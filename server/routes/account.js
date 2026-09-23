import {
  uid,
  hash,
  now,
  fail,
  credits,
  keySpend24h,
  transaction,
} from "../core.js";
import {
  OPEN_PAYMENT_STATUSES,
  UNCONFIRMED_INVOICE_STATUSES,
  sqlList,
} from "../payments.js";

// Ledger, API keys, support tickets, data export and account closure.
export function accountRoutes(ctx) {
  const { app, db, limit, requireUser, publicUser } = ctx;
  const { mediaJSON, deleteMedia } = ctx.media;
  app.get("/api/account/ledger", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT l.*,k.name key_name,h.result receipt_json FROM ledger l LEFT JOIN api_keys k ON k.id=l.key_id LEFT JOIN holds h ON h.id=l.ref WHERE l.user_id=? ORDER BY l.created DESC LIMIT 50",
        )
        .all(req.user.id)
        .map(({ receipt_json, ...v }) => ({
          ...v,
          amount: credits(v.amount),
          receipt: receipt_json ? JSON.parse(receipt_json) : null,
        })),
      balance: publicUser(req.user),
    }),
  );
  app.get("/api/keys", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT id,name,prefix,cap,created,revoked,last_used FROM api_keys WHERE user_id=? ORDER BY created DESC",
        )
        .all(req.user.id)
        .map((k) => ({
          ...k,
          cap: k.cap == null ? null : credits(k.cap),
          spent: credits(keySpend24h(db, k.id)),
        })),
    }),
  );
  app.post("/api/keys", requireUser, limit("keys", 10, 3600000), (req, res) => {
    if (
      db
        .prepare(
          "SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND revoked IS NULL",
        )
        .get(req.user.id).n >= 20
    )
      fail(400, "Maximum 20 active API keys.");
    if (
      db
        .prepare(
          "SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND created>?",
        )
        .get(req.user.id, now() - 3600000).n >= 10
    )
      fail(429, "Maximum ten key creations per hour.");
    const name = String(req.body.name || "Untitled key").slice(0, 60);
    const cap =
      req.body.cap == null || req.body.cap === "" ? null : Number(req.body.cap);
    if (cap != null && (!Number.isFinite(cap) || cap < 0 || cap > 1e9))
      fail(400, "Invalid credit cap.");
    const secret = uid("anonyma_live_") + uid();
    const id = uid("key_");
    db.prepare(
      "INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created,revoked,last_used) VALUES(?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      req.user.id,
      hash(secret),
      name,
      secret.slice(0, 20),
      cap == null ? null : Math.floor(cap * 10000),
      now(),
      null,
      null,
    );
    res.status(201).json({
      id,
      key: secret,
      name,
      message: "Copy this key now. It will never be shown again.",
    });
  });
  app.delete("/api/keys/:id", requireUser, (req, res) => {
    const r = db
      .prepare(
        "UPDATE api_keys SET revoked=? WHERE id=? AND user_id=? AND revoked IS NULL",
      )
      .run(now(), req.params.id, req.user.id);
    if (!r.changes) fail(404, "Key not found.");
    res.json({ ok: true });
  });
  app.post(
    "/api/support",
    requireUser,
    limit("support", 5, 3600000),
    (req, res) => {
      const subject = String(req.body.subject || ""),
        body = String(req.body.body || "");
      if (
        !subject.trim() ||
        subject.length > 200 ||
        !body.trim() ||
        body.length > 10000
      )
        fail(400, "Include a subject and a message (up to 10,000 characters).");
      const id = uid("ticket_");
      db.prepare(
        "INSERT INTO tickets(id,user_id,subject,body,created) VALUES(?,?,?,?,?)",
      ).run(id, req.user.id, subject, body, now());
      res.status(201).json({
        id,
        message:
          "Saved for this installation’s operator. No external message has been sent.",
      });
    },
  );
  app.get("/api/account/export", requireUser, (req, res) =>
    res.attachment("anonyma-account.json").json({
      user: publicUser(req.user),
      ledger: db
        .prepare("SELECT * FROM ledger WHERE user_id=?")
        .all(req.user.id),
      conversations: db
        .prepare("SELECT * FROM conversations WHERE user_id=?")
        .all(req.user.id)
        .map((c) => ({
          ...c,
          messages: db
            .prepare("SELECT * FROM messages WHERE conversation_id=?")
            .all(c.id),
        })),
      media: db
        .prepare("SELECT * FROM media WHERE user_id=?")
        .all(req.user.id)
        .map(mediaJSON),
    }),
  );
  app.delete("/api/account", requireUser, (req, res) => {
    if (req.body.confirm !== "DELETE")
      fail(
        400,
        "Type DELETE to confirm closure and forfeiture of unused credits.",
      );
    if (
      db
        .prepare("SELECT id FROM holds WHERE user_id=? AND status='held'")
        .get(req.user.id)
    )
      fail(
        409,
        "Wait for pending requests and payment reconciliation before closing the account.",
      );
    if (
      db
        .prepare(
          `SELECT id FROM deposits WHERE user_id=? AND status IN (${sqlList([...UNCONFIRMED_INVOICE_STATUSES, ...OPEN_PAYMENT_STATUSES])})`,
        )
        .get(req.user.id)
    )
      fail(
        409,
        "Resolve pending payment invoices before closing this account.",
      );
    for (const m of db
      .prepare("SELECT * FROM media WHERE user_id=?")
      .all(req.user.id))
      deleteMedia(m);
    transaction(db, () => {
      db.prepare("DELETE FROM conversations WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.id);
      db.prepare("UPDATE api_keys SET revoked=? WHERE user_id=?").run(
        now(),
        req.user.id,
      );
      db.prepare(
        "DELETE FROM challenges WHERE target IN (?,?) OR payload=?",
      ).run(req.user.email || "", req.user.wallet || "", req.user.id);
      db.prepare("DELETE FROM tickets WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM videos WHERE user_id=?").run(req.user.id);
      db.prepare(
        "UPDATE users SET username=NULL,password=NULL,email=NULL,wallet=NULL,token_balance='0',token_since=NULL,deleted=? WHERE id=?",
      ).run(now(), req.user.id);
    });
    res.clearCookie("anonyma_session", { path: "/" }).json({ ok: true });
  });
}
