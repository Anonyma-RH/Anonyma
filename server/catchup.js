import { fail, wantsWebSearch } from "./core.js";
import { chatLimits, contextEstimate } from "../data/chat-limits.js";
import {
  CATCHUP_REPLY_TOKENS,
  CATCHUP_SYSTEM,
  catchupMessages,
  checkCatchupPayload,
} from "../src/catchup.js";
import { unescapeDocumentText } from "../src/documents.js";

// Summarize & Continue ("catchup"): a Catch me up request is an ordinary
// /api/chat request whose messages the server builds itself from the
// `catchup` payload (a transcript: [{ role, text }]), the way Local Sheets
// does. So it runs on chat's own reserve -> settle billing, with Spending
// Limits, Seed Guard, Private Mode, Privacy Trail and failover as they are.
// It's always off the record: the summary is shown in the browser and the
// request stores nothing. /api/quote builds the same messages, so the
// estimate prices exactly what the request sends.
//
// Runs right after Local Sheets' own check in runChat (Seed Guard then
// reads the built messages), and returns true for a catch-up request,
// leaving any other request untouched.
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
export function prepareCatchupRequest(body) {
  if (!body || body.catchup === undefined) return false;
  const refuse = (message) => fail(400, message, "invalid_catchup");
  if (body.ephemeral !== true)
    refuse("A catch-up summary is never saved: send it off the record.");
  for (const key of REFUSED)
    if (body[key] !== undefined && body[key] !== null)
      refuse("A catch-up summary can't be combined with other chat options.");
  if (body.memory != null || wantsWebSearch(body))
    refuse("A catch-up summary can't be combined with other chat options.");
  if (body.mode !== undefined && !["chat", "code", "uncensored"].includes(body.mode))
    refuse("Catch me up works in chat, code and Uncensored.");
  let transcript;
  try {
    transcript = checkCatchupPayload(body.catchup);
  } catch (e) {
    fail(400, e.message, e.message.startsWith("Catch me up works on chats") ? "catchup_too_short" : "invalid_catchup");
  }
  body.messages = catchupMessages(transcript);
  return true;
}

// The summary's reply room for this model: CATCHUP_REPLY_TOKENS, lowered to
// the model's output cap and to what its context has left after the
// transcript (by the same conservative estimate chat's context check uses).
// A transcript that leaves too little room is refused before anything is
// held: the browser trims the oldest turns to fit, so this is a backstop.
export function catchupBudget(model, messages) {
  const limits = chatLimits(model);
  const room = (limits.contextTokens || 32768) - contextEstimate(messages);
  if (room < 2000)
    fail(
      400,
      "This chat is too long for this model to summarize. Choose a model with a larger context. Nothing was sent or charged.",
      "catchup_too_long",
    );
  return Math.max(1, Math.min(CATCHUP_REPLY_TOKENS, limits.maxOutputTokens, room));
}

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for a
// model, so the whole flow can be driven without a provider. It reads the
// transcript back out of the prompt and picks lines from it; it never
// invents anything. A transcript containing "[[catchup:length]]" ends like
// a reply that ran out of room. Never used live.
export function catchupTestReply(messages) {
  if (messages?.[0]?.content !== CATCHUP_SYSTEM) return null;
  const user = messages.find((m) => m.role === "user")?.content;
  if (typeof user !== "string") return null;
  const body = /<conversation>\n([\s\S]*)\n<\/conversation>/.exec(user)?.[1] || "";
  const turns = body
    .split(/\n\n(?=\[(?:User|Assistant)\]\n)/)
    .map((block) => {
      const m = /^\[(User|Assistant)\]\n([\s\S]*)$/.exec(block);
      return m ? { role: m[1] === "User" ? "user" : "assistant", text: unescapeDocumentText(m[2]) } : null;
    })
    .filter(Boolean);
  if (body.includes("[[catchup:length]]"))
    return { text: '{"key_points": ["The chat covered', finish: "length" };
  const sentences = (text) =>
    text
      .replace(/^#+\s*/gm, "")
      .replace(/\*\*/g, "")
      .split(/(?<=[.!?。！？])\s+|\n+/)
      .map((s) => s.replace(/^[-*\d.)\s]+/, "").trim())
      .filter((s) => s.length > 3);
  const first = (text) => sentences(text)[0] || "";
  const short = (s) => (s.length > 160 ? s.slice(0, 157).trimEnd() + "…" : s);
  const replies = turns.filter((t) => t.role === "assistant");
  const asks = turns.filter((t) => t.role === "user");
  const all = turns.flatMap((t) => sentences(t.text));
  const keyPoints = [...new Set(replies.map((t) => short(first(t.text))).filter(Boolean))].slice(0, 5);
  const decisions = [
    ...new Set(
      all
        .filter((s) => /\b(decided|agreed|we'll go with|let's go with|going with|settled on|confirmed)\b|决定|确定/i.test(s))
        .map(short),
    ),
  ].slice(0, 3);
  const openQuestions = [
    ...new Set(asks.slice(-3).flatMap((t) => sentences(t.text).filter((s) => /[?？]$/.test(s))).map(short)),
  ].slice(-2);
  const last = asks.at(-1);
  const summary = {
    key_points: keyPoints.length ? keyPoints : ["Local test provider: this is a fixture, not a model."],
    decisions,
    open_questions: openQuestions,
    left_off: last ? short(`You last asked: ${first(last.text)}`) : "",
  };
  return { text: JSON.stringify(summary, null, 1), finish: "stop" };
}
