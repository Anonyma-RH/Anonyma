import { uid, now, fail, transaction } from "../core.js";
import { capsFor } from "../holders.js";
import { isReleased } from "../releases.js";
import {
  IMPORT_SOURCES,
  MAX_CHATS_PER_REQUEST,
  MAX_CHAT_CHARS,
  MAX_MESSAGES_PER_CHAT,
  MAX_MESSAGE_CHARS,
  MAX_REQUEST_CHARS,
  checkUploadedChat,
  uploadedSeedFinding,
} from "../../src/chat-import.js";

// Chat Import: the account destination. The export itself is read in the
// browser (src/chat-import-engine.js); only the chats the person chose ever
// reach this route, each as its words, its dates and the id the export gave
// it (kept only to notice the same chat imported twice). A chat becomes an
// ordinary saved conversation: it is listed, searched, exported, shared,
// bookmarked, auto-deleted, wiped and closed with the account like any other,
// and is marked as imported. No model is called and nothing is charged.
//
// - Seed Guard (once released): a chat whose text holds a valid seed phrase
//   or a wallet private key is skipped, with its own reason, unless the
//   request says allow_seed_phrase for that chat (the page asks twice).
//   Nothing about a match is logged or kept.
// - The account's saved-chat cap (300, 600 at the Holder tier) is never
//   pruned by an import: a chat that doesn't fit is skipped, and the chats
//   already saved stay. An import never deletes a chat.
// - The account's auto-delete default applies, as it does to any new chat.
// - Nothing here logs titles, text or ids. Failures are ordinary 4xx.

// Chats brought in, by the conversation they became: their service, for
// the list, the chat's banner and the account export.
export function importedSources(db, user) {
  return new Map(
    db
      .prepare("SELECT conversation_id,source FROM chat_imports WHERE user_id=?")
      .all(user)
      .map((r) => [r.conversation_id, r.source]),
  );
}
// Rows of the conversation list with `imported_from` on the ones brought in.
export function withImported(db, user, rows) {
  const map = importedSources(db, user);
  if (!map.size) return rows;
  return rows.map((r) => (map.has(r.id) ? { ...r, imported_from: map.get(r.id) } : r));
}
export function importedExport(db, conversationId) {
  const r = db
    .prepare("SELECT source,source_id,imported FROM chat_imports WHERE conversation_id=?")
    .get(conversationId);
  return r ? { imported_from: { source: r.source, source_id: r.source_id, imported: r.imported } } : {};
}
// Account closure and Panic Wipe (eraseAccountContent in routes/account.js).
export function forgetChatImports(db, user) {
  db.prepare("DELETE FROM chat_imports WHERE user_id=?").run(user);
}

// Saved personal chats against the account's cap (Symposium runs have
// their own cap and are not counted here). Encrypted Backup's restore
// (routes/account-backup.js) fills the same room.
const PERSONAL = "user_id=? AND collab_id IS NULL AND mode IS NOT 'symposium'";
export function chatRoom(db, cfg, user) {
  const cap = capsFor(db, cfg, user).conversations;
  const have = db.prepare(`SELECT COUNT(*) n FROM conversations WHERE ${PERSONAL}`).get(user).n;
  return { cap, have, room: Math.max(0, cap - have) };
}
// The account's auto-delete default, as the expiry of a chat saved now.
export function defaultExpiry(db, user, at) {
  const days = db.prepare("SELECT days FROM retention_defaults WHERE user_id=?").get(user)?.days;
  return days ? at + days * 86400000 : null;
}
// One checked chat (checkUploadedChat) saved as an ordinary conversation:
// the chat and its words, in order, inside the caller's transaction. A
// reply keeps the model that wrote it when one is given (Encrypted
// Backup's restore); an import's replies have none. Returns the new ids.
export function insertChat(db, user, chat, expires) {
  const id = uid("c_");
  db.prepare(
    "INSERT INTO conversations(id,user_id,title,mode,created,updated,expires) VALUES(?,?,?,?,?,?,?)",
  ).run(id, user, chat.title, "chat", chat.created, chat.updated, expires);
  const add = db.prepare(
    "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
  );
  const messages = chat.messages.map((m) => {
    const mid = uid("m_");
    add.run(
      mid,
      id,
      m.role,
      JSON.stringify(m.role === "user" ? m.text : { text: m.text, finish_reason: "stop" }),
      m.role === "assistant" && typeof m.model === "string" ? m.model : null,
      0,
      m.at,
      m.role === "user" ? user : null,
    );
    return mid;
  });
  return { id, messages };
}

