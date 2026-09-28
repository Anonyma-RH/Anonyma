import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { config, hash, now } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import {
  parseHolderApiMultipliers,
  DEFAULT_HOLDER_API_MULTIPLIERS,
} from "../server/holder-tiers.js";
import {
  API_RATE,
  FILES_RATE,
  apiMultiplier,
  apiLimitFor,
  apiBoostInfo,
  boostedRate,
} from "../server/api-boost.js";
import { ACCESS_PREFIX } from "../server/oauth.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  apiBoostOf,
  apiBoostPerk,
  rateLine,
  standardLimit,
} from "../src/api-boost.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ALL = UPDATES.map((u) => u.id);
const allBut = (...ids) =>
  ["mvp", ...ALL.filter((id) => !ids.includes(id))].join(",");
const ON = "all";
const OFF = allBut("apiboost");

const NYMA_CONTRACT = "0x968be0c1a394bf1ce239e3b40909ec0f9d4f5583";
const HOUR = 3600000;
const wallet = () => "0x" + randomBytes(20).toString("hex");
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
const TOO_MANY = {
  error: {
    message: "Too many requests. Try again shortly.",
    code: "rate_limit",
    type: "rate_limit_error",
    param: null,
  },
};

// A JSON-RPC stand-in for the token's chain that reports the wrong chain,
// so no background refresh changes the holdings a test writes.
async function rpcServer(t) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const answer = (call) => ({ jsonrpc: "2.0", id: call.id, result: "0x1" });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, released = ON, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-apiboost-"));
  const rpc = await rpcServer(t);
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
    released,
    token: NYMA_CONTRACT,
    chain: 4663,
    rpc,
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function signUp(svc) {
  const agent = request.agent(svc.app);
  const r = await agent
    .post("/api/auth/register")
    .send({
      username: "u" + randomBytes(5).toString("hex"),
      password: "test-password-long",
    })
    .expect(201);
  return { agent, id: r.body.user.id };
}
// Holdings as the worker records them: the open cycle's lowest balance and
// the last successful read.
function hold(svc, id, balance, checked = now()) {
  const open = balance >= 1_000_000;
  svc.db
    .prepare(
      "UPDATE users SET wallet=?,token_balance=?,token_checked=?,holder_cycle=?,holder_low=? WHERE id=?",
    )
    .run(
      wallet(),
      String(balance),
      checked,
      open ? checked : null,
      open ? String(balance) : null,
      id,
    );
}
function apiKey(svc, userId, cap = null) {
  const secret = "anonyma_live_" + randomBytes(24).toString("hex");
  svc.db
    .prepare(
      "INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "key_" + randomBytes(6).toString("hex"),
      userId,
      hash(secret),
      "test",
      secret.slice(0, 20),
      cap,
      now(),
    );
  return "Bearer " + secret;
}
// A live Connect an App connection and access token for `userId`, written
// the way server/oauth.js stores them.
function oauthToken(svc, userId) {
  const t = now(),
    n = randomBytes(6).toString("hex"),
    token = ACCESS_PREFIX + randomBytes(24).toString("hex");
  const db = svc.db;
  db.prepare(
    "INSERT INTO oauth_clients(id,name,redirect_uris,created,authorized) VALUES(?,?,?,?,?)",
  ).run("client_" + n, "Test App", '["http://127.0.0.1:33418/callback"]', t, t);
  db.prepare(
    "INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created,allowance_total,connection_id) VALUES(?,?,NULL,?,NULL,NULL,?,?,?)",
  ).run("key_" + n, userId, "Test App", t, 20_000_000, "conn_" + n);
  db.prepare(
    "INSERT INTO oauth_connections(id,user_id,client_id,key_id,name,client_name,redirect_uri,private_only,created,activated,expires,revoked) VALUES(?,?,?,?,?,?,?,0,?,?,?,NULL)",
  ).run(
    "conn_" + n,
    userId,
    "client_" + n,
    "key_" + n,
    "Test App",
    "Test App",
    "http://127.0.0.1:33418/callback",
    t,
    t,
    t + 86400000,
  );
  db.prepare(
    "INSERT INTO oauth_tokens(hash,connection_id,kind,created,expires,rotated) VALUES(?,?,?,?,?,NULL)",
  ).run(hash(token), "conn_" + n, "access", t, t + 3600000);
  return "Bearer " + token;
}
const mcp = (svc, auth, body = ping) => {
  const r = request(svc.app).post("/mcp");
  if (auth) r.set("Authorization", auth);
  return r.send(body);
};
async function pings(svc, auth, n) {
  const statuses = [];
  for (let i = 0; i < n; i++) statuses.push((await mcp(svc, auth)).status);
  return statuses;
}
const count = (statuses, status) => statuses.filter((s) => s === status).length;

