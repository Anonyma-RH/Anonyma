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
import { config, database, hash, now, MIGRATIONS } from "../server/core.js";
import { UPDATES, earlyOpen } from "../server/releases.js";
import {
  createEarlyModels,
  earlyModelsLive,
  viewerOf,
  opensText,
} from "../server/early-models.js";
import {
  parseEarlyModelDays,
  parseModelList,
  DEFAULT_EARLY_MODEL_DAYS,
} from "../server/holder-tiers.js";
import { ACCESS_PREFIX } from "../server/oauth.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  withEarlyModels,
  isEarlyModel,
  earlyModelSuffix,
  earlyEligible,
  earlyModelsReleased,
  earlyModelTitle,
  EarlyModelTag,
} from "../src/early-models.js";
import { REFUSALS, refusalText } from "../src/cost-compare.js";

// Release commits flip `released` on UPDATES entries. Pin every update to
// unreleased for this file so these gates hold whichever have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ALL = UPDATES.map((u) => u.id);
const allBut = (...ids) =>
  ["mvp", ...ALL.filter((id) => !ids.includes(id))].join(",");
const HOUR = 3600000,
  DAY = 24 * HOUR,
  WINDOW = 14 * DAY;
const NYMA_CONTRACT = "0x968be0c1a394bf1ce239e3b40909ec0f9d4f5583";
const HOLDING = { rpc: "http://127.0.0.1:1", token: NYMA_CONTRACT };
const CHAT = "google/gemini-2.5-flash",
  OTHER = "claude-haiku-4.5",
  IMAGE = "google/gemini-2.5-flash-image",
  VIDEO = "kling-2.5-turbo",
  TTS = "fixture-voice",
  STT = "nova-3";
const T0 = Date.UTC(2026, 8, 20, 12);
const wallet = () => "0x" + randomBytes(20).toString("hex");
const WAV =
  "data:audio/wav;base64," + Buffer.from("RIFF0000WAVEfmt ").toString("base64");

