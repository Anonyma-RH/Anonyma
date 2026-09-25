import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  TIERS,
  GROUPS,
  EMPTY_LIMITS,
  QUERY_LIMITS,
  MODE_LABELS,
  fold,
  wordStarts,
  matchText,
  scoreItem,
  rankPalette,
  flatten,
  moveActive,
  recentBonus,
  pushRecent,
  validRecent,
  recentStoreKey,
  isApplePlatform,
  isPaletteShortcut,
  shortcutLabel,
  paletteActions,
  paletteReleased,
  historySearchItem,
  chatItems,
  modelItems,
  scrollItems,
  insertIntoPrompt,
  ago,
} from "../src/command-palette.js";

// Command Palette: a browser-only release. These tests cover the pure
// matching, ranking and grouping, which actions appear for each release and
// mode, the release gate itself, the Chinese copy and the source contracts
// that keep it browser-only (no requests, no charges, same model list as the
// picker). The headless-Chrome check lives with the release campaign files.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const src = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const dict = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
const han = /\p{Script=Han}/u;
// A browser config with exactly these updates released.
const cfg = (...ids) => ({
  releases: { features: Object.fromEntries(ids.map((id) => [id, true])) },
});
const ALL = [
  "code", "search", "images", "catalog", "audio", "video", "collab", "api",
  "social", "veil", "uncensored", "ephemeral", "private", "zh", "files",
  "documents", "symposium", "receipts", "scrolls", "app", "training", "mcp",
  "allowances", "connect", "estimates", "branches", "holders", "treasury",
  "doublecheck", "finder", "memory", "tasktools", "longanswers",
  "chatcontrol", "historylibrary", "voice", "palette",
];
const full = cfg(...ALL);
const ids = (list) => list.map((a) => a.id);

// ---- Matching ----

test("fold keeps length and position while dropping case and accents", () => {
  for (const s of ["Café Crème", "ÅNGSTRÖM", "naïve", "中文 Chat", "ﬁle", "İstanbul"]) {
    assert.equal(fold(s).length, s.length, s);
  }
  assert.equal(fold("Café Crème"), "cafe creme");
  assert.equal(fold("GPT-5.4 Mini"), "gpt-5.4 mini");
  assert.deepEqual(
    wordStarts("New chat-log myFile 中文").map((b, i) => (b ? i : -1)).filter((i) => i >= 0),
    [0, 4, 9, 13, 15, 20, 21],
  );
});

test("match tiers: exact > prefix > word start > several words > inside a word > initials > fuzzy", () => {
  const s = (q, t) => matchText(q, t)?.score ?? null;
  assert.equal(s("new chat", "New chat"), TIERS.exact);
  const prefix = s("new", "New chat"),
    word = s("chat", "New chat"),
    words = s("studio ima", "Image Studio"),
    inside = s("hat", "New chat"),
    initials = s("nc", "New chat"),
    fuzzy = s("nwct", "New chat");
  assert.ok(TIERS.exact > prefix && prefix > word, `${prefix} ${word}`);
  assert.ok(word > words && words > inside, `${word} ${words} ${inside}`);
  assert.ok(inside > initials && initials > fuzzy && fuzzy > 0, `${inside} ${initials} ${fuzzy}`);
  // A shorter label wins among prefixes; an earlier word start wins among words.
  assert.ok(s("image", "Image Studio") > s("image", "Images from an old reference archive"));
  assert.ok(s("web", "Web search") > s("web", "Turn on web search"));
  // Case, accents and extra spaces don't matter.
  assert.equal(s("CAFE", "Café notes"), s("café", "cafe notes"));
  assert.equal(s("  new   chat ", "New chat"), TIERS.exact);
});

test("highlight ranges point at the matched characters of the original text", () => {
  const cut = (q, t) => matchText(q, t).ranges.map(([a, b]) => t.slice(a, b));
  assert.deepEqual(cut("chat", "New chat"), ["chat"]);
  assert.deepEqual(cut("nc", "New chat"), ["N", "c"]);
  assert.deepEqual(cut("tows", "Turn on web search"), ["T", "o", "w", "s"]);
  assert.deepEqual(cut("studio img", "Image Studio"), ["Im", "g", "Studio"]);
  assert.deepEqual(cut("cafe", "Déjà vu at the Café"), ["Café"]);
  // Prefers an occurrence at a word start over an earlier one inside a word.
  assert.deepEqual(matchText("art", "Smart art").ranges, [[6, 9]]);
  // Chinese: each character is a word, and substrings match.
  assert.deepEqual(cut("历史", "搜索历史记录"), ["历史"]);
});

