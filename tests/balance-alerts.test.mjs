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
import { database, reserve, release, settle, now, uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { thresholdUnits } from "../server/balance-alerts.js";
import {
  MAX_CREDITS,
  SUGGESTED_CREDITS,
  THRESHOLD_RULE,
  bandOf,
  bannerFor,
  cleanMemory,
  dismissBanner,
  isInsufficientMessage,
  localDay,
  notificationText,
  notifiedMemory,
  observe,
  parseThreshold,
  shouldNotify,
  showCredits,
  toUnits,
  validThreshold,
} from "../src/balance-alerts.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const ORIGIN = "http://localhost:5175";
const units = (credits) => Math.round(credits * 10000);
const START = units(100_000); // the test-mode sign-up credit

async function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-alerts-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: ORIGIN,
    released,
    mvpModels: [MODEL],
  });
  await svc.stopWork();
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  svc.dir = dir;
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
const setAlert = (p, body) => p.agent.patch("/api/balance-alert").send(body);
const row = (s, user) =>
  s.db
    .prepare(
      "SELECT threshold,typeof(threshold) kind,notify,updated FROM balance_alerts WHERE user_id=?",
    )
    .get(user) || null;
const ledgerRows = (s) => s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n;
const holdRows = (s) => s.db.prepare("SELECT COUNT(*) n FROM holds").get().n;
const say = (text = "Hello alerts") => ({
  model: MODEL,
  messages: [{ role: "user", content: text }],
  max_tokens: 40,
});

test("Low-Balance Alerts is registered last, off by default and gated like any update", async (t) => {
  const entry = UPDATES.find((u) => u.id === "balancealerts");
  assert.ok(entry, "balancealerts is registered");
  assert.equal(entry.title, "Low-Balance Alerts");
  assert.equal(typeof entry.tagline, "string");
  assert.equal(entry.points.length, 3);
  assert.ok(
    UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "routines"),
    "added after the releases before it",
  );
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  for (const [path, method] of [
    ["/api/balance-alert", "GET"],
    ["/api/balance-alert", "PATCH"],
    ["/API/Balance-Alert", "GET"],
    ["/api/balance-alert/", "PATCH"],
  ])
    assert.deepEqual(featuresFor({ path, method, body: {} }), ["balancealerts"], path);

  const mvp = await fixture(t, "mvp");
  const a = await person(mvp.app);
  for (const send of [
    () => a.agent.get("/api/balance-alert"),
    () => setAlert(a, { threshold: 500 }),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Low-Balance Alerts is coming soon.");
  }
  assert.equal(row(mvp, a.user.id), null, "nothing stored while refused");
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.balancealerts, false);
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(closed.paths).some((p) => p.includes("balance-alert")));
  // While unreleased and never set, the export doesn't mention it.
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.equal(Object.hasOwn(exported, "balanceAlert"), false);

  // Released on its own: the routes need nothing else.
  const own = await fixture(t, "mvp,balancealerts");
  const b = await person(own.app);
  const view = (await b.agent.get("/api/balance-alert").expect(200)).body;
  assert.deepEqual(
    { ...view, updated: null },
    {
      enabled: false,
      threshold: null,
      notify: false,
      available: 100000,
      below: false,
      suggested: SUGGESTED_CREDITS,
      min: 1,
      max: MAX_CREDITS,
      updated: null,
    },
  );
  const open = (await request(own.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(open.paths["/api/balance-alert"].get);
  assert.ok(open.paths["/api/balance-alert"].patch);
  await request(own.app).get("/api/balance-alert").expect(401);
  await request(own.app).patch("/api/balance-alert").send({ threshold: 5 }).expect(401);
});

