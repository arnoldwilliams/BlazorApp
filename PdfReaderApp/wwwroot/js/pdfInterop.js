// ES module providing PDF rendering + text extraction on top of the vendored pdf.js build.
import * as pdfjsLib from '../lib/pdfjs/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../lib/pdfjs/build/pdf.worker.min.mjs', import.meta.url).href;

const PDFJS_ASSETS = new URL('../lib/pdfjs/', import.meta.url).href;

// Cache of pdf.js page proxies keyed by "documentId:pageNumber".
const pageCache = new Map();

// In flight render tasks per canvas, so a new render can cancel the previous one.
const renderTasks = new Map();

function cacheKey(docId, pageNumber) {
    return `${docId}:${pageNumber}`;
}

// Reference counted map so two viewers can show the same document safely.
const documents = new Map();
const refCounts = new Map();

async function getPage(docId, pageNumber) {
    const cached = pageCache.get(cacheKey(docId, pageNumber));
    if (cached) {
        return cached;
    }
    const doc = documents.get(docId);
    if (!doc) {
        throw new Error(`Unknown document: ${docId}`);
    }
    const page = await doc.getPage(pageNumber);
    pageCache.set(cacheKey(docId, pageNumber), page);
    return page;
}

async function openDocument(id, data, password) {
    if (documents.has(id)) {
        return documents.get(id).numPages;
    }

    const task = pdfjsLib.getDocument({
        data: new Uint8Array(data),
        password: password || undefined,
        cMapUrl: PDFJS_ASSETS + 'cmaps/',
        cMapPacked: true,
        standardFontDataUrl: PDFJS_ASSETS + 'standard_fonts/',
        wasmUrl: PDFJS_ASSETS + 'wasm/',
        iccUrl: PDFJS_ASSETS + 'iccs/',
    });

    let doc;
    try {
        doc = await task.promise;
    } catch (error) {
        // Normalise the password case into something Blazor can display.
        if (error && error.name === 'PasswordException') {
            throw new Error(`PasswordException:${error.code}:${error.message || ''}`);
        }
        throw new Error(error && error.message ? error.message : String(error));
    }

    documents.set(id, doc);
    refCounts.set(id, 1);
    return doc.numPages;
}

function releaseDocument(id) {
    const count = (refCounts.get(id) || 0) - 1;
    if (count > 0) {
        refCounts.set(id, count);
        return;
    }

    for (const key of Array.from(pageCache.keys())) {
        if (key.startsWith(`${id}:`)) {
            pageCache.delete(key);
        }
    }

    const doc = documents.get(id);
    refCounts.delete(id);
    documents.delete(id);
    if (doc) {
        doc.destroy();
    }
}

async function renderPage(documentId, pageNumber, canvas, wrapper, scale, rotation) {
    const page = await getPage(documentId, pageNumber);
    const outputScale = window.devicePixelRatio || 1;
    const viewport = page.getViewport({ scale: scale * outputScale, rotation: rotation });
    const context = canvas.getContext('2d');

    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);

    // Present the high resolution bitmap at CSS pixel size.
    const cssWidth = viewport.width / outputScale;
    const cssHeight = viewport.height / outputScale;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;
    wrapper.style.width = `${cssWidth}px`;
    wrapper.style.height = `${cssHeight}px`;

    // pdf.js refuses to render twice into one canvas, so cancel an in flight render
    // before starting a new one. This happens on rapid zoom or page changes.
    const previous = renderTasks.get(canvas);
    if (previous) {
        try {
            previous.cancel();
        } catch {
            /* already finished */
        }
        renderTasks.delete(canvas);
    }

    const renderTask = page.render({ canvasContext: context, viewport: viewport });
    renderTasks.set(canvas, renderTask);

    try {
        await renderTask.promise;
    } finally {
        if (renderTasks.get(canvas) === renderTask) {
            renderTasks.delete(canvas);
        }
    }

    return { width: cssWidth, height: cssHeight };
}

// Hosts registered by Blazor so clicks on the text layer can be routed back to .NET.
const hosts = new Map();
let clickListenerInstalled = false;

