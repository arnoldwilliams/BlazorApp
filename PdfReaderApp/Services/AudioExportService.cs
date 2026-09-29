using Microsoft.JSInterop;

namespace PdfReaderApp.Services;

public enum AudioFormat
{
    Mp3,
    Wav,
}

/// <summary>How much of the document an export covers.</summary>
public enum AudioExportScope
{
    Document,
    CurrentPage,
}

public sealed class AudioExportOptions
{
    public AudioFormat Format { get; set; } = AudioFormat.Mp3;

    /// <summary>Offline voice id, such as "en-us" or "de".</summary>
    public string Voice { get; set; } = "en-us";

    /// <summary>Speech rate as a multiple of normal speed.</summary>
    public double Rate { get; set; } = 1.0;

    /// <summary>Pitch multiplier.</summary>
    public double Pitch { get; set; } = 1.0;

    /// <summary>Volume multiplier between 0 and 1.</summary>
    public double Volume { get; set; } = 1.0;

    /// <summary>MP3 bitrate in kbps. Ignored for WAV.</summary>
    public int Bitrate { get; set; } = 128;

    /// <summary>Silence inserted between passages, in milliseconds.</summary>
    public int GapMs { get; set; } = 250;

    public string FileName { get; set; } = "reading.mp3";
}

public sealed class AudioExportProgress
{
    public string Stage { get; set; } = string.Empty;

    public int Current { get; set; }

    public int Total { get; set; }

    public string Message { get; set; } = string.Empty;

    public double Percent => Total <= 0 ? 0 : Math.Min(100, Current * 100.0 / Total);
}

public sealed class AudioExportResult
{
    public string Url { get; set; } = string.Empty;

    public string FileName { get; set; } = string.Empty;

    public string MimeType { get; set; } = string.Empty;

    public long Bytes { get; set; }

    public double Seconds { get; set; }

    public int Passages { get; set; }
}

/// <summary>
/// Wrapper around <c>wwwroot/js/audioExport.js</c>, which synthesises passages with the
/// bundled offline speech engine and writes them out as WAV or MP3.
/// </summary>
public sealed class AudioExportService : IAsyncDisposable
{
    private readonly IJSRuntime js;
    private IJSObjectReference? module;
    private DotNetObjectReference<AudioExportService>? selfReference;
    private bool initialized;

    public AudioExportService(IJSRuntime js)
    {
        this.js = js;
    }

    /// <summary>Raised as the export moves through loading, synthesis and encoding.</summary>
    public event Func<AudioExportProgress, Task>? ProgressChanged;

    public bool IsSupported { get; private set; }

    public async Task InitializeAsync()
    {
        if (initialized)
        {
            return;
        }

        module = await js.InvokeAsync<IJSObjectReference>("import", "./js/audioExport.js");
        selfReference ??= DotNetObjectReference.Create(this);
        IsSupported = await module.InvokeAsync<bool>("supported");
        initialized = true;
    }

    public async Task<IReadOnlyList<string>> GetVoicesAsync()
    {
        await InitializeAsync();
        if (!IsSupported)
        {
            return [];
        }

        var voices = await module!.InvokeAsync<List<AudioExportVoice>>("listVoices");
        return voices.Select(v => v.Id).ToList();
    }

    public async Task<AudioExportResult> ExportAsync(
        IReadOnlyList<string> passages,
        AudioExportOptions options,
        CancellationToken cancellationToken = default)
    {
        await InitializeAsync();
        if (!IsSupported)
        {
            throw new InvalidOperationException("This browser cannot build audio files.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        var payload = new
        {
            format = options.Format == AudioFormat.Wav ? "wav" : "mp3",
            voice = options.Voice,
            speed = options.Rate,
            pitch = options.Pitch,
            amplitude = options.Volume,
            wordgap = 0,
            bitrate = options.Bitrate,
            gapMs = options.GapMs,
            fileName = options.FileName,
        };

        return await module!.InvokeAsync<AudioExportResult>("exportPassages", passages, payload, selfReference);
    }

    public async Task CancelAsync()
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("cancelExport");
    }

    /// <summary>Hands the generated file to the browser's download handling.</summary>
    public async Task DownloadAsync(string url, string fileName)
    {
        if (module is null || string.IsNullOrEmpty(url))
        {
            return;
        }

        await module.InvokeVoidAsync("download", url, fileName);
    }

    public async Task ReleaseAsync(string? url)
    {
        if (module is null || string.IsNullOrEmpty(url))
        {
            return;
        }

        try
        {
            await module.InvokeVoidAsync("release", url);
        }
        catch (JSDisconnectedException)
        {
            // The runtime is gone; the browser will reclaim the object URL.
        }
    }

    [JSInvokable]
    public Task OnExportProgress(string stage, int current, int total, string message)
    {
        var progress = new AudioExportProgress
        {
            Stage = stage ?? string.Empty,
            Current = current,
            Total = total,
            Message = message ?? string.Empty,
        };

        return ProgressChanged?.Invoke(progress) ?? Task.CompletedTask;
    }

    public async ValueTask DisposeAsync()
    {
        if (module is not null)
        {
            try
            {
                await module.DisposeAsync();
            }
            catch (JSDisconnectedException)
            {
                // The runtime is gone; there is nothing left to release.
            }

            module = null;
        }

        selfReference?.Dispose();
        selfReference = null;
    }
}

/// <summary>Shape returned by the JavaScript module's voice list.</summary>
internal sealed class AudioExportVoice
{
    public string Id { get; set; } = string.Empty;
}