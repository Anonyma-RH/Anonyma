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
  callable,
} from "../server/core.js";
import { canonical } from "../server/auth.js";
import { recordPayment } from "../server/payments.js";
import { reportedProviderCost } from "../server/provider.js";
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
function dedicatedImageCatalog(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-image-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "models.json");
  const model = {
    id: "fixture/image",
    name: "Fixture image",
    type: "image",
    status: "live",
    capabilities: {
      accepts_prompt: true,
      accepts_image_url: true,
      requires_image_url: false,
    },
    pricing: {
      type: "per_generation",
      variants: [
        { quality: "low", options: [{ size: "default", price: 0.047 }] },
      ],
    },
  };
  writeFileSync(
    path,
    JSON.stringify({ updatedAt: new Date().toISOString(), data: [model] }),
  );
  return { path, model };
}

test("USD conversion removes float noise while rounding genuine fractional subcredits up", () => {
  assert.equal(usdUnits(0.4025), 4025000);
  assert.equal(usdUnits(0.1 + 0.2), 3000000);
  assert.equal(usdUnits(0.00000015), 2);
});
test("PPQ BYOK usage includes upstream inference and fee in the settled charge", async (t) => {
  const usage = {
    prompt_tokens: 13,
    completion_tokens: 5,
    cost: 0.00000418,
    is_byok: true,
    cost_details: { upstream_inference_cost: 0.0000836 },
  };
  const billed = 0.000088198; // PPQ's observed account-history debit.
  assert.ok(Math.abs(reportedProviderCost(usage) - billed) < 1e-12);
  // Without BYOK, usage.cost is the inference cost; PPQ debited 1.055x it
  // in a live check (0.000119208 reported, 0.000125764 debited).
  assert.ok(
    // PPQ's balance has nine decimals, so its debit is rounded to 1e-9.
    Math.abs(reportedProviderCost({ cost: 0.000119208 }) - 0.000125764) < 1e-9,
  );
  assert.equal(reportedProviderCost({ cost: 0.00000418, is_byok: true }), null);
  assert.equal(reportedProviderCost({ cost: 0.0001 }, undefined, 0), 0.0001);
  assert.equal(reportedProviderCost(usage, 0.00009), 0.00009);
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { choices: [{ delta: { content: "ready" } }] });
    event(res, { choices: [], usage });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 1000000, "byok-fund", "test_credit");
  const key = await keyFor(agent);
  const before = balance(s.db, user.id).total;
  const response = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send({ ...prompt, max_tokens: 100 })
    .expect(200);
  assert.equal(response.body.choices[0].message.content, "ready");
  assert.equal(before - balance(s.db, user.id).total, usdUnits(billed));
  assert.equal(balance(s.db, user.id).held, 0);
});
test("PPQ streamed input/output token aliases drive fallback billing", async (t) => {
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { choices: [{ delta: { content: "ready" } }] });
    event(res, { choices: [], usage: { input_tokens: 13, output_tokens: 5 } });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 1000000, "alias-fund", "test_credit");
  const key = await keyFor(agent);
  const before = balance(s.db, user.id).total;
  const response = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send({ ...prompt, max_tokens: 100 })
    .expect(200);
  assert.equal(response.body.usage.prompt_tokens, 13);
  assert.equal(response.body.usage.completion_tokens, 5);
  assert.equal(
    before - balance(s.db, user.id).total,
    usdUnits((13 * 0.15 + 5 * 1.25) / 1e6),
  );
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
    .prepare(
      "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
    )
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
test("API image output is signed, expires, and can be fetched without disclosing the API key", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  const r = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send({
      model: imageModel,
      messages: [{ role: "user", content: "A fixture" }],
    })
    .expect(200);
  const url = new URL(r.body.choices[0].message.images[0].image_url.url);
  await request(s.app)
    .get(url.pathname + url.search)
    .expect(200);
  await request(s.app)
    .get(url.pathname + url.search.replace("sig=", "sig=x"))
    .expect(404);
  s.db.prepare("UPDATE media SET expires=1").run();
  await request(s.app)
    .get(url.pathname + url.search)
    .expect(404);
});
test("video failure releases funds; ambiguous submission is held without automatic resubmission", async (t) => {
  let calls = 0;
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(200, { "content-type": "application/json" });
    if (req.method === "POST") {
      calls++;
      res.end(
        JSON.stringify(
          calls === 1 ? { id: "upstream-video" } : { status: "unknown" },
        ),
      );
    } else
      res.end(JSON.stringify({ status: "failed", error: "Fixture failure" }));
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fake" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "video-funds");
  const body = {
    model: "kling-2.5-turbo",
    prompt: "Clip",
    ratio: "16:9",
    duration: "5",
  };
  await agent.post("/api/videos").send(body).expect(202);
  await s.tick();
  assert.equal(balance(s.db, user.id).held, 0);
  const second = await agent.post("/api/videos").send(body);
  assert.equal(second.status, 500);
  assert.ok(balance(s.db, user.id).held > 0);
  await s.tick();
  assert.equal(calls, 2);
  assert.ok(
    (await agent.get("/api/videos")).body.data.some(
      (j) => j.status === "reconciliation",
    ),
  );
});
test("durable conversations and pending video jobs resume after process restart", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-restart-"));
  const settings = {
    testMode: true,
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
  };
  let s = createApp(settings);
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const { agent } = await register(s.app);
  const conversation = (
    await agent.post("/api/conversations").send({ title: "Survives restart" })
  ).body.id;
  await agent
    .post("/api/videos")
    .send({
      model: "kling-2.5-turbo",
      prompt: "Persisted clip",
      ratio: "16:9",
      duration: "5",
    })
    .expect(202);
  s.close();
  s = createApp(settings);
  const a = request.agent(s.app);
  await a
    .post("/api/auth/password")
    .send({ username: "tester", password: "test-password-long" })
    .expect(200);
  assert.equal(
    (await a.get("/api/conversations/" + conversation)).body.title,
    "Survives restart",
  );
  await s.tick();
  assert.equal((await a.get("/api/videos")).body.data[0].status, "completed");
});
test("catalog refresh imports priced upstream models and preserves unavailable history", async (t) => {
  const gateway = await mockServer(t, async (req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [
          {
            id: "fresh-fixture",
            type: "chat",
            owned_by: "Fixture",
            name: "Fixture model",
            pricing: {
              type: "per_token",
              input_per_1M_tokens: 1,
              output_per_1M_tokens: 2,
            },
          },
        ],
      }),
    );
  });
  const temp = mkdtempSync(join(tmpdir(), "anonyma-catalog-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const s = fixture(t, {
    gateway,
    syncModels: true,
    catalogPath: join(temp, "models.json"),
  });
  const m = (await request(s.app).get("/api/models")).body;
  assert.equal(m.live, true);
  assert.equal(m.data.find((v) => v.id === "fresh-fixture").status, "live");
  assert.equal(m.data.find((v) => v.id === chatModel).status, "unavailable");
});
test("missing or invalid published token rates reject before reserving credits", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "anonyma-unpriced-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const catalogPath = join(temp, "models.json");
  writeFileSync(
    catalogPath,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      data: [
        { id: "missing-rate", type: "chat", status: "live", pricing: {} },
        {
          id: "negative-rate",
          type: "chat",
          status: "live",
          pricing: { input_per_1M_tokens: -1, output_per_1M_tokens: 2 },
        },
      ],
    }),
  );
  const s = fixture(t, { catalogPath });
  const { agent } = await register(s.app);
  const listed = (await agent.get("/api/models").expect(200)).body.data;
  for (const model of ["missing-rate", "negative-rate"]) {
    assert.equal(listed.find((row) => row.id === model).callable, false);
    const response = await agent
      .post("/api/chat")
      .send({ ...prompt, model })
      .expect(400);
    assert.equal(response.body.error.code, "unpriced_model");
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
});
test("API compatibility clamps output, retains last 40 strings, skips parts, and exposes authenticated connection balance", async (t) => {
  let received;
  const gateway = await mockServer(t, async (req, res) => {
    received = await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, {
      choices: [{ delta: { content: "OK" } }],
      usage: { prompt_tokens: 2, completion_tokens: 1 },
    });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "compat-fund");
  const key = await keyFor(agent);
  const auth = "Bearer " + key.key;
  const connection = await request(s.app)
    .get("/v1")
    .set("User-Agent", "Integration test")
    .set("Authorization", auth)
    .expect(200);
  assert.equal(connection.body.authenticated, true);
  assert.equal(connection.body.account.credits, 10000);
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", auth)
    .send({
      model: chatModel,
      max_tokens: 99999,
      messages: [
        ...Array.from({ length: 41 }, (_, i) => ({
          role: "user",
          content: "Message " + i,
        })),
        { role: "user", content: [{ type: "text", text: "skipped" }] },
      ],
    })
    .expect(200);
  assert.equal(received.max_tokens, 8192);
  assert.equal(received.messages.length, 40);
  assert.equal(received.messages[0].content, "Message 1");
  assert.equal(received.messages.at(-1).content, "Message 40");
});
test("unreadable responses and upstream deadline charge the estimate, not the headroom, and report it", async (t) => {
  let timeoutMode = false;
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    if (timeoutMode) {
      setTimeout(() => {
        res.writeHead(200);
        res.end();
      }, 120);
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end("data: {broken-json}\n\n");
  });
  const s = fixture(t, {
    testMode: false,
    gateway,
    gatewayKey: "fixture",
    requestTimeoutMs: 40,
  });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "failure-fund");
  const key = await keyFor(agent);
  const auth = "Bearer " + key.key;
  const bad = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", auth)
    .send(prompt)
    .expect(502);
  assert.equal(bad.body.error.code, "provider_unreadable");
  assert.ok(bad.body.askr.credits_charged > 0);
  const hold = s.db
    .prepare("SELECT * FROM holds ORDER BY created DESC LIMIT 1")
    .get();
  // The hold carries 4x headroom; the failure policy charges the estimate.
  assert.equal(JSON.parse(hold.result).charged * 4, hold.amount);
  timeoutMode = true;
  const timed = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", auth)
    .send(prompt)
    .expect(504);
  assert.equal(timed.body.error.code, "provider_timeout");
  assert.ok(timed.body.askr.credits_charged > 0);
  assert.equal(balance(s.db, user.id).held, 0);
});
test("upstream disconnect preserves partial history and returns an honest billing receipt", async (t) => {
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { choices: [{ delta: { content: "Partial answer" } }] });
    res.end();
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "interruption-fund");
  const workspace = await agent.post("/api/chat").send(prompt).expect(200);
  assert.match(workspace.text, /provider_interrupted/);
  const message = s.db
    .prepare("SELECT content FROM messages WHERE role='assistant'")
    .get();
  assert.equal(JSON.parse(message.content).interrupted, true);
  assert.equal(JSON.parse(message.content).text, "Partial answer");
  const key = await keyFor(agent);
  const result = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(502);
  assert.equal(result.body.error.code, "provider_interrupted");
  assert.ok(result.body.anonyma.credits_charged > 0);
  assert.equal(balance(s.db, user.id).held, 0);
});
test("the standalone CLI streams an authenticated one-shot answer and receipt", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  const http = s.app.listen(0, "127.0.0.1");
  await new Promise((r) => http.once("listening", r));
  t.after(() => new Promise((r) => http.close(r)));
  const run = promisify(execFile);
  const result = await run(
    process.execPath,
    ["cli/anonyma.mjs", "Hello from the CLI"],
    {
      env: {
        ...process.env,
        ANONYMA_API_KEY: key.key,
        ANONYMA_BASE_URL: "http://127.0.0.1:" + http.address().port + "/v1",
        ANONYMA_MODEL: chatModel,
      },
    },
  );
  assert.match(result.stdout, /Hello from the CLI/);
  assert.match(result.stdout, /credits/);
  assert.match(result.stdout, /LOCAL TEST/);
});

