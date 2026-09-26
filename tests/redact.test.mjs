import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { crc32, deflateSync } from "node:zlib";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor, parseReleased, releaseInfo } from "../server/releases.js";
import { isReleased } from "../src/lib.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  BLOCKS_ACROSS,
  MAX_BOXES,
  MAX_HISTORY,
  MAX_ZOOM,
  MIN_BLOCK,
  MIN_ZOOM,
  addBox,
  applyBlack,
  applyPixelate,
  applyRedactions,
  blankEdit,
  clampBox,
  clampCrop,
  commit,
  createHistory,
  dataUrlType,
  editorSource,
  encodeAttempts,
  fitView,
  hitTest,
  moveRect,
  pixelBlock,
  rectFrom,
  redactedItem,
  redo,
  removeBox,
  resizeRect,
  styleBox,
  toImage,
  undo,
  zoomAt,
} from "../src/redact.js";
import { RedactError, bytesDataUrl, dataUrlBytes, finishRedacted } from "../src/redact-canvas.js";
import { withKeep } from "../src/clean-notes.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// ---- fixtures ----------------------------------------------------------------
// Every image here is drawn in code: test patterns and invented metadata.

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
}
// An RGBA PNG whose pixel (x, y) is pixel(x, y), with extra chunks after IHDR.
function png(width, height, pixel, extra = []) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) raw.set(pixel(x, y), y * (width * 4 + 1) + 1 + x * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    ...extra,
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
const pattern = (x, y) => [(x * 3) & 255, (y * 5) & 255, (x + y * 2) & 255, 255];
const TEXT_AUTHOR = pngChunk("tEXt", Buffer.from("Author\0Fixture Person", "latin1"));

// A 24x16 baseline JPEG test pattern with only its JFIF header (the same
// fixture Clean Uploads' tests use).
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
// BASE_JPEG with an EXIF APP1 holding one big-endian IFD0 entry.
function jpegWithExif(tag, type, count, value) {
  const tiff = Buffer.concat([
    Buffer.from("MM\0\x2a\0\0\0\x08", "latin1"),
    Buffer.from([0, 1]),
    Buffer.from([tag >> 8, tag & 255, 0, type]),
    Buffer.from([0, 0, 0, count]),
    value,
    Buffer.alloc(4),
  ]);
  const body = Buffer.concat([Buffer.from("Exif\0\0", "latin1"), tiff]);
  const len = Buffer.from([(body.length + 2) >> 8, (body.length + 2) & 255]);
  return Buffer.concat([BASE_JPEG.subarray(0, 2), Buffer.from([0xff, 0xe1]), len, body, BASE_JPEG.subarray(2)]);
}
const SOFTWARE_JPEG = jpegWithExif(0x0131, 2, 4, Buffer.from("Fix\0", "latin1"));
const ROTATED_JPEG = jpegWithExif(0x0112, 3, 1, Buffer.from([0, 6, 0, 0]));

// RGBA pixels in the shape of a canvas ImageData.
function image(width, height, fill = pattern) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) data.set(fill(x, y), (y * width + x) * 4);
  return { data, width, height };
}
const px = (img, x, y) => Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

// ---- the update and its gate -------------------------------------------------

test("Redact Before You Send is registered, unreleased, and client-only", () => {
  const update = UPDATES.find((u) => u.id === "redact");
  assert.ok(update, "expected a UPDATES entry with id 'redact'");
  assert.equal(update.title, "Redact Before You Send");
  assert.equal(update.tagline, "Black out what you don't want to share.");
  assert.equal(update.points.length, 3);
  // Committed as false until its "Release …" commit flips it to true.
  assert.equal(typeof committed[UPDATES.indexOf(update)], "boolean");
  const config = (released) => ({ releases: releaseInfo({ released: parseReleased(released) }) });
  assert.equal(isReleased(config("mvp"), "redact"), false);
  assert.equal(isReleased(config("mvp,cleanuploads"), "redact"), false);
  assert.equal(isReleased(config("mvp,redact"), "redact"), true);
  assert.equal(isReleased(config("all"), "redact"), true);
  // Nothing on the server depends on it: the redacted copy is made before
  // the request exists and goes out like any other image, so no route is
  // gated on it and nothing tells the server an image was redacted.
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } };
  for (const req of [
    { path: "/api/chat", method: "POST", body: { messages: [{ role: "user", content: [image] }] } },
    { path: "/api/images", method: "POST", body: { prompt: "x", images: ["data:image/png;base64,AAAA"] } },
  ])
    assert.ok(!featuresFor(req).includes("redact"));
});

