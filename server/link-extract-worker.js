import { parentPort, workerData } from "node:worker_threads";
import { extractHtml } from "./link-extract.js";

// Link Reader's extraction, off the server's main thread (see
// runExtraction in routes/link-reader.js, which also enforces a time and
// memory limit). Posts the result, or { error: true } without any detail.
try {
  parentPort.postMessage(extractHtml(workerData.html, { host: workerData.host }));
} catch {
  parentPort.postMessage({ error: true });
}
