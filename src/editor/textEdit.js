import { IText, Rect, FabricText } from 'fabric';
import { state, uid, effRotation, pageSize } from '../state.js';
import { renderPageImage } from '../pdf/render.js';
import { ensureTextContent, getViewport, pdfjsLib } from '../pdf/pdf.js';
import { record } from './history.js';
import { renderHints } from './hints.js';
import { rgbToHex } from '../utils.js';

// Distance from a Fabric text object's top to the first baseline, as a multiple of fontSize
// (Fabric: line box = fontSize * 1.13, baseline at (1 - 0.222) of it).
export const BASELINE_RATIO = 1.13 * (1 - 0.222);

/** Returns editable text blocks (lines) for a page, from OCR results or the native PDF text layer. */
export async function getTextBlocks(page) {
  if (page.ocr) return ocrBlocks(page);
  if (page.srcIndex == null || page.enhance) return [];
  await ensureTextContent(page);
  if (!page.textContent) return [];
  const rot = effRotation(page);
  if (!page._blocks || page._blocksRot !== rot) {
    page._blocks = pdfBlocks(page);
    page._blocksRot = rot;
  }
  return page._blocks;
}

function ocrBlocks(page) {
  return page.ocr.lines.map((l, i) => ({
    key: `ocr:${i}`,
    source: 'ocr',
    text: l.text,
    x: l.x,
    y: l.y,
    w: l.w,
    h: l.h,
    baseline: l.baseline,
    fontSize: l.fontSize,
    fontFamily: 'Arial',
    bold: false,
    italic: false,
  }));
}

function fontInfo(page, fontName, style) {
  let name = '';
  try {
    const objs = state.pdfPages[page.srcIndex].commonObjs;
    if (objs.has(fontName)) name = objs.get(fontName)?.name || '';
  } catch {
    /* font not loaded yet */
  }
  const generic = style?.fontFamily || '';
  const all = `${name} ${generic}`;
  let fontFamily = 'Arial';
  if (/courier|mono/i.test(all)) fontFamily = 'Courier New';
  else if (/times|roman|georgia|garamond|cambria|book|minion/i.test(name) || (!name && /^serif$/i.test(generic)))
    fontFamily = 'Times New Roman';
  return {
    fontFamily,
    bold: /bold|black|heavy|semibold|demi/i.test(name),
    italic: /italic|oblique/i.test(name),
  };
}

/**
 * Superscripts/subscripts ("19th", "x²") are smaller runs raised or lowered off the baseline,
 * so they start lines of their own. Folds them into their line, so editing the line covers them.
 */
function foldScripts(lines) {
  for (const s of [...lines]) { // copy: lines shrink while iterating
    const host = lines.find(
      (l) =>
        l !== s &&
        l.fs >= s.fs * 1.1 &&
        s.left >= l.left - l.fs * 0.3 &&
        s.left <= l.right + l.fs * 0.3 &&
        s.baseline > l.baseline - l.fs * 0.8 &&
        s.baseline < l.baseline + l.fs * 0.4,
    );
    if (!host) continue;
    host.runs.push(...s.runs);
    host.right = Math.max(host.right, s.right);
    host.top = Math.min(host.top, s.top);
    host.bottom = Math.max(host.bottom, s.bottom);
    lines.splice(lines.indexOf(s), 1);
  }
}

/** Joins a line's runs left to right, adding a space where there is a visible gap. */
function lineText(line) {
  let text = '';
  let right = -Infinity;
  for (const r of line.runs.sort((a, b) => a.x - b.x)) {
    if (r.x - right > line.fs * 0.15 && text && !text.endsWith(' ') && !r.str.startsWith(' ')) text += ' ';
    text += r.str;
    right = Math.max(right, r.x + r.w);
  }
  return text;
}

