import { useSyncExternalStore } from "react";

// English / 中文. The English source stays the only source: when Chinese is
// on, the live DOM's rendered text is swapped for dictionary translations and
// every original is kept so switching back restores it exactly. Only text
// nodes' values and a few attributes ever change (never nodes themselves),
// so React keeps working, and values the code reads back stay English.

// ---- Pure translation logic (no DOM) ----

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/;
export const isCJK = (ch) => !!ch && CJK.test(ch);
export const hasLetters = (s) => /[A-Za-z]/.test(s);
export const normalize = (s) => String(s).replace(/\s+/g, " ").trim();
export function splitSpace(s) {
  const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(s);
  return [lead, core, trail];
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SLOT = /\{(\d+)\}/;
// A whole number ("1,234.5") first, so "{0}." doesn't stop at its decimal
// point; otherwise the shortest text that lets the pattern match.
const CAPTURE = "(\\d[\\d,]*(?:\\.\\d+)?|[\\s\\S]+?)";

// A heading the dictionary can't carry: in Chinese, "The ANONYMA" (over
// "Platform") drops its article. The dictionary may override it.
const BUILT_IN = { "The ANONYMA": "ANONYMA" };

// zh.json: { strings: { English: 中文 }, patterns: [{ en: "{0} x", zh: "{0}…" }] }.
// Patterns are tried most-literal first, so "{0} credits available" wins
// over "{0} credits".
export function compileDictionary(raw) {
  const strings = new Map();
  for (const [en, zh] of Object.entries(raw?.strings || {}))
    if (typeof zh === "string") strings.set(normalize(en), zh);
  for (const [en, zh] of Object.entries(BUILT_IN))
    if (!strings.has(en)) strings.set(en, zh);
  const patterns = [];
  for (const p of raw?.patterns || []) {
    if (typeof p?.en !== "string" || typeof p?.zh !== "string") continue;
    const parts = normalize(p.en).split(SLOT);
    const literals = parts.filter((_, i) => i % 2 === 0);
    const weight = literals.join("").trim().length;
    if (!weight || parts.length < 3) continue;
    patterns.push({
      re: new RegExp(
        "^" +
          parts.map((x, i) => (i % 2 ? CAPTURE : escape(x))).join("") +
          "$",
      ),
      slots: parts.filter((_, i) => i % 2 === 1),
      // "@{0}" is a username: never translated.
      raw: new Set(
        parts.filter((x, i) => i % 2 === 1 && parts[i - 1].endsWith("@")),
      ),
      // A cheap substring check before running the regex.
      hint: literals.reduce((a, b) => (b.length > a.length ? b : a), ""),
      zh: p.zh,
      weight,
    });
  }
  patterns.sort((a, b) => b.weight - a.weight);
  return { strings, patterns, cache: new Map() };
}

// Fills a pattern's zh template. A capture that is itself Chinese drops the
// space the template put next to it ("{0} 即将推出" → "图像工作室即将推出").
function fill(template, values) {
  const parts = template.split(SLOT);
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      let text = parts[i];
      if (i > 0 && isCJK(out.at(-1)) && text[0] === " " && isCJK(text[1]))
        text = text.slice(1);
      out += text;
    } else {
      const v = values[parts[i]] ?? "";
      if (out.endsWith(" ") && isCJK(out.at(-2)) && isCJK(v[0]))
        out = out.slice(0, -1);
      out += v;
    }
  }
  return out;
}

