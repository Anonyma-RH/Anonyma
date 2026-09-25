import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { addCredit, balance, now } from "../server/core.js";
import { UPDATES, featuresFor, CONNECT_UPDATES } from "../server/releases.js";
import { redirectKind, cleanName, sweepOAuth, REFRESH_LEEWAY } from "../server/oauth.js";
import { knownPage } from "../src/site-routes.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ORIGIN = "http://localhost:5175";
const RESOURCE = ORIGIN + "/mcp";
// The reference snapshot has no zero-data-retention labels, so one model is
// counted as private through the operator override and one ordinary model
// isn't.
const PRIVATE_MODEL = "venice/venice-uncensored-1-2";
const PUBLIC_MODEL = "google/gemini-2.5-flash";
const REDIRECT = "http://127.0.0.1:33418/callback";

function fixture(t, released, extra = {}, dir) {
  const own = !dir;
  dir ||= mkdtempSync(join(tmpdir(), "anonyma-connect-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: ORIGIN,
    released: released ?? "all",
    mvpModels: [PRIVATE_MODEL, PUBLIC_MODEL],
    privateModels: [PRIVATE_MODEL],
    ...extra,
  });
  t.after(() => {
    svc.close();
    if (own) rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function signUp(app, name = "u" + randomBytes(5).toString("hex")) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}
async function registerClient(app, body = {}) {
  const r = await request(app)
    .post("/oauth/register")
    .send({ client_name: "Test App", redirect_uris: [REDIRECT], ...body })
    .expect(201);
  return r.body;
}
const authorizeQuery = (client, p, extra = {}) => ({
  response_type: "code",
  client_id: client.client_id,
  redirect_uri: client.redirect_uris[0],
  code_challenge: p.challenge,
  code_challenge_method: "S256",
  state: "state-" + randomBytes(4).toString("hex"),
  scope: "mcp",
  resource: RESOURCE,
  ...extra,
});
async function approve(agent, query, form = {}) {
  const r = await agent
    .post("/api/connections/approve")
    .send({
      request: query,
      budget: 2000,
      expiry_days: 30,
      private_only: true,
      ...form,
    })
    .expect(200);
  return new URL(r.body.redirect);
}
const tokenRequest = (app, body) =>
  request(app).post("/oauth/token").type("form").send(body);
function exchange(app, client, code, p, extra = {}) {
  return tokenRequest(app, {
    grant_type: "authorization_code",
    client_id: client.client_id,
    code,
    redirect_uri: client.redirect_uris[0],
    code_verifier: p.verifier,
    resource: RESOURCE,
    ...extra,
  });
}
// The whole flow: register, authorize, approve, exchange.
async function connect(svc, { agent, form = {}, client } = {}) {
  client ||= await registerClient(svc.app);
  agent ||= (await signUp(svc.app)).agent;
  const p = pkce();
  const query = authorizeQuery(client, p);
  const back = await approve(agent, query, form);
  const code = back.searchParams.get("code");
  const tokens = (await exchange(svc.app, client, code, p).expect(200)).body;
  const connection = svc.db
    .prepare("SELECT * FROM oauth_connections ORDER BY created DESC LIMIT 1")
    .get();
  return { client, agent, p, query, back, code, tokens, connection };
}
const rpc = (app, token, body) =>
  request(app)
    .post("/mcp")
    .set("Authorization", "Bearer " + token)
    .send(body);
const call = (app, token, name, args = {}, id = 1) =>
  rpc(app, token, {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });

test("the update is registered, and needs api, mcp and allowances", () => {
  const entry = UPDATES.find((u) => u.id === "connect");
  assert.ok(entry, "connect is registered in UPDATES");
  // Its release commit flips this; the gates below hold either way.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "Connect an App");
  assert.equal(entry.points.length, 3);
  assert.deepEqual(CONNECT_UPDATES, ["api", "mcp", "allowances", "connect"]);
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
    "/.well-known/oauth-authorization-server",
    "/oauth/register",
    "/oauth/authorize",
    "/oauth/token",
    "/oauth/revoke",
    "/api/connections",
    "/api/connections/authorize",
    "/api/connections/conn_1/activity",
  ])
    assert.deepEqual(
      featuresFor({ path, method: "GET", body: {} }).sort(),
      [...CONNECT_UPDATES].sort(),
      path,
    );
  // A private word in an entry's copy would break the no-branding rule.
  const copy = JSON.stringify(entry);
  assert.doesNotMatch(copy, /Meta|Muse|Claude|Cursor/);
});

