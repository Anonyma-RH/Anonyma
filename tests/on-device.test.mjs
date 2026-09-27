import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { knownPage, sitemap } from "../src/site-routes.js";
import { paletteActions } from "../src/command-palette.js";
import { modeReleased } from "../src/lib.js";
import { securityHeaders } from "../src/security-headers.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { createVault, sealChat, openChat, vaultChat } from "../src/device-vault.js";
import {
  CACHES,
  CONTEXT_WINDOW,
  DEFAULT_MODEL,
  HF_BASE,
  LIB_BASE,
  MIN_BUFFER,
  MIN_STORAGE_BINDING,
  ONDEVICE_MODELS,
  REPLY_TOKENS,
  SUPPORT_REASONS,
  SUPPORT_WORKS,
  SYSTEM_PROMPT,
  appConfigFor,
  buildLocalRequest,
  detectWebGPU,
  deviceVaultChat,
  estimateTokens,
  fitHistory,
  formatBytes,
  friendlyError,
  modelByKey,
  modelFiles,
  modelRecord,
  modelStorage,
  ondeviceReleased,
  progressState,
  removeModelFiles,
  streamLocalReply,
  variantFor,
} from "../src/on-device.js";
import { createWorkerClient } from "../src/ondevice-engine.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-ondevice-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const cfg = (features) => ({ releases: { features } });
const F16_GPU = { ok: true, f16: true };
const F32_GPU = { ok: true, f16: false };

// ---- The release gate ----

test("unreleased: the update is registered but hidden, and its page is a 404", async (t) => {
  const entry = UPDATES.find((u) => u.id === "ondevice");
  assert.ok(entry, "registered in UPDATES");
  assert.equal(committed[UPDATES.indexOf(entry)], false, "committed unreleased");
  assert.equal(entry.title, "On-Device Model");
  assert.equal(entry.points.length, 3);
  const mvp = fixture(t, "mvp");
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.ondevice, false);
  assert.equal(ondeviceReleased(config), false);
  assert.equal(config.releases.updates.find((u) => u.id === "ondevice").released, false);
  // The page: unknown until release (served once the client is built).
  if (existsSync("dist/client/index.html")) {
    await request(mvp.app).get("/workspace/device").expect(404);
    await request(fixture(t, "mvp,ondevice").app).get("/workspace/device").expect(200);
  }
  assert.equal(knownPage("/workspace/device"), false);
  assert.equal(knownPage("/workspace/device", { ondevice: true }), true);
  assert.ok(!sitemap("https://x.test", { ondevice: true }).includes("/workspace/device"), "never in the sitemap");
  // Released: the config says so.
  const live = (await request(fixture(t, "mvp,ondevice").app).get("/api/config").expect(200)).body;
  assert.equal(ondeviceReleased(live), true);
});

test("the client shows no mode, link, picker entry or palette place until release", () => {
  assert.equal(modeReleased(cfg({}), "device"), false);
  assert.equal(modeReleased(cfg({ ondevice: true }), "device"), true);
  const ids = (c) => paletteActions({ config: c, mode: "chat", signedIn: true }).map((x) => x.id);
  assert.ok(!ids(cfg({})).includes("go-device"));
  assert.ok(ids(cfg({ ondevice: true })).includes("go-device"));
  const src = read("../src/Workspace.jsx");
  assert.match(src, /\.filter\(\(\[id\]\) => id !== "device" \|\| isReleased\(config, "ondevice"\)\)/);
  assert.match(src, /mode === "device" && \(!config \|\| isReleased\(config, "ondevice"\)\)/);
  assert.match(src, /mode === "device" \? \(\s*isReleased\(config, "ondevice"\) &&/);
  // The model picker's entry, only in Chat and only once released.
  assert.match(src, /onDevice=\{\s*mode === "chat" && isReleased\(config, "ondevice"\)/);
  // A vault chat from this page never opens with a server model.
  assert.match(src, /if \(chat\.mode === "device"\) \{[\s\S]{0,200}isReleased\(config, "ondevice"\)[\s\S]{0,120}\/workspace\/device[\s\S]{0,80}return;/);
  // Its code is its own chunk, loaded only on the page.
  assert.match(src, /const OnDevice = lazy\(\(\) => import\("\.\/OnDevice\.jsx"\)\)/);
  assert.doesNotMatch(src, /from "\.\/on-device\.js"|from "\.\/ondevice-engine\.js"|@mlc-ai\/web-llm/);
});

test("nothing server-side: no route, no gate in featuresFor, nothing stored", () => {
  for (const body of [{ messages: [] }, { ondevice: true }, { model: "Llama-3.2-1B-Instruct-q4f16_1-MLC" }])
    assert.ok(!featuresFor({ path: "/api/chat", method: "POST", body }).includes("ondevice"));
  // The server only knows the update's name: its entry and the page flag.
  const hits = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith(".js") && /ondevice|on-device|web-llm/i.test(readFileSync(p, "utf8"))) hits.push(p);
    }
  };
  walk("server");
  assert.deepEqual(hits.sort(), ["server/releases.js", "server/routes/site.js"]);
  // The Dockerfile copies no new src file for the server.
  assert.doesNotMatch(read("../Dockerfile"), /on-device|ondevice/);
});