test("the level is stored exactly as integer subcredits, and only valid levels are", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  const on = (await setAlert(a, { threshold: 500 }).expect(200)).body;
  assert.equal(on.enabled, true);
  assert.equal(on.threshold, 500);
  assert.equal(on.notify, false);
  assert.deepEqual(
    { threshold: row(s, a.user.id).threshold, kind: row(s, a.user.id).kind },
    { threshold: 5_000_000, kind: "integer" },
  );
  // Four decimals are exact; the notification choice sticks until changed.
  await setAlert(a, { threshold: 1.2345, notify: true }).expect(200);
  assert.equal(row(s, a.user.id).threshold, 12345);
  assert.equal(row(s, a.user.id).notify, 1);
  const kept = (await setAlert(a, { threshold: 250.5 }).expect(200)).body;
  assert.equal(kept.threshold, 250.5);
  assert.equal(kept.notify, true, "a field left out keeps its value");
  const quiet = (await setAlert(a, { notify: false }).expect(200)).body;
  assert.equal(quiet.threshold, 250.5);
  assert.equal(quiet.notify, false);
  await setAlert(a, { threshold: MAX_CREDITS }).expect(200);
  assert.equal(row(s, a.user.id).threshold, MAX_CREDITS * 10000);

  const before = row(s, a.user.id);
  for (const threshold of [
    0,
    0.5,
    -5,
    1.23456,
    MAX_CREDITS + 1,
    "500",
    true,
    [500],
    { credits: 500 },
    1e308,
  ]) {
    const res = await setAlert(a, { threshold }).expect(400);
    assert.equal(res.body.error.code, "invalid_threshold", JSON.stringify(threshold));
    assert.equal(res.body.error.message, THRESHOLD_RULE);
  }
  for (const notify of ["yes", 1, null])
    assert.equal(
      (await setAlert(a, { notify }).expect(400)).body.error.code,
      "invalid_notify",
    );
  for (const body of [{}, { other: 1 }])
    assert.equal(
      (await setAlert(a, body).expect(400)).body.error.code,
      "invalid_alert",
      JSON.stringify(body),
    );
  // A JSON array isn't an object body at all.
  await setAlert(a, [500]).expect(400);
  assert.deepEqual(row(s, a.user.id), before, "a refused change changes nothing");

  // Off: the row goes; notify alone can't turn it on.
  const off = (await setAlert(a, { threshold: null }).expect(200)).body;
  assert.equal(off.enabled, false);
  assert.equal(off.threshold, null);
  assert.equal(off.notify, false);
  assert.equal(row(s, a.user.id), null);
  const res = await setAlert(a, { notify: true }).expect(400);
  assert.equal(res.body.error.code, "invalid_threshold");
  assert.equal(row(s, a.user.id), null);
  // Turning it off again is harmless.
  await setAlert(a, { threshold: null }).expect(200);

  // A setting never writes the ledger or holds anything.
  assert.equal(ledgerRows(s), 1);
  assert.equal(holdRows(s), 0);

  // The database refuses anything but a positive integer level.
  for (const bad of [0, -1, 1.5, "five hundred"])
    assert.throws(
      () =>
        s.db
          .prepare("INSERT INTO balance_alerts(user_id,threshold,notify,updated) VALUES(?,?,0,?)")
          .run(a.user.id, bad, now()),
      /CHECK constraint failed/,
      String(bad),
    );
  assert.throws(() =>
    s.db
      .prepare("INSERT INTO balance_alerts(user_id,threshold,notify,updated) VALUES(?,5,2,?)")
      .run(a.user.id, now()),
  );
  assert.equal(thresholdUnits(null), null);
  assert.equal(thresholdUnits(500), 5_000_000);
});

test("below means available (balance minus open holds) under the level", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  const get = async () => (await a.agent.get("/api/balance-alert").expect(200)).body;
  // Exactly at the level is not below it.
  await setAlert(a, { threshold: 100_000 }).expect(200);
  assert.equal((await get()).below, false);
  await setAlert(a, { threshold: 99_990 }).expect(200);
  assert.equal((await get()).below, false);
  // A hold of 20 credits takes available to 99,980: below.
  reserve(s.db, { id: "open-hold", user: a.user.id, amount: units(20) });
  let v = await get();
  assert.equal(v.available, 99_980);
  assert.equal(v.below, true);
  // Released, the credits are available again.
  release(s.db, "open-hold");
  assert.equal((await get()).below, false);
  // Settled, they're gone.
  reserve(s.db, { id: "spent", user: a.user.id, amount: units(20) });
  settle(s.db, "spent", units(15));
  v = await get();
  assert.equal(v.available, 99_985);
  assert.equal(v.below, true);
  // A credited payment under reconciliation leaves nothing available.
  await setAlert(a, { threshold: 1 }).expect(200);
  assert.equal((await get()).below, false);
  s.db
    .prepare(
      "INSERT INTO deposits(id,user_id,provider_id,amount,currency,status,payload,credited,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run("d1", a.user.id, "p1", 10_000_000, "usd", "reconciliation", "{}", 1, now(), now());
  v = await get();
  assert.equal(v.available, 0);
  assert.equal(v.below, true);
  // /api/me reports the same available figure the alert compares.
  const me = (await a.agent.get("/api/me").expect(200)).body.user;
  assert.equal(me.available, v.available);
});

