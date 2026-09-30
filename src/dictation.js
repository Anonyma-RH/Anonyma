// Private Dictation: speech to text on this device, for free. OpenAI's
// Whisper runs in the browser with Transformers.js, in a worker
// (src/dictation.worker.js, loaded only when someone dictates), on WebGPU
// where the browser has it and on the processor otherwise.
//
// Nothing about a recording touches ANONYMA's server or anyone else: the
// audio is decoded, transcribed and dropped in this browser, and the text
// lands in the composer for the person to review. The only network traffic
// is the one-time download of the model's files, straight from Hugging Face
// at a pinned revision and checked against pinned SHA-256 hashes, and of the
// speech engine from ANONYMA itself. The browser keeps both until the person
// removes them (the engine as an ordinary cached site file).
//
// Pure helpers only (no React, no Transformers.js), so tests run them in Node.

import { isReleased } from "./lib.js";

export const dictationReleased = (config) => isReleased(config, "dictation");

// ---- The engine ----
// Transformers.js (@huggingface/transformers, Apache-2.0) on ONNX Runtime
// Web (onnxruntime-web, MIT), both pinned in package.json. Their JavaScript
// is bundled into the worker's own chunk. ONNX Runtime's one WebAssembly
// binary (the build Transformers.js' WebGPU entry expects, which also runs on
// the processor) is a Vite build asset from node_modules, served by ANONYMA
// with the other fingerprinted assets, never from a CDN: the app's
// script-src is 'self', and nobody else learns that someone is dictating.
//
// Transformers.js also lists two Node-only backends as dependencies:
// onnxruntime-node (about 300 MB of native binaries, whose install script
// downloads CUDA libraries from NuGet on Linux) and sharp (whose libvips
// binary is LGPL). The browser build never imports either, so package.json's
// "overrides" replace both with onnxruntime-common, a small pure-JavaScript
// package from the ONNX Runtime project (tests/private-dictation.test.mjs
// keeps it that way).
export const DICTATION_ENGINE_VERSION = "1.31.0-dev.20260914-8d85527a0";
export const DICTATION_ENGINE_FILE = "ort-wasm-simd-threaded.asyncify.wasm";
// What the first use downloads from ANONYMA besides the model.
export const DICTATION_ENGINE_BYTES = 26861777;

