import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { addCredit, balance, reserve, settle, uid, now } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { replyBudgetFor } from "../server/routines.js";
import { knownPage } from "../src/site-routes.js";
import { MODE_FEATURES, modeReleased } from "../src/lib.js";
import {
  MAX_ROUTINES,
  KEEP_RUNS,
  canonicalZone,
  describeSchedule,
  latestRunAtOrBefore,
  monthWindow,
  nextRunAfter,
  runsBetween,
  wallClock,
  zonedTime,
} from "../src/routines.js";
import { compileDictionary, translateText } from "../src/i18n.js";

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
const ORIGIN = "http://localhost:5175";
const units = (credits) => Math.round(credits * 10000);
const iso = (t) => new Date(t).toISOString();
const utc = (s) => Date.parse(s);

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-routines-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: ORIGIN,
    released: released ?? "all",
    mvpModels: [MODEL, PRIVATE],
    privateModels: [PRIVATE],
    ...extra,
  });
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
// A controllable clock for core.now() and everything else on Date.now.
function clock(t, start) {
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
const body = (extra = {}) => ({
  name: "Morning AI news",
  prompt: "Summarise the top AI news in 5 bullets.",
  model: MODEL,
  schedule: { repeat: "weekdays", time: "08:00", timezone: "UTC" },
  per_run_credits: 50,
  monthly_budget_credits: 500,
  ...extra,
});
const create = async (p, extra) =>
  (await p.agent.post("/api/routines").send(body(extra)).expect(201)).body;
const runs = (s, routine) =>
  s.db
    .prepare(
      "SELECT * FROM routine_runs WHERE routine_id=? ORDER BY started,rowid",
    )
    .all(routine);
const holdsFor = (s, user, routine) =>
  s.db
    .prepare("SELECT * FROM holds WHERE id LIKE ?")
    .all(`${user}:routine_${routine}_%`);
const inbox = async (p, query = "") =>
  (await p.agent.get("/api/routines/runs" + query).expect(200)).body.runs;
const view = async (p, id) =>
  (await p.agent.get("/api/routines").expect(200)).body.routines.find(
    (r) => r.id === id,
  );

test("Routines is registered, unreleased and gated like any update", async (t) => {
  const entry = UPDATES.find((u) => u.id === "routines");
  assert.ok(entry, "routines is registered");
  assert.equal(entry.title, "Routines");
  assert.equal(entry.tagline, "Your prompts, on a schedule, on a budget.");
  assert.equal(entry.points.length, 3);
  assert.equal(
    committed[UPDATES.indexOf(entry)],
    false,
    "waits for its release commit",
  );
  const gate = (path, method = "GET", b = {}) =>
    featuresFor({ path, method, body: b });
  assert.deepEqual(gate("/api/routines"), ["routines"]);
  assert.deepEqual(gate("/api/routines/runs"), ["routines"]);
  assert.deepEqual(gate("/API/Routines/RUNS"), ["routines"]);
  assert.deepEqual(gate("/api/routines/rt_1", "DELETE"), ["routines"]);
  assert.deepEqual(gate("/api/routines", "POST", { web_search: true }), [
    "routines",
    "search",
  ]);
  assert.deepEqual(gate("/api/routines/rt_1", "PATCH", { private_only: true }), [
    "routines",
    "private",
  ]);
  assert.deepEqual(
    gate("/api/routines", "POST", { web_search: true, private_only: true }),
    ["routines", "search", "private"],
  );
  // Turning them off needs nothing extra.
  assert.deepEqual(
    gate("/api/routines/rt_1", "PATCH", { web_search: false, private_only: false }),
    ["routines"],
  );
  // The workspace page is a known address, showing "coming soon" until then.
  assert.equal(knownPage("/workspace/routines"), true);
  assert.equal(MODE_FEATURES.routines, "routines");
  assert.equal(modeReleased({ releases: { features: {} } }, "routines"), false);
  assert.equal(
    modeReleased({ releases: { features: { routines: true } } }, "routines"),
    true,
  );

  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app);
  for (const send of [
    () => a.agent.get("/api/routines"),
    () => a.agent.post("/api/routines").send(body()),
    () => a.agent.patch("/api/routines/rt_x").send({ enabled: false }),
    () => a.agent.delete("/api/routines/rt_x"),
    () => a.agent.get("/api/routines/runs"),
    () => a.agent.delete("/api/routines/runs/rr_x"),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Routines is coming soon.");
  }
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.routines, false);
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200))
    .body;
  assert.ok(!Object.keys(closed.paths).some((p) => p.includes("routines")));
  // A routine left behind (say, the update was switched off again) never
  // runs while it's unreleased.
  mvp.db
    .prepare(
      "INSERT INTO routines(id,user_id,name,prompt,model,repeat,minute,timezone,run_cap,monthly_budget,enabled,next_run,created,updated) VALUES('rt_left',?,'Left','Hello',?,'daily',0,'UTC',?,?,1,?,?,?)",
    )
    .run(a.user.id, MODEL, units(50), units(500), now() - 60000, now(), now());
  await mvp.tick();
  assert.equal(runs(mvp, "rt_left").length, 0);
  assert.equal(holdsFor(mvp, a.user.id, "rt_left").length, 0);

  // Released on its own, a plain routine needs nothing else; web search and
  // Private models only need their own updates.
  const own = fixture(t, "mvp,routines");
  const b = await person(own.app);
  const made = await create(b);
  assert.equal(made.web_search, false);
  assert.equal(made.private_only, false);
  for (const [extra, title] of [
    [{ web_search: true }, "Live Web Search"],
    [{ private_only: true, model: PRIVATE }, "Private Mode"],
  ]) {
    const res = await b.agent.post("/api/routines").send(body(extra)).expect(403);
    assert.equal(res.body.error.message, `${title} is coming soon.`);
  }
  await b.agent
    .patch("/api/routines/" + made.id)
    .send({ web_search: true })
    .expect(403);
  const open = (await request(own.app).get("/api/openapi.json").expect(200))
    .body;
  assert.ok(open.paths["/api/routines"].get);
  assert.ok(open.paths["/api/routines"].post);
  assert.ok(open.paths["/api/routines/{id}"].patch);
  assert.ok(open.paths["/api/routines/{id}"].delete);
  assert.ok(open.paths["/api/routines/runs"].get);
  assert.ok(open.paths["/api/routines/runs/{id}"].delete);
  await request(own.app).get("/api/routines").expect(401);
});