function pdfBlocks(page) {
  const vp = getViewport(page, 1);
  const { items, styles } = page.textContent;
  const runs = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const m = pdfjsLib.Util.transform(vp.transform, it.transform);
    // Only horizontal (as displayed) text is editable in place.
    if (Math.abs(m[1]) > 0.02 * Math.abs(m[0]) + 0.01 || Math.abs(m[2]) > 0.02 * Math.abs(m[3]) + 0.01) continue;
    const fs = Math.abs(m[3]);
    if (fs < 1) continue;
    const style = styles[it.fontName];
    const asc = Math.min(1, Math.max(0.6, style?.ascent ?? 0.8));
    const desc = Math.max(-0.4, Math.min(0, style?.descent ?? -0.2));
    const w = (it.width || 0) * vp.scale;
    runs.push({ str: it.str, x: m[4], baseline: m[5], fs, w, asc, desc, fontName: it.fontName, style });
  }
  runs.sort((a, b) => a.baseline - b.baseline || a.x - b.x);

  const lines = [];
  for (const r of runs) {
    const line = lines.find(
      (l) =>
        Math.abs(l.baseline - r.baseline) < l.fs * 0.35 &&
        r.x >= l.right - l.fs * 0.6 &&
        r.x - l.right < l.fs * 1.4 &&
        Math.max(l.fs, r.fs) / Math.min(l.fs, r.fs) < 1.35,
    );
    if (line) {
      line.runs.push(r);
      line.right = Math.max(line.right, r.x + r.w);
      line.top = Math.min(line.top, r.baseline - r.fs * r.asc);
      line.bottom = Math.max(line.bottom, r.baseline - r.fs * r.desc);
    } else {
      lines.push({ runs: [r], left: r.x, right: r.x + r.w, top: r.baseline - r.fs * r.asc, bottom: r.baseline - r.fs * r.desc, baseline: r.baseline, fs: r.fs, fontName: r.fontName, style: r.style });
    }
  }

  foldScripts(lines);
  for (const l of lines) l.text = lineText(l);

  return lines
    .filter((l) => l.text.trim() && l.right > l.left)
    .map((l, i) => ({
      key: `pdf:${i}`,
      source: 'pdf',
      text: l.text.trim(),
      x: l.left,
      y: l.top,
      w: l.right - l.left,
      h: l.bottom - l.top,
      baseline: l.baseline,
      fontSize: l.fs,
      ...fontInfo(page, l.fontName, l.style),
    }));
}

const median = (arr) => {
  if (!arr.length) return 255;
  const s = Float32Array.from(arr).sort();
  return s[s.length >> 1];
};


const lum = (p) => p[0] * 0.299 + p[1] * 0.587 + p[2] * 0.114;

/** Colour of the bright "paper" cluster: per-channel median of the brightest slice of pixels. */
function paperColor(pixels, from) {
  if (!pixels.length) return null;
  const sorted = pixels.slice().sort((a, b) => lum(a) - lum(b));
  const slice = sorted.slice(Math.floor(sorted.length * from), Math.max(Math.floor(sorted.length * from) + 1, Math.ceil(sorted.length * 0.97)));
  return [0, 1, 2].map((c) => median(slice.map((p) => p[c])));
}

const colorDist = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);

/**
 * Samples the rendered page around a rectangle: `bg` is the paper colour, `fg` the dominant
 * ink colour inside. `source` is anything with `bg` (canvas) and `bgScale` (px per point).
 * The paper colour comes from the brightest common pixels, so table borders, underlines and
 * the text itself can't pull it towards grey.
 */
