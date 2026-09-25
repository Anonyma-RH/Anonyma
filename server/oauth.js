import { randomBytes, createHash, timingSafeEqual } from "node:crypto";
import {
  hash,
  now,
  uid,
  fail,
  credits,
  keySpendTotal,
  transaction,
} from "./core.js";

// Connect an App: OAuth 2.1 (authorization code + PKCE S256, public clients
// only) in front of the MCP server. The app gets tokens and nothing else: no
// user id, username, email, chats or account balance, and no identity
// scopes. Every connection is backed by its own api_keys row carrying an
// agent allowance, so spending goes through reserve() like any other key.

export const SCOPE = "mcp";
export const ACCESS_PREFIX = "anonyma_at_";
export const REFRESH_PREFIX = "anonyma_rt_";
const CODE_PREFIX = "anonyma_ac_";
export const ACCESS_TTL = 3600000; // one hour, never past the connection
export const CODE_TTL = 60000;
// A rotated refresh token still works this long after its rotation: an app
// whose parallel requests all found the access token expired refreshes more
// than once, and that isn't theft. Reuse after this revokes every token.
export const REFRESH_LEEWAY = 30000;
// An approval the app never picks up is closed after this long.
export const PENDING_TTL = 10 * 60000;
// A registered client that never completes an authorization is removed.
export const CLIENT_TTL = 86400000;
export const EXPIRY_DAYS = [1, 7, 30, 90];
export const DEFAULT_EXPIRY_DAYS = 30;
// 2,000 credits is $2: dozens of calls on most models, a small loss if the
// app misbehaves. The user can pick anything up to MAX_BUDGET.
export const DEFAULT_BUDGET = 2000;
export const MAX_BUDGET = 1000000;
export const MAX_CONNECTIONS = 20;
export const MAX_REDIRECT_URIS = 5;
export const MAX_REDIRECT_LENGTH = 1024;
export const MAX_CLIENT_NAME = 80;
export const MAX_CONNECTION_NAME = 60;
const MAX_STATE = 1024;
const MAX_SCOPE = 512;

// The canonical origin, never the request's Host header.
export const issuerOf = (cfg) => cfg.publicUrl || cfg.origin;
export const resourceOf = (cfg) => issuerOf(cfg) + "/mcp";
export const resourceMetadataUrl = (cfg) =>
  issuerOf(cfg) + "/.well-known/oauth-protected-resource/mcp";

const secret = (prefix) => prefix + randomBytes(32).toString("base64url");
const str = (v) => (typeof v === "string" ? v : undefined);

export class OAuthError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.oauth = code;
  }
}
const oauthFail = (status, code, message) => {
  throw new OAuthError(status, code, message);
};

// Schemes that can run script, read local data or hand the code to
// something other than the app that registered.
const BLOCKED_SCHEMES = new Set([
  "javascript",
  "data",
  "file",
  "vbscript",
  "blob",
  "about",
  "filesystem",
  "view-source",
  "jar",
  "ws",
  "wss",
  "ftp",
  "mailto",
  "tel",
  "sms",
  "intent",
]);
// Handlers the operating system or a browser owns: they open web pages,
// run diagnostics or search, and would let a "private app" address hand the
// code to something other than an app.
const BLOCKED_SCHEME_PREFIXES = [
  "ms-",
  "microsoft",
  "search-ms",
  "shell",
  "x-safari",
  "safari",
  "googlechrome",
  "chrome",
  "firefox",
  "opera",
  "brave",
  "edge",
  "itms",
  "facetime",
  "callto",
  "skype",
];
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

