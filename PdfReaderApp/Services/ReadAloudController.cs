using PdfReaderApp.Models;

namespace PdfReaderApp.Services;

public enum ReadAloudStatus
{
    Idle,
    Preparing,
    Speaking,
    Paused,
    Completed,
    Error,
}

/// <summary>Callbacks the controller uses to drive the on screen document.</summary>
public interface IReadAloudHost
{
    /// <summary>Makes sure the page is rendered and visible to the reader.</summary>
    Task EnsurePageVisibleAsync(int pageNumber, CancellationToken cancellationToken);

    /// <summary>Highlights the character range of the page that is currently being spoken.</summary>
    Task HighlightAsync(int pageNumber, int start, int length);

    Task ClearHighlightAsync(int pageNumber);

    /// <summary>Records span offsets so highlights line up with the rendered text layer.</summary>
    Task ApplySpanOffsetsAsync(int pageNumber, IReadOnlyList<PageTextSpanRange> ranges);

    /// <summary>Brings the span being spoken into view.</summary>
    Task ScrollSpanIntoViewAsync(int pageNumber, int spanNumber);
}

/// <summary>
/// Extracts the text of a document, splits it into utterance sized chunks and plays the
/// chunks in order while keeping the viewer in sync.
/// </summary>
public sealed class ReadAloudController : IDisposable
{
    private static int nextOwnerId;

    private readonly PdfInterop pdf;
    private readonly SpeechInterop speech;
    private readonly List<TextChunk> chunks = [];
    private readonly Dictionary<int, PageTextMap> pageMaps = [];
    private readonly int ownerId = Interlocked.Increment(ref nextOwnerId) % 1000;

    private CancellationTokenSource? runCancellation;
    private IReadAloudHost? host;
    private string? documentId;
    private int currentIndex = -1;
    private bool disposed;

    public ReadAloudController(PdfInterop pdf, SpeechInterop speech)
    {
        this.pdf = pdf;
        this.speech = speech;

        speech.StateChanged += OnSpeechStateChanged;
    }

    /// <summary>Raised whenever the status, position or options change so the UI can refresh.</summary>
    public event Func<Task>? Changed;

    public ReadAloudStatus Status { get; private set; } = ReadAloudStatus.Idle;

    public string? ErrorMessage { get; private set; }

    public SpeechOptions Options { get; } = new();

    public IReadOnlyList<TextChunk> Chunks => chunks;

    public int CurrentIndex => currentIndex;

    public int TotalChunks => chunks.Count;

    public bool IsReady => chunks.Count > 0;

    public bool IsActive => Status is ReadAloudStatus.Speaking or ReadAloudStatus.Paused or ReadAloudStatus.Preparing;

    /// <summary>Percent of the document that has been read, including the active chunk.</summary>
    public double Progress
    {
        get
        {
            if (chunks.Count == 0 || currentIndex < 0)
            {
                return 0;
            }

            return Math.Min(100, (currentIndex + 1) * 100.0 / chunks.Count);
        }
    }

    public TextChunk? CurrentChunk
        => currentIndex >= 0 && currentIndex < chunks.Count ? chunks[currentIndex] : null;

    public void SetHost(IReadAloudHost readAloudHost) => host = readAloudHost;

    /// <summary>Reads every page of the document and builds the chunk list.</summary>
    public async Task PrepareAsync(string document, int pageCount, CancellationToken cancellationToken = default)
    {
        if (documentId == document && chunks.Count > 0)
        {
            return;
        }

        await StopAsync();

        documentId = document;
        chunks.Clear();
        pageMaps.Clear();
        currentIndex = -1;
        ErrorMessage = null;
        Status = ReadAloudStatus.Preparing;
        await RaiseChangedAsync();

        var index = 0;
        for (var pageNumber = 1; pageNumber <= pageCount; pageNumber++)
        {
            cancellationToken.ThrowIfCancellationRequested();

            var pageText = await pdf.GetPageTextAsync(document, pageNumber);
            var text = pageText?.Text ?? string.Empty;
            var ranges = BuildRanges(text, pageText?.Spans);

            pageMaps[pageNumber] = new PageTextMap(pageNumber, text, ranges);

            if (host is not null)
            {
                await host.ApplySpanOffsetsAsync(pageNumber, ranges);
            }

            var cursor = 0;
            foreach (var part in TextChunker.Split(text))
            {
                // Locate the part from the previous position so repeated text maps correctly.
                var start = text.IndexOf(part, cursor, StringComparison.Ordinal);
                if (start < 0)
                {
                    start = text.IndexOf(part, StringComparison.Ordinal);
                }

                if (start < 0)
                {
                    start = cursor;
                }

                cursor = Math.Min(text.Length, start + part.Length);

                chunks.Add(new TextChunk
                {
                    Index = index++,
                    PageNumber = pageNumber,
                    Start = start,
                    Length = part.Length,
                    Text = part,
                });
            }
        }

        if (chunks.Count == 0)
        {
            Status = ReadAloudStatus.Error;
            ErrorMessage = "No readable text was found. This PDF may be a scanned image without a text layer.";
        }
        else
        {
            Status = ReadAloudStatus.Idle;
        }

        await RaiseChangedAsync();
    }

