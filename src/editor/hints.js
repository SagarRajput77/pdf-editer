import { state, emit, setCurrentPage } from '../state.js';
import { getTextBlocks, createEditFromBlock, getMatchCanvas } from './textEdit.js';
import { el } from '../utils.js';

function usedBlockKeys(view) {
  const keys = new Set();
  let objects = [];
  if (view.canvas) objects = view.canvas.getObjects();
  else if (view.page.json) objects = JSON.parse(view.page.json).objects ?? [];
  for (const o of objects) if (o.blockKey) keys.add(o.blockKey);
  return keys;
}

/** Shows clickable boxes over existing text (native PDF text or OCR lines) in "Edit text" mode. */
export async function renderHints(view) {
  const layer = view.hintLayer;
  const token = (view.hintToken = (view.hintToken || 0) + 1);
  if (state.tool !== 'edittext' || !view.visible) {
    layer.innerHTML = '';
    return;
  }
  const page = view.page;
  const blocks = await getTextBlocks(page);
  if (token !== view.hintToken) return;
  layer.innerHTML = '';

  if (!blocks.length) {
    const card = el('div', 'scan-prompt');
    const looksScanned = page.isScanned || page.hasImages || page.enhance;
    if (page.ocr) {
      card.innerHTML = '<strong>No text recognized</strong><p>Try another OCR language or enhance the scan, then run OCR again.</p>';
    } else if (looksScanned) {
      card.innerHTML =
        '<strong>Scanned page</strong><p>This page is an image. Recognize its text (OCR) to make it editable.</p>';
      const btn = el('button', 'btn primary sm', 'Recognize text');
      btn.addEventListener('click', () => emit('ocr:request', page));
      card.appendChild(btn);
    } else if (page.textChars === null && page.srcIndex != null) {
      card.innerHTML = '<p>Analyzing page…</p>';
    } else {
      card.innerHTML = '<strong>No editable text</strong><p>Use “Add text” to place new text on this page.</p>';
    }
    layer.appendChild(card);
    return;
  }

  // Warm up the high-res render used to match fonts/colours, so clicking feels instant.
  if (page.ocr) getMatchCanvas(page).catch(() => {});

  const used = usedBlockKeys(view);
  const z = state.zoom;
  const frag = document.createDocumentFragment();
  for (const block of blocks) {
    if (used.has(block.key)) continue;
    const hint = el('div', `hint ${block.source}`);
    hint.style.left = `${block.x * z}px`;
    hint.style.top = `${block.y * z}px`;
    hint.style.width = `${Math.max(4, block.w * z)}px`;
    hint.style.height = `${Math.max(4, block.h * z)}px`;
    hint.title = block.source === 'ocr' ? 'Recognized text, click to edit' : 'Click to edit';
    hint.setAttribute('aria-label', block.text);
    hint.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setCurrentPage(page.id);
      createEditFromBlock(view, block);
    });
    frag.appendChild(hint);
  }
  layer.appendChild(frag);
}
