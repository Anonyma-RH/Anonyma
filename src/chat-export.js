// Chat Export (update "chatexport"): download one conversation as Markdown,
// JSON or a clean page to print (the browser's Print → Save as PDF). The file
// is built here, in the browser, from what this account can already open:
//
// - A saved conversation is read back with GET /api/conversations/:id, the
//   same request and access check as opening it. Collab members get what
//   they can read right now; a removed member or anyone else gets a 404.
// - A chat that was never saved (off the record, Private Mode, device-only,
//   or not saved yet) has nothing on the server to read, so only what is on
//   screen in this session is exported, and nothing is fetched.
//
// Nothing goes back to the server. Veil tags stay tags ([EMAIL_1]), exactly
// as the server stored them, unless the person asks to restore them from the
// tag map this browser keeps for the chat (src/veil.js); that happens only in
// the file. Documents and images are named placeholders: their contents are
// never re-exported. A reply's saved reasoning isn't included either.
//
// The JSON format (CHAT_EXPORT_SCHEMA below is its JSON Schema), version 1:
//
// {
//   "format": "anonyma.chat-export",
//   "version": 1,
//   "exported_at": "2026-09-25T20:00:00.000Z",
//   "local_test": true,                       // only from a local test service
//   "conversation": {
//     "id": "c_…" | null,                     // null when it was never saved
//     "title": "…",
//     "mode": "chat" | "code" | "uncensored" | "symposium",
//     "saved": true,                          // false: exported from the screen
//     "collab": { "name": "…" } | null,       // a shared (collab) conversation
//     "started_at": "…" | null,               // first and last message times
//     "last_message_at": "…" | null
//   },
//   "options": { "receipts": false, "citations": true, "veil_restored": false },
//   "summary": { "messages": 12, "attachments": 1, "masked_details": 2 },
//   "messages": [
//     { "role": "user", "you": true, "author": null, "created_at": "…" | null,
//       "text": "…", "attachments": [{ "type": "document", "name": "a.pdf", "included": false }] },
//     { "role": "assistant", "model": "Claude Opus 5.5", "model_id": "claude-opus-5.5",
//       "created_at": "…" | null, "text": "…", "interrupted": false,
//       "attachments": [{ "type": "image", "included": false }],
//       "citations": [{ "url": "https://…", "title": "…" }],   // only with options.citations
//       "receipt": { "credits_charged": 0.0123, "id": "…", "signed": true } | null }  // only with options.receipts
//   ]
// }
//
// "author" is the member's username as the chat shows it, for another
// member's message in a collab; your own messages have "you": true and no
// author. A receipt is only ever your own: other members' charges are never
// sent to you, so their replies have "receipt": null.
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { parseDocumentBlocks } from "./documents.js";
import { unveil } from "./veil.js";

export const CHAT_EXPORT_FORMAT = "anonyma.chat-export";
export const CHAT_EXPORT_VERSION = 1;
export const EXPORT_FORMATS = ["markdown", "json", "print"];
export const EXPORT_TYPES = {
  markdown: { extension: "md", type: "text/markdown;charset=utf-8" },
  json: { extension: "json", type: "application/json;charset=utf-8" },
};
const MAX_CITATIONS = 50;
const VEIL_TAG = /\[([A-Z]+_\d+)\]/g;

// ---- Where the messages come from ------------------------------------

// A saved conversation is read back from the server; anything else can only
// be exported as it is on screen. `reason` says why a chat wasn't saved.
export function exportPlan({
  id = null,
  ephemeral = false,
  privateMode = false,
  deviceOnly = false,
} = {}) {
  if (deviceOnly) return { source: "screen", reason: "device" };
  if (privateMode) return { source: "screen", reason: "private" };
  if (ephemeral) return { source: "screen", reason: "off_record" };
  if (!id) return { source: "screen", reason: "unsaved" };
  return { source: "server", reason: null };
}
export const SCREEN_NOTES = {
  device:
    "Device-only chat: it's kept only in this browser, so the download holds what's on screen now.",
  private:
    "Private Mode: nothing was saved, so the download holds only what's on screen now.",
  off_record:
    "Off the record: nothing was saved, so the download holds only what's on screen now.",
  unsaved:
    "This chat isn't saved yet, so the download holds what's on screen now.",
};

