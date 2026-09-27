import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { addCredit, now } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { roundSealer } from "../server/routes/blind.js";
import {
  CACHE_MS,
  MIN_VOTES,
  addToTally,
  arenaEligible,
  bootstrapIntervals,
  dayBucket,
  fitStrengths,
  leaderboard,
  pairTotals,
  poisson,
  quantile,
  seeded,
  tallyCell,
  toScores,
} from "../server/arena.js";
import { knownPage, sitemap } from "../src/site-routes.js";
import { arenaRanks, arenaReleased, barScale, winPercent } from "../src/arena.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// Two ordinary chat models with different makers.
const ONE = "google/gemini-2.5-flash";
const TWO = "glm-5.3";
// Two Uncensored models (releases.js UNCENSORED_MODELS).
const WILD = "venice/venice-uncensored-1-2";
const WILDER = "venice/venice-uncensored-role-play";

function fixture(t, { released, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-arena-"));
  const clock = { offset: 0 };
  const s = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "catalog.json"),
    origin: "http://localhost:5175",
    arenaClock: () => Date.now() + clock.offset,
    ...(released && released !== "all" ? { mvpModels: [ONE, TWO] } : {}),
    ...extra,
  });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...s, clock };
}
// A stand-in gateway that answers every chat.
async function gateway(t) {
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "A quiet answer" }, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 }, cost: 0.001 })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}
async function live(t, extra = {}) {
  return fixture(t, { testMode: false, gateway: await gateway(t), gatewayKey: "fixture", ...extra });
}
let visitor = 0;
async function person(s, name = "tester") {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username: name, password: "local-fixture-password" })
    .expect(201);
  addCredit(s.db, r.body.user.id, 1e8, "fixture-" + r.body.user.id);
  return { agent, user: r.body.user };
}
const round = async (p, body = {}) => {
  const r = await p.agent
    .post("/api/blind")
    .send({
      models: [ONE, TWO],
      messages: [{ role: "user", content: "Which is better for a quiet weekend?" }],
      max_tokens: 500,
      requestId: "r" + ++visitor,
      ...body,
    })
    .expect(200);
  const events = r.text
    .split("\n\n")
    .filter((x) => x.startsWith("data: {"))
    .map((x) => JSON.parse(x.slice(6)));
  return events.at(-1).blind.round;
};
const vote = (p, token, outcome = "a") => p.agent.post("/api/blind/votes").send({ round: token, outcome }).expect(200);
const consent = (p, body) => p.agent.put("/api/arena/consent").send(body);
const tally = (s) => s.db.prepare("SELECT * FROM arena_tally ORDER BY day,model_lo,model_hi").all();
const counted = (s) => tally(s).reduce((n, r) => n + r.lo_wins + r.hi_wins + r.ties + r.both_bad, 0);
// Rows straight into the aggregate, as `addToTally` would leave them.
function seed(s, rows, day = "2026-09-20") {
  const put = s.db.prepare(
    "INSERT INTO arena_tally(day,model_lo,model_hi,lo_wins,hi_wins,ties,both_bad) VALUES(?,?,?,?,?,?,?)",
  );
  for (const [x, y, xWins, yWins, ties = 0, bad = 0] of rows) {
    const flip = y < x;
    put.run(day, flip ? y : x, flip ? x : y, flip ? yWins : xWins, flip ? xWins : yWins, ties, bad);
  }
}

// ---- The release gate ----