test("schedule math: time zones, weekdays and daylight saving", () => {
  const every = (schedule, from, n) => {
    const out = [];
    for (let t = from, i = 0; i < n; i++) out.push(iso((t = nextRunAfter(schedule, t))));
    return out;
  };
  // Weekdays in UTC: Friday after 08:00 goes to Monday.
  const weekdays = { repeat: "weekdays", minute: 480, timezone: "UTC" };
  assert.deepEqual(every(weekdays, utc("2026-09-25T09:00:00Z"), 3), [
    "2026-09-28T08:00:00.000Z",
    "2026-09-29T08:00:00.000Z",
    "2026-09-30T08:00:00.000Z",
  ]);
  // Exactly at a slot, the next one is the following slot.
  assert.equal(
    iso(nextRunAfter(weekdays, utc("2026-09-28T08:00:00Z"))),
    "2026-09-29T08:00:00.000Z",
  );
  // Days count in the routine's zone: Monday 07:00 in Auckland is Sunday in
  // UTC, and Saturday 07:00 there (Friday in UTC) never runs.
  const auckland = { repeat: "weekdays", minute: 420, timezone: "Pacific/Auckland" };
  const nz = every(auckland, utc("2026-09-25T12:00:00Z"), 2);
  assert.deepEqual(nz, ["2026-09-27T18:00:00.000Z", "2026-09-28T18:00:00.000Z"]);
  assert.equal(new Date(nz[0]).getUTCDay(), 0, "Sunday in UTC");
  assert.equal(
    wallClock("Pacific/Auckland", Date.parse(nz[0])).day,
    28,
    "Monday the 28th in Auckland",
  );
  // Weekly, Monday 01:00 in Tokyo = Sunday 16:00 UTC.
  const tokyo = { repeat: "weekly", day: 1, minute: 60, timezone: "Asia/Tokyo" };
  assert.deepEqual(every(tokyo, utc("2026-09-25T00:00:00Z"), 2), [
    "2026-09-27T16:00:00.000Z",
    "2026-10-04T16:00:00.000Z",
  ]);
  // New York springs forward at 02:00 on 8 March 2026: a 02:30 routine runs
  // at 03:30 that day (as far past the jump), then 02:30 again.
  const nyGap = { repeat: "daily", minute: 150, timezone: "America/New_York" };
  const spring = every(nyGap, utc("2026-03-07T00:00:00Z"), 3);
  assert.deepEqual(spring, [
    "2026-03-07T07:30:00.000Z",
    "2026-03-08T07:30:00.000Z",
    "2026-03-09T06:30:00.000Z",
  ]);
  assert.deepEqual(
    spring.map((s) => {
      const w = wallClock("America/New_York", Date.parse(s));
      return `${w.hour}:${w.minute}`;
    }),
    ["2:30", "3:30", "2:30"],
  );
  // It falls back at 02:00 on 1 November: 01:30 happens twice and runs once,
  // the first time (EDT), and the next day at 01:30 EST.
  const nyOverlap = { repeat: "daily", minute: 90, timezone: "America/New_York" };
  assert.deepEqual(every(nyOverlap, utc("2026-10-31T00:00:00Z"), 3), [
    "2026-10-31T05:30:00.000Z",
    "2026-11-01T05:30:00.000Z",
    "2026-11-02T06:30:00.000Z",
  ]);
  assert.equal(
    iso(nextRunAfter(nyOverlap, utc("2026-11-01T05:30:00Z"))),
    "2026-11-02T06:30:00.000Z",
    "not again at the repeated 01:30",
  );
  // London leaves summer time on 25 October 2026; 08:00 stays 08:00 local.
  const london = { repeat: "daily", minute: 480, timezone: "Europe/London" };
  assert.deepEqual(every(london, utc("2026-10-24T00:00:00Z"), 2), [
    "2026-10-24T07:00:00.000Z",
    "2026-10-25T08:00:00.000Z",
  ]);
  // Sydney starts summer time on 4 October 2026 (southern hemisphere).
  const sydney = { repeat: "daily", minute: 540, timezone: "Australia/Sydney" };
  assert.deepEqual(every(sydney, utc("2026-10-02T12:00:00Z"), 2), [
    "2026-10-02T23:00:00.000Z",
    "2026-10-03T22:00:00.000Z",
  ]);
  // Lord Howe moves by half an hour: 02:15 is skipped and runs at 02:45.
  assert.equal(
    iso(zonedTime("Australia/Lord_Howe", 2026, 10, 4, 135)),
    "2026-10-03T15:45:00.000Z",
  );
  // Catch-up helpers: the latest slot at or before a time, and the slots
  // skipped since the one that was due.
  assert.equal(
    iso(latestRunAtOrBefore(weekdays, utc("2026-09-28T07:59:00Z"))),
    "2026-09-25T08:00:00.000Z",
  );
  assert.equal(
    runsBetween(weekdays, utc("2026-09-21T08:00:00Z"), utc("2026-09-28T08:00:00Z")),
    5,
  );
  // The monthly budget's month is the routine's own.
  const oct = monthWindow("Asia/Tokyo", utc("2026-09-30T16:00:00Z"));
  assert.equal(iso(oct.start), "2026-09-30T15:00:00.000Z");
  assert.equal(iso(oct.end), "2026-10-31T15:00:00.000Z");
  assert.equal(canonicalZone("utc"), "UTC");
  assert.equal(canonicalZone("europe/london"), "Europe/London");
  assert.equal(canonicalZone("Mars/Olympus_Mons"), null);
  assert.equal(canonicalZone("../../etc"), null);
  assert.equal(describeSchedule(weekdays), "Weekdays at 08:00");
  assert.equal(describeSchedule(tokyo), "Every Monday at 01:00");
  assert.equal(describeSchedule(nyGap), "Every day at 02:30");
});

