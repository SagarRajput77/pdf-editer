import { FabricText, Rect, Ellipse, Line, Path, FabricImage, ActiveSelection } from 'fabric';
import { state, on } from '../state.js';
import { record } from '../editor/history.js';
import { sampleColors } from '../editor/textEdit.js';
import { deleteSelection, duplicateSelection, arrangeSelection, refreshToolModes } from '../editor/tools.js';
import { icon } from '../icons.js';
import { el, toHex } from '../utils.js';

const FONTS = ['Arial', 'Times New Roman', 'Courier New'];
const TEXT_LAYOUT_KEYS = ['fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'textAlign'];

let host;
let selection = null;

export function initProperties(node) {
  host = node;
  on('selection', (s) => {
    selection = s;
    state.selectionView = s?.view ?? null;
    render();
  });
  on('tool', () => !selection && render());
  render();
}

// ---------- small control builders ----------

function section(title) {
  const s = el('div', 'prop-section');
  if (title) s.appendChild(el('h4', null, title));
  host.appendChild(s);
  return s;
}

function row(parent, label, control) {
  const r = el('label', 'prop-row');
  r.append(el('span', 'prop-label', label), control);
  parent.appendChild(r);
  return r;
}

function colorInput(value, onInput, onCommit) {
  const i = document.createElement('input');
  i.type = 'color';
  i.value = toHex(value);
  i.addEventListener('input', () => onInput(i.value));
  i.addEventListener('change', () => onCommit?.());
  return i;
}

function numberInput(value, { min = 1, max = 400, step = 1 }, onInput, onCommit) {
  const i = document.createElement('input');
  Object.assign(i, { type: 'number', min, max, step, value: Math.round(value * 10) / 10 });
  i.addEventListener('input', () => {
    const v = parseFloat(i.value);
    if (Number.isFinite(v) && v >= min && v <= max) onInput(v);
  });
  i.addEventListener('change', () => onCommit?.());
  return i;
}

function rangeInput(value, { min = 0, max = 1, step = 0.05, format = (v) => `${Math.round(v * 100)}%` }, onInput, onCommit) {
  const wrap = el('div', 'prop-row');
  wrap.style.margin = '0';
  const i = document.createElement('input');
  Object.assign(i, { type: 'range', min, max, step, value });
  const out = el('output', null, format(value));
  i.addEventListener('input', () => {
    out.textContent = format(parseFloat(i.value));
    onInput(parseFloat(i.value));
  });
  i.addEventListener('change', () => onCommit?.());
  wrap.append(i, out);
  return wrap;
}

function selectInput(options, value, onChange) {
  const s = document.createElement('select');
  for (const o of options) s.add(new Option(o, o, false, o === value));
  s.addEventListener('change', () => onChange(s.value));
  return s;
}

function segmented(items, onClick) {
  const seg = el('div', 'seg');
  for (const it of items) {
    const b = el('button');
    b.type = 'button';
    b.title = it.title;
    b.innerHTML = it.icon ? icon(it.icon, 16) : it.label;
    if (it.active) b.classList.add('active');
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick(it, b, seg);
    });
    seg.appendChild(b);
  }
  return seg;
}

function checkbox(label, checked, onChange) {
  const l = el('label', 'check');
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = checked;
  i.addEventListener('change', () => onChange(i.checked));
  l.append(i, document.createTextNode(label));
  return l;
}

function helpCard(parent, html) {
  const card = el('div', 'help-card small');
  card.innerHTML = html;
  parent.appendChild(card);
}

// ---------- shared control groups ----------

function textControls(parent, v, change, commit) {
  row(parent, 'Font', selectInput(FONTS.includes(v.family) ? FONTS : [v.family, ...FONTS], v.family, (x) => (change({ family: x }), commit())));
  row(parent, 'Size', numberInput(v.size, { min: 4, max: 300, step: 0.5 }, (x) => change({ size: x }), commit));
  row(parent, 'Color', colorInput(v.color, (x) => change({ color: x }), commit));
  row(
    parent,
    'Style',
    segmented(
      [
        { key: 'bold', icon: 'bold', title: 'Bold', active: v.bold },
        { key: 'italic', icon: 'italic', title: 'Italic', active: v.italic },
      ],
      (it, btn) => {
        const on = !btn.classList.contains('active');
        btn.classList.toggle('active', on);
        change({ [it.key]: on });
        commit();
      },
    ),
  );
  row(
    parent,
    'Align',
    segmented(
      ['left', 'center', 'right'].map((a) => ({ key: a, icon: `align-${a}`, title: `Align ${a}`, active: v.align === a })),
      (it, btn, seg) => {
        seg.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
        btn.classList.add('active');
        change({ align: it.key });
        commit();
      },
    ),
  );
}

