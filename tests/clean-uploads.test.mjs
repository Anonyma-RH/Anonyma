import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateRawSync, deflateSync, inflateRawSync, inflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATES, parseReleased, releaseInfo, featuresFor } from "../server/releases.js";
import { audioType, inspectFile } from "../server/files.js";
import { isReleased } from "../src/lib.js";
import { crc32, zipEntries } from "../src/file-formats.js";
import {
  cleanUpload,
  cleanImage,
  cleanOffice,
  cleanAudio,
  cleanNote,
  stripJpeg,
  stripPng,
  stripWebp,
  stripGif,
  readExif,
  heicDetails,
  imageKind,
  orientationTransform,
  pdfDetails,
  prepareImageAttachment,
  withKeep,
  detailText,
} from "../src/clean-uploads.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// ---- fixture helpers -------------------------------------------------------
// Every fixture is built here from synthetic values: an invented camera,
// person, place and company, never a real photo or document.

const sha = (b) => createHash("sha256").update(b).digest("hex");
const buf = (x) => (typeof x === "string" ? Buffer.from(x, "latin1") : Buffer.from(x));
const cat = (...parts) => Buffer.concat(parts.map(buf));
const has = (b, s) => Buffer.from(b).includes(Buffer.from(s, "latin1"));
const u16be = (n) => Buffer.from([n >> 8, n & 255]);
const u32be = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u32le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};

// A 24x16 baseline JPEG (a test pattern) with only its JFIF header: the
// "clean" image every photo fixture below is built from.
const BASE_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDAAgICAkICQsLCwsLCw0MDQ0NDQ0NDQ0NDQ0ODg4REREODg4NDQ4OEBARERITEhERERET" +
    "ExQUFBgYFxccHB0iIin/xAB1AAADAQEAAAAAAAAAAAAAAAAGBQcECAEBAQEAAAAAAAAAAAAAAAAAAwQFEAABAwMEAQIHAQEAAAAA" +
    "AAABAgMEESEFABIGEzIiMRYVg8SRYdRWRhEAAgMAAgEEAwEAAAAAAAAAAQIDBBEFEgAiUTEhEwYkFP/AABEIABAAGAMBIgACEQAD" +
    "EQD/2gAMAwEAAhEDEQA/ABDhkNHySbMJqtL5ZQKD01DBUqvvUhW21LVF66L+Af8AT/T+71k4lAgtcfksJycZxS3u5VC3VFQ0NpSH" +
    "ibFAvbzFtMMC2nDx807FWMmqTt7WmPKNTv8APrLxvuPuE+J0lq1U5P8AV+T42nptSvWOPG8MZZLkDt2sTKkAxVObIPYfZ8C5dlp1" +
    "ZqvINJ+Y3bArgI0qCt/iiSICSFWjA79zhbfssfnfGvGcw7F5QmCQXG5oU0mqyOgtxVSNyE3BCuspUn03UFVtQ2XXOeEfnLzbOUbx" +
    "0lxyIpTi4aEuKXRyI4wNyg0VI89wJbvSn71TPjDM/wCZyH5f/i1LWp2qMEUNjr3VAPTJHKAPYPGzKRu/B83IeFlkp8e1aOBf4KIm" +
    "yaBNnWtGrkhnGk4PVmMPUCd3z//Z",
  "base64",
);

// A minimal big-endian EXIF (TIFF) writer: IFD0, an Exif sub-IFD, a GPS
// IFD and an IFD1 thumbnail. Entries are [tag, type, value] with types
// 1 BYTE, 2 ASCII, 3 SHORT, 5 RATIONAL.
function exifTiff({ ifd0 = [], exif = [], gps = [], thumbnail = null }) {
  const entry = ([tag, type, value]) => {
    let data;
    if (type === 1) data = Buffer.from(value);
    if (type === 2) data = Buffer.from(value + "\0", "latin1");
    if (type === 3) data = Buffer.concat(value.map(u16be));
    if (type === 5) data = Buffer.concat(value.flatMap(([n, d]) => [u32be(n), u32be(d)]));
    return { tag, type, count: type === 2 || type === 1 ? data.length : value.length, data };
  };
  const i0 = ifd0.map(entry),
    ie = exif.map(entry),
    ig = gps.map(entry);
  if (ie.length) i0.push({ tag: 0x8769, type: 4, count: 1, ptr: "exif" });
  if (ig.length) i0.push({ tag: 0x8825, type: 4, count: 1, ptr: "gps" });
  const i1 = thumbnail
    ? [
        { tag: 0x0201, type: 4, count: 1, ptr: "thumb" },
        { tag: 0x0202, type: 4, count: 1, data: u32be(thumbnail.length) },
      ]
    : null;
  const ifds = [["ifd0", i0], ...(i1 ? [["ifd1", i1]] : []), ...(ie.length ? [["exif", ie]] : []), ...(ig.length ? [["gps", ig]] : [])];
  for (const [, list] of ifds) list.sort((a, b) => a.tag - b.tag);
  const at = {};
  let offset = 8;
  for (const [name, list] of ifds) {
    at[name] = offset;
    offset += 2 + 12 * list.length + 4;
  }
  for (const [, list] of ifds)
    for (const e of list)
      if (!e.ptr && e.data.length > 4) {
        e.offset = offset;
        offset += e.data.length + (e.data.length % 2);
      }
  if (thumbnail) {
    at.thumb = offset;
    offset += thumbnail.length;
  }
  const out = Buffer.alloc(offset);
  out.write("MM", 0, "latin1");
  out.writeUInt16BE(42, 2);
  out.writeUInt32BE(8, 4);
  for (const [name, list] of ifds) {
    let p = at[name];
    out.writeUInt16BE(list.length, p);
    p += 2;
    for (const e of list) {
      out.writeUInt16BE(e.tag, p);
      out.writeUInt16BE(e.type, p + 2);
      out.writeUInt32BE(e.count, p + 4);
      if (e.ptr) out.writeUInt32BE(at[e.ptr], p + 8);
      else if (e.data.length > 4) {
        out.writeUInt32BE(e.offset, p + 8);
        e.data.copy(out, e.offset);
      } else e.data.copy(out, p + 8);
      p += 12;
    }
    out.writeUInt32BE(name === "ifd0" && i1 ? at.ifd1 : 0, p);
  }
  if (thumbnail) Buffer.from(thumbnail).copy(out, at.thumb);
  return out;
}
// A phone-style EXIF: invented make, model, serial, owner and coordinates.
const photoExif = (orientation = 1) =>
  exifTiff({
    ifd0: [
      [0x010f, 2, "Fixture Camera Co"],
      [0x0110, 2, "FX-1"],
      [0x0112, 3, [orientation]],
      [0x0131, 2, "Fixture Editor 1.0"],
      [0x0132, 2, "2024:01:02 03:04:05"],
      [0x013b, 2, "A. Fixture"],
    ],
    exif: [
      [0x829a, 5, [[1, 100]]],
      [0x9003, 2, "2024:01:02 03:04:05"],
      [0xa431, 2, "SN-FIXTURE-0001"],
      [0xa434, 2, "Fixture Lens 35mm"],
    ],
    gps: [
      [0x0000, 1, [2, 3, 0, 0]],
      [0x0001, 2, "N"],
      [0x0002, 5, [[12, 1], [34, 1], [56, 1]]],
      [0x0003, 2, "E"],
      [0x0004, 5, [[65, 1], [43, 1], [21, 1]]],
    ],
    thumbnail: BASE_JPEG,
  });
