// The page's side of Encrypted Backup's worker (src/account-backup.worker.js),
// or, where a browser can't start one, the same code on the page. Either
// way the passphrase, the key and the plaintext stay in this browser.
export function openBackupEngine() {
  let worker = null;
  try {
    worker = new Worker(new URL("./account-backup.worker.js", import.meta.url), { type: "module" });
  } catch {
    worker = null;
  }
  if (!worker) return inPage();
  let next = 1;
  const waiting = new Map();
  worker.onmessage = (event) => {
    const { id, progress, result, error } = event.data || {};
    const w = waiting.get(id);
    if (!w) return;
    if (progress) return w.onProgress?.(progress);
    waiting.delete(id);
    if (error) w.reject(Object.assign(Error(error.message), { code: error.code }));
    else w.resolve(result);
  };
  worker.onerror = () => {
    for (const [id, w] of [...waiting]) {
      waiting.delete(id);
      w.reject(Object.assign(Error("The backup stopped. It may be too large for this browser."), { code: "failed" }));
    }
  };
  const ask = (message, onProgress) =>
    new Promise((resolve, reject) => {
      const id = next++;
      waiting.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, ...message });
    });
  return {
    open: (file, passphrase, { seedGuard = false, onProgress } = {}) => ask({ type: "open", file, passphrase, seedGuard }, onProgress),
    get: (kind, start, count) => ask({ type: "get", kind, start, count }),
    start: (passphrase, created) => ask({ type: "start", passphrase, created }),
    push: (items) => ask({ type: "push", items }),
    finish: () => ask({ type: "finish" }),
    close() {
      worker.terminate();
      waiting.clear();
    },
  };
}

function inPage() {
  let session = null,
    writer = null;
  const engine = () => import("./account-backup-engine.js");
  return {
    async open(file, passphrase, { seedGuard = false, onProgress } = {}) {
      session = null;
      session = await (await engine()).loadBackup(file, passphrase, { seedGuard, onProgress });
      return session.overview();
    },
    async get(kind, start, count) {
      return session ? session.get(kind, start, count) : [];
    },
    async start(passphrase, created) {
      writer = await (await engine()).writerFor(passphrase, { created });
      return true;
    },
    async push(items) {
      return writer.push(items);
    },
    async finish() {
      const done = await writer.finish();
      writer = null;
      return done;
    },
    close() {
      session = null;
      writer = null;
    },
  };
}
