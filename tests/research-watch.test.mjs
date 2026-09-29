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
import { MIGRATIONS, addCredit, balance, database, migrate, now, reserve, rollbackSchema, settle, uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { eraseAccountContent } from "../server/routes/account.js";
import { watchCosts, watchWritePrompt } from "../server/research-watch.js";
import { todayLine } from "../server/research.js";
import { MAX_WATCHES, MAX_PREVIOUS, TOPIC_LIMIT, defaultName, keyFindings } from "../src/research-watch.js";
import { DATA_NOTICE } from "../src/documents.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const ORIGIN = "http://localhost:5175";
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const units = (c) => Math.round(c * 10000);
const utc = (s) => Date.parse(s);
// The public NYMA contract, which switches Early Model Access on (as in tests/early-models.test.mjs).
const NYMA_CONTRACT = "0x968be0c1a394bf1ce239e3b40909ec0f9d4f5583";
const TOPIC = "EU AI Act enforcement";
const PLAN = [
  "What has the EU AI Office announced recently?",
  "Which obligations now apply to general-purpose models?",
  "Which fines or investigations have been reported?",
  "How are member states preparing to enforce the Act?",
  "What do providers say about compliance costs?",
  "Which guidance documents were published?",
];
const SOURCE = (n) => ({ url: `https://source-${n}.example.org/page`, title: `Source ${n}` });
const REPORT =
  "# AI Act briefing\n\n**Key findings**\n\n- The AI Office published new guidance on general-purpose models [1][2].\n- Member states are still naming their regulators [3].\n\n## Guidance\n\nProviders must document training data [1].";

// ---- A stand-in for the gateway (as in tests/deep-research.test.mjs) ----

function event(res, p) {
  res.write("data: " + JSON.stringify(p) + "\n\n");
}
async function readJSON(req) {
  let s = "";
  for await (const b of req) s += b;
  return JSON.parse(s || "{}");
}
const kindOf = (body) =>
  body.plugins?.some((p) => p?.id === "web")
    ? "search"
    : String(body.messages?.[0]?.content || "").startsWith("You plan web research")
      ? "plan"
      : String(body.messages?.[0]?.content || "").startsWith("You write briefings")
        ? "write"
        : "chat";
// `script` answers each kind of step: { plan, search(i, body), write } where
// each is text, { text, sources, finish }, { status } (a provider refusal),
// or null (hangs until the request is aborted). A function is called with
// (index, body).
async function gateway(t, script = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const body = await readJSON(req);
    const kind = kindOf(body);
    const index = calls.filter((c) => c.kind === kind).length;
    calls.push({ kind, body });
    const pick = (v, fallback) => (v === undefined ? fallback : typeof v === "function" ? v(index, body) : v);
    const answer =
      kind === "plan"
        ? pick(script.plan, JSON.stringify({ questions: PLAN }))
        : kind === "search"
          ? pick(script.search, {
              text: `Findings for ${body.messages[1].content}`,
              sources: [SOURCE(index * 2 + 1), SOURCE(index * 2 + 2)],
            })
          : kind === "write"
            ? pick(script.write, REPORT)
            : "ok";
    if (answer === null) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": waiting\n\n");
      req.on("close", () => res.destroy());
      return;
    }
    if (answer?.status) {
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stand-in refusal" } }));
      return;
    }
    const text = typeof answer === "string" ? answer : answer.text;
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { choices: [{ delta: { content: text } }] });
    if (answer?.sources)
      event(res, {
        choices: [
          { delta: { annotations: answer.sources.map((s) => ({ type: "url_citation", url_citation: s })) } },
        ],
      });
    event(res, {
      choices: [{ delta: {}, finish_reason: answer?.finish || "stop" }],
      usage: { prompt_tokens: 200, completion_tokens: 100 },
    });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(r);
      }),
  );
  return { url: "http://127.0.0.1:" + server.address().port, calls, of: (kind) => calls.filter((c) => c.kind === kind) };
}