// "web" (https), "loopback" (http on this computer, any port), "app" (a
// private-use scheme such as myapp://, RFC 8252) or null when refused.
export function redirectKind(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_REDIRECT_LENGTH ||
    // Whitespace, control characters, backslashes and any fragment.
    /[\s\u0000-\u001f\u007f\\#]/.test(value)
  )
    return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.hash) return null;
  const scheme = url.protocol.slice(0, -1);
  if (scheme === "https") return url.hostname ? "web" : null;
  if (scheme === "http") return LOOPBACK.has(url.hostname) ? "loopback" : null;
  if (
    !/^[a-z][a-z0-9+.-]{0,63}$/.test(scheme) ||
    BLOCKED_SCHEMES.has(scheme) ||
    BLOCKED_SCHEME_PREFIXES.some((p) => scheme.startsWith(p)) ||
    // A web address wrapped in an app scheme (x-https://…, app:https://…).
    /https?/.test(scheme) ||
    /^[a-z][a-z0-9+.-]*:\/*https?:/.test(value.toLowerCase())
  )
    return null;
  return "app";
}
// Whether a redirect URI is one the client registered: exactly, or for a
// loopback address, on any port. A native app listens on whatever port is
// free each time it connects (RFC 8252 section 7.3, OAuth 2.1). Everything
// else about it (scheme, host, path, query) must match, and it must already
// be in its normal form.
export function redirectRegistered(registered, value) {
  if (registered.includes(value)) return true;
  if (redirectKind(value) !== "loopback") return false;
  const url = new URL(value);
  if (url.href !== value) return false;
  return registered.some((r) => {
    if (redirectKind(r) !== "loopback") return false;
    const reg = new URL(r);
    return (
      reg.hostname === url.hostname &&
      reg.pathname === url.pathname &&
      reg.search === url.search
    );
  });
}
// What the consent screen shows as the place the code goes: the host for
// web and loopback addresses (punycode, so look-alike letters show), the
// scheme and host for an app's own scheme.
export function redirectHost(value) {
  const url = new URL(value);
  if (redirectKind(value) === "app")
    return url.protocol + (url.host ? "//" + url.host : "");
  return url.host;
}
// Self-reported names are plain text: no control, zero-width or
// direction-override characters, whitespace collapsed, capped.
export function cleanName(value, max) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
}
// RFC 8707 resource, compared in canonical form (lowercase scheme and host,
// no trailing slash). Undefined when it isn't a usable absolute URI.
function canonicalResource(value) {
  if (typeof value !== "string" || !value || value.length > 512) return;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return;
    return url.origin + url.pathname.replace(/\/+$/, "");
  } catch {}
}
export const resourceMatches = (cfg, value) =>
  canonicalResource(value) === resourceOf(cfg);

// Adds response parameters to a registered redirect URI, keeping its own
// query.
export function withParams(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params))
    if (v != null) url.searchParams.append(k, v);
  return url.href;
}

export const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
];
// Checks an authorization request. `fatal` means the client or redirect URI
// can't be trusted, so the user sees an error page and nothing is sent
// anywhere. `error` is reported to the app on its registered redirect URI.
export function checkAuthorization(db, cfg, q) {
  q = q && typeof q === "object" ? q : {};
  const clientId = str(q.client_id);
  const client =
    clientId && clientId.length <= 100
      ? db.prepare("SELECT * FROM oauth_clients WHERE id=?").get(clientId)
      : null;
  if (!client) return { fatal: "invalid_client" };
  const redirectUri = str(q.redirect_uri);
  if (
    !redirectUri ||
    !redirectRegistered(JSON.parse(client.redirect_uris), redirectUri) ||
    !redirectKind(redirectUri)
  )
    return { fatal: "invalid_redirect_uri" };
  const state = str(q.state);
  const base = {
    client,
    redirectUri,
    state: state && state.length <= MAX_STATE ? state : undefined,
  };
  const error = (code, description) => ({ ...base, error: code, description });
  for (const k of AUTHORIZE_PARAMS)
    if (q[k] !== undefined && typeof q[k] !== "string")
      return error("invalid_request", `Send ${k} once.`);
  if (q.response_type !== "code")
    return error(
      "unsupported_response_type",
      "Only response_type=code is supported.",
    );
  if (state !== undefined && state.length > MAX_STATE)
    return error("invalid_request", "state is too long.");
  const challenge = str(q.code_challenge);
  if (!challenge || q.code_challenge_method !== "S256")
    return error(
      "invalid_request",
      "PKCE is required: send code_challenge with code_challenge_method=S256.",
    );
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
    return error(
      "invalid_request",
      "code_challenge must be a base64url SHA-256 digest.",
    );
  if (q.resource !== undefined && !resourceMatches(cfg, q.resource))
    return error("invalid_target", `The only resource is ${resourceOf(cfg)}.`);
  if (q.scope !== undefined && q.scope.length > MAX_SCOPE)
    return error("invalid_scope", "scope is too long.");
  return {
    ...base,
    ok: true,
    challenge,
    // Other requested scopes are ignored: only "mcp" is ever granted.
    resource: q.resource === undefined ? null : resourceOf(cfg),
  };
}
// The redirect that reports an authorization error to the app.
export const errorRedirect = (cfg, check) =>
  withParams(check.redirectUri, {
    error: check.error,
    error_description: check.description,
    state: check.state,
    iss: issuerOf(cfg),
  });

// A connection is usable while it, its key and its account all are, and
// before its expiry.
export function liveConnection(db, id) {
  return db
    .prepare(
      `SELECT c.* FROM oauth_connections c
       JOIN api_keys k ON k.id=c.key_id
       JOIN users u ON u.id=c.user_id
       WHERE c.id=? AND c.revoked IS NULL AND k.revoked IS NULL
         AND u.deleted IS NULL AND c.expires>?`,
    )
    .get(id, now());
}
export function revokeTokens(db, connectionId) {
  db.prepare("DELETE FROM oauth_tokens WHERE connection_id=?").run(
    connectionId,
  );
}
// Immediate: the key is revoked and every token and pending code is gone.
export function revokeConnection(db, connectionId) {
  transaction(db, () => {
    const at = now();
    const c = db
      .prepare("SELECT * FROM oauth_connections WHERE id=?")
      .get(connectionId);
    if (!c) return;
    db.prepare(
      "UPDATE oauth_connections SET revoked=COALESCE(revoked,?) WHERE id=?",
    ).run(at, c.id);
    db.prepare(
      "UPDATE api_keys SET revoked=COALESCE(revoked,?) WHERE id=?",
    ).run(at, c.key_id);
    db.prepare("DELETE FROM oauth_tokens WHERE connection_id=?").run(c.id);
    db.prepare("DELETE FROM oauth_codes WHERE connection_id=?").run(c.id);
  });
}

// Approve: the connection, its allowance-backed key (no secret: hash NULL
// never matches a bearer, so it can't be used on /v1) and a single-use
// code, bound to the client, redirect URI, PKCE challenge and resource.
export function approveConnection(db, cfg, user, check, form) {
  return transaction(db, () => {
    const t = now();
    const active = db
      .prepare(
        "SELECT COUNT(*) n FROM oauth_connections WHERE user_id=? AND revoked IS NULL AND expires>?",
      )
      .get(user.id, t).n;
    if (active >= MAX_CONNECTIONS)
      fail(
        400,
        `You can have up to ${MAX_CONNECTIONS} connected apps. Revoke one first.`,
        "too_many_connections",
      );
    const connectionId = uid("conn_"),
      keyId = uid("key_"),
      expires = t + form.expiryDays * 86400000;
    db.prepare(
      "INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created,revoked,last_used,allowance_total,allowance_expires,paused_at,agent_label,connection_id) VALUES(?,?,NULL,?,NULL,NULL,?,NULL,NULL,?,?,NULL,?,?)",
    ).run(
      keyId,
      user.id,
      form.name,
      t,
      Math.round(form.budget * 10000),
      expires,
      form.name,
      connectionId,
    );
    db.prepare(
      "INSERT INTO oauth_connections(id,user_id,client_id,key_id,name,client_name,redirect_uri,private_only,created,activated,expires,revoked) VALUES(?,?,?,?,?,?,?,?,?,NULL,?,NULL)",
    ).run(
      connectionId,
      user.id,
      check.client.id,
      keyId,
      form.name,
      check.client.name,
      check.redirectUri,
      form.privateOnly ? 1 : 0,
      t,
      expires,
    );
    const code = secret(CODE_PREFIX);
    db.prepare(
      "INSERT INTO oauth_codes(hash,connection_id,client_id,redirect_uri,code_challenge,resource,expires,used) VALUES(?,?,?,?,?,?,?,NULL)",
    ).run(
      hash(code),
      connectionId,
      check.client.id,
      check.redirectUri,
      check.challenge,
      check.resource,
      t + CODE_TTL,
    );
    return {
      connectionId,
      redirect: withParams(check.redirectUri, {
        code,
        state: check.state,
        iss: issuerOf(cfg),
      }),
    };
  });
}

function issueTokens(db, connection) {
  const t = now();
  const access = secret(ACCESS_PREFIX),
    refresh = secret(REFRESH_PREFIX);
  const accessExpires = Math.min(t + ACCESS_TTL, connection.expires);
  const insert = db.prepare(
    "INSERT INTO oauth_tokens(hash,connection_id,kind,created,expires,rotated) VALUES(?,?,?,?,?,NULL)",
  );
  insert.run(hash(access), connection.id, "access", t, accessExpires);
  // A refresh token never outlives the connection.
  insert.run(hash(refresh), connection.id, "refresh", t, connection.expires);
  // However often an app refreshes, a connection keeps a handful of rows:
  // its newest access tokens (a request in flight may still carry the last
  // one) and its most recently rotated refresh tokens, to spot their reuse.
  db.prepare(
    `DELETE FROM oauth_tokens WHERE connection_id=? AND kind='access' AND hash NOT IN
       (SELECT hash FROM oauth_tokens WHERE connection_id=? AND kind='access' ORDER BY created DESC,rowid DESC LIMIT 3)`,
  ).run(connection.id, connection.id);
  db.prepare(
    `DELETE FROM oauth_tokens WHERE connection_id=? AND kind='refresh' AND rotated IS NOT NULL AND hash NOT IN
       (SELECT hash FROM oauth_tokens WHERE connection_id=? AND kind='refresh' AND rotated IS NOT NULL ORDER BY rotated DESC,rowid DESC LIMIT 10)`,
  ).run(connection.id, connection.id);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.floor((accessExpires - t) / 1000)),
    refresh_token: refresh,
    scope: SCOPE,
  };
}
const constantTimeEqual = (a, b) => {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
function checkTokenResource(cfg, params, bound) {
  if (params.resource === undefined) return;
  if (!resourceMatches(cfg, params.resource) || (bound && bound !== resourceOf(cfg)))
    oauthFail(400, "invalid_target", `The only resource is ${resourceOf(cfg)}.`);
}

// authorization_code grant. The code is consumed before anything else is
// checked, so a second attempt with it always fails, and one that was
// already used revokes every token issued from it.
export function exchangeCode(db, cfg, clientId, params) {
  const code = str(params.code);
  if (!code) oauthFail(400, "invalid_request", "code is required.");
  const codeHash = hash(code);
  const consumed = db
    .prepare("UPDATE oauth_codes SET used=? WHERE hash=? AND used IS NULL")
    .run(now(), codeHash).changes;
  const row = db.prepare("SELECT * FROM oauth_codes WHERE hash=?").get(codeHash);
  if (!row) oauthFail(400, "invalid_grant", "The authorization code is invalid.");
  if (!consumed) {
    revokeTokens(db, row.connection_id);
    oauthFail(
      400,
      "invalid_grant",
      "The authorization code was already used. Tokens issued from it are revoked.",
    );
  }
  if (row.expires <= now())
    oauthFail(400, "invalid_grant", "The authorization code has expired.");
  if (row.client_id !== clientId)
    oauthFail(400, "invalid_grant", "The code was issued to another client.");
  if (str(params.redirect_uri) !== row.redirect_uri)
    oauthFail(400, "invalid_grant", "redirect_uri does not match the authorization request.");
  checkTokenResource(cfg, params, row.resource);
  const verifier = str(params.code_verifier);
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
    oauthFail(400, "invalid_grant", "A valid code_verifier is required.");
  const computed = createHash("sha256").update(verifier).digest("base64url");
  if (!constantTimeEqual(computed, row.code_challenge))
    oauthFail(400, "invalid_grant", "The code_verifier does not match.");
  return transaction(db, () => {
    const connection = liveConnection(db, row.connection_id);
    if (!connection)
      oauthFail(400, "invalid_grant", "This connection is no longer available.");
    const t = now();
    db.prepare(
      "UPDATE oauth_connections SET activated=COALESCE(activated,?) WHERE id=?",
    ).run(t, connection.id);
    db.prepare(
      "UPDATE oauth_clients SET authorized=COALESCE(authorized,?) WHERE id=?",
    ).run(t, clientId);
    return issueTokens(db, connection);
  });
}

// refresh_token grant: rotated on every use. Presenting a rotated token
// again revokes all of the connection's tokens.
export function refreshTokens(db, cfg, clientId, params) {
  const token = str(params.refresh_token);
  if (!token) oauthFail(400, "invalid_request", "refresh_token is required.");
  const tokenHash = hash(token);
  const row = db
    .prepare(
      "SELECT t.*,c.client_id FROM oauth_tokens t JOIN oauth_connections c ON c.id=t.connection_id WHERE t.hash=? AND t.kind='refresh'",
    )
    .get(tokenHash);
  if (!row) oauthFail(400, "invalid_grant", "The refresh token is invalid.");
  const leeway = row.rotated != null && now() - row.rotated <= REFRESH_LEEWAY;
  if (row.rotated != null && !leeway) {
    revokeTokens(db, row.connection_id);
    oauthFail(
      400,
      "invalid_grant",
      "This refresh token was already used. The connection's tokens are revoked; connect the app again.",
    );
  }
  if (row.client_id !== clientId)
    oauthFail(400, "invalid_grant", "The refresh token was issued to another client.");
  if (row.expires <= now())
    oauthFail(400, "invalid_grant", "The refresh token has expired.");
  checkTokenResource(cfg, params, null);
  // Within the leeway the token was rotated moments ago; its rotation time
  // stays, so the leeway never extends.
  if (!leeway)
    db.prepare(
      "UPDATE oauth_tokens SET rotated=? WHERE hash=? AND rotated IS NULL",
    ).run(now(), tokenHash);
  return transaction(db, () => {
    const connection = liveConnection(db, row.connection_id);
    if (!connection)
      oauthFail(400, "invalid_grant", "This connection is no longer available.");
    return issueTokens(db, connection);
  });
}

// RFC 7009. Holding the token is enough to give it up. Revoking a refresh
// token ends the connection; an access token goes on its own.
export function revokeToken(db, clientId, token) {
  const row = db
    .prepare(
      "SELECT t.*,c.client_id FROM oauth_tokens t JOIN oauth_connections c ON c.id=t.connection_id WHERE t.hash=?",
    )
    .get(hash(token));
  if (!row || (clientId && clientId !== row.client_id)) return;
  if (row.kind === "refresh") revokeConnection(db, row.connection_id);
  else db.prepare("DELETE FROM oauth_tokens WHERE hash=?").run(row.hash);
}

// A bearer on /mcp that is an access token: its connection, key and user,
// or null. Access tokens are only ever looked up here, so they don't work
// on /v1 or anywhere else.
export function authenticateAccessToken(db, token) {
  if (typeof token !== "string" || !token.startsWith(ACCESS_PREFIX)) return null;
  const row = db
    .prepare(
      "SELECT connection_id FROM oauth_tokens WHERE hash=? AND kind='access' AND expires>?",
    )
    .get(hash(token), now());
  const connection = row && liveConnection(db, row.connection_id);
  if (!connection) return null;
  const key = db.prepare("SELECT * FROM api_keys WHERE id=?").get(connection.key_id);
  const user = db
    .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
    .get(connection.user_id);
  return key && user ? { connection, key, user } : null;
}

const heldOn = (db, keyId) =>
  db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM holds WHERE key_id=? AND status='held'",
    )
    .get(keyId).n;
// What's left of a connection's budget, in ledger units, after its spend
// and its holds in flight.
export const budgetLeft = (db, key) =>
  Math.max(
    0,
    (key.allowance_total ?? 0) - keySpendTotal(db, key.id) - heldOn(db, key.id),
  );
// A connection's own allowance: what the app may know about money.
export function connectionBudget(db, key, connection) {
  const spent = keySpendTotal(db, key.id);
  const held = heldOn(db, key.id);
  return {
    budget: credits(key.allowance_total ?? 0),
    spent: credits(spent),
    in_flight: credits(held),
    remaining: credits(Math.max(0, (key.allowance_total ?? 0) - spent - held)),
    expires_at: connection.expires,
    paused: key.paused_at != null,
  };
}

// Background cleanup: expired tokens and codes, approvals the app never
// picked up, and registrations that never completed an authorization.
export function sweepOAuth(db) {
  const t = now();
  db.prepare("DELETE FROM oauth_tokens WHERE expires<=?").run(t);
  db.prepare("DELETE FROM oauth_codes WHERE expires<?").run(t - 86400000);
  for (const c of db
    .prepare(
      "SELECT id FROM oauth_connections WHERE activated IS NULL AND revoked IS NULL AND created<?",
    )
    .all(t - PENDING_TTL))
    revokeConnection(db, c.id);
  db.prepare(
    "DELETE FROM oauth_clients WHERE authorized IS NULL AND created<? AND id NOT IN (SELECT client_id FROM oauth_connections WHERE revoked IS NULL)",
  ).run(t - CLIENT_TTL);
}
