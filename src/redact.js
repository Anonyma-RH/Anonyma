// Redact Before You Send: the editor's pure half. Boxes, crop, history,
// zoom and the pixel work itself run on plain numbers and RGBA arrays, so
// they're the same in the browser and in Node (tests). ImageRedact.jsx
// draws and encodes with a canvas; it calls applyRedactions on the canvas's
// own pixels, so what the editor shows is exactly what gets sent.
//
// Two styles only. Black replaces every pixel in the box. Pixelate replaces
// each large block with its average colour. There's no blur: a light blur
// can be undone, and text under pixelation can sometimes be guessed, which
// is why the editor says to use Black for text.

export const STYLES = ["black", "pixelate"];
export const DEFAULT_STYLE = "black";
// A drag shorter than this (in image pixels) is a click, not a box.
export const MIN_BOX = 3;
// Pixelate: at most this many blocks across the box's shorter side, and
// blocks never smaller than MIN_BLOCK pixels.
export const BLOCKS_ACROSS = 5;
export const MIN_BLOCK = 12;
export const MAX_BOXES = 200;
export const MAX_HISTORY = 100;
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

const finite = (...n) => n.every((v) => typeof v === "number" && Number.isFinite(v));

// The rectangle between two points, whichever way it was dragged.
export function rectFrom(a, b) {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(b.x - a.x),
    h: Math.abs(b.y - a.y),
  };
}

// A box on whole pixels inside the image, or null when nothing is left.
// Edges round outward, so a pixel the box only partly covers is covered.
export function clampBox(box, width, height) {
  if (!box || !finite(box.x, box.y, box.w, box.h, width, height)) return null;
  const x0 = Math.max(0, Math.floor(Math.min(box.x, box.x + box.w)));
  const y0 = Math.max(0, Math.floor(Math.min(box.y, box.y + box.h)));
  const x1 = Math.min(width, Math.ceil(Math.max(box.x, box.x + box.w)));
  const y1 = Math.min(height, Math.ceil(Math.max(box.y, box.y + box.h)));
  if (x1 <= x0 || y1 <= y0) return null;
  const style = STYLES.includes(box.style) ? box.style : DEFAULT_STYLE;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, style };
}

// The crop, clamped like a box; null means the whole image.
export function clampCrop(crop, width, height) {
  const c = clampBox(crop, width, height);
  if (!c || (c.x === 0 && c.y === 0 && c.w === width && c.h === height)) return null;
  return { x: c.x, y: c.y, w: c.w, h: c.h };
}

// Pixelate's block size for a box: large enough that a face becomes a few
// squares of colour.
export function pixelBlock(box) {
  return Math.max(MIN_BLOCK, Math.ceil(Math.min(box.w, box.h) / BLOCKS_ACROSS));
}

// Every pixel in the box becomes opaque black.
export function applyBlack(data, width, box) {
  for (let y = box.y; y < box.y + box.h; y++) {
    let p = (y * width + box.x) * 4;
    for (let x = 0; x < box.w; x++, p += 4) {
      data[p] = 0;
      data[p + 1] = 0;
      data[p + 2] = 0;
      data[p + 3] = 255;
    }
  }
}

// Each block (from the box's top-left corner, cut at the box's edges)
// becomes the average of its own pixels. Nothing outside the box is read.
export function applyPixelate(data, width, box, block = pixelBlock(box)) {
  const size = Math.max(1, Math.floor(block));
  for (let by = box.y; by < box.y + box.h; by += size) {
    const bh = Math.min(size, box.y + box.h - by);
    for (let bx = box.x; bx < box.x + box.w; bx += size) {
      const bw = Math.min(size, box.x + box.w - bx);
      let r = 0,
        g = 0,
        b = 0,
        a = 0;
      for (let y = by; y < by + bh; y++) {
        let p = (y * width + bx) * 4;
        for (let x = 0; x < bw; x++, p += 4) {
          r += data[p];
          g += data[p + 1];
          b += data[p + 2];
          a += data[p + 3];
        }
      }
      const n = bw * bh;
      r = Math.round(r / n);
      g = Math.round(g / n);
      b = Math.round(b / n);
      a = Math.round(a / n);
      for (let y = by; y < by + bh; y++) {
        let p = (y * width + bx) * 4;
        for (let x = 0; x < bw; x++, p += 4) {
          data[p] = r;
          data[p + 1] = g;
          data[p + 2] = b;
          data[p + 3] = a;
        }
      }
    }
  }
}

