import { now, fail, credits, onReserve, transaction } from "./core.js";
import { isReleased } from "./releases.js";

// Spending Limits: an account's own daily and monthly limits on what its
// personal balance can spend, so a runaway session, script or leaked key
// can't drain it. Off until the account sets one.
//
// What counts, per rolling window: every settled charge on the personal
// balance (a ledger row settling one of the account's own holds), credits
// sent to another account, treasury contributions, and every hold still
// open, whatever its age. Team-paid collab requests hold and settle on the
// treasury's own ledger account, so they never count here; neither do
// top-ups, refunds, rewards or payment corrections.
//
// Enforcement runs inside the reservation's transaction (core.js reserve(),
// through onReserve) and inside the transfer transactions, so concurrent
// requests can't jointly go over a limit, and settlement never exceeds the
// hold, so a request that was let through can't either.
//
// Lowering or adding a limit applies at once. Raising or removing one waits
// RAISE_DELAY, so a stolen session can't lift a limit and spend straight
// away; the owner sees the pending change and can cancel it.
export const HOUR = 3600000;
export const DAY = 24 * HOUR;
export const WINDOWS = { daily: DAY, monthly: 30 * DAY };
export const RAISE_DELAY = DAY;
export const MAX_LIMIT_CREDITS = 1_000_000_000;
// Ledger kinds that spend the personal balance without a hold.
export const TRANSFER_KINDS = ["transfer_out", "treasury_contribution"];

export const limitsLive = (cfg) => isReleased(cfg, "limits");

const COUNTED = `FROM ledger l WHERE l.user_id=? AND l.amount<0 AND l.created>?
  AND (l.kind IN (${TRANSFER_KINDS.map((k) => `'${k}'`).join(",")})
    OR EXISTS (SELECT 1 FROM holds h WHERE h.id=l.ref AND h.user_id=l.user_id))`;

const settingsOf = (db, user) =>
  db.prepare("SELECT * FROM spending_limits WHERE user_id=?").get(user) || null;
// Settled spend on the personal balance after `since`.
export const settledSince = (db, user, since) =>
  db.prepare(`SELECT COALESCE(SUM(-l.amount),0) n ${COUNTED}`).get(user, since)
    .n;
// Every hold still open on the personal balance.
export const heldNow = (db, user) =>
  db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM holds WHERE user_id=? AND status='held'",
    )
    .get(user).n;

// The limits in force at `at`: a pending change applies once its time comes.
export function limitsAt(row, at = now()) {
  const out = {};
  for (const name of Object.keys(WINDOWS)) {
    const due = row?.[`${name}_pending_at`];
    out[name] =
      due != null && due <= at
        ? row[`${name}_pending`]
        : (row?.[`${name}_limit`] ?? null);
  }
  return out;
}
const pendingAt = (row, name, at) => {
  const due = row?.[`${name}_pending_at`];
  return due != null && due > at
    ? { limit: row[`${name}_pending`], at: due }
    : null;
};

// When settled spend old enough to leave the window has freed `excess`, or
// null when expiring settled spend alone can't (open holds must finish).
function freesAt(db, user, span, at, excess) {
  let freed = 0;
  for (const r of db
    .prepare(
      `SELECT -l.amount n, l.created ${COUNTED} ORDER BY l.created, l.rowid`,
    )
    .all(user, at - span)) {
    freed += r.n;
    if (freed >= excess) return r.created + span;
  }
  return null;
}
// When the oldest counted spend in the window drops out of it.
function nextRoomAt(db, user, span, at) {
  const r = db
    .prepare(`SELECT MIN(l.created) t ${COUNTED}`)
    .get(user, at - span);
  return r.t == null ? null : r.t + span;
}

// "3 h 12 min", "45 min", "12 days 4 h": how long until room frees up.
export function waitText(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48)
    return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days} days ${hours % 24} h` : `${days} days`;
}
const isoMinute = (ms) => new Date(ms).toISOString().slice(0, 16) + "Z";

function refusal({ name, limit, settled, held, frees }, amount, at) {
  const left = Math.max(0, limit - settled - held);
  let message =
    limit === 0
      ? `Your ${name} spending limit is 0 credits, so nothing can be spent.`
      : amount > limit
        ? `This would spend up to ${credits(amount)} credits, more than your whole ${name} spending limit of ${credits(limit)} credits.`
        : left <= 0
          ? `You've reached your ${name} spending limit of ${credits(limit)} credits.`
          : `This would spend up to ${credits(amount)} credits, more than the ${credits(left)} credits left of your ${name} spending limit.`;
  if (frees != null)
    message += ` Room frees up in ${waitText(frees - at)} (${isoMinute(frees)}).`;
  else if (held > 0 && amount <= limit)
    message += " Room frees up as requests in progress finish.";
  const e = new Error(message);
  e.status = 402;
  e.code = "spending_limit";
  e.spendingLimit = {
    limit: name,
    window_hours: WINDOWS[name] / HOUR,
    limit_credits: credits(limit),
    used_credits: credits(settled + held),
    held_credits: credits(held),
    remaining_credits: credits(left),
    requested_credits: credits(amount),
    frees_at: frees,
  };
  return e;
}

