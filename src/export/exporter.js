import {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  pushGraphicsState,
  popGraphicsState,
  concatTransformationMatrix,
  setTextRenderingMode,
  setCharacterSpacing,
  TextRenderingMode,
  BlendMode,
  LineCapStyle,
} from 'pdf-lib';
import { util, FabricText, Rect, Ellipse, Line, Path, FabricImage } from 'fabric';
import { state, pageSize, effRotation } from '../state.js';
import { renderOriginal } from '../pdf/pdf.js';
import { getEnhancedCanvas } from '../pdf/render.js';
import { resampleAutoColors } from '../editor/textEdit.js';
import { parseColor, canvasToBytes, dataUrlToBytes } from '../utils.js';

const RASTER_SCALE = 2.5; // used when the source PDF can't be modified (encrypted)

const STD_FONTS = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

class FontCache {
  constructor(doc) {
    this.doc = doc;
    this.fonts = new Map();
  }
  get(family = 'Arial', weight = 'normal', style = 'normal') {
    const fam = /courier|mono/i.test(family)
      ? 'courier'
      : /times|roman|georgia|serif/i.test(family) && !/sans/i.test(family)
        ? 'times'
        : 'helvetica';
    const bold = weight === 'bold' || Number(weight) >= 600;
    const italic = style === 'italic' || style === 'oblique';
    const key = `${fam}-${bold}-${italic}`;
    if (!this.fonts.has(key)) this.fonts.set(key, this.doc.embedFont(STD_FONTS[fam][(bold ? 1 : 0) + (italic ? 2 : 0)]));
    return this.fonts.get(key);
  }
}

const toPdfColor = (c) => {
  const p = parseColor(c);
  return p ? { color: rgb(p.r / 255, p.g / 255, p.b / 255), alpha: p.a } : null;
};

/**
 * Matrix mapping "display space" (what the user sees: origin bottom-left, y up, page rotation applied)
 * to the page's unrotated user space, given its /Rotate and crop box.
 */
function displayToUser(rot, box) {
  const { x, y, width: W, height: H } = box;
  switch (rot) {
    case 90: return [0, 1, -1, 0, W + x, y];
    case 180: return [-1, 0, 0, -1, W + x, H + y];
    case 270: return [0, -1, 1, 0, x, H + y];
    default: return [1, 0, 0, 1, x, y];
  }
}

async function embedCanvas(doc, canvas, format) {
  return format === 'png'
    ? doc.embedPng(await canvasToBytes(canvas, 'image/png'))
    : doc.embedJpg(await canvasToBytes(canvas, 'image/jpeg', 0.85));
}

function flushEditing() {
  for (const p of state.pages) {
    const c = p.view?.canvas;
    if (!c) continue;
    const active = c.getActiveObject();
    if (active?.isEditing) active.exitEditing();
    if (active) c.discardActiveObject();
    c.requestRenderAll();
  }
}

async function pageObjects(page) {
  if (page.view?.canvas) return page.view.canvas.getObjects();
  if (!page.json) return [];
  return util.enlivenObjects(JSON.parse(page.json).objects ?? []);
}

function hasStyleOverrides(styles) {
  return Object.values(styles || {}).some((line) => Object.values(line || {}).some((s) => s && Object.keys(s).length));
}

const encodeCache = new WeakMap();
function canEncode(font, text) {
  let cache = encodeCache.get(font);
  if (!cache) encodeCache.set(font, (cache = new Map()));
  for (const ch of text) {
    if (!cache.has(ch)) {
      try {
        font.encodeText(ch);
        cache.set(ch, true);
      } catch {
        cache.set(ch, false);
      }
    }
    if (!cache.get(ch)) return false;
  }
  return true;
}

// ---- Object drawing. Each draw* runs inside a graphics state whose CTM is the object's own
// Fabric transform, i.e. local coordinates centred on the object with y pointing down.

const FLIP_Y = concatTransformationMatrix(1, 0, 0, -1, 0, 0);

// Families that map exactly onto the PDF standard fonts and can be written as vector text.
const STANDARD_FAMILY = /^(arial|helvetica|times new roman|times|courier new|courier)$/i;

