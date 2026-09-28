import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { now, uid, transaction } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { paletteActions } from "../src/command-palette.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  MAX_BOOKMARKS,
  MAX_NOTE,
  bookmarkLink,
  canBookmark,
  excerptOf,
  normalizeNote,
  savedIdAt,
} from "../src/bookmarks.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-bookmarks-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...(released === "all" ? {} : { mvpModels: [MODEL] }),
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
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
// A saved conversation written straight to the database: [role, content,
// author?, model?] per message, oldest first.
function conversation(s, user, title, messages, { mode = "chat", collab = null, expires = null } = {}) {
  const id = uid("c_");
  const t = now();
  s.db
    .prepare(
      "INSERT INTO conversations(id,user_id,title,mode,created,updated,collab_id,expires) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(id, user, title, mode, t, t, collab, expires);
  const insert = s.db.prepare(
    "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
  );
  const ids = messages.map(([role, content, author = user, model = null], i) => {
    const mid = uid("m_");
    insert.run(mid, id, role, JSON.stringify(content), model, 0, t + i, role === "user" ? author : null);
    return mid;
  });
  return { id, ids };
}
const exchange = (question, answer) => [
  ["user", question],
  ["assistant", { text: answer, reasoning: "hidden reasoning words" }, null, MODEL],
];
const count = (s, user) =>
  s.db.prepare("SELECT COUNT(*) n FROM bookmarks WHERE user_id=?").get(user).n;
const star = (p, message_id, note) =>
  p.agent.post("/api/bookmarks").send(note === undefined ? { message_id } : { message_id, note });
const list = async (p, query = "") =>
  (await p.agent.get("/api/bookmarks" + query).expect(200)).body;
async function collab(s, owner, members, name = "Launch team") {
  const { id } = (await owner.agent.post("/api/collabs").send({ name }).expect(201)).body;
  const invite = (await owner.agent.post(`/api/collabs/${id}/invite`).send({}).expect(200)).body;
  for (const m of members)
    await m.agent.post("/api/collabs/join").send({ token: invite.token }).expect(200);
  return id;
}

// ---- The release gate ----

test("unreleased: every route is refused, nothing is listed or exported, and the API docs leave it out", async (t) => {
  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app, "ana");
  for (const send of [
    () => a.agent.get("/api/bookmarks"),
    () => a.agent.get("/api/bookmarks?conversation=c_x"),
    () => a.agent.post("/api/bookmarks").send({ message_id: "m_x" }),
    () => a.agent.patch("/api/bookmarks/bm_x").send({ note: "x" }),
    () => a.agent.delete("/api/bookmarks/bm_x"),
    () => a.agent.get("/API/Bookmarks/"),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Bookmarks is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(mvp.app).get("/api/bookmarks").expect(403);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.bookmarks, false);
  const entry = config.releases.updates.find((u) => u.id === "bookmarks");
  assert.equal(entry.title, "Bookmarks");
  assert.equal(entry.released, false);
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(closed.paths).some((p) => p.includes("bookmarks")));
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.ok(!("bookmarks" in exported), "no bookmarks key while unreleased and empty");
  // Nothing else is gated by it.
  for (const path of ["/api/conversations", "/api/history/search", "/api/account/export"])
    assert.ok(!featuresFor({ path, method: "GET", body: {} }).includes("bookmarks"), path);
  assert.deepEqual(featuresFor({ path: "/api/bookmarks/bm_1", method: "PATCH", body: {} }), ["bookmarks"]);

  // Released on its own, it needs nothing else.
  const own = fixture(t, "mvp,bookmarks");
  const b = await person(own.app, "ben");
  const c = conversation(own, b.user.id, "Solo", exchange("q", "a"));
  await star(b, c.ids[1]).expect(201);
  const open = (await request(own.app).get("/api/openapi.json").expect(200)).body;
  for (const [path, methods] of [
    ["/api/bookmarks", ["get", "post"]],
    ["/api/bookmarks/{id}", ["patch", "delete"]],
  ])
    for (const m of methods) assert.ok(open.paths[path]?.[m], `${m} ${path}`);
  await request(own.app).get("/api/bookmarks").expect(401);
  await request(own.app).post("/api/bookmarks").send({ message_id: c.ids[1] }).expect(401);
});

// ---- CRUD ----

