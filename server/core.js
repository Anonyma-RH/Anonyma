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
import {
  DEFAULT_MVP_MODELS,
  modelReleased,
  parseReleased,
} from "./releases.js";
import { parseHolderRewards, parseHolderLoyalty } from "./holder-tiers.js";

export const uid = (prefix = "") => prefix + randomBytes(16).toString("hex");
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const now = () => Date.now();
export const UNITS = 10_000_000; // integer subcredits per USD
// Media generated through a Bearer-keyed request (chat images, /v1 media)
// gets a signed URL instead of a permanent library entry.
export const API_MEDIA_TTL_MS = 86400000;
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
// Only configured proxies may report the client address in X-Forwarded-For.
// Keep the backend port private when trusting a Docker bridge or subnet.
// Set TRUST_PROXY=false when nothing sits in front of the server.
export function parseTrustProxy(value) {
  const v = (value ?? "loopback").trim();
  if (["", "false", "0"].includes(v.toLowerCase())) return false;
  if (/^\d+$/.test(v))
    throw Error("TRUST_PROXY must name proxy addresses or subnets, not hops.");
  if (v.toLowerCase() === "true")
    throw Error(
      "TRUST_PROXY=true would let any client forge its address. Name the proxy's addresses or subnets instead.",
    );
  return v;
}
export function config(overrides = {}) {
  const e = process.env;
  const cfg = {
    production: e.NODE_ENV === "production",
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
    // NYMA Holder Program (server/holder-tiers.js): each tier's minimum
    // NYMA and credits every 30-day cycle, and the Loyal bonus. Early access
    // opens from the second tier (Insider).
    holderRewards: e.HOLDER_REWARDS || "",
    holderLoyalty: e.HOLDER_LOYALTY || "",
    walletChain: Number(e.WALLET_CHAIN_ID || 1),
    markup: Number(e.PLATFORM_MARKUP_PERCENT || 0),
    catalogPath: e.CATALOG_PATH || "runtime/models.cache.json",
    syncModels: e.AUTO_SYNC_MODELS === "true",
    supportEmail: e.SUPPORT_EMAIL || "",
    telegram: e.TELEGRAM_URL || "",
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    rateLimitUrl: e.RATE_LIMIT_REDIS_REST_URL || "",
    rateLimitToken: e.RATE_LIMIT_REDIS_REST_TOKEN || "",
    rateLimitNamespace: e.RATE_LIMIT_NAMESPACE || "anonyma",
    serverInstances: Number(e.SERVER_INSTANCES || 1),
    // The gateway's fee above the inference cost it reports (PPQ: 5.5%).
    gatewayFeePercent: Number(e.GATEWAY_FEE_PERCENT ?? 5.5),
    // Chat reservations hold this multiple of the price-list estimate.
    holdMargin: Number(e.HOLD_MARGIN ?? 4),
    // Per-request web search fee in USD (PPQ: $0.02 plus its 5.5% fee).
    webSearchPrice: Number(e.WEB_SEARCH_PRICE ?? 0.0211),
    // Share of a referred account's deposits credited to its referrer.
    referralPercent: Number(e.REFERRAL_PERCENT ?? 5),
    // Optional backup OpenAI-compatible gateway for chat (e.g. OpenRouter).
    gateway2: e.GATEWAY2_BASE_URL || "",
    gateway2Key: e.GATEWAY2_API_KEY || "",
    gateway2FeePercent: Number(e.GATEWAY2_FEE_PERCENT ?? 0),
    // Direct wallet payments: users send a dollar stablecoin from their linked
    // wallet to this public address and are credited once it's confirmed.
    // Defaults are USDG on Robinhood Chain.
    walletPaymentAddress: e.WALLET_PAYMENT_ADDRESS || "",
    walletPaymentRpc:
      e.WALLET_PAYMENT_RPC_URL || "https://rpc.mainnet.chain.robinhood.com",
    walletPaymentChain: Number(e.WALLET_PAYMENT_CHAIN_ID || 4663),
    walletPaymentContract:
      e.WALLET_PAYMENT_CONTRACT || "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
    walletPaymentSymbol: e.WALLET_PAYMENT_SYMBOL || "USDG",
    walletPaymentDecimals: Number(e.WALLET_PAYMENT_DECIMALS ?? 6),
    walletPaymentConfirmations: Number(e.WALLET_PAYMENT_CONFIRMATIONS ?? 10),
    // Ed25519 private key (base64 PKCS8 DER) that signs settlement receipts.
    // Production should set this; when unset, a key is generated on first
    // use and persisted in the database instead (see server/receipts.js).
    receiptSigningKey: e.RECEIPT_SIGNING_KEY || "",
    // Which updates are live ("all", or "mvp" plus update ids) and the MVP's
    // chat models while the full catalog isn't released.
    released: e.RELEASED_FEATURES ?? "mvp",
    mvpModels: e.MVP_MODELS
      ? e.MVP_MODELS.split(",")
          .map((v) => v.trim())
          .filter(Boolean)
      : DEFAULT_MVP_MODELS,
    // Private Mode follows the gateway's own zero-data-retention label; these
    // model ids are also counted as private (an operator override).
    privateModels: (e.PRIVATE_MODELS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    ...overrides,
  };
  if (!(cfg.released instanceof Set))
    cfg.released = parseReleased(cfg.released);
  if (!Number.isSafeInteger(cfg.serverInstances) || cfg.serverInstances < 1)
    throw Error("SERVER_INSTANCES must be a positive integer.");
  if (!!cfg.rateLimitUrl !== !!cfg.rateLimitToken)
    throw Error("Both rate limit REST URL and token are required.");
  if (cfg.serverInstances > 1 && !cfg.rateLimitUrl)
    throw Error("Multiple servers require a shared rate limit store.");
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(cfg.rateLimitNamespace))
    throw Error("Invalid rate limit namespace.");
  if (cfg.rateLimitUrl) {
    const url = new URL(cfg.rateLimitUrl);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          !cfg.production &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
        ))
    )
      throw Error(
        "Rate limit URL requires HTTPS (local HTTP is for development only).",
      );
  }
  for (const field of [
    "origin",
    "publicUrl",
    "gateway",
    "paymentBase",
    "rpc",
    "gateway2",
    "walletPaymentRpc",
  ]) {
    if (!cfg[field] && ["publicUrl", "rpc", "gateway2"].includes(field))
      continue;
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
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (
      url.protocol !== "https:" &&
      (cfg.production || (["origin", "publicUrl"].includes(field) && !loopback))
    )
      throw Error(
        `${field} must use HTTPS; HTTP is allowed only for local development origins.`,
      );
    if (["origin", "publicUrl"].includes(field)) {
      if (url.pathname !== "/" || url.search || url.hash)
        throw Error(`${field} must be an origin without a path.`);
      cfg[field] = url.origin;
    }
  }
  if (cfg.production && cfg.publicUrl && cfg.origin !== cfg.publicUrl)
    throw Error("APP_ORIGIN and PUBLIC_BASE_URL must match in production.");
  if (!Number.isInteger(cfg.port) || cfg.port < 0 || cfg.port > 65535)
    throw Error("Invalid server port.");
  for (const field of ["chain", "walletChain", "walletPaymentChain"])
    if (!Number.isSafeInteger(cfg[field]) || cfg[field] < 1)
      throw Error(`Invalid ${field} ID.`);
  for (const field of ["walletPaymentAddress", "walletPaymentContract"])
    if (cfg[field] && !/^0x[0-9a-fA-F]{40}$/.test(cfg[field]))
      throw Error(`Invalid ${field}: expected a 0x-prefixed 40-hex address.`);
  if (
    !Number.isInteger(cfg.walletPaymentDecimals) ||
    cfg.walletPaymentDecimals < 0 ||
    cfg.walletPaymentDecimals > 36
  )
    throw Error("Wallet payment decimals must be an integer from 0 to 36.");
  if (
    !Number.isInteger(cfg.walletPaymentConfirmations) ||
    cfg.walletPaymentConfirmations < 1 ||
    cfg.walletPaymentConfirmations > 10000
  )
    throw Error("Wallet payment confirmations must be from 1 to 10000.");
  if (!Number.isFinite(cfg.markup) || cfg.markup < 0)
    throw Error("Markup must be a nonnegative percentage.");
  if (!Array.isArray(cfg.holderRewards))
    cfg.holderRewards = parseHolderRewards(cfg.holderRewards);
  if (typeof cfg.holderLoyalty !== "object" || cfg.holderLoyalty === null)
    cfg.holderLoyalty = parseHolderLoyalty(cfg.holderLoyalty);
  if (
    !Number.isFinite(cfg.gatewayFeePercent) ||
    cfg.gatewayFeePercent < 0 ||
    cfg.gatewayFeePercent > 100
  )
    throw Error("Gateway fee must be a percentage from 0 to 100.");
  if (
    !Number.isFinite(cfg.holdMargin) ||
    cfg.holdMargin < 1 ||
    cfg.holdMargin > 20
  )
    throw Error("Hold margin must be between 1 and 20.");
  if (
    !Number.isFinite(cfg.webSearchPrice) ||
    cfg.webSearchPrice < 0 ||
    cfg.webSearchPrice > 1
  )
    throw Error("Web search price must be between 0 and 1 USD.");
  if (
    !Number.isFinite(cfg.referralPercent) ||
    cfg.referralPercent < 0 ||
    cfg.referralPercent > 50
  )
    throw Error("Referral percent must be between 0 and 50.");
  if (
    !Number.isFinite(cfg.gateway2FeePercent) ||
    cfg.gateway2FeePercent < 0 ||
    cfg.gateway2FeePercent > 100
  )
    throw Error("Backup gateway fee must be a percentage from 0 to 100.");
  return cfg;
}
const addColumn = (db, table, column, definition) => {
  if (
    !db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column)
  )
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
};
// Schema upgrades, applied in order and recorded in PRAGMA user_version.
// Only ever append: a released step must never be edited or reordered.
// Steps must also be safe on databases created before versioning existed
// (user_version 0), which is why they use IF NOT EXISTS / addColumn.
// A migration that only adds tables, indexes or triggers records its version
// in schema_additive, so an earlier build can still start on the upgraded
// database (see migrate) and a rollback doesn't need a restore.
const ADDITIVE =
  "CREATE TABLE IF NOT EXISTS schema_additive(version INTEGER PRIMARY KEY)";