// Parts translated one by one; those without a translation (a name like
// Veil) stay as they are. Undefined when none translate.
function parts(list, dict, depth) {
  let any = false;
  const out = list.map((s) => {
    const t = hasLetters(s) ? translateString(s, dict, depth) : undefined;
    if (t !== undefined) any = true;
    return t ?? s;
  });
  return any ? out : undefined;
}
const TRAILING_FULL = { ",": "，", ":": "：", ";": "；" };
// A single token with an underscore, digit or @ (anonyma_demo, user42) is a
// name or handle, not a phrase: it stays as written inside a pattern.
export const looksLikeHandle = (s) => /^[\w.@-]+$/.test(s) && /[_@\d]/.test(s);
// Dates and times the browser rendered in en-US ("9/25/2026, 1:22:31 AM")
// in the form zh-CN uses ("2026/9/25 01:22:31"); anything else is undefined.
export function translateDate(s) {
  const m =
    /^(?:(\d{1,2})\/(\d{1,2})\/(\d{4}))?(?:,? ?(\d{1,2}):(\d{2})(?::(\d{2}))? ?(AM|PM))?$/.exec(
      s,
    );
  if (!m || (!m[3] && !m[7])) return undefined;
  const date = m[3] ? `${m[3]}/${Number(m[1])}/${Number(m[2])}` : "";
  if (!m[7]) return date;
  let h = Number(m[4]) % 12;
  if (m[7] === "PM") h += 12;
  const time =
    String(h).padStart(2, "0") + ":" + m[5] + (m[6] ? ":" + m[6] : "");
  return date ? date + " " + time : time;
}
// A normalized string's translation, or undefined: an exact string, then a
// pattern (captures translated the same way when they can be), then known
// strings inside separators, " · " status lines and ", " lists.
export function translateString(core, dict, depth = 0) {
  const date = translateDate(core);
  if (date !== undefined) return date;
  const hit = dict.strings.get(core);
  if (hit !== undefined) return hit;
  if (depth > 3) return undefined;
  // Several patterns can match ("credits, worth ${0}." and "…${0}.{1}");
  // the first whose captures all translate wins, else the first match.
  let fallback;
  for (const p of dict.patterns) {
    if (!core.includes(p.hint)) continue;
    const m = p.re.exec(core);
    if (!m) continue;
    const values = {};
    let complete = true;
    p.slots.forEach((slot, i) => {
      const v = m[i + 1];
      const [lead, inner, trail] = splitSpace(v);
      const t =
        hasLetters(inner) && !p.raw.has(slot) && !looksLikeHandle(inner)
          ? translateString(inner, dict, depth + 1)
          : translateDate(inner);
      if (t === undefined && hasLetters(inner) && !p.raw.has(slot) && !looksLikeHandle(inner))
        complete = false;
      values[slot] = t === undefined ? v : lead + t + trail;
    });
    if (complete) return fill(p.zh, values);
    fallback ??= fill(p.zh, values);
  }
  if (fallback !== undefined) return fallback;
  // "· 2 details masked", "Balance:", "Explore workspace →".
  const m = /^([·•|—–:,;/(→↗\s-]*)([\s\S]*?)([·•|—–:,;/)→↗\s]*)$/.exec(core);
  if (m && (m[1] || m[3]) && hasLetters(m[2])) {
    const zh = translateString(m[2], dict, depth + 1);
    if (zh !== undefined) {
      const tail = isCJK(zh.at(-1)) && TRAILING_FULL[m[3]] ? TRAILING_FULL[m[3]] : m[3];
      return m[1] + zh + tail;
    }
  }
  // "Local sample · no charges".
  const segments = core.split(" · ");
  if (segments.length > 1) {
    const out = parts(segments, dict, depth + 1);
    if (out) return out.join(" · ");
  }
  // A list inside a pattern ("Enabled: Chat, Code & Build, Veil") joins with
  // 、. Only within patterns: at the top level a comma is usually a sentence.
  const items = depth > 0 ? core.split(", ") : [];
  if (items.length > 1) {
    const out = parts(items, dict, depth + 1);
    if (out) return out.join("、");
  }
  return undefined;
}

// The translation of rendered text with its leading and trailing whitespace
// kept, or undefined when there is none (the text then stays English).
export function translateText(text, dict) {
  const [lead, body, trail] = splitSpace(String(text));
  const core = normalize(body);
  if (!hasLetters(core)) {
    const date = translateDate(core);
    return date === undefined ? undefined : lead + date + trail;
  }
  let zh = dict.cache.get(core);
  if (zh === undefined) {
    zh = translateString(core, dict) ?? null;
    if (dict.cache.size > 5000) dict.cache.clear();
    dict.cache.set(core, zh);
  }
  return zh === null ? undefined : lead + zh + trail;
}