const XMP =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:exif="http://ns.adobe.com/exif/1.0/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">' +
  "<dc:creator><rdf:Seq><rdf:li>A. Fixture</rdf:li></rdf:Seq></dc:creator>" +
  "<exif:GPSLatitude>12,34.9N</exif:GPSLatitude>" +
  '<xmpMM:History><rdf:Seq><rdf:li xmlns:stEvt="http://ns.adobe.com/xap/1.0/sType/ResourceEvent#" stEvt:action="saved"/></rdf:Seq></xmpMM:History>' +
  "</rdf:Description></rdf:RDF></x:xmpmeta>";
// Photoshop image resources with IPTC By-line and City.
const IPTC = (() => {
  const iptc = cat("\x1c\x02\x50", u16be(10), "A. Fixture", "\x1c\x02\x5a", u16be(12), "Fixture City");
  return cat("Photoshop 3.0\0", "8BIM", u16be(0x0404), "\0\0", u32be(iptc.length), iptc, iptc.length % 2 ? "\0" : "");
})();
const jpegSegment = (marker, payload) => cat([0xff, marker], u16be(buf(payload).length + 2), payload);
// The base JPEG with metadata inserted after its JFIF header and, like a
// phone's multi-picture file, a second image after the end of the first.
function photo(orientation = 1) {
  const jfif = 4 + BASE_JPEG.readUInt16BE(4);
  return cat(
    BASE_JPEG.subarray(0, jfif),
    jpegSegment(0xe1, cat("Exif\0\0", photoExif(orientation))),
    jpegSegment(0xe1, cat("http://ns.adobe.com/xap/1.0/\0", XMP)),
    jpegSegment(0xed, IPTC),
    jpegSegment(0xfe, "Fixture comment"),
    BASE_JPEG.subarray(jfif),
    BASE_JPEG,
  );
}

// ffmpeg (a devDependency) decodes pixels and audio for the hash checks, and
// makes real encoder output. Those checks skip where it isn't installed.
const ffmpeg = (() => {
  try {
    const path = createRequire(import.meta.url)("@ffmpeg-installer/ffmpeg").path;
    execFileSync(path, ["-version"], { stdio: "ignore" });
    return path;
  } catch {
    return null;
  }
})();
const noFfmpeg = ffmpeg ? false : "ffmpeg is not installed";
function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-clean-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
// Decoded pixels (or PCM samples) as a hash.
function decodedHash(bytes, ext, args = ["-f", "rawvideo", "-pix_fmt", "rgb24"]) {
  return withTemp((dir) => {
    const file = join(dir, "in." + ext);
    writeFileSync(file, bytes);
    return sha(execFileSync(ffmpeg, ["-v", "error", "-i", file, ...args, "-"], { maxBuffer: 64 << 20 }));
  });
}
function ffmetadata(bytes, ext) {
  return withTemp((dir) => {
    const file = join(dir, "in." + ext);
    writeFileSync(file, bytes);
    return execFileSync(ffmpeg, ["-v", "error", "-i", file, "-f", "ffmetadata", "-"]).toString();
  });
}

