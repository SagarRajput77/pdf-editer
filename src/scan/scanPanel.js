import { state, on, emit, currentPage } from '../state.js';
import { recognizePage, OCR_LANGS } from './ocr.js';
import { DEFAULT_ENHANCE } from './enhance.js';
import { invalidateEnhance } from '../pdf/render.js';
import { setTool } from '../editor/tools.js';
import { markChanged } from '../editor/history.js';
import { toast } from '../ui/toast.js';
import { esc, debounce, downloadBlob } from '../utils.js';

let host;
let busy = false;
let progress = { text: '', value: 0 };

export function initScanPanel(node) {
  host = node;
  host.addEventListener('click', onClick);
  on('page:current', render);
  on('page:analyzed', (p) => p === currentPage() && render());
  on('page:ocr', render);
  on('pages:changed', render);
  on('ocr:request', (page) => runOcr([page]));
  render();
}

function pageStatus(page) {
  if (page.srcIndex == null) return { label: 'Blank page', cls: '', help: 'An empty page you inserted.' };
  if (page.textChars === null) return { label: 'Analyzing…', cls: '', help: '' };
  if (page.isScanned)
    return {
      label: 'Scanned page',
      cls: 'warn',
      help: 'This page is an image, so its text cannot be edited yet. Recognize the text below to edit it, search it and copy it.',
    };
  return {
    label: 'Digital page',
    cls: 'ok',
    help: 'This page already contains real text. Use the Edit text tool to change it. OCR is optional.',
  };
}

const slider = (key, label, min, max, step, value, unit = '') => `
  <label class="prop-row"><span class="prop-label">${label}</span>
    <input type="range" data-k="${key}" min="${min}" max="${max}" step="${step}" value="${value}">
    <output data-out="${key}">${value}${unit}</output>
  </label>`;

function render() {
  if (!host) return;
  const page = currentPage();
  if (!page) {
    host.innerHTML = '<p class="muted">Open a document to use the scan tools.</p>';
    return;
  }
  const n = state.pages.indexOf(page) + 1;
  const e = { ...DEFAULT_ENHANCE, ...(page.enhance ?? {}) };
  const scanned = state.pages.filter((p) => p.isScanned);
  const status = pageStatus(page);

  host.innerHTML = `
    <div class="prop-section">
      <div class="page-status"><span class="pill ${status.cls}">${status.label}</span><span class="muted small">Page ${n} of ${state.pages.length}</span></div>
      <p class="muted small" style="margin:6px 0 0">${status.help}</p>
    </div>

    <div class="prop-section">
      <h4>Recognize text (OCR)</h4>
      <label class="prop-row"><span class="prop-label">Language</span>
        <select data-k="lang">${OCR_LANGS.map(([v, l]) => `<option value="${v}" ${v === state.ocrLang ? 'selected' : ''}>${l}</option>`).join('')}</select>
      </label>
      <div class="btn-row">
        <button class="btn primary sm" data-act="ocr-page" ${busy ? 'disabled' : ''}>${page.ocr ? 'Run again on this page' : 'Recognize this page'}</button>
        <button class="btn ghost sm" data-act="ocr-all" ${busy ? 'disabled' : ''}>${scanned.length ? `All scanned pages (${scanned.length})` : 'All pages'}</button>
      </div>
      <div class="progress" ${busy ? '' : 'hidden'}>
        <div class="progress-track"><div class="progress-fill" style="width:${Math.round(progress.value * 100)}%"></div></div>
        <div class="progress-text small muted">${esc(progress.text)}</div>
      </div>
      ${
        page.ocr
          ? `<div class="ocr-result">
              <div class="small"><strong>${page.ocr.lines.length}</strong> lines recognized · ${Math.round(page.ocr.confidence)}% confidence</div>
              <div class="btn-row">
                <button class="btn primary sm" data-act="edit">Edit recognized text</button>
                <button class="btn ghost sm" data-act="copy">Copy text</button>
                <button class="btn ghost sm" data-act="txt">Save .txt</button>
              </div>
              <details><summary>Preview text</summary><pre class="ocr-text">${esc(page.ocr.text) || '(no text)'}</pre></details>
            </div>`
          : '<p class="muted small" style="margin:8px 0 0">The OCR engine and language data download the first time you use them (a few MB).</p>'
      }
    </div>

    <div class="prop-section">
      <h4>Enhance scan</h4>
      <div class="seg" data-k="mode" style="margin-bottom:10px">
        ${[['color', 'Original'], ['gray', 'Grayscale'], ['bw', 'B&amp;W']].map(([v, l]) => `<button data-mode="${v}" class="${e.mode === v ? 'active' : ''}">${l}</button>`).join('')}
      </div>
      <label class="check"><input type="checkbox" data-k="autoLevels" ${e.autoLevels ? 'checked' : ''}> Auto contrast</label>
      ${slider('brightness', 'Brightness', -100, 100, 1, e.brightness)}
      ${slider('contrast', 'Contrast', -100, 100, 1, e.contrast)}
      ${slider('whiten', 'Clean paper', 0, 100, 1, e.whiten)}
      ${e.mode === 'bw' ? slider('threshold', 'Threshold', 60, 230, 1, e.threshold) : ''}
      ${slider('angle', 'Straighten', -10, 10, 0.25, e.angle, '°')}
      <div class="btn-row">
        <button class="btn ghost sm" data-act="enh-all" ${page.enhance && scanned.length > 1 ? '' : 'disabled'}>Apply to all scanned pages</button>
        <button class="btn ghost sm" data-act="enh-reset" ${page.enhance ? '' : 'disabled'}>Reset</button>
      </div>
      <p class="muted small" style="margin:8px 0 0">Enhanced pages are saved as images in the downloaded PDF.</p>
    </div>

    <div class="prop-section">
      <h4>Download options</h4>
      <label class="check"><input type="checkbox" data-k="searchable" ${state.searchable ? 'checked' : ''}> Make scanned pages searchable</label>
      <p class="muted small" style="margin:0">Adds the recognized text as an invisible layer, so the PDF can be searched and its text copied.</p>
    </div>`;
  bind(page);
}

