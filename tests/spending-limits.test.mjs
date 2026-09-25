import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import {
  addCredit,
  balance,
  reserve,
  release,
  settle,
  uid,
  now,
} from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import {
  DAY,
  HOUR,
  changeLimits,
  limitsView,
  spendingRoom,
  waitText,
} from "../server/spending-limits.js";
import { spendingLimitMessage } from "../src/lib.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { knownPage } from "../src/site-routes.js";
import { estimateLabel } from "../src/estimate.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const IMAGE_MODEL = "google/gemini-2.5-flash-image";
const ORIGIN = "http://localhost:5175";
const units = (credits) => Math.round(credits * 10000);

async function fixture(t, released = "all", extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-limits-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: ORIGIN,
    released,
    mvpModels: [MODEL],
    ...extra,
  });
  // No background maintenance: these tests move the clock, and expired
  // holds must stay exactly as each test leaves them.
  await svc.stopWork();
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  svc.dir = dir;
  return svc;
}
let visitor = 0;
async function person(app, username = "u" + randomBytes(4).toString("hex")) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor % 250}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
// A controllable clock for core.now() and everything else on Date.now.
function clock(t, start = Date.now()) {
  let at = start;
  t.mock.method(Date, "now", () => at);
  return {
    get now() {
      return at;
    },
    advance(ms) {
      at += ms;
    },
    set(ms) {
      at = ms;
    },
  };
}
const setLimits = (p, body) => p.agent.patch("/api/spending-limits").send(body);
const ledgerRows = (s) => s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n;
const holdRow = (s, id) =>
  s.db.prepare("SELECT * FROM holds WHERE id=?").get(id);
function refused(fn) {
  try {
    fn();
  } catch (e) {
    assert.equal(e.code, "spending_limit", e.message);
    assert.equal(e.status, 402);
    return e;
  }
  assert.fail("expected a spending_limit refusal");
}
// A settled personal charge of `amount` subcredits, the normal way.
function spend(s, user, amount, id = uid("h_")) {
  reserve(s.db, { id, user, amount, ttl: 90 * DAY });
  settle(s.db, id, amount);
  return id;
}
const say = (text = "Hello limits") => ({
  model: MODEL,
  messages: [{ role: "user", content: text }],
  max_tokens: 40,
});

test("Spending Limits is registered, off by default and gated like any update", async (t) => {
  const entry = UPDATES.find((u) => u.id === "limits");
  assert.ok(entry, "limits is registered");
  assert.equal(entry.title, "Spending Limits");
  assert.equal(typeof entry.tagline, "string");
  assert.equal(entry.points.length, 3);
  assert.ok(
    UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "voice"),
    "added after the releases before it",
  );
  assert.equal(
    committed[UPDATES.indexOf(entry)],
    true,
    "released by its release commit",
  );
  for (const [path, method] of [
    ["/api/spending-limits", "GET"],
    ["/api/spending-limits", "PATCH"],
    ["/api/spending-limits/pending/daily", "DELETE"],
    ["/API/Spending-Limits", "GET"],
  ])
    assert.deepEqual(featuresFor({ path, method, body: {} }), ["limits"], path);

  // The Account tab's address is a known page (it says "coming soon"
  // until the update is released).
  assert.equal(knownPage("/account/limits"), true);

  const mvp = await fixture(t, "mvp");
  const a = await person(mvp.app);
  for (const send of [
    () => a.agent.get("/api/spending-limits"),
    () => a.agent.patch("/api/spending-limits").send({ daily_limit: 1 }),
    () => a.agent.delete("/api/spending-limits/pending/daily"),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Spending Limits is coming soon.");
  }
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.limits, false);
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200))
    .body;
  assert.ok(
    !Object.keys(closed.paths).some((p) => p.includes("spending-limits")),
  );

  // Released on its own: the routes need nothing else.
  const own = await fixture(t, "mvp,limits");
  const b = await person(own.app);
  const view = (await b.agent.get("/api/spending-limits").expect(200)).body;
  assert.equal(view.daily.limit, null);
  assert.equal(view.monthly.limit, null);
  assert.equal(view.daily.remaining, null);
  assert.equal(view.daily.pending, null);
  assert.equal(view.daily.window_hours, 24);
  assert.equal(view.monthly.window_hours, 720);
  assert.equal(view.raise_delay_hours, 24);
  const open = (await request(own.app).get("/api/openapi.json").expect(200))
    .body;
  assert.ok(open.paths["/api/spending-limits"].get);
  assert.ok(open.paths["/api/spending-limits"].patch);
  assert.ok(open.paths["/api/spending-limits/pending/{limit}"].delete);
  await request(own.app).get("/api/spending-limits").expect(401);
});

test("while unreleased, stored limits have no effect anywhere", async (t) => {
  const s = await fixture(t, "mvp,api,social");
  const a = await person(s.app);
  const b = await person(s.app);
  // A limit of 0 left behind (say, the update was switched off again).
  s.db
    .prepare(
      "INSERT INTO spending_limits(user_id,daily_limit,monthly_limit,updated) VALUES(?,0,0,?)",
    )
    .run(a.user.id, now());
  reserve(s.db, { id: "gate-off", user: a.user.id, amount: units(5) });
  release(s.db, "gate-off");
  await a.agent.post("/api/chat").send(say()).expect(200);
  await a.agent
    .post("/api/credits/send")
    .send({ to: b.user.username, amount: 2 })
    .expect(201);
  const q = (await a.agent.post("/api/quote").send(say()).expect(200)).body;
  assert.equal(q.spending_limit, undefined);
});

