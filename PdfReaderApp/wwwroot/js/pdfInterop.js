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

    // A page that has been through OCR gets its text layer rebuilt from the recognised
    // words instead of pdf.js, so a scanned page becomes selectable and clickable.
    const override = textOverrides.get(overrideKey(documentId, pageNumber));
    if (override && override.spans && override.spans.length > 0) {
        return await renderOcrTextLayer(documentId, pageNumber, container, scale, rotation, override.spans, hostToken);
    }

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

// Renders a page into a detached canvas at an explicit scale, for OCR. Unlike
// renderPage this takes no wrapper and never touches the page cache, so an OCR
// pass cannot disturb what is currently on screen.
async function renderPageToCanvas(documentId, pageNumber, canvas, scale, rotation) {
    const page = await getPage(documentId, pageNumber);
    const viewport = page.getViewport({ scale: scale, rotation: rotation });
    const context = canvas.getContext('2d', { willReadFrequently: true });

    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));

    // OCR reads glyph shapes, so paint the page on white instead of leaving the
    // canvas transparent: the engine binarises against the background it finds.
    context.save();
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.restore();

    await page.render({ canvasContext: context, viewport: viewport }).promise;

    return { width: canvas.width, height: canvas.height };
}

// The pdf.js viewport for a page at an explicit scale and rotation. The caller gets the
// real PageViewport, not a copy of its size, because its conversion methods are what map
// between image pixels and the page's own coordinates.
async function getPageViewport(documentId, pageNumber, scale, rotation) {
    const page = await getPage(documentId, pageNumber);
    return page.getViewport({ scale: scale, rotation: rotation });
}

// Text overrides captured from OCR, keyed by document and page. When a page has an
// override, its text replaces whatever pdf.js can extract, so a scanned page becomes
// readable even though the original PDF carries no text layer at all.
const textOverrides = new Map();

function overrideKey(documentId, pageNumber) {
    return `${documentId}:${pageNumber}`;
}

/// Stores the text an OCR pass recognised for one page, together with the per word
/// offsets that let the read aloud highlighting map back onto the page.
function setPageTextOverride(documentId, pageNumber, text, spans) {
    textOverrides.set(overrideKey(documentId, pageNumber), {
        text: text || '',
        spans: spans || [],
    });
}

function clearPageTextOverride(documentId, pageNumber) {
    textOverrides.delete(overrideKey(documentId, pageNumber));
}

function clearTextOverrides(documentId) {
    for (const key of Array.from(textOverrides.keys())) {
        if (key.startsWith(`${documentId}:`)) {
            textOverrides.delete(key);
        }
    }
}

// Writes OCR words into a text layer as absolutely positioned spans. Each word carries
// a data-num so the existing click, offset and highlight plumbing keeps working.
// The recognised boxes are stored in the page's own coordinate space, so they are mapped
// onto the page through the viewport, which is what keeps them on their glyphs at any
// rotation or zoom.
async function renderOcrTextLayer(documentId, pageNumber, container, scale, rotation, words, hostToken) {
    const page = await getPage(documentId, pageNumber);

    // The layer is laid out in the same space as the canvas, so it takes the caller's
    // scale and rotation rather than assuming an unscaled page.
    const viewport = page.getViewport({ scale: scale, rotation: rotation });

    container.replaceChildren();
    container.style.setProperty('--scale-factor', String(scale));
    container.style.setProperty('--total-scale-factor', String(scale));
    container.style.width = `${viewport.width}px`;
    container.style.height = `${viewport.height}px`;
    container.dataset.pageNumber = String(pageNumber);
    if (hostToken) {
        container.dataset.pdfHost = hostToken;
    } else {
        delete container.dataset.pdfHost;
    }

    let index = 0;
    for (const word of words || []) {
        const text = (word.text || '').trim();
        const box = word.bbox;
        if (!text || !box) {
            continue;
        }

        // Boxes arrive as fractions of the page, so they are mapped onto the rotated page
        // through the viewport's own transform. That keeps a word over its glyphs for any
        // rotation or zoom, including a page whose own rotation is not a multiple of 90.
        const corners = [
            viewport.convertToViewportPoint(box.x0, box.y0),
            viewport.convertToViewportPoint(box.x1, box.y0),
            viewport.convertToViewportPoint(box.x0, box.y1),
            viewport.convertToViewportPoint(box.x1, box.y1),
        ];

        const xs = corners.map(point => point[0]);
        const ys = corners.map(point => point[1]);
        const left = Math.max(0, Math.min(...xs));
        const top = Math.max(0, Math.min(...ys));
        const right = Math.min(viewport.width, Math.max(...xs));
        const bottom = Math.min(viewport.height, Math.max(...ys));

        const width = right - left;
        const height = bottom - top;
        if (width <= 0 || height <= 0) {
            continue;
        }

        const span = document.createElement('span');
        span.textContent = text;
        span.dataset.num = String(index++);
        span.style.left = `${left}px`;
        span.style.top = `${top}px`;
        span.style.width = `${width}px`;
        span.style.height = `${height}px`;
        span.style.fontSize = `${height}px`;
        container.appendChild(span);
    }

    return { width: viewport.width, height: viewport.height, spans: index };
}