// Applies every box, in order, to RGBA pixels ({ data, width, height }, the
// shape of a canvas ImageData). Returns the boxes as applied.
export function applyRedactions(image, boxes) {
  const applied = [];
  for (const raw of boxes || []) {
    const box = clampBox(raw, image.width, image.height);
    if (!box) continue;
    if (box.style === "pixelate") applyPixelate(image.data, image.width, box);
    else applyBlack(image.data, image.width, box);
    applied.push(box);
  }
  return applied;
}

// ---- editing ----

// An empty edit: no boxes, the whole image.
export const blankEdit = () => ({ boxes: [], crop: null });

export function sameEdit(a, b) {
  if (a === b) return true;
  const rect = (r, s) =>
    (!r && !s) || (!!r && !!s && r.x === s.x && r.y === s.y && r.w === s.w && r.h === s.h && r.style === s.style);
  return (
    a.boxes.length === b.boxes.length &&
    a.boxes.every((box, i) => rect(box, b.boxes[i])) &&
    rect(a.crop, b.crop)
  );
}

// Undo and redo over whole edits ({ boxes, crop }).
export const createHistory = (present = blankEdit()) => ({ past: [], present, future: [] });
export function commit(history, next) {
  if (sameEdit(history.present, next)) return history;
  return {
    past: [...history.past, history.present].slice(-MAX_HISTORY),
    present: next,
    future: [],
  };
}
export function undo(history) {
  if (!history.past.length) return history;
  return {
    past: history.past.slice(0, -1),
    present: history.past.at(-1),
    future: [history.present, ...history.future],
  };
}
export function redo(history) {
  if (!history.future.length) return history;
  return {
    past: [...history.past, history.present],
    present: history.future[0],
    future: history.future.slice(1),
  };
}

// A new box from a drag, or null for a click or when the limit is reached.
export function addBox(edit, a, b, style, width, height) {
  if (edit.boxes.length >= MAX_BOXES) return null;
  const r = rectFrom(a, b);
  if (r.w < MIN_BOX || r.h < MIN_BOX) return null;
  const box = clampBox({ ...r, style }, width, height);
  return box ? { ...edit, boxes: [...edit.boxes, box] } : null;
}
export const removeBox = (edit, index) => ({
  ...edit,
  boxes: edit.boxes.filter((_, i) => i !== index),
});
export const styleBox = (edit, index, style) => ({
  ...edit,
  boxes: edit.boxes.map((b, i) => (i === index ? { ...b, style } : b)),
});
export const replaceBox = (edit, index, box) => ({
  ...edit,
  boxes: edit.boxes.map((b, i) => (i === index ? box : b)),
});

// Which box (topmost first) and which part of it a point is on: a corner
// handle ("nw", "ne", "sw", "se") or its body ("move"). `tolerance` is in
// image pixels (the handle's screen size divided by the zoom).
export function hitTest(rects, point, tolerance) {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    const corners = {
      nw: [r.x, r.y],
      ne: [r.x + r.w, r.y],
      sw: [r.x, r.y + r.h],
      se: [r.x + r.w, r.y + r.h],
    };
    for (const [handle, [cx, cy]] of Object.entries(corners))
      if (Math.abs(point.x - cx) <= tolerance && Math.abs(point.y - cy) <= tolerance)
        return { index: i, handle };
    if (point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h)
      return { index: i, handle: "move" };
  }
  return null;
}

