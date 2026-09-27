import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { balance, now, uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import {
  createInactivityWipe,
  reminderEmail,
  OFFLINE_GAP_MS,
} from "../server/inactivity-wipe.js";
import {
  WIPE_DAYS,
  DAY_MS,
  ACTIVITY_STEP_MS,
  REMIND_MS,
  validDays,
  deadlineOf,
  remindAtOf,
  nearDeadline,
  daysLeft,
  daysLeftText,
  bannerOf,
  ERASES,
  KEEPS,
  BLOCKED_TEXT,
} from "../src/inactivity-wipe.js";
import { WIPE_GOES } from "../src/panic-wipe.js";
import { compileDictionary, translateText, translateDate } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ORIGIN = "http://localhost:5175";
const PASSWORD = "test-password-long";
const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 8, 27, 9, 0, 0);

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-inactivity-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    origin: ORIGIN,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  svc.dir = dir;
  return svc;
}
// No background maintenance: these tests move the clock and run the sweep
// themselves.
async function quiet(t, released, extra) {
  const svc = fixture(t, released, extra);
  await svc.stopWork();
  return svc;
}
// A controllable clock for core.now() and everything else on Date.now.
function clock(t, start = T0) {
  let at = start;
  t.mock.method(Date, "now", () => at);
  return {
    get now() {
      return at;
    },
    set(ms) {
      at = ms;
    },
    advance(ms) {
      at += ms;
    },
  };
}
let visitor = 0;
const ip = () => `198.51.100.${(++visitor % 250) + 1}`;
async function person(svc, username) {
  const agent = request.agent(svc.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", ip())
    .send({ username, password: PASSWORD })
    .expect(201);
  return { agent, id: r.body.user.id, username };
}
async function signIn(svc, username) {
  const agent = request.agent(svc.app);
  await agent
    .post("/api/auth/password")
    .set("X-Forwarded-For", ip())
    .send({ username, password: PASSWORD })
    .expect(200);
  return agent;
}
// A verified email, linked the way the Account page does it (test mode
// returns the code instead of mailing it).
async function linkEmail(p, email) {
  const sent = await p.agent
    .post("/api/auth/email/send")
    .set("X-Forwarded-For", ip())
    .send({ email, purpose: "link" })
    .expect(200);
  await p.agent
    .post("/api/auth/email/verify")
    .send({ id: sent.body.id, code: sent.body.testCode })
    .expect(200);
}
const turnOn = (p, days = 30, extra = {}) =>
  p.agent.put("/api/inactivity-wipe").send({ days, confirm: true, ...extra }).expect(200);
const view = async (p) => (await p.agent.get("/api/inactivity-wipe").expect(200)).body;
const row = (svc, id) =>
  svc.db.prepare("SELECT * FROM inactivity_wipe WHERE user_id=?").get(id);
// The worker has been running right up to `at` (no offline gap).
function running(svc, at) {
  svc.db
    .prepare(
      "INSERT INTO inactivity_clock(id,last_sweep) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_sweep=excluded.last_sweep",
    )
    .run(at - 60_000);
}
async function sweepAt(svc, c, at) {
  c.set(at);
  running(svc, at);
  return svc.inactivity.sweep(at);
}
const deadlineFor = (svc, id) => {
  const r = row(svc, id);
  return deadlineOf(r.last_active, r.days, r.paused);
};

// Some of everything an account keeps, the same for any account.
async function seed(svc, p) {
  const db = svc.db,
    t = now(),
    run = (sql, ...args) => db.prepare(sql).run(...args);
  const conv = uid("c_"),
    m1 = uid("m_"),
    m2 = uid("m_");
  run(
    "INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)",
    conv, p.id, "Trip notes", "chat", t, t,
  );
  run(
    "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
    m1, conv, "user", JSON.stringify("Plan a week in Naxos"), null, 0, t, p.id,
  );
  run(
    "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
    m2, conv, "assistant", JSON.stringify({ text: "Day one: the old town." }), "test-model", 0, t + 1, null,
  );
  run(
    "INSERT INTO bookmarks(id,user_id,message_id,note,created,updated) VALUES(?,?,?,?,?,?)",
    uid("bm_"), p.id, m2, "good one", t, t,
  );
  run(
    "INSERT INTO memory_facts(id,user_id,text,enabled,created,updated) VALUES(?,?,?,?,?,?)",
    uid("mf_"), p.id, "Prefers window seats", 1, t, t,
  );
  run(
    "INSERT INTO scrolls(id,user_id,title,body,created,updated) VALUES(?,?,?,?,?,?)",
    uid("s_"), p.id, "Packing list", "Sunscreen", t, t,
  );
  run(
    "INSERT INTO user_instructions(user_id,body,enabled,updated) VALUES(?,?,?,?)",
    p.id, "Answer briefly", 1, t,
  );
  run(
    "INSERT INTO uploads(id,user_id,name,bytes,kind,mime,text,created,expires,content) VALUES(?,?,?,?,?,?,?,?,?,?)",
    uid("up_"), p.id, "notes.txt", 5, "document", "text/plain", "hello", t, t + 30 * DAY_MS, Buffer.from("hello"),
  );
  const file = uid("f_") + ".png";
  mkdirSync(svc.cfg.mediaPath, { recursive: true });
  writeFileSync(join(svc.cfg.mediaPath, file), "png");
  run(
    "INSERT INTO media(id,user_id,kind,mime,filename,prompt,model,cost,created) VALUES(?,?,?,?,?,?,?,?,?)",
    uid("med_"), p.id, "image", "image/png", file, "a lighthouse", "test-image", 0, t,
  );
  run(
    "INSERT INTO routines(id,user_id,name,prompt,model,repeat,minute,timezone,run_cap,monthly_budget,next_run,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    uid("rt_"), p.id, "Morning news", "Five bullets", "test-model", "daily", 480, "UTC", 10000, 100000, t + DAY_MS, t, t,
  );
  await p.agent.post("/api/keys").send({ name: "agent" }).expect(201);
  // A second device.
  await signIn(svc, p.username);
  return { file };
}
// Rows per table that has a user_id column, plus messages in the account's
// own conversations, live keys and the saved files still on disk.
function snapshot(svc, id) {
  const db = svc.db;
  const out = {};
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all())
    if (db.prepare(`PRAGMA table_info(${name})`).all().some((c) => c.name === "user_id"))
      out[name] = db.prepare(`SELECT COUNT(*) n FROM ${name} WHERE user_id=?`).get(id).n;
  out.messages = db
    .prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id IN (SELECT id FROM conversations WHERE user_id=?)")
    .get(id).n;
  out.live_keys = db
    .prepare("SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND revoked IS NULL")
    .get(id).n;
  out.files = db
    .prepare("SELECT filename FROM media WHERE user_id=?")
    .all(id)
    .filter((m) => existsSync(join(svc.cfg.mediaPath, m.filename))).length;
  return out;
}

