import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { config, hash, now } from "../server/core.js";
import {
  UPDATES,
  earlyOpen,
  earlyUpdates,
  releaseGuard,
  EARLY_ACCESS_MIN_NYMA,
} from "../server/releases.js";
import {
  earlyAccessHolder,
  earlyAccessFor,
  requestHolder,
  EARLY_ACCESS_MAX_AGE,
} from "../server/holders.js";
import { authenticateAccessToken, ACCESS_PREFIX } from "../server/oauth.js";
import { knownPage, sitemap } from "../src/site-routes.js";
import { isReleased } from "../src/lib.js";
import { withEarlyAccess, isEarlyAccess, earlyUpdates as clientEarly } from "../src/holders.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// `early` is the owner's per-feature switch; tests set it on one update at a
// time and put it back.
function markEarly(t, id, value = true) {
  const u = UPDATES.find((x) => x.id === id);
  const had = Object.prototype.hasOwnProperty.call(u, "early"),
    was = u.early;
  u.early = value;
  t.after(() => (had ? (u.early = was) : delete u.early));
}
const ALL = UPDATES.map((u) => u.id);
// Every update released except `ids`: "mvp,code,search,...".
const allBut = (...ids) =>
  ["mvp", ...ALL.filter((id) => !ids.includes(id))].join(",");

const NYMA_CONTRACT = "0x968be0c1a394bf1ce239e3b40909ec0f9d4f5583";
const HOLDING = { rpc: "http://127.0.0.1:1", token: NYMA_CONTRACT };
const wallet = () => "0x" + randomBytes(20).toString("hex");

// A read-only JSON-RPC stand-in for the token's chain. By default it reports
// the wrong chain, so any background refresh fails and seeded holdings stay
// exactly as a test wrote them.
async function rpcServer(t, { chainId = 1, balance = 0n } = {}) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const answer = (call) => {
      if (call.method === "eth_chainId")
        return { jsonrpc: "2.0", id: call.id, result: "0x" + chainId.toString(16) };
      const value = call.params[0].data.startsWith("0x70a08231") ? balance : 18n;
      return {
        jsonrpc: "2.0",
        id: call.id,
        result: "0x" + value.toString(16).padStart(64, "0"),
      };
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-holders-"));
  const rpc = extra.rpc ?? (await rpcServer(t));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
    released: released ?? "all",
    token: NYMA_CONTRACT,
    chain: 4663,
    ...extra,
    rpc,
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
    .send({ username: "u" + randomBytes(5).toString("hex"), password: "test-password-long" })
    .expect(201);
  return { agent, id: r.body.user.id };
}
// Holdings as the worker records them: wallet, balance, last good read.
function hold(svc, id, balance, checked = now(), address = wallet()) {
  svc.db
    .prepare("UPDATE users SET wallet=?,token_balance=?,token_checked=? WHERE id=?")
    .run(address, String(balance), checked, id);
}
async function holder(svc) {
  const u = await signUp(svc);
  hold(svc, u.id, 6_000_000);
  return u;
}
async function nonHolder(svc) {
  const u = await signUp(svc);
  hold(svc, u.id, 4_999_999);
  return u;
}
function apiKey(svc, userId) {
  const secret = "anonyma_" + randomBytes(24).toString("hex");
  svc.db
    .prepare("INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created) VALUES(?,?,?,?,?,?,?)")
    .run("key_" + randomBytes(6).toString("hex"), userId, hash(secret), "test", secret.slice(0, 12), null, now());
  return "Bearer " + secret;
}
// A live Connect an App connection and access token for `userId`, written
// the way server/oauth.js stores them.
function oauthToken(svc, userId) {
  const t = now(),
    n = randomBytes(6).toString("hex"),
    token = ACCESS_PREFIX + randomBytes(24).toString("hex");
  const db = svc.db;
  db.prepare("INSERT INTO oauth_clients(id,name,redirect_uris,created,authorized) VALUES(?,?,?,?,?)").run(
    "client_" + n, "Test App", '["http://127.0.0.1:33418/callback"]', t, t,
  );
  db.prepare(
    "INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created,allowance_total,connection_id) VALUES(?,?,NULL,?,NULL,NULL,?,?,?)",
  ).run("key_" + n, userId, "Test App", t, 20_000_000, "conn_" + n);
  db.prepare(
    "INSERT INTO oauth_connections(id,user_id,client_id,key_id,name,client_name,redirect_uri,private_only,created,activated,expires,revoked) VALUES(?,?,?,?,?,?,?,1,?,?,?,NULL)",
  ).run("conn_" + n, userId, "client_" + n, "key_" + n, "Test App", "Test App", "http://127.0.0.1:33418/callback", t, t, t + 86400000);
  db.prepare("INSERT INTO oauth_tokens(hash,connection_id,kind,created,expires,rotated) VALUES(?,?,?,?,?,NULL)").run(
    hash(token), "conn_" + n, "access", t, t + 3600000,
  );
  return token;
}
const refused = async (res, title) => {
  const r = await res.expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(r.body.error.message, `${title} is coming soon.`);
};
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };

