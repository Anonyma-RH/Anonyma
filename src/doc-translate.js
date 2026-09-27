// Translate docs: the document side, pure and DOM-free so it runs in the
// browser and in tests. A document becomes a list of blocks (headings,
// paragraphs, lists, tables, quotes, code) written as Markdown; blocks are
// grouped into parts by structure; each part's translation is matched back
// to its blocks for the side-by-side view; and the result is written out as
// Markdown or a minimal DOCX. Nothing here sends anything anywhere.
import { zipEntries, parseOfficeXML, crc32, textBytes, XML_LIMIT } from "./file-formats.js";

export const MAX_DOC_CHARS = 150000;
// A part aims for about this many characters and never goes past PART_MAX
// (a longer block is split first). A heading starts a new part once the
// current one is past HEADING_BREAK of the target, so sections stay whole.
export const PART_TARGET = 1500;
export const PART_MAX = 3500;
const HEADING_BREAK = 0.35;

// ---- Markdown and plain text ----

const FENCE = /^\s{0,3}(`{3,}|~{3,})/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const LIST_ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+\S/;
const QUOTE = /^\s{0,3}>/;
const isTableRow = (l) => /\|/.test(l) && l.trim().length > 1;

// Blocks from Markdown (or plain text, read the same way). Each block is
// { kind, md } plus `level` for headings; `send` is false for code and
// rules, which are kept as written and never sent.
export function markdownBlocks(input) {
  const lines = String(input ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "    ")
    .split("\n");
  const blocks = [];
  let i = 0;
  const startsBlock = (l, next) =>
    FENCE.test(l) || HEADING.test(l) || RULE.test(l) || QUOTE.test(l) || LIST_ITEM.test(l) || (isTableRow(l) && TABLE_SEP.test(next || ""));
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`);
      const body = [line];
      i++;
      while (i < lines.length && !close.test(lines[i])) body.push(lines[i++]);
      if (i < lines.length) body.push(lines[i++]);
      blocks.push({ kind: "code", md: body.join("\n"), send: false });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      blocks.push({ kind: "heading", level: h[1].length, md: `${h[1]} ${h[2]}`, send: !!h[2].trim() });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      blocks.push({ kind: "rule", md: "---", send: false });
      i++;
      continue;
    }
    if (isTableRow(line) && TABLE_SEP.test(lines[i + 1] || "")) {
      const rows = [];
      while (i < lines.length && lines[i].trim() && isTableRow(lines[i])) rows.push(lines[i++].trim());
      blocks.push({ kind: "table", md: rows.join("\n"), send: true });
      continue;
    }
    if (QUOTE.test(line)) {
      const rows = [];
      while (i < lines.length && lines[i].trim() && QUOTE.test(lines[i])) rows.push(lines[i++].trimEnd());
      blocks.push({ kind: "quote", md: rows.join("\n"), send: true });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const rows = [];
      while (i < lines.length && lines[i].trim()) {
        const l = lines[i];
        if (rows.length && !LIST_ITEM.test(l) && !/^\s/.test(l) && startsBlock(l, lines[i + 1])) break;
        rows.push(l.trimEnd());
        i++;
      }
      blocks.push({ kind: "list", md: rows.join("\n"), send: true });
      continue;
    }
    const rows = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i], lines[i + 1])) {
      // A setext heading: text underlined with === or ---.
      if (rows.length === 1 && /^\s{0,3}(=+|-+)\s*$/.test(lines[i])) break;
      rows.push(lines[i++].trim());
    }
    if (i < lines.length && rows.length === 1 && /^\s{0,3}(=+|-+)\s*$/.test(lines[i])) {
      const level = lines[i].trim()[0] === "=" ? 1 : 2;
      blocks.push({ kind: "heading", level, md: `${"#".repeat(level)} ${rows[0]}`, send: true });
      i++;
      continue;
    }
    blocks.push({ kind: "paragraph", md: rows.join("\n"), send: true });
  }
  return blocks;
}

// ---- DOCX ----

const local = (node) =>
  String(node?.name || "")
    .split(":")
    .at(-1);
