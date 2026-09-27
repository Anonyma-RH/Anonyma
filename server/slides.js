import { fail, wantsWebSearch } from "./core.js";
import { chatLimits, contextEstimate } from "../data/chat-limits.js";
import { unescapeDocumentText } from "../src/documents.js";
import {
  SLIDES_BASE_TOKENS,
  SLIDES_SYSTEM,
  SLIDE_SYSTEM,
  checkSlidesPayload,
  slidesMaxTokens,
  slidesMessages,
  slidesProblem,
} from "../src/slides-spec.js";

// Slides ("slides"): making a deck, or regenerating one slide of it, is an
// ordinary /api/chat request whose messages the server builds itself from
// the `slides` payload (src/slides-spec.js), the way Study Mode does. So it
// runs on chat's own reserve -> settle billing, with Spending Limits, Seed
// Guard, Private Mode, Privacy Trail, Model Status and failover as they are.
// It's always off the record: the request stores nothing. A deck the person
// keeps is saved separately (server/routes/slides.js), or only in their
// browser.
//
// Two things differ from a plain chat, both set in code in runChat, never
// from the request body:
// - the hold is exactly the quoted maximum (no hold margin), so the "up to"
//   figure the page shows, the balance and limit checks and the hold are
//   one number;
// - the reply is held back until it reads as slides (slidesAcceptor). A
//   reply that doesn't (unreadable, cut short, or a refusal) releases its
//   hold and charges nothing, and its text is never sent to the browser, so
//   an unusable reply can't be had for free either.
//
// Runs right after Study Mode's own check in runChat (Seed Guard then reads
// the built messages), and returns the checked payload, or undefined for a
// request without `slides`, which is left untouched.
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
  // A deck is kept, so a seed phrase is never sent for one: Seed Guard's
  // "Send anyway" doesn't apply here.
  "allow_seed_phrase",
];
export function prepareSlidesRequest(body, { quote = false } = {}) {
  if (!body || body.slides === undefined) return;
  const refuse = (message) => fail(400, message, "invalid_slides");
  if (!quote && body.ephemeral !== true)
    refuse("Slides are made off the record: send the request off the record.");
  for (const key of REFUSED)
    if (body[key] !== undefined && body[key] !== null)
      refuse("Making slides can't be combined with other chat options.");
  if (body.memory != null || wantsWebSearch(body))
    refuse("Making slides can't be combined with other chat options.");
  if (body.mode !== undefined && body.mode !== "chat")
    refuse("Making slides can't be combined with other chat options.");
  let payload;
  try {
    payload = checkSlidesPayload(body.slides);
  } catch (e) {
    refuse(e.message);
  }
  body.messages = slidesMessages(payload);
  body.max_tokens = slidesMaxTokens(payload);
  body.mode = "chat";
  return payload;
}

// The reply budget for the chosen model: slidesMaxTokens, lowered to the
// model's output cap and to what its context has left after the prompt (by
// the same conservative estimate chat's context check uses). Parsed output
// needs room: a model whose context leaves less than 8,000 tokens (or its
// whole output cap, when that's smaller) is refused before anything is held.
// Only the hold depends on it; the charge is the actual usage.
export function slidesBudget(payload, model, messages) {
  const limits = chatLimits(model);
  const room = (limits.contextTokens || 32768) - contextEstimate(messages);
  if (room < Math.min(SLIDES_BASE_TOKENS, limits.maxOutputTokens))
    fail(
      400,
      "This source is too long for this model to turn into slides. Choose a model with a larger context, or a shorter source. Nothing was sent or charged.",
      "slides_too_long",
    );
  return Math.max(1, Math.min(slidesMaxTokens(payload), limits.maxOutputTokens, room));
}

// runChat's acceptOutput for a slides request: true for a reply that reads
// as slides; otherwise it refuses with the plain reason (cut short, the
// model's own refusal, or unreadable), and runChat releases the hold.
export const slidesAcceptor = (payload) => (output, finishReason) => {
  const problem = slidesProblem(payload, output, finishReason);
  if (problem) fail(502, problem.message, problem.code);
  return true;
};

// Progress while a deck is written: how many slides have started, never
// any of the text (server/routes/chat.js sends it instead of the text).
export { streamedSlides } from "../src/slides-spec.js";