test("a hold is refused before it's placed, exactly at the boundary", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  const user = a.user.id;
  const r = await setLimits(a, { daily_limit: 5 }).expect(200);
  assert.equal(r.body.changes.daily_limit, "applied");
  assert.equal(r.body.daily.limit, 5);
  const ledger = ledgerRows(s);

  // Exactly the limit fits.
  reserve(s.db, { id: "at", user, amount: units(5) });
  release(s.db, "at");
  // One subcredit more doesn't, and nothing is held or written.
  let e = refused(() =>
    reserve(s.db, { id: "over", user, amount: units(5) + 1 }),
  );
  assert.equal(holdRow(s, "over"), undefined);
  assert.equal(ledgerRows(s), ledger);
  assert.equal(e.spendingLimit.limit, "daily");
  assert.equal(e.spendingLimit.limit_credits, 5);
  assert.equal(e.spendingLimit.requested_credits, 5.0001);
  assert.equal(e.spendingLimit.frees_at, null);
  assert.match(
    e.message,
    /^This would spend up to 5\.0001 credits, more than your whole daily spending limit of 5 credits\.$/,
  );

  // Open holds count, whatever their age.
  reserve(s.db, { id: "h1", user, amount: units(3) });
  e = refused(() => reserve(s.db, { id: "h2", user, amount: units(2) + 1 }));
  assert.equal(e.spendingLimit.held_credits, 3);
  assert.equal(e.spendingLimit.remaining_credits, 2);
  assert.equal(e.spendingLimit.frees_at, null);
  assert.equal(
    e.message,
    "This would spend up to 2.0001 credits, more than the 2 credits left of your daily spending limit. Room frees up as requests in progress finish.",
  );
  reserve(s.db, { id: "h3", user, amount: units(2) });
  e = refused(() => reserve(s.db, { id: "h4", user, amount: 1 }));
  assert.match(
    e.message,
    /^You've reached your daily spending limit of 5 credits\./,
  );
  // A free request spends nothing, so it isn't refused.
  reserve(s.db, { id: "free", user, amount: 0 });
  release(s.db, "free");

  // Releasing a hold frees its room at once.
  release(s.db, "h1");
  reserve(s.db, { id: "h5", user, amount: units(3) });
  // A settled hold counts what it charged, never more than it held.
  settle(s.db, "h3", units(0.5));
  assert.equal(limitsView(s.db, user).daily.used, 3.5);
  reserve(s.db, { id: "h6", user, amount: units(1.5) });
  refused(() => reserve(s.db, { id: "h7", user, amount: 1 }));
  assert.equal(spendingRoom(s.db, user), 0);
  for (const id of ["h5", "h6"]) release(s.db, id);
  assert.equal(spendingRoom(s.db, user), units(4.5));
});

test("settled spend leaves each rolling window on time, and the refusal says when", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  const user = a.user.id;
  const c = clock(t);
  const T0 = c.now;
  await setLimits(a, { daily_limit: 10, monthly_limit: 25 }).expect(200);
  spend(s, user, units(6));
  c.advance(HOUR);
  spend(s, user, units(4));
  // 10 of 10 used today: 1 more fits once the first charge is 24 hours old.
  let e = refused(() => reserve(s.db, { id: "r1", user, amount: units(1) }));
  assert.equal(e.spendingLimit.limit, "daily");
  assert.equal(e.spendingLimit.frees_at, T0 + DAY);
  assert.match(
    e.message,
    /Room frees up in 23 h \(\d{4}-\d\d-\d\dT\d\d:\d\dZ\)\.$/,
  );
  // 7 more needs both charges gone.
  e = refused(() => reserve(s.db, { id: "r2", user, amount: units(7) }));
  assert.equal(e.spendingLimit.frees_at, T0 + HOUR + DAY);
  assert.equal(limitsView(s.db, user).daily.next_room_at, T0 + DAY);

  // At exactly 24 hours the first charge has left the daily window.
  c.set(T0 + DAY);
  spend(s, user, units(6));
  let v = limitsView(s.db, user);
  assert.equal(v.daily.used, 10);
  assert.equal(v.monthly.used, 16);
  // Two days in: nothing counts today, but the month still holds all 16.
  c.set(T0 + 2 * DAY);
  v = limitsView(s.db, user);
  assert.equal(v.daily.used, 0);
  assert.equal(v.monthly.used, 16);
  e = refused(() => reserve(s.db, { id: "r3", user, amount: units(10) }));
  assert.equal(e.spendingLimit.limit, "monthly");
  assert.equal(e.spendingLimit.window_hours, 720);
  assert.equal(e.spendingLimit.frees_at, T0 + 30 * DAY);
  // 30 days after the first charge, the month has room for it again.
  c.set(T0 + 30 * DAY);
  reserve(s.db, { id: "r4", user, amount: units(10) });
  release(s.db, "r4");

  // When both limits refuse, the one that holds out longest is named: here
  // the month frees up in an hour (its oldest charge is 29 days 23 hours
  // old), the day only after 24 hours. (Direct calls: the session that
  // signed up 30 days ago has expired.)
  changeLimits(s.db, user, { daily: units(5), monthly: units(16) });
  spend(s, user, units(5));
  e = refused(() => reserve(s.db, { id: "r5", user, amount: units(2) }));
  assert.equal(e.spendingLimit.limit, "daily");
  assert.equal(e.spendingLimit.frees_at, c.now + DAY);
  // And the other way round.
  const b = await person(s.app);
  changeLimits(s.db, b.user.id, { daily: units(5), monthly: units(6) });
  spend(s, b.user.id, units(5));
  e = refused(() =>
    reserve(s.db, { id: "r6", user: b.user.id, amount: units(2) }),
  );
  assert.equal(e.spendingLimit.limit, "monthly");
  assert.equal(e.spendingLimit.frees_at, c.now + 30 * DAY);
});

