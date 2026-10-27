import { createWorker } from 'tesseract.js';
import { pageSize } from '../state.js';
import { renderOriginal } from '../pdf/pdf.js';
import { getEnhancedCanvas } from '../pdf/render.js';

// Tesseract language codes. Trained data is downloaded on first use and cached by the browser.
export const OCR_LANGS = [
  ['eng', 'English'],
  ['hin', 'Hindi'],
  ['eng+hin', 'English + Hindi'],
  ['mar', 'Marathi'],
  ['guj', 'Gujarati'],
  ['ben', 'Bengali'],
  ['pan', 'Punjabi'],
  ['tam', 'Tamil'],
  ['tel', 'Telugu'],
  ['kan', 'Kannada'],
  ['mal', 'Malayalam'],
  ['urd', 'Urdu'],
  ['ara', 'Arabic'],
  ['fra', 'French'],
  ['deu', 'German'],
  ['spa', 'Spanish'],
  ['por', 'Portuguese'],
  ['ita', 'Italian'],
];

// Page segmentation for the full-page pass: tesseract.js's default (single block). The refine
// pass switches to single-line mode and must restore exactly this, or later runs read differently.
const PAGE_PSM = '6';

let worker = null;
let workerLang = null;
let workerPromise = null;
let progressCb = null;

async function getWorker(lang) {
  if (worker && workerLang === lang) return worker;
  if (workerPromise && workerLang === lang) return workerPromise;
  if (worker) {
    await worker.terminate();
    worker = null;
  }
  workerLang = lang;
  workerPromise = createWorker(lang, 1, { logger: (m) => progressCb?.(m) }).then((w) => (worker = w));
  try {
    return await workerPromise;
  } catch (err) {
    workerLang = null;
    throw err;
  } finally {
    workerPromise = null;
  }
}

function collectLines(data) {
  if (Array.isArray(data.lines) && data.lines.length) return data.lines;
  const out = [];
  for (const block of data.blocks ?? []) {
    for (const para of block.paragraphs ?? []) for (const line of para.lines ?? []) out.push(line);
  }
  return out;
}

/**
 * Prepares a scan for OCR: converts to grayscale and erases long horizontal/vertical
 * rules (table borders, underlines). Rules otherwise get read as "|", "[" or "~" and make
 * Tesseract merge neighbouring table cells into one line. Returns the cleaned canvas and
 * the detected rules (in points), which are later used to split lines into cells and to
 * keep edit covers inside their cell.
 */
function prepareForOcr(src, k) {
  const w = src.width, h = src.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(src, 0, 0);
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const gray = new Uint8ClampedArray(w * h);
  let sum = 0;
  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    gray[p] = d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114;
    sum += gray[p];
  }
  const thr = Math.max(60, Math.min(175, sum / gray.length - 45)); // "ink" threshold
  const erase = new Uint8Array(w * h);
  const rules = { h: [], v: [] };
  const gapTol = Math.max(2, Math.round(k * 0.8)); // tolerate small breaks (scan noise, skew)
  const minH = Math.round(40 * k); // ≥ 40pt horizontal run: not part of a glyph
  const minV = Math.round(30 * k); // ≥ 30pt vertical run

  const scan = (outer, inner, at, minLen, onRun) => {
    for (let a = 0; a < outer; a++) {
      let start = -1, last = -1;
      for (let b = 0; b <= inner; b++) {
        const isInk = b < inner && gray[at(a, b)] < thr;
        if (isInk) {
          if (start < 0) start = b;
          last = b;
        } else if (start >= 0 && (b === inner || b - last > gapTol)) {
          if (last - start >= minLen) onRun(a, start, last);
          start = -1;
        }
      }
    }
  };
  scan(h, w, (y, x) => y * w + x, minH, (y, x0, x1) => {
    rules.h.push({ y: y / k, x0: x0 / k, x1: x1 / k });
    for (let yy = Math.max(0, y - 1); yy <= Math.min(h - 1, y + 1); yy++) erase.fill(1, yy * w + x0, yy * w + x1 + 1);
  });
  scan(w, h, (x, y) => y * w + x, minV, (x, y0, y1) => {
    rules.v.push({ x: x / k, y0: y0 / k, y1: y1 / k });
    for (let xx = Math.max(0, x - 1); xx <= Math.min(w - 1, x + 1); xx++) for (let y = y0; y <= y1; y++) erase[y * w + xx] = 1;
  });

  for (let i = 0, p = 0; p < gray.length; i += 4, p++) {
    const v = erase[p] ? 255 : gray[p];
    gray[p] = v;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return { canvas: out, rules, ink: { gray, w, h, thr } };
}

