import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import {
  addCredit,
  balance,
  reserve,
  settle,
  release,
  MIGRATIONS,
} from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import {
  decimal,
  creditString,
  usdString,
  parseCredits,
  usageRange,
  csvCell,
  csvLine,
  chatFeature,
  featureOf,
  recordedModel,
  categoryOf,
  EXPORT_COLUMNS,
  MAX_EXPORT_ROWS,
  DAY,
} from "../server/usage-insights.js";
import {
  UI_STRINGS,
  UI_PATTERNS,
  formatAmount,
  exportRangeError,
  demoUsage,
} from "../src/usage-insights.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so every update is pinned unreleased for this file.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const GOOGLE = "google/gemini-2.5-flash",
  OPENAI = "openai/gpt-4o-mini",
  IMAGE = "google/gemini-2.5-flash-image";
const PROMPT = "PROMPT-SECRET-7731 tell me about amphorae";
const SPOKEN = "SPOKEN-SECRET-4410 read this aloud";

function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-usage-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...(released === "all" ? {} : { mvpModels: [GOOGLE, OPENAI] }),
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
    .set("X-Forwarded-For", `198.51.100.${++visitor}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const chat = (requestId, extra = {}) => ({
  model: GOOGLE,
  messages: [{ role: "user", content: PROMPT }],
  max_tokens: 50,
  requestId,
  ...extra,
});
const DAY_MS = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const today = () => Math.floor(Date.now() / DAY_MS);
const ledgerSum = (db, user, start, end) =>
  db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n, COUNT(*) c FROM ledger WHERE user_id=? AND created>=? AND created<?",
    )
    .get(user, start, end);
// RFC 4180: quoted fields, doubled quotes, CRLF rows; the BOM is dropped.
function parseCsv(text) {
  assert.equal(
    text.charCodeAt(0),
    0xfeff,
    "starts with a UTF-8 byte-order mark",
  );
  const rows = [];
  let row = [],
    cell = "",
    quoted = false,
    i = 1;
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') ((cell += '"'), (i += 2));
      else if (c === '"') ((quoted = false), i++);
      else ((cell += c), i++);
    } else if (c === '"') ((quoted = true), i++);
    else if (c === ",") (row.push(cell), (cell = ""), i++);
    else if (c === "\r" && text[i + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      ((row = []), (cell = ""), (i += 2));
    } else ((cell += c), i++);
  }
  assert.equal(cell, "", "the file ends with a complete row");
  assert.equal(row.length, 0, "the file ends with CRLF");
  return rows;
}
const csvObjects = (text) => {
  const [header, ...rows] = parseCsv(text);
  assert.deepEqual(header, EXPORT_COLUMNS);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]])));
};
const sumUnits = (list) => list.reduce((n, r) => n + r.spent.units, 0);
// A settled request written directly, for exact timestamps.
function settledAt(db, user, id, units, created, extra = {}) {
  const hold = user + ":" + id;
  db.prepare(
    "INSERT INTO holds(id,user_id,amount,key_id,kind,status,created,expires,result) VALUES(?,?,?,?,?,?,?,?,?)",
  ).run(
    hold,
    user,
    units,
    extra.key ?? null,
    extra.kind ?? "chat",
    "settled",
    created,
    created,
    JSON.stringify({ model: extra.model ?? GOOGLE, charged: units }),
  );
  db.prepare(
    "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
  ).run(
    "l_" + id,
    user,
    -units,
    extra.kind ?? "chat",
    hold,
    extra.key ?? null,
    extra.description ?? "Gemini 2.5 Flash",
    created,
  );
  return hold;
}

test("registered unreleased: routes refused, no labels written, nothing listed", async (t) => {
  const s = fixture(t, "mvp");
  const { agent } = await person(s.app, "gate");
  for (const path of [
    "/api/account/usage",
    "/api/account/usage?days=7",
    "/api/account/usage/export?format=csv",
    "/API/Account/Usage/Export?format=json",
  ]) {
    const r = await agent.get(path).expect(403);
    assert.equal(r.body.error.code, "feature_unreleased", path);
    assert.equal(
      r.body.error.message,
      "Usage Insights & Export is coming soon.",
    );
  }
  await request(s.app).get("/api/account/usage").expect(403);
  // Chat works as before and records no usage label while unreleased.
  await agent.post("/api/chat").send(chat("gate-1")).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM usage_tags").get().n, 0);
  const config = (await agent.get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.insights, false);
  const paths = Object.keys(
    (await request(s.app).get("/api/openapi.json").expect(200)).body.paths,
  );
  assert.ok(!paths.includes("/api/account/usage"));
  assert.ok(!paths.includes("/api/account/usage/export"));
  const entry = UPDATES.find((u) => u.id === "insights");
  assert.equal(entry.title, "Usage Insights & Export");
  assert.equal(entry.points.length, 3);
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  const zh = JSON.parse(
    readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"),
  ).strings;
  for (const line of [entry.title, entry.tagline, ...entry.points])
    assert.match(zh[line] || "", /\p{Script=Han}/u, `zh: ${line}`);
  // One additive migration, recorded so an older build can still start:
  // replay the steps to find the one that adds usage_tags.
  const fresh = new DatabaseSync(":memory:");
  let added = 0;
  MIGRATIONS.forEach((step, v) => {
    step(fresh);
    fresh.exec(`PRAGMA user_version=${v + 1}`);
    if (
      !added &&
      fresh.prepare("SELECT 1 FROM sqlite_master WHERE name='usage_tags'").get()
    )
      added = v + 1;
  });
  assert.ok(added, "a migration adds usage_tags");
  assert.ok(
    fresh.prepare("SELECT 1 FROM schema_additive WHERE version=?").get(added),
    "usage_tags is an additive migration",
  );
  assert.deepEqual(
    fresh
      .prepare("PRAGMA table_info(usage_tags)")
      .all()
      .map((c) => c.name),
    ["hold_id", "feature", "model"],
  );
  fresh.close();
});

test("released: listed in the contract, sign-in required, own data only", async (t) => {
  const s = fixture(t);
  const paths = (await request(s.app).get("/api/openapi.json").expect(200)).body
    .paths;
  assert.ok(paths["/api/account/usage"]?.get);
  assert.ok(paths["/api/account/usage/export"]?.get);
  for (const path of ["/api/account/usage", "/api/account/usage/export"]) {
    const r = await request(s.app).get(path).expect(401);
    assert.equal(r.body.error.code, "authentication_required");
  }
  const ana = await person(s.app, "ana");
  const ben = await person(s.app, "ben");
  await ana.agent.post("/api/chat").send(chat("ana-1")).expect(200);
  await ben.agent.post("/api/chat").send(chat("ben-1")).expect(200);
  await ben.agent.post("/api/chat").send(chat("ben-2")).expect(200);
  const anaRows = s.db
    .prepare("SELECT id FROM ledger WHERE user_id=?")
    .all(ana.user.id)
    .map((r) => r.id);
  // Query parameters can't point at someone else's ledger.
  const summary = (
    await ben.agent
      .get(
        `/api/account/usage?days=2&user=${ana.user.id}&user_id=${ana.user.id}`,
      )
      .expect(200)
  ).body;
  assert.equal(summary.totals.requests, 2);
  const csv = (
    await ben.agent
      .get(`/api/account/usage/export?days=2&user_id=${ana.user.id}`)
      .expect(200)
  ).text;
  const json = (
    await ben.agent
      .get("/api/account/usage/export?days=2&format=json")
      .expect(200)
  ).body;
  for (const id of anaRows) {
    assert.ok(!csv.includes(id), "no row of another account");
    assert.ok(!json.entries.some((e) => e.entry_id === id));
  }
  assert.ok(!csv.includes(ana.user.id));
  assert.ok(
    json.entries.every((e) => !String(e.ledger_ref).includes(ana.user.id)),
  );
});

test("every total, breakdown and exported row reconciles exactly with the ledger", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana");
  const ben = await person(s.app, "ben");
  const id = ana.user.id;
  const expectFeature = {};
  const run = async (rid, feature, body) => {
    await ana.agent.post("/api/chat").send(chat(rid, body)).expect(200);
    expectFeature[id + ":" + rid] = feature;
  };
  await run("r-plain", "chat");
  await run("r-web", "web_search", { web_search: true });
  await run("r-sym", "symposium", { mode: "symposium" });
  const source = (
    await ana.agent.get("/api/conversations").expect(200)
  ).body.data.find((c) => c.mode !== "symposium");
  const check = {
    model: OPENAI,
    mode: "symposium",
    double_check: { source_model: GOOGLE, source_conversation: source.id },
  };
  await run("r-dc", "double_check", check);
  // Off the record, only what billing reflects: a double-check files as chat,
  // a web search as web search.
  await run("r-dc-otr", "chat", {
    ...check,
    ephemeral: true,
    double_check: { source_model: GOOGLE },
  });
  await run("r-web-otr", "web_search", { ephemeral: true, web_search: true });
  await ana.agent
    .post("/api/images")
    .send({ model: IMAGE, prompt: PROMPT, n: 1, requestId: "r-img" })
    .expect(200);
  expectFeature[id + ":r-img"] = "image";
  await ana.agent
    .post("/api/audio/speech")
    .send({
      model: "fixture-voice",
      voice: "fixture-1",
      text: SPOKEN,
      requestId: "r-tts",
    })
    .expect(200);
  expectFeature[id + ":r-tts"] = "speech";
  await ana.agent
    .post("/api/audio/transcriptions")
    .send({
      audio:
        "data:audio/webm;base64," + Buffer.from("fake-webm").toString("base64"),
      requestId: "r-stt",
    })
    .expect(200);
  expectFeature[id + ":r-stt"] = "transcription";
  const key = (
    await ana.agent
      .post("/api/keys")
      .send({ name: "Research agent" })
      .expect(201)
  ).body;
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(chat("r-api"))
    .expect(200);
  expectFeature[id + ":r-api"] = "chat";
  // Credits sent and received are transfers, never spend.
  await ana.agent
    .post("/api/credits/send")
    .send({ to: "ben", amount: 5 })
    .expect(201);
  await ben.agent
    .post("/api/credits/send")
    .send({ to: "ana", amount: 2 })
    .expect(201);
  // Holds: settled for less than reserved (an interrupted chat from before
  // labels, recorded by name only), released (nothing charged) and held.
  reserve(s.db, {
    id: id + ":r-partial",
    user: id,
    amount: 1000,
    kind: "chat",
  });
  settle(s.db, id + ":r-partial", 400, "Interrupted: Gemini 2.5 Flash");
  expectFeature[id + ":r-partial"] = "chat";
  reserve(s.db, {
    id: id + ":r-released",
    user: id,
    amount: 900,
    kind: "chat",
  });
  release(s.db, id + ":r-released");
  reserve(s.db, {
    id: id + ":r-held",
    user: id,
    amount: 777,
    kind: "video",
    ttl: 3600000,
  });
  // Rewards, a Team Treasury contribution and an unknown kind.
  addCredit(s.db, id, 1234, "referral_test", "referral", "Referral reward");
  addCredit(
    s.db,
    id,
    10,
    "operator_adjustment_1",
    "operator_adjustment",
    "Adjustment",
  );
  const team = "treasury_" + "a".repeat(32);
  const t0 = Date.now();
  s.db
    .prepare("INSERT INTO users(id,created,deleted) VALUES(?,?,?)")
    .run(team, t0, t0);
  const entry = s.db.prepare(
    "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
  );
  entry.run(
    "l_tc_out",
    id,
    -7000,
    "treasury_contribution",
    "tc1:out",
    null,
    "To the team",
    t0,
  );
  entry.run(
    "l_tc_in",
    team,
    7000,
    "treasury_contribution",
    "tc1:in",
    null,
    "From ana",
    t0,
  );
  // A "Team pays" request: held and settled on the treasury, not on ana.
  s.db
    .prepare(
      "INSERT INTO holds(id,user_id,amount,key_id,kind,status,created,expires,result) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(team + ":team-1", team, 5000, null, "chat", "settled", t0, t0, "{}");
  entry.run(
    "l_team_spend",
    team,
    -3000,
    "chat",
    team + ":team-1",
    null,
    "Gemini 2.5 Flash",
    t0,
  );
  s.db
    .prepare(
      "INSERT INTO treasury_spends(hold_id,collab_id,user_id,model,created) VALUES(?,?,?,?,?)",
    )
    .run(team + ":team-1", "collab_x", id, GOOGLE, t0);

  const range = usageRange({ days: "2" });
  const r = (await ana.agent.get("/api/account/usage?days=2").expect(200)).body;
  const ledger = ledgerSum(s.db, id, range.start, range.end);
  const spend = s.db
    .prepare(
      "SELECT l.ref, l.amount FROM ledger l JOIN holds h ON h.id=l.ref AND h.user_id=l.user_id WHERE l.user_id=?",
    )
    .all(id);
  const spent = -spend.reduce((n, x) => n + x.amount, 0);
  const T = r.totals;
  // The net change is the ledger's own sum, and the categories add up to it.
  assert.equal(T.net.units, ledger.n);
  assert.equal(T.entries, ledger.c);
  assert.equal(
    T.topups.units +
      T.received.units +
      T.rewards.units +
      T.team_transfers.units +
      T.other.units -
      T.spent.units -
      T.sent.units,
    T.net.units,
  );
  assert.equal(T.spent.units, spent);
  assert.equal(T.requests, spend.length);
  assert.equal(T.topups.units, 100 * 10_000_000, "the local test credit");
  assert.equal(T.sent.units, 50000);
  assert.equal(T.received.units, 20000);
  assert.equal(T.rewards.units, 1234);
  assert.equal(T.team_transfers.units, -7000);
  assert.equal(T.other.units, 10);
  // Exact strings made from the same integers.
  for (const m of [T.spent, T.net, T.sent])
    assert.deepEqual(m, {
      units: m.units,
      credits: creditString(m.units),
      usd: usdString(m.units),
    });
  // Daily, model, feature and key breakdowns are the same spend.
  assert.equal(sumUnits(r.daily), spent);
  for (const list of [r.by_model, r.by_feature, r.by_source]) {
    assert.equal(sumUnits(list), spent);
    assert.equal(
      list.reduce((n, x) => n + x.requests, 0),
      spend.length,
    );
  }
  const perFeature = {};
  for (const x of spend) {
    const f = expectFeature[x.ref];
    assert.ok(f, "every settled request is expected: " + x.ref);
    perFeature[f] = (perFeature[f] || 0) - x.amount;
  }
  assert.deepEqual(
    Object.fromEntries(r.by_feature.map((f) => [f.feature, f.spent.units])),
    perFeature,
  );
  // Nothing for the released hold; the held one only as held.
  assert.ok(!spend.some((x) => x.ref.endsWith(":r-released")));
  assert.equal(r.held.units, balance(s.db, id).held);
  assert.equal(r.held.units, 777);
  assert.equal(r.held.requests, 1);
  // Team-paid spend: shown apart, never in ana's totals.
  assert.equal(r.team_paid.units, 3000);
  assert.equal(r.team_paid.requests, 1);
  // One row per model: the name-only interrupted charge joins its model id.
  const gemini = r.by_model.find((m) => m.id === GOOGLE);
  assert.equal(gemini.model, "Gemini 2.5 Flash");
  assert.equal(
    r.by_model.filter((m) => m.model === "Gemini 2.5 Flash").length,
    1,
  );
  assert.equal(
    gemini.spent.units,
    -spend
      .filter((x) => !/r-dc$|r-dc-otr$|r-img$|r-tts$|r-stt$/.test(x.ref))
      .reduce((n, x) => n + x.amount, 0),
  );
  assert.ok(r.by_model.some((m) => m.id === OPENAI && m.requests === 2));
  assert.ok(
    r.by_model.some(
      (m) => m.model === "Fixture voice" && m.id === "fixture-voice",
    ),
  );
  assert.ok(r.by_model.some((m) => m.model === "Nova 3" && m.id === "nova-3"));
  // Workspace versus the API key, by its name.
  const apiRow = r.by_source.find((x) => x.source === "api_key");
  assert.equal(apiRow.label, "Research agent");
  assert.equal(apiRow.id, key.id);
  assert.equal(apiRow.requests, 1);
  assert.equal(
    r.by_source.find((x) => x.source === "web").requests,
    spend.length - 1,
  );

  // The CSV export: the same rows, whose credits sum exactly to the ledger.
  const res = await ana.agent
    .get("/api/account/usage/export?format=csv&days=2")
    .expect(200);
  assert.match(res.headers["content-type"], /^text\/csv; charset=utf-8/);
  assert.equal(
    res.headers["content-disposition"],
    `attachment; filename="anonyma-usage-${range.from}-to-${range.to}.csv"`,
  );
  assert.equal(res.headers["cache-control"], "no-store");
  const rows = csvObjects(res.text);
  assert.equal(rows.length, ledger.c);
  assert.equal(Number(res.headers["x-export-rows"]), ledger.c);
  assert.equal(
    rows.reduce((n, x) => n + parseCredits(x.credits), 0),
    ledger.n,
  );
  assert.equal(
    rows.reduce((n, x) => n + Number(x.subcredits), 0),
    ledger.n,
  );
  const byId = new Map(
    s.db
      .prepare("SELECT * FROM ledger WHERE user_id=?")
      .all(id)
      .map((x) => [x.id, x]),
  );
  let last = "";
  for (const x of rows) {
    const l = byId.get(x.entry_id);
    assert.ok(l, "every row is one of ana's ledger entries");
    assert.equal(Number(x.subcredits), l.amount);
    assert.equal(x.credits, creditString(l.amount));
    assert.equal(x.usd, usdString(l.amount));
    assert.equal(x.timestamp_utc, new Date(l.created).toISOString());
    assert.equal(x.ledger_ref, l.ref);
    assert.equal(x.type, l.kind);
    assert.ok(x.timestamp_utc >= last, "oldest first");
    last = x.timestamp_utc;
  }
  assert.ok(
    !rows.some((x) => x.ledger_ref.includes("team-1")),
    "team-paid rows aren't ana's",
  );
  const plain = rows.find((x) => x.ledger_ref === id + ":r-plain");
  assert.equal(plain.category, "spend");
  assert.equal(plain.feature, "chat");
  assert.equal(plain.model, GOOGLE);
  assert.equal(plain.source, "web");
  // Signed receipts are named by request id, which fetches them.
  assert.equal(plain.receipt_id, "r-plain");
  await ana.agent.get("/api/receipts/r-plain").expect(200);
  const viaKey = rows.find((x) => x.ledger_ref === id + ":r-api");
  assert.equal(viaKey.source, "api_key");
  assert.equal(viaKey.key_or_app, "Research agent");
  assert.equal(rows.find((x) => x.type === "transfer_out").category, "sent");
  assert.equal(rows.find((x) => x.type === "transfer_out").credits, "-5.0000");
  assert.equal(rows.find((x) => x.type === "transfer_in").credits, "2.0000");
  assert.equal(
    rows.find((x) => x.ledger_ref === id + ":r-tts").feature,
    "speech",
  );
  assert.equal(
    rows.find((x) => x.ledger_ref === id + ":r-partial").model,
    "Gemini 2.5 Flash",
  );
  assert.equal(rows.find((x) => x.type === "test_credit").feature, "");

  // The JSON export: the same entries, a summary that matches the ledger.
  const j = await ana.agent
    .get("/api/account/usage/export?format=json&days=2")
    .expect(200);
  assert.match(j.headers["content-type"], /^application\/json/);
  assert.match(j.headers["content-disposition"], /\.json"$/);
  assert.equal(j.body.schema, "anonyma.usage-export.v1");
  assert.deepEqual(j.body.columns, EXPORT_COLUMNS);
  assert.equal(j.body.entries.length, ledger.c);
  assert.equal(j.body.summary.net.units, ledger.n);
  assert.equal(j.body.summary.net.credits, creditString(ledger.n));
  j.body.entries.forEach((e, i) => {
    for (const c of EXPORT_COLUMNS)
      assert.equal(e[c] == null ? "" : String(e[c]), rows[i][c], c);
  });

  // No prompt, reply, spoken text or transcript anywhere.
  for (const text of [res.text, j.text, JSON.stringify(r)])
    for (const secret of [
      "PROMPT-SECRET",
      "SPOKEN-SECRET",
      "amphorae",
      "Local test provider",
      "You asked",
      "Local test transcription",
    ])
      assert.ok(!text.includes(secret), secret);
});

test("UTC days: boundaries land on the right day and ranges are inclusive", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "utc");
  const d = today() - 20;
  const at = (day, ms) => day * DAY_MS + ms;
  settledAt(s.db, user.id, "before", 1, at(d, -1));
  settledAt(s.db, user.id, "first", 10, at(d, 0));
  settledAt(s.db, user.id, "late", 100, at(d, DAY_MS - 1));
  settledAt(s.db, user.id, "next", 1000, at(d + 1, 0));
  settledAt(s.db, user.id, "after", 10000, at(d + 2, 0));
  const r = (
    await agent
      .get(
        `/api/account/usage?from=${iso(d * DAY_MS)}&to=${iso((d + 1) * DAY_MS)}`,
      )
      .expect(200)
  ).body;
  assert.equal(r.range.timezone, "UTC");
  assert.equal(r.range.days, 2);
  assert.equal(r.range.start, new Date(d * DAY_MS).toISOString());
  assert.equal(r.range.end, new Date((d + 2) * DAY_MS).toISOString());
  assert.deepEqual(
    r.daily.map((x) => [x.date, x.spent.units, x.requests]),
    [
      [iso(d * DAY_MS), 110, 2],
      [iso((d + 1) * DAY_MS), 1000, 1],
    ],
  );
  assert.equal(r.totals.spent.units, 1110);
  const one = (
    await agent
      .get(`/api/account/usage?from=${iso(d * DAY_MS)}&to=${iso(d * DAY_MS)}`)
      .expect(200)
  ).body;
  assert.equal(one.totals.spent.units, 110);
  assert.equal(one.daily.length, 1);
  const rows = csvObjects(
    (
      await agent
        .get(
          `/api/account/usage/export?from=${iso(d * DAY_MS)}&to=${iso((d + 1) * DAY_MS)}`,
        )
        .expect(200)
    ).text,
  );
  assert.deepEqual(
    rows.map((x) => [x.timestamp_utc, x.subcredits]),
    [
      [new Date(at(d, 0)).toISOString(), "-10"],
      [new Date(at(d, DAY_MS - 1)).toISOString(), "-100"],
      [new Date(at(d + 1, 0)).toISOString(), "-1000"],
    ],
  );
  assert.equal(rows[1].timestamp_utc.slice(11), "23:59:59.999Z");
});

test("API keys and connected apps are labelled by name, revoked ones marked", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "labels");
  const key = (
    await agent.post("/api/keys").send({ name: "CLI laptop" }).expect(201)
  ).body;
  await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key.key)
    .send(chat("via-key"))
    .expect(200);
  await agent.delete("/api/keys/" + key.id).expect(200);
  // A connected app's key, as Connect an App writes it (server/oauth.js).
  const t0 = Date.now();
  s.db
    .prepare(
      "INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created,revoked,last_used,allowance_total,allowance_expires,paused_at,agent_label,connection_id) VALUES(?,?,NULL,?,NULL,NULL,?,NULL,NULL,?,?,NULL,?,?)",
    )
    .run(
      "key_app",
      user.id,
      "Notes app",
      t0,
      1_000_000,
      t0 + DAY_MS,
      "Notes app",
      "conn_app",
    );
  s.db
    .prepare(
      "INSERT INTO oauth_connections(id,user_id,client_id,key_id,name,client_name,redirect_uri,private_only,created,activated,expires,revoked) VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)",
    )
    .run(
      "conn_app",
      user.id,
      "client_x",
      "key_app",
      "Notes app",
      "=cmd",
      "https://app.invalid/cb",
      1,
      t0,
      t0,
      t0 + DAY_MS,
    );
  settledAt(s.db, user.id, "via-app", 321, t0, { key: "key_app" });
  const r = (await agent.get("/api/account/usage?days=1").expect(200)).body;
  const bySource = Object.fromEntries(r.by_source.map((x) => [x.source, x]));
  assert.equal(bySource.api_key.label, "CLI laptop");
  assert.equal(bySource.api_key.revoked, true);
  assert.equal(bySource.connected_app.label, "Notes app");
  assert.equal(bySource.connected_app.spent.units, 321);
  assert.equal(bySource.connected_app.revoked, false);
  assert.ok(!("web" in bySource));
  const rows = csvObjects(
    (await agent.get("/api/account/usage/export?days=1").expect(200)).text,
  );
  const app = rows.find((x) => x.ledger_ref === user.id + ":via-app");
  assert.equal(app.source, "connected_app");
  assert.equal(app.key_or_app, "Notes app");
  assert.equal(
    rows.find((x) => x.ledger_ref === user.id + ":via-key").key_or_app,
    "CLI laptop",
  );
  // Labels are the connection's own name, never the app's self-declared one.
  assert.ok(!JSON.stringify(r).includes("=cmd"));
});

test("ranges and formats are checked before anything is read", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "ranges");
  const day = (n) => iso((today() + n) * DAY_MS);
  const bad = [
    ["days=0", "invalid_range"],
    ["days=367", "invalid_range"],
    ["days=abc", "invalid_range"],
    ["days=1.5", "invalid_range"],
    ["days=7&days=8", "invalid_range"],
    [`from=${day(-3)}`, "invalid_range"],
    [`from=${day(-1)}&to=${day(-2)}`, "invalid_range"],
    ["from=2026-02-30&to=2026-03-01", "invalid_range"],
    ["from=2026-2-3&to=2026-02-04", "invalid_range"],
    [`from=${day(0)}&to=${day(1)}`, "invalid_range"],
    [`from=${day(-366)}&to=${day(0)}`, "range_too_long"],
    [`from=${day(-3)}&to=${day(0)}&days=4`, "invalid_range"],
  ];
  for (const [query, code] of bad) {
    for (const path of ["/api/account/usage", "/api/account/usage/export"]) {
      const r = await agent.get(`${path}?${query}`).expect(400);
      assert.equal(r.body.error.code, code, `${path}?${query}`);
    }
  }
  const r = await agent
    .get("/api/account/usage/export?format=xlsx")
    .expect(400);
  assert.equal(r.body.error.code, "invalid_format");
  // 366 days is the most one request covers; 30 is the default.
  const full = (
    await agent
      .get(`/api/account/usage?from=${day(-365)}&to=${day(0)}`)
      .expect(200)
  ).body;
  assert.equal(full.range.days, 366);
  assert.equal(full.daily.length, 366);
  assert.equal(
    (await agent.get("/api/account/usage").expect(200)).body.range.days,
    30,
  );
  await agent
    .get(`/api/account/usage/export?from=${day(-365)}&to=${day(0)}`)
    .expect(200);
  // Pure range parsing against a fixed clock.
  const at = Date.UTC(2026, 8, 25, 23, 59, 59, 999);
  assert.deepEqual(usageRange({ days: "7" }, at), {
    from: "2026-09-19",
    to: "2026-09-25",
    days: 7,
    timezone: "UTC",
    start: Date.UTC(2026, 8, 19),
    end: Date.UTC(2026, 8, 26),
  });
  assert.equal(
    usageRange({ from: "2024-02-29", to: "2024-02-29" }, at).days,
    1,
  );
  assert.throws(
    () => usageRange({ from: "2023-02-29", to: "2023-03-01" }, at),
    /UTC dates/,
  );
});

test("large exports stream in pages; oversized ranges are refused, never cut short", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "bulk");
  // 2,500 rows sharing one timestamp: paging must follow rowid, not skip.
  const at = (today() - 3) * DAY_MS + 12345;
  s.db.exec("BEGIN");
  const insert = s.db.prepare(
    "INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < 2500; i++)
    insert.run(
      `l_bulk_${i}`,
      user.id,
      i % 2 ? -(i + 1) : i + 7,
      "deposit",
      `bulk_${i}`,
      null,
      "Bulk",
      at,
    );
  s.db.exec("COMMIT");
  const range = `from=${iso(at)}&to=${iso(at)}`;
  const res = await agent.get(`/api/account/usage/export?${range}`).expect(200);
  const rows = csvObjects(res.text);
  assert.equal(rows.length, 2500);
  assert.equal(new Set(rows.map((x) => x.entry_id)).size, 2500);
  assert.deepEqual(
    rows.map((x) => x.entry_id),
    Array.from({ length: 2500 }, (_, i) => `l_bulk_${i}`),
  );
  const sum = ledgerSum(
    s.db,
    user.id,
    Math.floor(at / DAY_MS) * DAY_MS,
    (Math.floor(at / DAY_MS) + 1) * DAY_MS,
  );
  assert.equal(
    rows.reduce((n, x) => n + parseCredits(x.credits), 0),
    sum.n,
  );
  const json = (
    await agent
      .get(`/api/account/usage/export?format=json&${range}`)
      .expect(200)
  ).body;
  assert.equal(json.entries.length, 2500);
  assert.equal(json.summary.net.units, sum.n);
  const summary = (await agent.get(`/api/account/usage?${range}`).expect(200))
    .body;
  assert.equal(summary.totals.net.units, sum.n);
  // More rows than one export holds: refused with the count.
  s.db
    .prepare(
      `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<?)
       INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created)
       SELECT 'l_more_'||x, ?, 1, 'deposit', 'more_'||x, NULL, 'Bulk', ? FROM n`,
    )
    .run(MAX_EXPORT_ROWS - 2499, user.id, at + 1);
  const big = await agent.get(`/api/account/usage/export?${range}`).expect(400);
  assert.equal(big.body.error.code, "export_too_large");
  assert.match(big.body.error.message, /100,001 ledger entries/);
  assert.equal(
    (await agent.get(`/api/account/usage?${range}`).expect(200)).body.totals
      .entries,
    MAX_EXPORT_ROWS + 1,
  );
});

test("CSV cells are quoted and can't run as spreadsheet formulas", async (t) => {
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
  assert.equal(csvCell(-709), "-709");
  assert.equal(csvCell("-0.0709"), "-0.0709", "exact amounts stay numbers");
  assert.equal(csvCell("100000.0000"), "100000.0000");
  assert.equal(csvCell("plain"), '"plain"');
  assert.equal(
    csvCell('say "hi", then\r\nleave'),
    '"say ""hi"", then\r\nleave"',
  );
  for (const [raw, safe] of [
    ["=1+2", "'=1+2"],
    ["+SUM(A1)", "'+SUM(A1)"],
    ["-2+3", "'-2+3"],
    ["@cmd", "'@cmd"],
    ["\tTab", "'\tTab"],
    ["\rCR", "'\rCR"],
    ["\nLF", "'\nLF"],
    ["＝1+2", "'＝1+2"],
    [
      '=HYPERLINK("http://evil.invalid","x")',
      `'=HYPERLINK(""http://evil.invalid"",""x"")`,
    ],
  ])
    assert.equal(csvCell(raw), `"${safe}"`, JSON.stringify(raw));
  assert.throws(() => csvCell(0.1), /integers/);
  assert.equal(csvLine(["a", 1, null]), '"a",1,\r\n');

  // End to end: key names the account chose, including hostile ones.
  const s = fixture(t);
  const { agent, user } = await person(s.app, "sheets");
  const names = [
    '=HYPERLINK("http://evil.invalid","x")',
    "+cmd|' /C calc'!A0",
    "-2+3",
    "@SUM(1,2)",
    'Comma, "quote"\nnewline',
    "研究助手",
  ];
  for (const [i, name] of names.entries()) {
    const key = (await agent.post("/api/keys").send({ name }).expect(201)).body;
    await request(s.app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer " + key.key)
      .send(chat("sheet-" + i))
      .expect(200);
  }
  const res = await agent.get("/api/account/usage/export?days=2").expect(200);
  // Every hostile cell is quoted with an apostrophe in front of it.
  assert.ok(res.text.includes(`"'=HYPERLINK(""http://evil.invalid"",""x"")"`));
  assert.ok(
    !/(^|,)"?[=+\-@]/m.test(
      res.text.replace(/(^|,)-\d+(\.\d+)?(?=,|\r)/gm, "$1"),
    ),
  );
  const rows = csvObjects(res.text);
  const labels = rows
    .filter((x) => x.source === "api_key")
    .map((x) => x.key_or_app);
  assert.deepEqual(labels, [
    `'=HYPERLINK("http://evil.invalid","x")`,
    "'+cmd|' /C calc'!A0",
    "'-2+3",
    "'@SUM(1,2)",
    'Comma, "quote"\nnewline',
    "研究助手",
  ]);
  // Negative amounts are still plain numbers.
  assert.ok(
    rows
      .filter((x) => x.category === "spend")
      .every((x) => /^-\d+\.\d{4}$/.test(x.credits)),
  );
  // The JSON export keeps the names exactly as they are.
  const json = (
    await agent.get("/api/account/usage/export?days=2&format=json").expect(200)
  ).body;
  assert.deepEqual(
    json.entries.filter((x) => x.source === "api_key").map((x) => x.key_or_app),
    names,
  );
  assert.equal(user.username, "sheets");
});

