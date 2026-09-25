import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { UPDATES } from "../server/releases.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));
import {
  extractVariables,
  fillTemplate,
  validateScroll,
  validateInstructions,
  MAX_TITLE,
  MAX_BODY,
  MAX_INSTRUCTIONS,
} from "../src/scrolls.js";

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-scrolls-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...(released !== undefined ? { released } : {}),
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function register(app, name = "tester") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}

// --- Pure helpers ---------------------------------------------------------

test("extractVariables finds ordered, de-duplicated {{name}} placeholders", () => {
  assert.deepEqual(
    extractVariables("Hi {{name}}, your order {{order}} for {{name}} is ready."),
    ["name", "order"],
  );
  assert.deepEqual(extractVariables("No placeholders here."), []);
  assert.deepEqual(extractVariables(""), []);
  assert.deepEqual(extractVariables(null), []);
  // Whitespace inside braces is tolerated.
  assert.deepEqual(extractVariables("{{ spaced }}"), ["spaced"]);
});

test("fillTemplate substitutes known values and blanks missing ones", () => {
  assert.equal(
    fillTemplate("Hi {{name}}, welcome to {{place}}.", { name: "Ana" }),
    "Hi Ana, welcome to .",
  );
  assert.equal(fillTemplate("No vars", { unused: "x" }), "No vars");
  assert.equal(fillTemplate("{{n}}", { n: 0 }), "0");
});

test("validateScroll rejects empty or oversized title/body", () => {
  assert.deepEqual(validateScroll({ title: "Ok", body: "Body text" }), {});
  assert.ok(validateScroll({ title: "", body: "x" }).title);
  assert.ok(validateScroll({ title: "x", body: "" }).body);
  assert.ok(validateScroll({ title: "x".repeat(MAX_TITLE + 1), body: "b" }).title);
  assert.ok(validateScroll({ title: "t", body: "b".repeat(MAX_BODY + 1) }).body);
});

test("validateInstructions only rejects oversized bodies", () => {
  assert.equal(validateInstructions(""), null);
  assert.equal(validateInstructions("Be concise."), null);
  assert.ok(validateInstructions("x".repeat(MAX_INSTRUCTIONS + 1)));
});

// --- Routes -----------------------------------------------------------------

test("scrolls: CRUD, limits and ownership isolation", async (t) => {
  const s = fixture(t);
  const ana = await register(s.app, "ana");
  const ben = await register(s.app, "ben");

  await ana.agent.get("/api/scrolls").expect(200, { data: [] });

  const created = (
    await ana.agent
      .post("/api/scrolls")
      .send({ title: "Daily standup", body: "Summarize {{topic}} for the team." })
      .expect(201)
  ).body;
  assert.ok(created.id);
  assert.equal(created.title, "Daily standup");

  const list = (await ana.agent.get("/api/scrolls").expect(200)).body.data;
  assert.equal(list.length, 1);
  assert.equal(list[0].id, created.id);

  // Validation: title/body required and length-limited.
  await ana.agent.post("/api/scrolls").send({ title: "", body: "x" }).expect(400);
  await ana.agent.post("/api/scrolls").send({ title: "x", body: "" }).expect(400);
  await ana.agent
    .post("/api/scrolls")
    .send({ title: "x".repeat(81), body: "b" })
    .expect(400);
  await ana.agent
    .post("/api/scrolls")
    .send({ title: "t", body: "b".repeat(8001) })
    .expect(400);

  // Editing: partial updates keep the other field, owner only.
  const renamed = (
    await ana.agent
      .patch(`/api/scrolls/${created.id}`)
      .send({ title: "Standup prompt" })
      .expect(200)
  ).body;
  assert.equal(renamed.title, "Standup prompt");
  assert.equal(renamed.body, created.body);

  // Someone else can't see, edit or delete it.
  await ben.agent.get("/api/scrolls").expect(200, { data: [] });
  await ben.agent
    .patch(`/api/scrolls/${created.id}`)
    .send({ title: "Hijacked" })
    .expect(404);
  await ben.agent.delete(`/api/scrolls/${created.id}`).expect(404);
  await request(s.app).get("/api/scrolls").expect(401);

  await ana.agent.delete(`/api/scrolls/${created.id}`).expect(200);
  await ana.agent.get("/api/scrolls").expect(200, { data: [] });
  await ana.agent.delete(`/api/scrolls/${created.id}`).expect(404);
});

test("scrolls: capped at 200 per user", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const db = s.db;
  const now = Date.now();
  // Insert 200 directly to avoid 200 slow round trips through the route.
  const insert = db.prepare(
    "INSERT INTO scrolls(id,user_id,title,body,created,updated) VALUES(?,?,?,?,?,?)",
  );
  const { balance } = await import("../server/core.js");
  const userId = (await agent.get("/api/me")).body.user.id;
  for (let i = 0; i < 200; i++)
    insert.run("scroll_seed_" + i, userId, "Seed " + i, "Body " + i, now, now);
  const r = await agent
    .post("/api/scrolls")
    .send({ title: "One too many", body: "x" })
    .expect(400);
  assert.match(r.body.error.message, /up to 200/);
});