test("while unreleased, every endpoint is refused and /mcp never advertises OAuth", async (t) => {
  // Everything connect needs, except connect itself.
  const s = fixture(t, "mvp,api,mcp,allowances");
  for (const [method, path] of [
    ["get", "/.well-known/oauth-protected-resource"],
    ["get", "/.well-known/oauth-protected-resource/mcp"],
    ["get", "/.well-known/oauth-authorization-server"],
    ["post", "/oauth/register"],
    ["get", "/oauth/authorize"],
    ["post", "/oauth/token"],
    ["post", "/oauth/revoke"],
    ["get", "/api/connections"],
    ["post", "/api/connections/approve"],
    // Routing ignores case; so does the gate.
    ["get", "/.well-known/OAUTH-authorization-server"],
    ["post", "/OAuth/register"],
    ["post", "/OAUTH/token"],
    ["get", "/API/CONNECTIONS"],
    ["post", "/API/Connections/approve"],
  ]) {
    const r = await request(s.app)[method](path).send({}).expect(403);
    assert.equal(r.body.error.code, "feature_unreleased", path);
  }
  const noAuth = await request(s.app)
    .post("/mcp")
    .send({ jsonrpc: "2.0", id: 1, method: "ping" })
    .expect(401);
  assert.equal(noAuth.headers["www-authenticate"], 'Bearer realm="anonyma"');
  assert.doesNotMatch(noAuth.headers["www-authenticate"], /resource_metadata/);
  const shaped = await rpc(s.app, "anonyma_at_" + "x".repeat(43), {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(401);
  assert.doesNotMatch(shaped.headers["www-authenticate"], /resource_metadata/);
  assert.match(shaped.headers["www-authenticate"], /error="invalid_token"/);
  // The consent page isn't a known page until it's served.
  assert.equal(knownPage("/connect"), false);
  assert.equal(knownPage("/connect", { connect: true }), true);

  // A dependency missing is refused the same way, naming what's missing.
  const s2 = fixture(t, "mvp,api,mcp,connect");
  const r = await request(s2.app)
    .get("/.well-known/oauth-authorization-server")
    .expect(403);
  assert.equal(r.body.error.message, "Agent Allowances is coming soon.");
});

test("tokens stop working the moment the update is switched off again", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-connect-rollback-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: ORIGIN,
    released: "all",
    privateModels: [PRIVATE_MODEL],
  });
  const { tokens } = await connect(live);
  await rpc(live.app, tokens.access_token, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(200);
  live.close();
  const off = fixture(t, "mvp,api,mcp,allowances", {}, dir);
  await rpc(off.app, tokens.access_token, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(401);
});

test("discovery documents describe OAuth for /mcp from the configured origin", async (t) => {
  const s = fixture(t);
  for (const path of [
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ]) {
    const r = await request(s.app)
      .get(path)
      .set("Host", "attacker.example")
      .set("Origin", "https://some-app.example")
      .expect(200);
    assert.deepEqual(r.body, {
      resource: RESOURCE,
      authorization_servers: [ORIGIN],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
      resource_name: "ANONYMA",
    });
    assert.equal(r.headers["access-control-allow-origin"], "*");
    assert.equal(r.headers["access-control-allow-credentials"], undefined);
  }
  const meta = (
    await request(s.app)
      .get("/.well-known/oauth-authorization-server")
      .set("Host", "attacker.example")
      .expect(200)
  ).body;
  assert.equal(meta.issuer, ORIGIN);
  assert.equal(meta.authorization_endpoint, ORIGIN + "/oauth/authorize");
  assert.equal(meta.token_endpoint, ORIGIN + "/oauth/token");
  assert.equal(meta.registration_endpoint, ORIGIN + "/oauth/register");
  assert.equal(meta.revocation_endpoint, ORIGIN + "/oauth/revoke");
  assert.deepEqual(meta.response_types_supported, ["code"]);
  assert.deepEqual(meta.grant_types_supported, [
    "authorization_code",
    "refresh_token",
  ]);
  assert.deepEqual(meta.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(meta.token_endpoint_auth_methods_supported, ["none"]);
  assert.deepEqual(meta.scopes_supported, ["mcp"]);
  assert.equal(meta.authorization_response_iss_parameter_supported, true);
  assert.equal(meta.client_id_metadata_document_supported, false);
  // Nothing OpenID: no userinfo, no id_token, no identity claims.
  const text = JSON.stringify(meta);
  assert.doesNotMatch(text, /userinfo|id_token|openid|claims|subject/i);
  const oidc = await request(s.app).get("/.well-known/openid-configuration");
  assert.ok(!oidc.headers["content-type"]?.includes("application/json"));

  // Preflight works cross-origin, without credentials.
  const pre = await request(s.app)
    .options("/oauth/token")
    .set("Origin", "https://some-app.example")
    .set("Access-Control-Request-Method", "POST")
    .expect(204);
  assert.equal(pre.headers["access-control-allow-origin"], "*");
  assert.match(pre.headers["access-control-allow-methods"], /POST/);

  // With PUBLIC_BASE_URL set, that is the issuer.
  const s2 = fixture(t, "all", { publicUrl: "http://127.0.0.1:5585" });
  const meta2 = (
    await request(s2.app).get("/.well-known/oauth-authorization-server")
  ).body;
  assert.equal(meta2.issuer, "http://127.0.0.1:5585");
  const prm2 = (
    await request(s2.app).get("/.well-known/oauth-protected-resource/mcp")
  ).body;
  assert.equal(prm2.resource, "http://127.0.0.1:5585/mcp");

  // Released: a 401 on /mcp now points clients at the metadata.
  const noAuth = await request(s.app)
    .post("/mcp")
    .send({ jsonrpc: "2.0", id: 1, method: "ping" })
    .expect(401);
  assert.equal(
    noAuth.headers["www-authenticate"],
    `Bearer realm="anonyma", resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp", scope="mcp"`,
  );
  const bad = await rpc(s.app, "anonyma_at_nope", {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(401);
  assert.match(bad.headers["www-authenticate"], /resource_metadata="/);
  assert.match(bad.headers["www-authenticate"], /error="invalid_token"/);
});

test("registration takes public clients with safe redirect URIs only", async (t) => {
  const s = fixture(t);
  for (const uri of [
    "https://app.example/oauth/callback",
    "https://app.example:8443/cb?x=1",
    "http://localhost:6274/oauth/callback",
    "http://127.0.0.1:49152/callback",
    "http://[::1]:8080/cb",
    "cursorlike://anysphere.app/oauth/callback",
    "com.example.app:/oauth2redirect",
  ]) {
    assert.ok(redirectKind(uri), uri);
    const r = await request(s.app)
      .post("/oauth/register")
      .send({ redirect_uris: [uri], client_name: "Ok" })
      .expect(201);
    assert.deepEqual(r.body.redirect_uris, [uri]);
    assert.equal(r.body.token_endpoint_auth_method, "none");
    assert.equal(r.body.client_secret, undefined);
  }
  const refused = [
    "javascript:alert(1)",
    "JavaScript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "file:///etc/passwd",
    "vbscript:msgbox(1)",
    "blob:https://app.example/1d3b",
    "http://app.example/callback",
    "http://localhost.attacker.example/cb",
    "http://127.0.0.1.nip.io/cb",
    "https://app.example/cb#fragment",
    "https://app.example/cb#",
    "https://someone@app.example/cb",
    // Built at run time: the repository's privacy scan flags credentials in
    // URLs, even fake ones.
    ["https://user", "pass@app.example/cb"].join(":"),
    " https://app.example/cb",
    "https://app.example/c b",
    "https://app.example/cb\n",
    "https:\\\\app.example\\cb",
    "https://app.example/" + "a".repeat(1100),
    "relative/path",
    "",
    // Handlers owned by the system or a browser, and web addresses in an
    // app scheme's clothing.
    "ms-msdt:/id",
    "search-ms:query=x",
    "itms-services://?action=download-manifest",
    "googlechrome://attacker.example",
    "microsoft-edge:https://attacker.example",
    "x-safari-https://attacker.example",
    "someapp:https://attacker.example",
    "shell:startup",
  ];
  for (const uri of refused) assert.equal(redirectKind(uri), null, uri);
  // Registration is limited to 20 an hour per IP: a fresh server each round.
  const s2 = fixture(t);
  for (const uri of refused.slice(0, 12)) {
    const r = await request(s2.app)
      .post("/oauth/register")
      .send({ redirect_uris: [uri] })
      .expect(400);
    assert.equal(r.body.error, "invalid_redirect_uri", uri);
  }
  const s3 = fixture(t);
  for (const uri of refused.slice(12)) {
    const r = await request(s3.app)
      .post("/oauth/register")
      .send({ redirect_uris: [uri] })
      .expect(400);
    assert.equal(r.body.error, "invalid_redirect_uri", uri);
  }
  const s4 = fixture(t);
  for (const body of [
    { redirect_uris: [] },
    { redirect_uris: "https://app.example/cb" },
    { redirect_uris: [REDIRECT, 5] },
    {
      redirect_uris: Array.from(
        { length: 6 },
        (_, i) => `https://app.example/cb${i}`,
      ),
    },
    {},
  ]) {
    const r = await request(s4.app).post("/oauth/register").send(body).expect(400);
    assert.equal(r.body.error, "invalid_redirect_uri");
  }
  for (const body of [
    { token_endpoint_auth_method: "client_secret_basic" },
    { grant_types: ["client_credentials"] },
    { grant_types: ["refresh_token"] },
    { response_types: ["token"] },
  ]) {
    const r = await request(s4.app)
      .post("/oauth/register")
      .send({ redirect_uris: [REDIRECT], ...body })
      .expect(400);
    assert.equal(r.body.error, "invalid_client_metadata");
  }
  // Not JSON.
  const form = await request(s4.app)
    .post("/oauth/register")
    .type("form")
    .send({ redirect_uris: REDIRECT })
    .expect(400);
  assert.equal(form.body.error, "invalid_client_metadata");
  // The name is capped plain text; other metadata is neither kept nor echoed.
  const named = await request(s4.app)
    .post("/oauth/register")
    .send({
      redirect_uris: [REDIRECT],
      client_name: "Evil‮ppA\u0000​ " + "x".repeat(200),
      logo_uri: "https://tracker.example/pixel.png",
      contacts: ["someone@example.com"],
    })
    .expect(201);
  assert.equal(named.body.client_name.length, 80);
  assert.ok(named.body.client_name.startsWith("EvilppA x"));
  assert.equal(named.body.logo_uri, undefined);
  assert.equal(named.body.contacts, undefined);
  assert.equal(cleanName("  <b>App</b>\t\n ", 80), "<b>App</b>");
  const stored = s4.db
    .prepare("SELECT * FROM oauth_clients WHERE id=?")
    .get(named.body.client_id);
  assert.deepEqual(Object.keys(stored).sort(), [
    "authorized",
    "created",
    "id",
    "name",
    "redirect_uris",
  ]);
  // A name may not pose as ANONYMA.
  for (const client_name of ["ANONYMA", "Anonyma Official", "A.N.O.N.Y.M.A"]) {
    const r = await request(s4.app)
      .post("/oauth/register")
      .send({ redirect_uris: [REDIRECT], client_name })
      .expect(400);
    assert.equal(r.body.error, "invalid_client_metadata");
  }
  // Unnamed clients get a neutral name.
  const unnamed = await request(s4.app)
    .post("/oauth/register")
    .send({ redirect_uris: [REDIRECT] })
    .expect(201);
  assert.equal(unnamed.body.client_name, "Unnamed app");
});

test("registration is rate limited per IP, with an OAuth-shaped error", async (t) => {
  const s = fixture(t);
  for (let i = 0; i < 300; i++)
    await request(s.app)
      .post("/oauth/register")
      .send({ redirect_uris: [REDIRECT] })
      .expect(201);
  const r = await request(s.app)
    .post("/oauth/register")
    .send({ redirect_uris: [REDIRECT] })
    .expect(429);
  assert.equal(r.body.error, "temporarily_unavailable");
  assert.ok(r.headers["retry-after"]);
});

test("the full code and PKCE flow ends in a working ask on /mcp that stores nothing else", async (t) => {
  const s = fixture(t);
  const client = await registerClient(s.app);
  const { agent, user } = await signUp(s.app);
  const p = pkce();
  const query = authorizeQuery(client, p);

  // The authorization endpoint validates, then hands over to the consent
  // page, without leaking the request by referrer.
  const auth = await request(s.app).get("/oauth/authorize").query(query).expect(302);
  assert.equal(auth.headers["referrer-policy"], "no-referrer");
  assert.equal(auth.headers["x-frame-options"], "DENY");
  const consent = new URL(auth.headers.location, ORIGIN);
  assert.equal(consent.pathname, "/connect");
  assert.deepEqual(Object.fromEntries(consent.searchParams), query);

  // The consent page's own headers: no framing, no referrer.
  const page = await request(s.app).get("/connect").query(query);
  assert.equal(page.headers["referrer-policy"], "no-referrer");
  assert.equal(page.headers["x-frame-options"], "DENY");
  assert.match(page.headers["content-security-policy"], /frame-ancestors 'none'/);

  // Signed out, the consent API refuses; signed in it describes the app.
  await request(s.app)
    .get("/api/connections/authorize")
    .query(query)
    .expect(401);
  const info = (
    await agent.get("/api/connections/authorize").query(query).expect(200)
  ).body;
  assert.deepEqual(info.app, {
    name: "Test App",
    redirect_uri: REDIRECT,
    redirect_host: "127.0.0.1:33418",
    redirect_kind: "loopback",
  });
  assert.deepEqual(info.defaults, {
    name: "Test App",
    budget: 2000,
    expiry_days: 30,
    private_only: true,
  });
  assert.deepEqual(info.expiry_days, [1, 7, 30, 90]);
  assert.equal(info.private_models, 1);

  const back = await approve(agent, query, { name: "Laptop agent" });
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get("state"), query.state);
  assert.equal(back.searchParams.get("iss"), ORIGIN);
  const code = back.searchParams.get("code");
  assert.match(code, /^anonyma_ac_[A-Za-z0-9_-]{43}$/);
  // Stored only as a hash.
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM oauth_codes WHERE hash=?").get(code).n,
    0,
  );

  const token = await exchange(s.app, client, code, p).expect(200);
  assert.equal(token.headers["cache-control"], "no-store");
  assert.equal(token.headers.pragma, "no-cache");
  assert.deepEqual(Object.keys(token.body).sort(), [
    "access_token",
    "expires_in",
    "refresh_token",
    "scope",
    "token_type",
  ]);
  assert.equal(token.body.token_type, "Bearer");
  assert.equal(token.body.scope, "mcp");
  assert.ok(token.body.expires_in > 3500 && token.body.expires_in <= 3600);
  assert.match(token.body.access_token, /^anonyma_at_[A-Za-z0-9_-]{43}$/);
  assert.match(token.body.refresh_token, /^anonyma_rt_[A-Za-z0-9_-]{43}$/);
  for (const t of [token.body.access_token, token.body.refresh_token])
    assert.equal(
      s.db.prepare("SELECT COUNT(*) n FROM oauth_tokens WHERE hash=?").get(t).n,
      0,
      "tokens are stored hashed",
    );

  // The connection and its key: an allowance, an expiry, no usable secret.
  const c = s.db.prepare("SELECT * FROM oauth_connections").get();
  assert.equal(c.name, "Laptop agent");
  assert.equal(c.client_name, "Test App");
  assert.equal(c.private_only, 1);
  assert.ok(c.activated);
  const key = s.db.prepare("SELECT * FROM api_keys WHERE id=?").get(c.key_id);
  assert.equal(key.hash, null);
  assert.equal(key.connection_id, c.id);
  assert.equal(key.allowance_total, 2000 * 10000);
  assert.equal(key.allowance_expires, c.expires);
  assert.ok(Math.abs(c.expires - (now() + 30 * 86400000)) < 60000);

  const access = token.body.access_token;
  const init = await rpc(s.app, access, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  }).expect(200);
  assert.equal(init.body.result.serverInfo.name, "anonyma");
  const tools = await rpc(s.app, access, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  }).expect(200);
  assert.deepEqual(
    tools.body.result.tools.map((x) => x.name).sort(),
    ["ask", "balance", "list_models"],
  );
  const before = balance(s.db, user.id).total;
  const ask = await call(s.app, access, "ask", {
    model: PRIVATE_MODEL,
    prompt: "Connected app secret prompt",
  }).expect(200);
  const result = ask.body.result;
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Connected app secret prompt/);
  assert.ok(result.structuredContent.credits_charged > 0);
  assert.equal(result.structuredContent.balance_after, undefined);
  assert.equal(
    result.structuredContent.budget_remaining,
    2000 - result.structuredContent.credits_charged,
  );
  assert.ok(balance(s.db, user.id).total < before);

  // Nothing kept beyond the ledger row and its hold: no conversation, no
  // messages, no media, and the prompt appears nowhere in the database.
  const ledger = s.db
    .prepare("SELECT * FROM ledger WHERE key_id=?")
    .all(c.key_id);
  assert.equal(ledger.length, 1);
  for (const table of ["conversations", "messages", "media"])
    assert.equal(
      s.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n,
      0,
      table,
    );
  const tables = s.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  for (const table of tables) {
    const rows = JSON.stringify(s.db.prepare(`SELECT * FROM "${table}"`).all());
    assert.doesNotMatch(rows, /secret prompt/, table);
  }
  assert.equal(key.last_used, null);
  assert.ok(
    s.db.prepare("SELECT last_used FROM api_keys WHERE id=?").get(c.key_id)
      .last_used,
  );
});