test("unreleased: every Arena route is refused, the page is unknown, and a vote neither asks nor adds", async (t) => {
  const g = await gateway(t);
  const mvp = fixture(t, { released: "mvp,blind", testMode: false, gateway: g, gatewayKey: "fixture" });
  const a = await person(mvp, "ana");
  for (const send of [
    () => request(mvp.app).get("/api/arena"),
    () => request(mvp.app).get("/API/Arena/"),
    () => a.agent.get("/api/arena"),
    () => a.agent.get("/api/arena/consent"),
    () => a.agent.put("/api/arena/consent").send({ contribute: true }),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Blind Arena is coming soon.");
  }
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.arena, false);
  assert.equal(arenaReleased(config), false);
  const entry = config.releases.updates.find((u) => u.id === "arena");
  assert.equal(entry.title, "Blind Arena");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  const doc = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(doc.paths).some((p) => p.includes("arena")));
  assert.doesNotMatch((await request(mvp.app).get("/sitemap.xml").expect(200)).text, /\/arena</);
  if (existsSync("dist/client/index.html")) await request(mvp.app).get("/arena").expect(404);
  // Blind Compare works as before: no question, nothing added or kept.
  const v = (await vote(a, await round(a))).body;
  assert.equal(v.counted, true);
  assert.ok(!("arena" in v));
  assert.equal(mvp.db.prepare("SELECT COUNT(*) n FROM arena_consent").get().n, 0);
  assert.equal(counted(mvp), 0);
  assert.ok(!("blindArena" in (await a.agent.get("/api/account/export").expect(200)).body));

  // It's built on Blind Compare, so it needs that update too.
  const alone = fixture(t, { released: "mvp,arena" });
  const res = await request(alone.app).get("/api/arena").expect(403);
  assert.equal(res.body.error.message, "Blind Compare is coming soon.");
  assert.equal(arenaReleased((await request(alone.app).get("/api/config")).body), false);
  if (existsSync("dist/client/index.html")) await request(alone.app).get("/arena").expect(404);

  const open = fixture(t, { released: "mvp,blind,arena" });
  await request(open.app).get("/api/arena").expect(200);
  const openDoc = (await request(open.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(openDoc.paths["/api/arena"].get);
  assert.ok(openDoc.paths["/api/arena/consent"].get && openDoc.paths["/api/arena/consent"].put);
  assert.match((await request(open.app).get("/sitemap.xml").expect(200)).text, /\/arena</);
  if (existsSync("dist/client/index.html")) await request(open.app).get("/arena").expect(200);
  assert.equal(arenaReleased((await request(open.app).get("/api/config")).body), true);
});

test("the gate covers the routes and the page, and the update reads plainly", () => {
  const gate = (path, method = "GET") => featuresFor({ path, method, body: {} });
  assert.deepEqual(gate("/api/arena"), ["arena", "blind"]);
  assert.deepEqual(gate("/API/ARENA/"), ["arena", "blind"]);
  assert.deepEqual(gate("/api/arena/consent", "PUT"), ["arena", "blind"]);
  assert.deepEqual(gate("/api/arenas"), []);
  assert.ok(!gate("/api/blind/votes", "POST").includes("arena"), "votes stay Blind Compare's alone");
  assert.equal(knownPage("/arena"), false);
  assert.equal(knownPage("/arena", { arena: true }), true);
  assert.doesNotMatch(sitemap("https://a.example"), /\/arena</);
  assert.match(sitemap("https://a.example", { arena: true }), /https:\/\/a\.example\/arena</);
  const entry = UPDATES.find((u) => u.id === "arena");
  assert.equal(entry.tagline, "Which model wins when nobody knows the names?");
  assert.equal(entry.points.length, 3);
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.match(readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8"), /\barena: "podium"/);
});

// ---- The opt-in ----

test("the opt-in: off by default, asked once after a vote, and yes adds that vote once and later ones", async (t) => {
  const s = await live(t);
  const p = await person(s, "voter");
  const logged = [];
  const spy = ["log", "warn", "error", "info"].map((k) => {
    const orig = console[k];
    console[k] = (...args) => logged.push(args.join(" "));
    return () => (console[k] = orig);
  });
  try {
    assert.deepEqual((await p.agent.get("/api/arena/consent").expect(200)).body, { contribute: false, asked: false });
    await request(s.app).get("/api/arena/consent").expect(401);

    // The first vote asks, and adds nothing.
    const first = await round(p);
    const v1 = (await vote(p, first, "a")).body;
    assert.deepEqual(v1.arena, { ask: true, contributing: false, added: false });
    assert.equal(counted(s), 0);
    assert.deepEqual((await p.agent.get("/api/arena/consent")).body, { contribute: false, asked: true });
    // Asked once: an unanswered question is a no, and isn't asked again.
    const v2 = (await vote(p, await round(p), "b")).body;
    assert.deepEqual(v2.arena, { ask: false, contributing: false, added: false });
    assert.equal(counted(s), 0);

    // Yes to the question adds the vote that prompted it, once.
    assert.equal((await consent(p, { contribute: "yes" }).expect(400)).body.error.code, "invalid_request");
    assert.equal((await consent(p, { contribute: false, round: first }).expect(400)).body.error.code, "invalid_request");
    const yes = (await consent(p, { contribute: true, round: first }).expect(200)).body;
    assert.deepEqual(yes, { contribute: true, asked: true, added: true });
    const [row] = tally(s);
    const winner = v1.reveal.a.model;
    assert.equal(row[winner === row.model_lo ? "lo_wins" : "hi_wins"], 1, "A won, whichever model it was");
    assert.equal(row.day, dayBucket(now()));
    assert.equal((await consent(p, { contribute: true, round: first }).expect(200)).body.added, false);
    assert.equal(counted(s), 1);

    // Later votes are added as they're cast; a repeat vote on a round isn't.
    const third = await round(p);
    assert.deepEqual((await vote(p, third, "tie")).body.arena, { ask: false, contributing: true, added: true });
    assert.equal((await vote(p, third, "a")).body.arena.added, false);
    assert.equal(counted(s), 2);

    // No stops future votes; what was added stays.
    assert.deepEqual((await consent(p, { contribute: false }).expect(200)).body, { contribute: false, asked: true, added: false });
    assert.equal((await vote(p, await round(p), "bad")).body.arena.added, false);
    assert.equal(counted(s), 2);

    // Another account can't add someone else's vote.
    const q = await person(s, "stranger");
    await vote(q, await round(q));
    assert.equal((await consent(q, { contribute: true, round: third }).expect(200)).body.added, false);
    assert.equal(counted(s), 2);
  } finally {
    spy.forEach((undo) => undo());
  }
  assert.ok(!logged.some((l) => l.includes(p.user.id) || /weekend/.test(l)), "no account or content in server logs");
});

test("only saved chat and code rounds are added: off the record, Private Mode, Device Vault and Uncensored never are", async (t) => {
  const s = await live(t, { privateModels: [ONE, TWO] });
  const p = await person(s, "private");
  await consent(p, { contribute: true }).expect(200);
  const added = async (body, outcome = "a") => (await vote(p, await round(p, body), outcome)).body.arena.added;
  // Off the record (Device Vault chats are sent the same way).
  assert.equal(await added({ ephemeral: true }), false);
  assert.equal(await added({ private: true }), false);
  assert.equal(await added({ models: [WILD, WILDER], mode: "uncensored" }), false);
  // Saved chat and code rounds are.
  assert.equal(await added({}), true);
  assert.equal(await added({ mode: "code" }, "b"), true);
  assert.equal(counted(s), 2);
  // A token from before the Arena (no mark) is never added.
  const old = roundSealer(s.cfg.secret).seal({ v: 1, id: "br_before", u: p.user.id, a: ONE, b: TWO, t: now(), d: {} });
  assert.equal((await vote(p, old)).body.arena.added, false);
  assert.equal(arenaEligible({ ar: 1 }), true);
  assert.equal(arenaEligible({}), false);
  assert.equal(arenaEligible(null), false);
  // Nor is an off-the-record vote given as the answer to the question.
  const q = await person(s, "quiet");
  const off = await round(q, { ephemeral: true });
  assert.equal((await vote(q, off)).body.arena.ask, true);
  assert.equal((await consent(q, { contribute: true, round: off }).expect(200)).body.added, false);
  assert.equal(counted(s), 2);
});

// ---- The aggregate ----

test("the aggregate: counts per day and pair, with no account id, no vote id and no rowid", async (t) => {
  const s = await live(t);
  const p = await person(s, "counter");
  await consent(p, { contribute: true }).expect(200);
  for (const outcome of ["a", "b", "tie", "bad"]) await vote(p, await round(p), outcome);
  const cols = s.db.prepare("PRAGMA table_info(arena_tally)").all().map((c) => c.name);
  assert.deepEqual(cols, ["day", "model_lo", "model_hi", "lo_wins", "hi_wins", "ties", "both_bad"]);
  assert.throws(() => s.db.prepare("SELECT rowid FROM arena_tally").all(), /rowid/);
  const rows = tally(s);
  assert.equal(rows.length, 1, "one row per day and pair, never one per vote");
  assert.deepEqual([rows[0].model_lo, rows[0].model_hi], [TWO, ONE].sort());
  assert.equal(rows[0].lo_wins + rows[0].hi_wins, 2);
  assert.equal(rows[0].ties, 1);
  assert.equal(rows[0].both_bad, 1);
  assert.match(rows[0].day, /^\d{4}-\d{2}-\d{2}$/);
  const raw = JSON.stringify(rows);
  const ids = s.db.prepare("SELECT id FROM blind_votes").all().map((r) => r.id);
  assert.equal(ids.length, 4);
  for (const secret of [p.user.id, p.user.username, ...ids]) assert.ok(!raw.includes(secret), secret);
  // The consent table holds only the choice.
  assert.deepEqual(
    s.db.prepare("PRAGMA table_info(arena_consent)").all().map((c) => c.name),
    ["user_id", "choice"],
  );

  // The cell a vote lands in, whichever way round it was shown.
  assert.deepEqual(tallyCell("b", "a", "a"), { lo: "a", hi: "b", column: "hi_wins" });
  assert.deepEqual(tallyCell("a", "b", "a"), { lo: "a", hi: "b", column: "lo_wins" });
  assert.deepEqual(tallyCell("b", "a", "b"), { lo: "a", hi: "b", column: "lo_wins" });
  assert.deepEqual(tallyCell("a", "b", "tie"), { lo: "a", hi: "b", column: "ties" });
  assert.deepEqual(tallyCell("b", "a", "bad"), { lo: "a", hi: "b", column: "both_bad" });
  assert.equal(tallyCell("a", "a", "a"), null);
  assert.equal(tallyCell("a", "b", "maybe"), null);
  assert.equal(tallyCell("", "b", "a"), null);
  assert.equal(addToTally(s.db, { a: "x", b: "x", outcome: "a", at: now() }), false);
  // UTC days.
  assert.equal(dayBucket(Date.UTC(2026, 8, 27, 23, 59)), "2026-09-27");
  assert.equal(dayBucket(Date.UTC(2026, 8, 28, 0, 1)), "2026-09-28");
});

// ---- The ranking ----

test("ranking maths: Bradley–Terry on fixtures, ties and both bad as half, seeded intervals around each score", () => {
  // x beats y 3 to 1, y beats z 3 to 1, x beats z 9 to 1: about 190 points
  // a step (400 × log10 3), a little less for the prior.
  const three = [
    { model_lo: "x", model_hi: "y", lo_wins: 30, hi_wins: 10, ties: 0, both_bad: 0 },
    { model_lo: "y", model_hi: "z", lo_wins: 30, hi_wins: 10, ties: 0, both_bad: 0 },
    { model_lo: "x", model_hi: "z", lo_wins: 36, hi_wins: 4, ties: 0, both_bad: 0 },
  ];
  const board = leaderboard(three);
  assert.deepEqual(board.models.map((m) => [m.rank, m.id]), [[1, "x"], [2, "y"], [3, "z"]]);
  const [x, y, z] = board.models;
  assert.ok(Math.abs(x.score - y.score - 191) < 8, `x − y = ${x.score - y.score}`);
  assert.ok(Math.abs(y.score - z.score - 191) < 8, `y − z = ${y.score - z.score}`);
  assert.equal(Math.round((x.score + y.score + z.score) / 3), 1000, "the average model is 1000");
  assert.deepEqual([x.votes, y.votes, z.votes], [80, 80, 80]);
  assert.deepEqual([x.win_rate, y.win_rate, z.win_rate], [0.825, 0.5, 0.175]);
  assert.equal(board.votes, 120);
  for (const m of board.models) assert.ok(m.ci[0] < m.score && m.score < m.ci[1], `${m.id} ${m.ci}`);
  // Seeded: the same votes give the same board.
  assert.deepEqual(leaderboard(three), board);

  // Even: 1000 each. A tie and "both bad" both count half a win each way.
  const even = (ties, bad) =>
    leaderboard([{ model_lo: "a", model_hi: "b", lo_wins: 10, hi_wins: 10, ties, both_bad: bad }]).models;
  assert.deepEqual(even(4, 0).map((m) => [m.score, m.win_rate]), [[1000, 0.5], [1000, 0.5]]);
  const tied = leaderboard([{ model_lo: "a", model_hi: "b", lo_wins: 15, hi_wins: 5, ties: 10, both_bad: 0 }]);
  const bad = leaderboard([{ model_lo: "a", model_hi: "b", lo_wins: 15, hi_wins: 5, ties: 0, both_bad: 10 }]);
  assert.deepEqual(tied.models, bad.models);
  assert.equal(tied.models[0].win_rate, 0.667, "(15 + 10 / 2) / 30");

  // A perfect record stays on the scale, thanks to the prior.
  const perfect = leaderboard([{ model_lo: "a", model_hi: "b", lo_wins: 25, hi_wins: 0, ties: 0, both_bad: 0 }]).models;
  for (const m of perfect) for (const v of [m.score, ...m.ci]) assert.ok(Number.isFinite(v));
  assert.ok(perfect[0].score > 1200 && perfect[0].score < 1500, String(perfect[0].score));
  assert.throws(() => fitStrengths([{ lo: "a", hi: "b", wl: 1, wh: 0, t: 0 }], { prior: 0 }), /prior/);

  // More votes, a narrower range.
  const width = (n) => {
    const m = leaderboard([{ model_lo: "a", model_hi: "b", lo_wins: 2 * n, hi_wins: n, ties: 0, both_bad: 0 }]).models[0];
    return m.ci[1] - m.ci[0];
  };
  assert.ok(width(200) < width(20) / 2, `${width(200)} vs ${width(20)}`);

  // Converges well inside its budget on a full 60-model board.
  const ids = Array.from({ length: 60 }, (_, i) => "m" + String(i).padStart(2, "0"));
  const big = [];
  for (let i = 0; i < ids.length; i++)
    for (let j = i + 1; j < ids.length; j++) big.push({ lo: ids[i], hi: ids[j], wl: 20 + (i % 7), wh: 25 + (j % 5), t: 3 });
  const fit = fitStrengths(big);
  assert.ok(fit.iterations < 1000, `${fit.iterations} iterations`);
  const started = Date.now();
  const intervals = bootstrapIntervals(big, fit, { rounds: 200 });
  assert.ok(Date.now() - started < 5000, "the hourly recompute stays quick");
  const scores = toScores(fit);
  for (const id of ids) {
    const [lo, hi] = intervals.get(id);
    assert.ok(lo <= scores.get(id) + 1 && scores.get(id) - 1 <= hi, id);
  }

  // The pieces: totals merge days and ignore rows out of order.
  assert.deepEqual(
    pairTotals([
      { model_lo: "a", model_hi: "b", lo_wins: 1, hi_wins: 2, ties: 3, both_bad: 4 },
      { model_lo: "a", model_hi: "b", lo_wins: 1, hi_wins: -5, ties: 0, both_bad: 1 },
      { model_lo: "b", model_hi: "a", lo_wins: 9, hi_wins: 9, ties: 9, both_bad: 9 },
      { model_lo: "c", model_hi: "c", lo_wins: 9 },
    ]),
    [{ lo: "a", hi: "b", lo_wins: 2, hi_wins: 2, ties: 3, both_bad: 5 }],
  );
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  const random = seeded(7);
  for (const lambda of [4, 120]) {
    let sum = 0;
    for (let i = 0; i < 4000; i++) sum += poisson(lambda, random);
    assert.ok(Math.abs(sum / 4000 - lambda) < lambda * 0.05, `Poisson(${lambda}) mean ${sum / 4000}`);
  }
  assert.equal(poisson(0, random), 0);
});

test(`thresholds: a model is listed only from ${MIN_VOTES} votes; the rest are counted, not named`, async (t) => {
  assert.equal(MIN_VOTES, 20);
  const rows = (n) => [
    { model_lo: "a", model_hi: "b", lo_wins: 30, hi_wins: 30, ties: 0, both_bad: 0 },
    { model_lo: "a", model_hi: "quiet", lo_wins: Math.ceil(n / 2), hi_wins: Math.floor(n / 2), ties: 0, both_bad: 0 },
  ];
  const under = leaderboard(rows(19));
  assert.deepEqual(under.models.map((m) => m.id).sort(), ["a", "b"]);
  assert.equal(under.waiting, 1);
  assert.equal(under.votes, 79, "its votes still count in the total");
  assert.deepEqual(under.models.map((m) => m.rank), [1, 2]);
  const at = leaderboard(rows(20));
  assert.ok(at.models.some((m) => m.id === "quiet"));
  assert.equal(at.waiting, 0);
  assert.deepEqual(leaderboard([]), { votes: 0, minVotes: 20, waiting: 0, models: [] });

  // Through the API: the quiet model's id never appears.
  const s = fixture(t);
  seed(s, [
    [ONE, TWO, 14, 12, 2, 1],
    [ONE, "lab/quiet-model", 10, 9],
  ]);
  const body = (await request(s.app).get("/api/arena").expect(200)).body;
  assert.deepEqual(body.models.map((m) => m.id).sort(), [ONE, TWO].sort());
  assert.equal(body.waiting, 1);
  assert.ok(!JSON.stringify(body).includes("quiet"));
});

// ---- The public API ----

test("the public API: aggregates only, the same for everyone, recomputed at most hourly", async (t) => {
  const s = fixture(t);
  const p = await person(s, "looker");
  seed(s, [[ONE, TWO, 30, 18, 4, 2]]);
  const anon = await request(s.app).get("/api/arena").expect(200);
  assert.match(anon.headers["cache-control"], /^public, max-age=(\d+)$/);
  assert.ok(Number(/max-age=(\d+)/.exec(anon.headers["cache-control"])[1]) <= CACHE_MS / 1000);
  const mine = (await p.agent.get("/api/arena").expect(200)).body;
  assert.deepEqual(mine, anon.body, "signed in or not, the same board");
  assert.deepEqual(Object.keys(anon.body).sort(), ["computedAt", "method", "minVotes", "models", "nextUpdate", "votes", "waiting"]);
  assert.equal(anon.body.votes, 54);
  for (const m of anon.body.models)
    assert.deepEqual(Object.keys(m).sort(), ["ci", "id", "name", "rank", "score", "votes", "win_rate"]);
  const one = anon.body.models.find((m) => m.id === ONE);
  assert.equal(one.name, "Gemini 2.5 Flash");
  assert.equal(one.rank, 1);
  assert.equal(one.win_rate, 0.611, "(30 + 6 / 2) / 54");
  const raw = JSON.stringify(anon.body);
  for (const secret of [p.user.id, "looker", "2026-09-20"]) assert.ok(!raw.includes(secret), secret);
  assert.deepEqual(anon.body.method, {
    model: "bradley-terry",
    ties: "half",
    bothBad: "tie",
    prior: 1,
    interval: { confidence: 0.95, bootstrap: 200 },
  });

  // New votes wait for the next hourly recompute.
  seed(s, [[ONE, TWO, 0, 40]], "2026-09-21");
  assert.equal((await request(s.app).get("/api/arena")).body.votes, 54);
  s.clock.offset += CACHE_MS;
  const fresh = (await request(s.app).get("/api/arena")).body;
  assert.equal(fresh.votes, 94);
  assert.equal(fresh.models[0].id, TWO);
  assert.ok(fresh.computedAt > anon.body.computedAt);
});

// ---- Erase and export ----

test("erase: Panic Wipe and closure delete the choice, the aggregate stays, and the export lists the choice", async (t) => {
  const s = await live(t);
  const p = await person(s, "exporter");
  const never = await person(s, "never");
  assert.deepEqual((await never.agent.get("/api/account/export").expect(200)).body.blindArena, { contributing: false, asked: false });
  await vote(p, await round(p));
  await consent(p, { contribute: true }).expect(200);
  await vote(p, await round(p));
  const exported = (await p.agent.get("/api/account/export").expect(200)).body;
  assert.deepEqual(exported.blindArena, { contributing: true, asked: true });
  assert.ok(!JSON.stringify(exported).includes("lo_wins"), "nothing from the aggregate is anyone's");
  const before = tally(s);
  assert.equal(counted(s), 1);

  await p.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM arena_consent WHERE user_id=?").get(p.user.id).n, 0);
  assert.deepEqual(tally(s), before, "the aggregate stays: none of it names the account");

  const q = await person(s, "closer");
  await consent(q, { contribute: true }).expect(200);
  await vote(q, await round(q));
  assert.equal(counted(s), 2);
  const kept = tally(s);
  await q.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM arena_consent WHERE user_id=?").get(q.user.id).n, 0);
  assert.deepEqual(tally(s), kept);
});

// ---- The client ----

test("the workspace shows the badge and asks only once released, never in the demo", () => {
  const src = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const ws = src("src/Workspace.jsx");
  assert.match(src("src/arena.js"), /export const arenaReleased = \(config\) => isReleased\(config, "arena"\) && isReleased\(config, "blind"\);/);
  assert.match(src("src/arena.js"), /if \(!live\) \{\s*setBoard\(null\);\s*return;\s*\}/);
  assert.match(ws, /const arenaLive = !demo && arenaReleased\(config\);/);
  assert.match(ws, /useArena\(arenaLive\)/);
  assert.match(ws, /arena=\{arenaRank\}/);
  const finder = src("src/ModelFinder.jsx");
  assert.match(finder, /\{current && arena\?\.\[current\.id\] && <ArenaTag rank=\{arena\[current\.id\]\} \/>\}/);
  assert.match(finder, /\{arena\?\.\[m\.id\] && <ArenaTag rank=\{arena\[m\.id\]\} \/>\}/);
  assert.match(ws, /if \(arenaLive && r\.arena\?\.ask\) setArenaAsk\(\{ round: m\.blind\.token \}\);/);
  assert.match(ws, /\{arenaLive && arenaAsk && \(\s*<ArenaAsk busy=\{arenaSaving\} onAnswer=\{answerArena\} onClose=\{\(\) => setArenaAsk\(null\)\} \/>/);
  // Sending on without an answer leaves it at no.
  assert.match(ws, /setArenaAsk\(null\);\s*\/\/ Blind Compare: the thread goes on/);
  assert.match(ws, /arena=\{arenaLive \? <Link to="\/arena">/);
  const app = src("src/App.jsx");
  assert.match(app, /const Arena = lazy\(\(\) => import\("\.\/Arena\.jsx"\)\)/);
  assert.match(app, /\(to === "\/arena" && !\(featureEnabled\(config, "arena"\) && featureEnabled\(config, "blind"\)\)\)/);
  const page = src("src/Arena.jsx");
  assert.match(page, /if \(!live\) return <NotFound \/>;/);
  assert.match(page, /const live = arenaReleased\(config\) && !!user;/);
  assert.match(src("src/Account.jsx"), /\{!demo && <ArenaSettings config=\{config\} user=\{user\} \/>\}/);
  assert.match(src("src/PanicWipe.jsx"), /const arenaLive = blindLive && isReleased\(config, "arena"\);/);
  assert.match(src("src/DataControls.jsx"), /const arena = blind && isReleased\(config, "arena"\);/);
  // Client helpers.
  assert.deepEqual(arenaRanks({ models: [{ id: "a", rank: 1 }, { id: "b", rank: 2 }, { id: "c" }] }), { a: 1, b: 2 });
  assert.deepEqual(arenaRanks(null), {});
  assert.equal(winPercent(0.625), "63%");
  const at = barScale([{ score: 1000, ci: [950, 1050] }, { score: 900, ci: [850, 960] }]);
  assert.ok(at(850) > 0 && at(850) < 10 && at(1050) > 90 && at(1050) < 100);
  assert.equal(barScale([])(1000), 50);
});

// JSX compiled for Node with the same esbuild Vite uses; shared UI, routing
// and app context are swapped for plain stand-ins so only their own text
// renders.
async function compileAll() {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-arena-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Icon = () => React.createElement("svg");
     export const Modal = ({ title, children }) => React.createElement("dialog", { "aria-label": title }, React.createElement("h2", null, title), children);`,
  );
  const context = stub("context.mjs", `export const useApp = () => ({ config: null, loading: false });`);
  const router = stub("router.mjs", `export const Link = ({ to, children }) => React.createElement("a", { href: to }, children);`);
  const pages = stub(
    "pages.mjs",
    `export const PageIntro = ({ eyebrow, title, children }) => React.createElement("div", null, React.createElement("p", null, eyebrow), React.createElement("h1", null, title), React.createElement("p", null, children));
     export const NotFound = () => React.createElement("main", null, "404");`,
  );
  const compiled = {};
  async function compile(file) {
    const src = new URL("../src/" + file, import.meta.url);
    const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
    const out = code
      .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
      .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
      .replace(/from "\.\/context\.jsx"/g, `from "${context}"`)
      .replace(/from "\.\/Pages\.jsx"/g, `from "${pages}"`)
      .replace(/from "react-router-dom"/g, `from "${router}"`)
      .replace(/from "\.\/StatusDot\.jsx"/g, () => `from "${compiled["StatusDot.jsx"]}"`)
      .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
      .replace(/from "react"/g, `from "${react}"`);
    const path = join(dir, file.replace(/\.jsx$/, ".mjs"));
    writeFileSync(path, out);
    compiled[file] = pathToFileURL(path).href;
    return import(compiled[file]);
  }
  try {
    await compile("StatusDot.jsx");
    const finder = await compile("ModelFinder.jsx");
    const arena = await compile("Arena.jsx");
    return { ...arena, ModelFinder: finder.default };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
const han = /\p{Script=Han}/u;
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Text split by whether it sits inside data-i18n="off" (names) or not (the
// page's own words, to be translated).
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr"]);
  const stack = [],
    page = [],
    kept = [];
  for (const [, tag, text] of html.replace(/<!-- -->/g, "").matchAll(/(<[^>]+>)|([^<]+)/g)) {
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

const BOARD = {
  computedAt: Date.UTC(2026, 8, 27, 12, 0),
  nextUpdate: Date.UTC(2026, 8, 27, 13, 0),
  votes: 1234,
  minVotes: 20,
  waiting: 2,
  models: [
    { rank: 1, id: "moon/1", name: "Moonfall One", score: 1088, ci: [1060, 1115], votes: 640, win_rate: 0.62 },
    { rank: 2, id: "bright/1", name: "Brightline Swift", score: 1012, ci: [990, 1040], votes: 702, win_rate: 0.51 },
    { rank: 3, id: "oak/1", name: "Oakridge Mini", score: 900, ci: [860, 931], votes: 126, win_rate: 0.33 },
  ],
};

test("the board, the question, the setting and the badge: names kept as written, the rest translated", async () => {
  const { ArenaBoard, ArenaAsk, ArenaSettings, ModelFinder } = await compileAll();
  const models = [{ id: "moon/1", name: "Moonfall One", provider: "Moonfall Labs", type: "chat", pricing: {} }];
  const picker = (arena) =>
    renderToStaticMarkup(
      createElement(ModelFinder, { models, mode: "chat", resolved: { model: models[0] }, onChoose() {}, opts: {}, arena }),
    );
  assert.doesNotMatch(picker(null), /mf-tag arena/);
  assert.doesNotMatch(picker({}), /mf-tag arena/);
  const html = [
    renderToStaticMarkup(createElement(ArenaBoard, { board: BOARD, testMode: true })),
    renderToStaticMarkup(createElement(ArenaBoard, { board: { ...BOARD, votes: 1, waiting: 1, models: [BOARD.models[0]] } })),
    renderToStaticMarkup(createElement(ArenaBoard, { board: { ...BOARD, votes: 12, waiting: 3, models: [] } })),
    renderToStaticMarkup(createElement(ArenaBoard, { board: null, failed: true })),
    renderToStaticMarkup(createElement(ArenaBoard, { board: null })),
    renderToStaticMarkup(createElement(ArenaAsk, { onAnswer() {}, onClose() {} })),
    renderToStaticMarkup(createElement(ArenaSettings, { config: { releases: { features: { arena: true, blind: true } } }, user: { id: "u" } })),
  ].join("");
  assert.equal(renderToStaticMarkup(createElement(ArenaSettings, { config: null, user: { id: "u" } })), "");
  assert.match(html, /1,234 blind votes/);
  assert.match(html, /Not enough votes yet\./);
  assert.match(html, /1060–1115/);
  assert.match(html, /href="\/workspace\/chat"/);
  assert.match(html, /href="\/arena"/);
  assert.match(html, /role="switch"/);
  // The chosen model's badge, on the picker's button.
  assert.match(
    picker({ "moon/1": 3 }),
    /<span class="mf-tag arena" title="Its rank on the public Blind Arena, from blind votes">Arena #3<\/span>/,
  );
  for (const text of ["Arena #3", "Its rank on the public Blind Arena, from blind votes"])
    assert.match(translateText(text, zh) ?? "", han, text);
  const { page, kept } = textsOf(html);
  for (const name of ["Moonfall One", "Brightline Swift", "Oakridge Mini"]) assert.ok(kept.includes(name), "kept as written: " + name);
  for (const text of page) assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
});

test("the Chinese dictionary covers the update and the Arena's own words", () => {
  const entry = UPDATES.find((u) => u.id === "arena");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Blind Arena is coming soon.",
    "BLIND ARENA",
    "Which model wins when",
    "nobody knows the names?",
    "Blind Arena",
    "3 models ranked",
    "12 blind votes",
    "2 more models have votes but fewer than 20, so they aren't listed yet.",
    "Arena #12",
    "See the public Blind Arena",
    "Your Blind votes stay yours. You can change this in Account settings.",
    "Added. This vote and your next Blind votes go to the Arena, with no account attached.",
    "Your next Blind votes go to the Arena, with no account attached.",
    "Your Blind Arena choice. You'll be asked again after your next vote.",
    "Votes already added to the Blind Arena. They carry no account, so they can't be picked out.",
    "It also says whether you add your votes to the Blind Arena.",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
});
