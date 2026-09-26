import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { uid, now } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { knownPage } from "../src/site-routes.js";
import { MODE_FEATURES, modeReleased } from "../src/lib.js";
import { buildChatRequest } from "../src/estimate.js";
import { createVeilState } from "../src/veil.js";
import { vaultChat } from "../src/device-vault.js";
import { rankPalette, GROUPS } from "../src/command-palette.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  MAX_PROJECTS,
  MAX_PINNED,
  PROJECT_COLORS,
  PRIVACY_LABELS,
  PRIVACY_HELP,
  privacyChoices,
  projectChatStart,
  storedPrivacy,
  effectivePrivacy,
  withDeviceChoice,
  withProjectInstructions,
  projectRequestFields,
  pinnedFilesBlocked,
  withPinnedDocuments,
  projectItems,
  projectChatPath,
  projectPagePath,
  projectProblems,
} from "../src/projects.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
// The reference snapshot has no zero-data-retention labels, so one model is
// counted as private through the operator override.
const PRIVATE = "venice/venice-uncensored-1-2";
const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-projects-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: released ?? "all",
    mvpModels: [MODEL, PRIVATE],
    privateModels: [PRIVATE],
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(app, username = "u" + randomBytes(4).toString("hex")) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor % 250}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const create = async (p, body = {}) =>
  (await p.agent.post("/api/projects").send({ name: "Launch plan", ...body }).expect(201)).body;
const chat = (extra = {}) => ({
  model: MODEL,
  messages: [{ role: "user", content: "Draft the launch post" }],
  max_tokens: 50,
  requestId: uid(),
  ...extra,
});
// The conversation a streamed chat saved into, from its final event.
const conversationOf = (text) => {
  let id = null;
  for (const line of text.split("\n"))
    if (line.startsWith("data: {")) {
      const e = JSON.parse(line.slice(6));
      if (e.conversationId) id = e.conversationId;
    }
  return id;
};
const send = async (p, extra, status = 200) => {
  const r = await p.agent.post("/api/chat").send(chat(extra)).expect(status);
  return status === 200 ? conversationOf(r.text) : r.body;
};
const upload = async (p, name = "brief.md", text = "# Brief\nShip on Friday.") =>
  (
    await p.agent
      .post("/api/files")
      .send({ filename: name, data: Buffer.from(text).toString("base64"), consent: true })
      .expect(201)
  ).body;
const count = (s, table, where = "1", ...args) =>
  s.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...args).n;

test("Projects is registered, unreleased and gated like any update", async (t) => {
  const entry = UPDATES.find((u) => u.id === "projects");
  assert.ok(entry, "projects is registered");
  assert.equal(entry.title, "Projects");
  assert.equal(entry.tagline, "Keep related chats, files and instructions together.");
  assert.equal(entry.points.length, 3);
  assert.equal(committed[UPDATES.indexOf(entry)], false, "unreleased until its release commit");
  const gate = (path, method = "GET", body = {}, query) =>
    featuresFor({ path, method, body, query });
  assert.deepEqual(gate("/api/projects"), ["projects"]);
  assert.deepEqual(gate("/API/Projects/prj_1"), ["projects"]);
  assert.deepEqual(gate("/api/projects/prj_1", "DELETE"), ["projects"]);
  assert.deepEqual(gate("/api/projects/prj_1/chats", "POST", { conversationId: "c" }), ["projects"]);
  assert.deepEqual(gate("/api/projects/prj_1/chats/c_1", "DELETE"), ["projects"]);
  // What a project turns on needs its own update too.
  assert.deepEqual(gate("/api/projects", "POST", { files: [] }), ["projects", "files"]);
  assert.deepEqual(gate("/api/projects", "POST", { privacy: "off_record" }), ["projects", "ephemeral"]);
  // Device only is kept in the browser: the server never gates on the vault.
  assert.deepEqual(gate("/api/projects/p", "PATCH", { privacy: "device" }), ["projects"]);
  assert.deepEqual(gate("/api/projects", "POST", { privacy: "private" }), ["projects", "private", "ephemeral"]);
  assert.deepEqual(gate("/api/projects", "POST", { privacy: "normal" }), ["projects"]);
  assert.deepEqual(gate("/api/projects", "POST", { privacy: "__proto__" }), ["projects"]);
  assert.deepEqual(gate("/api/projects", "POST", { privacy: "constructor" }), ["projects"]);
  // A chat filed in a project, and history search narrowed to one.
  assert.deepEqual(gate("/api/chat", "POST", { project: "p" }), ["projects"]);
  assert.deepEqual(gate("/api/chat", "POST", { project: "p", mode: "symposium" }), ["projects", "symposium"]);
  assert.deepEqual(gate("/api/chat", "POST", {}), []);
  assert.deepEqual(gate("/api/history/search", "GET", {}, { q: "ab", project: "p" }), ["historylibrary", "projects"]);
  assert.deepEqual(gate("/api/history/search", "GET", {}, { q: "ab" }), ["historylibrary"]);
  // The workspace page shows as coming soon until released.
  assert.equal(MODE_FEATURES.projects, "projects");
  assert.ok(knownPage("/workspace/projects"));
  const off = { releases: { features: { projects: false } } };
  const on = { releases: { features: { projects: true } } };
  assert.equal(modeReleased(off, "projects"), false);
  assert.equal(modeReleased(on, "projects"), true);

  // Unreleased: the routes, a filed chat and a project-narrowed search are
  // refused before anything runs, and chats carry no project field.
  const s = fixture(t, "mvp,historylibrary");
  const a = await person(s.app);
  const refused = async (res) => {
    const r = await res.expect(403);
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.equal(r.body.error.message, "Projects is coming soon.");
  };
  await refused(a.agent.get("/api/projects"));
  await refused(a.agent.post("/api/projects").send({ name: "x" }));
  await refused(a.agent.post("/api/chat").send(chat({ project: "prj_x" })));
  await refused(a.agent.get("/api/history/search?q=launch&project=prj_x"));
  assert.equal(count(s, "holds"), 0, "nothing was reserved for a refused chat");
  const id = await send(a, {});
  const list = (await a.agent.get("/api/conversations").expect(200)).body.data;
  assert.ok(list.length === 1 && !("project_id" in list[0]));
  assert.ok(!("project_id" in (await a.agent.get("/api/conversations/" + id).expect(200)).body));
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.ok(!("projects" in exported), "no projects key before release");
  await a.agent.get("/api/history/search?q=launch").expect(200);

  // Released on its own: a default privacy mode or pinned files still need
  // their own updates.
  const r = fixture(t, "mvp,projects");
  const b = await person(r.app);
  const needs = async (body, title) => {
    const res = await b.agent.post("/api/projects").send({ name: "x", ...body }).expect(403);
    assert.equal(res.body.error.message, `${title} is coming soon.`);
  };
  await needs({ privacy: "off_record" }, "Ephemeral Chats");
  await needs({ privacy: "private" }, "Private Mode");
  await needs({ files: [] }, "Files & Reusable Uploads");
  await b.agent.post("/api/projects").send({ name: "Plain" }).expect(201);
  assert.equal((await b.agent.get("/api/projects").expect(200)).body.projects.length, 1);
});

