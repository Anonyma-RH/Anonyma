// Chat Import (update "chatimport"): reads the official ChatGPT and Claude
// data exports and turns each conversation into plain, ordinary messages.
// Pure and DOM-free, so the browser's worker, the page, the tests and the
// server's own checks (server/routes/chat-import.js) all run the same code.
//
// What an export looks like (public shapes, both are conversations.json):
//
// - ChatGPT: an array of conversations. Each has `title`, `create_time` and
//   `update_time` (seconds), `current_node` and a `mapping` tree of nodes
//   { id, parent, children, message }. A conversation the user edited or
//   regenerated has several branches; the one on screen is the path from
//   `current_node` back up through `parent`. A message has
//   author.role (system, user, assistant, tool), recipient ("all" for the
//   person, else a tool), create_time, metadata and
//   content { content_type, parts | text }. Newer exports split the file
//   into conversations-000.json, conversations-001.json and so on.
// - Claude: an array of conversations { uuid, name, created_at,
//   updated_at, chat_messages }. A message has sender ("human" or
//   "assistant"), created_at, `text` and, in newer exports, `content`
//   blocks ({ type: "text" | "thinking" | "tool_use" | ... }), plus
//   `attachments` and `files`.
//
// What is imported is the words: the text the person and the assistant
// wrote, in order, on the branch that was on screen. Attachments, images,
// generated files, tool steps, hidden reasoning and system prompts are not
// imported; they are counted so the page can say so.
import { findSeedPhrase, findPrivateKey } from "./seed-guard.js";

export const IMPORT_SOURCES = ["chatgpt", "claude"];
export const SOURCE_NAMES = { chatgpt: "ChatGPT", claude: "Claude" };
export const sourceName = (source) => SOURCE_NAMES[source] || "another service";

// The file chosen (a ZIP or a conversations JSON), and how much of it may
// be read once unpacked (a guard against a ZIP that expands enormously).
export const MAX_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_FILE_LABEL = "200 MB";
export const MAX_ENTRY_BYTES = 300 * 1024 * 1024;
export const MAX_UNZIPPED_BYTES = 600 * 1024 * 1024;
export const MAX_ZIP_ENTRIES = 200000;
// More chats than this in one export is refused: the list would be too
// long to work with (the largest real exports hold a few thousand).
export const MAX_CHATS_IN_EXPORT = 50000;

// What one saved (account) import request may carry. The browser sends
// chats in batches that stay under these; the server refuses the rest.
export const MAX_CHATS_PER_REQUEST = 20;
export const MAX_MESSAGES_PER_CHAT = 4000;
export const MAX_MESSAGE_CHARS = 200000;
export const MAX_CHAT_CHARS = 2000000;
export const MAX_REQUEST_CHARS = 4000000;
export const MAX_TITLE = 70;
// A title is read up to this long (so Seed Guard sees all of it) and kept at
// MAX_TITLE when it is saved to the account.
export const MAX_TITLE_READ = 200;
export const MAX_SOURCE_ID = 100;

const ROLES = ["user", "assistant"];
const DAY = 86400000;

// ---- Small helpers ---------------------------------------------------------

