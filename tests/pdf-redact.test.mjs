import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import net from "node:net";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor, parseReleased, releaseInfo } from "../server/releases.js";
import { isReleased, modeReleased } from "../src/lib.js";
import { knownPage, sitemap } from "../src/site-routes.js";
import { paletteActions } from "../src/command-palette.js";
import { rankTools } from "../src/tool-search.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { buildDocumentBlock } from "../src/documents.js";
import { detectSensitive, veil, createVeilState } from "../src/veil.js";
import { applyRedactions } from "../src/redact.js";
import {
  CHAT_IMAGES,
  CHAT_OCR_PAGES,
  DEFAULT_DPI,
  DETECTORS,
  DPI_CHOICES,
  MAX_BOXES,
  MAX_CANVAS_PIXELS,
  MAX_OUTPUT_BYTES,
  MAX_PAGES,
  PdfRedactError,
  addBoxes,
  addManualBox,
  blacken,
  blankEdit,
  boxCovers,
  chatImageItem,
  chatTextDocument,
  commitEdit,
  compileTerm,
  countBySource,
  createHistory,
  detectPage,
  detectorSource,
  detectorTypes,
  downloadName,
  findTerm,
  hasText,
  hitBox,
  indexPage,
  matchRects,
  mergeRects,
  moveBox,
  pageCapProblem,
  pagesWithBoxes,
  parsePageRange,
  pixelRects,
  planPage,
  rangeText,
  redactPages,
  redactedName,
  redo,
  removeBoxAt,
  removeSource,
  resizeBox,
  snippet,
  termOf,
  termSource,
  textRuns,
  undo,
} from "../src/pdf-redact.js";
import { PdfWriteError, PdfWriter, buildImagePdf, jpegInfo, stripJpeg } from "../src/pdf-writer.js";
import { checkImageOnlyPdf } from "../src/pdf-check.js";
import { closePdf, readPages } from "../src/pdf-redact-canvas.js";
import { holdForChat, sendBlock, takeForChat } from "../src/pdf-handoff.js";
import { makePdf } from "./fixtures/make-pdf.mjs";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const config = (released) => ({ releases: releaseInfo({ released: parseReleased(released) }) });
const cfg = (features) => ({ releases: { features } });

function app(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-pdfredact-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    origin: "http://localhost:5175",
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}

// ---- pdf.js and a canvas in Node (the same pdf.js the page loads) ------------
const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
let napi = null;
try {
  napi = await import("@napi-rs/canvas");
} catch {
  napi = null;
}
const needCanvas = !napi && "needs @napi-rs/canvas (an optional dependency of pdfjs-dist)";
const FONTS = new URL("../node_modules/pdfjs-dist/standard_fonts/", import.meta.url).pathname;
const openDoc = (bytes) =>
  pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0, standardFontDataUrl: FONTS }).promise;
const close = (doc) => closePdf(doc);
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");

// The canvas surface redactPages draws on, here a @napi-rs/canvas. `live`
// counts pictures alive at once, to check pages are made one at a time.
function surfaceFor(doc, stats = { live: 0, max: 0, drawn: [] }) {
  return {
    stats,
    async draw(n, plan) {
      const page = await doc.getPage(n);
      const canvas = napi.createCanvas(plan.width, plan.height);
      await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: page.getViewport({ scale: plan.scale }) }).promise;
      page.cleanup();
      stats.live++;
      stats.max = Math.max(stats.max, stats.live);
      stats.drawn.push(n);
      return canvas;
    },
    black(canvas, rects) {
      const ctx = canvas.getContext("2d");
      for (const r of rects) {
        const region = ctx.getImageData(r.x, r.y, r.w, r.h);
        applyRedactions(region, [{ x: 0, y: 0, w: r.w, h: r.h, style: "black" }]);
        ctx.putImageData(region, r.x, r.y);
      }
    },
    async encode(canvas, quality) {
      return new Uint8Array(canvas.toBuffer("image/jpeg", Math.round(quality * 100)));
    },
    free() {
      stats.live--;
    },
  };
}
// One page drawn (no boxes), as RGBA, and where the page's points fall in it.
async function draw(doc, n, dpi = DEFAULT_DPI) {
  const page = await doc.getPage(n);
  const view = page.getViewport({ scale: 1 });
  const plan = planPage(view.width, view.height, dpi);
  const canvas = napi.createCanvas(plan.width, plan.height);
  await page.render({ canvas, canvasContext: canvas.getContext("2d"), viewport: page.getViewport({ scale: plan.scale }) }).promise;
  const ctx = canvas.getContext("2d");
  return { plan, view, data: ctx.getImageData(0, 0, plan.width, plan.height).data, canvas };
}
const luma = (d, w, x, y) => {
  const p = (y * w + x) * 4;
  return 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
};
// Every dark pixel in a pixel rectangle.
function inkIn(img, x0, y0, x1, y1) {
  const out = [];
  for (let y = Math.max(0, y0); y < Math.min(img.plan.height, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(img.plan.width, x1); x++) if (luma(img.data, img.plan.width, x, y) < 128) out.push([x, y]);
  return out;
}
const inside = (rects) => ([x, y]) => rects.some((r) => x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h);

// Text of a page, indexed the way the page does it.
async function pagesOf(doc) {
  return readPages(doc);
}
// The rectangles for every match of a term on a page.
function boxesFor(index, page, term, options, source = "test", measureFor = null) {
  const out = [];
  for (const m of findTerm(index, term, options)) for (const r of matchRects(index, m.start, m.end, { measureFor })) out.push({ page, ...r, source });
  return out;
}
// A measure made in Courier itself: every character 0.6 em, so it is exact.
const courier = () => Object.assign((s) => s.length * 0.6, { exact: true });

// ---- fixtures: every PDF is made here, from invented text ---------------------

const COURIER = 7.2; // Courier's glyph advance at 12 pt: 0.6 em
const SECRETS = {
  name: "Alice Wonderland",
  card: "4111 1111 1111 1111",
  email: "alice@example.com",
  note: "Bob Hidden",
  field: "Carol Formfield",
  invisible: "Dave Invisible",
  rotated: "Rotated Secret 9911",
  title: "Secret Title Zed",
  author: "Author Eve Name",
  xmp: "xmp-secret-Frank",
  attachment: "attachment payload Grace",
  attachmentName: "secret-attachment.txt",
  js: "js secret Heidi",
};
function fixture() {
  return makePdf({
    pages: [
      {
        items: [
          { text: "Quarterly report", x: 72, y: 750, size: 18 },
          { text: `Account holder: ${SECRETS.name}`, x: 72, y: 700, font: "F2" },
          { text: `Card ${SECRETS.card} expires soon`, x: 72, y: 660, font: "F2" },
          { text: SECRETS.email, x: 72, y: 620, size: 14 },
          { text: SECRETS.invisible, x: 72, y: 560, invisible: true },
          { text: "Unrelated closing line", x: 72, y: 100, size: 14 },
        ],
        notes: [{ rect: [350, 500, 400, 520], contents: SECRETS.note }],
        fields: [{ rect: [72, 500, 260, 524], name: "holder", value: SECRETS.field }],
      },
      { rotate: 90, items: [{ text: SECRETS.rotated, x: 72, y: 700, font: "F2" }, { text: "Far away text", x: 72, y: 300, font: "F2" }] },
    ],
    info: { Title: SECRETS.title, Author: SECRETS.author, Subject: "Confidential subject", Keywords: "secret, keywords", Producer: "Fixture Producer", Creator: "Fixture Creator" },
    xmp: `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator><rdf:Seq><rdf:li>${SECRETS.xmp}</rdf:li></rdf:Seq></dc:creator></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`,
    attachment: { name: SECRETS.attachmentName, data: SECRETS.attachment },
    javascript: `app.alert("${SECRETS.js}")`,
  });
}

// The pieces of a file this writer made: the text outside its streams and
// each stream on its own, found by /Length, with no help from pdf-check.js.
function pieces(bytes) {
  const s = latin1(bytes);
  let skeleton = "",
    from = 0;
  const streams = [];
  for (;;) {
    const at = s.indexOf("\nstream\n", from);
    if (at < 0) break;
    const dict = s.slice(Math.max(0, at - 400), at);
    const length = Number(/\/Length (\d+)[^/]*$/.exec(dict)?.[1]);
    assert.ok(Number.isInteger(length), "a stream has a /Length");
    const start = at + 8;
    streams.push({ dict: dict.slice(dict.lastIndexOf("<<")), data: s.slice(start, start + length) });
    skeleton += s.slice(from, start) + "\u2026";
    from = start + length;
  }
  return { skeleton: skeleton + s.slice(from), streams };
}

// ---- the update and its gate -------------------------------------------------

test("PDF Redact is registered, unreleased, client-only, and has no server route", async (t) => {
  const update = UPDATES.find((u) => u.id === "pdfredact");
  assert.ok(update, "expected a UPDATES entry with id 'pdfredact'");
  assert.equal(update.title, "PDF Redact");
  assert.equal(update.points.length, 3);
  // Committed as false until its "Release …" commit flips it to true.
  assert.equal(typeof committed[UPDATES.indexOf(update)], "boolean");
  assert.equal(isReleased(config("mvp"), "pdfredact"), false);
  assert.equal(isReleased(config("mvp,pdfredact"), "pdfredact"), true);
  assert.equal(isReleased(config("all"), "pdfredact"), true);
  const pages = read("src/Pages.jsx");
  const icons = pages.slice(pages.indexOf("const featureIcons = {"), pages.indexOf("};", pages.indexOf("const featureIcons = {")));
  assert.match(icons, /\n {2}pdfredact: "pdf"/);
  // Nothing on the server depends on it: no route, and nothing gated in
  // featuresFor, whatever a request holds.
  for (const req of [
    { path: "/api/chat", method: "POST", body: { messages: [{ role: "user", content: "x" }] } },
    { path: "/api/documents", method: "POST", body: {} },
    { path: "/api/pdfredact", method: "POST", body: {} },
  ])
    assert.ok(!featuresFor(req).includes("pdfredact"), req.path);
  const hits = [];
  const { readdirSync } = await import("node:fs");
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js") && /pdfredact|pdf-redact/i.test(readFileSync(p, "utf8"))) hits.push(p);
    }
  };
  walk("server");
  assert.deepEqual(hits.sort(), ["server/releases.js", "server/routes/site.js"], "the server only knows its name and the page flag");
  // The Dockerfile copies nothing new: no server code imports the page's files.
  assert.doesNotMatch(read("Dockerfile"), /pdf-redact|pdf-writer|pdf-check|pdf-handoff/);
  // The server reports it: off under the MVP, on under all.
  for (const [released, expected] of [["mvp", false], ["all", true]]) {
    const body = (await request(app(t, released).app).get("/api/config").expect(200)).body;
    assert.equal(body.releases.features.pdfredact, expected, released);
  }
});