// ---- The release gate ----

test("unreleased: every route is refused, nothing shows or runs, and the docs leave it out", async (t) => {
  const mvp = await quiet(t, "mvp");
  const a = await person(mvp, "ana");
  for (const send of [
    () => a.agent.get("/api/inactivity-wipe"),
    () => a.agent.put("/api/inactivity-wipe").send({ days: 30, confirm: true }),
    () => a.agent.delete("/api/inactivity-wipe/notice"),
    () => a.agent.get("/API/Inactivity-Wipe/"),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Inactivity Wipe is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(mvp.app).get("/api/inactivity-wipe").expect(403);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.deadswitch, false);
  const entry = config.releases.updates.find((u) => u.id === "deadswitch");
  assert.equal(entry.title, "Inactivity Wipe");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  const docs = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(docs.paths).some((p) => p.includes("inactivity")));
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.ok(!("inactivityWipe" in exported), "no inactivityWipe key while unreleased and off");

  // It needs Panic Wipe, whose erase it is.
  assert.deepEqual(featuresFor({ path: "/api/inactivity-wipe", method: "GET", body: {} }), ["deadswitch", "wipe"]);
  assert.deepEqual(featuresFor({ path: "/api/inactivity-wipe/notice", method: "DELETE", body: {} }), ["deadswitch", "wipe"]);
  for (const path of ["/api/account/wipe", "/api/me", "/api/account/export", "/v1/balance"])
    assert.ok(!featuresFor({ path, method: "GET", body: {} }).includes("deadswitch"), path);
  const alone = await quiet(t, "mvp,deadswitch");
  const b = await person(alone, "ben");
  const res = await b.agent.get("/api/inactivity-wipe").expect(403);
  assert.equal(res.body.error.message, "Panic Wipe is coming soon.");
  assert.ok(!Object.keys(openapiForConfig(alone.cfg).paths).some((p) => p.includes("inactivity")));

  // A setting left from an earlier release: the worker neither erases nor
  // mails while the update is off, but activity is still recorded.
  const c = clock(t);
  const past = T0 - 100 * DAY_MS;
  mvp.db
    .prepare("INSERT INTO inactivity_wipe(user_id,days,api_counts,last_active,updated) VALUES(?,?,?,?,?)")
    .run(a.id, 30, 1, past, past);
  const before = snapshot(mvp, a.id);
  assert.deepEqual(await mvp.inactivity.sweep(c.now), { erased: 0, waiting: 0, reminded: 0 });
  assert.deepEqual(snapshot(mvp, a.id), before);
  await a.agent.get("/api/me").expect(200);
  assert.equal(row(mvp, a.id).last_active, T0);

  // Released with Panic Wipe, it answers.
  const open = await quiet(t, "mvp,wipe,deadswitch");
  const d = await person(open, "dee");
  assert.equal((await view(d)).enabled, false);
  for (const [path, methods] of [
    ["/api/inactivity-wipe", ["get", "put"]],
    ["/api/inactivity-wipe/notice", ["delete"]],
  ])
    assert.deepEqual(Object.keys(openapiForConfig(open.cfg).paths[path]).sort(), methods.sort());
});

// ---- The deadline maths ----

test("the deadline maths: whole days, plus the hour a recorded time can lag, plus offline time", () => {
  assert.deepEqual(WIPE_DAYS, [30, 90, 180, 365]);
  for (const d of WIPE_DAYS) assert.ok(validDays(d));
  for (const d of [0, 1, 7, 29, 31, 364, "30", null, undefined, 30.5]) assert.ok(!validDays(d), String(d));
  assert.equal(DAY_MS, 86_400_000);
  assert.equal(ACTIVITY_STEP_MS, HOUR);
  assert.equal(REMIND_MS, 7 * DAY_MS);
  for (const d of WIPE_DAYS) {
    assert.equal(deadlineOf(T0, d) - T0, d * DAY_MS + HOUR);
    assert.equal(remindAtOf(T0, d), deadlineOf(T0, d) - 7 * DAY_MS);
    assert.equal(deadlineOf(T0, d, 5 * HOUR) - deadlineOf(T0, d), 5 * HOUR);
  }
  // Absolute time: a daylight-saving change never moves it.
  const march = Date.UTC(2026, 2, 1);
  assert.equal(deadlineOf(march, 30) - march, 30 * DAY_MS + HOUR);
  assert.equal(deadlineOf(T0, 7), null);
  assert.equal(deadlineOf(NaN, 30), null);
  assert.equal(deadlineOf(T0, 30, -HOUR), deadlineOf(T0, 30), "negative offline time is ignored");
  // The last 7 days, boundaries included.
  const remind = remindAtOf(T0, 30);
  assert.equal(nearDeadline(T0, 30, remind - 1), false);
  assert.equal(nearDeadline(T0, 30, remind), true);
  assert.equal(nearDeadline(T0, 30, deadlineOf(T0, 30) + DAY_MS), true);
  // Days left: rounded down, so the extra hour never shows as a day.
  assert.equal(daysLeft(deadlineOf(T0, 90), T0), 90);
  assert.equal(daysLeft(deadlineOf(T0, 30), T0 + 29 * DAY_MS + 2 * HOUR), 0);
  assert.equal(daysLeft(deadlineOf(T0, 30), T0 + 40 * DAY_MS), 0);
  assert.equal(daysLeftText(0), "less than a day");
  assert.equal(daysLeftText(1), "1 day");
  assert.equal(daysLeftText(12), "12 days");
});

