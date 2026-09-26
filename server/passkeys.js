import { randomBytes } from "node:crypto";
import { isIP } from "node:net";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { hash, now, fail, uid } from "./core.js";
import { isReleased } from "./releases.js";

// Passkeys (update "passkeys"): WebAuthn sign-in with a device's own lock,
// Face ID, a fingerprint or a PIN. The browser proves it holds the private
// key; ANONYMA keeps only the public key. Every ceremony requires user
// verification, so a passkey sign-in counts as both of Two-Step Sign-in's
// factors and never asks for an authenticator code.
//
// The relying party is the host of APP_ORIGIN, and a response must come from
// exactly APP_ORIGIN. A challenge is single-use, lasts CHALLENGE_MS, and is
// bound to the session that asked for it, or (signing in and signing up,
// before any session exists) to a pending-sign-in cookie.
export const CHALLENGE_MS = 5 * 60000;
export const MAX_PASSKEYS = 10;
export const NAME_MAX = 40;
// Wrong answers from one passkey: this many within FAIL_WINDOW_MS lock it
// for LOCK_MS (the same numbers as Two-Step Sign-in's code lock).
export const MAX_FAILURES = 5;
export const FAIL_WINDOW_MS = 15 * 60000;
export const LOCK_MS = 15 * 60000;
// Adding or removing a passkey needs this session to have confirmed it's you
// within this time (as Two-Step Sign-in's settings do).
export const REAUTH_MS = 10 * 60000;
// The pending sign-in cookie: httpOnly, SameSite=Strict, only sent to the
// passkey sign-in routes, and only its hash is stored.
export const PENDING_COOKIE = "anonyma_passkey";
export const PENDING_PATH = "/api/auth/passkey";
// EdDSA, ES256 and RS256: what platform authenticators and security keys use.
export const ALGORITHMS = [-8, -7, -257];
// The label the authenticator shows for accounts without a username. Emails
// and wallet addresses are never sent to an authenticator or a passkey
// manager's sync.
export const DEFAULT_ACCOUNT_LABEL = "ANONYMA account";

// The WebAuthn RP ID: APP_ORIGIN's host name. Browsers refuse IP addresses as
// an RP ID, so an installation served from a bare IP can't offer passkeys.
export const rpIdOf = (cfg) => new URL(cfg.origin).hostname;
export function passkeysAvailable(cfg) {
  try {
    const u = new URL(cfg.origin);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    // WebAuthn needs a secure context: HTTPS, or http://localhost.
    const secure =
      u.protocol === "https:" ||
      host === "localhost" ||
      host.endsWith(".localhost");
    return !!host && !isIP(host) && secure;
  } catch {
    return false;
  }
}
export const passkeysLive = (cfg) =>
  isReleased(cfg, "passkeys") && passkeysAvailable(cfg);

// The WebAuthn user handle: 32 random bytes, never derived from the account.
export const newHandle = () => randomBytes(32).toString("base64url");

// A passkey's name: trimmed, single-spaced, no control characters, 1–40.
export function cleanName(value) {
  if (typeof value !== "string") return null;
  const name = value
    .replace(/\s+/g, " ")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  return name && [...name].length <= NAME_MAX ? name : null;
}

// Which ways an account can sign in. Email counts when an address is linked:
// an emailed code signs in without a password.
export function signInMethods(db, user) {
  const passkeys = db
    .prepare("SELECT COUNT(*) n FROM passkeys WHERE user_id=?")
    .get(user.id).n;
  return {
    password: !!user.password,
    email: !!user.email,
    wallet: !!user.wallet,
    passkeys,
  };
}
// Whether removing one passkey would leave the account without a way in.
export const lastWayIn = (m) =>
  !m.password && !m.email && !m.wallet && m.passkeys <= 1;

// The browser's response, checked for shape and size before anything reads
// it (the library does the WebAuthn checks). Returns the response or null.
const B64URL = /^[A-Za-z0-9_-]*$/;
const field = (v, max, optional = false) =>
  (optional && (v === undefined || v === null)) ||
  (typeof v === "string" && v.length <= max && B64URL.test(v));
