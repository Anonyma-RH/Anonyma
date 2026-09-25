#!/usr/bin/env node
// Builds src/i18n/zh.json, the English → Simplified Chinese dictionary behind the
// language switch. The English source stays as it is; the runtime maps what the
// page shows. The dictionary comes from the in-place translation on feature/zh-cn.
//
//   node scripts/i18n-extract.mjs [--pairs <dir>]   rebuild src/i18n/zh.json
//   node scripts/i18n-extract.mjs --report          coverage of the committed dictionary
//   options: --base <rev> (English, default db8be71), --zh <rev> (Chinese, default 8e1c8f5),
//            --why "<english>" (print every pairing found for one key)
//
// Both versions of every changed file are parsed and walked in parallel. Where the
// translator restructured a sentence, the literals of the nearest differing node are
// aligned instead; what stays ambiguous goes to runtime/i18n-extract-report.txt and
// is settled in the hand tables below. Templates, string concatenations and elements
// holding only text and expressions become patterns with numbered captures, with the
// string choices inside them expanded.
//
// --pairs cross-checks against the translator's own pair files (extracted/, results/,
// missed/, releases-map.json). They rank above literals that were only aligned; the
// translated source ranks above them, since fixes were made there afterwards. With the
// hand tables in place, the output is the same with or without them.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@babel/parser";

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const BASE = opt("--base", "db8be71");
const ZH = opt("--zh", "8e1c8f5");
const PAIRS = opt("--pairs", process.env.I18N_PAIRS || "");
const OUT = "src/i18n/zh.json";
const REPORT_FILE = "runtime/i18n-extract-report.txt";

// ---------------------------------------------------------------- text helpers
const HAN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_EDGE = "\\u3000-\\u303f\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef\\u201c\\u201d\\u2018\\u2019";
const hasCJK = (s) => HAN.test(s);
const norm = (s) => String(s).replace(/\s+/g, " ").trim();
// Chinese wording: collapsed whitespace, no space between two Chinese characters
// (a wrapped JSX line) or next to full-width punctuation, and the informal "you"
// the translation settled on.
const FULL_PUNCT = "\\u3001\\u3002\\uff0c\\uff1a\\uff1b\\uff01\\uff1f\\uff08\\uff09";
const normZh = (s) =>
  norm(s)
    .replace(new RegExp(`([${CJK_EDGE}]) (?=[${CJK_EDGE}])`, "g"), "$1")
    .replace(new RegExp(`([${FULL_PUNCT}]) | (?=[${FULL_PUNCT}])`, "g"), "$1")
    .replace(/您/g, "你");
const anon = (s) => s.replace(/\{\d+\}/g, "{}");