// ---- The setting ----

test("off by default: an account that never turns it on has nothing recorded", async (t) => {
  const svc = await quiet(t);
  const p = await person(svc, "olga");
  const v = await view(p);
  assert.equal(v.enabled, false);
  assert.equal(v.days, null);
  assert.equal(v.apiCounts, true, "API use would count once it's on");
  assert.equal(v.lastActive, null);
  assert.equal(v.deadline, null);
  assert.equal(v.notice, null);
  assert.deepEqual(v.options, [30, 90, 180, 365]);
  const key = (await p.agent.post("/api/keys").send({ name: "k" }).expect(201)).body.key;
  await request(svc.app).get("/v1/balance").set("Authorization", "Bearer " + key).expect(200);
  await signIn(svc, "olga");
  await p.agent.get("/api/me").expect(200);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM inactivity_wipe").get().n, 0);
  assert.equal((await p.agent.get("/api/account/export").expect(200)).body.inactivityWipe, null);
  assert.deepEqual(await svc.inactivity.sweep(), { erased: 0, waiting: 0, reminded: 0 });
});

test("turning it on needs a confirmation, as does a shorter period; off deletes the record", async (t) => {
  const svc = await quiet(t);
  const c = clock(t);
  const p = await person(svc, "pia");
  const put = (body) => p.agent.put("/api/inactivity-wipe").send(body);
  for (const [body, code] of [
    [{}, "invalid_inactivity"],
    [{ days: 7, confirm: true }, "invalid_days"],
    [{ days: "30", confirm: true }, "invalid_days"],
    [{ days: 0, confirm: true }, "invalid_days"],
    [{ days: 30, api_counts: "yes", confirm: true }, "invalid_api_counts"],
    [{ api_counts: false }, "invalid_days"],
    [{ days: 90 }, "confirmation_required"],
    [{ days: 90, confirm: "true" }, "confirmation_required"],
  ]) {
    const res = await put(body).expect(400);
    assert.equal(res.body.error.code, code, JSON.stringify(body));
  }
  assert.equal(row(svc, p.id), undefined, "nothing stored by a refused change");
  let v = (await put({ days: 90, confirm: true }).expect(200)).body;
  assert.equal(v.enabled, true);
  assert.equal(v.days, 90);
  assert.equal(v.apiCounts, true);
  assert.equal(v.lastActive, T0);
  assert.equal(v.deadline, T0 + 90 * DAY_MS + HOUR);
  assert.equal(v.daysLeft, 90);
  assert.equal(v.email, false);
  assert.equal(v.remindAt, null, "no verified email, no reminder");
  // Longer needs no confirmation; shorter does.
  c.advance(10 * 60_000);
  v = (await put({ days: 180 }).expect(200)).body;
  assert.equal(v.days, 180);
  assert.equal(v.lastActive, c.now, "a change starts a new period");
  assert.equal((await put({ days: 30 }).expect(400)).body.error.code, "confirmation_required");
  assert.equal(row(svc, p.id).days, 180);
  v = (await put({ days: 30, confirm: true }).expect(200)).body;
  assert.equal(v.days, 30);
  // api_counts alone keeps the period.
  v = (await put({ api_counts: false }).expect(200)).body;
  assert.equal(v.apiCounts, false);
  assert.equal(v.days, 30);
  // Off deletes the row: nothing about the account's activity stays.
  v = (await put({ days: null }).expect(200)).body;
  assert.equal(v.enabled, false);
  assert.equal(row(svc, p.id), undefined);
  // With a verified email, the reminder is scheduled.
  await linkEmail(p, "pia@example.com");
  v = (await turnOn(p, 90)).body;
  assert.equal(v.email, true);
  assert.equal(v.emailReminders, true);
  assert.equal(v.remindAt, v.deadline - 7 * DAY_MS);
  assert.ok(!JSON.stringify(v).includes("pia@example.com"), "the address itself isn't returned");
});

// ---- Activity ----

test("sign-ins, session requests and API use refresh last-active at most once an hour", async (t) => {
  const svc = await quiet(t);
  const c = clock(t);
  const p = await person(svc, "quinn");
  const key = (await p.agent.post("/api/keys").send({ name: "agent" }).expect(201)).body.key;
  const bearer = "Bearer " + key;
  await turnOn(p, 30);
  const last = () => row(svc, p.id).last_active;
  assert.equal(last(), T0);
  c.advance(30 * 60_000);
  await p.agent.get("/api/me").expect(200);
  assert.equal(last(), T0, "within the hour: no write");
  c.set(T0 + HOUR);
  await p.agent.get("/api/me").expect(200);
  assert.equal(last(), T0 + HOUR, "an hour on: written");
  c.advance(10 * 60_000);
  await signIn(svc, "quinn");
  assert.equal(last(), T0 + HOUR, "a sign-in is throttled the same way");
  c.advance(HOUR);
  await signIn(svc, "quinn");
  assert.equal(last(), c.now, "a sign-in counts");
  // Signed-out requests and bad keys never count.
  c.advance(2 * HOUR);
  await request(svc.app).get("/api/me").expect(200);
  await request(svc.app).get("/v1/balance").set("Authorization", "Bearer anonyma_live_nope").expect(401);
  assert.equal(last(), c.now - 2 * HOUR);
  // API keys count while api_counts is on (the default)...
  await request(svc.app).get("/v1/balance").set("Authorization", bearer).expect(200);
  assert.equal(last(), c.now, "an API key's use counts");
  c.advance(2 * HOUR);
  await request(svc.app)
    .post("/mcp")
    .set("Authorization", bearer)
    .send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
    .expect(200);
  assert.equal(last(), c.now, "so does MCP use");
  // ...and not once it's unticked.
  c.advance(2 * HOUR);
  await p.agent.put("/api/inactivity-wipe").send({ api_counts: false }).expect(200);
  const setAt = c.now;
  c.advance(2 * HOUR);
  await request(svc.app).get("/v1/balance").set("Authorization", bearer).expect(200);
  await request(svc.app)
    .post("/mcp")
    .set("Authorization", bearer)
    .send({ jsonrpc: "2.0", id: 2, method: "ping" })
    .expect(200);
  assert.equal(last(), setAt, "API and MCP use no longer count");
  await p.agent.get("/api/me").expect(200);
  assert.equal(last(), c.now, "the account's own session still does");
});

