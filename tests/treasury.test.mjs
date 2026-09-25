import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import {
  addCredit,
  balance,
  credits,
  hash,
  now,
  reserve,
  release,
} from "../server/core.js";
import { UPDATES, featuresFor, parseReleased } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const LIVE = "mvp,collab,treasury";
function fixture(t, released = LIVE, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-treasury-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released,
    mvpModels: [MODEL],
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function mockServer(t, handler) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  return "http://127.0.0.1:" + s.address().port;
}
let visitor = 0;
async function person(app, username) {
  const agent = request.agent(app);
  // Each person signs up from their own address, as real visitors would.
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor % 250}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
// Ana owns a collab Ben has joined, with one shared conversation.
async function team(s) {
  const ana = await person(s.app, "ana");
  const ben = await person(s.app, "ben");
  const { id } = (
    await ana.agent.post("/api/collabs").send({ name: "Launch team" }).expect(201)
  ).body;
  const { token } = (
    await ana.agent.post(`/api/collabs/${id}/invite`).send({}).expect(200)
  ).body;
  await ben.agent.post("/api/collabs/join").send({ token }).expect(200);
  const convo = (
    await ben.agent
      .post(`/api/collabs/${id}/conversations`)
      .send({ title: "Plan" })
      .expect(201)
  ).body.id;
  return { ana, ben, id, token, convo };
}
const units = (c) => Math.round(c * 10000);
const say = (text, extra = {}) => ({
  model: MODEL,
  messages: [{ role: "user", content: text }],
  max_tokens: 50,
  ...extra,
});
const contribute = (p, id, amount, key) =>
  p.agent
    .post(`/api/collabs/${id}/treasury/contribute`)
    .send({ credits: amount, idempotency_key: key });
const withdraw = (p, id, amount, key) =>
  p.agent
    .post(`/api/collabs/${id}/treasury/withdraw`)
    .send({ credits: amount, idempotency_key: key });
const setLimits = (owner, id, member, body) =>
  owner.agent
    .patch(`/api/collabs/${id}/treasury/members/${member.user.id}`)
    .send(body);
const accountOf = (s, id) =>
  s.db
    .prepare("SELECT account_user_id FROM treasury_accounts WHERE collab_id=?")
    .get(id)?.account_user_id;
// Transfers move credits; they never create or destroy them.
const ledgerTotal = (s) =>
  s.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM ledger").get().n;
const count = (s, sql, ...args) => s.db.prepare(sql).get(...args).n;

