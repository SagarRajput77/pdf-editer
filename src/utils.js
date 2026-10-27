export const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/** Parses '#rgb', '#rrggbb(aa)', 'rgb()/rgba()' into {r,g,b,a}; returns null for empty/transparent. */
export function parseColor(c) {
  if (!c || typeof c !== 'string') return null;
  const s = c.trim().toLowerCase();
  if (s === 'transparent' || s === 'none') return null;
  let r, g, b, a = 1;
  if (s[0] === '#') {
    let h = s.slice(1);
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('');
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255;
  } else {
    const m = s.match(/rgba?\(([^)]+)\)/);
    if (!m) return s === 'white' ? { r: 255, g: 255, b: 255, a: 1 } : s === 'black' ? { r: 0, g: 0, b: 0, a: 1 } : null;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean).map(parseFloat);
    [r, g, b] = parts;
    if (parts.length > 3) a = parts[3];
  }
  if ([r, g, b].some((v) => !Number.isFinite(v)) || a <= 0) return null;
  return { r, g, b, a };
}

export function toHex(c, fallback = '#000000') {
  const p = parseColor(c);
  if (!p) return fallback;
  return '#' + [p.r, p.g, p.b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

export function rgbToHex([r, g, b]) {
  return '#' + [r, g, b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
}

export function canvasToBlob(canvas, type = 'image/png', quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Canvas export failed'))), type, quality),
  );
}

export async function canvasToBytes(canvas, type, quality) {
  return new Uint8Array(await (await canvasToBlob(canvas, type, quality)).arrayBuffer());
}

export function dataUrlToBytes(dataUrl) {
  const bin = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 15000);
}