// ---- The models ----
// Whisper (OpenAI, MIT) converted to ONNX for Transformers.js by its author
// (Apache-2.0), multilingual. Each is pinned to one Hugging Face commit, and
// every file the engine reads is listed with its SHA-256 and size: a file
// that doesn't match is refused before the engine sees it
// (createPinnedFetch). Hashes were taken from the files at these commits and
// match Hugging Face's own LFS records.
//
// Two builds of each, of which a device downloads one: 4-bit weights with
// 16-bit maths ("q4f16") for graphics processors with WebGPU's shader-f16
// feature, several times faster there; and 8-bit weights ("q8") for the
// processor (WebAssembly), everywhere else.
export const HF_ORIGIN = "https://huggingface.co";
export const DICTATION_CACHE = "anonyma-dictation";
export const BUILDS = {
  gpu: { dtype: "q4f16", device: "webgpu" },
  cpu: { dtype: "q8", device: "wasm" },
};
const COMMON = [
  { path: "preprocessor_config.json", bytes: 339, sha256: "a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d" },
  { path: "tokenizer.json", bytes: 2480466, sha256: "27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566" },
  { path: "tokenizer_config.json", bytes: 282683, sha256: "2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce" },
];
export const DICTATION_MODELS = [
  {
    key: "tiny",
    name: "Whisper tiny",
    note: "Fastest. Fine for short, clear dictation.",
    repo: "Xenova/whisper-tiny",
    rev: "5332fcc35e32a33b86612b9a57a89be7906102b1",
    common: [
      { path: "config.json", bytes: 2248, sha256: "2b2e4e519084e0ea028b19b153f95202735a971870d6844aa26e559edd292e94" },
      { path: "generation_config.json", bytes: 3716, sha256: "68ac791fcb4999461a313472125042934656240ba1cba7d1c2627fcbb19ac24c" },
      ...COMMON,
    ],
    builds: {
      gpu: [
        { path: "onnx/encoder_model_q4f16.onnx", bytes: 6303086, sha256: "fd605566b1dc81d05e378df6e782b3525a66b6efd52916c618ff301573577949" },
        { path: "onnx/decoder_model_merged_q4f16.onnx", bytes: 46041144, sha256: "dc59a0cad1aa37442390f2b3cf9696868e38a570a23901c4efacde71b6690e98" },
      ],
      cpu: [
        { path: "onnx/encoder_model_quantized.onnx", bytes: 10124910, sha256: "fd9d995b9dcb0520f0dbf6cf68651af639fc385f594d9d876e69ca2802dc438e" },
        { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 30727765, sha256: "6c0c125986b007d2e3734bec84c18bda0152071b90b87fadac6d7764499927a0" },
      ],
    },
  },
  {
    key: "base",
    name: "Whisper base",
    note: "More accurate, especially with accents and other languages. Slower.",
    repo: "Xenova/whisper-base",
    rev: "64da57285918e20ea79ea5c88eed7197933abaa8",
    common: [
      { path: "config.json", bytes: 2248, sha256: "d1d347fdb422e6347c2f843a90d375aa67ea3f4b3e20d2c3075f9a9f6243685b" },
      { path: "generation_config.json", bytes: 3776, sha256: "3bba359e33fdd6dc1c10f71846a477d339b0242f462f70ea1dd73274caa38d05" },
      ...COMMON,
    ],
    builds: {
      gpu: [
        { path: "onnx/encoder_model_q4f16.onnx", bytes: 14138124, sha256: "9205a07a3040b786fafc6d8b9afe4339f6acaefb561b51f660ec5327ef4147b8" },
        { path: "onnx/decoder_model_merged_q4f16.onnx", bytes: 68573265, sha256: "aadeadbecc79bee3287cb34f0b37c768a0ddfd243c3367f209e446d9e3ae4c4a" },
      ],
      cpu: [
        { path: "onnx/encoder_model_quantized.onnx", bytes: 23200850, sha256: "3e345e977b55620a37c0c2b2af0644e019afdfad562dcf71eb929bb7274285f9" },
        { path: "onnx/decoder_model_merged_quantized.onnx", bytes: 53707539, sha256: "a6beb6baabb66f00b6a686d828c95ffca6146d51900cbad0266cad38f64cf861" },
      ],
    },
  },
];
export const DEFAULT_DICTATION_MODEL = "tiny";
export const dictationModel = (key) => DICTATION_MODELS.find((m) => m.key === key) || null;
export const LICENCE_LINE =
  "Whisper is by OpenAI (MIT licence); these ONNX builds are Apache-2.0. The engine is Transformers.js (Apache-2.0) on ONNX Runtime (MIT).";

// Where Transformers.js asks for a model's files: a fixed commit, never "main".
export const modelBase = (model) => `${HF_ORIGIN}/${model.repo}/resolve/${model.rev}/`;
export const modelUrl = (model, path) => modelBase(model) + path;
// Every file of one build, and what it downloads.
export const buildFiles = (model, build) => [...model.common, ...(model.builds[build] || [])];
export const buildBytes = (model, build) => buildFiles(model, build).reduce((n, f) => n + f.bytes, 0);

// Every pinned file, by URL.
export function pinnedFiles(models = DICTATION_MODELS) {
  const map = new Map();
  for (const m of models)
    for (const f of [...m.common, ...Object.values(m.builds).flat()]) map.set(modelUrl(m, f.path), { ...f, model: m.key });
  return map;
}

// Which build this device runs: the WebGPU one where the graphics processor
// has shader-f16, the processor one otherwise. `nav` is navigator, or a
// stand-in in tests.
export async function detectDictationBuild(nav = globalThis.navigator) {
  try {
    const adapter = await nav?.gpu?.requestAdapter?.();
    return adapter?.features?.has?.("shader-f16") ? "gpu" : "cpu";
  } catch {
    return "cpu";
  }
}