test("Team Treasury is registered and needs both treasury and collab released", async (t) => {
  const entry = UPDATES.find((u) => u.id === "treasury");
  assert.equal(entry.title, "Team Treasury");
  assert.equal(entry.tagline, "One balance for the whole team.");
  assert.equal(entry.points.length, 3);
  const refused = async (res, title) => {
    const r = await res.expect(403);
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.equal(r.body.error.message, `${title} is coming soon.`);
  };
  // Gated in featuresFor's array style: treasury routes and a team-paid
  // chat need "treasury" and "collab"; other collab routes need collab only.
  // Viewing a treasury and withdrawing need only collab, so switching Team
  // Treasury off never traps credits (the route refuses collabs without one;
  // see treasury-safety.test.mjs).
  const gates = (path, method = "GET", body = {}) =>
    featuresFor({ path, method, body });
  assert.deepEqual(gates("/api/collabs/c1/treasury"), ["collab"]);
  assert.deepEqual(gates("/api/collabs/c1/treasury/withdraw", "POST"), ["collab"]);
  assert.deepEqual(
    gates("/API/Collabs/c1/Treasury/contribute", "POST"),
    ["treasury", "collab"],
  );
  assert.deepEqual(gates("/api/collabs/c1"), ["collab"]);
  assert.deepEqual(gates("/api/collabs/c1/treasuryx"), ["collab"]);
  assert.deepEqual(gates("/api/chat", "POST", { treasury: true }), [
    "treasury",
    "collab",
  ]);
  assert.deepEqual(
    gates("/api/chat", "POST", { mode: "code", web_search: true, treasury: true }),
    ["code", "search", "treasury", "collab"],
  );
  assert.deepEqual(gates("/api/chat", "POST", { treasury: "yes" }), []);
  assert.deepEqual(gates("/api/conversations", "POST", { treasury: true }), []);
  // The API document lists the treasury routes only once both are live.
  const listed = (released) =>
    Object.keys(
      openapiForConfig({ released: parseReleased(released) }).paths,
    ).filter((p) => p.includes("/treasury"));
  assert.deepEqual(listed("mvp,collab"), []);
  assert.deepEqual(listed("mvp,treasury"), []);
  assert.equal(listed("mvp,collab,treasury").length, 4);

  const id = "collab_" + "0".repeat(32);
  for (const [released, title] of [
    ["mvp", "Team Treasury"],
    ["mvp,collab", "Team Treasury"],
    ["mvp,treasury", "Collab"],
  ]) {
    const s = fixture(t, released);
    const a = await person(s.app, "tester");
    // Viewing and withdrawing need only Collab; with it on they reach the
    // route, which refuses a collab this person isn't in.
    if (released === "mvp,collab") {
      await a.agent.get(`/api/collabs/${id}/treasury`).expect(404);
      await withdraw(a, id, 1, "k").expect(404);
    } else {
      await refused(a.agent.get(`/api/collabs/${id}/treasury`), "Collab");
      await refused(withdraw(a, id, 1, "k"), "Collab");
    }
    await refused(contribute(a, id, 1, "k"), title);
    await refused(
      a.agent
        .patch(`/api/collabs/${id}/treasury/members/${a.user.id}`)
        .send({ daily_limit: 1 }),
      title,
    );
    await refused(a.agent.post("/api/chat").send(say("hi", { treasury: true })), title);
    // Chat without the flag is unchanged.
    await a.agent.post("/api/chat").send(say("hi")).expect(200);
  }
  // A team-paid code chat needs the treasury too, not only Code & Build.
  const coded = fixture(t, "mvp,code,collab");
  const c = await person(coded.app, "coder");
  await refused(
    c.agent.post("/api/chat").send(say("hi", { mode: "code", treasury: true })),
    "Team Treasury",
  );

  const s = fixture(t, LIVE);
  const { ana, id: live } = await team(s);
  const view = (await ana.agent.get(`/api/collabs/${live}/treasury`).expect(200))
    .body;
  assert.equal(view.balance, 0);
  assert.deepEqual(view.activity, []);
  const info = (await request(s.app).get("/api/config").expect(200)).body.releases;
  assert.equal(info.features.treasury, true);
  assert.equal(info.updates.find((u) => u.id === "treasury").released, true);
});