// A JSON-RPC stand-in that reports the wrong chain, so any background
// balance refresh fails and holdings stay exactly as a test wrote them.
async function rpcServer(t) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const answer = (call) => ({ jsonrpc: "2.0", id: call.id, result: "0x1" });
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, extra = {}) {
  const dir = extra.dir ?? mkdtempSync(join(tmpdir(), "anonyma-early-models-"));
  const rpc = extra.rpc ?? (await rpcServer(t));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
    released: "all",
    token: NYMA_CONTRACT,
    chain: 4663,
    ...extra,
    rpc,
  });
  svc.dir = dir;
  // Closes once, whether a test closed it early (a restart) or not.
  let open = true;
  svc.shutdown = () => {
    if (open) svc.close();
    open = false;
  };
  t.after(() => {
    svc.shutdown();
    if (!extra.dir) rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function signUp(svc) {
  const agent = request.agent(svc.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor % 250}`)
    .send({
      username: "u" + randomBytes(5).toString("hex"),
      password: "test-password-long",
    })
    .expect(201);
  return { agent, id: r.body.user.id };
}
// Holdings as the worker records them (see tests/holders.test.mjs).
function hold(svc, id, balance, checked = now()) {
  const open = balance >= 1_000_000;
  svc.db
    .prepare(
      "UPDATE users SET wallet=?,token_balance=?,token_checked=?,holder_cycle=?,holder_low=? WHERE id=?",
    )
    .run(
      wallet(),
      String(balance),
      checked,
      open ? checked : null,
      open ? String(balance) : null,
      id,
    );
}
async function insider(svc) {
  const u = await signUp(svc);
  hold(svc, u.id, 6_000_000);
  return u;
}
// The Holder tier: the library perk, short of the Insider minimum.
async function holderTier(svc) {
  const u = await signUp(svc);
  hold(svc, u.id, 4_999_999);
  return u;
}
function apiKey(svc, userId) {
  const secret = "anonyma_" + randomBytes(24).toString("hex");
  svc.db
    .prepare(
      "INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created) VALUES(?,?,?,?,?,?,?)",
    )
    .run(
      "key_" + randomBytes(6).toString("hex"),
      userId,
      hash(secret),
      "test",
      secret.slice(0, 12),
      null,
      now(),
    );
  return "Bearer " + secret;
}
// A live Connect an App connection and access token, as server/oauth.js
// stores them (the same helper as tests/holders.test.mjs, not private-only).
function oauthToken(svc, userId) {
  const t = now(),
    n = randomBytes(6).toString("hex"),
    token = ACCESS_PREFIX + randomBytes(24).toString("hex");
  const db = svc.db;
  db.prepare(
    "INSERT INTO oauth_clients(id,name,redirect_uris,created,authorized) VALUES(?,?,?,?,?)",
  ).run("client_" + n, "Test App", '["http://127.0.0.1:33418/callback"]', t, t);
  db.prepare(
    "INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created,allowance_total,connection_id) VALUES(?,?,NULL,?,NULL,NULL,?,?,?)",
  ).run("key_" + n, userId, "Test App", t, 20_000_000, "conn_" + n);
  db.prepare(
    "INSERT INTO oauth_connections(id,user_id,client_id,key_id,name,client_name,redirect_uri,private_only,created,activated,expires,revoked) VALUES(?,?,?,?,?,?,?,0,?,?,?,NULL)",
  ).run(
    "conn_" + n,
    userId,
    "client_" + n,
    "key_" + n,
    "Test App",
    "Test App",
    "http://127.0.0.1:33418/callback",
    t,
    t,
    t + 86400000,
  );
  db.prepare(
    "INSERT INTO oauth_tokens(hash,connection_id,kind,created,expires,rotated) VALUES(?,?,?,?,?,NULL)",
  ).run(hash(token), "conn_" + n, "access", t, t + 3600000);
  return "Bearer " + token;
}
// A model first seen by a live refresh at `at` (default: just now).
function makeNew(svc, id, catalog = "models", at = now()) {
  svc.db
    .prepare(
      "INSERT INTO model_first_seen(catalog,id,first_seen) VALUES(?,?,?) ON CONFLICT(catalog,id) DO UPDATE SET first_seen=excluded.first_seen",
    )
    .run(catalog, id, at);
  return at;
}
const firstSeen = (db, id, catalog = "models") =>
  db
    .prepare("SELECT first_seen FROM model_first_seen WHERE catalog=? AND id=?")
    .get(catalog, id)?.first_seen;
const count = (db, sql, ...args) => db.prepare(sql).get(...args).n;
const ledger = (svc, id) =>
  count(svc.db, "SELECT COUNT(*) n FROM ledger WHERE user_id=?", id);
// Nothing was reserved, generated, queued or charged for the account.
function untouched(svc, id, ledgerBefore) {
  for (const table of ["holds", "media", "videos"])
    assert.equal(
      count(svc.db, `SELECT COUNT(*) n FROM ${table} WHERE user_id=?`, id),
      0,
      `no ${table} row`,
    );
  assert.equal(ledger(svc, id), ledgerBefore, "no ledger entry");
}
const chatBody = (model) => ({
  model,
  messages: [{ role: "user", content: "Hello" }],
});
const mcp = (app, auth, method, params = {}) =>
  request(app)
    .post("/mcp")
    .set("Authorization", auth)
    .send({ jsonrpc: "2.0", id: 1, method, params });
const early = (r) => {
  assert.equal(r.status, 403, r.text);
  assert.equal(r.body.error.code, "early_model");
  assert.match(
    r.body.error.message,
    /^This model is new and open to NYMA Insiders first\. It opens to everyone on \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\. Nothing was sent or charged\.$/,
  );
  return r;
};

// ---- Registration and settings ----

test("Early Model Access is registered, unreleased by default, and never early itself", (t) => {
  const entry = UPDATES.find((u) => u.id === "earlymodels");
  assert.ok(entry);
  assert.equal(entry.title, "Early Model Access");
  assert.equal(entry.tagline, "New models open to NYMA Insiders first.");
  assert.equal(entry.points.length, 3);
  assert.equal(committed[UPDATES.indexOf(entry)], true, "released by its release commit");
  assert.ok(
    UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "referralboost"),
    "added after Referral Boost",
  );
  assert.equal(entry.early, undefined);
  // Even marked early, it's a holder perk already: never an early update.
  entry.early = true;
  t.after(() => delete entry.early);
  assert.equal(
    earlyOpen(config({ released: allBut("earlymodels") }), "earlymodels"),
    false,
  );
  // No investment language anywhere in its copy.
  const copy = [entry.title, entry.tagline, ...entry.points].join(" ");
  assert.doesNotMatch(copy, /return|yield|profit|price|value|invest|earn/i);
});

test("EARLY_MODEL_DAYS and EARLY_MODEL_EXEMPT: defaults, bounds and bad values", (t) => {
  assert.equal(DEFAULT_EARLY_MODEL_DAYS, 14);
  assert.equal(parseEarlyModelDays(""), 14);
  assert.equal(parseEarlyModelDays(undefined), 14);
  assert.equal(parseEarlyModelDays(" 7 "), 7);
  assert.equal(parseEarlyModelDays("0"), 0);
  assert.equal(parseEarlyModelDays("90"), 90);
  assert.equal(parseEarlyModelDays(3), 3);
  for (const bad of ["91", "-1", "1.5", "x", "14 days", 91, -1, 2.5, NaN])
    assert.throws(
      () => parseEarlyModelDays(bad),
      /EARLY_MODEL_DAYS/,
      String(bad),
    );
  assert.deepEqual(parseModelList(" a, b ,,a "), ["a", "b"]);
  assert.deepEqual(parseModelList(""), []);
  assert.deepEqual(parseModelList(["x", " x", "y"]), ["x", "y"]);
  const saved = {
    d: process.env.EARLY_MODEL_DAYS,
    e: process.env.EARLY_MODEL_EXEMPT,
  };
  t.after(() => {
    for (const [k, v] of [
      ["EARLY_MODEL_DAYS", saved.d],
      ["EARLY_MODEL_EXEMPT", saved.e],
    ])
      v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  process.env.EARLY_MODEL_DAYS = "3";
  process.env.EARLY_MODEL_EXEMPT = "vendor/a, vendor/b";
  const cfg = config({});
  assert.equal(cfg.earlyModelDays, 3);
  assert.deepEqual(cfg.earlyModelExempt, ["vendor/a", "vendor/b"]);
  process.env.EARLY_MODEL_DAYS = "forever";
  assert.throws(() => config({}), /EARLY_MODEL_DAYS/);
  delete process.env.EARLY_MODEL_DAYS;
  delete process.env.EARLY_MODEL_EXEMPT;
  assert.equal(config({}).earlyModelDays, 14);
  assert.deepEqual(config({}).earlyModelExempt, []);
});

// ---- When a model is new ----

function bare(t, overrides = {}) {
  const db = database(":memory:");
  const cfg = config({ released: "all", ...HOLDING, ...overrides });
  t.after(() => db.isOpen && db.close());
  return { db, cfg, early: createEarlyModels(db, cfg) };
}

test("first seen: reference catalogs and the first live catalog are the baseline; later live refreshes record new ids once", (t) => {
  const { db, early } = bare(t);
  const baselines = () =>
    db.prepare("SELECT * FROM model_catalog_baselines ORDER BY catalog").all();
  // The bundled snapshot (not live): known, never new, and no baseline yet.
  assert.deepEqual(early.record("models", ["a", "b"], { live: false, t: T0 }), {
    added: 2,
    baseline: false,
    firstSeen: 0,
  });
  assert.equal(firstSeen(db, "a"), 0);
  assert.deepEqual(baselines(), []);
  // The first live catalog is the baseline: everything in it is known.
  assert.deepEqual(
    early.record("models", ["a", "b", "c"], { live: true, t: T0 + 1 }),
    { added: 1, baseline: true, firstSeen: 0 },
  );
  assert.equal(firstSeen(db, "c"), 0);
  assert.deepEqual(
    baselines().map((r) => ({ ...r })),
    [{ catalog: "models", taken: T0 + 1 }],
  );
  // After it, an id a live refresh lists for the first time is new, once.
  const T1 = T0 + DAY;
  assert.deepEqual(
    early.record("models", ["a", "c", "d"], { live: true, t: T1 }),
    { added: 1, baseline: false, firstSeen: T1 },
  );
  assert.equal(firstSeen(db, "d"), T1);
  early.record("models", ["d", "e"], { live: true, t: T1 + HOUR });
  assert.equal(firstSeen(db, "d"), T1, "never moved by a later refresh");
  assert.equal(firstSeen(db, "e"), T1 + HOUR);
  // Leaving the catalog and coming back doesn't make a model new again.
  early.record("models", ["a"], { live: true, t: T1 + 2 * DAY });
  early.record("models", ["a", "b", "d"], { live: true, t: T1 + 3 * DAY });
  assert.equal(firstSeen(db, "b"), 0);
  assert.equal(firstSeen(db, "d"), T1);
  // A reference catalog after the baseline still never makes anything new.
  early.record("models", ["z"], { live: false, t: T1 + 4 * DAY });
  assert.equal(firstSeen(db, "z"), 0);
  // Each catalog keeps its own baseline.
  early.recordAudio({ tts: [{ id: "v1" }], stt: [{ id: "s1" }] }, true, {
    t: T1,
  });
  early.recordAudio(
    { tts: [{ id: "v1" }, { id: "v2" }], stt: [{ id: "s1" }] },
    true,
    { t: T1 + 5 },
  );
  assert.equal(firstSeen(db, "v1", "tts"), 0);
  assert.equal(firstSeen(db, "v2", "tts"), T1 + 5);
  assert.equal(firstSeen(db, "s1", "stt"), 0);
  assert.deepEqual(
    baselines().map((r) => r.catalog),
    ["models", "stt", "tts"],
  );
  // recordCatalog reads the snapshot's own live flag.
  early.recordCatalog({ data: [{ id: "f" }], live: true }, { t: T1 + 6 });
  early.recordCatalog({ data: [{ id: "g" }] }, { t: T1 + 7 });
  assert.equal(firstSeen(db, "f"), T1 + 6);
  assert.equal(firstSeen(db, "g"), 0);
  // Junk ids are skipped; an unknown catalog is a bug.
  early.record("models", [null, 7, "", "x".repeat(251), "ok"], {
    live: true,
    t: T1,
  });
  assert.equal(
    count(
      db,
      "SELECT COUNT(*) n FROM model_first_seen WHERE length(id)>250 OR id=''",
    ),
    0,
  );
  assert.equal(firstSeen(db, "ok"), T1);
  assert.throws(() => early.record("images", ["x"]), /Unknown model catalog/);
  // The table refuses anything but a whole, non-negative time.
  assert.throws(() =>
    db.prepare("INSERT INTO model_first_seen VALUES('models','neg',-1)").run(),
  );
  assert.throws(() =>
    db
      .prepare("INSERT INTO model_first_seen VALUES('models','real',1.5)")
      .run(),
  );
});

test("the migration is additive, and an upgraded database takes its current catalog as the baseline", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-early-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "models.json");
  const liveCache = (ids) =>
    writeFileSync(
      catalogPath,
      JSON.stringify({
        data: ids.map((id) => ({
          id,
          name: id,
          type: "chat",
          status: "live",
          pricing: { input_per_1M_tokens: 1, output_per_1M_tokens: 2 },
        })),
        updatedAt: new Date().toISOString(),
        source: "Configured gateway catalog",
        live: true,
      }),
    );
  // A live cache from before this release: all of it is already public.
  liveCache(["vendor/one", "vendor/two"]);
  const first = await fixture(t, { dir, catalogPath });
  const additive = first.db
    .prepare("SELECT version FROM schema_additive")
    .all()
    .map((r) => r.version);
  assert.ok(
    additive.includes(MIGRATIONS.length),
    "the Early Model Access migration is additive",
  );
  assert.equal(
    first.db.prepare("PRAGMA user_version").get().user_version,
    MIGRATIONS.length,
  );
  assert.equal(firstSeen(first.db, "vendor/one"), 0);
  assert.equal(firstSeen(first.db, "vendor/two"), 0);
  assert.equal(
    count(
      first.db,
      "SELECT COUNT(*) n FROM model_first_seen WHERE first_seen>0",
    ),
    0,
  );
  assert.equal(
    count(
      first.db,
      "SELECT COUNT(*) n FROM model_catalog_baselines WHERE catalog='models'",
    ),
    1,
  );
  first.shutdown();
  // The operator refreshed the catalog while the service was down: the new
  // id is recorded as first seen at the next start.
  liveCache(["vendor/one", "vendor/two", "vendor/three"]);
  const before = now();
  const second = await fixture(t, { dir, catalogPath });
  assert.ok(firstSeen(second.db, "vendor/three") >= before);
  assert.equal(firstSeen(second.db, "vendor/one"), 0);
});

test("a live refresh records a new model before it's offered; one that can't be recorded is dropped", async (t) => {
  let ids = [CHAT, OTHER];
  const row = (id) => ({
    id,
    name: id === "vendor/brand-new" ? "Brand New" : id,
    type: "chat",
    owned_by: "vendor",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { input_per_1M_tokens: 1, output_per_1M_tokens: 2 },
  });
  // Both feeds (/v1/models and its image/video one) answer with the same
  // rows: syncCatalog refuses an empty feed and merges them by id.
  const gateway = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: ids.map(row) }));
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => gateway.close(r)));
  let clock = Date.now();
  t.mock.method(Date, "now", () => clock);
  const svc = await fixture(t, {
    syncModels: true,
    gateway: `http://127.0.0.1:${gateway.address().port}`,
  });
  const n = await holderTier(svc);
  // The first live refresh is the baseline.
  let list = (await request(svc.app).get("/api/models").expect(200)).body;
  assert.equal(list.live, true);
  assert.equal(firstSeen(svc.db, CHAT), 0);
  assert.equal(list.data.filter((m) => m.earlyUntil).length, 0);
  // Five minutes on, the gateway lists a model nobody has seen.
  ids = [CHAT, OTHER, "vendor/brand-new"];
  clock += 301_000;
  const seenAt = clock;
  list = (await request(svc.app).get("/api/models").expect(200)).body;
  assert.equal(firstSeen(svc.db, "vendor/brand-new"), seenAt);
  const fresh = list.data.find((m) => m.id === "vendor/brand-new");
  assert.equal(fresh.earlyUntil, seenAt + WINDOW);
  early(await n.agent.post("/api/quote").send(chatBody("vendor/brand-new")));
  // A refresh that can't be recorded never reaches the catalog.
  ids = [CHAT, OTHER, "vendor/brand-new", "vendor/unrecorded"];
  clock += 301_000;
  svc.db.exec(
    "CREATE TRIGGER refuse_one BEFORE INSERT ON model_first_seen WHEN NEW.id='vendor/unrecorded' BEGIN SELECT RAISE(ABORT,'disk full'); END",
  );
  list = (await request(svc.app).get("/api/models").expect(200)).body;
  assert.match(
    list.refreshError,
    /disk full/,
    "the refresh is reported as failed",
  );
  assert.ok(
    !list.data.some((m) => m.id === "vendor/unrecorded"),
    "the unrecorded model isn't offered",
  );
  assert.equal(firstSeen(svc.db, "vendor/unrecorded"), undefined);
  // Nothing half-recorded: the whole refresh rolled back together.
  assert.equal(
    list.data.find((m) => m.id === "vendor/brand-new").earlyUntil,
    seenAt + WINDOW,
  );
});

