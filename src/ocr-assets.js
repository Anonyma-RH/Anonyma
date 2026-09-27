// Local OCR: where the text reader's files are served from. Constants only,
// shared by vite.config.mjs (which copies the engine into the build) and the
// browser code. Everything is served by ANONYMA itself under /ocr/, never a
// CDN: the app's script-src is 'self', and nobody else learns that someone
// is reading an image. The server gates /ocr/ on the "ocr" update and serves
// it with a year-long cache, so each directory name carries its version:
// upgrading tesseract.js or the language data must change the path.
//
// The engine: tesseract.js and tesseract.js-core, both Apache-2.0, pinned in
// package.json at OCR_ENGINE_VERSION (the build fails if they differ). The
// worker, the core's loader and its .wasm share one directory because the
// core looks for its .wasm next to the worker script.
export const OCR_ENGINE_VERSION = "7.0.0";
export const OCR_ENGINE_PATH = `/ocr/engine-${OCR_ENGINE_VERSION}`;
// [package, file inside it]. Two cores: WebAssembly SIMD where the browser
// has it (every current browser), and the plain build otherwise. Both are
// the LSTM-only builds, which is all the "fast" language data needs.
export const OCR_ENGINE_FILES = [
  ["tesseract.js", "dist/worker.min.js"],
  ["tesseract.js-core", "tesseract-core-simd-lstm.js"],
  ["tesseract.js-core", "tesseract-core-simd-lstm.wasm"],
  ["tesseract.js-core", "tesseract-core-lstm.js"],
  ["tesseract.js-core", "tesseract-core-lstm.wasm"],
];
// The language data: Tesseract's own tessdata_fast 4.1.0 models for English
// and Simplified Chinese (github.com/tesseract-ocr/tessdata_fast, Apache-2.0,
// LICENSE alongside). "fast" is the integer LSTM build: a third of the size
// of "best" at a small cost in accuracy, which suits screenshots. Each file
// is stored gzipped (eng 1.97 MB, chi_sim 1.72 MB, about half their raw
// size) under its plain .traineddata name, because the repository and the
// Docker build leave out *.gz files; tesseract.js checks the gzip header
// and unpacks it either way.
export const OCR_DATA_PATH = "/ocr/tessdata-fast-4.1.0";
export const OCR_DATA_BYTES = { eng: 1967599, chi_sim: 1723376 };
// What the first run downloads besides the language data: the worker
// (0.1 MB) and the SIMD core (2.9 MB), each fetched once and then kept by
// the browser's cache.
export const OCR_ENGINE_BYTES = 111307 + 89271 + 2857601;