test("settles, transfers and contributions move the balance the alert watches", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app, "alice_alerts");
  const b = await person(s.app, "bob_alerts");
  await setAlert(a, { threshold: 99_995 }).expect(200);
  // A real chat reserves, settles and lowers available below the level.
  await a.agent.post("/api/chat").send(say()).expect(200);
  let v = (await a.agent.get("/api/balance-alert").expect(200)).body;
  assert.ok(v.available < 100_000 && v.available > 99_995, String(v.available));
  assert.equal(v.below, false);
  await a.agent
    .post("/api/credits/send")
    .send({ to: b.user.username, amount: 10, requestId: "t-1" })
    .expect(201);
  v = (await a.agent.get("/api/balance-alert").expect(200)).body;
  assert.equal(v.below, true);
  // The recipient's balance went up; its own alert is off and stays off.
  const vb = (await b.agent.get("/api/balance-alert").expect(200)).body;
  assert.equal(vb.enabled, false);
  assert.equal(vb.available, 100_010);
  // A treasury contribution spends the personal balance too.
  const collab = (await b.agent.post("/api/collabs").send({ name: "Crew" }).expect(201)).body;
  await setAlert(b, { threshold: 100_005 }).expect(200);
  const cid = collab.id || collab.collab?.id;
  await b.agent
    .post(`/api/collabs/${cid}/treasury/contribute`)
    .send({ credits: 6, idempotency_key: "c-1" })
    .expect((r) => assert.ok([200, 201].includes(r.status), r.text));
  const after = (await b.agent.get("/api/balance-alert").expect(200)).body;
  assert.equal(after.available, 100_004);
  assert.equal(after.below, true);
});

test("each account sees and changes only its own alert", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  await setAlert(a, { threshold: 700, notify: true }).expect(200);
  const vb = (await b.agent.get("/api/balance-alert").expect(200)).body;
  assert.equal(vb.enabled, false);
  assert.equal(vb.threshold, null);
  await setAlert(b, { threshold: 50 }).expect(200);
  await setAlert(b, { threshold: null }).expect(200);
  const va = (await a.agent.get("/api/balance-alert").expect(200)).body;
  assert.equal(va.threshold, 700);
  assert.equal(va.notify, true);
  // A body can't name another account.
  await setAlert(b, { threshold: 10, user_id: a.user.id }).expect(200);
  assert.equal(row(s, a.user.id).threshold, units(700));
  assert.equal(row(s, b.user.id).threshold, units(10));
});

test("export includes the setting; closing the account deletes it; Panic Wipe keeps it", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  let exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.balanceAlert, null, "released: present, null while off");
  await setAlert(a, { threshold: 321.5, notify: true }).expect(200);
  exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.balanceAlert.threshold, 321.5);
  assert.equal(exported.balanceAlert.notify, true);
  assert.equal(typeof exported.balanceAlert.updated, "number");

  // Panic Wipe erases content, keeps settings (and signs out).
  const w = await person(s.app);
  await setAlert(w, { threshold: 42 }).expect(200);
  await w.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(row(s, w.user.id).threshold, units(42));

  await a.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(row(s, a.user.id), null);
});

test("a setting left behind is exported, and does nothing, while unreleased", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-alerts-gate-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const opts = {
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: ORIGIN,
    mvpModels: [MODEL],
  };
  const on = createApp({ ...opts, released: "all" });
  await on.stopWork();
  const a = await person(on.app, "left_behind");
  await setAlert(a, { threshold: 150_000 }).expect(200);
  on.close();
  // The update switched off again: refused, still exportable, still deletable.
  const off = createApp({ ...opts, released: "mvp" });
  await off.stopWork();
  t.after(() => off.close());
  const agent = request.agent(off.app);
  await agent
    .post("/api/auth/password")
    .send({ username: "left_behind", password: "test-password-long" })
    .expect(200);
  await agent.get("/api/balance-alert").expect(403);
  const exported = (await agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.balanceAlert.threshold, 150_000);
  // Nothing else changes: chat still runs below the stored level.
  await agent.post("/api/chat").send(say()).expect(200);
  await agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(
    off.db.prepare("SELECT COUNT(*) n FROM balance_alerts").get().n,
    0,
  );
});