test("saving routines: validation, the ten-routine limit, on and off", async (t) => {
  const c = clock(t, utc("2026-09-25T07:59:00Z"));
  const s = fixture(t);
  const p = await person(s.app);
  const made = await create(p);
  assert.equal(made.name, "Morning AI news");
  assert.deepEqual(made.schedule, { repeat: "weekdays", time: "08:00", timezone: "UTC" });
  assert.equal(made.per_run_credits, 50);
  assert.equal(made.monthly_budget_credits, 500);
  assert.equal(made.enabled, true);
  assert.equal(made.running, false);
  assert.equal(made.next_run_at, utc("2026-09-25T08:00:00Z"));
  assert.deepEqual(made.month, { spent: 0, held: 0, remaining: 500, resets_at: utc("2026-10-01T00:00:00Z") });
  // The zone is stored in its canonical form.
  const zoned = await create(p, {
    schedule: { repeat: "weekly", day: 1, time: "09:30", timezone: "europe/london" },
  });
  assert.deepEqual(zoned.schedule, { repeat: "weekly", time: "09:30", day: 1, timezone: "Europe/London" });
  assert.equal(zoned.next_run_at, utc("2026-09-28T08:30:00Z"));

  for (const [extra, code] of [
    [{ name: "" }, "invalid_routine"],
    [{ name: "x".repeat(81) }, "invalid_routine"],
    [{ prompt: "   " }, "invalid_routine"],
    [{ prompt: "x".repeat(8001) }, "invalid_routine"],
    [{ model: "nobody/nothing" }, "invalid_model"],
    [{ model: "google/gemini-2.5-flash-image" }, "invalid_model"],
    [{ model: MODEL, private_only: true }, "private_model_required"],
    [{ web_search: "yes" }, "invalid_routine"],
    [{ schedule: { repeat: "hourly", time: "08:00" } }, "invalid_schedule"],
    [{ schedule: { repeat: "daily", time: "24:00" } }, "invalid_schedule"],
    [{ schedule: { repeat: "daily", time: "8:00" } }, "invalid_schedule"],
    [{ schedule: { repeat: "weekly", time: "08:00" } }, "invalid_schedule"],
    [{ schedule: { repeat: "weekly", time: "08:00", day: 7 } }, "invalid_schedule"],
    [{ schedule: { repeat: "daily", time: "08:00", timezone: "Mars/Base" } }, "invalid_schedule"],
    [{ per_run_credits: 0 }, "invalid_routine"],
    [{ per_run_credits: 1.00001 }, "invalid_routine"],
    [{ per_run_credits: 100001, monthly_budget_credits: 200000 }, "invalid_routine"],
    [{ per_run_credits: 60, monthly_budget_credits: 50 }, "invalid_routine"],
    [{ monthly_budget_credits: "500" }, "invalid_routine"],
  ]) {
    const res = await p.agent.post("/api/routines").send(body(extra)).expect(400);
    assert.equal(res.body.error.code, code, JSON.stringify(extra));
  }
  const missing = { ...body() };
  delete missing.schedule;
  await p.agent.post("/api/routines").send(missing).expect(400);

  // Switching off clears the next run; switching on picks the next slot
  // after now, never one that has passed. Other changes keep the schedule.
  const off = (await p.agent.patch("/api/routines/" + made.id).send({ enabled: false }).expect(200)).body;
  assert.equal(off.enabled, false);
  assert.equal(off.next_run_at, null);
  c.set(utc("2026-09-25T09:00:00Z"));
  const on = (await p.agent.patch("/api/routines/" + made.id).send({ enabled: true }).expect(200)).body;
  assert.equal(on.next_run_at, utc("2026-09-28T08:00:00Z"));
  const renamed = (await p.agent.patch("/api/routines/" + made.id).send({ name: "  AI news  " }).expect(200)).body;
  assert.equal(renamed.name, "AI news");
  assert.equal(renamed.next_run_at, on.next_run_at);
  const moved = (
    await p.agent
      .patch("/api/routines/" + made.id)
      .send({ schedule: { repeat: "daily", time: "10:00", timezone: "UTC" } })
      .expect(200)
  ).body;
  assert.equal(moved.next_run_at, utc("2026-09-25T10:00:00Z"));
  await p.agent.patch("/api/routines/" + made.id).send({ per_run_credits: 600 }).expect(400);
  const privateOn = await p.agent.patch("/api/routines/" + made.id).send({ private_only: true }).expect(400);
  assert.equal(privateOn.body.error.code, "private_model_required");
  const privateModel = (
    await p.agent.patch("/api/routines/" + made.id).send({ private_only: true, model: PRIVATE }).expect(200)
  ).body;
  assert.equal(privateModel.private_only, true);

  // Someone else's routine is not found.
  const q = await person(s.app);
  await q.agent.patch("/api/routines/" + made.id).send({ enabled: false }).expect(404);
  await q.agent.delete("/api/routines/" + made.id).expect(404);
  await q.agent.get("/api/routines/runs?routine=" + made.id).expect(404);
  assert.deepEqual((await q.agent.get("/api/routines").expect(200)).body.routines, []);

  // Ten per account, checked on the server and in the schema.
  for (let i = 2; i < MAX_ROUTINES; i++) await create(p, { name: "Routine " + i });
  const full = await p.agent.post("/api/routines").send(body()).expect(409);
  assert.equal(full.body.error.code, "routine_limit");
  assert.throws(
    () =>
      s.db
        .prepare(
          "INSERT INTO routines(id,user_id,name,prompt,model,repeat,minute,timezone,run_cap,monthly_budget,created,updated) VALUES('rt_extra',?,'x','x',?,'daily',0,'UTC',1,1,0,0)",
        )
        .run(p.user.id, MODEL),
    /routine_limit/,
  );
  const list = (await p.agent.get("/api/routines").expect(200)).body;
  assert.equal(list.routines.length, MAX_ROUTINES);
  assert.equal(list.max_routines, 10);
  assert.equal(list.keep_runs, KEEP_RUNS);
  await p.agent.delete("/api/routines/" + zoned.id).expect(200);
  await create(p, { name: "Room again" });
});