export function sampleColors(source, r) {
  const fallback = { bg: '#ffffff', fg: '#111111', bgRGB: [255, 255, 255], fgRGB: [17, 17, 17] };
  const s = source.bgScale;
  const cv = source.bg;
  if (!s || !cv?.width) return fallback;
  const m = Math.max(2, Math.round(2.5 * s));
  const ix0 = Math.floor(r.x * s), iy0 = Math.floor(r.y * s);
  const ix1 = Math.ceil((r.x + r.w) * s), iy1 = Math.ceil((r.y + r.h) * s);
  const x0 = Math.max(0, ix0 - m), y0 = Math.max(0, iy0 - m);
  const x1 = Math.min(cv.width, ix1 + m), y1 = Math.min(cv.height, iy1 + m);
  const w = x1 - x0, h = y1 - y0;
  if (w <= 0 || h <= 0) return fallback;
  const data = cv.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
  const step = Math.max(1, Math.floor(Math.sqrt((w * h) / 60000)));
  const ring = [];
  const inner = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      const i = (y * w + x) * 4;
      const gx = x + x0, gy = y + y0;
      const px = [data[i], data[i + 1], data[i + 2]];
      if (gx < ix0 || gx >= ix1 || gy < iy0 || gy >= iy1) ring.push(px);
      else inner.push(px);
    }
  }
  const ringPaper = paperColor(ring, 0.7);
  const innerPaper = paperColor(inner, 0.55);
  // Prefer the paper inside the area (exact cell/background colour) unless the area is mostly
  // covered by something else (e.g. whiting out a dark logo), then use the surroundings.
  let bg = innerPaper && (!ringPaper || colorDist(innerPaper, ringPaper) < 45) ? innerPaper : ringPaper;
  bg ??= [255, 255, 255];
  const ink = inner.map((p) => [colorDist(p, bg), p]).filter(([d]) => d > 90).sort((a, b) => b[0] - a[0]);
  let fg = [17, 17, 17];
  if (ink.length) {
    // Use only the strongest ink pixels; anti-aliased edges would wash the colour out.
    const top = ink.slice(0, Math.max(1, Math.ceil(ink.length * 0.15)));
    fg = [0, 1, 2].map((c) => top.reduce((sum, [, p]) => sum + p[c], 0) / top.length);
  }
  return { bg: rgbToHex(bg), fg: rgbToHex(fg), bgRGB: bg, fgRGB: fg };
}

const areaOf = (o) => ({ x: o.left, y: o.top, w: o.width * o.scaleX, h: o.height * o.scaleY });

/**
 * Re-matches colours of auto-coloured covers/edited text against a new page background
 * (e.g. after scan enhancement). `source` is anything with `bg` (canvas) and `bgScale`.
 * Returns true if something changed.
 */
export function resampleAutoColors(objects, source) {
  let changed = false;
  for (const o of objects) {
    if (!o.autoColor) continue;
    let fill;
    if (o.role === 'whiteout') fill = sampleColors(source, areaOf(o)).bg;
    else if (o instanceof FabricText) {
      const cover = o.linkId && objects.find((x) => x !== o && x.linkId === o.linkId);
      if (cover) fill = sampleColors(source, areaOf(cover)).fg;
    }
    if (fill && fill !== o.fill) {
      o.set('fill', fill);
      changed = true;
    }
  }
  return changed;
}

// ---------- matching the font of scanned text ----------

/** High-resolution render of the page used for colour/font matching (cached per page). */
export function getMatchCanvas(page) {
  if (!page._match) {
    const { width, height } = pageSize(page);
    page._match = renderPageImage(page, Math.min(3, 3300 / Math.max(width, height))).catch((err) => {
      page._match = null;
      throw err;
    });
  }
  return page._match;
}

// Candidate typefaces for scanned text. The first three map to PDF standard fonts and export as
// vector text; the others are used when installed and export as high-resolution images.
const CANDIDATE_FAMILIES = [
  'Arial', 'Times New Roman', 'Courier New',
  'Verdana', 'Tahoma', 'Calibri', 'Segoe UI', 'Trebuchet MS', 'Century Gothic',
  'Georgia', 'Cambria', 'Garamond', 'Book Antiqua', 'Consolas', 'Lucida Console',
];
const WEIGHTS = ['normal', 'bold'];

let installedFamilies = null;
/** Detects installed fonts by checking that they render differently from every fallback. */
function availableFamilies() {
  if (installedFamilies) return installedFamilies;
  const ctx = document.createElement('canvas').getContext('2d');
  const probe = 'mmmmmmmmmmlli1WQ@#';
  const width = (font) => {
    ctx.font = `40px ${font}`;
    return ctx.measureText(probe).width;
  };
  const fallbacks = ['monospace', 'serif', 'sans-serif'].map((g) => [g, width(g)]);
  installedFamilies = CANDIDATE_FAMILIES.filter(
    (f, i) => i < 3 || fallbacks.some(([g, w]) => Math.abs(width(`"${f}", ${g}`) - w) > 0.5),
  );
  return installedFamilies;
}

let scratch = null;
function scratchCtx(w, h) {
  scratch ??= document.createElement('canvas');
  if (scratch.width < w) scratch.width = w;
  if (scratch.height < h) scratch.height = h;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, scratch.width, scratch.height);
  return ctx;
}

