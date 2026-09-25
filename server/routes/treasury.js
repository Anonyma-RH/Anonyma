import {
  uid,
  hash,
  now,
  fail,
  credits,
  balance,
  hasDisputedCredit,
  transaction,
} from "../core.js";
import { isReleased } from "../releases.js";

export const MAX_TREASURY_TRANSFER = 1_000_000; // credits
export const MAX_TREASURY_LIMIT = 1_000_000_000; // credits
const DAY = 86400000;
// Limits cover the last 24 hours and the last 30 days.
const WINDOWS = { daily: DAY, monthly: 30 * DAY };
const KINDS = {
  treasury_contribution: "contribution",
  treasury_withdrawal: "withdrawal",
  treasury_return: "return",
};

// Team Treasury: a collab's shared credit balance. The balance is its own
// ledger account, a users row created on the first contribution with no
// username, password, email or wallet and already tombstoned, so no sign-in
// or lookup reaches it while the existing balance, hold and settle helpers
// work unchanged. Contributions and withdrawals are linked ledger pairs like
// credit sends; team-paid chats hold on the account within each member's
// limits and settle or release through the normal path.
export function treasuryRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  // While Team Treasury is switched off, a collab that already has one can
  // still see it and its owner can withdraw (see featuresFor); nothing else.
  function openWhenOff(collab) {
    const account = accountFor(collab);
    if (!account && !isReleased(cfg, "treasury"))
      fail(403, "Team Treasury is coming soon.", "feature_unreleased");
    return account;
  }
  const entry = db.prepare(
    "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
  );
  // Both sides of a transfer, written in the caller's transaction.
  function transfer(from, to, amount, kind, ref, [sent, received]) {
    const at = now();
    entry.run(uid("l_"), from, -amount, kind, ref + ":out", null, sent, at);
    entry.run(uid("l_"), to, amount, kind, ref + ":in", null, received, at);
  }
  // A retry with the same idempotency key returns the original transfer.
  function repeated(ref, amount) {
    const prior = db
      .prepare("SELECT amount FROM ledger WHERE ref=?")
      .get(ref + ":out");
    if (prior && -prior.amount !== amount)
      fail(
        409,
        "That idempotency key was already used for a different amount.",
        "idempotency_conflict",
      );
    return !!prior;
  }
  function idempotencyKey(req) {
    const key = req.headers["idempotency-key"] ?? req.body.idempotency_key;
    if (typeof key !== "string" || !key.trim() || key.length > 200)
      fail(
        400,
        "Send an idempotency_key of 1–200 characters so a retry can't apply twice.",
        "invalid_request_id",
      );
    return key;
  }
  // Credits with at most four decimals, as integer ledger subunits.
  function toUnits(value, min, max, message) {
    const units = Math.round(value * 10000);
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < min ||
      value > max ||
      Math.abs(units - value * 10000) > 1e-6
    )
      fail(400, message);
    return units;
  }
  function membership(id, user) {
    const c = db
      .prepare(
        "SELECT c.*, m.role FROM collabs c JOIN collab_members m ON m.collab_id=c.id AND m.user_id=? WHERE c.id=?",
      )
      .get(user, id);
    if (!c) fail(404, "Collab not found.");
    return c;
  }
  const accountFor = (collab) =>
    db
      .prepare("SELECT account_user_id FROM treasury_accounts WHERE collab_id=?")
      .get(collab)?.account_user_id ?? null;
  function openAccount(collab) {
    const existing = accountFor(collab);
    if (existing) return existing;
    const id = uid("treasury_");
    db.prepare("INSERT INTO users(id,created,deleted) VALUES(?,?,?)").run(
      id,
      now(),
      now(),
    );
    db.prepare(
      "INSERT INTO treasury_accounts(collab_id,account_user_id,created) VALUES(?,?,?)",
    ).run(collab, id, now());
    return id;
  }
  // Members start with a daily limit of 0, so they can't spend until the
  // owner sets one; a monthly limit is optional. The owner, who can withdraw
  // everything anyway, has no limit unless they set one.
  function limitsOf(c, user) {
    const row = db
      .prepare(
        "SELECT daily_limit,monthly_limit FROM treasury_members WHERE collab_id=? AND user_id=?",
      )
      .get(c.id, user);
    if (row) return { daily: row.daily_limit, monthly: row.monthly_limit };
    return { daily: c.owner_id === user ? null : 0, monthly: null };
  }
  // Settled team spend in the window plus every reservation still held.
  // Chat holds settle within minutes, so spends older than a day before the
  // window can't have settled inside it.
  function used(collab, user, window) {
    const since = now() - window;
    const settled = db
      .prepare(
        "SELECT COALESCE(SUM(-l.amount),0) n FROM treasury_spends s JOIN ledger l ON l.ref=s.hold_id WHERE s.collab_id=? AND (? IS NULL OR s.user_id=?) AND s.created>? AND l.amount<0 AND l.created>?",
      )
      .get(collab, user, user, since - DAY, since).n;
    const held = db
      .prepare(
        "SELECT COALESCE(SUM(h.amount),0) n FROM treasury_spends s JOIN holds h ON h.id=s.hold_id WHERE s.collab_id=? AND (? IS NULL OR s.user_id=?) AND h.status='held'",
      )
      .get(collab, user, user).n;
    return settled + held;
  }
  const limitCredits = (v) => (v == null ? null : credits(v));
  function memberView(c, m) {
    const caps = limitsOf(c, m.id);
    return {
      id: m.id,
      username: m.username || "Former member",
      role: m.role,
      daily_limit: limitCredits(caps.daily),
      monthly_limit: limitCredits(caps.monthly),
      daily_used: credits(used(c.id, m.id, WINDOWS.daily)),
      monthly_used: credits(used(c.id, m.id, WINDOWS.monthly)),
    };
  }
  function activity(collab, account) {
    // The other side of each transfer names the member.
    const transfers = account
      ? db
          .prepare(
            `SELECT t.kind, t.amount, t.created, u.username FROM ledger t
             LEFT JOIN ledger p ON p.ref = CASE WHEN t.amount>0
               THEN substr(t.ref,1,length(t.ref)-3)||':out'
               ELSE substr(t.ref,1,length(t.ref)-4)||':in' END
             LEFT JOIN users u ON u.id=p.user_id
             WHERE t.user_id=? AND t.kind IN ('treasury_contribution','treasury_withdrawal','treasury_return')
             ORDER BY t.created DESC, t.rowid DESC LIMIT 50`,
          )
          .all(account)
          .map((t) => ({
            type: KINDS[t.kind],
            member: t.username || "Former member",
            credits: credits(Math.abs(t.amount)),
            created: t.created,
          }))
      : [];
    const spends = db
      .prepare(
        `SELECT s.model, s.created, u.username, h.status, h.amount reserved, l.amount charged
         FROM treasury_spends s JOIN holds h ON h.id=s.hold_id
         LEFT JOIN ledger l ON l.ref=s.hold_id
         LEFT JOIN users u ON u.id=s.user_id
         WHERE s.collab_id=? ORDER BY s.created DESC, s.rowid DESC LIMIT 50`,
      )
      .all(collab)
      .map((s) => ({
        type: "spend",
        member: s.username || "Former member",
        model: s.model,
        status:
          s.status === "held"
            ? "pending"
            : s.status === "settled"
              ? "charged"
              : "released",
        credits: credits(
          s.status === "held" ? s.reserved : -(s.charged || 0),
        ),
        created: s.created,
      }));
    return [...transfers, ...spends]
      .sort((a, b) => b.created - a.created)
      .slice(0, 50);
  }
  // A deleted collab's balance returns to its owner as a linked transfer,
  // never lost. Refused while team-paid requests still hold part of it.
  function returnToOwner(c) {
    const account = accountFor(c.id);
    if (!account) return;
    const b = balance(db, account);
    if (b.held)
      fail(
        409,
        `Wait for team-paid requests in ${c.name} to finish, then try again.`,
        "treasury_busy",
      );
    if (b.total > 0)
      transfer(account, c.owner_id, b.total, "treasury_return", uid("treasury_"), [
        "Returned to the owner when the collab was deleted",
        `Returned from the ${c.name} treasury`,
      ]);
  }

  app.get("/api/collabs/:id/treasury", requireUser, (req, res) => {
    const c = membership(req.params.id, req.user.id);
    const account = openWhenOff(c.id);
    const b = account
      ? balance(db, account)
      : { total: 0, available: 0, held: 0 };
    const members = db
      .prepare(
        "SELECT u.id, u.username, m.role FROM collab_members m JOIN users u ON u.id=m.user_id WHERE m.collab_id=? ORDER BY m.role DESC, m.joined",
      )
      .all(c.id)
      .map((m) => memberView(c, m));
    res.json({
      id: c.id,
      name: c.name,
      role: c.role,
      // Switched off again: the balance can still be seen and withdrawn.
      paused: !isReleased(cfg, "treasury"),
      balance: credits(b.total),
      available: credits(b.available),
      held: credits(b.held),
      you: members.find((m) => m.id === req.user.id),
      members,
      monthly_used: credits(used(c.id, null, WINDOWS.monthly)),
      activity: activity(c.id, account),
    });
  });

  app.post(
    "/api/collabs/:id/treasury/contribute",
    requireUser,
    limit("treasury", 30, 3600000),
    (req, res) => {
      const c = membership(req.params.id, req.user.id);
      const key = idempotencyKey(req);
      const amount = toUnits(
        req.body.credits,
        1,
        MAX_TREASURY_TRANSFER,
        `Contribute between 1 and ${MAX_TREASURY_TRANSFER.toLocaleString("en-US")} credits, with at most four decimals.`,
      );
      const ref =
        "treasury_" +
        hash(`contribute:${req.user.id}:${c.id}:${key}`).slice(0, 32);
      const again = transaction(db, () => {
        if (repeated(ref, amount)) return true;
        if (hasDisputedCredit(db, req.user.id))
          fail(
            409,
            "A credited payment is under reconciliation. Transfers are paused until it is confirmed.",
            "payment_reconciliation_pending",
          );
        if (balance(db, req.user.id).available < amount)
          fail(
            402,
            "Not enough available credits to contribute.",
            "insufficient_credits",
          );
        transfer(
          req.user.id,
          openAccount(c.id),
          amount,
          "treasury_contribution",
          ref,
          [
            `Contributed to the ${c.name} treasury`,
            `Contribution from @${req.user.username || "a member"}`,
          ],
        );
        return false;
      });
      const b = balance(db, accountFor(c.id));
      res.status(again ? 200 : 201).json({
        id: ref,
        credits: credits(amount),
        balance: credits(b.total),
        available: credits(b.available),
      });
    },
  );

  app.post(
    "/api/collabs/:id/treasury/withdraw",
    requireUser,
    limit("treasury", 30, 3600000),
    (req, res) => {
      const c = membership(req.params.id, req.user.id);
      if (c.owner_id !== req.user.id)
        fail(403, "Only the collab owner can withdraw from the treasury.");
      openWhenOff(c.id);
      const key = idempotencyKey(req);
      const amount = toUnits(
        req.body.credits,
        1,
        MAX_TREASURY_TRANSFER,
        `Withdraw between 1 and ${MAX_TREASURY_TRANSFER.toLocaleString("en-US")} credits, with at most four decimals.`,
      );
      const ref =
        "treasury_" +
        hash(`withdraw:${req.user.id}:${c.id}:${key}`).slice(0, 32);
      const again = transaction(db, () => {
        if (repeated(ref, amount)) return true;
        const account = accountFor(c.id);
        if (!account || balance(db, account).available < amount)
          fail(
            402,
            "The treasury doesn't have that many available credits.",
            "treasury_insufficient",
          );
        transfer(account, req.user.id, amount, "treasury_withdrawal", ref, [
          `Withdrawn by @${req.user.username || "the owner"}`,
          `Withdrawn from the ${c.name} treasury`,
        ]);
        return false;
      });
      const b = balance(db, accountFor(c.id));
      res.status(again ? 200 : 201).json({
        id: ref,
        credits: credits(amount),
        balance: credits(b.total),
        available: credits(b.available),
      });
    },
  );

  app.patch(
    "/api/collabs/:id/treasury/members/:userId",
    requireUser,
    (req, res) => {
      const c = membership(req.params.id, req.user.id);
      if (c.owner_id !== req.user.id)
        fail(403, "Only the collab owner can set spending limits.");
      const m = db
        .prepare(
          "SELECT u.id, u.username, m.role FROM collab_members m JOIN users u ON u.id=m.user_id WHERE m.collab_id=? AND m.user_id=?",
        )
        .get(c.id, req.params.userId);
      if (!m) fail(404, "That person isn't a member.");
      const caps = limitsOf(c, m.id);
      // Omitted fields keep their value; null means no limit.
      const next = (field, current) =>
        !Object.hasOwn(req.body, field)
          ? current
          : req.body[field] === null
            ? null
            : toUnits(
                req.body[field],
                0,
                MAX_TREASURY_LIMIT,
                "Set each limit in credits from 0 to 1,000,000,000 with at most four decimals, or null for no limit.",
              );
      db.prepare(
        `INSERT INTO treasury_members(collab_id,user_id,daily_limit,monthly_limit,updated) VALUES(?,?,?,?,?)
         ON CONFLICT(collab_id,user_id) DO UPDATE SET daily_limit=excluded.daily_limit,monthly_limit=excluded.monthly_limit,updated=excluded.updated`,
      ).run(
        c.id,
        m.id,
        next("daily_limit", caps.daily),
        next("monthly_limit", caps.monthly),
        now(),
      );
      res.json(memberView(c, m));
    },
  );

  return {
    // Read-only quote context: verify access before exposing team funds and
    // cap available credits by this member's remaining spending limits.
    forQuote(user, conversation) {
      if (!isReleased(cfg, "treasury") || !isReleased(cfg, "collab"))
        fail(403, "Team Treasury is coming soon.", "feature_unreleased");
      if (!conversation) fail(400, "Team pays works only in collab conversations.", "treasury_unavailable");
      const v = ctx.conversations.accessConversation(conversation, user);
      if (!v.collab_id) fail(400, "Team pays works only in collab conversations.", "treasury_unavailable");
      const c = membership(v.collab_id, user);
      const account = accountFor(c.id);
      let available = account ? balance(db, account).available : 0;
      const caps = limitsOf(c, user);
      for (const [name, window] of Object.entries(WINDOWS))
        if (caps[name] != null) available = Math.min(available, caps[name] - used(c.id, user, window));
      return { available: Math.max(0, available) };
    },
    // For POST /api/chat with treasury: true. The guard runs inside the
    // reservation's transaction: treasury funds, then the member's limits
    // (settled + held + this hold), then records who the hold is for.
    forChat(user, conversation, model, hold) {
      const c = conversation
        ? db
            .prepare(
              "SELECT k.* FROM conversations v JOIN collabs k ON k.id=v.collab_id WHERE v.id=?",
            )
            .get(conversation)
        : null;
      if (!c)
        fail(
          400,
          "Team pays works only in collab conversations.",
          "treasury_unavailable",
        );
      const insufficient = () =>
        fail(
          402,
          "The team treasury doesn't have enough credits for this request.",
          "treasury_insufficient",
        );
      const account = accountFor(c.id);
      if (!account) insufficient();
      return {
        account,
        guard(amount) {
          if (balance(db, account).available < amount) insufficient();
          const caps = limitsOf(c, user);
          for (const [name, window] of Object.entries(WINDOWS)) {
            const cap = caps[name];
            if (cap == null) continue;
            const left = cap - used(c.id, user, window);
            // Say which it is: the limit is used up, or this one request's
            // worst-case cost is more than what's left of it.
            if (amount > left)
              fail(
                402,
                cap === 0
                  ? "Your team spending limit is 0. Ask the collab owner to raise it."
                  : left <= 0
                    ? `You've reached your ${name} team spending limit.`
                    : `This request could cost up to ${credits(amount)} credits, more than the ${credits(left)} left of your ${name} team spending limit.`,
                "treasury_limit",
              );
          }
          db.prepare(
            "INSERT INTO treasury_spends(hold_id,collab_id,user_id,model,created) VALUES(?,?,?,?,?)",
          ).run(hold, c.id, user, model, now());
        },
      };
    },
    // Inside the transaction that deletes the collab.
    closeCollab: returnToOwner,
    // An owner can't close their account while a collab they own has credits
    // in its treasury: members' contributions would go with the account. The
    // owner withdraws or spends them first.
    assertOwnedEmpty(user) {
      for (const c of db
        .prepare("SELECT * FROM collabs WHERE owner_id=? ORDER BY created")
        .all(user)) {
        const account = accountFor(c.id);
        if (!account) continue;
        const b = balance(db, account);
        if (b.held)
          fail(
            409,
            `Wait for team-paid requests in ${c.name} to finish, then try again.`,
            "treasury_busy",
          );
        if (b.total > 0)
          fail(
            409,
            `A collab you own still has ${credits(b.total)} ${b.total === 10000 ? "credit" : "credits"} in its team treasury. Withdraw or spend them before closing your account.`,
            "treasury_not_empty",
          );
      }
    },
  };
}
