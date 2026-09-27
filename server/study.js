import { fail, wantsWebSearch } from "./core.js";
import { chatLimits, contextEstimate } from "../data/chat-limits.js";
import { unescapeDocumentText } from "../src/documents.js";
import {
  STUDY_SYSTEM,
  checkStudyPayload,
  studyMaxTokens,
  studyMessages,
} from "../src/study-spec.js";

// Study Mode ("study"): making a deck is an ordinary /api/chat request whose
// messages the server builds itself from the `study` payload
// (src/study-spec.js), so it runs through chat's own reserve → settle
// billing, Spending Limits, Allowances, Seed Guard, Private Mode and Privacy
// Trail. It's always off the record: nothing about it is saved here. The
// deck itself is kept only in the person's browser.
//
// Runs first in runChat (and in /api/quote, which prices the same request),
// and returns the checked payload, or undefined for a request without
// `study`, which is left untouched.
const REFUSED = [
  "conversationId",
  "project",
  "taskTool",
  "double_check",
  "treasury",
  "messages",
  "sheets",
  "models",
  "depth",
  "question",
];
export function prepareStudyRequest(body, { quote = false } = {}) {
  if (!body || body.study === undefined) return;
  const refuse = (message) => fail(400, message, "invalid_study");
  if (!quote && body.ephemeral !== true)
    refuse("Study decks are made off the record: send the request off the record.");
  for (const key of REFUSED)
    if (body[key] !== undefined && body[key] !== null)
      refuse("Making a deck can't be combined with other chat options.");
  if (body.memory != null || wantsWebSearch(body))
    refuse("Making a deck can't be combined with other chat options.");
  if (body.mode !== undefined && body.mode !== "chat")
    refuse("Making a deck can't be combined with other chat options.");
  let payload;
  try {
    payload = checkStudyPayload(body.study);
  } catch (e) {
    refuse(e.message);
  }
  body.messages = studyMessages(payload);
  body.max_tokens = studyMaxTokens(payload);
  body.mode = "chat";
  return payload;
}

// The deck's reply budget for the chosen model: studyMaxTokens, lowered to
// the model's output cap and to what its context has left after the prompt.
// Only the hold depends on it; the charge is the actual usage.
export function studyBudget(payload, model, messages) {
  const limits = chatLimits(model);
  const room = (limits.contextTokens || 32768) - contextEstimate(messages);
  return Math.max(
    1,
    Math.min(studyMaxTokens(payload), limits.maxOutputTokens, room),
  );
}

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for a
// model, so the whole flow can be driven without a provider. It reads the
// source back out of the prompt and makes fill-in-the-blank cards and
// questions from its sentences, each with the sentence as its snippet.
// Never used live.
export function studyTestReply(messages) {
  if (messages?.[0]?.content !== STUDY_SYSTEM) return null;
  const user = messages.find((m) => m.role === "user")?.content;
  if (typeof user !== "string") return null;
  const block = /<document name="([^"]*)">([\s\S]*?)<\/document>/.exec(user);
  if (!block) return null;
  const name = unescapeDocumentText(block[1]).replace(/\.[a-z0-9]{1,5}$/i, "");
  const source = unescapeDocumentText(block[2]);
  const task = /^Task: (.*)$/m.exec(user)?.[1] || "";
  const cards = Number(/up to (\d+) flashcards/.exec(task)?.[1] || 0);
  const quiz = Number(/up to (\d+) quiz questions/.exec(task)?.[1] || 0);
  const sentences = source
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => {
      const words = s.split(" ").length;
      return words >= 6 && words <= 45 && !/^(user|assistant):/i.test(s);
    });
  // The blank is the term a sentence defines ("a process called X", "X
  // turns…"), else the longest word in its second half.
  const STOP = /^(which|there|their|these|those|about|would|could|should|after|before|through|between|without)$/i;
  const keyOf = (s) => {
    const named = /\b(?:called|known as|named)\s+([A-Za-z][A-Za-z-]{3,})/.exec(s)?.[1];
    if (named) return named;
    const first = /^([A-Z][a-z-]{7,})\s/.exec(s)?.[1];
    if (first && !STOP.test(first)) return first;
    const words = s.split(" ");
    return (words.slice(Math.floor(words.length / 2)).join(" ").match(/[A-Za-z][A-Za-z-]{4,}/g) || [])
      .filter((w) => !STOP.test(w))
      .reduce((a, b) => (b.length > a.length ? b : a), "");
  };
  const facts = sentences
    .map((s) => ({ s, key: keyOf(s) }))
    .filter((f) => f.key);
  if (!facts.length)
    return JSON.stringify({ error: "The source has no full sentences to study." });
  const blank = (f) => f.s.replace(f.key, "_____");
  // Pasted text has no name of its own: the first words stand in, as a
  // model's title would.
  const title =
    name && name !== "Pasted text"
      ? name
      : sentences[0]?.split(" ").slice(0, 3).join(" ").replace(/[,.;:]$/, "") || "Study deck";
  const out = { title };
  if (cards)
    out.cards = facts.slice(0, cards).map((f) => ({
      front: blank(f),
      back: f.key,
      snippet: f.s,
    }));
  if (quiz) {
    const keys = [...new Set(facts.map((f) => f.key))];
    out.quiz = facts.slice(0, quiz).map((f, i) => {
      const others = keys.filter((k) => k !== f.key);
      const wrong = [0, 1, 2].map(
        (j) => others[(i + j * 3 + 1) % Math.max(1, others.length)] || `Option ${j + 1}`,
      );
      const answer = i % 4;
      const options = [...wrong];
      options.splice(answer, 0, f.key);
      return {
        question: `Which word completes this? ${blank(f)}`,
        options: [...new Set(options)].length === 4 ? options : [f.key, "None of these", "All of these", "Not stated"],
        answer: [...new Set(options)].length === 4 ? answer : 0,
        explanation: `The source uses “${f.key}” here.`,
        snippet: f.s,
      };
    });
  }
  return JSON.stringify(out);
}
