import { uid, now, fail, credits } from "../core.js";

export function conversationRoutes({ app, db, requireUser }) {
  function ownConversation(id, user) {
    const c = db
      .prepare("SELECT * FROM conversations WHERE id=? AND user_id=?")
      .get(id, user);
    if (!c) fail(404, "Conversation not found.");
    return c;
  }
  function newConversation(user, title = "New conversation", mode = "chat") {
    const id = uid("c_");
    db.prepare(
      "INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)",
    ).run(id, user, title.slice(0, 70), mode, now(), now());
    db.prepare(
      "DELETE FROM conversations WHERE user_id=? AND id NOT IN (SELECT id FROM conversations WHERE user_id=? ORDER BY updated DESC LIMIT 300)",
    ).run(user, user);
    return id;
  }
  app.get("/api/conversations", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT * FROM conversations WHERE user_id=? ORDER BY updated DESC LIMIT 300",
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
    db.prepare("DELETE FROM conversations WHERE user_id=?").run(req.user.id);
    res.json({ ok: true });
  });
  app.get("/api/conversations/:id", requireUser, (req, res) => {
    const c = ownConversation(req.params.id, req.user.id);
    res.json({
      ...c,
      messages: db
        .prepare(
          "SELECT * FROM messages WHERE conversation_id=? ORDER BY created,rowid",
        )
        .all(c.id)
        .map((m) => ({
          ...m,
          content: JSON.parse(m.content),
          credits: credits(m.cost),
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
  return { ownConversation, newConversation };
}
