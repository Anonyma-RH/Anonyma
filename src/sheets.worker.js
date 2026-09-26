// Local Sheets' worker: the sheet is read, kept and calculated here, off the
// page's main thread. Only its profile, the first few rows (for the "share
// sample rows" choice) and each small result go back to the page. This
// worker never makes a network request.
import { handleSheetMessage } from "./sheets-engine.js";

const state = { sheet: null };
self.onmessage = async (event) => {
  self.postMessage(await handleSheetMessage(state, event.data));
};
