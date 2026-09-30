using System.Text.Json;
using TtsServer;

var builder = WebApplication.CreateBuilder(args);

var piperOptions = new PiperOptions();
builder.Configuration.GetSection("Piper").Bind(piperOptions);
builder.Services.AddSingleton(piperOptions);
builder.Services.AddSingleton<PiperEngine>();

builder.Services.AddCors(cors => cors.AddDefaultPolicy(policy => policy
    .WithOrigins(builder.Configuration.GetSection("Cors:Origins").Get<string[]>()
                 ?? ["http://localhost:12000"])
    .AllowAnyHeader()
    .AllowAnyMethod()));

builder.Services.ConfigureHttpJsonOptions(json =>
{
    json.SerializerOptions.PropertyNamingPolicy = JsonNamingPolicy.CamelCase;
});

var app = builder.Build();
app.UseCors();

app.Logger.LogInformation("Narration engine root: {Root}", app.Services.GetRequiredService<PiperEngine>().RootPath);

// The web app probes this before offering server voices, so it can fall back to the
// in-browser engine instead of failing an export.
app.MapGet("/api/health", (PiperEngine engine) => Results.Ok(new
{
    status = "ok",
    engine = "piper",
    installed = engine.IsInstalled,
    voices = engine.InstalledVoices().Count,
}));

app.MapGet("/api/voices", (PiperEngine engine) =>
{
    var installed = engine.InstalledVoices().Select(v => new
    {
        id = v.Id,
        name = v.Name,
        language = v.Language,
        quality = v.Quality,
        gender = v.Gender,
    });

    return Results.Ok(new
    {
        engine = "piper",
        installed = engine.IsInstalled,
        defaultVoice = VoiceCatalog.DefaultVoiceId,
        voices = installed,
    });
});

// Synthesises one passage and returns a WAV. The browser concatenates the passages and
// encodes MP3 if the user asked for it, so the server only ever deals in raw WAV.
app.MapPost("/api/speech", async (
    SpeechRequest request,
    PiperEngine engine,
    CancellationToken cancellationToken) =>
{
    if (string.IsNullOrWhiteSpace(request.Text))
    {
        return Results.BadRequest(new { error = "There is no text to narrate." });
    }

    var voice = VoiceCatalog.Resolve(request.Voice);

    try
    {
        var result = await engine.SynthesizeAsync(
            request.Text,
            voice,
            request.Rate,
            request.SentenceSilenceMs,
            cancellationToken);

        return Results.File(result.Wav, "audio/wav", $"speech-{voice.Id}.wav");
    }
    catch (PiperException ex)
    {
        return Results.Problem(ex.Message, statusCode: StatusCodes.Status503ServiceUnavailable);
    }
    catch (OperationCanceledException)
    {
        return Results.StatusCode(StatusCodes.Status499ClientClosedRequest);
    }
});

app.Run();

public sealed record SpeechRequest
{
    public string Text { get; init; } = string.Empty;

    public string? Voice { get; init; }

    public double Rate { get; init; } = 1.0;

    public int SentenceSilenceMs { get; init; } = 200;
}
