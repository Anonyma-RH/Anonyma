import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  mkdirSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { createMediaStore } from "../server/media.js";
import { now, reserve, release } from "../server/core.js";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-data-controls-"));
  const s = createApp({
    testMode: true,
    released: "all",
    origin: "http://localhost:5175",
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
  });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
async function account(s, username) {
  const a = request.agent(s.app);
  const r = await a
    .post("/api/auth/register")
    .send({ username, password: "long-fixture-password" })
    .expect(201);
  return { a, id: r.body.user.id };
}
const fileFor = (s, id) =>
  join(
    s.cfg.mediaPath,
    s.db.prepare("SELECT filename FROM media WHERE id=?").get(id).filename,
  );
const png = readFileSync(new URL("../data/test-image.png", import.meta.url));

test("account export is complete, credential-free and respects current shared membership", async (t) => {
  const s = fixture(t),
    alice = await account(s, "alice"),
    bob = await account(s, "bob");
  const key = (
    await alice.a
      .post("/api/keys")
      .send({ name: "export key", cap: 50 })
      .expect(201)
  ).body;
  await alice.a
    .post("/api/support")
    .send({
      subject: "Own ticket",
      body: "My details",
      email: "alice@example.invalid",
    })
    .expect(201);
  await bob.a
    .post("/api/support")
    .send({
      subject: "Other ticket",
      body: "PRIVATE OTHER TICKET",
      email: "bob@example.invalid",
    })
    .expect(201);
  for (let i = 0; i < 60; i++)
    s.db
      .prepare(
        "INSERT INTO deposits(id,user_id,amount,currency,status,payload,created,updated) VALUES(?,?,10000000,'usdg','finished','{}',?,?)",
      )
      .run("deposit-" + i, alice.id, i, i);
  s.db
    .prepare(
      "INSERT INTO collabs(id,owner_id,name,created,updated) VALUES('shared',?,'Shared',1,1)",
    )
    .run(bob.id);
  for (const id of [alice.id, bob.id])
    s.db
      .prepare(
        "INSERT INTO collab_members(collab_id,user_id,role,joined) VALUES('shared',?,'member',1)",
      )
      .run(id);
  s.db
    .prepare(
      "INSERT INTO conversations(id,user_id,title,mode,created,updated,collab_id) VALUES('thread',?,'Shared thread','chat',1,1,'shared')",
    )
    .run(alice.id);
  for (const [id, author, body] of [
    ["own", alice.id, "MY SHARED TEXT"],
    ["other", bob.id, "PRIVATE OTHER TEXT"],
  ])
    s.db
      .prepare(
        "INSERT INTO messages(id,conversation_id,role,content,cost,created,author_id) VALUES(?,'thread','user',?,123,1,?)",
      )
      .run(id, JSON.stringify({ text: body }), author);
  let out = (await alice.a.get("/api/account/export").expect(200)).body;
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.deposits.length, 60);
  assert.equal(out.deposits[0].amount, 1);
  assert.equal(out.keys[0].cap, 50);
  assert.equal(out.supportRequests.length, 1);
  assert.equal(out.sessions.length, 1);
  assert.equal(
    out.conversations[0].messages.find((m) => m.id === "other").cost,
    null,
  );
  const serialized = JSON.stringify(out);
  for (const secret of [
    key.key,
    s.db.prepare("SELECT hash FROM api_keys WHERE id=?").get(key.id).hash,
    s.db.prepare("SELECT password FROM users WHERE id=?").get(alice.id)
      .password,
    s.db.prepare("SELECT hash FROM sessions WHERE user_id=?").get(alice.id)
      .hash,
    "PRIVATE OTHER TICKET",
  ])
    assert.ok(!serialized.includes(secret));
  s.db
    .prepare(
      "DELETE FROM collab_members WHERE user_id=? AND collab_id='shared'",
    )
    .run(alice.id);
  for (const path of ["/api/account/export", "/api/conversations/export"]) {
    out = (await alice.a.get(path).expect(200)).body;
    assert.equal(out.conversations.length, 0);
    assert.ok(!JSON.stringify(out).includes("PRIVATE OTHER TEXT"));
    if (path.includes("account"))
      assert.equal(out.ownSharedMessages[0].content.text, "MY SHARED TEXT");
  }
});