// Visible English: words, not identifiers, paths, URLs, CSS or code.
function looksLikeCode(s) {
  const t = s.trim();
  if (/^(https?:|mailto:|data:|www\.)|:\/\//.test(t)) return true;
  if (/^[/.#?~][\w./#?=&%-]*$/.test(t)) return true;
  if (/^[a-z0-9]+([_\-.:/@+][a-z0-9]+)+$/.test(t)) return true;
  if (/^[a-z]+[A-Z][A-Za-z0-9]*$/.test(t)) return true;
  if (/^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(t)) return true;
  // Braces, arrows, tags, statement ends and CSS functions, unless they sit inside a
  // sentence (a prose paragraph may quote {id: "web"}); a semicolon in prose is fine.
  const code = t.replace(/\{\d+\}/g, "");
  const words = (code.match(/[A-Za-z]{2,}/g) || []).length;
  if (words < 8 && /=>|[{}]|<\/?[a-z]|;\s*($|[}\n])|\b(var|calc|rgba?|url|translate)\(|\b\d+(px|rem|em|vh|vw|ms)\b/.test(code)) return true;
  return false;
}
const isNatural = (s) => {
  const t = norm(s).replace(/\{\d+\}/g, " ");
  return /[A-Za-z]{2}/.test(t) && !hasCJK(t) && !looksLikeCode(norm(s));
};

// ------------------------------------------------------------------ git + AST
const git = (...args) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const show = (rev, file) => {
  try {
    return git("show", `${rev}:${file}`);
  } catch {
    return null;
  }
};
const parseCode = (code) =>
  parse(code, { sourceType: "module", plugins: ["jsx"], errorRecovery: true });

const SKIP_KEYS = new Set([
  "type", "start", "end", "loc", "range", "extra", "leadingComments", "trailingComments",
  "innerComments", "comments", "tokens", "errors",
]);
const isNode = (v) => !!v && typeof v === "object" && typeof v.type === "string";
function kids(node) {
  const out = [];
  for (const k of Object.keys(node)) {
    if (SKIP_KEYS.has(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) for (const x of v) isNode(x) && out.push(x);
    else if (isNode(v)) out.push(v);
  }
  return out.sort((a, b) => a.start - b.start);
}
const jsxName = (n) =>
  !n ? "" : n.type === "JSXIdentifier" ? n.name : n.type === "JSXNamespacedName" ? `${n.namespace.name}:${n.name.name}` : `${jsxName(n.object)}.${jsxName(n.property)}`;
const LOCALE_CALLS = new Set(["toLocaleString", "toLocaleDateString", "toLocaleTimeString"]);

// Structure with string contents masked, so a translated node still matches its original.
const shapes = new WeakMap();
function shape(node) {
  if (!isNode(node)) return "";
  if (shapes.has(node)) return shapes.get(node);
  let s;
  switch (node.type) {
    case "StringLiteral":
    case "JSXText":
    case "TemplateElement":
      s = "S";
      break;
    case "Identifier":
    case "JSXIdentifier":
      s = node.name;
      break;
    case "NumericLiteral":
      s = String(node.value);
      break;
    case "CallExpression":
      // Locale arguments ("zh-CN" versus undefined) are part of the translation.
      if (node.callee.type === "MemberExpression" && LOCALE_CALLS.has(node.callee.property?.name)) {
        s = `${shape(node.callee)}(L)`;
        break;
      }
    // falls through
    default: {
      const parts = [];
      for (const k of Object.keys(node)) {
        if (SKIP_KEYS.has(k)) continue;
        let v = node[k];
        if (k === "children" && Array.isArray(v)) v = meaningful(v);
        if (Array.isArray(v)) parts.push(`${k}[${v.map(shape).join(",")}]`);
        else if (isNode(v)) parts.push(`${k}:${shape(v)}`);
        else if (typeof v === "string" || typeof v === "boolean") parts.push(`${k}=${v}`);
      }
      s = `${node.type}{${parts.join(";")}}`;
    }
  }
  shapes.set(node, s);
  return s;
}
// JSX children that render something: whitespace text and {" "} carry no words.
const meaningful = (children) =>
  children.filter(
    (c) =>
      !(c.type === "JSXText" && !c.value.trim()) &&
      !(c.type === "JSXExpressionContainer" &&
        (c.expression.type === "JSXEmptyExpression" ||
          (c.expression.type === "StringLiteral" && !c.expression.value.trim()))),
  );

// Every literal under a node, in source order.
// frag: inside a template or concatenation, so only ever part of a longer string.
function collect(node, out = [], attr = null, frag = false) {
  if (!isNode(node)) return out;
  switch (node.type) {
    case "JSXText": {
      const t = norm(node.value);
      if (t) out.push({ kind: "text", text: t, node, frag });
      return out;
    }
    case "StringLiteral":
      out.push({ kind: attr ? "attr" : "string", attr, text: node.value, node, frag });
      return out;
    case "TemplateLiteral":
      out.push({ kind: "template", text: templateText(node), node, frag });
      break;
    case "ImportDeclaration":
    case "ExportAllDeclaration":
    case "Directive":
      return out;
    case "JSXAttribute":
      return collect(node.value, out, jsxName(node.name), frag);
  }
  const inner = frag || isComposite(node);
  for (const c of kids(node)) if (c.type !== "TemplateElement") collect(c, out, attr, inner);
  return out;
}
const templateText = (t) =>
  t.quasis.map((q, i) => (q.value.cooked ?? q.value.raw) + (i < t.expressions.length ? `{${i}}` : "")).join("");

// ------------------------------------------------------- templates → patterns
// A template or concatenation flattens into alternatives: each alternative is a list
// of text and capture parts plus the string choices taken to produce it.
const MAX_ALTS = 64;
const stringish = (e) =>
  !!e &&
  (e.type === "StringLiteral" ||
    e.type === "TemplateLiteral" ||
    (e.type === "BinaryExpression" && e.operator === "+" && (stringish(e.left) || stringish(e.right))) ||
    (e.type === "ConditionalExpression" && (stringish(e.consequent) || stringish(e.alternate))) ||
    (e.type === "LogicalExpression" && ["||", "??"].includes(e.operator) && stringish(e.right)));
// WorkspaceHome's plural(n, one, many = one + "s"); on zh-cn, plural(n, unit).
const isPlural = (e) =>
  e.type === "CallExpression" && e.callee.type === "Identifier" && e.callee.name === "plural" &&
  e.arguments.length >= 2 && e.arguments.slice(1).every((a) => a.type === "StringLiteral");
const isComposite = (e) =>
  e.type === "TemplateLiteral" || isPlural(e) || (e.type === "BinaryExpression" && e.operator === "+" && stringish(e));
// JSX text as React renders it: lines trimmed where they wrap, joined by one space.
function jsxRendered(value) {
  const lines = value.split(/\r\n|\n|\r/);
  let last = 0;
  lines.forEach((l, i) => /[^ \t]/.test(l) && (last = i));
  let out = "";
  lines.forEach((line, i) => {
    let t = line.replace(/\t/g, " ");
    if (i > 0) t = t.replace(/^ +/, "");
    if (i < lines.length - 1) t = t.replace(/ +$/, "");
    if (t) out += t + (i !== last ? " " : "");
  });
  return out;
}
// An element whose children are only text and expressions renders as one run of
// text nodes; its textContent gets a pattern of its own.
function leafRun(el) {
  if (el.type !== "JSXElement" && el.type !== "JSXFragment") return null;
  if (meaningful(el.children).length < 2) return null;
  // {" "} and same-line spaces still render, so they stay in the run.
  const children = el.children.filter((c) => !(c.type === "JSXExpressionContainer" && c.expression.type === "JSXEmptyExpression"));
  const jsxInside = (n) => isNode(n) && (n.type === "JSXElement" || n.type === "JSXFragment" || kids(n).some(jsxInside));
  if (!children.every((c) => c.type === "JSXText" || (c.type === "JSXExpressionContainer" && !jsxInside(c.expression)))) return null;
  if (!children.some((c) => c.type === "JSXText" && /[A-Za-z\u3400-\u9fff]/.test(c.value))) return null;
  return { type: "JSXRun", children, loc: el.loc, start: el.start, end: el.end };
}
const one = (parts, sig = {}) => [{ parts, sig }];
function product(A, B) {
  if (!A || !B) return null;
  const out = [];
  for (const a of A)
    for (const b of B) {
      if (Object.keys(b.sig).some((k) => k in a.sig && a.sig[k] !== b.sig[k])) continue;
      out.push({ parts: [...a.parts, ...b.parts], sig: { ...a.sig, ...b.sig } });
    }
  return out.length > MAX_ALTS ? null : out;
}
const withSig = (alts, k, v) => alts && alts.map((a) => ({ parts: a.parts, sig: { ...a.sig, [k]: v } }));
const cap = (node) => ({ cap: shape(node), node });
function flatten(e) {
  switch (e.type) {
    case "StringLiteral":
      return one([{ t: e.value }]);
    case "TemplateLiteral": {
      let alts = one([{ t: e.quasis[0].value.cooked ?? "" }]);
      e.expressions.forEach((x, i) => {
        alts = product(alts, flatten(x));
        alts = product(alts, one([{ t: e.quasis[i + 1].value.cooked ?? "" }]));
      });
      return alts;
    }
    case "BinaryExpression":
      if (e.operator === "+" && stringish(e)) return product(flatten(e.left), flatten(e.right));
      break;
    case "ConditionalExpression":
      if (stringish(e)) {
        const k = "?" + shape(e.test);
        const a = withSig(flatten(e.consequent), k, 0);
        const b = withSig(flatten(e.alternate), k, 1);
        return a && b && a.length + b.length <= MAX_ALTS ? [...a, ...b] : null;
      }
      break;
    case "JSXRun":
      return e.children.reduce((alts, c) => {
        if (c.type === "JSXText") return product(alts, one([{ t: jsxRendered(c.value) }]));
        const x = c.expression;
        // {cond && value} renders nothing when cond is false.
        if (x.type === "LogicalExpression" && x.operator === "&&") {
          const k = "&&" + shape(x.left);
          const b = withSig(flatten(x.right), k, 1);
          return product(alts, b && [...withSig(one([]), k, 0), ...b]);
        }
        return product(alts, flatten(x));
      }, one([]));
    case "JSXEmptyExpression":
      return one([]);
    case "LogicalExpression":
      // In JSX, cond && "text" renders nothing or the text.
      if (e.operator === "&&" && stringish(e.right)) {
        const k = "&&" + shape(e.left);
        const b = withSig(flatten(e.right), k, 1);
        return b && [...withSig(one([]), k, 0), ...b];
      }
      if (stringish(e)) {
        const k = e.operator + shape(e.left);
        const b = withSig(flatten(e.right), k, 1);
        return b && [...withSig(one([cap(e.left)]), k, 0), ...b];
      }
      break;
    case "CallExpression":
      if (isPlural(e)) {
        const [n, ...forms] = e.arguments;
        const k = "plural" + shape(n);
        const words = forms.length === 1 && !hasCJK(forms[0].value)
          ? [forms[0].value, forms[0].value + "s"]
          : forms.map((f) => f.value);
        return words.map((w, i) => ({ parts: [cap(n), { t: " " + w }], sig: words.length > 1 ? { [k]: i } : {} }));
      }
      break;
  }
  return one([cap(e)]);
}
const compatible = (a, b) => Object.keys(a).every((k) => !(k in b) || b[k] === a[k]);
// Pair English and Chinese alternatives, then number the captures in English order.
function patternsFor(enNode, zhNode) {
  const E = flatten(enNode);
  const Z = flatten(zhNode);
  if (!E || !Z) return { error: "too many string combinations" };
  const out = [];
  for (const [i, ea] of E.entries()) {
    let zs = Z.filter((z) => compatible(ea.sig, z.sig) && compatible(z.sig, ea.sig));
    if (zs.length !== 1 && E.length === Z.length) zs = [Z[i]];
    if (zs.length !== 1) return { error: `no single Chinese form for an English form (${zs.length})` };
    const za = zs[0];
    const ec = ea.parts.filter((p) => p.cap);
    const zc = za.parts.filter((p) => p.cap);
    if (ec.length !== zc.length) return { error: `capture count differs (${ec.length} vs ${zc.length})` };
    const index = new Map();
    const used = new Set();
    ec.forEach((p, n) => {
      const j = zc.findIndex((q, m) => !used.has(m) && q.cap === p.cap);
      if (j >= 0) {
        used.add(j);
        index.set(zc[j], n);
      }
    });
    // Captures whose code changed with the translation keep their relative order.
    const restZ = zc.filter((q, m) => !used.has(m));
    const restE = ec.map((p, n) => n).filter((n) => ![...index.values()].includes(n));
    restZ.forEach((q, m) => index.set(q, restE[m]));
    const render = (parts, num) => parts.map((p) => (p.cap ? `{${num(p)}}` : p.t)).join("");
    out.push({ en: norm(render(ea.parts, (p) => ec.indexOf(p))), zh: normZh(render(za.parts, (q) => index.get(q))) });
  }
  return { patterns: out };
}

// --------------------------------------------------------------- pairing walk
function pairFile(file, enCode, zhCode, sink) {
  const ctx = { file, sink, enCode, zhCode };
  walk(parseCode(enCode).program, parseCode(zhCode).program, ctx, false);
}
const lineOf = (node) => node?.loc?.start?.line ?? 0;
function record(ctx, en, zh, how, node, extra = {}) {
  ctx.sink.pairs.push({ en, zh, how, file: ctx.file, line: lineOf(node), ...extra });
}
function leaf(ctx, en, zh, node, how, fragment) {
  if (isMarkdown(en) && isMarkdown(zh)) {
    const E = markdownRuns(en);
    const Z = markdownRuns(zh);
    if (E.length !== Z.length)
      return ctx.sink.ambiguous.push({ file: ctx.file, line: lineOf(node), why: "markdown blocks differ", en: E, zh: Z });
    return E.forEach((e, i) => leaf(ctx, e, Z[i], node, how, fragment));
  }
  if (hasCJK(zh) && isNatural(en)) record(ctx, norm(en), normZh(zh), how, node, { fragment });
  // Changed, but not into Chinese (a dropped word); the dictionary cannot hold these.
  else if (isNatural(en) && norm(en) !== norm(zh) && !fragment)
    ctx.sink.latin.push(`${ctx.file}:${lineOf(node)} ${JSON.stringify(norm(en))} → ${JSON.stringify(norm(zh))}`);
}
// Sample replies are Markdown, rendered block by block with bold spans as their own
// text nodes; code blocks stay as they are.
const isMarkdown = (s) => /\n\n|\*\*|```/.test(s);
function markdownRuns(s) {
  const out = [];
  for (let block of s.replace(/```[\s\S]*?```/g, "\n\n").split(/\n{2,}|\n(?=\d+\. |[-*] |#)/)) {
    block = block.replace(/^#+\s*/, "").replace(/^(\d+\.|[-*])\s+/, "");
    for (const part of block.split("**")) if (norm(part)) out.push(norm(part));
  }
  return out;
}
function composite(ctx, a, b, how, fragment = false) {
  const { patterns, error } = patternsFor(a, b);
  if (error) {
    if (hasCJK(collect(b).map((x) => x.text).join("")))
      ctx.sink.ambiguous.push({ file: ctx.file, line: lineOf(a), why: error, en: [templateOrSource(ctx.enCode, a)], zh: [templateOrSource(ctx.zhCode, b)] });
    return;
  }
  for (const p of patterns) {
    if (!hasCJK(p.zh) || !isNatural(p.en)) continue;
    record(ctx, p.en, p.zh, how, a, { pattern: /\{\d+\}/.test(p.en), fragment });
  }
}
const templateOrSource = (code, node) => code.slice(node.start, node.end).replace(/\s+/g, " ").slice(0, 300);

function walk(a, b, ctx, inComposite) {
  if (!isNode(a) || !isNode(b)) {
    if (isNode(a) || isNode(b)) align(collect(a), collect(b), ctx, a || b, inComposite);
    return;
  }
  if (a.type !== b.type) return align(collect(a), collect(b), ctx, a, inComposite);
  // Inside arrays of different lengths the pairing is a guess, however alike the nodes.
  const how = ctx.loose ? "aligned" : "source";
  if (a.type === "JSXText") return leaf(ctx, a.value, b.value, a, how, inComposite);
  if (a.type === "StringLiteral") return leaf(ctx, a.value, b.value, a, how, inComposite);
  if (!inComposite && isComposite(a) && isComposite(b)) {
    composite(ctx, a, b, how);
    inComposite = true;
  }
  const runA = !inComposite && leafRun(a);
  const runB = runA && leafRun(b);
  if (runA && runB) composite(ctx, runA, runB, how);
  if (a.type === "TemplateLiteral") return pairExpressions(a.expressions, b.expressions, ctx);
  // Joined list items ("Enabled: Chat, Dashboard, …") are each a unit of their own.
  if (a.type === "ArrayExpression") inComposite = false;
  for (const key of Object.keys(a)) {
    if (SKIP_KEYS.has(key)) continue;
    let va = a[key];
    let vb = b[key];
    if (Array.isArray(va) && Array.isArray(vb)) {
      if (key === "children") {
        va = meaningful(va);
        vb = meaningful(vb);
      }
      alignArrays(va.filter(isNode), vb.filter(isNode), ctx, inComposite);
    } else if (isNode(va) || isNode(vb)) walk(va, vb, ctx, inComposite);
  }
}
// The name a declaration, property or export introduces.
function ident(n) {
  switch (n.type) {
    case "FunctionDeclaration":
    case "ClassDeclaration":
      return n.id && `${n.type}:${n.id.name}`;
    case "VariableDeclaration":
      return "var:" + n.declarations.map((d) => shape(d.id)).join(",");
    case "ExportNamedDeclaration":
    case "ExportDefaultDeclaration":
      return n.declaration && ident(n.declaration) && `export:${ident(n.declaration)}`;
    case "ObjectProperty":
    case "ObjectMethod":
      return !n.computed && `prop:${n.key.name ?? n.key.value}`;
  }
  return null;
}
// Template expressions may be reordered by the translation: match them by shape.
function pairExpressions(A, B, ctx) {
  const used = new Set();
  const left = [];
  for (const x of A) {
    const j = B.findIndex((y, i) => !used.has(i) && shape(y) === shape(x));
    if (j >= 0) {
      used.add(j);
      walk(x, B[j], ctx, true);
    } else left.push(x);
  }
  const restB = B.filter((y, i) => !used.has(i));
  if (left.length === restB.length) left.forEach((x, i) => walk(x, restB[i], ctx, true));
  else align(left.flatMap((x) => collect(x)), restB.flatMap((y) => collect(y)), ctx, A[0], true);
}
function alignArrays(A, B, ctx, inComposite) {
  if (A.length === B.length && A.every((x, i) => x.type === B[i].type)) {
    A.forEach((x, i) => walk(x, B[i], ctx, inComposite));
    return;
  }
  // Longest alignment: identical shapes score highest, then the same declaration or
  // property name, then the same element, then the same type.
  const sim = (x, y) => {
    if (x.type !== y.type) return -1;
    if (shape(x) === shape(y)) return 4;
    if (ident(x) && ident(x) === ident(y)) return 3;
    if (x.type === "JSXElement") return jsxName(x.openingElement.name) === jsxName(y.openingElement.name) ? 2 : 1;
    return 1;
  };
  // A match is safe only when its key is unique on both sides.
  const keyOf = (x, s) => (s === 4 ? "4" + shape(x) : s === 3 ? "3" + ident(x) : null);
  const count = (list, k, s) => list.filter((z) => keyOf(z, s) === k).length;
  const safe = (x, y, s) => {
    const k = keyOf(x, s);
    return k !== null && count(A, k, s) === 1 && count(B, k, s) === 1;
  };
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) {
      const s = sim(A[i], B[j]);
      dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1], s > 0 ? s + dp[i + 1][j + 1] : -Infinity);
    }
  let i = 0;
  let j = 0;
  let runA = [];
  let runB = [];
  const flush = () => {
    if (runA.length || runB.length)
      align(runA.flatMap((x) => collect(x)), runB.flatMap((y) => collect(y)), ctx, runA[0] || runB[0], inComposite);
    runA = [];
    runB = [];
  };
  while (i < n && j < m) {
    const s = sim(A[i], B[j]);
    if (s > 0 && dp[i][j] === s + dp[i + 1][j + 1]) {
      flush();
      const guess = !safe(A[i], B[j], s);
      if (guess) ctx.loose = (ctx.loose || 0) + 1;
      walk(A[i++], B[j++], ctx, inComposite);
      if (guess) ctx.loose--;
    } else if (dp[i][j] === dp[i + 1][j]) runA.push(A[i++]);
    else runB.push(B[j++]);
  }
  runA.push(...A.slice(i));
  runB.push(...B.slice(j));
  flush();
}
// Where the trees differ: anchor on literals that did not change, then pair the
// translated literals between anchors when the counts agree.
function align(E, Z, ctx, node, inComposite) {
  const n = E.length;
  const m = Z.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = E[i].text === Z[j].text ? 1 + dp[i + 1][j + 1] : Math.max(dp[i + 1][j], dp[i][j + 1]);
  let i = 0;
  let j = 0;
  let segE = [];
  let segZ = [];
  const flush = () => {
    const e = segE.filter((x) => isNatural(x.text));
    const z = segZ.filter((x) => hasCJK(x.text));
    segE = [];
    segZ = [];
    if (!z.length) return;
    if (e.length === z.length) {
      e.forEach((x, k) => {
        const y = z[k];
        if (x.kind === "template" || y.kind === "template") {
          if (x.kind === "template" && y.kind === "template") composite(ctx, x.node, y.node, "aligned", inComposite || x.frag);
          else
            ctx.sink.ambiguous.push({ file: ctx.file, line: lineOf(x.node), why: "template paired with a plain string", en: [x.text], zh: [y.text] });
        } else leaf(ctx, x.text, y.text, x.node, "aligned", inComposite || x.frag);
      });
    } else if (!e.length)
      ctx.sink.added.push({ file: ctx.file, line: lineOf(node), zh: z.map((x) => x.text) });
    else
      ctx.sink.ambiguous.push({
        file: ctx.file,
        line: lineOf(node),
        why: `${e.length} English vs ${z.length} Chinese literals`,
        en: e.map((x) => x.text),
        zh: z.map((x) => x.text),
      });
  };
  while (i < n && j < m) {
    if (E[i].text === Z[j].text) {
      flush();
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) segE.push(E[i++]);
    else segZ.push(Z[j++]);
  }
  segE.push(...E.slice(i));
  segZ.push(...Z.slice(j));
  flush();
}

// ------------------------------------------------------------------ index.html
function pairHtml(enHtml, zhHtml, sink) {
  const grab = (html, re) => html.match(re)?.[1];
  for (const re of [/<title>([^<]*)<\/title>/, /<meta name="description" content="([^"]*)"/]) {
    const en = grab(enHtml, re);
    const zh = grab(zhHtml, re);
    if (en && zh && hasCJK(zh)) sink.pairs.push({ en: norm(en), zh: normZh(zh), how: "source", file: "index.html", line: 1 });
  }
}

// -------------------------------------------------------- translator pair files
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
    e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(e[1] === "x" ? 2 : 1), e[1] === "x" ? 16 : 10)) : ENTITIES[e] ?? m);
function loadTranslatorPairs(dir) {
  const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  const tr = {};
  for (const f of readdirSync(join(dir, "results"))) Object.assign(tr, read(join("results", f)));
  if (existsSync(join(dir, "overrides.json"))) Object.assign(tr, read("overrides.json"));
  const out = [];
  for (const sub of ["extracted", "missed"]) {
    if (!existsSync(join(dir, sub))) continue;
    for (const f of readdirSync(join(dir, sub))) {
      if (f.startsWith("_")) continue;
      const { file, items } = read(join(sub, f));
      for (const it of items) {
        let zh = tr[it.id];
        if (typeof zh !== "string" || hasCJK(it.text)) continue; // null: a program value; CJK: re-extracted after translation
        // Templates with string choices inside are expanded from the source instead.
        if (it.kind === "template" && it.exprs.some((x) => /["'`]/.test(x.src))) continue;
        const pattern = it.kind === "template" && it.exprs.length > 0;
        // JSX text was extracted raw; the page shows it with entities decoded.
        const text = it.kind === "jsxtext" ? decodeEntities(it.text) : it.text;
        if (it.kind === "jsxtext") zh = decodeEntities(zh);
        const runs = isMarkdown(text) && isMarkdown(zh) ? [markdownRuns(text), markdownRuns(zh)] : [[text], [zh]];
        if (runs[0].length !== runs[1].length) continue;
        runs[0].forEach((en, i) =>
          out.push({ en: norm(en), zh: normZh(runs[1][i]), file, line: it.line, id: it.id, pattern }));
      }
    }
  }
  if (existsSync(join(dir, "releases-map.json")))
    for (const [en, zh] of Object.entries(read("releases-map.json")))
      out.push({ en: norm(en), zh: normZh(zh), file: "server/releases.js", line: 0, id: "releases-map", pattern: false });
  return out.filter((p) => hasCJK(p.zh) && isNatural(p.en));
}

