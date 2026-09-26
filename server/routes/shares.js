import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { uid, now, fail, transaction } from "../core.js";
import { isReleased } from "../releases.js";
import {
  MAX_ACTIVE_SHARES,
  MAX_SHARES_PER_CONVERSATION,
  MAX_SEALED_BYTES,
  MAX_SEALED_TOTAL_BYTES,
  SEALED_IV_BYTES,
  SEALED_TAG_BYTES,
  SHAREABLE_MODES,
  SHARE_BLOCK_MESSAGES,
  SHARE_TOKEN,
  SHARE_TOKEN_BYTES,
  SNAPSHOT_PROBLEMS,
  buildSnapshot,
  parseShareDays,
  publishedTitle,
  shareExpiry,
  sharePath,
  snapshotProblem,
  snapshotSummary,
} from "../../src/share-links.js";

// Share a Chat (update "sharelinks"). An account publishes a read-only
// snapshot of one of its saved personal conversations at /s/<token>. The
// snapshot is copied once, at creation (src/share-links.js says what it
// holds); later messages never join it. The link is gone for everyone the
// moment it's revoked, when it expires, when its conversation is deleted or
// auto-deleted, and when the account closes; each of those looks exactly like
// a token that never existed. Share links are never listed anywhere public.
//
// Sealed Share (update "sealedshare") adds links the server can't read: the
// browser seals the snapshot with a key that stays in the link's #fragment
// and uploads only the ciphertext (sealed_shares). The same lifetimes,
// limits and revocation apply. A Device-only chat can be shared this way
// only, with no conversation on the server at all.
const MB = 1024 * 1024;
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
  const sealedLive = () => isReleased(cfg, "sealedshare");
  // Unknown, revoked, expired and deleted all look the same.
  const missing = () =>
    fail(404, "This shared conversation isn't available.", "share_not_found");
  // A link is live while it hasn't expired, its conversation still exists and
  // hasn't passed its auto-delete (treated as gone at once, as everywhere
  // else), and its account is open.
  const LIVE = `(s.expires IS NULL OR s.expires>?) AND (c.expires IS NULL OR c.expires>=?) AND c.collab_id IS NULL AND u.deleted IS NULL`;
  const FROM = `FROM share_links s JOIN conversations c ON c.id=s.conversation_id JOIN users u ON u.id=s.user_id`;
  // A sealed link goes by the same rules; a Device-only one has no
  // conversation, so only its own expiry and its account apply.
  const SEALED_LIVE = `(s.expires IS NULL OR s.expires>?) AND (s.conversation_id IS NULL OR (c.id IS NOT NULL AND (c.expires IS NULL OR c.expires>=?) AND c.collab_id IS NULL)) AND u.deleted IS NULL`;
  const SEALED_FROM = `FROM sealed_shares s LEFT JOIN conversations c ON c.id=s.conversation_id JOIN users u ON u.id=s.user_id`;
  function published(token) {
    if (typeof token !== "string" || !SHARE_TOKEN.test(token)) return null;
    const t = now();
    const open = db
      .prepare(`SELECT s.title,s.snapshot,s.message_count,s.created ${FROM} WHERE s.token=? AND ${LIVE}`)
      .get(token, t, t);
    if (open) return open;
    // Sealed links open only while Sealed Share is released.
    if (!sealedLive()) return null;
    const sealed = db
      .prepare(`SELECT s.ciphertext,s.created ${SEALED_FROM} WHERE s.token=? AND ${SEALED_LIVE}`)
      .get(token, t, t);
    return sealed ? { ...sealed, sealed: true } : null;
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
  // A sealed link as its owner sees it: no title and no message count (both
  // are inside the ciphertext), and an address without its key, which only
  // the link made when it was shared holds.
  const sealedView = (s) => ({
    ...view({ ...s, title: null, message_count: null }),
    sealed: true,
    device_only: s.conversation_id == null,
    bytes: s.bytes,
  });
  const owned = (user, extra = "", ...args) => {
    const t = now();
    const open = db
      .prepare(
        `SELECT s.id,s.token,s.title,s.conversation_id,s.message_count,s.created,s.expires,c.title conversation_title,c.expires conversation_expires ${FROM} WHERE s.user_id=? AND ${LIVE} ${extra} ORDER BY s.created DESC,s.rowid DESC`,
      )
      .all(user, t, t, ...args)
      .map(view);
    const sealed = db
      .prepare(
        `SELECT s.id,s.token,s.conversation_id,length(s.ciphertext) bytes,s.created,s.expires,c.title conversation_title,c.expires conversation_expires ${SEALED_FROM} WHERE s.user_id=? AND ${SEALED_LIVE} ${extra} ORDER BY s.created DESC,s.rowid DESC`,
      )
      .all(user, t, t, ...args)
      .map(sealedView);
    return [...open, ...sealed].sort((a, b) => b.created - a.created);
  };
  // Live links, sealed or not, for an account or a conversation.
  const activeCount = (column, id, t) =>
    db.prepare(`SELECT COUNT(*) n ${FROM} WHERE ${column}=? AND ${LIVE}`).get(id, t, t).n +
    db.prepare(`SELECT COUNT(*) n ${SEALED_FROM} WHERE ${column}=? AND ${SEALED_LIVE}`).get(id, t, t).n;
  function checkLimits(user, conversation, t) {
    if (activeCount("s.user_id", user, t) >= MAX_ACTIVE_SHARES)
      fail(
        400,
        `You can have up to ${MAX_ACTIVE_SHARES} active share links. Revoke one first.`,
        "share_limit",
      );
    if (conversation && activeCount("s.conversation_id", conversation, t) >= MAX_SHARES_PER_CONVERSATION)
      fail(
        400,
        `A conversation can have up to ${MAX_SHARES_PER_CONVERSATION} active share links. Revoke one first.`,
        "share_limit",
      );
  }
  // The snapshot of one of your own saved personal conversations, as a link
  // publishes it, or the reason it can't be shared.
  function snapshotOf(user, conversationId, askedTitle) {
    // Your own saved conversation (404 for anyone else's, an expired one or
    // one that doesn't exist).
    const c = ctx.conversations.accessConversation(conversationId, user);
    // Shared collab conversations hold other members' messages.
    if (c.collab_id || c.user_id !== user)
      fail(400, SHARE_BLOCK_MESSAGES.collab, "share_collab");
    if (!SHAREABLE_MODES.includes(c.mode || "chat"))
      fail(400, SHARE_BLOCK_MESSAGES.mode, "share_mode");
    const rows = db
      .prepare(
        "SELECT role,content,model FROM messages WHERE conversation_id=? ORDER BY created,rowid",
      )
      .all(c.id);
    const messages = buildSnapshot(rows, (id) => ctx.models.find(id)?.name || id);
    const problem = snapshotProblem(messages);
    if (problem) fail(400, SNAPSHOT_PROBLEMS[problem], problem);
    return { c, messages, title: publishedTitle(askedTitle, c.title, rows) };
  }
  // Off the record and Private Mode are never saved, so there is no
  // conversation to copy, whatever else the request says.
  function excluded(body) {
    if (body.private === true)
      fail(400, SHARE_BLOCK_MESSAGES.private, "share_excluded");
    if (body.ephemeral === true)
      fail(400, SHARE_BLOCK_MESSAGES.off_record, "share_excluded");
  }
  // The uploaded ciphertext: canonical base64url of the IV, the AES-GCM
  // ciphertext and its tag, within the size cap.
  function ciphertextOf(value) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9_-]+$/.test(value) ||
      value.length % 4 === 1
    )
      fail(400, "ciphertext must be base64url text.", "invalid_request");
    if (value.length > Math.ceil((MAX_SEALED_BYTES * 4) / 3))
      fail(
        400,
        `This conversation is too long to share as one sealed link (${MAX_SEALED_BYTES / MB} MB at most).`,
        "share_too_large",
      );
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value)
      fail(400, "ciphertext must be base64url text.", "invalid_request");
    if (bytes.length < SEALED_IV_BYTES + SEALED_TAG_BYTES + 1)
      fail(400, "ciphertext is too short to be a sealed snapshot.", "invalid_request");
    if (bytes.length > MAX_SEALED_BYTES)
      fail(
        400,
        `This conversation is too long to share as one sealed link (${MAX_SEALED_BYTES / MB} MB at most).`,
        "share_too_large",
      );
    return bytes;
  }

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

  // Sealed Share: the snapshot a sealed link of this conversation would hold,
  // for the owner's browser to seal. Nothing is stored. (The server already
  // holds this conversation; it's the copy behind the link it can't read.)
  app.post(
    "/api/shares/draft",
    requireUser,
    limit("share_draft", 60, 3600000),
    (req, res) => {
      const body = req.body;
      excluded(body);
      if (typeof body.conversationId !== "string" || !body.conversationId)
        fail(400, "conversationId must be a conversation id.", "invalid_request");
      if (body.title !== undefined && typeof body.title !== "string")
        fail(400, "title must be text.", "invalid_request");
      const { title, messages } = snapshotOf(req.user.id, body.conversationId, body.title);
      const summary = snapshotSummary(messages);
      res.json({ title, messages, withheld: summary.withheld, masked: summary.masked });
    },
  );

  app.post(
    "/api/shares",
    requireUser,
    limit("share_create", 30, 3600000),
    (req, res) => {
      const body = req.body;
      excluded(body);
      if (body.sealed !== undefined && typeof body.sealed !== "boolean")
        fail(400, "sealed must be true or false.", "invalid_request");
      if (body.device !== undefined && typeof body.device !== "boolean")
        fail(400, "device must be true or false.", "invalid_request");
      const sealed = body.sealed === true,
        device = body.device === true;
      // A Device-only chat was never on the server, and never arrives here
      // readable: it can only be shared sealed.
      if (device && !sealed)
        fail(400, SHARE_BLOCK_MESSAGES.device_unsealed, "share_device_sealed");
      if (!sealed && body.ciphertext !== undefined)
        fail(400, "ciphertext needs sealed: true.", "invalid_request");
      if (device ? body.conversationId !== undefined : typeof body.conversationId !== "string" || !body.conversationId)
        fail(
          400,
          device
            ? "A Device-only share has no conversationId."
            : "conversationId must be a conversation id.",
          "invalid_request",
        );
      const expiry = parseShareDays(body.expires_in_days);
      if (!expiry.ok)
        fail(
          400,
          "expires_in_days must be 1, 7, 30 or null (never).",
          "invalid_request",
        );
      if (body.title !== undefined && (sealed || typeof body.title !== "string"))
        fail(
          400,
          sealed
            ? "A sealed link's title is sealed inside it: don't send it."
            : "title must be text.",
          "invalid_request",
        );
      if (sealed) {
        const bytes = ciphertextOf(body.ciphertext);
        const id = transaction(db, () => {
          const t = now();
          let conversation = null;
          if (!device) {
            // The same checks as an open link: your own saved personal chat,
            // code or uncensored conversation with something in it.
            const c = snapshotOf(req.user.id, body.conversationId).c;
            conversation = c;
          }
          checkLimits(req.user.id, conversation?.id, t);
          const held = db
            .prepare(
              `SELECT COALESCE(SUM(length(s.ciphertext)),0) n ${SEALED_FROM} WHERE s.user_id=? AND ${SEALED_LIVE}`,
            )
            .get(req.user.id, t, t).n;
          if (held + bytes.length > MAX_SEALED_TOTAL_BYTES)
            fail(
              400,
              `Your sealed links can hold up to ${MAX_SEALED_TOTAL_BYTES / MB} MB in all. Revoke one first.`,
              "share_limit",
            );
          const { expires } = shareExpiry(expiry.days, t, conversation?.expires ?? null);
          const id = uid("share_"),
            token = randomBytes(SHARE_TOKEN_BYTES).toString("base64url");
          db.prepare(
            "INSERT INTO sealed_shares(id,user_id,conversation_id,token,ciphertext,created,expires) VALUES(?,?,?,?,?,?,?)",
          ).run(id, req.user.id, conversation?.id ?? null, token, bytes, t, expires);
          return id;
        });
        const [link] = owned(req.user.id, "AND s.id=?", id);
        return res.status(201).json(link);
      }
      const created = transaction(db, () => {
        const { c, messages, title } = snapshotOf(
          req.user.id,
          body.conversationId,
          body.title,
        );
        const t = now();
        checkLimits(req.user.id, c.id, t);
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
          title,
          JSON.stringify(messages),
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

  // Revoking deletes the snapshot (or its ciphertext): the link stops
  // working at once.
  app.delete("/api/shares/:id", requireUser, (req, res) => {
    const r = db
      .prepare("DELETE FROM share_links WHERE id=? AND user_id=?")
      .run(req.params.id, req.user.id);
    const sealed = r.changes
      ? r
      : db
          .prepare("DELETE FROM sealed_shares WHERE id=? AND user_id=?")
          .run(req.params.id, req.user.id);
    if (!sealed.changes) fail(404, "Share link not found.", "not_found");
    res.json({ ok: true });
  });

  // The public snapshot. No sign-in; nothing about its owner. A sealed one
  // is only its ciphertext and date: the page opens it with the key from its
  // link, which this request never carries.
  app.get("/api/s/:token", viewLimit, (req, res) => {
    privatePage(res);
    const s = published(req.params.token);
    if (!s) missing();
    if (s.sealed)
      return res.json({
        sealed: true,
        created: s.created,
        ciphertext: Buffer.from(s.ciphertext).toString("base64url"),
      });
    res.json({
      title: s.title,
      created: s.created,
      messages: JSON.parse(s.snapshot),
    });
  });

  // The shared page itself: the web app, with the same headers, and the
  // same 404 for every link that isn't live. Once Sealed Share is released,
  // an open (unsealed) link's page carries its title for link previews; a
  // sealed one carries nothing about what's inside.
  app.get("/s/:token", viewLimit, (req, res) => {
    privatePage(res);
    const s = published(req.params.token);
    const status = s ? 200 : 404;
    const index = resolve("dist/client/index.html");
    if (!existsSync(index)) return res.status(status).end();
    if (s && !s.sealed && sealedLive())
      return res
        .status(200)
        .type("html")
        .send(withPreview(readFileSync(index, "utf8"), s));
    res.status(status).sendFile("index.html", { root: resolve("dist/client") });
  });
}

// An open link's page with its title and message count in the tags link
// previews read. Nothing else from the snapshot.
const escapeHtml = (text) =>
  String(text).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );
export function withPreview(html, share) {
  const title = escapeHtml(share.title);
  const description = escapeHtml(
    share.message_count === 1
      ? "A read-only snapshot of 1 message, shared from ANONYMA."
      : `A read-only snapshot of ${share.message_count} messages, shared from ANONYMA.`,
  );
  const tags =
    `<meta property="og:type" content="website"/>` +
    `<meta property="og:site_name" content="ANONYMA"/>` +
    `<meta property="og:title" content="${title}"/>` +
    `<meta property="og:description" content="${description}"/>` +
    `<meta name="twitter:card" content="summary"/>` +
    `<meta name="robots" content="noindex, nofollow"/>`;
  return html
    .replace(/<title>[^<]*<\/title>/, () => `<title>${title} · ANONYMA</title>`)
    .replace(
      /<meta name="description" content="[^"]*"\s*\/?>/,
      () => `<meta name="description" content="${description}"/>`,
    )
    .replace("</head>", () => tags + "</head>");
}
