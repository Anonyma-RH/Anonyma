// Command Palette (⌘K on a Mac, Ctrl+K elsewhere): the pure, DOM-free half.
// Matching, ranking, grouping, recents and which actions exist in the
// current context live here so they can be unit tested with node --test;
// CommandPalette.jsx renders them.
//
// Nothing here touches the network. The palette searches only what the page
// already holds: the conversation list, the model picker's own list and the
// account's scrolls. Opening it, typing in it and choosing from it send
// nothing and charge nothing.
import { isReleased, modeReleased } from "./lib.js";
import { MEMORY_MODES } from "./memory.js";
import { extractVariables } from "./scrolls.js";
export { moveActive } from "./model-finder.js";

export const paletteReleased = (config) => isReleased(config, "palette");

// ---- Text matching ----

// Lower-cased, accent-free text of exactly the input's length, so a match
// position maps straight back onto the original string for highlighting.
export function fold(text) {
  const s = String(text ?? "");
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const n = ch.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const lower = ch.toLowerCase();
    out += n.length === 1 ? n : lower.length === 1 ? lower : ch;
  }
  return out;
}
const WORD = /[\p{L}\p{N}]/u;
const HAN = /[⺀-鿿豈-﫿]/;
// Where words begin: the first character, anything after a separator, a
// capital after a lower-case letter (camelCase) and every Chinese character.
export function wordStarts(text) {
  const s = String(text ?? "");
  const starts = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i],
      prev = s[i - 1];
    starts.push(
      WORD.test(ch) &&
        (i === 0 ||
          !WORD.test(prev) ||
          HAN.test(ch) ||
          (prev !== prev.toUpperCase() && ch !== ch.toLowerCase())),
    );
  }
  return starts;
}
const toRanges = (positions) => {
  const ranges = [];
  for (const p of positions) {
    const last = ranges.at(-1);
    if (last && last[1] === p) last[1] = p + 1;
    else ranges.push([p, p + 1]);
  }
  return ranges;
};

// Score tiers: an exact match beats a prefix, which beats a match at a word
// start, then several words matched separately, then a match inside a word,
// then initials ("nc" → New chat), then any in-order subsequence.
export const TIERS = {
  exact: 1000,
  prefix: 900,
  word: 800,
  words: 700,
  inside: 600,
  initials: 500,
  fuzzy: 100,
};

// Best subsequence alignment of `q` in `t` (both folded), preferring word
// starts and consecutive runs. Dynamic programming, linear in |q|·|t|.
function subsequence(q, t, starts) {
  const n = q.length,
    m = t.length;
  if (!n || n > m) return null;
  // Quick reject: not even a greedy subsequence.
  for (let i = 0, j = 0; i < n; i++, j++) {
    j = t.indexOf(q[i], j);
    if (j === -1) return null;
  }
  const START = 8,
    RUN = 5,
    GAP = 1,
    LEAD = 0.2;
  const NONE = -Infinity;
  let prev = new Array(m).fill(NONE);
  const back = [];
  for (let j = 0; j < m; j++)
    if (t[j] === q[0]) prev[j] = 1 + (starts[j] ? START : 0) - LEAD * j;
  back.push(new Array(m).fill(-1));
  for (let i = 1; i < n; i++) {
    const cur = new Array(m).fill(NONE),
      from = new Array(m).fill(-1);
    // best over k <= j-2 of prev[k] - GAP*(j-k-1), carried along j.
    let far = NONE,
      farAt = -1;
    for (let j = 1; j < m; j++) {
      if (j >= 2 && prev[j - 2] - GAP > far - GAP) {
        far = prev[j - 2] - GAP;
        farAt = j - 2;
      } else far -= GAP;
      if (t[j] !== q[i]) continue;
      const near = prev[j - 1] + RUN;
      const base = near >= far ? near : far;
      if (base === NONE) continue;
      cur[j] = base + 1 + (starts[j] ? START : 0);
      from[j] = near >= far ? j - 1 : farAt;
    }
    prev = cur;
    back.push(from);
  }
  let end = -1,
    best = NONE;
  for (let j = 0; j < m; j++)
    if (prev[j] > best) {
      best = prev[j];
      end = j;
    }
  if (end === -1) return null;
  const positions = [end];
  for (let i = n - 1; i > 0; i--) positions.unshift(back[i][positions[0]]);
  return { value: best, positions };
}

