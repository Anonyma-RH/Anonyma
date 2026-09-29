// The page's side of Chat Import's reader: talks to the worker
// (src/chat-import.worker.js), or, where a browser can't start one, runs the
// same reader on the page. Either way the export is read in this browser.
export function openEngine() {
  let worker = null;
  try {
    worker = new Worker(new URL("./chat-import.worker.js", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  if (!worker) return inPage();
  let next = 1;
  const waiting = new Map();
  const finish = (id) => {
    const w = waiting.get(id);
    waiting.delete(id);
    return w;
  };
  worker.onmessage = (event) => {
    const { id, progress, result, error } = event.data || {};
    const w = waiting.get(id);
    if (!w) return;
    if (progress) return w.onProgress?.(progress);
    finish(id);
    if (error) w.reject(Object.assign(Error(error.message), { code: error.code }));
    else w.resolve(result);
  };
  worker.onerror = () => {
    for (const [id, w] of [...waiting]) {
      finish(id);
      w.reject(Object.assign(Error("This export stopped loading. It may be too large for this browser."), { code: "failed" }));
    }
  };
  const ask = (message, onProgress) =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, ...message });
    });
  return {
    load: (file, { seedGuard = false, onProgress } = {}) => ask({ type: "load", file, seedGuard }, onProgress),
    search: (query) => ask({ type: "search", query }),
    get: (ids) => ask({ type: "get", ids }),
    close() {
      worker.terminate();
      waiting.clear();
    },
  };
}

function inPage() {
  let session = null;
  let engine = null;
  const reader = async () => (engine ||= await import("./chat-import-engine.js"));
  return {
    async load(file, { seedGuard = false, onProgress } = {}) {
      session = null;
      session = await (await reader()).loadExport(file, { seedGuard, onProgress });
      return session.overview();
    },
    async search(query) {
      return session ? session.search(query) : [];
    },
    async get(ids) {
      return session ? session.get(ids) : [];
    },
    close() {
      session = null;
    },
  };
}