test("rate limits: reads per minute and changes per hour", async (t) => {
  const s = fixture(t);
  const p = await person(s.app);
  const made = await create(p);
  for (let i = 0; i < 119; i++)
    await p.agent.patch("/api/routines/" + made.id).send({ enabled: i % 2 === 0 }).expect(200);
  await p.agent.patch("/api/routines/" + made.id).send({ enabled: true }).expect(429);
  for (let i = 0; i < 120; i++) await p.agent.get("/api/routines/runs").expect(200);
  await p.agent.get("/api/routines").expect(429);
});

test("a due routine runs once, on the chat hold and settle path, and lands in the inbox", async (t) => {
  const c = clock(t, utc("2026-09-25T07:59:00Z")); // a Friday
  const s = fixture(t);
  const p = await person(s.app);
  const before = balance(s.db, p.user.id).available;
  const made = await create(p);
  // Not due yet: nothing happens.
  await s.tick();
  assert.equal(runs(s, made.id).length, 0);

  c.set(utc("2026-09-25T08:00:30Z"));
  await s.tick();
  await s.tick();
  const done = runs(s, made.id);
  assert.equal(done.length, 1, "exactly one run");
  const [run] = await inbox(p);
  assert.equal(run.status, "done");
  assert.equal(run.routine_id, made.id);
  assert.equal(run.routine_name, "Morning AI news");
  assert.equal(run.scheduled_for, utc("2026-09-25T08:00:00Z"));
  assert.equal(run.skipped, 0);
  assert.equal(run.model, MODEL);
  assert.match(run.answer, /Local test provider/);
  assert.match(run.answer, /Summarise the top AI news in 5 bullets\./);
  assert.equal(run.request_id, `routine_${made.id}_${utc("2026-09-25T08:00:00Z")}`);
  assert.ok(run.credits_charged > 0);
  assert.equal(run.reply_budget, 4096);
  assert.equal(run.finish_reason, "stop");
  assert.equal(run.code, null);

  // Charged once, settled, on the ledger, never beyond the per-run maximum.
  const hold = s.db
    .prepare("SELECT * FROM holds WHERE id=?")
    .get(`${p.user.id}:${run.request_id}`);
  assert.equal(hold.status, "settled");
  assert.ok(hold.amount <= units(50), "held within the per-run maximum");
  assert.equal(hold.key_id, null);
  const ledger = s.db
    .prepare("SELECT * FROM ledger WHERE ref=?")
    .get(hold.id);
  assert.equal(-ledger.amount, units(run.credits_charged));
  const afterRun = balance(s.db, p.user.id);
  assert.equal(before - afterRun.available, -ledger.amount);
  assert.equal(afterRun.held, 0);

  // The signed receipt verifies, answer included, and is stored like chat's.
  assert.equal(run.signed_receipt.receipt.id, run.request_id);
  assert.equal(run.signed_receipt.receipt.credits_charged, run.credits_charged);
  const verified = (
    await request(s.app)
      .post("/api/receipts/verify")
      .send({ receipt: run.signed_receipt.receipt, signature: run.signed_receipt.signature, answer: run.answer })
      .expect(200)
  ).body;
  assert.equal(verified.valid, true);
  assert.equal(verified.answer_matches, true);
  await p.agent.get("/api/receipts/" + run.request_id).expect(200);

  // Month to date, and the next weekday slot (Monday).
  const v = await view(p, made.id);
  assert.equal(v.month.spent, run.credits_charged);
  assert.equal(v.month.held, 0);
  assert.equal(v.last_status, "done");
  assert.equal(v.last_run_at, utc("2026-09-25T08:00:00Z"));
  assert.equal(v.next_run_at, utc("2026-09-28T08:00:00Z"));
  // The weekend passes without a run; Monday runs once more.
  c.set(utc("2026-09-27T12:00:00Z"));
  await s.tick();
  assert.equal(runs(s, made.id).length, 1);
  c.set(utc("2026-09-28T08:01:00Z"));
  await s.tick();
  assert.equal(runs(s, made.id).length, 2);
  const [latest, first] = await inbox(p);
  assert.equal(latest.scheduled_for, utc("2026-09-28T08:00:00Z"));
  assert.equal(first.id, run.id);
  assert.equal((await inbox(p, "?routine=" + made.id)).length, 2);
  assert.deepEqual(
    (await inbox(p, "?before=" + latest.started_at)).map((r) => r.id),
    [run.id],
  );
  // A run can be deleted from the inbox; its charge and receipt stay.
  await p.agent.delete("/api/routines/runs/" + run.id).expect(200);
  assert.equal((await inbox(p)).length, 1);
  assert.ok(s.db.prepare("SELECT 1 FROM ledger WHERE ref=?").get(hold.id));
  await p.agent.delete("/api/routines/runs/" + run.id).expect(404);
});

