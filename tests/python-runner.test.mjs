import test, { before, after, mock } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import express from "express";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor, parseReleased, releaseInfo } from "../server/releases.js";
import { pythonTestReply, chatStream } from "../server/provider.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { securityHeaders } from "../src/security-headers.js";
import { buildDocumentBlock, composeMessageWithDocuments, parseDocumentBlocks } from "../src/documents.js";
import {
  LOAD_TIMEOUT,
  MAX_MOUNT_BYTES,
  PYODIDE_CORE_BYTES,
  PYODIDE_CORE_FILES,
  PYODIDE_FILES,
  PYODIDE_LOCK_FILE,
  PYODIDE_PATH,
  PYODIDE_VERSION,
  PYODIDE_WHEELS,
  PYTHON_PACKAGES,
  PYTHON_WORKER_FILE,
  pythonWorkerCsp,
} from "../src/python-assets.js";
import {
  HONEST_LINE,
  PACKAGES_BYTES,
  attachedFiles,
  encodeFiles,
  errorHint,
  firstRunNote,
  isPythonBlock,
  mountableName,
  readError,
  runPython,
  runnerBusy,
  stopPython,
} from "../src/python-runner.js";
import { checkedLock } from "../scripts/pyodide-assets.mjs";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const require = createRequire(import.meta.url);
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const config = (released) => ({ releases: releaseInfo({ released: parseReleased(released) }) });
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const PY = `${PYODIDE_PATH}/pyodide.mjs`;
const WHEEL = `${PYODIDE_PATH}/${PYODIDE_WHEELS[0].file}`;
const builtWorker = () =>
  existsSync("dist/client/assets") ? readdirSync("dist/client/assets").find((f) => /^python\.worker-[\w-]+\.js$/.test(f)) : null;