// ---- Messages ----------------------------------------------------------

const iso = (ms) =>
  Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;

// Source links a reply cited, when they are plain web addresses.
export function cleanCitations(list) {
  if (!Array.isArray(list)) return [];
  const out = [],
    seen = new Set();
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
    if (seen.has(url.href)) continue;
    seen.add(url.href);
    const title =
      typeof c.title === "string"
        ? c.title.replace(/\s+/g, " ").trim().slice(0, 300)
        : "";
    out.push(title ? { url: url.href, title } : { url: url.href });
    if (out.length >= MAX_CITATIONS) break;
  }
  return out;
}

// One chat message, as the workspace holds it (messageFromServer in
// src/lib.js, or a message still on screen), as an export entry, or null
// when there's nothing to show. `userId`/`username` identify "you".
export function exportMessage(
  m,
  { userId = null, username = null, modelName = (id) => id } = {},
) {
  if (!m || m.sample || (m.role !== "user" && m.role !== "assistant"))
    return null;
  const raw = typeof m.content === "string" ? m.content : "";
  const attachments = [];
  let text = raw;
  if (m.role === "user") {
    // Documents ride inside the saved prompt as <document> blocks: each one
    // becomes a named placeholder and its text stays out of the file.
    const parsed = parseDocumentBlocks(raw);
    if (parsed.documents.length) {
      text = parsed.text;
      for (const d of parsed.documents)
        attachments.push({
          type: "document",
          name:
            String(d.name || "document")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 200) || "document",
          included: false,
        });
    }
  }
  const images = Array.isArray(m.images) ? m.images.length : 0;
  for (let i = 0; i < images; i++)
    attachments.push({ type: "image", included: false });
  const interrupted = m.role === "assistant" && m.interrupted === true;
  if (!text.trim() && !attachments.length && !interrupted) return null;
  const created_at = iso(m.created);
  if (m.role === "user") {
    // Yours: the message's author is this account (or, on screen or in an
    // older personal chat, there's no author at all).
    const you = m.author_id
      ? m.author_id === userId
      : !m.author || m.author === username;
    return {
      role: "user",
      you,
      author: you ? null : m.author ? String(m.author) : null,
      created_at,
      text,
      attachments,
    };
  }
  const entry = {
    role: "assistant",
    model: m.model ? String(modelName(m.model) || m.model) : null,
    model_id: m.model ? String(m.model) : null,
    created_at,
    text,
    interrupted,
    attachments,
    citations: cleanCitations(m.citations),
    receipt: null,
  };
  // Only your own replies carry a charge: the server leaves other members'
  // charges out (credits: null), and a reply still on screen has one once
  // its final event arrived.
  if (m.credits != null && Number.isFinite(Number(m.credits))) {
    const copied = !!m.origin_id;
    entry.receipt = {
      // A branch copies earlier replies without charging them again.
      credits_charged: copied ? 0 : Number(m.credits),
      id: typeof m.requestId === "string" && m.requestId ? m.requestId : null,
      signed:
        typeof m.privacy?.receipt_id === "string" && !!m.privacy.receipt_id,
      ...(copied ? { branch_copy: true } : {}),
    };
  }
  return entry;
}

// Distinct Veil tags in a list of strings.
function tagsIn(texts) {
  const found = new Set();
  for (const t of texts)
    for (const match of String(t || "").matchAll(VEIL_TAG)) found.add(match[1]);
  return found;
}
const entryTexts = (title, entries) => [
  title,
  ...entries.flatMap((e) => [
    e.text,
    ...e.attachments.map((a) => a.name || ""),
  ]),
];

