import { uid, now, fail, credits, transaction } from "../core.js";
import { capsFor } from "../holders.js";
import { BASE_CAPS, HOLDER_CAPS } from "../holder-tiers.js";

// Use the same membership boundary as conversation reads. A removed member
// cannot export other members' messages from a shared conversation they created.
export function exportConversations(db, user) {
  return db
    .prepare(
      `SELECT c.* FROM conversations c
    WHERE ((c.collab_id IS NULL AND c.user_id=?) OR
      EXISTS (SELECT 1 FROM collab_members m WHERE m.collab_id=c.collab_id AND m.user_id=?))
      AND (c.expires IS NULL OR c.expires>=?)
    ORDER BY c.updated DESC,c.rowid DESC`,
    )
    .all(user, user, now())
    .map((c) => ({
      ...c,
      messages: db
        .prepare(
          "SELECT * FROM messages WHERE conversation_id=? ORDER BY created,rowid",
        )
        .all(c.id)
        .map((m) => ({
          ...m,
          content: JSON.parse(m.content),
          cost: c.collab_id && m.author_id !== user ? null : m.cost,
        })),
    }));
}

// Personal conversations kept per account, newest first. Symposium runs have
// their own cap (see newConversation). An account at the NYMA Holder
// Program's Holder tier keeps twice as many (capsFor, server/holders.js).
export const CONVERSATION_CAP = BASE_CAPS.conversations;
export const SYMPOSIUM_CAP = BASE_CAPS.symposium;

// Modes a conversation can be branched from. Symposium runs are several
// conversations per question and are not edited turn by turn.
const BRANCHABLE = [null, "chat", "code", "uncensored"];

// Days an auto-delete choice may hold; null clears it (kept forever).
const RETENTION_DAYS = [1, 7, 30];
const retentionExpiry = (value) => {
  if (value === null) return null;
  if (RETENTION_DAYS.includes(value)) return now() + value * 86400000;
  fail(400, "Retention must be null, 1, 7 or 30 days.", "invalid_request");
};