test("noise is rejected: no match, mid-word starts and scattered letters", () => {
  assert.equal(matchText("xyz", "New chat"), null);
  assert.equal(matchText("ath", "Turn on web search"), null, "starts mid-word");
  assert.equal(matchText("aeiou", "a long title that has every vowel somewhere in it, eventually, in order"), null);
  assert.equal(matchText("chats", "chat"), null, "longer than the text");
  assert.equal(matchText("a", ""), null);
  assert.deepEqual(matchText("", "anything"), { score: 0, ranges: [] });
  assert.deepEqual(matchText("   ", "anything"), { score: 0, ranges: [] });
});

test("scoreItem: label, translated label and keywords; keywords weigh less and never highlight", () => {
  const item = { label: "Add credits", alt: "充值积分", keywords: ["top up", "buy credits"] };
  const byLabel = scoreItem(item, "add");
  assert.equal(byLabel.field, "label");
  assert.deepEqual(byLabel.ranges, [[0, 3]]);
  const byAlt = scoreItem(item, "充值");
  assert.equal(byAlt.field, "alt");
  assert.deepEqual(byAlt.ranges, [[0, 2]]);
  const byKeyword = scoreItem(item, "top up");
  assert.equal(byKeyword.field, "keywords");
  assert.deepEqual(byKeyword.ranges, []);
  assert.ok(byKeyword.score < byLabel.score);
  assert.equal(scoreItem(item, "zzz"), null);
  // Keywords match as words or initials, never as loose letters: a provider
  // name must not make "ath" match every one of its models.
  const model = { label: "Claude Opus 5.5", keywords: ["claude-opus-5.5", "Anthropic"] };
  assert.ok(matchText("ath", "Anthropic"), "a loose match on its own");
  assert.equal(scoreItem(model, "ath"), null);
  assert.equal(scoreItem(model, "anthro").field, "keywords");
  assert.equal(scoreItem({ label: "Voice & Audio", keywords: ["text to speech"] }, "tts").field, "keywords");
  assert.deepEqual(scoreItem(item, ""), { score: 0, ranges: [], field: "label" });
});

// ---- Ranking and grouping ----

const sampleItems = () => [
  ...chatItems(
    [
      { id: "c1", title: "Trip to Athens", mode: "chat", updated: 1 },
      { id: "c2", title: "Web scraper in Rust", mode: "code", updated: 2 },
      ...Array.from({ length: 10 }, (_, i) => ({ id: "x" + i, title: "Notes " + i, mode: "chat", updated: 3 })),
    ],
    { now: 10 },
  ),
  ...modelItems(
    [
      { id: "claude-opus-5.5", name: "Claude Opus 5.5", provider: "Anthropic" },
      { id: "gpt-6-sol", name: "GPT-6 Sol", provider: "OpenAI" },
    ],
    { current: "gpt-6-sol" },
  ),
  ...scrollItems([{ id: "s1", title: "Weekly report", body: "Summarise {{week}} for the team." }]),
  ...paletteActions({ config: full, mode: "chat", signedIn: true }),
];

test("empty query: recent first, then chats, models, scrolls, actions and places, each capped", () => {
  const { groups, total } = rankPalette(sampleItems(), "", {
    recent: ["action:veil", "chat:c2", "chat:missing", "model:gpt-6-sol"],
  });
  assert.deepEqual(groups.map((g) => g.id), ["recent", "chats", "models", "scrolls", "actions", "goto"]);
  // Recent keeps its order, skips keys that no longer resolve and isn't repeated below.
  assert.deepEqual(groups[0].items.map((i) => i.key), ["action:veil", "chat:c2", "model:gpt-6-sol"]);
  assert.ok(!groups[1].items.some((i) => i.key === "chat:c2"));
  assert.ok(!groups[4].items.some((i) => i.key === "action:veil"));
  assert.equal(groups[1].items.length, EMPTY_LIMITS.chats);
  assert.equal(groups[1].items[0].key, "chat:c1", "the list's own order: most recent first");
  // Indexes run through the groups in display order, for keyboard movement.
  const flat = flatten(groups);
  assert.equal(flat.length, total);
  flat.forEach((it, i) => assert.equal(it.index, i));
});