// One piece of a query (no spaces) against a text: {score, ranges} or null.
// Without `fuzzy`, only contiguous matches and initials count.
function matchPiece(q, t, starts, fuzzy = true) {
  const idx = t.indexOf(q);
  if (idx !== -1) {
    let at = idx;
    for (let p = idx; p !== -1; p = t.indexOf(q, p + 1))
      if (starts[p]) {
        at = p;
        break;
      }
    const ranges = [[at, at + q.length]];
    if (at === 0)
      return {
        score:
          q.length === t.length
            ? TIERS.exact
            : TIERS.prefix - Math.min(t.length - q.length, 99) * 0.5,
        ranges,
      };
    return {
      score: (starts[at] ? TIERS.word : TIERS.inside) - Math.min(at, 99) * 0.5,
      ranges,
    };
  }
  const fit = subsequence(q, t, starts);
  if (!fit) return null;
  const { positions } = fit;
  const spread = positions.at(-1) - positions[0] + 1 - positions.length;
  // Letters scattered across a long text, or starting mid-word, are noise.
  if (!starts[positions[0]] || spread > Math.max(12, q.length * 3)) return null;
  const ranges = toRanges(positions);
  if (positions.every((p) => starts[p]))
    return {
      score: TIERS.initials - Math.min(positions[0], 99) * 0.5 - spread * 0.5,
      ranges,
    };
  if (!fuzzy) return null;
  const quality = Math.max(0, Math.min(1, fit.value / (14 * q.length)));
  return { score: TIERS.fuzzy + Math.round(290 * quality), ranges };
}

// How well `query` matches `text`: {score, ranges} (ranges are [start, end)
// pairs into `text`), or null for no match. An empty query matches with 0.
// `fuzzy: false` leaves out loose subsequences (used for keywords, where a
// provider name like "Anthropic" would otherwise match almost anything).
export function matchText(query, text, { fuzzy = true } = {}) {
  const q = fold(query).trim().replace(/\s+/g, " ");
  if (!q) return { score: 0, ranges: [] };
  const t = fold(text);
  if (!t.trim()) return null;
  const starts = wordStarts(text);
  const whole = matchPiece(q, t, starts, fuzzy);
  const pieces = q.split(" ");
  if (pieces.length < 2) return whole;
  if (whole && whole.score >= TIERS.inside) return whole;
  // Several words: every one must match on its own, anywhere in the text.
  let total = 0;
  const positions = new Set();
  for (const piece of pieces) {
    const m = matchPiece(piece, t, starts, fuzzy);
    if (!m) return whole;
    total += m.score;
    for (const [a, b] of m.ranges) for (let p = a; p < b; p++) positions.add(p);
  }
  const avg = total / pieces.length;
  const score = avg >= TIERS.word ? TIERS.words - (TIERS.prefix - avg) * 0.2 : avg * 0.8;
  const combined = {
    score,
    ranges: toRanges([...positions].sort((a, b) => a - b)),
  };
  return whole && whole.score >= combined.score ? whole : combined;
}

// An item's best match over its label, its translated label (`alt`) and its
// keywords. Keywords count for less and are never highlighted.
export const KEYWORD_WEIGHT = 0.7;
export function scoreItem(item, query) {
  if (!fold(query).trim()) return { score: 0, ranges: [], field: "label" };
  const fields = [
    ["label", item.label, 1],
    ["alt", item.alt, 1],
    ...(item.keywords || []).map((k) => ["keywords", k, KEYWORD_WEIGHT]),
  ];
  let best = null;
  for (const [field, text, weight] of fields) {
    if (!text) continue;
    const m = matchText(query, text, { fuzzy: field !== "keywords" });
    if (!m) continue;
    const score = m.score * weight;
    if (!best || score > best.score)
      best = { score, ranges: field === "keywords" ? [] : m.ranges, field };
  }
  return best;
}

// ---- Ranking and grouping ----

