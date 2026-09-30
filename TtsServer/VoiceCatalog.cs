namespace TtsServer;

/// <summary>A narration voice offered by the server.</summary>
public sealed record VoiceInfo(
    string Id,
    string Name,
    string Language,
    string Quality,
    string Gender,
    string ModelFile,
    string ConfigFile);

/// <summary>
/// The voices this server can narrate with.
///
/// Ids are the contract shared with the web app: the reader uses the same id for live
/// playback and for export, so a voice chosen in one place means the same thing in the
/// other. Each id is also the piper model stem, which keeps the mapping trivial.
/// </summary>
public static class VoiceCatalog
{
    public static readonly IReadOnlyList<VoiceInfo> Voices =
    [
        new("en_US-lessac-medium", "Lessac", "en-US", "medium", "female",
            "en_US-lessac-medium.onnx", "en_US-lessac-medium.onnx.json"),
        new("en_US-amy-medium", "Amy", "en-US", "medium", "female",
            "en_US-amy-medium.onnx", "en_US-amy-medium.onnx.json"),
        new("en_US-ryan-medium", "Ryan", "en-US", "medium", "male",
            "en_US-ryan-medium.onnx", "en_US-ryan-medium.onnx.json"),
        new("en_GB-alba-medium", "Alba", "en-GB", "medium", "female",
            "en_GB-alba-medium.onnx", "en_GB-alba-medium.onnx.json"),
        new("en_GB-alan-medium", "Alan", "en-GB", "medium", "male",
            "en_GB-alan-medium.onnx", "en_GB-alan-medium.onnx.json"),
        new("de_DE-thorsten-medium", "Thorsten", "de-DE", "medium", "male",
            "de_DE-thorsten-medium.onnx", "de_DE-thorsten-medium.onnx.json"),
        new("es_ES-davefx-medium", "Dave", "es-ES", "medium", "male",
            "es_ES-davefx-medium.onnx", "es_ES-davefx-medium.onnx.json"),
        new("fr_FR-siwis-medium", "Siwis", "fr-FR", "medium", "female",
            "fr_FR-siwis-medium.onnx", "fr_FR-siwis-medium.onnx.json"),
    ];

    public const string DefaultVoiceId = "en_US-lessac-medium";

    public static VoiceInfo? Find(string? id)
        => id is null ? null : Voices.FirstOrDefault(v => v.Id == id);

    /// <summary>
    /// The voice to use for a request. An unknown id falls back to the default rather than
    /// failing, so a stale saved selection still produces audio.
    /// </summary>
    public static VoiceInfo Resolve(string? id) => Find(id) ?? Find(DefaultVoiceId)!;
}
