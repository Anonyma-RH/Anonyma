import { UPDATES } from "../server/releases.js";
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { addCredit, balance, now, uid } from "../server/core.js";
import { mediaRecipe } from "../server/history-library.js";
import { createMediaStore } from "../server/media.js";
const imageModel = "google/gemini-2.5-flash-image";
function fixture(t, extra = {}) {
  const d = mkdtempSync(join(tmpdir(), "history-library-"));
  const s = createApp({
    testMode: true,
    released: "all",
    dbPath: join(d, "db.sqlite"),
    mediaPath: join(d, "media"),
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    s.close();
    rmSync(d, { recursive: true, force: true });
  });
  return s;
}
async function person(s, name) {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "fixture-password-long" })
    .expect(201);
  addCredit(s.db, r.body.user.id, 10000000, uid(), "test_credit");
  return { agent, user: r.body.user };
}
function conversation(
  s,
  user,
  title,
  {
    mode = "chat",
    expires = null,
    collab = null,
    content = "needle in a saved message",
  } = {},
) {
  const id = uid("c_");
  s.db
    .prepare(
      "INSERT INTO conversations(id,user_id,title,mode,expires,collab_id,created,updated) VALUES(?,?,?,?,?,?,?,?)",
    )
    .run(id, user, title, mode, expires, collab, now(), now());
  s.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,role,content,created,author_id) VALUES(?,?,?,?,?,?)",
    )
    .run(uid("m_"), id, "user", JSON.stringify(content), now(), user);
  return id;
}
function team(s, owner, member) {
  const id = uid("team_");
  s.db
    .prepare(
      "INSERT INTO collabs(id,owner_id,name,created,updated) VALUES(?,?,?,?,?)",
    )
    .run(id, owner, "Fixture team", now(), now());
  for (const [u, r] of [
    [owner, "owner"],
    [member, "member"],
  ])
    s.db
      .prepare(
        "INSERT INTO collab_members(collab_id,user_id,role,joined) VALUES(?,?,?,?)",
      )
      .run(id, u, r, now());
  return id;
}
async function image(s, p, extra = {}) {
  return (
    await p.agent
      .post("/api/images")
      .send({
        model: imageModel,
        prompt: "A Greek blue archive",
        n: 1,
        ...extra,
      })
      .expect(200)
  ).body.data[0];
}

test("recipe retains only supported bounded generation controls", () => {
  const r = mediaRecipe("image", {
    model: "m",
    prompt: "x",
    images: ["data:image/png;base64,YQ=="],
    private: true,
    auth: "not retained",
    veilMap: { secret: "private" },
    requestId: "old",
  });
  assert.deepEqual(Object.keys(r), ["model", "prompt", "images"]);
  assert.equal(
    mediaRecipe("image", { prompt: "x".repeat(3 * 1024 * 1024) }),
    null,
  );
});

test("history search enforces auth, membership, privacy, literal matching and bounded pages", async (t) => {
  const s = fixture(t);
  const a = await person(s, "archivist"),
    b = await person(s, "visitor");
  await request(s.app).get("/api/history/search?q=needle").expect(401);
  const ids = Array.from({ length: 4 }, (_, i) =>
    conversation(s, a.user.id, "Saved " + i),
  );
  conversation(s, b.user.id, "Someone else");
  conversation(s, a.user.id, "Private", { mode: "private" });
  conversation(s, a.user.id, "Off record", { mode: "ephemeral" });
  conversation(s, a.user.id, "Auto delete", { expires: now() + 60000 });
  conversation(s, a.user.id, "Already expired", { expires: now() - 1 });
  const collab = team(s, a.user.id, b.user.id);
  const shared = conversation(s, a.user.id, "Shared needle", { collab });
  let r = (
    await a.agent.get("/api/history/search?q=needle&limit=2").expect(200)
  ).body;
  assert.equal(r.data.length, 2);
  assert.equal(r.nextOffset, 2);
  const found = [];
  while (true) {
    found.push(...r.data.map((v) => v.id));
    if (r.nextOffset === null) break;
    r = (
      await a.agent
        .get("/api/history/search")
        .query({ q: "needle", limit: 2, offset: r.nextOffset })
        .expect(200)
    ).body;
  }
  assert.equal(new Set(found).size, 5);
  assert.ok(ids.every((id) => found.includes(id)));
  assert.ok(found.includes(shared));
  assert.equal(
    (await a.agent.get("/api/history/search?q=%25%25").expect(200)).body.data
      .length,
    0,
  );
  await a.agent.get("/api/history/search?q=n").expect(400);
  await a.agent.get("/api/history/search?q=needle&limit=51").expect(400);
  await a.agent.get("/api/history/search?q=needle&offset=-1").expect(400);
  assert.ok(
    (
      await b.agent.get("/api/history/search?q=needle").expect(200)
    ).body.data.some((v) => v.id === shared),
  );
  s.db
    .prepare("DELETE FROM collab_members WHERE collab_id=? AND user_id=?")
    .run(collab, b.user.id);
  assert.ok(
    !(
      await b.agent.get("/api/history/search?q=needle").expect(200)
    ).body.data.some((v) => v.id === shared),
  );
});

