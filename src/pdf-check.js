// PDF Redact: a check of the file it just wrote, made from the file's own
// bytes and nothing else. Redaction promises that the copy holds only
// pictures of pages, so before a download is offered the writer's output is
// read back and held to that shape: every object a known kind with only its
// known keys, every content stream only "place this picture", and no byte
// anywhere that isn't part of an object. A file that fails is not offered.
//
// No text operator, font, annotation, form, attachment, script, /Info or
// metadata entry is accepted; there's no allow-list entry for any of them.
// No DOM here: it runs in Node too (tests/pdf-redact.test.mjs, which also
// reads the same files with pdf.js as a second opinion).

const latin1 = (bytes, from, to) => {
  let s = "";
  for (let i = from; i < to; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(to, i + 0x8000)));
  return s;
};

// ---- a small reader for the dictionaries this writer produces ----------

function tokenize(text) {
  const tokens = [];
  const re = /<<|>>|\[|\]|\/[^\s/<>[\]()]*|[^\s/<>[\]()]+|\(|\)/g;
  let m;
  while ((m = re.exec(text))) tokens.push(m[0]);
  return tokens;
}
function parseValue(tokens, at) {
  const t = tokens[at];
  if (t === "<<") {
    const dict = {};
    let i = at + 1;
    while (tokens[i] !== ">>") {
      if (i >= tokens.length || !tokens[i].startsWith("/")) throw new Error("dictionary");
      const key = tokens[i].slice(1);
      const [value, next] = parseValue(tokens, i + 1);
      if (key in dict) throw new Error("repeated key");
      dict[key] = value;
      i = next;
    }
    return [dict, i + 1];
  }
  if (t === "[") {
    const list = [];
    let i = at + 1;
    while (tokens[i] !== "]") {
      if (i >= tokens.length) throw new Error("array");
      const [value, next] = parseValue(tokens, i);
      list.push(value);
      i = next;
    }
    return [list, i + 1];
  }
  if (t === undefined || t === ">>" || t === "]" || t === "(" || t === ")") throw new Error("value");
  // "12 0 R" is one reference.
  if (/^\d+$/.test(t) && /^\d+$/.test(tokens[at + 1] || "") && tokens[at + 2] === "R") return [`${t} ${tokens[at + 1]} R`, at + 3];
  return [t, at + 1];
}
function parseDictAt(text, start) {
  const from = text.indexOf("<<", start);
  if (from < 0) throw new Error("no dictionary");
  // Find the matching close so a nested dictionary doesn't end it early.
  let depth = 0,
    i = from;
  for (; i < text.length; i++) {
    if (text.startsWith("<<", i)) {
      depth++;
      i++;
    } else if (text.startsWith(">>", i)) {
      depth--;
      i++;
      if (!depth) break;
    }
  }
  if (depth) throw new Error("unterminated dictionary");
  const [dict] = parseValue(tokenize(text.slice(from, i + 1)), 0);
  return { dict, end: i + 1 };
}

const keysOf = (dict) => Object.keys(dict).sort().join(",");
const CATALOG = "Pages,Type";
const PAGES = "Count,Kids,Type";
const PAGE = "Contents,MediaBox,Parent,Resources,Type";
const IMAGE_KEYS = new Set(["BitsPerComponent", "ColorSpace", "Filter", "Height", "Length", "Subtype", "Type", "Width"]);
const num = (v) => typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v);
const ref = (v) => (typeof v === "string" && /^(\d+) 0 R$/.exec(v)?.[1]) || null;

