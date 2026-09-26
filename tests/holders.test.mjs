import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { createMediaStore } from "../server/media.js";
import { config, database, hash, now } from "../server/core.js";
import {
  UPDATES,
  earlyOpen,
  earlyUpdates,
  earlyAccessMin,
  releaseGuard,
} from "../server/releases.js";
import {
  earlyAccessHolder,
  earlyAccessFor,
  requestHolder,
  currentTier,
  tierFor,
  recordCheck,
  settleCycle,
  settleHolderCycles,
  retentionCaps,
  capsFor,
  voteCandidates,
  rewardsSummary,
  holdingsFor,
  EARLY_ACCESS_MAX_AGE,
  CYCLE_MS,
} from "../server/holders.js";
import {
  parseHolderRewards,
  parseHolderLoyalty,
  rewardsOn,
  BASE_CAPS,
  HOLDER_CAPS,
} from "../server/holder-tiers.js";
import { authenticateAccessToken, ACCESS_PREFIX } from "../server/oauth.js";
import { knownPage, sitemap } from "../src/site-routes.js";
import { isReleased } from "../src/lib.js";
import { withEarlyAccess, isEarlyAccess, earlyUpdates as clientEarly } from "../src/holders.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// `early` is the owner's per-feature switch; tests set it on one update at a
// time and put it back.
function markEarly(t, id, value = true) {
  const u = UPDATES.find((x) => x.id === id);
  const had = Object.prototype.hasOwnProperty.call(u, "early"),
    was = u.early;
  u.early = value;
  t.after(() => (had ? (u.early = was) : delete u.early));
}
const ALL = UPDATES.map((u) => u.id);
// Every update released except `ids`: "mvp,code,search,...".
const allBut = (...ids) =>
  ["mvp", ...ALL.filter((id) => !ids.includes(id))].join(",");
const TITLE = "NYMA Holder Program";

const NYMA_CONTRACT = "0x968be0c1a394bf1ce239e3b40909ec0f9d4f5583";
const HOLDING = { rpc: "http://127.0.0.1:1", token: NYMA_CONTRACT };
const wallet = () => "0x" + randomBytes(20).toString("hex");
const HOUR = 3600000,
  DAY = 24 * HOUR,
  CREDIT = 10_000; // ledger subcredits per credit

// A read-only JSON-RPC stand-in for the token's chain. By default it reports
// the wrong chain, so any background refresh fails and seeded holdings stay
// exactly as a test wrote them.
async function rpcServer(t, { chainId = 1, balance = 0n } = {}) {
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const answer = (call) => {
      if (call.method === "eth_chainId")
        return { jsonrpc: "2.0", id: call.id, result: "0x" + chainId.toString(16) };
      const value = call.params[0].data.startsWith("0x70a08231") ? balance : 18n;
      return {
        jsonrpc: "2.0",
        id: call.id,
        result: "0x" + value.toString(16).padStart(64, "0"),
      };
    };
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(Array.isArray(body) ? body.map(answer) : answer(body)));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t, released, extra = {}) {
  const dir = extra.dir ?? mkdtempSync(join(tmpdir(), "anonyma-holders-"));
  const rpc = extra.rpc ?? (await rpcServer(t));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
    released: released ?? "all",
    token: NYMA_CONTRACT,
    chain: 4663,
    ...extra,
    rpc,
  });
  svc.dir = dir;
  t.after(() => {
    svc.close();
    if (!extra.dir) rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function signUp(svc) {
  const agent = request.agent(svc.app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: "u" + randomBytes(5).toString("hex"), password: "test-password-long" })
    .expect(201);
  return { agent, id: r.body.user.id, username: r.body.user.username };
}
// Holdings as the worker records them: wallet, balance, last good read, and
// the open cycle with its lowest balance (none below the Holder minimum).
function hold(svc, id, balance, checked = now(), address = wallet(), cycle = checked) {
  const open = balance >= 1_000_000;
  svc.db
    .prepare(
      "UPDATE users SET wallet=?,token_balance=?,token_checked=?,holder_cycle=?,holder_low=? WHERE id=?",
    )
    .run(address, String(balance), checked, open ? cycle : null, open ? String(balance) : null, id);
}
async function holder(svc) {
  const u = await signUp(svc);
  hold(svc, u.id, 6_000_000);
  return u;
}
// Holder tier (the library perk) but short of early access at Insider.
async function nonHolder(svc) {
  const u = await signUp(svc);
  hold(svc, u.id, 4_999_999);
  return u;
}
function apiKey(svc, userId) {
  const secret = "anonyma_" + randomBytes(24).toString("hex");
  svc.db
    .prepare("INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created) VALUES(?,?,?,?,?,?,?)")
    .run("key_" + randomBytes(6).toString("hex"), userId, hash(secret), "test", secret.slice(0, 12), null, now());
  return "Bearer " + secret;
}
// A live Connect an App connection and access token for `userId`, written
// the way server/oauth.js stores them.
function oauthToken(svc, userId) {
  const t = now(),
    n = randomBytes(6).toString("hex"),
    token = ACCESS_PREFIX + randomBytes(24).toString("hex");
  const db = svc.db;
  db.prepare("INSERT INTO oauth_clients(id,name,redirect_uris,created,authorized) VALUES(?,?,?,?,?)").run(
    "client_" + n, "Test App", '["http://127.0.0.1:33418/callback"]', t, t,
  );
  db.prepare(
    "INSERT INTO api_keys(id,user_id,hash,name,prefix,cap,created,allowance_total,connection_id) VALUES(?,?,NULL,?,NULL,NULL,?,?,?)",
  ).run("key_" + n, userId, "Test App", t, 20_000_000, "conn_" + n);
  db.prepare(
    "INSERT INTO oauth_connections(id,user_id,client_id,key_id,name,client_name,redirect_uri,private_only,created,activated,expires,revoked) VALUES(?,?,?,?,?,?,?,1,?,?,?,NULL)",
  ).run("conn_" + n, userId, "client_" + n, "key_" + n, "Test App", "Test App", "http://127.0.0.1:33418/callback", t, t, t + 86400000);
  db.prepare("INSERT INTO oauth_tokens(hash,connection_id,kind,created,expires,rotated) VALUES(?,?,?,?,?,NULL)").run(
    hash(token), "conn_" + n, "access", t, t + 3600000,
  );
  return token;
}
const refused = async (res, title) => {
  const r = await res.expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(r.body.error.message, `${title} is coming soon.`);
};
const initialize = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } };

// ---- The program on a bare database, with the clock passed in ----

function programDb(t, overrides = {}, path = ":memory:") {
  const db = database(path);
  const cfg = config({ released: "all", ...HOLDING, ...overrides });
  t.after(() => db.isOpen && db.close());
  return { db, cfg };
}
function addUser(db, address = wallet()) {
  const id = "u_" + randomBytes(5).toString("hex");
  db.prepare("INSERT INTO users(id,wallet,created) VALUES(?,?,?)").run(id, address, 0);
  return id;
}
const row = (db, id) => db.prepare("SELECT * FROM users WHERE id=?").get(id);
const check = (db, cfg, id, balance, t, scheduled = false) =>
  recordCheck(db, cfg, row(db, id), balance, { t, scheduled });
const paid = (db, id) =>
  db
    .prepare("SELECT amount FROM ledger WHERE user_id=? AND kind='holder_reward' ORDER BY created,rowid")
    .all(id)
    .map((r) => r.amount / CREDIT);
const T0 = Date.UTC(2026, 0, 5, 9);

