import './styles.css';
import { state, on, emit, createPageModel, currentPage, setCurrentPage } from './state.js';
import { hydrateIcons } from './icons.js';
import { openPdf, analyzePage } from './pdf/pdf.js';
import { imagesToPdf, fileToDataUrl } from './pdf/importImages.js';
import { initViewer, sync, fitWidth, setZoom, destroyAllViews } from './editor/viewer.js';
import { setTool, addImage, deleteSelection, duplicateSelection, activeView } from './editor/tools.js';
import { undo, redo, canUndo, canRedo, clearHistory, hasEdits } from './editor/history.js';
import { renderHints } from './editor/hints.js';
import { initProperties } from './ui/properties.js';
import { initThumbnails } from './ui/thumbnails.js';
import { initScanPanel } from './scan/scanPanel.js';
import { openSignatureModal } from './ui/signature.js';
import { exportPdf } from './export/exporter.js';
import { toast, showLoading, hideLoading } from './ui/toast.js';
import { downloadBlob } from './utils.js';

const $ = (id) => document.getElementById(id);

hydrateIcons();
initViewer($('viewer'), $('pages'));
initProperties($('propsPanel'));
initThumbnails($('thumbs'));
initScanPanel($('scanPanel'));

// ---------- opening files ----------

function reportIgnored(count, openedPdf) {
  if (!count) return;
  const why = openedPdf ? 'Only one PDF can be opened at a time' : 'Only images can be combined into one document';
  const files = count === 1 ? '1 other file was' : `${count} other files were`;
  toast(`${why}, so ${files} ignored.`, 'info', 6500);
}

async function loadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  const pdf = files.find((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  const images = files.filter((f) => f.type.startsWith('image/'));
  if (!pdf && !images.length) {
    toast('Please choose a PDF or an image (JPG, PNG, WEBP).', 'error');
    return;
  }
  if (hasEdits() && !confirm('Open a new file? Unsaved edits to the current document will be lost.')) return;
  showLoading(pdf ? 'Opening PDF…' : 'Converting images to PDF…');
  try {
    let bytes;
    let name;
    if (pdf) {
      bytes = new Uint8Array(await pdf.arrayBuffer());
      name = pdf.name.replace(/\.pdf$/i, '');
    } else {
      images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
      bytes = await imagesToPdf(images);
      name = images.length === 1 ? images[0].name.replace(/\.[^.]+$/, '') : 'scanned-document';
    }
    await loadDocument(bytes, name);
    reportIgnored(files.length - (pdf ? 1 : images.length), !!pdf);
  } catch (err) {
    console.error(err);
    const msg =
      err?.name === 'PasswordException'
        ? 'This PDF is password protected. Remove the password and try again.'
        : `Could not open the file: ${err?.message ?? err}`;
    toast(msg, 'error', 6000);
  } finally {
    hideLoading();
  }
}

function updateDocName() {
  const n = state.pages.length;
  $('docName').textContent = `${state.fileName}.pdf · ${n} page${n === 1 ? '' : 's'}`;
}
on('pages:changed', () => state.pages.length && updateDocName());

async function loadDocument(bytes, name) {
  const { doc, proxies } = await openPdf(bytes);
  destroyAllViews();
  clearHistory();
  state.pdfDoc?.destroy();
  Object.assign(state, { pdfBytes: bytes, pdfDoc: doc, pdfPages: proxies, fileName: name, currentPageId: null, selectionView: null });
  state.pages = proxies.map((p, i) => {
    const [x1, y1, x2, y2] = p.view;
    return createPageModel({ srcIndex: i, baseRotation: p.rotate || 0, baseWidth: x2 - x1, baseHeight: y2 - y1 });
  });

  $('landing').hidden = true;
  $('toolbar').hidden = false;
  $('workspace').hidden = false;
  $('btnDownload').disabled = false;
  updateDocName();
  document.title = `${name} – PDF Editor`;

  sync();
  fitWidth(1.5);
  emit('pages:changed');
  setCurrentPage(state.pages[0].id);
  setTool('select');
  emit('selection', null);
  analyzeAll(doc);
}

async function analyzeAll(doc) {
  let scanned = 0;
  for (const page of [...state.pages]) {
    if (state.pdfDoc !== doc) return; // another file was opened meanwhile
    try {
      await analyzePage(page);
    } catch (err) {
      console.warn('Page analysis failed', err);
    }
    if (page.isScanned) scanned++;
    emit('page:analyzed', page);
    if (page.view) renderHints(page.view);
  }
  if (scanned) {
    toast(
      `${scanned === state.pages.length ? 'This document is scanned' : `${scanned} scanned page${scanned > 1 ? 's' : ''} detected`}. Open “Scan tools” to recognize and edit the text.`,
      'info',
      6500,
    );
    selectTab('scan');
  }
}

// Recognized text becomes editable immediately.
on('page:ocr', (page) => page?.view && renderHints(page.view));

$('fileInput').addEventListener('change', (e) => {
  loadFiles(e.target.files);
  e.target.value = '';
});
$('btnOpen').addEventListener('click', () => $('fileInput').click());
$('btnOpenLanding').addEventListener('click', () => $('fileInput').click());

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const files = e.dataTransfer?.files;
  if (!files?.length) return;
  // Dropping a single image on an open document inserts it into the current page.
  if (state.pages.length && files.length === 1 && files[0].type.startsWith('image/')) insertImageFile(files[0]);
  else loadFiles(files);
});

