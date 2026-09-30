using System.Diagnostics;
using System.Text;

namespace TtsServer;

public sealed class PiperOptions
{
    /// <summary>Directory holding the piper executable, its shared libraries and voices.</summary>
    public string Root { get; set; } = "engines/piper";

    /// <summary>Maximum number of synthesis calls running at once.</summary>
    public int MaxConcurrency { get; set; } = 2;

    /// <summary>Longest text accepted in one request, in characters.</summary>
    public int MaxTextLength { get; set; } = 20000;

    /// <summary>How long a single synthesis call may take.</summary>
    public int TimeoutSeconds { get; set; } = 120;
}

public sealed class SynthesisResult
{
    public required byte[] Wav { get; init; }

    public required int SampleRate { get; init; }

    public required double Seconds { get; init; }
}

/// <summary>
/// Runs piper as a subprocess, one call per passage.
///
/// piper writes a RIFF WAV to stdout, so no temporary files are involved. The process is
/// started from the piper directory because the binary loads its shared libraries and
/// espeak-ng data relative to its own location.
/// </summary>
public sealed class PiperEngine
{
    private readonly PiperOptions options;
    private readonly SemaphoreSlim gate;
    private readonly ILogger<PiperEngine> log;

    public PiperEngine(PiperOptions options, ILogger<PiperEngine> log)
    {
        this.options = options;
        this.log = log;
        gate = new SemaphoreSlim(Math.Max(1, options.MaxConcurrency));
    }

    public string RootPath => Path.GetFullPath(options.Root);

    private string ExecutablePath => Path.Combine(RootPath, "piper");

    public bool IsInstalled => File.Exists(ExecutablePath);

    public bool HasVoice(VoiceInfo voice)
        => File.Exists(Path.Combine(RootPath, "voices", voice.ModelFile))
           && File.Exists(Path.Combine(RootPath, "voices", voice.ConfigFile));

    /// <summary>Voices whose model files are actually present on disk.</summary>
    public IReadOnlyList<VoiceInfo> InstalledVoices()
        => VoiceCatalog.Voices.Where(HasVoice).ToList();

    public async Task<SynthesisResult> SynthesizeAsync(
        string text,
        VoiceInfo voice,
        double rate,
        int sentenceSilenceMs,
        CancellationToken cancellationToken)
    {
        if (!IsInstalled)
        {
            throw new PiperException(
                $"The narration engine is not installed. Expected to find \"{ExecutablePath}\". "
                + "Run scripts/setup-voices.sh to download it.");
        }

        if (!HasVoice(voice))
        {
            throw new PiperException(
                $"Voice \"{voice.Id}\" is not installed. Run scripts/setup-voices.sh to download it.");
        }

        if (string.IsNullOrWhiteSpace(text))
        {
            throw new PiperException("There is no text to narrate.");
        }

        if (text.Length > options.MaxTextLength)
        {
            throw new PiperException(
                $"The passage is longer than {options.MaxTextLength} characters.");
        }

        await gate.WaitAsync(cancellationToken);
        try
        {
            return await RunAsync(text, voice, rate, sentenceSilenceMs, cancellationToken);
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task<SynthesisResult> RunAsync(
        string text,
        VoiceInfo voice,
        double rate,
        int sentenceSilenceMs,
        CancellationToken cancellationToken)
    {
        var model = Path.Combine(RootPath, "voices", voice.ModelFile);
        var config = Path.Combine(RootPath, "voices", voice.ConfigFile);

        var startInfo = new ProcessStartInfo
        {
            FileName = ExecutablePath,
            WorkingDirectory = RootPath,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            UseShellExecute = false,
        };

        startInfo.ArgumentList.Add("--model");
        startInfo.ArgumentList.Add(model);
        startInfo.ArgumentList.Add("--config");
        startInfo.ArgumentList.Add(config);
        startInfo.ArgumentList.Add("--output_file");
        startInfo.ArgumentList.Add("-");
        startInfo.ArgumentList.Add("--quiet");

        // piper expresses speed as a phoneme length multiplier, so a faster reading is a
        // shorter scale. The reader's rate is clamped to the range the UI offers.
        var lengthScale = 1.0 / Math.Clamp(rate, 0.5, 2.5);
        startInfo.ArgumentList.Add("--length_scale");
        startInfo.ArgumentList.Add(lengthScale.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));

        // piper already inserts a little silence after each sentence; the reader's gap
        // setting replaces it so the export spacing matches the slider.
        startInfo.ArgumentList.Add("--sentence_silence");
        startInfo.ArgumentList.Add(
            (Math.Clamp(sentenceSilenceMs, 0, 5000) / 1000.0)
            .ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));

        using var process = new Process { StartInfo = startInfo };
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(options.TimeoutSeconds));

