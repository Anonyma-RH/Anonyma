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