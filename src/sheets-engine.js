// The engine behind Local Sheets: the same message handler runs in a Web
// Worker (src/sheets.worker.js) or, where workers aren't available, on the
// page itself. Either way the sheet stays in this browser's memory only:
// nothing is stored, and closing the sheet (or the tab) drops it.
import {
  MAX_BYTES,
  decodeBytes,
  loadSheet,
  runSpec,
  sheetKind,
  sheetProfile,
} from "./sheets.js";

export const tooLarge = () =>
  `This file is larger than ${MAX_BYTES / 1024 / 1024} MB. Split it into smaller files and open one at a time.`;

// { id, type: "load", file | text, name } → { id, profile, samples, warnings }
// { id, type: "run", spec }              → { id, result }
// { id, type: "close" }                  → { id, closed: true }
export async function handleSheetMessage(state, message) {
  const { id, type } = message || {};
  try {
    if (type === "load") {
      state.sheet = null;
      const name = String(message.name || "sheet.csv").slice(0, 200);
      let text = message.text;
      if (text === undefined) {
        if (message.file.size > MAX_BYTES) throw Error(tooLarge());
        text = decodeBytes(await message.file.arrayBuffer());
      }
      const sheet = loadSheet(text, { name, kind: sheetKind(name) });
      state.sheet = sheet;
      return {
        id,
        name,
        profile: sheetProfile(sheet),
        samples: sheet.samples,
        warnings: sheet.warnings,
      };
    }
    if (type === "run") {
      if (!state.sheet) throw Error("Open a sheet first.");
      return { id, result: runSpec(state.sheet, message.spec) };
    }
    if (type === "close") {
      state.sheet = null;
      return { id, closed: true };
    }
    throw Error("Unknown request.");
  } catch (e) {
    return {
      id,
      error:
        e instanceof RangeError
          ? "This sheet is too large for this browser's memory."
          : e.message,
    };
  }
}

// The page's handle on the engine: a worker when the browser has one.
export function createSheetEngine({ worker = true } = {}) {
  let next = 0;
  const waiting = new Map();
  const state = { sheet: null };
  let w = null;
  if (worker && typeof Worker !== "undefined") {
    try {
      w = new Worker(new URL("./sheets.worker.js", import.meta.url), {
        type: "module",
      });
      w.onmessage = (e) => {
        const done = waiting.get(e.data?.id);
        if (!done) return;
        waiting.delete(e.data.id);
        done(e.data);
      };
      w.onerror = () => {
        for (const done of waiting.values())
          done({ error: "The sheet engine stopped. Open the file again." });
        waiting.clear();
      };
    } catch {
      w = null;
    }
  }
  const call = (message) => {
    const id = ++next;
    if (!w) return handleSheetMessage(state, { ...message, id });
    return new Promise((resolve) => {
      waiting.set(id, resolve);
      w.postMessage({ ...message, id });
    });
  };
  const unwrap = async (message) => {
    const reply = await call(message);
    if (reply.error) throw Error(reply.error);
    return reply;
  };
  return {
    load: (source) => unwrap({ type: "load", ...source }),
    run: async (spec) => (await unwrap({ type: "run", spec })).result,
    close() {
      state.sheet = null;
      waiting.clear();
      w?.terminate();
      w = null;
    },
  };
}