function fixture(t, { released = "all", gatewayUrl = "http://127.0.0.1:9", ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-research-watch-"));
  const svc = createApp({
    testMode: false,
    gateway: gatewayUrl,
    gatewayKey: "fixture",
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: ORIGIN,
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(s, fund = 50_000_000) {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username: "u" + randomBytes(4).toString("hex"), password: "test-password-long" })
    .expect(201);
  if (fund) addCredit(s.db, r.body.user.id, fund, "fund-" + r.body.user.id, "test_credit");
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
const daily = { repeat: "daily", time: "08:00", timezone: "UTC" };
const body = (extra = {}) => ({
  topic: TOPIC,
  model: MODEL,
  depth: "quick",
  schedule: daily,
  monthly_budget_credits: 1000,
  ...extra,
});
const create = async (p, extra) => (await p.agent.post("/api/research-watches").send(body(extra)).expect(201)).body;
const quote = async (p, extra = {}) =>
  (await p.agent.post("/api/research-watches/quote").send({ model: MODEL, depth: "quick", topic: TOPIC, ...extra }).expect(200)).body;
const runs = (s, watch) =>
  s.db.prepare("SELECT * FROM routine_runs WHERE routine_id=? ORDER BY started,rowid").all(watch);
const holdsFor = (s, user, watch) =>
  s.db.prepare("SELECT * FROM holds WHERE id LIKE ? ORDER BY id").all(`${user}:routine_${watch}_%`);
const inbox = async (p, query = "") => (await p.agent.get("/api/routines/runs" + query).expect(200)).body.runs;
const view = async (p, id) =>
  (await p.agent.get("/api/research-watches").expect(200)).body.watches.find((w) => w.id === id);
const stepOf = (id) => id.split(":").at(-1);
// A watch that runs at 08:00 UTC, created just before, with the clock at its
// first slot. Returns the clock so a test can move on.
async function due(t, s, p, extra) {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const made = await create(p, extra);
  c.set(utc("2026-09-25T08:00:30Z"));
  return { c, made };
}

// ---- Gating ----

test("Research Watch is registered, unreleased and gated like any update", async (t) => {
  const entry = UPDATES.find((u) => u.id === "researchwatch");
  assert.ok(entry, "researchwatch is registered");
  assert.equal(entry.title, "Research Watch");
  assert.equal(entry.tagline, "A sourced briefing on any topic, delivered on your schedule.");
  assert.equal(entry.points.length, 3);
  // `false` until its release commit flips it; the gate tests pin it anyway.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  const gate = (path, method = "GET", b = {}) => featuresFor({ path, method, body: b });
  const all = ["researchwatch", "routines", "deepresearch", "search"];
  assert.deepEqual(gate("/api/research-watches"), all);
  assert.deepEqual(gate("/API/Research-Watches/quote", "POST"), all);
  assert.deepEqual(gate("/api/research-watches/rt_1", "DELETE"), all);
  assert.deepEqual(gate("/api/research-watches", "POST", { private_only: true }), [...all, "private"]);
  assert.deepEqual(gate("/api/research-watches/rt_1", "PATCH", { private_only: false }), all);
  // The inbox stays Routines' own.
  assert.deepEqual(gate("/api/routines/runs"), ["routines"]);

  // Unreleased: every route is refused, the API docs leave it out and the
  // config says so.
  const mvp = fixture(t, { released: "mvp" });
  const a = await person(mvp);
  for (const send of [
    () => a.agent.get("/api/research-watches"),
    () => a.agent.post("/api/research-watches").send(body()),
    () => a.agent.post("/api/research-watches/quote").send({ model: MODEL, depth: "quick" }),
    () => a.agent.patch("/api/research-watches/rt_x").send({ enabled: false }),
    () => a.agent.delete("/api/research-watches/rt_x"),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Research Watch is coming soon.");
  }
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.researchwatch, false);
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(closed.paths).some((p) => p.includes("research-watches")));
  // A watch left behind (say, the update was switched off again) never runs
  // while it, Deep Research or Live Web Search is unreleased.
  const g = await gateway(t);
  const gated = fixture(t, { released: "mvp,routines,deepresearch,search", gatewayUrl: g.url });
  const b = await person(gated);
  gated.db
    .prepare(
      "INSERT INTO routines(id,user_id,name,prompt,model,web_search,repeat,minute,timezone,run_cap,monthly_budget,enabled,next_due,created,updated,kind,depth) VALUES('rt_left',?,'Left',?,?,1,'daily',0,'UTC',?,?,1,?,?,?,'research','quick')",
    )
    .run(b.user.id, TOPIC, MODEL, units(200), units(500), now() - 60000, now(), now());
  await gated.tick();
  assert.equal(runs(gated, "rt_left").length, 0);
  assert.equal(g.calls.length, 0);
  assert.equal(holdsFor(gated, b.user.id, "rt_left").length, 0);

  // It needs Routines, Deep Research and Live Web Search as well.
  for (const missing of ["routines", "deepresearch", "search"]) {
    const have = ["routines", "deepresearch", "search", "researchwatch"].filter((x) => x !== missing);
    const part = fixture(t, { released: "mvp," + have.join(",") });
    const c = await person(part);
    const res = await c.agent.get("/api/research-watches").expect(403);
    assert.match(res.body.error.message, /is coming soon\.$/);
  }
  // Released, a plain watch needs nothing else; Private models only needs Private Mode.
  const own = fixture(t, { released: "mvp,routines,deepresearch,search,researchwatch", mvpModels: [MODEL] });
  const d = await person(own);
  const made = await create(d);
  assert.equal(made.kind, "research");
  const res = await d.agent.post("/api/research-watches").send(body({ private_only: true })).expect(403);
  assert.equal(res.body.error.message, "Private Mode is coming soon.");
  const open = (await request(own.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(open.paths["/api/research-watches"].get);
  assert.ok(open.paths["/api/research-watches"].post);
  assert.ok(open.paths["/api/research-watches/quote"].post);
  assert.ok(open.paths["/api/research-watches/{id}"].patch);
  assert.ok(open.paths["/api/research-watches/{id}"].delete);
  await request(own.app).get("/api/research-watches").expect(401);
});

test("the schema change is additive: a build from before it still starts, and can't run a watch as a prompt routine", async (t) => {
  const at = MIGRATIONS.findIndex((m) => String(m).includes('"routines"') && String(m).includes("'research'"));
  assert.ok(at > 0, "found by content");
  const db = database(":memory:");
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  const cols = db.prepare("PRAGMA table_info(routines)").all().map((c) => c.name);
  for (const c of ["kind", "depth", "new_only", "next_due"]) assert.ok(cols.includes(c), c);
  const runCols = db.prepare("PRAGMA table_info(routine_runs)").all().map((c) => c.name);
  for (const c of ["kind", "research"]) assert.ok(runCols.includes(c), c);
  // Recorded as additive, so an earlier build can be started on it...
  assert.ok(db.prepare("SELECT version FROM schema_additive WHERE version=?").get(at + 1));
  assert.deepEqual(rollbackSchema(db, at), { from: MIGRATIONS.length, to: at });
  // ...and upgrading again re-runs it harmlessly.
  migrate(db);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name IN ('routines_per_account','research_watches_per_account','routines_watch_due')").get().n, 3);
  db.close();

  // The scheduler of a build from before this one, on a due, switched-on watch:
  // it never matches, because a watch's next run is next_due and next_run is NULL.
  const s = fixture(t);
  const p = await person(s);
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const made = await create(p);
  const row = s.db.prepare("SELECT * FROM routines WHERE id=?").get(made.id);
  assert.equal(row.next_run, null);
  assert.equal(row.next_due, utc("2026-09-25T08:00:00Z"));
  assert.equal(row.enabled, 1);
  const older = s.db
    .prepare(
      "SELECT r.id FROM routines r JOIN users u ON u.id=r.user_id AND u.deleted IS NULL WHERE r.enabled=1 AND r.next_run<=? AND r.running_since IS NULL ORDER BY r.next_run LIMIT ?",
    )
    .all(utc("2027-01-01T00:00:00Z"), 8);
  assert.deepEqual(older, []);
  c.set(utc("2026-09-25T07:30:00Z"));
});

// ---- Saving ----

test("the quote is what a run holds: one number, priced like Deep Research", async (t) => {
  const s = fixture(t);
  const p = await person(s);
  const q = await quote(p);
  assert.equal(q.searches, 3);
  assert.equal(q.estimate, true);
  assert.equal(units(q.credits), units(q.steps.plan) + 3 * units(q.steps.search) + units(q.steps.write));
  assert.equal(q.min_monthly_budget_credits, q.credits);
  const thorough = await quote(p, { depth: "thorough" });
  assert.equal(thorough.searches, 6);
  assert.ok(thorough.credits > q.credits);
  // Only new adds the last report's key findings (at their longest): dearer.
  const fresh = await quote(p, { new_only: true });
  assert.ok(fresh.credits > q.credits);
  // The same function prices the saved watch.
  const made = await create(p);
  assert.equal(made.per_run_credits, q.credits);
  const costs = watchCosts({
    cfg: s.cfg,
    m: { ...(await import("../server/core.js")).catalog().data.find((m) => m.id === MODEL) },
    topic: TOPIC,
    depth: "quick",
    newOnly: false,
    factor: 1,
  });
  assert.equal(costs.total, units(q.credits));
  // A quote without a topic assumes the longest one; it never charges.
  const before = balance(s.db, p.user.id);
  const generic = await quote(p, { topic: undefined });
  assert.ok(generic.credits >= q.credits);
  assert.deepEqual(balance(s.db, p.user.id), before);
  // The account's spending limit shows beside it.
  await p.agent.patch("/api/spending-limits").send({ daily_limit: 5 }).expect(200);
  assert.equal((await quote(p)).spending_limit.remaining, 5);
  // Bad input.
  await p.agent.post("/api/research-watches/quote").send({ model: MODEL, depth: "deep" }).expect(400);
  await p.agent.post("/api/research-watches/quote").send({ model: "nope/none", depth: "quick" }).expect(400);
});

test("a watch is saved with its per-run maximum, and a budget that can't cover one run is refused", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const s = fixture(t);
  const p = await person(s);
  const q = await quote(p);
  const made = await create(p, { name: "  AI Act  " });
  assert.equal(made.kind, "research");
  assert.equal(made.name, "AI Act");
  assert.equal(made.topic, TOPIC);
  assert.equal(made.depth, "quick");
  assert.equal(made.new_only, false);
  assert.equal(made.private_only, false);
  assert.equal(made.web_search, true);
  assert.equal(made.per_run_credits, q.credits);
  assert.equal(made.monthly_budget_credits, 1000);
  assert.equal(made.enabled, true);
  assert.equal(made.next_run_at, utc("2026-09-25T08:00:00Z"), "the next slot; saving never runs it");
  assert.equal(runs(s, made.id).length, 0);
  // The name defaults to the topic.
  const unnamed = await create(p, { topic: "Passkey adoption in banks", schedule: { ...daily, time: "09:30" } });
  assert.equal(unnamed.name, "Passkey adoption in banks");
  assert.equal(defaultName("x".repeat(100)).length, 60);

  // A monthly budget below one run's maximum is refused, with the number.
  const small = await p.agent.post("/api/research-watches").send(body({ monthly_budget_credits: q.credits - 1 })).expect(400);
  assert.equal(small.body.error.code, "watch_budget_too_small");
  assert.match(small.body.error.message, new RegExp(String(q.credits).replace(".", "\\.")));
  // Weekly needs a day; weekdays is not offered; the time and zone are checked.
  await p.agent.post("/api/research-watches").send(body({ schedule: { repeat: "weekly", time: "08:00" } })).expect(400);
  const weekdays = await p.agent.post("/api/research-watches").send(body({ schedule: { ...daily, repeat: "weekdays" } })).expect(400);
  assert.equal(weekdays.body.error.message, "Repeat daily or weekly.");
  await p.agent.post("/api/research-watches").send(body({ schedule: { ...daily, time: "8am" } })).expect(400);
  await p.agent.post("/api/research-watches").send(body({ schedule: { ...daily, timezone: "Mars/Base" } })).expect(400);
  const weekly = await create(p, { topic: "Weekly one", schedule: { repeat: "weekly", day: 1, time: "08:00", timezone: "UTC" } });
  assert.equal(weekly.next_run_at, utc("2026-09-28T08:00:00Z"));
  // Topic, depth, model and the rest.
  for (const bad of [
    { topic: "" },
    { topic: "x".repeat(TOPIC_LIMIT + 1) },
    { depth: "deep" },
    { model: "not/a-model" },
    { new_only: "yes" },
    { monthly_budget_credits: 0 },
    { monthly_budget_credits: 1000.00001 },
  ]) {
    const res = await p.agent.post("/api/research-watches").send(body(bad)).expect(400);
    assert.ok(res.body.error.code, JSON.stringify(bad));
  }
  await p.agent.post("/api/research-watches").send({ ...body(), topic: undefined }).expect(400);
  // Private models only needs a zero-data-retention model.
  assert.equal(
    (await p.agent.post("/api/research-watches").send(body({ private_only: true })).expect(400)).body.error.code,
    "private_model_required",
  );
  c.set(utc("2026-09-25T07:30:00Z"));
});

test("Seed Guard refuses a seed phrase as a topic, with no override", async (t) => {
  const s = fixture(t);
  const p = await person(s);
  for (const send of [
    () => p.agent.post("/api/research-watches").send(body({ topic: "What is " + SEED, allow_seed_phrase: true })),
  ]) {
    const res = await send().expect(400);
    assert.equal(res.body.error.code, "seed_phrase_blocked");
  }
  const made = await create(p);
  const res = await p.agent.patch("/api/research-watches/" + made.id).send({ topic: "About " + SEED }).expect(400);
  assert.equal(res.body.error.code, "seed_phrase_blocked");
  assert.equal((await view(p, made.id)).topic, TOPIC);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM routines WHERE user_id=?").get(p.user.id).n, 1);
});

test("up to five watches, apart from ten prompt routines; a watch is changed only from its own routes", async (t) => {
  const s = fixture(t);
  const p = await person(s);
  for (let i = 0; i < MAX_WATCHES; i++) await create(p, { topic: "Topic " + i });
  const over = await p.agent.post("/api/research-watches").send(body({ topic: "One more" })).expect(409);
  assert.equal(over.body.error.code, "watch_limit");
  // Prompt routines count separately, and the routines list leaves watches out.
  for (let i = 0; i < 10; i++)
    await p.agent
      .post("/api/routines")
      .send({
        name: "R" + i,
        prompt: "Hello",
        model: MODEL,
        schedule: daily,
        per_run_credits: 5,
        monthly_budget_credits: 50,
      })
      .expect(201);
  const list = (await p.agent.get("/api/routines").expect(200)).body;
  assert.equal(list.routines.length, 10);
  assert.ok(list.routines.every((r) => r.kind === undefined));
  assert.equal((await p.agent.get("/api/research-watches").expect(200)).body.watches.length, MAX_WATCHES);
  assert.equal((await p.agent.get("/api/research-watches").expect(200)).body.max_watches, 5);
  const [w] = (await p.agent.get("/api/research-watches").expect(200)).body.watches;
  // The generic edit route refuses a watch; another account can't reach it.
  assert.equal(
    (await p.agent.patch("/api/routines/" + w.id).send({ enabled: false }).expect(400)).body.error.code,
    "invalid_routine",
  );
  const other = await person(s);
  await other.agent.patch("/api/research-watches/" + w.id).send({ enabled: false }).expect(404);
  await other.agent.delete("/api/research-watches/" + w.id).expect(404);
  // A prompt routine isn't a watch.
  const [r] = list.routines;
  await p.agent.patch("/api/research-watches/" + r.id).send({ enabled: false }).expect(404);
  // Deleting a watch makes room.
  await p.agent.delete("/api/research-watches/" + w.id).expect(200);
  await create(p, { topic: "Room again" });
});

test("changes re-price the watch; switching off doesn't; the schedule moves the next run", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const s = fixture(t);
  const p = await person(s);
  const made = await create(p);
  const q = await quote(p, { depth: "thorough" });
  const thorough = (
    await p.agent.patch("/api/research-watches/" + made.id).send({ depth: "thorough" }).expect(200)
  ).body;
  assert.equal(thorough.depth, "thorough");
  assert.equal(thorough.per_run_credits, q.credits);
  assert.equal(thorough.topic, TOPIC, "omitted fields are kept");
  // A budget the new price no longer fits is refused.
  await p.agent
    .patch("/api/research-watches/" + made.id)
    .send({ monthly_budget_credits: q.credits - 1 })
    .expect(400);
  // Off, and back on: the next run is the next slot after now.
  const off = (await p.agent.patch("/api/research-watches/" + made.id).send({ enabled: false }).expect(200)).body;
  assert.equal(off.next_run_at, null);
  c.set(utc("2026-09-25T09:00:00Z"));
  const on = (await p.agent.patch("/api/research-watches/" + made.id).send({ enabled: true }).expect(200)).body;
  assert.equal(on.next_run_at, utc("2026-09-26T08:00:00Z"));
  const moved = (
    await p.agent
      .patch("/api/research-watches/" + made.id)
      .send({ schedule: { repeat: "weekly", day: 5, time: "17:00", timezone: "Europe/London" } })
      .expect(200)
  ).body;
  assert.deepEqual(moved.schedule, { repeat: "weekly", time: "17:00", day: 5, timezone: "Europe/London" });
  assert.equal(moved.next_run_at, utc("2026-09-25T16:00:00Z"));
  // Switching off never asks for a new quote, even when the budget is short.
  s.db.prepare("UPDATE routines SET monthly_budget=? WHERE id=?").run(units(1), made.id);
  await p.agent.patch("/api/research-watches/" + made.id).send({ enabled: false }).expect(200);
  await p.agent.patch("/api/research-watches/" + made.id).send({ enabled: true }).expect(400);
});

// ---- A run ----

test("a due watch runs Deep Research's steps, held and settled one by one, and lands in the inbox with sources", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s);
  const { c, made } = await due(t, s, p);
  const q = await quote(p);
  const before = balance(s.db, p.user.id);
  await s.tick();
  await s.tick();
  assert.equal(runs(s, made.id).length, 1, "exactly one run");
  // The plan, the first three of its sub-questions as web searches, the report.
  assert.deepEqual(g.calls.map((x) => x.kind).sort(), ["plan", "search", "search", "search", "write"]);
  const searched = g.of("search").map((x) => x.body.messages[1].content).sort();
  assert.deepEqual(searched, PLAN.slice(0, 3).sort());
  assert.ok(g.of("search").every((x) => x.body.plugins?.[0]?.id === "web" && x.body.messages.length === 2));
  assert.equal(g.of("plan")[0].body.max_tokens, 4000);
  assert.equal(g.of("write")[0].body.max_tokens, 8000);
  assert.ok(g.calls.every((x) => !x.body.provider?.zdr), "not a private watch");

  // Billing: one hold per step, at the quoted amounts, every one settled.
  const holds = holdsFor(s, p.user.id, made.id);
  assert.deepEqual(holds.map((h) => stepOf(h.id)).sort(), ["plan", "search1", "search2", "search3", "write"]);
  assert.ok(holds.every((h) => h.status === "settled"));
  const at = (name) => holds.find((h) => stepOf(h.id) === name).amount;
  assert.equal(at("plan"), units(q.steps.plan));
  for (const n of ["search1", "search2", "search3"]) assert.equal(at(n), units(q.steps.search));
  assert.equal(at("write"), units(q.steps.write));
  assert.equal(
    holds.reduce((n, h) => n + h.amount, 0),
    units(q.credits),
    "the hold is the quote",
  );
  const [run] = await inbox(p);
  assert.equal(run.status, "done");
  assert.equal(run.kind, "research");
  assert.equal(run.routine_id, made.id);
  assert.equal(run.routine_name, TOPIC);
  assert.equal(run.scheduled_for, utc("2026-09-25T08:00:00Z"));
  assert.equal(run.web_search, true);
  assert.equal(run.private_only, false);
  assert.equal(run.request_id, `routine_${made.id}_${utc("2026-09-25T08:00:00Z")}`);
  assert.equal(run.finish_reason, "stop");
  assert.equal(run.code, null);
  assert.equal(run.signed_receipt, null);
  assert.match(run.answer, /^# AI Act briefing/);
  assert.match(run.answer, /published new guidance on general-purpose models \[1\]\[2\]\./);
  assert.equal(run.citations.length, 6);
  assert.deepEqual(run.citations[0], SOURCE(1));
  // What each step did and cost, never the content.
  assert.equal(run.research.depth, "quick");
  assert.equal(run.research.previous, false);
  // Privacy Trail: each finished step says which route served it.
  assert.deepEqual(run.research.steps.map((x) => x.route), ["primary", "primary", "primary", "primary", "primary"]);
  assert.deepEqual(run.research.questions, PLAN.slice(0, 3));
  assert.deepEqual(run.research.steps.map((x) => [x.kind, x.status]), [
    ["plan", "done"],
    ["search", "done"],
    ["search", "done"],
    ["search", "done"],
    ["write", "done"],
  ]);
  const ledger = s.db
    .prepare("SELECT ref,amount FROM ledger WHERE user_id=? AND amount<0 ORDER BY ref")
    .all(p.user.id);
  assert.equal(ledger.length, 5, "one ledger entry per step");
  const charged = -ledger.reduce((n, l) => n + l.amount, 0);
  assert.equal(charged, units(run.credits_charged));
  assert.equal(run.credits_charged, run.research.credits_charged);
  assert.equal(
    run.research.steps.reduce((n, x) => n + units(x.credits), 0),
    charged,
  );
  assert.ok(run.credits_charged > 0 && units(run.credits_charged) <= units(q.credits));
  assert.ok(run.credits_charged > 3 * 21, "three web search fees at least");
  assert.equal(before.available - balance(s.db, p.user.id).available, charged);
  assert.equal(balance(s.db, p.user.id).held, 0);
  // Model Status counts each step as a request to the model, as Deep Research's do.
  assert.equal(s.modelStatus.events().length, 5);
  // Month to date, and the next slot.
  const v = await view(p, made.id);
  assert.equal(v.month.spent, run.credits_charged);
  assert.equal(v.month.held, 0);
  assert.equal(v.last_status, "done");
  assert.equal(v.next_run_at, utc("2026-09-26T08:00:00Z"));
  // Nothing more the same day; the next slot runs once more (another slot id).
  c.set(utc("2026-09-25T20:00:00Z"));
  await s.tick();
  assert.equal(runs(s, made.id).length, 1);
  c.set(utc("2026-09-26T08:00:10Z"));
  await s.tick();
  assert.equal(runs(s, made.id).length, 2);
  assert.equal(holdsFor(s, p.user.id, made.id).length, 10);
  // It is in the inbox of the watch, and deleting a report keeps the ledger.
  assert.equal((await inbox(p, "?routine=" + made.id)).length, 2);
  await p.agent.delete("/api/routines/runs/" + run.id).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND amount<0").get(p.user.id).n, 10);
});

test("only new since last time: the last report's key findings ride along as data, and are forgotten with the report", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s);
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const made = await create(p, { new_only: true });
  assert.equal(made.new_only, true);
  const plain = await create(p, { topic: "A plain watch", schedule: { ...daily, time: "08:05" } });
  // The first run has nothing to compare with: no previous block, the ordinary prompts.
  c.set(utc("2026-09-25T08:10:00Z"));
  await s.tick();
  const first = g.calls.slice();
  assert.equal(first.length, 10, "both watches ran");
  for (const call of first) assert.ok(!JSON.stringify(call.body.messages).includes("Previous report"), JSON.stringify(call.body.messages).slice(0, 1500));
  const [w1] = first.filter((x) => x.kind === "write" && JSON.stringify(x.body.messages).includes(TOPIC));
  assert.equal(w1.body.messages[0].content, watchWritePrompt(false), "the ordinary prompt");
  const firstRun = (await inbox(p, "?routine=" + made.id))[0];
  assert.equal(firstRun.research.previous, false);
  g.calls.length = 0;

  // The next day: the plan and the report both see the previous key findings,
  // without citation numbers, as a delimited document with the data notice.
  c.set(utc("2026-09-26T08:10:00Z"));
  await s.tick();
  assert.equal(g.calls.length, 10, "both watches ran again");
  const mine = g.calls.filter((x) => x.kind !== "search" && JSON.stringify(x.body.messages).includes(TOPIC));
  assert.deepEqual(mine.map((x) => x.kind).sort(), ["plan", "write"]);
  const plan = mine.find((x) => x.kind === "plan").body.messages;
  const write = mine.find((x) => x.kind === "write").body.messages;
  const block = /<document name="Previous report: key findings">([\s\S]*?)<\/document>/;
  for (const messages of [plan, write]) {
    const text = messages[1].content;
    const found = block.exec(text);
    assert.ok(found, "the previous block is a delimited document");
    assert.match(found[1], /The AI Office published new guidance on general-purpose models\./);
    assert.match(found[1], /Member states are still naming their regulators\./);
    assert.ok(!/\[\d\]/.test(found[1]), "citation numbers stripped");
    assert.ok(!/Providers must document training data/.test(found[1]), "only the key findings");
    assert.ok(text.includes(DATA_NOTICE), "sent as data");
  }
  assert.match(plan[0].content, /what is new or has changed since that date/);
  // The previous report's date rides with its key findings, in the plan and the report.
  for (const messages of [plan, write]) assert.match(messages[1].content, /The previous report is from 2026-09-25 \(UTC\)\.\n\n<document name="Previous report: key findings">/);
  assert.equal(write[0].content, watchWritePrompt(true));
  // Searches carry only their own sub-question, never the previous report.
  for (const x of g.of("search")) assert.ok(!JSON.stringify(x.body.messages).includes("Previous report"));
  // A watch without "only new" never sends one.
  const others = g.calls.filter((x) => x.kind !== "search" && !JSON.stringify(x.body.messages).includes(TOPIC));
  assert.equal(others.length, 2);
  for (const x of others) assert.ok(!JSON.stringify(x.body.messages).includes("Previous report"));
  const secondRun = (await inbox(p, "?routine=" + made.id))[0];
  assert.equal(secondRun.research.previous, true);
  // The dearer prompts were held at their maximum: the quote for "only new".
  const dearer = await quote(p, { new_only: true });
  assert.equal(made.per_run_credits, dearer.credits);
  const held = holdsFor(s, p.user.id, made.id).filter((h) => h.id.includes(`_${utc("2026-09-26T08:00:00Z")}:`));
  assert.equal(held.reduce((n, h) => n + h.amount, 0), units(dearer.credits));

  // Delete the newest report and the watch forgets it: the next run compares
  // with the one before, and with none once both are gone.
  g.calls.length = 0;
  await p.agent.delete("/api/routines/runs/" + secondRun.id).expect(200);
  await p.agent.delete("/api/routines/runs/" + firstRun.id).expect(200);
  c.set(utc("2026-09-27T08:10:00Z"));
  await s.tick();
  assert.ok(!JSON.stringify(g.calls.map((x) => x.body.messages)).includes("Previous report"));
  assert.equal((await inbox(p, "?routine=" + made.id))[0].research.previous, false);
  assert.ok(plain.id);
});

