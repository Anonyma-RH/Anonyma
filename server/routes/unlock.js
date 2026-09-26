import { createHash } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { hash, now, fail, uid, passwordMatches } from "../core.js";
import { reauthMethods } from "../two-step.js";
import { passkeysLive } from "../passkeys.js";

// Privacy Screen's "Lock after idle" (update "privacyscreen"). The lock is a
// screen in the browser (src/privacy-screen.js): the chats stay in the page's
// memory, unrendered, and the session is never touched. Unlocking asks the
// server to re-check that it's the account's owner: the password when the
// account has one, otherwise a code sent to its email or a signature from its
// linked wallet (the same rule as Two-Step's "confirm it's you").
//
// Nothing is stored for this but wrong attempts, counted like a rate limit:
// one row in rate_limits under a hashed key that expires on its own. Five
// wrong attempts within 15 minutes refuse unlocking for 15 minutes; "Sign
// out instead" is always there. The one-time email code or wallet message
// lives in challenges for 10 minutes, bound to this session.
export const UNLOCK_MAX_FAILURES = 5;
export const UNLOCK_FAIL_WINDOW_MS = 15 * 60000;
export const UNLOCK_LOCK_MS = 15 * 60000;
export const UNLOCK_CHALLENGE_MS = 10 * 60000;
// With Passkeys released too, a passkey is one more way to unlock (and the
// only one an account made with a passkey has). The passkey itself is
// checked by Passkeys' "confirm it's you" (/api/account/passkeys/reauth,
// with its own per-passkey lockout); this check then accepts that
// confirmation, by this session, from the last 2 minutes.
export const UNLOCK_PASSKEY_MS = 2 * 60000;

