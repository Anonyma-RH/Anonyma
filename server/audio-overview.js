import { chatLimits } from "../data/chat-limits.js";
import { isReleased } from "./releases.js";
import { chatPrice, usdUnits } from "./core.js";
import { buildDocumentBlock, DATA_NOTICE_BLOCK, unescapeDocumentText } from "../src/documents.js";
import { LENGTHS, languageName, MAX_TITLE } from "../src/audio-overview.js";

// Audio Overview (update "audiooverview"): the script prompt, what a run can
// cost at most, the local test stand-in for the script model, and joining
// the voiced turns into one file. The route is server/routes/audio-overview.js;
// the parts shared with the browser are in src/audio-overview.js.

// The script's reply budget, in tokens. Reasoning models spend part of it
// thinking before they answer (batch 5 saw about 1,900 hidden tokens), so
// it's well above what the script itself needs, and capped by the model's
// own output limit (as /api/chat would cap it).
export const SCRIPT_BUDGET = { short: 8000, long: 12000 };
export function scriptBudget(cfg, m, length) {
  const cap = isReleased(cfg, "longanswers") ? chatLimits(m).maxOutputTokens : 8192;
  return Math.max(1, Math.min(SCRIPT_BUDGET[length], cap));
}

const KIND_NAMES = { document: "document", chat: "chat", research: "research report" };
export const SCRIPT_PROMPT_START = "You write the script for a two-host audio overview";
export function scriptPrompt(length, language) {
  const spec = LENGTHS[length];
  return [
    `${SCRIPT_PROMPT_START} of the source the user gives you.`,
    "Host A leads and explains. Host B asks what a curious listener would ask, and adds points from the source. They take turns, starting with A.",
    "Write plain spoken sentences: no lists, headings, Markdown, links, emoji or stage directions.",
    "Use only facts stated in the source. Add no facts, figures, names or opinions from anywhere else. Where the source is thin or unclear, the hosts say so.",
    "Never invent quotes. Quote someone only when the source quotes them word for word, and say who said it.",
    `Length: about ${spec.words} words in all (in Chinese, Japanese or Korean, about ${spec.minutes * 270} characters), about ${spec.minutes} minutes read aloud. Never more than ${spec.maxTurns} turns.`,
    `Language: write the title, chapters and turns in ${languageName(language)}.`,
    "Split the turns into 2 to 6 chapters. Each chapter's \"turn\" is the index of its first turn; the first chapter starts at 0.",
    "Reply with JSON only, exactly in this shape:",
    '{"title": "...", "chapters": [{"title": "...", "turn": 0}], "turns": [{"speaker": "A", "text": "..."}, {"speaker": "B", "text": "..."}]}',
  ].join("\n");
}

// The source goes as one document block with Injection Shield's data notice
// ("send as data"), so instructions inside it are read as text.
export function scriptMessages({ source, length, language }) {
  return [
    { role: "system", content: scriptPrompt(length, language) },
    {
      role: "user",
      content:
        `Write the audio overview script for this ${KIND_NAMES[source.kind] || "source"}.\n\n` +
        buildDocumentBlock({ name: source.title, text: source.text }) +
        "\n\n" +
        DATA_NOTICE_BLOCK,
    },
  ];
}

// What the voices cost for `chars` characters, in integer units at the
// account's rate: the voice model's published price per 1,000 characters.
export const voiceCharge = (chars, tts, factor) =>
  usdUnits((chars / 1000) * tts.pricing.api_price * factor);

// The most a run can cost, in integer units at the account's rate: the
// script (its prompt plus the whole reply budget) and the voices for the
// length's character cap. Quote and run use this same function.
export function overviewCosts({ cfg, m, tts, messages, length, factor }) {
  const budget = scriptBudget(cfg, m, length);
  const script = chatPrice(m, messages, budget, 0, factor);
  const voices = voiceCharge(LENGTHS[length].maxChars, tts, factor);
  return { budget, amounts: { script, voices }, total: script + voices };
}