/** Lays out a Fabric text object's lines with a PDF font (visible, or invisible for search). */
function writeTextLines(ctx, t, font, lines, { color, opacity, invisible = false }) {
  const fs = t.fontSize;
  const lh = t.lineHeight || 1;
  const fraction = t._fontSizeFraction ?? 0.222;
  const w = t.width;
  // Fabric's charSpacing is in 1/1000 em; PDF's Tc is in text-space units (added after each glyph).
  const tc = ((t.charSpacing || 0) / 1000) * fs;
  ctx.page.pushOperators(pushGraphicsState(), FLIP_Y);
  if (tc) ctx.page.pushOperators(setCharacterSpacing(tc));
  if (invisible) ctx.page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
  let acc = 0;
  lines.forEach((line, i) => {
    const heightOfLine = t.getHeightOfLine(i);
    const baseline = -t.height / 2 + acc + (heightOfLine / lh) * (1 - fraction);
    acc += heightOfLine;
    if (!line.trim()) return;
    const lw = font.widthOfTextAtSize(line, fs) + tc * ([...line].length - 1);
    let x = -w / 2;
    if (t.textAlign === 'center') x += (w - lw) / 2;
    else if (t.textAlign === 'right') x += w - lw;
    ctx.page.drawText(line, { x, y: -baseline, size: fs, font, color, opacity });
  });
  ctx.page.pushOperators(popGraphicsState());
}

async function drawText(ctx, t) {
  const fill = toPdfColor(t.fill);
  if (!fill) return true;
  const font = await ctx.fonts.get(t.fontFamily, t.fontWeight, t.fontStyle);
  const lines = t.textLines ?? String(t.text).split('\n');
  const vector = STANDARD_FAMILY.test(t.fontFamily) && !hasStyleOverrides(t.styles) && lines.every((l) => canEncode(font, l));
  if (vector) {
    writeTextLines(ctx, t, font, lines, { color: fill.color, opacity: fill.alpha * (t.opacity ?? 1) });
    return true;
  }
  // Other typefaces (matched to a scan, e.g. Verdana) or scripts the standard fonts can't encode
  // (e.g. Devanagari): draw a high-resolution image, plus invisible text so it stays searchable.
  ctx.page.pushOperators(pushGraphicsState());
  await drawRaster(ctx, t);
  ctx.page.pushOperators(popGraphicsState());
  const searchable = lines.map((l) => [...l].filter((ch) => canEncode(font, ch)).join(''));
  writeTextLines(ctx, t, font, searchable, { invisible: true });
  return true;
}

function paintOptions(o) {
  const fill = toPdfColor(o.fill);
  const stroke = o.strokeWidth > 0 ? toPdfColor(o.stroke) : null;
  const op = o.opacity ?? 1;
  const opts = { color: fill?.color, opacity: fill ? fill.alpha * op : undefined };
  if (stroke) Object.assign(opts, { borderColor: stroke.color, borderWidth: o.strokeWidth, borderOpacity: stroke.alpha * op });
  return { opts, visible: !!(fill || stroke) };
}

function drawRect(ctx, o) {
  const { opts, visible } = paintOptions(o);
  if (!visible) return;
  if (o.role === 'highlight') opts.blendMode = BlendMode.Multiply;
  ctx.page.drawRectangle({ x: -o.width / 2, y: -o.height / 2, width: o.width, height: o.height, ...opts });
}

function drawEllipse(ctx, o) {
  const { opts, visible } = paintOptions(o);
  if (!visible) return;
  ctx.page.drawEllipse({ x: 0, y: 0, xScale: o.rx, yScale: o.ry, ...opts });
}

function drawLine(ctx, o) {
  const stroke = toPdfColor(o.stroke);
  if (!stroke || !o.strokeWidth) return;
  const p = o.calcLinePoints();
  ctx.page.drawLine({
    start: { x: p.x1, y: p.y1 },
    end: { x: p.x2, y: p.y2 },
    thickness: o.strokeWidth,
    color: stroke.color,
    opacity: stroke.alpha * (o.opacity ?? 1),
    lineCap: LineCapStyle.Round,
  });
}

