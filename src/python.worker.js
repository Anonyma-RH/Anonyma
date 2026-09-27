// Python Runner's worker: Python (Pyodide) runs here, off the page, in this
// browser. The page sends code and any files the person chose to give it;
// what comes back is printed text, figures as PNG bytes and a status. The
// page stops a run by terminating this worker (src/python-runner.js).
//
// No network. Before anything else runs (Pyodide included), this worker
// removes its own ways out: fetch reaches only Pyodide's own files under
// PYODIDE_PATH, by exact name, without cookies; XMLHttpRequest, WebSocket,
// EventSource, WebTransport, nested workers, importScripts, fonts and
// BroadcastChannel are replaced with stubs that refuse; IndexedDB, the Cache
// API and navigator.storage (this site's saved data) are gone. The server
// also sends this script its own Content-Security-Policy, which limits it to
// the same files where the browser applies a worker's own policy
// (src/python-assets.js, pythonWorkerCsp). Python's `js` module sees only a
// few timer functions, not this worker's globals.
import {
  MAX_FIGURE_BYTES,
  MAX_FIGURES,
  MAX_MOUNT_BYTES,
  MAX_OUTPUT_CHARS,
  MEMORY_CAP_MB,
  PYODIDE_FILES,
  PYODIDE_LOCK_FILE,
  PYODIDE_PATH,
} from "./python-assets.js";

const NO_NETWORK =
  "No network: code in Python Runner can't reach the internet, ANONYMA or this site's saved data.";
const INDEX = new URL(PYODIDE_PATH + "/", self.location.origin).href;
const ALLOWED = new Set(PYODIDE_FILES.map((f) => INDEX + f));

// ---- 1. Lock down, before anything else -------------------------------------
const nativeFetch = self.fetch;
const refuse = () => {
  throw new Error(NO_NETWORK);
};
function Blocked() {
  throw new Error(NO_NETWORK);
}
function guardedFetch(input, init) {
  let url;
  try {
    url = new URL(typeof input === "object" && input && "url" in input ? input.url : String(input), INDEX);
  } catch {
    return Promise.reject(new TypeError(NO_NETWORK));
  }
  if (!ALLOWED.has(url.href)) return Promise.reject(new TypeError(NO_NETWORK));
  const integrity = typeof init?.integrity === "string" ? init.integrity : undefined;
  return nativeFetch.call(self, url.href, {
    method: "GET",
    credentials: "omit",
    mode: "same-origin",
    redirect: "error",
    referrerPolicy: "no-referrer",
    ...(integrity ? { integrity } : {}),
  });
}
// Removes `name` from an object and everything it inherits from, then pins
// `value` in its place. Fails loudly if the browser won't let go of it.
function pin(target, name, value) {
  for (let o = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, name);
    if (d && !delete o[name]) throw Error(`Couldn't remove ${name}.`);
  }
  Object.defineProperty(target, name, { value, writable: false, configurable: false, enumerable: false });
  if (target[name] !== value) throw Error(`Couldn't replace ${name}.`);
}
const GONE = [
  // Network.
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "EventSource",
  "WebTransport",
  "RTCPeerConnection",
  "webkitRTCPeerConnection",
  "RTCDataChannel",
  "FontFace",
  // Other contexts on this origin.
  "Worker",
  "SharedWorker",
  "BroadcastChannel",
  "Notification",
];
const EMPTY = ["indexedDB", "caches", "fonts", "cookieStore", "webkitRequestFileSystem", "requestFileSystem"];
const NAVIGATOR = ["storage", "serviceWorker", "locks", "usb", "hid", "serial", "bluetooth", "sendBeacon", "permissions"];
let lockdownError = null;
try {
  pin(self, "fetch", guardedFetch);
  // Not a TypeError, so Pyodide doesn't retry the script with import().
  pin(self, "importScripts", refuse);
  for (const name of GONE) pin(self, name, Blocked);
  for (const name of EMPTY) pin(self, name, undefined);
  for (const name of NAVIGATOR) pin(self.navigator, name, undefined);
  // Memory, best effort: WebAssembly memory can't grow past the cap, so
  // Python raises MemoryError instead of taking the tab down.
  const cap = MEMORY_CAP_MB * 1024 * 1024;
  const grow = WebAssembly.Memory.prototype.grow;
  pin(WebAssembly.Memory.prototype, "grow", function (delta) {
    if (this.buffer.byteLength + Number(delta) * 65536 > cap)
      throw new RangeError(`Python Runner's memory limit (${MEMORY_CAP_MB} MB) was reached.`);
    return grow.call(this, delta);
  });
} catch (e) {
  lockdownError = e;
}

