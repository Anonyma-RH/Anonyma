// Chat Import's worker: an export is unzipped, parsed and searched here, off
// the page's main thread, so a large one never freezes the tab. It holds the
// parsed chats between messages, never makes a network request and keeps
// nothing once the page closes it.
import { loadExport } from "./chat-import-engine.js";

let session = null;
const say = (message) => self.postMessage(message);

self.onmessage = async (event) => {
  const { id, type } = event.data || {};
  try {
    if (type === "load") {
      session = null;
      session = await loadExport(event.data.file, {
        seedGuard: event.data.seedGuard === true,
        onProgress: (progress) => say({ id, progress }),
      });
      return say({ id, result: session.overview() });
    }
    if (!session) throw Object.assign(Error("Nothing is open."), { code: "closed" });
    if (type === "search") return say({ id, result: session.search(event.data.query) });
    if (type === "get") return say({ id, result: session.get(event.data.ids || []) });
    throw Error("Unknown request.");
  } catch (e) {
    say({
      id,
      error: {
        code: e?.code || "failed",
        message:
          e instanceof RangeError
            ? "This export is too large for this browser's memory."
            : e?.message || "Something went wrong reading this file.",
      },
    });
  }
};
