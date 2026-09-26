import { hash, now, fail, uid, transaction } from "../core.js";
import { sessionCookieOptions } from "../auth.js";
import { reauthMethods, REAUTH_MS as TWO_STEP_REAUTH_MS } from "../two-step.js";
import {
  CHALLENGE_MS,
  DEFAULT_ACCOUNT_LABEL,
  MAX_PASSKEYS,
  PENDING_COOKIE,
  PENDING_PATH,
  REAUTH_MS,
  cleanName,
  cleanResponse,
  createPasskeys,
  lastWayIn,
  newHandle,
  passkeysAvailable,
  signInMethods,
} from "../passkeys.js";

// Passkeys (update "passkeys", gated in featuresFor):
// - sign in with a passkey, no username (/api/auth/passkey/options, /verify);
// - create an account with a username and a passkey, no password or email
//   (/api/auth/passkey/signup/options, /signup/verify), like wallet-only
//   accounts;
// - Account → Security: list, add, rename and remove passkeys.
// A passkey sign-in requires user verification (the device's Face ID,
// fingerprint or PIN), so it counts as both of Two-Step Sign-in's factors and
// never waits for an authenticator code.
//
// Adding or removing a passkey needs this session to have confirmed it's you
// in the last 10 minutes: with the password (or an email code or wallet
// signature) through Two-Step Sign-in's /api/account/two-step/reauth, or with
// one of the account's passkeys here. A stolen session can't add its own
// passkey to keep a way in.
export function passkeyRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, startSession, newUser } = ctx;
  const passkeys = (ctx.passkeys ||= createPasskeys(db, cfg));
  const sessionHash = (req) => hash(req.cookies.anonyma_session || "");
  const pendingCookie = {
    ...sessionCookieOptions(cfg),
    sameSite: "strict",
    path: PENDING_PATH,
  };
  // A fresh pending-sign-in cookie; only its hash is stored with the
  // challenge, so a response can finish only in the browser that started it.
  function bindPending(res) {
    const token = uid("pkp_");
    res.cookie(PENDING_COOKIE, token, { ...pendingCookie, maxAge: CHALLENGE_MS });
    return hash(token);
  }
  const pendingOf = (req) => {
    const t = req.cookies?.[PENDING_COOKIE];
    return typeof t === "string" && t.length <= 100 ? hash(t) : "";
  };
  const clearPending = (res) => res.clearCookie(PENDING_COOKIE, pendingCookie);
  function responseOf(req, kind) {
    const r = cleanResponse(req.body?.response, kind);
    if (!r)
      fail(400, "That passkey response wasn’t readable. Try again.", "passkey_invalid_response");
    return r;
  }

  // "Confirm it's you" for this session: the newer of Two-Step Sign-in's
  // confirmation (password, email code or wallet signature) and a passkey.
  function reauthUntil(req) {
    const s = sessionHash(req);
    const a = db
      .prepare("SELECT at FROM two_step_reauth WHERE session_hash=? AND user_id=?")
      .get(s, req.user.id)?.at;
    const b = db
      .prepare("SELECT at FROM passkey_reauth WHERE session_hash=? AND user_id=?")
      .get(s, req.user.id)?.at;
    const until = Math.max(
      a != null ? a + TWO_STEP_REAUTH_MS : 0,
      b != null ? b + REAUTH_MS : 0,
    );
    return until > now() ? until : null;
  }
  function requireReauth(req) {
    if (!reauthUntil(req))
      fail(
        403,
        "Confirm it’s you first. Adding or removing a passkey needs your password, a passkey (or a fresh email code or wallet signature) from the last 10 minutes.",
        "passkey_reauth_required",
      );
  }
  function status(req) {
    const methods = signInMethods(db, req.user);
    return {
      data: passkeys.list(req.user.id),
      max: MAX_PASSKEYS,
      available: passkeysAvailable(cfg),
      methods,
      // How this account confirms it's you: Two-Step Sign-in's methods, and
      // a passkey once it has one.
      reauthMethods: [
        ...reauthMethods(req.user),
        ...(methods.passkeys ? ["passkey"] : []),
      ],
      reauthUntil: reauthUntil(req),
    };
  }

  // ---- Sign in with a passkey (no username) ----
  app.post(
    "/api/auth/passkey/options",
    limit("passkey_start", 30, 900000),
    async (req, res) => {
      passkeys.assertAvailable();
      const options = await passkeys.authenticationOptions();
      passkeys.store("signin", options.challenge, { binding: bindPending(res) });
      res.json({ options });
    },
  );
  app.post(
    "/api/auth/passkey/verify",
    limit("passkey_login", 20, 900000),
    async (req, res) => {
      passkeys.assertAvailable();
      const response = responseOf(req, "get");
      const binding = pendingOf(req);
      if (!binding)
        fail(400, "This passkey request expired or was already used. Try again.", "passkey_expired");
      clearPending(res);
      const row = passkeys.claim("signin", response, { binding });
      const p = await passkeys.verifyGet(response, row, { res });
      const user = db
        .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
        .get(p.user_id);
      // User verification happened on the device: no two-step code.
      res.json({ user: startSession(res, user), passkey: { name: p.name } });
    },
  );

  // ---- Create an account with a passkey ----
  app.post(
    "/api/auth/passkey/signup/options",
    limit("passkey_signup_start", 20, 3600000),
    async (req, res) => {
      passkeys.assertAvailable();
      const username = req.body.username;
      if (typeof username !== "string" || !/^\w[\w.-]{2,31}$/.test(username))
        fail(
          400,
          "Username must be 3–32 letters, numbers, dots, dashes or underscores.",
        );
      if (
        db
          .prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE")
          .get(username)
      )
        fail(409, "That username is taken.");
      const handle = newHandle();
      const options = await passkeys.registrationOptions({
        userName: username,
        userHandle: handle,
      });
      passkeys.store("signup", options.challenge, {
        binding: bindPending(res),
        username,
        userHandle: handle,
      });
      res.json({ options });
    },
  );
  app.post(
    "/api/auth/passkey/signup/verify",
    // Account creation shares the password sign-up's limit.
    limit("register", 10, 3600000),
    async (req, res) => {
      passkeys.assertAvailable();
      const response = responseOf(req, "create");
      const binding = pendingOf(req);
      if (!binding)
        fail(400, "This passkey request expired or was already used. Try again.", "passkey_expired");
      clearPending(res);
      const row = passkeys.claim("signup", response, { binding });
      const made = await passkeys.verifyCreate(response, row);
      const name = cleanName(req.body.name) || "Passkey";
      const user = transaction(db, () => {
        if (
          db
            .prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE")
            .get(row.username)
        )
          fail(409, "That username is taken.");
        const u = newUser({ username: row.username }, req);
        passkeys.insert(u.id, row.user_handle, made, name);
        return u;
      });
      res.status(201).json({ user: startSession(res, user), passkey: { name } });
    },
  );

  // ---- Account → Security ----
  app.get("/api/account/passkeys", requireUser, (req, res) =>
    res.json(status(req)),
  );
  // Confirm it's you with one of this account's passkeys, for this session.
  app.post(
    "/api/account/passkeys/reauth/options",
    requireUser,
    limit("passkey_reauth_start", 10, 900000),
    async (req, res) => {
      passkeys.assertAvailable();
      const own = db
        .prepare("SELECT credential_id,transports FROM passkeys WHERE user_id=?")
        .all(req.user.id);
      if (!own.length)
        fail(400, "This account has no passkeys yet.", "passkey_none");
      const options = await passkeys.authenticationOptions(own);
      passkeys.store("reauth", options.challenge, {
        userId: req.user.id,
        sessionHash: sessionHash(req),
      });
      res.json({ options });
    },
  );
  app.post(
    "/api/account/passkeys/reauth",
    requireUser,
    limit("passkey_reauth", 10, 900000),
    async (req, res) => {
      passkeys.assertAvailable();
      const response = responseOf(req, "get");
      const row = passkeys.claim("reauth", response, {
        user_id: req.user.id,
        session_hash: sessionHash(req),
      });
      await passkeys.verifyGet(response, row, { userId: req.user.id, res });
      db.prepare(
        `INSERT INTO passkey_reauth(session_hash,user_id,at) VALUES(?,?,?)
         ON CONFLICT(session_hash) DO UPDATE SET user_id=excluded.user_id,at=excluded.at`,
      ).run(sessionHash(req), req.user.id, now());
      res.json({ reauthUntil: now() + REAUTH_MS });
    },
  );
  // Add a passkey: the options, then the new credential and its name.
  app.post(
    "/api/account/passkeys/options",
    requireUser,
    limit("passkey_add", 10, 3600000),
    async (req, res) => {
      passkeys.assertAvailable();
      requireReauth(req);
      const own = db
        .prepare("SELECT credential_id,transports FROM passkeys WHERE user_id=?")
        .all(req.user.id);
      if (own.length >= MAX_PASSKEYS)
        fail(
          409,
          `You can add up to ${MAX_PASSKEYS} passkeys. Remove one to add another.`,
          "passkey_limit",
        );
      const handle = passkeys.handleOf(req.user.id);
      const options = await passkeys.registrationOptions({
        userName: req.user.username || DEFAULT_ACCOUNT_LABEL,
        userHandle: handle,
        exclude: own,
      });
      passkeys.store("add", options.challenge, {
        userId: req.user.id,
        sessionHash: sessionHash(req),
        userHandle: handle,
      });
      res.json({ options });
    },
  );
  app.post(
    "/api/account/passkeys",
    requireUser,
    limit("passkey_add_verify", 20, 3600000),
    async (req, res) => {
      passkeys.assertAvailable();
      const response = responseOf(req, "create");
      const name = req.body.name == null ? "Passkey" : cleanName(req.body.name);
      if (!name)
        fail(400, "Name your passkey in 1 to 40 characters.", "passkey_name");
      const row = passkeys.claim("add", response, {
        user_id: req.user.id,
        session_hash: sessionHash(req),
      });
      // Checked again: the confirmation may have lapsed since the options.
      requireReauth(req);
      const made = await passkeys.verifyCreate(response, row);
      const id = passkeys.insert(req.user.id, row.user_handle, made, name);
      res.status(201).json({ id, ...status(req) });
    },
  );
  app.patch(
    "/api/account/passkeys/:id",
    requireUser,
    limit("passkey_manage", 30, 900000),
    (req, res) => {
      const name = cleanName(req.body.name);
      if (!name)
        fail(400, "Name your passkey in 1 to 40 characters.", "passkey_name");
      const r = db
        .prepare("UPDATE passkeys SET name=? WHERE id=? AND user_id=?")
        .run(name, String(req.params.id), req.user.id);
      if (!r.changes) fail(404, "Passkey not found.", "passkey_not_found");
      res.json(status(req));
    },
  );
  app.delete(
    "/api/account/passkeys/:id",
    requireUser,
    limit("passkey_manage", 30, 900000),
    (req, res) => {
      const id = String(req.params.id);
      if (
        !db
          .prepare("SELECT 1 FROM passkeys WHERE id=? AND user_id=?")
          .get(id, req.user.id)
      )
        fail(404, "Passkey not found.", "passkey_not_found");
      requireReauth(req);
      transaction(db, () => {
        // Checked with the deletion, so two removals at once can't both pass.
        if (lastWayIn(signInMethods(db, req.user)))
          fail(
            409,
            "This passkey is your only way to sign in. Add another passkey, link an email or link a wallet first.",
            "passkey_last_method",
          );
        db.prepare("DELETE FROM passkeys WHERE id=? AND user_id=?").run(
          id,
          req.user.id,
        );
      });
      res.json(status(req));
    },
  );
}
