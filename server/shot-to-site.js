import { fail, wantsWebSearch } from "./core.js";
import { chatLimits, contextEstimate } from "../data/chat-limits.js";
import { unescapeDocumentText } from "../src/documents.js";
import {
  CHANGE_SYSTEM,
  MAX_PAGE_CHARS,
  MIN_ROOM_TOKENS,
  SITE_SYSTEM,
  checkSitePayload,
  siteMaxTokens,
  siteMessages,
  siteProblem,
} from "../src/site-spec.js";

// Screenshot to site ("shottosite"): turning a picture into a page, or
// changing that page with words, is an ordinary /api/chat request whose
// messages the server builds itself from the `shottosite` payload
// (src/site-spec.js), the way Slides does. So it runs on chat's own
// reserve -> settle billing, with Spending Limits, Seed Guard, Private Mode,
// Privacy Trail, Model Status and failover as they are. It's always off the
// record: the request stores nothing, not even the picture. A page the person
// keeps is saved separately, as an ordinary conversation
// (server/routes/shot-to-site.js).
//
// Two things differ from a plain chat, both set in code in runChat, never
// from the request body:
// - the hold is exactly the quoted maximum (no hold margin), so the "up to"
//   figure the page shows, the balance and limit checks and the hold are
//   one number;
// - the reply is held back until it reads as a page (siteAcceptor). A reply
//   that doesn't (unreadable, cut short, too long, or a refusal) releases
//   its hold and charges nothing, and its text is never sent to the
//   browser, so an unusable reply can't be had for free either.
//
// The picture is priced like any image in a chat (its data URL's length, in
// server/core.js quote). To ask what a request costs, the browser sends only
// the picture's kind and length ({ mime, chars }): the price is worked out on
// a stand-in of exactly that length, so the estimate equals the hold and the
// picture itself isn't sent before the person presses the button.
//
// Runs right after Slides' own check in runChat (Seed Guard then reads the
// built messages), and returns the checked payload, or undefined for a
// request without `shottosite`, which is left untouched.
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
  "slides",
  "canvas",
  "repo",
  "models",
  "depth",
  "question",
  // A page is kept, so a seed phrase is never sent for one: Seed Guard's
  // "Send anyway" doesn't apply here.
  "allow_seed_phrase",
];
export function prepareSiteRequest(body, { quote = false } = {}) {
  if (!body || body.shottosite === undefined) return;
  const refuse = (message) => fail(400, message, "invalid_shottosite");
  if (!quote && body.ephemeral !== true)
    refuse("Pages are made off the record: send the request off the record.");
  for (const key of REFUSED)
    if (body[key] !== undefined && body[key] !== null)
      refuse("Making a page can't be combined with other chat options.");
  if (body.memory != null || wantsWebSearch(body))
    refuse("Making a page can't be combined with other chat options.");
  if (body.mode !== undefined && body.mode !== "chat")
    refuse("Making a page can't be combined with other chat options.");
  let payload;
  try {
    payload = checkSitePayload(body.shottosite, { quote });
  } catch (e) {
    refuse(e.message);
  }
  body.messages = siteMessages(payload);
  body.max_tokens = siteMaxTokens(payload);
  body.mode = "chat";
  return payload;
}

// The reply budget for the chosen model: siteMaxTokens, lowered to the
// model's output cap and to what its context has left after the prompt (by
// the same conservative estimate chat's context check uses). Parsed output
// needs room: a model whose context leaves less than 8,000 tokens (or its
// whole output cap, when that's smaller) is refused before anything is held.
// Only the hold depends on it; the charge is the actual usage.
export function siteBudget(payload, model, messages) {
  const limits = chatLimits(model);
  const room = (limits.contextTokens || 32768) - contextEstimate(messages);
  if (room < Math.min(MIN_ROOM_TOKENS, limits.maxOutputTokens))
    fail(
      400,
      "This picture and page are too long for this model to work with. Choose a model with a larger context, or a smaller picture. Nothing was sent or charged.",
      "site_too_long",
    );
  return Math.max(1, Math.min(siteMaxTokens(payload), limits.maxOutputTokens, room));
}

// runChat's acceptOutput for a page request: true for a reply that reads as
// a page; otherwise it refuses with the plain reason (cut short, too long,
// the model's own refusal, or unreadable), and runChat releases the hold.
export const siteAcceptor = (payload) => (output, finishReason) => {
  const problem = siteProblem(payload, output, finishReason);
  if (problem) fail(502, problem.message, problem.code);
  return true;
};

// Progress while a page is written: how many characters so far, never any of
// the text (server/routes/chat.js sends it instead of the text).
export { streamedPage } from "../src/site-spec.js";