// { ok, pages, problems } for a file this writer made. `problems` names
// what's wrong in plain terms; an empty list means only page pictures are
// in the file.
export function checkImageOnlyPdf(bytes) {
  const problems = [];
  const fail = (why) => {
    problems.push(why);
    return { ok: false, pages: 0, problems };
  };
  try {
    if (!bytes || bytes.length < 40) return fail("The file is empty.");
    if (latin1(bytes, 0, 9) !== "%PDF-1.4\n") return fail("The file doesn't start as expected.");
    const tail = latin1(bytes, Math.max(0, bytes.length - 64), bytes.length);
    const start = /startxref\n(\d+)\n%%EOF\n$/.exec(tail);
    if (!start) return fail("The file doesn't end as expected.");
    const xrefAt = Number(start[1]);
    const head = latin1(bytes, xrefAt, Math.min(bytes.length, xrefAt + 40));
    const size = /^xref\n0 (\d+)\n0000000000 65535 f \n/.exec(head);
    if (!size) return fail("The cross-reference table is missing.");
    const count = Number(size[1]);
    const table = latin1(bytes, xrefAt, bytes.length);
    const entries = [...table.matchAll(/^(\d{10}) 00000 n \n/gm)].map((m) => Number(m[1]));
    if (entries.length !== count - 1) return fail("The cross-reference table is the wrong length.");
    const trailerAt = table.indexOf("trailer\n");
    const trailer = parseDictAt(table, trailerAt).dict;
    if (keysOf(trailer) !== "Root,Size") problems.push("The trailer names more than the catalog.");
    if (trailer.Size !== String(count)) problems.push("The trailer's size is wrong.");
    const rootNum = ref(trailer.Root);

    // Every object, in file order. Nothing may sit between them.
    const order = entries.map((offset, i) => ({ num: i + 1, offset })).sort((a, b) => a.offset - b.offset);
    let cursor = 15; // "%PDF-1.4\n" and its 6-byte binary comment
    if (bytes[9] !== 0x25 || bytes[14] !== 0x0a) problems.push("The file's header is unexpected.");
    const objects = new Map();
    for (const { num: n, offset } of order) {
      if (offset !== cursor) return fail("There are bytes in the file that aren't part of an object.");
      const probe = latin1(bytes, offset, Math.min(bytes.length, offset + 24000));
      const open = new RegExp(`^${n} 0 obj\\n`).exec(probe);
      if (!open) return fail("An object isn't where the table says.");
      const { dict, end } = parseDictAt(probe, open[0].length);
      let at = offset + end;
      let stream = null;
      const after = latin1(bytes, at, Math.min(bytes.length, at + 12));
      if (after.startsWith("\nstream\n")) {
        const length = Number(dict.Length);
        if (!Number.isInteger(length) || length < 0) return fail("A stream has no length.");
        const from = at + 8;
        stream = { from, to: from + length };
        at = from + length;
        if (latin1(bytes, at, at + 18) !== "\nendstream\nendobj\n") return fail("A stream doesn't end where it should.");
        at += 18;
      } else if (after.startsWith("\nendobj\n")) at += 8;
      else return fail("An object doesn't end where it should.");
      objects.set(n, { dict, stream });
      cursor = at;
    }
    if (cursor !== xrefAt) return fail("There are bytes in the file that aren't part of an object.");
    // The file is exactly: header, objects, table, trailer.
    const lastEof = bytes.length;
    const eofAt = table.lastIndexOf("%%EOF\n") + xrefAt + 6;
    if (eofAt !== lastEof) return fail("There are bytes after the end of the file.");

    // What each object is.
    const catalog = objects.get(Number(rootNum));
    if (!catalog || keysOf(catalog.dict) !== CATALOG || catalog.dict.Type !== "/Catalog") return fail("The catalog holds more than the page tree.");
    const treeNum = Number(ref(catalog.dict.Pages));
    const tree = objects.get(treeNum);
    if (!tree || keysOf(tree.dict) !== PAGES || tree.dict.Type !== "/Pages") return fail("The page tree holds more than pages.");
    const kids = tree.dict.Kids;
    if (!Array.isArray(kids) || !kids.length || Number(tree.dict.Count) !== kids.length) return fail("The page count is wrong.");
    const seen = new Set([Number(rootNum), treeNum]);
    for (const kid of kids) {
      const pn = Number(ref(kid));
      const page = objects.get(pn);
      if (!page || keysOf(page.dict) !== PAGE || page.dict.Type !== "/Page") {
        problems.push("A page holds more than its picture.");
        continue;
      }
      seen.add(pn);
      if (ref(page.dict.Parent) !== String(treeNum)) problems.push("A page isn't in the page tree.");
      const box = page.dict.MediaBox;
      if (!Array.isArray(box) || box.length !== 4 || !box.every(num) || Number(box[0]) !== 0 || Number(box[1]) !== 0 || !(Number(box[2]) > 0 && Number(box[3]) > 0))
        problems.push("A page's size is wrong.");
      // Resources: exactly one XObject, /Im0.
      const res = page.dict.Resources;
      const xo = res && !Array.isArray(res) && typeof res === "object" && keysOf(res) === "XObject" ? res.XObject : null;
      if (!xo || typeof xo !== "object" || Array.isArray(xo) || keysOf(xo) !== "Im0") {
        problems.push("A page's resources hold more than one picture.");
        continue;
      }
      const im = objects.get(Number(ref(xo.Im0)));
      const content = objects.get(Number(ref(page.dict.Contents)));
      if (!im?.stream || !content?.stream) {
        problems.push("A page is missing its picture or its content.");
        continue;
      }
      seen.add(Number(ref(xo.Im0)));
      seen.add(Number(ref(page.dict.Contents)));
      // The picture: only image keys, a picture filter, no mask or alpha
      // stream, no metadata.
      if (Object.keys(im.dict).some((k) => !IMAGE_KEYS.has(k)) || im.dict.Subtype !== "/Image" || im.dict.Type !== "/XObject")
        problems.push("A picture carries more than pixels.");
      if (!["/DCTDecode", "/FlateDecode"].includes(im.dict.Filter)) problems.push("A picture isn't a plain image.");
      if (!["/DeviceRGB", "/DeviceGray"].includes(im.dict.ColorSpace)) problems.push("A picture isn't plain colour.");
      // The content: place one picture, nothing else.
      if (keysOf(content.dict) !== "Length") problems.push("A page's content holds more than its length.");
      const text = latin1(bytes, content.stream.from, content.stream.to);
      const ok = /^q -?\d+(\.\d+)? 0 0 -?\d+(\.\d+)? 0 0 cm \/Im0 Do Q\n$/.test(text);
      if (!ok) problems.push("A page's content does more than place its picture.");
    }
    for (const n of objects.keys()) if (!seen.has(n)) problems.push("The file has an object no page uses.");
    return { ok: problems.length === 0, pages: kids.length, problems };
  } catch {
    return fail("The file couldn't be read back.");
  }
}