function app(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-python-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    origin: "http://localhost:5175",
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
const binary = (res, cb) => {
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.on("end", () => cb(null, Buffer.concat(chunks)));
};

// ---- the update and its gate -------------------------------------------------

test("Python Runner is registered, unreleased, and gates only Python's own files", () => {
  const update = UPDATES.find((u) => u.id === "python");
  assert.ok(update, "expected a UPDATES entry with id 'python'");
  assert.equal(update.title, "Python Runner");
  assert.equal(update.tagline, "Run the Python it writes, right in the chat, on your device.");
  assert.equal(update.points.length, 3);
  assert.equal(typeof committed[UPDATES.indexOf(update)], "boolean", "registered release flag");
  for (const path of [PY, WHEEL, "/PYODIDE/314.0.7/pyodide.asm.wasm", "/pyodide", "/pyodide/"])
    assert.deepEqual(featuresFor({ path, method: "GET" }), ["python"], path);
  assert.deepEqual(featuresFor({ path: "/pyodidex", method: "GET" }), []);
  // No server route of its own: a chat stays an ordinary chat.
  assert.deepEqual(featuresFor({ path: "/api/chat", method: "POST", body: { messages: [] } }), []);
  const src = read("server/releases.js");
  assert.doesNotMatch(src.replace(/\/\/.*$/gm, ""), /\/api\/python/);
});

test("Python's files are 403 until released, then served from the build with a year-long cache", async (t) => {
  for (const released of ["mvp", "mvp,documents,code"]) {
    const svc = app(t, released);
    for (const f of [PY, WHEEL, `${PYODIDE_PATH}/${PYODIDE_LOCK_FILE}`]) {
      const r = await request(svc.app).get(f).expect(403);
      assert.equal(r.body.error.code, "feature_unreleased", `${released} ${f}`);
      assert.equal(r.body.error.message, "Python Runner is coming soon.");
    }
    const cfg = (await request(svc.app).get("/api/config").expect(200)).body;
    assert.equal(cfg.releases.features.python, false, released);
  }
  if (!existsSync(`dist/client${PYODIDE_PATH}`)) return t.diagnostic("no dist/: the served-file checks need npm run build");
  const svc = app(t, "mvp,python");
  const cfg = (await request(svc.app).get("/api/config").expect(200)).body;
  assert.equal(cfg.releases.features.python, true);
  const mjs = await request(svc.app).get(PY).expect(200);
  assert.match(mjs.headers["content-type"], /^text\/javascript/);
  assert.equal(mjs.headers["cache-control"], "public, max-age=31536000, immutable");
  assert.equal(mjs.headers["cross-origin-resource-policy"], "same-origin");
  const wasm = await request(svc.app).get(`${PYODIDE_PATH}/pyodide.asm.wasm`).buffer(true).parse(binary).expect(200);
  assert.equal(wasm.headers["content-type"], "application/wasm");
  assert.equal(Buffer.compare(wasm.body, readFileSync(require.resolve("pyodide/pyodide.asm.wasm"))), 0, "the package's own file");
  const wheel = await request(svc.app).get(WHEEL).buffer(true).parse(binary).expect(200);
  assert.equal(wheel.headers["content-type"], "application/octet-stream");
  assert.equal(sha256(wheel.body), PYODIDE_WHEELS[0].sha256, "the pinned wheel");
  // The served lock lists only the pinned wheels.
  const lock = JSON.parse((await request(svc.app).get(`${PYODIDE_PATH}/${PYODIDE_LOCK_FILE}`).expect(200)).text);
  assert.deepEqual(Object.keys(lock.packages).sort(), PYODIDE_WHEELS.map((w) => w.name).sort());
  for (const w of PYODIDE_WHEELS) assert.equal(lock.packages[w.name].sha256, w.sha256);
  const notice = await request(svc.app).get(`${PYODIDE_PATH}/LICENSES.txt`).expect(200);
  assert.match(notice.text, /Mozilla Public License 2\.0/);
  // Nothing else is under /pyodide/: the directory holds exactly the list.
  const served = readdirSync(`dist/client${PYODIDE_PATH}`).sort();
  assert.deepEqual(served, [...PYODIDE_FILES, "LICENSES.txt"].sort());
});

test("the app's CSP is unchanged; the worker script alone gets a stricter one", async (t) => {
  // The policy as it was before Python Runner: 'self' and 'wasm-unsafe-eval'
  // already cover Pyodide, so nothing was added.
  const csp = securityHeaders()["Content-Security-Policy"];
  assert.equal(
    csp,
    "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; font-src 'self' data:; media-src 'self' blob: https:; worker-src 'self' blob:; connect-src 'self' https: wss:; frame-src https://verify.walletconnect.com https://verify.walletconnect.org",
  );
  assert.doesNotMatch(read("src/security-headers.js"), /pyodide|python/i);
  // The worker's own policy: Pyodide's files and WebAssembly, nothing else.
  assert.equal(
    pythonWorkerCsp("https://askanonyma.com"),
    "default-src 'none'; script-src https://askanonyma.com/pyodide/ 'wasm-unsafe-eval'; connect-src https://askanonyma.com/pyodide/; base-uri 'none'",
  );
  assert.doesNotMatch(pythonWorkerCsp("https://askanonyma.com"), /unsafe-eval'(?!.)|'self'|https:(?!\/\/askanonyma)|\*/);
  assert.ok(PYTHON_WORKER_FILE.test("/app/dist/client/assets/python.worker-BWhGJhtP.js"));
  assert.ok(!PYTHON_WORKER_FILE.test("/app/dist/client/assets/Workspace-abc.js"));
  const worker = builtWorker();
  if (!worker) return t.diagnostic("no dist/: the header check needs npm run build");
  const svc = app(t, "mvp", { origin: "https://askanonyma.com" });
  const r = await request(svc.app).get(`/assets/${worker}`).expect(200);
  assert.equal(r.headers["content-security-policy"], pythonWorkerCsp("https://askanonyma.com"));
  const page = await request(svc.app).get("/").expect(200);
  assert.equal(page.headers["content-security-policy"].replace(/ frame-src [^;]*$/, ""), csp.replace(/ frame-src [^;]*$/, ""));
});

test("the build copies the pinned interpreter as it is and checks every wheel's hash", () => {
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.devDependencies.pyodide, PYODIDE_VERSION, "pinned exactly");
  assert.equal(JSON.parse(readFileSync(require.resolve("pyodide/package.json"), "utf8")).version, PYODIDE_VERSION);
  assert.equal(JSON.parse(readFileSync(require.resolve("pyodide/package.json"), "utf8")).license, "MPL-2.0");
  // The pins are the package's own lock entries, and exactly what the
  // offered packages need.
  const { trimmed } = checkedLock();
  assert.deepEqual(PYTHON_PACKAGES, ["numpy", "pandas", "matplotlib"]);
  assert.deepEqual(Object.keys(trimmed.packages).sort(), PYODIDE_WHEELS.map((w) => w.name).sort());
  const size = (f) => statSync(require.resolve(`pyodide/${f}`)).size;
  assert.equal(PYODIDE_CORE_BYTES, PYODIDE_CORE_FILES.reduce((s, f) => s + size(f), 0));
  if (existsSync(`dist/client${PYODIDE_PATH}`)) {
    for (const f of PYODIDE_CORE_FILES)
      assert.equal(Buffer.compare(readFileSync(`dist/client${PYODIDE_PATH}/${f}`), readFileSync(require.resolve(`pyodide/${f}`))), 0, f);
    for (const w of PYODIDE_WHEELS) {
      const buf = readFileSync(`dist/client${PYODIDE_PATH}/${w.file}`);
      assert.equal(sha256(buf), w.sha256, w.file);
      assert.equal(buf.length, w.bytes, w.file);
    }
  }
  // Nothing is committed: the wheels come from the cache in node_modules.
  assert.doesNotMatch(read("scripts/pyodide-assets.mjs"), /writeFileSync\([^)]*(public|src)\//);
  assert.ok(!existsSync("public/pyodide"));
  // No URL anywhere in the runner's own browser code: nothing from a CDN.
  for (const f of ["src/python-runner.js", "src/python.worker.js", "src/python-assets.js", "src/PythonRunner.jsx"])
    assert.doesNotMatch(read(f), /https?:\/\/|\/\/cdn|jsdelivr|unpkg/i, f);
  // Lazy: the worker and Pyodide load on the first Run, never with the app.
  assert.match(read("src/python-runner.js"), /new Worker\(new URL\("\.\/python\.worker\.js", import\.meta\.url\)/);
  assert.match(read("src/python.worker.js"), /await import\(\/\* @vite-ignore \*\/ INDEX \+ "pyodide\.mjs"\)/);
  assert.match(read("Dockerfile"), /src\/python-assets\.js(?: [^\n]+)? \.\/src\//, "the server's import is in the image");
});

// ---- the worker's lockdown, as written ---------------------------------------

test("the worker removes its own network and storage before Pyodide loads", () => {
  const src = read("src/python.worker.js");
  const lockdown = src.indexOf('pin(self, "fetch", guardedFetch)');
  const load = src.indexOf("await import(");
  assert.ok(lockdown > 0 && load > lockdown, "locked down first");
  for (const name of ["XMLHttpRequest", "WebSocket", "EventSource", "WebTransport", "Worker", "SharedWorker", "BroadcastChannel", "FontFace", "RTCPeerConnection"])
    assert.match(src, new RegExp(`"${name}",`), name);
  for (const name of ["indexedDB", "caches", "fonts", "cookieStore"]) assert.match(src, new RegExp(`"${name}"`), name);
  for (const name of ["storage", "serviceWorker", "locks"]) assert.match(src, new RegExp(`"${name}"`), name);
  assert.match(src, /pin\(self, "importScripts", refuse\)/);
  // fetch reaches only the listed files, by exact URL, without cookies.
  assert.match(src, /if \(!ALLOWED\.has\(url\.href\)\) return Promise\.reject/);
  assert.match(src, /credentials: "omit",\s*mode: "same-origin",\s*redirect: "error"/);
  // Python's `js` module is a short list, not the worker's globals.
  assert.match(src, /jsglobals: \{/);
  assert.doesNotMatch(src.slice(src.indexOf("jsglobals: {"), src.indexOf("env: {")), /fetch|XMLHttp|self,|globalThis/);
  // The memory cap and a refusal if the lockdown failed.
  assert.match(src, /pin\(WebAssembly\.Memory\.prototype, "grow"/);
  assert.match(src, /if \(lockdownError\) throw lockdownError;/);
});

// ---- the page's controller: timeouts, Stop, and what it trusts ---------------

class FakeWorker {
  static all = [];
  constructor(url, options) {
    this.url = String(url);
    this.options = options;
    this.listeners = {};
    this.posted = [];
    this.terminated = false;
    FakeWorker.all.push(this);
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  postMessage(message, transfer) {
    this.posted.push({ message, transfer });
  }
  terminate() {
    this.terminated = true;
  }
  emit(data) {
    for (const fn of this.listeners.message || []) fn({ data });
  }
}

test("a runaway run is stopped by terminating the worker when its time is up", (t) => {
  const saved = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => {
    stopPython();
    mock.timers.reset();
    globalThis.Worker = saved;
    FakeWorker.all.length = 0;
  });
  const events = [];
  runPython({
    code: "while True: pass",
    files: [{ name: "../../secret/sales.csv", text: "a,b\n1,2" }, { name: "evil.sh", text: "x" }],
    onEvent: (e) => events.push(e),
  });
  const w = FakeWorker.all.at(-1);
  assert.equal(w.options.type, "module");
  assert.match(w.url, /python\.worker\.js$/);
  const { message, transfer } = w.posted[0];
  assert.equal(message.type, "run");
  assert.equal(message.code, "while True: pass");
  assert.deepEqual(message.files.map((f) => f.name), ["sales.csv"], "a bare, text-file name only");
  assert.equal(new TextDecoder().decode(message.files[0].bytes), "a,b\n1,2");
  assert.equal(transfer.length, 1);
  assert.equal(runnerBusy(), true);
  const id = message.id;
  // A message for another run, a spoofed "done" before the code starts, an
  // unknown stream and a figure that isn't bytes are all ignored.
  w.emit({ id: id + 1, type: "running" });
  w.emit({ id, type: "done", ok: true });
  w.emit({ id, type: "out", stream: "html", text: "<b>x</b>" });
  assert.deepEqual(events, []);
  w.emit({ id, type: "running" });
  w.emit({ id, type: "out", stream: "stdout", text: "tick\n" });
  w.emit({ id, type: "figure", png: "data:image/png;base64,AAAA" });
  assert.deepEqual(events.map((e) => e.type), ["running", "out"]);
  // The clock starts when the code does: 30 s by default.
  mock.timers.tick(29999);
  assert.equal(w.terminated, false);
  mock.timers.tick(1);
  assert.equal(w.terminated, true, "the worker is terminated: the loop can't go on");
  assert.deepEqual(events.at(-1), { type: "done", ok: false, reason: "timeout", seconds: 30 });
  assert.equal(runnerBusy(), false);
  // A late message from the dead worker changes nothing.
  w.emit({ id, type: "out", stream: "stdout", text: "late\n" });
  assert.equal(events.at(-1).type, "done");

  // The next run starts a new worker; Stop terminates it at once.
  const more = [];
  const stop = runPython({ code: "print(1)", timeout: 60, onEvent: (e) => more.push(e) });
  const w2 = FakeWorker.all.at(-1);
  assert.notEqual(w2, w);
  w2.emit({ id: w2.posted[0].message.id, type: "running" });
  mock.timers.tick(30000);
  assert.equal(w2.terminated, false, "a 60 s limit was chosen");
  stop();
  assert.equal(w2.terminated, true);
  assert.deepEqual(more.at(-1), { type: "done", ok: false, reason: "stopped" });

  // Python that never starts is given up on too.
  const slow = [];
  runPython({ code: "print(1)", timeout: 5, onEvent: (e) => slow.push(e) });
  const w3 = FakeWorker.all.at(-1);
  mock.timers.tick(LOAD_TIMEOUT * 1000);
  assert.equal(w3.terminated, true);
  assert.equal(slow.at(-1).reason, "load-timeout");

  // A finished run keeps the worker warm, then lets it go when idle, or at
  // once if it grew past 512 MB.
  const done = [];
  runPython({ code: "print(1)", timeout: 5, onEvent: (e) => done.push(e) });
  const w4 = FakeWorker.all.at(-1);
  const id4 = w4.posted[0].message.id;
  w4.emit({ id: id4, type: "running" });
  mock.timers.tick(5000);
  assert.equal(w4.terminated, false, "an unknown limit falls back to 30 s");
  w4.emit({ id: id4, type: "done", ok: true, value: "3", ms: 12, memory: 40e6 });
  assert.deepEqual(done.at(-1), { type: "done", ok: true, value: "3", ms: 12 });
  assert.equal(w4.terminated, false);
  mock.timers.tick(5 * 60 * 1000);
  assert.equal(w4.terminated, true, "idle for five minutes");
  runPython({ code: "x = bytearray(600_000_000)", onEvent: () => {} });
  const w5 = FakeWorker.all.at(-1);
  const id5 = w5.posted[0].message.id;
  w5.emit({ id: id5, type: "running" });
  w5.emit({ id: id5, type: "done", ok: true, memory: 700 * 1024 * 1024 });
  assert.equal(w5.terminated, true, "its memory is given back");
});

// ---- files, errors and honest sizes ------------------------------------------

test("only text files attached in this conversation are offered, under bare names", () => {
  const content = composeMessageWithDocuments("Chart this", [
    { name: "sales.csv", text: "month,revenue\nJan,1" },
    { name: "notes.pdf", text: "pdf text" },
    { name: "../../etc/passwd.csv", text: "x" },
  ]);
  const docs = [
    ...parseDocumentBlocks(content).documents,
    { name: "page.csv", source: "link", text: "fetched" },
    { name: "scan.csv", source: "ocr", text: "read" },
    { name: "sales.csv", text: "month,revenue\nJan,2", truncated: true },
  ];
  assert.deepEqual(attachedFiles(docs), [
    { name: "sales.csv", text: "month,revenue\nJan,2", truncated: true },
    { name: "passwd.csv", text: "x", truncated: false },
  ]);
  assert.equal(mountableName("a/b\\c.tsv"), "c.tsv");
  assert.equal(mountableName(".hidden.json"), "hidden.json");
  assert.equal(mountableName("data (1).csv"), "data (1).csv");
  assert.equal(mountableName("x.py"), null);
  assert.equal(mountableName(""), null);
  assert.equal(encodeFiles([{ name: "big.csv", bytes: new Uint8Array(MAX_MOUNT_BYTES + 1) }]).length, 0);
  assert.equal(encodeFiles([{ name: "ok.csv", text: "a" }])[0].bytes.length, 1);
  assert.ok(isPythonBlock(["language-python"]));
  assert.ok(isPythonBlock("language-py"));
  assert.ok(!isPythonBlock(["language-javascript"]));
  assert.ok(!isPythonBlock(undefined));
});

test("errors get a plain hint, and the first run's size is the real one", () => {
  const tb = (last) => `Traceback (most recent call last):\n  File "<python>", line 1, in <module>\n${last}\n`;
  assert.deepEqual(readError(tb("ZeroDivisionError: division by zero")), { name: "ZeroDivisionError", detail: "division by zero" });
  assert.equal(errorHint(tb("ModuleNotFoundError: No module named 'scipy'")), "scipy isn't available here. Python Runner has numpy, pandas, matplotlib and Python's standard library.");
  assert.equal(errorHint(tb("ModuleNotFoundError: No module named 'numpy'")), null);
  assert.equal(errorHint(tb("FileNotFoundError: [Errno 44] No such file or directory: 'sales.csv'")), "The code reads a file it wasn't given. Attach it to the chat, then tick it next to Run.");
  assert.equal(errorHint(tb("MemoryError")), "The code ran out of memory. Python Runner allows about 1 GB.");
  assert.equal(errorHint(tb("OSError: No network: code in Python Runner can't reach the internet, ANONYMA or this site's saved data.")), "Python Runner has no network, so code can't download anything.");
  assert.equal(errorHint("hello"), null);
  const total = PYODIDE_WHEELS.reduce((s, w) => s + w.bytes, 0);
  assert.equal(PACKAGES_BYTES, total);
  assert.equal(firstRunNote(), "The first run downloads Python (about 13.4 MB) from ANONYMA, and numpy, pandas or matplotlib (up to 17.4 MB more) only when code uses them. Your browser keeps a copy.");
  assert.equal(HONEST_LINE, "Code runs in your browser. It can't reach the internet or your files unless you attach them. Check code before you run it.");
});

// ---- the UI and its gate ------------------------------------------------------

async function uiModule() {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-python-ui-"));
  const react = import.meta.resolve("react");
  writeFileSync(join(dir, "ui.mjs"), `import React from "${react}";\nexport const Icon = () => React.createElement("svg");\n`);
  const src = new URL("../src/PythonRunner.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const out = code
    .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${pathToFileURL(join(dir, "ui.mjs")).href}"`)
    .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "PythonRunner.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const hast = (lang, text) => ({
  type: "element",
  tagName: "pre",
  children: [{ type: "element", tagName: "code", properties: { className: lang ? [`language-${lang}`] : [] }, children: [{ type: "text", value: text }] }],
});

test("Run appears on finished Python blocks only once Python Runner is released", async () => {
  const ui = await uiModule();
  assert.equal(ui.pythonReleased(null), false);
  assert.equal(ui.pythonReleased(config("mvp")), false);
  assert.equal(ui.pythonReleased(config("mvp,python")), true);
  assert.equal(ui.pythonReleased(config("all")), true);
  const render = ({ enabled, lang = "python", streaming = false, base, files = [] }) => {
    function Probe() {
      const parts = ui.usePythonRunner({ enabled, base, files });
      const set = streaming ? parts.streamingComponents : parts.components;
      const Pre = set?.pre;
      const node = hast(lang, "print(1)");
      return Pre ? createElement(Pre, { node }, createElement("code", null, "print(1)")) : createElement("pre", null, "plain");
    }
    return renderToStaticMarkup(createElement(Probe));
  };
  assert.doesNotMatch(render({ enabled: false }), /python-run/);
  const on = render({ enabled: true, files: [{ name: "sales.csv", text: "a", truncated: true }] });
  assert.match(on, /class="small-button python-run"[^>]*><svg><\/svg><span>Run<\/span>/);
  assert.match(on, /title="Code runs in your browser\. It can&#x27;t reach the internet or your files unless you attach them\. Check code before you run it\."/);
  assert.match(on, /<input type="checkbox"\/><span>Use my attached CSV<\/span><span class="python-file-name" data-i18n="off">sales\.csv<\/span><span class="python-file-cut">shortened<\/span>/, "unticked until chosen");
  assert.match(render({ enabled: true, files: [{ name: "notes.json", text: "{}" }] }), /<span>Use my attached file<\/span>/);
  assert.match(on, /<option value="30" selected="">30 seconds<\/option><option value="60">1 minute<\/option><option value="120">2 minutes<\/option>/);
  assert.doesNotMatch(render({ enabled: true, lang: "javascript" }), /python-run/);
  assert.doesNotMatch(render({ enabled: true, streaming: true }), /python-run/, "not while the reply is still arriving");
  // Live Preview's button keeps working on other blocks.
  const base = { pre: ({ node, children }) => createElement("div", { className: "preview-block" }, createElement("pre", null, children)) };
  assert.match(render({ enabled: true, lang: "html", base }), /preview-block/);
  assert.match(render({ enabled: true, base }), /python-run/);
  assert.match(render({ enabled: true, base }), /preview-block/, "Python blocks keep the base block too");

  // Workspace renders it behind the gate, in text modes, on replies only.
  const ws = read("src/Workspace.jsx");
  assert.match(ws, /const pythonLive = pythonReleased\(config\) && textMode;/);
  assert.match(ws, /usePythonRunner\(\{ enabled: pythonLive, base: htmlPreview\.components, files: pythonFiles \}\)/);
  assert.match(ws, /const replyParts =\s*m\.role !== "assistant"\s*\? undefined\s*: busy && i === messages\.length - 1\s*\? python\.streamingComponents\s*: python\.components;/);
  assert.match(ws, /components=\{\s*shieldView\s*\? shieldMarkdown\(replyParts\)\s*: replyParts\s*\}/);
  const dc = read("src/DataControls.jsx");
  assert.match(dc, /const python = !!config && isReleased\(config, "python"\);/);
  assert.match(dc, /\{python && \(\s*<li>\s*Python Runner:/);
});

test("nothing is sent, stored or charged: the runner has no server path", () => {
  for (const f of ["src/PythonRunner.jsx", "src/python-runner.js", "src/python.worker.js"]) {
    const src = read(f);
    assert.doesNotMatch(src, /\bapi\(|["'`]\/api\/|navigator\.sendBeacon\(|localStorage\.setItem\((?!ACK_KEY)/, f);
  }
  // Output is shown, never written into the conversation.
  assert.doesNotMatch(read("src/PythonRunner.jsx"), /setMessages|fetch\(|\/api\//);
  // Model output and code output are never translated or rendered as HTML.
  const ui = read("src/PythonRunner.jsx");
  assert.doesNotMatch(ui, /dangerouslySetInnerHTML|innerHTML/);
  assert.match(ui, /<pre className="python-output" data-i18n="off"/);
  assert.match(ui, /<pre className="python-output python-value" data-i18n="off"/);
  assert.match(ui, /URL\.createObjectURL\(new Blob\(\[png\], \{ type: "image\/png" \}\)\)/);
});

test("local test mode answers a Python plotting or CSV request with runnable code", async () => {
  const run = async (content) => {
    let out = "";
    for await (const e of chatStream({ testMode: true }, { model: "claude-sonnet-5", messages: [{ role: "user", content }] }))
      out += e.choices?.[0]?.delta?.content || "";
    return out;
  };
  const plot = await run("Plot a sine wave in Python");
  assert.match(plot, /^\*\*Local test provider\*\* — a fixed sample reply, not a live model\./);
  assert.match(plot, /```python\nimport numpy as np\nimport matplotlib\.pyplot as plt\n[\s\S]*plt\.show\(\)[\s\S]*```/);
  const withCsv = await run(composeMessageWithDocuments("Chart this CSV in Python", [{ name: "sales.csv", text: "month,revenue\nJan,1" }]));
  assert.match(withCsv, /df = pd\.read_csv\("sales\.csv"\)/);
  assert.match(pythonTestReply("用 Python 画图"), /```python/);
  assert.match(await run("Write a python function"), /```javascript filename=hello\.js/, "unchanged");
  // A CSV that mentions python doesn't turn an unrelated question into one.
  assert.equal(pythonTestReply("Summarise this\n\n" + buildDocumentBlock({ name: "a.csv", text: "python,plot" })), null);
});

// ---- Chinese -----------------------------------------------------------------

test("every string Python Runner shows has a Chinese translation", () => {
  const zh = compileDictionary(JSON.parse(read("src/i18n/zh.json")));
  const han = /\p{Script=Han}/u;
  const texts = new Set();
  const src = read("src/PythonRunner.jsx");
  for (const [, t] of src.matchAll(/L\("([^"]+)"\)/g)) texts.add(t);
  assert.ok(texts.has("Use my attached CSV") && texts.has("Use my attached file"));
  const update = UPDATES.find((u) => u.id === "python");
  for (const t of [update.title, update.tagline, ...update.points]) texts.add(t);
  for (const t of [
    HONEST_LINE,
    firstRunNote(),
    "Loading numpy, matplotlib…",
    "Loading pandas…",
    "Running… 3.2 s",
    "Finished in 1.4 s",
    "Finished in 0.1 s",
    "Stopped: still running after 30 s",
    "Stopped: still running after 120 s",
    "Figure 1",
    "30 seconds",
    "1 minute",
    "2 minutes",
    "Download PNG",
    "Stop",
    "Stopped",
    "Cancel",
    "Result",
    "Python couldn't start in this browser.",
    errorHint("ModuleNotFoundError: No module named 'scipy'"),
    errorHint("FileNotFoundError: x"),
    errorHint("MemoryError"),
    errorHint("OSError: No network: x"),
    /Python Runner: [^\n]+/.exec(read("src/DataControls.jsx"))[0].trim(),
  ])
    texts.add(t);
  assert.ok(texts.size > 35, `the scan found the panel's strings (${texts.size})`);
  for (const t of texts) assert.match(translateText(t, zh) ?? "", han, `untranslated: ${JSON.stringify(t)}`);
  assert.equal(translateText("Finished in 1.4 s", zh), "已完成，用时 1.4 秒");
  assert.equal(translateText("Figure 2", zh), "图 2");
  // Code, output and file names are never translated.
  assert.match(src, /<span className="python-file-name" data-i18n="off">/);
  assert.match(src, /<span data-i18n="off">\{state\.files\.join\(", "\)\}<\/span>/);
});

// ---- headless Chrome: the real worker ----------------------------------------
// A saved reply with Python blocks, run in the app under its real CSP: output,
// a figure, every network route refused, a CSV given only when ticked, and a
// runaway loop killed at 30 s. Every request the page and its worker make is
// recorded. Needs Chrome and a build (npm run build); skipped otherwise.

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const noChrome = !existsSync(CHROME) || !builtWorker() || !existsSync(`dist/client${PYODIDE_PATH}/${PYODIDE_WHEELS.at(-1).file}`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
async function chrome(t) {
  const profile = mkdtempSync(join(tmpdir(), "anonyma-python-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,1400", "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
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
    requests = [],
    workers = new Set();
  const workerSessions = new Set();
  const send = (method, params = {}, sessionId) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method === "Network.requestWillBeSent") requests.push({ url: m.params.request.url, worker: workerSessions.has(m.sessionId) });
    else if (m.method === "Target.attachedToTarget") {
      const sessionId = m.params.sessionId;
      if (m.params.targetInfo.type === "worker") {
        workerSessions.add(sessionId);
        if (PYTHON_WORKER_FILE.test(new URL(m.params.targetInfo.url, "http://x").pathname)) workers.add(sessionId);
      }
      send("Network.enable", {}, sessionId)
        .catch(() => {})
        .then(() => send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => {}));
    } else if (m.method === "Target.detachedFromTarget") workers.delete(m.params.sessionId);
  };
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, ms = 60000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        const v = await evaluate(expression);
        if (v) return v;
      } catch {}
      await wait(150);
    }
    throw new Error("timed out waiting for " + expression);
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true });
  return { send, evaluate, until, requests, workers };
}

const BLOCKS = {
  hello: 'print("hello from python", 6 * 7)\n{"answer": 42}',
  network: `import pyodide_js
results = []
async def attempt(label, go):
    try:
        await go()
        results.append("REACHED " + label)
    except BaseException as e:
        results.append("blocked " + label)

async def js_fetch():
    from js import fetch
    await fetch("https://example.com/")
async def pyfetch_web():
    import pyodide.http
    await pyodide.http.pyfetch("https://example.com/")
async def pyfetch_site():
    import pyodide.http
    await pyodide.http.pyfetch("/api/me")
async def open_url():
    import pyodide.http
    pyodide.http.open_url("https://example.com/")
async def loader_site():
    await pyodide_js._api.loadBinaryFile("/api/me")
async def loader_web():
    await pyodide_js._api.loadBinaryFile("https://example.com/x.whl")
async def package_url():
    await pyodide_js.loadPackage("https://example.com/x-1.0-py3-none-any.whl", error_callback=lambda m: None)
    import x
async def urllib_web():
    import urllib.request
    urllib.request.urlopen("http://example.com/", timeout=3)
async def socket_web():
    import socket
    socket.create_connection(("example.com", 80), timeout=3)
async def js_eval():
    pyodide_js.constructor.constructor("return fetch")()("https://example.com/")

for label, go in [("js-fetch", js_fetch), ("pyfetch-web", pyfetch_web), ("pyfetch-site", pyfetch_site), ("open-url", open_url), ("loader-site", loader_site), ("loader-web", loader_web), ("package-url", package_url), ("urllib", urllib_web), ("socket", socket_web), ("eval", js_eval)]:
    await attempt(label, go)
print("\\n".join(results))`,
  figure: `import numpy as np
import matplotlib.pyplot as plt
from PIL import Image
x = np.linspace(0, 6.3, 50)
plt.plot(x, np.sin(x))
plt.title("wave")
plt.show()
print("drawn", Image.new("RGB", (3, 2)).size)`,
  csv: `import pandas as pd
df = pd.read_csv("sales.csv")
print("total", df["revenue"].sum())`,
  loop: "while True:\n    pass",
};

test("headless: Python runs in the browser with no network, draws a figure, and a runaway loop is killed", { skip: noChrome && "needs Chrome and dist/", timeout: 240000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-python-e2e-"));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const svc = createApp({ testMode: true, released: "all", origin, dbPath: join(dir, "db.sqlite"), mediaPath: join(dir, "media"), catalogPath: join(dir, "models.json") });
  const served = [];
  const outer = express();
  outer.use((req, res, next) => {
    served.push(req.path);
    next();
  });
  outer.use(svc.app);
  const server = outer.listen(port, "127.0.0.1");
  t.after(() => {
    server.close();
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const page = await chrome(t);
  await page.send("Page.navigate", { url: origin + "/" });
  await page.until(`document.readyState === "complete"`);
  const status = await page.evaluate(
    `fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "python-e2e", password: "test-password-long" }) }).then((r) => r.status)`,
  );
  assert.equal(status, 201);
  await page.evaluate(`localStorage.setItem("anonyma.python.ack", "1")`);
  // A saved chat: a question with sales.csv attached, and a reply with
  // five Python blocks.
  const user = svc.db.prepare("SELECT id FROM users WHERE username=?").get("python-e2e").id;
  const now = Date.now();
  svc.db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)").run("c_python", user, "Python", "chat", now, now);
  const question = composeMessageWithDocuments("Run some Python", [{ name: "sales.csv", text: "month,revenue\nJan,4200\nFeb,4800\n" }]);
  const reply = Object.values(BLOCKS).map((code) => "```python\n" + code + "\n```").join("\n\n");
  const insert = svc.db.prepare("INSERT INTO messages(id,conversation_id,role,content,model,cost,created) VALUES(?,?,?,?,?,?,?)");
  insert.run("m_q", "c_python", "user", JSON.stringify(question), null, 0, now);
  insert.run("m_a", "c_python", "assistant", JSON.stringify(reply), "claude-sonnet-5", 0, now + 1);

  await page.send("Page.navigate", { url: origin + "/workspace/chat?c=c_python" });
  await page.until(`document.querySelectorAll(".python-block .python-run").length === 5`);
  const block = (i) => `document.querySelectorAll(".python-block")[${i}]`;
  const runBlock = async (i, { tick = false } = {}) => {
    if (tick) await page.evaluate(`${block(i)}.querySelector(".python-file input").click()`);
    await page.evaluate(`${block(i)}.querySelector(".python-run").click()`);
    await page.until(`!${block(i)}.querySelector(".python-stop") && /Finished|error|Stopped/.test(${block(i)}.querySelector(".python-status")?.textContent || "")`, 120000);
    return page.evaluate(`${block(i)}.querySelector(".python-panel").innerText`);
  };

  // 1. stdout, and the last expression's value.
  const hello = await runBlock(0);
  assert.match(hello, /Finished in [\d.]+ s/);
  assert.match(hello, /hello from python 42/);
  assert.match(hello, /\{'answer': 42\}/);
  assert.match(hello, /Code runs in your browser\. It can't reach the internet or your files unless you attach them\. Check code before you run it\./);

  // 2. Every way out is refused.
  const net = await runBlock(1);
  assert.doesNotMatch(net, /REACHED/);
  for (const label of ["js-fetch", "pyfetch-web", "pyfetch-site", "open-url", "loader-site", "loader-web", "package-url", "urllib", "socket", "eval"])
    assert.match(net, new RegExp(`blocked ${label}\\b`), `${label}: ${net}`);

  // 3. A matplotlib figure, drawn in the worker and shown as a PNG.
  const fig = await runBlock(2);
  assert.match(fig, /drawn \(3, 2\)/, "pillow loads by its import name, PIL");
  assert.match(fig, /Figure 1/);
  const img = await page.evaluate(`(() => { const i = ${block(2)}.querySelector(".python-figures img"); return i && { src: i.src.slice(0, 5), w: i.naturalWidth, h: i.naturalHeight }; })()`);
  assert.equal(img.src, "blob:");
  assert.ok(img.w > 300 && img.h > 200, `a real image: ${JSON.stringify(img)}`);

  // 4. The attached CSV reaches the code only when ticked.
  const without = await runBlock(3);
  assert.match(without, /FileNotFoundError/);
  assert.match(without, /The code reads a file it wasn't given\./);
  const withFile = await runBlock(3, { tick: true });
  assert.match(withFile, /total 9000/);
  assert.match(withFile, /sales\.csv/);

  // Every request so far: the app's own page and API calls, and Pyodide's
  // files for the worker. Nothing left this origin, and the worker asked for
  // nothing but its own script and Pyodide's files.
  const outside = page.requests.filter((r) => !r.url.startsWith(origin) && !/^(data|blob):/.test(r.url));
  assert.deepEqual(outside, [], "no request left this origin");
  const fromWorker = page.requests.filter((r) => r.worker).map((r) => r.url.slice(origin.length));
  assert.ok(fromWorker.some((u) => u === `${PYODIDE_PATH}/pyodide.asm.wasm`), "the worker's requests were recorded");
  for (const u of fromWorker) assert.ok(u.startsWith(`${PYODIDE_PATH}/`) || PYTHON_WORKER_FILE.test(u), `worker asked for ${u}`);
  assert.ok(served.includes(`${PYODIDE_PATH}/${PYODIDE_WHEELS.find((w) => w.name === "matplotlib").file}`));

  // 5. A runaway loop: Stop ends it at once; left alone, the 30 s limit does.
  await page.evaluate(`${block(4)}.querySelector(".python-run").click()`);
  await page.until(`/Running/.test(${block(4)}.querySelector(".python-status")?.textContent || "")`);
  await wait(1500);
  const workersBefore = page.workers.size;
  assert.ok(workersBefore >= 1);
  await page.evaluate(`${block(4)}.querySelector(".python-stop").click()`);
  await page.until(`${block(4)}.querySelector(".python-status")?.textContent === "Stopped"`, 5000);
  await page.until(`document.querySelectorAll(".python-run:not(:disabled)").length === 5`, 5000);
  const started = Date.now();
  await page.evaluate(`${block(4)}.querySelector(".python-run").click()`);
  await page.until(`/Stopped: still running after 30 s/.test(${block(4)}.querySelector(".python-status")?.textContent || "")`, 120000);
  const took = (Date.now() - started) / 1000;
  assert.ok(took >= 30 && took < 90, `stopped after ${took} s`);
  await page.until(`true`, 1000);
  for (let i = 0; i < 20 && page.workers.size; i++) await wait(250);
  assert.equal(page.workers.size, 0, "the worker was terminated");
  // And Python starts again afterwards.
  const again = await runBlock(0);
  assert.match(again, /hello from python 42/);
});
