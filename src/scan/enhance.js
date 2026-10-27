// Pixel-level clean-up for scanned pages.

export const DEFAULT_ENHANCE = {
  mode: 'color', // 'color' | 'gray' | 'bw'
  autoLevels: false, // stretch histogram (auto contrast)
  brightness: 0, // -100..100
  contrast: 0, // -100..100
  whiten: 0, // 0..100: pushes near-white paper (shadows, yellowing) to pure white
  threshold: 160, // B&W cut-off
  angle: 0, // straighten, degrees
};

function percentileLevels(data, lowPct = 0.01, highPct = 0.99) {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < data.length; i += 16) {
    hist[(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0]++;
    n++;
  }
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) {
    acc += hist[v];
    if (acc >= n * lowPct) { lo = v; break; }
  }
  acc = 0;
  for (let v = 255; v >= 0; v--) {
    acc += hist[v];
    if (acc >= n * (1 - highPct)) { hi = v; break; }
  }
  return hi - lo < 20 ? [0, 255] : [lo, hi];
}

export function applyEnhance(src, opts) {
  const o = { ...DEFAULT_ENHANCE, ...opts };
  const w = src.width, h = src.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  if (o.angle) {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.rotate((o.angle * Math.PI) / 180);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, -w / 2, -h / 2);
    ctx.restore();
  } else {
    ctx.drawImage(src, 0, 0);
  }

  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const [lo, hi] = o.autoLevels ? percentileLevels(d) : [0, 255];
  const levelK = 255 / (hi - lo);
  const C = o.contrast * 2.55;
  const contrastK = (259 * (C + 255)) / (255 * (259 - C));
  const B = o.brightness * 2.55;
  const whitenCut = o.whiten > 0 ? 255 - o.whiten * 1.4 : 256;

  // Build a lookup table for the per-channel tone curve.
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    let x = o.autoLevels ? (v - lo) * levelK : v;
    x = contrastK * (x - 128) + 128 + B;
    lut[v] = x;
  }

  for (let i = 0; i < d.length; i += 4) {
    let r = lut[d[i]], g = lut[d[i + 1]], b = lut[d[i + 2]];
    const l = r * 0.299 + g * 0.587 + b * 0.114;
    if (o.mode === 'bw') {
      r = g = b = l >= o.threshold ? 255 : 0;
    } else if (o.mode === 'gray') {
      r = g = b = l;
    }
    if (l >= whitenCut) r = g = b = 255;
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
  ctx.putImageData(img, 0, 0);
  return out;
}