test("the migration adds one additive table", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-alerts-schema-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = database(join(dir, "fresh.sqlite"));
  t.after(() => db.close());
  const version = db.prepare("PRAGMA user_version").get().user_version;
  const cols = db.prepare("PRAGMA table_info(balance_alerts)").all().map((c) => c.name);
  assert.deepEqual(cols, ["user_id", "threshold", "notify", "updated"]);
  assert.ok(
    db.prepare("SELECT 1 FROM schema_additive WHERE version=?").get(version),
    "recorded as additive, so an older build can still start",
  );
});

// ---- The browser's rules (src/balance-alerts.js) ----

test("thresholds typed in the panel parse like the server validates them", () => {
  assert.equal(parseThreshold("500"), 500);
  assert.equal(parseThreshold(" 1,000 "), 1000);
  assert.equal(parseThreshold("12.3456"), 12.3456);
  for (const bad of ["", "0", "0.99", "-5", "abc", "1e3", "12.34567", "1000000001", null, undefined])
    assert.equal(parseThreshold(bad), null, String(bad));
  assert.equal(validThreshold(1), true);
  assert.equal(validThreshold(MAX_CREDITS), true);
  assert.equal(validThreshold(Number.NaN), false);
  assert.equal(validThreshold(Infinity), false);
  assert.equal(toUnits(0.0001), 1);
  assert.equal(toUnits(499.5706), 4995706);
});

test("bands: below the level, below half, below a quarter, and empty", () => {
  const L = units(500);
  assert.equal(bandOf(units(600), L), 0);
  assert.equal(bandOf(L, L), 0, "exactly at the level is not below");
  assert.equal(bandOf(L - 1, L), 1);
  assert.equal(bandOf(units(250), L), 1, "exactly half is band 1");
  assert.equal(bandOf(units(250) - 1, L), 2);
  assert.equal(bandOf(units(125), L), 2);
  assert.equal(bandOf(units(125) - 1, L), 3);
  assert.equal(bandOf(1, L), 3);
  assert.equal(bandOf(0, L), 4);
  assert.equal(bandOf(-5, L), 4);
  assert.equal(bandOf(0, null), 0, "no level, no band");
  assert.equal(bandOf(0, 0), 0);
});

test("a dismissed banner stays away for the day unless the balance drops a band", () => {
  const L = units(500);
  const noon = new Date(2026, 8, 25, 12, 0).getTime();
  const later = new Date(2026, 8, 25, 23, 59).getTime();
  const tomorrow = new Date(2026, 8, 26, 0, 1).getTime();
  let memory = cleanMemory(null);
  assert.deepEqual(memory, { dismissed: null, notified: null });
  assert.equal(bannerFor({ threshold: L, available: units(600), memory, at: noon }), null);
  assert.deepEqual(bannerFor({ threshold: L, available: units(420), memory, at: noon }), {
    band: 1,
    empty: false,
  });
  memory = dismissBanner(memory, { threshold: L, available: units(420), at: noon });
  assert.deepEqual(memory.dismissed, { threshold: L, band: 1, day: localDay(noon) });
  // Same day, same band: no nagging, whatever happens in between.
  assert.equal(bannerFor({ threshold: L, available: units(300), memory, at: later }), null);
  assert.equal(bannerFor({ threshold: L, available: units(251), memory, at: later }), null);
  // A lower band brings it back the same day.
  assert.deepEqual(bannerFor({ threshold: L, available: units(240), memory, at: later }), {
    band: 2,
    empty: false,
  });
  assert.deepEqual(bannerFor({ threshold: L, available: 0, memory, at: later }), {
    band: 4,
    empty: true,
  });
  // A new day brings it back in the same band.
  assert.deepEqual(bannerFor({ threshold: L, available: units(420), memory, at: tomorrow }), {
    band: 1,
    empty: false,
  });
  // A different level is a different alert.
  assert.ok(bannerFor({ threshold: units(450), available: units(420), memory, at: later }));
  // Dismissed in band 2, band 1 stays hidden (the balance only went up).
  const deep = dismissBanner(cleanMemory(null), { threshold: L, available: units(200), at: noon });
  assert.equal(bannerFor({ threshold: L, available: units(400), memory: deep, at: later }), null);
  // A top-up back to the level forgets the dismissal, so the next drop shows it.
  const topped = observe(memory, { threshold: L, available: L });
  assert.deepEqual(topped, { dismissed: null, notified: null });
  assert.ok(bannerFor({ threshold: L, available: units(499), memory: topped, at: later }));
  // Below the level, observing keeps what it remembers.
  assert.deepEqual(observe(memory, { threshold: L, available: units(100) }), memory);
  // Junk in storage is ignored.
  assert.deepEqual(cleanMemory({ dismissed: { band: "x" }, notified: 5 }), {
    dismissed: null,
    notified: null,
  });
  assert.equal(localDay(new Date(2026, 0, 5, 9).getTime()), "2026-01-05");
});

