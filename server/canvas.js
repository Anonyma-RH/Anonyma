import { fail, wantsWebSearch } from "./core.js";
import {
  CANVAS_BASE_TOKENS,
  CANVAS_LENGTH,
  CANVAS_SYSTEM,
  CANVAS_TOO_LONG,
  CANVAS_UNREADABLE,
  canvasFit,
  canvasMessages,
  checkCanvasPayload,
  readCanvasReply,
} from "../src/canvas-spec.js";
import { unescapeDocumentText } from "../src/documents.js";

// Canvas ("canvas"): a suggestion is an ordinary /api/chat request whose
// messages the server builds itself from the `canvas` payload
// (src/canvas-spec.js), so it runs through chat's own reserve -> settle
// billing, Spending Limits, Allowances, Seed Guard, Private Mode, Privacy
// Trail, Model Status and failover. It's always off the record: nothing
// about a suggestion is saved (the canvas itself is saved separately, by
// routes/canvas.js, and only if the person keeps it on their account).
//
// Only a usable reply is paid for: runChat asks canvasVerdict (through
// req.acceptOutput, set here in code) and releases the hold for a reply
// that can't be read or was cut off by its budget, as for an empty one.
//
// Runs in runChat after the other built-message modes (Study, Compare,
// Sheets, Catch me up), each of which refuses ready-made `messages`, so a
// request carrying two of them is refused. Returns the checked payload, or
// undefined for a request without `canvas`, which is left untouched.
const REFUSED = [
  "auto",
  "conversationId",
  "project",
  "taskTool",
  "double_check",
  "treasury",
  "messages",
  "sheets",
  "study",
  "compare",
  "catchup",
  "models",
  "depth",
  "question",
];
export function prepareCanvasRequest(body, { quote = false } = {}) {
  if (!body || body.canvas === undefined) return;
  const refuse = (message) => fail(400, message, "invalid_canvas");
  if (!quote && body.ephemeral !== true)
    refuse("Canvas suggestions are never saved: send them off the record.");
  for (const key of REFUSED)
    if (body[key] !== undefined && body[key] !== null)
      refuse("A Canvas suggestion can't be combined with other chat options.");
  if (body.memory != null || wantsWebSearch(body))
    refuse("A Canvas suggestion can't be combined with other chat options.");
  if (body.mode !== undefined && body.mode !== "chat")
    refuse("A Canvas suggestion can't be combined with other chat options.");
  let payload;
  try {
    payload = checkCanvasPayload(body.canvas);
  } catch (e) {
    refuse(e.message);
  }
  body.messages = canvasMessages(payload);
  body.max_tokens = CANVAS_BASE_TOKENS;
  body.mode = "chat";
  return payload;
}

// The reply budget for the chosen model (src/canvas-spec.js canvasFit). A
// text too long for the model to rewrite in one reply is refused before
// anything is held.
export function canvasBudget(payload, model, messages) {
  const fit = canvasFit(payload, model, messages);
  if (!fit.fits) fail(400, CANVAS_TOO_LONG, "canvas_too_long");
  return fit.budget;
}

// runChat's acceptOutput for a suggestion: true for a reply the browser can
// use, otherwise the plain message and code to refuse it with (nothing is
// charged either way it's refused).
export const canvasVerdict = (payload) => (output, finish) => {
  const read = readCanvasReply(output, { finish, original: payload.text });
  if (read.ok) return true;
  return read.reason === "length"
    ? { message: CANVAS_LENGTH, code: "canvas_length" }
    : { message: CANVAS_UNREADABLE, code: "canvas_unreadable" };
};

