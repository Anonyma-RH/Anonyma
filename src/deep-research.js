// Deep Research (update "deepresearch"): the pure parts shared by the server
// route (server/routes/research.js) and the workspace (src/DeepResearch.jsx).
// No DOM, no network, no storage: plan parsing, source numbering, report
// cleaning and the partial result a stopped run leaves behind.

// How many web searches each depth runs at most. The planner is asked for
// that many sub-questions; anything past the cap is dropped.
export const DEPTHS = { quick: 3, thorough: 6 };
export const DEPTH_IDS = Object.keys(DEPTHS);
export const MAX_QUESTION = 2000;
export const MAX_SUBQUESTION = 300;
// One search's findings as kept for the report (characters).
export const MAX_FINDINGS = 6000;
export const MAX_STEP_SOURCES = 5;
export const MAX_SOURCES = 20;
// Searches that run at the same time.
export const SEARCH_CONCURRENCY = 3;

const tidy = (s) => s.replace(/\s+/g, " ").trim();

// The planner's reply, which must be strict JSON: {"questions": [...]}. A
// ```json fence around it is tolerated; anything else that isn't that shape
// (prose, a bare list, a non-string entry) falls back to the question itself,
// as one search. Duplicates and empty or over-long entries are dropped, and
// the list is cut at the depth's cap.
export function parsePlan(text, question, cap) {
  const fallback = { questions: [tidy(String(question || ""))], fallback: true };
  if (typeof text !== "string") return fallback;
  let raw = text.trim();
  const fence = /^```(?:json)?[ \t]*\n([\s\S]*?)\n?```$/i.exec(raw);
  if (fence) raw = fence[1].trim();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return fallback;
  const list = data.questions;
  if (!Array.isArray(list) || !list.length) return fallback;
  if (list.some((q) => typeof q !== "string")) return fallback;
  const seen = new Set();
  const questions = [];
  for (const q of list) {
    const clean = tidy(q);
    if (clean.length < 3 || clean.length > MAX_SUBQUESTION) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    questions.push(clean);
    if (questions.length >= cap) break;
  }
  return questions.length ? { questions, fallback: false } : fallback;
}

// A source's identity for de-duplication: http(s) only, no fragment, no
// trailing slash, host in lower case. Null for anything else.
export function sourceKey(url) {
  if (typeof url !== "string" || url.length > 2000) return null;
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null;
  u.hash = "";
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : "";
  return (u.protocol + "//" + u.host.toLowerCase() + path + u.search).toLowerCase();
}
export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

// One step's sources as the provider cited them: valid http(s) URLs only,
// de-duplicated, capped.
export function stepSources(list) {
  const out = [];
  const seen = new Set();
  for (const s of Array.isArray(list) ? list : []) {
    const key = sourceKey(s?.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: s.url.slice(0, 2000),
      title: typeof s.title === "string" ? tidy(s.title).slice(0, 300) : "",
    });
    if (out.length >= MAX_STEP_SOURCES) break;
  }
  return out;
}

// Every search's sources, numbered once: `sources` is the report's numbered
// list (1-based in the text) and `numbers[i]` the numbers search i
// contributed. A page two searches both found keeps one number. Numbers are
// dealt round-robin (each search's first page, then each one's second…) so
// that when the list is full every search still has pages to cite. The cap
// matches what Share a Chat keeps, so a shared report's numbers all resolve.
export function collectSources(results) {
  const sources = [];
  const index = new Map();
  const lists = (results || []).map((r) => (r?.status === "done" ? r.sources || [] : []));
  const numbers = lists.map(() => []);
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let k = 0; k < longest; k++)
    lists.forEach((list, i) => {
      const s = list[k];
      const key = s && sourceKey(s.url);
      if (!key) return;
      if (!index.has(key)) {
        if (sources.length >= MAX_SOURCES) return;
        sources.push({ url: s.url, title: s.title || "" });
        index.set(key, sources.length);
      }
      const n = index.get(key);
      if (!numbers[i].includes(n)) numbers[i].push(n);
    });
  numbers.forEach((list) => list.sort((a, b) => a - b));
  return { sources, numbers };
}