// Epoch milliseconds from ChatGPT's seconds (a float), a millisecond count
// or an ISO date. 0 when there is no usable time.
export function toMillis(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0)
    return Math.round(value < 1e11 ? value * 1000 : value);
  if (typeof value === "string" && value.trim()) {
    const n = Date.parse(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }
  return 0;
}
const oneLine = (s) =>
  String(s ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
const cut = (s, n) => {
  const chars = Array.from(s);
  return chars.length > n ? chars.slice(0, n).join("").trimEnd() : s;
};
// A saved chat's title: one line, at most 70 characters.
export const cleanTitle = (value, max = MAX_TITLE) => cut(oneLine(value), max);
const clean = (text) =>
  String(text ?? "")
    .replace(/\r\n?/g, "\n")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .trim();

// ChatGPT marks its web citations and entities with private-use characters
// (U+E200 to U+E204). Entities read as their name; citations and other
// markers would be dangling references, so they go. Old-style 【4:0†source】
// references go too.
function tidyChatGPT(text) {
  return text
    .replace(/entity(\[[\s\S]*?\])/g, (_, json) => {
      try {
        const list = JSON.parse(json);
        return typeof list?.[1] === "string" ? list[1] : "";
      } catch {
        return "";
      }
    })
    .replace(/[^]*/g, "")
    .replace(/[-]/g, "")
    .replace(/【\d+:\d+†[^】]*】/g, "");
}

// Consecutive messages from the same side become one, so a chat that runs
// on (an assistant step before and after a tool call) still alternates.
function mergeRuns(messages) {
  const out = [];
  for (const m of messages) {
    const last = out.at(-1);
    if (last && last.role === m.role) last.text += "\n\n" + m.text;
    else out.push({ ...m });
  }
  return out;
}
// Times that never go backwards, so the order on the page is the order
// the words were written in.
function steady(messages, floor) {
  let at = floor;
  for (const m of messages) {
    at = Math.max(at, m.at || 0);
    m.at = at;
  }
  return messages;
}
const titleFrom = (messages) => {
  const first = messages.find((m) => m.role === "user") || messages[0];
  return cleanTitle(first?.text || "") || "Imported chat";
};

// ---- ChatGPT ---------------------------------------------------------------

// The path on screen: from current_node up to the root. Without a usable
// current_node (older exports), the newest child at every step.
function chatgptBranch(mapping, currentNode) {
  const at = (id) => (id != null && Object.hasOwn(mapping, id) ? mapping[id] : null);
  let id = at(currentNode) ? currentNode : null;
  if (id == null) {
    const ids = Object.keys(mapping);
    let cursor = ids.find((k) => {
      const parent = mapping[k]?.parent;
      return parent == null || !at(parent);
    });
    const seen = new Set();
    while (cursor != null && !seen.has(cursor)) {
      seen.add(cursor);
      id = cursor;
      const kids = (at(cursor)?.children || []).filter((k) => at(k));
      cursor = kids.length ? kids.at(-1) : null;
    }
  }
  const chain = [];
  const seen = new Set();
  while (id != null && at(id) && !seen.has(id)) {
    seen.add(id);
    chain.push(at(id));
    id = at(id).parent;
  }
  return chain.reverse();
}

// The words of one ChatGPT message, and how many attachments it held.
function chatgptContent(message) {
  const c = message?.content;
  const type = c?.content_type;
  let text = "";
  let attachments = 0;
  if (type === "text" || type === "multimodal_text") {
    const parts = Array.isArray(c.parts) ? c.parts : [];
    const words = [];
    for (const part of parts) {
      if (typeof part === "string") words.push(part);
      else if (part && typeof part === "object") {
        if (part.content_type === "audio_transcription" && typeof part.text === "string")
          words.push(part.text);
        else attachments++;
      }
    }
    text = words.join("\n");
  } else if (type === "code" && typeof c.text === "string") {
    text = "```" + (typeof c.language === "string" && c.language !== "unknown" ? c.language : "") + "\n" + c.text + "\n```";
  } else if (type === undefined && Array.isArray(c?.parts)) {
    text = c.parts.filter((p) => typeof p === "string").join("\n");
  }
  // Uploaded files are listed in metadata; an image is in the parts as well
  // as there, so the larger count is the number of things left out.
  const listed = Array.isArray(message?.metadata?.attachments) ? message.metadata.attachments.length : 0;
  attachments = Math.max(attachments, listed);
  return { text: tidyChatGPT(clean(text)), attachments };
}

export function parseChatGPT(list) {
  const chats = [];
  let empty = 0;
  for (const conv of list) {
    if (!conv || typeof conv !== "object" || !conv.mapping || typeof conv.mapping !== "object") {
      empty++;
      continue;
    }
    const messages = [];
    let attachments = 0;
    for (const node of chatgptBranch(conv.mapping, conv.current_node)) {
      const m = node?.message;
      if (!m || typeof m !== "object") continue;
      const role = m.author?.role;
      const hidden = m.metadata?.is_visually_hidden_from_conversation === true;
      // Tool steps (search, code, image generation) are not part of the
      // conversation; only what they left behind for a person to read.
      if (role === "tool") {
        if (Array.isArray(m.content?.parts))
          attachments += m.content.parts.filter((p) => p && typeof p === "object").length;
        continue;
      }
      if (hidden || !ROLES.includes(role)) continue;
      if (m.recipient != null && m.recipient !== "all") continue;
      const item = chatgptContent(m);
      attachments += item.attachments;
      if (!item.text) continue;
      messages.push({ role, text: item.text, at: toMillis(m.create_time) });
    }
    const merged = mergeRuns(messages);
    if (!merged.length) {
      empty++;
      continue;
    }
    const created = toMillis(conv.create_time) || merged.find((m) => m.at)?.at || 0;
    steady(merged, created);
    const updated = Math.max(toMillis(conv.update_time), merged.at(-1).at, created);
    chats.push({
      source: "chatgpt",
      key: cleanKey(conv.conversation_id ?? conv.id),
      title: cleanTitle(conv.title, MAX_TITLE_READ) || titleFrom(merged),
      created,
      updated,
      messages: merged,
      attachments,
    });
  }
  return { chats, empty };
}

// ---- Claude ----------------------------------------------------------------

function claudeContent(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const words = [];
  let attachments = 0;
  for (const b of blocks) {
    if (!b || typeof b !== "object") continue;
    if (b.type === "text" && typeof b.text === "string") words.push(b.text);
    else if (b.type === "image" || b.type === "document") attachments++;
  }
  let text = words.join("\n\n");
  // Older exports carry the text alone.
  if (!text.trim() && typeof message?.text === "string") text = message.text;
  for (const key of ["attachments", "files"])
    if (Array.isArray(message?.[key])) attachments += message[key].length;
  return { text: clean(text), attachments };
}

export function parseClaude(list) {
  const chats = [];
  let empty = 0;
  for (const conv of list) {
    if (!conv || typeof conv !== "object" || !Array.isArray(conv.chat_messages)) {
      empty++;
      continue;
    }
    const messages = [];
    let attachments = 0;
    for (const m of conv.chat_messages) {
      if (!m || typeof m !== "object") continue;
      const role = m.sender === "human" ? "user" : m.sender === "assistant" ? "assistant" : null;
      if (!role) continue;
      const item = claudeContent(m);
      attachments += item.attachments;
      if (!item.text) continue;
      messages.push({ role, text: item.text, at: toMillis(m.created_at) });
    }
    const merged = mergeRuns(messages);
    if (!merged.length) {
      empty++;
      continue;
    }
    const created = toMillis(conv.created_at) || merged.find((m) => m.at)?.at || 0;
    steady(merged, created);
    const updated = Math.max(toMillis(conv.updated_at), merged.at(-1).at, created);
    chats.push({
      source: "claude",
      key: cleanKey(conv.uuid ?? conv.id),
      title: cleanTitle(conv.name, MAX_TITLE_READ) || titleFrom(merged),
      created,
      updated,
      messages: merged,
      attachments,
    });
  }
  return { chats, empty };
}

// The id an export gives a conversation, kept only to notice the same chat
// imported twice. Absent or odd ids simply skip that check.
function cleanKey(value) {
  if (typeof value !== "string") return null;
  const key = value.trim();
  // eslint-disable-next-line no-control-regex
  return key && key.length <= MAX_SOURCE_ID && !/[\u0000-\u001f\u007f]/.test(key) ? key : null;
}

// Which service wrote a parsed conversations file, from its shape.
export function detectSource(list) {
  if (!Array.isArray(list)) return null;
  const sample = list.find((c) => c && typeof c === "object");
  if (!sample) return null;
  if (sample.mapping && typeof sample.mapping === "object") return "chatgpt";
  if (Array.isArray(sample.chat_messages)) return "claude";
  return null;
}
export function parseConversations(list) {
  const source = detectSource(list);
  if (!source) return null;
  return { source, ...(source === "chatgpt" ? parseChatGPT(list) : parseClaude(list)) };
}

// ---- Shape of a chat for the list, the search and the checks --------------

export const chatChars = (chat) => chat.messages.reduce((n, m) => n + m.text.length, 0);
// Why a chat can't go to the account, or null when it can.
export function accountFit(chat) {
  if (
    chat.messages.length > MAX_MESSAGES_PER_CHAT ||
    chatChars(chat) > MAX_CHAT_CHARS ||
    chat.messages.some((m) => m.text.length > MAX_MESSAGE_CHARS)
  )
    return "too_large";
  return null;
}

// Seed Guard's hard finds (a seed phrase, a WIF or extended private key) in
// a chat's title and messages. The soft 64-hex notice isn't used: bare hex
// is far more often a hash than a key, and would flag many ordinary chats.
export function seedFinding(chat) {
  const texts = [chat.title, ...chat.messages.map((m) => m.text)];
  return texts.some((t) => !!findSeedPhrase(t) || !!findPrivateKey(t));
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A case-insensitive matcher for the list's search box (title or any
// message), or null for an empty query.
export function searchMatcher(query) {
  const q = String(query ?? "").trim().slice(0, 200);
  if (!q) return null;
  const re = new RegExp(escapeRe(q), "i");
  return (chat) => re.test(chat.title) || chat.messages.some((m) => re.test(m.text));
}

// One row of the list: what the person needs to choose, without the words.
export function summarize(chat, index) {
  return {
    id: index,
    key: chat.key,
    title: chat.title,
    created: chat.created,
    updated: chat.updated,
    messages: chat.messages.length,
    chars: chatChars(chat),
    attachments: chat.attachments,
    fit: accountFit(chat),
    seed: !!chat.seed,
  };
}

// ---- Choosing ----------------------------------------------------------------

// Why a chat can't be chosen for the destination picked right now, or null:
// "known" (already imported there), and for the account only "big" (over
// its limits) and "seed" (Seed Guard holds it back unless it was allowed).
// `known` is a Set of export ids already imported to that destination.
export function chatProblem(chat, { dest, known = null, allow = new Set(), seedLive = false } = {}) {
  if (known && chat.key && known.has(chat.key)) return "known";
  if (dest === "account") {
    if (chat.fit) return "big";
    if (seedLive && chat.seed && !allow.has(chat.id)) return "seed";
  }
  return null;
}
// The chats that will be imported: chosen, and still allowed, oldest index
// first (the list is newest first, so this is the list's own order).
export const chosenIds = (selected, chats, context) =>
  [...selected].filter((id) => chats[id] && !chatProblem(chats[id], context)).sort((a, b) => a - b);
// "Select all" adds every chat in view that can be chosen.
export function selectAll(selected, visible, context) {
  const next = new Set(selected);
  for (const c of visible) if (!chatProblem(c, context)) next.add(c.id);
  return next;
}
// "Select none" clears what is in view (everything, when nothing is filtered).
export function selectNone(selected, visible, filtered) {
  if (!filtered) return new Set();
  const next = new Set(selected);
  for (const c of visible) next.delete(c.id);
  return next;
}
// How many chats a destination can still take (Infinity for Markdown).
export function destinationRoom(dest, { status = null, vaultCount = 0, vaultMax = 5000 } = {}) {
  if (dest === "account") return status ? status.room : 0;
  if (dest === "vault") return Math.max(0, vaultMax - vaultCount);
  return Infinity;
}

// ---- What the account route takes ------------------------------------------

// One uploaded chat, checked and cleaned; { reason } when it can't be saved
// and { chat } when it can. `at` is now, so no time is in the future.
export function checkUploadedChat(raw, at = Date.now()) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { reason: "invalid" };
  if (!Array.isArray(raw.messages)) return { reason: "invalid" };
  if (raw.messages.length > MAX_MESSAGES_PER_CHAT) return { reason: "too_large" };
  const messages = [];
  let chars = 0;
  for (const m of raw.messages) {
    if (!m || typeof m !== "object" || !ROLES.includes(m.role) || typeof m.text !== "string")
      return { reason: "invalid" };
    if (m.text.length > MAX_MESSAGE_CHARS) return { reason: "too_large" };
    const text = clean(m.text);
    if (!text) continue;
    chars += text.length;
    if (chars > MAX_CHAT_CHARS) return { reason: "too_large" };
    const when = Number.isFinite(m.created) ? Math.round(m.created) : 0;
    messages.push({ role: m.role, text, at: when > 0 && when <= at + DAY ? when : 0 });
  }
  if (!messages.length) return { reason: "empty" };
  const first = messages.find((m) => m.at)?.at || 0;
  const created = Number.isFinite(raw.created) && raw.created > 0 && raw.created <= at ? Math.round(raw.created) : first || at;
  steady(messages, created);
  for (const m of messages) m.at = Math.min(m.at, at);
  const wrote = messages.at(-1).at;
  const updated =
    Number.isFinite(raw.updated) && raw.updated > 0 && raw.updated <= at ? Math.max(Math.round(raw.updated), wrote) : wrote;
  let sourceId = null;
  if (raw.source_id != null) {
    sourceId = cleanKey(raw.source_id);
    if (!sourceId) return { reason: "invalid" };
  }
  return {
    chat: {
      title: cleanTitle(raw.title) || titleFrom(messages),
      // The whole title, for Seed Guard, before it is cut for saving.
      fullTitle: cleanTitle(raw.title, MAX_TITLE_READ),
      sourceId,
      created: Math.min(created, wrote),
      updated,
      messages,
      allowSeed: raw.allow_seed_phrase === true,
    },
  };
}
// Whether a cleaned chat holds something Seed Guard holds back.
export const uploadedSeedFinding = (chat) =>
  seedFinding({ title: chat.fullTitle || chat.title, messages: chat.messages });

// ---- Batches for the account -----------------------------------------------

// Splits chats into requests that stay under the per-request limits, in
// order. A chat that can't fit alone (over the per-chat limit) is not here:
// the list already keeps those off the account.
export function planBatches(chats) {
  const batches = [];
  let batch = [],
    chars = 0;
  for (const chat of chats) {
    const size = chatChars(chat) + 500;
    if (batch.length && (batch.length >= MAX_CHATS_PER_REQUEST || chars + size > MAX_REQUEST_CHARS)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(chat);
    chars += size;
  }
  if (batch.length) batches.push(batch);
  return batches;
}
// A chat as the route takes it: only its words and dates.
export const uploadShape = (chat, allowSeed = false) => ({
  source_id: chat.key,
  title: chat.title,
  created: chat.created,
  updated: chat.updated,
  messages: chat.messages.map((m) => ({ role: m.role, text: m.text, created: m.at })),
  ...(allowSeed ? { allow_seed_phrase: true } : {}),
});
// A chat as Device Vault keeps it.
export const vaultMessages = (chat) =>
  chat.messages.map((m) => ({ role: m.role, content: m.text, created: m.at }));