    public async Task StartAsync()
    {
        if (chunks.Count == 0)
        {
            return;
        }

        if (Status == ReadAloudStatus.Paused)
        {
            await ResumeAsync();
            return;
        }

        if (Status == ReadAloudStatus.Speaking)
        {
            return;
        }

        if (currentIndex < 0 || currentIndex >= chunks.Count)
        {
            currentIndex = 0;
        }

        runCancellation?.Cancel();
        runCancellation?.Dispose();
        runCancellation = new CancellationTokenSource();

        Status = ReadAloudStatus.Speaking;
        await RaiseChangedAsync();

        _ = RunAsync(runCancellation.Token);
    }

    /// <summary>Starts reading from the chunk that contains the given text span.</summary>
    public async Task StartReadingAtSpanAsync(int pageNumber, int spanNumber)
    {
        if (chunks.Count == 0 || !pageMaps.TryGetValue(pageNumber, out var map))
        {
            return;
        }

        var range = map.SpanRanges.FirstOrDefault(r => r.Num == spanNumber);
        if (range is null)
        {
            return;
        }

        var index = chunks.FindIndex(c => c.PageNumber == pageNumber && range.Start >= c.Start && range.Start < c.End);
        if (index < 0)
        {
            index = chunks.FindIndex(c => c.PageNumber == pageNumber && c.Start >= range.Start);
        }

        if (index < 0)
        {
            index = chunks.FindIndex(c => c.PageNumber == pageNumber);
        }

        if (index < 0)
        {
            return;
        }

        await SeekAsync(index);

        if (Status is not (ReadAloudStatus.Speaking or ReadAloudStatus.Paused or ReadAloudStatus.Preparing))
        {
            await StartAsync();
        }
    }

    /// <summary>Span offsets for a page, used by the viewer to align highlights with the text layer.</summary>
    public IReadOnlyList<PageTextSpanRange>? GetSpanOffsetsForPage(int pageNumber)
        => pageMaps.TryGetValue(pageNumber, out var map) ? map.SpanRanges : null;

    /// <summary>Restarts the document from the first chunk.</summary>
    public async Task RestartAsync()
    {
        currentIndex = 0;
        await StartAsync();
    }

    public async Task PauseAsync()
    {
        if (Status != ReadAloudStatus.Speaking)
        {
            return;
        }

        Status = ReadAloudStatus.Paused;
        await speech.PauseAsync();
        await RaiseChangedAsync();
    }

    public async Task ResumeAsync()
    {
        if (Status != ReadAloudStatus.Paused)
        {
            return;
        }

        Status = ReadAloudStatus.Speaking;
        await speech.ResumeAsync();
        await RaiseChangedAsync();
    }

    public async Task StopAsync()
    {
        runCancellation?.Cancel();

        if (host is not null && CurrentChunk is { } chunk)
        {
            await host.ClearHighlightAsync(chunk.PageNumber);
        }

        await speech.CancelAsync();

        if (Status != ReadAloudStatus.Error)
        {
            Status = chunks.Count > 0 ? ReadAloudStatus.Idle : Status;
        }

        await RaiseChangedAsync();
    }

    public Task NextAsync() => SeekAsync(currentIndex + 1);

    public Task PreviousAsync() => SeekAsync(currentIndex - 1);

    /// <summary>Moves to a chunk, restarting playback when the document is already playing.</summary>
    public async Task SeekAsync(int chunkIndex)
    {
        if (chunks.Count == 0)
        {
            return;
        }

        var wasActive = Status == ReadAloudStatus.Speaking;
        await StopAsync();

        currentIndex = Math.Clamp(chunkIndex, 0, chunks.Count - 1);

        if (host is not null && CurrentChunk is { } chunk)
        {
            await host.EnsurePageVisibleAsync(chunk.PageNumber, CancellationToken.None);
        }

        if (wasActive || Status == ReadAloudStatus.Paused)
        {
            await StartAsync();
        }
        else
        {
            await RaiseChangedAsync();
        }
    }