test("image batches retain successful outputs and charge them once after a later provider failure", async (t) => {
  const { path: catalogPath, model } = dedicatedImageCatalog(t);
  let calls = 0;
  const upstreamRequests = [];
  const png =
    "data:image/png;base64," +
    readFileSync("data/test-image.png").toString("base64");
  const gateway = await mockServer(t, async (req, res) => {
    upstreamRequests.push({ path: req.url, body: await readJSON(req) });
    calls++;
    res.writeHead(calls === 1 ? 200 : 503, {
      "content-type": "application/json",
    });
    res.end(
      JSON.stringify(
        calls === 1
          ? {
              data: [{ b64_json: png.split(",")[1] }],
              cost: 0.02,
            }
          : { error: { message: "Test outage" } },
      ),
    );
  });
  const s = fixture(t, {
    testMode: false,
    gateway,
    gatewayKey: "fixture",
    catalogPath,
  });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "image-batch-funding");
  const body = {
    model: model.id,
    prompt: "A blue circle",
    n: 3,
    requestId: "partial-batch",
  };
  const result = await agent.post("/api/images").send(body).expect(200);
  assert.equal(result.body.partial, true);
  assert.equal(result.body.data.length, 1);
  assert.match(result.body.warning, /Only saved images/);
  assert.equal(result.body.receipt.credits_charged, 20);
  assert.equal(result.body.data[0].cost, 20);
  assert.equal(calls, 2);
  assert.equal(upstreamRequests[0].path, "/v1/images/generations");
  assert.equal(upstreamRequests[0].body.model, model.id);
  assert.equal(upstreamRequests[0].body.quality, "low");
  assert.equal(upstreamRequests[0].body.prompt, "A blue circle");
  assert.equal(upstreamRequests[0].body.messages, undefined);
  assert.equal((await agent.get("/api/media")).body.data.length, 1);
  assert.equal(balance(s.db, user.id).held, 0);
  await agent.post("/api/images").send(body).expect(409);
  assert.equal(calls, 2);
  await agent
    .post("/api/images")
    .send({ ...body, images: "not-an-array" })
    .expect(400);
});

