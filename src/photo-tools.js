// Photo Tools (update "phototools"): the parts of the page that don't need
// React or the server, so they can be tested on their own. The page is
// src/PhotoTools.jsx; the routes are in server/routes/photo-tools.js.

export const TOOLS = ["edit", "background", "upscale"];
// The most a photo may be when it's sent: the same 1.5 MiB as a composer
// image. Bigger photos are shrunk in the browser to fit.
export const IMAGE_LIMIT = 1.5 * 1024 * 1024;
// The most a photo may be before the browser tries to shrink it at all.
export const OPEN_LIMIT = 40 * 1024 * 1024;
export const PROMPT_MAX = 2000;
export const CHOICES = "photo-tools:choices";

export const TOOL_INFO = {
  edit: {
    label: "Edit with words",
    short: "Edit",
    icon: "sharpen",
    blurb: "Say what to change and the model redraws the photo.",
    action: "Edit the photo",
  },
  background: {
    label: "Remove background",
    short: "Cut out",
    icon: "eraser",
    blurb: "Keep the subject, drop the rest. The result is a transparent PNG.",
    action: "Remove the background",
  },
  upscale: {
    label: "Upscale",
    short: "Upscale",
    icon: "zoomin",
    blurb: "Make the photo larger and sharper. The model sets the new size.",
    action: "Upscale the photo",
  },
};

export const toolFrom = (value) => (TOOLS.includes(value) ? value : "edit");

// A price as shown: exact to the credit's four decimals, never rounded down
// to something under what is held.
export const price = (value) =>
  Number.isFinite(Number(value)) ? Number(value).toLocaleString("en-US", { maximumFractionDigits: 4 }) : "";

// A file name for a result: the photo's own name without its extension,
// then what was done, then the result's type.
export function resultName(original, tool, mime) {
  const stem =
    String(original || "photo")
      .replace(/\.[A-Za-z0-9]{1,5}$/, "")
      .replace(/[^\p{L}\p{N}._ -]+/gu, "")
      .trim()
      .slice(0, 60) || "photo";
  const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" }[mime] || "png";
  return `${stem}-${{ edit: "edited", background: "cutout", upscale: "upscaled" }[tool] || "result"}.${ext}`;
}

// The scale steps a shrink tries, largest first: begins at the size that
// should land just under the limit for a photo of this many bytes, then
// backs off by a fifth each time.
export function shrinkScales(bytes, limit = IMAGE_LIMIT, steps = 8) {
  if (!(bytes > limit)) return [1];
  const first = Math.min(1, Math.sqrt(limit / bytes) * 0.92);
  return Array.from({ length: steps }, (_, i) => Number((first * 0.8 ** i).toFixed(4)));
}

export class PhotoError extends Error {}

// A data URL's bytes as a Blob, without a network request (the page's
// connect-src doesn't take data: addresses).
export function dataUrlBlob(url) {
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(url));
  if (!m) throw new PhotoError("That picture couldn't be read.");
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: m[1] });
}

// A photo over the limit, redrawn smaller in this browser (which also drops
// its metadata). A PNG or WebP stays as it is so any transparency stays; a
// GIF becomes a PNG of its first frame; everything else is a JPEG. The
// original file never leaves the device either way.
export async function shrinkToFit(file, limit = IMAGE_LIMIT) {
  if (file.size <= limit) return file;
  if (file.size > OPEN_LIMIT) throw new PhotoError(`"${file.name}" is too large to open. Use a photo under 40 MiB.`);
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PhotoError(`"${file.name}" couldn't be opened in this browser.`);
  }
  try {
    const type = file.type === "image/webp" ? "image/webp" : file.type === "image/png" || file.type === "image/gif" ? "image/png" : "image/jpeg";
    for (const scale of shrinkScales(file.size, limit)) {
      const w = Math.max(1, Math.round(bitmap.width * scale)),
        h = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (type === "image/jpeg") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, w, h);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, 0, 0, w, h);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, 0.92));
      if (blob && blob.size <= limit) {
        const ext = { "image/png": "png", "image/webp": "webp", "image/jpeg": "jpg" }[blob.type] || "png";
        return new File([blob], file.name.replace(/\.[A-Za-z0-9]{1,5}$/, "") + "." + ext, { type: blob.type });
      }
    }
  } finally {
    bitmap.close?.();
  }
  throw new PhotoError(`"${file.name}" is too large to send even when shrunk. Use a smaller photo.`);
}

// What the "after" line says about size, from the two pictures' pixels.
export function sizeNote(before, after) {
  if (!before?.width || !after?.width) return "";
  const same = before.width === after.width && before.height === after.height;
  const dims = (d) => `${d.width.toLocaleString("en-US")} × ${d.height.toLocaleString("en-US")}`;
  return same ? dims(after) : `${dims(before)} → ${dims(after)}`;
}
