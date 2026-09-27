// Meeting Notes (update "meetingnotes"): the parts the browser and the server
// share. A recording is read in the browser (src/meeting-audio.js), sent as
// plain 16 kHz mono sound in pieces of at most five minutes to the
// transcription model, and the timestamped transcript then goes to a text
// model that writes the notes as strict JSON: a summary, the decisions, the
// action items and the open questions. The routes are
// server/routes/meeting-notes.js; the page is src/MeetingNotes.jsx. Pure and
// DOM-free, so the server and the tests run it too.
import { buildDocumentBlock, DATA_NOTICE_BLOCK, escapeDocumentText } from "./documents.js";
import { LANGUAGES, languageName } from "./audio-overview.js";
import { firstJsonObject } from "./highlight-ask.js";

// Whether the app offers it: released, with Voice & Audio, whose speech
// models transcribe it (the server gates the same way; see featuresFor).
export const meetingNotesLive = (config) =>
  config?.releases?.features?.meetingnotes === true && config?.releases?.features?.audio === true;

// ---- Limits ----

export const MAX_SECONDS = 3 * 3600;
export const MIN_SECONDS = 2;
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
// A video is never read whole: only its sound track's bytes are.
export const MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;
// What is sent: mono 16-bit PCM at 16 kHz, 32,000 bytes a second, so five
// minutes (9.6 MB) stays under the transcription route's 10 MB.
export const CHUNK_RATE = 16000;
export const MAX_CHUNK_SECONDS = 300;
// A piece ends at the quietest moment of its last 15 seconds, so a word is
// rarely cut in two.
export const CUT_WINDOW_SECONDS = 15;
export const MAX_CHUNKS = Math.ceil(MAX_SECONDS / (MAX_CHUNK_SECONDS - CUT_WINDOW_SECONDS)) + 1;
// The longest transcript a recording can have, for the notes step's
// maximum: 1,300 characters a minute (about 230 spoken words, faster than
// anyone talks for long, with the timestamps), and never more than one
// request carries (the service allows 240,000 characters a message).
export const CHARS_PER_MINUTE = 1300;
export const MAX_NOTES_CHARS = 200000;
export const MAX_SEGMENTS = 20000;
export const MAX_SEGMENT_CHARS = 4000;
export const MAX_TITLE = 100;
export const LIMITS = { summary: 2000, item: 500, decisions: 40, actions: 60, questions: 40, owner: 80, due: 80 };

export const maxTranscriptChars = (duration) =>
  Math.min(MAX_NOTES_CHARS, Math.ceil((Math.max(0, Number(duration) || 0) / 60) * CHARS_PER_MINUTE));

// The spoken-language hint for the transcription model: an ISO 639-1 code
// or "multi" (several languages). [code, English name, own name].
export const SPOKEN = [
  ["en", "English", "English"],
  ["zh", "Chinese", "中文"],
  ["es", "Spanish", "Español"],
  ["fr", "French", "Français"],
  ["de", "German", "Deutsch"],
  ["pt", "Portuguese", "Português"],
  ["it", "Italian", "Italiano"],
  ["nl", "Dutch", "Nederlands"],
  ["ja", "Japanese", "日本語"],
  ["ko", "Korean", "한국어"],
  ["hi", "Hindi", "हिन्दी"],
  ["ru", "Russian", "Русский"],
  ["multi", "Several languages", ""],
];
// The notes' language: "auto" writes in the transcript's own language.
export const NOTE_LANGUAGES = LANGUAGES;
export { languageName };

// Messages the browser and the server both show.
export const MEETING_PRIVATE =
  "Meeting Notes isn't available in Private Mode: no transcription model offers zero data retention.";
export const NOTES_CUT_SHORT =
  "The model ran out of room before the notes were finished, so nothing was charged for them. Try again, or pick another model. Your transcript is kept here.";
export const NOTES_UNUSABLE =
  "The model's notes weren't in the expected format, so nothing was charged for them. Try again, or pick another model. Your transcript is kept here.";
