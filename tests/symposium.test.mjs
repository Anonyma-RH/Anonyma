import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import {
  defaultSymposiumModels,
  buildFusionMessages,
  totalEstimate,
} from "../src/symposium.js";

const chatModel = "google/gemini-2.5-flash";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-symposium-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function register(app) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: "tester", password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const ask = (mode) => ({
  model: chatModel,
  messages: [{ role: "user", content: "Hello from the symposium test" }],
  max_tokens: 50,
  ...(mode !== undefined ? { mode } : {}),
});

test("an optional symposium chat mode is stored on its conversation, and existing modes are unaffected", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);

  await agent.post("/api/chat").send(ask("symposium")).expect(200);
  await agent.post("/api/chat").send(ask("code")).expect(200);
  await agent.post("/api/chat").send(ask(undefined)).expect(200);
  // An unrecognised mode value still falls back to "chat", same as before
  // this endpoint accepted "symposium".
  await agent.post("/api/chat").send(ask("something-else")).expect(200);

  const rows = s.db
    .prepare("SELECT mode FROM conversations WHERE user_id=? ORDER BY created")
    .all(user.id);
  assert.deepEqual(
    rows.map((r) => r.mode),
    ["symposium", "code", "chat", "chat"],
  );
});

test("symposium conversations are excluded when GET /api/conversations is filtered by mode client-side", async (t) => {
  // The server keeps GET /api/conversations mode-agnostic (unchanged
  // behaviour); Symposium.jsx filters its own use of that list so it
  // doesn't clutter Chat history. This locks in the data the client filter
  // relies on: every conversation genuinely carries its own mode.
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  await agent.post("/api/chat").send(ask("symposium")).expect(200);
  await agent.post("/api/chat").send(ask("chat")).expect(200);

  const list = await agent.get("/api/conversations").expect(200);
  assert.equal(list.body.data.length, 2);
  const nonSymposium = list.body.data.filter((c) => c.mode !== "symposium");
  assert.equal(nonSymposium.length, 1);
  assert.equal(nonSymposium[0].mode, "chat");
  void user;
});

test("defaultSymposiumModels picks the first callable chat models and respects the requested count", () => {
  const models = [
    { id: "a", type: "chat", callable: true },
    { id: "b", type: "chat", callable: false },
    { id: "c", type: "image", callable: true },
    { id: "d", type: "chat", callable: true },
    { id: "e", type: "chat", callable: true },
  ];
  assert.deepEqual(defaultSymposiumModels(models), ["a", "d", "e"]);
  assert.deepEqual(defaultSymposiumModels(models, 2), ["a", "d"]);
  assert.deepEqual(defaultSymposiumModels([]), []);
});

test("buildFusionMessages labels each answer and skips empty ones, without echoing the answers verbatim as the question", () => {
  const messages = buildFusionMessages({
    question: "What is the capital of France?",
    answers: [
      { name: "Model A", text: "Paris." },
      { name: "Model B", text: "  " },
      { name: "Model C", text: "It's Paris, the capital." },
    ],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /one best answer/i);
  assert.equal(messages[1].role, "user");
  assert.match(messages[1].content, /What is the capital of France\?/);
  assert.match(messages[1].content, /### Model A\nParis\./);
  assert.match(messages[1].content, /### Model C\nIt's Paris, the capital\./);
  assert.doesNotMatch(messages[1].content, /Model B/);
});

test("totalEstimate sums resolved credit quotes and skips failed ones", () => {
  assert.equal(
    totalEstimate({
      a: { credits: 12 },
      b: { credits: 30 },
      c: { error: "Unavailable" },
    }),
    42,
  );
  assert.equal(totalEstimate({}), 0);
  assert.equal(totalEstimate(undefined), 0);
});