// -------------------------------------------------------------- hand decisions
// Strings the source builds in ways a pairing walk cannot see, checked by hand
// against the translated source.
const EXTRA_PATTERNS = [
  // WorkspaceHome "Requests this week": plural(n, ...kindNouns[k]) joined with ", ".
  ...[
    ["chat", "chats", "次对话"],
    ["image", "images", "张图像"],
    ["video", "videos", "个视频"],
    ["voice clip", "voice clips", "段语音"],
  ].flatMap(([one, many, zh]) => [
    { en: `{0} ${one}`, zh: `{0} ${zh}` },
    { en: `{0} ${many}`, zh: `{0} ${zh}` },
  ]),
  // Collab list rows: {c.members} member{s} · {c.role}; zh-cn looks the role up instead
  // (the roles are in EXTRA_STRINGS).
  { en: "{0} member · {1}", zh: "{0} 位成员 · {1}" },
  { en: "{0} members · {1}", zh: "{0} 位成员 · {1}" },
];
const EXTRA_STRINGS = {
  // lib.js normalizeModel(): `${m.type} model`; zh-cn maps the type to a word first.
  "chat model": "对话模型",
  "image model": "图像模型",
  "video model": "视频模型",
  "audio model": "音频模型",
  "embedding model": "嵌入模型",
  // Workspace video quality options: the capitalised provider value; zh-cn looks it up.
  Standard: "标准",
  Fast: "快速",
  Quality: "高质量",
  Prime: "旗舰",
  Pro: "专业",
  Turbo: "极速",
  Lite: "轻量",
  // Sign-in method tabs: m[0].toUpperCase() + m.slice(1).
  Password: "密码",
  Email: "邮箱",
  Wallet: "钱包",
  // release-copy modelAvailability(): `Available in ${workspaceName.toLowerCase()}`, where
  // zh-cn puts the Chinese name in directly.
  "Available in chat": "可在对话中使用",
  "Available in workspace": "可在工作台中使用",
  "Unavailable in chat": "无法在对话中使用",
  "Unavailable in workspace": "无法在工作台中使用",
  // Collab roles, rendered raw in English; zh-cn looks them up (roleNames).
  owner: "所有者",
  member: "成员",
};
// Relative times from Intl.RelativeTimeFormat (numeric: "auto") in WorkspaceHome ago(),
// which runs in the browser's locale; the conversation list prefixes them with ", ".
function relativeTimes() {
  const en = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  const zh = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  const strings = {};
  const patterns = [];
  for (const unit of ["year", "month", "week", "day", "hour", "minute"]) {
    const e1 = en.format(-1, unit);
    if (!/\d/.test(e1)) strings[e1] = zh.format(-1, unit);
    else patterns.push({ en: e1.replace("1", "{0}"), zh: zh.format(-1, unit).replace("1", "{0}") });
    patterns.push({ en: en.format(-5, unit).replace("5", "{0}"), zh: zh.format(-5, unit).replace("5", "{0}") });
  }
  for (const [k, v] of Object.entries({ ...strings })) strings[", " + k] = "，" + v;
  for (const p of [...patterns]) patterns.push({ en: ", " + p.en, zh: "，" + p.zh });
  // Chart labels: toLocaleDateString(undefined, { month: "short", day: "numeric" }).
  for (let mth = 0; mth < 12; mth++) {
    const d = new Date(Date.UTC(2026, mth, 15, 12));
    const f = (loc) => d.toLocaleDateString(loc, { month: "short", day: "numeric", timeZone: "UTC" }).replace("15", "{0}");
    patterns.push({ en: f("en"), zh: f("zh-CN") });
  }
  return { strings, patterns };
}
// How each ambiguous alignment in the report was settled, by its English location.
const RESOLVED = {
  "src/Collab.jsx:102": 'EXTRA_PATTERNS "{0} member(s) · {1}" plus the roles in EXTRA_STRINGS',
  "src/WorkspaceHome.jsx:36": 'EXTRA_PATTERNS "{0} chat(s)"; the bare plural is excluded',
  "src/WorkspaceHome.jsx:37": 'EXTRA_PATTERNS "{0} image(s)"',
  "src/WorkspaceHome.jsx:38": 'EXTRA_PATTERNS "{0} video(s)"; the bare plural is excluded',
  "src/WorkspaceHome.jsx:39": 'EXTRA_PATTERNS "{0} voice clip(s)"; the bare nouns are excluded',
};
// Where one English string was translated differently in different places, the
// general choice. Others are picked by frequency and listed in the report.
const PREFER = {
  "Launch team": "发布团队", // sample collab name; a product launch, not a startup
  "Waiting for your wallet…": "正在等待你的钱包……", // Chinese ellipsis
  "Please wait…": "请稍候……",
  // ReferenceFlow's word-by-word heading ["How", "it", "works"] became ["工作", "原理"].
  How: "工作",
  it: "原理",
  image: "图像", // glossary: image → 图像
  member: "成员", // the role; counts use the "{0} member(s)" patterns
  // zh-cn renders "{x} 图片{x > 1 ? "张" : ""}"; the counter belongs before the noun.
  "{0} image": "{0} 张图像",
  "{0} images": "{0} 张图像",
  // zh-cn ends the short branch with an ASCII full stop.
  "Anyone who signs up through your link is connected to your account.": "通过你的链接注册的任何人都会与你的账户关联。",
  // zh-cn left one English word in the sentence.
  "Unused credits are forfeited. Unresolved holds or invoices block closure. Personal content and owned shared workspaces are deleted; financial records, other workspaces’ shared content and external copies remain. Review the data-controls guide before confirming.":
    "未使用的积分将被没收。未解决的冻结或账单会阻止关闭账户。个人内容和你拥有的共享工作台将被删除；财务记录、其他工作台中的共享内容以及外部副本仍会保留。确认前请查看数据控制指南。",
  // zh-cn mixes a half-width opening and a full-width closing parenthesis.
  "Web search: ${0} ({1} credits) per searched request before platform markup. A searched request costs at least its token cost plus this fee.":
    "联网搜索：${0}（{1} 积分），每次搜索请求收取，平台加价前计算。每次搜索请求的费用至少为其 Token 费用加上此项费用。",
};
// Pairs deliberately left out, with the reason; the report lists them.
const EXCLUDE = {
  hour: "an Intl.RelativeTimeFormat unit passed to rtf.format(), never shown; relative times have patterns",
  minute: "an Intl.RelativeTimeFormat unit passed to rtf.format(), never shown; relative times have patterns",
  chats: "a plural() noun, only shown after a count; covered by the \"{0} chats\" pattern",
  videos: "a plural() noun, only shown after a count; covered by the \"{0} videos\" pattern",
  "voice clip": "a plural() noun, only shown after a count; covered by the \"{0} voice clip\" pattern",
  "voice clips": "a plural() noun, only shown after a count; covered by the \"{0} voice clips\" pattern",
  "Reply email: {0} Subject: {1} {2}": "the support draft's downloaded text file, never shown on the page",
  "Reply email: Subject: {0} {1}": "the support draft's downloaded text file, never shown on the page",
  "You get {0}% back in credits when they top up.":
    "the first half of a concatenation that always renders with its second half; the whole sentences have patterns",
};

