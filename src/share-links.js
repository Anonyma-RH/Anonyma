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
// `sealed` says Sealed Share is live: a Device-only chat can then be shared,
// but only sealed (the server never had it, and never gets it readable), and
// never one that ran in Private Mode, which promises nothing is stored on our
// servers. For a Device-only chat `saved` means Device Vault has saved it.
export function shareBlocked({ saved, ephemeral, privateMode, deviceOnly, collab, mode, sealed = false }) {
  if (deviceOnly) {
    if (!sealed) return "device";
    if (privateMode) return "device_private";
    if (!SHAREABLE_MODES.includes(mode || "chat")) return "mode";
    if (!saved) return "unsaved";
    return null;
  }
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
  device:
    "Device-only chats are kept only in this browser, so they can't be shared by link.",
  device_private:
    "Private Mode chats are never stored on our servers, so they can't be shared by link, even from Device Vault.",
  device_unsealed: "A Device-only chat can only be shared as a sealed link.",
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
// The title a snapshot is published under: the one asked for, else the
// conversation's. Never an attachment's name (a chat that began with only a
// document is titled after it), since attachments aren't published.
export function publishedTitle(asked, fallback, rows) {
  const chosen = shareTitle(asked, fallback);
  // A conversation title keeps only its first 70 characters.
  const named = [...attachmentNames(rows)].some(
    (n) => n === chosen || n.slice(0, MAX_SHARE_TITLE).trim() === chosen,
  );
  return named ? "Shared conversation" : chosen;
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

// ---- Sealed Share (update "sealedshare") ----
// The browser seals a snapshot with a random 256-bit AES-GCM key
// (src/sealed-share.js) and uploads only the ciphertext. The key travels in
// the link's #k= fragment, which browsers never send to a server, so the
// server stores and serves bytes it can't read. The same snapshot rules
// apply: Veil tags stay tags, attachments become placeholders.
export const SEALED_KEY_BYTES = 32;
export const SEALED_IV_BYTES = 12;
export const SEALED_TAG_BYTES = 16;
// A key as it appears in a link: 32 bytes as base64url, 43 characters.
export const SEALED_KEY = /^[A-Za-z0-9_-]{43}$/;
// The most one sealed link may hold (IV, ciphertext and tag), and the most
// an account's live sealed links may hold together.
export const MAX_SEALED_BYTES = 3 * 1024 * 1024;
export const MAX_SEALED_TOTAL_BYTES = 32 * 1024 * 1024;
export const SEALED_FORMAT = "anonyma-sealed-share";
export const SEALED_VERSION = 1;
export const sealedLink = (url, key) => url + "#k=" + key;
// The honest limits, shown wherever a sealed link is made or viewed.
export const SEALED_FACTS = {
  who: "Anyone with the full link can read it. ANONYMA can't: the key never reaches our servers.",
  lost: "Lose the link and it can't be recovered.",
  preview: "No link preview: apps you paste it into can't show what's inside.",
};

// A Device-only chat as the workspace holds it (src/Workspace.jsx): the text
// as it was sent (Veil tags, not the values), images as URLs, and each reply's
// model id. As the saved-message rows snapshotMessage reads, so both kinds of
// chat are snapshotted by the same rules. Image URLs are never copied: only
// how many there were.
export function deviceRows(messages = []) {
  const rows = [];
  for (const m of messages) {
    if (!m || m.sample) continue;
    const text = typeof m.content === "string" ? m.content : "";
    const images = Array.isArray(m.images) ? m.images.length : 0;
    if (m.role === "user")
      rows.push({
        role: "user",
        content: JSON.stringify(
          images
            ? [{ type: "text", text }, ...Array.from({ length: images }, () => ({ type: "image_url" }))]
            : text,
        ),
      });
    else if (m.role === "assistant")
      rows.push({
        role: "assistant",
        model: typeof m.model === "string" ? m.model : null,
        content: JSON.stringify({
          text,
          images: Array.from({ length: images }, () => ({})),
          citations: Array.isArray(m.citations) ? m.citations : [],
          ...(m.interrupted === true ? { interrupted: true } : {}),
        }),
      });
  }
  return rows;
}
// A Device-only chat's snapshot and title, before sealing. The fallback title
// is the first thing typed as it was sent, so Veil tags stay tags.
export function deviceSnapshot(messages, askedTitle, modelName) {
  const rows = deviceRows(messages);
  const snapshot = buildSnapshot(rows, modelName);
  const first = snapshot.find((m) => m.role === "user" && m.text);
  return {
    title: publishedTitle(askedTitle, first?.text.slice(0, 80) || "", rows),
    messages: snapshot,
  };
}
// Why a snapshot can't be shared as one link, or null.
export function snapshotProblem(messages) {
  if (!messages.length) return "share_empty";
  if (messages.length > MAX_SHARE_MESSAGES || JSON.stringify(messages).length > MAX_SHARE_CHARS)
    return "share_too_large";
  return null;
}
export const SNAPSHOT_PROBLEMS = {
  share_empty: "There's nothing to share in this conversation yet.",
  share_too_large: "This conversation is too long to share as one link.",
};

// What is sealed: the page's title and the messages, nothing else.
export const sealedPayload = ({ title, messages }) => ({
  format: SEALED_FORMAT,
  version: SEALED_VERSION,
  title: shareTitle(title),
  messages,
});
// A decrypted payload, checked field by field before anything renders: only
// what a snapshot may hold, in the shapes snapshotMessage makes. null when it
// isn't one.
export function readSealedPayload(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.format !== SEALED_FORMAT ||
    value.version !== SEALED_VERSION ||
    typeof value.title !== "string" ||
    !Array.isArray(value.messages) ||
    !value.messages.length ||
    value.messages.length > MAX_SHARE_MESSAGES
  )
    return null;
  const messages = [];
  for (const m of value.messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) return null;
    if (typeof m.text !== "string" || m.text.length > MAX_SHARE_CHARS) return null;
    const out = { role: m.role, text: m.text };
    if (m.withheld !== undefined) {
      if (!Number.isSafeInteger(m.withheld) || m.withheld < 1 || m.withheld > 10000) return null;
      out.withheld = m.withheld;
    }
    if (!out.text && !out.withheld) return null;
    if (m.role === "assistant") {
      if (m.model !== undefined) {
        if (typeof m.model !== "string" || !m.model || m.model.length > 200) return null;
        out.model = m.model;
      }
      if (m.interrupted === true) out.interrupted = true;
      const citations = citationsOf(m.citations);
      if (citations.length) out.citations = citations;
    }
    messages.push(out);
  }
  return { title: shareTitle(value.title), messages };
}