test("Holder Early Access is registered, unreleased by default, and not itself early", () => {
  const entry = UPDATES.find((u) => u.id === "holders");
  assert.ok(entry, "holders is registered in UPDATES");
  // Its release commit flips this; the gates below hold either way.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "Holder Early Access");
  assert.equal(entry.tagline, "Hold NYMA, get what's next first.");
  assert.equal(entry.points.length, 3);
  assert.equal(entry.early, undefined);
  assert.equal(EARLY_ACCESS_MIN_NYMA, 5_000_000);
});

test("the holder rule: config, linked wallet, a recent read and the threshold", () => {
  const cfg = { ...HOLDING, earlyAccessMin: 5_000_000 };
  const t = now();
  const user = { wallet: wallet(), token_balance: "5000000", token_checked: t - 1000, deleted: null };
  assert.equal(earlyAccessHolder(cfg, user, t), true);
  // Threshold.
  assert.equal(earlyAccessHolder(cfg, { ...user, token_balance: "4999999.999" }, t), false);
  assert.equal(earlyAccessHolder(cfg, { ...user, token_balance: "not a number" }, t), false);
  assert.equal(earlyAccessHolder({ ...cfg, earlyAccessMin: 100 }, { ...user, token_balance: "100" }, t), true);
  assert.equal(earlyAccessHolder({ ...cfg, earlyAccessMin: 100 }, { ...user, token_balance: "99" }, t), false);
  // Stale or never read.
  assert.equal(earlyAccessHolder(cfg, { ...user, token_checked: t - EARLY_ACCESS_MAX_AGE + 60000 }, t), true);
  assert.equal(earlyAccessHolder(cfg, { ...user, token_checked: t - EARLY_ACCESS_MAX_AGE - 1 }, t), false);
  assert.equal(earlyAccessHolder(cfg, { ...user, token_checked: null }, t), false);
  // Unlinked wallet, closed account.
  assert.equal(earlyAccessHolder(cfg, { ...user, wallet: null }, t), false);
  assert.equal(earlyAccessHolder(cfg, { ...user, deleted: t }, t), false);
  assert.equal(earlyAccessHolder(cfg, null, t), false);
  // Token config unset: nobody is a holder.
  assert.equal(earlyAccessHolder({ ...cfg, rpc: "" }, user, t), false);
  assert.equal(earlyAccessHolder({ ...cfg, token: "" }, user, t), false);
  assert.equal(earlyAccessHolder({}, user, t), false);
});

test("EARLY_ACCESS_MIN_NYMA is configurable and must be positive", (t) => {
  assert.equal(config({}).earlyAccessMin, 5_000_000);
  const saved = process.env.EARLY_ACCESS_MIN_NYMA;
  t.after(() =>
    saved === undefined
      ? delete process.env.EARLY_ACCESS_MIN_NYMA
      : (process.env.EARLY_ACCESS_MIN_NYMA = saved),
  );
  process.env.EARLY_ACCESS_MIN_NYMA = "1000";
  assert.equal(config({}).earlyAccessMin, 1000);
  for (const bad of ["0", "-5", "lots"]) {
    process.env.EARLY_ACCESS_MIN_NYMA = bad;
    assert.throws(() => config({}), /EARLY_ACCESS_MIN_NYMA/);
  }
});

