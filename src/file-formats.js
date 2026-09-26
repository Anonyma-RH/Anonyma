// Bounded OOXML text extraction shared by the browser and server. No formulas,
// scripts, macros, relationships or external resources are evaluated.
export const FILE_LIMIT = 10 * 1024 * 1024;
export const EXPANDED_LIMIT = 8 * 1024 * 1024;
export const XML_LIMIT = 2 * 1024 * 1024;
export const EXTRACTED_LIMIT = 100000;
export const OFFICE_EXTENSIONS = ["docx", "xlsx", "pptx"];
const bad = (message) => {
  throw new Error(message);
};
const decoder = new TextDecoder("utf-8", { fatal: true });
export function textBytes(bytes) {
  const text = decoder.decode(bytes);
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text))
    bad("The file is not supported UTF-8 text.");
  return text.replace(/^\uFEFF/, "");
}
export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let bit = 0; bit < 8; bit++)
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
export function zipEntries(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length < 22 || bytes.length > FILE_LIMIT)
    bad("Office files must be non-empty and at most 10 MB.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p) => view.getUint16(p, true),
    u32 = (p) => view.getUint32(p, true);
  let end = -1;
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (u32(p) === 0x06054b50 && p + 22 + u16(p + 20) === bytes.length) {
      end = p;
      break;
    }
  }
  if (end < 0 || u16(end + 4) || u16(end + 6) || u16(end + 8) !== u16(end + 10))
    bad("Unsupported or malformed ZIP archive.");
  const count = u16(end + 10),
    size = u32(end + 12),
    start = u32(end + 16);
  if (!count || count > 256 || start + size !== end)
    bad("Office archive exceeds its entry limit or is malformed.");
  const entries = new Map();
  let pos = start,
    expanded = 0;
  const ranges = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > end || u32(pos) !== 0x02014b50)
      bad("Malformed ZIP directory.");
    const flags = u16(pos + 8),
      method = u16(pos + 10),
      checksum = u32(pos + 16),
      packed = u32(pos + 20),
      length = u32(pos + 24),
      nl = u16(pos + 28),
      el = u16(pos + 30),
      cl = u16(pos + 32),
      local = u32(pos + 42);
    if (
      pos + 46 + nl + el + cl > end ||
      !nl ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      u16(pos + 34) ||
      packed === 0xffffffff ||
      length === 0xffffffff ||
      local === 0xffffffff
    )
      bad("Encrypted, split or ZIP64 archives are not supported.");
    const name = decoder.decode(bytes.subarray(pos + 46, pos + 46 + nl));
    if (
      name.length > 240 ||
      /(^\/|\\|\x00|(^|\/)\.\.?($|\/))/.test(name) ||
      entries.has(name)
    )
      bad("Unsafe or duplicate archive entry.");
    if (/vbaProject|activeX|embeddings\//i.test(name))
      bad("Macros and embedded executable objects are not supported.");
    expanded += length;
    if (
      expanded > EXPANDED_LIMIT ||
      length > XML_LIMIT ||
      length > Math.max(1024, packed * 200)
    )
      bad("Expanded Office content exceeds the safe extraction limit.");
    if (
      local + 30 > start ||
      u32(local) !== 0x04034b50 ||
      u16(local + 8) !== method ||
      u16(local + 6) !== flags
    )
      bad("Malformed ZIP entry.");
    const lnl = u16(local + 26),
      lel = u16(local + 28),
      data = local + 30 + lnl + lel;
    if (
      data + packed > start ||
      decoder.decode(bytes.subarray(local + 30, local + 30 + lnl)) !== name
    )
      bad("Malformed ZIP entry bounds.");
    if (
      !(flags & 8) &&
      (u32(local + 14) !== checksum ||
        u32(local + 18) !== packed ||
        u32(local + 22) !== length)
    )
      bad("Inconsistent ZIP entry.");
    if (ranges.some(([a, b]) => local < b && data + packed > a))
      bad("Overlapping ZIP entries are not supported.");
    ranges.push([local, data + packed]);
    entries.set(name, {
      name,
      method,
      checksum,
      length,
      bytes: bytes.subarray(data, data + packed),
    });
    pos += 46 + nl + el + cl;
  }
  if (pos !== end) bad("Malformed ZIP directory size.");
  return entries;
}
function entities(text) {
  return text.replace(/&([^;\s]{1,32});/g, (_, value) => {
    if (/^(amp|lt|gt|quot|apos)$/.test(value))
      return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[value];
    if (!/^#(?:[0-9]+|x[0-9a-f]+)$/i.test(value))
      bad("Custom XML entities are not supported.");
    const code =
      value[1].toLowerCase() === "x"
        ? parseInt(value.slice(2), 16)
        : Number(value.slice(1));
    if (
      !Number.isInteger(code) ||
      code > 0x10ffff ||
      (code < 0x20 && ![9, 10, 13].includes(code)) ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      bad("Invalid XML character.");
    return String.fromCodePoint(code);
  });
}
export function parseOfficeXML(text) {
  if (text.length > XML_LIMIT || /<!\s*(DOCTYPE|ENTITY)/i.test(text))
    bad("XML entities and document types are not supported.");
  const root = { name: "#", children: [], attrs: {} };
  const stack = [root];
  let at = 0,
    nodes = 0;
  const tokens =
    /<!--[\s\S]*?-->|<\?xml\s[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
  for (const match of text.matchAll(tokens)) {
    if (match.index !== at || ++nodes > 100000)
      bad("Malformed or excessive XML content.");
    const token = match[0];
    at += token.length;
    const parent = stack.at(-1);
    if (token.startsWith("<!--") || token.startsWith("<?xml ")) continue;
    if (token.startsWith("<![CDATA[")) {
      parent.children.push(token.slice(9, -3));
      continue;
    }
    if (!token.startsWith("<")) {
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(token))
        bad("Malformed XML entity.");
      parent.children.push(entities(token));
      continue;
    }
    if (token.startsWith("</")) {
      const end = /^<\/([\w:.-]+)\s*>$/.exec(token);
      if (!end || stack.length < 2 || stack.pop().name !== end[1])
        bad("Malformed XML nesting.");
      continue;
    }
    const begin = /^<([\w:.-]+)/.exec(token);
    if (!begin || !token.endsWith(">"))
      bad("Unsupported or malformed XML markup.");
    let attrs = token.slice(begin[0].length, -1),
      selfClosing = false;
    if (attrs.endsWith("/")) {
      selfClosing = true;
      attrs = attrs.slice(0, -1);
    }
    const node = { name: begin[1], attrs: Object.create(null), children: [] };
    const attr = /\s+([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
    let offset = 0;
    while (offset < attrs.length) {
      if (!attrs.slice(offset).trim()) break;
      attr.lastIndex = offset;
      const a = attr.exec(attrs);
      if (!a || Object.hasOwn(node.attrs, a[1]))
        bad("Malformed or duplicate XML attribute.");
      const value = a[2] ?? a[3];
      if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[\da-f]+;)/i.test(value))
        bad("Malformed XML entity.");
      node.attrs[a[1]] = entities(value);
      offset = attr.lastIndex;
    }
    parent.children.push(node);
    if (!selfClosing) {
      stack.push(node);
      if (stack.length > 64) bad("XML nesting is too deep.");
    }
  }
  if (
    at !== text.length ||
    stack.length !== 1 ||
    root.children.filter((n) => typeof n !== "string").length !== 1 ||
    root.children.some((n) => typeof n === "string" && n.trim())
  )
    bad("Malformed XML document.");
  return root;
}
const all = (node, name) =>
  typeof node === "string"
    ? []
    : [
        ...(node.name.split(":").at(-1) === name ? [node] : []),
        ...node.children.flatMap((n) => all(n, name)),
      ];
// Stop collecting text at the output bound instead of joining expanded trees.
const contents = (node) => {
  const pending = [node],
    pieces = [];
  let size = 0;
  while (pending.length && size <= EXTRACTED_LIMIT) {
    const value = pending.pop();
    if (typeof value === "string") {
      const part = value.slice(0, EXTRACTED_LIMIT + 1 - size);
      pieces.push(part);
      size += part.length;
    } else
      for (let i = value.children.length - 1; i >= 0; i--)
        pending.push(value.children[i]);
  }
  return pieces.join("");
};
// DOCX text a reader wouldn't see: runs marked hidden (w:vanish), set under
// 2 pt, or white on an unshaded page outside tables. Only the browser asks
// for it (Injection Shield, src/shield.js); the text itself is unchanged.
const localName = (node) => node.name.split(":").at(-1);
const childNamed = (node, name) =>
  node?.children?.find((n) => typeof n !== "string" && localName(n) === name) || null;
function attrNamed(node, name) {
  for (const key in node?.attrs || {}) if (key.split(":").at(-1) === name) return node.attrs[key];
  return undefined;
}
const shaded = (shd) => {
  const fill = String(attrNamed(shd, "fill") || "auto").toLowerCase();
  return !!shd && !["auto", "ffffff", "none"].includes(fill);
};
export function docxHidden(tree) {
  const out = [];
  let chars = 0,
    last = null;
  const background = childNamed(childNamed(tree, "document") || tree, "background");
  const darkPage = !!background && !/^(?:ffffff|auto)?$/i.test(attrNamed(background, "color") || "");
  const walk = (node, inTable, shadedParagraph) => {
    if (typeof node === "string" || out.length >= 50 || chars > 20000) return;
    const local = localName(node);
    if (local === "tbl") inTable = true;
    if (local === "p") shadedParagraph = shaded(childNamed(childNamed(node, "pPr"), "shd"));
    if (local === "r") {
      const pr = childNamed(node, "rPr");
      let why = null;
      if (pr) {
        const vanish = childNamed(pr, "vanish"),
          size = childNamed(pr, "sz"),
          color = childNamed(pr, "color");
        const off = /^(?:0|false|off)$/i.test(attrNamed(vanish, "val") || "");
        if (vanish && !off) why = "vanish";
        else if (size && Number(attrNamed(size, "val")) < 4) why = "tiny";
        else if (
          color &&
          /^(?:ffffff|fffffe|fefefe)$/i.test(attrNamed(color, "val") || "") &&
          !inTable &&
          !darkPage &&
          !shadedParagraph &&
          !shaded(childNamed(pr, "shd")) &&
          !childNamed(pr, "highlight")
        )
          why = "white";
      }
      const text = all(node, "t").map(contents).join("");
      if (!text.trim()) return;
      if (!why) {
        last = null;
        return;
      }
      chars += text.length;
      if (last && last.why === why) last.text += text;
      else out.push((last = { why, text }));
      return;
    }
    for (const child of node.children) walk(child, inTable, shadedParagraph);
    if (local === "p" && last) last.text += "\n";
  };
  walk(tree, false, false);
  return out
    .map((h) => ({ ...h, text: h.text.replace(/\s+/g, " ").trim().slice(0, 2000) }))
    .filter((h) => h.text);
}
export async function extractOffice(input, extension, inflate, { hidden = false } = {}) {
  if (!OFFICE_EXTENSIONS.includes(extension))
    bad(
      "Choose DOCX, XLSX or PPTX. Legacy and macro-enabled Office files are not supported.",
    );
  const entries = zipEntries(input);
  const read = async (name) => {
    const e = entries.get(name);
    if (!e) bad("The Office file is missing required content.");
    const bytes = e.method === 0 ? e.bytes : await inflate(e.bytes, e.length);
    if (bytes.length !== e.length || crc32(bytes) !== e.checksum)
      bad("Office entry checksum or size is invalid.");
    return parseOfficeXML(textBytes(bytes));
  };
  const types = await read("[Content_Types].xml");
  const mime = {
    docx: "wordprocessingml.document.main+xml",
    xlsx: "spreadsheetml.sheet.main+xml",
    pptx: "presentationml.presentation.main+xml",
  }[extension];
  if (!all(types, "Override").some((n) => n.attrs.ContentType?.includes(mime)))
    bad("The file contents do not match its Office extension.");
  const chunks = [];
  let size = 0,
    overflow = false;
  const add = (value) => {
    const remaining = EXTRACTED_LIMIT + 1 - size;
    if (value.length > remaining) overflow = true;
    if (remaining > 0) {
      const part = value.slice(0, remaining);
      chunks.push(part);
      size += part.length;
    }
  };
  const full = () => size > EXTRACTED_LIMIT;
  const paragraphs = (tree) => {
    for (const p of all(tree, "p")) {
      if (full()) break;
      add("\n");
      for (const t of all(p, "t")) {
        add(contents(t));
        if (full()) break;
      }
    }
  };
  let hiddenText = [];
  if (extension === "docx") {
    const tree = await read("word/document.xml");
    paragraphs(tree);
    if (hidden) hiddenText = docxHidden(tree);
  }
  if (extension === "pptx") {
    const names = [...entries.keys()]
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!names.length) bad("No supported slides found.");
    for (let i = 0; i < names.length && !full(); i++) {
      add(`\nSlide ${i + 1}`);
      paragraphs(await read(names[i]));
    }
  }
  if (extension === "xlsx") {
    const shared = [];
    let sharedSize = 0;
    if (entries.has("xl/sharedStrings.xml"))
      for (const si of all(await read("xl/sharedStrings.xml"), "si")) {
        const value = contents(si);
        sharedSize += value.length;
        if (sharedSize > XML_LIMIT)
          bad("Shared string text exceeds the extraction limit.");
        shared.push(value);
      }
    const names = [...entries.keys()]
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!names.length) bad("No supported worksheets found.");
    for (let i = 0; i < names.length && !full(); i++) {
      add(`\nWorksheet ${i + 1} (stored values; formulas are not evaluated)`);
      for (const row of all(await read(names[i]), "row")) {
        if (full()) break;
        add("\n");
        let first = true;
        for (const c of all(row, "c")) {
          if (full()) break;
          if (!first) add("\t");
          first = false;
          add(`${c.attrs.r || "cell"}: `);
          const v = all(c, "v")[0];
          if (c.attrs.t === "s")
            add(shared[Number(v ? contents(v) : NaN)] ?? "");
          else if (c.attrs.t === "inlineStr") {
            for (const t of all(c, "t")) {
              add(contents(t));
              if (full()) break;
            }
          } else if (v) add(contents(v));
        }
      }
    }
  }
  const raw = chunks.join("").trim();
  return {
    text: raw.slice(0, EXTRACTED_LIMIT),
    truncated: overflow || size > EXTRACTED_LIMIT,
    warning:
      "Text only. Layout, comments, embedded objects and formula calculation are not included.",
    ...(hidden ? { hidden: hiddenText } : {}),
  };
}
export async function browserInflate(bytes, expected) {
  if (typeof DecompressionStream === "undefined")
    bad(
      "Office extraction is unavailable in this browser. Export as text or PDF.",
    );
  let stream;
  try {
    stream = new Blob([bytes])
      .stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
  } catch {
    bad(
      "Office extraction is unavailable in this browser. Export as text or PDF.",
    );
  }
  const reader = stream.getReader(),
    chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > expected || length > XML_LIMIT) {
        await reader.cancel();
        bad("Expanded Office entry exceeds its safe limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(length);
  let p = 0;
  for (const chunk of chunks) {
    out.set(chunk, p);
    p += chunk.length;
  }
  return out;
}
