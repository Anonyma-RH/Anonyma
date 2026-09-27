// On-Device Model's engine: WebLLM runs in a dedicated worker
// (src/ondevice.worker.js, its own chunk, loaded only when a model starts),
// and this page talks to it with WebLLM's worker messages. This slim client
// replaces WebLLM's own WebWorkerMLCEngine so the page never loads the
// engine's ~6 MB bundle a second time on the main thread. It speaks the
// protocol of the pinned @mlc-ai/web-llm (0.2.85); tests/on-device.test.mjs
// checks the handler still answers these message kinds.
//
// Nothing here uses fetch: the page and the worker exchange messages only.

// An engine client over a worker (or a stand-in with postMessage/onmessage
// in tests). `close()` fails whatever is waiting, e.g. a download in progress.
export function createWorkerClient(worker, { onProgress } = {}) {
  const pending = new Map();
  let modelId = null,
    closed = null;
  const failAll = (err) => {
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };
  worker.onmessage = (event) => {
    const msg = event?.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.kind === "initProgressCallback") return onProgress?.(msg.content);
    const waiting = pending.get(msg.uuid);
    if (!waiting) return;
    pending.delete(msg.uuid);
    if (msg.kind === "return") waiting.resolve(msg.content);
    else waiting.reject(workerError(msg.content));
  };
  worker.onerror = (event) => {
    event?.preventDefault?.();
    const err = new Error("The on-device engine couldn't run in this browser.");
    err.name = "WorkerError";
    closed = err;
    failAll(err);
  };
  const call = (kind, content) =>
    new Promise((resolve, reject) => {
      if (closed) return reject(closed);
      const uuid = globalThis.crypto.randomUUID();
      pending.set(uuid, { resolve, reject });
      worker.postMessage({ kind, uuid, content });
    });
  const tell = (kind, content) => worker.postMessage({ kind, uuid: globalThis.crypto.randomUUID(), content });
  const client = {
    get modelId() {
      return modelId;
    },
    // Loads (downloading first if needed) the one model this client runs.
    // Only the models in `appConfig` can be loaded.
    async load(id, appConfig) {
      tell("setAppConfig", appConfig);
      tell("setLogLevel", "WARN");
      await call("reload", { modelId: [id], chatOpts: undefined });
      modelId = id;
      return client;
    },
    chat: {
      completions: {
        // A streamed chat completion: an async iterator of chunks, pulled
        // one at a time from the worker.
        async create(request) {
          if (!modelId) throw new Error("No on-device model is loaded.");
          const selectedModelId = modelId;
          await call("chatCompletionStreamInit", {
            request: { ...request, stream: true },
            selectedModelId,
            modelId: [modelId],
            chatOpts: undefined,
          });
          return (async function* chunks() {
            while (true) {
              const chunk = await call("completionStreamNextChunk", { selectedModelId });
              if (!chunk || typeof chunk !== "object") return;
              yield chunk;
            }
          })();
        },
      },
    },
    // Stops the reply being written; the stream then ends normally.
    interruptGenerate() {
      call("interruptGenerate", null).catch(() => {});
    },
    close() {
      const err = new Error("Stopped");
      err.name = "AbortError";
      closed = err;
      failAll(err);
    },
  };
  return client;
}
// The worker sends errors as text ("IntegrityError: …"); keep the name.
function workerError(content) {
  const text = String(content ?? "The on-device model failed.");
  const err = new Error(text);
  const name = /^([A-Za-z]+Error)\b/.exec(text)?.[1];
  if (name) err.name = name;
  return err;
}

// Starts one model in a fresh worker. `stop()` ends the worker at once: it
// cancels a download in progress (files already fetched stay cached, so the
// next start resumes) and frees the graphics memory the model held.
export function startEngine({ modelId, appConfig, onProgress }) {
  const worker = new Worker(new URL("./ondevice.worker.js", import.meta.url), {
    type: "module",
    name: "anonyma-on-device",
  });
  const client = createWorkerClient(worker, { onProgress });
  return {
    engine: client.load(modelId, appConfig),
    stop() {
      client.close();
      worker.terminate();
    },
  };
}
