import { randomInt } from "node:crypto";
import { hash, now, transaction, uid, fail, credits } from "./core.js";
import { isReleased, earlyUpdates, earlyOpen, UPDATES } from "./releases.js";
import { ACCESS_PREFIX } from "./oauth.js";
import {
  parseHolderRewards,
  parseHolderLoyalty,
  CYCLE_DAYS,
  BASE_CAPS,
  HOLDER_CAPS,
} from "./holder-tiers.js";

// The NYMA Holder Program. An account that holds NYMA in a linked wallet
// earns ANONYMA credits every 30-day cycle by tier, plus each tier's perk:
//
//   Holder        1,000,000 NYMA    2,000 credits   Bigger library
//   Insider       5,000,000 NYMA   15,000 credits   + Early access
//   Inner Circle 25,000,000 NYMA  100,000 credits   + Roadmap vote
//
// (defaults; HOLDER_REWARDS and HOLDER_LOYALTY in server/holder-tiers.js).
// Nothing is staked, locked or deposited: ANONYMA only reads the wallet's
// balance (refreshTokenHoldings in server/auth.js). The worker reads every
// linked wallet about once a day, at a random time, and settles due cycles.
//
// A cycle opens at the first successful read that sees at least the Holder
// minimum, and its tier is set by the LOWEST balance any successful read
// sees during it, so buying just before a payout doesn't raise it. A read
// below the Holder minimum ends the cycle unpaid. A failed read changes
// nothing. After 30 days the cycle is paid, once, if a read succeeded in
// the last 48 hours; otherwise it waits for one. The next cycle opens at
// the payout. After HOLDER_LOYALTY's number of paid cycles in a row, each
// payout carries the Loyal bonus until a cycle ends unpaid.

const HOUR = 3600000;
const DAY = 24 * HOUR;
export const CYCLE_MS = CYCLE_DAYS * DAY;
// A tier, and every perk, needs a successful read this recent. The worker
// reads each wallet every 12 to 36 hours, so one failed day is tolerated.
export const CHECK_MAX_AGE = 48 * HOUR;
export const EARLY_ACCESS_MAX_AGE = CHECK_MAX_AGE;

export const holderTiers = (cfg) => cfg?.holderRewards ?? parseHolderRewards();
export const holderLoyalty = (cfg) =>
  cfg?.holderLoyalty ?? parseHolderLoyalty();
// Early access opens from the Insider tier.
export const earlyAccessThreshold = (cfg) => holderTiers(cfg)[1].min;
export const tokenChecks = (cfg) => !!(cfg?.rpc && cfg?.token);
export const programLive = (cfg) => isReleased(cfg, "holders");

// The highest tier a balance reaches, with its level (1 = Holder,
// 2 = Insider, 3 = Inner Circle), or null below the Holder minimum.
export function tierFor(cfg, balance) {
  const n = Number(balance);
  if (balance == null || !Number.isFinite(n)) return null;
  let found = null;
  holderTiers(cfg).forEach((tier, i) => {
    if (n >= tier.min) found = { ...tier, level: i + 1 };
  });
  return found;
}

// Credits (in ledger units) a cycle at `tier` pays, with the Loyal bonus
// after enough paid cycles in a row. Rounded down: never a subcredit over.
export function cycleAmount(cfg, tier, paidInARow) {
  if (!tier) return { units: 0, bonus: false };
  const { after, multiplier } = holderLoyalty(cfg);
  const bonus = paidInARow >= after && multiplier > 1 && tier.units > 0;
  return {
    units: bonus ? Math.floor(tier.units * multiplier) : tier.units,
    bonus,
  };
}

const fresh = (user, t) => {
  const checked = Number(user?.token_checked);
  return Number.isFinite(checked) && checked > 0 && t - checked <= CHECK_MAX_AGE;
};

// The account's CURRENT tier: the lowest balance successful reads saw in
// its open cycle so far, while its latest successful read is under 48
// hours old. Null when the program isn't live, balance reads aren't
// configured, or the account is closed, unlinked or between cycles.
// Every perk and early access use this one rule.
export function currentTier(cfg, user, t = now()) {
  if (!programLive(cfg) || !tokenChecks(cfg)) return null;
  if (!user || user.deleted != null || !user.wallet) return null;
  if (user.holder_cycle == null || !fresh(user, t)) return null;
  return tierFor(cfg, user.holder_low);
}
const level = (cfg, user, t) => currentTier(cfg, user, t)?.level ?? 0;

