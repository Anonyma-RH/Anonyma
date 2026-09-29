import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { credits, generationPrice, usdUnits } from "./core.js";
import { isPrivateModel } from "./private-mode.js";
import { modelReleased } from "./releases.js";

// Photo Tools (update "phototools"): edit a photo with words, remove its
// background or upscale it, on the gateway's image-to-image models. The
// routes are in server/routes/photo-tools.js.
//
// Which models offer which tool is read from the live catalog's own
// capability fields, never assumed: a model is offered only when the catalog
// says it takes a source image (and, for edits, a prompt). The bundled
// reference snapshot carries no capability fields, so before the gateway's
// catalog has loaded nothing is offered.
//
// Extend (outpainting) is not offered. The gateway's outpaint model
// (flux-2-pro-outpaint) declares no image input, and no direction or size
// field is published for it, so a request for it could only be guessed.
// FLUX Kontext models are left out for the same reason: their catalog rows
// declare no image input either. They join the lists on their own the day
// the catalog declares one.
export const TOOLS = ["edit", "background", "upscale"];
export const IMAGE_LIMIT = 1.5 * 1024 * 1024;
export const PROMPT_MAX = 2000;
// What a result may be before it is sent back without saving it.
export const INLINE_LIMIT = 32 * 1024 * 1024;

const EDIT_ID = /(?:-edit|-i2i)$|^flux-kontext-/;
const BACKGROUND = ["birefnet-v2"];
const UPSCALE = ["aura-sr", "crystal-upscaler", "topaz-upscale"];
const EXTEND = ["flux-2-pro-outpaint"];
// The edit model that opens first: modest price, and it is asked to change
// only what the words say. Anything not on the list follows by price.
const EDIT_FIRST = ["seedream-v5-lite-edit", "qwen-image-2-edit", "flux-2-pro-i2i", "grok-imagine-edit"];
const FIRST = { edit: EDIT_FIRST, background: BACKGROUND, upscale: UPSCALE };

// How much bigger each upscaler makes a photo on each side (aura-sr: always
// 4x, checked live at 512 to 2048). The others aren't published, so they are
// treated as the worst case, 4x. A result is checked and returned whole (32 MB
// inline, 100 MB saved) only after the provider has billed, so the input is
// capped so that the largest result stays under UPSCALE_OUTPUT_SIDE pixels on
// its long side: 1024 px in for a 4x model.
export const UPSCALE_FACTORS = { "aura-sr": 4 };
export const UPSCALE_DEFAULT_FACTOR = 4;
export const UPSCALE_OUTPUT_SIDE = 4096;
export const upscaleMaxSide = (id, factors = UPSCALE_FACTORS) =>
  Math.max(1, Math.floor(UPSCALE_OUTPUT_SIDE / (factors[id] ?? UPSCALE_DEFAULT_FACTOR)));

export const EXTEND_UNAVAILABLE =
  "Extend isn't available yet: the gateway's outpainting model doesn't accept a photo, and publishes no direction or size to ask for.";

const isVideo = (m) =>
  String(m.category || "").endsWith("-to-video") ||
  (m.architecture?.output_modalities || []).includes("video");

// The tool a model id belongs to, or null.
export function toolOf(m) {
  if (BACKGROUND.includes(m?.id)) return "background";
  if (UPSCALE.includes(m?.id)) return "upscale";
  if (EDIT_ID.test(m?.id || "")) return "edit";
  return null;
}

// The highest price the catalog publishes for a plain request: the price of
// the default option, or the model's base price if that is higher. This is
// the hold, and exactly what the page shows as "up to". What is charged is
// the provider's own reported cost, never more than this.
export const holdUsd = (m) => Math.max(generationPrice(m, {}), Number(m.pricing?.base_price) || 0);
export const holdUnits = (m, factor) => Math.ceil(usdUnits(holdUsd(m)) * factor);

// Why a model can't run `tool`, or null when it can. Never mentions a
// provider's internals: it is shown as the reason a model isn't offered.
export function photoIssue(m, tool, cfg) {
  if (!m || m.type !== "image" || m.status !== "live") return "not_live";
  if (toolOf(m) !== tool) return "wrong_tool";
  if (String(m.id).startsWith("private/") || isVideo(m)) return "not_photo";
  const caps = m.capabilities || {};
  // A photo goes in: the catalog must say the model takes one.
  if (caps.accepts_image_url !== true) return "no_image_input";
  if (tool === "edit") {
    if (caps.accepts_prompt !== true) return "no_prompt";
  } else if (caps.requires_prompt === true) return "needs_prompt";
  if (!(holdUsd(m) > 0)) return "unpriced";
  if (!(cfg.testMode || cfg.gatewayKey)) return "no_gateway";
  if (!modelReleased(m, cfg)) return "not_released";
  return null;
}

const priceOf = (m) => holdUsd(m);
// The models that can run each tool, first choice first, and the tools that
// can't be offered with why.
export function photoModels(catalog, cfg, { hides = () => false } = {}) {
  const out = { edit: [], background: [], upscale: [] };
  for (const m of catalog?.data || []) {
    const tool = toolOf(m);
    if (tool && !hides(m.id) && !photoIssue(m, tool, cfg)) out[tool].push(m);
  }
  for (const tool of TOOLS)
    out[tool].sort((a, b) => {
      const rank = (m) => {
        const i = FIRST[tool].indexOf(m.id);
        return i < 0 ? FIRST[tool].length : i;
      };
      return rank(a) - rank(b) || priceOf(a) - priceOf(b) || a.id.localeCompare(b.id);
    });
  const outpaint = (catalog?.data || []).find((m) => EXTEND.includes(m.id) && m.status === "live");
  return {
    ...out,
    unavailable: [
      {
        tool: "extend",
        reason: outpaint
          ? "The gateway's outpainting model doesn't accept a photo yet."
          : "The gateway doesn't list an outpainting model right now.",
      },
    ],
  };
}

