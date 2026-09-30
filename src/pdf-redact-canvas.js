// Redact a PDF: the browser half. It opens the file with pdf.js (loaded the
// way Documents loads it, worker included, and only once a PDF is chosen),
// reads each page's text and where it sits, draws previews, and writes the
// redacted copy: every page drawn on a canvas, the boxes painted solid
// black there, and the pictures written into a new file by pdf-writer.js.
// Nothing from the original file is copied into the copy, and nothing here
// makes a network request: the file is read from memory, the worker is this
// site's own, and the output goes to a Blob.
import { loadPdfjs } from "./pdf-text.js";
import { applyRedactions } from "./redact.js";
import {
  CHAT_IMAGE_BYTES,
  PdfRedactError,
  abortError as aborted,
  indexPage,
  pageCapProblem,
  redactPages,
} from "./pdf-redact.js";

export { PdfRedactError };

const isAbort = (e) => e?.name === "AbortError";
export { isAbort };

// Lets go of an opened document and stops its worker (pdf.js keeps both on
// the loading task).
export const closePdf = (doc) => doc?.loadingTask?.destroy?.()?.catch?.(() => {});

function canvasBlob(canvas, type, quality) {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new PdfRedactError("A page couldn't be made into a picture."))), type, quality),
  );
}
function newCanvas(width, height) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
// Frees a canvas's pixels now rather than whenever it's collected.
export function freeCanvas(canvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // Nothing left to free.
  }
}

// ---- opening ----------------------------------------------------------------

// Opens a PDF from its bytes. `askPassword(reason)` (reason "needed" or
// "wrong") resolves the password the person typed, or null to give up; the
// password stays in this call and is never kept. Rejects with a
// PdfRedactError carrying a plain message.
export async function openPdf(data, { askPassword } = {}) {
  const pdfjs = await loadPdfjs();
  // The bytes are given to pdf.js's worker and can't be reused; that's what
  // we want: this array is the only copy of the file the page holds.
  const task = pdfjs.getDocument({ data, isEvalSupported: false, verbosity: 0 });
  let gaveUp = false;
  task.onPassword = async (update, reason) => {
    const wrong = reason === pdfjs.PasswordResponses?.INCORRECT_PASSWORD;
    const password = askPassword ? await askPassword(wrong ? "wrong" : "needed") : null;
    if (password == null) {
      gaveUp = true;
      task.destroy();
      return;
    }
    update(password);
  };
  try {
    const doc = await task.promise;
    const count = doc.numPages;
    const tooLong = pageCapProblem(count);
    if (tooLong) {
      await closePdf(doc);
      throw new PdfRedactError(tooLong);
    }
    return doc;
  } catch (e) {
    if (e instanceof PdfRedactError) throw e;
    if (gaveUp || e?.name === "PasswordException") throw new PdfRedactError("This PDF is password-protected. Enter its password to open it.");
    throw new PdfRedactError("This file can't be opened as a PDF.");
  }
}

// Every page's text and where it sits, and the pages' sizes in points as
// they're shown. Pages are read one at a time and released.
export async function readPages(doc, { onProgress, signal } = {}) {
  const pages = [],
    sizes = [];
  for (let n = 1; n <= doc.numPages; n++) {
    if (signal?.aborted) throw aborted();
    const page = await doc.getPage(n);
    const view = page.getViewport({ scale: 1 });
    const [content, annotations] = await Promise.all([page.getTextContent(), page.getAnnotations().catch(() => [])]);
    pages.push(
      indexPage({ content, annotations, transform: view.transform, width: view.width, height: view.height }),
    );
    sizes.push({ width: view.width, height: view.height });
    page.cleanup();
    onProgress?.(n / doc.numPages);
  }
  return { pages, sizes };
}

