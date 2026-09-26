import { UNITS, addCredit, fail, hash, now, transaction, uid } from "./core.js";

const statuses = new Set([
  "waiting",
  "confirming",
  "confirmed",
  "sending",
  "partially_paid",
  "finished",
  "failed",
  "expired",
  "refunded",
]);
const terminalUncredited = new Set(["failed", "expired", "refunded"]);
// Invoices the processor may still move toward payment.
export const OPEN_PAYMENT_STATUSES = [
  "waiting",
  "confirming",
  "confirmed",
  "sending",
  "partially_paid",
];
// Invoices whose processor status can no longer change.
export const FINAL_PAYMENT_STATUSES = ["finished", ...terminalUncredited];
// Local states for an invoice whose creation has not been confirmed.
export const UNCONFIRMED_INVOICE_STATUSES = [
  "creating",
  "error",
  "reconciliation",
];
export const sqlList = (values) => values.map((v) => `'${v}'`).join(",");

// A referred account's credited deposits earn its referrer a share. The
// reward follows the deposit: reversed with it and reinstated with it, as
// append-only entries keyed by the deposit.
function referralReward(db, deposit, percent, event) {
  if (!(percent > 0)) return;
  const referrer = db
    .prepare(
      "SELECT r.id FROM users u JOIN users r ON r.id=u.referred_by WHERE u.id=? AND r.deleted IS NULL",
    )
    .get(deposit.user_id);
  if (!referrer) return;
  const ref = `referral_${deposit.id}`;
  const outstanding = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n, COUNT(*) c FROM ledger WHERE ref=? OR ref LIKE ?",
    )
    .get(ref, ref + "_correction_%");
  const insert = (amount, key, kind, description) =>
    db
      .prepare(
        "INSERT OR IGNORE INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
      )
      .run(uid("l_"), referrer.id, amount, kind, key, null, description, now());
  const reward = Math.floor((deposit.amount * percent) / 100);
  if (event === "credit" && !outstanding.c && reward > 0)
    insert(reward, ref, "referral", "Referral reward");
  else if (event === "reverse" && outstanding.n > 0)
    insert(
      -outstanding.n,
      `${ref}_correction_${outstanding.c}`,
      "referral_correction",
      "Referral reward reversed",
    );
  else if (event === "reinstate" && outstanding.c && outstanding.n === 0) {
    const original = db
      .prepare("SELECT amount FROM ledger WHERE ref=?")
      .get(ref);
    if (original?.amount > 0)
      insert(
        original.amount,
        `${ref}_correction_${outstanding.c}`,
        "referral_correction",
        "Referral reward reinstated",
      );
  }
}

