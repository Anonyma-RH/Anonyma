// Quote Cards (update "quotecards"): the pure parts of turning a reply, or
// part of one, into an image card. No DOM, no network, no storage: the text a
// card carries, how it is fitted and wrapped, where everything sits for each
// template and size, and what Veil placeholders do. The canvas drawing is
// src/quote-card-render.js and the dialog is src/QuoteCards.jsx. Nothing here
// (or there) sends anything anywhere: a card is made and kept on this device.
import { tidySelection } from "./highlight-ask.js";
import { unveil } from "./veil.js";

export const QUOTE_CARDS_UPDATE = "quotecards";

// The most text the editor holds. A card shows what fits and says so when
// the rest is left off.
export const MAX_CARD_TEXT = 4000;

// The site's own type: the same stacks as --serif and --font in styles.css.
export const SERIF =
  '"GFS Didot", Georgia, "Songti SC", "Noto Serif SC", "Source Han Serif SC", STSong, SimSun, serif';
export const SANS =
  '"GFS Neohellenic", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", sans-serif';
export const serifFont = (px) => `400 ${px}px ${SERIF}`;
export const sansFont = (px) => `700 ${px}px ${SANS}`;

// Pixel sizes of the exported PNG (1x: what social feeds take).
export const SIZES = [
  { id: "square", label: "1:1", detail: "1080 × 1080", width: 1080, height: 1080 },
  { id: "portrait", label: "4:5", detail: "1080 × 1350", width: 1080, height: 1350 },
  { id: "wide", label: "16:9", detail: "1920 × 1080", width: 1920, height: 1080 },
];
export const DEFAULT_SIZE = "square";
export const sizeById = (id) => SIZES.find((s) => s.id === id) || null;

// House colours only: cobalt, gold, ink and white. `edge` is a hairline for a
// card that would otherwise blend into a white feed; `column` draws the Ionic
// capital on a fluted shaft down the left; `band` is a flat bar across the top.
export const TEMPLATES = [
  {
    id: "cobalt",
    name: "Cobalt",
    bg: "#0135df",
    ink: "#ffffff",
    accent: "#ffb21c",
    quiet: "rgba(255,255,255,0.78)",
    edge: null,
    band: null,
    column: false,
  },
  {
    id: "white",
    name: "White",
    bg: "#ffffff",
    ink: "#0e1a3a",
    accent: "#0135df",
    quiet: "#4f5b73",
    edge: "#d5def0",
    band: "#0135df",
    column: false,
  },
  {
    id: "dark",
    name: "Dark",
    bg: "#0e1a3a",
    ink: "#ffffff",
    accent: "#ffb21c",
    quiet: "rgba(255,255,255,0.72)",
    edge: null,
    band: null,
    column: false,
  },
  {
    id: "column",
    name: "Column",
    bg: "#f5f8ff",
    ink: "#0e1a3a",
    accent: "#0135df",
    quiet: "#4f5b73",
    edge: "#d5def0",
    band: null,
    column: true,
  },
];
export const DEFAULT_TEMPLATE = "cobalt";
export const templateById = (id) => TEMPLATES.find((t) => t.id === id) || null;

// The Ionic mark (public/brand/official/ionic-transparent.png), 600 x 340.
export const MARK_URL = "/brand/official/ionic-transparent.png";
export const MARK_RATIO = 340 / 600;

// ---- The text a card carries ----

// Cleans text for a card: invisible characters out, lines tidied, and no
// more than MAX_CARD_TEXT characters.
export function cleanCardText(text, max = MAX_CARD_TEXT) {
  const clean = tidySelection(text);
  if (clean.length <= max) return clean;
  return clean.slice(0, max).trimEnd();
}