// ---- The worker ----

test("the worker erases exactly what Panic Wipe erases, keeps credits and settings, and runs once", async (t) => {
  const svc = await quiet(t);
  const c = clock(t);
  const panic = await person(svc, "petra");
  const idle = await person(svc, "ivan");
  const idleFiles = await seed(svc, idle);
  await seed(svc, panic);
  await turnOn(panic, 30);
  await turnOn(idle, 30);
  const full = snapshot(svc, idle.id);
  assert.ok(full.conversations && full.messages && full.media && full.files && full.live_keys && full.sessions >= 2);
  const credits = balance(svc.db, idle.id);
  const ledger = svc.db.prepare("SELECT * FROM ledger WHERE user_id=? ORDER BY rowid").all(idle.id);
  // Panic Wipe, by hand, for one of them.
  c.advance(HOUR);
  await panic.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  // Not a millisecond early.
  const deadline = deadlineFor(svc, idle.id);
  assert.equal(deadline, T0 + 30 * DAY_MS + HOUR);
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args.map(String).join(" ")));
  assert.deepEqual(await sweepAt(svc, c, deadline - 1), { erased: 0, waiting: 0, reminded: 0 });
  assert.deepEqual(snapshot(svc, idle.id), full);
  assert.deepEqual(await sweepAt(svc, c, deadline), { erased: 1, waiting: 0, reminded: 0 });
  // Exactly the same as Panic Wipe, table by table.
  const erased = snapshot(svc, idle.id);
  assert.deepEqual(erased, snapshot(svc, panic.id));
  for (const k of ["conversations", "messages", "bookmarks", "memory_facts", "scrolls", "user_instructions", "uploads", "media", "files", "routines", "sessions", "live_keys"])
    assert.equal(erased[k], 0, k);
  assert.ok(!existsSync(join(svc.cfg.mediaPath, idleFiles.file)));
  // Credits, ledger, the account and the setting stay.
  assert.deepEqual(balance(svc.db, idle.id), credits);
  assert.deepEqual(svc.db.prepare("SELECT * FROM ledger WHERE user_id=? ORDER BY rowid").all(idle.id), ledger);
  assert.equal(svc.db.prepare("SELECT deleted FROM users WHERE id=?").get(idle.id).deleted, null);
  const r = row(svc, idle.id);
  assert.equal(r.days, 30);
  assert.equal(r.erased, deadline);
  assert.equal(r.notice, "erased");
  // Signed out everywhere.
  assert.equal((await idle.agent.get("/api/me").expect(200)).body.user, null);
  // Logs carry a count, never the account.
  assert.deepEqual(lines, ["Inactivity Wipe: 1 erased, 0 waiting, 0 reminded."]);
  for (const line of lines) for (const s of [idle.id, "ivan", "Trip notes"]) assert.ok(!line.includes(s));
  // Idempotent: once erased, never again in the same period. (The Panic
  // Wipe account has the setting on too; its period ends an hour later, and
  // its erase finds nothing left.)
  const panicSnapshot = snapshot(svc, panic.id);
  assert.deepEqual(await sweepAt(svc, c, deadline + DAY_MS), { erased: 1, waiting: 0, reminded: 0 });
  assert.equal(row(svc, panic.id).erased, deadline + DAY_MS);
  assert.deepEqual(snapshot(svc, panic.id), panicSnapshot);
  assert.equal(row(svc, idle.id).erased, deadline, "not erased twice");
  assert.deepEqual(await sweepAt(svc, c, deadline + 2 * DAY_MS - 1), { erased: 0, waiting: 0, reminded: 0 });
  // Coming back starts a new period; what's saved then stays until its own
  // deadline.
  c.set(deadline + 2 * DAY_MS);
  const back = await signIn(svc, "ivan");
  const v = (await back.get("/api/inactivity-wipe").expect(200)).body;
  assert.equal(v.lastActive, c.now);
  assert.deepEqual(v.notice, { kind: "erased", at: deadline, days: 30 });
  assert.deepEqual(bannerOf(v), { kind: "erased", at: deadline, days: 30 });
  svc.db
    .prepare("INSERT INTO scrolls(id,user_id,title,body,created,updated) VALUES(?,?,?,?,?,?)")
    .run("s_new", idle.id, "New", "x", c.now, c.now);
  assert.deepEqual(await sweepAt(svc, c, c.now + 29 * DAY_MS), { erased: 0, waiting: 0, reminded: 0 });
  assert.equal(snapshot(svc, idle.id).scrolls, 1);
  // Dismissed once, gone.
  const dismissed = (await back.delete("/api/inactivity-wipe/notice").expect(200)).body;
  assert.equal(dismissed.notice, null);
  assert.equal(dismissed.erased, deadline, "the last erase stays listed");
});

