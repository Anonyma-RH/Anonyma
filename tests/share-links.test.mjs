import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.js";
import { MIGRATIONS, migrate, rollbackSchema, uid } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import {
  SHARE_TOKEN,
  MAX_ACTIVE_SHARES,
  MAX_SHARES_PER_CONVERSATION,
  shareBlocked,
  shareExpiry,
  parseShareDays,
  shareTitle,
  snapshotMessage,
  attachmentNames,
  snapshotSummary,
} from "../src/share-links.js";

// Release commits flip `released` on UPDATES entries; these tests cover the
// gate itself, so every update is pinned unreleased for this file.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const DAY = 86400000;

function fixture(t, released = "all", extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-shares-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    publicUrl: "https://share.example.test",
    ...(released === "all" ? {} : { mvpModels: [MODEL] }),
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(s, username) {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `192.0.2.${++visitor % 250}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
// Sends one chat turn (the test provider answers) and returns its
// conversation id.
async function say(agent, content, conversationId, extra = {}) {
  const r = await agent
    .post("/api/chat")
    .send({
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens: 50,
      ...(conversationId ? { conversationId } : {}),
      ...extra,
    })
    .expect(200);
  const last = r.text
    .split("\n\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
    .find((e) => e.anonyma);
  return last?.conversationId ?? null;
}
const share = (agent, conversationId, extra = {}) =>
  agent.post("/api/shares").send({ conversationId, ...extra });
const tokenOf = (link) => link.path.split("/").pop();
const view = (s, token, ip = "198.51.100.7") =>
  request(s.app).get("/api/s/" + token).set("X-Forwarded-For", ip);
const page = (s, token, ip = "198.51.100.7") =>
  request(s.app).get("/s/" + token).set("X-Forwarded-For", ip);

test("gated until Share a Chat is released: every route refused, contract and config closed", async (t) => {
  const entry = UPDATES.find((u) => u.id === "sharelinks");
  assert.ok(entry, "registered in UPDATES");
  assert.equal(entry.title, "Share a Chat");
  assert.equal(entry.points.length, 3);
  assert.ok(
    UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "voice"),
    "added after the releases before it",
  );
  assert.equal(committed[UPDATES.indexOf(entry)], true, "released by its release commit");
  const s = fixture(t, "mvp");
  const { agent } = await person(s, "gate");
  const conversation = await say(agent, "Hello there");
  // Built one at a time: supertest starts a server per request.
  for (const res of [
    () => agent.get("/api/shares"),
    () => share(agent, conversation),
    () => agent.delete("/api/shares/share_x"),
    () => view(s, "a".repeat(32)),
    () => page(s, "a".repeat(32)),
    () => request(s.app).get("/S/" + "a".repeat(32)),
  ]) {
    const r = await res().expect(403);
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.equal(r.body.error.message, "Share a Chat is coming soon.");
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_links").get().n, 0);
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.sharelinks, false);
  const spec = (await request(s.app).get("/api/openapi.json").expect(200)).body;
  for (const p of ["/api/shares", "/api/shares/{id}", "/api/s/{token}", "/s/{token}"])
    assert.equal(spec.paths[p], undefined, p);
  // Until then the export doesn't mention it either.
  const exported = (await agent.get("/api/account/export").expect(200)).body;
  assert.equal("shareLinks" in exported, false);
  // Released by id, the routes open and the contract lists them.
  const live = fixture(t, "mvp,sharelinks");
  const listed = (await request(live.app).get("/api/openapi.json").expect(200)).body;
  for (const p of ["/api/shares", "/api/shares/{id}", "/api/s/{token}", "/s/{token}"])
    assert.ok(listed.paths[p], p);
  const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")).strings;
  for (const line of [entry.title, entry.tagline, ...entry.points])
    assert.ok(zh[line], `zh: ${line}`);
});

test("a snapshot link: read-only, public, no account details, and later messages never join it", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s, "sharer_ana");
  const conversation = await say(agent, "Plan a three-day trip to Lisbon");
  const r = await share(agent, conversation).expect(201);
  const link = r.body;
  assert.match(tokenOf(link), SHARE_TOKEN);
  assert.equal(link.url, "https://share.example.test/s/" + tokenOf(link));
  assert.equal(link.messages, 2);
  assert.equal(link.title, "Plan a three-day trip to Lisbon");
  assert.equal(link.conversation_id, conversation);
  // Seven days by default.
  assert.ok(Math.abs(link.expires - (link.created + 7 * DAY)) < 5);
  assert.equal(link.ends_with_conversation, false);
  // Anyone with the link, signed in or not, with the privacy headers.
  const v = await view(s, tokenOf(link)).expect(200);
  assert.equal(v.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(v.headers["referrer-policy"], "no-referrer");
  assert.equal(v.headers["cache-control"], "no-store");
  assert.deepEqual(Object.keys(v.body).sort(), ["created", "messages", "title"]);
  assert.equal(v.body.created, link.created);
  assert.deepEqual(
    v.body.messages.map((m) => m.role),
    ["user", "assistant"],
  );
  assert.equal(v.body.messages[0].text, "Plan a three-day trip to Lisbon");
  assert.equal(v.body.messages[0].model, undefined, "only replies name a model");
  assert.match(v.body.messages[1].text, /Local test provider/);
  const catalogName = (await request(s.app).get("/api/models").expect(200)).body.data.find(
    (m) => m.id === MODEL,
  ).name;
  assert.ok(catalogName);
  assert.equal(v.body.messages[1].model, catalogName, "a reply names the model that wrote it");
  for (const m of v.body.messages)
    for (const key of Object.keys(m))
      assert.ok(["role", "text", "model", "withheld", "interrupted", "citations"].includes(key), key);
  // Nothing identifies the account, the conversation or what it paid.
  const stored = JSON.parse(
    s.db.prepare("SELECT content FROM messages WHERE role='assistant'").get().content,
  );
  const cost = s.db.prepare("SELECT cost FROM messages WHERE role='assistant'").get().cost;
  assert.ok(stored.request_id && cost > 0);
  const body = JSON.stringify(v.body);
  for (const secret of [user.id, "sharer_ana", conversation, link.id, stored.request_id, `"cost"`, `"usage"`, `"request_id"`, `"credits`, String(cost)])
    assert.ok(!body.includes(secret), `leaks ${secret}`);
  // The page itself: same headers, served without a session.
  const p = await page(s, tokenOf(link)).expect(200);
  assert.equal(p.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(p.headers["referrer-policy"], "no-referrer");
  // A snapshot, not a window.
  await say(agent, "Add a day in Sintra", conversation);
  const again = await view(s, tokenOf(link)).expect(200);
  assert.deepEqual(again.body, v.body);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?").get(conversation).n,
    4,
  );
  // A custom title, trimmed to one line.
  const titled = await share(agent, conversation, { title: "  Lisbon\n\nitinerary  " }).expect(201);
  assert.equal(titled.body.title, "Lisbon itinerary");
  assert.equal(titled.body.messages, 4);
  // Never indexed anywhere public.
  const map = await request(s.app).get("/sitemap.xml").expect(200);
  assert.doesNotMatch(map.text, /\/s\//);
  // Signed out: no management.
  await request(s.app).get("/api/shares").expect(401);
  await request(s.app).post("/api/shares").send({ conversationId: conversation }).expect(401);
  await request(s.app).delete("/api/shares/" + link.id).expect(401);
});

test("masked details stay masked, and attachments, images and files become placeholders", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "veiled");
  // What Veil sends: the browser already swapped the values for tags.
  const masked = "Email me at [EMAIL_1] or call [PHONE_1].";
  const veiled = await say(agent, masked);
  const r = await share(agent, veiled).expect(201);
  assert.ok(r.body.masked >= 2);
  const v = await view(s, tokenOf(r.body)).expect(200);
  assert.equal(v.body.messages[0].text, masked);
  const stored = s.db
    .prepare("SELECT content FROM messages WHERE conversation_id=? AND role='user'")
    .get(veiled).content;
  assert.equal(JSON.parse(stored), masked, "exactly what the server stored");

  // A document attached to the prompt, and a reference image.
  const doc =
    'Summarize this\n\n<document name="salary-2026.pdf" pages="2">Salary: 123456 SECRET</document>';
  const withDoc = await say(agent, doc);
  const image = await say(agent, [
    { type: "text", text: "What is in this picture?" },
    {
      type: "image_url",
      image_url: {
        url: "data:image/png;base64," + readFileSync("data/test-image.png").toString("base64"),
      },
    },
  ]);
  const d = await share(agent, withDoc).expect(201);
  assert.equal(d.body.withheld, 1);
  const dv = await view(s, tokenOf(d.body)).expect(200);
  assert.equal(dv.body.messages[0].text, "Summarize this");
  assert.equal(dv.body.messages[0].withheld, 1);
  const docBody = JSON.stringify(dv.body.messages[0]);
  assert.doesNotMatch(docBody, /salary-2026|123456|SECRET|<document/);
  const i = await share(agent, image).expect(201);
  const iv = await view(s, tokenOf(i.body)).expect(200);
  assert.equal(iv.body.messages[0].text, "What is in this picture?");
  assert.equal(iv.body.messages[0].withheld, 1);
  assert.doesNotMatch(JSON.stringify(iv.body), /data:image|base64/);

  // A chat that began with only a document is titled after the file; that
  // name is never published, not even as the title.
  const onlyDoc = await say(agent, '<document name="tax-return.pdf">Refund 999</document>');
  assert.equal(
    s.db.prepare("SELECT title FROM conversations WHERE id=?").get(onlyDoc).title,
    "tax-return.pdf",
  );
  const od = await share(agent, onlyDoc, { title: "tax-return.pdf" }).expect(201);
  assert.equal(od.body.title, "Shared conversation");
  const odv = await view(s, tokenOf(od.body)).expect(200);
  assert.equal(odv.body.title, "Shared conversation");
  assert.deepEqual(odv.body.messages[0], { role: "user", text: "", withheld: 1 });

  // Replies: generated images are left out, reasoning isn't published,
  // interrupted replies say so, and only web citations are kept.
  const reply = await say(agent, "Draw me a map");
  s.db.prepare(
    "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    uid("m_"),
    reply,
    "assistant",
    JSON.stringify({
      text: "Here is the map.",
      reasoning: "PRIVATE CHAIN OF THOUGHT",
      images: [{ type: "image_url", image_url: { url: "/api/media/x/file?sig=1" } }],
      interrupted: true,
      request_id: "req-should-not-leak",
      usage: { prompt_tokens: 9 },
      citations: [
        { url: "https://example.org/lisbon", title: "Lisbon guide" },
        { url: "javascript:alert(1)", title: "bad" },
        { url: "data:text/html,hi" },
      ],
    }),
    MODEL,
    777777,
    Date.now() + 1000,
    null,
  );
  const m = await share(agent, reply).expect(201);
  const mv = await view(s, tokenOf(m.body)).expect(200);
  const last = mv.body.messages.at(-1);
  assert.equal(last.text, "Here is the map.");
  assert.equal(last.withheld, 1);
  assert.equal(last.interrupted, true);
  assert.deepEqual(last.citations, [{ url: "https://example.org/lisbon", title: "Lisbon guide" }]);
  assert.doesNotMatch(
    JSON.stringify(mv.body),
    /PRIVATE CHAIN|req-should-not-leak|777777|\/api\/media|javascript:|prompt_tokens/,
  );
});