/** Normalized cross-correlation of two soft ink images, best over ±1px shifts. */
function nccScore(a, b, w, h) {
  let best = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, n = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const va = a[y * w + x], vb = b[(y + dy) * w + x + dx];
          sa += va; sb += vb; sab += va * vb; saa += va * va; sbb += vb * vb; n++;
        }
      }
      const den = Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n));
      if (den > 0) best = Math.max(best, (sab - (sa * sb) / n) / den);
    }
  }
  return best;
}

/**
 * Correlation of the left-to-right ink profiles (ink per column). Character widths and gaps
 * show up here, which separates monospace from proportional faces much better than overlap.
 */
function profileScore(a, b, w, h) {
  const pa = new Float64Array(w), pb = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      pa[x] += a[y * w + x];
      pb[x] += b[y * w + x];
    }
  }
  const smooth = (p) => p.map((v, i) => (v + (p[i - 1] ?? v) + (p[i + 1] ?? v)) / 3);
  const sa = smooth(pa), sb = smooth(pb);
  const mean = (p) => p.reduce((s, v) => s + v, 0) / p.length;
  const ma = mean(sa), mb = mean(sb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < w; i++) {
    num += (sa[i] - ma) * (sb[i] - mb);
    da += (sa[i] - ma) ** 2;
    db += (sb[i] - mb) ** 2;
  }
  return da && db ? Math.max(0, num / Math.sqrt(da * db)) : 0;
}

/**
 * Finds the font that best reproduces a scanned text block: for every candidate family and
 * weight, the recognized text is rendered at the same height, baseline and width as the scan,
 * and compared with the scanned glyphs pixel by pixel. Returns size, family, weight and the
 * horizontal scale that makes the standard font as wide as the original typeface.
 */
function matchOcrFont(source, block, colors) {
  const s = source.bgScale;
  const p = 2;
  const x0 = Math.max(0, Math.floor(block.x * s) - p);
  const y0 = Math.max(0, Math.floor(block.y * s) - p);
  const w = Math.min(source.bg.width - x0, Math.ceil(block.w * s) + 2 * p);
  const h = Math.min(source.bg.height - y0, Math.ceil(block.h * s) + 2 * p);
  const baseline = block.baseline ?? block.y + block.h * 0.8;
  const fallback = { fontFamily: 'Arial', fontWeight: 'normal', fontSize: Math.max(4, block.fontSize), scaleX: 1, inkLeft: 0 };
  if (w < 4 || h < 4 || !block.text) return fallback;

  // Soft ink image of the scan: 0 = paper, 1 = full ink.
  const src = source.bg.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, h).data;
  const bgL = lum(colors.bgRGB), fgL = lum(colors.fgRGB);
  const range = bgL - fgL || 1;
  const scan = new Float32Array(w * h);
  for (let i = 0; i < scan.length; i++) {
    const l = src[i * 4] * 0.299 + src[i * 4 + 1] * 0.587 + src[i * 4 + 2] * 0.114;
    scan[i] = Math.min(1, Math.max(0, (bgL - l) / range));
  }

  const chars = [...block.text];
  let best = null;
  for (const family of availableFamilies()) {
    for (const weight of WEIGHTS) {
      const ctx = scratchCtx(w, h);
      ctx.font = `${weight} 100px "${family}"`;
      const m = ctx.measureText(block.text);
      const asc = m.actualBoundingBoxAscent / 100;
      const desc = m.actualBoundingBoxDescent / 100;
      const inkW = (m.actualBoundingBoxLeft + m.actualBoundingBoxRight) / 100;
      if (asc <= 0 || inkW <= 0) continue;
      let fontSize = block.baseline ? (baseline - block.y) / asc : block.h / (asc + desc);
      fontSize = Math.max(4, Math.min(fontSize, block.h * 2));
      const natural = inkW * fontSize;
      const advances = chars.map((ch) => (ctx.measureText(ch).width / 100) * fontSize);

      // Two ways to reach the original's width: stretch the glyphs, or open up the letter
      // spacing (wide faces like Verdana are much closer to Arial + tracking than to stretched Arial).
      const variants = [{ scaleX: Math.min(1.45, Math.max(0.7, block.w / natural)), spacing: 0 }];
      if (chars.length > 1) {
        const spacing = Math.min(0.3 * fontSize, Math.max(-0.08 * fontSize, (block.w - natural) / (chars.length - 1)));
        const rest = Math.min(1.1, Math.max(0.9, block.w / (natural + spacing * (chars.length - 1))));
        variants.push({ scaleX: rest, spacing });
      }

      for (const v of variants) {
        const bearing = (m.actualBoundingBoxLeft / 100) * fontSize * v.scaleX; // pt
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, w, h);
        ctx.setTransform(v.scaleX, 0, 0, 1, (block.x + bearing) * s - x0, 0);
        ctx.font = `${weight} ${fontSize * s}px "${family}"`;
        ctx.fillStyle = '#000';
        if (v.spacing) {
          let x = 0;
          chars.forEach((ch, i) => {
            ctx.fillText(ch, x, baseline * s - y0);
            x += (advances[i] + v.spacing) * s;
          });
        } else ctx.fillText(block.text, 0, baseline * s - y0);
        const rendered = ctx.getImageData(0, 0, w, h).data;
        const cand = new Float32Array(w * h);
        for (let i = 0; i < cand.length; i++) cand[i] = rendered[i * 4 + 3] / 255;
        const shape = 0.6 * nccScore(scan, cand, w, h) + 0.4 * profileScore(scan, cand, w, h);
        // Prefer natural widths: heavy stretching or tracking usually means the wrong family.
        const score = shape * (1 - 0.15 * Math.abs(Math.log(v.scaleX)) - 0.3 * Math.abs(v.spacing / fontSize));
        if (!best || score > best.score) {
          best = {
            score,
            fontFamily: family,
            fontWeight: weight,
            fontSize,
            scaleX: v.scaleX,
            charSpacing: Math.round((v.spacing / fontSize) * 1000), // Fabric unit: 1/1000 em
            inkLeft: bearing,
          };
        }
      }
    }
  }
  return best ?? fallback;
}

