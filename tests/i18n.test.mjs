import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES } from "../server/releases.js";
import { isReleased } from "../src/lib.js";
import {
  compileDictionary,
  translateText,
  adjustSpacing,
  createSession,
  setLanguage,
  t,
} from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const dict = compileDictionary({
  strings: {
    "Log in": "登录",
    "Get started": "开始使用",
    "Image Studio": "图像工作室",
    "Good evening": "晚上好",
    "How": "工作",
    "works": "原理",
  },
  patterns: [
    { en: "{0} is coming soon.", zh: "{0}即将推出。" },
    { en: "{0} — ANONYMA", zh: "{0} — ANONYMA" },
    { en: "{0} credits", zh: "{0} 积分" },
    { en: "{0} credits available", zh: "{0} 积分可用" },
    { en: "{0} members", zh: "{0} 名成员" },
    { en: "Opens in {0}", zh: "在 {0} 中打开" },
  ],
});
// Stand-ins for DOM text nodes and elements: the session only touches
// nodeValue and get/setAttribute.
const text = (nodeValue) => ({ nodeValue, isConnected: true });
const values = (nodes) => nodes.map((n) => n.nodeValue);
function element(attrs) {
  const map = new Map(Object.entries(attrs));
  return {
    isConnected: true,
    getAttribute: (k) => (map.has(k) ? map.get(k) : null),
    setAttribute: (k, v) => map.set(k, String(v)),
  };
}

test("an exact string translates and keeps its surrounding whitespace", () => {
  assert.equal(translateText("Log in", dict), "登录");
  assert.equal(translateText("  Get started ", dict), "  开始使用 ");
  assert.equal(translateText("\n   Get\n     started\n", dict), "\n   开始使用\n");
});

test("patterns fill captures and translate nested dictionary strings", () => {
  assert.equal(translateText("Image Studio is coming soon.", dict), "图像工作室即将推出。");
  // A capture that is itself a pattern match.
  assert.equal(
    translateText("Image Studio is coming soon. — ANONYMA", dict),
    "图像工作室即将推出。 — ANONYMA",
  );
  // Numbers with separators and decimals, and the most literal pattern wins.
  assert.equal(translateText("1,234.5 credits", dict), "1,234.5 积分");
  assert.equal(translateText("1,234.5 credits available", dict), "1,234.5 积分可用");
  // A Chinese capture drops the template's space; a Latin one keeps it.
  assert.equal(translateText("Opens in Image Studio", dict), "在图像工作室中打开");
  assert.equal(translateText("Opens in Venice", dict), "在 Venice 中打开");
  // Separators around a known string.
  assert.equal(translateText(" · Get started", dict), " · 开始使用");
});

test("a string with no translation stays English", () => {
  assert.equal(translateText("Something new", dict), undefined);
  const nodes = [text("Something new")];
  const s = createSession(dict);
  s.translateRun(nodes);
  assert.deepEqual(values(nodes), ["Something new"]);
  assert.equal(s.live.size, 0);
});

test("switching back restores every original exactly, as often as needed", () => {
  const originals = ["Log in", " ", "Get started ", "\n  Image Studio is coming soon.\n", "42"];
  const nodes = originals.map(text);
  for (let i = 0; i < 3; i++) {
    const s = createSession(dict);
    s.translateRun([nodes[0]]);
    s.translateRun([nodes[2]]);
    s.translateRun([nodes[3]]);
    s.translateRun([nodes[4]]);
    assert.deepEqual(values(nodes), ["登录", " ", "开始使用 ", "\n  图像工作室即将推出。\n", "42"]);
    // Translating again is a no-op: its own output is never re-read as English.
    s.translateRun([nodes[0]]);
    assert.equal(nodes[0].nodeValue, "登录");
    s.restoreAll();
    assert.deepEqual(values(nodes), originals);
  }
});

test("React's later English replaces the record instead of being restored over", () => {
  const node = text("Log in");
  const s = createSession(dict);
  s.translateRun([node]);
  node.nodeValue = "Get started"; // React re-renders with new English
  s.translateRun([node]);
  assert.equal(node.nodeValue, "开始使用");
  node.nodeValue = "Signed in as ada"; // no translation
  s.translateRun([node]);
  s.restoreAll();
  assert.equal(node.nodeValue, "Signed in as ada");
});

test("consecutive text nodes translate as one string and restore apart", () => {
  const run = [text("3"), text(" member"), text("s")];
  const s = createSession(dict);
  s.translateRun(run);
  assert.deepEqual(values(run), ["3 名成员", "", ""]);
  run[0].nodeValue = "4"; // React updates only the count
  s.translateRun(run);
  assert.deepEqual(values(run), ["4 名成员", "", ""]);
  s.restoreAll();
  assert.deepEqual(values(run), ["4", " member", "s"]);
});

test("pieces the dictionary knows translate one by one when the whole isn't there", () => {
  const d = compileDictionary({ strings: { Export: "导出", account: "账户", data: "数据" } });
  const run = [text("Export "), text("account "), text("data")];
  const s = createSession(d);
  s.translateRun(run);
  assert.deepEqual(values(run), ["导出 ", "账户 ", "数据"]);
  // The spacing pass then closes the gaps between Chinese neighbours.
  s.space(run[0], "", "账");
  s.space(run[1], "出", "数");
  assert.deepEqual(values(run), ["导出", "账户", "数据"]);
  s.restoreAll();
  assert.deepEqual(values(run), ["Export ", "account ", "data"]);
});

