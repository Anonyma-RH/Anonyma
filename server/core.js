import { DatabaseSync } from "node:sqlite";
import {
  randomBytes,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { videoPresets } from "../data/video-presets.js";

export const uid = (prefix = "") => prefix + randomBytes(16).toString("hex");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const now = () => Date.now();
export const UNITS = 10_000_000; // integer subcredits per USD
export const credits = (n) => Number((n / 10000).toFixed(4));
export const usdUnits = (dollars) => {
  const scaled = Number(dollars) * UNITS;
  const rounded = Math.round(scaled);
  // Remove binary floating-point noise at an exact subcredit boundary.
  // Real fractional subcredits still round up for prepaid reservations.
  return Math.abs(scaled - rounded) <= Math.abs(scaled) * Number.EPSILON
    ? rounded
    : Math.ceil(scaled);
};
export function fail(status, message, code = "invalid_request") {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  throw e;
}
export function passwordHash(password) {
  const salt = randomBytes(16).toString("hex");
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password, stored) {
  const [salt, digest] = stored.split(":");
  return timingSafeEqual(
    Buffer.from(digest, "hex"),
    scryptSync(password, salt, 64),
  );
}
export function config(overrides = {}) {
  const e = process.env;
  const cfg = {
    port: Number(e.PORT || 3001),
    host: e.HOST || "127.0.0.1",
    origin: e.APP_ORIGIN || "http://localhost:5175",
    dbPath: e.DATABASE_PATH || "runtime/anonyma.sqlite",
    mediaPath: e.MEDIA_PATH || "runtime/media",
    testMode: e.LOCAL_TEST_MODE === "true",
    secret: e.APP_SECRET || "",
    gateway: e.GATEWAY_BASE_URL || "https://api.ppq.ai",
    gatewayKey: e.GATEWAY_API_KEY || "",
    mediaHosts: (e.MEDIA_ALLOWED_HOSTS || "api.ppq.ai").split(","),
    paymentKey: e.NOWPAYMENTS_API_KEY || "",
    paymentSecret: e.NOWPAYMENTS_IPN_SECRET || "",
    paymentBase: "https://api.nowpayments.io/v1",
    publicUrl: e.PUBLIC_BASE_URL || "",
    smtp: e.SMTP_URL || "",
    smtpFrom: e.SMTP_FROM || "",
    walletProject: e.WALLETCONNECT_PROJECT_ID || "",
    rpc: e.TOKEN_RPC_URL || "",
    token: e.TOKEN_CONTRACT || "",
    chain: Number(e.TOKEN_CHAIN_ID || 4663),
    walletChain: Number(e.WALLET_CHAIN_ID || 1),
    markup: Number(e.PLATFORM_MARKUP_PERCENT || 0),
    catalogPath: e.CATALOG_PATH || "runtime/models.cache.json",
    syncModels: e.AUTO_SYNC_MODELS === "true",
    supportEmail: e.SUPPORT_EMAIL || "",
    telegram: e.TELEGRAM_URL || "",
    ...overrides,
  };
  for (const field of [
    "origin",
    "publicUrl",
    "gateway",
    "paymentBase",
    "rpc",
  ]) {
    if (!cfg[field] && ["publicUrl", "rpc"].includes(field)) continue;
    let url;
    try {
      url = new URL(cfg[field]);
    } catch {
      throw Error(`Invalid ${field} URL.`);
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw Error(`Invalid ${field} URL.`);
    if (["origin", "publicUrl"].includes(field)) {
      if (url.pathname !== "/" || url.search || url.hash)
        throw Error(`${field} must be an origin without a path.`);
      cfg[field] = url.origin;
    }
  }
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535)
    throw Error("Invalid server port.");
  for (const field of ["chain", "walletChain"])
    if (!Number.isSafeInteger(cfg[field]) || cfg[field] < 1)
      throw Error(`Invalid ${field} ID.`);
  if (!Number.isFinite(cfg.markup) || cfg.markup < 0)
    throw Error("Markup must be a nonnegative percentage.");
  return cfg;
}
export function database(path) {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE, password TEXT, email TEXT UNIQUE, wallet TEXT UNIQUE, created INTEGER NOT NULL, deleted INTEGER, token_balance TEXT DEFAULT '0', token_since INTEGER, token_checked INTEGER);
 CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires INTEGER NOT NULL,created INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS challenges(id TEXT PRIMARY KEY,target TEXT NOT NULL,purpose TEXT NOT NULL,hash TEXT NOT NULL,expires INTEGER NOT NULL,attempts INTEGER DEFAULT 0,payload TEXT);
 CREATE TABLE IF NOT EXISTS rate_events(kind TEXT,target TEXT,created INTEGER);
 CREATE TABLE IF NOT EXISTS api_keys(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),hash TEXT UNIQUE,name TEXT NOT NULL,prefix TEXT,cap INTEGER,created INTEGER,revoked INTEGER,last_used INTEGER);
 CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),amount INTEGER NOT NULL,kind TEXT NOT NULL,ref TEXT UNIQUE NOT NULL,key_id TEXT,description TEXT,created INTEGER NOT NULL);
 CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger is append-only'); END;
 CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT,'Ledger is append-only'); END;
 CREATE TABLE IF NOT EXISTS holds(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),amount INTEGER NOT NULL,key_id TEXT,kind TEXT,status TEXT DEFAULT 'held',created INTEGER,expires INTEGER,result TEXT);
 CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),title TEXT,mode TEXT,created INTEGER,updated INTEGER);
 CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,role TEXT,content TEXT,model TEXT,cost INTEGER DEFAULT 0,created INTEGER);
 CREATE TABLE IF NOT EXISTS media(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),kind TEXT,mime TEXT,filename TEXT,prompt TEXT,model TEXT,cost INTEGER,created INTEGER,expires INTEGER);
 CREATE TABLE IF NOT EXISTS videos(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),hold_id TEXT,provider_id TEXT,status TEXT,request TEXT,error TEXT,media_id TEXT,created INTEGER,updated INTEGER);
 CREATE TABLE IF NOT EXISTS deposits(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),provider_id TEXT UNIQUE,amount INTEGER,currency TEXT,status TEXT,payload TEXT,credited INTEGER DEFAULT 0,created INTEGER,updated INTEGER);
 CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),subject TEXT,body TEXT,created INTEGER);
 CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id,created);
 CREATE INDEX IF NOT EXISTS holds_user ON holds(user_id,status);
 CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created);
 `);
  if (
    !db
      .prepare("PRAGMA table_info(users)")
      .all()
      .some((c) => c.name === "token_checked")
  )
    db.exec("ALTER TABLE users ADD COLUMN token_checked INTEGER");
  return db;
}
export function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}
export function balance(db, user) {
  const total = db
    .prepare("SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE user_id=?")
    .get(user).n;
  const held = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM holds WHERE user_id=? AND status='held'",
    )
    .get(user).n;
  return { total, held, available: total - held };
}
export function addCredit(
  db,
  user,
  amount,
  ref,
  kind = "deposit",
  description = "Credit deposit",
) {
  if (!Number.isSafeInteger(amount) || amount <= 0)
    fail(400, "Credit amount must be a positive integer.");
  db.prepare("INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?,?)").run(
    uid("l_"),
    user,
    amount,
    kind,
    ref,
    null,
    description,
    now(),
  );
}
export function reserve(
  db,
  { id, user, amount, key, kind = "chat", ttl = 300000 },
) {
  return transaction(db, () => {
    if (db.prepare("SELECT id FROM holds WHERE id=?").get(id))
      fail(
        409,
        "This request has already been submitted.",
        "duplicate_request",
      );
    if (!Number.isSafeInteger(amount) || amount < 0)
      fail(400, "Invalid reservation");
    if (balance(db, user).available < amount)
      fail(
        402,
        "Not enough credits for this request. Add credits or reduce the output limit.",
        "insufficient_credits",
      );
    if (key) {
      const k = db
        .prepare("SELECT * FROM api_keys WHERE id=? AND revoked IS NULL")
        .get(key);
      if (!k) fail(401, "Key revoked");
      const spent = -db
        .prepare(
          "SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE key_id=? AND amount<0 AND created>?",
        )
        .get(key, now() - 86400000).n;
      const inflight = db
        .prepare(
          "SELECT COALESCE(SUM(amount),0) n FROM holds WHERE key_id=? AND status='held'",
        )
        .get(key).n;
      if (k.cap != null && spent + inflight + amount > k.cap)
        fail(
          429,
          "This API key would exceed its rolling 24-hour spending cap.",
          "key_cap_exceeded",
        );
    }
    db.prepare(
      "INSERT INTO holds(id,user_id,amount,key_id,kind,created,expires) VALUES(?,?,?,?,?,?,?)",
    ).run(id, user, amount, key || null, kind, now(), now() + ttl);
    return amount;
  });
}
export function settle(
  db,
  id,
  actual,
  description = "Model usage",
  metadata = {},
) {
  return transaction(db, () => {
    const h = db.prepare("SELECT * FROM holds WHERE id=?").get(id);
    if (!h || h.status !== "held")
      return h?.result ? JSON.parse(h.result) : { charged: 0 };
    if (
      !Number.isFinite(actual) ||
      actual < 0 ||
      !Number.isSafeInteger(Math.ceil(actual))
    )
      fail(502, "Usage cost could not be verified.", "invalid_cost");
    const amount = Math.min(h.amount, Math.max(0, Math.ceil(actual)));
    if (amount)
      db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)").run(
        uid("l_"),
        h.user_id,
        -amount,
        h.kind,
        id,
        h.key_id,
        description,
        now(),
      );
    const result = {
      ...metadata,
      charged: amount,
      credits_charged: credits(amount),
      released: credits(h.amount - amount),
    };
    db.prepare("UPDATE holds SET status='settled',result=? WHERE id=?").run(
      JSON.stringify(result),
      id,
    );
    return result;
  });
}
export function release(db, id) {
  db.prepare(
    "UPDATE holds SET status='released' WHERE id=? AND status='held'",
  ).run(id);
}
const snapshot = JSON.parse(
  readFileSync(
    new URL("../data/models.snapshot.json", import.meta.url),
    "utf8",
  ),
);
export function catalog() {
  return {
    data: [
      ...snapshot.data,
      ...snapshot.dead.map((m) => ({ ...m, status: "unavailable" })),
    ],
    updatedAt: snapshot.updatedAt,
    source: "Reference catalog snapshot · 19 Sep 2026",
  };
}
export const vision = (m) =>
  (m.architecture?.input_modalities || []).includes("image");
export const imagePrices = {
  "google/gemini-3.1-flash-lite-image": 0.041,
  "google/gemini-2.5-flash-image": 0.047,
  "google/gemini-3.1-flash-image": 0.083,
  "google/gemini-3-pro-image": 0.163,
};
export function imageCallable(m) {
  return Object.hasOwn(imagePrices, m.id);
}
export function callable(m, cfg) {
  return (
    m.status === "live" &&
    !m.id.startsWith("private/") &&
    (["chat", "video"].includes(m.type) || imageCallable(m)) &&
    (m.type !== "video" || videoPresets(m).length > 0) &&
    (!(m.architecture?.output_modalities || []).includes("image") ||
      imageCallable(m)) &&
    (cfg.testMode || !!cfg.gatewayKey)
  );
}