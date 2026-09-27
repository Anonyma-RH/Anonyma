import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { OCR_ENGINE_FILES, OCR_ENGINE_PATH, OCR_ENGINE_VERSION } from "./src/ocr-assets.js";
import { PYODIDE_PATH } from "./src/python-assets.js";
import { pyodideAssets } from "./scripts/pyodide-assets.mjs";

const require = createRequire(import.meta.url);

// Local OCR (src/ocr-assets.js): tesseract.js's worker and its WebAssembly
// core are copied from node_modules into the build under OCR_ENGINE_PATH,
// and served from there by the dev server, so nothing loads from a CDN.
// The pinned packages must match the version in the path.
function ocrEngine() {
  for (const pkg of ["tesseract.js", "tesseract.js-core"]) {
    const { version } = JSON.parse(readFileSync(require.resolve(`${pkg}/package.json`), "utf8"));
    if (version !== OCR_ENGINE_VERSION)
      throw Error(`${pkg} is ${version}; update OCR_ENGINE_VERSION in src/ocr-assets.js to match.`);
  }
  const files = OCR_ENGINE_FILES.map(([pkg, file]) => ({
    name: file.split("/").pop(),
    path: require.resolve(`${pkg}/${file}`),
  }));
  return {
    name: "anonyma-ocr-engine",
    configureServer(server) {
      server.middlewares.use(OCR_ENGINE_PATH, (req, res, next) => {
        const file = files.find((f) => "/" + f.name === req.url.split("?")[0]);
        if (!file) return next();
        res.setHeader("Content-Type", file.name.endsWith(".wasm") ? "application/wasm" : "text/javascript");
        res.end(readFileSync(file.path));
      });
    },
    generateBundle() {
      for (const file of files)
        this.emitFile({
          type: "asset",
          fileName: `${OCR_ENGINE_PATH.slice(1)}/${file.name}`,
          source: readFileSync(file.path),
        });
    },
  };
}

// Python Runner (src/python-assets.js): Pyodide's interpreter from the
// pinned npm package and the checked numpy, pandas and matplotlib wheels
// (scripts/pyodide-assets.mjs), copied into the build under PYODIDE_PATH and
// served from there by the dev server, so nothing loads from a CDN.
const PYODIDE_TYPES = {
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".zip": "application/zip",
};
function pyodideEngine() {
  let assets;
  const load = () => (assets ??= pyodideAssets({ log: (m) => console.log(m) }));
  return {
    name: "anonyma-pyodide",
    configureServer(server) {
      server.middlewares.use(PYODIDE_PATH, (req, res, next) => {
        const name = req.url.split("?")[0].slice(1);
        load().then((list) => {
          const file = list.find((f) => f.name === name);
          if (!file) return next();
          res.setHeader("Content-Type", PYODIDE_TYPES[name.slice(name.lastIndexOf("."))] || "application/octet-stream");
          res.end(file.source ?? readFileSync(file.path));
        }, next);
      });
    },
    async generateBundle() {
      for (const file of await load())
        this.emitFile({
          type: "asset",
          fileName: `${PYODIDE_PATH.slice(1)}/${file.name}`,
          source: file.source ?? readFileSync(file.path),
        });
    },
  };
}

export default defineConfig({
  build: {
    outDir: "dist/client",
    // The walkthrough's Three.js/Lottie chunk is lazy-loaded and knowingly large.
    chunkSizeWarningLimit: 900,
  },
  optimizeDeps: {
    include: ["react", "react-dom/client"],
  },
  server: {
    host: "127.0.0.1",
    port: 5175,
    strictPort: true,
    proxy: {
      "/api": "http://127.0.0.1:3001",
      "/v1": "http://127.0.0.1:3001",
      "/health": "http://127.0.0.1:3001",
      "/llms": "http://127.0.0.1:3001",
      "/cli.mjs": "http://127.0.0.1:3001",
      "/install.sh": "http://127.0.0.1:3001",
      "/install.ps1": "http://127.0.0.1:3001",
      // Live Preview's sandboxed frame page and its headers come from the API.
      "/preview-frame.html": "http://127.0.0.1:3001",
    },
    allowedHosts: ["terminal.local"],
    warmup: {
      clientFiles: ["./src/main.jsx"],
    },
  },
  plugins: [react(), ocrEngine(), pyodideEngine()],
});
