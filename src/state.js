// Central app state + a tiny event bus shared by all modules.

export const state = {
  fileName: 'document',
  pdfBytes: null, // Uint8Array of the original file (source for export)
  pdfDoc: null, // pdf.js document proxy
  pdfPages: [], // pdf.js page proxies, indexed by source page index
  pages: [], // PageModel[] in display order
  zoom: 1,
  tool: 'select',
  currentPageId: null,
  selectionView: null,
  searchable: true,
  ocrLang: 'eng',
  defaults: {
    fontFamily: 'Arial',
    fontSize: 14,
    textColor: '#111111',
    bold: false,
    italic: false,
    align: 'left',
    stroke: '#e53935',
    fill: '',
    strokeWidth: 2,
    highlight: '#ffeb3b',
    drawColor: '#1d4ed8',
    drawWidth: 2,
    whiteout: '#ffffff',
    matchBackground: true,
  },
};

const listeners = new Map();

export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
  return () => listeners.get(evt).delete(fn);
}

export function emit(evt, payload) {
  listeners.get(evt)?.forEach((fn) => {
    try {
      fn(payload);
    } catch (err) {
      console.error(`Listener for "${evt}" failed`, err);
    }
  });
}

let seq = 0;
export const uid = (prefix = 'id') => `${prefix}${++seq}${Math.random().toString(36).slice(2, 6)}`;

export const getPage = (id) => state.pages.find((p) => p.id === id);
export const currentPage = () => getPage(state.currentPageId) ?? state.pages[0] ?? null;

export function setCurrentPage(id) {
  if (!id || state.currentPageId === id) return;
  state.currentPageId = id;
  emit('page:current', getPage(id));
}

/**
 * A page in the editor. `srcIndex` points into the original PDF (null = inserted blank page).
 * Sizes are in PDF points; `baseWidth/baseHeight` are the unrotated crop-box dimensions.
 */
export function createPageModel({ srcIndex, baseRotation = 0, baseWidth, baseHeight }) {
  return {
    id: uid('pg'),
    srcIndex,
    baseRotation,
    rotation: 0, // user-applied rotation on top of the PDF's own /Rotate
    baseWidth,
    baseHeight,
    textChars: null, // number of characters in the native text layer (null = not analyzed yet)
    hasImages: false,
    isScanned: false,
    textContent: null,
    ocr: null, // { lang, lines: [...], text, confidence }
    enhance: null, // scan enhancement settings, see scan/enhance.js
    enhancedCanvas: null,
    json: null, // serialized Fabric objects when the page is not mounted
    thumb: null,
    view: null,
  };
}

export const effRotation = (p) => ((((p.baseRotation + p.rotation) % 360) + 360) % 360);

export function pageSize(p) {
  return effRotation(p) % 180 === 0
    ? { width: p.baseWidth, height: p.baseHeight }
    : { width: p.baseHeight, height: p.baseWidth };
}
