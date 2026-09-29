using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PdfReaderApp.Models;

namespace PdfReaderApp.Services;

/// <summary>
/// Document engine for Word files, backed by the mammoth.js module in
/// <c>wwwroot/js/docxInterop.js</c>. The document is converted to HTML and paginated
/// in the browser, then rendered with the same page model as the PDF reader.
/// </summary>
public sealed class DocxInterop : IDocumentEngine
{
    private readonly IJSRuntime js;
    private IJSObjectReference? module;
    private DotNetObjectReference<IDocumentTextHost>? hostReference;
    private DotNetObjectReference<IDocumentPageVisibilityHost>? visibilityReference;

    /// <summary>Token stamped onto text layers so clicks route back to the attached host.</summary>
    private string? hostToken;

    public DocxInterop(IJSRuntime js)
    {
        this.js = js;
    }

    public DocumentFormat Format => DocumentFormat.Docx;

    public string DisplayName => "Word document";

    public bool IsInitialized => module is not null;

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        if (module is not null)
        {
            return;
        }

        module = await js.InvokeAsync<IJSObjectReference>("import", cancellationToken, "./js/docxInterop.js");
    }

    public async Task<int> OpenDocumentAsync(string documentId, byte[] bytes, CancellationToken cancellationToken = default)
    {
        await InitializeAsync(cancellationToken);
        return await module!.InvokeAsync<int>("openDocument", cancellationToken, documentId, bytes);
    }

    public async Task ReleaseDocumentAsync(string documentId)
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("releaseDocument", documentId);
    }

    public async Task<DocumentPageSize[]> GetAllPageSizesAsync(string documentId)
    {
        await InitializeAsync();
        return await module!.InvokeAsync<DocumentPageSize[]>("getAllPageSizes", documentId);
    }

    public async Task RenderPageAsync(
        string documentId,
        int pageNumber,
        ElementReference canvas,
        ElementReference wrapper,
        double scale,
        double rotationDegrees)
    {
        await InitializeAsync();
        await module!.InvokeVoidAsync("renderPage", documentId, pageNumber, canvas, wrapper, scale, rotationDegrees);
    }

    public async Task RenderTextLayerAsync(
        string documentId,
        int pageNumber,
        ElementReference container,
        double scale,
        double rotationDegrees)
    {
        await InitializeAsync();
        // The host token is stamped onto the page so clicks route back to this viewer.
        await module!.InvokeVoidAsync("renderTextLayer", documentId, pageNumber, container, scale, rotationDegrees, hostToken);
    }

    public async Task<DocumentPageText?> GetPageTextAsync(string documentId, int pageNumber)
    {
        await InitializeAsync();
        return await module!.InvokeAsync<DocumentPageText>("getPageText", documentId, pageNumber);
    }

    public async Task ApplySpanOffsetsAsync(ElementReference container, IReadOnlyList<PageTextSpanRange> ranges)
    {
        await InitializeAsync();
        await module!.InvokeVoidAsync("applySpanOffsets", container, ranges);
    }

    public async Task<int[]> HighlightRangeAsync(ElementReference container, int start, int length)
    {
        if (module is null)
        {
            return [];
        }

        return await module.InvokeAsync<int[]>("highlightRange", container, start, length);
    }

    public async Task ClearHighlightAsync(ElementReference container)
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("clearHighlight", container);
    }

    public async Task<string> AttachHostAsync(IDocumentTextHost host)
    {
        await InitializeAsync();

        hostReference?.Dispose();
        hostReference = DotNetObjectReference.Create(host);

        hostToken = Guid.NewGuid().ToString("N");
        await module!.InvokeVoidAsync("attachHost", hostToken, hostReference);
        return hostToken;
    }

    public async Task DetachHostAsync(string? token)
    {
        if (module is null || string.IsNullOrEmpty(token))
        {
            hostReference?.Dispose();
            hostReference = null;
            hostToken = null;
            return;
        }

        try
        {
            await module.InvokeVoidAsync("detachHost", token);
        }
        catch (JSDisconnectedException)
        {
            // The browser page is going away, nothing left to detach.
        }

        hostReference?.Dispose();
        hostReference = null;
        hostToken = null;
    }

    public async Task<string> ObservePagesAsync(ElementReference root, IDocumentPageVisibilityHost host)
    {
        await InitializeAsync();

        visibilityReference?.Dispose();
        visibilityReference = DotNetObjectReference.Create(host);

        var token = Guid.NewGuid().ToString("N");
        await module!.InvokeVoidAsync("observePages", token, root, visibilityReference);
        return token;
    }

    public async Task UnobservePagesAsync(string? token)
    {
        if (module is null || string.IsNullOrEmpty(token))
        {
            visibilityReference?.Dispose();
            visibilityReference = null;
            return;
        }

        try
        {
            await module.InvokeVoidAsync("unobservePages", token);
        }
        catch (JSDisconnectedException)
        {
            // The browser page is going away.
        }

        visibilityReference?.Dispose();
        visibilityReference = null;
    }

    public async Task ScrollToPageAsync(ElementReference root, int pageNumber)
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("scrollToPage", root, pageNumber);
    }

    public async ValueTask DisposeAsync()
    {
        hostReference?.Dispose();
        visibilityReference?.Dispose();

        if (module is not null)
        {
            try
            {
                await module.DisposeAsync();
            }
            catch (JSDisconnectedException)
            {
                // The JS runtime is already gone, so the module cannot be disposed.
            }

            module = null;
        }
    }
}