// PNG: an RGBA encoder (filter 0) and a decoder for what it writes.
function pngChunk(type, data) {
  const body = cat(type, data);
  return cat(u32be(body.length - 4), body, u32be(crc32(body)));
}
function png(width, height, rgba, chunks = []) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) Buffer.from(rgba).copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const ihdr = cat(u32be(width), u32be(height), [8, 6, 0, 0, 0]);
  return cat("\x89PNG\r\n\x1a\n", pngChunk("IHDR", ihdr), ...chunks.map(([t, d]) => pngChunk(t, d)), pngChunk("IDAT", deflateSync(raw)), pngChunk("IEND", ""));
}
function pngChunks(b) {
  const list = [];
  for (let p = 8; p < b.length; ) {
    const length = b.readUInt32BE(p);
    list.push([b.toString("latin1", p + 4, p + 8), b.subarray(p + 8, p + 8 + length)]);
    p += 12 + length;
  }
  return list;
}
function decodePng(bytes) {
  const b = Buffer.from(bytes);
  const chunks = pngChunks(b);
  const ihdr = chunks.find(([t]) => t === "IHDR")[1];
  const width = ihdr.readUInt32BE(0),
    height = ihdr.readUInt32BE(4);
  const raw = inflateSync(Buffer.concat(chunks.filter(([t]) => t === "IDAT").map(([, d]) => d)));
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.equal(raw[y * (width * 4 + 1)], 0, "fixture rows use filter 0");
    raw.copy(pixels, y * width * 4, y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1));
  }
  return { width, height, pixels };
}
// Each pixel a distinct colour, so any move is visible.
function pattern(width, height) {
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) px.writeUInt32BE((((i + 1) * 0x010307) & 0xffffff) * 256 + 0xff, i * 4);
  return px;
}
// What the canvas does in browserReencode: drawImage through the
// orientation transform (pixel centres mapped by the matrix).
function drawOriented(src, orientation) {
  const t = orientationTransform(orientation, src.width, src.height);
  const [a, b, c, d, e, f] = t.matrix;
  const out = Buffer.alloc(t.width * t.height * 4);
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++) {
      const X = Math.floor(a * (x + 0.5) + c * (y + 0.5) + e),
        Y = Math.floor(b * (x + 0.5) + d * (y + 0.5) + f);
      assert.ok(X >= 0 && X < t.width && Y >= 0 && Y < t.height, "pixel lands on the canvas");
      src.pixels.copy(out, (Y * t.width + X) * 4, (y * src.width + x) * 4, (y * src.width + x + 1) * 4);
    }
  return { width: t.width, height: t.height, pixels: out };
}
// EXIF 2.3's definition of each orientation: the displayed pixel (x, y)
// comes from stored pixel S(sx, sy) of a w x h image.
const EXIF_ORIENTATION = {
  1: (x, y) => [x, y],
  2: (x, y, w) => [w - 1 - x, y],
  3: (x, y, w, h) => [w - 1 - x, h - 1 - y],
  4: (x, y, w, h) => [x, h - 1 - y],
  5: (x, y) => [y, x],
  6: (x, y, w, h) => [y, h - 1 - x],
  7: (x, y, w, h) => [w - 1 - y, h - 1 - x],
  8: (x, y, w) => [w - 1 - y, x],
};