// ---- LOCAL_TEST_MODE only (server/provider.js) ----
// A deterministic stand-in for a model, so the whole flow can be driven
// without a provider. It reads the source back out of the prompt and lays
// its Markdown out as slides: # is the deck's title, each ## a slide, two
// ### under one ## a two-column slide, a "> quote — who" line a quote, and
// a leading figure ("0 prompts stored") a big number. It never invents
// facts. Markers in the source or instruction select other replies:
// [[slides:length]] cut short, [[slides:prose]] not JSON,
// [[slides:refuse]] a refusal, [[slides:fenced]] JSON in a code fence with
// prose around it, [[slides:shapes]] other JSON shapes and field names.
// Never used live.
const words = (s, n) => s.split(/\s+/).filter(Boolean).slice(0, n).join(" ");
const sentencesOf = (text) =>
  text
    .replace(/\*\*/g, "")
    .split(/(?<=[.!?。！？])\s+|\n+/)
    .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((s) => s.length > 3 && !/^#/.test(s) && !/^(User|Assistant):\s*$/.test(s));
const FIGURE = /^((?:[$€£¥])?\d[\d,.]*(?:\s?(?:%|×|x|k|m|bn|days?|hours?|seconds?|s))?)\s+(.{3,})$/i;

function sectionsOf(text) {
  const out = { title: "", intro: [], sections: [] };
  let section = null,
    sub = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/^(User|Assistant):\s+/, "").trim();
    if (!line) continue;
    let m;
    if ((m = /^#\s+(.+)$/.exec(line))) {
      if (!out.title) out.title = m[1].trim();
    } else if ((m = /^##\s+(.+)$/.exec(line))) {
      section = { heading: m[1].trim(), items: [], subs: [], quote: null };
      sub = null;
      out.sections.push(section);
    } else if ((m = /^###\s+(.+)$/.exec(line)) && section) {
      sub = { heading: m[1].trim(), items: [] };
      section.subs.push(sub);
    } else if ((m = /^>\s*(.+)$/.exec(line)) && section) {
      const [quote, who] = m[1].split(/\s+[—–-]{1,2}\s+/);
      section.quote = { quote: quote.replace(/^["“]|["”]$/g, ""), attribution: who || "" };
    } else {
      const items = /^\s*(?:[-*•]|\d+[.)])\s+/.test(raw) ? [line.replace(/^(?:[-*•]|\d+[.)])\s+/, "")] : sentencesOf(line);
      (sub || section || { items: out.intro }).items.push(...items.map((s) => s.replace(/\*\*/g, "")));
    }
  }
  return out;
}

function deckFrom(source, count) {
  const text = source.text;
  const doc = sectionsOf(text);
  const name = source.name.replace(/\.[a-z0-9]{1,5}$/i, "");
  const slides = [];
  const note = (s) => (s ? `Say: ${words(s, 24)}${s.split(/\s+/).length > 24 ? "…" : ""}` : "");
  slides.push({
    layout: "title",
    title: doc.title || (source.kind === "prompt" ? words(text, 8) : name),
    subtitle: doc.intro[0] || (source.kind === "prompt" ? "Made by the local test provider" : ""),
    notes: note(doc.intro[0]) || "Introduce the deck.",
  });
  for (const s of doc.sections) {
    if (slides.length >= count) break;
    const first = s.items[0] || "";
    const figure = FIGURE.exec(first);
    if (s.subs.length >= 2) {
      const col = (c) => ({ heading: c.heading, bullets: c.items.slice(0, 3).map((b) => words(b, 12)) });
      slides.push({ layout: "two-column", title: s.heading, left: col(s.subs[0]), right: col(s.subs[1]), notes: note(s.subs[0].items[0]) });
    } else if (s.quote) {
      slides.push({ layout: "quote", quote: s.quote.quote, attribution: s.quote.attribution, notes: note(first) || `Read the quote from ${s.heading}.` });
    } else if (figure) {
      slides.push({ layout: "big-number", title: s.heading, number: figure[1], label: words(figure[2], 16), notes: note(s.items[1] || first) });
    } else if (!s.items.length) {
      slides.push({ layout: "section", title: s.heading, subtitle: "", notes: `Now: ${s.heading}.` });
    } else {
      slides.push({ layout: "bullets", title: s.heading, bullets: s.items.slice(0, 5).map((b) => words(b, 12)), notes: note(first) });
    }
  }
  // Plain text without ## sections: its sentences, four to a slide.
  if (slides.length === 1) {
    const all = [...doc.intro.slice(1), ...doc.sections.flatMap((s) => s.items)];
    for (let i = 0; i < all.length && slides.length < count; i += 4)
      slides.push({
        layout: "bullets",
        title: words(all[i], 5),
        bullets: all.slice(i, i + 4).map((b) => words(b, 12)),
        notes: note(all[i]),
      });
  }
  if (source.kind === "prompt")
    while (slides.length < Math.min(count, 3))
      slides.push({
        layout: "bullets",
        title: `Part ${slides.length}`,
        bullets: ["Local test provider: a fixture, not a model", "Configure a gateway key for real slides"],
        notes: "",
      });
  return { title: slides[0].title, slides: slides.slice(0, count) };
}