// ---- Balance reads ----

// When the worker reads a wallet next: 12 to 36 hours on, at a time nobody
// can predict. Moving the same NYMA between wallets to be seen in each at
// its read would need knowing when that is. An account's own Refresh never
// moves this schedule; an extra read can only lower a cycle's balance.
export const nextCheck = (t) => t + 12 * HOUR + randomInt(24 * HOUR);

// Records one successful balance read, and applies it to the Holder
// Program's cycle, in a single transaction, so a read is never half
// recorded. `user` is the row the read was made for; nothing is written if
// its wallet changed or the account closed while the read was in flight.
export function recordCheck(db, cfg, user, amount, options = {}) {
  const t = options.t ?? now();
  return transaction(db, () => {
    const current = db
      .prepare("SELECT * FROM users WHERE id=? AND wallet=? AND deleted IS NULL")
      .get(user.id, user.wallet);
    if (!current) return null;
    // token_since: how long the balance has held at least 5,000,000, for
    // the markup discount in server/core.js (unchanged).
    const old = Number(current.token_balance);
    const since =
      amount >= 5000000
        ? old >= 5000000
          ? current.token_since || t
          : t
        : null;
    db.prepare(
      "UPDATE users SET token_balance=?,token_since=?,token_checked=? WHERE id=?",
    ).run(String(amount), since, t, current.id);
    if (options.scheduled)
      db.prepare("UPDATE users SET token_due=?,token_retry=NULL WHERE id=?").run(
        nextCheck(t),
        current.id,
      );
    if (programLive(cfg)) {
      if (amount < holderTiers(cfg)[0].min)
        // Below the Holder minimum: the cycle ends unpaid, and so does the
        // run of paid cycles behind the Loyal bonus.
        db.prepare(
          "UPDATE users SET holder_cycle=NULL,holder_low=NULL,holder_paid=0 WHERE id=?",
        ).run(current.id);
      else if (current.holder_cycle == null)
        db.prepare(
          "UPDATE users SET holder_cycle=?,holder_low=? WHERE id=?",
        ).run(t, String(amount), current.id);
      else if (!(Number(current.holder_low) <= amount))
        db.prepare("UPDATE users SET holder_low=? WHERE id=?").run(
          String(amount),
          current.id,
        );
    }
    return db.prepare("SELECT * FROM users WHERE id=?").get(current.id);
  });
}

// What linking, unlinking or closing resets: a different wallet starts
// from nothing.
export const HOLDER_RESET =
  "token_balance='0',token_since=NULL,token_checked=NULL,token_retry=NULL,token_due=NULL,holder_cycle=NULL,holder_low=NULL,holder_paid=0";

// ---- Monthly credits: settling cycles ----

const rewardDescription = (tier, bonus) =>
  `NYMA holder reward: ${tier.name}${bonus ? ", Loyal bonus" : ""}`;

// Pays one account's due cycle, or does nothing. Everything happens in one
// transaction: the holder_rewards row (primary key: account and cycle
// start), the ledger credit (unique ref) and the move to the next cycle
// (only if the cycle is still the one read). A crash before the commit
// leaves no trace, and a rerun finds the cycle already moved on, so a
// cycle is never paid twice.
export function settleCycle(db, cfg, id, t = now()) {
  return transaction(db, () => {
    const u = db
      .prepare(
        "SELECT * FROM users WHERE id=? AND wallet IS NOT NULL AND deleted IS NULL",
      )
      .get(id);
    if (!u || u.holder_cycle == null || u.holder_cycle > t - CYCLE_MS)
      return null;
    // No successful read in 48 hours: wait for one, don't reset.
    if (!fresh(u, t)) return null;
    const tier = tierFor(cfg, u.holder_low);
    if (!tier) {
      db.prepare(
        "UPDATE users SET holder_cycle=NULL,holder_low=NULL,holder_paid=0 WHERE id=? AND holder_cycle=?",
      ).run(u.id, u.holder_cycle);
      return null;
    }
    const { units, bonus } = cycleAmount(cfg, tier, u.holder_paid);
    const ref = `holder_reward_${u.id}_${u.holder_cycle}`;
    if (units > 0) {
      db.prepare(
        "INSERT INTO holder_rewards(user_id,cycle_start,paid,tier,amount,bonus,ref) VALUES(?,?,?,?,?,?,?)",
      ).run(u.id, u.holder_cycle, t, tier.id, units, bonus ? 1 : 0, ref);
      db.prepare(
        "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        uid("l_"),
        u.id,
        units,
        "holder_reward",
        ref,
        null,
        rewardDescription(tier, bonus),
        t,
      );
    }
    // The next cycle opens now, starting from the latest read. A tier whose
    // amount is 0 pays nothing and leaves the paid run as it was.
    const moved = db
      .prepare(
        "UPDATE users SET holder_cycle=?,holder_low=?,holder_paid=holder_paid+? WHERE id=? AND holder_cycle=?",
      )
      .run(t, u.token_balance, units > 0 ? 1 : 0, u.id, u.holder_cycle);
    if (moved.changes !== 1) throw Error("The holder cycle moved during payout.");
    return units > 0
      ? { user: u.id, cycleStart: u.holder_cycle, tier: tier.id, amount: units, bonus }
      : null;
  });
}