test("media source links require ownership and current membership; deletion never exposes saved source text", async (t) => {
  const s = fixture(t),
    a = await person(s, "sourceowner"),
    b = await person(s, "sourcepeer");
  const c = team(s, a.user.id, b.user.id),
    source = conversation(s, a.user.id, "Private team title", { collab: c });
  const store = createMediaStore(s.db, s.cfg);
  const asset = await store.saveMedia(
    b.user.id,
    "image",
    readFileSync("data/test-image.png"),
    {
      mime: "image/png",
      prompt: "Do not duplicate this source text",
      model: imageModel,
      sourceConversation: source,
    },
  );
  assert.equal(
    s.db.prepare("SELECT prompt FROM media WHERE id=?").get(asset.id).prompt,
    "",
  );
  let details = (
    await b.agent.get(`/api/library/${asset.id}/actions`).expect(200)
  ).body;
  assert.equal(details.source.id, source);
  assert.equal(details.rerun.available, false);
  await a.agent.get(`/api/library/${asset.id}/actions`).expect(404);
  await request(s.app).get(`/api/library/${asset.id}/actions`).expect(401);
  s.db
    .prepare("DELETE FROM collab_members WHERE collab_id=? AND user_id=?")
    .run(c, b.user.id);
  details = (await b.agent.get(`/api/library/${asset.id}/actions`).expect(200))
    .body;
  assert.equal(details.source.status, "unavailable");
  assert.equal(JSON.stringify(details).includes("Private team title"), false);
  assert.equal(
    s.db
      .prepare("SELECT source_id FROM library_items WHERE media_id=?")
      .get(asset.id).source_id,
    null,
  );
  const own = conversation(s, b.user.id, "Personal source");
  const second = await store.saveMedia(
    b.user.id,
    "image",
    readFileSync("data/test-image.png"),
    { mime: "image/png", sourceConversation: own },
  );
  s.db.prepare("DELETE FROM conversations WHERE id=?").run(own);
  assert.equal(
    (await b.agent.get(`/api/library/${second.id}/actions`).expect(200)).body
      .source.status,
    "unavailable",
  );
  await b.agent.delete(`/api/media/${second.id}`).expect(200);
  assert.equal(
    s.db.prepare("SELECT * FROM library_items WHERE media_id=?").get(second.id),
    undefined,
  );
});

test("image rerun restores references, quotes without spending, rejects stale/tampered/repeated/cross-account actions", async (t) => {
  const s = fixture(t),
    a = await person(s, "imageowner"),
    b = await person(s, "imageother");
  const ref =
    "data:image/png;base64," +
    readFileSync("data/test-image.png").toString("base64");
  const asset = await image(s, a, { images: [ref] });
  const before = balance(s.db, a.user.id),
    holds = s.db.prepare("SELECT COUNT(*) n FROM holds").get().n;
  const detail = (
    await a.agent.get(`/api/library/${asset.id}/actions`).expect(200)
  ).body;
  assert.deepEqual(detail.rerun.params.images, [ref]);
  assert.equal(detail.source.status, "not-recorded");
  const q = (
    await a.agent.post(`/api/library/${asset.id}/quote`).send({}).expect(200)
  ).body;
  assert.deepEqual(balance(s.db, a.user.id), before);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, holds);
  await b.agent.post("/api/images").send(q.body).expect(409);
  await a.agent
    .post("/api/images")
    .send({ ...q.body, prompt: "Changed after quote" })
    .expect(409);
  await a.agent
    .post("/api/images")
    .send({ ...q.body, libraryQuote: { ...q.quote, expires: now() - 1 } })
    .expect(409);
  const rerun = (await a.agent.post("/api/images").send(q.body).expect(200))
    .body;
  assert.notEqual(rerun.data[0].id, asset.id);
  assert.deepEqual(
    JSON.parse(
      s.db
        .prepare("SELECT recipe FROM library_items WHERE media_id=?")
        .get(rerun.data[0].id).recipe,
    ).images,
    [ref],
  );
  await a.agent.post("/api/images").send(q.body).expect(409);
  assert.equal(balance(s.db, a.user.id).held, 0);
  assert.ok(s.db.prepare("SELECT id FROM media WHERE id=?").get(asset.id));
  const stale = (
    await a.agent.post(`/api/library/${asset.id}/quote`).send({}).expect(200)
  ).body;
  s.cfg.markup = 99;
  await a.agent.post("/api/images").send(stale.body).expect(409);
  await a.agent.delete(`/api/media/${asset.id}`).expect(200);
  await a.agent.post(`/api/library/${asset.id}/quote`).send({}).expect(404);
});