test("key findings are taken from a report's own section, tolerantly", () => {
  assert.equal(
    keyFindings(REPORT),
    "- The AI Office published new guidance on general-purpose models.\n- Member states are still naming their regulators.",
  );
  // The "only new" format puts What's new first; the baseline is Key findings.
  const fresh =
    "# Title\n\n**What's new**\n\n- A change [1].\n\n**Key findings**\n\n- Where it stands now [2][3].\n- More: https://x.example.org/a [4].\n\n## Details\n\nMore text.";
  assert.equal(keyFindings(fresh), "- Where it stands now.\n- More:.");
  assert.equal(keyFindings("## Key findings\n\n- A\n- B\n\n## Next\n\nno"), "- A\n- B");
  assert.equal(keyFindings("Key findings:\n- A\n- B"), "- A\n- B");
  // No such section: the opening text, without the title.
  assert.equal(keyFindings("# Title\n\nJust prose [1]."), "Just prose.");
  assert.equal(keyFindings(""), "");
  // Never longer than the limit, and cut at a line end or a sentence.
  const long = "**Key findings**\n\n" + Array.from({ length: 400 }, (_, i) => `- Finding number ${i} is here.`).join("\n");
  const cut = keyFindings(long);
  assert.ok(cut.length <= MAX_PREVIOUS);
  assert.ok(cut.endsWith("here."));
  assert.equal(keyFindings(long, 100).length <= 100, true);
});