// A model as the page lists it: its price is the hold, at the account's rate.
export const offerOf = (m, factor, cfg) => {
  const units = holdUnits(m, factor);
  return {
    id: m.id,
    name: m.name || m.id,
    provider: typeof m.owned_by === "string" ? m.owned_by : null,
    credits: credits(units),
    units,
    private: isPrivateModel(m, cfg),
    // An upscaler takes a photo no bigger than this on its long side.
    ...(toolOf(m) === "upscale" ? { max_side: upscaleMaxSide(m.id) } : {}),
  };
};

// The library's name for a result: what was asked, or what was done.
export function resultLabel(tool, prompt) {
  if (tool === "edit") return String(prompt || "").trim().slice(0, 200) || "Edited photo";
  return tool === "background" ? "Background removed" : "Upscaled photo";
}

// ---- Reading what the provider gave back ----

export function sniff(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) return "image/png";
  if (b.length >= 3 && b.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))) return "image/jpeg";
  if (b.length >= 12 && b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP")
    return "image/webp";
  if (b.length >= 4 && b.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  return null;
}

// A picture's pixel size from its header, or null when it can't be read. Only
// the header is read; the pixels are never decoded.
export function imageSize(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const kind = sniff(b);
  if (kind === "image/png") return b.length >= 24 ? { width: b.readUInt32BE(16), height: b.readUInt32BE(20) } : null;
  if (kind === "image/gif") return b.length >= 10 ? { width: b.readUInt16LE(6), height: b.readUInt16LE(8) } : null;
  if (kind === "image/jpeg") {
    // Walk the segments to the first start-of-frame marker.
    for (let at = 2; at + 4 <= b.length; ) {
      if (b[at] !== 0xff) {
        at++;
        continue;
      }
      const marker = b[at + 1];
      if (marker === 0xff) {
        at++;
        continue;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
        at += 2;
        continue;
      }
      const length = b.readUInt16BE(at + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
        return at + 9 <= b.length ? { width: b.readUInt16BE(at + 7), height: b.readUInt16BE(at + 5) } : null;
      at += 2 + length;
    }
    return null;
  }
  if (kind === "image/webp") {
    const chunk = b.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") return b.length >= 30 ? { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) } : null;
    if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
      const bits = b.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)
      return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  return null;
}

// Whether a PNG or WebP can hold transparent pixels: a colour type with an
// alpha channel, a transparency chunk, or WebP's alpha flag. This reads only
// headers; it says the file is able to be transparent, not that it is.
export function hasAlpha(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const kind = sniff(b);
  if (kind === "image/png") {
    if (b.length < 26) return false;
    const colour = b[25];
    if (colour === 4 || colour === 6) return true;
    for (let at = 8; at + 8 <= b.length; ) {
      const size = b.readUInt32BE(at),
        type = b.subarray(at + 4, at + 8).toString("latin1");
      if (type === "tRNS") return true;
      if (type === "IDAT" || type === "IEND") return false;
      at += 12 + size;
    }
    return false;
  }
  if (kind === "image/webp") {
    const chunk = b.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") return b.length > 20 && (b[20] & 0x10) !== 0;
    // Lossless: a signature byte, then 14 + 14 bits of size and the alpha bit.
    if (chunk === "VP8L") return b.length > 25 && b[20] === 0x2f && (b[24] & 0x10) !== 0;
    return false;
  }
  return false;
}

// What a run's output is checked for before it is kept or charged. Returns
// the file's type, or throws a plain refusal (nothing is charged).
export function checkOutput(tool, bytes) {
  const mime = sniff(bytes);
  if (!mime) throw unusable("The provider returned something that isn't a picture, so nothing was saved or charged.", "photo_unusable");
  if (tool === "background" && !hasAlpha(bytes))
    throw unusable("The provider returned a picture without a transparent background, so nothing was saved or charged.", "photo_not_transparent");
  return mime;
}
export const unusable = (message, code) => Object.assign(new Error(message), { status: 502, code });

// ---- Local test mode's stand-ins ----

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
};
// A square RGBA PNG: a shaded cobalt ball on a transparent background, the
// local test provider's answer to "remove the background".
export function testCutout(size = 512) {
  const mid = (size - 1) / 2,
    r = size * 0.38,
    rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4);
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - mid, y - mid);
      // A one-pixel soft edge, then a highlight toward the top left.
      const alpha = Math.max(0, Math.min(1, r - d + 0.5));
      const light = Math.max(0, 1 - Math.hypot(x - (mid - r * 0.35), y - (mid - r * 0.4)) / (r * 1.5));
      const mix = (a, b) => Math.round(a + (b - a) * light);
      row.set([mix(0x01, 0x9d), mix(0x35, 0xb4), mix(0xdf, 0xff), Math.round(alpha * 255)], 1 + x * 4);
    }
    rows.push(row);
  }
  const head = Buffer.alloc(13);
  head.writeUInt32BE(size, 0);
  head.writeUInt32BE(size, 4);
  head.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", head),
    chunk("IDAT", deflateSync(Buffer.concat(rows))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// What the local test provider returns for each tool.
export const testOutput = (tool) =>
  tool === "background" ? testCutout() : readFileSync(new URL("../data/test-image.png", import.meta.url));
