// Highlight & Ask (update "highlight"): the pure parts shared by the
// workspace (src/HighlightAsk.jsx) and the fact-check route
// (server/routes/factcheck.js). No DOM, no network, no storage: the quote a
// selection becomes, the Translate languages, Veil's placeholders, and the
// fact-check verdict's parsing, sources and saved text.
import { decodeEntities, sourceKey, stripUrls } from "./deep-research.js";

export const HIGHLIGHT_UPDATE = "highlight";
// The most of a selection a quote carries into the composer, and the most
// one fact-check checks (characters).
export const MAX_QUOTE = 6000;
export const MAX_CLAIM = 1000;
// A fact-check shows 1 to 3 sources, and a reason of one short paragraph.
export const MAX_FACT_SOURCES = 3;
export const MAX_REASON = 900;
export const VERDICTS = ["supported", "disputed", "mixed", "unverified"];
export const QUOTE_ACTIONS = ["ask", "explain", "simplify", "translate"];

// Translate's languages, shown by their own names. `name` and `zh` are what
// the instruction put in the composer calls them, in the app's language.
export const LANGUAGES = [
  { id: "en", native: "English", name: "English", zh: "英语" },
  { id: "zh", native: "简体中文", name: "Simplified Chinese", zh: "简体中文" },
  { id: "es", native: "Español", name: "Spanish", zh: "西班牙语" },
  { id: "fr", native: "Français", name: "French", zh: "法语" },
  { id: "de", native: "Deutsch", name: "German", zh: "德语" },
  { id: "pt", native: "Português", name: "Portuguese", zh: "葡萄牙语" },
  { id: "it", native: "Italiano", name: "Italian", zh: "意大利语" },
  { id: "ja", native: "日本語", name: "Japanese", zh: "日语" },
  { id: "ko", native: "한국어", name: "Korean", zh: "韩语" },
  { id: "ru", native: "Русский", name: "Russian", zh: "俄语" },
  { id: "ar", native: "العربية", name: "Arabic", zh: "阿拉伯语" },
  { id: "hi", native: "हिन्दी", name: "Hindi", zh: "印地语" },
];
export const languageById = (id) => LANGUAGES.find((l) => l.id === id) || null;

// Translate's first target in a browser that hasn't picked one: English for
// the Chinese app; otherwise the browser's own language if it's on the list
// and isn't English, else Simplified Chinese.
export function defaultLanguage(uiLang, browserLangs = []) {
  if (uiLang === "zh") return "en";
  for (const tag of browserLangs || []) {
    const id = String(tag || "").toLowerCase().split("-")[0];
    if (id && id !== "en" && languageById(id)) return id;
  }
  return "zh";
}

// ---- A selection, as text ----

// Invisible characters that can hide instructions or flip text direction
// (zero-width, bidi controls, Unicode tags). Emoji joiners stay.
const INVISIBLE = /[\u200B\u200C\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|[\u{E0000}-\u{E007F}]/gu;
export function tidySelection(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(INVISIBLE, "")
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
// A quote block of the selection. A literal image in it (from a code span,
// say) becomes a link, so quoting can never load a remote image.
export function quoteBlock(text) {
  const clean = tidySelection(text);
  if (!clean) return "";
  return clean
    .replace(/!\[([^\]\n]*)\]\(/g, "[$1](")
    .split("\n")
    .map((line) => (line.trim() ? "> " + line : ">"))
    .join("\n");
}
// Long selections are cut to MAX_QUOTE characters, and say so.
export function clipQuote(text, max = MAX_QUOTE) {
  const clean = tidySelection(text);
  if (clean.length <= max) return { text: clean, clipped: false };
  return { text: clean.slice(0, max).trimEnd() + "…", clipped: true };
}

// The short instruction under the quote, in the app's language. Ask about
// this leaves the line empty for the person's own question.
const INSTRUCTIONS = {
  explain: { en: "Explain this part in more detail.", zh: "请更详细地解释这一部分。" },
  simplify: { en: "Rewrite this part in simpler words.", zh: "请用更简单的话改写这一部分。" },
  translate: { en: "Translate this part into {lang}.", zh: "请把这一部分翻译成{lang}。" },
};
export function quoteInstruction(action, { uiLang = "en", lang = "zh" } = {}) {
  const L = uiLang === "zh" ? "zh" : "en";
  const line = INSTRUCTIONS[action]?.[L];
  if (!line) return "";
  const target = languageById(lang) || LANGUAGES[0];
  return line.replace("{lang}", L === "zh" ? target.zh : target.name);
}
// What an action puts in the composer: the quote, a blank line and the
// instruction (or an empty line to type a question on).
export function quotePrompt(action, text, options = {}) {
  const quote = quoteBlock(clipQuote(text).text);
  if (!quote) return "";
  const line = quoteInstruction(action, options);
  return line ? `${quote}\n\n${line}` : `${quote}\n\n`;
}

// ---- Veil ----

// A Veil placeholder such as [EMAIL_1] (src/veil.js's tag types). Quoting
// keeps a veiled value as its placeholder, so it stays masked whatever the
// Veil switch says; a fact-check with one in it is refused.
const VEIL_TAG = /\[(?:EMAIL|KEY|WALLET|IBAN|CARD|PHONE|IP|PRIVATE)_\d{1,6}\]/;
export const hasVeilPlaceholder = (text) => VEIL_TAG.test(String(text || ""));
export const FACTCHECK_VEILED =
  "Veil masked details in this text, so it can't be fact-checked: a web search with placeholders would find nothing, and the real details never leave this browser. Select text without them.";

// ---- Fact-check ----

// The language a fact-check's saved text is written in: Chinese for a claim
// in Chinese (the model's reason follows the claim), English otherwise.
export const claimLanguage = (claim) => (/[\u3400-\u9FFF]/.test(String(claim)) ? "zh" : "en");

export const VERDICT_LABELS = {
  en: { supported: "Supported", disputed: "Disputed", mixed: "Mixed", unverified: "Couldn't verify" },
  zh: { supported: "有依据", disputed: "遭反驳", mixed: "部分属实", unverified: "无法核实" },
};
const VERDICT_ALIASES = {
  supported: "supported",
  disputed: "disputed",
  mixed: "mixed",
  unverified: "unverified",
  unverifiable: "unverified",
  "couldn't verify": "unverified",
  "could not verify": "unverified",
  "cannot verify": "unverified",
};
const verdictId = (v) =>
  typeof v === "string" ? VERDICT_ALIASES[v.trim().toLowerCase().replace(/[’]/g, "'")] || null : null;

// The first complete JSON object in a reply: the whole reply, a ```json
// fence, or, when a provider's search adds prose around it, the first
// balanced {...}. Anything else is null.
export function firstJsonObject(text) {
  if (typeof text !== "string") return null;
  let raw = text.trim();
  const fence = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(raw);
  if (fence) raw = fence[1].trim();
  const asObject = (s) => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === "object" && !Array.isArray(v) ? v : null;
    } catch {
      return null;
    }
  };
  const whole = asObject(raw);
  if (whole) return whole;
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0,
    inString = false,
    escaped = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return asObject(raw.slice(start, i + 1));
  }
  return null;
}

