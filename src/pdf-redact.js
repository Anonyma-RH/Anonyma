// Redact a PDF: the pure half. Finding text on a page from pdf.js's text
// layer (search terms and Veil's detectors), turning each match into a box
// that covers it, the boxes' editing, the pixel rectangles the output paints
// black, page planning for memory, and the small helpers Send to chat uses.
// Nothing here touches the DOM, a canvas or the network, so it's tested in
// Node against the same pdf.js the page uses (tests/pdf-redact.test.mjs).
//
// Units. A page's boxes are in points, the PDF's own unit, measured on the
// page as it's shown (rotation applied) from its top-left corner, so a box
// means the same thing on the editor's preview and at 150, 200 or 300 dpi.
// Only the output turns them into pixels, and that rounds outward.
import {
  MAX_HISTORY,
  MIN_BOX,
  applyRedactions,
  clampBox,
  createHistory,
  hitTest,
  moveRect,
  rectFrom,
  redactedItem,
  redo,
  resizeRect,
  undo,
} from "./redact.js";
import { detectSensitive } from "./veil.js";
import { ocrDocument } from "./ocr.js";
import { PdfWriter } from "./pdf-writer.js";
import { checkImageOnlyPdf } from "./pdf-check.js";

export { createHistory, hitTest, redo, undo };

// ---- limits ---------------------------------------------------------------

export const MAX_PAGES = 200;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_BOXES = 5000;
export const MAX_TERMS = 40;
export const MAX_TERM_LENGTH = 200;
export const MAX_OUTPUT_BYTES = 600 * 1024 * 1024;
export const DPI_CHOICES = [150, 200, 300];
export const DEFAULT_DPI = 200;
export const JPEG_QUALITY = 0.92;
// One canvas at a time, and never a bigger one than the smallest browsers
// allow (Safari on iPhone stops at about 16.7 million pixels).
export const MAX_CANVAS_PIXELS = 16_777_216;
export const MAX_CANVAS_SIDE = 16_384;
// Send to chat: the composer takes eight images of up to 1.5 MiB; the text
// path reads a page in a few seconds on a device, so it's held to fewer.
export const CHAT_IMAGES = 8;
export const CHAT_OCR_PAGES = 20;
export const CHAT_IMAGE_BYTES = 1.5 * 1024 * 1024;

export class PdfRedactError extends Error {}
export const abortError = () => {
  const e = new Error("Cancelled.");
  e.name = "AbortError";
  return e;
};
// Why a document is too long, or null. One place, so the page and the
// tests agree on the cap.
export const pageCapProblem = (count) =>
  count > MAX_PAGES
    ? `This PDF has ${Number(count).toLocaleString("en-US")} pages. Redact a PDF takes up to ${MAX_PAGES}. Split it first, then redact each part.`
    : null;

// ---- the page's text, with where it is ----------------------------------

const DEFAULT_ASCENT = 0.95;
const DEFAULT_DESCENT = -0.25;

// The text layer's items as runs: where each starts, which way it runs and
// which way is up (unit vectors, in the PDF's own space), how wide and how
// tall, and how far it reaches above and below its baseline. `annotations`
// (pdf.js getAnnotations) add the text of form fields and notes, which the
// text layer doesn't hold but a page shows; each is one run for its whole
// rectangle.
export function textRuns(content, annotations = []) {
  const runs = [];
  for (const item of content?.items || []) {
    if (typeof item?.str !== "string") continue;
    const t = item.transform;
    if (!Array.isArray(t) || t.length < 6 || !t.slice(0, 6).every(Number.isFinite)) continue;
    const [a, b, c, d, e, f] = t;
    const along = Math.hypot(a, b),
      up = Math.hypot(c, d);
    const size = up || Math.abs(Number(item.height)) || 0;
    const style = content.styles?.[item.fontName] || {};
    runs.push({
      str: item.str,
      ox: e,
      oy: f,
      dx: along ? a / along : 1,
      dy: along ? b / along : 0,
      ux: up ? c / up : 0,
      uy: up ? d / up : 1,
      width: Math.max(0, Number(item.width) || 0),
      size,
      asc: style.ascent > 0 ? Math.min(style.ascent, 1.3) : DEFAULT_ASCENT,
      desc: style.descent < 0 ? Math.max(style.descent, -0.6) : DEFAULT_DESCENT,
      eol: !!item.hasEOL,
      // pdf.js loads a page's fonts under this name once the page is drawn, so
      // a canvas can measure with the PDF's own font where it's loaded.
      fontName: typeof item.fontName === "string" ? item.fontName : "",
      family: typeof style.fontFamily === "string" && style.fontFamily ? style.fontFamily : "sans-serif",
    });
  }
  for (const note of annotations || []) {
    const box = note?.rect;
    if (!Array.isArray(box) || box.length < 4 || !box.every(Number.isFinite)) continue;
    if (note.fieldType === "Btn") continue;
    const parts = [];
    const push = (v) => {
      if (Array.isArray(v)) v.forEach(push);
      else if (typeof v === "string" && v.trim()) parts.push(v.trim());
    };
    push(note.fieldValue);
    push(note.contentsObj?.str);
    push(note.contents);
    const str = [...new Set(parts)].join(" ");
    if (!str) continue;
    runs.push({
      whole: true,
      str,
      box: [Math.min(box[0], box[2]), Math.min(box[1], box[3]), Math.max(box[0], box[2]), Math.max(box[1], box[3])],
      size: 0,
      eol: true,
    });
  }
  return runs;
}

