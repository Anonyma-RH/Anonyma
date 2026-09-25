import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { UPDATES } from "../server/releases.js";
import { CONVERSATION_CAP, SYMPOSIUM_CAP } from "../server/routes/conversations.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));
import {
  defaultSymposiumModels,
  buildFusionMessages,
  totalEstimate,
} from "../src/symposium.js";

const chatModel = "google/gemini-2.5-flash";

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-symposium-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    // The server defaults to the MVP, so the default fixture opens every
    // update explicitly, as the other suites do.
    released: released ?? "all",
    // Gating fixtures release only part of the roadmap; the MVP list needs
    // the test model so requests reach the release gate.
    ...(released !== undefined ? { mvpModels: [chatModel] } : {}),
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
  // behaviour); Workspace.jsx leaves symposium runs out of the recent
  // conversations list. This locks in the data that filter relies on: every
  // conversation genuinely carries its own mode, and the account's
  // conversation export still includes symposium runs.
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  await agent.post("/api/chat").send(ask("symposium")).expect(200);
  await agent.post("/api/chat").send(ask("chat")).expect(200);

  const list = await agent.get("/api/conversations").expect(200);
  assert.equal(list.body.data.length, 2);
  const nonSymposium = list.body.data.filter((c) => c.mode !== "symposium");
  assert.equal(nonSymposium.length, 1);
  assert.equal(nonSymposium[0].mode, "chat");

  const exported = await agent.get("/api/conversations/export").expect(200);
  assert.deepEqual(
    exported.body.conversations.map((c) => c.mode).sort(),
    ["chat", "symposium"],
  );
  const symposium = exported.body.conversations.find((c) => c.mode === "symposium");
  assert.equal(symposium.user_id, user.id);
  assert.equal(symposium.messages[0].content, "Hello from the symposium test");
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
  // Fractional quotes sum without floating-point noise.
  assert.equal(
    totalEstimate({ a: { credits: 108.4857 }, b: { credits: 3.8562 }, c: { credits: 14.3555 } }),
    126.6974,
  );
  assert.equal(totalEstimate({}), 0);
  assert.equal(totalEstimate(undefined), 0);
});

test("defaultSymposiumModels prefers one model per provider", () => {
  const models = [
    { id: "c1", provider: "anthropic", type: "chat", callable: true },
    { id: "c2", provider: "anthropic", type: "chat", callable: true },
    { id: "g1", provider: "google", type: "chat", callable: true },
    { id: "o1", provider: "openai", type: "chat", callable: true },
  ];
  assert.deepEqual(defaultSymposiumModels(models), ["c1", "g1", "o1"]);
  assert.deepEqual(defaultSymposiumModels(models.slice(0, 2)), ["c1", "c2"]);
});

test("Symposium is refused under the MVP and works once released", async (t) => {
  const s = fixture(t, "mvp");
  const { agent } = await register(s.app);

  const refused = await agent.post("/api/chat").send(ask("symposium")).expect(403);
  assert.equal(refused.body.error.code, "feature_unreleased");
  assert.equal(refused.body.error.message, "Symposium is coming soon.");
  const refusedConvo = await agent
    .post("/api/conversations")
    .send({ mode: "symposium" })
    .expect(403);
  assert.equal(refusedConvo.body.error.code, "feature_unreleased");

  // Plain chat and other modes are unaffected.
  await agent.post("/api/chat").send(ask(undefined)).expect(200);
  await agent.post("/api/chat").send(ask("chat")).expect(200);
});

test("mvp,symposium releases Symposium", async (t) => {
  const s = fixture(t, "mvp,symposium");
  const { agent } = await register(s.app);
  await agent.post("/api/chat").send(ask("symposium")).expect(200);
  await agent.post("/api/conversations").send({ mode: "symposium" }).expect(201);
});

test("Symposium's gate adds to a request's other gates instead of replacing them", async (t) => {
  // Web search is still refused on a symposium request while search is
  // unreleased, and releasing search alone doesn't open Symposium.
  const s = fixture(t, "mvp,symposium");
  const { agent } = await register(s.app);
  const searched = await agent
    .post("/api/chat")
    .send({ ...ask("symposium"), web_search: true })
    .expect(403);
  assert.equal(searched.body.error.code, "feature_unreleased");
  assert.equal(searched.body.error.message, "Live Web Search is coming soon.");

  const other = fixture(t, "mvp,search");
  const { agent: agent2 } = await register(other.app);
  const refused = await agent2
    .post("/api/chat")
    .send({ ...ask("symposium"), web_search: true })
    .expect(403);
  assert.equal(refused.body.error.message, "Symposium is coming soon.");
});