// -------------------------------------------------------------------- build
function changedFiles() {
  return git("diff", "--name-only", BASE, ZH)
    .split("\n")
    .filter(Boolean);
}
const scriptFile = (f) => /\.(m?js|jsx)$/.test(f) && !f.startsWith("tests/");
function extract() {
  const sink = { pairs: [], ambiguous: [], added: [], latin: [] };
  for (const file of changedFiles()) {
    const en = show(BASE, file);
    const zh = show(ZH, file);
    if (en == null || zh == null) continue;
    if (file === "index.html") pairHtml(en, zh, sink);
    else if (scriptFile(file)) pairFile(file, en, zh, sink);
  }
  pageTitles(sink);
  return sink;
}
// document.title: "<last path segment> — ANONYMA" in English; the Chinese source
// looks the segment up in pageTitles.
function pageTitles(sink) {
  const zh = show(ZH, "src/App.jsx");
  const en = show(BASE, "src/App.jsx");
  if (!zh || !en || !/replaceAll\("-", " "\)\} — ANONYMA/.test(en)) return;
  const ast = parseCode(zh);
  const find = (node) => {
    if (!isNode(node)) return null;
    if (node.type === "VariableDeclarator" && node.id.name === "pageTitles") return node.init;
    for (const c of kids(node)) {
      const r = find(c);
      if (r) return r;
    }
    return null;
  };
  const obj = find(ast.program);
  for (const p of obj?.properties || []) {
    const k = p.key.name ?? p.key.value;
    if (p.value.type === "StringLiteral")
      sink.pairs.push({ en: `${k.replaceAll("-", " ")} — ANONYMA`, zh: `${p.value.value} — ANONYMA`, how: "source", file: "src/App.jsx", line: lineOf(p) });
  }
}