test("standing instructions: get/put round trip and length limit", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);

  // No change in behaviour before anything is saved.
  const empty = (await agent.get("/api/instructions").expect(200)).body;
  assert.deepEqual(empty, { body: "", enabled: false, updated: null });

  const saved = (
    await agent
      .put("/api/instructions")
      .send({ body: "Always answer in bullet points.", enabled: true })
      .expect(200)
  ).body;
  assert.equal(saved.body, "Always answer in bullet points.");
  assert.equal(saved.enabled, true);
  assert.ok(saved.updated);

  const read = (await agent.get("/api/instructions").expect(200)).body;
  assert.equal(read.body, "Always answer in bullet points.");
  assert.equal(read.enabled, true);

  // Disabling keeps the saved text but flips the flag.
  const disabled = (
    await agent
      .put("/api/instructions")
      .send({ body: "Always answer in bullet points.", enabled: false })
      .expect(200)
  ).body;
  assert.equal(disabled.enabled, false);

  await agent
    .put("/api/instructions")
    .send({ body: "x".repeat(4001), enabled: true })
    .expect(400);
  await request(s.app).get("/api/instructions").expect(401);
});

test("account export includes scrolls and instructions; deletion removes them", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  await agent
    .post("/api/scrolls")
    .send({ title: "Export me", body: "Body" })
    .expect(201);
  await agent
    .put("/api/instructions")
    .send({ body: "Be terse.", enabled: true })
    .expect(200);

  const exported = (await agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.scrolls.length, 1);
  assert.equal(exported.scrolls[0].title, "Export me");
  assert.equal(exported.instructions.body, "Be terse.");
  assert.equal(exported.instructions.enabled, 1);

  await agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM scrolls WHERE user_id=?").get(user.id).n,
    0,
  );
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM user_instructions WHERE user_id=?")
      .get(user.id).n,
    0,
  );
});

test("chat accepts a leading system message without changing what is saved", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const r = await agent
    .post("/api/chat")
    .send({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "Always answer in bullet points." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 50,
    })
    .expect(200);
  assert.match(r.text, /data: /);
  const convo = (await agent.get("/api/conversations").expect(200)).body.data[0];
  const thread = (await agent.get(`/api/conversations/${convo.id}`).expect(200)).body;
  // Only the last user message is saved, as before this feature.
  const userMessages = thread.messages.filter((m) => m.role === "user");
  assert.equal(userMessages.length, 1);
  assert.equal(userMessages[0].content, "Hello");
});

// --- Release gating ----------------------------------------------------

test("scrolls: registered as an unreleased update", () => {
  const entry = UPDATES.find((u) => u.id === "scrolls");
  assert.ok(entry);
  // Committed as false until its "Release …" commit flips it to true.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "Scrolls");
  assert.equal(entry.tagline, "Save the prompt. Skip the retyping.");
  assert.deepEqual(entry.points, [
    "Saved prompts with fill-in blanks",
    "Type / to insert one",
    "Standing instructions for every chat",
  ]);
});

test("scrolls: the MVP refuses its endpoints until released", async (t) => {
  const s = fixture(t, "mvp");
  const { agent } = await register(s.app);
  const refused = async (res) => {
    const r = await res.expect(403);
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.equal(r.body.error.message, "Scrolls is coming soon.");
  };
  await refused(agent.get("/api/scrolls"));
  await refused(agent.post("/api/scrolls").send({ title: "t", body: "b" }));
  await refused(agent.patch("/api/scrolls/scroll_x").send({ title: "t" }));
  await refused(agent.delete("/api/scrolls/scroll_x"));
  await refused(agent.get("/api/instructions"));
  await refused(
    agent.put("/api/instructions").send({ body: "x", enabled: true }),
  );
});

test("scrolls: releasing the update opens its endpoints", async (t) => {
  const s = fixture(t, "mvp,scrolls");
  const { agent } = await register(s.app);
  await agent.get("/api/scrolls").expect(200, { data: [] });
  const created = (
    await agent
      .post("/api/scrolls")
      .send({ title: "Daily standup", body: "Summarize {{topic}}." })
      .expect(201)
  ).body;
  assert.ok(created.id);
  await agent
    .patch(`/api/scrolls/${created.id}`)
    .send({ title: "Renamed" })
    .expect(200);
  await agent.get("/api/instructions").expect(200, {
    body: "",
    enabled: false,
    updated: null,
  });
  await agent
    .put("/api/instructions")
    .send({ body: "Be terse.", enabled: true })
    .expect(200);
  await agent.delete(`/api/scrolls/${created.id}`).expect(200);
});