export const GROUPS = [
  { id: "recent", label: "Recent" },
  { id: "chats", label: "Chats" },
  { id: "models", label: "Models" },
  { id: "scrolls", label: "Scrolls" },
  { id: "actions", label: "Actions" },
  { id: "goto", label: "Go to" },
];
// Per-group caps with an empty query (a short overview) and with a query.
export const EMPTY_LIMITS = { recent: 5, chats: 5, models: 5, scrolls: 5, actions: 50, goto: 50 };
export const QUERY_LIMITS = { chats: 8, models: 8, scrolls: 6, actions: 8, goto: 8 };
// A recently used item gets a small lift, never enough to jump a tier.
export const recentBonus = (index) => (index < 0 ? 0 : Math.max(0, 30 - index * 5));
// Once something matches as a whole word or better, weak scattered matches
// below this share of the best score are dropped as noise.
export const CUTOFF = 0.35;

// Items: { key, group, label, alt?, keywords?, always? }. With an empty
// query: a Recent group (from `recent`, the most recent keys first) and then
// each group in GROUPS order, items in their given order. With a query: only
// matches, best first in each group, and the groups ordered by their best
// match. `always` items (a "search saved chats for…" fallback) follow the
// matches of their group whenever there is a query.
export function rankPalette(items, query, { recent = [], limits } = {}) {
  const hasQuery = !!fold(query).trim();
  const caps = { ...(hasQuery ? QUERY_LIMITS : EMPTY_LIMITS), ...(limits || {}) };
  const byGroup = new Map(GROUPS.map((g) => [g.id, []]));
  const recentAt = new Map(recent.map((k, i) => [k, i]));
  if (!hasQuery) {
    const known = new Map(items.filter((it) => !it.always).map((it) => [it.key, it]));
    const recents = recent
      .map((k) => known.get(k))
      .filter(Boolean)
      .slice(0, caps.recent);
    const taken = new Set(recents.map((it) => it.key));
    byGroup.set("recent", recents.map((it) => ({ ...it, ranges: [], score: 0 })));
    for (const it of items)
      if (!it.always && !taken.has(it.key) && byGroup.has(it.group))
        byGroup.get(it.group).push({ ...it, ranges: [], score: 0 });
    return finish(byGroup, caps, GROUPS.map((g) => g.id));
  }
  const extra = new Map();
  items.forEach((it, order) => {
    if (!byGroup.has(it.group) || it.group === "recent") return;
    if (it.always) {
      if (!extra.has(it.group)) extra.set(it.group, []);
      extra.get(it.group).push({ ...it, ranges: [], score: -1, order });
      return;
    }
    const m = scoreItem(it, query);
    if (!m) return;
    byGroup.get(it.group).push({
      ...it,
      ranges: m.ranges,
      field: m.field,
      score: m.score + recentBonus(recentAt.has(it.key) ? recentAt.get(it.key) : -1),
      order,
    });
  });
  const best = Math.max(-Infinity, ...[...byGroup.values()].flat().map((it) => it.score));
  if (best >= TIERS.inside)
    for (const [group, list] of byGroup)
      byGroup.set(group, list.filter((it) => it.score >= best * CUTOFF));
  for (const list of byGroup.values())
    list.sort((a, b) => b.score - a.score || a.order - b.order);
  for (const [group, list] of byGroup) list.splice(caps[group] ?? 8);
  for (const [group, list] of extra) byGroup.get(group).push(...list);
  const top = (id) => byGroup.get(id)[0]?.score ?? -Infinity;
  const order = GROUPS.map((g) => g.id)
    .filter((id) => id !== "recent")
    .sort((a, b) => top(b) - top(a) || GROUPS.findIndex((g) => g.id === a) - GROUPS.findIndex((g) => g.id === b));
  return finish(byGroup, {}, order);
}
function finish(byGroup, caps, order) {
  const groups = [];
  let index = 0;
  for (const id of order) {
    const list = byGroup.get(id).slice(0, caps[id] ?? Infinity);
    if (!list.length) continue;
    groups.push({
      id,
      label: GROUPS.find((g) => g.id === id).label,
      items: list.map((it) => ({ ...it, index: index++ })),
    });
  }
  return { groups, total: index };
}
export const flatten = (groups) => groups.flatMap((g) => g.items);

// ---- Recents (this browser only) ----

