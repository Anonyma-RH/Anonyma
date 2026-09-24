import { uid, now, fail, credits } from "../core.js";

export function conversationRoutes({ app, db, requireUser }) {
  // Read and post: a personal conversation's creator, or a current member of
  // a shared conversation's collab (leaving a collab ends access, even to
  // conversations you started there).
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
    if (!c) fail(404, "Conversation not found.");
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
  ) {
    const id = uid("c_");
    db.prepare(
      "INSERT INTO conversations(id,user_id,title,mode,created,updated,collab_id) VALUES(?,?,?,?,?,?,?)",
    ).run(id, user, title.slice(0, 70), mode, now(), now(), collab);
    // Keep the newest 300 personal conversations; shared ones belong to their collab.
    db.prepare(
      "DELETE FROM conversations WHERE user_id=? AND collab_id IS NULL AND id NOT IN (SELECT id FROM conversations WHERE user_id=? AND collab_id IS NULL ORDER BY updated DESC LIMIT 300)",
    ).run(user, user);
    return id;
  }
  app.get("/api/conversations", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT * FROM conversations WHERE user_id=? AND collab_id IS NULL ORDER BY updated DESC LIMIT 300",
        )
        .all(req.user.id),
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
      conversations: db
        .prepare(
          "SELECT * FROM conversations WHERE user_id=? ORDER BY updated DESC",
        )
        .all(req.user.id)
        .map((c) => ({
          ...c,
          messages: db
            .prepare(
              "SELECT * FROM messages WHERE conversation_id=? ORDER BY created,rowid",
            )
            .all(c.id)
            .map((m) => ({ ...m, content: JSON.parse(m.content) })),
        })),
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
    res.json({
      ...c,
      ...(c.collab_id
        ? { collab: { id: c.collab_id, name: collab_name } }
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
  app.patch("/api/conversations/:id", requireUser, (req, res) => {
    ownConversation(req.params.id, req.user.id);
    db.prepare("UPDATE conversations SET title=?,updated=? WHERE id=?").run(
      String(req.body.title || "Untitled")
        .trim()
        .slice(0, 70) || "Untitled",
      now(),
      req.params.id,
    );
    res.json({ ok: true });
  });
  app.delete("/api/conversations/:id", requireUser, (req, res) => {
    ownConversation(req.params.id, req.user.id);
    db.prepare("DELETE FROM conversations WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });
  return { accessConversation, ownConversation, newConversation };
}