// ---- Fetching the pinned files ----
const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
export async function sha256Hex(bytes, subtle = globalThis.crypto?.subtle) {
  return hex(await subtle.digest("SHA-256", bytes));
}
export class PinnedFileError extends Error {
  constructor(message, name = "IntegrityError") {
    super(message);
    this.name = name;
  }
}
const isHuggingFace = (url) => url.protocol === "https:" && (url.hostname === "huggingface.co" || url.hostname === "hf.co");
const requestUrl = (input) => (typeof input === "string" ? input : input instanceof URL ? input.href : input?.url);
const headerOf = (init, input, name) => {
  const h = init?.headers ?? input?.headers;
  if (!h) return null;
  if (typeof h.get === "function") return h.get(name);
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase());
  return k ? h[k] : null;
};
const fileResponse = (bytes, status = 200, extra = {}) =>
  new Response(bytes, {
    status,
    headers: { "content-type": "application/octet-stream", "content-length": String(bytes.byteLength), ...extra },
  });
async function readAll(res, total, onChunk) {
  if (!res.body?.getReader) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const out = new Uint8Array(total);
  let at = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (at + value.byteLength > total) {
      reader.cancel().catch(() => {});
      throw new PinnedFileError("A downloaded file was larger than expected, so it wasn't used.");
    }
    out.set(value, at);
    at += value.byteLength;
    onChunk?.(at);
  }
  return at === total ? out : out.subarray(0, at);
}

// The only way the engine reaches the network (Transformers.js' env.fetch,
// and the worker's own fetch). Pinned model files are served from this
// browser's Cache Storage or downloaded once from Hugging Face, without
// cookies or a referrer, and handed over only when their size and SHA-256
// match; then they're kept. Transformers.js' "is this file there?" probes
// (a GET for byte 0) are answered from the pinned list, and any other file it
// asks Hugging Face for is a 404, both without a request. Everything else is
// refused. `onProgress({ url, loaded, total })` follows downloads.
export function createPinnedFetch({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  cachesApi = globalThis.caches,
  subtle = globalThis.crypto?.subtle,
  files = pinnedFiles(),
  onProgress,
} = {}) {
  const openCache = async () => {
    try {
      return cachesApi ? await cachesApi.open(DICTATION_CACHE) : null;
    } catch {
      return null;
    }
  };
  return async function pinnedFetch(input, init = {}) {
    let url;
    try {
      url = new URL(requestUrl(input));
    } catch {
      throw new PinnedFileError("Private Dictation only downloads its own model files.", "BlockedError");
    }
    const pinned = files.get(url.href);
    if (!pinned) {
      if (isHuggingFace(url)) return new Response(null, { status: 404, statusText: "Not pinned" });
      throw new PinnedFileError("Private Dictation only downloads its own model files.", "BlockedError");
    }
    // A probe for the file's size: answered from the pin.
    if (/^bytes=0-0$/.test(String(headerOf(init, input, "range") || "")))
      return new Response(new Uint8Array(1), {
        status: 206,
        headers: { "content-range": `bytes 0-0/${pinned.bytes}`, "content-length": "1" },
      });
    const cache = await openCache();
    const cached = await cache?.match(url.href).catch(() => null);
    if (cached) {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      if (bytes.byteLength === pinned.bytes && (await sha256Hex(bytes, subtle)) === pinned.sha256) return fileResponse(bytes);
      // Damaged or changed on this device: dropped and downloaded again.
      await cache.delete(url.href).catch(() => {});
    }
    const res = await fetchImpl(url.href, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      cache: "no-store",
      signal: init.signal,
    });
    if (!res.ok) throw new PinnedFileError(`Hugging Face answered ${res.status} for a model file.`, "DownloadError");
    const bytes = await readAll(res, pinned.bytes, (loaded) => onProgress?.({ url: url.href, loaded, total: pinned.bytes }));
    if (bytes.byteLength !== pinned.bytes || (await sha256Hex(bytes, subtle)) !== pinned.sha256)
      throw new PinnedFileError("A downloaded file didn't match its expected fingerprint, so it wasn't used.");
    await cache?.put(url.href, fileResponse(bytes)).catch(() => {});
    return fileResponse(bytes);
  };
}
// The worker's fetch: the engine's own WebAssembly from this origin (fetched
// by ONNX Runtime itself), and the pinned model files; nothing else.
export function workerFetch({ origin, engineUrl, realFetch, pinnedFetch }) {
  const engine = new URL(engineUrl, origin).href;
  if (new URL(engine).origin !== new URL(origin).origin) throw new Error("The engine must come from this site.");
  return (input, init) => {
    let href;
    try {
      href = new URL(requestUrl(input), origin).href;
    } catch {
      href = "";
    }
    if (href === engine) return realFetch(engine, { credentials: "same-origin" });
    return pinnedFetch(input, init);
  };
}

