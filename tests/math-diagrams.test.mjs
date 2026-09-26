import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { unified } from "unified";
import remarkParse from "remark-parse";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { now, uid } from "../server/core.js";
import { UPDATES, featuresFor, releaseInfo } from "../server/releases.js";
import { chatStream } from "../server/provider.js";
import { messageFromServer } from "../src/lib.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { excerptOf, withoutDiagrams } from "../src/bookmarks.js";
import { buildChatExport, exportJSON, exportMarkdown } from "../src/chat-export.js";
import {
  DIAGRAM_CONFIG,
  DIAGRAM_CSS,
  DIAGRAM_THEME,
  KATEX_OPTIONS,
  MAX_DIAGRAM_SOURCE,
  cleanDiagramCss,
  diagramSource,
  prepareMath,
  protectedRanges,
  rehypeRichWrap,
  remarkFenceClosed,
  remarkMathTidy,
  splitMath,
} from "../src/rich-markdown.js";

// Math & Diagrams (update "diagrams"): LaTeX typeset by KaTeX and ```mermaid
// blocks drawn by Mermaid in replies, in the browser. Covered here: the
// release gate (before it, the plain renderer exactly as today), telling
// money from math, display and inline math, diagrams only once their fence
// closes, the fallback for a diagram that can't be drawn, lazy chunks,
// KaTeX/Mermaid safety settings, Veil, Bookmarks excerpts, Chat Export's
// source fallback, the local test fixture and the Chinese copy.

// Release commits flip `released` on UPDATES entries; these tests cover the
// gate itself, so every update is pinned unreleased for this file.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const src = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const han = /\p{Script=Han}/u;

function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-diagrams-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...(released === "all" ? {} : { mvpModels: [MODEL] }),
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(app, username) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const events = (text) =>
  text
    .split("\n\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)));

// ---- The components, compiled for Node with the esbuild Vite uses ----
//
// The shared UI kit and the app context are stand-ins; KaTeX's lazy module
// is the real KaTeX without its stylesheet; Mermaid's lazy module is a
// stand-in that draws a fixed SVG, refuses anything starting "not valid",
// and counts how often it was loaded.
const scratch = mkdtempSync(join(tmpdir(), "anonyma-diagrams-ui-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const react = import.meta.resolve("react");
const stub = (name, body) => {
  writeFileSync(join(scratch, name), body);
  return pathToFileURL(join(scratch, name)).href;
};
const local = (name) => new URL("../src/" + name, import.meta.url).href;
async function compile(name, swaps) {
  const file = new URL("../src/" + name, import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(file, "utf8"), file.pathname, {
    jsx: "transform",
    format: "esm",
  });
  let out = code;
  for (const [from, to] of swaps) out = out.replace(from, to);
  return await import(stub(name.replace(/\.jsx$/, ".mjs"), out));
}
let rich, veil;
before(async () => {
  const ui = stub(
    "ui.mjs",
    `import React from "${react}";
     export const Icon = ({ name }) => React.createElement("i", { "data-icon": name });`,
  );
  const context = stub("context.mjs", `export const useApp = () => globalThis.__app ?? null;`);
  const katexKit = stub(
    "math-katex.mjs",
    `export { default as katex } from "${import.meta.resolve("katex")}";
     export { default as rehypeKatex } from "${import.meta.resolve("rehype-katex")}";`,
  );
  const diagramKit = stub(
    "diagram-render.mjs",
    `globalThis.__diagramLoads = (globalThis.__diagramLoads || 0) + 1;
     export async function drawDiagram(source) {
       globalThis.__diagramDraws = (globalThis.__diagramDraws || 0) + 1;
       if (/^not valid/.test(source)) throw Error("Parse error");
       return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><text>drawn</text></svg>';
     }`,
  );
  rich = await compile("RichMarkdown.jsx", [
    [/^import "\.\/diagrams\.css";$/m, ""],
    [/from "\.\/ui\.jsx"/g, `from "${ui}"`],
    [/from "\.\/context\.jsx"/g, `from "${context}"`],
    [/from "\.\/lib\.js"/g, `from "${local("lib.js")}"`],
    [/from "\.\/i18n\.js"/g, `from "${local("i18n.js")}"`],
    [/from "\.\/rich-markdown\.js"/g, `from "${local("rich-markdown.js")}"`],
    [/import\("\.\/math-katex\.js"\)/g, `import("${katexKit}")`],
    [/import\("\.\/diagram-render\.js"\)/g, `import("${diagramKit}")`],
    [/from "react-markdown"/g, `from "${import.meta.resolve("react-markdown")}"`],
    [/from "remark-math"/g, `from "${import.meta.resolve("remark-math")}"`],
    [/from "react"/g, `from "${react}"`],
  ]);
  veil = await compile("Veil.jsx", [
    [/^import "\.\/veil\.css";$/m, ""],
    [/from "\.\/ui\.jsx"/g, `from "${ui}"`],
    [/from "react"/g, `from "${react}"`],
  ]);
});
const configWith = (diagrams) => ({ releases: { features: { diagrams } } });
function reply(text, props = {}) {
  return renderToStaticMarkup(
    createElement(rich.ReplyMarkdown, { remarkPlugins: [remarkGfm], ...props }, text),
  );
}
const plainReply = (text) =>
  renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins: [remarkGfm] }, text));
