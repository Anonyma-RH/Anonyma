// Link Reader: pure helpers shared by the browser (src/LinkReader.jsx) and
// the server (server/link-reader.js, server/link-extract.js). No DOM and no
// network here.
//
// A page that was read rides with the message as a Documents block
// (src/documents.js) marked source="link", with its URL, host and word
// count as attributes. Its text is public page text fetched by the server,
// not something the user typed, so Veil leaves it as it is (only the typed
// question is masked, maskOutsideLinks) and Seed Guard doesn't scan it
// (stripLinkBlocks).

export const LINK_READER = Object.freeze({
  maxWords: 30000,
  maxBytes: 5 * 1024 * 1024,
  timeoutSeconds: 10,
  maxRedirects: 3,
  perHour: 60,
  // "Read this page" chips offered at once for the links in the composer.
  maxChips: 3,
});

// Query parameters that only track who clicked or where from. They're
// removed before a page is fetched (a click id like fbclid can tie the
// fetch back to a person) and from the link shown on the card.
const TRACKING = new Set([
  "fbclid",
  "gclid",
  "gclsrc",
  "dclid",
  "gbraid",
  "wbraid",
  "msclkid",
  "yclid",
  "twclid",
  "ttclid",
  "li_fat_id",
  "igshid",
  "igsh",
  "mc_cid",
  "mc_eid",
  "_hsenc",
  "_hsmi",
  "__hssc",
  "__hstc",
  "__hsfp",
  "hsctatracking",
  "mkt_tok",
  "oly_anon_id",
  "oly_enc_id",
  "vero_id",
  "vero_conv",
  "rb_clickid",
  "s_cid",
  "_openstat",
  "epik",
  "wickedid",
  "ref_src",
  "ref_url",
  "spm",
  "scm",
]);
export const isTrackingParam = (name) => {
  const n = String(name).toLowerCase();
  return n.startsWith("utm_") || n.startsWith("pk_") || n.startsWith("mtm_") || TRACKING.has(n);
};
// The same URL without tracking parameters (a new URL object).
export function stripTracking(input) {
  const url = new URL(String(input));
  const keep = [...url.searchParams].filter(([name]) => !isTrackingParam(name));
  if (keep.length !== [...url.searchParams].length) {
    url.search = "";
    for (const [name, value] of keep) url.searchParams.append(name, value);
  }
  return url;
}

// http(s) links typed or pasted in the composer, in order, without
// duplicates or trailing punctuation.
const LINK = /\bhttps?:\/\/[^\s<>"'`{}|\\^]+/gi;
export function findLinks(text, max = LINK_READER.maxChips) {
  const out = [];
  for (const match of String(text || "").matchAll(LINK)) {
    let link = match[0];
    // Sentence punctuation, and a closing bracket that isn't part of the link.
    for (;;) {
      const trimmed = link.replace(/[.,;:!?'"»”’]+$/u, "");
      const last = trimmed.at(-1);
      const unbalanced =
        (last === ")" && count(trimmed, "(") < count(trimmed, ")")) ||
        (last === "]" && count(trimmed, "[") < count(trimmed, "]"));
      const next = unbalanced ? trimmed.slice(0, -1) : trimmed;
      if (next === link) break;
      link = next;
    }
    let url;
    try {
      url = new URL(link);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || !url.hostname) continue;
    if (!out.includes(link)) out.push(link);
    if (out.length >= max) break;
  }
  return out;
}
const count = (s, ch) => s.split(ch).length - 1;

export function linkHost(link) {
  try {
    return new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// Words in a page: a run of letters or digits, and each Chinese or Japanese
// character on its own (they aren't separated by spaces).
const CJK = "\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}";
const WORD = new RegExp(`[${CJK}]|[^\\s${CJK}]*[\\p{L}\\p{N}][^\\s${CJK}]*`, "gu");
export function countWords(text) {
  let n = 0;
  for (const _ of String(text || "").matchAll(WORD)) n++;
  return n;
}
// The text cut after its `max`th word, and whether anything was cut.
export function capWords(text, max = LINK_READER.maxWords) {
  const s = String(text || "");
  let n = 0,
    end = s.length;
  for (const m of s.matchAll(WORD)) {
    n++;
    if (n === max) end = m.index + m[0].length;
    if (n > max) return { text: s.slice(0, end).trimEnd(), words: max, truncated: true };
  }
  return { text: s, words: n, truncated: false };
}

// A read page's <document> block, as buildDocumentBlock writes it for a
// document with source "link". Matches blocks written by that function only.
const LINK_BLOCK = /<document\s[^>]*\bsource="link"[^>]*>[\s\S]*?<\/document>/g;

// Veil masks what the user typed, never a page's text: `mask` runs on
// everything outside read-page blocks.
export function maskOutsideLinks(content, mask) {
  const s = String(content ?? "");
  if (!s.includes('source="link"')) return mask(s);
  let out = "",
    last = 0;
  for (const m of s.matchAll(LINK_BLOCK)) {
    if (m.index > last) out += mask(s.slice(last, m.index));
    out += m[0];
    last = m.index + m[0].length;
  }
  if (last < s.length) out += mask(s.slice(last));
  return out;
}
// The text without read-page blocks (for Seed Guard, which scans only what
// the user wrote or attached from their own device).
export function stripLinkBlocks(text) {
  const s = String(text ?? "");
  return s.includes('source="link"') ? s.replace(LINK_BLOCK, "") : s;
}

export const formatWords = (n) => {
  const v = Number(n) || 0;
  return `${v.toLocaleString("en-US")} ${v === 1 ? "word" : "words"}`;
};