// ---- Storage ----
// What a model keeps in this browser: `complete` when every file of this
// device's build is cached; `bytes` counts every cached file of the model.
export async function dictationStorage(model, build, cachesApi = globalThis.caches) {
  let files = 0,
    bytes = 0,
    have = 0;
  const wanted = new Set(buildFiles(model, build).map((f) => f.path));
  if (cachesApi && (typeof cachesApi.has !== "function" || (await cachesApi.has(DICTATION_CACHE)))) {
    const cache = await cachesApi.open(DICTATION_CACHE);
    for (const f of [...model.common, ...Object.values(model.builds).flat()])
      if (await cache.match(modelUrl(model, f.path))) {
        files++;
        bytes += f.bytes;
        if (wanted.has(f.path)) have++;
      }
  }
  return { files, bytes, complete: have === wanted.size, partial: files > 0 && have < wanted.size };
}
// Removes every file of a model (both builds) from this browser. Each model
// keeps its own copy of the tokenizer under its own URL, so the other model
// is untouched. Returns how many entries were removed.
export async function removeDictationModel(model, cachesApi = globalThis.caches) {
  if (!cachesApi) return 0;
  const cache = await cachesApi.open(DICTATION_CACHE);
  let removed = 0;
  for (const f of [...model.common, ...Object.values(model.builds).flat()])
    if (await cache.delete(modelUrl(model, f.path))) removed++;
  return removed;
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1e9) return `${(v / 1e9).toFixed(1)} GB`;
  if (v >= 1e6) return `${Math.round(v / 1e6)} MB`;
  if (v >= 1e3) return `${Math.round(v / 1e3)} KB`;
  return `${v} bytes`;
}

// ---- Languages ----
// Whisper detects the language itself, or is told one. The picker offers
// the common ones; the codes are Whisper's own.
export const DICTATION_LANGUAGES = [
  { code: "auto", name: "Detect automatically" },
  { code: "en", name: "English" },
  { code: "es", name: "Spanish" },
  { code: "zh", name: "Chinese" },
  { code: "ar", name: "Arabic" },
  { code: "nl", name: "Dutch" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "hi", name: "Hindi" },
  { code: "id", name: "Indonesian" },
  { code: "it", name: "Italian" },
  { code: "ja", name: "Japanese" },
  { code: "ko", name: "Korean" },
  { code: "pl", name: "Polish" },
  { code: "pt", name: "Portuguese" },
  { code: "ru", name: "Russian" },
  { code: "sv", name: "Swedish" },
  { code: "tr", name: "Turkish" },
  { code: "uk", name: "Ukrainian" },
  { code: "vi", name: "Vietnamese" },
];
export const dictationLanguage = (code) => DICTATION_LANGUAGES.find((l) => l.code === code)?.code || "auto";

// ---- Audio ----
// Whisper hears 16 kHz mono. The longest recording taken, and the quietest
// one worth transcribing (Whisper invents words for silence).
export const SAMPLE_RATE = 16000;
export const MAX_RECORDING_MS = 120000;
export const MIN_SECONDS = 0.4;
export function audioCheck(samples) {
  const n = samples?.length || 0;
  if (n < MIN_SECONDS * SAMPLE_RATE) return "short";
  let sum = 0,
    peak = 0;
  for (let i = 0; i < n; i++) {
    const v = Math.abs(samples[i]);
    sum += v * v;
    if (v > peak) peak = v;
  }
  if (peak < 0.01 || Math.sqrt(sum / n) < 0.0015) return "silent";
  return "ok";
}
// Channels (Float32Arrays) → one, averaged.
export function downmix(channels) {
  if (channels.length === 1) return channels[0];
  const n = channels[0].length,
    out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < n; i++) out[i] += ch[i] / channels.length;
  return out;
}