const MD_LINK = /!?\[([^\]\n]*)\]\((<[^>\n]*>|[^()\s]*(?:\([^()\s]*\)[^()\s]*)*)(?:\s+"[^"\n]*")?\)/g;
const BARE_URL = /\bhttps?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"]/g;

// Findings text for the report prompt: links become their words and bare
// URLs go, so the writer has no addresses to copy, only numbered sources.
export function stripUrls(text) {
  return String(text || "")
    .replace(MD_LINK, (_, label) => label)
    .replace(BARE_URL, "")
    .replace(/[ \t]+\n/g, "\n");
}

// Citation numbers inside one bracket: "3", "1, 4", "2-5" (ranges expand, at
// most 10 numbers). Null when the bracket isn't a citation.
function citationNumbers(inner) {
  if (!/^\s*\d{1,3}(\s*[-–]\s*\d{1,3})?(\s*,\s*\d{1,3}(\s*[-–]\s*\d{1,3})?)*\s*$/.test(inner)) return null;
  const out = [];
  for (const part of inner.split(",")) {
    const [a, b] = part.split(/[-–]/).map((x) => Number(x.trim()));
    if (b === undefined) out.push(a);
    else for (let n = Math.min(a, b); n <= Math.max(a, b) && out.length < 10; n++) out.push(n);
  }
  return out;
}

// Removed pieces leave a marker, then go with the space before them, so
// "as reported [9]." reads "as reported." without touching indentation or
// line breaks anywhere else.
const GONE = "\u0000";
const closeGaps = (text) =>
  text
    .replace(new RegExp(` ${GONE}+ `, "g"), " ")
    .replace(new RegExp(`[ \\t]*${GONE}+(?=[.,;:!?)\\]]|\\n|$)`, "g"), "")
    .replace(new RegExp(`${GONE}+`, "g"), "")
    .replace(/ ?\(\s*\)/g, "")
    .replace(/<>/g, "");

// The written report, made safe to show against the sources the searches
// actually returned: a link keeps its URL only if it is one of them (else
// just its words), other bare URLs are removed, citation numbers outside
// 1..sources.length are dropped, footnote syntax becomes plain [n], and a
// trailing "Sources"/"References" section the model added anyway is cut
// (the app lists the real sources). Returns the text and the numbers cited.
export function cleanReport(text, sources = []) {
  const allowed = new Set(sources.map((s) => sourceKey(s.url)).filter(Boolean));
  const count = sources.length;
  const cited = new Set();
  let out = String(text || "").replace(/\r\n/g, "\n").replaceAll(GONE, "");
  // Reference-style definitions and footnote bodies: "[1]: https://…", "[^2]: …".
  out = out.replace(/^[ \t]*\[\^?[^\]\n]+\]:[^\n]*(\n|$)/gm, "");
  // A closing sources section, at any heading level or as a bold line.
  out = out.replace(
    /\n(?:#{1,6}[ \t]*|\*\*)[ \t]*(sources|references|citations|bibliography|works cited|来源|参考资料|参考文献|引用)[ \t]*:?(\*\*)?[ \t]*:?[ \t]*\n[\s\S]*$/i,
    "\n",
  );
  // Links: keep only the allowed ones.
  out = out.replace(MD_LINK, (whole, label, target) => {
    const url = target.replace(/^<|>$/g, "");
    if (whole.startsWith("!")) return label || GONE; // no remote images in a report
    if (allowed.has(sourceKey(url))) return `[${label}](${url})`;
    return label || GONE;
  });
  // Bare URLs outside links: keep only the allowed ones.
  out = out.replace(/(\]\()?(\bhttps?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"])/g, (whole, inLink, url) =>
    inLink ? whole : allowed.has(sourceKey(url)) ? url : GONE,
  );
  // Footnote markers: [^3] -> [3].
  out = out.replace(/\[\^(\d{1,3})\]/g, "[$1]");
  // Citation brackets not followed by "(" (so never a link's label).
  out = out.replace(/\[([^\]\n]{1,40})\](?!\()/g, (whole, inner) => {
    const nums = citationNumbers(inner);
    if (!nums) return whole;
    const valid = [...new Set(nums.filter((n) => Number.isInteger(n) && n >= 1 && n <= count))];
    valid.forEach((n) => cited.add(n));
    return valid.length ? valid.map((n) => `[${n}]`).join("") : GONE;
  });
  out = closeGaps(out).replace(/\n{3,}/g, "\n\n").trim();
  return { text: out, cited: [...cited].sort((a, b) => a - b) };
}

// What a run that ended before its report still gives back: each finished
// search's findings under its sub-question, with that search's source
// numbers. Built in code from what was paid for, never by a model. The
// reason is shown by the app, in the reader's language, not in this text.
// The findings' own citation numbers can't be trusted to match the list,
// so they go, and the search's numbers from the list follow instead.
export function partialReport({ questions = [], results = [], sources = [], numbers = [] }) {
  const parts = [];
  questions.forEach((q, i) => {
    const r = results[i];
    if (r?.status !== "done") return;
    const mine = numbers[i] || [];
    const own = mine.map((n) => sources[n - 1]).filter(Boolean);
    const linked = cleanReport(r.findings || "", own).text;
    const body = closeGaps(linked.replace(/\[\d{1,3}\](?!\()/g, GONE)).trim();
    const refs = mine.map((n) => `[${n}]`).join("");
    parts.push(`### ${i + 1}. ${q}\n\n${body}${refs ? "\n\n" + refs : ""}`);
  });
  return parts.join("\n\n");
}

// The step list a run records: the plan, one per search, and the report.
// `status` is "done", "failed", "stopped" or "skipped"; credits are what
// that step was charged (0 unless it finished).
export function researchSummary(steps = []) {
  const searches = steps.filter((s) => s.kind === "search");
  return {
    searched: searches.filter((s) => s.status === "done").length,
    planned: searches.length,
    sources: searches.reduce((n, s) => n + (s.status === "done" ? s.sources || 0 : 0), 0),
  };
}