// ---- The window and who gets it ----

test("the window: open to Insiders for exactly EARLY_MODEL_DAYS, then to everyone", (t) => {
  const { db, cfg, early } = bare(t);
  early.record("models", ["old"], { live: true, t: T0 });
  early.record("models", ["old", "new"], { live: true, t: T0 + HOUR });
  const opens = T0 + HOUR + WINDOW;
  assert.deepEqual([...early.inWindow("models", T0 + HOUR)], [["new", opens]]);
  assert.equal(early.inWindow("models", opens - 1).get("new"), opens);
  assert.equal(
    early.inWindow("models", opens).size,
    0,
    "open to everyone at the minute it opens",
  );
  assert.equal(early.inWindow("models", opens + DAY).size, 0);
  assert.equal(early.inWindow("tts", T0 + HOUR).size, 0);
  // Anyone may use it from then on; before, only an eligible viewer.
  const nobody = { user: null, app: false };
  assert.throws(() => early.check(nobody, "models", "new", opens - 1), {
    code: "early_model",
  });
  early.check(nobody, "models", "new", opens);
  early.check(nobody, "models", "old", T0 + HOUR);
  // The message names the minute, in UTC.
  assert.equal(
    opensText(Date.UTC(2026, 9, 9, 14, 5, 59)),
    "2026-10-09 14:05 UTC",
  );
  try {
    early.check(nobody, "models", "new", T0 + HOUR);
  } catch (e) {
    assert.equal(e.status, 403);
    assert.deepEqual(e.earlyModel, {
      model: "new",
      opens_at: new Date(opens).toISOString(),
    });
    assert.match(e.message, new RegExp(opensText(opens)));
  }
  // A shorter window, and 0, which turns the feature off.
  const short = createEarlyModels(db, { ...cfg, earlyModelDays: 1 });
  assert.equal(short.inWindow("models", T0 + HOUR).get("new"), T0 + HOUR + DAY);
  assert.equal(short.inWindow("models", T0 + HOUR + DAY).size, 0);
  const off = { ...cfg, earlyModelDays: 0 };
  assert.equal(earlyModelsLive(off), false);
  assert.equal(
    createEarlyModels(db, off).inWindow("models", T0 + HOUR).size,
    0,
  );
  // Exempt ids open to everyone at once; the rest keep their window.
  early.record("models", ["old", "new", "newer"], {
    live: true,
    t: T0 + 2 * HOUR,
  });
  const exempt = createEarlyModels(db, { ...cfg, earlyModelExempt: ["new"] });
  assert.deepEqual(
    [...exempt.inWindow("models", T0 + 2 * HOUR).keys()],
    ["newer"],
  );
});