export function chatImportRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const read = limit("chat-import-read", 120, 60000);
  const write = limit("chat-import", 300, 3600000);
  const roomFor = (user) => chatRoom(db, cfg, user);

  app.get("/api/import/status", requireUser, read, (req, res) => {
    const imported = Object.fromEntries(IMPORT_SOURCES.map((s) => [s, []]));
    for (const r of db
      .prepare("SELECT source,source_id FROM chat_imports WHERE user_id=? AND source_id IS NOT NULL")
      .all(req.user.id))
      imported[r.source]?.push(r.source_id);
    res.json({
      ...roomFor(req.user.id),
      retention_days:
        db.prepare("SELECT days FROM retention_defaults WHERE user_id=?").get(req.user.id)?.days ?? null,
      seed_guard: isReleased(cfg, "seedguard"),
      limits: {
        chats_per_request: MAX_CHATS_PER_REQUEST,
        messages_per_chat: MAX_MESSAGES_PER_CHAT,
        message_chars: MAX_MESSAGE_CHARS,
        chat_chars: MAX_CHAT_CHARS,
        request_chars: MAX_REQUEST_CHARS,
      },
      imported,
    });
  });

  app.post("/api/import/chats", requireUser, write, (req, res) => {
    const { source, chats } = req.body ?? {};
    if (!IMPORT_SOURCES.includes(source))
      fail(400, "source must be chatgpt or claude.", "invalid_request");
    if (!Array.isArray(chats) || !chats.length || chats.length > MAX_CHATS_PER_REQUEST)
      fail(400, `Send 1 to ${MAX_CHATS_PER_REQUEST} chats at a time.`, "invalid_request");
    let size = 0;
    for (const c of chats)
      if (Array.isArray(c?.messages))
        for (const m of c.messages) if (typeof m?.text === "string") size += m.text.length;
    if (size > MAX_REQUEST_CHARS)
      fail(413, "That is too much text for one request. Send fewer chats at a time.", "import_too_large");
    const user = req.user.id,
      at = now(),
      seedGuard = isReleased(cfg, "seedguard");
    // The account's auto-delete default reaches every chat made after it was
    // set, imported ones too.
    const expires = defaultExpiry(db, user, at);
    let { room } = roomFor(user);
    const saved = [],
      skipped = [];
    const seen = db.prepare("SELECT 1 FROM chat_imports WHERE user_id=? AND source=? AND source_id=?");
    const mark = db.prepare(
      "INSERT INTO chat_imports(conversation_id,user_id,source,source_id,imported) VALUES(?,?,?,?,?)",
    );
    chats.forEach((raw, index) => {
      const checked = checkUploadedChat(raw, at);
      if (!checked.chat) return skipped.push({ index, reason: checked.reason });
      const chat = checked.chat;
      if (chat.sourceId && seen.get(user, source, chat.sourceId))
        return skipped.push({ index, reason: "already_imported" });
      if (seedGuard && !chat.allowSeed && uploadedSeedFinding(chat))
        return skipped.push({ index, reason: "seed_phrase_blocked" });
      if (room <= 0) return skipped.push({ index, reason: "conversation_limit" });
      const id = transaction(db, () => {
        const { id } = insertChat(db, user, chat, expires);
        mark.run(id, user, source, chat.sourceId, at);
        return id;
      });
      room--;
      saved.push({ index, id });
    });
    res.json({ saved, skipped, room });
  });
}
