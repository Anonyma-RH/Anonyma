// Find in Chat (update "findinchat"): search inside the conversation that's
// open, in this browser only. Nothing here touches the network or the page:
// these are the pure parts (reading a rendered message's text, matching,
// stepping, the shortcut and the labels), wired to the page by
// src/FindInChat.jsx.
//
// What gets searched is what the page shows, not the raw message: rendered
// markdown (so `**bold**` is found as "bold"), code blocks, Veil values
// restored on screen, document chips, sources and an open Reasoning. Buttons,
// labels and other controls are left out.

export const FIND_RELEASE = "findinchat";
// The longest query the field accepts, and the most matches highlighted and
// counted (shown as "10,000+").
export const MAX_QUERY = 200;
export const MAX_MATCHES = 10000;
// Put between blocks (paragraphs, list items, table cells, messages' parts)
// so a match never runs from the end of one block into the next. A query
// can't contain it: the field is one line, and queries are cleaned first.
export const SEPARATOR = "\u2029";

// The searchable parts of the open chat, inside the workspace's chat area.
// Only the outermost match counts, so a nested .markdown isn't read twice.
export const CONTENT_SELECTOR = [
  ".message .markdown",
  ".message .citations a",
  ".message details[open] > p",
  ".symposium-question",
  ".symposium-column .markdown",
].join(", ");

// Elements whose text is never searched: controls, hidden parts, and
// anything marked data-find="skip".
const SKIP = new Set([
  "BUTTON",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "OPTION",
  "SCRIPT",
  "STYLE",
  "TEMPLATE",
  "NOSCRIPT",
  "SVG",
  "SUMMARY",
  "IFRAME",
  "CANVAS",
  "AUDIO",
  "VIDEO",
]);
// Elements that start a new line on screen.
const BLOCK = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "BR",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIELDSET",
  "FIGCAPTION",
  "FIGURE",
  "FOOTER",
  "FORM",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HEADER",
  "HR",
  "LI",
  "MAIN",
  "NAV",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "TABLE",
  "TBODY",
  "TD",
  "TFOOT",
  "TH",
  "THEAD",
  "TR",
  "UL",
]);

const attr = (el, name) =>
  typeof el.getAttribute === "function" ? el.getAttribute(name) : null;
const tagOf = (el) => String(el.tagName || el.nodeName || "").toUpperCase();

export function skipped(el) {
  const tag = tagOf(el);
  if (SKIP.has(tag)) return true;
  if (attr(el, "hidden") !== null || attr(el, "inert") !== null) return true;
  if (attr(el, "aria-hidden") === "true") return true;
  if (attr(el, "data-find") === "skip") return true;
  // A closed <details> shows only its summary, which is a label.
  if (tag === "DETAILS" && attr(el, "open") === null) return true;
  return false;
}

// Spaces as they read: non-breaking and other spaces become " ". Outside
// code, line breaks inside a paragraph show as spaces too; in a code block
// ("pre") they stay line breaks, so a match doesn't run across lines.
const SPACE = /[\s\u00a0\u2000-\u200a\u202f\u205f\u3000]/g;
// Built from a string: a minifier can write U+2028 and U+2029 out as raw
// characters, which would end a regular expression literal.
const SPACE_KEEP_LINES = new RegExp(
  "[\\t\\v\\f \\u00a0\\u1680\\u2000-\\u200a\\u202f\\u205f\\u3000\\u2028\\u2029\\ufeff]",
  "g",
);
export function normalizeSpace(value, pre = false) {
  return pre
    ? String(value).replace(/\r/g, "\n").replace(SPACE_KEEP_LINES, " ")
    : String(value).replace(SPACE, " ");
}

