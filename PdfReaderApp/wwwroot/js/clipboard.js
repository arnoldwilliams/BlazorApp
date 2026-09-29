// Returns the text currently selected inside the rendered PDF text layer.
export function getPdfSelection() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return '';
    }

    const anchor = selection.anchorNode;
    const container = anchor ? (anchor.nodeType === 1 ? anchor : anchor.parentElement) : null;
    if (!container || !container.closest('.textLayer')) {
        return '';
    }

    return selection.toString().replace(/\s+/g, ' ').trim();
}

export default { getPdfSelection };
