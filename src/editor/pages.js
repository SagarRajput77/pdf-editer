import { util, Point } from 'fabric';
import { state, emit, createPageModel, pageSize, setCurrentPage } from '../state.js';
import { invalidateEnhance } from '../pdf/render.js';
import { dropPage, markChanged } from './history.js';
import { destroyView } from './viewer.js';
import { CUSTOM_PROPS } from './pageView.js';
import { toast } from '../ui/toast.js';

function pageHasObjects(page) {
  if (page.view?.canvas) return page.view.canvas.getObjects().length > 0;
  return !!page.json && (JSON.parse(page.json).objects ?? []).length > 0;
}

/** Rotates a page by ±90° and moves its edits along with it. */
export async function rotatePage(page, delta) {
  const { width: W, height: H } = pageSize(page);
  const view = page.view;
  const c = view?.canvas;
  if (c) {
    const active = c.getActiveObject();
    if (active?.isEditing) active.exitEditing();
    c.discardActiveObject();
  }
  const objects = c ? c.getObjects() : page.json ? await util.enlivenObjects(JSON.parse(page.json).objects ?? []) : [];
  for (const o of objects) {
    const center = o.getCenterPoint();
    const next = delta > 0 ? new Point(H - center.y, center.x) : new Point(center.y, W - center.x);
    o.set('angle', ((o.angle || 0) + delta + 360) % 360);
    o.setPositionByOrigin(next, 'center', 'center');
    o.setCoords();
  }
  page.rotation = (page.rotation + delta + 360) % 360;
  page.ocr = null; // OCR coordinates no longer match
  page._blocks = null;
  invalidateEnhance(page, true);
  if (c) {
    page.json = view.serialize();
  } else if (page.json) {
    const json = JSON.parse(page.json);
    json.objects = objects.map((o) => o.toObject(CUSTOM_PROPS));
    page.json = JSON.stringify(json);
  }
  if (view) {
    view.lastJSON = page.json;
    view.layout();
  }
  dropPage(page.id);
  markChanged();
  emit('pages:changed');
  emit('page:ocr', page);
}

export function deletePage(page) {
  if (state.pages.length <= 1) {
    toast('A document needs at least one page.', 'error');
    return;
  }
  const n = state.pages.indexOf(page) + 1;
  if (pageHasObjects(page) && !confirm(`Delete page ${n} and the edits on it?`)) return;
  const idx = state.pages.indexOf(page);
  state.pages.splice(idx, 1);
  destroyView(page);
  dropPage(page.id);
  if (state.currentPageId === page.id) {
    state.currentPageId = null;
    setCurrentPage(state.pages[Math.min(idx, state.pages.length - 1)].id);
  }
  markChanged();
  emit('pages:changed');
}

export function movePage(page, dir) {
  const i = state.pages.indexOf(page);
  const j = i + dir;
  if (j < 0 || j >= state.pages.length) return;
  [state.pages[i], state.pages[j]] = [state.pages[j], state.pages[i]];
  markChanged();
  emit('pages:changed');
}

export function insertBlankAfter(page) {
  const { width, height } = pageSize(page);
  const blank = createPageModel({ srcIndex: null, baseWidth: width, baseHeight: height });
  blank.textChars = 0;
  state.pages.splice(state.pages.indexOf(page) + 1, 0, blank);
  markChanged();
  emit('pages:changed');
  return blank;
}

export function duplicatePage(page) {
  const copy = createPageModel({
    srcIndex: page.srcIndex,
    baseRotation: page.baseRotation,
    baseWidth: page.baseWidth,
    baseHeight: page.baseHeight,
  });
  Object.assign(copy, {
    rotation: page.rotation,
    textChars: page.textChars,
    hasImages: page.hasImages,
    isScanned: page.isScanned,
    textContent: page.textContent,
    ocr: page.ocr ? structuredClone(page.ocr) : null,
    enhance: page.enhance ? { ...page.enhance } : null,
    json: page.view?.canvas ? page.view.serialize() : page.json,
  });
  state.pages.splice(state.pages.indexOf(page) + 1, 0, copy);
  markChanged();
  emit('pages:changed');
  return copy;
}