// How many of the chat's masked details this browser can restore: tags that
// appear in what would be exported and that the Veil map holds.
export function restorableCount(
  { title = "", messages = [] },
  map,
  context = {},
) {
  if (!map || typeof map !== "object") return 0;
  const entries = messages
    .map((m) => exportMessage(m, context))
    .filter(Boolean);
  let n = 0;
  for (const tag of tagsIn(entryTexts(title, entries)))
    if (Object.prototype.hasOwnProperty.call(map, tag)) n++;
  return n;
}

// The export itself (the JSON document; Markdown and the print page are
// rendered from it). `restore` is the Veil map, or null to keep tags.
export function buildChatExport({
  conversation = {},
  messages = [],
  userId = null,
  username = null,
  modelName = (id) => id,
  receipts = false,
  citations = true,
  restore = null,
  testMode = false,
  now = Date.now(),
} = {}) {
  const map =
    restore && typeof restore === "object" && Object.keys(restore).length
      ? restore
      : null;
  const fix = (s) => (map ? unveil(s, map) : s);
  const entries = messages
    .map((m) => exportMessage(m, { userId, username, modelName }))
    .filter(Boolean)
    .map((e) => {
      const out = {
        ...e,
        text: fix(e.text),
        attachments: e.attachments.map((a) =>
          a.name ? { ...a, name: fix(a.name) } : a,
        ),
      };
      if (out.role === "assistant") {
        if (!citations) delete out.citations;
        if (!receipts) delete out.receipt;
      }
      return out;
    });
  const title =
    fix(
      String(conversation.title || "")
        .replace(/\s+/g, " ")
        .trim(),
    ) || "Untitled conversation";
  const times = entries
    .map((e) => e.created_at)
    .filter(Boolean)
    .sort();
  const collab =
    conversation.collab && typeof conversation.collab === "object"
      ? { name: String(conversation.collab.name || "") }
      : null;
  return {
    format: CHAT_EXPORT_FORMAT,
    version: CHAT_EXPORT_VERSION,
    exported_at: new Date(now).toISOString(),
    ...(testMode ? { local_test: true } : {}),
    conversation: {
      id: conversation.saved === false ? null : conversation.id || null,
      title,
      mode: ["chat", "code", "uncensored", "symposium"].includes(
        conversation.mode,
      )
        ? conversation.mode
        : "chat",
      saved: conversation.saved !== false && !!conversation.id,
      collab,
      started_at: times[0] || null,
      last_message_at: times.at(-1) || null,
    },
    options: {
      receipts: !!receipts,
      citations: !!citations,
      veil_restored: !!map,
    },
    summary: {
      messages: entries.length,
      attachments: entries.reduce((n, e) => n + e.attachments.length, 0),
      masked_details: [...tagsIn(entryTexts(title, entries))].length,
    },
    messages: entries,
  };
}

export const exportJSON = (doc) => JSON.stringify(doc, null, 2) + "\n";

// ---- Filenames -----------------------------------------------------------

const pad = (n) => String(n).padStart(2, "0");
const localDate = (d) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localStamp = (value) => {
  const d = new Date(value);
  return `${localDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// anonyma-<title>-<date>.<ext>: letters, marks and digits from any script,
// everything else (slashes, dots, quotes, control and direction characters,
// Veil tags) folded to single hyphens, at most 60 characters of title. The
// fixed prefix keeps reserved device names (CON, NUL…) and hidden or
// relative names out. The title is the saved one: restored Veil values
// never reach a filename.
export function exportFilename(title, extension, at = Date.now()) {
  const ext = ["md", "json", "pdf"].includes(extension) ? extension : "txt";
  const slug = Array.from(
    String(title ?? "")
      .normalize("NFKC")
      .replace(VEIL_TAG, " ")
      .toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, ""),
  )
    .slice(0, 60)
    .join("")
    .replace(/-+$/, "");
  return `anonyma-${slug || "chat"}-${localDate(new Date(at))}.${ext}`;
}

// ---- Markdown ------------------------------------------------------------

// The same parse the chat uses to show a message (react-markdown with GFM),
// stopped as soon as the syntax tree exists.
class Parsed extends Error {}
export function parseMarkdown(text) {
  let tree = null;
  const stop = new Parsed("parsed");
  const capture = () => (t) => {
    tree = t;
    throw stop;
  };
  try {
    Markdown({ children: text, remarkPlugins: [remarkGfm, capture] });
  } catch (e) {
    if (e !== stop) throw e;
  }
  return tree;
}

// Backslash-escapes Markdown punctuation so text we insert (a title, a
// model or member name, a document name, a source's title) is shown as
// written and can't form links, headings, emphasis or HTML.
export const escapeInline = (s) =>
  String(s ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>#!|~&{}()]/g, "\\$&");
// Every ASCII punctuation character, for raw HTML shown as text.
const escapeAll = (s) => s.replace(/[!-/:-@[-`{-~]/g, "\\$&");