test("a query keeps only matches, best first, with groups ordered by their best match", () => {
  const { groups } = rankPalette(sampleItems(), "web");
  assert.deepEqual(groups.map((g) => g.id), ["chats", "actions"]);
  assert.equal(groups[0].items[0].label, "Web scraper in Rust");
  assert.equal(groups[1].items[0].id, "web-search");
  const models = rankPalette(sampleItems(), "opus").groups;
  assert.deepEqual(models.map((g) => g.id), ["models"]);
  assert.equal(models[0].items[0].key, "model:claude-opus-5.5");
  // Model ids and providers are searchable too.
  assert.equal(rankPalette(sampleItems(), "openai").groups[0].items[0].key, "model:gpt-6-sol");
  // Scrolls by title or by their text.
  assert.equal(rankPalette(sampleItems(), "weekly").groups[0].items[0].key, "scroll:s1");
  assert.equal(rankPalette(sampleItems(), "summarise").groups[0].items[0].key, "scroll:s1");
  // Per-group caps with a query.
  const notes = rankPalette(sampleItems(), "notes").groups.find((g) => g.id === "chats");
  assert.equal(notes.items.length, QUERY_LIMITS.chats);
  // Nothing matches: no groups at all.
  assert.deepEqual(rankPalette(sampleItems(), "qqqq"), { groups: [], total: 0 });
});

test("weak scattered matches are dropped once something matches properly", () => {
  const items = [
    { key: "a", group: "actions", label: "Account settings" },
    { key: "b", group: "actions", label: "Sample notes text" },
  ];
  // "set" is a word in "Account settings" and only a scattered subsequence in the other.
  assert.ok(matchText("set", "Sample notes text").score < TIERS.initials);
  assert.deepEqual(rankPalette(items, "set").groups[0].items.map((i) => i.key), ["a"]);
  // With no proper match, fuzzy matches are all there is and stay.
  assert.deepEqual(rankPalette(items, "sml").groups[0].items.map((i) => i.key), ["b"]);
  // Initials are a proper match of their own: "set" → Some Example Text.
  assert.ok(matchText("set", "Some example text").score >= TIERS.initials - 50);
});

test("recent use lifts an item among equals but never jumps a tier", () => {
  const items = [
    { key: "one", group: "actions", label: "Open alpha" },
    { key: "two", group: "actions", label: "Open gamma" },
    { key: "exact", group: "actions", label: "Open" },
  ];
  const order = (recent) => rankPalette(items, "open", { recent }).groups[0].items.map((i) => i.key);
  assert.deepEqual(order([]), ["exact", "one", "two"]);
  assert.deepEqual(order(["two"]), ["exact", "two", "one"]);
  assert.ok(recentBonus(0) < TIERS.exact - TIERS.prefix);
  assert.equal(recentBonus(-1), 0);
});

test("'always' items follow a group's matches only when there is a query", () => {
  const items = [
    { key: "chat:1", group: "chats", label: "Athens" },
    { key: "h", group: "chats", label: "Search saved chats for", always: true },
  ];
  assert.deepEqual(rankPalette(items, "").groups[0].items.map((i) => i.key), ["chat:1"]);
  assert.deepEqual(rankPalette(items, "ath").groups[0].items.map((i) => i.key), ["chat:1", "h"]);
  assert.deepEqual(rankPalette(items, "zzz").groups[0].items.map((i) => i.key), ["h"]);
});

test("keyboard movement: arrows wrap, Home and End jump, pages step by five", () => {
  assert.equal(moveActive(0, "ArrowDown", 3), 1);
  assert.equal(moveActive(2, "ArrowDown", 3), 0);
  assert.equal(moveActive(0, "ArrowUp", 3), 2);
  assert.equal(moveActive(1, "Home", 3), 0);
  assert.equal(moveActive(0, "End", 3), 2);
  assert.equal(moveActive(0, "PageDown", 20), 5);
  assert.equal(moveActive(3, "PageUp", 20), 0);
  assert.equal(moveActive(0, "ArrowDown", 0), -1);
});

// ---- Shortcut and recents ----