test("dedicated image references remain private and retired chat-image models are unavailable live", async (t) => {
  assert.equal(
    callable(
      {
        id: imageModel,
        type: "chat",
        status: "live",
        pricing: { input_per_1M_tokens: 0.15, output_per_1M_tokens: 1.25 },
        architecture: { output_modalities: ["image", "text"] },
      },
      { testMode: false, gatewayKey: "fixture" },
    ),
    false,
  );
  const { path: catalogPath, model } = dedicatedImageCatalog(t);
  const png = readFileSync("data/test-image.png").toString("base64");
  const ref = "data:image/png;base64," + png;
  let upstream;
  const gateway = await mockServer(t, async (req, res) => {
    upstream = { path: req.url, body: await readJSON(req) };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ b64_json: png }], cost: 0.047 }));
  });
  const s = fixture(t, {
    testMode: false,
    gateway,
    gatewayKey: "fixture",
    catalogPath,
  });
  const { agent, user } = await register(s.app);
  const other = await register(s.app, "image-outsider");
  addCredit(s.db, user.id, 1000000, "reference-fund", "test_credit");
  const result = await agent
    .post("/api/images")
    .send({ model: model.id, prompt: "Use this reference", images: [ref] })
    .expect(200);
  assert.equal(upstream.path, "/v1/images/generations");
  assert.equal(upstream.body.image_url, ref);
  assert.equal(result.body.receipt.charged, usdUnits(0.047));
  const url = result.body.data[0].url;
  await agent
    .get(url)
    .expect(200)
    .expect("Content-Type", /image\/png/);
  await other.agent.get(url).expect(404);
  await request(s.app).get(url).expect(404);
  await agent
    .post("/api/images")
    .send({ model: model.id, prompt: "Invalid references", images: [ref, ref] })
    .expect(400);
  assert.equal(balance(s.db, user.id).held, 0);
});

test("invalid credit and settlement amounts cannot corrupt ledger or release held funds", async (t) => {
  const s = fixture(t);
  const { user } = await register(s.app);
  reserve(s.db, { id: "checked-cost", user: user.id, amount: 1000 });
  for (const value of [NaN, Infinity, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => settle(s.db, "checked-cost", value),
      /could not be verified/,
    );
    assert.throws(
      () => addCredit(s.db, user.id, value, uid()),
      /positive integer/,
    );
  }
  assert.equal(balance(s.db, user.id).held, 1000);
  assert.equal(settle(s.db, "checked-cost", 200).charged, 200);
});

test("real SMTP adapter delivers to a local capture server and removes failed challenges", async (t) => {
  const { createServer: tcpServer } = await import("node:net");
  let mail = "",
    reject = false;
  const sockets = new Set();
  const smtp = tcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");
    socket.write("220 localhost ESMTP test\r\n");
    let buffer = "",
      data = false;
    socket.on("data", (chunk) => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf("\r\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === ".") {
            data = false;
            socket.write("250 captured\r\n");
          } else mail += line + "\n";
        } else if (/^EHLO|^HELO/.test(line))
          socket.write("250-localhost\r\n250 SIZE 1000000\r\n");
        else if (/^MAIL FROM/.test(line))
          socket.write(reject ? "550 fixture refused\r\n" : "250 OK\r\n");
        else if (/^DATA/.test(line)) {
          data = true;
          socket.write("354 Send message\r\n");
        } else if (/^QUIT/.test(line)) socket.end("221 Bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  await new Promise((resolve) => smtp.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    for (const socket of sockets) socket.destroy();
    smtp.close();
  });
  const s = fixture(t, {
    testMode: false,
    smtp: `smtp://127.0.0.1:${smtp.address().port}`,
    smtpFrom: "Anonyma <sender@example.invalid>",
  });
  const agent = request.agent(s.app);
  const sent = await agent
    .post("/api/auth/email/send")
    .send({ email: "recipient@example.invalid" })
    .expect(200);
  assert.equal(sent.body.testCode, undefined);
  assert.match(mail, /To: recipient@example.invalid/);
  const code = mail.match(/Your code is (\d{6})/)[1];
  await agent
    .post("/api/auth/email/verify")
    .send({ id: sent.body.id, code })
    .expect(200);
  reject = true;
  const failed = await agent
    .post("/api/auth/email/send")
    .send({ email: "unreachable@example.invalid" })
    .expect(503);
  assert.equal(failed.body.error.code, "email_unavailable");
  assert.equal(
    s.db
      .prepare(
        "SELECT COUNT(*) n FROM challenges WHERE target='unreachable@example.invalid'",
      )
      .get().n,
    0,
  );
});

test("expired image batches recover persisted charges exactly once and leave known videos reserved", async (t) => {
  const s = fixture(t);
  const { user } = await register(s.app);
  reserve(s.db, {
    id: "recover-image",
    user: user.id,
    amount: 10000,
    kind: "image",
    ttl: -100,
  });
  s.db.prepare("UPDATE holds SET result=? WHERE id=?").run(
    JSON.stringify({
      delivered: 2400,
      mediaIds: ["already-delivered"],
      description: "Test image",
    }),
    "recover-image",
  );
  reserve(s.db, {
    id: "keep-video",
    user: user.id,
    amount: 10000,
    kind: "video",
    ttl: -100,
  });
  await s.tick();
  await s.tick();
  const receipt = JSON.parse(
    s.db.prepare("SELECT result FROM holds WHERE id='recover-image'").get()
      .result,
  );
  assert.equal(receipt.charged, 2400);
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM ledger WHERE ref='recover-image'")
      .get().n,
    1,
  );
  assert.equal(
    s.db.prepare("SELECT status FROM holds WHERE id='keep-video'").get().status,
    "held",
  );
});

test("maintenance does not release an expired reservation while its image request is still active", async (t) => {
  const { path: catalogPath, model } = dedicatedImageCatalog(t);
  let service, heldDuringRequest;
  const png =
    "data:image/png;base64," +
    readFileSync("data/test-image.png").toString("base64");
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    service.db.prepare("UPDATE holds SET expires=0 WHERE kind='image'").run();
    await service.tick();
    heldDuringRequest = service.db
      .prepare("SELECT status FROM holds WHERE kind='image'")
      .get().status;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        data: [{ b64_json: png.split(",")[1] }],
        cost: -9,
      }),
    );
  });
  service = fixture(t, {
    testMode: false,
    gateway,
    gatewayKey: "fixture",
    catalogPath,
  });
  const { agent, user } = await register(service.app);
  addCredit(service.db, user.id, 100000000, "active-image-fund");
  const result = await agent
    .post("/api/images")
    .send({ model: model.id, prompt: "A circle" })
    .expect(200);
  assert.equal(heldDuringRequest, "held");
  assert.equal(result.body.receipt.credits_charged, 47);
  assert.equal(balance(service.db, user.id).held, 0);
});

