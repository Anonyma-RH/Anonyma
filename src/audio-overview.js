// Audio Overview (update "audiooverview"): the parts the browser and the
// server share. A source (a document, a saved chat or a Deep Research
// report) becomes a two-host script as strict JSON, and each turn of the
// script is voiced with one of two chosen voices. The route is
// server/routes/audio-overview.js; the dialog is src/AudioOverview.jsx.
// Pure and DOM-free.

// Whether the app offers it: released, with Voice & Audio, whose speech
// models voice it (the server gates the same way; see featuresFor).
export const overviewLive = (config) =>
  config?.releases?.features?.audiooverview === true && config?.releases?.features?.audio === true;

// About how long the audio runs, what the script is asked for, and the most
// it may hold: the script is cut at `maxChars` (and `maxTurns`), so the
// voices can never cost more than the maximum shown before it starts.
export const LENGTHS = {
  short: { minutes: 3, words: 450, maxChars: 4500, maxTurns: 40 },
  long: { minutes: 8, words: 1200, maxChars: 11000, maxTurns: 90 },
};
export const SOURCE_KINDS = ["document", "chat", "research"];
export const MIN_SOURCE = 200;
export const MAX_SOURCE = 120000;
export const MAX_TITLE = 120;
// A turn longer than this is voiced in pieces, split at sentence ends.
export const MAX_TURN = 900;
export const MAX_CHAPTERS = 8;
export const SPEAKERS = ["A", "B"];

// [code, English name (for the prompt), the language's own name (for the
// picker)]. "auto" writes in the language of the source.
export const LANGUAGES = [
  ["auto", "the language of the source", ""],
  ["en", "English", "English"],
  ["zh", "Simplified Chinese", "中文（简体）"],
  ["es", "Spanish", "Español"],
  ["fr", "French", "Français"],
  ["de", "German", "Deutsch"],
  ["pt", "Portuguese", "Português"],
  ["it", "Italian", "Italiano"],
  ["nl", "Dutch", "Nederlands"],
  ["pl", "Polish", "Polski"],
  ["tr", "Turkish", "Türkçe"],
  ["ru", "Russian", "Русский"],
  ["ja", "Japanese", "日本語"],
  ["ko", "Korean", "한국어"],
  ["hi", "Hindi", "हिन्दी"],
  ["ar", "Arabic", "العربية"],
];
export const languageName = (code) =>
  (LANGUAGES.find(([c]) => c === code) || LANGUAGES[0])[1];

// Messages the browser and the server both show.
export const OVERVIEW_VEILED =
  "Veil masked details in this source, and the voices would read the placeholders aloud, so this overview won't be made. Remove the details, or turn Veil off for this source.";
export const OVERVIEW_PRIVATE =
  "Audio Overview isn't available in Private Mode: no voice model offers zero data retention.";
export const SCRIPT_CUT_SHORT =
  "The model ran out of room while writing the script, so nothing was voiced. Only the script step was charged. Try the shorter length, or another model.";
export const SCRIPT_UNUSABLE =
  "The model's script wasn't in the expected format, so nothing was voiced. Only the script step was charged. Try again, or pick another model.";

// A Veil placeholder such as [EMAIL_1] (src/veil.js). A source that still
// carries one (a saved chat whose details were masked) would be read aloud
// with the placeholder in it.
const VEIL_TAG = /\[(?:EMAIL|KEY|WALLET|IBAN|CARD|PHONE|IP|PRIVATE)_\d+\]/;
export const hasVeilTags = (text) => VEIL_TAG.test(String(text || ""));