test("contributions and withdrawals are atomic, idempotent transfers that can't overdraw", async (t) => {
  const s = fixture(t);
  const { ana, ben, id } = await team(s);
  const total = ledgerTotal(s);
  const anaBefore = balance(s.db, ana.user.id).total;

  const first = await contribute(ana, id, 500, "first").expect(201);
  assert.equal(first.body.balance, 500);
  const account = accountOf(s, id);
  assert.equal(balance(s.db, account).total, units(500));
  assert.equal(balance(s.db, ana.user.id).total, anaBefore - units(500));
  const pair = s.db
    .prepare("SELECT user_id, amount, kind FROM ledger WHERE ref LIKE ? ORDER BY amount")
    .all(first.body.id + ":%")
    .map((e) => [e.user_id, e.amount, e.kind]);
  assert.deepEqual(pair, [
    [ana.user.id, -units(500), "treasury_contribution"],
    [account, units(500), "treasury_contribution"],
  ]);
  assert.equal(ledgerTotal(s), total);

  // A retry with the same key doesn't apply twice.
  const again = await contribute(ana, id, 500, "first").expect(200);
  assert.equal(again.body.id, first.body.id);
  assert.equal(balance(s.db, account).total, units(500));
  const conflict = await contribute(ana, id, 400, "first").expect(409);
  assert.equal(conflict.body.error.code, "idempotency_conflict");
  // The Idempotency-Key header works the same way.
  for (const status of [201, 200])
    await ana.agent
      .post(`/api/collabs/${id}/treasury/contribute`)
      .set("Idempotency-Key", "header-key")
      .send({ credits: 1.5 })
      .expect(status);
  assert.equal(balance(s.db, account).total, units(501.5));

  // Invalid requests move nothing.
  await ana.agent
    .post(`/api/collabs/${id}/treasury/contribute`)
    .send({ credits: 5 })
    .expect(400);
  for (const amount of [0, -5, 0.5, 1.00001, "10", null, true, 2_000_000])
    await contribute(ana, id, amount, "bad").expect(400);
  // Can't contribute more than is available.
  const benBefore = balance(s.db, ben.user.id).total;
  const over = await contribute(
    ben,
    id,
    credits(balance(s.db, ben.user.id).available) + 1,
    "over",
  ).expect(402);
  assert.equal(over.body.error.code, "insufficient_credits");
  assert.equal(balance(s.db, ben.user.id).total, benBefore);

  // Only the owner withdraws, back to their own balance, and never more than
  // is available.
  await withdraw(ben, id, 1, "ben-w").expect(403);
  const tooMuch = await withdraw(ana, id, 502, "w1").expect(402);
  assert.equal(tooMuch.body.error.code, "treasury_insufficient");
  const anaMid = balance(s.db, ana.user.id).total;
  const w = await withdraw(ana, id, 200, "w2").expect(201);
  assert.equal(w.body.balance, 301.5);
  await withdraw(ana, id, 200, "w2").expect(200);
  assert.equal(balance(s.db, account).total, units(301.5));
  assert.equal(balance(s.db, ana.user.id).total, anaMid + units(200));
  // Credits held by a request in flight can't be withdrawn.
  reserve(s.db, { id: ben.user.id + ":held", user: account, amount: units(300) });
  const held = await withdraw(ana, id, 2, "w3").expect(402);
  assert.equal(held.body.error.code, "treasury_insufficient");
  release(s.db, ben.user.id + ":held");
  assert.equal(ledgerTotal(s), total);

  // A failure between the two entries leaves nothing behind.
  s.db.exec(
    "CREATE TEMP TRIGGER fail_treasury_in BEFORE INSERT ON ledger WHEN NEW.kind='treasury_contribution' AND NEW.amount>0 BEGIN SELECT RAISE(ABORT,'injected failure'); END",
  );
  const benMid = balance(s.db, ben.user.id).total;
  await contribute(ben, id, 50, "atomic").expect(500);
  s.db.exec("DROP TRIGGER fail_treasury_in");
  assert.equal(balance(s.db, ben.user.id).total, benMid);
  assert.equal(balance(s.db, account).total, units(301.5));
  await contribute(ben, id, 50, "atomic").expect(201);
  assert.equal(balance(s.db, account).total, units(351.5));
  assert.equal(ledgerTotal(s), total);
});

