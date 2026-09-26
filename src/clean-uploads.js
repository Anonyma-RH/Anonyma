// Clean Uploads: photos, Office files and audio carry hidden details (GPS
// location, camera serial numbers, author names, edit history) that say more
// than the file itself. They are removed here, in the browser, before a file
// leaves the device, so neither the AI provider nor ANONYMA receives them.
//
// Everything below works on bytes and runs in Node too (tests). The one step
// that needs a canvas, drawing a photo the right way up or converting HEIC,
// is passed in as `reencode`; browserReencode is the browser's version.
//
// - JPEG, PNG, WebP, GIF: metadata segments and chunks are dropped and the
//   image data is copied byte for byte. A photo whose EXIF says to rotate or
//   flip it is redrawn the right way up instead (the rotation lives in the
//   metadata being removed): JPEG and WebP at quality 0.95, PNG lossless.
// - HEIC/HEIF: redrawn as JPEG (0.92) where this browser can decode it.
// - DOCX, XLSX, PPTX: document properties, comment and tracked-change
//   authors, template and file paths, archive timestamps, and the metadata
//   of embedded photos. Every other archive entry is copied unchanged.
// - MP3, WAV, FLAC, M4A: tags, cover art and recording dates. OGG and WebM
//   can't be cleaned; the caller asks the user what to do.
// - A PDF or Office file attached to a chat never leaves the device (only
//   its extracted text is sent), so it is inspected here, never rewritten.
import {
  zipEntries,
  crc32,
  parseOfficeXML,
  textBytes,
  browserInflate,
  OFFICE_EXTENSIONS,
} from "./file-formats.js";
import { DOCUMENT_KINDS, extensionOf } from "./documents.js";
import { IMAGE_LIMIT, detailList, isHeicFile } from "./clean-notes.js";

export * from "./clean-notes.js";
export const JPEG_QUALITY = 0.95;
export const MIN_JPEG_QUALITY = 0.92;
export const AUDIO_EXTENSIONS = ["mp3", "wav", "flac", "m4a", "ogg", "webm"];

// ---- bytes ----