// ---- WebGPU ----

test("WebGPU detection: missing, no adapter, too small, and a usable GPU with or without f16", async () => {
  const gpu = (adapter) => ({ gpu: { requestAdapter: async () => adapter } });
  const limits = { maxBufferSize: 2 ** 32, maxStorageBufferBindingSize: 2 ** 31 };
  assert.deepEqual(await detectWebGPU(undefined), { ok: false, reason: "no-webgpu" });
  assert.deepEqual(await detectWebGPU({}), { ok: false, reason: "no-webgpu" });
  assert.deepEqual(await detectWebGPU({ gpu: {} }), { ok: false, reason: "no-webgpu" });
  assert.deepEqual(await detectWebGPU(gpu(null)), { ok: false, reason: "no-adapter" });
  assert.deepEqual(
    await detectWebGPU({ gpu: { requestAdapter: async () => { throw new Error("blocked"); } } }),
    { ok: false, reason: "no-adapter" },
  );
  assert.deepEqual(
    await detectWebGPU(gpu({ limits: { maxBufferSize: MIN_BUFFER - 1, maxStorageBufferBindingSize: 2 ** 30 }, features: new Set() })),
    { ok: false, reason: "too-small" },
  );
  assert.deepEqual(
    await detectWebGPU(gpu({ limits: { maxBufferSize: 2 ** 30, maxStorageBufferBindingSize: MIN_STORAGE_BINDING - 1 }, features: new Set() })),
    { ok: false, reason: "too-small" },
  );
  assert.deepEqual(
    await detectWebGPU(gpu({ limits, features: new Set(["shader-f16"]), info: { vendor: "apple" } })),
    { ok: true, f16: true, vendor: "apple" },
  );
  assert.deepEqual(await detectWebGPU(gpu({ limits, features: new Set() })), { ok: true, f16: false, vendor: "" });
});

// ---- The pinned models ----

