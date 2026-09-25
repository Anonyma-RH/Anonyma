import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import { rewindPlan, resendContent, promptParts, branchesAt, singleFlight } from "../src/branches.js";
import { CONVERSATION_CAP } from "../server/routes/conversations.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-branches-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    // The MVP's default model list may not include the test model, so gating
    // fixtures put it on the list (as the ephemeral suite does).
    ...(released === "all" ? {} : { mvpModels: ["google/gemini-2.5-flash"] }),
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
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const turn = (text, extra = {}) => ({
  model: "google/gemini-2.5-flash",
  messages: [{ role: "user", content: text }],
  max_tokens: 50,
  ...extra,
});
// A saved conversation with three turns: six messages, user then assistant.
async function threeTurns(agent, extra = {}) {
  await agent.post("/api/chat").send(turn("one", extra)).expect(200);
  const convo = (await agent.get("/api/conversations")).body.data[0];
  for (const text of ["two", "three"])
    await agent
      .post("/api/chat")
      .send(turn(text, { ...extra, conversationId: convo.id }))
      .expect(200);
  return (await agent.get("/api/conversations/" + convo.id)).body;
}
const snapshot = (db, id) =>
  db
    .prepare(
      "SELECT id,role,content,model,cost,created,author_id FROM messages WHERE conversation_id=? ORDER BY created,rowid",
    )
    .all(id);

test("branching before a turn copies the earlier messages and leaves the original unchanged", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ana");
  const source = await threeTurns(agent);
  assert.equal(source.messages.length, 6);
  const originalRows = snapshot(s.db, source.id);
  const originalConvo = s.db.prepare("SELECT * FROM conversations WHERE id=?").get(source.id);
  const spent = balance(s.db, user.id).total;

  // Edit the second prompt: branch before it.
  const second = source.messages[2];
  assert.equal(second.role, "user");
  const r = await agent
    .post(`/api/conversations/${source.id}/branch`)
    .send({ before: second.id, requestId: "edit-1" })
    .expect(201);
  assert.equal(r.body.copied, 2);
  assert.deepEqual(r.body.parent, { id: source.id, title: source.title, mode: "chat" });
  assert.notEqual(r.body.id, source.id);

  // The branch holds exactly the prefix, in order, with provenance and no cost.
  const branch = (await agent.get("/api/conversations/" + r.body.id)).body;
  assert.deepEqual(
    branch.messages.map((m) => [m.role, m.content, m.origin_id]),
    source.messages.slice(0, 2).map((m) => [m.role, m.content, m.id]),
  );
  assert.ok(branch.messages.every((m) => m.cost === 0));
  assert.deepEqual(branch.parent, { id: source.id, title: source.title, mode: "chat" });
  assert.equal(branch.branch_point, second.id);
  assert.equal(branch.branch_key, undefined, "the idempotency key isn't exposed");

  // Nothing about the original changed, and branching cost nothing.
  assert.deepEqual(snapshot(s.db, source.id), originalRows);
  assert.deepEqual(s.db.prepare("SELECT * FROM conversations WHERE id=?").get(source.id), originalConvo);
  assert.equal(balance(s.db, user.id).total, spent);

  // The original lists the branch for navigation.
  const again = (await agent.get("/api/conversations/" + source.id)).body;
  assert.deepEqual(
    again.branches.map((b) => [b.id, b.branch_point]),
    [[r.body.id, second.id]],
  );
  assert.equal(again.parent, null);

  // Continuing the branch (the edited prompt) adds to the branch only.
  await agent
    .post("/api/chat")
    .send(turn("two, rephrased", { conversationId: r.body.id }))
    .expect(200);
  assert.equal((await agent.get("/api/conversations/" + r.body.id)).body.messages.length, 4);
  assert.deepEqual(snapshot(s.db, source.id), originalRows);
});

test("branching through a message includes it; regenerate uses before on the prompt", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "ben");
  const source = await threeTurns(agent);
  const firstAnswer = source.messages[1];
  const through = await agent
    .post(`/api/conversations/${source.id}/branch`)
    .send({ through: firstAnswer.id, requestId: "cont-1" })
    .expect(201);
  assert.equal(through.body.copied, 2);
  // Regenerate the last answer: branch before its prompt, then send that prompt again.
  const lastPrompt = source.messages[4];
  const regen = await agent
    .post(`/api/conversations/${source.id}/branch`)
    .send({ before: lastPrompt.id, requestId: "regen-1" })
    .expect(201);
  assert.equal(regen.body.copied, 4);
  // Editing the very first prompt makes an empty branch that still records where it came from.
  const first = await agent
    .post(`/api/conversations/${source.id}/branch`)
    .send({ before: source.messages[0].id, requestId: "edit-first" })
    .expect(201);
  assert.equal(first.body.copied, 0);
  assert.equal((await agent.get("/api/conversations/" + first.body.id)).body.parent.id, source.id);
});