export function cleanResponse(r, kind) {
  if (!r || typeof r !== "object" || Array.isArray(r)) return null;
  const inner = r.response;
  if (
    !field(r.id, 1400) ||
    !r.id ||
    r.rawId !== r.id ||
    r.type !== "public-key" ||
    !inner ||
    typeof inner !== "object" ||
    !field(inner.clientDataJSON, 8192) ||
    !inner.clientDataJSON
  )
    return null;
  if (kind === "create") {
    if (!field(inner.attestationObject, 65536) || !inner.attestationObject)
      return null;
    if (
      inner.transports !== undefined &&
      (!Array.isArray(inner.transports) ||
        inner.transports.length > 8 ||
        inner.transports.some((t) => typeof t !== "string" || t.length > 20))
    )
      return null;
  } else if (
    !field(inner.authenticatorData, 8192) ||
    !inner.authenticatorData ||
    !field(inner.signature, 8192) ||
    !inner.signature ||
    !field(inner.userHandle, 128, true)
  )
    return null;
  const ext = r.clientExtensionResults;
  if (ext !== undefined && (ext === null || typeof ext !== "object"))
    return null;
  return r;
}
// The challenge inside clientDataJSON, which names the stored ceremony.
export function challengeOf(response) {
  try {
    const data = JSON.parse(
      Buffer.from(response.response.clientDataJSON, "base64url").toString(),
    );
    return typeof data?.challenge === "string" &&
      data.challenge.length <= 128 &&
      B64URL.test(data.challenge)
      ? data.challenge
      : null;
  } catch {
    return null;
  }
}
// The sign counter in authenticatorData (bytes 33–36, big-endian).
export function counterOf(authenticatorData) {
  const b = Buffer.from(authenticatorData, "base64url");
  return b.length >= 37 ? b.readUInt32BE(33) : null;
}
// A counter that went backwards (or stood still) can mean a copied
// authenticator. Synced passkeys report 0 every time, which is allowed.
export const counterRegressed = (stored, next) =>
  (next > 0 || stored > 0) && next <= stored;

const bad = (message = "That passkey couldn’t be verified. Try again.") =>
  fail(401, message, "passkey_invalid");
const expired = () =>
  fail(
    400,
    "This passkey request expired or was already used. Try again.",
    "passkey_expired",
  );