// Spacing next to Chinese: a space between two Chinese neighbours goes, and
// a lone comma or full stop after Chinese becomes its full-width form.
const FULL = { ",": "，", ".": "。", ":": "：", ";": "；", "!": "！", "?": "？" };
export function adjustSpacing(text, prev, next, chineseBlock = false) {
  const [lead, core, trail] = splitSpace(text);
  if (!core) return lead && isCJK(prev) && isCJK(next) ? "" : text;
  if (FULL[core] && (isCJK(prev) || chineseBlock))
    return FULL[core] + (isCJK(next) ? "" : trail);
  return (
    (lead && isCJK(prev) && isCJK(core[0]) ? "" : lead) +
    core +
    (trail && isCJK(core.at(-1)) && isCJK(next) ? "" : trail)
  );
}

// ---- Language state ----

const KEY = "anonyma.lang";
const storage = () => (typeof window === "undefined" ? null : window.localStorage);
let language;
const listeners = new Set();
export function getLanguage() {
  if (language === undefined) {
    try {
      language = storage()?.getItem(KEY) === "zh" ? "zh" : "en";
    } catch {
      language = "en";
    }
  }
  return language;
}
export function setLanguage(next) {
  next = next === "zh" ? "zh" : "en";
  if (next === getLanguage()) return;
  language = next;
  try {
    storage()?.setItem(KEY, next);
  } catch {}
  listeners.forEach((fn) => fn());
}
export function subscribeLanguage(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export const useLanguage = () =>
  useSyncExternalStore(subscribeLanguage, getLanguage, () => "en");

// Loaded only once Chinese is chosen, so the English bundle is unchanged.
let dictionary;
export function loadDictionary() {
  dictionary ??= import("./i18n/zh.json").then(
    (m) => compileDictionary(m.default),
    (e) => {
      dictionary = undefined;
      throw e;
    },
  );
  return dictionary;
}

// ---- Translating nodes (works on anything with a nodeValue) ----

// Dev-only QA list of English seen while Chinese was on with no translation.
const missing = import.meta.env?.DEV ? new Set() : null;
if (missing && typeof window !== "undefined") window.__i18nMissing = missing;
const noteMissing = (s) => missing?.add(normalize(s));

// One run of the translator. For each text node it remembers
// { en, base, out }: the English React rendered, its translation and what is
// on screen after spacing. A node whose value no longer equals `out` was
// changed by React, so that value is new English. Attributes likewise.
export function createSession(dict) {
  const records = new WeakMap();
  const attrs = new WeakMap();
  const live = new Set();
  const liveAttrs = new Set();
  // Chinese we wrote -> its English, to recognise our own output when a
  // script copies it into new nodes (anime's splitText on a heading).
  const reverse = new Map();
  function english(node) {
    const r = records.get(node);
    if (!r) return node.nodeValue;
    if (node.nodeValue === r.out) return r.en;
    records.delete(node);
    return node.nodeValue;
  }
  function restore(node) {
    const r = records.get(node);
    if (!r) return;
    if (node.nodeValue === r.out && r.out !== r.en) node.nodeValue = r.en;
    records.delete(node);
  }
  function write(node, en, base) {
    const r = records.get(node);
    if (r && r.en === en && r.base === base) return live.add(node);
    if (!r && base === en) return;
    records.set(node, { en, base, out: base });
    live.add(node);
    if (node.nodeValue !== base) node.nodeValue = base;
  }
  function remember(zh, en) {
    if (reverse.size > 5000) reverse.clear();
    reverse.set(normalize(zh), normalize(en));
  }
  // New nodes that already show a translation of ours: their English is
  // known, so they are adopted (the whole text in the first node) and
  // switching back shows the English instead of leaving Chinese behind.
  function adopt(run, ens) {
    if (run.some((n) => records.has(n))) return false;
    const shown = ens.join("");
    const [lead, core, trail] = splitSpace(shown);
    const en = CJK.test(core) && reverse.get(normalize(core));
    if (!en) return false;
    run.forEach((node, i) => {
      const out = i ? "" : shown;
      records.set(node, { en: i ? "" : lead + en + trail, base: out, out });
      live.add(node);
      if (node.nodeValue !== out) node.nodeValue = out;
    });
    return true;
  }
  // Consecutive text nodes ("3", " member", "s") are tried as one string
  // first; the whole translation goes in the first node and the rest are
  // emptied (never removed).
  // Options: `adoptable` (see adopt), `whole` (a split heading's line: its
  // words are never translated one by one) and `fixed` (English -> Chinese,
  // tried first for single nodes: see SCOPED).
  function translateRun(run, { adoptable = false, whole = false, fixed } = {}) {
    const ens = run.map(english);
    if (adoptable && adopt(run, ens)) return;
    let bases;
    if (run.length > 1) {
      const all = ens.join("");
      // A date split across nodes has no letters but still translates.
      if (hasLetters(all) || translateDate(normalize(all)) !== undefined) {
        const t = translateText(all, dict);
        if (t !== undefined) {
          bases = run.map((_, i) => (i ? "" : t));
          remember(t, all);
        } else if (whole) {
          noteMissing(all);
          bases = ens;
        }
      }
    }
    let missed = false;
    bases ??= ens.map((en) => {
      // Letterless text stays as it is, except a bare en-US date or time
      // ("9/25/2026" in a Created column).
      if (!hasLetters(en)) {
        const date = translateText(en, dict);
        if (date !== undefined) remember(date, en);
        return date ?? en;
      }
      const [lead, core, trail] = splitSpace(en);
      const f = fixed?.get(normalize(core));
      if (f !== undefined) return lead + f + trail;
      const t = translateText(en, dict);
      if (t === undefined) {
        noteMissing(en);
        missed = true;
      } else remember(t, en);
      return t ?? en;
    });
    // The whole string is what a dictionary entry would need.
    if (missed && run.length > 1) noteMissing(ens.join(""));
    run.forEach((node, i) => write(node, ens[i], bases[i]));
  }
  // Applies spacing next to Chinese neighbours (prev/next are their nearest
  // visible characters) to a node already through translateRun.
  function space(node, prev, next) {
    if (!node.nodeValue && !records.has(node)) return;
    const en = english(node);
    const r = records.get(node);
    const base = r ? r.base : en;
    // A lone "." after a name ("晚上好，anonyma_demo.") still ends a Chinese
    // sentence when the block around it is Chinese.
    const lone = FULL[base.trim()] !== undefined;
    const block = lone
      ? node.parentElement?.closest("h1,h2,h3,h4,h5,h6,p,li,td,th,dd,dt,label,figcaption")
      : null;
    const out = adjustSpacing(base, prev, next, !!block && /[\u4e00-\u9fff]/.test(block.textContent));
    if (r) {
      if (out === en && base === en) return restore(node);
      r.out = out;
      live.add(node);
    } else if (out === en) return;
    else {
      records.set(node, { en, base: en, out });
      live.add(node);
    }
    if (node.nodeValue !== out) node.nodeValue = out;
  }
  // el.getAttribute/setAttribute; `keep` leaves the English (see styledValues).
  function translateAttr(el, name, keep = false) {
    let map = attrs.get(el);
    const r = map?.get(name);
    const value = el.getAttribute(name);
    if (value === null || (r && value !== r.out)) map?.delete(name);
    if (value === null) return;
    const en = r && value === r.out ? r.en : value;
    const skip = keep || !hasLetters(en);
    const t = skip ? undefined : translateText(en, dict);
    if (t === undefined && !skip) noteMissing(en);
    if (t === undefined || t === en) {
      if (r && value === r.out) {
        el.setAttribute(name, en);
        map.delete(name);
      }
      return;
    }
    if (!map) attrs.set(el, (map = new Map()));
    map.set(name, { en, out: t });
    liveAttrs.add(el);
    if (value !== t) el.setAttribute(name, t);
  }
  // Back to English: every original returns exactly. Nodes React has since
  // rewritten keep React's value.
  function restoreAll() {
    for (const node of live) restore(node);
    for (const el of liveAttrs) {
      attrs.get(el)?.forEach((r, name) => {
        if (el.getAttribute(name) === r.out) el.setAttribute(name, r.en);
      });
      attrs.delete(el);
    }
    live.clear();
    liveAttrs.clear();
  }
  // Forget nodes React has thrown away (a reattached node is found again
  // through its record).
  function prune() {
    for (const n of live) if (!n.isConnected) live.delete(n);
    for (const e of liveAttrs) if (!e.isConnected) liveAttrs.delete(e);
  }
  return { dict, live, translateRun, space, restore, translateAttr, restoreAll, prune };
}

// ---- The live DOM translator ----

// Text inside these is never translated; user and model content carries
// data-i18n="off" (chat messages, conversation titles, collab names, ...).
const NO_TEXT = "script,style,code,pre,textarea,noscript,kbd,samp";
const OFF = '[data-i18n="off"],[contenteditable]:not([contenteditable="false"])';
const ATTRS = ["placeholder", "title", "aria-label", "alt"];
// "How" "it" "works" animate word by word; the dictionary's "工作" "原理"
// already say it all, so the third word is left blank.
const SCOPED = [[".flow-word", "works", ""]];
const scopedFor = (el) => {
  const found = SCOPED.filter(([selector]) => el.matches(selector));
  return found.length ? new Map(found.map(([, en, zh]) => [en, zh])) : undefined;
};
let state = null;

// For text the DOM translator can't reach, such as a confirm() dialog.
export const t = (en) => (state && translateText(en, state.session.dict)) || en;

// anime's splitText (Reveal headings) turns a heading into one span per
// word with spaces between, plus a visually hidden copy of the whole text.
function isSplit(el) {
  for (let c = el?.firstElementChild; c; c = c.nextElementSibling)
    if (c.hasAttribute("data-word")) return true;
  return false;
}
// `blocked`: inside user/model content or code, where text stays as it is.
function textPass(el, blocked) {
  const { session } = state;
  if (blocked) {
    for (let n = el.firstChild; n; n = n.nextSibling)
      if (n.nodeType === 3) session.restore(n);
    return;
  }
  if (el.hasAttribute("data-word")) return;
  if (isSplit(el)) {
    // The words and the spaces between them are one sentence per line.
    const lines = [[]];
    const words = (parent) => {
      for (let n = parent.firstChild; n; n = n.nextSibling)
        if (n.nodeType === 3) lines.at(-1).push(n);
        else if (n.nodeType === 1) words(n);
    };
    for (let n = el.firstChild; n; n = n.nextSibling)
      if (n.nodeType === 3) lines.at(-1).push(n);
      else if (n.nodeName === "BR") lines.push([]);
      else if (n.nodeType === 1 && n.hasAttribute("data-word")) words(n);
    for (const line of lines)
      if (line.length) session.translateRun(line, { adoptable: true, whole: true });
    return;
  }
  // The hidden copy, or a heading split after it was translated, may already
  // show our Chinese (see adopt).
  const adoptable = isSplit(el.parentElement);
  const fixed = scopedFor(el);
  let run = [];
  for (let n = el.firstChild; ; n = n.nextSibling) {
    if (n?.nodeType === 3) {
      run.push(n);
      continue;
    }
    if (run.length) session.translateRun(run, { adoptable, fixed });
    run = [];
    if (!n) break;
  }
}
function edgeChar(node, last) {
  if (node.nodeType === 3) {
    const s = node.nodeValue.trim();
    return s ? (last ? s.at(-1) : s[0]) : "";
  }
  if (node.nodeType !== 1) return "";
  for (let c = last ? node.lastChild : node.firstChild; c; c = last ? c.previousSibling : c.nextSibling) {
    const ch = edgeChar(c, last);
    if (ch) return ch;
  }
  return "";
}
function neighbourChar(node, last) {
  for (let s = last ? node.previousSibling : node.nextSibling; s; s = last ? s.previousSibling : s.nextSibling) {
    const ch = edgeChar(s, last);
    if (ch) return ch;
  }
  return "";
}
function spacingPass(el) {
  if (el.hasAttribute("data-word") || isSplit(el)) return;
  for (let n = el.firstChild; n; n = n.nextSibling)
    if (n.nodeType === 3)
      state.session.space(n, neighbourChar(n, true), neighbourChar(n, false));
}
// Attribute values a stylesheet selects on ([aria-label="Stop generation"])
// stay English, or the rule would stop matching.
function styledValues() {
  const found = new Set();
  const scan = (rules) => {
    for (const rule of rules) {
      for (const m of rule.selectorText?.matchAll(/\[(aria-label|title|alt|placeholder)="([^"]*)"\]/g) || [])
        found.add(m[1] + "=" + m[2]);
      if (rule.cssRules) scan(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) {
    try {
      scan(sheet.cssRules);
    } catch {}
  }
  return found;
}
function attrPass(el, off) {
  for (const name of ATTRS)
    if (el.hasAttribute(name) || off)
      state.session.translateAttr(
        el,
        name,
        off || state.styled.has(name + "=" + el.getAttribute(name)),
      );
}
function collect(el, into) {
  into.add(el);
  for (let c = el.firstElementChild; c; c = c.nextElementSibling)
    collect(c, into);
}
function process(elements) {
  // Parents too: a translated child can change their spacing.
  for (const el of [...elements]) if (el.parentElement) elements.add(el.parentElement);
  const open = [];
  for (const el of elements) {
    const off = !!el.closest(OFF);
    const blocked = off || !!el.closest(NO_TEXT);
    textPass(el, blocked);
    attrPass(el, off);
    if (!blocked) open.push(el);
  }
  // Twice, so a comma turned full-width is seen by the space before it.
  for (let i = 0; i < 2; i++) for (const el of open) spacingPass(el);
  if (state.session.live.size > state.pruned * 2 + 500) {
    state.session.prune();
    state.pruned = state.session.live.size;
  }
}
function onMutations(list, observer) {
  if (!state) return;
  const elements = new Set();
  for (const m of list) {
    if (m.type === "characterData") {
      if (m.target.parentElement) elements.add(m.target.parentElement);
    } else if (m.type === "attributes") {
      if (m.attributeName === "data-i18n") collect(m.target, elements);
      else elements.add(m.target);
    } else {
      elements.add(m.target);
      for (const n of m.addedNodes) if (n.nodeType === 1) collect(n, elements);
    }
  }
  process(elements);
  // Drop the records our own writes just queued: nothing to redo.
  observer.takeRecords();
}

const meta = () => document.querySelector('meta[name="description"]');
export function startTranslator(dict) {
  if (state?.session.dict === dict) return;
  stopTranslator();
  state = {
    session: createSession(dict),
    pruned: 0,
    styled: styledValues(),
    lang: document.documentElement.getAttribute("lang"),
  };
  document.documentElement.setAttribute("lang", "zh-CN");
  const title = document.querySelector("title");
  const elements = new Set();
  collect(document.body, elements);
  if (title) elements.add(title);
  process(elements);
  if (meta()) state.session.translateAttr(meta(), "content");
  state.observer = new MutationObserver(onMutations);
  const options = { childList: true, subtree: true, characterData: true };
  state.observer.observe(document.body, {
    ...options,
    attributes: true,
    attributeFilter: [...ATTRS, "data-i18n"],
  });
  if (title) state.observer.observe(title, options);
}
// Back to English: every original returns and the observer stops.
export function stopTranslator() {
  if (!state) return;
  state.observer?.disconnect();
  state.session.restoreAll();
  if (state.lang === null) document.documentElement.removeAttribute("lang");
  else document.documentElement.setAttribute("lang", state.lang);
  state = null;
}
