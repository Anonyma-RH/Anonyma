import { randomInt, createHmac, timingSafeEqual } from "node:crypto";
import {
  verifyMessage,
  JsonRpcProvider,
  Contract,
  getAddress,
  FetchRequest,
} from "ethers";
import nodemailer from "nodemailer";
import {
  uid,
  hash,
  now,
  fail,
  passwordHash,
  passwordMatches,
  addCredit,
  balance,
  credits,
  discount,
} from "./core.js";
import {
  earlyAccessFor,
  recordCheck,
  retentionCaps,
  HOLDER_RESET,
} from "./holders.js";
import { createTwoStep } from "./two-step.js";
import { isReleased } from "./releases.js";

export function sessionCookieOptions(cfg) {
  return {
    httpOnly: true,
    sameSite: "lax",
    secure: cfg.production || new URL(cfg.origin).protocol === "https:",
    path: "/",
  };
}

export function authRoutes(app, db, cfg, limit) {
  const cookieOptions = { ...sessionCookieOptions(cfg), maxAge: 30 * 86400000 };
  // Two-Step Sign-in: an account that turned it on gets a session only after
  // its code (POST /api/auth/two-step). Enforced whether or not the update
  // is currently released, so switching it off never drops the protection.
  const twoStep = createTwoStep(db, cfg);
  function signIn(res, user, method, payload) {
    if (twoStep.isOn(user.id)) return twoStep.begin(user, method, payload);
    return { user: session(res, user) };
  }
  // A password reset: the new password, every session signed out and the
  // email's other sign-in and reset codes gone.
  function resetPassword(user, passwordHashed, email) {
    db.prepare("UPDATE users SET password=? WHERE id=?").run(
      passwordHashed,
      user.id,
    );
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
    db.prepare(
      "DELETE FROM challenges WHERE target=? AND purpose IN ('login','recover')",
    ).run(email);
  }
  // A 6-digit email code for `purpose`, valid for 10 minutes, five per
  // address per hour. Also used by Two-Step Sign-in's "confirm it's you"
  // (routes/two-step.js). Returns the challenge id and the code.
  async function sendEmailCode(email, purpose, payload) {
    if (
      db
        .prepare(
          "SELECT COUNT(*) n FROM rate_events WHERE kind='email' AND target=? AND created>?",
        )
        .get(email, now() - 3600000).n >= 5
    )
      fail(429, "Only five codes per email per hour.");
    if ((!cfg.smtp || !cfg.smtpFrom) && !cfg.testMode)
      fail(503, "Email delivery is not configured.", "email_unconfigured");
    db.prepare("INSERT INTO rate_events(kind,target,created) VALUES(?,?,?)").run(
      "email",
      email,
      now(),
    );
    const code = String(randomInt(100000, 1000000));
    const id = uid("e_");
    db.prepare(
      "INSERT INTO challenges(id,target,purpose,hash,expires,payload) VALUES(?,?,?,?,?,?)",
    ).run(id, email, purpose, hash(id + code), now() + 600000, payload);
    if (cfg.smtp) {
      try {
        await nodemailer.createTransport(cfg.smtp).sendMail({
          from: cfg.smtpFrom,
          to: email,
          subject: "Your Anonyma verification code",
          text: `Your code is ${code}. It expires in 10 minutes. If you did not request it, ignore this email.`,
        });
      } catch {
        db.prepare("DELETE FROM challenges WHERE id=?").run(id);
        fail(
          503,
          "The verification email could not be sent. Please try again later.",
          "email_unavailable",
        );
      }
    }
    return { id, code };
  }
  function session(res, user) {
    const token = uid("session_");
    db.prepare(
      "INSERT INTO sessions(hash,user_id,expires,created) VALUES(?,?,?,?)",
    ).run(hash(token), user.id, now() + 30 * 86400000, now());
    res.cookie("anonyma_session", token, cookieOptions);
    return publicUser(user);
  }
  function publicUser(user) {
    const b = balance(db, user.id);
    return {
      id: user.id,
      username: user.username,
      email: user.email,
      wallet: user.wallet,
      created: user.created,
      balance: credits(b.total),
      available: credits(b.available),
      held: credits(b.held),
      tokenBalance: user.token_balance,
      tokenSince: user.token_since,
      discount: discount(user.token_balance, user.token_since),
      // When the linked wallet's balance was last read successfully.
      tokenChecked: user.token_checked ?? null,
      // NYMA Holder Program: this account's own early updates, tier and
      // retention caps (twice the standard ones from the Holder tier).
      ...earlyAccessFor(cfg, user),
      caps: retentionCaps(cfg, user),
    };
  }
  // A referral link sets the anonyma_ref cookie; any sign-up method honours it.
  function referrerFrom(req) {
    const code = String(req.body?.ref || req.cookies?.anonyma_ref || "")
      .trim()
      .toLowerCase();
    if (!/^[a-z0-9]{6,16}$/.test(code)) return null;
    return (
      db
        .prepare(
          "SELECT id FROM users WHERE referral_code=? AND deleted IS NULL",
        )
        .get(code)?.id || null
    );
  }
  function newUser(fields, req) {
    const id = uid("u_");
    db.prepare(
      "INSERT INTO users(id,username,password,email,wallet,created,referred_by) VALUES(?,?,?,?,?,?,?)",
    ).run(
      id,
      fields.username || null,
      fields.password || null,
      fields.email || null,
      fields.wallet || null,
      now(),
      req ? referrerFrom(req) : null,
    );
    if (cfg.testMode)
      addCredit(
        db,
        id,
        100 * 10000000,
        "test_signup_" + id,
        "test_credit",
        "LOCAL TEST credits — no monetary value",
      );
    return db.prepare("SELECT * FROM users WHERE id=?").get(id);
  }
  const requireUser = (req, res, next) => {
    if (!req.user) fail(401, "Sign in to continue.", "authentication_required");
    next();
  };
  app.use((req, res, next) => {
    const token = req.cookies.anonyma_session;
    if (token) {
      const s = db
        .prepare("SELECT user_id FROM sessions WHERE hash=? AND expires>?")
        .get(hash(token), now());
      if (s)
        req.user = db
          .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
          .get(s.user_id);
    }
    next();
  });
  app.get("/api/me", (req, res) =>
    res.json({ user: req.user ? publicUser(req.user) : null }),
  );
  app.post(
    "/api/auth/register",
    limit("register", 10, 3600000),
    async (req, res) => {
      const { username, password, email } = req.body;
      if (typeof username !== "string" || !/^\w[\w.-]{2,31}$/.test(username))
        fail(
          400,
          "Username must be 3–32 letters, numbers, dots, dashes or underscores.",
        );
      if (
        typeof password !== "string" ||
        password.length < 10 ||
        password.length > 256
      )
        fail(400, "Use a password between 10 and 256 characters.");
      if (email)
        fail(
          400,
          "Add and verify your recovery email from Account after signing up.",
        );
      if (
        db
          .prepare("SELECT id FROM users WHERE username=? COLLATE NOCASE")
          .get(username)
      )
        fail(409, "That username is taken.");
      const user = newUser({ username, password: passwordHash(password) }, req);
      res.status(201).json({ user: session(res, user) });
    },
  );
  app.post("/api/auth/password", limit("login", 20, 900000), (req, res) => {
    const { username, password } = req.body;
    const user =
      typeof username === "string"
        ? db
            .prepare(
              "SELECT * FROM users WHERE username=? COLLATE NOCASE AND deleted IS NULL",
            )
            .get(username)
        : null;
    if (
      !user?.password ||
      typeof password !== "string" ||
      password.length > 256 ||
      !passwordMatches(password, user.password)
    )
      fail(401, "Incorrect username or password.");
    res.json(signIn(res, user, "password"));
  });
  app.post(
    "/api/auth/email/send",
    limit("email_ip", 15, 3600000),
    async (req, res) => {
      const email = String(req.body.email || "")
        .trim()
        .toLowerCase();
      const purpose = req.body.purpose || "login";
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
        fail(400, "Enter a valid email address.");
      if (!["login", "recover", "link"].includes(purpose))
        fail(400, "Invalid email purpose");
      if (purpose === "link" && !req.user) fail(401, "Sign in first.");
      const { id, code } = await sendEmailCode(
        email,
        purpose,
        req.user?.id || null,
      );
      res.json({
        id,
        ...(cfg.testMode ? { testCode: code } : {}),
        message: "Verification code sent. It expires in 10 minutes.",
      });
    },
  );
  app.post(
    "/api/auth/email/verify",
    limit("verify", 30, 900000),
    (req, res) => {
      const ch = db
        .prepare(
          "SELECT * FROM challenges WHERE id=? AND purpose IN ('login','recover','link')",
        )
        .get(String(req.body.id || ""));
      if (!ch || ch.expires < now() || ch.attempts >= 5)
        fail(400, "Code expired or too many attempts.");
      db.prepare("UPDATE challenges SET attempts=attempts+1 WHERE id=?").run(
        ch.id,
      );
      if (hash(ch.id + String(req.body.code)) !== ch.hash)
        fail(400, "Incorrect verification code.");
      let user = db
        .prepare("SELECT * FROM users WHERE email=? AND deleted IS NULL")
        .get(ch.target);
      if (ch.purpose === "link") {
        if (!req.user || req.user.id !== ch.payload)
          fail(401, "Sign in to the account that requested this code.");
        if (user && user.id !== req.user.id)
          fail(409, "Email is already linked.");
        db.prepare("UPDATE users SET email=? WHERE id=?").run(
          ch.target,
          req.user.id,
        );
        user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
      } else if (ch.purpose === "recover") {
        if (!user) fail(400, "No account is linked to that email.");
        const p = req.body.password;
        if (typeof p !== "string" || p.length < 10 || p.length > 256)
          fail(400, "New password must be 10–256 characters.");
        // With two-step on, the reset waits for the code: an email code
        // alone never changes the password or signs anyone in.
        if (twoStep.isOn(user.id)) {
          db.prepare("DELETE FROM challenges WHERE id=?").run(ch.id);
          return res.json(
            twoStep.begin(user, "recover", {
              password: passwordHash(p),
              email: ch.target,
            }),
          );
        }
        resetPassword(user, passwordHash(p), ch.target);
      } else user ||= newUser({ email: ch.target }, req);
      db.prepare("DELETE FROM challenges WHERE id=?").run(ch.id);
      // Linking an email happens inside a signed-in session: no second step.
      res.json(
        ch.purpose === "link"
          ? { user: session(res, user) }
          : signIn(res, user, ch.purpose === "recover" ? "recover" : "email"),
      );
    },
  );
  app.post(
    "/api/auth/wallet/challenge",
    limit("wallet", 20, 900000),
    (req, res) => {
      if (req.body.link && !req.user) fail(401, "Sign in to link a wallet.");
      let address;
      try {
        address = getAddress(req.body.address).toLowerCase();
      } catch {
        fail(400, "Invalid wallet address.");
      }
      const id = uid("w_"),
        nonce = uid();
      const message = `${new URL(cfg.origin).host} wants you to sign in with your Ethereum account:\n${getAddress(address)}\n\nSign in to Anonyma. This does not authorize a blockchain transaction.\n\nURI: ${cfg.origin}\nVersion: 1\nChain ID: ${cfg.walletChain}\nNonce: ${nonce}\nIssued At: ${new Date().toISOString()}\nExpiration Time: ${new Date(now() + 600000).toISOString()}`;
      db.prepare(
        "INSERT INTO challenges(id,target,purpose,hash,expires,payload) VALUES(?,?,?,?,?,?)",
      ).run(
        id,
        address,
        req.body.link ? "wallet_link" : "wallet",
        hash(message),
        now() + 600000,
        JSON.stringify({ message, user: req.user?.id }),
      );
      res.json({ id, message });
    },
  );
  app.post(
    "/api/auth/wallet/verify",
    limit("wallet_verify", 30, 900000),
    (req, res) => {
      const ch = db
        .prepare(
          "SELECT * FROM challenges WHERE id=? AND purpose IN ('wallet','wallet_link')",
        )
        .get(String(req.body.id || ""));
      if (!ch || ch.expires < now()) fail(400, "Wallet challenge expired.");
      const payload = JSON.parse(ch.payload);
      let signer;
      try {
        signer = verifyMessage(
          payload.message,
          req.body.signature,
        ).toLowerCase();
      } catch {
        fail(401, "Invalid signature.");
      }
      if (signer !== ch.target)
        fail(401, "Signature does not match the wallet.");
      let user = db
        .prepare("SELECT * FROM users WHERE wallet=? AND deleted IS NULL")
        .get(signer);
      if (ch.purpose === "wallet_link") {
        if (!req.user || payload.user !== req.user.id)
          fail(401, "Sign in to link this wallet.");
        if (user && user.id !== req.user.id)
          fail(409, "Wallet belongs to another account.");
        db.prepare(
          `UPDATE users SET wallet=?,${HOLDER_RESET} WHERE id=?`,
        ).run(signer, req.user.id);
        user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
      } else user ||= newUser({ wallet: signer }, req);
      db.prepare("DELETE FROM challenges WHERE id=?").run(ch.id);
      // Wallet sign-in takes the same second step; linking a wallet happens
      // inside a signed-in session.
      res.json(
        ch.purpose === "wallet_link"
          ? { user: session(res, user) }
          : signIn(res, user, "wallet"),
      );
    },
  );
  // The second step: the pending sign-in's token and a code. Per IP here,
  // per account in twoStep.verify (wrong codes lock code entry), per pending
  // sign-in by its attempt count.
  app.post(
    "/api/auth/two-step",
    limit("two_step", 20, 900000),
    (req, res) => {
      const p = twoStep.pending(req.body.token);
      const user = db
        .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
        .get(p.user_id);
      if (!user || !twoStep.isOn(user.id)) {
        db.prepare("DELETE FROM two_step_pending WHERE hash=?").run(p.hash);
        fail(400, "This sign-in expired. Sign in again.", "two_step_expired");
      }
      let result;
      try {
        result = twoStep.verify(user.id, req.body.code, { res });
      } catch (e) {
        if (e.status === 401)
          db.prepare(
            "UPDATE two_step_pending SET attempts=attempts+1 WHERE hash=?",
          ).run(p.hash);
        throw e;
      }
      db.prepare("DELETE FROM two_step_pending WHERE hash=?").run(p.hash);
      if (p.method === "recover") {
        const reset = JSON.parse(p.payload);
        resetPassword(user, reset.password, reset.email);
      }
      res.json({
        user: session(
          res,
          db.prepare("SELECT * FROM users WHERE id=?").get(user.id),
        ),
        twoStep: {
          method: result.method,
          recoveryCodesLeft: twoStep.codesLeft(user.id),
        },
      });
    },
  );
  app.post("/api/auth/logout", (req, res) => {
    db.prepare("DELETE FROM sessions WHERE hash=?").run(
      hash(req.cookies.anonyma_session || ""),
    );
    res
      .clearCookie("anonyma_session", sessionCookieOptions(cfg))
      .json({ ok: true });
  });
  app.post("/api/auth/logout-all", requireUser, (req, res) => {
    db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.id);
    res
      .clearCookie("anonyma_session", sessionCookieOptions(cfg))
      .json({ ok: true });
  });
  app.get("/api/account/sessions", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT created,expires FROM sessions WHERE user_id=? AND expires>? ORDER BY created DESC",
        )
        .all(req.user.id, now()),
    }),
  );
  app.post(
    "/api/account/token/refresh",
    requireUser,
    limit("token_refresh", 10, 3600000),
    async (req, res) => {
      if (!cfg.rpc || !cfg.token)
        fail(503, "Token contract and RPC are not configured.");
      if (!req.user.wallet) fail(400, "Link a wallet first.");
      await refreshTokenHoldings(db, cfg, req.user);
      res.json({
        user: publicUser(
          db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id),
        ),
      });
    },
  );
  // NYMA Holder Program: unlinking removes the wallet, its holdings and its
  // cycle from the account. An account that signs in only with that wallet must add
  // an email (or a passkey) first, or it could never sign in again.
  app.post(
    "/api/account/wallet/unlink",
    requireUser,
    limit("wallet_unlink", 10, 3600000),
    (req, res) => {
      if (!req.user.wallet) fail(400, "No wallet is linked.", "wallet_not_linked");
      // A passkey is another way in, once Passkeys is live.
      const passkey =
        isReleased(cfg, "passkeys") &&
        !!db.prepare("SELECT 1 FROM passkeys WHERE user_id=?").get(req.user.id);
      if (!req.user.password && !req.user.email && !passkey)
        fail(
          409,
          "This wallet is how you sign in. Link an email first, so you can still sign in without it.",
          "wallet_sign_in_only",
        );
      db.prepare(
        `UPDATE users SET wallet=NULL,${HOLDER_RESET} WHERE id=? AND deleted IS NULL`,
      ).run(req.user.id);
      res.json({
        user: publicUser(
          db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id),
        ),
      });
    },
  );
  // Passkeys (routes/passkeys.js) start sessions and create passwordless
  // accounts the same way.
  return {
    requireUser,
    publicUser,
    twoStep,
    sendEmailCode,
    startSession: session,
    newUser,
  };
}
export const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
export function validIPN(body, signature, secret) {
  if (
    !secret ||
    typeof signature !== "string" ||
    !/^[a-f0-9]{128}$/i.test(signature)
  )
    return false;
  const expected = createHmac("sha512", secret)
    .update(JSON.stringify(canonical(body)))
    .digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

// Reads the linked wallet's NYMA balance and records it (recordCheck in
// server/holders.js). `scheduled` marks the worker's own reads, which set
// the next one; an account's Refresh never moves that schedule.
export async function refreshTokenHoldings(db, cfg, user, { scheduled = false } = {}) {
  const rpc = new FetchRequest(cfg.rpc);
  rpc.timeout = cfg.rpcTimeoutMs || 10000;
  const provider = new JsonRpcProvider(rpc);
  try {
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== cfg.chain)
      fail(503, "RPC chain does not match configuration.");
    const contract = new Contract(
      cfg.token,
      [
        "function balanceOf(address) view returns(uint256)",
        "function decimals() view returns(uint8)",
      ],
      provider,
    );
    const [raw, decimals] = await Promise.all([
      contract.balanceOf(user.wallet),
      contract.decimals(),
    ]);
    const amount = Number(raw) / 10 ** Number(decimals);
    if (!Number.isFinite(amount)) throw Error("Invalid token balance.");
    // The wallet may have changed while the RPC was in flight: recordCheck
    // writes nothing then, so the old wallet's holdings never carry over.
    recordCheck(db, cfg, user, amount, { scheduled });
  } finally {
    provider.destroy();
  }
}