test("lists inside a pattern join with 、 and keep names it doesn't know", () => {
  const d = compileDictionary({
    strings: { Chat: "对话", Account: "账户" },
    patterns: [{ en: "Enabled: {0}.", zh: "已启用：{0}。" }],
  });
  assert.equal(translateText("Enabled: Chat, Veil, Account.", d), "已启用：对话、Veil、账户。");
  // A comma outside a pattern is part of a sentence, not a list.
  assert.equal(translateText("Chat, Account", d), undefined);
});

test("the built-in and scoped special cases", () => {
  const d = compileDictionary({ strings: { Platform: "平台" } });
  assert.equal(translateText("The ANONYMA", d), "ANONYMA");
  const word = text("works");
  const s = createSession(d);
  s.translateRun([word], { fixed: new Map([["works", ""]]) });
  assert.equal(word.nodeValue, "");
  s.restoreAll();
  assert.equal(word.nodeValue, "works");
  // Nothing is translated for confirm() while the translator is off.
  assert.equal(t("Delete Team and its shared conversations?"), "Delete Team and its shared conversations?");
});

test("a heading split into words after it was translated comes back English", () => {
  const s = createSession(dict);
  const source = text("Image Studio is coming soon.");
  s.translateRun([source]);
  // anime's splitText copies the Chinese into new word nodes.
  const words = ["图像", "工作室", "即将", "推出。"].map(text);
  s.translateRun(words, { adoptable: true, whole: true });
  assert.deepEqual(values(words), ["图像工作室即将推出。", "", "", ""]);
  s.restoreAll();
  assert.equal(words.map((n) => n.nodeValue).join(""), "Image Studio is coming soon.");
});

test("spaces between Chinese neighbours go, and punctuation after Chinese is full-width", () => {
  assert.equal(adjustSpacing(" ", "作", "原"), "");
  assert.equal(adjustSpacing(" ", "a", "原"), " ");
  assert.equal(adjustSpacing(",", "好", ""), "，");
  assert.equal(adjustSpacing(".", "e", ""), ".");
  assert.equal(adjustSpacing("开始使用 ", "", "原"), "开始使用");
  // "How" " " "works": the space between the translated words is emptied
  // and comes back on the way out.
  const [a, gap, b] = [text("How"), text(" "), text("works")];
  const s = createSession(dict);
  s.translateRun([a]);
  s.translateRun([b]);
  s.space(gap, "作", "原");
  assert.deepEqual(values([a, gap, b]), ["工作", "", "原理"]);
  s.space(gap, "作", "原");
  s.restoreAll();
  assert.deepEqual(values([a, gap, b]), ["How", " ", "works"]);
});

test("attributes translate, stay English when kept, and restore", () => {
  const el = element({ "aria-label": "Get started", title: "Log in", alt: "A photo" });
  const s = createSession(dict);
  for (const name of ["aria-label", "title", "alt"]) s.translateAttr(el, name, name === "title");
  assert.equal(el.getAttribute("aria-label"), "开始使用");
  assert.equal(el.getAttribute("title"), "Log in");
  assert.equal(el.getAttribute("alt"), "A photo");
  s.restoreAll();
  assert.equal(el.getAttribute("aria-label"), "Get started");
});

test("the stub dictionary has the shape the runtime reads", () => {
  const raw = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
  const zh = compileDictionary(raw);
  assert.ok(zh.strings.size > 10);
  assert.ok(raw.patterns.every((p) => typeof p.en === "string" && typeof p.zh === "string"));
  assert.equal(translateText("Log in", zh), "登录");
});

test("the update is registered as off by default", () => {
  const entry = UPDATES.find((u) => u.id === "zh");
  assert.ok(entry, "zh is registered in UPDATES");
  // Committed as false until its "Release …" commit flips it to true.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "简体中文");
  assert.equal(entry.tagline, "The whole site in Simplified Chinese.");
  assert.deepEqual(entry.points, [
    "One switch between English and Chinese",
    "Every page, the workspace and your account",
    "Your chats stay exactly as written",
  ]);
});

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-i18n-"));
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
// LanguageSwitch.jsx compiled for Node with the same esbuild Vite uses; its
// imports point at the modules this test already loaded.
async function switchModule() {
  const src = new URL("../src/LanguageSwitch.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const out = code
    .replace(/^import "\.\/i18n\.css";$/m, "")
    .replace(/from "\.\/(lib|i18n)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${import.meta.resolve("react")}"`);
  const dir = mkdtempSync(join(tmpdir(), "anonyma-i18n-ui-"));
  const file = join(dir, "LanguageSwitch.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the switch renders only once the update is released", async (t) => {
  const { LanguageSwitch, LanguageSettings } = await switchModule();
  const render = (C, config) => renderToStaticMarkup(createElement(C, { config }));
  const mvp = (await request(fixture(t, "mvp").app).get("/api/config").expect(200)).body;
  assert.equal(mvp.releases.features.zh, false);
  assert.equal(isReleased(mvp, "zh"), false);
  assert.equal(render(LanguageSwitch, mvp), "");
  assert.equal(render(LanguageSettings, mvp), "");
  assert.equal(render(LanguageSwitch, null), "");
  // A stored choice doesn't matter while unreleased.
  setLanguage("zh");
  assert.equal(render(LanguageSwitch, mvp), "");
  setLanguage("en");

  const live = (await request(fixture(t, "mvp,zh").app).get("/api/config").expect(200)).body;
  assert.equal(isReleased(live, "zh"), true);
  const html = render(LanguageSwitch, live);
  assert.match(html, /data-i18n="off"/);
  assert.match(html, /aria-pressed="true"[^>]*>EN</);
  assert.match(html, /aria-pressed="false"[^>]*>中文</);
  assert.match(render(LanguageSettings, live), /Language\./);
});