test("off the record, Private Mode, collab, Symposium, empty and others' chats are refused", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "owner_bo");
  const { agent: other } = await person(s, "other_cy");
  const mine = await say(agent, "Just between us");
  // Off the record and Private: never saved, so nothing to share, whatever
  // the request claims.
  for (const flag of [{ ephemeral: true }, { private: true }]) {
    const r = await share(agent, mine, flag).expect(400);
    assert.equal(r.body.error.code, "share_excluded");
  }
  // An off-the-record chat has no conversation at all.
  assert.equal(await say(agent, "Off the record", null, { ephemeral: true }), null);
  // Someone else's conversation, a made-up one: not found.
  assert.equal((await share(other, mine).expect(404)).body.error.message, "Conversation not found.");
  await share(agent, "c_nope").expect(404);
  // A collab conversation holds other members' messages.
  const collab = (await agent.post("/api/collabs").send({ name: "Team" }).expect(201)).body.id;
  const team = (await agent.post(`/api/collabs/${collab}/conversations`).send({ title: "Team chat" }).expect(201)).body.id;
  await say(agent, "Team update", team);
  const c = await share(agent, team).expect(400);
  assert.equal(c.body.error.code, "share_collab");
  // The database refuses one however it's written.
  assert.throws(
    () =>
      s.db.prepare(
        "INSERT INTO share_links(id,user_id,conversation_id,token,title,snapshot,message_count,created) VALUES('x',(SELECT user_id FROM conversations WHERE id=?),?,'t','t','[]',0,0)",
      ).run(team, team),
    /share_personal_only/,
  );
  // Symposium runs, and an empty conversation.
  const symposium = (await agent.post("/api/conversations").send({ mode: "symposium" }).expect(201)).body.id;
  assert.equal((await share(agent, symposium).expect(400)).body.error.code, "share_mode");
  const empty = (await agent.post("/api/conversations").send({ title: "Empty" }).expect(201)).body.id;
  assert.equal((await share(agent, empty).expect(400)).body.error.code, "share_empty");
  // Bad requests.
  for (const body of [
    { conversationId: 42 },
    {},
    { conversationId: mine, expires_in_days: 2 },
    { conversationId: mine, expires_in_days: "7" },
    { conversationId: mine, title: 5 },
  ])
    await agent.post("/api/shares").send(body).expect(400);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_links").get().n, 0);
});