// How wide a run of text would be in its font, measured on a canvas: how
// pdf.js's own text layer places a match, and how a match inside a longer
// run is located. The PDF's own font is used where pdf.js has loaded it
// (the page has been drawn); otherwise the generic family it names.
export function makeMeasureFor() {
  let ctx = null;
  return (run) => {
    ctx ||= newCanvas(1, 1).getContext("2d");
    const own = /^[\w-]+$/.test(run.fontName || "") ? run.fontName : "";
    const font = `${Math.max(1, run.size || 10)}px ${own ? `"${own}", ` : ""}${run.family || "sans-serif"}, sans-serif`;
    const measure = (text) => {
      ctx.font = font;
      return ctx.measureText(text).width;
    };
    measure.exact = !!own && ownFontLoaded(own);
    return measure;
  };
}
// Whether pdf.js has loaded this PDF font into the page (it does once a
// page using it has been drawn): then a canvas measures in the real font.
function ownFontLoaded(name) {
  try {
    for (const face of document.fonts) if (face.family.replace(/^["']|["']$/g, "") === name && face.status === "loaded") return true;
  } catch {
    // No font set to ask.
  }
  return false;
}

// ---- previews ----------------------------------------------------------------

// Draws page `n` into a canvas for the editor, at `cssWidth` CSS pixels
// across, sharp on a high-density screen. Returns { done, cancel }.
export function renderPreview(doc, n, canvas, cssWidth, ratio = 1) {
  let task = null,
    cancelled = false;
  const done = (async () => {
    const page = await doc.getPage(n);
    try {
      if (cancelled) throw aborted();
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(3, Math.max(0.2, (cssWidth * Math.min(2, ratio)) / base.width));
      const view = page.getViewport({ scale });
      // Drawn off screen and copied over at once, so a redraw never shows
      // a half-finished page.
      const off = newCanvas(Math.max(1, Math.ceil(view.width)), Math.max(1, Math.ceil(view.height)));
      task = page.render({ canvas: off, viewport: view });
      await task.promise;
      if (cancelled) {
        freeCanvas(off);
        throw aborted();
      }
      canvas.width = off.width;
      canvas.height = off.height;
      canvas.getContext("2d").drawImage(off, 0, 0);
      freeCanvas(off);
    } catch (e) {
      if (e?.name === "RenderingCancelledException") throw aborted();
      throw e;
    } finally {
      page.cleanup();
    }
  })();
  return {
    done,
    cancel() {
      cancelled = true;
      task?.cancel();
    },
  };
}

// ---- the redacted copy ---------------------------------------------------------

// Fills the boxes on a page's canvas solid black, with Redact Before You
// Send's own pixel function on the pixels under each box.
export function paintBlack(canvas, rects) {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  for (const r of rects) {
    const region = ctx.getImageData(r.x, r.y, r.w, r.h);
    applyRedactions(region, [{ x: 0, y: 0, w: r.w, h: r.h, style: "black" }]);
    ctx.putImageData(region, r.x, r.y);
  }
}

// Writes the redacted copy of `pages` (page numbers) of an open document,
// with pdf-redact.js's redactPages: the canvas here is where each page is
// drawn and painted. `onProgress` gets { page, of }.
export function redactPdf({ doc, sizes, boxes, dpi, pages, onProgress, signal }) {
  const surface = {
    async draw(n, plan) {
      const page = await doc.getPage(n);
      const canvas = newCanvas(plan.width, plan.height);
      try {
        await page.render({ canvas, viewport: page.getViewport({ scale: plan.scale }) }).promise;
      } catch (e) {
        freeCanvas(canvas);
        throw e;
      } finally {
        page.cleanup();
      }
      return canvas;
    },
    black: paintBlack,
    async encode(canvas, quality) {
      const blob = await canvasBlob(canvas, "image/jpeg", quality);
      return new Uint8Array(await blob.arrayBuffer());
    },
    free: freeCanvas,
  };
  return redactPages({ sizes, boxes, dpi, pages, surface, onProgress, signal });
}

export const pdfBlob = (bytes) => new Blob([bytes], { type: "application/pdf" });

// ---- Send to chat --------------------------------------------------------------

// The redacted copy's own pages, drawn from the copy's bytes (never from the
// original, which the copy doesn't contain) as JPEG data URLs. `fit: "chat"`
// keeps each under the composer's image limit; `fit: "read"` draws larger,
// for reading the text on this device. Calls `each({ page, url })` per page.
export async function copyPagesAsImages(bytes, pageNumbers, { fit = "chat", onProgress, signal, each }) {
  const pdfjs = await loadPdfjs();
  // pdf.js takes its input, so give it a copy of the copy.
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  try {
    for (let k = 0; k < pageNumbers.length; k++) {
      if (signal?.aborted) throw aborted();
      onProgress?.({ page: k + 1, of: pageNumbers.length });
      const page = await doc.getPage(pageNumbers[k]);
      try {
        const base = page.getViewport({ scale: 1 });
        const steps = fit === "read" ? [{ long: 3000, q: 0.9 }] : [
          { long: 1800, q: 0.85 },
          { long: 1500, q: 0.8 },
          { long: 1200, q: 0.75 },
          { long: 1000, q: 0.7 },
          { long: 800, q: 0.6 },
          { long: 600, q: 0.5 },
        ];
        let url = null;
        for (const step of steps) {
          const scale = Math.min(4, step.long / Math.max(base.width, base.height));
          const view = page.getViewport({ scale });
          const canvas = newCanvas(Math.max(1, Math.ceil(view.width)), Math.max(1, Math.ceil(view.height)));
          try {
            await page.render({ canvas, viewport: view }).promise;
            const blob = await canvasBlob(canvas, "image/jpeg", step.q);
            if (fit === "read" || blob.size <= CHAT_IMAGE_BYTES) {
              url = await blobDataUrl(blob);
              break;
            }
          } finally {
            freeCanvas(canvas);
          }
        }
        if (!url) throw new PdfRedactError(`Page ${pageNumbers[k]} is too large to attach as a picture.`);
        await each({ page: pageNumbers[k], url });
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await closePdf(doc);
  }
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new PdfRedactError("A page couldn't be read."));
    reader.readAsDataURL(blob);
  });
}
