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
    res.json({ user: session(res, user) });
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
      db.prepare(
        "INSERT INTO rate_events(kind,target,created) VALUES(?,?,?)",
      ).run("email", email, now());
      const code = String(randomInt(100000, 1000000));
      const id = uid("e_");
      db.prepare(
        "INSERT INTO challenges(id,target,purpose,hash,expires,payload) VALUES(?,?,?,?,?,?)",
      ).run(
        id,
        email,
        purpose,
        hash(id + code),
        now() + 600000,
        req.user?.id || null,
      );
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
        db.prepare("UPDATE users SET password=? WHERE id=?").run(
          passwordHash(p),
          user.id,
        );
        db.prepare("DELETE FROM sessions WHERE user_id=?").run(user.id);
        db.prepare(
          "DELETE FROM challenges WHERE target=? AND purpose IN ('login','recover')",
        ).run(ch.target);
      } else user ||= newUser({ email: ch.target }, req);
      db.prepare("DELETE FROM challenges WHERE id=?").run(ch.id);
      res.json({ user: session(res, user) });
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
          "UPDATE users SET wallet=?,token_balance='0',token_since=NULL,token_checked=NULL WHERE id=?",
        ).run(signer, req.user.id);
        user = db.prepare("SELECT * FROM users WHERE id=?").get(req.user.id);
      } else user ||= newUser({ wallet: signer }, req);
      db.prepare("DELETE FROM challenges WHERE id=?").run(ch.id);
      res.json({ user: session(res, user) });
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
  return { requireUser, publicUser };
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

export async function refreshTokenHoldings(db, cfg, user) {
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
    // The wallet may have changed while the RPC was in flight. Never transfer
    // the old wallet's discount to the newly linked wallet.
    const current = db
      .prepare(
        "SELECT * FROM users WHERE id=? AND wallet=? AND deleted IS NULL",
      )
      .get(user.id, user.wallet);
    if (!current) return;
    const old = Number(current.token_balance);
    const since =
      amount >= 5000000
        ? old >= 5000000
          ? current.token_since || now()
          : now()
        : null;
    db.prepare(
      "UPDATE users SET token_balance=?,token_since=?,token_checked=? WHERE id=? AND wallet=? AND deleted IS NULL",
    ).run(String(amount), since, now(), user.id, user.wallet);
  } finally {
    provider.destroy();
  }
}
