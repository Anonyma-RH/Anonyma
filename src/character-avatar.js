// A character's picture, made in the browser: the file is cleaned of hidden
// details (Clean Uploads: location, camera, author, dates), cut to a centred
// square, redrawn at 256 px or less on a canvas and encoded small. A canvas
// redraw carries nothing over from the original file, so what is saved is
// the pixels and nothing else; the server checks it again
// (server/character-avatar.js). Nothing is uploaded until the character is
// saved.
//
// The bytes-in, bytes-out steps take their canvas work as arguments so they
// run in Node (tests); `browserDraw` is the browser's own.
import { cleanImage, imageKind } from "./clean-uploads.js";
import { AVATAR_SIZE, MAX_AVATAR_BYTES } from "./characters.js";

// A file this large isn't a picture to keep as a face.
export const MAX_PICTURE_BYTES = 12 * 1024 * 1024;
// The centred square of a width x height picture.
export function cropRect(width, height) {
  const side = Math.min(width, height);
  return { sx: Math.floor((width - side) / 2), sy: Math.floor((height - side) / 2), side };
}
// The size drawn: the square's own size when it's small, never more than
// AVATAR_SIZE, and smaller again when the encoded picture is over the cap.
export const drawSizes = (side) => {
  const first = Math.min(AVATAR_SIZE, side);
  return [...new Set([first, Math.min(first, 192), Math.min(first, 128), Math.min(first, 96)])];
};
// WebP first (small and flat); a browser that can't encode it gets JPEG.
export const QUALITIES = [0.86, 0.72, 0.58, 0.44];
export const dataUrlOf = (bytes, type) => {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
};

export class AvatarError extends Error {}

// { url, type, bytes } for a chosen file, or an AvatarError to show as is.
export async function prepareAvatar(file, { clean = cleanImage, draw = browserDraw } = {}) {
  if (!file || typeof file.arrayBuffer !== "function") throw new AvatarError("Choose a picture.");
  if (file.size > MAX_PICTURE_BYTES) throw new AvatarError("That picture is too large. Choose one under 12 MB.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!imageKind(bytes)) throw new AvatarError("Use a PNG, JPEG, WebP, GIF or HEIC picture.");
  let cleaned;
  try {
    cleaned = await clean(bytes);
  } catch (e) {
    throw new AvatarError(e?.message || "That picture couldn't be read. Try another image.");
  }
  let out;
  try {
    out = await draw(cleaned.bytes, cleaned.type);
  } catch (e) {
    throw new AvatarError(e?.message || "That picture couldn't be read. Try another image.");
  }
  if (!out?.bytes?.length || out.bytes.length > MAX_AVATAR_BYTES)
    throw new AvatarError("That picture is too detailed to keep small. Try a simpler one.");
  return { url: dataUrlOf(out.bytes, out.type), type: out.type, bytes: out.bytes.length };
}

// The browser's draw: decode, cut the centred square, draw it at each size
// and quality until the encoded picture is within the cap.
export async function browserDraw(bytes, type) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type }));
  try {
    const { sx, sy, side } = cropRect(bitmap.width, bitmap.height);
    for (const size of drawSizes(side)) {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, size, size);
      for (const quality of QUALITIES) {
        let blob = await new Promise((done) => canvas.toBlob(done, "image/webp", quality));
        if (!blob || blob.type !== "image/webp")
          blob = await new Promise((done) => canvas.toBlob(done, "image/jpeg", quality));
        if (!blob) throw new AvatarError("That picture couldn't be redrawn.");
        if (blob.size <= MAX_AVATAR_BYTES)
          return { bytes: new Uint8Array(await blob.arrayBuffer()), type: blob.type };
      }
    }
    throw new AvatarError("That picture is too detailed to keep small. Try a simpler one.");
  } finally {
    bitmap.close?.();
  }
}