// Reads one rendered part of a message (anything with the DOM's nodeType,
// nodeValue, childNodes, tagName and getAttribute) into its searchable text
// and the text nodes it came from. Every character of `text` maps back to
// one character of one node, apart from separators, which map to none.
export function collectText(root) {
  const segments = [];
  let text = "";
  let pendingBreak = false;
  const walk = (node, pre) => {
    if (node.nodeType === 3) {
      const value = node.nodeValue || "";
      if (!value) return;
      // Whitespace before, between and after blocks (ReactMarkdown's "\n")
      // shows as nothing.
      if (!pre && (pendingBreak || !text) && !value.trim()) return;
      if (pendingBreak && text) text += SEPARATOR;
      pendingBreak = false;
      segments.push({
        node,
        start: text.length,
        end: text.length + value.length,
      });
      text += normalizeSpace(value, pre);
      return;
    }
    if (node.nodeType !== 1 || skipped(node)) return;
    const tag = tagOf(node);
    const block = BLOCK.has(tag);
    if (block) pendingBreak = true;
    const inPre = pre || tag === "PRE";
    for (const child of node.childNodes || []) walk(child, inPre);
    if (block) pendingBreak = true;
  };
  for (const child of root?.childNodes || [])
    walk(child, tagOf(root || {}) === "PRE");
  return { text, segments };
}

// ---- Case and words ----

// Lower case with every character keeping its length, so positions in the
// folded text are positions in the page's text. A character whose lower
// case is longer (the Turkish dotted İ) is left as it is. Final sigma folds
// to σ, so "ΟΔΟΣ" finds "οδος" and "οδoς".
export function foldCase(s) {
  s = String(s);
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower.replace(/ς/g, "σ");
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out.replace(/ς/g, "σ");
}

// Letters, digits, combining marks and "_" make words. Scripts written
// without spaces (Chinese, Japanese, Thai…) have no word boundaries to find,
// so there each character counts as a word of its own: "Whole word" never
// hides a match in them.
const WORD = /[\p{L}\p{N}\p{M}_]/u;
const SPACELESS =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Myanmar}]/u;
const isHigh = (c) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c) => c >= 0xdc00 && c <= 0xdfff;
function charBefore(s, i) {
  if (i <= 0) return "";
  if (i >= 2 && isLow(s.charCodeAt(i - 1)) && isHigh(s.charCodeAt(i - 2)))
    return s.slice(i - 2, i);
  return s[i - 1];
}
function charAt(s, i) {
  if (i >= s.length) return "";
  if (isHigh(s.charCodeAt(i)) && isLow(s.charCodeAt(i + 1)))
    return s.slice(i, i + 2);
  return s[i];
}
function edge(outside, inside) {
  if (!outside || !inside) return true;
  if (!WORD.test(outside) || !WORD.test(inside)) return true;
  return SPACELESS.test(outside) || SPACELESS.test(inside);
}
export function isWholeWord(text, start, end) {
  return (
    edge(charBefore(text, start), charAt(text, start)) &&
    edge(charAt(text, end), charBefore(text, end))
  );
}

// ---- Searching ----

// A query as it's searched: one line, spaces as spaces, at most MAX_QUERY
// characters (never cutting an emoji in half). Blank means no search.
export function cleanQuery(query) {
  let q = String(query ?? "").replace(SPACE, " ");
  if (q.length > MAX_QUERY) {
    q = q.slice(0, MAX_QUERY);
    if (isHigh(q.charCodeAt(q.length - 1))) q = q.slice(0, -1);
  }
  return q.trim() ? q : "";
}

// One part's searchable forms, computed once and reused for every query.
export function prepareItem(part) {
  const text = part?.text || "";
  return { ...part, text, folded: foldCase(text) };
}

// Every match of `query` across the prepared parts, in page order, left to
// right and without overlaps, as the browser's own find does: "aa" is found
// twice in "aaaa", at 0 and 2. { matches: [{ item, start, end }], capped }.
export function findMatches(
  items,
  query,
  { matchCase = false, wholeWord = false, limit = MAX_MATCHES } = {},
) {
  const q = cleanQuery(query);
  const matches = [];
  if (!q) return { matches, capped: false };
  const needle = matchCase ? q : foldCase(q);
  for (let i = 0; i < items.length; i++) {
    const hay = matchCase ? items[i].text : items[i].folded;
    if (!hay || hay.length < needle.length) continue;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(needle, from);
      if (at < 0) break;
      const end = at + needle.length;
      if (wholeWord && !isWholeWord(items[i].text, at, end)) {
        from = at + 1;
        continue;
      }
      if (matches.length >= limit) return { matches, capped: true };
      matches.push({ item: i, start: at, end });
      from = end;
    }
  }
  return { matches, capped: false };
}