test("the background worker's tick runs the sweep", async (t) => {
  const svc = fixture(t);
  const p = await person(svc, "tick");
  await seed(svc, p);
  await turnOn(p, 30);
  // Due long ago, and the worker's first run (nothing to measure a gap from).
  svc.db.prepare("UPDATE inactivity_wipe SET last_active=? WHERE user_id=?").run(now() - 31 * DAY_MS, p.id);
  svc.db.prepare("DELETE FROM inactivity_clock").run();
  t.mock.method(console, "log", () => {});
  // Twice: the first may be a round the timer had already started.
  await svc.tick();
  await svc.tick();
  assert.ok(row(svc, p.id).erased, "erased by the tick");
  assert.equal(snapshot(svc, p.id).conversations, 0);
  assert.equal(snapshot(svc, p.id).files, 0);
});

test("an erase waits for requests in progress and retries an hour later", async (t) => {
  const svc = await quiet(t);
  const c = clock(t);
  const p = await person(svc, "wanda");
  await seed(svc, p);
  await turnOn(p, 30);
  svc.db
    .prepare("INSERT INTO holds(id,user_id,amount,kind,status,created,expires) VALUES(?,?,?,?,?,?,?)")
    .run("h_1", p.id, 100, "chat", "held", T0, T0 + 1e12);
  const full = snapshot(svc, p.id);
  const deadline = deadlineFor(svc, p.id);
  assert.deepEqual(await sweepAt(svc, c, deadline), { erased: 0, waiting: 1, reminded: 0 });
  assert.deepEqual(snapshot(svc, p.id), full, "nothing erased, files included");
  assert.equal(row(svc, p.id).blocked, "requests_in_flight");
  svc.db.prepare("UPDATE holds SET status='released' WHERE id='h_1'").run();
  assert.deepEqual(await sweepAt(svc, c, deadline + 30 * 60_000), { erased: 0, waiting: 0, reminded: 0 }, "not retried within the hour");
  assert.deepEqual(await sweepAt(svc, c, deadline + HOUR), { erased: 1, waiting: 0, reminded: 0 });
  assert.equal(row(svc, p.id).blocked, null);
  assert.equal(snapshot(svc, p.id).conversations, 0);
  assert.ok(BLOCKED_TEXT.requests_in_flight && BLOCKED_TEXT.treasury_not_empty && BLOCKED_TEXT.failed);
});

test("coming back in the last 7 days resets the clock and leaves a one-time notice", async (t) => {
  const svc = await quiet(t);
  const c = clock(t);
  const p = await person(svc, "rhea");
  await turnOn(p, 30);
  const first = deadlineFor(svc, p.id);
  // Back before the last 7 days: a quiet reset.
  c.set(first - 8 * DAY_MS);
  let v = await view(p);
  assert.equal(v.notice, null);
  assert.equal(v.lastActive, c.now);
  // Back inside them, with a fresh sign-in (the old session has expired):
  // the reset is shown once.
  const second = deadlineFor(svc, p.id);
  c.set(second - 3 * DAY_MS);
  p.agent = await signIn(svc, "rhea");
  v = await view(p);
  assert.deepEqual(v.notice, { kind: "reset", deadline: second });
  assert.equal(v.deadline, c.now + 30 * DAY_MS + HOUR);
  assert.deepEqual(bannerOf(v), { kind: "reset", deadline: second, left: 3, next: v.deadline });
  v = (await p.agent.delete("/api/inactivity-wipe/notice").expect(200)).body;
  assert.equal(v.notice, null);
  assert.equal(bannerOf(v), null);
  // Past the deadline but before the worker got to it: still a reset.
  const third = deadlineFor(svc, p.id);
  c.set(third + 10 * 60_000);
  p.agent = await signIn(svc, "rhea");
  v = await view(p);
  assert.deepEqual(bannerOf(v), { kind: "reset", deadline: third, left: 0, next: v.deadline });
  assert.deepEqual(await sweepAt(svc, c, c.now), { erased: 0, waiting: 0, reminded: 0 });
});

test("one reminder email 7 days before, only to a verified email, and test mode only records it", async (t) => {
  const svc = await quiet(t);
  const c = clock(t);
  const mail = await person(svc, "mira");
  await linkEmail(mail, "mira@example.com");
  const none = await person(svc, "nils");
  await turnOn(mail, 90);
  await turnOn(none, 90);
  const remindAt = row(svc, mail.id).last_active + 83 * DAY_MS + HOUR;
  assert.equal(remindAt, deadlineFor(svc, mail.id) - 7 * DAY_MS);
  assert.deepEqual(await sweepAt(svc, c, remindAt - 1), { erased: 0, waiting: 0, reminded: 0 });
  assert.equal(svc.inactivity.outbox.length, 0);
  assert.deepEqual(await sweepAt(svc, c, remindAt), { erased: 0, waiting: 0, reminded: 1 });
  assert.equal(svc.inactivity.outbox.length, 1);
  const [sent] = svc.inactivity.outbox;
  assert.equal(sent.to, "mira@example.com");
  assert.equal(sent.subject, "Your ANONYMA content will be erased in 7 days");
  assert.match(sent.text, /no activity for 83 days/);
  assert.match(sent.text, new RegExp(new Date(deadlineFor(svc, mail.id)).toUTCString().slice(0, 16)));
  assert.match(sent.text, /http:\/\/localhost:5175\/login/);
  assert.ok(!sent.text.includes("mira") && !sent.text.includes(mail.id), "nothing about the account in the text");
  assert.equal(row(svc, mail.id).reminded, remindAt);
  // Sent once: later sweeps in the same period send nothing more.
  for (const at of [remindAt + 7 * HOUR, remindAt + 3 * DAY_MS, remindAt + 7 * DAY_MS - 1])
    assert.equal((await sweepAt(svc, c, at)).reminded, 0);
  assert.equal(svc.inactivity.outbox.length, 1);
  assert.ok(!svc.inactivity.outbox.some((m) => m.to !== "mira@example.com"), "no email, no reminder");
  // Coming back starts a new period with its own reminder.
  c.set(remindAt + 7 * DAY_MS - 2);
  await signIn(svc, "mira");
  assert.equal(row(svc, mail.id).reminded, null);
  const next = deadlineFor(svc, mail.id) - 7 * DAY_MS;
  assert.equal((await sweepAt(svc, c, next)).reminded, 1);
  assert.equal(svc.inactivity.outbox.length, 2);
  assert.equal(svc.inactivity.outbox.filter((m) => m.to === "mira@example.com").length, 2);
});