function attachHost(token, reference) {
    hosts.set(token, reference);
    if (clickListenerInstalled) {
        return;
    }

    document.addEventListener('click', (event) => {
        const layer = event.target && event.target.closest ? event.target.closest('.textLayer[data-pdf-host]') : null;
        if (!layer) {
            return;
        }

        const host = hosts.get(layer.dataset.pdfHost);
        if (!host) {
            return;
        }

        const pageNumber = Number.parseInt(layer.dataset.pageNumber, 10);
        if (!Number.isFinite(pageNumber)) {
            return;
        }

        const span = event.target.closest('span[data-num]');
        const spanNumber = span ? Number.parseInt(span.dataset.num, 10) : -1;
        host.invokeMethodAsync('OnTextSpanClickAsync', pageNumber, Number.isFinite(spanNumber) ? spanNumber : -1)
            .catch(() => { /* .NET side may be disposed during navigation. */ });
    });

    clickListenerInstalled = true;
}

function detachHost(token) {
    hosts.delete(token);
}

// Builds a positioned text layer over the canvas so text can be selected and highlighted.
async function renderTextLayer(documentId, pageNumber, container, scale, rotation, hostToken) {
    const page = await getPage(documentId, pageNumber);
    const viewport = page.getViewport({ scale: scale, rotation: rotation });

    container.replaceChildren();

    // The text layer positions itself with these custom properties, so they must be
    // present on the container before the layer is constructed.
    container.style.setProperty('--scale-factor', String(scale));
    container.style.setProperty('--total-scale-factor', String(scale));
    container.style.setProperty('--scale-round-x', '1px');
    container.style.setProperty('--scale-round-y', '1px');
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;
    container.dataset.pageNumber = String(pageNumber);
    if (hostToken) {
        container.dataset.pdfHost = hostToken;
    } else {
        delete container.dataset.pdfHost;
    }

    const textContent = await page.getTextContent();
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: textContent,
        container: container,
        viewport: viewport,
    });
    await textLayer.render();

    // Number the rendered spans in document order. pdf.js emits one span per non-empty
    // text item in order, which is the same order getPageText numbers its spans, so the
    // numbers line up and highlights can be mapped back to character offsets.
    const spans = container.querySelectorAll('span');
    let index = 0;
    for (const span of spans) {
        if (span.textContent && span.textContent.length > 0) {
            span.dataset.num = String(index++);
        } else {
            delete span.dataset.num;
        }
    }

    return { width: viewport.width, height: viewport.height };
}

// Highlights the spans of a page that intersect the spoken character range.
// Returns the span numbers that were highlighted so Blazor can scroll them into view.
function highlightRange(container, start, length) {
    clearHighlight(container);

    const end = start + length;
    const highlighted = [];

    for (const span of container.querySelectorAll('span[data-num]')) {
        const begin = span.dataset.begin;
        const stop = span.dataset.end;
        if (begin === undefined || stop === undefined) {
            continue;
        }

        const spanStart = Number.parseInt(begin, 10);
        const spanEnd = Number.parseInt(stop, 10);
        if (!Number.isFinite(spanStart) || !Number.isFinite(spanEnd)) {
            continue;
        }

        if (spanEnd > start && spanStart < end) {
            span.classList.add('pdf-speak-highlight');
            highlighted.push(Number.parseInt(span.dataset.num, 10));
        }
    }

    return highlighted;
}

function clearHighlight(container) {
    for (const span of container.querySelectorAll('span.pdf-speak-highlight')) {
        span.classList.remove('pdf-speak-highlight');
    }
}

// Records each span's character range inside the page text so highlights can be mapped.
function applySpanOffsets(container, ranges) {
    if (!container || typeof container.querySelectorAll !== 'function') {
        return;
    }

    const byNumber = new Map();
    for (const range of ranges || []) {
        byNumber.set(range.num, range);
    }

    for (const span of container.querySelectorAll('span[data-num]')) {
        const number = Number.parseInt(span.dataset.num, 10);
        const range = byNumber.get(number);
        if (!range) {
            continue;
        }
        span.dataset.begin = String(range.start);
        span.dataset.end = String(range.end);
    }
}

function clearSpanOffsets(container) {
    for (const span of container.querySelectorAll('span[data-num]')) {
        delete span.dataset.begin;
        delete span.dataset.end;
    }
}

async function getPageSize(documentId, pageNumber) {
    const page = await getPage(documentId, pageNumber);
    const viewport = page.getViewport({ scale: 1, rotation: 0 });
    return { width: viewport.width, height: viewport.height };
}

// Builds a single ordered model of a page: the full text plus per item offsets.
// pdf.js hands back text items in content order, so concatenating them with a
// separator yields a string whose offsets are stable for both speech and highlighting.
function buildPageModel(items) {
    const spans = [];
    let text = '';
    let number = 0;

    for (const item of items) {
        if (!item || typeof item.str !== 'string' || item.str.length === 0) {
            continue;
        }

        const separated = text.length === 0
            ? ''
            : (item.hasEOL ? '\n' : ' ');
        if (separated) {
            text += separated;
        }

        const start = text.length;
        text += item.str;
        spans.push({ num: number++, text: item.str, start: start });
    }

    // Drop trailing whitespace without shifting any span offset.
    text = text.replace(/\s+$/, '');

    return { text: text, spans: spans };
}

