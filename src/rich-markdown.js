// Math & Diagrams (the "diagrams" update): the plain-JavaScript half of how a
// reply's LaTeX and Mermaid blocks are recognised. No DOM and no React here,
// so the tests can run it directly; src/RichMarkdown.jsx renders the result.
//
// - Math: $…$, $$…$$, \(…\) and \[…\] become remark-math nodes, typeset by
//   KaTeX (rehype-katex) once its lazy chunk is in. A dollar sign that reads
//   as money ("$5 and $10") stays a dollar sign (see prepareMath).
// - Diagrams: a ```mermaid block becomes a <rich-diagram> element that
//   src/RichMarkdown.jsx draws with Mermaid (its own lazy chunk) once the
//   block's closing fence has arrived, so a streaming reply never draws half
//   a diagram.
// Nothing here fetches, stores or sends anything.
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";

export const DIAGRAMS_UPDATE = "diagrams";

// ---- Money or math: which dollar signs open math ----
//
// remark-math pairs dollar signs the way Markdown pairs backticks: the next
// "$" closes, whatever surrounds it. Replies are full of prices, so before
// parsing, every "$" that can't be math under Pandoc's rules is escaped:
//   - an opening "$" is followed by a non-space;
//   - its closing "$" follows a non-space and isn't followed by a digit;
//   - the math between them is not empty and has no other "$" in it
//     (remark-math would close there);
//   - neither crosses a blank line.
// So "$5 and $10" and "$5-$10" stay money, while "$x^2$" and "$E = mc^2$" are
// math. "$$…$$" pairs with the next "$$". \(…\) and \[…\] are rewritten as
// $…$ and $$…$$. Code (fenced, indented and inline) and raw HTML are left
// exactly as written: their ranges come from a Markdown parse without math.

const SPACE = /\s/;
const DIGIT = /[0-9]/;
// Whether `pos` starts its line, after at most a block quote or list marker
// and indentation: where remark-math would open or close a display block.
function atLineStart(doc, pos) {
  const from = doc.lastIndexOf("\n", pos - 1) + 1;
  return /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?$/.test(doc.slice(from, pos));
}
const restOfLine = (doc, pos) => {
  const end = doc.indexOf("\n", pos);
  return doc.slice(pos, end < 0 ? doc.length : end);
};
// A blank line at the "\n" at k (paragraphs end there).
function blankAfter(doc, k, limit) {
  let m = k + 1;
  while (m < limit && (doc[m] === " " || doc[m] === "\t")) m++;
  return m >= limit || doc[m] === "\n" || doc[m] === "\r";
}
// Where a "$" run of `run` (1 or 2) at `i` closes: the index just after the
// closer, or -1 if it can't be math. "$$" at the start of a line, with no
// other "$" on it, opens a display block that closes only at a line holding
// just "$$" (as remark-math reads it); anywhere else "$$" is inline and must
// not close at the start of a line.
function closingDollar(doc, i, run, limit) {
  const start = i + run;
  if (start >= limit) return -1;
  if (run === 1 && SPACE.test(doc[start])) return -1;
  const block = run === 2 && atLineStart(doc, i) && !restOfLine(doc, start).includes("$");
  for (let k = start; k < limit; k++) {
    const c = doc[k];
    if (c === "\n") {
      if (!block && blankAfter(doc, k, limit)) return -1;
      continue;
    }
    if (c !== "$") continue;
    let e = k;
    while (e < limit && doc[e] === "$") e++;
    const size = e - k;
    if (size !== run) {
      // Single-dollar math can't hold any other dollar sign; display math
      // may hold single (escaped) ones, e.g. $$\$5$$.
      if (run === 1) return -1;
      k = e - 1;
      continue;
    }
    const lineStart = atLineStart(doc, k);
    if (block) {
      if (!lineStart || restOfLine(doc, e).trim()) {
        k = e - 1;
        continue;
      }
    } else if (run === 2 && lineStart) return -1;
    if (!doc.slice(start, k).trim()) return -1;
    if (run === 1 && (SPACE.test(doc[k - 1]) || DIGIT.test(doc[e] || ""))) return -1;
    return e;
  }
  return -1;
}