// A message's own Markdown, made safe to put in a file without changing how
// it reads in the chat:
// - Raw HTML is shown in the chat as plain text, never run. In the file it
//   is backslash-escaped, so a Markdown viewer shows it as text too.
// - Links and images the chat wouldn't follow (javascript:, data: and the
//   like, see react-markdown's defaultUrlTransform) keep only their text.
// - A code block left open (a reply cut off mid-code) is closed, so it
//   can't swallow the rest of the file.
export function safeMarkdown(text) {
  const src = String(text ?? "");
  if (!src.trim()) return "";
  const tree = parseMarkdown(src);
  const edits = [];
  const at = (node) =>
    node?.position && Number.isInteger(node.position.start.offset)
      ? [node.position.start.offset, node.position.end.offset]
      : null;
  const unsafe = (url) =>
    typeof url === "string" && defaultUrlTransform(url) === "" && url !== "";
  const badDefinitions = new Set();
  (function scan(node) {
    if (node.type === "definition" && unsafe(node.url))
      badDefinitions.add(node.identifier);
    for (const child of node.children || []) scan(child);
  })(tree);
  const unwrap = (node) => {
    const range = at(node),
      kids = (node.children || []).filter(at);
    if (!range) return;
    if (!kids.length) return edits.push([range[0], range[1], ""]);
    edits.push([range[0], at(kids[0])[0], ""]);
    edits.push([at(kids.at(-1))[1], range[1], ""]);
  };
  (function walk(node) {
    const range = at(node);
    if (node.type === "html" && range) {
      // Continuation lines lose their indentation (the chat collapses it
      // anyway), so escaped HTML can't turn into an indented code block.
      const raw = src.slice(range[0], range[1]).replace(/\n[ \t]+/g, "\n");
      edits.push([range[0], range[1], escapeAll(raw)]);
      return;
    }
    if (
      node.type === "definition" &&
      badDefinitions.has(node.identifier) &&
      range
    ) {
      edits.push([range[0], range[1], ""]);
      return;
    }
    if (node.type === "image" && unsafe(node.url) && range) {
      edits.push([range[0], range[1], escapeInline(node.alt || "")]);
      return;
    }
    if (
      node.type === "imageReference" &&
      badDefinitions.has(node.identifier) &&
      range
    ) {
      edits.push([range[0], range[1], escapeInline(node.alt || "")]);
      return;
    }
    if (
      (node.type === "link" && unsafe(node.url)) ||
      (node.type === "linkReference" && badDefinitions.has(node.identifier))
    )
      unwrap(node);
    for (const child of node.children || []) walk(child);
  })(tree);
  let out = src;
  for (const [start, end, value] of edits.sort((a, b) => b[0] - a[0]))
    out = out.slice(0, start) + value + out.slice(end);
  // An unclosed fence at the top level runs to the end of the message.
  const last = (tree.children || []).at(-1);
  if (last?.type === "code" && at(last)) {
    const block = src.slice(...at(last)).split("\n");
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(block[0]);
    if (open) {
      const fence = open[1];
      const close = new RegExp(
        `^ {0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}[ \\t]*$`,
      );
      if (block.length < 2 || !close.test(block.at(-1)))
        out = out.replace(/\s*$/, "") + "\n" + fence;
    }
  }
  return out.replace(/\s+$/, "");
}

