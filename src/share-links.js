// Share a Chat: pure helpers shared by the server (routes/shares.js) and the
// browser (ShareLinks.jsx). A share link publishes a read-only snapshot of one
// saved personal conversation at an unguessable address. The snapshot is a
// copy of the messages' text as the server saved it, taken once: Veil tags
// stay tags (the server never had the real values), attachments, images and
// files become a neutral placeholder, and each reply keeps the name of the
// model that wrote it. Nothing about the account goes with it: no username,
// email, wallet, balance, cost, receipt or request id.
import { parseDocumentBlocks } from "./documents.js";

// Link lifetimes on offer, in days; null keeps it until you revoke it (or the
// conversation goes). Seven days unless you choose otherwise.
export const SHARE_EXPIRY_DAYS = [1, 7, 30, null];
export const DEFAULT_SHARE_DAYS = 7;
export const MAX_ACTIVE_SHARES = 100;
export const MAX_SHARES_PER_CONVERSATION = 5;
// A snapshot is refused rather than cut short, so it never misleads.
export const MAX_SHARE_MESSAGES = 400;
export const MAX_SHARE_CHARS = 2_000_000;
export const MAX_SHARE_TITLE = 70;
// Symposium runs (several conversations per question, and saved
// double-checks) aren't shareable in this version.
export const SHAREABLE_MODES = ["chat", "code", "uncensored"];
// 24 random bytes as base64url: 32 characters, 192 bits of randomness.
export const SHARE_TOKEN_BYTES = 24;
export const SHARE_TOKEN = /^[A-Za-z0-9_-]{32}$/;
export const sharePath = (token) => "/s/" + token;
const DAY = 86400000;
const MAX_CITATIONS = 20;
// A Veil tag as the server stores it, e.g. [EMAIL_1].
export const VEIL_TAG = /\[[A-Z]+_\d+\]/g;

// Why a chat can't be shared, or null when it can. The server refuses the
// same cases (routes/shares.js); this only lets the UI say why up front.
export function shareBlocked({ saved, ephemeral, privateMode, collab, mode }) {
  if (privateMode) return "private";
  if (ephemeral) return "off_record";
  if (collab) return "collab";
  if (!SHAREABLE_MODES.includes(mode || "chat")) return "mode";
  if (!saved) return "unsaved";
  return null;
}
export const SHARE_BLOCK_MESSAGES = {
  private: "Private Mode chats are never saved, so there's nothing to share.",
  off_record:
    "Off-the-record chats are never saved, so there's nothing to share.",
  collab:
    "Collab conversations include other members' messages, so they can't be shared by link yet.",
  mode: "Only chat, code and uncensored conversations can be shared.",
  unsaved: "Send a message first: only saved conversations can be shared.",
};

// When a new link expires: the chosen lifetime, but never later than the
// conversation's own auto-delete. `bounded` says the conversation's
// deadline is the one that applies.
export function shareExpiry(days, at, conversationExpires) {
  const chosen = days == null ? null : at + days * DAY;
  if (conversationExpires == null) return { expires: chosen, bounded: false };
  if (chosen == null || conversationExpires < chosen)
    return { expires: conversationExpires, bounded: true };
  return { expires: chosen, bounded: false };
}

// The expiry field of a create request: absent means the default, null means
// never, otherwise one of the offered day counts. Anything else is invalid.
export function parseShareDays(value) {
  if (value === undefined) return { ok: true, days: DEFAULT_SHARE_DAYS };
  if (SHARE_EXPIRY_DAYS.includes(value)) return { ok: true, days: value };
  return { ok: false };
}

// A title for the shared page: one line, trimmed, at most 70 characters.
export function shareTitle(value, fallback) {
  const clean = (s) =>
    String(s ?? "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_SHARE_TITLE)
      .trim();
  return clean(value) || clean(fallback) || "Shared conversation";
}

// Source links a reply cited, when they're plain web addresses.
function citationsOf(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    const raw = typeof c?.url === "string" ? c.url.trim() : "";
    if (!raw || raw.length > 2000) continue;
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    const title =
      typeof c.title === "string" ? c.title.replace(/\s+/g, " ").trim().slice(0, 200) : "";
    out.push(title ? { url: url.href, title } : { url: url.href });
    if (out.length >= MAX_CITATIONS) break;
  }
  return out;
}

// One saved message row ({ role, content (JSON), model }) as it appears in a
// snapshot: { role, text, withheld?, model?, interrupted?, citations? }, or
// null for a row with nothing to show. `modelName` maps a model id to the
// name shown under a reply.
export function snapshotMessage(row, modelName = (id) => id) {
  if (row?.role !== "user" && row?.role !== "assistant") return null;
  let content;
  try {
    content = JSON.parse(row.content);
  } catch {
    content = typeof row.content === "string" ? row.content : "";
  }
  let text = "",
    withheld = 0;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    const parts = [];
    for (const p of content)
      if (p?.type === "text" && typeof p.text === "string") parts.push(p.text);
      else withheld++;
    text = parts.join("\n");
  } else if (content && typeof content === "object") {
    text = typeof content.text === "string" ? content.text : "";
    if (Array.isArray(content.images)) withheld += content.images.length;
  }
  // Documents travel inside a user message as <document> blocks after the
  // typed prompt: each becomes a placeholder, its text is never published.
  if (row.role === "user") {
    const parsed = parseDocumentBlocks(text);
    if (parsed.documents.length) {
      text = parsed.text;
      withheld += parsed.documents.length;
    }
  }
  text = text.trim();
  if (!text && !withheld) return null;
  const message = { role: row.role, text };
  if (withheld) message.withheld = withheld;
  if (row.role === "assistant") {
    if (row.model) message.model = String(modelName(row.model) || row.model);
    if (content?.interrupted === true) message.interrupted = true;
    const citations = citationsOf(content?.citations);
    if (citations.length) message.citations = citations;
  }
  return message;
}

export function buildSnapshot(rows, modelName) {
  return rows.map((row) => snapshotMessage(row, modelName)).filter(Boolean);
}

// The names of documents attached to the saved user messages. A chat that
// began with only a document is titled after it, and an attachment's name
// is never published, so such a title is replaced (see shareTitle's use in
// routes/shares.js).
export function attachmentNames(rows) {
  const names = new Set();
  for (const row of rows) {
    if (row?.role !== "user") continue;
    let content;
    try {
      content = JSON.parse(row.content);
    } catch {
      continue;
    }
    const texts =
      typeof content === "string"
        ? [content]
        : Array.isArray(content)
          ? content.filter((p) => p?.type === "text").map((p) => String(p.text))
          : [];
    for (const text of texts)
      for (const d of parseDocumentBlocks(text).documents)
        names.add(d.name.replace(/\s+/g, " ").trim());
  }
  return names;
}

// What the create dialog reports back: how many placeholders and Veil tags
// the snapshot holds.
export function snapshotSummary(messages) {
  let withheld = 0,
    masked = 0;
  for (const m of messages) {
    withheld += m.withheld || 0;
    masked += (m.text.match(VEIL_TAG) || []).length;
  }
  return { messages: messages.length, withheld, masked };
}
