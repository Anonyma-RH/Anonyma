import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { unveil } from "../src/veil.js";
import { paletteActions } from "../src/command-palette.js";
import {
  CONTENT_SELECTOR,
  FIND_RELEASE,
  MAX_MATCHES,
  MAX_QUERY,
  SEPARATOR,
  cleanQuery,
  collectText,
  countLabel,
  findAriaShortcut,
  findMatches,
  findShortcutLabel,
  findStepKey,
  foldCase,
  isFindShortcut,
  isWholeWord,
  matchRange,
  normalizeSpace,
  prepareItem,
  sameOrNext,
  startIndex,
  step,
  takesShortcut,
} from "../src/find-in-chat.js";

// Find in Chat (update "findinchat"): a browser-only release. These tests
// cover the matching (case, whole words, overlaps, emoji, CJK, long chats),
// reading rendered markdown into searchable text and back to text nodes,
// stepping, labels, the shortcut, the release gate, the palette entry, the
// Chinese copy and the source contracts that keep it in the browser. The
// headless-Chrome check lives with the release campaign files.

// Release commits flip `released` on UPDATES entries; these tests cover the
// gate itself, so every update is pinned unreleased for this file.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const src = (path) =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");
const dict = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
const han = /\p{Script=Han}/u;

// ---- A tiny DOM, enough for collectText ----------------------------------

function element(tagName, attrs = {}, children = []) {
  const el = {
    nodeType: 1,
    tagName: tagName.toUpperCase(),
    attrs,
    childNodes: [],
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name)
        ? this.attrs[name]
        : null;
    },
  };
  for (const c of children)
    el.childNodes.push(typeof c === "string" ? textNode(c) : c);
  return el;
}
const textNode = (value) => ({ nodeType: 3, nodeValue: value });
const h = (tag, attrs, ...children) => element(tag, attrs || {}, children);
const entities = (s) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, "\u00a0")
    .replace(/&amp;/g, "&");
