import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance, credits, uid, now } from "../server/core.js";
import { UPDATES } from "../server/releases.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
function fixture(t, released = "mvp,api,mcp") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-mcp-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released,
    mvpModels: [MODEL],
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
    await agent.post("/api/keys").send({ name: "mcp", cap }).expect(201)
  ).body;
}
const rpc = (svc, auth, body) => {
  const r = request(svc.app).post("/mcp");
  if (auth) r.set("Authorization", auth);
  return r.send(body);
};

test("the full MCP handshake runs one ledger charge and reports the right balance", async (t) => {
  const svc = fixture(t);
  const { agent, user } = await register(svc.app);
  const key = await keyFor(agent);
  const auth = "Bearer " + key.key;
  const before = balance(svc.db, user.id).total;
  const ledgerBefore = svc.db
    .prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=?")
    .get(user.id).n;

  const init = await rpc(svc, auth, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18" },
  }).expect(200);
  assert.equal(init.body.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.body.result.capabilities, {
    tools: { listChanged: false },
  });
  assert.equal(init.body.result.serverInfo.name, "anonyma");

  await rpc(svc, auth, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
  }).expect(202);

  const list = await rpc(svc, auth, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  }).expect(200);
  assert.deepEqual(
    list.body.result.tools.map((tool) => tool.name).sort(),
    ["ask", "balance", "list_models"],
  );
  for (const tool of list.body.result.tools)
    assert.equal(tool.inputSchema.type, "object");

  const call = await rpc(svc, auth, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "ask",
      arguments: { model: MODEL, prompt: "Hello from the MCP test" },
    },
  }).expect(200);
  const result = call.body.result;
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /Hello from the MCP test/);
  assert.equal(result.structuredContent.model, MODEL);
  assert.ok(result.structuredContent.usage.total_tokens > 0);
  assert.ok(result.structuredContent.credits_charged > 0);

  const ledgerRows = svc.db
    .prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=?")
    .get(user.id).n;
  assert.equal(ledgerRows - ledgerBefore, 1);
  const after = balance(svc.db, user.id);
  assert.equal(after.held, 0);
  assert.equal(
    credits(before - after.total),
    result.structuredContent.credits_charged,
  );
  assert.equal(credits(after.available), result.structuredContent.balance_after);
});

test("the balance tool reports available and held credits", async (t) => {
  const svc = fixture(t);
  const { agent, user } = await register(svc.app);
  const key = await keyFor(agent);
  const r = await rpc(svc, "Bearer " + key.key, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "balance", arguments: {} },
  }).expect(200);
  const b = balance(svc.db, user.id);
  assert.deepEqual(r.body.result.structuredContent, {
    available: credits(b.available),
    held: credits(b.held),
  });
});

test("the list_models tool lists callable chat models with pricing", async (t) => {
  const svc = fixture(t);
  const { agent } = await register(svc.app);
  const key = await keyFor(agent);
  const r = await rpc(svc, "Bearer " + key.key, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "list_models" },
  }).expect(200);
  const models = r.body.result.structuredContent.models;
  assert.deepEqual(
    models.map((m) => m.id),
    [MODEL],
  );
  assert.ok(models[0].context_length > 0);
  assert.ok(models[0].input_price_per_1m_credits > 0);
  assert.ok(models[0].output_price_per_1m_credits > 0);
});

test("insufficient credits are an isError tool result, not a protocol error, and charge nothing", async (t) => {
  const svc = fixture(t);
  const { agent, user } = await register(svc.app);
  const key = await keyFor(agent);
  const drain = balance(svc.db, user.id).available;
  svc.db
    .prepare(
      "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(uid("l_"), user.id, -drain, "test_drain", uid("r_"), null, "Drain for test", now());
  assert.equal(balance(svc.db, user.id).available, 0);
  const ledgerBefore = svc.db
    .prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=?")
    .get(user.id).n;

  const r = await rpc(svc, "Bearer " + key.key, {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "ask", arguments: { model: MODEL, prompt: "Hello" } },
  }).expect(200);
  assert.equal(r.body.result.isError, true);
  assert.match(r.body.result.content[0].text, /credits/i);
  const ledgerAfter = svc.db
    .prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=?")
    .get(user.id).n;
  assert.equal(ledgerAfter, ledgerBefore);
  assert.equal(
    svc.db
      .prepare("SELECT COUNT(*) n FROM holds WHERE user_id=? AND status='held'")
      .get(user.id).n,
    0,
  );
});