test("video polling is bounded and rotates through all queued jobs", async (t) => {
  let active = 0,
    peak = 0;
  const polled = new Set();
  const gateway = await mockServer(t, async (req, res) => {
    active++;
    peak = Math.max(peak, active);
    polled.add(req.url.split("/").at(-1));
    await new Promise((resolve) => setTimeout(resolve, 5));
    active--;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "processing" }));
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { user } = await register(s.app);
  for (let i = 0; i < 21; i++)
    s.db
      .prepare(
        "INSERT INTO videos(id,user_id,hold_id,provider_id,status,request,error,media_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
      )
      .run(
        "queued-" + i,
        user.id,
        "hold-" + i,
        "provider-" + i,
        "pending",
        "{}",
        null,
        null,
        1,
        1,
      );
  await s.tick();
  assert.equal(polled.size, 20);
  await s.tick();
  assert.equal(polled.size, 21);
  assert.ok(peak > 1 && peak <= 4);
});

test("live video adapter refuses fixture flags and recovers completion without duplicate media or charges", async (t) => {
  let fixtureFlag = true;
  const video =
    "data:video/mp4;base64," +
    readFileSync("data/test-video.mp4").toString("base64");
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify(
        req.method === "POST"
          ? { id: "video-upstream" }
          : {
              status: "completed",
              cost: "invalid",
              data: fixtureFlag ? { test: true } : { url: video },
            },
      ),
    );
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "video-recovery-fund");
  const job = await agent
    .post("/api/videos")
    .send({
      model: "kling-2.5-turbo",
      prompt: "A circle moving",
      ratio: "16:9",
      duration: "5",
    })
    .expect(202);
  await s.tick();
  assert.equal((await agent.get("/api/media")).body.data.length, 0);
  assert.ok(balance(s.db, user.id).held > 0);
  fixtureFlag = false;
  await s.tick();
  const media = (await agent.get("/api/media")).body.data;
  assert.equal(media.length, 1);
  assert.equal(media[0].cost, 402.5);
  const count = s.db
    .prepare("SELECT COUNT(*) n FROM ledger WHERE kind='video'")
    .get().n;
  s.db
    .prepare("UPDATE videos SET status='processing' WHERE id=?")
    .run(job.body.id);
  await s.tick();
  assert.equal((await agent.get("/api/media")).body.data.length, 1);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind='video'").get().n,
    count,
  );
});

test("payment callbacks can arrive before invoice creation returns without lost credits or status regression", async (t) => {
  const secret = "early-callback-fixture";
  let s;
  const base = await mockServer(t, async (req, res) => {
    const body = await readJSON(req);
    const update = {
      payment_id: "early-42",
      order_id: body.order_id,
      price_amount: body.price_amount,
      price_currency: "usd",
      pay_currency: "btc",
      payment_status: "finished",
    };
    const signature = createHmac("sha512", secret)
      .update(JSON.stringify(canonical(update)))
      .digest("hex");
    await request(s.app)
      .post("/api/payments/ipn")
      .set("x-nowpayments-sig", signature)
      .send(update)
      .expect(200);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...update,
        payment_status: "waiting",
        pay_address: "test-only-address",
        pay_amount: 0.001,
      }),
    );
  });
  s = fixture(t, {
    testMode: false,
    paymentKey: "fixture",
    paymentSecret: secret,
    paymentBase: base,
    publicUrl: "https://payments.example.invalid",
  });
  const { agent, user } = await register(s.app);
  const result = await agent
    .post("/api/deposits")
    .send({ amount: 20, currency: "btc", requestId: "early" })
    .expect(201);
  assert.equal(result.body.payment_status, "finished");
  assert.equal(result.body.pay_address, "test-only-address");
  await agent
    .post("/api/deposits")
    .send({ amount: 20, currency: "btc", requestId: "early" })
    .expect(200);
  assert.equal(credits(balance(s.db, user.id).total), 20000);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 1);
});

test("stale payment callbacks cannot reopen an expired invoice", async (t) => {
  const secret = "terminal-status-fixture";
  let invoice;
  let currentStatus = "finished";
  const base = await mockServer(t, async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(
        JSON.stringify({ ...invoice, payment_status: currentStatus }),
      );
    }
    const body = await readJSON(req);
    invoice = {
      payment_id: "terminal-42",
      order_id: body.order_id,
      price_amount: body.price_amount,
      price_currency: "usd",
      pay_currency: "btc",
      payment_status: "waiting",
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(invoice));
  });
  const s = fixture(t, {
    testMode: false,
    paymentKey: "fixture",
    paymentSecret: secret,
    paymentBase: base,
    publicUrl: "https://payments.example.invalid",
    paymentPollIntervalMs: -1,
  });
  const { agent, user } = await register(s.app);
  const created = await agent
    .post("/api/deposits")
    .send({ amount: 10, currency: "btc" })
    .expect(201);
  const callback = async (payment_status) => {
    const body = { ...invoice, payment_status };
    const signature = createHmac("sha512", secret)
      .update(JSON.stringify(canonical(body)))
      .digest("hex");
    await request(s.app)
      .post("/api/payments/ipn")
      .set("x-nowpayments-sig", signature)
      .send(body)
      .expect(200);
  };
  await callback("expired");
  await callback("waiting");
  assert.equal(
    s.db.prepare("SELECT status FROM deposits WHERE id=?").get(created.body.id)
      .status,
    "expired",
  );
  assert.equal(balance(s.db, user.id).total, 0);
  await callback("finished");
  const conflicted = s.db
    .prepare("SELECT status,payload FROM deposits WHERE id=?")
    .get(created.body.id);
  assert.equal(conflicted.status, "reconciliation");
  assert.ok(JSON.parse(conflicted.payload).statusReview);
  assert.equal(balance(s.db, user.id).total, 0);
  await agent.get(`/api/deposits/${created.body.id}`).expect(200);
  assert.equal(credits(balance(s.db, user.id).total), 10000);
  await callback("refunded");
  assert.equal(
    s.db.prepare("SELECT status FROM deposits WHERE id=?").get(created.body.id)
      .status,
    "reconciliation",
  );
  assert.equal(
    (await agent.get("/api/deposits").expect(200)).body.data[0].credited,
    0,
  );
  assert.equal(balance(s.db, user.id).available, 0);
  assert.throws(
    () => reserve(s.db, { id: "blocked-by-dispute", user: user.id, amount: 1 }),
    { code: "payment_reconciliation_pending" },
  );
  currentStatus = "refunded";
  await s.tick();
  assert.equal(
    s.db.prepare("SELECT status FROM deposits WHERE id=?").get(created.body.id)
      .status,
    "refunded",
  );
  assert.equal(balance(s.db, user.id).total, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 2);
  assert.equal(
    (await agent.get(`/api/deposits/${created.body.id}`).expect(200)).body
      .credited,
    0,
  );
  await callback("refunded");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 2);
  await callback("finished");
  assert.throws(
    () =>
      reserve(s.db, { id: "blocked-until-current", user: user.id, amount: 1 }),
    { code: "payment_reconciliation_pending" },
  );
  currentStatus = "finished";
  const stillDisputed = await agent
    .get(`/api/deposits/${created.body.id}`)
    .expect(200);
  assert.equal(stillDisputed.body.credited, 0);
  assert.equal(stillDisputed.body.status, "reconciliation");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 2);
  recordPayment(
    s.db,
    { ...invoice, payment_status: "finished" },
    { current: true, allowReinstate: true },
  );
  const reinstated = await agent
    .get(`/api/deposits/${created.body.id}`)
    .expect(200);
  assert.equal(reinstated.body.credited, 1);
  await callback("finished");
  assert.equal(credits(balance(s.db, user.id).total), 10000);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 3);
  await callback("failed");
  currentStatus = "failed";
  await agent.get(`/api/deposits/${created.body.id}`).expect(200);
  assert.equal(balance(s.db, user.id).total, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 4);
  await callback("finished");
  currentStatus = "finished";
  await agent.get(`/api/deposits/${created.body.id}`).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 4);
  recordPayment(
    s.db,
    { ...invoice, payment_status: "finished" },
    { current: true, allowReinstate: true },
  );
  assert.equal(credits(balance(s.db, user.id).total), 10000);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 5);
});