test("only members see or fund a treasury, and only the owner withdraws or sets limits", async (t) => {
  const s = fixture(t);
  const { ana, ben, id } = await team(s);
  const eve = await person(s.app, "eve");
  await contribute(ana, id, 100, "seed").expect(201);

  await eve.agent.get(`/api/collabs/${id}/treasury`).expect(404);
  await contribute(eve, id, 10, "eve").expect(404);
  await withdraw(eve, id, 10, "eve").expect(404);
  await setLimits(eve, id, eve, { daily_limit: 10 }).expect(404);
  await setLimits(ben, id, ben, { daily_limit: 10 }).expect(403);
  await withdraw(ben, id, 1, "ben").expect(403);
  await setLimits(ana, id, eve, { daily_limit: 10 }).expect(404);

  await contribute(ben, id, 25, "ben").expect(201);
  const view = (await ben.agent.get(`/api/collabs/${id}/treasury`).expect(200))
    .body;
  assert.equal(view.balance, 125);
  assert.equal(view.available, 125);
  assert.deepEqual(
    view.activity.map((a) => [a.type, a.member, a.credits]),
    [
      ["contribution", "ben", 25],
      ["contribution", "ana", 100],
    ],
  );
  // Members start unable to spend; the owner isn't limited unless they choose.
  assert.equal(view.you.username, "ben");
  assert.deepEqual([view.you.daily_limit, view.you.monthly_limit], [0, null]);
  const owner = view.members.find((m) => m.role === "owner");
  assert.deepEqual([owner.daily_limit, owner.monthly_limit], [null, null]);

  // Omitted fields keep their value; null is no limit.
  let set = (await setLimits(ana, id, ben, { daily_limit: 100 }).expect(200)).body;
  assert.deepEqual([set.daily_limit, set.monthly_limit], [100, null]);
  set = (await setLimits(ana, id, ben, { monthly_limit: 2500.5 }).expect(200)).body;
  assert.deepEqual([set.daily_limit, set.monthly_limit], [100, 2500.5]);
  set = (await setLimits(ana, id, ben, { monthly_limit: null }).expect(200)).body;
  assert.deepEqual([set.daily_limit, set.monthly_limit], [100, null]);
  for (const bad of [-1, "5", 0.00001, 2e9])
    await setLimits(ana, id, ben, { daily_limit: bad }).expect(400);
});

test("a team-paid chat charges the treasury once, and only within the member's limits", async (t) => {
  const s = fixture(t);
  const { ana, ben, id, convo } = await team(s);
  await contribute(ana, id, 500, "seed").expect(201);
  const account = accountOf(s, id);
  const benBefore = balance(s.db, ben.user.id).total;
  const teamPaid = (text, extra = {}) =>
    ben.agent
      .post("/api/chat")
      .send(say(text, { conversationId: convo, treasury: true, ...extra }));

  // Refused until the owner allows it; nothing is held or recorded.
  const locked = await teamPaid("Team idea").expect(402);
  assert.equal(locked.body.error.code, "treasury_limit");
  assert.equal(balance(s.db, account).held, 0);
  assert.equal(count(s, "SELECT COUNT(*) n FROM treasury_spends"), 0);

  await setLimits(ana, id, ben, { daily_limit: 100, monthly_limit: 1000 }).expect(200);
  const before = balance(s.db, account).total;
  const r = await teamPaid("Team idea", { requestId: "team-1" }).expect(200);
  const hold = s.db
    .prepare("SELECT * FROM holds WHERE id=?")
    .get(ben.user.id + ":team-1");
  assert.equal(hold.user_id, account);
  assert.equal(hold.status, "settled");
  const charges = s.db.prepare("SELECT * FROM ledger WHERE ref=?").all(hold.id);
  assert.equal(charges.length, 1);
  assert.equal(charges[0].user_id, account);
  assert.ok(charges[0].amount < 0);
  const charged = credits(-charges[0].amount);
  assert.match(r.text, new RegExp(`"credits_charged":${charged}\\b`));
  assert.equal(balance(s.db, account).total, before + charges[0].amount);
  assert.equal(balance(s.db, account).held, 0);
  assert.equal(balance(s.db, ben.user.id).total, benBefore);

  // Resubmitting the same request is refused, not charged again.
  const dup = await teamPaid("Team idea", { requestId: "team-1" }).expect(409);
  assert.equal(dup.body.error.code, "duplicate_request");
  assert.equal(count(s, "SELECT COUNT(*) n FROM ledger WHERE ref=?", hold.id), 1);

  // Everyone sees the spend; it counts toward Ben's usage.
  const view = (await ana.agent.get(`/api/collabs/${id}/treasury`).expect(200))
    .body;
  const spend = view.activity.find((a) => a.type === "spend");
  assert.deepEqual(
    [spend.member, spend.model, spend.status, spend.credits],
    ["ben", MODEL, "charged", charged],
  );
  const benView = view.members.find((m) => m.username === "ben");
  assert.equal(benView.daily_used, charged);
  assert.equal(benView.monthly_used, charged);
  const thread = (await ana.agent.get(`/api/conversations/${convo}`).expect(200))
    .body;
  assert.equal(thread.messages.filter((m) => m.role === "assistant").length, 1);

  // Without Team pays (or with anything but true), members pay as before.
  await ben.agent
    .post("/api/chat")
    .send(say("My own", { conversationId: convo }))
    .expect(200);
  await ben.agent
    .post("/api/chat")
    .send(say("Also mine", { conversationId: convo, treasury: "yes" }))
    .expect(200);
  assert.ok(balance(s.db, ben.user.id).total < benBefore);
  assert.equal(balance(s.db, account).total, before + charges[0].amount);

  // Only collab conversations can be team-paid.
  const personal = await ben.agent
    .post("/api/chat")
    .send(say("hi", { treasury: true }))
    .expect(400);
  assert.equal(personal.body.error.code, "treasury_unavailable");

  // The monthly limit is enforced on its own too.
  await setLimits(ana, id, ben, { daily_limit: null, monthly_limit: charged }).expect(200);
  const monthly = await teamPaid("More").expect(402);
  assert.equal(monthly.body.error.code, "treasury_limit");
  assert.equal(
    monthly.body.error.message,
    "You've reached your monthly team spending limit.",
  );

  // An empty treasury refuses rather than charging the member.
  await setLimits(ana, id, ben, { monthly_limit: null }).expect(200);
  await withdraw(ana, id, credits(balance(s.db, account).available), "empty").expect(201);
  const empty = await teamPaid("Broke").expect(402);
  assert.equal(empty.body.error.code, "treasury_insufficient");
});

