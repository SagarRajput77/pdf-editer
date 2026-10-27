import { PDFDocument } from 'pdf-lib';
import { canvasToBytes } from '../utils.js';

// createImageBitmap applies EXIF orientation, so phone photos come out upright.
async function decodeToCanvas(file, maxSide = Infinity, background = null) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bmp.width * k));
  canvas.height = Math.max(1, Math.round(bmp.height * k));
  const ctx = canvas.getContext('2d');
  if (background) {
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  bmp.close?.();
  return canvas;
}

/** Builds a PDF where each image becomes one (scanned) page. */
export async function imagesToPdf(files) {
  const doc = await PDFDocument.create();
  for (const file of files) {
    const canvas = await decodeToCanvas(file, 5000, '#ffffff');
    const isPng = file.type === 'image/png';
    const bytes = await canvasToBytes(canvas, isPng ? 'image/png' : 'image/jpeg', 0.92);
    const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
    // Treat images as ~150 dpi scans and keep the long side at most A4 height.
    let w = (canvas.width * 72) / 150;
    let h = (canvas.height * 72) / 150;
    const k = Math.min(1, 842 / Math.max(w, h));
    w *= k;
    h *= k;
    const page = doc.addPage([w, h]);
    page.drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return doc.save();
}

/** Loads an image file as a (downscaled) data URL for placing on a page. */
export async function fileToDataUrl(file, maxSide = 2000) {
  const keepAlpha = /png|gif|webp|svg/.test(file.type);
  const canvas = await decodeToCanvas(file, maxSide);
  return canvas.toDataURL(keepAlpha ? 'image/png' : 'image/jpeg', 0.9);
}