/** Detects whether a block is left/centre/right aligned inside its table cell. */
function cellAlignment(block, rules) {
  if (!rules?.v?.length) return 'left';
  const top = block.y, bot = block.y + block.h;
  let cellL = -Infinity, cellR = Infinity;
  for (const r of rules.v) {
    if (r.y0 > bot || r.y1 < top) continue;
    if (r.x <= block.x && r.x > cellL) cellL = r.x;
    if (r.x >= block.x + block.w && r.x < cellR) cellR = r.x;
  }
  if (!Number.isFinite(cellL) || !Number.isFinite(cellR)) return 'left';
  const cellW = cellR - cellL;
  const leftGap = block.x - cellL, rightGap = cellR - (block.x + block.w);
  if (cellW < block.w * 1.25) return 'left';
  if (Math.abs(leftGap - rightGap) < Math.max(3, cellW * 0.12)) return 'center';
  if (rightGap < leftGap * 0.4) return 'right';
  return 'left';
}

/** Shrinks a cover so it stops just inside the nearest table borders around the text. */
function clampToRules(area, block, rules) {
  if (!rules) return area;
  let { x, y } = area;
  let right = area.x + area.w, bottom = area.y + area.h;
  const top = block.y, bot = block.y + block.h, left = block.x, rgt = block.x + block.w;
  for (const r of rules.v) {
    if (r.y0 > bot || r.y1 < top) continue;
    if (r.x <= left && r.x >= x - 0.5) x = Math.max(x, r.x + 0.9);
    if (r.x >= rgt && r.x <= right + 0.5) right = Math.min(right, r.x - 0.9);
  }
  for (const r of rules.h) {
    if (r.x1 < left || r.x0 > rgt) continue;
    if (r.y <= top && r.y >= y - 0.5) y = Math.max(y, r.y + 0.9);
    if (r.y >= bot && r.y <= bottom + 0.5) bottom = Math.min(bottom, r.y - 0.9);
  }
  return { x, y, w: Math.max(1, right - x), h: Math.max(1, bottom - y) };
}

/**
 * Stops a cover just above an underline (solid or dotted rule) that runs through the lower
 * part of the text box, e.g. the line a name is written on. Rows below the baseline are
 * only lightly inked by descenders; a row inked across much of the width is a rule.
 */