test("every step's prompt says today's date, and the planner and searches prefer recent items", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s);
  const { c, made } = await due(t, s, p, { new_only: true });
  await s.tick();
  const today = "Today is 2026-09-25 (UTC).";
  assert.equal(todayLine(), today, "the clock the run reads");
  assert.equal(g.calls.length, 5);
  for (const call of g.calls) assert.ok(call.body.messages[0].content.includes(today), `${call.kind} says today's date`);
  const [plan] = g.of("plan");
  assert.match(plan.body.messages[0].content, /prefer recent items and include the current year in the sub-questions/);
  for (const search of g.of("search")) assert.match(search.body.messages[0].content, /Prefer recent pages, and do not present items from earlier years as current/);
  assert.match(g.of("write")[0].body.messages[0].content, /Findings from earlier years are background, not the latest news/);
  // The next day the date moves on, and "only new" tells the model when the previous report was made.
  g.calls.length = 0;
  c.set(utc("2026-10-02T08:00:30Z"));
  await s.tick();
  for (const call of g.calls) assert.ok(call.body.messages[0].content.includes("Today is 2026-10-02 (UTC)."), call.kind);
  for (const call of [g.of("plan")[0], g.of("write")[0]]) {
    assert.match(call.body.messages[1].content, /The previous report is from 2026-09-25 \(UTC\)\./);
    assert.ok(!call.body.messages[1].content.includes("2026-10-02"), "the report's own date isn't in the data");
  }
  assert.match(g.of("write")[0].body.messages[0].content, /with the date of that report\. Report what is new or has changed since that date\./);
  // The date is always ten characters, so the quote prices the prompt a run sends.
  assert.equal(todayLine(utc("2026-01-01T00:00:00Z")).length, todayLine(utc("2026-12-31T23:59:59Z")).length);
  assert.ok(made.id);
});