test("star, list, note, re-star, filter by conversation and remove", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const c = conversation(s, a.user.id, "Greek islands", exchange("Which island in May?", "Naxos: warm sea, few crowds."));
  const made = await star(a, c.ids[1], "  for the   trip\nplan ").expect(201);
  const b = made.body;
  assert.match(b.id, /^bm_/);
  assert.equal(b.message_id, c.ids[1]);
  assert.equal(b.conversation_id, c.id);
  assert.equal(b.conversation_title, "Greek islands");
  assert.equal(b.conversation_mode, "chat");
  assert.equal(b.role, "assistant");
  assert.equal(b.model, MODEL);
  assert.equal(b.author, null);
  assert.equal(b.collab, null);
  assert.equal(b.expires, null);
  // The reply's text, never its reasoning.
  assert.equal(b.excerpt, "Naxos: warm sea, few crowds.");
  assert.equal(b.more, false);
  assert.equal(b.note, "for the trip plan", "one line, trimmed");
  // Starring it again returns the same bookmark unchanged.
  const again = (await star(a, c.ids[1], "different").expect(200)).body;
  assert.equal(again.id, b.id);
  assert.equal(again.note, "for the trip plan");
  assert.equal(count(s, a.user.id), 1);
  // A prompt too, with no note.
  const q = (await star(a, c.ids[0]).expect(201)).body;
  assert.equal(q.role, "user");
  assert.equal(q.model, null);
  assert.equal(q.note, "");
  assert.equal(q.excerpt, "Which island in May?");
  let r = await list(a);
  assert.deepEqual(r.data.map((x) => x.id), [q.id, b.id], "newest first");
  assert.equal(r.total, 2);
  assert.equal(r.limit, MAX_BOOKMARKS);
  assert.equal(r.nextOffset, null);
  // A note can be changed and cleared.
  const edited = (await a.agent.patch("/api/bookmarks/" + b.id).send({ note: "Naxos!" }).expect(200)).body;
  assert.equal(edited.note, "Naxos!");
  assert.ok(edited.updated >= b.updated);
  assert.equal((await a.agent.patch("/api/bookmarks/" + b.id).send({ note: "" }).expect(200)).body.note, "");
  await a.agent.patch("/api/bookmarks/" + b.id).send({}).expect(400);
  // The open conversation's bookmarks.
  const other = conversation(s, a.user.id, "Other", exchange("x", "y"));
  await star(a, other.ids[1]).expect(201);
  r = await list(a, "?conversation=" + c.id + "&limit=1000");
  assert.deepEqual(r.data.map((x) => x.message_id).sort(), [...c.ids].sort());
  assert.equal(r.total, 3);
  // Remove.
  await a.agent.delete("/api/bookmarks/" + b.id).expect(200);
  await a.agent.delete("/api/bookmarks/" + b.id).expect(404);
  await a.agent.patch("/api/bookmarks/" + b.id).send({ note: "x" }).expect(404);
  assert.equal((await list(a)).total, 2);
  // The message itself is untouched.
  assert.equal((await a.agent.get("/api/conversations/" + c.id).expect(200)).body.messages.length, 2);
});

test("bookmarks work on messages saved by a real chat, in chat and code", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  await a.agent
    .post("/api/chat")
    .send({ model: MODEL, messages: [{ role: "user", content: "hello there" }], max_tokens: 50, mode: "code" })
    .expect(200);
  const convo = (await a.agent.get("/api/conversations").expect(200)).body.data[0];
  const saved = (await a.agent.get("/api/conversations/" + convo.id).expect(200)).body;
  assert.equal(saved.mode, "code");
  const reply = saved.messages.find((m) => m.role === "assistant");
  const b = (await star(a, reply.id).expect(201)).body;
  assert.equal(b.conversation_mode, "code");
  assert.equal(b.model, reply.model);
  assert.equal(bookmarkLink(b), `/workspace/code?c=${convo.id}&m=${reply.id}`);
});

test("input is checked: ids, note length and type, seed phrases, search and page sizes", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const c = conversation(s, a.user.id, "Notes", exchange("q", "a"));
  for (const bad of [{}, { message_id: 7 }, { message_id: "" }, { message_id: "m".repeat(101) }])
    assert.equal((await a.agent.post("/api/bookmarks").send(bad).expect(400)).body.error.code, "invalid_request");
  await star(a, c.ids[1], "x".repeat(MAX_NOTE + 1)).expect(400);
  await star(a, c.ids[1], { text: "no" }).expect(400);
  // Seed Guard: a note is stored, so a seed phrase never is.
  const seed =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const refused = await star(a, c.ids[1], seed.slice(0, MAX_NOTE)).expect(400);
  assert.equal(refused.body.error.code, "seed_phrase_blocked");
  assert.equal(count(s, a.user.id), 0, "nothing saved when the note is refused");
  const b = (await star(a, c.ids[1], "x".repeat(MAX_NOTE)).expect(201)).body;
  assert.equal(b.note.length, MAX_NOTE);
  await a.agent.patch("/api/bookmarks/" + b.id).send({ note: seed.slice(0, MAX_NOTE) }).expect(400);
  await a.agent.patch("/api/bookmarks/" + b.id).send({ note: 12 }).expect(400);
  for (const q of [
    "?q=" + "x".repeat(161),
    "?role=system",
    "?limit=0",
    `?limit=${MAX_BOOKMARKS + 1}`,
    "?offset=-1",
    "?offset=1.5",
    "?conversation=" + "c".repeat(101),
  ])
    await a.agent.get("/api/bookmarks" + q).expect(400);
});