// \( … \) or \[ … \] starting just after the opening bracket at `from`: the
// index of the closing backslash, or -1. The closer's backslash must not be
// escaped itself (\\) is a TeX line break).
function closingBracket(doc, from, limit, bracket) {
  for (let k = from; k < limit; k++) {
    const c = doc[k];
    if (c === "\n") {
      if (blankAfter(doc, k, limit)) return -1;
      continue;
    }
    if (c === "$") return -1;
    if (c !== "\\") continue;
    let e = k;
    while (e < limit && doc[e] === "\\") e++;
    if ((e - k) % 2 === 1 && doc[e] === bracket) return e - 1;
    k = e - 1;
  }
  return -1;
}
// Whether \[ at `open` and \] at `close` read the same way once they're
// "$$": a closer at the start of a line only ends a block that opened at the
// start of one, and then it has to be alone on its line.
function bracketsAgree(doc, open, close) {
  if (!atLineStart(doc, close)) return true;
  return atLineStart(doc, open) && !restOfLine(doc, close + 2).trim();
}

// \[…\] is also how Markdown writers escape square brackets ("\[sic\]"), so
// it only counts as display math when it isn't glued to a word and the
// inside looks like math (a command, operator, script, brace or digit).
const LOOKS_LIKE_MATH = /[\\^_=+\-*/<>{}|0-9]/;

// Ranges [start, end) of code, inline code and raw HTML: what prepareMath
// must leave alone. Parsed with GFM (tables, autolinks) but without math, so
// a price can't swallow the code span after it.
const plainParser = unified().use(remarkParse).use(remarkGfm);
export function protectedRanges(doc) {
  const ranges = [];
  const walk = (node) => {
    if (
      (node.type === "code" || node.type === "inlineCode" || node.type === "html") &&
      node.position
    )
      ranges.push([node.position.start.offset, node.position.end.offset]);
    else for (const child of node.children || []) walk(child);
  };
  walk(plainParser.parse(doc));
  return ranges.sort((a, b) => a[0] - b[0]);
}

