import { parseHTML } from "linkedom";
import { Readability } from "@mozilla/readability";
import { capWords, LINK_READER } from "../src/link-reader.js";

// Link Reader, the extraction half: a fetched page's readable text. Runs in
// a worker thread (link-extract-worker.js) so a large or hostile page can't
// stall the server; the pure functions here are also unit tested directly.
//
// linkedom builds a light DOM (no scripts run, nothing is fetched), then
// scripts, styles, frames, embeds and form controls are removed (a <form>
// is unwrapped, since some sites wrap the whole page in one) and Mozilla's
// Readability picks the article. The article is turned into plain text:
// headings, paragraphs, list items and table rows on their own lines. Links
// keep their words and lose their URLs. At most 30,000 words are kept.

const DROP = [
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "link",
  "base",
  "input",
  "button",
  "select",
  "option",
  "textarea",
  "svg",
  "canvas",
  "video",
  "audio",
  "picture",
  "source",
  "img",
  "map",
  "dialog",
].join(",");
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "center", "dd", "details",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "header",
  "hgroup", "html", "li", "main", "nav", "ol", "p", "pre", "section", "summary",
  "table", "tbody", "thead", "tfoot", "tr", "ul", "caption",
]);
const HEADING = /^h([1-6])$/;
const SKIP = new Set(DROP.split(",").concat("head", "title", "meta"));

function clean(document) {
  // Scripts go, except JSON-LD data, which Readability reads (as JSON, never
  // run) for the title, site name and byline, and then removes itself.
  for (const el of [...document.querySelectorAll(DROP)])
    if (!(el.tagName === "SCRIPT" && /^application\/ld\+json$/i.test(el.getAttribute("type") || ""))) el.remove();
  for (const form of [...document.querySelectorAll("form")]) form.replaceWith(...form.childNodes);
  // Hidden text is left out: it isn't what a reader of the page sees.
  for (const el of [...document.querySelectorAll("[hidden],[aria-hidden=true]")]) el.remove();
  for (const el of [...document.querySelectorAll("[style]")])
    if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(el.getAttribute("style") || "")) el.remove();
}

// Plain text from a DOM node: one line per block, "- " for list items,
// "#"s for headings, " | " between table cells, <pre> kept as it is.
export function domText(root) {
  const lines = [];
  let line = "";
  const flush = () => {
    const t = line.replace(/[ \t\u00a0]+/g, " ").trim();
    if (t) lines.push(t);
    line = "";
  };
  const walk = (node, pre = false) => {
    if (node.nodeType === 3) {
      line += pre ? node.textContent : node.textContent.replace(/\s+/g, " ");
      return;
    }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (SKIP.has(tag)) return;
    if (tag === "br") {
      if (pre) line += "\n";
      else flush();
      return;
    }
    if (tag === "hr") {
      flush();
      return;
    }
    const heading = HEADING.exec(tag);
    if (tag === "pre") {
      flush();
      const text = node.textContent.replace(/\r\n?/g, "\n").replace(/^\n+|\s+$/g, "");
      if (text) lines.push(...text.split("\n"), "");
      return;
    }
    if (heading || BLOCK.has(tag)) flush();
    if (heading) line += "#".repeat(Number(heading[1])) + " ";
    if (tag === "li") line += "- ";
    if (tag === "td" || tag === "th") {
      if (line.trim()) line += " | ";
    }
    for (const child of node.childNodes) walk(child, pre);
    if (heading || BLOCK.has(tag)) flush();
    if (heading) lines.push("");
    if (tag === "p" || tag === "blockquote" || tag === "table" || tag === "ul" || tag === "ol")
      lines.push("");
  };
  walk(root);
  flush();
  return tidy(lines.join("\n"));
}
// Control and zero-width characters out, at most one blank line in a row.
export function tidy(text) {
  return String(text || "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b\ufeff]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const oneLine = (s, max) => {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t;
};
const meta = (document, ...names) => {
  for (const n of names) {
    const el = document.querySelector(`meta[property="${n}"],meta[name="${n}"]`);
    const v = el?.getAttribute("content");
    if (v && v.trim()) return v;
  }
  return "";
};

// linkedom needs a whole document: a page (or a test fragment) without its
// own <body> has everything put in one.
function wholeDocument(html) {
  const s = String(html || "");
  if (/<body[\s>]/i.test(s)) return s;
  const inner = s.replace(/<!doctype[^>]*>/gi, "").replace(/<\/?(html|head)(\s[^>]*)?>/gi, "");
  return `<!doctype html><html><head></head><body>${inner}</body></html>`;
}
// "Why onions have layers | The Garden Post" without the site's own name.
export function cleanTitle(title, siteName) {
  const t = String(title || "").trim();
  const site = String(siteName || "").trim();
  if (!site) return t;
  for (const sep of [" | ", " - ", " – ", " — ", " · ", " :: ", ": "]) {
    if (t.endsWith(sep + site) && t.length > (sep + site).length) return t.slice(0, -(sep + site).length).trim();
    if (sep !== ": " && t.startsWith(site + sep) && t.length > (site + sep).length) return t.slice((site + sep).length).trim();
  }
  return t;
}

// { title, siteName, byline, text, words, truncated } for an HTML page.
export function extractHtml(html, { host = "", maxWords = LINK_READER.maxWords } = {}) {
  const { document } = parseHTML(wholeDocument(html));
  const docTitle = document.querySelector("title")?.textContent || "";
  const ogTitle = meta(document, "og:title", "twitter:title");
  const ogSite = meta(document, "og:site_name", "application-name");
  clean(document);
  let article = null;
  try {
    // A copy, since Readability changes the document it reads.
    const { document: copy } = parseHTML(document.toString());
    article = new Readability(copy, { maxElemsToParse: 60000, charThreshold: 200 }).parse();
  } catch {
    article = null;
  }
  let text = "";
  if (article?.content) text = domText(parseHTML(`<!doctype html><html><body>${article.content}</body></html>`).document.body);
  // Readability found no article (a short page, a list, a home page): the
  // whole body, without its navigation and page furniture.
  if (text.length < 200) {
    for (const el of [...document.querySelectorAll("nav,header,footer,aside")]) el.remove();
    const body = domText(document.body || document.documentElement);
    if (body) text = body;
  }
  const capped = capWords(text, maxWords);
  const siteName = oneLine(article?.siteName || ogSite || "", 120);
  return {
    title: oneLine(cleanTitle(article?.title || ogTitle || docTitle, ogSite || siteName) || host, 300),
    siteName,
    byline: oneLine(article?.byline || "", 200),
    text: capped.text,
    words: capped.words,
    truncated: capped.truncated,
  };
}

// The same for text/plain.
export function extractPlain(text, { host = "", path = "", maxWords = LINK_READER.maxWords } = {}) {
  const capped = capWords(tidy(text), maxWords);
  return {
    title: oneLine(fileName(path) || host, 300),
    siteName: "",
    byline: "",
    text: capped.text,
    words: capped.words,
    truncated: capped.truncated,
  };
}
// The last path segment, decoded ("report.pdf"), for titles of files.
export function fileName(path) {
  const last = String(path || "").split("/").filter(Boolean).at(-1) || "";
  try {
    return decodeURIComponent(last).slice(0, 200);
  } catch {
    return last.slice(0, 200);
  }
}