// Database access and the WebAuthn ceremonies for one app.
export function createPasskeys(db, cfg) {
  const rpID = () => rpIdOf(cfg);
  function assertAvailable() {
    if (!passkeysAvailable(cfg))
      fail(
        503,
        "Passkeys need this service on a domain name over HTTPS.",
        "passkeys_unavailable",
      );
  }
  const list = (userId) =>
    db
      .prepare(
        "SELECT id,name,created,last_used,backed_up FROM passkeys WHERE user_id=? ORDER BY created,rowid",
      )
      .all(userId)
      .map((p) => ({
        id: p.id,
        name: p.name,
        created: p.created,
        lastUsed: p.last_used,
        synced: !!p.backed_up,
      }));
  // An account's passkeys share one handle, so an authenticator keeps one
  // passkey per account; the first gets a new random one.
  const handleOf = (userId) =>
    db
      .prepare("SELECT user_handle FROM passkeys WHERE user_id=? LIMIT 1")
      .get(userId)?.user_handle || newHandle();

  function store(purpose, challenge, fields) {
    const t = now();
    db.prepare("DELETE FROM passkey_challenges WHERE expires<?").run(t);
    db.prepare(
      "INSERT INTO passkey_challenges(id,purpose,challenge,user_id,session_hash,binding,username,user_handle,expires,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      uid("pkc_"),
      purpose,
      hash(challenge),
      fields.userId ?? null,
      fields.sessionHash ?? null,
      fields.binding ?? null,
      fields.username ?? null,
      fields.userHandle ?? null,
      t + CHALLENGE_MS,
      t,
    );
  }
  // Takes the ceremony a response answers, once: it's deleted whether or not
  // the response then verifies, so a response can never be replayed.
  function claim(purpose, response, where) {
    const challenge = challengeOf(response);
    if (!challenge) bad();
    const keys = Object.keys(where);
    const row = db
      .prepare(
        `DELETE FROM passkey_challenges WHERE challenge=? AND purpose=? ${keys.map((k) => `AND ${k}=?`).join(" ")} RETURNING *`,
      )
      .get(hash(challenge), purpose, ...keys.map((k) => where[k]));
    if (!row || row.expires < now()) expired();
    return { ...row, plain: challenge };
  }

  // Registration options for `user` (an account adding a passkey, or one
  // being created). Resident (discoverable) keys and user verification are
  // required; "none" attestation: which device made it isn't asked.
  async function registrationOptions({ userName, userHandle, exclude = [] }) {
    return generateRegistrationOptions({
      rpName: "ANONYMA",
      rpID: rpID(),
      userName,
      userDisplayName: userName,
      userID: Buffer.from(userHandle, "base64url"),
      timeout: CHALLENGE_MS,
      attestationType: "none",
      excludeCredentials: exclude.map((p) => ({
        id: p.credential_id,
        transports: p.transports ? JSON.parse(p.transports) : undefined,
      })),
      authenticatorSelection: {
        residentKey: "required",
        userVerification: "required",
      },
      supportedAlgorithmIDs: ALGORITHMS,
      extensions: { credProps: true },
    });
  }
  async function verifyCreate(response, row) {
    let v;
    try {
      v = await verifyRegistrationResponse({
        response,
        expectedChallenge: row.plain,
        expectedOrigin: cfg.origin,
        expectedRPID: rpID(),
        requireUserPresence: true,
        requireUserVerification: true,
        supportedAlgorithmIDs: ALGORITHMS,
      });
    } catch {
      bad();
    }
    if (!v?.verified) bad();
    // The browser says whether the key is discoverable; one that isn't
    // couldn't sign in without a username.
    if (response.clientExtensionResults?.credProps?.rk === false)
      fail(
        400,
        "This authenticator couldn’t save a passkey that signs in on its own. Try your phone or computer’s built-in passkeys.",
        "passkey_not_discoverable",
      );
    const { credential, credentialBackedUp } = v.registrationInfo;
    if (
      db
        .prepare("SELECT 1 FROM passkeys WHERE credential_id=?")
        .get(credential.id)
    )
      fail(409, "This passkey is already added.", "passkey_exists");
    return {
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports?.length
        ? JSON.stringify(credential.transports.slice(0, 8))
        : null,
      backedUp: credentialBackedUp ? 1 : 0,
    };
  }
  function insert(userId, userHandle, made, name) {
    const id = uid("pk_");
    try {
      db.prepare(
        "INSERT INTO passkeys(id,user_id,credential_id,public_key,counter,user_handle,transports,backed_up,name,created) VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        userId,
        made.credentialId,
        made.publicKey,
        made.counter,
        userHandle,
        made.transports,
        made.backedUp,
        name,
        now(),
      );
    } catch (e) {
      if (/passkey_limit/.test(e.message))
        fail(
          409,
          `You can add up to ${MAX_PASSKEYS} passkeys. Remove one to add another.`,
          "passkey_limit",
        );
      if (/UNIQUE/.test(e.message))
        fail(409, "This passkey is already added.", "passkey_exists");
      throw e;
    }
    return id;
  }

  async function authenticationOptions(allow = []) {
    return generateAuthenticationOptions({
      rpID: rpID(),
      userVerification: "required",
      timeout: CHALLENGE_MS,
      // None for a sign-in: the browser offers any passkey for this site.
      allowCredentials: allow.length
        ? allow.map((p) => ({
            id: p.credential_id,
            transports: p.transports ? JSON.parse(p.transports) : undefined,
          }))
        : undefined,
    });
  }
  function assertUnlocked(p, res) {
    const t = now();
    if (p.locked_until > t) {
      const minutes = Math.ceil((p.locked_until - t) / 60000);
      res?.set("Retry-After", String(Math.ceil((p.locked_until - t) / 1000)));
      fail(
        429,
        minutes === 1
          ? "This passkey is locked after too many failed tries. Try again in 1 minute."
          : `This passkey is locked after too many failed tries. Try again in ${minutes} minutes.`,
        "passkey_locked",
      );
    }
  }
  function recordFailure(p) {
    const t = now();
    const fresh = p.failed_since != null && t - p.failed_since < FAIL_WINDOW_MS;
    const count = fresh ? p.failures + 1 : 1;
    if (count >= MAX_FAILURES)
      db.prepare(
        "UPDATE passkeys SET failures=0,failed_since=NULL,locked_until=? WHERE id=?",
      ).run(t + LOCK_MS, p.id);
    else
      db.prepare(
        "UPDATE passkeys SET failures=?,failed_since=? WHERE id=?",
      ).run(count, fresh ? p.failed_since : t, p.id);
  }
  // Checks a sign-in or "confirm it's you" answer against its passkey:
  // origin, RP ID, challenge, signature, user verification, the user handle
  // and the sign counter. Returns the passkey row; wrong answers count
  // towards its lock.
  async function verifyGet(response, row, { userId = null, res } = {}) {
    const p = db
      .prepare("SELECT * FROM passkeys WHERE credential_id=?")
      .get(response.id);
    if (
      !p ||
      (userId && p.user_id !== userId) ||
      !db
        .prepare("SELECT 1 FROM users WHERE id=? AND deleted IS NULL")
        .get(p.user_id)
    )
      fail(
        401,
        "This passkey isn’t registered with ANONYMA. It may have been removed.",
        "passkey_unknown",
      );
    assertUnlocked(p, res);
    // A discoverable sign-in must name the account the passkey was made for.
    const handle = response.response.userHandle;
    if (!userId && handle !== p.user_handle) {
      recordFailure(p);
      bad();
    }
    if (userId && handle && handle !== p.user_handle) {
      recordFailure(p);
      bad();
    }
    let v;
    try {
      v = await verifyAuthenticationResponse({
        response,
        expectedChallenge: row.plain,
        expectedOrigin: cfg.origin,
        expectedRPID: rpID(),
        requireUserVerification: true,
        // The counter is checked below, once the signature is known good.
        credential: {
          id: p.credential_id,
          publicKey: new Uint8Array(p.public_key),
          counter: 0,
        },
      });
    } catch {
      v = null;
    }
    if (!v?.verified) {
      recordFailure(p);
      bad();
    }
    const next = v.authenticationInfo.newCounter;
    if (counterRegressed(p.counter, next)) {
      recordFailure(p);
      fail(
        401,
        "This passkey’s use count went backwards, which can mean it was copied. Sign in another way, then remove it and add it again.",
        "passkey_counter",
      );
    }
    // Only one answer can move the counter on (synced passkeys stay at 0).
    const moved = db
      .prepare(
        "UPDATE passkeys SET counter=?,backed_up=?,last_used=?,failures=0,failed_since=NULL,locked_until=NULL WHERE id=? AND (counter<? OR (counter=0 AND ?=0))",
      )
      .run(
        next,
        v.authenticationInfo.credentialBackedUp ? 1 : 0,
        now(),
        p.id,
        next,
        next,
      );
    if (!moved.changes)
      fail(
        401,
        "This passkey’s use count went backwards, which can mean it was copied. Sign in another way, then remove it and add it again.",
        "passkey_counter",
      );
    return p;
  }

  return {
    rpID,
    assertAvailable,
    list,
    handleOf,
    store,
    claim,
    registrationOptions,
    verifyCreate,
    insert,
    authenticationOptions,
    verifyGet,
  };
}
