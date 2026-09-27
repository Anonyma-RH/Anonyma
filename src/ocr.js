// Local OCR ("Text only"): the pure half. The text in an attached image is
// read in this browser by tesseract.js (src/ocr-engine.js), shown for
// editing (src/OcrPanel.jsx), and "Use text" swaps the image for a text
// attachment in Documents' format, so everything that applies to an
// attached file applies to it: Injection Shield's "send as data", Veil's
// masking, Seed Guard's scan and the message budget. The image is dropped
// and never sent. Nothing here touches the DOM, so it's tested in Node.
import { MAX_DOCUMENTS, buildDocumentBlock } from "./documents.js";
import { toCredits } from "./model-finder.js";
import {
  OCR_DATA_BYTES,
  OCR_DATA_PATH,
  OCR_ENGINE_BYTES,
  OCR_ENGINE_PATH,
} from "./ocr-assets.js";

// The language choices. `data` lists the models to load, main one first:
// tesseract reads mixed Chinese and English best with both, Chinese first.
export const OCR_LANGUAGES = [
  { id: "eng", label: "English", data: ["eng"] },
  { id: "chi_sim+eng", label: "Chinese and English", data: ["chi_sim", "eng"] },
  { id: "chi_sim", label: "Chinese", data: ["chi_sim"] },
];
export const ocrLanguage = (id) =>
  OCR_LANGUAGES.find((l) => l.id === id) || OCR_LANGUAGES[0];
// Picked from the interface language each time; the panel's picker changes it.
export const defaultOcrLanguage = (uiLanguage) =>
  uiLanguage === "zh" ? "chi_sim+eng" : "eng";
// What a first run downloads from ANONYMA for this choice: the engine and
// the language data. The browser keeps them afterwards.
export const firstRunBytes = (id) =>
  OCR_ENGINE_BYTES + ocrLanguage(id).data.reduce((n, l) => n + OCR_DATA_BYTES[l], 0);
export const megabytes = (bytes) => Math.max(0.1, Math.round(bytes / 1e5) / 10);

// tesseract.js's options. Every path is on ANONYMA's own origin, so none of
// the library's CDN defaults is ever used:
// - the worker script loads directly from 'self' (no blob: wrapper), under
//   the app's own CSP (script-src 'self' 'wasm-unsafe-eval');
// - the core is the SIMD build where WebAssembly SIMD works, else the plain
//   one; its .wasm sits next to the worker;
// - the language data comes from OCR_DATA_PATH. Those files are gzipped
//   under plain names (src/ocr-assets.js), so `gzip: false` asks for
//   eng.traineddata and tesseract.js unpacks it by its header;
// - cacheMethod "none": nothing is written to IndexedDB; the browser's HTTP
//   cache keeps the files (the server sends them with a long cache).
export function engineOptions({ simd = true } = {}) {
  return {
    workerPath: `${OCR_ENGINE_PATH}/worker.min.js`,
    corePath: `${OCR_ENGINE_PATH}/${simd ? "tesseract-core-simd-lstm.js" : "tesseract-core-lstm.js"}`,
    langPath: OCR_DATA_PATH,
    gzip: false,
    cacheMethod: "none",
    workerBlobURL: false,
    legacyCore: false,
    legacyLang: false,
  };
}

// Small images read better enlarged: Tesseract wants letters 20 or so
// pixels tall, and a small crop of a screen has them at 12 to 16. Anything
// under about half a megapixel (800 x 600) is drawn at twice the size.
// Larger ones, like phone and retina screenshots, already have big enough
// text, and enlarging it further makes Chinese read worse, so they stay as
// they are. Nothing goes past 4,000 px on its long side.
export function ocrScale(width, height) {
  if (!(width > 0 && height > 0)) return 1;
  const up = width * height < 480000 ? 2 : 1;
  return Math.min(up, 4000 / Math.max(width, height));
}