test("a team-paid chat is charged the standard rate, whatever the member holds", async (t) => {
  const s = fixture(t, LIVE, { markup: 50 });
  const { ana, ben, id, convo } = await team(s);
  await contribute(ana, id, 500, "seed").expect(201);
  await setLimits(ana, id, ben, { daily_limit: null }).expect(200);
  const charge = async (requestId, treasury) => {
    await ben.agent
      .post("/api/chat")
      .send(
        say("The same prompt each time", {
          conversationId: convo,
          requestId,
          ...(treasury ? { treasury: true } : {}),
        }),
      )
      .expect(200);
    return -s.db
      .prepare("SELECT amount FROM ledger WHERE ref=?")
      .get(ben.user.id + ":" + requestId).amount;
  };
  const standard = await charge("standard", true);
  assert.ok(standard > 0);
  s.db
    .prepare("UPDATE users SET token_balance=? WHERE id=?")
    .run(40000000, ben.user.id);
  // Teammates see every team spend, so it can't reflect Ben's own rate;
  // his own requests still get whatever his account is due.
  assert.equal(await charge("held", true), standard);
  assert.ok((await charge("own", false)) < standard);
});

test("limits count held requests, so concurrent team-paid chats can't pass them", async (t) => {
  const s = fixture(t);
  const { ana, ben, id, convo } = await team(s);
  await contribute(ana, id, 5000, "seed").expect(201);
  await setLimits(ana, id, ben, { daily_limit: null, monthly_limit: null }).expect(200);
  // A generous output limit keeps each estimate above the fixture's cost.
  const ask = (requestId) =>
    ben.agent.post("/api/chat").send(
      say("The same prompt every time", {
        conversationId: convo,
        treasury: true,
        requestId,
        max_tokens: 400,
      }),
    );
  // With room to spare the hold includes headroom over the estimate.
  await ask("probe").expect(200);
  const probe = s.db
    .prepare("SELECT amount FROM holds WHERE id=?")
    .get(ben.user.id + ":probe").amount;
  const estimate = probe / s.cfg.holdMargin;
  assert.ok(Number.isSafeInteger(estimate) && estimate > 0);
  const spent = -s.db
    .prepare("SELECT amount FROM ledger WHERE ref=?")
    .get(ben.user.id + ":probe").amount;

  // Room for one more request at the estimate: not the headroom, not two.
  const cap = spent + Math.floor(estimate * 1.5);
  await setLimits(ana, id, ben, { daily_limit: cap / 10000 }).expect(200);
  const results = await Promise.all(["c1", "c2", "c3"].map(ask));
  const statuses = results.map((r) => r.status).sort();
  assert.deepEqual(statuses, [200, 402, 402]);
  for (const r of results.filter((r) => r.status === 402)) {
    assert.equal(r.body.error.code, "treasury_limit");
    // What's left is less than one request's worst case, and it says so.
    assert.match(
      r.body.error.message,
      /^This request could cost up to [\d.]+ credits, more than the [\d.]+ left of your daily team spending limit\.$/,
    );
  }
  const held = s.db
    .prepare(
      "SELECT h.amount FROM treasury_spends t JOIN holds h ON h.id=t.hold_id WHERE t.user_id=? AND h.id!=?",
    )
    .all(ben.user.id, ben.user.id + ":probe")
    .map((h) => h.amount);
  assert.deepEqual(held, [estimate]);
  const you = (await ben.agent.get(`/api/collabs/${id}/treasury`).expect(200))
    .body.you;
  assert.ok(units(you.daily_used) <= cap);

  // A reservation still in flight counts until it finishes.
  await setLimits(ana, id, ben, { daily_limit: null }).expect(200);
  const account = accountOf(s, id);
  const busy = ben.user.id + ":busy";
  reserve(s.db, { id: busy, user: account, amount: units(100) });
  s.db
    .prepare(
      "INSERT INTO treasury_spends(hold_id,collab_id,user_id,model,created) VALUES(?,?,?,?,?)",
    )
    .run(busy, id, ben.user.id, MODEL, now());
  const used = (await ben.agent.get(`/api/collabs/${id}/treasury`).expect(200))
    .body.you.daily_used;
  await setLimits(ana, id, ben, { daily_limit: used }).expect(200);
  await ask("blocked").expect(402);
  release(s.db, busy);
  await ask("allowed").expect(200);
});

