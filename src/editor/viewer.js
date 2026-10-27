import { state, on, emit, setCurrentPage, currentPage, pageSize } from '../state.js';
import { PageView } from './pageView.js';
import { clamp } from '../utils.js';

let scroller;
let container;
let mountObserver;
let currentObserver;
const ratios = new Map();
let suppressCurrentUntil = 0;

export function initViewer(scrollEl, pagesEl) {
  scroller = scrollEl;
  container = pagesEl;
  // Mount Fabric canvases / render backgrounds only for pages near the viewport.
  mountObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const view = state.pages.find((p) => p.id === e.target.dataset.id)?.view;
        if (!view) continue;
        if (e.isIntersecting) view.show();
        else view.hide();
      }
    },
    { root: scroller, rootMargin: '1200px 0px' },
  );
  currentObserver = new IntersectionObserver(
    (entries) => {
      for (const e of entries) ratios.set(e.target.dataset.id, e.intersectionRatio);
      if (Date.now() < suppressCurrentUntil) return;
      let best = null;
      let bestRatio = 0;
      for (const [id, r] of ratios) {
        if (r > bestRatio) {
          bestRatio = r;
          best = id;
        }
      }
      if (best) setCurrentPage(best);
    },
    { root: scroller, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] },
  );
  on('pages:changed', sync);
}

/** Puts page views in the DOM in model order, creating views for new pages. */
export function sync() {
  state.pages.forEach((page, i) => {
    if (!page.view) {
      new PageView(page);
      mountObserver.observe(page.view.wrap);
      currentObserver.observe(page.view.wrap);
    }
    container.appendChild(page.view.wrap);
    page.view.label.textContent = `Page ${i + 1}`;
  });
  for (const child of [...container.children]) {
    if (!state.pages.some((p) => p.view?.wrap === child)) child.remove();
  }
}

export function destroyView(page) {
  const view = page.view;
  if (!view) return;
  mountObserver.unobserve(view.wrap);
  currentObserver.unobserve(view.wrap);
  ratios.delete(page.id);
  view.hide();
  view.wrap.remove();
  page.view = null;
}

export function destroyAllViews() {
  for (const page of state.pages) destroyView(page);
  ratios.clear();
  container.innerHTML = '';
}

export function scrollToPage(page) {
  if (!page?.view) return;
  suppressCurrentUntil = Date.now() + 700;
  setCurrentPage(page.id);
  scroller.scrollTo({ top: page.view.wrap.offsetTop - 16, behavior: 'smooth' });
}

export function setZoom(z) {
  z = clamp(Math.round(z * 100) / 100, 0.25, 4);
  const anchor = currentPage()?.view?.wrap;
  const rel = anchor ? (scroller.scrollTop - anchor.offsetTop) / Math.max(1, anchor.offsetHeight) : 0;
  state.zoom = z;
  for (const p of state.pages) p.view?.layout({ deferBg: true });
  if (anchor) scroller.scrollTop = anchor.offsetTop + rel * anchor.offsetHeight;
  emit('zoom', z);
}

export function fitWidth(maxZoom = 4) {
  if (!state.pages.length) return;
  const maxW = Math.max(...state.pages.map((p) => pageSize(p).width));
  setZoom(Math.min(maxZoom, (scroller.clientWidth - 48) / maxW));
}