// The limiter stores hashed keys. These find a counter by what it counts:
// the account and the client IP (supertest's loopback address).
const IPS = ["::ffff:127.0.0.1", "127.0.0.1", "::1"];
const keyFor = (svc, name, subject) =>
  `${svc.cfg.rateLimitNamespace}:${name}:${sha(subject)}`;
function counter(svc, name, subjects) {
  for (const subject of subjects) {
    const row = svc.db
      .prepare("SELECT count FROM rate_limits WHERE key=?")
      .get(keyFor(svc, name, subject));
    if (row) return { subject, count: row.count };
  }
  return null;
}
const accountCounter = (svc, userId) =>
  counter(
    svc,
    "api_account",
    IPS.map((ip) => `${userId}:${ip}`),
  );
// Moves an existing counter to `n` within its window (to test the high
// limits without sending hundreds of requests).
function setCount(svc, name, subject, n) {
  svc.db
    .prepare("UPDATE rate_limits SET count=? WHERE key=?")
    .run(n, keyFor(svc, name, subject));
}

// ---- Settings ----

test("HOLDER_API_MULTIPLIERS: defaults, custom values, off, and refusals", () => {
  assert.equal(DEFAULT_HOLDER_API_MULTIPLIERS, "holder:2,insider:3,inner:5");
  assert.deepEqual(parseHolderApiMultipliers(undefined), {
    holder: 2,
    insider: 3,
    inner: 5,
  });
  assert.deepEqual(parseHolderApiMultipliers(null), {
    holder: 2,
    insider: 3,
    inner: 5,
  });
  assert.deepEqual(
    parseHolderApiMultipliers(" inner:4x , holder:1 ,insider:2.5 "),
    { holder: 1, insider: 2.5, inner: 4 },
  );
  assert.deepEqual(parseHolderApiMultipliers("holder:10,insider:10,inner:10"), {
    holder: 10,
    insider: 10,
    inner: 10,
  });
  for (const off of ["", "  ", "off", "OFF"])
    assert.equal(parseHolderApiMultipliers(off), null);
  for (const [bad, message] of [
    ["holder:2,insider:3", /missing: inner/],
    ["holder:2,insider:3,inner:5,vip:9", /tier:multiplier/],
    ["holder:2,holder:3,inner:5", /more than once/],
    ["holder:0.5,insider:1,inner:2", /from 1 to 10/],
    ["holder:0,insider:1,inner:2", /from 1 to 10/],
    ["holder:2,insider:3,inner:11", /from 1 to 10/],
    ["holder:2,insider:1,inner:5", /can't be below/],
    ["holder:-2,insider:3,inner:5", /tier:multiplier/],
    ["holder:2.333,insider:3,inner:5", /tier:multiplier/],
    ["holder:two,insider:3,inner:5", /tier:multiplier/],
    ["holder:2:3,insider:3,inner:5", /tier:multiplier/],
    ["holder:NaN,insider:3,inner:5", /tier:multiplier/],
    ["holder:Infinity,insider:3,inner:5", /tier:multiplier/],
  ])
    assert.throws(() => parseHolderApiMultipliers(bad), message, bad);
  // config() validates it at startup; null (off) and parsed values stay.
  assert.deepEqual(config({}).holderApiMultipliers, {
    holder: 2,
    insider: 3,
    inner: 5,
  });
  assert.equal(config({ holderApiMultipliers: "" }).holderApiMultipliers, null);
  assert.equal(
    config({ holderApiMultipliers: null }).holderApiMultipliers,
    null,
  );
  assert.deepEqual(
    config({ holderApiMultipliers: "holder:1.5,insider:2,inner:3" })
      .holderApiMultipliers,
    { holder: 1.5, insider: 2, inner: 3 },
  );
  assert.throws(
    () => config({ holderApiMultipliers: "holder:0" }),
    /HOLDER_API_MULTIPLIERS/,
  );
  // Boosted rates are whole requests, rounded down.
  assert.equal(boostedRate(120, 1.5), 180);
  assert.equal(boostedRate(60, 2.25), 135);
  assert.equal(boostedRate(120, 1), 120);
  // The example environment files list it, with its defaults.
  for (const f of [".env.example", ".env.production.example"])
    assert.match(
      readFileSync(new URL("../" + f, import.meta.url), "utf8"),
      /^HOLDER_API_MULTIPLIERS=holder:2,insider:3,inner:5$/m,
    );
});

test("the multiplier follows the Holder Program's current tier: each tier, a stale read, no wallet", () => {
  const cfg = config({
    released: ON,
    rpc: "http://127.0.0.1:1",
    token: NYMA_CONTRACT,
  });
  const t = now();
  const user = (low, checked = t, extra = {}) => ({
    id: "u",
    wallet: "0xabc",
    deleted: null,
    holder_cycle: low == null ? null : t - HOUR,
    holder_low: low == null ? null : String(low),
    token_checked: checked,
    ...extra,
  });
  const cases = [
    [user(999_999), 1, null],
    [user(1_000_000), 2, "holder"],
    [user(5_000_000), 3, "insider"],
    [user(25_000_000), 5, "inner"],
    [user(900_000_000), 5, "inner"],
    // A read just inside the 48 hours still counts; one past it doesn't.
    [user(25_000_000, t - 48 * HOUR), 5, "inner"],
    [user(25_000_000, t - 48 * HOUR - 1), 1, null],
    [user(25_000_000, null), 1, null],
    // No wallet, no open cycle, a closed account, no account.
    [user(25_000_000, t, { wallet: null }), 1, null],
    [user(null), 1, null],
    [user(25_000_000, t, { deleted: t }), 1, null],
    [null, 1, null],
  ];
  for (const [u, multiplier, tier] of cases) {
    assert.equal(apiMultiplier(cfg, u, t), multiplier, JSON.stringify(u));
    const limit = apiLimitFor(cfg, u, t);
    assert.equal(limit.multiplier, multiplier);
    assert.equal(limit.perMinute, API_RATE * multiplier);
    assert.equal(limit.filesPerMinute, FILES_RATE * multiplier);
    assert.equal(limit.tier?.id ?? null, tier);
    assert.deepEqual(limit.standard, { perMinute: 120, filesPerMinute: 60 });
    assert.equal(limit.windowSeconds, 60);
  }
  // The cycle's LOWEST read sets the tier, as for every perk.
  assert.equal(
    apiMultiplier(cfg, user(2_000_000, t, { token_balance: "30000000" }), t),
    2,
  );
  const inner = user(25_000_000);
  // Nothing without balance reads, the Holder Program, the update or the
  // multipliers.
  for (const other of [
    config({ released: ON, rpc: "", token: NYMA_CONTRACT }),
    config({
      released: allBut("holders"),
      rpc: "http://127.0.0.1:1",
      token: NYMA_CONTRACT,
    }),
    config({ released: OFF, rpc: "http://127.0.0.1:1", token: NYMA_CONTRACT }),
    config({
      released: ON,
      rpc: "http://127.0.0.1:1",
      token: NYMA_CONTRACT,
      holderApiMultipliers: "off",
    }),
  ]) {
    assert.equal(apiMultiplier(other, inner, t), 1);
    assert.equal(apiLimitFor(other, inner, t).perMinute, 120);
    assert.equal(apiLimitFor(other, inner, t).tier, null);
  }
  // A tier whose multiplier is 1 is no boost, so no tier is shown for it.
  const flat = config({
    released: ON,
    rpc: "http://127.0.0.1:1",
    token: NYMA_CONTRACT,
    holderApiMultipliers: "holder:1,insider:1.5,inner:2",
  });
  assert.equal(apiLimitFor(flat, user(1_000_000), t).tier, null);
  assert.deepEqual(apiLimitFor(flat, user(5_000_000), t).tier, {
    id: "insider",
    name: "Insider",
  });
  assert.equal(apiLimitFor(flat, user(5_000_000), t).perMinute, 180);
});

test("public settings: /api/config lists each tier's limits once released, and nothing before", async (t) => {
  const on = await fixture(t);
  const open = (await request(on.app).get("/api/config").expect(200)).body;
  assert.deepEqual(open.apiBoost, {
    perMinute: 120,
    filesPerMinute: 60,
    tiers: [
      {
        id: "holder",
        name: "Holder",
        multiplier: 2,
        perMinute: 240,
        filesPerMinute: 120,
      },
      {
        id: "insider",
        name: "Insider",
        multiplier: 3,
        perMinute: 360,
        filesPerMinute: 180,
      },
      {
        id: "inner",
        name: "Inner Circle",
        multiplier: 5,
        perMinute: 600,
        filesPerMinute: 300,
      },
    ],
  });
  assert.equal(open.releases.features.apiboost, true);
  const closed = (
    await request((await fixture(t, OFF)).app)
      .get("/api/config")
      .expect(200)
  ).body;
  assert.equal(closed.apiBoost, null);
  assert.equal(closed.releases.features.apiboost, false);
  // Multipliers off: the standard limits, no tiers.
  const flat = await fixture(t, ON, { holderApiMultipliers: "off" });
  assert.deepEqual((await request(flat.app).get("/api/config")).body.apiBoost, {
    perMinute: 120,
    filesPerMinute: 60,
    tiers: [],
  });
  assert.equal(apiBoostInfo(config({ released: OFF })), null);
});

// ---- The limiter ----

test("a boosted account gets its tier's limit on /mcp and /v1, counted apart from everyone else on the same IP", async (t) => {
  const svc = await fixture(t);
  const insider = await signUp(svc);
  hold(svc, insider.id, 6_000_000);
  const standard = await signUp(svc);
  hold(svc, standard.id, 500_000);
  const a = apiKey(svc, insider.id),
    b = apiKey(svc, standard.id);

  // The standard account: 120 a minute, then 429.
  const bRun = await pings(svc, b, 121);
  assert.equal(count(bRun, 200), 120);
  assert.equal(bRun[120], 429);
  // The Insider account on the same IP is untouched by that, and goes past 120.
  const aRun = await pings(svc, a, 130);
  assert.equal(count(aRun, 200), 130);
  // ...and the standard account is still limited: A's traffic never raised it.
  await mcp(svc, b).expect(429);
  // Bad keys from the same IP count per IP, apart from both accounts.
  const bad = "Bearer anonyma_live_" + "0".repeat(48);
  const badRun = await pings(svc, bad, 121);
  assert.equal(count(badRun, 401), 120);
  assert.equal(badRun[120], 429);
  await mcp(svc, a).expect(200);
  await mcp(svc, undefined).expect(429); // no credential at all: the IP counter

  // A's counter is keyed to A (and the IP), and holds A's requests only.
  const own = accountCounter(svc, insider.id);
  assert.equal(own.count, 131);
  assert.equal(accountCounter(svc, standard.id).count, 122);
  // Up to 360 for Insider (3×), then 429.
  setCount(svc, "api_account", own.subject, 359);
  await mcp(svc, a).expect(200);
  const limited = await mcp(svc, a).expect(429);
  assert.deepEqual(limited.body, TOO_MANY);
  // /v1/chat/completions and the /v1 media endpoints share the same counter.
  await request(svc.app)
    .post("/v1/chat/completions")
    .set("Authorization", a)
    .send({ model: "x", messages: [{ role: "user", content: "Hi" }] })
    .expect(429);
  await request(svc.app)
    .post("/v1/images/generations")
    .set("Authorization", a)
    .send({ model: "x", prompt: "a lighthouse" })
    .expect(429);
  // Stored keys never contain an account ID or an IP address.
  for (const { key } of svc.db.prepare("SELECT key FROM rate_limits").all()) {
    assert.doesNotMatch(key, new RegExp(insider.id));
    assert.doesNotMatch(key, /127\.0\.0\.1|::1/);
  }
});

test("each tier gets its own multiple, and a stale read or no wallet gets the standard limit", async (t) => {
  const svc = await fixture(t);
  const cases = [
    ["holder", 1_500_000, now(), 240],
    ["inner", 40_000_000, now(), 600],
    ["stale", 40_000_000, now() - 49 * HOUR, 120],
    ["below", 999_999, now(), 120],
    ["none", null, null, 120],
  ];
  for (const [label, balance, checked, limit] of cases) {
    const u = await signUp(svc);
    if (balance != null) hold(svc, u.id, balance, checked);
    const auth = apiKey(svc, u.id);
    await mcp(svc, auth).expect(200);
    const { subject } = accountCounter(svc, u.id);
    setCount(svc, "api_account", subject, limit - 1);
    assert.equal((await mcp(svc, auth)).status, 200, label);
    const refused = await mcp(svc, auth);
    assert.equal(refused.status, 429, label);
    assert.deepEqual(refused.body, TOO_MANY, label);
  }
});

test("a tier drop lowers the limit at once, within the same window", async (t) => {
  const svc = await fixture(t);
  const u = await signUp(svc);
  hold(svc, u.id, 6_000_000);
  const auth = apiKey(svc, u.id);
  const run = await pings(svc, auth, 150);
  assert.equal(count(run, 200), 150);
  // The balance read goes stale (49 hours): standard limit, and 151 > 120.
  svc.db
    .prepare("UPDATE users SET token_checked=? WHERE id=?")
    .run(now() - 49 * HOUR, u.id);
  const stale = await mcp(svc, auth).expect(429);
  assert.deepEqual(stale.body, TOO_MANY);
  assert.ok(Number(stale.headers["retry-after"]) >= 1);
  assert.ok(Number(stale.headers["retry-after"]) <= 60);
  // A fresh read at Inner Circle: 600, so it's allowed again in the window.
  hold(svc, u.id, 30_000_000);
  await mcp(svc, auth).expect(200);
  // The balance drops below the Holder minimum: the cycle ends, 120 again.
  hold(svc, u.id, 10);
  await mcp(svc, auth).expect(429);
  // Unlinking the wallet does the same.
  hold(svc, u.id, 30_000_000);
  await mcp(svc, auth).expect(200);
  svc.db.prepare("UPDATE users SET wallet=NULL WHERE id=?").run(u.id);
  await mcp(svc, auth).expect(429);
});

test("429s look the same for every account and never mention a tier", async (t) => {
  const on = await fixture(t);
  const holder = await signUp(on);
  hold(on, holder.id, 30_000_000);
  const standard = await signUp(on);
  const h = apiKey(on, holder.id),
    s = apiKey(on, standard.id);
  await mcp(on, h).expect(200);
  await mcp(on, s).expect(200);
  setCount(on, "api_account", accountCounter(on, holder.id).subject, 600);
  setCount(on, "api_account", accountCounter(on, standard.id).subject, 120);
  const boosted = await mcp(on, h).expect(429);
  const plain = await mcp(on, s).expect(429);
  // Before the update: the per-IP limit, as it always was.
  const off = await fixture(t, OFF);
  const before = await signUp(off);
  const o = apiKey(off, before.id);
  await pings(off, o, 120);
  const legacy = await mcp(off, o).expect(429);
  const headerNames = (r) =>
    Object.keys(r.headers)
      .filter(
        (k) =>
          ![
            "date",
            "etag",
            "content-length",
            "connection",
            "keep-alive",
          ].includes(k),
      )
      .sort();
  for (const r of [boosted, plain, legacy]) {
    assert.deepEqual(r.body, TOO_MANY);
    assert.ok(Number(r.headers["retry-after"]) >= 1);
    assert.deepEqual(headerNames(r), headerNames(legacy));
    const everything = JSON.stringify(r.headers) + r.text;
    assert.doesNotMatch(
      everything,
      /tier|holder|insider|inner|boost|nyma|ratelimit-|x-ratelimit/i,
    );
  }
});

test("a connected app gets the standard limit whatever its owner's tier, and never learns the tier", async (t) => {
  const svc = await fixture(t);
  const owner = await signUp(svc);
  hold(svc, owner.id, 6_000_000);
  const app = oauthToken(svc, owner.id);
  const init = await mcp(svc, app, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  }).expect(200);
  const balanceCall = await mcp(svc, app, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "balance", arguments: {} },
  }).expect(200);
  // The owner is an Insider (3x), but the app's counter stays at 120, so an
  // app can't tell a boosted account from any other by pushing past 120.
  const run = await pings(svc, app, 130);
  // 118 here plus the initialize and balance calls above: the standard 120.
  assert.equal(count(run, 200), 118, "the standard 120, not the owner's 360");
  assert.equal(count(run, 429), 12);
  const refused = await mcp(svc, app).expect(429);
  assert.deepEqual(refused.body, TOO_MANY);
  for (const r of [init, balanceCall, refused]) {
    const everything = JSON.stringify(r.headers) + r.text;
    assert.doesNotMatch(
      everything,
      /tier|holder|insider|inner circle|boost|x-ratelimit/i,
    );
  }
  // The account's own limit route is session-only: an access token gets 401.
  await request(svc.app)
    .get("/api/account/api-limit")
    .set("Authorization", app)
    .expect(401);
  // Access tokens only count for the account on /mcp; on /v1 they're
  // unknown credentials, counted per IP and refused by the auth step.
  const before = counter(svc, "api_ip", IPS)?.count ?? 0;
  await request(svc.app)
    .post("/v1/chat/completions")
    .set("Authorization", app)
    .send({ model: "x", messages: [{ role: "user", content: "Hi" }] })
    .expect(401);
  assert.equal(counter(svc, "api_ip", IPS).count, before + 1);
});

