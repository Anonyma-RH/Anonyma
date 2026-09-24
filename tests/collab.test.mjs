import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-collab-"));
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
let visitor = 0;
async function person(app, username) {
  const agent = request.agent(app);
  // Each person signs up from their own address, as real visitors would.
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `203.0.113.${++visitor}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const say = (text) => ({
  model: "google/gemini-2.5-flash",
  messages: [{ role: "user", content: text }],
  max_tokens: 50,
});

test("collab members share conversations, each paying for their own requests", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana");
  const ben = await person(s.app, "ben");
  const eve = await person(s.app, "eve");

  const { id } = (
    await ana.agent
      .post("/api/collabs")
      .send({ name: "Launch team" })
      .expect(201)
  ).body;
  const invite = (
    await ana.agent.post(`/api/collabs/${id}/invite`).send({}).expect(200)
  ).body;
  assert.match(invite.link, /\/workspace\/collab\?join=[a-f0-9]{48}$/);
  await ben.agent
    .post("/api/collabs/join")
    .send({ token: invite.token })
    .expect(200);
  await ben.agent
    .post("/api/collabs/join")
    .send({ token: invite.token })
    .expect(200); // no-op
  await ben.agent.post(`/api/collabs/${id}/invite`).send({}).expect(403); // members can't invite

  const convo = (
    await ben.agent
      .post(`/api/collabs/${id}/conversations`)
      .send({ title: "Tagline ideas" })
      .expect(201)
  ).body.id;
  const view = (await ana.agent.get(`/api/collabs/${id}`).expect(200)).body;
  assert.deepEqual(
    view.members.map((m) => [m.username, m.role]),
    [
      ["ana", "owner"],
      ["ben", "member"],
    ],
  );
  assert.equal(view.conversations[0].title, "Tagline ideas");
  // Shared conversations don't clutter personal lists.
  assert.equal(
    (await ben.agent.get("/api/conversations").expect(200)).body.data.length,
    0,
  );

  // Both members post in the same conversation; each pays for their own turn.
  const anaBefore = balance(s.db, ana.user.id).total;
  const benBefore = balance(s.db, ben.user.id).total;
  await ana.agent
    .post("/api/chat")
    .send({ ...say("Ana's idea"), conversationId: convo })
    .expect(200);
  await ben.agent
    .post("/api/chat")
    .send({ ...say("Ben's idea"), conversationId: convo })
    .expect(200);
  assert.ok(balance(s.db, ana.user.id).total < anaBefore);
  assert.ok(balance(s.db, ben.user.id).total < benBefore);
  const thread = (
    await ana.agent.get(`/api/conversations/${convo}`).expect(200)
  ).body;
  assert.equal(thread.collab.name, "Launch team");
  const users = thread.messages.filter((m) => m.role === "user");
  assert.deepEqual(
    users.map((m) => m.author),
    ["ana", "ben"],
  );
  assert.ok(users[0].credits !== null || users[0].cost === 0);
  const bensReply = thread.messages.filter((m) => m.role === "assistant")[1];
  assert.equal(bensReply.cost, null, "members don't see what others paid");

  // Outsiders can't read, post or list it.
  await eve.agent.get(`/api/conversations/${convo}`).expect(404);
  await eve.agent
    .post("/api/chat")
    .send({ ...say("hi"), conversationId: convo })
    .expect(404);
  await eve.agent.get(`/api/collabs/${id}`).expect(404);
  // Members can't delete a conversation they didn't start; the owner can rename it.
  await ana.agent
    .patch(`/api/conversations/${convo}`)
    .send({ title: "Renamed" })
    .expect(200);

  // Removing a member ends their access; the owner can't be removed.
  await ben.agent.delete(`/api/collabs/${id}/members/ana`).expect(400);
  await ana.agent.delete(`/api/collabs/${id}/members/ben`).expect(200);
  await ben.agent.get(`/api/conversations/${convo}`).expect(404);

  // A replaced invite link stops working.
  const second = (
    await ana.agent.post(`/api/collabs/${id}/invite`).send({}).expect(200)
  ).body;
  await eve.agent
    .post("/api/collabs/join")
    .send({ token: invite.token })
    .expect(404);
  await eve.agent
    .post("/api/collabs/join")
    .send({ token: second.token })
    .expect(200);

  // Deleting the collab removes its shared conversations.
  await ana.agent.delete(`/api/collabs/${id}`).expect(200);
  await ana.agent.get(`/api/conversations/${convo}`).expect(404);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
});

test("a collab holds at most twelve members", async (t) => {
  const s = fixture(t);
  const owner = await person(s.app, "owner");
  const { id } = (
    await owner.agent
      .post("/api/collabs")
      .send({ name: "Big group" })
      .expect(201)
  ).body;
  const { token } = (
    await owner.agent.post(`/api/collabs/${id}/invite`).send({}).expect(200)
  ).body;
  for (let i = 1; i < 12; i++) {
    const p = await person(s.app, "member" + i);
    await p.agent.post("/api/collabs/join").send({ token }).expect(200);
  }
  const late = await person(s.app, "latecomer");
  const r = await late.agent
    .post("/api/collabs/join")
    .send({ token })
    .expect(409);
  assert.equal(r.body.error.code, "collab_full");
});

test("closing an account removes owned collabs and keeps others' shared history", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana");
  const ben = await person(s.app, "ben");
  const mine = (
    await ben.agent.post("/api/collabs").send({ name: "Ben's own" }).expect(201)
  ).body.id;
  const shared = (
    await ana.agent
      .post("/api/collabs")
      .send({ name: "Ana's team" })
      .expect(201)
  ).body.id;
  const { token } = (
    await ana.agent.post(`/api/collabs/${shared}/invite`).send({}).expect(200)
  ).body;
  await ben.agent.post("/api/collabs/join").send({ token }).expect(200);
  const convo = (
    await ben.agent
      .post(`/api/collabs/${shared}/conversations`)
      .send({ title: "Plan" })
      .expect(201)
  ).body.id;
  await ben.agent
    .post("/api/chat")
    .send({ ...say("Ben was here"), conversationId: convo })
    .expect(200);

  await ben.agent
    .delete("/api/account")
    .send({ confirm: "DELETE" })
    .expect(200);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM collabs WHERE id=?").get(mine).n,
    0,
  );
  const view = (await ana.agent.get(`/api/collabs/${shared}`).expect(200)).body;
  assert.deepEqual(
    view.members.map((m) => m.username),
    ["ana"],
  );
  const thread = (
    await ana.agent.get(`/api/conversations/${convo}`).expect(200)
  ).body;
  assert.equal(thread.messages.find((m) => m.role === "user").author, null);
});
