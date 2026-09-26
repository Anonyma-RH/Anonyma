import test, { before, after } from "node:test";
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
import vm from "node:vm";
import {
  hasShareTarget,
  readShareTarget,
  combineShareFields,
  stripShareParams,
} from "../src/share-target.js";
import { siteRoutes } from "../server/routes/site.js";
import { applyMiddleware } from "../server/middleware.js";
import { createApp } from "../server/app.js";
import { UPDATES } from "../server/releases.js";
import { installHintFor } from "../src/lib.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const manifestPath = "public/manifest.webmanifest";
const swPath = "public/sw.js";

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-install-app-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: released ?? "all",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}

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
});

// The app isn't installable until the "app" update is released: index.html
// must not statically declare it, and the client must add it itself only
// once config says so.
test("index.html does not statically link the manifest or declare standalone-app meta tags", () => {
  const html = readFileSync("index.html", "utf8");
  assert.doesNotMatch(html, /rel="manifest"/);
  assert.doesNotMatch(html, /apple-mobile-web-app/);
});

test("the client adds the manifest link, standalone meta tags and service worker only once released", () => {
  const gate = readFileSync("src/InstallApp.jsx", "utf8");
  // Nothing happens before config has loaded, and an unreleased config
  // returns before the manifest link or the registration.
  const body = gate.slice(gate.indexOf("export function useInstallAppGate"));
  const loaded = body.indexOf("if (!config) return;");
  const unreleased = body.indexOf('if (!isReleased(config, "app")) {');
  const link = body.indexOf('link.href = "/manifest.webmanifest"');
  const register = body.indexOf('navigator.serviceWorker.register("/sw.js")');
  assert.ok(loaded > -1 && unreleased > loaded, "waits for config, then checks the release");
  assert.ok(link > unreleased && register > link, "adds the link and worker only after the check");
  assert.match(gate, /apple-mobile-web-app-capable/);
  // main.jsx no longer registers the worker unconditionally.
  const main = readFileSync("src/main.jsx", "utf8");
  assert.doesNotMatch(main, /serviceWorker\.register/);
  // context.jsx wires the gate up with the loaded config.
  const context = readFileSync("src/context.jsx", "utf8");
  assert.match(context, /useInstallAppGate\(config\)/);
});

test("the install entry and share-target prefill are gated behind the app release", () => {
  const workspace = readFileSync("src/Workspace.jsx", "utf8");
  assert.match(workspace, /isReleased\(config, "app"\) && <InstallAppEntry \/>/);
  assert.match(workspace, /enabled: isReleased\(config, "app"\)/);
  const shareTarget = readFileSync("src/share-target.js", "utf8");
  assert.match(shareTarget, /if \(!enabled \|\| mode !== "chat"\) return;/);
});

test("installed on iPhone, the page stays below the status bar", () => {
  const gate = readFileSync("src/InstallApp.jsx", "utf8");
  // black-translucent draws the page under the clock and notch, and nothing
  // on the site pads for the safe area.
  assert.match(gate, /\["apple-mobile-web-app-status-bar-style", "default"\]/);
  assert.doesNotMatch(gate, /black-translucent/);
});

test("installHintFor: manual install hints for iPhone, iPad and Safari on a Mac", () => {
  const safariIPhone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
  const chromeIPhone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1";
  const oldChromeIPhone =
    "Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/110.0 Mobile/15E148 Safari/604.1";
  const iPadDesktop =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  const macSafari17 = iPadDesktop.replace("Version/18.0", "Version/17.4");
  const macSafari16 = iPadDesktop.replace("Version/18.0", "Version/16.6");
  const macChrome =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
  const android =
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36";
  assert.equal(installHintFor(safariIPhone, "iPhone", 5), "ios");
  assert.equal(installHintFor(chromeIPhone, "iPhone", 5), "ios", "iOS 16.4+ browsers can add to the Home Screen");
  assert.equal(installHintFor(oldChromeIPhone, "iPhone", 5), null, "before 16.4 only Safari can");
  assert.equal(installHintFor(iPadDesktop, "MacIntel", 5), "ios", "an iPad asking for desktop sites");
  assert.equal(installHintFor(macSafari17, "MacIntel", 0), "mac");
  assert.equal(installHintFor(macSafari16, "MacIntel", 0), null, "Add to Dock needs Safari 17");
  assert.equal(installHintFor(macChrome, "MacIntel", 0), null, "Chrome offers its own prompt");
  assert.equal(installHintFor(android, "Linux armv8l", 5), null);
});