function bind(page) {
  host.querySelector('[data-k="lang"]').addEventListener('change', (ev) => (state.ocrLang = ev.target.value));
  host.querySelector('[data-k="searchable"]').addEventListener('change', (ev) => (state.searchable = ev.target.checked));
  host.querySelector('[data-k="autoLevels"]').addEventListener('change', (ev) => updateEnhance(page, { autoLevels: ev.target.checked }));
  host.querySelectorAll('[data-mode]').forEach((b) =>
    b.addEventListener('click', () => {
      updateEnhance(page, { mode: b.dataset.mode }, true);
      render();
    }),
  );
  host.querySelectorAll('input[type="range"][data-k]').forEach((input) => {
    const key = input.dataset.k;
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      host.querySelector(`[data-out="${key}"]`).textContent = `${v}${key === 'angle' ? '°' : ''}`;
      updateEnhance(page, { [key]: v });
    });
    input.addEventListener('change', () => render());
  });
}

function onClick(ev) {
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const page = currentPage();
  switch (btn.dataset.act) {
    case 'ocr-page':
      runOcr([page]);
      break;
    case 'ocr-all': {
      const scanned = state.pages.filter((p) => p.isScanned);
      runOcr(scanned.length ? scanned : state.pages);
      break;
    }
    case 'edit':
      setTool('edittext');
      break;
    case 'copy':
      navigator.clipboard
        .writeText(page.ocr?.text ?? '')
        .then(() => toast('Text copied to clipboard', 'success'))
        .catch(() => toast('Could not access the clipboard', 'error'));
      break;
    case 'txt': {
      const text = state.pages
        .map((p, i) => (p.ocr ? `--- Page ${i + 1} ---\n${p.ocr.text}` : null))
        .filter(Boolean)
        .join('\n\n');
      downloadBlob(new Blob([text], { type: 'text/plain;charset=utf-8' }), `${state.fileName}-text.txt`);
      break;
    }
    case 'enh-all': {
      const { angle, ...settings } = page.enhance;
      for (const p of state.pages) if (p.isScanned && p !== page) updateEnhance(p, settings, true);
      toast('Enhancement applied to all scanned pages', 'success');
      break;
    }
    case 'enh-reset':
      if (page.enhance?.angle && page.ocr) clearOcr(page);
      page.enhance = null;
      markChanged();
      invalidateEnhance(page);
      refreshPage(page);
      render();
      break;
  }
}

function clearOcr(page) {
  page.ocr = null;
  emit('page:ocr', page);
  toast('Recognized text was cleared because the page geometry changed. Run OCR again.');
}

const refreshPage = (page) => {
  page._needsResample = true; // covers/edited text should follow the new paper/ink colours
  page.view?.refreshBackground();
  emit('page:thumb', page);
};
const refreshPageDebounced = new Map();

function updateEnhance(page, patch, immediate = false) {
  const prev = page.enhance ?? DEFAULT_ENHANCE;
  if ('angle' in patch && patch.angle !== prev.angle && page.ocr) clearOcr(page);
  page.enhance = { ...prev, ...patch };
  markChanged();
  invalidateEnhance(page);
  if (immediate) return refreshPage(page);
  if (!refreshPageDebounced.has(page)) refreshPageDebounced.set(page, debounce(() => refreshPage(page), 90));
  refreshPageDebounced.get(page)();
}

function setProgress(text, value) {
  progress = { text, value };
  const fill = host?.querySelector('.progress-fill');
  const label = host?.querySelector('.progress-text');
  if (fill) fill.style.width = `${Math.round(value * 100)}%`;
  if (label) label.textContent = text;
}

export async function runOcr(pages) {
  if (busy || !pages.length) return;
  busy = true;
  progress = { text: 'Starting…', value: 0 };
  render();
  let done = 0;
  try {
    for (const [i, page] of pages.entries()) {
      const prefix = pages.length > 1 ? `Page ${i + 1} of ${pages.length}: ` : '';
      await recognizePage(page, state.ocrLang, (m) => {
        const label = m.status === 'recognizing text' ? 'recognizing text' : m.status;
        const overall = pages.length > 1 ? (i + (m.status === 'recognizing text' ? m.progress : 0)) / pages.length : m.progress;
        setProgress(`${prefix}${label}…`, overall ?? 0);
      });
      done++;
      emit('page:ocr', page);
    }
    toast(
      done === 1 ? 'Text recognized. Click “Edit recognized text” to change it.' : `Text recognized on ${done} pages.`,
      'success',
      5000,
    );
  } catch (err) {
    console.error(err);
    toast(`OCR failed: ${err?.message ?? err}. Check your internet connection (language data is downloaded on first use).`, 'error', 7000);
  } finally {
    busy = false;
    render();
  }
}
