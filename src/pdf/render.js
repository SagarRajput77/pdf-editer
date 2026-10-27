import { pageSize } from '../state.js';
import { renderOriginal } from './pdf.js';
import { applyEnhance } from '../scan/enhance.js';

// Resolution used for enhanced scans (and therefore for their export): ~180 dpi on A4.
function enhanceScale(page) {
  const { width, height } = pageSize(page);
  return Math.min(2.5, 3200 / Math.max(width, height));
}

export async function getEnhancedCanvas(page) {
  if (page.enhancedCanvas) return page.enhancedCanvas;
  if (!page._enhBase) page._enhBase = renderOriginal(page, enhanceScale(page));
  const base = await page._enhBase;
  if (!page.enhance) return base;
  if (!page.enhancedCanvas) page.enhancedCanvas = applyEnhance(base, page.enhance);
  return page.enhancedCanvas;
}

export function invalidateEnhance(page, includeBase = false) {
  page.enhancedCanvas = null;
  page._match = null; // high-res render used for font/colour matching
  if (includeBase) page._enhBase = null;
  page.thumb = null;
}

/** Renders what the user sees as the page background (enhanced scan or original PDF). */
export async function renderPageImage(page, scale) {
  if (!page.enhance) return renderOriginal(page, scale);
  const src = await getEnhancedCanvas(page);
  const { width, height } = pageSize(page);
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.floor(width * scale));
  out.height = Math.max(1, Math.floor(height * scale));
  const ctx = out.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, out.width, out.height);
  return out;
}