test("exports are rate limited per account", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "limited");
  for (let i = 0; i < 20; i++)
    await agent.get("/api/account/usage/export?days=1").expect(200);
  const r = await agent.get("/api/account/usage/export?days=1").expect(429);
  assert.equal(r.body.error.type, "rate_limit_error");
  // Another account has its own allowance.
  const other = await person(s.app, "other");
  await other.agent.get("/api/account/usage/export?days=1").expect(200);
});

test("amounts are exact decimals from integers, never floats", () => {
  assert.equal(decimal(0, 4), "0.0000");
  assert.equal(creditString(-5), "-0.0005");
  assert.equal(creditString(12345), "1.2345");
  assert.equal(creditString(-10_000_000), "-1000.0000");
  assert.equal(usdString(1), "0.0000001");
  assert.equal(usdString(-211709), "-0.0211709");
  assert.equal(creditString(Number.MAX_SAFE_INTEGER), "900719925474.0991");
  assert.equal(usdString(-Number.MAX_SAFE_INTEGER), "-900719925.4740991");
  assert.throws(() => creditString(0.5), /safe integers/);
  assert.throws(() => creditString(2 ** 53), /safe integers/);
  for (const n of [0, 1, -1, 9999, -10000, 123456789, -987654321012])
    assert.equal(parseCredits(creditString(n)), n);
  // 0.1 + 0.2 style drift can't happen: sums are integers first.
  const parts = Array.from({ length: 1000 }, () => 1);
  assert.equal(creditString(parts.reduce((a, b) => a + b, 0)), "0.1000");
  // Client formatting trims zeros and groups digits without rounding.
  assert.equal(formatAmount("12345.6700"), "12,345.67");
  assert.equal(formatAmount("-0.0709"), "-0.0709");
  assert.equal(formatAmount("0.0000"), "0");
  assert.equal(formatAmount("-0.0000"), "0");
  assert.equal(formatAmount("1000000.0001"), "1,000,000.0001");
});

