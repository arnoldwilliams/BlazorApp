using Microsoft.JSInterop;
using PdfReaderApp.Models;

namespace PdfReaderApp.Services;

/// <summary>
/// Runs optical character recognition over PDF pages using the vendored tesseract.js
/// bundle in <c>wwwroot/js/ocr.js</c>.
/// </summary>
public sealed class OcrService : IAsyncDisposable
{
    private readonly IJSRuntime js;
    private IJSObjectReference? module;

    public OcrService(IJSRuntime js)
    {
        this.js = js;
    }

    /// <summary>Languages offered in the UI. Only the ones actually bundled will work.</summary>
    public static IReadOnlyList<OcrLanguage> Languages { get; } =
    [
        new("eng", "English"),
    ];

    private async Task<IJSObjectReference> GetModuleAsync(CancellationToken cancellationToken = default)
        => module ??= await js.InvokeAsync<IJSObjectReference>("import", cancellationToken, "./js/ocr.js");

    /// <summary>
    /// Recognises a single page and returns its text. <paramref name="onProgress"/> is
    /// called as the engine works so the UI can show a percentage.
    /// </summary>
    public async Task<OcrPageResult> RecognizePageAsync(
        string documentId,
        int pageNumber,
        string language,
        double scale,
        double rotation,
        Action<OcrProgress>? onProgress = null,
        CancellationToken cancellationToken = default)
    {
        var reference = onProgress is null
            ? null
            : DotNetObjectReference.Create(new ProgressBridge(onProgress));

        try
        {
            var target = await GetModuleAsync(cancellationToken);
            return await target.InvokeAsync<OcrPageResult>(
                "recognizePage",
                cancellationToken,
                documentId,
                pageNumber,
                new
                {
                    language,
                    scale,
                    rotation,
                    onProgress = reference,
                });
        }
        finally
        {
            reference?.Dispose();
        }
    }

    /// <summary>Releases the recognition worker once a run is finished or abandoned.</summary>
    public async Task TerminateAsync()
    {
        await InvokeQuietlyAsync("terminate");
    }

    /// <summary>Tears the worker down mid run; the pending recognition then fails.</summary>
    public async Task CancelAsync()
    {
        await InvokeQuietlyAsync("cancel");
    }

    private async Task InvokeQuietlyAsync(string function)
    {
        if (module is null)
        {
            return;
        }

        try
        {
            await module.InvokeVoidAsync(function);
        }
        catch (JSDisconnectedException)
        {
            // The browser page is going away, so the worker goes with it.
        }
    }

    public async ValueTask DisposeAsync()
    {
        await TerminateAsync();

        if (module is not null)
        {
            try
            {
                await module.DisposeAsync();
            }
            catch (JSDisconnectedException)
            {
                // The JS runtime is already gone.
            }

            module = null;
        }
    }

    /// <summary>Receives tesseract's progress messages from JavaScript.</summary>
    private sealed class ProgressBridge
    {
        private readonly Action<OcrProgress> callback;

        public ProgressBridge(Action<OcrProgress> callback)
        {
            this.callback = callback;
        }

        [JSInvokable]
        public void OnOcrProgress(string status, double progress)
            => callback(new OcrProgress(status, progress));
    }
}

/// <summary>Progress reported by the OCR engine for one page.</summary>
public sealed record OcrProgress(string Status, double Progress);