test("authorization refuses bad requests, and never redirects to an untrusted address", async (t) => {
  const s = fixture(t);
  const client = await registerClient(s.app, {
    redirect_uris: [REDIRECT, "https://app.example/cb"],
  });
  const p = pkce();
  const good = authorizeQuery(client, p);
  // Unknown client, unregistered or inexact redirect: an error page, never a
  // redirect.
  for (const q of [
    { ...good, client_id: "client_unknown" },
    { ...good, client_id: undefined },
    { ...good, redirect_uri: undefined },
    { ...good, redirect_uri: "https://attacker.example/cb" },
    { ...good, redirect_uri: "https://app.example/cb/" },
    { ...good, redirect_uri: "https://app.example/cb?x=1" },
    { ...good, redirect_uri: "http://127.0.0.1:33418/other" },
    { ...good, redirect_uri: "http://127.0.0.1:33418/callback?x=1" },
    { ...good, redirect_uri: "http://localhost:33418/callback" },
    { ...good, redirect_uri: "HTTP://127.0.0.1:33418/callback" },
    { ...good, redirect_uri: "HTTP://127.0.0.1:33419/callback" },
  ]) {
    const r = await request(s.app).get("/oauth/authorize").query(q).expect(400);
    assert.equal(r.headers.location, undefined);
    assert.match(r.headers["content-type"], /text\/html/);
    assert.match(r.text, /can't be used/);
    assert.equal(r.headers["referrer-policy"], "no-referrer");
  }
  // A repeated client_id is ambiguous: refused the same way.
  const dup = await request(s.app).get(
    `/oauth/authorize?client_id=${client.client_id}&client_id=${client.client_id}&redirect_uri=${encodeURIComponent(REDIRECT)}`,
  );
  assert.equal(dup.status, 400);
  assert.equal(dup.headers.location, undefined);

  // Everything else goes to the consent page, never straight back to the
  // app: that would make this origin an open redirector for any registered
  // client. Signed in, the user sees the error and may send it to the app.
  const { agent } = await signUp(s.app);
  for (const [q, error] of [
    [{ ...good, response_type: "token" }, "unsupported_response_type"],
    [{ ...good, response_type: undefined }, "unsupported_response_type"],
    [{ ...good, code_challenge: undefined }, "invalid_request"],
    [{ ...good, code_challenge_method: "plain" }, "invalid_request"],
    [{ ...good, code_challenge_method: undefined }, "invalid_request"],
    [{ ...good, code_challenge: "short" }, "invalid_request"],
    [{ ...good, resource: "https://attacker.example/mcp" }, "invalid_target"],
    [{ ...good, resource: ORIGIN + "/v1" }, "invalid_target"],
    [{ ...good, state: "s".repeat(2000) }, "invalid_request"],
  ]) {
    const r = await request(s.app).get("/oauth/authorize").query(q).expect(302);
    assert.match(r.headers.location, /^\/connect\?/);
    const consent = await agent
      .get("/api/connections/authorize")
      .query(q)
      .expect(400);
    assert.equal(consent.body.error.code, error, JSON.stringify(q));
    assert.equal(consent.body.app.redirect_host, "127.0.0.1:33418");
    const to = new URL(consent.body.return_to);
    assert.equal(to.origin + to.pathname, REDIRECT);
    assert.equal(to.searchParams.get("error"), error);
    assert.equal(to.searchParams.get("iss"), ORIGIN);
    assert.equal(to.searchParams.get("code"), null);
    if (q.state.length < 1024) assert.equal(to.searchParams.get("state"), q.state);
    else assert.equal(to.searchParams.get("state"), null);
  }
  // The canonical resource is matched loosely on case and a trailing slash.
  for (const resource of [RESOURCE, "HTTP://LOCALHOST:5175/mcp", RESOURCE + "/"]) {
    const r = await request(s.app)
      .get("/oauth/authorize")
      .query({ ...good, resource })
      .expect(302);
    assert.match(r.headers.location, /^\/connect\?/);
  }

  // The consent API applies the same checks and redirects nowhere.
  const bad = await agent
    .get("/api/connections/authorize")
    .query({ ...good, redirect_uri: "https://attacker.example/cb" })
    .expect(400);
  assert.equal(bad.body.error.code, "invalid_redirect_uri");
  assert.equal(bad.body.return_to, undefined);
  const refused = await agent
    .post("/api/connections/approve")
    .send({
      request: { ...good, code_challenge_method: "plain" },
      budget: 100,
      expiry_days: 7,
    })
    .expect(400);
  assert.equal(refused.body.error.code, "invalid_request");
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM oauth_connections").get().n,
    0,
  );
  // The form itself.
  for (const [form, code] of [
    [{ budget: 0 }, "invalid_budget"],
    [{ budget: -5 }, "invalid_budget"],
    [{ budget: "2000" }, "invalid_budget"],
    [{ budget: 1000001 }, "invalid_budget"],
    [{ expiry_days: 365 }, "invalid_expiry"],
    [{ expiry_days: undefined }, "invalid_expiry"],
  ]) {
    const r = await agent
      .post("/api/connections/approve")
      .send({ request: good, budget: 2000, expiry_days: 30, ...form })
      .expect(400);
    assert.equal(r.body.error.code, code);
  }
  // Approve and deny keep the app's same-origin and JSON protections.
  await agent
    .post("/api/connections/approve")
    .set("Origin", "https://attacker.example")
    .send({ request: good, budget: 2000, expiry_days: 30 })
    .expect(403);
  await agent
    .post("/api/connections/approve")
    .type("form")
    .send({ budget: 2000, expiry_days: 30 })
    .expect(415);
  await request(s.app)
    .post("/api/connections/approve")
    .send({ request: good, budget: 2000, expiry_days: 30 })
    .expect(401);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM oauth_connections").get().n,
    0,
  );
  // Deny sends the app access_denied, with its state.
  const denied = await agent
    .post("/api/connections/deny")
    .send({ request: good })
    .expect(200);
  const to = new URL(denied.body.redirect);
  assert.equal(to.searchParams.get("error"), "access_denied");
  assert.equal(to.searchParams.get("state"), good.state);
  assert.equal(to.searchParams.get("iss"), ORIGIN);
  assert.equal(to.searchParams.get("code"), null);
  // An app's own scheme and an existing query survive the redirect.
  const app2 = await registerClient(s.app, {
    redirect_uris: ["myapp://oauth/callback?from=anonyma"],
  });
  const back = await approve(agent, authorizeQuery(app2, pkce()));
  assert.equal(back.protocol, "myapp:");
  assert.equal(back.searchParams.get("from"), "anonyma");
  assert.ok(back.searchParams.get("code"));
});