// Between two runs: nothing when they read as one word, a space when they're
// apart on a line, a line break when they're on different lines.
function between(prev, run) {
  if (prev.whole || run.whole) return "\n";
  if (/\s$/.test(prev.str) || /^\s/.test(run.str)) return "";
  const rx = run.ox - prev.ox,
    ry = run.oy - prev.oy;
  const gap = rx * prev.dx + ry * prev.dy - prev.width;
  const across = rx * prev.ux + ry * prev.uy;
  const size = prev.size || run.size || 10;
  if (Math.abs(across) > 0.6 * size) return "\n";
  return gap > 0.12 * size ? " " : "";
}

// One page's searchable text and where each stretch of it sits. `transform`
// is pdf.js's viewport.transform at scale 1 (rotation included); `width`
// and `height` are the page's size in points as shown.
export function indexPage({ content, annotations = [], transform, width, height }) {
  const runs = textRuns(content, annotations);
  let text = "";
  const spans = [];
  let last = null,
    breakNext = false;
  for (const run of runs) {
    if (!run.str) {
      if (run.eol) breakNext = true;
      continue;
    }
    if (last) text += breakNext ? "\n" : between(last, run);
    spans.push({ start: text.length, end: text.length + run.str.length, run });
    text += run.str;
    last = run;
    breakNext = !!run.eol;
  }
  return { text, spans, transform: transform || [1, 0, 0, -1, 0, height || 0], width: width || 0, height: height || 0 };
}
export const hasText = (index) => !!index && /\S/.test(index.text);

// ---- finding ---------------------------------------------------------------

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A search term as a regular expression: what's typed is matched as text,
// not as a pattern; any run of spaces or line breaks in it matches any run
// of white space on the page. Null for an empty term.
export function compileTerm(term, { matchCase = false, whole = false } = {}) {
  const t = String(term ?? "").trim().slice(0, MAX_TERM_LENGTH);
  if (!t) return null;
  let source = t.split(/\s+/).map(escapeRegExp).join("\\s+");
  if (whole) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  return new RegExp(source, "gu" + (matchCase ? "" : "i"));
}
// Every match of a term on a page: [{ start, end }] in the page's text.
export function findTerm(index, term, options) {
  const re = compileTerm(term, options);
  if (!re || !index?.text) return [];
  const out = [];
  let m;
  while ((m = re.exec(index.text))) {
    if (m[0].length) out.push({ start: m.index, end: m.index + m[0].length });
    else re.lastIndex++;
  }
  return out;
}

// The detectors one tap turns on: Veil's, reused as they are. Veil finds
// no names of its own; the only names it knows are the person's own
// "always veil" words, offered when there are some.
export const DETECTORS = [
  { id: "email", label: "Email addresses", types: ["EMAIL"] },
  { id: "phone", label: "Phone numbers", types: ["PHONE"] },
  { id: "card", label: "Card numbers", types: ["CARD"] },
  { id: "iban", label: "IBANs", types: ["IBAN"] },
  { id: "wallet", label: "Wallet addresses", types: ["WALLET"] },
  { id: "key", label: "Keys and secrets", types: ["KEY"] },
  { id: "ip", label: "IP addresses", types: ["IP"] },
  { id: "words", label: "Your Veil words", types: ["PRIVATE"] },
];
export const detectorTypes = (id) => DETECTORS.find((d) => d.id === id)?.types || [];