test("a reminder that can't be sent is tried again six hours later, and nothing is sent while unreleased", async (t) => {
  const svc = await quiet(t);
  const c = clock(t);
  const p = await person(svc, "tess");
  await linkEmail(p, "tess@example.com");
  await turnOn(p, 30);
  let accept = false;
  const tries = [];
  const worker = createInactivityWipe(
    { db: svc.db, cfg: svc.cfg },
    {
      erase: () => assert.fail("nothing is due"),
      send: async (m) => {
        tries.push(m.to);
        return accept;
      },
    },
  );
  const remindAt = deadlineFor(svc, p.id) - 7 * DAY_MS;
  running(svc, remindAt);
  assert.equal((await worker.sweep(remindAt)).reminded, 0);
  assert.equal(tries.length, 1);
  assert.equal(row(svc, p.id).reminded, null);
  running(svc, remindAt + HOUR);
  await worker.sweep(remindAt + HOUR);
  assert.equal(tries.length, 1, "not before six hours");
  accept = true;
  running(svc, remindAt + 6 * HOUR);
  assert.equal((await worker.sweep(remindAt + 6 * HOUR)).reminded, 1);
  assert.equal(tries.length, 2);
  assert.equal(row(svc, p.id).reminded, remindAt + 6 * HOUR);
  // The email itself.
  const email = reminderEmail({ origin: "https://askanonyma.com" }, { idleDays: 1, deadline: T0 });
  assert.match(email.text, /no activity for 1 day\./);
  assert.match(email.text, /https:\/\/askanonyma\.com\/login/);
  // Unreleased: nothing is sent.
  const off = await quiet(t, "mvp");
  const q = await person(off, "uma");
  off.db.prepare("UPDATE users SET email=? WHERE id=?").run("uma@example.com", q.id);
  off.db
    .prepare("INSERT INTO inactivity_wipe(user_id,days,api_counts,last_active,updated) VALUES(?,?,?,?,?)")
    .run(q.id, 30, 1, T0 - 25 * DAY_MS, T0);
  assert.deepEqual(await off.inactivity.sweep(T0), { erased: 0, waiting: 0, reminded: 0 });
  assert.equal(off.inactivity.outbox.length, 0);
});

test("without an email service, no reminder date is shown, claimed, recorded or sent", async (t) => {
  // Live mode with no SMTP settings, as production is today.
  const svc = await quiet(t, "all", { testMode: false });
  const c = clock(t);
  const config = (await request(svc.app).get("/api/config").expect(200)).body;
  assert.equal(config.services.email, false);
  const p = await person(svc, "vera");
  // A verified email from before (linking one needs the email service).
  svc.db.prepare("UPDATE users SET email=? WHERE id=?").run("vera@example.com", p.id);
  let v = (await turnOn(p, 30)).body;
  assert.equal(v.email, true);
  assert.equal(v.emailReminders, false, "the same readiness as services.email");
  assert.equal(v.remindAt, null, "no reminder date is promised");
  const tries = [];
  const worker = createInactivityWipe(
    { db: svc.db, cfg: svc.cfg },
    { erase: () => assert.fail("nothing is due"), send: async (m) => (tries.push(m), true) },
  );
  const remindAt = deadlineFor(svc, p.id) - 7 * DAY_MS;
  for (const at of [remindAt, remindAt + DAY_MS, remindAt + 7 * HOUR]) {
    running(svc, at);
    assert.equal((await worker.sweep(at)).reminded, 0);
    assert.equal((await sweepAt(svc, c, at)).reminded, 0);
  }
  assert.equal(tries.length, 0, "nothing handed to a mailer");
  assert.equal(svc.inactivity.outbox.length, 0);
  const r = row(svc, p.id);
  assert.equal(r.remind_tried, null, "not claimed");
  assert.equal(r.reminded, null, "not recorded");
  v = await view(p);
  assert.equal(v.reminded, null);
  assert.equal(v.remindAt, null);
  // The erase itself doesn't depend on email.
  assert.equal((await sweepAt(svc, c, deadlineFor(svc, p.id))).erased, 1);

  // With SMTP set up (live mode), it's offered and sent once, to the
  // verified email only.
  const smtp = await quiet(t, "all", { testMode: false, smtp: "smtp://127.0.0.1:9", smtpFrom: "ANONYMA <no-reply@example.com>" });
  assert.equal((await request(smtp.app).get("/api/config").expect(200)).body.services.email, true);
  const q = await person(smtp, "wren");
  const n = await person(smtp, "noor");
  smtp.db.prepare("UPDATE users SET email=? WHERE id=?").run("wren@example.com", q.id);
  const w = (await turnOn(q, 30)).body;
  assert.equal(w.emailReminders, true);
  assert.equal(w.remindAt, w.deadline - 7 * DAY_MS);
  const none = (await turnOn(n, 30)).body;
  assert.equal(none.emailReminders, true);
  assert.equal(none.email, false);
  assert.equal(none.remindAt, null, "no verified email, no date");
  const sent = [];
  const mailer = createInactivityWipe(
    { db: smtp.db, cfg: smtp.cfg },
    { erase: () => assert.fail("nothing is due"), send: async (m) => (sent.push(m.to), true) },
  );
  running(smtp, w.remindAt);
  assert.equal((await mailer.sweep(w.remindAt)).reminded, 1);
  running(smtp, w.remindAt + DAY_MS);
  assert.equal((await mailer.sweep(w.remindAt + DAY_MS)).reminded, 0);
  assert.deepEqual(sent, ["wren@example.com"]);
});