// Text as it's spoken: no Markdown emphasis, code marks, headings, links or
// control characters, and single spaces.
export function spoken(text) {
  return String(text ?? "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ")
    .replace(/\[([^\]\n]{1,200})\]\((?:https?:)?[^)\s]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/^\s*[-*•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Pieces of at most `max` characters, split after sentence ends where it can.
export function splitTurn(text, max = MAX_TURN) {
  if (text.length <= max) return [text];
  const sentences = text.match(/[^.!?。！？]*[.!?。！？]+["'”’)]*\s*|[^.!?。！？]+$/g) || [text];
  const pieces = [];
  let current = "";
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };
  for (let s of sentences) {
    while (s.length > max) {
      // One very long sentence: cut at the last space before the limit.
      push();
      let cut = s.lastIndexOf(" ", max);
      if (cut < max / 2) cut = max;
      pieces.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
    if ((current + s).length > max) push();
    current += s;
  }
  push();
  return pieces.filter(Boolean);
}

// The model's script, checked and normalised. Strict JSON in exactly the
// shape asked for (a ```json fence around it is tolerated): an object with
// `turns`, each { speaker: "A" | "B", text }, and optional `title` and
// `chapters` ({ title, turn }). Both hosts must speak. Resolves to
// { script: { title, chapters, turns }, trimmed } or { problem }.
// Long turns are split into pieces; the script is cut at the length's
// character and turn caps (`trimmed` counts the turns left out).
export function parseScript(raw, lengthId, maxTurn = MAX_TURN) {
  const spec = LENGTHS[lengthId];
  if (!spec) return { problem: "length" };
  let text = String(raw ?? "").trim();
  const fence = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(text);
  if (fence) text = fence[1].trim();
  if (!text) return { problem: "empty" };
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { problem: "json" };
  }
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.turns))
    return { problem: "shape" };
  if (
    data.turns.some(
      (t) => !t || typeof t !== "object" || !SPEAKERS.includes(t.speaker) || typeof t.text !== "string",
    )
  )
    return { problem: "shape" };
  // Where each of the model's turns starts once long ones are split.
  const starts = [];
  const all = [];
  data.turns.forEach((t, i) => {
    starts[i] = all.length;
    const said = spoken(t.text);
    if (said) for (const piece of splitTurn(said, maxTurn)) all.push({ speaker: t.speaker, text: piece });
  });
  starts[data.turns.length] = all.length;
  const turns = [];
  let chars = 0;
  for (const t of all) {
    if (turns.length >= spec.maxTurns || chars + t.text.length > spec.maxChars) break;
    turns.push(t);
    chars += t.text.length;
  }
  if (turns.length < 2 || !SPEAKERS.every((s) => turns.some((t) => t.speaker === s)))
    return { problem: "shape" };
  const title = typeof data.title === "string" ? spoken(data.title).slice(0, MAX_TITLE) : "";
  const seen = new Set();
  const chapters = (Array.isArray(data.chapters) ? data.chapters : [])
    .filter(
      (c) =>
        c &&
        typeof c.title === "string" &&
        spoken(c.title) &&
        Number.isInteger(c.turn) &&
        c.turn >= 0 &&
        c.turn < data.turns.length,
    )
    .map((c) => ({ title: spoken(c.title).slice(0, 80), turn: starts[c.turn] }))
    .filter((c) => c.turn < turns.length)
    .sort((a, b) => a.turn - b.turn)
    .filter((c) => !seen.has(c.turn) && seen.add(c.turn))
    .slice(0, MAX_CHAPTERS);
  if (chapters.length) chapters[0] = { ...chapters[0], turn: 0 };
  return {
    script: { title, chapters, turns },
    trimmed: all.length - turns.length,
    characters: chars,
  };
}

export const scriptCharacters = (turns) =>
  (turns || []).reduce((n, t) => n + (t?.text?.length || 0), 0);

// ---- Choosing the voices, in the browser ----

// The most the voices can cost for a length, in credits, from the model's
// listed price per 1,000 characters (at the account's rate). The same for
// every source, so the cheapest voice model is the cheapest overview.
export const voicesMaximum = (model, length) =>
  Math.round(((LENGTHS[length]?.maxChars || 0) / 1000) * (Number(model?.credits_per_1k_chars) || 0) * 10000) / 10000;

// Other names a catalog may give a voice's language.
const LANGUAGE_ALIASES = { zh: ["cmn", "chinese", "mandarin"], en: ["english"] };
const isMulti = (v) => ["multi", "multilingual"].includes(String(v?.language || "").trim().toLowerCase());
// Whether a voice speaks `code` ("en", "zh"...): its own language, or "multi".
export function voiceSpeaks(voice, code) {
  const l = String(voice?.language || "").trim().toLowerCase();
  if (!l) return false;
  if (isMulti(voice)) return true;
  if (l === code || l.startsWith(code + "-") || l.startsWith(code + "_")) return true;
  const name = (LANGUAGES.find(([c]) => c === code)?.[1] || "").toLowerCase();
  return l === name || (LANGUAGE_ALIASES[code] || []).some((a) => l === a || l.startsWith(a + "-"));
}

// The language a source is written in, roughly, for choosing voices when
// the script follows the source: its script (kana, Hangul, Han, Cyrillic,
// Arabic, Devanagari), else its commonest short words. `fallback` when
// there's too little to tell.
const COMMON_WORDS = {
  en: "the and of to is in that it for with was are this",
  es: "el la de que y los las en es por con una del para",
  fr: "le la les des et est une du que dans pour pas sur",
  de: "der die das und ist nicht mit ein eine zu den von auf",
  pt: "o os que não uma do da em para com são dos das",
  it: "il che di la e non per un una sono del della gli",
  nl: "de het een en van is niet dat op zijn met voor",
  pl: "i w nie się na że jest do to z jak po",
  tr: "ve bir bu için ile da değil çok olarak gibi daha",
};
export function guessLanguage(text, fallback = "en") {
  const t = String(text || "").slice(0, 6000);
  const count = (re) => (t.match(re) || []).length;
  const letters = count(/\p{L}/gu);
  if (letters < 20) return fallback;
  const share = (re) => count(re) / letters;
  if (share(/[\u3040-\u30ff]/g) > 0.05) return "ja";
  if (share(/[\uac00-\ud7af]/g) > 0.2) return "ko";
  if (share(/[\u4e00-\u9fff]/g) > 0.2) return "zh";
  if (share(/[\u0400-\u04ff]/g) > 0.2) return "ru";
  if (share(/[\u0600-\u06ff]/g) > 0.2) return "ar";
  if (share(/[\u0900-\u097f]/g) > 0.2) return "hi";
  const words = t.toLowerCase().match(/\p{L}+/gu) || [];
  let best = null,
    top = 0;
  for (const [code, list] of Object.entries(COMMON_WORDS)) {
    const set = new Set(list.split(" "));
    const score = words.reduce((n, w) => n + (set.has(w) ? 1 : 0), 0);
    if (score > top) [best, top] = [code, score];
  }
  return top >= 3 ? best : fallback;
}

const byName = (a, b) => String(a.name || a.id).localeCompare(String(b.name || b.id));
const genderOf = (v) => {
  const g = String(v?.gender || "").trim().toLowerCase();
  return g === "female" || g === "f" ? "female" : g === "male" || g === "m" ? "male" : null;
};
// Two different voices for language `code`: voices in that language first,
// then multilingual ones, alphabetically; a female and a male voice when the
// catalog says which are which.
export function pickVoices(model, code) {
  const voices = [...(model?.voices || [])].sort(byName);
  if (!voices.length) return { voiceA: "", voiceB: "" };
  const own = voices.filter((v) => voiceSpeaks(v, code) && !isMulti(v));
  const multi = voices.filter((v) => isMulti(v));
  const candidates = own.length + multi.length ? [...own, ...multi] : voices;
  const female = candidates.find((v) => genderOf(v) === "female"),
    male = candidates.find((v) => genderOf(v) === "male");
  if (female && male) return { voiceA: female.id, voiceB: male.id };
  const a = candidates[0];
  const b = candidates.find((v) => v.id !== a.id) || voices.find((v) => v.id !== a.id) || a;
  return { voiceA: a.id, voiceB: b.id };
}
// The voice model with the lowest maximum for the length, among those with
// voices for language `code`: two of them if any model has two, else one;
// else the cheapest model with any voices, else the cheapest.
export function pickVoiceModel(catalog, { language, length }) {
  const priced = (catalog || []).filter((m) => Number.isFinite(Number(m?.credits_per_1k_chars)));
  const speaking = (m) => (m.voices || []).filter((v) => voiceSpeaks(v, language)).length;
  const pool = [
    priced.filter((m) => speaking(m) >= 2),
    priced.filter((m) => speaking(m) >= 1),
    priced.filter((m) => m.voices?.length),
    priced,
  ].find((list) => list.length);
  if (!pool) return "";
  return [...pool].sort((a, b) => voicesMaximum(a, length) - voicesMaximum(b, length) || byName(a, b))[0].id;
}
// The voice model and voices a new overview starts with. A choice this
// browser remembered wins while its model is still offered (its voices too,
// while they are); otherwise the cheapest model for the language, with two
// of its voices.
export function voiceDefaults({ catalog, language, length, remembered = null }) {
  const kept = (catalog || []).find((m) => m.id === remembered?.tts);
  if (kept) {
    const ids = (kept.voices || []).map((v) => v.id);
    const ok =
      ids.includes(remembered.voiceA) &&
      ids.includes(remembered.voiceB) &&
      (remembered.voiceA !== remembered.voiceB || ids.length < 2);
    return {
      tts: kept.id,
      ...(ok ? { voiceA: remembered.voiceA, voiceB: remembered.voiceB } : pickVoices(kept, language)),
      remembered: true,
    };
  }
  const id = pickVoiceModel(catalog, { language, length });
  const model = (catalog || []).find((m) => m.id === id);
  return { tts: id, ...(model ? pickVoices(model, language) : { voiceA: "", voiceB: "" }), remembered: false };
}

// ---- Sources, built in the browser ----

const clip = (text) => {
  const t = String(text || "").trim();
  return t.length > MAX_SOURCE
    ? { text: t.slice(0, MAX_SOURCE), truncated: true }
    : { text: t, truncated: false };
};
const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
};