test("eligibility is the Holder Program's current tier, Insider and up, with a fresh check; never a connected app", (t) => {
  const { cfg, early } = bare(t);
  const at = T0 + 10 * DAY;
  const user = (balance, checked = at - HOUR, extra = {}) => ({
    id: "u",
    wallet: wallet(),
    deleted: null,
    token_balance: String(balance),
    token_checked: checked,
    holder_cycle: balance >= 1_000_000 ? checked : null,
    holder_low: balance >= 1_000_000 ? String(balance) : null,
    ...extra,
  });
  const yes = (u, app = false) => early.eligible({ user: u, app }, at);
  assert.equal(yes(null), false, "signed out");
  assert.equal(
    yes(user(9_000_000, at - HOUR, { wallet: null })),
    false,
    "no wallet",
  );
  assert.equal(yes(user(999_999)), false, "below every tier");
  assert.equal(yes(user(4_999_999)), false, "Holder tier");
  assert.equal(yes(user(5_000_000)), true, "Insider minimum");
  assert.equal(yes(user(25_000_000)), true, "Inner Circle");
  assert.equal(
    yes(user(6_000_000, at - 48 * HOUR)),
    true,
    "a check exactly 48 hours old still counts",
  );
  assert.equal(
    yes(user(6_000_000, at - 48 * HOUR - 1)),
    false,
    "a stale check doesn't",
  );
  assert.equal(
    yes(user(6_000_000, at - HOUR, { deleted: at - 1 })),
    false,
    "closed account",
  );
  // The tier is the cycle's LOWEST balance, as for every perk.
  assert.equal(
    yes(user(9_000_000, at - HOUR, { holder_low: "4000000" })),
    false,
  );
  assert.equal(
    yes(user(30_000_000), true),
    false,
    "a connected app, whatever the account holds",
  );
  // A viewer is an app when the request came through a connection.
  assert.deepEqual(viewerOf({ user: { id: "u" } }), {
    user: { id: "u" },
    app: false,
  });
  assert.equal(
    viewerOf({ user: {}, apiKey: { id: "k", connection_id: null } }).app,
    false,
  );
  assert.equal(
    viewerOf({ user: {}, apiKey: { id: "k", connection_id: "conn" } }).app,
    true,
  );
  assert.equal(viewerOf({ user: {}, appConnection: { id: "conn" } }).app, true);
  assert.equal(viewerOf({ user: {}, standardRate: true }).app, true);
  assert.deepEqual(viewerOf(undefined), { user: null, app: false });
  // Without the program live and balance checks on, nobody could qualify:
  // then the feature is off and every model is open to everyone.
  assert.equal(earlyModelsLive(cfg), true);
  assert.equal(earlyModelsLive({ ...cfg, rpc: "" }), false);
  assert.equal(earlyModelsLive({ ...cfg, token: "" }), false);
  assert.equal(
    earlyModelsLive(config({ released: allBut("holders"), ...HOLDING })),
    false,
  );
  assert.equal(
    earlyModelsLive(config({ released: allBut("earlymodels"), ...HOLDING })),
    false,
  );
  assert.equal(
    earlyModelsLive(
      config({ released: "mvp,holders,earlymodels", ...HOLDING }),
    ),
    true,
  );
});