export function unlockRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, sendEmailCode } = ctx;
  const sessionHash = (req) => hash(req.cookies.anonyma_session || "");
  // Like the rate limiter's keys: never an account id in the clear.
  const failKey = (userId) =>
    `${cfg.rateLimitNamespace}:unlock_fail:${createHash("sha256").update(String(userId)).digest("hex")}`;
  const readFailures = db.prepare(
    "SELECT count,expires FROM rate_limits WHERE key=?",
  );
  const addFailure = db.prepare(`INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
      expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END
    RETURNING count,expires`);
  const holdUntil = db.prepare("UPDATE rate_limits SET expires=? WHERE key=?");
  const clearFailures = db.prepare("DELETE FROM rate_limits WHERE key=?");

  // Milliseconds until unlocking is allowed again; 0 when it is.
  function lockedFor(userId) {
    const r = readFailures.get(failKey(userId));
    const t = now();
    return r && r.expires > t && r.count >= UNLOCK_MAX_FAILURES
      ? r.expires - t
      : 0;
  }
  function refuseLocked(ms, res) {
    const minutes = Math.max(1, Math.ceil(ms / 60000));
    res.set("Retry-After", String(Math.max(1, Math.ceil(ms / 1000))));
    fail(
      429,
      minutes === 1
        ? "Too many incorrect attempts. Try again in 1 minute, or sign out instead."
        : `Too many incorrect attempts. Try again in ${minutes} minutes, or sign out instead.`,
      "unlock_locked",
    );
  }
  function assertOpen(req, res) {
    const ms = lockedFor(req.user.id);
    if (ms) refuseLocked(ms, res);
  }
  // A wrong password, code or signature. The fifth within the window starts
  // the lock straight away, so the answer says so.
  function wrong(req, res, message) {
    const key = failKey(req.user.id),
      t = now();
    const r = addFailure.get(key, t + UNLOCK_FAIL_WINDOW_MS, t, t);
    if (r.count >= UNLOCK_MAX_FAILURES) {
      holdUntil.run(t + UNLOCK_LOCK_MS, key);
      refuseLocked(UNLOCK_LOCK_MS, res);
    }
    fail(401, message, "unlock_failed");
  }
  // The account's password, email code or wallet signature, as Two-Step's
  // "confirm it's you" takes them, and a passkey once Passkeys is live.
  function unlockMethods(user) {
    const methods = reauthMethods(user);
    if (
      passkeysLive(cfg) &&
      db.prepare("SELECT 1 FROM passkeys WHERE user_id=? LIMIT 1").get(user.id)
    )
      methods.push("passkey");
    return methods;
  }
  function allowed(req, method) {
    const methods = unlockMethods(req.user);
    if (!methods.includes(method))
      fail(
        400,
        methods[0] === "password"
          ? "Unlock with your password."
          : methods[0] === "passkey"
            ? "Unlock with your passkey."
            : "Unlock with a code sent to your email or a signature from your linked wallet.",
        "unlock_method",
      );
  }

  // How this account unlocks, and whether wrong attempts have paused it.
  app.get("/api/auth/unlock", requireUser, (req, res) => {
    const ms = lockedFor(req.user.id);
    res.json({
      methods: unlockMethods(req.user),
      retryAfter: ms ? Math.ceil(ms / 1000) : null,
    });
  });

  // An email code or a wallet message, for accounts without a password.
  app.post(
    "/api/auth/unlock/start",
    requireUser,
    limit("unlock_start", 10, 3600000),
    async (req, res) => {
      const method = req.body?.method;
      if (method !== "email" && method !== "wallet")
        fail(
          400,
          "Unlock with a code sent to your email or a signature from your linked wallet.",
          "unlock_method",
        );
      allowed(req, method);
      assertOpen(req, res);
      const payload = JSON.stringify({
        user: req.user.id,
        session: sessionHash(req),
      });
      if (method === "email") {
        const { id, code } = await sendEmailCode(
          req.user.email,
          "unlock",
          payload,
        );
        return res.json({
          id,
          ...(cfg.testMode ? { testCode: code } : {}),
          message: "Verification code sent. It expires in 10 minutes.",
        });
      }
      const id = uid("w_"),
        address = getAddress(req.user.wallet);
      const message = `${new URL(cfg.origin).host} asks you to unlock your screen with your Ethereum account:\n${address}\n\nUnlock the Privacy Screen on Anonyma. This does not authorize a blockchain transaction and can't be used to sign in.\n\nURI: ${cfg.origin}\nVersion: 1\nChain ID: ${cfg.walletChain}\nNonce: ${uid()}\nIssued At: ${new Date(now()).toISOString()}\nExpiration Time: ${new Date(now() + UNLOCK_CHALLENGE_MS).toISOString()}`;
      db.prepare(
        "INSERT INTO challenges(id,target,purpose,hash,expires,payload) VALUES(?,?,?,?,?,?)",
      ).run(
        id,
        req.user.wallet,
        "unlock_wallet",
        hash(message),
        now() + UNLOCK_CHALLENGE_MS,
        JSON.stringify({
          message,
          user: req.user.id,
          session: sessionHash(req),
        }),
      );
      res.json({ id, message });
    },
  );

  // The check itself. It never creates, rotates or ends a session, and a
  // wrong answer never signs anyone out.
  app.post(
    "/api/auth/unlock",
    requireUser,
    limit("unlock", 30, 900000),
    (req, res) => {
      const method = req.body?.method;
      if (!["password", "email", "wallet", "passkey"].includes(method))
        fail(400, "Choose how to unlock.", "unlock_method");
      allowed(req, method);
      assertOpen(req, res);
      if (method === "passkey") {
        const at = db
          .prepare("SELECT at FROM passkey_reauth WHERE session_hash=? AND user_id=?")
          .get(sessionHash(req), req.user.id)?.at;
        if (at == null || at < now() - UNLOCK_PASSKEY_MS)
          fail(400, "Confirm with your passkey again.", "unlock_expired");
      } else if (method === "password") {
        const p = req.body.password;
        if (typeof p !== "string" || !p || p.length > 256)
          fail(400, "Enter your password.", "unlock_password_required");
        if (!passwordMatches(p, req.user.password))
          wrong(req, res, "Incorrect password.");
      } else {
        const purpose = method === "email" ? "unlock" : "unlock_wallet";
        const ch = db
          .prepare("SELECT * FROM challenges WHERE id=? AND purpose=?")
          .get(String(req.body.id || ""), purpose);
        const target = method === "email" ? req.user.email : req.user.wallet;
        let payload = null;
        try {
          payload = JSON.parse(ch?.payload || "null");
        } catch {}
        // Only a code or message this session asked for, for this account's
        // current email or wallet.
        if (
          !ch ||
          ch.expires < now() ||
          ch.attempts >= 5 ||
          payload?.user !== req.user.id ||
          payload?.session !== sessionHash(req) ||
          ch.target !== target
        )
          fail(
            400,
            method === "email"
              ? "This code expired. Send a new one."
              : "This wallet request expired. Try again.",
            "unlock_expired",
          );
        if (method === "email") {
          db.prepare(
            "UPDATE challenges SET attempts=attempts+1 WHERE id=?",
          ).run(ch.id);
          if (hash(ch.id + String(req.body.code ?? "").trim()) !== ch.hash)
            wrong(req, res, "Incorrect verification code.");
        } else {
          let signer = null;
          try {
            signer = verifyMessage(
              payload.message,
              req.body.signature,
            ).toLowerCase();
          } catch {}
          if (signer !== target)
            wrong(req, res, "Signature does not match the wallet.");
        }
        db.prepare("DELETE FROM challenges WHERE id=?").run(ch.id);
      }
      clearFailures.run(failKey(req.user.id));
      res.json({ ok: true, unlocked: now() });
    },
  );
}