test("incompatible or absent saved settings stay unavailable, with no silent model fallback", async (t) => {
  const s = fixture(t),
    a = await person(s, "oldlibrary");
  const asset = await image(s, a);
  const set = (recipe) =>
    s.db
      .prepare("UPDATE library_items SET recipe=? WHERE media_id=?")
      .run(JSON.stringify(recipe), asset.id);
  set({ model: "model-removed", prompt: "x", n: 1 });
  assert.equal(
    (await a.agent.get(`/api/library/${asset.id}/actions`).expect(200)).body
      .rerun.available,
    false,
  );
  await a.agent.post(`/api/library/${asset.id}/quote`).send({}).expect(409);
  set({ model: imageModel, prompt: "x", images: ["not-a-valid-reference"] });
  assert.equal(
    (await a.agent.get(`/api/library/${asset.id}/actions`).expect(200)).body
      .rerun.available,
    false,
  );
  s.db.prepare("DELETE FROM library_items WHERE media_id=?").run(asset.id);
  assert.match(
    (await a.agent.get(`/api/library/${asset.id}/actions`).expect(200)).body
      .rerun.message,
    /not retained/,
  );
});

test("audio restores complete script and voice, never the truncated card prompt", async (t) => {
  const s = fixture(t),
    a = await person(s, "voicearchive"),
    text = "A complete narration. ".repeat(40);
  const original = (
    await a.agent
      .post("/api/audio/speech")
      .send({
        model: "fixture-voice",
        voice: "fixture-1",
        text,
        language: "en",
      })
      .expect(200)
  ).body.data;
  const q = (
    await a.agent.post(`/api/library/${original.id}/quote`).send({}).expect(200)
  ).body;
  assert.equal(q.params.text, text.trim());
  assert.equal(q.params.voice, "fixture-1");
  assert.equal(q.params.language, "en");
  await a.agent.post("/api/audio/speech").send(q.body).expect(200);
  assert.equal(balance(s.db, a.user.id).held, 0);
});

test("private/ephemeral and auto-deleting chat media never becomes a permanent searchable library recipe", async (t) => {
  const s = fixture(t),
    a = await person(s, "transient");
  const req = {
    model: imageModel,
    messages: [{ role: "user", content: "A transient blue image" }],
    max_tokens: 50,
  };
  await a.agent
    .post("/api/chat")
    .send({ ...req, ephemeral: true })
    .expect(200);
  const m = s.db.prepare("SELECT * FROM media WHERE user_id=?").get(a.user.id);
  assert.ok(m.expires > now());
  assert.equal(m.prompt, "");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM library_items").get().n, 0);
  assert.equal(
    (await a.agent.get("/api/media").expect(200)).body.data.length,
    0,
  );
  await a.agent.get(`/api/library/${m.id}/actions`).expect(404);
  const c = conversation(s, a.user.id, "Auto delete", {
    expires: now() + 60000,
  });
  await a.agent
    .post("/api/chat")
    .send({ ...req, conversationId: c })
    .expect(200);
  assert.equal(
    (await a.agent.get("/api/media").expect(200)).body.data.length,
    0,
  );
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM library_items").get().n, 0);
});

test("history/library gate blocks search, quotes and marked reruns before auth", async (t) => {
  const gate = UPDATES.find((u) => u.id === "historylibrary");
  const released = gate.released; gate.released = false;
  t.after(() => { gate.released = released; });
  const s = fixture(t, { released: new Set() });
  await request(s.app).get("/api/history/search?q=hello").expect(403);
  await request(s.app).get("/api/library/item/actions").expect(403);
  await request(s.app)
    .post("/api/images")
    .send({ libraryMediaId: "item" })
    .expect(403);
});