test("the NYMA Holder Program is registered, unreleased by default, and never early", () => {
  const entry = UPDATES.find((u) => u.id === "holders");
  assert.ok(entry, "holders is registered in UPDATES");
  // Its release commit flips this; the gates below hold either way.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, TITLE);
  assert.equal(entry.points.length, 3);
  assert.equal(entry.early, undefined);
  assert.equal(earlyAccessMin(config({})), 5_000_000);
});

test("HOLDER_REWARDS and HOLDER_LOYALTY: defaults, overrides, zeros and bad values", (t) => {
  const tiers = parseHolderRewards();
  assert.deepEqual(
    tiers.map(({ id, name, perk, min, credits, units }) => [id, name, perk, min, credits, units]),
    [
      ["holder", "Holder", "library", 1_000_000, 2000, 2000 * CREDIT],
      ["insider", "Insider", "early", 5_000_000, 15000, 15000 * CREDIT],
      ["inner", "Inner Circle", "vote", 25_000_000, 100000, 100000 * CREDIT],
    ],
  );
  assert.deepEqual(parseHolderLoyalty(), { after: 3, multiplier: 1.5 });
  assert.deepEqual(parseHolderRewards(" 10 : 1.5 , 20:0 ,30:3").map((x) => x.units), [15000, 0, 30000]);
  assert.equal(rewardsOn(parseHolderRewards("1:0,2:0,3:0")), false);
  assert.equal(rewardsOn(parseHolderRewards("1:0,2:1,3:0")), true);
  for (const bad of ["1:1,2:2", "1:1,2:2,3:3,4:4", "2:1,1:1,3:1", "0:1,2:1,3:1", "1:-1,2:1,3:1", "1:x,2:1,3:1", "1:0.00001,2:1,3:1"])
    assert.throws(() => parseHolderRewards(bad), /HOLDER_REWARDS/, bad);
  for (const bad of ["0:1.5", "3:0.5", "3:11", "3", "x:1.5", "1.5:2"])
    assert.throws(() => parseHolderLoyalty(bad), /HOLDER_LOYALTY/, bad);
  // From the environment; early access follows the Insider minimum.
  const saved = { r: process.env.HOLDER_REWARDS, l: process.env.HOLDER_LOYALTY };
  t.after(() => {
    for (const [k, v] of [["HOLDER_REWARDS", saved.r], ["HOLDER_LOYALTY", saved.l]])
      v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  process.env.HOLDER_REWARDS = "100:1,200:2,300:3";
  process.env.HOLDER_LOYALTY = "2:2";
  const cfg = config({});
  assert.equal(earlyAccessMin(cfg), 200);
  assert.deepEqual(cfg.holderLoyalty, { after: 2, multiplier: 2 });
  process.env.HOLDER_REWARDS = "lots";
  assert.throws(() => config({}), /HOLDER_REWARDS/);
});

test("the tier is set by the LOWEST balance a cycle's successful checks saw", (t) => {
  const { db, cfg } = programDb(t);
  assert.equal(tierFor(cfg, 999_999.99), null);
  assert.equal(tierFor(cfg, 1_000_000).id, "holder");
  assert.equal(tierFor(cfg, 4_999_999).id, "holder");
  assert.equal(tierFor(cfg, 5_000_000).id, "insider");
  assert.equal(tierFor(cfg, 25_000_000).level, 3);
  assert.equal(tierFor(cfg, "not a number"), null);
  const id = addUser(db);
  check(db, cfg, id, 30_000_000, T0);
  assert.equal(currentTier(cfg, row(db, id), T0).id, "inner");
  check(db, cfg, id, 6_000_000, T0 + 5 * DAY);
  // Buying back in doesn't raise the tier during the cycle.
  check(db, cfg, id, 26_000_000, T0 + 10 * DAY);
  check(db, cfg, id, 90_000_000, T0 + 29 * DAY);
  assert.equal(row(db, id).holder_low, "6000000");
  assert.equal(currentTier(cfg, row(db, id), T0 + 29 * DAY).id, "insider");
  // A stale read (over 48 hours) means no tier at all until the next one.
  assert.equal(currentTier(cfg, row(db, id), T0 + 29 * DAY + EARLY_ACCESS_MAX_AGE + 1), null);
  // Paid by the cycle's lowest balance: Insider credits, not Inner Circle.
  const [result] = settleHolderCycles(db, cfg, T0 + 30 * DAY);
  assert.equal(result.tier, "insider");
  assert.deepEqual(paid(db, id), [15000]);
  // The next cycle starts from the latest read.
  assert.equal(currentTier(cfg, row(db, id), T0 + 30 * DAY).id, "inner");
});

test("a cycle pays once after 30 days, restarts at the payout, and resets below 1,000,000 NYMA", (t) => {
  const { db, cfg } = programDb(t);
  const id = addUser(db);
  // Below the Holder minimum, no cycle opens.
  check(db, cfg, id, 999_999, T0 - DAY);
  assert.equal(row(db, id).holder_cycle, null);
  check(db, cfg, id, 2_000_000, T0);
  assert.equal(row(db, id).holder_cycle, T0);
  check(db, cfg, id, 2_000_000, T0 + 29 * DAY);
  assert.deepEqual(settleHolderCycles(db, cfg, T0 + 30 * DAY - 1), [], "not before 30 days");
  settleHolderCycles(db, cfg, T0 + 30 * DAY + 5000);
  assert.deepEqual(paid(db, id), [2000]);
  const ledger = db.prepare("SELECT * FROM ledger WHERE user_id=?").get(id);
  assert.equal(ledger.kind, "holder_reward");
  assert.equal(ledger.amount, 2000 * CREDIT);
  assert.equal(ledger.description, "NYMA holder reward: Holder");
  assert.equal(row(db, id).holder_cycle, T0 + 30 * DAY + 5000);
  assert.equal(row(db, id).holder_paid, 1);
  // One check below 1,000,000 ends the cycle unpaid and the paid run.
  const c2 = T0 + 30 * DAY + 5000;
  check(db, cfg, id, 2_500_000, c2 + 3 * DAY);
  check(db, cfg, id, 999_999.5, c2 + 4 * DAY);
  assert.equal(row(db, id).holder_cycle, null);
  assert.equal(row(db, id).holder_paid, 0);
  check(db, cfg, id, 2_000_000, c2 + 31 * DAY);
  assert.deepEqual(settleHolderCycles(db, cfg, c2 + 31 * DAY), [], "the reset cycle pays nothing");
  assert.deepEqual(paid(db, id), [2000]);
  // The new cycle starts at the next check at or above the minimum.
  assert.equal(row(db, id).holder_cycle, c2 + 31 * DAY);
});

test("a failed read neither resets nor counts: a due cycle waits for a successful one", async (t) => {
  const { db, cfg } = programDb(t);
  const id = addUser(db);
  check(db, cfg, id, 3_000_000, T0);
  check(db, cfg, id, 3_000_000, T0 + 27 * DAY);
  // No successful read since day 27 (reads failing): due but not paid, and
  // the cycle is intact.
  assert.deepEqual(settleHolderCycles(db, cfg, T0 + 30 * DAY), []);
  assert.equal(row(db, id).holder_cycle, T0);
  const waiting = holdingsFor(db, cfg, row(db, id), T0 + 30 * DAY);
  assert.equal(waiting.cycle.daysLeft, 0);
  assert.equal(waiting.cycle.waiting, true);
  assert.equal(waiting.tier, null, "no tier without a read in 48 hours");
  assert.equal(earlyAccessHolder(cfg, row(db, id), T0 + 30 * DAY), false);
  // The next successful read counts toward this cycle, then it pays.
  check(db, cfg, id, 3_000_000, T0 + 33 * DAY);
  settleHolderCycles(db, cfg, T0 + 33 * DAY);
  assert.deepEqual(paid(db, id), [2000]);

  // Through the worker: a read that fails (wrong chain) leaves the cycle,
  // its lowest balance and the last good read exactly as they were.
  const svc = await fixture(t, "all");
  const u = await signUp(svc);
  hold(svc, u.id, 30_000_000, now() - 47 * HOUR, wallet(), now() - 10 * DAY);
  const beforeTick = svc.db.prepare("SELECT holder_cycle,holder_low,holder_paid,token_checked FROM users WHERE id=?").get(u.id);
  await svc.tick();
  const afterTick = svc.db.prepare("SELECT holder_cycle,holder_low,holder_paid,token_checked,token_retry FROM users WHERE id=?").get(u.id);
  assert.ok(afterTick.token_retry, "the read was attempted and failed");
  delete afterTick.token_retry;
  assert.deepEqual(afterTick, beforeTick);
});

test("the Loyal bonus: x1.5 from the fourth paid cycle in a row, until a cycle ends unpaid", (t) => {
  const { db, cfg } = programDb(t);
  const id = addUser(db);
  check(db, cfg, id, 5_000_000, T0);
  let start = T0;
  const cycle = () => {
    check(db, cfg, id, 5_000_000, start + 29 * DAY);
    settleHolderCycles(db, cfg, start + 30 * DAY);
    start += 30 * DAY;
  };
  for (let i = 0; i < 5; i++) cycle();
  assert.deepEqual(paid(db, id), [15000, 15000, 15000, 22500, 22500]);
  assert.equal(row(db, id).holder_paid, 5);
  assert.deepEqual(
    db.prepare("SELECT bonus FROM holder_rewards WHERE user_id=? ORDER BY paid").all(id).map((r) => r.bonus),
    [0, 0, 0, 1, 1],
  );
  assert.equal(
    db.prepare("SELECT description FROM ledger WHERE user_id=? ORDER BY created DESC LIMIT 1").get(id).description,
    "NYMA holder reward: Insider, Loyal bonus",
  );
  // The account sees the bonus on the credits due.
  assert.deepEqual(holdingsFor(db, cfg, row(db, id), start + DAY).cycle.due, { credits: 22500, bonus: true });
  // One unpaid cycle and it starts over.
  check(db, cfg, id, 10, start + 2 * DAY);
  check(db, cfg, id, 5_000_000, start + 3 * DAY);
  start += 3 * DAY;
  for (let i = 0; i < 4; i++) cycle();
  assert.deepEqual(paid(db, id).slice(5), [15000, 15000, 15000, 22500]);
  // A custom bonus, and none at all.
  const other = programDb(t, { holderLoyalty: "1:2" });
  const u = addUser(other.db);
  check(other.db, other.cfg, u, 1_000_000, T0);
  for (const day of [29, 59]) {
    check(other.db, other.cfg, u, 1_000_000, T0 + day * DAY);
    settleHolderCycles(other.db, other.cfg, T0 + (day + 1) * DAY);
  }
  assert.deepEqual(paid(other.db, u), [2000, 4000]);
});

test("a rerun, a restart or a failure mid-payout never pays twice", async (t) => {
  const { db, cfg } = programDb(t);
  const id = addUser(db);
  check(db, cfg, id, 25_000_000, T0);
  check(db, cfg, id, 25_000_000, T0 + 29 * DAY);
  const due = T0 + 30 * DAY;
  // A failure inside the transaction, after the reward row and the ledger
  // credit are written: all of it rolls back.
  t.mock.method(console, "error", () => {});
  db.exec(
    "CREATE TEMP TRIGGER fail_payout BEFORE UPDATE OF holder_cycle ON users WHEN OLD.holder_cycle IS NOT NULL AND NEW.holder_cycle IS NOT NULL BEGIN SELECT RAISE(ABORT,'simulated failure'); END;",
  );
  assert.deepEqual(settleHolderCycles(db, cfg, due), []);
  assert.deepEqual(paid(db, id), []);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM holder_rewards").get().n, 0);
  assert.equal(row(db, id).holder_cycle, T0);
  db.exec("DROP TRIGGER fail_payout");
  // The rerun pays, once; rerunning again at once or later pays nothing.
  assert.equal(settleHolderCycles(db, cfg, due + 1000).length, 1);
  assert.equal(settleHolderCycles(db, cfg, due + 1000).length, 0);
  assert.equal(settleHolderCycles(db, cfg, due + 20 * DAY).length, 0);
  assert.equal(settleCycle(db, cfg, id, due + 1000), null);
  assert.deepEqual(paid(db, id), [100000]);
  // Even a stale cycle start written back can't pay the same cycle again:
  // the reward's primary key (account, cycle start) refuses it.
  db.prepare("UPDATE users SET holder_cycle=?,token_checked=? WHERE id=?").run(T0, due + 2000, id);
  assert.deepEqual(settleHolderCycles(db, cfg, due + 3000), []);
  assert.deepEqual(paid(db, id), [100000]);
  assert.equal(console.error.mock.callCount(), 2);
});

test("a process killed mid-payout leaves nothing, and the rerun pays exactly once", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-holders-crash-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "crash.sqlite");
  const setup = programDb(t, {}, path);
  const ids = [addUser(setup.db), addUser(setup.db)];
  for (const id of ids) {
    check(setup.db, setup.cfg, id, 7_000_000, T0);
    check(setup.db, setup.cfg, id, 7_000_000, T0 + 29 * DAY);
  }
  setup.db.close();
  const due = T0 + 30 * DAY;
  // A separate process pays the first due cycle and is SIGKILLed inside the
  // transaction, right after the ledger credit is written.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
      import { database, config } from ${JSON.stringify(new URL("../server/core.js", import.meta.url).href)};
      import { settleHolderCycles } from ${JSON.stringify(new URL("../server/holders.js", import.meta.url).href)};
      const db = database(${JSON.stringify(path)});
      db.function("crash", () => process.kill(process.pid, "SIGKILL"));
      db.exec("CREATE TEMP TRIGGER crash_mid_payout AFTER INSERT ON ledger WHEN NEW.kind='holder_reward' BEGIN SELECT crash(); END;");
      settleHolderCycles(db, config({ released: "all", rpc: "http://127.0.0.1:1", token: "${NYMA_CONTRACT}" }), ${due});
      console.log("survived");
      `,
    ],
    { encoding: "utf8" },
  );
  assert.equal(child.signal, "SIGKILL", child.stderr);
  assert.doesNotMatch(child.stdout, /survived/);
  const { db, cfg } = programDb(t, {}, path);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM holder_rewards").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 0);
  for (const id of ids) assert.equal(row(db, id).holder_cycle, T0);
  // Restart: the worker's pass pays each cycle once, and never again.
  assert.equal(settleHolderCycles(db, cfg, due + 60000).length, 2);
  assert.equal(settleHolderCycles(db, cfg, due + 120000).length, 0);
  for (const id of ids) assert.deepEqual(paid(db, id), [15000]);
});

test("the worker pays due cycles on its runs, once, across a restart", async (t) => {
  const svc = await fixture(t, "all");
  const u = await signUp(svc);
  hold(svc, u.id, 6_000_000, now() - HOUR, wallet(), now() - 31 * DAY);
  await svc.tick();
  await svc.tick();
  assert.deepEqual(paid(svc.db, u.id), [15000]);
  // The same database under a new process.
  const again = await fixture(t, "all", { dir: svc.dir, rpc: svc.cfg.rpc });
  await again.tick();
  assert.deepEqual(paid(again.db, u.id), [15000]);
  // The account sees it in its ledger and holdings.
  const ledger = (await u.agent.get("/api/account/ledger").expect(200)).body.data;
  assert.equal(ledger[0].kind, "holder_reward");
  const holdings = (await u.agent.get("/api/account/holdings").expect(200)).body;
  assert.deepEqual(
    { credits: holdings.lastReward.credits, tier: holdings.lastReward.tier, bonus: holdings.lastReward.bonus },
    { credits: 15000, tier: "insider", bonus: false },
  );
  assert.equal(holdings.paidInARow, 1);
  assert.equal(holdings.cycle.daysLeft, 30);
});

test("an amount of 0 turns that tier's credits off, and all zeros turn them all off", (t) => {
  const { db, cfg } = programDb(t, { holderRewards: "1000000:0,5000000:15000,25000000:100000" });
  const small = addUser(db),
    big = addUser(db);
  for (const [id, balance] of [[small, 2_000_000], [big, 6_000_000]]) {
    check(db, cfg, id, balance, T0);
    check(db, cfg, id, balance, T0 + 29 * DAY);
  }
  settleHolderCycles(db, cfg, T0 + 30 * DAY);
  assert.deepEqual(paid(db, small), []);
  assert.deepEqual(paid(db, big), [15000]);
  // The unpaid tier's cycle still rolls over, and its paid run stays put.
  assert.equal(row(db, small).holder_cycle, T0 + 30 * DAY);
  assert.equal(row(db, small).holder_paid, 0);
  assert.equal(holdingsFor(db, cfg, row(db, small), T0 + 31 * DAY).cycle.due.credits, 0);

  const off = programDb(t, { holderRewards: "1000000:0,5000000:0,25000000:0" });
  const ids = [1_000_000, 5_000_000, 30_000_000].map((balance) => {
    const id = addUser(off.db);
    check(off.db, off.cfg, id, balance, T0);
    check(off.db, off.cfg, id, balance, T0 + 29 * DAY);
    return id;
  });
  settleHolderCycles(off.db, off.cfg, T0 + 30 * DAY);
  assert.equal(off.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 0);
  assert.equal(off.db.prepare("SELECT COUNT(*) n FROM holder_rewards").get().n, 0);
  // The perks still follow the tier.
  assert.equal(currentTier(off.cfg, row(off.db, ids[2]), T0 + 30 * DAY).id, "inner");
});

test("a closed account and an unlinked wallet get nothing", async (t) => {
  const svc = await fixture(t, "all");
  const due = (u) => hold(svc, u.id, 6_000_000, now() - HOUR, wallet(), now() - 31 * DAY);
  const [gone, unlinked, kept] = [await signUp(svc), await signUp(svc), await signUp(svc)];
  [gone, unlinked, kept].forEach(due);
  await gone.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  await unlinked.agent.post("/api/account/wallet/unlink").send({}).expect(200);
  for (const u of [gone, unlinked]) {
    const r = row(svc.db, u.id);
    assert.equal(r.wallet, null);
    assert.deepEqual([r.holder_cycle, r.holder_low, r.holder_paid, r.token_checked], [null, null, 0, null]);
  }
  // Even with a cycle forced back on, the payout re-checks both.
  svc.db.prepare("UPDATE users SET holder_cycle=?,holder_low='6000000',token_checked=? WHERE id IN (?,?)").run(now() - 31 * DAY, now() - HOUR, gone.id, unlinked.id);
  settleHolderCycles(svc.db, svc.cfg);
  assert.deepEqual(paid(svc.db, gone.id), []);
  assert.deepEqual(paid(svc.db, unlinked.id), []);
  assert.deepEqual(paid(svc.db, kept.id), [15000]);
});

test("worker reads come 12 to 36 hours apart at random; an account's own refresh never moves them", (t) => {
  const { db, cfg } = programDb(t);
  const id = addUser(db);
  const gaps = new Set();
  for (let i = 0; i < 20; i++) {
    const t0 = T0 + i * 2 * DAY;
    check(db, cfg, id, 2_000_000, t0, true);
    const gap = row(db, id).token_due - t0;
    assert.ok(gap >= 12 * HOUR && gap < 36 * HOUR, String(gap));
    gaps.add(gap);
    check(db, cfg, id, 2_000_000, t0 + HOUR);
    assert.equal(row(db, id).token_due, t0 + gap, "a refresh leaves the schedule alone");
  }
  assert.ok(gaps.size > 15, "the times differ");
});

test("the Holder tier's bigger library: twice the caps, and nothing deleted at once on the way down", async (t) => {
  const svc = await fixture(t, "all");
  const h = await signUp(svc),
    n = await signUp(svc);
  hold(svc, h.id, 1_000_000);
  hold(svc, n.id, 999_999);
  assert.deepEqual(capsFor(svc.db, svc.cfg, h.id), HOLDER_CAPS);
  assert.deepEqual(capsFor(svc.db, svc.cfg, n.id), BASE_CAPS);
  assert.deepEqual(HOLDER_CAPS, { conversations: 600, symposium: 300, image: 200, video: 120, audio: 120 });
  assert.deepEqual((await h.agent.get("/api/me")).body.user.caps, HOLDER_CAPS);
  const seed = (id, count, mode = "chat") => {
    const insert = svc.db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)");
    for (let i = 0; i < count; i++) insert.run(`c_${id}_${mode}_${i}`, id, "Seeded", mode, i, i);
  };
  const count = (id, mode = "chat") =>
    svc.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=? AND (mode IS 'symposium')=?").get(id, mode === "symposium" ? 1 : 0).n;
  seed(h.id, 650);
  seed(n.id, 310);
  seed(h.id, 320, "symposium");
  await h.agent.post("/api/conversations").send({}).expect(201);
  await n.agent.post("/api/conversations").send({}).expect(201);
  await h.agent.post("/api/conversations").send({ mode: "symposium" }).expect(201);
  assert.equal(count(h.id), 600);
  assert.equal(count(n.id), 300);
  assert.equal(count(h.id, "symposium"), 300);
  assert.equal((await h.agent.get("/api/conversations").expect(200)).body.data.length, 600);
  // Media, per type.
  const store = createMediaStore(svc.db, svc.cfg);
  const png = readFileSync(new URL("../data/test-image.png", import.meta.url));
  const media = (id, kind, many) => {
    const insert = svc.db.prepare("INSERT INTO media(id,user_id,kind,mime,filename,prompt,model,cost,created,expires) VALUES(?,?,?,?,?,?,?,?,?,NULL)");
    for (let i = 0; i < many; i++) insert.run(`m_${id}_${kind}_${i}`, id, kind, "x/y", `missing-${id}-${kind}-${i}`, "", "", 0, i);
  };
  const library = (id, kind) => svc.db.prepare("SELECT COUNT(*) n FROM media WHERE user_id=? AND kind=?").get(id, kind).n;
  media(h.id, "image", 205);
  media(h.id, "video", 125);
  media(h.id, "audio", 125);
  await store.saveMedia(h.id, "image", png, { mime: "image/png" });
  await store.saveMedia(h.id, "video", Buffer.from("fixture"), { mime: "video/mp4" });
  await store.saveMedia(h.id, "audio", Buffer.from("fixture"), { mime: "audio/mpeg" });
  assert.deepEqual(["image", "video", "audio"].map((k) => library(h.id, k)), [200, 120, 120]);
  // A check sees less than 1,000,000 NYMA: nothing goes at once...
  recordCheck(svc.db, svc.cfg, row(svc.db, h.id), 10, {});
  assert.deepEqual(capsFor(svc.db, svc.cfg, h.id), BASE_CAPS);
  assert.equal(count(h.id), 600);
  assert.equal(library(h.id, "image"), 200);
  // ...and the standard caps apply as new items are saved.
  await h.agent.post("/api/conversations").send({}).expect(201);
  await store.saveMedia(h.id, "image", png, { mime: "image/png" });
  assert.equal(count(h.id), 300);
  assert.equal(library(h.id, "image"), 100);
  assert.equal(library(h.id, "video"), 120, "other types wait for their own next save");
});

test("the Inner Circle's roadmap vote: one per account per month, counts only in public", async (t) => {
  markEarly(t, "collab");
  const svc = await fixture(t, allBut("scrolls", "symposium", "collab"));
  // Early updates and the program itself aren't on the ballot.
  assert.deepEqual(voteCandidates(svc.cfg).map((c) => c.id), ["symposium", "scrolls"]);
  const a = await signUp(svc),
    b = await signUp(svc),
    insider = await signUp(svc);
  hold(svc, a.id, 25_000_000);
  hold(svc, b.id, 40_000_000);
  hold(svc, insider.id, 24_999_999);
  const vote = (u, update) => u.agent.put("/api/holders/vote").send({ update });
  const r = await vote(insider, "scrolls").expect(403);
  assert.equal(r.body.error.code, "inner_circle_only");
  await request(svc.app).put("/api/holders/vote").send({ update: "scrolls" }).expect(401);
  for (const bad of ["holders", "code", "collab", "nope", ""])
    assert.equal((await vote(a, bad).expect(400)).body.error.code, "invalid_vote", bad);
  assert.equal((await vote(a, "scrolls").expect(200)).body.choice, "scrolls");
  // Voting again changes the vote; it never adds one.
  assert.equal((await vote(a, "symposium").expect(200)).body.choice, "symposium");
  await vote(a, "symposium").expect(200);
  await vote(b, "scrolls").expect(200);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM roadmap_votes WHERE user_id=?").get(a.id).n, 1);
  const tally = async () =>
    Object.fromEntries((await request(svc.app).get("/api/holders/summary").expect(200)).body.vote.candidates.map((c) => [c.id, c.votes]));
  assert.deepEqual(await tally(), { symposium: 1, scrolls: 1 });
  // A vote counts while its account is Inner Circle.
  svc.db.prepare("UPDATE users SET holder_low='6000000' WHERE id=?").run(b.id);
  assert.deepEqual(await tally(), { symposium: 1, scrolls: 0 });
  const ballot = (await a.agent.get("/api/account/holdings").expect(200)).body.vote;
  assert.equal(ballot.open, true);
  assert.equal(ballot.choice, "symposium");
  assert.equal((await insider.agent.get("/api/account/holdings")).body.vote.open, false);
  // Counts only: nothing that names or identifies a voter.
  const text = (await request(svc.app).get("/api/holders/summary")).text;
  for (const u of [a, b]) {
    assert.ok(!text.includes(u.id) && !text.includes(u.username));
    assert.ok(!text.includes(row(svc.db, u.id).wallet));
  }
  // Closing the account removes its vote.
  await a.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM roadmap_votes WHERE user_id=?").get(a.id).n, 0);
});

test("public transparency: 30 days of totals, as of the start of today (UTC)", (t) => {
  const { db, cfg } = programDb(t);
  const ids = [addUser(db), addUser(db), addUser(db)];
  const start = Date.UTC(2026, 4, 1);
  ids.forEach((id, i) => check(db, cfg, id, [2_000_000, 6_000_000, 30_000_000][i], start));
  for (const id of ids) check(db, cfg, id, Number(row(db, id).holder_low), start + 29 * DAY);
  settleHolderCycles(db, cfg, start + 30 * DAY + HOUR);
  // Paid today: not counted until tomorrow.
  const today = start + 30 * DAY + 5 * HOUR;
  assert.deepEqual(rewardsSummary(db, today), { since: start, until: start + 30 * DAY, credits: 0, holders: 0 });
  assert.deepEqual(
    rewardsSummary(db, today + DAY),
    { since: start + DAY, until: start + 31 * DAY, credits: 117000, holders: 3 },
  );
  assert.deepEqual(Object.keys(rewardsSummary(db, today + DAY)).sort(), ["credits", "holders", "since", "until"]);
  assert.equal(rewardsSummary(db, today + 32 * DAY).holders, 0, "gone after 30 days");
});

test("the whole program is gated behind holders", async (t) => {
  const svc = await fixture(t, allBut("holders"));
  const u = await signUp(svc);
  hold(svc, u.id, 30_000_000, now() - HOUR, wallet(), now() - 31 * DAY);
  await refused(u.agent.get("/api/account/holdings"), TITLE);
  await refused(request(svc.app).get("/api/holders/summary"), TITLE);
  await refused(u.agent.put("/api/holders/vote").send({ update: "scrolls" }), TITLE);
  await refused(u.agent.post("/api/account/wallet/unlink").send({}), TITLE);
  const cfg = (await request(svc.app).get("/api/config").expect(200)).body;
  assert.equal(cfg.releases.holderProgram, null);
  const me = (await u.agent.get("/api/me").expect(200)).body.user;
  assert.equal(me.holder.tier, null);
  assert.deepEqual(me.caps, BASE_CAPS);
  // No payout, no tier, no perks, and reads don't open cycles.
  await svc.tick();
  assert.deepEqual(settleHolderCycles(svc.db, svc.cfg), []);
  assert.deepEqual(paid(svc.db, u.id), []);
  assert.equal(currentTier(svc.cfg, row(svc.db, u.id)), null);
  assert.deepEqual(retentionCaps(svc.cfg, row(svc.db, u.id)), BASE_CAPS);
  const fresh = await signUp(svc);
  svc.db.prepare("UPDATE users SET wallet=? WHERE id=?").run(wallet(), fresh.id);
  recordCheck(svc.db, svc.cfg, row(svc.db, fresh.id), 30_000_000, {});
  assert.equal(row(svc.db, fresh.id).holder_cycle, null);
  assert.equal(row(svc.db, fresh.id).token_balance, "30000000", "the balance itself is still recorded");
  await request(svc.app).get("/token").expect(404);
});

test("the holder rule for early access: Insider tier or above, a linked wallet and a recent read", () => {
  const cfg = config({ released: "all", ...HOLDING });
  const t = now();
  const user = { wallet: wallet(), token_balance: "5000000", token_checked: t - 1000, holder_cycle: t - DAY, holder_low: "5000000", deleted: null };
  assert.equal(earlyAccessHolder(cfg, user, t), true);
  // The cycle's lowest balance decides, not the latest one.
  assert.equal(earlyAccessHolder(cfg, { ...user, holder_low: "4999999.999", token_balance: "9000000" }, t), false);
  assert.equal(earlyAccessHolder(cfg, { ...user, holder_low: "not a number" }, t), false);
  assert.equal(earlyAccessHolder(cfg, { ...user, holder_cycle: null }, t), false);
  assert.equal(earlyAccessHolder(config({ released: "all", ...HOLDING, holderRewards: "10:0,100:0,1000:0" }), { ...user, holder_low: "100" }, t), true);
  // Stale or never read.
  assert.equal(earlyAccessHolder(cfg, { ...user, token_checked: t - EARLY_ACCESS_MAX_AGE + 60000 }, t), true);
  assert.equal(earlyAccessHolder(cfg, { ...user, token_checked: t - EARLY_ACCESS_MAX_AGE - 1 }, t), false);
  assert.equal(earlyAccessHolder(cfg, { ...user, token_checked: null }, t), false);
  // Unlinked wallet, closed account.
  assert.equal(earlyAccessHolder(cfg, { ...user, wallet: null }, t), false);
  assert.equal(earlyAccessHolder(cfg, { ...user, deleted: t }, t), false);
  assert.equal(earlyAccessHolder(cfg, null, t), false);
  // Token config unset: nobody is a holder.
  assert.equal(earlyAccessHolder({ ...cfg, rpc: "" }, user, t), false);
  assert.equal(earlyAccessHolder({ ...cfg, token: "" }, user, t), false);
  // The program itself unreleased.
  assert.equal(earlyAccessHolder(config({ released: allBut("holders"), ...HOLDING }), user, t), false);
});

test("an update is early only while marked, unreleased and the program is live", (t) => {
  markEarly(t, "scrolls");
  const cfg = (released) => config({ released });
  assert.equal(earlyOpen(cfg(allBut("scrolls")), "scrolls"), true);
  assert.deepEqual(earlyUpdates(cfg(allBut("scrolls"))), ["scrolls"]);
  // The program itself not live: nothing opens early.
  assert.equal(earlyOpen(cfg(allBut("scrolls", "holders")), "scrolls"), false);
  // Released to everyone: no longer early.
  assert.equal(earlyOpen(cfg("all"), "scrolls"), false);
  // Not marked.
  assert.equal(earlyOpen(cfg(allBut("scrolls", "symposium")), "symposium"), false);
});

test("Connect an App can never be early: an outside app drives it", async (t) => {
  markEarly(t, "connect");
  assert.equal(earlyOpen(config({ released: allBut("connect") }), "connect"), false);
  const svc = await fixture(t, allBut("connect"));
  const h = await holder(svc);
  await refused(h.agent.get("/api/connections"), "Connect an App");
  const cfg = (await request(svc.app).get("/api/config")).body;
  assert.equal(cfg.releases.updates.find((u) => u.id === "connect").early, false);
  assert.deepEqual((await h.agent.get("/api/me")).body.user.earlyAccess, []);
});

test("an early update opens to an Insider's session and to no one else", async (t) => {
  markEarly(t, "scrolls");
  const svc = await fixture(t, allBut("scrolls"));
  const h = await holder(svc),
    n = await nonHolder(svc);
  await h.agent.get("/api/scrolls").expect(200);
  await refused(n.agent.get("/api/scrolls"), "Scrolls");
  await refused(request(svc.app).get("/api/scrolls"), "Scrolls");
  // A balance read more than 48 hours ago no longer counts.
  const stale = await signUp(svc);
  hold(svc, stale.id, 50_000_000, now() - EARLY_ACCESS_MAX_AGE - 60000);
  await refused(stale.agent.get("/api/scrolls"), "Scrolls");
  // A holding without a linked wallet doesn't count.
  const unlinked = await signUp(svc);
  hold(svc, unlinked.id, 9_000_000);
  svc.db.prepare("UPDATE users SET wallet=NULL WHERE id=?").run(unlinked.id);
  await refused(unlinked.agent.get("/api/scrolls"), "Scrolls");
  // A forged or expired session is nobody.
  await refused(
    request(svc.app).get("/api/scrolls").set("Cookie", "anonyma_session=session_forged"),
    "Scrolls",
  );
  // A closed account's holdings don't count.
  const gone = await holder(svc);
  svc.db.prepare("UPDATE users SET deleted=? WHERE id=?").run(now(), gone.id);
  await refused(gone.agent.get("/api/scrolls"), "Scrolls");
});

test("unmarked updates, an unreleased program and unset token config all keep a holder out", async (t) => {
  // Not marked early.
  {
    const svc = await fixture(t, allBut("scrolls"));
    const h = await holder(svc);
    await refused(h.agent.get("/api/scrolls"), "Scrolls");
  }
  markEarly(t, "scrolls");
  // The program itself unreleased.
  {
    const svc = await fixture(t, allBut("scrolls", "holders"));
    const h = await holder(svc);
    await refused(h.agent.get("/api/scrolls"), "Scrolls");
    const me = (await h.agent.get("/api/me").expect(200)).body.user;
    assert.deepEqual(me.earlyAccess, []);
    assert.equal(me.holder.eligible, false);
  }
  // TOKEN_RPC_URL / TOKEN_CONTRACT unset: nobody is a holder, pages still work.
  {
    const svc = await fixture(t, allBut("scrolls"), { rpc: "", token: "" });
    const h = await holder(svc);
    await refused(h.agent.get("/api/scrolls"), "Scrolls");
    const me = (await h.agent.get("/api/me").expect(200)).body.user;
    assert.deepEqual(me.earlyAccess, []);
    assert.equal(me.holder.eligible, false);
    assert.equal(me.holder.tier, null);
    const cfg = (await request(svc.app).get("/api/config").expect(200)).body;
    assert.equal(cfg.services.token, false);
    assert.equal(cfg.releases.updates.find((u) => u.id === "scrolls").early, true);
    await request(svc.app).get("/token").expect(200);
    const holdings = (await h.agent.get("/api/account/holdings").expect(200)).body;
    assert.equal(holdings.checks, false);
    assert.equal(holdings.tier, null);
    hold(svc, h.id, 6_000_000, now() - HOUR, wallet(), now() - 31 * DAY);
    assert.deepEqual(settleHolderCycles(svc.db, svc.cfg), []);
  }
});

test("the account's own API key carries early access on /v1; its session cookie doesn't", async (t) => {
  markEarly(t, "api");
  const svc = await fixture(t, allBut("api"));
  const h = await holder(svc),
    n = await nonHolder(svc);
  // Key creation is part of the early update: the holder can, others can't.
  const created = (await h.agent.post("/api/keys").send({ name: "early" }).expect(201)).body;
  await refused(n.agent.post("/api/keys").send({ name: "early" }), "Developer API & CLI");
  const holderKey = "Bearer " + created.key,
    otherKey = apiKey(svc, n.id);
  await request(svc.app).get("/v1/models").set("Authorization", holderKey).expect(200);
  await refused(request(svc.app).get("/v1/models").set("Authorization", otherKey), "Developer API & CLI");
  await refused(request(svc.app).get("/v1/models"), "Developer API & CLI");
  // /v1 authenticates by key only, so the gate ignores cookies there: a
  // holder's session can't lend early access to another account's key.
  await refused(h.agent.get("/v1/models").set("Authorization", otherKey), "Developer API & CLI");
  await refused(h.agent.get("/v1/models"), "Developer API & CLI");
  // A revoked key is nobody.
  svc.db.prepare("UPDATE api_keys SET revoked=? WHERE hash=?").run(now(), hash(created.key));
  await refused(request(svc.app).get("/v1/models").set("Authorization", holderKey), "Developer API & CLI");
});

test("on /mcp an API key carries early access and a connected app never does", async (t) => {
  markEarly(t, "mcp");
  const svc = await fixture(t, allBut("mcp"));
  const h = await holder(svc),
    n = await nonHolder(svc);
  const mcp = (auth) =>
    request(svc.app).post("/mcp").set("Authorization", auth).send(initialize);
  const ok = await mcp(apiKey(svc, h.id)).expect(200);
  assert.equal(ok.body.result.serverInfo.name, "anonyma");
  await refused(mcp(apiKey(svc, n.id)), "MCP Server");
  // A valid OAuth access token for the holder's own account: refused
  // exactly like a non-holder, so the app can't tell.
  const token = oauthToken(svc, h.id);
  assert.ok(authenticateAccessToken(svc.db, token), "the token itself is valid");
  const app = await mcp("Bearer " + token);
  const other = await mcp("Bearer " + oauthToken(svc, n.id));
  assert.equal(app.status, 403);
  assert.deepEqual(app.body, other.body);
  assert.equal(app.body.error.code, "feature_unreleased");
  // Same answer from the resolver directly, whatever the route.
  const isHolder = requestHolder(svc.db, svc.cfg);
  for (const path of ["/mcp", "/MCP", "/v1/models"])
    assert.equal(isHolder({ path, headers: { authorization: "Bearer " + token }, cookies: {} }), false);
  assert.equal(isHolder({ path: "/mcp", headers: { authorization: apiKey(svc, h.id) }, cookies: {} }), true);
});

test("the guard asks about the holder only for early gates, once, and fails closed", async (t) => {
  markEarly(t, "scrolls");
  const cfg = config({ released: allBut("scrolls", "symposium"), ...HOLDING });
  const run = (req, holder) => {
    let error = null;
    try {
      releaseGuard(cfg, holder)(req, {}, () => {});
    } catch (e) {
      error = e;
    }
    return error;
  };
  let asked = 0;
  const yes = () => (++asked, true);
  assert.equal(run({ path: "/api/scrolls", method: "GET", body: {} }, yes), null);
  assert.equal(asked, 1);
  // Not early: refused without asking.
  assert.equal(run({ path: "/api/chat", method: "POST", body: { mode: "symposium" } }, yes).code, "feature_unreleased");
  assert.equal(asked, 1);
  // Released: never asked.
  assert.equal(run({ path: "/api/collabs", method: "GET", body: {} }, yes), null);
  assert.equal(asked, 1);
  // Anything but a plain true is a refusal, and no resolver means no one.
  for (const answer of [false, "true", 1, undefined])
    assert.equal(run({ path: "/api/scrolls", method: "GET", body: {} }, () => answer).code, "feature_unreleased");
  assert.equal(run({ path: "/api/scrolls", method: "GET", body: {} }, undefined).code, "feature_unreleased");
});

test("public surfaces are identical for holders, non-holders and signed-out visitors", async (t) => {
  markEarly(t, "scrolls");
  const svc = await fixture(t, allBut("scrolls", "collab"));
  const h = await holder(svc),
    n = await nonHolder(svc),
    anon = request.agent(svc.app);
  // Someone has been paid, and someone has voted.
  const inner = await signUp(svc);
  hold(svc, inner.id, 30_000_000, now() - HOUR, wallet(), now() - 31 * DAY);
  assert.equal(settleHolderCycles(svc.db, svc.cfg).length, 1);
  await inner.agent.put("/api/holders/vote").send({ update: "collab" }).expect(200);
  for (const path of ["/api/config", "/api/models", "/api/openapi.json", "/api/holders/summary", "/sitemap.xml", "/llms.txt", "/llms-full.txt", "/robots.txt", "/token", "/roadmap"]) {
    const [a, b, c] = await Promise.all([h.agent.get(path), n.agent.get(path), anon.get(path)]);
    assert.equal(a.status, 200, path);
    assert.deepEqual([a.status, a.text], [b.status, b.text], path);
    assert.deepEqual([a.status, a.text], [c.status, c.text], path);
  }
  const cfg = (await anon.get("/api/config")).body;
  // The roadmap may say which updates are early: that's product information.
  assert.equal(cfg.releases.updates.find((u) => u.id === "scrolls").early, true);
  assert.equal(cfg.releases.updates.find((u) => u.id === "symposium").early, false);
  assert.equal(cfg.releases.features.scrolls, false);
  assert.deepEqual(cfg.releases.earlyAccess, { threshold: 5_000_000 });
  assert.deepEqual(cfg.releases.holderProgram.tiers.map((x) => [x.name, x.min, x.credits, x.perk]), [
    ["Holder", 1_000_000, 2000, "library"],
    ["Insider", 5_000_000, 15000, "early"],
    ["Inner Circle", 25_000_000, 100000, "vote"],
  ]);
  assert.doesNotMatch(JSON.stringify(cfg), /earlyAccess":\[|eligible/);
  // The summary is totals and counts only, with nothing about an account.
  const summary = (await anon.get("/api/holders/summary")).body;
  // Early Model Access (live here) adds the models open to Insiders first:
  // the same list for everyone, none right now.
  assert.deepEqual(Object.keys(summary).sort(), ["earlyModels", "rewards", "vote"]);
  assert.deepEqual(summary.earlyModels, { days: 14, models: [] });
  assert.deepEqual(Object.keys(summary.rewards).sort(), ["credits", "holders", "since", "until"]);
  for (const c of summary.vote.candidates) assert.deepEqual(Object.keys(c).sort(), ["id", "title", "votes"]);
  const text = JSON.stringify(summary);
  for (const u of [h, n, inner]) {
    assert.ok(!text.includes(u.id) && !text.includes(u.username));
    assert.ok(!text.includes(row(svc.db, u.id).wallet));
  }
});

test("the session JSON lists the account's own early updates, tier and caps", async (t) => {
  markEarly(t, "scrolls");
  markEarly(t, "symposium");
  const svc = await fixture(t, allBut("scrolls", "symposium"));
  const h = await holder(svc),
    n = await nonHolder(svc);
  const mine = (await h.agent.get("/api/me").expect(200)).body.user;
  assert.deepEqual(mine.earlyAccess, ["symposium", "scrolls"]);
  assert.deepEqual(mine.holder, { eligible: true, threshold: 5_000_000, tier: "insider" });
  assert.equal(typeof mine.tokenChecked, "number");
  const theirs = (await n.agent.get("/api/me").expect(200)).body.user;
  assert.deepEqual(theirs.earlyAccess, []);
  assert.deepEqual(theirs.holder, { eligible: false, threshold: 5_000_000, tier: "holder" });
  assert.deepEqual(theirs.caps, HOLDER_CAPS);
  assert.equal((await request(svc.app).get("/api/me").expect(200)).body.user, null);
  // Same helper as the session: a released update is never "early".
  const released = config({ released: "all", ...HOLDING });
  assert.deepEqual(earlyAccessFor(released, { wallet: wallet(), token_balance: "6000000", token_checked: now(), holder_cycle: now(), holder_low: "6000000" }).earlyAccess, []);
});

test("/token is an unknown page before the release and a public page after", async (t) => {
  const before = await fixture(t, allBut("holders"));
  await request(before.app).get("/token").expect(404);
  await request(before.app).get("/token/").expect(404);
  assert.doesNotMatch((await request(before.app).get("/sitemap.xml")).text, /\/token</);
  const live = await fixture(t, "mvp,holders");
  await request(live.app).get("/token").expect(200);
  assert.match((await request(live.app).get("/sitemap.xml")).text, /<loc>http:\/\/localhost:5175\/token<\/loc>/);
  // The same rule for the shared route list.
  assert.equal(knownPage("/token"), false);
  assert.equal(knownPage("/token", { token: true }), true);
  assert.doesNotMatch(sitemap("https://x.test"), /token/);
  assert.match(sitemap("https://x.test", { token: true }), /https:\/\/x.test\/token/);
});

test("a wallet can be unlinked, but never an account's only way to sign in", async (t) => {
  const closed = await fixture(t, allBut("holders"));
  const early = await holder(closed);
  await refused(early.agent.post("/api/account/wallet/unlink").send({}), TITLE);

  markEarly(t, "scrolls");
  const svc = await fixture(t, allBut("scrolls"));
  await request(svc.app).post("/api/account/wallet/unlink").send({}).expect(401);
  const none = await signUp(svc);
  const r = await none.agent.post("/api/account/wallet/unlink").send({}).expect(400);
  assert.equal(r.body.error.code, "wallet_not_linked");
  // Wallet-only account: unlinking would lock it out.
  const only = await holder(svc);
  svc.db.prepare("UPDATE users SET password=NULL,email=NULL WHERE id=?").run(only.id);
  const locked = await only.agent.post("/api/account/wallet/unlink").send({}).expect(409);
  assert.equal(locked.body.error.code, "wallet_sign_in_only");
  // A holder unlinks: wallet, holdings and cycle go, and so does early access.
  const h = await holder(svc);
  await h.agent.get("/api/scrolls").expect(200);
  const after = (await h.agent.post("/api/account/wallet/unlink").send({}).expect(200)).body.user;
  assert.equal(after.wallet, null);
  assert.equal(after.tokenBalance, "0");
  assert.equal(after.tokenChecked, null);
  assert.deepEqual(after.earlyAccess, []);
  assert.equal(after.holder.eligible, false);
  assert.equal(after.holder.tier, null);
  await refused(h.agent.get("/api/scrolls"), "Scrolls");
});

test("a balance read from the chain opens a cycle and early access, and a failed read never renews it", async (t) => {
  markEarly(t, "scrolls");
  // Account → Refresh reads the balance over RPC; the tier follows it.
  const rpc = await rpcServer(t, { chainId: 4663, balance: 7_000_000n * 10n ** 18n });
  const svc = await fixture(t, allBut("scrolls"), { rpc });
  const u = await signUp(svc);
  svc.db.prepare("UPDATE users SET wallet=? WHERE id=?").run(wallet(), u.id);
  await refused(u.agent.get("/api/scrolls"), "Scrolls");
  const me = (await u.agent.post("/api/account/token/refresh").send({}).expect(200)).body.user;
  assert.equal(me.tokenBalance, "7000000");
  assert.equal(me.holder.eligible, true);
  assert.equal(me.holder.tier, "insider");
  assert.equal(row(svc.db, u.id).holder_low, "7000000");
  assert.equal(row(svc.db, u.id).token_due, null, "a refresh doesn't schedule the worker");
  await u.agent.get("/api/scrolls").expect(200);
  // The worker's read schedules the next one.
  svc.db.prepare("UPDATE users SET token_due=0 WHERE id=?").run(u.id);
  await svc.tick();
  assert.ok(row(svc.db, u.id).token_due > now() + 11 * HOUR);

  // The background worker: a failed read backs off without touching
  // token_checked, so a balance nobody can confirm lapses after 48 hours.
  const broken = await fixture(t, allBut("scrolls")); // wrong-chain RPC
  const v = await signUp(broken);
  const checked = now() - 47 * HOUR;
  hold(broken, v.id, 6_000_000, checked);
  await v.agent.get("/api/scrolls").expect(200);
  await broken.tick();
  const r = broken.db.prepare("SELECT * FROM users WHERE id=?").get(v.id);
  assert.equal(r.token_checked, checked, "a failed read is not a check");
  assert.ok(r.token_retry >= now() - 60000, "the retry is scheduled");
  assert.equal(earlyAccessHolder(broken.cfg, r, now() + 2 * 3600000), false);
  // It isn't retried before the hour is up.
  await broken.tick();
  assert.equal(broken.db.prepare("SELECT token_retry FROM users WHERE id=?").get(v.id).token_retry, r.token_retry);
});

test("the browser opens exactly the account's early updates", () => {
  const config = {
    releases: {
      features: { holders: true, scrolls: false, symposium: false, collab: false },
      updates: [
        { id: "holders", released: true, early: false },
        { id: "scrolls", released: false, early: true },
        { id: "symposium", released: false, early: false },
        { id: "collab", released: false, early: true },
      ],
      earlyAccess: { threshold: 5_000_000 },
    },
  };
  assert.deepEqual(clientEarly(config).map((u) => u.id), ["scrolls", "collab"]);
  // A holder's session lists scrolls, and claims symposium, which isn't early.
  const user = { earlyAccess: ["scrolls", "symposium"] };
  const mine = withEarlyAccess(config, user);
  assert.equal(isReleased(mine, "scrolls"), true);
  assert.equal(isReleased(mine, "symposium"), false);
  assert.equal(isReleased(mine, "collab"), false);
  assert.equal(isEarlyAccess(mine, "scrolls"), true);
  assert.equal(isEarlyAccess(mine, "collab"), false);
  // Nobody else, and the public config itself, is unchanged.
  assert.equal(withEarlyAccess(config, null), config);
  assert.equal(withEarlyAccess(config, { earlyAccess: [] }), config);
  assert.equal(isReleased(config, "scrolls"), false);
  // Before the program is live, nothing opens.
  const off = { releases: { ...config.releases, features: { ...config.releases.features, holders: false } } };
  assert.equal(isReleased(withEarlyAccess(off, user), "scrolls"), false);
  assert.equal(withEarlyAccess(null, user), null);
});

// The words public copy about NYMA must never use, in English and Chinese.
const BANNED = /\b(yield|APY|APR|dividends?|returns?|profits?|invest(ment|ments|ing|or|ors)?|prices?|buy-?backs?|discount|markup|allocation|vesting|liquidity)\b/i;
const BANNED_ZH = /收益|回报|利润|投资|价格|回购|分红|股息|年化|折扣|加价/;
// Visible text in a JSX source: string and template literals and JSX text
// (leaving out code that sits between a closing ">" and the next "<").
const visibleText = (src) =>
  [
    ...src.matchAll(/"((?:[^"\\\n]|\\.)*)"/g),
    ...src.matchAll(/`([^`]*)`/g),
    ...[...src.matchAll(/>([^<>{}]+)</g)].filter((m) => !/[;=]|&&|\?\./.test(m[1])),
  ].map((m) => m[1]).join("\n");

test("NYMA copy sticks to facts and never uses investment language", () => {
  const page = readFileSync(new URL("../src/Token.jsx", import.meta.url), "utf8");
  const panel = readFileSync(new URL("../src/Holders.jsx", import.meta.url), "utf8");
  const paper = readFileSync(new URL("../src/Whitepaper.jsx", import.meta.url), "utf8");
  const section = paper.slice(paper.indexOf('<Section id="nyma"'), paper.indexOf('<Section id="roadmap"'));
  assert.ok(section.length > 200, "the whitepaper has a NYMA section");
  const entry = UPDATES.find((u) => u.id === "holders");
  const copy = [visibleText(page), visibleText(panel), visibleText(section), JSON.stringify(entry)];
  for (const text of copy) assert.doesNotMatch(text, BANNED);
  const flat = (text) => text.replace(/\s+/g, " ");
  for (const text of [flat(page), flat(section)]) {
    assert.match(text, /not financial advice|isn't financial advice|nothing here is financial advice/i);
    assert.match(text, /Rewards are ANONYMA credits, not tokens or cash, and have no cash value\./);
    assert.match(text, /No staking, no locking, no deposits\./);
  }
  assert.match(flat(page), /Inner Circle votes help decide what ships next\./);
  assert.match(flat(page + panel), /nothing is deleted at once\. The normal caps simply apply again, so the oldest items beyond them are removed as new ones are saved\./);
  // The contract comes from the homepage constant, never a second copy.
  assert.doesNotMatch(page + section, /0x968be0c1/);
  assert.match(page, /import \{ CONTRACT_ADDRESS \} from "\.\/Home\.jsx"/);
  // Chinese for the program's strings keeps to the same rule.
  const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
  const entries = [...Object.entries(zh.strings), ...zh.patterns.map((p) => [p.en, p.zh])].filter(([en]) =>
    /\bNYMA\b|Holder|Insider|Inner Circle|Loyal|30-day|cycle|perk|Roadmap vote|Bigger library/.test(en),
  );
  assert.ok(entries.length > 40);
  for (const [en, text] of entries)
    if (!/^(Not financial advice\.|Not a share of the company, and no revenue share\.)$|financial advice|revenue share/.test(en))
      assert.doesNotMatch(text, BANNED_ZH, en);
});