function build() {
  const { pairs, ambiguous, added, latin } = extract();
  const translator = PAIRS ? loadTranslatorPairs(PAIRS) : [];
  const notes = { conflicts: [], sourceFixes: [], translatorOnly: [], sourceOnly: [], fragments: [], guessed: [] };
  const RANK = { source: 3, translator: 2, aligned: 1 };
  const buckets = { strings: new Map(), patterns: new Map() };
  const add = (bucket, p, how) => {
    const m = buckets[bucket];
    if (!m.has(p.en)) m.set(p.en, []);
    m.get(p.en).push({ ...p, how });
  };
  for (const p of pairs) add(p.pattern ? "patterns" : "strings", p, p.how);
  for (const p of translator) add(p.pattern ? "patterns" : "strings", p, "translator");
  const why = opt("--why");
  if (why) for (const b of ["strings", "patterns"]) console.log(b, JSON.stringify(buckets[b].get(why), null, 1));

  const result = { strings: {}, patterns: [] };
  for (const bucket of ["strings", "patterns"]) {
    for (const [en, occ] of buckets[bucket]) {
      if (en in EXCLUDE) continue;
      const fromSource = occ.filter((o) => o.how !== "translator");
      // Only ever rendered inside a longer sentence, which has its own pattern.
      if (fromSource.length && fromSource.every((o) => o.fragment)) {
        notes.fragments.push(en);
        continue;
      }
      const values = new Map();
      for (const o of occ) {
        const v = values.get(o.zh) || { zh: o.zh, rank: 0, count: 0, where: [] };
        v.rank = Math.max(v.rank, RANK[o.how]);
        v.count++;
        v.where.push(`${o.file}:${o.line} (${o.how})`);
        values.set(o.zh, v);
      }
      // The translated source wins over the pair files (fixes were made there), and
      // the pair files win over literals that were only aligned.
      const ranked = [...values.values()].sort((x, y) => y.rank - x.rank || y.count - x.count);
      let chosen = PREFER[en] ?? ranked[0].zh;
      const tv = occ.filter((o) => o.how === "translator").map((o) => o.zh);
      const sv = occ.filter((o) => o.how === "source").map((o) => o.zh);
      if (tv.length && sv.length && !tv.some((v) => sv.includes(v)))
        notes.sourceFixes.push({ en, translator: [...new Set(tv)], source: [...new Set(sv)] });
      else if (!sv.length && !occ.some((o) => o.how === "aligned")) notes.translatorOnly.push(en);
      else if (!tv.length && PAIRS) notes.sourceOnly.push({ en, zh: chosen, where: occ[0].file + ":" + occ[0].line });
      // Only disagreements within the final wording count as conflicts.
      const finals = ranked.filter((v) => v.rank === ranked[0].rank);
      if (finals.length > 1) notes.conflicts.push({ en, chosen, options: finals.map((v) => ({ zh: v.zh, where: v.where })) });
      if (occ.every((o) => o.how === "aligned") && !(en in PREFER))
        notes.guessed.push(`${occ[0].file}:${occ[0].line} ${JSON.stringify(en)} → ${JSON.stringify(chosen)}`);
      if (bucket === "strings") result.strings[en] = chosen;
      else result.patterns.push({ en, zh: chosen });
    }
  }
  const rel = relativeTimes();
  for (const [en, zh] of Object.entries({ ...rel.strings, ...EXTRA_STRINGS })) if (!(en in result.strings)) result.strings[en] = zh;
  for (const p of [...EXTRA_PATTERNS, ...rel.patterns])
    if (!result.patterns.some((q) => q.en === p.en)) result.patterns.push(p);
  // A pattern that renders to a fixed string belongs in strings.
  result.patterns = result.patterns.filter((p) => /\{\d+\}/.test(p.en));
  const sorted = { strings: {}, patterns: result.patterns.sort((a, b) => a.en.localeCompare(b.en)) };
  for (const k of Object.keys(result.strings).sort((a, b) => a.localeCompare(b))) sorted.strings[k] = result.strings[k];
  notes.added = added;
  notes.latin = latin;
  return { dict: sorted, ambiguous, notes };
}