test("a failed team-paid chat releases its hold back to the treasury", async (t) => {
  const gateway = await mockServer(t, (req, res) => {
    req.resume();
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Upstream failure" } }));
  });
  const s = fixture(t, LIVE, { testMode: false, gateway, gatewayKey: "fixture" });
  const { ana, ben, id, convo } = await team(s);
  addCredit(s.db, ana.user.id, units(1000), "treasury-test-fund");
  await contribute(ana, id, 500, "seed").expect(201);
  await setLimits(ana, id, ben, { daily_limit: 100 }).expect(200);
  const account = accountOf(s, id);

  const r = await ben.agent
    .post("/api/chat")
    .send(say("hi", { conversationId: convo, treasury: true, requestId: "fails" }))
    .expect(200);
  assert.match(r.text, /"error"/);
  const hold = s.db
    .prepare("SELECT * FROM holds WHERE id=?")
    .get(ben.user.id + ":fails");
  assert.equal(hold.user_id, account);
  assert.equal(hold.status, "released");
  assert.equal(count(s, "SELECT COUNT(*) n FROM ledger WHERE ref=?", hold.id), 0);
  assert.deepEqual(
    [balance(s.db, account).total, balance(s.db, account).held],
    [units(500), 0],
  );
  const view = (await ben.agent.get(`/api/collabs/${id}/treasury`).expect(200))
    .body;
  const spend = view.activity.find((a) => a.type === "spend");
  assert.deepEqual([spend.status, spend.credits], ["released", 0]);
  assert.equal(view.you.daily_used, 0);
});