// ---- The text ----
// Whisper's non-speech tags ([BLANK_AUDIO], (music), *applause*…) and the
// spacing it leaves, cleaned; the words themselves are kept as heard.
export function cleanTranscript(text) {
  return String(text || "")
    .replace(/\[[^\]\n]{0,40}\]|\((?:[^)\n]{0,30}\b(?:music|applause|laughter|laughs|silence|noise|inaudible|blank_audio)\b[^)\n]{0,30})\)|\*[^*\n]{0,30}\*/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

// ---- The worker ----
// Messages, page → worker: { type: "load", id, model, build } and
// { type: "transcribe", id, audio (Float32Array, 16 kHz mono), language }.
// Worker → page: { type: "progress", id, loaded, total }, { type: "ready",
// id, device, build }, { type: "partial", id, text }, { type: "result", id,
// text, device } and { type: "error", id, name, message }.
export function createDictationClient(worker) {
  const pending = new Map();
  let closed = null;
  const failAll = (err) => {
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };
  worker.onmessage = (event) => {
    const msg = event?.data;
    if (!msg || typeof msg !== "object") return;
    const p = pending.get(msg.id);
    if (!p) return;
    if (msg.type === "progress") return p.onProgress?.({ loaded: msg.loaded, total: msg.total });
    if (msg.type === "partial") return p.onPartial?.(String(msg.text || ""));
    pending.delete(msg.id);
    if (msg.type === "error") {
      const err = new Error(String(msg.message || "Private Dictation failed."));
      err.name = String(msg.name || "Error");
      p.reject(err);
    } else p.resolve(msg);
  };
  worker.onerror = (event) => {
    event?.preventDefault?.();
    const err = new Error("The on-device engine couldn't run in this browser.");
    err.name = "WorkerError";
    closed = err;
    failAll(err);
  };
  const call = (message, handlers = {}, transfer = []) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(closed);
      const id = globalThis.crypto.randomUUID();
      pending.set(id, { resolve, reject, ...handlers });
      worker.postMessage({ ...message, id }, transfer);
    });
  return {
    // Downloads (the first time) and starts a model's build; resolves
    // { device, build } (the processor build if the WebGPU one couldn't run).
    load: (model, build, { onProgress } = {}) => call({ type: "load", model, build }, { onProgress }),
    // Transcribes 16 kHz mono samples; resolves { text, device }. The
    // samples are handed to the worker (transferred), not copied.
    transcribe: (audio, language = "auto", { onPartial } = {}) =>
      call({ type: "transcribe", audio, language: dictationLanguage(language) }, { onPartial }, [audio.buffer]),
    close() {
      const err = new Error("Stopped");
      err.name = "AbortError";
      closed = err;
      failAll(err);
    },
  };
}

// Plain messages for what can go wrong, never the engine's raw text alone.
export function friendlyError(err, phase = "transcribe") {
  const t = `${err?.name || ""} ${err?.message || ""}`;
  if (/IntegrityError|fingerprint/i.test(t))
    return "A downloaded file didn't match its expected fingerprint, so it wasn't used. Remove the model and try again.";
  if (/QuotaExceeded|quota|not enough space/i.test(t))
    return "There isn't enough storage space on this device for this model. Free some space or pick the smaller model.";
  if (/WorkerError/.test(t)) return "The on-device engine couldn't run in this browser. Reload the page and try again.";
  if (/out of memory|memory access out of bounds|allocation/i.test(t))
    return "This device ran out of memory. Close other tabs, or pick the smaller model.";
  if (phase === "load" && /DownloadError|fetch|network|Failed to fetch|load failed/i.test(t))
    return "The download stopped. Check your connection and try again; files already downloaded are kept.";
  return phase === "load"
    ? "The model couldn't start on this device. Reload the page and try again, or pick the smaller model."
    : "The on-device transcription stopped before finishing. Try again, or type instead.";
}
