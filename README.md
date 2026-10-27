# PDF Editor

A browser-based PDF editor, similar to Sejda's PDF editor, that can also edit **scanned documents**.
Everything runs on the client, so files are never uploaded.

## Run

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # static production build in dist/
```

The OCR engine (Tesseract.js) downloads its WebAssembly core and language data from a CDN the
first time OCR runs. The browser caches them after that.

## Features

**Editing**
- Edit existing text: click a line, and it is replaced by an editable text box sitting on a cover
  that matches the paper colour. Font size, position, colour and (where detectable) font family and weight are matched.
- Add text, whiteout, highlight, rectangle, ellipse, line, freehand drawing
- Insert images; signatures (draw or type, last one is remembered)
- Properties panel: font, size, colour, bold/italic, alignment, fill/stroke, opacity, arrange, duplicate
- Undo/redo, zoom (Ctrl+wheel), keyboard shortcuts (V, E, T, W, H, R, O, L, D, Del, Ctrl+Z/Y/D)

**Pages**: rotate (edits rotate with the page), reorder, duplicate, insert a blank page, delete

**Scanned documents**
- Automatic detection of scanned pages (image only, no text layer), shown with a `SCAN` badge
- Open JPG/PNG/WEBP photos or scans directly; each image becomes a page (EXIF orientation respected)
- OCR in English, Hindi, Marathi, Gujarati, Bengali, Tamil, Telugu, Kannada, Malayalam, Punjabi,
  Urdu and more, per page or for all scanned pages
- Forms and tables: table borders are detected and removed before OCR (so they aren't read as
  `|` or `[`), lines are split into individual cells, uncertain cells get a second single-line
  OCR pass, and edit covers stay inside their cell borders
- Edit recognized text: each OCR line or table cell becomes clickable. Editing it samples the paper and ink
  colours, covers the original and places matching text.
- Enhance: grayscale / black & white, auto contrast, brightness, contrast, clean paper (whiten the
  background), straighten. Covers re-match their colour automatically when the scan changes.
- Make searchable: the download contains an invisible OCR text layer, so you can search, select and copy text
- Copy recognized text or save it as .txt

## How it works

| Layer | Library | Role |
| --- | --- | --- |
| Rendering | `pdfjs-dist` | Draws page backgrounds and extracts the native text layer |
| Editing | `fabric` | One canvas per page (mounted only near the viewport) for edit objects |
| OCR | `tesseract.js` | Recognizes lines and words with bounding boxes and baselines |
| Export | `pdf-lib` | Writes edits into the original PDF |

Export keeps the original page objects (links, annotations and form fields stay intact) and
writes every edit as real PDF content. Text, shapes, paths and images are vector or embedded
images, not a flattened screenshot. The overlay is drawn through a transform that maps the
editor's coordinates onto each page's crop box and `/Rotate`, so rotated pages work. Text that the
14 standard PDF fonts can't encode (for example Devanagari) is embedded as a high-resolution image.

```
src/
  main.js              app wiring: open, toolbar, download, shortcuts
  state.js             app state + event bus
  pdf/                 pdf.js setup, rendering, image→PDF import
  editor/              page views, tools, text editing, history, page ops
  scan/                OCR, enhancement filters, Scan tools panel
  export/exporter.js   pdf-lib export
  ui/                  properties panel, thumbnails, signature modal, toasts
```

## Known limitations

- Editing or whiting out text **covers** the original. It does not delete it from the PDF's
  content stream, so the old text can still be found by text extraction. Don't use whiteout for
  redaction.
- OCR has no font information, so edited scan text inherits the look by matching. Candidate fonts
  (Arial, Times, Courier and installed ones such as Verdana, Tahoma, Calibri, Georgia, Consolas)
  are rendered in regular and bold, with stretch or letter-spacing, and compared with the scanned
  glyphs. The best match sets family, weight, size, width and alignment in the cell. Text in
  non-standard fonts is saved as a ~300 dpi image with an invisible searchable copy. You can
  override the font in the Properties panel.
- Enhanced scan pages are saved as images (JPEG, or PNG for B&W).
- Password-protected PDFs can't be opened. For PDFs that are only permission-restricted, the
  download is built from page images.
- Fonts available for new text are Helvetica/Arial, Times and Courier.
# pdf-editer
