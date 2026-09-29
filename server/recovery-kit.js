import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { hash, now, fail, uid } from "./core.js";
import { isReleased } from "./releases.js";
import { REAUTH_MS as TWO_STEP_REAUTH_MS } from "./two-step.js";
import { REAUTH_MS as PASSKEY_REAUTH_MS } from "./passkeys.js";
import {
  KIT_SIZE,
  KIT_PENDING_MINUTES,
  KIT_USERNAME_TRIES,
  KIT_ADDRESS_TRIES,
  kitCodeFromBytes,
  KIT_RANDOM_SYMBOLS,
} from "../src/recovery-kit.js";

// Recovery Kit (update "recovery"): ten one-time codes that get an account
// back in with its username, for accounts without an email to reset from.
//
// Storage. Each code is kept only as a scrypt digest (the password KDF, with
// node's defaults, as passwordHash in core.js), under a random salt for the
// kit, so a sign-in attempt costs one derivation however many codes are
// left. No pepper: like Two-Step Sign-in's recovery codes, a kit keeps
// working if the installation secret is lost. 95 random bits a code make a
// stolen database useless for finding one.
//
// Checking. The typed code is derived once and compared with every one of
// the account's ten digests with timingSafeEqual, without stopping at a
// match. An unknown username, or one without a kit, is derived against a
// fixed salt the same way, and all of them get the same answer. A code is
// spent by a conditional update, so two requests with one code can't both
// win.
//
// Lockouts. Every attempt counts against the username (5 an hour) and the
// network address (10 an hour) before the check runs, and a right code
// gives both back, so a burst of parallel requests can't slip past the
// limit. Past it, every attempt is refused, a right code too, until the
// hour is up. The counters are keyed by an HMAC under the installation
// secret: no username or address is stored.
//
// After a right code. Every session, sign-in waiting for a code, "confirm
// it's you" mark and pending email sign-in code is gone, and the browser
// gets a short-lived token that can do exactly one thing: set a new
// password or add a passkey. Only then does a session start, without
// Two-Step Sign-in's code or an email code: this is the one path that skips
// them. Two-step itself stays on for later sign-ins. API keys and connected
// apps are separate credentials and keep working.

export const PENDING_MS = KIT_PENDING_MINUTES * 60000;
export const LOCK_WINDOW = 3600000;
export const USERNAME_TRIES = KIT_USERNAME_TRIES;
export const ADDRESS_TRIES = KIT_ADDRESS_TRIES;
// scrypt's output length, as the password hash uses.
const DIGEST_BYTES = 64;
// A salt for usernames without a kit, so every attempt costs the same.
const NO_KIT_SALT = "0".repeat(32);

export const newKitCode = () => kitCodeFromBytes(randomBytes(KIT_RANDOM_SYMBOLS));
export const newKitSalt = () => randomBytes(16).toString("hex");

// A code's digest: scrypt of its 20 symbols (already normalised) under the
// kit's salt. Asynchronous, so a derivation never blocks other requests.
export const kitDigest = (symbols, salt) =>
  new Promise((resolve, reject) =>
    scrypt("anonyma recovery kit v1:" + symbols, salt, DIGEST_BYTES, (e, key) =>
      e ? reject(e) : resolve(key),
    ),
  );
// Which of `rows` (each with a hex digest) matches `digest`: every row is
// compared, a match doesn't stop the loop, and the comparison is constant
// time. Returns the matching row or null.
export function matchDigest(rows, digest) {
  let found = null;
  for (const r of rows) {
    const stored = Buffer.from(r.digest, "hex");
    const same = stored.length === digest.length && timingSafeEqual(stored, digest);
    if (same && !found) found = r;
  }
  return found;
}

// "Confirm it's you" for a session: the newer of Two-Step Sign-in's
// confirmation (password, email code or wallet signature) and a passkey's,
// exactly as Passkeys' settings read it (server/routes/passkeys.js).
export function reauthUntil(db, sessionHash, userId) {
  const a = db
    .prepare("SELECT at FROM two_step_reauth WHERE session_hash=? AND user_id=?")
    .get(sessionHash, userId)?.at;
  const b = db
    .prepare("SELECT at FROM passkey_reauth WHERE session_hash=? AND user_id=?")
    .get(sessionHash, userId)?.at;
  const until = Math.max(
    a != null ? a + TWO_STEP_REAUTH_MS : 0,
    b != null ? b + PASSKEY_REAUTH_MS : 0,
  );
  return until > now() ? until : null;
}