test("waits read plainly", () => {
  assert.equal(waitText(1), "1 min");
  assert.equal(waitText(45 * 60000), "45 min");
  assert.equal(waitText(3 * HOUR + 12 * 60000), "3 h 12 min");
  assert.equal(waitText(23 * HOUR), "23 h");
  assert.equal(waitText(12 * DAY + 4 * HOUR), "12 days 4 h");
  assert.equal(waitText(3 * DAY), "3 days");
});

test("workspace chat is refused with 402 before anything is held or saved", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  await setLimits(a, { daily_limit: 0 }).expect(200);
  const before = balance(s.db, a.user.id);
  const r = await a.agent
    .post("/api/chat")
    .send({ ...say(), requestId: "refused-chat" })
    .expect(402);
  assert.equal(r.body.error.code, "spending_limit");
  assert.equal(r.body.error.type, "insufficient_quota");
  assert.equal(
    r.body.error.message,
    "Your daily spending limit is 0 credits, so nothing can be spent.",
  );
  assert.equal(r.body.spending_limit.limit, "daily");
  assert.equal(r.body.spending_limit.limit_credits, 0);
  assert.equal(holdRow(s, a.user.id + ":refused-chat"), undefined);
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?")
      .get(a.user.id).n,
    0,
  );
  assert.deepEqual(balance(s.db, a.user.id), before);
  // The estimate shows the room, so the composer can warn before Send.
  const q = (await a.agent.post("/api/quote").send(say()).expect(200)).body;
  assert.deepEqual(q.spending_limit, { remaining: 0 });
  // The chip beside Send says so, apart from a short balance.
  assert.equal(estimateLabel({ status: "ready", credits: 2, available: 50, room: 1 }).tone, "limited");
  assert.equal(estimateLabel({ status: "ready", credits: 2, available: 1, room: 1 }).tone, "short");
  assert.equal(estimateLabel({ status: "ready", credits: 2, available: 50 }).tone, "ready");
  // The browser's wording names the limit the same way.
  assert.equal(
    spendingLimitMessage(r.body),
    "Your daily spending limit is 0 credits, so nothing can be spent.",
  );
});

test("a chat's reservation headroom falls back to the base estimate under a limit", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  await a.agent
    .post("/api/chat")
    .send({ ...say(), requestId: "probe" })
    .expect(200);
  const probe = holdRow(s, a.user.id + ":probe");
  const headroom = probe.amount;
  const spent = limitsView(s.db, a.user.id).daily.used;
  // Room for more than the base estimate but less than the headroom.
  await setLimits(a, {
    daily_limit: spent + Math.floor(headroom / 2) / 10000,
  }).expect(200);
  await a.agent
    .post("/api/chat")
    .send({ ...say(), requestId: "fits" })
    .expect(200);
  const held = holdRow(s, a.user.id + ":fits");
  assert.ok(held.amount < headroom, "held the base estimate, not the headroom");
  const v = limitsView(s.db, a.user.id);
  assert.ok(v.daily.used <= v.daily.limit);
});

test("API keys, the /v1 API and the MCP server are all held to the account's limits", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  const key = (
    await a.agent
      .post("/api/keys")
      .send({ name: "script", cap: null })
      .expect(201)
  ).body;
  // A generous key allowance doesn't lift the account's own limit.
  await a.agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: 1000 })
    .expect(200);
  await setLimits(a, { daily_limit: 0 }).expect(200);
  const v1 = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .set("Idempotency-Key", "v1-refused")
    .send(say())
    .expect(402);
  assert.equal(v1.body.error.code, "spending_limit");
  assert.equal(v1.body.spending_limit.limit, "daily");
  assert.equal(holdRow(s, a.user.id + ":v1-refused"), undefined);

  const mcp = await request(s.app)
    .post("/mcp")
    .set("Authorization", "Bearer " + key.key)
    .send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "ask",
        arguments: { model: MODEL, prompt: "hi", max_tokens: 40 },
      },
    })
    .expect(200);
  assert.equal(mcp.body.result.isError, true);
  assert.match(
    mcp.body.result.content[0].text,
    /^Your daily spending limit is 0 credits/,
  );
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM holds WHERE user_id=?").get(a.user.id)
      .n,
    0,
  );
});