// ---- LOCAL_TEST_MODE only ----
// A deterministic stand-in for a model (server/provider.js), so the whole
// flow can be driven without a provider. It reads the task and text back
// out of the prompt and applies a few fixed word swaps, so every action
// visibly changes something. A selection containing "[[canvas:length]]"
// ends like a reply cut off by its budget, and "[[canvas:junk]]" gets a
// reply that can't be read. Never used live.
const swaps = (pairs) => (s) => pairs.reduce((t, [a, b]) => t.replace(a, b), s);
const IMPROVE = [
  [/\ba very good\b/gi, "an excellent"],
  [/\bvery good\b/gi, "excellent"],
  [/\ba lot of\b/gi, "many"],
  [/\bin order to\b/gi, "to"],
  [/\butili[sz]e\b/gi, "use"],
  [/\bbasically,?\s*/gi, ""],
  [/\breally\s+/gi, ""],
  [/\bthings\b/gi, "details"],
  [/\bgets\b/gi, "receives"],
  [/\bget\b/gi, "receive"],
  [/\bshows up\b/gi, "appears"],
  [/\bmake sure\b/gi, "ensure"],
];
const FILLER = [
  [/\b(really|very|just|basically|actually|quite|simply)\s+/gi, ""],
  [/\bin order to\b/gi, "to"],
  [/\bat this point in time\b/gi, "now"],
  [/\bdue to the fact that\b/gi, "because"],
  [/\s*\([^)]*\)/g, ""],
];
const FORMAL = [
  [/\bdon't\b/gi, "do not"],
  [/\bcan't\b/gi, "cannot"],
  [/\bwon't\b/gi, "will not"],
  [/\bit's\b/gi, "it is"],
  [/\bwe're\b/gi, "we are"],
  [/\byou're\b/gi, "you are"],
  [/\bthanks\b/gi, "thank you"],
  [/^hi\b/gim, "Dear reader"],
  [/\bget\b/gi, "receive"],
  [/\ba lot of\b/gi, "a great deal of"],
  [/!/g, "."],
];
const FRIENDLY = [
  [/\bdo not\b/gi, "don't"],
  [/\bcannot\b/gi, "can't"],
  [/\bwill not\b/gi, "won't"],
  [/\bit is\b/gi, "it's"],
  [/\bwe are\b/gi, "we're"],
  [/\byou are\b/gi, "you're"],
  [/\breceive\b/gi, "get"],
  [/^dear\b[^\n,]*/gim, "Hi there"],
];
const PLAIN = [
  [/\butili[sz]e\b/gi, "use"],
  [/\bapproximately\b/gi, "about"],
  [/\bcommence\b/gi, "start"],
  [/\bin order to\b/gi, "to"],
  [/\bprior to\b/gi, "before"],
  [/\bsubsequently\b/gi, "then"],
  [/\bfacilitate\b/gi, "help"],
  [/\bin the event that\b/gi, "if"],
  [/\bpurchase\b/gi, "buy"],
];
const GRAMMAR = [
  [/\bteh\b/g, "the"],
  [/\brecieve/g, "receive"],
  [/\bseperate/g, "separate"],
  [/\bdefinately\b/g, "definitely"],
  [/\balot\b/g, "a lot"],
  [/\bshould of\b/g, "should have"],
  [/\btheir is\b/g, "there is"],
  [/\bits a\b/g, "it's a"],
  [/\bdont\b/g, "don't"],
  [/(^|[\s(])i(?=[\s,.!?'])/g, "$1I"],
  [/ {2,}/g, " "],
];
const CONSISTENT = [
  [/\be-mail\b/g, "email"],
  [/\bE-mail\b/g, "Email"],
  [/\bweb site\b/g, "website"],
  [/\bWeb site\b/g, "Website"],
  [/\bcolour/g, "color"],
  [/\borganisation/g, "organization"],
  [/\bper cent\b/g, "percent"],
  [/\bon-line\b/g, "online"],
  [/\bAnonyma\b/g, "ANONYMA"],
];
const tidy = (s) => s.replace(/[ \t]{2,}/g, " ").replace(/ +([,.;:!?])/g, "$1");
const sentences = (s) => s.match(/[^.!?\n]+[.!?]+/g) || [s];
function testRewrite(task, text) {
  if (/^Improve /.test(task)) {
    const out = tidy(swaps(IMPROVE)(text));
    return out !== text ? out : `Put simply, ${text.charAt(0).toLowerCase()}${text.slice(1)}`;
  }
  if (/^Shorten /.test(task)) {
    let out = tidy(swaps(FILLER)(text));
    const all = sentences(out);
    if (all.length > 2) out = all.slice(0, 2).join("").trim();
    return out !== text ? out : text.split(/\s+/).slice(0, Math.max(3, Math.ceil(text.split(/\s+/).length * 0.7))).join(" ");
  }
  if (/^Expand /.test(task))
    return `${text} In practice, this means each step is written down, so nobody has to guess what comes next.`;
  if (/formal, professional tone/.test(task)) return swaps(FORMAL)(text);
  if (/warm, friendly tone/.test(task)) return swaps(FRIENDLY)(text);
  if (/plain language/.test(task)) return tidy(swaps(PLAIN)(text));
  if (/^Fix the spelling/.test(task)) return swaps(GRAMMAR)(text);
  if (/^Make the whole document consistent/.test(task)) return swaps(CONSISTENT)(text);
  if (/as the user asks: .*\b(bullet|list)/i.test(task))
    return sentences(text)
      .map((s) => "- " + s.trim())
      .join("\n");
  return tidy(swaps(IMPROVE)(text));
}
function testSummary(text) {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^(#|[-*+] |\d+\. |>)/.test(p));
  const picked = paragraphs.slice(0, 3).map((p) => sentences(p)[0].trim());
  return "**In short:** " + (picked.join(" ") || "This document is short.");
}
export function canvasTestReply(messages) {
  if (messages?.[0]?.content !== CANVAS_SYSTEM) return null;
  const user = messages.find((m) => m.role === "user")?.content;
  if (typeof user !== "string") return null;
  const task = user.split("\n")[0];
  const block = (name) => {
    const m = new RegExp(`<document name="${name}">([\\s\\S]*?)</document>`).exec(user);
    return m ? unescapeDocumentText(m[1]) : null;
  };
  const text = block("Selection") ?? block("Document") ?? "";
  if (text.includes("[[canvas:junk]]")) return { text: "{ this isn't what was asked for" };
  const result = /^Write one short paragraph/.test(task) ? testSummary(text) : testRewrite(task, text);
  if (text.includes("[[canvas:length]]")) return { text: "<revised>" + result.slice(0, Math.ceil(result.length / 2)), finish: "length" };
  return { text: `<revised>\n${result}\n</revised>` };
}
