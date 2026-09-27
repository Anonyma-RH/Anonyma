// On-Device Model's engine (WebLLM), in its own worker so generating a reply
// never blocks the page. Served from this origin, so it runs under the app's
// worker-src 'self'. Its only network use is fetching the pinned model files
// (src/on-device.js); it never talks to ANONYMA's server.
import { WebWorkerMLCEngineHandler } from "@mlc-ai/web-llm";

const handler = new WebWorkerMLCEngineHandler();
self.onmessage = (msg) => handler.onmessage(msg);
