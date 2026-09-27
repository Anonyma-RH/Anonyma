import { uid, now, fail } from "../core.js";
import { isReleased } from "../releases.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import { CANVAS_LIMITS, MAX_CANVASES } from "../../src/canvas-spec.js";

// Canvas: the canvases an account keeps on the server ("Saved to your
// account"). A canvas is a title and its Markdown text, nothing else: the
// suggestions made on it are off-the-record chats (server/canvas.js) and
// never stored, and neither is the side panel's history. Canvases kept off
// the record (this tab only) or encrypted on the device stay in the browser
// and never reach these routes.
//
// Like a new conversation, a new canvas takes the account's auto-delete
// default (retention_defaults), fixed when it's made: past that time it's
// gone for every read and the worker deletes it. Account closure and Panic
// Wipe erase every canvas (forgetCanvases), and the account export lists
// them with their text (exportCanvases). Nothing about a canvas is logged.

const LIST = "SELECT id,title,length(content) chars,revision,created,updated,expires FROM canvas_documents";
const LIVE = "user_id=? AND (expires IS NULL OR expires>=?)";
const view = (r) => ({
  id: r.id,
  title: r.title,
  ...(r.content !== undefined ? { content: r.content } : { chars: r.chars }),
  revision: r.revision,
  created: r.created,
  updated: r.updated,
  expires: r.expires ?? null,
});

// The account export: every canvas the account can still open, with its text.
export function exportCanvases(db, user) {
  return db
    .prepare(`SELECT id,title,content,revision,created,updated,expires FROM canvas_documents WHERE ${LIVE} ORDER BY created,rowid`)
    .all(user, now())
    .map(view);
}
// Account closure and Panic Wipe (eraseAccountContent in routes/account.js).
export function forgetCanvases(db, user) {
  db.prepare("DELETE FROM canvas_documents WHERE user_id=?").run(user);
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
export function canvasRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const read = limit("canvas-read", 240, 60000);
  // Autosave writes every second or two while someone types.
  const write = limit("canvas", 1200, 600000);
  const seedGuard = () => isReleased(cfg, "seedguard");
  function title(value) {
    if (typeof value !== "string") fail(400, "A title must be text.", "invalid_request");
    const t = value.replace(/\s+/g, " ").trim();
    if (!t) fail(400, "Give the canvas a title.", "invalid_request");
    if (t.length > CANVAS_LIMITS.title) fail(400, `Keep a title to ${CANVAS_LIMITS.title} characters.`, "invalid_request");
    if (CONTROL.test(t)) fail(400, "A title can't hold control characters.", "invalid_request");
    return t;
  }
  function content(value) {
    if (typeof value !== "string") fail(400, "A canvas's text must be text.", "invalid_request");
    if (value.length > CANVAS_LIMITS.content)
      fail(413, "A canvas holds up to 200,000 characters. Split it into two, or export it.", "canvas_too_large");
    if (CONTROL.test(value)) fail(400, "A canvas can't hold control characters.", "invalid_request");
    return value.replace(/\r\n?/g, "\n");
  }
  // Seed Guard: a canvas kept here is stored, so a seed phrase is never
  // saved in one (no override; the browser keeps it off the server first).
  const guard = (...texts) => {
    if (seedGuard() && texts.some((t) => typeof t === "string" && findSeedPhrase(t)))
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
  };
  const one = (id, user) =>
    typeof id === "string" && id.length <= 100
      ? db.prepare(`SELECT * FROM canvas_documents WHERE id=? AND ${LIVE}`).get(id, user, now())
      : null;
  function owned(id, user) {
    const row = one(id, user);
    if (!row) fail(404, "Canvas not found.", "canvas_not_found");
    return row;
  }

  app.get("/api/canvas", requireUser, read, (req, res) => {
    const data = db.prepare(`${LIST} WHERE ${LIVE} ORDER BY updated DESC,rowid DESC`).all(req.user.id, now()).map(view);
    res.json({ data, limit: MAX_CANVASES });
  });
  app.post("/api/canvas", requireUser, write, (req, res) => {
    const body = req.body || {};
    for (const key of Object.keys(body))
      if (!["title", "content"].includes(key)) fail(400, "A canvas takes a title and its text.", "invalid_request");
    const t = title(body.title ?? "Untitled canvas");
    const text = content(body.content ?? "");
    guard(t, text);
    const user = req.user.id;
    // The account's auto-delete default, as for a new conversation.
    const days = db.prepare("SELECT days FROM retention_defaults WHERE user_id=?").get(user)?.days;
    const at = now();
    const id = uid("cv_");
    // Canvases past their auto-delete time no longer count.
    db.prepare("DELETE FROM canvas_documents WHERE user_id=? AND expires IS NOT NULL AND expires<?").run(user, at);
    try {
      db.prepare(
        "INSERT INTO canvas_documents(id,user_id,title,content,revision,created,updated,expires) VALUES(?,?,?,?,1,?,?,?)",
      ).run(id, user, t, text, at, at, days ? at + days * 86400000 : null);
    } catch (e) {
      if (/canvas_limit/.test(e.message))
        fail(409, `You can keep up to ${MAX_CANVASES} canvases. Delete one to make another.`, "canvas_limit");
      throw e;
    }
    res.status(201).json(view(owned(id, user)));
  });
  app.get("/api/canvas/:id", requireUser, read, (req, res) => {
    res.json(view(owned(req.params.id, req.user.id)));
  });
  // Rename, save its text, or both. `base` is the revision the browser
  // last saw: when the canvas has changed since (another tab or device),
  // nothing is saved and it's 409 canvas_conflict.
  app.patch("/api/canvas/:id", requireUser, write, (req, res) => {
    const body = req.body || {};
    for (const key of Object.keys(body))
      if (!["title", "content", "base"].includes(key)) fail(400, "A canvas takes a title and its text.", "invalid_request");
    if (body.title === undefined && body.content === undefined)
      fail(400, "Send a new title, new text or both.", "invalid_request");
    const row = owned(req.params.id, req.user.id);
    if (body.base !== undefined) {
      if (!Number.isSafeInteger(body.base) || body.base < 1) fail(400, "base must be a revision number.", "invalid_request");
      if (body.base !== row.revision)
        fail(409, "This canvas was changed somewhere else since you opened it.", "canvas_conflict");
    }
    const t = body.title === undefined ? row.title : title(body.title);
    const text = body.content === undefined ? row.content : content(body.content);
    guard(body.title === undefined ? null : t, body.content === undefined ? null : text);
    if (t !== row.title || text !== row.content)
      db.prepare("UPDATE canvas_documents SET title=?,content=?,revision=revision+1,updated=? WHERE id=?").run(
        t,
        text,
        now(),
        row.id,
      );
    res.json(view(owned(row.id, req.user.id)));
  });
  app.delete("/api/canvas/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    db.prepare("DELETE FROM canvas_documents WHERE id=?").run(row.id);
    res.json({ ok: true });
  });
}