test("create, read, change and delete a project; only its owner can", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  const p = await create(a, {
    name: "  Launch plan  ",
    color: "amber",
    instructions: "Write in British English.",
    privacy: "normal",
    model: MODEL,
  });
  assert.match(p.id, /^prj_/);
  assert.equal(p.name, "Launch plan", "trimmed");
  assert.equal(p.color, "amber");
  assert.equal(p.instructions, "Write in British English.");
  assert.equal(p.privacy, "normal");
  assert.equal(p.model, MODEL);
  assert.deepEqual(p.files, []);
  assert.deepEqual(p.chats, []);
  assert.deepEqual(p.runs, []);
  // Defaults.
  const bare = await create(a, { name: "Notes" });
  assert.equal(bare.color, "cobalt");
  assert.equal(bare.privacy, "normal");
  assert.equal(bare.model, null);
  assert.equal(bare.instructions, "");
  const list = (await a.agent.get("/api/projects").expect(200)).body;
  assert.deepEqual(list.projects.map((x) => x.name), ["Launch plan", "Notes"], "oldest first");
  assert.equal(list.max_projects, MAX_PROJECTS);
  assert.equal(list.max_pinned, MAX_PINNED);
  // Validation.
  const bad = async (body, code = "invalid_project") => {
    const r = await a.agent.post("/api/projects").send({ name: "x", ...body }).expect(400);
    assert.equal(r.body.error.code, code);
  };
  await bad({ name: "" });
  await bad({ name: "   " });
  await bad({ name: "x".repeat(61) });
  await bad({ name: 5 });
  await bad({ color: "#ff0000" });
  await bad({ instructions: "x".repeat(4001) });
  await bad({ privacy: "public" });
  // Device only is this browser's choice; the server stores off the record.
  await bad({ privacy: "device" });
  await bad({ model: "no/such-model" }, "invalid_model");
  await bad({ files: "file-1" });
  await bad({ files: ["a", "a"] });
  // PATCH keeps what it leaves out, and can clear the model.
  const changed = (
    await a.agent.patch("/api/projects/" + p.id).send({ name: "Launch", model: null }).expect(200)
  ).body;
  assert.equal(changed.name, "Launch");
  assert.equal(changed.model, null);
  assert.equal(changed.color, "amber");
  assert.equal(changed.instructions, "Write in British English.");
  // Another account can't read, change, delete or use it: the same 404 as
  // a project that doesn't exist.
  const missing = async (res) => {
    const r = await res.expect(404);
    assert.equal(r.body.error.code, "project_not_found");
  };
  await missing(b.agent.get("/api/projects/" + p.id));
  await missing(b.agent.patch("/api/projects/" + p.id).send({ name: "Mine now" }));
  await missing(b.agent.delete("/api/projects/" + p.id));
  await missing(b.agent.get("/api/history/search?q=launch&project=" + p.id));
  await missing(b.agent.post("/api/chat").send(chat({ project: p.id })));
  assert.equal(count(s, "holds", "user_id=?", b.user.id), 0, "refused before any reservation");
  assert.deepEqual((await b.agent.get("/api/projects").expect(200)).body.projects, []);
  const bChat = await send(b, {});
  await missing(b.agent.post(`/api/projects/${p.id}/chats`).send({ conversationId: bChat }));
  // Nor move someone else's chat into their own project.
  const aChat = await send(a, {});
  const bProject = await create(b, { name: "B" });
  await b.agent
    .post(`/api/projects/${bProject.id}/chats`)
    .send({ conversationId: aChat })
    .expect(404);
  // The database refuses a cross-account row whatever code writes it.
  assert.throws(
    () =>
      s.db
        .prepare("INSERT INTO project_chats(conversation_id,project_id,user_id,added) VALUES(?,?,?,?)")
        .run(aChat, bProject.id, b.user.id, now()),
    /project_owner_only/,
  );
  assert.throws(
    () =>
      s.db
        .prepare("INSERT INTO project_chats(conversation_id,project_id,user_id,added) VALUES(?,?,?,?)")
        .run(aChat, bProject.id, a.user.id, now()),
    /project_owner_only/,
  );
  // Deleting a project keeps its chats, unfiled.
  await a.agent.post(`/api/projects/${p.id}/chats`).send({ conversationId: aChat }).expect(200);
  await a.agent.delete("/api/projects/" + p.id).expect(200);
  await missing(a.agent.get("/api/projects/" + p.id));
  const kept = (await a.agent.get("/api/conversations").expect(200)).body.data.find((c) => c.id === aChat);
  assert.ok(kept, "the chat is still saved");
  assert.equal(kept.project_id, null);
  assert.equal(count(s, "project_chats"), 0);
});

