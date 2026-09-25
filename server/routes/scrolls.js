import { uid, now, fail } from "../core.js";

const MAX_TITLE = 80;
const MAX_BODY = 8000;
const MAX_SCROLLS = 200;
const MAX_INSTRUCTIONS = 4000;

// Scrolls: saved, reusable prompts with {{variable}} placeholders. Standing
// instructions: one editable body the client may send as a leading system
// message on chat requests.
export function scrollsRoutes(ctx) {
  const { app, db, limit, requireUser } = ctx;
  const title = (value) => {
    const t = String(value ?? "").trim();
    if (!t || t.length > MAX_TITLE)
      fail(400, `Title must be 1–${MAX_TITLE} characters.`);
    return t;
  };
  const scrollBody = (value) => {
    const b = String(value ?? "");
    if (!b.trim() || b.length > MAX_BODY)
      fail(400, `Body must be 1–${MAX_BODY} characters.`);
    return b;
  };
  function owned(id, user) {
    const s = db
      .prepare("SELECT * FROM scrolls WHERE id=? AND user_id=?")
      .get(id, user);
    if (!s) fail(404, "Scroll not found.");
    return s;
  }

  app.get("/api/scrolls", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare("SELECT * FROM scrolls WHERE user_id=? ORDER BY updated DESC")
        .all(req.user.id),
    }),
  );

  app.post(
    "/api/scrolls",
    requireUser,
    limit("scrolls", 60, 3600000),
    (req, res) => {
      if (
        db
          .prepare("SELECT COUNT(*) n FROM scrolls WHERE user_id=?")
          .get(req.user.id).n >= MAX_SCROLLS
      )
        fail(400, `You can save up to ${MAX_SCROLLS} scrolls.`);
      const id = uid("scroll_");
      const t = title(req.body.title);
      const b = scrollBody(req.body.body);
      const created = now();
      db.prepare(
        "INSERT INTO scrolls(id,user_id,title,body,created,updated) VALUES(?,?,?,?,?,?)",
      ).run(id, req.user.id, t, b, created, created);
      res
        .status(201)
        .json({ id, title: t, body: b, created, updated: created });
    },
  );

  app.patch("/api/scrolls/:id", requireUser, (req, res) => {
    const s = owned(req.params.id, req.user.id);
    const t = req.body.title !== undefined ? title(req.body.title) : s.title;
    const b =
      req.body.body !== undefined ? scrollBody(req.body.body) : s.body;
    const updated = now();
    db.prepare("UPDATE scrolls SET title=?,body=?,updated=? WHERE id=?").run(
      t,
      b,
      updated,
      s.id,
    );
    res.json({ id: s.id, title: t, body: b, created: s.created, updated });
  });

  app.delete("/api/scrolls/:id", requireUser, (req, res) => {
    owned(req.params.id, req.user.id);
    db.prepare("DELETE FROM scrolls WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });

  app.get("/api/instructions", requireUser, (req, res) => {
    const row = db
      .prepare("SELECT * FROM user_instructions WHERE user_id=?")
      .get(req.user.id);
    res.json({
      body: row?.body || "",
      enabled: !!row?.enabled,
      updated: row?.updated ?? null,
    });
  });

  app.put("/api/instructions", requireUser, (req, res) => {
    const b = String(req.body.body ?? "");
    if (b.length > MAX_INSTRUCTIONS)
      fail(400, `Instructions cannot exceed ${MAX_INSTRUCTIONS} characters.`);
    const enabled = req.body.enabled === true;
    const updated = now();
    const exists = db
      .prepare("SELECT 1 FROM user_instructions WHERE user_id=?")
      .get(req.user.id);
    if (exists)
      db.prepare(
        "UPDATE user_instructions SET body=?,enabled=?,updated=? WHERE user_id=?",
      ).run(b, enabled ? 1 : 0, updated, req.user.id);
    else
      db.prepare(
        "INSERT INTO user_instructions(user_id,body,enabled,updated) VALUES(?,?,?,?)",
      ).run(req.user.id, b, enabled ? 1 : 0, updated);
    res.json({ body: b, enabled, updated });
  });
}