// ---------- toolbar ----------

const toolButtons = document.querySelectorAll('[data-tool]');
toolButtons.forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
on('tool', (tool) => toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === tool)));

async function insertImageFile(file) {
  const page = currentPage();
  if (!page?.view) return;
  try {
    const dataUrl = await fileToDataUrl(file);
    await addImage(page.view, dataUrl);
  } catch (err) {
    console.error(err);
    toast('Could not read that image.', 'error');
  }
}

$('imageInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (file) insertImageFile(file);
  e.target.value = '';
});

document.querySelectorAll('[data-action]').forEach((b) =>
  b.addEventListener('click', () => {
    const action = b.dataset.action;
    if (action === 'image') $('imageInput').click();
    else if (action === 'sign')
      openSignatureModal((dataUrl) => addImage(currentPage()?.view, dataUrl, { role: 'signature', maxWidth: 0.3 }));
    else if (action === 'scan') selectTab('scan');
  }),
);

$('btnUndo').addEventListener('click', () => undo());
$('btnRedo').addEventListener('click', () => redo());
on('history', () => {
  $('btnUndo').disabled = !canUndo();
  $('btnRedo').disabled = !canRedo();
});

const ZOOM_STEPS = [0.25, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
$('btnZoomIn').addEventListener('click', () => setZoom(ZOOM_STEPS.find((z) => z > state.zoom + 0.001) ?? 4));
$('btnZoomOut').addEventListener('click', () => setZoom([...ZOOM_STEPS].reverse().find((z) => z < state.zoom - 0.001) ?? 0.25));
$('zoomLabel').addEventListener('click', () => fitWidth());
on('zoom', (z) => ($('zoomLabel').textContent = `${Math.round(z * 100)}%`));

$('viewer').addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setZoom(state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
  },
  { passive: false },
);

// ---------- right panel tabs ----------

function selectTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('propsPanel').hidden = name !== 'props';
  $('scanPanel').hidden = name !== 'scan';
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
on('selection', (s) => s && selectTab('props'));

// ---------- download ----------

$('btnDownload').addEventListener('click', async () => {
  const btn = $('btnDownload');
  btn.disabled = true;
  showLoading('Building your PDF…');
  try {
    const { bytes, rasterized } = await exportPdf({ searchable: state.searchable });
    downloadBlob(new Blob([bytes], { type: 'application/pdf' }), `${state.fileName}-edited.pdf`);
    toast(
      rasterized
        ? 'Downloaded. This PDF is protected, so pages were saved as images.'
        : 'Your edited PDF has been downloaded.',
      'success',
      5000,
    );
  } catch (err) {
    console.error(err);
    toast(`Export failed: ${err?.message ?? err}`, 'error', 6000);
  } finally {
    btn.disabled = false;
    hideLoading();
  }
});

// ---------- keyboard ----------

const TOOL_KEYS = { v: 'select', e: 'edittext', t: 'text', w: 'whiteout', h: 'highlight', r: 'rect', o: 'ellipse', l: 'line', d: 'draw' };

document.addEventListener('keydown', (e) => {
  if (!state.pages.length || document.querySelector('.modal-backdrop')) return;
  const target = e.target;
  const typing = target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
  const active = activeView()?.canvas?.getActiveObject();
  if (typing || active?.isEditing) {
    if (e.key === 'Escape' && active?.isEditing) {
      active.exitEditing();
      activeView()?.canvas.requestRenderAll();
    }
    return;
  }
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  if (mod && key === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
  } else if (mod && key === 'y') {
    e.preventDefault();
    redo();
  } else if (mod && key === 'd') {
    e.preventDefault();
    duplicateSelection();
  } else if (mod && (key === '=' || key === '+')) {
    e.preventDefault();
    $('btnZoomIn').click();
  } else if (mod && key === '-') {
    e.preventDefault();
    $('btnZoomOut').click();
  } else if (e.key === 'Delete' || e.key === 'Backspace') {
    if (deleteSelection()) e.preventDefault();
  } else if (e.key === 'Escape') {
    const view = activeView();
    view?.canvas.discardActiveObject();
    view?.canvas.requestRenderAll();
    setTool('select');
  } else if (!mod && !e.altKey && TOOL_KEYS[key]) {
    setTool(TOOL_KEYS[key]);
  }
});

window.addEventListener('beforeunload', (e) => {
  if (hasEdits()) {
    e.preventDefault();
    e.returnValue = '';
  }
});
