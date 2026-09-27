// Python Runner: where Python's files are served from, and the limits a run
// works under. Constants only, shared by vite.config.mjs and
// scripts/pyodide-assets.mjs (which put the files into the build), the
// server (which gates and serves them) and the browser code.
//
// Python is Pyodide (CPython compiled to WebAssembly), MPL-2.0, pinned in
// package.json at PYODIDE_VERSION; the build fails if the installed version
// differs. Everything is served by ANONYMA itself under /pyodide/, never a
// CDN: the app's script-src is 'self', and nobody else learns that someone
// is running code. The server gates /pyodide/ on the "python" update and
// serves it with a year-long cache, so the directory name carries the
// version: upgrading Pyodide must change the path.
export const PYODIDE_VERSION = "314.0.7";
export const PYODIDE_PATH = `/pyodide/${PYODIDE_VERSION}`;
// From the npm package, copied as they are. pyodide-lock.json is written by
// the build instead: the package's own list, cut down to the wheels below.
export const PYODIDE_CORE_FILES = [
  "pyodide.mjs",
  "pyodide.asm.mjs",
  "pyodide.asm.wasm",
  "python_stdlib.zip",
];
export const PYODIDE_LOCK_FILE = "pyodide-lock.json";
export const PYODIDE_NOTICE_FILE = "LICENSES.txt";
// What the first run downloads: the interpreter and the standard library.
export const PYODIDE_CORE_BYTES = 17931 + 1250344 + 9598218 + 2545637;

// The packages offered, and the wheels they need, from Pyodide's own build
// of this release. The npm package carries only the interpreter, so the
// build fetches these once from Pyodide's own distribution
// (scripts/pyodide-assets.mjs), checks each against the SHA-256 below (the
// same one the package's pyodide-lock.json lists), and keeps them in
// node_modules/.cache; nothing is committed. In the browser
// Pyodide checks each wheel against the same hash again (subresource
// integrity) before installing it. Listed in install order.
export const PYTHON_PACKAGES = ["numpy", "pandas", "matplotlib"];
export const PYODIDE_WHEELS = [
  { name: "numpy", file: "numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl", sha256: "a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf", bytes: 2960568 },
  { name: "six", file: "six-1.17.0-py2.py3-none-any.whl", sha256: "228c50f73aa7addf2c2ccf2979c256802a59ab69cad8152b31b9443cc8140f42", bytes: 11050 },
  { name: "python-dateutil", file: "python_dateutil-2.9.0.post0-py2.py3-none-any.whl", sha256: "9b13365edf9c188f570baf9c540bbb3029ada2a2dacb9694b3659941693ee9e5", bytes: 229892 },
  { name: "pytz", file: "pytz-2026.1.post1-py2.py3-none-any.whl", sha256: "b8249d6450146e0b61e6d710dc02ebb35a904796c4c2f97fe87d4ac5872db36a", bytes: 510489 },
  { name: "pandas", file: "pandas-3.0.2-cp314-cp314-pyemscripten_2026_0_wasm32.whl", sha256: "45ff57772cc2f366a8582c7d3097cc4e6676342ecd5a3c08184a43462d5a02ae", bytes: 4177749 },
  { name: "contourpy", file: "contourpy-1.3.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl", sha256: "0ac15ebf9f820d2d1c3526388aa2818b631cb6c4aae1682efd6b4cc12c1f302c", bytes: 118874 },
  { name: "cycler", file: "cycler-0.12.1-py3-none-any.whl", sha256: "8ee450085f15b47f78b034d60059af6a3649e98fa5dde073363437742cc0b4ea", bytes: 8321 },
  { name: "fonttools", file: "fonttools-4.62.1-py3-none-any.whl", sha256: "0d1516e073fd0a8d8e6d9af46417b6a26209a42518024a18f7085e72d2599605", bytes: 1152647 },
  { name: "kiwisolver", file: "kiwisolver-1.5.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl", sha256: "47781998156721147c128a3c74547d5703e0e3cc454d8203e629339368308a93", bytes: 36616 },
  { name: "packaging", file: "packaging-26.1-py3-none-any.whl", sha256: "565acbbea54da30348b6d68b6a54373e6f777987db9f1db6966b4b3a5060d303", bytes: 95852 },
  { name: "pillow", file: "pillow-12.2.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl", sha256: "e29838b7a756e4ee0f27a9cfa9a387ee0dfa2e9dd44be2dd595130b9f9d93ac3", bytes: 1037806 },
  { name: "pyparsing", file: "pyparsing-3.3.2-py3-none-any.whl", sha256: "f0dd8225b5f8e945980b400bd465b4b90cb0498a2eede0d9dbea98372f6110c5", bytes: 122781 },
  { name: "matplotlib", file: "matplotlib-3.10.8-cp314-cp314-pyemscripten_2026_0_wasm32.whl", sha256: "722857932f8f62eac64f8439af15c94d427f9fb945f9590cd242805c983d2d54", bytes: 6982033 },
];
// Every file under PYODIDE_PATH. The worker's fetch reaches these and
// nothing else.
export const PYODIDE_FILES = [
  ...PYODIDE_CORE_FILES,
  PYODIDE_LOCK_FILE,
  ...PYODIDE_WHEELS.map((w) => w.file),
];

// The limits a run works under.
export const RUN_TIMEOUTS = [30, 60, 120];
export const RUN_TIMEOUT_DEFAULT = 30;
// Downloading and starting Python (first run on a slow line) has its own,
// longer allowance; the run's own clock starts when the code does.
export const LOAD_TIMEOUT = 180;
// Best effort: WebAssembly memory can't grow past this (MemoryError).
export const MEMORY_CAP_MB = 1024;
// What comes back to the page: at most this much printed text, figures and
// figure size. More is dropped, and the panel says so.
export const MAX_OUTPUT_CHARS = 200000;
export const MAX_FIGURES = 12;
export const MAX_FIGURE_BYTES = 4 * 1024 * 1024;
// A file mounted for the code (Use my attached CSV): at most this size.
export const MAX_MOUNT_BYTES = 10 * 1024 * 1024;
// An idle Python is shut down after this long, to give its memory back.
export const IDLE_SHUTDOWN_MS = 5 * 60 * 1000;

// The worker script's own Content-Security-Policy, sent with it by the
// server (server/routes/site.js). Browsers that apply a worker's own policy
// (current Chrome, Edge and Firefox) let it load and fetch only Pyodide's
// files, nothing else on this origin or any other; the worker also removes
// its network and storage APIs itself (src/python.worker.js). The app's own
// policy (src/security-headers.js) is unchanged.
export function pythonWorkerCsp(origin) {
  const base = `${String(origin).replace(/\/$/, "")}/pyodide/`;
  return [
    "default-src 'none'",
    `script-src ${base} 'wasm-unsafe-eval'`,
    `connect-src ${base}`,
    "base-uri 'none'",
  ].join("; ");
}
// The worker's built file name, as Vite emits it (assets/python.worker-<hash>.js).
export const PYTHON_WORKER_FILE = /\/assets\/python\.worker-[\w-]+\.js$/;