test("⌘K on Apple platforms and Ctrl+K elsewhere, never with Shift, Alt, repeats or while composing", () => {
  const k = (extra) => ({ key: "k", code: "KeyK", ...extra });
  assert.equal(isPaletteShortcut(k({ metaKey: true }), true), true);
  assert.equal(isPaletteShortcut(k({ ctrlKey: true }), true), false, "Ctrl+K stays kill-line on a Mac");
  assert.equal(isPaletteShortcut(k({ ctrlKey: true }), false), true);
  assert.equal(isPaletteShortcut(k({ metaKey: true }), false), false);
  assert.equal(isPaletteShortcut(k({ ctrlKey: true, metaKey: true }), false), false);
  assert.equal(isPaletteShortcut({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: false }, false), true);
  for (const extra of [{ shiftKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }])
    assert.equal(isPaletteShortcut(k({ ctrlKey: true, ...extra }), false), false, JSON.stringify(extra));
  assert.equal(isPaletteShortcut({ key: "j", code: "KeyJ", ctrlKey: true }, false), false);
  assert.equal(isPaletteShortcut(k({}), false), false, "plain k types a k");
  // Another keyboard layout: the K key types "л" but is still the K key.
  assert.equal(isPaletteShortcut({ key: "л", code: "KeyK", ctrlKey: true }, false), true);
  assert.equal(isPaletteShortcut(null, false), false);
  assert.equal(isApplePlatform({ platform: "MacIntel" }), true);
  assert.equal(isApplePlatform({ userAgentData: { platform: "macOS" } }), true);
  assert.equal(isApplePlatform({ platform: "iPhone" }), true);
  assert.equal(isApplePlatform({ platform: "Win32" }), false);
  assert.equal(isApplePlatform({ platform: "Linux x86_64" }), false);
  assert.equal(isApplePlatform(null), false);
  assert.equal(isApplePlatform({}), false);
  assert.equal(shortcutLabel(true), "⌘K");
  assert.equal(shortcutLabel(false), "Ctrl K");
});

test("recents hold item keys only, per account and separately for the demo", () => {
  assert.equal(recentStoreKey({ userId: "u_1" }), "palette-recent:u_1");
  assert.equal(recentStoreKey({ userId: "u_1", demo: true }), "palette-recent:demo");
  assert.equal(recentStoreKey({}), "palette-recent:guest");
  let list = [];
  for (const k of ["a", "b", "c", "a"]) list = pushRecent(list, k);
  assert.deepEqual(list, ["a", "c", "b"]);
  for (let i = 0; i < 20; i++) list = pushRecent(list, "k" + i);
  assert.equal(list.length, 8);
  assert.deepEqual(pushRecent("junk", "x"), ["x"]);
  assert.deepEqual(validRecent(["ok", 3, null, "", "x".repeat(400), { a: 1 }]), ["ok"]);
  assert.deepEqual(validRecent("nope"), []);
});

// ---- Which actions appear ----

test("MVP only: new chat, account places and the catalog; nothing unreleased", () => {
  const list = paletteActions({ config: cfg(), mode: "chat", signedIn: true });
  assert.deepEqual(ids(list), ["new-chat", "go-home", "account", "top-up", "settings", "models"]);
  // No config at all (offline preview) fails closed the same way.
  assert.deepEqual(ids(paletteActions({ config: undefined, mode: "chat" })), ids(list));
});

test("everything released, signed in, in chat: every action and place except the current one", () => {
  const list = paletteActions({ config: full, mode: "chat", signedIn: true });
  assert.deepEqual(ids(list.filter((a) => a.group === "actions")), [
    "new-chat", "web-search", "veil", "private-mode", "off-record", "scrolls", "memory", "files", "language",
  ]);
  assert.deepEqual(ids(list.filter((a) => a.group === "goto")), [
    "go-home", "go-uncensored", "go-symposium", "go-code", "go-image", "go-video", "go-audio",
    "go-collab", "go-tools", "go-library", "history", "account", "top-up", "api-keys", "settings", "models",
  ]);
  assert.ok(!ids(list).includes("go-chat"), "no link to the page you're on");
  for (const a of list) {
    assert.equal(a.key, "action:" + a.id);
    assert.ok(a.label && typeof a.label === "string");
  }
  assert.equal(list.find((a) => a.id === "top-up").to, "/account/credits");
  assert.equal(list.find((a) => a.id === "go-code").to, "/workspace/code");
  assert.deepEqual(list.find((a) => a.id === "history").state, { libraryTab: "history" });
});

