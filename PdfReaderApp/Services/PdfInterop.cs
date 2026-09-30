using Microsoft.AspNetCore.Components;
using Microsoft.JSInterop;
using PdfReaderApp.Models;

namespace PdfReaderApp.Services;

/// <summary>
/// Thin wrapper over the pdf.js ES module in <c>wwwroot/js/pdfInterop.js</c>.
/// </summary>
public sealed class PdfInterop : IAsyncDisposable
{
    private readonly IJSRuntime js;
    private IJSObjectReference? module;
    private DotNetObjectReference<IPdfDocumentHost>? hostReference;
    private DotNetObjectReference<IPdfPageVisibilityHost>? visibilityReference;

    /// <summary>Token stamped onto text layers so clicks route back to the attached host.</summary>
    private string? hostToken;

    public PdfInterop(IJSRuntime js)
    {
        this.js = js;
    }

    public bool IsInitialized => module is not null;

    public async Task InitializeAsync(CancellationToken cancellationToken = default)
    {
        if (module is not null)
        {
            return;
        }

        module = await js.InvokeAsync<IJSObjectReference>("import", cancellationToken, "./js/pdfInterop.js");
        await module.InvokeVoidAsync("ensureTextLayerStyles", cancellationToken);
    }

    public async Task<int> OpenDocumentAsync(string documentId, byte[] bytes, CancellationToken cancellationToken = default)
    {
        await InitializeAsync(cancellationToken);
        return await module!.InvokeAsync<int>("openDocument", cancellationToken, documentId, bytes, null);
    }

    public async Task ReleaseDocumentAsync(string documentId)
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("releaseDocument", documentId);
    }

    public async Task<PdfPageSize?> GetPageSizeAsync(string documentId, int pageNumber)
    {
        await InitializeAsync();
        return await module!.InvokeAsync<PdfPageSize>("getPageSize", documentId, pageNumber);
    }

    /// <summary>Sizes of every page, used to lay out the continuous view before rendering.</summary>
    public async Task<PdfPageSize[]> GetAllPageSizesAsync(string documentId)
    {
        await InitializeAsync();
        return await module!.InvokeAsync<PdfPageSize[]>("getAllPageSizes", documentId);
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
        // The host token is stamped onto the layer so clicks route back to this viewer.
        await module!.InvokeVoidAsync("renderTextLayer", documentId, pageNumber, container, scale, rotationDegrees, hostToken);
    }

    public async Task<PdfPageText?> GetPageTextAsync(string documentId, int pageNumber)
    {
        await InitializeAsync();
        return await module!.InvokeAsync<PdfPageText>("getPageText", documentId, pageNumber);
    }

    /// <summary>
    /// Stores recognised text for a page. From here on the page reports this text instead
    /// of whatever pdf.js can extract, which is what makes a scanned page readable.
    /// </summary>
    public async Task SetPageTextOverrideAsync(string documentId, OcrPageResult result)
    {
        await InitializeAsync();
        await module!.InvokeVoidAsync("setPageTextOverride", documentId, result.PageNumber, result.Text, result.Spans);
    }

    public async Task ClearTextOverridesAsync(string documentId)
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("clearTextOverrides", documentId);
    }

    /// <summary>Maps text spans to offsets in the page text so spoken ranges can highlight them.</summary>
    public async Task ApplySpanOffsetsAsync(ElementReference container, IReadOnlyList<PageTextSpanRange> ranges)
    {
        await InitializeAsync();
        await module!.InvokeVoidAsync("applySpanOffsets", container, ranges);
    }

    public async Task ClearSpanOffsetsAsync(ElementReference container)
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("clearSpanOffsets", container);
    }

    /// <summary>Highlights spans intersecting the range and returns the highlighted span numbers.</summary>
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

    /// <summary>Wires up a host so clicks on the text layer can reach the viewer component.</summary>
    public async Task<string> AttachHostAsync(IPdfDocumentHost host)
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

    /// <summary>Watches page placeholders so only the pages near the viewport get rendered.</summary>
    public async Task<string> ObservePagesAsync(ElementReference root, IPdfPageVisibilityHost host)
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

    public async Task ScrollToSpanAsync(ElementReference container, int spanNumber)
    {
        if (module is null)
        {
            return;
        }

        await module.InvokeVoidAsync("scrollToSpan", container, spanNumber);
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

/// <summary>Receives events originating from the PDF layer in the browser.</summary>
public interface IPdfDocumentHost
{
    /// <summary>Called with a page number and the span that was clicked, or -1 for an empty area.</summary>
    [JSInvokable]
    Task OnTextSpanClickAsync(int pageNumber, int spanNumber);
}

/// <summary>Receives page visibility notifications from the IntersectionObserver.</summary>
public interface IPdfPageVisibilityHost
{
    [JSInvokable]
    Task OnPageVisibleAsync(int pageNumber);
}