// Whether a ```math fence is among the protected ranges (rehype-katex draws
// those as display math too).
const MATH_FENCE = /^[ \t>]*(`{3,}|~{3,})[ \t]*math\b/im;

// The reply text as the renderer should parse it, and whether it holds any
// math at all (so KaTeX's chunk is only fetched when there is some).
export function prepareMath(doc, ranges = protectedRanges(doc)) {
  const text = String(doc ?? "");
  let out = "";
  let math = false;
  let r = 0;
  let i = 0;
  while (i < text.length) {
    while (r < ranges.length && ranges[r][1] <= i) r++;
    if (r < ranges.length && ranges[r][0] <= i) {
      const chunk = text.slice(i, ranges[r][1]);
      if (!math && MATH_FENCE.test(chunk)) math = true;
      out += chunk;
      i = ranges[r][1];
      continue;
    }
    const limit = r < ranges.length ? ranges[r][0] : text.length;
    const c = text[i];
    if (c === "\\") {
      let j = i;
      while (j < limit && text[j] === "\\") j++;
      const odd = (j - i) % 2 === 1;
      const next = text[j];
      if (odd && j < limit && (next === "(" || next === "[")) {
        const close = closingBracket(text, j + 1, limit, next === "(" ? ")" : "]");
        const inner = close > 0 ? text.slice(j + 1, close) : "";
        const glued = next === "[" && i > 0 && /\w/.test(text[i - 1]);
        const ok =
          close > 0 &&
          inner.trim() &&
          text[i - 1] !== "$" &&
          text[close + 2] !== "$" &&
          (next === "(" ||
            (!glued && LOOKS_LIKE_MATH.test(inner) && bracketsAgree(text, j - 1, close)));
        if (ok) {
          const fence = next === "(" ? "$" : "$$";
          out += text.slice(i, j - 1) + fence + inner + fence;
          i = close + 2;
          math = true;
          continue;
        }
      }
      // An escaped dollar stays escaped, with its backslash.
      if (odd && next === "$" && j < limit) {
        out += text.slice(i, j + 1);
        i = j + 1;
        continue;
      }
      out += text.slice(i, j);
      i = j;
      continue;
    }
    if (c === "$") {
      let j = i;
      while (j < limit && text[j] === "$") j++;
      const run = j - i;
      const end = run <= 2 ? closingDollar(text, i, run, limit) : -1;
      if (end > 0) {
        out += text.slice(i, end);
        i = end;
        math = true;
        continue;
      }
      out += "\\$".repeat(run);
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return { text: out, math };
}

// The same pairing on a line of plain text (a bookmark's excerpt): pieces of
// text and of math, in order. Unpaired dollar signs stay text.
export function splitMath(value) {
  const text = String(value ?? "");
  const parts = [];
  let buffer = "";
  let i = 0;
  const flush = () => {
    if (buffer) parts.push({ type: "text", value: buffer });
    buffer = "";
  };
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && (text[i + 1] === "$" || text[i + 1] === "\\")) {
      buffer += text.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (c === "\\" && (text[i + 1] === "(" || text[i + 1] === "[")) {
      const close = closingBracket(text, i + 2, text.length, text[i + 1] === "(" ? ")" : "]");
      const inner = close > 0 ? text.slice(i + 2, close) : "";
      if (close > 0 && inner.trim() && (text[i + 1] === "(" || LOOKS_LIKE_MATH.test(inner))) {
        flush();
        parts.push({ type: "math", value: inner.trim() });
        i = close + 2;
        continue;
      }
    }
    if (c === "$") {
      let j = i;
      while (j < text.length && text[j] === "$") j++;
      const run = j - i;
      const end = run <= 2 ? closingDollar(text, i, run, text.length) : -1;
      if (end > 0) {
        flush();
        parts.push({ type: "math", value: text.slice(j, end - run).trim() });
        i = end;
        continue;
      }
      buffer += text.slice(i, j);
      i = j;
      continue;
    }
    buffer += c;
    i++;
  }
  flush();
  return parts;
}

// ---- remark: tidy what remark-math parsed ----
//
// "$$…$$" on a line of its own is display math, even inside a paragraph
// (remark-math only makes a display block when the dollar signs sit on
// their own lines). And "$$x + 1" followed by "$$" on the next line puts
// "x + 1" in the fence's meta, which TeX doesn't have: it's part of the math.
function displayNode(value, position) {
  return {
    type: "math",
    meta: null,
    value,
    position,
    data: {
      hName: "pre",
      hChildren: [
        {
          type: "element",
          tagName: "code",
          properties: { className: ["language-math", "math-display"] },
          children: [{ type: "text", value }],
        },
      ],
    },
  };
}
const endsLine = (node) =>
  !node || node.type === "break" || (node.type === "text" && /\n[ \t]*$/.test(node.value));
const startsLine = (node) =>
  !node || node.type === "break" || (node.type === "text" && /^[ \t]*\n/.test(node.value));
// A paragraph's children split around the display equations in it.
function splitParagraph(paragraph, source) {
  const kids = paragraph.children;
  const out = [];
  let run = [];
  let found = false;
  const flush = () => {
    const kept = run.filter((c) => !(c.type === "text" && !c.value.trim()) && c.type !== "break");
    if (kept.length) out.push({ type: "paragraph", children: run });
    run = [];
  };
  for (let i = 0; i < kids.length; i++) {
    const child = kids[i];
    const start = child.position?.start?.offset;
    const lonely =
      child.type === "inlineMath" &&
      start != null &&
      source.startsWith("$$", start) &&
      endsLine(run.length ? run.at(-1) : null) &&
      startsLine(kids[i + 1]);
    if (!lonely) {
      run.push(child);
      continue;
    }
    found = true;
    const before = run.at(-1);
    if (before?.type === "text") before.value = before.value.replace(/\n[ \t]*$/, "");
    else if (before?.type === "break") run.pop();
    flush();
    out.push(displayNode(child.value, child.position));
    const after = kids[i + 1];
    if (after?.type === "text") after.value = after.value.replace(/^[ \t]*\n/, "");
    else if (after?.type === "break") i++;
  }
  if (!found) return null;
  flush();
  return out;
}
export function remarkMathTidy() {
  return (tree, file) => {
    const source = String(file?.value ?? "");
    const walk = (node) => {
      const children = node.children;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.type === "math" && child.meta) {
          const value = child.meta + (child.value ? "\n" + child.value : "");
          children[i] = displayNode(value, child.position);
          continue;
        }
        if (child.type === "paragraph") {
          const parts = splitParagraph(child, source);
          if (parts) {
            children.splice(i, 1, ...parts);
            i += parts.length - 1;
          }
          continue;
        }
        walk(child);
      }
    };
    walk(tree);
  };
}

// ---- remark: has a code block's closing fence arrived? ----
//
// While a reply streams, a ```mermaid block is open until its closing fence
// comes in; the diagram is drawn only then. The flag rides on the code
// element as data-closed="true".
const FENCE_OPEN = /^[ \t>]*(`{3,}|~{3,})/;
export const DIAGRAM_LANGUAGE = /^mermaid$/i;
export function remarkFenceClosed() {
  return (tree, file) => {
    const source = String(file?.value ?? "");
    const walk = (node) => {
      if (node.type === "code") {
        if (!DIAGRAM_LANGUAGE.test(node.lang || "")) return;
        const start = node.position?.start?.offset;
        const end = node.position?.end?.offset;
        if (start == null || end == null) return;
        const lines = source.slice(start, end).split("\n");
        const open = lines[0].match(FENCE_OPEN)?.[1];
        const last = lines.at(-1);
        const close = last.match(/^[ \t>]*(`{3,}|~{3,})[ \t]*$/)?.[1];
        const closed =
          lines.length >= 2 &&
          !!open &&
          !!close &&
          close[0] === open[0] &&
          close.length >= open.length;
        if (closed)
          node.data = {
            ...node.data,
            hProperties: { ...node.data?.hProperties, dataClosed: "true" },
          };
        return;
      }
      for (const child of node.children || []) walk(child);
    };
    walk(tree);
  };
}