const additive = (sql) => (db) => {
  db.exec(sql);
  db.exec(ADDITIVE);
  db.prepare("INSERT OR IGNORE INTO schema_additive(version) VALUES(?)").run(
    db.prepare("PRAGMA user_version").get().user_version + 1,
  );
};
export const MIGRATIONS = [
  (db) =>
    db.exec(`
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
 CREATE INDEX IF NOT EXISTS deposits_user_status ON deposits(user_id,status,credited);
 CREATE INDEX IF NOT EXISTS messages_conversation ON messages(conversation_id,created);
`),
  (db) => addColumn(db, "users", "token_checked", "INTEGER"),
  (db) => addColumn(db, "holds", "uncovered", "INTEGER DEFAULT 0"),
  // API-key spending caps sum the ledger by key on every reservation.
  (db) =>
    db.exec("CREATE INDEX IF NOT EXISTS ledger_key ON ledger(key_id,created)"),
  // Referral codes and who referred each account.
  (db) => {
    addColumn(db, "users", "referral_code", "TEXT");
    addColumn(db, "users", "referred_by", "TEXT");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code ON users(referral_code) WHERE referral_code IS NOT NULL",
    );
  },
  // Collab: shared workspaces whose members read and write the same
  // conversations; messages record who wrote them.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS collabs(id TEXT PRIMARY KEY,owner_id TEXT REFERENCES users(id),name TEXT NOT NULL,invite_hash TEXT UNIQUE,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS collab_members(collab_id TEXT REFERENCES collabs(id) ON DELETE CASCADE,user_id TEXT REFERENCES users(id),role TEXT NOT NULL,joined INTEGER NOT NULL,PRIMARY KEY(collab_id,user_id));
      CREATE INDEX IF NOT EXISTS collab_members_user ON collab_members(user_id);
    `);
    addColumn(
      db,
      "conversations",
      "collab_id",
      "TEXT REFERENCES collabs(id) ON DELETE CASCADE",
    );
    addColumn(db, "messages", "author_id", "TEXT");
    db.exec(
      "CREATE INDEX IF NOT EXISTS conversations_collab ON conversations(collab_id,updated)",
    );
  },
  (db) => {
    addColumn(db, "tickets", "email", "TEXT");
    addColumn(db, "tickets", "delivery", "TEXT DEFAULT 'saved'");
    addColumn(db, "tickets", "delivered_at", "INTEGER");
  },
  (db) =>
    db.exec(`
    CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY,count INTEGER NOT NULL,expires INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires);
  `),
  // Auto-delete: a saved conversation can carry an expiry, and an account
  // can set a default applied to conversations created after the change.
  (db) => {
    addColumn(db, "conversations", "expires", "INTEGER");
    db.exec(
      "CREATE TABLE IF NOT EXISTS retention_defaults(user_id TEXT PRIMARY KEY REFERENCES users(id), days INTEGER NOT NULL)",
    );
  },
  // Signed receipts: an Ed25519 keypair (generated on first use unless
  // RECEIPT_SIGNING_KEY is set) and the signature saved for each settled
  // chat request that opted in.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS receipt_keys(id TEXT PRIMARY KEY,public_key TEXT NOT NULL,private_key TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS receipt_signatures(receipt_id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),key_id TEXT NOT NULL,payload TEXT NOT NULL,signature TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS receipt_signatures_user ON receipt_signatures(user_id,created);
    `);
  },
  // Scrolls: saved reusable prompts with {{variable}} placeholders. Standing
  // instructions: one editable system message the client may send with chat.
  (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scrolls(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),title TEXT NOT NULL,body TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS scrolls_user ON scrolls(user_id);
      CREATE TABLE IF NOT EXISTS user_instructions(user_id TEXT PRIMARY KEY REFERENCES users(id),body TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,updated INTEGER NOT NULL);
    `);
  },
  // Agent allowances: an API key can carry a lifetime credit cap, an expiry,
  // a pause switch and a label, enforced alongside the existing 24h cap.
  (db) => {
    addColumn(db, "api_keys", "allowance_total", "INTEGER");
    addColumn(db, "api_keys", "allowance_expires", "INTEGER");
    addColumn(db, "api_keys", "paused_at", "INTEGER");
    addColumn(db, "api_keys", "agent_label", "TEXT");
  },
  // Connect an App: OAuth for the MCP server. Apps register as public
  // clients; each approval is a connection backed by an allowance-carrying
  // api_keys row that has no usable secret. Codes and tokens are stored only
  // as SHA-256 hashes.
  (db) => {
    addColumn(db, "api_keys", "connection_id", "TEXT");
    db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients(id TEXT PRIMARY KEY,name TEXT NOT NULL,redirect_uris TEXT NOT NULL,created INTEGER NOT NULL,authorized INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_connections(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),client_id TEXT NOT NULL,key_id TEXT NOT NULL REFERENCES api_keys(id),name TEXT NOT NULL,client_name TEXT NOT NULL,redirect_uri TEXT NOT NULL,private_only INTEGER NOT NULL DEFAULT 1,created INTEGER NOT NULL,activated INTEGER,expires INTEGER NOT NULL,revoked INTEGER);
      CREATE INDEX IF NOT EXISTS oauth_connections_user ON oauth_connections(user_id,created);
      CREATE TABLE IF NOT EXISTS oauth_codes(hash TEXT PRIMARY KEY,connection_id TEXT NOT NULL,client_id TEXT NOT NULL,redirect_uri TEXT NOT NULL,code_challenge TEXT NOT NULL,resource TEXT,expires INTEGER NOT NULL,used INTEGER);
      CREATE TABLE IF NOT EXISTS oauth_tokens(hash TEXT PRIMARY KEY,connection_id TEXT NOT NULL,kind TEXT NOT NULL,created INTEGER NOT NULL,expires INTEGER NOT NULL,rotated INTEGER);
      CREATE INDEX IF NOT EXISTS oauth_tokens_connection ON oauth_tokens(connection_id,kind);
      CREATE INDEX IF NOT EXISTS oauth_tokens_expiry ON oauth_tokens(expires);
    `);
  },
  // Branch chats: a branch records the conversation and message it was cut
  // from, and copied messages point back at their originals. branch_key
  // (user + request id) makes a retried branch request return the same copy.
  (db) => {
    addColumn(db, "conversations", "parent_id", "TEXT");
    addColumn(db, "conversations", "branch_point", "TEXT");
    addColumn(db, "conversations", "branch_key", "TEXT");
    addColumn(db, "conversations", "branch_cut", "TEXT");
    addColumn(db, "messages", "origin_id", "TEXT");
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS conversations_branch_key ON conversations(branch_key) WHERE branch_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS conversations_parent ON conversations(parent_id) WHERE parent_id IS NOT NULL;
    `);
  },
  // NYMA holdings: token_checked records only a successful balance
  // read, so a failed one backs off here instead of looking like a check.
  (db) => addColumn(db, "users", "token_retry", "INTEGER"),
  // NYMA Holder Program (server/holders.js). On users: when the worker's
  // next balance read is due (token_due, at a random time), the open 30-day
  // cycle's start and lowest balance, and the paid cycles in a row.
  // holder_rewards records each paid cycle once: its primary key is what
  // makes a payout impossible to repeat. roadmap_votes holds one Inner
  // Circle vote per account per UTC month.
  (db) => {
    addColumn(db, "users", "token_due", "INTEGER");
    addColumn(db, "users", "holder_cycle", "INTEGER");
    addColumn(db, "users", "holder_low", "TEXT");
    addColumn(db, "users", "holder_paid", "INTEGER NOT NULL DEFAULT 0");
    db.exec(`
      CREATE INDEX IF NOT EXISTS users_holder_cycle ON users(holder_cycle) WHERE holder_cycle IS NOT NULL;
      CREATE TABLE IF NOT EXISTS holder_rewards(user_id TEXT NOT NULL REFERENCES users(id),cycle_start INTEGER NOT NULL,paid INTEGER NOT NULL,tier TEXT NOT NULL,amount INTEGER NOT NULL,bonus INTEGER NOT NULL DEFAULT 0,ref TEXT UNIQUE NOT NULL,PRIMARY KEY(user_id,cycle_start));
      CREATE INDEX IF NOT EXISTS holder_rewards_paid ON holder_rewards(paid);
      CREATE TABLE IF NOT EXISTS roadmap_votes(month TEXT NOT NULL,user_id TEXT NOT NULL REFERENCES users(id),update_id TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,PRIMARY KEY(month,user_id));
    `);
  },
  // Team Treasury: a collab's shared balance is its own ledger account (a
  // hidden users row), with per-member limits that go when the membership
  // goes, and the member behind each team-paid reservation. The trigger
  // refuses to delete a collab whose treasury still has credits or holds,
  // whichever build runs: members' contributions are never orphaned, even
  // by code from before this migration after a rollback.
  additive(`
      CREATE TABLE IF NOT EXISTS treasury_accounts(collab_id TEXT PRIMARY KEY,account_user_id TEXT UNIQUE NOT NULL REFERENCES users(id),created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS treasury_members(collab_id TEXT NOT NULL,user_id TEXT NOT NULL,daily_limit INTEGER,monthly_limit INTEGER,updated INTEGER NOT NULL,PRIMARY KEY(collab_id,user_id),FOREIGN KEY(collab_id,user_id) REFERENCES collab_members(collab_id,user_id) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS treasury_spends(hold_id TEXT PRIMARY KEY,collab_id TEXT NOT NULL,user_id TEXT NOT NULL,model TEXT,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS treasury_spends_member ON treasury_spends(collab_id,user_id,created);
      CREATE TRIGGER IF NOT EXISTS treasury_keeps_collab BEFORE DELETE ON collabs
      WHEN EXISTS (SELECT 1 FROM treasury_accounts t WHERE t.collab_id=OLD.id AND (
        (SELECT COALESCE(SUM(amount),0) FROM ledger WHERE user_id=t.account_user_id)<>0
        OR EXISTS (SELECT 1 FROM holds WHERE user_id=t.account_user_id AND status='held')))
      BEGIN SELECT RAISE(ABORT,'treasury_not_empty'); END;
    `),
  // Double-check This: a saved second opinion is a copy of the question and
  // answer it reviewed, so it links to that conversation (source_id) and
  // never outlives it. Deleting the source deletes its checks, whatever the
  // path (delete, delete all, cap pruning, expiry cleanup, collab deletion).
  // Shortening the source's auto-delete shortens its checks, and no update
  // can give a check a later deadline than its source; a longer source
  // deadline never extends a check. A member who leaves (or is removed from)
  // a collab loses their checks of its conversations along with access.
  (db) => {
    addColumn(
      db,
      "conversations",
      "source_id",
      "TEXT REFERENCES conversations(id) ON DELETE CASCADE",
    );
    db.exec(`
      CREATE INDEX IF NOT EXISTS conversations_source ON conversations(source_id) WHERE source_id IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS conversation_checks_shorten AFTER UPDATE OF expires ON conversations
        WHEN NEW.expires IS NOT NULL
        BEGIN
          UPDATE conversations SET expires=NEW.expires
            WHERE source_id=NEW.id AND (expires IS NULL OR expires>NEW.expires);
        END;
      CREATE TRIGGER IF NOT EXISTS conversation_check_bounded AFTER UPDATE OF expires, source_id ON conversations
        WHEN NEW.source_id IS NOT NULL AND (SELECT s.expires FROM conversations s WHERE s.id=NEW.source_id) IS NOT NULL
          AND (NEW.expires IS NULL OR NEW.expires>(SELECT s.expires FROM conversations s WHERE s.id=NEW.source_id))
        BEGIN
          UPDATE conversations SET expires=(SELECT s.expires FROM conversations s WHERE s.id=NEW.source_id) WHERE id=NEW.id;
        END;
      CREATE TRIGGER IF NOT EXISTS conversation_check_bounded_insert AFTER INSERT ON conversations
        WHEN NEW.source_id IS NOT NULL AND (SELECT s.expires FROM conversations s WHERE s.id=NEW.source_id) IS NOT NULL
          AND (NEW.expires IS NULL OR NEW.expires>(SELECT s.expires FROM conversations s WHERE s.id=NEW.source_id))
        BEGIN
          UPDATE conversations SET expires=(SELECT s.expires FROM conversations s WHERE s.id=NEW.source_id) WHERE id=NEW.id;
        END;
      CREATE TRIGGER IF NOT EXISTS conversation_check_never_extend AFTER UPDATE OF expires ON conversations
        WHEN OLD.source_id IS NOT NULL AND OLD.expires IS NOT NULL
          AND (NEW.expires IS NULL OR NEW.expires>OLD.expires)
        BEGIN
          UPDATE conversations SET expires=MIN(OLD.expires,COALESCE((SELECT s.expires FROM conversations s WHERE s.id=NEW.source_id),OLD.expires)) WHERE id=NEW.id;
        END;
      CREATE TRIGGER IF NOT EXISTS collab_member_checks_removed AFTER DELETE ON collab_members
        BEGIN
          DELETE FROM conversations WHERE user_id=OLD.user_id AND source_id IN
            (SELECT id FROM conversations WHERE collab_id=OLD.collab_id);
        END;
    `);
  },
  // Library provenance keeps only a link for chat-derived media, never a
  // second copy of source prompts. Standalone studio recipes follow the media.
  additive(`
    CREATE TABLE IF NOT EXISTS library_items(media_id TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,source_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,had_source INTEGER NOT NULL DEFAULT 0,recipe TEXT);
    CREATE INDEX IF NOT EXISTS library_items_source ON library_items(source_id) WHERE source_id IS NOT NULL;
    CREATE TRIGGER IF NOT EXISTS library_member_access_removed AFTER DELETE ON collab_members
    BEGIN UPDATE library_items SET source_id=NULL,recipe=NULL WHERE media_id IN (SELECT id FROM media WHERE user_id=OLD.user_id) AND source_id IN (SELECT id FROM conversations WHERE collab_id=OLD.collab_id); END;
  `),
  // Optional Memory Across Models: facts a user writes (or saves from a
  // message of a saved personal chat) and shares with every model, plus the
  // account's opt-in switch, off by default. A fact saved from a chat keeps a
  // link to it only for display; deleting that chat leaves the fact.
  additive(`
      CREATE TABLE IF NOT EXISTS memory_facts(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),text TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,source_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memory_facts_user ON memory_facts(user_id,created);
      CREATE INDEX IF NOT EXISTS memory_facts_source ON memory_facts(source_conversation_id) WHERE source_conversation_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS memory_settings(user_id TEXT PRIMARY KEY REFERENCES users(id),enabled INTEGER NOT NULL DEFAULT 0,updated INTEGER NOT NULL);
  `),
  // Files & Reusable Uploads: explicit, owner-only saved uploads with a
  // mandatory expiry. Original bytes and bounded extracted text stay in SQLite
  // with their owner, so no filesystem path comes from a submitted filename.
  additive(`CREATE TABLE IF NOT EXISTS uploads(
      id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),name TEXT NOT NULL,
      bytes INTEGER NOT NULL,kind TEXT NOT NULL,mime TEXT NOT NULL,text TEXT,truncated INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL,expires INTEGER NOT NULL,content BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS uploads_owner ON uploads(user_id,created,id);
      CREATE INDEX IF NOT EXISTS uploads_expiry ON uploads(expires);`),
  // Spending Limits (server/spending-limits.js): an account's own daily
  // (rolling 24 hours) and monthly (rolling 30 days) limits on what its
  // personal balance can spend, in integer subcredits; NULL means no limit.
  // A raise or removal waits in the *_pending columns until *_pending_at
  // (a NULL pending value with a time set is a pending removal). Settings
  // only: a limit change never writes the ledger.
  additive(`CREATE TABLE IF NOT EXISTS spending_limits(
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      daily_limit INTEGER CHECK(daily_limit IS NULL OR (typeof(daily_limit)='integer' AND daily_limit>=0)),
      monthly_limit INTEGER CHECK(monthly_limit IS NULL OR (typeof(monthly_limit)='integer' AND monthly_limit>=0)),
      daily_pending INTEGER CHECK(daily_pending IS NULL OR (typeof(daily_pending)='integer' AND daily_pending>=0)),
      daily_pending_at INTEGER,
      monthly_pending INTEGER CHECK(monthly_pending IS NULL OR (typeof(monthly_pending)='integer' AND monthly_pending>=0)),
      monthly_pending_at INTEGER,
      updated INTEGER NOT NULL);`),
  // Share a Chat: a read-only snapshot of one saved personal conversation,
  // published at an unguessable token (routes/shares.js). The snapshot is a
  // copy taken once. It goes with its conversation whatever deletes it
  // (delete, delete all, cap pruning, auto-delete cleanup, account closure)
  // and never outlives the conversation's auto-delete: a new link is capped
  // at it, a shorter auto-delete shortens every link, and a longer or cleared
  // one never extends them. Only the conversation's creator can share it, and
  // never a collab conversation, whichever code writes the row.
  additive(`
      CREATE TABLE IF NOT EXISTS share_links(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,token TEXT UNIQUE NOT NULL,title TEXT NOT NULL,snapshot TEXT NOT NULL,message_count INTEGER NOT NULL,created INTEGER NOT NULL,expires INTEGER);
      CREATE INDEX IF NOT EXISTS share_links_user ON share_links(user_id,created);
      CREATE INDEX IF NOT EXISTS share_links_conversation ON share_links(conversation_id);
      CREATE INDEX IF NOT EXISTS share_links_expiry ON share_links(expires) WHERE expires IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS share_links_personal_only BEFORE INSERT ON share_links
        WHEN (SELECT collab_id FROM conversations WHERE id=NEW.conversation_id) IS NOT NULL
          OR (SELECT user_id FROM conversations WHERE id=NEW.conversation_id) IS NOT NEW.user_id
        BEGIN SELECT RAISE(ABORT,'share_personal_only'); END;
      CREATE TRIGGER IF NOT EXISTS share_links_bounded AFTER INSERT ON share_links
        WHEN (SELECT expires FROM conversations WHERE id=NEW.conversation_id) IS NOT NULL
          AND (NEW.expires IS NULL OR NEW.expires>(SELECT expires FROM conversations WHERE id=NEW.conversation_id))
        BEGIN
          UPDATE share_links SET expires=(SELECT expires FROM conversations WHERE id=NEW.conversation_id) WHERE id=NEW.id;
        END;
      CREATE TRIGGER IF NOT EXISTS share_links_bounded_update AFTER UPDATE OF expires ON share_links
        WHEN (SELECT expires FROM conversations WHERE id=NEW.conversation_id) IS NOT NULL
          AND (NEW.expires IS NULL OR NEW.expires>(SELECT expires FROM conversations WHERE id=NEW.conversation_id))
        BEGIN
          UPDATE share_links SET expires=(SELECT expires FROM conversations WHERE id=NEW.conversation_id) WHERE id=NEW.id;
        END;
      CREATE TRIGGER IF NOT EXISTS share_links_follow_retention AFTER UPDATE OF expires ON conversations
        WHEN NEW.expires IS NOT NULL
        BEGIN
          UPDATE share_links SET expires=NEW.expires
            WHERE conversation_id=NEW.id AND (expires IS NULL OR expires>NEW.expires);
        END;
  `),
  // Usage Insights (server/usage-insights.js): what a chat request's spend is
  // filed under (chat, web search, Symposium or Double-check) and its model
  // id, keyed by its hold. Written when the request is reserved, only while
  // the update is released; no content, and no user id of its own.
  additive(`CREATE TABLE IF NOT EXISTS usage_tags(
      hold_id TEXT PRIMARY KEY REFERENCES holds(id),
      feature TEXT NOT NULL,
      model TEXT);`),
  // Routines (server/routines.js): saved prompts that run on a schedule with
  // a per-run maximum and a monthly budget, in integer subcredits. minute is
  // minutes past midnight in the IANA timezone; weekday (0 = Sunday) is set
  // for weekly routines only. next_run is the next slot (NULL while off);
  // running_since marks the one run in flight. At most ten per account, also
  // enforced here. Runs are the Routines inbox: the answer, charge and signed
  // receipt of each run, the newest 50 per routine, going with the routine.
  additive(`
      CREATE TABLE IF NOT EXISTS routines(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,prompt TEXT NOT NULL,model TEXT NOT NULL,
        web_search INTEGER NOT NULL DEFAULT 0 CHECK(web_search IN (0,1)),
        private_only INTEGER NOT NULL DEFAULT 0 CHECK(private_only IN (0,1)),
        repeat TEXT NOT NULL CHECK(repeat IN ('daily','weekdays','weekly')),
        minute INTEGER NOT NULL CHECK(minute BETWEEN 0 AND 1439),
        weekday INTEGER CHECK(weekday IS NULL OR weekday BETWEEN 0 AND 6),
        timezone TEXT NOT NULL,
        run_cap INTEGER NOT NULL CHECK(typeof(run_cap)='integer' AND run_cap>0),
        monthly_budget INTEGER NOT NULL CHECK(typeof(monthly_budget)='integer' AND monthly_budget>0),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
        next_run INTEGER,running_since INTEGER,last_run INTEGER,last_status TEXT,
        created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS routines_user ON routines(user_id,created);
      CREATE INDEX IF NOT EXISTS routines_due ON routines(next_run) WHERE enabled=1;
      CREATE TRIGGER IF NOT EXISTS routines_per_account BEFORE INSERT ON routines
        WHEN (SELECT COUNT(*) FROM routines WHERE user_id=NEW.user_id)>=10
        BEGIN SELECT RAISE(ABORT,'routine_limit'); END;
      CREATE TABLE IF NOT EXISTS routine_runs(id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),
        slot INTEGER NOT NULL,started INTEGER NOT NULL,finished INTEGER,
        status TEXT NOT NULL CHECK(status IN ('running','done','refused','failed')),
        skipped INTEGER NOT NULL DEFAULT 0,model TEXT,
        web_search INTEGER NOT NULL DEFAULT 0,private_only INTEGER NOT NULL DEFAULT 0,
        request_id TEXT,charged INTEGER NOT NULL DEFAULT 0,reply_budget INTEGER,finish_reason TEXT,
        answer TEXT,citations TEXT,receipt TEXT,code TEXT,message TEXT);
      CREATE INDEX IF NOT EXISTS routine_runs_routine ON routine_runs(routine_id,started);
      CREATE INDEX IF NOT EXISTS routine_runs_user ON routine_runs(user_id,started);
  `),
  // Sealed Share (routes/shares.js): a share link whose snapshot the browser
  // encrypted before uploading it. Only the ciphertext is stored; the key is
  // in the link's #fragment, which never reaches the server. A sealed copy of
  // a saved conversation follows the same rules as share_links: it goes with
  // its conversation and never outlives its auto-delete. A Device-only chat
  // has no conversation here (conversation_id NULL); its link lasts until it
  // expires, is revoked or the account's content is erased.
  additive(`
      CREATE TABLE IF NOT EXISTS sealed_shares(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
        conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,ciphertext BLOB NOT NULL,created INTEGER NOT NULL,expires INTEGER);
      CREATE INDEX IF NOT EXISTS sealed_shares_user ON sealed_shares(user_id,created);
      CREATE INDEX IF NOT EXISTS sealed_shares_conversation ON sealed_shares(conversation_id) WHERE conversation_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS sealed_shares_expiry ON sealed_shares(expires) WHERE expires IS NOT NULL;
      CREATE TRIGGER IF NOT EXISTS sealed_shares_personal_only BEFORE INSERT ON sealed_shares
        WHEN NEW.conversation_id IS NOT NULL AND (
          (SELECT collab_id FROM conversations WHERE id=NEW.conversation_id) IS NOT NULL
          OR (SELECT user_id FROM conversations WHERE id=NEW.conversation_id) IS NOT NEW.user_id)
        BEGIN SELECT RAISE(ABORT,'share_personal_only'); END;
      CREATE TRIGGER IF NOT EXISTS sealed_shares_bounded AFTER INSERT ON sealed_shares
        WHEN NEW.conversation_id IS NOT NULL
          AND (SELECT expires FROM conversations WHERE id=NEW.conversation_id) IS NOT NULL
          AND (NEW.expires IS NULL OR NEW.expires>(SELECT expires FROM conversations WHERE id=NEW.conversation_id))
        BEGIN
          UPDATE sealed_shares SET expires=(SELECT expires FROM conversations WHERE id=NEW.conversation_id) WHERE id=NEW.id;
        END;
      CREATE TRIGGER IF NOT EXISTS sealed_shares_bounded_update AFTER UPDATE OF expires ON sealed_shares
        WHEN NEW.conversation_id IS NOT NULL
          AND (SELECT expires FROM conversations WHERE id=NEW.conversation_id) IS NOT NULL
          AND (NEW.expires IS NULL OR NEW.expires>(SELECT expires FROM conversations WHERE id=NEW.conversation_id))
        BEGIN
          UPDATE sealed_shares SET expires=(SELECT expires FROM conversations WHERE id=NEW.conversation_id) WHERE id=NEW.id;
        END;
      CREATE TRIGGER IF NOT EXISTS sealed_shares_follow_retention AFTER UPDATE OF expires ON conversations
        WHEN NEW.expires IS NOT NULL
        BEGIN
          UPDATE sealed_shares SET expires=NEW.expires
            WHERE conversation_id=NEW.id AND (expires IS NULL OR expires>NEW.expires);
        END;
  `),
  // Projects (server/routes/projects.js): folders for an account's saved
  // chats with shared context. A project keeps a name, a colour from the
  // house palette, optional instructions (the browser sends them with every
  // chat in it, like standing instructions), how a new chat in it starts
  // (starts: normal, off_record or private) and a default model; at most 50
  // per account, also enforced here.
  // project_chats files a saved personal conversation (a Symposium run too)
  // in one project of its own creator; the row goes with the conversation
  // (delete, delete all, cap pruning, auto-delete) or the project, whose
  // chats then stay unfiled. Off-the-record, Private and Device-only chats
  // are never saved, so never filed. project_files pins up to five of the
  // account's saved uploads; a pin goes with its upload (expiry included)
  // or the project. The triggers keep every row inside one account,
  // whichever code writes it.
  additive(`
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,color TEXT NOT NULL,instructions TEXT NOT NULL DEFAULT '',
        starts TEXT NOT NULL DEFAULT 'normal' CHECK(starts IN ('normal','off_record','private')),
        model TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS projects_user ON projects(user_id,created);
      CREATE TRIGGER IF NOT EXISTS projects_per_account BEFORE INSERT ON projects
        WHEN (SELECT COUNT(*) FROM projects WHERE user_id=NEW.user_id)>=50
        BEGIN SELECT RAISE(ABORT,'project_limit'); END;
      CREATE TABLE IF NOT EXISTS project_chats(
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),added INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS project_chats_project ON project_chats(project_id,added);
      CREATE INDEX IF NOT EXISTS project_chats_user ON project_chats(user_id);
      CREATE TRIGGER IF NOT EXISTS project_chats_own BEFORE INSERT ON project_chats
        WHEN (SELECT user_id FROM projects WHERE id=NEW.project_id) IS NOT NEW.user_id
          OR (SELECT user_id FROM conversations WHERE id=NEW.conversation_id) IS NOT NEW.user_id
          OR (SELECT collab_id FROM conversations WHERE id=NEW.conversation_id) IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'project_owner_only'); END;
      CREATE TRIGGER IF NOT EXISTS project_chats_own_update BEFORE UPDATE ON project_chats
        WHEN (SELECT user_id FROM projects WHERE id=NEW.project_id) IS NOT NEW.user_id
          OR (SELECT user_id FROM conversations WHERE id=NEW.conversation_id) IS NOT NEW.user_id
          OR (SELECT collab_id FROM conversations WHERE id=NEW.conversation_id) IS NOT NULL
        BEGIN SELECT RAISE(ABORT,'project_owner_only'); END;
      CREATE TABLE IF NOT EXISTS project_files(
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        upload_id TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id),added INTEGER NOT NULL,
        PRIMARY KEY(project_id,upload_id));
      CREATE INDEX IF NOT EXISTS project_files_upload ON project_files(upload_id);
      CREATE TRIGGER IF NOT EXISTS project_files_own BEFORE INSERT ON project_files
        WHEN (SELECT user_id FROM projects WHERE id=NEW.project_id) IS NOT NEW.user_id
          OR (SELECT user_id FROM uploads WHERE id=NEW.upload_id) IS NOT NEW.user_id
        BEGIN SELECT RAISE(ABORT,'project_owner_only'); END;
      CREATE TRIGGER IF NOT EXISTS project_files_per_project BEFORE INSERT ON project_files
        WHEN (SELECT COUNT(*) FROM project_files WHERE project_id=NEW.project_id)>=5
        BEGIN SELECT RAISE(ABORT,'project_files_limit'); END;
  `),
  // Two-Step Sign-in (server/two-step.js). two_step: the authenticator
  // secret, sealed with a key derived from the app secret (never stored in
  // the clear); enabled=0 is a setup waiting for its first code. last_step
  // is the newest 30-second step whose code was accepted (older codes are
  // refused), then the wrong-code count and the lock. Recovery codes are
  // kept only as salted hashes, each usable once. two_step_pending: a
  // sign-in whose first step (method) succeeded, waiting for its code; the
  // token is kept as a hash, and payload holds a password reset's new hash
  // until the code is right. two_step_reauth: when a session last confirmed
  // it's its owner (password, email code or wallet signature), which turning
  // two-step on and new recovery codes need within the last 10 minutes; keyed
  // by the session's hash, so it never carries over to another session.
  additive(`
      CREATE TABLE IF NOT EXISTS two_step(user_id TEXT PRIMARY KEY REFERENCES users(id),
        secret TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
        enabled_at INTEGER,last_step INTEGER,
        failures INTEGER NOT NULL DEFAULT 0,failed_since INTEGER,locked_until INTEGER,
        created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS two_step_recovery(user_id TEXT NOT NULL REFERENCES users(id),
        hash TEXT NOT NULL,used INTEGER,created INTEGER NOT NULL,
        PRIMARY KEY(user_id,hash));
      CREATE TABLE IF NOT EXISTS two_step_pending(hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        method TEXT NOT NULL CHECK(method IN ('password','email','recover','wallet')),
        payload TEXT,attempts INTEGER NOT NULL DEFAULT 0,
        expires INTEGER NOT NULL,created INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS two_step_pending_user ON two_step_pending(user_id);
      CREATE TABLE IF NOT EXISTS two_step_reauth(session_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        method TEXT NOT NULL CHECK(method IN ('password','email','wallet')),
        at INTEGER NOT NULL);
  `),
  // Low-Balance Alerts (server/balance-alerts.js): the available balance, in
  // integer subcredits, below which the app warns the account, and whether
  // it asked for a browser notification too. No row means the alert is off.
  // Settings only: an alert never writes the ledger or holds anything.
  additive(`CREATE TABLE IF NOT EXISTS balance_alerts(
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      threshold INTEGER NOT NULL CHECK(typeof(threshold)='integer' AND threshold>0),
      notify INTEGER NOT NULL DEFAULT 0 CHECK(notify IN (0,1)),
      updated INTEGER NOT NULL);`),
  // Bookmarks (server/routes/bookmarks.js): a star on one saved message,
  // with an optional private note, for its owner only. It points at the
  // message and never copies its text, so it goes with the message whatever
  // deletes it (conversation delete, delete all, cap pruning, auto-delete
  // cleanup, a branch's parent stays as it is). Leaving a collab, or being
  // removed from one, deletes that member's bookmarks in its conversations.
  // At most 1,000 per account, also enforced here.
  additive(`
      CREATE TABLE IF NOT EXISTS bookmarks(id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        note TEXT NOT NULL DEFAULT '' CHECK(length(note)<=140),
        created INTEGER NOT NULL,updated INTEGER NOT NULL,
        UNIQUE(user_id,message_id));
      CREATE INDEX IF NOT EXISTS bookmarks_user ON bookmarks(user_id,created);
      CREATE INDEX IF NOT EXISTS bookmarks_message ON bookmarks(message_id);
      CREATE TRIGGER IF NOT EXISTS bookmarks_per_account BEFORE INSERT ON bookmarks
        WHEN (SELECT COUNT(*) FROM bookmarks WHERE user_id=NEW.user_id)>=1000
        BEGIN SELECT RAISE(ABORT,'bookmark_limit'); END;
      CREATE TRIGGER IF NOT EXISTS bookmarks_member_removed AFTER DELETE ON collab_members
        BEGIN
          DELETE FROM bookmarks WHERE user_id=OLD.user_id AND message_id IN
            (SELECT m.id FROM messages m JOIN conversations c ON c.id=m.conversation_id
             WHERE c.collab_id=OLD.collab_id);
        END;
  `),
];
// The schema versions whose migrations were recorded as additive.
const additiveVersions = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_additive'")
    .get()
    ? new Set(db.prepare("SELECT version FROM schema_additive").all().map((r) => r.version))
    : new Set();
const newerAreAdditive = (db, from, to) => {
  const additiveSet = additiveVersions(db);
  for (let v = from + 1; v <= to; v++) if (!additiveSet.has(v)) return false;
  return true;
};
export function migrate(db) {
  const version = () => db.prepare("PRAGMA user_version").get().user_version;
  // A database upgraded by a newer build starts only when every migration
  // this build doesn't know only added tables, indexes or triggers.
  if (version() > MIGRATIONS.length) {
    if (newerAreAdditive(db, MIGRATIONS.length, version())) return;
    throw Error(
      "This database was upgraded by a newer version of Anonyma. Update the software before starting it.",
    );
  }
  for (let v = version(); v < MIGRATIONS.length; v++)
    transaction(db, () => {
      MIGRATIONS[v](db);
      db.exec(`PRAGMA user_version=${v + 1}`);
    });
}
// Before redeploying a build older than the additive-migration rule: lower
// the schema version so that build starts. Only additive migrations can be
// stepped over; their tables and triggers stay, and upgrading again re-runs
// them harmlessly (IF NOT EXISTS). Take a backup first (operator.mjs does).
export function rollbackSchema(db, target) {
  const current = db.prepare("PRAGMA user_version").get().user_version;
  if (!Number.isSafeInteger(target) || target < 0 || target > current)
    throw Error(`Choose a schema version from 0 to ${current}.`);
  if (!newerAreAdditive(db, target, current))
    throw Error(
      `Versions ${target + 1} to ${current} aren't all additive; restore a backup instead.`,
    );
  db.exec(`PRAGMA user_version=${target}`);
  return { from: current, to: target };
}
export function database(path) {
  if (path !== ":memory:")
    mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;",
  );
  migrate(db);
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
  return {
    total,
    held,
    available: hasDisputedCredit(db, user)
      ? Math.min(0, total - held)
      : total - held,
  };
}
// A credited payment whose processor status later conflicts pauses spending
// until the operator confirms it.
export const hasDisputedCredit = (db, user) =>
  !!db
    .prepare(
      "SELECT 1 FROM deposits WHERE user_id=? AND credited=1 AND status='reconciliation' LIMIT 1",
    )
    .get(user);
// Settled spend by an API key over the rolling 24-hour cap window.
export const keySpend24h = (db, key) =>
  -db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE key_id=? AND amount<0 AND created>?",
    )
    .get(key, now() - 86400000).n;
