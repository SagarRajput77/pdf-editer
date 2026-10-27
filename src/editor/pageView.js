import { Canvas, FabricObject, ActiveSelection } from 'fabric';
import { state, pageSize, emit } from '../state.js';
import { renderPageImage } from '../pdf/render.js';
import { bindCanvasEvents, applyToolMode } from './tools.js';
import { renderHints } from './hints.js';
import { resampleAutoColors } from './textEdit.js';
import { record } from './history.js';
import { el } from '../utils.js';

// Custom properties persisted with every Fabric object.
export const CUSTOM_PROPS = ['role', 'linkId', 'blockKey', 'autoColor'];
export const EMPTY_JSON = '{"objects":[]}';

Object.assign(FabricObject.ownDefaults, {
  transparentCorners: false,
  cornerColor: '#ffffff',
  cornerStrokeColor: '#2563eb',
  borderColor: '#2563eb',
  cornerSize: 9,
  cornerStyle: 'circle',
  borderScaleFactor: 1.5,
});

/**
 * One page in the continuous viewer: a pdf.js-rendered background canvas, a Fabric
 * canvas for edits (mounted only while near the viewport) and a hint layer for "Edit text".
 */
export class PageView {
  constructor(page) {
    this.page = page;
    page.view = this;
    this.wrap = el('div', 'page-wrap');
    this.wrap.dataset.id = page.id;
    this.pageEl = el('div', 'page');
    this.bg = document.createElement('canvas');
    this.bg.className = 'page-bg';
    this.host = el('div', 'fab-host');
    this.hintLayer = el('div', 'hint-layer');
    this.label = el('div', 'page-label');
    this.pageEl.append(this.bg, this.host, this.hintLayer);
    this.wrap.append(this.pageEl, this.label);

    this.canvas = null;
    this.visible = false;
    this.suspend = false;
    this.bgScale = 0;
    this.bgToken = 0;
    this.bgTimer = null;
    this.lastJSON = page.json;
    this.mounting = null;
    this.layout();
  }

  get size() {
    return pageSize(this.page);
  }

  layout({ deferBg = false } = {}) {
    const { width, height } = this.size;
    const z = state.zoom;
    this.pageEl.style.width = `${Math.round(width * z)}px`;
    this.pageEl.style.height = `${Math.round(height * z)}px`;
    if (this.canvas) {
      this.canvas.setDimensions({ width: width * z, height: height * z });
      this.canvas.setZoom(z);
      this.canvas.calcOffset();
      this.canvas.requestRenderAll();
    }
    if (this.visible) {
      if (deferBg) this.scheduleBg();
      else this.renderBg();
    }
    renderHints(this);
  }

  async show() {
    if (this.visible) return;
    this.visible = true;
    await this.mount();
    if (!this.visible) {
      this.unmount();
      return;
    }
    this.renderBg();
    renderHints(this);
  }

  hide() {
    if (!this.visible) return;
    this.visible = false;
    this.bgToken++;
    this.unmount();
    this.bg.width = 0;
    this.bg.height = 0;
    this.bgScale = 0;
    this.hintLayer.innerHTML = '';
  }

  async mount() {
    if (this.canvas) return;
    if (this.mounting) return this.mounting;
    this.mounting = (async () => {
      const { width, height } = this.size;
      const z = state.zoom;
      const holder = el('div');
      const canvasEl = document.createElement('canvas');
      holder.appendChild(canvasEl);
      this.host.appendChild(holder);
      const c = new Canvas(canvasEl, {
        width: width * z,
        height: height * z,
        preserveObjectStacking: true,
        selectionColor: 'rgba(37,99,235,0.08)',
        selectionBorderColor: '#2563eb',
        stopContextMenu: true,
      });
      c.setZoom(z);
      c._holder = holder;
      this.suspend = true;
      if (this.page.json) await c.loadFromJSON(this.page.json);
      this.suspend = false;
      this.canvas = c;
      bindCanvasEvents(this);
      applyToolMode(this);
      this.layout({ deferBg: true });
      this.lastJSON = this.serialize();
      this.page.json = this.lastJSON;
    })();
    try {
      await this.mounting;
    } finally {
      this.mounting = null;
    }
  }

  unmount() {
    const c = this.canvas;
    if (!c) return;
    const active = c.getActiveObject();
    if (active?.isEditing) active.exitEditing();
    this.page.json = this.serialize();
    this.lastJSON = this.page.json;
    if (state.selectionView === this) emit('selection', null);
    this.canvas = null;
    const holder = c._holder;
    Promise.resolve(c.dispose()).finally(() => holder.remove());
  }

  serialize() {
    const c = this.canvas;
    if (!c) return this.page.json;
    // Objects inside an ActiveSelection are stored relative to the group; serialize them in page space.
    const active = c.getActiveObject();
    let selected = null;
    if (active instanceof ActiveSelection) {
      selected = active.getObjects();
      this.suspend = true;
      c.discardActiveObject();
    }
    const json = JSON.stringify(c.toObject(CUSTOM_PROPS));
    if (selected) {
      c.setActiveObject(new ActiveSelection(selected, { canvas: c }));
      c.requestRenderAll();
      this.suspend = false;
    }
    return json;
  }

  async loadJSON(json) {
    this.page.json = json;
    this.lastJSON = json;
    const c = this.canvas;
    if (c) {
      this.suspend = true;
      c.discardActiveObject();
      await c.loadFromJSON(json ?? EMPTY_JSON);
      applyToolMode(this);
      c.requestRenderAll();
      this.suspend = false;
      emit('selection', null);
    }
    renderHints(this);
  }

  scheduleBg() {
    clearTimeout(this.bgTimer);
    this.bgTimer = setTimeout(() => this.renderBg(), 140);
  }

  async renderBg() {
    clearTimeout(this.bgTimer);
    const token = ++this.bgToken;
    const scale = state.zoom * (window.devicePixelRatio || 1);
    let img;
    try {
      img = await renderPageImage(this.page, scale);
    } catch (err) {
      console.error(err);
      return;
    }
    if (token !== this.bgToken || !this.visible) return;
    this.bg.width = img.width;
    this.bg.height = img.height;
    this.bg.getContext('2d').drawImage(img, 0, 0);
    this.bgScale = img.width / this.size.width;
    if (this.page._needsResample && this.canvas) {
      this.page._needsResample = false;
      if (resampleAutoColors(this.canvas.getObjects(), this)) {
        this.canvas.requestRenderAll();
        record(this);
      }
    }
  }

  /** Re-render background (after enhancement / rotation changes). */
  refreshBackground() {
    if (this.visible) this.renderBg();
  }
}