// ---- 2. Talking to the page -------------------------------------------------
let runId = null;
const post = (message, transfer) => self.postMessage({ ...message, id: runId }, transfer || []);

// Printed text goes back in batches, in the order it was printed, never
// more than MAX_OUTPUT_CHARS a run.
let sent = 0,
  pending = [],
  pendingChars = 0,
  lastFlush = 0,
  truncated = false;
const decoders = {};
function flush() {
  for (const chunk of pending) post({ type: "out", stream: chunk.stream, text: chunk.text });
  pending = [];
  pendingChars = 0;
  lastFlush = performance.now();
}
function write(stream, text) {
  if (truncated || !text) return;
  const room = MAX_OUTPUT_CHARS - sent;
  if (text.length > room) {
    text = text.slice(0, room);
    truncated = true;
  }
  sent += text.length;
  const last = pending.at(-1);
  if (last && last.stream === stream) last.text += text;
  else pending.push({ stream, text });
  pendingChars += text.length;
  if (truncated) {
    flush();
    post({ type: "truncated" });
  } else if (pendingChars > 16384 || performance.now() - lastFlush > 60) flush();
}
const writer = (stream) => ({
  write(bytes) {
    decoders[stream] ??= new TextDecoder();
    write(stream, decoders[stream].decode(bytes, { stream: true }));
    return bytes.length;
  },
});

// ---- 3. Python --------------------------------------------------------------
// The runner's own Python: a fresh namespace and home folder per run, tidy
// tracebacks, the last expression's value, matplotlib figures as PNGs, no
// keyboard input and no network.
const RUNNER = String.raw`
import builtins, io, linecache, os, shutil, sys, traceback
from pyodide.code import eval_code_async
from pyodide.ffi import to_js

NO_NETWORK = ${JSON.stringify(NO_NETWORK)}
HOME = "/home/pyodide"
FILENAME = "<python>"

def _no_input(*args, **kwargs):
    raise EOFError("input() isn't available here: Python Runner has no keyboard input.")

def _no_network(*args, **kwargs):
    raise OSError(NO_NETWORK)

async def _no_network_async(*args, **kwargs):
    raise OSError(NO_NETWORK)

try:
    import pyodide.http as _http
    import pyodide.http._pyfetch as _pyfetch
    import pyodide.http.pyxhr as _pyxhr
    _http.pyfetch = _pyfetch.pyfetch = _no_network_async
    _http.open_url = _no_network
    for _name in ("get", "post", "put", "delete", "head", "patch", "options", "_xhr_request"):
        setattr(_pyxhr, _name, _no_network)
except Exception:
    pass

builtins.input = _no_input
_builtins = dict(builtins.__dict__)

def reset():
    for name in list(builtins.__dict__):
        if name not in _builtins:
            del builtins.__dict__[name]
    builtins.__dict__.update(_builtins)
    os.chdir("/")
    for place in (HOME, "/tmp"):
        shutil.rmtree(place, ignore_errors=True)
        os.makedirs(place, exist_ok=True)
    os.chdir(HOME)
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        plt.close("all")

def _send_figures(emit):
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return
    for num in plt.get_fignums():
        fig = plt.figure(num)
        buf = io.BytesIO()
        fig.savefig(buf, format="png", dpi=120, bbox_inches="tight", facecolor="white")
        emit(to_js(buf.getvalue()))
    plt.close("all")

def prepare_matplotlib(emit):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    def show(*args, **kwargs):
        _send_figures(emit)
    plt.show = show

def _user_traceback(e):
    tb = e.__traceback__
    while tb is not None and tb.tb_frame.f_code.co_filename != FILENAME:
        tb = tb.tb_next
    return "".join(traceback.format_exception(type(e), e, tb))

async def run(code, emit):
    linecache.cache[FILENAME] = (len(code), None, code.splitlines(True), FILENAME)
    namespace = {"__name__": "__main__", "__builtins__": builtins}
    ok, value = True, None
    try:
        result = await eval_code_async(code, namespace, filename=FILENAME)
        if result is not None:
            value = repr(result)
            if len(value) > 20000:
                value = value[:20000] + " …"
    except SystemExit as e:
        if e.code not in (None, 0):
            ok = False
            print(f"SystemExit: {e.code}", file=sys.stderr)
    except BaseException as e:
        ok = False
        print(_user_traceback(e), file=sys.stderr, end="")
    try:
        _send_figures(emit)
    except Exception as e:
        print(f"Couldn't draw a figure: {e}", file=sys.stderr)
    sys.stdout.flush()
    sys.stderr.flush()
    return ok, value
`;

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
let figures = 0;
function sendFigure(bytes) {
  if (!(bytes instanceof Uint8Array)) return;
  figures++;
  if (figures > MAX_FIGURES) {
    if (figures === MAX_FIGURES + 1) post({ type: "figures-dropped" });
    return;
  }
  // A PNG, and not too big; anything else is dropped.
  if (bytes.length > MAX_FIGURE_BYTES || PNG.some((b, i) => bytes[i] !== b)) return;
  flush();
  const copy = bytes.slice();
  post({ type: "figure", png: copy }, [copy.buffer]);
}

