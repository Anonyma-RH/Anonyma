import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  copyFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  hasShareTarget,
  readShareTarget,
  combineShareFields,
  stripShareParams,
} from "../src/share-target.js";
import { siteRoutes } from "../server/routes/site.js";

const manifestPath = "public/manifest.webmanifest";
const swPath = "public/sw.js";

function readManifest() {
  return JSON.parse(readFileSync(manifestPath, "utf8"));
}

// Minimal PNG IHDR reader (no new dependency): signature, then a length(4) +
// type(4) + data chunk, and IHDR's data starts with width(4) + height(4).
function pngSize(path) {
  const buf = readFileSync(path);
  assert.equal(buf.readUInt32BE(12), 0x49484452, path + " should start with an IHDR chunk"); // "IHDR"
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

test("manifest is valid JSON with the required installable-app fields", () => {
  const manifest = readManifest();
  assert.equal(manifest.name, "ANONYMA");
  assert.equal(manifest.short_name, "ANONYMA");
  assert.equal(manifest.start_url, "/workspace");
  assert.equal(manifest.scope, "/");
  assert.equal(manifest.display, "standalone");
  assert.match(manifest.theme_color, /^#0135df$/i);
  assert.match(manifest.background_color, /^#0135df$/i);
  assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 3);
});

test("every manifest icon file exists and matches its declared PNG size", () => {
  const manifest = readManifest();
  for (const icon of manifest.icons) {
    assert.equal(icon.type, "image/png");
    const path = "public" + icon.src;
    assert.ok(existsSync(path), icon.src + " should exist under public/");
    const [w, h] = icon.sizes.split("x").map(Number);
    const size = pngSize(path);
    assert.deepEqual(size, { width: w, height: h }, icon.src + " size mismatch");
  }
  assert.ok(
    manifest.icons.some((i) => i.purpose === "maskable"),
    "at least one icon should be marked maskable",
  );
});

test("manifest share_target posts to the workspace chat composer via GET", () => {
  const manifest = readManifest();
  assert.equal(manifest.share_target.action, "/workspace/chat");
  assert.equal(manifest.share_target.method, "GET");
  assert.deepEqual(manifest.share_target.params, {
    title: "title",
    text: "text",
    url: "url",
  });
});

test("apple touch icon referenced from index.html exists at its declared size", () => {
  const html = readFileSync("index.html", "utf8");
  const match = html.match(/rel="apple-touch-icon" href="([^"]+)"/);
  assert.ok(match, "index.html should link an apple-touch-icon");
  const path = "public" + match[1];
  assert.ok(existsSync(path));
  assert.deepEqual(pngSize(path), { width: 180, height: 180 });
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/);
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/);
});

test("service worker source never touches /api, /v1, /health or non-GET requests", () => {
  const sw = readFileSync(swPath, "utf8");
  assert.match(sw, /startsWith\("\/api\/"\)/);
  assert.match(sw, /startsWith\("\/v1"\)/);
  assert.match(sw, /===\s*"\/health"/);
  assert.match(sw, /request\.method !== "GET"/, "non-GET requests must bypass the worker");
  // The precache list itself must not name a dynamic route.
  const shellMatch = sw.match(/SHELL_URLS\s*=\s*\[([^\]]*)\]/);
  assert.ok(shellMatch);
  assert.doesNotMatch(shellMatch[1], /\/api|\/v1|\/health/);
  // Every response cached inside caches.open goes through a strategy that
  // is only reached after isNeverCached() has returned — i.e. the fetch
  // handler bails out before it, not after.
  const fetchHandler = sw.slice(sw.indexOf('addEventListener("fetch"'));
  assert.match(fetchHandler, /if \(isNeverCached\(url\)\) return;/);
});

test("share-target: parses, combines and strips title/text/url without auto-sending", () => {
  const search = "?title=Cool%20find&text=Worth%20a%20look&url=https%3A%2F%2Fexample.com&demo=1";
  assert.equal(hasShareTarget(search), true);
  const fields = readShareTarget(search);
  assert.deepEqual(fields, {
    title: "Cool find",
    text: "Worth a look",
    url: "https://example.com",
  });
  assert.equal(
    combineShareFields(fields),
    "Cool find\n\nWorth a look\n\nhttps://example.com",
  );
  // demo=1 (an unrelated param) survives; the share fields do not.
  assert.equal(stripShareParams(search), "?demo=1");
});

test("share-target: a plain visit with no share params is a no-op", () => {
  assert.equal(hasShareTarget("?demo=1"), false);
  assert.equal(readShareTarget(""), null);
  assert.equal(stripShareParams("?model=gpt"), "?model=gpt");
});

test("share-target: combines only the fields actually present", () => {
  assert.equal(combineShareFields({ text: "just a note" }), "just a note");
  assert.equal(combineShareFields({}), "");
});

test("server: manifest.webmanifest and sw.js are served with correct types once a build exists", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-site-build-"));
  mkdirSync(join(dir, "dist/client"), { recursive: true });
  copyFileSync(manifestPath, join(dir, "dist/client/manifest.webmanifest"));
  copyFileSync(swPath, join(dir, "dist/client/sw.js"));
  copyFileSync("index.html", join(dir, "dist/client/index.html"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });
  const app = express();
  siteRoutes({ app, db: {}, cfg: {} });
  const manifestRes = await request(app).get("/manifest.webmanifest").expect(200);
  assert.match(manifestRes.headers["content-type"], /application\/manifest\+json/);
  const swRes = await request(app).get("/sw.js").expect(200);
  assert.match(swRes.headers["content-type"], /javascript/);
  assert.equal(swRes.headers["cache-control"], "no-cache");
  // The SPA fallback still serves index.html for an unrelated app route,
  // proving the static file routes above did not swallow it.
  const fallback = await request(app).get("/workspace/chat").expect(200);
  assert.match(fallback.headers["content-type"], /text\/html/);
});

test("server: no crash and a plain 404 for manifest/sw.js when no build output exists", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-site-nobuild-"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });
  const app = express();
  siteRoutes({ app, db: {}, cfg: {} });
  await request(app).get("/manifest.webmanifest").expect(404);
  await request(app).get("/sw.js").expect(404);
});