function tighten(slide, instruction) {
  const short = (s) => words(s || "", 7);
  const out = { ...slide, notes: `Rewritten by the local test provider: ${instruction || "clearer and tighter"}.` };
  delete out.id;
  if (out.bullets) out.bullets = out.bullets.map(short).reverse();
  for (const k of ["left", "right"]) if (out[k]) out[k] = { ...out[k], bullets: out[k].bullets.map(short) };
  if (out.subtitle) out.subtitle = short(out.subtitle);
  if (out.label) out.label = short(out.label);
  return out;
}

export function slidesTestReply(messages) {
  const system = messages?.[0]?.content;
  if (system !== SLIDES_SYSTEM && system !== SLIDE_SYSTEM) return null;
  const user = String(messages.find((m) => m.role === "user")?.content || "");
  const all = unescapeDocumentText(user);
  const marker = /\[\[slides:(\w+)\]\]/.exec(all)?.[1];
  if (marker === "length") return { text: '{"title": "A deck that was cut', finish: "length" };
  if (marker === "prose") return { text: "Here are a few thoughts on your deck, in prose rather than JSON.", finish: "stop" };
  if (marker === "refuse") return { text: '{"error": "The source has nothing to present."}', finish: "stop" };
  if (system === SLIDE_SYSTEM) {
    const block = /<document name="Slide \d+">([\s\S]*?)<\/document>/.exec(user)?.[1];
    let slide = {};
    try {
      slide = JSON.parse(unescapeDocumentText(block || "{}"));
    } catch {}
    const instruction = /^Instruction: (.*)$/m.exec(user)?.[1] || "";
    const next = tighten(slide, instruction);
    if (marker === "layout") delete next.layout;
    return { text: JSON.stringify(next), finish: "stop" };
  }
  const count = Number(/^Task: exactly (\d+) slides\.$/m.exec(user)?.[1] || 8);
  const kind = /^Source: the prompt below\.$/m.test(user) ? "prompt" : /^Source: a saved chat\.$/m.test(user) ? "chat" : "document";
  const doc = /<document name="([^"]*)">([\s\S]*?)<\/document>/.exec(user);
  const source =
    kind === "prompt"
      ? { kind, name: "Prompt", text: user.split("\nPrompt:\n")[1] || "" }
      : { kind, name: unescapeDocumentText(doc?.[1] || "Document"), text: unescapeDocumentText(doc?.[2] || "") };
  const deck = deckFrom(source, Math.min(count, 20));
  if (marker === "fenced")
    return { text: "Sure! Here's the deck:\n```json\n" + JSON.stringify(deck, null, 2) + "\n```\nEnjoy.", finish: "stop" };
  if (marker === "shapes")
    return {
      text: JSON.stringify([
        { type: "Cover", title: ["Shapes", "test"], subtitle: { text: "Other field names" } },
        { layout: "Bullet Points", heading: "Points", points: [{ text: "**First** point" }, "- Second point"] },
        { layout: "stat", value: 42, caption: "An answer" },
        { layout: "columns", title: "Two sides", columns: [{ title: "Left", items: ["a", "b"] }, { title: "Right", points: "c\nd" }] },
        { layout: "quotation", text: "Short and plain.", author: "A reader" },
        { layout: "section-header", title: "The end" },
      ]),
      finish: "stop",
    };
  return { text: JSON.stringify(deck), finish: "stop" };
}
