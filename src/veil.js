// Veil: masks sensitive values in a prompt before it ever leaves the browser.
// Pure detection/round-trip logic lives here so it can be unit tested without
// React or a DOM. Storage helpers below reuse lib.js's guarded localStorage
// wrappers; nothing here ever sends the tag/value map anywhere.
import { readStore, saveStore } from "./lib.js";

// Luhn checksum, used to keep card-number detection conservative: a random
// 13-19 digit run (an order number, an ISBN, a serial) fails this far more
// often than it passes.
export function luhnValid(digits) {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0,
    alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}
// IBAN mod-97 checksum (ISO 7064). Keeps a plain "two letters + digits" token
// from being flagged unless it is actually a valid account number.
export function ibanValid(value) {
  const v = value.toUpperCase().replace(/\s+/g, "");
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let remainder = 0;
  for (let i = 0; i < expanded.length; i++)
    remainder = (remainder * 10 + Number(expanded[i])) % 97;
  return remainder === 1;
}
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
const PHONE_INTL = "\\+\\d{1,3}[-.\\s]?\\(?\\d{1,4}\\)?(?:[-.\\s]?\\d{2,4}){1,4}";
const PHONE_PAREN = "\\(\\d{3}\\)[-.\\s]?\\d{3}[-.\\s]?\\d{4}";
const PHONE_DASH = "\\b\\d{3}[-.\\s]\\d{3}[-.\\s]\\d{4}\\b";
const IPV4 =
  "\\b(?:(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\.){3}(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)\\b";
// Broadly used compact IPv6 pattern (full, compressed and mixed forms).
// A compressed address can start or end with ":", where \b doesn't apply
// (":" and the surrounding whitespace are both non-word), so boundaries are
// enforced with lookaround instead.
const IPV6 =
  "(?<![A-Za-z0-9:])(?:(?:[A-Fa-f0-9]{1,4}:){7}[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,7}:|(?:[A-Fa-f0-9]{1,4}:){1,6}:[A-Fa-f0-9]{1,4}|(?:[A-Fa-f0-9]{1,4}:){1,5}(?::[A-Fa-f0-9]{1,4}){1,2}|(?:[A-Fa-f0-9]{1,4}:){1,4}(?::[A-Fa-f0-9]{1,4}){1,3}|(?:[A-Fa-f0-9]{1,4}:){1,3}(?::[A-Fa-f0-9]{1,4}){1,4}|(?:[A-Fa-f0-9]{1,4}:){1,2}(?::[A-Fa-f0-9]{1,4}){1,5}|[A-Fa-f0-9]{1,4}:(?:(?::[A-Fa-f0-9]{1,4}){1,6})|:(?:(?::[A-Fa-f0-9]{1,4}){1,7}|:))(?![A-Za-z0-9:])";