function drawPath(ctx, o) {
  const { opts, visible } = paintOptions(o);
  if (!visible) return;
  const d = o.path.map((seg) => seg.join(' ')).join(' ');
  ctx.page.pushOperators(FLIP_Y); // drawSvgPath flips y itself
  ctx.page.drawSvgPath(d, { x: -o.pathOffset.x, y: o.pathOffset.y, ...opts, borderLineCap: LineCapStyle.Round });
}

async function drawImage(ctx, o) {
  const src = o.getSrc();
  let img = ctx.images.get(src);
  if (!img) {
    if (/^data:image\/jpe?g/i.test(src)) img = await ctx.doc.embedJpg(dataUrlToBytes(src));
    else if (/^data:image\/png/i.test(src)) img = await ctx.doc.embedPng(dataUrlToBytes(src));
    else {
      const el = o.getElement();
      const canvas = document.createElement('canvas');
      canvas.width = el.naturalWidth || el.width;
      canvas.height = el.naturalHeight || el.height;
      canvas.getContext('2d').drawImage(el, 0, 0);
      img = await embedCanvas(ctx.doc, canvas, 'png');
    }
    ctx.images.set(src, img);
  }
  ctx.page.pushOperators(FLIP_Y);
  ctx.page.drawImage(img, { x: -o.width / 2, y: -o.height / 2, width: o.width, height: o.height, opacity: o.opacity ?? 1 });
}

/** Fallback: render the object (untransformed) to a PNG and place it. */
async function drawRaster(ctx, o) {
  const keys = ['angle', 'scaleX', 'scaleY', 'flipX', 'flipY', 'skewX', 'skewY'];
  const saved = Object.fromEntries(keys.map((k) => [k, o[k]]));
  const k = 4;
  o.set({ angle: 0, scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0, skewY: 0 });
  const canvas = o.toCanvasElement({ multiplier: k, enableRetinaScaling: false });
  o.set(saved);
  o.setCoords();
  const img = await embedCanvas(ctx.doc, canvas, 'png');
  const w = canvas.width / k;
  const h = canvas.height / k;
  ctx.page.pushOperators(FLIP_Y);
  ctx.page.drawImage(img, { x: -w / 2, y: -h / 2, width: w, height: h });
}

async function drawObject(ctx, o) {
  if (o.visible === false) return;
  ctx.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...o.calcTransformMatrix()));
  try {
    let ok = true;
    if (o instanceof FabricText) ok = await drawText(ctx, o);
    else if (o instanceof Rect) drawRect(ctx, o);
    else if (o instanceof Ellipse) drawEllipse(ctx, o);
    else if (o instanceof Line) drawLine(ctx, o);
    else if (o instanceof Path) drawPath(ctx, o);
    else if (o instanceof FabricImage) await drawImage(ctx, o);
    else ok = false;
    if (!ok) await drawRaster(ctx, o);
  } finally {
    ctx.page.pushOperators(popGraphicsState());
  }
}

/** Invisible OCR text so scanned pages become searchable/selectable. */
async function drawOcrLayer(ctx, page, base, height, objects) {
  const font = await ctx.fonts.get('Arial');
  const edited = new Set(objects.map((o) => o.blockKey).filter(Boolean));
  ctx.page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...base),
    setTextRenderingMode(TextRenderingMode.Invisible),
  );
  page.ocr.lines.forEach((line, i) => {
    if (edited.has(`ocr:${i}`)) return;
    const baseline = line.baseline ?? line.y + line.h * 0.8;
    const words = line.words.length ? line.words : [{ text: line.text, x: line.x, w: line.w }];
    for (const word of words) {
      const text = [...word.text].filter((ch) => canEncode(font, ch)).join('');
      if (!text.trim()) continue;
      let size = line.fontSize;
      const tw = font.widthOfTextAtSize(text, size);
      if (tw > 0 && word.w > 0) size = Math.max(1, Math.min(size * 3, (size * word.w) / tw));
      ctx.page.drawText(text, { x: word.x, y: height - baseline, size, font });
    }
  });
  ctx.page.pushOperators(popGraphicsState());
}

