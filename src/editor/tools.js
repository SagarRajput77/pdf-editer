import { IText, Rect, Ellipse, Line, PencilBrush, FabricImage, ActiveSelection } from 'fabric';
import { state, emit, setCurrentPage } from '../state.js';
import { record } from './history.js';
import { renderHints } from './hints.js';
import { sampleColors } from './textEdit.js';
import { CUSTOM_PROPS } from './pageView.js';

// Tools that create a new object by clicking/dragging on the page.
export const CREATE_TOOLS = new Set(['text', 'rect', 'ellipse', 'line', 'highlight', 'whiteout']);

export function setTool(tool) {
  state.tool = tool;
  for (const p of state.pages) if (p.view) applyToolMode(p.view);
  emit('tool', tool);
}

export function refreshToolModes() {
  for (const p of state.pages) if (p.view) applyToolMode(p.view);
}

export function applyToolMode(view) {
  renderHints(view);
  const c = view.canvas;
  if (!c) return;
  const t = state.tool;
  const creating = CREATE_TOOLS.has(t);
  if (creating || t === 'draw') {
    const active = c.getActiveObject();
    if (active && !active.isEditing) c.discardActiveObject();
  }
  c.isDrawingMode = t === 'draw';
  if (t === 'draw') {
    const brush = new PencilBrush(c);
    brush.color = state.defaults.drawColor;
    brush.width = state.defaults.drawWidth;
    brush.strokeLineCap = 'round';
    brush.strokeLineJoin = 'round';
    c.freeDrawingBrush = brush;
  }
  c.selection = !creating;
  c.skipTargetFind = creating;
  c.defaultCursor = creating ? (t === 'text' ? 'text' : 'crosshair') : 'default';
  c.setCursor?.(c.defaultCursor);
  c.requestRenderAll();
}

export function activeView() {
  return state.pages.find((p) => p.view?.canvas?.getActiveObject())?.view ?? null;
}

function clampPoint(view, p) {
  const { width, height } = view.size;
  return { x: Math.min(width, Math.max(0, p.x)), y: Math.min(height, Math.max(0, p.y)) };
}

/** Shifts an object back onto the page if it sticks out (anything off the page is cut off on export). */
export function keepInsidePage(view, obj) {
  if (!obj) return;
  const { width, height } = view.size;
  obj.setCoords(); // cached corners are stale while text is being typed
  const pts = obj.getCoords();
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const dx = maxX > width ? Math.max(width - maxX, -minX) : Math.max(0, -minX);
  const dy = maxY > height ? Math.max(height - maxY, -minY) : Math.max(0, -minY);
  if (!dx && !dy) return;
  obj.set({ left: obj.left + dx, top: obj.top + dy });
  obj.setCoords();
  view.canvas?.requestRenderAll();
}

function onSelect(view) {
  for (const p of state.pages) {
    const c = p.view?.canvas;
    if (p.view !== view && c?.getActiveObject()) {
      c.discardActiveObject();
      c.requestRenderAll();
    }
  }
  setCurrentPage(view.page.id);
  emit('selection', { view, obj: view.canvas.getActiveObject() });
}

export function bindCanvasEvents(view) {
  const c = view.canvas;
  let drag = null;

  c.on('mouse:down', (opt) => {
    setCurrentPage(view.page.id);
    const t = state.tool;
    if (!CREATE_TOOLS.has(t) || t === 'text') return;
    const p = clampPoint(view, c.getScenePoint(opt.e));
    const obj = createShape(t, p);
    c.add(obj);
    drag = { obj, start: p, tool: t };
  });

  c.on('mouse:move', (opt) => {
    if (!drag) return;
    resizeShape(drag, clampPoint(view, c.getScenePoint(opt.e)));
    c.requestRenderAll();
  });

  c.on('mouse:up', (opt) => {
    if (!drag) {
      if (state.tool === 'text') addText(view, clampPoint(view, c.getScenePoint(opt.e)));
      return;
    }
    const { obj, tool } = drag;
    drag = null;
    finishShape(view, obj, tool);
  });

  c.on('object:modified', ({ target }) => {
    if (target?.isEditing === false && target.text?.trim() === '') return; // being removed, see below
    record(view);
  });
  c.on('path:created', ({ path }) => {
    path.set({ role: 'draw' });
    record(view);
  });
  c.on('text:changed', ({ target }) => keepInsidePage(view, target));
  c.on('text:editing:exited', ({ target }) => {
    if (target && !target.text.trim()) {
      // Emptied text = deleted text (an edit's cover stays). Fabric still uses target.canvas
      // after firing this event, so remove it once exitEditing has finished.
      queueMicrotask(() => {
        c.remove(target);
        record(view);
        renderHints(view);
      });
      return;
    }
    keepInsidePage(view, target);
    record(view);
    renderHints(view);
  });
  c.on('selection:created', () => !view.suspend && onSelect(view));
  c.on('selection:updated', () => !view.suspend && onSelect(view));
  c.on('selection:cleared', () => {
    if (!view.suspend && state.selectionView === view) emit('selection', null);
  });
}

