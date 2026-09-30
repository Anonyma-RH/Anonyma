import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { securityHeaders } from "../src/security-headers.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  BUILDS,
  DEFAULT_DICTATION_MODEL,
  DICTATION_CACHE,
  DICTATION_ENGINE_BYTES,
  DICTATION_ENGINE_FILE,
  DICTATION_ENGINE_VERSION,
  DICTATION_LANGUAGES,
  DICTATION_MODELS,
  HF_ORIGIN,
  LICENCE_LINE,
  MAX_RECORDING_MS,
  SAMPLE_RATE,
  audioCheck,
  buildBytes,
  buildFiles,
  cleanTranscript,
  createDictationClient,
  createPinnedFetch,
  detectDictationBuild,
  dictationLanguage,
  dictationModel,
  dictationReleased,
  dictationStorage,
  downmix,
  formatBytes,
  friendlyError,
  modelBase,
  modelUrl,
  pinnedFiles,
  removeDictationModel,
  sha256Hex,
  workerFetch,
} from "../src/dictation.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const cfg = (features) => ({ releases: { features } });

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-dictation-"));
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

// A Cache Storage stand-in: named caches of url → Response.
function fakeCaches() {
  const stores = new Map();
  const api = {
    stores,
    async has(name) {
      return stores.has(name);
    },
    async open(name) {
      if (!stores.has(name)) {
        const m = new Map();
        stores.set(name, {
          map: m,
          async match(url) {
            const r = m.get(typeof url === "string" ? url : url.url);
            return r ? r.clone() : undefined;
          },
          async put(url, res) {
            m.set(url, res.clone());
          },
          async delete(url) {
            return m.delete(url);
          },
          async keys() {
            return [...m.keys()];
          },
        });
      }
      return stores.get(name);
    },
  };
  return api;
}
// Small stand-in "model files" with real SHA-256s, pinned the same way.
const bytes = (s) => new TextEncoder().encode(s);
const sha = (b) => createHash("sha256").update(b).digest("hex");
const FAKE_BASE = "https://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/";
function fakeFiles() {
  const config = bytes('{"model_type":"whisper"}');
  const weights = bytes("weights ".repeat(2000));
  const files = new Map([
    [FAKE_BASE + "config.json", { path: "config.json", bytes: config.byteLength, sha256: sha(config) }],
    [FAKE_BASE + "onnx/encoder_model_quantized.onnx", { path: "onnx/encoder_model_quantized.onnx", bytes: weights.byteLength, sha256: sha(weights) }],
  ]);
  return { files, content: { [FAKE_BASE + "config.json"]: config, [FAKE_BASE + "onnx/encoder_model_quantized.onnx"]: weights } };
}
// A network stand-in: records every request; serves `content` (or a
// tampered copy).
function fakeNetwork(content, { tamper = null, status = 200 } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    let body = content[url];
    if (!body) return new Response(null, { status: 404 });
    if (tamper === url) {
      body = new Uint8Array(body);
      body[0] ^= 1;
    }
    return new Response(body, { status });
  };
  return { calls, fetchImpl };
}

// ---- The release gate ----

test("unreleased: registered with three points, off by default, and nothing on the server", async (t) => {
  const entry = UPDATES.find((u) => u.id === "dictation");
  assert.ok(entry, "registered in UPDATES");
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "Private Dictation");
  assert.equal(entry.tagline, "Talk instead of typing. Your voice becomes text on your own device, for free.");
  assert.equal(entry.points.length, 3);
  const mvp = (await request(fixture(t, "mvp").app).get("/api/config").expect(200)).body;
  assert.equal(mvp.releases.features.dictation, false);
  assert.equal(dictationReleased(mvp), false);
  assert.equal(mvp.releases.updates.find((u) => u.id === "dictation").released, false);
  const live = (await request(fixture(t, "mvp,dictation").app).get("/api/config").expect(200)).body;
  assert.equal(dictationReleased(live), true);
  // No server routes: no request needs this update, and the server only
  // knows its name.
  for (const [path, method, body] of [
    ["/api/chat", "POST", { messages: [] }],
    ["/api/audio/transcriptions", "POST", { audio: "data:audio/webm;base64,AA==" }],
    ["/api/config", "GET"],
    ["/dictation/anything", "GET"],
  ])
    assert.ok(!featuresFor({ path, method, body }).includes("dictation"), path);
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js") && /"dictation"|Private Dictation|@huggingface\/transformers|onnxruntime/.test(readFileSync(p, "utf8"))) hits.push(p);
    }
  };
  walk("server");
  assert.deepEqual(hits, ["server/releases.js"]);
  assert.doesNotMatch(read("Dockerfile"), /dictation/i);
  // Its update card has an icon.
  assert.match(read("src/Pages.jsx"), /\n {2}dictation: "mic",\n/);
});