// ------------------------------------------------------------------ coverage
// Every Chinese literal on the translated side, with the outermost template or
// concatenation it sits in (a choice inside a sentence is covered by the sentence).
function chineseLiterals() {
  const out = [];
  for (const file of changedFiles()) {
    const zh = show(ZH, file);
    if (zh == null) continue;
    if (file === "index.html") {
      for (const re of [/<title>([^<]*)<\/title>/, /<meta name="description" content="([^"]*)"/]) {
        const t = zh.match(re)?.[1];
        if (t && hasCJK(t)) out.push({ file, line: 1, text: normZh(t) });
      }
      continue;
    }
    if (!scriptFile(file)) continue;
    const visit = (node, owner) => {
      if (!isNode(node)) return;
      if (node.type === "ImportDeclaration") return;
      const own = owner || (isComposite(node) ? node : leafRun(node));
      if (node.type === "JSXText" || node.type === "StringLiteral") {
        const runs = isMarkdown(node.value) ? markdownRuns(node.value) : [node.value];
        for (const r of runs) if (hasCJK(r)) out.push({ file, line: lineOf(node), text: normZh(r), owner: own });
        return;
      }
      if (node.type === "TemplateLiteral" && node === own && hasCJK(templateText(node)))
        out.push({ file, line: lineOf(node), text: normZh(templateText(node)), owner: own, template: true });
      for (const c of kids(node)) visit(c, own);
    };
    visit(parseCode(zh).program, null);
  }
  return out;
}
// A Chinese literal is covered when the dictionary produces it, or when the English
// it was paired with has an entry (the wording may have been corrected since).
function coverage(dict) {
  const values = new Set(Object.values(dict.strings).map(normZh));
  const patternZh = new Set(dict.patterns.map((p) => anon(normZh(p.zh))));
  const keys = new Set([...Object.keys(dict.strings), ...dict.patterns.map((p) => p.en)]);
  const english = new Map();
  for (const p of extract().pairs) {
    const k = anon(p.zh);
    if (!english.has(k)) english.set(k, new Set());
    english.get(k).add(p.en);
  }
  const produced = (text) =>
    values.has(text) ||
    patternZh.has(anon(text)) ||
    values.has(`${text} — ANONYMA`) || // a document.title segment
    patternZh.has(`{} ${text}`) || // a counter word used through plural()
    [...(english.get(anon(text)) || [])].some((en) => keys.has(en));
  const ownerCovered = new Map();
  const covered = (lit) => {
    if (produced(lit.text)) return true;
    if (!lit.owner) return false;
    if (!ownerCovered.has(lit.owner)) {
      const alts = flatten(lit.owner) || [];
      let n = 0;
      const texts = alts.map((a) => normZh(a.parts.map((p) => (p.cap ? `{${n++}}` : p.t)).join("")));
      ownerCovered.set(lit.owner, texts.some(produced));
    }
    return ownerCovered.get(lit.owner);
  };
  const lits = chineseLiterals();
  const unique = new Map();
  for (const l of lits) {
    const k = anon(l.text);
    const u = unique.get(k) || { text: l.text, where: [], covered: false, en: [...(english.get(k) || [])] };
    u.where.push(`${l.file}:${l.line}`);
    u.covered ||= covered(l);
    unique.set(k, u);
  }
  return [...unique.values()];
}