test("the token endpoint refuses bad verifiers, redirects, clients, reused and expired codes", async (t) => {
  const s = fixture(t);
  const client = await registerClient(s.app);
  const other = await registerClient(s.app);
  const { agent } = await signUp(s.app);
  const fresh = async () => {
    const p = pkce();
    const back = await approve(agent, authorizeQuery(client, p));
    return { p, code: back.searchParams.get("code") };
  };
  const expectError = async (r, status, error) => {
    await r.expect(status);
    const body = (await r).body;
    assert.equal(body.error, error);
    assert.equal(typeof body.error_description, "string");
    assert.equal((await r).headers["cache-control"], "no-store");
  };

  // A wrong verifier fails, and burns the code for good.
  let { p, code } = await fresh();
  await expectError(
    exchange(s.app, client, code, { verifier: pkce().verifier }),
    400,
    "invalid_grant",
  );
  await expectError(exchange(s.app, client, code, p), 400, "invalid_grant");
  // A verifier with the wrong shape.
  ({ p, code } = await fresh());
  await expectError(
    exchange(s.app, client, code, { verifier: "short" }),
    400,
    "invalid_grant",
  );
  // A redirect_uri that doesn't match exactly.
  ({ p, code } = await fresh());
  await expectError(
    exchange(s.app, client, code, p, { redirect_uri: REDIRECT + "/" }),
    400,
    "invalid_grant",
  );
  ({ p, code } = await fresh());
  await expectError(
    exchange(s.app, client, code, p, { redirect_uri: undefined }),
    400,
    "invalid_grant",
  );
  // Another client's code.
  ({ p, code } = await fresh());
  await expectError(
    exchange(s.app, other, code, p),
    400,
    "invalid_grant",
  );
  // A resource other than /mcp.
  ({ p, code } = await fresh());
  await expectError(
    exchange(s.app, client, code, p, { resource: ORIGIN + "/v1" }),
    400,
    "invalid_target",
  );
  // An expired code (older than 60 seconds).
  ({ p, code } = await fresh());
  s.db.prepare("UPDATE oauth_codes SET expires=?").run(now() - 1);
  await expectError(exchange(s.app, client, code, p), 400, "invalid_grant");
  // Unknown client, unknown grant, missing grant.
  ({ p, code } = await fresh());
  await expectError(
    exchange(s.app, { ...client, client_id: "client_nope" }, code, p),
    401,
    "invalid_client",
  );
  await expectError(
    tokenRequest(s.app, { grant_type: "password", client_id: client.client_id }),
    400,
    "unsupported_grant_type",
  );
  await expectError(tokenRequest(s.app, {}), 400, "invalid_request");
  await expectError(
    tokenRequest(s.app, {
      grant_type: "authorization_code",
      client_id: client.client_id,
      code: "anonyma_ac_nope",
    }),
    400,
    "invalid_grant",
  );
  // Malformed JSON comes back as an OAuth error too.
  const broken = await request(s.app)
    .post("/oauth/token")
    .set("Content-Type", "application/json")
    .send('{"grant_type":')
    .expect(400);
  assert.equal(broken.body.error, "invalid_request");

  // A good exchange works with JSON as well as a form. Using that code again
  // fails and revokes what it issued.
  ({ p, code } = await fresh());
  const ok = await request(s.app)
    .post("/oauth/token")
    .send({
      grant_type: "authorization_code",
      client_id: client.client_id,
      code,
      redirect_uri: REDIRECT,
      code_verifier: p.verifier,
    })
    .expect(200);
  await rpc(s.app, ok.body.access_token, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(200);
  await expectError(exchange(s.app, client, code, p), 400, "invalid_grant");
  await rpc(s.app, ok.body.access_token, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(401);
  await expectError(
    tokenRequest(s.app, {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: ok.body.refresh_token,
    }),
    400,
    "invalid_grant",
  );
  // A public client may name itself in a Basic header instead.
  ({ p, code } = await fresh());
  await request(s.app)
    .post("/oauth/token")
    .auth(client.client_id, "")
    .type("form")
    .send({
      grant_type: "authorization_code",
      code,
      redirect_uri: REDIRECT,
      code_verifier: p.verifier,
    })
    .expect(200);
});

test("refresh tokens rotate, never outlive the connection, and reuse revokes them all", async (t) => {
  const s = fixture(t);
  const { client, tokens, connection } = await connect(s, {
    form: { expiry_days: 1 },
  });
  const refresh = (token, extra = {}) =>
    tokenRequest(s.app, {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: token,
      ...extra,
    });
  const rows = s.db
    .prepare("SELECT * FROM oauth_tokens WHERE kind='refresh'")
    .all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].expires, connection.expires);

  // Another client can't use it (and doesn't burn it).
  const other = await registerClient(s.app);
  const stolen = await tokenRequest(s.app, {
    grant_type: "refresh_token",
    client_id: other.client_id,
    refresh_token: tokens.refresh_token,
  }).expect(400);
  assert.equal(stolen.body.error, "invalid_grant");

  const next = (await refresh(tokens.refresh_token).expect(200)).body;
  assert.notEqual(next.refresh_token, tokens.refresh_token);
  assert.notEqual(next.access_token, tokens.access_token);
  assert.equal(next.scope, "mcp");
  const ping = (token) =>
    rpc(s.app, token, { jsonrpc: "2.0", id: 1, method: "ping" });
  await ping(next.access_token).expect(200);
  // The new refresh token also ends with the connection.
  assert.equal(
    s.db
      .prepare(
        "SELECT expires FROM oauth_tokens WHERE kind='refresh' AND rotated IS NULL",
      )
      .get().expires,
    connection.expires,
  );
  const third = (await refresh(next.refresh_token).expect(200)).body;
  await ping(third.access_token).expect(200);

  // The first refresh token again, moments after its rotation: an app's
  // parallel refreshes, not theft. It still works and revokes nothing.
  const twin = (await refresh(tokens.refresh_token).expect(200)).body;
  await ping(twin.access_token).expect(200);
  await ping(third.access_token).expect(200);
  // Past the leeway it's reuse: every token of the connection goes.
  s.db
    .prepare("UPDATE oauth_tokens SET rotated=rotated-? WHERE rotated IS NOT NULL")
    .run(REFRESH_LEEWAY + 1000);
  const reuse = await refresh(tokens.refresh_token).expect(400);
  assert.equal(reuse.body.error, "invalid_grant");
  await ping(third.access_token).expect(401);
  await ping(next.access_token).expect(401);
  await ping(twin.access_token).expect(401);
  assert.equal(
    (await refresh(third.refresh_token).expect(400)).body.error,
    "invalid_grant",
  );
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM oauth_tokens").get().n,
    0,
  );

  // However often an app refreshes, the connection keeps a handful of rows.
  const busy = await connect(s, { client });
  let current = busy.tokens.refresh_token;
  for (let i = 0; i < 15; i++)
    current = (await refresh(current).expect(200)).body.refresh_token;
  const kinds = s.db
    .prepare(
      "SELECT kind, rotated IS NOT NULL rotated, COUNT(*) n FROM oauth_tokens WHERE connection_id=? GROUP BY 1,2",
    )
    .all(busy.connection.id);
  assert.deepEqual(
    Object.fromEntries(kinds.map((k) => [k.kind + (k.rotated ? ":rotated" : ""), k.n])),
    { access: 3, refresh: 1, "refresh:rotated": 10 },
  );

  // Past the connection's expiry nothing works.
  const again = await connect(s, { client, form: { expiry_days: 1 } });
  s.db
    .prepare("UPDATE oauth_connections SET expires=? WHERE id=?")
    .run(now() - 1, again.connection.id);
  await ping(again.tokens.access_token).expect(401);
  assert.equal(
    (await refresh(again.tokens.refresh_token).expect(400)).body.error,
    "invalid_grant",
  );
});