test("a retried branch request returns the same branch; reusing the id elsewhere conflicts", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "cai");
  const source = await threeTurns(agent);
  const body = { before: source.messages[4].id, requestId: "retry-me" };
  const a = await agent.post(`/api/conversations/${source.id}/branch`).send(body).expect(201);
  const b = await agent.post(`/api/conversations/${source.id}/branch`).send(body).expect(200);
  assert.equal(b.body.id, a.body.id);
  assert.equal(b.body.copied, a.body.copied);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE parent_id=?").get(source.id).n,
    1,
    "only one branch was created",
  );
  const c = await agent
    .post(`/api/conversations/${source.id}/branch`)
    .send({ before: source.messages[2].id, requestId: "retry-me" })
    .expect(409);
  assert.equal(c.body.error.code, "idempotency_conflict");
  // Same message, other cut: a different copy, so it's a conflict too, not the old branch.
  const d = await agent
    .post(`/api/conversations/${source.id}/branch`)
    .send({ through: source.messages[4].id, requestId: "retry-me" })
    .expect(409);
  assert.equal(d.body.error.code, "idempotency_conflict");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE parent_id=?").get(source.id).n, 1);
});

test("branching the oldest conversation at the cap never deletes the original", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ivy");
  const source = await threeTurns(agent);
  // Fill the account to the cap with newer conversations; the source is the oldest.
  s.db.prepare("UPDATE conversations SET updated=1 WHERE id=?").run(source.id);
  const insert = s.db.prepare(
    "INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)",
  );
  for (let i = 0; i < CONVERSATION_CAP - 1; i++) insert.run("c_fill" + i, user.id, "filler " + i, "chat", 10 + i, 10 + i);
  const count = () =>
    s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=? AND collab_id IS NULL").get(user.id).n;
  assert.equal(count(), CONVERSATION_CAP);
  const b = await agent
    .post(`/api/conversations/${source.id}/branch`)
    .send({ before: source.messages[4].id, requestId: "at-cap" })
    .expect(201);
  assert.ok(s.db.prepare("SELECT id FROM conversations WHERE id=?").get(source.id), "the original survives");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?").get(source.id).n, 6);
  assert.ok(s.db.prepare("SELECT id FROM conversations WHERE id=?").get(b.body.id));
  assert.equal(count(), CONVERSATION_CAP, "the cap still holds; the oldest other conversation went");
  assert.equal(s.db.prepare("SELECT id FROM conversations WHERE id='c_fill0'").get(), undefined);
});

test("requests are validated: one point, a message from this conversation, a request id", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "dee");
  const source = await threeTurns(agent);
  const other = await threeTurns(agent);
  const url = `/api/conversations/${source.id}/branch`;
  const id = source.messages[2].id;
  for (const body of [
    { requestId: "x" },
    { before: id, through: id, requestId: "x" },
    { before: 7, requestId: "x" },
    { before: id },
    { before: id, requestId: "" },
  ])
    await agent.post(url).send(body).expect(400);
  // A message id from another conversation is not a branch point here.
  await agent.post(url).send({ before: other.messages[2].id, requestId: "y" }).expect(404);
  await agent.post("/api/conversations/c_missing/branch").send({ before: id, requestId: "z" }).expect(404);
});

test("no cross-account access: strangers can't branch or see branches of someone else's chat", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana");
  const eve = await person(s.app, "eve");
  const source = await threeTurns(ana.agent);
  await eve.agent
    .post(`/api/conversations/${source.id}/branch`)
    .send({ before: source.messages[2].id, requestId: "steal" })
    .expect(404);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE parent_id IS NOT NULL").get().n, 0);
  // Eve's own branch of her own chat never shows Ana's conversation as a parent.
  const mine = await threeTurns(eve.agent);
  const b = await eve.agent
    .post(`/api/conversations/${mine.id}/branch`)
    .send({ through: mine.messages[1].id, requestId: "own" })
    .expect(201);
  await ana.agent.get("/api/conversations/" + b.body.id).expect(404);
  assert.ok(!(await ana.agent.get("/api/conversations")).body.data.some((c) => c.id === b.body.id));
});