test("the server reports it unreleased under the MVP and released under all", async (t) => {
  for (const [released, expected] of [["mvp", false], ["all", true]]) {
    const dir = mkdtempSync(join(tmpdir(), "anonyma-redact-"));
    const svc = createApp({
      testMode: true,
      released,
      origin: "http://localhost:5175",
      dbPath: join(dir, "db.sqlite"),
      mediaPath: join(dir, "media"),
      catalogPath: join(dir, "models.json"),
    });
    t.after(() => {
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const config = (await request(svc.app).get("/api/config").expect(200)).body;
    assert.equal(config.releases.features.redact, expected, released);
  }
});

// Redact.jsx and CleanUploads.jsx compiled for Node with the same esbuild
// Vite uses; the icon set is a stand-in so only their own markup renders.
async function uiModules() {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-redact-ui-"));
  const react = import.meta.resolve("react");
  writeFileSync(join(dir, "ui.mjs"), `import React from "${react}";\nexport const Icon = () => React.createElement("svg");\n`);
  const ui = pathToFileURL(join(dir, "ui.mjs")).href;
  const compile = async (name) => {
    const src = new URL(`../src/${name}.jsx`, import.meta.url);
    const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
    const out = code
      .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
      .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
      .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
      .replace(/from "react"/g, `from "${react}"`);
    const file = join(dir, name + ".mjs");
    writeFileSync(file, out);
    return import(pathToFileURL(file).href);
  };
  try {
    return { redact: await compile("Redact"), clean: await compile("CleanUploads") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the composer shows Redact only once released, and a redacted chip can't offer the original", async () => {
  const { redact, clean } = await uiModules();
  const config = (released) => ({ releases: releaseInfo({ released: parseReleased(released) }) });
  assert.equal(redact.redactReleased(config("mvp")), false);
  assert.equal(redact.redactReleased(null), false);
  assert.equal(redact.redactReleased(config("all")), true);

  // Workspace renders the chip tools and the editor only behind the gate.
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(ws, /const redactLive = redactReleased\(config\);/);
  assert.equal((ws.match(/<RedactChipTools/g) || []).length, 1);
  assert.equal((ws.match(/<RedactEditor/g) || []).length, 1);
  assert.match(ws, /\{redactLive && \(\s*<RedactChipTools/);
  assert.match(ws, /\{redactLive && redacting && imageItems\.includes\(redacting\) && \(\s*<RedactEditor/);
  const dc = readFileSync(new URL("../src/DataControls.jsx", import.meta.url), "utf8");
  assert.match(dc, /const redact = !!config && isReleased\(config, "redact"\);/);
  assert.match(dc, /\{redact && \(\s*<li>\s*Redact Before You Send:/);

  // A chip as Clean Uploads prepares it: cleaned copy sent, original kept aside.
  const item = {
    name: "statement.png",
    url: "data:image/png;base64,Q0xFQU4=",
    cleanUrl: "data:image/png;base64,Q0xFQU4=",
    originalUrl: "data:image/png;base64,T1JJR0lOQUw=",
    clean: { status: "cleaned", details: ["author"] },
    keep: false,
  };
  const chip = (it) =>
    renderToStaticMarkup(
      createElement(clean.CleanImageChip, { item: it, onKeep() {}, onRemove() {} }, createElement(redact.RedactChipTools, { item: it, onOpen() {} })),
    );
  const before = chip(item);
  assert.match(before, />Redact<\/span><\/button>/);
  assert.match(before, /aria-label="Redact statement\.png"/);
  assert.match(before, /Keep original/);
  assert.doesNotMatch(before, /Redacted/);
  assert.match(before, /<img [^>]*data-i18n="off"/);

  const after = redactedItem(item, "data:image/png;base64,UkVEQUNURUQ=", { status: "clean", details: [] });
  const html = chip(after);
  assert.match(html, /class="redact-tag">Redacted</);
  assert.match(html, />Redact<\/span><\/button>/, "redacting again stays possible");
  assert.doesNotMatch(html, /Keep original/, "no way back to the original");
  assert.doesNotMatch(html, /T1JJR0lOQUw=|Q0xFQU4=/, "neither earlier copy is in the chip");
  assert.match(html, /Removed: author/, "Clean Uploads' note still says what went");
  // Without Clean Uploads (a plain chip), Redact still works the same way.
  const plain = chip({ name: "plain.png", url: "data:image/png;base64,UExBSU4=" });
  assert.match(plain, />Redact</);
  assert.doesNotMatch(plain, /Keep original|Removed/);
});

// ---- geometry ----------------------------------------------------------------

test("boxes clamp to the image, round outward to whole pixels, and vanish when outside", () => {
  assert.deepEqual(rectFrom({ x: 10, y: 40 }, { x: 2, y: 5 }), { x: 2, y: 5, w: 8, h: 35 });
  assert.deepEqual(clampBox({ x: 10.4, y: 5.6, w: 20.2, h: 10.1, style: "black" }, 100, 50), {
    x: 10, y: 5, w: 21, h: 11, style: "black",
  });
  // Partly outside: cut at the edges.
  assert.deepEqual(clampBox({ x: -20, y: 40, w: 50, h: 30, style: "pixelate" }, 100, 50), {
    x: 0, y: 40, w: 30, h: 10, style: "pixelate",
  });
  // A negative size is the same rectangle drawn the other way.
  assert.deepEqual(clampBox({ x: 30, y: 30, w: -10, h: -10 }, 100, 50), { x: 20, y: 20, w: 10, h: 10, style: "black" });
  // Entirely outside, empty or not a number: nothing.
  assert.equal(clampBox({ x: 120, y: 0, w: 10, h: 10 }, 100, 50), null);
  assert.equal(clampBox({ x: 5, y: 5, w: 0, h: 10 }, 100, 50), null);
  assert.equal(clampBox({ x: NaN, y: 5, w: 10, h: 10 }, 100, 50), null);
  assert.equal(clampBox({ x: 0, y: 0, w: Infinity, h: 10 }, 100, 50), null);
  // Only the two styles exist; anything else is Black, the safe one.
  assert.equal(clampBox({ x: 0, y: 0, w: 5, h: 5, style: "blur" }, 100, 50).style, "black");
  // A crop covering the whole image is no crop.
  assert.equal(clampCrop({ x: -5, y: -5, w: 200, h: 200 }, 100, 50), null);
  assert.deepEqual(clampCrop({ x: 10, y: 10, w: 30, h: 20 }, 100, 50), { x: 10, y: 10, w: 30, h: 20 });
});

test("drawing, moving, resizing and hit-testing boxes", () => {
  const edit = blankEdit();
  // A click (under MIN_BOX) draws nothing.
  assert.equal(addBox(edit, { x: 5, y: 5 }, { x: 6, y: 6 }, "black", 100, 100), null);
  const one = addBox(edit, { x: 60, y: 60 }, { x: 10, y: 20 }, "pixelate", 100, 100);
  assert.deepEqual(one.boxes, [{ x: 10, y: 20, w: 50, h: 40, style: "pixelate" }]);
  // Drawn past the edge: clamped.
  const two = addBox(one, { x: 90, y: 90 }, { x: 140, y: 130 }, "black", 100, 100);
  assert.deepEqual(two.boxes[1], { x: 90, y: 90, w: 10, h: 10, style: "black" });
  // Topmost first, corners before bodies.
  assert.deepEqual(hitTest(two.boxes, { x: 95, y: 95 }, 2), { index: 1, handle: "move" });
  assert.deepEqual(hitTest(two.boxes, { x: 11, y: 19 }, 2), { index: 0, handle: "nw" });
  assert.deepEqual(hitTest(two.boxes, { x: 60, y: 60 }, 2), { index: 0, handle: "se" });
  assert.equal(hitTest(two.boxes, { x: 5, y: 5 }, 2), null);
  // Resizing keeps the opposite corner; it can't shrink below MIN_BOX.
  assert.deepEqual(resizeRect(one.boxes[0], "se", { x: 80, y: 90 }, 100, 100), { x: 10, y: 20, w: 70, h: 70, style: "pixelate" });
  assert.deepEqual(resizeRect(one.boxes[0], "nw", { x: 70, y: 70 }, 100, 100), { x: 60, y: 60, w: 10, h: 10, style: "pixelate" });
  assert.deepEqual(resizeRect(one.boxes[0], "se", { x: 10.5, y: 20.5 }, 100, 100), one.boxes[0]);
  // A crop rectangle (no style) stays one.
  assert.deepEqual(resizeRect({ x: 0, y: 0, w: 100, h: 100 }, "se", { x: 50, y: 40 }, 100, 100), { x: 0, y: 0, w: 50, h: 40 });
  // Moving stays inside the image, on whole pixels.
  assert.deepEqual(moveRect(one.boxes[0], 100, -100, 100, 100), { x: 50, y: 0, w: 50, h: 40, style: "pixelate" });
  assert.deepEqual(moveRect(one.boxes[0], 2.4, 2.6, 100, 100), { x: 12, y: 23, w: 50, h: 40, style: "pixelate" });
  // Restyle and remove.
  assert.equal(styleBox(two, 0, "black").boxes[0].style, "black");
  assert.deepEqual(removeBox(two, 0).boxes, [two.boxes[1]]);
  // There's a limit.
  let many = blankEdit();
  for (let i = 0; i < MAX_BOXES; i++) many = addBox(many, { x: 0, y: 0 }, { x: 10, y: 10 }, "black", 100, 100);
  assert.equal(many.boxes.length, MAX_BOXES);
  assert.equal(addBox(many, { x: 0, y: 0 }, { x: 10, y: 10 }, "black", 100, 100), null);
});

test("undo and redo cover boxes and crop together", () => {
  let h = createHistory();
  const a = { boxes: [{ x: 1, y: 1, w: 5, h: 5, style: "black" }], crop: null };
  const b = { ...a, crop: { x: 0, y: 0, w: 10, h: 10 } };
  h = commit(h, a);
  h = commit(h, b);
  assert.equal(commit(h, { ...b, boxes: [...b.boxes] }), h, "an unchanged edit isn't a step");
  h = undo(h);
  assert.deepEqual(h.present, a);
  h = undo(h);
  assert.deepEqual(h.present, blankEdit());
  assert.equal(undo(h), h);
  h = redo(h);
  assert.deepEqual(h.present, a);
  // A new edit drops what could be redone.
  h = commit(h, { boxes: [], crop: { x: 2, y: 2, w: 4, h: 4 } });
  assert.deepEqual(h.future, []);
  assert.equal(redo(h), h);
  for (let i = 0; i < MAX_HISTORY + 20; i++) h = commit(h, { boxes: [{ x: i, y: 0, w: 5, h: 5, style: "black" }], crop: null });
  assert.equal(h.past.length, MAX_HISTORY);
});

test("zoom keeps the point under the pointer still, within limits; fit centres the image", () => {
  const v = fitView(1000, 500, 800, 600, 0);
  assert.equal(v.scale, 0.8);
  assert.deepEqual([v.x, v.y], [0, 100]);
  // Small images are enlarged, but at most 3x.
  assert.equal(fitView(100, 50, 2000, 2000, 0).scale, 3);
  const before = toImage(v, 300, 250);
  const z = zoomAt(v, 2, 300, 250);
  assert.equal(z.scale, 1.6);
  const after = toImage(z, 300, 250);
  assert.ok(Math.abs(after.x - before.x) < 1e-9 && Math.abs(after.y - before.y) < 1e-9);
  assert.equal(zoomAt(v, 1000, 0, 0).scale, MAX_ZOOM);
  assert.equal(zoomAt(v, 0.0001, 0, 0).scale, MIN_ZOOM);
});

// ---- compositing -------------------------------------------------------------

test("Black makes every pixel in the box opaque black and touches nothing else", () => {
  const img = image(40, 30);
  const box = clampBox({ x: 5, y: 4, w: 12, h: 9 }, 40, 30);
  applyBlack(img.data, img.width, box);
  for (let y = 0; y < 30; y++)
    for (let x = 0; x < 40; x++) {
      const inside = x >= 5 && x < 17 && y >= 4 && y < 13;
      assert.deepEqual(px(img, x, y), inside ? [0, 0, 0, 255] : pattern(x, y), `${x},${y}`);
    }
  // Transparent pixels under a box become opaque black too.
  const clear = image(4, 4, () => [200, 10, 10, 0]);
  applyRedactions(clear, [{ x: 0, y: 0, w: 4, h: 4, style: "black" }]);
  assert.deepEqual(px(clear, 2, 2), [0, 0, 0, 255]);
});

test("Pixelate uses large blocks, each the average of only its own pixels", () => {
  assert.equal(pixelBlock({ w: 20, h: 20 }), MIN_BLOCK);
  assert.equal(pixelBlock({ w: 400, h: 120 }), Math.ceil(120 / BLOCKS_ACROSS));
  assert.equal(pixelBlock({ w: 3, h: 900 }), MIN_BLOCK);
  // Outside the box every pixel is 255; if any leaked into an average the
  // block would come out lighter than the inside's own values.
  const w = 60,
    h = 50,
    box = { x: 10, y: 10, w: 40, h: 30, style: "pixelate" };
  const inside = (x, y) => x >= 10 && x < 50 && y >= 10 && y < 40;
  const img = image(w, h, (x, y) => (inside(x, y) ? [(x * 7) % 200, (y * 3) % 200, 50, 255] : [255, 255, 255, 255]));
  const original = image(w, h, (x, y) => (inside(x, y) ? [(x * 7) % 200, (y * 3) % 200, 50, 255] : [255, 255, 255, 255]));
  applyRedactions(img, [box]);
  const block = pixelBlock(box);
  assert.equal(block, MIN_BLOCK);
  for (let by = 10; by < 40; by += block)
    for (let bx = 10; bx < 50; bx += block) {
      const bw = Math.min(block, 50 - bx),
        bh = Math.min(block, 40 - by);
      const sum = [0, 0, 0, 0];
      for (let y = by; y < by + bh; y++)
        for (let x = bx; x < bx + bw; x++) px(original, x, y).forEach((v, i) => (sum[i] += v));
      const avg = sum.map((s) => Math.round(s / (bw * bh)));
      for (let y = by; y < by + bh; y++)
        for (let x = bx; x < bx + bw; x++) assert.deepEqual(px(img, x, y), avg, `block ${bx},${by} at ${x},${y}`);
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) if (!inside(x, y)) assert.deepEqual(px(img, x, y), [255, 255, 255, 255]);
  // Far fewer colours than pixels are left in the box.
  const colours = new Set();
  for (let y = 10; y < 40; y++) for (let x = 10; x < 50; x++) colours.add(px(img, x, y).join());
  assert.ok(colours.size <= Math.ceil(40 / block) * Math.ceil(30 / block));
});

test("boxes apply in order, partly-outside boxes are cut, and outside ones are skipped", () => {
  const img = image(20, 20);
  const applied = applyRedactions(img, [
    { x: 15, y: 15, w: 20, h: 20, style: "black" },
    { x: 40, y: 40, w: 5, h: 5, style: "black" },
    { x: 0, y: 0, w: 4, h: 4, style: "pixelate" },
  ]);
  assert.deepEqual(applied, [
    { x: 15, y: 15, w: 5, h: 5, style: "black" },
    { x: 0, y: 0, w: 4, h: 4, style: "pixelate" },
  ]);
  assert.deepEqual(px(img, 19, 19), [0, 0, 0, 255]);
  assert.deepEqual(px(img, 14, 14), pattern(14, 14));
  const [r, g, b] = px(img, 0, 0);
  assert.deepEqual(px(img, 3, 3).slice(0, 3), [r, g, b]);
  // A pixelate box over a black one can't bring anything back.
  const again = image(10, 10);
  applyRedactions(again, [
    { x: 0, y: 0, w: 10, h: 10, style: "black" },
    { x: 0, y: 0, w: 10, h: 10, style: "pixelate" },
  ]);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) assert.deepEqual(px(again, x, y), [0, 0, 0, 255]);
});

// ---- output ------------------------------------------------------------------

test("encoding: JPEG stays JPEG, anything else is PNG, then smaller JPEGs until it fits", () => {
  const png = encodeAttempts("image/png");
  assert.deepEqual(png[0], { type: "image/png", quality: undefined, scale: 1 });
  assert.equal(png[1].type, "image/jpeg");
  assert.equal(encodeAttempts("image/gif")[0].type, "image/png");
  assert.equal(encodeAttempts("image/webp")[0].type, "image/png");
  const jpeg = encodeAttempts("image/jpeg");
  assert.deepEqual(jpeg[0], { type: "image/jpeg", quality: 0.92, scale: 1 });
  for (const list of [png, jpeg]) {
    for (let i = 1; i < list.length; i++) assert.ok(list[i].scale <= list[i - 1].scale);
    assert.ok(list.at(-1).scale < 0.3);
    assert.ok(list.every((a) => a.type === "image/png" || a.type === "image/jpeg"), "never another format");
  }
});

test("the redacted copy is checked by Clean Uploads' strip step: no EXIF, no text chunks", async () => {
  // A canvas never writes these; if one ever did, they'd still go.
  const jpeg = await finishRedacted(new Uint8Array(SOFTWARE_JPEG));
  assert.equal(Buffer.compare(Buffer.from(jpeg.bytes), BASE_JPEG), 0);
  assert.ok(!Buffer.from(jpeg.bytes).includes("Exif"));
  assert.equal(jpeg.type, "image/jpeg");
  assert.equal(jpeg.status, "cleaned");
  const clean = await finishRedacted(new Uint8Array(BASE_JPEG));
  assert.equal(clean.status, "clean");
  assert.deepEqual(clean.details, []);
  const withText = png(8, 8, pattern, [TEXT_AUTHOR]);
  const out = await finishRedacted(new Uint8Array(withText));
  assert.ok(!Buffer.from(out.bytes).includes("tEXt"));
  assert.ok(!Buffer.from(out.bytes).includes("Fixture Person"));
  assert.equal(out.type, "image/png");
  // It never redraws: an orientation it would have to apply is refused.
  await assert.rejects(finishRedacted(new Uint8Array(ROTATED_JPEG)), RedactError);
  await assert.rejects(finishRedacted(new Uint8Array([1, 2, 3])), RedactError);
});

test("data URLs round-trip, and a redacted item keeps nothing of the original", () => {
  const bytes = new Uint8Array(png(3, 3, pattern));
  const url = bytesDataUrl(bytes, "image/png");
  assert.equal(dataUrlType(url), "image/png");
  assert.deepEqual(dataUrlBytes(url), bytes);
  assert.throws(() => dataUrlBytes("data:image/png,notbase64"), RedactError);
  assert.equal(dataUrlType("https://example.com/x.png"), "");

  const kept = withKeep(
    {
      name: "photo.jpg",
      url: "data:image/jpeg;base64,Q0xFQU4=",
      cleanUrl: "data:image/jpeg;base64,Q0xFQU4=",
      originalUrl: "data:image/jpeg;base64,T1JJR0lOQUw=",
      clean: { status: "cleaned", details: ["location", "camera"] },
      keep: false,
    },
    true,
  );
  // The editor opens on what Send would use (here the kept original).
  assert.equal(editorSource(kept), kept.originalUrl);
  const next = redactedItem(kept, "data:image/png;base64,UkVE", { status: "clean", details: [] });
  assert.deepEqual(next, {
    name: "photo.jpg",
    url: "data:image/png;base64,UkVE",
    cleanUrl: "data:image/png;base64,UkVE",
    originalUrl: null,
    keep: false,
    redacted: true,
    clean: { status: "cleaned", details: ["location", "camera"] },
  });
  // Ticking Keep original afterwards can't bring the original back.
  assert.equal(withKeep(next, true).url, null);
  // An image Clean Uploads held back opens on its original; the redrawn
  // copy is checked, so it can be sent.
  const held = { name: "odd.png", url: null, cleanUrl: null, originalUrl: "data:image/png;base64,T0RE", clean: { status: "failed", details: [] }, keep: false };
  assert.equal(editorSource(held), held.originalUrl);
  const fixed = redactedItem(held, "data:image/png;base64,T0s=", { status: "clean", details: [] });
  assert.equal(fixed.url, "data:image/png;base64,T0s=");
  assert.deepEqual(fixed.clean, { status: "clean", details: [] });
  // Without Clean Uploads there's no note to carry.
  assert.equal("clean" in redactedItem({ name: "a.png", url: "data:image/png;base64,QQ==" }, "data:image/png;base64,Qg=="), false);
});

// ---- Chinese -----------------------------------------------------------------

test("every string the feature shows has a Chinese translation", () => {
  const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const han = /\p{Script=Han}/u;
  const read = (f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  // Text between tags, titles and labels, and the sentences set as notes
  // and errors, straight from the source.
  const texts = new Set();
  for (const f of ["ImageRedact.jsx", "Redact.jsx"]) {
    const src = read(f);
    for (const [, t] of src.matchAll(/>\s*([^<>{}]*[A-Za-z]{2}[^<>{}]*?)\s*</g)) if (!/[=;()]/.test(t)) texts.add(t.replace(/\s+/g, " ").trim());
    for (const [, t] of src.matchAll(/(?:title|aria-label)="([^"]+)"/g)) texts.add(t);
    for (const [, t] of src.matchAll(/"([A-Z][^"]*[a-z][^"]*[.…])"/g)) texts.add(t);
  }
  for (const [, t] of read("redact-canvas.js").matchAll(/RedactError\("([^"]+)"\)/g)) texts.add(t);
  const update = UPDATES.find((u) => u.id === "redact");
  for (const t of [update.title, update.tagline, ...update.points]) texts.add(t);
  // Set from expressions rather than as plain text.
  texts.add("Apply");
  texts.add("Draw a box or crop first");
  texts.add("Redact statement.png");
  texts.add(
    "Metadata couldn't be removed from an image. Redact it to send a redrawn copy, tick Keep original to send it as it is, or remove it.",
  );
  const dc = read("DataControls.jsx");
  const line = /Redact Before You Send: [^\n]+/.exec(dc)[0].trim();
  texts.add(line);
  assert.ok(texts.size > 40, "the scan found the editor's strings");
  for (const t of texts) {
    assert.match(translateText(t, zh) ?? "", han, `untranslated: ${JSON.stringify(t)}`);
  }
});

// ---- headless Chrome: the real flow ------------------------------------------
// Attaches a test-pattern PNG that carries invented metadata, draws a Black
// box in the editor, applies and sends, then checks the bytes that went out:
// different from the original, the box uniformly black, the rest untouched,
// no metadata. Needs Chrome and a build (npm run build); skipped otherwise.

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const noChrome = !existsSync(CHROME) || !existsSync("dist/client/index.html");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
async function chrome(t) {
  const profile = mkdtempSync(join(tmpdir(), "anonyma-redact-chrome-"));
  const proc = spawn(CHROME, [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--window-size=1280,900",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore" });
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
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    }
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  return { send, evaluate, until };
}

test("headless: only the redacted copy is sent, black where boxed, with no metadata", { skip: noChrome && "needs Chrome and dist/", timeout: 180000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-redact-e2e-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const svc = createApp({
    testMode: true,
    released: "all",
    origin,
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
  });
  const server = svc.app.listen(port, "127.0.0.1");
  t.after(() => {
    server.close();
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const W = 160,
    H = 100,
    BOX = { x: 40, y: 20, w: 80, h: 50 };
  const original = png(W, H, pattern, [TEXT_AUTHOR]);
  const file = join(dir, "pattern.png");
  writeFileSync(file, original);

  const page = await chrome(t);
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__bodies = []; const f = window.fetch; window.fetch = function (u, o) { try { if (String(u).includes("/api/chat") && o && o.body) window.__bodies.push(o.body); } catch {} return f.apply(this, arguments); };`,
  });
  await page.send("Page.navigate", { url: origin + "/" });
  await page.until(`document.readyState === "complete"`);
  const status = await page.evaluate(
    `fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "redact-e2e", password: "test-password-long" }) }).then((r) => r.status)`,
  );
  assert.equal(status, 201);
  await page.send("Page.navigate", { url: origin + "/workspace/chat?model=claude-sonnet-5" });
  await page.until(`!!document.querySelector(".attachment-control input[type=file]")`);
  const { root } = await page.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await page.send("DOM.querySelector", { nodeId: root.nodeId, selector: ".attachment-control input[type=file]" });
  await page.send("DOM.setFileInputFiles", { nodeId, files: [file] });
  await page.until(`!!document.querySelector(".redact-open")`);
  await page.evaluate(`document.querySelector(".redact-open").click()`);
  await page.until(`(() => { const c = document.querySelector(".redact-sheet canvas"); return !!c && c.width === ${W} && c.getBoundingClientRect().width > ${W}; })()`);
  // The editor shows the image as soon as it opens.
  await page.until(`document.querySelector(".redact-sheet canvas").getContext("2d").getImageData(5, 5, 1, 1).data[3] === 255`);
  const shown = await page.evaluate(`Array.from(document.querySelector(".redact-sheet canvas").getContext("2d").getImageData(5, 5, 1, 1).data)`);
  assert.deepEqual(shown, pattern(5, 5));
  const r = await page.evaluate(`(() => { const b = document.querySelector(".redact-sheet canvas").getBoundingClientRect(); return { x: b.x, y: b.y, k: b.width / ${W} }; })()`);
  const at = (x, y) => ({ x: r.x + x * r.k, y: r.y + y * r.k });
  const a = at(BOX.x, BOX.y),
    b = at(BOX.x + BOX.w, BOX.y + BOX.h);
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x, y: a.y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: a.x, y: a.y, button: "left", buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 8; i++)
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: a.x + ((b.x - a.x) * i) / 8, y: a.y + ((b.y - a.y) * i) / 8, button: "left", buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: b.x, y: b.y, button: "left", buttons: 0, clickCount: 1 });
  await page.until(`!document.querySelector(".redact-apply").disabled`);
  await page.evaluate(`document.querySelector(".redact-apply").click()`);
  await page.until(`!!document.querySelector(".redact-tag") && !document.querySelector("dialog.redact-root")`);
  // The chip can't go back to the original.
  assert.equal(await page.evaluate(`!!document.querySelector(".attachment-list .clean-keep")`), false);
  await page.evaluate(
    `(() => { const t = document.querySelector("textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "What is this?"); t.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await wait(200);
  await page.evaluate(`document.querySelector("form.composer").requestSubmit()`);
  await page.until(`window.__bodies.length > 0`);
  // Let the fixture reply finish before the server closes.
  await page.until(`document.body.innerText.includes("credits charged")`);
  await wait(300);
  const sent = await page.evaluate(`(async () => {
    const body = window.__bodies.at(-1);
    const url = (body.match(/data:image\\/[a-z]+;base64,[A-Za-z0-9+/=]+/) || [])[0];
    const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes]));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const all = Array.from(ctx.getImageData(0, 0, bmp.width, bmp.height).data);
    return { url: url.slice(0, 22), b64: url.split(",")[1], width: bmp.width, height: bmp.height, pixels: all, images: (body.match(/data:image\\//g) || []).length };
  })()`);
  assert.equal(sent.images, 1, "one image in the request");
  assert.equal(sent.url, "data:image/png;base64,");
  assert.deepEqual([sent.width, sent.height], [W, H]);
  const bytes = Buffer.from(sent.b64, "base64");
  assert.notEqual(Buffer.compare(bytes, original), 0, "the bytes differ from the original");
  assert.ok(!bytes.includes("tEXt") && !bytes.includes("Fixture Person"), "no metadata");
  assert.ok(!bytes.includes("Exif"));
  const at2 = (x, y) => sent.pixels.slice((y * W + x) * 4, (y * W + x) * 4 + 4);
  // Inside the box (allowing a pixel for pointer rounding at its edges):
  // uniformly black.
  for (let y = BOX.y + 1; y < BOX.y + BOX.h - 1; y++)
    for (let x = BOX.x + 1; x < BOX.x + BOX.w - 1; x++) assert.deepEqual(at2(x, y), [0, 0, 0, 255], `${x},${y}`);
  // Well outside it: exactly the original pixels (PNG is lossless).
  for (const [x, y] of [[0, 0], [10, 10], [W - 1, H - 1], [BOX.x - 3, BOX.y + 10], [BOX.x + BOX.w + 3, BOX.y + 10], [BOX.x + 10, BOX.y + BOX.h + 3]])
    assert.deepEqual(at2(x, y), pattern(x, y), `${x},${y}`);
});
