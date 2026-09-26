import { sessionCookieOptions } from "../auth.js";
import { exportConversations } from "./conversations.js";
import { HOLDER_RESET } from "../holders.js";
import { limitsView } from "../spending-limits.js";
import { exportRoutines, forgetRoutines } from "../routines.js";
import { exportProjects } from "./projects.js";
import { alertsLive, exportAlert, forgetAlert } from "../balance-alerts.js";
import { isReleased } from "../releases.js";
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

// What account closure and Panic Wipe (routes/wipe.js) both erase, inside
// the caller's transaction:
// - collabs the account owns, with their shared conversations (the caller
//   checks their Team Treasuries are empty first);
// - its membership of other collabs, whose shared messages stay;
// - share links, sealed ones too (Device-only ones included), then personal
//   conversations and their messages (Symposium runs, branches and
//   Double-checks are conversations too);
// - every session and pending sign-in code (and sign-in waiting for a
//   two-step code);
// - connected apps' tokens and pending codes;
// - projects, with their filed chats and pinned files (the chats go with
//   the conversations above);
// - support requests, video jobs, saved uploads, Scrolls, standing
//   instructions and memory facts;
// - saved media rows. Their files can't join a transaction, so the caller
//   removes them first (deleteMedia or removeMediaFile).
// The ledger, deposits, request records, receipts and the account row are
// the caller's to keep or change.
export function eraseAccountContent(db, user) {
  const id = user.id;
  db.prepare("DELETE FROM collabs WHERE owner_id=?").run(id);
  db.prepare("DELETE FROM collab_members WHERE user_id=?").run(id);
  db.prepare("DELETE FROM share_links WHERE user_id=?").run(id);
  db.prepare("DELETE FROM sealed_shares WHERE user_id=?").run(id);
  db.prepare(
    "DELETE FROM conversations WHERE user_id=? AND collab_id IS NULL",
  ).run(id);
  // Projects: their filed chats and pins go with them.
  db.prepare("DELETE FROM project_chats WHERE user_id=?").run(id);
  db.prepare("DELETE FROM project_files WHERE user_id=?").run(id);
  db.prepare("DELETE FROM projects WHERE user_id=?").run(id);
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(id);
  // Sign-ins waiting for a two-step code, and sessions' "confirm it's you"
  // marks. The two-step setting itself is the caller's to keep (Panic Wipe)
  // or delete (closure).
  db.prepare("DELETE FROM two_step_pending WHERE user_id=?").run(id);
  db.prepare("DELETE FROM two_step_reauth WHERE user_id=?").run(id);
  db.prepare(
    "DELETE FROM oauth_tokens WHERE connection_id IN (SELECT id FROM oauth_connections WHERE user_id=?)",
  ).run(id);
  db.prepare(
    "DELETE FROM oauth_codes WHERE connection_id IN (SELECT id FROM oauth_connections WHERE user_id=?)",
  ).run(id);
  db.prepare("DELETE FROM challenges WHERE target IN (?,?) OR payload=?").run(
    user.email || "",
    user.wallet || "",
    id,
  );
  db.prepare("DELETE FROM tickets WHERE user_id=?").run(id);
  db.prepare("DELETE FROM videos WHERE user_id=?").run(id);
  db.prepare("DELETE FROM uploads WHERE user_id=?").run(id);
  db.prepare("DELETE FROM scrolls WHERE user_id=?").run(id);
  db.prepare("DELETE FROM user_instructions WHERE user_id=?").run(id);
  db.prepare("DELETE FROM memory_facts WHERE user_id=?").run(id);
  // Routines and their inbox. A run already picked up is refused by its
  // reservation, which finds the routine gone.
  forgetRoutines(db, id);
  db.prepare("DELETE FROM media WHERE user_id=?").run(id);
}