// Where a match starts and ends in its part's text nodes, for a DOM Range:
// [startNode, startOffset, endNode, endOffset], or null when the text has
// changed under it.
export function matchRange(segments, start, end) {
  const find = (pos, isEnd) => {
    let lo = 0,
      hi = segments.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = segments[mid];
      if (isEnd ? pos <= s.start : pos < s.start) hi = mid - 1;
      else if (isEnd ? pos > s.end : pos >= s.end) lo = mid + 1;
      else return s;
    }
    return null;
  };
  const a = find(start, false);
  const b = find(end, true);
  if (!a || !b) return null;
  return [a.node, start - a.start, b.node, end - b.start];
}

// The match after (1) or before (-1) the current one, going round.
export function step(index, total, direction) {
  if (!total) return -1;
  if (index < 0) return direction < 0 ? total - 1 : 0;
  return (((index + direction) % total) + total) % total;
}

// After a search re-runs on changed content, the match at or after where the
// current one was ({ item, start }), so reading position isn't lost; -1 if
// there are none.
export function sameOrNext(matches, previous) {
  if (!matches.length) return -1;
  if (!previous) return 0;
  const at = matches.findIndex(
    (m) =>
      m.item > previous.item ||
      (m.item === previous.item && m.start >= previous.start),
  );
  return at < 0 ? matches.length - 1 : at;
}

// Which match a fresh search starts on, given each match's top and bottom
// on screen (tops(i) → { top, bottom }) and the top of the readable area:
// the first match at or below where you're reading, else the nearest one
// above it. Page order is top to bottom, so this stops early.
export function startIndex(total, rectOf, bandTop) {
  if (!total) return -1;
  for (let i = 0; i < total; i++) {
    const r = rectOf(i);
    if (r && r.bottom >= bandTop) return i;
  }
  return total - 1;
}

// ---- Labels ----

const num = (n) => Number(n).toLocaleString("en-US");
// The count next to the field, which is also the live region screen readers
// announce. Chinese is written here (not through the page translator) so the
// numbers never meet a generic "{0} of {1}" pattern.
export function countLabel(
  { index = -1, total = 0, capped = false, query = "" } = {},
  zh = false,
) {
  if (!cleanQuery(query)) return "";
  if (!total) return zh ? "无匹配" : "No matches";
  const n = num(total) + (capped ? "+" : "");
  const i = num(index + 1);
  return zh ? `第 ${i} 个，共 ${n} 个` : `${i} of ${n}`;
}

// ---- The shortcut ----

// ⌘F on Apple platforms, Ctrl+F elsewhere; never with Shift or Alt, or while
// an input method is composing.
export function isFindShortcut(e, apple) {
  if (!e || e.isComposing || e.altKey || e.shiftKey) return false;
  if (!(e.key === "f" || e.key === "F" || e.code === "KeyF")) return false;
  return apple ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
}
// While the bar is open: ⌘G / Ctrl+G and F3 go to the next match, with Shift
// the previous one. 0 when it's another key.
export function findStepKey(e, apple) {
  if (!e || e.isComposing || e.altKey) return 0;
  const dir = e.shiftKey ? -1 : 1;
  if (e.key === "F3" && !e.metaKey && !e.ctrlKey) return dir;
  if (!(e.key === "g" || e.key === "G" || e.code === "KeyG")) return 0;
  const mod = apple ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
  return mod ? dir : 0;
}
export const findShortcutLabel = (apple) => (apple ? "⌘F" : "Ctrl F");
export const findAriaShortcut = (apple) => (apple ? "Meta+F" : "Control+F");

// Whether ⌘F / Ctrl+F opens Find in Chat for the focused element, described
// as { editable, composer, inBar, inWorkspace, body }: from the page itself,
// the chat, the composer or the bar; never from another text field (a rename
// box, the model search…), which keeps the browser's own find.
export function takesShortcut({
  body = false,
  inBar = false,
  composer = false,
  editable = false,
  inWorkspace = false,
} = {}) {
  if (body || inBar || composer) return true;
  return inWorkspace && !editable;
}
