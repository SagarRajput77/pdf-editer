import { state, on, pageSize } from '../state.js';
import { renderPageImage } from '../pdf/render.js';
import { rotatePage, deletePage, movePage, insertBlankAfter, duplicatePage } from '../editor/pages.js';
import { scrollToPage } from '../editor/viewer.js';
import { icon } from '../icons.js';
import { el } from '../utils.js';

let host;
const queue = [];
let running = false;

export function initThumbnails(node) {
  host = node;
  on('pages:changed', render);
  on('page:current', highlight);
  on('page:analyzed', updateBadges);
  on('page:ocr', updateBadges);
  on('page:thumb', (page) => {
    page.thumb = null;
    enqueue(page);
    updateBadges();
  });
}

const ACTIONS = [
  ['rotate-ccw', 'Rotate left', (p) => rotatePage(p, -90)],
  ['rotate-cw', 'Rotate right', (p) => rotatePage(p, 90)],
  ['chevron-up', 'Move up', (p) => movePage(p, -1)],
  ['chevron-down', 'Move down', (p) => movePage(p, 1)],
  ['copy', 'Duplicate page', (p) => duplicatePage(p)],
  ['file-plus', 'Insert blank page after', (p) => insertBlankAfter(p)],
  ['trash', 'Delete page', (p) => deletePage(p)],
];

function render() {
  if (!host) return;
  host.innerHTML = '';
  state.pages.forEach((page, i) => {
    const item = el('div', 'thumb');
    item.dataset.id = page.id;
    item.tabIndex = 0;
    const img = el('div', 'thumb-img');
    const { width, height } = pageSize(page);
    img.style.aspectRatio = `${width} / ${height}`;
    if (page.thumb) img.appendChild(page.thumb);
    else enqueue(page);
    const meta = el('div', 'thumb-meta');
    meta.append(el('span', null, String(i + 1)), el('span', 'badges'));
    const actions = el('div', 'thumb-actions');
    for (const [ic, title, fn] of ACTIONS) {
      const b = el('button', `icon-btn${ic === 'trash' ? ' danger' : ''}`);
      b.title = title;
      b.innerHTML = icon(ic, 14);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn(page);
      });
      actions.appendChild(b);
    }
    item.append(img, meta, actions);
    item.addEventListener('click', () => scrollToPage(page));
    item.addEventListener('keydown', (e) => e.key === 'Enter' && scrollToPage(page));
    host.appendChild(item);
  });
  updateBadges();
  highlight();
}

function highlight() {
  host?.querySelectorAll('.thumb').forEach((t) => {
    const active = t.dataset.id === state.currentPageId;
    t.classList.toggle('active', active);
    if (active) t.scrollIntoView({ block: 'nearest' });
  });
}

function updateBadges() {
  if (!host) return;
  for (const page of state.pages) {
    const badges = host.querySelector(`.thumb[data-id="${page.id}"] .badges`);
    if (!badges) continue;
    badges.innerHTML = '';
    if (page.isScanned) badges.appendChild(Object.assign(el('span', 'badge scan', 'SCAN'), { title: 'Scanned page' }));
    if (page.ocr) badges.appendChild(Object.assign(el('span', 'badge ocr', 'OCR'), { title: 'Text recognized' }));
    if (page.enhance) badges.appendChild(Object.assign(el('span', 'badge enh', 'ENH'), { title: 'Enhanced' }));
  }
}

function enqueue(page) {
  if (!queue.includes(page)) queue.push(page);
  pump();
}

async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const page = queue.shift();
    if (!state.pages.includes(page) || page.thumb) continue;
    try {
      const canvas = await renderPageImage(page, 240 / pageSize(page).width);
      page.thumb = canvas;
      const slot = host.querySelector(`.thumb[data-id="${page.id}"] .thumb-img`);
      if (slot) {
        slot.innerHTML = '';
        slot.appendChild(canvas);
      }
    } catch (err) {
      console.warn('Thumbnail failed', err);
    }
  }
  running = false;
}