const SAMPLE = [
  "The area is $A = \\pi r^2$, and it costs $5 and $10.",
  "",
  "$$",
  "E = mc^2",
  "$$",
  "",
  "```mermaid",
  "flowchart TD",
  "  A --> B",
  "```",
].join("\n");

// ---- The release gate ----

test("registered as an unreleased, browser-only update with its own icon", () => {
  const update = UPDATES.find((u) => u.id === "diagrams");
  assert.ok(update);
  assert.equal(typeof committed[UPDATES.indexOf(update)], "boolean");
  assert.equal(update.title, "Math & Diagrams");
  assert.equal(update.points.length, 3);
  assert.match(src("src/Pages.jsx"), /\bdiagrams: "sigma"/);
  assert.match(src("src/ui.jsx"), /\bsigma: Sigma\b/);
  // Nothing on the server to gate: no request needs "diagrams".
  for (const path of ["/api/chat", "/api/bookmarks", "/api/conversations/c_1", "/api/shares/x"])
    for (const method of ["GET", "POST"])
      assert.ok(!featuresFor({ path, method, body: {} }).includes("diagrams"), path);
  assert.equal(releaseInfo({ released: new Set() }).features.diagrams, false);
  assert.equal(releaseInfo({ released: "all" }).features.diagrams, true);
});

test("the app's config says whether it's live", async (t) => {
  for (const [released, live] of [
    ["mvp", false],
    ["mvp,bookmarks", false],
    ["mvp,diagrams", true],
    ["all", true],
  ]) {
    const s = fixture(t, released);
    const config = (await request(s.app).get("/api/config").expect(200)).body;
    assert.equal(config.releases.features.diagrams, live, released);
  }
});

test("before release (and for what people type): exactly the plain renderer, code blocks and raw TeX", () => {
  globalThis.__app = { config: configWith(false) };
  const before = plainReply(SAMPLE);
  assert.equal(reply(SAMPLE), before);
  assert.equal(reply(SAMPLE, { live: false }), before);
  // Released, but the text is the user's own: still plain.
  globalThis.__app = { config: configWith(true) };
  assert.equal(reply(SAMPLE, { rich: false }), before);
  assert.match(before, /<code class="language-mermaid">/);
  assert.match(before, /\$A = \\pi r\^2\$/);
  assert.doesNotMatch(before, /rich-|katex/);
  globalThis.__app = null;
});

test("every place replies render uses it, for replies only", () => {
  for (const [file, rule] of [
    ["src/Workspace.jsx", /<ReplyMarkdown\s+\/\/[^\n]*\n\s*rich=\{m\.role === "assistant"\}/],
    ["src/SharedChat.jsx", /<ReplyMarkdown\s+rich=\{m\.role === "assistant"\}/],
    ["src/ChatExport.jsx", /<ReplyMarkdown\s+rich=\{m\.role === "assistant"\}/],
    ["src/Symposium.jsx", /<ReplyMarkdown rich=\{!!col\.text\}[\s\S]*<ReplyMarkdown rich=\{!!fusion\.text\}/],
    ["src/DoubleCheck.jsx", /<ReplyMarkdown\s+rich=\{!!result\.text\}/],
    ["src/TaskTools.jsx", /<ReplyMarkdown\s+rich=\{!!r\.text\}/],
    ["src/HistoryLibrary.jsx", /<ReplyMarkdown rich=\{m\.role !== "user"\}/],
    ["src/Routines.jsx", /<ReplyMarkdown remarkPlugins/],
    ["src/Bookmarks.jsx", /<MathText text=\{excerpt\} live=\{rich\} \/>/],
  ]) {
    const code = src(file);
    assert.match(code, rule, file);
    assert.doesNotMatch(code, /<ReactMarkdown/, file);
  }
  // The gate itself: the "diagrams" update in the app's config.
  assert.match(src("src/RichMarkdown.jsx"), /isReleased\(config, DIAGRAMS_UPDATE\)/);
});

