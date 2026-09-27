// Study Mode, the browser's side: pure helpers only (sources, reading the
// model's deck, spaced repetition, streaks, quiz scores, export and import).
// No DOM, React or IndexedDB here, so tests run them in node; the page is
// src/Study.jsx and storage is src/study-store.js.
import {
  MAX_SOURCE_CHARS,
  MAX_SOURCE_BLOCK,
  MIN_SOURCE_CHARS,
  STUDY_LIMITS,
  sourceBlock,
} from "./study-spec.js";
import { parseDocumentBlocks } from "./documents.js";
import { unveil } from "./veil.js";

const newId = () =>
  globalThis.crypto?.randomUUID?.() ||
  Math.random().toString(36).slice(2) + Date.now().toString(36);

// ---- Sources ----

// Line endings normalised, control characters other than tabs and line
// breaks dropped, and the ends trimmed: what the server checks for.
export function cleanSource(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
}
export function cleanName(name, fallback = "Pasted text") {
  const v = String(name ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, STUDY_LIMITS.name)
    .trim();
  return v || fallback;
}
// The source as sent: at most MAX_SOURCE_CHARS characters, and short enough
// that its escaped block fits the message cap. `total` is the full length.
export function fitSource(name, text) {
  const all = cleanSource(text);
  let kept = all.slice(0, MAX_SOURCE_CHARS);
  const markup = sourceBlock(name, "").length;
  for (let i = 0; i < 12; i++) {
    const length = sourceBlock(name, kept).length;
    if (length <= MAX_SOURCE_BLOCK) break;
    // Escaping makes text longer than its character count, so scale by the
    // ratio actually seen, and step down a little more each round.
    const ratio = (length - markup) / Math.max(1, kept.length);
    const target = Math.floor((MAX_SOURCE_BLOCK - markup) / ratio) - 16 * (i + 1);
    kept = kept.slice(0, Math.max(0, Math.min(kept.length - 1, target)));
  }
  kept = kept.trim();
  return { text: kept, cut: kept.length < all.length, total: all.length };
}
export const tooShort = (text) => cleanSource(text).length < MIN_SOURCE_CHARS;

// A saved chat as a study source: each turn labelled, a user's attached
// documents with their text, and replies without their hidden reasoning.
// Messages are as messageFromServer (src/lib.js) returns them.
export function chatTranscript(messages) {
  const turns = [];
  for (const m of messages || []) {
    if (m?.role === "user") {
      const { text, documents } = parseDocumentBlocks(m.content || "");
      const parts = [];
      if (text.trim()) parts.push(text.trim());
      for (const d of documents)
        if (d.text?.trim()) parts.push(`Attached document "${d.name}":\n${d.text.trim()}`);
      if (parts.length) turns.push("User: " + parts.join("\n\n"));
    } else if (m?.role === "assistant") {
      const text = String(m.content || "").trim();
      if (text) turns.push("Assistant: " + text);
    }
  }
  return turns.join("\n\n");
}

// The `study` payload for /api/chat and /api/quote. `mask` is Veil's (or
// the identity): it runs on the source's name and text before they're cut
// to size, so what's counted is what's sent.
export function studyPayload(source, { make, count, level }, mask = (s) => s) {
  const name = cleanName(mask(cleanName(source?.name)));
  const fitted = fitSource(name, mask(cleanSource(source?.text)));
  return {
    payload: {
      make,
      count,
      level,
      source: { kind: source?.kind, name, text: fitted.text },
    },
    cut: fitted.cut,
    total: fitted.total,
  };
}

// ---- Reading the model's deck ----

export const TRUNCATED_MESSAGE =
  "The model ran out of room while writing the deck. Nothing was saved. Try fewer cards, or pick a faster model.";
export const UNREADABLE_MESSAGE =
  "The model's reply wasn't a deck Study Mode can read. Nothing was saved. Try again, or choose another model.";
export const ITEM_LIMITS = {
  title: 120,
  front: 400,
  back: 1200,
  snippet: 600,
  question: 500,
  option: 300,
  options: 6,
  explanation: 1200,
  items: 500,
};