test("uncertain invoice creation blocks closure and recovers from a later authenticated callback", async (t) => {
  let invoice;
  const secret = "late-callback-fixture";
  const base = await mockServer(t, async (req, res) => {
    const body = await readJSON(req);
    invoice = {
      payment_id: "late-42",
      order_id: body.order_id,
      price_amount: body.price_amount,
      price_currency: "usd",
      pay_currency: "btc",
      payment_status: "finished",
    };
    res.destroy();
  });
  const s = fixture(t, {
    testMode: false,
    paymentKey: "fixture",
    paymentSecret: secret,
    paymentBase: base,
    publicUrl: "https://payments.example.invalid",
  });
  const { agent, user } = await register(s.app);
  await agent
    .post("/api/deposits")
    .send({ amount: 20, currency: "btc", requestId: "late" })
    .expect(502);
  assert.equal(
    s.db.prepare("SELECT status FROM deposits").get().status,
    "reconciliation",
  );
  await agent.delete("/api/account").send({ confirm: "DELETE" }).expect(409);
  await agent
    .post("/api/deposits")
    .send({ amount: 20, currency: "btc", requestId: "late" })
    .expect(409);
  const signature = (body) =>
    createHmac("sha512", secret)
      .update(JSON.stringify(canonical(body)))
      .digest("hex");
  const invalid = { ...invoice, pay_currency: "eth" };
  await request(s.app)
    .post("/api/payments/ipn")
    .set("x-nowpayments-sig", signature(invalid))
    .send(invalid)
    .expect(400);
  assert.equal(
    s.db.prepare("SELECT provider_id FROM deposits").get().provider_id,
    null,
  );
  await request(s.app)
    .post("/api/payments/ipn")
    .set("x-nowpayments-sig", signature(invoice))
    .send(invoice)
    .expect(200);
  assert.equal(credits(balance(s.db, user.id).total), 20000);
});

test("background payment checks settle invoices without browser polling or a delivered webhook", async (t) => {
  let invoice,
    checks = 0;
  const base = await mockServer(t, async (req, res) => {
    if (req.method === "POST") {
      const body = await readJSON(req);
      invoice = {
        payment_id: "poll-42",
        order_id: body.order_id,
        price_amount: body.price_amount,
        price_currency: "usd",
        pay_currency: "btc",
        payment_status: "waiting",
      };
    } else checks++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        ...invoice,
        payment_status: checks ? "finished" : "waiting",
      }),
    );
  });
  const s = fixture(t, {
    testMode: false,
    paymentKey: "fixture",
    paymentSecret: "fixture",
    paymentBase: base,
    publicUrl: "https://payments.example.invalid",
    paymentPollIntervalMs: 0,
  });
  const { agent, user } = await register(s.app);
  await agent
    .post("/api/deposits")
    .send({ amount: 10, currency: "btc" })
    .expect(201);
  s.db.prepare("UPDATE deposits SET updated=0").run();
  await s.tick();
  await s.tick();
  assert.equal(checks, 1);
  assert.equal(credits(balance(s.db, user.id).total), 10000);
});

test("saved invoices remain viewable during processor outages without trusting a mismatched status", async (t) => {
  let invoice;
  let status = "offline";
  const base = await mockServer(t, async (req, res) => {
    if (req.method === "POST") {
      const body = await readJSON(req);
      invoice = {
        payment_id: "saved-42",
        order_id: body.order_id,
        price_amount: body.price_amount,
        price_currency: "usd",
        pay_currency: "btc",
        pay_address: "saved-address",
        pay_amount: 0.001,
        payment_status: "waiting",
      };
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(invoice));
    }
    if (status === "offline") {
      res.writeHead(503);
      return res.end();
    }
    res.writeHead(200, { "content-type": "application/json" });
    if (status === "empty") return res.end("null");
    res.end(
      JSON.stringify({
        ...invoice,
        payment_id:
          status === "mismatch" ? "another-invoice" : invoice.payment_id,
        payment_status: status === "finished" ? "finished" : "waiting",
      }),
    );
  });
  const s = fixture(t, {
    testMode: false,
    paymentKey: "fixture",
    paymentSecret: "fixture",
    paymentBase: base,
    publicUrl: "https://payments.example.invalid",
  });
  const { agent, user } = await register(s.app);
  const created = await agent
    .post("/api/deposits")
    .send({ amount: 10, currency: "btc" })
    .expect(201);
  const cached = await agent
    .get(`/api/deposits/${created.body.id}`)
    .expect(200);
  assert.equal(cached.body.status, "waiting");
  assert.equal(cached.body.payload.pay_address, "saved-address");
  assert.match(cached.body.refreshError, /last verified invoice details/);
  assert.equal(balance(s.db, user.id).total, 0);
  status = "empty";
  const empty = await agent.get(`/api/deposits/${created.body.id}`).expect(200);
  assert.match(empty.body.refreshError, /last verified invoice details/);
  status = "mismatch";
  const wrong = await agent.get(`/api/deposits/${created.body.id}`).expect(502);
  assert.equal(wrong.body.error.code, "payment_identity_mismatch");
  status = "finished";
  const settled = await agent
    .get(`/api/deposits/${created.body.id}`)
    .expect(200);
  assert.equal(settled.body.status, "finished");
  assert.equal(settled.body.refreshError, undefined);
  assert.equal(credits(balance(s.db, user.id).total), 10000);
});