// React's static markup is well formed, so a small parser reads it back.
function parseHTML(html) {
  const VOID = new Set([
    "br",
    "hr",
    "img",
    "input",
    "meta",
    "link",
    "source",
    "wbr",
  ]);
  const root = element("div", { class: "markdown" });
  const stack = [root];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    const top = stack.at(-1);
    if (text !== undefined) {
      top.childNodes.push(textNode(entities(text)));
      continue;
    }
    if (tag.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (tag.startsWith("<!")) continue;
    const name = /^<([a-zA-Z0-9]+)/.exec(tag)[1];
    const attrs = {};
    for (const [, k, v] of tag
      .slice(1 + name.length)
      .replace(/\/?>$/, "")
      .matchAll(/([^\s=]+)(?:="([^"]*)")?/g))
      attrs[k] = v === undefined ? "" : entities(v);
    const node = element(name, attrs);
    top.childNodes.push(node);
    if (!VOID.has(name.toLowerCase()) && !tag.endsWith("/>")) stack.push(node);
  }
  return root;
}
// A message's markdown as the workspace renders it (remark-gfm, plus an
// optional Veil map restoring masked values on screen).
function rendered(markdown, { veilMap } = {}) {
  const plugins = [remarkGfm];
  if (veilMap)
    plugins.push(() => (tree) => {
      const walk = (n) => {
        if (n.type === "text") n.value = unveil(n.value, veilMap);
        (n.children || []).forEach(walk);
      };
      walk(tree);
    });
  return parseHTML(
    renderToStaticMarkup(
      createElement(ReactMarkdown, { remarkPlugins: plugins }, markdown),
    ),
  );
}
const item = (root) => prepareItem(collectText(root));
const hits = (items, q, opts) => findMatches(items, q, opts).matches;
const texts = (items, q, opts) =>
  hits(items, q, opts).map((m) => items[m.item].text.slice(m.start, m.end));

// ---- Matching -------------------------------------------------------------

test("case-insensitive by default; Match case finds only the exact case", () => {
  const items = [prepareItem({ text: "Athens, athens and ATHENS." })];
  assert.deepEqual(texts(items, "athens"), ["Athens", "athens", "ATHENS"]);
  assert.deepEqual(texts(items, "ATHENS"), ["Athens", "athens", "ATHENS"]);
  assert.deepEqual(texts(items, "Athens", { matchCase: true }), ["Athens"]);
  assert.deepEqual(texts(items, "athens", { matchCase: true }), ["athens"]);
  assert.deepEqual(hits(items, "Sparta"), []);
});

test("matches run left to right without overlapping, like the browser's own find", () => {
  const one = [prepareItem({ text: "aaaa" })];
  assert.deepEqual(
    hits(one, "aa").map((m) => m.start),
    [0, 2],
  );
  assert.deepEqual(
    hits([prepareItem({ text: "aaa" })], "aa").map((m) => m.start),
    [0],
  );
  assert.deepEqual(
    hits([prepareItem({ text: "abababa" })], "aba").map((m) => m.start),
    [0, 4],
  );
  // Matches never overlap, so the highlights never overlap either.
  const m = hits([prepareItem({ text: "x".repeat(50) })], "xxx");
  assert.equal(m.length, 16);
  m.slice(1).forEach((x, i) => assert.ok(x.start >= m[i].end));
  // A match never spans two parts (two messages, or a reply and its sources).
  assert.deepEqual(
    hits(
      [prepareItem({ text: "end of one" }), prepareItem({ text: "two" })],
      "one two",
    ),
    [],
  );
});

test("Whole word: letters, digits, marks and _ make words; punctuation and spaces don't", () => {
  const items = [
    prepareItem({
      text: "cat concat cat_1 cat. (cat) cats scat cat-nap 3cat cat3",
    }),
  ];
  assert.deepEqual(
    hits(items, "cat", { wholeWord: true }).map((m) => m.start),
    [0, 17, 23, 38],
  );
  assert.equal(hits(items, "cat").length, 10);
  // A failed candidate doesn't hide a word right after it.
  assert.deepEqual(
    texts([prepareItem({ text: "catcat cat" })], "cat", { wholeWord: true }),
    ["cat"],
  );
  // A query with its own punctuation or spaces at the edge.
  assert.deepEqual(
    texts([prepareItem({ text: "Hello, world" })], "hello,", {
      wholeWord: true,
    }),
    ["Hello,"],
  );
  assert.equal(
    hits([prepareItem({ text: "café" })], "caf", { wholeWord: true }).length,
    0,
  );
  // A combining accent belongs to its letter: "cafe" isn't a whole word in "café".
  assert.equal(
    hits([prepareItem({ text: "cafe\u0301 au lait" })], "cafe", {
      wholeWord: true,
    }).length,
    0,
  );
  assert.equal(isWholeWord("a b", 0, 1), true);
  assert.equal(isWholeWord("ab", 0, 1), false);
  assert.equal(
    hits(items, "cat", { wholeWord: true, matchCase: true }).length,
    4,
  );
});

test("emoji and other characters outside the BMP are found whole, never half", () => {
  const items = [
    prepareItem({ text: "Ship it 🚀🚀 then 👍🏽 and 🔥fire🔥 and 𝐁𝐨𝐥𝐝" }),
  ];
  assert.deepEqual(texts(items, "🚀"), ["🚀", "🚀"]);
  assert.deepEqual(texts(items, "👍🏽"), ["👍🏽"]);
  assert.deepEqual(
    texts(items, "👍"),
    ["👍"],
    "the base emoji matches without its skin tone",
  );
  // An emoji is not a letter, so it's a word boundary.
  assert.deepEqual(texts(items, "fire", { wholeWord: true }), ["fire"]);
  assert.deepEqual(texts(items, "𝐁𝐨𝐥𝐝"), ["𝐁𝐨𝐥𝐝"]);
  // Surrogates stay paired in every match.
  for (const m of hits(items, "🚀")) {
    const t = items[0].text;
    assert.ok(
      !(t.charCodeAt(m.start) >= 0xdc00 && t.charCodeAt(m.start) <= 0xdfff),
    );
  }
  // A query cut at MAX_QUERY never ends in half an emoji.
  const long = "a".repeat(MAX_QUERY - 1) + "🚀";
  const q = cleanQuery(long);
  assert.equal(q, "a".repeat(MAX_QUERY - 1));
  assert.ok(cleanQuery("b".repeat(500)).length === MAX_QUERY);
});

test("Chinese, Japanese and mixed scripts; Whole word never hides a match in spaceless scripts", () => {
  const items = [
    prepareItem({
      text: "我们明天去雅典。Athens 雅典卫城很美。東京とアテネ。",
    }),
  ];
  assert.deepEqual(texts(items, "雅典"), ["雅典", "雅典"]);
  assert.deepEqual(texts(items, "雅典", { wholeWord: true }), ["雅典", "雅典"]);
  assert.deepEqual(texts(items, "アテネ"), ["アテネ"]);
  assert.deepEqual(texts(items, "athens", { wholeWord: true }), ["Athens"]);
  // Next to Chinese, an English word is still whole.
  assert.deepEqual(
    texts([prepareItem({ text: "用GPT写" })], "gpt", { wholeWord: true }),
    ["GPT"],
  );
  // Korean is written with spaces, so it keeps ordinary word rules.
  assert.equal(
    hits([prepareItem({ text: "안녕하세요" })], "안녕", { wholeWord: true })
      .length,
    0,
  );
  assert.equal(
    hits([prepareItem({ text: "안녕 하세요" })], "안녕", { wholeWord: true })
      .length,
    1,
  );
});

test("case folding keeps every position; special cases fold sensibly", () => {
  for (const s of [
    "İstanbul",
    "ΟΔΟΣ",
    "Straße",
    "ẞ",
    "Ǆ",
    "𐐀𐐨",
    "ÅNGSTRÖM",
    "中文 Chat 🚀",
  ])
    assert.equal(foldCase(s).length, s.length, s);
  // The dotted İ lowercases to two characters, so it's kept as it is.
  assert.equal(foldCase("İstanbul"), "İstanbul");
  assert.deepEqual(
    texts([prepareItem({ text: "İstanbul and istanbul" })], "ISTANBUL"),
    ["istanbul"],
  );
  // Final sigma folds to σ.
  assert.deepEqual(texts([prepareItem({ text: "ΟΔΟΣ οδος οδoς" })], "οδοσ"), [
    "ΟΔΟΣ",
    "οδος",
  ]);
  assert.deepEqual(texts([prepareItem({ text: "Deseret 𐐀" })], "𐐨"), ["𐐀"]);
});

test("spaces: non-breaking spaces and soft line breaks read as spaces; code keeps its lines", () => {
  const items = [
    prepareItem({ text: normalizeSpace("New\u00a0York and\nboston\u2003tea") }),
  ];
  assert.deepEqual(
    texts(items, "new york"),
    ["New\u00a0York"].map((s) => s.replace("\u00a0", " ")),
  );
  assert.equal(hits(items, "and boston").length, 1);
  assert.equal(hits(items, "boston tea").length, 1);
  const code = [
    prepareItem({
      text: normalizeSpace(
        "const a = 1;\nconst b = 2;\r\nreturn a\t+ b;",
        true,
      ),
    }),
  ];
  assert.equal(hits(code, "1; const").length, 0, "no match across code lines");
  assert.equal(hits(code, "a + b").length, 1, "a tab reads as a space");
  assert.equal(cleanQuery("   "), "");
  assert.equal(cleanQuery("\u00a0x"), " x");
  assert.equal(cleanQuery(null), "");
  assert.deepEqual(findMatches([prepareItem({ text: "anything" })], "  "), {
    matches: [],
    capped: false,
  });
});

test("the count stops at MAX_MATCHES and says so", () => {
  const items = Array.from({ length: 30 }, () =>
    prepareItem({ text: "the ".repeat(500) }),
  );
  const { matches, capped } = findMatches(items, "the");
  assert.equal(matches.length, MAX_MATCHES);
  assert.equal(capped, true);
  const small = findMatches(items, "the", { limit: 20 });
  assert.equal(small.matches.length, 20);
  assert.equal(small.capped, true);
  assert.equal(findMatches(items.slice(0, 2), "the").capped, false);
  assert.equal(
    countLabel({ index: 0, total: MAX_MATCHES, capped: true, query: "the" }),
    "1 of 10,000+",
  );
});

test("a very long chat: 2,000 messages (about 4 MB of text) are read and searched quickly", () => {
  const words = [
    "olive",
    "harbour",
    "ferry",
    "marble",
    "column",
    "temple",
    "the",
    "and",
    "Naxos",
    "sunset",
    "kouros",
    "schedule",
  ];
  let seed = 7;
  const rand = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const messages = [];
  for (let i = 0; i < 2000; i++) {
    const parts = [];
    while (parts.join(" ").length < 2000)
      parts.push(words[Math.floor(rand() * words.length)]);
    if (i === 1234) parts.push("Blue Star ferry at 07:30 from Paros");
    messages.push(
      h(
        "div",
        { class: "markdown" },
        h("p", null, parts.slice(0, 150).join(" ")),
        h("ul", null, h("li", null, parts.slice(150).join(" "))),
      ),
    );
  }
  let t = performance.now();
  const items = messages.map(item);
  const readMs = performance.now() - t;
  const total = items.reduce((n, x) => n + x.text.length, 0);
  assert.ok(total > 3_900_000, `text ${total}`);
  t = performance.now();
  const rare = findMatches(items, "blue star ferry");
  const rareMs = performance.now() - t;
  t = performance.now();
  const common = findMatches(items, "temple", { wholeWord: true });
  const commonMs = performance.now() - t;
  t = performance.now();
  const exact = findMatches(items, "Naxos", { matchCase: true });
  const exactMs = performance.now() - t;
  assert.equal(rare.matches.length, 1);
  assert.equal(rare.matches[0].item, 1234);
  assert.ok(
    common.matches.length > 5000 && common.matches.length <= MAX_MATCHES,
  );
  assert.ok(exact.matches.length > 5000);
  // Generous bounds for a busy machine; typical runs are a small fraction.
  assert.ok(readMs < 4000, `read ${readMs.toFixed(0)} ms`);
  assert.ok(rareMs < 1500, `rare ${rareMs.toFixed(0)} ms`);
  assert.ok(commonMs < 2500, `common ${commonMs.toFixed(0)} ms`);
  assert.ok(exactMs < 2500, `exact ${exactMs.toFixed(0)} ms`);
  console.log(
    `# long chat: ${(total / 1e6).toFixed(1)} MB read in ${readMs.toFixed(0)} ms; searches ${rareMs.toFixed(0)} / ${commonMs.toFixed(0)} / ${exactMs.toFixed(0)} ms`,
  );
});

// ---- Reading what's on screen --------------------------------------------

test("rendered markdown is searched as it reads: formatting marks aren't text, blocks don't run together", () => {
  const md = [
    "Take the **07:30 Blue Star ferry** from *Paros* to [Naxos](https://example.com/naxos).",
    "",
    "1. Book deck seats",
    "2. Rent the car in `Naxos town`",
    "",
    "| Island | Day |",
    "| --- | --- |",
    "| Milos | Tuesday |",
    "",
    "> Slow cooling gives satin glazes depth.",
    "",
    "```js",
    "export function page(items, cursor = 0) {",
    "  return items.slice(cursor);",
    "}",
    "```",
  ].join("\n");
  const it = item(rendered(md));
  // Bold, italic, links and inline code read as plain words.
  assert.equal(
    hits([it], "07:30 blue star ferry from paros to naxos").length,
    1,
  );
  assert.equal(hits([it], "Naxos town").length, 1);
  // The markdown syntax itself isn't on screen, so it isn't found.
  assert.equal(hits([it], "**").length, 0);
  assert.equal(hits([it], "](https").length, 0);
  assert.equal(hits([it], "| Milos").length, 0);
  // Table cells and list items are separate blocks.
  assert.equal(hits([it], "Milos").length, 1);
  assert.equal(hits([it], "Milos Tuesday").length, 0);
  assert.equal(hits([it], "seats Rent").length, 0);
  assert.ok(it.text.includes(SEPARATOR));
  // Code blocks are searched, line by line.
  assert.equal(hits([it], "items.slice(cursor)").length, 1);
  assert.equal(hits([it], "cursor = 0").length, 1);
  assert.equal(hits([it], "cursor) { return").length, 0);
  assert.equal(hits([it], "satin glazes").length, 1);
});

test("every character maps back to its text node, even across bold and links", () => {
  const it = item(
    rendered(
      "Take the **Blue Star** ferry to [Naxos town](https://example.com).",
    ),
  );
  const [m] = hits([it], "blue star ferry to naxos");
  const [startNode, startOffset, endNode, endOffset] = matchRange(
    it.segments,
    m.start,
    m.end,
  );
  assert.equal(startNode.nodeValue.slice(startOffset), "Blue Star");
  assert.equal(endNode.nodeValue.slice(0, endOffset), "Naxos");
  // Reading the ranges back gives exactly the matched text.
  const nodes = it.segments.map((s) => s.node);
  const from = nodes.indexOf(startNode),
    to = nodes.indexOf(endNode);
  const readBack = nodes
    .slice(from, to + 1)
    .map((n, i, all) =>
      n.nodeValue.slice(
        i === 0 ? startOffset : 0,
        i === all.length - 1 ? endOffset : undefined,
      ),
    )
    .join("");
  assert.equal(readBack, "Blue Star ferry to Naxos");
  // A match inside one node, and at the very start and end of a part.
  const one = item(
    h("div", null, h("p", null, "alpha beta"), h("p", null, "gamma")),
  );
  const g = hits([one], "gamma")[0];
  const r = matchRange(one.segments, g.start, g.end);
  assert.equal(r[0].nodeValue, "gamma");
  assert.deepEqual([r[1], r[3]], [0, 5]);
  const a = matchRange(one.segments, 0, 5);
  assert.deepEqual([a[0].nodeValue, a[1], a[3]], ["alpha beta", 0, 5]);
  assert.equal(matchRange(one.segments, 500, 505), null);
});

test("controls, hidden parts and closed details aren't searched; open ones are", () => {
  const root = h(
    "div",
    { class: "markdown" },
    h("p", null, "Visible answer"),
    h(
      "div",
      { class: "preview-block" },
      h("pre", null, h("code", null, "<p>hi</p>")),
      h("button", null, "Preview"),
    ),
    h("span", { "aria-hidden": "true" }, "decorative"),
    h("span", { hidden: "" }, "hidden text"),
    h("div", { "data-find": "skip" }, "skipped label"),
    h(
      "details",
      null,
      h("summary", null, "Reasoning"),
      h("p", null, "closed thoughts"),
    ),
    h(
      "details",
      { open: "" },
      h("summary", null, "More"),
      h("p", null, "open thoughts"),
    ),
    h("svg", null, "icon text"),
    h("textarea", null, "draft text"),
  );
  const it = item(root);
  assert.equal(hits([it], "visible answer").length, 1);
  assert.equal(hits([it], "<p>hi</p>").length, 1, "an HTML code block is text");
  for (const gone of [
    "Preview",
    "decorative",
    "hidden text",
    "skipped label",
    "closed thoughts",
    "Reasoning",
    "More",
    "icon text",
    "draft text",
  ])
    assert.equal(hits([it], gone).length, 0, gone);
  assert.equal(hits([it], "open thoughts").length, 1);
});

test("Veil values restored on screen are searchable; the tags the model saw are not", () => {
  const map = { EMAIL_1: "maria@example.com", NAME_1: "Maria Papadopoulou" };
  const it = item(
    rendered("Send the plan to [NAME_1] at [EMAIL_1] before Friday.", {
      veilMap: map,
    }),
  );
  assert.deepEqual(texts([it], "maria@example.com"), ["maria@example.com"]);
  assert.equal(hits([it], "papadopoulou").length, 1);
  assert.equal(hits([it], "[EMAIL_1]").length, 0);
  // Without this browser's map the tag is what's on screen, so that's what's found.
  const plain = item(rendered("Send the plan to [EMAIL_1] before Friday."));
  assert.equal(hits([plain], "[EMAIL_1]").length, 1);
});

test("whitespace between blocks is dropped, a <br> separates lines, text in a <pre> keeps its lines", () => {
  const it = item(
    h(
      "div",
      null,
      "\n",
      h("p", null, "one"),
      "\n",
      h("p", null, "two", h("br"), "three"),
      "\n  ",
      h("pre", null, "a\n\nb"),
    ),
  );
  assert.equal(it.text, ["one", "two", "three", "a\n\nb"].join(SEPARATOR));
  assert.equal(it.segments.length, 4);
  for (const s of it.segments)
    assert.equal(
      it.text.slice(s.start, s.end),
      normalizeSpace(s.node.nodeValue, s.node.nodeValue.includes("\n")),
    );
  assert.deepEqual(collectText(h("div")), { text: "", segments: [] });
  assert.deepEqual(collectText(null), { text: "", segments: [] });
});

test("the searched parts are the chat's messages, sources, open reasoning and Symposium answers", () => {
  for (const s of [
    ".message .markdown",
    ".message .citations a",
    ".message details[open] > p",
    ".symposium-question",
    ".symposium-column .markdown",
  ])
    assert.ok(CONTENT_SELECTOR.split(", ").includes(s), s);
  // The labels, buttons and turn actions around a message are not.
  assert.doesNotMatch(
    CONTENT_SELECTOR,
    /message-label|turn-actions|button|composer/,
  );
});

// ---- Moving through matches --------------------------------------------------

test("stepping goes round both ways; a refresh keeps your place; a fresh search starts where you read", () => {
  assert.equal(step(0, 3, 1), 1);
  assert.equal(step(2, 3, 1), 0);
  assert.equal(step(0, 3, -1), 2);
  assert.equal(step(-1, 3, 1), 0);
  assert.equal(step(-1, 3, -1), 2);
  assert.equal(step(0, 0, 1), -1);
  const matches = [
    { item: 0, start: 4 },
    { item: 2, start: 10 },
    { item: 2, start: 30 },
    { item: 5, start: 0 },
  ];
  assert.equal(sameOrNext(matches, { item: 2, start: 30 }), 2);
  assert.equal(
    sameOrNext(matches, { item: 2, start: 20 }),
    2,
    "the one after, when it moved",
  );
  assert.equal(
    sameOrNext(matches, { item: 9, start: 0 }),
    3,
    "past the end: the last one",
  );
  assert.equal(sameOrNext(matches, undefined), 0);
  assert.equal(sameOrNext([], { item: 0, start: 0 }), -1);
  // Tops on screen: the first at or below the top of the readable area...
  const rects = [-900, -300, 40, 700].map((top) => ({ top, bottom: top + 20 }));
  assert.equal(
    startIndex(4, (i) => rects[i], 60),
    2,
  );
  assert.equal(
    startIndex(4, (i) => rects[i], -2000),
    0,
  );
  // ...else the nearest one above (at the bottom of a long chat).
  assert.equal(
    startIndex(4, (i) => rects[i], 2000),
    3,
  );
  assert.equal(
    startIndex(0, () => null, 0),
    -1,
  );
  // It stops at the first one it needs.
  let asked = 0;
  startIndex(1000, (i) => (asked++, { top: i * 10, bottom: i * 10 + 5 }), 50);
  assert.ok(asked < 10);
});

test("the count: '3 of 12', 'No matches', nothing before you type; in Chinese too", () => {
  assert.equal(countLabel({ index: 2, total: 12, query: "ferry" }), "3 of 12");
  assert.equal(
    countLabel({ index: -1, total: 0, query: "ferry" }),
    "No matches",
  );
  assert.equal(countLabel({ index: 0, total: 1234, query: "x" }), "1 of 1,234");
  assert.equal(countLabel({ index: -1, total: 0, query: "  " }), "");
  assert.equal(
    countLabel({ index: 2, total: 12, query: "ferry" }, true),
    "第 3 个，共 12 个",
  );
  assert.equal(
    countLabel({ index: -1, total: 0, query: "渡轮" }, true),
    "无匹配",
  );
  assert.equal(
    countLabel({ index: 0, total: 10000, capped: true, query: "the" }, true),
    "第 1 个，共 10,000+ 个",
  );
  assert.equal(countLabel(), "");
});

// ---- The shortcut -------------------------------------------------------------

test("⌘F on Apple platforms, Ctrl+F elsewhere; ⌘G/Ctrl+G and F3 step", () => {
  const key = (k, extra = {}) => ({
    key: k,
    code: "Key" + k.toUpperCase(),
    ...extra,
  });
  assert.equal(isFindShortcut(key("f", { metaKey: true }), true), true);
  assert.equal(isFindShortcut(key("F", { metaKey: true }), true), true);
  assert.equal(isFindShortcut(key("f", { ctrlKey: true }), true), false);
  assert.equal(isFindShortcut(key("f", { ctrlKey: true }), false), true);
  assert.equal(isFindShortcut(key("f", { metaKey: true }), false), false);
  // Another layout: the F key types something else, the code still says KeyF.
  assert.equal(
    isFindShortcut({ key: "а", code: "KeyF", ctrlKey: true }, false),
    true,
  );
  for (const extra of [
    { shiftKey: true },
    { altKey: true },
    { isComposing: true },
    { ctrlKey: true, metaKey: true },
  ])
    assert.equal(
      isFindShortcut(key("f", { metaKey: true, ...extra }), true),
      false,
      JSON.stringify(extra),
    );
  assert.equal(
    isFindShortcut(key("k", { metaKey: true }), true),
    false,
    "⌘K stays the palette's",
  );
  assert.equal(isFindShortcut(null, true), false);
  assert.equal(findStepKey(key("g", { metaKey: true }), true), 1);
  assert.equal(
    findStepKey(key("g", { metaKey: true, shiftKey: true }), true),
    -1,
  );
  assert.equal(findStepKey(key("g", { ctrlKey: true }), false), 1);
  assert.equal(findStepKey(key("g", { ctrlKey: true }), true), 0);
  assert.equal(findStepKey({ key: "F3" }, false), 1);
  assert.equal(findStepKey({ key: "F3", shiftKey: true }, true), -1);
  assert.equal(findStepKey({ key: "Enter" }, true), 0);
  assert.equal(findShortcutLabel(true), "⌘F");
  assert.equal(findShortcutLabel(false), "Ctrl F");
  assert.equal(findAriaShortcut(true), "Meta+F");
  assert.equal(findAriaShortcut(false), "Control+F");
});

test("the shortcut is taken from the page, the chat, the composer and the bar, never another text field", () => {
  assert.equal(takesShortcut({ body: true }), true);
  assert.equal(
    takesShortcut({ composer: true, editable: true, inWorkspace: true }),
    true,
  );
  assert.equal(
    takesShortcut({ inBar: true, editable: true, inWorkspace: true }),
    true,
  );
  assert.equal(
    takesShortcut({ inWorkspace: true }),
    true,
    "a message, a sidebar link",
  );
  assert.equal(
    takesShortcut({ inWorkspace: true, editable: true }),
    false,
    "a rename box, the model search",
  );
  assert.equal(takesShortcut({ editable: true }), false);
  assert.equal(takesShortcut({}), false, "outside the workspace");
  assert.equal(takesShortcut(), false);
});

// ---- The release gate --------------------------------------------------------

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-find-in-chat-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}

