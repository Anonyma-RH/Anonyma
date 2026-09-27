// Python Runner, on the page: one Python worker (src/python.worker.js) for
// the whole tab, started on the first Run and reused while it's warm. A run
// that's stopped or runs out of time ends by terminating the worker, which
// is the only sure way to stop a loop; the next Run starts a new one. An
// idle worker is shut down after IDLE_SHUTDOWN_MS to give its memory back.
import {
  IDLE_SHUTDOWN_MS,
  LOAD_TIMEOUT,
  MAX_MOUNT_BYTES,
  PYODIDE_CORE_BYTES,
  PYODIDE_WHEELS,
  RUN_TIMEOUT_DEFAULT,
  RUN_TIMEOUTS,
} from "./python-assets.js";

export const PYTHON_UPDATE = "python";
// Code blocks the Run button appears on: python, py or python3.
export const isPythonBlock = (classes) =>
  [].concat(classes || []).some((c) => /^language-(?:python|py|python3)$/i.test(String(c)));

// ---- honest sizes ----
export const megabytes = (bytes) => Math.round((bytes / 1e6) * 10) / 10;
export const PACKAGES_BYTES = PYODIDE_WHEELS.reduce((sum, w) => sum + w.bytes, 0);
export const firstRunNote = () =>
  `The first run downloads Python (about ${megabytes(PYODIDE_CORE_BYTES)} MB) from ANONYMA, and numpy, pandas or matplotlib (up to ${megabytes(PACKAGES_BYTES)} MB more) only when code uses them. Your browser keeps a copy.`;
export const HONEST_LINE =
  "Code runs in your browser. It can't reach the internet or your files unless you attach them. Check code before you run it.";

// ---- files the person can give a run ----
// Attached text files that code usually reads (CSV and friends), from the
// user messages of this conversation: [{ name, text, truncated }].
export const MOUNTABLE = /\.(csv|tsv|txt|json)$/i;
export function mountableName(name) {
  const base = String(name || "").split(/[\\/]/).pop().trim();
  const clean = base.replace(/[^\w .()-]/g, "_").replace(/^[^\w]+/, "").slice(0, 120);
  return clean && MOUNTABLE.test(clean) ? clean : null;
}
export function attachedFiles(documents) {
  const seen = new Map();
  for (const d of documents || []) {
    if (d?.source === "link" || d?.source === "ocr") continue;
    const name = mountableName(d?.name);
    if (!name || typeof d.text !== "string") continue;
    // The latest copy of a name wins.
    seen.set(name, { name, text: d.text, truncated: !!d.truncated });
  }
  return [...seen.values()];
}
export function encodeFiles(files) {
  const enc = new TextEncoder();
  return (files || [])
    .map((f) => ({ name: mountableName(f.name), bytes: f.bytes instanceof Uint8Array ? f.bytes : enc.encode(String(f.text ?? "")) }))
    .filter((f) => f.name && f.bytes.length <= MAX_MOUNT_BYTES);
}

// ---- tracebacks the model can't have seen ----
export function readError(text) {
  const last = String(text || "").trim().split("\n").at(-1) || "";
  const m = /^(\w+(?:Error|Exception|Exit)|MemoryError|KeyboardInterrupt)(?::\s*(.*))?$/.exec(last);
  return m ? { name: m[1], detail: m[2] || "" } : null;
}
// A friendlier line under some errors.
export function errorHint(text, { offered = ["numpy", "pandas", "matplotlib"] } = {}) {
  const e = readError(text);
  if (!e) return null;
  if (e.name === "ModuleNotFoundError") {
    const mod = /No module named '([^'.]+)/.exec(e.detail)?.[1];
    if (mod && !offered.includes(mod))
      return `${mod} isn't available here. Python Runner has numpy, pandas, matplotlib and Python's standard library.`;
  }
  if (e.name === "FileNotFoundError") return "The code reads a file it wasn't given. Attach it to the chat, then tick it next to Run.";
  if (e.name === "MemoryError") return "The code ran out of memory. Python Runner allows about 1 GB.";
  if (/No network/.test(text)) return "Python Runner has no network, so code can't download anything.";
  return null;
}