test("a connected app is refused in its budget's terms, never told the account's limits", async (t) => {
  const s = await fixture(t, "all", { privateModels: [MODEL] });
  const a = await person(s.app);
  // Connect an App: register, approve with a 2,000 credit budget, exchange.
  const client = (
    await request(s.app)
      .post("/oauth/register")
      .send({
        client_name: "Test App",
        redirect_uris: ["http://127.0.0.1:33418/callback"],
      })
      .expect(201)
  ).body;
  const verifier = randomBytes(32).toString("base64url");
  const query = {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: client.redirect_uris[0],
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    state: "s1",
    scope: "mcp",
    resource: ORIGIN + "/mcp",
  };
  const back = new URL(
    (
      await a.agent
        .post("/api/connections/approve")
        .send({
          request: query,
          budget: 2000,
          expiry_days: 30,
          private_only: true,
        })
        .expect(200)
    ).body.redirect,
  );
  const tokens = (
    await request(s.app)
      .post("/oauth/token")
      .type("form")
      .send({
        grant_type: "authorization_code",
        client_id: client.client_id,
        code: back.searchParams.get("code"),
        redirect_uri: client.redirect_uris[0],
        code_verifier: verifier,
        resource: ORIGIN + "/mcp",
      })
      .expect(200)
  ).body;
  const ask = () =>
    request(s.app)
      .post("/mcp")
      .set("Authorization", "Bearer " + tokens.access_token)
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "ask",
          arguments: { model: MODEL, prompt: "hi", max_tokens: 40 },
        },
      })
      .expect(200);
  // Without a limit, the connection works as usual.
  const ran = await ask();
  assert.equal(ran.body.result.isError, undefined, JSON.stringify(ran.body));
  // With less room than the budget left: the same fixed answer as a short
  // balance, whatever the request's size, before anything is held.
  await setLimits(a, { daily_limit: 1 }).expect(200);
  const holds = () =>
    s.db.prepare("SELECT COUNT(*) n FROM holds WHERE user_id=?").get(a.user.id)
      .n;
  const held = holds();
  const r = await ask();
  assert.equal(r.body.result.isError, true);
  assert.equal(
    r.body.result.content[0].text,
    "This connection can't spend right now. Its owner can check it in ANONYMA.",
  );
  assert.doesNotMatch(JSON.stringify(r.body), /spending limit|spending_limit/i);
  assert.equal(holds(), held);
  // Its balance tool still reports only the connection's own budget.
  const bal = await request(s.app)
    .post("/mcp")
    .set("Authorization", "Bearer " + tokens.access_token)
    .send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "balance", arguments: {} },
    })
    .expect(200);
  assert.doesNotMatch(
    JSON.stringify(bal.body),
    /spending limit|spending_limit/i,
  );
});

test("team-paid requests don't count and aren't blocked; contributions do count", async (t) => {
  const s = await fixture(t);
  const ana = await person(s.app, "ana");
  const { id } = (
    await ana.agent.post("/api/collabs").send({ name: "Launch" }).expect(201)
  ).body;
  const convo = (
    await ana.agent
      .post(`/api/collabs/${id}/conversations`)
      .send({ title: "Plan" })
      .expect(201)
  ).body.id;
  await ana.agent
    .post(`/api/collabs/${id}/treasury/contribute`)
    .send({ credits: 50, idempotency_key: "c1" })
    .expect(201);
  // The contribution left the personal balance, so it counts.
  let v = (await ana.agent.get("/api/spending-limits").expect(200)).body;
  assert.equal(v.daily.used, 50);
  await setLimits(ana, { daily_limit: 60 }).expect(200);
  const over = await ana.agent
    .post(`/api/collabs/${id}/treasury/contribute`)
    .send({ credits: 11, idempotency_key: "c2" })
    .expect(402);
  assert.equal(over.body.error.code, "spending_limit");
  assert.equal(over.body.spending_limit.remaining_credits, 10);
  // A retry of a contribution already made isn't a new spend.
  await ana.agent
    .post(`/api/collabs/${id}/treasury/contribute`)
    .send({ credits: 50, idempotency_key: "c1" })
    .expect(200);

  // With no personal room left, team pays still works, and doesn't count.
  await setLimits(ana, { daily_limit: 0 }).expect(200);
  await ana.agent
    .post("/api/chat")
    .send({
      ...say(),
      conversationId: convo,
      treasury: true,
      requestId: "team",
    })
    .expect(200);
  const teamHold = s.db
    .prepare(
      "SELECT h.* FROM holds h JOIN treasury_spends t ON t.hold_id=h.id WHERE t.user_id=?",
    )
    .get(ana.user.id);
  assert.equal(teamHold.status, "settled");
  assert.notEqual(
    teamHold.user_id,
    ana.user.id,
    "held on the treasury's own account",
  );
  v = (await ana.agent.get("/api/spending-limits").expect(200)).body;
  assert.equal(v.daily.used, 50, "only the contribution counts");
  const personal = await ana.agent
    .post("/api/chat")
    .send({ ...say(), conversationId: convo, requestId: "mine" })
    .expect(402);
  assert.equal(personal.body.error.code, "spending_limit");
  // A team-paid estimate says nothing about personal limits.
  const q = (
    await ana.agent
      .post("/api/quote")
      .send({ ...say(), conversationId: convo, treasury: true })
      .expect(200)
  ).body;
  assert.equal(q.spending_limit, undefined);
});