export const NOTHING_HEARD = "No speech was found in this recording, so there's nothing to make notes from.";

// ---- Time ----

// "4:05", "12:04", or "1:02:03" (always with hours when `long`).
export function clock(seconds, long = false) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    r = String(s % 60).padStart(2, "0");
  return h || long ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
}
// A transcript's timestamp: mm:ss, or h:mm:ss for a recording of an hour
// or more.
export const stamp = (seconds, duration) => {
  const long = Number(duration) >= 3600;
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  if (long) return clock(s, true);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
// Seconds from "12:04", "1:02:03", "[12:04]" or a number; null otherwise.
export function parseClock(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== "string") return null;
  const m = /^\s*\[?\s*(?:(\d{1,2}):)?(\d{1,3}):(\d{2})(?:[.,]\d+)?\s*\]?\s*$/.exec(value);
  if (!m) return null;
  const [h, min, s] = [Number(m[1] || 0), Number(m[2]), Number(m[3])];
  if (s >= 60 || (m[1] && min >= 60)) return null;
  return h * 3600 + min * 60 + s;
}
// "24 min", "1 h 05 min", "45 s": a recording's length in the setup line.
export function lengthLabel(seconds) {
  const s = Math.round(Number(seconds) || 0);
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min`;
}

// ---- Pieces ----

// Where a recording is cut: pieces of at most `max` seconds, each ending at
// the quietest moment of the `window` seconds before that limit when
// `quiet(from, to)` finds one (it resolves to a time in [from, to], or
// null), else at the limit. Times are whole samples at `rate`, so the
// browser, the server and the bill agree to the sample.
export async function planChunks(
  duration,
  { max = MAX_CHUNK_SECONDS, window = CUT_WINDOW_SECONDS, quiet = null, rate = CHUNK_RATE } = {},
) {
  const total = Math.round(Math.max(0, Number(duration) || 0) * rate);
  const limit = Math.floor(max * rate),
    span = Math.min(limit - 1, Math.floor(window * rate));
  const cuts = [0];
  let at = 0;
  while (total - at > limit) {
    const latest = at + limit;
    let cut = latest;
    if (quiet) {
      const q = await quiet((latest - span) / rate, latest / rate);
      if (Number.isFinite(q)) {
        const s = Math.round(q * rate);
        if (s >= latest - span && s <= latest) cut = s;
      }
    }
    cuts.push(cut);
    at = cut;
  }
  if (total > 0) cuts.push(total);
  return cuts.slice(1).map((end, i) => ({
    index: i,
    start: cuts[i] / rate,
    end: end / rate,
    samples: end - cuts[i],
    seconds: (end - cuts[i]) / rate,
  }));
}

// The quietest moment of some audio: the middle of its quietest `frame`
// (by RMS), in seconds from the start. On a tie the later one wins, so
// pieces stay long. Null for no audio.
export function quietestPoint(samples, rate = CHUNK_RATE, frame = 0.1) {
  const size = Math.max(1, Math.round(frame * rate));
  const frames = Math.floor((samples?.length || 0) / size);
  if (!frames) return null;
  let best = -1,
    lowest = Infinity;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * size, end = i + size; i < end; i++) sum += samples[i] * samples[i];
    if (sum <= lowest) {
      lowest = sum;
      best = f;
    }
  }
  return (best * size + size / 2) / rate;
}

// The server's check of a plan: each piece's seconds (the last may be
// short), adding up to the duration. Returns the seconds, rounded to the
// sample, or throws an Error whose message the server returns as is.
export function checkPlan(chunks, duration) {
  const d = Number(duration);
  if (!Number.isFinite(d) || d < MIN_SECONDS) throw Error("This recording is too short to transcribe.");
  if (d > MAX_SECONDS + 0.001) throw Error("Recordings can be up to 3 hours long. Split a longer one.");
  if (!Array.isArray(chunks) || !chunks.length || chunks.length > MAX_CHUNKS)
    throw Error("Send the recording's pieces as a list of their lengths in seconds.");
  const out = chunks.map((c) => Math.round(Number(c) * CHUNK_RATE) / CHUNK_RATE);
  out.forEach((s, i) => {
    if (!Number.isFinite(s) || s <= 0 || s > MAX_CHUNK_SECONDS + 1e-6)
      throw Error("Each piece is at most 5 minutes long.");
    if (i < out.length - 1 && s < MAX_CHUNK_SECONDS - CUT_WINDOW_SECONDS - 1e-6)
      throw Error("Only the last piece can be shorter than 4 minutes 45 seconds.");
  });
  const sum = out.reduce((n, s) => n + s, 0);
  if (Math.abs(sum - d) > 0.01) throw Error("The pieces must add up to the recording's length.");
  return out;
}
export const chunkStarts = (seconds) => {
  let at = 0;
  return seconds.map((s) => {
    const start = at;
    at = Math.round((at + s) * CHUNK_RATE) / CHUNK_RATE;
    return start;
  });
};

// ---- The transcript ----

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const cleanLine = (v, max) =>
  typeof v === "string" ? v.replace(CONTROL, " ").replace(/\s+/g, " ").trim().slice(0, max) : "";
const round2 = (n) => Math.round(n * 100) / 100;

// The server's check of the transcript the browser sends for the notes
// step: [{ start, end, text, speaker? }], in order, inside the recording.
// Empty lines are dropped. Throws an Error with a message to show.
export function checkSegments(list, duration) {
  if (!Array.isArray(list) || list.length > MAX_SEGMENTS)
    throw Error("Send the transcript as a list of timed lines.");
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== "object" || Array.isArray(s)) throw Error("Each transcript line has a start, an end and its text.");
    if (typeof s.text !== "string" || s.text.length > MAX_SEGMENT_CHARS)
      throw Error("Each transcript line has up to 4,000 characters of text.");
    const start = Number(s.start),
      end = Number(s.end ?? s.start);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || end > Number(duration) + 1)
      throw Error("Each transcript line's times must be inside the recording.");
    const text = cleanLine(s.text, MAX_SEGMENT_CHARS);
    if (!text) continue;
    const speaker = s.speaker == null ? null : cleanLine(String(s.speaker), 40) || null;
    out.push({ start: round2(start), end: round2(end), text, ...(speaker ? { speaker } : {}) });
  }
  return out.sort((a, b) => a.start - b.start);
}

// One line as the notes model reads it: "[12:04] text", or with the
// provider's speaker label, "[12:04] Speaker 2: text".
export const transcriptLine = (s, duration) =>
  `[${stamp(s.start, duration)}] ${s.speaker ? s.speaker + ": " : ""}${s.text}`;
// How long a line is once it's in the request (escaped for the document
// block, then for JSON), so a fitted transcript never costs more than the
// maximum that was held for it.
export const sentLength = (text) => JSON.stringify(escapeDocumentText(text)).length - 2;
const utf8Length = (text) => {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
};
// The transcript for the notes model, whole lines only, as long as fits in
// `maxChars` (sent length) and `maxBytes` (the model's context). `cutAt`
// is where it stops (the first line left out), or null when it's all there.
export function fitTranscript(segments, duration, { maxChars = MAX_NOTES_CHARS, maxBytes = Infinity } = {}) {
  const lines = [];
  let chars = 0,
    bytes = 0,
    cutAt = null;
  for (const s of segments) {
    const line = transcriptLine(s, duration);
    const extra = lines.length ? 1 : 0;
    const len = sentLength(line) + (extra ? 2 : 0),
      size = utf8Length(escapeDocumentText(line)) + extra;
    if (chars + len > maxChars || bytes + size > maxBytes) {
      cutAt = s.start;
      break;
    }
    lines.push(line);
    chars += len;
    bytes += size;
  }
  return { text: lines.join("\n"), lines: lines.length, cutAt };
}

// ---- The notes prompt ----

export const NOTES_PROMPT_START = "You write meeting notes from a transcript.";
export function notesPrompt(language = "auto") {
  const lang = language === "auto" ? "the language the transcript is in" : languageName(language);
  return [
    NOTES_PROMPT_START,
    "Each line of the transcript starts with the time it was said, as [mm:ss] or [h:mm:ss]. A speaker label such as \"Speaker 2:\" follows only when the transcription provider gave one; it is not a name.",
    "Use only what is said in the transcript. Add no facts, names, dates, numbers or opinions from anywhere else. Leave out anything unclear.",
    '- "title": a short name for the meeting, from what it was about (at most 8 words).',
    '- "summary": 3 to 6 plain sentences on what the meeting covered and where it landed.',
    '- "decisions": what was decided or agreed, as said. An empty list if nothing was decided.',
    '- "action_items": tasks someone took on or was asked to do. "owner" is the person\'s name only when the transcript says who will do it; otherwise null. Never guess an owner and never use a speaker label as one. "due" is a deadline as said ("by Friday"), or null; don\'t turn it into a date: you don\'t know when the meeting was.',
    '- "open_questions": questions raised and not answered, and points left undecided.',
    '- "at": the time of the line it comes from, copied from the transcript (for example "12:04"), or null.',
    `Write the notes in ${lang}. Keep people's names exactly as the transcript writes them.`,
    "Placeholders such as [EMAIL_1] or [PRIVATE_2] stand for details hidden from you: copy them exactly, never guess what they hide.",
    "Reply with JSON only, exactly in this shape:",
    '{"title": "...", "summary": "...", "decisions": [{"text": "...", "at": "12:04"}], "action_items": [{"task": "...", "owner": null, "due": null, "at": "12:04"}], "open_questions": [{"text": "...", "at": null}]}',
  ].join("\n");
}
// The transcript goes as one document block with Injection Shield's data
// notice ("send as data"), so anything said in the meeting is read as text.
// The model also gets the recording's length; nothing else about it.
export function notesMessages({ text, duration, language = "auto" }) {
  return [
    { role: "system", content: notesPrompt(language) },
    {
      role: "user",
      content:
        `Write the notes for this meeting. The recording is ${clock(duration)} long.\n\n` +
        buildDocumentBlock({ name: "Transcript", text }) +
        "\n\n" +
        DATA_NOTICE_BLOCK,
    },
  ];
}

