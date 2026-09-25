import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { reserve, settle, release, credits, keySpendTotal } from "../server/core.js";
import { UPDATES } from "../server/releases.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const chatModel = "google/gemini-2.5-flash";
const prompt = {
  model: chatModel,
  messages: [{ role: "user", content: "Hello allowance test" }],
  max_tokens: 30,
};

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-allowances-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    // The server defaults to the MVP, so the default fixture opens every
    // update explicitly, as the other suites do.
    released: released ?? "all",
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
async function keyFor(agent) {
  return (
    await agent
      .post("/api/keys")
      .send({ name: "agent-key", cap: null })
      .expect(201)
  ).body;
}

test("an allowance blocks spending beyond it, counting in-flight holds", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const key = await keyFor(agent);
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: 5 })
    .expect(200);
  // 5 credits = 50,000 subcredits.
  reserve(s.db, { id: "al-1", user: user.id, amount: 30000, key: key.id });
  // A second concurrent hold would push the key over its allowance even
  // though nothing has settled yet.
  assert.throws(
    () =>
      reserve(s.db, { id: "al-2", user: user.id, amount: 30000, key: key.id }),
    /allowance/,
  );
  settle(s.db, "al-1", 20000);
  // 20,000 settled + a fresh 25,000 hold stays within the 50,000 allowance.
  reserve(s.db, { id: "al-3", user: user.id, amount: 25000, key: key.id });
  assert.throws(
    () =>
      reserve(s.db, { id: "al-4", user: user.id, amount: 10000, key: key.id }),
    /allowance/,
  );
  release(s.db, "al-3");
});

test("an exhausted allowance refuses a real request with 402", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: 0.001 })
    .expect(200);
  const r = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(402);
  assert.equal(r.body.error.code, "allowance_exhausted");
  // Nothing is spent yet, so the refusal names the request's worst case
  // rather than claiming the allowance is used up.
  assert.match(r.body.error.message, /^This request could cost up to .+ credits, more than the 0\.001 left on this key's allowance\.$/);
});

test("an allowance below the chat headroom still lets the base estimate through", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  const send = (id) =>
    request(s.app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer " + key.key)
      .set("Idempotency-Key", id)
      .send(prompt);
  await send("probe").expect(200);
  // The first request held the full headroom (holdMargin x the estimate).
  const probe = (await agent.get("/api/requests/probe").expect(200)).body;
  const headroom = probe.reserved;
  const spent = (await agent.get(`/api/keys/${key.id}/usage`).expect(200))
    .body.spent_total;
  // Leave half the headroom: more than the base estimate, less than the
  // headroom, so the hold falls back to the estimate instead of refusing.
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: spent + headroom / 2 })
    .expect(200);
  await send("fallback").expect(200);
  const held = (await agent.get("/api/requests/fallback").expect(200)).body;
  assert.ok(held.reserved < headroom, "held the base estimate, not the headroom");
});

test("pausing a key refuses requests until resumed", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  const paused = await agent
    .post(`/api/keys/${key.id}/pause`)
    .send({})
    .expect(200);
  assert.equal(paused.body.paused, true);
  const blocked = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(403);
  assert.equal(blocked.body.error.code, "key_paused");
  const resumed = await agent
    .post(`/api/keys/${key.id}/resume`)
    .send({})
    .expect(200);
  assert.equal(resumed.body.paused, false);
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(200);
});

test("an expired allowance refuses requests", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ expires_at: Date.now() - 1000 })
    .expect(200);
  const r = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(403);
  assert.equal(r.body.error.code, "key_expired");
});

test("keys without an allowance behave exactly as before", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  const usage = (await agent.get(`/api/keys/${key.id}/usage`).expect(200))
    .body;
  assert.equal(usage.allowance_total, null);
  assert.equal(usage.remaining, null);
  assert.equal(usage.expires_at, null);
  assert.equal(usage.paused, false);
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(200);
  const list = (await agent.get("/api/keys").expect(200)).body.data;
  const row = list.find((k) => k.id === key.id);
  assert.equal(row.allowance_total, null);
  assert.equal(row.paused, false);
});

test("usage numbers match the ledger", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: 50 })
    .expect(200);
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(prompt)
    .expect(200);
  const usage = (await agent.get(`/api/keys/${key.id}/usage`).expect(200))
    .body;
  assert.equal(usage.spent_total, credits(keySpendTotal(s.db, key.id)));
  assert.ok(usage.spent_total > 0);
  assert.equal(usage.in_flight, 0);
  assert.equal(usage.requests, 1);
  assert.ok(Math.abs(usage.remaining + usage.spent_total - 50) < 0.0001);
});

test("the account export carries each key's allowance settings", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  const expires = Date.now() + 86400000;
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: 12.5, expires_at: expires, label: "Research agent" })
    .expect(200);
  await agent.post(`/api/keys/${key.id}/pause`).send({}).expect(200);
  const out = (await agent.get("/api/account/export").expect(200)).body;
  const row = out.keys.find((k) => k.id === key.id);
  assert.equal(row.agent_label, "Research agent");
  assert.equal(row.allowance_total, 12.5);
  assert.equal(row.allowance_expires, expires);
  assert.equal(typeof row.paused_at, "number");
});

test("allowance management is owner-only", async (t) => {
  const s = fixture(t);
  const { agent: owner } = await register(s.app, "owner");
  const key = await keyFor(owner);
  const { agent: intruder } = await register(s.app, "intruder");
  await intruder.get(`/api/keys/${key.id}/usage`).expect(404);
  await intruder
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: 10 })
    .expect(404);
  await intruder.post(`/api/keys/${key.id}/pause`).send({}).expect(404);
  await intruder.post(`/api/keys/${key.id}/resume`).send({}).expect(404);
  await request(s.app).get(`/api/keys/${key.id}/usage`).expect(401);
});

test("Agent Allowances is registered and needs both api and allowances", async (t) => {
  const entry = UPDATES.find((u) => u.id === "allowances");
  assert.ok(entry, "the allowances update is registered");
  assert.equal(entry.title, "Agent Allowances");
  assert.equal(entry.tagline, "Give an agent a budget, not your wallet.");

  const mvp = fixture(t, "mvp");
  const { agent: a1 } = await register(mvp.app);
  const blocked1 = await a1.get("/api/keys/anything/usage").expect(403);
  assert.equal(blocked1.body.error.code, "feature_unreleased");

  const apiOnly = fixture(t, "mvp,api");
  const { agent: a2 } = await register(apiOnly.app);
  const blocked2 = await a2.get("/api/keys/anything/usage").expect(403);
  assert.equal(blocked2.body.error.code, "feature_unreleased");
  assert.equal(blocked2.body.error.message, "Agent Allowances is coming soon.");

  const both = fixture(t, "mvp,api,allowances");
  const { agent: a3 } = await register(both.app);
  const key = await keyFor(a3);
  await a3.get(`/api/keys/${key.id}/usage`).expect(200);

  // The published contract lists the allowance routes only once both
  // updates are live, never on the strength of api alone.
  const routes = [
    "/api/keys/{id}/allowance",
    "/api/keys/{id}/pause",
    "/api/keys/{id}/resume",
    "/api/keys/{id}/usage",
  ];
  const spec = async (app) =>
    (await request(app).get("/api/openapi.json").expect(200)).body.paths;
  const apiPaths = await spec(apiOnly.app);
  assert.ok(apiPaths["/api/keys"], "the api routes are listed");
  for (const path of routes) assert.equal(apiPaths[path], undefined, path);
  const bothPaths = await spec(both.app);
  for (const path of routes) assert.ok(bothPaths[path], path);
});