test("the boost never lets a key spend past its cap or its account's balance", async (t) => {
  const svc = await fixture(t);
  const u = await signUp(svc);
  hold(svc, u.id, 30_000_000);
  const capped = apiKey(svc, u.id, 0);
  const model = (await request(svc.app).get("/api/models")).body.data.find(
    (m) => m.type === "chat" && m.callable,
  ).id;
  const chat = (auth) =>
    request(svc.app)
      .post("/v1/chat/completions")
      .set("Authorization", auth)
      .send({ model, messages: [{ role: "user", content: "Hi" }] });
  const r = await chat(capped).expect(429);
  assert.equal(r.body.error.code, "key_cap_exceeded");
  // No credits left: 402, boosted or not.
  const broke = await signUp(svc);
  hold(svc, broke.id, 30_000_000);
  svc.db
    .prepare(
      "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(
      "l_" + randomBytes(6).toString("hex"),
      broke.id,
      -100 * 10_000_000,
      "test_credit",
      "drain_" + broke.id,
      null,
      "test drain",
      now(),
    );
  const empty = await chat(apiKey(svc, broke.id)).expect(402);
  assert.equal(empty.body.error.code, "insufficient_credits");
});

test("/v1/files counts per account at 60 times the multiplier", async (t) => {
  const svc = await fixture(t);
  const inner = await signUp(svc);
  hold(svc, inner.id, 30_000_000);
  const standard = await signUp(svc);
  const i = apiKey(svc, inner.id),
    s = apiKey(svc, standard.id);
  const list = (auth) =>
    request(svc.app).get("/v1/files").set("Authorization", auth);
  await list(i).expect(200);
  await list(s).expect(200);
  setCount(svc, "api-files", inner.id, 299);
  setCount(svc, "api-files", standard.id, 59);
  await list(i).expect(200);
  assert.deepEqual((await list(i).expect(429)).body, TOO_MANY);
  await list(s).expect(200);
  await list(s).expect(429);
});

