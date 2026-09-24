import { randomBytes } from "node:crypto";
import {
  hash,
  now,
  uid,
  fail,
  credits,
  balance,
  hasDisputedCredit,
  transaction,
} from "../core.js";
import { requestIdentifier } from "../middleware.js";

export const MIN_TRANSFER = 1; // credits
export const MAX_TRANSFER = 1_000_000; // credits

// Credit transfers between accounts, recorded as a linked pair of ledger
// entries so both balances change atomically and the history is auditable.
export function creditRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  // Codes are created on first use: eight characters from an unambiguous
  // lowercase alphabet, retried on the rare collision.
  function referralCode(user) {
    const existing = db
      .prepare("SELECT referral_code FROM users WHERE id=?")
      .get(user).referral_code;
    if (existing) return existing;
    const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = [...randomBytes(8)]
        .map((b) => alphabet[b % alphabet.length])
        .join("");
      try {
        db.prepare(
          "UPDATE users SET referral_code=? WHERE id=? AND referral_code IS NULL",
        ).run(code, user);
        return db
          .prepare("SELECT referral_code FROM users WHERE id=?")
          .get(user).referral_code;
      } catch (e) {
        if (!/UNIQUE/.test(e.message)) throw e;
      }
    }
    fail(503, "Could not create a referral code. Try again.");
  }
  app.get("/api/referrals", requireUser, (req, res) => {
    const code = referralCode(req.user.id);
    const earned = db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE user_id=? AND kind IN ('referral','referral_correction')",
      )
      .get(req.user.id).n;
    res.json({
      code,
      link: `${cfg.publicUrl || cfg.origin}/?ref=${code}`,
      percent: cfg.referralPercent,
      invited: db
        .prepare("SELECT COUNT(*) n FROM users WHERE referred_by=?")
        .get(req.user.id).n,
      earned: credits(earned),
    });
  });
  app.post(
    "/api/credits/send",
    requireUser,
    limit("send-credits", 10, 3600000),
    (req, res) => {
      const to = String(req.body.to || "")
        .trim()
        .replace(/^@/, "");
      const amount = Number(req.body.amount);
      const units = Math.round(amount * 10000);
      if (
        !Number.isFinite(amount) ||
        amount < MIN_TRANSFER ||
        amount > MAX_TRANSFER ||
        Math.abs(units - amount * 10000) > 1e-6
      )
        fail(
          400,
          `Send between ${MIN_TRANSFER} and ${MAX_TRANSFER.toLocaleString()} credits, with at most four decimals.`,
        );
      const recipient = db
        .prepare(
          "SELECT * FROM users WHERE username=? COLLATE NOCASE AND deleted IS NULL",
        )
        .get(to);
      if (!recipient)
        fail(404, "No account has that username.", "recipient_not_found");
      if (recipient.id === req.user.id)
        fail(400, "You can't send credits to yourself.");
      const id =
        "transfer_" +
        hash(req.user.id + ":" + requestIdentifier(req)).slice(0, 32);
      const result = transaction(db, () => {
        const previous = db
          .prepare("SELECT amount FROM ledger WHERE ref=?")
          .get(id + ":out");
        if (previous) {
          if (-previous.amount !== units)
            fail(
              409,
              "That request ID was already used for a different transfer.",
            );
          return { id, repeated: true };
        }
        if (hasDisputedCredit(db, req.user.id))
          fail(
            409,
            "A credited payment is under reconciliation. Transfers are paused until it is confirmed.",
            "payment_reconciliation_pending",
          );
        if (balance(db, req.user.id).available < units)
          fail(
            402,
            "Not enough available credits to send.",
            "insufficient_credits",
          );
        const entry = db.prepare(
          "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
        );
        const at = now();
        entry.run(
          uid("l_"),
          req.user.id,
          -units,
          "transfer_out",
          id + ":out",
          null,
          `Sent to @${recipient.username}`,
          at,
        );
        entry.run(
          uid("l_"),
          recipient.id,
          units,
          "transfer_in",
          id + ":in",
          null,
          `Received from @${req.user.username || "a user"}`,
          at,
        );
        return { id, repeated: false };
      });
      res.status(result.repeated ? 200 : 201).json({
        id: result.id,
        to: recipient.username,
        credits: credits(units),
        available: credits(balance(db, req.user.id).available),
      });
    },
  );
}