// ---- Every surface ----

test("lists: /api/models is the same for everyone and marks the model; the app and key-bound lists follow the account", async (t) => {
  const svc = await fixture(t);
  const opens = makeNew(svc, CHAT) + WINDOW;
  makeNew(svc, TTS, "tts");
  const i = await insider(svc),
    h = await holderTier(svc),
    plain = await signUp(svc),
    anon = request.agent(svc.app);
  // /api/models: identical for every viewer, like every public surface.
  const [a, b, c, d] = await Promise.all(
    [i, h, plain]
      .map((u) => u.agent.get("/api/models"))
      .concat(anon.get("/api/models")),
  );
  for (const r of [b, c, d]) assert.equal(r.text, a.text);
  const models = a.body.data;
  assert.equal(models.find((m) => m.id === CHAT).earlyUntil, opens);
  assert.equal(models.filter((m) => m.earlyUntil).length, 1);
  // The app offers it only when the session says the account is eligible,
  // which drives every picker, Model Finder, Cost Compare, @mentions and
  // Symposium (all read the context's models).
  const session = async (u) =>
    (await u.agent.get("/api/me").expect(200)).body.user;
  const [si, sh, sp] = await Promise.all([
    session(i),
    session(h),
    session(plain),
  ]);
  assert.equal(si.holder.eligible, true);
  assert.equal(sh.holder.eligible, false);
  assert.ok(withEarlyModels(models, si).some((m) => m.id === CHAT));
  for (const who of [sh, sp, null]) {
    const offered = withEarlyModels(models, who);
    assert.ok(!offered.some((m) => m.id === CHAT));
    assert.equal(offered.length, models.length - 1);
  }
  // /v1/models and /v1 follow the key's account.
  const ki = apiKey(svc, i.id),
    kh = apiKey(svc, h.id);
  const v1 = async (key) =>
    (
      await request(svc.app)
        .get("/v1/models")
        .set("Authorization", key)
        .expect(200)
    ).body.data.map((m) => m.id);
  assert.ok((await v1(ki)).includes(CHAT));
  assert.ok(!(await v1(kh)).includes(CHAT));
  assert.ok((await v1(kh)).includes(OTHER));
  const info = async (key) =>
    (await request(svc.app).get("/v1").set("Authorization", key).expect(200))
      .body.models;
  assert.equal(await info(ki), (await info(kh)) + 1);
  // MCP list_models: the account's own key follows the account; a connected
  // app never sees it, even on an Insider account.
  const listed = async (auth) =>
    (
      await mcp(svc.app, auth, "tools/call", {
        name: "list_models",
        arguments: {},
      }).expect(200)
    ).body.result.structuredContent.models.map((m) => m.id);
  assert.ok((await listed(ki)).includes(CHAT));
  assert.ok(!(await listed(kh)).includes(CHAT));
  const app = oauthToken(svc, i.id);
  const appList = await listed(app);
  assert.ok(appList.length > 0 && !appList.includes(CHAT));
  // Speech models: that list is already the account's own (priced at its
  // rate), so it leaves the early one out for everyone else.
  const voices = async (agent) =>
    (await agent.get("/api/audio/models").expect(200)).body.tts;
  const vi = await voices(i.agent);
  assert.ok(vi.find((m) => m.id === TTS).earlyUntil > now());
  assert.ok(!(await voices(h.agent)).some((m) => m.id === TTS));
  assert.ok(!(await voices(anon)).some((m) => m.id === TTS));
  // Holdings and the NYMA page: the same list for everyone.
  const holdings = async (u) =>
    (await u.agent.get("/api/account/holdings").expect(200)).body.earlyModels;
  const hi = await holdings(i);
  assert.equal(hi.days, 14);
  assert.deepEqual(
    hi.models
      .map(({ id, type, opensAt }) => ({ id, type, opensAt }))
      .sort((x, y) => x.id.localeCompare(y.id)),
    [
      {
        id: TTS,
        type: "speech",
        opensAt: firstSeen(svc.db, TTS, "tts") + WINDOW,
      },
      { id: CHAT, type: "chat", opensAt: opens },
    ].sort((x, y) => x.id.localeCompare(y.id)),
  );
  assert.equal(hi.models.find((m) => m.id === CHAT).name, "Gemini 2.5 Flash");
  assert.deepEqual(await holdings(h), hi);
  assert.deepEqual(
    (await anon.get("/api/holders/summary").expect(200)).body.earlyModels,
    hi,
  );
  // After the window: a normal model, everywhere.
  makeNew(svc, CHAT, "models", now() - WINDOW);
  assert.ok(
    !(await anon.get("/api/models")).body.data.find((m) => m.id === CHAT)
      .earlyUntil,
  );
  assert.ok((await v1(kh)).includes(CHAT));
  assert.ok(!(await holdings(h)).models.some((m) => m.id === CHAT));
});