test("an update is early only while marked, unreleased and Holder Early Access is live", (t) => {
  markEarly(t, "scrolls");
  const cfg = (released) => config({ released });
  assert.equal(earlyOpen(cfg(allBut("scrolls")), "scrolls"), true);
  assert.deepEqual(earlyUpdates(cfg(allBut("scrolls"))), ["scrolls"]);
  // Holder Early Access itself not live: nothing opens early.
  assert.equal(earlyOpen(cfg(allBut("scrolls", "holders")), "scrolls"), false);
  // Released to everyone: no longer early.
  assert.equal(earlyOpen(cfg("all"), "scrolls"), false);
  // Not marked.
  assert.equal(earlyOpen(cfg(allBut("scrolls", "symposium")), "symposium"), false);
});

test("Connect an App can never be early: an outside app drives it", async (t) => {
  markEarly(t, "connect");
  assert.equal(earlyOpen(config({ released: allBut("connect") }), "connect"), false);
  const svc = await fixture(t, allBut("connect"));
  const h = await holder(svc);
  await refused(h.agent.get("/api/connections"), "Connect an App");
  const cfg = (await request(svc.app).get("/api/config")).body;
  assert.equal(cfg.releases.updates.find((u) => u.id === "connect").early, false);
  assert.deepEqual((await h.agent.get("/api/me")).body.user.earlyAccess, []);
});

test("an early update opens to a holder's session and to no one else", async (t) => {
  markEarly(t, "scrolls");
  const svc = await fixture(t, allBut("scrolls"));
  const h = await holder(svc),
    n = await nonHolder(svc);
  await h.agent.get("/api/scrolls").expect(200);
  await refused(n.agent.get("/api/scrolls"), "Scrolls");
  await refused(request(svc.app).get("/api/scrolls"), "Scrolls");
  // A balance read more than 48 hours ago no longer counts.
  const stale = await signUp(svc);
  hold(svc, stale.id, 50_000_000, now() - EARLY_ACCESS_MAX_AGE - 60000);
  await refused(stale.agent.get("/api/scrolls"), "Scrolls");
  // A holding without a linked wallet doesn't count.
  const unlinked = await signUp(svc);
  svc.db
    .prepare("UPDATE users SET wallet=NULL,token_balance='9000000',token_checked=? WHERE id=?")
    .run(now(), unlinked.id);
  await refused(unlinked.agent.get("/api/scrolls"), "Scrolls");
  // A forged or expired session is nobody.
  await refused(
    request(svc.app).get("/api/scrolls").set("Cookie", "anonyma_session=session_forged"),
    "Scrolls",
  );
  // A closed account's holdings don't count.
  const gone = await holder(svc);
  svc.db.prepare("UPDATE users SET deleted=? WHERE id=?").run(now(), gone.id);
  await refused(gone.agent.get("/api/scrolls"), "Scrolls");
});

test("unmarked updates, an unreleased Holder Early Access and unset token config all keep a holder out", async (t) => {
  // Not marked early.
  {
    const svc = await fixture(t, allBut("scrolls"));
    const h = await holder(svc);
    await refused(h.agent.get("/api/scrolls"), "Scrolls");
  }
  markEarly(t, "scrolls");
  // Holder Early Access itself unreleased.
  {
    const svc = await fixture(t, allBut("scrolls", "holders"));
    const h = await holder(svc);
    await refused(h.agent.get("/api/scrolls"), "Scrolls");
    const me = (await h.agent.get("/api/me").expect(200)).body.user;
    assert.deepEqual(me.earlyAccess, []);
    assert.equal(me.holder.eligible, false);
  }
  // TOKEN_RPC_URL / TOKEN_CONTRACT unset: nobody is a holder, pages still work.
  {
    const svc = await fixture(t, allBut("scrolls"), { rpc: "", token: "" });
    const h = await holder(svc);
    await refused(h.agent.get("/api/scrolls"), "Scrolls");
    const me = (await h.agent.get("/api/me").expect(200)).body.user;
    assert.deepEqual(me.earlyAccess, []);
    assert.equal(me.holder.eligible, false);
    const cfg = (await request(svc.app).get("/api/config").expect(200)).body;
    assert.equal(cfg.services.token, false);
    assert.equal(cfg.releases.updates.find((u) => u.id === "scrolls").early, true);
    await request(svc.app).get("/token").expect(200);
  }
});