test("the client shows no menu, panel or engine until release; the engine loads only when chosen", () => {
  assert.equal(dictationReleased(cfg({})), false);
  assert.equal(dictationReleased(cfg({ dictation: true })), true);
  const ws = read("src/Workspace.jsx");
  assert.match(ws, /const dictationLive = !demo && textMode && isReleased\(config, "dictation"\);/);
  assert.equal((ws.match(/<DictationMenu\b/g) || []).length, 1);
  assert.equal((ws.match(/<DictationPanel\b/g) || []).length, 1);
  assert.match(ws, /\{dictationLive && \(\s*<DictationMenu/);
  assert.match(ws, /\{dictationOpen && dictationLive && \(\s*<Suspense fallback=\{null\}>\s*<DictationPanel/);
  // The panel (and through it the engine and Transformers.js) is its own
  // lazy chunk; the workspace never imports them.
  assert.match(ws, /const DictationPanel = lazy\(\(\) => import\("\.\/Dictation\.jsx"\)\);/);
  assert.doesNotMatch(ws, /from "\.\/dictation(-engine)?\.js"|@huggingface\/transformers|onnxruntime/);
  assert.match(read("src/dictation-engine.js"), /new Worker\(new URL\("\.\/dictation\.worker\.js", import\.meta\.url\)/);
  assert.doesNotMatch(read("src/Dictation.jsx"), /@huggingface\/transformers|dictation\.worker/);
  // Every live mode keeps it: nothing leaves the device, so the gate doesn't
  // depend on Private Mode, Sealed Mode, off the record or Device Vault.
  const gate = /const dictationLive = ([^;]+);/.exec(ws)[1];
  assert.doesNotMatch(gate, /privateMode|sealed|ephemeral|deviceOnly|veil/i);
  // Not in the tool directory or the sidebar: it lives in the composer.
  assert.doesNotMatch(read("src/tool-search.js"), /dictation/i);
});

// DictationMenu.jsx and Dictation.jsx compiled for Node with the same
// esbuild Vite uses; the icon set is a stand-in.
async function uiModules() {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-dictation-ui-"));
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
    return { menu: await compile("DictationMenu"), panel: await compile("Dictation") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the mic menu: both options once released, and paid transcription only where it exists", async () => {
  const { menu, panel } = await uiModules();
  const closed = renderToStaticMarkup(createElement(menu.default, { paid: { available: true }, onDevice() {}, onPaid() {} }));
  assert.match(closed, /class="attachment-control dictate-button"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"/);
  assert.match(closed, /<span>Dictate<\/span>/);
  assert.doesNotMatch(closed, /role="menu"/);
  const both = renderToStaticMarkup(createElement(menu.DictationOptions, { paid: { available: true } }));
  assert.match(both, /<b>On this device \(free\)<\/b><small>Private: your voice never leaves this device\. Less accurate\.<\/small>/);
  assert.match(both, /<b>Paid transcription<\/b><small>More accurate\. The audio goes to a speech provider\.<\/small>/);
  assert.equal((both.match(/role="menuitem"/g) || []).length, 2);
  // In Private Mode or Sealed Mode, paid transcription says why it's not here.
  const reason = "Not in Private Mode: no speech provider offers zero data retention.";
  const privateMenu = renderToStaticMarkup(createElement(menu.DictationOptions, { paid: { available: false, reason } }));
  assert.match(privateMenu, /aria-disabled="true"><b>Paid transcription<\/b><small>Not in Private Mode/);
  // Without the paid update, only the on-device choice.
  const onlyLocal = renderToStaticMarkup(createElement(menu.DictationOptions, { paid: { available: false } }));
  assert.equal((onlyLocal.match(/role="menuitem"/g) || []).length, 1);
  const ws = read("src/Workspace.jsx");
  assert.match(ws, /const paidVoiceLive = !demo && isReleased\(config, "voice"\) && isReleased\(config, "audio"\);/);
  assert.match(ws, /!paidVoiceLive\s*\? \{ available: false \}\s*: privateMode\s*\? \{ available: false, reason: "Not in Private Mode/);
  assert.match(ws, /: sealedOn\s*\? \{ available: false, reason: "Not available in Sealed Mode\." \}/);
  // Choosing one closes the other panel.
  assert.match(ws, /onDevice=\{\(\) => \{\s*setVoiceOpen\(false\);\s*setDictationOpen\(true\);/);
  assert.match(ws, /onPaid=\{\(\) => \{\s*setDictationOpen\(false\);\s*setVoiceOpen\(true\);/);

  // The panel says what it does and doesn't do before anything downloads.
  const html = renderToStaticMarkup(createElement(panel.default, { onText() {}, onClose() {} }));
  assert.match(html, /Free\. Your recording never leaves this device\. The first use downloads the model \(about …\) from Hugging Face; after that it works offline\./);
  assert.match(html, /It&#x27;s less accurate than paid transcription, so check the words before you send\./);
  assert.match(html, /Works in every mode, including Private Mode and off the record\./);
  assert.match(html, /The first use also loads the speech engine \(27 MB\) from ANONYMA\./);
  assert.ok(html.includes(LICENCE_LINE.replace(/'/g, "&#x27;")));
  assert.match(html, /aria-label="Dictation model"/);
  assert.match(html, /aria-label="Spoken language"/);
  for (const l of DICTATION_LANGUAGES) assert.ok(html.includes(`<option value="${l.code}"`), l.code);
});

test("text goes into the composer for review; nothing is sent or uploaded", () => {
  const ws = read("src/Workspace.jsx");
  const handler = /<DictationPanel[\s\S]*?onText=\{\(t\) => \{([\s\S]*?)\}\}\s*\/>/.exec(ws)?.[1];
  assert.ok(handler, "the panel's onText");
  assert.match(handler, /setPrompt\(\(p\) => \(p\.trim\(\) \? p\.trimEnd\(\) \+ " " \+ t : t\)\);/);
  assert.match(handler, /promptBox\.current\?\.focus\(\);/);
  assert.doesNotMatch(handler, /send|api\(|fetch|submit/i);
  // The panel hands the cleaned words to onText and nothing else: no API
  // call, no fetch, no storage of the recording.
  const panel = read("src/Dictation.jsx");
  assert.match(panel, /onText\(text\);/);
  assert.doesNotMatch(panel, /\bapi\(|\bfetch\(|indexedDB|FileReader|sessionStorage/);
  // Only the model and language choice are remembered, in this browser.
  assert.match(panel, /localStorage\.setItem\(PREFS, JSON\.stringify\(p\)\)/);
  const engine = read("src/dictation-engine.js");
  assert.doesNotMatch(engine, /\bfetch\(|\bapi\(|localStorage|indexedDB/);
  // The samples are handed to the worker, not copied.
  assert.match(read("src/dictation.js"), /\{ onPartial \}, \[audio\.buffer\]\)/);
});

// ---- The pinned models ----

test("two multilingual Whisper models, pinned to a commit, every file with a SHA-256", () => {
  assert.deepEqual(DICTATION_MODELS.map((m) => m.key), ["tiny", "base"]);
  assert.equal(DEFAULT_DICTATION_MODEL, "tiny");
  assert.equal(dictationModel("nope"), null);
  assert.deepEqual(BUILDS, { gpu: { dtype: "q4f16", device: "webgpu" }, cpu: { dtype: "q8", device: "wasm" } });
  for (const m of DICTATION_MODELS) {
    assert.match(m.repo, /^Xenova\/whisper-(tiny|base)$/, "multilingual, not the .en builds");
    assert.match(m.rev, /^[0-9a-f]{40}$/);
    assert.equal(modelBase(m), `${HF_ORIGIN}/${m.repo}/resolve/${m.rev}/`);
    assert.doesNotMatch(modelBase(m), /\/main\//);
    for (const build of ["gpu", "cpu"]) {
      const files = buildFiles(m, build);
      assert.deepEqual(
        files.map((f) => f.path).sort(),
        [
          "config.json",
          "generation_config.json",
          "preprocessor_config.json",
          "tokenizer.json",
          "tokenizer_config.json",
          `onnx/decoder_model_merged_${build === "gpu" ? "q4f16" : "quantized"}.onnx`,
          `onnx/encoder_model_${build === "gpu" ? "q4f16" : "quantized"}.onnx`,
        ].sort(),
      );
      for (const f of files) {
        assert.match(f.sha256, /^[0-9a-f]{64}$/, f.path);
        assert.ok(Number.isInteger(f.bytes) && f.bytes > 300, f.path);
      }
    }
  }
  // The download sizes people see.
  assert.deepEqual(
    DICTATION_MODELS.map((m) => [formatBytes(buildBytes(m, "cpu")), formatBytes(buildBytes(m, "gpu"))]),
    [
      ["44 MB", "55 MB"],
      ["80 MB", "85 MB"],
    ],
  );
  const pins = pinnedFiles();
  assert.equal(pins.size, DICTATION_MODELS.reduce((n, m) => n + m.common.length + m.builds.gpu.length + m.builds.cpu.length, 0));
  for (const url of pins.keys()) assert.match(url, /^https:\/\/huggingface\.co\/Xenova\/whisper-(tiny|base)\/resolve\/[0-9a-f]{40}\//);
  assert.equal(pins.get(modelUrl(DICTATION_MODELS[0], "onnx/encoder_model_quantized.onnx")).sha256, "fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e");
});

test("a file that matches its pin is used and kept; the next load needs no request", async () => {
  const { files, content } = fakeFiles();
  const net = fakeNetwork(content);
  const caches = fakeCaches();
  const progress = [];
  const pinned = createPinnedFetch({ fetchImpl: net.fetchImpl, cachesApi: caches, files, onProgress: (p) => progress.push(p) });
  const url = FAKE_BASE + "onnx/encoder_model_quantized.onnx";
  const r = await pinned(url);
  assert.equal(r.status, 200);
  assert.deepEqual(new Uint8Array(await r.arrayBuffer()), content[url]);
  assert.equal(net.calls.length, 1);
  // No cookies, no referrer, no HTTP cache games: a plain download.
  assert.deepEqual(
    { credentials: net.calls[0].init.credentials, referrerPolicy: net.calls[0].init.referrerPolicy },
    { credentials: "omit", referrerPolicy: "no-referrer" },
  );
  assert.ok(progress.length > 0 && progress.at(-1).loaded === content[url].byteLength && progress.at(-1).total === content[url].byteLength);
  // Kept in this browser's Cache Storage under the pinned URL.
  assert.ok(caches.stores.get(DICTATION_CACHE).map.has(url));
  const again = await pinned(new Request(url));
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), content[url]);
  assert.equal(net.calls.length, 1, "served from this device");
});

test("a tampered or wrong-sized file is refused and never cached; a damaged copy is fetched again", async () => {
  const { files, content } = fakeFiles();
  const url = FAKE_BASE + "config.json";
  const caches = fakeCaches();
  const bad = fakeNetwork(content, { tamper: url });
  const pinned = createPinnedFetch({ fetchImpl: bad.fetchImpl, cachesApi: caches, files });
  await assert.rejects(pinned(url), (e) => e.name === "IntegrityError" && /fingerprint/.test(e.message));
  assert.ok(!caches.stores.get(DICTATION_CACHE)?.map.has(url), "nothing kept");
  assert.equal(friendlyError(Object.assign(new Error("A downloaded file didn't match its expected fingerprint, so it wasn't used."), { name: "IntegrityError" }), "load"),
    "A downloaded file didn't match its expected fingerprint, so it wasn't used. Remove the model and try again.");
  // Bigger than pinned: refused as it streams in.
  const big = fakeNetwork({ [url]: bytes('{"model_type":"whisper","extra":true}') });
  await assert.rejects(createPinnedFetch({ fetchImpl: big.fetchImpl, cachesApi: caches, files })(url), (e) => e.name === "IntegrityError");
  // Smaller than pinned: refused too.
  const small = fakeNetwork({ [url]: bytes("{}") });
  await assert.rejects(createPinnedFetch({ fetchImpl: small.fetchImpl, cachesApi: caches, files })(url), (e) => e.name === "IntegrityError");
  // Hugging Face down: a plain download error, nothing cached.
  const down = fakeNetwork(content, { status: 503 });
  await assert.rejects(createPinnedFetch({ fetchImpl: down.fetchImpl, cachesApi: caches, files })(url), (e) => e.name === "DownloadError");
  // A copy damaged on this device is dropped and downloaded again.
  const cache = await caches.open(DICTATION_CACHE);
  await cache.put(url, new Response(bytes('{"model_type":"whisper!"}')));
  const good = fakeNetwork(content);
  const r = await createPinnedFetch({ fetchImpl: good.fetchImpl, cachesApi: caches, files })(url);
  assert.equal(await r.text(), '{"model_type":"whisper"}');
  assert.equal(good.calls.length, 1);
  assert.equal(await (await cache.match(url)).text(), '{"model_type":"whisper"}');
  // The real hash function agrees with Node's.
  assert.equal(await sha256Hex(bytes("abc")), sha(bytes("abc")));
});

test("no requests to any host but the pinned files: probes and other files are answered locally", async () => {
  const { files, content } = fakeFiles();
  const net = fakeNetwork(content);
  const pinned = createPinnedFetch({ fetchImpl: net.fetchImpl, cachesApi: fakeCaches(), files });
  // Transformers.js' "is it there?" probe (a GET for byte 0): the pinned size.
  const probe = await pinned(FAKE_BASE + "onnx/encoder_model_quantized.onnx", { headers: new Headers({ Range: "bytes=0-0" }) });
  assert.equal(probe.status, 206);
  assert.equal(probe.headers.get("content-range"), `bytes 0-0/${files.get(FAKE_BASE + "onnx/encoder_model_quantized.onnx").bytes}`);
  // Any other file on Hugging Face (another revision, "main", a file we
  // don't use): a 404, without asking.
  for (const url of [
    FAKE_BASE + "processor_config.json",
    "https://huggingface.co/Xenova/whisper-tiny/resolve/main/config.json",
    "https://huggingface.co/api/models/Xenova/whisper-tiny",
    "https://hf.co/Xenova/whisper-tiny/raw/main/config.json",
  ])
    assert.equal((await pinned(url)).status, 404, url);
  // Anything else is refused outright.
  for (const url of [
    "https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm",
    "http://huggingface.co/Xenova/whisper-tiny/resolve/5332fcc35e32a33b86612b9a57a89be7906102b1/config.json",
    "https://evil.example/config.json",
    "https://huggingface.co.evil.example/x",
    "not a url",
  ])
    await assert.rejects(pinned(url), (e) => e.name === "BlockedError", url);
  assert.equal(net.calls.length, 0, "not one request");
  // The real pins, through a stubbed network: only pinned URLs are fetched.
  const seen = [];
  const all = createPinnedFetch({
    fetchImpl: async (url) => {
      seen.push(url);
      return new Response(new Uint8Array(0));
    },
    cachesApi: fakeCaches(),
  });
  for (const url of pinnedFiles().keys()) await all(url).catch(() => {});
  await all("https://huggingface.co/openai/whisper-large-v3/resolve/main/model.safetensors");
  await all("https://evil.example/").catch(() => {});
  assert.deepEqual(seen, [...pinnedFiles().keys()]);
});

test("the worker's own fetch reaches the engine's WebAssembly on this origin and the pinned files, nothing else", async () => {
  const origin = "https://askanonyma.com";
  const engineUrl = "/assets/ort-wasm-simd-threaded.asyncify-CxOG5pUO.wasm";
  const real = [];
  const pinnedCalls = [];
  const f = workerFetch({
    origin,
    engineUrl,
    realFetch: async (url, init) => (real.push({ url, init }), new Response("wasm")),
    pinnedFetch: async (input) => (pinnedCalls.push(input), new Response("pinned")),
  });
  assert.equal(await (await f(origin + engineUrl)).text(), "wasm");
  assert.deepEqual(real, [{ url: origin + engineUrl, init: { credentials: "same-origin" } }]);
  // Everything else goes through the pinned fetcher (which refuses it):
  // ANONYMA's own API included.
  for (const url of ["/api/chat", origin + "/api/audio/transcriptions", FAKE_BASE + "config.json"]) await f(url);
  assert.equal(real.length, 1);
  assert.equal(pinnedCalls.length, 3);
  assert.throws(() => workerFetch({ origin, engineUrl: "https://cdn.jsdelivr.net/x.wasm", realFetch() {}, pinnedFetch() {} }), /this site/);

  // The worker locks itself down before the engine is evaluated, and points
  // Transformers.js at the pinned fetcher, the pinned commit and this
  // origin's WebAssembly, with its own caches and local paths off.
  const lock = read("src/dictation-lockdown.js");
  assert.match(lock, /import engineUrl from "onnxruntime-web\/ort-wasm-simd-threaded\.asyncify\.wasm\?url";/);
  assert.match(lock, /self\.fetch = workerFetch\(/);
  assert.match(lock, /for \(const name of \["XMLHttpRequest", "WebSocket", "EventSource", "WebTransport"\]\)/);
  const worker = read("src/dictation.worker.js");
  const imports = [...worker.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
  assert.equal(imports[0], "./dictation-lockdown.js", "the lock-down is evaluated first");
  assert.ok(imports.indexOf("@huggingface/transformers") > 0);
  for (const line of [
    "env.allowLocalModels = false;",
    "env.useBrowserCache = false;",
    "env.useWasmCache = false;",
    "env.useCustomCache = false;",
    "env.experimental_useCrossOriginStorage = false;",
    "env.fetch = pinnedFetch;",
    "env.backends.onnx.wasm.wasmPaths = { wasm: ENGINE_URL };",
    'env.remoteHost = "https://huggingface.co/";',
  ])
    assert.ok(worker.includes(line), line);
  assert.match(worker, /env\.remotePathTemplate = modelBase\(model\)/);
  assert.match(worker, /revision: model\.rev,/);
  assert.doesNotMatch(worker + lock, /jsdelivr|unpkg|cdn\./);
});

test("the dependencies: pinned exactly, permissive, and no Node-only binaries or install scripts", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.devDependencies["@huggingface/transformers"], "4.3.0");
  assert.equal(pkg.devDependencies["onnxruntime-web"], DICTATION_ENGINE_VERSION);
  assert.ok(!pkg.dependencies["@huggingface/transformers"] && !pkg.dependencies["onnxruntime-web"], "bundled for the browser, not a server dependency");
  // Transformers.js asks for exactly the runtime we pin and serve.
  const tf = JSON.parse(readFileSync(join("node_modules", "@huggingface", "transformers", "package.json"), "utf8"));
  assert.equal(tf.version, "4.3.0");
  assert.equal(tf.dependencies["onnxruntime-web"], DICTATION_ENGINE_VERSION);
  // Its Node-only backends are replaced by a small pure-JS package.
  assert.deepEqual(pkg.overrides["@huggingface/transformers"], {
    "onnxruntime-node": "npm:onnxruntime-common@1.30.0",
    sharp: "npm:onnxruntime-common@1.30.0",
  });
  const lock = JSON.parse(read("package-lock.json")).packages;
  for (const name of ["onnxruntime-node", "sharp"]) {
    const entry = lock[`node_modules/${name}`];
    assert.equal(entry?.name, "onnxruntime-common", name);
    assert.ok(!entry.hasInstallScript);
  }
  assert.ok(!Object.keys(lock).some((k) => /@img\/sharp|sharp-libvips|node_modules\/onnxruntime-node\/node_modules/.test(k)), "no native image or runtime binaries");
  const PERMISSIVE = /^(MIT|ISC|Apache-2\.0|BSD-2-Clause|BSD-3-Clause)$/;
  for (const name of ["@huggingface/transformers", "@huggingface/jinja", "@huggingface/tokenizers", "onnxruntime-web", "onnxruntime-common", "flatbuffers", "guid-typescript", "long", "platform", "protobufjs"])
    assert.match(lock[`node_modules/${name}`].license, PERMISSIVE, name);
  // The engine's one WebAssembly file, as installed.
  const wasm = join(require.resolve("onnxruntime-web").replace(/dist\/.*$/, "dist"), DICTATION_ENGINE_FILE);
  assert.equal(JSON.parse(readFileSync(join(wasm, "..", "..", "package.json"), "utf8")).version, DICTATION_ENGINE_VERSION);
  assert.equal(statSync(wasm).size, DICTATION_ENGINE_BYTES);
  // Once built, it is one fingerprinted asset (not a second copy), and the
  // worker chunk is its own.
  if (existsSync("dist/client/assets")) {
    const assets = readdirSync("dist/client/assets");
    assert.equal(assets.filter((f) => f.startsWith("ort-wasm-simd-threaded.asyncify-") && f.endsWith(".wasm")).length, 1);
    assert.equal(assets.filter((f) => /^dictation\.worker-[\w-]+\.js$/.test(f)).length, 1);
    assert.ok(!existsSync("dist/client/dictation"));
  }
});

test("the page's CSP already allows it: same-origin worker and WebAssembly, HTTPS downloads; unchanged", () => {
  const csp = securityHeaders()["Content-Security-Policy"];
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /connect-src 'self' https: wss:/);
  assert.match(securityHeaders()["Permissions-Policy"], /microphone=\(self\)/);
  assert.doesNotMatch(read("src/security-headers.js"), /dictation|huggingface/i);
});

// ---- The worker protocol ----

function stubWorker() {
  const sent = [];
  const w = {
    sent,
    postMessage(msg, transfer) {
      sent.push({ msg, transfer });
    },
    reply(data) {
      w.onmessage({ data });
    },
  };
  return w;
}

test("worker protocol: load with progress, transcribe with the samples handed over, partial text, errors", async () => {
  const w = stubWorker();
  const client = createDictationClient(w);
  const progress = [];
  const loading = client.load("base", "gpu", { onProgress: (p) => progress.push(p) });
  const { msg: load } = w.sent[0];
  assert.deepEqual({ ...load, id: undefined }, { type: "load", model: "base", build: "gpu", id: undefined });
  w.reply({ type: "progress", id: load.id, loaded: 10, total: 100 });
  w.reply({ type: "progress", id: "someone-else", loaded: 99, total: 100 });
  w.reply({ type: "ready", id: load.id, device: "webgpu", build: "gpu" });
  assert.deepEqual(await loading, { type: "ready", id: load.id, device: "webgpu", build: "gpu" });
  assert.deepEqual(progress, [{ loaded: 10, total: 100 }]);

  const audio = new Float32Array(SAMPLE_RATE);
  const partials = [];
  const running = client.transcribe(audio, "xx-not-a-language", { onPartial: (t) => partials.push(t) });
  const { msg: tr, transfer } = w.sent[1];
  assert.equal(tr.type, "transcribe");
  assert.equal(tr.language, "auto", "unknown languages are detected instead");
  assert.equal(tr.audio, audio);
  assert.deepEqual(transfer, [audio.buffer], "transferred, not copied");
  w.reply({ type: "partial", id: tr.id, text: "Draft a short" });
  w.reply({ type: "result", id: tr.id, text: "Draft a short email.", device: "webgpu" });
  assert.equal((await running).text, "Draft a short email.");
  assert.deepEqual(partials, ["Draft a short"]);
  assert.equal(dictationLanguage("es"), "es");

  const failing = client.transcribe(new Float32Array(10));
  w.reply({ type: "error", id: w.sent[2].msg.id, name: "RangeError", message: "memory access out of bounds" });
  await assert.rejects(failing, (e) => e.name === "RangeError");
  assert.equal(friendlyError({ name: "RangeError", message: "memory access out of bounds" }), "This device ran out of memory. Close other tabs, or pick the smaller model.");

  // The worker dying fails what's waiting; so does closing the client.
  const waiting = client.load("tiny", "cpu");
  w.onerror({ preventDefault() {} });
  await assert.rejects(waiting, (e) => e.name === "WorkerError");
  await assert.rejects(client.load("tiny", "cpu"), (e) => e.name === "WorkerError");
  const w2 = stubWorker();
  const c2 = createDictationClient(w2);
  const stopped = c2.load("tiny", "cpu");
  c2.close();
  await assert.rejects(stopped, (e) => e.name === "AbortError");
  // The worker answers exactly these message kinds.
  const worker = read("src/dictation.worker.js");
  for (const kind of ['msg.type === "load"', 'msg.type === "transcribe"', 'type: "ready"', 'type: "result"', 'type: "partial"', 'type: "error"', 'type: "progress"'])
    assert.ok(worker.includes(kind), kind);
});

test("WebGPU with shader-f16 gets the fast build; everything else the processor build", async () => {
  const nav = (adapter) => ({ gpu: { requestAdapter: async () => adapter } });
  assert.equal(await detectDictationBuild(undefined), "cpu");
  assert.equal(await detectDictationBuild({}), "cpu");
  assert.equal(await detectDictationBuild(nav(null)), "cpu");
  assert.equal(await detectDictationBuild(nav({ features: new Set() })), "cpu");
  assert.equal(await detectDictationBuild(nav({ features: new Set(["shader-f16"]) })), "gpu");
  assert.equal(await detectDictationBuild({ gpu: { requestAdapter: async () => { throw new Error("blocked"); } } }), "cpu");
  // The worker falls back to the processor build if the WebGPU one can't
  // run, but never past a failed fingerprint or a refused download.
  const worker = read("src/dictation.worker.js");
  assert.match(worker, /if \(build !== "gpu" \|\| \/fingerprint\|Integrity\|DownloadError\|Blocked\|QuotaExceeded\/i\.test/);
});

// ---- Storage ----

test("downloaded state per build, and Remove deletes only that model's files", async () => {
  const caches = fakeCaches();
  const [tiny, base] = DICTATION_MODELS;
  assert.deepEqual(await dictationStorage(tiny, "cpu", caches), { files: 0, bytes: 0, complete: false, partial: false });
  const cache = await caches.open(DICTATION_CACHE);
  for (const f of buildFiles(tiny, "cpu")) await cache.put(modelUrl(tiny, f.path), new Response("x"));
  await cache.put(modelUrl(base, "config.json"), new Response("x"));
  assert.deepEqual(await dictationStorage(tiny, "cpu", caches), { files: 7, bytes: buildBytes(tiny, "cpu"), complete: true, partial: false });
  // The WebGPU build still needs its own two weight files.
  const gpu = await dictationStorage(tiny, "gpu", caches);
  assert.equal(gpu.complete, false);
  assert.equal(gpu.partial, true);
  assert.equal((await dictationStorage(base, "cpu", caches)).partial, true);
  assert.equal(await removeDictationModel(tiny, caches), 7);
  assert.deepEqual(await dictationStorage(tiny, "cpu", caches), { files: 0, bytes: 0, complete: false, partial: false });
  assert.equal((await dictationStorage(base, "cpu", caches)).files, 1, "the other model is untouched");
  assert.equal(await removeDictationModel(tiny, null), 0);
});

// ---- Audio and text ----

test("audio: too short and silent recordings aren't transcribed; channels are averaged", () => {
  assert.equal(MAX_RECORDING_MS, 120000);
  assert.equal(audioCheck(new Float32Array(100)), "short");
  assert.equal(audioCheck(new Float32Array(SAMPLE_RATE)), "silent");
  const hum = new Float32Array(SAMPLE_RATE).map(() => 0.004);
  assert.equal(audioCheck(hum), "silent");
  const speech = new Float32Array(SAMPLE_RATE).map((_, i) => 0.3 * Math.sin(i / 7));
  assert.equal(audioCheck(speech), "ok");
  assert.deepEqual([...downmix([new Float32Array([1, 0]), new Float32Array([0, 1])])], [0.5, 0.5]);
  const mono = new Float32Array([0.1]);
  assert.equal(downmix([mono]), mono);
});

test("Whisper's non-speech tags are removed and the words kept as heard", () => {
  assert.equal(cleanTranscript(" [BLANK_AUDIO] "), "");
  assert.equal(cleanTranscript("Hello there [Music] , how are you ?"), "Hello there, how are you?");
  assert.equal(cleanTranscript("(upbeat music) Send the slides *applause* by noon."), "Send the slides by noon.");
  assert.equal(cleanTranscript("I said (the second one) twice"), "I said (the second one) twice");
  assert.equal(cleanTranscript("你好，世界。"), "你好，世界。");
  assert.equal(cleanTranscript(null), "");
});

test("plain messages for what can go wrong", () => {
  assert.equal(friendlyError({ name: "QuotaExceededError" }, "load"), "There isn't enough storage space on this device for this model. Free some space or pick the smaller model.");
  assert.equal(friendlyError({ name: "DownloadError", message: "Hugging Face answered 503" }, "load"), "The download stopped. Check your connection and try again; files already downloaded are kept.");
  assert.equal(friendlyError({ name: "TypeError", message: "Failed to fetch" }, "load"), "The download stopped. Check your connection and try again; files already downloaded are kept.");
  assert.equal(friendlyError({ name: "WorkerError" }), "The on-device engine couldn't run in this browser. Reload the page and try again.");
  assert.equal(friendlyError({ name: "Error", message: "?" }, "load"), "The model couldn't start on this device. Reload the page and try again, or pick the smaller model.");
  assert.equal(friendlyError({ name: "Error", message: "?" }), "The on-device transcription stopped before finishing. Try again, or type instead.");
});

// ---- Chinese and Spanish ----

test("every string it shows has Chinese and Spanish, the update's own included", () => {
  const zhRaw = JSON.parse(read("src/i18n/zh.json"));
  const esRaw = JSON.parse(read("src/i18n/es.json"));
  const zh = compileDictionary(zhRaw, "zh");
  const es = compileDictionary(esRaw, "es");
  const entry = UPDATES.find((u) => u.id === "dictation");
  const strings = [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Dictate",
    "On this device (free)",
    "Private: your voice never leaves this device. Less accurate.",
    "Paid transcription",
    "More accurate. The audio goes to a speech provider.",
    "Not in Private Mode: no speech provider offers zero data retention.",
    "Not available in Sealed Mode.",
    "Private dictation",
    "Close private dictation",
    "Dictation model",
    "Spoken language",
    "Record",
    "Cancel",
    "Close",
    "Model",
    "Language",
    "Downloaded",
    "Remove from this device",
    "Partly downloaded",
    "Starting the model on this device…",
    "Waiting for microphone permission…",
    "Finishing the recording…",
    "Transcribing on your device…",
    "That recording was too short. Record a little longer.",
    "No speech was heard. Check your microphone, then record again.",
    "No words were recognised. Record again, or type instead.",
    "Stopped. Nothing was added to your message.",
    "Stopped. Files already downloaded are kept.",
    "Recording stopped when the tab was hidden. Press Record to start again.",
    "Added to your message. Check it, then press Send: nothing is sent until you do.",
    "Running on this device's graphics processor (WebGPU).",
    "Running on this device's processor.",
    "It's less accurate than paid transcription, so check the words before you send.",
    "Works in every mode, including Private Mode and off the record.",
    LICENCE_LINE,
    ...DICTATION_MODELS.map((m) => m.note),
    ...DICTATION_LANGUAGES.map((l) => l.name),
    ...["QuotaExceededError", "DownloadError", "WorkerError", "IntegrityError", "RangeError"].flatMap((name) => [
      friendlyError({ name, message: "memory access out of bounds" }, "load"),
      friendlyError({ name }, "transcribe"),
    ]),
    friendlyError({ name: "Error" }, "load"),
    // Patterns, as rendered.
    "Free. Your recording never leaves this device. The first use downloads the model (about 44 MB) from Hugging Face; after that it works offline.",
    "Download the model (85 MB)",
    "Stop · 0:07",
    "Downloading from Hugging Face… 12 MB of 55 MB",
    "Listening… up to 2:00. Press Stop when you're done.",
    "The first use also loads the speech engine (27 MB) from ANONYMA.",
  ];
  for (const s of new Set(strings)) {
    assert.notEqual(translateText(s, zh), s, `zh: ${s}`);
    // Spanish writes a few language names the same way (Hindi).
    if (s !== "Hindi") assert.notEqual(translateText(s, es), s, `es: ${s}`);
    else assert.equal(esRaw.strings[s], "Hindi");
  }
  assert.equal(translateText("On this device (free)", es), "En este dispositivo (gratis)");
  assert.equal(translateText("Private Dictation", zh), "私密语音输入");
  assert.equal(translateText("Download the model (85 MB)", es), "Descargar el modelo (85 MB)");
  // The transcript itself is never translated.
  assert.match(read("src/Dictation.jsx"), /<p className="dictation-partial" data-i18n="off">/);
});