test("a new chat is filed in its project; off the record, Private and Device only chats store nothing", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const p = await create(a, { privacy: "normal" });
  const id = await send(a, { project: p.id });
  assert.ok(id);
  const detail = (await a.agent.get("/api/projects/" + p.id).expect(200)).body;
  assert.deepEqual(detail.chats.map((c) => c.id), [id]);
  assert.equal(detail.chat_count, 1);
  const listed = (await a.agent.get("/api/conversations").expect(200)).body.data;
  assert.equal(listed.find((c) => c.id === id).project_id, p.id);
  assert.equal((await a.agent.get("/api/conversations/" + id).expect(200)).body.project_id, p.id);
  // A message added to a saved chat stays where the chat is; naming a
  // project with it is refused rather than moving the chat.
  await send(a, { conversationId: id });
  const refusedMove = await send(a, { conversationId: id, project: p.id }, 400);
  assert.equal(refusedMove.error.code, "invalid_request");

  // Off the record, Private Mode and Device only projects start their chats
  // off the record in the browser, and the browser never sends the project
  // with them (projectRequestFields). Such a chat stores nothing.
  const before = {
    conversations: count(s, "conversations"),
    messages: count(s, "messages"),
    filed: count(s, "project_chats"),
  };
  for (const privacy of ["off_record", "private", "device"]) {
    const q = await create(a, { name: privacy, privacy: storedPrivacy(privacy) });
    const here = effectivePrivacy(q, privacy === "device" ? [q.id] : [], true);
    assert.equal(here, privacy);
    const start = projectChatStart(here, { vault: true, privateMode: true });
    assert.equal(start.ephemeral, true, privacy);
    const fields = projectRequestFields(q, { ephemeral: start.ephemeral });
    assert.deepEqual(fields, {}, "no project id with an unsaved chat");
    const body = {
      ephemeral: true,
      ...(start.privateMode ? { private: true, model: PRIVATE } : {}),
      ...fields,
    };
    const r = await a.agent.post("/api/chat").send(chat(body)).expect(200);
    assert.match(r.text, /credits_charged/);
    assert.equal(conversationOf(r.text), null, "no conversation id is streamed");
    // And if a client did send the project with it, it's refused, and
    // nothing is reserved or stored.
    const held = count(s, "holds");
    const refused = await send(a, { ...body, project: q.id }, 400);
    assert.equal(refused.error.code, "invalid_request");
    assert.equal(count(s, "holds"), held);
    const view = (await a.agent.get("/api/projects/" + q.id).expect(200)).body;
    assert.deepEqual(view.chats, []);
  }
  assert.deepEqual(
    {
      conversations: count(s, "conversations"),
      messages: count(s, "messages"),
      filed: count(s, "project_chats"),
    },
    before,
    "nothing was saved or filed",
  );
});

test("chats move in and out of projects, and lists and history search filter by project", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const p = await create(a, { name: "Alpha" });
  const q = await create(a, { name: "Beta" });
  const one = await send(a, { messages: [{ role: "user", content: "Launch timeline for alpha" }] });
  const two = await send(a, { messages: [{ role: "user", content: "Launch budget for beta" }] });
  const three = await send(a, { messages: [{ role: "user", content: "Launch party ideas" }] });
  await a.agent.post(`/api/projects/${p.id}/chats`).send({ conversationId: one }).expect(200);
  await a.agent.post(`/api/projects/${q.id}/chats`).send({ conversationId: two }).expect(200);
  const byId = async () =>
    Object.fromEntries(
      (await a.agent.get("/api/conversations").expect(200)).body.data.map((c) => [c.id, c.project_id]),
    );
  assert.deepEqual(await byId(), { [one]: p.id, [two]: q.id, [three]: null });
  // From one project to another.
  await a.agent.post(`/api/projects/${q.id}/chats`).send({ conversationId: one }).expect(200);
  assert.deepEqual(await byId(), { [one]: q.id, [two]: q.id, [three]: null });
  assert.equal(count(s, "project_chats", "conversation_id=?", one), 1, "in one project at a time");
  // Out again: 404 when it isn't in that project.
  await a.agent.delete(`/api/projects/${p.id}/chats/${one}`).expect(404);
  await a.agent.delete(`/api/projects/${q.id}/chats/${one}`).expect(200);
  assert.deepEqual(await byId(), { [one]: null, [two]: q.id, [three]: null });
  await a.agent.post(`/api/projects/${q.id}/chats`).send({}).expect(400);
  await a.agent.post(`/api/projects/${q.id}/chats`).send({ conversationId: "c_nope" }).expect(404);
  // History search narrowed to a project.
  const search = async (query) =>
    (await a.agent.get("/api/history/search?q=launch" + query).expect(200)).body.data;
  assert.equal((await search("")).length, 3);
  const inBeta = await search("&project=" + q.id);
  assert.deepEqual(inBeta.map((h) => h.id), [two]);
  assert.equal(inBeta[0].project_id, q.id);
  assert.deepEqual(await search("&project=" + p.id), []);
  assert.equal((await search("")).find((h) => h.id === three).project_id, null);
  // A collab's shared chats stay in the collab.
  const collab = (await a.agent.post("/api/collabs").send({ name: "Team" }).expect(201)).body;
  const shared = (
    await a.agent.post(`/api/collabs/${collab.id}/conversations`).send({ title: "Shared" }).expect(201)
  ).body;
  await a.agent
    .post(`/api/projects/${q.id}/chats`)
    .send({ conversationId: shared.id })
    .expect(400);
  // An auto-deleted chat leaves the project at once.
  s.db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(now() - 1000, two);
  assert.deepEqual((await a.agent.get("/api/projects/" + q.id).expect(200)).body.chats, []);
});