// ---- Local test mode ----

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for
// the script model. It reads the source back out of the prompt and has the
// hosts take turns reading its sentences, so the whole flow runs with no
// provider. Never used live.
export function overviewTestReply(messages) {
  const system = messages?.[0]?.content;
  if (typeof system !== "string" || !system.startsWith(SCRIPT_PROMPT_START)) return null;
  const user = String(messages.find((m) => m.role === "user")?.content || "");
  const doc = /<document name="([^"]*)"[^>]*>([\s\S]*?)<\/document>/.exec(user);
  const text = unescapeDocumentText(doc?.[2] || "");
  // The source's first heading, else its name without a file extension.
  const heading = /^#{1,3}\s+(.+)$/m.exec(text)?.[1];
  const title = (heading || unescapeDocumentText(doc?.[1] || "your source").replace(/\.[a-z0-9]{1,5}$/i, ""))
    .trim()
    .slice(0, MAX_TITLE);
  const long = /about 1200 words/.test(system);
  const chinese = /[\u3400-\u9fff]/.test(text);
  // Sentences: a line at a time, split where a sentence end is followed by
  // a capital, a digit or Chinese (so "5 a.m. on" and "2.4" stay whole).
  const sentences = text
    .split("\n")
    .map((line) => line.replace(/^(User|Assistant): /, "").replace(/^(?:[-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, "").trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z0-9"“\u3400-\u9fff])|(?<=[。！？])/))
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 20 && /[.!?。！？]$/.test(s))
    .slice(0, long ? 40 : 14);
  const say = (speaker, t) => ({ speaker, text: t });
  const turns = chinese
    ? [say("A", `欢迎收听。今天我们来聊聊《${title}》。`), say("B", "好的，先说最重要的一点。")]
    : [say("A", `Welcome. Today we're looking at ${title}.`), say("B", "Let's start with the main point.")];
  sentences.forEach((s, i) => turns.push(say(i % 2 ? "B" : "A", s)));
  turns.push(
    chinese
      ? say(turns.length % 2 ? "B" : "A", "以上就是这次的概览，内容全部来自原文。")
      : say(turns.length % 2 ? "B" : "A", "That's the overview. Everything in it came from the source."),
  );
  const third = Math.max(2, Math.floor(turns.length / 3));
  const chapters = chinese
    ? [{ title: "开场", turn: 0 }, { title: "要点", turn: 2 }, { title: "细节", turn: 2 + third }, { title: "总结", turn: turns.length - 1 }]
    : [{ title: "Introduction", turn: 0 }, { title: "Key points", turn: 2 }, { title: "The details", turn: 2 + third }, { title: "Wrap-up", turn: turns.length - 1 }];
  return JSON.stringify({ title, chapters: chapters.filter((c) => c.turn < turns.length), turns });
}

// ---- Joining the clips ----

const V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
// An MPEG audio Layer III frame header at `i`, or null.
function mp3Header(buf, i) {
  if (i + 4 > buf.length || buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (buf[i + 1] >> 3) & 3; // 0: MPEG 2.5, 2: MPEG 2, 3: MPEG 1
  const layer = (buf[i + 1] >> 1) & 3; // 1: Layer III
  if (version === 1 || layer !== 1) return null;
  const bitrateIndex = buf[i + 2] >> 4,
    rateIndex = (buf[i + 2] >> 2) & 3,
    padding = (buf[i + 2] >> 1) & 1;
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const v1 = version === 3;
  const bitrate = (v1 ? V1_L3 : V2_L3)[bitrateIndex] * 1000;
  const sampleRate = [44100, 48000, 32000][rateIndex] / (v1 ? 1 : version === 2 ? 2 : 4);
  const samples = v1 ? 1152 : 576;
  const mono = buf[i + 3] >> 6 === 3;
  return {
    length: Math.floor(((samples / 8) * bitrate) / sampleRate) + padding,
    sampleRate,
    samples,
    mono,
    side: v1 ? (mono ? 17 : 32) : mono ? 9 : 17,
  };
}
// An MP3 clip's audio frames, without its ID3 tags or its Xing/Info/VBRI
// frame (whose frame count would be wrong for the joined file), and how
// long they play. Null when it isn't a plain Layer III stream.
export function mp3Frames(buf) {
  let i = 0;
  if (buf.length >= 10 && buf.toString("latin1", 0, 3) === "ID3") {
    const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
    i = 10 + size + (buf[5] & 0x10 ? 10 : 0);
  }
  // Find the first frame: a header whose next frame is a header too.
  const limit = Math.min(buf.length, i + 4096);
  let first = null;
  for (; i < limit; i++) {
    const h = mp3Header(buf, i);
    if (h && (i + h.length === buf.length || mp3Header(buf, i + h.length))) {
      first = h;
      break;
    }
  }
  if (!first) return null;
  const frames = [];
  let samples = 0,
    index = 0;
  while (i < buf.length) {
    const h = mp3Header(buf, i);
    if (!h || i + h.length > buf.length) break;
    if (h.sampleRate !== first.sampleRate || h.mono !== first.mono) return null;
    const tag = buf.toString("latin1", i + 4 + h.side, i + 8 + h.side);
    const info = index === 0 && (tag === "Xing" || tag === "Info" || buf.toString("latin1", i + 36, i + 40) === "VBRI");
    if (!info) {
      frames.push(buf.subarray(i, i + h.length));
      samples += h.samples;
    }
    i += h.length;
    index++;
  }
  if (!frames.length) return null;
  return { frames, seconds: samples / first.sampleRate, sampleRate: first.sampleRate, mono: first.mono };
}
// A WAV clip's format chunk and PCM data, and how long it plays. A data
// size of 0 or 0xFFFFFFFF (a streamed WAV) means "to the end".
export function wavParts(buf) {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== "RIFF" || buf.toString("latin1", 8, 12) !== "WAVE")
    return null;
  let i = 12,
    fmt = null,
    data = null;
  while (i + 8 <= buf.length) {
    const id = buf.toString("latin1", i, i + 4);
    let size = buf.readUInt32LE(i + 4);
    const start = i + 8;
    if (id === "data") {
      if (size === 0 || size === 0xffffffff || start + size > buf.length) size = buf.length - start;
      data = buf.subarray(start, start + size);
      break;
    }
    if (start + size > buf.length) return null;
    if (id === "fmt ") fmt = buf.subarray(start, start + size);
    i = start + size + (size & 1);
  }
  if (!fmt || fmt.length < 16 || fmt.length & 1 || !data) return null;
  const byteRate = fmt.readUInt32LE(8),
    blockAlign = fmt.readUInt16LE(12);
  if (!byteRate || !blockAlign) return null;
  data = data.subarray(0, data.length - (data.length % blockAlign));
  return { fmt, data, seconds: data.length / byteRate };
}

// Joins the voiced turns into one file when that's simple with the format
// the voice model returned: MP3 frames with one sample rate and channel
// mode, or WAV with one format. Returns { bytes, mime, starts, duration }
// (each clip's start, in seconds), or null for anything else, which the
// browser then plays as a playlist.
export function stitchClips(clips) {
  if (!clips.length) return null;
  const kind = (mime) => (mime === "audio/mpeg" ? "mp3" : ["audio/wav", "audio/x-wav"].includes(mime) ? "wav" : null);
  const k = kind(clips[0].mime);
  if (!k || clips.some((c) => kind(c.mime) !== k)) return null;
  const starts = [];
  let at = 0;
  if (k === "mp3") {
    const parts = clips.map((c) => mp3Frames(c.bytes));
    if (parts.some((p) => !p)) return null;
    if (parts.some((p) => p.sampleRate !== parts[0].sampleRate || p.mono !== parts[0].mono)) return null;
    for (const p of parts) {
      starts.push(at);
      at += p.seconds;
    }
    return { bytes: Buffer.concat(parts.flatMap((p) => p.frames)), mime: "audio/mpeg", starts, duration: at };
  }
  const parts = clips.map((c) => wavParts(c.bytes));
  if (parts.some((p) => !p) || parts.some((p) => !p.fmt.equals(parts[0].fmt))) return null;
  for (const p of parts) {
    starts.push(at);
    at += p.seconds;
  }
  const fmt = parts[0].fmt;
  const size = parts.reduce((n, p) => n + p.data.length, 0);
  const header = Buffer.alloc(20 + fmt.length + 8);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(4 + 8 + fmt.length + 8 + size + (size & 1), 4);
  header.write("WAVE", 8, "latin1");
  header.write("fmt ", 12, "latin1");
  header.writeUInt32LE(fmt.length, 16);
  fmt.copy(header, 20);
  header.write("data", 20 + fmt.length, "latin1");
  header.writeUInt32LE(size, 24 + fmt.length);
  return {
    bytes: Buffer.concat([header, ...parts.map((p) => p.data), ...(size & 1 ? [Buffer.alloc(1)] : [])]),
    mime: "audio/wav",
    starts,
    duration: at,
  };
}