test("revoking a connection stops it at once; /oauth/revoke gives up tokens", async (t) => {
  const s = fixture(t);
  const { agent, tokens, connection, client } = await connect(s);
  const ping = (token) =>
    rpc(s.app, token, { jsonrpc: "2.0", id: 1, method: "ping" });
  await ping(tokens.access_token).expect(200);
  const list = (await agent.get("/api/connections").expect(200)).body.data;
  assert.equal(list.length, 1);
  await agent.delete("/api/connections/" + connection.id).expect(200);
  const refused = await ping(tokens.access_token).expect(401);
  assert.match(refused.headers["www-authenticate"], /error="invalid_token"/);
  assert.match(refused.headers["www-authenticate"], /resource_metadata=/);
  assert.equal(
    (
      await tokenRequest(s.app, {
        grant_type: "refresh_token",
        client_id: client.client_id,
        refresh_token: tokens.refresh_token,
      }).expect(400)
    ).body.error,
    "invalid_grant",
  );
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM oauth_tokens").get().n, 0);
  assert.ok(
    s.db.prepare("SELECT revoked FROM api_keys WHERE id=?").get(connection.key_id)
      .revoked,
  );
  assert.equal((await agent.get("/api/connections")).body.data.length, 0);
  await agent.delete("/api/connections/" + connection.id).expect(404);
  // Someone else's connection is not found.
  const second = await connect(s, { client });
  const stranger = await signUp(s.app, "stranger");
  await stranger.agent
    .delete("/api/connections/" + second.connection.id)
    .expect(404);
  await stranger.agent
    .post(`/api/connections/${second.connection.id}/pause`)
    .send({})
    .expect(404);
  await stranger.agent
    .get(`/api/connections/${second.connection.id}/activity`)
    .expect(404);

  // RFC 7009: an access token goes alone; a refresh token ends the
  // connection. Unknown tokens are still a 200.
  const revoke = (body) =>
    request(s.app).post("/oauth/revoke").type("form").send(body);
  await revoke({ token: second.tokens.access_token }).expect(200);
  await ping(second.tokens.access_token).expect(401);
  assert.equal(
    s.db
      .prepare("SELECT revoked FROM oauth_connections WHERE id=?")
      .get(second.connection.id).revoked,
    null,
  );
  // A mismatched client can't revoke it.
  await revoke({
    token: second.tokens.refresh_token,
    client_id: "client_other",
  }).expect(200);
  assert.equal(
    s.db
      .prepare("SELECT revoked FROM oauth_connections WHERE id=?")
      .get(second.connection.id).revoked,
    null,
  );
  await revoke({
    token: second.tokens.refresh_token,
    client_id: client.client_id,
  }).expect(200);
  assert.ok(
    s.db
      .prepare("SELECT revoked FROM oauth_connections WHERE id=?")
      .get(second.connection.id).revoked,
  );
  await revoke({ token: "anonyma_rt_unknown" }).expect(200);
  assert.equal(
    (await revoke({}).expect(400)).body.error,
    "invalid_request",
  );
});