test("Symposium runs and branches belong to a project", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const p = await create(a);
  const runs = [];
  for (let i = 0; i < 2; i++)
    runs.push(await send(a, { mode: "symposium", project: p.id }));
  const view = (await a.agent.get("/api/projects/" + p.id).expect(200)).body;
  assert.deepEqual(view.runs.map((r) => r.id).sort(), runs.sort());
  assert.equal(view.run_count, 2);
  assert.deepEqual(view.chats, [], "runs are listed apart from chats");
  assert.equal(
    (await a.agent.get("/api/projects").expect(200)).body.projects[0].run_count,
    2,
  );
  // A run can be moved out and back like a chat.
  await a.agent.delete(`/api/projects/${p.id}/chats/${runs[0]}`).expect(200);
  await a.agent.post(`/api/projects/${p.id}/chats`).send({ conversationId: runs[0] }).expect(200);
  // A branch of a filed chat is filed in the same project.
  const id = await send(a, { project: p.id });
  const saved = (await a.agent.get("/api/conversations/" + id).expect(200)).body;
  const reply = saved.messages.find((m) => m.role === "assistant");
  const branch = (
    await a.agent
      .post(`/api/conversations/${id}/branch`)
      .send({ through: reply.id, requestId: uid() })
      .expect(201)
  ).body;
  assert.equal((await a.agent.get("/api/conversations/" + branch.id).expect(200)).body.project_id, p.id);
});

test("pinned files are the owner's own saved text files, up to five, and go with the upload", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  const f1 = await upload(a, "brief.md", "# Brief\nShip on Friday.");
  const f2 = await upload(a, "style.txt", "Short sentences.");
  const p = await create(a, { files: [f1.id, f2.id] });
  assert.deepEqual(p.files.map((f) => f.name), ["brief.md", "style.txt"], "in pin order");
  assert.equal(p.files[0].characters, "# Brief\nShip on Friday.".length);
  assert.ok(p.files[0].expires > now());
  // The text a new chat attaches comes from the owner's own file route.
  const text = (await a.agent.get(`/api/files/${f1.id}/text`).expect(200)).body;
  assert.equal(text.text, "# Brief\nShip on Friday.");
  // Replace the pins; up to five; never another account's upload.
  const more = [];
  for (let i = 0; i < 4; i++) more.push(await upload(a, `n${i}.txt`, "note " + i));
  const five = [f1.id, ...more.map((f) => f.id)];
  assert.equal((await a.agent.patch("/api/projects/" + p.id).send({ files: five }).expect(200)).body.files.length, 5);
  const six = await a.agent.patch("/api/projects/" + p.id).send({ files: [...five, f2.id] }).expect(400);
  assert.equal(six.body.error.code, "project_files_limit");
  const theirs = await upload(b, "secret.txt", "B's text");
  await a.agent.patch("/api/projects/" + p.id).send({ files: [theirs.id] }).expect(404);
  const empty = await create(a, { name: "Empty" });
  for (const user of [a.user.id, b.user.id])
    assert.throws(
      () =>
        s.db
          .prepare("INSERT INTO project_files(project_id,upload_id,user_id,added) VALUES(?,?,?,?)")
          .run(empty.id, theirs.id, user, now()),
      /project_owner_only/,
    );
  assert.throws(
    () =>
      s.db
        .prepare("INSERT INTO project_files(project_id,upload_id,user_id,added) VALUES(?,?,?,?)")
        .run(p.id, f2.id, a.user.id, now()),
    /project_files_limit/,
  );
  // An expired upload drops out at once, and its pin goes with it.
  s.db.prepare("UPDATE uploads SET expires=? WHERE id=?").run(now() - 1, f1.id);
  assert.ok(!(await a.agent.get("/api/projects/" + p.id).expect(200)).body.files.some((f) => f.id === f1.id));
  await a.agent.get("/api/files").expect(200); // runs cleanup
  assert.equal(count(s, "project_files", "upload_id=?", f1.id), 0);
  // Deleting the upload unpins it.
  await a.agent.delete("/api/files/" + more[0].id).expect(200);
  assert.deepEqual(
    (await a.agent.get("/api/projects/" + p.id).expect(200)).body.files.map((f) => f.id),
    more.slice(1).map((f) => f.id),
  );
  // Unpin everything.
  assert.deepEqual((await a.agent.patch("/api/projects/" + p.id).send({ files: [] }).expect(200)).body.files, []);
});