// The kit as its owner, the account export and the settings see it. Never
// a code or a digest.
export function kitView(db, userId) {
  const kit = db.prepare("SELECT created FROM recovery_kits WHERE user_id=?").get(userId);
  if (!kit) return null;
  const codes = db
    .prepare("SELECT used FROM recovery_kit_codes WHERE user_id=?")
    .all(userId);
  const used = codes.map((c) => c.used).filter((u) => u != null);
  return {
    created: kit.created,
    total: KIT_SIZE,
    unused: codes.length - used.length,
    lastUsed: used.length ? Math.max(...used) : null,
  };
}
export const exportRecoveryKit = kitView;

// Account closure: the kit, its codes, a pending recovery and the nudge.
export function forgetRecoveryKit(db, userId) {
  db.prepare("DELETE FROM recovery_kit_codes WHERE user_id=?").run(userId);
  db.prepare("DELETE FROM recovery_kits WHERE user_id=?").run(userId);
  db.prepare("DELETE FROM recovery_pending WHERE user_id=?").run(userId);
  db.prepare("DELETE FROM recovery_nudges WHERE user_id=?").run(userId);
}

// Whether the account gets the one-time nudge: no email to reset from, only
// one kind of way in (a password, or passkeys), a username to recover with,
// no kit yet and never dismissed.
export function nudgeDue(db, user) {
  if (!user.username || user.email || user.wallet) return false;
  const passkeys = db
    .prepare("SELECT COUNT(*) n FROM passkeys WHERE user_id=?")
    .get(user.id).n;
  if (!!user.password === passkeys > 0) return false;
  if (db.prepare("SELECT 1 FROM recovery_kits WHERE user_id=?").get(user.id)) return false;
  return !db.prepare("SELECT 1 FROM recovery_nudges WHERE user_id=?").get(user.id);
}

// Signs the account out everywhere and drops everything that could still
// become a session: sign-ins waiting for a two-step code (a waiting email
// reset included), "confirm it's you" marks, started passkey ceremonies,
// other pending recoveries and pending email sign-in codes. Inside the
// caller's transaction.
export function revokeAccess(db, user) {
  db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
  db.prepare("DELETE FROM two_step_pending WHERE user_id=?").run(user.id);
  db.prepare("DELETE FROM two_step_reauth WHERE user_id=?").run(user.id);
  db.prepare("DELETE FROM passkey_reauth WHERE user_id=?").run(user.id);
  db.prepare("DELETE FROM passkey_challenges WHERE user_id=?").run(user.id);
  db.prepare("DELETE FROM recovery_pending WHERE user_id=?").run(user.id);
  if (user.email)
    db.prepare(
      "DELETE FROM challenges WHERE target=? AND purpose IN ('login','recover')",
    ).run(user.email);
}

