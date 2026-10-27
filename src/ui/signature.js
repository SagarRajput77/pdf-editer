import { icon } from '../icons.js';
import { esc } from '../utils.js';
import { toast } from './toast.js';

const STORAGE_KEY = 'pdf-editor.signature';
const COLORS = ['#111827', '#1d4ed8', '#b91c1c'];
const SCRIPT_FONTS = ['"Segoe Script", "Brush Script MT", cursive', '"Lucida Handwriting", "Apple Chancery", cursive', '"Ink Free", "Comic Sans MS", cursive'];

function loadSaved() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function save(dataUrl) {
  try {
    localStorage.setItem(STORAGE_KEY, dataUrl);
  } catch {
    /* storage unavailable */
  }
}

/** Crops transparent margins so the signature image is tight. */
function trim(canvas) {
  const ctx = canvas.getContext('2d');
  const { width, height } = canvas;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  const pad = 6;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width - 1, x1 + pad);
  y1 = Math.min(height - 1, y1 + pad);
  const out = document.createElement('canvas');
  out.width = x1 - x0 + 1;
  out.height = y1 - y0 + 1;
  out.getContext('2d').drawImage(canvas, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export function openSignatureModal(onDone) {
  const saved = loadSaved();
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-label="Add signature">
      <div class="modal-head"><h3>Add signature</h3><button class="icon-btn" data-act="close" title="Close">${icon('x')}</button></div>
      <div class="seg" style="max-width:240px"><button class="active" data-tab="draw">Draw</button><button data-tab="type">Type</button></div>
      <div data-pane="draw">
        <canvas class="sig-pad"></canvas>
        <div class="sig-tools">
          <div class="swatches">${COLORS.map((c, i) => `<button class="swatch${i === 0 ? ' active' : ''}" data-color="${c}" style="background:${c}" title="Ink colour"></button>`).join('')}</div>
          <button class="btn ghost sm" data-act="clear">Clear</button>
        </div>
      </div>
      <div data-pane="type" class="sig-type" hidden>
        <input class="input" data-role="name" placeholder="Type your name" maxlength="60" />
        <div class="sig-fonts">${SCRIPT_FONTS.map((f, i) => `<button class="sig-font${i === 0 ? ' active' : ''}" data-font='${esc(f)}' style='font-family:${f}'>Your signature</button>`).join('')}</div>
      </div>
      <div class="modal-foot">
        ${saved ? '<button class="btn ghost" data-act="saved">Use saved signature</button>' : ''}
        <span class="spacer"></span>
        <button class="btn ghost" data-act="close">Cancel</button>
        <button class="btn primary" data-act="use">Add to page</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);

  const $ = (s) => backdrop.querySelector(s);
  const pad = $('.sig-pad');
  const dpr = window.devicePixelRatio || 1;
  const rect = pad.getBoundingClientRect();
  pad.width = rect.width * dpr;
  pad.height = rect.height * dpr;
  const ctx = pad.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2.6;
  let color = COLORS[0];
  let font = SCRIPT_FONTS[0];
  let tab = 'draw';
  let inked = false;
  let last = null;

  const point = (e) => {
    const r = pad.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  pad.addEventListener('pointerdown', (e) => {
    pad.setPointerCapture(e.pointerId);
    last = point(e);
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
  });
  pad.addEventListener('pointermove', (e) => {
    if (!last) return;
    const p = point(e);
    const mid = { x: (last.x + p.x) / 2, y: (last.y + p.y) / 2 };
    ctx.quadraticCurveTo(last.x, last.y, mid.x, mid.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(mid.x, mid.y);
    last = p;
    inked = true;
  });
  const end = () => (last = null);
  pad.addEventListener('pointerup', end);
  pad.addEventListener('pointercancel', end);

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  document.addEventListener('keydown', onKey);

  const finish = (dataUrl) => {
    if (!dataUrl) return;
    save(dataUrl);
    close();
    onDone(dataUrl);
  };

  const typedSignature = () => {
    const name = $('[data-role="name"]').value.trim();
    if (!name) return null;
    const c = document.createElement('canvas');
    c.width = 1400;
    c.height = 320;
    const x = c.getContext('2d');
    x.font = `120px ${font}`;
    x.fillStyle = color;
    x.textBaseline = 'middle';
    x.fillText(name, 30, 160, 1340);
    return trim(c);
  };

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) return close();
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.tab) {
      tab = t.dataset.tab;
      backdrop.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b === t));
      backdrop.querySelectorAll('[data-pane]').forEach((p) => (p.hidden = p.dataset.pane !== tab));
      if (tab === 'type') $('[data-role="name"]').focus();
    } else if (t.dataset.color) {
      color = t.dataset.color;
      backdrop.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('active', b === t));
    } else if (t.dataset.font) {
      font = t.dataset.font;
      backdrop.querySelectorAll('.sig-font').forEach((b) => b.classList.toggle('active', b === t));
    } else if (t.dataset.act === 'clear') {
      ctx.clearRect(0, 0, pad.width, pad.height);
      inked = false;
    } else if (t.dataset.act === 'close') close();
    else if (t.dataset.act === 'saved') finish(saved);
    else if (t.dataset.act === 'use') {
      const typed = tab === 'type';
      const dataUrl = typed ? typedSignature() : inked && trim(pad);
      if (dataUrl) finish(dataUrl);
      else toast(typed ? 'Type your name first.' : 'Draw your signature in the box first.', 'error');
    }
  });

  $('[data-role="name"]').addEventListener('input', (e) => {
    const v = e.target.value || 'Your signature';
    backdrop.querySelectorAll('.sig-font').forEach((b) => (b.textContent = v));
  });
}