const OPPOSITE = { nw: "se", ne: "sw", sw: "ne", se: "nw" };
const corner = (r, handle) => ({
  x: handle.endsWith("w") ? r.x : r.x + r.w,
  y: handle.startsWith("n") ? r.y : r.y + r.h,
});
// Drags one corner; the opposite corner stays put.
export function resizeRect(rect, handle, point, width, height) {
  const fixed = corner(rect, OPPOSITE[handle]);
  const r = rectFrom(fixed, point);
  const box = clampBox({ ...r, style: rect.style }, width, height);
  if (!box || box.w < MIN_BOX || box.h < MIN_BOX) return rect;
  return rect.style === undefined ? { x: box.x, y: box.y, w: box.w, h: box.h } : box;
}
// Moves a rectangle by whole pixels, kept inside the image.
export function moveRect(rect, dx, dy, width, height) {
  const x = Math.min(Math.max(0, Math.round(rect.x + dx)), Math.max(0, width - rect.w));
  const y = Math.min(Math.max(0, Math.round(rect.y + dy)), Math.max(0, height - rect.h));
  return { ...rect, x, y };
}

// ---- zoom and pan ----
// A view is { scale, x, y }: an image pixel (px, py) is drawn at
// (x + px * scale, y + py * scale) in the stage.

export function fitView(width, height, stageWidth, stageHeight, pad = 24) {
  const scale = Math.min(
    3,
    Math.max(MIN_ZOOM, Math.min((stageWidth - pad * 2) / width, (stageHeight - pad * 2) / height)),
  );
  return {
    scale,
    x: (stageWidth - width * scale) / 2,
    y: (stageHeight - height * scale) / 2,
  };
}
// Zooms by `factor` keeping the stage point (px, py) still.
export function zoomAt(view, factor, px, py) {
  const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.scale * factor));
  const k = scale / view.scale;
  return { scale, x: px - (px - view.x) * k, y: py - (py - view.y) * k };
}
export const toImage = (view, px, py) => ({
  x: (px - view.x) / view.scale,
  y: (py - view.y) / view.scale,
});

// ---- output ----

// What the redacted copy is saved as: JPEG stays JPEG (a photo), anything
// else becomes PNG (screenshots keep sharp text). When the result is over
// the size limit the next attempt is tried: JPEG, then JPEG a little
// smaller, each step 15% fewer pixels across.
export function encodeAttempts(sourceType) {
  const first = sourceType === "image/jpeg"
    ? { type: "image/jpeg", quality: 0.92, scale: 1 }
    : { type: "image/png", quality: undefined, scale: 1 };
  const out = [first];
  if (first.type === "image/png") out.push({ type: "image/jpeg", quality: 0.92, scale: 1 });
  out.push({ type: "image/jpeg", quality: 0.85, scale: 1 });
  for (let i = 1, scale = 1; i <= 8; i++) {
    scale = Math.round(scale * 0.85 * 1000) / 1000;
    out.push({ type: "image/jpeg", quality: 0.85, scale });
  }
  return out;
}

// The composer attachment after Apply: only the redacted copy is left.
// The original (and Clean Uploads' Keep original copy of it) is dropped, so
// nothing can send it any more. Clean Uploads' note still describes what
// was removed; a file it couldn't clean was redrawn here, so it now reads
// as clean.
export function redactedItem(item, url, clean) {
  const next = {
    name: item.name,
    url,
    cleanUrl: url,
    originalUrl: null,
    keep: false,
    redacted: true,
  };
  if (item.clean || clean) {
    const kept = item.clean && item.clean.status !== "failed" ? item.clean : null;
    next.clean = kept ? { ...kept } : { status: clean?.status === "cleaned" ? "cleaned" : "clean", details: clean?.details || [] };
  }
  return next;
}

// The image an editor opens on: what Send would use, or, for an image
// Clean Uploads is holding back, its original (the redacted copy is
// redrawn, so its hidden details go too).
export const editorSource = (item) => item?.url || item?.originalUrl || null;

// "image/png" from "data:image/png;base64,...".
export function dataUrlType(url) {
  const m = /^data:([^;,]+)[;,]/.exec(String(url || ""));
  return m ? m[1].toLowerCase() : "";
}