test("video rerun restores priced ratio/duration, submits once and settles with original media preserved", async (t) => {
  const s = fixture(t),
    a = await person(s, "videoarchive");
  await a.agent
    .post("/api/videos")
    .send({
      model: "kling-2.5-turbo",
      prompt: "A blue Greek archive",
      ratio: "16:9",
      duration: "5",
      requestId: "original-video",
    })
    .expect(202);
  await s.tick();
  const original = (await a.agent.get("/api/media").expect(200)).body.data[0];
  assert.equal(original.kind, "video");
  const q = (
    await a.agent.post(`/api/library/${original.id}/quote`).send({}).expect(200)
  ).body;
  assert.equal(q.params.ratio, "16:9");
  assert.equal(q.params.duration, "5");
  const before = s.db.prepare("SELECT COUNT(*) n FROM videos").get().n;
  await a.agent.post("/api/videos").send(q.body).expect(202);
  await a.agent.post("/api/videos").send(q.body).expect(409);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM videos").get().n,
    before + 1,
  );
  await s.tick();
  assert.equal(balance(s.db, a.user.id).held, 0);
  assert.equal(
    (await a.agent.get("/api/media").expect(200)).body.data.length,
    2,
  );
  const bad = { ...q.params, ratio: "nonsense" };
  s.db
    .prepare("UPDATE library_items SET recipe=? WHERE media_id=?")
    .run(JSON.stringify(bad), original.id);
  assert.equal(
    (await a.agent.get(`/api/library/${original.id}/actions`).expect(200)).body
      .rerun.available,
    false,
  );
});

test("rerunning the oldest image protects its original when the library is at its retention cap", async (t) => {
  const s = fixture(t),
    a = await person(s, "retentionarchive"),
    original = await image(s, a);
  s.db.prepare("UPDATE media SET created=1 WHERE id=?").run(original.id);
  const store = createMediaStore(s.db, s.cfg),
    bytes = readFileSync("data/test-image.png");
  for (let i = 0; i < 99; i++)
    await store.saveMedia(a.user.id, "image", bytes, {
      mime: "image/png",
      prompt: "Other saved item",
    });
  const q = (
    await a.agent.post(`/api/library/${original.id}/quote`).send({}).expect(200)
  ).body;
  const result = (await a.agent.post("/api/images").send(q.body).expect(200))
    .body;
  assert.ok(s.db.prepare("SELECT id FROM media WHERE id=?").get(original.id));
  assert.ok(
    s.db.prepare("SELECT id FROM media WHERE id=?").get(result.data[0].id),
  );
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM media WHERE user_id=?").get(a.user.id)
      .n,
    100,
  );
});


test("source lifecycle is rechecked after an asynchronous media download before persistence", async (t) => {
  const s = fixture(t, { mediaHosts: ["fixture.invalid"] }),
    a = await person(s, "downloadowner"),
    b = await person(s, "downloadpeer"),
    store = createMediaStore(s.db, s.cfg),
    bytes = readFileSync("data/test-image.png"),
    originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  async function download(source, mutate, expires = null) {
    globalThis.fetch = async () => {
      mutate();
      return new Response(bytes, { headers: { "content-type": "image/png" } });
    };
    return store.saveMedia(b.user.id, "image", "https://fixture.invalid/image.png", {
      sourceConversation: source, prompt: "Never retain a duplicate source prompt", expires,
    });
  }
  const deleted = conversation(s, b.user.id, "Deleted while downloading");
  await assert.rejects(download(deleted, () => {
    s.db.prepare("DELETE FROM conversations WHERE id=?").run(deleted);
  }));
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM media").get().n, 0);
  assert.equal(readdirSync(s.cfg.mediaPath).filter((f) => f !== ".secret").length, 0);

  const collab = team(s, a.user.id, b.user.id),
    shared = conversation(s, a.user.id, "Access revoked while downloading", { collab });
  await assert.rejects(download(shared, () => {
    s.db.prepare("DELETE FROM collab_members WHERE collab_id=? AND user_id=?").run(collab, b.user.id);
  }));
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM media").get().n, 0);

  const changing = conversation(s, b.user.id, "Retention changes during download"),
    deadline = now() + 60000;
  const temporary = await download(changing, () => {
    s.db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(deadline, changing);
  });
  assert.equal(temporary.expires, deadline);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM library_items").get().n, 0);
  assert.equal((await b.agent.get("/api/media").expect(200)).body.data.length, 0);
  // A later extension must not extend an already selected media retention deadline.
  const earlier = deadline - 1000;
  const limited = await download(changing, () => {
    s.db.prepare("UPDATE conversations SET expires=NULL WHERE id=?").run(changing);
  }, earlier);
  assert.equal(limited.expires, earlier);
});