// Priority-ordered detectors. Earlier entries win when two candidates start
// at the same position (see collectMatches); everything else is resolved by
// leftmost start.
const DETECTORS = [
  { type: "EMAIL", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g },
  {
    // Known secret prefixes, then bare 64-hex material (private keys).
    type: "KEY",
    pattern:
      /\bsk-ant-[A-Za-z0-9_-]{10,}\b|\bsk-[A-Za-z0-9_-]{10,}\b|\bghp_[A-Za-z0-9]{20,}\b|\bgithub_pat_[A-Za-z0-9_]{20,}\b|\bAKIA[A-Z0-9]{12,}\b|\bxox[bpa]-[A-Za-z0-9-]{10,}\b|\bAIza[A-Za-z0-9_-]{20,}\b|\b[a-fA-F0-9]{64}\b/g,
  },
  {
    type: "WALLET",
    pattern:
      /\b0x[a-fA-F0-9]{40}\b|\bbc1[ac-hj-np-z02-9]{6,87}\b|\b[13][a-km-zA-HJ-NP-Z1-9]{25,34}\b/g,
  },
  {
    type: "IBAN",
    pattern: /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g,
    validate: ibanValid,
  },
  {
    type: "CARD",
    pattern: /\b(?:\d[ -]?){12,18}\d\b/g,
    validate: (value) => {
      const digits = value.replace(/[ -]/g, "");
      return digits.length >= 13 && digits.length <= 19 && luhnValid(digits);
    },
  },
  {
    type: "PHONE",
    pattern: new RegExp(`${PHONE_INTL}|${PHONE_PAREN}|${PHONE_DASH}`, "g"),
    validate: (value) => {
      const digits = value.replace(/\D/g, "");
      return digits.length >= 7 && digits.length <= 15;
    },
  },
  { type: "IP", pattern: new RegExp(IPV6, "g") },
  { type: "IP", pattern: new RegExp(IPV4, "g") },
];
function collectStructuredMatches(text) {
  const raw = [];
  DETECTORS.forEach((d, priority) => {
    const re = new RegExp(d.pattern.source, d.pattern.flags);
    let m;
    while ((m = re.exec(text))) {
      const value = m[0];
      if (!d.validate || d.validate(value, m))
        raw.push({ start: m.index, end: m.index + value.length, type: d.type, value, priority });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
  });
  raw.sort(
    (a, b) =>
      a.start - b.start || a.priority - b.priority || b.end - b.start - (a.end - a.start),
  );
  const accepted = [];
  let lastEnd = -1;
  for (const m of raw) {
    if (m.start < lastEnd) continue;
    accepted.push(m);
    lastEnd = m.end;
  }
  return accepted;
}
// User-defined "always veil" words are matched only in the gaps left by the
// structured detectors above, so a name can't split an email or key apart.
function collectWordMatches(text, structured, words) {
  const clean = [...new Set((words || []).map((w) => String(w || "").trim()).filter(Boolean))];
  if (!clean.length) return [];
  const wordRe = new RegExp(
    "\\b(" + clean.sort((a, b) => b.length - a.length).map(escapeRegExp).join("|") + ")\\b",
    "gi",
  );
  const gaps = [];
  let cursor = 0;
  for (const m of structured) {
    if (m.start > cursor) gaps.push([cursor, m.start]);
    cursor = Math.max(cursor, m.end);
  }
  if (cursor < text.length) gaps.push([cursor, text.length]);
  const extra = [];
  for (const [gs, ge] of gaps) {
    const segment = text.slice(gs, ge);
    wordRe.lastIndex = 0;
    let m;
    while ((m = wordRe.exec(segment))) {
      extra.push({ start: gs + m.index, end: gs + m.index + m[0].length, type: "PRIVATE", value: m[0] });
      if (wordRe.lastIndex === m.index) wordRe.lastIndex++;
    }
  }
  return extra;
}
function collectMatches(text, words) {
  const structured = collectStructuredMatches(text);
  const withWords = [...structured, ...collectWordMatches(text, structured, words)];
  withWords.sort((a, b) => a.start - b.start);
  return withWords;
}
// A fresh, empty per-conversation veil state: same value -> same tag as long
// as this object (or its persisted form, see loadVeilState) is reused.
export function createVeilState() {
  return { map: {}, counters: {}, valueToTag: {} };
}
function tagFor(state, type, value) {
  state.map ||= {};
  state.counters ||= {};
  state.valueToTag ||= {};
  const key = type + "\u0000" + value;
  let tag = state.valueToTag[key];
  if (!tag) {
    state.counters[type] = (state.counters[type] || 0) + 1;
    tag = `${type}_${state.counters[type]}`;
    state.valueToTag[key] = tag;
    state.map[tag] = value;
  }
  return tag;
}
// Replaces detected sensitive spans in `text` with numbered tags, reusing
// `state` (created by createVeilState / loadVeilState) so the same value
// gets the same tag across calls in one conversation. `words` is the
// optional user-defined "always veil" list.
export function veil(text, state, words = []) {
  if (!text) return { text: text || "", count: 0, tags: [] };
  const s = state || createVeilState();
  const matches = collectMatches(text, words);
  if (!matches.length) return { text, count: 0, tags: [] };
  let result = "",
    cursor = 0;
  const tags = [];
  for (const m of matches) {
    result += text.slice(cursor, m.start);
    const tag = tagFor(s, m.type, m.value);
    result += `[${tag}]`;
    tags.push(tag);
    cursor = m.end;
  }
  result += text.slice(cursor);
  return { text: result, count: matches.length, tags };
}
// Restores original values from a tag -> value map (state.map). Tags with no
// entry in `map` are left as-is (e.g. history loaded in a browser that never
// had this conversation's map).
export function unveil(text, map) {
  if (!text || !map) return text || "";
  return text.replace(/\[([A-Z]+_\d+)\]/g, (full, tag) =>
    Object.prototype.hasOwnProperty.call(map, tag) ? map[tag] : full,
  );
}

// --- Local-only storage (never sent to the server) ---------------------
const KEY_PREFIX = "veil:state:";
export function loadVeilState(conversationKey) {
  const saved = readStore(KEY_PREFIX + conversationKey, null);
  if (!saved) return createVeilState();
  return {
    map: saved.map || {},
    counters: saved.counters || {},
    valueToTag: saved.valueToTag || {},
  };
}
export function saveVeilState(conversationKey, state) {
  return saveStore(KEY_PREFIX + conversationKey, state);
}
// Moves a temporary (pre-send) conversation's veil map to its real id once
// the server assigns one, so the map is never lost or orphaned.
export function moveVeilState(fromKey, toKey) {
  if (!fromKey || !toKey || fromKey === toKey) return;
  const saved = readStore(KEY_PREFIX + fromKey, null);
  if (!saved) return;
  saveStore(KEY_PREFIX + toKey, saved);
  try {
    localStorage.removeItem("anonyma:" + KEY_PREFIX + fromKey);
  } catch {}
}
// Drops a conversation's plain-text map from this browser's storage, for a
// Device Vault chat whose map is kept encrypted in the vault instead.
export function forgetVeilState(conversationKey) {
  try {
    localStorage.removeItem("anonyma:" + KEY_PREFIX + conversationKey);
  } catch {}
}
export function loadVeilWords() {
  return readStore("veil:words", []);
}
export function saveVeilWords(words) {
  return saveStore("veil:words", words);
}
export function loadVeilOn() {
  return readStore("veil:on", false);
}
export function saveVeilOn(on) {
  return saveStore("veil:on", !!on);
}
