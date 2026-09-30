// Private Dictation's worker: Whisper (Transformers.js on ONNX Runtime Web)
// runs here, off the page, in this browser. The page sends 16 kHz mono
// samples; what comes back is text. The recording is never stored or sent.
//
// Its only network use: the pinned model files from Hugging Face, checked
// against their SHA-256 before use and kept in Cache Storage
// (createPinnedFetch in src/dictation.js), and ONNX Runtime's WebAssembly
// binary from ANONYMA itself (a Vite build asset). Before the engine
// loads, this worker replaces its own fetch with one that reaches nothing
// else, and refuses XMLHttpRequest, WebSocket and EventSource. Served from
// this origin, so it runs under the app's worker-src 'self'.
//
// This import comes first: it locks the worker's network down before the
// engine's modules are evaluated.
import { ENGINE_URL, onDownload, pinnedFetch } from "./dictation-lockdown.js";
import { env, pipeline, WhisperTextStreamer } from "@huggingface/transformers";
import {
  BUILDS,
  buildBytes,
  cleanTranscript,
  detectDictationBuild,
  dictationModel,
  modelBase,
} from "./dictation.js";

// Pinned files only: fetched through the pinned fetcher, cached by it (not by
// Transformers.js), and no local paths. The engine's WebAssembly comes from
// this origin, never a CDN.
env.allowLocalModels = false;
env.allowRemoteModels = true;
env.remoteHost = "https://huggingface.co/";
env.useBrowserCache = false;
env.useWasmCache = false;
env.useCustomCache = false;
env.experimental_useCrossOriginStorage = false;
env.fetch = pinnedFetch;
env.backends.onnx.wasm.wasmPaths = { wasm: ENGINE_URL };
env.backends.onnx.wasm.proxy = false;

let engine = null; // { key, build, device, pipe }
let loading = null;

// Starts a model's build (downloading its files first, if needed). The
// WebGPU build falls back to the processor build when this worker has no
// usable WebGPU with shader-f16, or the model won't run on it.
async function load(key, wanted, onProgress) {
  const model = dictationModel(key);
  if (!model) throw new Error("Unknown model.");
  if (engine?.key === key && (engine.build === wanted || engine.fellBack)) return engine;
  if (loading?.key === key) return loading.promise;
  const promise = (async () => {
    try {
      await engine?.pipe?.dispose?.();
    } catch {}
    engine = null;
    // Every file of this model at its pinned commit, never "main" (even the
    // requests Transformers.js makes without a revision).
    env.remotePathTemplate = modelBase(model).replace("https://huggingface.co/", "").replace(model.repo, "{model}");
    const start = async (build) => {
      // Download progress, summed over the build's files.
      const seen = new Map();
      onDownload(({ url, loaded }) => {
        seen.set(url, loaded);
        let l = 0;
        for (const v of seen.values()) l += v;
        onProgress?.({ loaded: l, total: buildBytes(model, build) });
      });
      return pipeline("automatic-speech-recognition", model.repo, {
        revision: model.rev,
        dtype: BUILDS[build].dtype,
        device: BUILDS[build].device,
      });
    };
    let build = wanted === "gpu" && (await detectDictationBuild(self.navigator)) === "gpu" ? "gpu" : "cpu",
      pipe;
    const fellBack = wanted === "gpu" && build === "cpu";
    try {
      pipe = await start(build);
    } catch (err) {
      if (build !== "gpu" || /fingerprint|Integrity|DownloadError|Blocked|QuotaExceeded/i.test(`${err?.name} ${err?.message}`))
        throw err;
      build = "cpu";
      pipe = await start(build);
    }
    engine = { key, build, device: BUILDS[build].device, pipe, fellBack: fellBack || build !== wanted };
    return engine;
  })();
  loading = { key, promise };
  try {
    return await promise;
  } finally {
    onDownload(null);
    if (loading?.promise === promise) loading = null;
  }
}

async function transcribe(audio, language, onPartial) {
  if (!engine) throw new Error("No model is loaded.");
  let text = "";
  const streamer = new WhisperTextStreamer(engine.pipe.tokenizer, {
    skip_prompt: true,
    callback_function: (piece) => {
      text += piece;
      onPartial(cleanTranscript(text));
    },
  });
  const out = await engine.pipe(audio, {
    task: "transcribe",
    ...(language && language !== "auto" ? { language } : {}),
    // Recordings over 30 seconds are read in overlapping windows.
    chunk_length_s: 30,
    stride_length_s: 5,
    streamer,
  });
  return cleanTranscript(out?.text ?? text);
}

self.onmessage = async (event) => {
  const msg = event.data || {};
  const reply = (m) => self.postMessage({ ...m, id: msg.id });
  try {
    if (msg.type === "load") {
      const e = await load(msg.model, msg.build === "gpu" ? "gpu" : "cpu", (p) => reply({ type: "progress", ...p }));
      reply({ type: "ready", device: e.device, build: e.build });
    } else if (msg.type === "transcribe") {
      const audio = msg.audio instanceof Float32Array ? msg.audio : new Float32Array(0);
      const text = await transcribe(audio, msg.language, (t) => reply({ type: "partial", text: t }));
      reply({ type: "result", text, device: engine.device });
    }
  } catch (err) {
    reply({ type: "error", name: err?.name || "Error", message: String(err?.message || err) });
  }
};