test("deleting a collab returns the treasury to its owner", async (t) => {
  const s = fixture(t);
  const { ana, ben, id } = await team(s);
  await contribute(ana, id, 300, "a").expect(201);
  await contribute(ben, id, 200, "b").expect(201);
  await setLimits(ana, id, ben, { daily_limit: 100 }).expect(200);
  const account = accountOf(s, id);
  const anaBefore = balance(s.db, ana.user.id).total;
  const total = ledgerTotal(s);

  // Not while a team-paid request still holds treasury credits.
  reserve(s.db, { id: ben.user.id + ":inflight", user: account, amount: units(10) });
  const busy = await ana.agent.delete(`/api/collabs/${id}`).expect(409);
  assert.equal(busy.body.error.code, "treasury_busy");
  assert.equal(count(s, "SELECT COUNT(*) n FROM collabs WHERE id=?", id), 1);
  release(s.db, ben.user.id + ":inflight");

  await ana.agent.delete(`/api/collabs/${id}`).expect(200);
  assert.equal(count(s, "SELECT COUNT(*) n FROM collabs WHERE id=?", id), 0);
  assert.equal(balance(s.db, account).total, 0);
  assert.equal(balance(s.db, ana.user.id).total, anaBefore + units(500));
  assert.equal(ledgerTotal(s), total);
  assert.deepEqual(
    s.db
      .prepare("SELECT user_id, amount FROM ledger WHERE kind='treasury_return' ORDER BY amount")
      .all()
      .map((e) => [e.user_id, e.amount]),
    [
      [account, -units(500)],
      [ana.user.id, units(500)],
    ],
  );
  assert.equal(count(s, "SELECT COUNT(*) n FROM treasury_members"), 0);
});

test("an owner can't close their account while their treasury holds credits", async (t) => {
  const s = fixture(t);
  const { ana, ben, id } = await team(s);
  await contribute(ben, id, 200, "b").expect(201);
  const account = accountOf(s, id);
  const total = ledgerTotal(s);
  const close = () => ana.agent.delete("/api/account").send({ confirm: "DELETE" });
  const refused = async (code, held, message) => {
    const r = await close().expect(409);
    assert.equal(r.body.error.code, code);
    if (message) assert.equal(r.body.error.message, message);
    // Nothing moved and nothing closed: the collab and Ben's credits remain.
    await ana.agent.get(`/api/collabs/${id}/treasury`).expect(200);
    assert.equal(balance(s.db, account).total, units(held));
    assert.equal(ledgerTotal(s), total);
    assert.equal(count(s, "SELECT COUNT(*) n FROM ledger WHERE kind='treasury_return'"), 0);
  };

  reserve(s.db, { id: ben.user.id + ":inflight", user: account, amount: units(5) });
  await refused("treasury_busy", 200);
  release(s.db, ben.user.id + ":inflight");
  await refused(
    "treasury_not_empty",
    200,
    "A collab you own still has 200 credits in its team treasury. Withdraw or spend them before closing your account.",
  );
  await withdraw(ana, id, 199, "most").expect(201);
  await refused(
    "treasury_not_empty",
    1,
    "A collab you own still has 1 credit in its team treasury. Withdraw or spend them before closing your account.",
  );

  // Once it's empty the account closes and the collab goes with it.
  await withdraw(ana, id, 1, "rest").expect(201);
  await close().expect(200);
  assert.equal(count(s, "SELECT COUNT(*) n FROM collabs WHERE id=?", id), 0);
  assert.equal(balance(s.db, account).total, 0);
  assert.equal(ledgerTotal(s), total);

  // A member closing their own account isn't held up by the treasury.
  const t2 = fixture(t);
  const other = await team(t2);
  await contribute(other.ben, other.id, 50, "b").expect(201);
  await other.ben.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(balance(t2.db, accountOf(t2, other.id)).total, units(50));
});

