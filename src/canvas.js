// Canvas, the browser's side: selections and their context, tracked
// changes, undo history, Markdown shortcuts, the DOCX export and the two
// places a canvas can live without the server (this tab, or Device Vault).
// No React or DOM here, so node tests can run all of it.
//
// A suggestion never edits the document by itself: the model's text is
// diffed against what was sent (src/doc-compare.js, word by word) and each
// change waits for Accept or Reject.
import { wordDiff } from "./doc-compare.js";
import { CANVAS_LIMITS } from "./canvas-spec.js";

// Context sent on each side of a selection, in characters, cut to whole
// words. The model is told it's context only.
export const CONTEXT_CHARS = CANVAS_LIMITS.context;

// ---- Selections ----

const WORD = /[\p{L}\p{N}\p{M}_'’-]/u;
// The selection a suggestion works on: widened to whole words, with the
// spaces and line breaks at either end left out, so the rewrite never eats a
// paragraph break. Returns { start, end } (start === end when nothing
// usable is selected).
export function selectionRange(text, start, end) {
  const s = String(text ?? "");
  let a = Math.max(0, Math.min(start, end, s.length)),
    b = Math.min(s.length, Math.max(start, end, 0));
  if (a === b) return { start: a, end: a };
  while (a > 0 && WORD.test(s[a - 1]) && WORD.test(s[a])) a--;
  while (b < s.length && WORD.test(s[b - 1]) && WORD.test(s[b])) b++;
  while (a < b && /\s/.test(s[a])) a++;
  while (b > a && /\s/.test(s[b - 1])) b--;
  return { start: a, end: b };
}
// Up to `max` characters on each side of [start, end), cut at a space so no
// word is split.
export function contextAround(text, start, end, max = CONTEXT_CHARS) {
  const s = String(text ?? "");
  let before = s.slice(Math.max(0, start - max), start);
  if (start - max > 0) before = before.replace(/^\S*\s*/, "");
  let after = s.slice(end, end + max);
  if (end + max < s.length) after = after.replace(/\s*\S*$/, "");
  return { before, after };
}

// Where "Summarise on top" puts its paragraph: after a leading heading (the
// document's title) and the blank lines under it, otherwise at the start.
export function summaryInsertAt(text) {
  const s = String(text ?? "");
  const m = /^[ \t]*#{1,6}[ \t]+[^\n]*(\n|$)/.exec(s);
  if (!m) return 0;
  let at = m[0].length;
  while (at < s.length && s[at] === "\n") at++;
  return at;
}
// The text to insert at `at` for a summary: blank lines around it as needed.
export function summaryInsertText(text, at, summary) {
  const before = text.slice(0, at),
    after = text.slice(at);
  const lead = !before ? "" : before.endsWith("\n\n") ? "" : before.endsWith("\n") ? "\n" : "\n\n";
  return lead + summary.trim() + (after.trim() ? "\n\n" : "");
}

// The `canvas` payload for an action, and the part of the document its
// result replaces: { payload, region: { start, end }, original }. A
// selection sends the selected text and a little context; Summarise, Make
// consistent and an instruction with nothing selected send the document.
// `mask` is Veil's, applied to every piece of text sent.
export function buildRequest({ action, tone, instruction, text, start = 0, end = 0, mask = (s) => s }) {
  const doc = String(text ?? "");
  const extra = {
    ...(action === "tone" ? { tone } : {}),
    ...(action === "custom" ? { instruction: mask(String(instruction ?? "").trim()) } : {}),
  };
  const range = selectionRange(doc, start, end);
  const selection = range.start < range.end && !["summarize", "consistent"].includes(action);
  if (selection) {
    const { before, after } = contextAround(doc, range.start, range.end);
    return {
      payload: { action, ...extra, scope: "selection", text: mask(doc.slice(range.start, range.end)), before: mask(before), after: mask(after) },
      region: range,
      original: doc.slice(range.start, range.end),
    };
  }
  if (action === "summarize") {
    const at = summaryInsertAt(doc);
    return { payload: { action, scope: "document", text: mask(doc) }, region: { start: at, end: at }, original: "" };
  }
  return { payload: { action, ...extra, scope: "document", text: mask(doc) }, region: { start: 0, end: doc.length }, original: doc };
}

// ---- Tracked changes ----

// The region's text before and after a suggestion, as runs of unchanged
// text and changes ({ kind: "change", id, del, ins }): one change per
// stretch the word diff marks, numbered from 0.
export function trackChanges(original, revised) {
  const out = [];
  let n = 0;
  for (const [op, text] of wordDiff(String(original ?? ""), String(revised ?? ""))) {
    if (op === 0) {
      out.push({ kind: "same", text });
      continue;
    }
    let last = out.at(-1);
    if (!last || last.kind !== "change") out.push((last = { kind: "change", id: n++, del: "", ins: "" }));
    if (op === -1) last.del += text;
    else last.ins += text;
  }
  return out;
}
export const changesIn = (parts) => parts.filter((p) => p.kind === "change");
// The region's text with each change accepted ("accept") or not (anything
// else keeps the original).
export const applyDecisions = (parts, decisions = {}) =>
  parts.map((p) => (p.kind === "same" ? p.text : decisions[p.id] === "accept" ? p.ins : p.del)).join("");
export const allDecided = (parts, decisions = {}) =>
  changesIn(parts).every((c) => decisions[c.id] === "accept" || decisions[c.id] === "reject");
export function decideAll(parts, decision) {
  return Object.fromEntries(changesIn(parts).map((c) => [c.id, decision]));
}
// The whole document once a review is done: the region replaced by the
// decided text. Returns { text, start, end } with the new region.
export function finishReview(doc, region, parts, decisions) {
  const middle = applyDecisions(parts, decisions);
  return {
    text: doc.slice(0, region.start) + middle + doc.slice(region.end),
    start: region.start,
    end: region.start + middle.length,
  };
}
// Counts for the side panel: accepted, rejected and still open.
export function decisionCounts(parts, decisions = {}) {
  const all = changesIn(parts);
  const accepted = all.filter((c) => decisions[c.id] === "accept").length,
    rejected = all.filter((c) => decisions[c.id] === "reject").length;
  return { total: all.length, accepted, rejected, open: all.length - accepted - rejected };
}

// ---- Undo and redo ----

export const HISTORY_LIMIT = 100;
// Typing within this long of the last keystroke is one step to undo.
export const TYPING_WINDOW = 900;
export const createHistory = (text = "") => ({ past: [], present: text, future: [], at: 0, typing: false });
export function recordHistory(h, text, { typing = false, at = Date.now() } = {}) {
  if (text === h.present) return h;
  const merge = typing && h.typing && at - h.at < TYPING_WINDOW;
  return {
    past: merge ? h.past : [...h.past, h.present].slice(-HISTORY_LIMIT),
    present: text,
    future: [],
    at,
    typing,
  };
}
export function undoHistory(h) {
  if (!h.past.length) return h;
  return { past: h.past.slice(0, -1), present: h.past.at(-1), future: [h.present, ...h.future], at: 0, typing: false };
}
export function redoHistory(h) {
  if (!h.future.length) return h;
  return { past: [...h.past, h.present].slice(-HISTORY_LIMIT), present: h.future[0], future: h.future.slice(1), at: 0, typing: false };
}
// Where two texts differ: { start, end } of the changed part in `b`, to put
// the selection there after an undo or redo.
export function changedRange(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let ea = a.length,
    eb = b.length;
  while (ea > start && eb > start && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  return { start, end: eb };
}

// ---- Markdown shortcuts (the toolbar) ----

// Bold, italic or code: wraps the selection in `mark`, or unwraps it when
// it's already wrapped (inside or just outside the selection).
export function toggleWrap(text, start, end, mark) {
  const sel = text.slice(start, end);
  const n = mark.length;
  if (sel.length >= 2 * n && sel.startsWith(mark) && sel.endsWith(mark)) {
    const inner = sel.slice(n, -n);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  if (text.slice(start - n, start) === mark && text.slice(end, end + n) === mark)
    return { text: text.slice(0, start - n) + sel + text.slice(end + n), start: start - n, end: end - n };
  const word = sel || "text";
  return {
    text: text.slice(0, start) + mark + word + mark + text.slice(end),
    start: start + n,
    end: start + n + word.length,
  };
}
const LINE_PREFIX = /^(#{1,6} |[-*+] |\d+[.)] |> )/;
// A heading, list or quote for every line the selection touches: the
// prefix is added, replaces another, or (when every line has it) removed.
export function toggleLinePrefix(text, start, end, prefix) {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  let to = text.indexOf("\n", Math.max(start, end - 1));
  if (to < 0) to = text.length;
  const lines = text.slice(from, to).split("\n");
  const numbered = prefix === "1. ";
  const has = (l) => (numbered ? /^\d+[.)] /.test(l) : l.startsWith(prefix));
  const remove = lines.every((l) => !l.trim() || has(l));
  let k = 0;
  const next = lines
    .map((l) => {
      if (!l.trim()) return l;
      const bare = l.replace(LINE_PREFIX, "");
      if (remove) return bare;
      return (numbered ? `${++k}. ` : prefix) + bare;
    })
    .join("\n");
  return { text: text.slice(0, from) + next + text.slice(to), start: from, end: from + next.length };
}
// A link around the selection, with the address selected to type over.
export function insertLink(text, start, end) {
  const label = text.slice(start, end) || "link text";
  const url = "https://";
  const out = text.slice(0, start) + `[${label}](${url})` + text.slice(end);
  const at = start + label.length + 3;
  return { text: out, start: at, end: at + url.length };
}

// ---- Titles and files ----

export const DEFAULT_TITLE = "Untitled canvas";
// A title from the document's first heading or line, for a new canvas.
export function titleFrom(text) {
  const line = String(text ?? "")
    .split("\n")
    .map((l) => l.replace(/^#{1,6}\s+/, "").replace(/[*_`[\]]/g, "").trim())
    .find(Boolean);
  return (line || DEFAULT_TITLE).slice(0, 80);
}
export function fileStem(title) {
  return (
    String(title ?? "")
      .normalize("NFKD")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase()
      .slice(0, 60) || "canvas"
  );
}
export const wordCount = (text) => (String(text ?? "").match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu) || []).length;

// ---- Where a canvas lives ----

// On the account (server ids "cv_…"), off the record in this tab only
// ("cvt_…", sessionStorage) or in Device Vault ("cvd_…", sealed like a vault
// chat). The id says which, so ?doc= reopens the right one.
export const storeOf = (id) =>
  typeof id !== "string" ? null : id.startsWith("cvt_") ? "tab" : id.startsWith("cvd_") ? "vault" : id.startsWith("cv_") ? "account" : null;
export const newLocalId = (kind) => (kind === "vault" ? "cvd_" : "cvt_") + crypto.randomUUID().replace(/-/g, "");

const TAB_KEY = (account) => "anonyma:canvas:tab:" + (account || "guest");
// Off-the-record canvases: this tab's sessionStorage only, per account, so
// closing the tab clears them and no other tab or account sees them.
export function readTabCanvases(storage, account) {
  try {
    const list = JSON.parse(storage?.getItem(TAB_KEY(account)) || "[]");
    return Array.isArray(list)
      ? list.filter((c) => storeOf(c?.id) === "tab" && typeof c.content === "string" && typeof c.title === "string")
      : [];
  } catch {
    return [];
  }
}
export function writeTabCanvas(storage, account, canvas) {
  const list = readTabCanvases(storage, account).filter((c) => c.id !== canvas.id);
  const next = [{ ...canvas }, ...list];
  storage.setItem(TAB_KEY(account), JSON.stringify(next));
  return next;
}
export function removeTabCanvas(storage, account, id) {
  const next = readTabCanvases(storage, account).filter((c) => c.id !== id);
  if (next.length) storage.setItem(TAB_KEY(account), JSON.stringify(next));
  else storage.removeItem(TAB_KEY(account));
  return next;
}
// A Device Vault record for a canvas: a vault "chat" of mode "canvas" with
// no messages, so the vault seals, exports, imports and deletes it like any
// other record. The vault's chat list leaves these out (DeviceVault.jsx).
export function vaultCanvasRecord({ id, title, content, created, now = Date.now() }) {
  return { id, mode: "canvas", title: String(title || DEFAULT_TITLE), messages: [], canvas: { content: String(content ?? "") }, created: created || now, updated: now };
}
export const isVaultCanvas = (c) => c?.mode === "canvas" && storeOf(c.id) === "vault" && typeof c.canvas?.content === "string";

// A first canvas, so the page shows what it does.
export const SAMPLE_CANVAS = `# Launch note: private workspace

Our team is getting ready to launch the new workspace next month. We really want to make sure that every customer gets a very good first week, and there are a lot of things to explain.

## What's new

- One balance for every model, with no subscription.
- Chats you can keep on your account, off the record, or on your own device.
- A e-mail when your balance runs low.

## Next steps

We will send the final e-mail to customers on the 3rd. In order to do this, the support team should of finished the help pages by Friday.
`;

// ---- DOCX (a minimal, valid WordprocessingML package) ----

const XML_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
export const xmlEscape = (s) =>
  String(s ?? "")
    .replace(XML_BAD, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

// The Markdown's blocks: headings, paragraphs, list items, quotes, code
// and rules. Tables keep their cells, one row per paragraph.
export function markdownBlocks(md) {
  const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  // A paragraph or quote still gathering lines, and the last list item
  // (already in `blocks`), which takes the lines that continue it.
  let para = null,
    item = null;
  const flush = () => {
    if (para) blocks.push(para);
    para = null;
  };
  const stop = () => {
    flush();
    item = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)/.exec(line);
    let m;
    if (fence) {
      stop();
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      blocks.push({ type: "code", text: code.join("\n") });
    } else if (!line.trim()) stop();
    else if ((m = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line))) {
      stop();
      blocks.push({ type: "heading", level: Math.min(3, m[1].length), text: m[2] });
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      stop();
      blocks.push({ type: "rule" });
    } else if ((m = /^(\s*)[-*+]\s+(.*)$/.exec(line))) {
      stop();
      blocks.push((item = { type: "bullet", depth: Math.min(4, Math.floor(m[1].length / 2)), text: m[2] }));
    } else if ((m = /^(\s*)(\d+)([.)])\s+(.*)$/.exec(line))) {
      stop();
      blocks.push((item = { type: "number", depth: Math.min(4, Math.floor(m[1].length / 2)), marker: m[2] + m[3], text: m[4] }));
    } else if ((m = /^\s{0,3}>\s?(.*)$/.exec(line))) {
      if (para?.type === "quote") para.text += " " + m[1];
      else {
        stop();
        para = { type: "quote", text: m[1] };
      }
    } else if (/^\s*\|.*\|\s*$/.test(line)) {
      stop();
      if (!/^\s*\|[\s:|-]+\|\s*$/.test(line))
        blocks.push({ type: "paragraph", text: line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join("   ") });
    } else if (para) para.text += " " + line.trim();
    else if (item) item.text += " " + line.trim();
    else para = { type: "paragraph", text: line.trim() };
  }
  flush();
  return blocks;
}

// Inline Markdown as runs: **bold**, *italic*, `code` and [links](https://…).
const INLINE =
  /\\([\\`*_{}[\]()#+\-.!>|~])|(`+)([^`]|[^`][\s\S]*?[^`])\2(?!`)|\*\*(?=\S)([\s\S]*?\S)\*\*(?!\*)|__(?=\S)([\s\S]*?\S)__(?![\p{L}\p{N}])|\*(?=[^\s*])([\s\S]*?[^\s*])\*|(?<![\p{L}\p{N}_])_(?=[^\s_])([\s\S]*?[^\s_])_(?![\p{L}\p{N}_])|\[([^\]\n]+)\]\(\s*([^()\s]+)(?:\s+"[^"]*")?\s*\)|<((?:https?:\/\/|mailto:)[^>\s]+)>/gu;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
export function inlineRuns(text, style = {}) {
  const runs = [];
  const push = (t, s = style) => {
    if (!t) return;
    const last = runs.at(-1);
    if (last && !last.link && !s.link && last.bold === !!s.bold && last.italic === !!s.italic && last.code === !!s.code) last.text += t;
    else runs.push({ text: t, bold: !!s.bold, italic: !!s.italic, code: !!s.code, ...(s.link ? { link: s.link } : {}) });
  };
  let at = 0;
  const s = String(text ?? "");
  for (const m of s.matchAll(INLINE)) {
    push(s.slice(at, m.index));
    at = m.index + m[0].length;
    if (m[1] !== undefined) push(m[1]);
    else if (m[3] !== undefined) push(m[3], { ...style, code: true });
    else if (m[4] !== undefined || m[5] !== undefined) for (const r of inlineRuns(m[4] ?? m[5], { ...style, bold: true })) push(r.text, r);
    else if (m[6] !== undefined || m[7] !== undefined) for (const r of inlineRuns(m[6] ?? m[7], { ...style, italic: true })) push(r.text, r);
    else if (m[8] !== undefined) {
      const link = SAFE_LINK.test(m[9]) ? m[9] : null;
      for (const r of inlineRuns(m[8], style)) push(r.text, link ? { ...r, link } : r);
    } else if (m[10] !== undefined) push(m[10], { ...style, link: m[10] });
  }
  push(s.slice(at));
  return runs;
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
function runXML(r) {
  const props = [r.code ? '<w:rStyle w:val="CodeChar"/>' : r.link ? '<w:rStyle w:val="Hyperlink"/>' : "", r.bold ? "<w:b/>" : "", r.italic ? "<w:i/>" : ""].join("");
  const body = String(r.text)
    .split(/(\t|\n)/)
    .map((t) => (t === "\t" ? "<w:tab/>" : t === "\n" ? "<w:br/>" : t ? `<w:t xml:space="preserve">${xmlEscape(t)}</w:t>` : ""))
    .join("");
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}${body}</w:r>`;
}
// Every file of the package, as text. No author, dates or other metadata:
// the document carries only its text. Links become external hyperlinks.
export function docxFiles(markdown) {
  const links = [];
  const linkId = (url) => {
    let i = links.indexOf(url);
    if (i < 0) i = links.push(url) - 1;
    return `rIdL${i + 1}`;
  };
  const runs = (text) =>
    inlineRuns(text)
      .map((r) => (r.link ? `<w:hyperlink r:id="${linkId(r.link)}" w:history="1">${runXML(r)}</w:hyperlink>` : runXML(r)))
      .join("");
  const para = (style, inner, extra = "") => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ""}${extra}</w:pPr>${inner}</w:p>`;
  const body = markdownBlocks(markdown)
    .map((b) => {
      if (b.type === "heading") return para(`Heading${b.level}`, runs(b.text));
      if (b.type === "rule") return para("", "", '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C8D0DC"/></w:pBdr>');
      if (b.type === "code") return para("Code", runXML({ text: b.text, code: false }));
      if (b.type === "quote") return para("Quote", runs(b.text));
      if (b.type === "bullet" || b.type === "number") {
        const indent = `<w:ind w:left="${360 * (b.depth + 2)}" w:hanging="360"/>`;
        return para("ListParagraph", runXML({ text: (b.type === "bullet" ? "•" : b.marker) + "\t" }) + runs(b.text), indent);
      }
      return para("", runs(b.text));
    })
    .join("");
  const document = `${HEAD}<w:document ${W}><w:body>${body || "<w:p/>"}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;
  const rels = `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${links
    .map(
      (url, i) =>
        `<Relationship Id="rIdL${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${xmlEscape(url)}" TargetMode="External"/>`,
    )
    .join("")}</Relationships>`;
  const style = (id, name, type, inner, extra = "") =>
    `<w:style w:type="${type}" w:styleId="${id}"${extra}><w:name w:val="${name}"/>${inner}</w:style>`;
  const styles = `${HEAD}<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei" w:cs="Calibri"/><w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>${[
    style("Normal", "Normal", "paragraph", "<w:qFormat/>", ' w:default="1"'),
    style("Heading1", "heading 1", "paragraph", '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="142343"/><w:sz w:val="36"/><w:szCs w:val="36"/></w:rPr>'),
    style("Heading2", "heading 2", "paragraph", '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="280" w:after="100"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="142343"/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr>'),
    style("Heading3", "heading 3", "paragraph", '<w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="80"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="142343"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr>'),
    style("Quote", "Quote", "paragraph", '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:left="720"/></w:pPr><w:rPr><w:i/><w:color w:val="555F6D"/></w:rPr>'),
    style("Code", "Code", "paragraph", '<w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F3F5F8"/><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr>'),
    style("ListParagraph", "List Paragraph", "paragraph", '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="60"/><w:ind w:left="720" w:hanging="360"/></w:pPr>'),
    style("Hyperlink", "Hyperlink", "character", '<w:rPr><w:color w:val="0135DF"/><w:u w:val="single"/></w:rPr>'),
    style("CodeChar", "Code Char", "character", '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:shd w:val="clear" w:color="auto" w:fill="F3F5F8"/></w:rPr>'),
  ].join("")}</w:styles>`;
  return {
    "[Content_Types].xml": `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
    "_rels/.rels": `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    "word/document.xml": document,
    "word/_rels/document.xml.rels": rels,
    "word/styles.xml": styles,
  };
}
export const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
// The .docx bytes, zipped with the JSZip the caller loads (the page loads it
// only when someone exports). Fixed dates, so nothing about when it was
// made is written either.
export async function docxBytes(JSZip, markdown) {
  const zip = new JSZip();
  const date = new Date(Date.UTC(1980, 0, 1));
  for (const [path, text] of Object.entries(docxFiles(markdown))) zip.file(path, text, { date });
  return zip.generateAsync({ type: "uint8array", compression: "DEFLATE", mimeType: DOCX_TYPE });
}