function fillStrokeControls(parent, v, change, commit, { fill = true } = {}) {
  if (fill) {
    const fillRow = el('div');
    fillRow.style.display = 'flex';
    fillRow.style.gap = '8px';
    fillRow.style.alignItems = 'center';
    const picker = colorInput(v.fill || '#ffffff', (x) => change({ fill: x }), commit);
    picker.disabled = !v.fill;
    const none = checkbox('None', !v.fill, (checked) => {
      picker.disabled = checked;
      change({ fill: checked ? '' : picker.value });
      commit();
    });
    none.style.margin = '0';
    fillRow.append(picker, none);
    row(parent, 'Fill', fillRow);
  }
  row(parent, 'Stroke', colorInput(v.stroke, (x) => change({ stroke: x }), commit));
  row(parent, 'Thickness', numberInput(v.strokeWidth, { min: 0, max: 40, step: 0.5 }, (x) => change({ strokeWidth: x }), commit));
}

// ---------- render ----------

function render() {
  if (!host) return;
  host.innerHTML = '';
  const view = selection?.view;
  const obj = view?.canvas?.getActiveObject();
  if (obj) renderObject(view, obj);
  else renderDefaults();
}

function renderObject(view, obj) {
  const c = view.canvas;
  const set = (props) => {
    if ('fill' in props) props = { ...props, autoColor: false }; // user picked a colour explicitly
    obj.set(props);
    if (obj.initDimensions && TEXT_LAYOUT_KEYS.some((k) => k in props)) obj.initDimensions();
    obj.setCoords();
    c.requestRenderAll();
  };
  const commit = () => record(view);
  const opacityRow = (s) =>
    row(s, 'Opacity', rangeInput(obj.opacity ?? 1, { min: 0.05, max: 1, step: 0.05 }, (x) => set({ opacity: x }), commit));

  if (obj instanceof ActiveSelection) {
    const s = section(`${obj.getObjects().length} objects selected`);
    actions(s, { single: false });
    return;
  }

  if (obj instanceof FabricText) {
    const s = section(obj.role === 'edit-text' ? 'Edited text' : 'Text');
    textControls(
      s,
      {
        family: obj.fontFamily,
        size: obj.fontSize,
        color: obj.fill,
        bold: obj.fontWeight === 'bold',
        italic: obj.fontStyle === 'italic',
        align: obj.textAlign,
      },
      (p) => {
        const props = {};
        if ('family' in p) props.fontFamily = p.family;
        if ('size' in p) props.fontSize = p.size;
        if ('color' in p) props.fill = p.color;
        if ('bold' in p) props.fontWeight = p.bold ? 'bold' : 'normal';
        if ('italic' in p) props.fontStyle = p.italic ? 'italic' : 'normal';
        if ('align' in p) props.textAlign = p.align;
        set(props);
      },
      commit,
    );
    opacityRow(s);
    if (obj.role === 'edit-text') {
      helpCard(s, '<p>The original text is hidden by a colour-matched cover underneath. Delete this text to remove the original text from the page.</p>');
    }
  } else if (obj.role === 'whiteout') {
    const s = section('Whiteout');
    row(s, 'Color', colorInput(obj.fill, (x) => set({ fill: x }), commit));
    const btns = el('div', 'btn-row');
    const match = el('button', 'btn ghost sm');
    match.innerHTML = `${icon('wand', 15)}<span>Match background</span>`;
    match.addEventListener('click', () => {
      const { bg } = sampleColors(view, { x: obj.left, y: obj.top, w: obj.width * obj.scaleX, h: obj.height * obj.scaleY });
      set({ fill: bg });
      obj.set('autoColor', true);
      commit();
      render();
    });
    btns.appendChild(match);
    s.appendChild(btns);
  } else if (obj.role === 'highlight') {
    const s = section('Highlight');
    row(s, 'Color', colorInput(obj.fill, (x) => set({ fill: x }), commit));
    opacityRow(s);
  } else if (obj instanceof Rect || obj instanceof Ellipse) {
    const s = section(obj instanceof Rect ? 'Rectangle' : 'Ellipse');
    fillStrokeControls(
      s,
      { fill: obj.fill === 'transparent' ? '' : obj.fill, stroke: obj.stroke, strokeWidth: obj.strokeWidth },
      (p) => set('fill' in p ? { fill: p.fill || 'transparent' } : p),
      commit,
    );
    opacityRow(s);
  } else if (obj instanceof Line || obj instanceof Path) {
    const s = section(obj instanceof Line ? 'Line' : 'Drawing');
    fillStrokeControls(s, { stroke: obj.stroke, strokeWidth: obj.strokeWidth }, set, commit, { fill: false });
    opacityRow(s);
  } else if (obj instanceof FabricImage) {
    const s = section(obj.role === 'signature' ? 'Signature' : 'Image');
    opacityRow(s);
  } else {
    section('Object');
  }
  actions(section(), { single: true });
}