test("excerpts: typed words without attached documents, reply text, image parts, long messages", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const long = "word ".repeat(200).trim();
  const c = conversation(s, a.user.id, "Shapes", [
    ["user", 'Summarise this\n\n<document name="plan.txt">secret appendix text</document>'],
    ["assistant", { text: long }, null, MODEL],
    ["user", [{ type: "text", text: "What is in" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }, { type: "text", text: "this picture?" }]],
    ["assistant", { text: "", images: [{ image_url: { url: "/media/x.png" } }] }, null, MODEL],
    ["user", '<document name="only.txt">just a file</document>'],
  ]);
  const out = [];
  for (const id of c.ids) out.push((await star(a, id).expect(201)).body);
  assert.equal(out[0].excerpt, "Summarise this");
  assert.ok(!JSON.stringify(out[0]).includes("secret appendix"), "attached documents never shown");
  assert.equal(out[1].more, true);
  assert.ok(out[1].excerpt.endsWith("…"));
  assert.ok(out[1].excerpt.length <= 281);
  assert.equal(out[2].excerpt, "What is in this picture?");
  assert.ok(!out[2].excerpt.includes("base64"));
  assert.equal(out[3].excerpt, "");
  assert.equal(out[4].excerpt, "");
});

// ---- Search and filters ----

test("search matches the message text, chat title or note, never JSON structure; filters and pages", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const c1 = conversation(s, a.user.id, "Olive harvest", exchange("When to pick olives?", "Late October, by hand."));
  const c2 = conversation(s, a.user.id, "Kiln", exchange("Firing clay?", "Bisque at 1000°C, then glaze."));
  await star(a, c1.ids[1], "harvest calendar");
  await star(a, c1.ids[0]);
  await star(a, c2.ids[1], "100% worth it");
  await star(a, c2.ids[0]);
  const ids = async (q) => (await list(a, q)).data.map((x) => x.message_id).sort();
  assert.deepEqual(await ids("?q=october"), [c1.ids[1]], "reply text, any case");
  assert.deepEqual(await ids("?q=olive"), [...c1.ids].sort(), "chat title");
  assert.deepEqual(await ids("?q=calendar"), [c1.ids[1]], "note");
  assert.deepEqual(await ids("?q=text"), [], "not the saved JSON's keys");
  assert.deepEqual(await ids("?q=reasoning"), [], "not the hidden reasoning");
  assert.deepEqual(await ids("?q=" + encodeURIComponent("100%")), [c2.ids[1]], "% is literal");
  assert.deepEqual(await ids("?q=" + encodeURIComponent("_")), [], "_ is literal");
  assert.deepEqual(await ids("?role=assistant"), [c1.ids[1], c2.ids[1]].sort());
  assert.deepEqual(await ids("?role=user"), [c1.ids[0], c2.ids[0]].sort());
  assert.deepEqual(await ids("?noted=1"), [c1.ids[1], c2.ids[1]].sort());
  assert.deepEqual(await ids("?noted=1&q=kiln"), [c2.ids[1]]);
  let r = await list(a, "?limit=3");
  assert.equal(r.data.length, 3);
  assert.equal(r.nextOffset, 3);
  assert.equal(r.total, 4);
  r = await list(a, "?limit=3&offset=3");
  assert.equal(r.data.length, 1);
  assert.equal(r.nextOffset, null);
  // The total is every visible bookmark, whatever the filter.
  assert.equal((await list(a, "?q=october")).total, 4);
});

// ---- Ownership and privacy ----

test("bookmarks are personal: another account can't star, see, change or remove yours", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const b = await person(s.app, "ben");
  const mine = conversation(s, a.user.id, "Mine", exchange("private question", "private answer"));
  const bm = (await star(a, mine.ids[1], "my note").expect(201)).body;
  // Someone else's message looks exactly like a missing one.
  const theirs = await star(b, mine.ids[1]).expect(404);
  const missing = await star(b, "m_does_not_exist").expect(404);
  assert.deepEqual(theirs.body.error, missing.body.error);
  assert.equal(theirs.body.error.code, "bookmark_message_not_found");
  await b.agent.patch("/api/bookmarks/" + bm.id).send({ note: "hijack" }).expect(404);
  await b.agent.delete("/api/bookmarks/" + bm.id).expect(404);
  assert.equal((await list(b)).total, 0);
  assert.equal((await list(b, "?conversation=" + mine.id)).data.length, 0);
  assert.equal((await list(a)).data[0].note, "my note");
});

