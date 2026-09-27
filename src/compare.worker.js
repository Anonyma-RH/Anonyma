// Document Compare's worker: the two versions are diffed here, off the
// page's main thread, so a long document never freezes the tab. It gets the
// two texts and gives back the comparison; it never makes a network request
// and keeps nothing once it has answered.
import { compareTexts } from "./doc-compare.js";

self.onmessage = (event) => {
  const { id, original, revised, kinds } = event.data || {};
  try {
    self.postMessage({ id, result: compareTexts(original, revised, { kinds }) });
  } catch (e) {
    self.postMessage({
      id,
      error:
        e instanceof RangeError
          ? "These documents are too large for this browser's memory."
          : e.message,
    });
  }
};