test("credits sent count for the sender only; top-ups, refunds and corrections never count", async (t) => {
  const s = await fixture(t);
  const ana = await person(s.app, "ana");
  const bob = await person(s.app, "bob");
  await setLimits(ana, { daily_limit: 10 }).expect(200);
  await setLimits(bob, { daily_limit: 1 }).expect(200);
  await ana.agent
    .post("/api/credits/send")
    .send({ to: "bob", amount: 6, requestId: "t1" })
    .expect(201);
  const over = await ana.agent
    .post("/api/credits/send")
    .send({ to: "bob", amount: 5, requestId: "t2" })
    .expect(402);
  assert.equal(over.body.error.code, "spending_limit");
  assert.equal(over.body.spending_limit.remaining_credits, 4);
  assert.match(
    over.body.error.message,
    /^This would spend up to 5 credits, more than the 4 credits left of your daily spending limit\. Room frees up in 24 h/,
  );
  assert.equal(
    spendingLimitMessage(over.body).replace(/at .+\.$/, "at TIME."),
    "This would spend up to 5 credits, more than the 4 credits left of your daily spending limit. Room frees up at TIME.",
  );
  // The same request again returns the original transfer.
  await ana.agent
    .post("/api/credits/send")
    .send({ to: "bob", amount: 6, requestId: "t1" })
    .expect(200);
  await ana.agent
    .post("/api/credits/send")
    .send({ to: "bob", amount: 4, requestId: "t3" })
    .expect(201);
  // Receiving isn't spending.
  assert.equal(limitsView(s.db, bob.user.id).daily.used, 0);

  // Money coming in, and corrections, change the balance but not the usage.
  const used = limitsView(s.db, ana.user.id).daily.used;
  addCredit(s.db, ana.user.id, units(100), "deposit-x", "deposit", "Deposit");
  const correction = s.db.prepare(
    "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
  );
  correction.run(
    uid("l_"),
    ana.user.id,
    -units(20),
    "payment_correction",
    "corr-1",
    null,
    "Payment reversed",
    now(),
  );
  correction.run(
    uid("l_"),
    ana.user.id,
    -units(1),
    "referral_correction",
    "corr-2",
    null,
    "Referral reversed",
    now(),
  );
  assert.equal(limitsView(s.db, ana.user.id).daily.used, used);
});

test("lowering applies now; raising and removing wait 24 hours and can be cancelled", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  const user = a.user.id;
  const c = clock(t);
  const ledger = ledgerRows(s);
  let r = await setLimits(a, { daily_limit: 100 }).expect(200);
  assert.equal(r.body.changes.daily_limit, "applied");
  r = await setLimits(a, { daily_limit: 50 }).expect(200);
  assert.equal(r.body.changes.daily_limit, "applied");
  assert.equal(r.body.daily.limit, 50);

  // A raise waits; the lower limit keeps applying meanwhile.
  const T1 = c.now;
  r = await setLimits(a, { daily_limit: 80 }).expect(200);
  assert.equal(r.body.changes.daily_limit, "pending");
  assert.equal(r.body.daily.limit, 50);
  assert.deepEqual(r.body.daily.pending, { limit: 80, applies_at: T1 + DAY });
  refused(() => reserve(s.db, { id: "x1", user, amount: units(60) }));
  c.set(T1 + DAY - 1);
  assert.equal(
    (await a.agent.get("/api/spending-limits").expect(200)).body.daily.limit,
    50,
  );
  c.set(T1 + DAY);
  let v = (await a.agent.get("/api/spending-limits").expect(200)).body;
  assert.equal(v.daily.limit, 80);
  assert.equal(v.daily.pending, null);
  reserve(s.db, { id: "x2", user, amount: units(60) });
  release(s.db, "x2");

  // Cancelling keeps the limit in force.
  r = await setLimits(a, { daily_limit: 200 }).expect(200);
  assert.equal(r.body.changes.daily_limit, "pending");
  v = (await a.agent.delete("/api/spending-limits/pending/daily").expect(200))
    .body;
  assert.equal(v.daily.pending, null);
  assert.equal(v.daily.limit, 80);
  c.advance(2 * DAY);
  assert.equal(
    (await a.agent.get("/api/spending-limits").expect(200)).body.daily.limit,
    80,
  );
  const none = await a.agent
    .delete("/api/spending-limits/pending/daily")
    .expect(404);
  assert.equal(none.body.error.code, "no_pending_change");
  await a.agent.delete("/api/spending-limits/pending/weekly").expect(400);

  // Removing a limit is a raise: it waits too.
  const T2 = c.now;
  r = await setLimits(a, { daily_limit: null }).expect(200);
  assert.equal(r.body.changes.daily_limit, "pending");
  assert.deepEqual(r.body.daily.pending, { limit: null, applies_at: T2 + DAY });
  assert.equal(r.body.daily.limit, 80);
  c.set(T2 + DAY);
  assert.equal(
    (await a.agent.get("/api/spending-limits").expect(200)).body.daily.limit,
    null,
  );

  // Adding a limit applies at once; a new raise starts the wait again.
  r = await setLimits(a, { monthly_limit: 100 }).expect(200);
  assert.equal(r.body.changes.monthly_limit, "applied");
  const T3 = c.now;
  await setLimits(a, { monthly_limit: 150 }).expect(200);
  c.advance(12 * HOUR);
  r = await setLimits(a, { monthly_limit: 200 }).expect(200);
  assert.equal(r.body.monthly.pending.applies_at, T3 + 12 * HOUR + DAY);
  c.set(T3 + DAY);
  assert.equal(
    (await a.agent.get("/api/spending-limits").expect(200)).body.monthly.limit,
    100,
  );
  // Lowering while a raise is pending applies now and drops the raise.
  r = await setLimits(a, { monthly_limit: 90 }).expect(200);
  assert.equal(r.body.changes.monthly_limit, "applied");
  assert.equal(r.body.monthly.pending, null);
  // Sending the limit in force cancels a pending change.
  await setLimits(a, { monthly_limit: 120 }).expect(200);
  r = await setLimits(a, { monthly_limit: 90 }).expect(200);
  assert.equal(r.body.changes.monthly_limit, "unchanged");
  assert.equal(r.body.monthly.pending, null);
  // Fields left out keep their value and their pending change.
  await setLimits(a, { daily_limit: 40 }).expect(200);
  await setLimits(a, { daily_limit: 45 }).expect(200);
  r = await setLimits(a, { monthly_limit: 80 }).expect(200);
  assert.equal(r.body.daily.limit, 40);
  assert.equal(r.body.daily.pending.limit, 45);

  // Settings only: integer subcredits, and never a ledger row.
  const row = s.db
    .prepare(
      "SELECT typeof(daily_limit) d, typeof(monthly_limit) m, typeof(daily_pending) p, daily_limit, monthly_limit FROM spending_limits WHERE user_id=?",
    )
    .get(user);
  assert.deepEqual(
    { ...row },
    {
      d: "integer",
      m: "integer",
      p: "integer",
      daily_limit: 400000,
      monthly_limit: 800000,
    },
  );
  assert.equal(ledgerRows(s), ledger);
});

