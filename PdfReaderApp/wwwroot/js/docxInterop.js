// ES module providing DOCX rendering + text extraction.
//
// The browser build of mammoth.js converts the WordprocessingML into HTML. That HTML is
// then paginated into letter sized "pages" so it can be shown with the same page model
// the PDF viewer uses (page number, canvas sized wrapper, text layer with spans).

const MAMMOTH_SCRIPT = './lib/mammoth/mammoth.browser.min.js';

// Letter page expressed in CSS pixels at 96 dpi.
const PAGE_WIDTH = 816;
const PAGE_HEIGHT = 1056;
const PAGE_MARGIN = 96;
const CONTENT_WIDTH = PAGE_WIDTH - (PAGE_MARGIN * 2);
const CONTENT_HEIGHT = PAGE_HEIGHT - (PAGE_MARGIN * 2);

// Cache of converted documents keyed by documentId.
const documents = new Map();

let mammothLoad;

// Loads a classic script once and resolves when it has executed.
function loadScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = src;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error(`Could not load ${src}`));
        document.head.appendChild(script);
    });
}

async function ensureMammoth() {
    if (window.mammoth) {
        return window.mammoth;
    }

    mammothLoad ??= loadScript(MAMMOTH_SCRIPT);
    await mammothLoad;

    if (!window.mammoth) {
        throw new Error('The DOCX converter failed to load.');
    }

    return window.mammoth;
}

// Removes anything active that a document could smuggle into the converted HTML.
function sanitize(root) {
    const blocked = ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'base'];
    for (const tag of blocked) {
        for (const node of Array.from(root.querySelectorAll(tag))) {
            node.remove();
        }
    }

    for (const node of Array.from(root.querySelectorAll('*'))) {
        for (const attr of Array.from(node.attributes)) {
            const name = attr.name.toLowerCase();
            const value = attr.value || '';
            if (name.startsWith('on')) {
                node.removeAttribute(attr.name);
            } else if ((name === 'href' || name === 'src') && /^\s*javascript:/i.test(value)) {
                node.removeAttribute(attr.name);
            }
        }
    }
}

// Splits a top level block into the smallest units a page break may fall between.
// Lists are split per item so a long list can span several pages.
function buildUnits(parent) {
    const units = [];

    for (const child of Array.from(parent.children)) {
        const tag = child.tagName ? child.tagName.toLowerCase() : '';
        if ((tag === 'ul' || tag === 'ol') && child.children.length > 1) {
            let start = tag === 'ol' ? Number.parseInt(child.getAttribute('start') || '1', 10) : 0;
            for (const item of Array.from(child.children)) {
                const list = document.createElement(tag);
                if (tag === 'ol' && Number.isFinite(start)) {
                    list.setAttribute('start', String(start));
                }
                list.appendChild(item.cloneNode(true));
                units.push({ node: list, margin: 0 });
                start++;
            }
        } else {
            units.push({ node: child.cloneNode(true), margin: 0 });
        }
    }

    return units;
}

// Total vertical extent of a unit including its own margins.
function measureUnit(measure, node) {
    measure.replaceChildren(node);
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    const marginTop = Number.parseFloat(style.marginTop) || 0;
    const marginBottom = Number.parseFloat(style.marginBottom) || 0;
    return rect.height + marginTop + marginBottom;
}

// Wraps every text node of a block in a numbered span and appends the block to the
// page text model. The span numbers match the ones the viewer uses when highlighting.
function processBlock(block, state) {
    if (state.text.length > 0) {
        state.text += '\n';
    }

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
        nodes.push(walker.currentNode);
    }

    for (const node of nodes) {
        const value = node.nodeValue;
        if (value === null || value.length === 0) {
            continue;
        }

        if (state.text.length > 0 && !state.text.endsWith('\n')) {
            const last = state.text[state.text.length - 1];
            if (!/\s/.test(last) && !/^\s/.test(value)) {
                state.text += ' ';
            }
        }

        const start = state.text.length;
        state.text += value;

        const span = document.createElement('span');
        span.setAttribute('data-num', String(state.num));
        span.textContent = value;
        node.parentNode.replaceChild(span, node);

        state.spans.push({ num: state.num, text: value, start: start });
        state.num++;
    }
}

function buildPages(unitPages) {
    const pages = [];

    for (const units of unitPages) {
        const state = { text: '', spans: [], num: 0 };
        const html = [];

        for (const unit of units) {
            processBlock(unit, state);
            html.push(unit.outerHTML);
        }

        // Drop trailing whitespace without shifting any span offset.
        state.text = state.text.replace(/\s+$/, '');

        pages.push({ html: html.join(''), text: state.text, spans: state.spans });
    }

    return pages;
}

