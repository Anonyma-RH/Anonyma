import { chatLimits } from "../data/chat-limits.js";
import { isReleased } from "./releases.js";
import { chatPrice, fail, usdUnits } from "./core.js";
import { wavParts } from "./audio-overview.js";
import { unescapeDocumentText } from "../src/documents.js";
import {
  CHARS_PER_MINUTE,
  CHUNK_RATE,
  MAX_NOTES_CHARS,
  NOTES_PROMPT_START,
  maxTranscriptChars,
  notesMessages,
  parseClock,
  stamp,
} from "../src/meeting-notes.js";

// Meeting Notes (update "meetingnotes"): what each step can cost at most,
// the pieces' audio check, reading a transcription reply's timestamps, and
// the local test stand-ins for the transcription and notes models. The
// routes are server/routes/meeting-notes.js; the parts shared with the
// browser are in src/meeting-notes.js.

// ---- Money ----

// What `seconds` of audio cost to transcribe, in integer units at the
// account's rate: the model's published price per minute, pro rata (as
// /api/audio/transcriptions charges).
export const sttCharge = (seconds, stt, factor) => usdUnits((seconds / 60) * stt.pricing.api_price * factor);

// The notes' reply budget, in tokens. Reasoning models spend part of it
// thinking before they answer, so it's well above what the notes need,
// capped by the model's own output limit (as /api/chat would cap it).
export const NOTES_BUDGET = { short: 8000, long: 12000 };
export function notesBudget(cfg, m, duration) {
  const want = duration > 3600 ? NOTES_BUDGET.long : NOTES_BUDGET.short;
  const cap = isReleased(cfg, "longanswers") ? chatLimits(m).maxOutputTokens : 8192;
  return Math.max(1, Math.min(want, cap));
}
// The notes step's plan for a recording: its reply budget, the longest
// transcript it will carry (the recording's longest likely transcript,
// within what one message and the model's context allow), and the most it
// can cost: the prompt with a transcript of exactly that length plus the
// whole reply budget. Quote, hold and run all use this.
export function notesPlan({ cfg, m, duration, language, factor }) {
  const budget = notesBudget(cfg, m, duration);
  const extended = isReleased(cfg, "longanswers");
  const empty = notesMessages({ text: "", duration, language });
  const promptBytes = empty.reduce((n, x) => n + 8 + Buffer.byteLength(x.content), 8);
  // The model's context allowance (when Longer Answers applies it), less
  // the prompt and the reply budget; a message's own character cap else.
  const room = extended
    ? Math.max(0, (chatLimits(m).contextTokens || 32768) - budget - promptBytes - 64)
    : Math.max(0, 46000 - promptBytes);
  const wanted = maxTranscriptChars(duration);
  const maxChars = Math.min(wanted, extended ? MAX_NOTES_CHARS : 46000, room);
  const messages = notesMessages({ text: "x".repeat(maxChars), duration, language });
  const amount = chatPrice(m, messages, budget, 0, factor);
  return {
    budget,
    maxChars,
    maxBytes: room,
    messages,
    amount,
    // Roughly how much of the recording the notes can cover, when the
    // model can't take a transcript as long as it may be (null: all of it).
    covers: maxChars < wanted ? Math.floor((maxChars / CHARS_PER_MINUTE) * 60) : null,
  };
}

// ---- A piece's audio ----