test("auth failures return 401 with a WWW-Authenticate header", async (t) => {
  const svc = fixture(t);
  const noAuth = await rpc(svc, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(401);
  assert.equal(noAuth.headers["www-authenticate"], 'Bearer realm="anonyma"');
  const badKey = await rpc(svc, "Bearer not-a-real-key", {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(401);
  assert.equal(badKey.headers["www-authenticate"], 'Bearer realm="anonyma"');
});

test("GET and DELETE are refused; a batch mixes requests and notifications correctly", async (t) => {
  const svc = fixture(t);
  const { agent } = await register(svc.app);
  const key = await keyFor(agent);
  const auth = "Bearer " + key.key;
  await request(svc.app).get("/mcp").set("Authorization", auth).expect(405);
  await request(svc.app)
    .delete("/mcp")
    .set("Authorization", auth)
    .expect(405);

  const batch = await rpc(svc, auth, [
    { jsonrpc: "2.0", id: 1, method: "ping" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]).expect(200);
  assert.equal(batch.body.length, 2);
  assert.deepEqual(
    batch.body.map((m) => m.id),
    [1, 2],
  );

  const onlyNotifications = await rpc(svc, auth, [
    { jsonrpc: "2.0", method: "notifications/initialized" },
  ]).expect(202);
  assert.equal(onlyNotifications.text, "");
});

test("unknown methods answer -32601 and unknown tools answer -32602", async (t) => {
  const svc = fixture(t);
  const { agent } = await register(svc.app);
  const key = await keyFor(agent);
  const auth = "Bearer " + key.key;

  const badMethod = await rpc(svc, auth, {
    jsonrpc: "2.0",
    id: 1,
    method: "bogus/method",
  }).expect(200);
  assert.equal(badMethod.body.error.code, -32601);

  const badTool = await rpc(svc, auth, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name: "not_a_real_tool" },
  }).expect(200);
  assert.equal(badTool.body.error.code, -32602);

  // A notification for an unknown method still gets no reply at all.
  await rpc(svc, auth, { jsonrpc: "2.0", method: "bogus/notification" }).expect(
    202,
  );
});

test("malformed JSON and an invalid envelope are reported as JSON-RPC errors", async (t) => {
  const svc = fixture(t);
  const { agent } = await register(svc.app);
  const key = await keyFor(agent);
  const auth = "Bearer " + key.key;

  const badJson = await request(svc.app)
    .post("/mcp")
    .set("Authorization", auth)
    .set("Content-Type", "application/json")
    .send("{not valid json")
    .expect(400);
  assert.equal(badJson.body.error.code, -32700);

  const badEnvelope = await rpc(svc, auth, { id: 1, method: "ping" }).expect(
    200,
  );
  assert.equal(badEnvelope.body.error.code, -32600);

  const noMethod = await rpc(svc, auth, { jsonrpc: "2.0", id: 2 }).expect(200);
  assert.equal(noMethod.body.error.code, -32600);
});

test("the mcp update is registered and gates on both mcp and api", async (t) => {
  const entry = UPDATES.find((u) => u.id === "mcp");
  assert.ok(entry);
  assert.equal(entry.title, "MCP Server");
  assert.equal(entry.tagline, "Your balance, inside any AI tool.");
  assert.equal(entry.points.length, 3);
  // Committed as false until its "Release …" commit flips it to true.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");

  const mvpOnly = fixture(t, "mvp");
  const blocked = await rpc(mvpOnly, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(403);
  assert.equal(blocked.body.error.code, "feature_unreleased");
  assert.equal(blocked.body.error.message, "MCP Server is coming soon.");

  // Released as a client-facing update but not the API it runs on top of.
  const mcpOnly = fixture(t, "mvp,mcp");
  const stillBlocked = await rpc(mcpOnly, null, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(403);
  assert.equal(stillBlocked.body.error.code, "feature_unreleased");
  assert.equal(
    stillBlocked.body.error.message,
    "Developer API & CLI is coming soon.",
  );

  const both = fixture(t, "mvp,mcp,api");
  const { agent } = await register(both.app);
  const key = await keyFor(agent);
  const ok = await rpc(both, "Bearer " + key.key, {
    jsonrpc: "2.0",
    id: 1,
    method: "ping",
  }).expect(200);
  assert.deepEqual(ok.body, { jsonrpc: "2.0", id: 1, result: {} });
});