        if (!process.Start())
        {
            throw new PiperException("The narration engine could not be started.");
        }

        // WAV bytes can exceed the pipe buffer, so the read has to run while stdin is
        // being written; awaiting the write first would deadlock on a long passage.
        var stdout = new MemoryStream();
        var readOutput = process.StandardOutput.BaseStream.CopyToAsync(stdout, timeout.Token);
        var readError = process.StandardError.ReadToEndAsync(timeout.Token);

        try
        {
            await process.StandardInput.WriteAsync(text.AsMemory(), timeout.Token);
            await process.StandardInput.FlushAsync(timeout.Token);
            process.StandardInput.Close();

            await readOutput;
            var stderr = await readError;
            await process.WaitForExitAsync(timeout.Token);

            if (process.ExitCode != 0)
            {
                log.LogWarning("piper exited with {Code}: {Error}", process.ExitCode, stderr.Trim());
                throw new PiperException(
                    string.IsNullOrWhiteSpace(stderr)
                        ? "The narration engine could not synthesise this passage."
                        : $"The narration engine failed: {stderr.Trim()}");
            }

            var wav = stdout.ToArray();
            if (wav.Length <= 44)
            {
                throw new PiperException("The narration engine returned no audio.");
            }

            var sampleRate = ReadSampleRate(wav);
            var seconds = EstimateSeconds(wav, sampleRate);
            return new SynthesisResult { Wav = wav, SampleRate = sampleRate, Seconds = seconds };
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            TryKill(process);
            throw new PiperException(
                $"The narration engine did not finish within {options.TimeoutSeconds} seconds.");
        }
        catch
        {
            TryKill(process);
            throw;
        }
    }

    private static void TryKill(Process process)
    {
        try
        {
            if (!process.HasExited)
            {
                process.Kill(entireProcessTree: true);
            }
        }
        catch
        {
            // The process may have exited between the check and the kill.
        }
    }

    /// <summary>Reads the sample rate out of the RIFF header piper writes.</summary>
    public static int ReadSampleRate(byte[] wav)
    {
        if (wav.Length < 28)
        {
            return 0;
        }

        // "RIFF" .... "WAVE" then the fmt chunk, whose sample rate is at offset 24.
        var hasRiff = wav[0] == 'R' && wav[1] == 'I' && wav[2] == 'F' && wav[3] == 'F';
        var hasWave = wav[8] == 'W' && wav[9] == 'A' && wav[10] == 'V' && wav[11] == 'E';
        if (!hasRiff || !hasWave)
        {
            return 0;
        }

        return BitConverter.ToInt32(wav, 24);
    }

    private static double EstimateSeconds(byte[] wav, int sampleRate)
    {
        if (sampleRate <= 0)
        {
            return 0;
        }

        // 16 bit mono, so the audio is two bytes per sample after the 44 byte header.
        var samples = Math.Max(0, (wav.Length - 44) / 2);
        return (double)samples / sampleRate;
    }
}

/// <summary>Raised when the engine cannot produce audio for a request.</summary>
public sealed class PiperException : Exception
{
    public PiperException(string message) : base(message)
    {
    }
}
