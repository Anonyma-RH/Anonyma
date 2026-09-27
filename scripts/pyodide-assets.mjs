// Python Runner's files for the build (vite.config.mjs): Pyodide's
// interpreter from the pinned npm package, and the numpy, pandas and
// matplotlib wheels it needs, all served by ANONYMA under PYODIDE_PATH.
//
// The npm package carries only the interpreter. The wheels are Pyodide's own
// builds of the same release, fetched once from its CDN (the address
// Pyodide itself loads them from by default), each checked against the
// SHA-256 pinned in src/python-assets.js, which must also be the one in the
// package's own pyodide-lock.json. They're kept in node_modules/.cache, so a
// build after the first needs no network, and nothing is committed. A
// missing or altered wheel stops the build.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import {
  PYODIDE_CORE_FILES,
  PYODIDE_LOCK_FILE,
  PYODIDE_NOTICE_FILE,
  PYODIDE_VERSION,
  PYODIDE_WHEELS,
  PYTHON_PACKAGES,
} from "../src/python-assets.js";

const require = createRequire(import.meta.url);
export const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

// Pyodide and the packages' licences, served next to them.
export const PYODIDE_NOTICE = `Python Runner runs Python in your browser with these unmodified files.

Pyodide ${PYODIDE_VERSION} (pyodide.mjs, pyodide.asm.mjs, pyodide.asm.wasm)
  Mozilla Public License 2.0. Source: https://github.com/pyodide/pyodide/tree/${PYODIDE_VERSION}
CPython 3.14 and its standard library (python_stdlib.zip)
  Python Software Foundation License. Source: https://github.com/python/cpython
numpy: BSD 3-Clause. https://github.com/numpy/numpy
pandas: BSD 3-Clause. https://github.com/pandas-dev/pandas
matplotlib: Matplotlib License (PSF-based). https://github.com/matplotlib/matplotlib
contourpy, cycler, kiwisolver: BSD 3-Clause.
fonttools, pyparsing, pytz, six: MIT.
pillow: MIT-CMU (HPND).
packaging: Apache 2.0 or BSD 2-Clause.
python-dateutil: Apache 2.0 or BSD 3-Clause.

The wheels are Pyodide's own builds for release ${PYODIDE_VERSION}; their build
recipes are in the Pyodide repository above.
`;

export function pyodidePackageDir() {
  return dirname(require.resolve("pyodide/package.json"));
}

// The package's lock, checked against the pins: every wheel the offered
// packages need is pinned, with the same file and hash, and nothing else.
export function checkedLock() {
  const dir = pyodidePackageDir();
  const { version } = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  if (version !== PYODIDE_VERSION)
    throw Error(`pyodide is ${version}; update PYODIDE_VERSION and the wheels in src/python-assets.js to match.`);
  const lock = JSON.parse(readFileSync(join(dir, "pyodide-lock.json"), "utf8"));
  const needed = new Set();
  const walk = (name) => {
    const key = name.toLowerCase();
    if (needed.has(key)) return;
    const entry = lock.packages[key];
    if (!entry) throw Error(`pyodide-lock.json has no package ${name}.`);
    needed.add(key);
    entry.depends.forEach(walk);
  };
  PYTHON_PACKAGES.forEach(walk);
  const pinned = PYODIDE_WHEELS.map((w) => w.name);
  if ([...needed].sort().join() !== [...pinned].sort().join())
    throw Error(`The offered packages need ${[...needed].sort().join(", ")}; src/python-assets.js pins ${pinned.sort().join(", ")}.`);
  for (const w of PYODIDE_WHEELS) {
    const entry = lock.packages[w.name];
    if (entry.file_name !== w.file || entry.sha256 !== w.sha256)
      throw Error(`${w.name}: the pin in src/python-assets.js differs from pyodide-lock.json.`);
  }
  // The served lock lists only the pinned wheels, so an import of anything
  // else is an ordinary ModuleNotFoundError rather than a failed download.
  const trimmed = {
    ...lock,
    packages: Object.fromEntries(PYODIDE_WHEELS.map((w) => [w.name, lock.packages[w.name]])),
  };
  return { dir, trimmed };
}

async function download(url, attempts = 3) {
  let last;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: "follow" });
      if (!r.ok) throw Error(`HTTP ${r.status}`);
      return Buffer.from(await r.arrayBuffer());
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw last;
}

// The wheels, from the cache or fetched once into it, each checked.
export async function wheelFiles({ cacheDir, log = () => {} } = {}) {
  const dir = cacheDir || join(process.cwd(), "node_modules", ".cache", "anonyma-pyodide", PYODIDE_VERSION);
  mkdirSync(dir, { recursive: true });
  const files = [];
  for (const w of PYODIDE_WHEELS) {
    const path = join(dir, w.file);
    let ok = existsSync(path) && sha256(readFileSync(path)) === w.sha256;
    if (!ok) {
      log(`Fetching ${w.file} from Pyodide's distribution…`);
      const buf = await download(PYODIDE_CDN + w.file);
      if (sha256(buf) !== w.sha256 || buf.length !== w.bytes)
        throw Error(`${w.file} doesn't match its pinned SHA-256; not using it.`);
      writeFileSync(path + ".part", buf);
      renameSync(path + ".part", path);
    }
    files.push({ name: w.file, path });
  }
  return files;
}

// Everything served under PYODIDE_PATH: [{ name, path } | { name, source }].
export async function pyodideAssets(options = {}) {
  const { dir, trimmed } = checkedLock();
  return [
    ...PYODIDE_CORE_FILES.map((name) => ({ name, path: join(dir, name) })),
    { name: PYODIDE_LOCK_FILE, source: JSON.stringify(trimmed) },
    { name: PYODIDE_NOTICE_FILE, source: PYODIDE_NOTICE },
    ...(await wheelFiles(options)),
  ];
}