test("in a collab, members bookmark shared messages privately; leaving or removal deletes theirs", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana");
  const ben = await person(s.app, "ben");
  const eve = await person(s.app, "eve");
  const team = await collab(s, ana, [ben]);
  const shared = conversation(
    s,
    ana.user.id,
    "Tagline ideas",
    [
      ["user", "ben's question", ben.user.id],
      ["assistant", { text: "a shared answer" }, null, MODEL],
      ["user", "ana's follow-up", ana.user.id],
    ],
    { collab: team },
  );
  const anaStar = (await star(ana, shared.ids[1], "ana's private note").expect(201)).body;
  const benStar = (await star(ben, shared.ids[1], "ben's private note").expect(201)).body;
  assert.notEqual(anaStar.id, benStar.id);
  assert.deepEqual(anaStar.collab, { id: team, name: "Launch team" });
  // Each sees only their own bookmark and note.
  for (const [p, note] of [
    [ana, "ana's private note"],
    [ben, "ben's private note"],
  ]) {
    const r = await list(p, "?conversation=" + shared.id);
    assert.equal(r.data.length, 1);
    assert.equal(r.data[0].note, note);
  }
  await ben.agent.patch("/api/bookmarks/" + anaStar.id).send({ note: "x" }).expect(404);
  await ben.agent.delete("/api/bookmarks/" + anaStar.id).expect(404);
  // Who wrote a prompt, when it wasn't you.
  assert.equal((await star(ana, shared.ids[0]).expect(201)).body.author, "ben");
  assert.equal((await star(ben, shared.ids[0]).expect(201)).body.author, null);
  assert.equal((await star(ana, shared.ids[2]).expect(201)).body.author, null);
  // A non-member can't star a shared message.
  await star(eve, shared.ids[1]).expect(404);
  // Ben leaves: his bookmarks there are deleted; Ana's stay.
  await ben.agent.delete(`/api/collabs/${team}/members/ben`).expect(200);
  assert.equal(count(s, ben.user.id), 0);
  assert.equal(count(s, ana.user.id), 3);
  assert.equal((await list(ben)).total, 0);
  // Rejoining doesn't bring them back.
  const invite = (await ana.agent.post(`/api/collabs/${team}/invite`).send({}).expect(200)).body;
  await ben.agent.post("/api/collabs/join").send({ token: invite.token }).expect(200);
  assert.equal((await list(ben)).total, 0);
  // The owner removes a member: the same.
  await star(ben, shared.ids[1]).expect(201);
  await ana.agent.delete(`/api/collabs/${team}/members/ben`).expect(200);
  assert.equal(count(s, ben.user.id), 0);
  // Access is checked on every read too, even if a row were left behind.
  s.db
    .prepare("INSERT INTO bookmarks(id,user_id,message_id,note,created,updated) VALUES(?,?,?,?,?,?)")
    .run("bm_left", ben.user.id, shared.ids[1], "left behind", now(), now());
  assert.equal((await list(ben)).total, 0);
  await ben.agent.patch("/api/bookmarks/bm_left").send({ note: "x" }).expect(404);
  assert.ok(!JSON.stringify((await ben.agent.get("/api/account/export").expect(200)).body.bookmarks).includes("bm_left"));
  // Deleting the collab deletes its conversations and every bookmark in them.
  await ana.agent.delete(`/api/collabs/${team}`).expect(200);
  assert.equal(count(s, ana.user.id), 0);
});

// ---- Rules: what can be bookmarked, and what removes a bookmark ----

test("only saved chat, code and Uncensored messages; Symposium runs are refused", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  for (const mode of ["chat", "code", "uncensored"]) {
    const c = conversation(s, a.user.id, mode, exchange("q", "a"), { mode });
    await star(a, c.ids[1]).expect(201);
  }
  for (const mode of ["symposium", "private", "ephemeral"]) {
    const c = conversation(s, a.user.id, mode, exchange("q", "a"), { mode });
    const r = await star(a, c.ids[1]).expect(400);
    assert.equal(r.body.error.code, "bookmark_excluded");
  }
  // Off the record and Private Mode never save a message, so there is no id
  // to star: the chat route stores nothing at all.
  const before = s.db.prepare("SELECT COUNT(*) n FROM messages").get().n;
  await a.agent
    .post("/api/chat")
    .send({ model: MODEL, messages: [{ role: "user", content: "off the record" }], max_tokens: 50, ephemeral: true })
    .expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, before);
});