// ---- Money ----

test("a run that the balance, spending limits, monthly budget or agreed maximum can't cover is refused before anything is held or sent", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  // Each case is its own service, so one watch's run never counts in another's.
  const world = async () => {
    const g = await gateway(t);
    const s = fixture(t, { gatewayUrl: g.url });
    const p = await person(s);
    c.set(utc("2026-09-25T07:00:00Z"));
    return { g, s, p, q: await quote(p) };
  };
  const nextSlot = async (w) => {
    c.set(utc("2026-09-25T08:00:30Z"));
    await w.s.tick();
  };
  const refused = (w, id, code) => {
    const r = runs(w.s, id).at(-1);
    assert.equal(r.status, "refused");
    assert.equal(r.code, code);
    assert.equal(r.charged, 0);
    assert.equal(r.research, null);
    assert.equal(w.g.calls.length, 0, "nothing was sent");
    return r;
  };

  // The monthly budget: what's left this month can't cover a whole run.
  const a = await world();
  const budgeted = await create(a.p, { monthly_budget_credits: a.q.credits + 10 });
  const spent = `${a.p.user.id}:routine_${budgeted.id}_1`;
  reserve(a.s.db, { id: spent, user: a.p.user.id, amount: units(11) });
  settle(a.s.db, spent, units(11));
  assert.equal((await view(a.p, budgeted.id)).month.spent, 11);
  await nextSlot(a);
  const r = refused(a, budgeted.id, "routine_budget");
  assert.match(r.message, /monthly budget has \d/);
  assert.equal(holdsFor(a.s, a.p.user.id, budgeted.id).length, 1, "only the earlier charge");
  // A new month starts the budget again.
  c.set(utc("2026-10-01T08:00:30Z"));
  await a.s.tick();
  assert.equal(runs(a.s, budgeted.id).at(-1).status, "done");
  assert.equal(a.g.calls.length, 5);

  // The price went up after the watch was saved: refused, with a way out; saving the
  // watch again accepts the new maximum.
  const b = await world();
  const stale = await create(b.p);
  b.s.db.prepare("UPDATE routines SET run_cap=? WHERE id=?").run(units(b.q.credits) - 1, stale.id);
  await nextSlot(b);
  assert.match(refused(b, stale.id, "routine_run_cap").message, /Open the watch and save it/);
  assert.equal(holdsFor(b.s, b.p.user.id, stale.id).length, 0);
  await b.p.agent.patch("/api/research-watches/" + stale.id).send({ name: "Renamed" }).expect(200);
  c.set(utc("2026-09-26T08:00:30Z"));
  await b.s.tick();
  assert.equal(runs(b.s, stale.id).at(-1).status, "done");

  // The account's balance.
  const d = await world();
  const broke = await create(d.p);
  const drain = uid("drain_");
  reserve(d.s.db, { id: drain, user: d.p.user.id, amount: balance(d.s.db, d.p.user.id).available - 5 });
  settle(d.s.db, drain, balance(d.s.db, d.p.user.id).held);
  await nextSlot(d);
  refused(d, broke.id, "insufficient_credits");
  assert.equal(holdsFor(d.s, d.p.user.id, broke.id).length, 0, "a partly held run is undone");
  assert.equal(d.s.db.prepare("SELECT COUNT(*) n FROM holds WHERE user_id=? AND status='held'").get(d.p.user.id).n, 0);

  // Enough for the plan and some searches but not the whole run: still none of it is held.
  const f = await world();
  const partial = await create(f.p);
  const room = balance(f.s.db, f.p.user.id).available - units(f.q.credits) + units(f.q.steps.write) - 1;
  reserve(f.s.db, { id: uid("drain_"), user: f.p.user.id, amount: room });
  assert.ok(balance(f.s.db, f.p.user.id).available < units(f.q.credits));
  await nextSlot(f);
  refused(f, partial.id, "insufficient_credits");
  assert.equal(holdsFor(f.s, f.p.user.id, partial.id).length, 0, "the steps held before the failure are undone");

  // The account's own spending limits.
  const e = await world();
  const limited = await create(e.p);
  await e.p.agent.patch("/api/spending-limits").send({ daily_limit: 0 }).expect(200);
  await nextSlot(e);
  refused(e, limited.id, "spending_limit");
  assert.equal(holdsFor(e.s, e.p.user.id, limited.id).length, 0);
  assert.equal((await inbox(e.p))[0].credits_charged, 0);
  assert.equal(balance(e.s.db, e.p.user.id).held, 0);
});

test("a step that can't be used costs nothing: an unusable plan, failed searches, an empty or cut-off report", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const paid = (r) => r.research.steps.map((x) => [x.kind, x.status, x.credits > 0]);
  const run = async (script, extra = {}) => {
    const g = await gateway(t, script);
    const s = fixture(t, { gatewayUrl: g.url });
    const p = await person(s);
    c.set(utc("2026-09-25T07:00:00Z"));
    const made = await create(p, extra);
    c.set(utc("2026-09-25T08:00:30Z"));
    await s.tick();
    const [r] = await inbox(p);
    return { g, s, p, made, r, holds: holdsFor(s, p.user.id, made.id) };
  };

  // A plan that isn't the JSON asked for is released, uncharged, and the
  // topic itself is the one search.
  const prose = await run({ plan: "Sure! Here is how I would research it." });
  assert.equal(prose.r.status, "done");
  assert.deepEqual(prose.r.research.questions, [TOPIC]);
  assert.deepEqual(paid(prose.r), [["plan", "failed", false], ["search", "done", true], ["write", "done", true]]);
  assert.equal(prose.g.of("search").length, 1);
  assert.equal(prose.g.of("search")[0].body.messages[1].content, TOPIC);
  assert.equal(prose.holds.find((h) => stepOf(h.id) === "plan").status, "released");
  assert.ok(prose.holds.filter((h) => stepOf(h.id).startsWith("search") && stepOf(h.id) !== "search1").every((h) => h.status === "released"));
  // The plan may arrive in a fence, like Deep Research's.
  const fenced = await run({ plan: "```json\n" + JSON.stringify({ questions: PLAN.slice(0, 2) }) + "\n```" });
  assert.equal(fenced.g.of("search").length, 2);
  assert.equal(paid(fenced.r)[0].join(), "plan,done,true");

  // One search fails: released, the report uses the rest.
  const one = await run({ search: (i) => (i === 1 ? { status: 500 } : { text: "Findings " + i, sources: [SOURCE(i + 1)] }) });
  assert.equal(one.r.status, "done");
  assert.equal(one.r.research.steps.filter((x) => x.kind === "search" && x.status === "failed").length, 1);
  assert.equal(one.holds.filter((h) => h.status === "released").length, 1);
  assert.equal(one.holds.filter((h) => h.status === "settled").length, 4);
  assert.equal(one.g.of("write").length, 1);

  // Every search fails: nothing usable, so nothing at all is charged, plan included.
  const none = await run({ search: { status: 500 } });
  assert.equal(none.r.status, "failed");
  assert.equal(none.r.code, "research_no_results");
  assert.equal(none.r.credits_charged, 0);
  assert.equal(none.g.of("write").length, 0, "no report was asked for");
  assert.ok(none.holds.every((h) => h.status === "released"), "every hold released");
  assert.equal(balance(none.s.db, none.p.user.id).held, 0);
  assert.equal(none.s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE amount<0").get().n, 0);
  assert.equal(none.r.answer, null);
  assert.equal((await view(none.p, none.made.id)).last_status, "failed");
  // A search that answers nothing is unusable too.
  const blank = await run({ search: "   " });
  assert.equal(blank.r.code, "research_no_results");
  assert.equal(blank.r.credits_charged, 0);

  // The report fails: the searches' findings are delivered, the report step
  // isn't charged.
  const failed = await run({ write: { status: 500 } });
  assert.equal(failed.r.status, "done");
  assert.equal(failed.r.code, "research_report_failed");
  assert.match(failed.r.message, /The report step wasn't charged/);
  assert.equal(failed.r.finish_reason, "interrupted");
  assert.match(failed.r.answer, /^### 1\. What has the EU AI Office announced recently\?/);
  assert.match(failed.r.answer, /Findings for What has the EU AI Office/);
  assert.equal(failed.r.citations.length, 6);
  assert.deepEqual(paid(failed.r).map((x) => x.join()), ["plan,done,true", "search,done,true", "search,done,true", "search,done,true", "write,failed,false"]);
  assert.equal(failed.holds.find((h) => stepOf(h.id) === "write").status, "released");
  // Empty, or cut off with nothing in it, is the same.
  const empty = await run({ write: "  " });
  assert.equal(empty.r.code, "research_report_failed");
  const cutOff = await run({ write: { text: "", finish: "length" } });
  assert.equal(cutOff.r.code, "research_report_failed");
  assert.equal(cutOff.holds.find((h) => stepOf(h.id) === "write").status, "released");

  // A report cut short but with content is kept, charged, and says so.
  const short = await run({ write: { text: REPORT, finish: "length" } });
  assert.equal(short.r.status, "done");
  assert.equal(short.r.finish_reason, "length");
  assert.match(short.r.answer, /\*Cut short: the model reached its reply limit/);
  assert.equal(short.r.code, null);
  // A topic written in Chinese gets the Chinese note, as Deep Research's does.
  const zhRun = await run({ write: { text: REPORT, finish: "length" } }, { topic: "欧盟人工智能法案的执行情况" });
  assert.match(zhRun.r.answer, /已截断/);
});

test("Private models only: zero-data-retention routing on every step, never the backup gateway", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url, privateModels: [MODEL] });
  const p = await person(s);
  const made = await create(p, { private_only: true });
  assert.equal(made.private_only, true);
  assert.equal(made.web_search, true);
  const q = await quote(p, { private_only: true });
  assert.equal(made.per_run_credits, q.credits);
  c.set(utc("2026-09-25T08:00:30Z"));
  await s.tick();
  assert.equal(g.calls.length, 5);
  assert.ok(g.calls.every((x) => x.body.provider?.zdr === true), "ZDR routing on every step");
  const [r] = await inbox(p);
  assert.equal(r.status, "done");
  assert.equal(r.private_only, true);
  // A private watch labels its steps as chat and web search only.
  const tags = s.db.prepare("SELECT DISTINCT feature FROM usage_tags ORDER BY feature").all();
  assert.deepEqual(tags.map((x) => x.feature), ["chat", "web_search"]);
  // The model stops being private: the run is refused, nothing sent.
  const g2 = await gateway(t);
  const s2 = fixture(t, { gatewayUrl: g2.url, privateModels: [MODEL] });
  const p2 = await person(s2);
  const other = await create(p2, { private_only: true });
  s2.cfg.privateModels = [];
  c.set(utc("2026-09-26T08:00:30Z"));
  await s2.tick();
  const [refused] = runs(s2, other.id);
  assert.equal(refused.status, "refused");
  assert.equal(refused.code, "private_model_required");
  assert.equal(g2.calls.length, 0);
});