// ---- the worker ----
let worker = null;
let warm = false;
let idle = null;
let current = null;
let seq = 0;
const listeners = new Set();
export const runnerBusy = () => !!current;
export function onRunnerChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
const changed = () => listeners.forEach((fn) => fn());

function shutdown() {
  clearTimeout(idle);
  idle = null;
  worker?.terminate();
  worker = null;
  warm = false;
}
export const pythonWarm = () => warm;

function spawn() {
  const w = new Worker(new URL("./python.worker.js", import.meta.url), {
    type: "module",
    name: "python-runner",
  });
  w.addEventListener("message", (event) => current?.receive(event.data));
  w.addEventListener("error", (event) => {
    event.preventDefault?.();
    current?.receive({ type: "fatal", id: current.id, message: "Python couldn't start in this browser." });
  });
  return w;
}

// Runs `code`. `onEvent` gets every message ({ type: "status" | "running" |
// "out" | "figure" | "truncated" | "figures-dropped" | "done" }) and the
// run ends with one "done": { ok, reason?, value?, ms? }. Returns stop().
export function runPython({ code, files = [], timeout = RUN_TIMEOUT_DEFAULT, onEvent = () => {} }) {
  if (current) current.finish({ type: "done", ok: false, reason: "replaced" }, true);
  clearTimeout(idle);
  const seconds = RUN_TIMEOUTS.includes(timeout) ? timeout : RUN_TIMEOUT_DEFAULT;
  const id = ++seq;
  let timer = null;
  let running = false;
  const run = {
    id,
    receive(msg) {
      if (!msg || msg.id !== id || current !== run) return;
      if (msg.type === "running") {
        if (running) return;
        running = true;
        warm = true;
        clearTimeout(timer);
        timer = setTimeout(() => run.finish({ type: "done", ok: false, reason: "timeout", seconds }, true), seconds * 1000);
        onEvent({ type: "running" });
      } else if (msg.type === "done") {
        if (!running) return;
        const big = msg.memory > 512 * 1024 * 1024;
        run.finish({ type: "done", ok: !!msg.ok, value: typeof msg.value === "string" ? msg.value : null, ms: msg.ms }, big);
      } else if (msg.type === "fatal") {
        run.finish({ type: "done", ok: false, reason: "fatal", message: String(msg.message || "") }, true);
      } else if (msg.type === "out" && (msg.stream === "stdout" || msg.stream === "stderr") && typeof msg.text === "string") {
        onEvent({ type: "out", stream: msg.stream, text: msg.text });
      } else if (msg.type === "figure" && msg.png instanceof Uint8Array) {
        onEvent({ type: "figure", png: msg.png });
      } else if (msg.type === "status" && !running) {
        onEvent({
          type: "status",
          phase: msg.phase === "packages" ? "packages" : "starting",
          packages: Array.isArray(msg.packages) ? msg.packages.filter((p) => typeof p === "string").slice(0, 5) : [],
        });
      } else if (msg.type === "truncated" || msg.type === "figures-dropped") onEvent({ type: msg.type });
    },
    finish(result, kill) {
      if (current !== run) return;
      clearTimeout(timer);
      current = null;
      if (kill) shutdown();
      else idle = setTimeout(shutdown, IDLE_SHUTDOWN_MS);
      onEvent(result);
      changed();
    },
  };
  current = run;
  changed();
  // Downloading and starting Python has its own, longer allowance.
  timer = setTimeout(() => run.finish({ type: "done", ok: false, reason: "load-timeout", seconds: LOAD_TIMEOUT }, true), LOAD_TIMEOUT * 1000);
  try {
    worker ??= spawn();
    const payload = encodeFiles(files);
    worker.postMessage({ type: "run", id, code: String(code), files: payload }, payload.map((f) => f.bytes.buffer));
  } catch {
    run.finish({ type: "done", ok: false, reason: "fatal", message: "Python couldn't start in this browser." }, true);
  }
  return () => run.finish({ type: "done", ok: false, reason: "stopped" }, true);
}

// For tests: shut the worker down now.
export const stopPython = () => {
  current?.finish({ type: "done", ok: false, reason: "stopped" }, true);
  shutdown();
};