test("each action needs its own release", () => {
  const without = (id) =>
    ids(paletteActions({ config: cfg(...ALL.filter((x) => x !== id)), mode: "chat", signedIn: true }));
  const gates = {
    search: ["web-search"],
    veil: ["veil"],
    private: ["private-mode"],
    ephemeral: ["private-mode", "off-record"],
    scrolls: ["scrolls"],
    memory: ["memory"],
    documents: ["files"],
    files: ["files"],
    zh: ["language"],
    historylibrary: ["history"],
    api: ["api-keys"],
    code: ["go-code"],
    symposium: ["go-symposium"],
    uncensored: ["go-uncensored"],
    images: ["go-image"],
    video: ["go-video"],
    audio: ["go-audio"],
    collab: ["go-collab"],
    tasktools: ["go-tools"],
  };
  const all = ids(paletteActions({ config: full, mode: "chat", signedIn: true }));
  for (const [release, gone] of Object.entries(gates)) {
    const left = without(release);
    for (const id of gone) assert.ok(!left.includes(id), `${id} without ${release}`);
    assert.deepEqual(left, all.filter((id) => !gone.includes(id)), release);
  }
  // Your library needs any one media studio.
  const noMedia = ids(paletteActions({
    config: cfg(...ALL.filter((x) => !["images", "video", "audio"].includes(x))),
    mode: "chat",
    signedIn: true,
  }));
  assert.ok(!noMedia.includes("go-library") && !noMedia.includes("history"));
});

test("toggles follow the composer: where they're shown, labelled by their state", () => {
  const at = (mode, extra = {}) => paletteActions({ config: full, mode, signedIn: true, ...extra });
  // Web search is a chat and code control only.
  assert.ok(ids(at("code")).includes("web-search"));
  assert.ok(!ids(at("uncensored")).includes("web-search"));
  // Image, video and the other studios have no chat toggles, scrolls, memory or files.
  for (const mode of ["image", "video", "audio", "symposium", "home", "library", "collab", "tools"])
    for (const id of ["web-search", "veil", "private-mode", "off-record", "scrolls", "memory", "files"])
      assert.ok(!ids(at(mode)).includes(id), `${id} in ${mode}`);
  const label = (list, id) => list.find((a) => a.id === id)?.label;
  assert.equal(label(at("chat", { webSearch: true }), "web-search"), "Turn off web search");
  assert.equal(label(at("chat", { veilOn: true }), "veil"), "Turn off Veil");
  assert.equal(label(at("chat", { ephemeral: true }), "off-record"), "Go back on the record");
  assert.equal(label(at("chat", { language: "zh" }), "language"), "Switch to English");
  assert.equal(label(at("chat"), "language"), "Switch to 中文");
  const priv = at("chat", { privateMode: true, ephemeral: true, veilOn: true });
  assert.equal(label(priv, "private-mode"), "Turn off Private Mode");
  assert.equal(priv.find((a) => a.id === "private-mode").on, true);
  // Private Mode keeps off the record on; memory and saved files are never offered there.
  for (const id of ["off-record", "memory", "files"]) assert.ok(!ids(priv).includes(id), id);
  // Off the record alone: no memory, no saved files.
  for (const id of ["memory", "files"]) assert.ok(!ids(at("chat", { ephemeral: true })).includes(id), id);
  // Veil on: saved files are unavailable, as the composer's button is.
  assert.ok(!ids(at("chat", { veilOn: true })).includes("files"));
  assert.ok(ids(at("chat", { veilOn: true })).includes("memory"));
  // A shared chat: no memory. While a reply streams: no saved files.
  assert.ok(!ids(at("chat", { shared: true })).includes("memory"));
  assert.ok(!ids(at("chat", { busy: true })).includes("files"));
  // New chat starts over in a text mode, and goes to chat from anywhere else.
  assert.equal(at("code").find((a) => a.id === "new-chat").to, undefined);
  assert.equal(at("code").find((a) => a.id === "new-chat").detail, "Code & build");
  assert.equal(at("image").find((a) => a.id === "new-chat").to, "/workspace/chat");
});

test("a mode that isn't released offers no toggles there", () => {
  const list = paletteActions({ config: cfg("search", "veil", "scrolls"), mode: "code", signedIn: true });
  for (const id of ["web-search", "veil", "scrolls"]) assert.ok(!ids(list).includes(id), id);
  assert.equal(list.find((a) => a.id === "new-chat").to, "/workspace/chat");
});