// ---- Math ----

test("money stays money: unpaired or price-like dollar signs are escaped, math is kept", () => {
  const cases = [
    ["It costs $5 and $10.", false],
    ["Between $5-$10, or $1,000-$2,000.", false],
    ["($5)($10) and $5/$10", false],
    ["Run $ npm i, then echo $HOME and $PATH", false],
    ["Pay $5 for $x$ units", true],
    ["Inline $x^2 + y^2 = z^2$ here.", true],
    ["the $n$th term", true],
    ["Escaped \\$5 stays", false],
  ];
  for (const [text, math] of cases) {
    const p = prepareMath(text);
    assert.equal(p.math, math, text);
    // What remark-math then sees as math, and nothing else.
    const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMath).parse(p.text);
    const found = [];
    (function walk(n) {
      if (n.type === "inlineMath") found.push(n.value);
      (n.children || []).forEach(walk);
    })(tree);
    assert.equal(found.length > 0, math, text);
  }
  assert.equal(prepareMath("It costs $5 and $10.").text, "It costs \\$5 and \\$10.");
  assert.equal(prepareMath("Pay $5 for $x$ units").text, "Pay \\$5 for $x$ units");
});

test("code, inline code and raw HTML are left exactly as written", () => {
  const text = [
    "Use `echo $HOME` and $5 later.",
    "",
    "```bash",
    "$ npm i && echo $1 $2",
    "```",
    "",
    "    $ indented code $x$",
    "",
    "<div>$5 and $6</div>",
    "",
    "and $y$",
  ].join("\n");
  const p = prepareMath(text);
  assert.match(p.text, /`echo \$HOME`/);
  assert.match(p.text, /\n\$ npm i && echo \$1 \$2\n/);
  assert.match(p.text, /\n {4}\$ indented code \$x\$\n/);
  assert.match(p.text, /<div>\$5 and \$6<\/div>\n\nand \$y\$/);
  assert.match(p.text, /and \\\$5 later/);
  assert.equal(protectedRanges(text).length, 4);
});

test("\\( \\) and \\[ \\] become math; escaped brackets and TeX line breaks don't", () => {
  assert.equal(prepareMath("Inline \\(a+b\\) here").text, "Inline $a+b$ here");
  assert.equal(prepareMath("\\[\nx = \\frac{1}{2}\n\\]").text, "$$\nx = \\frac{1}{2}\n$$");
  assert.equal(prepareMath("see \\[sic\\] and arr\\[0\\]").text, "see \\[sic\\] and arr\\[0\\]");
  assert.equal(
    prepareMath("$$\n\\begin{aligned} a &= 1 \\\\[2pt] b &= 2 \\end{aligned}\n$$").text,
    "$$\n\\begin{aligned} a &= 1 \\\\[2pt] b &= 2 \\end{aligned}\n$$",
  );
  // A display block that opens mid-line can't close at the start of a line.
  assert.equal(prepareMath("> quote $$\n> a^2\n> $$").math, false);
});

