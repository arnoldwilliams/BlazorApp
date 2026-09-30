using System.Text.Json.Serialization;

namespace PdfReaderApp.Models;

public sealed class PdfPageSize
{
    [JsonPropertyName("width")]
    public double Width { get; set; }

    [JsonPropertyName("height")]
    public double Height { get; set; }
}

public sealed class PdfTextSpan
{
    [JsonPropertyName("num")]
    public int Num { get; set; }

    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;

    /// <summary>Offset of this span inside the page text returned by pdf.js.</summary>
    [JsonPropertyName("start")]
    public int Start { get; set; }
}

public sealed class PdfPageText
{
    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;

    [JsonPropertyName("spans")]
    public List<PdfTextSpan> Spans { get; set; } = [];

    /// <summary>Number of non whitespace characters pdf.js extracted for the page.</summary>
    [JsonPropertyName("chars")]
    public int Chars { get; set; }

    /// <summary>
    /// Share of the page the extracted glyph boxes cover, 0 to 1. A scanned page that
    /// carries only a scanner stamp, page number or watermark measures a fraction of a
    /// percent, while a page of real text measures several percent.
    /// </summary>
    [JsonPropertyName("coverage")]
    public double Coverage { get; set; }
}

/// <summary>A contiguous run of prose queued for read aloud.</summary>
public sealed class TextChunk
{
    public int Index { get; init; }

    public int PageNumber { get; init; }

    /// <summary>Offset of the chunk inside the page text returned by pdf.js.</summary>
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

/// <summary>A word recognised by OCR, with the box it occupies on the page.</summary>
public sealed class OcrWord
{
    [JsonPropertyName("num")]
    public int Num { get; set; }

    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;

    /// <summary>Offset of this word inside the recognised page text.</summary>
    [JsonPropertyName("start")]
    public int Start { get; set; }

    [JsonPropertyName("bbox")]
    public OcrBox? BoundingBox { get; set; }
}

public sealed class OcrBox
{
    [JsonPropertyName("x0")]
    public double X0 { get; set; }

    [JsonPropertyName("y0")]
    public double Y0 { get; set; }

    [JsonPropertyName("x1")]
    public double X1 { get; set; }

    [JsonPropertyName("y1")]
    public double Y1 { get; set; }
}

/// <summary>Result of recognising a single page.</summary>
public sealed class OcrPageResult
{
    [JsonPropertyName("pageNumber")]
    public int PageNumber { get; set; }

    [JsonPropertyName("text")]
    public string Text { get; set; } = string.Empty;

    [JsonPropertyName("spans")]
    public List<OcrWord> Spans { get; set; } = [];

    [JsonPropertyName("confidence")]
    public double Confidence { get; set; }

    [JsonPropertyName("wordCount")]
    public int WordCount { get; set; }

    [JsonPropertyName("scale")]
    public double Scale { get; set; }
}

/// <summary>OCR languages offered by the viewer.</summary>
public sealed record OcrLanguage(string Code, string Name);

/// <summary>Which pages an OCR run should cover.</summary>
public enum OcrScopeOption
{
    /// <summary>Only the page currently on screen.</summary>
    CurrentPage,

    /// <summary>Every page in the document.</summary>
    WholeDocument,

    /// <summary>Only pages that carry no extractable text, i.e. the scanned ones.</summary>
    MissingTextOnly,
}

/// <summary>Maps every text span on a page back to its offset in the page text.</summary>
public sealed class PageTextMap
{
    public PageTextMap(
        int pageNumber,
        string text,
        IReadOnlyList<PageTextSpanRange> spanRanges,
        bool hasUsableText)
    {
        PageNumber = pageNumber;
        Text = text;
        SpanRanges = spanRanges;
        HasUsableText = hasUsableText;
    }

    public int PageNumber { get; }

    public string Text { get; }

    public IReadOnlyList<PageTextSpanRange> SpanRanges { get; }

    /// <summary>
    /// True when the page carries enough real text to read. A page that only has a
    /// scanner stamp or a watermark on an otherwise scanned image is not usable, and OCR
    /// should still run on it.
    /// </summary>
    public bool HasUsableText { get; }
}