test("limits are validated, stored exactly and kept to their own account", async (t) => {
  const s = await fixture(t);
  const ana = await person(s.app, "ana");
  const bob = await person(s.app, "bob");
  for (const body of [
    { daily_limit: -1 },
    { daily_limit: 1_000_000_001 },
    { daily_limit: 1.00001 },
    { daily_limit: "5" },
    { monthly_limit: {} },
    {},
    { weekly_limit: 5 },
  ]) {
    const r = await setLimits(ana, body).expect(400);
    assert.equal(r.body.error.code, "invalid_limit", JSON.stringify(body));
  }
  const r = await setLimits(ana, {
    daily_limit: 1_000_000_000,
    monthly_limit: 12.3456,
  }).expect(200);
  assert.equal(r.body.daily.limit, 1_000_000_000);
  assert.equal(r.body.monthly.limit, 12.3456);
  assert.equal(
    s.db
      .prepare("SELECT monthly_limit n FROM spending_limits WHERE user_id=?")
      .get(ana.user.id).n,
    123456,
  );
  // The schema refuses anything but a whole, non-negative number of subcredits.
  for (const bad of [1.5, -1])
    assert.throws(
      () =>
        s.db
          .prepare("UPDATE spending_limits SET daily_limit=? WHERE user_id=?")
          .run(bad, ana.user.id),
      /CHECK/,
    );

  // Bob sees and changes only his own.
  await setLimits(ana, { monthly_limit: 20 }).expect(200);
  const bobView = (await bob.agent.get("/api/spending-limits").expect(200))
    .body;
  assert.equal(bobView.monthly.limit, null);
  await bob.agent.delete("/api/spending-limits/pending/monthly").expect(404);
  assert.equal(
    (await ana.agent.get("/api/spending-limits").expect(200)).body.monthly
      .pending.limit,
    20,
  );
  // Someone else's spending never counts toward yours.
  spend(s, bob.user.id, units(30));
  assert.equal(limitsView(s.db, ana.user.id).monthly.used, 0);
});

test("image generation is refused before any hold, and fits exactly within the limit", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  const probe = await a.agent
    .post("/api/quote")
    .send({ model: IMAGE_MODEL, prompt: "x" })
    .expect(200);
  const price = probe.body.credits;
  await setLimits(a, { daily_limit: price * 2 - 0.0001 }).expect(200);
  await a.agent
    .post("/api/images")
    .send({ model: IMAGE_MODEL, prompt: "One", n: 1 })
    .expect(200);
  const r = await a.agent
    .post("/api/images")
    .send({ model: IMAGE_MODEL, prompt: "Two", n: 1, requestId: "img-2" })
    .expect(402);
  assert.equal(r.body.error.code, "spending_limit");
  assert.equal(holdRow(s, a.user.id + ":img-2"), undefined);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM media WHERE user_id=?").get(a.user.id)
      .n,
    1,
  );
});