// -------------------------------------------------------------------- main
function writeReport(ambiguous, notes, dict) {
  const lines = [];
  const sec = (title, rows) => {
    lines.push(`\n## ${title} (${rows.length})`);
    lines.push(...rows);
  };
  sec("Ambiguous alignments", ambiguous.map((a) =>
    `${a.file}:${a.line} ${a.why}\n  en: ${JSON.stringify(a.en)}\n  zh: ${JSON.stringify(a.zh)}` +
    `\n  resolved: ${RESOLVED[`${a.file}:${a.line}`] || "NOT YET"}`));
  sec("Chinese-only additions (lookup maps with no English literal; see EXTRA_STRINGS)", notes.added.map((a) =>
    `${a.file}:${a.line} ${JSON.stringify(a.zh)}`));
  sec("One English string, several final translations", notes.conflicts.map((c) =>
    `${JSON.stringify(c.en)} → ${JSON.stringify(c.chosen)}\n` +
    c.options.map((o) => `  ${JSON.stringify(o.zh)} at ${o.where.join(", ")}`).join("\n")));
  sec("Pair files differ from the translated source (source used)", notes.sourceFixes.map((f) =>
    `${JSON.stringify(f.en)}\n  pairs:  ${JSON.stringify(f.translator)}\n  source: ${JSON.stringify(f.source)}`));
  sec("Only in the pair files", notes.translatorOnly.map((e) => JSON.stringify(e)));
  sec("Only in the source walk (no pair-file entry)", notes.sourceOnly.map((s) => `${s.where} ${JSON.stringify(s.en)} → ${JSON.stringify(s.zh)}`));
  sec("Changed without Chinese characters (cannot be dictionary values)", notes.latin);
  sec("Aligned by position only, unconfirmed by the pair files (checked by hand)", notes.guessed);
  sec("Fragments left to their sentence patterns", notes.fragments.map((e) => JSON.stringify(e)));
  sec("Excluded by hand", Object.entries(EXCLUDE).map(([k, why]) => `${JSON.stringify(k)}: ${why}`));
  mkdirSync("runtime", { recursive: true });
  writeFileSync(REPORT_FILE, `# i18n-extract report (${BASE} → ${ZH})\n` +
    `strings: ${Object.keys(dict.strings).length}, patterns: ${dict.patterns.length}\n` + lines.join("\n") + "\n");
}