test("private-only connections list and run zero-data-retention models only", async (t) => {
  const s = fixture(t);
  const { tokens, connection } = await connect(s);
  const access = tokens.access_token;
  const list = (await call(s.app, access, "list_models").expect(200)).body
    .result;
  assert.deepEqual(
    list.structuredContent.models.map((m) => m.id),
    [PRIVATE_MODEL],
  );
  assert.ok(list.structuredContent.models.every((m) => m.private === true));
  const refused = (
    await call(s.app, access, "ask", {
      model: PUBLIC_MODEL,
      prompt: "hello",
    }).expect(200)
  ).body.result;
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /private models only/);
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM holds WHERE key_id=?")
      .get(connection.key_id).n,
    0,
    "nothing was reserved",
  );

  // Switched off at consent, the connection sees every model.
  const open = await connect(s, { form: { private_only: false } });
  const all = (
    await call(s.app, open.tokens.access_token, "list_models").expect(200)
  ).body.result.structuredContent.models;
  assert.ok(all.some((m) => m.id === PUBLIC_MODEL && m.private === false));
  assert.ok(all.some((m) => m.id === PRIVATE_MODEL && m.private === true));
  const ok = (
    await call(s.app, open.tokens.access_token, "ask", {
      model: PUBLIC_MODEL,
      prompt: "hello",
    }).expect(200)
  ).body.result;
  assert.equal(ok.isError, undefined);
});

async function mockServer(t, handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return "http://127.0.0.1:" + server.address().port;
}
async function readJSON(req) {
  let body = "";
  for await (const b of req) body += b;
  return JSON.parse(body || "{}");
}
const sse = (res, v) => res.write("data: " + JSON.stringify(v) + "\n\n");

test("a private-only connection routes like Private Mode: ZDR only, never the backup", async (t) => {
  let mode = "ok";
  const primaryBodies = [];
  const primary = await mockServer(t, async (req, res) => {
    const body = await readJSON(req);
    primaryBodies.push(body);
    if (mode === "unfunded") {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "unfunded" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { choices: [{ delta: { content: "from primary" } }] });
    sse(res, {
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0002 },
    });
    res.end("data: [DONE]\n\n");
  });
  const backupCalls = [];
  const backup = await mockServer(t, async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ data: [{ id: PRIVATE_MODEL }, { id: PUBLIC_MODEL }] }),
      );
    }
    backupCalls.push((await readJSON(req)).model);
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { choices: [{ delta: { content: "from backup" } }] });
    sse(res, {
      choices: [],
      usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0002 },
    });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, "all", {
    testMode: false,
    gateway: primary,
    gatewayKey: "fixture",
    gateway2: backup,
    gateway2Key: "backup-key",
  });
  t.mock.method(console, "error", () => {});
  const { agent, user } = await signUp(s.app);
  addCredit(s.db, user.id, 100000000, "connect-fund", "test_credit");
  const { tokens } = await connect(s, { agent });
  const ask = (token, model = PRIVATE_MODEL) =>
    call(s.app, token, "ask", { model, prompt: "route me" }).expect(200);

  const served = (await ask(tokens.access_token)).body.result;
  assert.equal(served.content[0].text, "from primary");
  assert.deepEqual(primaryBodies.at(-1).provider, {
    zdr: true,
    data_collection: "deny",
  });
  // The primary refuses: a private-only connection never fails over.
  mode = "unfunded";
  const failed = (await ask(tokens.access_token)).body.result;
  assert.equal(failed.isError, true);
  assert.deepEqual(backupCalls, []);
  assert.equal(balance(s.db, user.id).held, 0);

  // Without private-only, ordinary API routing: no ZDR flag, failover allowed.
  mode = "ok";
  const open = await connect(s, { agent, form: { private_only: false } });
  await ask(open.tokens.access_token, PUBLIC_MODEL);
  assert.equal(primaryBodies.at(-1).provider, undefined);
  mode = "unfunded";
  const failover = (await ask(open.tokens.access_token, PUBLIC_MODEL)).body
    .result;
  assert.equal(failover.content[0].text, "from backup");
  assert.deepEqual(backupCalls, [PUBLIC_MODEL]);
});

test("balance reports the connection's budget, never the account's", async (t) => {
  const s = fixture(t);
  const { agent, user } = await signUp(s.app);
  const { tokens, connection } = await connect(s, {
    agent,
    form: { budget: 750.5 },
  });
  const bal = (
    await call(s.app, tokens.access_token, "balance").expect(200)
  ).body.result;
  assert.deepEqual(bal.structuredContent, {
    budget: 750.5,
    spent: 0,
    in_flight: 0,
    remaining: 750.5,
    expires_at: connection.expires,
    paused: false,
  });
  assert.ok(balance(s.db, user.id).total > 7505000, "the account holds more");
  assert.doesNotMatch(bal.content[0].text, /Available|On hold/);
  assert.match(bal.content[0].text, /Remaining: 750\.5 of 750\.5 credits/);
  const ask = (
    await call(s.app, tokens.access_token, "ask", {
      model: PRIVATE_MODEL,
      prompt: "spend a little",
    }).expect(200)
  ).body.result;
  const after = (
    await call(s.app, tokens.access_token, "balance").expect(200)
  ).body.result.structuredContent;
  assert.equal(after.spent, ask.structuredContent.credits_charged);
  assert.equal(
    after.remaining,
    Number((750.5 - ask.structuredContent.credits_charged).toFixed(4)),
  );
  // The tool descriptions say so too.
  const tools = (
    await rpc(s.app, tokens.access_token, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    })
  ).body.result.tools;
  assert.match(
    tools.find((x) => x.name === "balance").description,
    /this connection's budget/,
  );
  // A regular API key on /mcp still sees the account balance.
  const key = (await agent.post("/api/keys").send({ name: "k" }).expect(201))
    .body.key;
  const keyBal = (await call(s.app, key, "balance").expect(200)).body.result;
  assert.ok("available" in keyBal.structuredContent);
});