// Accept only authenticated processor responses or verified signed callbacks.
// Binding by order_id recovers a callback that beats the create response, or
// an invoice whose upstream creation succeeded before the connection failed.
export function recordPayment(
  db,
  body,
  { current = false, allowReinstate = false, referralPercent = 0 } = {},
) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    fail(400, "Invalid payment update.");
  const providerId = String(body.payment_id || "");
  if (
    !providerId ||
    providerId.length > 200 ||
    !statuses.has(body.payment_status)
  )
    fail(400, "Invalid payment identity or status.");
  return transaction(db, () => {
    const existing = db
      .prepare("SELECT * FROM deposits WHERE provider_id=?")
      .get(providerId);
    const d =
      existing ||
      db
        .prepare("SELECT * FROM deposits WHERE id=?")
        .get(String(body.order_id || ""));
    if (!d) return null;
    if (
      !d.credited &&
      !db
        .prepare("SELECT id FROM users WHERE id=? AND deleted IS NULL")
        .get(d.user_id)
    )
      fail(
        409,
        "Payment belongs to a closed account and requires operator reconciliation.",
      );
    if (d.provider_id && d.provider_id !== providerId)
      fail(
        409,
        "A different processor invoice is already bound to this order.",
      );
    const binding = !d.provider_id;
    const identityRequired = binding || body.payment_status === "finished";
    const paidAmount = Number(body.price_amount);
    if (
      ((identityRequired || body.order_id != null) &&
        String(body.order_id) !== d.id) ||
      ((identityRequired || body.price_currency != null) &&
        String(body.price_currency).toLowerCase() !== "usd") ||
      ((identityRequired || body.price_amount != null) &&
        (!Number.isFinite(paidAmount) ||
          paidAmount <= 0 ||
          Math.abs(paidAmount - d.amount / 1e7) > 0.005)) ||
      (body.pay_currency != null &&
        String(body.pay_currency).toLowerCase() !== d.currency)
    )
      fail(400, "Payment invoice mismatch.");
    const previous = JSON.parse(d.payload);
    let review = !!previous.statusReview;
    let status = d.credited ? "finished" : body.payment_status;
    let creditState = d.credited
      ? previous.creditState === "reversed"
        ? "reversed"
        : "credited"
      : "uncredited";
    let correctionCount =
      Number.isSafeInteger(previous.creditCorrectionCount) &&
      previous.creditCorrectionCount >= 0
        ? previous.creditCorrectionCount
        : 0;
    if (d.credited) {
      const isTerminal = terminalUncredited.has(body.payment_status);
      const correctLedger = (amount, description) => {
        correctionCount += 1;
        db.prepare(
          "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          uid("l_"),
          d.user_id,
          amount,
          "payment_correction",
          `payment_${providerId}_correction_${correctionCount}`,
          null,
          description,
          now(),
        );
      };
      if (current && isTerminal && creditState === "credited") {
        // Only the authenticated current processor status can reverse a
        // previously credited invoice. Keep the correction append-only.
        correctLedger(
          -d.amount,
          `${d.currency.toUpperCase()} payment reversed`,
        );
        referralReward(db, d, referralPercent, "reverse");
        creditState = "reversed";
        review = false;
        status = body.payment_status;
      } else if (
        current &&
        allowReinstate &&
        body.payment_status === "finished" &&
        creditState === "reversed"
      ) {
        // A reversal is terminal enough that an ordinary status poll must not
        // reinstate spendable credit. The operator confirms this transition.
        correctLedger(
          d.amount,
          `${d.currency.toUpperCase()} payment reinstated`,
        );
        referralReward(db, d, referralPercent, "reinstate");
        creditState = "credited";
        review = false;
        status = "finished";
      } else if (creditState === "reversed") {
        if (isTerminal) {
          review = false;
          status = body.payment_status;
        } else {
          review = true;
          status = "reconciliation";
        }
      } else {
        if (isTerminal) review = true;
        if (review) {
          if (current && body.payment_status === "finished") review = false;
          else status = "reconciliation";
        }
      }
    } else if (review || terminalUncredited.has(d.status)) {
      if (body.payment_status === "finished") {
        // A signed callback may be older than a terminal update. An
        // authenticated status fetch is required before adding credit.
        if (current) review = false;
        else {
          review = true;
          status = "reconciliation";
        }
      } else if (review) {
        if (current && terminalUncredited.has(body.payment_status))
          review = false;
        else status = "reconciliation";
      } else if (!terminalUncredited.has(body.payment_status))
        status = d.status;
    }
    if (status === "finished" && !d.credited) creditState = "credited";
    const payload = {
      ...previous,
      ...body,
      payment_status: status,
      creditState,
      creditCorrectionCount: correctionCount,
      ...(review
        ? {
            statusReview:
              "Conflicting payment updates require a current processor check; unresolved outcomes need operator reconciliation.",
          }
        : {}),
    };
    if (!review) delete payload.statusReview;
    db.prepare(
      "UPDATE deposits SET provider_id=?,status=?,payload=?,updated=? WHERE id=?",
    ).run(providerId, status, JSON.stringify(payload), now(), d.id);
    if (status === "finished" && !d.credited) {
      addCredit(
        db,
        d.user_id,
        d.amount,
        "payment_" + providerId,
        "deposit",
        `${d.currency.toUpperCase()} deposit`,
      );
      db.prepare("UPDATE deposits SET credited=1 WHERE id=?").run(d.id);
      referralReward(db, d, referralPercent, "credit");
    }
    return db.prepare("SELECT * FROM deposits WHERE id=?").get(d.id);
  });
}