// Veil's matches on one page: [{ start, end, type }]. Line breaks are
// hidden from the detectors, so a run of digits in a table's next row can't
// join the row above into a "phone number".
export function detectPage(index, words = []) {
  if (!index?.text) return [];
  return detectSensitive(index.text.replace(/\n/g, "\u0001"), words).map(({ start, end, type }) => ({ start, end, type }));
}

// ---- boxes around matches --------------------------------------------------

const apply = (t, x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
function bounds(points) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const [x, y] of points) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x);
    y1 = Math.max(y1, y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
// Where each character boundary of a run falls, as a fraction of its width.
// `measure(text)` gives the width text would have in a font (the text
// layer's own trick: the run's font, measured on a canvas, scaled to the
// width the PDF says); without it the characters are taken as equal. A
// measure whose `exact` is true was made in the PDF's own font.
function fractions(run, measure) {
  const n = run.str.length;
  if (typeof measure === "function" && n > 1) {
    try {
      const total = measure(run.str);
      if (total > 0 && Number.isFinite(total)) {
        const out = new Array(n + 1);
        out[0] = 0;
        out[n] = 1;
        for (let i = 1; i < n; i++) out[i] = Math.min(1, Math.max(out[i - 1], measure(run.str.slice(0, i)) / total));
        return { at: out, measured: true };
      }
    } catch {
      // Fall through to equal widths.
    }
  }
  return { at: Array.from({ length: n + 1 }, (_, i) => i / (n || 1)), measured: false };
}
// The rectangle, in points on the shown page, that covers characters
// [from, to) of a run. It's padded all round, and a partial run gets a
// little extra along the line because a character's place inside a run is
// measured, not read from the file. Covering too much is the safe side.
function runRect(run, from, to, vt, { measureFor, pad }) {
  const p = Math.max(pad, (run.size || 0) * 0.06);
  if (run.whole) {
    const [x0, y0, x1, y1] = run.box;
    return bounds([
      apply(vt, x0 - p, y0 - p),
      apply(vt, x1 + p, y0 - p),
      apply(vt, x1 + p, y1 + p),
      apply(vt, x0 - p, y1 + p),
    ]);
  }
  const n = run.str.length;
  const measure = measureFor?.(run) || null;
  const { at: f, measured } = fractions(run, measure);
  // How sure the place of a character inside the run is decides how far a
  // partial match reaches past its ends: measured in the PDF's own font
  // (`measure.exact`), measured in a stand-in font, or only guessed from
  // equal widths. Covering more than the word is the safe side, and a page
  // is shown with its boxes over it, so anything left showing can be seen.
  const partial = from > 0 || to < n;
  const reach = !measured ? [2, 12, 0.05] : measure.exact ? [0.5, 2, 0.008] : [1, 6, 0.02];
  const slack = partial ? Math.min(reach[1], Math.max(reach[0], run.width * reach[2])) : 0;
  const s0 = f[from] * run.width - p - (from > 0 ? slack : 0);
  const s1 = f[to] * run.width + p + (to < n ? slack : 0);
  const v0 = run.desc * run.size - p,
    v1 = run.asc * run.size + p;
  const at = (s, v) => apply(vt, run.ox + run.dx * s + run.ux * v, run.oy + run.dy * s + run.uy * v);
  return bounds([at(s0, v0), at(s1, v0), at(s1, v1), at(s0, v1)]);
}
// Rectangles on one line that touch or overlap become one.
export function mergeRects(rects, gap = 3) {
  const list = rects.map((r) => ({ ...r })).sort((a, b) => a.y - b.y || a.x - b.x);
  const out = [];
  for (const r of list) {
    const hit = out.find((o) => {
      const overlap = Math.min(o.y + o.h, r.y + r.h) - Math.max(o.y, r.y);
      return overlap > 0.5 * Math.min(o.h, r.h) && r.x <= o.x + o.w + gap && o.x <= r.x + r.w + gap;
    });
    if (!hit) out.push(r);
    else {
      const x0 = Math.min(hit.x, r.x),
        y0 = Math.min(hit.y, r.y),
        x1 = Math.max(hit.x + hit.w, r.x + r.w),
        y1 = Math.max(hit.y + hit.h, r.y + r.h);
      Object.assign(hit, { x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    }
  }
  return out;
}
// The rectangles covering characters [start, end) of a page's text.
export function matchRects(index, start, end, { measureFor = null, pad = 1 } = {}) {
  const rects = [];
  for (const span of index.spans) {
    if (span.end <= start) continue;
    if (span.start >= end) break;
    rects.push(
      runRect(span.run, Math.max(start, span.start) - span.start, Math.min(end, span.end) - span.start, index.transform, {
        measureFor,
        pad,
      }),
    );
  }
  return mergeRects(rects.filter((r) => Number.isFinite(r.x + r.y + r.w + r.h) && r.w > 0 && r.h > 0));
}
// What a page's text says at those characters, for the list of matches:
// a little around it, on one line.
export function snippet(index, start, end, around = 24) {
  const flat = (s) => s.replace(/\s+/g, " ");
  return {
    before: flat(index.text.slice(Math.max(0, start - around), start)).trim(),
    match: flat(index.text.slice(start, end)),
    after: flat(index.text.slice(end, end + around)).trim(),
  };
}

// ---- boxes and their editing ------------------------------------------------

export const blankEdit = () => ({ boxes: [] });
// A box: { page (from 1), x, y, w, h (points from the shown page's
// top-left), source }. `source` says why it's there: "manual", "term:…"
// or "detector:…", so turning a find off takes its boxes away and nothing
// else.
export const termSource = (term, { matchCase = false, whole = false } = {}) =>
  `term:${matchCase ? "c" : "i"}${whole ? "w" : "-"}:${matchCase ? String(term).trim() : String(term).trim().toLowerCase()}`;
export const detectorSource = (id) => `detector:${id}`;
export const termOf = (source) => /^term:[ci][w-]:([\s\S]*)$/.exec(source)?.[1] ?? null;

const contains = (o, r, eps = 0.5) =>
  r.x >= o.x - eps && r.y >= o.y - eps && r.x + r.w <= o.x + o.w + eps && r.y + r.h <= o.y + o.h + eps;
// Whether a box lies entirely inside another.
export const boxCovers = contains;

export function sameBoxes(a, b) {
  if (a === b) return true;
  return (
    a.boxes.length === b.boxes.length &&
    a.boxes.every((x, i) => {
      const y = b.boxes[i];
      return x.page === y.page && x.x === y.x && x.y === y.y && x.w === y.w && x.h === y.h && x.source === y.source;
    })
  );
}
// Undo and redo, as Redact Before You Send has them: whole edits.
export function commitEdit(history, next) {
  if (sameBoxes(history.present, next)) return history;
  return { past: [...history.past, history.present].slice(-MAX_HISTORY), present: next, future: [] };
}
export const boxesOnPage = (edit, page) => edit.boxes.filter((b) => b.page === page);
export const boxCount = (edit) => edit.boxes.length;
export const pagesWithBoxes = (edit) => new Set(edit.boxes.map((b) => b.page)).size;

// Adds boxes (dropping any already inside a box on the same page, and
// stopping at the limit). Returns { edit, added, skipped }.
export function addBoxes(edit, list) {
  const boxes = [...edit.boxes];
  let added = 0,
    skipped = 0;
  for (const b of list) {
    if (!(b.w > 0 && b.h > 0) || !Number.isFinite(b.x + b.y + b.w + b.h)) continue;
    if (boxes.length >= MAX_BOXES) {
      skipped++;
      continue;
    }
    if (boxes.some((o) => o.page === b.page && contains(o, b))) {
      skipped++;
      continue;
    }
    boxes.push({ page: b.page, x: b.x, y: b.y, w: b.w, h: b.h, source: b.source || "manual" });
    added++;
  }
  return { edit: added ? { ...edit, boxes } : edit, added, skipped };
}
export const removeSource = (edit, source) => ({ ...edit, boxes: edit.boxes.filter((b) => b.source !== source) });
export const removeBoxAt = (edit, index) => ({ ...edit, boxes: edit.boxes.filter((_, i) => i !== index) });
export const clearBoxes = () => blankEdit();
export function countBySource(edit, source) {
  let n = 0;
  for (const b of edit.boxes) if (b.source === source) n++;
  return n;
}
// A box drawn by hand, from two corners on a page of the given size.
export function addManualBox(edit, page, a, b, width, height) {
  if (edit.boxes.length >= MAX_BOXES) return null;
  const r = rectFrom(a, b);
  if (r.w < MIN_BOX || r.h < MIN_BOX) return null;
  const box = clampBox({ ...r, style: "black" }, width, height);
  return box ? { ...edit, boxes: [...edit.boxes, { page, x: box.x, y: box.y, w: box.w, h: box.h, source: "manual" }] } : null;
}
// Moving and resizing reuse Redact Before You Send's geometry; a box keeps
// its page and its reason.
export function moveBox(edit, index, dx, dy, width, height) {
  const b = edit.boxes[index];
  if (!b) return edit;
  const m = moveRect(b, dx, dy, width, height);
  return { ...edit, boxes: edit.boxes.map((x, i) => (i === index ? { ...x, x: m.x, y: m.y } : x)) };
}
export function resizeBox(edit, index, handle, point, width, height) {
  const b = edit.boxes[index];
  if (!b) return edit;
  const r = resizeRect({ x: b.x, y: b.y, w: b.w, h: b.h }, handle, point, width, height);
  return { ...edit, boxes: edit.boxes.map((x, i) => (i === index ? { ...x, x: r.x, y: r.y, w: r.w, h: r.h, source: "manual" } : x)) };
}
// The topmost box on a page under a point, and which part of it.
export function hitBox(edit, page, point, tolerance) {
  const own = [];
  edit.boxes.forEach((b, i) => {
    if (b.page === page) own.push({ b, i });
  });
  const hit = hitTest(
    own.map((o) => o.b),
    point,
    tolerance,
  );
  return hit ? { index: own[hit.index].i, handle: hit.handle } : null;
}

// ---- the output --------------------------------------------------------------

// The size a page is rendered at for the chosen quality: dpi / 72 pixels
// to the point, held down for a very large page so no canvas is bigger than
// a browser allows. `limited` says it was.
export function planPage(widthPt, heightPt, dpi) {
  let scale = dpi / 72;
  let width = Math.round(widthPt * scale),
    height = Math.round(heightPt * scale);
  let limited = false;
  if (width * height > MAX_CANVAS_PIXELS || width > MAX_CANVAS_SIDE || height > MAX_CANVAS_SIDE) {
    const k = Math.min(Math.sqrt(MAX_CANVAS_PIXELS / (width * height)), MAX_CANVAS_SIDE / Math.max(width, height)) * 0.999;
    scale *= k;
    width = Math.max(1, Math.round(widthPt * scale));
    height = Math.max(1, Math.round(heightPt * scale));
    limited = true;
  }
  return { scale, width: Math.max(1, width), height: Math.max(1, height), dpi: Math.round(scale * 72), limited };
}
// A page's boxes as pixel rectangles at that scale. Edges round outward and
// each box gains a pixel all round, so a partly covered pixel is covered.
export function pixelRects(boxes, scale, width, height, margin = 1) {
  const out = [];
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x * scale) - margin),
      y0 = Math.max(0, Math.floor(b.y * scale) - margin),
      x1 = Math.min(width, Math.ceil((b.x + b.w) * scale) + margin),
      y1 = Math.min(height, Math.ceil((b.y + b.h) * scale) + margin);
    if (x1 > x0 && y1 > y0) out.push({ x: x0, y: y0, w: x1 - x0, h: y1 - y0, style: "black" });
  }
  return out;
}
// Fills every rectangle solid black in RGBA pixels ({ data, width, height }),
// with Redact Before You Send's own tested function. Returns the rectangles
// as applied.
export const blacken = (image, rects) => applyRedactions(image, rects.map((r) => ({ ...r, style: "black" })));