let py = null,
  runner = null,
  starting = null;
async function start() {
  if (lockdownError) throw lockdownError;
  post({ type: "status", phase: "starting" });
  const { loadPyodide } = await import(/* @vite-ignore */ INDEX + "pyodide.mjs");
  const api = await loadPyodide({
    indexURL: INDEX,
    lockFileURL: INDEX + PYODIDE_LOCK_FILE,
    // What Python's `js` module can see: timers and a few plain types,
    // not this worker's globals.
    jsglobals: {
      setTimeout: self.setTimeout.bind(self),
      clearTimeout: self.clearTimeout.bind(self),
      setInterval: self.setInterval.bind(self),
      clearInterval: self.clearInterval.bind(self),
      Object,
      Array,
      Date,
      WeakRef,
      Uint8Array,
    },
    env: { HOME: "/home/pyodide", MPLBACKEND: "Agg" },
  });
  api.setStdout(writer("stdout"));
  api.setStderr(writer("stderr"));
  api.setStdin({ error: true });
  const ns = api.toPy({});
  api.runPython(RUNNER, { globals: ns, filename: "<runner>" });
  runner = ns;
  py = api;
}

// What the code imports from the packages offered (the import names of the
// pinned wheels). pandas plots through matplotlib.
const OFFERED = ["numpy", "pandas", "matplotlib", "mpl_toolkits", "pylab", "PIL", "dateutil", "pytz", "six", "contourpy", "cycler", "fontTools", "kiwisolver", "packaging", "pyparsing"];
function packagesFor(code) {
  const found = new Set();
  let imports = null;
  try {
    imports = py.pyimport("pyodide.code").find_imports(code);
    for (const name of imports.toJs()) found.add(String(name).split(".")[0]);
  } catch {
    // A syntax error: Python reports it when the code runs.
  } finally {
    imports?.destroy?.();
  }
  if (found.has("pylab") || found.has("mpl_toolkits")) found.add("matplotlib");
  if (found.has("pandas") && /\.(plot|hist|boxplot)\s*[(.]/.test(code)) found.add("matplotlib");
  return OFFERED.filter((n) => found.has(n));
}

async function run({ code, files = [] }) {
  sent = 0;
  pending = [];
  pendingChars = 0;
  truncated = false;
  figures = 0;
  const started = performance.now();
  if (!py) {
    starting ??= start();
    await starting;
  }
  // Only what the code imports is loaded: from ANONYMA, each wheel checked
  // against its pinned hash.
  const packages = packagesFor(code);
  if (packages.length) {
    post({ type: "status", phase: "packages", packages: packages.filter((n) => ["numpy", "pandas", "matplotlib"].includes(n)) });
    await py.loadPackagesFromImports(packages.map((n) => `import ${n}`).join("\n"), {
      messageCallback: () => {},
      errorCallback: (m) => write("stderr", String(m) + "\n"),
    });
  }
  const reset = runner.get("reset");
  const fn = runner.get("run");
  const prepare = runner.get("prepare_matplotlib");
  try {
    reset();
    // Files the person chose to give this run, in its home folder.
    for (const f of files) {
      const name = String(f?.name || "").split(/[\\/]/).pop();
      if (!/^\w[\w .()-]{0,120}$/.test(name) || !(f.bytes instanceof Uint8Array) || f.bytes.length > MAX_MOUNT_BYTES) continue;
      py.FS.writeFile(`/home/pyodide/${name}`, f.bytes);
    }
    if (packages.includes("matplotlib")) prepare(sendFigure);
    post({ type: "running", loadMs: Math.round(performance.now() - started) });
    const t0 = performance.now();
    const result = await fn(code, sendFigure);
    let ok = true,
      value = null;
    try {
      [ok, value] = result.toJs();
    } finally {
      result.destroy?.();
    }
    flush();
    post({
      type: "done",
      ok: !!ok,
      value: typeof value === "string" ? value : null,
      ms: Math.round(performance.now() - t0),
      memory: py._module?.HEAPU8?.buffer?.byteLength || 0,
    });
  } finally {
    reset.destroy?.();
    fn.destroy?.();
    prepare.destroy?.();
  }
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "run" || typeof data.code !== "string") return;
  runId = data.id;
  run(data).catch((e) => {
    flush();
    post({ type: "fatal", message: String(e?.message || e).slice(0, 2000) });
  });
});