// One real listening server and plain fetch, so parallel requests really
// are in flight together on one process, as in production.
async function served(t, s) {
  const server = s.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = "http://127.0.0.1:" + server.address().port;
  return async function signUp() {
    let cookie = "";
    const call = async (path, body, method = "POST") => {
      const r = await fetch(base + path, {
        method,
        headers: {
          "content-type": "application/json",
          cookie,
          "x-forwarded-for": `203.0.113.${++visitor % 250}`,
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      const set = r.headers.get("set-cookie");
      if (set) cookie = set.split(";")[0];
      const type = r.headers.get("content-type") || "";
      return {
        status: r.status,
        body: type.includes("json") ? await r.json() : await r.text(),
      };
    };
    const me = await call("/api/auth/register", {
      username: "u" + randomBytes(4).toString("hex"),
      password: "test-password-long",
    });
    assert.equal(me.status, 201);
    return { call, user: me.body.user };
  };
}

test("concurrent requests can't jointly go over a limit", async (t) => {
  const s = await fixture(t);
  const signUp = await served(t, s);
  const a = await signUp();
  const price = (
    await a.call("/api/quote", { model: IMAGE_MODEL, prompt: "x" })
  ).body.credits;
  assert.equal(
    (await a.call("/api/spending-limits", { daily_limit: price * 3 }, "PATCH"))
      .status,
    200,
  );
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) =>
      a.call("/api/images", {
        model: IMAGE_MODEL,
        prompt: "Race " + i,
        n: 1,
        requestId: "race-" + i,
      }),
    ),
  );
  assert.equal(results.filter((r) => r.status === 200).length, 3);
  assert.equal(
    results.filter(
      (r) => r.status === 402 && r.body.error.code === "spending_limit",
    ).length,
    5,
  );
  assert.equal(limitsView(s.db, a.user.id).daily.used, price * 3);

  // Chats in flight together: every hold counts, so the total never passes.
  const b = await signUp();
  assert.equal(
    (await b.call("/api/chat", { ...say(), requestId: "probe" })).status,
    200,
  );
  const base = holdRow(s, b.user.id + ":probe").amount / s.cfg.holdMargin;
  const spent = limitsView(s.db, b.user.id).daily.used;
  const limit = spent + Math.floor(base * 2.5) / 10000;
  assert.equal(
    (await b.call("/api/spending-limits", { daily_limit: limit }, "PATCH"))
      .status,
    200,
  );
  const chats = await Promise.all(
    Array.from({ length: 6 }, (_, i) =>
      b.call("/api/chat", { ...say("Race " + i), requestId: "chat-" + i }),
    ),
  );
  const admitted = chats.filter((r) => r.status === 200).length;
  const limited = chats.filter(
    (r) => r.status === 402 && r.body.error.code === "spending_limit",
  ).length;
  assert.equal(admitted + limited, 6);
  assert.ok(limited > 0, "some were refused");
  // What was held at once never passed the limit: each admitted request
  // held at least the base estimate, and at most two fit in the room.
  const holds = s.db
    .prepare("SELECT amount FROM holds WHERE user_id=? AND id LIKE ?")
    .all(b.user.id, b.user.id + ":chat-%");
  assert.equal(holds.length, admitted);
  const after = limitsView(s.db, b.user.id).daily;
  assert.ok(after.used <= after.limit, `${after.used} <= ${after.limit}`);
});

test("reservations racing from separate database connections still can't pass a limit", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  await setLimits(a, { daily_limit: 10 }).expect(200);
  const amount = units(1);
  const workers = 6,
    tries = 5;
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const code = `
    const { workerData, parentPort } = require("node:worker_threads");
    (async () => {
      const core = await import(workerData.core);
      const limits = await import(workerData.limits);
      const db = core.database(workerData.db);
      limits.enforceSpendingLimits(db, { released: "all" });
      Atomics.wait(workerData.gate, 0, 0);
      let ok = 0, refused = 0;
      for (let i = 0; i < workerData.tries; i++) {
        try {
          core.reserve(db, { id: workerData.name + ":" + i, user: workerData.user, amount: workerData.amount });
          ok++;
        } catch (e) {
          if (e.code !== "spending_limit") throw e;
          refused++;
        }
      }
      db.close();
      parentPort.postMessage({ ok, refused });
    })().catch((e) => parentPort.postMessage({ error: e.message }));
  `;
  const shared = {
    core: new URL("../server/core.js", import.meta.url).href,
    limits: new URL("../server/spending-limits.js", import.meta.url).href,
    db: join(s.dir, "test.sqlite"),
    user: a.user.id,
    amount,
    tries,
    gate,
  };
  const runs = Array.from({ length: workers }, (_, i) => {
    const w = new Worker(code, {
      eval: true,
      workerData: { ...shared, name: "w" + i },
    });
    return new Promise((resolve, reject) => {
      w.once("message", resolve);
      w.once("error", reject);
    });
  });
  await new Promise((r) => setTimeout(r, 200));
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.error, undefined, r.error);
  assert.equal(
    results.reduce((n, r) => n + r.ok, 0),
    10,
  );
  assert.equal(
    results.reduce((n, r) => n + r.refused, 0),
    workers * tries - 10,
  );
  assert.equal(
    s.db
      .prepare(
        "SELECT SUM(amount) n FROM holds WHERE user_id=? AND status='held'",
      )
      .get(a.user.id).n,
    units(10),
  );
});