test("only the three pinned models load, from fixed revisions, with hashes WebLLM checks", () => {
  assert.equal(ONDEVICE_MODELS.length, 3);
  assert.equal(DEFAULT_MODEL, "llama-3.2-1b");
  const sri = /^sha256-[A-Za-z0-9+/]{43}=$/;
  for (const gpu of [F16_GPU, F32_GPU]) {
    const config = appConfigFor(gpu);
    assert.equal(config.cacheBackend, "cache");
    assert.equal(config.model_list.length, 3);
    for (const [i, rec] of config.model_list.entries()) {
      const model = ONDEVICE_MODELS[i];
      const v = variantFor(model, gpu);
      assert.equal(rec.model_id, v.id);
      assert.match(rec.model_id, gpu.f16 ? /q4f16_1-MLC$/ : /q4f32_1-MLC$/);
      // Hugging Face at a commit, MLC's libraries at a commit: never "main".
      assert.equal(rec.model, `${HF_BASE}${v.id}/resolve/${v.rev}/`);
      assert.match(v.rev, /^[0-9a-f]{40}$/);
      assert.ok(rec.model_lib.startsWith(LIB_BASE));
      assert.match(LIB_BASE, /^https:\/\/raw\.githubusercontent\.com\/mlc-ai\/binary-mlc-llm-libs\/[0-9a-f]{40}\//);
      assert.doesNotMatch(rec.model + rec.model_lib, /\/main\//);
      assert.equal(rec.overrides.context_window_size, CONTEXT_WINDOW);
      assert.deepEqual(rec.required_features, gpu.f16 ? ["shader-f16"] : undefined);
      assert.match(rec.integrity.config, sri);
      assert.match(rec.integrity.model_lib, sri);
      assert.match(rec.integrity.tokenizer["tokenizer.json"], sri);
      assert.equal(rec.integrity.onFailure, "error");
      assert.ok(v.bytes > 5e8 && v.vramMB > 500);
    }
  }
  assert.equal(modelByKey("nope"), null);
  // Sizes shown to people.
  assert.equal(formatBytes(709718801), "710 MB");
  assert.equal(formatBytes(880931543), "881 MB");
  assert.equal(formatBytes(1822589797), "1.8 GB");
  assert.equal(formatBytes(0), "0 bytes");
});

// ---- Storage ----

// A stand-in for window.caches: named caches of url → Content-Length.
function fakeCaches(seed = {}) {
  const stores = new Map();
  const open = async (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name);
    return {
      keys: async () => [...m.keys()].map((url) => ({ url })),
      match: async (url) =>
        m.has(url) ? { headers: { get: (h) => (h === "content-length" && m.get(url) != null ? String(m.get(url)) : null) } } : undefined,
      delete: async (url) => m.delete(url),
    };
  };
  for (const [name, entries] of Object.entries(seed)) {
    stores.set(name, new Map(Object.entries(entries)));
  }
  return { open, has: async (name) => stores.has(name), stores };
}
function seedComplete(model, variant, perFile = 1000) {
  const files = modelFiles(model, variant);
  const seed = { [CACHES.model]: {}, [CACHES.config]: {}, [CACHES.wasm]: {} };
  for (const f of files.expected) seed[f.cache][f.url] = perFile;
  return seed;
}

test("storage: sums what a model uses, knows complete from partial, and ignores everything else", async () => {
  const [llama1, qwen, llama3] = ONDEVICE_MODELS;
  const v = variantFor(llama1, F16_GPU);
  const seed = seedComplete(llama1, v, 1000);
  // Qwen: two shards of an interrupted download, one without a length.
  const q = modelFiles(qwen, variantFor(qwen, F16_GPU));
  seed[CACHES.model][q.shards[0]] = 5_000_000;
  seed[CACHES.model][q.shards[1]] = null;
  // Something else in the same caches, and an unrelated cache.
  seed[CACHES.model]["https://huggingface.co/mlc-ai/SmolLM2-360M-Instruct-q4f16_1-MLC/resolve/main/params_shard_0.bin"] = 777;
  seed["anonyma-assets-v2"] = { "http://localhost/assets/index.js": 123 };
  const caches = fakeCaches(seed);

  const a = await modelStorage(llama1, v, caches);
  assert.equal(a.complete, true);
  assert.equal(a.partial, false);
  assert.equal(a.files, llama1.shards + 4);
  // Complete: at least the known download size (compressed lengths undercount).
  assert.equal(a.bytes, v.bytes);
  const b = await modelStorage(qwen, variantFor(qwen, F16_GPU), caches);
  assert.deepEqual(b, { bytes: 5_000_000, files: 2, complete: false, partial: true });
  const c = await modelStorage(llama3, variantFor(llama3, F16_GPU), caches);
  assert.deepEqual(c, { bytes: 0, files: 0, complete: false, partial: false });
  // The f32 build of the same model isn't complete on an f16 cache.
  assert.equal((await modelStorage(llama1, variantFor(llama1, F32_GPU), caches)).complete, false);
  // No Cache Storage at all (an old browser): nothing, not an error.
  assert.deepEqual(await modelStorage(llama1, v, undefined), { bytes: 0, files: 0, complete: false, partial: false });
});

test("remove: deletes every file of that model (any build or revision) and nothing else", async () => {
  const [llama1, qwen] = ONDEVICE_MODELS;
  const seed = seedComplete(llama1, variantFor(llama1, F16_GPU));
  // The other build, and an older revision, of the same model.
  const f32 = modelFiles(llama1, variantFor(llama1, F32_GPU));
  seed[CACHES.model][f32.shards[3]] = 10;
  seed[CACHES.model][`${HF_BASE}${llama1.variants.f16.id}/resolve/0000000000000000000000000000000000000000/tokenizer.json`] = 10;
  seed[CACHES.wasm]["https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/web-llm-models/v0_2_80/" + llama1.variants.f16.lib] = 10;
  // Another model, and a file that merely shares a prefix of the name.
  const q = modelFiles(qwen, variantFor(qwen, F16_GPU));
  seed[CACHES.model][q.tokenizer] = 10;
  seed[CACHES.model][`${HF_BASE}${llama1.variants.f16.id}-extra/resolve/x/tokenizer.json`] = 10;
  const caches = fakeCaches(seed);
  const total = () => [...caches.stores.values()].reduce((n, m) => n + m.size, 0);
  const before = total();
  const removed = await removeModelFiles(llama1, caches);
  assert.equal(removed, llama1.shards + 4 + 3);
  assert.equal(total(), before - removed);
  const left = [...caches.stores.values()].flatMap((m) => [...m.keys()]);
  assert.deepEqual(left.sort(), [q.tokenizer, `${HF_BASE}${llama1.variants.f16.id}-extra/resolve/x/tokenizer.json`].sort());
  assert.equal((await modelStorage(llama1, variantFor(llama1, F16_GPU), caches)).files, 0);
  assert.equal(await removeModelFiles(llama1, caches), 0, "removing twice is harmless");
});

// ---- Chatting: never ANONYMA's API ----

// A stand-in for WebLLM's worker handler (its message protocol), answering
// from a script of reply chunks.
function fakeWorker(chunks, { failReload } = {}) {
  const posted = [];
  const worker = {
    posted,
    onmessage: null,
    onerror: null,
    postMessage(msg) {
      posted.push(structuredClone(msg));
      const reply = (kind, content) => queueMicrotask(() => worker.onmessage({ data: { kind, uuid: msg.uuid, content } }));
      if (msg.kind === "reload") {
        queueMicrotask(() => worker.onmessage({ data: { kind: "initProgressCallback", uuid: "", content: { progress: 0.5, text: "Fetching param cache[11/22]: 350MB fetched. 50% completed" } } }));
        return failReload ? reply("throw", failReload) : reply("return", null);
      }
      if (msg.kind === "chatCompletionStreamInit") return reply("return", null);
      if (msg.kind === "completionStreamNextChunk") return reply("return", chunks.shift());
      if (msg.kind === "interruptGenerate") return reply("return", null);
    },
  };
  return worker;
}
const chunk = (content, extra = {}) => ({ choices: [{ delta: { content }, finish_reason: extra.finish ?? null }], ...(extra.usage ? { usage: extra.usage } : {}) });

test("an on-device reply streams from the worker and never calls fetch, so never /api/chat", async (t) => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error("fetch must not be used");
  };
  t.after(() => (globalThis.fetch = realFetch));

  const progress = [];
  const worker = fakeWorker([
    chunk("Hello"),
    chunk(" from your"),
    chunk(" device.", { finish: "stop" }),
    { choices: [], usage: { completion_tokens: 4, extra: { decode_tokens_per_s: 41.6 } } },
    undefined,
  ]);
  const client = createWorkerClient(worker, { onProgress: (p) => progress.push(progressState(p, 700e6)) });
  const appConfig = appConfigFor(F16_GPU);
  assert.equal(await client.load(appConfig.model_list[0].model_id, appConfig), client);
  assert.equal(progress[0].phase, "download");
  assert.equal(progress[0].done, 350e6);

  const thread = [
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!", local: { model: "llama-3.2-1b", tps: 50 } },
    { role: "user", content: "Say hello again.", images: ["data:x"] },
  ];
  const { request: req, dropped } = buildLocalRequest(thread);
  assert.equal(dropped, 0);
  const seen = [];
  const out = await streamLocalReply({ engine: client, request: req, onDelta: (s) => seen.push(s) });
  assert.deepEqual(seen, ["Hello", "Hello from your", "Hello from your device."]);
  assert.deepEqual(out, { text: "Hello from your device.", finishReason: "stop", tokens: 4, tokensPerSecond: 42 });
  assert.deepEqual(calls, [], "no network request of any kind");

  // What the worker got: the model files config, then the chat, and only
  // each message's role and text (no ids, stats or attachments).
  const kinds = worker.posted.map((m) => m.kind);
  assert.deepEqual(kinds.slice(0, 4), ["setAppConfig", "setLogLevel", "reload", "chatCompletionStreamInit"]);
  assert.ok(kinds.slice(4).every((k) => k === "completionStreamNextChunk"));
  const sent = worker.posted.find((m) => m.kind === "chatCompletionStreamInit").content.request;
  assert.deepEqual(sent.messages, [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: "Hi" },
    { role: "assistant", content: "Hello!" },
    { role: "user", content: "Say hello again." },
  ]);
  assert.equal(sent.stream, true);
  assert.equal(sent.max_tokens, REPLY_TOKENS);
  // The app config names only the pinned models.
  const cfgSent = worker.posted.find((m) => m.kind === "setAppConfig").content;
  assert.deepEqual(cfgSent.model_list.map((m) => m.model_id), ONDEVICE_MODELS.map((m) => m.variants.f16.id));

  // Stop: the handler interrupts and the stream ends normally.
  client.interruptGenerate();
  assert.equal(worker.posted.at(-1).kind, "interruptGenerate");
});