test("a delivered report tells Push Alerts, if it is there: ids only, and nothing depends on it", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s);
  const made = await create(p, { name: "Secret name", topic: "A private topic" });
  const seen = [];
  s.setPushAlerts({ notify: (event) => seen.push(event) });
  c.set(utc("2026-09-25T08:00:30Z"));
  await s.tick();
  const [run] = await inbox(p);
  assert.deepEqual(seen, [{ user: p.user.id, kind: "research_report", routine: made.id, run: run.id }]);
  assert.ok(!JSON.stringify(seen).includes("private topic") && !JSON.stringify(seen).includes("Secret name"));
  // A refused run isn't a report. A hook that throws changes nothing.
  s.setPushAlerts({ notify: () => { throw new Error("boom"); } });
  c.set(utc("2026-09-26T08:00:30Z"));
  await s.tick();
  assert.equal((await inbox(p)).length, 2);
  assert.equal((await inbox(p))[0].status, "done");
  s.setPushAlerts({ notify: (event) => seen.push(event) });
  s.db.prepare("UPDATE routines SET run_cap=1 WHERE id=?").run(made.id);
  c.set(utc("2026-09-27T08:00:30Z"));
  await s.tick();
  assert.equal((await inbox(p))[0].status, "refused");
  assert.equal(seen.length, 1, "no alert for a refusal");
});

test("a topic that is a seed phrase by the time it runs is refused, with nothing sent", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s);
  const made = await create(p);
  s.db.prepare("UPDATE routines SET prompt=? WHERE id=?").run("Check " + SEED, made.id);
  c.set(utc("2026-09-25T08:00:30Z"));
  await s.tick();
  const [r] = runs(s, made.id);
  assert.equal(r.status, "refused");
  assert.equal(r.code, "seed_phrase_blocked");
  assert.equal(g.calls.length, 0);
  assert.equal(holdsFor(s, p.user.id, made.id).length, 0);
});

test("one run at a time per watch; stopping a run keeps and charges only what finished", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  // The second and third searches hang until the run is stopped.
  const g = await gateway(t, { search: (i) => (i === 0 ? { text: "Findings one", sources: [SOURCE(1)] } : null) });
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s);
  const made = await create(p);
  c.set(utc("2026-09-25T08:00:30Z"));
  const first = s.tick();
  // Claimed and held synchronously: running, with every step's hold in place.
  let [run] = runs(s, made.id);
  assert.equal(run.status, "running");
  assert.equal(run.kind, "research");
  assert.equal(holdsFor(s, p.user.id, made.id).length, 5);
  assert.ok(holdsFor(s, p.user.id, made.id).every((h) => h.status === "held"));
  assert.equal((await view(p, made.id)).running, true);
  assert.equal((await p.agent.delete("/api/research-watches/" + made.id).expect(409)).body.error.code, "routine_running");
  // The next day's slot comes due while it runs: no second run.
  c.set(utc("2026-09-26T08:00:30Z"));
  s.routines.startDue();
  assert.equal(runs(s, made.id).length, 1);
  // Wait until the first search has settled, then stop the account's runs.
  for (let i = 0; i < 200 && !holdsFor(s, p.user.id, made.id).some((h) => h.status === "settled"); i++)
    await new Promise((r) => setTimeout(r, 10));
  s.routines.cancelFor(p.user.id);
  await first;
  [run] = runs(s, made.id);
  assert.equal(run.status, "done");
  assert.equal(run.code, "research_stopped");
  assert.equal(run.finish_reason, "interrupted");
  assert.match(run.answer, /Findings one/);
  const holds = holdsFor(s, p.user.id, made.id);
  assert.equal(holds.filter((h) => h.status === "settled").length, 2, "the plan and the finished search");
  assert.equal(holds.filter((h) => h.status === "held").length, 0);
  assert.equal(balance(s.db, p.user.id).held, 0);
  assert.ok(run.charged > 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND amount<0").get(p.user.id).n, 2);
});

test("Early Model Access: a model still in its early days can't be chosen below Insider, and each run checks again", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const g = await gateway(t);
  const s = fixture(t, {
    gatewayUrl: g.url,
    token: NYMA_CONTRACT,
    chain: 4663,
    rpc: "http://127.0.0.1:1",
  });
  const p = await person(s);
  const made = await create(p);
  const newly = () =>
    s.db
      .prepare("INSERT INTO model_first_seen(catalog,id,first_seen) VALUES('models',?,?) ON CONFLICT(catalog,id) DO UPDATE SET first_seen=excluded.first_seen")
      .run(MODEL, now());
  // The model goes early after the watch was saved: the run is refused before anything is held or sent.
  newly();
  c.set(utc("2026-09-25T08:00:30Z"));
  await s.tick();
  const [r] = runs(s, made.id);
  assert.equal(r.status, "refused");
  assert.equal(r.code, "early_model");
  assert.equal(g.calls.length, 0);
  assert.equal(holdsFor(s, p.user.id, made.id).length, 0);
  // And it can't be chosen, quoted or saved.
  for (const send of [
    () => p.agent.post("/api/research-watches/quote").send({ model: MODEL, depth: "quick" }),
    () => p.agent.post("/api/research-watches").send(body({ topic: "Another" })),
    () => p.agent.patch("/api/research-watches/" + made.id).send({ model: MODEL }),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "early_model");
  }
});

test("a run interrupted by a restart is recorded as failed, with what its finished steps were charged, and frees its watch", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-research-watch-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const open = () =>
    createApp({
      testMode: true,
      released: "all",
      dbPath: join(dir, "test.sqlite"),
      mediaPath: join(dir, "media"),
      catalogPath: join(dir, "models.json"),
      origin: ORIGIN,
    });
  const first = open();
  const p = await person(first);
  const made = await create(p);
  const slot = utc("2026-09-25T08:00:00Z");
  first.db.prepare("UPDATE routines SET running_since=? WHERE id=?").run(now(), made.id);
  first.db
    .prepare("INSERT INTO routine_runs(id,routine_id,user_id,slot,started,status,request_id,kind) VALUES('rr_cut',?,?,?,?,'running',?,'research')")
    .run(made.id, p.user.id, slot, now(), `routine_${made.id}_${slot}`);
  // The plan had settled before the restart; a search was still running.
  const plan = `${p.user.id}:routine_${made.id}_${slot}:plan`;
  reserve(first.db, { id: plan, user: p.user.id, amount: units(5) });
  settle(first.db, plan, units(2));
  reserve(first.db, { id: `${p.user.id}:routine_${made.id}_${slot}:search1`, user: p.user.id, amount: units(20) });
  await first.stopWork();
  first.close();
  const second = open();
  const row = second.db.prepare("SELECT * FROM routine_runs WHERE id='rr_cut'").get();
  assert.equal(row.status, "failed");
  assert.equal(row.code, "interrupted");
  assert.equal(row.charged, units(2), "the plan that finished stays charged");
  assert.equal(second.db.prepare("SELECT running_since,last_status FROM routines WHERE id=?").get(made.id).running_since, null);
});