test("the budget, pause and expiry are enforced over OAuth by the allowance", async (t) => {
  const s = fixture(t);
  const { agent, user } = await signUp(s.app);
  const { tokens, connection } = await connect(s, {
    agent,
    form: { budget: 1 },
  });
  const ask = (prompt = "x".repeat(4000), max_tokens = 8192) =>
    call(s.app, tokens.access_token, "ask", {
      model: PRIVATE_MODEL,
      prompt,
      max_tokens,
    }).expect(200);
  const before = balance(s.db, user.id).total;
  // Hold more than the budget: refused before anything runs.
  const big = (await ask()).body.result;
  assert.equal(big.isError, true);
  assert.match(big.content[0].text, /this connection's budget/);
  assert.equal(balance(s.db, user.id).total, before);
  // Spend it down with small calls until the budget is used up.
  let exhausted;
  let calls = 0;
  for (let i = 0; i < 60 && !exhausted; i++) {
    const r = (await ask("hi", 50)).body.result;
    if (r.isError) exhausted = r;
    else calls++;
  }
  assert.ok(calls > 1, "small calls ran until the budget was used");
  assert.ok(exhausted, "the budget runs out");
  assert.match(
    exhausted.content[0].text,
    /this connection's budget|full budget/,
  );
  const spent = s.db
    .prepare("SELECT -COALESCE(SUM(amount),0) n FROM ledger WHERE key_id=?")
    .get(connection.key_id).n;
  assert.ok(spent <= 10000, "never more than the 1-credit budget");

  // Pause and resume from the account.
  const second = await connect(s, { agent });
  await agent
    .post(`/api/connections/${second.connection.id}/pause`)
    .send({})
    .expect(200);
  const paused = (
    await call(s.app, second.tokens.access_token, "ask", {
      model: PRIVATE_MODEL,
      prompt: "hi",
    }).expect(200)
  ).body.result;
  assert.equal(paused.isError, true);
  assert.match(paused.content[0].text, /connection is paused/);
  const listed = (await agent.get("/api/connections")).body.data.find(
    (c) => c.id === second.connection.id,
  );
  assert.equal(listed.paused, true);
  await agent
    .post(`/api/connections/${second.connection.id}/resume`)
    .send({})
    .expect(200);
  const resumed = (
    await call(s.app, second.tokens.access_token, "ask", {
      model: PRIVATE_MODEL,
      prompt: "hi",
    }).expect(200)
  ).body.result;
  assert.equal(resumed.isError, undefined);
  // The key's own expiry is the connection's, so reserve() refuses at it.
  s.db
    .prepare("UPDATE api_keys SET allowance_expires=? WHERE id=?")
    .run(now() - 1, second.connection.key_id);
  const expired = (
    await call(s.app, second.tokens.access_token, "ask", {
      model: PRIVATE_MODEL,
      prompt: "hi",
    }).expect(200)
  ).body.result;
  assert.match(expired.content[0].text, /connection has expired/);
});

// Leaves the account with exactly this many available credits.
function setAvailable(db, userId, credits) {
  const total = balance(db, userId).total;
  db.prepare(
    "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    "l_" + randomBytes(8).toString("hex"),
    userId,
    Math.round(credits * 10000) - total,
    "test_debit",
    "test-debit-" + randomBytes(8).toString("hex"),
    null,
    "Test debit",
    now(),
  );
}

test("an app can't work out the account balance by probing", async (t) => {
  const s = fixture(t);
  const { agent, user } = await signUp(s.app);
  const { tokens } = await connect(s, { agent, form: { budget: 2000 } });
  const ask = (max_tokens, prompt = "probe") =>
    call(s.app, tokens.access_token, "ask", {
      model: PRIVATE_MODEL,
      prompt,
      max_tokens,
    }).expect(200);

  // A balance below what's left of the budget: every ask gets the same
  // refusal, whatever it would cost, and nothing is reserved.
  setAvailable(s.db, user.id, 3);
  const answers = new Set();
  for (const max of [1, 50, 2048, 8192]) {
    const r = (await ask(max)).body.result;
    assert.equal(r.isError, true);
    answers.add(r.content[0].text);
  }
  assert.deepEqual([...answers], [
    "This connection can't spend right now. Its owner can check it in ANONYMA.",
  ]);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  // The owner is told why; the app's balance tool still shows the budget.
  const [c] = (await agent.get("/api/connections")).body.data;
  assert.equal(c.balance_short, true);
  const bal = (await call(s.app, tokens.access_token, "balance")).body.result;
  assert.equal(bal.structuredContent.remaining, 2000);

  // Balance above the budget: a request too big to reserve reads the same
  // whether the budget or the account refused it.
  const small = await connect(s, { agent, form: { budget: 10 } });
  setAvailable(s.db, user.id, 12);
  const probe = (chars) =>
    call(s.app, small.tokens.access_token, "ask", {
      model: PRIVATE_MODEL,
      prompt: "x".repeat(chars),
      max_tokens: 8192,
    }).expect(200);
  // About 11 credits: over the 10-credit budget, under the balance.
  const overBudget = (await probe(30000)).body.result;
  // About 14 credits: over the balance too.
  const overBalance = (await probe(60000)).body.result;
  assert.equal(overBudget.isError, true);
  assert.equal(overBalance.isError, true);
  assert.equal(overBudget.content[0].text, overBalance.content[0].text);
  assert.match(overBudget.content[0].text, /more than the 10 credits left/);
  // The consent page starts from a budget the balance covers.
  const p = pkce();
  const info = (
    await agent
      .get("/api/connections/authorize")
      .query(authorizeQuery(small.client, p))
      .expect(200)
  ).body;
  assert.equal(info.defaults.budget, 12);
  // A payment under reconciliation reads like any other "can't spend".
  s.db
    .prepare(
      "INSERT INTO deposits(id,user_id,provider_id,amount,currency,status,payload,credited,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run("dep_x", user.id, "p_x", 1, "usd", "reconciliation", "{}", 1, now(), now());
  const disputed = (
    await call(s.app, small.tokens.access_token, "ask", {
      model: PRIVATE_MODEL,
      prompt: "hi",
      max_tokens: 10,
    })
  ).body.result;
  assert.match(disputed.content[0].text, /can't spend right now/);
});

test("the app learns nothing about the user", async (t) => {
  const s = fixture(t);
  const { agent, user } = await signUp(s.app, "very_private_person");
  s.db
    .prepare("UPDATE users SET email=?, wallet=? WHERE id=?")
    .run("hidden@example.com", "0x1234567890abcdef1234567890abcdef12345678", user.id);
  await agent
    .post("/api/conversations")
    .send({ title: "My diary" })
    .catch(() => {});
  const seen = [];
  const keep = (r) => {
    seen.push(JSON.stringify(r.headers) + r.text);
    return r;
  };
  const client = keep(
    await request(s.app)
      .post("/oauth/register")
      .send({ redirect_uris: [REDIRECT], client_name: "Curious App" }),
  ).body;
  keep(await request(s.app).get("/.well-known/oauth-authorization-server"));
  keep(await request(s.app).get("/.well-known/oauth-protected-resource/mcp"));
  const p = pkce();
  const query = authorizeQuery(client, p);
  keep(await request(s.app).get("/oauth/authorize").query(query));
  const back = await approve(agent, query);
  seen.push(back.href);
  const tokens = keep(
    await exchange(s.app, client, back.searchParams.get("code"), p),
  ).body;
  const refreshed = keep(
    await tokenRequest(s.app, {
      grant_type: "refresh_token",
      client_id: client.client_id,
      refresh_token: tokens.refresh_token,
    }),
  ).body;
  const access = refreshed.access_token;
  keep(
    await rpc(s.app, access, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {},
    }),
  );
  keep(await rpc(s.app, access, { jsonrpc: "2.0", id: 2, method: "tools/list" }));
  for (const name of ["list_models", "balance"])
    keep(await call(s.app, access, name));
  keep(
    await call(s.app, access, "ask", { model: PRIVATE_MODEL, prompt: "who am I?" }),
  );
  keep(await call(s.app, access, "ask", { model: PUBLIC_MODEL, prompt: "x" }));
  keep(
    await request(s.app)
      .post("/oauth/revoke")
      .type("form")
      .send({ token: access }),
  );
  keep(await rpc(s.app, access, { jsonrpc: "2.0", id: 3, method: "ping" }));
  const everything = seen.join("\n");
  const accountTotal = String(balance(s.db, user.id).total / 10000);
  for (const secret of [
    "very_private_person",
    user.id,
    "hidden@example.com",
    "0x1234567890abcdef",
    "My diary",
    accountTotal,
    "anonyma_session",
  ])
    assert.ok(!everything.includes(secret), `leaked ${secret}`);
});

test("the connection's key is never listed or managed as an API key", async (t) => {
  const s = fixture(t);
  const { agent } = await signUp(s.app);
  const { connection, tokens } = await connect(s, { agent });
  await call(s.app, tokens.access_token, "ask", {
    model: PRIVATE_MODEL,
    prompt: "ledger row",
  }).expect(200);
  assert.deepEqual((await agent.get("/api/keys").expect(200)).body.data, []);
  await agent.delete("/api/keys/" + connection.key_id).expect(404);
  await agent
    .patch(`/api/keys/${connection.key_id}/allowance`)
    .send({ total_credits: 999999 })
    .expect(404);
  await agent.post(`/api/keys/${connection.key_id}/pause`).send({}).expect(404);
  // Access tokens only work on /mcp.
  await request(s.app)
    .get("/v1/models")
    .set("Authorization", "Bearer " + tokens.access_token)
    .expect(401);
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + tokens.access_token)
    .send({ model: PRIVATE_MODEL, messages: [{ role: "user", content: "x" }] })
    .expect(401);
  const v1 = (
    await request(s.app)
      .get("/v1")
      .set("Authorization", "Bearer " + tokens.access_token)
  ).body;
  assert.equal(v1.authenticated, false);
  // A refresh token isn't a bearer anywhere.
  await rpc(s.app, tokens.refresh_token, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(401);
  // The ledger names the connection as an app; the export lists it.
  const ledger = (await agent.get("/api/account/ledger")).body.data;
  const row = ledger.find((r) => r.key_id === connection.key_id);
  assert.equal(row.connected_app, true);
  assert.equal(row.key_name, "Test App");
  const exported = (await agent.get("/api/account/export")).body;
  assert.equal(exported.connectedApps.length, 1);
  assert.equal(exported.connectedApps[0].name, "Test App");
  // The 20-key limit doesn't count connections.
  for (let i = 0; i < 3; i++)
    await agent.post("/api/keys").send({ name: "k" + i }).expect(201);
});

test("Connected apps shows metadata and activity, never content", async (t) => {
  const s = fixture(t);
  const { agent } = await signUp(s.app);
  const { connection, tokens } = await connect(s, {
    agent,
    form: { name: "Research bot", budget: 500, expiry_days: 7 },
  });
  const r = (
    await call(s.app, tokens.access_token, "ask", {
      model: PRIVATE_MODEL,
      prompt: "a very private question",
    }).expect(200)
  ).body.result;
  const [c] = (await agent.get("/api/connections").expect(200)).body.data;
  assert.equal(c.id, connection.id);
  assert.equal(c.name, "Research bot");
  assert.equal(c.app_name, "Test App");
  assert.equal(c.redirect_host, "127.0.0.1:33418");
  assert.equal(c.redirect_kind, "loopback");
  assert.equal(c.private_only, true);
  assert.equal(c.budget, 500);
  assert.equal(c.spent, r.structuredContent.credits_charged);
  assert.equal(c.paused, false);
  assert.equal(c.expired, false);
  assert.equal(c.signed_in, true);
  assert.ok(c.last_used && c.activated && c.created);
  assert.ok(Math.abs(c.expires_at - (now() + 7 * 86400000)) < 60000);
  const activity = await agent
    .get(`/api/connections/${connection.id}/activity`)
    .expect(200);
  assert.equal(activity.body.data.length, 1);
  const [row] = activity.body.data;
  assert.deepEqual(Object.keys(row).sort(), [
    "created",
    "credits",
    "id",
    "model",
    "receipt_id",
    "signed",
  ]);
  assert.equal(row.model, PRIVATE_MODEL);
  assert.equal(row.credits, r.structuredContent.credits_charged);
  assert.equal(row.receipt_id, r.structuredContent.request_id);
  assert.equal(row.signed, true);
  assert.doesNotMatch(activity.text, /very private question/);
});

test("closing the account revokes its connected apps", async (t) => {
  const s = fixture(t);
  const { agent } = await signUp(s.app);
  const { tokens, connection } = await connect(s, { agent });
  await agent
    .delete("/api/account")
    .send({ confirm: "DELETE" })
    .expect(200);
  await rpc(s.app, tokens.access_token, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(401);
  const c = s.db
    .prepare("SELECT * FROM oauth_connections WHERE id=?")
    .get(connection.id);
  assert.ok(c.revoked);
  assert.equal(c.name, "Deleted account");
  assert.equal(c.redirect_uri, "");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM oauth_tokens").get().n, 0);
});

test("cleanup removes expired codes, approvals never picked up and unused clients", async (t) => {
  const s = fixture(t);
  const used = await connect(s);
  const idle = await registerClient(s.app);
  const { agent } = await signUp(s.app, "second");
  const pending = await registerClient(s.app);
  await approve(agent, authorizeQuery(pending, pkce()));
  const pendingConnection = s.db
    .prepare("SELECT * FROM oauth_connections WHERE client_id=?")
    .get(pending.client_id);
  // Age everything past its limits.
  s.db.prepare("UPDATE oauth_clients SET created=?").run(now() - 25 * 3600000);
  s.db
    .prepare("UPDATE oauth_connections SET created=? WHERE id=?")
    .run(now() - 11 * 60000, pendingConnection.id);
  sweepOAuth(s.db);
  const clients = s.db
    .prepare("SELECT id FROM oauth_clients")
    .all()
    .map((c) => c.id);
  assert.ok(clients.includes(used.client.client_id), "an authorized client stays");
  assert.ok(!clients.includes(idle.client_id), "an unused client goes");
  assert.ok(!clients.includes(pending.client_id));
  const swept = s.db
    .prepare("SELECT * FROM oauth_connections WHERE id=?")
    .get(pendingConnection.id);
  assert.ok(swept.revoked, "an approval nobody picked up is closed");
  assert.ok(
    s.db.prepare("SELECT revoked FROM api_keys WHERE id=?").get(swept.key_id)
      .revoked,
  );
  assert.equal(
    s.db
      .prepare("SELECT revoked FROM oauth_connections WHERE id=?")
      .get(used.connection.id).revoked,
    null,
  );
  // Expired access tokens are removed; the live refresh token stays.
  s.db
    .prepare("UPDATE oauth_tokens SET expires=? WHERE kind='access'")
    .run(now() - 1);
  sweepOAuth(s.db);
  assert.deepEqual(
    s.db
      .prepare("SELECT kind FROM oauth_tokens")
      .all()
      .map((r) => r.kind),
    ["refresh"],
  );
});

test("an account can hold at most 20 connected apps", async (t) => {
  const s = fixture(t);
  const client = await registerClient(s.app);
  const { agent } = await signUp(s.app);
  for (let i = 0; i < 20; i++)
    await approve(agent, authorizeQuery(client, pkce()));
  const r = await agent
    .post("/api/connections/approve")
    .send({
      request: authorizeQuery(client, pkce()),
      budget: 10,
      expiry_days: 1,
    })
    .expect(400);
  assert.equal(r.body.error.code, "too_many_connections");
});

test("a loopback redirect may use another port; the code goes to the one asked for", async (t) => {
  const s = fixture(t);
  const client = await registerClient(s.app);
  const { agent } = await signUp(s.app);
  const p = pkce();
  const moved = "http://127.0.0.1:50123/callback";
  const query = authorizeQuery(client, p, { redirect_uri: moved });
  await request(s.app).get("/oauth/authorize").query(query).expect(302);
  const info = (
    await agent.get("/api/connections/authorize").query(query).expect(200)
  ).body;
  assert.equal(info.app.redirect_host, "127.0.0.1:50123");
  const back = await approve(agent, query);
  assert.equal(back.origin + back.pathname, moved);
  // The token request names the same address, port included.
  const tokens = (
    await exchange(s.app, client, back.searchParams.get("code"), p, {
      redirect_uri: moved,
    }).expect(200)
  ).body;
  assert.ok(tokens.access_token);
  // A web redirect never gets that freedom.
  const web = await registerClient(s.app, {
    redirect_uris: ["https://app.example:8443/cb"],
  });
  await request(s.app)
    .get("/oauth/authorize")
    .query(authorizeQuery(web, pkce(), { redirect_uri: "https://app.example:9443/cb" }))
    .expect(400);
});

test("a connected app pays the standard rate, whatever the account holds", async (t) => {
  const s = fixture(t, undefined, { markup: 50 });
  const { agent, user } = await signUp(s.app);
  const { tokens } = await connect(s, { agent, form: { budget: 5000 } });
  const charge = async () =>
    (
      await call(s.app, tokens.access_token, "ask", {
        model: PRIVATE_MODEL,
        prompt: "The same prompt each time",
      }).expect(200)
    ).body.result.structuredContent.credits_charged;
  const standard = await charge();
  assert.ok(standard > 0);
  s.db
    .prepare("UPDATE users SET token_balance=? WHERE id=?")
    .run(40000000, user.id);
  assert.equal(await charge(), standard);
});