// ---- LOCAL_TEST_MODE only (server/provider.js) ----
// A deterministic stand-in for a model, so the whole flow can be driven
// without a provider. It builds a small landing page from the notes, and a
// change edits the page it is given: an instruction that names a colour
// sets the page's accent, and every change adds a line saying what was
// asked. It never invents facts. Markers in the notes or instruction select
// other replies: [[site:length]] cut short, [[site:prose]] no page,
// [[site:refuse]] a refusal, [[site:fenced]] a code fence with prose around
// it, [[site:fragment]] markup without a document, [[site:json]] the page in
// JSON, [[site:external]] a page that reaches outside itself,
// [[site:long]] a page over the size limit. Never used live.
const esc = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const COLOURS = {
  blue: "#0135df",
  brown: "#7a4a24",
  green: "#0a7f4f",
  red: "#c22d2d",
  orange: "#d9650a",
  purple: "#6a3fc4",
  black: "#141a2b",
  pink: "#c73a8a",
  teal: "#0a7f86",
};
const CSS = `:root{--accent:#0135df;--ink:#18233f;--soft:#eef2fb}
*{box-sizing:border-box}
body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);line-height:1.5;background:#fff}
nav{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:14px 5vw;border-bottom:1px solid #e2e6ee}
nav b{font-size:18px}
nav a{color:var(--ink);text-decoration:none;margin-left:18px;font-size:14px}
.hero{padding:56px 5vw 40px;background:var(--soft)}
.hero h1{font-size:clamp(28px,5vw,46px);line-height:1.1;margin:0 0 12px;max-width:16ch}
.hero p{max-width:52ch;margin:0 0 20px;color:#48536d}
.btn{display:inline-block;background:var(--accent);color:#fff;padding:12px 20px;border-radius:2px;text-decoration:none;font-weight:600}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;padding:32px 5vw}
.card{border:1px solid #e2e6ee;padding:18px}
.card i{display:block;width:28px;height:28px;background:var(--accent);margin-bottom:12px}
.card h2{font-size:17px;margin:0 0 6px}
.card p{margin:0;font-size:14px;color:#48536d}
.notes,.changed{margin:0 5vw 24px;padding:12px 14px;border-left:4px solid var(--accent);background:var(--soft);font-size:14px}
footer{padding:20px 5vw;border-top:1px solid #e2e6ee;font-size:13px;color:#606a80}`;

// Notes written as "Brand: headline. More words." name the page and give it a
// headline; anything else goes in the notes line.
function landing(notes, extra = "") {
  const named = /^([^:.]{2,30}):\s*([^.]{3,90})\.?/.exec(notes);
  const brand = named ? named[1].trim() : "Northwind";
  const headline = named ? named[2].trim() : "A page drawn from your picture";
  const wants = COLOURS[/\b(blue|brown|green|red|orange|purple|black|pink|teal)\b/i.exec(notes)?.[1]?.toLowerCase()] || "";
  return [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${esc(brand === "Northwind" ? "Sample page" : brand)}</title>`,
    `<style>${CSS.replace("--accent:#0135df", "--accent:" + (wants || "#0135df"))}${extra}</style>`,
    "</head>",
    "<body>",
    `<nav><b>${esc(brand)}</b><span><a href="#">Product</a><a href="#">Pricing</a><a href="#">Contact</a></span></nav>`,
    "<main>",
    '<section class="hero">',
    `<h1>${esc(headline)}</h1>`,
    "<p>The layout, the colours and the words in the picture, rebuilt as a page you can change with words.</p>",
    '<a class="btn" href="#">Get started</a>',
    "</section>",
    '<section class="cards">',
    '<div class="card"><i></i><h2>Clear layout</h2><p>Rows and columns follow the picture.</p></div>',
    '<div class="card"><i></i><h2>Your colours</h2><p>Blocks keep the shades you drew.</p></div>',
    '<div class="card"><i></i><h2>Real text</h2><p>Words are copied where they can be read.</p></div>',
    "</section>",
    notes && !named ? `<p class="notes">Notes: ${esc(notes)}</p>` : "",
    "</main>",
    "<footer>Made by the local test provider: a fixture, not a model.</footer>",
    "</body>",
    "</html>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function siteTestReply(messages) {
  const system = messages?.[0]?.content;
  if (system !== SITE_SYSTEM && system !== CHANGE_SYSTEM) return null;
  const content = messages.find((m) => m.role === "user")?.content;
  const user = String(typeof content === "string" ? content : content?.find((p) => p.type === "text")?.text || "");
  const all = unescapeDocumentText(user);
  const marker = /\[\[site:(\w+)\]\]/.exec(all)?.[1];
  if (marker === "length") return { text: "<!doctype html><html><head><style>body{margin:0", finish: "length" };
  if (marker === "prose") return { text: "Here is how I would lay this page out, in prose rather than code.", finish: "stop" };
  if (marker === "refuse") return { text: "ERROR: The picture is blank, so there is nothing to build a page from.", finish: "stop" };
  let html;
  if (system === CHANGE_SYSTEM) {
    const block = /<document name="Current page">([\s\S]*?)<\/document>/.exec(user)?.[1];
    const current = unescapeDocumentText(block || "");
    const instruction = /^Instruction: (.*)$/m.exec(user)?.[1] || "";
    const colour = COLOURS[/\b(blue|green|red|orange|purple|black|pink|teal)\b/i.exec(instruction)?.[1]?.toLowerCase()];
    html = current
      .replace(/--accent:#[0-9a-f]{6}/i, (all) => (colour ? "--accent:" + colour : all))
      .replace(/<\/main>|<\/body>/i, (tag) => `<p class="changed">Changed: ${esc(instruction)}</p>\n${tag}`);
  } else {
    const notes = /^Notes from the person: (.*)$/m.exec(user)?.[1] || "";
    html = landing(notes === "none" ? "" : notes.replace(/\[\[site:\w+\]\]/g, "").trim());
  }
  if (marker === "external")
    html = html.replace("</head>", '<link rel="stylesheet" href="https://fonts.example.invalid/x.css">\n<script src="https://cdn.example.invalid/x.js"></script>\n</head>');
  if (marker === "long") html = html.replace("</body>", `<!-- ${"x".repeat(MAX_PAGE_CHARS)} -->\n</body>`);
  if (marker === "fenced") return { text: "Sure! Here's the page:\n```html\n" + html + "\n```\nEnjoy.", finish: "stop" };
  if (marker === "fragment") return { text: html.slice(html.indexOf("<nav>"), html.indexOf("</main>") + 7), finish: "stop" };
  if (marker === "json") return { text: JSON.stringify({ html: html.split("\n") }), finish: "stop" };
  return { text: html, finish: "stop", ...(marker === "long" ? { chunk: 4000 } : {}) };
}
