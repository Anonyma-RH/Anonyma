// Reviewed text helpers from the existing voice branch. This release reads
// complete replies only, after an explicit Play action. No streaming loop.
// No JSX/DOM here so this file can be unit tested directly.

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "eg",
  "ie",
  "approx",
  "inc",
  "ltd",
  "co",
  "no",
  "vol",
  "fig",
  "al",
  "cf",
  "gen",
  "rep",
]);

// A fenced code block is skipped: reading code aloud is unusable, so it is
// replaced with a short spoken summary of its size instead.
export function summarizeCodeBlocks(text) {
  return text.replace(/```[^\n`]*\n?([\s\S]*?)```/g, (_, body) => {
    const lines = body.split("\n").filter((l) => l.trim()).length;
    return ` Here's a code block, ${lines || 1} line${lines === 1 ? "" : "s"}. `;
  });
}

// A "." at `index` is unsafe to split on if it's part of a decimal number
// (3.14), a known abbreviation (Mr.), or a single-letter initial (J. R. R.).
function isSafePeriod(text, index) {
  const before = text.slice(0, index);
  const after = text.slice(index + 1);
  if (/\d$/.test(before) && /^\d/.test(after)) return false;
  const word = before.match(/([A-Za-z]+)$/)?.[1]?.toLowerCase();
  if (word && ABBREVIATIONS.has(word)) return false;
  // A run of dotted single letters (an initial, or "a.m."/"U.S.") ending
  // right before this period is not a real sentence end.
  if (/(^|\s)([A-Za-z]\.){0,3}[A-Za-z]$/.test(before)) return false;
  return true;
}

// The end index (exclusive) of the next safe sentence boundary at or after
// `from`, or -1 if none is found. Chinese and Japanese full stops (。！？)
// end a sentence with no space after them.
function nextSentenceEnd(text, from = 0) {
  const re = /[.!?]+(?=\s|$)|[。！？]+/g;
  re.lastIndex = from;
  let m;
  while ((m = re.exec(text))) {
    const end = m.index + m[0].length;
    if (m[0][0] !== "." || isSafePeriod(text, m.index)) return end;
    re.lastIndex = m.index + 1;
  }
  return -1;
}

// Force-splits an overlong run of text at the last word boundary before the
// limit (or a hard cut if there is no good space), so a very long sentence
// still produces a speakable chunk instead of stalling everything after it.
function splitLong(text, maxChunkChars) {
  let cut = text.lastIndexOf(" ", maxChunkChars);
  if (cut < maxChunkChars * 0.5) cut = maxChunkChars;
  return [text.slice(0, cut).trim(), text.slice(cut).trim()];
}

// Splits a block of COMPLETE text into speakable chunks: sentences are kept
// together up to maxChunkChars, short sentences are merged, and sentences
// longer than the limit are force-split at word boundaries. Code blocks are
// replaced by a spoken summary first.
export function splitSentences(rawText, { maxChunkChars = 400 } = {}) {
  const text = summarizeCodeBlocks(rawText)
    .replace(/[ \t]+/g, " ")
    .trim();
  if (!text) return [];
  const sentences = [];
  let start = 0;
  for (;;) {
    const end = nextSentenceEnd(text, start);
    if (end === -1) {
      const rest = text.slice(start).trim();
      if (rest) sentences.push(rest);
      break;
    }
    sentences.push(text.slice(start, end).trim());
    start = end;
  }
  const chunks = [];
  let current = "";
  for (let s of sentences) {
    while (s.length > maxChunkChars) {
      const [piece, rest] = splitLong(s, maxChunkChars);
      if (current) {
        chunks.push(current);
        current = "";
      }
      if (piece) chunks.push(piece);
      s = rest;
    }
    if (!s) continue;
    if (current && current.length + 1 + s.length > maxChunkChars) {
      chunks.push(current);
      current = s;
    } else {
      current = current ? current + " " + s : s;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// What a voice should say for a chunk of markdown: headings, emphasis, code
// ticks, links and list bullets are formatting, not words.
export function speakable(text) {
  return String(text || "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\n]+)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n+\s*/g, " ")
    .trim();
}

// Veil's tags ([EMAIL_1], [PHONE_2]) read as words ("email 1") rather than
// as brackets and underscores; the real values never reach the voice.
export function speakVeilTags(text) {
  return String(text || "").replace(
    /\[([A-Z]+)_(\d+)\]/g,
    (_, type, n) => type.toLowerCase() + " " + n,
  );
}
