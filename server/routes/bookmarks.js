import { uid, now, fail, transaction } from "../core.js";
import { isReleased } from "../releases.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import {
  MAX_BOOKMARKS,
  MAX_NOTE,
  BOOKMARK_MODES,
  normalizeNote,
  excerptOf,
} from "../../src/bookmarks.js";

// Bookmarks: a star on one saved message, with an optional private note.
// Only the account that made it ever sees it, including in a shared (collab)
// conversation. A bookmark points at the message and never copies its text,
// so it goes with the message: deleting the conversation (or delete all, cap
// pruning, auto-delete cleanup, account closure, Panic Wipe) deletes it, and
// leaving a collab deletes your bookmarks there (a trigger, see core.js).
// Every read also checks access again, so a bookmark whose conversation is
// auto-deleting past its time, or that you can no longer open, is never
// shown. Off-the-record and Private chats are never saved, so there is
// nothing of theirs to bookmark. The release gate in releases.js refuses
// these routes while the update is unreleased.

// The text of a saved message, whatever shape it was saved in: a string, an
// array of text and image parts, or a reply object { text, reasoning, ... }.
const TEXT = `(CASE WHEN json_valid(m.content) THEN CASE json_type(m.content)
  WHEN 'text' THEN json_extract(m.content,'$')
  WHEN 'object' THEN json_extract(m.content,'$.text')
  WHEN 'array' THEN (SELECT group_concat(json_extract(p.value,'$.text'),char(10)) FROM json_each(m.content) p WHERE json_extract(p.value,'$.type')='text')
  END END)`;
// A bookmark the account can still read: its own, on a message of a
// conversation it can open (its own personal one, or one of a collab it is
// a current member of), in a mode that can be bookmarked, not past its
// auto-delete time. The same boundary as accessConversation.
const VISIBLE = `b.user_id=:user
  AND (c.expires IS NULL OR c.expires>=:now)
  AND coalesce(c.mode,'chat') IN (${BOOKMARK_MODES.map((m) => `'${m}'`).join(",")})
  AND ((c.collab_id IS NULL AND c.user_id=:user)
    OR EXISTS(SELECT 1 FROM collab_members cm WHERE cm.collab_id=c.collab_id AND cm.user_id=:user))`;
const FROM = `FROM bookmarks b
  JOIN messages m ON m.id=b.message_id
  JOIN conversations c ON c.id=m.conversation_id
  LEFT JOIN collabs k ON k.id=c.collab_id
  LEFT JOIN users u ON u.id=m.author_id`;

// `diagrams`: Math & Diagrams is released, so a reply's diagram source is
// left out of its excerpt (src/bookmarks.js).
function view(r, user, diagrams = false) {
  return {
    id: r.id,
    message_id: r.message_id,
    conversation_id: r.conversation_id,
    conversation_title: r.conversation_title || "Untitled",
    conversation_mode: r.conversation_mode || "chat",
    collab: r.collab_id ? { id: r.collab_id, name: r.collab_name } : null,
    // A shared conversation's auto-delete time, or a personal one's.
    expires: r.expires ?? null,
    role: r.role,
    model: r.role === "assistant" ? r.model || null : null,
    // Who wrote a prompt in a shared conversation, when it wasn't you.
    author: r.role === "user" && r.author_id && r.author_id !== user ? r.author || "Former member" : null,
    message_created: r.message_created,
    ...excerptOf(r.text, r.role, { diagrams }),
    note: r.note,
    created: r.created,
    updated: r.updated,
  };
}

// What the account export lists: ids and notes, never the message text
// again (it's already in the export's conversations).
export function exportBookmarks(db, user) {
  return db
    .prepare(
      `SELECT b.id,b.message_id,m.conversation_id,b.note,b.created,b.updated ${FROM}
       WHERE ${VISIBLE} ORDER BY b.created,b.rowid`,
    )
    .all({ user, now: now() });
}
// Account closure and Panic Wipe (eraseAccountContent in routes/account.js).
export function forgetBookmarks(db, user) {
  db.prepare("DELETE FROM bookmarks WHERE user_id=?").run(user);
}

