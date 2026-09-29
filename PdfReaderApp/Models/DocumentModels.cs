using System.Text.Json.Serialization;

namespace PdfReaderApp.Models;

/// <summary>The document formats the reader can display.</summary>
public enum DocumentFormat
{
    Pdf,
    Docx,
}

public sealed class DocumentPageSize
{
    [JsonPropertyName("width")]
    public double Width { get; set; }

    [JsonPropertyName("height")]
    public double Height { get; set; }
}

public sealed class DocumentTextSpan
{
    [JsonPropertyName("num")]
    public int Num { get; set; }

    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;

    /// <summary>Offset of this span inside the page text returned by the engine.</summary>
    [JsonPropertyName("start")]
    public int Start { get; set; }

    /// <summary>Tags the span so the engine can rebuild mark-up (for example the heading level).</summary>
    [JsonPropertyName("kind")]
    public string? Kind { get; set; }
}

public sealed class DocumentPageText
{
    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;

    [JsonPropertyName("spans")]
    public List<DocumentTextSpan> Spans { get; set; } = [];
}

/// <summary>A contiguous run of prose queued for read aloud.</summary>
public sealed class TextChunk
{
    public int Index { get; init; }

    public int PageNumber { get; init; }

    /// <summary>Offset of the chunk inside the page text returned by the engine.</summary>
    public int Start { get; init; }

    public int Length { get; init; }

    public string Text { get; init; } = string.Empty;

    public int End => Start + Length;
}

public sealed record PageTextSpanRange(int Num, int Start, int Length)
{
    public int End => Start + Length;
}

/// <summary>Character range of a page that is currently being spoken.</summary>
public sealed record PageHighlight(int PageNumber, int Start, int Length);

/// <summary>Maps every text span on a page back to its offset in the page text.</summary>
public sealed class PageTextMap
{
    public PageTextMap(int pageNumber, string text, IReadOnlyList<PageTextSpanRange> spanRanges)
    {
        PageNumber = pageNumber;
        Text = text;
        SpanRanges = spanRanges;
    }

    public int PageNumber { get; }

    public string Text { get; }

    public IReadOnlyList<PageTextSpanRange> SpanRanges { get; }
}
