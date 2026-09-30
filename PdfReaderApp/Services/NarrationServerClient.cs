using Microsoft.Extensions.Configuration;
using Microsoft.JSInterop;

namespace PdfReaderApp.Services;

/// <summary>A voice offered by the narration server.</summary>
public sealed class NarrationVoice
{
    public string Id { get; set; } = string.Empty;

    public string Name { get; set; } = string.Empty;

    public string Language { get; set; } = string.Empty;

    public string Quality { get; set; } = string.Empty;

    public string Gender { get; set; } = string.Empty;
}

/// <summary>Outcome of probing the narration server.</summary>
public sealed class NarrationServerStatus
{
    public bool Available { get; set; }

    public string Reason { get; set; } = string.Empty;

    public int VoiceCount { get; set; }
}

/// <summary>
/// Talks to the optional narration server that synthesises speech with a neural voice.
///
/// The in-browser engine cannot match the quality of the operating system's voices, so
/// this server exists to give exported audio the same voice as live reading. It is
/// optional: when it is unreachable the reader falls back to the offline engine rather
/// than failing an export.
/// </summary>
public sealed class NarrationServerClient : IAsyncDisposable
{
    private const string ConfigKey = "NarrationServer:BaseUrl";

    private readonly IJSRuntime js;
    private readonly IConfiguration configuration;
    private IJSObjectReference? module;
    private bool initialized;

    public NarrationServerClient(IJSRuntime js, IConfiguration configuration)
    {
        this.js = js;
        this.configuration = configuration;
    }

    /// <summary>Base URL of the narration server, without a trailing slash.</summary>
    public string BaseUrl => (configuration[ConfigKey] ?? string.Empty).TrimEnd('/');

    public bool IsConfigured => BaseUrl.Length > 0;

    private async Task EnsureInitializedAsync()
    {
        if (initialized)
        {
            return;
        }

        module = await js.InvokeAsync<IJSObjectReference>("import", "./js/audioExport.js");
        initialized = true;
    }

    /// <summary>Checks whether the server is reachable and has voices installed.</summary>
    public async Task<NarrationServerStatus> ProbeAsync()
    {
        if (!IsConfigured)
        {
            return new NarrationServerStatus
            {
                Available = false,
                Reason = "No narration server is configured.",
            };
        }

        await EnsureInitializedAsync();
        var result = await module!.InvokeAsync<NarrationServerStatus>("probeServer", BaseUrl);
        return result;
    }

    /// <summary>The voices the server can synthesise with.</summary>
    public async Task<IReadOnlyList<NarrationVoice>> GetVoicesAsync()
    {
        if (!IsConfigured)
        {
            return [];
        }

        await EnsureInitializedAsync();
        var voices = await module!.InvokeAsync<List<NarrationVoice>>("listServerVoices", BaseUrl);
        return voices;
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
                // The page was already torn down.
            }
        }
    }
}
