// Private Dictation's engine, page side: one worker (src/dictation.worker.js,
// its own chunk with Transformers.js, loaded only when someone dictates),
// kept while it's in use and stopped after a few idle minutes so its memory
// is freed. A recording is decoded here to 16 kHz mono and handed to the
// worker; nothing uses fetch, and nothing is stored.
import { SAMPLE_RATE, createDictationClient, downmix } from "./dictation.js";

const IDLE_MS = 3 * 60 * 1000;
let current = null, // { worker, client, model, build, ready }
  idle = null;

export function stopDictationEngine() {
  clearTimeout(idle);
  if (!current) return;
  current.client.close();
  current.worker.terminate();
  current = null;
}
const rest = () => {
  clearTimeout(idle);
  idle = setTimeout(stopDictationEngine, IDLE_MS);
};

// Starts (downloading first, if needed) a model's build ("gpu" or "cpu").
// Resolves { device, build }: the build that runs, "cpu" when the WebGPU one
// couldn't. `onProgress({ loaded, total })` follows the download.
export async function loadDictation(model, build, { onProgress } = {}) {
  clearTimeout(idle);
  if (current && (current.model !== model || current.build !== build)) stopDictationEngine();
  if (!current) {
    const worker = new Worker(new URL("./dictation.worker.js", import.meta.url), {
      type: "module",
      name: "anonyma-dictation",
    });
    current = { worker, client: createDictationClient(worker), model, build, ready: null };
  }
  const mine = current;
  mine.ready ??= mine.client.load(model, build, { onProgress: (p) => mine.progress?.(p) });
  mine.progress = onProgress;
  try {
    return await mine.ready;
  } catch (err) {
    if (current === mine) stopDictationEngine();
    throw err;
  } finally {
    mine.progress = null;
    if (current === mine) rest();
  }
}

// Transcribes 16 kHz mono samples with the loaded model.
export async function transcribeOnDevice(model, build, samples, language, { onPartial } = {}) {
  await loadDictation(model, build);
  clearTimeout(idle);
  try {
    return await current.client.transcribe(samples, language, { onPartial });
  } finally {
    rest();
  }
}

// A recording (a Blob from MediaRecorder) as 16 kHz mono samples, decoded
// and resampled by the browser's Web Audio.
export async function decodeRecording(blob) {
  const C = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!C) throw new Error("This browser can't decode audio.");
  const ctx = new C(1, 1, SAMPLE_RATE);
  const buffer = await blob.arrayBuffer();
  const audio = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(buffer, resolve, reject);
    if (p && typeof p.then === "function") p.then(resolve, reject);
  });
  const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
  // A copy the worker can own.
  return new Float32Array(downmix(channels));
}