// ---- Reading the notes back ----

const TEXT_KEYS = ["text", "decision", "question", "item", "task", "action", "title", "content", "summary", "point", "description"];
// Text from a string, an array of strings (joined) or an object's text.
function textOf(v, max, keys = TEXT_KEYS) {
  if (typeof v === "string") return cleanLine(v, max);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  if (Array.isArray(v)) return cleanLine(v.map((x) => textOf(x, max, keys)).filter(Boolean).join(" "), max);
  if (v && typeof v === "object") {
    for (const k of keys) if (v[k] != null) return textOf(v[k], max, keys);
  }
  return "";
}
const pick = (obj, keys) => {
  for (const k of keys) if (obj?.[k] != null) return obj[k];
  return undefined;
};
const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : typeof v === "string" || typeof v === "object" ? [v] : []);
const atOf = (item, duration) => {
  const raw = item && typeof item === "object" && !Array.isArray(item) ? pick(item, ["at", "time", "timestamp", "when_said", "start"]) : null;
  const t = parseClock(raw);
  return t != null && t <= Number(duration) + 1 ? t : null;
};
function items(v, { duration, max, keys = TEXT_KEYS }) {
  const seen = new Set();
  const out = [];
  for (const item of asList(v)) {
    const text = textOf(item, LIMITS.item, keys);
    if (!text || seen.has(text.toLowerCase())) continue;
    seen.add(text.toLowerCase());
    out.push({ text, at: atOf(item, duration) });
    if (out.length >= max) break;
  }
  return out;
}
const normName = (s) => String(s || "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
const SPEAKER_LABEL = /^(speaker|说话人|发言人)\s*\d+$/i;
// An owner is kept only when the transcript names them: the name as the
// model wrote it, found in the transcript as whole words (or anywhere, for
// names written without spaces). Several names ("Maya and Dev") keep the
// ones found. Speaker labels are never owners.
export function namedIn(transcript, owner) {
  const hay = normName(transcript);
  const found = (name) => {
    const n = normName(name);
    if (!n || n.length > LIMITS.owner || SPEAKER_LABEL.test(n) || /^(null|none|n\/a|unknown|tbd|someone|everyone|all|team|we)$/.test(n))
      return false;
    if (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(n)) return hay.includes(n);
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}])${esc}($|[^\\p{L}\\p{N}])`, "u").test(hay);
  };
  const text = cleanLine(typeof owner === "string" ? owner : "", LIMITS.owner);
  if (!text) return null;
  if (found(text)) return text;
  const parts = text.split(/\s*(?:,|&|\/|\band\b|和|与|、)\s*/i).filter(Boolean);
  const kept = parts.length > 1 ? parts.filter(found) : [];
  return kept.length ? kept.join(", ") : null;
}
function actionItems(v, { duration, transcript }) {
  const seen = new Set();
  const out = [];
  let dropped = 0;
  for (const item of asList(v)) {
    const obj = item && typeof item === "object" && !Array.isArray(item) ? item : null;
    const task = obj
      ? textOf(pick(obj, ["task", "action", "text", "item", "description", "what", "title"]), LIMITS.item)
      : textOf(item, LIMITS.item);
    if (!task || seen.has(task.toLowerCase())) continue;
    seen.add(task.toLowerCase());
    const asked = obj ? textOf(pick(obj, ["owner", "assignee", "who", "person", "responsible"]), LIMITS.owner, ["name"]) : "";
    const owner = asked ? namedIn(transcript, asked) : null;
    if (asked && !owner && !/^(null|none|n\/a|unknown|tbd)$/i.test(asked)) dropped++;
    const due = obj ? textOf(pick(obj, ["due", "deadline", "by", "when", "due_date"]), LIMITS.due) : "";
    out.push({ task, owner, due: due && !/^(null|none|n\/a)$/i.test(due) ? due : null, at: atOf(obj, duration) });
    if (out.length >= LIMITS.actions) break;
  }
  return { list: out, dropped };
}

// The model's notes, checked and normalised, or { problem }. JSON only
// (a code fence, or prose around one object, is tolerated), in the shape
// asked for, read tolerantly: a summary given as a list of sentences or an
// object, items given as plain strings or objects, other common key names.
// `transcript` is the text the model read, for checking owners; `duration`
// bounds each "at".
export function parseNotes(raw, { transcript = "", duration = Infinity } = {}) {
  const data = firstJsonObject(typeof raw === "string" ? raw : "");
  if (!data) return { problem: "json" };
  const root = data.notes && typeof data.notes === "object" && !Array.isArray(data.notes) ? data.notes : data;
  const title = textOf(pick(root, ["title", "meeting_title", "name", "topic"]), MAX_TITLE);
  const summary = textOf(pick(root, ["summary", "overview", "tldr", "tl_dr", "recap"]), LIMITS.summary);
  const decisions = items(pick(root, ["decisions", "decisions_made", "agreed", "agreements"]), {
    duration,
    max: LIMITS.decisions,
  });
  const actions = actionItems(pick(root, ["action_items", "actionItems", "actions", "tasks", "todos", "to_dos", "next_steps"]), {
    duration,
    transcript,
  });
  const questions = items(pick(root, ["open_questions", "openQuestions", "questions", "unresolved", "open_issues", "open_points"]), {
    duration,
    max: LIMITS.questions,
  });
  if (!summary && !decisions.length && !actions.list.length && !questions.length) return { problem: "empty" };
  return {
    notes: { title, summary, decisions, actions: actions.list, questions },
    dropped: actions.dropped,
  };
}
// Reads a finished notes reply: { notes, dropped } when it parses (`cut`
// when the model also hit its limit), otherwise { problem, message }.
export function readNotes(text, finishReason, context) {
  const r = parseNotes(text, context);
  if (r.notes) return { ...r, cut: finishReason === "length" };
  return {
    problem: r.problem,
    message: finishReason === "length" ? NOTES_CUT_SHORT : NOTES_UNUSABLE,
    code: finishReason === "length" ? "notes_length" : "notes_invalid",
  };
}

// ---- Veil ----

// The transcript as the notes model gets it while Veil is on: each line's
// text through `mask(text)` → { text, count } (src/veil.js's veil with one
// state for the whole meeting, so a value is the same tag everywhere).
export function maskSegments(segments, mask) {
  let count = 0;
  const out = segments.map((s) => {
    const r = mask(s.text);
    count += r.count || 0;
    return { ...s, text: r.text };
  });
  return { segments: out, count };
}
// Notes with every text put back through `restore` (Veil's unveil).
export function restoreNotes(notes, restore) {
  if (!notes) return notes;
  const r = (s) => (typeof s === "string" ? restore(s) : s);
  return {
    ...notes,
    title: r(notes.title),
    summary: r(notes.summary),
    decisions: (notes.decisions || []).map((d) => ({ ...d, text: r(d.text) })),
    actions: (notes.actions || []).map((a) => ({ ...a, task: r(a.task), owner: r(a.owner), due: r(a.due) })),
    questions: (notes.questions || []).map((q) => ({ ...q, text: r(q.text) })),
  };
}

// ---- The document ----

const HEADINGS = {
  en: {
    notes: "Meeting notes",
    summary: "Summary",
    decisions: "Decisions",
    actions: "Action items",
    questions: "Open questions",
    transcript: "Transcript",
    none: "None.",
    meta: (length, stt, model) => `Recording ${length} · transcribed by ${stt}${model ? ` · notes by ${model}` : ""}`,
    due: "due",
    cut: (at) => `The notes cover the transcript up to ${at}; the rest was too long for one request.`,
    only: "Transcript only: no notes were made.",
  },
  zh: {
    notes: "会议纪要",
    summary: "摘要",
    decisions: "决定",
    actions: "待办事项",
    questions: "待解决问题",
    transcript: "文字稿",
    none: "无。",
    meta: (length, stt, model) => `录音 ${length} · 由 ${stt} 转录${model ? ` · 纪要由 ${model} 撰写` : ""}`,
    due: "截止",
    cut: (at) => `纪要只涵盖文字稿 ${at} 之前的部分；其余部分太长，一次请求放不下。`,
    only: "仅文字稿：未生成纪要。",
  },
};
export const headingsFor = (lang) => HEADINGS[lang] || HEADINGS.en;
const MD_SPECIAL = /[\\`*_[\]<>|~#]/g;
export const escapeMarkdown = (s) => String(s ?? "").replace(MD_SPECIAL, "\\$&");
export const unescapeMarkdown = (s) => String(s ?? "").replace(/\\([\\`*_[\]<>|~#])/g, "$1");
const TRANSCRIPT_LINE = /^- \*\*\[(\d{1,2}:\d{2}(?::\d{2})?)\]\*\*(?: \*\*((?:[^*\\]|\\.)+?):\*\*)? (.*)$/;

// The saved document (and the Markdown export): the notes, then the whole
// transcript with its timestamps. `notes` is null for a transcript only.
export function notesMarkdown({ title, duration, notes, segments, stt, model, lang = "en", cutAt = null }) {
  const h = headingsFor(lang);
  const at = (t) => (t != null ? ` (${stamp(t, duration)})` : "");
  const out = [`# ${escapeMarkdown(title || notes?.title || h.notes)}`, "", `_${escapeMarkdown(h.meta(clock(duration), stt || "", notes ? model : ""))}_`, ""];
  if (notes) {
    out.push(`## ${h.summary}`, "", notes.summary ? escapeMarkdown(notes.summary) : h.none, "");
    out.push(`## ${h.decisions}`, "");
    if (notes.decisions.length) notes.decisions.forEach((d) => out.push(`- ${escapeMarkdown(d.text)}${at(d.at)}`));
    else out.push(h.none);
    out.push("", `## ${h.actions}`, "");
    if (notes.actions.length)
      notes.actions.forEach((a) =>
        out.push(
          `- [ ] ${escapeMarkdown(a.task)}${a.owner ? ` — **${escapeMarkdown(a.owner)}**` : ""}${a.due ? ` · ${h.due} ${escapeMarkdown(a.due)}` : ""}${at(a.at)}`,
        ),
      );
    else out.push(h.none);
    out.push("", `## ${h.questions}`, "");
    if (notes.questions.length) notes.questions.forEach((q) => out.push(`- ${escapeMarkdown(q.text)}${at(q.at)}`));
    else out.push(h.none);
    out.push("");
    if (cutAt != null) out.push(`_${escapeMarkdown(h.cut(stamp(cutAt, duration)))}_`, "");
  } else out.push(`_${escapeMarkdown(h.only)}_`, "");
  out.push(`## ${h.transcript}`, "");
  for (const s of segments)
    out.push(`- **[${stamp(s.start, duration)}]**${s.speaker ? ` **${escapeMarkdown(s.speaker)}:**` : ""} ${escapeMarkdown(s.text)}`);
  return out.join("\n").trimEnd() + "\n";
}
// The transcript back out of a saved document, for reopening it here and
// for its text and subtitle exports: each line's start (its end is the
// next line's start), speaker and text.
export function transcriptFromMarkdown(markdown, duration) {
  const lines = String(markdown || "").split("\n");
  const out = [];
  for (const line of lines) {
    const m = TRANSCRIPT_LINE.exec(line);
    if (!m) continue;
    const start = parseClock(m[1]);
    if (start == null) continue;
    out.push({ start, end: start, text: unescapeMarkdown(m[3]), ...(m[2] ? { speaker: unescapeMarkdown(m[2]) } : {}) });
  }
  out.forEach((s, i) => (s.end = i + 1 < out.length ? Math.max(s.start, out[i + 1].start) : Math.max(s.start, Number(duration) || s.start)));
  return out;
}

// Plain text with timestamps: one line each, [h:mm:ss].
export function plainTranscript({ title, segments }) {
  const lines = segments.map((s) => `[${clock(s.start, true)}] ${s.speaker ? s.speaker + ": " : ""}${s.text}`);
  return (title ? `${title}\n\n` : "") + lines.join("\n") + "\n";
}
// SubRip subtitles: each line from its start to its end (or the next
// line's start), at least half a second.
export function srtTranscript(segments, duration) {
  const t = (sec) => {
    const ms = Math.max(0, Math.round(sec * 1000));
    const h = Math.floor(ms / 3600000),
      m = Math.floor((ms % 3600000) / 60000),
      s = Math.floor((ms % 60000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return segments
    .map((s, i) => {
      const next = segments[i + 1]?.start;
      let end = s.end > s.start ? s.end : next != null ? next : Number(duration);
      if (!(end > s.start)) end = s.start + 2;
      end = Math.max(end, s.start + 0.5);
      return `${i + 1}\n${t(s.start)} --> ${t(end)}\n${s.speaker ? s.speaker + ": " : ""}${s.text}\n`;
    })
    .join("\n");
}
// A file name from a title: no path characters, at most 80 characters.
export const fileStem = (title) =>
  String(title || "meeting-notes")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "meeting-notes";