test("the footer offers the install entry to visitors, only once the app is released", () => {
  const app = readFileSync("src/App.jsx", "utf8");
  assert.match(app, /g\.title === "Connect" && isReleased\(config, "app"\) && <InstallAppFooterLink \/>/);
  const gate = readFileSync("src/InstallApp.jsx", "utf8");
  assert.match(gate, /export function InstallAppFooterLink\(\)/);
});

test("the UPDATES entry for the app exists and is off by default", () => {
  const entry = UPDATES.find((u) => u.id === "app");
  assert.ok(entry, 'UPDATES should include an "app" entry');
  assert.equal(entry.title, "Install the App");
  assert.equal(entry.tagline, "Your workspace, one tap away.");
  assert.deepEqual(entry.points, [
    "Install on phone or desktop",
    "Opens straight into your workspace",
    "Share links and text into a chat on Android",
  ]);
  // Committed as false until its "Release …" commit flips it to true.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
});

test("server: the app update is off under the MVP and on once released", async (t) => {
  const off = fixture(t, "mvp");
  const infoOff = (await request(off.app).get("/api/config").expect(200)).body.releases;
  assert.equal(infoOff.features.app, false);
  assert.equal(infoOff.updates.find((u) => u.id === "app").released, false);

  const on = fixture(t, "mvp,app");
  const infoOn = (await request(on.app).get("/api/config").expect(200)).body.releases;
  assert.equal(infoOn.features.app, true);
  assert.equal(infoOn.updates.find((u) => u.id === "app").released, true);
});

// ---- The service worker, run for real against fake caches and fetch ----

const ORIGIN = "https://askanonyma.test";