test("invalid upstream token counts fall back to estimates and never strand reservations", async (t) => {
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { choices: [{ delta: { content: "A useful answer" } }] });
    event(res, {
      choices: [],
      usage: { prompt_tokens: -100, completion_tokens: "oops" },
    });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 10000000, "invalid-usage-test");
  const key = await keyFor(agent);
  const result = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(200);
  assert.ok(result.body.usage.prompt_tokens > 0);
  assert.ok(result.body.usage.completion_tokens > 0);
  assert.ok(result.body.anonyma.credits_charged > 0);
  assert.equal(balance(s.db, user.id).held, 0);
});

test("malformed API bodies return client errors and wallet linking requires a session", async (t) => {
  const s = fixture(t);
  await request(s.app)
    .post("/api/auth/register")
    .set("Content-Type", "application/json")
    .expect(400);
  await request(s.app).post("/api/auth/register").send([]).expect(400);
  await request(s.app)
    .post("/api/auth/wallet/challenge")
    .send({ address: Wallet.createRandom().address, link: true })
    .expect(401);
  const { agent } = await register(s.app);
  await agent.delete("/api/account").expect(400);
  await agent.get("/api/me").expect(200);
});

test("password recovery invalidates older email recovery and login codes", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const email = "recovery@example.invalid";
  const link = (
    await agent
      .post("/api/auth/email/send")
      .send({ email, purpose: "link" })
      .expect(200)
  ).body;
  await agent
    .post("/api/auth/email/verify")
    .send({ id: link.id, code: link.testCode })
    .expect(200);
  const old = (
    await agent
      .post("/api/auth/email/send")
      .send({ email, purpose: "recover" })
      .expect(200)
  ).body;
  const login = (
    await agent
      .post("/api/auth/email/send")
      .send({ email, purpose: "login" })
      .expect(200)
  ).body;
  const reset = (
    await agent
      .post("/api/auth/email/send")
      .send({ email, purpose: "recover" })
      .expect(200)
  ).body;
  await agent
    .post("/api/auth/email/verify")
    .send({
      id: reset.id,
      code: reset.testCode,
      password: "a-new-long-password",
    })
    .expect(200);
  await request(s.app)
    .post("/api/auth/email/verify")
    .send({ id: old.id, code: old.testCode, password: "another-long-password" })
    .expect(400);
  await request(s.app)
    .post("/api/auth/email/verify")
    .send({ id: login.id, code: login.testCode })
    .expect(400);
  await request(s.app)
    .post("/api/auth/password")
    .send({ username: "tester", password: "a-new-long-password" })
    .expect(200);
});

test("null image parts and malformed generation IDs fail before reserving funds", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  await agent
    .post("/api/chat")
    .send({ ...prompt, messages: [{ role: "user", content: [null] }] })
    .expect(400);
  for (const requestId of [{}, [], 42, ""]) {
    await agent
      .post("/api/chat")
      .send({ ...prompt, requestId })
      .expect(400);
    await agent
      .post("/api/images")
      .send({ model: imageModel, prompt: "hello", requestId })
      .expect(400);
  }
  assert.equal(balance(s.db, user.id).held, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
});

test("request receipts are recoverable after completion and isolated by account", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const other = await register(s.app, "other");
  await agent
    .post("/api/chat")
    .send({ ...prompt, requestId: "recover-me" })
    .expect(200);
  const result = (await agent.get("/api/requests/recover-me").expect(200)).body;
  assert.equal(result.status, "settled");
  assert.ok(result.receipt.credits_charged > 0);
  await other.agent.get("/api/requests/recover-me").expect(404);
  await request(s.app).get("/api/requests/recover-me").expect(401);
});

test("a later chat-image download failure bills and exposes saved partial output", async (t) => {
  const png = readFileSync(
    new URL("../data/test-image.png", import.meta.url),
  ).toString("base64");
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, {
      choices: [
        {
          delta: {
            images: [
              { image_url: { url: "data:image/png;base64," + png } },
              { image_url: { url: "https://untrusted.invalid/image.png" } },
            ],
          },
        },
      ],
    });
    event(res, { choices: [{ delta: {}, finish_reason: "stop" }] });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, { testMode: false, gatewayKey: "fixture", gateway });
  const { agent, user } = await register(s.app);
  addCredit(
    s.db,
    user.id,
    usdUnits(10),
    "fund-partial-image",
    "deposit",
    "Test-only funding in temporary isolated database",
  );
  const response = await agent
    .post("/api/chat")
    .send({
      model: chatModel,
      messages: prompt.messages,
      requestId: "partial-image",
    })
    .expect(200);
  assert.match(response.text, /error/);
  const state = (await agent.get("/api/requests/partial-image")).body;
  assert.equal(state.status, "settled");
  assert.ok(state.receipt.credits_charged > 0);
  assert.equal(balance(s.db, user.id).held, 0);
  const media = (await agent.get("/api/media")).body.data;
  assert.equal(media.length, 1);
  assert.equal(media[0].cost, state.receipt.credits_charged);
  assert.match(response.text, new RegExp(media[0].id));
  const stored = s.db
    .prepare("SELECT content FROM messages WHERE role='assistant'")
    .get();
  assert.equal(JSON.parse(stored.content).images.length, 1);
});