export const RECENT_LIMIT = 8;
// Per account (and separate for the demo), holding item keys, never titles.
export const recentStoreKey = ({ demo = false, userId = null } = {}) =>
  "palette-recent:" + (demo ? "demo" : userId || "guest");
export function pushRecent(list, key, limit = RECENT_LIMIT) {
  const clean = Array.isArray(list)
    ? list.filter((k) => typeof k === "string" && k && k.length <= 300 && k !== key)
    : [];
  return [key, ...clean].slice(0, limit);
}
export const validRecent = (list) =>
  Array.isArray(list)
    ? list.filter((k) => typeof k === "string" && k && k.length <= 300).slice(0, RECENT_LIMIT)
    : [];

// ---- The shortcut ----

export const isApplePlatform = (nav = globalThis.navigator) =>
  /Mac|iPhone|iPad|iPod/i.test(
    nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "",
  );
// ⌘K on Apple platforms, Ctrl+K elsewhere, from any focused element. Never
// with Shift or Alt, and never while an input method is composing. e.code
// covers keyboard layouts where the K key types another letter.
export function isPaletteShortcut(e, apple) {
  if (!e || e.isComposing || e.altKey || e.shiftKey || e.repeat) return false;
  if (!(e.key === "k" || e.key === "K" || e.code === "KeyK")) return false;
  return apple ? !!e.metaKey && !e.ctrlKey : !!e.ctrlKey && !e.metaKey;
}
export const shortcutLabel = (apple) => (apple ? "⌘K" : "Ctrl K");
export const ariaShortcut = (apple) => (apple ? "Meta+K" : "Control+K");

// ---- What the palette lists ----

export const TEXT_MODES = ["chat", "code", "uncensored"];
// Modes whose composer has a model picker.
export const MODEL_MODES = ["chat", "code", "uncensored", "image", "video"];
export const MODE_LABELS = {
  home: "Home",
  chat: "Chat & reason",
  uncensored: "Uncensored",
  symposium: "Symposium",
  code: "Code & build",
  image: "Image studio",
  video: "Video studio",
  audio: "Voice studio",
  collab: "Collab",
  library: "Your library",
  tools: "Research, Writing & Calculators",
};
// The workspace's places, in the sidebar's order.
const PLACES = [
  ["home", "Workspace home", ["dashboard", "overview", "start"]],
  ["chat", "Chat & reason", ["conversation", "talk", "ask", "reasoning"]],
  ["uncensored", "Uncensored", ["unfiltered", "uncensored models"]],
  ["symposium", "Symposium", ["compare models", "several models", "side by side", "council"]],
  ["code", "Code & Build", ["programming", "coding", "developer"]],
  ["image", "Image Studio", ["images", "picture", "generate an image", "art"]],
  ["video", "Video Studio", ["video", "movie", "clip", "animation"]],
  ["audio", "Voice & Audio", ["voice", "audio", "speech", "text to speech", "transcribe"]],
  ["collab", "Collab", ["team", "shared", "members", "together"]],
  ["tools", "Research, Writing & Calculators", ["task tools", "research", "writing", "calculator"]],
  ["library", "Your library", ["library", "media", "saved images", "saved videos"]],
];