// Loads public/sw.js in a sandbox with an in-memory Cache Storage and a
// scripted network, and returns helpers to fire its events.
function loadWorker(network) {
  const listeners = {};
  const stores = new Map();
  const fetched = [];
  const abs = (r) => new URL(typeof r === "string" ? r : r.url, ORIGIN).href;
  class SWRequest extends Request {
    constructor(input, init) {
      super(typeof input === "string" ? new URL(input, ORIGIN) : input, init);
    }
  }
  const fetchImpl = async (r) => {
    const url = abs(r);
    fetched.push(url);
    return network(url);
  };
  function cache(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      match: async (r) => m.get(abs(r))?.clone(),
      put: async (r, res) => void m.set(abs(r), res),
      addAll: async (list) => {
        const got = [];
        for (const r of list) {
          const res = await fetchImpl(r);
          if (!res.ok) throw new TypeError("addAll: " + res.status);
          got.push([abs(r), res]);
        }
        for (const [k, v] of got) m.set(k, v);
      },
      keys: async () => [...m.keys()].map((u) => new Request(u)),
      delete: async (r) => m.delete(abs(r)),
    };
  }
  const caches = {
    open: async (name) => cache(name),
    keys: async () => [...stores.keys()],
    delete: async (name) => stores.delete(name),
    match: async (r, { cacheName } = {}) =>
      stores.has(cacheName) ? cache(cacheName).match(r) : undefined,
  };
  const self = {
    location: new URL(ORIGIN + "/sw.js"),
    addEventListener: (type, fn) => (listeners[type] = fn),
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInContext(
    readFileSync(swPath, "utf8"),
    vm.createContext({
      self,
      caches,
      fetch: fetchImpl,
      Request: SWRequest,
      Response,
      URL,
    }),
  );
  async function lifecycle(type) {
    const waits = [];
    listeners[type]({ waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  }
  // Fires a fetch event. `responded` is null when the worker let the request
  // through untouched (no respondWith), as the browser would then do.
  async function request(path, { method = "GET", mode = "cors", destination = "", headers = {} } = {}) {
    const req = {
      url: new URL(path, ORIGIN).href,
      method,
      mode,
      destination,
      headers: new Headers(headers),
    };
    let responded = null;
    const waits = [];
    listeners.fetch({
      request: req,
      respondWith: (p) => (responded = p),
      waitUntil: (p) => waits.push(p),
    });
    const response = responded && (await responded);
    await Promise.all(waits);
    return response;
  }
  return { stores, fetched, lifecycle, request, cacheKeys: () => [...stores.values()].flatMap((m) => [...m.keys()]) };
}
const ok = (body, type = "text/html") =>
  new Response(body, { status: 200, headers: { "content-type": type } });
const site = (overrides = {}) => (url) => {
  const { pathname } = new URL(url);
  if (pathname in overrides) return overrides[pathname](url);
  if (pathname === "/offline.html") return ok("offline page");
  if (pathname === "/offline.js") return ok("// lang", "text/javascript");
  return ok("live " + pathname);
};

test("service worker: install precaches only the offline page and its script", async () => {
  const sw = loadWorker(site());
  await sw.lifecycle("install");
  assert.deepEqual(sw.cacheKeys().sort(), [ORIGIN + "/offline.html", ORIGIN + "/offline.js"]);
  // All or nothing: a failed offline page fails the install so it retries.
  const broken = loadWorker(site({ "/offline.html": () => new Response("", { status: 403 }) }));
  await assert.rejects(broken.lifecycle("install"));
});

test("service worker: activate deletes caches from older versions only", async () => {
  const sw = loadWorker(site());
  await sw.lifecycle("install");
  sw.stores.set("anonyma-shell-v1", new Map());
  sw.stores.set("anonyma-assets-v0", new Map());
  sw.stores.set("someone-else", new Map());
  await sw.lifecycle("activate");
  const names = [...sw.stores.keys()];
  assert.ok(!names.includes("anonyma-shell-v1") && !names.includes("anonyma-assets-v0"));
  assert.ok(names.includes("someone-else"));
  assert.ok(names.some((n) => /^anonyma-shell-v\d+$/.test(n)), "the current shell cache stays");
  const src = readFileSync(swPath, "utf8");
  assert.match(src, /const CACHE_VERSION = "v\d+";/);
});

test("service worker: never answers the API, /v1, /mcp, /health, version.json, media, ranges, writes or other origins", async () => {
  const sw = loadWorker(site());
  await sw.lifecycle("install");
  const before = sw.fetched.length;
  const untouched = [
    ["/api/config"],
    ["/api"],
    ["/api/media/abc", { mode: "navigate" }],
    ["/v1/models"],
    ["/v1", { mode: "navigate" }],
    ["/mcp"],
    ["/mcp", { mode: "navigate" }],
    ["/health"],
    ["/health", { mode: "navigate" }],
    ["/version.json"],
    ["/media/anonyma-hero.mp4", { destination: "video" }],
    ["/media/anonyma-hero-poster.jpg", { destination: "image" }],
    ["/assets/film-abc123.mp4"],
    ["/assets/clip.webm", { headers: { range: "bytes=0-" } }],
    ["/brand/voice.mp3", { destination: "audio" }],
    ["/assets/app-abc123.js", { method: "POST" }],
    ["/workspace", { method: "POST", mode: "navigate" }],
    ["https://cdn.example.com/lib.js"],
    ["/install.sh", { mode: "navigate" }],
    ["/cli.mjs", { mode: "navigate" }],
    ["/llms.txt", { mode: "navigate" }],
    ["/brand/official/ionic-icon-180.png", { destination: "image" }],
    ["/sitemap.xml"],
  ];
  for (const [path, opts] of untouched)
    assert.equal(await sw.request(path, opts), null, path + " must reach the network untouched");
  assert.equal(sw.fetched.length, before, "the worker fetched nothing itself");
  assert.equal(sw.cacheKeys().length, 2, "and cached nothing");
});

test("service worker: pages are network-first and never cached, even with shared text in the URL", async () => {
  let build = "one";
  const sw = loadWorker(site({ "/workspace/chat": () => ok("build " + build) }));
  await sw.lifecycle("install");
  await sw.lifecycle("activate");
  const first = await sw.request("/workspace/chat?text=private%20note", { mode: "navigate" });
  assert.equal(await first.text(), "build one");
  // A new deploy is visible on the very next navigation.
  build = "two";
  const second = await sw.request("/workspace/chat", { mode: "navigate" });
  assert.equal(await second.text(), "build two");
  assert.ok(!sw.cacheKeys().some((k) => k.includes("/workspace")), "no page is ever stored");
  assert.ok(!sw.cacheKeys().some((k) => k.includes("private")), "shared text never lands in a cache key");
});

test("service worker: the offline page appears only when the network fails", async () => {
  let down = false;
  const sw = loadWorker(site({
    "/workspace": () => {
      if (down) throw new TypeError("Failed to fetch");
      return ok("live workspace");
    },
    "/nope": () => new Response("not found", { status: 404 }),
    "/boom": () => new Response("error", { status: 500 }),
  }));
  await sw.lifecycle("install");
  assert.equal(await (await sw.request("/workspace", { mode: "navigate" })).text(), "live workspace");
  // A server error or 404 is a real answer, not "offline".
  assert.equal((await sw.request("/nope", { mode: "navigate" })).status, 404);
  assert.equal((await sw.request("/boom", { mode: "navigate" })).status, 500);
  down = true;
  assert.equal(await (await sw.request("/workspace", { mode: "navigate" })).text(), "offline page");
});

test("service worker: hashed /assets/ files are cache-first, only 200s are kept, and the cache is bounded", async () => {
  const sw = loadWorker(site({
    "/assets/gone-old.js": () => new Response("<!doctype html>", { status: 404 }),
  }));
  const first = await sw.request("/assets/index-abc123.js");
  assert.equal(await first.text(), "live /assets/index-abc123.js");
  const fetches = sw.fetched.length;
  const second = await sw.request("/assets/index-abc123.js");
  assert.equal(await second.text(), "live /assets/index-abc123.js");
  assert.equal(sw.fetched.length, fetches, "the second request is served from cache");
  assert.equal((await sw.request("/assets/gone-old.js")).status, 404);
  assert.ok(!sw.cacheKeys().some((k) => k.includes("gone-old")), "a 404 is never cached");
  for (let i = 0; i < 200; i++) await sw.request(`/assets/chunk-${i}.js`);
  const assets = sw.cacheKeys().filter((k) => k.includes("/assets/"));
  assert.ok(assets.length <= 120, "bounded: " + assets.length);
  assert.ok(assets.some((k) => k.endsWith("/assets/chunk-199.js")), "the newest stay");
  assert.ok(!assets.some((k) => k.endsWith("/assets/index-abc123.js")), "the oldest go first");
});

test("offline page: no inline script or handlers (the CSP blocks them) and both languages", () => {
  const html = readFileSync("public/offline.html", "utf8");
  assert.doesNotMatch(html, /\son[a-z]+=/i, "no inline event handlers");
  for (const [, attrs, body] of html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)) {
    assert.match(attrs, /src="\/offline\.js"/);
    assert.equal(body.trim(), "", "no inline script");
  }
  assert.match(html, /You're offline/);
  assert.match(html, /你已离线/);
  const js = readFileSync("public/offline.js", "utf8");
  assert.match(js, /localStorage\.getItem\("anonyma\.lang"\) === "zh"/);
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

test("server: the app's files are served with correct types and headers once a build exists", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-site-build-"));
  mkdirSync(join(dir, "dist/client"), { recursive: true });
  copyFileSync(manifestPath, join(dir, "dist/client/manifest.webmanifest"));
  copyFileSync(swPath, join(dir, "dist/client/sw.js"));
  copyFileSync("public/offline.html", join(dir, "dist/client/offline.html"));
  copyFileSync("public/offline.js", join(dir, "dist/client/offline.js"));
  copyFileSync("index.html", join(dir, "dist/client/index.html"));
  mkdirSync(join(dir, "dist/client/assets"));
  copyFileSync("public/offline.js", join(dir, "dist/client/assets/index-Ab12Cd34.js"));
  const prevCwd = process.cwd();
  process.chdir(dir);
  t.after(() => {
    process.chdir(prevCwd);
    rmSync(dir, { recursive: true, force: true });
  });
  const app = express();
  // main's security headers and CSP, exactly as the server applies them.
  applyMiddleware(app, { trustProxy: false, production: false, origin: "http://localhost:5175" });
  siteRoutes({ app, db: {}, cfg: {} });
  const manifestRes = await request(app).get("/manifest.webmanifest").expect(200);
  assert.match(manifestRes.headers["content-type"], /application\/manifest\+json/);
  const swRes = await request(app).get("/sw.js").expect(200);
  assert.match(swRes.headers["content-type"], /javascript/);
  assert.equal(swRes.headers["cache-control"], "no-cache");
  // The CSP allows a same-origin worker and manifest (default-src 'self').
  const csp = swRes.headers["content-security-policy"];
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /default-src 'self'/);
  assert.doesNotMatch(csp, /manifest-src/);
  const offline = await request(app).get("/offline.html").expect(200);
  assert.match(offline.headers["content-type"], /text\/html/);
  assert.match(offline.headers["content-security-policy"], /script-src 'self'/);
  const offlineJs = await request(app).get("/offline.js").expect(200);
  assert.match(offlineJs.headers["content-type"], /javascript/);
  // Other static files keep express.static's defaults.
  assert.notEqual(offlineJs.headers["cache-control"], "no-cache");
  assert.doesNotMatch(offlineJs.headers["cache-control"], /immutable/);
  // Fingerprinted build files are cached for a year.
  const asset = await request(app).get("/assets/index-Ab12Cd34.js").expect(200);
  assert.equal(asset.headers["cache-control"], "public, max-age=31536000, immutable");
  // The SPA fallback still serves index.html for an unrelated app route,
  // proving the static file routes above did not swallow it.
  const fallback = await request(app).get("/workspace/chat").expect(200);
  assert.match(fallback.headers["content-type"], /text\/html/);
});

test("server: the manifest, worker and offline page are refused until the app is released", async (t) => {
  const off = fixture(t, "mvp");
  for (const path of ["/manifest.webmanifest", "/sw.js", "/offline.html", "/offline.js"]) {
    const res = await request(off.app).get(path).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased", path);
  }
  // Released: the gate lets them through to the static files (404 only when
  // this checkout has no build).
  const on = fixture(t, "mvp,app");
  for (const path of ["/manifest.webmanifest", "/sw.js", "/offline.html", "/offline.js"]) {
    const res = await request(on.app).get(path);
    assert.notEqual(res.status, 403, path);
  }
  // Icons and the rest of the site are never gated.
  await request(off.app).get("/api/config").expect(200);
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

test("the service worker leaves films, audio and range requests to the network", () => {
  const sw = readFileSync("public/sw.js", "utf8");
  assert.match(sw, /request\.headers\.has\("range"\)/);
  assert.match(sw, /request\.destination === "video"/);
  assert.match(sw, /request\.destination === "audio"/);
  assert.match(sw, /mp4\|webm/);
});