// A ZIP writer for Office fixtures, with a save timestamp like most tools
// other than Office write. Entries are [name, text or bytes].
function zip(files, { time = 0x6c21, date = 0x5822 } = {}) {
  const locals = [],
    central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const raw = buf(typeof content === "string" ? Buffer.from(content, "utf8") : content);
    const packed = deflateRawSync(raw);
    const head = Buffer.alloc(30 + name.length);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(8, 8);
    head.writeUInt16LE(time, 10);
    head.writeUInt16LE(date, 12);
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(name.length, 26);
    head.write(name, 30, "latin1");
    const dir = Buffer.alloc(46 + name.length);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(time, 12);
    dir.writeUInt16LE(date, 14);
    dir.writeUInt32LE(crc32(raw), 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(raw.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    dir.write(name, 46, "latin1");
    locals.push(head, packed);
    central.push(dir);
    offset += head.length + packed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}
const entryText = (zipBytes, name) => {
  const e = zipEntries(zipBytes).get(name);
  return (e.method === 0 ? Buffer.from(e.bytes) : inflateRawSync(e.bytes)).toString("utf8");
};
const entryBytes = (zipBytes, name) => {
  const e = zipEntries(zipBytes).get(name);
  return e.method === 0 ? Buffer.from(e.bytes) : inflateRawSync(e.bytes);
};
const inflate = (bytes) => inflateRawSync(bytes);
const deflate = (bytes) => deflateRawSync(bytes);
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const CORE_XML =
  XML +
  '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
  "<dc:title>Fixture plan</dc:title><dc:creator>Jane Fixture</dc:creator><cp:lastModifiedBy>Jane Fixture</cp:lastModifiedBy><cp:revision>7</cp:revision>" +
  '<dcterms:created xsi:type="dcterms:W3CDTF">2024-01-02T03:04:05Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2024-01-03T03:04:05Z</dcterms:modified>' +
  "</cp:coreProperties>";
const APP_XML =
  XML +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  "<Template>Normal.dotm</Template><TotalTime>42</TotalTime><Pages>1</Pages><Application>Fixture Office Word</Application>" +
  "<Company>Fixture Company Ltd</Company><Manager>M. Fixture</Manager><AppVersion>16.0000</AppVersion></Properties>";
const CUSTOM_XML =
  XML +
  '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
  '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Client"><vt:lpwstr>Fixture Client</vt:lpwstr></property></Properties>';
const types = (main) =>
  XML +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpeg" ContentType="image/jpeg"/>' +
  `<Override PartName="/main.xml" ContentType="application/vnd.openxmlformats-officedocument.${main}"/></Types>`;
function docx() {
  return zip([
    ["[Content_Types].xml", types("wordprocessingml.document.main+xml")],
    ["docProps/core.xml", CORE_XML],
    ["docProps/app.xml", APP_XML],
    ["docProps/custom.xml", CUSTOM_XML],
    [
      "word/document.xml",
      XML +
        `<w:document ${W}><w:body><w:p><w:r><w:t>Quarterly fixture plan</w:t></w:r></w:p>` +
        '<w:p><w:ins w:id="1" w:author="Jane Fixture" w:date="2024-01-02T03:04:05Z"><w:r><w:t>An added line</w:t></w:r></w:ins></w:p></w:body></w:document>',
    ],
    [
      "word/comments.xml",
      XML +
        `<w:comments ${W}><w:comment w:id="0" w:author="Jane Fixture" w:date="2024-01-02T03:04:05Z" w:initials="JF"><w:p><w:r><w:t>Check this</w:t></w:r></w:p></w:comment></w:comments>`,
    ],
    [
      "word/people.xml",
      XML +
        '<w15:people xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"><w15:person w15:author="Jane Fixture"><w15:presenceInfo w15:providerId="AD" w15:userId="S::jane@fixture.invalid::0000"/></w15:person></w15:people>',
    ],
    ["word/fontTable.xml", XML + `<w:fonts ${W}><w:font w:name="Fixture Sans"/></w:fonts>`],
    [
      "word/_rels/settings.xml.rels",
      XML +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="file:///C:\\Users\\jfixture\\Templates\\Plan.dotm" TargetMode="External"/></Relationships>',
    ],
    ["word/media/image1.jpeg", photo(6)],
  ]);
}

// ---- images ----------------------------------------------------------------

test("a phone JPEG loses its location, camera, author, dates and extra image; the pixels stay byte for byte", async () => {
  const input = photo(1);
  assert.equal(readExif(photoExif(1)).found.has("location"), true, "the fixture carries GPS");
  const r = await cleanImage(input, { reencode: () => assert.fail("no redraw for an upright photo") });
  // Everything added to the base image is gone, and nothing else changed.
  assert.deepEqual(Buffer.from(r.bytes), BASE_JPEG);
  assert.equal(r.type, "image/jpeg");
  for (const secret of ["Fixture Camera Co", "SN-FIXTURE-0001", "A. Fixture", "Fixture City", "2024:01:02", "Exif", "GPSLatitude"])
    assert.ok(!has(r.bytes, secret), `removed: ${secret}`);
  assert.deepEqual(r.details, ["location", "camera", "author", "dates", "software", "history", "comments", "thumbnail", "other"]);
  const s = stripJpeg(r.bytes);
  assert.deepEqual([s.width, s.height], [24, 16]);
  assert.equal(cleanNote({ status: "cleaned", details: r.details }).text,
    "Removed: location, camera details, author, dates, software, edit history, comments, thumbnail, other details");
});

test("the cleaned JPEG decodes to the same pixels", { skip: noFfmpeg }, async () => {
  const input = photo(1);
  const r = await cleanImage(input);
  assert.equal(decodedHash(r.bytes, "jpg"), decodedHash(input, "jpg"));
  assert.equal(decodedHash(r.bytes, "jpg"), decodedHash(BASE_JPEG, "jpg"));
});

test("orientation: the canvas transform matches EXIF's definition of all eight orientations", () => {
  const src = { width: 5, height: 3, pixels: pattern(5, 3) };
  for (let o = 1; o <= 8; o++) {
    const out = drawOriented(src, o);
    assert.deepEqual([out.width, out.height], o >= 5 ? [3, 5] : [5, 3], `size for ${o}`);
    for (let y = 0; y < out.height; y++)
      for (let x = 0; x < out.width; x++) {
        const [sx, sy] = EXIF_ORIENTATION[o](x, y, src.width, src.height);
        assert.equal(
          out.pixels.readUInt32BE((y * out.width + x) * 4),
          src.pixels.readUInt32BE((sy * src.width + sx) * 4),
          `orientation ${o} at ${x},${y}`,
        );
      }
  }
});

test("orientation: a rotated photo is redrawn upright from a copy without its EXIF, then cleaned again", async () => {
  const calls = [];
  const reencode = async (bytes, options) => {
    calls.push({ bytes: Buffer.from(bytes), ...options });
    // A browser's encoder output, with a comment of its own.
    const jfif = 4 + BASE_JPEG.readUInt16BE(4);
    return { bytes: cat(BASE_JPEG.subarray(0, jfif), jpegSegment(0xfe, "encoder"), BASE_JPEG.subarray(jfif)), type: "image/jpeg" };
  };
  const r = await cleanImage(photo(6), { reencode });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].orientation, 6);
  assert.equal(calls[0].outType, "image/jpeg");
  assert.ok(calls[0].quality >= 0.92);
  // The decoder is handed the stripped copy: no EXIF left to rotate it twice.
  assert.deepEqual(calls[0].bytes, BASE_JPEG);
  assert.equal(r.rotated, true);
  assert.deepEqual(Buffer.from(r.bytes), BASE_JPEG, "the encoder's own comment is stripped too");
  assert.ok(r.details.includes("location"));
});

test("orientation: a PNG with EXIF orientation 6 comes out rotated, lossless, with no EXIF", async () => {
  const src = { width: 6, height: 4, pixels: pattern(6, 4) };
  const input = png(src.width, src.height, src.pixels, [["eXIf", photoExif(6)]]);
  const reencode = async (bytes, { orientation, outType }) => {
    assert.ok(!has(bytes, "eXIf"), "the decoder never sees the orientation");
    assert.equal(outType, "image/png");
    const drawn = drawOriented(decodePng(bytes), orientation);
    return { bytes: png(drawn.width, drawn.height, drawn.pixels, [["tEXt", "Software\0Canvas"]]), type: "image/png" };
  };
  const r = await cleanImage(input, { reencode });
  const out = decodePng(r.bytes);
  assert.deepEqual([out.width, out.height], [4, 6]);
  for (let y = 0; y < 6; y++)
    for (let x = 0; x < 4; x++) {
      const [sx, sy] = EXIF_ORIENTATION[6](x, y, 6, 4);
      assert.equal(out.pixels.readUInt32BE((y * 4 + x) * 4), src.pixels.readUInt32BE((sy * 6 + sx) * 4));
    }
  assert.deepEqual(pngChunks(Buffer.from(r.bytes)).map(([t]) => t), ["IHDR", "IDAT", "IEND"]);
  assert.ok(r.details.includes("location") && r.details.includes("camera"));
});