// A confirmed on-chain transfer from the user's linked wallet. It can't be
// reversed like a processor invoice, so the deposit is recorded already
// credited. The provider id (chain and transaction hash) is unique, which
// makes each transaction creditable once.
export function recordWalletPayment(
  db,
  { user, providerId, amount, currency, payload },
  { referralPercent = 0 } = {},
) {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    fail(400, "This payment is too small to credit.", "payment_not_matched");
  return transaction(db, () => {
    const existing = db
      .prepare("SELECT * FROM deposits WHERE provider_id=?")
      .get(providerId);
    if (existing) {
      if (existing.user_id !== user)
        fail(
          409,
          "This transaction was already credited to another account.",
          "payment_already_claimed",
        );
      return existing;
    }
    const id = "deposit_" + hash(providerId).slice(0, 32);
    const created = now();
    db.prepare(
      "INSERT INTO deposits(id,user_id,provider_id,amount,currency,status,payload,credited,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      user,
      providerId,
      amount,
      currency,
      "finished",
      JSON.stringify({
        ...payload,
        payment_id: providerId,
        payment_status: "finished",
        creditState: "credited",
      }),
      1,
      created,
      created,
    );
    addCredit(
      db,
      user,
      amount,
      "payment_" + providerId,
      "deposit",
      `${currency.toUpperCase()} deposit`,
    );
    referralReward(
      db,
      { id, user_id: user, amount },
      referralPercent,
      "credit",
    );
    return db.prepare("SELECT * FROM deposits WHERE id=?").get(id);
  });
}

// A confirmed NYMA transfer for Pay with NYMA (server/routes/nyma.js),
// credited like a wallet payment: a deposit recorded already credited, whose
// value goes on the ledger as nyma_topup and its bonus as nyma_bonus. Each
// Transfer log (chain, transaction hash, log index) is claimed once, and the
// per-payment and rolling 24-hour limits (USD of value, plus `slack` for a
// quote rounded up to whole NYMA) are checked with the insert.
export function recordNymaPayment(
  db,
  { user, providerId, chain, txHash, logs, value, bonus, maxUsd, dailyMaxUsd, slack = 0, payload },
  { referralPercent = 0 } = {},
) {
  if (!Number.isSafeInteger(value) || value <= 0)
    fail(400, "This payment is too small to credit.", "payment_not_matched");
  if (!Number.isSafeInteger(bonus) || bonus < 0)
    fail(400, "Invalid bonus.", "invalid_request");
  const review = (why) =>
    fail(
      409,
      `${why} so it can't be credited automatically. Contact support with the transaction hash.`,
      "wallet_payment_review",
    );
  return transaction(db, () => {
    const existing = db
      .prepare("SELECT * FROM deposits WHERE provider_id=?")
      .get(providerId);
    if (existing) {
      if (existing.user_id !== user)
        fail(
          409,
          "This transaction was already credited to another account.",
          "payment_already_claimed",
        );
      return existing;
    }
    const claimed = db.prepare(
      "SELECT deposit_id FROM nyma_claims WHERE chain=? AND tx_hash=? AND log_index=?",
    );
    if (logs.some((i) => claimed.get(chain, txHash, i)))
      fail(
        409,
        "This transfer was already credited.",
        "payment_already_claimed",
      );
    if (value > maxUsd * UNITS + slack)
      review(
        `This top-up is worth more than the $${maxUsd} limit for one NYMA payment,`,
      );
    const today = db
      .prepare(
        "SELECT COALESCE(SUM(amount),0) n FROM deposits WHERE user_id=? AND currency='nyma' AND credited=1 AND created>?",
      )
      .get(user, now() - 86400000).n;
    if (today + value > dailyMaxUsd * UNITS + slack)
      review(
        `This top-up would pass the $${dailyMaxUsd} limit for NYMA top-ups in 24 hours,`,
      );
    const id = "deposit_" + hash(providerId).slice(0, 32);
    const created = now();
    db.prepare(
      "INSERT INTO deposits(id,user_id,provider_id,amount,currency,status,payload,credited,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      id,
      user,
      providerId,
      value,
      "nyma",
      "finished",
      JSON.stringify({
        ...payload,
        payment_id: providerId,
        payment_status: "finished",
        creditState: "credited",
      }),
      1,
      created,
      created,
    );
    const claim = db.prepare(
      "INSERT INTO nyma_claims(chain,tx_hash,log_index,deposit_id) VALUES(?,?,?,?)",
    );
    for (const i of logs) claim.run(chain, txHash, i, id);
    addCredit(db, user, value, "payment_" + providerId, "nyma_topup", "NYMA top-up");
    if (bonus > 0)
      addCredit(
        db,
        user,
        bonus,
        "nyma_bonus_" + providerId,
        "nyma_bonus",
        "NYMA top-up bonus",
      );
    // Referral rewards follow the top-up's value, never its bonus.
    referralReward(db, { id, user_id: user, amount: value }, referralPercent, "credit");
    return db.prepare("SELECT * FROM deposits WHERE id=?").get(id);
  });
}