test("a shared conversation's branch stays in its collab and follows membership", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana");
  const ben = await person(s.app, "ben");
  const eve = await person(s.app, "eve");
  const { id: collab } = (await ana.agent.post("/api/collabs").send({ name: "Team" }).expect(201)).body;
  const { token } = (await ana.agent.post(`/api/collabs/${collab}/invite`).send({}).expect(200)).body;
  await ben.agent.post("/api/collabs/join").send({ token }).expect(200);
  const { id: shared } = (
    await ana.agent.post(`/api/collabs/${collab}/conversations`).send({ title: "Plan" }).expect(201)
  ).body;
  await ana.agent.post("/api/chat").send(turn("ana asks", { conversationId: shared })).expect(200);
  await ben.agent.post("/api/chat").send(turn("ben asks", { conversationId: shared })).expect(200);
  const source = (await ben.agent.get("/api/conversations/" + shared)).body;

  // Ben (a member, not the creator) branches before his own prompt.
  const b = await ben.agent
    .post(`/api/conversations/${shared}/branch`)
    .send({ before: source.messages[2].id, requestId: "ben-edit" })
    .expect(201);
  const row = s.db.prepare("SELECT * FROM conversations WHERE id=?").get(b.body.id);
  assert.equal(row.collab_id, collab, "the branch stays in the collab");
  assert.equal(row.user_id, ben.user.id);
  // Ana (another member) sees it; authorship of copied messages is preserved.
  const seen = (await ana.agent.get("/api/conversations/" + b.body.id)).body;
  assert.equal(seen.messages[0].author, "ana");
  assert.ok((await ana.agent.get("/api/conversations/" + shared)).body.branches.some((x) => x.id === b.body.id));
  // A non-member can't read it or branch the shared conversation.
  await eve.agent.get("/api/conversations/" + b.body.id).expect(404);
  await eve.agent
    .post(`/api/conversations/${shared}/branch`)
    .send({ before: source.messages[2].id, requestId: "eve" })
    .expect(404);
  // After Ben leaves, he loses the branch he made too.
  await ben.agent.delete(`/api/collabs/${collab}/members/ben`).expect(200);
  await ben.agent.get("/api/conversations/" + b.body.id).expect(404);
  await ben.agent
    .post(`/api/conversations/${shared}/branch`)
    .send({ before: source.messages[2].id, requestId: "ben-again" })
    .expect(404);
});

test("a branch never outlives an auto-deleting source", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "fay");
  const source = await threeTurns(agent);
  const setAt = Date.now();
  await agent.patch("/api/conversations/" + source.id).send({ retention: 1 }).expect(200);
  const b = await agent
    .post(`/api/conversations/${source.id}/branch`)
    .send({ through: source.messages[3].id, requestId: "keep" })
    .expect(201);
  const expires = s.db.prepare("SELECT expires FROM conversations WHERE id=?").get(b.body.id).expires;
  const sourceExpires = s.db.prepare("SELECT expires FROM conversations WHERE id=?").get(source.id).expires;
  assert.ok(expires >= setAt + 86400000 - 5000 && expires <= sourceExpires);
});

test("off the record and symposium chats have nothing saved to branch", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "gus");
  // An off-the-record retry is a new ephemeral request: nothing is stored either time.
  for (const text of ["draft", "draft, edited"])
    await agent.post("/api/chat").send(turn(text, { ephemeral: true })).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
  // Symposium runs (never listed with ordinary chats) are not branchable.
  await agent.post("/api/chat").send(turn("compare", { mode: "symposium" })).expect(200);
  const sym = s.db.prepare("SELECT id FROM conversations WHERE mode='symposium'").get();
  const msg = s.db.prepare("SELECT id FROM messages WHERE conversation_id=?").get(sym.id);
  const r = await agent
    .post(`/api/conversations/${sym.id}/branch`)
    .send({ through: msg.id, requestId: "sym" })
    .expect(400);
  assert.equal(r.body.error.code, "invalid_request");
});