test("a PNG loses its text, XMP, EXIF and timestamp chunks; colour chunks and pixels stay", () => {
  const px = pattern(7, 5);
  const xmp = cat("XML:com.adobe.xmp\0\0\0\0\0", XMP);
  const input = png(7, 5, px, [
    ["gAMA", u32be(45455)],
    ["tEXt", "Author\0A. Fixture"],
    ["tEXt", "Creation Time\0Tue, 02 Jan 2024"],
    ["iTXt", xmp],
    ["eXIf", photoExif(1)],
    ["tIME", Buffer.from([7, 232, 1, 2, 3, 4, 5])],
    ["pHYs", cat(u32be(2835), u32be(2835), [1])],
  ]);
  const r = stripPng(input);
  assert.deepEqual(pngChunks(Buffer.from(r.bytes)).map(([t]) => t), ["IHDR", "gAMA", "pHYs", "IDAT", "IEND"]);
  assert.equal(sha(decodePng(r.bytes).pixels), sha(px));
  assert.deepEqual(
    [...r.found].sort(),
    ["author", "camera", "dates", "history", "location", "software", "thumbnail"].sort(),
  );
});

test("a WebP loses its EXIF and XMP chunks and flags; the image chunk is copied unchanged", async () => {
  // A 1x1 lossless WebP, extended with metadata the way cameras and editors write it.
  const simple = Buffer.from("UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==", "base64");
  const vp8l = simple.subarray(12);
  const chunk = (type, data) => cat(type, u32le(buf(data).length), data, buf(data).length % 2 ? "\0" : "");
  const body = cat(chunk("VP8X", [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]), vp8l, chunk("EXIF", photoExif(1)), chunk("XMP ", XMP));
  const input = cat("RIFF", u32le(body.length + 4), "WEBP", body);
  const r = await cleanImage(input, { reencode: () => assert.fail("no redraw") });
  const out = Buffer.from(r.bytes);
  assert.equal(r.type, "image/webp");
  assert.equal(out.readUInt32LE(4), out.length - 8);
  assert.ok(out.includes(vp8l), "the image data is untouched");
  assert.equal(out[20], 0, "the EXIF and XMP flags are cleared");
  assert.ok(!has(out, "EXIF") && !has(out, "XMP ") && !has(out, "Fixture"));
  assert.ok(r.details.includes("location") && r.details.includes("author"));
  if (ffmpeg) assert.equal(decodedHash(out, "webp", ["-f", "rawvideo", "-pix_fmt", "rgba"]), decodedHash(simple, "webp", ["-f", "rawvideo", "-pix_fmt", "rgba"]));
});

test("a GIF loses comment and XMP extensions; looping and frames stay", () => {
  const gif = Buffer.from("R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==", "base64");
  const loop = cat("\x21\xff\x0bNETSCAPE2.0\x03\x01\x00\x00\x00");
  // XMP in a GIF: raw text, then the 258-byte "magic trailer" that lets a
  // decoder read it as sub-blocks.
  const trailer = Buffer.from([1, ...Array.from({ length: 255 }, (_, i) => 255 - i), 0, 0]);
  const xmp = cat("\x21\xff\x0bXMP DataXMP", XMP, trailer);
  const comment = cat("\x21\xfe\x0fFixture comment\x00");
  const withMeta = cat(gif.subarray(0, 19), loop, comment, xmp, gif.subarray(19));
  const r = stripGif(withMeta);
  assert.deepEqual(Buffer.from(r.bytes), cat(gif.subarray(0, 19), loop, gif.subarray(19)));
  assert.ok(r.found.has("comments") && r.found.has("author") && r.found.has("location"));
});

test("HEIC is read for the chip and converted to a metadata-free JPEG where the browser can decode it", async () => {
  const heic = cat(u32be(24), "ftypheic", u32be(0), "mif1heic", "\0\0\0\x10meta", "Exif\0\0", photoExif(6));
  assert.equal(imageKind(heic), "heic");
  assert.ok(heicDetails(heic).has("location"));
  const seen = [];
  const r = await cleanImage(heic, {
    reencode: async (bytes, options) => {
      seen.push(options);
      return { bytes: photo(1), type: "image/jpeg" };
    },
  });
  // The decoder applies HEIC's own rotation, so no EXIF orientation is passed.
  assert.equal(seen[0].orientation, undefined);
  assert.equal(seen[0].outType, "image/jpeg");
  assert.equal(seen[0].quality, 0.92);
  assert.equal(r.converted, true);
  assert.deepEqual(Buffer.from(r.bytes), BASE_JPEG);
  assert.ok(r.details.includes("location"));
  // A browser that can't decode HEIC: the upload fails instead of sending it.
  const failed = await cleanUpload(heic, { name: "IMG_0001.HEIC", reencode: () => Promise.reject(new Error("decode")) });
  assert.equal(failed.status, "failed");
  assert.equal(failed.bytes, null);
});

test("an image that can't be parsed isn't guessed at: it fails and waits for the user", async () => {
  const truncated = photo(1).subarray(0, 300);
  const r = await cleanUpload(truncated, { name: "photo.jpg" });
  assert.equal(r.status, "failed");
  assert.equal(r.bytes, null);
  assert.deepEqual(cleanNote(r), { tone: "warn", text: "Metadata couldn't be removed from this file." });
});

// ---- Keep original and gating ----------------------------------------------

test("Keep original bypasses cleaning and says so", async () => {
  const input = photo(1);
  const kept = await cleanUpload(input, { name: "photo.jpg", keepOriginal: true, reencode: () => assert.fail() });
  assert.equal(kept.status, "kept");
  assert.equal(Buffer.compare(Buffer.from(kept.bytes), input), 0);
  assert.ok(has(kept.bytes, "SN-FIXTURE-0001"));
  assert.equal(cleanNote(kept, { keep: true }).text, "Original kept with its hidden details");
  // The composer's per-image switch: the original goes out, then the cleaned
  // copy again; an image that couldn't be cleaned has nothing to go back to.
  const item = { name: "photo.jpg", url: "clean", cleanUrl: "clean", originalUrl: "original", keep: false };
  assert.equal(withKeep(item, true).url, "original");
  assert.equal(withKeep(withKeep(item, true), false).url, "clean");
  assert.equal(withKeep({ ...item, url: null, cleanUrl: null }, false).url, null);
});

