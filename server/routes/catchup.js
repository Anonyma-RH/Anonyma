import { now, fail, transaction } from "../core.js";
import { isReleased } from "../releases.js";
import { checkCarriedSummary } from "../../src/catchup.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";

// Summarize & Continue (update "catchup"). Catch me up itself is an
// ordinary off-the-record /api/chat request (server/catchup.js), so the only
// route here is Continue fresh for a saved chat: a new conversation, linked
// back to the one it came from, whose carried summary the browser sends as
// the leading context of every message in it. Chats the server never saved
// (off the record, Private Mode, device-only) continue in the browser and
// never reach this.
//
// Nothing is copied from the source but its mode, its collab and its
// project: the new chat starts empty. The source is never changed.
// Money: none. Creating the chat is free; its messages bill as usual.
// Privacy: the summary is stored with the new chat only (chat_continuations),
// goes with it whatever deletes it, and is in the account export. Never logged.
const CONTINUABLE = [null, "chat", "code", "uncensored"];

// The link and summary a continued conversation carries, or null. The
// source is named only while `visible` says this user can still open it.
export function continuationOf(db, id, visible) {
  const row = db
    .prepare("SELECT source_id,summary,created FROM chat_continuations WHERE conversation_id=?")
    .get(id);
  if (!row) return null;
  const source = visible(row.source_id);
  return {
    from: source ? { id: source.id, title: source.title, mode: source.mode || "chat" } : null,
    summary: row.summary,
    created: row.created,
  };
}

export function catchupRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const { accessConversation, newConversation } = ctx.conversations;

  app.post("/api/catchup/continue", requireUser, limit("catchup_continue", 30, 60000), (req, res) => {
    const body = req.body || {};
    if (typeof body.from !== "string" || !body.from)
      fail(400, "Name the chat to continue from.", "invalid_request");
    const source = accessConversation(body.from, req.user.id);
    if (!CONTINUABLE.includes(source.mode ?? null))
      fail(400, "Only chat, code and Uncensored conversations can be continued fresh.", "invalid_request");
    let summary;
    try {
      summary = checkCarriedSummary(body.summary);
    } catch (e) {
      fail(400, e.message, "invalid_request");
    }
    // Seed Guard: the summary goes with every message in the new chat, so a
    // seed phrase in it is refused here, with no override.
    if (isReleased(cfg, "seedguard") && findSeedPhrase(summary))
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    if (body.title != null && typeof body.title !== "string")
      fail(400, "title must be text.", "invalid_request");
    const title =
      String(body.title || "Continued · " + (source.title || "Untitled"))
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 70) || "Continued";
    const mode = source.mode || "chat";
    const created = now();
    const id = transaction(db, () => {
      // Like a branch: the source is protected from the conversation cap, a
      // shared chat's continuation stays in its collab, and it never
      // outlives an auto-deleting source.
      const id = newConversation(req.user.id, title, mode, source.collab_id, source.id);
      const own = db.prepare("SELECT expires FROM conversations WHERE id=?").get(id).expires;
      const expires =
        source.expires == null ? own : own == null ? source.expires : Math.min(own, source.expires);
      db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(expires, id);
      db.prepare(
        "INSERT INTO chat_continuations(conversation_id,source_id,user_id,summary,created) VALUES(?,?,?,?,?)",
      ).run(id, source.id, req.user.id, summary, created);
      // Projects: a continuation of a filed chat is filed in the same project.
      db.prepare(
        "INSERT INTO project_chats(conversation_id,project_id,user_id,added) SELECT ?,project_id,user_id,? FROM project_chats WHERE conversation_id=? AND user_id=?",
      ).run(id, created, source.id, req.user.id);
      return id;
    });
    res.status(201).json({
      id,
      title,
      mode,
      continued: {
        from: { id: source.id, title: source.title, mode },
        summary,
        created,
      },
    });
  });
}