function createShape(tool, p) {
  const d = state.defaults;
  const base = { left: p.x, top: p.y, width: 1, height: 1 };
  switch (tool) {
    case 'whiteout':
      return new Rect({ ...base, fill: d.whiteout, strokeWidth: 0, role: 'whiteout' });
    case 'highlight':
      return new Rect({ ...base, fill: d.highlight, opacity: 0.4, strokeWidth: 0, role: 'highlight' });
    case 'ellipse':
      return new Ellipse({ left: p.x, top: p.y, rx: 0.5, ry: 0.5, fill: d.fill || 'transparent', stroke: d.stroke, strokeWidth: d.strokeWidth, role: 'shape' });
    case 'line':
      return new Line([p.x, p.y, p.x, p.y], { stroke: d.stroke, strokeWidth: d.strokeWidth, strokeLineCap: 'round', role: 'shape' });
    default:
      return new Rect({ ...base, fill: d.fill || 'transparent', stroke: d.stroke, strokeWidth: d.strokeWidth, role: 'shape' });
  }
}

function resizeShape({ obj, start, tool }, p) {
  const x = Math.min(start.x, p.x);
  const y = Math.min(start.y, p.y);
  const w = Math.abs(p.x - start.x);
  const h = Math.abs(p.y - start.y);
  if (tool === 'line') obj.set({ x2: p.x, y2: p.y });
  else if (tool === 'ellipse') obj.set({ left: x, top: y, rx: w / 2, ry: h / 2 });
  else obj.set({ left: x, top: y, width: w, height: h });
  obj.setCoords();
}

function finishShape(view, obj, tool) {
  const c = view.canvas;
  if (tool === 'line') {
    if (Math.hypot(obj.x2 - obj.x1, obj.y2 - obj.y1) < 4) obj.set({ x2: obj.x1 + 120, y2: obj.y1 });
  } else if (tool === 'ellipse') {
    if (obj.rx < 2 && obj.ry < 2) obj.set({ rx: 40, ry: 28 });
  } else if (obj.width < 4 && obj.height < 4) {
    const sizes = { highlight: [150, 16], whiteout: [120, 24], rect: [120, 80] };
    const [w, h] = sizes[tool] ?? [100, 60];
    obj.set({ width: w, height: h });
  }
  if (tool === 'whiteout' && state.defaults.matchBackground) {
    const { bg } = sampleColors(view, { x: obj.left, y: obj.top, w: obj.width, h: obj.height });
    obj.set({ fill: bg, autoColor: true });
  }
  obj.setCoords();
  setTool('select');
  c.setActiveObject(obj);
  c.requestRenderAll();
  record(view);
}

export function addText(view, p) {
  const c = view.canvas;
  if (!c) return;
  const d = state.defaults;
  const text = new IText('Type here', {
    left: p.x,
    top: Math.max(0, p.y - d.fontSize * 0.6),
    fontFamily: d.fontFamily,
    fontSize: d.fontSize,
    fill: d.textColor,
    fontWeight: d.bold ? 'bold' : 'normal',
    fontStyle: d.italic ? 'italic' : 'normal',
    textAlign: d.align,
    role: 'text',
  });
  c.add(text);
  keepInsidePage(view, text);
  setTool('select');
  c.setActiveObject(text);
  text.enterEditing();
  text.selectAll();
  c.requestRenderAll();
  record(view);
}

export async function addImage(view, dataUrl, { role = 'image', maxWidth = 0.5 } = {}) {
  if (!view) return;
  if (!view.canvas) await view.mount();
  const c = view.canvas;
  const img = await FabricImage.fromURL(dataUrl);
  const { width, height } = view.size;
  const k = Math.min(1, (width * maxWidth) / img.width, (height * 0.4) / img.height);
  let left = (width - img.width * k) / 2;
  let top = (height - img.height * k) / 2;
  // Cascade instead of stacking exactly on top of an image placed earlier (e.g. a second signature).
  const taken = (x, y) => c.getObjects().some((o) => o instanceof FabricImage && Math.abs(o.left - x) < 1 && Math.abs(o.top - y) < 1);
  for (let i = 0; i < 20 && taken(left, top); i++) {
    left += 16;
    top += 16;
  }
  img.set({ scaleX: k, scaleY: k, left, top, role });
  c.add(img);
  keepInsidePage(view, img);
  setTool('select');
  c.setActiveObject(img);
  c.requestRenderAll();
  record(view);
}

export function deleteSelection() {
  const view = activeView();
  if (!view) return false;
  const c = view.canvas;
  const active = c.getActiveObject();
  if (!active || active.isEditing) return false;
  const objects = active instanceof ActiveSelection ? active.getObjects() : [active];
  c.discardActiveObject();
  objects.forEach((o) => c.remove(o));
  c.requestRenderAll();
  record(view);
  renderHints(view);
  return true;
}

export async function duplicateSelection() {
  const view = activeView();
  if (!view) return;
  const c = view.canvas;
  const active = c.getActiveObject();
  if (!active || active.isEditing || active instanceof ActiveSelection) return;
  const clone = await active.clone(CUSTOM_PROPS);
  clone.set({ left: active.left + 12, top: active.top + 12, blockKey: null, linkId: null });
  c.add(clone);
  c.setActiveObject(clone);
  c.requestRenderAll();
  record(view);
}

export function arrangeSelection(where) {
  const view = activeView();
  if (!view) return;
  const c = view.canvas;
  const active = c.getActiveObject();
  if (!active) return;
  if (where === 'front') c.bringObjectToFront(active);
  else c.sendObjectToBack(active);
  c.requestRenderAll();
  record(view);
}