test("deleting the conversation, delete-all and cap pruning delete its bookmarks", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const one = conversation(s, a.user.id, "One", exchange("q1", "a1"));
  const two = conversation(s, a.user.id, "Two", exchange("q2", "a2"));
  await star(a, one.ids[1], "note one");
  await star(a, two.ids[1]);
  await a.agent.delete("/api/conversations/" + one.id).expect(200);
  assert.equal(count(s, a.user.id), 1);
  assert.deepEqual((await list(a)).data.map((x) => x.message_id), [two.ids[1]]);
  await a.agent.delete("/api/conversations").expect(200);
  assert.equal(count(s, a.user.id), 0);

  // The personal-conversation cap removes the oldest chat, and its bookmarks.
  const oldest = conversation(s, a.user.id, "Oldest", exchange("old q", "old a"));
  s.db.prepare("UPDATE conversations SET updated=1 WHERE id=?").run(oldest.id);
  await star(a, oldest.ids[1]).expect(201);
  transaction(s.db, () => {
    const insert = s.db.prepare(
      "INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)",
    );
    for (let i = 0; i < 300; i++) insert.run(uid("c_"), a.user.id, "filler", "chat", now(), now() + i);
  });
  await a.agent.post("/api/conversations").send({ title: "Newest" }).expect(201);
  assert.equal(s.db.prepare("SELECT 1 FROM conversations WHERE id=?").get(oldest.id), undefined);
  assert.equal(count(s, a.user.id), 0);
});

test("auto-delete: hidden the moment the chat expires, deleted with it by the worker", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const c = conversation(s, a.user.id, "Short-lived", exchange("q", "a"), { expires: now() + 60000 });
  const b = (await star(a, c.ids[1], "keep?").expect(201)).body;
  // An auto-deleting chat can be bookmarked; the bookmark says when it goes.
  assert.equal(b.expires, s.db.prepare("SELECT expires FROM conversations WHERE id=?").get(c.id).expires);
  s.db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(now() - 1, c.id);
  const r = await list(a);
  assert.equal(r.total, 0);
  assert.equal(r.data.length, 0);
  await a.agent.patch("/api/bookmarks/" + b.id).send({ note: "x" }).expect(404);
  await star(a, c.ids[0]).expect(404);
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.deepEqual(exported.bookmarks, []);
  await s.tick();
  assert.equal(count(s, a.user.id), 0);
});

test("a bookmark stays on its exact message: branches copy messages without it", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const c = conversation(s, a.user.id, "Original", [...exchange("one", "first"), ...exchange("two", "second")]);
  const b = (await star(a, c.ids[1], "the first answer").expect(201)).body;
  const branch = (
    await a.agent
      .post(`/api/conversations/${c.id}/branch`)
      .send({ through: c.ids[1], requestId: "branch-1" })
      .expect(201)
  ).body;
  const copy = (await a.agent.get("/api/conversations/" + branch.id).expect(200)).body;
  assert.equal(copy.messages.length, 2);
  assert.ok(!copy.messages.some((m) => m.id === c.ids[1]), "copies get new ids");
  assert.equal((await list(a, "?conversation=" + branch.id)).data.length, 0);
  const still = (await list(a)).data;
  assert.equal(still.length, 1);
  assert.equal(still[0].id, b.id);
  assert.equal(still[0].conversation_id, c.id);
  assert.equal(still[0].message_id, c.ids[1]);
  // Deleting the branch leaves it; deleting the original takes it, even
  // though the branch still has a copy of the message.
  await a.agent.delete("/api/conversations/" + branch.id).expect(200);
  assert.equal(count(s, a.user.id), 1);
  const again = (
    await a.agent
      .post(`/api/conversations/${c.id}/branch`)
      .send({ through: c.ids[1], requestId: "branch-2" })
      .expect(201)
  ).body;
  await a.agent.delete("/api/conversations/" + c.id).expect(200);
  assert.equal(count(s, a.user.id), 0);
  assert.equal((await a.agent.get("/api/conversations/" + again.id).expect(200)).body.messages.length, 2);
});

// ---- Jump to message ----

