import { getAddress, verifyMessage } from "ethers";
import { hash, now, fail, transaction, uid, passwordMatches } from "../core.js";
import {
  SETUP_MS,
  REAUTH_MS,
  reauthMethods,
  base32Encode,
  newSecret,
  sealSecret,
  matchTotp,
  accountLabel,
  otpauthUri,
} from "../two-step.js";

// Two-Step Sign-in settings (Account → Security), behind the "twostep"
// release gate. Turning it on shows a new secret, then needs a current code
// from it; turning it off needs a current code or a recovery code. Either
// change signs out every other session. The sign-in step itself lives in
// server/auth.js (POST /api/auth/two-step).
//
// A stolen session must not be able to turn it on (which would lock the
// owner out) or take new recovery codes, so both need this session to have
// confirmed it's its owner within REAUTH_MS: the account's password, or for
// an account without one, a fresh email code or wallet signature. The
// confirmation is keyed by the session's own hash.
export function twoStepRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, twoStep, sendEmailCode } = ctx;
  const sessionHash = (req) => hash(req.cookies.anonyma_session || "");
  function reauthUntil(req) {
    const r = db
      .prepare(
        "SELECT at FROM two_step_reauth WHERE session_hash=? AND user_id=?",
      )
      .get(sessionHash(req), req.user.id);
    return r && r.at + REAUTH_MS > now() ? r.at + REAUTH_MS : null;
  }
  function requireReauth(req) {
    if (!reauthUntil(req))
      fail(
        403,
        "Confirm it’s you first. Turning on two-step sign-in and making new recovery codes need your password (or a fresh email code or wallet signature) from the last 10 minutes.",
        "two_step_reauth_required",
      );
  }
  function status(req) {
    const userId = req.user.id;
    const r = twoStep.row(userId);
    return {
      enabled: !!r?.enabled,
      enabledAt: r?.enabled ? r.enabled_at : null,
      recoveryCodesLeft: r?.enabled ? twoStep.codesLeft(userId) : 0,
      // How this account confirms it's you, and until when this session's
      // last confirmation counts (null: confirm again first).
      reauthMethods: reauthMethods(req.user),
      reauthUntil: reauthUntil(req),
    };
  }
  // Every session but this one; returns how many were signed out.
  const signOutOthers = (req) =>
    db
      .prepare("DELETE FROM sessions WHERE user_id=? AND hash<>?")
      .run(req.user.id, sessionHash(req)).changes;
  const allowed = (req, method) => {
    const methods = reauthMethods(req.user);
    if (!methods.includes(method))
      fail(
        400,
        methods[0] === "password"
          ? "Confirm with your password."
          : "Confirm with a code sent to your email or a signature from your linked wallet.",
        "two_step_reauth_method",
      );
  };

  app.get("/api/account/two-step", requireUser, (req, res) =>
    res.json(status(req)),
  );
  // "Confirm it's you" without a password: an email code sent to the
  // account's own address, or a message for its linked wallet to sign. Both
  // are bound to this session and last 10 minutes.
  app.post(
    "/api/account/two-step/reauth/start",
    requireUser,
    limit("two_step_reauth_start", 10, 3600000),
    async (req, res) => {
      const method = req.body.method;
      if (method !== "email" && method !== "wallet")
        fail(
          400,
          "Confirm with a code sent to your email or a signature from your linked wallet.",
          "two_step_reauth_method",
        );
      allowed(req, method);
      const payload = JSON.stringify({
        user: req.user.id,
        session: sessionHash(req),
      });
      if (method === "email") {
        const { id, code } = await sendEmailCode(
          req.user.email,
          "two_step_reauth",
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
      const message = `${new URL(cfg.origin).host} asks you to confirm it's you with your Ethereum account:\n${address}\n\nConfirm a two-step sign-in change on Anonyma. This does not authorize a blockchain transaction.\n\nURI: ${cfg.origin}\nVersion: 1\nChain ID: ${cfg.walletChain}\nNonce: ${uid()}\nIssued At: ${new Date(now()).toISOString()}\nExpiration Time: ${new Date(now() + 600000).toISOString()}`;
      db.prepare(
        "INSERT INTO challenges(id,target,purpose,hash,expires,payload) VALUES(?,?,?,?,?,?)",
      ).run(
        id,
        req.user.wallet,
        "two_step_reauth_wallet",
        hash(message),
        now() + 600000,
        JSON.stringify({
          message,
          user: req.user.id,
          session: sessionHash(req),
        }),
      );
      res.json({ id, message });
    },
  );
  app.post(
    "/api/account/two-step/reauth",
    requireUser,
    limit("two_step_reauth", 10, 900000),
    (req, res) => {
      const method = req.body.method;
      allowed(req, method);
      if (method === "password") {
        const p = req.body.password;
        if (
          typeof p !== "string" ||
          p.length > 256 ||
          !passwordMatches(p, req.user.password)
        )
          fail(401, "Incorrect password.", "two_step_reauth_failed");
      } else {
        const purpose =
          method === "email" ? "two_step_reauth" : "two_step_reauth_wallet";
        const ch = db
          .prepare("SELECT * FROM challenges WHERE id=? AND purpose=?")
          .get(String(req.body.id || ""), purpose);
        const target = method === "email" ? req.user.email : req.user.wallet;
        let payload = null;
        try {
          payload = JSON.parse(ch?.payload || "null");
        } catch {}
        // Only a confirmation this session asked for, for this account's
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
              ? "Code expired or too many attempts."
              : "Wallet challenge expired.",
            "two_step_reauth_expired",
          );
        if (method === "email") {
          db.prepare(
            "UPDATE challenges SET attempts=attempts+1 WHERE id=?",
          ).run(ch.id);
          if (hash(ch.id + String(req.body.code)) !== ch.hash)
            fail(400, "Incorrect verification code.", "two_step_reauth_failed");
        } else {
          let signer;
          try {
            signer = verifyMessage(
              payload.message,
              req.body.signature,
            ).toLowerCase();
          } catch {
            fail(401, "Invalid signature.", "two_step_reauth_failed");
          }
          if (signer !== target)
            fail(
              401,
              "Signature does not match the wallet.",
              "two_step_reauth_failed",
            );
        }
        db.prepare("DELETE FROM challenges WHERE id=?").run(ch.id);
      }
      db.prepare(
        `INSERT INTO two_step_reauth(session_hash,user_id,method,at) VALUES(?,?,?,?)
         ON CONFLICT(session_hash) DO UPDATE SET user_id=excluded.user_id,method=excluded.method,at=excluded.at`,
      ).run(sessionHash(req), req.user.id, method, now());
      res.json({ reauthUntil: now() + REAUTH_MS });
    },
  );
  // A new secret, replacing any setup not yet confirmed. Nothing changes for
  // sign-in until a code from it is confirmed. Needs a recent "confirm it's
  // you" from this session, as does confirming it.
  app.post(
    "/api/account/two-step/setup",
    requireUser,
    limit("two_step_setup", 10, 3600000),
    (req, res) => {
      const r = twoStep.row(req.user.id);
      if (r?.enabled)
        fail(409, "Two-step sign-in is already on.", "two_step_on");
      requireReauth(req);
      const secret = newSecret();
      db.prepare(
        `INSERT INTO two_step(user_id,secret,enabled,created) VALUES(?,?,0,?)
         ON CONFLICT(user_id) DO UPDATE SET secret=excluded.secret,created=excluded.created,
           last_step=NULL,failures=0,failed_since=NULL,locked_until=NULL
         WHERE two_step.enabled=0`,
      ).run(req.user.id, sealSecret(cfg.secret, req.user.id, secret), now());
      const key = base32Encode(secret);
      const label = accountLabel(req.user);
      res.json({
        secret: key,
        uri: otpauthUri(key, label),
        issuer: "Anonyma",
        label,
        expires: now() + SETUP_MS,
      });
    },
  );
  // Confirms the setup with a current code, turns two-step on and returns
  // the recovery codes, the only time they're shown.
  app.post(
    "/api/account/two-step/enable",
    requireUser,
    limit("two_step_enable", 20, 900000),
    (req, res) => {
      const r = twoStep.row(req.user.id);
      if (r?.enabled)
        fail(409, "Two-step sign-in is already on.", "two_step_on");
      requireReauth(req);
      if (!r || r.created < now() - SETUP_MS)
        fail(
          400,
          "This setup expired. Start again to get a new key.",
          "two_step_setup_expired",
        );
      const code = String(req.body.code ?? "").replace(/\s/g, "");
      if (!/^\d{6}$/.test(code))
        fail(
          400,
          "Enter the 6-digit code from your authenticator app.",
          "two_step_code_format",
        );
      const m = matchTotp(twoStep.secretOf(r), code);
      if (m?.step == null)
        fail(
          401,
          "That code didn’t match. Check the key in your app and that your phone’s clock is set automatically.",
          "two_step_invalid",
        );
      const { codes, signedOut } = transaction(db, () => {
        const changed = db
          .prepare(
            "UPDATE two_step SET enabled=1,enabled_at=?,last_step=?,failures=0,failed_since=NULL,locked_until=NULL WHERE user_id=? AND enabled=0 AND secret=?",
          )
          .run(now(), m.step, req.user.id, r.secret);
        if (!changed.changes)
          fail(
            409,
            "This setup changed. Start again.",
            "two_step_setup_changed",
          );
        return {
          codes: twoStep.issueRecoveryCodes(req.user.id),
          signedOut: signOutOthers(req),
        };
      });
      res.json({
        ...status(req),
        recoveryCodes: codes,
        signedOutSessions: signedOut,
      });
    },
  );
  // Ten new recovery codes; the old ones stop working. Needs a current
  // authenticator code (not a recovery code).
  app.post(
    "/api/account/two-step/recovery-codes",
    requireUser,
    limit("two_step_manage", 20, 900000),
    (req, res) => {
      // Checked before the code, so a stale session never uses one up.
      if (twoStep.isOn(req.user.id)) requireReauth(req);
      twoStep.verify(req.user.id, req.body.code, { recovery: false, res });
      const codes = transaction(db, () =>
        twoStep.issueRecoveryCodes(req.user.id),
      );
      res.json({ ...status(req), recoveryCodes: codes });
    },
  );
  // Turns it off with a current code or a recovery code: the secret, the
  // recovery codes and any sign-in waiting for a code are deleted.
  app.post(
    "/api/account/two-step/disable",
    requireUser,
    limit("two_step_manage", 20, 900000),
    (req, res) => {
      twoStep.verify(req.user.id, req.body.code, { res });
      const signedOut = transaction(db, () => {
        db.prepare("DELETE FROM two_step_recovery WHERE user_id=?").run(
          req.user.id,
        );
        db.prepare("DELETE FROM two_step_pending WHERE user_id=?").run(
          req.user.id,
        );
        db.prepare("DELETE FROM two_step WHERE user_id=?").run(req.user.id);
        return signOutOthers(req);
      });
      res.json({ ...status(req), signedOutSessions: signedOut });
    },
  );
}