// ---- The release gate ----

test("while unreleased: the per-IP limit for everyone, no route, nothing listed", async (t) => {
  const svc = await fixture(t, OFF);
  const insider = await signUp(svc);
  hold(svc, insider.id, 30_000_000);
  const standard = await signUp(svc);
  const a = apiKey(svc, insider.id),
    b = apiKey(svc, standard.id);
  // One counter for the IP, shared by both accounts: 120 in all.
  const first = await pings(svc, a, 60);
  const second = await pings(svc, b, 60);
  assert.equal(count([...first, ...second], 200), 120);
  await mcp(svc, a).expect(429);
  await mcp(svc, b).expect(429);
  assert.equal(accountCounter(svc, insider.id), null);
  assert.equal(counter(svc, "api_ip", IPS).count, 122);
  // /v1/files: the standard 60 per account, holder or not.
  setCount(svc, "api-files", insider.id, 0);
  await request(svc.app).get("/v1/files").set("Authorization", a).expect(200);
  setCount(svc, "api-files", insider.id, 60);
  await request(svc.app).get("/v1/files").set("Authorization", a).expect(429);
  // The account's route is refused, and nothing is listed.
  const r = await insider.agent.get("/api/account/api-limit").expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(r.body.error.message, "API Boost is coming soon.");
  const contract = (await request(svc.app).get("/api/openapi.json").expect(200))
    .body;
  assert.equal(contract.paths["/api/account/api-limit"], undefined);
  assert.deepEqual(
    featuresFor({ path: "/api/account/api-limit", method: "GET" }),
    ["api", "apiboost"],
  );
  // It also needs the API released.
  const noApi = await fixture(t, allBut("api"));
  const n = await signUp(noApi);
  const refused = await n.agent.get("/api/account/api-limit").expect(403);
  assert.equal(
    refused.body.error.message,
    `${UPDATES.find((u) => u.id === "api").title} is coming soon.`,
  );
});