test("demo and signed-out workspaces: no account-backed actions; the demo keeps ?demo=1", () => {
  const demo = paletteActions({ config: full, mode: "chat", demo: true });
  for (const id of ["veil", "private-mode", "off-record", "scrolls", "memory", "files", "history"])
    assert.ok(!ids(demo).includes(id), id);
  assert.ok(ids(demo).includes("web-search"), "the demo shows the Web toggle too");
  for (const a of demo.filter((x) => x.to && x.to.startsWith("/workspace")))
    assert.match(a.to, /\?demo=1$/, a.id);
  assert.equal(demo.find((a) => a.id === "top-up").to, "/account/credits?demo=1");
  assert.equal(demo.find((a) => a.id === "models").to, "/models");
  const out = paletteActions({ config: full, mode: "chat", signedIn: false });
  for (const id of ["memory", "files", "history"]) assert.ok(!ids(out).includes(id), id);
  assert.ok(ids(out).includes("veil"));
});

test("account pages: places and language only, never a link to the section you're on", () => {
  const list = paletteActions({ config: full, page: "account", section: "credits", signedIn: true });
  assert.deepEqual(ids(list.filter((a) => a.group === "actions")), ["new-chat", "language"]);
  assert.equal(list.find((a) => a.id === "new-chat").to, "/workspace/chat");
  assert.ok(!ids(list).includes("top-up"));
  assert.ok(ids(list).includes("account") && ids(list).includes("go-chat"));
  const overview = paletteActions({ config: full, page: "account", section: "overview", signedIn: true });
  assert.ok(!ids(overview).includes("account") && ids(overview).includes("top-up"));
});

test("'search saved chats for …' only for signed-in History & library with 2–160 characters", () => {
  const ctx = { config: full, signedIn: true };
  const item = historySearchItem("  athens trip ", ctx);
  assert.equal(item.always, true);
  assert.equal(item.noRecent, true);
  assert.deepEqual(item.state, { libraryTab: "history", historyQuery: "athens trip" });
  assert.equal(item.to, "/workspace/library");
  assert.equal(historySearchItem("a", ctx), null);
  assert.equal(historySearchItem("x".repeat(161), ctx), null);
  assert.equal(historySearchItem("athens", { ...ctx, signedIn: false }), null);
  assert.equal(historySearchItem("athens", { ...ctx, demo: true }), null);
  assert.equal(historySearchItem("athens", { config: cfg(...ALL.filter((x) => x !== "historylibrary")), signedIn: true }), null);
});

// ---- Items from page data ----

test("chats: the list's order, Symposium runs left out, titles as written", () => {
  const now = Date.UTC(2026, 8, 25, 12);
  const items = chatItems(
    [
      { id: "a", title: "Athens", mode: "code", updated: now - 2 * 3600e3 },
      { id: "s", title: "A council", mode: "symposium", updated: now },
      { id: "b", title: "", mode: "uncensored", updated: now - 30e3 },
      { id: "c", title: "Old", mode: "chat" },
      null,
    ],
    { current: "a", now },
  );
  assert.deepEqual(items.map((i) => i.key), ["chat:a", "chat:b", "chat:c"]);
  assert.equal(items[0].current, true);
  assert.equal(items[0].detail, MODE_LABELS.code);
  assert.equal(items[0].time, ago(now - 2 * 3600e3, now));
  assert.equal(items[1].label, "Untitled");
  assert.equal(items[1].time, "just now");
  assert.equal(items[2].time, "");
  assert.deepEqual(chatItems(undefined), []);
});

test("models: exactly the picker's list, current first; tags follow the picker's rules", () => {
  const pool = [
    { id: "a", name: "Alpha", provider: "P", private: true, vision: true },
    { id: "b", name: "Beta", provider: "Q", trainsOnPrompts: true },
  ];
  const items = modelItems(pool, { current: "b", trainingLive: true });
  assert.deepEqual(items.map((i) => i.value), [pool[1], pool[0]], "nothing added, nothing dropped");
  assert.equal(items[0].current, true);
  assert.deepEqual(items[0].tags, ["Trains on prompts"]);
  assert.deepEqual(items[1].tags, ["Private", "Sees images"]);
  // Demo models aren't labelled private; training labels need their release.
  assert.deepEqual(modelItems(pool, { demo: true })[0].tags, ["Sees images"]);
  assert.deepEqual(modelItems(pool, {})[1].tags, []);
  assert.deepEqual(modelItems(null), []);
});

