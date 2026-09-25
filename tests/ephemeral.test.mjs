import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import { retentionLabel, retentionOptionLabel } from "../src/ephemeral.js";

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-ephemeral-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released,
    // The MVP's default model list doesn't include the fixture's test
    // model, so gating tests that release only "mvp,ephemeral" need it
    // added explicitly to keep chat requests reaching the release gate
    // rather than failing on model availability first.
    ...(released ? { mvpModels: [prompt.model] } : {}),
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
const prompt = {
  model: "google/gemini-2.5-flash",
  messages: [{ role: "user", content: "Off the record test message" }],
  max_tokens: 50,
};
const lastLedgerRow = (db, user) =>
  db
    .prepare(
      "SELECT * FROM ledger WHERE user_id=? ORDER BY created DESC LIMIT 1",
    )
    .get(user);

test("retentionLabel counts whole days remaining and handles the edges", () => {
  const base = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(retentionLabel(null, base), "");
  assert.equal(retentionLabel(undefined, base), "");
  assert.equal(retentionLabel(base - 1000, base), "Deletes soon");
  assert.equal(retentionLabel(base + 3600000, base), "Deletes in 1 day");
  assert.equal(retentionLabel(base + 6 * 86400000 + 1, base), "Deletes in 7 days");
  assert.equal(retentionLabel(base + 30 * 86400000, base), "Deletes in 30 days");
});
test("retentionOptionLabel names the four supported choices", () => {
  assert.equal(retentionOptionLabel(null), "Never");
  assert.equal(retentionOptionLabel(1), "1 day");
  assert.equal(retentionOptionLabel(7), "7 days");
  assert.equal(retentionOptionLabel(30), "30 days");
});
test("an off-the-record chat charges and returns a receipt but saves nothing", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const before = balance(s.db, user.id).total;
  const r = await agent
    .post("/api/chat")
    .send({ ...prompt, ephemeral: true })
    .expect(200);
  assert.match(r.text, /\[DONE\]/);
  assert.match(r.text, /credits_charged/);
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
  const ledgerRow = lastLedgerRow(s.db, user.id);
  assert.ok(ledgerRow && ledgerRow.amount < 0);
  assert.ok(
    !ledgerRow.description.includes("Off the record test message"),
    "the ledger description carries no prompt text",
  );
});
test("ephemeral can't be combined with a saved conversationId", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  await agent.post("/api/chat").send(prompt).expect(200);
  const convo = (await agent.get("/api/conversations")).body.data[0];
  const r = await agent
    .post("/api/chat")
    .send({ ...prompt, ephemeral: true, conversationId: convo.id })
    .expect(400);
  assert.equal(r.body.error.code, "invalid_request");
  // Nothing was reserved or charged for the rejected request.
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM holds WHERE status='held'").get().n,
    0,
  );
});
test("auto-delete retention can be set and cleared on an owned conversation", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  await agent.post("/api/chat").send(prompt).expect(200);
  const convo = (await agent.get("/api/conversations")).body.data[0];
  assert.equal(convo.expires, null);
  const setAt = Date.now();
  await agent
    .patch("/api/conversations/" + convo.id)
    .send({ retention: 7 })
    .expect(200);
  const withRetention = (await agent.get("/api/conversations/" + convo.id))
    .body;
  assert.ok(withRetention.expires >= setAt + 6.9 * 86400000);
  assert.ok(withRetention.expires <= Date.now() + 7 * 86400000 + 5000);
  // An out-of-range value is rejected.
  await agent
    .patch("/api/conversations/" + convo.id)
    .send({ retention: 3 })
    .expect(400);
  // A retention-only patch leaves the title untouched.
  await agent
    .patch("/api/conversations/" + convo.id)
    .send({ title: "Kept" })
    .expect(200);
  await agent
    .patch("/api/conversations/" + convo.id)
    .send({ retention: 1 })
    .expect(200);
  assert.equal(
    (await agent.get("/api/conversations/" + convo.id)).body.title,
    "Kept",
  );
  // null clears it.
  await agent
    .patch("/api/conversations/" + convo.id)
    .send({ retention: null })
    .expect(200);
  assert.equal(
    (await agent.get("/api/conversations/" + convo.id)).body.expires,
    null,
  );
});
test("account retention default applies only to conversations created afterward", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  await agent.post("/api/chat").send(prompt).expect(200);
  const existing = (await agent.get("/api/conversations")).body.data[0];
  assert.equal(existing.expires, null);
  assert.deepEqual((await agent.get("/api/retention")).body, { days: null });
  await agent.put("/api/retention").send({ days: 30 }).expect(200);
  assert.deepEqual((await agent.get("/api/retention")).body, { days: 30 });
  await agent.put("/api/retention").send({ days: 2 }).expect(400);
  assert.deepEqual(
    (await agent.get("/api/retention")).body,
    { days: 30 },
    "the rejected value did not change the stored default",
  );
  await agent.post("/api/chat").send(prompt).expect(200);
  const list = (await agent.get("/api/conversations")).body.data;
  const stillUntouched = list.find((c) => c.id === existing.id);
  const fresh = list.find((c) => c.id !== existing.id);
  assert.equal(stillUntouched.expires, null, "existing conversation unchanged");
  assert.ok(fresh.expires > Date.now(), "the new conversation carries the default");
  await agent.put("/api/retention").send({ days: null }).expect(200);
  assert.deepEqual((await agent.get("/api/retention")).body, { days: null });
});
test("an expired conversation 404s immediately and the worker purges it with its messages", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  await agent.post("/api/chat").send(prompt).expect(200);
  const convo = (await agent.get("/api/conversations")).body.data[0];
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?").get(convo.id).n,
    2,
  );
  s.db.prepare("UPDATE conversations SET expires=1 WHERE id=?").run(convo.id);
  // Not found right away, well before any maintenance tick runs.
  await agent.get("/api/conversations/" + convo.id).expect(404);
  await agent
    .patch("/api/conversations/" + convo.id)
    .send({ title: "x" })
    .expect(404);
  assert.equal(
    (await agent.get("/api/conversations")).body.data.length,
    0,
    "excluded from the list too",
  );
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE id=?").get(convo.id).n,
    1,
    "the row still exists until the worker sweeps it",
  );
  await s.tick();
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE id=?").get(convo.id).n,
    0,
  );
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?").get(convo.id).n,
    0,
    "messages cascade with their conversation",
  );
});
test("only the owner, or the collab owner for a shared conversation, can set retention", async (t) => {
  const s = fixture(t);
  const { agent: ana } = await register(s.app, "ana");
  const { agent: eve } = await register(s.app, "eve");
  await ana.post("/api/chat").send(prompt).expect(200);
  const personal = (await ana.get("/api/conversations")).body.data[0];
  await eve
    .patch("/api/conversations/" + personal.id)
    .send({ retention: 7 })
    .expect(404);

  const collab = (
    await ana.post("/api/collabs").send({ name: "Team" }).expect(201)
  ).body;
  const invite = (
    await ana.post(`/api/collabs/${collab.id}/invite`).send({}).expect(200)
  ).body;
  const { agent: ben } = await register(s.app, "ben");
  await ben.post("/api/collabs/join").send({ token: invite.token }).expect(200);
  const shared = (
    await ben
      .post(`/api/collabs/${collab.id}/conversations`)
      .send({ title: "Shared" })
      .expect(201)
  ).body;
  // Ben started the shared conversation but isn't the collab owner.
  await ben
    .patch("/api/conversations/" + shared.id)
    .send({ retention: 7 })
    .expect(403);
  await ana
    .patch("/api/conversations/" + shared.id)
    .send({ retention: 7 })
    .expect(200);
  const detail = (await ana.get("/api/conversations/" + shared.id)).body;
  assert.ok(detail.expires > Date.now());
});