test("the account export includes limits, and closing the account removes them", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  await setLimits(a, { daily_limit: 25 }).expect(200);
  await setLimits(a, { daily_limit: 30 }).expect(200);
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.spendingLimits.daily.limit, 25);
  assert.equal(exported.spendingLimits.daily.pending.limit, 30);
  await a.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM spending_limits WHERE user_id=?")
      .get(a.user.id).n,
    0,
  );
});

// The panel compiled for Node with the esbuild Vite uses; ui.jsx is swapped
// for plain stand-ins so only this component's own text is rendered.
async function panelModule() {
  const src = new URL("../src/SpendingLimits.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(
    readFileSync(src, "utf8"),
    src.pathname,
    {
      jsx: "transform",
      format: "esm",
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "anonyma-limits-ui-"));
  writeFileSync(
    join(dir, "ui.mjs"),
    `import React from "${import.meta.resolve("react")}";
     export const Icon = () => null;
     export const Button = ({ children, ...p }) => React.createElement("button", p, children);
     export const Notice = ({ children }) => React.createElement("div", null, children);`,
  );
  const out = code
    .replace(/^import "\.\/spending-limits\.css";$/m, "")
    .replace(
      /from "\.\/ui\.jsx"/g,
      `from "${pathToFileURL(join(dir, "ui.mjs")).href}"`,
    )
    .replace(
      /from "\.\/lib\.js"/g,
      `from "${new URL("../src/lib.js", import.meta.url)}"`,
    )
    .replace(/from "react"/g, `from "${import.meta.resolve("react")}"`);
  const file = join(dir, "SpendingLimits.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

test("every word the panel and its refusals show has a Chinese translation", async () => {
  const dict = compileDictionary(
    JSON.parse(
      readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"),
    ),
  );
  const { SpendingLimits } = await panelModule();
  const html = renderToStaticMarkup(
    createElement(SpendingLimits, { demo: true }),
  );
  const texts = [
    ...html.split(/<[^>]+>/),
    ...[...html.matchAll(/(?:placeholder|aria-label)="([^"]*)"/g)].map(
      (m) => m[1],
    ),
  ]
    .map((s) => entities(s).trim())
    .filter((s) => /[A-Za-z]{2}/.test(s));
  assert.ok(texts.includes("Set the ceiling."));
  assert.ok(
    texts.some((s) => /Rises to 1,500 credits at /.test(s)),
    "the demo shows a pending raise",
  );
  for (const text of texts)
    assert.match(
      translateText(text, dict) ?? "",
      /\p{Script=Han}/u,
      `untranslated: ${text}`,
    );
  // Shown only on a full card, and on the dashboard.
  const at = new Date(Date.UTC(2026, 8, 26, 14, 5)).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
  for (const text of [
    `Room frees up from ${at}.`,
    `No limit from ${at}.`,
    "Daily limit: 17.6 of 50 credits left",
    "Monthly limit: 589 of 1,000 credits left",
    `Daily limit: rises to 80 credits at ${at}, 24 hours from now. You can cancel it until then.`,
    `Monthly limit: removed at ${at}, 24 hours from now. You can cancel it until then.`,
    "Daily limit: 40 credits, in force now.",
    "Monthly limit: pending change cancelled. The current limit stays.",
    "Spending limits",
    "over your spending limit",
  ])
    assert.match(
      translateText(text, dict) ?? "",
      /\p{Script=Han}/u,
      `untranslated: ${text}`,
    );

  // The refusals the browser builds from a 402 spending_limit body.
  const body = (s) => ({
    error: { code: "spending_limit" },
    spending_limit: s,
  });
  const soon = Date.UTC(2026, 8, 26, 14, 5);
  const messages = [
    body({
      limit: "daily",
      limit_credits: 5,
      requested_credits: 2.5,
      remaining_credits: 1,
      held_credits: 0,
      frees_at: soon,
    }),
    body({
      limit: "monthly",
      limit_credits: 5,
      requested_credits: 2.5,
      remaining_credits: 0,
      held_credits: 1,
      frees_at: null,
    }),
    body({
      limit: "monthly",
      limit_credits: 5,
      requested_credits: 9,
      remaining_credits: 3,
      held_credits: 0,
      frees_at: null,
    }),
    body({
      limit: "daily",
      limit_credits: 0,
      requested_credits: 1,
      remaining_credits: 0,
      held_credits: 0,
      frees_at: null,
    }),
  ].map(spendingLimitMessage);
  assert.match(
    messages[0],
    /^This would spend up to 2\.5 credits, more than the 1 credits left of your daily spending limit\. Room frees up at .+\.$/,
  );
  assert.match(
    messages[1],
    /^You've reached your monthly spending limit of 5 credits\. Room frees up as requests in progress finish\.$/,
  );
  assert.match(
    messages[2],
    /more than your whole monthly spending limit of 5 credits\.$/,
  );
  for (const m of messages) {
    const zh = translateText(m, dict);
    assert.match(zh ?? "", /\p{Script=Han}/u, m);
    assert.doesNotMatch(
      zh,
      /spending limit|Room frees/,
      `left in English: ${zh}`,
    );
  }
  assert.equal(
    spendingLimitMessage({ error: { code: "insufficient_credits" } }),
    null,
  );
});