test("pinned files attach to a new chat in the project only where Saved files work", () => {
  const pinned = [
    { id: "file-1", name: "brief.md", text: "# Brief\nShip on Friday.", truncated: false },
    { id: "file-2", name: "style.txt", text: "Short sentences.", truncated: true },
  ];
  let n = 0;
  const docs = withPinnedDocuments([], pinned, () => "d" + ++n);
  assert.deepEqual(
    docs.map(({ id, name, pinned: from, kind, chars, truncated }) => ({ id, name, from, kind, chars, truncated })),
    [
      { id: "d1", name: "brief.md", from: "file-1", kind: "text", chars: 23, truncated: false },
      { id: "d2", name: "style.txt", from: "file-2", kind: "text", chars: 16, truncated: true },
    ],
  );
  // Never twice, and never past the composer's five.
  assert.equal(withPinnedDocuments(docs, pinned).length, 2);
  const local = [1, 2, 3, 4].map((i) => ({ id: "l" + i, name: i + ".txt", text: "x", kind: "text" }));
  assert.equal(withPinnedDocuments(local, pinned).length, 5);
  // The attached text goes with the first message, like any document.
  const { request } = buildChatRequest({ text: "Plan the week", documents: docs });
  assert.match(request.at(-1).content, /^Plan the week/);
  assert.match(request.at(-1).content, /<document name="brief.md"/);
  assert.match(request.at(-1).content, /Ship on Friday\./);
  // Saved files aren't available in Private Mode, off the record (Device
  // only too) or with Veil on, so pinned files aren't attached there.
  assert.equal(pinnedFilesBlocked({}), false);
  assert.equal(pinnedFilesBlocked({ privateMode: true }), true);
  assert.equal(pinnedFilesBlocked({ ephemeral: true }), true);
  assert.equal(pinnedFilesBlocked({ veilOn: true }), true);
});

test("instructions go with every chat in the project, after standing instructions, and Veil masks them", () => {
  const project = { id: "prj_1", instructions: "Reply to jane@example.com's team in British English." };
  assert.equal(withProjectInstructions("", project), project.instructions);
  assert.equal(withProjectInstructions("Be brief.", project), "Be brief.\n\n" + project.instructions);
  assert.equal(withProjectInstructions("Be brief.", { instructions: "  " }), "Be brief.");
  assert.equal(withProjectInstructions("", null), "");
  const history = [
    { role: "user", content: "First" },
    { role: "assistant", content: "Reply" },
  ];
  const instructions = withProjectInstructions("Be brief.", project);
  // Sent as the leading system message of every request, never saved.
  const plain = buildChatRequest({ messages: history, text: "Next", instructions });
  assert.deepEqual(plain.request[0], { role: "system", content: instructions });
  assert.equal(plain.next.length, 3, "the conversation shown carries no instructions");
  // Veil masks them in the browser, with the conversation's own map.
  const state = createVeilState();
  const veiled = buildChatRequest({
    messages: history,
    text: "Write to jane@example.com",
    instructions,
    veilWith: { state, words: [] },
  });
  assert.equal(veiled.request[0].role, "system");
  assert.ok(!veiled.request[0].content.includes("jane@example.com"), "masked");
  assert.match(veiled.request[0].content, /\[EMAIL_1\]/);
  assert.match(veiled.request.at(-1).content, /\[EMAIL_1\]/, "the same tag in the message");
  assert.equal(state.map.EMAIL_1, "jane@example.com");
  assert.ok(veiled.masked >= 2);
});

test("a project's default privacy mode decides how a new chat in it starts", () => {
  const live = { vault: true, privateMode: true };
  const off = { ephemeral: true, deviceOnly: false, privateMode: false };
  assert.deepEqual(projectChatStart("normal", live), { ephemeral: false, deviceOnly: false, privateMode: false });
  assert.deepEqual(projectChatStart("off_record", live), off);
  assert.deepEqual(projectChatStart("device", live), { ephemeral: true, deviceOnly: true, privateMode: false });
  assert.deepEqual(projectChatStart("private", live), { ephemeral: true, deviceOnly: false, privateMode: true });
  // A default that can't run here never falls back to a saved chat.
  assert.deepEqual(projectChatStart("device", { vault: false }), off);
  assert.deepEqual(projectChatStart("private", { privateMode: false }), off);
  // Only a new saved chat names its project.
  const p = { id: "prj_1" };
  assert.deepEqual(projectRequestFields(p, {}), { project: "prj_1" });
  assert.deepEqual(projectRequestFields(p, { ephemeral: true }), {});
  assert.deepEqual(projectRequestFields(p, { conversationId: "c_1" }), {});
  assert.deepEqual(projectRequestFields(null, {}), {});
  // The editor offers only defaults whose updates are live.
  const config = (ids) => ({ releases: { features: Object.fromEntries(ids.map((id) => [id, true])) } });
  assert.deepEqual(privacyChoices(config([])), ["normal"]);
  assert.deepEqual(privacyChoices(config(["ephemeral"])), ["normal", "off_record"]);
  assert.deepEqual(privacyChoices(config(["ephemeral", "vault", "private"])), ["normal", "off_record", "device", "private"]);
  assert.deepEqual(privacyChoices(config(["ephemeral", "vault", "private"]), { vault: false }), ["normal", "off_record", "private"]);
  assert.deepEqual(Object.keys(PRIVACY_LABELS), ["normal", "off_record", "device", "private"]);
  // Device only is kept in this browser: the server stores off the record,
  // which is also how the project starts in a browser without the vault.
  assert.equal(storedPrivacy("device"), "off_record");
  assert.equal(storedPrivacy("private"), "private");
  const q = { id: "prj_9", privacy: "off_record" };
  assert.equal(effectivePrivacy(q, ["prj_9"], true), "device");
  assert.equal(effectivePrivacy(q, ["prj_9"], false), "off_record");
  assert.equal(effectivePrivacy(q, [], true), "off_record");
  assert.equal(effectivePrivacy({ id: "prj_9", privacy: "normal" }, ["prj_9"], true), "normal");
  assert.deepEqual(withDeviceChoice(["a"], "b", "device"), ["a", "b"]);
  assert.deepEqual(withDeviceChoice(["a", "b"], "b", "off_record"), ["a"]);
  assert.deepEqual(withDeviceChoice(null, "b", null), []);
  assert.deepEqual(Object.keys(PRIVACY_HELP), Object.keys(PRIVACY_LABELS));
  // Device only chats are grouped by project inside the encrypted vault.
  const sealed = vaultChat({ id: "v1", mode: "chat", messages: [{ role: "user", content: "Hi" }], project: "prj_1" });
  assert.equal(sealed.project, "prj_1");
  assert.ok(!("project" in vaultChat({ id: "v2", mode: "chat", messages: [] })));
});