test("expiry choices, auto-delete bounds, and one identical 404 for unknown, malformed, revoked and expired links", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "timer");
  const { agent: other } = await person(s, "stranger");
  const conversation = await say(agent, "Timing test");
  const made = {};
  for (const days of [1, 7, 30, null]) {
    const r = await share(agent, conversation, { expires_in_days: days }).expect(201);
    made[String(days)] = r.body;
    if (days == null) assert.equal(r.body.expires, null);
    else assert.ok(Math.abs(r.body.expires - (r.body.created + days * DAY)) < 5);
  }
  // Five live links at most per conversation.
  await share(agent, conversation).expect(201);
  const sixth = await share(agent, conversation).expect(400);
  assert.equal(sixth.body.error.code, "share_limit");
  assert.match(sixth.body.error.message, new RegExp(`up to ${MAX_SHARES_PER_CONVERSATION}`));
  // Revoke: only its owner; then gone at once.
  const doomed = made["30"];
  await other.delete("/api/shares/" + doomed.id).expect(404);
  await view(s, tokenOf(doomed)).expect(200);
  await agent.delete("/api/shares/" + doomed.id).expect(200);
  await agent.delete("/api/shares/" + doomed.id).expect(404);
  // Expired: force the 1-day link past its deadline.
  s.db.prepare("UPDATE share_links SET expires=? WHERE id=?").run(Date.now() - 1, made["1"].id);
  const unknown = await view(s, "b".repeat(32)).expect(404);
  const statuses = [];
  for (const token of [tokenOf(doomed), tokenOf(made["1"]), "short", "a.b", "c".repeat(33)]) {
    const r = await view(s, token);
    statuses.push(r.status);
    if (r.status === 404) assert.deepEqual(r.body, unknown.body);
    const p = await page(s, token);
    if (p.status === 404) {
      assert.equal(p.headers["x-robots-tag"], "noindex, nofollow");
      assert.equal(p.headers["referrer-policy"], "no-referrer");
    }
  }
  assert.deepEqual(statuses, [404, 404, 404, 404, 404]);
  assert.equal(unknown.body.error.code, "share_not_found");
  await page(s, "b".repeat(32)).expect(404);
  // The list shows only live links.
  const list = (await agent.get("/api/shares").expect(200)).body;
  const ids = list.data.map((l) => l.id);
  assert.equal(ids.length, 3);
  assert.ok(ids.includes(made["7"].id) && ids.includes(made["null"].id));
  assert.ok(!ids.includes(doomed.id) && !ids.includes(made["1"].id));
  assert.deepEqual(list.limits, { active: MAX_ACTIVE_SHARES, per_conversation: MAX_SHARES_PER_CONVERSATION });
  assert.equal((await other.get("/api/shares").expect(200)).body.data.length, 0);
  // Maintenance reclaims the expired snapshot.
  await s.tick();
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_links WHERE id=?").get(made["1"].id).n, 0);

  // Auto-delete: a new link never outlives its conversation...
  const brief = await say(agent, "Short-lived chat");
  await agent.patch("/api/conversations/" + brief).send({ retention: 1 }).expect(200);
  const convExpires = s.db.prepare("SELECT expires FROM conversations WHERE id=?").get(brief).expires;
  const bounded = (await share(agent, brief, { expires_in_days: 30 }).expect(201)).body;
  assert.equal(bounded.expires, convExpires);
  assert.equal(bounded.ends_with_conversation, true);
  const never = (await share(agent, brief, { expires_in_days: null }).expect(201)).body;
  assert.equal(never.expires, convExpires);
  // ...clearing its auto-delete never extends a link...
  await agent.patch("/api/conversations/" + brief).send({ retention: null }).expect(200);
  assert.equal(
    s.db.prepare("SELECT expires FROM share_links WHERE id=?").get(never.id).expires,
    convExpires,
  );
  // ...and a shorter auto-delete shortens every link to it.
  const later = await say(agent, "Kept a while");
  const open = (await share(agent, later, { expires_in_days: null }).expect(201)).body;
  const month = (await share(agent, later, { expires_in_days: 30 }).expect(201)).body;
  await agent.patch("/api/conversations/" + later).send({ retention: 7 }).expect(200);
  const week = s.db.prepare("SELECT expires FROM conversations WHERE id=?").get(later).expires;
  for (const l of [open, month])
    assert.equal(s.db.prepare("SELECT expires FROM share_links WHERE id=?").get(l.id).expires, week);
  const listed = (await agent.get("/api/shares?conversation=" + later).expect(200)).body.data;
  assert.equal(listed.length, 2);
  assert.ok(listed.every((l) => l.ends_with_conversation && l.expires === week));
  // The database keeps the bound on any later write as well.
  s.db.prepare("UPDATE share_links SET expires=NULL WHERE id=?").run(open.id);
  assert.equal(s.db.prepare("SELECT expires FROM share_links WHERE id=?").get(open.id).expires, week);
  // A conversation past its auto-delete is gone at once, before cleanup.
  s.db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(Date.now() - 1, later);
  await view(s, tokenOf(open)).expect(404);
  await s.tick();
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_links WHERE conversation_id=?").get(later).n, 0);
});