test("unreleased: the page is a 404, out of the sitemap, and nothing in the client shows it", async (t) => {
  assert.equal(knownPage("/workspace/pdfredact"), false);
  assert.equal(knownPage("/workspace/pdfredact", { pdfredact: false }), false);
  assert.equal(knownPage("/workspace/pdfredact", { pdfredact: true }), true);
  assert.ok(!sitemap("https://x.test", { pdfredact: true }).includes("pdfredact"), "never in the sitemap");
  if (existsSync("dist/client/index.html")) {
    await request(app(t, "mvp").app).get("/workspace/pdfredact").expect(404);
    await request(app(t, "mvp,pdfredact").app).get("/workspace/pdfredact").expect(200);
  }
  assert.equal(modeReleased(cfg({}), "pdfredact"), false);
  assert.equal(modeReleased(cfg({ pdfredact: true }), "pdfredact"), true);
  const ids = (c) => paletteActions({ config: c, mode: "chat", signedIn: true }).map((x) => x.id);
  assert.ok(!ids(cfg({})).includes("go-pdfredact"));
  assert.ok(ids(cfg({ pdfredact: true })).includes("go-pdfredact"));
  const ws = read("src/Workspace.jsx");
  assert.match(ws, /\.filter\(\(\[id\]\) => id !== "pdfredact" \|\| isReleased\(config, "pdfredact"\)\)/);
  assert.match(ws, /mode === "pdfredact" && \(!config \|\| isReleased\(config, "pdfredact"\)\)/);
  assert.match(ws, /mode === "pdfredact" \? \(\s*isReleased\(config, "pdfredact"\) &&/);
  // Its code is its own chunk; the main bundle imports neither the page nor pdf.js for it.
  assert.match(ws, /const PdfRedact = lazy\(\(\) => import\("\.\/PdfRedact\.jsx"\)\)/);
  assert.doesNotMatch(ws, /from "\.\/pdf-redact(-canvas)?\.js"|from "\.\/pdf-writer\.js"|from "\.\/pdf-check\.js"|pdfjs-dist/);
  // Account → Data controls says how it treats data, only once released.
  const dc = read("src/DataControls.jsx");
  assert.match(dc, /const pdfRedact = !!config && isReleased\(config, "pdfredact"\);/);
  assert.match(dc, /\{pdfRedact && \(\s*<li>\s*PDF Redact: the PDF is opened, boxed and redrawn in your browser/);
  // The tool directory finds it by intent, in English and Chinese, once the caller offers it.
  const entries = [["photos", "Photo tools", ""], ["pdfredact", "Redact a PDF", ""], ["notes", "Meeting notes", ""]];
  const first = (q) => rankTools(entries, q)[0]?.[0];
  for (const q of ["redact a pdf", "black out names in a document", "censor my pdf", "打码", "涂黑 文档"]) assert.equal(first(q), "pdfredact", q);
  assert.match(read("src/tool-search.js"), /^ {2}pdfredact: '[^']*\p{Script=Han}/mu);
  assert.deepEqual(rankTools(entries.filter(([id]) => id !== "pdfredact"), "redact a pdf").map((e) => e[0]).filter((id) => id === "pdfredact"), []);
});

// ---- the writer and its check ---------------------------------------------------

// A JPEG from a canvas, with a camera's EXIF, a comment, an ICC-like
// application segment and bytes after its end all added.
function dirtyJpeg() {
  const c = napi.createCanvas(40, 30);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, 40, 30);
  ctx.fillStyle = "#00f";
  ctx.fillRect(5, 5, 20, 10);
  const clean = new Uint8Array(c.toBuffer("image/jpeg", 90));
  const seg = (marker, payload) => {
    const body = Buffer.from(payload, "latin1");
    return Buffer.concat([Buffer.from([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  };
  const dirty = Buffer.concat([
    Buffer.from(clean.subarray(0, 2)),
    seg(0xe1, "Exif\0\0SECRET-CAMERA-OWNER"),
    seg(0xe2, "ICC_PROFILE\0SECRET-PROFILE"),
    seg(0xfe, "SECRET-COMMENT"),
    Buffer.from(clean.subarray(2)),
    Buffer.from("TRAILING-SECRET-BYTES", "latin1"),
  ]);
  return { clean, dirty: new Uint8Array(dirty) };
}

test("the writer strips a picture to its pixels: no EXIF, comment, profile or trailing bytes", { skip: needCanvas }, async () => {
  const { dirty } = dirtyJpeg();
  assert.ok(latin1(dirty).includes("SECRET-CAMERA-OWNER"));
  const info = jpegInfo(dirty);
  assert.deepEqual([info.width, info.height, info.components, info.precision], [40, 30, 3, 8]);
  const stripped = stripJpeg(dirty);
  const text = latin1(stripped);
  for (const s of ["SECRET-CAMERA-OWNER", "SECRET-PROFILE", "SECRET-COMMENT", "TRAILING-SECRET", "Exif", "ICC_PROFILE", "JFIF"]) assert.ok(!text.includes(s), s);
  assert.deepEqual([...stripped.subarray(0, 2)], [0xff, 0xd8]);
  assert.deepEqual([...stripped.subarray(-2)], [0xff, 0xd9]);
  // It still decodes, at the same size, to the same picture.
  const img = await napi.loadImage(Buffer.from(stripped));
  assert.deepEqual([img.width, img.height], [40, 30]);
  const c = napi.createCanvas(40, 30);
  c.getContext("2d").drawImage(img, 0, 0);
  const px = c.getContext("2d").getImageData(10, 8, 1, 1).data;
  assert.ok(px[2] > 200 && px[0] < 60, "the blue box is still blue");
  assert.throws(() => stripJpeg(Uint8Array.of(1, 2, 3, 4, 5)), PdfWriteError);
  assert.equal(jpegInfo(Uint8Array.of(0xff, 0xd8)), null);
});

test("the writer makes a file of only pictures: catalog, page tree, and per page a content stream, a picture and a page", { skip: needCanvas }, () => {
  const { dirty } = dirtyJpeg();
  const bytes = buildImagePdf([
    { width: 612, height: 792, image: { kind: "jpeg", data: dirty } },
    { width: 792.5, height: 612, image: { kind: "jpeg", data: dirty } },
  ]);
  assert.equal(latin1(bytes.subarray(0, 9)), "%PDF-1.4\n");
  const { skeleton, streams } = pieces(bytes);
  // The only names in the file.
  const names = new Set([...skeleton.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1]));
  const allowed = "Type Catalog Pages Page Kids Count Parent MediaBox Resources XObject Im0 Contents Subtype Image Width Height ColorSpace DeviceRGB DeviceGray BitsPerComponent Filter DCTDecode Length Size Root".split(" ");
  assert.deepEqual([...names].filter((n) => !allowed.includes(n)), []);
  for (const forbidden of ["Info", "Metadata", "ID", "Font", "Annots", "AcroForm", "Names", "OpenAction", "JS", "Author", "Producer", "Encrypt"])
    assert.ok(!names.has(forbidden), forbidden);
  assert.match(skeleton, /trailer\n<< \/Size 9 \/Root 1 0 R >>\nstartxref\n\d+\n%%EOF\n$/);
  // Content streams only place the picture; picture streams are JPEGs with nothing added.
  const content = streams.filter((s) => !/\/Subtype \/Image/.test(s.dict));
  const images = streams.filter((s) => /\/Subtype \/Image/.test(s.dict));
  assert.equal(content.length, 2);
  assert.equal(images.length, 2);
  assert.equal(content[0].data, "q 612 0 0 792 0 0 cm /Im0 Do Q\n");
  assert.equal(content[1].data, "q 792.5 0 0 612 0 0 cm /Im0 Do Q\n");
  for (const im of images) {
    assert.ok(im.data.startsWith("\xff\xd8\xff") && im.data.endsWith("\xff\xd9"));
    for (const s of ["Exif", "JFIF", "ICC_PROFILE", "SECRET"]) assert.ok(!im.data.includes(s), s);
  }
  assert.deepEqual(checkImageOnlyPdf(bytes), { ok: true, pages: 2, problems: [] });
});

test("the writer refuses what isn't a picture it can place, and a file with no pages", () => {
  assert.throws(() => new PdfWriter().addPage({ width: 10, height: 10, image: { kind: "jpeg", data: Uint8Array.of(1, 2, 3, 4) } }), PdfWriteError);
  assert.throws(() => new PdfWriter().addPage({ width: 10, height: 10, image: { kind: "text", data: "BT" } }), PdfWriteError);
  assert.throws(() => new PdfWriter().addPage({ width: NaN, height: 10, image: { kind: "flate", width: 1, height: 1, data: Uint8Array.of(1) } }), PdfWriteError);
  assert.throws(() => new PdfWriter().finish(), PdfWriteError);
  const w = new PdfWriter();
  w.addPage({ width: 10, height: 10, image: { kind: "flate", width: 1, height: 1, data: Uint8Array.of(120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1) } });
  w.finish();
  assert.throws(() => w.finish(), PdfWriteError);
  assert.throws(() => w.addPage({ width: 1, height: 1, image: { kind: "flate", width: 1, height: 1, data: Uint8Array.of(1) } }), PdfWriteError);
});

test("the check refuses a file that holds anything but page pictures", () => {
  const flate = Uint8Array.of(120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1);
  const good = buildImagePdf([{ width: 100, height: 100, image: { kind: "flate", width: 1, height: 1, data: flate } }]);
  assert.deepEqual(checkImageOnlyPdf(good), { ok: true, pages: 1, problems: [] });
  const bytes = (s) => Uint8Array.from(Buffer.from(s, "latin1"));
  const good1 = latin1(good);
  const placed = "q 100 0 0 100 0 0 cm /Im0 Do Q\n";
  assert.ok(good1.includes(placed));
  const attempts = {
    // Same length as the real content, so every offset stays true.
    "text drawn on the page": good1.replace(placed, "BT (Secret) Tj ET".padEnd(placed.length - 1, " ") + "\n"),
    "a document-details entry": good1.replace(/\/Size \d+ \/Root 1 0 R/, (m) => m + " /Info 9 0 R"),
    "a page with a note": good1.replace("/MediaBox [0 0 100 100]", "/MediaBox [0 0 100 100] /Annots [1 0 R]"),
    "a page with a font": good1.replace("/Resources << /XObject", "/Resources << /Font << /F1 1 0 R >> /XObject"),
    "a catalog with a script": good1.replace("<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Catalog /Pages 2 0 R /OpenAction 1 0 R >>"),
    "bytes after the end": good1 + "SECRET",
    "bytes inside the file": good1.replace("endobj\n2 0 obj", "endobj\nSECRET\n2 0 obj"),
    "a picture with a metadata entry": good1.replace("/Filter /FlateDecode", "/Filter /FlateDecode /Metadata 1 0 R"),
    "a picture with a mask": good1.replace("/Filter /FlateDecode", "/Filter /FlateDecode /SMask 1 0 R"),
    "a filter that isn't a picture's": good1.replace("/FlateDecode", "/LZWDecode"),
    "a page with no size": good1.replace("/MediaBox [0 0 100 100]", "/MediaBox [0 0 0 0]"),
  };
  for (const [what, s] of Object.entries(attempts)) {
    assert.notEqual(s, good1, `${what}: the change was made`);
    const r = checkImageOnlyPdf(bytes(s));
    assert.equal(r.ok, false, what);
    assert.ok(r.problems.length > 0, what);
  }
  assert.equal(checkImageOnlyPdf(new Uint8Array(0)).ok, false);
  assert.equal(checkImageOnlyPdf(bytes("%PDF-1.4\nnot a real file, but long enough to get past the length check\n")).ok, false);
});

// ---- the text and where it is -------------------------------------------------

test("the text layer's runs know where they are, and a page's text is one string with line breaks", async () => {
  const doc = await openDoc(fixture());
  const { pages, sizes } = await pagesOf(doc);
  assert.equal(pages.length, 2);
  assert.deepEqual(sizes.map((s) => [s.width, s.height]), [[612, 792], [792, 612]], "page 2 is shown rotated");
  const one = pages[0];
  assert.ok(one.text.includes(`Account holder: ${SECRETS.name}`));
  assert.ok(one.text.includes(`Card ${SECRETS.card} expires soon`));
  assert.ok(one.text.split("\n").length >= 5, "each line is a line");
  assert.ok(hasText(one));
  // The note's and the form field's text are searchable too (the text layer
  // doesn't hold them), each as one run over its own rectangle.
  assert.ok(one.text.includes(SECRETS.note), "a note");
  assert.ok(one.text.includes(SECRETS.field), "a form field");
  // Invisible text (a scan's hidden layer) is in the text layer, so it's found.
  assert.ok(one.text.includes(SECRETS.invisible));
  assert.equal(hasText({ text: " \n " }), false);
  assert.equal(hasText(null), false);
  await close(doc);
});

test("a term is text, never a pattern; spaces match any run of white space, across runs and lines", async () => {
  assert.equal(compileTerm("   "), null);
  assert.equal(compileTerm(""), null);
  assert.equal(compileTerm(undefined), null);
  assert.ok(compileTerm("a+b").test("a+b") && !compileTerm("a+b").test("aab"), "regex characters are literal");
  const index = (text) => ({ text, spans: [], transform: [1, 0, 0, -1, 0, 100], width: 100, height: 100 });
  const ends = (text, term, o) => findTerm(index(text), term, o).map((m) => text.slice(m.start, m.end));
  assert.deepEqual(ends("Alice alice ALICE", "alice"), ["Alice", "alice", "ALICE"]);
  assert.deepEqual(ends("Alice alice ALICE", "alice", { matchCase: true }), ["alice"]);
  assert.deepEqual(ends("cat concat cat.", "cat", { whole: true }), ["cat", "cat"]);
  assert.deepEqual(ends("cat concat", "cat"), ["cat", "cat"]);
  assert.deepEqual(ends("John\nSmith and John  Smith and JohnSmith", "john smith"), ["John\nSmith", "John  Smith"]);
  assert.deepEqual(ends("naïve café", "café"), ["café"]);
  assert.deepEqual(ends("a.b (x)", "(x)"), ["(x)"]);
  assert.deepEqual(ends("anything", ".*"), []);
  assert.deepEqual(findTerm(index(""), "x"), []);
  // A term is capped, so a pasted paragraph can't build a giant expression.
  assert.ok(compileTerm("x".repeat(500)).source.length <= 200);
  const real = await openDoc(fixture());
  const { pages } = await pagesOf(real);
  assert.equal(findTerm(pages[0], "alice wonderland").length, 1, "found on the page");
  assert.equal(findTerm(pages[0], "wonder land").length, 0);
  assert.equal(findTerm(pages[1], "rotated secret").length, 1, "found on the rotated page");
  await close(real);
});

test("Veil's detectors are reused as they are: the same matches, with places", async () => {
  // pdf-redact.js takes them from veil.js rather than restating them.
  assert.match(read("src/pdf-redact.js"), /import \{ detectSensitive \} from "\.\/veil\.js"/);
  assert.doesNotMatch(read("src/pdf-redact.js"), /luhn|ibanValid|\\bsk-|xox\[/i, "no detector of its own");
  assert.deepEqual(DETECTORS.map((d) => d.id), ["email", "phone", "card", "iban", "wallet", "key", "ip", "words"]);
  const all = new Set(DETECTORS.flatMap((d) => d.types));
  assert.deepEqual([...all].sort(), ["CARD", "EMAIL", "IBAN", "IP", "KEY", "PHONE", "PRIVATE", "WALLET"]);
  assert.deepEqual(detectorTypes("card"), ["CARD"]);
  assert.deepEqual(detectorTypes("nope"), []);
  const text =
    "Write to jo@example.org or call +1 415-555-0132. Card 4111 1111 1111 1111 or 4111 1111 1111 1112. " +
    "IBAN GB82WEST12345698765432, wallet 0x52908400098527886E0F7030069857D2E4169EE7, ip 203.0.113.9, " +
    "key ghp_abcdefghijklmnopqrstuvwxyz0123, and Zed Zebra.";
  const found = detectSensitive(text, ["Zed Zebra"]);
  const of = (type) => found.filter((m) => m.type === type).map((m) => text.slice(m.start, m.end));
  assert.deepEqual(of("EMAIL"), ["jo@example.org"]);
  assert.deepEqual(of("PHONE"), ["+1 415-555-0132"]);
  assert.deepEqual(of("CARD"), ["4111 1111 1111 1111"], "a number that fails the Luhn check isn't a card");
  assert.deepEqual(of("IBAN"), ["GB82WEST12345698765432"]);
  assert.deepEqual(of("WALLET"), ["0x52908400098527886E0F7030069857D2E4169EE7"]);
  assert.deepEqual(of("IP"), ["203.0.113.9"]);
  assert.deepEqual(of("KEY"), ["ghp_abcdefghijklmnopqrstuvwxyz0123"]);
  assert.deepEqual(of("PRIVATE"), ["Zed Zebra"], "Veil's own names are the person's always-veil words");
  // It's what Veil masks: the same count, in the same places.
  const masked = veil(text, createVeilState(), ["Zed Zebra"]);
  assert.equal(masked.count, found.length);
  assert.deepEqual(detectSensitive(text, [], ["EMAIL"]).map((m) => m.type), ["EMAIL"]);
  assert.deepEqual(detectSensitive("", ["x"]), []);
  // On a page, line breaks are hidden from the detectors: a table's digits don't join.
  const page = { text: "call 415-555\n0132 or 415-555-0132", spans: [], transform: [1, 0, 0, -1, 0, 1], width: 1, height: 1 };
  const hits = detectPage(page).map((m) => page.text.slice(m.start, m.end));
  assert.deepEqual(hits, ["415-555-0132"]);
  assert.equal(detectPage(null).length, 0);
  const doc = await openDoc(fixture());
  const { pages } = await pagesOf(doc);
  const types = detectPage(pages[0]).map((m) => m.type);
  assert.ok(types.includes("CARD") && types.includes("EMAIL"), types.join());
  await close(doc);
});

test("boxes fully cover the text they were made for, even after the page is drawn at 150, 200 and 300 dpi", { skip: needCanvas }, async () => {
  const doc = await openDoc(fixture());
  const { pages } = await pagesOf(doc);
  const view = (await doc.getPage(1)).getViewport({ scale: 1 });
  for (const dpi of DPI_CHOICES) {
    const img = await draw(doc, 1, dpi);
    const { scale } = img.plan;
    // A matched word set in Courier: its glyph cells are exactly 7.2 pt wide,
    // so where its ink can be is known without asking the code under test.
    const line = "Account holder: " + SECRETS.name;
    const from = line.indexOf("Alice"),
      to = line.length;
    const boxes = boxesFor(pages[0], 1, "alice wonderland", undefined, "test", courier);
    assert.ok(boxes.length >= 1, "a box");
    // With nothing known about the font the boxes reach farther, never less.
    const guessed = boxesFor(pages[0], 1, "alice wonderland");
    assert.ok(guessed[0].x < boxes[0].x - 1 && guessed[0].w > boxes[0].w + 2, "a guess covers more than a measure");
    const rects = pixelRects(boxes, scale, img.plan.width, img.plan.height);
    const baseline = view.height - 700;
    const ink = inkIn(
      img,
      Math.floor((72 + from * COURIER) * scale),
      Math.floor((baseline - 11) * scale),
      Math.ceil((72 + to * COURIER) * scale),
      Math.ceil((baseline + 4) * scale),
    );
    assert.ok(ink.length > 200, `the words have ink at ${dpi} dpi (${ink.length})`);
    const uncovered = ink.filter((p) => !inside(rects)(p));
    assert.equal(uncovered.length, 0, `${uncovered.length} ink pixels outside the boxes at ${dpi} dpi`);
    // The box doesn't swallow the label before it ("Account holder: ").
    const before = inkIn(img, Math.floor(72 * scale), Math.floor((baseline - 11) * scale), Math.floor((72 + (from - 1) * COURIER) * scale), Math.ceil((baseline + 4) * scale));
    assert.ok(before.length > 100);
    assert.ok(before.every((p) => !inside(rects)(p)), "the label is left alone");
  }
  await close(doc);
});

test("a whole run is boxed by its own width; a match inside a longer run by where its characters fall", { skip: needCanvas }, async () => {
  const doc = await openDoc(fixture());
  const { pages } = await pagesOf(doc);
  const img = await draw(doc, 1);
  const { scale } = img.plan;
  // The email stands alone on a line in Helvetica 14 pt; its ink is read
  // from the drawn page, not from the code under test.
  const boxes = boxesFor(pages[0], 1, "alice@example.com");
  const rects = pixelRects(boxes, scale, img.plan.width, img.plan.height);
  const ink = inkIn(img, Math.floor(70 * scale), Math.floor((792 - 620 - 14) * scale), Math.ceil(300 * scale), Math.ceil((792 - 620 + 5) * scale));
  assert.ok(ink.length > 200);
  assert.equal(ink.filter((p) => !inside(rects)(p)).length, 0, "all of the email's ink is under a box");
  assert.equal(matchRects(pages[0], 0, 0).length, 0);
  await close(doc);
  // A run of ten narrow letters then ten wide ones, 200 pt across. With no
  // font to measure, the characters are taken as equal; with one (as the
  // page does on a canvas), the wide half starts a quarter of the way in.
  const items = [{ str: "iiiiiiiiiiWWWWWWWWWW", transform: [10, 0, 0, 10, 0, 50], width: 200, height: 10, fontName: "f", hasEOL: false }];
  const index = indexPage({ content: { items, styles: {} }, transform: [1, 0, 0, -1, 0, 100], width: 300, height: 100 });
  const at = index.text.indexOf("W");
  const equal = matchRects(index, at, index.text.length)[0];
  const measured = matchRects(index, at, index.text.length, { measureFor: () => (s) => [...s].reduce((n, ch) => n + (ch === "i" ? 1 : 3), 0) })[0];
  assert.ok(Math.abs(equal.x - (100 - 1 - 10)) < 0.01, `equal widths: ${equal.x}`);
  assert.ok(Math.abs(measured.x - (50 - 1 - 4)) < 0.01, `measured widths: ${measured.x}`);
  const ownFont = matchRects(index, at, index.text.length, { measureFor: () => Object.assign((s) => [...s].reduce((n, ch) => n + (ch === "i" ? 1 : 3), 0), { exact: true }) })[0];
  assert.ok(Math.abs(ownFont.x - (50 - 1 - 1.6)) < 0.01, `the PDF's own font: ${ownFont.x}`);
  assert.ok(ownFont.x > measured.x, "the surer the font, the tighter the reach past the word");
  assert.ok(Math.abs(measured.x + measured.w - 201) < 0.01, "to the run's end, and its padding");
  // Both cover the word's whole extent: the measured one because it's placed, the equal one by reaching farther.
  assert.ok(measured.w >= 150 && equal.w >= 100);
  // A measure that fails or answers nonsense falls back to equal widths.
  const broken = matchRects(index, at, index.text.length, { measureFor: () => () => { throw new Error("x"); } })[0];
  assert.deepEqual(broken, equal);
  assert.deepEqual(matchRects(index, at, index.text.length, { measureFor: () => () => 0 })[0], equal);
  // A range that reaches past the end covers the run to its end.
  assert.ok(matchRects(index, at, index.text.length + 50).length >= 1);
});

test("boxes are right on a rotated page too: everything drawn in the rotated words is covered", { skip: needCanvas }, async () => {
  const doc = await openDoc(fixture());
  const { pages, sizes } = await pagesOf(doc);
  const img = await draw(doc, 2);
  const { scale } = img.plan;
  const boxes = boxesFor(pages[1], 2, SECRETS.rotated, undefined, "test", courier);
  const rects = pixelRects(boxes, scale, img.plan.width, img.plan.height);
  // The run runs up the page: its own corners, through the page's transform,
  // from the known origin, Courier width and font size.
  const t = (await doc.getPage(2)).getViewport({ scale: 1 }).transform;
  const at = (x, y) => [t[0] * x + t[2] * y + t[4], t[1] * x + t[3] * y + t[5]];
  const width = SECRETS.rotated.length * COURIER;
  const corners = [at(72, 700 - 3), at(72 + width, 700 - 3), at(72 + width, 700 + 10), at(72, 700 + 10)];
  const xs = corners.map((c) => c[0]),
    ys = corners.map((c) => c[1]);
  const ink = inkIn(img, Math.floor(Math.min(...xs) * scale), Math.floor(Math.min(...ys) * scale), Math.ceil(Math.max(...xs) * scale), Math.ceil(Math.max(...ys) * scale));
  assert.ok(ink.length > 200, `the rotated words have ink (${ink.length})`);
  assert.ok(boxes[0].h > boxes[0].w, "and the box stands up with them");
  assert.equal(ink.filter((p) => !inside(rects)(p)).length, 0);
  // The far text isn't touched.
  assert.equal(boxesFor(pages[1], 2, "Far away").every((b) => !boxCovers(boxes[0], b)), true);
  await close(doc);
});

test("the annotation's and the form field's rectangles are boxed whole", async () => {
  const doc = await openDoc(fixture());
  const { pages } = await pagesOf(doc);
  const view = (await doc.getPage(1)).getViewport({ scale: 1 });
  const field = boxesFor(pages[0], 1, SECRETS.field)[0];
  // Its rectangle is [72, 500, 260, 524] in the file, which is y 268 to 292 from the top.
  assert.ok(field.x <= 72 && field.x + field.w >= 260, "the field's width");
  assert.ok(field.y <= view.height - 524 && field.y + field.h >= view.height - 500, "the field's height");
  // pdf.js reports a note's rectangle as its 22-point icon, which is what the page draws.
  const note = boxesFor(pages[0], 1, SECRETS.note)[0];
  assert.ok(note.x <= 350 && note.x + note.w >= 372, "the note's icon, across");
  assert.ok(note.y <= view.height - 520 && note.y + note.h >= view.height - 498, "and down");
  const noteRuns = textRuns({ items: [], styles: {} }, [
    { rect: [10, 10, 5, 5], fieldValue: ["a", "b"], contentsObj: { str: "a" } },
    { rect: [1, 2, 3, 4], fieldType: "Btn", fieldValue: "Yes" },
    { rect: [1, 2, 3], fieldValue: "bad rect" },
    { rect: [1, 2, 3, 4] },
  ]);
  assert.equal(noteRuns.length, 1);
  assert.deepEqual(noteRuns[0].box, [5, 5, 10, 10]);
  assert.equal(noteRuns[0].str, "a b", "one entry per distinct text");
  await close(doc);
});

test("rectangles on one line merge; matches list with a little around them", () => {
  const merged = mergeRects([
    { x: 0, y: 0, w: 10, h: 10 },
    { x: 11, y: 1, w: 10, h: 10 },
    { x: 0, y: 30, w: 10, h: 10 },
    { x: 50, y: 0, w: 5, h: 10 },
  ]);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0], { x: 0, y: 0, w: 21, h: 11 });
  const index = { text: "The quick brown fox\njumps over the lazy dog", spans: [], transform: [1, 0, 0, -1, 0, 1], width: 1, height: 1 };
  assert.deepEqual(snippet(index, 10, 15, 6), { before: "quick", match: "brown", after: "fox j" });
});

// ---- boxes and their editing ---------------------------------------------------

test("boxes add without duplicating, come off by their reason, and undo and redo as whole edits", () => {
  let edit = blankEdit();
  const src = termSource("Alice", { matchCase: false });
  const a = { page: 1, x: 10, y: 10, w: 100, h: 20, source: src };
  let r = addBoxes(edit, [a, { page: 1, x: 20, y: 12, w: 30, h: 10, source: src }, { page: 2, x: 20, y: 12, w: 30, h: 10, source: src }, { page: 1, x: 0, y: 0, w: 0, h: 5 }, { page: 1, x: NaN, y: 0, w: 5, h: 5 }]);
  assert.equal(r.added, 2, "one inside another on the same page is dropped; the same rectangle on another page isn't");
  assert.equal(r.skipped, 1);
  edit = r.edit;
  assert.equal(pagesWithBoxes(edit), 2);
  assert.equal(countBySource(edit, src), 2);
  assert.equal(termOf(src), "alice");
  assert.equal(termOf(detectorSource("email")), null);
  assert.equal(termSource("Alice", { matchCase: true, whole: true }), "term:cw:Alice");
  assert.equal(addBoxes(edit, [a]).edit, edit, "nothing new leaves the edit as it was");
  let history = createHistory(blankEdit());
  history = commitEdit(history, edit);
  assert.equal(commitEdit(history, edit), history, "the same edit isn't a step");
  const off = removeSource(edit, src);
  assert.equal(off.boxes.length, 0);
  history = commitEdit(history, off);
  history = undo(history);
  assert.equal(history.present.boxes.length, 2);
  history = redo(history);
  assert.equal(history.present.boxes.length, 0);
  history = undo(undo(history));
  assert.equal(history.present.boxes.length, 0, "back to the start");
  // Moving a box on page 2 to where a page 1 box is isn't the same edit.
  const p1 = addBoxes(blankEdit(), [{ page: 1, x: 5, y: 5, w: 10, h: 10 }]).edit;
  const p2 = addBoxes(blankEdit(), [{ page: 2, x: 5, y: 5, w: 10, h: 10 }]).edit;
  assert.notEqual(commitEdit(createHistory(p1), p2).present, p1);
  // The limit.
  const many = Array.from({ length: MAX_BOXES + 5 }, (_, i) => ({ page: 1, x: i * 3, y: 0, w: 2, h: 2 }));
  const capped = addBoxes(blankEdit(), many);
  assert.equal(capped.edit.boxes.length, MAX_BOXES);
  assert.equal(capped.skipped, 5);
  assert.equal(addManualBox(capped.edit, 1, { x: 0, y: 0 }, { x: 50, y: 50 }, 612, 792), null);
});

test("drawing, moving, resizing and hit-testing use Redact Before You Send's geometry and keep a box's page and reason", () => {
  const W = 612,
    H = 792;
  let edit = addManualBox(blankEdit(), 3, { x: 100.4, y: 50.6 }, { x: 40, y: 20 }, W, H);
  assert.deepEqual(edit.boxes[0], { page: 3, x: 40, y: 20, w: 61, h: 31, source: "manual" }, "whole points, rounded outward");
  assert.equal(addManualBox(blankEdit(), 1, { x: 1, y: 1 }, { x: 2, y: 2 }, W, H), null, "a click isn't a box");
  assert.equal(addManualBox(blankEdit(), 1, { x: -50, y: -50 }, { x: -10, y: -10 }, W, H), null, "outside the page");
  const clipped = addManualBox(blankEdit(), 1, { x: 600, y: 780 }, { x: 700, y: 900 }, W, H);
  assert.deepEqual([clipped.boxes[0].w, clipped.boxes[0].h], [12, 12], "cut at the page's edge");
  edit = addBoxes(edit, [{ page: 1, x: 200, y: 200, w: 50, h: 50, source: "detector:email" }]).edit;
  const moved = moveBox(edit, 1, 10, -300, W, H);
  assert.deepEqual([moved.boxes[1].page, moved.boxes[1].source, moved.boxes[1].y], [1, "detector:email", 0], "kept inside the page, page and reason kept");
  const resized = resizeBox(edit, 1, "se", { x: 400, y: 300 }, W, H);
  assert.deepEqual([resized.boxes[1].w, resized.boxes[1].h, resized.boxes[1].source], [200, 100, "manual"], "a box edited by hand is the person's own");
  assert.equal(moveBox(edit, 9, 1, 1, W, H), edit);
  assert.deepEqual(hitBox(edit, 3, { x: 60, y: 30 }, 4), { index: 0, handle: "move" });
  assert.deepEqual(hitBox(edit, 3, { x: 40, y: 20 }, 4), { index: 0, handle: "nw" });
  assert.equal(hitBox(edit, 2, { x: 60, y: 30 }, 4), null, "only this page's boxes");
  assert.deepEqual(removeBoxAt(edit, 0).boxes.map((b) => b.page), [1]);
});

// ---- the pictures ---------------------------------------------------------------

test("a page is drawn at dpi / 72 pixels to the point, held down for a page too big for one canvas", () => {
  const letter = planPage(612, 792, 200);
  assert.deepEqual([letter.width, letter.height, letter.dpi, letter.limited], [1700, 2200, 200, false]);
  assert.deepEqual(planPage(612, 792, 150).width, 1275);
  assert.deepEqual(planPage(612, 792, 300).height, 3300);
  const poster = planPage(2000, 3000, 300);
  assert.equal(poster.limited, true);
  assert.ok(poster.width * poster.height <= MAX_CANVAS_PIXELS);
  assert.ok(poster.dpi < 300 && poster.dpi > 100);
  const strip = planPage(72, 100000, 150);
  assert.ok(strip.height <= 16384, "no side is longer than a browser allows");
  assert.equal(planPage(0.1, 0.1, 150).width, 1);
});

test("boxes become pixel rectangles that round outward, gain a pixel all round, and stay on the page", () => {
  const r = pixelRects([{ x: 10.2, y: 20.7, w: 30.1, h: 5 }], 2, 200, 200);
  assert.deepEqual(r, [{ x: 19, y: 40, w: 63, h: 13, style: "black" }]);
  assert.deepEqual(pixelRects([{ x: -10, y: -10, w: 12, h: 12 }], 1, 100, 100)[0], { x: 0, y: 0, w: 3, h: 3, style: "black" });
  assert.equal(pixelRects([{ x: 500, y: 500, w: 5, h: 5 }], 1, 100, 100).length, 0);
  assert.equal(pixelRects([], 1, 100, 100).length, 0);
  // Every pixel under a rectangle becomes opaque black, and nothing else changes.
  const img = { width: 6, height: 4, data: new Uint8ClampedArray(6 * 4 * 4).fill(200) };
  const applied = blacken(img, [{ x: 1, y: 1, w: 3, h: 2 }]);
  assert.equal(applied.length, 1);
  const px = (x, y) => Array.from(img.data.slice((y * 6 + x) * 4, (y * 6 + x) * 4 + 4));
  for (let y = 1; y < 3; y++) for (let x = 1; x < 4; x++) assert.deepEqual(px(x, y), [0, 0, 0, 255]);
  assert.deepEqual(px(0, 0), [200, 200, 200, 200]);
  assert.deepEqual(px(4, 1), [200, 200, 200, 200]);
});

// ---- the redacted copy: the core promise -----------------------------------------

test("redacted text is truly gone: the written file has no text, fonts, strings or metadata, and the boxes are black", { skip: needCanvas, timeout: 120000 }, async () => {
  const source = fixture();
  // The original really holds everything the copy must not.
  const srcText = latin1(source);
  for (const s of Object.values(SECRETS)) assert.ok(srcText.includes(s), `the original holds "${s}"`);
  assert.ok(srcText.includes("BT ") && srcText.includes("/Type /Font") && srcText.includes("/Annots") && srcText.includes("/JavaScript") && srcText.includes("/EmbeddedFile"));
  const doc = await openDoc(source);
  const meta = await doc.getMetadata();
  assert.equal(meta.info.Author, SECRETS.author);
  assert.ok(meta.metadata, "an XMP packet");
  assert.ok(await doc.getAttachments(), "an attachment");
  const { pages, sizes } = await pagesOf(doc);

  // The boxes a person would make: words, the detectors, and one by hand.
  const boxes = [];
  for (const term of [SECRETS.name, SECRETS.note, SECRETS.field, SECRETS.invisible]) boxes.push(...boxesFor(pages[0], 1, term));
  boxes.push(...boxesFor(pages[1], 2, "Rotated Secret"));
  for (const m of detectPage(pages[0])) if (m.type === "CARD" || m.type === "EMAIL") for (const r of matchRects(pages[0], m.start, m.end)) boxes.push({ page: 1, ...r, source: "detector" });
  boxes.push({ page: 1, x: 300, y: 300, w: 120, h: 40, source: "manual" });
  const edit = addBoxes(blankEdit(), boxes).edit;

  const surface = surfaceFor(doc);
  const progress = [];
  const out = await redactPages({ sizes, boxes: edit.boxes, dpi: 150, pages: [1, 2], surface, onProgress: (p) => progress.push(p) });
  assert.deepEqual(progress, [{ page: 1, of: 2 }, { page: 2, of: 2 }]);
  assert.equal(surface.stats.max, 1, "one page's picture at a time");
  assert.equal(surface.stats.live, 0, "and each let go");
  assert.equal(out.limited, 0);
  assert.deepEqual(out.check, { ok: true, pages: 2, problems: [] });
  const bytes = out.bytes;
  await close(doc);

  // 1. Not one original string anywhere in the file's bytes: not the ones
  // redacted, not the ones left visible, not the metadata, the attachment
  // or the script.
  const file = latin1(bytes);
  const utf16 = (s) => Buffer.from(s, "utf16le").toString("latin1");
  const visible = ["Quarterly report", "Unrelated closing line", "Far away text", "Account holder", "expires soon"];
  for (const s of [...Object.values(SECRETS), ...visible, "Confidential subject", "Fixture Producer", "Fixture Creator", "secret, keywords"]) {
    assert.ok(!file.includes(s), `the copy holds "${s}"`);
    assert.ok(!file.includes(utf16(s)), `the copy holds "${s}" as UTF-16`);
  }
  // 2. Nothing but pictures, read without pdf-check.js: the names in the
  // structure, the operators in the content, the bytes of each picture.
  const { skeleton, streams } = pieces(bytes);
  const names = new Set([...skeleton.matchAll(/\/([A-Za-z0-9]+)/g)].map((m) => m[1]));
  for (const n of ["Font", "BaseFont", "Annots", "Annot", "AcroForm", "Widget", "Names", "EmbeddedFile", "EmbeddedFiles", "Filespec", "JS", "JavaScript", "OpenAction", "AA", "Metadata", "Info", "Author", "Title", "Producer", "Creator", "ID", "Encrypt", "Outlines", "StructTreeRoot", "ToUnicode", "Encoding", "Lang"])
    assert.ok(!names.has(n), `/${n} is in the copy`);
  const tokens = streams.filter((s) => !/\/Subtype \/Image/.test(s.dict)).flatMap((s) => s.data.trim().split(/\s+/));
  for (const tok of tokens) assert.match(tok, /^(q|Q|cm|Do|\/Im0|-?\d+(\.\d+)?)$/, `content token ${tok}`);
  for (const op of ["BT", "ET", "Tj", "TJ", "Tf", "Td", "TD", "Tm", "T*", "'", '"', "Tr", "Tc", "Tw"]) assert.ok(!tokens.includes(op), `text operator ${op}`);
  assert.equal(streams.filter((s) => /\/Subtype \/Image/.test(s.dict)).length, 2);
  for (const im of streams.filter((s) => /\/Subtype \/Image/.test(s.dict))) for (const s of ["Exif", "JFIF", "ICC", "Adobe", "xmp", "XMP"]) assert.ok(!im.data.includes(s), s);
  assert.ok(!file.includes("/Info") && !file.includes("<x:xmpmeta") && !file.includes("xpacket"), "no document details, no XMP packet");
  assert.match(file, /trailer\n<< \/Size \d+ \/Root 1 0 R >>\n/, "the trailer names the catalog and nothing else");

  // 3. A second opinion: pdf.js reads the copy and finds no text, notes,
  // form fields, attachments, scripts or details, and no text operator.
  const copy = await openDoc(bytes);
  assert.equal(copy.numPages, 2);
  const info = await copy.getMetadata();
  assert.deepEqual(Object.keys(info.info).filter((k) => /^(Title|Author|Subject|Keywords|Creator|Producer|CreationDate|ModDate)$/.test(k)), []);
  assert.equal(info.metadata, null);
  assert.equal(await copy.getAttachments(), null);
  assert.equal(await copy.getOpenAction(), null, "no action to run on open");
  assert.equal(await copy.getJSActions(), null, "no script");
  assert.equal(await copy.getOutline(), null);
  assert.equal((await copy.getDestinations()).size, 0);
  assert.equal(await copy.getPageLabels(), null);
  assert.equal(await copy.getFieldObjects(), null);
  const shownText = [];
  for (let n = 1; n <= 2; n++) {
    const page = await copy.getPage(n);
    shownText.push(...(await page.getTextContent()).items.map((i) => i.str).filter((s) => s.trim()));
    assert.deepEqual(await page.getAnnotations(), []);
    const ops = (await page.getOperatorList()).fnArray;
    for (const name of ["beginText", "endText", "showText", "showSpacedText", "setFont", "nextLineShowText", "nextLineSetSpacingShowText"])
      assert.ok(!ops.includes(pdfjs.OPS[name]), `pdf.js finds ${name}`);
    assert.ok(ops.includes(pdfjs.OPS.paintImageXObject), "the page is one picture");
  }
  assert.deepEqual(shownText, [], "no text to extract, so none to search or select");
  const copyPages = (await readPages(copy)).pages;
  for (const s of [SECRETS.name, "Quarterly", "alice", "4111"]) assert.equal(copyPages.flatMap((p) => findTerm(p, s)).length, 0, `"${s}" can't be found in the copy`);

  // 4. The boxes are black in the pictures, where the words were.
  const shot = (n) => draw(copy, n, 150);
  const one = await shot(1);
  const rects = pixelRects(edit.boxes.filter((b) => b.page === 1), one.plan.scale, one.plan.width, one.plan.height, 0);
  let dark = 0,
    total = 0;
  for (const r of rects)
    for (let y = r.y + 3; y < r.y + r.h - 3; y++)
      for (let x = r.x + 3; x < r.x + r.w - 3; x++) {
        total++;
        if (luma(one.data, one.plan.width, x, y) < 40) dark++;
      }
  assert.ok(total > 5000);
  assert.ok(dark / total > 0.999, `${dark} of ${total} pixels under the boxes are black`);
  // And what wasn't boxed is still there to read: white paper and ink.
  const unrelated = inkIn(one, Math.floor(72 * one.plan.scale), Math.floor((792 - 100 - 14) * one.plan.scale), Math.ceil(300 * one.plan.scale), Math.ceil((792 - 100 + 4) * one.plan.scale));
  assert.ok(unrelated.length > 100, "the unrelated line is still legible ink");
  assert.ok(unrelated.every((p) => !inside(rects)(p)));
  assert.ok(luma(one.data, one.plan.width, 5, 5) > 250, "white paper");
  // The rotated page, drawn as it is shown.
  const two = await shot(2);
  const rects2 = pixelRects(edit.boxes.filter((b) => b.page === 2), two.plan.scale, two.plan.width, two.plan.height, 0);
  assert.ok(rects2.length >= 1);
  for (const r of rects2) assert.ok(luma(two.data, two.plan.width, r.x + (r.w >> 1), r.y + (r.h >> 1)) < 40);
  assert.deepEqual([two.plan.width, two.plan.height], [Math.round(792 * (150 / 72)), Math.round(612 * (150 / 72))]);
  await close(copy);
});

test("a copy with no boxes is still only pictures: flattened, with no details, and nothing else drawn", { skip: needCanvas, timeout: 60000 }, async () => {
  const doc = await openDoc(fixture());
  const { sizes } = await pagesOf(doc);
  const out = await redactPages({ sizes, boxes: [], dpi: 150, pages: [1], surface: surfaceFor(doc) });
  assert.equal(out.check.ok, true);
  const file = latin1(out.bytes);
  for (const s of [SECRETS.title, SECRETS.author, "Quarterly report"]) assert.ok(!file.includes(s));
  await close(doc);
});

test("a page can be left out of the copy, a bad page is refused, and Cancel stops between pages", { skip: needCanvas, timeout: 60000 }, async () => {
  const doc = await openDoc(fixture());
  const { sizes } = await pagesOf(doc);
  const stats = { live: 0, max: 0, drawn: [] };
  const out = await redactPages({ sizes, boxes: [], dpi: 150, pages: [2], surface: surfaceFor(doc, stats) });
  assert.deepEqual(stats.drawn, [2]);
  assert.equal(out.check.pages, 1);
  await assert.rejects(redactPages({ sizes, boxes: [], dpi: 150, pages: [3], surface: surfaceFor(doc) }), PdfRedactError);
  await assert.rejects(redactPages({ sizes, boxes: [], dpi: 150, pages: [], surface: surfaceFor(doc) }), PdfRedactError);
  const controller = new AbortController();
  const drawn = { live: 0, max: 0, drawn: [] };
  const surface = surfaceFor(doc, drawn);
  const inner = surface.encode;
  surface.encode = async (c, q) => {
    controller.abort();
    return inner(c, q);
  };
  await assert.rejects(redactPages({ sizes, boxes: [], dpi: 150, pages: [1, 2], surface, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(drawn.drawn, [1], "no page after Cancel");
  assert.equal(drawn.live, 0, "and the page in hand is let go");
  await close(doc);
});

test("the page cap is 200; a big document is refused before any page is drawn, and 200 pages write fine", async () => {
  assert.equal(MAX_PAGES, 200);
  assert.equal(pageCapProblem(200), null);
  assert.match(pageCapProblem(201), /^This PDF has 201 pages\. Redact a PDF takes up to 200\. Split it first, then redact each part\.$/);
  assert.match(pageCapProblem(1234), /1,234 pages/);
  const sizes = Array.from({ length: 201 }, () => ({ width: 10, height: 10 }));
  let drawn = 0;
  const surface = { draw: async () => drawn++, black() {}, encode: async () => new Uint8Array(), free() {} };
  await assert.rejects(redactPages({ sizes, boxes: [], dpi: 150, pages: sizes.map((_, i) => i + 1), surface }), PdfRedactError);
  assert.equal(drawn, 0);
  // 200 pages, one after another, through the real writer.
  const flate = Uint8Array.of(120, 156, 99, 96, 96, 96, 0, 0, 0, 4, 0, 1);
  const w = new PdfWriter();
  for (let i = 0; i < 200; i++) w.addPage({ width: 612, height: 792, image: { kind: "flate", width: 1, height: 1, data: flate } });
  const { parts, length } = w.finish();
  const all = new Uint8Array(length);
  let at = 0;
  for (const p of parts) (all.set(p, at), (at += p.length));
  assert.deepEqual(checkImageOnlyPdf(all), { ok: true, pages: 200, problems: [] });
});

test("an oversized copy is refused with a plain message rather than run out of memory", async () => {
  const jpeg = napi ? new Uint8Array(napi.createCanvas(8, 8).toBuffer("image/jpeg", 80)) : null;
  if (!jpeg) return;
  const sizes = [{ width: 10, height: 10 }];
  const surface = { draw: async () => 1, black() {}, encode: async () => jpeg, free() {} };
  await assert.rejects(redactPages({ sizes, boxes: [], dpi: 150, pages: [1], surface, maxBytes: 100 }), /getting too large/);
  assert.equal((await redactPages({ sizes, boxes: [], dpi: 150, pages: [1], surface })).check.ok, true);
  assert.equal(MAX_OUTPUT_BYTES, 600 * 1024 * 1024);
});

test("no network: the page's files never fetch, and a whole redaction opens no request or socket", { skip: needCanvas, timeout: 60000 }, async () => {
  for (const f of ["src/pdf-redact.js", "src/pdf-redact-canvas.js", "src/pdf-writer.js", "src/pdf-check.js", "src/pdf-handoff.js", "src/PdfRedact.jsx"]) {
    const src = read(f);
    assert.doesNotMatch(src, /\bfetch\s*\(|XMLHttpRequest|sendBeacon|new WebSocket|EventSource|navigator\.serviceWorker|\bapi\(|\/api\//, f);
    assert.doesNotMatch(src, /https?:\/\/(?!www\.w3\.org)/, `${f} names no host`);
  }
  // The only dynamic imports are code the app already ships, loaded on demand.
  const dynamic = [...read("src/PdfRedact.jsx").matchAll(/import\(("[^"]+")\)/g)].map((m) => m[1]).sort();
  assert.deepEqual(dynamic, ['"./ocr-engine.js"', '"./ocr.js"']);
  assert.match(read("src/pdf-text.js"), /import\("pdfjs-dist"\)/);
  // A whole run with fetch and sockets watched.
  const calls = [];
  const realFetch = globalThis.fetch;
  const realConnect = net.Socket.prototype.connect;
  globalThis.fetch = (...a) => (calls.push(["fetch", String(a[0])]), Promise.reject(new Error("no network in this test")));
  net.Socket.prototype.connect = function (...a) {
    calls.push(["socket", a[0]]);
    throw new Error("no network in this test");
  };
  try {
    const doc = await openDoc(fixture());
    const { pages, sizes } = await pagesOf(doc);
    const boxes = boxesFor(pages[0], 1, SECRETS.name);
    const out = await redactPages({ sizes, boxes, dpi: 150, pages: [1, 2], surface: surfaceFor(doc) });
    assert.equal(out.check.ok, true);
    await close(doc);
  } finally {
    globalThis.fetch = realFetch;
    net.Socket.prototype.connect = realConnect;
  }
  assert.deepEqual(calls, []);
});

// ---- Send to chat, names and page ranges ------------------------------------------

test("page ranges read like 1-3, 5; anything else isn't a page", () => {
  assert.deepEqual(parsePageRange("", 5), [1, 2, 3, 4, 5]);
  assert.deepEqual(parsePageRange("ALL", 3), [1, 2, 3]);
  assert.deepEqual(parsePageRange("1-3, 5", 9), [1, 2, 3, 5]);
  assert.deepEqual(parsePageRange("5,1,1-2", 9), [1, 2, 5]);
  assert.deepEqual(parsePageRange("2 – 3", 9), [2, 3]);
  for (const bad of ["0", "3-1", "10", "1-", "a", "1,,2", "-2", "1-2-3", "1.5"]) assert.equal(parsePageRange(bad, 9), null, bad);
  assert.equal(rangeText([1, 2, 3, 5, 7, 8]), "1-3, 5, 7-8");
  assert.equal(rangeText([]), "");
  assert.equal(CHAT_IMAGES, 8);
  assert.equal(CHAT_OCR_PAGES, 20);
});

test("names: the copy is called for the file it came from, with nothing that isn't a name", () => {
  assert.equal(redactedName("Report 2026.pdf"), "Report 2026-redacted.pdf");
  assert.equal(redactedName("C:\\Users\\me\\statement.PDF"), "statement-redacted.pdf");
  assert.equal(redactedName("../../etc/passwd"), "passwd-redacted.pdf");
  assert.equal(redactedName("a<b>:c|d?.pdf"), "abcd-redacted.pdf");
  assert.equal(redactedName(""), "document-redacted.pdf");
  assert.equal(redactedName("x".repeat(300)).length, 100 + "-redacted.pdf".length);
  assert.equal(downloadName("my copy"), "my copy.pdf");
  assert.equal(downloadName("my copy.pdf"), "my copy.pdf");
  assert.equal(downloadName("a/b\\c.pdf"), "c.pdf");
  assert.equal(downloadName("   "), "redacted.pdf");
});

test("Send to chat: pictures are Redact Before You Send's chips, text is Local OCR's document, and only a signed-in, unsealed workspace gets either", () => {
  const item = chatImageItem("scan-page-2.jpg", "data:image/jpeg;base64,QUJD");
  assert.deepEqual(item, {
    name: "scan-page-2.jpg",
    url: "data:image/jpeg;base64,QUJD",
    cleanUrl: "data:image/jpeg;base64,QUJD",
    originalUrl: null,
    keep: false,
    redacted: true,
    clean: { status: "clean", details: [] },
  });
  const doc = chatTextDocument({ name: "scan.pdf", id: "d1", pages: [{ page: 1, text: "  first  " }, { page: 2, text: "   " }, { page: 3, text: "third" }] });
  assert.equal(doc.text, "[Page 1]\nfirst\n\n[Page 3]\nthird");
  assert.deepEqual([doc.kind, doc.source, doc.name, doc.id, doc.pages, doc.size], ["ocr", "ocr", "scan.pdf", "d1", null, null]);
  assert.match(buildDocumentBlock({ name: doc.name, text: doc.text, source: doc.source }), /source="ocr"/, "it goes as a document, so Shield's send-as-data path applies");
  assert.equal(chatTextDocument({ name: "x.pdf", id: "d", pages: [{ page: 1, text: "" }] }).text, "");
  assert.equal(sendBlock({ demo: false, signedIn: true, sealed: false }), null);
  assert.match(sendBlock({ demo: true, signedIn: true, sealed: false }), /signed-in workspace/);
  assert.match(sendBlock({ demo: false, signedIn: false, sealed: false }), /signed-in workspace/);
  assert.match(sendBlock({ demo: false, signedIn: true, sealed: true }), /Sealed Mode takes no attachments/);
  // The hand-off is one in-memory slot: taken once, gone after half a minute.
  holdForChat({ images: [item], documents: [] }, 1000);
  assert.deepEqual(takeForChat(2000), { images: [item], documents: [] });
  assert.equal(takeForChat(2001), null, "taken once");
  holdForChat({ images: [item] }, 1000);
  assert.equal(takeForChat(1000 + 30001), null, "expired");
  holdForChat(null);
  assert.equal(takeForChat(), null);
  // Only the new chat's composer receives it, and only in a chat; the router's history holds none of it.
  const ws = read("src/Workspace.jsx");
  assert.match(ws, /const pdfPages = takeForChat\(\);\s+if \(pdfPages && mode === "chat"\) \{\s+setAttachments\(pdfPages\.images \|\| \[\]\);\s+setDocuments\(pdfPages\.documents \|\| \[\]\);/);
  assert.match(ws, /holdForChat\(pages\);\s+navigate\("\/workspace\/chat" \+ \(demo \? "\?demo=1" : ""\)\);/);
  assert.match(ws, /sendBlocked=\{sendBlock\(\{ demo, signedIn: !!user, sealed: sealedOn \}\)\}/);
  // What the page hands over is made from the redacted copy's own bytes.
  const page = read("src/PdfRedact.jsx");
  assert.equal((page.match(/copyPagesAsImages\(result\.bytes,/g) || []).length, 2, "both paths read the finished copy");
  assert.doesNotMatch(page, /copyPagesAsImages\(doc|copyPagesAsImages\(file/);
});

// ---- the page --------------------------------------------------------------------

async function uiModule() {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-pdfredact-ui-"));
  const react = import.meta.resolve("react");
  writeFileSync(
    join(dir, "ui.mjs"),
    `import React from "${react}";\nexport const Icon = ({ name }) => React.createElement("svg", { "data-icon": name });\nexport const Notice = ({ children, type }) => React.createElement("div", { className: "notice " + (type || "") }, children);\nexport const Modal = ({ title, children }) => React.createElement("dialog", { "aria-label": title }, children);\n`,
  );
  const ui = pathToFileURL(join(dir, "ui.mjs")).href;
  const src = new URL("../src/PdfRedact.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const out = code
    .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "PdfRedact.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    // The module is loaded; its files can go.
    setTimeout(() => rmSync(dir, { recursive: true, force: true }), 0);
  }
}

test("the first screen says what it does, and what it doesn't, before anything is opened", async () => {
  const { default: PdfRedact } = await uiModule();
  const html = renderToStaticMarkup(createElement(PdfRedact, { config: config("all"), user: { id: "u" }, veilWords: [], onSendToChat() {} }));
  assert.match(html, /<h1>Redact a PDF<\/h1>/);
  assert.match(html, /it&#x27;s real removal, not a black box drawn on top/);
  assert.match(html, /The redacted PDF is pictures of your pages, so its text can&#x27;t be selected or searched\./);
  assert.match(html, /Nothing is uploaded unless you choose Send to chat\./);
  assert.match(html, /Nothing from the original file is copied, so the text under a box is gone\./);
  assert.match(html, /Up to 200 pages and 200 MB/);
  assert.match(html, /accept="\.pdf,application\/pdf"/);
  // No editor, no copy and no chat button until a file is open.
  for (const s of ["Make redacted copy", "Download", "Find text", "pdfr-work", "Undo"]) assert.ok(!html.includes(s), s);
  assert.match(html, /class="pdfr-drop-icon"/);
  // The user's own text is never translated.
  const source = read("src/PdfRedact.jsx");
  assert.match(source, /<b data-i18n="off">\{file\?\.name\}<\/b>/);
  assert.match(source, /<span data-i18n="off">\{f\.term\}<\/span>/);
  assert.match(source, /<span data-i18n="off">\s*\{s\.before/);
  assert.match(source, /<input type="text" value=\{name\}[^>]*data-i18n="off"/);
  assert.match(source, /name="pdf-password" type="password" autoComplete="off"[^>]*data-i18n="off"/);
  // The page keeps nothing: no storage, no cookie, no URL state to carry a name.
  assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB|document\.cookie|saveStore|readStore|history\.(push|replace)State|useSearchParams/);
  // No Auto Model, no model picker: the page calls no model.
  assert.doesNotMatch(source, /Auto|models=|useModel/);
});

test("Send to chat reads Local OCR only when it's released, and offers pictures otherwise; the copy is made from the file's own bytes", () => {
  const source = read("src/PdfRedact.jsx");
  assert.match(source, /const ocrLive = !!config && isReleased\(config, "ocr"\) && isReleased\(config, "documents"\);/);
  assert.match(source, /setSendMode\(ocrLive \? "text" : "images"\)/);
  const canvas = read("src/pdf-redact-canvas.js");
  assert.match(canvas, /getDocument\(\{ data: bytes\.slice\(\), isEvalSupported: false, verbosity: 0 \}\)/);
  assert.match(canvas, /getDocument\(\{ data, isEvalSupported: false, verbosity: 0 \}\)/);
  // Every picture the page makes for a chat is under the composer's image limit, or refused.
  assert.match(canvas, /blob\.size <= CHAT_IMAGE_BYTES/);
  // A password is asked for here, used once and never kept.
  assert.doesNotMatch(canvas + source, /setPassword|savePassword|rememberPassword|localStorage|sessionStorage/);
  assert.match(source, /ask\.resolve\(String\(value \?\? ""\)\);\s+setAsk\(null\);/, "the typed password is handed on once and dropped");
});

// ---- Chinese and Spanish -----------------------------------------------------------

test("every string the page shows has Chinese and Spanish, and no Chinese leaks into Spanish", () => {
  const zh = compileDictionary(JSON.parse(read("src/i18n/zh.json")), "zh");
  const es = compileDictionary(JSON.parse(read("src/i18n/es.json")), "es");
  const han = /\p{Script=Han}/u;
  const strings = [
    "PDF Redact",
    "Redact a PDF on your device before you share it. Real removal, not a black box drawn on top.",
    "Find words, emails, phone numbers and more, or draw boxes by hand",
    "Every page is redrawn with your boxes solid black, so nothing is left under them",
    "Done on your device; the copy is pictures, so its text can't be selected or searched",
    "Redact a PDF",
    "Black out names, numbers and anything else in a PDF before you share it. Done on your device, and the text under a box is really gone.",
    "Opening Redact a PDF…",
    "REDACT A PDF",
    "Black out names, numbers and anything else before you share a PDF. It's done on this device, and it's real removal, not a black box drawn on top.",
    "Choose another PDF",
    "Choose a PDF file.",
    "This file is larger than 200 MB. Split it first.",
    "This file isn't a PDF.",
    "This file can't be opened as a PDF.",
    "This PDF is password-protected. Enter its password to open it.",
    "Drop a PDF here",
    "Up to 200 pages and 200 MB. It's opened on this device; nothing is uploaded.",
    "Choose a PDF",
    "Real removal",
    "Each page is redrawn as a picture with your boxes painted solid black, then written into a new PDF. Nothing from the original file is copied, so the text under a box is gone.",
    "What it costs you",
    "The redacted PDF is pictures of your pages, so its text can't be selected or searched.",
    "On this device",
    "Your PDF is opened and redacted here. Nothing is uploaded unless you choose Send to chat.",
    "Find it or draw it",
    "Search for words, tap a finder for emails, phone numbers and more, or draw boxes yourself.",
    "Check before you share",
    "Look at every page. Scans and pictures have no text to find, so draw boxes over those.",
    "Waiting for the password…",
    "Reading your PDF on this device…",
    "This all happens on your device. Nothing is uploaded.",
    "1 page · 12 KB",
    "3 pages · 12 KB",
    "Find text",
    "Word, name or number to find",
    "Word, name or number",
    "Match case",
    "Whole word",
    "No matches.",
    "1 match on 1 page",
    "2 matches on 1 page",
    "5 matches on 3 pages",
    "Redact this match",
    "Redact all 5 matches",
    "Show this page",
    "Page 3",
    "Redact",
    "Show more matches",
    "Listing the first 300. Redact all still covers every match.",
    "Words you've redacted",
    "1 box",
    "4 boxes",
    "Remove the boxes for this find",
    "Find automatically",
    "Email addresses",
    "Phone numbers",
    "Card numbers",
    "IBANs",
    "Wallet addresses",
    "Keys and secrets",
    "IP addresses",
    "Your Veil words",
    "4 found",
    "None found",
    "Boxed",
    "Box all",
    "Finders use the same checks as Veil. They don't find names; search for a name above, or add it to Veil's always-veil words.",
    "1 page has no text to search (a scan or a picture). Draw boxes on it yourself.",
    "3 pages have no text to search (scans or pictures). Draw boxes on them yourself.",
    "Boxes",
    "No boxes yet. Search, tap a finder or draw on a page.",
    "1 box on 1 page",
    "4 boxes on 1 page",
    "4 boxes on 2 pages",
    "Undo",
    "Redo",
    "Clear all boxes",
    "Those places already have boxes.",
    "Nothing new to box.",
    "Stopped at 5,000 boxes.",
    "1 box added. Check every page before you share the copy.",
    "3 boxes added. Check every page before you share the copy.",
    "Page tools",
    "Tool",
    "Draw",
    "Scroll",
    "Drag on a page to draw a box",
    "Scroll with a finger; tap a box to select it",
    "Zoom",
    "Zoom out",
    "Zoom in",
    "Fit to width",
    "Delete box",
    "Drag the box to move it or a corner to resize it. Delete removes it.",
    "Drag on a page to draw a box. Click a box to move, resize or delete it.",
    "Scroll the pages, and tap a box to select it. Switch to Draw to add or move boxes.",
    "This copy is out of date.",
    "Your redacted PDF is ready.",
    "You changed the boxes after making it. Make the copy again before you download or send it.",
    "1 page · 1.2 MB · 200 dpi",
    "3 pages · 1.2 MB · 200 dpi",
    "Checked in the file itself: only page pictures. No text, fonts, metadata, annotations, form fields, attachments or scripts.",
    "1 very large page was drawn a little smaller than the quality you chose.",
    "2 very large pages were drawn a little smaller than the quality you chose.",
    "The copy isn't password-protected.",
    "File name",
    "Download",
    "Send to chat",
    "Send to chat isn't available here. Download the copy instead.",
    "Send to chat needs a signed-in workspace. Download the copy instead.",
    "Sealed Mode takes no attachments. Turn it off to send pages to a chat, or download the copy.",
    "The text is read from the redacted pages on this device and attached to a new chat as a document. Nothing is sent until you press Send there.",
    "The redacted pages are attached to a new chat as pictures. Nothing is sent until you press Send there.",
    "Pages to send (up to 8)",
    "Pages to send (up to 20)",
    "Read and attach",
    "Attach pictures",
    "Send pictures instead",
    "Send the text instead",
    "Choose pages between 1 and 12, like 1-3, 5.",
    "The text of up to 20 pages can be read at a time.",
    "A chat takes up to 8 pictures. Choose fewer pages.",
    "No text could be read on those pages. Send them as pictures instead.",
    "The pages couldn't be sent to a chat.",
    "Page 4 is too large to attach as a picture.",
    "The copy didn't pass its own check, so it isn't offered. Nothing was saved. Try again.",
    "The redacted copy couldn't be made.",
    "The copy is getting too large. Choose a lower quality, or redact fewer pages.",
    "A page couldn't be made into a picture.",
    "A page couldn't be read.",
    "There are no pages to copy.",
    "Page 9 isn't in this PDF.",
    "This page couldn't be drawn.",
    "This PDF has 1,234 pages. Redact a PDF takes up to 200. Split it first, then redact each part.",
    "Making page 2 of 12…",
    "Reading page 2 of 12 on this device…",
    "Preparing page 2 of 12…",
    "No boxes yet",
    "Copy quality",
    "150 dpi (smaller file)",
    "300 dpi (sharper text)",
    "Cancel",
    "Make redacted copy",
    "This PDF is password-protected",
    "That password didn't work. Try again.",
    "Password",
    "The password opens the file here and isn't kept. The redacted copy is not password-protected.",
    "Open",
    "Look at the copy",
    "Back to the original",
    "This is the redacted copy as it will be shared: pictures of your pages, with the boxes solid black. Nothing is drawn over it here.",
    "The copy couldn't be shown.",
    "PDF Redact: the PDF is opened, boxed and redrawn in your browser, and the redacted copy is written there. Nothing is uploaded, saved or added to your export unless you choose Send to chat, and then only the redacted pages, as pictures or as the text read from them on this device, go to a new chat.",
  ];
  const missing = [];
  for (const s of strings) {
    const z = translateText(s, zh),
      e = translateText(s, es);
    if (z === undefined || !han.test(z)) missing.push(["zh", s]);
    if (e === undefined || han.test(e)) missing.push(["es", s]);
  }
  assert.deepEqual(missing, []);
  // Numbers, names and sizes inside a pattern stay as they are.
  assert.match(translateText("Redact all 5 matches", zh), /5/);
  assert.match(translateText("1 page · 1.2 MB · 200 dpi", es), /1\.2 MB/);
});

// ---- headless Chrome: the real flow, the real canvas and the real JPEGs ------------
// Opens a generated PDF on the page, searches a name, taps two finders, makes
// the copy and downloads it, then reads the downloaded bytes here: only page
// pictures, none of the original's words or details, and the requests the
// page made after the file was chosen are its own files and nothing else.
// Needs Chrome and a build (npm run build); skipped otherwise.

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const noChrome = !existsSync(CHROME) || !existsSync("dist/client/index.html");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
async function chrome(t) {
  const profile = mkdtempSync(join(tmpdir(), "anonyma-pdfredact-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  t.after(async () => {
    proc.kill();
    await wait(300);
    rmSync(profile, { recursive: true, force: true });
  });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try {
      port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    } catch {
      await wait(100);
    }
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((x) => x.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  t.after(() => ws.close());
  let seq = 0;
  const pending = new Map(),
    listeners = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) for (const fn of listeners) fn(m);
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return;
      } catch {}
      await wait(150);
    }
    throw new Error("timed out waiting for " + expression);
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("DOM.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  return { send, evaluate, until, listeners };
}

test("headless: the real browser draws, paints and writes a copy with no text, no details and no request but its own files", { skip: noChrome && "needs Chrome and dist/", timeout: 240000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-pdfredact-e2e-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const svc = createApp({ testMode: true, released: "all", origin, dbPath: join(dir, "db.sqlite"), mediaPath: join(dir, "media"), catalogPath: join(dir, "models.json") });
  const server = svc.app.listen(port, "127.0.0.1");
  t.after(() => {
    server.close();
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const source = makePdf({
    pages: [
      { items: [{ text: "Quarterly report", x: 72, y: 720, size: 18 }, { text: `Holder: ${SECRETS.name}`, x: 72, y: 680 }, { text: `Mail ${SECRETS.email} now`, x: 72, y: 650 }, { text: `Card ${SECRETS.card} ok`, x: 72, y: 620 }, { text: "Closing words stay", x: 72, y: 100, size: 14 }] },
      { items: [{ text: `Second page for ${SECRETS.name}`, x: 72, y: 700 }] },
    ],
    info: { Title: SECRETS.title, Author: SECRETS.author },
    xmp: "<x:xmpmeta>" + SECRETS.xmp + "</x:xmpmeta>",
    attachment: { name: SECRETS.attachmentName, data: SECRETS.attachment },
  });
  const file = join(dir, "statement.pdf");
  writeFileSync(file, source);

  const page = await chrome(t);
  const requests = [];
  page.listeners.push((m) => m.method === "Network.requestWillBeSent" && requests.push({ url: m.params.request.url, method: m.params.request.method, at: Date.now() }));
  await page.send("Page.navigate", { url: origin + "/" });
  await page.until(`document.readyState === "complete"`);
  const status = await page.evaluate(`fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "pdfredact-e2e", password: "test-password-long" }) }).then((r) => r.status)`);
  assert.equal(status, 201);
  await page.send("Page.navigate", { url: origin + "/workspace/pdfredact" });
  await page.until(`!!document.querySelector(".pdfr-drop")`);
  const { root } = await page.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: 'input[type=file][accept*="pdf"]' });
  const chosen = Date.now();
  await page.send("DOM.setFileInputFiles", { nodeId, files: [file] });
  await page.until(`!!document.querySelector(".pdfr-work")`);
  // Search a name, box every match, tap two finders.
  await page.evaluate(`document.querySelector(".pdfr-search input").focus()`);
  await page.send("Input.insertText", { text: "alice wonderland" });
  await page.until(`/2 matches on 2 pages/.test(document.body.innerText)`);
  await page.evaluate(`document.querySelector(".pdfr-primary.small").click()`);
  await page.until(`!!document.querySelector(".pdfr-chips")`);
  for (const label of ["Email addresses", "Card numbers"])
    await page.evaluate(`(() => { const li = [...document.querySelectorAll(".pdfr-detectors li")].find((l) => l.innerText.startsWith(${JSON.stringify(label)})); li.querySelector("button").click(); })()`);
  await page.until(`document.querySelectorAll(".pdfr-detectors .pdfr-toggle.on").length === 2`);
  await page.evaluate(`(() => { window.__blobs = []; const c = URL.createObjectURL; URL.createObjectURL = function (b) { window.__blobs.push(b); return c.call(URL, b); }; })()`);
  await page.evaluate(`document.querySelector(".pdfr-dock .pdfr-primary").click()`);
  await page.until(`!!document.querySelector(".pdfr-result:not(.stale)")`, 90000);
  assert.match(await page.evaluate(`document.querySelector(".pdfr-result").innerText`), /Checked in the file itself: only page pictures/);
  await page.evaluate(`document.querySelector(".pdfr-result .pdfr-primary").click()`);
  await page.until(`window.__blobs.length === 1`);
  const b64 = await page.evaluate(`(async () => { const buf = new Uint8Array(await window.__blobs[0].arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000)); return btoa(s); })()`);
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  const after = requests.filter((r) => r.at >= chosen);

  // The file the browser wrote: only pictures of pages, and none of the original's words or details.
  assert.deepEqual(checkImageOnlyPdf(bytes), { ok: true, pages: 2, problems: [] });
  const text = latin1(bytes);
  for (const s of [SECRETS.name, "Wonderland", SECRETS.email, "4111", SECRETS.title, SECRETS.author, SECRETS.xmp, SECRETS.attachment, SECRETS.attachmentName, "Quarterly report", "Closing words"]) assert.ok(!text.includes(s), s);
  for (const s of ["/Font", "/Info", "/Annots", "/Metadata", "/EmbeddedFile", "Exif", "JFIF", "BT\n"]) assert.ok(!text.includes(s), s);
  const copy = await openDoc(bytes);
  assert.equal(copy.numPages, 2);
  for (let n = 1; n <= 2; n++) assert.deepEqual((await (await copy.getPage(n)).getTextContent()).items.filter((i) => i.str.trim()), []);
  assert.equal((await copy.getMetadata()).metadata, null);
  await close(copy);
  // What was boxed is black in the real JPEG, and what wasn't is still ink on white.
  if (napi) {
    const again = await openDoc(bytes);
    const img = await draw(again, 1, 150);
    const src = await openDoc(source);
    const { pages } = await pagesOf(src);
    const boxes = [...boxesFor(pages[0], 1, SECRETS.name), ...boxesFor(pages[0], 1, SECRETS.email), ...boxesFor(pages[0], 1, SECRETS.card)];
    const rects = pixelRects(boxes, img.plan.scale, img.plan.width, img.plan.height, 0);
    let dark = 0,
      total = 0;
    // The boxes here come from equal character widths and the browser's from measured ones, so
    // they agree in the middle of each word and differ a little at its ends and in height: the middle is checked.
    for (const r of rects) for (let y = r.y + 7; y < r.y + r.h - 7; y++) for (let x = r.x + (r.w >> 2); x < r.x + r.w - (r.w >> 2); x++) (total++, luma(img.data, img.plan.width, x, y) < 40 && dark++);
    assert.ok(total > 2000 && dark / total > 0.999, `${dark} of ${total} boxed pixels are black`);
    const closing = inkIn(img, Math.floor(72 * img.plan.scale), Math.floor((792 - 100 - 14) * img.plan.scale), Math.ceil(300 * img.plan.scale), Math.ceil((792 - 100 + 4) * img.plan.scale));
    assert.ok(closing.length > 100, "the unboxed line is still legible");
    await close(again);
    await close(src);
  }
  // After the file was chosen the page asked for its own scripts and worker and nothing else: no other host, no API call, no upload.
  assert.ok(after.length >= 1);
  assert.deepEqual([...new Set(after.map((r) => new URL(r.url).origin))].filter((o) => o !== origin && o !== "null"), []);
  // Every one a plain GET (the workspace's own polling included: nothing carries the file), and no URL holds a word from it.
  assert.deepEqual(after.filter((r) => r.method !== "GET").map((r) => r.method + " " + r.url), []);
  for (const r of after) for (const word of ["Wonderland", "Alice", "example.com", "4111", "statement.pdf"]) assert.ok(!decodeURIComponent(r.url).includes(word), `${r.url} names "${word}"`);
});
