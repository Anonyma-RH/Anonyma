// Live Preview (the "preview" update): the documents a sandboxed preview
// frame shows, built entirely in the browser. Nothing here touches the DOM
// or the network, so it runs the same in Node (tests/live-preview.test.mjs).
//
// - projectFiles(messages): Code & Build's files, named from what the reply
//   says ("```html index.html", **style.css**, <!-- index.html -->, …), with
//   a real revision number per path.
// - assemblePreview({ files, entry }): one self-contained HTML document for
//   the chosen page. The project's own CSS, JS, SVG and images are inlined
//   or turned into data: URLs; anything missing or outside the project is
//   listed as a note instead of failing silently.
// - Every document starts with the preview's Content-Security-Policy <meta>
//   (every network request refused), then a small console shim that reports console
//   output and errors to the app as plain text.
//
// The frame itself is an iframe sandboxed with allow-scripts only, on PREVIEW_FRAME_PATH
// (src/LivePreview.jsx, server/routes/preview.js): an opaque origin that
// can't read the app's cookies, storage, API or DOM.
import { PREVIEW_CSP, PREVIEW_FRAME_PATH } from "./security-headers.js";

export { PREVIEW_CSP, PREVIEW_FRAME_PATH };

// The one and only sandbox token a preview frame gets. Never add
// allow-same-origin, allow-top-navigation, allow-popups, allow-forms or
// allow-modals (the tests fail if anything else appears).
export const PREVIEW_SANDBOX = "allow-scripts";

// Messages between the app and the frame. The app accepts a message only
// from its own preview frame's window, and treats its data as plain text.
export const PREVIEW_MESSAGE = {
  ready: "anonyma-preview:ready",
  render: "anonyma-preview:render",
  console: "anonyma-preview:console",
  open: "anonyma-preview:open",
};

// "Fit" gives the page the pane's own width; the others give it a device's
// width, scaled down to fit when the pane is narrower.
export const VIEWPORTS = [
  { id: "fit", label: "Fit", width: null, height: null },
  { id: "desktop", label: "Desktop", width: 1280, height: 800 },
  { id: "tablet", label: "Tablet", width: 768, height: 1024 },
  { id: "phone", label: "Phone", width: 375, height: 812 },
];

// Limits: one document (characters), console lines kept by the app, the
// longest console line, and how many lines one page may send.
export const MAX_PREVIEW_CHARS = 4_000_000;
export const CONSOLE_KEEP = 200;
export const CONSOLE_TEXT = 2000;
export const CONSOLE_SEND = 500;

// ---------------------------------------------------------------------------
// Code & Build files from replies
// ---------------------------------------------------------------------------

const LANG_EXT = {
  html: "html",
  htm: "html",
  xhtml: "html",
  css: "css",
  scss: "scss",
  sass: "sass",
  less: "less",
  js: "js",
  javascript: "js",
  mjs: "js",
  cjs: "js",
  node: "js",
  jsx: "jsx",
  ts: "ts",
  typescript: "ts",
  tsx: "tsx",
  json: "json",
  svg: "svg",
  xml: "xml",
  py: "py",
  python: "py",
  sh: "sh",
  bash: "sh",
  shell: "sh",
  zsh: "sh",
  md: "md",
  markdown: "md",
  txt: "txt",
  text: "txt",
  plaintext: "txt",
  sql: "sql",
  yaml: "yml",
  yml: "yml",
  toml: "toml",
  rb: "rb",
  ruby: "rb",
  go: "go",
  rust: "rs",
  rs: "rs",
  java: "java",
  c: "c",
  cpp: "cpp",
  cs: "cs",
  csharp: "cs",
  php: "php",
  swift: "swift",
  kotlin: "kt",
  vue: "vue",
  svelte: "svelte",
};
// Extensions a block of each language may be named with.
const FAMILY = {
  html: ["html", "htm", "xhtml"],
  js: ["js", "mjs", "cjs"],
  jsx: ["jsx", "js"],
  ts: ["ts", "mts", "cts"],
  svg: ["svg"],
  xml: ["xml", "svg"],
  md: ["md", "markdown"],
  yml: ["yml", "yaml"],
  sh: ["sh", "bash", "zsh"],
  txt: ["txt", "text"],
};
const KNOWN_EXT = new Set([
  ...Object.values(LANG_EXT),
  ...Object.values(FAMILY).flat(),
  "h",
  "hpp",
  "ini",
  "env",
  "csv",
  "webmanifest",
]);
// Library names that look like files ("a Node.js server").
const NOT_FILES = new Set(
  "node.js next.js nuxt.js vue.js react.js three.js d3.js express.js chart.js ember.js backbone.js angular.js alpine.js p5.js anime.js socket.io nest.js solid.js deno.js bun.js htmx.js".split(
    " ",
  ),
);
const FILE_TOKEN = /^(?:[\w@-][\w.@-]*\/)*[\w@-][\w.@-]*\.([A-Za-z0-9]{1,10})$/;

export function normalizePath(path) {
  const parts = [];
  for (const seg of String(path ?? "")
    .replace(/\\/g, "/")
    .split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg);
  }
  return parts.join("/");
}
const extOf = (path) => {
  const m = /\.([^./]+)$/.exec(path);
  return m ? m[1].toLowerCase() : "";
};
const dirOf = (path) => {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i + 1);
};
const baseOf = (path) => path.slice(path.lastIndexOf("/") + 1);
export const isHtmlPath = (path) =>
  ["html", "htm", "xhtml"].includes(extOf(path));

