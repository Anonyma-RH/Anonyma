import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from "node:crypto";
import { hash, now, fail, uid } from "./core.js";

// Two-Step Sign-in: an authenticator app code (TOTP, RFC 6238: HMAC-SHA-1,
// 6 digits, 30-second steps) after a correct password, email code, password
// reset or wallet signature, before any session exists. Ten single-use
// recovery codes stand in for the app. API keys and connected apps are
// separate credentials and never ask for it.
export const STEP_MS = 30000;
export const DIGITS = 6;
// A code from the step before or after the server's is accepted too, for
// clock drift and typing time.
export const WINDOW = 1;
export const RECOVERY_COUNT = 10;
// Recovery codes: 16 characters from the RFC 4648 base32 alphabet (80
// bits), shown as four groups of four.
export const RECOVERY_LENGTH = 16;
// A started setup (secret shown, no code confirmed yet) lasts this long.
export const SETUP_MS = 15 * 60000;
// After the first step, the code must follow within this time and within
// this many tries, or the sign-in starts over.
export const PENDING_MS = 5 * 60000;
export const PENDING_ATTEMPTS = 5;
// Wrong codes for one account (any sign-in or settings change): this many
// within FAIL_WINDOW_MS locks code entry for LOCK_MS.
export const MAX_FAILURES = 5;
export const FAIL_WINDOW_MS = 15 * 60000;
export const LOCK_MS = 15 * 60000;
// Turning two-step on and new recovery codes need this session to have
// confirmed it's its owner (password, or a fresh email code or wallet
// signature for accounts without one) within this time.
export const REAUTH_MS = 10 * 60000;
// How an account confirms it's its owner: its password when it has one,
// otherwise a code sent to its email or a signature from its wallet.
export const reauthMethods = (user) =>
  user.password
    ? ["password"]
    : [user.email && "email", user.wallet && "wallet"].filter(Boolean);
