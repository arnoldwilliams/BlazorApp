using Microsoft.JSInterop;

namespace PdfReaderApp.Services;

public sealed class SpeechVoice
{
    public string Name { get; set; } = string.Empty;

    public string Lang { get; set; } = string.Empty;

    public bool Local { get; set; }

    public bool IsDefault { get; set; }

    public int Index { get; set; }

    public string DisplayName => IsDefault ? $"{Name} ({Lang}) — default" : $"{Name} ({Lang})";
}

public sealed class SpeechOptions
{
    public string? VoiceName { get; set; }

    public string? Lang { get; set; }

    public double Rate { get; set; } = 1.0;

    public double Pitch { get; set; } = 1.0;

    public double Volume { get; set; } = 1.0;
}

/// <summary>
/// Wrapper around the Web Speech API module in <c>wwwroot/js/speechInterop.js</c>.
/// </summary>
public sealed class SpeechInterop : IAsyncDisposable
{
    private readonly IJSRuntime js;
    private IJSObjectReference? module;
    private DotNetObjectReference<SpeechInterop>? selfReference;
    private bool initialized;

    public SpeechInterop(IJSRuntime js)
    {
        this.js = js;
    }

    /// <summary>Raised with "speaking", "paused", "idle" or "unsupported" as the browser state changes.</summary>
    public event Func<string, Task>? StateChanged;

    /// <summary>Raised with the utterance id, character index and character length of the current word.</summary>
    public event Func<int, int, int, Task>? BoundaryReached;

    public bool IsSupported { get; private set; }

    public async Task InitializeAsync()
    {
        if (initialized)
        {
            await NotifyStateAsync(await GetStateAsync());
            return;
        }

        module = await js.InvokeAsync<IJSObjectReference>("import", "./js/speechInterop.js");
        selfReference ??= DotNetObjectReference.Create(this);

        IsSupported = await module.InvokeAsync<bool>("supported");
        await module.InvokeVoidAsync("init", selfReference);
        initialized = true;
    }

    public async Task<IReadOnlyList<SpeechVoice>> GetVoicesAsync(bool waitForLoad = true)
    {
        await InitializeAsync();

        if (!IsSupported)
        {
            return [];
        }

        var voices = waitForLoad
            ? await module!.InvokeAsync<List<SpeechVoice>>("waitForVoices", 4000)
            : await module!.InvokeAsync<List<SpeechVoice>>("getVoices");

        return voices;
    }

    public async Task<string> SpeakAsync(int utteranceId, string text, SpeechOptions options)
    {
        await InitializeAsync();
        return await module!.InvokeAsync<string>("speak", utteranceId, text, options);
    }

    public async Task CancelAsync()
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("cancel");
    }

    public async Task PauseAsync()
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("pause");
    }

    public async Task ResumeAsync()
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("resume");
    }

    public async Task<string> GetStateAsync()
    {
        if (module is null)
        {
            return "idle";
        }

        return await module.InvokeAsync<string>("getState");
    }

    // Re-raises the browser callbacks as .NET events.
    [JSInvokable]
    public Task OnSpeechStateChanged(string state)
    {
        if (state == "unsupported")
        {
            IsSupported = false;
        }

        return NotifyStateAsync(state);
    }

    [JSInvokable]
    public Task OnSpeechBoundary(int utteranceId, int charIndex, int charLength)
        => BoundaryReached?.Invoke(utteranceId, charIndex, charLength) ?? Task.CompletedTask;

    private Task NotifyStateAsync(string state)
        => StateChanged?.Invoke(state) ?? Task.CompletedTask;

    public async ValueTask DisposeAsync()
    {
        if (module is not null)
        {
            try
            {
                await module.InvokeVoidAsync("dispose");
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