test("caps: 50 projects per account, and the conversation cap still applies to filed chats", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  for (let i = 0; i < MAX_PROJECTS; i++)
    s.db
      .prepare("INSERT INTO projects(id,user_id,name,color,created,updated) VALUES(?,?,?,?,?,?)")
      .run("prj_" + i, a.user.id, "P" + i, "cobalt", i, i);
  const r = await a.agent.post("/api/projects").send({ name: "One more" }).expect(409);
  assert.equal(r.body.error.code, "project_limit");
  assert.throws(
    () =>
      s.db
        .prepare("INSERT INTO projects(id,user_id,name,color,created,updated) VALUES(?,?,?,?,?,?)")
        .run("prj_x", a.user.id, "X", "cobalt", 1, 1),
    /project_limit/,
  );
  // Another account has its own 50.
  const b = await person(s.app);
  await create(b);
  // The oldest filed chat is pruned by the conversation cap like any other,
  // and leaves its project with it.
  await a.agent.delete("/api/projects/prj_0").expect(200);
  const p = await create(a);
  const old = await send(a, { project: p.id });
  s.db.prepare("UPDATE conversations SET updated=1 WHERE id=?").run(old);
  const insert = s.db.prepare(
    "INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)",
  );
  for (let i = 0; i < 299; i++) insert.run("c_fill" + i, a.user.id, "Filler", "chat", now(), now() + i);
  await a.agent.post("/api/conversations").send({ title: "Newest" }).expect(201);
  assert.equal(count(s, "conversations", "id=?", old), 0, "pruned");
  assert.equal(count(s, "project_chats", "conversation_id=?", old), 0);
  assert.deepEqual((await a.agent.get("/api/projects/" + p.id).expect(200)).body.chats, []);
});

test("Seed Guard refuses a seed phrase in a project's instructions", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const r = await a.agent
    .post("/api/projects")
    .send({ name: "Wallet", instructions: "My words: " + SEED })
    .expect(400);
  assert.equal(r.body.error.code, "seed_phrase_blocked");
  assert.doesNotMatch(r.body.error.message, /abandon/);
  const p = await create(a);
  await a.agent.patch("/api/projects/" + p.id).send({ instructions: SEED }).expect(400);
  assert.equal(count(s, "projects", "instructions LIKE ?", "%abandon%"), 0);
});

test("Panic Wipe, account closure and the account export include projects", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const f = await upload(a);
  const p = await create(a, { name: "Launch", color: "navy", instructions: "Be brief.", files: [f.id], model: MODEL });
  const id = await send(a, { project: p.id });
  const run = await send(a, { mode: "symposium", project: p.id });
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.deepEqual(exported.projects, [
    {
      id: p.id,
      name: "Launch",
      color: "navy",
      instructions: "Be brief.",
      privacy: "normal",
      model: MODEL,
      created: p.created,
      updated: p.updated,
      conversations: [id, run],
      pinned_files: [{ id: f.id, name: "brief.md" }],
    },
  ]);
  assert.ok(exported.conversations.some((c) => c.id === id), "the chat itself is exported too");
  // Panic Wipe erases projects with everything else.
  const other = await person(s.app);
  const kept = await create(other, { name: "Theirs" });
  await a.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(count(s, "projects", "user_id=?", a.user.id), 0);
  assert.equal(count(s, "project_chats", "user_id=?", a.user.id), 0);
  assert.equal(count(s, "project_files", "user_id=?", a.user.id), 0);
  assert.equal(count(s, "projects", "id=?", kept.id), 1, "another account's stay");
  // Closing an account does too.
  const c = await person(s.app);
  const cp = await create(c);
  await send(c, { project: cp.id });
  await c.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(count(s, "projects", "user_id=?", c.user.id), 0);
  assert.equal(count(s, "project_chats", "user_id=?", c.user.id), 0);
});

test("the Command Palette offers Go to project and New chat in project", () => {
  const projects = [
    { id: "prj_1", name: "Launch plan" },
    { id: "prj_2", name: "Thesis" },
  ];
  const items = projectItems(projects);
  assert.deepEqual(items.map((i) => i.key), ["project:prj_1", "project-new:prj_1", "project:prj_2", "project-new:prj_2"]);
  assert.ok(items.every((i) => i.group === "projects" && !i.i18n), "names are never translated");
  assert.deepEqual([...new Set(items.map((i) => i.detail))], ["Go to project", "New chat in project"]);
  assert.ok(GROUPS.some((g) => g.id === "projects" && g.label === "Projects"));
  const { groups } = rankPalette(items, "thesis");
  assert.deepEqual(groups[0].items.map((i) => i.key).sort(), ["project-new:prj_2", "project:prj_2"]);
  const newChat = rankPalette(items, "new chat in project").groups[0].items;
  assert.ok(newChat.every((i) => i.run === "new"));
  assert.equal(projectChatPath({ id: "prj_1" }, "code"), "/workspace/code?project=prj_1");
  assert.equal(projectChatPath({ id: "prj_1" }, "image"), "/workspace/chat?project=prj_1");
  assert.equal(projectPagePath({ id: "prj_1" }), "/workspace/projects?p=prj_1");
  assert.equal(projectPagePath(null), "/workspace/projects");
  assert.deepEqual(projectItems(null), []);
});