function main() {
  if (argv.includes("--report")) {
    if (!existsSync(OUT)) throw Error(`${OUT} is missing; run without --report first.`);
    const dict = JSON.parse(readFileSync(OUT, "utf8"));
    const rows = coverage(dict);
    const miss = rows.filter((r) => !r.covered);
    const left = miss.filter((r) => r.en.some((e) => e in EXCLUDE));
    const visible = rows.length - left.length;
    const pct = (n, of) => ((100 * n) / of).toFixed(1) + "%";
    console.log(`Dictionary: ${Object.keys(dict.strings).length} strings, ${dict.patterns.length} patterns.`);
    console.log(`Chinese strings on ${ZH} (unique; changed source files and index.html): ${rows.length}`);
    console.log(`Covered: ${rows.length - miss.length} of ${rows.length} (${pct(rows.length - miss.length, rows.length)})`);
    console.log(`Covered, user-visible only: ${rows.length - miss.length} of ${visible} (${pct(rows.length - miss.length, visible)})`);
    console.log(`\nUncovered (${miss.length}):`);
    for (const r of miss)
      console.log(`  ${r.where[0]}${r.where.length > 1 ? ` (+${r.where.length - 1})` : ""}  ${JSON.stringify(r.text)}` +
        (left.includes(r) ? "  [left out on purpose]" : "") +
        (r.en.length ? `\n      English: ${r.en.map((e) => JSON.stringify(e)).join(" | ")}` : ""));
    if (Object.keys(EXCLUDE).length) {
      console.log(`\nLeft out on purpose:`);
      for (const [k, why] of Object.entries(EXCLUDE)) console.log(`  ${JSON.stringify(k)}: ${why}`);
    }
    return;
  }
  const { dict, ambiguous, notes } = build();
  mkdirSync("src/i18n", { recursive: true });
  writeFileSync(OUT, JSON.stringify(dict, null, 1) + "\n");
  writeReport(ambiguous, notes, dict);
  console.log(`Wrote ${OUT}: ${Object.keys(dict.strings).length} strings, ${dict.patterns.length} patterns` +
    `${PAIRS ? ", cross-checked against the pair files" : ""}.`);
  console.log(`Ambiguous: ${ambiguous.length}, conflicts: ${notes.conflicts.length}, pair/source differences: ${notes.sourceFixes.length}. Details: ${REPORT_FILE}`);
}
main();