test("retention prunes only personal conversations and oldest saved files, then cleans expired data", async (t) => {
  const s = fixture(t),
    u = await account(s, "retention");
  const insert = s.db.prepare(
    "INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,'Old','chat',1,1)",
  );
  for (let i = 0; i < 300; i++) insert.run("old-" + i, u.id);
  s.db
    .prepare(
      "INSERT INTO messages(id,conversation_id,role,content,created) VALUES('old-message','old-0','user','\"old\"',1)",
    )
    .run();
  const newest = (
    await u.a.post("/api/conversations").send({ title: "Newest" }).expect(201)
  ).body.id;
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?")
      .get(u.id).n,
    300,
  );
  assert.ok(
    s.db.prepare("SELECT id FROM conversations WHERE id=?").get(newest),
  );
  assert.equal(
    s.db.prepare("SELECT id FROM messages WHERE id='old-message'").get(),
    undefined,
  );
  const store = createMediaStore(s.db, s.cfg);
  for (const [kind, cap, mime, bytes] of [
    ["image", 100, "image/png", png],
    ["video", 60, "video/mp4", Buffer.from("fixture")],
    ["audio", 60, "audio/mpeg", Buffer.from("fixture")],
  ]) {
    let first;
    for (let i = 0; i <= cap; i++) {
      const m = await store.saveMedia(u.id, kind, bytes, { mime });
      if (i === 0) first = fileFor(s, m.id);
    }
    assert.equal(
      s.db
        .prepare("SELECT COUNT(*) n FROM media WHERE user_id=? AND kind=?")
        .get(u.id, kind).n,
      cap,
    );
    assert.equal(existsSync(first), false);
  }
  const expired = await store.saveMedia(u.id, "image", png, {
    mime: "image/png",
    expires: now() - 1000,
  });
  const expiredFile = fileFor(s, expired.id);
  await u.a.get("/api/media/" + expired.id).expect(404);
  s.db
    .prepare(
      "INSERT INTO sessions(hash,user_id,created,expires) VALUES('expired',?,0,1)",
    )
    .run(u.id);
  s.db
    .prepare(
      "INSERT INTO challenges(id,target,purpose,hash,expires) VALUES('expired','fixture','login','hash',1)",
    )
    .run();
  s.db
    .prepare(
      "INSERT INTO rate_events(kind,target,created) VALUES('fixture','old',1)",
    )
    .run();
  await s.tick();
  assert.equal(existsSync(expiredFile), false);
  for (const [table, where] of [
    ["sessions", "hash='expired'"],
    ["challenges", "id='expired'"],
    ["rate_events", "target='old'"],
  ])
    assert.equal(
      s.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get().n,
      0,
    );
});

test("closure deletes active content and credentials while retaining accounting and other accounts", async (t) => {
  const s = fixture(t),
    u = await account(s, "closing"),
    other = await account(s, "staying");
  const key = (
    await u.a.post("/api/keys").send({ name: "Private key name" }).expect(201)
  ).body;
  const conversation = (
    await u.a
      .post("/api/conversations")
      .send({ title: "Private title" })
      .expect(201)
  ).body.id;
  await u.a
    .post("/api/support")
    .send({
      subject: "Delete me",
      body: "Private request",
      email: "closing@example.invalid",
    })
    .expect(201);
  const store = createMediaStore(s.db, s.cfg),
    media = await store.saveMedia(u.id, "image", png, { mime: "image/png" }),
    file = fileFor(s, media.id);
  s.db
    .prepare(
      "INSERT INTO deposits(id,user_id,amount,currency,status,payload,created,updated) VALUES('kept',?,10000000,'usdg','finished','{}',1,1)",
    )
    .run(u.id);
  reserve(s.db, { id: "pending", user: u.id, amount: 1, ttl: 60000 });
  await u.a.delete("/api/account").send({ confirm: "DELETE" }).expect(409);
  release(s.db, "pending");
  await u.a.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(existsSync(file), false);
  assert.equal(
    s.db.prepare("SELECT id FROM conversations WHERE id=?").get(conversation),
    undefined,
  );
  for (const table of ["sessions", "media", "tickets", "videos"])
    assert.equal(
      s.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(u.id)
        .n,
      0,
    );
  const user = s.db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  for (const field of ["username", "email", "wallet", "password"])
    assert.equal(user[field], null);
  assert.ok(user.deleted);
  const row = s.db.prepare("SELECT * FROM api_keys WHERE id=?").get(key.id);
  assert.ok(row.revoked);
  assert.equal(row.hash, null);
  assert.equal(row.prefix, null);
  assert.equal(row.name, "Deleted account");
  assert.ok(s.db.prepare("SELECT id FROM deposits WHERE id='kept'").get());
  assert.ok(
    s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=?").get(u.id).n >
      0,
  );
  await u.a.get("/api/account/export").expect(401);
  await request(s.app)
    .get("/v1/balance")
    .set("Authorization", `Bearer ${key.key}`)
    .expect(401);
  assert.equal(
    (await other.a.get("/api/account/export").expect(200)).body.user.username,
    "staying",
  );
});

test("file deletion failures preserve a retryable record instead of reporting account closure", async (t) => {
  const s = fixture(t),
    u = await account(s, "retry-delete");
  const store = createMediaStore(s.db, s.cfg),
    media = await store.saveMedia(u.id, "image", png, { mime: "image/png" });
  const file = fileFor(s, media.id);
  rmSync(file);
  mkdirSync(file);
  const failed = await u.a
    .delete("/api/account")
    .send({ confirm: "DELETE" })
    .expect(503);
  assert.equal(failed.body.error.code, "media_delete_failed");
  assert.equal(
    s.db.prepare("SELECT deleted FROM users WHERE id=?").get(u.id).deleted,
    null,
  );
  assert.ok(s.db.prepare("SELECT id FROM media WHERE id=?").get(media.id));
  rmSync(file, { recursive: true });
  await u.a.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
});