// A Deep Research report as a source: its text without the [n] citation
// marks, then its sources by title and site (never addresses).
export function researchSource(message) {
  const report = String(message?.content || "")
    .replace(/(?:\[\d+\])+/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1");
  const sources = (Array.isArray(message?.citations) ? message.citations : [])
    .map((c, i) => `${i + 1}. ${String(c?.title || hostOf(c?.url) || "Untitled").slice(0, 160)}${c?.title && hostOf(c?.url) ? ` (${hostOf(c.url)})` : ""}`)
    .join("\n");
  const heading = /^#\s+(.+)$/m.exec(report)?.[1]?.trim();
  return {
    kind: "research",
    title: (heading || "Research report").slice(0, MAX_TITLE),
    ...clip(sources ? `${report.trim()}\n\nSources:\n${sources}` : report),
  };
}

// A chat as a source: each message as it's stored (Veil's placeholders stay
// placeholders, never restored), labelled by who wrote it. Blind rounds,
// prepared samples and messages without text are left out.
export function chatSource(messages, title) {
  const parts = [];
  for (const m of messages || []) {
    if (!m || m.sample || m.blind || typeof m.content !== "string" || !m.content.trim()) continue;
    if (m.role === "user") parts.push("User: " + m.content.trim());
    else if (m.role === "assistant")
      parts.push("Assistant: " + (m.research ? researchSource(m).text : m.content.trim()));
  }
  return {
    kind: "chat",
    title: String(title || "").trim().slice(0, MAX_TITLE) || "This chat",
    ...clip(parts.join("\n\n")),
  };
}

export function documentSource(doc) {
  return {
    kind: "document",
    title: String(doc?.name || "Document").slice(0, MAX_TITLE),
    ...clip(doc?.text),
  };
}

// ---- Playback ----

// "m:ss" (or "h:mm:ss").
export function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
// The index of the turn playing at `time`: the last start at or before it.
export function turnAt(turns, time) {
  let at = -1;
  (turns || []).forEach((t, i) => {
    if (Number.isFinite(t?.start) && t.start <= time + 0.05) at = i;
  });
  return at;
}
// The chapter a turn belongs to.
export function chapterOf(chapters, turn) {
  let at = -1;
  (chapters || []).forEach((c, i) => {
    if (c.turn <= turn) at = i;
  });
  return at;
}