test("each settled request is filed by what the ledger and its label record", () => {
  assert.equal(chatFeature({ api: false, ephemeral: false, body: {} }), "chat");
  assert.equal(
    chatFeature({ api: false, ephemeral: false, body: {}, webSearch: true }),
    "web_search",
  );
  assert.equal(
    chatFeature({
      api: false,
      ephemeral: false,
      body: { mode: "symposium" },
      webSearch: true,
    }),
    "symposium",
  );
  assert.equal(
    chatFeature({
      api: false,
      ephemeral: false,
      body: { mode: "symposium", double_check: {} },
    }),
    "double_check",
  );
  assert.equal(
    chatFeature({
      api: false,
      ephemeral: true,
      body: { mode: "symposium", double_check: {} },
    }),
    "chat",
  );
  assert.equal(
    chatFeature({ api: false, ephemeral: true, body: {}, webSearch: true }),
    "web_search",
  );
  assert.equal(
    chatFeature({ api: true, ephemeral: false, body: { mode: "symposium" } }),
    "chat",
  );
  assert.equal(featureOf("chat", null, "Gemini"), "chat", "unlabelled chat");
  assert.equal(featureOf("chat", "made_up", "Gemini"), "chat");
  assert.equal(featureOf("audio", null, "Speech: Fixture voice"), "speech");
  assert.equal(
    featureOf("audio", null, "Transcription: Nova 3"),
    "transcription",
  );
  assert.equal(featureOf("image", null, "Recovered image batch: X"), "image");
  assert.equal(featureOf("video", null, "kling"), "video");
  assert.deepEqual(recordedModel("video", null, "vendor/video-1"), {
    id: "vendor/video-1",
    name: null,
  });
  assert.deepEqual(recordedModel("chat", null, "Timeout policy: GPT"), {
    id: null,
    name: "GPT",
  });
  assert.deepEqual(recordedModel("audio", "nova-3", "Transcription: Nova 3"), {
    id: "nova-3",
    name: "Nova 3",
  });
  assert.equal(categoryOf("deposit", null, 5), "topup");
  assert.equal(categoryOf("payment_correction", null, -5), "topup");
  assert.equal(categoryOf("chat", "chat", -5), "spend");
  assert.equal(categoryOf("chat", null, -5), "other", "no hold, no spend");
  assert.equal(categoryOf("treasury_withdrawal", null, 5), "team");
  assert.equal(categoryOf("mystery", null, 5), "other");
});