// The first complete JSON object in a reply, allowing code fences or text
// around it. Null when there's none.
export function extractJSON(text) {
  const s = String(text ?? "");
  for (let start = s.indexOf("{"); start >= 0; start = s.indexOf("{", start + 1)) {
    let depth = 0,
      inString = false,
      escaped = false;
    for (let i = start; i < s.length; i++) {
      const c = s[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === "\\") escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          const v = JSON.parse(s.slice(start, i + 1));
          if (v && typeof v === "object" && !Array.isArray(v)) return v;
        } catch {}
        break;
      }
    }
  }
  return null;
}

const oneLine = (v, max) =>
  typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, max).trim() : "";
const block = (v, max) =>
  typeof v === "string"
    ? v.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim().slice(0, max).trim()
    : "";

// Whether a snippet appears in the source: compared without case, quote
// style or spacing differences. A snippet the model shortened with "…" is
// found if every piece of it is.
const fold = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[‘’‚′]/g, "'")
    .replace(/[“”„″]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
export function grounded(snippet, source) {
  const hay = fold(source);
  const pieces = fold(snippet)
    .split(/\.\.\.|…/)
    .map((p) => p.replace(/^[\s"'.,;:([-]+|[\s"',;:)\]-]+$/g, "").trim())
    .filter(Boolean);
  if (!pieces.length || !hay) return false;
  return pieces.every((p) => p.length >= 8 && hay.includes(p));
}

// One card or question, checked; null when it isn't usable.
function readCard(c, source) {
  if (!c || typeof c !== "object") return null;
  const front = block(c.front, ITEM_LIMITS.front),
    back = block(c.back, ITEM_LIMITS.back);
  if (!front || !back) return null;
  const snippet = block(c.snippet, ITEM_LIMITS.snippet);
  return { id: newId(), front, back, snippet, grounded: source == null ? !!c.grounded : grounded(snippet, source) };
}
function readQuestion(q, source) {
  if (!q || typeof q !== "object") return null;
  const question = block(q.question, ITEM_LIMITS.question);
  if (!question || !Array.isArray(q.options)) return null;
  const options = q.options.map((o) => oneLine(o, ITEM_LIMITS.option));
  if (options.length < 2 || options.length > ITEM_LIMITS.options || options.some((o) => !o)) return null;
  if (new Set(options.map((o) => o.toLowerCase())).size !== options.length) return null;
  const answer = q.answer;
  if (!Number.isInteger(answer) || answer < 0 || answer >= options.length) return null;
  const snippet = block(q.snippet, ITEM_LIMITS.snippet);
  return {
    id: newId(),
    question,
    options,
    answer,
    explanation: block(q.explanation, ITEM_LIMITS.explanation),
    snippet,
    grounded: source == null ? !!q.grounded : grounded(snippet, source),
  };
}

// The model's reply, read. Resolves to one of:
//   { truncated: true }          cut off at its reply budget (finish_reason
//                                "length") before the JSON closed
//   { refusal }                  the model said the source has nothing to study
//   { problems: [...] }          not a deck
//   { deck, dropped, ungrounded } the usable cards and questions, at most
//                                `count` of each; `dropped` counts the rest
// `source` is the text as sent, for the snippet check.
export function readDeck(text, { make, count, source, finishReason = null }) {
  const obj = extractJSON(text);
  if (!obj) {
    if (finishReason === "length") return { truncated: true };
    return { problems: ["The reply wasn't a single JSON object."] };
  }
  if (typeof obj.error === "string" && obj.error.trim() && !obj.cards && !obj.quiz)
    return { refusal: oneLine(obj.error, 300) };
  const wantCards = make !== "quiz",
    wantQuiz = make !== "cards";
  const rawCards = wantCards && Array.isArray(obj.cards) ? obj.cards : [];
  const rawQuiz = wantQuiz && Array.isArray(obj.quiz) ? obj.quiz : [];
  const cards = rawCards.map((c) => readCard(c, source)).filter(Boolean).slice(0, count);
  const quiz = rawQuiz.map((q) => readQuestion(q, source)).filter(Boolean).slice(0, count);
  if (!cards.length && !quiz.length) {
    if (finishReason === "length") return { truncated: true };
    return { problems: ["The reply had no usable cards or questions."] };
  }
  const dropped = rawCards.length + rawQuiz.length - cards.length - quiz.length;
  const ungrounded = [...cards, ...quiz].filter((x) => !x.grounded).length;
  return {
    deck: { title: oneLine(obj.title, ITEM_LIMITS.title), cards, quiz },
    dropped: Math.max(0, dropped),
    ungrounded,
  };
}

// A plain line when a deck came back smaller than asked for: not an error.
// The model writes fewer only when the source is too short (STUDY_SYSTEM),
// unless some of what it wrote wasn't usable (`dropped`). Null when the deck
// has as many as asked for.
const count = (n, one, many) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
export function shortfallNote({ cards = 0, quiz = 0 }, { make, count: asked, dropped = 0 }) {
  const wantCards = make !== "quiz",
    wantQuiz = make !== "cards";
  if (!(wantCards && cards < asked) && !(wantQuiz && quiz < asked)) return null;
  const made = [
    wantCards ? count(cards, "card", "cards") : null,
    wantQuiz ? count(quiz, "question", "questions") : null,
  ]
    .filter(Boolean)
    .join(" and ");
  return dropped
    ? `Made ${made}; the rest weren't usable and were left out.`
    : `Made ${made}: the source had enough for that many.`;
}

// How many cards and questions a reply streamed so far has started, for
// the progress line while a deck is written.
export function streamedCount(text) {
  const s = String(text ?? "");
  return {
    cards: (s.match(/"front"\s*:/g) || []).length,
    quiz: (s.match(/"question"\s*:/g) || []).length,
  };
}

// Veil: every text field restored with this browser's map.
export function restoreDeck(deck, map) {
  if (!map || !Object.keys(map).length) return deck;
  const u = (s) => unveil(s, map);
  return {
    ...deck,
    title: u(deck.title),
    cards: deck.cards.map((c) => ({ ...c, front: u(c.front), back: u(c.back), snippet: u(c.snippet) })),
    quiz: deck.quiz.map((q) => ({
      ...q,
      question: u(q.question),
      options: q.options.map(u),
      explanation: u(q.explanation),
      snippet: u(q.snippet),
    })),
  };
}

// A new deck as stored in this browser. The source's text isn't kept:
// only its kind, name and length, and each card's snippet.
export function newDeck({ title, source, make, count, level, model, cards, quiz, now = Date.now() }) {
  return {
    id: newId(),
    title: oneLine(title, ITEM_LIMITS.title) || cleanName(source?.name, "Study deck"),
    created: now,
    updated: now,
    source: {
      kind: source?.kind || "text",
      name: cleanName(source?.name),
      chars: Number(source?.chars) || 0,
    },
    made: { make, count, level, model: model || null },
    cards: cards || [],
    quiz: quiz || [],
    quizStats: null,
  };
}

// ---- Spaced repetition: SM-2 ----
//
// Each card keeps { reps, ease, interval (days), due (ms), lapses, last }.
// A card with no review yet is new. Grades map to SM-2 qualities: Again 1,
// Hard 3, Good 4, Easy 5. The ease factor moves by SM-2's formula (never
// below 1.3). Again starts the card over and brings it back in 10 minutes;
// the first good answer waits 1 day, the second 6, then the interval grows
// by the ease factor (Hard by 1.2 instead, Easy by an extra 1.3).

export const GRADES = ["again", "hard", "good", "easy"];
export const MINUTE = 60 * 1000;
export const DAY = 24 * 60 * MINUTE;
export const RELEARN = 10 * MINUTE;
export const MAX_INTERVAL = 3650;
const QUALITY = { again: 1, hard: 3, good: 4, easy: 5 };

export const newSrs = () => ({ reps: 0, ease: 2.5, interval: 0, due: 0, lapses: 0, last: 0 });
export function schedule(srs, grade, now = Date.now()) {
  if (!GRADES.includes(grade)) throw Error("Unknown grade.");
  const s = { ...newSrs(), ...(srs || {}) };
  const q = QUALITY[grade];
  const ease = Math.max(1.3, Math.round((s.ease + 0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)) * 100) / 100);
  if (grade === "again")
    return { reps: 0, ease, interval: 0, due: now + RELEARN, lapses: s.lapses + 1, last: now };
  let interval;
  if (s.reps === 0) interval = { hard: 1, good: 1, easy: 4 }[grade];
  else if (s.reps === 1) interval = { hard: 3, good: 6, easy: 8 }[grade];
  else {
    const grow = { hard: 1.2, good: ease, easy: ease * 1.3 }[grade];
    interval = Math.max(s.interval + 1, Math.round(s.interval * grow));
  }
  interval = Math.min(MAX_INTERVAL, interval);
  return { reps: s.reps + 1, ease, interval, due: now + interval * DAY, lapses: s.lapses, last: now };
}
// What each button would do, in ms from now, for its label.
export function nextIntervals(srs, now = Date.now()) {
  return Object.fromEntries(GRADES.map((g) => [g, schedule(srs, g, now).due - now]));
}
// "10 min", "1 day", "6 days", "3 months", "1.5 years".
export function formatInterval(ms) {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${Math.max(1, minutes)} min`;
  const days = Math.round(ms / DAY);
  if (days < 1) {
    const hours = Math.round(ms / (60 * MINUTE));
    return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (days < 31) return `${days} ${days === 1 ? "day" : "days"}`;
  if (days < 365) {
    const months = Math.round(days / 30);
    return `${months} ${months === 1 ? "month" : "months"}`;
  }
  const years = Math.round((days / 365) * 10) / 10;
  return `${years} ${years === 1 ? "year" : "years"}`;
}
export const isNew = (card) => !card?.srs || (!card.srs.last && !card.srs.reps);
export const isDue = (card, now = Date.now()) => !isNew(card) && card.srs.due <= now;
export function deckCounts(deck, now = Date.now()) {
  const cards = deck?.cards || [];
  let due = 0,
    fresh = 0,
    learned = 0;
  for (const c of cards) {
    if (isNew(c)) fresh++;
    else {
      if (c.srs.due <= now) due++;
      if (c.srs.reps > 0) learned++;
    }
  }
  return { due, new: fresh, learned, total: cards.length };
}
export function totalCounts(decks, now = Date.now()) {
  return (decks || []).reduce(
    (t, d) => {
      const c = deckCounts(d, now);
      return { due: t.due + c.due, new: t.new + c.new, cards: t.cards + c.total };
    },
    { due: 0, new: 0, cards: 0 },
  );
}
export const NEW_PER_SESSION = 20;
// A session's cards: those due, the longest-waiting first, then new cards
// in the deck's order, at most `newLimit` of them.
export function reviewQueue(deck, now = Date.now(), { newLimit = NEW_PER_SESSION } = {}) {
  const cards = deck?.cards || [];
  const due = cards.filter((c) => isDue(c, now)).sort((a, b) => a.srs.due - b.srs.due);
  const fresh = cards.filter(isNew).slice(0, newLimit);
  return [...due, ...fresh].map((c) => c.id);
}
// When the next card in a deck comes due, or null when none is scheduled.
export function nextDue(deck) {
  const times = (deck?.cards || []).filter((c) => !isNew(c)).map((c) => c.srs.due);
  return times.length ? Math.min(...times) : null;
}

// ---- Streaks: days with at least one review, in this browser ----

export function dayKey(ms = Date.now()) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
const KEEP_DAYS = 400;
export function logReview(log, now = Date.now()) {
  const days = { ...(log?.days || {}) };
  const key = dayKey(now);
  days[key] = (days[key] || 0) + 1;
  const keys = Object.keys(days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k];
  return { days };
}
// Consecutive days with a review, up to today; a streak isn't broken until
// a whole day passes without one, so yesterday's still counts this morning.
export function streak(log, now = Date.now()) {
  const days = log?.days || {};
  let at = new Date(now);
  if (!days[dayKey(at.getTime())]) at.setDate(at.getDate() - 1);
  let n = 0;
  while (days[dayKey(at.getTime())]) {
    n++;
    at.setDate(at.getDate() - 1);
  }
  return n;
}
export const reviewedToday = (log, now = Date.now()) => log?.days?.[dayKey(now)] || 0;

// ---- Quiz ----

export function quizScore(answers) {
  const total = answers?.length || 0;
  const right = (answers || []).filter((a) => a.chosen === a.answer).length;
  return { right, total, percent: total ? Math.round((right / total) * 100) : 0 };
}
export function withQuizResult(deck, score, now = Date.now()) {
  const best = deck.quizStats?.best;
  const better = !best || score.right / score.total > best.right / best.total;
  return {
    ...deck,
    updated: now,
    quizStats: {
      last: { right: score.right, total: score.total, at: now },
      best: better ? { right: score.right, total: score.total, at: now } : best,
      taken: (deck.quizStats?.taken || 0) + 1,
    },
  };
}

// ---- Export and import ----

export const DECK_FORMAT = "anonyma-study-deck";
export const DECK_VERSION = 1;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// A deck as a JSON file: its cards, questions and review progress. The
// source's text was never kept, so it isn't in the file either.
export function exportDeck(deck) {
  return {
    format: DECK_FORMAT,
    version: DECK_VERSION,
    title: deck.title,
    created: new Date(deck.created || Date.now()).toISOString(),
    source: { kind: deck.source?.kind || "text", name: deck.source?.name || "" },
    cards: deck.cards.map(({ front, back, snippet, srs }) => ({
      front,
      back,
      snippet,
      ...(srs && !isNew({ srs }) ? { srs } : {}),
    })),
    quiz: deck.quiz.map(({ question, options, answer, explanation, snippet }) => ({
      question,
      options,
      answer,
      explanation,
      snippet,
    })),
  };
}

// One CSV cell (RFC 4180): quoted when it holds a comma, a quote or a line
// break, with quotes doubled. A cell starting with = + - @ (or their
// full-width forms), a tab or a line break gets an apostrophe first, so a
// spreadsheet opening the file never runs it as a formula.
export function csvCell(value) {
  let v = String(value ?? "");
  if (/^[=+\-@\t\r\n＝＋－＠]/.test(v)) v = "'" + v;
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
// Front,back rows for Anki's text import (File → Import), with the header
// lines Anki reads: comma-separated, plain text (never HTML), two columns.
// Quiz questions come along as cards: the question, then the right answer.
export function deckCSV(deck) {
  const rows = [
    ...deck.cards.map((c) => [c.front, c.back]),
    ...deck.quiz.map((q) => [q.question, q.options[q.answer]]),
  ];
  return (
    ["#separator:Comma", "#html:false", "#columns:Front,Back"].join("\r\n") +
    "\r\n" +
    rows.map((r) => r.map(csvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}

const finite = (v, min, max) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
function readSrs(s) {
  if (!s || typeof s !== "object") return undefined;
  const ok =
    Number.isInteger(s.reps) && finite(s.reps, 0, 10000) &&
    finite(s.ease, 1.3, 5) &&
    finite(s.interval, 0, MAX_INTERVAL) &&
    finite(s.due, 0, 8.64e15) &&
    Number.isInteger(s.lapses) && finite(s.lapses, 0, 10000) &&
    finite(s.last, 0, 8.64e15);
  return ok ? { reps: s.reps, ease: s.ease, interval: s.interval, due: s.due, lapses: s.lapses, last: s.last } : undefined;
}

// A deck file, checked strictly. Returns { deck, dropped } or throws an
// Error saying what's wrong. Unusable cards and questions are left out and
// counted; a file with none usable is refused. Imported snippets can't be
// checked against a source, so they aren't marked as found in one.
export function importDeck(raw, now = Date.now()) {
  let data = raw;
  if (typeof raw === "string") {
    if (raw.length > MAX_IMPORT_BYTES) throw Error("This file is too large for a deck (5 MB at most).");
    try {
      data = JSON.parse(raw);
    } catch {
      throw Error("This file isn't JSON. Choose a deck exported from Study Mode.");
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw Error("This file isn't a Study Mode deck.");
  if (data.format !== DECK_FORMAT) throw Error("This file isn't a Study Mode deck.");
  if (data.version !== DECK_VERSION) throw Error("This deck was made by a newer version of Study Mode.");
  const cardsIn = data.cards === undefined ? [] : data.cards;
  const quizIn = data.quiz === undefined ? [] : data.quiz;
  if (!Array.isArray(cardsIn) || !Array.isArray(quizIn)) throw Error("This deck's cards aren't a list.");
  if (cardsIn.length > ITEM_LIMITS.items || quizIn.length > ITEM_LIMITS.items)
    throw Error(`A deck can have at most ${ITEM_LIMITS.items} cards and ${ITEM_LIMITS.items} questions.`);
  const cards = cardsIn
    .map((c) => {
      const card = readCard({ ...(c && typeof c === "object" ? c : {}), grounded: false }, null);
      if (!card) return null;
      const srs = readSrs(c.srs);
      return srs ? { ...card, srs } : card;
    })
    .filter(Boolean);
  const quiz = quizIn
    .map((q) => readQuestion(q && typeof q === "object" ? { ...q, grounded: false } : q, null))
    .filter(Boolean);
  if (!cards.length && !quiz.length) throw Error("This deck has no usable cards or questions.");
  const kind = ["text", "document", "chat"].includes(data.source?.kind) ? data.source.kind : "text";
  const deck = newDeck({
    title: typeof data.title === "string" ? data.title : "",
    source: { kind, name: typeof data.source?.name === "string" ? data.source.name : "Imported deck" },
    make: cards.length && quiz.length ? "both" : cards.length ? "cards" : "quiz",
    count: Math.max(cards.length, quiz.length),
    level: null,
    model: null,
    cards,
    quiz,
    now,
  });
  deck.imported = true;
  if (!deck.title) deck.title = "Imported deck";
  return { deck, dropped: cardsIn.length + quizIn.length - cards.length - quiz.length };
}

// ---- A made-up sample deck ----

// Written by hand, not by a model, so the reviewer can be tried without an
// account or a charge.
export function sampleDeck(now = Date.now()) {
  const text = [
    ["What drives the water cycle?", "Energy from the Sun, which heats water so it evaporates.", "The water cycle is driven by energy from the Sun, which heats water in oceans, lakes and soil so that it evaporates."],
    ["What is evaporation?", "Liquid water turning into water vapour.", "Evaporation is the change of liquid water into water vapour."],
    ["What is transpiration?", "Water vapour released from plant leaves.", "Plants also release water vapour through their leaves, a process called transpiration."],
    ["How do clouds form?", "Rising vapour cools and condenses into tiny droplets.", "As moist air rises it cools, and the vapour condenses into tiny droplets that form clouds."],
    ["What is precipitation?", "Water falling from clouds as rain, snow, sleet or hail.", "When droplets grow heavy enough they fall as precipitation: rain, snow, sleet or hail."],
    ["Where does most evaporated water come from?", "The oceans.", "Most of the water that evaporates comes from the oceans."],
    ["What is runoff?", "Water that flows over land into streams, rivers and the sea.", "Water that isn't absorbed flows over the land as runoff into streams, rivers and eventually the sea."],
    ["What is groundwater?", "Water that soaks into the soil and is stored in rock layers.", "Some water soaks into the ground and is stored in layers of rock as groundwater."],
  ];
  const quiz = [
    ["Which process turns water vapour into cloud droplets?", ["Condensation", "Evaporation", "Transpiration", "Runoff"], 0, "Rising air cools and its vapour condenses into droplets.", text[3][2]],
    ["Where does most evaporated water come from?", ["Lakes", "Plants", "The oceans", "Glaciers"], 2, "The passage says most of it comes from the oceans.", text[5][2]],
    ["What is water released from plant leaves called?", ["Runoff", "Transpiration", "Precipitation", "Infiltration"], 1, "Plants release vapour through their leaves: transpiration.", text[2][2]],
    ["What provides the energy for the water cycle?", ["The Moon", "Wind", "Volcanoes", "The Sun"], 3, "The Sun heats water so that it evaporates.", text[0][2]],
  ];
  const deck = newDeck({
    title: "The water cycle (sample)",
    source: { kind: "text", name: "Sample notes", chars: 900 },
    make: "both",
    count: 10,
    level: "easy",
    model: null,
    cards: text.map(([front, back, snippet]) => ({ id: newId(), front, back, snippet, grounded: true })),
    quiz: quiz.map(([question, options, answer, explanation, snippet]) => ({
      id: newId(),
      question,
      options,
      answer,
      explanation,
      snippet,
      grounded: true,
    })),
    now,
  });
  deck.sample = true;
  return deck;
}