test("symposium runs have their own cap and never evict ordinary chats", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const count = (mode) =>
    s.db
      .prepare(
        "SELECT COUNT(*) n FROM conversations WHERE user_id=? AND (mode IS 'symposium')=?",
      )
      .get(user.id, mode === "symposium" ? 1 : 0).n;
  const messagesOf = (id) =>
    s.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?").get(id).n;

  // The oldest ordinary chat and the oldest symposium run both have messages.
  await agent.post("/api/chat").send(ask(undefined)).expect(200);
  await agent.post("/api/chat").send(ask("symposium")).expect(200);
  const oldest = (mode) =>
    s.db
      .prepare("SELECT id FROM conversations WHERE user_id=? AND mode=? ORDER BY rowid LIMIT 1")
      .get(user.id, mode).id;
  const firstChat = oldest("chat"),
    firstRun = oldest("symposium");
  assert.ok(messagesOf(firstChat) > 0 && messagesOf(firstRun) > 0);

  // Fill the ordinary cap exactly, then run far more symposium conversations
  // than their own cap allows.
  const insert = s.db.prepare(
    "INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)",
  );
  for (let i = 1; i < CONVERSATION_CAP; i++)
    insert.run(`c_fill_${i}`, user.id, "Filler", "chat", Date.now(), Date.now());
  assert.equal(count("chat"), CONVERSATION_CAP);
  for (let i = 0; i < SYMPOSIUM_CAP + 10; i++)
    await agent.post("/api/conversations").send({ mode: "symposium" }).expect(201);

  // No ordinary chat was evicted; symposium runs stay at their own cap, and
  // the oldest run went with its messages.
  assert.equal(count("chat"), CONVERSATION_CAP);
  assert.ok(s.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(firstChat));
  assert.ok(messagesOf(firstChat) > 0);
  assert.equal(count("symposium"), SYMPOSIUM_CAP);
  assert.equal(s.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(firstRun), undefined);
  assert.equal(messagesOf(firstRun), 0);

  // A new ordinary chat still evicts only the oldest ordinary chat.
  await agent.post("/api/conversations").send({ mode: "chat" }).expect(201);
  assert.equal(count("chat"), CONVERSATION_CAP);
  assert.equal(count("symposium"), SYMPOSIUM_CAP);
  assert.equal(s.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(firstChat), undefined);
  assert.equal(messagesOf(firstChat), 0);
});

test("Symposium is registered as an unreleased update", () => {
  const update = UPDATES.find((u) => u.id === "symposium");
  assert.ok(update);
  assert.equal(update.title, "Symposium");
  assert.equal(update.tagline, "Ask several models at once.");
  assert.deepEqual(update.points, [
    "Up to four models side by side",
    "A receipt for every answer",
    "Fuse the answers into one",
  ]);
  // Committed as false until its "Release …" commit flips it to true.
  assert.equal(typeof committed[UPDATES.indexOf(update)], "boolean");
});

test("veilQuestion masks the question once for every column and the fusion step", async () => {
  const { veilQuestion, veilSegments } = await import("../src/symposium.js");
  const { createVeilState } = await import("../src/veil.js");
  const question = "Draft a reply to jane@example.com about Project Nimbus for jane@example.com.";

  // Veil off: the question goes out as typed.
  const plain = veilQuestion(question, { on: false, state: createVeilState(), words: ["Nimbus"] });
  assert.deepEqual(plain, { text: question, count: 0, entries: [] });

  // Veil on: emails and the user's words become tags; a repeated value
  // reuses its tag, and the entries list each tag once with its real value.
  const state = createVeilState();
  const masked = veilQuestion(question, { on: true, state, words: ["Nimbus"] });
  assert.equal(
    masked.text,
    "Draft a reply to [EMAIL_1] about Project [PRIVATE_1] for [EMAIL_1].",
  );
  assert.equal(masked.count, 3);
  assert.deepEqual(masked.entries, [
    { tag: "EMAIL_1", value: "jane@example.com" },
    { tag: "PRIVATE_1", value: "Nimbus" },
  ]);

  // The fusion request carries only the masked question and the (tagged)
  // answers, never the real values.
  const fusion = buildFusionMessages({
    question: masked.text,
    answers: [
      { name: "A", text: "Hi [EMAIL_1], about [PRIVATE_1]…" },
      { name: "B", text: "Dear [EMAIL_1]" },
    ],
  });
  const sent = JSON.stringify(fusion);
  assert.doesNotMatch(sent, /jane@example\.com|Nimbus/);
  assert.match(sent, /\[EMAIL_1\]/);

  // On screen the same map restores the values; unknown tags stay as written.
  assert.deepEqual(veilSegments("To [EMAIL_1] re [PRIVATE_1] and [KEY_9].", state.map), [
    { text: "To " },
    { tag: "EMAIL_1", value: "jane@example.com" },
    { text: " re " },
    { tag: "PRIVATE_1", value: "Nimbus" },
    { text: " and [KEY_9]." },
  ]);
  assert.deepEqual(veilSegments("", state.map), []);
});

test("pickerModels lists selected models first and filters the rest", async () => {
  const { pickerModels } = await import("../src/symposium.js");
  const models = [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
    { id: "g", name: "Gamma" },
  ];
  assert.deepEqual(pickerModels(models, ["g"], "").map((m) => m.id), ["g", "a", "b"]);
  assert.deepEqual(pickerModels(models, ["g"], "bet").map((m) => m.id), ["g", "b"]);
  assert.deepEqual(pickerModels(models, [], "", 1).map((m) => m.id), ["a"]);
});