export function conversationRoutes({ app, db, cfg, requireUser }) {
  // Read and post: a personal conversation's creator, or a current member of
  // a shared conversation's collab (leaving a collab ends access, even to
  // conversations you started there). An expired conversation is treated as
  // gone immediately; the worker only reclaims its storage afterward.
  function accessConversation(id, user) {
    const c = db
      .prepare(
        `SELECT c.*, m.role collab_role, k.name collab_name, k.owner_id collab_owner
         FROM conversations c
         LEFT JOIN collab_members m ON m.collab_id=c.collab_id AND m.user_id=?
         LEFT JOIN collabs k ON k.id=c.collab_id
         WHERE c.id=? AND (CASE WHEN c.collab_id IS NULL THEN c.user_id=? ELSE m.user_id IS NOT NULL END)`,
      )
      .get(user, id, user);
    if (!c || (c.expires != null && c.expires < now()))
      fail(404, "Conversation not found.");
    return c;
  }
  // Rename and delete: the creator, or the owner of its collab.
  function ownConversation(id, user) {
    const c = accessConversation(id, user);
    if (c.user_id !== user && c.collab_owner !== user)
      fail(
        403,
        "Only its creator or the collab owner can change this conversation.",
      );
    return c;
  }
  function newConversation(
    user,
    title = "New conversation",
    mode = "chat",
    collab = null,
    // A conversation that must survive this call's pruning (the source of a
    // branch): it always counts among the kept newest, so an older one goes.
    protect = null,
  ) {
    const id = uid("c_");
    // An account's auto-delete default only reaches conversations created
    // after it was set; existing ones keep whatever they already had.
    const days = db
      .prepare("SELECT days FROM retention_defaults WHERE user_id=?")
      .get(user)?.days;
    const expires = days ? now() + days * 86400000 : null;
    db.prepare(
      "INSERT INTO conversations(id,user_id,title,mode,created,updated,collab_id,expires) VALUES(?,?,?,?,?,?,?,?)",
    ).run(id, user, title.slice(0, 70), mode, now(), now(), collab, expires);
    // Keep the newest 300 personal conversations (600 at the Holder tier);
    // shared ones belong to their collab. Symposium runs (several
    // conversations per question) are capped separately at 150 (300), so
    // they never push out ordinary chats. Messages go with their
    // conversation (ON DELETE CASCADE). Caps are read at each save, so an
    // account that leaves the tier loses nothing at once: the oldest beyond
    // the standard cap go as new ones are saved.
    const symposium = mode === "symposium" ? 1 : 0;
    const caps = capsFor(db, cfg, user);
    db.prepare(
      "DELETE FROM conversations WHERE user_id=? AND collab_id IS NULL AND (mode IS 'symposium')=? AND id NOT IN (SELECT id FROM conversations WHERE user_id=? AND collab_id IS NULL AND (mode IS 'symposium')=? ORDER BY (id IS ?) DESC,updated DESC,rowid DESC LIMIT ?)",
    ).run(user, symposium, user, symposium, protect, symposium ? caps.symposium : caps.conversations);
    return id;
  }
  app.get("/api/conversations", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          // Symposium runs are capped on their own and never shown here, so they
          // can't crowd ordinary chats out of this list. Everything kept is
          // listed, up to the Holder tier's larger cap.
          "SELECT * FROM conversations WHERE user_id=? AND collab_id IS NULL AND mode IS NOT 'symposium' AND (expires IS NULL OR expires>=?) ORDER BY updated DESC,rowid DESC LIMIT ?",
        )
        .all(req.user.id, now(), HOLDER_CAPS.conversations),
    }),
  );
  app.post("/api/conversations", requireUser, (req, res) =>
    res.status(201).json({
      id: newConversation(
        req.user.id,
        String(req.body.title || "New conversation"),
        String(req.body.mode || "chat"),
      ),
    }),
  );
  app.get("/api/conversations/export", requireUser, (req, res) => {
    res.attachment("anonyma-conversations.json").json({
      conversations: exportConversations(db, req.user.id),
    });
  });
  app.delete("/api/conversations", requireUser, (req, res) => {
    db.prepare(
      "DELETE FROM conversations WHERE user_id=? AND collab_id IS NULL",
    ).run(req.user.id);
    res.json({ ok: true });
  });
  app.get("/api/conversations/:id", requireUser, (req, res) => {
    const { collab_role, collab_name, collab_owner, ...c } = accessConversation(
      req.params.id,
      req.user.id,
    );
    // Provenance: the parent (only if this user can still open it) and the
    // branches cut from this conversation that this user can open.
    const visible = (id) => {
      try {
        return accessConversation(id, req.user.id);
      } catch {
        return null;
      }
    };
    const parent = c.parent_id ? visible(c.parent_id) : null;
    const branches = db
      .prepare(
        "SELECT id FROM conversations WHERE parent_id=? ORDER BY created,rowid",
      )
      .all(c.id)
      .map((b) => visible(b.id))
      .filter(Boolean)
      .map((b) => ({
        id: b.id,
        title: b.title,
        mode: b.mode,
        branch_point: b.branch_point,
        created: b.created,
      }));
    const { branch_key, branch_cut, ...rest } = c;
    res.json({
      ...rest,
      parent: parent ? { id: parent.id, title: parent.title, mode: parent.mode } : null,
      branches,
      ...(c.collab_id
        ? {
            collab: {
              id: c.collab_id,
              name: collab_name,
              owner: collab_owner === req.user.id,
            },
          }
        : {}),
      messages: db
        .prepare(
          "SELECT m.*, u.username author FROM messages m LEFT JOIN users u ON u.id=m.author_id WHERE m.conversation_id=? ORDER BY m.created,m.rowid",
        )
        .all(c.id)
        .map((m) => ({
          ...m,
          content: JSON.parse(m.content),
          // Other members see each other's messages but not what they paid.
          credits:
            m.author_id && m.author_id !== req.user.id ? null : credits(m.cost),
          cost: m.author_id && m.author_id !== req.user.id ? null : m.cost,
        })),
    });
  });
  // Branch: copy the start of a conversation into a new one, leaving the
  // original untouched. `before` copies every message ahead of the given one
  // (edit or regenerate that turn); `through` copies up to and including it
  // (continue from there). A shared conversation's branch stays in the same
  // collab, so only its current members can read it. Copies carry no cost:
  // nothing was charged again. A retried request (same requestId) returns
  // the branch it already made.
  app.post("/api/conversations/:id/branch", requireUser, (req, res) => {
    const source = accessConversation(req.params.id, req.user.id);
    if (!BRANCHABLE.includes(source.mode ?? null))
      fail(400, "This conversation can't be branched.", "invalid_request");
    const { before, through } = req.body;
    const point = before ?? through;
    const cut = before != null ? "before" : "through";
    if (
      (before == null) === (through == null) ||
      typeof point !== "string" ||
      !point
    )
      fail(400, "Give exactly one of before or through (a message id).", "invalid_request");
    const requestId = req.body.requestId;
    if (typeof requestId !== "string" || !requestId.trim() || requestId.length > 200)
      fail(400, "Request ID must contain 1–200 characters.", "invalid_request_id");
    const key = req.user.id + ":" + requestId;
    const existing = db
      .prepare("SELECT * FROM conversations WHERE branch_key=?")
      .get(key);
    if (existing) {
      if (
        existing.parent_id !== source.id ||
        existing.branch_point !== point ||
        existing.branch_cut !== cut
      )
        fail(409, "This request ID was already used for a different branch.", "idempotency_conflict");
      return res.status(200).json({
        id: existing.id,
        title: existing.title,
        mode: existing.mode,
        parent: { id: source.id, title: source.title, mode: source.mode || "chat" },
        copied: db
          .prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?")
          .get(existing.id).n,
      });
    }
    const all = db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id=? ORDER BY created,rowid",
      )
      .all(source.id);
    const at = all.findIndex((m) => m.id === point);
    if (at < 0) fail(404, "Message not found in this conversation.");
    const copy = all.slice(0, before != null ? at : at + 1);
    const title = String(req.body.title || "Branch · " + (source.title || "Untitled"))
      .trim()
      .slice(0, 70) || "Branch";
    const id = transaction(db, () => {
      // The source is protected from the personal-conversation cap: making a
      // branch never deletes the conversation it was cut from.
      const id = newConversation(req.user.id, title, source.mode || "chat", source.collab_id, source.id);
      // A branch never outlives an auto-deleting source: it keeps the earlier
      // of the source's expiry and the account default newConversation set.
      const own = db.prepare("SELECT expires FROM conversations WHERE id=?").get(id).expires;
      const expires =
        source.expires == null ? own : own == null ? source.expires : Math.min(own, source.expires);
      db.prepare(
        "UPDATE conversations SET parent_id=?,branch_point=?,branch_cut=?,branch_key=?,expires=?,created=?,updated=? WHERE id=?",
      ).run(source.id, point, cut, key, expires, now(), now(), id);
      const insert = db.prepare(
        "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id,origin_id) VALUES(?,?,?,?,?,?,?,?,?)",
      );
      for (const m of copy)
        insert.run(uid("m_"), id, m.role, m.content, m.model, 0, m.created, m.author_id, m.id);
      return id;
    });
    res.status(201).json({
      id,
      title,
      mode: source.mode || "chat",
      parent: { id: source.id, title: source.title, mode: source.mode || "chat" },
      copied: copy.length,
    });
  });
  app.patch("/api/conversations/:id", requireUser, (req, res) => {
    const c = ownConversation(req.params.id, req.user.id);
    // Unchanged default: a body with no retention field always sets the
    // title (as before). A retention-only body leaves the title alone.
    if (!Object.hasOwn(req.body, "retention") || Object.hasOwn(req.body, "title"))
      db.prepare("UPDATE conversations SET title=?,updated=? WHERE id=?").run(
        String(req.body.title || "Untitled")
          .trim()
          .slice(0, 70) || "Untitled",
        now(),
        req.params.id,
      );
    if (Object.hasOwn(req.body, "retention")) {
      // Auto-delete is stricter than rename/delete: a shared conversation's
      // creator doesn't control it, only the collab's owner does.
      if (c.collab_id && c.collab_owner !== req.user.id)
        fail(
          403,
          "Only the collab owner can set auto-delete for a shared conversation.",
        );
      db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(
        retentionExpiry(req.body.retention),
        req.params.id,
      );
    }
    res.json({ ok: true });
  });
  app.delete("/api/conversations/:id", requireUser, (req, res) => {
    ownConversation(req.params.id, req.user.id);
    db.prepare("DELETE FROM conversations WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });
  return { accessConversation, ownConversation, newConversation };
}
