import * as pdfjsLib from 'pdfjs-dist';
import workerSrc from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { state, pageSize, effRotation } from '../state.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;
const CDN = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjsLib.version}/`;

export { pdfjsLib };

export async function openPdf(bytes) {
  const doc = await pdfjsLib.getDocument({
    data: bytes.slice(), // pdf.js transfers (detaches) the buffer, keep our copy intact
    cMapUrl: `${CDN}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${CDN}standard_fonts/`,
  }).promise;
  const proxies = [];
  for (let i = 1; i <= doc.numPages; i++) proxies.push(await doc.getPage(i));
  return { doc, proxies };
}

export function getViewport(page, scale = 1) {
  return state.pdfPages[page.srcIndex].getViewport({ scale, rotation: effRotation(page) });
}

/** Renders the original PDF page (ignoring scan enhancements) into a new canvas. */
export async function renderOriginal(page, scale) {
  const { width, height } = pageSize(page);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(width * scale));
  canvas.height = Math.max(1, Math.floor(height * scale));
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (page.srcIndex == null) return canvas;
  try {
    const proxy = state.pdfPages[page.srcIndex];
    const viewport = proxy.getViewport({ scale, rotation: effRotation(page) });
    await proxy.render({ canvasContext: ctx, viewport }).promise;
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error('Page render failed', err);
  }
  return canvas;
}

export function ensureTextContent(page) {
  if (page.srcIndex == null) return Promise.resolve(null);
  if (!page._tcPromise) {
    page._tcPromise = state.pdfPages[page.srcIndex]
      .getTextContent()
      .then((tc) => (page.textContent = tc))
      .catch((err) => {
        console.warn('Text extraction failed', err);
        return (page.textContent = { items: [], styles: {} });
      });
  }
  return page._tcPromise;
}

const IMAGE_OPS = new Set(
  [
    pdfjsLib.OPS.paintImageXObject,
    pdfjsLib.OPS.paintInlineImageXObject,
    pdfjsLib.OPS.paintImageXObjectRepeat,
    pdfjsLib.OPS.paintInlineImageXObjectGroup,
    pdfjsLib.OPS.paintJpegXObject,
  ].filter((v) => v !== undefined),
);

/** Detects whether a page is a scan: (almost) no native text but contains images. */
export async function analyzePage(page) {
  if (page.srcIndex == null) {
    page.textChars = 0;
    return page;
  }
  const tc = await ensureTextContent(page);
  const chars = tc.items.reduce((n, it) => n + (it.str ? it.str.trim().length : 0), 0);
  page.textChars = chars;
  if (chars < 25) {
    const ops = await state.pdfPages[page.srcIndex].getOperatorList();
    page.hasImages = ops.fnArray.some((fn) => IMAGE_OPS.has(fn));
  }
  page.isScanned = page.hasImages && chars < 25;
  return page;
}
