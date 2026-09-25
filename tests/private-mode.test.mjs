import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";
import { UPDATES } from "../server/releases.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// A Venice model (owned_by: "Venice") from the reference snapshot — private
// under the default PRIVATE_MODEL_PROVIDERS — and an ordinary one that isn't.
const privateModel = "venice/venice-uncensored-1-2";
const publicModel = "google/gemini-2.5-flash";
const prompt = (model) => ({
  model,
  messages: [{ role: "user", content: "Private mode test message" }],
  max_tokens: 50,
});

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-private-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released,
    // The MVP's default model list doesn't include either fixture model, so
    // gating tests that release the catalog partially need them added
    // explicitly to reach the release/model checks under test rather than
    // failing on model availability first.
    ...(released ? { mvpModels: [privateModel, publicModel] } : {}),
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

test("the update is registered as off by default", () => {
  const entry = UPDATES.find((u) => u.id === "private");
  assert.ok(entry, "private is registered in UPDATES");
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "Private Mode");
  assert.equal(entry.tagline, "Private models. Nothing saved.");
  assert.deepEqual(entry.points, [
    "Only models whose provider says it keeps no data",
    "Never saved on our servers",
    "Veil masks your details before sending",
  ]);
});

test("a private chat with a private model works and saves nothing", async (t) => {
  const s = fixture(t, "mvp,ephemeral,private");
  const { agent, user } = await register(s.app);
  const before = balance(s.db, user.id).total;
  const r = await agent
    .post("/api/chat")
    .send({ ...prompt(privateModel), private: true })
    .expect(200);
  assert.match(r.text, /\[DONE\]/);
  assert.match(r.text, /credits_charged/);
  assert.match(r.text, /"private":\{"provider":"Venice","stored":false\}/);
  assert.ok(!/"conversationId":"c_/.test(r.text), "no conversation id is streamed");
  assert.ok(balance(s.db, user.id).total < before, "billing still happens");
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n,
    0,
    "no conversation row",
  );
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM messages").get().n,
    0,
    "not even the user message is stored",
  );
  assert.equal(
    (await agent.get("/api/conversations")).body.data.length,
    0,
    "the sidebar list stays empty",
  );
});

test("a non-private model is refused, and a conversationId is refused", async (t) => {
  const s = fixture(t, "mvp,ephemeral,private");
  const { agent } = await register(s.app);
  const r = await agent
    .post("/api/chat")
    .send({ ...prompt(publicModel), private: true })
    .expect(400);
  assert.equal(r.body.error.code, "private_model_required");
  // Nothing was reserved or charged for the rejected request.
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM holds WHERE status='held'").get().n,
    0,
  );

  // A saved conversation from a normal, non-private chat...
  await agent.post("/api/chat").send(prompt(publicModel)).expect(200);
  const convo = (await agent.get("/api/conversations")).body.data[0];
  // ...can't be attached to a private request.
  const r2 = await agent
    .post("/api/chat")
    .send({ ...prompt(privateModel), private: true, conversationId: convo.id })
    .expect(400);
  assert.equal(r2.body.error.code, "invalid_request");
});

test("the models API flags private models only when released", async (t) => {
  const s1 = fixture(t, "mvp,ephemeral");
  const { agent: unreleasedAgent } = await register(s1.app, "priv-a");
  const unreleased = (await unreleasedAgent.get("/api/models")).body.data;
  assert.ok(
    unreleased.every((m) => m.private === undefined),
    "no model is flagged private before the release",
  );

  const s2 = fixture(t, "mvp,ephemeral,private");
  const { agent: releasedAgent } = await register(s2.app, "priv-b");
  const released = (await releasedAgent.get("/api/models")).body.data;
  assert.equal(released.find((m) => m.id === privateModel).private, true);
  assert.equal(released.find((m) => m.id === publicModel).private, undefined);
});

test("release gating: private needs ephemeral, and both work", async (t) => {
  // Neither released.
  const s1 = fixture(t, "mvp");
  const { agent: a1 } = await register(s1.app, "priv-n1");
  const r1 = await a1
    .post("/api/chat")
    .send({ ...prompt(privateModel), private: true })
    .expect(403);
  assert.equal(r1.body.error.code, "feature_unreleased");

  // private released, ephemeral not: still refused, naming Ephemeral Chats.
  const s2 = fixture(t, "mvp,private");
  const { agent: a2 } = await register(s2.app, "priv-n2");
  const r2 = await a2
    .post("/api/chat")
    .send({ ...prompt(privateModel), private: true })
    .expect(403);
  assert.equal(r2.body.error.code, "feature_unreleased");
  assert.equal(r2.body.error.message, "Ephemeral Chats is coming soon.");

  // ephemeral released, private not.
  const s3 = fixture(t, "mvp,ephemeral");
  const { agent: a3 } = await register(s3.app, "priv-n3");
  const r3 = await a3
    .post("/api/chat")
    .send({ ...prompt(privateModel), private: true })
    .expect(403);
  assert.equal(r3.body.error.message, "Private Mode is coming soon.");

  // Both released: works.
  const s4 = fixture(t, "mvp,ephemeral,private");
  const { agent: a4 } = await register(s4.app, "priv-n4");
  await a4
    .post("/api/chat")
    .send({ ...prompt(privateModel), private: true })
    .expect(200);
});