// Labels in a downloaded file follow the page's language: `label` is the
// language switch's translator for text outside the page (t in src/i18n.js).
// Labels never contain the chat's own words, so nothing a person or a model
// wrote is ever translated.
const LABELS = {
  exported: "Exported from ANONYMA",
  range: "Conversation",
  messages: "Messages",
  shared: "Shared in",
  timezone: "Times are local",
  masked: "Masked details stay masked, shown as tags like [EMAIL_1].",
  restored: "Masked details were restored in this browser for this file.",
  placeholders:
    "Attachments and images appear as placeholders; their contents aren't included.",
  test: "Local test mode: receipts show fixture credits.",
  you: "You",
  member: "Former member",
  assistant: "Assistant",
  document: "Attached document",
  documentNote: "its text isn't included in this export",
  image: "Image",
  imageNote: "not included in this export",
  interrupted: "Reply interrupted.",
  sources: "Sources",
  branchCopy: "Receipt · copied from the original conversation, charged there",
  receiptId: "Receipt ID",
  signed: "Signed",
};
// A reply's charge, one whole phrase per case so the language switch can
// translate it (numbers are the only thing filled in).
export const receiptLabel = (receipt, localTest = false) =>
  receipt.branch_copy
    ? LABELS.branchCopy
    : localTest
      ? `Test receipt · ${receipt.credits_charged} fixture credits charged`
      : `Receipt · ${receipt.credits_charged} credits charged`;
export const EXPORT_LABELS = Object.values(LABELS);

const offset = (ms) => {
  const minutes = -new Date(ms).getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const m = Math.abs(minutes);
  return `UTC${sign}${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
};

// Who a message is from, as the chat labels it.
export function speaker(entry, label = (s) => s) {
  if (entry.role === "assistant") return entry.model || label(LABELS.assistant);
  if (entry.you) return label(LABELS.you);
  return entry.author || label(LABELS.member);
}

// `note` is the SCREEN_NOTES line for a chat that was never saved.
export function exportMarkdown(
  doc,
  { label = (s) => s, time = localStamp, note = "" } = {},
) {
  const L = (key) => label(LABELS[key]);
  const c = doc.conversation;
  const lines = [`# ${escapeInline(c.title)}`, ""];
  const meta = [`- ${L("exported")}: ${time(doc.exported_at)}`];
  if (c.started_at)
    meta.push(
      `- ${L("range")}: ${time(c.started_at)}${
        c.last_message_at && c.last_message_at !== c.started_at
          ? " – " + time(c.last_message_at)
          : ""
      }`,
    );
  meta.push(`- ${L("messages")}: ${doc.summary.messages}`);
  if (c.collab) meta.push(`- ${L("shared")}: ${escapeInline(c.collab.name)}`);
  if (!c.saved && note) meta.push(`- ${escapeInline(label(note))}`);
  meta.push(`- ${L("timezone")} (${offset(Date.parse(doc.exported_at))})`);
  if (doc.options.veil_restored) meta.push(`- ${escapeInline(L("restored"))}`);
  else if (doc.summary.masked_details)
    meta.push(`- ${escapeInline(L("masked"))}`);
  if (doc.summary.attachments)
    meta.push(`- ${escapeInline(L("placeholders"))}`);
  if (doc.local_test && doc.options.receipts)
    meta.push(`- ${escapeInline(L("test"))}`);
  lines.push(...meta, "");
  for (const e of doc.messages) {
    lines.push("---", "");
    const when = e.created_at ? " · " + time(e.created_at) : "";
    lines.push(`## ${escapeInline(speaker(e, label))}${when}`, "");
    const body = safeMarkdown(e.text);
    if (body) lines.push(body, "");
    for (const a of e.attachments)
      lines.push(
        a.type === "document"
          ? `*${L("document")}: ${escapeInline(a.name)} (${L("documentNote")})*`
          : `*${L("image")} (${L("imageNote")})*`,
        "",
      );
    if (e.role !== "assistant") continue;
    if (e.interrupted) lines.push(`*${L("interrupted")}*`, "");
    if (e.citations?.length) {
      lines.push(`**${L("sources")}**`, "");
      e.citations.forEach((s, i) =>
        lines.push(
          `${i + 1}. [${escapeInline(s.title || new URL(s.url).host)}](<${s.url}>)`,
        ),
      );
      lines.push("");
    }
    if (e.receipt) {
      const r = e.receipt;
      const parts = [escapeInline(label(receiptLabel(r, doc.local_test)))];
      if (r.id) parts.push(`${L("receiptId")} ${escapeInline(r.id)}`);
      if (r.signed) parts.push(L("signed"));
      lines.push(`*${parts.join(" · ")}*`, "");
    }
  }
  return (
    lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/\s+$/, "") + "\n"
  );
}

