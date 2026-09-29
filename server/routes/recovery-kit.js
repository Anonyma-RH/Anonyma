import { hash, now, fail, passwordHash, transaction } from "../core.js";
import { reauthMethods } from "../two-step.js";
import {
  DEFAULT_ACCOUNT_LABEL,
  MAX_PASSKEYS,
  cleanName,
  cleanResponse,
  passkeysLive,
} from "../passkeys.js";
import {
  createRecoveryKit,
  kitView,
  nudgeDue,
  reauthUntil,
} from "../recovery-kit.js";
import {
  KIT_FORMAT_MESSAGE,
  KIT_TWO_STEP_MESSAGE,
  KIT_TYPO_MESSAGE,
  looksLikeTwoStepCode,
  readKitCode,
} from "../../src/recovery-kit.js";

// Recovery Kit (update "recovery", gated in featuresFor; the rules are in
// server/recovery-kit.js):
// - Account → Security: the kit's status, making or replacing it (after
//   "confirm it's you", Two-Step Sign-in's or a passkey's, from the last 10
//   minutes), deleting it, and dismissing the one-time nudge;
// - the sign-in page's "Use a recovery code": a username and a code, then a
//   new password or passkey before any session starts.
export function recoveryKitRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, startSession } = ctx;
  const kit = (ctx.recoveryKit ||= createRecoveryKit(db, cfg));
  const passkeys = ctx.passkeys;
  const byAddress = (req) => "address:" + req.ip;
  const sessionHash = (req) => hash(req.cookies.anonyma_session || "");
  const passkeyCount = (userId) =>
    db.prepare("SELECT COUNT(*) n FROM passkeys WHERE user_id=?").get(userId).n;

  function status(req) {
    const user = req.user;
    const count = passkeyCount(user.id);
    return {
      kit: kitView(db, user.id),
      // Recovering takes the username, so a kit needs one.
      username: !!user.username,
      nudge: nudgeDue(db, user),
      reauthMethods: [
        ...reauthMethods(user),
        ...(count && passkeysLive(cfg) ? ["passkey"] : []),
      ],
      reauthUntil: reauthUntil(db, sessionHash(req), user.id),
    };
  }
  function requireReauth(req) {
    if (!reauthUntil(db, sessionHash(req), req.user.id))
      fail(
        403,
        "Confirm it’s you first. Making or deleting a recovery kit needs your password, a passkey (or a fresh email code or wallet signature) from the last 10 minutes.",
        "recovery_reauth_required",
      );
  }
  // What the browser needs once a session exists.
  function signedIn(res, userId, method) {
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
    return {
      user: startSession(res, user),
      recovery: {
        method,
        codesLeft: kitView(db, userId)?.unused ?? 0,
        // Still on: the next password sign-in asks for its code again.
        twoStep: ctx.twoStep.isOn(userId),
      },
    };
  }

  // ---- Account → Security ----
  app.get("/api/account/recovery-kit", requireUser, (req, res) =>
    res.json(status(req)),
  );
  // Makes the kit, or with replace: true, a new one in its place. Returns
  // the ten codes, the only time they're shown.
  app.post(
    "/api/account/recovery-kit",
    requireUser,
    limit("recovery_kit_make", 10, 3600000),
    async (req, res) => {
      if (!req.user.username)
        fail(
          409,
          "A recovery kit needs a username to recover with, and this account has none.",
          "recovery_kit_username",
        );
      requireReauth(req);
      const replace = req.body?.replace === true;
      const exists = () =>
        !!db.prepare("SELECT 1 FROM recovery_kits WHERE user_id=?").get(req.user.id);
      if (exists() && !replace)
        fail(409, "You already have a recovery kit. Make a new one to replace it.", "recovery_kit_exists");
      const made = await kit.issue(req.user.id);
      transaction(db, () => {
        // This session may have been signed out while the codes were being
        // hashed (a recovery signs out every session): it can't write then.
        if (!db.prepare("SELECT 1 FROM sessions WHERE hash=? AND user_id=?").get(sessionHash(req), req.user.id))
          fail(401, "Sign in to continue.", "authentication_required");
        // Checked again with the write: another tab may have made one.
        if (exists() && !replace)
          fail(409, "You already have a recovery kit. Make a new one to replace it.", "recovery_kit_exists");
        made.store();
      });
      res.status(201).json({ ...status(req), codes: made.codes });
    },
  );
  app.delete(
    "/api/account/recovery-kit",
    requireUser,
    limit("recovery_kit_make", 10, 3600000),
    (req, res) => {
      requireReauth(req);
      transaction(db, () => {
        db.prepare("DELETE FROM recovery_kit_codes WHERE user_id=?").run(req.user.id);
        db.prepare("DELETE FROM recovery_kits WHERE user_id=?").run(req.user.id);
        db.prepare("DELETE FROM recovery_pending WHERE user_id=?").run(req.user.id);
      });
      res.json(status(req));
    },
  );
  // The one-time nudge: dismissed for good.
  app.delete("/api/account/recovery-kit/nudge", requireUser, (req, res) => {
    db.prepare(
      "INSERT INTO recovery_nudges(user_id,dismissed) VALUES(?,?) ON CONFLICT(user_id) DO NOTHING",
    ).run(req.user.id, now());
    res.json(status(req));
  });

  // ---- Using a code (the sign-in page) ----
  app.post(
    "/api/auth/recovery-kit/redeem",
    limit("recovery_kit_redeem", 20, 3600000, byAddress),
    async (req, res) => {
      const username =
        typeof req.body?.username === "string" ? req.body.username.trim() : "";
      if (!username || username.length > 32)
        fail(400, "Enter your username.", "recovery_username");
      const typed = typeof req.body?.code === "string" ? req.body.code : "";
      const read = readKitCode(typed);
      // Not a code, or a typo its check symbol catches: nothing was tried,
      // so nothing counts towards the lockout.
      if (!read)
        fail(
          400,
          looksLikeTwoStepCode(typed) ? KIT_TWO_STEP_MESSAGE : KIT_FORMAT_MESSAGE,
          "recovery_code_format",
        );
      if (read.typo) fail(400, KIT_TYPO_MESSAGE, "recovery_code_typo");
      const { user, match, keys } = await kit.check(username, read.symbols, req, res);
      const started = transaction(db, () => kit.begin(user, match));
      if (!started)
        fail(
          401,
          "That code was already used. Each code works once; try another from your kit.",
          "recovery_code_used",
        );
      kit.giveBack(keys);
      const count = passkeyCount(user.id);
      res.json({
        recovery: {
          token: started.token,
          expires: started.expires,
          codesLeft: kitView(db, user.id)?.unused ?? 0,
          // The ways this account can finish: a new password always; a
          // passkey where passkeys work and the account has room for one.
          passkey: passkeysLive(cfg) && count < MAX_PASSKEYS,
        },
      });
    },
  );
  app.post(
    "/api/auth/recovery-kit/password",
    limit("recovery_kit_finish", 20, 900000, byAddress),
    (req, res) => {
      const p = kit.pending(req.body?.token);
      const password = req.body?.password;
      if (typeof password !== "string" || password.length < 10 || password.length > 256)
        fail(400, "Use a password between 10 and 256 characters.", "recovery_password");
      const hashed = passwordHash(password);
      transaction(db, () => {
        if (!kit.finish(p))
          fail(400, "This recovery step expired. The code you used is spent; start again with another code from your kit.", "recovery_expired");
        db.prepare("UPDATE users SET password=? WHERE id=?").run(hashed, p.user_id);
      });
      res.json(signedIn(res, p.user_id, "password"));
    },
  );
  // Adding a passkey instead: Passkeys' own ceremony ("add"), bound to the
  // recovery rather than a session.
  app.post(
    "/api/auth/recovery-kit/passkey/options",
    limit("recovery_kit_finish", 20, 900000, byAddress),
    async (req, res) => {
      passkeys.assertAvailable();
      const p = kit.pending(req.body?.token);
      const own = db
        .prepare("SELECT credential_id,transports FROM passkeys WHERE user_id=?")
        .all(p.user_id);
      if (own.length >= MAX_PASSKEYS)
        fail(
          409,
          `This account already has ${MAX_PASSKEYS} passkeys. Set a new password instead.`,
          "passkey_limit",
        );
      const handle = passkeys.handleOf(p.user_id);
      const options = await passkeys.registrationOptions({
        userName: p.user.username || DEFAULT_ACCOUNT_LABEL,
        userHandle: handle,
        exclude: own,
      });
      passkeys.store("add", options.challenge, {
        userId: p.user_id,
        sessionHash: kit.bindingOf(p),
        userHandle: handle,
      });
      res.json({ options });
    },
  );
  app.post(
    "/api/auth/recovery-kit/passkey",
    limit("recovery_kit_finish", 20, 900000, byAddress),
    async (req, res) => {
      passkeys.assertAvailable();
      const p = kit.pending(req.body?.token);
      const response = cleanResponse(req.body?.response, "create");
      if (!response)
        fail(400, "That passkey response wasn’t readable. Try again.", "passkey_invalid_response");
      const name = req.body?.name == null ? "Passkey" : cleanName(req.body.name);
      if (!name) fail(400, "Name your passkey in 1 to 40 characters.", "passkey_name");
      const row = passkeys.claim("add", response, {
        user_id: p.user_id,
        session_hash: kit.bindingOf(p),
      });
      const made = await passkeys.verifyCreate(response, row);
      transaction(db, () => {
        if (!kit.finish(p))
          fail(400, "This recovery step expired. The code you used is spent; start again with another code from your kit.", "recovery_expired");
        passkeys.insert(p.user_id, row.user_handle, made, name);
      });
      res.json({ ...signedIn(res, p.user_id, "passkey"), passkey: { name } });
    },
  );
  return { recoveryKit: kit };
}
