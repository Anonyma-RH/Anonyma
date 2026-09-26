// Redact Before You Send: the browser half. Decodes the attachment, paints
// it with the boxes applied (the editor's view and the output use the same
// painter), encodes the redacted copy from a canvas and runs it through
// Clean Uploads' strip step. The canvas never holds the original pixels
// under a box once painted, and encoding from it leaves every piece of the
// original file's metadata behind.
import {
  applyRedactions,
  clampBox,
  clampCrop,
  encodeAttempts,
  dataUrlType,
} from "./redact.js";
import { IMAGE_LIMIT } from "./clean-notes.js";

export class RedactError extends Error {}

export function dataUrlBytes(url) {
  const comma = String(url).indexOf(",");
  if (comma < 0 || !/;base64$/i.test(url.slice(0, comma))) throw new RedactError("This image can't be opened for redaction.");
  const binary = atob(url.slice(comma + 1));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
export function bytesDataUrl(bytes, type) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}

// An ImageBitmap of the attachment, upright (the browser applies any EXIF
// orientation while decoding). No object URL is made, so there's none to
// revoke; close() the bitmap when done.
export async function decodeSource(url) {
  const blob = new Blob([dataUrlBytes(url)], { type: dataUrlType(url) || "image/png" });
  try {
    try {
      return await createImageBitmap(blob, { imageOrientation: "from-image" });
    } catch {
      // Browsers without the option apply the orientation by default.
      return await createImageBitmap(blob);
    }
  } catch (e) {
    if (e instanceof RedactError) throw e;
    throw new RedactError("This image can't be opened for redaction.");
  }
}

export function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
function canvasBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new RedactError("The redacted image couldn't be made."))),
      type,
      quality,
    ),
  );
}

// Draws the image at full size with every box applied. Each box's pixels
// are read back and rewritten by applyRedactions, the tested function, so
// the view and the output can't differ.
export function paint(canvas, bitmap, boxes) {
  if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
  if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);
  for (const raw of boxes) {
    const box = clampBox(raw, bitmap.width, bitmap.height);
    if (!box) continue;
    const region = ctx.getImageData(box.x, box.y, box.w, box.h);
    applyRedactions(region, [{ x: 0, y: 0, w: box.w, h: box.h, style: box.style }]);
    ctx.putImageData(region, box.x, box.y);
  }
  return canvas;
}

// The redacted copy's bytes: painted, cropped, encoded, and scaled down
// only if it's over the attachment limit.
export async function encodeRedacted(bitmap, edit, sourceType, { maxBytes = IMAGE_LIMIT } = {}) {
  const full = paint(makeCanvas(bitmap.width, bitmap.height), bitmap, edit.boxes);
  const crop = clampCrop(edit.crop, bitmap.width, bitmap.height) || {
    x: 0,
    y: 0,
    w: bitmap.width,
    h: bitmap.height,
  };
  try {
    for (const attempt of encodeAttempts(sourceType)) {
      const w = Math.max(1, Math.round(crop.w * attempt.scale)),
        h = Math.max(1, Math.round(crop.h * attempt.scale));
      const out = makeCanvas(w, h);
      const ctx = out.getContext("2d");
      if (attempt.type === "image/jpeg") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(full, crop.x, crop.y, crop.w, crop.h, 0, 0, w, h);
      const blob = await canvasBlob(out, attempt.type, attempt.quality);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      release(out);
      if (bytes.length <= maxBytes)
        return { bytes, type: blob.type || attempt.type, width: w, height: h, scaled: attempt.scale < 1 };
    }
  } finally {
    release(full);
  }
  throw new RedactError("The redacted image is over 1.5 MiB. Crop it smaller, then apply again.");
}

// Frees a canvas's pixels now rather than whenever it's collected.
export function release(canvas) {
  try {
    canvas.width = 0;
    canvas.height = 0;
  } catch {
    // A detached or transferred canvas has nothing left to free.
  }
}

// Clean Uploads' strip step on the redacted copy. A canvas writes no
// camera, location or author details, so this is a check that normally
// changes nothing; anything it does find goes. It never redraws (a canvas
// output has no orientation to apply).
export async function finishRedacted(bytes) {
  const { cleanImage } = await import("./clean-uploads.js");
  const refuse = async () => {
    throw new RedactError("The redacted image couldn't be checked.");
  };
  try {
    const r = await cleanImage(bytes, { reencode: refuse, maxBytes: Infinity });
    return { bytes: r.bytes, type: r.type, details: r.details, status: r.details.length ? "cleaned" : "clean" };
  } catch {
    throw new RedactError("The redacted image couldn't be checked.");
  }
}

// Boxes around the text this browser can find, where it offers the Shape
// Detection API's TextDetector (feature-detected; hidden otherwise). Only
// the boxes are kept, never the text it read.
export const canFindText = () => typeof globalThis.TextDetector === "function";
export async function findText(bitmap, pad = 2) {
  const found = await new globalThis.TextDetector().detect(bitmap);
  return found
    .map((t) => t.boundingBox)
    .filter(Boolean)
    .map((b) => ({ x: b.x - pad, y: b.y - pad, w: b.width + pad * 2, h: b.height + pad * 2 }));
}