test("a request naming an early model is refused before anything is reserved, on every paid path", async (t) => {
  const svc = await fixture(t);
  for (const id of [CHAT, IMAGE, VIDEO]) makeNew(svc, id);
  makeNew(svc, TTS, "tts");
  makeNew(svc, STT, "stt");
  const h = await holderTier(svc),
    i = await insider(svc);
  const kh = apiKey(svc, h.id);
  const before = ledger(svc, h.id);
  const post = (path, body) => h.agent.post(path).send(body);
  const v1 = (path, body) =>
    request(svc.app).post(path).set("Authorization", kh).send(body);
  // The workspace.
  const r = early(await post("/api/chat", chatBody(CHAT)));
  assert.equal(r.body.early_model.model, CHAT);
  assert.equal(
    r.body.early_model.opens_at,
    new Date(firstSeen(svc.db, CHAT) + WINDOW).toISOString(),
  );
  early(await post("/api/chat", { ...chatBody(CHAT), mode: "symposium" }));
  early(await post("/api/quote", chatBody(CHAT)));
  early(
    await post("/api/images", { model: IMAGE, prompt: "A lighthouse", n: 1 }),
  );
  early(
    await post("/api/videos", {
      model: VIDEO,
      prompt: "A lighthouse",
      aspect_ratio: "16:9",
      duration: "5",
    }),
  );
  early(await post("/api/audio/speech", { model: TTS, text: "Hello" }));
  early(await post("/api/audio/transcriptions", { model: STT, audio: WAV }));
  // The API, with the account's own key.
  early(await v1("/v1/chat/completions", chatBody(CHAT)));
  early(
    await v1("/v1/images/generations", { model: IMAGE, prompt: "x", n: 1 }),
  );
  early(await v1("/v1/audio/speech", { model: TTS, input: "Hello" }));
  early(
    await v1("/v1/videos", {
      model: VIDEO,
      prompt: "x",
      aspect_ratio: "16:9",
      duration: "5",
    }),
  );
  early(
    await request(svc.app)
      .post("/v1/audio/transcriptions")
      .set("Authorization", kh)
      .field("model", STT)
      .attach("file", Buffer.from("fake-wav-bytes"), {
        filename: "clip.wav",
        contentType: "audio/wav",
      }),
  );
  // MCP with the account's own key: the same refusal, as a tool error.
  const ask = (
    await mcp(svc.app, kh, "tools/call", {
      name: "ask",
      arguments: { model: CHAT, prompt: "Hi" },
    }).expect(200)
  ).body.result;
  assert.equal(ask.isError, true);
  assert.match(ask.content[0].text, /open to NYMA Insiders first/);
  // Cost Compare prices the rest and refuses just that row.
  const compare = (
    await post("/api/estimate/compare", {
      messages: [{ role: "user", content: "Hello" }],
      models: [CHAT, OTHER],
    }).expect(200)
  ).body.results;
  assert.equal(compare.find((x) => x.model === CHAT).code, "early_model");
  assert.equal(compare.find((x) => x.model === CHAT).status, "refused");
  assert.equal(compare.find((x) => x.model === OTHER).status, "ok");
  untouched(svc, h.id, before);
  // A connected app on an Insider account gets the generic answer: it never
  // learns the tier, the program or the window.
  const app = oauthToken(svc, i.id);
  const appAsk = (
    await mcp(svc.app, app, "tools/call", {
      name: "ask",
      arguments: { model: CHAT, prompt: "Hi" },
    }).expect(200)
  ).body.result;
  assert.equal(appAsk.isError, true);
  assert.equal(
    appAsk.content[0].text,
    "This model is catalog-only or unavailable.",
  );
  assert.equal(
    count(svc.db, "SELECT COUNT(*) n FROM holds WHERE user_id=?", i.id),
    0,
  );
  // The eligible account itself goes through, on the same paths.
  const ki = apiKey(svc, i.id);
  await i.agent.post("/api/quote").send(chatBody(CHAT)).expect(200);
  const chat = await i.agent.post("/api/chat").send(chatBody(CHAT)).expect(200);
  assert.match(chat.text, /\[DONE\]/);
  await request(svc.app)
    .post("/v1/chat/completions")
    .set("Authorization", ki)
    .send(chatBody(CHAT))
    .expect(200);
  await i.agent
    .post("/api/images")
    .send({ model: IMAGE, prompt: "A lighthouse", n: 1 })
    .expect(200);
  await i.agent
    .post("/api/audio/speech")
    .send({ model: TTS, text: "Hello" })
    .expect(200);
  const own = (
    await mcp(svc.app, ki, "tools/call", {
      name: "ask",
      arguments: { model: CHAT, prompt: "Hi" },
    }).expect(200)
  ).body.result;
  assert.equal(own.isError, undefined);
  const ok = (
    await i.agent
      .post("/api/estimate/compare")
      .send({ messages: [{ role: "user", content: "Hello" }], models: [CHAT] })
      .expect(200)
  ).body.results;
  assert.equal(ok[0].status, "ok");
  // A stale balance check puts the account back with everyone else.
  svc.db
    .prepare("UPDATE users SET token_checked=? WHERE id=?")
    .run(now() - 49 * HOUR, i.id);
  early(await i.agent.post("/api/quote").send(chatBody(CHAT)));
});