test("time the worker wasn't running never counts as inactivity", async (t) => {
  const svc = await quiet(t);
  const c = clock(t);
  const p = await person(svc, "otto");
  await seed(svc, p);
  await turnOn(p, 30);
  c.set(T0 + 10 * 60_000);
  await svc.inactivity.sweep(c.now);
  const deadline = deadlineFor(svc, p.id);
  // The service was down (or a backup restored) from then to the deadline:
  // that whole time is added, so nothing is erased on coming back up.
  c.set(deadline);
  assert.deepEqual(await svc.inactivity.sweep(c.now), { erased: 0, waiting: 0, reminded: 0 });
  const r = row(svc, p.id);
  assert.equal(r.paused, deadline - (T0 + 10 * 60_000));
  assert.ok(snapshot(svc, p.id).conversations > 0);
  assert.ok(r.paused >= OFFLINE_GAP_MS);
  // A short gap (under 15 minutes) is ordinary and adds nothing.
  const other = await person(svc, "olaf");
  await turnOn(other, 30);
  c.advance(10 * 60_000);
  await svc.inactivity.sweep(c.now);
  assert.equal(row(svc, other.id).paused, 0);
  // With the worker running, the extended deadline is kept to the
  // millisecond.
  const extended = deadlineFor(svc, p.id);
  assert.equal(extended, deadline + r.paused);
  assert.deepEqual(await sweepAt(svc, c, extended - 1), { erased: 0, waiting: 0, reminded: 0 });
  assert.deepEqual(await sweepAt(svc, c, extended), { erased: 1, waiting: 0, reminded: 0 });
  assert.equal(row(svc, p.id).erased, extended);
  assert.equal(row(svc, other.id).erased, null);
});

// ---- Export and lifecycle ----

test("the export lists the setting; closure deletes it; Panic Wipe keeps it", async (t) => {
  const svc = await quiet(t);
  const c = clock(t);
  const p = await person(svc, "xena");
  await turnOn(p, 180, { api_counts: false });
  const exported = (await p.agent.get("/api/account/export").expect(200)).body.inactivityWipe;
  assert.deepEqual(exported, {
    days: 180,
    apiCounts: false,
    lastActive: T0,
    paused: 0,
    deadline: T0 + 180 * DAY_MS + HOUR,
    reminded: null,
    erased: null,
    updated: T0,
  });
  c.advance(2 * HOUR);
  await p.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(row(svc, p.id).days, 180, "Panic Wipe keeps the setting");
  const again = await signIn(svc, "xena");
  await again.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(row(svc, p.id), undefined, "closure deletes it");
});

// ---- The browser side ----

const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
const han = /\p{Script=Han}/u;

test("its lists match Panic Wipe's, and the update has an icon", () => {
  // Panic Wipe's list, less what only a browser can clear.
  assert.deepEqual(ERASES.slice(0, 8), WIPE_GOES.slice(0, 8));
  assert.ok(!ERASES.some((x) => /browser/i.test(x)));
  assert.ok(KEEPS.includes("Your account and every credit in it"));
  const pages = readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8");
  assert.match(pages, /\bdeadswitch: "hourglass"/, "featureIcons entry");
  assert.match(readFileSync(new URL("../src/ui.jsx", import.meta.url), "utf8"), /hourglass: Hourglass/);
  const docker = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(docker, /src\/inactivity-wipe\.js/, "the server's shared maths ships in the image");
});

test("the Chinese dictionary covers the update, the section, the dialog, the banner and the errors", () => {
  const entry = UPDATES.find((u) => u.id === "deadswitch");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Inactivity Wipe is coming soon.",
    ...ERASES,
    ...KEEPS,
    ...Object.values(BLOCKED_TEXT),
    "Anything kept in your browsers, such as Device Vault chats",
    "Inactivity wipe.",
    "If you stop signing in, your content erases itself. Off until you choose a period.",
    "Erase my content if I don’t sign in for",
    "API and connected-app use counts as activity",
    "An agent using your API key keeps your content. Untick this so only you signing in counts.",
    "What gets erased, and what stays",
    "Last active",
    "Erases after",
    "Time left",
    "Reminder",
    "Offline time added",
    "Last erased",
    "On · 90 days",
    "less than a day",
    "Sent 12/19/2026, 1:05 PM",
    "By email, 12/19/2026, 1:05 PM",
    "None, since email reminders aren’t available",
    "None: add a verified email in Account",
    "No reminder email: email reminders aren’t available.",
    "No reminder email: add a verified email in Account to get one.",
    "We’ll email you a reminder 7 days before.",
    "We’ll email a reminder 7 days before, if email is set up and you’ve added one.",
    "The erase is waiting.",
    "It tries again every hour.",
    "On. If you don’t sign in before 12/26/2026, 1:05 PM, your content is erased.",
    "Off. Nothing will be erased for inactivity, and your last-active time is deleted.",
    "Turn on Inactivity Wipe?",
    "If you don’t sign in for 90 days, your content will be erased. This can’t be undone.",
    "Shorten it",
    "Inactivity Wipe was 5 days away.",
    "Inactivity Wipe was less than a day away.",
    "Inactivity Wipe was due.",
    "Signing in reset the clock.",
    "If you stop signing in, it erases your content after 12/26/2026, 12:52 PM.",
    "Inactivity Wipe erased your content on 9/27/2026, 12:52 PM.",
    "There was no activity for 30 days. Your account and credits are here.",
    "Your account and credits are here.",
    "Inactivity settings",
    "Dismiss the Inactivity Wipe notice",
    "Confirm to turn on Inactivity Wipe or shorten its period.",
    "Choose 30, 90, 180 or 365 days, or null to turn it off.",
    "Choose a period to turn Inactivity Wipe on.",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
});

