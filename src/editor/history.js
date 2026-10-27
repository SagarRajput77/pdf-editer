import { emit, getPage } from '../state.js';

// Snapshot-based undo/redo. Each entry stores a page's serialized objects before and after a change.
const undoStack = [];
const redoStack = [];
const LIMIT = 150;

export function record(view) {
  if (!view?.canvas || view.suspend) return;
  const after = view.serialize();
  if (after === view.lastJSON) return;
  undoStack.push({ pageId: view.page.id, before: view.lastJSON, after });
  if (undoStack.length > LIMIT) undoStack.shift();
  redoStack.length = 0;
  view.lastJSON = after;
  view.page.json = after;
  emit('history');
}

async function applyEntry(entry, json) {
  const page = getPage(entry.pageId);
  if (!page?.view) return false;
  await page.view.loadJSON(json);
  return true;
}

export async function undo() {
  while (undoStack.length) {
    const entry = undoStack.pop();
    if (await applyEntry(entry, entry.before)) {
      redoStack.push(entry);
      break;
    }
  }
  emit('history');
}

export async function redo() {
  while (redoStack.length) {
    const entry = redoStack.pop();
    if (await applyEntry(entry, entry.after)) {
      undoStack.push(entry);
      break;
    }
  }
  emit('history');
}

/** Forget history for a page whose geometry changed (rotation) or that was deleted. */
export function dropPage(pageId) {
  for (const stack of [undoStack, redoStack]) {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i].pageId === pageId) stack.splice(i, 1);
  }
  emit('history');
}

export function clearHistory() {
  undoStack.length = 0;
  redoStack.length = 0;
  pageChanges = false;
  emit('history');
}

// Page operations and scan enhancements aren't undoable, but they are still unsaved work.
// Rotating a page also drops its undo entries, so this keeps its edits counted.
let pageChanges = false;
export function markChanged() {
  pageChanges = true;
}

export const canUndo = () => undoStack.length > 0;
export const canRedo = () => redoStack.length > 0;
export const hasEdits = () => pageChanges || undoStack.length > 0;
