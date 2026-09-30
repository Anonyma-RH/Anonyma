// Private Dictation's worker, first module: before the engine
// (Transformers.js and ONNX Runtime) is even evaluated, the worker's own
// fetch is replaced with one that reaches only the pinned model files
// (createPinnedFetch in src/dictation.js) and the speech engine's own
// WebAssembly on this origin, and XMLHttpRequest, WebSocket, EventSource and
// WebTransport are refused. Imported first by src/dictation.worker.js.
import engineUrl from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import { createPinnedFetch, workerFetch } from "./dictation.js";

// The engine's WebAssembly: a fingerprinted build asset on this origin.
export const ENGINE_URL = new URL(engineUrl, self.location.origin).href;

const realFetch = self.fetch.bind(self);
let listener = null;
// Download progress for the load in flight: onDownload(fn) sets who hears it.
export const onDownload = (fn) => {
  listener = fn;
};
export const pinnedFetch = createPinnedFetch({
  fetchImpl: realFetch,
  cachesApi: self.caches,
  onProgress: (p) => listener?.(p),
});
self.fetch = workerFetch({ origin: self.location.origin, engineUrl: ENGINE_URL, realFetch, pinnedFetch });
for (const name of ["XMLHttpRequest", "WebSocket", "EventSource", "WebTransport"])
  if (name in self)
    self[name] = function refused() {
      throw new Error("Private Dictation's engine has no other network access.");
    };