export const ISSUER = "Anonyma";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32Encode(bytes) {
  let bits = 0,
    value = 0,
    out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(text) {
  const clean = String(text)
    .toUpperCase()
    .replace(/[\s=-]/g, "");
  let bits = 0,
    value = 0;
  const out = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw Error("Invalid base32.");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// RFC 4226 HOTP with RFC 6238's time counter. `algorithm` is for the RFC's
// own test vectors; accounts always use SHA-1, the one every authenticator
// app supports.
export function hotp(key, counter, digits = DIGITS, algorithm = "sha1") {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** digits).padStart(digits, "0");
}
export const stepAt = (ms) => Math.floor(ms / STEP_MS);
export const totp = (key, ms, digits = DIGITS, algorithm = "sha1") =>
  hotp(key, stepAt(ms), digits, algorithm);

const sameText = (a, b) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

// The step a 6-digit code belongs to, within ±WINDOW of `at`, that is later
// than `lastStep` (a code is good once: RFC 6238 §5.2). Returns
// { step } on a match, { replay: true } when it matches only steps already
// used, or null.
export function matchTotp(key, code, { at = now(), lastStep = null } = {}) {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(at);
  let replay = false;
  for (const step of [current, current - 1, current + 1]) {
    if (!sameText(hotp(key, step), code)) continue;
    if (lastStep == null || step > lastStep) return { step };
    replay = true;
  }
  return replay ? { replay: true } : null;
}

export const newSecret = () => randomBytes(20);

// The label an authenticator app shows: the username, else the email, else
// a shortened wallet, capped so the QR code stays small.
export function accountLabel(user) {
  const w = user.wallet;
  const name =
    user.username ||
    user.email ||
    (w ? w.slice(0, 6) + "…" + w.slice(-4) : "account");
  return String(name).slice(0, 64);
}
export function otpauthUri(secretB32, label) {
  const l = encodeURIComponent(ISSUER) + ":" + encodeURIComponent(label);
  return `otpauth://totp/${l}?secret=${secretB32}&issuer=${encodeURIComponent(ISSUER)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_MS / 1000}`;
}

// The secret at rest: AES-256-GCM under a key derived from the app secret
// (APP_SECRET, or the generated one in the media folder), bound to the
// account so a row can't be moved to another. Losing the app secret makes
// authenticator codes uncheckable; recovery codes don't depend on it.
const keyFor = (appSecret) =>
  createHmac("sha256", appSecret).update("anonyma two-step secret v1").digest();
export function sealSecret(appSecret, userId, secret) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFor(appSecret), iv);
  c.setAAD(Buffer.from("two-step:" + userId));
  const body = Buffer.concat([c.update(secret), c.final()]);
  return (
    "v1." + Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url")
  );
}
export function openSecret(appSecret, userId, sealed) {
  if (typeof sealed !== "string" || !sealed.startsWith("v1."))
    throw Error("Unknown two-step secret format.");
  const raw = Buffer.from(sealed.slice(3), "base64url");
  const d = createDecipheriv(
    "aes-256-gcm",
    keyFor(appSecret),
    raw.subarray(0, 12),
  );
  d.setAAD(Buffer.from("two-step:" + userId));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

// Recovery codes, lowercase: "abcd-efgh-ijkl-mnop". Typed codes may use
// any case, spaces or dashes. Stored only as a hash salted with the
// account id; 80 random bits make them impractical to guess from a hash.
export function newRecoveryCode() {
  let s = "";
  for (let i = 0; i < RECOVERY_LENGTH; i++) s += B32[randomInt(32)];
  return s.toLowerCase().match(/.{4}/g).join("-");
}
export const normalizeRecovery = (code) =>
  String(code).toLowerCase().replace(/[\s-]/g, "");
export const recoveryHash = (userId, code) =>
  hash("anonyma two-step recovery:" + userId + ":" + normalizeRecovery(code));
export const looksLikeRecovery = (code) =>
  new RegExp(`^[a-z2-7]{${RECOVERY_LENGTH}}$`).test(normalizeRecovery(code));

// Database access for one app: the settings row, recovery codes, pending
// sign-ins, failures and the lock.
export function createTwoStep(db, cfg) {
  const row = (userId) =>
    db.prepare("SELECT * FROM two_step WHERE user_id=?").get(userId);
  const isOn = (userId) =>
    !!db
      .prepare("SELECT 1 FROM two_step WHERE user_id=? AND enabled=1")
      .get(userId);
  const codesLeft = (userId) =>
    db
      .prepare(
        "SELECT COUNT(*) n FROM two_step_recovery WHERE user_id=? AND used IS NULL",
      )
      .get(userId).n;

  function assertUnlocked(r, res) {
    const t = now();
    if (r?.locked_until > t) {
      const minutes = Math.ceil((r.locked_until - t) / 60000);
      res?.set("Retry-After", String(Math.ceil((r.locked_until - t) / 1000)));
      fail(
        429,
        minutes === 1
          ? "Too many incorrect codes. Try again in 1 minute."
          : `Too many incorrect codes. Try again in ${minutes} minutes.`,
        "two_step_locked",
      );
    }
  }
  // A wrong code: MAX_FAILURES within FAIL_WINDOW_MS locks the account's
  // code entry for LOCK_MS. The count starts over after the lock.
  function recordFailure(userId) {
    const r = row(userId);
    if (!r) return;
    const t = now();
    const fresh = r.failed_since != null && t - r.failed_since < FAIL_WINDOW_MS;
    const count = fresh ? r.failures + 1 : 1;
    if (count >= MAX_FAILURES)
      db.prepare(
        "UPDATE two_step SET failures=0,failed_since=NULL,locked_until=? WHERE user_id=?",
      ).run(t + LOCK_MS, userId);
    else
      db.prepare(
        "UPDATE two_step SET failures=?,failed_since=? WHERE user_id=?",
      ).run(count, fresh ? r.failed_since : t, userId);
  }
  const clearFailures = (userId) =>
    db
      .prepare(
        "UPDATE two_step SET failures=0,failed_since=NULL,locked_until=NULL WHERE user_id=?",
      )
      .run(userId);

  function secretOf(r) {
    try {
      return openSecret(cfg.secret, r.user_id, r.secret);
    } catch {
      fail(
        503,
        "Authenticator codes can't be checked on this server right now. Use a recovery code, or contact support.",
        "two_step_unavailable",
      );
    }
  }

  // Checks a code for an account with two-step on: an authenticator code,
  // or (when allowed) an unused recovery code, which is then spent. Wrong
  // codes count towards the lock; a replayed code is refused without
  // counting. Returns { method: "totp" | "recovery" }.
  function verify(userId, code, { recovery = true, res } = {}) {
    const r = row(userId);
    if (!r?.enabled) fail(409, "Two-step sign-in is off.", "two_step_off");
    assertUnlocked(r, res);
    const typed = typeof code === "string" ? code.trim().slice(0, 64) : "";
    const digits = typed.replace(/\s/g, "");
    if (/^\d{6}$/.test(digits)) {
      const m = matchTotp(secretOf(r), digits, { lastStep: r.last_step });
      if (m?.step != null) {
        // Only one request can move the step forward, so a code used by two
        // requests at once works for just one.
        const moved = db
          .prepare(
            "UPDATE two_step SET last_step=? WHERE user_id=? AND (last_step IS NULL OR last_step<?)",
          )
          .run(m.step, userId, m.step);
        if (moved.changes) {
          clearFailures(userId);
          return { method: "totp" };
        }
      }
      if (m)
        fail(
          401,
          "That code was already used. Wait for the next one.",
          "two_step_code_used",
        );
    } else if (recovery && looksLikeRecovery(typed)) {
      const spent = db
        .prepare(
          "UPDATE two_step_recovery SET used=? WHERE user_id=? AND hash=? AND used IS NULL",
        )
        .run(now(), userId, recoveryHash(userId, typed));
      if (spent.changes) {
        clearFailures(userId);
        return { method: "recovery" };
      }
    } else
      // Not a code at all: nothing was tried, so nothing counts.
      fail(
        400,
        recovery
          ? "Enter the 6-digit code from your authenticator app, or a recovery code."
          : "Enter the 6-digit code from your authenticator app.",
        "two_step_code_format",
      );
    recordFailure(userId);
    fail(
      401,
      recovery
        ? "That code didn’t work. Enter the current 6-digit code, or an unused recovery code."
        : "That code didn’t work. Enter the current 6-digit code from your authenticator app.",
      "two_step_invalid",
    );
  }

  // Replaces the account's recovery codes with ten new ones and returns
  // them; only their hashes are kept.
  function issueRecoveryCodes(userId) {
    const codes = Array.from({ length: RECOVERY_COUNT }, newRecoveryCode);
    db.prepare("DELETE FROM two_step_recovery WHERE user_id=?").run(userId);
    const insert = db.prepare(
      "INSERT INTO two_step_recovery(user_id,hash,created) VALUES(?,?,?)",
    );
    for (const c of codes) insert.run(userId, recoveryHash(userId, c), now());
    return codes;
  }

  // After a correct first step: a short-lived sign-in waiting for the code.
  // `payload` carries what the first step would have changed (a password
  // reset's new password hash), applied only once the code is right.
  function begin(user, method, payload = null) {
    const token = uid("twostep_");
    db.prepare("DELETE FROM two_step_pending WHERE expires<?").run(now());
    db.prepare(
      "INSERT INTO two_step_pending(hash,user_id,method,payload,expires,created) VALUES(?,?,?,?,?,?)",
    ).run(
      hash(token),
      user.id,
      method,
      payload ? JSON.stringify(payload) : null,
      now() + PENDING_MS,
      now(),
    );
    return {
      twoStep: {
        token,
        method,
        expires: now() + PENDING_MS,
      },
    };
  }
  function pending(token) {
    const p =
      typeof token === "string" && token.length <= 200
        ? db
            .prepare("SELECT * FROM two_step_pending WHERE hash=?")
            .get(hash(token))
        : null;
    if (!p || p.expires < now() || p.attempts >= PENDING_ATTEMPTS) {
      if (p)
        db.prepare("DELETE FROM two_step_pending WHERE hash=?").run(p.hash);
      fail(400, "This sign-in expired. Sign in again.", "two_step_expired");
    }
    return p;
  }

  return {
    row,
    isOn,
    codesLeft,
    verify,
    issueRecoveryCodes,
    begin,
    pending,
    secretOf,
  };
}