    /// <summary>Reads a block of text that is not part of the document, such as a selection.</summary>
    public async Task ReadTextAsync(string text)
    {
        if (string.IsNullOrWhiteSpace(text))
        {
            return;
        }

        await StopAsync();

        Status = ReadAloudStatus.Speaking;
        await RaiseChangedAsync();

        runCancellation?.Cancel();
        runCancellation?.Dispose();
        runCancellation = new CancellationTokenSource();
        var token = runCancellation.Token;

        try
        {
            var batch = 0;
            foreach (var part in TextChunker.Split(text))
            {
                if (token.IsCancellationRequested)
                {
                    break;
                }

                var utteranceId = EncodeUtteranceId(0, -1, batch++);
                await speech.SpeakAsync(utteranceId, part, Options);
            }

            if (!token.IsCancellationRequested)
            {
                Status = ReadAloudStatus.Completed;
            }
            else
            {
                Status = ReadAloudStatus.Idle;
            }
        }
        catch (Exception ex)
        {
            Status = ReadAloudStatus.Error;
            ErrorMessage = ex.Message;
        }

        await RaiseChangedAsync();
    }

    public async Task JumpToPageAsync(int pageNumber)
    {
        // Page 1 is a sensible fallback when the controller has not been prepared yet.
        var target = chunks.FindIndex(chunk => chunk.PageNumber == pageNumber);
        if (target < 0)
        {
            return;
        }

        await SeekAsync(target);
    }

    private async Task RunAsync(CancellationToken token)
    {
        try
        {
            while (!token.IsCancellationRequested && currentIndex < chunks.Count)
            {
                var chunk = chunks[currentIndex];
                var utteranceId = EncodeUtteranceId(ownerId, currentIndex, 0);

                if (host is not null)
                {
                    await host.EnsurePageVisibleAsync(chunk.PageNumber, token);
                    if (pageMaps.TryGetValue(chunk.PageNumber, out var map))
                    {
                        await host.ApplySpanOffsetsAsync(chunk.PageNumber, map.SpanRanges);
                    }
                    await host.HighlightAsync(chunk.PageNumber, chunk.Start, chunk.Length);
                }

                if (token.IsCancellationRequested)
                {
                    break;
                }

                await speech.SpeakAsync(utteranceId, chunk.Text, Options);

                if (token.IsCancellationRequested)
                {
                    break;
                }

                currentIndex++;
                await RaiseChangedAsync();

                // Give the browser a moment to service rendering between utterances.
                await Task.Delay(60, token);
            }

            if (!token.IsCancellationRequested)
            {
                Status = ReadAloudStatus.Completed;
                if (host is not null && chunks.Count > 0)
                {
                    await host.ClearHighlightAsync(chunks[^1].PageNumber);
                }

                await RaiseChangedAsync();
            }
        }
        catch (OperationCanceledException)
        {
            // Expected when playback is stopped or restarted.
        }
        catch (Exception ex)
        {
            Status = ReadAloudStatus.Error;
            ErrorMessage = ex.Message;
            await RaiseChangedAsync();
        }
    }

    private async Task OnSpeechStateChanged(string state)
    {
        if (state == "paused" && Status == ReadAloudStatus.Speaking)
        {
            Status = ReadAloudStatus.Paused;
            await RaiseChangedAsync();
        }
        else if (state == "speaking" && Status == ReadAloudStatus.Paused)
        {
            Status = ReadAloudStatus.Speaking;
            await RaiseChangedAsync();
        }
    }

    /// <summary>Packs the owner, chunk and batch into one id so stale boundary events can be ignored.</summary>
    private static int EncodeUtteranceId(int owner, int chunkIndex, int batch)
        => (owner * 1_000_000) + ((chunkIndex + 1) * 100) + batch;

    private static IReadOnlyList<PageTextSpanRange> BuildRanges(string text, IReadOnlyList<PdfTextSpan>? spans)
    {
        if (spans is null || spans.Count == 0 || text.Length == 0)
        {
            return [];
        }

        // pdf.js reports each item's offset while it concatenates the page text, so the
        // ranges are taken directly instead of being re-derived by searching the string.
        var ranges = new List<PageTextSpanRange>(spans.Count);
        foreach (var span in spans)
        {
            if (string.IsNullOrEmpty(span.Text))
            {
                ranges.Add(new PageTextSpanRange(span.Num, Math.Clamp(span.Start, 0, text.Length), 0));
                continue;
            }

            var start = Math.Clamp(span.Start, 0, text.Length);
            var length = Math.Min(span.Text.Length, text.Length - start);
            ranges.Add(new PageTextSpanRange(span.Num, start, length));
        }

        return ranges;
    }

    private Task RaiseChangedAsync()
        => Changed?.Invoke() ?? Task.CompletedTask;

    public void Dispose()
    {
        if (disposed)
        {
            return;
        }

        disposed = true;
        speech.StateChanged -= OnSpeechStateChanged;
        runCancellation?.Cancel();
        runCancellation?.Dispose();
    }
}