test("the account's own API key carries early access on /v1; its session cookie doesn't", async (t) => {
  markEarly(t, "api");
  const svc = await fixture(t, allBut("api"));
  const h = await holder(svc),
    n = await nonHolder(svc);
  // Key creation is part of the early update: the holder can, others can't.
  const created = (await h.agent.post("/api/keys").send({ name: "early" }).expect(201)).body;
  await refused(n.agent.post("/api/keys").send({ name: "early" }), "Developer API & CLI");
  const holderKey = "Bearer " + created.key,
    otherKey = apiKey(svc, n.id);
  await request(svc.app).get("/v1/models").set("Authorization", holderKey).expect(200);
  await refused(request(svc.app).get("/v1/models").set("Authorization", otherKey), "Developer API & CLI");
  await refused(request(svc.app).get("/v1/models"), "Developer API & CLI");
  // /v1 authenticates by key only, so the gate ignores cookies there: a
  // holder's session can't lend early access to another account's key.
  await refused(h.agent.get("/v1/models").set("Authorization", otherKey), "Developer API & CLI");
  await refused(h.agent.get("/v1/models"), "Developer API & CLI");
  // A revoked key is nobody.
  svc.db.prepare("UPDATE api_keys SET revoked=? WHERE hash=?").run(now(), hash(created.key));
  await refused(request(svc.app).get("/v1/models").set("Authorization", holderKey), "Developer API & CLI");
});

test("on /mcp an API key carries early access and a connected app never does", async (t) => {
  markEarly(t, "mcp");
  const svc = await fixture(t, allBut("mcp"));
  const h = await holder(svc),
    n = await nonHolder(svc);
  const mcp = (auth) =>
    request(svc.app).post("/mcp").set("Authorization", auth).send(initialize);
  const ok = await mcp(apiKey(svc, h.id)).expect(200);
  assert.equal(ok.body.result.serverInfo.name, "anonyma");
  await refused(mcp(apiKey(svc, n.id)), "MCP Server");
  // A valid OAuth access token for the holder's own account: refused
  // exactly like a non-holder, so the app can't tell.
  const token = oauthToken(svc, h.id);
  assert.ok(authenticateAccessToken(svc.db, token), "the token itself is valid");
  const app = await mcp("Bearer " + token);
  const other = await mcp("Bearer " + oauthToken(svc, n.id));
  assert.equal(app.status, 403);
  assert.deepEqual(app.body, other.body);
  assert.equal(app.body.error.code, "feature_unreleased");
  // Same answer from the resolver directly, whatever the route.
  const isHolder = requestHolder(svc.db, svc.cfg);
  for (const path of ["/mcp", "/MCP", "/v1/models"])
    assert.equal(isHolder({ path, headers: { authorization: "Bearer " + token }, cookies: {} }), false);
  assert.equal(isHolder({ path: "/mcp", headers: { authorization: apiKey(svc, h.id) }, cookies: {} }), true);
});

test("the guard asks about the holder only for early gates, once, and fails closed", async (t) => {
  markEarly(t, "scrolls");
  const cfg = config({ released: allBut("scrolls", "symposium"), ...HOLDING });
  const run = (req, holder) => {
    let error = null;
    try {
      releaseGuard(cfg, holder)(req, {}, () => {});
    } catch (e) {
      error = e;
    }
    return error;
  };
  let asked = 0;
  const yes = () => (++asked, true);
  assert.equal(run({ path: "/api/scrolls", method: "GET", body: {} }, yes), null);
  assert.equal(asked, 1);
  // Not early: refused without asking.
  assert.equal(run({ path: "/api/chat", method: "POST", body: { mode: "symposium" } }, yes).code, "feature_unreleased");
  assert.equal(asked, 1);
  // Released: never asked.
  assert.equal(run({ path: "/api/collabs", method: "GET", body: {} }, yes), null);
  assert.equal(asked, 1);
  // Anything but a plain true is a refusal, and no resolver means no one.
  for (const answer of [false, "true", 1, undefined])
    assert.equal(run({ path: "/api/scrolls", method: "GET", body: {} }, () => answer).code, "feature_unreleased");
  assert.equal(run({ path: "/api/scrolls", method: "GET", body: {} }, undefined).code, "feature_unreleased");
});