test("after downtime only the latest missed slot runs, once", async (t) => {
  const c = clock(t, utc("2026-09-21T07:00:00Z"));
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s);
  const made = await create(p);
  c.set(utc("2026-09-24T09:15:00Z"));
  await s.tick();
  await s.tick();
  assert.equal(runs(s, made.id).length, 1);
  const [only] = runs(s, made.id);
  assert.equal(only.slot, utc("2026-09-24T08:00:00Z"));
  assert.equal(only.skipped, 3);
  assert.equal((await inbox(p))[0].skipped, 3);
  assert.equal(holdsFor(s, p.user.id, made.id).length, 5, "one run's holds");
});

// ---- Erase and export ----

test("the account export has the watch and its reports; closing the account, a wipe and the erase remove them", async (t) => {
  const c = clock(t, utc("2026-09-25T07:00:00Z"));
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s);
  const made = await create(p, { new_only: true });
  c.set(utc("2026-09-25T08:00:30Z"));
  await s.tick();
  const exported = (await p.agent.get("/api/account/export").expect(200)).body;
  const w = exported.routines.routines.find((x) => x.id === made.id);
  assert.equal(w.kind, "research");
  assert.equal(w.topic, TOPIC);
  assert.equal(w.depth, "quick");
  assert.equal(w.new_only, true);
  const r = exported.routines.runs.find((x) => x.routine_id === made.id);
  assert.match(r.answer, /AI Act briefing/);
  assert.equal(r.kind, "research");
  assert.equal(r.research.steps.length, 5);
  assert.equal(r.citations.length, 6);

  // The shared erase (closure, Panic Wipe and Inactivity Wipe use it).
  const erased = await person(s);
  const gone = await create(erased);
  c.set(utc("2026-09-26T08:00:30Z"));
  await s.tick();
  assert.equal(runs(s, gone.id).length, 1);
  s.db.exec("BEGIN");
  eraseAccountContent(s.db, erased.user);
  s.db.exec("COMMIT");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM routines WHERE user_id=?").get(erased.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM routine_runs WHERE user_id=?").get(erased.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM usage_tags WHERE hold_id LIKE ?").get(`${erased.user.id}:%`).n >= 0, true);
  // The ledger keeps the charges.
  assert.ok(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND amount<0").get(erased.user.id).n > 0);

  // Panic Wipe.
  await p.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM routines WHERE user_id=?").get(p.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM routine_runs WHERE user_id=?").get(p.user.id).n, 0);
  // Closing the account.
  const closing = await person(s);
  const shut = await create(closing);
  await closing.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM routines WHERE id=?").get(shut.id).n, 0);
  c.set(utc("2026-09-27T08:00:30Z"));
  await s.tick();
  assert.equal(runs(s, shut.id).length, 0);
});

test("rate limits: quotes per minute, changes per hour", async (t) => {
  const s = fixture(t);
  const p = await person(s);
  const made = await create(p);
  for (let i = 0; i < 119; i++)
    await p.agent.patch("/api/research-watches/" + made.id).send({ enabled: false }).expect(200);
  await p.agent.patch("/api/research-watches/" + made.id).send({ enabled: false }).expect(429);
  for (let i = 0; i < 120; i++) await p.agent.get("/api/research-watches").expect(200);
  await p.agent.get("/api/research-watches").expect(429);
});

// ---- The page ----