const CJK = "\\u2e80-\\u9fff\\uf900-\\ufaff\\u3000-\\u303f\\uff00-\\uffef";
const CJK_CHAR = new RegExp(`[${CJK}]`);
// Tesseract's output tidied: line endings, a space it puts between every
// Chinese character, trailing spaces, and runs of blank lines.
export function cleanOcrText(raw) {
  return String(raw ?? "")
    .replace(/\r\n?|\f/g, "\n")
    .replace(new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, "g"), "$1")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The line under the text, from tesseract's mean word confidence (0-100).
export function confidenceNote(confidence, text) {
  if (!String(text ?? "").trim())
    return { tone: "empty", text: "No text found in this image." };
  const c = Math.round(Math.min(100, Math.max(0, Number(confidence) || 0)));
  if (c >= 85) return { tone: "good", text: `Read clearly: ${c}% confidence.` };
  if (c >= 60) return { tone: "warn", text: `Some words may be wrong: ${c}% confidence.` };
  return { tone: "low", text: `Hard to read: ${c}% confidence. Check every line.` };
}

// The text attachment that takes the image's place, in Documents' format
// (src/Documents.jsx). It keeps the image's name and is marked
// source="ocr", so the model and the chat both know it was read from an
// image. No size: the image's bytes aren't what's sent.
export function ocrDocument(item, text, id) {
  const body = String(text ?? "");
  return {
    id,
    name: String(item?.name || "image"),
    kind: "ocr",
    source: "ocr",
    pages: null,
    size: null,
    text: body,
    chars: body.length,
    warning: "",
    hidden: null,
  };
}

// Why "Use text" can't go ahead, or null when it can.
export function replaceProblem({ images, documents, item, text }) {
  if (!images?.includes(item)) return "gone";
  if ((documents?.length || 0) >= MAX_DOCUMENTS) return "full";
  if (!String(text ?? "").trim()) return "empty";
  return null;
}
// "Use text": the image leaves the composer and the text joins the
// attached documents. Every other image and document stays as it was.
// Returns null (and changes nothing) when it can't.
export function replaceWithText({ images, documents, item, doc }) {
  if (replaceProblem({ images, documents, item, text: doc?.text })) return null;
  return {
    images: images.filter((x) => x !== item),
    documents: [...documents, doc],
  };
}

// ---- the saving, estimated in this browser -----------------------------------
// Nothing is sent to price it. An image's input tokens: about one per 750
// pixels once it's scaled to fit 1,568 px on its long side and 1.15
// megapixels (how Anthropic documents it; OpenAI's and Google's counts for a
// screenshot land in the same range). Text: about four characters per
// token, and one per Chinese character. A guide: each provider's own count
// decides the charge.
export function imageTokens(width, height) {
  if (!(width > 0 && height > 0)) return 0;
  const scale = Math.min(1, 1568 / Math.max(width, height), Math.sqrt(1150000 / (width * height)));
  return Math.ceil((width * scale * (height * scale)) / 750);
}
export function textTokens(text) {
  let cjk = 0,
    other = 0;
  for (const ch of String(text ?? "")) CJK_CHAR.test(ch) ? cjk++ : other++;
  return Math.ceil(other / 4) + cjk;
}
// { image, text } credits for this model's input at the standard rate, or
// null unless the model reads images and publishes an input price. The text
// is counted as it would be sent: inside its document tags.
export function ocrSavings({ model, markup = 0, width, height, name, text }) {
  const rate = model?.pricing?.input_per_1M_tokens;
  if (!model?.vision || typeof rate !== "number" || !Number.isFinite(rate) || rate < 0) return null;
  const pixels = imageTokens(width, height);
  if (!pixels) return null;
  const words = textTokens(buildDocumentBlock({ name, text, source: "ocr" }));
  const credits = (tokens) => toCredits((tokens * rate) / 1e6, markup);
  return { imageTokens: pixels, textTokens: words, image: credits(pixels), text: credits(words) };
}