test("deleting a conversation, clearing history or closing the account deletes its links; export lists them", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "deleter");
  const a = await say(agent, "First chat");
  const b = await say(agent, "Second chat");
  const c = await say(agent, "Third chat");
  const la = (await share(agent, a).expect(201)).body;
  const lb = (await share(agent, b, { title: "Second, shared" }).expect(201)).body;
  const lc = (await share(agent, c).expect(201)).body;
  // The export lists live links with their addresses, not the snapshot text.
  const exported = (await agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.shareLinks.length, 3);
  const eb = exported.shareLinks.find((l) => l.id === lb.id);
  assert.deepEqual(Object.keys(eb).sort(), ["conversation_id", "created", "expires", "id", "messages", "title", "url"]);
  assert.equal(eb.url, lb.url);
  assert.equal(eb.title, "Second, shared");
  assert.equal(eb.messages, 2);
  // Deleting one conversation.
  await agent.delete("/api/conversations/" + a).expect(200);
  await view(s, tokenOf(la)).expect(404);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_links WHERE id=?").get(la.id).n, 0);
  // Clearing personal history.
  await agent.delete("/api/conversations").expect(200);
  await view(s, tokenOf(lb)).expect(404);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_links").get().n, 0);
  // Closing the account.
  const { agent: closer } = await person(s, "closer");
  const d = await say(closer, "Last words");
  const ld = (await share(closer, d).expect(201)).body;
  await view(s, tokenOf(ld)).expect(200);
  await closer.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  await view(s, tokenOf(ld)).expect(404);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_links").get().n, 0);
  assert.equal(lc.messages, 2);
});