test("the composer attachment keeps both versions and is off by default", async () => {
  const file = new File([photo(1)], "photo.jpg", { type: "image/jpeg" });
  const item = await prepareImageAttachment(file);
  assert.equal(item.keep, false);
  assert.equal(item.url, item.cleanUrl);
  assert.equal(Buffer.from(item.cleanUrl.split(",")[1], "base64").compare(BASE_JPEG), 0);
  assert.ok(Buffer.from(item.originalUrl.split(",")[1], "base64").includes("SN-FIXTURE-0001"));
  assert.ok(item.url.startsWith("data:image/jpeg;base64,"));
  const broken = await prepareImageAttachment(new File([photo(1).subarray(0, 300)], "broken.jpg", { type: "image/jpeg" }));
  assert.equal(broken.url, null);
  assert.equal(broken.clean.status, "failed");
});

test("Clean Uploads is registered, off by default, and client-only", async () => {
  const update = UPDATES.find((u) => u.id === "cleanuploads");
  assert.ok(update, "expected a UPDATES entry with id 'cleanuploads'");
  assert.equal(update.title, "Clean Uploads");
  assert.equal(update.tagline, "Your files arrive without their hidden details.");
  assert.equal(update.points.length, 3);
  // Committed as false until its "Release …" commit flips it to true.
  assert.equal(typeof committed[UPDATES.indexOf(update)], "boolean");
  const config = (released) => ({ releases: releaseInfo({ released: parseReleased(released) }) });
  assert.equal(isReleased(config("mvp"), "cleanuploads"), false);
  assert.equal(isReleased(config("mvp,cleanuploads"), "cleanuploads"), true);
  assert.equal(isReleased(config("all"), "cleanuploads"), true);
  // Nothing on the server depends on it: cleaning happens before the
  // request exists, so no route is gated on it.
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  const req = { path: "/api/chat", method: "POST", body: { messages: [{ role: "user", content: [image] }] } };
  assert.ok(!featuresFor(req).includes("cleanuploads"));
  // While unreleased the upload goes out exactly as chosen.
  const input = photo(1);
  const off = await cleanUpload(input, { name: "photo.jpg", enabled: false });
  assert.equal(off.status, "off");
  assert.equal(Buffer.compare(Buffer.from(off.bytes), input), 0);
});

// ---- Office ------------------------------------------------------------------

test("a DOCX loses its author, company, dates, custom properties, paths and photo location; the server still reads it", async () => {
  const input = docx();
  const before = await inspectFile("plan.docx", input);
  const r = await cleanUpload(input, { name: "plan.docx", inflate, deflate });
  assert.equal(r.status, "cleaned");
  assert.deepEqual(r.details, ["location", "camera", "author", "company", "dates", "software", "history", "comments", "titles", "custom", "paths", "thumbnail", "other"]);
  const out = Buffer.from(r.bytes);
  // Still a valid package the server extracts the same text from.
  const after = await inspectFile("plan.docx", out);
  assert.equal(after.text, before.text);
  assert.match(after.text, /Quarterly fixture plan/);
  // Properties.
  assert.match(entryText(out, "docProps/core.xml"), /<cp:coreProperties [^>]*><\/cp:coreProperties>$/);
  const app = entryText(out, "docProps/app.xml");
  for (const gone of ["Company", "Manager", "Application", "AppVersion", "TotalTime", "Template"]) assert.ok(!app.includes(gone), gone);
  assert.match(app, /<Pages>1<\/Pages>/);
  assert.ok(!entryText(out, "docProps/custom.xml").includes("Fixture Client"));
  // Tracked changes and comments keep their text under a neutral author.
  const doc = entryText(out, "word/document.xml");
  assert.match(doc, /w:author="Author"/);
  assert.ok(!doc.includes("w:date="));
  assert.match(entryText(out, "word/comments.xml"), /w:initials="A"/);
  assert.ok(!entryText(out, "word/people.xml").includes("presenceInfo"));
  assert.match(entryText(out, "word/_rels/settings.xml.rels"), /Target="Plan\.dotm"/);
  // The embedded photo keeps only its orientation.
  const media = entryBytes(out, "word/media/image1.jpeg");
  const s = stripJpeg(media);
  assert.equal(s.orientation, 6);
  assert.deepEqual(Buffer.from(s.bytes), BASE_JPEG);
  assert.equal(readExif(media.subarray(media.indexOf("MM\0*", 0, "latin1"))).found.size, 0);
  // No entry anywhere still names the person, company, client or camera.
  for (const [name] of zipEntries(out)) {
    const text = entryBytes(out, name).toString("latin1");
    for (const secret of ["Jane Fixture", "jfixture", "Fixture Company", "Fixture Client", "SN-FIXTURE", "fixture.invalid", "2024-01-02"])
      assert.ok(!text.includes(secret), `${name} still has ${secret}`);
  }
  // Untouched entries are copied byte for byte; timestamps become Office's own.
  assert.equal(Buffer.compare(Buffer.from(zipEntries(out).get("word/fontTable.xml").bytes), Buffer.from(zipEntries(input).get("word/fontTable.xml").bytes)), 0);
  for (let p = out.indexOf(Buffer.from([0x50, 0x4b, 1, 2])); p >= 0; p = out.indexOf(Buffer.from([0x50, 0x4b, 1, 2]), p + 4))
    assert.deepEqual([out.readUInt16LE(p + 12), out.readUInt16LE(p + 14)], [0, 0x21]);
  // A second pass finds nothing left.
  const again = await cleanOffice(out, "docx", { inflate, deflate });
  assert.deepEqual(again.details, []);
  assert.equal(again.changed, false);
});