// The reason, as plain text: links become their words, addresses and
// citation markers go, emphasis marks go, and it's one paragraph.
export function cleanReason(value) {
  if (typeof value !== "string") return "";
  let s = stripUrls(value)
    .replace(/\[\^?\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]|【[^】]{0,40}】/g, "")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,;:!?。，；：！？])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .trim();
  if (s.length > MAX_REASON) s = s.slice(0, MAX_REASON).replace(/\s+\S*$/, "") + "…";
  return s;
}

// The verdict reply, which must be JSON of exactly this shape:
// {"verdict": "supported|disputed|mixed|unverified", "reason": "...",
//  "sources": ["https://..."]}. Null when it isn't (no object, an unknown
// verdict or an empty reason).
export function parseVerdict(text) {
  const data = firstJsonObject(text);
  if (!data) return null;
  const verdict = verdictId(data.verdict);
  if (!verdict) return null;
  const reason = cleanReason(data.reason);
  if (!reason) return null;
  const sources = (Array.isArray(data.sources) ? data.sources : [])
    .map((s) => (typeof s === "string" ? s : typeof s?.url === "string" ? s.url : null))
    .filter(Boolean)
    .slice(0, 10);
  return { verdict, reason, sources };
}

// The pages the web search returned, as the provider reported them: http(s)
// only, de-duplicated, titles decoded to plain text.
export function returnedPages(list, max = 50) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    const key = sourceKey(s?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: s.url.slice(0, 2000),
      title: typeof s.title === "string" ? decodeEntities(s.title).replace(/\s+/g, " ").trim().slice(0, 300) : "",
    });
    if (out.length >= max) break;
  }
  return out;
}

// The card's sources: the pages the model named, but only those the search
// returned, up to three. If it named none of them, the search's first pages
// instead (`named` false says so). Never an address the search didn't return.
export function pickSources(named, returned, max = MAX_FACT_SOURCES) {
  const pages = returnedPages(returned);
  const byKey = new Map(pages.map((p) => [sourceKey(p.url), p]));
  const picked = [];
  const seen = new Set();
  for (const url of Array.isArray(named) ? named : []) {
    const key = sourceKey(url);
    if (!key || seen.has(key) || !byKey.has(key)) continue;
    seen.add(key);
    picked.push(byKey.get(key));
    if (picked.length >= max) break;
  }
  if (picked.length) return { sources: picked, named: true };
  return { sources: pages.slice(0, max), named: false };
}

export const NO_SOURCES_REASON = {
  en: "The web search returned no pages, so this couldn't be checked.",
  zh: "网络搜索没有返回任何网页，因此无法核查。",
};
// The verdict the card shows. A check whose search returned no pages can't
// be supported or disputed by the web, so it's "Couldn't verify".
export function finishVerdict(parsed, returned, lang = "en") {
  const { sources, named } = pickSources(parsed.sources, returned);
  if (!sources.length)
    return { verdict: "unverified", reason: NO_SOURCES_REASON[lang] || NO_SOURCES_REASON.en, sources: [], named: false };
  return { verdict: parsed.verdict, reason: parsed.reason, sources, named };
}

// The saved turns: the person's (the quote and what was asked) and the
// card's plain Markdown, which is what History, Export and Share show.
export function factCheckUserText(claim) {
  const lang = claimLanguage(claim);
  return `${quoteBlock(claim)}\n\n${lang === "zh" ? "用网络核查这段内容。" : "Fact-check this against the web."}`;
}
export function factCheckText({ verdict, reason }, lang = "en") {
  const L = VERDICT_LABELS[lang] || VERDICT_LABELS.en;
  const head = lang === "zh" ? `**事实核查：${L[verdict]}**` : `**Fact-check: ${L[verdict]}**`;
  return `${head}\n\n${reason}`;
}