test("/api/account/api-limit: the signed-in account's own limit", async (t) => {
  const svc = await fixture(t);
  const insider = await signUp(svc);
  hold(svc, insider.id, 6_000_000);
  const standard = await signUp(svc);
  const own = (await insider.agent.get("/api/account/api-limit").expect(200))
    .body;
  assert.deepEqual(own, {
    perMinute: 360,
    filesPerMinute: 180,
    standard: { perMinute: 120, filesPerMinute: 60 },
    multiplier: 3,
    tier: { id: "insider", name: "Insider" },
    windowSeconds: 60,
  });
  const plain = (await standard.agent.get("/api/account/api-limit").expect(200))
    .body;
  assert.equal(plain.perMinute, 120);
  assert.equal(plain.tier, null);
  await request(svc.app).get("/api/account/api-limit").expect(401);
  // An API key isn't a session.
  await request(svc.app)
    .get("/api/account/api-limit")
    .set("Authorization", apiKey(svc, insider.id))
    .expect(401);
  // Listed in the contract once released.
  const contract = (await request(svc.app).get("/api/openapi.json").expect(200))
    .body;
  assert.ok(contract.paths["/api/account/api-limit"].get);
  assert.match(
    contract.paths["/v1/chat/completions"].post.description,
    /API Boost/,
  );
  assert.match(contract.paths["/mcp"].post.description, /never told its tier/);
});