test("branching is gated until Edit, Regenerate & Branch Chats is released", async (t) => {
  const s = fixture(t, "mvp");
  const { agent } = await person(s.app, "hal");
  await agent.post("/api/chat").send(turn("hello")).expect(200);
  const convo = (await agent.get("/api/conversations")).body.data[0];
  const full = (await agent.get("/api/conversations/" + convo.id)).body;
  const r = await agent
    .post(`/api/conversations/${convo.id}/branch`)
    .send({ through: full.messages[0].id, requestId: "early" })
    .expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 1);
  // The contract hides the route until release.
  const spec = (await agent.get("/api/openapi.json")).body;
  assert.equal(spec.paths["/api/conversations/{id}/branch"], undefined);
  const entry = UPDATES.find((u) => u.id === "branches");
  assert.equal(entry.title, "Edit, Regenerate & Branch Chats");
  assert.equal(committed[UPDATES.indexOf(entry)], true, "registered released; explicit MVP configuration still gates it");
});

// --- Client planning (src/branches.js) --------------------------------------

const history = [
  { id: "m1", role: "user", content: "first", images: ["data:image/png;base64,AAA"] },
  { id: "m2", role: "assistant", content: "answer one", model: "model-a" },
  { id: "m3", role: "user", content: 'second\n\n<document name="a.txt">text</document>' },
  { id: "m4", role: "assistant", content: "answer two", model: "model-b" },
];

test("edit resends from the history before the edited turn and keeps its documents", () => {
  const plan = rewindPlan(history, 2, "edit");
  assert.equal(plan.userIndex, 2);
  assert.deepEqual(plan.base, history.slice(0, 2));
  assert.equal(plan.model, null);
  assert.equal(resendContent(plan.prompt, "  second, better "), 'second, better\n\n<document name="a.txt">text</document>');
  assert.equal(promptParts(history[2].content).typed, "second");
  // Uploads on the edited turn go with it.
  assert.deepEqual(rewindPlan(history, 0, "edit").prompt.images, history[0].images);
  assert.deepEqual(rewindPlan(history, 0, "edit").base, []);
});

test("regenerate resends the answer's own prompt, exactly, to the model that answered", () => {
  const plan = rewindPlan(history, 3, "regenerate");
  assert.equal(plan.userIndex, 2);
  assert.deepEqual(plan.base, history.slice(0, 2));
  assert.equal(plan.model, "model-b");
  assert.equal(resendContent(plan.prompt), history[2].content);
  // Wrong roles and missing turns plan nothing.
  assert.equal(rewindPlan(history, 1, "edit"), null);
  assert.equal(rewindPlan(history, 0, "regenerate"), null);
  assert.equal(rewindPlan([{ role: "assistant", content: "x" }], 0, "regenerate"), null);
  assert.equal(rewindPlan(history, 9, "edit"), null);
});

test("documents-only prompts edit to an empty typed part; branch chips match their point", () => {
  assert.deepEqual(promptParts('<document name="b.txt">x</document>'), { typed: "", attached: '<document name="b.txt">x</document>' });
  assert.deepEqual(promptParts(undefined), { typed: "", attached: "" });
  const branches = [{ id: "c1", branch_point: "m3" }, { id: "c2", branch_point: "m1" }];
  assert.deepEqual(branchesAt(branches, "m3").map((b) => b.id), ["c1"]);
  assert.deepEqual(branchesAt(branches, undefined), []);
});

test("one branch/resend at a time: repeated clicks during a delayed request make one branch and one generation", async () => {
  const flight = singleFlight();
  let branches = 0,
    generations = 0,
    release;
  const gate = new Promise((r) => (release = r));
  // What rewind does: create the branch (slow network), then generate once.
  const edit = () =>
    flight.run(async (fresh) => {
      branches++;
      await gate;
      if (!fresh()) return "dropped";
      generations++;
      return "sent";
    });
  const first = edit();
  const repeats = [edit(), edit(), edit()];
  assert.equal(flight.pending, true);
  assert.deepEqual(await Promise.all(repeats), [undefined, undefined, undefined], "ignored while pending");
  release();
  assert.equal(await first, "sent");
  assert.equal(branches, 1);
  assert.equal(generations, 1);
  assert.equal(flight.pending, false, "released after the task");
  // A failing task releases the guard too.
  await assert.rejects(flight.run(async () => { throw new Error("network"); }));
  assert.equal(flight.pending, false);
  // Navigating away (reset) while the branch request is in flight drops the resend.
  let later;
  const pending = flight.run(async (fresh) => {
    await new Promise((r) => (later = r));
    if (!fresh()) return "dropped";
    generations++;
    return "sent";
  });
  flight.reset();
  later();
  assert.equal(await pending, "dropped");
  assert.equal(generations, 1);
});