test("retentionChoiceFor shows the shortest option that covers the time left", async () => {
  const { retentionChoiceFor } = await import("../src/ephemeral.js");
  const now = Date.UTC(2026, 8, 24), day = 86400000;
  assert.equal(retentionChoiceFor(null, now), null);
  assert.equal(retentionChoiceFor(now + 3600000, now), 1);
  assert.equal(retentionChoiceFor(now + 6.5 * day, now), 7);
  assert.equal(retentionChoiceFor(now + 7 * day, now), 7);
  assert.equal(retentionChoiceFor(now + 20 * day, now), 30);
});

test("the update is registered as off by default", () => {
  const entry = UPDATES.find((u) => u.id === "ephemeral");
  assert.ok(entry, "ephemeral is registered in UPDATES");
  assert.equal(entry.released, false);
  assert.equal(entry.title, "Ephemeral Chats");
  assert.equal(entry.tagline, "Off the record, or gone on schedule.");
  assert.deepEqual(entry.points, [
    "Chats that are never saved",
    "Auto-delete after 1, 7 or 30 days",
    "A receipt either way",
  ]);
});

test("the MVP refuses ephemeral chats and retention on the server", async (t) => {
  const s = fixture(t, "mvp");
  const { agent } = await register(s.app);
  const refused = async (res) => {
    const r = await res.expect(403);
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.equal(r.body.error.message, "Ephemeral Chats is coming soon.");
  };
  await refused(agent.post("/api/chat").send({ ...prompt, ephemeral: true }));
  await refused(agent.get("/api/retention"));
  await refused(agent.put("/api/retention").send({ days: 7 }));

  // A normal, saved chat still works, and a title-only rename still works
  // on the resulting conversation.
  await agent.post("/api/chat").send(prompt).expect(200);
  const convo = (await agent.get("/api/conversations")).body.data[0];
  await refused(
    agent.patch("/api/conversations/" + convo.id).send({ retention: 7 }),
  );
  await agent
    .patch("/api/conversations/" + convo.id)
    .send({ title: "Renamed" })
    .expect(200);
  assert.equal(
    (await agent.get("/api/conversations/" + convo.id)).body.title,
    "Renamed",
  );
});

test("releasing ephemeral opens off-the-record chats and retention", async (t) => {
  const s = fixture(t, "mvp,ephemeral");
  const { agent } = await register(s.app);
  const r = await agent
    .post("/api/chat")
    .send({ ...prompt, ephemeral: true })
    .expect(200);
  assert.match(r.text, /credits_charged/);

  await agent.post("/api/chat").send(prompt).expect(200);
  const convo = (await agent.get("/api/conversations")).body.data[0];
  await agent
    .patch("/api/conversations/" + convo.id)
    .send({ retention: 7 })
    .expect(200);
  assert.deepEqual((await agent.get("/api/retention")).body, { days: null });
  await agent.put("/api/retention").send({ days: 7 }).expect(200);
  assert.deepEqual((await agent.get("/api/retention")).body, { days: 7 });
});