test("registered last and unreleased; off under the MVP, on by id or all", async (t) => {
  const entry = UPDATES.find((u) => u.id === FIND_RELEASE);
  assert.ok(entry, "registered in UPDATES");
  assert.equal(FIND_RELEASE, "findinchat");
  assert.ok(
    UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "bookmarks"),
    "added after the releases before it",
  );
  assert.equal(
    committed[UPDATES.indexOf(entry)],
    true,
    "released by its release commit",
  );
  assert.equal(entry.title, "Find in Chat");
  assert.equal(entry.points.length, 3);
  for (const [released, on] of [
    ["mvp", false],
    ["mvp,findinchat", true],
    ["all", true],
  ]) {
    const s = fixture(t, released);
    const config = (await request(s.app).get("/api/config").expect(200)).body;
    assert.equal(config.releases.features.findinchat, on, released);
    assert.equal(
      config.releases.updates.find((u) => u.id === "findinchat").released,
      on,
      released,
    );
  }
});

test("browser only: no route, gate or API contract, and the code never reaches the network", async (t) => {
  for (const [path, method] of [
    ["/api/conversations/c_1", "GET"],
    ["/api/history/search", "GET"],
    ["/api/chat", "POST"],
    ["/api/find", "GET"],
  ])
    assert.ok(
      !featuresFor({ path, method, body: {} }).includes("findinchat"),
      path,
    );
  for (const f of readdirSync(new URL("../server/routes/", import.meta.url)))
    assert.doesNotMatch(
      src("server/routes/" + f),
      /findinchat|find-in-chat/i,
      f,
    );
  assert.doesNotMatch(src("server/app.js"), /findinchat|find-in-chat/i);
  assert.doesNotMatch(src("server/openapi.js"), /findinchat|find-in-chat/i);
  const s = fixture(t, "all");
  const contract = (await request(s.app).get("/api/openapi.json").expect(200))
    .body;
  assert.doesNotMatch(JSON.stringify(contract.paths), /find/i);
  for (const file of ["src/find-in-chat.js", "src/FindInChat.jsx"]) {
    const code = src(file);
    for (const call of [
      /\bapi\(/,
      /\bfetch\(/,
      /streamChat/,
      /XMLHttpRequest/,
      /sendBeacon/,
      /WebSocket/,
      /localStorage/,
      /saveStore/,
    ])
      assert.doesNotMatch(code, call, `${file}: ${call}`);
  }
});

test("the messages' DOM is never rewritten: matches are painted with CSS highlights", () => {
  const jsx = src("src/FindInChat.jsx");
  assert.match(jsx, /CSS\.highlights\.set\(ALL/);
  assert.match(jsx, /CSS\.highlights\.set\(CURRENT/);
  assert.match(jsx, /const ALL = "anonyma-find";/);
  assert.match(jsx, /const CURRENT = "anonyma-find-current";/);
  for (const bad of [
    /innerHTML/,
    /outerHTML/,
    /surroundContents/,
    /createElement\("mark"\)/,
    /\.normalize\(\)/,
    /execCommand/,
    /insertAdjacentHTML/,
  ])
    assert.doesNotMatch(jsx, bad, String(bad));
  const css = src("src/find-in-chat.css");
  assert.match(css, /::highlight\(anonyma-find\)/);
  assert.match(css, /::highlight\(anonyma-find-current\)/);
  // Mobile, visible focus, and print.
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media print/);
});

test("the workspace shows Find only once released and while a conversation is on screen", () => {
  const ws = src("src/Workspace.jsx");
  assert.match(ws, /enabled: findInChatReleased\(config\)/);
  assert.match(
    ws,
    /\(textMode && messages\.length > 0\) \|\| \(mode === "symposium" && symposiumShown\)/,
  );
  assert.match(ws, /\{find\.button\}/);
  assert.match(ws, /\{find\.bar\}/);
  assert.match(ws, /case "find-in-chat":\s*return find\.show\(\);/);
  assert.match(ws, /onResults=\{setSymposiumShown\}/);
  assert.match(src("src/Symposium.jsx"), /onResults\?\.\(findable\)/);
  const jsx = src("src/FindInChat.jsx");
  assert.match(jsx, /const live = !!enabled && !!findable;/);
  assert.match(jsx, /const button = live \?/);
  assert.match(jsx, /live && open \?/);
  // The shortcut listener exists only while the update is released.
  assert.match(jsx, /if \(!enabled\) return;\s*const onKey/);
});

test("the palette offers Find in this chat only when it's released and a chat is on screen", () => {
  const cfg = (...ids) => ({
    releases: { features: Object.fromEntries(ids.map((id) => [id, true])) },
  });
  const find = (config, extra = {}) =>
    paletteActions({ config, mode: "chat", signedIn: true, ...extra }).find(
      (a) => a.id === "find-in-chat",
    );
  const item = find(cfg("findinchat"), { findable: true });
  assert.ok(item);
  assert.equal(item.label, "Find in this chat");
  assert.equal(item.group, "actions");
  assert.equal(
    find(cfg("findinchat")),
    undefined,
    "nothing on screen to search",
  );
  assert.equal(find(cfg(), { findable: true }), undefined, "unreleased");
  assert.ok(
    find(cfg("findinchat"), { findable: true, demo: true }),
    "the demo's local chats too",
  );
  assert.equal(
    paletteActions({
      config: cfg("findinchat"),
      page: "account",
      findable: true,
    }).find((a) => a.id === "find-in-chat"),
    undefined,
  );
});

// ---- The bar, rendered --------------------------------------------------------

async function uiModule() {
  const file = new URL("../src/FindInChat.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(
    readFileSync(file, "utf8"),
    file.pathname,
    {
      jsx: "transform",
      format: "esm",
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "anonyma-find-in-chat-ui-"));
  const local = (name) => new URL("../src/" + name, import.meta.url).href;
  const out = code
    .replace(/^import "\.\/find-in-chat\.css";$/m, "")
    .replace(/from "\.\/lib\.js"/g, `from "${local("lib.js")}"`)
    .replace(/from "\.\/i18n\.js"/g, `from "${local("i18n.js")}"`)
    .replace(
      /from "\.\/command-palette\.js"/g,
      `from "${local("command-palette.js")}"`,
    )
    .replace(
      /from "\.\/find-in-chat\.js"/g,
      `from "${local("find-in-chat.js")}"`,
    )
    .replace(
      /from "lucide-react"/g,
      `from "${import.meta.resolve("lucide-react")}"`,
    )
    .replace(/from "react"/g, `from "${import.meta.resolve("react")}"`);
  const path = join(dir, "FindInChat.mjs");
  writeFileSync(path, out);
  try {
    return await import(pathToFileURL(path).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the bar: a search landmark, a labelled field, a live count and labelled buttons", async () => {
  const { FindBar, FindButton, findInChatReleased } = await uiModule();
  const noop = () => {};
  const html = renderToStaticMarkup(
    createElement(FindBar, {
      barRef: { current: null },
      inputRef: { current: null },
      query: "ferry",
      setQuery: noop,
      matchCase: true,
      setMatchCase: noop,
      wholeWord: false,
      setWholeWord: noop,
      label: "3 of 12",
      total: 12,
      onMove: noop,
      onEnter: noop,
      onClose: noop,
    }),
  );
  assert.match(html, /role="search" aria-label="Find in this chat"/);
  assert.match(
    html,
    /<input[^>]*type="search"[^>]*aria-label="Find in this chat"[^>]*aria-describedby="[^"]+-count"/,
  );
  assert.match(html, /placeholder="Find in this chat"/);
  assert.match(html, /maxLength="200"|maxlength="200"/i);
  assert.match(
    html,
    /role="status" aria-live="polite" aria-atomic="true" data-i18n="off">3 of 12</,
  );
  assert.match(
    html,
    /aria-label="Match case" title="Match case" aria-pressed="true"/,
  );
  assert.match(
    html,
    /aria-label="Whole word" title="Whole word" aria-pressed="false"/,
  );
  assert.match(
    html,
    /aria-label="Previous match" title="Previous match \(Shift\+Enter\)"/,
  );
  assert.match(html, /aria-label="Next match" title="Next match \(Enter\)"/);
  assert.match(html, /aria-label="Close find" title="Close \(Esc\)"/);
  assert.doesNotMatch(html, /disabled/);
  const none = renderToStaticMarkup(
    createElement(FindBar, {
      barRef: { current: null },
      inputRef: { current: null },
      query: "zzz",
      setQuery: noop,
      matchCase: false,
      setMatchCase: noop,
      wholeWord: false,
      setWholeWord: noop,
      label: "No matches",
      total: 0,
      onMove: noop,
      onEnter: noop,
      onClose: noop,
    }),
  );
  assert.match(none, /class="find-count none"/);
  assert.equal(
    (none.match(/disabled=""/g) || []).length,
    2,
    "previous and next are disabled",
  );
  const button = renderToStaticMarkup(
    createElement(FindButton, { apple: true, open: false, onOpen: noop }),
  );
  assert.match(button, /aria-label="Find in this chat"/);
  assert.match(button, /aria-keyshortcuts="Meta\+F"/);
  assert.match(button, /title="Find in this chat \(⌘F\)"/);
  assert.match(button, /aria-expanded="false"/);
  assert.match(button, /<span>Find<\/span>/);
  assert.match(
    renderToStaticMarkup(
      createElement(FindButton, { apple: false, open: true, onOpen: noop }),
    ),
    /aria-keyshortcuts="Control\+F"[^>]*aria-expanded="true"[^>]*title="Find in this chat \(Ctrl F\)"/,
  );
  assert.equal(
    findInChatReleased({ releases: { features: { findinchat: true } } }),
    true,
  );
  assert.equal(
    findInChatReleased({ releases: { features: { findinchat: "true" } } }),
    false,
  );
  assert.equal(findInChatReleased(undefined), false);
});

// ---- Chinese ------------------------------------------------------------------

test("Chinese: the update, the bar's labels and the palette entry", () => {
  const entry = UPDATES.find((u) => u.id === "findinchat");
  const jsx = src("src/FindInChat.jsx");
  const ui = [
    "Find in this chat",
    "Find",
    "Match case",
    "Whole word",
    "Previous match",
    "Next match",
    "Previous match (Shift+Enter)",
    "Next match (Enter)",
    "Close find",
    "Close (Esc)",
  ];
  for (const s of ui) assert.ok(jsx.includes(s), `still used: ${s}`);
  const lines = [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Find in Chat is coming soon.",
    ...ui,
    "Find in this chat (⌘F)",
    "Find in this chat (Ctrl F)",
    "Searched in your browser",
  ];
  for (const line of lines) {
    const zh = translateText(line, dict);
    assert.ok(zh && han.test(zh), `zh: ${line} → ${zh}`);
    const leftover = (zh.match(/[A-Za-z]{4,}/g) || []).filter(
      (w) => !["Ctrl", "Shift", "Enter"].includes(w),
    );
    assert.deepEqual(leftover, [], `half-translated: ${line} → ${zh}`);
  }
  // The count is written in Chinese by find-in-chat.js itself, and kept away
  // from the page translator.
  assert.match(jsx, /className=\{"find-count"[\s\S]*?data-i18n="off"/);
});