// ---- The app ----

async function uiModule() {
  const src = new URL("../src/ApiBoost.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(
    readFileSync(src, "utf8"),
    src.pathname,
    {
      jsx: "transform",
      format: "esm",
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "anonyma-apiboost-ui-"));
  const react = import.meta.resolve("react");
  const router = join(dir, "router.mjs");
  writeFileSync(
    router,
    `import React from "${react}";\nexport const Link = ({ children, to, ...p }) => React.createElement("a", { href: to, ...p }, children);`,
  );
  const out = code
    .replace(/^import "\.\/api-boost\.css";$/m, "")
    .replace(/from "react-router-dom"/g, `from "${pathToFileURL(router).href}"`)
    .replace(
      /from "\.\/lib\.js"/g,
      `from "${new URL("../src/lib.js", import.meta.url)}"`,
    )
    .replace(
      /from "\.\/api-boost\.js"/g,
      `from "${new URL("../src/api-boost.js", import.meta.url)}"`,
    )
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "ApiBoost.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const boost = {
  perMinute: 120,
  filesPerMinute: 60,
  tiers: [
    {
      id: "holder",
      name: "Holder",
      multiplier: 2,
      perMinute: 240,
      filesPerMinute: 120,
    },
    {
      id: "insider",
      name: "Insider",
      multiplier: 3,
      perMinute: 360,
      filesPerMinute: 180,
    },
    {
      id: "inner",
      name: "Inner Circle",
      multiplier: 5,
      perMinute: 600,
      filesPerMinute: 300,
    },
  ],
};
const released = {
  releases: { features: { apiboost: true } },
  apiBoost: boost,
};
const insiderLimit = {
  perMinute: 360,
  filesPerMinute: 180,
  multiplier: 3,
  tier: { id: "insider", name: "Insider" },
};
const entities = (s) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
const textsOf = (html) =>
  [
    ...html.split(/<[^>]+>/),
    ...[...html.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)].map(
      (m) => m[1],
    ),
  ]
    .map((s) => entities(s).trim())
    .filter((s) => /[A-Za-z]{2}/.test(s));