test("jump to message: the link opens its conversation, which holds the message, however long", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push(...exchange("question " + i, "answer " + i));
  const c = conversation(s, a.user.id, "Very long chat", rows, { mode: "uncensored" });
  const target = c.ids[7];
  const b = (await star(a, target).expect(201)).body;
  const link = bookmarkLink(b);
  assert.equal(link, `/workspace/uncensored?c=${c.id}&m=${target}`);
  const url = new URL(link, "http://x");
  const saved = (await a.agent.get("/api/conversations/" + url.searchParams.get("c")).expect(200)).body;
  assert.equal(saved.messages.length, 400, "the whole chat is loaded, so the message can scroll into view");
  assert.equal(saved.messages.findIndex((m) => m.id === url.searchParams.get("m")), 7);
  assert.equal(bookmarkLink({ ...b, conversation_mode: "symposium" }, { demo: true }).startsWith("/workspace/chat?demo=1&"), true);
  // The workspace scrolls to it and marks it, only with the update live.
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(ws, /data-message-id=\{m\.id \|\| undefined\}/);
  assert.match(ws, /const jumpTo = params\.get\("m"\);/);
  assert.match(ws, /!bookmarksReleased\(config\)\) return;/);
  assert.match(ws, /target\.scrollIntoView\(\{ block: "start" \}\)/);
  assert.match(ws, /" bookmark-target"/);
});

// ---- Caps ----

test("up to 1,000 bookmarks per account; expired chats free their places", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const b = await person(s.app, "ben");
  const big = conversation(s, a.user.id, "Big", Array.from({ length: MAX_BOOKMARKS + 2 }, (_, i) => ["user", "m" + i]));
  transaction(s.db, () => {
    const insert = s.db.prepare(
      "INSERT INTO bookmarks(id,user_id,message_id,note,created,updated) VALUES(?,?,?,?,?,?)",
    );
    for (let i = 0; i < MAX_BOOKMARKS - 1; i++) insert.run(uid("bm_"), a.user.id, big.ids[i], "", now(), now());
  });
  await star(a, big.ids[MAX_BOOKMARKS - 1]).expect(201);
  const full = await star(a, big.ids[MAX_BOOKMARKS]).expect(409);
  assert.equal(full.body.error.code, "bookmark_limit");
  assert.match(full.body.error.message, /1,000/);
  // Re-starring one you already have still answers.
  await star(a, big.ids[0]).expect(200);
  // Another account's count is its own.
  const theirs = conversation(s, b.user.id, "Theirs", exchange("q", "a"));
  await star(b, theirs.ids[1]).expect(201);
  // The database refuses a 1,001st too, whatever writes it.
  assert.throws(
    () =>
      s.db
        .prepare("INSERT INTO bookmarks(id,user_id,message_id,note,created,updated) VALUES(?,?,?,?,?,?)")
        .run("bm_over", a.user.id, big.ids[MAX_BOOKMARKS], "", now(), now()),
    /bookmark_limit/,
  );
  // A list page is at most 1,000.
  assert.equal((await list(a, "?limit=1000")).data.length, 1000);
  // Bookmarks in a chat past its auto-delete time no longer count.
  const brief = conversation(s, a.user.id, "Brief", exchange("q", "a"), { expires: now() + 60000 });
  s.db.prepare("DELETE FROM bookmarks WHERE message_id=?").run(big.ids[0]);
  await star(a, brief.ids[1]).expect(201);
  s.db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(now() - 1, brief.id);
  await star(a, big.ids[MAX_BOOKMARKS]).expect(201);
  assert.equal(count(s, a.user.id), MAX_BOOKMARKS);
});

// ---- Export and deletion ----

test("the export lists ids and notes without repeating message text; closure and Panic Wipe delete them", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana");
  const ben = await person(s.app, "ben");
  const team = await collab(s, ben, [ana]);
  const mine = conversation(s, ana.user.id, "Mine", exchange("my question", "the unmistakable answer"));
  const shared = conversation(s, ben.user.id, "Shared", exchange("team q", "team a"), { collab: team });
  const b1 = (await star(ana, mine.ids[1], "keep this").expect(201)).body;
  const b2 = (await star(ana, shared.ids[1]).expect(201)).body;
  const exported = (await ana.agent.get("/api/account/export").expect(200)).body;
  assert.deepEqual(
    exported.bookmarks.map((x) => Object.keys(x).sort()),
    [b1, b2].map(() => ["conversation_id", "created", "id", "message_id", "note", "updated"]),
  );
  assert.deepEqual(exported.bookmarks.map((x) => [x.id, x.message_id, x.conversation_id, x.note]), [
    [b1.id, mine.ids[1], mine.id, "keep this"],
    [b2.id, shared.ids[1], shared.id, ""],
  ]);
  assert.equal(JSON.stringify(exported).split("the unmistakable answer").length - 1, 1, "the text appears once, in its conversation");
  // Ben's export has none of Ana's.
  assert.deepEqual((await ben.agent.get("/api/account/export").expect(200)).body.bookmarks, []);
  // Closing the account deletes every bookmark, including one in a collab
  // whose conversation stays.
  await ana.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(count(s, ana.user.id), 0);
  assert.ok(s.db.prepare("SELECT 1 FROM messages WHERE id=?").get(shared.ids[1]), "the shared message stays");

  // Panic Wipe too.
  const eve = await person(s.app, "eve");
  const hers = conversation(s, eve.user.id, "Hers", exchange("q", "a"));
  await star(eve, hers.ids[0], "hers").expect(201);
  await eve.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(count(s, eve.user.id), 0);
});

