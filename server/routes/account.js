import { sessionCookieOptions } from "../auth.js";
import { exportConversations } from "./conversations.js";
import { HOLDER_RESET } from "../holders.js";
import {
  uid,
  hash,
  now,
  fail,
  credits,
  keySpend24h,
  keySpendTotal,
  transaction,
} from "../core.js";
import {
  OPEN_PAYMENT_STATUSES,
  UNCONFIRMED_INVOICE_STATUSES,
  sqlList,
} from "../payments.js";
import {
  deliverSupport,
  supportConfigured,
  validSupportEmail,
} from "../support.js";

// Ledger, API keys, support tickets, data export and account closure.
export function accountRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, publicUser } = ctx;
  const { mediaJSON, deleteMedia } = ctx.media;
  app.get("/api/account/ledger", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT l.*,k.name key_name,k.connection_id,h.result receipt_json FROM ledger l LEFT JOIN api_keys k ON k.id=l.key_id LEFT JOIN holds h ON h.id=l.ref WHERE l.user_id=? ORDER BY l.created DESC LIMIT 50",
        )
        .all(req.user.id)
        .map(({ receipt_json, connection_id, ...v }) => ({
          ...v,
          // Spent by a connected app rather than an API key.
          ...(connection_id ? { connected_app: true } : {}),
          amount: credits(v.amount),
          receipt: receipt_json ? JSON.parse(receipt_json) : null,
        })),
      balance: publicUser(req.user),
    }),
  );
  // Spending for the dashboard: the last 14 local days, split by kind, plus
  // this week against the week before. Only settled usage counts (ledger rows
  // tied to a hold); deposits, transfers and referral rewards don't.
  app.get("/api/account/summary", requireUser, (req, res) => {
    const DAY = 86400000;
    const tz = Math.max(
      -840,
      Math.min(840, Math.trunc(Number(req.query.tz) || 0)),
    );
    const shift = tz * 60000;
    const today = Math.floor((now() - shift) / DAY);
    const from = (today - 13) * DAY + shift;
    const rows = db
      .prepare(
        "SELECT l.amount,l.ref,l.created,h.kind FROM ledger l JOIN holds h ON h.id=l.ref WHERE l.user_id=? AND l.created>=?",
      )
      .all(req.user.id, from);
    const days = Array.from({ length: 14 }, (_, i) => ({
      date: new Date((today - 13 + i) * DAY).toISOString().slice(0, 10),
      spent: 0,
    }));
    const kinds = {};
    const week = { spent: 0, previous: 0, requests: 0, byKind: {} };
    const counted = new Set();
    for (const r of rows) {
      const i = Math.floor((r.created - shift) / DAY) - (today - 13);
      if (i < 0 || i > 13) continue;
      const kind = r.kind || "chat";
      days[i].spent -= r.amount;
      (kinds[kind] ||= { kind, spent: 0, requests: 0 }).spent -= r.amount;
      if (i >= 7) week.spent -= r.amount;
      else week.previous -= r.amount;
      if (r.amount < 0 && !counted.has(r.ref)) {
        counted.add(r.ref);
        kinds[kind].requests++;
        if (i >= 7) {
          week.requests++;
          week.byKind[kind] = (week.byKind[kind] || 0) + 1;
        }
      }
    }
    res.json({
      days: days.map((d) => ({ ...d, spent: credits(d.spent) })),
      byKind: Object.values(kinds)
        .map((k) => ({ ...k, spent: credits(k.spent) }))
        .sort((a, b) => b.spent - a.spent),
      week: {
        ...week,
        spent: credits(week.spent),
        previous: credits(week.previous),
      },
      balance: publicUser(req.user),
    });
  });
  app.get("/api/keys", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT id,name,prefix,cap,created,revoked,last_used,allowance_total,allowance_expires,paused_at,agent_label FROM api_keys WHERE user_id=? AND connection_id IS NULL ORDER BY created DESC",
        )
        .all(req.user.id)
        .map(
          ({
            allowance_total,
            allowance_expires,
            paused_at,
            agent_label,
            ...k
          }) => {
            const spentTotal = keySpendTotal(db, k.id);
            const held = db
              .prepare(
                "SELECT COALESCE(SUM(amount),0) n FROM holds WHERE key_id=? AND status='held'",
              )
              .get(k.id).n;
            return {
              ...k,
              cap: k.cap == null ? null : credits(k.cap),
              spent: credits(keySpend24h(db, k.id)),
              label: agent_label,
              paused: paused_at != null,
              expires_at: allowance_expires,
              allowance_total:
                allowance_total == null ? null : credits(allowance_total),
              allowance_spent: credits(spentTotal),
              allowance_remaining:
                allowance_total == null
                  ? null
                  : credits(Math.max(0, allowance_total - spentTotal - held)),
            };
          },
        ),
    }),
  );
  app.post("/api/keys", requireUser, limit("keys", 10, 3600000), (req, res) => {
    if (
      db
        .prepare(
          "SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND revoked IS NULL AND connection_id IS NULL",
        )
        .get(req.user.id).n >= 20
    )
      fail(400, "Maximum 20 active API keys.");
    if (
      db
        .prepare(
          "SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND created>? AND connection_id IS NULL",
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
        "UPDATE api_keys SET revoked=? WHERE id=? AND user_id=? AND revoked IS NULL AND connection_id IS NULL",
      )
      .run(now(), req.params.id, req.user.id);
    if (!r.changes) fail(404, "Key not found.");
    res.json({ ok: true });
  });
  app.post("/api/support", limit("support", 5, 3600000), async (req, res) => {
    const subject = String(req.body.subject || ""),
      body = String(req.body.body || "");
    if (
      !subject.trim() ||
      subject.length > 200 ||
      !body.trim() ||
      body.length > 10000
    )
      fail(400, "Include a subject and a message (up to 10,000 characters).");
    const email = String(req.body.email || req.user?.email || "").trim();
    if (!validSupportEmail(email))
      fail(400, "Include a valid email address so support can reply.");
    if (!supportConfigured(cfg) && !cfg.testMode)
      fail(
        503,
        "Support email is temporarily unavailable. Your message has not been sent.",
        "support_unavailable",
      );
    const id = uid("ticket_");
    db.prepare(
      "INSERT INTO tickets(id,user_id,subject,body,created,email) VALUES(?,?,?,?,?,?)",
    ).run(id, req.user?.id || null, subject, body, now(), email);
    const delivery = await deliverSupport(db, cfg, id);
    res.status(delivery === "failed" ? 202 : 201).json({
      id,
      delivery,
      message:
        delivery === "accepted"
          ? `Support request ${id} sent. Keep this reference for follow-up.`
          : delivery === "failed"
            ? `Request ${id} saved, but email delivery failed. Contact support directly and include this reference.`
            : `Test ticket ${id} saved locally. No email was sent.`,
    });
  });
  app.get("/api/account/export", requireUser, (req, res) =>
    res.attachment("anonyma-account.json").json({
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      units: {
        ledgerAmount: "integer subcredits (10000 = 1 credit)",
        depositAmount: "USD",
        keyCap: "credits",
        mediaCost: "credits",
        requestAmount: "integer subcredits",
      },
      user: publicUser(req.user),
      ledger: db
        .prepare("SELECT * FROM ledger WHERE user_id=? ORDER BY created,rowid")
        .all(req.user.id),
      deposits: db
        .prepare(
          "SELECT * FROM deposits WHERE user_id=? ORDER BY created,rowid",
        )
        .all(req.user.id)
        .map((d) => ({
          ...d,
          amount: d.amount / 1e7,
          payload: JSON.parse(d.payload || "null"),
        })),
      keys: db
        .prepare(
          "SELECT id,name,prefix,cap,created,revoked,last_used,agent_label,allowance_total,allowance_expires,paused_at,connection_id FROM api_keys WHERE user_id=?",
        )
        .all(req.user.id)
        .map((k) => ({
          ...k,
          cap: k.cap == null ? null : credits(k.cap),
          allowance_total:
            k.allowance_total == null ? null : credits(k.allowance_total),
        })),
      sessions: db
        .prepare(
          "SELECT created,expires FROM sessions WHERE user_id=? AND expires>?",
        )
        .all(req.user.id, now()),
      connectedApps: db
        .prepare(
          "SELECT id,key_id,name,client_name,redirect_uri,private_only,created,activated,expires,revoked FROM oauth_connections WHERE user_id=?",
        )
        .all(req.user.id),
      supportRequests: db
        .prepare(
          "SELECT id,subject,body,email,created,delivery,delivered_at FROM tickets WHERE user_id=?",
        )
        .all(req.user.id),
      requests: db
        .prepare("SELECT * FROM holds WHERE user_id=? ORDER BY created,rowid")
        .all(req.user.id),
      videos: db
        .prepare(
          "SELECT id,status,request,error,media_id,created,updated FROM videos WHERE user_id=?",
        )
        .all(req.user.id)
        .map((v) => ({ ...v, request: JSON.parse(v.request || "null") })),
      holderRewards: db
        .prepare(
          "SELECT cycle_start,paid,tier,amount,bonus FROM holder_rewards WHERE user_id=? ORDER BY paid",
        )
        .all(req.user.id)
        .map((r) => ({ ...r, amount: credits(r.amount), bonus: !!r.bonus })),
      roadmapVotes: db
        .prepare(
          "SELECT month,update_id,created,updated FROM roadmap_votes WHERE user_id=? ORDER BY month",
        )
        .all(req.user.id),
      collaborations: db
        .prepare(
          "SELECT c.id,c.name,c.created,m.role,m.joined FROM collabs c JOIN collab_members m ON c.id=m.collab_id WHERE m.user_id=?",
        )
        .all(req.user.id),
      conversations: exportConversations(db, req.user.id),
      // Own contributions remain exportable after leaving a shared workspace,
      // without disclosing its other members' content or current metadata.
      ownSharedMessages: db
        .prepare(
          "SELECT m.* FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE m.author_id=? AND c.collab_id IS NOT NULL ORDER BY m.created,m.rowid",
        )
        .all(req.user.id)
        .map((m) => ({ ...m, content: JSON.parse(m.content) })),
      media: db
        .prepare("SELECT * FROM media WHERE user_id=?")
        .all(req.user.id)
        .map(mediaJSON),
      scrolls: db
        .prepare("SELECT * FROM scrolls WHERE user_id=?")
        .all(req.user.id),
      instructions:
        db
          .prepare("SELECT * FROM user_instructions WHERE user_id=?")
          .get(req.user.id) || null,
      // Memory Across Models: the on/off choice and every saved fact.
      memory: {
        enabled: !!db
          .prepare("SELECT enabled FROM memory_settings WHERE user_id=?")
          .get(req.user.id)?.enabled,
        facts: db
          .prepare(
            "SELECT id,text,enabled,source_conversation_id,created,updated FROM memory_facts WHERE user_id=? ORDER BY created,rowid",
          )
          .all(req.user.id)
          .map((f) => ({ ...f, enabled: !!f.enabled })),
      },
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
    // Owned collabs' Team Treasuries must be empty: members' credits never
    // disappear with the owner's account.
    ctx.treasury.assertOwnedEmpty(req.user.id);
    for (const m of db
      .prepare("SELECT * FROM media WHERE user_id=?")
      .all(req.user.id))
      deleteMedia(m);
    transaction(db, () => {
      // Checked again with the deletion, atomically; a database trigger
      // backs this up (see the Team Treasury migration).
      ctx.treasury.assertOwnedEmpty(req.user.id);
      // Owned collabs go (with their shared conversations); in other
      // collabs the member leaves and their messages stay, unattributed.
      db.prepare("DELETE FROM collabs WHERE owner_id=?").run(req.user.id);
      db.prepare("DELETE FROM collab_members WHERE user_id=?").run(req.user.id);
      db.prepare(
        "DELETE FROM conversations WHERE user_id=? AND collab_id IS NULL",
      ).run(req.user.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.id);
      db.prepare(
        "UPDATE api_keys SET revoked=?,hash=NULL,name='Deleted account',prefix=NULL,agent_label=NULL WHERE user_id=?",
      ).run(now(), req.user.id);
      // Connected apps lose their tokens and pending codes with the account.
      db.prepare(
        "DELETE FROM oauth_tokens WHERE connection_id IN (SELECT id FROM oauth_connections WHERE user_id=?)",
      ).run(req.user.id);
      db.prepare(
        "DELETE FROM oauth_codes WHERE connection_id IN (SELECT id FROM oauth_connections WHERE user_id=?)",
      ).run(req.user.id);
      db.prepare(
        "UPDATE oauth_connections SET revoked=COALESCE(revoked,?),name='Deleted account',client_name='',redirect_uri='' WHERE user_id=?",
      ).run(now(), req.user.id);
      db.prepare(
        "DELETE FROM challenges WHERE target IN (?,?) OR payload=?",
      ).run(req.user.email || "", req.user.wallet || "", req.user.id);
      db.prepare("DELETE FROM tickets WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM videos WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM scrolls WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM user_instructions WHERE user_id=?").run(
        req.user.id,
      );
      db.prepare("DELETE FROM memory_facts WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM memory_settings WHERE user_id=?").run(req.user.id);
      // NYMA Holder Program: votes go; paid cycles stay with the ledger.
      db.prepare("DELETE FROM roadmap_votes WHERE user_id=?").run(req.user.id);
      db.prepare(
        `UPDATE users SET username=NULL,password=NULL,email=NULL,wallet=NULL,${HOLDER_RESET},deleted=? WHERE id=?`,
      ).run(now(), req.user.id);
    });
    res
      .clearCookie("anonyma_session", sessionCookieOptions(cfg))
      .json({ ok: true });
  });
}