test("the balance, spending limits, monthly budget and per-run maximum refuse runs before anything is held", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const s = fixture(t);
  const due = async () => {
    c.advance(86400000);
    await s.tick();
  };
  const daily = { schedule: { repeat: "daily", time: "08:00", timezone: "UTC" } };
  const lastRun = (id) => runs(s, id).at(-1);

  // A per-run maximum too small for even a short reply.
  const a = await person(s.app);
  const tiny = await create(a, { ...daily, per_run_credits: 0.01, monthly_budget_credits: 500 });
  const startA = balance(s.db, a.user.id).available;
  await due();
  let r = lastRun(tiny.id);
  assert.equal(r.status, "refused");
  assert.equal(r.code, "routine_run_cap");
  assert.equal(r.charged, 0);
  assert.equal(holdsFor(s, a.user.id, tiny.id).length, 0, "nothing reserved");
  assert.equal(balance(s.db, a.user.id).available, startA);

  // A per-run maximum between the estimate and the usual 4x headroom holds
  // just the estimate; a smaller one shortens the reply budget instead.
  await a.agent.patch("/api/routines/" + tiny.id).send({ per_run_credits: 10 }).expect(200);
  await due();
  r = lastRun(tiny.id);
  assert.equal(r.status, "done");
  assert.equal(r.reply_budget, 4096);
  const held = holdsFor(s, a.user.id, tiny.id).at(-1);
  assert.ok(held.amount <= units(10), "held within the per-run maximum");
  await a.agent.patch("/api/routines/" + tiny.id).send({ per_run_credits: 2 }).expect(200);
  await due();
  r = lastRun(tiny.id);
  assert.equal(r.status, "done");
  assert.ok(r.reply_budget >= 256 && r.reply_budget < 4096, String(r.reply_budget));
  assert.ok(holdsFor(s, a.user.id, tiny.id).at(-1).amount <= units(2));

  // The monthly budget: what's left this month can't cover a run.
  const b = await person(s.app);
  const budgeted = await create(b, { ...daily, per_run_credits: 20, monthly_budget_credits: 20 });
  const spent = `${b.user.id}:routine_${budgeted.id}_1`;
  reserve(s.db, { id: spent, user: b.user.id, amount: units(19.99) });
  settle(s.db, spent, units(19.99));
  assert.equal((await view(b, budgeted.id)).month.spent, 19.99);
  await due();
  r = lastRun(budgeted.id);
  assert.equal(r.status, "refused");
  assert.equal(r.code, "routine_budget");
  assert.equal(holdsFor(s, b.user.id, budgeted.id).length, 1, "only the earlier charge");
  // A new month starts the budget again.
  c.set(utc("2026-10-01T07:00:00Z"));
  await due();
  assert.equal(lastRun(budgeted.id).status, "done");

  // The account's balance.
  const d = await person(s.app);
  const broke = await create(d, daily);
  const drain = uid("drain_");
  reserve(s.db, { id: drain, user: d.user.id, amount: balance(s.db, d.user.id).available - 5 });
  settle(s.db, drain, balance(s.db, d.user.id).held);
  await due();
  r = lastRun(broke.id);
  assert.equal(r.status, "refused");
  assert.equal(r.code, "insufficient_credits");
  assert.equal(holdsFor(s, d.user.id, broke.id).length, 0);

  // The account's own spending limits.
  const e = await person(s.app);
  const limited = await create(e, daily);
  await e.agent.patch("/api/spending-limits").send({ daily_limit: 0 }).expect(200);
  await due();
  r = lastRun(limited.id);
  assert.equal(r.status, "refused");
  assert.equal(r.code, "spending_limit");
  assert.equal(holdsFor(s, e.user.id, limited.id).length, 0);
  assert.equal((await inbox(e))[0].credits_charged, 0);
});

test("the reply budget is the largest whose worst-case hold fits the cap", () => {
  const m = {
    id: "x",
    type: "chat",
    pricing: { input_per_1M_tokens: 1, output_per_1M_tokens: 10 },
    context_length: 100000,
  };
  const messages = [{ role: "user", content: "hi" }];
  const cost = (max) =>
    Math.ceil(
      ((Math.ceil(JSON.stringify(messages).length / 2) * 1 + max * 10) / 1e6) * 1e7,
    );
  const fit = (cap) =>
    replyBudgetFor(m, messages, { factor: 1, feeUnits: 0, cap, longAnswers: true });
  assert.deepEqual(fit(cost(4096)), { max: 4096, amount: cost(4096) });
  assert.equal(fit(cost(256) - 1), null);
  const mid = fit(cost(1000) + 50);
  assert.equal(mid.max, 1000);
  assert.ok(mid.amount <= cost(1000) + 50);
});

test("after downtime only the latest missed slot runs, once", async (t) => {
  const c = clock(t, utc("2026-09-21T07:00:00Z"));
  const s = fixture(t);
  const p = await person(s.app);
  const made = await create(p, { schedule: { repeat: "daily", time: "08:00", timezone: "UTC" } });
  // Down from Monday morning until Thursday 09:15: Monday, Tuesday,
  // Wednesday and Thursday's 08:00 all passed.
  c.set(utc("2026-09-24T09:15:00Z"));
  await s.tick();
  await s.tick();
  const [only] = runs(s, made.id);
  assert.equal(runs(s, made.id).length, 1);
  assert.equal(only.slot, utc("2026-09-24T08:00:00Z"), "the latest slot");
  assert.equal(only.skipped, 3, "three older slots skipped");
  assert.equal(only.status, "done");
  assert.equal((await inbox(p))[0].skipped, 3);
  assert.equal((await view(p, made.id)).next_run_at, utc("2026-09-25T08:00:00Z"));
  assert.equal(holdsFor(s, p.user.id, made.id).length, 1, "one charge");
  c.set(utc("2026-09-24T23:00:00Z"));
  await s.tick();
  assert.equal(runs(s, made.id).length, 1);
});

