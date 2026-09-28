import { now, fail, credits, balance, transaction } from "./core.js";
import { isReleased } from "./releases.js";
import {
  SUGGESTED_CREDITS,
  MIN_CREDITS,
  MAX_CREDITS,
  THRESHOLD_RULE,
  toUnits,
  validThreshold,
} from "../src/balance-alerts.js";

// Low-Balance Alerts: one setting per account, the available balance (its
// credits minus every hold still open, core.js balance()) below which the
// app warns it, plus whether it asked for a browser notification too. Off
// until the account turns it on (no row). The warning itself is shown by the
// browser (src/BalanceAlerts.jsx), from the balance the app already reads
// after each request; the server sends no email and no push.
//
// Settings only: nothing here touches the ledger or holds, and Spending
// Limits (server/spending-limits.js) are separate. Team Treasury balances
// aren't watched: this is the personal balance only.
export const alertsLive = (cfg) => isReleased(cfg, "balancealerts");

const rowOf = (db, user) =>
  db
    .prepare("SELECT threshold,notify,updated FROM balance_alerts WHERE user_id=?")
    .get(user) || null;

// A submitted level in credits as integer subcredits; null turns it off.
export function thresholdUnits(value) {
  if (value === null) return null;
  if (!validThreshold(value)) fail(400, THRESHOLD_RULE, "invalid_threshold");
  return toUnits(value);
}

// What GET /api/balance-alert returns, in credits.
export function alertView(db, user) {
  const row = rowOf(db, user);
  const { available } = balance(db, user);
  return {
    enabled: !!row,
    threshold: row ? credits(row.threshold) : null,
    notify: !!row?.notify,
    available: credits(available),
    below: !!row && available < row.threshold,
    suggested: SUGGESTED_CREDITS,
    min: MIN_CREDITS,
    max: MAX_CREDITS,
    updated: row?.updated ?? null,
  };
}

// Applies { threshold?: units | null, notify?: boolean }: a field left out
// keeps its value, and threshold null turns the alert off (and forgets the
// notification choice with it).
export function changeAlert(db, user, change, at = now()) {
  transaction(db, () => {
    if (change.threshold === null) {
      db.prepare("DELETE FROM balance_alerts WHERE user_id=?").run(user);
      return;
    }
    const row = rowOf(db, user);
    const threshold = change.threshold ?? row?.threshold;
    if (threshold == null)
      fail(
        400,
        "Set an alert level to turn the alert on.",
        "invalid_threshold",
      );
    const notify = change.notify ?? !!row?.notify;
    db.prepare(
      `INSERT INTO balance_alerts(user_id,threshold,notify,updated) VALUES(?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET threshold=excluded.threshold,notify=excluded.notify,updated=excluded.updated`,
    ).run(user, threshold, notify ? 1 : 0, at);
  });
}

// The account export's balanceAlert: null when the alert is off.
export function exportAlert(db, user) {
  const row = rowOf(db, user);
  return row
    ? { threshold: credits(row.threshold), notify: !!row.notify, updated: row.updated }
    : null;
}
// Account closure deletes the setting (routes/account.js). Panic Wipe keeps
// it with the account's other settings, like Spending Limits.
export const forgetAlert = (db, user) =>
  db.prepare("DELETE FROM balance_alerts WHERE user_id=?").run(user);