// Database access for one app.
export function createRecoveryKit(db, cfg) {
  const live = () => isReleased(cfg, "recovery");

  // ---- Lockouts ----
  const lockKey = (subject) =>
    createHmac("sha256", cfg.secret)
      .update("anonyma recovery kit lockout v1:" + subject)
      .digest("hex");
  const keysFor = (username, ip) => [
    { key: lockKey("username:" + String(username).toLowerCase()), max: USERNAME_TRIES },
    { key: lockKey("address:" + ip), max: ADDRESS_TRIES },
  ];
  // Refuses when either counter is spent, otherwise counts this attempt on
  // both. One synchronous step, so parallel attempts are counted one by one.
  function takeAttempt(keys, res) {
    const t = now();
    db.prepare("DELETE FROM recovery_lockouts WHERE window_end<=?").run(t);
    for (const { key, max } of keys) {
      const row = db
        .prepare("SELECT attempts,window_end FROM recovery_lockouts WHERE key=?")
        .get(key);
      if (row && row.attempts >= max) {
        const wait = row.window_end - t;
        res?.set("Retry-After", String(Math.max(1, Math.ceil(wait / 1000))));
        fail(
          429,
          `Too many recovery attempts. Try again in ${Math.max(1, Math.ceil(wait / 60000))} min.`,
          "recovery_locked",
        );
      }
    }
    for (const { key } of keys)
      db.prepare(
        `INSERT INTO recovery_lockouts(key,attempts,window_end) VALUES(?,1,?)
         ON CONFLICT(key) DO UPDATE SET attempts=attempts+1`,
      ).run(key, t + LOCK_WINDOW);
  }
  // A right code: the username's count starts over and the address gets
  // this attempt back.
  function giveBack(keys) {
    const [username, address] = keys;
    db.prepare("DELETE FROM recovery_lockouts WHERE key=?").run(username.key);
    db.prepare(
      "UPDATE recovery_lockouts SET attempts=MAX(attempts-1,0) WHERE key=?",
    ).run(address.key);
  }

  // ---- Making a kit ----
  // Ten new codes; the old ones, and a recovery waiting on one of them,
  // stop working. Returns the codes (the only time they exist in the clear)
  // and the kit's date.
  async function issue(userId) {
    const codes = Array.from({ length: KIT_SIZE }, newKitCode);
    const salt = newKitSalt();
    const digests = await Promise.all(
      codes.map((c) => kitDigest(c.replace(/-/g, ""), salt)),
    );
    return {
      codes,
      // Written by the caller inside its transaction, after its own checks.
      store() {
        const created = now();
        db.prepare("DELETE FROM recovery_kit_codes WHERE user_id=?").run(userId);
        db.prepare("DELETE FROM recovery_pending WHERE user_id=?").run(userId);
        db.prepare(
          `INSERT INTO recovery_kits(user_id,salt,created) VALUES(?,?,?)
           ON CONFLICT(user_id) DO UPDATE SET salt=excluded.salt,created=excluded.created`,
        ).run(userId, salt, created);
        const insert = db.prepare(
          "INSERT INTO recovery_kit_codes(user_id,slot,digest,used) VALUES(?,?,?,NULL)",
        );
        digests.forEach((d, i) => insert.run(userId, i + 1, d.toString("hex")));
        return created;
      },
    };
  }

  // ---- Using a code ----
  // Checks `symbols` (a well-formed code) for `username`. Resolves to the
  // account and the code's slot and digest when it's right and unused;
  // otherwise refuses with the same answer for an unknown username, a
  // username without a kit and a wrong code. A code already used says so:
  // only someone holding the code learns it.
  async function check(username, symbols, req, res) {
    const keys = keysFor(username, req.ip);
    takeAttempt(keys, res);
    const user = db
      .prepare("SELECT * FROM users WHERE username=? COLLATE NOCASE AND deleted IS NULL")
      .get(username);
    const kit = user
      ? db.prepare("SELECT salt FROM recovery_kits WHERE user_id=?").get(user.id)
      : null;
    const digest = await kitDigest(symbols, kit?.salt ?? NO_KIT_SALT);
    const rows = kit
      ? db
          .prepare("SELECT slot,digest,used FROM recovery_kit_codes WHERE user_id=?")
          .all(user.id)
      : [];
    const match = matchDigest(rows, digest);
    if (!match)
      fail(401, "That username and code don’t match.", "recovery_invalid");
    if (match.used != null)
      fail(
        401,
        "That code was already used. Each code works once; try another from your kit.",
        "recovery_code_used",
      );
    return { user, match, keys };
  }
  // Spends the code and starts the recovery, inside the caller's
  // transaction: every other way in is signed out, and the token that can
  // set a new password or add a passkey is returned. False when the code
  // was spent (or the kit replaced) in the meantime.
  function begin(user, match) {
    const spent = db
      .prepare(
        "UPDATE recovery_kit_codes SET used=? WHERE user_id=? AND slot=? AND digest=? AND used IS NULL",
      )
      .run(now(), user.id, match.slot, match.digest);
    if (!spent.changes) return null;
    revokeAccess(db, user);
    const token = uid("kitrec_");
    const t = now();
    db.prepare(
      "INSERT INTO recovery_pending(hash,user_id,expires,created) VALUES(?,?,?,?)",
    ).run(hash(token), user.id, t + PENDING_MS, t);
    return { token, expires: t + PENDING_MS };
  }
  // The recovery a token names, and its account.
  function pending(token) {
    db.prepare("DELETE FROM recovery_pending WHERE expires<?").run(now());
    const p =
      typeof token === "string" && token.length <= 200
        ? db.prepare("SELECT * FROM recovery_pending WHERE hash=?").get(hash(token))
        : null;
    const user = p
      ? db.prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL").get(p.user_id)
      : null;
    if (!p || !user)
      fail(
        400,
        "This recovery step expired. The code you used is spent; start again with another code from your kit.",
        "recovery_expired",
      );
    return { ...p, user };
  }
  // Ends a recovery once its new password or passkey is written, inside the
  // caller's transaction. False when the token was already used.
  function finish(p) {
    const gone = db.prepare("DELETE FROM recovery_pending WHERE hash=?").run(p.hash);
    if (!gone.changes) return false;
    revokeAccess(db, p.user);
    return true;
  }
  // A passkey ceremony started during a recovery is bound to it with this
  // value in passkey_challenges.session_hash, which no session's hash can
  // equal.
  const bindingOf = (p) => hash("anonyma recovery kit passkey:" + p.hash);

  return {
    live,
    keysFor,
    takeAttempt,
    giveBack,
    issue,
    check,
    begin,
    pending,
    finish,
    bindingOf,
  };
}