test("one run at a time per routine", async (t) => {
  const c = clock(t, utc("2026-09-21T07:00:00Z"));
  const s = fixture(t);
  const p = await person(s.app);
  // The local test provider echoes the prompt a few characters at a time,
  // so a long prompt keeps the run in flight for a while.
  const made = await create(p, {
    prompt: "Slow routine. " + "zzyzx ".repeat(300),
    schedule: { repeat: "daily", time: "08:00", timezone: "UTC" },
  });
  c.set(utc("2026-09-21T08:00:10Z"));
  const first = s.tick();
  // Claimed and reserved synchronously: running, with its hold in place.
  let [run] = runs(s, made.id);
  assert.equal(run.status, "running");
  const routine = () =>
    s.db.prepare("SELECT * FROM routines WHERE id=?").get(made.id);
  assert.ok(routine().running_since != null);
  assert.equal(holdsFor(s, p.user.id, made.id)[0].status, "held");
  assert.equal((await view(p, made.id)).running, true);
  // The next day's slot comes due while it's still running: no second run.
  c.set(utc("2026-09-22T08:00:10Z"));
  s.routines.startDue();
  s.routines.startDue();
  assert.equal(runs(s, made.id).length, 1);
  assert.equal(
    (await p.agent.delete("/api/routines/" + made.id).expect(409)).body.error.code,
    "routine_running",
  );
  await p.agent.delete("/api/routines/runs/" + run.id).expect(409);
  await first;
  [run] = runs(s, made.id);
  assert.equal(run.status, "done");
  assert.equal(routine().running_since, null);
  // Once it has finished, the slot that came due runs, once.
  await s.tick();
  await s.tick();
  const both = runs(s, made.id);
  assert.equal(both.length, 2);
  assert.equal(both[1].slot, utc("2026-09-22T08:00:00Z"));
  assert.notEqual(both[0].request_id, both[1].request_id);
  await p.agent.delete("/api/routines/" + made.id).expect(200);
  assert.equal(runs(s, made.id).length, 0, "the inbox goes with it");
});

test("a run interrupted by a restart is recorded as failed and frees its routine", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-routines-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () =>
    createApp({
      testMode: true,
      dbPath: join(dir, "test.sqlite"),
      mediaPath: join(dir, "media"),
      catalogPath: join(dir, "models.json"),
      origin: ORIGIN,
      released: "all",
      mvpModels: [MODEL],
    });
  const first = open();
  const p = await person(first.app);
  const made = await create(p);
  first.db
    .prepare("UPDATE routines SET running_since=? WHERE id=?")
    .run(now(), made.id);
  first.db
    .prepare(
      "INSERT INTO routine_runs(id,routine_id,user_id,slot,started,status) VALUES('rr_cut',?,?,1,?,'running')",
    )
    .run(made.id, p.user.id, now());
  await first.stopWork();
  first.close();
  const second = open();
  t.after(() => second.close());
  const cut = second.db.prepare("SELECT * FROM routine_runs WHERE id='rr_cut'").get();
  assert.equal(cut.status, "failed");
  assert.equal(cut.code, "interrupted");
  const r = second.db.prepare("SELECT * FROM routines WHERE id=?").get(made.id);
  assert.equal(r.running_since, null);
  assert.equal(r.last_status, "failed");
});

test("a routine never runs after its account is closed, or once it is switched off", async (t) => {
  const c = clock(t, utc("2026-09-21T07:00:00Z"));
  const s = fixture(t);
  const daily = { schedule: { repeat: "daily", time: "08:00", timezone: "UTC" } };

  // Closing the account deletes its routines and inbox.
  const a = await person(s.app);
  const gone = await create(a, daily);
  c.set(utc("2026-09-21T08:00:30Z"));
  await s.tick();
  assert.equal(runs(s, gone.id).length, 1);
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.routines.routines.length, 1);
  assert.equal(exported.routines.routines[0].prompt, "Summarise the top AI news in 5 bullets.");
  assert.equal(exported.routines.runs.length, 1);
  assert.equal(exported.routines.runs[0].routine_name, "Morning AI news");
  await a.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM routines WHERE user_id=?").get(a.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM routine_runs WHERE user_id=?").get(a.user.id).n, 0);
  c.set(utc("2026-09-22T08:00:30Z"));
  await s.tick();
  assert.equal(holdsFor(s, a.user.id, gone.id).length, 1, "only the run before closure");

  // An account marked closed by any other path (a wipe) never runs either.
  const b = await person(s.app);
  const wiped = await create(b, daily);
  s.db.prepare("UPDATE users SET deleted=? WHERE id=?").run(now(), b.user.id);
  c.set(utc("2026-09-23T08:00:30Z"));
  await s.tick();
  assert.equal(runs(s, wiped.id).length, 0);
  assert.equal(holdsFor(s, b.user.id, wiped.id).length, 0);

  // Switched off, or the account closed, after the worker picked the run up
  // but before its reservation: the reservation's guard refuses it.
  const d = await person(s.app);
  const raced = await create(d, daily);
  s.db.exec(
    `CREATE TEMP TRIGGER switch_off AFTER INSERT ON routine_runs BEGIN UPDATE routines SET enabled=0 WHERE id=NEW.routine_id; END;`,
  );
  t.after(() => {
    try {
      s.db.exec("DROP TRIGGER IF EXISTS switch_off");
    } catch {}
  });
  c.set(utc("2026-09-24T08:00:30Z"));
  await s.tick();
  s.db.exec("DROP TRIGGER switch_off");
  const [refused] = runs(s, raced.id);
  assert.equal(refused.status, "refused");
  assert.equal(refused.code, "routine_gone");
  assert.equal(holdsFor(s, d.user.id, raced.id).length, 0, "nothing reserved");
  const e = await person(s.app);
  const closing = await create(e, daily);
  s.db.exec(
    `CREATE TEMP TRIGGER close_account AFTER INSERT ON routine_runs BEGIN UPDATE users SET deleted=1 WHERE id=NEW.user_id; END;`,
  );
  c.set(utc("2026-09-25T08:00:30Z"));
  await s.tick();
  s.db.exec("DROP TRIGGER close_account");
  const [closed] = runs(s, closing.id);
  assert.equal(closed.code, "routine_gone");
  assert.equal(holdsFor(s, e.user.id, closing.id).length, 0);
});