test("XLSX and PPTX: comment authors, people and the saved folder go; the server still reads them", async () => {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const xlsx = zip([
    ["[Content_Types].xml", types("spreadsheetml.sheet.main+xml")],
    [
      "xl/workbook.xml",
      XML +
        `<workbook ${S} xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"><mc:Choice Requires="x15ac"><x15ac:absPath url="C:\\Users\\jfixture\\Desktop\\" xmlns:x15ac="http://schemas.microsoft.com/office/spreadsheetml/2010/11/ac"/></mc:Choice></mc:AlternateContent><sheets><sheet name="Sheet1" sheetId="1"/></sheets></workbook>`,
    ],
    ["xl/worksheets/sheet1.xml", XML + `<worksheet ${S}><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Budget</t></is></c></row></sheetData></worksheet>`],
    ["xl/comments1.xml", XML + `<comments ${S}><authors><author>Jane Fixture</author></authors><commentList/></comments>`],
    ["xl/persons/person.xml", XML + '<personList xmlns="http://schemas.microsoft.com/office/spreadsheetml/2018/threadedcomments"><person displayName="Jane Fixture" id="{00000000-0000-0000-0000-000000000000}" userId="jane@fixture.invalid" providerId="AD"/></personList>'],
    ["docProps/core.xml", CORE_XML],
  ]);
  const x = await cleanUpload(xlsx, { name: "budget.xlsx", inflate, deflate });
  assert.equal(x.status, "cleaned");
  assert.ok(x.details.includes("paths") && x.details.includes("author"));
  assert.match((await inspectFile("budget.xlsx", Buffer.from(x.bytes))).text, /A1: Budget/);
  assert.ok(!entryText(x.bytes, "xl/workbook.xml").includes("absPath"));
  assert.match(entryText(x.bytes, "xl/comments1.xml"), /<author>Author<\/author>/);
  assert.match(entryText(x.bytes, "xl/persons/person.xml"), /displayName="Author" id="[^"]+" userId="Author" providerId="None"/);

  const P = 'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"';
  const pptx = zip([
    ["[Content_Types].xml", types("presentationml.presentation.main+xml")],
    ["ppt/slides/slide1.xml", XML + `<p:sld ${P}><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Roadmap</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`],
    ["ppt/commentAuthors.xml", XML + `<p:cmAuthorLst ${P}><p:cmAuthor id="0" name="Jane Fixture" initials="JF" lastIdx="1" clrIdx="0"/></p:cmAuthorLst>`],
    ["docProps/app.xml", APP_XML],
  ]);
  const p = await cleanUpload(pptx, { name: "deck.pptx", inflate, deflate });
  assert.match((await inspectFile("deck.pptx", Buffer.from(p.bytes))).text, /Roadmap/);
  assert.match(entryText(p.bytes, "ppt/commentAuthors.xml"), /name="Author" initials="A"/);
  assert.ok(p.details.includes("company"));
});

test("an Office file that can't be read safely is left alone and waits for the user", async () => {
  const damaged = docx().subarray(0, 400);
  const r = await cleanUpload(damaged, { name: "plan.docx", inflate, deflate });
  assert.equal(r.status, "failed");
  assert.equal(r.bytes, null);
  // A chat attachment only reports what stays behind, and never rewrites.
  const seen = await cleanOffice(docx(), "docx", { inflate, inspectOnly: true });
  assert.equal(seen.bytes, undefined);
  assert.ok(seen.details.includes("author") && seen.details.includes("company"));
  assert.equal(cleanNote({ status: "cleaned", details: ["author", "company"] }, { notSent: true }).text, "Not sent: author, company");
});

// ---- PDF -------------------------------------------------------------------

test("a PDF attached to a chat reports the details that stay on the device (pdf.js metadata)", async () => {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const xmp =
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:xmpMM="http://ns.adobe.com/xap/1.0/mm/">' +
    "<dc:creator><rdf:Seq><rdf:li>Jane Fixture</rdf:li></rdf:Seq></dc:creator><xmpMM:DocumentID>uuid:0000</xmpMM:DocumentID></rdf:Description></rdf:RDF></x:xmpmeta>";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Metadata 5 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] >>",
    "<< /Author (Jane Fixture) /Producer (Fixture PDF 2.1) /CreationDate (D:20240102030405Z) /Title (Fixture plan) /Client (Fixture Client) >>",
    `<< /Type /Metadata /Subtype /XML /Length ${xmp.length} >>\nstream\n${xmp}\nendstream`,
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((o, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => String(o).padStart(10, "0") + " 00000 n \n").join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const task = pdfjs.getDocument({ data: new TextEncoder().encode(pdf), isEvalSupported: false });
  const details = pdfDetails(await (await task.promise).getMetadata());
  await task.destroy();
  assert.deepEqual(details, ["author", "dates", "software", "history", "titles", "custom"]);
  assert.equal(detailText(details), "author, dates, software, edit history, titles and tags, custom properties");
  assert.deepEqual(pdfDetails({ info: { Title: "" } }), []);
});

// ---- audio -----------------------------------------------------------------

