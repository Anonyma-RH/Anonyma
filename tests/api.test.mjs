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
test("input limits and unsupported roles reject before creating holds", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  const auth = "Bearer " + key.key;
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", auth)
    .send({ ...prompt, messages: [{ role: "tool", content: "x" }] })
    .expect(400);
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", auth)
    .send({
      ...prompt,
      messages: Array.from({ length: 41 }, () => ({
        role: "user",
        content: "x".repeat(4000),
      })),
    })
    .expect(400);
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", auth)
    .send({ ...prompt, max_tokens: -1 })
    .expect(400);
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", auth)
    .send({
      ...prompt,
      messages: [{ role: "user", content: "x".repeat(270000) }],
    })
    .expect(413);
  await agent
    .post("/api/chat")
    .send({
      ...prompt,
      messages: [{ role: "user", content: "x".repeat(48001) }],
    })
    .expect(400);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  await request(s.app)
    .post("/v1/embeddings")
    .set("Authorization", auth)
    .send({})
    .expect(404);
});
test("image batch generates private durable assets, limits references, and supports deletion", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const other = await register(s.app, "outsider");
  const result = await agent
    .post("/api/images")
    .send({
      model: imageModel,
      prompt: "Red circle test",
      n: 2,
      requestId: "images-1",
    })
    .expect(200);
  assert.equal(result.body.data.length, 2);
  assert.ok(result.body.receipt.credits_charged > 0);
  const url = result.body.data[0].url;
  await agent
    .get(url)
    .expect(200)
    .expect("Content-Type", /image\/png/);
  await other.agent.get(url).expect(404);
  await request(s.app).get(url).expect(404);
  const ref = "data:image/png;base64,iVBORw0KGgo=";
  await agent
    .post("/api/images")
    .send({ model: imageModel, prompt: "x", n: 1, images: Array(9).fill(ref) })
    .expect(400);
  await agent
    .post("/api/images")
    .send({ model: imageModel, prompt: "x", n: 5 })
    .expect(400);
  await agent.delete(url).expect(200);
  await agent.get(url).expect(404);
});
test("video jobs settle into a real playable local fixture and remain private", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const result = await agent
    .post("/api/videos")
    .send({
      model: "kling-2.5-turbo",
      prompt: "Test clip",
      ratio: "16:9",
      duration: "5",
      requestId: "vid-1",
    })
    .expect(202);
  assert.ok(balance(s.db, user.id).held > 0);
  await s.tick();
  const jobs = (await agent.get("/api/videos")).body.data;
  assert.equal(jobs[0].status, "completed");
  const media = (await agent.get("/api/media")).body.data;
  assert.equal(media[0].mime, "video/mp4");
  const asset = await agent.get(media[0].url).expect(200);
  assert.ok(asset.body.length > 1000);
  assert.equal(balance(s.db, user.id).held, 0);
  await agent
    .post("/api/videos")
    .send({
      model: "kling-2.5-turbo",
      prompt: "Test clip",
      ratio: "16:9",
      duration: "5",
      requestId: "vid-1",
    })
    .expect(409);
  await agent
    .post("/api/videos")
    .send({
      model: "kling-2.5-turbo",
      prompt: "x",
      ratio: "16:9",
      duration: "42",
    })
    .expect(400);
});
test("empty and explicitly rejected real-adapter responses release reservations", async (t) => {
  const gateway = await mockServer(t, async (req, res) => {
    const body = await readJSON(req);
    if (body.messages[0].content === "reject") {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Fixture rejection" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, {
      choices: [{ delta: { content: "" } }],
      usage: { prompt_tokens: 10, completion_tokens: 0 },
    });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, {
    testMode: false,
    gateway,
    gatewayKey: "fake-test-key",
  });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 1000000, "mock-fund");
  const key = await keyFor(agent);
  const before = balance(s.db, user.id).total;
  const r = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(502);
  assert.equal(r.body.error.code, "empty_output");
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send({ ...prompt, messages: [{ role: "user", content: "reject" }] })
    .expect(400);
  assert.equal(balance(s.db, user.id).total, before);
  assert.equal(balance(s.db, user.id).held, 0);
});
test("NOWPayments signed callback credits once; forged and mismatched callbacks rejected", async (t) => {
  let invoice;
  const base = await mockServer(t, async (req, res) => {
    const body = await readJSON(req);
    invoice = {
      payment_id: 123456,
      payment_status: "waiting",
      order_id: body.order_id,
      price_currency: "usd",
      price_amount: body.price_amount,
      pay_address: "test-address",
      pay_amount: 0.0001,
      pay_currency: "btc",
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(invoice));
  });
  const secret = "test-ipn-secret";
  const s = fixture(t, {
    testMode: false,
    paymentKey: "test-key",
    paymentSecret: secret,
    paymentBase: base,
    publicUrl: "https://example.invalid",
  });
  const { agent, user } = await register(s.app);
  await agent
    .post("/api/deposits")
    .send({ amount: 20, currency: "btc" })
    .expect(201);
  const payload = { ...invoice, payment_status: "finished" };
  const sign = (v) =>
    createHmac("sha512", secret)
      .update(JSON.stringify(canonical(v)))
      .digest("hex");
  await request(s.app).post("/api/payments/ipn").send(payload).expect(401);
  const wrong = { ...payload, price_amount: 999 };
  await request(s.app)
    .post("/api/payments/ipn")
    .set("x-nowpayments-sig", sign(wrong))
    .send(wrong)
    .expect(400);
  assert.equal(balance(s.db, user.id).total, 0);
  for (const amount of ["not-a-number", null, -1]) {
    const invalid = { ...payload, price_amount: amount };
    await request(s.app)
      .post("/api/payments/ipn")
      .set("x-nowpayments-sig", sign(invalid))
      .send(invalid)
      .expect(400);
    assert.equal(balance(s.db, user.id).total, 0);
  }
  for (let i = 0; i < 2; i++)
    await request(s.app)
      .post("/api/payments/ipn")
      .set("x-nowpayments-sig", sign(payload))
      .send(payload)
      .expect(200);
  assert.equal(credits(balance(s.db, user.id).total), 20000);
  const sparseUpdate = { ...payload };
  delete sparseUpdate.pay_address;
  await request(s.app)
    .post("/api/payments/ipn")
    .set("x-nowpayments-sig", sign(sparseUpdate))
    .send(sparseUpdate)
    .expect(200);
  assert.equal(
    (await agent.get("/api/deposits")).body.data[0].payload.pay_address,
    invoice.pay_address,
  );
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='deposit'").get().n,
    1,
  );
});
test("account closure revokes access and deletes content while retaining financial audit", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const key = await keyFor(agent);
  await agent.post("/api/conversations").send({ title: "Private" }).expect(201);
  await agent.delete("/api/account").send({ confirm: "no" }).expect(400);
  await agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  await request(s.app)
    .get("/v1/models")
    .set("Authorization", "Bearer " + key.key)
    .expect(401);
  assert.equal(
    s.db.prepare("SELECT username FROM users WHERE id=?").get(user.id).username,
    null,
  );
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?")
      .get(user.id).n,
    0,
  );
  assert.ok(
    s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=?").get(user.id)
      .n > 0,
  );
});
test("support requests, session listings, and exports are owner-scoped", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  await request(s.app)
    .post("/api/support")
    .send({ subject: "a", body: "b" })
    .expect(401);
  const ticket = await agent
    .post("/api/support")
    .send({ subject: "Fixture help", body: "Local integration test." })
    .expect(201);
  assert.ok(ticket.body.id);
  const exported = await agent.get("/api/account/export").expect(200);
  assert.equal(exported.body.user.username, "tester");
  assert.ok(!JSON.stringify(exported.body).includes("test-password-long"));
  const sessions = await agent.get("/api/account/sessions").expect(200);
  assert.equal(sessions.body.data.length, 1);
  await agent.post("/api/auth/logout-all").send({}).expect(200);
  await agent.get("/api/account/export").expect(401);
});
test("email hourly limits persist after successful verification", async (t) => {
  const s = fixture(t),
    a = request.agent(s.app);
  for (let i = 0; i < 5; i++) {
    const j = (
      await a
        .post("/api/auth/email/send")
        .send({ email: "limited@example.invalid" })
        .expect(200)
    ).body;
    await a
      .post("/api/auth/email/verify")
      .send({ id: j.id, code: j.testCode })
      .expect(200);
  }
  await a
    .post("/api/auth/email/send")
    .send({ email: "limited@example.invalid" })
    .expect(429);
});
test("vision validation uses advertised capabilities rather than guessed provider names", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const models = (await agent.get("/api/models")).body.data;
  const textOnly = models.find(
    (m) => m.type === "chat" && m.callable && !m.vision,
  );
  assert.ok(textOnly);
  await agent
    .post("/api/chat")
    .send({
      model: textOnly.id,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this" },
            {
              type: "image_url",
              image_url: { url: "https://example.invalid/test.png" },
            },
          ],
        },
      ],
    })
    .expect(400);
});