test("the inbox keeps each routine's newest 50 runs", async (t) => {
  const c = clock(t, utc("2026-09-21T07:00:00Z"));
  const s = fixture(t);
  const p = await person(s.app);
  const made = await create(p, { schedule: { repeat: "daily", time: "08:00", timezone: "UTC" } });
  const other = await create(p, { name: "Other" });
  const add = s.db.prepare(
    "INSERT INTO routine_runs(id,routine_id,user_id,slot,started,finished,status,answer) VALUES(?,?,?,?,?,?,'done','old')",
  );
  for (let i = 0; i < KEEP_RUNS; i++) {
    add.run("rr_old_" + i, made.id, p.user.id, i, 1000 + i, 1000 + i);
    add.run("rr_other_" + i, other.id, p.user.id, i, 1000 + i, 1000 + i);
  }
  c.set(utc("2026-09-21T08:00:30Z"));
  await s.tick();
  const kept = runs(s, made.id);
  assert.equal(kept.length, KEEP_RUNS);
  assert.ok(!kept.some((r) => r.id === "rr_old_0"), "the oldest went");
  assert.equal(kept.at(-1).status, "done");
  assert.notEqual(kept.at(-1).answer, "old");
  assert.equal(runs(s, other.id).length, KEEP_RUNS, "other routines untouched");
  const page = (await p.agent.get("/api/routines/runs").expect(200)).body;
  assert.equal(page.runs.length, KEEP_RUNS);
  assert.equal(page.more, true);
});

async function mockServer(t, handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return "http://127.0.0.1:" + server.address().port;
}
async function readJSON(req) {
  let text = "";
  for await (const b of req) text += b;
  return JSON.parse(text || "{}");
}
const sse = (res, v) => res.write("data: " + JSON.stringify(v) + "\n\n");

test("Private models only routes like Private Mode: zero data retention, never the backup", async (t) => {
  let mode = "ok";
  const primaryBodies = [];
  const primary = await mockServer(t, async (req, res) => {
    primaryBodies.push(await readJSON(req));
    if (mode === "unfunded") {
      res.writeHead(402, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "unfunded" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { choices: [{ delta: { content: "from primary" } }] });
    sse(res, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0002 } });
    res.end("data: [DONE]\n\n");
  });
  const backupCalls = [];
  const backup = await mockServer(t, async (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: PRIVATE }, { id: MODEL }] }));
    }
    backupCalls.push((await readJSON(req)).model);
    res.writeHead(200, { "content-type": "text/event-stream" });
    sse(res, { choices: [{ delta: { content: "from backup" } }] });
    sse(res, { choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0002 } });
    res.end("data: [DONE]\n\n");
  });
  const c = clock(t, utc("2026-09-21T07:00:00Z"));
  const s = fixture(t, "all", {
    testMode: false,
    gateway: primary,
    gatewayKey: "fixture",
    gateway2: backup,
    gateway2Key: "backup-key",
  });
  t.mock.method(console, "error", () => {});
  const p = await person(s.app);
  addCredit(s.db, p.user.id, 100000000, "routine-fund", "deposit");
  const daily = { schedule: { repeat: "daily", time: "08:00", timezone: "UTC" } };
  const priv = await create(p, { ...daily, private_only: true, model: PRIVATE });
  assert.equal(priv.private_only, true);
  const day = async (d) => {
    c.set(utc(`2026-09-${d}T08:00:30Z`));
    await s.tick();
  };
  await day(21);
  let [run] = runs(s, priv.id);
  assert.equal(run.status, "done");
  assert.equal(run.answer, "from primary");
  assert.equal(run.private_only, 1);
  assert.equal(primaryBodies.at(-1).model, PRIVATE);
  assert.deepEqual(primaryBodies.at(-1).provider, { zdr: true, data_collection: "deny" });
  // The primary refuses: a private routine never fails over.
  mode = "unfunded";
  await day(22);
  run = runs(s, priv.id).at(-1);
  assert.equal(run.status, "failed");
  assert.equal(run.charged, 0);
  assert.deepEqual(backupCalls, []);
  assert.equal(balance(s.db, p.user.id).held, 0);
  // A model that stops counting as private is refused before anything is
  // reserved.
  s.cfg.privateModels = [];
  await day(23);
  run = runs(s, priv.id).at(-1);
  assert.equal(run.status, "refused");
  assert.equal(run.code, "private_model_required");
  s.cfg.privateModels = [PRIVATE];

  // An ordinary routine: no ZDR flag, and failover is allowed.
  await p.agent.patch("/api/routines/" + priv.id).send({ enabled: false }).expect(200);
  mode = "ok";
  const open = await create(p, daily);
  await day(24);
  assert.equal(primaryBodies.at(-1).provider, undefined);
  assert.equal(runs(s, open.id).at(-1).answer, "from primary");
  mode = "unfunded";
  await day(25);
  assert.equal(runs(s, open.id).at(-1).answer, "from backup");
  assert.deepEqual(backupCalls, [MODEL]);
});

test("the Chinese dictionary covers the update and the Routines page", () => {
  const zh = compileDictionary(
    JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")),
  );
  const han = /\p{Script=Han}/u;
  const entry = UPDATES.find((u) => u.id === "routines");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Routines is coming soon.",
    "Inbox",
    "New routine",
    "Edit routine",
    "Save routine",
    "Delete routine",
    "Repeat",
    "Every day",
    "Weekdays (Monday to Friday)",
    "Once a week",
    "Time zone",
    "Per-run maximum (credits)",
    "Monthly budget (credits)",
    "Private models only",
    "Web search",
    "Delivered",
    "Refused",
    "Failed",
    "Running",
    "All routines",
    "Weekdays at 08:00",
    "Every day at 08:00",
    "Every Monday at 08:00",
    "Every Sunday at 21:30",
    "Skipped 1 missed run",
    "Skipped 3 missed runs",
    "12.5 of 500 credits spent this month",
    "Routines run on our server, where Veil can't mask anything: the prompt is sent as written.",
    "Your balance couldn't cover this run. Nothing was charged.",
    "This routine's monthly budget couldn't cover this run. Nothing was charged.",
    "The per-run maximum couldn't cover this run with this model and prompt. Nothing was charged.",
    "Your spending limits couldn't cover this run. Nothing was charged.",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
});