// The worker's pass: every account whose cycle is 30 days old and has a
// read from the last 48 hours. One account's failure never stops the rest.
export function settleHolderCycles(db, cfg, t = now()) {
  if (!programLive(cfg) || !tokenChecks(cfg)) return [];
  const due = db
    .prepare(
      "SELECT id FROM users WHERE holder_cycle IS NOT NULL AND holder_cycle<=? AND token_checked>=? AND wallet IS NOT NULL AND deleted IS NULL ORDER BY holder_cycle LIMIT 200",
    )
    .all(t - CYCLE_MS, t - CHECK_MAX_AGE);
  const paid = [];
  for (const { id } of due) {
    try {
      const result = settleCycle(db, cfg, id, t);
      if (result) paid.push(result);
    } catch (e) {
      console.error("A holder reward could not be settled; it will retry:", e.message);
    }
  }
  return paid;
}

// ---- Perks ----

// Holder tier and up: "Bigger library", twice the retention caps. Used
// wherever conversations and media are pruned. An account that drops
// below the tier loses nothing at once: the standard caps apply again, so
// the oldest items beyond them go as new ones are saved.
export const retentionCaps = (cfg, user, t = now()) =>
  level(cfg, user, t) >= 1 ? { ...HOLDER_CAPS } : { ...BASE_CAPS };
export function capsFor(db, cfg, userId, t = now()) {
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  return retentionCaps(cfg, user, t);
}

// Insider and up: early access.
export const earlyAccessHolder = (cfg, user, t = now()) =>
  level(cfg, user, t) >= 2;
export const earlyAccessOn = earlyAccessHolder;

// Inner Circle: one advisory roadmap vote per UTC month, for an update
// that's registered but not released or open early.
export const monthOf = (t) => new Date(t).toISOString().slice(0, 7);
export const voteCandidates = (cfg) =>
  UPDATES.filter(
    (u) => u.id !== "holders" && !isReleased(cfg, u.id) && !earlyOpen(cfg, u.id),
  ).map((u) => ({ id: u.id, title: u.title }));

export function castVote(db, cfg, user, updateId, t = now()) {
  if (level(cfg, user, t) < 3)
    fail(403, "The roadmap vote is for Inner Circle accounts.", "inner_circle_only");
  if (!voteCandidates(cfg).some((c) => c.id === updateId))
    fail(400, "Choose an update that isn't released yet.", "invalid_vote");
  // One row per account per month: voting again changes the vote.
  db.prepare(
    "INSERT INTO roadmap_votes(month,user_id,update_id,created,updated) VALUES(?,?,?,?,?) ON CONFLICT(month,user_id) DO UPDATE SET update_id=excluded.update_id,updated=excluded.updated",
  ).run(monthOf(t), user.id, updateId, t, t);
}

// This month's totals, counts only. A vote counts while its account is
// still Inner Circle, so passing the same NYMA between accounts doesn't
// multiply it.
export function voteTally(db, cfg, t = now()) {
  const month = monthOf(t);
  const candidates = voteCandidates(cfg);
  const counts = new Map(candidates.map((c) => [c.id, 0]));
  for (const row of db
    .prepare(
      "SELECT v.update_id vote,u.* FROM roadmap_votes v JOIN users u ON u.id=v.user_id WHERE v.month=?",
    )
    .all(month))
    if (counts.has(row.vote) && level(cfg, row, t) >= 3)
      counts.set(row.vote, counts.get(row.vote) + 1);
  return {
    month,
    candidates: candidates.map((c) => ({ ...c, votes: counts.get(c.id) })),
  };
}

// ---- What the account and the public see ----