// A piece as the browser sends it: a WAV of mono 16-bit PCM at 16 kHz.
// Only its format and samples are kept: whatever other chunks the file
// carried never reach the provider. Returns { bytes, seconds }.
export function cleanPiece(buf) {
  const parts = wavParts(buf);
  if (!parts) fail(400, "Send each piece as a WAV file.", "invalid_audio");
  const { fmt, data } = parts;
  if (
    fmt.readUInt16LE(0) !== 1 ||
    fmt.readUInt16LE(2) !== 1 ||
    fmt.readUInt32LE(4) !== CHUNK_RATE ||
    fmt.readUInt16LE(14) !== 16
  )
    fail(400, "Send each piece as mono 16-bit PCM at 16 kHz.", "invalid_audio");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(CHUNK_RATE, 24);
  header.writeUInt32LE(CHUNK_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return { bytes: Buffer.concat([header, data]), seconds: data.length / 2 / CHUNK_RATE };
}

// ---- Timestamps from the transcription reply ----

const num = (v) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null);
const words = (v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim() : "");
// A provider's speaker id as a label: 0 → "Speaker 1". Only when the
// provider gives one; never guessed.
export function speakerLabel(v) {
  if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < 100) return `Speaker ${v + 1}`;
  if (typeof v === "string" && /^\d{1,2}$/.test(v.trim())) return `Speaker ${Number(v) + 1}`;
  if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").trim().slice(0, 40);
  return null;
}
const line = (start, end, text, speaker) => {
  const s = num(start),
    e = num(end);
  const t = words(text);
  if (s == null || !t) return null;
  const label = speakerLabel(speaker);
  return { start: s, end: e != null && e >= s ? e : s, text: t, ...(label ? { speaker: label } : {}) };
};
// Words into lines: a new line at a speaker change, a pause of a second or
// more, a sentence end once a line has run 6 seconds, or at 20 seconds.
function fromWords(list) {
  const out = [];
  let cur = null;
  for (const w of list) {
    const text = words(w?.punctuated_word ?? w?.word ?? w?.text);
    const start = num(w?.start),
      end = num(w?.end);
    if (!text || start == null) continue;
    const speaker = speakerLabel(w?.speaker);
    if (
      cur &&
      (speaker !== cur.speaker ||
        start - cur.end >= 1 ||
        (/[.!?。！？]$/.test(cur.text) && cur.end - cur.start >= 6) ||
        cur.end - cur.start >= 20)
    ) {
      out.push(cur);
      cur = null;
    }
    if (!cur) cur = { start, end: end ?? start, text, speaker };
    else {
      cur.text += (/^[\u3400-\u9fff]/.test(text) && /[\u3400-\u9fff]$/.test(cur.text) ? "" : " ") + text;
      cur.end = Math.max(cur.end, end ?? start);
    }
  }
  if (cur) out.push(cur);
  return out.map((c) => line(c.start, c.end, c.text, c.speaker)).filter(Boolean);
}
// The timed lines in a transcription reply, in the shapes providers use:
// OpenAI-style verbose_json segments, Deepgram utterances or paragraphs,
// or words. Speaker labels only where the reply has them. [] when the
// reply has no timings (the caller then times the piece as one line).
export function transcriptSegments(j) {
  if (!j || typeof j !== "object") return [];
  if (Array.isArray(j.segments) && j.segments.length) {
    const segments = j.segments.map((s) => line(s?.start, s?.end, s?.text, s?.speaker)).filter(Boolean);
    const wordSource = j.words ?? j.results?.channels?.[0]?.alternatives?.[0]?.words;
    const finer = Array.isArray(wordSource) ? fromWords(wordSource) : [];
    // Some gateways include one segment for the entire piece alongside
    // real word timings. Prefer that finer evidence; never invent times.
    if (finer.length > segments.length && segments.some((s) => s.end - s.start > 20)) return finer;
    if (segments.length) return segments;
  }
  const results = j.results && typeof j.results === "object" ? j.results : null;
  if (Array.isArray(results?.utterances) && results.utterances.length)
    return results.utterances.map((u) => line(u?.start, u?.end, u?.transcript ?? u?.text, u?.speaker)).filter(Boolean);
  const alt = results?.channels?.[0]?.alternatives?.[0];
  const paragraphs = alt?.paragraphs?.paragraphs;
  if (Array.isArray(paragraphs) && paragraphs.length)
    return paragraphs
      .flatMap((p) =>
        (Array.isArray(p?.sentences) ? p.sentences : []).map((s) => line(s?.start, s?.end, s?.text, p?.speaker)),
      )
      .filter(Boolean);
  const list = Array.isArray(j.words) && j.words.length ? j.words : Array.isArray(alt?.words) ? alt.words : [];
  return list.length ? fromWords(list) : [];
}

// ---- Local test mode ----