test("Projects and Routines: an early model can't be chosen below Insider, and each routine run checks again", async (t) => {
  const svc = await fixture(t);
  makeNew(svc, CHAT);
  const h = await holderTier(svc),
    i = await insider(svc);
  early(
    await h.agent.post("/api/projects").send({ name: "Launch", model: CHAT }),
  );
  const project = (
    await i.agent
      .post("/api/projects")
      .send({ name: "Launch", model: CHAT })
      .expect(201)
  ).body;
  const other = (
    await h.agent.post("/api/projects").send({ name: "Other" }).expect(201)
  ).body;
  early(await h.agent.patch("/api/projects/" + other.id).send({ model: CHAT }));
  await h.agent
    .patch("/api/projects/" + other.id)
    .send({ model: OTHER })
    .expect(200);
  // Renaming a project whose default went early later isn't blocked.
  svc.db
    .prepare("UPDATE users SET token_checked=? WHERE id=?")
    .run(now() - 49 * HOUR, i.id);
  await i.agent
    .patch("/api/projects/" + project.id)
    .send({ name: "Renamed" })
    .expect(200);
  hold(svc, i.id, 6_000_000);
  const routine = {
    name: "Morning",
    prompt: "Summarise the news in 3 bullets.",
    model: CHAT,
    schedule: { repeat: "daily", time: "08:00", timezone: "UTC" },
    per_run_credits: 50,
    monthly_budget_credits: 500,
  };
  early(await h.agent.post("/api/routines").send(routine));
  const mine = (await i.agent.post("/api/routines").send(routine).expect(201))
    .body;
  // The account drops below Insider before the run: the run is refused
  // before anything is reserved.
  hold(svc, i.id, 4_000_000);
  svc.db
    .prepare("UPDATE routines SET next_run=? WHERE id=?")
    .run(now() - 1000, mine.id);
  svc.routines.startDue();
  await svc.routines.idle();
  const run = svc.db
    .prepare("SELECT * FROM routine_runs WHERE routine_id=?")
    .get(mine.id);
  assert.equal(run.status, "refused");
  assert.equal(run.code, "early_model");
  assert.equal(
    count(svc.db, "SELECT COUNT(*) n FROM holds WHERE user_id=?", i.id),
    0,
  );
});

test("EARLY_MODEL_EXEMPT opens a model to everyone at once", async (t) => {
  const svc = await fixture(t, { earlyModelExempt: [CHAT] });
  makeNew(svc, CHAT);
  makeNew(svc, OTHER);
  const h = await holderTier(svc);
  const models = (await request(svc.app).get("/api/models").expect(200)).body
    .data;
  assert.equal(models.find((m) => m.id === CHAT).earlyUntil, undefined);
  assert.ok(models.find((m) => m.id === OTHER).earlyUntil > now());
  await h.agent.post("/api/quote").send(chatBody(CHAT)).expect(200);
  early(await h.agent.post("/api/quote").send(chatBody(OTHER)));
  assert.deepEqual(
    (
      await h.agent.get("/api/account/holdings").expect(200)
    ).body.earlyModels.models.map((m) => m.id),
    [OTHER],
  );
});

test("switched off, it changes nothing: unreleased, EARLY_MODEL_DAYS=0, no Holder Program, no balance checks", async (t) => {
  for (const [label, extra] of [
    ["unreleased", { released: allBut("earlymodels") }],
    ["days 0", { earlyModelDays: 0 }],
    ["program unreleased", { released: allBut("holders") }],
    ["no balance checks", { rpc: "", token: "" }],
  ]) {
    const svc = await fixture(t, extra);
    makeNew(svc, CHAT);
    const h = await holderTier(svc);
    const models = (await request(svc.app).get("/api/models").expect(200)).body
      .data;
    assert.ok(!models.some((m) => m.earlyUntil), label);
    await h.agent.post("/api/quote").send(chatBody(CHAT)).expect(200);
    const key = apiKey(svc, h.id);
    const listed = (
      await request(svc.app)
        .get("/v1/models")
        .set("Authorization", key)
        .expect(200)
    ).body.data;
    assert.ok(
      listed.some((m) => m.id === CHAT),
      label,
    );
    if (label !== "program unreleased") {
      const holdings = (await h.agent.get("/api/account/holdings").expect(200))
        .body;
      assert.equal(holdings.earlyModels, undefined, label);
      assert.equal(
        (await request(svc.app).get("/api/holders/summary").expect(200)).body
          .earlyModels,
        undefined,
        label,
      );
    }
  }
});

// ---- The browser ----