/**
 * Finds a block's baseline from the scan itself: going down from the middle of the text,
 * the last row before ink coverage drops off (only descenders continue below it).
 * Tesseract's line baseline is sometimes pulled down to the descenders or to an underline,
 * which makes the matched font far too large.
 */
function inkBaseline(ink, b, k) {
  const x0 = Math.max(0, Math.floor(b.x * k)), x1 = Math.min(ink.w, Math.ceil((b.x + b.w) * k));
  const y0 = Math.max(0, Math.floor(b.y * k)), y1 = Math.min(ink.h, Math.ceil((b.y + b.h) * k));
  if (x1 - x0 < 4 || y1 - y0 < 6) return null;
  const rows = [];
  for (let y = y0; y < y1; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) if (ink.gray[y * ink.w + x] < ink.thr) n++;
    rows.push(n);
  }
  const strong = Math.max(...rows) * 0.3;
  if (!strong) return null;
  let r = rows.length >> 1;
  while (r < rows.length && rows[r] < strong) r++; // middle row may fall between strokes
  while (r < rows.length && rows[r] >= strong) r++;
  const baseline = (y0 + r) / k;
  return baseline > b.y + b.h * 0.4 ? baseline : null;
}

// Words that are just border/noise artefacts.
const JUNK = /^[|¦[\]{}()~_=\-—–.,:;'"`!]+$/;

function cleanWord(wd, k) {
  const text = (wd.text || '').trim().replace(/^[|¦]+|[|¦]+$/g, '');
  if (!text || (JUNK.test(text) && (wd.confidence < 80 || /[|¦~_[\]]/.test(text)))) return null;
  return {
    text,
    confidence: wd.confidence,
    x: wd.bbox.x0 / k,
    y: wd.bbox.y0 / k,
    w: (wd.bbox.x1 - wd.bbox.x0) / k,
    h: (wd.bbox.y1 - wd.bbox.y0) / k,
  };
}

/**
 * Splits one Tesseract line into blocks: at table borders and at gaps much wider than a
 * normal word space (form columns). Each block becomes one editable item.
 */
function splitLine(line, k, rules, ink) {
  const words = (line.words || []).map((wd) => cleanWord(wd, k)).filter(Boolean);
  if (!words.length) return [];
  const lb = line.baseline && Number.isFinite(line.baseline.y0) && Number.isFinite(line.baseline.y1) ? line.baseline : null;
  const y0 = Math.min(...words.map((wd) => wd.y));
  const y1 = Math.max(...words.map((wd) => wd.y + wd.h));
  const chars = words.reduce((n, wd) => n + wd.text.length, 0);
  const charW = words.reduce((s, wd) => s + wd.w, 0) / Math.max(1, chars);
  const gapLimit = Math.max(charW * 2.6, (y1 - y0) * 1.1);
  const ruleBetween = (a, b) =>
    rules.v.some((r) => r.x > a.x + a.w - 1 && r.x < b.x + 1 && r.y0 < y1 && r.y1 > y0);

  const groups = [[words[0]]];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1], b = words[i];
    if (b.x - (a.x + a.w) > gapLimit || ruleBetween(a, b)) groups.push([b]);
    else groups.at(-1).push(b);
  }

  return groups.map((ws) => {
    const x = Math.min(...ws.map((wd) => wd.x));
    const right = Math.max(...ws.map((wd) => wd.x + wd.w));
    const y = Math.min(...ws.map((wd) => wd.y));
    const bottom = Math.max(...ws.map((wd) => wd.y + wd.h));
    const h = bottom - y;
    let baseline = null;
    if (lb) {
      // Tesseract gives one baseline per line; evaluate it at this block's centre.
      const cx = ((x + right) / 2) * k;
      const t = lb.x1 !== lb.x0 ? (cx - lb.x0) / (lb.x1 - lb.x0) : 0;
      const bl = (lb.y0 + (lb.y1 - lb.y0) * t) / k;
      if (bl > y && bl <= bottom + 2) baseline = bl;
    }
    baseline = inkBaseline(ink, { x, y, w: right - x, h }, k) ?? baseline;
    const fontSize = Math.max(4, Math.min(baseline ? (baseline - y) / 0.72 : h * 0.85, h * 1.15));
    return {
      text: ws.map((wd) => wd.text).join(' '),
      confidence: ws.reduce((s, wd) => s + wd.confidence, 0) / ws.length,
      x,
      y,
      w: right - x,
      h,
      baseline,
      fontSize,
      words: ws,
    };
  });
}