// Credits paid and holders rewarded over the 30 whole UTC days before
// today. Aggregates only, and they change once a day, so they can't be
// matched to one account's payout time.
export function rewardsSummary(db, t = now()) {
  const d = new Date(t);
  const until = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const since = until - CYCLE_MS;
  const row = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) amount,COUNT(DISTINCT user_id) holders FROM holder_rewards WHERE paid>=? AND paid<?",
    )
    .get(since, until);
  return { since, until, credits: credits(row.amount), holders: row.holders };
}

// Account → NYMA holdings: this account's own program state.
export function holdingsFor(db, cfg, user, t = now()) {
  const tier = currentTier(cfg, user, t);
  const open = !!user.wallet && user.holder_cycle != null;
  const cycleTier = open ? tierFor(cfg, user.holder_low) : null;
  const due = cycleAmount(cfg, cycleTier, user.holder_paid || 0);
  const ends = open ? user.holder_cycle + CYCLE_MS : null;
  const last = db
    .prepare(
      "SELECT * FROM holder_rewards WHERE user_id=? ORDER BY paid DESC,rowid DESC LIMIT 1",
    )
    .get(user.id);
  const vote = voteTally(db, cfg, t);
  const mine = db
    .prepare("SELECT update_id FROM roadmap_votes WHERE month=? AND user_id=?")
    .get(vote.month, user.id)?.update_id;
  return {
    checks: tokenChecks(cfg),
    tier: tier ? { id: tier.id, name: tier.name, level: tier.level } : null,
    cycle: open
      ? {
          start: user.holder_cycle,
          ends,
          daysLeft: Math.max(0, Math.ceil((ends - t) / DAY)),
          low: Number(user.holder_low),
          // Due, but no successful read in 48 hours: it waits for one.
          waiting: !fresh(user, t),
          due: { credits: credits(due.units), bonus: due.bonus },
        }
      : null,
    paidInARow: user.holder_paid || 0,
    loyalty: holderLoyalty(cfg),
    lastReward: last
      ? {
          credits: credits(last.amount),
          tier: last.tier,
          bonus: !!last.bonus,
          paid: last.paid,
        }
      : null,
    caps: retentionCaps(cfg, user, t),
    vote: {
      month: vote.month,
      open: (tier?.level ?? 0) >= 3,
      choice: vote.candidates.some((c) => c.id === mine) ? mine : null,
      candidates: vote.candidates.map(({ id, title }) => ({ id, title })),
    },
  };
}

// For the account's own session JSON only: the early updates it can use
// now, its tier and early-access status. /api/config and every public page
// stay the same for everyone.
export function earlyAccessFor(cfg, user, t = now()) {
  const eligible = earlyAccessOn(cfg, user, t);
  return {
    earlyAccess: eligible ? earlyUpdates(cfg) : [],
    holder: {
      eligible,
      threshold: earlyAccessThreshold(cfg),
      tier: currentTier(cfg, user, t)?.id ?? null,
    },
  };
}

// For releaseGuard (server/releases.js): whether a request comes from an
// early-access holder. It runs before the routes, so it identifies the
// account exactly the way the route that follows will:
// - /v1 and /mcp: only the account's own API key (a Bearer secret). The
//   session cookie is ignored there, since those routes ignore it too.
// - /mcp with a connected app's OAuth access token: never. An outside app
//   must not learn that the account holds NYMA, so it gets the same
//   403 feature_unreleased as everyone else.
// - every other route: the session cookie.
export function requestHolder(db, cfg) {
  const liveUser = (id) =>
    db.prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL").get(id);
  return (req) => {
    const p = String(req.path).toLowerCase();
    let user = null;
    if (p === "/v1" || p.startsWith("/v1/") || p === "/mcp" || p.startsWith("/mcp/")) {
      const bearer = req.headers?.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!bearer || bearer.startsWith(ACCESS_PREFIX)) return false;
      // A connected app's own key has no secret; excluded all the same.
      const key = db
        .prepare(
          "SELECT user_id FROM api_keys WHERE hash=? AND revoked IS NULL AND connection_id IS NULL",
        )
        .get(hash(bearer));
      user = key ? liveUser(key.user_id) : null;
    } else {
      const token = req.cookies?.anonyma_session;
      const session =
        typeof token === "string" && token
          ? db
              .prepare("SELECT user_id FROM sessions WHERE hash=? AND expires>?")
              .get(hash(token), now())
          : null;
      user = session ? liveUser(session.user_id) : null;
    }
    return earlyAccessOn(cfg, user);
  };
}
