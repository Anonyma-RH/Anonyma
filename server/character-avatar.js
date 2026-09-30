import { fail } from "./core.js";
import { imageKind, stripJpeg, stripPng, stripWebp } from "../src/clean-uploads.js";
import { AVATAR_SIZE, MAX_AVATAR_BYTES, parseAvatar } from "../src/characters.js";

// A character's picture, checked again on the server whatever the browser
// did: the browser redraws it at 256 px, which drops every hidden detail,
// and this makes sure of it. Only a built-in monogram or a small PNG, JPEG
// or WebP is kept. The bytes are read by content, never by the type the
// request claims; metadata (EXIF, text, XMP, comments, timestamps) is
// removed with Clean Uploads' own strippers, and the picture may be no
// larger than 256 x 256 pixels or MAX_AVATAR_BYTES.
const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
const le16 = (b, p) => b[p] | (b[p + 1] << 8);
const le24 = (b, p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
const tag = (b, p) => String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);

// The pixel size a WebP declares: lossy (VP8), lossless (VP8L) or extended
// (VP8X), read from the first chunk after its header.
function webpSize(b) {
  const kind = tag(b, 12);
  if (kind === "VP8X") return { width: le24(b, 24) + 1, height: le24(b, 27) + 1 };
  if (kind === "VP8L" && b[20] === 0x2f) {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (kind === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
    return { width: le16(b, 26) & 0x3fff, height: le16(b, 28) & 0x3fff };
  return null;
}

const refuse = (message = "Use a PNG, JPEG or WebP picture of up to 256 by 256 pixels.") =>
  fail(400, message, "invalid_avatar");

// The value to store for an avatar in a request: null, "mono:<colour>" or a
// clean data URL. Anything else is refused.
export function cleanAvatar(value) {
  const parsed = parseAvatar(value);
  if (!parsed) refuse();
  if (parsed.kind === "none") return null;
  if (parsed.kind === "mono") return value;
  if (parsed.base64.length > Math.ceil((MAX_AVATAR_BYTES * 4) / 3) + 4)
    refuse(`That picture is too large. Keep it under ${Math.round(MAX_AVATAR_BYTES / 1024)} KB.`);
  const raw = Buffer.from(parsed.base64, "base64");
  if (!raw.length || raw.length > MAX_AVATAR_BYTES)
    refuse(`That picture is too large. Keep it under ${Math.round(MAX_AVATAR_BYTES / 1024)} KB.`);
  const kind = imageKind(raw);
  // The type the request claimed must be what the bytes are.
  if (!MIME[kind] || MIME[kind] !== parsed.mime) refuse();
  let clean;
  try {
    clean = kind === "png" ? stripPng(raw) : kind === "jpeg" ? stripJpeg(raw) : stripWebp(raw);
  } catch {
    refuse("That picture couldn't be read. Try another image.");
  }
  const size = kind === "webp" ? webpSize(clean.bytes) : clean;
  if (!size || !(size.width >= 1) || !(size.height >= 1)) refuse("That picture couldn't be read. Try another image.");
  if (size.width > AVATAR_SIZE || size.height > AVATAR_SIZE)
    refuse(`That picture is too big. Use at most ${AVATAR_SIZE} by ${AVATAR_SIZE} pixels.`);
  const bytes = Buffer.from(clean.bytes);
  if (bytes.length > MAX_AVATAR_BYTES) refuse();
  return `data:${MIME[kind]};base64,${bytes.toString("base64")}`;
}