test("中文: every Usage string and pattern the view renders has a translation", () => {
  const raw = JSON.parse(
    readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"),
  );
  const dict = compileDictionary(raw);
  const han = /\p{Script=Han}/u;
  const check = (text) => {
    const zh = translateText(text, dict);
    assert.ok(zh && han.test(zh), `no 中文 for ${JSON.stringify(text)}`);
    // Only names and codes may stay in Latin letters.
    assert.ok(
      !/\b(the|and|your|of|in|to|from|credits?)\b/i.test(zh),
      `English left in ${zh}`,
    );
  };
  for (const s of UI_STRINGS) check(s);
  for (const [, sample] of UI_PATTERNS) check(sample);
  // Every text node written in the component itself is covered too.
  const jsx = readFileSync(
    new URL("../src/UsageInsights.jsx", import.meta.url),
    "utf8",
  );
  const nodes = [...jsx.matchAll(/(?<![=-])>([^<>{}]*[A-Za-z][^<>{}]*)</g)]
    .map((m) => m[1].replace(/\s+/g, " ").trim())
    .filter((s) => s && !/^[=&|?:!)]/.test(s));
  assert.ok(nodes.length >= 10, "the component's text nodes were found");
  for (const node of nodes) check(node);
  for (const s of [
    "Usage",
    "Usage insights",
    "Usage insights and export",
    "Every credit, accounted for.",
  ])
    check(s);
  // Days and dates are numbers only, so they read the same in both languages.
  const sample = demoUsage(30, Date.UTC(2026, 8, 25));
  assert.equal(sample.daily.length, 30);
  assert.equal(sample.daily.at(-1).date, "2026-09-25");
  assert.equal(sumUnits(sample.by_model), sample.totals.spent.units);
  assert.equal(sumUnits(sample.by_feature), sample.totals.spent.units);
  assert.equal(sumUnits(sample.by_source), sample.totals.spent.units);
  assert.equal(sumUnits(sample.daily), sample.totals.spent.units);
  assert.equal(
    exportRangeError("2026-09-01", "2026-09-25", Date.UTC(2026, 8, 25)),
    "",
  );
  assert.match(
    exportRangeError("2026-09-26", "2026-09-25", Date.UTC(2026, 8, 25)),
    /on or before/,
  );
  assert.match(
    exportRangeError("2025-09-24", "2026-09-25", Date.UTC(2026, 8, 25)),
    /366/,
  );
  assert.match(
    exportRangeError("2026-09-20", "2026-09-26", Date.UTC(2026, 8, 25)),
    /today/,
  );
});