// Refuses (402 spending_limit) when spending `amount` more would take the
// personal balance over a limit in force. Call it inside the transaction
// that records the spend or its hold.
export function assertSpendingRoom(db, user, amount, at = now()) {
  // A free request spends nothing, even from an account already over.
  if (!(amount > 0)) return;
  const row = settingsOf(db, user);
  if (!row) return;
  const limits = limitsAt(row, at);
  if (limits.daily == null && limits.monthly == null) return;
  const held = heldNow(db, user);
  let binding = null;
  for (const [name, span] of Object.entries(WINDOWS)) {
    const limit = limits[name];
    if (limit == null) continue;
    const settled = settledSince(db, user, at - span);
    if (settled + held + amount <= limit) continue;
    const frees =
      amount > limit
        ? null
        : freesAt(db, user, span, at, settled + held + amount - limit);
    // Name the limit that holds the request back the longest.
    if (!binding || (binding.frees ?? Infinity) < (frees ?? Infinity))
      binding = { name, limit, settled, held, frees };
  }
  if (binding) throw refusal(binding, amount, at);
}

// Room left before the tightest limit in force, or null with no limit.
export function spendingRoom(db, user, at = now()) {
  const row = settingsOf(db, user);
  const limits = limitsAt(row, at);
  let room = null;
  for (const [name, span] of Object.entries(WINDOWS)) {
    if (limits[name] == null) continue;
    const left =
      limits[name] - settledSince(db, user, at - span) - heldNow(db, user);
    room = room == null ? left : Math.min(room, left);
  }
  return room == null ? null : Math.max(0, room);
}

// Everything the Account panel shows, in credits.
export function limitsView(db, user, at = now()) {
  const row = settingsOf(db, user);
  const limits = limitsAt(row, at);
  const held = heldNow(db, user);
  const view = { raise_delay_hours: RAISE_DELAY / HOUR, held: credits(held) };
  for (const [name, span] of Object.entries(WINDOWS)) {
    const settled = settledSince(db, user, at - span);
    const limit = limits[name];
    const pending = pendingAt(row, name, at);
    view[name] = {
      limit: limit == null ? null : credits(limit),
      window_hours: span / HOUR,
      settled: credits(settled),
      held: credits(held),
      used: credits(settled + held),
      remaining:
        limit == null ? null : credits(Math.max(0, limit - settled - held)),
      pending: pending
        ? {
            limit: pending.limit == null ? null : credits(pending.limit),
            applies_at: pending.at,
          }
        : null,
      next_room_at: nextRoomAt(db, user, span, at),
    };
  }
  return view;
}

// Credits with at most four decimals as integer subcredits; null is no limit.
export function limitUnits(value) {
  if (value === null) return null;
  const units = Math.round(value * 10000);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > MAX_LIMIT_CREDITS ||
    Math.abs(units - value * 10000) > 1e-6
  )
    fail(
      400,
      `Set each limit in credits from 0 to ${MAX_LIMIT_CREDITS.toLocaleString("en-US")} with at most four decimals, or null for no limit.`,
      "invalid_limit",
    );
  return units;
}

function save(db, user, next, at) {
  db.prepare(
    `INSERT INTO spending_limits(user_id,daily_limit,monthly_limit,daily_pending,daily_pending_at,monthly_pending,monthly_pending_at,updated)
     VALUES(?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET daily_limit=excluded.daily_limit,monthly_limit=excluded.monthly_limit,
       daily_pending=excluded.daily_pending,daily_pending_at=excluded.daily_pending_at,
       monthly_pending=excluded.monthly_pending,monthly_pending_at=excluded.monthly_pending_at,updated=excluded.updated`,
  ).run(
    user,
    next.daily.limit,
    next.monthly.limit,
    next.daily.pending?.limit ?? null,
    next.daily.pending?.at ?? null,
    next.monthly.pending?.limit ?? null,
    next.monthly.pending?.at ?? null,
    at,
  );
}
// The stored settings with any pending change whose time has come applied.
function current(db, user, at) {
  const row = settingsOf(db, user);
  const limits = limitsAt(row, at);
  return Object.fromEntries(
    Object.keys(WINDOWS).map((name) => [
      name,
      { limit: limits[name], pending: pendingAt(row, name, at) },
    ]),
  );
}

// Applies { daily: units|null, monthly: units|null } (fields left out stay
// as they are) and says what happened to each: "applied" (a lower or new
// limit, in force now), "pending" (a raise or removal, from RAISE_DELAY
// later) or "unchanged". A new value always replaces a pending change; a
// new raise starts the wait again.
export function changeLimits(db, user, changes, at = now()) {
  return transaction(db, () => {
    const next = current(db, user, at);
    const outcome = {};
    for (const [name, value] of Object.entries(changes)) {
      const slot = next[name];
      if (value === slot.limit) {
        slot.pending = null;
        outcome[name] = "unchanged";
      } else if (
        value !== null &&
        (slot.limit === null || value < slot.limit)
      ) {
        slot.limit = value;
        slot.pending = null;
        outcome[name] = "applied";
      } else {
        slot.pending = { limit: value, at: at + RAISE_DELAY };
        outcome[name] = "pending";
      }
    }
    save(db, user, next, at);
    return outcome;
  });
}
// Cancels a pending raise or removal; the limit in force stays.
export function cancelPending(db, user, name, at = now()) {
  return transaction(db, () => {
    const next = current(db, user, at);
    if (!next[name].pending)
      fail(
        404,
        `There's no pending change to your ${name} limit.`,
        "no_pending_change",
      );
    next[name].pending = null;
    save(db, user, next, at);
  });
}

// Registers the check every reservation on this database runs; it applies
// only while Spending Limits is released.
export function enforceSpendingLimits(db, cfg) {
  onReserve(db, (user, amount) => {
    if (limitsLive(cfg)) assertSpendingRoom(db, user, amount);
  });
}