test("one notification, only on a crossing seen in this tab, only after opt-in and permission", () => {
  const L = units(500);
  const base = {
    previous: units(510),
    available: units(490),
    threshold: L,
    notify: true,
    permission: "granted",
    memory: cleanMemory(null),
  };
  assert.equal(shouldNotify(base), true);
  // Not without opting in, or without permission.
  assert.equal(shouldNotify({ ...base, notify: false }), false);
  for (const permission of ["default", "denied", "unsupported"])
    assert.equal(shouldNotify({ ...base, permission }), false, permission);
  // Not on page load (nothing seen before), and not without a crossing.
  assert.equal(shouldNotify({ ...base, previous: null }), false);
  assert.equal(shouldNotify({ ...base, previous: units(495) }), false, "already below");
  assert.equal(shouldNotify({ ...base, available: L }), false, "at the level isn't below");
  assert.equal(shouldNotify({ ...base, previous: L }), true, "from exactly the level");
  // Not twice: another tab (shared memory) or a later drop.
  const told = notifiedMemory(base.memory, L);
  assert.equal(shouldNotify({ ...base, memory: told }), false);
  assert.equal(
    shouldNotify({ ...base, previous: units(300), available: units(100), memory: told }),
    false,
  );
  // Back above the level re-arms it.
  const rearmed = observe(told, { threshold: L, available: units(600) });
  assert.equal(shouldNotify({ ...base, memory: rearmed }), true);
  // Raising the level over an unchanged balance isn't a crossing.
  assert.equal(
    shouldNotify({ ...base, previous: units(490), available: units(490), threshold: units(600) }),
    false,
  );
  // Off (no level): never.
  assert.equal(shouldNotify({ ...base, threshold: null }), false);
  const text = notificationText({ available: 499.5706, threshold: 500 });
  assert.equal(text.title, "Low balance on ANONYMA");
  assert.equal(text.body, "499.57 credits available, below your alert at 500 credits.");
  assert.equal(
    notificationText({ available: 0, threshold: 500 }).body,
    "No credits available. Top up to keep going.",
  );
  assert.equal(showCredits(1234.567), (1234.56).toLocaleString(undefined, { maximumFractionDigits: 2 }));
  assert.equal(showCredits(-3), "0");
});

test("the Top up link follows balance refusals, never spending-limit ones", async (t) => {
  const s = await fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  // Send everything away, then a chat can't be covered.
  await a.agent
    .post("/api/credits/send")
    .send({ to: b.user.username, amount: 100_000, requestId: "drain" })
    .expect(201);
  const chat = await a.agent.post("/api/chat").send(say()).expect(402);
  assert.equal(chat.body.error.code, "insufficient_credits");
  assert.equal(isInsufficientMessage(chat.body.error.message), true);
  const sendMore = await a.agent
    .post("/api/credits/send")
    .send({ to: b.user.username, amount: 5, requestId: "too-much" })
    .expect(402);
  assert.equal(isInsufficientMessage(sendMore.body.error.message), true);
  // A spending-limit refusal is a different thing.
  await b.agent.patch("/api/spending-limits").send({ daily_limit: 0 }).expect(200);
  const limited = await b.agent.post("/api/chat").send(say()).expect(402);
  assert.equal(limited.body.error.code, "spending_limit");
  assert.equal(isInsufficientMessage(limited.body.error.message), false);
  assert.equal(isInsufficientMessage("The team treasury doesn't have enough credits for this request."), false);
  assert.equal(isInsufficientMessage(""), false);
  assert.equal(isInsufficientMessage(undefined), false);
  assert.equal(
    isInsufficientMessage(
      "Not enough credits right now: the other answers are holding credits while they run. Add credits or compare fewer models.",
    ),
    true,
    "Symposium's own wording",
  );
});