// ---- Browser helpers ----

test("browser helpers: which messages show a star, fresh message ids, notes and excerpts", () => {
  const base = { conversation: "c_1", mode: "chat", ephemeral: false, privateMode: false, deviceOnly: false, demo: false };
  const reply = { role: "assistant", content: "hi" };
  assert.equal(canBookmark({ ...base, message: reply }), true);
  assert.equal(canBookmark({ ...base, message: { role: "user", content: "q" }, mode: "code" }), true);
  for (const [why, extra] of [
    ["unsaved chat", { conversation: null }],
    ["off the record", { ephemeral: true }],
    ["Private Mode", { privateMode: true }],
    ["Device Vault", { deviceOnly: true }],
    ["demo", { demo: true }],
    ["Symposium", { mode: "symposium" }],
    ["prepared example", { message: { ...reply, sample: true } }],
    ["system message", { message: { role: "system", content: "x" } }],
  ])
    assert.equal(canBookmark({ ...base, message: reply, ...extra }), false, why);
  const local = [{ role: "user" }, { role: "assistant" }];
  const saved = [{ id: "m_1", role: "user" }, { id: "m_2", role: "assistant" }];
  assert.equal(savedIdAt(local, saved, 1), "m_2");
  assert.equal(savedIdAt(local, saved.slice(0, 1), 1), null, "lists differ in length");
  assert.equal(savedIdAt([{ role: "assistant" }, { role: "assistant" }], saved, 1), null, "roles differ");
  assert.equal(normalizeNote("  a\n\tb    c "), "a b c");
  assert.deepEqual(excerptOf("x\n\ny", "assistant"), { excerpt: "x y", more: false });
  // Markdown reads as plain words; identifiers and arithmetic stay as written.
  assert.equal(
    excerptOf("Take the **07:30 ferry** — `fast`.\n\n1. Book seats.\n- Rent a car\n# Plan\n> tip\n[map](https://example.test/x)\n```js\nconst a_b = 2 * 3;\n```").excerpt,
    "Take the 07:30 ferry — fast. Book seats. Rent a car Plan tip map const a_b = 2 * 3;",
  );
});

test("the palette offers Bookmarks only when it's released", () => {
  const cfg = (...ids) => ({ releases: { features: Object.fromEntries(ids.map((id) => [id, true])) } });
  const on = ["historylibrary", "images", "palette"];
  const find = (config, extra = {}) =>
    paletteActions({ config, mode: "chat", signedIn: true, ...extra }).find((a) => a.id === "bookmarks");
  assert.equal(find(cfg(...on)), undefined);
  const item = find(cfg(...on, "bookmarks"));
  assert.equal(item.to, "/workspace/library");
  assert.deepEqual(item.state, { libraryTab: "bookmarks" });
  assert.equal(find(cfg(...on, "bookmarks"), { signedIn: false }), undefined);
  assert.equal(find(cfg(...on, "bookmarks"), { demo: true }), undefined);
});

// ---- Chinese ----

const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
const han = /\p{Script=Han}/u;