test("HTTP API contract and downloaded CLI reflect the configured installation without leaking configuration", async (t) => {
  const s = fixture(t, {
    publicUrl: "https://anonyma.example.invalid",
    gatewayKey: "secret-not-for-contract",
  });
  const doc = (await request(s.app).get("/api/openapi.json").expect(200)).body;
  assert.equal(doc.openapi, "3.1.0");
  assert.ok(doc.paths["/api/requests/{id}"]);
  assert.ok(!JSON.stringify(doc).includes("secret-not-for-contract"));
  const cli = (await request(s.app).get("/cli.mjs").expect(200)).text;
  assert.match(cli, /https:\/\/anonyma\.example\.invalid\/v1/);
  assert.ok(!cli.includes("secret-not-for-contract"));
});
test("behind a trusted proxy, rate limits apply per client instead of site-wide", async (t) => {
  const s = fixture(t);
  const signUp = (name, ip) =>
    request(s.app)
      .post("/api/auth/register")
      .set("X-Forwarded-For", ip)
      .send({ username: name, password: "test-password-long" });
  for (let i = 0; i < 10; i++)
    assert.equal((await signUp("busy" + i, "203.0.113.7")).status, 201);
  assert.equal((await signUp("busy10", "203.0.113.7")).status, 429);
  // A different visitor behind the same proxy keeps their own allowance.
  assert.equal((await signUp("other0", "198.51.100.9")).status, 201);

  // Without a trusted proxy the forwarded header is ignored, not believed.
  const direct = fixture(t, { trustProxy: false });
  for (let i = 0; i < 10; i++)
    await request(direct.app)
      .post("/api/auth/register")
      .set("X-Forwarded-For", "192.0.2." + i)
      .send({ username: "spoof" + i, password: "test-password-long" })
      .expect(201);
  await request(direct.app)
    .post("/api/auth/register")
    .set("X-Forwarded-For", "192.0.2.99")
    .send({ username: "spoof10", password: "test-password-long" })
    .expect(429);
});
test("gateway account and throttling refusals report an outage and release funds", async (t) => {
  let status = 402;
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Operator account detail" } }));
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "refusal-fund");
  const key = await keyFor(agent);
  const before = balance(s.db, user.id).total;
  const errors = t.mock.method(console, "error", () => {});
  const unfunded = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(503);
  assert.equal(unfunded.body.error.code, "provider_unavailable");
  assert.doesNotMatch(unfunded.body.error.message, /Operator account/);
  assert.equal(errors.mock.callCount(), 1);
  status = 429;
  const busy = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(503);
  assert.equal(busy.body.error.code, "provider_busy");
  // A refused video submission is released, not parked for reconciliation.
  status = 401;
  await agent
    .post("/api/videos")
    .send({
      model: "kling-2.5-turbo",
      prompt: "Clip",
      ratio: "16:9",
      duration: "5",
    })
    .expect(503);
  assert.equal(
    s.db.prepare("SELECT status FROM videos").get().status,
    "failed",
  );
  assert.equal(balance(s.db, user.id).total, before);
  assert.equal(balance(s.db, user.id).held, 0);
});
test("a stopped chat is cancelled once the provider accepts and charges only the prompt", async (t) => {
  let late = null; // "accept" or "refuse" after a delay, else accept now
  let received;
  let acceptedAt = 0,
    cancelledAt = 0;
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    received?.();
    res.on("close", () => (cancelledAt = Date.now()));
    if (late) {
      setTimeout(() => {
        if (late === "refuse") return res.writeHead(400).end("{}");
        acceptedAt = Date.now();
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": accepted\n\n");
      }, 300);
      return;
    }
    // Accept the request, then produce nothing until the client leaves.
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": accepted\n\n");
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const server = s.app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((r) => server.close(r));
  });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "stop-fund");
  const key = await keyFor(agent);
  const url = `http://127.0.0.1:${server.address().port}/v1/chat/completions`;
  async function stopEarly(afterGatewayMs) {
    const gatewaySawIt = new Promise((r) => (received = r));
    const controller = new AbortController();
    const pending = fetch(url, {
      method: "POST",
      headers: {
        authorization: "Bearer " + key.key,
        "content-type": "application/json",
      },
      body: JSON.stringify({ ...prompt, stream: true }),
      signal: controller.signal,
    })
      .then((r) => r.text())
      .catch(() => {});
    await gatewaySawIt;
    await new Promise((r) => setTimeout(r, afterGatewayMs));
    controller.abort();
    await pending;
    for (let i = 0; i < 100; i++) {
      const hold = s.db
        .prepare("SELECT * FROM holds ORDER BY rowid DESC LIMIT 1")
        .get();
      if (hold.status !== "held") return hold;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw Error("Reservation was never finalized.");
  }
  const accepted = await stopEarly(100);
  assert.equal(accepted.status, "settled");
  const receipt = JSON.parse(accepted.result);
  assert.ok(receipt.charged > 0, "the prompt is billed");
  assert.ok(receipt.charged < accepted.amount, "output is not billed");
  // The client leaves before the provider answers: the upstream request is
  // kept until the provider accepts, then cancelled and billed as a stop.
  late = "accept";
  const leftEarly = await stopEarly(20);
  assert.equal(leftEarly.status, "settled");
  assert.ok(JSON.parse(leftEarly.result).charged > 0, "the prompt is billed");
  assert.ok(
    acceptedAt > 0 && cancelledAt >= acceptedAt,
    "cancelled after acceptance",
  );
  // If the provider refuses instead, nothing is charged.
  const before = balance(s.db, user.id).total;
  late = "refuse";
  const refused = await stopEarly(20);
  assert.equal(refused.status, "released");
  assert.equal(balance(s.db, user.id).total, before);
  assert.equal(balance(s.db, user.id).held, 0);
});
test("costs above a reservation are absorbed but recorded for the operator", async (t) => {
  const s = fixture(t);
  const { user } = await register(s.app);
  const warnings = t.mock.method(console, "warn", () => {});
  reserve(s.db, { id: "over", user: user.id, amount: 1000 });
  const receipt = settle(s.db, "over", 1500);
  assert.equal(receipt.charged, 1000);
  assert.equal(receipt.uncovered, undefined, "not exposed in user receipts");
  const hold = s.db.prepare("SELECT * FROM holds WHERE id='over'").get();
  assert.equal(hold.uncovered, 500);
  assert.equal(warnings.mock.callCount(), 1);
  assert.doesNotMatch(warnings.mock.calls[0].arguments[0], /\bover\b/);
  reserve(s.db, { id: "under", user: user.id, amount: 1000 });
  settle(s.db, "under", 400);
  assert.equal(
    s.db.prepare("SELECT uncovered FROM holds WHERE id='under'").get()
      .uncovered,
    0,
  );
});
test("image sizes price case-insensitively and unpublished sizes are refused before reserving", async (t) => {
  const { generationPrice, unpublishedImageOption } =
    await import("../server/core.js");
  const dir = mkdtempSync(join(tmpdir(), "anonyma-sized-image-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "models.json");
  const model = {
    id: "fixture/sized-image",
    name: "Sized image",
    type: "image",
    status: "live",
    capabilities: { accepts_prompt: true, accepts_resolution: true },
    pricing: {
      type: "per_generation",
      variants: [
        {
          quality: "standard",
          options: [
            { size: "default", price: 0.092 },
            { size: "1k", price: 0.092 },
            { size: "2k", price: 0.138 },
            { size: "4K", price: 0.184 },
          ],
        },
      ],
    },
  };
  writeFileSync(
    catalogPath,
    JSON.stringify({ updatedAt: new Date().toISOString(), data: [model] }),
  );
  // The provider documents "2K"; the price list spells it "2k".
  assert.equal(generationPrice(model, { resolution: "2K" }), 0.138);
  assert.equal(generationPrice(model, { size: "4k" }), 0.184);
  assert.equal(unpublishedImageOption(model, { ratio: "16:9" }), null);
  assert.deepEqual(unpublishedImageOption(model, { resolution: "8K" }), {
    requested: "8K",
    published: ["1k", "2k", "4K"],
  });

  let sent;
  const gateway = await mockServer(t, async (req, res) => {
    sent = await readJSON(req);
    res.writeHead(200, { "content-type": "application/json" });
    // No cost reported: billing must use the requested option's price.
    res.end(
      JSON.stringify({
        data: [
          {
            b64_json: readFileSync(
              new URL("../data/test-image.png", import.meta.url),
            ).toString("base64"),
          },
        ],
      }),
    );
  });
  const s = fixture(t, {
    testMode: false,
    gateway,
    gatewayKey: "fixture",
    catalogPath,
  });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "sized-image-fund", "test_credit");
  const refused = await agent
    .post("/api/images")
    .send({ model: model.id, prompt: "Mountains", resolution: "8K" })
    .expect(400);
  assert.equal(refused.body.error.code, "unpriced_option");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  const before = balance(s.db, user.id).total;
  await agent
    .post("/api/images")
    .send({ model: model.id, prompt: "Mountains", resolution: "2K" })
    .expect(200);
  assert.equal(sent.resolution, "2K");
  assert.equal(before - balance(s.db, user.id).total, usdUnits(0.138));
});
test("dedicated image models are refused by chat endpoints before reserving", async (t) => {
  const { path: catalogPath, model } = dedicatedImageCatalog(t);
  const s = fixture(t, {
    testMode: false,
    gateway: "http://127.0.0.1:9",
    gatewayKey: "fixture",
    catalogPath,
  });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "image-chat-fund", "test_credit");
  const key = await keyFor(agent);
  const api = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send({ ...prompt, model: model.id })
    .expect(400);
  assert.equal(api.body.error.code, "unsupported_model");
  await agent
    .post("/api/chat")
    .send({ ...prompt, model: model.id })
    .expect(400);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
});
test("interrupted streams bill PPQ input/output token aliases", async (t) => {
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { choices: [{ delta: { content: "Partial" } }] });
    event(res, {
      choices: [],
      usage: { input_tokens: 5000, output_tokens: 3 },
    });
    res.end(); // no [DONE]: the connection ends before completion
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "interrupt-alias-fund", "test_credit");
  const key = await keyFor(agent);
  const before = balance(s.db, user.id).total;
  const r = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(502);
  assert.equal(r.body.error.code, "provider_interrupted");
  // The reported 5,000 prompt tokens exceed this small request's hold: the
  // user pays the hold and the rest is recorded as operator-absorbed.
  const hold = s.db.prepare("SELECT amount, uncovered FROM holds").get();
  assert.equal(before - balance(s.db, user.id).total, hold.amount);
  assert.equal(
    hold.amount + hold.uncovered,
    usdUnits((5000 * 0.15 + 3 * 1.25) / 1e6),
  );
});
test("generated images are stored with the type their bytes show", async (t) => {
  const { createMediaStore } = await import("../server/media.js");
  const { database } = await import("../server/core.js");
  const dir = mkdtempSync(join(tmpdir(), "anonyma-image-type-"));
  const db = database(join(dir, "db.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  db.prepare("INSERT INTO users(id,created) VALUES(?,?)").run("u1", 1);
  const store = createMediaStore(db, {
    mediaPath: dir,
    secret: "fixture",
    mediaHosts: [],
    origin: "http://localhost:5175",
  });
  const asPng = (bytes) => "data:image/png;base64," + bytes.toString("base64");
  const jpeg = Buffer.from("ffd8ffe000104a46494600010100", "hex");
  const png = readFileSync(new URL("../data/test-image.png", import.meta.url));
  assert.equal(
    (await store.saveMedia("u1", "image", asPng(jpeg))).mime,
    "image/jpeg",
  );
  assert.equal(
    (await store.saveMedia("u1", "image", asPng(png))).mime,
    "image/png",
  );
});
test("chat holds headroom for pricier routing but falls back when the balance is short", async (t) => {
  let upstream = 0.000001;
  const gateway = await mockServer(t, async (req, res) => {
    await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { choices: [{ delta: { content: "ready" } }] });
    event(res, {
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 10,
        cost: upstream,
        cost_details: { upstream_inference_cost: upstream },
      },
    });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "headroom-fund", "test_credit");
  const key = await keyFor(agent);
  const ask = (auth, requestId) =>
    request(s.app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer " + auth)
      .set("Idempotency-Key", requestId)
      .send(prompt)
      .expect(200);
  const holdFor = (owner, requestId) =>
    s.db.prepare("SELECT * FROM holds WHERE id=?").get(`${owner}:${requestId}`);
  await ask(key.key, "learn-estimate");
  const estimate = holdFor(user.id, "learn-estimate").amount / 4;

  // The provider routes to a model three times pricier than its list price.
  upstream = (3 * estimate) / 1e7 / 1.055;
  const before = balance(s.db, user.id).total;
  await ask(key.key, "pricier-route");
  const pricier = holdFor(user.id, "pricier-route");
  assert.equal(pricier.uncovered, 0);
  assert.equal(
    before - balance(s.db, user.id).total,
    usdUnits(upstream * 1.055),
  );

  // A balance that covers the estimate but not the headroom still works.
  upstream = 0.000001;
  const other = await register(s.app, "short-balance");
  addCredit(s.db, other.user.id, estimate * 2, "short-fund", "test_credit");
  const otherKey = await keyFor(other.agent);
  await ask(otherKey.key, "short");
  assert.equal(holdFor(other.user.id, "short").amount, estimate);
});
test("web search sends the web plugin, returns citations and bills at least the search fee", async (t) => {
  let sent;
  const gateway = await mockServer(t, async (req, res) => {
    sent = await readJSON(req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, {
      choices: [
        {
          delta: {
            content: "Here is today's news.",
            annotations: [
              {
                type: "url_citation",
                url_citation: {
                  url: "https://example.com/a",
                  title: "Example A",
                },
              },
              {
                type: "url_citation",
                url_citation: {
                  url: "https://example.com/a",
                  title: "Duplicate",
                },
              },
              {
                type: "url_citation",
                url_citation: { url: "javascript:alert(1)", title: "Bad" },
              },
            ],
          },
        },
      ],
    });
    // The reported inference cost excludes the search fee in this fixture.
    event(res, {
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.000001 },
    });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "search-fund", "test_credit");
  const before = balance(s.db, user.id).total;
  const r = await agent
    .post("/api/chat")
    .send({ ...prompt, web_search: true })
    .expect(200);
  assert.deepEqual(sent.plugins, [{ id: "web", max_results: 5 }]);
  const final = r.text
    .split("\n\n")
    .filter((l) => l.includes('"anonyma"'))
    .map((l) => JSON.parse(l.slice(6)))
    .pop();
  assert.deepEqual(final.anonyma.citations, [
    { url: "https://example.com/a", title: "Example A" },
  ]);
  const charged = before - balance(s.db, user.id).total;
  assert.ok(charged >= usdUnits(0.0211), "the search fee is always covered");
  const saved = s.db
    .prepare("SELECT content FROM messages WHERE role='assistant'")
    .get();
  assert.equal(JSON.parse(saved.content).citations.length, 1);

  // Without the toggle, no plugin is sent and no fee is added.
  await agent.post("/api/chat").send(prompt).expect(200);
  assert.equal(sent.plugins, undefined);
});