class CleanError extends Error {}
const bad = (message) => {
  throw new CleanError(message);
};
const u8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
const utf8 = new TextDecoder("utf-8");
const encoder = new TextEncoder();
function latin1(b, start, end) {
  let s = "";
  for (let i = start; i < end && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
}
const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const be16 = (b, p) => (b[p] << 8) | b[p + 1];
const be32 = (b, p) =>
  ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const le16 = (b, p) => b[p] | (b[p + 1] << 8);
const le32 = (b, p) =>
  (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const syncsafe = (b, p) =>
  ((b[p] & 0x7f) << 21) | ((b[p + 1] & 0x7f) << 14) | ((b[p + 2] & 0x7f) << 7) | (b[p + 3] & 0x7f);
function startsWith(b, p, s) {
  if (p < 0 || p + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[p + i] !== (s.charCodeAt(i) & 0xff)) return false;
  return true;
}
function indexOf(b, s, from = 0, to = b.length) {
  const first = s.charCodeAt(0) & 0xff;
  for (let i = from; i + s.length <= to; i++)
    if (b[i] === first && startsWith(b, i, s)) return i;
  return -1;
}
function concat(parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
const sameBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const merge = (into, from) => {
  for (const k of from) into.add(k);
};
const u32be = (n) => Uint8Array.of(n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
const u32le = (n) => Uint8Array.of(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, n >>> 24);

// ---- EXIF, XMP and IPTC: what's in them, for the chip ----

// IFD0 tags that only describe how to show the pixels.
const PLAIN_IFD0 = new Set([
  0x0100, 0x0101, 0x0102, 0x0103, 0x0106, 0x0111, 0x0112, 0x0115, 0x0116,
  0x0117, 0x011a, 0x011b, 0x011c, 0x0128, 0x013e, 0x013f, 0x0201, 0x0202,
  0x0211, 0x0212, 0x0213, 0x0214,
]);
const IFD0 = {
  0x010e: "comments", 0x010f: "camera", 0x0110: "camera", 0x0131: "software",
  0x0132: "dates", 0x013b: "author", 0x8298: "author", 0x9c9b: "titles",
  0x9c9c: "comments", 0x9c9d: "author", 0x9c9e: "titles", 0x9c9f: "titles",
  0xa430: "author", 0xa431: "camera",
};
// Exif sub-IFD: dates, a comment and the owner's name; the rest (serials,
// lens, exposure, the maker note) describes the camera. These don't.
const EXIF_DATES = new Set([0x9003, 0x9004, 0x9010, 0x9011, 0x9012, 0x9290, 0x9291, 0x9292]);
const PLAIN_EXIF = new Set([0x9000, 0x9101, 0xa000, 0xa001, 0xa002, 0xa003]);
export function readExif(input) {
  const b = u8(input);
  const found = new Set();
  let orientation = 1;
  const le = b[0] === 0x49 && b[1] === 0x49;
  if (b.length < 8 || (!le && !(b[0] === 0x4d && b[1] === 0x4d))) {
    found.add("other");
    return { found, orientation };
  }
  const r16 = (p) => (le ? le16(b, p) : be16(b, p));
  const r32 = (p) => (le ? le32(b, p) : be32(b, p));
  if (r16(2) !== 42) {
    found.add("other");
    return { found, orientation };
  }
  const seen = new Set();
  const ifd = (offset, kind) => {
    if (!offset || seen.has(offset) || seen.size > 16 || offset + 2 > b.length) return 0;
    seen.add(offset);
    const n = r16(offset);
    if (n > 1000 || offset + 2 + n * 12 > b.length) {
      found.add("other");
      return 0;
    }
    for (let i = 0; i < n; i++) {
      const e = offset + 2 + i * 12,
        tag = r16(e);
      if (kind === "gps") {
        if (tag !== 0) found.add("location");
      } else if (kind === "ifd1") {
        if (tag === 0x0201 || tag === 0x0111) found.add("thumbnail");
      } else if (tag === 0x8769) ifd(r32(e + 8), "exif");
      else if (tag === 0x8825) ifd(r32(e + 8), "gps");
      else if (tag === 0xa005) continue;
      else if (tag === 0x02bc) {
        const count = r32(e + 4),
          at = count > 4 ? r32(e + 8) : e + 8;
        if (at + count <= b.length) merge(found, readXmp(utf8.decode(b.subarray(at, at + count))));
      } else if (kind === "exif") {
        if (EXIF_DATES.has(tag)) found.add("dates");
        else if (tag === 0x9286) found.add("comments");
        else if (tag === 0xa430) found.add("author");
        else if (tag === 0xa420) found.add("other");
        else if (!PLAIN_EXIF.has(tag)) found.add("camera");
      } else if (tag === 0x0112) {
        const v = r16(e + 8);
        if (v >= 1 && v <= 8) orientation = v;
      } else if (!PLAIN_IFD0.has(tag)) found.add(IFD0[tag] || "other");
    }
    return offset + 2 + n * 12 + 4 <= b.length ? r32(offset + 2 + n * 12) : 0;
  };
  const next = ifd(r32(4), "ifd0");
  if (next) ifd(next, "ifd1");
  return { found, orientation };
}

const XMP_RULES = [
  ["location", /exif:GPS|GPS(Latitude|Longitude|Altitude)|photoshop:(City|State|Country)|Iptc4xmpCore:(Location|CountryCode)|Iptc4xmpExt:Location/i],
  ["camera", /tiff:(Make|Model)|aux:(SerialNumber|Lens|LensID|LensSerialNumber)|exifEX:(BodySerialNumber|LensModel|LensMake|LensSerialNumber)|exif:(FNumber|ExposureTime|ISOSpeed|FocalLength)/i],
  ["author", /dc:(creator|rights)|xmpRights:|photoshop:(AuthorsPosition|Credit|CaptionWriter)|Iptc4xmpCore:CreatorContactInfo|aux:OwnerName|pdf:Author/i],
  ["dates", /(xmp|xap):(CreateDate|ModifyDate|MetadataDate)|exif:DateTime(Original|Digitized)|photoshop:DateCreated/i],
  ["software", /(xmp|xap):CreatorTool|tiff:Software|pdf:Producer/i],
  ["history", /xmpMM:(History|DerivedFrom|Ingredients|Pantry|DocumentID|InstanceID|OriginalDocumentID)|photoshop:(DocumentAncestors|History)|crs:/i],
  ["comments", /dc:description|exif:UserComment|photoshop:(Instructions|Headline)/i],
  ["titles", /dc:(title|subject)|lr:hierarchicalSubject|photoshop:(Category|SupplementalCategories)/i],
];
export function readXmp(text) {
  const found = new Set();
  for (const [kind, re] of XMP_RULES) if (re.test(text)) found.add(kind);
  if (!found.size) found.add("other");
  return found;
}

// IPTC-IIM datasets (record 2) inside Photoshop's image resources.
const IPTC = {
  5: "titles", 15: "titles", 20: "titles", 25: "titles", 40: "comments",
  55: "dates", 60: "dates", 62: "dates", 63: "dates", 65: "software",
  70: "software", 80: "author", 85: "author", 90: "location", 92: "location",
  95: "location", 100: "location", 101: "location", 105: "titles",
  110: "author", 115: "author", 116: "author", 118: "author", 120: "comments",
  122: "author",
};
// Resources about printing and layout only.
const PLAIN_RESOURCES = new Set([0x03ed, 0x03f3, 0x03f5, 0x03f8, 0x0408, 0x040d, 0x0414, 0x0419, 0x0425, 0x0426, 0x0428, 0x2710]);
export function readIptc(input) {
  const b = u8(input);
  const found = new Set();
  let unknown = false,
    p = startsWith(b, 0, "Photoshop 3.0\0") ? 14 : 0;
  while (p + 12 <= b.length && startsWith(b, p, "8BIM")) {
    const id = be16(b, p + 4),
      nameLength = b[p + 6];
    let q = p + 7 + nameLength + ((nameLength + 1) % 2);
    if (q + 4 > b.length) break;
    const size = be32(b, q);
    q += 4;
    if (q + size > b.length) break;
    const data = b.subarray(q, q + size);
    if (id === 0x0404) {
      for (let i = 0; i + 5 <= data.length; ) {
        if (data[i] !== 0x1c) break;
        const length = be16(data, i + 3);
        if (length & 0x8000) break;
        if (data[i + 1] === 2 && data[i + 2] !== 0) found.add(IPTC[data[i + 2]] || "other");
        i += 5 + length;
      }
    } else if (id === 0x0409 || id === 0x040c) found.add("thumbnail");
    else if (id === 0x0422) merge(found, readExif(data).found);
    else if (id === 0x0424) merge(found, readXmp(utf8.decode(data)));
    else if (id === 0x0421) found.add("software");
    else if (!PLAIN_RESOURCES.has(id)) unknown = true;
    p = q + size + (size % 2);
  }
  if (!found.size && (unknown || p < b.length)) found.add("other");
  return found;
}

// ---- JPEG ----

function jpegApp(marker, segment, found, state) {
  const d = segment.subarray(4);
  switch (marker) {
    case 0xe0:
      if (startsWith(d, 0, "JFIF\0")) {
        if (d.length <= 14) return segment;
        // A JFIF thumbnail (or trailing bytes): keep only the 14-byte header.
        if (d.length > 14 && (d[12] || d[13])) found.add("thumbnail");
        const kept = segment.slice(0, 18);
        kept[2] = 0;
        kept[3] = 16;
        kept[16] = 0;
        kept[17] = 0;
        return kept;
      }
      found.add(startsWith(d, 0, "JFXX\0") ? "thumbnail" : "other");
      return null;
    case 0xe1:
      if (startsWith(d, 0, "Exif\0")) {
        const r = readExif(d.subarray(6));
        merge(found, r.found);
        state.orientation = r.orientation;
      } else if (startsWith(d, 0, "http://ns.adobe.com/")) merge(found, readXmp(utf8.decode(d)));
      else found.add("other");
      return null;
    case 0xe2:
      // The colour profile stays: the pixels mean nothing without it.
      if (startsWith(d, 0, "ICC_PROFILE\0")) return segment;
      found.add("other");
      return null;
    case 0xeb:
      // JUMBF, which carries C2PA content credentials (an edit history).
      found.add(indexOf(d, "c2pa") >= 0 ? "history" : "other");
      return null;
    case 0xec:
      found.add(startsWith(d, 0, "Ducky") ? "software" : "other");
      return null;
    case 0xed:
      merge(found, readIptc(d));
      return null;
    case 0xee:
      // Adobe's colour-transform flag: needed to decode CMYK images.
      if (startsWith(d, 0, "Adobe")) return segment;
      found.add("other");
      return null;
    default:
      found.add("other");
      return null;
  }
}

// Drops every APPn segment except JFIF, the ICC profile and Adobe's
// colour-transform flag, every comment, and anything after the image (extra
// pictures such as MPF depth maps). The segments that make the picture
// (tables, frame header, scans) are copied unchanged, so it decodes to
// exactly the same pixels.
export function stripJpeg(input) {
  const b = u8(input);
  if (b[0] !== 0xff || b[1] !== 0xd8) bad("This isn't a JPEG image.");
  const out = [b.subarray(0, 2)];
  const found = new Set();
  const state = { orientation: 1 };
  let p = 2,
    frame = null,
    scans = 0;
  for (;;) {
    if (p + 1 >= b.length) bad("The JPEG image is incomplete.");
    if (b[p] !== 0xff) bad("Malformed JPEG marker.");
    while (b[p + 1] === 0xff) p++;
    const m = b[p + 1];
    if (m === 0xd9) {
      out.push(b.subarray(p, p + 2));
      p += 2;
      break;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      out.push(b.subarray(p, p + 2));
      p += 2;
      continue;
    }
    if (m === 0x00 || m === 0xd8 || p + 4 > b.length) bad("Malformed JPEG marker.");
    const length = be16(b, p + 2);
    if (length < 2 || p + 2 + length > b.length) bad("Malformed JPEG segment.");
    const segment = b.subarray(p, p + 2 + length);
    if (m >= 0xe0 && m <= 0xef) {
      const kept = jpegApp(m, segment, found, state);
      if (kept) out.push(kept);
    } else if (m === 0xfe) found.add("comments");
    else {
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc && length >= 7)
        frame = { height: be16(b, p + 5), width: be16(b, p + 7) };
      out.push(segment);
    }
    p += 2 + length;
    if (m === 0xda) {
      // Entropy-coded data runs to the next marker that isn't a stuffed
      // 0xFF00 or a restart marker.
      const start = p;
      while (p + 1 < b.length && !(b[p] === 0xff && b[p + 1] !== 0 && (b[p + 1] < 0xd0 || b[p + 1] > 0xd7)))
        p++;
      if (p + 1 >= b.length) bad("The JPEG image is incomplete.");
      out.push(b.subarray(start, p));
      scans++;
    }
  }
  if (!frame || !scans) bad("The JPEG has no image data.");
  if (b.subarray(p).some((x) => x !== 0)) found.add("other");
  return { bytes: concat(out), found, orientation: state.orientation, ...frame };
}

// ---- PNG ----

const PNG_SIGNATURE = "\x89PNG\r\n\x1a\n";
// Ancillary chunks that change how the pixels look (colour, transparency,
// animation) stay; text, EXIF, timestamps and private chunks go.
const PNG_KEEP = new Set([
  "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "pHYs", "bKGD", "hIST",
  "sPLT", "acTL", "fcTL", "fdAT", "cICP", "mDCv", "cLLi",
]);
const PNG_TEXT = {
  title: "titles", author: "author", description: "comments", copyright: "author",
  "creation time": "dates", software: "software", comment: "comments",
  source: "camera", "date:create": "dates", "date:modify": "dates",
  "date:timestamp": "dates",
};
// ImageMagick's "Raw profile type exif": EXIF as hex text.
function rawProfile(text) {
  const lines = text.split("\n").filter(Boolean);
  const hex = lines.slice(2).join("").replace(/\s/g, "");
  if (!/^([0-9a-f]{2})+$/i.test(hex)) return null;
  const bytes = Uint8Array.from(hex.match(/../g), (h) => parseInt(h, 16));
  return startsWith(bytes, 0, "Exif\0") ? bytes.subarray(6) : bytes;
}
function pngText(type, data, found) {
  const zero = data.indexOf(0);
  const keyword = latin1(data, 0, zero < 0 ? Math.min(79, data.length) : zero).toLowerCase();
  if (keyword === "xml:com.adobe.xmp" && type === "iTXt" && data[zero + 1] === 0) {
    let q = data.indexOf(0, zero + 3);
    q = q < 0 ? -1 : data.indexOf(0, q + 1);
    if (q > 0) return merge(found, readXmp(utf8.decode(data.subarray(q + 1))));
  }
  if (/^raw profile type (exif|app1)$/.test(keyword) && type === "tEXt") {
    const exif = rawProfile(latin1(data, zero + 1, data.length));
    if (exif) return merge(found, readExif(exif).found);
  }
  if (keyword.startsWith("exif:"))
    return found.add(/gps/.test(keyword) ? "location" : /date/.test(keyword) ? "dates" : "camera");
  found.add(PNG_TEXT[keyword] || "other");
}
export function stripPng(input) {
  const b = u8(input);
  if (!startsWith(b, 0, PNG_SIGNATURE)) bad("This isn't a PNG image.");
  const out = [b.subarray(0, 8)];
  const found = new Set();
  let orientation = 1,
    p = 8,
    ended = false,
    size = null;
  while (p + 12 <= b.length) {
    const length = be32(b, p),
      type = latin1(b, p + 4, p + 8);
    if (!/^[A-Za-z]{4}$/.test(type) || p + 12 + length > b.length) bad("Malformed PNG chunk.");
    if (p === 8 && type !== "IHDR") bad("The PNG has no header.");
    const chunk = b.subarray(p, p + 12 + length),
      data = b.subarray(p + 8, p + 8 + length);
    const critical = !(b[p + 4] & 0x20);
    if (critical || PNG_KEEP.has(type)) {
      out.push(chunk);
      if (type === "IHDR") size = { width: be32(data, 0), height: be32(data, 4) };
    } else if (type === "tEXt" || type === "zTXt" || type === "iTXt") pngText(type, data, found);
    else if (type === "eXIf") {
      const r = readExif(data);
      merge(found, r.found);
      orientation = r.orientation;
    } else if (type === "tIME") found.add("dates");
    else if (type === "caBX") found.add("history");
    else found.add("other");
    p += 12 + length;
    if (type === "IEND") {
      ended = true;
      break;
    }
  }
  if (!ended) bad("The PNG image is incomplete.");
  if (p < b.length) found.add("other");
  return { bytes: concat(out), found, orientation, ...size };
}

// ---- WebP ----

const WEBP_KEEP = new Set(["VP8 ", "VP8L", "VP8X", "ALPH", "ANIM", "ANMF", "ICCP"]);
export function stripWebp(input) {
  const b = u8(input);
  if (!startsWith(b, 0, "RIFF") || !startsWith(b, 8, "WEBP")) bad("This isn't a WebP image.");
  const end = 8 + le32(b, 4);
  if (end > b.length || end < 12) bad("The WebP image is incomplete.");
  const chunks = [];
  const found = new Set();
  let orientation = 1,
    p = 12,
    image = false;
  while (p + 8 <= end) {
    const type = latin1(b, p, p + 4),
      size = le32(b, p + 4),
      next = p + 8 + size + (size & 1);
    if (p + 8 + size > end) bad("Malformed WebP chunk.");
    const data = b.subarray(p + 8, p + 8 + size);
    if (WEBP_KEEP.has(type)) {
      let chunk = b.subarray(p, Math.min(next, end));
      if (type === "VP8X") {
        // Clear the "has EXIF" and "has XMP" flags.
        chunk = chunk.slice();
        chunk[8] &= ~0x0c;
      }
      if (type === "VP8 " || type === "VP8L" || type === "ANMF") image = true;
      chunks.push(chunk);
    } else if (type === "EXIF") {
      const r = readExif(startsWith(data, 0, "Exif\0") ? data.subarray(6) : data);
      merge(found, r.found);
      orientation = r.orientation;
    } else if (type === "XMP ") merge(found, readXmp(utf8.decode(data)));
    else found.add("other");
    p = next;
  }
  if (!image) bad("The WebP has no image data.");
  if (end < b.length) found.add("other");
  // A last chunk without its padding byte gets one.
  let body = concat(chunks);
  if (body.length & 1) body = concat([body, Uint8Array.of(0)]);
  return {
    bytes: concat([ascii("RIFF"), u32le(body.length + 4), ascii("WEBP"), body]),
    found,
    orientation,
  };
}

// ---- GIF ----

export function stripGif(input) {
  const b = u8(input);
  if (!startsWith(b, 0, "GIF87a") && !startsWith(b, 0, "GIF89a")) bad("This isn't a GIF image.");
  const found = new Set();
  const out = [];
  let p = 13;
  if (b.length < 13) bad("The GIF image is incomplete.");
  if (b[10] & 0x80) p += 3 * 2 ** ((b[10] & 7) + 1);
  out.push(b.subarray(0, p));
  const blocks = (q) => {
    while (q < b.length && b[q] !== 0) q += 1 + b[q];
    if (q >= b.length) bad("The GIF image is incomplete.");
    return q + 1;
  };
  let frames = 0;
  for (;;) {
    if (p >= b.length) bad("The GIF image is incomplete.");
    const kind = b[p];
    if (kind === 0x3b) {
      out.push(b.subarray(p, p + 1));
      p++;
      break;
    }
    if (kind === 0x2c) {
      let q = p + 10;
      if (q > b.length) bad("The GIF image is incomplete.");
      if (b[p + 9] & 0x80) q += 3 * 2 ** ((b[p + 9] & 7) + 1);
      const end = blocks(q + 1);
      out.push(b.subarray(p, end));
      p = end;
      frames++;
      continue;
    }
    if (kind !== 0x21) bad("Malformed GIF block.");
    const label = b[p + 1],
      end = blocks(p + 2);
    if (label === 0xf9 || label === 0x01) out.push(b.subarray(p, end));
    else if (label === 0xff) {
      const app = latin1(b, p + 3, p + 14);
      // Looping and the colour profile stay.
      if (app === "NETSCAPE2.0" || app === "ANIMEXTS1.0" || app === "ICCRGBG1012") out.push(b.subarray(p, end));
      else if (app === "XMP DataXMP") merge(found, readXmp(utf8.decode(b.subarray(p + 14, end))));
      else found.add("other");
    } else if (label === 0xfe) found.add("comments");
    else found.add("other");
    p = end;
  }
  if (!frames) bad("The GIF has no image data.");
  if (b.subarray(p).some((x) => x !== 0)) found.add("other");
  return { bytes: concat(out), found, orientation: 1 };
}

// ---- HEIC: converted, so only read for the chip ----

export function heicDetails(input) {
  const b = u8(input);
  const found = new Set();
  const exif = indexOf(b, "Exif\0\0");
  if (exif >= 0) merge(found, readExif(b.subarray(exif + 6)).found);
  const xmp = indexOf(b, "<x:xmpmeta");
  if (xmp >= 0) {
    const end = indexOf(b, "</x:xmpmeta>", xmp);
    merge(found, readXmp(utf8.decode(b.subarray(xmp, end > 0 ? end : Math.min(b.length, xmp + 65536)))));
  }
  return found;
}

// ---- images ----

const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };
const STRIP = { jpeg: stripJpeg, png: stripPng, webp: stripWebp, gif: stripGif };
const HEIC_BRANDS = /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/;
// By content, never by the name or the type the browser reports.
export function imageKind(input) {
  const b = u8(input);
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpeg";
  if (startsWith(b, 0, PNG_SIGNATURE)) return "png";
  if (startsWith(b, 0, "RIFF") && startsWith(b, 8, "WEBP")) return "webp";
  if (startsWith(b, 0, "GIF87a") || startsWith(b, 0, "GIF89a")) return "gif";
  if (startsWith(b, 4, "ftyp") && HEIC_BRANDS.test(latin1(b, 8, 12))) return "heic";
  return null;
}

// The canvas transform that draws a w x h image the way its EXIF orientation
// says it should look: setTransform(...matrix), then drawImage(image, 0, 0).
export function orientationTransform(orientation, width, height) {
  const w = width,
    h = height;
  switch (orientation) {
    case 2: return { width: w, height: h, matrix: [-1, 0, 0, 1, w, 0] };
    case 3: return { width: w, height: h, matrix: [-1, 0, 0, -1, w, h] };
    case 4: return { width: w, height: h, matrix: [1, 0, 0, -1, 0, h] };
    case 5: return { width: h, height: w, matrix: [0, 1, 1, 0, 0, 0] };
    case 6: return { width: h, height: w, matrix: [0, 1, -1, 0, h, 0] };
    case 7: return { width: h, height: w, matrix: [0, -1, -1, 0, h, w] };
    case 8: return { width: h, height: w, matrix: [0, -1, 1, 0, 0, w] };
    default: return { width: w, height: h, matrix: [1, 0, 0, 1, 0, 0] };
  }
}

// { bytes, type, details, rotated?, converted? }. Throws when the image
// can't be read; the caller shows that and lets the user choose.
export async function cleanImage(input, { reencode = browserReencode, maxBytes = IMAGE_LIMIT } = {}) {
  const bytes = u8(input);
  const kind = imageKind(bytes);
  if (!kind) bad("This isn't a supported image.");
  if (kind === "heic") {
    const found = heicDetails(bytes);
    const out = await reencode(bytes, {
      type: "image/heic",
      outType: "image/jpeg",
      quality: MIN_JPEG_QUALITY,
      maxBytes,
      fit: true,
    });
    if (imageKind(out.bytes) !== "jpeg") bad("The photo couldn't be converted.");
    return { bytes: stripJpeg(out.bytes).bytes, type: "image/jpeg", details: detailList(found), converted: true };
  }
  const first = STRIP[kind](bytes);
  if (first.orientation > 1 && first.orientation <= 8) {
    // The stripped copy is decoded, so the decoder can't apply the
    // orientation too; the transform turns the pixels themselves.
    const outType = kind === "png" ? "image/png" : kind === "webp" ? "image/webp" : "image/jpeg";
    const options = { type: MIME[kind], orientation: first.orientation, outType, quality: JPEG_QUALITY, maxBytes };
    let out = await reencode(first.bytes, options);
    if (out.bytes.length > maxBytes && outType !== "image/png")
      out = await reencode(first.bytes, { ...options, quality: MIN_JPEG_QUALITY });
    const outKind = imageKind(out.bytes);
    if (!STRIP[outKind]) bad("The photo couldn't be turned the right way up.");
    const again = STRIP[outKind](out.bytes);
    return { bytes: again.bytes, type: MIME[outKind], details: detailList(first.found), rotated: true };
  }
  return { bytes: first.bytes, type: MIME[kind], details: detailList(first.found) };
}

// The browser's reencode: decode, draw through the orientation transform,
// encode. `fit` scales down until the result is at most maxBytes.
const MAX_PIXELS = 16_000_000;
export async function browserReencode(bytes, { type, orientation = 1, outType, quality, maxBytes = Infinity, fit = false }) {
  const source = await decodeImage(new Blob([bytes], { type }));
  try {
    let scale = Math.min(1, Math.sqrt(MAX_PIXELS / (source.width * source.height)));
    for (let attempt = 0; attempt < 8; attempt++) {
      const w = Math.max(1, Math.round(source.width * scale)),
        h = Math.max(1, Math.round(source.height * scale));
      const t = orientationTransform(orientation, w, h);
      const canvas = makeCanvas(t.width, t.height);
      const ctx = canvas.getContext("2d");
      if (outType === "image/jpeg") {
        ctx.fillStyle = "#fff";
        ctx.fillRect(0, 0, t.width, t.height);
      }
      ctx.imageSmoothingQuality = "high";
      ctx.setTransform(...t.matrix);
      ctx.drawImage(source.image, 0, 0, w, h);
      const blob = await canvasBlob(canvas, outType, quality);
      const out = new Uint8Array(await blob.arrayBuffer());
      if (!fit || out.length <= maxBytes) return { bytes: out, type: blob.type || outType };
      scale *= 0.8;
    }
    bad("The photo is too large to convert.");
  } finally {
    source.close();
  }
}
async function decodeImage(blob) {
  if (typeof createImageBitmap === "function") {
    const bitmap = await createImageBitmap(blob);
    return { image: bitmap, width: bitmap.width, height: bitmap.height, close: () => bitmap.close?.() };
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { image: img, width: img.naturalWidth, height: img.naturalHeight, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}
function makeCanvas(width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
function canvasBlob(canvas, type, quality) {
  if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("The image couldn't be redrawn."))), type, quality),
  );
}

// ---- Office (DOCX, XLSX, PPTX) ----

const local = (name) => name.split(":").at(-1);
const textOf = (node) =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const CORE = {
  creator: "author", lastModifiedBy: "author", created: "dates", modified: "dates",
  lastPrinted: "dates", title: "titles", subject: "titles", keywords: "titles",
  category: "titles", contentStatus: "titles", description: "comments",
  revision: "history", version: "history",
};
// docProps/core.xml: every property goes (the root stays, empty, which the
// Open Packaging Conventions allow).
function cleanCoreXml(text, found) {
  const m = /^([\s\S]*?<((?:[\w.-]+:)?coreProperties)\b[^>]*?)(\/?)>([\s\S]*)$/.exec(text);
  if (!m) bad("Unexpected document properties.");
  if (m[3] === "/") return text;
  const root = parseOfficeXML(text).children.find((n) => typeof n !== "string");
  let any = false;
  for (const child of root.children) {
    if (typeof child === "string") {
      if (child.trim()) any = true;
      continue;
    }
    any = true;
    if (textOf(child).trim()) found.add(CORE[local(child.name)] || "other");
  }
  if (!any) return text;
  if (!new RegExp(`</${escapeRe(m[2])}\\s*>\\s*$`).test(m[4])) bad("Unexpected document properties.");
  return `${m[1]}></${m[2]}>`;
}
// docProps/app.xml: the leaf properties that name a person, company, path,
// application or editing time go; counts and titles of parts stay.
const APP = {
  Template: "paths", TotalTime: "history", Company: "company", Manager: "company",
  HyperlinkBase: "paths", Application: "software", AppVersion: "software",
};
function cleanAppXml(text, found) {
  let out = text;
  for (const [name, kind] of Object.entries(APP)) {
    const re = new RegExp(`<((?:[\\w.-]+:)?${name})(?:\\s[^>]*)?(?:/>|>([^<]*)</\\1\\s*>)`, "g");
    out = out.replace(re, (_, tag, value = "") => {
      const v = value.trim();
      const reported =
        v && !(name === "TotalTime" && /^0+$/.test(v)) && !(name === "Template" && !/[\\/]/.test(v));
      if (reported) found.add(kind);
      return "";
    });
  }
  return out;
}
function cleanCustomXml(text, found) {
  return text.replace(/<((?:[\w.-]+:)?property)\b[^>]*?(?:\/>|>[\s\S]*?<\/\1\s*>)/g, () => {
    found.add("custom");
    return "";
  });
}
const anonymous = (found, kind, value, as) => {
  if (value && value !== as) found.add(kind);
};
// Comment and tracked-change authors become "Author" (what Word's own
// "remove personal information" does); their dates and presence ids go.
function cleanWordXml(text, found) {
  return text
    .replace(/(\s(?:w|w15):author=")([^"]*)"/g, (_, a, v) => {
      anonymous(found, "author", v, "Author");
      return `${a}Author"`;
    })
    .replace(/(\sw:initials=")([^"]*)"/g, (_, a, v) => {
      anonymous(found, "author", v, "A");
      return `${a}A"`;
    })
    .replace(/\s(?:w:date|w16cex:dateUtc|w16du:dateUtc)="[^"]*"/g, () => {
      found.add("dates");
      return "";
    })
    .replace(/<w15:presenceInfo\b[^>]*\/>/g, () => {
      found.add("author");
      return "";
    });
}
// The attached template's full path (C:\Users\name\...) keeps its file name.
function cleanTemplateRel(text, found) {
  return text.replace(/<Relationship\b[^>]*\/attachedTemplate"[^>]*>/g, (tag) =>
    tag.replace(/\sTarget="([^"]*)"/, (all, target) => {
      const base = target.split(/[\\/]/).pop();
      if (!base || base === target) return all;
      found.add("paths");
      return ` Target="${base}"`;
    }),
  );
}
// PowerPoint comment authors and Excel's people list.
function cleanPeople(text, found) {
  return text
    .replace(/(\s(?:name|displayName|userId)=")([^"]*)"/g, (_, a, v) => {
      anonymous(found, "author", v, "Author");
      return `${a}Author"`;
    })
    .replace(/(\sinitials=")([^"]*)"/g, (_, a, v) => {
      anonymous(found, "author", v, "A");
      return `${a}A"`;
    })
    .replace(/(\sproviderId=")[^"]*"/g, (_, a) => `${a}None"`);
}
function cleanSheetComments(text, found) {
  return text.replace(/<author>([^<]*)<\/author>/g, (_, v) => {
    anonymous(found, "author", v, "Author");
    return "<author>Author</author>";
  });
}
// Excel's hint of the folder the workbook was last saved in.
function cleanAbsPath(text, found) {
  return text.replace(
    /<mc:AlternateContent\b[^>]*>\s*<mc:Choice\s+Requires="x15ac"\s*>\s*<x15ac:absPath\b[^>]*\/>\s*<\/mc:Choice>\s*<\/mc:AlternateContent>/g,
    () => {
      found.add("paths");
      return "";
    },
  );
}
// A minimal EXIF that says only how to turn the picture: embedded photos
// keep their orientation, because Office draws them as the file says.
function orientationTiff(orientation) {
  return Uint8Array.of(0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0, 0, 0, 0, 0);
}
function withJpegOrientation(jpeg, orientation) {
  const tiff = orientationTiff(orientation);
  const app1 = concat([Uint8Array.of(0xff, 0xe1, 0, 8 + tiff.length), ascii("Exif\0\0"), tiff]);
  const at = jpeg[2] === 0xff && jpeg[3] === 0xe0 ? 4 + be16(jpeg, 4) : 2;
  return concat([jpeg.subarray(0, at), app1, jpeg.subarray(at)]);
}
function withPngOrientation(png, orientation) {
  const body = concat([ascii("eXIf"), orientationTiff(orientation)]);
  const chunk = concat([u32be(body.length - 4), body, u32be(crc32(body))]);
  const at = 8 + 12 + be32(png, 8);
  return concat([png.subarray(0, at), chunk, png.subarray(at)]);
}
function cleanEmbeddedImage(raw, found) {
  const kind = imageKind(raw);
  if (!kind || kind === "heic") return raw;
  const r = STRIP[kind](raw);
  if (r.orientation > 1 && kind === "webp") return raw;
  merge(found, r.found);
  if (r.orientation > 1 && kind === "jpeg") return withJpegOrientation(r.bytes, r.orientation);
  if (r.orientation > 1 && kind === "png") return withPngOrientation(r.bytes, r.orientation);
  return r.bytes;
}
function officeRule(name, extension) {
  if (name === "docProps/core.xml") return cleanCoreXml;
  if (name === "docProps/app.xml") return cleanAppXml;
  if (name === "docProps/custom.xml") return cleanCustomXml;
  if (/^(word|ppt|xl)\/media\/[^/]+$/.test(name) || /^docProps\/thumbnail\.\w+$/.test(name)) return "media";
  if (extension === "docx" && /^word\/[^/]+\.xml$/.test(name)) return cleanWordXml;
  if (extension === "docx" && name === "word/_rels/settings.xml.rels") return cleanTemplateRel;
  if (extension === "pptx" && /^ppt\/(commentAuthors|authors)\.xml$/.test(name)) return cleanPeople;
  if (extension === "xlsx" && /^xl\/persons\/[^/]+\.xml$/.test(name)) return cleanPeople;
  if (extension === "xlsx" && /^xl\/comments\d*\.xml$/.test(name)) return cleanSheetComments;
  if (extension === "xlsx" && name === "xl/workbook.xml") return cleanAbsPath;
  return null;
}
// Archive-level details zipEntries doesn't return: entry timestamps (Office
// writes 1980-01-01; other tools write when the file was saved), extra
// fields holding times or owner ids, and a comment.
const DOS_DATE = 0x21;
function archiveDetails(b, found) {
  let end = -1;
  for (let p = b.length - 22; p >= Math.max(0, b.length - 65557); p--)
    if (le32(b, p) === 0x06054b50 && p + 22 + le16(b, p + 20) === b.length) {
      end = p;
      break;
    }
  if (le16(b, end + 20)) found.add("comments");
  const extras = (from, length) => {
    for (let q = from; q + 4 <= from + length; q += 4 + le16(b, q + 2)) {
      const id = le16(b, q);
      if (id === 0x5455 || id === 0x000a || id === 0x5855) found.add("dates");
      else if (id === 0x7875 || id === 0x7855) found.add("other");
    }
  };
  let pos = le32(b, end + 16);
  for (let i = le16(b, end + 10); i > 0; i--) {
    const time = le16(b, pos + 12),
      date = le16(b, pos + 14),
      nl = le16(b, pos + 28),
      el = le16(b, pos + 30),
      cl = le16(b, pos + 32),
      at = le32(b, pos + 42);
    if (time !== 0 || (date !== DOS_DATE && date !== 0)) found.add("dates");
    if (cl) found.add("comments");
    extras(pos + 46 + nl, el);
    extras(at + 30 + le16(b, at + 26), le16(b, at + 28));
    pos += 46 + nl + el + cl;
  }
}
function writeZip(files) {
  const parts = [],
    central = [];
  let offset = 0;
  for (const f of files) {
    const name = encoder.encode(f.name),
      flags = /[^\x00-\x7f]/.test(f.name) ? 0x800 : 0;
    const head = new Uint8Array(30 + name.length),
      v = new DataView(head.buffer);
    v.setUint32(0, 0x04034b50, true);
    v.setUint16(4, 20, true);
    v.setUint16(6, flags, true);
    v.setUint16(8, f.method, true);
    v.setUint16(10, 0, true);
    v.setUint16(12, DOS_DATE, true);
    v.setUint32(14, f.crc, true);
    v.setUint32(18, f.data.length, true);
    v.setUint32(22, f.length, true);
    v.setUint16(26, name.length, true);
    head.set(name, 30);
    const entry = new Uint8Array(46 + name.length),
      c = new DataView(entry.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, 20, true);
    c.setUint16(6, 20, true);
    c.setUint16(8, flags, true);
    c.setUint16(10, f.method, true);
    c.setUint16(12, 0, true);
    c.setUint16(14, DOS_DATE, true);
    c.setUint32(16, f.crc, true);
    c.setUint32(20, f.data.length, true);
    c.setUint32(24, f.length, true);
    c.setUint16(28, name.length, true);
    c.setUint32(42, offset, true);
    entry.set(name, 46);
    parts.push(head, f.data);
    central.push(entry);
    offset += head.length + f.data.length;
  }
  const directory = concat(central);
  const tail = new Uint8Array(22),
    t = new DataView(tail.buffer);
  t.setUint32(0, 0x06054b50, true);
  t.setUint16(8, files.length, true);
  t.setUint16(10, files.length, true);
  t.setUint32(12, directory.length, true);
  t.setUint32(16, offset, true);
  return concat([...parts, directory, tail]);
}
export async function browserDeflate(bytes) {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}
// { bytes, details, changed }. With `inspectOnly` only { details }: what a
// chat attachment, whose text alone is sent, keeps on the device.
export async function cleanOffice(input, extension, { inflate = browserInflate, deflate = browserDeflate, inspectOnly = false } = {}) {
  if (!OFFICE_EXTENSIONS.includes(extension)) bad("Choose DOCX, XLSX or PPTX.");
  const bytes = u8(input);
  const entries = zipEntries(bytes);
  const found = new Set();
  archiveDetails(bytes, found);
  const rebuild = found.size > 0;
  const changed = new Map();
  for (const [name, e] of entries) {
    const rule = officeRule(name, extension);
    if (!rule) continue;
    const raw = e.method === 0 ? e.bytes : await inflate(e.bytes, e.length);
    if (raw.length !== e.length || crc32(raw) !== e.checksum) bad("An Office entry is damaged.");
    if (rule === "media") {
      const next = cleanEmbeddedImage(raw, found);
      if (!sameBytes(next, raw)) changed.set(name, next);
      continue;
    }
    const text = textBytes(raw);
    const next = rule(text, found);
    if (next === text) continue;
    parseOfficeXML(next);
    changed.set(name, encoder.encode(next));
  }
  const details = detailList(found);
  if (inspectOnly) return { details };
  if (!changed.size && !rebuild) return { bytes, details, changed: false };
  const files = [];
  for (const [name, e] of entries) {
    const raw = changed.get(name);
    if (!raw) {
      files.push({ name, method: e.method, crc: e.checksum, length: e.length, data: e.bytes });
      continue;
    }
    const packed = deflate ? await deflate(raw) : null;
    const smaller = packed && packed.length < raw.length;
    files.push({ name, method: smaller ? 8 : 0, crc: crc32(raw), length: raw.length, data: smaller ? packed : raw });
  }
  const out = writeZip(files);
  zipEntries(out);
  return { bytes: out, details, changed: true };
}

// What a PDF attached to a chat keeps on the device, from pdf.js's
// getMetadata(): the info dictionary (non-standard keys arrive in a Custom
// map) and the XMP metadata, iterable as [name, value] pairs.
const PDF_INFO = {
  Author: "author", Creator: "software", Producer: "software", CreationDate: "dates",
  ModDate: "dates", Title: "titles", Subject: "titles", Keywords: "titles",
};
export function pdfDetails(meta) {
  const info = meta?.info || {};
  const found = new Set();
  for (const [key, kind] of Object.entries(PDF_INFO))
    if (typeof info[key] === "string" && info[key].trim()) found.add(kind);
  const custom = info.Custom;
  if (custom instanceof Map ? custom.size : custom && Object.keys(custom).length) found.add("custom");
  const xmp = meta?.metadata;
  if (xmp && typeof xmp[Symbol.iterator] === "function") {
    const names = [...xmp].map(([name]) => name);
    if (names.length) {
      const kinds = readXmp(names.join(" "));
      kinds.delete("other");
      merge(found, kinds);
    }
  }
  return detailList(found);
}

// ---- audio ----

const ID3_GROUPS = {
  titles: "TIT1 TIT2 TIT3 TALB TCON TRCK TPOS TKEY TLAN TMOO TSOA TSOT TSOP TSO2 TSOC TSST TSRC GRP1 MVNM MVIN TT1 TT2 TT3 TAL TCO TRK TPA TKE TLA",
  author: "TPE1 TPE2 TPE3 TPE4 TCOM TEXT TOLY TOPE TOWN TCOP TPUB TRSN TRSO TIPL TMCL IPLS WOAR WCOP WPUB WORS WOAS WOAF WCOM WPAY TP1 TP2 TP3 TP4 TCM TXT TOL TOA TCR TPB IPL WAR WCP WPB WAS WAF WCM",
  dates: "TDRC TDEN TDOR TDRL TDTG TYER TDAT TIME TORY TRDA TYE TDA TIM TOR TRD",
  pictures: "APIC PIC",
  comments: "COMM USLT SYLT COM ULT SLT",
  software: "TSSE TENC TFLT TMED TSS TEN TFT TMT",
};
const ID3 = Object.fromEntries(
  Object.entries(ID3_GROUPS).flatMap(([kind, ids]) => ids.split(" ").map((id) => [id, kind])),
);
// One ID3v2 tag at p: its frames' kinds go into found; returns its length.
function readId3(b, p, found) {
  const version = b[p + 3],
    flags = b[p + 5],
    size = syncsafe(b, p + 6);
  if (version < 2 || version > 4) bad("Unsupported ID3 tag.");
  const total = 10 + size + (flags & 0x10 ? 10 : 0);
  if (p + total > b.length) bad("The ID3 tag runs past the end of the file.");
  const short = version === 2,
    header = short ? 6 : 10,
    end = p + 10 + size;
  let q = p + 10;
  if (flags & 0x40 && !short) q += version === 4 ? syncsafe(b, q) : be32(b, q) + 4;
  while (q + header <= end) {
    const id = latin1(b, q, q + (short ? 3 : 4));
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break;
    const length = short
      ? (b[q + 3] << 16) | (b[q + 4] << 8) | b[q + 5]
      : version === 4
        ? syncsafe(b, q + 4)
        : be32(b, q + 4);
    if (id !== "TLEN" && id !== "TLE") found.add(ID3[id] || "other");
    q += header + length;
  }
  return total;
}
function skipId3(b, found) {
  let p = 0;
  while (startsWith(b, p, "ID3") && p + 10 <= b.length) p += readId3(b, p, found);
  return p;
}
// ID3v1 (and Enhanced TAG+) and APEv2 tags at the end of the file.
function tailTags(b, start, found) {
  let end = b.length;
  const filled = (from, length) => b.subarray(from, from + length).some((x) => x !== 0 && x !== 0x20);
  if (end - start >= 128 && startsWith(b, end - 128, "TAG")) {
    const t = end - 128;
    if (filled(t + 3, 30) || filled(t + 63, 30)) found.add("titles");
    if (filled(t + 33, 30)) found.add("author");
    if (filled(t + 93, 4)) found.add("dates");
    if (filled(t + 97, b[t + 125] === 0 ? 28 : 30)) found.add("comments");
    end = t;
    if (end - start >= 227 && startsWith(b, end - 227, "TAG+")) end -= 227;
  }
  if (end - start >= 32 && startsWith(b, end - 32, "APETAGEX")) {
    const size = le32(b, end - 32 + 12),
      total = size + (le32(b, end - 32 + 20) & 0x80000000 ? 32 : 0);
    if (end - total >= start) {
      const items = latin1(b, end - total, end).toLowerCase(),
        ape = new Set();
      if (/artist|composer|copyright|publisher/.test(items)) ape.add("author");
      if (/title|album|genre|track/.test(items)) ape.add("titles");
      if (/year|date/.test(items)) ape.add("dates");
      if (/comment/.test(items)) ape.add("comments");
      if (/cover art/.test(items)) ape.add("pictures");
      merge(found, ape.size ? ape : ["other"]);
      end -= total;
    }
  }
  return end;
}
function stripMp3(b) {
  const found = new Set();
  let start = skipId3(b, found);
  while (start < b.length && b[start] === 0) start++;
  if (!(b[start] === 0xff && (b[start + 1] & 0xe0) === 0xe0)) bad("No MPEG audio after the tags.");
  const end = tailTags(b, start, found);
  return { bytes: b.slice(start, end), found };
}
const RIFF_INFO = {
  IART: "author", IENG: "author", ICOP: "author", ICMS: "author", ICRD: "dates",
  ISFT: "software", ITCH: "software", ICMT: "comments", ISBJ: "comments",
  INAM: "titles", IPRD: "titles", IGNR: "titles", IKEY: "titles", ITRK: "titles", IPRT: "titles",
};
// Chunks that carry no personal detail; dropped without a mention.
const WAV_SILENT = new Set(["cue ", "smpl", "inst", "PEAK", "JUNK", "junk", "PAD ", "FLLR", "fake", "regn", "umid"]);
function wavChunk(id, body, found) {
  if (id === "LIST" && startsWith(body, 0, "INFO")) {
    for (let q = 4; q + 8 <= body.length; ) {
      const sub = latin1(body, q, q + 4),
        size = le32(body, q + 4);
      if (size) found.add(RIFF_INFO[sub] || "other");
      q += 8 + size + (size & 1);
    }
  } else if (id === "LIST") found.add(startsWith(body, 0, "adtl") ? "comments" : "other");
  else if (id === "bext") {
    found.add("author");
    found.add("dates");
  } else if (id === "id3 " || id === "ID3 ") {
    if (startsWith(body, 0, "ID3")) readId3(body, 0, found);
    else found.add("other");
  } else if (id === "_PMX") merge(found, readXmp(utf8.decode(body)));
  else if (!WAV_SILENT.has(id)) found.add("other");
}
function stripWav(b) {
  if (!startsWith(b, 0, "RIFF") || !startsWith(b, 8, "WAVE")) bad("This isn't a WAV file.");
  const end = 8 + le32(b, 4);
  if (end > b.length) bad("The WAV file is incomplete.");
  const kept = [],
    found = new Set();
  let p = 12,
    format = false,
    audio = false;
  while (p + 8 <= end) {
    const id = latin1(b, p, p + 4),
      size = le32(b, p + 4);
    if (p + 8 + size > end) bad("A WAV chunk runs past the end of the file.");
    const next = Math.min(end, p + 8 + size + (size & 1));
    if (id === "fmt " || id === "fact" || id === "data") {
      kept.push(b.subarray(p, next));
      format ||= id === "fmt ";
      audio ||= id === "data";
    } else wavChunk(id, b.subarray(p + 8, p + 8 + size), found);
    p = next;
  }
  if (!format || !audio) bad("The WAV file has no audio.");
  if (end < b.length) found.add("other");
  const body = concat(kept);
  return { bytes: concat([ascii("RIFF"), u32le(body.length + 4), ascii("WAVE"), body]), found };
}
const VORBIS = {
  ARTIST: "author", ALBUMARTIST: "author", COMPOSER: "author", PERFORMER: "author",
  CONDUCTOR: "author", LYRICIST: "author", COPYRIGHT: "author", ORGANIZATION: "author",
  LABEL: "author", CONTACT: "author", TITLE: "titles", ALBUM: "titles", GENRE: "titles",
  TRACKNUMBER: "titles", TRACKTOTAL: "titles", DISCNUMBER: "titles", DISCTOTAL: "titles",
  VERSION: "titles", DESCRIPTION: "comments", COMMENT: "comments", LYRICS: "comments",
  DATE: "dates", YEAR: "dates", ORIGINALDATE: "dates", ENCODER: "software",
  ENCODED_BY: "software", "ENCODED-BY": "software", ENCODING: "software",
  LOCATION: "location", METADATA_BLOCK_PICTURE: "pictures", COVERART: "pictures",
};
function vorbisComments(d, found) {
  if (d.length < 8) return found.add("other");
  const vendor = le32(d, 0);
  if (vendor) found.add("software");
  let q = 4 + vendor;
  const count = q + 4 <= d.length ? le32(d, q) : 0;
  q += 4;
  for (let i = 0; i < count && q + 4 <= d.length; i++) {
    const length = le32(d, q);
    const field = utf8.decode(d.subarray(q + 4, Math.min(d.length, q + 4 + length)));
    const key = field.split("=")[0].toUpperCase();
    if (!key.startsWith("REPLAYGAIN_")) found.add(VORBIS[key] || "other");
    q += 4 + length;
  }
}
function stripFlac(b) {
  const found = new Set();
  const start = skipId3(b, found);
  if (!startsWith(b, start, "fLaC")) bad("This isn't a FLAC file.");
  const kept = [];
  let p = start + 4,
    last = false;
  while (!last) {
    if (p + 4 > b.length) bad("The FLAC file is incomplete.");
    last = !!(b[p] & 0x80);
    const type = b[p] & 0x7f,
      length = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    if (type === 127 || p + 4 + length > b.length) bad("Malformed FLAC metadata.");
    // Stream information, seek table and cue sheet stay.
    if (type === 0 || type === 3 || type === 5) kept.push(b.slice(p, p + 4 + length));
    else if (type === 4) vorbisComments(b.subarray(p + 4, p + 4 + length), found);
    else if (type === 6) found.add("pictures");
    else if (type !== 1) found.add("other");
    p += 4 + length;
  }
  if (!kept.length || (kept[0][0] & 0x7f) !== 0) bad("The FLAC file has no stream information.");
  kept.forEach((block, i) => {
    block[0] = (block[0] & 0x7f) | (i === kept.length - 1 ? 0x80 : 0);
  });
  if (!(b[p] === 0xff && (b[p + 1] & 0xfe) === 0xf8)) bad("No FLAC audio after the metadata.");
  const end = tailTags(b, p, found);
  return { bytes: concat([ascii("fLaC"), ...kept, b.subarray(p, end)]), found };
}
const MP4_TAGS = {
  "\xa9ART": "author", aART: "author", "\xa9wrt": "author", cprt: "author", "\xa9aut": "author",
  "\xa9nam": "titles", "\xa9alb": "titles", "\xa9gen": "titles", gnre: "titles", trkn: "titles",
  disk: "titles", "\xa9grp": "titles", keyw: "titles", "\xa9day": "dates", "\xa9too": "software",
  "\xa9enc": "software", "\xa9swr": "software", "\xa9cmt": "comments", desc: "comments",
  ldes: "comments", "\xa9lyr": "comments", covr: "pictures", "\xa9xyz": "location",
  "\xa9mak": "camera", "\xa9mod": "camera", "location.ISO6709": "location",
  "quicktime.make": "camera", "quicktime.model": "camera", "quicktime.creationdate": "dates",
  "quicktime.software": "software", "quicktime.author": "author", "quicktime.artist": "author",
};
function mp4Meta(d, found) {
  const before = found.size;
  for (const [tag, kind] of Object.entries(MP4_TAGS)) if (indexOf(d, tag) >= 0) found.add(kind);
  if (found.size === before && d.some((x) => x !== 0)) found.add("other");
}
const XMP_UUID = "\xbe\x7a\xcf\xcb\x97\xa9\x42\xe8\x9c\x71\x99\x94\x91\xe3\xaf\xac";
// Creation and modification times in mvhd, tkhd and mdhd become 0 (unknown).
function zeroTimes(b, q, end, found) {
  const wide = b[q] === 1,
    width = wide ? 8 : 4;
  if (q + 4 + 2 * width > end) bad("Malformed MP4 header.");
  const span = b.subarray(q + 4, q + 4 + 2 * width);
  if (span.some((x) => x !== 0)) found.add("dates");
  span.fill(0);
}
function walkMp4(b, start, end, depth, found) {
  let p = start;
  while (p + 8 <= end) {
    let size = be32(b, p),
      header = 8;
    const type = latin1(b, p + 4, p + 8);
    if (size === 1) {
      if (p + 16 > end) bad("Malformed MP4 box.");
      size = be32(b, p + 8) * 2 ** 32 + be32(b, p + 12);
      header = 16;
    } else if (size === 0) size = end - p;
    if (size < header || p + size > end) bad("Malformed MP4 box.");
    if (type === "udta" || type === "meta" || (type === "uuid" && startsWith(b, p + header, XMP_UUID))) {
      if (type === "uuid") merge(found, readXmp(utf8.decode(b.subarray(p + header + 16, p + size))));
      else mp4Meta(b.subarray(p + header, p + size), found);
      // The same number of bytes as a 'free' box, so every offset into the
      // file (the sample tables point into mdat) stays right.
      b.set(ascii("free"), p + 4);
      b.fill(0, p + header, p + size);
    } else if (type === "mvhd" || type === "tkhd" || type === "mdhd") zeroTimes(b, p + header, p + size, found);
    else if ((type === "moov" || type === "trak" || type === "mdia") && depth < 8) walkMp4(b, p + header, p + size, depth + 1, found);
    p += size;
  }
  if (depth > 0 && p !== end) bad("Malformed MP4 box.");
}
function stripM4a(b) {
  if (!startsWith(b, 4, "ftyp")) bad("This isn't an M4A file.");
  const out = b.slice();
  const found = new Set();
  walkMp4(out, 0, out.length, 0, found);
  return { bytes: out, found };
}
export function cleanAudio(input, extension) {
  const b = u8(input);
  const strip = { mp3: stripMp3, wav: stripWav, flac: stripFlac, m4a: stripM4a }[extension];
  if (!strip) bad("Metadata can't be removed from this audio format.");
  const r = strip(b);
  return { bytes: r.bytes, details: detailList(r.found) };
}

// ---- any upload ----

// { status, bytes, type?, details, ... }. status: "off" (the update isn't
// released), "kept" (Keep original), "none" (plain text: nothing to remove),
// "cleaned" (details removed), "clean" (checked, nothing found) or "failed"
// (can't be cleaned safely: bytes is null and the user chooses).
export async function cleanUpload(input, { name = "", enabled = true, keepOriginal = false, reencode, inflate, deflate, maxBytes } = {}) {
  const bytes = u8(input);
  if (!enabled) return { status: "off", bytes, details: [] };
  if (keepOriginal) return { status: "kept", bytes, details: [] };
  const extension = extensionOf(name).slice(1);
  try {
    if (DOCUMENT_KINDS["." + extension] === "text") return { status: "none", bytes, details: [] };
    let r;
    if (imageKind(bytes)) r = await cleanImage(bytes, { reencode, maxBytes });
    else if (OFFICE_EXTENSIONS.includes(extension)) r = await cleanOffice(bytes, extension, { inflate, deflate });
    else if (AUDIO_EXTENSIONS.includes(extension)) r = cleanAudio(bytes, extension);
    else bad("Metadata can't be removed from this format.");
    return { ...r, status: r.details.length ? "cleaned" : "clean" };
  } catch (e) {
    return { status: "failed", bytes: null, details: [], reason: e?.message || "" };
  }
}

// ---- the composer's reference images (browser) ----

function dataUrl(bytes, type) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(binary)}`;
}
// An attachment for the composer: { name, url, cleanUrl, originalUrl,
// clean, keep }, where url is what Send uses (null until the user chooses
// when the image can't be cleaned), or { error } when it can't be used.
export async function prepareImageAttachment(file, { reencode, maxBytes = IMAGE_LIMIT } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const heic = imageKind(bytes) === "heic" || isHeicFile(file);
  const original = heic ? null : dataUrl(bytes, file.type || "image/jpeg");
  const r = await cleanUpload(bytes, { name: file.name, reencode, maxBytes });
  if (r.status === "failed") {
    if (heic) return { error: `"${file.name}" can't be opened in this browser. Save it as JPEG, then attach it.` };
    return { name: file.name, url: null, cleanUrl: null, originalUrl: original, clean: { status: "failed", details: [] }, keep: false };
  }
  if (r.bytes.length > maxBytes) return { error: `"${file.name}" is larger than 1.5 MiB.` };
  const clean = dataUrl(r.bytes, r.type);
  return {
    name: file.name,
    url: clean,
    cleanUrl: clean,
    originalUrl: original,
    clean: { status: r.status, details: r.details, converted: !!r.converted },
    keep: false,
  };
}