test("scrolls: title and text are searchable; variables open the fill form", () => {
  const items = scrollItems([
    { id: "1", title: "Report", body: "Summarise {{week}} for {{team}}." },
    { id: "2", title: "Polite", body: "Rewrite politely." },
    { id: "3", title: "Broken" },
  ]);
  assert.deepEqual(items.map((i) => i.detail), ["2 variables", "Insert"]);
  // Inserting keeps what's typed; an empty prompt or a "/" search is replaced.
  assert.equal(insertIntoPrompt("", "X"), "X");
  assert.equal(insertIntoPrompt("  ", "X"), "X");
  assert.equal(insertIntoPrompt("/rep", "X"), "X");
  assert.equal(insertIntoPrompt("Draft line\n", "X"), "Draft line\n\nX");
});

// ---- The release gate ----

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-palette-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}

test("registered unreleased; off under the MVP and on with RELEASED_FEATURES=palette or all", async (t) => {
  const entry = UPDATES.find((u) => u.id === "palette");
  assert.ok(entry, "palette is registered in UPDATES");
  assert.equal(committed[UPDATES.indexOf(entry)], true, "released by its release commit");
  assert.equal(entry.title, "Command Palette");
  assert.equal(entry.points.length, 3);
  for (const [released, on] of [["mvp", false], ["mvp,palette", true], ["all", true]]) {
    const svc = fixture(t, released);
    const config = (await request(svc.app).get("/api/config").expect(200)).body;
    assert.equal(config.releases.features.palette, on, released);
    assert.equal(paletteReleased(config), on, released);
    assert.equal(config.releases.updates.find((u) => u.id === "palette").released, on);
  }
  assert.equal(paletteReleased(undefined), false);
  assert.equal(paletteReleased({ releases: { features: { palette: "true" } } }), false);
});