test("at most 100 live links per account", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s, "prolific");
  const one = await say(agent, "One");
  const two = await say(agent, "Two");
  const insert = s.db.prepare(
    "INSERT INTO share_links(id,user_id,conversation_id,token,title,snapshot,message_count,created,expires) VALUES(?,?,?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < MAX_ACTIVE_SHARES; i++)
    insert.run(uid("share_"), user.id, one, uid().slice(0, 32), "t", "[]", 0, Date.now(), null);
  const r = await share(agent, two).expect(400);
  assert.equal(r.body.error.code, "share_limit");
  assert.match(r.body.error.message, /up to 100 active share links/);
  // Expired ones don't count.
  s.db.prepare("UPDATE share_links SET expires=? WHERE rowid IN (SELECT rowid FROM share_links LIMIT 1)").run(Date.now() - 1);
  await share(agent, two).expect(201);
});

test("viewing is rate-limited per address", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "popular");
  const link = (await share(agent, await say(agent, "Busy link")).expect(201)).body;
  for (let i = 0; i < 120; i++) await view(s, tokenOf(link), "203.0.113.9").expect(200);
  const r = await view(s, tokenOf(link), "203.0.113.9").expect(429);
  assert.equal(r.body.error.code, "rate_limit");
  // Another address is unaffected.
  await view(s, tokenOf(link), "203.0.113.10").expect(200);
});