function asFileName(token, lang) {
  const t = String(token || "")
    .trim()
    .replace(/^["'`*(\[]+|["'`*)\]:,;.]+$/g, "")
    .replace(/^\.\//, "");
  const m = FILE_TOKEN.exec(t);
  if (!m || t.length > 160 || NOT_FILES.has(t.toLowerCase())) return null;
  const ext = m[1].toLowerCase();
  if (!KNOWN_EXT.has(ext)) return null;
  if (lang) {
    const want = LANG_EXT[lang];
    if (want && !(FAMILY[want] || [want]).includes(ext)) return null;
  }
  const path = normalizePath(t);
  return path || null;
}

// The name a fenced block's info string gives it: "html index.html",
// "js filename=app.js", "css title=\"a.css\"", "html:index.html", "index.html".
function nameFromInfo(info) {
  const words = info.split(/\s+/).filter(Boolean);
  let lang = (words[0] || "").toLowerCase(),
    name = null;
  const colon = /^([\w+#-]+):(.+)$/.exec(words[0] || "");
  if (colon) {
    lang = colon[1].toLowerCase();
    name = asFileName(colon[2], lang);
  } else if (words[0] && asFileName(words[0], null) && words[0].includes(".")) {
    name = asFileName(words[0], null);
    lang = extOf(name);
  }
  if (!name) {
    const attr =
      /(?:file(?:name)?|title|name|path)\s*=\s*["']?([^"'\s}]+)/i.exec(info);
    if (attr) name = asFileName(attr[1], lang);
  }
  if (!name)
    for (const w of words.slice(1)) {
      name = asFileName(w, lang);
      if (name) break;
    }
  return { lang: lang.replace(/[^\w+#-]/g, ""), name };
}

// A filename the code's first line gives itself: <!-- index.html -->,
// /* style.css */, // app.js — note, # tool.py.
function nameFromFirstLine(line, lang) {
  const text = line.trim();
  const m =
    /^<!--\s*(?:file(?:name)?\s*:\s*)?(\S+)/i.exec(text) ||
    /^\/\*+\s*(?:file(?:name)?\s*:\s*)?(\S+)/i.exec(text) ||
    /^\/\/\s*(?:file(?:name)?\s*:\s*)?(\S+)/i.exec(text) ||
    (["py", "sh", "yml", "rb", "toml"].includes(LANG_EXT[lang])
      ? /^#\s*(?:file(?:name)?\s*:\s*)?(\S+)/i.exec(text)
      : null) ||
    (LANG_EXT[lang] === "sql"
      ? /^--\s*(?:file(?:name)?\s*:\s*)?(\S+)/i.exec(text)
      : null);
  return m ? asFileName(m[1].replace(/(?:-->|\*\/)$/, ""), lang) : null;
}

// A filename the line just above the block marks as its name: a heading,
// `code`, **bold**, or a line that is little more than the name.
function nameFromLine(line, lang) {
  const text = line.trim();
  if (!text || text.length > 160) return null;
  const candidates = [];
  const heading = /^#{1,6}\s+(.+)$/.exec(text);
  if (heading)
    candidates.push(...heading[1].replace(/[`*_]/g, " ").split(/[\s(),:]+/));
  for (const m of text.matchAll(/`([^`]+)`/g)) candidates.push(m[1]);
  for (const m of text.matchAll(/\*\*([^*]+)\*\*|__([^_]+)__/g))
    candidates.push((m[1] || m[2]).replace(/`/g, ""));
  const bare =
    /^(?:[-*+]|\d+[.)])?\s*(?:(?:file(?:name)?|path)\s*:\s*)?([^\s:]+)\s*:?$/i.exec(
      text.replace(/[`*_]/g, ""),
    );
  if (bare) candidates.push(bare[1]);
  for (const c of candidates) {
    const name = asFileName(c, lang);
    if (name) return name;
  }
  return null;
}

// Fenced code blocks, in order. An unclosed block (a reply still streaming)
// isn't a file yet.
export function codeBlocks(text) {
  const lines = String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(\s*)(`{3,}|~{3,})(.*)$/.exec(lines[i]);
    if (!open) continue;
    const [, indent, fence, rawInfo] = open;
    const info = rawInfo.trim();
    if (fence[0] === "`" && info.includes("`")) continue;
    const close = new RegExp(`^\\s*\\${fence[0]}{${fence.length},}\\s*$`);
    let j = i + 1;
    while (j < lines.length && !close.test(lines[j])) j++;
    if (j >= lines.length) break;
    const body = lines
      .slice(i + 1, j)
      .map((l) => (indent && l.startsWith(indent) ? l.slice(indent.length) : l))
      .join("\n");
    let k = i - 1;
    while (k >= 0 && !lines[k].trim() && k > i - 3) k--;
    out.push({
      info,
      content: body ? body + "\n" : "",
      before: k >= 0 ? lines[k] : "",
    });
    i = j;
  }
  return out;
}

// Local stylesheet and script references in a page, in document order.
function pageReferences(html, dir) {
  const refs = [];
  const tags =
    String(html).match(/<(?:link|script)\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi) ||
    [];
  for (const tag of tags) {
    const attrs = parseAttributes(
      tag.replace(/^<\w+/, "").replace(/\/?>$/, ""),
    );
    const get = (n) => attrs.find((a) => a.name.toLowerCase() === n)?.value;
    const isLink = /^<link/i.test(tag);
    if (isLink && !/\bstylesheet\b/i.test(get("rel") || "")) continue;
    const r = resolveRef(isLink ? get("href") : get("src"), dir);
    if (r.kind === "local")
      refs.push({ type: isLink ? "css" : "js", path: r.path });
  }
  return refs;
}

// Code & Build's project: every closed code block in the assistant's replies,
// named, with version = how many times that path has appeared so far.
export function projectFiles(messages = []) {
  const blocks = [];
  messages.forEach((m, message) => {
    if (m?.role !== "assistant" || typeof m.content !== "string") return;
    codeBlocks(m.content).forEach((b, order) => {
      const { lang, name } = nameFromInfo(b.info);
      const firstLine = b.content.split("\n")[0] || "";
      blocks.push({
        message,
        order,
        lang,
        ext: LANG_EXT[lang] || (/^\w{1,10}$/.test(lang) ? lang : "txt"),
        content: b.content,
        explicit:
          name ||
          nameFromFirstLine(firstLine, lang) ||
          nameFromLine(b.before, lang),
      });
    });
  });
  const explicit = new Set(blocks.map((b) => b.explicit).filter(Boolean));
  // Pages first: an unnamed page is index.html (page-2.html, … for more in
  // the same reply), so a reply that rewrites the page makes a new revision.
  const byMessage = new Map();
  for (const b of blocks) {
    if (!byMessage.has(b.message)) byMessage.set(b.message, []);
    byMessage.get(b.message).push(b);
  }
  const latestPage = new Map();
  for (const list of byMessage.values()) {
    let pages = 0;
    for (const b of list) {
      if (b.explicit) b.path = b.explicit;
      else if (b.ext === "html")
        b.path = pages++ ? `page-${pages}.html` : "index.html";
      if (b.path && isHtmlPath(b.path)) latestPage.set(b.path, b.content);
    }
    // Unnamed CSS and JS take the names the reply's pages (or the latest
    // pages before it) ask for but no named file provides, in order.
    const pagesHere = list.filter((b) => b.path && isHtmlPath(b.path));
    const sources = pagesHere.length
      ? pagesHere.map((b) => [b.path, b.content])
      : [...latestPage];
    const wanted = { css: [], js: [] };
    for (const [path, html] of sources)
      for (const ref of pageReferences(html, dirOf(path)))
        if (!explicit.has(ref.path) && !wanted[ref.type].includes(ref.path))
          wanted[ref.type].push(ref.path);
    for (const type of ["css", "js"]) {
      const unnamed = list.filter((b) => !b.path && b.ext === type);
      const names =
        unnamed.length && unnamed.length === wanted[type].length
          ? wanted[type]
          : unnamed.map((_, i) =>
              type === "css"
                ? i
                  ? `style-${i + 1}.css`
                  : "style.css"
                : i
                  ? `script-${i + 1}.js`
                  : "script.js",
            );
      unnamed.forEach((b, i) => (b.path = names[i]));
    }
    for (const b of list) if (!b.path) b.path = `file-${b.order + 1}.${b.ext}`;
  }
  const seen = new Map();
  return blocks.map((b) => {
    const version = (seen.get(b.path) || 0) + 1;
    seen.set(b.path, version);
    return {
      name: b.path,
      path: b.path,
      content: b.content,
      lang: b.lang,
      version,
    };
  });
}

// The newest content of each path.
export function latestFiles(files = []) {
  const map = new Map();
  for (const f of files) {
    const path = normalizePath(f.path ?? f.name);
    if (path) map.set(path, String(f.content ?? ""));
  }
  return [...map].map(([path, content]) => ({ path, content }));
}

// The pages a project can show: index.html first, then shallowest, then A–Z.
export function previewPages(files = []) {
  return latestFiles(files)
    .map((f) => f.path)
    .filter(isHtmlPath)
    .sort((a, b) => {
      const rank = (p) =>
        p === "index.html" ? 0 : baseOf(p) === "index.html" ? 1 : 2;
      return (
        rank(a) - rank(b) ||
        a.split("/").length - b.split("/").length ||
        a.localeCompare(b)
      );
    });
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

// What a reference in a page or stylesheet points at, relative to `dir`
// (the referring file's folder): a project path, an external URL, an inline
// data:/blob: URL, a #fragment, or something else (mailto:, javascript:, …).
export function resolveRef(ref, dir = "") {
  const raw = String(ref ?? "").trim();
  if (!raw) return { kind: "empty" };
  if (raw.startsWith("#")) return { kind: "fragment" };
  if (raw.startsWith("//")) return { kind: "external", url: raw };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
  if (scheme) {
    const s = scheme[1].toLowerCase();
    if (s === "data" || s === "blob") return { kind: "inline" };
    if (["http", "https", "ws", "wss", "ftp"].includes(s))
      return { kind: "external", url: raw };
    return { kind: "other" };
  }
  let path = raw.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {}
  path = normalizePath(path.startsWith("/") ? path : dir + path);
  return path ? { kind: "local", path } : { kind: "empty" };
}

function indexProject(files) {
  const byPath = new Map();
  for (const f of latestFiles(files)) byPath.set(f.path, f.content);
  const lower = new Map(),
    base = new Map();
  for (const path of byPath.keys()) {
    const l = path.toLowerCase();
    if (!lower.has(l)) lower.set(l, path);
    const b = baseOf(path).toLowerCase();
    base.set(b, base.has(b) ? null : path);
  }
  return {
    byPath,
    // Exact, then ignoring case, then a unique file of that name anywhere.
    find(path) {
      if (byPath.has(path)) return { path, content: byPath.get(path) };
      const l = lower.get(path.toLowerCase());
      if (l) return { path: l, content: byPath.get(l), matched: true };
      const b = base.get(baseOf(path).toLowerCase());
      if (b) return { path: b, content: byPath.get(b), matched: true };
      return null;
    },
  };
}

const MIME = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  ico: "image/x-icon",
  bmp: "image/bmp",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
  webm: "video/webm",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  html: "text/html",
  htm: "text/html",
  txt: "text/plain",
  xml: "application/xml",
  csv: "text/csv",
  vtt: "text/vtt",
};
function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
export const dataUrl = (path, content) =>
  `data:${MIME[extOf(path)] || "application/octet-stream"};base64,${base64(content)}`;
// What a missing local asset becomes: an empty inline URL, so the browser
// neither fetches anything nor reports a sandbox violation for it.
const EMPTY_URL = "data:,";

// ---------------------------------------------------------------------------
// HTML and CSS
// ---------------------------------------------------------------------------

const ATTR =
  /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
export function parseAttributes(text) {
  const out = [];
  for (const m of String(text).matchAll(ATTR)) {
    const value = m[2] ?? m[3] ?? m[4];
    out.push({
      name: m[1],
      value: value === undefined ? undefined : decodeEntities(value),
      raw: m[0],
    });
  }
  return out;
}
const ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};
function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X"
          ? parseInt(e.slice(2), 16)
          : parseInt(e.slice(1), 10);
      return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e.toLowerCase()] ?? all;
  });
}
export const escapeAttr = (s) =>
  String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
function serializeTag(name, attrs, selfClosing) {
  return (
    "<" +
    name +
    attrs
      .map((a) =>
        a.changed
          ? a.value === undefined
            ? " " + a.name
            : ` ${a.name}="${escapeAttr(a.value)}"`
          : " " + a.raw,
      )
      .join("") +
    (selfClosing ? " />" : ">")
  );
}

// Text safe inside <script> and <style> elements: nothing in it can close
// the element or start a comment that swallows the closing tag.
export const scriptText = (js) =>
  String(js)
    .replace(/<\/(script)/gi, "<\\/$1")
    .replace(/<!--/g, "<\\!--");
export const styleText = (css) => String(css).replace(/<\/(style)/gi, "<\\/$1");

const RELATIVE_IMPORT =
  /(?:\bimport|\bexport)\s[^'";]*?\bfrom\s*(['"])(\.{0,2}\/[^'"]*)\1|\bimport\s*(['"])(\.{0,2}\/[^'"]*)\3|\bimport\s*\(\s*(['"])(\.{0,2}\/[^'"]*)\5\s*\)/;
const JS_TYPES =
  /^(?:|module|text\/javascript|application\/javascript|text\/ecmascript|application\/ecmascript)$/i;

// Stylesheet text with its own references resolved: @import inlined (in
// place, inside @media when the import has a media query) and url() turned
// into data: URLs. `dir` is the stylesheet's folder, which CSS resolves
// against. `flat` puts inlined files on one line so the page's own line
// numbers (for console errors) stay as written.
function processCss(css, dir, ctx, from, stack = []) {
  const TOKENS =
    /\/\*[\s\S]*?(?:\*\/|$)|@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)|"([^"]*)"|'([^']*)')([^;]*);?|url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s]*))\s*\)/gi;
  return String(css).replace(
    TOKENS,
    (all, i1, i2, i3, i4, i5, media, u1, u2, u3) => {
      if (all.startsWith("/*")) return all;
      const isImport = /^@import/i.test(all);
      const ref = isImport ? (i1 ?? i2 ?? i3 ?? i4 ?? i5) : (u1 ?? u2 ?? u3);
      const r = resolveRef(ref, dir);
      if (r.kind === "external") {
        ctx.note("external", ref, from);
        return all;
      }
      if (r.kind !== "local") return all;
      const hit = ctx.project.find(r.path);
      if (!hit) {
        ctx.note("missing", r.path, from);
        return isImport ? "" : `url("${EMPTY_URL}")`;
      }
      if (hit.matched) ctx.note("matched", r.path, from, hit.path);
      if (!isImport) return `url(${dataUrl(hit.path, hit.content)})`;
      if (stack.includes(hit.path) || stack.length > 8) return "";
      const inner = processCss(hit.content, dirOf(hit.path), ctx, hit.path, [
        ...stack,
        hit.path,
      ]).replace(/\r?\n/g, " ");
      const m = (media || "").trim();
      return m ? `@media ${m} { ${inner} }` : inner;
    },
  );
}

function processSrcset(value, dir, ctx, from) {
  const out = [];
  let i = 0;
  const s = String(value);
  while (i < s.length) {
    while (i < s.length && /[\s,]/.test(s[i])) i++;
    if (i >= s.length) break;
    let j = i;
    while (j < s.length && !/\s/.test(s[j])) j++;
    let url = s.slice(i, j),
      descriptor = "";
    if (url.endsWith(",")) url = url.replace(/,+$/, "");
    else {
      let k = j;
      while (k < s.length && s[k] !== ",") k++;
      descriptor = s.slice(j, k).trim();
      j = k;
    }
    out.push(
      (
        assetUrl(url, dir, ctx, from) + (descriptor ? " " + descriptor : "")
      ).trim(),
    );
    i = j + 1;
  }
  return out.join(", ");
}

// A page attribute's URL: a project file becomes a data: URL; a missing one
// becomes empty; an external one stays (the sandbox refuses to load it).
function assetUrl(ref, dir, ctx, from) {
  const r = resolveRef(ref, dir);
  if (r.kind === "external") {
    ctx.note("external", ref, from);
    return ref;
  }
  if (r.kind !== "local") return ref;
  const hit = ctx.project.find(r.path);
  if (!hit) {
    ctx.note("missing", r.path, from);
    return EMPTY_URL;
  }
  if (hit.matched) ctx.note("matched", r.path, from, hit.path);
  return dataUrl(hit.path, hit.content);
}

const RAW_TEXT = new Set([
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);
const HINT_RELS =
  /\b(?:dns-prefetch|preconnect|prefetch|prerender|preload|modulepreload|manifest)\b/i;
const URL_ATTRS = {
  img: ["src"],
  source: ["src"],
  video: ["src", "poster"],
  audio: ["src"],
  track: ["src"],
  input: ["src"],
  image: ["href", "xlink:href"],
  feimage: ["href", "xlink:href"],
};

function processHtml(html, ctx) {
  const TAG =
    /<!--[\s\S]*?(?:--!?>|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>?|<\?[^>]*>?|<(\/?)([a-zA-Z][^\s\/>]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  const src = String(html);
  const deferred = [];
  let out = "",
    last = 0,
    m;
  // Every search starts where the last element ended (raw text included).
  while (((TAG.lastIndex = last), (m = TAG.exec(src)))) {
    out += src.slice(last, m.index);
    last = TAG.lastIndex;
    const [all, closing, rawName, rawAttrs] = m;
    if (!rawName || closing) {
      out += all;
      continue;
    }
    const name = rawName.toLowerCase();
    const selfClosing = /\/\s*$/.test(rawAttrs);
    const attrs = parseAttributes(rawAttrs.replace(/\/\s*$/, ""));
    const get = (n) => attrs.find((a) => a.name.toLowerCase() === n);
    const set = (a, value) => {
      a.value = value;
      a.changed = true;
    };
    // Raw text: the element's content runs to its closing tag.
    let content = null;
    if (RAW_TEXT.has(name)) {
      if (name === "plaintext") {
        content = src.slice(last);
        last = src.length;
      } else {
        const end = new RegExp(`</${name}(?=[\\s/>])`, "ig");
        end.lastIndex = last;
        const e = end.exec(src);
        const stop = e ? e.index : src.length;
        content = src.slice(last, stop);
        last = stop;
      }
    }
    for (const a of attrs)
      if (a.name.toLowerCase() === "style" && a.value !== undefined) {
        const css = processCss(a.value, ctx.dir, ctx, ctx.entry);
        if (css !== a.value) set(a, css);
      }
    if (name === "script") {
      const srcAttr = get("src");
      const type = (get("type")?.value || "").trim();
      const isJs = JS_TYPES.test(type);
      const isModule = /^module$/i.test(type);
      if (srcAttr?.value === undefined) {
        if (isModule && RELATIVE_IMPORT.test(content))
          ctx.note("module", ctx.entry, ctx.entry);
        // Named, so an error's line number is within this script.
        const label = `${ctx.entry.replace(/[^\w./@-]/g, "_")}#script-${++ctx.scripts}`;
        out +=
          serializeTag(rawName, attrs, false) +
          content +
          (isJs && content.trim() ? `\n//# sourceURL=${label}` : "");
        continue;
      }
      const r = resolveRef(srcAttr.value, ctx.dir);
      if (r.kind === "external") {
        ctx.note("external", srcAttr.value, ctx.entry);
        out += serializeTag(rawName, attrs, false) + content;
        continue;
      }
      if (r.kind !== "local") {
        out += serializeTag(rawName, attrs, false) + content;
        continue;
      }
      const hit = ctx.project.find(r.path);
      // Skip the original element's closing tag too.
      const close = /^<\/script\s*>/i.exec(src.slice(last));
      if (close) last += close[0].length;
      if (!hit) {
        ctx.note("missing", r.path, ctx.entry);
        out += `<!-- missing: ${r.path.replace(/--/g, "- -")} -->`;
        continue;
      }
      if (hit.matched) ctx.note("matched", r.path, ctx.entry, hit.path);
      if (isModule && RELATIVE_IMPORT.test(hit.content))
        ctx.note("module", hit.path, hit.path);
      const keep = attrs.filter(
        (a) =>
          ![
            "src",
            "async",
            "defer",
            "integrity",
            "crossorigin",
            "charset",
            "referrerpolicy",
            "fetchpriority",
          ].includes(a.name.toLowerCase()),
      );
      const label = hit.path.replace(/[^\w./@-]/g, "_");
      const inline =
        serializeTag(rawName, keep, false) +
        scriptText(hit.content + (isJs ? `\n//# sourceURL=${label}` : "")) +
        "</script>";
      // A deferred classic script runs once the page is parsed: at the end.
      if (get("defer") && !isModule) deferred.push(inline);
      else out += inline;
      continue;
    }
    if (name === "style") {
      out +=
        serializeTag(rawName, attrs, false) +
        styleText(processCss(content, ctx.dir, ctx, ctx.entry));
      continue;
    }
    if (name === "link") {
      const rel = (get("rel")?.value || "").toLowerCase();
      const href = get("href");
      if (HINT_RELS.test(rel) && !/\bstylesheet\b/.test(rel)) continue;
      if (/\bstylesheet\b/.test(rel) && href?.value !== undefined) {
        const r = resolveRef(href.value, ctx.dir);
        if (r.kind === "external") ctx.note("external", href.value, ctx.entry);
        if (r.kind === "local") {
          const hit = ctx.project.find(r.path);
          if (!hit) {
            ctx.note("missing", r.path, ctx.entry);
            out += `<!-- missing: ${r.path.replace(/--/g, "- -")} -->`;
            continue;
          }
          if (hit.matched) ctx.note("matched", r.path, ctx.entry, hit.path);
          const media = get("media")?.value;
          const css = processCss(
            hit.content,
            dirOf(hit.path),
            ctx,
            hit.path,
          ).replace(/\r?\n/g, " ");
          out +=
            `<style data-preview-href="${escapeAttr(hit.path)}"${media ? ` media="${escapeAttr(media)}"` : ""}>` +
            styleText(css) +
            "</style>";
          continue;
        }
      }
      out += serializeTag(rawName, attrs, selfClosing);
      continue;
    }
    // Declarative shadow roots stay plain (inert) templates: a closed one
    // would hide what's inside from the shim.
    if (name === "template") {
      const mode = get("shadowrootmode");
      if (mode) {
        mode.name = "data-preview-shadowrootmode";
        mode.changed = true;
        ctx.note(
          "unsupported",
          "<template shadowrootmode>",
          ctx.entry,
          "template",
        );
      }
    }
    for (const n of URL_ATTRS[name] || []) {
      const a = get(n);
      if (a?.value === undefined) continue;
      if (
        name === "input" &&
        (get("type")?.value || "").toLowerCase() !== "image"
      )
        continue;
      const next = assetUrl(a.value, ctx.dir, ctx, ctx.entry);
      if (next !== a.value) set(a, next);
    }
    for (const n of ["srcset"]) {
      const a = get(n);
      if (a?.value === undefined || !["img", "source"].includes(name)) continue;
      const next = processSrcset(a.value, ctx.dir, ctx, ctx.entry);
      if (next !== a.value) set(a, next);
    }
    if (name === "use") {
      const a = get("href") || get("xlink:href");
      const r = resolveRef(a?.value, ctx.dir);
      if (r.kind === "local" || r.kind === "external")
        ctx.note("unsupported", a.value, ctx.entry, "use");
    }
    // Nested frames never load (a frame of its own would run outside the
    // shim); objects and embeds keep their fallback content.
    if (
      ["iframe", "frame", "object", "embed", "portal", "fencedframe"].includes(
        name,
      )
    ) {
      const a = get(name === "object" ? "data" : "src");
      ctx.note(
        "unsupported",
        a?.value || (get("srcdoc") ? "srcdoc" : `<${name}>`),
        ctx.entry,
        name,
      );
      out += `<!-- ${name} not shown in the preview -->`;
      continue;
    }
    const changed = attrs.some((a) => a.changed);
    out +=
      (changed ? serializeTag(rawName, attrs, selfClosing) : all) +
      (content ?? "");
  }
  out += src.slice(last);
  if (deferred.length) {
    const at = out.search(/<\/body\s*>(?![\s\S]*<\/body\s*>)/i);
    out =
      at < 0
        ? out + deferred.join("")
        : out.slice(0, at) + deferred.join("") + out.slice(at);
  }
  return out;
}

// JSON that can sit inside a <script> element.
export const safeJson = (value) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

// Runs first in every previewed page, on one line (so the page's own line
// numbers stay as written). It reports console output, uncaught errors and
// sandbox refusals to the app as plain text, capped; turns links to the
// project's other pages into a request to show that page; lets forms and
// alert() work without the sandbox's allow-forms/allow-modals; and gives the
// page a temporary in-memory localStorage/sessionStorage, since the real
// ones don't exist for a sandboxed page. WebRTC isn't covered by CSP, so
// its constructors are removed here (best effort).
export const PREVIEW_SHIM = `function (c) {
  "use strict";
  var P = window.parent, sent = 0;
  function post(m) { try { P.postMessage(m, c.origin || "*"); } catch (e) {} }
  function fmt(v) {
    try {
      if (typeof v === "string") return v;
      if (v instanceof Error) return (v.name || "Error") + ": " + v.message;
      if (v === undefined) return "undefined";
      if (typeof v === "function") return "function " + (v.name || "") + "()";
      if (typeof v === "symbol" || typeof v === "bigint") return String(v);
      if (v && typeof v === "object") {
        if (typeof Node !== "undefined" && v instanceof Node) return "<" + String(v.nodeName || "node").toLowerCase() + ">";
        var seen = [];
        var s = JSON.stringify(v, function (k, x) {
          if (typeof x === "bigint") return String(x);
          if (typeof x === "function") return "[Function]";
          if (x && typeof x === "object") { if (seen.indexOf(x) >= 0) return "[Circular]"; seen.push(x); }
          return x;
        });
        return s === undefined ? String(v) : s;
      }
      return String(v);
    } catch (e) { return Object.prototype.toString.call(v); }
  }
  function send(level, text) {
    sent++;
    if (sent > c.limit) {
      if (sent === c.limit + 1) post({ type: c.type, level: "warn", text: "Console output stopped after " + c.limit + " messages." });
      return;
    }
    text = String(text);
    if (text.length > c.max) text = text.slice(0, c.max) + "…";
    post({ type: c.type, level: level, text: text });
  }
  ["log", "info", "warn", "error", "debug"].forEach(function (k) {
    var original = console[k];
    console[k] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length; i++) parts.push(fmt(arguments[i]));
      send(k, parts.join(" "));
      if (typeof original === "function") return original.apply(console, arguments);
    };
  });
  function where(file, line) {
    if (!line) return "";
    file = String(file || "");
    if (!file || file.indexOf(c.frame) >= 0) return " (" + c.entry + ")";
    if (file.indexOf(location.origin + "/") === 0) file = file.slice(location.origin.length + 1);
    var inline = /^(.*)#script-(\\d+)$/.exec(file);
    if (inline) return " (" + inline[1] + ", inline script " + inline[2] + ", line " + line + ")";
    return " (" + file + ":" + line + ")";
  }
  window.addEventListener("error", function (e) {
    if (e.target && e.target !== window) return;
    send("error", (e.message || "Error") + where(e.filename, e.lineno));
  });
  window.addEventListener("unhandledrejection", function (e) { send("error", "Unhandled rejection: " + fmt(e.reason)); });
  var reported = [];
  document.addEventListener("securitypolicyviolation", function (e) {
    var text = "Blocked by the preview sandbox: " + (e.blockedURI || "inline") + " (" + (e.effectiveDirective || e.violatedDirective || "policy") + ")";
    if (reported.indexOf(text) >= 0) return;
    if (reported.length < 100) reported.push(text);
    send("blocked", text);
  });
  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href], area[href]") : null;
    if (!a) return;
    var href = a.getAttribute("href") || "";
    if (href.charAt(0) === "#" || /^javascript:/i.test(href)) return;
    e.preventDefault();
    var url = null;
    try { url = new URL(href, "https://preview.invalid/" + c.dir); } catch (x) {}
    if (url && url.origin === "https://preview.invalid") {
      var path = url.pathname.slice(1);
      try { path = decodeURIComponent(path); } catch (x) {}
      if (path === c.entry && url.hash) { location.hash = url.hash; return; }
      if (c.pages.indexOf(path) >= 0) { post({ type: c.open, path: path }); return; }
    }
    send("info", "Links don't leave the preview: " + href);
  }, true);
  function isSubmit(el) {
    if (!el || !el.form) return false;
    var t = (el.getAttribute("type") || "").toLowerCase();
    return el.tagName === "BUTTON" ? (t === "" || t === "submit") : el.tagName === "INPUT" && (t === "submit" || t === "image");
  }
  function submit(form, submitter) {
    if (!form.noValidate && !(submitter && submitter.formNoValidate) && !form.checkValidity()) { form.reportValidity(); return; }
    var ev;
    try { ev = new SubmitEvent("submit", { bubbles: true, cancelable: true, submitter: submitter || null }); }
    catch (x) { ev = new Event("submit", { bubbles: true, cancelable: true }); }
    if (form.dispatchEvent(ev)) send("info", "Forms don't send anywhere in the preview.");
  }
  window.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button, input") : null;
    if (e.defaultPrevented || !isSubmit(b) || b.disabled) return;
    submit(b.form, b);
  });
  window.addEventListener("keydown", function (e) {
    var t = e.target;
    if (e.defaultPrevented || e.key !== "Enter" || e.isComposing || !t || t.tagName !== "INPUT" || !t.form) return;
    if (/^(button|submit|reset|image|checkbox|radio|file|color|range)$/i.test(t.type)) return;
    var els = t.form.elements;
    for (var i = 0; i < els.length; i++) if (isSubmit(els[i])) return;
    e.preventDefault();
    submit(t.form, null);
  });
  window.alert = function (m) { send("info", "alert: " + fmt(m)); };
  window.confirm = function (m) { send("info", "confirm: " + fmt(m) + " (answered Cancel)"); return false; };
  window.prompt = function (m) { send("info", "prompt: " + fmt(m) + " (answered Cancel)"); return null; };
  function memoryStorage() {
    var data = new Map(), told = false;
    function note() { if (!told) { told = true; send("info", "Storage here is temporary and separate from ANONYMA."); } }
    return {
      get length() { return data.size; },
      key: function (i) { return Array.from(data.keys())[i] ?? null; },
      getItem: function (k) { note(); k = String(k); return data.has(k) ? data.get(k) : null; },
      setItem: function (k, v) { note(); data.set(String(k), String(v)); },
      removeItem: function (k) { data.delete(String(k)); },
      clear: function () { data.clear(); }
    };
  }
  ["localStorage", "sessionStorage"].forEach(function (k) {
    try { Object.defineProperty(window, k, { value: memoryStorage(), configurable: true }); } catch (e) {}
  });
  ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription"].forEach(function (k) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  });
  var apply = Reflect.apply, own = Object.getOwnPropertyDescriptor;
  var removeNode = Element.prototype.remove, findAll = Element.prototype.querySelectorAll, isA = Element.prototype.matches;
  var empty = Element.prototype.replaceChildren, rootOf = own(Document.prototype, "documentElement").get;
  var typeOf = own(Node.prototype, "nodeType").get, addedOf = own(MutationRecord.prototype, "addedNodes").get;
  var countOf = own(NodeList.prototype, "length").get, framesOf = own(window, "length").get;
  var observe = MutationObserver.prototype.observe, attach = Element.prototype.attachShadow;
  var FRAMES = "iframe, frame, object, embed, portal, fencedframe", WATCH = { childList: true, subtree: true }, stripped = false;
  function strip(node) {
    if (!node || apply(typeOf, node, []) !== 1) return;
    var single = apply(isA, node, [FRAMES]);
    var found = single ? [node] : apply(findAll, node, [FRAMES]);
    var n = single ? 1 : apply(countOf, found, []);
    for (var i = 0; i < n; i++) apply(removeNode, found[i], []);
    if (n && !stripped) { stripped = true; send("blocked", "Nested frames aren't shown in the preview."); }
  }
  function guard() {
    if (apply(framesOf, window, []) > 0) {
      apply(empty, apply(rootOf, document, []), []);
      send("blocked", "This page hid a nested frame, so the preview stopped it.");
    }
  }
  var watcher = new MutationObserver(function (records) {
    for (var i = 0; i < records.length; i++) {
      var added = apply(addedOf, records[i], []);
      for (var j = 0, n = apply(countOf, added, []); j < n; j++) strip(added[j]);
    }
    guard();
  });
  apply(observe, watcher, [document, WATCH]);
  function lock(target, name, value) {
    try { Object.defineProperty(target, name, { configurable: false, writable: false, value: value }); } catch (e) {}
  }
  var DSD = /shadowrootmode/gi, tail = "";
  function noDsd(html) { return String(html).replace(DSD, "data-preview-srm"); }
  ["write", "writeln"].forEach(function (k) {
    var original = Document.prototype[k];
    lock(Document.prototype, k, function () {
      var text = "";
      for (var i = 0; i < arguments.length; i++) text += String(arguments[i]);
      text = noDsd(text);
      if (/shadowrootmode/i.test(tail + text)) text = " " + text;
      tail = text.slice(-16);
      return apply(original, this, [text]);
    });
  });
  [Element.prototype, typeof ShadowRoot === "undefined" ? null : ShadowRoot.prototype].forEach(function (proto) {
    var original = proto && proto.setHTMLUnsafe;
    if (original) lock(proto, "setHTMLUnsafe", function (html, options) { return apply(original, this, [noDsd(html), options]); });
  });
  if (Document.parseHTMLUnsafe) {
    var parse = Document.parseHTMLUnsafe;
    lock(Document, "parseHTMLUnsafe", function (html, options) { return apply(parse, Document, [noDsd(html), options]); });
  }
  try {
    lock(Element.prototype, "attachShadow", function (init) {
      init = init || {};
      var root = apply(attach, this, [{ mode: init.mode === "open" ? "open" : "closed", delegatesFocus: !!init.delegatesFocus, slotAssignment: init.slotAssignment === "manual" ? "manual" : "named", serializable: !!init.serializable, clonable: false }]);
      apply(observe, watcher, [root, WATCH]);
      return root;
    });
    var internal = own(ElementInternals.prototype, "shadowRoot").get;
    Object.defineProperty(ElementInternals.prototype, "shadowRoot", { configurable: false, get: function () {
      var root = apply(internal, this, []); if (root) apply(observe, watcher, [root, WATCH]); return root;
    } });
  } catch (e) {}
}`.replace(/\n\s*/g, " ");

// The document the preview frame shows for `entry` (or index.html, or the
// first page). Returns { html, entry, pages, notes }; html is null when there
// is no page to show or the result is too large.
export function assemblePreview({
  files = [],
  entry,
  origin = "",
  limit = MAX_PREVIEW_CHARS,
} = {}) {
  const project = indexProject(files);
  const pages = previewPages(files);
  const notes = [];
  const seen = new Set();
  const note = (kind, ref, from, path) => {
    const key = [kind, ref, from, path].join("\u0000");
    if (seen.has(key) || notes.length >= 100) return;
    seen.add(key);
    notes.push({ kind, ref, from, ...(path ? { path } : {}) });
  };
  const chosen = pages.includes(normalizePath(entry))
    ? normalizePath(entry)
    : pages[0];
  if (!chosen)
    return { html: null, entry: null, pages, notes: [{ kind: "no-html" }] };
  let source = project.byPath.get(chosen);
  // A doctype stays first (standards mode, which a bare fragment also
  // gets); everything else follows the policy and the shim, on the same
  // line, so the page's line numbers don't move.
  let doctype = !/<html[\s>]/i.test(source);
  source = source.replace(
    /^(﻿?(?:\s*<!--[\s\S]*?-->)*\s*)<!doctype\b[^>]*>/i,
    (all, lead) => {
      doctype = true;
      return lead;
    },
  );
  const body = processHtml(source, {
    project,
    note,
    dir: dirOf(chosen),
    entry: chosen,
    scripts: 0,
  });
  const shim = {
    origin,
    frame: PREVIEW_FRAME_PATH,
    type: PREVIEW_MESSAGE.console,
    open: PREVIEW_MESSAGE.open,
    entry: chosen,
    dir: dirOf(chosen),
    pages,
    limit: CONSOLE_SEND,
    max: CONSOLE_TEXT,
  };
  const html =
    (doctype ? "<!DOCTYPE html>" : "") +
    `<meta http-equiv="Content-Security-Policy" content="${escapeAttr(PREVIEW_CSP)}">` +
    `<meta http-equiv="x-dns-prefetch-control" content="off">` +
    `<script>(${PREVIEW_SHIM})(${safeJson(shim)});</script>` +
    body;
  if (html.length > limit)
    return { html: null, entry: chosen, pages, notes: [{ kind: "too-large" }] };
  return { html, entry: chosen, pages, notes };
}

// A single HTML block from a reply, previewed on its own.
export const assembleSnippet = (html, origin = "") =>
  assemblePreview({ files: [{ path: "index.html", content: html }], origin });

// What a note says, for the notes list.
export function noteText(n) {
  switch (n.kind) {
    case "missing":
      return `Missing file: ${n.ref} (referenced in ${n.from})`;
    case "external":
      return `Not loaded, the preview blocks network requests: ${n.ref}`;
    case "matched":
      return `${n.ref} matched to ${n.path} by file name`;
    case "module":
      return `Module imports between files aren't resolved in the preview: ${n.from}`;
    case "unsupported":
      return `Not shown in the preview: ${n.ref}`;
    case "no-html":
      return "No HTML page to preview yet.";
    case "too-large":
      return "This page is too large to preview.";
    default:
      return String(n.kind);
  }
}

// ---------------------------------------------------------------------------
// Messages from the frame (the app side)
// ---------------------------------------------------------------------------

const LEVELS = ["log", "info", "warn", "error", "debug", "blocked"];
// A console line from the preview as { level, text }, or null. `data` is
// whatever the page posted: only a string survives, cut to size.
export function readConsoleMessage(data) {
  if (
    !data ||
    typeof data !== "object" ||
    data.type !== PREVIEW_MESSAGE.console
  )
    return null;
  const level = LEVELS.includes(data.level) ? data.level : "log";
  const text = typeof data.text === "string" ? data.text : "";
  return {
    level,
    text: text.length > CONSOLE_TEXT ? text.slice(0, CONSOLE_TEXT) + "…" : text,
  };
}
// The shim's own notices (not the page's output), which the console shows in
// the reader's language.
const SHIM_NOTICES = [
  /^Nested frames aren't shown in the preview\.$/,
  /^This page hid a nested frame, so the preview stopped it\.$/,
  /^Storage here is temporary and separate from ANONYMA\.$/,
  /^Forms don't send anywhere in the preview\.$/,
  /^Console output stopped after \d+ messages\.$/,
  /^Links don't leave the preview: \S+$/,
  /^Blocked by the preview sandbox: \S+ \([\w-]+\)$/,
];
export const isShimNotice = (text) =>
  SHIM_NOTICES.some((re) => re.test(String(text)));
// A request from a preview link to show another page of the project: only a
// page the project really has.
export function readOpenMessage(data, pages = []) {
  if (!data || typeof data !== "object" || data.type !== PREVIEW_MESSAGE.open)
    return null;
  return typeof data.path === "string" && pages.includes(data.path)
    ? data.path
    : null;
}
// Adds console lines, keeping the newest CONSOLE_KEEP; `dropped` counts the rest.
export function appendConsole(state, lines) {
  const all = [...state.lines, ...lines];
  const over = Math.max(0, all.length - CONSOLE_KEEP);
  return { lines: over ? all.slice(over) : all, dropped: state.dropped + over };
}

// A small prepared project for the demo workspace (?demo=1): a page, its
// stylesheet and its script, so Preview has something real to run.
export const PREVIEW_DEMO_REPLY = `Here is a small page you can run in Preview.

\`\`\`html index.html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Idea counter</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <main class="card">
    <p class="eyebrow">A LITTLE POSSIBILITY</p>
    <h1>Ideas today: <span id="count">0</span></h1>
    <button id="add" type="button">Add an idea</button>
  </main>
  <script src="script.js"></script>
</body>
</html>
\`\`\`

\`\`\`css style.css
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0135df; font-family: Georgia, serif; }
.card { background: #fff; padding: 40px; border-radius: 12px; text-align: center; max-width: 80vw; }
.eyebrow { letter-spacing: .2em; font-size: 12px; color: #0135df; }
h1 { font-size: clamp(28px, 6vw, 48px); margin: 8px 0 24px; }
button { font: inherit; padding: 12px 20px; border: 0; border-radius: 999px; background: #c9a54a; cursor: pointer; }
\`\`\`

\`\`\`js script.js
const count = document.getElementById("count");
let ideas = 0;
document.getElementById("add").addEventListener("click", () => {
  ideas += 1;
  count.textContent = ideas;
  console.log("Ideas today:", ideas);
});
\`\`\`

Open the Preview tab to run it. It runs in a sandbox in your browser, and its network requests are blocked.`;
