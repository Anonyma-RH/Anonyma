import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { uid, now, fail, transaction } from "../core.js";
import {
  MAX_ACTIVE_SHARES,
  MAX_SHARES_PER_CONVERSATION,
  MAX_SHARE_MESSAGES,
  MAX_SHARE_CHARS,
  MAX_SHARE_TITLE,
  SHAREABLE_MODES,
  SHARE_BLOCK_MESSAGES,
  SHARE_TOKEN,
  SHARE_TOKEN_BYTES,
  attachmentNames,
  buildSnapshot,
  parseShareDays,
  shareExpiry,
  sharePath,
  shareTitle,
  snapshotSummary,
} from "../../src/share-links.js";

// Share a Chat (update "sharelinks"). An account publishes a read-only
// snapshot of one of its saved personal conversations at /s/<token>. The
// snapshot is copied once, at creation (src/share-links.js says what it
// holds); later messages never join it. The link is gone for everyone the
// moment it's revoked, when it expires, when its conversation is deleted or
// auto-deleted, and when the account closes; each of those looks exactly like
// a token that never existed. Share links are never listed anywhere public.
export function shareRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const base = () => String(cfg.publicUrl || cfg.origin).replace(/\/+$/, "");
  // A shared page and its data: kept out of search indexes and caches, and
  // the token never travels on as a referrer.
  const privatePage = (res) =>
    res.set({
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "no-store",
    });
  // Viewing is public and needs no sign-in, so it's limited per address.
  const viewLimit = limit("share_view", 120, 60000);
  // The page's title: the one asked for, else the conversation's. Never an
  // attachment's name (a chat that began with only a document is titled
  // after it), since attachments aren't published.
  function title(asked, conversationTitle, rows) {
    const chosen = shareTitle(asked, conversationTitle);
    // A conversation title keeps only its first 70 characters.
    const named = [...attachmentNames(rows)].some(
      (n) => n === chosen || n.slice(0, MAX_SHARE_TITLE).trim() === chosen,
    );
    return named ? "Shared conversation" : chosen;
  }
  // Unknown, revoked, expired and deleted all look the same.
  const missing = () =>
    fail(404, "This shared conversation isn't available.", "share_not_found");
  // A link is live while it hasn't expired, its conversation still exists and
  // hasn't passed its auto-delete (treated as gone at once, as everywhere
  // else), and its account is open.
  const LIVE = `(s.expires IS NULL OR s.expires>?) AND (c.expires IS NULL OR c.expires>=?) AND c.collab_id IS NULL AND u.deleted IS NULL`;
  const FROM = `FROM share_links s JOIN conversations c ON c.id=s.conversation_id JOIN users u ON u.id=s.user_id`;
  function published(token) {
    if (typeof token !== "string" || !SHARE_TOKEN.test(token)) return null;
    const t = now();
    return (
      db
        .prepare(`SELECT s.title,s.snapshot,s.created ${FROM} WHERE s.token=? AND ${LIVE}`)
        .get(token, t, t) || null
    );
  }
  const view = (s) => ({
    id: s.id,
    url: base() + sharePath(s.token),
    path: sharePath(s.token),
    title: s.title,
    conversation_id: s.conversation_id,
    conversation_title: s.conversation_title,
    messages: s.message_count,
    created: s.created,
    expires: s.expires,
    // The conversation's auto-delete is the deadline that applies.
    ends_with_conversation:
      s.conversation_expires != null && s.expires === s.conversation_expires,
  });
  const owned = (user, extra = "", ...args) => {
    const t = now();
    return db
      .prepare(
        `SELECT s.id,s.token,s.title,s.conversation_id,s.message_count,s.created,s.expires,c.title conversation_title,c.expires conversation_expires ${FROM} WHERE s.user_id=? AND ${LIVE} ${extra} ORDER BY s.created DESC,s.rowid DESC`,
      )
      .all(user, t, t, ...args)
      .map(view);
  };

  app.get("/api/shares", requireUser, (req, res) => {
    const conversation = req.query.conversation;
    if (conversation !== undefined && typeof conversation !== "string")
      fail(400, "conversation must be a conversation id.", "invalid_request");
    res.json({
      data: conversation
        ? owned(req.user.id, "AND s.conversation_id=?", conversation)
        : owned(req.user.id),
      limits: {
        active: MAX_ACTIVE_SHARES,
        per_conversation: MAX_SHARES_PER_CONVERSATION,
      },
    });
  });

  app.post(
    "/api/shares",
    requireUser,
    limit("share_create", 30, 3600000),
    (req, res) => {
      const body = req.body;
      // Off the record and Private Mode are never saved, so there is no
      // conversation to copy, whatever else the request says.
      if (body.private === true)
        fail(400, SHARE_BLOCK_MESSAGES.private, "share_excluded");
      if (body.ephemeral === true)
        fail(400, SHARE_BLOCK_MESSAGES.off_record, "share_excluded");
      if (typeof body.conversationId !== "string" || !body.conversationId)
        fail(400, "conversationId must be a conversation id.", "invalid_request");
      const expiry = parseShareDays(body.expires_in_days);
      if (!expiry.ok)
        fail(
          400,
          "expires_in_days must be 1, 7, 30 or null (never).",
          "invalid_request",
        );
      if (body.title !== undefined && typeof body.title !== "string")
        fail(400, "title must be text.", "invalid_request");
      const created = transaction(db, () => {
        // Your own saved conversation (404 for anyone else's, an expired
        // one or one that doesn't exist).
        const c = ctx.conversations.accessConversation(
          body.conversationId,
          req.user.id,
        );
        // Shared collab conversations hold other members' messages.
        if (c.collab_id || c.user_id !== req.user.id)
          fail(400, SHARE_BLOCK_MESSAGES.collab, "share_collab");
        if (!SHAREABLE_MODES.includes(c.mode || "chat"))
          fail(400, SHARE_BLOCK_MESSAGES.mode, "share_mode");
        const rows = db
          .prepare(
            "SELECT role,content,model FROM messages WHERE conversation_id=? ORDER BY created,rowid",
          )
          .all(c.id);
        const messages = buildSnapshot(
          rows,
          (id) => ctx.models.find(id)?.name || id,
        );
        if (!messages.length)
          fail(400, "There's nothing to share in this conversation yet.", "share_empty");
        const snapshot = JSON.stringify(messages);
        if (messages.length > MAX_SHARE_MESSAGES || snapshot.length > MAX_SHARE_CHARS)
          fail(
            400,
            "This conversation is too long to share as one link.",
            "share_too_large",
          );
        const t = now();
        const active = (where, id) =>
          db
            .prepare(
              `SELECT COUNT(*) n ${FROM} WHERE ${where}=? AND ${LIVE}`,
            )
            .get(id, t, t).n;
        if (active("s.user_id", req.user.id) >= MAX_ACTIVE_SHARES)
          fail(
            400,
            `You can have up to ${MAX_ACTIVE_SHARES} active share links. Revoke one first.`,
            "share_limit",
          );
        if (active("s.conversation_id", c.id) >= MAX_SHARES_PER_CONVERSATION)
          fail(
            400,
            `A conversation can have up to ${MAX_SHARES_PER_CONVERSATION} active share links. Revoke one first.`,
            "share_limit",
          );
        const { expires } = shareExpiry(expiry.days, t, c.expires);
        const id = uid("share_"),
          token = randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
        db.prepare(
          "INSERT INTO share_links(id,user_id,conversation_id,token,title,snapshot,message_count,created,expires) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(
          id,
          req.user.id,
          c.id,
          token,
          title(body.title, c.title, rows),
          snapshot,
          messages.length,
          t,
          expires,
        );
        return { id, summary: snapshotSummary(messages) };
      });
      const [link] = owned(req.user.id, "AND s.id=?", created.id);
      res.status(201).json({
        ...link,
        withheld: created.summary.withheld,
        masked: created.summary.masked,
      });
    },
  );

  // Revoking deletes the snapshot: the link stops working at once.
  app.delete("/api/shares/:id", requireUser, (req, res) => {
    const r = db
      .prepare("DELETE FROM share_links WHERE id=? AND user_id=?")
      .run(req.params.id, req.user.id);
    if (!r.changes) fail(404, "Share link not found.", "not_found");
    res.json({ ok: true });
  });

  // The public snapshot. No sign-in; nothing about its owner.
  app.get("/api/s/:token", viewLimit, (req, res) => {
    privatePage(res);
    const s = published(req.params.token);
    if (!s) missing();
    res.json({
      title: s.title,
      created: s.created,
      messages: JSON.parse(s.snapshot),
    });
  });

  // The shared page itself: the web app, with the same headers, and the
  // same 404 for every link that isn't live.
  app.get("/s/:token", viewLimit, (req, res) => {
    privatePage(res);
    const status = published(req.params.token) ? 200 : 404;
    const index = resolve("dist/client/index.html");
    if (existsSync(index))
      res.status(status).sendFile("index.html", { root: resolve("dist/client") });
    else res.status(status).end();
  });
}