// The actions and places the palette offers, from release flags and the
// page's state. Only released features appear (the same checks the app
// uses: isReleased and modeReleased, which include early access), and only
// where they make sense: toggles where the composer shows that toggle,
// never a link to the page you're on.
export function paletteActions(ctx = {}) {
  const {
    config,
    page = "workspace",
    mode = "home",
    section = "overview",
    demo = false,
    signedIn = false,
    webSearch = false,
    veilOn = false,
    privateMode = false,
    ephemeral = false,
    shared = false,
    busy = false,
    language = "en",
  } = ctx;
  const on = (id) => isReleased(config, id);
  const q = demo ? "?demo=1" : "";
  const ws = page === "workspace";
  const here = (m) => ws && mode === m;
  const text = ws && TEXT_MODES.includes(mode) && modeReleased(config, mode);
  const live = !demo;
  const out = [];
  const add = (group, a) =>
    out.push({ group, i18n: true, key: "action:" + a.id, ...a });

  add("actions", {
    id: "new-chat",
    label: "New chat",
    icon: "plus",
    keywords: ["new conversation", "start fresh", "blank chat"],
    detail: MODE_LABELS[text ? mode : "chat"],
    ...(text ? {} : { to: "/workspace/chat" + q }),
  });
  if (ws && ["chat", "code"].includes(mode) && modeReleased(config, mode) && on("search"))
    add("actions", {
      id: "web-search",
      label: webSearch ? "Turn off web search" : "Turn on web search",
      icon: "globe",
      toggle: true,
      on: webSearch,
      keywords: ["web", "internet", "sources", "online", "search the web"],
      detail: "About 21 credits per search",
    });
  if (text && live && on("veil"))
    add("actions", {
      id: "veil",
      label: veilOn ? "Turn off Veil" : "Turn on Veil",
      icon: "shield",
      toggle: true,
      on: veilOn,
      keywords: ["mask", "redact", "hide private details", "privacy"],
      detail: "Masks private details in your browser before sending",
    });
  if (text && live && on("private") && on("ephemeral"))
    add("actions", {
      id: "private-mode",
      label: privateMode ? "Turn off Private Mode" : "Turn on Private Mode",
      icon: "eyeoff",
      toggle: true,
      on: privateMode,
      keywords: ["private", "zero data retention", "zdr", "privacy"],
      detail: "Starts a fresh chat",
    });
  // Private Mode keeps Off the record on, as its own toggle does.
  if (text && live && on("ephemeral") && !privateMode)
    add("actions", {
      id: "off-record",
      label: ephemeral ? "Go back on the record" : "Go off the record",
      icon: "eye",
      toggle: true,
      on: ephemeral,
      keywords: ["off the record", "ephemeral", "don't save", "temporary", "incognito"],
      detail: "Starts a fresh chat",
    });
  if (text && live && on("scrolls"))
    add("actions", {
      id: "scrolls",
      label: "Open Scrolls",
      icon: "book",
      keywords: ["saved prompts", "standing instructions", "templates"],
      detail: "Saved prompts and standing instructions",
    });
  if (
    text && live && signedIn && on("memory") && MEMORY_MODES.includes(mode) &&
    !privateMode && !ephemeral && !shared
  )
    add("actions", {
      id: "memory",
      label: "Open Memory",
      icon: "memory",
      keywords: ["memory", "facts", "remember"],
      detail: "Facts you choose to share with every model",
    });
  // Saved files aren't offered in Private, off-the-record or Veil contexts,
  // exactly as the composer's own button is disabled there.
  if (
    text && live && signedIn && on("documents") && on("files") &&
    !privateMode && !ephemeral && !veilOn && !busy
  )
    add("actions", {
      id: "files",
      label: "Open saved files",
      icon: "file",
      keywords: ["files", "uploads", "reusable uploads", "documents"],
      detail: "Owner-only files you saved for reuse",
    });
  if (on("zh"))
    add("actions", {
      id: "language",
      label: language === "zh" ? "Switch to English" : "Switch to 中文",
      icon: "globe",
      keywords: ["language", "chinese", "english", "zh", "en", "中文", "语言", "英文", "简体中文"],
    });

  for (const [id, label, keywords] of PLACES)
    if (modeReleased(config, id) && !here(id))
      add("goto", { id: "go-" + id, label, keywords, icon: "arrow", to: "/workspace/" + id + q });
  if (live && signedIn && on("historylibrary") && modeReleased(config, "library"))
    add("goto", {
      id: "history",
      label: "Search history",
      icon: "history",
      keywords: ["history", "saved conversations", "find a conversation", "past chats"],
      to: "/workspace/library" + q,
      state: { libraryTab: "history" },
    });
  const account = (id, label, sec, keywords, extra = {}) =>
    !(page === "account" && section === sec) &&
    add("goto", { id, label, keywords, to: "/account" + (sec === "overview" ? "" : "/" + sec) + q, ...extra });
  account("account", "Account", "overview", ["profile", "balance", "usage", "overview"], { icon: "settings" });
  account("top-up", "Add credits", "credits", ["top up", "buy credits", "deposit", "fund", "balance", "pay"], { icon: "credits" });
  if (on("api")) account("api-keys", "API keys", "keys", ["developer", "api", "keys", "cli", "tokens"], { icon: "key" });
  account("settings", "Account settings", "settings", ["preferences", "sessions", "export", "sign out"], { icon: "settings" });
  add("goto", {
    id: "models",
    label: "Explore models",
    icon: "models",
    keywords: ["catalog", "model catalog", "prices", "pricing"],
    to: "/models",
  });
  return out;
}