// Settled spend by an API key over its whole lifetime, for its allowance.
export const keySpendTotal = (db, key) =>
  -db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE key_id=? AND amount<0",
    )
    .get(key).n;
// Split an integer charge across items so the parts sum exactly to it.
export const splitCharge = (total, count) =>
  Array.from(
    { length: count },
    (_, index) => Math.floor(total / count) + (index < total % count ? 1 : 0),
  );
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
  db.prepare(
    "INSERT OR IGNORE INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
  ).run(uid("l_"), user, amount, kind, ref, null, description, now());
}
// Checks another module runs inside every reservation's transaction, for the
// account the hold is placed on: Spending Limits registers one per database
// (server/spending-limits.js), so no reservation path can skip it.
const reserveChecks = new WeakMap();
export const onReserve = (db, check) => reserveChecks.set(db, check);
export function reserve(
  db,
  { id, user, amount, key, kind = "chat", ttl = 300000, guard },
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
    // Callers with their own spending rules (Team Treasury limits) check and
    // record them here, atomically with the reservation.
    guard?.(amount);
    if (hasDisputedCredit(db, user))
      fail(
        409,
        "A credited payment is under reconciliation. New requests are paused until its current processor status is confirmed.",
        "payment_reconciliation_pending",
      );
    if (balance(db, user).available < amount)
      fail(
        402,
        "Not enough credits for this request. Add credits or reduce the output limit.",
        "insufficient_credits",
      );
    // The account's own spending limits, counting this hold with its settled
    // spend and every hold still open (402 spending_limit).
    reserveChecks.get(db)?.(user, amount);
    if (key) {
      const k = db
        .prepare("SELECT * FROM api_keys WHERE id=? AND revoked IS NULL")
        .get(key);
      if (!k) fail(401, "Key revoked");
      if (k.paused_at != null) fail(403, "This API key is paused.", "key_paused");
      if (k.allowance_expires != null && now() >= k.allowance_expires)
        fail(403, "This API key's allowance has expired.", "key_expired");
      const spent = keySpend24h(db, key);
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
      if (k.allowance_total != null) {
        const left = k.allowance_total - keySpendTotal(db, key) - inflight;
        // Say which it is: the allowance is used up, or this one request's
        // worst-case cost is larger than what's left of it.
        if (amount > left)
          fail(
            402,
            left <= 0
              ? "This API key has used its full allowance."
              : `This request could cost up to ${credits(amount)} credits, more than the ${credits(left)} left on this key's allowance.`,
            "allowance_exhausted",
          );
      }
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
    // Users are never charged beyond their reservation, so any excess is an
    // operator loss; keep it on the hold for the reconciliation report.
    const uncovered = Math.ceil(actual) - amount;
    if (uncovered > 0)
      console.warn(
        `Provider cost exceeded a reservation by ${credits(uncovered)} credits; absorbed by the operator. See the reconciliation report for the hold.`,
      );
    if (amount)
      db.prepare(
        "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
      ).run(
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
    db.prepare(
      "UPDATE holds SET status='settled',result=?,uncovered=? WHERE id=?",
    ).run(JSON.stringify(result), Math.max(0, uncovered), id);
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
// The snapshot lists retired models by ID only.
export const retiredModel = (id) => ({ id, name: id, status: "unavailable" });
export const retiredModelIds = () => snapshot.dead;
export function catalog() {
  return {
    data: [...snapshot.data, ...snapshot.dead.map(retiredModel)],
    updatedAt: snapshot.updatedAt,
    source: "Reference catalog snapshot · 19 Sep 2026",
  };
}
export const vision = (m) =>
  (m.architecture?.input_modalities || []).includes("image") ||
  (m.type === "image" && m.capabilities?.accepts_image_url === true);
export const imagePrices = {
  "google/gemini-3.1-flash-lite-image": 0.041,
  "google/gemini-2.5-flash-image": 0.047,
  "google/gemini-3.1-flash-image": 0.083,
  "google/gemini-3-pro-image": 0.163,
};
export function imageCallable(m) {
  // Some gateway rows say type=image while their declared output is video.
  // Their positive generation price does not make them image generators.
  if (
    String(m.category || "").endsWith("-to-video") ||
    (m.architecture?.output_modalities || []).includes("video")
  )
    return false;
  if (Object.hasOwn(imagePrices, m.id)) return true;
  if (m.type !== "image" || m.capabilities?.accepts_prompt !== true)
    return false;
  const prices = [
    m.pricing?.base_price,
    m.pricing?.per_generation,
    ...(m.pricing?.variants || []).flatMap((v) =>
      (v.options || []).map((o) => o.price),
    ),
  ];
  return prices.some(
    (price) => typeof price === "number" && Number.isFinite(price) && price > 0,
  );
}
export function hasPublishedTokenRates(m) {
  return [
    m.pricing?.input_per_1M_tokens,
    m.pricing?.output_per_1M_tokens,
  ].every(
    (rate) => typeof rate === "number" && Number.isFinite(rate) && rate >= 0,
  );
}
export function callable(m, cfg) {
  return (
    m.status === "live" &&
    !m.id.startsWith("private/") &&
    (["chat", "video"].includes(m.type) || imageCallable(m)) &&
    // A gateway's chat label/token rates do not establish an output contract.
    // Our chat path handles text and vetted images, not generated audio/video.
    // Keep unsupported rows catalog-only until routing, decoding and billing
    // support them. Zero-priced text models remain eligible.
    (m.type !== "chat" ||
      (m.architecture?.output_modalities || []).every((kind) =>
        ["text", "image"].includes(kind),
      )) &&
    (m.type !== "chat" || imageCallable(m) || hasPublishedTokenRates(m)) &&
    (m.type !== "video" || videoPresets(m).length > 0) &&
    (cfg.testMode || m.type !== "chat" || !imageCallable(m)) &&
    (!(m.architecture?.output_modalities || []).includes("image") ||
      imageCallable(m)) &&
    (cfg.testMode || !!cfg.gatewayKey) &&
    modelReleased(m, cfg)
  );
}
// Published option names mix cases ("2k" and "2K" both appear).
const sameOption = (a, b) =>
  b != null && String(a).toLowerCase() === String(b).toLowerCase();
const pricedVariant = (m, opts) => {
  const variants = m.pricing?.variants || [];
  return variants.find((v) => v.quality === opts.quality) || variants[0];
};
// The requested value that selects an image model's price: resolution, then
// size, then an aspect ratio when the model prices by aspect ratio.
export function imagePriceKey(m, opts = {}) {
  const sizes = (pricedVariant(m, opts)?.options || []).map((o) => o.size);
  return [opts.resolution, opts.size, opts.ratio].find((value) =>
    sizes.some((size) => sameOption(size, value)),
  );
}
// A resolution or size the price list doesn't publish would silently fall
// back to the default price while the provider renders what was asked for.
export function unpublishedImageOption(m, opts = {}) {
  const sized = (pricedVariant(m, opts)?.options || []).filter(
    (o) => o.size !== "default",
  );
  if (!sized.length || imagePriceKey(m, opts)) return null;
  const requested = opts.resolution ?? opts.size;
  return requested == null
    ? null
    : { requested, published: sized.map((o) => o.size) };
}
// Refuse a dedicated image model's option before any hold is created; shared
// by the workspace image studio and the /v1/images/generations API route.
export function assertPricedImageOption(m, opts = {}) {
  if (m.type !== "image") return;
  if (
    opts.quality &&
    !(m.pricing?.variants || []).some((variant) => variant.quality === opts.quality)
  )
    fail(400, "Choose a published quality for this model.");
  const unpublished = unpublishedImageOption(m, opts);
  if (unpublished)
    fail(
      400,
      `Size "${unpublished.requested}" has no published price for this model. Choose one of: ${unpublished.published.join(", ")}.`,
      "unpriced_option",
    );
  if (!(generationPrice(m, opts) > 0))
    fail(400, "This image option has no published price.", "unpriced_model");
}
export function generationPrice(m, opts = {}) {
  if (Object.hasOwn(imagePrices, m.id)) return imagePrices[m.id];
  const variants = m.pricing?.variants || [];
  const v = variants.find((v) => v.quality === opts.quality) || variants[0];
  if (m.type === "image") {
    const options = (v?.options || []).filter(
      (o) =>
        typeof o.price === "number" && Number.isFinite(o.price) && o.price > 0,
    );
    const selected = imagePriceKey(m, opts);
    const priced =
      options.find((o) => sameOption(o.size, selected)) ||
      options.find((o) => o.size === "default") ||
      options.reduce(
        (highest, o) => (!highest || o.price > highest.price ? o : highest),
        null,
      );
    return (
      priced?.price ?? m.pricing?.base_price ?? m.pricing?.per_generation ?? 0
    );
  }
  const size =
    opts.resolution ||
    opts.size ||
    `${opts.ratio || "16:9"}_${opts.duration || "5"}`;
  const o =
    v?.options?.find((o) => o.size === size) ||
    v?.options?.find((o) => o.size === "default") ||
    v?.options?.[0];
  return Number(
    o?.price ?? m.pricing?.per_generation ?? m.pricing?.base_price ?? 0,
  );
}
export function tokenCost(m, input, output) {
  return (
    ((m.pricing?.input_per_1M_tokens || 0) * input +
      (m.pricing?.output_per_1M_tokens || 0) * output) /
    1e6
  );
}
export function quote(m, messages, maxTokens = 4096, opts = {}) {
  const input =
    Math.ceil(JSON.stringify(messages).length / 2) +
    messages.reduce(
      (n, v) =>
        n +
        (Array.isArray(v.content)
          ? v.content.filter((p) => p.type === "image_url").length * 4096
          : 0),
      0,
    );
  return usdUnits(
    m.type === "chat" && !imageCallable(m)
      ? tokenCost(m, input, maxTokens)
      : generationPrice(m, opts) * (opts.n || 1),
  );
}
// Whether a chat request asks for PPQ's web plugin, which carries its own
// per-request fee: `web_search: true`, or a plugins entry with id "web".
export const wantsWebSearch = (body) =>
  body?.web_search === true ||
  (Array.isArray(body?.plugins) && body.plugins.some((p) => p?.id === "web"));
export function discount(balance) {
  const b = Number(balance);
  // 25% off markup per 1% of the one-billion reference supply.
  // The separate 14-day benefit is early model access, not a holding delay.
  return Number.isFinite(b) ? Math.min(1, Math.max(0, b / 40000000)) : 0;
}
export function markupFactor(user, cfg) {
  return 1 + (cfg.markup / 100) * (1 - discount(user.token_balance));
}
// The rate before any per-account adjustment. A connected app is charged at
// this rate, so what it's charged says nothing about the account.
export const standardFactor = (cfg) => 1 + cfg.markup / 100;
// What a chat request is priced at, in integer units, before any hold
// headroom: its token estimate plus the web search fee (USD, 0 without
// search), at the account's rate factor. /api/chat holds against exactly
// this, and /api/quote and Cost Compare quote it, so an estimate and Send
// can never price the same request differently.
export const chatPrice = (m, messages, maxTokens, webSearchUsd, factor) =>
  Math.ceil((quote(m, messages, maxTokens) + usdUnits(webSearchUsd)) * factor);
