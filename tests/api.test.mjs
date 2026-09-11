import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHmac } from "node:crypto";
import { Wallet } from "ethers";
import { createApp } from "../server/app.js";
import {
  balance,
  credits,
  reserve,
  settle,
  release,
  addCredit,
  now,
  uid,
  usdUnits,
} from "../server/core.js";
import { canonical } from "../server/auth.js";
const chatModel = "google/gemini-2.5-flash",
  imageModel = "google/gemini-2.5-flash-image";
const prompt = {
  model: chatModel,
  messages: [{ role: "user", content: "Hello test" }],
  max_tokens: 50,
};
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-test-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function register(app, name = "tester") {
  const agent = request.agent(app);
  const result = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return { agent, user: result.body.user };
}
async function keyFor(agent, cap = null) {
  return (
    await agent.post("/api/keys").send({ name: "integration", cap }).expect(201)
  ).body;
}
async function mockServer(t, handler) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  return "http://127.0.0.1:" + s.address().port;
}
async function readJSON(req) {
  let s = "";
  for await (const b of req) s += b;
  return JSON.parse(s || "{}");
}
function event(res, p) {
  res.write("data: " + JSON.stringify(p) + "\n\n");
}

test("USD conversion removes float noise while rounding genuine fractional subcredits up", () => {
  assert.equal(usdUnits(0.4025), 4025000);
  assert.equal(usdUnits(0.1 + 0.2), 3000000);
  assert.equal(usdUnits(0.00000015), 2);
});
test("config/catalog are explicit; missing gateway does not create fake successful generations", async (t) => {
  const s = fixture(t, {
    testMode: false,
    smtp: "smtp://fixture",
    smtpFrom: "",
    paymentKey: "fixture",
    paymentSecret: "fixture",
    publicUrl: "http://localhost",
  });
  const c = await request(s.app).get("/api/config").expect(200);
  assert.equal(c.body.services.generation, false);
  assert.equal(c.body.services.email, false);
  assert.equal(c.body.services.payments, false);
  const models = (await request(s.app).get("/api/models").expect(200)).body;
  assert.equal(models.data.length, 566);
  assert.equal(models.data.filter((m) => m.callable).length, 0);
  const { agent } = await register(s.app);
  await agent.post("/api/chat").send(prompt).expect(503);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
});
test("registration hashes secrets; CSRF rejects foreign origins; logout invalidates session", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  assert.equal(user.balance, 100000);
  const stored = s.db.prepare("SELECT * FROM users").get();
  assert.notEqual(stored.password, "test-password-long");
  assert.ok(stored.password.includes(":"));
  await agent
    .post("/api/auth/logout")
    .set("Origin", "https://evil.example")
    .send({})
    .expect(403);
  await agent.post("/api/auth/logout").send({}).expect(200);
  assert.equal((await agent.get("/api/me")).body.user, null);
  await agent
    .post("/api/auth/password")
    .send({ username: "tester", password: "wrong" })
    .expect(401);
  await agent
    .post("/api/auth/password")
    .send({ username: "tester", password: "test-password-long" })
    .expect(200);
});
test("email codes expire, are single-use, and stop after five guesses", async (t) => {
  const s = fixture(t);
  const a = request.agent(s.app);
  const send = (
    await a
      .post("/api/auth/email/send")
      .send({ email: "test@example.invalid" })
      .expect(200)
  ).body;
  await a
    .post("/api/auth/email/verify")
    .send({ id: send.id, code: send.testCode })
    .expect(200);
  await a
    .post("/api/auth/email/verify")
    .send({ id: send.id, code: send.testCode })
    .expect(400);
  const send2 = (
    await a
      .post("/api/auth/email/send")
      .send({ email: "other@example.invalid" })
  ).body;
  for (let i = 0; i < 5; i++)
    await a
      .post("/api/auth/email/verify")
      .send({ id: send2.id, code: "000000" })
      .expect(400);
  await a
    .post("/api/auth/email/verify")
    .send({ id: send2.id, code: send2.testCode })
    .expect(400);
  const send3 = (
    await a
      .post("/api/auth/email/send")
      .send({ email: "expires@example.invalid" })
  ).body;
  s.db.prepare("UPDATE challenges SET expires=0 WHERE id=?").run(send3.id);
  await a
    .post("/api/auth/email/verify")
    .send({ id: send3.id, code: send3.testCode })
    .expect(400);
});
test("verified email recovery changes password and revokes prior sessions", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const ch = (
    await agent
      .post("/api/auth/email/send")
      .send({ email: "recover@example.invalid", purpose: "link" })
  ).body;
  await agent
    .post("/api/auth/email/verify")
    .send({ id: ch.id, code: ch.testCode })
    .expect(200);
  const recovery = request.agent(s.app);
  const rc = (
    await recovery
      .post("/api/auth/email/send")
      .send({ email: "recover@example.invalid", purpose: "recover" })
  ).body;
  await recovery
    .post("/api/auth/email/verify")
    .send({ id: rc.id, code: rc.testCode, password: "replacement-password" })
    .expect(200);
  assert.equal((await agent.get("/api/me")).body.user, null);
  await agent
    .post("/api/auth/password")
    .send({ username: "tester", password: "test-password-long" })
    .expect(401);
  await agent
    .post("/api/auth/password")
    .send({ username: "tester", password: "replacement-password" })
    .expect(200);
});
test("wallet signature login is domain-bound, matches the address, and prevents replay", async (t) => {
  const s = fixture(t);
  const a = request.agent(s.app);
  const wallet = Wallet.createRandom();
  const ch = (
    await a.post("/api/auth/wallet/challenge").send({ address: wallet.address })
  ).body;
  assert.ok(ch.message.startsWith("localhost:5175 wants"));
  const wrong = await Wallet.createRandom().signMessage(ch.message);
  await a
    .post("/api/auth/wallet/verify")
    .send({ id: ch.id, signature: wrong })
    .expect(401);
  const signature = await wallet.signMessage(ch.message);
  const result = await a
    .post("/api/auth/wallet/verify")
    .send({ id: ch.id, signature })
    .expect(200);
  assert.equal(result.body.user.wallet, wallet.address.toLowerCase());
  await a
    .post("/api/auth/wallet/verify")
    .send({ id: ch.id, signature })
    .expect(400);
});
test("streaming chat persists receipts/context; duplicate request rejected; owners isolated", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const other = await register(s.app, "other");
  const r = await agent
    .post("/api/chat")
    .send({ ...prompt, requestId: "same-request" })
    .expect(200);
  assert.match(r.text, /\[DONE\]/);
  assert.match(r.text, /credits_charged/);
  const chats = (await agent.get("/api/conversations")).body.data;
  assert.equal(chats.length, 1);
  const c = (await agent.get("/api/conversations/" + chats[0].id)).body;
  assert.equal(c.messages.length, 2);
  assert.match(c.messages[1].content.text, /Local test provider/);
  assert.ok(c.messages[1].credits > 0);
  assert.equal(balance(s.db, user.id).held, 0);
  await other.agent.get("/api/conversations/" + c.id).expect(404);
  await other.agent.delete("/api/conversations/" + c.id).expect(404);
  await agent
    .post("/api/chat")
    .send({ ...prompt, requestId: "same-request" })
    .expect(409);
  await agent
    .patch("/api/conversations/" + c.id)
    .send({ title: "Renamed" })
    .expect(200);
  const exp = await agent.get("/api/conversations/export").expect(200);
  assert.equal(exp.body.conversations[0].title, "Renamed");
  await agent.delete("/api/conversations").expect(200);
  assert.equal((await agent.get("/api/conversations")).body.data.length, 0);
});
test("API key stores only hash, returns OpenAI-compatible JSON/SSE, revokes immediately", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  assert.ok(
    !JSON.stringify(s.db.prepare("SELECT * FROM api_keys").all()).includes(
      key.key,
    ),
  );
  const listing = await request(s.app)
    .get("/v1/models")
    .set("Authorization", "Bearer " + key.key)
    .expect(200);
  assert.ok(listing.body.data.length > 0);
  assert.ok(!("pricing" in listing.body.data[0]));
  const result = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send({ ...prompt, temperature: 0.3, tools: [{}] })
    .expect(200);
  assert.equal(result.body.object, "chat.completion");
  assert.ok(result.body.askr.credits_charged > 0);
  assert.ok(result.body.choices[0].message.content);
  const stream = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send({ ...prompt, stream: true })
    .expect(200);
  assert.match(stream.text, /chat.completion.chunk/);
  assert.match(stream.text, /\[DONE\]/);
  await agent.delete("/api/keys/" + key.id).expect(200);
  await request(s.app)
    .get("/v1/models")
    .set("Authorization", "Bearer " + key.key)
    .expect(401);
});
test("API caps include inflight reservations and roll forward after 24 hours", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const key = await keyFor(agent, 1);
  reserve(s.db, { id: "cap-first", user: user.id, amount: 7000, key: key.id });
  assert.throws(
    () =>
      reserve(s.db, {
        id: "cap-second",
        user: user.id,
        amount: 4000,
        key: key.id,
      }),
    /cap/,
  );
  settle(s.db, "cap-first", 6000);
  assert.throws(
    () =>
      reserve(s.db, {
        id: "cap-third",
        user: user.id,
        amount: 5000,
        key: key.id,
      }),
    /cap/,
  );
  s.db
    .prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?,?)")
    .run(
      "old_spend",
      user.id,
      -50000,
      "chat",
      "old_spend_ref",
      key.id,
      "Old usage",
      now() - 90000000,
    );
  reserve(s.db, { id: "cap-fourth", user: user.id, amount: 4000, key: key.id });
  release(s.db, "cap-fourth");
});
test("reservation is atomic, never overdraws, settlement is idempotent and ledger is append-only", async (t) => {
  const s = fixture(t);
  const { user } = await register(s.app);
  const total = balance(s.db, user.id).total;
  reserve(s.db, { id: "big1", user: user.id, amount: total - 1 });
  assert.throws(
    () => reserve(s.db, { id: "big2", user: user.id, amount: 2 }),
    /Not enough/,
  );
  const result = settle(s.db, "big1", total * 2);
  assert.equal(result.charged, total - 1);
  assert.equal(settle(s.db, "big1", 10).charged, total - 1);
  assert.equal(balance(s.db, user.id).available, 1);
  assert.throws(
    () => s.db.prepare("UPDATE ledger SET amount=0").run(),
    /append-only/,
  );
  assert.throws(() => s.db.prepare("DELETE FROM ledger").run(), /append-only/);
});