// Writes the redacted copy: for each page, one at a time, a picture drawn
// at the chosen quality, painted solid black under that page's boxes and
// added to a new file, then the finished file read back and checked
// (pdf-check.js). `surface` is where the pictures are made, so this same
// code runs on a browser canvas and in Node (tests):
//   draw(n, plan)   -> a handle: page n drawn on white, plan.width by plan.height
//   black(h, rects) -> paint those pixel rectangles opaque black
//   encode(h, q)    -> the picture's JPEG bytes
//   free(h)         -> let go of it
// Only one handle is alive at a time. Resolves { bytes, pages, limited,
// check }; nothing of the original file is passed to the writer.
export async function redactPages({ sizes, boxes, dpi, pages, surface, onProgress, signal, maxBytes = MAX_OUTPUT_BYTES }) {
  const cap = pageCapProblem(pages.length);
  if (cap) throw new PdfRedactError(cap);
  if (!pages.length) throw new PdfRedactError("There are no pages to copy.");
  const writer = new PdfWriter();
  let limited = 0;
  for (let k = 0; k < pages.length; k++) {
    if (signal?.aborted) throw abortError();
    const n = pages[k];
    const size = sizes[n - 1];
    if (!size) throw new PdfRedactError(`Page ${n} isn't in this PDF.`);
    onProgress?.({ page: k + 1, of: pages.length });
    const plan = planPage(size.width, size.height, dpi);
    if (plan.limited) limited++;
    const handle = await surface.draw(n, plan);
    try {
      surface.black(
        handle,
        pixelRects(
          boxes.filter((b) => b.page === n),
          plan.scale,
          plan.width,
          plan.height,
        ),
      );
      const jpeg = await surface.encode(handle, JPEG_QUALITY);
      writer.addPage({ width: size.width, height: size.height, image: { kind: "jpeg", data: jpeg } });
      if (writer.length > maxBytes)
        throw new PdfRedactError("The copy is getting too large. Choose a lower quality, or redact fewer pages.");
    } finally {
      surface.free(handle);
    }
  }
  const { parts, length } = writer.finish();
  const bytes = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    bytes.set(part, at);
    at += part.length;
  }
  return { bytes, pages: pages.length, limited, check: checkImageOnlyPdf(bytes) };
}