// ---- rehype: wrap math and diagrams for their React components ----
//
// Math becomes <rich-math> (inline) or <rich-math-block> (display) around
// what remark-math made, carrying its TeX; rehype-katex then typesets inside
// the wrapper. A ```mermaid block becomes <rich-diagram> around its <pre>,
// which stays as the fallback. Typeset math is kept in a small cache so a
// streaming reply doesn't typeset the same equation on every chunk.

const classesOf = (el) =>
  [].concat(el?.properties?.className || []).map(String);
export const hastText = (node) =>
  node?.type === "text"
    ? node.value
    : (node?.children || []).map(hastText).join("");
const TYPESET_LIMIT = 400;
const typeset = new Map();
const cacheKey = (tex, display) => (display ? "D" : "I") + tex;
function remember(key, children) {
  if (typeset.has(key)) typeset.delete(key);
  typeset.set(key, children);
  if (typeset.size > TYPESET_LIMIT) typeset.delete(typeset.keys().next().value);
}
const clone = (v) =>
  typeof structuredClone === "function" ? structuredClone(v) : JSON.parse(JSON.stringify(v));

export function rehypeRichWrap({ katex = false } = {}) {
  return (tree) => {
    const walk = (node) => {
      const children = node.children;
      if (!children) return;
      for (let i = 0; i < children.length; i++) {
        const el = children[i];
        if (el.type !== "element") continue;
        if (el.tagName === "pre") {
          const code = el.children.find(
            (c) => c.type === "element" && c.tagName === "code",
          );
          const classes = classesOf(code);
          if (classes.includes("language-math")) {
            const tex = hastText(code).replace(/\n$/, "");
            const key = cacheKey(tex, true);
            children[i] = {
              type: "element",
              tagName: "rich-math-block",
              properties: { dataTex: tex },
              children: katex && typeset.has(key) ? clone(typeset.get(key)) : [el],
              position: el.position,
            };
            continue;
          }
          if (classes.some((c) => /^language-mermaid$/i.test(c))) {
            children[i] = {
              type: "element",
              tagName: "rich-diagram",
              properties: {
                dataSource: hastText(code).replace(/\n$/, ""),
                dataClosed: code.properties?.dataClosed === "true" ? "true" : "false",
              },
              children: [el],
              position: el.position,
            };
            continue;
          }
        }
        if (el.tagName === "code" && classesOf(el).includes("math-inline")) {
          const tex = hastText(el);
          const key = cacheKey(tex, false);
          children[i] = {
            type: "element",
            tagName: "rich-math",
            properties: { dataTex: tex },
            children: katex && typeset.has(key) ? clone(typeset.get(key)) : [el],
            position: el.position,
          };
          continue;
        }
        walk(el);
      }
    };
    walk(tree);
  };
}
// After rehype-katex: keep what it made for next time, and mark any wrapper
// whose TeX KaTeX couldn't read.
export function rehypeRichRemember() {
  return (tree) => {
    const walk = (node) => {
      for (const el of node.children || []) {
        if (el.type !== "element") continue;
        if (el.tagName === "rich-math" || el.tagName === "rich-math-block") {
          const display = el.tagName === "rich-math-block";
          const typesetDone = el.children.some(
            (c) => c.type === "element" && classesOf(c).some((k) => k.startsWith("katex")),
          );
          if (typesetDone) {
            if (hasClass(el, "katex-error")) el.properties.dataError = "true";
            else remember(cacheKey(el.properties.dataTex, display), clone(el.children));
          }
          continue;
        }
        walk(el);
      }
    };
    walk(tree);
  };
}
function hasClass(node, name) {
  if (node.type !== "element") return false;
  if (classesOf(node).includes(name)) return true;
  return node.children.some((c) => hasClass(c, name));
}