function actions(parent, { single }) {
  const wrap = el('div', 'btn-row');
  const add = (label, ic, fn, cls = 'ghost') => {
    const b = el('button', `btn ${cls} sm`);
    b.innerHTML = `${icon(ic, 15)}<span>${label}</span>`;
    b.addEventListener('click', fn);
    wrap.appendChild(b);
  };
  if (single) {
    add('Duplicate', 'copy', () => duplicateSelection());
    add('Front', 'front', () => arrangeSelection('front'));
    add('Back', 'back', () => arrangeSelection('back'));
  }
  add('Delete', 'trash', () => deleteSelection(), 'danger');
  parent.appendChild(wrap);
}

function renderDefaults() {
  const d = state.defaults;
  const noop = () => {};
  switch (state.tool) {
    case 'text': {
      const s = section('New text');
      textControls(
        s,
        { family: d.fontFamily, size: d.fontSize, color: d.textColor, bold: d.bold, italic: d.italic, align: d.align },
        (p) => {
          if ('family' in p) d.fontFamily = p.family;
          if ('size' in p) d.fontSize = p.size;
          if ('color' in p) d.textColor = p.color;
          if ('bold' in p) d.bold = p.bold;
          if ('italic' in p) d.italic = p.italic;
          if ('align' in p) d.align = p.align;
        },
        noop,
      );
      helpCard(s, '<p>Click anywhere on a page to add text.</p>');
      break;
    }
    case 'rect':
    case 'ellipse':
    case 'line': {
      const s = section(state.tool === 'line' ? 'New line' : 'New shape');
      fillStrokeControls(s, { fill: d.fill, stroke: d.stroke, strokeWidth: d.strokeWidth }, (p) => Object.assign(d, p), noop, {
        fill: state.tool !== 'line',
      });
      helpCard(s, '<p>Drag on the page to draw. Click once for a default size.</p>');
      break;
    }
    case 'highlight': {
      const s = section('Highlight');
      row(s, 'Color', colorInput(d.highlight, (x) => (d.highlight = x)));
      helpCard(s, '<p>Drag across text to highlight it.</p>');
      break;
    }
    case 'draw': {
      const s = section('Freehand');
      row(s, 'Color', colorInput(d.drawColor, (x) => ((d.drawColor = x), refreshToolModes())));
      row(s, 'Thickness', numberInput(d.drawWidth, { min: 0.5, max: 30, step: 0.5 }, (x) => ((d.drawWidth = x), refreshToolModes())));
      break;
    }
    case 'whiteout': {
      const s = section('Whiteout');
      row(s, 'Color', colorInput(d.whiteout, (x) => (d.whiteout = x)));
      s.appendChild(checkbox('Match the paper colour automatically (for scans)', d.matchBackground, (v) => (d.matchBackground = v)));
      helpCard(s, '<p>Drag over anything you want to erase. On scans, the cover takes the colour of the surrounding paper.</p>');
      break;
    }
    case 'edittext': {
      const s = section('Edit text');
      helpCard(
        s,
        `<p>Click any outlined line of text to edit it. The text gets a cover that matches the page, so the replacement blends in.</p>
         <ul><li><span style="color:#2563eb">Blue</span> outlines: real PDF text</li>
         <li><span style="color:#15803d">Green</span> outlines: text recognized from a scan</li>
         <li>Scanned page? Run OCR in <b>Scan tools</b> first.</li></ul>`,
      );
      break;
    }
    default: {
      const s = section('Properties');
      helpCard(
        s,
        `<p>Select an object on the page to change it.</p>
         <ul>
           <li><b>Edit text</b>: change existing text</li>
           <li><b>Scan tools</b>: OCR and clean up scanned pages</li>
           <li><kbd>Del</kbd> deletes, <kbd>Ctrl</kbd>+<kbd>Z</kbd>/<kbd>Y</kbd> undo/redo</li>
           <li><kbd>Ctrl</kbd>+<kbd>D</kbd> duplicates the selection</li>
         </ul>`,
      );
    }
  }
}
