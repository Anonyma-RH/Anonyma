// Encrypted Backup's worker: the key is derived, the file sealed and opened,
// and an opened backup's items held here, off the page's main thread, so a
// large account never freezes the tab. It never makes a network request and
// keeps nothing once the page closes it.
import { loadBackup, writerFor } from "./account-backup-engine.js";

let session = null,
  writer = null;
const say = (message, transfer = []) => self.postMessage(message, transfer);
const buffers = (parts) => parts.map((p) => p.buffer);

self.onmessage = async (event) => {
  const { id, type } = event.data || {};
  try {
    if (type === "open") {
      session = null;
      session = await loadBackup(event.data.file, event.data.passphrase, {
        seedGuard: event.data.seedGuard === true,
        onProgress: (progress) => say({ id, progress }),
      });
      return say({ id, result: session.overview() });
    }
    if (type === "get") {
      if (!session) throw Object.assign(Error("Nothing is open."), { code: "closed" });
      return say({ id, result: session.get(event.data.kind, event.data.start, event.data.count) });
    }
    if (type === "start") {
      writer = null;
      writer = await writerFor(event.data.passphrase, { created: event.data.created });
      return say({ id, result: true });
    }
    if (type === "push" || type === "finish") {
      if (!writer) throw Object.assign(Error("No backup is being made."), { code: "closed" });
      if (type === "push") {
        const parts = await writer.push(event.data.items || []);
        return say({ id, result: parts }, buffers(parts));
      }
      const done = await writer.finish();
      writer = null;
      return say({ id, result: done }, [done.header.buffer, ...buffers(done.parts)]);
    }
    throw Error("Unknown request.");
  } catch (e) {
    say({
      id,
      error: {
        code: e?.code || "failed",
        message:
          e instanceof RangeError
            ? "This backup is too large for this browser's memory."
            : e?.message || "Something went wrong with this backup.",
      },
    });
  }
};
