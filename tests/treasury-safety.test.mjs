import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.js";
import {
  MIGRATIONS,
  balance,
  database,
  migrate,
  reserve,
  release,
  rollbackSchema,
} from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";

// Team Treasury safety: refusals never touch personal funds, contributions
// survive members leaving, no build can orphan a treasury, switching the
// feature off never traps credits, and the migration can be rolled back.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const LIVE = "mvp,collab,treasury";
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-treasury-safety-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function open(t, dir, released = LIVE) {
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released,
    mvpModels: [MODEL],
  });
  let closed = false;
  const close = svc.close;
  svc.close = () => {
    if (!closed) close();
    closed = true;
  };
  t.after(() => svc.close());
  return svc;
}
let visitor = 0;
async function person(app, username) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `203.0.113.${++visitor % 250}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
async function signIn(app, username) {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/password")
    .set("X-Forwarded-For", `203.0.113.${++visitor % 250}`)
    .send({ username, password: "test-password-long" })
    .expect(200);
  return { agent };
}
async function joinCollab(owner, member, id) {
  const { token } = (
    await owner.agent.post(`/api/collabs/${id}/invite`).send({}).expect(200)
  ).body;
  await member.agent.post("/api/collabs/join").send({ token }).expect(200);
}
async function team(s) {
  const ana = await person(s.app, "ana");
  const ben = await person(s.app, "ben");
  const { id } = (
    await ana.agent.post("/api/collabs").send({ name: "Launch team" }).expect(201)
  ).body;
  await joinCollab(ana, ben, id);
  const convo = (
    await ben.agent.post(`/api/collabs/${id}/conversations`).send({ title: "Plan" }).expect(201)
  ).body.id;
  return { ana, ben, id, convo };
}
const units = (c) => Math.round(c * 10000);
const contribute = (p, id, amount, key) =>
  p.agent.post(`/api/collabs/${id}/treasury/contribute`).send({ credits: amount, idempotency_key: key });
const withdraw = (p, id, amount, key) =>
  p.agent.post(`/api/collabs/${id}/treasury/withdraw`).send({ credits: amount, idempotency_key: key });
const accountOf = (db, id) =>
  db.prepare("SELECT account_user_id FROM treasury_accounts WHERE collab_id=?").get(id)?.account_user_id;
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const ledgerTotal = (db) => db.prepare("SELECT COALESCE(SUM(amount),0) n FROM ledger").get().n;

test("a refused team-paid request never touches the member's own balance", async (t) => {
  const s = open(t, tempDir(t));
  const { ana, ben, id, convo } = await team(s);
  const snapshot = () => ({
    balance: balance(s.db, ben.user.id),
    ledger: count(s.db, "SELECT COUNT(*) n FROM ledger WHERE user_id=?", ben.user.id),
    holds: count(s.db, "SELECT COUNT(*) n FROM holds WHERE user_id=?", ben.user.id),
  });
  const teamPaid = () =>
    ben.agent.post("/api/chat").send({
      model: MODEL,
      messages: [{ role: "user", content: "Team idea" }],
      max_tokens: 50,
      conversationId: convo,
      treasury: true,
    });
  const before = snapshot();
  // No treasury yet, then a limit of 0, then an empty treasury: each is
  // refused outright, never retried on the member's own balance.
  assert.equal((await teamPaid().expect(402)).body.error.code, "treasury_insufficient");
  await contribute(ana, id, 10, "seed").expect(201);
  assert.equal((await teamPaid().expect(402)).body.error.code, "treasury_limit");
  await ana.agent.patch(`/api/collabs/${id}/treasury/members/${ben.user.id}`).send({ daily_limit: null }).expect(200);
  await withdraw(ana, id, 10, "empty").expect(201);
  assert.equal((await teamPaid().expect(402)).body.error.code, "treasury_insufficient");
  assert.deepEqual(snapshot(), before);
  assert.equal(count(s.db, "SELECT COUNT(*) n FROM treasury_spends"), 0);
});

test("contributions stay in the treasury when contributors leave, are removed or close their account", async (t) => {
  const s = open(t, tempDir(t));
  const { ana, ben, id } = await team(s);
  const cara = await person(s.app, "cara");
  const dan = await person(s.app, "dan");
  await joinCollab(ana, cara, id);
  await joinCollab(ana, dan, id);
  for (const [p, amount] of [[ben, 30], [cara, 20], [dan, 10]])
    await contribute(p, id, amount, "gift-" + p.user.id).expect(201);
  const account = accountOf(s.db, id);
  const total = ledgerTotal(s.db);
  assert.equal(balance(s.db, account).total, units(60));
  await ben.agent.delete(`/api/collabs/${id}/members/ben`).expect(200);
  await ana.agent.delete(`/api/collabs/${id}/members/cara`).expect(200);
  await dan.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(balance(s.db, account).total, units(60));
  assert.equal(ledgerTotal(s.db), total);
  // The activity still shows who gave what.
  const view = (await ana.agent.get(`/api/collabs/${id}/treasury`).expect(200)).body;
  assert.deepEqual(
    view.activity.filter((a) => a.type === "contribution").map((a) => [a.member, a.credits]).sort(),
    [["Former member", 10], ["ben", 30], ["cara", 20]],
  );
});

test("no build can delete a collab whose treasury still has credits or holds", async (t) => {
  const s = open(t, tempDir(t));
  const { ana, ben, id } = await team(s);
  await contribute(ben, id, 40, "b").expect(201);
  const account = accountOf(s.db, id);
  // What code from before Team Treasury would run: plain deletes, no refund.
  const oldCollabDelete = () => s.db.prepare("DELETE FROM collabs WHERE id=?").run(id);
  const oldOwnerClose = () => s.db.prepare("DELETE FROM collabs WHERE owner_id=?").run(ana.user.id);
  assert.throws(oldCollabDelete, /treasury_not_empty/);
  assert.throws(oldOwnerClose, /treasury_not_empty/);
  await withdraw(ana, id, 39, "most").expect(201);
  reserve(s.db, { id: "inflight", user: account, amount: 1 });
  assert.throws(oldCollabDelete, /treasury_not_empty/);
  release(s.db, "inflight");
  assert.throws(oldCollabDelete, /treasury_not_empty/);
  await withdraw(ana, id, 1, "rest").expect(201);
  oldCollabDelete();
  assert.equal(count(s.db, "SELECT COUNT(*) n FROM collabs WHERE id=?", id), 0);
});

test("switching Team Treasury off keeps existing balances visible and withdrawable", async (t) => {
  const dir = tempDir(t);
  const live = open(t, dir);
  const { ana, ben, id, convo } = await team(live);
  const { id: empty } = (await ana.agent.post("/api/collabs").send({ name: "Quiet" }).expect(201)).body;
  await contribute(ben, id, 25, "b").expect(201);
  live.close();

  const off = open(t, dir, "mvp,collab");
  const owner = await signIn(off.app, "ana");
  const member = await signIn(off.app, "ben");
  const view = (await owner.agent.get(`/api/collabs/${id}/treasury`).expect(200)).body;
  assert.equal(view.paused, true);
  assert.equal(view.balance, 25);
  assert.equal((await member.agent.get(`/api/collabs/${id}/treasury`).expect(200)).body.balance, 25);
  // Everything else about the treasury is off.
  const unreleased = async (req) =>
    assert.equal((await req.expect(403)).body.error.code, "feature_unreleased");
  await unreleased(contribute(member, id, 1, "late"));
  await unreleased(owner.agent.patch(`/api/collabs/${id}/treasury/members/${ben.user.id}`).send({ daily_limit: 1 }));
  await unreleased(
    member.agent.post("/api/chat").send({
      model: MODEL,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
      conversationId: convo,
      treasury: true,
    }),
  );
  await unreleased(owner.agent.get(`/api/collabs/${empty}/treasury`));
  await unreleased(withdraw(owner, empty, 1, "none"));
  // Only the owner withdraws, as when it's on.
  await withdraw(member, id, 1, "steal").expect(403);
  await withdraw(owner, id, 25, "rescue").expect(201);
  assert.equal(balance(off.db, accountOf(off.db, id)).total, 0);
});

test("the gate opens only viewing and withdrawal of a treasury without Team Treasury", () => {
  const needs = (method, path, body = {}) => featuresFor({ method, path, body }).join(",");
  assert.equal(needs("GET", "/api/collabs/c1/treasury"), "collab");
  assert.equal(needs("POST", "/api/collabs/c1/treasury/withdraw"), "collab");
  assert.equal(needs("POST", "/api/collabs/c1/Treasury/Withdraw/"), "collab");
  assert.equal(needs("POST", "/api/collabs/c1/treasury/contribute"), "treasury,collab");
  assert.equal(needs("PATCH", "/api/collabs/c1/treasury/members/u1"), "treasury,collab");
  assert.equal(needs("GET", "/api/collabs/c1/treasury/withdraw"), "treasury,collab");
  assert.ok(needs("POST", "/api/chat", { treasury: true }).includes("treasury"));
});

test("Treasury rollback remains additive and later non-additive migrations cannot be skipped", (t) => {
  const db = database(join(tempDir(t), "latest.sqlite"));
  t.after(() => db.close());
  const latest = MIGRATIONS.length;
  const treasuryVersion = 17; // Released after Holder Program schema16; never renumber.
  assert.ok(db.prepare("SELECT version FROM schema_additive WHERE version=?").get(treasuryVersion));
  db.exec(`PRAGMA user_version=${latest + 1}`);
  db.prepare("INSERT INTO schema_additive(version) VALUES(?)").run(latest + 1);
  migrate(db);
  db.prepare("DELETE FROM schema_additive WHERE version=?").run(latest + 1);
  assert.throws(() => migrate(db), /upgraded by a newer version/);
  db.exec(`PRAGMA user_version=${latest}`);
  assert.throws(() => rollbackSchema(db, treasuryVersion), /aren't all additive/);

  // Build the actual pre-Treasury prefix, preserving the Holder migrations.
  const old = new DatabaseSync(join(tempDir(t), "old.sqlite"));
  t.after(() => old.close());
  old.exec("PRAGMA foreign_keys=ON");
  for (let v = 0; v < treasuryVersion; v++) {
    MIGRATIONS[v](old);
    old.exec(`PRAGMA user_version=${v + 1}`);
  }
  old.prepare("INSERT INTO users(id,created) VALUES('u_x',0)").run();
  old.prepare("INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES('l_x','u_x',5,'test_credit','x',NULL,'x',0)").run();
  assert.throws(() => rollbackSchema(old, treasuryVersion - 2), /aren't all additive/);
  assert.throws(() => rollbackSchema(old, treasuryVersion + 1), /Choose a schema version/);
  assert.deepEqual(rollbackSchema(old, treasuryVersion - 1), { from: treasuryVersion, to: treasuryVersion - 1 });
  migrate(old);
  assert.equal(old.prepare("PRAGMA user_version").get().user_version, latest);
  assert.equal(old.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='treasury_keeps_collab'").get().n, 1);
  assert.equal(balance(old, "u_x").total, 5);
  assert.deepEqual(old.prepare("SELECT version FROM schema_additive ORDER BY version").all().map(r => r.version), db.prepare("SELECT version FROM schema_additive ORDER BY version").all().map(r => r.version));
  assert.equal(old.prepare("PRAGMA foreign_key_check").all().length, 0);
});


test("team quotes match standard-rate holds, expose only authorized spendable funds and write nothing", async (t) => {
  const s = open(t, tempDir(t));
  const { ana, ben, id, convo } = await team(s);
  s.cfg.markup = 50;
  const stranger = await person(s.app, "stranger");
  await contribute(ana, id, 1000, "quote-fund").expect(201);
  await ana.agent.patch(`/api/collabs/${id}/treasury/members/${ben.user.id}`)
    .send({daily_limit: 50, monthly_limit: 100}).expect(200);
  s.db.prepare("UPDATE users SET token_balance=? WHERE id=?").run("1000000000",ben.user.id);
  const snapshot = () => ({
    treasury:balance(s.db,accountOf(s.db,id)), personal:balance(s.db,ben.user.id),
    ledger:count(s.db,"SELECT COUNT(*) n FROM ledger"), holds:count(s.db,"SELECT COUNT(*) n FROM holds"),
    spends:count(s.db,"SELECT COUNT(*) n FROM treasury_spends"),
  });
  const before=snapshot();
  const body={model:MODEL,messages:[{role:"user",content:"Team idea"}],max_tokens:50,conversationId:convo,treasury:true};
  const q=await ben.agent.post("/api/quote").send(body).expect(200);
  assert.equal(q.body.available,50);
  const personal=await ben.agent.post("/api/quote").send({...body,treasury:false}).expect(200);
  assert.ok(q.body.credits>personal.body.credits,"team quote ignores member discount");
  await stranger.agent.post("/api/quote").send(body).expect(404);
  assert.deepEqual(snapshot(),before,"quoting never creates holds, ledger or spend records");
  const requestId="quote-team-alignment";
  await ben.agent.post("/api/chat").send({...body,requestId}).expect(200);
  const hold=s.db.prepare("SELECT * FROM holds WHERE id=?").get(ben.user.id+":"+requestId);
  assert.equal(hold.user_id,accountOf(s.db,id));
  assert.equal(hold.amount,Math.ceil(units(q.body.credits)*s.cfg.holdMargin));
  assert.deepEqual(balance(s.db,ben.user.id),before.personal);
});


test("team request recovery remains requester-only across hold states and member removal does not erase team totals", async (t) => {
  const s = open(t, tempDir(t));
  const {ana,ben,id,convo}=await team(s);
  await contribute(ana,id,1000,"recovery-fund").expect(201);
  await ana.agent.patch(`/api/collabs/${id}/treasury/members/${ben.user.id}`).send({daily_limit:100}).expect(200);
  const requestId="team-recover";
  await ben.agent.post("/api/chat").send({model:MODEL,messages:[{role:"user",content:"Idea"}],max_tokens:50,conversationId:convo,treasury:true,requestId}).expect(200);
  const recovered=await ben.agent.get("/api/requests/"+requestId).expect(200);
  assert.equal(recovered.body.status,"settled");assert.ok(recovered.body.receipt.charged>0);
  await ana.agent.get("/api/requests/"+requestId).expect(404);
  await ana.agent.get("/api/requests/"+encodeURIComponent(ben.user.id+":"+requestId)).expect(404);
  const account=accountOf(s.db,id),pending=ben.user.id+":team-pending";
  reserve(s.db,{id:pending,user:account,amount:100});
  s.db.prepare("INSERT INTO treasury_spends(hold_id,collab_id,user_id,model,created) VALUES(?,?,?,?,?)").run(pending,id,ben.user.id,MODEL,Date.now());
  assert.equal((await ben.agent.get("/api/requests/team-pending").expect(200)).body.status,"held");
  await ana.agent.get("/api/requests/team-pending").expect(404);
  release(s.db,pending);
  assert.equal((await ben.agent.get("/api/requests/team-pending").expect(200)).body.status,"released");
  const before=(await ana.agent.get(`/api/collabs/${id}/treasury`).expect(200)).body;
  assert.ok(before.monthly_used>0);
  await ana.agent.delete(`/api/collabs/${id}/members/ben`).expect(200);
  const after=(await ana.agent.get(`/api/collabs/${id}/treasury`).expect(200)).body;
  assert.equal(after.monthly_used,before.monthly_used);
  assert.ok(after.activity.some(a=>a.type==="spend"&&a.status==="charged"));
  await ben.agent.get(`/api/collabs/${id}/treasury`).expect(404);
  // Recovery of your own past charge remains available after leaving.
  assert.equal((await ben.agent.get("/api/requests/"+requestId).expect(200)).body.status,"settled");
});