test("inline and display math render with KaTeX once its chunk is in, and never translate", async () => {
  globalThis.__app = { config: configWith(true) };
  // Before KaTeX's chunk arrives: the TeX as code, in place.
  const early = reply("Area $A = \\pi r^2$.");
  assert.match(early, /<rich-math|class="rich-math"/);
  assert.match(early, /<code class="language-math math-inline">A = \\pi r\^2<\/code>/);
  await rich.loadKatex();
  const html = reply(SAMPLE);
  assert.match(html, /<span class="rich-math" data-i18n="off"><span class="katex">/);
  assert.match(html, /<figure class="rich-block rich-math-block" data-i18n="off">/);
  assert.match(html, /class="katex-display"/);
  assert.match(html, /<annotation encoding="application\/x-tex">E = mc\^2<\/annotation>/);
  assert.match(html, /Show source/);
  assert.match(html, /Copy SVG/);
  assert.match(html, /it costs \$5 and \$10\./);
  // $$…$$ on a line of its own is display math, even inside a paragraph.
  const lonely = reply("The area:\n$$A = \\pi r^2$$\nwhere r is the radius.");
  assert.match(lonely, /<p>The area:<\/p>\s*<figure class="rich-block rich-math-block"/);
  assert.match(lonely, /<p>where r is the radius\.<\/p>/);
  // ```math blocks are display math too.
  assert.match(reply("```math\nx^2\n```"), /rich-math-block[\s\S]*katex-display/);
  // TeX that doesn't parse shows as written, with a plain note.
  const broken = reply("$$\n\\frac{1}{\n$$");
  assert.match(broken, /class="katex-error"/);
  assert.match(broken, /Couldn&#x27;t typeset this equation\./);
  assert.doesNotMatch(broken, /Copy SVG/);
  globalThis.__app = null;
});

test("KaTeX is set for untrusted TeX: no links, images, HTML extensions or runaway macros", async () => {
  await rich.loadKatex();
  globalThis.__app = { config: configWith(true) };
  const html = reply(
    [
      "$\\href{javascript:alert(1)}{click}$",
      "$\\url{https://example.com/x}$",
      "$\\includegraphics{https://example.com/pixel.png}$",
      "$\\htmlClass{x}{y}$ $\\htmlData{a=b}{y}$ $\\htmlStyle{color:red}{y}$",
    ].join(" "),
  );
  // Shown as the command's name (the TeX itself is only in the MathML
  // annotation), never as a link or an image.
  assert.doesNotMatch(html, /<a\s|\shref=|<img|src=/i);
  const shown = html.replace(/<annotation[^>]*>[^<]*<\/annotation>/g, "");
  assert.doesNotMatch(shown, /javascript:|example\.com/);
  assert.doesNotMatch(shown, /class="x"|data-a=|color:red/);
  assert.equal(KATEX_OPTIONS.trust, false);
  assert.ok(KATEX_OPTIONS.maxExpand <= 1000 && KATEX_OPTIONS.maxSize <= 50);
  const bomb = reply("$\\def\\a{\\a\\a}\\a$");
  assert.match(bomb, /katex-error|rich-math/);
  globalThis.__app = null;
});

test("Veil keeps working next to math: tags restore, math is untouched", async () => {
  await rich.loadKatex();
  globalThis.__app = { config: configWith(true) };
  const html = reply("[NAME_1] computed $x^2$ for [NAME_1].", {
    remarkPlugins: [remarkGfm, [veil.veilRemarkPlugin, { map: { NAME_1: "Alice" } }]],
  });
  assert.equal((html.match(/<mark class="veil-mark"[^>]*>Alice<\/mark>/g) || []).length, 2);
  assert.match(html, /class="rich-math"[^>]*><span class="katex">/);
  assert.doesNotMatch(html.replace(/title="[^"]*"/g, ""), /\[NAME_1\]/);
  globalThis.__app = null;
});

// ---- Diagrams ----

test("a ```mermaid block is recognised, and drawn only once its closing fence has arrived", () => {
  const parse = (text) => {
    const processor = unified().use(remarkParse).use(remarkGfm).use(remarkFenceClosed);
    const tree = processor.runSync(processor.parse(text), text);
    const codes = [];
    (function walk(n) {
      if (n.type === "code") codes.push(n);
      (n.children || []).forEach(walk);
    })(tree);
    return codes.map((c) => [c.lang, c.data?.hProperties?.dataClosed === "true"]);
  };
  assert.deepEqual(parse("```mermaid\ngraph TD\nA-->B\n```"), [["mermaid", true]]);
  assert.deepEqual(parse("```mermaid\ngraph TD\nA-->B"), [["mermaid", false]]);
  assert.deepEqual(parse("```mermaid\ngraph TD\nA-->B\n``"), [["mermaid", false]]);
  assert.deepEqual(parse("~~~~mermaid\ngraph TD\n~~~~"), [["mermaid", true]]);
  assert.deepEqual(parse("> ```mermaid\n> graph TD\n> ```"), [["mermaid", true]]);
  assert.deepEqual(parse("```js\nx\n```"), [["js", false]]);
  // Only mermaid blocks become diagrams.
  const hast = (text) => {
    const tree = { type: "root", children: [] };
    const html = renderToStaticMarkup(
      createElement(ReactMarkdown, {
        remarkPlugins: [remarkGfm, remarkFenceClosed],
        rehypePlugins: [rehypeRichWrap, () => (t) => void tree.children.push(...t.children)],
      }, text),
    );
    return { html, tree };
  };
  assert.match(hast("```mermaid\ngraph TD\n```").html, /<rich-diagram data-source="graph TD" data-closed="true">/);
  assert.doesNotMatch(hast("```js\nlet a\n```\n\n```text\nmermaid\n```").html, /rich-diagram/);
});

test("drawn diagrams show with Show source, Copy SVG and Download PNG; ones that can't be drawn fall back to code", async () => {
  globalThis.__app = { config: configWith(true) };
  const good = "```mermaid\nflowchart TD\n  A --> B\n```";
  // First paint: the code block, while Mermaid's chunk loads.
  const first = reply(good);
  assert.match(first, /<div class="rich-diagram-pending" data-i18n="off"><pre><code class="language-mermaid"/);
  assert.equal((await rich.drawDiagramOnce("flowchart TD\n  A --> B")).status, "ok");
  const drawn = reply(good);
  assert.match(drawn, /<figure class="rich-block rich-diagram" data-i18n="off">/);
  assert.match(drawn, /role="img" aria-label="Diagram"/);
  for (const label of ["Show source", "Copy SVG", "Download PNG"]) assert.match(drawn, new RegExp(label));
  // Invalid: the code as written, and a short note.
  const bad = "not valid [[[ mermaid";
  assert.equal((await rich.drawDiagramOnce(bad)).status, "failed");
  const fallback = reply("```mermaid\n" + bad + "\n```");
  assert.match(fallback, /<code class="language-mermaid"[^>]*>not valid \[\[\[ mermaid/);
  assert.match(fallback, /Couldn&#x27;t draw this diagram\./);
  assert.doesNotMatch(fallback, /Copy SVG|Download PNG/);
  // Still streaming: the code block, no note and nothing drawn.
  const open = reply("```mermaid\nflowchart TD\n  A --> B");
  assert.match(open, /data-i18n="off"><pre><code class="language-mermaid"/);
  assert.doesNotMatch(open, /Couldn|Drawing/);
  // Too long to draw: the code, with a note.
  const long = "graph TD\n" + "A-->B\n".repeat(MAX_DIAGRAM_SOURCE / 5);
  assert.match(reply("```mermaid\n" + long + "```"), /This diagram is too long to draw here\./);
  globalThis.__app = null;
});

test("Mermaid is its own chunk, fetched only for a finished diagram", async () => {
  const before = globalThis.__diagramLoads || 0;
  globalThis.__app = { config: configWith(true) };
  for (const text of ["Plain reply.", "$x$ and $$y$$", "```js\nlet x\n```", "```mermaid\ngraph TD"])
    reply(text);
  assert.equal(globalThis.__diagramLoads || 0, before);
  globalThis.__app = null;
  // In the source: Mermaid, the diagram module, KaTeX and the SVG maker are
  // only ever imported dynamically, and only from the reply renderer.
  const jsx = src("src/RichMarkdown.jsx");
  assert.match(jsx, /import\("\.\/diagram-render\.js"\)/);
  assert.match(jsx, /import\("\.\/math-katex\.js"\)/);
  assert.match(jsx, /import\("\.\/math-svg\.js"\)/);
  for (const file of readdirSync(new URL("../src/", import.meta.url))) {
    if (!/\.(jsx?|mjs)$/.test(file)) continue;
    const code = src("src/" + file);
    if (file !== "diagram-render.js")
      assert.doesNotMatch(code, /from "mermaid"|from "dompurify"/, file);
    if (file !== "math-katex.js") assert.doesNotMatch(code, /from "katex"|from "rehype-katex"/, file);
    if (file !== "math-svg.js") assert.doesNotMatch(code, /from "opentype\.js"/, file);
    assert.doesNotMatch(code, /from "\.\/(diagram-render|math-katex|math-svg)\.js"/, file);
  }
  // In the build: none of them is reachable by static imports from the
  // app's entry, the workspace or a shared chat.
  const dist = new URL("../dist/client/", import.meta.url);
  if (!existsSync(new URL("index.html", dist))) return;
  const assets = readdirSync(new URL("assets/", dist));
  const read = (f) => readFileSync(new URL("assets/" + f, dist), "utf8");
  const statics = (code) =>
    [...code.matchAll(/(?:^|[;}\n])\s*import\s*(?:[\w*{}\s,$]+from\s*)?["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]);
  const reach = (entry) => {
    const seen = new Set();
    const queue = [entry];
    while (queue.length) {
      const f = queue.pop();
      if (seen.has(f)) continue;
      seen.add(f);
      queue.push(...statics(read(f)));
    }
    return seen;
  };
  const entry = readFileSync(new URL("index.html", dist), "utf8").match(/src="\/assets\/([^"]+\.js)"/)[1];
  const lazy = (f) => /^(diagram-render|math-katex|math-svg|katex|mermaid|flowDiagram|sequenceDiagram)-/.test(f);
  for (const start of [entry, ...assets.filter((f) => /^(Workspace|SharedChat)-.*\.js$/.test(f))])
    for (const f of reach(start)) assert.ok(!lazy(f), `${start} statically loads ${f}`);
  assert.ok(assets.some((f) => /^diagram-render-.*\.js$/.test(f)));
  assert.ok(assets.some((f) => /^math-katex-.*\.js$/.test(f)));
  assert.ok(assets.some((f) => /^KaTeX_Main-Regular-.*\.woff2$/.test(f)), "KaTeX fonts are served from this site");
});

test("Mermaid runs strict, without HTML labels, in the house theme that a diagram can't change", () => {
  assert.equal(DIAGRAM_CONFIG.securityLevel, "strict");
  assert.equal(DIAGRAM_CONFIG.htmlLabels, false);
  assert.equal(DIAGRAM_CONFIG.flowchart.htmlLabels, false);
  assert.equal(DIAGRAM_CONFIG.class.htmlLabels, false);
  assert.equal(DIAGRAM_CONFIG.startOnLoad, false);
  assert.equal(DIAGRAM_CONFIG.theme, "base");
  for (const key of ["securityLevel", "htmlLabels", "theme", "themeVariables", "themeCSS", "fontFamily", "flowchart", "maxTextSize", "secure"])
    assert.ok(DIAGRAM_CONFIG.secure.includes(key), key);
  assert.equal(DIAGRAM_THEME.primaryBorderColor, "#0135df");
  assert.equal(DIAGRAM_THEME.lineColor, "#0135df");
  assert.doesNotMatch(DIAGRAM_CSS, /url\(|@import/);
  // Directives and front-matter config are dropped; a title stays.
  assert.equal(
    diagramSource('%%{init: {"securityLevel": "loose", "themeCSS": "x"}}%%\nflowchart LR\n  A-->B'),
    "flowchart LR\n  A-->B",
  );
  assert.equal(
    diagramSource("---\ntitle: Refunds\nconfig:\n  theme: dark\n  securityLevel: loose\n---\nflowchart LR\n  A-->B"),
    "---\ntitle: Refunds\n---\nflowchart LR\n  A-->B",
  );
  assert.equal(diagramSource("---\nconfig:\n  look: handDrawn\n---\ngraph TD\nA-->B"), "graph TD\nA-->B");
  // CSS inside a drawn diagram can only point inside it.
  assert.equal(
    cleanDiagramCss('@import "https://x.test/a.css"; .a{background:url(https://x.test/p.png)} .b{marker-end:url(#arrow)}'),
    " .a{background:none} .b{marker-end:url(#arrow)}",
  );
  assert.equal(cleanDiagramCss("fill:url( 'data:image/png;base64,AAA' )"), "fill:none");
});

test("the renderers never set HTML from strings, evaluate code or reach the network", () => {
  for (const file of ["src/RichMarkdown.jsx", "src/rich-markdown.js", "src/diagram-render.js", "src/math-svg.js", "src/math-katex.js"]) {
    const code = src(file);
    assert.doesNotMatch(code, /dangerouslySetInnerHTML|\.innerHTML\s*=|outerHTML\s*=|insertAdjacentHTML/, file);
    assert.doesNotMatch(code, /\beval\(|new Function\(/, file);
    // fetch only for this site's own font files.
    for (const m of code.matchAll(/fetch\(([^,)]+)/g)) assert.equal(m[1].trim(), "url", file);
  }
  // The drawn SVG is sanitised before it's mounted, and mounted as nodes.
  const draw = src("src/diagram-render.js");
  assert.match(draw, /DOMPurify\.sanitize\(svg, \{\s*USE_PROFILES: \{ svg: true, svgFilters: true \}/);
  for (const tag of ["a", "foreignObject", "image", "use", "script"]) assert.match(draw, new RegExp(`"${tag}"`));
  assert.match(src("src/RichMarkdown.jsx"), /el\.replaceChildren\(svg\)/);
  // The CSP is unchanged: no 'unsafe-eval' was needed.
  const csp = src("src/security-headers.js");
  assert.match(csp, /"script-src 'self' 'wasm-unsafe-eval'"/);
  assert.match(csp, /"font-src 'self' data:"/);
});

// ---- Plain-text excerpts (Bookmarks) ----

test("splitMath finds math in a line of plain text and leaves prices alone", () => {
  assert.deepEqual(splitMath("Area $A = \\pi r^2$ costs $5 and $10"), [
    { type: "text", value: "Area " },
    { type: "math", value: "A = \\pi r^2" },
    { type: "text", value: " costs $5 and $10" },
  ]);
  assert.deepEqual(splitMath("Cut off $\\frac{1}{2"), [{ type: "text", value: "Cut off $\\frac{1}{2" }]);
  assert.deepEqual(splitMath("\\(x\\) and $$y$$"), [
    { type: "math", value: "x" },
    { type: "text", value: " and " },
    { type: "math", value: "y" },
  ]);
});

test("bookmarks: once released, an answer's excerpt leaves its diagram out and says it has one", async (t) => {
  const reply = "Here is the flow:\n\n```mermaid\nflowchart LR\n  A-->B\n```\n\nThe area is $x^2$.";
  assert.deepEqual(excerptOf(reply, "assistant"), {
    excerpt: "Here is the flow: flowchart LR A-->B The area is $x^2$.",
    more: false,
  });
  assert.deepEqual(excerptOf(reply, "assistant", { diagrams: true }), {
    excerpt: "Here is the flow: The area is $x^2$.",
    more: false,
    diagram: true,
  });
  assert.deepEqual(excerptOf("```mermaid\ngraph TD\nA-->B", "assistant", { diagrams: true }).diagram, undefined);
  assert.equal(withoutDiagrams("~~~mermaid\na\n~~~\nx").diagrams, 1);
  // Through the API: the same saved answer, before and after the release.
  for (const [released, diagram] of [
    ["mvp,bookmarks", false],
    ["mvp,bookmarks,diagrams", true],
  ]) {
    const s = fixture(t, released);
    const p = await person(s.app, "ada" + visitor);
    const id = uid("c_"),
      answer = uid("m_"),
      at = now();
    s.db
      .prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)")
      .run(id, p.user.id, "Flow", "chat", at, at);
    const insert = s.db.prepare(
      "INSERT INTO messages(id,conversation_id,role,content,model,cost,created) VALUES(?,?,?,?,?,?,?)",
    );
    insert.run(uid("m_"), id, "user", JSON.stringify("Draw it"), null, 0, at);
    insert.run(answer, id, "assistant", JSON.stringify({ text: reply }), MODEL, 0, at + 1);
    await p.agent.post("/api/bookmarks").send({ message_id: answer }).expect(201);
    const [b] = (await p.agent.get("/api/bookmarks").expect(200)).body.data;
    assert.equal(b.diagram === true, diagram, released);
    assert.equal(/flowchart LR A-->B/.test(b.excerpt), !diagram, released);
    assert.match(b.excerpt, /The area is \$x\^2\$\./);
  }
});

test("the bookmark card typesets its excerpt's math and tags a diagram, once released", () => {
  const card = src("src/Bookmarks.jsx");
  assert.match(card, /const rich = b\.role === "assistant" && diagramsReleased\(config\);/);
  assert.match(card, /\{diagram && <span className="bookmark-diagram-tag">Diagram<\/span>\}/);
  globalThis.__app = null;
  // Unreleased: the excerpt as text.
  assert.equal(renderToStaticMarkup(createElement(rich.MathText, { text: "Area $x^2$", live: false })), "Area $x^2$");
  assert.match(
    renderToStaticMarkup(createElement(rich.MathText, { text: "Area $x^2$ for $5", live: true })),
    /^Area <span class="rich-math" data-i18n="off"><\/span> for \$5$/,
  );
  // An excerpt cut off inside display math stops before it.
  assert.match(
    renderToStaticMarkup(
      createElement(rich.MathText, { text: "Area $x$, and the charge is $$ \\text{charge} = \\frac{t…", live: true }),
    ),
    /<\/span>, and the charge is …$/,
  );
  assert.equal(
    renderToStaticMarkup(createElement(rich.MathText, { text: "It costs $5 and $10…", live: true })),
    "It costs $5 and $10…",
  );
});

// ---- Chat Export and the local test fixture ----

test("Chat Export's Markdown and JSON keep the TeX and the diagram's source as written", async (t) => {
  const s = fixture(t);
  const p = await person(s.app, "grace");
  const r = await p.agent
    .post("/api/chat")
    .send({ model: MODEL, messages: [{ role: "user", content: "Explain the formula with a diagram" }], max_tokens: 400 })
    .expect(200);
  const list = events(r.text);
  const text = list.map((e) => e.choices?.[0]?.delta?.content || "").join("");
  assert.match(text, /\$\$\n\\text\{charge\}/);
  assert.match(text, /```mermaid\nflowchart TD\n/);
  assert.match(text, /\$p_\{in\}\$/);
  const id = list.find((e) => e.conversationId)?.conversationId;
  const saved = (await p.agent.get("/api/conversations/" + id).expect(200)).body;
  const doc = buildChatExport({
    conversation: { id: saved.id, title: saved.title, mode: "chat" },
    messages: saved.messages.map(messageFromServer),
    userId: p.user.id,
    username: p.user.username,
  });
  const md = exportMarkdown(doc);
  assert.ok(md.includes("```mermaid\nflowchart TD\n  A[Your message] --> B{Enough balance?}"));
  assert.ok(md.includes("\\text{charge} = \\frac{t_{in}\\,p_{in} + t_{out}\\,p_{out}}{10^{6}}"));
  const json = JSON.parse(exportJSON(doc));
  const answer = json.messages.find((m) => m.role === "assistant");
  assert.ok(answer.text.includes("```mermaid\nflowchart TD"));
});

test("local test mode answers a diagram or formula question with a fixed, labelled sample", async () => {
  const run = async (content) => {
    let out = "";
    for await (const e of chatStream({ testMode: true }, { model: MODEL, messages: [{ role: "user", content }] }))
      out += e.choices?.[0]?.delta?.content || "";
    return out;
  };
  const sample = await run("Draw the refund flow as a diagram");
  assert.match(sample, /^\*\*Local test provider\*\* — a fixed sample reply, not a live model\./);
  assert.match(sample, /```mermaid\n[\s\S]*\n```/);
  assert.equal(await run("Which formula?"), sample);
  assert.equal(await run("用公式和流程图说明计费"), sample);
  assert.match(await run("Tell me about Lisbon"), /You asked: Tell me about Lisbon/);
  assert.match(await run("Write a python function"), /```javascript filename=hello\.js/);
});

// ---- Chinese ----

test("Chinese: the update and every label translate; math and diagrams stay as written", () => {
  const zh = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
  const update = UPDATES.find((u) => u.id === "diagrams");
  for (const text of [
    update.title,
    update.tagline,
    ...update.points,
    "Show source",
    "Hide source",
    "Copy SVG",
    "Download PNG",
    "Copied",
    "Downloaded",
    "Couldn't copy this equation.",
    "Couldn't copy this diagram.",
    "Couldn't make a PNG in this browser.",
    "Couldn't typeset this equation.",
    "Couldn't draw this diagram.",
    "Drawing the diagram…",
    "This diagram is too long to draw here.",
    "Equation source",
    "Diagram",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
  assert.equal(translateText("Math & Diagrams", zh), "数学公式与图表");
  assert.match(translateText(update.tagline, zh), /会话/);
  // The rendered math and diagrams sit inside data-i18n="off"; their buttons
  // translate themselves (useUiText), like Live Preview's.
  const jsx = src("src/RichMarkdown.jsx");
  assert.equal((jsx.match(/data-i18n="off"/g) || []).length >= 4, true);
  assert.match(jsx, /language === "zh" \? t\(text\) : text/);
  // Where Mermaid draws and where an equation is read for Copy SVG are off
  // limits to the translator too (labels are measured in there).
  assert.match(src("src/diagram-render.js"), /box\.setAttribute\("data-i18n", "off"\)/);
  assert.match(src("src/math-svg.js"), /ghost\.setAttribute\("data-i18n", "off"\)/);
});