// InactivityWipe.jsx compiled for Node with the same esbuild Vite uses;
// shared UI and routing are swapped for plain stand-ins so only its own text
// renders.
async function uiModule() {
  const src = new URL("../src/InactivityWipe.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-inactivity-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Notice = ({ children }) => React.createElement("div", null, children);
     export const Icon = () => React.createElement("svg");
     export const Button = ({ children }) => React.createElement("button", null, children);
     export const Modal = ({ children, title }) => React.createElement("dialog", { "aria-label": title }, children);`,
  );
  const router = stub(
    "router.mjs",
    `export const Link = ({ children, to, className }) => React.createElement("a", { href: to, className }, children);`,
  );
  const out = code
    .replace(/^import "\.\/(panic-wipe|inactivity-wipe)\.css";$/gm, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "\.\/(lib|panic-wipe|inactivity-wipe)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "InactivityWipe.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function pageTexts(html) {
  const out = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)) out.push(entities(attr));
    } else if (entities(text).trim()) out.push(entities(text).trim());
  }
  return out.filter((x) => /[A-Za-z]{2}/.test(x));
}

test("the section and the banner are gated, and every word on them translates", async () => {
  const mod = await uiModule();
  const on = { releases: { features: { deadswitch: true, wipe: true, projects: true, bookmarks: true, blind: true, pagewatch: true, passkeys: true, giftlinks: true, vaultsync: true, canvas: true, slides: true, arena: true } } };
  const soon = { releases: { features: { deadswitch: false, wipe: true } } };
  assert.equal(mod.inactivityReleased(on), true);
  assert.equal(mod.inactivityReleased(soon), false);
  assert.equal(mod.inactivityReleased({ releases: { features: { deadswitch: true, wipe: false } } }), false);
  const user = { id: "u_1" };
  assert.equal(renderToStaticMarkup(createElement(mod.InactivityWipeSettings, { config: soon, user })), "");
  assert.equal(renderToStaticMarkup(createElement(mod.InactivityWipeBanner, { config: soon, user, demo: false })), "");
  const base = {
    enabled: true,
    days: 90,
    apiCounts: true,
    lastActive: T0,
    paused: 3 * HOUR,
    deadline: deadlineOf(T0, 90, 3 * HOUR),
    daysLeft: 90,
    email: true,
    emailReminders: true,
    remindAt: remindAtOf(T0, 90, 3 * HOUR),
    reminded: null,
    erased: T0 - 40 * DAY_MS,
  };
  const html = [
    renderToStaticMarkup(createElement(mod.InactivityStatus, { view: base })),
    renderToStaticMarkup(createElement(mod.InactivityStatus, { view: { ...base, reminded: T0 + DAY_MS, daysLeft: 0 } })),
    renderToStaticMarkup(createElement(mod.InactivityStatus, { view: { ...base, email: false } })),
    renderToStaticMarkup(createElement(mod.InactivityStatus, { view: { ...base, emailReminders: false, daysLeft: 1 } })),
    renderToStaticMarkup(createElement(mod.WipeLists, { config: on })),
    renderToStaticMarkup(createElement(mod.InactivityNotice, { banner: { kind: "reset", deadline: T0, left: 5, next: T0 + 30 * DAY_MS }, onDismiss() {} })),
    renderToStaticMarkup(createElement(mod.InactivityNotice, { banner: { kind: "reset", deadline: T0, left: 0, next: T0 + 30 * DAY_MS }, onDismiss() {} })),
    renderToStaticMarkup(createElement(mod.InactivityNotice, { banner: { kind: "erased", at: T0, days: 30 }, onDismiss() {} })),
  ].join("");
  const texts = pageTexts(html);
  for (const expected of ["Slide decks saved to your account", "Canvases saved to your account", "Vault Sync's encrypted copy of your Device Vault on our servers", "Anything kept in your browsers, such as Device Vault chats"])
    assert.ok(texts.includes(expected), expected);
  assert.ok(!texts.includes("Slides decks, on your account and in this browser"), "automatic erase cannot reach local decks");
  for (const expected of ["Last active", "Erases after", "Offline time added", "Last erased", "What goes", "What stays", "Dismiss", "Inactivity settings"])
    assert.ok(texts.includes(expected), expected);
  // The reminder row: a date only when email can be sent and the account
  // has a verified one.
  assert.match(mod.reminderText(base), /^By email, /);
  assert.equal(mod.reminderText({ ...base, emailReminders: false, remindAt: null }), "None, since email reminders aren’t available");
  assert.equal(mod.reminderText({ ...base, email: false, remindAt: null }), "None: add a verified email in Account");
  assert.equal(mod.reminderText({ ...base, emailReminders: false, email: false, remindAt: null }), "None, since email reminders aren’t available");
  assert.match(mod.reminderText({ ...base, reminded: T0 }), /^Sent /);
  const off = renderToStaticMarkup(createElement(mod.InactivityStatus, { view: { ...base, emailReminders: false, remindAt: null } }));
  assert.ok(pageTexts(off).includes("None, since email reminders aren’t available"));
  assert.ok(!/By email/.test(off));
  assert.equal(mod.reminderPromise({ emailReminders: false, email: true }), "No reminder email: email reminders aren’t available.");
  assert.equal(mod.reminderPromise({ emailReminders: true, email: false }), "No reminder email: add a verified email in Account to get one.");
  assert.equal(mod.reminderPromise({ emailReminders: true, email: true }), "We’ll email you a reminder 7 days before.");
  assert.match(html, /href="\/account\/settings#inactivity-wipe"/);
  // Dates render in the form zh-CN uses; everything with words is Chinese.
  for (const text of texts)
    if (translateDate(text) === undefined)
      assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
  assert.ok(texts.some((x) => translateDate(x) !== undefined), "dates are there, in a form the switch translates");
});