test("the page and engine files never reach ANONYMA's API", () => {
  for (const file of ["../src/OnDevice.jsx", "../src/on-device.js", "../src/ondevice-engine.js", "../src/ondevice.worker.js"]) {
    const src = read(file);
    assert.doesNotMatch(src, /["'`]\/api\/|["'`]\/v1\//, file);
    assert.doesNotMatch(src, /\b(streamChat|api)\s*\(/, file);
    assert.doesNotMatch(src, /import\s*\{[^}]*\b(api|streamChat)\b[^}]*\}\s*from\s*"\.\/lib\.js"/, file);
    assert.doesNotMatch(src, /\bfetch\s*\(/, file);
    assert.doesNotMatch(src, /dangerouslySetInnerHTML|\beval\s*\(|new Function/, file);
  }
  // Replies go through the shared renderer; images are never loaded.
  const page = read("../src/OnDevice.jsx");
  assert.match(page, /<ReplyMarkdown rich remarkPlugins=\{\[remarkGfm\]\} components=\{REPLY_PARTS\}>/);
  assert.match(page, /img: NoImage/);
  assert.doesNotMatch(page, /<img\b/);
  // No Veil, Web, files, memory or project controls on this page.
  assert.doesNotMatch(page, /VeilToggle|WebToggle|DocumentAttach|MemoryPanel|ProjectPicker|EphemeralToggle|PrivateModeToggle/);
  // User and model text is kept out of translation.
  assert.match(page, /<div className="markdown" data-i18n="off">/);
});

test("the worker client: errors keep their names, and stopping fails a download in progress", async () => {
  const appConfig = appConfigFor(F16_GPU);
  const bad = createWorkerClient(fakeWorker([], { failReload: "IntegrityError: Integrity check failed for tokenizer.json" }));
  await assert.rejects(bad.load("x", appConfig), (err) => err.name === "IntegrityError");
  assert.match(friendlyError(new Error("IntegrityError: Integrity check failed"), "load"), /fingerprint/);

  // A download that never finishes: stop() rejects it with AbortError.
  const silent = { posted: [], postMessage(m) { this.posted.push(m); } };
  const client = createWorkerClient(silent);
  const loading = client.load("x", appConfig);
  client.close();
  await assert.rejects(loading, (err) => err.name === "AbortError");
  await assert.rejects(client.load("x", appConfig), (err) => err.name === "AbortError");
  // The worker failing to start at all (e.g. blocked by a policy).
  const broken = { postMessage() {}, onerror: null };
  const c2 = createWorkerClient(broken);
  const p = c2.load("x", appConfig);
  broken.onerror({ preventDefault() {} });
  await assert.rejects(p, (err) => err.name === "WorkerError");
  assert.match(friendlyError(await p.catch((e) => e), "load"), /couldn't run in this browser/);
  // No model loaded: refused before anything is posted.
  const idle = createWorkerClient(fakeWorker([]));
  await assert.rejects(idle.chat.completions.create({ messages: [] }), /No on-device model/);
});

test("the pinned WebLLM still speaks the worker protocol this client uses", () => {
  const pkg = JSON.parse(read("../package.json"));
  assert.equal(pkg.dependencies["@mlc-ai/web-llm"], "0.2.85", "pinned exactly");
  const lock = JSON.parse(read("../package-lock.json"));
  const entry = lock.packages["node_modules/@mlc-ai/web-llm"];
  assert.equal(entry.version, "0.2.85");
  assert.equal(entry.license, "Apache-2.0");
  assert.ok(!entry.hasInstallScript);
  const lib = readFileSync(new URL("../node_modules/@mlc-ai/web-llm/lib/index.js", import.meta.url), "utf8");
  const handler = lib.slice(lib.indexOf("class WebWorkerMLCEngineHandler"), lib.indexOf("function CreateWebWorkerMLCEngine"));
  for (const kind of ["reload", "chatCompletionStreamInit", "completionStreamNextChunk", "interruptGenerate", "setAppConfig", "setLogLevel", "initProgressCallback"])
    assert.match(handler, new RegExp(`"${kind}"`), kind);
  assert.match(handler, /kind: "return"/);
  assert.match(handler, /kind: "throw"/);
  // WebLLM checks the integrity hashes we give it, and reads tensor-cache.json.
  assert.match(lib, /modelRecord\.integrity[\s\S]{0,80}model_lib/);
  assert.match(lib, /"tensor-cache\.json"/);
  // No eval in the engine, so it runs under script-src 'self' 'wasm-unsafe-eval'.
  assert.doesNotMatch(lib, /\beval\(|new Function\(/);
});

test("the existing CSP already allows the engine: same-origin worker, WASM, HTTPS downloads", () => {
  const csp = securityHeaders()["Content-Security-Policy"];
  assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
  assert.match(csp, /worker-src 'self' blob:/);
  assert.match(csp, /connect-src 'self' https: wss:/);
  // The worker is a bundled file (worker-src 'self'), never a CDN script.
  assert.match(read("../src/ondevice-engine.js"), /new Worker\(new URL\("\.\/ondevice\.worker\.js", import\.meta\.url\)/);
  for (const m of appConfigFor(F16_GPU).model_list) {
    assert.ok(m.model.startsWith("https://huggingface.co/"));
    assert.ok(m.model_lib.startsWith("https://raw.githubusercontent.com/"));
  }
});

// ---- The chat itself ----

test("history fits the model's 4k window: newest first, never starting with a reply", () => {
  const long = "word ".repeat(2000); // ~2,860 estimated tokens
  const thread = [
    { role: "user", content: long },
    { role: "assistant", content: "ok" },
    { role: "user", content: "second" },
    { role: "assistant", content: long },
    { role: "user", content: "third" },
  ];
  const fit = fitHistory(thread);
  assert.equal(fit.messages[0].role, "user");
  assert.equal(fit.messages.at(-1).content, "third");
  assert.ok(fit.dropped >= 3);
  const total = fit.messages.reduce((n, m) => n + estimateTokens(m.content), 0) + estimateTokens(SYSTEM_PROMPT);
  assert.ok(total + REPLY_TOKENS <= CONTEXT_WINDOW, `${total} + reply fits`);
  // A short thread goes whole.
  assert.equal(fitHistory(thread.slice(2, 3)).dropped, 0);
  // The newest message is always kept, even when long (the composer caps it).
  assert.equal(fitHistory([{ role: "user", content: long + long }]).messages.length, 1);
  // Chinese counts as a token per character, so estimates run high.
  assert.ok(estimateTokens("本机模型".repeat(100)) >= 400);
  const { request: req, dropped } = buildLocalRequest(thread);
  assert.equal(req.messages[0].role, "system");
  assert.equal(dropped, fit.dropped);
});

test("loading progress: download, loading from this device, ready", () => {
  assert.deepEqual(progressState({ progress: 0, text: "Start to fetch params" }), { phase: "prepare", fraction: 0 });
  assert.deepEqual(
    progressState({ progress: 0.25, text: "Fetching param cache[5/22]: 170MB fetched. 25% completed, 9 secs elapsed." }, 700),
    { phase: "download", fraction: 0.25, done: 175 },
  );
  assert.deepEqual(progressState({ progress: 0.5, text: "Loading model from cache[11/22]: 350MB loaded. 50% completed" }), { phase: "load", fraction: 0.5 });
  assert.deepEqual(progressState({ progress: 1, text: "Finish loading on WebGPU - apple" }), { phase: "ready", fraction: 1 });
  assert.equal(progressState({ progress: 7, text: "Fetching param cache" }).fraction, 1);
});

test("plain error messages for what can go wrong", () => {
  const e = (name, message) => Object.assign(new Error(message), { name });
  assert.match(friendlyError(e("QuotaExceededError", "")), /storage space/);
  assert.match(friendlyError("ContextWindowSizeExceededError: Prompt tokens exceed context window size"), /too long/);
  assert.match(friendlyError(e("Error", "GPU device lost: out of memory")), /ran out of memory/);
  assert.match(friendlyError(e("TypeError", "Failed to fetch"), "load"), /download stopped/);
  assert.match(friendlyError(e("Error", "weird"), "load"), /couldn't start/);
  assert.match(friendlyError(e("Error", "weird")), /stopped before finishing/);
  // The engine's own text is never shown as is.
  assert.doesNotMatch(friendlyError(e("Error", "secret internals at /x/y.js:1")), /internals/);
});

// ---- Device Vault ----

test("Device Vault keeps an on-device chat as a device chat, sealed like any other", async () => {
  const messages = [
    { role: "user", content: "What is WebGPU?" },
    { role: "assistant", content: "A browser API.", local: { model: "qwen-2.5-1.5b", tps: 40 }, extra: "dropped" },
  ];
  const chat = deviceVaultChat({ id: "c1", model: "qwen-2.5-1.5b", messages, created: 1, now: 2 });
  assert.equal(chat.mode, "device");
  assert.equal(chat.model, "qwen-2.5-1.5b");
  assert.equal(chat.title, "What is WebGPU?");
  assert.equal(chat.private, false);
  assert.equal(chat.veil, null);
  assert.deepEqual(chat.messages, [
    { role: "user", content: "What is WebGPU?" },
    { role: "assistant", content: "A browser API.", local: { model: "qwen-2.5-1.5b", tps: 40 } },
  ]);
  assert.equal(deviceVaultChat({ id: "c2", model: "evil", messages }).model, DEFAULT_MODEL);
  // Other chats keep their modes; an unknown mode still falls back to chat.
  assert.equal(vaultChat({ id: "a", mode: "code", messages }).mode, "code");
  assert.equal(vaultChat({ id: "b", mode: "other", messages }).mode, "chat");
  // Sealed and opened with the vault's own format.
  const { key } = await createVault("a long enough passphrase");
  const record = await sealChat(key, chat);
  assert.doesNotMatch(JSON.stringify(record), /WebGPU|browser API/);
  assert.deepEqual(await openChat(key, record), chat);
});

// ---- Chinese ----

test("every visible string has Chinese, and user and model text stays untranslated", () => {
  const zh = compileDictionary(JSON.parse(read("../src/i18n/zh.json")));
  const han = /\p{Script=Han}/u;
  const entry = UPDATES.find((u) => u.id === "ondevice");
  const page = read("../src/OnDevice.jsx");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "On-device",
    "On-device model",
    "Opening the on-device model…",
    "Runs in your browser · free · nothing sent",
    "RUNS ON THIS DEVICE",
    "Chat with a small model that runs in your browser. Free, it keeps answering offline, and nothing you type is sent anywhere.",
    "Checking this browser for WebGPU…",
    "Your browser doesn't support this yet",
    "It works in:",
    "Everything else in ANONYMA works as usual in this browser.",
    "Open Chat",
    "Llama 3.2 1B is ready",
    "Ask anything. The reply is written by your own device; you can even turn off your connection.",
    "on this device",
    "Free · nothing sent",
    "133 tokens a second",
    "Stopped at the length limit.",
    "Earlier messages didn't fit the model's memory, so it saw only the most recent ones.",
    "Message the on-device model",
    "Message Llama 3.2 1B, on this device",
    "On this device · free · nothing sent",
    "Send message",
    "Stop generation",
    "Keep this chat in Device Vault",
    "Encrypted on this device with your passphrase. Never on our servers.",
    "Not saved: kept in this tab only, gone when you reload or close it.",
    "Set up Device Vault to keep it",
    "Unlock Device Vault to keep it",
    "Models on this device",
    "710 MB download",
    "About 879 MB of graphics memory",
    "In use",
    "Starting…",
    "Downloading…",
    "Downloaded · 710 MB",
    "Partly downloaded · 120 MB",
    "Not downloaded",
    "Remove",
    "Using 710 MB on this device",
    "No models downloaded yet",
    "11 GB free for this site",
    "What leaves this device",
    "The model file downloads once from Hugging Face, and its small engine file from GitHub (they see a download, not your chats). After that, everything runs on your device: no credits, nothing sent to ANONYMA or anyone.",
    "Your browser keeps the files until you remove them, and may clear them if it runs short of space.",
    "Small models are weaker than the ones in Chat: expect simpler answers and more mistakes. No web search, files or memory here.",
    "Remove downloaded model?",
    "frees 710 MB on this device. You can download it again any time.",
    "Image not shown: on-device replies never load images.",
    "Download",
    "Already on this device",
    "710 MB, once",
    "Graphics memory",
    "About 879 MB",
    "Cost",
    "Free, no credits",
    "Licence",
    "Start Llama 3.2 1B",
    "Resume download",
    "Download 710 MB and start",
    "Loads from this device. No download, nothing sent.",
    "Only the model file is downloaded. Your messages never leave this device.",
    "Downloading 32%",
    "Loading from this device 80%",
    "Preparing…",
    "Model download",
    "227 MB of 710 MB downloaded",
    "A one-time download. If you stop, what's downloaded is kept and the next start resumes.",
    "Getting the model ready on your graphics processor.",
    "Stop download",
    "Cancel",
    "That message is too long for the on-device model. Keep it under 6,000 characters.",
    "This chat couldn't be saved to Device Vault. It's still here in this tab.",
    "The model's files couldn't be removed. Try again, or clear this site's data in your browser settings.",
    ...ONDEVICE_MODELS.map((m) => m.note),
    ...Object.values(SUPPORT_REASONS),
    ...SUPPORT_WORKS,
    ...["IntegrityError", "QuotaExceededError", "ShaderF16", "ContextWindowSizeExceeded", "out of memory", "WorkerError", "Failed to fetch"].map((m) =>
      friendlyError(Object.assign(new Error(m), { name: m }), "load"),
    ),
    friendlyError(new Error("x"), "load"),
    friendlyError(new Error("x"), "reply"),
  ]) {
    assert.ok(text, "a string to check");
    assert.match(translateText(text, zh) ?? "", han, text);
  }
  assert.equal(translateText("Device Vault", zh), "本机保险库");
  // Model names, licences and every message stay as written.
  assert.match(page, /<b data-i18n="off">\{m\.name\}<\/b>/);
  assert.match(page, /<dd data-i18n="off">\{model\.licence\}<\/dd>/);
  assert.match(page, /<h2 data-i18n="off">\{model\.name\}<\/h2>/);
});
