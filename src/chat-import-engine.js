// Chat Import's reader: unzips an export, parses its conversations and holds
// them for the page (see src/chat-import.js for the formats). It runs in a
// worker (src/chat-import.worker.js) so a large export never freezes the
// tab, and never makes a network request: the words stay in this browser
// until the person chooses the account destination.
import JSZip from "jszip";
import {
  MAX_CHATS_IN_EXPORT,
  MAX_ENTRY_BYTES,
  MAX_FILE_BYTES,
  MAX_FILE_LABEL,
  MAX_UNZIPPED_BYTES,
  MAX_ZIP_ENTRIES,
  parseConversations,
  searchMatcher,
  seedFinding,
  sourceName,
  summarize,
} from "./chat-import.js";

export class ImportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}
const fail = (code, message) => new ImportError(code, message);
export const NOT_AN_EXPORT =
  "This isn't a ChatGPT or Claude export. Choose the ZIP you were sent, or the conversations.json inside it.";

// conversations.json, or a numbered piece of it (conversations-000.json),
// anywhere in the ZIP. Mac resource forks and hidden files are ignored.
const CONVERSATIONS = /^(?:.*\/)?conversations(?:-\d+)?\.json$/i;
export const isConversationsFile = (name) =>
  CONVERSATIONS.test(name) && !/(^|\/)(__MACOSX|\._)/.test(name);

const isZip = (bytes) =>
  bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05) && (bytes[3] === 0x04 || bytes[3] === 0x06);

async function bytesOf(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (input && typeof input.arrayBuffer === "function") return new Uint8Array(await input.arrayBuffer());
  throw fail("not_export", NOT_AN_EXPORT);
}
const sizeOf = (input) => input?.size ?? input?.byteLength ?? input?.length ?? 0;

// The text of a conversations file, without a byte-order mark.
function textOf(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw fail("not_export", NOT_AN_EXPORT);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}
function jsonOf(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof RangeError)
      throw fail("too_big", "This export is too large for this browser to read.");
    throw fail("not_export", NOT_AN_EXPORT);
  }
}

// Every conversations file in `input`, as parsed JSON, one at a time so only
// one file's text is in memory at once. `visit(list, name)` is called for each.
async function eachConversationsFile(input, visit, progress) {
  const size = sizeOf(input);
  if (size > MAX_FILE_BYTES)
    throw fail("too_big", `This file is over ${MAX_FILE_LABEL}. Choose a smaller export, or the conversations.json from inside it.`);
  if (!size) throw fail("not_export", NOT_AN_EXPORT);
  let bytes = await bytesOf(input);
  if (!isZip(bytes)) {
    progress?.("parsing");
    // Each big value is let go as soon as the next form of it exists, so a
    // large file is never held in three forms at once.
    let text = textOf(bytes);
    bytes = null;
    let list = jsonOf(text);
    text = null;
    await visit(list, "conversations.json");
    return;
  }
  progress?.("unzipping");
  let zip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw fail("bad_zip", "This ZIP couldn't be opened. It may be damaged; download the export again.");
  }
  const entries = Object.values(zip.files).filter((f) => !f.dir);
  if (entries.length > MAX_ZIP_ENTRIES) throw fail("too_big", "This ZIP holds too many files.");
  const wanted = entries
    .filter((f) => isConversationsFile(f.name))
    .sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  if (!wanted.length)
    throw fail("no_conversations", "There's no conversations.json in this ZIP. Choose the export ZIP you were sent by ChatGPT or Claude.");
  // The size the ZIP itself declares, checked before anything is unpacked.
  let declared = 0;
  for (const f of wanted) {
    const n = f._data?.uncompressedSize;
    if (Number.isFinite(n)) {
      if (n > MAX_ENTRY_BYTES) throw fail("too_big", "The conversations in this export are too large to read here.");
      declared += n;
    }
  }
  if (declared > MAX_UNZIPPED_BYTES) throw fail("too_big", "The conversations in this export are too large to read here.");
  let unpacked = 0;
  for (const f of wanted) {
    progress?.("parsing");
    let data = await f.async("uint8array");
    unpacked += data.length;
    if (data.length > MAX_ENTRY_BYTES || unpacked > MAX_UNZIPPED_BYTES)
      throw fail("too_big", "The conversations in this export are too large to read here.");
    let text = textOf(data);
    data = null;
    let list = jsonOf(text);
    text = null;
    await visit(list, f.name);
  }
}

// Reads an export. `input` is a File or Blob (or bytes). `seedGuard` scans
// every chat for a seed phrase or key while reading (only when Seed Guard is
// live), so the list can say which are held back for the account.
export async function loadExport(input, { seedGuard = false, onProgress } = {}) {
  const progress = (phase, detail) => onProgress?.({ phase, ...detail });
  progress("reading");
  const chats = [];
  let source = null,
    empty = 0;
  await eachConversationsFile(
    input,
    async (list, name) => {
      if (!Array.isArray(list)) throw fail("not_export", NOT_AN_EXPORT);
      if (!list.length) return;
      const parsed = parseConversations(list);
      if (!parsed) throw fail("not_export", NOT_AN_EXPORT);
      if (source && parsed.source !== source)
        throw fail("mixed", "These files come from different services. Import one export at a time.");
      source = parsed.source;
      empty += parsed.empty;
      for (const chat of parsed.chats) chats.push(chat);
      if (chats.length > MAX_CHATS_IN_EXPORT)
        throw fail("too_big", "This export holds too many chats to list. Try an export from a shorter period.");
      progress("parsed", { chats: chats.length, file: name });
    },
    progress,
  );
  if (!source) throw fail("no_chats", "There are no chats in this file.");
  if (!chats.length)
    throw fail("no_chats", `No ${sourceName(source)} chats with text were found in this file.`);
  chats.sort((a, b) => b.updated - a.updated);
  if (seedGuard) {
    for (let i = 0; i < chats.length; i++) {
      chats[i].seed = seedFinding(chats[i]);
      if (i % 25 === 0) progress("checking", { done: i, total: chats.length });
    }
  }
  return new ImportSession(source, chats, empty);
}

// The parsed chats, held in the worker. The page asks for the list, for a
// search, and for the words of only the chats it needs.
export class ImportSession {
  constructor(source, chats, empty = 0) {
    this.source = source;
    this.chats = chats;
    this.empty = empty;
  }
  overview() {
    let messages = 0,
      attachments = 0;
    for (const c of this.chats) {
      messages += c.messages.length;
      attachments += c.attachments;
    }
    return {
      source: this.source,
      empty: this.empty,
      messages,
      attachments,
      chats: this.chats.map(summarize),
    };
  }
  // Indexes of chats whose title or messages contain the query.
  search(query) {
    const match = searchMatcher(query);
    if (!match) return this.chats.map((_, i) => i);
    const found = [];
    for (let i = 0; i < this.chats.length; i++) if (match(this.chats[i])) found.push(i);
    return found;
  }
  // The full chats at these indexes (out of range ones are left out).
  get(ids) {
    return ids
      .filter((i) => Number.isInteger(i) && i >= 0 && i < this.chats.length)
      .map((i) => ({ ...this.chats[i], id: i }));
  }
}