test("the API keys line, the holdings list and the guide render, and hide while unreleased", async () => {
  const { ApiRateLimit, ApiRateCard, HoldingsApiBoost, ApiGuideLimits } =
    await uiModule();
  // Unreleased (or no config): nothing.
  for (const config of [
    null,
    {},
    { releases: { features: { apiboost: false } }, apiBoost: boost },
  ]) {
    assert.equal(
      renderToStaticMarkup(createElement(ApiRateLimit, { config, demo: true })),
      "",
    );
    assert.equal(
      renderToStaticMarkup(
        createElement(HoldingsApiBoost, { config, tierId: "inner" }),
      ),
      "",
    );
    assert.equal(
      renderToStaticMarkup(createElement(ApiGuideLimits, { config })),
      "",
    );
  }
  assert.equal(
    apiBoostOf({ releases: { features: {} }, apiBoost: boost }),
    null,
  );
  // The sample account (demo): the standard limit, and how to raise it.
  const demo = renderToStaticMarkup(
    createElement(ApiRateLimit, { config: released, demo: true }),
  );
  assert.match(demo, /Your API rate limit: 120 requests\/min</);
  assert.match(
    demo,
    /<li class="on"><span>Standard<\/span><b>120\/min<\/b><\/li>/,
  );
  assert.match(
    demo,
    /Holding NYMA in a linked wallet raises it, up to 600 requests\/min at Inner Circle\./,
  );
  assert.match(demo, /href="\/token"/);
  // A signed-in account before its own limit has loaded.
  const loading = renderToStaticMarkup(
    createElement(ApiRateLimit, { config: released, user: { id: "u" } }),
  );
  assert.match(loading, /Loading your API rate limit…/);
  assert.doesNotMatch(loading, /class="on"/);
  // An Insider account.
  const card = renderToStaticMarkup(
    createElement(ApiRateCard, { boost, limit: insiderLimit }),
  );
  assert.match(
    card,
    /Your API rate limit: 360 requests\/min \(Insider boost\)/,
  );
  assert.match(
    card,
    /<li class="on"><span>Insider<\/span><b>360\/min<\/b><\/li>/,
  );
  assert.match(card, /File uploads have their own: 180 requests\/min\./);
  assert.match(card, /still set what(&#x27;|')s spent/);
  assert.doesNotMatch(card, /Holding NYMA/);
  // Multipliers off: the line, no tiers.
  const flat = renderToStaticMarkup(
    createElement(ApiRateCard, {
      boost: { ...boost, tiers: [] },
      limit: standardLimit(boost),
    }),
  );
  assert.match(flat, /Your API rate limit: 120 requests\/min/);
  assert.doesNotMatch(flat, /<ul|Holding NYMA/);
  // Holdings: every tier, the account's own marked.
  const holdings = renderToStaticMarkup(
    createElement(HoldingsApiBoost, { config: released, tierId: "inner" }),
  );
  assert.match(holdings, /<h3>API Boost<\/h3>/);
  assert.match(
    holdings,
    /<li class="on"><span>Inner Circle<\/span><b>600 requests\/min<\/b><em>5×<\/em><\/li>/,
  );
  assert.match(
    holdings,
    /<li><span>Holder<\/span><b>240 requests\/min<\/b><em>2×<\/em><\/li>/,
  );
  // The guide.
  const guide = renderToStaticMarkup(
    createElement(ApiGuideLimits, { config: released }),
  );
  assert.match(
    guide,
    /share 120 requests\/min for each account from each IP address/,
  );
  assert.match(
    guide,
    /Inner Circle: 600 requests\/min, file uploads 300 requests\/min/,
  );
  assert.match(guide, /never told your tier/);
  // Shared helpers.
  assert.equal(
    rateLine(insiderLimit),
    "Your API rate limit: 360 requests/min (Insider boost)",
  );
  assert.equal(apiBoostPerk(boost, "insider"), "API limit 3×");
  assert.equal(apiBoostPerk(boost, "nope"), null);
  assert.equal(
    apiBoostPerk({ tiers: [{ id: "holder", multiplier: 1 }] }, "holder"),
    null,
  );
});

test("every word API Boost shows has a Chinese translation", async () => {
  const dict = compileDictionary(
    JSON.parse(
      readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"),
    ),
  );
  const han = /\p{Script=Han}/u;
  const { ApiRateLimit, ApiRateCard, HoldingsApiBoost, ApiGuideLimits } =
    await uiModule();
  const html = [
    renderToStaticMarkup(
      createElement(ApiRateLimit, { config: released, demo: true }),
    ),
    renderToStaticMarkup(
      createElement(ApiRateLimit, { config: released, user: { id: "u" } }),
    ),
    renderToStaticMarkup(
      createElement(ApiRateCard, { boost, limit: insiderLimit }),
    ),
    renderToStaticMarkup(
      createElement(ApiRateCard, {
        boost,
        limit: {
          ...insiderLimit,
          perMinute: 600,
          filesPerMinute: 300,
          tier: { id: "inner", name: "Inner Circle" },
        },
      }),
    ),
    renderToStaticMarkup(
      createElement(HoldingsApiBoost, { config: released, tierId: "holder" }),
    ),
    renderToStaticMarkup(createElement(ApiGuideLimits, { config: released })),
  ].join("");
  const texts = textsOf(html);
  assert.ok(texts.includes("Your API rate limit: 120 requests/min"));
  assert.ok(texts.includes("API Boost"));
  for (const text of texts)
    assert.match(translateText(text, dict) ?? "", han, `untranslated: ${text}`);
  const entry = UPDATES.find((u) => u.id === "apiboost");
  // Plain product copy: nothing about returns, yield, profit, price or value.
  for (const text of [...texts, entry.title, entry.tagline, ...entry.points])
    assert.doesNotMatch(
      text,
      /\b(returns?|yield|profit|prices?|invest\w*|value|earn\w*|gains?)\b/i,
      text,
    );
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "API Boost is coming soon.",
    "API limit 3×",
    "API limit 2.5×",
    "Holder and up",
    "More API and MCP requests a minute for your API keys and connected apps. Standard: 120 requests/min. Your balance, key caps and allowances still set what's spent.",
    "429 — rate limit or key_cap_exceeded. See the rate limits above; each key can also have a rolling 24-hour credit cap.",
    "429 — rate limit or key_cap_exceeded. Chat completions allows 120 requests per minute per IP; each key can also have a rolling 24-hour credit cap.",
  ])
    assert.match(translateText(text, dict) ?? "", han, `untranslated: ${text}`);
  // Numbers and tier names survive translation.
  assert.equal(
    translateText(
      "Your API rate limit: 1,200 requests/min (Inner Circle boost)",
      dict,
    ),
    "你的 API 速率上限：每分钟 1,200 个请求（核心圈提速）",
  );
});

