import { addCredit, fail, now, transaction, uid } from "./core.js";

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

// Accept only authenticated processor responses or verified signed callbacks.
// Binding by order_id recovers a callback that beats the create response, or
// an invoice whose upstream creation succeeded before the connection failed.
export function recordPayment(
  db,
  body,
  { current = false, allowReinstate = false } = {},
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
    }
    return db.prepare("SELECT * FROM deposits WHERE id=?").get(d.id);
  });
}
