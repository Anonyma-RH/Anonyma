import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { isReleased } from "../src/lib.js";
import {
  DEFAULT_SIZE,
  DEFAULT_TEMPLATE,
  MARK_RATIO,
  MARK_URL,
  MAX_CARD_TEXT,
  SANS,
  SERIF,
  SIZES,
  TEMPLATES,
  cardFileName,
  cleanCardText,
  cleanPrefs,
  clampLine,
  creditLine,
  fitText,
  flow,
  layoutCard,
  plainFromMarkdown,
  shownCardText,
  tokenize,
  veiledTags,
  wrapParagraph,
} from "../src/quote-cards.js";
import { cardBlob, drawCard } from "../src/quote-card-render.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/.*$/gm, "$1");

// A stand-in for canvas text measuring: every character is half its size
// wide, and a Chinese character is a whole size wide.
const CJK = /[㐀-鿿＀-￯　-〿]/;
const measure = (s, px) => Array.from(String(s)).reduce((n, c) => n + (CJK.test(c) ? px : px * 0.5), 0);
const lineWidth = (l, size) => measure(l.text, size) + (l.indent || 0);

// ---- the update and its gate -------------------------------------------------

test("Quote Cards is registered once, unreleased, with a browser-only gate and no server route", () => {
  const entries = UPDATES.filter((u) => u.id === "quotecards");
  assert.equal(entries.length, 1);
  const [update] = entries;
  assert.equal(update.title, "Quote Cards");
  assert.equal(update.tagline, "Turn a great answer into a clean image card to share. Made on your device; no link back to your chat.");
  assert.equal(update.points.length, 3);
  // The committed flag flips at release, so only its type is pinned here.
  assert.equal(typeof committed[UPDATES.indexOf(update)], "boolean", "registered release flag");
  // Nothing on the server can reach it: no route, so nothing to gate, and
  // no request ever needs another update to be live for it.
  for (const [method, path] of [
    ["GET", "/api/quotecards"],
    ["POST", "/api/quotecards"],
    ["POST", "/api/quote-cards"],
    ["GET", "/brand/official/ionic-transparent.png"],
    ["POST", "/api/chat"],
  ])
    assert.ok(!featuresFor({ path, method, body: { messages: [] } }).includes("quotecards"), `${method} ${path}`);
  const serverSources = readdirSyncDeep("server").filter((f) => /\.js$/.test(f));
  const naming = serverSources.filter((f) => /quotecards|quote-cards/i.test(strip(read(f))) && !f.endsWith("releases.js"));
  assert.deepEqual(naming, [], "no server file but the release list knows about Quote Cards");
  assert.ok(existsSync(new URL("../public" + MARK_URL, import.meta.url)), "the Ionic mark the cards use is a shipped file");
});
function readdirSyncDeep(dir) {
  return readdirSync(new URL("../" + dir, import.meta.url), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? readdirSyncDeep(dir + "/" + e.name) : [dir + "/" + e.name],
  );
}

