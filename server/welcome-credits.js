import { now, hash, fail, uid, balance, transaction } from "./core.js";

// Welcome Credits: every account starts with free credits to try Anonyma
// (WELCOME_CREDITS: 500 in production by default, 0 turns them off). A new
// account gets them at sign-up (grantWelcome, from newUser in
// server/auth.js); accounts from before the launch get them once, on the
// first start after it (backfillWelcome, from createApp).
//
// They're for trying requests, not for moving around:
//  - Requests spend them before paid credit, and they can't be sent, gifted
//    or contributed to a treasury (assertTransferable), so accounts made to
//    collect them can't pool them.
//  - New grants are limited per network address and per day across the site
//    (WELCOME_PER_ADDRESS_DAILY, WELCOME_DAILY_MAX). Over either limit the
//    account is still created, just without the credits.
//
// An account's grant is one ledger row (kind 'welcome', ref
// 'welcome:<account id>'); the ref is unique, so nothing grants it twice.

export const WELCOME_KIND = "welcome";
export const WELCOME_DESCRIPTION = "Free credits to try Anonyma";
// Accounts created before this get the backfill; later ones only at sign-up.
export const WELCOME_LAUNCH = Date.UTC(2026, 8, 30, 5, 30);
const DAY = 86400000;
const PER_CREDIT = 10000; // ledger units per credit

export const welcomeUnits = (cfg) => (cfg.welcomeCredits || 0) * PER_CREDIT;
const refFor = (user) => "welcome:" + user;
const record = (db, user, units, at) =>
  db
    .prepare(
      "INSERT OR IGNORE INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(uid("l_"), user, units, WELCOME_KIND, refFor(user), null, WELCOME_DESCRIPTION, at)
    .changes === 1;

// Grants a new account its welcome credits unless a daily limit is reached.
// Addresses are counted by hash in rate_events, which keeps a day of them.
export function grantWelcome(db, cfg, user, address, at = now()) {
  const units = welcomeUnits(cfg);
  if (!units) return false;
  const since = at - DAY;
  const count = (sql, ...args) => db.prepare(sql).get(...args).n;
  if (
    count(
      "SELECT COUNT(*) n FROM rate_events WHERE kind='welcome' AND created>?",
      since,
    ) >= cfg.welcomeDailyMax
  )
    return false;
  const target = address ? hash("welcome:" + address) : null;
  if (
    target &&
    count(
      "SELECT COUNT(*) n FROM rate_events WHERE kind='welcome' AND target=? AND created>?",
      target,
      since,
    ) >= cfg.welcomePerAddress
  )
    return false;
  db.prepare("INSERT INTO rate_events(kind,target,created) VALUES(?,?,?)").run(
    "welcome",
    target,
    at,
  );
  return record(db, user, units, at);
}

// Every open account created before the launch gets its welcome credits;
// one already granted is skipped. Collab treasuries are ledger accounts
// marked deleted from the start, so they never qualify. Returns how many
// accounts were granted.
export function backfillWelcome(db, cfg, at = now()) {
  const units = welcomeUnits(cfg);
  if (!units) return 0;
  return transaction(db, () => {
    let granted = 0;
    for (const { id } of db
      .prepare(
        "SELECT id FROM users WHERE deleted IS NULL AND created<? AND NOT EXISTS (SELECT 1 FROM ledger WHERE ref='welcome:' || users.id)",
      )
      .all(WELCOME_LAUNCH))
      if (record(db, id, units, at)) granted++;
    return granted;
  });
}

// The welcome credits requests haven't spent yet. Requests spend them
// first: every request charge settled since the grant, and every hold still
// open, counts against them.
export function welcomeLeft(db, user) {
  const grant = db
    .prepare("SELECT amount, created FROM ledger WHERE ref=?")
    .get(refFor(user));
  if (!grant) return 0;
  const spent = -db
    .prepare(
      `SELECT COALESCE(SUM(l.amount),0) n FROM ledger l WHERE l.user_id=? AND l.amount<0 AND l.created>=?
        AND EXISTS (SELECT 1 FROM holds h WHERE h.id=l.ref AND h.user_id=l.user_id)`,
    )
    .get(user, grant.created).n;
  const held = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM holds WHERE user_id=? AND status='held'",
    )
    .get(user).n;
  return Math.max(0, grant.amount - spent - held);
}

// Refuses (402 welcome_credits_locked) credits leaving the account that
// only its unspent welcome credits could cover. Call it inside the
// transaction that moves them, after the insufficient_credits check.
export function assertTransferable(db, user, units) {
  const locked = welcomeLeft(db, user);
  if (locked && balance(db, user).available - locked < units)
    fail(
      402,
      "Free welcome credits can only be spent on requests. They can't be sent, gifted or added to a treasury.",
      "welcome_credits_locked",
    );
}