// KaTeX, set for text from a model: no \href, \url, \includegraphics or HTML
// extensions (trust: false), no network, bounded size and macro expansion,
// and errors shown as the TeX itself in the text colour.
export const KATEX_OPTIONS = {
  trust: false,
  strict: "ignore",
  maxSize: 25,
  maxExpand: 500,
  errorColor: "inherit",
  output: "htmlAndMathml",
};

// ---- Mermaid ----

// The site's sans, as in src/styles.css (--font).
export const DIAGRAM_FONT =
  '"GFS Neohellenic", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", sans-serif';

// The house theme: white nodes ruled in cobalt, ink text, cobalt lines and
// the brand's yellow as the accent (notes, second series, highlights). Flat.
const COBALT = "#0135df";
const DEEP = "#061b69";
const INK = "#18233f";
const YELLOW = "#ffb21c";
const PALE_YELLOW = "#fff3d6";
const PALE_COBALT = "#eef3ff";
const LINE = "#c9d6f5";
export const DIAGRAM_THEME = {
  fontFamily: DIAGRAM_FONT,
  fontSize: "15px",
  background: "#ffffff",
  primaryColor: "#ffffff",
  primaryBorderColor: COBALT,
  primaryTextColor: INK,
  secondaryColor: PALE_YELLOW,
  secondaryBorderColor: YELLOW,
  secondaryTextColor: INK,
  tertiaryColor: PALE_COBALT,
  tertiaryBorderColor: LINE,
  tertiaryTextColor: INK,
  mainBkg: "#ffffff",
  nodeBorder: COBALT,
  nodeTextColor: INK,
  lineColor: COBALT,
  textColor: INK,
  titleColor: DEEP,
  clusterBkg: PALE_COBALT,
  clusterBorder: LINE,
  edgeLabelBackground: "#ffffff",
  // Sequence diagrams
  actorBkg: COBALT,
  actorBorder: COBALT,
  actorTextColor: "#ffffff",
  actorLineColor: LINE,
  signalColor: INK,
  signalTextColor: INK,
  labelBoxBkgColor: PALE_COBALT,
  labelBoxBorderColor: COBALT,
  labelTextColor: INK,
  loopTextColor: INK,
  activationBkgColor: PALE_COBALT,
  activationBorderColor: COBALT,
  sequenceNumberColor: "#ffffff",
  noteBkgColor: PALE_YELLOW,
  noteBorderColor: YELLOW,
  noteTextColor: INK,
  // Pie charts and other series
  pie1: COBALT,
  pie2: YELLOW,
  pie3: DEEP,
  pie4: "#7d9cf0",
  pie5: "#ffd88a",
  pie6: "#3c63e8",
  pie7: "#b9c9f7",
  pie8: "#e6a019",
  pieStrokeColor: "#ffffff",
  pieStrokeWidth: "2px",
  pieOuterStrokeColor: COBALT,
  pieOuterStrokeWidth: "1px",
  pieTitleTextColor: DEEP,
  pieSectionTextColor: "#ffffff",
  pieLegendTextColor: INK,
  // Gantt
  sectionBkgColor: PALE_COBALT,
  altSectionBkgColor: "#ffffff",
  sectionBkgColor2: PALE_YELLOW,
  taskBkgColor: COBALT,
  taskBorderColor: DEEP,
  taskTextColor: "#ffffff",
  taskTextLightColor: "#ffffff",
  taskTextOutsideColor: INK,
  activeTaskBkgColor: YELLOW,
  activeTaskBorderColor: "#c98700",
  doneTaskBkgColor: "#b9c9f7",
  doneTaskBorderColor: COBALT,
  critBkgColor: YELLOW,
  critBorderColor: "#c98700",
  todayLineColor: YELLOW,
  gridColor: LINE,
  // State and class diagrams
  labelColor: INK,
  altBackground: PALE_COBALT,
  compositeBackground: PALE_COBALT,
  compositeTitleBackground: "#ffffff",
  classText: INK,
  pieOpacity: "1",
  // Git graphs, mind maps and timelines cycle through the same few colours,
  // each with a label colour that reads on it.
  ...cycle(),
  fillType0: PALE_COBALT,
  fillType1: PALE_YELLOW,
};
function cycle() {
  const fills = [COBALT, YELLOW, DEEP, "#7d9cf0", "#ffd88a", "#3c63e8", "#b9c9f7", "#e6a019"];
  const labels = ["#ffffff", INK, "#ffffff", INK, INK, "#ffffff", INK, INK];
  const out = {};
  for (let i = 0; i < 12; i++) {
    const k = i % fills.length;
    out["cScale" + i] = fills[k];
    out["cScaleLabel" + i] = labels[k];
    if (i < 8) {
      out["git" + i] = fills[k];
      out["gitBranchLabel" + i] = labels[k];
    }
  }
  return out;
}

