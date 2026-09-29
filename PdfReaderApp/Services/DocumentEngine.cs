using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PdfReaderApp.Models;

namespace PdfReaderApp.Services;

/// <summary>Receives events originating from a document's text layer in the browser.</summary>
public interface IDocumentTextHost
{
    /// <summary>Called with a page number and the span that was clicked, or -1 for an empty area.</summary>
    [JSInvokable]
    Task OnTextSpanClickAsync(int pageNumber, int spanNumber);
}

/// <summary>Receives page visibility notifications from the IntersectionObserver.</summary>
public interface IDocumentPageVisibilityHost
{
    [JSInvokable]
    Task OnPageVisibleAsync(int pageNumber);
}

/// <summary>
/// Reads the text of an already opened document. This is the surface the read aloud
/// controller depends on, so it stays independent of the rendering engine.
/// </summary>
public interface IDocumentTextSource
{
    bool IsInitialized { get; }

    Task InitializeAsync(CancellationToken cancellationToken = default);

    /// <summary>Opens a document and returns its page count.</summary>
    Task<int> OpenDocumentAsync(string documentId, byte[] bytes, CancellationToken cancellationToken = default);

    Task ReleaseDocumentAsync(string documentId);

    /// <summary>Sizes of every page, used to lay out the continuous view before rendering.</summary>
    Task<DocumentPageSize[]> GetAllPageSizesAsync(string documentId);

    Task<DocumentPageText?> GetPageTextAsync(string documentId, int pageNumber);

    /// <summary>Maps text spans to offsets in the page text so spoken ranges can highlight them.</summary>
    Task ApplySpanOffsetsAsync(ElementReference container, IReadOnlyList<PageTextSpanRange> ranges);

    /// <summary>Highlights spans intersecting the range and returns the highlighted span numbers.</summary>
    Task<int[]> HighlightRangeAsync(ElementReference container, int start, int length);

    Task ClearHighlightAsync(ElementReference container);
}

/// <summary>
/// Forwards text access to whichever engine is currently showing a document. The read
/// aloud controller is constructed once with this source, and the viewer points it at the
/// engine selected for the file that was opened.
/// </summary>
public sealed class ActiveDocumentSource : IDocumentTextSource
{
    public IDocumentTextSource? Current { get; set; }

    private IDocumentTextSource Active
        => Current ?? throw new InvalidOperationException("No document is open.");

    public bool IsInitialized => Current?.IsInitialized ?? false;

    public Task InitializeAsync(CancellationToken cancellationToken = default)
        => Active.InitializeAsync(cancellationToken);

    public Task<int> OpenDocumentAsync(string documentId, byte[] bytes, CancellationToken cancellationToken = default)
        => Active.OpenDocumentAsync(documentId, bytes, cancellationToken);

    public Task ReleaseDocumentAsync(string documentId)
        => Active.ReleaseDocumentAsync(documentId);

    public Task<DocumentPageSize[]> GetAllPageSizesAsync(string documentId)
        => Active.GetAllPageSizesAsync(documentId);

    public Task<DocumentPageText?> GetPageTextAsync(string documentId, int pageNumber)
        => Active.GetPageTextAsync(documentId, pageNumber);

    public Task ApplySpanOffsetsAsync(ElementReference container, IReadOnlyList<PageTextSpanRange> ranges)
        => Active.ApplySpanOffsetsAsync(container, ranges);

    public Task<int[]> HighlightRangeAsync(ElementReference container, int start, int length)
        => Active.HighlightRangeAsync(container, start, length);

    public Task ClearHighlightAsync(ElementReference container)
        => Active.ClearHighlightAsync(container);
}

/// <summary>
/// A rendering engine for one document format. The viewer picks the engine that matches
/// the file that was opened; everything else in the reader is format agnostic.
/// </summary>
public interface IDocumentEngine : IDocumentTextSource, IAsyncDisposable
{
    /// <summary>The format this engine handles.</summary>
    DocumentFormat Format { get; }

    /// <summary>Human readable name used in status messages, such as "PDF".</summary>
    string DisplayName { get; }

    Task RenderPageAsync(
        string documentId,
        int pageNumber,
        ElementReference canvas,
        ElementReference wrapper,
        double scale,
        double rotationDegrees);

    Task RenderTextLayerAsync(
        string documentId,
        int pageNumber,
        ElementReference container,
        double scale,
        double rotationDegrees);

    /// <summary>Wires up a host so clicks on the text layer can reach the viewer component.</summary>
    Task<string> AttachHostAsync(IDocumentTextHost host);

    Task DetachHostAsync(string? token);

    /// <summary>Watches page placeholders so only the pages near the viewport get rendered.</summary>
    Task<string> ObservePagesAsync(ElementReference root, IDocumentPageVisibilityHost host);

    Task UnobservePagesAsync(string? token);

    Task ScrollToPageAsync(ElementReference root, int pageNumber);
}