export function bookmarkRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const read = limit("bookmarks-read", 240, 60000);
  const write = limit("bookmarks", 600, 3600000);
  const one = (id, user) =>
    typeof id === "string" &&
    id.length <= 100 &&
    db
      .prepare(
        `SELECT b.*,m.conversation_id,m.role,m.model,m.author_id,m.created message_created,
           c.title conversation_title,c.mode conversation_mode,c.collab_id,c.expires,k.name collab_name,u.username author,
           substr(${TEXT},1,4000) text
         ${FROM} WHERE b.id=:id AND ${VISIBLE}`,
      )
      .get({ id, user, now: now() });
  function owned(id, user) {
    const row = one(id, user);
    if (!row) fail(404, "Bookmark not found.", "bookmark_not_found");
    return row;
  }
  function note(value) {
    if (value == null) return "";
    if (typeof value !== "string")
      fail(400, "A note must be text.", "invalid_request");
    const text = normalizeNote(value);
    if (text.length > MAX_NOTE)
      fail(400, `Keep a note to ${MAX_NOTE} characters.`, "invalid_request");
    // Seed Guard: a note is stored, so a seed phrase is never saved in one.
    if (isReleased(cfg, "seedguard") && findSeedPhrase(text))
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    return text;
  }
  // Auto-deleting conversations past their time are already gone for every
  // read; the worker deletes them (and so their bookmarks) on its next pass.
  // Clearing the account's own ones first keeps the cap about what it can see.
  const clearExpired = (user) =>
    db
      .prepare(
        `DELETE FROM bookmarks WHERE user_id=? AND message_id IN
          (SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
           WHERE c.expires IS NOT NULL AND c.expires<?)`,
      )
      .run(user, now());

  app.get("/api/bookmarks", requireUser, read, (req, res) => {
    const q = String(req.query.q ?? "").trim(),
      role = String(req.query.role ?? "all"),
      offset = Number(req.query.offset ?? 0),
      take = Number(req.query.limit ?? 50),
      noted = req.query.noted === "true" || req.query.noted === "1",
      conversation = req.query.conversation;
    if (
      q.length > 160 ||
      !["all", "user", "assistant"].includes(role) ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > MAX_BOOKMARKS ||
      !Number.isInteger(take) ||
      take < 1 ||
      take > MAX_BOOKMARKS ||
      (conversation !== undefined && (typeof conversation !== "string" || conversation.length > 100))
    )
      fail(
        400,
        `Search up to 160 characters; role is all, user or assistant; use a page size of 1–${MAX_BOOKMARKS}.`,
        "invalid_request",
      );
    const where = [VISIBLE];
    const params = { user: req.user.id, now: now() };
    if (role !== "all") {
      where.push("m.role=:role");
      params.role = role;
    }
    if (noted) where.push("b.note<>''");
    if (conversation !== undefined) {
      where.push("m.conversation_id=:conversation");
      params.conversation = conversation;
    }
    if (q) {
      where.push(
        `(b.note LIKE :q ESCAPE '\\' OR c.title LIKE :q ESCAPE '\\' OR ${TEXT} LIKE :q ESCAPE '\\')`,
      );
      params.q = "%" + q.replace(/[\\%_]/g, "\\$&") + "%";
    }
    const rows = db
      .prepare(
        `SELECT b.*,m.conversation_id,m.role,m.model,m.author_id,m.created message_created,
           c.title conversation_title,c.mode conversation_mode,c.collab_id,c.expires,k.name collab_name,u.username author,
           substr(${TEXT},1,4000) text
         ${FROM} WHERE ${where.join(" AND ")}
         ORDER BY b.created DESC,b.rowid DESC LIMIT :take OFFSET :offset`,
      )
      .all({ ...params, take: take + 1, offset });
    res.json({
      data: rows.slice(0, take).map((r) => view(r, req.user.id, isReleased(cfg, "diagrams"))),
      nextOffset: rows.length > take ? offset + take : null,
      // Every bookmark the account can see, whatever the filter.
      total: db
        .prepare(`SELECT COUNT(*) n ${FROM} WHERE ${VISIBLE}`)
        .get({ user: req.user.id, now: params.now }).n,
      limit: MAX_BOOKMARKS,
    });
  });

  app.post("/api/bookmarks", requireUser, write, (req, res) => {
    const messageId = req.body?.message_id;
    if (typeof messageId !== "string" || !messageId || messageId.length > 100)
      fail(400, "message_id must be a saved message's id.", "invalid_request");
    const text = note(req.body.note);
    // A message you can't read looks exactly like one that doesn't exist.
    const missing = () =>
      fail(404, "Message not found.", "bookmark_message_not_found");
    const message = db
      .prepare("SELECT id,conversation_id FROM messages WHERE id=?")
      .get(messageId);
    if (!message) missing();
    let c;
    try {
      c = ctx.conversations.accessConversation(message.conversation_id, req.user.id);
    } catch {
      missing();
    }
    if (!BOOKMARK_MODES.includes(c.mode || "chat"))
      fail(
        400,
        "Only messages in saved chat, code and Uncensored conversations can be bookmarked.",
        "bookmark_excluded",
      );
    const result = transaction(db, () => {
      const existing = db
        .prepare("SELECT id FROM bookmarks WHERE user_id=? AND message_id=?")
        .get(req.user.id, messageId);
      if (existing) return { id: existing.id, created: false };
      clearExpired(req.user.id);
      const n = db
        .prepare("SELECT COUNT(*) n FROM bookmarks WHERE user_id=?")
        .get(req.user.id).n;
      if (n >= MAX_BOOKMARKS)
        fail(
          409,
          `You can keep up to ${MAX_BOOKMARKS.toLocaleString("en-US")} bookmarks. Remove one to add another.`,
          "bookmark_limit",
        );
      const id = uid("bm_"),
        at = now();
      db.prepare(
        "INSERT INTO bookmarks(id,user_id,message_id,note,created,updated) VALUES(?,?,?,?,?,?)",
      ).run(id, req.user.id, messageId, text, at, at);
      return { id, created: true };
    });
    res
      .status(result.created ? 201 : 200)
      .json(view(owned(result.id, req.user.id), req.user.id, isReleased(cfg, "diagrams")));
  });

  app.patch("/api/bookmarks/:id", requireUser, write, (req, res) => {
    owned(req.params.id, req.user.id);
    if (!req.body || !Object.hasOwn(req.body, "note"))
      fail(400, "Send the note to save (an empty one clears it).", "invalid_request");
    db.prepare("UPDATE bookmarks SET note=?,updated=? WHERE id=? AND user_id=?").run(
      note(req.body.note),
      now(),
      req.params.id,
      req.user.id,
    );
    res.json(view(owned(req.params.id, req.user.id), req.user.id, isReleased(cfg, "diagrams")));
  });

  // Removing never needs access to the message: your own bookmark can always go.
  app.delete("/api/bookmarks/:id", requireUser, write, (req, res) => {
    const r = db
      .prepare("DELETE FROM bookmarks WHERE id=? AND user_id=?")
      .run(String(req.params.id), req.user.id);
    if (!r.changes) fail(404, "Bookmark not found.", "bookmark_not_found");
    res.json({ ok: true });
  });
}