// ---- The JSON Schema of version 1 ----------------------------------------

const nullable = (type) => ({ type: [type, "null"] });
const attachment = {
  type: "object",
  required: ["type", "included"],
  additionalProperties: false,
  properties: {
    type: { enum: ["document", "image"] },
    name: { type: "string" },
    included: { const: false },
  },
};
export const CHAT_EXPORT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "ANONYMA chat export, version 1",
  type: "object",
  required: [
    "format",
    "version",
    "exported_at",
    "conversation",
    "options",
    "summary",
    "messages",
  ],
  additionalProperties: false,
  properties: {
    format: { const: CHAT_EXPORT_FORMAT },
    version: { const: CHAT_EXPORT_VERSION },
    exported_at: { type: "string", format: "date-time" },
    local_test: { const: true },
    conversation: {
      type: "object",
      required: [
        "id",
        "title",
        "mode",
        "saved",
        "collab",
        "started_at",
        "last_message_at",
      ],
      additionalProperties: false,
      properties: {
        id: nullable("string"),
        title: { type: "string" },
        mode: { enum: ["chat", "code", "uncensored", "symposium"] },
        saved: { type: "boolean" },
        collab: {
          type: ["object", "null"],
          required: ["name"],
          additionalProperties: false,
          properties: { name: { type: "string" } },
        },
        started_at: nullable("string"),
        last_message_at: nullable("string"),
      },
    },
    options: {
      type: "object",
      required: ["receipts", "citations", "veil_restored"],
      additionalProperties: false,
      properties: {
        receipts: { type: "boolean" },
        citations: { type: "boolean" },
        veil_restored: { type: "boolean" },
      },
    },
    summary: {
      type: "object",
      required: ["messages", "attachments", "masked_details"],
      additionalProperties: false,
      properties: {
        messages: { type: "integer" },
        attachments: { type: "integer" },
        masked_details: { type: "integer" },
      },
    },
    messages: {
      type: "array",
      items: {
        oneOf: [
          {
            type: "object",
            required: [
              "role",
              "you",
              "author",
              "created_at",
              "text",
              "attachments",
            ],
            additionalProperties: false,
            properties: {
              role: { const: "user" },
              you: { type: "boolean" },
              author: nullable("string"),
              created_at: nullable("string"),
              text: { type: "string" },
              attachments: { type: "array", items: attachment },
            },
          },
          {
            type: "object",
            required: [
              "role",
              "model",
              "model_id",
              "created_at",
              "text",
              "interrupted",
              "attachments",
            ],
            additionalProperties: false,
            properties: {
              role: { const: "assistant" },
              model: nullable("string"),
              model_id: nullable("string"),
              created_at: nullable("string"),
              text: { type: "string" },
              interrupted: { type: "boolean" },
              attachments: { type: "array", items: attachment },
              citations: {
                type: "array",
                items: {
                  type: "object",
                  required: ["url"],
                  additionalProperties: false,
                  properties: {
                    url: { type: "string" },
                    title: { type: "string" },
                  },
                },
              },
              receipt: {
                type: ["object", "null"],
                required: ["credits_charged", "id", "signed"],
                additionalProperties: false,
                properties: {
                  credits_charged: { type: "number" },
                  id: nullable("string"),
                  signed: { type: "boolean" },
                  branch_copy: { const: true },
                },
              },
            },
          },
        ],
      },
    },
  },
};