/** Builds the edited PDF and returns its bytes. */
export async function exportPdf({ searchable = true } = {}) {
  flushEditing();

  let doc;
  let rasterAll = false;
  try {
    doc = await PDFDocument.load(state.pdfBytes, { updateMetadata: false });
  } catch (err) {
    if (!/encrypt/i.test(err?.message ?? '')) throw err;
    // Protected PDFs can be displayed but not rewritten: fall back to page images.
    rasterAll = true;
    doc = await PDFDocument.create();
  }

  // Reuse the original page objects (keeps links, annotations, forms); copy only when a page
  // is used more than once (duplicated pages).
  const originals = rasterAll ? [] : doc.getPages();
  const reused = state.pages.filter((p) => p.srcIndex != null && !p.enhance && !rasterAll).map((p) => p.srcIndex);
  const seen = new Set();
  const dupIdx = [];
  for (const i of reused) {
    if (seen.has(i)) dupIdx.push(i);
    else seen.add(i);
  }
  const dupPages = dupIdx.length ? await doc.copyPages(doc, dupIdx) : [];
  for (let i = doc.getPageCount() - 1; i >= 0; i--) doc.removePage(i);

  const ctx = { doc, fonts: new FontCache(doc), images: new Map(), page: null };
  const used = new Set();
  let dupCursor = 0;

  for (const page of state.pages) {
    const { width, height } = pageSize(page);
    let pdfPage;
    let base = [1, 0, 0, 1, 0, 0];

    if (page.enhance || (rasterAll && page.srcIndex != null)) {
      const canvas = page.enhance ? await getEnhancedCanvas(page) : await renderOriginal(page, RASTER_SCALE);
      const img = await embedCanvas(doc, canvas, page.enhance?.mode === 'bw' ? 'png' : 'jpg');
      pdfPage = doc.addPage([width, height]);
      pdfPage.drawImage(img, { x: 0, y: 0, width, height });
    } else if (page.srcIndex == null) {
      pdfPage = doc.addPage([width, height]);
    } else {
      let src;
      if (!used.has(page.srcIndex)) {
        src = originals[page.srcIndex];
        used.add(page.srcIndex);
      } else src = dupPages[dupCursor++];
      pdfPage = doc.addPage(src);
      const rot = effRotation(page);
      pdfPage.setRotation(degrees(rot));
      base = displayToUser(rot, pdfPage.getCropBox());
      // Isolate the original content so its graphics state can't leak into our overlay.
      pdfPage.node.normalize();
      pdfPage.node.wrapContentStreams(
        doc.context.register(doc.context.contentStream([pushGraphicsState()])),
        doc.context.register(doc.context.contentStream([popGraphicsState()])),
      );
    }
    ctx.page = pdfPage;

    const objects = await pageObjects(page);
    if (page._needsResample && !page.view?.canvas && objects.length) {
      // Enhancement changed while the page was off-screen: match colours against the new background.
      const bgCanvas = page.enhance ? await getEnhancedCanvas(page) : await renderOriginal(page, 2);
      resampleAutoColors(objects, { bg: bgCanvas, bgScale: bgCanvas.width / width });
    }
    const textless = page.isScanned || page.enhance || rasterAll || (page.textChars ?? 0) < 25;
    if (searchable && page.ocr && textless) await drawOcrLayer(ctx, page, base, height, objects);

    if (objects.length) {
      // Display space (y up) -> Fabric scene space (y down, origin top-left).
      pdfPage.pushOperators(
        pushGraphicsState(),
        concatTransformationMatrix(...base),
        concatTransformationMatrix(1, 0, 0, -1, 0, height),
      );
      for (const o of objects) await drawObject(ctx, o);
      pdfPage.pushOperators(popGraphicsState());
    }
  }

  return { bytes: await doc.save({ useObjectStreams: true }), rasterized: rasterAll };
}