// LOCAL_TEST_MODE only: a scripted meeting stands in for the transcription
// model, one line every 26 seconds, so the whole flow runs with no
// provider. It carries no speaker labels (the gateway's transcription
// doesn't return any). Never used live.
export const TEST_LINE_SECONDS = 26;
export const TEST_MEETING = [
  "Okay, let's get started. This is the weekly launch sync for Atlas 2.0.",
  "Quick agenda: the pricing page, the beta feedback, and the Android build.",
  "First, pricing. Last week we had two options for the free tier.",
  "I looked at the numbers again. Most beta users stay under 1,000 credits a month.",
  "So we decided to keep the free tier at 1,000 credits, and drop the idea of a trial.",
  "Good. Maya will update the pricing page copy before Thursday.",
  "I can do that. I'll send the draft to maya.chen@example.com for review first, then post it.",
  "Next, the beta feedback. We had 140 responses this week.",
  "The top complaint is still the export. People want Markdown, not just PDF.",
  "Agreed: Markdown export ships in 2.0, and PDF can wait for 2.1.",
  "Dev, can you size the Markdown export work by Monday?",
  "Sure, I'll have an estimate by Monday.",
  "Second complaint was the onboarding. Three people got stuck on the workspace invite.",
  "Do we know if that's the email or the link itself?",
  "Not yet. Nobody has looked at the logs for that.",
  "Priya will review the invite flow and write up what's breaking.",
  "Okay. Then the Android build.",
  "The build is green, but the store review flagged the microphone permission text.",
  "We need to explain why the app asks for the microphone before the first recording.",
  "Let's go with the short explanation screen we used on iOS.",
  "Tom will port the iOS permission screen to Android this sprint.",
  "Do we still want the tablet layout in this release?",
  "I'd say no. It's not tested enough, and it's not blocking anyone.",
  "Fine, the tablet layout moves to 2.1.",
  "One more thing. Legal asked whether transcripts are stored on our side.",
  "Who owns the reply to legal? I don't think that's been decided.",
  "Let's leave it open and pick it up with Sam on Friday.",
  "Also, the launch date. Is the 14th still realistic with the store review?",
  "If the review passes by Wednesday, yes. Otherwise it slips a week.",
  "Right. So the date depends on the Android review.",
  "Last item: the press list. Maya, can you share the final list in the channel?",
  "Yes, I'll post it after this call.",
  "Great. Anything else before we wrap?",
  "Just a reminder that the retro is moved to Thursday at 3.",
  "Thanks, everyone. Same time next week.",
];
export function meetingTestTranscript({ start, seconds }) {
  const segments = [];
  const first = Math.ceil(start / TEST_LINE_SECONDS - 1e-9);
  for (let k = first; k * TEST_LINE_SECONDS < start + seconds; k++) {
    const at = k * TEST_LINE_SECONDS;
    const text = TEST_MEETING[k % TEST_MEETING.length];
    const s = at - start;
    const e = Math.min(seconds, s + Math.min(TEST_LINE_SECONDS - 2, 4 + text.length / 15));
    segments.push({ start: Math.round(s * 100) / 100, end: Math.round(e * 100) / 100, text });
  }
  return { text: segments.map((s) => s.text).join(" "), duration: seconds, segments };
}

// A deterministic stand-in for the notes model: it reads the transcript
// back out of the prompt and files its lines by simple patterns (decisions,
// "X will…", "X, can you…", questions). Names come only from those lines.
export function meetingNotesTestReply(messages) {
  const system = messages?.[0]?.content;
  if (typeof system !== "string" || !system.startsWith(NOTES_PROMPT_START)) return null;
  const user = String(messages.find((m) => m.role === "user")?.content || "");
  const doc = /<document name="[^"]*"[^>]*>([\s\S]*?)<\/document>/.exec(user);
  const length = /The recording is ([\d:]+) long/.exec(user)?.[1] || "0:00";
  const duration = parseClock(length) || 0;
  const lines = unescapeDocumentText(doc?.[1] || "")
    .split("\n")
    .map((l) => /^\[([\d:]+)\] (?:(Speaker \d+): )?(.*)$/.exec(l))
    .filter(Boolean)
    .map((m) => ({ at: m[1], text: m[3].trim() }));
  const decisions = [],
    actions = [],
    questions = [];
  const seen = new Set();
  for (const { at, text } of lines) {
    if (seen.has(text)) continue;
    seen.add(text);
    let m;
    const due = (task) => /\b(?:by|before) [A-Z][a-z]+/.exec(task)?.[0] || null;
    const upper = (task) => task[0].toUpperCase() + task.slice(1);
    if ((m = /(?:^|\. )([A-Z][a-z]+) will (.+?)\.?$/.exec(text))) actions.push({ task: upper(m[2]), owner: m[1], due: due(m[2]), at });
    else if ((m = /(?:^|\. )([A-Z][a-z]+), can you (.+?)\??$/.exec(text))) actions.push({ task: upper(m[2]), owner: m[1], due: due(m[2]), at });
    else if (/\b(we decided|agreed|let's go with|moves to)\b/i.test(text)) decisions.push({ text: upper(text.replace(/^(So |Fine, |Agreed: )/, "")), at });
    else if (/\?/.test(text) && !/^(Great|Okay)\b/.test(text)) questions.push({ text, at });
  }
  const topic = /this is (?:the |our )?(.+?)(?: for (.+?))?\.$/i.exec(lines[0]?.text || "");
  const title = topic ? `${topic[1][0].toUpperCase()}${topic[1].slice(1)}${topic[2] ? " · " + topic[2] : ""}` : "Meeting";
  const summary = [
    `Local test notes, made without a model from ${lines.length} transcript lines (${stamp(duration, duration)} of recording).`,
    lines[1] ? `It opened with: “${lines[1].text}”` : "",
    `${decisions.length} decisions, ${actions.length} action items and ${questions.length} open questions were picked out by simple patterns.`,
  ]
    .filter(Boolean)
    .join(" ");
  return JSON.stringify({ title, summary, decisions, action_items: actions, open_questions: questions });
}