test("the Chinese dictionary covers the update, the star, the note and the Bookmarks tab", () => {
  const entry = UPDATES.find((u) => u.id === "bookmarks");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Bookmarks is coming soon.",
    "Bookmark",
    "Bookmarked",
    "Bookmark this message",
    "Remove this bookmark",
    "Add note",
    "Edit note",
    "Private note",
    "Why this one matters…",
    "Save note",
    "Saved to your bookmarks.",
    "See all bookmarks",
    "Reopen this chat to bookmark this message.",
    "That bookmarked message is no longer in this chat.",
    "Open bookmarks",
    "Search bookmarks",
    "A word from the message, the chat or your note…",
    "All",
    "Answers",
    "Prompts",
    "With notes",
    "Answer",
    "Your prompt",
    "Prompt by",
    "Note",
    "In",
    "Shared in",
    "Open at message",
    "Remove",
    "Load more bookmarks",
    "No bookmarks match.",
    "No bookmarks yet. Star a message in any saved chat and it will wait for you here.",
    "An image or attachment, without text.",
    "Auto-deletes with its chat on 10/3/2026",
    "12 bookmarks · up to 1,000",
    "1 bookmark · up to 1,000",
    "Star any message in a saved chat to keep it here. Only you see your bookmarks and notes, even in shared Collab chats. Off-the-record and Private chats aren’t saved, so they can’t be bookmarked.",
    "Sign in to bookmark messages. Bookmarks are kept with your account, and only you can see them.",
    "Keep a note to 140 characters.",
    "Message not found.",
    "Bookmark not found.",
    "You can keep up to 1,000 bookmarks. Remove one to add another.",
    "Only messages in saved chat, code and Uncensored conversations can be bookmarked.",
    "Your bookmarks and their notes, in every chat",
    "Bookmarks: which messages you starred and your private notes, up to 1,000 per account, visible only to you. A bookmark stores no copy of the message: it goes when you remove it, when its chat is deleted or auto-deleted, when you leave the collab it belongs to, and when you wipe or close your account.",
    "The export also lists your bookmarks: each one’s message and conversation ids and your note. The messages themselves are already in the export.",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
});

// Bookmarks.jsx compiled for Node with the same esbuild Vite uses; shared UI
// and routing are swapped for plain stand-ins so only its own text renders.
async function pageModule() {
  const src = new URL("../src/Bookmarks.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-bookmarks-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub("ui.mjs", `export const Notice = ({ children }) => React.createElement("div", null, children);`);
  const router = stub(
    "router.mjs",
    `export const Link = ({ children, to, className }) => React.createElement("a", { href: to, className }, children);`,
  );
  const icons = stub("icons.mjs", `export const Star = () => React.createElement("svg");`);
  // Math & Diagrams (unreleased here): the excerpt as plain text.
  const rich = stub(
    "rich.mjs",
    `export const MathText = ({ text }) => text;
     export const diagramsReleased = () => false;`,
  );
  const out = code
    .replace(/^import "\.\/bookmarks\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "lucide-react"/g, `from "${icons}"`)
    .replace(/from "\.\/RichMarkdown\.jsx"/g, `from "${rich}"`)
    .replace(/from "\.\/(lib|veil|seed-guard|bookmarks)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "Bookmarks.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Text split by whether it sits inside data-i18n="off" (the user's and the
// model's words) or not (the page's own, to be translated).
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr"]);
  const stack = [],
    page = [],
    kept = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g))
        (off || stack.some((x) => x.off) ? kept : page).push(entities(attr));
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>")) stack.push({ off });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    }
  }
  const words = (list) => list.filter((x) => /[A-Za-z]{2}/.test(x));
  return { page: words(page), kept: words(kept) };
}

test("the Bookmarks page marks your words and the model's off, and translates the rest", async () => {
  const { default: BookmarksPanel, BookmarkCard } = await pageModule();
  const card = (b, extra = {}) =>
    renderToStaticMarkup(createElement(BookmarkCard, { b, modelName: "Gemini 2.5 Flash", config: {}, ...extra }));
  const base = {
    id: "bm_1",
    message_id: "m_1",
    conversation_id: "c_1",
    conversation_title: "Greek islands",
    conversation_mode: "chat",
    collab: null,
    expires: null,
    role: "assistant",
    model: MODEL,
    author: null,
    message_created: Date.UTC(2026, 8, 25),
    excerpt: "Naxos has warm water in May",
    more: false,
    note: "Trip planning note",
    created: Date.UTC(2026, 8, 25),
    updated: Date.UTC(2026, 8, 25),
  };
  const html = [
    card(base),
    card({ ...base, role: "user", model: null, author: "benedict", excerpt: "", note: "", collab: { id: "k", name: "Launch crew" }, expires: Date.UTC(2026, 9, 3) }),
    card({ ...base, role: "user", model: null }, { editing: true }),
    renderToStaticMarkup(createElement(BookmarksPanel, { user: null, demo: false, config: {} })),
  ].join("");
  const { page, kept } = textsOf(html);
  for (const text of ["Greek islands", "Naxos has warm water in May", "Trip planning note", "Gemini 2.5 Flash", "benedict", "Launch crew"])
    assert.ok(kept.includes(text), "kept as written: " + text);
  assert.ok(page.includes("Open at message"));
  assert.ok(page.includes("Prompt by"));
  assert.match(html, /href="\/workspace\/chat\?c=c_1&amp;m=m_1"/);
  for (const text of page) assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
});