// A reply's Markdown as the plain words it reads as: no markers, no link
// targets, no images, no diagram source, bullets and numbers kept.
export function plainFromMarkdown(markdown) {
  let s = String(markdown ?? "").replace(/\r\n?/g, "\n");
  // A diagram's source is not a quote.
  s = s.replace(/^ {0,3}(```|~~~) *(?:mermaid|diagram)[^\n]*\n[\s\S]*?(?:\n {0,3}\1[^\n]*(?=\n|$)|(?![\s\S]))/gim, "");
  // Other code keeps its lines; only the fence lines go.
  s = s.replace(/^ {0,3}(```|~~~)[^\n]*\n?/gm, "");
  s = s.replace(/!\[([^\]\n]*)\]\([^)\n]*\)/g, "$1");
  s = s.replace(/\[([^\]\n]+)\]\([^)\n]*\)/g, "$1");
  s = s.replace(/<\/?[a-z][^>\n]*>/gi, "");
  s = s.replace(/^ {0,3}#{1,6}[ \t]+/gm, "");
  s = s.replace(/^ {0,3}>[ \t]?/gm, "");
  s = s.replace(/^ {0,3}(?:[-*_][ \t]*){3,}$/gm, "");
  // A table: its rules go, its rows read as cells joined by a dot.
  s = s
    .split("\n")
    .flatMap((line) => {
      if (!/^\s*\|.*\|\s*$/.test(line)) return [line];
      if (/^\s*\|?[\s:|-]+\|?\s*$/.test(line) && /-/.test(line)) return [];
      return [
        line
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim())
          .filter(Boolean)
          .join(" · "),
      ];
    })
    .join("\n");
  s = s.replace(/^[ \t]*[-*+][ \t]+/gm, "• ");
  s = s.replace(/^[ \t]*(\d{1,3})[.)][ \t]+/gm, "$1. ");
  s = s.replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2");
  s = s.replace(/~~(?=\S)([^\n]*?\S)~~/g, "$1");
  s = s.replace(/(^|[^\w*\\])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?![\w*])/g, "$1$2");
  s = s.replace(/(^|[^\w\\])_(?=[^\s_])([^_\n]*?[^\s_])_(?![\w])/g, "$1$2");
  s = s.replace(/`([^`\n]+)`/g, "$1");
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!>|~])/g, "$1");
  return tidySelection(s);
}

// ---- Veil ----

const TAG_G = /\[([A-Z]+_\d+)\]/g;
// The Veil placeholders in `text` that this browser's map can restore.
export function veiledTags(text, map) {
  if (!map || typeof map !== "object") return [];
  const found = new Set();
  for (const m of String(text ?? "").matchAll(TAG_G))
    if (Object.prototype.hasOwnProperty.call(map, m[1])) found.add(m[1]);
  return [...found];
}
// What the card shows: placeholders as they are, unless the person chose to
// put the real values on the card.
export function shownCardText(text, { reveal = false, map = null } = {}) {
  return reveal && map ? unveil(String(text ?? ""), map) : String(text ?? "");
}

// ---- The credit line ----

// "Asked on ANONYMA · Claude Sonnet", either part optional. `brand` is the
// words for the first part in the app's language.
export function creditLine({ asked = true, model = true, brand = "Asked on ANONYMA", modelName = "" } = {}) {
  const parts = [];
  if (asked) parts.push(brand);
  const name = String(modelName || "").replace(/\s+/g, " ").trim();
  if (model && name) parts.push(name);
  return parts.join(" · ");
}
export const cardFileName = (sizeId) => `anonyma-quote-card-${(sizeById(sizeId) || SIZES[0]).label.replace(":", "x")}.png`;

// ---- Wrapping ----

const CJK = /[⺀-〿぀-ヿ㐀-鿿가-힯豈-﫿＀-￯]/;
// Never start a line with these, and never end one with the openers.
const NO_START = new Set([..."，。、！？；：）」』》】〕〉”’…—．，％"]);
const NO_END = new Set([..."（「『《【〔〈“‘"]);
const LATIN_CLOSER = /^[.,;:!?)\]%]$/;
const MARKER = /^(?:•|\d{1,3}\.)(?=\s)/;

// Splits a line into breakable pieces: Latin words (with trailing marks),
// and single CJK characters with their closing marks. `sp` says whether a
// space came before the piece.
export function tokenize(line) {
  const out = [];
  let word = null;
  let space = false;
  let opener = "";
  const flush = () => {
    if (word) out.push(word);
    word = null;
  };
  for (const ch of Array.from(String(line ?? ""))) {
    if (/\s/.test(ch)) {
      flush();
      space = true;
      continue;
    }
    if (CJK.test(ch)) {
      flush();
      if (NO_END.has(ch)) {
        opener += ch;
        continue;
      }
      const prev = out[out.length - 1];
      if (NO_START.has(ch) && prev && !space) {
        prev.t += ch;
        continue;
      }
      out.push({ t: opener + ch, sp: space });
      opener = "";
      space = false;
      continue;
    }
    if (!word) {
      // A mark right after a Chinese character belongs to it, not to a new line.
      const prev = out[out.length - 1];
      if (LATIN_CLOSER.test(ch) && prev && !space && !opener && CJK.test(Array.from(prev.t).pop())) {
        prev.t += ch;
        continue;
      }
      word = { t: opener + ch, sp: space };
      opener = "";
      space = false;
    } else word.t += ch;
  }
  flush();
  if (opener) out.push({ t: opener, sp: space });
  return out;
}

// Greedy wrapping of one paragraph to `width`, using measure(string) in px.
// A bullet or number keeps its hanging indent. Returns [{ text, indent }];
// `stats.split` is set when a word had to be broken by letter.
export function wrapParagraph(text, width, measure, stats = null) {
  const tokens = tokenize(text);
  if (!tokens.length) return [];
  const lead = MARKER.exec(String(text).trim());
  const hang = lead && tokens.length > 1 ? measure(lead[0] + " ") : 0;
  const lines = [];
  let cur = "";
  const room = () => Math.max(1, width - (lines.length ? hang : 0));
  const commit = () => {
    if (cur) lines.push({ text: cur, indent: lines.length ? hang : 0 });
    cur = "";
  };
  for (const tok of tokens) {
    const joined = cur ? cur + (tok.sp ? " " : "") + tok.t : tok.t;
    if (measure(joined) <= room()) {
      cur = joined;
      continue;
    }
    if (cur) commit();
    if (measure(tok.t) <= room()) {
      cur = tok.t;
      continue;
    }
    // One word wider than the line (a long address, say): broken by letter.
    if (stats) stats.split = true;
    let piece = "";
    for (const ch of Array.from(tok.t)) {
      if (piece && measure(piece + ch) > room()) {
        cur = piece;
        commit();
        piece = "";
      }
      piece += ch;
    }
    cur = piece;
  }
  commit();
  return lines;
}

// The card's text as paragraphs: lines of a paragraph, and a gap where the
// text has a blank line.
function paragraphs(text) {
  const out = [];
  let gap = false;
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/[ \t]+/g, " ").trim();
    if (!line) {
      gap = out.length > 0;
      continue;
    }
    out.push({ text: line, gap });
    gap = false;
  }
  return out;
}

// Lays `text` out at one size: the lines with their offsets and the height.
export function flow(text, width, size, measure, { lineHeight = 1.28, gap = 0.55 } = {}) {
  const at = (s) => measure(s, size);
  const lh = size * lineHeight;
  const lines = [];
  const stats = { split: false };
  let y = 0;
  for (const p of paragraphs(text)) {
    if (p.gap && lines.length) y += size * gap;
    for (const l of wrapParagraph(p.text, width, at, stats)) {
      lines.push({ text: l.text, indent: l.indent, y });
      y += lh;
    }
  }
  return { lines, height: y, lh, split: stats.split };
}

// The largest size (from max down to min, in steps) at which `text` fits the
// box, with no word broken in two (a long address is set smaller instead);
// at the smallest size that still doesn't fit, the text is cut at a word and
// ends in an ellipsis. `truncated` and `shown` (characters kept) say so.
export function fitText(text, box, { measure, minSize, maxSize, step = 2, lineHeight = 1.28, gap = 0.55 }) {
  const opts = { lineHeight, gap };
  const fits = (t, size) => {
    const f = flow(t, box.width, size, measure, opts);
    return f.height <= box.height && (!f.split || size <= minSize);
  };
  const source = String(text ?? "");
  if (!source.trim()) return { size: maxSize, ...flow("", box.width, maxSize, measure, opts), truncated: false, shown: 0, total: 0, text: "" };
  const sizes = [];
  for (let s = minSize; s <= maxSize; s += step) sizes.push(s);
  if (sizes[sizes.length - 1] !== maxSize) sizes.push(maxSize);
  if (fits(source, minSize)) {
    let lo = 0;
    let hi = sizes.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(source, sizes[mid])) lo = mid;
      else hi = mid - 1;
    }
    const size = sizes[lo];
    return { size, ...flow(source, box.width, size, measure, opts), truncated: false, shown: Array.from(source).length, total: Array.from(source).length, text: source };
  }
  // Too much text even at the smallest size: keep the most that fits.
  const chars = Array.from(source);
  let lo = 0;
  let hi = chars.length;
  const cut = (n) => chars.slice(0, n).join("").trimEnd() + "…";
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(cut(mid), minSize)) lo = mid;
    else hi = mid - 1;
  }
  let head = chars.slice(0, lo).join("");
  // Back to the last space, when that costs only a few letters.
  const space = head.search(/\s\S*$/);
  if (space > head.length * 0.8 && !CJK.test(head.slice(-1))) head = head.slice(0, space);
  // No dangling comma or colon before the ellipsis.
  head = head.replace(/[\s,;:、，；：\-–—]+$/u, "");
  const shownText = head + "…";
  return {
    size: minSize,
    ...flow(shownText, box.width, minSize, measure, opts),
    truncated: true,
    shown: Array.from(head).length,
    total: chars.length,
    text: shownText,
  };
}

// Shortens one line to `width` with an ellipsis (the credit line, when a
// model's name is long).
export function clampLine(text, width, measure) {
  const chars = Array.from(String(text ?? ""));
  if (measure(chars.join("")) <= width) return chars.join("");
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(chars.slice(0, mid).join("").trimEnd() + "…") <= width) lo = mid;
    else hi = mid - 1;
  }
  return lo ? chars.slice(0, lo).join("").trimEnd() + "…" : "";
}

// ---- The layout ----

// Where everything sits for a template and a size, and the text fitted to
// what's left. `measure(string, px)` measures the quote's serif type;
// `measureCredit(string, px)` the credit line's sans (default: the same).
// Everything is in pixels of the exported image.
export function layoutCard({ template, size, text, credit = "", measure, measureCredit = measure }) {
  const tpl = typeof template === "string" ? templateById(template) : template;
  const dim = typeof size === "string" ? sizeById(size) : size;
  if (!tpl || !dim) throw Error("Unknown card template or size.");
  const { width: w, height: h } = dim;
  const unit = Math.min(w, h);
  const pad = Math.round(unit * 0.095);
  const band = tpl.band ? { x: 0, y: 0, w, h: Math.round(unit * 0.014) } : null;
  // The fluted column with the Ionic capital, down the left edge.
  let column = null;
  let left = pad;
  if (tpl.column) {
    const cw = Math.round(unit * 0.12);
    const cx = Math.round(pad * 0.8);
    const top = Math.round(pad * 0.55);
    column = { x: cx, y: top, w: cw, h: h - top * 2, capital: { w: Math.round(cw * 1.5), h: Math.round(cw * 1.5 * MARK_RATIO) } };
    left = cx + cw + Math.round(unit * 0.075);
  }
  const right = w - pad;
  const footerH = Math.round(unit * 0.07);
  const glyphSize = Math.round(unit * 0.19);
  const glyphH = Math.round(unit * 0.09);
  const glyph = { x: left, y: pad + (band ? Math.round(band.h * 0.5) : 0), size: glyphSize, h: glyphH };
  const boxTop = glyph.y + glyphH + Math.round(unit * 0.03);
  const boxBottom = h - pad - footerH - Math.round(unit * 0.045);
  const box = { x: left, y: boxTop, width: right - left, height: boxBottom - boxTop };
  const maxSize = Math.round(unit * 0.085);
  const minSize = Math.round(unit * 0.034);
  const fit = fitText(text, box, { measure, minSize, maxSize });
  const block = fit.height;
  const top = box.y + Math.max(0, Math.round((box.height - block) / 2));
  const lines = fit.lines.map((l) => ({ text: l.text, x: box.x + l.indent, y: top + l.y, h: fit.lh }));

  // Footer: the credit on the left, the mark on the right (the column card
  // already carries the mark as its capital).
  const markH = footerH;
  const mark = tpl.column ? null : { w: Math.round(markH / MARK_RATIO), h: markH, x: 0, y: h - pad - markH };
  if (mark) mark.x = right - mark.w;
  const creditSize = Math.round(unit * 0.027);
  const creditRoom = right - left - (mark ? mark.w + Math.round(unit * 0.04) : 0);
  const creditText = credit ? clampLine(credit, creditRoom, (s) => measureCredit(s, creditSize)) : "";
  const creditPlace = creditText
    ? { text: creditText, x: left, y: h - pad - Math.round(footerH / 2), size: creditSize }
    : null;
  return {
    width: w,
    height: h,
    template: tpl,
    pad,
    band,
    column,
    glyph,
    box,
    text: {
      size: fit.size,
      lineHeight: fit.lh,
      lines,
      truncated: fit.truncated,
      shown: fit.shown,
      total: fit.total,
      text: fit.text,
    },
    footer: { credit: creditPlace, mark, ruleY: h - pad - footerH - Math.round(unit * 0.02) },
  };
}

// ---- What the dialog remembers in this browser: choices, never text ----

export const PREFS_KEY = "quotecards:prefs";
export function cleanPrefs(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  return {
    template: templateById(p.template) ? p.template : DEFAULT_TEMPLATE,
    size: sizeById(p.size) ? p.size : DEFAULT_SIZE,
    asked: p.asked !== false,
    model: p.model !== false,
  };
}