// ---- The browser components, rendered with the esbuild Vite uses ----
async function uiModule() {
  const src = new URL("../src/BalanceAlerts.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-alerts-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Icon = () => null;
     export const Button = ({ children, secondary, ...p }) => React.createElement("button", p, children);
     export const Notice = ({ children }) => React.createElement("div", { className: "notice" }, children);`,
  );
  const router = stub(
    "router.mjs",
    `export const Link = ({ children, to, ...p }) => React.createElement("a", { href: to, ...p }, children);`,
  );
  const out = code
    .replace(/^import "\.\/balance-alerts\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "\.\/lib\.js"/g, `from "${new URL("../src/lib.js", import.meta.url)}"`)
    .replace(/from "\.\/i18n\.js"/g, `from "${new URL("../src/i18n.js", import.meta.url)}"`)
    .replace(
      /from "\.\/balance-alerts\.js"/g,
      `from "${new URL("../src/balance-alerts.js", import.meta.url)}"`,
    )
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "BalanceAlerts.mjs");
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
const textsOf = (html) =>
  [
    ...html.split(/<[^>]+>/),
    ...[...html.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)].map((m) => m[1]),
  ]
    .map((s) => entities(s).trim())
    .filter((s) => /[A-Za-z]{2}/.test(s));
const released = { releases: { features: { balancealerts: true } } };

test("the banner, the refusal link and the panel render, and hide while unreleased", async () => {
  const { LowBalanceNotice, LowBalanceRefusal, LowBalanceBanner, BalanceAlertSettings } =
    await uiModule();
  const low = renderToStaticMarkup(
    createElement(LowBalanceNotice, { available: 420, threshold: 500, held: 12.5, onDismiss: () => {} }),
  );
  assert.match(low, /Low balance\./);
  assert.match(low, /420 credits available, below your alert at 500 credits\./);
  assert.match(low, /12\.5 more are on hold for requests in progress\./);
  assert.match(low, /href="\/account\/credits"[^>]*>Top up</);
  assert.match(low, /href="\/account\/credits#balance-alert"/);
  assert.match(low, /aria-label="Dismiss the low-balance warning"/);
  assert.match(low, /role="status"/);
  const empty = renderToStaticMarkup(
    createElement(LowBalanceNotice, { empty: true, available: 0, threshold: 500, held: 0 }),
  );
  assert.match(empty, /Out of credits\./);
  assert.match(empty, /No credits available\. Top up to keep going\./);
  assert.doesNotMatch(empty, /on hold/);

  const refusal = (config, error, demo = false) =>
    renderToStaticMarkup(
      createElement(LowBalanceRefusal, { config, user: { available: 0.5 }, demo, error }),
    );
  const msg = "Not enough credits for this request. Add credits or reduce the output limit.";
  assert.match(refusal(released, msg), /0\.5 credits available\..*Top up/);
  assert.equal(refusal({ releases: { features: {} } }, msg), "", "unreleased: nothing");
  assert.equal(refusal(released, "You've reached your daily spending limit of 5 credits."), "");
  assert.match(refusal(released, msg, true), /href="\/account\/credits\?demo=1"/);

  // The banner needs the release, a signed-in account and its fetched setting.
  assert.equal(
    renderToStaticMarkup(createElement(LowBalanceBanner, { config: {}, user: { id: "u", available: 1 } })),
    "",
  );
  assert.equal(
    renderToStaticMarkup(createElement(LowBalanceBanner, { config: released, user: null })),
    "",
  );
  const panel = renderToStaticMarkup(
    createElement(BalanceAlertSettings, { config: released, user: null, demo: true }),
  );
  assert.match(panel, /id="balance-alert"/);
  assert.match(panel, /Warn me when my available balance drops below/);
  assert.match(panel, /value="500"/);
  assert.match(panel, /About \$0\.50\./);
});

test("every word the alert shows has a Chinese translation", async () => {
  const dict = compileDictionary(
    JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")),
  );
  const han = /\p{Script=Han}/u;
  const { LowBalanceNotice, LowBalanceRefusal, BalanceAlertSettings } = await uiModule();
  const html = [
    renderToStaticMarkup(createElement(BalanceAlertSettings, { config: released, demo: true })),
    renderToStaticMarkup(
      createElement(LowBalanceNotice, { available: 1234.5, threshold: 2000, held: 3, onDismiss: () => {} }),
    ),
    renderToStaticMarkup(createElement(LowBalanceNotice, { empty: true, available: 0, threshold: 500 })),
    renderToStaticMarkup(
      createElement(LowBalanceRefusal, {
        config: released,
        user: { available: 12 },
        error: "Not enough credits for this request.",
      }),
    ),
  ].join("");
  const texts = textsOf(html);
  assert.ok(texts.includes("Low-balance alert"));
  assert.ok(texts.includes("Out of credits."));
  for (const text of texts)
    assert.match(translateText(text, dict) ?? "", han, `untranslated: ${text}`);
  const entry = UPDATES.find((u) => u.id === "balancealerts");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Low-Balance Alerts is coming soon.",
    THRESHOLD_RULE,
    "Set an alert level to turn the alert on.",
    "This browser will show the notification.",
    "Notifications are blocked for this site. Allow them in your browser's site settings to get one.",
    "Your browser will ask for permission when you tick this box.",
    "This browser can't show notifications. The workspace banner still works.",
    "Allow in this browser",
    "Loading your alert…",
    "Saving…",
    "Alert on: you'll be warned below 750 credits.",
    "Alert off. No low-balance warnings will show.",
    "Now: 420.5 credits available, below your alert.",
    "Now: 1,000 credits available, above your alert.",
    "We suggest 500 credits: one long reply from a large model can hold over 100.",
    "Low-balance alert below 500 credits",
    "Change",
    "Low balance on ANONYMA",
    notificationText({ available: 499.57, threshold: 500 }).body,
    notificationText({ available: 0, threshold: 500 }).body,
    "Low-balance alerts: your alert level and whether you asked for browser notifications. Whether you dismissed the banner is kept only in this browser. Closing your account deletes the setting; Panic Wipe keeps it with your other settings.",
    "The export also includes your low-balance alert setting.",
  ])
    assert.match(translateText(text, dict) ?? "", han, `untranslated: ${text}`);
  // Numbers survive translation.
  assert.match(
    translateText("1,234.5 credits available, below your alert at 2,000 credits.", dict),
    /1,234\.5.*2,000/,
  );
});

test("the dashboard, Account page, workspace and data controls wire the alert in", () => {
  const read = (f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  const workspace = read("Workspace.jsx");
  assert.match(workspace, /<LowBalanceBanner config=\{config\} user=\{user\} demo=\{demo\} \/>/);
  assert.match(workspace, /<LowBalanceRefusal config=\{config\} user=\{user\} demo=\{demo\} error=\{error\} \/>/);
  for (const f of ["Symposium.jsx", "AudioStudio.jsx"])
    assert.match(read(f), /<LowBalanceRefusal /, f);
  const account = read("Account.jsx");
  assert.match(account, /alertsLive && \(demo \|\| user\) && \(\s*<BalanceAlertSettings/);
  assert.match(account, /alertsLive && <BalanceAlertWatch /);
  assert.match(read("WorkspaceHome.jsx"), /Low-balance alert below \$\{showCredits\(alertLevel\)\} credits/);
  assert.match(read("DataControls.jsx"), /isReleased\(config, "balancealerts"\)/);
  // No new polling: the watch reads the balance the app already refreshes.
  const ui = read("BalanceAlerts.jsx");
  assert.doesNotMatch(ui, /setInterval|setTimeout\(/);
  // The permission prompt only comes from a click handler.
  assert.equal((ui.match(/requestPermission\(/g) || []).length, 1);
  assert.match(ui, /askPermission\(\)/);
  assert.doesNotMatch(ui, /serviceWorker|PushManager|showNotification/);
  // The server module and the shared rules ship in the production image.
  assert.match(
    readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"),
    /src\/balance-alerts\.js/,
  );
});