// Turns recognised words into the same shape pdf.js text produces: one string plus the
// offset of every span inside it. Words are grouped into lines by their vertical
// position so the text reads naturally, and each line is separated by a newline.
// Tesseract reports boxes in the pixel space of the image it was given. Those boxes are
// converted into the page's own coordinate space through the viewport's inverse
// transform, which is the only space that stays valid when the page is later rotated or
// zoomed. The conversion also flips the vertical axis, since pdf.js measures a page from
// its bottom left while an image measures it from the top left.
function buildOcrPageModel(words, viewport) {
    const imageWidth = viewport && viewport.width ? viewport.width : 1;
    const imageHeight = viewport && viewport.height ? viewport.height : 1;

    const usable = [];
    for (const word of words || []) {
        const text = (word.text || '').trim();
        const box = word.bbox;
        if (!text || !box) {
            continue;
        }

        // Recognition occasionally reports a box that runs past the edge of the image.
        // Clamping it here guarantees the word lands inside the page it belongs to.
        const left = Math.max(0, Math.min(box.x0, box.x1));
        const top = Math.max(0, Math.min(box.y0, box.y1));
        const right = Math.min(imageWidth, Math.max(box.x0, box.x1));
        const bottom = Math.min(imageHeight, Math.max(box.y0, box.y1));
        if (right - left <= 0 || bottom - top <= 0) {
            continue;
        }

        const corners = [
            viewport.convertToPdfPoint(left, top),
            viewport.convertToPdfPoint(right, top),
            viewport.convertToPdfPoint(left, bottom),
            viewport.convertToPdfPoint(right, bottom),
        ];

        const xs = corners.map(point => point[0]);
        const ys = corners.map(point => point[1]);

        usable.push({
            text: text,
            bbox: {
                x0: Math.min(...xs),
                y0: Math.min(...ys),
                x1: Math.max(...xs),
                y1: Math.max(...ys),
            },
            // Vertical centre, used to decide which line a word belongs to. Taken from the
            // image so that lines are read top to bottom regardless of page rotation.
            centre: (top + bottom) / 2,
            height: Math.max(1, bottom - top),
        });
    }

    if (usable.length === 0) {
        return { text: '', spans: [] };
    }

    // Lines are built from the top down. A word joins the current line while it stays
    // within roughly half a line height of that line's centre, otherwise it starts one.
    usable.sort((a, b) => a.centre - b.centre || a.bbox.x0 - b.bbox.x0);

    const lines = [];
    for (const word of usable) {
        const line = lines[lines.length - 1];
        if (line && Math.abs(word.centre - line.centre) <= Math.max(line.height, word.height) * 0.6) {
            line.words.push(word);
            line.height = Math.max(line.height, word.height);
        } else {
            lines.push({ centre: word.centre, height: word.height, words: [word] });
        }
    }

    let text = '';
    const spans = [];
    let number = 0;

    for (const line of lines) {
        line.words.sort((a, b) => a.bbox.x0 - b.bbox.x0);

        for (const word of line.words) {
            if (text.length > 0) {
                text += ' ';
            }

            const start = text.length;
            text += word.text;
            spans.push({
                num: number++,
                text: word.text,
                start: start,
                bbox: word.bbox,
            });
        }

        // A newline between lines keeps the chunker's sentence detection sane.
        text += '\n';
    }

    text = text.replace(/\s+$/, '');

    return { text: text, spans: spans };
}

// Extracts the text of a page, returning the text and the per item offsets.
async function getPageText(documentId, pageNumber) {
    // An OCR pass wins over pdf.js: a scanned page has no usable text layer, and where
    // OCR has run it is the only source that reflects what is actually on the page.
    const override = textOverrides.get(overrideKey(documentId, pageNumber));
    if (override) {
        return { text: override.text, spans: override.spans };
    }

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
    renderPageToCanvas,
    getPageViewport,
    buildOcrPageModel,
    setPageTextOverride,
    clearPageTextOverride,
    clearTextOverrides,
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
    renderPageToCanvas,
    getPageViewport,
    buildOcrPageModel,
    setPageTextOverride,
    clearPageTextOverride,
    clearTextOverrides,
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