// "redacted-report.pdf" from "report.pdf": no path, nothing but the name
// the person chose to keep.
export function redactedName(name) {
  const base = String(name || "document")
    .replace(/^.*[\\/]/, "")
    .replace(/\.pdf$/i, "")
    .replace(/[\u0000-\u001f<>:"|?*]/g, "")
    .trim()
    .slice(0, 100);
  return `${base || "document"}-redacted.pdf`;
}
export function downloadName(name) {
  const base = String(name || "")
    .replace(/^.*[\\/]/, "")
    .replace(/\.pdf$/i, "")
    .replace(/[\u0000-\u001f<>:"|?*\\/]/g, "")
    .trim()
    .slice(0, 100);
  return (base || "redacted") + ".pdf";
}

// "1-3, 7" as page numbers: [1, 2, 3, 7]. Blank means every page. Null for
// anything that isn't a page in the document.
export function parsePageRange(text, count) {
  const t = String(text ?? "").trim();
  if (!t || /^all$/i.test(t)) return Array.from({ length: count }, (_, i) => i + 1);
  const out = new Set();
  for (const part of t.split(/\s*,\s*/)) {
    const m = /^(\d+)(?:\s*[-–]\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]),
      b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b < a || b > count) return null;
    for (let p = a; p <= b; p++) out.add(p);
  }
  return [...out].sort((x, y) => x - y);
}
export function rangeText(pages) {
  const runs = [];
  for (const p of pages) {
    const last = runs.at(-1);
    if (last && p === last[1] + 1) last[1] = p;
    else runs.push([p, p]);
  }
  return runs.map(([a, b]) => (a === b ? String(a) : `${a}-${b}`)).join(", ");
}

// ---- Send to chat ------------------------------------------------------------

// A composer image chip for a page of the redacted copy: the same shape
// Redact Before You Send leaves, with nothing of an original in it.
export const chatImageItem = (name, url) => redactedItem({ name }, url, { status: "clean", details: [] });
// The redacted pages' text as one Documents attachment marked as read from
// an image (Local OCR's own shape).
export function chatTextDocument({ name, pages, id }) {
  const body = pages
    .filter((p) => p.text.trim())
    .map((p) => `[Page ${p.page}]\n${p.text.trim()}`)
    .join("\n\n");
  return ocrDocument({ name }, body, id);
}