// Config keys a diagram may not change, even if a directive slipped through
// (they're stripped first, see diagramSource): security, labels, the theme,
// fonts and limits.
const LOCKED = [
  "secure",
  "securityLevel",
  "startOnLoad",
  "maxTextSize",
  "maxEdges",
  "suppressErrorRendering",
  "htmlLabels",
  "theme",
  "themeVariables",
  "themeCSS",
  "fontFamily",
  "altFontFamily",
  "darkMode",
  "flowchart",
  "class",
  "state",
  "er",
  "look",
  "handDrawnSeed",
  "fontSize",
  "dompurifyConfig",
  "deterministicIds",
  "deterministicIDSeed",
  "elk",
  "layout",
  "wrap",
];
// A little of the house style Mermaid's theme variables don't reach: solid
// edge-label grounds and slightly firmer lines. Our CSS, not the diagram's.
export const DIAGRAM_CSS =
  ".edgeLabel rect{opacity:1}" +
  ".node rect,.node polygon,.node circle,.node ellipse,.node path{stroke-width:1.5px}" +
  ".flowchart-link{stroke-width:1.5px}";
export const DIAGRAM_CONFIG = {
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false, useMaxWidth: true, padding: 12, nodeSpacing: 40, rankSpacing: 40 },
  class: { htmlLabels: false },
  state: { useMaxWidth: true },
  sequence: { useMaxWidth: true, mirrorActors: false },
  theme: "base",
  themeVariables: DIAGRAM_THEME,
  themeCSS: DIAGRAM_CSS,
  fontFamily: DIAGRAM_FONT,
  suppressErrorRendering: true,
  deterministicIds: false,
  maxTextSize: 20000,
  maxEdges: 400,
  secure: LOCKED,
};
// Longest diagram source drawn (characters); longer ones stay as code.
export const MAX_DIAGRAM_SOURCE = DIAGRAM_CONFIG.maxTextSize;

// The diagram as Mermaid gets it: without %%{init}%% directives or a
// front-matter config block, which could restyle it or turn settings back
// on. A front-matter title is kept.
export function diagramSource(source) {
  let text = String(source ?? "").replace(/\r\n?/g, "\n");
  const front = text.match(/^\s*---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/);
  if (front) {
    const title = front[1].match(/^title:[ \t]*(.+)$/m)?.[1]?.trim();
    text =
      (title ? `---\ntitle: ${title.replace(/[\r\n]/g, " ")}\n---\n` : "") +
      text.slice(front[0].length);
  }
  return text.replace(/%%\{[\s\S]*?\}%%/g, "").trim();
}

// CSS inside a drawn diagram (its <style> and style="" attributes) may point
// only inside the SVG: no @import, and url() only as url(#id).
export function cleanDiagramCss(css) {
  return String(css ?? "")
    .replace(/@import[^;]*;?/gi, "")
    .replace(/url\(\s*(['"]?)(?!#)[^)]*\)/gi, "none")
    .replace(/expression\s*\(/gi, "(");
}

// What a diagram's file is called when it's downloaded.
export const DIAGRAM_FILENAME = "diagram.png";