// Ledger, API keys, support tickets, data export and account closure.
export function accountRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, publicUser } = ctx;
  // Spending Limits: the limits in force, pending changes and usage.
  const exportLimits = (user) =>
    db.prepare("SELECT 1 FROM spending_limits WHERE user_id=?").get(user)
      ? limitsView(db, user)
      : null;
  // Low-Balance Alerts: the alert level and notification choice, once the
  // update is live or while one is set (null when the alert is off).
  function balanceAlertExport(user) {
    const alert = exportAlert(db, user);
    return alert || alertsLive(cfg) ? { balanceAlert: alert } : {};
  }
  const { mediaJSON, deleteMedia } = ctx.media;
  function shareLinksExport(user) {
    const t = now();
    const links = db
      .prepare(
        `SELECT s.id,s.conversation_id,s.token,s.title,s.message_count,s.created,s.expires FROM share_links s JOIN conversations c ON c.id=s.conversation_id
         WHERE s.user_id=? AND (s.expires IS NULL OR s.expires>?) AND (c.expires IS NULL OR c.expires>=?) ORDER BY s.created,s.rowid`,
      )
      .all(user, t, t)
      .map(({ token, message_count, ...s }) => ({
        ...s,
        url: String(cfg.publicUrl || cfg.origin).replace(/\/+$/, "") + "/s/" + token,
        messages: message_count,
      }));
    return {
      ...(links.length || isReleased(cfg, "sharelinks") ? { shareLinks: links } : {}),
      ...sealedSharesExport(user, t),
    };
  }
  // Sealed Share: each live sealed link's address (without its key, which
  // only the link itself holds), dates and the ciphertext exactly as stored.
  function sealedSharesExport(user, t) {
    const links = db
      .prepare(
        `SELECT s.id,s.conversation_id,s.token,s.ciphertext,s.created,s.expires FROM sealed_shares s LEFT JOIN conversations c ON c.id=s.conversation_id
         WHERE s.user_id=? AND (s.expires IS NULL OR s.expires>?) AND (s.conversation_id IS NULL OR (c.id IS NOT NULL AND (c.expires IS NULL OR c.expires>=?)))
         ORDER BY s.created,s.rowid`,
      )
      .all(user, t, t)
      .map(({ token, ciphertext, ...s }) => ({
        ...s,
        device_only: s.conversation_id == null,
        url: String(cfg.publicUrl || cfg.origin).replace(/\/+$/, "") + "/s/" + token,
        ciphertext: Buffer.from(ciphertext).toString("base64url"),
      }));
    return links.length || isReleased(cfg, "sealedshare")
      ? { sealedShares: links }
      : {};
  }
  function projectsExport(user) {
    const projects = exportProjects(db, user);
    return projects.length || isReleased(cfg, "projects") ? { projects } : {};
  }
  // Two-Step Sign-in: only whether it's on (once the update is live, or
  // while it is on). Never the secret or the recovery codes.
  function twoStepExport(user) {
    const enabled = ctx.twoStep.isOn(user);
    return enabled || isReleased(cfg, "twostep")
      ? { twoStep: { enabled } }
      : {};
  }
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
      uploads: db.prepare("SELECT id,name,bytes,kind,text,truncated,created,expires FROM uploads WHERE user_id=? AND expires>?").all(req.user.id, now()),
      scrolls: db
        .prepare("SELECT * FROM scrolls WHERE user_id=?")
        .all(req.user.id),
      instructions:
        db
          .prepare("SELECT * FROM user_instructions WHERE user_id=?")
          .get(req.user.id) || null,
      // Share a Chat: every live link, with its address (once the update is
      // live, or while any link exists). A snapshot's text is a copy of
      // messages already exported with their conversation above, so it isn't
      // repeated here.
      ...shareLinksExport(req.user.id),
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
      spendingLimits: exportLimits(req.user.id),
      // Routines: each routine and its inbox (answers, charges, receipts).
      routines: exportRoutines(db, req.user.id),
      // Projects: each one's settings, filed chats and pinned files (once
      // the update is live, or while any project exists).
      ...projectsExport(req.user.id),
      ...twoStepExport(req.user.id),
      ...balanceAlertExport(req.user.id),
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
      eraseAccountContent(db, req.user);
      db.prepare(
        "UPDATE api_keys SET revoked=?,hash=NULL,name='Deleted account',prefix=NULL,agent_label=NULL WHERE user_id=?",
      ).run(now(), req.user.id);
      // Connected apps lose their tokens and pending codes with the account
      // (eraseAccountContent), and their names here.
      db.prepare(
        "UPDATE oauth_connections SET revoked=COALESCE(revoked,?),name='Deleted account',client_name='',redirect_uri='' WHERE user_id=?",
      ).run(now(), req.user.id);
      db.prepare("DELETE FROM memory_settings WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM spending_limits WHERE user_id=?").run(req.user.id);
      // Two-Step Sign-in: the sealed secret and the recovery code hashes.
      db.prepare("DELETE FROM two_step_recovery WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM two_step WHERE user_id=?").run(req.user.id);
      forgetAlert(db, req.user.id);
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