/**
 * Second pass for uncertain blocks: re-read each one on its own as a single text line
 * (PSM 7). Full-page layout analysis is weak on short isolated cells (form values, IDs,
 * amounts). This is usually far more accurate for them.
 */
async function refineBlocks(worker, canvas, k, blocks, onProgress) {
  const low = blocks.filter((b) => b.confidence < 85);
  if (!low.length) return;
  await worker.setParameters({ tessedit_pageseg_mode: '7' });
  try {
    for (const [i, b] of low.entries()) {
      onProgress?.({ status: 'double-checking uncertain text', progress: i / low.length });
      const m = Math.max(2, b.h * 0.3) * k;
      const left = Math.max(0, Math.floor(b.x * k - m));
      const top = Math.max(0, Math.floor(b.y * k - m));
      const rectangle = {
        left,
        top,
        width: Math.min(canvas.width - left, Math.ceil(b.w * k + 2 * m)),
        height: Math.min(canvas.height - top, Math.ceil(b.h * k + 2 * m)),
      };
      const { data } = await worker.recognize(canvas, { rectangle });
      const words = (data.words ?? []).map((wd) => cleanWord(wd, k)).filter(Boolean);
      if (!words.length) continue;
      const confidence = words.reduce((s, wd) => s + wd.confidence, 0) / words.length;
      if (confidence <= b.confidence) continue;
      Object.assign(b, { text: words.map((wd) => wd.text).join(' '), confidence, words });
    }
  } finally {
    await worker.setParameters({ tessedit_pageseg_mode: PAGE_PSM });
  }
}

/**
 * Runs OCR on one page. Result coordinates are in PDF points (display orientation),
 * so they line up directly with the editing canvas.
 */
export async function recognizePage(page, lang, onProgress) {
  progressCb = onProgress;
  try {
    const { width, height } = pageSize(page);
    onProgress?.({ status: 'preparing page image', progress: 0 });
    const source = page.enhance
      ? await getEnhancedCanvas(page)
      : await renderOriginal(page, Math.min(3.2, 3300 / Math.max(width, height)));
    const k = source.width / width; // pixels per point
    const { canvas, rules, ink } = prepareForOcr(source, k);
    const w = await getWorker(lang);
    // Set every time: a previous run may have failed before restoring it after its refine pass.
    await w.setParameters({ tessedit_pageseg_mode: PAGE_PSM });
    const { data } = await w.recognize(canvas);

    const rows = collectLines(data).map((line) => splitLine(line, k, rules, ink).filter((b) => b.w > 1 && b.h > 1));
    progressCb = null; // the refine pass reports its own progress
    await refineBlocks(w, canvas, k, rows.flat(), onProgress);

    const textLines = [];
    const lines = [];
    for (const row of rows) {
      const blocks = row.filter((b) => b.confidence >= 15);
      if (!blocks.length) continue;
      lines.push(...blocks);
      textLines.push(blocks.map((b) => b.text).join('    '));
    }

    page.ocr = {
      lang,
      lines, // editable blocks (one per cell / phrase)
      rules,
      text: textLines.join('\n'),
      confidence: lines.length ? lines.reduce((s, l) => s + l.confidence, 0) / lines.length : 0,
    };
    return page.ocr;
  } finally {
    progressCb = null;
  }
}