// Routines.jsx compiled for Node with the same esbuild Vite uses. Shared UI,
// routing and markdown are swapped for plain stand-ins so only this page's
// own text is rendered.
async function pageModule() {
  const src = new URL("../src/Routines.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-routines-ui-"));
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
     export const Empty = ({ title, children }) => React.createElement("div", null, React.createElement("h3", null, title), React.createElement("p", null, children));
     export const CopyButton = ({ label = "Copy" }) => React.createElement("button", null, label);`,
  );
  const receipt = stub("receipt.mjs", "export default () => null;");
  const router = stub(
    "router.mjs",
    `export const Link = ({ children, to }) => React.createElement("a", { href: to }, children);`,
  );
  const markdown = stub(
    "markdown.mjs",
    `export default ({ children }) => React.createElement("div", null, children);`,
  );
  const gfm = stub("gfm.mjs", "export default () => {};");
  const out = code
    .replace(/^import "\.\/routines\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/SignedReceipt\.jsx"/g, `from "${receipt}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "react-markdown"/g, `from "${markdown}"`)
    .replace(/from "remark-gfm"/g, `from "${gfm}"`)
    .replace(/from "\.\/lib\.js"/g, `from "${new URL("../src/lib.js", import.meta.url)}"`)
    .replace(/from "\.\/routines\.js"/g, `from "${new URL("../src/routines.js", import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "Routines.mjs");
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
// user's and the model's words) or not (the page's own, to be translated).
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
      // The language switch never touches a textarea's text (i18n.js).
      const noText = /^(script|style|code|pre|textarea|noscript|kbd|samp)$/i.test(m[2]);
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>"))
        stack.push({ off: off || noText });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    }
  }
  const words = (list) => list.filter((s) => /[A-Za-z]{2}/.test(s));
  return { page: words(page), kept: words(kept) };
}

test("the page marks user and model content off, and translates the rest", async () => {
  const dict = compileDictionary(
    JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")),
  );
  const { default: Routines, Editor, RoutineCard, RunCard, demoState } = await pageModule();
  const models = [
    { id: "m-1", name: "Gemini 2.5 Flash", type: "chat", callable: true },
    { id: "m-2", name: "Venice Uncensored", type: "chat", callable: true, private: true },
  ];
  const config = { releases: { features: { routines: true, search: true, private: true } } };
  const { routines, runs } = demoState();
  const draft = {
    id: "demo-news",
    name: "Morning AI news",
    prompt: "My own prompt text",
    model: "m-1",
    web_search: true,
    private_only: false,
    repeat: "weekly",
    day: 3,
    time: "08:00",
    timezone: "UTC",
    per_run_credits: "25",
    monthly_budget_credits: "500",
    enabled: true,
  };
  const failed = {
    ...runs[1],
    id: "failed",
    status: "failed",
    code: "provider_rejected",
    message: "The provider rejected this request.",
    skipped: 1,
  };
  const html = [
    renderToStaticMarkup(createElement(Routines, { demo: true, user: null, models, config })),
    renderToStaticMarkup(createElement(Routines, { demo: false, user: null, models, config })),
    renderToStaticMarkup(
      createElement(Editor, { draft, setDraft() {}, models, config, busy: false, error: "", onSave() {}, onCancel() {}, onDelete() {} }),
    ),
    ...routines.map((r) =>
      renderToStaticMarkup(createElement(RoutineCard, { r: { ...r, running: true }, modelName: "Gemini 2.5 Flash" })),
    ),
    ...[...runs, failed, { ...runs[0], id: "long", finish_reason: "length" }, { ...runs[0], id: "live", status: "running", answer: null }].map((run) =>
      renderToStaticMarkup(createElement(RunCard, { run, modelName: "Gemini 2.5 Flash" })),
    ),
  ].join("");
  const { page, kept } = textsOf(html);
  // The user's and the model's words stay as written.
  for (const text of ["Morning AI news", "Friday review", "Gemini 2.5 Flash", "Example source", "UTC", "Europe/London"])
    assert.ok(kept.includes(text), `kept as written: ${text}`);
  assert.ok(kept.some((t) => t.startsWith("Draft a short, upbeat checklist")), "the prompt");
  assert.ok(kept.some((t) => t.includes("a prepared demo answer")), "the answer");
  // Everything else is the page's own, and has a translation.
  assert.ok(page.includes("Routines run on our server, where Veil can't mask anything: the prompt is sent as written."));
  assert.ok(page.includes("Weekdays at 08:00"));
  assert.ok(page.includes("Every Wednesday at 08:00") || page.includes("Every Friday at 16:30"));
  const date = /^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2} [AP]M$/;
  for (const text of page) {
    if (text === "The provider rejected this request.") continue; // a server message, not the page's
    if (date.test(text)) {
      assert.ok(translateText(text, dict), `date: ${text}`);
      continue;
    }
    assert.match(translateText(text, dict) ?? "", /\p{Script=Han}/u, `untranslated: ${text}`);
  }
});

test("a routine never saves a seed phrase, with Seed Guard live", async (t) => {
  const s = fixture(t);
  const p = await person(s.app);
  const mnemonic =
    "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const saved = (i) => UPDATES[i].released;
  const at = UPDATES.findIndex((u) => u.id === "seedguard");
  const was = saved(at);
  UPDATES[at].released = true;
  t.after(() => (UPDATES[at].released = was));
  const r = await p.agent
    .post("/api/routines")
    .send(body({ prompt: "Check this wallet: " + mnemonic }))
    .expect(400);
  assert.equal(r.body.error.code, "seed_phrase_blocked");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM routines").get().n, 0);
  // An ordinary prompt still saves.
  await create(p, { prompt: "Five bullets on today's AI news" });
});