test("the editor's checks match the server's, and colors come from the house palette", () => {
  assert.deepEqual(projectProblems({ name: "Launch" }), {});
  assert.ok(projectProblems({ name: " " }).name);
  assert.ok(projectProblems({ name: "x".repeat(61) }).name);
  assert.ok(projectProblems({ name: "x", instructions: "y".repeat(4001) }).instructions);
  const brand = readFileSync(new URL("../src/brand.css", import.meta.url), "utf8").toLowerCase();
  for (const c of PROJECT_COLORS) assert.ok(brand.includes(c.hex), c.id);
});

// Projects.jsx compiled for Node with the same esbuild Vite uses. Shared UI,
// routing and Seed Guard are swapped for plain stand-ins so only this file's
// own text is rendered.
async function pageModule() {
  const src = new URL("../src/Projects.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-projects-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Icon = () => null;
     export const Button = ({ children, secondary, ...p }) => React.createElement("button", p, children);
     export const Notice = ({ children }) => React.createElement("div", { className: "notice" }, children);
     export const Empty = ({ title, children, action }) => React.createElement("div", null, React.createElement("h3", null, title), React.createElement("p", null, children), action);`,
  );
  const seed = stub(
    "seed.mjs",
    `export const SeedGuardNotice = () => null;
     export const seedGuardLive = () => false;
     export const useSeedScan = () => null;`,
  );
  const router = stub(
    "router.mjs",
    `export const Link = ({ children, to, ...p }) => React.createElement("a", { href: to, ...p }, children);
     export const useSearchParams = () => [new URLSearchParams(globalThis.__projectParams || ""), () => {}];`,
  );
  const out = code
    .replace(/^import "\.\/projects\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/SeedGuard\.jsx"/g, `from "${seed}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "\.\/lib\.js"/g, `from "${new URL("../src/lib.js", import.meta.url)}"`)
    .replace(/from "\.\/projects\.js"/g, `from "${new URL("../src/projects.js", import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "Projects.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
// The page's text, split by whether it sits inside data-i18n="off" (the
// account's own words) or not (the page's own, to be translated).
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "source", "wbr"]);
  const stack = [];
  const page = [],
    kept = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g))
        (off || stack.some((x) => x.off) ? kept : page).push(entities(attr));
      const noText = /^(script|style|code|pre|textarea|noscript|kbd|samp)$/i.test(m[2]);
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>")) stack.push({ off: off || noText });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    }
  }
  const words = (list) => list.filter((s) => /[A-Za-z]{2}/.test(s));
  return { page: words(page), kept: words(kept) };
}

test("the Projects page marks the account's words off and translates the rest", async () => {
  const dict = compileDictionary(
    JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")),
  );
  const han = /\p{Script=Han}/u;
  const mod = await pageModule();
  const { default: Projects, Editor, ProjectView, ProjectBar, ProjectsSidebar, ProjectPicker } = mod;
  const models = [{ id: "m-1", name: "Gemini 2.5 Flash", type: "chat", callable: true }];
  const all = ["projects", "files", "documents", "ephemeral", "vault", "private"];
  const config = { releases: { features: Object.fromEntries(all.map((id) => [id, true])) } };
  const file = { id: "file-1", name: "brief-notes.md", bytes: 10, kind: "document", truncated: false, characters: 10, expires: Date.parse("2026-10-01") };
  const project = {
    id: "prj_1",
    name: "Moonshot Launch",
    color: "amber",
    instructions: "Always answer like a pirate.",
    privacy: "off_record",
    model: "m-1",
    files: [file],
    chat_count: 1,
    run_count: 1,
    created: 1,
    updated: 1,
    chats: [{ id: "c1", title: "Pricing page draft", mode: "chat", updated: Date.parse("2026-09-20") }],
    runs: [{ id: "c2", title: "Which launch date", mode: "symposium", updated: Date.parse("2026-09-21") }],
  };
  const one = { ...project, chat_count: 1, run_count: 0, files: [file, file].map((f, i) => ({ ...f, id: "f" + i })) };
  const list = (items, device = []) => ({
    list: items,
    loaded: true,
    max: 50,
    byId: (id) => items.find((p) => p.id === id) || null,
    privacyOf: (p, vault) => effectivePrivacy(p, device, vault),
  });
  const vaultChat = { id: "v1", title: "Private planning notes", project: "prj_1", updated: Date.parse("2026-09-22") };
  const noop = () => {};
  const render = (el) => renderToStaticMarkup(el);
  const html = [
    render(createElement(Projects, { demo: true, user: null, config, models, projects: list([]) })),
    render(createElement(Projects, { demo: false, user: null, config, models, projects: list([]) })),
    render(createElement(Projects, { demo: false, user: { id: "u" }, config, models, projects: list([]) })),
    render(createElement(Projects, { demo: false, user: { id: "u" }, config, models, projects: list([project, { ...project, id: "prj_2", privacy: "normal", instructions: "", model: null, files: [], chat_count: 0, run_count: 3 }]) })),
    render(createElement(Projects, { demo: false, user: { id: "u" }, config, models, projects: list(Array.from({ length: 50 }, (_, i) => ({ ...project, id: "p" + i }))) })),
    ...["normal", "off_record", "device", "private"].map((privacy) =>
      render(
        createElement(ProjectView, {
          p: { ...project, privacy: privacy === "device" ? "off_record" : privacy },
          privacy,
          models,
          config,
          vaultLive: true,
          vault: privacy === "device" ? { unlocked: true, chats: [vaultChat] } : { unlocked: false, status: privacy === "private" ? "none" : "locked", chats: [] },
        }),
      ),
    ),
    render(createElement(ProjectView, { p: { ...project, instructions: "", files: [], chats: [], runs: [] }, privacy: "normal", models, config: { releases: { features: {} } }, vaultLive: true, vault: { unlocked: true, chats: [] } })),
    render(createElement(ProjectView, { p: { ...project, instructions: "", files: [], chats: [], runs: [] }, privacy: "normal", models, config, vaultLive: false })),
    ...[
      { name: "", color: "cobalt", instructions: "", privacy: "normal", model: null, files: [], pinned: [] },
      { id: "prj_1", name: "Moonshot Launch", color: "amber", instructions: "Always answer like a pirate.", privacy: "device", model: "m-1", files: ["file-1"], pinned: [file], original: project },
    ].map((draft) =>
      render(createElement(Editor, { draft, setDraft: noop, config, models, vaultLive: true, busy: false, error: "", onSave: noop, onCancel: noop, onDelete: noop })),
    ),
    render(createElement(ProjectBar, { project, saved: false, fresh: true, instructionsOn: true, attached: 1, pinsBlocked: true, note: "", onLeave: noop })),
    render(createElement(ProjectBar, { project: one, saved: false, fresh: true, instructionsOn: false, attached: 2, pinsBlocked: false, note: "Not saved, so not listed in the project" })),
    render(createElement(ProjectBar, { project, saved: true, fresh: false, instructionsOn: true, attached: 0, note: "Device only: grouped with this project in Device Vault" })),
    render(createElement(ProjectsSidebar, { projects: [project], currentId: "prj_1", onNew: noop })),
    render(createElement(ProjectsSidebar, { projects: [], onNew: noop })),
    render(createElement(ProjectsSidebar, { projects: Array.from({ length: 8 }, (_, i) => ({ ...project, id: "p" + i })), onNew: noop })),
    render(createElement(ProjectPicker, { projects: [project], value: null, onChange: noop })),
    render(createElement(ProjectPicker, { projects: [project], value: "prj_1", onChange: noop, label: "In project", none: "Any project" })),
  ].join("");
  const { page, kept } = textsOf(html);
  // The account's words stay as written: names, instructions, chat titles,
  // file names and model names.
  for (const text of ["Moonshot Launch", "Always answer like a pirate.", "Pricing page draft", "Which launch date", "brief-notes.md", "Gemini 2.5 Flash", "Private planning notes"])
    assert.ok(kept.includes(text), `kept as written: ${text}`);
  for (const text of ["Moonshot Launch", "Always answer like a pirate.", "Pricing page draft"])
    assert.ok(!page.includes(text), `never translated: ${text}`);
  // Everything else has a translation.
  assert.ok(page.includes("Pinned files aren't attached in Private Mode, off the record or with Veil on, like Saved files."));
  assert.ok(page.includes("New chats here start Device only: they're kept encrypted in this browser and listed below while Device Vault is unlocked, never on our servers."));
  const date = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
  for (const text of page) {
    if (date.test(text)) continue; // a bare date takes the zh-CN form (i18n.js)
    assert.match(translateText(text, dict) ?? "", han, `untranslated: ${text}`);
  }
  // And what the rest of the workspace shows for Projects.
  const entry = UPDATES.find((u) => u.id === "projects");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Projects is coming soon.",
    "Go to project",
    "New chat in project",
    "Show chats from",
    "All chats",
    "No project",
    "Every saved chat is in a project.",
    "No saved chats in this project yet.",
    "None here for this filter.",
    "A pinned file couldn't be attached. Its saved file may have expired.",
    "That project wasn't found.",
    "This run goes in the project",
    ", with its instructions.",
    "Projects, with their instructions and pinned files",
    ...Object.values(PRIVACY_LABELS),
    ...Object.values(PRIVACY_HELP),
    ...PROJECT_COLORS.map((c) => c.label),
    // Server messages the page shows.
    "Project not found.",
    "Give the project a name of 1–60 characters.",
    "Choose one of the project colors.",
    "Project instructions cannot exceed 4000 characters.",
    "Choose Normal, Off the record or Private Mode.",
    "Choose a chat model, or no default.",
    "Pin up to 5 files to a project.",
    "Pin saved text and Office files. Audio needs transcribing first.",
    "You can have up to 50 projects. Delete one to add another.",
    "This chat isn't in the project.",
    "A collab's shared chats stay in the collab; they can't join a project.",
    "This looks like a wallet seed phrase. A project's instructions are saved and sent with every chat in it, so ANONYMA won't save one. Remove it to continue.",
    "Off-the-record and Private chats are never saved, so they aren't filed in a project.",
    "A saved chat moves between projects from its details, not with a new message.",
    ...Object.values(projectProblems({ name: "" })),
    ...Object.values(projectProblems({ name: "x".repeat(61), instructions: "y".repeat(4001) })),
  ])
    assert.match(translateText(text, dict) ?? "", han, text);
});
