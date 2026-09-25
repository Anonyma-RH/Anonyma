import { uid, now, fail } from "../core.js";
import { veil, createVeilState } from "../../src/veil.js";
import {
  MAX_FACTS,
  MEMORY_MODES,
  REFUSED_DETECTORS,
  normalizeFact,
  factError,
  buildMemoryMessage,
  matchesStored,
} from "../../src/memory.js";

// Optional Memory Across Models. Off until the account turns it on. Facts are
// written only through these routes (typed by the user, or saved from a
// message of a saved personal chat); chat requests never write memory. A
// request carries the facts it wants to use as [{ id, text }] (the browser
// may have masked them with Veil); forRequest keeps only this user's stored,
// enabled facts, unchanged apart from masking, and only for requests that
// may use memory at all. /api/chat and /api/quote both use it, so an estimate
// prices exactly the memory Send would add.
export function memoryRoutes(ctx) {
  const { app, db, limit, requireUser } = ctx;
  const setting = (user) =>
    !!db
      .prepare("SELECT enabled FROM memory_settings WHERE user_id=?")
      .get(user)?.enabled;
  const facts = (user) =>
    db
      .prepare(
        `SELECT f.id,f.text,f.enabled,f.created,f.updated,f.source_conversation_id,c.title source_title
         FROM memory_facts f LEFT JOIN conversations c ON c.id=f.source_conversation_id AND c.user_id=f.user_id
         WHERE f.user_id=? ORDER BY f.created,f.rowid`,
      )
      .all(user)
      .map(({ source_conversation_id, source_title, enabled, ...f }) => ({
        ...f,
        enabled: !!enabled,
        source: source_conversation_id
          ? {
              conversation_id: source_conversation_id,
              title: source_title ?? null,
            }
          : null,
      }));
  function owned(id, user) {
    const f = db
      .prepare("SELECT * FROM memory_facts WHERE id=? AND user_id=?")
      .get(id, user);
    if (!f) fail(404, "Memory fact not found.");
    return f;
  }
  function validText(value) {
    const text = normalizeFact(value);
    const sensitive = [
      ...new Set(
        veil(text, createVeilState()).tags.map((t) => t.replace(/_\d+$/, "")),
      ),
    ].filter((type) => REFUSED_DETECTORS.includes(type));
    const error = factError(text, sensitive);
    if (error)
      fail(
        400,
        error,
        sensitive.length ? "memory_sensitive" : "invalid_request",
      );
    return text;
  }

  function writeContext(req) {
    if (
      req.body?.private === true ||
      req.body?.ephemeral === true ||
      req.privateOnly ||
      (req.body?.mode != null && !MEMORY_MODES.includes(req.body.mode))
    )
      fail(
        400,
        "Memory cannot be changed from this chat context.",
        "memory_excluded",
      );
  }

  app.get("/api/memory", requireUser, (req, res) =>
    res.json({
      enabled: setting(req.user.id),
      facts: facts(req.user.id),
      limit: MAX_FACTS,
    }),
  );
  app.put("/api/memory/settings", requireUser, (req, res) => {
    writeContext(req);
    if (typeof req.body.enabled !== "boolean")
      fail(400, "enabled must be true or false.", "invalid_request");
    db.prepare(
      "INSERT INTO memory_settings(user_id,enabled,updated) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled,updated=excluded.updated",
    ).run(req.user.id, req.body.enabled ? 1 : 0, now());
    res.json({ enabled: req.body.enabled });
  });
  app.post(
    "/api/memory/facts",
    requireUser,
    limit("memory", 60, 3600000),
    (req, res) => {
      writeContext(req);
      const text = validText(req.body.text);
      // Saving from a chat message: only a saved personal conversation this
      // user can read. Off-the-record and Private chats are never saved, so
      // they can't be a source; shared (collab) conversations aren't either.
      let source = null;
      if (req.body.source_conversation != null) {
        if (typeof req.body.source_conversation !== "string")
          fail(
            400,
            "source_conversation must be a conversation id.",
            "invalid_request",
          );
        const c = ctx.conversations.accessConversation(
          req.body.source_conversation,
          req.user.id,
        );
        if (c.collab_id)
          fail(
            400,
            "Facts can't be saved from a shared conversation.",
            "memory_shared_source",
          );
        if (!MEMORY_MODES.includes(c.mode))
          fail(
            400,
            "Facts cannot be saved from this conversation mode.",
            "memory_excluded",
          );
        source = c.id;
      }
      if (
        db
          .prepare("SELECT COUNT(*) n FROM memory_facts WHERE user_id=?")
          .get(req.user.id).n >= MAX_FACTS
      )
        fail(
          400,
          `Memory holds up to ${MAX_FACTS} facts. Delete one first.`,
          "memory_full",
        );
      const id = uid("mem_"),
        created = now();
      db.prepare(
        "INSERT INTO memory_facts(id,user_id,text,enabled,source_conversation_id,created,updated) VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        req.user.id,
        text,
        req.body.enabled === false ? 0 : 1,
        source,
        created,
        created,
      );
      res.status(201).json(facts(req.user.id).find((f) => f.id === id));
    },
  );
  app.patch("/api/memory/facts/:id", requireUser, (req, res) => {
    writeContext(req);
    const f = owned(req.params.id, req.user.id);
    if (req.body.enabled !== undefined && typeof req.body.enabled !== "boolean")
      fail(400, "enabled must be true or false.", "invalid_request");
    const text =
      req.body.text !== undefined ? validText(req.body.text) : f.text;
    const enabled =
      req.body.enabled !== undefined ? (req.body.enabled ? 1 : 0) : f.enabled;
    db.prepare(
      "UPDATE memory_facts SET text=?,enabled=?,updated=? WHERE id=?",
    ).run(text, enabled, Math.max(now(), f.updated + 1), f.id);
    res.json(facts(req.user.id).find((x) => x.id === f.id));
  });
  app.delete("/api/memory/facts/:id", requireUser, (req, res) => {
    writeContext(req);
    owned(req.params.id, req.user.id);
    db.prepare("DELETE FROM memory_facts WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });
  // Forget everything: every fact goes; the on/off choice stays as it was.
  app.delete("/api/memory", requireUser, (req, res) => {
    writeContext(req);
    db.prepare("DELETE FROM memory_facts WHERE user_id=?").run(req.user.id);
    res.json({ ok: true });
  });

  // The memory a web chat (or its quote) may add, and why none was added.
  // Returns { message, facts: [{ id, text }] as sent, skipped, reason }.
  function forRequest(user, body, { api = false } = {}) {
    const asked = body?.memory;
    if (asked == null)
      return { message: null, facts: [], skipped: 0, reason: null };
    if (!Array.isArray(asked) || asked.length > MAX_FACTS)
      fail(
        400,
        `memory must be a list of up to ${MAX_FACTS} facts.`,
        "invalid_request",
      );
    const none = (reason) => ({
      message: null,
      facts: [],
      skipped: asked.length,
      reason,
    });
    // Never over the API, off the record, in Private Mode, in Symposium or
    // Double-check, or in a shared conversation, whatever the request says.
    if (api) return none("api");
    if (
      body.double_check != null ||
      !MEMORY_MODES.includes(body.mode ?? "chat")
    )
      return none("mode");
    if (body.private === true) return none("private");
    if (body.ephemeral === true) return none("off_record");
    if (typeof body.conversationId === "string") {
      const c = ctx.conversations.accessConversation(body.conversationId, user);
      if (c.collab_id) return none("shared");
      if (!MEMORY_MODES.includes(c.mode)) return none("mode");
    }
    if (!setting(user)) return none("disabled");
    const stored = new Map(
      db
        .prepare(
          "SELECT id,text,updated FROM memory_facts WHERE user_id=? AND enabled=1",
        )
        .all(user)
        .map((f) => [f.id, f]),
    );
    const sent = [],
      seen = new Set();
    for (const f of asked) {
      const text = typeof f?.text === "string" ? f.text : null;
      // Another account's fact, a deleted or disabled one, an edited one
      // whose old text the browser still has, or anything but masking: dropped.
      if (
        typeof f?.id !== "string" ||
        seen.has(f.id) ||
        !stored.has(f.id) ||
        !matchesStored(text, stored.get(f.id).text) ||
        (text !== stored.get(f.id).text &&
          f.updated !== stored.get(f.id).updated) ||
        (f.updated != null && f.updated !== stored.get(f.id).updated)
      )
        continue;
      seen.add(f.id);
      sent.push({ id: f.id, text });
    }
    return {
      message: buildMemoryMessage(sent.map((f) => f.text)),
      facts: sent,
      skipped: asked.length - sent.length,
      reason: sent.length ? null : asked.length ? "no_facts" : null,
    };
  }
  return { memory: { forRequest } };
}