test("the browser: who is offered an early model, the Early tag, and Cost Compare's words", () => {
  const at = Date.now();
  const models = [
    { id: "a", name: "A" },
    { id: "b", name: "B", earlyUntil: at + DAY },
    { id: "c", name: "C", earlyUntil: at - 1 },
  ];
  const eligible = { holder: { eligible: true } };
  assert.equal(earlyEligible(eligible), true);
  assert.equal(earlyEligible({ holder: { eligible: false } }), false);
  assert.equal(earlyEligible(null), false);
  assert.equal(withEarlyModels(models, eligible, at), models);
  assert.deepEqual(
    withEarlyModels(models, { holder: { eligible: false } }, at).map(
      (m) => m.id,
    ),
    ["a", "c"],
  );
  assert.deepEqual(
    withEarlyModels(models, null, at).map((m) => m.id),
    ["a", "c"],
  );
  // Nothing early: the same array back, so React sees no change.
  const plain = [{ id: "a" }];
  assert.equal(withEarlyModels(plain, null), plain);
  assert.equal(isEarlyModel(models[1], at), true);
  assert.equal(
    isEarlyModel(models[2], at),
    false,
    "past its window: a normal model",
  );
  assert.equal(isEarlyModel(models[0], at), false);
  assert.equal(earlyModelSuffix(models[1]), " · Early");
  assert.equal(earlyModelSuffix(models[0]), "");
  assert.match(
    earlyModelTitle(at + DAY),
    /^New model: open to NYMA Insiders and up first\. Opens to everyone .+\.$/,
  );
  const on = { releases: { features: { earlymodels: true, holders: true } } };
  assert.equal(earlyModelsReleased(on), true);
  assert.equal(
    earlyModelsReleased({ releases: { features: { earlymodels: true } } }),
    false,
  );
  assert.equal(refusalText("early_model"), "Open to NYMA Insiders first");
  assert.equal(REFUSALS.early_model, "Open to NYMA Insiders first");
});

// ---- Chinese ----

const zh = compileDictionary(
  JSON.parse(
    readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"),
  ),
);
const han = /\p{Script=Han}/u;

test("the Chinese dictionary covers the update, the tag, the Holdings list and the refusal", () => {
  const entry = UPDATES.find((u) => u.id === "earlymodels");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Early",
    "· Early",
    "New models open to Insiders first",
    "For their first 14 days, newly added models are open to the Insider tier and up, then to everyone.",
    "For their first 1 day, newly added models are open to the Insider tier and up, then to everyone.",
    "They're in your model pickers now, tagged Early.",
    "Opens to everyone 10/9/2026, 2:05 PM",
    "No new models in early access right now. The next ones show here.",
    "New model: open to NYMA Insiders and up first. Opens to everyone 10/9/2026, 2:05 PM.",
    "This model is new and open to NYMA Insiders first. It opens to everyone on 2026-10-09 14:05 UTC. Nothing was sent or charged.",
    "Open to NYMA Insiders first",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
});

// Holders.jsx compiled for Node with the esbuild Vite uses; shared UI and
// routing are swapped for plain stand-ins so only its own text renders.
async function holdersModule() {
  const src = new URL("../src/Holders.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(
    readFileSync(src, "utf8"),
    src.pathname,
    { jsx: "transform", format: "esm" },
  );
  const dir = mkdtempSync(join(tmpdir(), "anonyma-early-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Icon = () => React.createElement("svg");`,
  );
  const router = stub(
    "router.mjs",
    `export const Link = ({ children, to, className }) => React.createElement("a", { href: to, className }, children);`,
  );
  const lib = stub("lib.mjs", `export const api = async () => ({});`);
  // Referral Boost's own Holdings block isn't under test here.
  const boost = stub("ReferralBoost.mjs", `export const HoldingsBoost = () => null;`);
  // Nor is API Boost's (tests/api-boost.test.mjs).
  const apiBoost = stub("ApiBoost.mjs", `export const HoldingsApiBoost = () => null;`);
  const out = code
    .replace(/^import "\.\/holders\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "\.\/lib\.js"/g, `from "${lib}"`)
    .replace(/from "\.\/ReferralBoost\.jsx"/g, `from "${boost}"`)
    .replace(/from "\.\/ApiBoost\.jsx"/g, `from "${apiBoost}"`)
    .replace(
      /from "\.\/(holders|early-models|referral-boost|api-boost)\.js"/g,
      (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`,
    )
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "Holders.mjs");
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
function textsOf(html) {
  const stack = [],
    page = [],
    kept = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(
        /(?:placeholder|aria-label|title)="([^"]*)"/g,
      ))
        (off || stack.some((x) => x.off) ? kept : page).push(entities(attr));
      if (m[1]) stack.pop();
      else if (!tag.endsWith("/>")) stack.push({ off });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    }
  }
  const words = (list) => list.filter((x) => /[A-Za-z]{2}/.test(x));
  return { page: words(page), kept: words(kept) };
}

test("the Holdings list and the Early tag render translated text, with model names kept as written", async () => {
  const { EarlyModelList } = await holdersModule();
  const soon = Date.now() + 3 * DAY;
  const list = {
    days: 14,
    models: [
      { id: CHAT, name: "Gemini 2.5 Flash", type: "chat", opensAt: soon },
      { id: "gone", name: "Opened", type: "chat", opensAt: Date.now() - 1 },
    ],
  };
  const html = [
    renderToStaticMarkup(
      createElement(EarlyModelList, { early: list, eligible: true }),
    ),
    renderToStaticMarkup(
      createElement(EarlyModelList, {
        early: { days: 1, models: [] },
        eligible: false,
      }),
    ),
    renderToStaticMarkup(
      createElement(EarlyModelTag, { model: { id: CHAT, earlyUntil: soon } }),
    ),
  ].join("");
  assert.equal(
    renderToStaticMarkup(createElement(EarlyModelList, { early: undefined })),
    "",
  );
  assert.equal(
    renderToStaticMarkup(createElement(EarlyModelTag, { model: { id: CHAT } })),
    "",
  );
  assert.equal(
    renderToStaticMarkup(
      createElement(EarlyModelTag, {
        model: { id: CHAT, earlyUntil: Date.now() - 1 },
      }),
    ),
    "",
  );
  const { page, kept } = textsOf(html);
  assert.deepEqual(
    kept,
    ["Gemini 2.5 Flash"],
    "only the model's name is kept as written; a model past its window isn't listed",
  );
  assert.ok(page.includes("New models open to Insiders first"));
  assert.ok(page.includes("Early"));
  assert.match(html, /class="early-tag early-model"/);
  for (const text of page)
    assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
});