function stopAboveRule(source, area, baseline, fontSize, bgRGB) {
  const s = source.bgScale;
  const cv = source.bg;
  if (!s || !cv?.width) return area;
  const x0 = Math.max(0, Math.floor(area.x * s)), x1 = Math.min(cv.width, Math.ceil((area.x + area.w) * s));
  const y0 = Math.max(0, Math.floor((baseline + fontSize * 0.06) * s)), y1 = Math.min(cv.height, Math.ceil((area.y + area.h) * s));
  const w = x1 - x0;
  if (w < 4 || y1 <= y0) return area;
  const data = cv.getContext('2d', { willReadFrequently: true }).getImageData(x0, y0, w, y1 - y0).data;
  for (let y = 0; y < y1 - y0; y++) {
    let ink = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (colorDist([data[i], data[i + 1], data[i + 2]], bgRGB) > 60) ink++;
    }
    if (ink > w * 0.35) {
      const bottom = (y0 + y) / s - 0.3;
      return bottom > baseline ? { ...area, h: bottom - area.y } : area;
    }
  }
  return area;
}

/**
 * Replaces an existing text line with an editable text box on top of a colour-matched cover.
 * The new text inherits the original's look: font family/weight/size/width and colour are
 * matched (from the PDF's font info, or by comparing glyphs for scans), and it stays anchored
 * the way the original was aligned in its table cell.
 */
export async function createEditFromBlock(view, block) {
  if (!view.canvas || view._creatingEdit) return;
  view._creatingEdit = true;
  try {
    const isOcr = block.source === 'ocr';
    let source = view;
    if (isOcr) {
      const canvas = await getMatchCanvas(view.page);
      source = { bg: canvas, bgScale: canvas.width / view.size.width };
    }
    const c = view.canvas;
    if (!c) return;

    const pad = isOcr ? Math.max(0.8, block.h * 0.1) : Math.max(1, block.h * 0.12);
    let area = { x: block.x - pad, y: block.y - pad, w: block.w + pad * 2, h: block.h + pad * 2 };
    if (isOcr) area = clampToRules(area, block, view.page.ocr?.rules);
    const colors = sampleColors(source, area);
    area = stopAboveRule(source, area, block.baseline ?? block.y + block.h * 0.8, block.fontSize, colors.bgRGB);
    const linkId = uid('lnk');

    const cover = new Rect({
      left: area.x,
      top: area.y,
      width: area.w,
      height: area.h,
      fill: colors.bg,
      strokeWidth: 0,
      role: 'whiteout',
      linkId,
      blockKey: block.key,
      autoColor: true,
    });

    const style = isOcr
      ? matchOcrFont(source, block, colors)
      : {
          fontFamily: block.fontFamily,
          fontWeight: block.bold ? 'bold' : 'normal',
          fontSize: block.fontSize,
          scaleX: 1,
          inkLeft: 0,
        };
    const align = isOcr ? cellAlignment(block, view.page.ocr?.rules) : 'left';
    const anchorX = { left: block.x + style.inkLeft, center: block.x + block.w / 2, right: block.x + block.w }[align];
    const fs = style.fontSize;
    const baseline = block.baseline ?? block.y + block.h * 0.8;

    const text = new IText(block.text, {
      originX: align, // text grows from the same anchor as the original (e.g. centred cells)
      left: anchorX,
      top: baseline - fs * BASELINE_RATIO,
      fontSize: fs,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      fontStyle: block.italic ? 'italic' : 'normal',
      scaleX: style.scaleX,
      charSpacing: style.charSpacing ?? 0,
      fill: colors.fg,
      lineHeight: 1,
      role: 'edit-text',
      linkId,
      blockKey: block.key,
      autoColor: true,
    });
    text.setCoords();

    c.add(cover, text);
    c.setActiveObject(text);
    // Caret at the end of the line; must be set before the hidden textarea is initialised.
    text.selectionStart = text.selectionEnd = text.text.length;
    text.enterEditing();
    c.requestRenderAll();
    record(view);
    renderHints(view);
  } catch (err) {
    console.error('Could not start editing this text', err);
  } finally {
    view._creatingEdit = false;
  }
}