async function openDocument(id, data) {
    if (documents.has(id)) {
        return documents.get(id).pages.length;
    }

    const mammoth = await ensureMammoth();

    let result;
    try {
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer });
    } catch (error) {
        throw new Error(error && error.message ? error.message : String(error));
    }

    const source = document.createElement('div');
    source.innerHTML = result.value || '';
    sanitize(source);

    const units = buildUnits(source);
    if (units.length === 0) {
        units.push({ node: document.createElement('p') });
    }

    // Measure every unit off screen with the same width and typography as a page.
    const measure = document.createElement('div');
    measure.className = 'document-content docx-measure';
    measure.style.width = `${CONTENT_WIDTH}px`;
    document.body.appendChild(measure);

    const unitPages = [];
    let current = [];
    let used = 0;

    try {
        for (const unit of units) {
            const height = measureUnit(measure, unit.node);
            if (current.length > 0 && used + height > CONTENT_HEIGHT) {
                unitPages.push(current);
                current = [];
                used = 0;
            }

            current.push(unit.node);
            used += height;
        }
    } finally {
        measure.remove();
    }

    if (current.length > 0) {
        unitPages.push(current);
    }

    const pages = buildPages(unitPages);
    const doc = { pages: pages };
    documents.set(id, doc);
    return pages.length;
}

function releaseDocument(id) {
    documents.delete(id);
}

async function getPageSize() {
    return { width: PAGE_WIDTH, height: PAGE_HEIGHT };
}

async function getAllPageSizes(documentId) {
    const doc = documents.get(documentId);
    if (!doc) {
        throw new Error(`Unknown document: ${documentId}`);
    }

    return doc.pages.map(() => ({ width: PAGE_WIDTH, height: PAGE_HEIGHT }));
}

function getDocumentPage(documentId, pageNumber) {
    const doc = documents.get(documentId);
    if (!doc) {
        throw new Error(`Unknown document: ${documentId}`);
    }

    const page = doc.pages[pageNumber - 1];
    if (!page) {
        throw new Error(`Unknown page ${pageNumber} of document ${documentId}`);
    }

    return page;
}

// Sizes the wrapper for the current zoom and rotation. The content itself is scaled with
// a CSS transform inside renderTextLayer.
function renderPage(documentId, pageNumber, canvas, wrapper, scale, rotation) {
    getDocumentPage(documentId, pageNumber);

    const rotated = Math.abs(rotation) % 180 === 90;
    const width = (rotated ? PAGE_HEIGHT : PAGE_WIDTH) * scale;
    const height = (rotated ? PAGE_WIDTH : PAGE_HEIGHT) * scale;

    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;

    return { width: width, height: height };
}

// Fills the page container with the converted mark-up and numbers its text spans.
function renderTextLayer(documentId, pageNumber, container, scale, rotation, hostToken) {
    const page = getDocumentPage(documentId, pageNumber);

    container.innerHTML = page.html;
    container.classList.add('document-content');
    container.style.width = `${PAGE_WIDTH}px`;
    container.style.height = `${PAGE_HEIGHT}px`;
    container.style.padding = `${PAGE_MARGIN}px`;
    container.style.transform = `rotate(${rotation}deg) scale(${scale})`;
    container.dataset.pageNumber = String(pageNumber);
    if (hostToken) {
        container.dataset.docxHost = hostToken;
    } else {
        delete container.dataset.docxHost;
    }

    return { width: PAGE_WIDTH, height: PAGE_HEIGHT };
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
        const layer = event.target && event.target.closest ? event.target.closest('[data-docx-host]') : null;
        if (!layer) {
            return;
        }

        const host = hosts.get(layer.dataset.docxHost);
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

// Highlights the spans of a page that intersect the spoken character range.
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
            span.classList.add('docx-speak-highlight');
            highlighted.push(Number.parseInt(span.dataset.num, 10));
        }
    }

    return highlighted;
}

function clearHighlight(container) {
    for (const span of container.querySelectorAll('span.docx-speak-highlight')) {
        span.classList.remove('docx-speak-highlight');
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

async function getPageText(documentId, pageNumber) {
    const page = getDocumentPage(documentId, pageNumber);
    return { text: page.text, spans: page.spans };
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

    for (const element of (root || document).querySelectorAll('.docx-page[data-page-number]')) {
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
    const target = (root || document).querySelector(`.docx-page[data-page-number="${pageNumber}"]`);
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

const api = {
    openDocument,
    releaseDocument,
    renderPage,
    renderTextLayer,
    getPageText,
    getPageSize,
    getAllPageSizes,
    attachHost,
    detachHost,
    highlightRange,
    clearHighlight,
    applySpanOffsets,
    observePages,
    unobservePages,
    scrollToPage,
    scrollToSpan,
};

window.docxInterop = api;

export default api;
export {
    openDocument,
    releaseDocument,
    renderPage,
    renderTextLayer,
    getPageText,
    getPageSize,
    getAllPageSizes,
    attachHost,
    detachHost,
    highlightRange,
    clearHighlight,
    applySpanOffsets,
    observePages,
    unobservePages,
    scrollToPage,
    scrollToSpan,
};