test("the API keys page, holdings, /token and the API guide wire it in", () => {
  const read = (f) =>
    readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  assert.match(
    read("Account.jsx"),
    /<ApiRateLimit config=\{config\} user=\{user\} demo=\{demo\} \/>/,
  );
  const holders = read("Holders.jsx");
  assert.match(
    holders,
    /<HoldingsApiBoost config=\{config\} tierId=\{state\?\.tier\?\.id\} \/>/,
  );
  assert.match(
    holders,
    /apiBoostPerk\(apiBoostOf\(config\), state\.tier\.id\)/,
  );
  const token = read("Token.jsx");
  assert.match(token, /apiBoostPerk\(apiBoost, t\.id\)/);
  assert.match(token, /API Boost <small>/);
  const guide = read("ApiGuide.jsx");
  assert.match(guide, /<ApiGuideLimits config=\{config\} \/>/);
  assert.match(guide, /apiBoostOf\(config\) \?/);
  // The new files are in the public allowlist; the server module needs no
  // src/ file, so the production image needs no new COPY.
  const allow = JSON.parse(
    readFileSync(new URL("../.public-files.json", import.meta.url), "utf8"),
  ).files;
  for (const f of [
    "server/api-boost.js",
    "server/routes/api-boost.js",
    "src/ApiBoost.jsx",
    "src/api-boost.css",
    "src/api-boost.js",
    "tests/api-boost.test.mjs",
  ])
    assert.ok(Object.hasOwn(allow, f), f);
  assert.doesNotMatch(
    readFileSync(new URL("../server/api-boost.js", import.meta.url), "utf8"),
    /from "\.\.\/src\//,
  );
});