// Extracts the text of a page, returning the text and the per item offsets.
async function getPageText(documentId, pageNumber) {
    const page = await getPage(documentId, pageNumber);
    const content = await page.getTextContent();
    const model = buildPageModel(content.items);

    if (model.text.length === 0) {
        return { text: '', spans: [] };
    }

    return {
        text: model.text,
        spans: model.spans.map((span) => ({ num: span.num, text: span.text, start: span.start })),
    };
}

// Page sizes for every page, used to lay out the continuous view before rendering.
async function getAllPageSizes(documentId) {
    const doc = documents.get(documentId);
    if (!doc) {
        throw new Error(`Unknown document: ${documentId}`);
    }

    const sizes = [];
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
        const page = await getPage(documentId, pageNumber);
        const viewport = page.getViewport({ scale: 1, rotation: 0 });
        sizes.push({ width: viewport.width, height: viewport.height });
    }

    return sizes;
}

// Tracks which page placeholders are near the viewport so Blazor can render them lazily.
const pageObservers = new Map();

function observePages(token, root, reference) {
    unobservePages(token);

    const observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) {
                continue;
            }

            const pageNumber = Number.parseInt(entry.target.dataset.pageNumber, 10);
            if (Number.isFinite(pageNumber)) {
                reference.invokeMethodAsync('OnPageVisibleAsync', pageNumber)
                    .catch(() => { /* .NET side may be disposed during navigation. */ });
            }
        }
    }, { root: root || null, rootMargin: '300px 0px' });

    for (const element of (root || document).querySelectorAll('.pdf-page[data-page-number]')) {
        observer.observe(element);
    }

    pageObservers.set(token, observer);
}

function unobservePages(token) {
    const observer = pageObservers.get(token);
    if (observer) {
        observer.disconnect();
        pageObservers.delete(token);
    }
}

function scrollToPage(root, pageNumber) {
    const target = (root || document).querySelector(`.pdf-page[data-page-number="${pageNumber}"]`);
    if (target) {
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

function scrollToSpan(container, spanNumber) {
    if (!container || spanNumber < 0) {
        return;
    }

    const span = container.querySelector(`span[data-num="${spanNumber}"]`);
    if (span) {
        span.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

// Installs the styles pdf.js expects on a text layer. The stylesheet is defined by
// `TextLayer` in pdf.js instead of being shipped as a separate file, so mirror the
// essentials here to keep the layer aligned with the rendered canvas.
function ensureTextLayerStyles() {
    if (document.getElementById('pdfjs-text-layer-styles')) {
        return;
    }

    const style = document.createElement('style');
    style.id = 'pdfjs-text-layer-styles';
    style.textContent = `
.textLayer {
    position: absolute;
    inset: 0;
    overflow: hidden;
    line-height: 1;
    text-size-adjust: none;
    forced-color-adjust: none;
    transform-origin: 0 0;
    caret-color: CanvasText;
}
.textLayer :is(span, br) {
    color: transparent;
    position: absolute;
    white-space: pre;
    cursor: text;
    transform-origin: 0% 0%;
}
.textLayer span {
    font-size: var(--font-height, 1em);
    line-height: 1;
}
.textLayer span.markedContent { top: 0; height: 0; }
.textLayer ::selection { background: rgba(0, 100, 255, 0.35); }
`;
    document.head.append(style);
}

const api = {
    openDocument,
    releaseDocument,
    renderPage,
    renderTextLayer,
    getPageText,
    getPageSize,
    getAllPageSizes,
    ensureTextLayerStyles,
    attachHost,
    detachHost,
    highlightRange,
    clearHighlight,
    applySpanOffsets,
    clearSpanOffsets,
    observePages,
    unobservePages,
    scrollToPage,
    scrollToSpan,
};

window.pdfInterop = api;

export default api;
export {
    openDocument,
    releaseDocument,
    renderPage,
    renderTextLayer,
    getPageText,
    getPageSize,
    getAllPageSizes,
    ensureTextLayerStyles,
    attachHost,
    detachHost,
    highlightRange,
    clearHighlight,
    applySpanOffsets,
    clearSpanOffsets,
    observePages,
    unobservePages,
    scrollToPage,
    scrollToSpan,
};