test("browser only: no server route, gate or API contract, and no requests from the palette", async (t) => {
  // No request path is gated on it, because there is nothing on the server.
  for (const path of ["/api/palette", "/api/chat", "/api/conversations", "/api/history/search"])
    assert.ok(!featuresFor({ path, method: "POST", body: {} }).includes("palette"), path);
  for (const f of readdirSync(new URL("../server/routes/", import.meta.url)))
    assert.doesNotMatch(src("server/routes/" + f), /palette/i, f);
  assert.doesNotMatch(src("server/app.js"), /palette/i);
  const svc = fixture(t, "all");
  const contract = (await request(svc.app).get("/api/openapi.json").expect(200)).body;
  assert.doesNotMatch(JSON.stringify(contract.paths), /palette/i);
  // Neither half of the palette can reach the network.
  for (const file of ["src/command-palette.js", "src/CommandPalette.jsx"]) {
    const code = src(file);
    for (const call of [/\bapi\(/, /\bfetch\(/, /streamChat/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/])
      assert.doesNotMatch(code, call, `${file}: ${call}`);
  }
});

// ---- Wiring (source contracts) ----

test("the workspace wires the palette behind its release, with the picker's own models", () => {
  const ws = src("src/Workspace.jsx");
  assert.match(ws, /const paletteLive = paletteReleased\(config\);/);
  assert.match(ws, /const palette = usePalette\(paletteLive\);/);
  assert.match(ws, /\{paletteLive && \(\s*<PaletteButton/);
  assert.match(ws, /\{palette\.open && \(\s*<CommandPalette/);
  // Models: the same list the picker shows (Private Mode, Uncensored and
  // image-reading narrowing included), switched the way the picker switches.
  assert.match(ws, /finderLive\s*\?\s*finderModels\s*:\s*visibleModels/);
  assert.match(ws, /<ModelFinder\s+models=\{finderModels\}/);
  assert.match(ws, /if \(finderLive\) chooseModel\(\{ model: item\.value\.id \}\);/);
  // Toggles call the composer's own handlers.
  for (const call of ["togglePrivateMode()", "toggleEphemeral()", "setWebSearch((v) => !v)", "setVeilOn((v) => !v)", "setScrollsPanel(true)"])
    assert.ok(ws.includes(call), call);
  // History from the palette only pre-fills the search box.
  assert.match(ws, /request=\{paletteLive && location\.state\?\.libraryTab/);
  const lib = src("src/HistoryLibrary.jsx");
  assert.match(lib, /if \(request\?\.tab !== "history"\) return;/);
  assert.doesNotMatch(lib.slice(lib.indexOf("request?.tab"), lib.indexOf("request?.tab") + 400), /search\(/);
  // Saved files open only where the composer's own button is enabled.
  assert.match(src("src/ReusableUploads.jsx"), /if \(!openRequest \|\| disabled \|\| privateContext\) return;/);
  const account = src("src/Account.jsx");
  assert.match(account, /const paletteLive = paletteReleased\(config\);/);
  assert.match(account, /\{paletteLive && \(\s*<PaletteButton/);
});

test("the dialog is an accessible combobox and listbox with a focus trap and focus return", () => {
  const jsx = src("src/CommandPalette.jsx");
  for (const needle of [
    'role="combobox"',
    'aria-expanded="true"',
    "aria-controls={listId}",
    'aria-autocomplete="list"',
    "aria-activedescendant=",
    'role="listbox"',
    'role="group"',
    'role="option"',
    "aria-selected=",
    'aria-labelledby={id + "-title"}',
    'aria-live="polite"',
    "showModal()",
    'aria-haspopup="dialog"',
    "aria-keyshortcuts=",
    'e.key !== "Tab"',
    "refocus(prev)",
    "input.current?.blur()",
    'window.addEventListener("keydown", onKey, true)',
  ])
    assert.ok(jsx.includes(needle), needle);
  // Labels are rendered by the palette itself (with highlights), so the page
  // translator is kept off them; chat titles and model names are content.
  assert.match(jsx, /className="palette-label" data-i18n="off"/);
  const css = src("src/command-palette.css");
  assert.match(css, /\.palette-option\.active/);
  assert.match(css, /@media\(max-width:700px\)/);
  assert.match(css, /:focus-visible/);
});

// ---- Chinese ----

test("every string the palette shows has a Chinese translation", () => {
  const entry = UPDATES.find((u) => u.id === "palette");
  const lines = new Set([entry.title, entry.tagline, ...entry.points, ...GROUPS.map((g) => g.label), ...Object.values(MODE_LABELS)]);
  for (const mode of ["chat", "code", "image", "home"])
    for (const state of [{}, { webSearch: true, veilOn: true, ephemeral: true, language: "zh" }, { privateMode: true }])
      for (const a of paletteActions({ config: full, mode, signedIn: true, ...state })) {
        if (a.label !== "Switch to 中文") lines.add(a.label);
        if (a.detail) lines.add(a.detail);
      }
  lines.add(historySearchItem("athens", { config: full, signedIn: true }).label);
  for (const tag of ["Private", "Sees images", "Trains on prompts"]) lines.add(tag);
  for (const d of ["Insert", "1 variable", "3 variables"]) lines.add(d);
  const jsx = src("src/CommandPalette.jsx"),
    ws = src("src/Workspace.jsx"),
    account = src("src/Account.jsx");
  const ui = [
    "Open the command palette", "Command palette", "Search", "Close the command palette",
    "Use the up and down arrow keys to move through the results, Enter to choose, and Escape to close.",
    "Results", "Current", "On", "Off", "Move", "Choose", "Close", "Open or close",
    "Nothing matches. Try fewer letters or another word.", "Nothing to show here yet.",
    "Search chats, models, scrolls and actions…",
  ];
  for (const s of ui) {
    assert.ok(jsx.includes(s), `still used: ${s}`);
    lines.add(s);
  }
  for (const s of ["Search chats, models and actions…", "Search chats and actions…"]) {
    assert.ok(ws.includes(s), s);
    lines.add(s);
  }
  assert.ok(account.includes("Search actions and places…"));
  lines.add("Search actions and places…");
  for (const s of ["1 result", "7 results", "2 hours ago", "yesterday", "last week", "just now"]) lines.add(s);
  for (const line of lines) {
    const zh = translateText(line, dict);
    assert.ok(zh && han.test(zh), `zh: ${line} → ${zh}`);
    // No English words left behind, apart from names and key labels.
    const leftover = (zh.match(/[A-Za-z]{4,}/g) || []).filter((w) => !["Veil", "Enter", "Escape", "Ctrl"].includes(w));
    assert.deepEqual(leftover, [], `half-translated: ${line} → ${zh}`);
  }
});

test("in Chinese, action labels are searchable by their translation", () => {
  const actions = paletteActions({ config: full, mode: "chat", signedIn: true, language: "zh" }).map((a) => ({
    ...a,
    alt: translateText(a.label, dict),
  }));
  const top = (q) => rankPalette(actions, q).groups[0]?.items[0];
  assert.equal(top("新对话").id, "new-chat");
  assert.equal(top("新对话").field, "alt");
  assert.equal(top("联网").id, "web-search");
  assert.equal(top("隐私").id, "private-mode");
  assert.equal(top("充值").id, "top-up");
  // English still works while Chinese is shown.
  assert.equal(top("top up").id, "top-up");
});