test("the migration is additive and its triggers hold without the route", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  migrate(db);
  const latest = MIGRATIONS.length;
  const version = db.prepare("SELECT version FROM schema_additive WHERE version=?").get(latest);
  assert.ok(version, "recorded as additive");
  assert.deepEqual(rollbackSchema(db, latest - 1), { from: latest, to: latest - 1 });
  migrate(db);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, latest);
  db.prepare("INSERT INTO users(id,created) VALUES('u1',0),('u2',0)").run();
  db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated,expires) VALUES('c1','u1','t','chat',0,0,5000)").run();
  const add = (id, user, expires) =>
    db.prepare(
      "INSERT INTO share_links(id,user_id,conversation_id,token,title,snapshot,message_count,created,expires) VALUES(?,?,'c1',?,'t','[]',0,0,?)",
    ).run(id, user, "tok" + id, expires);
  // Only the conversation's creator.
  assert.throws(() => add("s0", "u2", null), /share_personal_only/);
  add("s1", "u1", null);
  add("s2", "u1", 9000);
  add("s3", "u1", 1000);
  const expiries = () =>
    db.prepare("SELECT id,expires FROM share_links ORDER BY id").all().map((r) => [r.id, r.expires]);
  assert.deepEqual(expiries(), [["s1", 5000], ["s2", 5000], ["s3", 1000]]);
  db.prepare("UPDATE conversations SET expires=2000 WHERE id='c1'").run();
  assert.deepEqual(expiries(), [["s1", 2000], ["s2", 2000], ["s3", 1000]]);
  db.prepare("DELETE FROM conversations WHERE id='c1'").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM share_links").get().n, 0);
  db.close();
});

test("pure helpers: blocking reasons, expiry, titles and snapshot rows", () => {
  assert.equal(shareBlocked({ saved: true, mode: "chat" }), null);
  assert.equal(shareBlocked({ saved: true, mode: "code" }), null);
  assert.equal(shareBlocked({ saved: true, mode: "uncensored" }), null);
  assert.equal(shareBlocked({ saved: true, privateMode: true, ephemeral: true }), "private");
  assert.equal(shareBlocked({ saved: false, ephemeral: true }), "off_record");
  assert.equal(shareBlocked({ saved: true, collab: true }), "collab");
  assert.equal(shareBlocked({ saved: true, mode: "symposium" }), "mode");
  assert.equal(shareBlocked({ saved: false, mode: "chat" }), "unsaved");
  assert.deepEqual(parseShareDays(undefined), { ok: true, days: 7 });
  assert.deepEqual(parseShareDays(null), { ok: true, days: null });
  assert.deepEqual(parseShareDays(30), { ok: true, days: 30 });
  assert.equal(parseShareDays(0).ok, false);
  assert.equal(parseShareDays("1").ok, false);
  assert.deepEqual(shareExpiry(7, 0, null), { expires: 7 * DAY, bounded: false });
  assert.deepEqual(shareExpiry(null, 0, null), { expires: null, bounded: false });
  assert.deepEqual(shareExpiry(7, 0, DAY), { expires: DAY, bounded: true });
  assert.deepEqual(shareExpiry(null, 0, DAY), { expires: DAY, bounded: true });
  assert.deepEqual(shareExpiry(1, 0, 30 * DAY), { expires: DAY, bounded: false });
  assert.equal(shareTitle("", "  Fallback "), "Fallback");
  assert.equal(shareTitle("x".repeat(90)).length, 70);
  assert.equal(shareTitle(" ", ""), "Shared conversation");
  assert.equal(snapshotMessage({ role: "system", content: '"x"' }), null);
  assert.equal(snapshotMessage({ role: "assistant", content: JSON.stringify({ text: "", reasoning: "r" }) }), null);
  assert.deepEqual(
    snapshotMessage({ role: "assistant", content: JSON.stringify({ text: "Hi" }), model: "m1" }, (id) => "Model " + id),
    { role: "assistant", text: "Hi", model: "Model m1" },
  );
  assert.deepEqual(snapshotMessage({ role: "user", content: "not json" }), { role: "user", text: "not json" });
  const rows = [
    { role: "user", content: JSON.stringify('Hi\n\n<document name="a.txt">A</document>\n\n<document name="b.csv">B</document>') },
    { role: "user", content: JSON.stringify([{ type: "text", text: '<document name="c.md">C</document>' }]) },
  ];
  assert.deepEqual([...attachmentNames(rows)].sort(), ["a.txt", "b.csv", "c.md"]);
  assert.deepEqual(snapshotMessage(rows[0]), { role: "user", text: "Hi", withheld: 2 });
  assert.deepEqual(snapshotSummary([{ text: "[EMAIL_1] and [CARD_2]", withheld: 1 }, { text: "none" }]), {
    messages: 2,
    withheld: 1,
    masked: 2,
  });
});
