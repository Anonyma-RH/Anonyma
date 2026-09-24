import { randomBytes } from "node:crypto";
import { uid, hash, now, fail, transaction } from "../core.js";

export const MAX_MEMBERS = 12;
const MAX_OWNED = 20;

// Collab: shared workspaces. Members read and post in the same
// conversations; each member's requests are billed to their own balance.
export function collabRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const { newConversation } = ctx.conversations;
  const name = (value) => {
    const n = String(value || "")
      .trim()
      .slice(0, 60);
    if (!n) fail(400, "Give the collab a name.");
    return n;
  };
  function membership(id, user) {
    const m = db
      .prepare(
        "SELECT c.*, m.role FROM collabs c JOIN collab_members m ON m.collab_id=c.id AND m.user_id=? WHERE c.id=?",
      )
      .get(user, id);
    if (!m) fail(404, "Collab not found.");
    return m;
  }
  const owned = (id, user) => {
    const c = membership(id, user);
    if (c.owner_id !== user) fail(403, "Only the collab owner can do that.");
    return c;
  };
  const touch = (id) =>
    db.prepare("UPDATE collabs SET updated=? WHERE id=?").run(now(), id);

  app.get("/api/collabs", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          `SELECT c.id, c.name, c.updated, m.role,
             (SELECT COUNT(*) FROM collab_members x WHERE x.collab_id=c.id) members
           FROM collabs c JOIN collab_members m ON m.collab_id=c.id AND m.user_id=?
           ORDER BY c.updated DESC`,
        )
        .all(req.user.id),
    }),
  );

  app.post(
    "/api/collabs",
    requireUser,
    limit("collabs", 10, 3600000),
    (req, res) => {
      const title = name(req.body.name);
      if (
        db
          .prepare("SELECT COUNT(*) n FROM collabs WHERE owner_id=?")
          .get(req.user.id).n >= MAX_OWNED
      )
        fail(400, `You can own up to ${MAX_OWNED} collabs.`);
      const id = uid("collab_");
      transaction(db, () => {
        db.prepare(
          "INSERT INTO collabs(id,owner_id,name,created,updated) VALUES(?,?,?,?,?)",
        ).run(id, req.user.id, title, now(), now());
        db.prepare(
          "INSERT INTO collab_members(collab_id,user_id,role,joined) VALUES(?,?,?,?)",
        ).run(id, req.user.id, "owner", now());
      });
      res.status(201).json({ id, name: title });
    },
  );

  app.get("/api/collabs/:id", requireUser, (req, res) => {
    const c = membership(req.params.id, req.user.id);
    res.json({
      id: c.id,
      name: c.name,
      role: c.role,
      maxMembers: MAX_MEMBERS,
      members: db
        .prepare(
          "SELECT u.username, m.role, m.joined FROM collab_members m JOIN users u ON u.id=m.user_id WHERE m.collab_id=? ORDER BY m.role DESC, m.joined",
        )
        .all(c.id)
        .map((m) => ({ ...m, username: m.username || "Former member" })),
      conversations: db
        .prepare(
          "SELECT c.id, c.title, c.mode, c.updated, c.expires, u.username author FROM conversations c LEFT JOIN users u ON u.id=c.user_id WHERE c.collab_id=? AND (c.expires IS NULL OR c.expires>=?) ORDER BY c.updated DESC LIMIT 100",
        )
        .all(c.id, now()),
    });
  });

  app.patch("/api/collabs/:id", requireUser, (req, res) => {
    owned(req.params.id, req.user.id);
    db.prepare("UPDATE collabs SET name=?,updated=? WHERE id=?").run(
      name(req.body.name),
      now(),
      req.params.id,
    );
    res.json({ ok: true });
  });

  app.delete("/api/collabs/:id", requireUser, (req, res) => {
    owned(req.params.id, req.user.id);
    // Shared conversations and memberships go with the collab.
    db.prepare("DELETE FROM collabs WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });

  // A new invite link replaces the previous one.
  app.post("/api/collabs/:id/invite", requireUser, (req, res) => {
    owned(req.params.id, req.user.id);
    const token = randomBytes(24).toString("hex");
    db.prepare("UPDATE collabs SET invite_hash=? WHERE id=?").run(
      hash(token),
      req.params.id,
    );
    res.json({
      token,
      link: `${cfg.publicUrl || cfg.origin}/workspace/collab?join=${token}`,
    });
  });

  app.post(
    "/api/collabs/join",
    requireUser,
    limit("collab-join", 20, 3600000),
    (req, res) => {
      const token = String(req.body.token || "");
      if (!/^[a-f0-9]{48}$/.test(token))
        fail(400, "That invite link isn't valid.");
      const c = db
        .prepare("SELECT * FROM collabs WHERE invite_hash=?")
        .get(hash(token));
      if (!c)
        fail(
          404,
          "That invite link has expired or been replaced.",
          "invite_invalid",
        );
      transaction(db, () => {
        const already = db
          .prepare(
            "SELECT 1 FROM collab_members WHERE collab_id=? AND user_id=?",
          )
          .get(c.id, req.user.id);
        if (already) return;
        const count = db
          .prepare("SELECT COUNT(*) n FROM collab_members WHERE collab_id=?")
          .get(c.id).n;
        if (count >= MAX_MEMBERS)
          fail(
            409,
            `This collab already has ${MAX_MEMBERS} members.`,
            "collab_full",
          );
        db.prepare(
          "INSERT INTO collab_members(collab_id,user_id,role,joined) VALUES(?,?,?,?)",
        ).run(c.id, req.user.id, "member", now());
      });
      touch(c.id);
      res.json({ id: c.id, name: c.name });
    },
  );

  // The owner removes someone, or a member leaves (the owner deletes instead).
  app.delete("/api/collabs/:id/members/:username", requireUser, (req, res) => {
    const c = membership(req.params.id, req.user.id);
    const target = db
      .prepare(
        "SELECT u.id FROM collab_members m JOIN users u ON u.id=m.user_id WHERE m.collab_id=? AND u.username=? COLLATE NOCASE",
      )
      .get(c.id, req.params.username);
    if (!target) fail(404, "That person isn't a member.");
    if (target.id === c.owner_id)
      fail(400, "The owner can't leave. Delete the collab instead.");
    if (target.id !== req.user.id && c.owner_id !== req.user.id)
      fail(403, "Only the collab owner can remove members.");
    db.prepare(
      "DELETE FROM collab_members WHERE collab_id=? AND user_id=?",
    ).run(c.id, target.id);
    res.json({ ok: true });
  });

  app.post("/api/collabs/:id/conversations", requireUser, (req, res) => {
    const c = membership(req.params.id, req.user.id);
    const id = newConversation(
      req.user.id,
      String(req.body.title || "Shared conversation"),
      req.body.mode === "code" ? "code" : "chat",
      c.id,
    );
    touch(c.id);
    res.status(201).json({ id });
  });
}