// "Search saved chats for …": opens History & library with the words typed
// in its search box. It never searches by itself; the person presses Search.
export function historySearchItem(query, ctx = {}) {
  const { config, demo = false, signedIn = false } = ctx;
  const q = String(query || "").trim();
  if (demo || !signedIn || q.length < 2 || q.length > 160) return null;
  if (!isReleased(config, "historylibrary") || !modeReleased(config, "library")) return null;
  return {
    key: "history-search",
    group: "chats",
    always: true,
    noRecent: true,
    id: "history-search",
    label: "Search saved chats for",
    query: q,
    i18n: true,
    icon: "search",
    to: "/workspace/library",
    state: { libraryTab: "history", historyQuery: q },
  };
}

const rtf =
  typeof Intl !== "undefined" && Intl.RelativeTimeFormat
    ? new Intl.RelativeTimeFormat(undefined, { numeric: "auto" })
    : null;
// "2 hours ago", as the workspace home shows it.
export function ago(t, now = Date.now()) {
  const s = (now - Number(t)) / 1000;
  if (!Number.isFinite(s) || !rtf) return "";
  if (s < 60) return "just now";
  for (const [unit, sec] of [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ])
    if (s >= sec) return rtf.format(-Math.floor(s / sec), unit);
  return "";
}

// Saved conversations, in the list's own order (most recent first).
// Symposium runs have no thread view, so they stay out as they do in the
// sidebar.
export function chatItems(conversations = [], { current = null, now = Date.now() } = {}) {
  return (Array.isArray(conversations) ? conversations : [])
    .filter((c) => c && c.id && c.mode !== "symposium")
    .map((c) => ({
      key: "chat:" + c.id,
      group: "chats",
      label: String(c.title || "Untitled").slice(0, 200),
      detail: MODE_LABELS[c.mode] || MODE_LABELS.chat,
      time: c.updated ? ago(c.updated, now) : "",
      current: c.id === current,
      icon: "chat",
      value: c,
    }));
}

// The model picker's own list (already narrowed for Private Mode, the
// Uncensored section and images in the chat), the current model first.
export function modelItems(models = [], { current = "", demo = false, trainingLive = false } = {}) {
  const list = (Array.isArray(models) ? models : []).filter((m) => m && m.id);
  const ordered = [
    ...list.filter((m) => m.id === current),
    ...list.filter((m) => m.id !== current),
  ];
  return ordered.map((m) => ({
    key: "model:" + m.id,
    group: "models",
    label: String(m.name || m.id),
    keywords: [m.id, m.provider].filter(Boolean),
    detail: m.provider || "",
    tags: [
      !demo && m.private ? "Private" : "",
      m.vision ? "Sees images" : "",
      trainingLive && m.trainsOnPrompts ? "Trains on prompts" : "",
    ].filter(Boolean),
    current: m.id === current,
    icon: "models",
    value: m,
  }));
}

// Saved scrolls: searched by title and the start of their text.
export function scrollItems(scrolls = []) {
  return (Array.isArray(scrolls) ? scrolls : [])
    .filter((s) => s && s.id && typeof s.body === "string")
    .map((s) => {
      const vars = extractVariables(s.body).length;
      return {
        key: "scroll:" + s.id,
        group: "scrolls",
        label: String(s.title || "Untitled scroll").slice(0, 200),
        keywords: [s.body.slice(0, 160)],
        detail: vars ? `${vars} variable${vars > 1 ? "s" : ""}` : "Insert",
        icon: "book",
        value: s,
      };
    });
}

// Inserting a scroll from the palette keeps what's already in the composer:
// an empty prompt (or a "/" scroll search) is replaced, anything else gets
// the scroll after a blank line.
export function insertIntoPrompt(prompt, text) {
  const p = String(prompt || "");
  return !p.trim() || /^\/\S*$/.test(p.trim()) ? text : p.trimEnd() + "\n\n" + text;
}