test("the app reports it off until released, and there is still no API for it", async (t) => {
  for (const [released, expected] of [
    ["mvp", false],
    ["mvp,highlight", false],
    ["mvp,quotecards", true],
    ["all", true],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "anonyma-quotecards-"));
    const svc = createApp({
      testMode: true,
      released,
      origin: "http://localhost:5175",
      dbPath: join(dir, "db.sqlite"),
      mediaPath: join(dir, "media"),
      catalogPath: join(dir, "models.json"),
    });
    t.after(() => {
      svc.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const cfg = (await request(svc.app).get("/api/config").expect(200)).body;
    assert.equal(cfg.releases.features.quotecards, expected, released);
    assert.equal(isReleased(cfg, "quotecards"), expected, released);
    const entry = cfg.releases.updates.find((u) => u.id === "quotecards");
    assert.equal(entry.released, expected);
    assert.equal(entry.title, "Quote Cards");
    await request(svc.app).post("/api/quotecards").send({ text: "x" }).expect(404);
    // A chat is an ordinary chat: nothing about cards is asked of the server.
    assert.deepEqual(featuresFor({ path: "/api/chat", method: "POST", body: { messages: [] } }), []);
  }
});

test("the client gate: no button, no toolbar action and no dialog before release", async () => {
  const workspace = read("src/Workspace.jsx");
  assert.match(workspace, /const cardsLive = isReleased\(config, "quotecards"\) && textMode;/);
  // The Card button on a reply, the toolbar's action and the dialog all hang on it.
  assert.match(workspace, /const cardButton = \(m, i\) =>\s*cardsLive &&\s*m\.role === "assistant"/);
  assert.match(workspace, /onCard=\{cardsLive \? setCard : null\}/);
  assert.match(workspace, /\{card && cardsLive && \(\s*<Suspense fallback=\{null\}>\s*<QuoteCardDialog/);
  assert.match(workspace, /const QuoteCardDialog = lazy\(\(\) => import\("\.\/QuoteCards\.jsx"\)\);/);
  // The model's name only rides on a reply once cards are live.
  assert.match(workspace, /data-highlight-model=\{\s*cardsLive && highlightLive && m\.role === "assistant" && m\.model \? m\.model : undefined/);
  // The reply's button skips replies still streaming, blind panes, checks and research in progress.
  for (const guard of ["!m.blind", "!m.factcheck", "!m.research?.live", "!(busy && i === messages.length - 1)"])
    assert.ok(workspace.includes(guard), guard);
  const symposium = read("src/Symposium.jsx");
  assert.match(symposium, /const cardsLive = highlightLive && isReleased\(config, "quotecards"\);/);
  assert.match(symposium, /onCard=\{cardsLive \? setCard : null\}/);
  // Shared and public views never had Highlight & Ask, so they can't make cards.
  for (const f of ["SharedChat.jsx", "Pages.jsx"]) assert.ok(!/QuoteCard|onCard/.test(read("src/" + f).replace(/quotecards: "quotemark"/, "")), f);
  // The toolbar draws a Card action only when it's handed one.
  const ui = await highlightModule();
  const off = renderToStaticMarkup(createElement(ui.HighlightToolbar, { root: { current: null }, onCard: () => {} }));
  assert.equal(off, "", "nothing is drawn until there's a selection");
  assert.match(read("src/HighlightAsk.jsx"), /\{onCard && \(\s*<button\s+type="button"\s+className="hl-card"/);
  // Its icon is on the roadmap card.
  assert.match(read("src/Pages.jsx"), /quotecards: "quotemark"/);
});

async function highlightModule() {
  const src = new URL("../src/HighlightAsk.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-quotecards-hl-"));
  const react = import.meta.resolve("react");
  const reactDom = import.meta.resolve("react-dom");
  writeFileSync(join(dir, "ui.mjs"), `import React from "${react}";\nexport const Icon = ({ name }) => React.createElement("i", { "data-icon": name });\n`);
  const here = (f) => new URL("../src/" + f, import.meta.url).href;
  const out = code
    .replace(/^import "\.\/highlight-ask\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${pathToFileURL(join(dir, "ui.mjs")).href}"`)
    .replace(/from "\.\/(lib|estimate|deep-research|i18n|highlight-ask)\.js"/g, (_, f) => `from "${here(f + ".js")}"`)
    .replace(/from "react-dom"/g, `from "${reactDom}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "HighlightAsk.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- text fitting and wrapping -----------------------------------------------

test("wrapping breaks at spaces, keeps every word, and never runs past the width", () => {
  const text = "Prepaid credits bill you only for the thinking you actually did, and nothing else at all.";
  for (const width of [120, 200, 340, 900]) {
    const lines = wrapParagraph(text, width, (s) => measure(s, 20));
    assert.ok(lines.length >= 1);
    for (const l of lines) assert.ok(measure(l.text, 20) <= width + 0.001, `${width}: ${l.text}`);
    assert.equal(lines.map((l) => l.text).join(" "), text, "no word lost or split");
  }
  assert.deepEqual(wrapParagraph("", 100, (s) => measure(s, 20)), []);
  assert.equal(wrapParagraph("one two", 10000, (s) => measure(s, 20))[0].text, "one two");
});

test("a word wider than the line is broken by letter, a bullet hangs, and Chinese breaks between characters", () => {
  const long = "https://example.com/" + "a".repeat(80);
  const lines = wrapParagraph(long, 200, (s) => measure(s, 20));
  assert.ok(lines.length > 1);
  assert.equal(lines.map((l) => l.text).join(""), long);
  for (const l of lines) assert.ok(measure(l.text, 20) <= 200);
  const bullet = wrapParagraph("• " + "word ".repeat(30).trim(), 300, (s) => measure(s, 20));
  assert.equal(bullet[0].indent, 0);
  assert.ok(bullet.slice(1).every((l) => l.indent === measure("• ", 20)), "continuation lines hang under the text");
  const zh = "隐私不是一个开关，而是没有人保留副本之后剩下的东西。";
  const zhLines = wrapParagraph(zh, 200, (s) => measure(s, 20));
  assert.ok(zhLines.length > 1);
  assert.equal(zhLines.map((l) => l.text).join(""), zh);
  for (const l of zhLines) {
    assert.ok(measure(l.text, 20) <= 200, l.text);
    assert.ok(!/^[，。、！？；：）」]/.test(l.text), "a closing mark never starts a line: " + l.text);
  }
  assert.deepEqual(tokenize("你好，世界").map((t) => t.t), ["你", "好，", "世", "界"]);
});

test("the text is fitted to the biggest size that fits, and shrinks as it grows", () => {
  const box = { width: 874, height: 600 };
  const opts = { measure, minSize: 37, maxSize: 92 };
  const short = fitText("Hello.", box, opts);
  assert.equal(short.size, 92);
  assert.equal(short.truncated, false);
  const medium = fitText("Prepaid credits bill you only for the thinking you actually did. ".repeat(3), box, opts);
  const bigger = fitText("Prepaid credits bill you only for the thinking you actually did. ".repeat(6), box, opts);
  assert.ok(medium.size < 92 && medium.size > 37, String(medium.size));
  assert.ok(bigger.size <= medium.size);
  for (const f of [short, medium, bigger]) {
    assert.ok(f.height <= box.height, `fits: ${f.height}`);
    assert.equal(f.truncated, false);
  }
  // One size up would not have fitted.
  const above = flow("Prepaid credits bill you only for the thinking you actually did. ".repeat(3), box.width, medium.size + 2, measure);
  assert.ok(above.height > box.height, "the size is the largest that fits");
  // A long address is set smaller rather than broken in two.
  const address = fitText("Please email jane.doe@example.com about the launch.", box, opts);
  assert.ok(address.lines.some((l) => l.text.includes("jane.doe@example.com")), address.lines.map((l) => l.text).join("|"));
  assert.equal(address.split, false);
  // Sizes are whole pixels in steps.
  assert.equal(medium.size % 2, 1, "37 + 2n");
  // Blank lines make a paragraph gap, extra blank lines don't add more.
  const gap = flow("One\n\n\n\nTwo", 500, 40, measure);
  const tight = flow("One\nTwo", 500, 40, measure);
  assert.equal(gap.lines.length, 2);
  assert.ok(gap.height > tight.height);
  assert.deepEqual(flow("   \n \n", 500, 40, measure).lines, []);
});

test("text that can't fit even at the smallest size is cut at a word with an ellipsis, and says so", () => {
  const box = { width: 874, height: 500 };
  const text = "Every model has a price and the price is public and you see the most a message can cost before you send it. ".repeat(20);
  const fit = fitText(text, box, { measure, minSize: 37, maxSize: 92 });
  assert.equal(fit.truncated, true);
  assert.equal(fit.size, 37);
  assert.ok(fit.text.endsWith("…"));
  assert.ok(fit.shown > 0 && fit.shown < fit.total);
  assert.equal(fit.total, Array.from(text).length);
  assert.ok(fit.height <= box.height);
  assert.ok(text.startsWith(fit.text.slice(0, -1)), "what's shown is the start of the text");
  assert.ok(!/[\s,;:]…$/.test(fit.text), "no dangling comma or space before the ellipsis");
  // Cut at a word: the next character of the source is a space (or the cut is at the end of a word).
  const kept = fit.text.slice(0, -1);
  assert.ok(/\s/.test(text[kept.length]) || text[kept.length - 1] === " " || /\w$/.test(kept));
  // Chinese is cut by character.
  const zh = fitText("这是一个很长的句子。".repeat(200), box, { measure, minSize: 37, maxSize: 92 });
  assert.equal(zh.truncated, true);
  assert.ok(zh.text.endsWith("…"));
  // A one-line clamp (the credit line).
  assert.equal(clampLine("Asked on ANONYMA", 10000, (s) => measure(s, 20)), "Asked on ANONYMA");
  const clamped = clampLine("Asked on ANONYMA · A very long model name indeed", 300, (s) => measure(s, 20));
  assert.ok(clamped.endsWith("…") && measure(clamped, 20) <= 300);
  assert.equal(clampLine("Anything", 1, (s) => measure(s, 20)), "");
});

test("Markdown becomes the plain words a reader sees", () => {
  const md = [
    "# Why prepaid",
    "",
    "A **subscription** bills you _monthly_; see [the pricing page](https://example.com/pricing) or `credits`.",
    "",
    "- first point",
    "- second point",
    "",
    "1. one",
    "2) two",
    "",
    "> quoted line",
    "",
    "| Plan | Cost |",
    "|------|------|",
    "| Prepaid | Pay as you go |",
    "",
    "```mermaid",
    "graph TD",
    "A-->B",
    "```",
    "",
    "```js",
    "const answer = 42;",
    "```",
    "",
    "![a chart](https://example.com/x.png) and snake_case_word and 5 * 3 * 2 stay.",
    "Email [EMAIL_1] stays as a tag.",
  ].join("\n");
  const out = plainFromMarkdown(md);
  assert.match(out, /^Why prepaid\n\nA subscription bills you monthly; see the pricing page or credits\./);
  assert.match(out, /• first point\n• second point/);
  assert.match(out, /1\. one\n2\. two/);
  assert.match(out, /quoted line/);
  assert.match(out, /Plan · Cost\nPrepaid · Pay as you go/);
  assert.ok(!/graph TD|A-->B/.test(out), "a diagram's source isn't a quote");
  assert.match(out, /const answer = 42;/);
  assert.ok(!/```|\*\*|https?:\/\/|\|---/.test(out), out);
  assert.match(out, /a chart and snake_case_word and 5 \* 3 \* 2 stay\./);
  assert.match(out, /Email \[EMAIL_1\] stays as a tag\./);
  assert.equal(plainFromMarkdown(null), "");
  // Invisible characters that could hide text are gone, and the editor's limit holds.
  assert.equal(cleanCardText("a​b‮c"), "abc");
  assert.equal(cleanCardText("x".repeat(MAX_CARD_TEXT + 500)).length, MAX_CARD_TEXT);
});

// ---- the templates and sizes -------------------------------------------------

test("three sizes and four templates, in the house palette", () => {
  assert.deepEqual(
    SIZES.map((s) => [s.label, s.width, s.height]),
    [["1:1", 1080, 1080], ["4:5", 1080, 1350], ["16:9", 1920, 1080]],
  );
  assert.deepEqual(TEMPLATES.map((t) => t.name), ["Cobalt", "White", "Dark", "Column"]);
  assert.equal(new Set(TEMPLATES.map((t) => t.id)).size, 4);
  const palette = new Set(["#0135df", "#ffb21c", "#0e1a3a", "#ffffff", "#f5f8ff", "#d5def0", "#4f5b73", "rgba(255,255,255,0.78)", "rgba(255,255,255,0.72)"]);
  for (const t of TEMPLATES)
    for (const key of ["bg", "ink", "accent", "quiet", "edge", "band"])
      if (t[key]) assert.ok(palette.has(t[key]), `${t.id}.${key} ${t[key]}`);
  assert.equal(TEMPLATES.filter((t) => t.column).length, 1, "one column card");
  assert.equal(TEMPLATES.find((t) => t.column).id, "column");
  // The site's own fonts.
  assert.match(SERIF, /^"GFS Didot"/);
  assert.match(SANS, /^"GFS Neohellenic"/);
  const css = read("src/styles.css");
  assert.ok(css.includes(`--serif: ${SERIF};`), "the same serif stack as the site");
  assert.ok(css.includes(`--font: ${SANS},`.replace(/,$/, ";")) || css.includes(`--font: ${SANS};`), "the same sans stack as the site");
});

test("every template at every size lays its text, credit and mark inside the card without overlap", () => {
  const text = "A subscription bills you for the month whether you think or not. Prepaid credits bill you only for the thinking you actually did.";
  const credit = "Asked on ANONYMA · Claude Sonnet";
  for (const tpl of TEMPLATES)
    for (const size of SIZES) {
      const label = `${tpl.id} ${size.id}`;
      const L = layoutCard({ template: tpl.id, size: size.id, text, credit, measure });
      assert.equal(L.width, size.width, label);
      assert.equal(L.height, size.height, label);
      assert.equal(L.template.id, tpl.id);
      // The text box sits inside the padding, clear of the opening mark.
      assert.ok(L.box.x >= L.pad && L.box.x + L.box.width <= L.width - L.pad + 1, `${label} box x`);
      assert.ok(L.box.y >= L.glyph.y + L.glyph.h && L.box.y + L.box.height <= L.height - L.pad, `${label} box y`);
      assert.ok(L.text.lines.length >= 1);
      for (const line of L.text.lines) {
        assert.ok(line.x >= L.box.x - 0.001, `${label} left`);
        assert.ok(line.x + measure(line.text, L.text.size) <= L.box.x + L.box.width + 0.001, `${label} right: ${line.text}`);
        assert.ok(line.y >= L.box.y - 0.001 && line.y + line.h <= L.box.y + L.box.height + 0.001, `${label} vertical`);
      }
      // The credit is below the text and the hairline, the mark at the right.
      assert.ok(L.footer.credit, `${label} credit`);
      assert.ok(L.footer.credit.y > L.box.y + L.box.height, `${label} credit under text`);
      assert.ok(L.footer.ruleY > L.box.y + L.box.height && L.footer.ruleY < L.footer.credit.y, `${label} rule`);
      assert.ok(L.footer.credit.y < L.height - L.pad + 1);
      if (tpl.column) {
        assert.equal(L.footer.mark, null, "the column's capital is the mark");
        assert.ok(L.column.x + L.column.w < L.box.x, `${label} column clear of the text`);
        assert.ok(L.column.x >= 0 && L.column.y >= 0 && L.column.y + L.column.h <= L.height, `${label} column inside`);
        assert.ok(L.column.capital.w > L.column.w, "the capital overhangs the shaft");
        assert.ok(Math.abs(L.column.capital.h / L.column.capital.w - MARK_RATIO) < 0.01);
      } else {
        assert.equal(L.column, null);
        const m = L.footer.mark;
        assert.ok(m.x + m.w <= L.width - L.pad + 1 && m.y + m.h <= L.height, `${label} mark inside`);
        assert.ok(Math.abs(m.h / m.w - MARK_RATIO) < 0.01, "the mark keeps its proportions");
        assert.ok(L.footer.credit.x + measure(L.footer.credit.text, L.footer.credit.size) <= m.x, `${label} credit clear of the mark`);
      }
      assert.equal(L.band !== null, !!tpl.band, `${label} band`);
      assert.equal(L.text.truncated, false);
    }
  // Short text is set large, long text small: never outside its bounds.
  const big = layoutCard({ template: "cobalt", size: "square", text: "Hi.", measure });
  const small = layoutCard({ template: "cobalt", size: "square", text: text.repeat(5), measure });
  assert.ok(big.text.size > small.text.size);
  // No credit, no line; a long credit is clamped clear of the mark.
  assert.equal(layoutCard({ template: "dark", size: "wide", text, credit: "", measure }).footer.credit, null);
  const clamped = layoutCard({ template: "dark", size: "square", text, credit: "Asked on ANONYMA · " + "Model ".repeat(30), measure });
  assert.ok(clamped.footer.credit.text.endsWith("…"));
  assert.throws(() => layoutCard({ template: "nope", size: "square", text, measure }), /Unknown card template or size/);
  assert.throws(() => layoutCard({ template: "cobalt", size: "huge", text, measure }), /Unknown card template or size/);
});

test("the lines under the quote follow the two toggles, and the model name is the reply's own", () => {
  assert.equal(creditLine({ asked: true, model: true, modelName: "Claude Sonnet" }), "Asked on ANONYMA · Claude Sonnet");
  assert.equal(creditLine({ asked: true, model: false, modelName: "Claude Sonnet" }), "Asked on ANONYMA");
  assert.equal(creditLine({ asked: false, model: true, modelName: "Claude Sonnet" }), "Claude Sonnet");
  assert.equal(creditLine({ asked: false, model: false, modelName: "Claude Sonnet" }), "");
  // Without a known model the second part just isn't there.
  assert.equal(creditLine({ asked: true, model: true, modelName: "" }), "Asked on ANONYMA");
  assert.equal(creditLine({ asked: true, model: true, brand: "在 ANONYMA 上提问", modelName: " GLM  5.2 " }), "在 ANONYMA 上提问 · GLM 5.2");
  assert.equal(cardFileName("wide"), "anonyma-quote-card-16x9.png");
  assert.equal(cardFileName("nope"), "anonyma-quote-card-1x1.png");
  // The file name never carries anything typed: only the size.
  assert.ok(!/[a-z]+ [a-z]+/i.test(cardFileName("portrait")));
});

// ---- Veil ---------------------------------------------------------------------

test("Veil placeholders stay masked on the card unless the person reveals them", () => {
  const map = { EMAIL_1: "jane.doe@example.com", PHONE_2: "+1 555 0100" };
  const text = "Write to [EMAIL_1] or call [PHONE_2]. [KEY_9] is unknown here, and [email_1] isn't a tag.";
  // The default is masked, whatever map the browser holds.
  assert.equal(shownCardText(text), text);
  assert.equal(shownCardText(text, { map }), text);
  assert.equal(shownCardText(text, { reveal: false, map }), text);
  assert.ok(!shownCardText(text, { map }).includes("jane.doe"));
  // Only on a deliberate reveal do real values appear, and only the ones the map has.
  const shown = shownCardText(text, { reveal: true, map });
  assert.equal(shown, "Write to jane.doe@example.com or call +1 555 0100. [KEY_9] is unknown here, and [email_1] isn't a tag.");
  assert.equal(shownCardText(text, { reveal: true, map: null }), text);
  assert.deepEqual(veiledTags(text, map), ["EMAIL_1", "PHONE_2"]);
  assert.deepEqual(veiledTags(text, {}), []);
  assert.deepEqual(veiledTags(text, null), []);
  assert.deepEqual(veiledTags("[EMAIL_1] [EMAIL_1]", map), ["EMAIL_1"]);
  // The layout is given the masked text unless revealed: what's drawn is what's passed.
  const masked = layoutCard({ template: "white", size: "square", text: shownCardText(text, { map }), measure });
  assert.ok(masked.text.lines.map((l) => l.text).join(" ").includes("[EMAIL_1]"));
  // Prototype keys are never "values".
  assert.deepEqual(veiledTags("[CONSTRUCTOR_1] [TOSTRING_1]", {}), []);
  assert.equal(shownCardText("[TOSTRING_1]", { reveal: true, map: {} }), "[TOSTRING_1]");
});

test("what's remembered in the browser is choices only, never text", () => {
  assert.deepEqual(cleanPrefs(null), { template: DEFAULT_TEMPLATE, size: DEFAULT_SIZE, asked: true, model: true });
  assert.deepEqual(cleanPrefs({ template: "dark", size: "wide", asked: false, model: false, text: "secret" }), {
    template: "dark",
    size: "wide",
    asked: false,
    model: false,
  });
  assert.deepEqual(cleanPrefs({ template: "nope", size: 9 }), { template: DEFAULT_TEMPLATE, size: DEFAULT_SIZE, asked: true, model: true });
  const dialog = strip(read("src/QuoteCards.jsx"));
  assert.match(dialog, /saveStore\(PREFS_KEY, next\)/);
  assert.equal((dialog.match(/saveStore\(/g) || []).length, 1, "one thing is saved: the choices");
  assert.ok(!/localStorage|sessionStorage|indexedDB/.test(dialog));
  // The "Reveal" choice is never saved: each card starts masked.
  assert.match(dialog, /const \[reveal, setReveal\] = useState\(false\);/);
  assert.ok(!/reveal[^;\n]*saveStore|saveStore[^;\n]*reveal/i.test(dialog));
});

// ---- drawing and the PNG ------------------------------------------------------

function fakeCanvas() {
  const calls = [];
  const ctx = {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 0,
    globalAlpha: 1,
    font: "",
    textBaseline: "",
    textAlign: "",
    clearRect: (...a) => calls.push(["clearRect", ...a]),
    fillRect: (...a) => calls.push(["fillRect", ...a]),
    strokeRect: (...a) => calls.push(["strokeRect", ...a]),
    drawImage: (...a) => calls.push(["drawImage", ...a.slice(1)]),
    fillText(s, x, y) {
      calls.push(["fillText", s, x, y, this.font, this.fillStyle]);
    },
    measureText: (s) => ({ width: s.length * 10, actualBoundingBoxAscent: 30 }),
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ctx,
    // A stand-in PNG: the signature and an IHDR chunk with this canvas's size.
    toBlob(cb, type) {
      const b = Buffer.alloc(33);
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
      b.writeUInt32BE(13, 8);
      b.write("IHDR", 12);
      b.writeUInt32BE(canvas.width, 16);
      b.writeUInt32BE(canvas.height, 20);
      cb(new Blob([b], { type }));
    },
  };
  return { canvas, ctx, calls };
}

test("drawing sets the canvas to the export size and draws exactly the laid-out text", async () => {
  const mark = { fake: "image" };
  for (const size of SIZES)
    for (const tpl of TEMPLATES) {
      const layout = layoutCard({ template: tpl.id, size: size.id, text: "One line of a quote.", credit: "Asked on ANONYMA", measure });
      const { canvas, calls } = fakeCanvas();
      drawCard(canvas, layout, mark);
      assert.equal(canvas.width, size.width);
      assert.equal(canvas.height, size.height);
      const drawn = calls.filter((c) => c[0] === "fillText").map((c) => c[1]);
      assert.deepEqual(drawn, ["“", ...layout.text.lines.map((l) => l.text), "Asked on ANONYMA"]);
      // The background is the whole card, first.
      assert.deepEqual(calls.find((c) => c[0] === "fillRect").slice(1), [0, 0, size.width, size.height]);
      // The Ionic mark is drawn once (footer, or the column's capital).
      assert.equal(calls.filter((c) => c[0] === "drawImage").length, 1, `${tpl.id} ${size.id}`);
      // The quote is set in the site's serif at the fitted size, in the template's ink.
      const quote = calls.find((c) => c[0] === "fillText" && c[1] === layout.text.lines[0].text);
      assert.equal(quote[4], `400 ${layout.text.size}px ${SERIF}`);
      assert.equal(quote[5], tpl.ink);
      const credit = calls.find((c) => c[0] === "fillText" && c[1] === "Asked on ANONYMA");
      assert.equal(credit[4], `700 ${layout.footer.credit.size}px ${SANS}`);
    }
  // Without the mark (it failed to load) a card is still made.
  const layout = layoutCard({ template: "cobalt", size: "square", text: "Hello", measure });
  const { canvas, calls } = fakeCanvas();
  drawCard(canvas, layout, null);
  assert.equal(calls.filter((c) => c[0] === "drawImage").length, 0);
  // The PNG comes from the canvas at its own size: nothing rescales it.
  const wide = layoutCard({ template: "dark", size: "wide", text: "Hello", measure });
  const made = fakeCanvas();
  drawCard(made.canvas, wide, null);
  const blob = await cardBlob(made.canvas);
  assert.equal(blob.type, "image/png");
  const bytes = Buffer.from(await blob.arrayBuffer());
  assert.equal(bytes.readUInt32BE(16), 1920);
  assert.equal(bytes.readUInt32BE(20), 1080);
  await assert.rejects(cardBlob({ toBlob: (cb) => cb(null) }), /couldn't be made/);
});

test("nothing is uploaded: no request of any kind in the card's code, and none when it runs", async () => {
  for (const f of ["src/quote-cards.js", "src/quote-card-render.js", "src/QuoteCards.jsx"]) {
    const src = strip(read(f));
    assert.ok(!/\bfetch\s*\(/.test(src), `${f} fetch`);
    assert.ok(!/XMLHttpRequest|sendBeacon|WebSocket|EventSource|navigator\.share|streamChat|\bapi\(/.test(src), `${f} network`);
    assert.ok(!/from "\.\/lib\.js"/.test(src) || f.endsWith("QuoteCards.jsx"), `${f} imports`);
    assert.ok(!/(https?:)?\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(src.replace(/\/\/www\.w3\.org[^"']*/g, "")), `${f} no outside address`);
  }
  // The dialog reaches the server for nothing: the only things it imports from
  // the app are the storage helpers, the language and Seed Guard's scanner.
  const dialog = strip(read("src/QuoteCards.jsx"));
  assert.match(dialog, /import \{ readStore, saveStore \} from "\.\/lib\.js";/);
  // The only file the renderer loads is the site's own mark, as an image.
  const render = strip(read("src/quote-card-render.js"));
  assert.match(render, /img\.src = MARK_URL;/);
  assert.equal(MARK_URL, "/brand/official/ionic-transparent.png");
  // Run it all with every way out of the page stubbed to fail.
  const saved = { fetch: globalThis.fetch, XHR: globalThis.XMLHttpRequest, beacon: globalThis.navigator?.sendBeacon };
  const attempts = [];
  globalThis.fetch = (...a) => {
    attempts.push(["fetch", ...a]);
    throw Error("no network");
  };
  try {
    const layout = layoutCard({ template: "column", size: "portrait", text: "Anything at all. [EMAIL_1]", credit: "Asked on ANONYMA · Model", measure });
    const { canvas } = fakeCanvas();
    drawCard(canvas, layout, {});
    await cardBlob(canvas);
    plainFromMarkdown("# A [link](https://example.com/x)");
  } finally {
    globalThis.fetch = saved.fetch;
  }
  assert.deepEqual(attempts, []);
  // No share link and no address on the card: the credit line is words only.
  assert.ok(!/https?:|www\.|\.com|askanonyma/i.test(creditLine({ asked: true, model: true, modelName: "Claude Sonnet" })));
  const html = read("index.html");
  assert.ok(html.length > 0);
});

// ---- the dialog ---------------------------------------------------------------

async function dialogModule() {
  const src = new URL("../src/QuoteCards.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-quotecards-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Icon = ({ name }) => React.createElement("i", { "data-icon": name });
export const Button = ({ children, secondary, ...p }) => React.createElement("button", { ...p, className: "button" + (secondary ? " secondary" : "") }, children);
export const Modal = ({ title, children }) => React.createElement("dialog", { "aria-label": title }, children);`,
  );
  const renderStub = stub(
    "render.mjs",
    `export const cardBlob = async () => null; export const copyImage = async () => {}; export const drawCard = () => {};
export const layoutOnDevice = () => ({}); export const loadCardFonts = async () => {}; export const loadMark = async () => null; export const saveBlob = () => {};`,
  );
  const here = (f) => new URL("../src/" + f, import.meta.url).href;
  const out = code
    .replace(/^import "\.\/quote-cards\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/quote-card-render\.js"/g, `from "${renderStub}"`)
    .replace(/from "\.\/(lib|i18n|seed-guard|quote-cards)\.js"/g, (_, f) => `from "${here(f + ".js")}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "QuoteCards.mjs");
  writeFileSync(file, out);
  try {
    return (await import(pathToFileURL(file).href)).default;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the dialog opens masked, offers Veil's real values only when there are some, and warns about seed phrases", async () => {
  const Dialog = await dialogModule();
  const render = (props) => renderToStaticMarkup(createElement(Dialog, { onClose() {}, ...props }));
  // A selection with two masked details and this browser's map for them.
  const html = render({
    source: { text: "Mail [EMAIL_1] and [PHONE_1] about the launch." },
    modelName: "Claude Sonnet",
    veilMap: { EMAIL_1: "jane.doe@example.com", PHONE_1: "+1 555 0100" },
  });
  assert.match(html, /aria-label="Quote card"/);
  // The text box holds the masked text; the real values are nowhere in the markup.
  assert.match(html, /<textarea[^>]*data-i18n="off"[^>]*>Mail \[EMAIL_1\] and \[PHONE_1\] about the launch\.<\/textarea>/);
  assert.ok(!html.includes("jane.doe") && !html.includes("555 0100"));
  assert.match(html, /Show the real details Veil masked/);
  assert.match(html, /2 masked details stay as tags like \[EMAIL_1\] unless you tick this\./);
  assert.ok(!/<input[^>]*checked=""[^>]*\/>\s*<span>\s*Show the real details/.test(html), "unticked");
  assert.ok(!/quote-card-alert/.test(html), "no warning until it's ticked");
  // Both credit lines are on, and the model's name is shown.
  assert.match(html, /<input type="checkbox" checked=""\/><span>Asked on ANONYMA<\/span>/);
  assert.match(html, /<small data-i18n="off">Claude Sonnet<\/small>/);
  // Four templates, three sizes, the export buttons and the honest line.
  for (const name of ["Cobalt", "White", "Dark", "Column"]) assert.ok(html.includes(`<span>${name}</span>`), name);
  for (const label of ["1:1", "4:5", "16:9"]) assert.ok(html.includes(label), label);
  assert.match(html, /Save PNG/);
  assert.match(html, /Copy image/);
  assert.match(html, /Made on this device\. Nothing is uploaded, and the image has no link back to your chat\./);
  // A default of cobalt and a square card, until something else is chosen.
  assert.match(html, /data-template="cobalt"/);
  assert.match(html, /data-size="square"/);
  // No masked details: no Veil choice at all. No model: its line is off and says why.
  const plain = render({ source: { markdown: "# Title\n\nSome **bold** words." }, veilMap: {} });
  assert.ok(!/Show the real details Veil masked/.test(plain));
  assert.match(plain, />Title\n\nSome bold words\.<\/textarea>/);
  assert.match(plain, /Not known for this text/);
  assert.match(plain, /<input type="checkbox" disabled=""\/>/);
  // Seed Guard, when it's live, warns about a seed phrase, and never repeats it.
  const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const warned = render({ source: { text: phrase }, seedGuard: true });
  assert.match(warned, /role="alert"[^>]*>.*This text looks like a wallet seed phrase or key\./);
  assert.equal((warned.match(/abandon/g) || []).length, 11, "only the text box holds it");
  assert.ok(!/looks like a wallet seed phrase/.test(render({ source: { text: phrase }, seedGuard: false })));
  assert.ok(!/looks like a wallet seed phrase/.test(render({ source: { text: "A normal sentence." }, seedGuard: true })));
});

// ---- Chinese ------------------------------------------------------------------

test("every visible string has a Chinese entry, including the release copy", () => {
  const dict = compileDictionary(JSON.parse(read("src/i18n/zh.json")));
  const entry = UPDATES.find((u) => u.id === "quotecards");
  const strings = [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Quote card",
    "Card",
    "Card preview",
    "Template",
    "Cobalt",
    "White",
    "Dark",
    "Column",
    "Size",
    "Card text",
    "Too long for one card. The first 639 characters fit; the rest is left off.",
    "Lines under the quote",
    "Asked on ANONYMA",
    "The model's name",
    "Not known for this text",
    "Show the real details Veil masked",
    "1 masked detail stays as a tag like [EMAIL_1] unless you tick this.",
    "3 masked details stay as tags like [EMAIL_1] unless you tick this.",
    "Untick this to mask them again.",
    "The card now shows the real details. Anyone you send the image to will be able to read them.",
    "This text looks like a wallet seed phrase or key. The card would show it to anyone you send the image to.",
    "Save PNG",
    "Copy image",
    "Saved as a PNG.",
    "The image couldn't be made.",
    "Copied the image.",
    "This browser can't copy an image. Use Save PNG.",
    "Made on this device. Nothing is uploaded, and the image has no link back to your chat.",
    "Make an image card of this reply, on this device",
    "Make an image card of this text, on this device",
    "Close dialog",
  ];
  for (const en of strings) {
    const zh = translateText(en, dict);
    assert.ok(zh && zh !== en && /\p{Script=Han}/u.test(zh), `no Chinese for ${JSON.stringify(en)}`);
  }
  // The credit line on the card follows the app's language.
  assert.equal(creditLine({ asked: true, model: false, brand: translateText("Asked on ANONYMA", dict) }), "在 ANONYMA 上提问");
  // Every string the dialog and toolbar draw is one of the above.
  for (const en of ["Make an image card of this text, on this device", "Card"]) assert.ok(read("src/HighlightAsk.jsx").includes(en));
  // The model's name is the model's, so it's never translated.
  assert.match(read("src/QuoteCards.jsx"), /<small data-i18n="off">\{modelName\}<\/small>/);
});

// ---- headless Chrome: the real flow ------------------------------------------
// Makes a real reply in test mode with Veil on, selects part of it, opens the
// card from the toolbar, and checks what is actually drawn, the PNG's real
// dimensions, the saved file, and that not one request left the page.

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const noChrome = !existsSync(CHROME) || !existsSync("dist/client/index.html");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}
async function chrome(t, { downloads }) {
  const profile = mkdtempSync(join(tmpdir(), "anonyma-quotecards-chrome-"));
  const proc = spawn(
    CHROME,
    ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--window-size=1280,900", "--no-first-run", "--no-default-browser-check", "about:blank"],
    { stdio: "ignore" },
  );
  t.after(async () => {
    proc.kill();
    await wait(300);
    rmSync(profile, { recursive: true, force: true });
  });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try {
      port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    } catch {
      await wait(100);
    }
  }
  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const ws = new WebSocket(list.find((x) => x.type === "page").webSocketDebuggerUrl);
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  t.after(() => ws.close());
  let seq = 0;
  const pending = new Map();
  const requests = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method === "Network.requestWillBeSent") requests.push({ url: m.params.request.url, method: m.params.request.method, type: m.params.type });
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, ms = 30000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      try {
        if (await evaluate(expression)) return;
      } catch {}
      await wait(120);
    }
    throw new Error("timed out waiting for " + expression);
  };
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Network.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloads, eventsEnabled: false }).catch(() => {});
  return { send, evaluate, until, requests };
}
const pngSize = (bytes) => {
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "a PNG");
  assert.equal(bytes.subarray(12, 16).toString(), "IHDR");
  return [bytes.readUInt32BE(16), bytes.readUInt32BE(20)];
};

test("headless: a real card from a Veil-masked reply, drawn on this device, PNG at the size chosen, nothing sent", { skip: noChrome && "needs Chrome and dist/", timeout: 240000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-quotecards-e2e-"));
  const downloads = join(dir, "downloads");
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const svc = createApp({
    testMode: true,
    released: "all",
    origin,
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
  });
  const server = svc.app.listen(port, "127.0.0.1");
  t.after(() => {
    server.close();
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const page = await chrome(t, { downloads });
  await page.send("Browser.grantPermissions", { origin, permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => {});
  // Veil on, English, before anything loads.
  await page.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `try { localStorage.setItem("anonyma:veil:on", "true"); localStorage.setItem("anonyma.lang", "en"); } catch {}`,
  });
  await page.send("Page.navigate", { url: origin + "/" });
  await page.until(`document.readyState === "complete"`);
  const status = await page.evaluate(
    `fetch("/api/auth/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: "cards-e2e", password: "test-password-long" }) }).then((r) => r.status)`,
  );
  assert.equal(status, 201);
  await page.send("Page.navigate", { url: origin + "/workspace/chat?model=claude-sonnet-5" });
  await page.until(`!!document.querySelector("form.composer textarea")`);
  await wait(500);
  // Nothing about cards is on screen before there is a reply.
  assert.equal(await page.evaluate(`!!document.querySelector(".quote-card-open")`), false);
  await page.evaluate(
    `(() => { const t = document.querySelector("form.composer textarea"); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(t, "Please email jane.doe@example.com about the launch."); t.dispatchEvent(new Event("input", { bubbles: true })); })()`,
  );
  await wait(250);
  await page.evaluate(`document.querySelector("form.composer").requestSubmit()`);
  await page.until(`!!document.querySelector(".quote-card-open")`, 60000);
  // The reply shows the real address (restored in this browser); the model never saw it.
  assert.equal(await page.evaluate(`document.querySelector("[data-highlight-reply]").innerText.includes("jane.doe@example.com")`), true);

  // Record every string the card draws.
  await page.evaluate(
    `window.__drawn = []; const ft = CanvasRenderingContext2D.prototype.fillText; CanvasRenderingContext2D.prototype.fillText = function (s, ...a) { window.__drawn.push(String(s)); return ft.call(this, s, ...a); };`,
  );
  // Select the paragraph that echoes the address, then Card in the toolbar.
  await page.evaluate(
    `(() => { const el = document.querySelector("[data-highlight-reply]"); const p = [...el.querySelectorAll("p")].find((x) => x.innerText.includes("You asked")); const r = document.createRange(); r.selectNodeContents(p); const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); })()`,
  );
  await page.until(`!!document.querySelector(".hl-card")`);
  const mark = page.requests.length;
  await page.evaluate(`document.querySelector(".hl-card").click()`);
  await page.until(`!!document.querySelector('.quote-card canvas[data-state="ready"]') && window.__drawn.length > 0`);
  const state = () =>
    page.evaluate(`(() => { const c = document.querySelector(".quote-card canvas"); return { w: c.width, h: c.height, template: c.dataset.template, size: c.dataset.size, state: c.dataset.state, text: document.querySelector("#quote-card-text").value, drawn: window.__drawn.slice() }; })()`);
  const settle = async (fn) => {
    await page.evaluate(`window.__drawn = []`);
    await fn();
    await page.until(`document.querySelector(".quote-card canvas").dataset.state === "ready" && window.__drawn.length > 0`);
    await wait(150);
  };

  // Masked by default: the text box and the card hold the placeholder, never the address.
  let s = await state();
  assert.match(s.text, /\[EMAIL_1\]/);
  assert.ok(!s.text.includes("jane.doe@example.com"));
  assert.ok(s.drawn.join(" ").includes("[EMAIL_1]"), "the card is drawn with the placeholder");
  assert.ok(!s.drawn.join(" ").includes("jane.doe"), "and never the real address");
  assert.deepEqual([s.w, s.h, s.template, s.size], [1080, 1080, "cobalt", "square"]);
  assert.ok(s.drawn.includes("Asked on ANONYMA · Claude Sonnet 5") || s.drawn.some((d) => /^Asked on ANONYMA · .+/.test(d)), s.drawn.join("|"));
  // Warned, and only on request: ticking the box puts the real address on the card.
  assert.equal(await page.evaluate(`!!document.querySelector(".quote-card-alert")`), false);
  await settle(() => page.evaluate(`document.querySelector(".quote-card-reveal input").click()`));
  s = await state();
  assert.ok(s.drawn.join(" ").includes("jane.doe@example.com"), "revealed on request");
  assert.match(s.text, /\[EMAIL_1\]/, "the text box still holds the placeholder");
  assert.equal(await page.evaluate(`document.querySelector(".quote-card-alert")?.getAttribute("role")`), "alert");
  assert.match(await page.evaluate(`document.querySelector(".quote-card-alert").innerText`), /Anyone you send the image to will be able to read them/);
  await settle(() => page.evaluate(`document.querySelector(".quote-card-reveal input").click()`));
  s = await state();
  assert.ok(!s.drawn.join(" ").includes("jane.doe"), "masked again");

  // Templates and sizes: the canvas is exactly the export size for each.
  for (const [label, w, h, id] of [["4:5", 1080, 1350, "portrait"], ["16:9", 1920, 1080, "wide"], ["1:1", 1080, 1080, "square"]]) {
    await settle(() => page.evaluate(`[...document.querySelectorAll(".quote-card [role=radio]")].find((b) => b.innerText.includes(${JSON.stringify(label)})).click()`));
    s = await state();
    assert.deepEqual([s.w, s.h, s.size], [w, h, id], label);
  }
  for (const name of ["White", "Dark", "Column", "Cobalt"]) {
    await settle(() => page.evaluate(`[...document.querySelectorAll(".quote-card [role=radio]")].find((b) => b.innerText.includes(${JSON.stringify(name)})).click()`));
    assert.equal((await state()).template, name.toLowerCase());
  }
  // The credit toggles.
  await settle(() => page.evaluate(`[...document.querySelectorAll(".quote-card-options input")][0].click()`));
  s = await state();
  assert.ok(!s.drawn.some((d) => d.startsWith("Asked on ANONYMA")), "the brand line is off");
  assert.ok(s.drawn.some((d) => /Claude|GLM|Sonnet/i.test(d) && !d.includes("ANONYMA")), s.drawn.join("|"));
  await settle(() => page.evaluate(`[...document.querySelectorAll(".quote-card-options input")][1].click()`));
  s = await state();
  assert.equal(s.drawn.filter((d) => /ANONYMA|Claude|Sonnet|GLM/i.test(d)).length, 0, "no credit line when both are off");
  await settle(() => page.evaluate(`[...document.querySelectorAll(".quote-card-options input")].slice(0, 2).forEach((i) => i.click())`));

  // The actual PNG, at the chosen size, with no metadata.
  await settle(() => page.evaluate(`[...document.querySelectorAll(".quote-card [role=radio]")].find((b) => b.innerText.includes("4:5")).click()`));
  const b64 = await page.evaluate(`new Promise((res) => document.querySelector(".quote-card canvas").toBlob(async (b) => { const buf = new Uint8Array(await b.arrayBuffer()); let s = ""; for (let i = 0; i < buf.length; i += 32768) s += String.fromCharCode(...buf.subarray(i, i + 32768)); res(btoa(s)); }, "image/png"))`);
  const png = Buffer.from(b64, "base64");
  assert.deepEqual(pngSize(png), [1080, 1350]);
  for (const chunk of ["tEXt", "iTXt", "zTXt", "eXIf", "tIME"]) assert.ok(!png.includes(chunk), `no ${chunk} chunk`);
  assert.ok(png.length > 5000);

  // Save PNG writes that file: the same size, named for the size only.
  await page.evaluate(`[...document.querySelectorAll(".quote-card-actions button")].find((b) => b.innerText.includes("Save PNG")).click()`);
  const file = join(downloads, "anonyma-quote-card-4x5.png");
  for (let i = 0; i < 60 && !existsSync(file); i++) await wait(150);
  if (existsSync(file)) assert.deepEqual(pngSize(readFileSync(file)), [1080, 1350]);
  else t.diagnostic("the headless browser didn't write the download; the PNG bytes were checked from the canvas instead");
  await page.until(`/Saved as a PNG/.test(document.querySelector(".quote-card-flash").innerText)`, 8000);

  // Copy image puts a PNG on the clipboard where the browser allows it.
  await page.evaluate(`[...document.querySelectorAll(".quote-card-actions button")].find((b) => b.innerText.includes("Copy image")).click()`);
  await page.until(`/Copied the image|can.t copy an image/.test(document.querySelector(".quote-card-flash").innerText)`, 8000);
  if (/Copied the image/.test(await page.evaluate(`document.querySelector(".quote-card-flash").innerText`))) {
    const clip = await page.evaluate(`(async () => { const items = await navigator.clipboard.read(); const blob = await items[0].getType("image/png"); const bmp = await createImageBitmap(blob); return [items[0].types.join(","), bmp.width, bmp.height]; })()`).catch(() => null);
    if (clip) assert.deepEqual(clip.slice(1), [1080, 1350]);
  }

  // Nothing left the page: since the card opened, every request was a plain GET for the
  // site's own files (its script, styles, fonts and the mark), and none went to the API.
  const since = page.requests.slice(mark).filter((r) => !/^(blob:|data:)/.test(r.url));
  for (const r of since) {
    assert.equal(r.method, "GET", `${r.method} ${r.url}`);
    assert.ok(r.url.startsWith(origin + "/") && !r.url.startsWith(origin + "/api/"), r.url);
  }

  // The reply's own Card button opens the whole reply as plain text.
  await page.evaluate(`document.querySelector("dialog.modal .icon-button").click()`);
  await page.until(`!document.querySelector(".quote-card")`);
  await page.evaluate(`document.querySelector(".quote-card-open").click()`);
  await page.until(`!!document.querySelector('.quote-card canvas[data-state="ready"]')`);
  const whole = await page.evaluate(`document.querySelector("#quote-card-text").value`);
  assert.match(whole, /Local test provider/);
  assert.match(whole, /\[EMAIL_1\]/);
  assert.ok(!/\*\*/.test(whole), "no Markdown marks");
  assert.ok(!whole.includes("jane.doe@example.com"), "the masked text, not the restored one");
  // What the person chose is remembered for next time, as choices only.
  const prefs = await page.evaluate(`localStorage.getItem("anonyma:quotecards:prefs")`);
  assert.deepEqual(Object.keys(JSON.parse(prefs)).sort(), ["asked", "model", "size", "template"]);
  assert.ok(!prefs.includes("EMAIL") && !prefs.includes("jane"));
});