test("a contribution is refused while the contributor has a payment under reconciliation", async (t) => {
  // Gift Credits too, to compare the refusals.
  const s = fixture(t, LIVE + ",social");
  const { ana, ben, id } = await team(s);
  const total = ledgerTotal(s);
  const benBefore = balance(s.db, ben.user.id).total;
  s.db
    .prepare(
      "INSERT INTO deposits(id,user_id,provider_id,amount,currency,status,payload,credited,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run("dep_disputed", ben.user.id, "p_disputed", 1, "usd", "reconciliation", "{}", 1, now(), now());

  // The same check, code and message as Gift Credits.
  const r = await contribute(ben, id, 10, "disputed").expect(409);
  assert.equal(r.body.error.code, "payment_reconciliation_pending");
  const gift = await ben.agent
    .post("/api/credits/send")
    .send({ to: "ana", amount: 10, requestId: "gift" })
    .expect(409);
  assert.deepEqual(r.body.error, gift.body.error);
  assert.equal(accountOf(s, id), undefined);
  assert.equal(balance(s.db, ben.user.id).total, benBefore);
  assert.equal(ledgerTotal(s), total);
  // Other members are unaffected.
  await contribute(ana, id, 10, "clean").expect(201);

  // Once the payment is confirmed, the same request goes through.
  s.db.prepare("UPDATE deposits SET status='confirmed' WHERE id=?").run("dep_disputed");
  await contribute(ben, id, 10, "disputed").expect(201);
  assert.equal(balance(s.db, accountOf(s, id)).total, units(20));
});

test("a member's limit goes when they leave, are removed or close their account", async (t) => {
  const s = fixture(t);
  const { ana, ben, id, token } = await team(s);
  await setLimits(ana, id, ben, { daily_limit: 100 }).expect(200);
  await ana.agent.delete(`/api/collabs/${id}/members/ben`).expect(200);
  assert.equal(count(s, "SELECT COUNT(*) n FROM treasury_members"), 0);
  await ben.agent.get(`/api/collabs/${id}/treasury`).expect(404);

  // Rejoining starts from no allowance again.
  await ben.agent.post("/api/collabs/join").send({ token }).expect(200);
  const view = (await ben.agent.get(`/api/collabs/${id}/treasury`).expect(200))
    .body;
  assert.equal(view.you.daily_limit, 0);

  await setLimits(ana, id, ben, { daily_limit: 50 }).expect(200);
  await ben.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(count(s, "SELECT COUNT(*) n FROM treasury_members"), 0);
});

test("the treasury account can't sign in and never appears in user lists", async (t) => {
  const s = fixture(t);
  const { ana, id } = await team(s);
  await contribute(ana, id, 100, "a").expect(201);
  const account = accountOf(s, id);
  const row = s.db.prepare("SELECT * FROM users WHERE id=?").get(account);
  assert.deepEqual(
    [row.username, row.password, row.email, row.wallet, row.referral_code],
    [null, null, null, null, null],
  );
  assert.ok(row.deleted, "created already tombstoned");

  // Even a forged session for it signs nobody in.
  s.db
    .prepare("INSERT INTO sessions(hash,user_id,expires,created) VALUES(?,?,?,?)")
    .run(hash("forged-session"), account, now() + 60000, now());
  const me = await request(s.app)
    .get("/api/me")
    .set("Cookie", "anonyma_session=forged-session")
    .expect(200);
  assert.equal(me.body.user, null);
  await request(s.app)
    .post("/api/auth/password")
    .send({ username: account, password: "test-password-long" })
    .expect(401);

  const collab = (await ana.agent.get(`/api/collabs/${id}`).expect(200)).body;
  assert.deepEqual(
    collab.members.map((m) => m.username),
    ["ana", "ben"],
  );
  const treasury = (await ana.agent.get(`/api/collabs/${id}/treasury`).expect(200))
    .body;
  assert.ok(!treasury.members.some((m) => m.id === account));
  await ana.agent
    .patch(`/api/collabs/${id}/treasury/members/${account}`)
    .send({ daily_limit: 1 })
    .expect(404);
});
