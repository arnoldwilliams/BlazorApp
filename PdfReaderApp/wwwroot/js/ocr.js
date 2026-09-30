// OCR for scanned PDFs, built on the vendored tesseract.js bundle in ../lib/tesseract.
//
// tesseract.js is a classic script rather than an ES module, so it is injected on first
// use. Every asset it needs (worker, wasm core, traineddata) is served from this app's
// own origin, so recognition works with no network access and no data leaves the browser.
import * as pdf from './pdfInterop.js';

const TESSERACT_SCRIPT = new URL('../lib/tesseract/tesseract.min.js', import.meta.url).href;
const TESSERACT_BASE = new URL('../lib/tesseract/', import.meta.url).href;

let scriptPromise = null;
let worker = null;
let workerLanguage = null;

// The worker's logger is bound once, at creation, so it must not capture a particular
// caller's callback: the worker outlives any single recognition. Progress is routed
// through this sink, which each call sets while it runs and clears when it is done.
let progressSink = null;

function reportProgress(message) {
    if (!progressSink || !message) {
        return;
    }

    try {
        // Blazor hands over a DotNetObjectReference, so progress has to be pushed back
        // through invokeMethodAsync rather than a plain callback.
        if (typeof progressSink.invokeMethodAsync === 'function') {
            progressSink.invokeMethodAsync('OnOcrProgress', message.status || '', message.progress || 0);
        } else if (typeof progressSink === 'function') {
            progressSink(message);
        }
    } catch {
        // A disposed bridge means the caller has moved on; losing a progress tick is fine.
    }
}

function loadEngine() {
    if (window.Tesseract) {
        return Promise.resolve(window.Tesseract);
    }

    if (scriptPromise) {
        return scriptPromise;
    }

    scriptPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = TESSERACT_SCRIPT;
        script.onload = () => {
            if (window.Tesseract) {
                resolve(window.Tesseract);
            } else {
                reject(new Error('The OCR engine loaded but did not register itself.'));
            }
        };
        script.onerror = () => {
            scriptPromise = null;
            reject(new Error('The OCR engine could not be loaded.'));
        };
        document.head.appendChild(script);
    });

    return scriptPromise;
}

async function getWorker(language) {
    const Tesseract = await loadEngine();

    if (worker && workerLanguage === language) {
        return worker;
    }

    await releaseWorker();

    worker = await Tesseract.createWorker(language, 1, {
        workerPath: TESSERACT_BASE + 'worker.min.js',
        corePath: TESSERACT_BASE,
        langPath: TESSERACT_BASE,
        // Keep the worker on this origin: a blob worker cannot resolve the sibling
        // assets with a relative path.
        workerBlobURL: false,
        // The traineddata is served uncompressed, so do not ask for a .gz.
        gzip: false,
        cacheMethod: 'none',
        logger: reportProgress,
    });

    workerLanguage = language;
    return worker;
}

async function releaseWorker() {
    progressSink = null;

    if (worker) {
        try {
            await worker.terminate();
        } catch {
            // Terminating an already dead worker is not an error worth surfacing.
        }
    }

    worker = null;
    workerLanguage = null;
}

/// Recognises one page of a document. Returns the recognised text, the per word offsets
/// the rest of the viewer needs, and the mean confidence.
export async function recognizePage(documentId, pageNumber, options) {
    const settings = options || {};
    const scale = settings.scale > 0 ? settings.scale : 2;
    const rotation = settings.rotation || 0;
    const language = settings.language || 'eng';
    const onProgress = settings.onProgress;

    const canvas = document.createElement('canvas');

    // Recognition always reads the page upright, never at the rotation it happens to be
    // displayed at. Tesseract cannot read sideways text, and the recognised boxes are
    // stored relative to the page, so the viewer's rotation is applied later when the
    // boxes are mapped onto the page. That keeps the text and its geometry independent of
    // how the page is currently turned on screen.
    const ocrRotation = 0;

    try {
        // Render from the same pdf.js document the viewer is showing, at a higher scale than
        // the screen. Small glyphs are the main cause of poor recognition, so this is the
        // single biggest lever on accuracy.
        await pdf.renderPageToCanvas(documentId, pageNumber, canvas, scale, ocrRotation);

        const instance = await getWorker(language);
        progressSink = onProgress || null;

        const result = await instance.recognize(canvas);
        const data = result && result.data ? result.data : {};

        // Ask pdf.js for the page size at the scale being recognised. It is the only
        // reliable source for a page whose own rotation is unusual, and the same space is
        // used later to map the recognised boxes back onto the page.
        const viewport = await pdf.getPageViewport(documentId, pageNumber, scale, ocrRotation);

        const model = pdf.buildOcrPageModel(data.words || [], viewport);

        return {
            pageNumber: pageNumber,
            text: model.text,
            spans: model.spans,
            confidence: typeof data.confidence === 'number' ? data.confidence : 0,
            wordCount: model.spans.length,
            scale: scale,
            rotation: rotation,
        };
    } finally {
        // tesseract can emit a trailing tick after recognize() resolves, so the sink is
        // cleared on a later turn rather than immediately. The bridge must outlive it.
        setTimeout(() => {
            progressSink = null;
        }, 1000);

        // Release the bitmap promptly; a full size page canvas is several megabytes.
        canvas.width = 0;
        canvas.height = 0;
    }
}

/// Frees the worker. Called when a run finishes, is cancelled, or the viewer is disposed.
export async function terminate() {
    await releaseWorker();
}

/// Stops a run that is already under way. tesseract.js has no cancel call, so the worker
/// is torn down; the in flight recognize() then rejects and the caller sees a cancellation.
export async function cancel() {
    await releaseWorker();
}

export default { recognizePage, terminate, cancel };