const mpegFrame = () => {
  const f = Buffer.alloc(417);
  f.set([0xff, 0xfb, 0x90, 0x00]);
  return f;
};
function id3v23(frames) {
  const body = Buffer.concat(frames.map(([id, data]) => cat(id, u32be(buf(data).length), "\0\0", data)));
  const size = body.length;
  return cat("ID3\x03\x00\x00", [(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127], body);
}

test("MP3: ID3v2 and ID3v1 tags go, the audio frames stay; the server still accepts it", () => {
  const audio = Buffer.concat([mpegFrame(), mpegFrame(), mpegFrame()]);
  const v1 = Buffer.alloc(128);
  v1.write("TAGFixture song", 0, "latin1");
  v1.write("A. Fixture", 33, "latin1");
  v1.write("2024", 93, "latin1");
  const input = cat(
    id3v23([["TIT2", "\0Fixture song"], ["TPE1", "\0A. Fixture"], ["TYER", "\x002024"], ["COMM", "\0eng\0Fixture note"], ["APIC", "\0image/jpeg\0\x03\0" + "x".repeat(20)], ["TSSE", "\0Fixture Encoder"]]),
    audio,
    v1,
  );
  const r = cleanAudio(input, "mp3");
  assert.deepEqual(Buffer.from(r.bytes), audio);
  assert.deepEqual(r.details, ["author", "dates", "software", "comments", "titles", "pictures"]);
  assert.equal(audioType(Buffer.from(r.bytes), "mp3"), "audio/mpeg");
});

test("WAV: INFO and broadcast chunks go, the format and samples stay", () => {
  const chunk = (id, data) => cat(id, u32le(buf(data).length), data, buf(data).length % 2 ? "\0" : "");
  const fmt = chunk("fmt ", cat([1, 0, 1, 0], u32le(8000), u32le(16000), [2, 0, 16, 0]));
  const data = chunk("data", Buffer.alloc(200, 7));
  const info = chunk("LIST", cat("INFO", chunk("IART", "A. Fixture\0"), chunk("ICRD", "2024-01-02\0"), chunk("ISFT", "Fixture Recorder\0")));
  const body = cat("WAVE", fmt, info, chunk("bext", Buffer.alloc(40, 1)), data);
  const r = cleanAudio(cat("RIFF", u32le(body.length), body), "wav");
  assert.deepEqual(Buffer.from(r.bytes), cat("RIFF", u32le(4 + fmt.length + data.length), "WAVE", fmt, data));
  assert.deepEqual(r.details, ["author", "dates", "software"]);
  assert.equal(audioType(Buffer.from(r.bytes), "wav"), "audio/wav");
});

test("FLAC: Vorbis comments and pictures go, stream info and frames stay", () => {
  const block = (type, data, last = false) => cat([(last ? 0x80 : 0) | type, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255], data);
  const streaminfo = Buffer.alloc(34, 3);
  const comments = ["ARTIST=A. Fixture", "DATE=2024-01-02", "LOCATION=Fixture City"];
  const vorbis = cat(u32le(7), "fixture", u32le(comments.length), ...comments.flatMap((c) => [u32le(c.length), c]));
  const frames = cat([0xff, 0xf8, 0x69, 0x08], Buffer.alloc(60, 5));
  const input = cat("fLaC", block(0, streaminfo), block(4, vorbis), block(6, Buffer.alloc(32)), block(1, Buffer.alloc(16), true), frames);
  const r = cleanAudio(input, "flac");
  assert.deepEqual(Buffer.from(r.bytes), cat("fLaC", block(0, streaminfo, true), frames));
  assert.deepEqual(r.details, ["location", "author", "dates", "software", "pictures"]);
});

test("M4A: tag boxes become free space of the same size and header dates are zeroed", () => {
  const box = (type, ...data) => {
    const body = cat(...data);
    return cat(u32be(body.length + 8), type, body);
  };
  const mvhd = box("mvhd", [0, 0, 0, 0], u32be(3786825600), u32be(3786825601), u32be(1000), u32be(5000), Buffer.alloc(80));
  const ilst = box("ilst", box("\xa9ART", box("data", u32be(1), u32be(0), "A. Fixture")), box("\xa9xyz", box("data", u32be(1), u32be(0), "+12.3456+065.4321/")));
  const udta = box("udta", box("meta", [0, 0, 0, 0], box("hdlr", Buffer.alloc(25)), ilst));
  const mdat = box("mdat", Buffer.alloc(64, 9));
  const input = cat(box("ftyp", "M4A ", u32be(0), "isomM4A "), box("moov", mvhd, udta), mdat);
  const r = cleanAudio(input, "m4a");
  const out = Buffer.from(r.bytes);
  assert.equal(out.length, input.length, "every offset into mdat stays right");
  assert.ok(out.subarray(out.length - mdat.length).equals(mdat));
  assert.ok(!has(out, "A. Fixture") && !has(out, "+12.3456") && !has(out, "udta"));
  assert.ok(has(out, "free"));
  assert.equal(out.readUInt32BE(out.indexOf("mvhd") + 8), 0);
  assert.deepEqual(r.details, ["location", "author", "dates"]);
  assert.equal(audioType(out, "m4a"), "audio/mp4");
});

test("OGG and WebM audio can't be cleaned safely, so the user chooses", async () => {
  for (const name of ["voice.ogg", "voice.webm"]) {
    const r = await cleanUpload(Buffer.from("OggS\0\x02" + "\0".repeat(40), "latin1"), { name });
    assert.equal(r.status, "failed", name);
    assert.equal(r.bytes, null);
  }
  const text = await cleanUpload(Buffer.from("plain notes"), { name: "notes.txt" });
  assert.equal(text.status, "none");
  assert.equal(cleanNote(text), null);
});

test("real encoder output: MP3, FLAC, M4A and WAV lose their tags and decode to the same samples", { skip: noFfmpeg }, () => {
  const pcm = ["-f", "s16le", "-ac", "1", "-ar", "8000"];
  for (const [ext, codec] of [["mp3", ["-c:a", "libmp3lame"]], ["flac", ["-c:a", "flac"]], ["m4a", ["-c:a", "aac"]], ["wav", ["-c:a", "pcm_s16le"]]]) {
    const input = withTemp((dir) => {
      const file = join(dir, "tone." + ext);
      execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", "-ac", "1", "-ar", "8000", ...codec,
        "-metadata", "artist=A. Fixture", "-metadata", "date=2024-01-02", "-metadata", "title=Fixture take", file]);
      return readFileSync(file);
    });
    assert.match(ffmetadata(input, ext), /A\. Fixture/, `${ext} fixture is tagged`);
    const r = cleanAudio(input, ext);
    const tags = ffmetadata(r.bytes, ext);
    for (const secret of ["A. Fixture", "2024-01-02", "Fixture take"]) assert.ok(!tags.includes(secret), `${ext}: ${secret}`);
    assert.equal(decodedHash(r.bytes, ext, pcm), decodedHash(input, ext, pcm), `${ext} samples`);
    assert.ok(r.details.includes("author"), ext);
  }
});
