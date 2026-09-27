// Local OCR's engine: tesseract.js in a Web Worker, loaded only when an
// image is read. The library, its worker, its WebAssembly core and the
// language data all come from ANONYMA's own origin (src/ocr-assets.js,
// engineOptions in src/ocr.js); the image never leaves this browser. One
// worker is kept while images are being read and stopped after two idle
// minutes (or at once when a read is cancelled), so its memory is freed.
import { cleanOcrText, engineOptions, ocrLanguage, ocrScale } from "./ocr.js";

// WebAssembly SIMD support: the one-instruction probe module that
// wasm-feature-detect (a tesseract.js dependency) uses.
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253,
  15, 253, 98, 11,
]);
export function hasSimd() {
  try {
    return WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

const IDLE_MS = 120000;
let pending = null, // Promise of the worker
  loaded = "", // the languages it's set up for
  listener = null, // the progress callback of the read in flight
  idle = null;

function start(languages) {
  if (!pending) {
    pending = (async () => {
      const mod = await import("tesseract.js/dist/tesseract.esm.min.js");
      const Tesseract = mod.default || mod;
      const worker = await Tesseract.createWorker(languages, Tesseract.OEM.LSTM_ONLY, {
        ...engineOptions({ simd: hasSimd() }),
        logger: (m) => listener?.(m),
        errorHandler: () => {},
      });
      loaded = languages;
      return worker;
    })();
    pending.catch(() => {
      pending = null;
      loaded = "";
    });
  }
  return pending;
}

// Stops the worker (a read in progress with it) and frees its memory.
export async function stopOcr() {
  clearTimeout(idle);
  const p = pending;
  pending = null;
  loaded = "";
  const worker = await p?.catch(() => null);
  await worker?.terminate().catch(() => {});
}

// An attachment's data: URL as a Blob, decoded here: fetch() can't read a
// data: URL under the app's connect-src.
export function dataUrlBlob(url) {
  const s = String(url || ""),
    comma = s.indexOf(",");
  if (comma < 0 || !/;base64$/i.test(s.slice(0, comma)))
    throw new Error("This image can't be read.");
  const binary = atob(s.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: /^data:([^;,]+)/i.exec(s)?.[1] || "image/png" });
}

// The image, decoded upright and drawn on white (so transparent screenshots
// read as dark on light), enlarged when it's small (ocrScale).
async function prepare(url) {
  const blob = dataUrlBlob(url);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob, { imageOrientation: "from-image" });
  } catch {
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      throw new Error("This image can't be read.");
    }
  }
  const { width, height } = bitmap;
  const scale = ocrScale(width, height);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return { canvas, width, height };
}

const aborted = () => {
  const e = new Error("Cancelled.");
  e.name = "AbortError";
  return e;
};

// Reads the text in an image (an attachment's data: URL) in this browser.
// `onProgress({ stage: "load" | "read", progress })` follows the first-run
// download and the reading. Resolves { text, confidence, width, height }
// with the image's own size; a cancelled read rejects with an AbortError.
export async function readImageText(url, languageId, { onProgress, signal } = {}) {
  if (signal?.aborted) throw aborted();
  const languages = ocrLanguage(languageId).data.join("+");
  clearTimeout(idle);
  const onAbort = () => stopOcr();
  signal?.addEventListener("abort", onAbort, { once: true });
  const cancelled = new Promise((_, reject) =>
    signal?.addEventListener("abort", () => reject(aborted()), { once: true }),
  );
  cancelled.catch(() => {});
  listener = (m) =>
    onProgress?.({
      stage: m.status === "recognizing text" ? "read" : "load",
      progress: Math.max(0, Math.min(1, Number(m.progress) || 0)),
    });
  try {
    const work = (async () => {
      const [worker, image] = await Promise.all([start(languages), prepare(url)]);
      if (loaded !== languages) {
        await worker.reinitialize(languages, 1);
        loaded = languages;
      }
      const { data } = await worker.recognize(image.canvas);
      return {
        text: cleanOcrText(data.text),
        confidence: Number(data.confidence) || 0,
        width: image.width,
        height: image.height,
      };
    })();
    // A read cut short by Cancel may still settle later; nothing waits on it.
    work.catch(() => {});
    return await Promise.race([work, cancelled]);
  } finally {
    listener = null;
    signal?.removeEventListener("abort", onAbort);
    if (pending) idle = setTimeout(stopOcr, IDLE_MS);
  }
}