// ResearchWatch.jsx and Routines.jsx compiled for Node with the same esbuild
// Vite uses. Shared UI, routing and markdown are swapped for plain stand-ins
// so only these pages' own text is rendered. `params` is what the URL says.
async function pageModules(params = "") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-research-watch-ui-"));
  const react = import.meta.resolve("react");
  const write = (name, code) => {
    writeFileSync(join(dir, name), code);
    return pathToFileURL(join(dir, name)).href;
  };
  const stub = (name, body) => write(name, `import React from "${react}";\n` + body);
  const ui = stub(
    "ui.mjs",
    `export const Icon = () => null;
     export const Button = ({ children, secondary, ...p }) => React.createElement("button", p, children);
     export const Notice = ({ children }) => React.createElement("div", { className: "notice" }, children);
     export const Empty = ({ title, children }) => React.createElement("div", null, React.createElement("h3", null, title), React.createElement("p", null, children));
     export const CopyButton = ({ label = "Copy" }) => React.createElement("button", null, label);`,
  );
  const router = stub(
    "router.mjs",
    `export const Link = ({ children, to }) => React.createElement("a", { href: to }, children);
     export const useSearchParams = () => [new URLSearchParams(${JSON.stringify(params)}), () => {}];`,
  );
  const inert = stub("inert.mjs", `export const ReplyMarkdown = ({ children }) => React.createElement("div", null, children); export default () => null;`);
  const gfm = stub("gfm.mjs", "export default () => {};");
  const watch = stub(
    "page-watch.mjs",
    `export const WatchesTab = () => null;
     export const WatchReportCard = () => null;
     export const demoWatchState = () => ({ watches: [], reports: [] });
     export const markWatchesSeen = () => {};`,
  );
  const abs = (f) => new URL("../src/" + f, import.meta.url);
  const compile = async (file, extra) => {
    const src = abs(file);
    const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
    const out = code
      .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
      .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
      .replace(/from "react-router-dom"/g, `from "${router}"`)
      .replace(/from "\.\/lib\.js"/g, `from "${abs("lib.js")}"`)
      .replace(/from "\.\/routines\.js"/g, `from "${abs("routines.js")}"`)
      .replace(/from "\.\/deep-research\.js"/g, `from "${abs("deep-research.js")}"`)
      .replace(/from "\.\/research-watch\.js"/g, `from "${abs("research-watch.js")}"`)
      .replace(/from "\.\/page-watch\.js"/g, `from "${abs("page-watch.js")}"`)
      .replace(/from "\.\/PageWatch\.jsx"/g, `from "${watch}"`)
      .replace(/from "\.\/SignedReceipt\.jsx"/g, `from "${inert}"`)
      .replace(/from "\.\/RichMarkdown\.jsx"/g, `from "${inert}"`)
      .replace(/from "remark-gfm"/g, `from "${gfm}"`)
      .replace(/from "react"/g, `from "${react}"`);
    return extra ? extra(out) : out;
  };
  const research = write("ResearchWatch.mjs", await compile("ResearchWatch.jsx"));
  const page = write("Routines.mjs", (await compile("Routines.jsx")).replace(/from "\.\/ResearchWatch\.jsx"/g, `from "${research}"`));
  try {
    return { research: await import(research), routines: await import(page) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
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
const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
const han = /\p{Script=Han}/u;
const liveConfig = { releases: { features: { routines: true, search: true, private: true, deepresearch: true, researchwatch: true } } };

test("the tab, editor, cards and report details: the user's and the model's words stay as written, the rest translates", async () => {
  const { research, routines } = await pageModules("watch=new");
  const models = [
    { id: "m-1", name: "Gemini 2.5 Flash", type: "chat", callable: true },
    { id: "m-2", name: "Venice Uncensored", type: "chat", callable: true, private: true },
  ];
  const { watches, runs } = research.demoResearchState();
  const failedRun = {
    ...runs[0],
    id: "f",
    status: "failed",
    code: "research_no_results",
    answer: null,
    citations: [],
    research: null,
    credits_charged: 0,
  };
  const partial = {
    ...runs[0],
    id: "p",
    code: "research_report_failed",
    finish_reason: "interrupted",
    research: { ...runs[0].research, new_only: false, steps: runs[0].research.steps.map((s) => ({ ...s, status: s.kind === "write" ? "skipped" : s.status })) },
  };
  const refused = ["routine_budget", "routine_run_cap", "seed_phrase_blocked", "research_unavailable", "research_stopped"].map((code, i) => ({
    ...failedRun,
    id: "r" + i,
    status: "refused",
    code,
  }));
  const draft = {
    id: null,
    name: "",
    topic: "My own watch topic",
    model: "m-1",
    depth: "quick",
    new_only: true,
    private_only: false,
    repeat: "weekly",
    day: 1,
    time: "08:00",
    timezone: "UTC",
    monthly_budget_credits: "500",
    enabled: true,
  };
  const props = { demo: true, live: false, models, config: liveConfig, busy: false, error: "", onSave() {}, onCancel() {}, onDelete() {}, setDraft() {} };
  const html = [
    // The tab, with the URL asking for a new watch: the editor is open.
    renderToStaticMarkup(
      createElement(research.ResearchTab, {
        demo: true,
        live: false,
        models,
        config: liveConfig,
        watches,
        setWatches() {},
        reload() {},
        setError() {},
        nameOf: (id) => (id === "demo-model" ? "Gemini 2.5 Flash" : id),
        onReports() {},
      }),
    ),
    renderToStaticMarkup(createElement(research.WatchEditor, { ...props, draft })),
    renderToStaticMarkup(createElement(research.WatchEditor, { ...props, draft: { ...draft, id: "x", depth: "thorough", repeat: "daily", private_only: true, enabled: false, monthly_budget_credits: "10" } })),
    renderToStaticMarkup(createElement(research.WatchCard, { w: { ...watches[0], running: true, private_only: true }, modelName: "Gemini 2.5 Flash" })),
    renderToStaticMarkup(createElement(research.WatchCard, { w: { ...watches[0], enabled: false, new_only: false, depth: "thorough" }, modelName: "Gemini 2.5 Flash" })),
    ...[runs[0], failedRun, partial, ...refused].map((run) =>
      renderToStaticMarkup(createElement(routines.RunCard, { run, modelName: "Gemini 2.5 Flash" })),
    ),
    renderToStaticMarkup(
      createElement(research.ResearchRunDetails, {
        run: { ...runs[0], research: { ...runs[0].research, previous: false, steps: [...runs[0].research.steps, { kind: "search", status: "stopped", sources: 0, credits: 0 }] } },
      }),
    ),
    renderToStaticMarkup(createElement(routines.default, { demo: true, user: null, models, config: liveConfig })),
  ].join("");
  const { page, kept } = textsOf(html);
  // The user's and the model's words stay as written.
  for (const text of ["EU AI Act enforcement", "Gemini 2.5 Flash", "Example source one", "UTC", "What has the EU AI Office announced this week?"])
    assert.ok(kept.includes(text), `kept as written: ${text}`);
  assert.ok(kept.some((t) => t.startsWith("What is changing in how the EU AI Act")), "the topic");
  assert.ok(kept.some((t) => t.includes("a prepared demo report")), "the report");
  // The report's sources are a numbered list (its [n] citations are these).
  assert.match(html, /<ol><li><a href="https:\/\/example\.com\/ai-act-guidance"/);
  assert.match(html, /class="run-kind">Research watch</);
  // Everything else is the page's own, and has a translation.
  for (const text of [
    "New research watch",
    "Edit research watch",
    "Only what's new since last time",
    "Compared with the last report",
    "Up to 95.2568 credits per run",
  ])
    assert.ok(page.some((t) => t === text) || html.includes(entitiesOut(text)), `shown: ${text}`);
  const date = /^\d{1,2}\/\d{1,2}\/\d{4}, \d{1,2}:\d{2} [AP]M$/;
  for (const text of page) {
    if (date.test(text)) {
      assert.ok(translateText(text, zh), `date: ${text}`);
      continue;
    }
    assert.match(translateText(text, zh) ?? "", han, `untranslated: ${text}`);
  }
});
const entitiesOut = (s) => s.replace(/'/g, "&#x27;");

test("a new watch starts on the cheapest priced model", async () => {
  const { research } = await pageModules();
  const m = (id, i, o) => ({ id, name: id, pricing: { input_per_1M_tokens: i, output_per_1M_tokens: o } });
  assert.equal(research.defaultModel([m("big", 10, 50), m("small", 0.1, 0.4), m("mid", 1, 4)]), "small");
  assert.equal(research.defaultModel([{ id: "unpriced", name: "x" }, m("mid", 1, 4)]), "mid");
  assert.equal(research.defaultModel([{ id: "only", name: "x" }]), "only");
  assert.equal(research.defaultModel([]), "");
});

test("Research watch shows only once it, Routines, Deep Research and Live Web Search are released", async () => {
  const { research, routines } = await pageModules();
  const on = liveConfig;
  assert.equal(research.researchWatchLive({}), false);
  assert.equal(research.researchWatchLive(on), true);
  for (const missing of ["routines", "deepresearch", "search", "researchwatch"]) {
    const f = { ...on.releases.features, [missing]: false };
    assert.equal(research.researchWatchLive({ releases: { features: f } }), false, missing);
  }
  const models = [{ id: "m-1", name: "Gemini 2.5 Flash", type: "chat", callable: true }];
  const shown = renderToStaticMarkup(createElement(routines.default, { demo: true, user: null, models, config: on }));
  assert.match(shown, /Research watch<span class="routines-count">1\/5<\/span>/);
  assert.match(shown, /<option value="#research" disabled="">Research watch<\/option>/);
  assert.match(shown, /EU AI Act enforcement/, "its report is in the inbox");
  const before = renderToStaticMarkup(
    createElement(routines.default, { demo: true, user: null, models, config: { releases: { features: { routines: true } } } }),
  );
  assert.ok(!/Research watch|EU AI Act/.test(before), "nothing before release");
  assert.ok(!/research-watches/.test(before));
  // Live, it asks the server for its watches only once released.
  const src = readFileSync(new URL("../src/Routines.jsx", import.meta.url), "utf8");
  assert.match(src, /researchLive \? api\("\/api\/research-watches"\) : null/);
  assert.match(src, /\{researchLive && \(\s*<button[\s\S]{0,200}?onClick=\{\(\) => setTab\("research"\)\}/);
  assert.match(src, /tab === "research" && researchLive \?/);
});

test("the tab, the open watch and the inbox filter are in the URL", async () => {
  const models = [{ id: "m-1", name: "Gemini 2.5 Flash", type: "chat", callable: true }];
  const draftHtml = async (params, config = liveConfig) => {
    const { routines } = await pageModules(params);
    return renderToStaticMarkup(createElement(routines.default, { demo: true, user: null, models, config }));
  };
  // ?tab=research opens the tab; ?watch= opens the editor on that watch or a new one.
  const tab = await draftHtml("tab=research");
  assert.match(tab, /<h2>Research watch<\/h2>/);
  assert.ok(!/research-editor/.test(tab));
  const editing = await draftHtml("tab=research&watch=demo-research");
  assert.match(editing, /<h2>Edit research watch<\/h2>/);
  assert.match(editing, />What is changing in how the EU AI Act is being enforced\?</);
  const created = await draftHtml("tab=research&watch=new");
  assert.match(created, /<h2>New research watch<\/h2>/);
  // A watch that isn't there, and a tab that isn't released, fall back to the inbox.
  assert.ok(!/research-editor/.test(await draftHtml("tab=research&watch=gone")));
  const off = await draftHtml("tab=research", { releases: { features: { routines: true } } });
  assert.match(off, /aria-pressed="true" class="active">Inbox/);
  // The inbox filter: only that watch's reports.
  const filtered = await draftHtml("show=demo-research");
  assert.match(filtered, /EU AI Act enforcement/);
  assert.ok(!/Morning AI news/.test(filtered.replace(/<option[\s\S]*?<\/option>/g, "")), "only the watch's runs");
});

test("every visible string has a Chinese entry, including the release copy and the run notes", async () => {
  const entry = UPDATES.find((u) => u.id === "researchwatch");
  const { research } = await pageModules();
  const strings = [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Research Watch is coming soon.",
    ...Object.values(research.RESEARCH_NOTES),
    ...Object.values(research.RESEARCH_REASONS),
    "Up to 95.2568 credits per run",
    "At least 95.2568 credits, the most one run can cost. 477 credits covers every run this month at its maximum. It's a cap, not a charge.",
    "This budget is below one run's maximum of 95.2568 credits.",
    "3 of 3 searches",
    "2 of 3 searches",
    "12 sources",
    "1 source",
    "First report: nothing to compare with yet",
    "Plan",
    "Report",
    "Done",
    "Failed",
    "Stopped",
    "Not run",
    "Not charged",
    "21.6 credits",
    "Research watch",
    "View reports",
    "Only what's new",
  ];
  for (const s of strings) {
    const t = translateText(s, zh);
    assert.ok(t && t !== s && han.test(t), `no Chinese for ${JSON.stringify(s)} (${t})`);
  }
});