const kids = (node) => (node?.children || []).filter((n) => typeof n !== "string");
const child = (node, name) => kids(node).find((n) => local(n) === name) || null;
function attr(node, name) {
  for (const key in node?.attrs || {}) if (key.split(":").at(-1) === name) return node.attrs[key];
  return undefined;
}
const on = (node) => !!node && !["0", "false", "off"].includes(String(attr(node, "val") ?? "true").toLowerCase());
// Markdown's own characters in document text, so a line of text is never
// read as markup: emphasis and code marks anywhere, block marks at the start.
export function escapeInline(text) {
  return String(text).replace(/([\\`*])/g, "\\$1");
}
const escapeLead = (text) => text.replace(/^(\s*)([#>+-]|\d{1,3}[.)])(?=\s)/, "$1\\$2");

// A paragraph's text as Markdown: bold and italic runs kept, hidden runs,
// deleted text and field codes left out.
function paragraphText(p) {
  const runs = [];
  const walk = (node, hidden) => {
    for (const n of kids(node)) {
      const name = local(n);
      if (
        [
          "pPr",
          "rPr",
          "del",
          "moveFrom",
          "instrText",
          "delText",
          "fldChar",
          "commentReference",
          "footnoteReference",
          "endnoteReference",
        ].includes(name)
      )
        continue;
      if (name === "r") {
        const props = child(n, "rPr");
        if (hidden || on(child(props, "vanish"))) continue;
        const fmt = { b: on(child(props, "b")), i: on(child(props, "i")) };
        let text = "";
        for (const part of kids(n)) {
          const k = local(part);
          if (k === "t") text += part.children.filter((c) => typeof c === "string").join("");
          else if (k === "tab") text += " ";
          else if (k === "br" || k === "cr") text += "\n";
          else if (k === "noBreakHyphen") text += "-";
        }
        if (text) runs.push({ text, ...fmt });
      } else walk(n, hidden);
    }
  };
  walk(p, false);
  // Neighbouring runs with the same formatting become one.
  const merged = [];
  for (const r of runs) {
    const last = merged.at(-1);
    if (last && last.b === r.b && last.i === r.i) last.text += r.text;
    else merged.push({ ...r });
  }
  let out = "";
  for (const r of merged) {
    const [, lead, core, trail] = /^(\s*)([\s\S]*?)(\s*)$/.exec(r.text);
    const body = escapeInline(core);
    const mark = r.b && r.i ? "***" : r.b ? "**" : r.i ? "*" : "";
    out += lead + (core && mark ? mark + body + mark : body) + trail;
  }
  return out
    .replace(/[ \u00a0]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}
// Heading levels by style: "heading 1" to "heading 6" and "Title" by name,
// or an outline level set on the style. Quote styles are marked "quote".
function headingStyles(styles) {
  const map = new Map([
    ["Quote", "quote"],
    ["IntenseQuote", "quote"],
  ]);
  if (!styles) return map;
  const walk = (node) => {
    for (const n of kids(node)) {
      if (local(n) === "style") {
        const id = attr(n, "styleId");
        const name = String(attr(child(n, "name"), "val") || "").toLowerCase();
        const outline = attr(child(child(n, "pPr"), "outlineLvl"), "val");
        const m = /^heading\s*(\d)$/.exec(name);
        const level = name === "title" ? 1 : m ? Number(m[1]) : outline != null && Number(outline) < 6 ? Number(outline) + 1 : 0;
        if (id && level >= 1 && level <= 6) map.set(id, level);
        else if (id && /^(intense )?quote$/.test(name)) map.set(id, "quote");
      } else walk(n);
    }
  };
  walk(styles);
  return map;
}
// Which lists are numbered: numId and level → true when not bullets.
function numberFormats(numbering) {
  const abstract = new Map(),
    nums = new Map();
  for (const n of kids(child(numbering, "numbering") || numbering)) {
    if (local(n) === "abstractNum") {
      const levels = new Map();
      for (const lvl of kids(n).filter((x) => local(x) === "lvl"))
        levels.set(Number(attr(lvl, "ilvl") || 0), String(attr(child(lvl, "numFmt"), "val") || "bullet"));
      abstract.set(attr(n, "abstractNumId"), levels);
    } else if (local(n) === "num") nums.set(attr(n, "numId"), attr(child(n, "abstractNumId"), "val"));
  }
  return (numId, level) => {
    const fmt = abstract.get(nums.get(numId))?.get(level);
    return !!fmt && !["bullet", "none"].includes(fmt);
  };
}
function tableMarkdown(tbl) {
  const rows = [];
  for (const tr of kids(tbl).filter((n) => local(n) === "tr")) {
    const cells = [];
    for (const tc of kids(tr).filter((n) => local(n) === "tc")) {
      const text = kids(tc)
        .filter((n) => local(n) === "p" || local(n) === "tbl")
        .map((n) => (local(n) === "p" ? paragraphText(n) : ""))
        .filter(Boolean)
        .join(" ")
        .replace(/\n/g, " ")
        .replace(/\|/g, "\\|");
      cells.push(text);
      const span = Number(attr(child(child(tc, "tcPr"), "gridSpan"), "val") || 1);
      for (let s = 1; s < Math.min(span, 20); s++) cells.push("");
    }
    if (cells.length) rows.push(cells);
  }
  if (!rows.length) return null;
  // A header row set all in bold is a header already: Markdown shows it so.
  if (rows[0].every((c) => !c || /^\*\*[^*]+\*\*$/.test(c))) rows[0] = rows[0].map((c) => c.replace(/^\*\*|\*\*$/g, ""));
  const width = Math.max(...rows.map((r) => r.length));
  const line = (r) => "| " + Array.from({ length: width }, (_, i) => r[i] || " ").join(" | ") + " |";
  return [line(rows[0]), "| " + Array(width).fill("---").join(" | ") + " |", ...rows.slice(1).map(line)].join("\n");
}
// Blocks from a DOCX's parsed parts: word/document.xml, and styles and
// numbering when the file has them.
export function docxBlocks({ document, styles = null, numbering = null }) {
  const levels = headingStyles(styles);
  const numbered = numbering ? numberFormats(numbering) : () => false;
  const body = child(child(document, "document"), "body");
  if (!body) throw Error("This DOCX has no document body.");
  const blocks = [];
  let list = null;
  const endList = () => {
    if (list) blocks.push({ kind: "list", md: list.lines.join("\n"), send: true });
    list = null;
  };
  const visit = (nodes) => {
    for (const n of nodes) {
      const name = local(n);
      if (name === "sdt") {
        visit(kids(child(n, "sdtContent")));
        continue;
      }
      if (name === "tbl") {
        endList();
        const md = tableMarkdown(n);
        if (md) blocks.push({ kind: "table", md, send: true });
        continue;
      }
      if (name !== "p") continue;
      const pPr = child(n, "pPr");
      const text = paragraphText(n);
      const style = attr(child(pPr, "pStyle"), "val");
      const outline = attr(child(pPr, "outlineLvl"), "val");
      const numPr = child(pPr, "numPr");
      const styled = levels.get(style);
      const level =
        (typeof styled === "number" ? styled : 0) ||
        /^heading\s*(\d)$/i.exec(style || "")?.[1] | 0 ||
        (outline != null && Number(outline) < 6 ? Number(outline) + 1 : 0);
      if (!text) {
        if (!numPr) endList();
        continue;
      }
      if (level && !numPr) {
        endList();
        blocks.push({
          kind: "heading",
          level: Math.min(6, level),
          md: `${"#".repeat(Math.min(6, level))} ${text.replace(/\n/g, " ")}`,
          send: true,
        });
        continue;
      }
      const bulletStyle = /^list ?(bullet|number)/i.exec(style || "");
      if (numPr || bulletStyle) {
        const ilvl = Math.min(8, Number(attr(child(numPr, "ilvl"), "val") || 0));
        const numId = attr(child(numPr, "numId"), "val");
        if (numId === "0") {
          endList();
        } else {
          const ordered = numPr ? numbered(numId, ilvl) : /number/i.test(bulletStyle[1]);
          // Another list starts where the numbering changes at the top level.
          if (list && ilvl === 0 && list.numId !== (numId ?? style)) endList();
          list ||= { lines: [], counters: [], numId: numId ?? style };
          list.counters.length = ilvl + 1;
          list.counters[ilvl] = (list.counters[ilvl] || 0) + 1;
          const marker = ordered ? `${list.counters[ilvl]}.` : "-";
          list.lines.push(`${"   ".repeat(ilvl)}${marker} ${text.replace(/\n/g, " ")}`);
          continue;
        }
      }
      endList();
      if (styled === "quote")
        blocks.push({
          kind: "quote",
          md: text
            .split("\n")
            .map((l) => "> " + l)
            .join("\n"),
          send: true,
        });
      else blocks.push({ kind: "paragraph", md: escapeLead(text), send: true });
    }
  };
  visit(kids(body));
  endList();
  return blocks;
}
// A DOCX file's blocks, read with the same bounded ZIP and XML readers as
// Documents (src/file-formats.js). `inflate` is browserInflate in the
// browser or zlib in tests.
export async function readDocx(bytes, inflate) {
  const entries = zipEntries(bytes);
  const read = async (name, required = true) => {
    const e = entries.get(name);
    if (!e) {
      if (required) throw Error("The DOCX is missing its document.");
      return null;
    }
    const data = e.method === 0 ? e.bytes : await inflate(e.bytes, e.length);
    if (data.length !== e.length || crc32(data) !== e.checksum) throw Error("The DOCX is damaged.");
    const text = textBytes(data);
    if (text.length > XML_LIMIT) throw Error("This DOCX is too large to read here. Split it, or save it as PDF or text.");
    return parseOfficeXML(text);
  };
  const types = await read("[Content_Types].xml");
  const overrides = [];
  const walk = (n) => {
    for (const k of kids(n)) {
      if (local(k) === "Override") overrides.push(String(attr(k, "ContentType") || ""));
      walk(k);
    }
  };
  walk(types);
  if (!overrides.some((t) => t.includes("wordprocessingml.document.main+xml"))) throw Error("This isn't a Word document.");
  return docxBlocks({
    document: await read("word/document.xml"),
    styles: await read("word/styles.xml", false),
    numbering: await read("word/numbering.xml", false),
  });
}

// ---- PDF ----

const BULLET = /^([•◦▪●‣∙·▸►–—*-]|\(?\d{1,3}[.)]|\(?[a-z][.)])\s+/;
const PAGE_NUMBER = /^\s*(?:page\s+)?\d{1,4}(?:\s*(?:of|\/)\s*\d{1,4})?\s*$/i;
const SENTENCE_END = /[.!?:;。！？：；)"”’]$/;
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\uff00-\uffef]/;
function joinLines(a, b) {
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  if (CJK.test(a.at(-1)) && CJK.test(b[0])) return a + b;
  return a + " " + b;
}
// Blocks from a PDF's text items: `pages` is [{ items: [{ str, x, y, h,
// eol }] }] in the order pdf.js reads them (src/pdf-text.js pdfLayout).
// Lines come from the items' positions; a bigger font than the body text
// makes a heading, a leading bullet or number a list item, and a vertical
// gap a new paragraph. Page numbers alone on a line are dropped. Tables in
// a PDF come through as text.
export function pdfBlocks(pages) {
  const lines = [];
  pages.forEach((page, p) => {
    let line = null;
    const pageLines = [];
    for (const it of page.items || []) {
      const str = String(it.str || "");
      const h = Math.abs(Number(it.h) || 0);
      if (!str.trim() && !it.eol) continue;
      if (line && (Math.abs(it.y - line.y) > Math.max(h, line.h) * 0.5 || line.eol)) {
        pageLines.push(line);
        line = null;
      }
      if (!line) line = { text: "", y: it.y, x: it.x, h: 0, page: p, eol: false };
      if (str.trim()) {
        line.text += (line.text && !/\s$/.test(line.text) && !/^\s/.test(str) && it.x - (line.right ?? it.x) > h * 0.15 ? " " : "") + str;
        line.h = Math.max(line.h, h);
        line.right = it.x + (Number(it.w) || 0);
      }
      if (it.eol) line.eol = true;
    }
    if (line) pageLines.push(line);
    const kept = pageLines.map((l) => ({ ...l, text: l.text.replace(/\s+/g, " ").trim() })).filter((l) => l.text);
    // A page number alone on the first or last line.
    if (kept.length && PAGE_NUMBER.test(kept.at(-1).text)) kept.pop();
    if (kept.length && PAGE_NUMBER.test(kept[0].text)) kept.shift();
    lines.push(...kept);
  });
  if (!lines.length) return [];
  // The body size: the most common line height, weighted by characters.
  const weight = new Map();
  for (const l of lines) weight.set(Math.round(l.h * 2) / 2, (weight.get(Math.round(l.h * 2) / 2) || 0) + l.text.length);
  const body = [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0] || 10;
  const headingSizes = [
    ...new Set(lines.filter((l) => l.h >= body * 1.18 && l.text.length <= 150).map((l) => Math.round(l.h * 2) / 2)),
  ].sort((a, b) => b - a);
  const levelOf = (l) => {
    if (l.h < body * 1.18 || l.text.length > 150) return 0;
    return Math.min(3, headingSizes.indexOf(Math.round(l.h * 2) / 2) + 1) || 3;
  };
  // Lists whose bullets are drawn rather than written: two or more short
  // lines in a row, indented from the body text's left edge by the same
  // amount, are items.
  const edges = new Map();
  for (const l of lines) edges.set(Math.round(l.x), (edges.get(Math.round(l.x)) || 0) + l.text.length);
  const left = [...edges.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const widest = Math.max(...lines.map((l) => (l.right ?? l.x) - l.x));
  const indented = (l) => !!l && !levelOf(l) && l.x > left + l.h && (l.right ?? l.x) - l.x < widest * 0.75;
  const sameIndent = (a, b) => indented(a) && indented(b) && a.page === b.page && Math.abs(a.x - b.x) < 2;
  const drawnItem = (i) => sameIndent(lines[i], lines[i - 1]) || sameIndent(lines[i], lines[i + 1]);
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    if (cur.kind === "heading")
      blocks.push({ kind: "heading", level: cur.level, md: `${"#".repeat(cur.level)} ${escapeInline(cur.text)}`, send: true });
    else if (cur.kind === "list")
      blocks.push({
        kind: "list",
        md: cur.items
          .map((t) => (BULLET.test(t) ? t.replace(/^([•◦▪●‣∙·▸►–—*-])\s+/, "- ").replace(/^\((\d{1,3}|[a-z])\)\s+/, "$1. ") : "- " + t))
          .map((t) => escapeInline(t))
          .join("\n"),
        send: true,
      });
    else blocks.push({ kind: "paragraph", md: escapeLead(escapeInline(cur.text)), send: true });
    cur = null;
  };
  let prev = null;
  lines.forEach((l, i) => {
    const level = levelOf(l);
    const bullet = BULLET.test(l.text) || drawnItem(i);
    const samePage = prev && prev.page === l.page;
    const gap = samePage ? Math.abs(prev.y - l.y) : Infinity;
    const lineHeight = Math.max(l.h, prev?.h || 0) || body;
    const loose = gap > lineHeight * 1.75;
    // A paragraph carries on over a page break when it stopped mid-sentence.
    const carries = prev && !samePage && cur?.kind === "paragraph" && !SENTENCE_END.test(prev.text) && /^[a-z]/.test(l.text);
    if (level) {
      if (cur?.kind === "heading" && cur.level === level && !loose) cur.text = joinLines(cur.text, l.text);
      else {
        flush();
        cur = { kind: "heading", level, text: l.text };
      }
    } else if (bullet) {
      if (cur?.kind !== "list" || gap > lineHeight * 2.6) {
        flush();
        cur = { kind: "list", items: [] };
      }
      cur.items.push(l.text);
    } else if (cur?.kind === "list" && !loose && samePage) {
      cur.items[cur.items.length - 1] = joinLines(cur.items.at(-1), l.text);
    } else if (cur?.kind === "paragraph" && ((samePage && !loose) || carries)) {
      cur.text = joinLines(cur.text, l.text);
    } else {
      flush();
      cur = { kind: "paragraph", text: l.text };
    }
    prev = l;
  });
  flush();
  return blocks;
}

// ---- Parts ----

// Sentences, for splitting a paragraph that's too long for one part.
function sentences(text) {
  const out = [];
  let last = 0;
  const re = /[.!?。！？](?:["”’)\]]*)(?:\s+|(?=[\u3040-\u9fff]))/g;
  for (let m; (m = re.exec(text));) {
    out.push(text.slice(last, m.index + m[0].length));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
// Pieces of at most `max` characters, split at whitespace where possible.
function hardSplit(text, max) {
  const out = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}
function groupUnder(units, max, join, head = "") {
  const out = [];
  let cur = "";
  for (const u of units.flatMap((u) => (u.length + head.length > max ? hardSplit(u, max - head.length - 2) : [u]))) {
    if (cur && head.length + cur.length + join.length + u.length > max) {
      out.push(head + cur);
      cur = "";
    }
    cur = cur ? cur + join + u : u;
  }
  if (cur) out.push(head + cur);
  return out;
}
// A block longer than `max`, as several blocks of the same kind: a
// paragraph or quote by sentences, a list by its top-level items, a table by
// rows (each piece keeps the header row).
export function splitBlock(block, max = PART_MAX) {
  if (!block.send || block.md.length <= max) return [block];
  const piece = (md) => ({ ...block, md, split: true });
  if (block.kind === "table") {
    const rows = block.md.split("\n");
    const head = rows.slice(0, 2).join("\n") + "\n";
    return groupUnder(rows.slice(2), max, "\n", head).map(piece);
  }
  if (block.kind === "list") {
    const items = [];
    for (const line of block.md.split("\n")) {
      if (/^\S/.test(line) || !items.length) items.push(line);
      else items[items.length - 1] += "\n" + line;
    }
    return groupUnder(items, max, "\n").map(piece);
  }
  if (block.kind === "quote") {
    const text = block.md
      .split("\n")
      .map((l) => l.replace(/^\s{0,3}>\s?/, ""))
      .join(" ");
    return groupUnder(sentences(text), max - 2, "").map((t) => piece("> " + t.trim()));
  }
  return groupUnder(sentences(block.md.replace(/\n/g, " ")), max, "").map((t) => piece(t.trim()));
}
// The document's blocks (long ones split) and its parts: consecutive sent
// blocks, grouped by structure. A part is { index, blocks: [block indexes],
// text, title }.
export function planParts(input, { target = PART_TARGET, max = PART_MAX } = {}) {
  const blocks = input.flatMap((b) => splitBlock(b, max));
  const parts = [];
  let cur = null;
  const close = (carryHeading = true) => {
    if (!cur) return;
    // A part never ends on a heading: it moves to the next part.
    let carry = null;
    if (carryHeading && cur.blocks.length > 1 && blocks[cur.blocks.at(-1)].kind === "heading") carry = cur.blocks.pop();
    parts.push(cur);
    cur = carry == null ? null : { blocks: [carry], size: blocks[carry].md.length };
  };
  blocks.forEach((b, i) => {
    // Code and rules stay as written, and a part never spans them.
    if (!b.send) return close(false);
    const size = b.md.length;
    if (cur) {
      const over = cur.size + 2 + size > max;
      const full = cur.size >= target;
      const section = b.kind === "heading" && b.level <= 3 && cur.size >= target * HEADING_BREAK;
      if (over || full || section) close();
    }
    if (!cur) cur = { blocks: [], size: 0 };
    cur.blocks.push(i);
    cur.size += (cur.blocks.length > 1 ? 2 : 0) + size;
  });
  close();
  return {
    blocks,
    parts: parts.map((p, index) => {
      const first = blocks[p.blocks[0]];
      return {
        index,
        blocks: p.blocks,
        text: p.blocks.map((i) => blocks[i].md).join("\n\n"),
        title:
          first.kind === "heading"
            ? first.md
                .replace(/^#+\s*/, "")
                .replace(/\\(.)/g, "$1")
                .slice(0, 80)
            : "",
      };
    }),
  };
}

// A part's translation matched to its blocks: one translated block per
// source block when the counts agree (the usual case, since the model is
// told to keep the structure), otherwise null and the part is shown whole.
export function alignPart(part, text) {
  const out = markdownBlocks(text);
  return out.length === part.blocks.length ? out.map((b) => b.md) : null;
}

// ---- Rows for the side-by-side view ----

// Rows in reading order: { key, left: [block], right, state, part }. A
// part whose translation lines up gets a row per block; one that doesn't
// (or hasn't arrived) gets one row. Kept blocks (code, rules) show on both
// sides as they are.
export function viewRows(blocks, parts, results) {
  const owner = new Map();
  for (const p of parts) for (const i of p.blocks) owner.set(i, p);
  const rows = [];
  const done = new Set();
  blocks.forEach((b, i) => {
    const p = owner.get(i);
    if (!p) {
      rows.push({ key: "k" + i, left: [b], right: b.md, kept: true });
      return;
    }
    if (done.has(p.index)) return;
    const r = results[p.index];
    const aligned = r?.status === "done" ? r.aligned : null;
    if (aligned) {
      const at = p.blocks.indexOf(i);
      rows.push({ key: `p${p.index}b${at}`, left: [b], right: aligned[at], part: p.index, first: at === 0, state: "done" });
      if (at === p.blocks.length - 1) done.add(p.index);
      return;
    }
    done.add(p.index);
    rows.push({
      key: "p" + p.index,
      left: p.blocks.map((k) => blocks[k]),
      right: r?.status === "done" ? r.text : "",
      part: p.index,
      first: true,
      state: r?.status || "pending",
    });
  });
  return rows;
}

// ---- Export ----

// The translated document as Markdown, in reading order. A part not
// translated (yet) keeps its original text, so nothing goes missing.
export function translatedMarkdown(blocks, parts, results, unmask = (s) => s) {
  const owner = new Map();
  for (const p of parts) for (const i of p.blocks) owner.set(i, p);
  const out = [];
  const done = new Set();
  blocks.forEach((b, i) => {
    const p = owner.get(i);
    const r = p && results[p.index];
    if (!p || r?.status !== "done") return out.push(b.md);
    if (r.aligned) return out.push(unmask(r.aligned[p.blocks.indexOf(i)]));
    if (!done.has(p.index)) out.push(unmask(r.text));
    done.add(p.index);
  });
  return out.join("\n\n") + "\n";
}
export const fileStem = (name) =>
  String(name || "document")
    .replace(/\.[^.]+$/, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ")
    .trim()
    .slice(0, 80) || "document";

// Inline Markdown as runs: **bold**, *italic* or _italic_, `code`, links as
// their text, backslash escapes undone.
export function inlineRuns(md) {
  const runs = [];
  let b = false,
    i = false,
    text = "";
  const push = (t, extra = {}) => {
    if (!t) return;
    const last = runs.at(-1);
    if (last && last.b === b && last.i === i && !last.code && !extra.code) last.text += t;
    else runs.push({ text: t, b, i, ...extra });
  };
  const s = String(md ?? "");
  for (let k = 0; k < s.length;) {
    const c = s[k];
    if (c === "\\" && k + 1 < s.length && /[\\`*_{}[\]()#+\-.!|>~]/.test(s[k + 1])) {
      text += s[k + 1];
      k += 2;
      continue;
    }
    if (c === "`") {
      const end = s.indexOf("`", k + 1);
      if (end > k) {
        push(text);
        text = "";
        push(s.slice(k + 1, end), { code: true });
        k = end + 1;
        continue;
      }
    }
    const link = c === "!" || c === "[" ? /^!?\[([^\]]*)\]\(([^)\s]*)(?:\s+"[^"]*")?\)/.exec(s.slice(k)) : null;
    if (link) {
      text += link[1];
      k += link[0].length;
      continue;
    }
    const run = c === "*" || c === "_" ? (s[k + 1] === c ? (s[k + 2] === c ? 3 : 2) : 1) : 0;
    // Emphasis marks, but not a lone * between spaces or _ inside a word.
    const lone = /\s/.test(s[k - 1] || " ") && /\s/.test(s[k + run] || " ");
    const inWord = c === "_" && /\w/.test(s[k - 1] || "") && /\w/.test(s[k + run] || "");
    if (run && !lone && !inWord) {
      push(text);
      text = "";
      if (run >= 2) b = !b;
      if (run !== 2) i = !i;
      k += run;
      continue;
    }
    if (c === "<" && /^<br\s*\/?>/i.test(s.slice(k))) {
      text += "\n";
      k += /^<br\s*\/?>/i.exec(s.slice(k))[0].length;
      continue;
    }
    text += c;
    k++;
  }
  push(text);
  return runs;
}
const xml = (s) =>
  String(s ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
function runsXml(md, { rtl = false, bold = false, mono = false } = {}) {
  return inlineRuns(md)
    .map((r) => {
      const props = [
        r.code || mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : "",
        r.b || bold ? "<w:b/><w:bCs/>" : "",
        r.i ? "<w:i/><w:iCs/>" : "",
        rtl ? "<w:rtl/>" : "",
      ].join("");
      const pieces = r.text.split("\n").map((t) => `<w:t xml:space="preserve">${xml(t)}</w:t>`);
      return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${pieces.join("<w:br/>")}</w:r>`;
    })
    .join("");
}
const para = (content, { style, rtl, num, extra = "" } = {}) =>
  `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${num ? `<w:numPr><w:ilvl w:val="${num.level}"/><w:numId w:val="${num.id}"/></w:numPr>` : ""}${extra}${rtl ? "<w:bidi/>" : ""}</w:pPr>${content}</w:p>`;
const splitRow = (line) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/(?<!\\)\|$/, "")
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, "|"));

// The files of a minimal DOCX for Markdown `md`: { path: xml }. Headings,
// paragraphs, bullet and numbered lists (each numbered list restarts at 1),
// tables with a header row, quotes, code and rules; bold, italic and code
// inside a paragraph. Right-to-left languages get bidi paragraphs.
export function docxParts(md, { lang = "en", rtl = false, title = "" } = {}) {
  const blocks = markdownBlocks(md);
  const body = [];
  const numbered = [];
  for (const b of blocks) {
    if (b.kind === "heading")
      body.push(para(runsXml(b.md.replace(/^#+\s*/, ""), { rtl }), { style: `Heading${Math.min(b.level, 4)}`, rtl }));
    else if (b.kind === "paragraph") body.push(para(runsXml(b.md, { rtl }), { rtl }));
    else if (b.kind === "quote")
      body.push(
        para(
          runsXml(
            b.md
              .split("\n")
              .map((l) => l.replace(/^\s{0,3}>\s?/, ""))
              .join("\n"),
            { rtl },
          ),
          { style: "Quote", rtl },
        ),
      );
    else if (b.kind === "code") {
      const lines = b.md.split("\n").slice(1);
      if (lines.length && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(lines.at(-1))) lines.pop();
      body.push(
        para(
          `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/></w:rPr>${lines.map((t) => `<w:t xml:space="preserve">${xml(t)}</w:t>`).join("<w:br/>")}</w:r>`,
          { style: "Code" },
        ),
      );
    } else if (b.kind === "rule")
      body.push(para("", { extra: '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="A6B3CC"/></w:pBdr>' }));
    else if (b.kind === "list") {
      let orderedId = null;
      const indents = [];
      for (const line of b.md.split("\n")) {
        const m = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/.exec(line);
        if (!m) {
          body.push(para(runsXml(line.trim(), { rtl }), { style: "ListParagraph", rtl }));
          continue;
        }
        // Nesting by indentation, however many spaces a level uses.
        const indent = m[1].length;
        while (indents.length && indent < indents.at(-1)) indents.pop();
        if (!indents.length || indent > indents.at(-1)) indents.push(indent);
        const level = Math.min(8, indents.length - 1);
        const ordered = /\d/.test(m[2]);
        if (ordered && orderedId == null) {
          orderedId = 2 + numbered.length;
          numbered.push(orderedId);
        }
        body.push(para(runsXml(m[3], { rtl }), { style: "ListParagraph", rtl, num: { id: ordered ? orderedId : 1, level } }));
      }
    } else if (b.kind === "table") {
      const rows = b.md
        .split("\n")
        .filter((l) => !TABLE_SEP.test(l))
        .map(splitRow);
      const width = Math.max(1, ...rows.map((r) => r.length));
      const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="A6B3CC"/>`;
      const cells = (r, head) =>
        `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${Array.from(
          { length: width },
          (_, k) =>
            `<w:tc><w:tcPr><w:tcW w:w="${Math.floor(9000 / width)}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="EDF2FF"/>' : ""}</w:tcPr>${para(runsXml(r[k] || "", { rtl, bold: head }), { rtl })}</w:tc>`,
        ).join("")}</w:tr>`;
      body.push(
        `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>${rtl ? "<w:bidiVisual/>" : ""}<w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("")}</w:tblBorders><w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr><w:tblGrid>${Array.from({ length: width }, () => `<w:gridCol w:w="${Math.floor(9000 / width)}"/>`).join("")}</w:tblGrid>${rows.map((r, k) => cells(r, k === 0)).join("")}</w:tbl>`,
        // Word needs a paragraph between a table and whatever follows.
        para(""),
      );
    }
  }
  if (!body.length) body.push(para(""));
  const langAttrs = `w:val="${xml(lang)}" w:eastAsia="${xml(lang)}" w:bidi="${xml(lang)}"`;
  const style = (id, name, { type = "paragraph", ppr = "", rpr = "", based = "Normal", extra = "" } = {}) =>
    `<w:style w:type="${type}" w:styleId="${id}"><w:name w:val="${name}"/>${based ? `<w:basedOn w:val="${based}"/>` : ""}${extra}${ppr ? `<w:pPr>${ppr}</w:pPr>` : ""}${rpr ? `<w:rPr>${rpr}</w:rPr>` : ""}</w:style>`;
  const heading = (n, size) =>
    style(`Heading${n}`, `heading ${n}`, {
      extra: '<w:next w:val="Normal"/><w:qFormat/>',
      ppr: `<w:keepNext/><w:spacing w:before="${n === 1 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/>`,
      rpr: `<w:b/><w:bCs/><w:color w:val="0135DF"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`,
    });
  const lvl = (i, fmt, text, indent) =>
    `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr></w:lvl>`;
  const levels = (fmt) =>
    Array.from({ length: 9 }, (_, i) =>
      fmt === "bullet"
        ? lvl(i, "bullet", ["•", "◦", "▪"][i % 3], 720 * (i + 1))
        : lvl(i, ["decimal", "lowerLetter", "lowerRoman"][i % 3], `%${i + 1}.`, 720 * (i + 1)),
    ).join("");
  return {
    "[Content_Types].xml":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    "_rels/.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    "docProps/core.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>${xml(title)}</dc:title><dc:language>${xml(lang)}</dc:language></cp:coreProperties>`,
    "word/_rels/document.xml.rels":
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>${body.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1300" w:bottom="1440" w:left="1300" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    "word/styles.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Arial"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang ${langAttrs}/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="288" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${style("Normal", "Normal", { based: "", extra: "<w:qFormat/>" })}${heading(1, 36)}${heading(2, 30)}${heading(3, 26)}${heading(4, 23)}${style("ListParagraph", "List Paragraph", { ppr: '<w:spacing w:after="60"/><w:ind w:left="720"/><w:contextualSpacing/>' })}${style("Quote", "Quote", { ppr: '<w:ind w:left="567"/><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="0135DF"/></w:pBdr>', rpr: "<w:i/><w:iCs/>" })}${style("Code", "Code", { ppr: '<w:spacing w:after="0"/><w:shd w:val="clear" w:color="auto" w:fill="F4F6FA"/>', rpr: '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="19"/>' })}${style("TableGrid", "Table Grid", { type: "table", based: "" })}</w:styles>`,
    "word/numbering.xml": `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="hybridMultilevel"/>${levels("bullet")}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="hybridMultilevel"/>${levels("decimal")}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>${numbered
      .map(
        (id) =>
          `<w:num w:numId="${id}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>`,
      )
      .join("")}</w:numbering>`,
  };
}
// The DOCX file itself, zipped with JSZip (loaded by the caller only when
// someone exports).
export async function buildDocx(JSZip, md, options) {
  const zip = new JSZip();
  for (const [path, content] of Object.entries(docxParts(md, options))) zip.file(path, content);
  return zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}