test("public surfaces are identical for holders, non-holders and signed-out visitors", async (t) => {
  markEarly(t, "scrolls");
  const svc = await fixture(t, allBut("scrolls"));
  const h = await holder(svc),
    n = await nonHolder(svc),
    anon = request.agent(svc.app);
  for (const path of ["/api/config", "/api/models", "/api/openapi.json", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/robots.txt", "/token", "/roadmap"]) {
    const [a, b, c] = await Promise.all([h.agent.get(path), n.agent.get(path), anon.get(path)]);
    assert.equal(a.status, 200, path);
    assert.deepEqual([a.status, a.text], [b.status, b.text], path);
    assert.deepEqual([a.status, a.text], [c.status, c.text], path);
  }
  const cfg = (await anon.get("/api/config")).body;
  // The roadmap may say which updates are early: that's product information.
  assert.equal(cfg.releases.updates.find((u) => u.id === "scrolls").early, true);
  assert.equal(cfg.releases.updates.find((u) => u.id === "symposium").early, false);
  assert.equal(cfg.releases.features.scrolls, false);
  assert.deepEqual(cfg.releases.earlyAccess, { threshold: 5_000_000 });
  assert.doesNotMatch(JSON.stringify(cfg), /earlyAccess":\[|eligible/);
});

test("the session JSON lists the account's own early updates and holder status", async (t) => {
  markEarly(t, "scrolls");
  markEarly(t, "symposium");
  const svc = await fixture(t, allBut("scrolls", "symposium"));
  const h = await holder(svc),
    n = await nonHolder(svc);
  const mine = (await h.agent.get("/api/me").expect(200)).body.user;
  assert.deepEqual(mine.earlyAccess, ["symposium", "scrolls"]);
  assert.deepEqual(mine.holder, { eligible: true, threshold: 5_000_000 });
  assert.equal(typeof mine.tokenChecked, "number");
  const theirs = (await n.agent.get("/api/me").expect(200)).body.user;
  assert.deepEqual(theirs.earlyAccess, []);
  assert.deepEqual(theirs.holder, { eligible: false, threshold: 5_000_000 });
  assert.equal((await request(svc.app).get("/api/me").expect(200)).body.user, null);
  // Same helper as the session: a released update is never "early".
  const released = config({ released: "all", ...HOLDING });
  assert.deepEqual(earlyAccessFor(released, { wallet: wallet(), token_balance: "6000000", token_checked: now() }).earlyAccess, []);
});

test("/token is an unknown page before the release and a public page after", async (t) => {
  const before = await fixture(t, allBut("holders"));
  await request(before.app).get("/token").expect(404);
  await request(before.app).get("/token/").expect(404);
  assert.doesNotMatch((await request(before.app).get("/sitemap.xml")).text, /\/token</);
  const live = await fixture(t, "mvp,holders");
  await request(live.app).get("/token").expect(200);
  assert.match((await request(live.app).get("/sitemap.xml")).text, /<loc>http:\/\/localhost:5175\/token<\/loc>/);
  // The same rule for the shared route list.
  assert.equal(knownPage("/token"), false);
  assert.equal(knownPage("/token", { token: true }), true);
  assert.doesNotMatch(sitemap("https://x.test"), /token/);
  assert.match(sitemap("https://x.test", { token: true }), /https:\/\/x.test\/token/);
});

test("a wallet can be unlinked, but never an account's only way to sign in", async (t) => {
  const closed = await fixture(t, allBut("holders"));
  const early = await holder(closed);
  await refused(early.agent.post("/api/account/wallet/unlink").send({}), "Holder Early Access");

  markEarly(t, "scrolls");
  const svc = await fixture(t, allBut("scrolls"));
  await request(svc.app).post("/api/account/wallet/unlink").send({}).expect(401);
  const none = await signUp(svc);
  const r = await none.agent.post("/api/account/wallet/unlink").send({}).expect(400);
  assert.equal(r.body.error.code, "wallet_not_linked");
  // Wallet-only account: unlinking would lock it out.
  const only = await holder(svc);
  svc.db.prepare("UPDATE users SET password=NULL,email=NULL WHERE id=?").run(only.id);
  const locked = await only.agent.post("/api/account/wallet/unlink").send({}).expect(409);
  assert.equal(locked.body.error.code, "wallet_sign_in_only");
  // A holder unlinks: wallet and holdings go, and so does early access.
  const h = await holder(svc);
  await h.agent.get("/api/scrolls").expect(200);
  const after = (await h.agent.post("/api/account/wallet/unlink").send({}).expect(200)).body.user;
  assert.equal(after.wallet, null);
  assert.equal(after.tokenBalance, "0");
  assert.equal(after.tokenChecked, null);
  assert.deepEqual(after.earlyAccess, []);
  assert.equal(after.holder.eligible, false);
  await refused(h.agent.get("/api/scrolls"), "Scrolls");
});

test("a balance read from the chain turns early access on, and a failed read never renews it", async (t) => {
  markEarly(t, "scrolls");
  // Account → Refresh reads the balance over RPC; access follows it.
  const rpc = await rpcServer(t, { chainId: 4663, balance: 7_000_000n * 10n ** 18n });
  const svc = await fixture(t, allBut("scrolls"), { rpc });
  const u = await signUp(svc);
  svc.db.prepare("UPDATE users SET wallet=? WHERE id=?").run(wallet(), u.id);
  await refused(u.agent.get("/api/scrolls"), "Scrolls");
  const me = (await u.agent.post("/api/account/token/refresh").send({}).expect(200)).body.user;
  assert.equal(me.tokenBalance, "7000000");
  assert.equal(me.holder.eligible, true);
  await u.agent.get("/api/scrolls").expect(200);

  // The background worker: a failed read backs off without touching
  // token_checked, so a balance nobody can confirm lapses after 48 hours.
  const broken = await fixture(t, allBut("scrolls")); // wrong-chain RPC
  const v = await signUp(broken);
  const checked = now() - 47 * 3600000;
  hold(broken, v.id, 6_000_000, checked);
  await v.agent.get("/api/scrolls").expect(200);
  await broken.tick();
  const row = broken.db.prepare("SELECT * FROM users WHERE id=?").get(v.id);
  assert.equal(row.token_checked, checked, "a failed read is not a check");
  assert.ok(row.token_retry >= now() - 60000, "the retry is scheduled");
  assert.equal(earlyAccessHolder(broken.cfg, row, now() + 2 * 3600000), false);
  // It isn't retried before the hour is up.
  await broken.tick();
  assert.equal(broken.db.prepare("SELECT token_retry FROM users WHERE id=?").get(v.id).token_retry, row.token_retry);
});

test("the browser opens exactly the account's early updates", () => {
  const config = {
    releases: {
      features: { holders: true, scrolls: false, symposium: false, collab: false },
      updates: [
        { id: "holders", released: true, early: false },
        { id: "scrolls", released: false, early: true },
        { id: "symposium", released: false, early: false },
        { id: "collab", released: false, early: true },
      ],
      earlyAccess: { threshold: 5_000_000 },
    },
  };
  assert.deepEqual(clientEarly(config).map((u) => u.id), ["scrolls", "collab"]);
  // A holder's session lists scrolls, and claims symposium, which isn't early.
  const user = { earlyAccess: ["scrolls", "symposium"] };
  const mine = withEarlyAccess(config, user);
  assert.equal(isReleased(mine, "scrolls"), true);
  assert.equal(isReleased(mine, "symposium"), false);
  assert.equal(isReleased(mine, "collab"), false);
  assert.equal(isEarlyAccess(mine, "scrolls"), true);
  assert.equal(isEarlyAccess(mine, "collab"), false);
  // Nobody else, and the public config itself, is unchanged.
  assert.equal(withEarlyAccess(config, null), config);
  assert.equal(withEarlyAccess(config, { earlyAccess: [] }), config);
  assert.equal(isReleased(config, "scrolls"), false);
  // Before Holder Early Access is live, nothing opens.
  const off = { releases: { ...config.releases, features: { ...config.releases.features, holders: false } } };
  assert.equal(isReleased(withEarlyAccess(off, user), "scrolls"), false);
  assert.equal(withEarlyAccess(null, user), null);
});

test("the NYMA page and whitepaper section stick to facts", () => {
  const page = readFileSync(new URL("../src/Token.jsx", import.meta.url), "utf8");
  const paper = readFileSync(new URL("../src/Whitepaper.jsx", import.meta.url), "utf8");
  const section = paper.slice(paper.indexOf('<Section id="nyma"'), paper.indexOf('<Section id="roadmap"'));
  assert.ok(section.length > 200, "the whitepaper has a NYMA section");
  for (const text of [page, section]) {
    assert.doesNotMatch(text, /discount|markup|price|allocation|vesting|liquidity|invest|yield|APY|\breturns\b|profit/i);
    assert.match(text, /not financial advice|isn't financial advice|nothing here is financial advice/i);
  }
  // The contract comes from the homepage constant, never a second copy.
  assert.doesNotMatch(page + section, /0x968be0c1/);
  assert.match(page, /import \{ CONTRACT_ADDRESS \} from "\.\/Home\.jsx"/);
});
