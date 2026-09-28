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
import { config, now, usdUnits, balance } from "../server/core.js";
import { UPDATES, releaseInfo, featuresFor } from "../server/releases.js";
import {
  recordPayment,
  recordWalletPayment,
  referralUnits,
} from "../server/payments.js";
import {
  DEFAULT_HOLDER_REFERRAL_PERCENTS,
  parseHolderReferralPercents,
  boostedRates,
} from "../server/holder-tiers.js";
import {
  boostLive,
  referralRate,
  referralOptions,
  tierRates,
} from "../server/referral-boost.js";
import { CHECK_MAX_AGE } from "../server/holders.js";
import { openapi } from "../server/openapi.js";
import {
  boostReleased,
  referralBoost,
  ownPercent,
  rateLine,
  boostPerk,
  topPercent,
  tierList,
  percentText,
} from "../src/referral-boost.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ALL = UPDATES.map((u) => u.id);
const allBut = (...ids) =>
  ["mvp", ...ALL.filter((id) => !ids.includes(id))].join(",");
const NYMA_CONTRACT = "0x968be0c1a394bf1ce239e3b40909ec0f9d4f5583";
const HOLDING = { rpc: "http://127.0.0.1:1", token: NYMA_CONTRACT };
const HOUR = 3600000;
const wallet = () => "0x" + randomBytes(20).toString("hex");

// A read-only JSON-RPC stand-in that reports the wrong chain, so no
// background balance refresh ever succeeds and seeded holdings stay exactly
// as a test wrote them.
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
  const dir = mkdtempSync(join(tmpdir(), "anonyma-referral-boost-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
    released: "all",
    token: NYMA_CONTRACT,
    chain: 4663,
    referralPercent: 5,
    ...extra,
    rpc: await rpcServer(t),
  });
  await svc.stopWork();
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function signUp(svc, ref) {
  const agent = request.agent(svc.app);
  const r = await agent
    .post("/api/auth/register")
    .set("Cookie", ref ? `anonyma_ref=${ref}` : "")
    .send({
      username: "u" + randomBytes(5).toString("hex"),
      password: "test-password-long",
    })
    .expect(201);
  return { agent, id: r.body.user.id };
}
// A referrer and a friend who signed up through the referrer's link.
async function pair(svc) {
  const alice = await signUp(svc);
  const code = (await alice.agent.get("/api/referrals").expect(200)).body.code;
  const bob = await signUp(svc, code);
  assert.equal(
    svc.db.prepare("SELECT referred_by FROM users WHERE id=?").get(bob.id)
      .referred_by,
    alice.id,
  );
  return { alice, bob };
}
// Holdings as the worker records them: wallet, balance, last good read and
// the open cycle with its lowest balance (none below the Holder minimum).
function hold(svc, id, amount, checked = now()) {
  const open = amount >= 1_000_000;
  svc.db
    .prepare(
      "UPDATE users SET wallet=?,token_balance=?,token_checked=?,holder_cycle=?,holder_low=? WHERE id=?",
    )
    .run(
      wallet(),
      String(amount),
      checked,
      open ? checked : null,
      open ? String(amount) : null,
      id,
    );
}
function unlink(svc, id) {
  svc.db
    .prepare(
      "UPDATE users SET wallet=NULL,token_balance='0',token_checked=NULL,holder_cycle=NULL,holder_low=NULL WHERE id=?",
    )
    .run(id);
}
let seq = 0;
// An open invoice for `user`, as POST /api/payments creates it.
function invoice(svc, user, dollars) {
  const id = `dep-${++seq}-${randomBytes(3).toString("hex")}`;
  svc.db
    .prepare(
      "INSERT INTO deposits(id,user_id,provider_id,amount,currency,status,payload,credited,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
    )
    .run(
      id,
      user,
      null,
      usdUnits(dollars),
      "btc",
      "waiting",
      "{}",
      0,
      now(),
      now(),
    );
  return {
    id,
    body: {
      payment_id: "pay-" + id,
      order_id: id,
      price_amount: dollars,
      price_currency: "usd",
    },
  };
}
const pay = (svc, inv, status, extra = {}) =>
  recordPayment(
    svc.db,
    { ...inv.body, payment_status: status },
    { current: true, ...referralOptions(svc.cfg), ...extra },
  );
const rewards = (svc, user) =>
  svc.db
    .prepare(
      "SELECT amount,kind,ref,description FROM ledger WHERE user_id=? AND kind IN ('referral','referral_correction') ORDER BY created,rowid",
    )
    .all(user)
    .map((r) => ({ ...r }));

// ---- The update ----

test("Referral Boost is registered last, unreleased, never early, with no routes of its own", () => {
  const entry = UPDATES.find((u) => u.id === "referralboost");
  assert.ok(
    UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "routines"),
    "added after the releases before it",
  );
  assert.equal(entry.title, "Referral Boost");
  assert.equal(entry.points.length, 3);
  assert.equal(committed[UPDATES.indexOf(entry)], true, "released by its release commit");
  assert.equal(entry.early, undefined);
  // It changes a rate, not a route: no request needs it.
  for (const [method, path] of [
    ["GET", "/api/referrals"],
    ["POST", "/api/credits/send"],
    ["GET", "/api/account/holdings"],
    ["POST", "/api/payments/ipn"],
  ])
    assert.ok(
      !featuresFor({ method, path, body: {} }).includes("referralboost"),
    );
});

const PLAIN =
  /\b(returns?|yield|profit|price|APY|APR|interest|invest\w*|earnings?|passive|stak\w+)\b/i;
test("the update's copy stays plain: credits back, no investment language", () => {
  const entry = UPDATES.find((u) => u.id === "referralboost");
  const words = [entry.title, entry.tagline, ...entry.points].join(" ");
  assert.doesNotMatch(words, PLAIN);
  assert.match(entry.points.join(" "), /credits/);
});

// ---- Rates ----

test("HOLDER_REFERRAL_PERCENTS parses tier:percent, with modest defaults", () => {
  assert.equal(
    DEFAULT_HOLDER_REFERRAL_PERCENTS,
    "holder:6,insider:7.5,inner:10",
  );
  assert.deepEqual(
    { ...parseHolderReferralPercents(undefined, 5) },
    { holder: 6, insider: 7.5, inner: 10 },
  );
  // Order, spaces, case and a trailing % don't matter.
  assert.deepEqual(
    {
      ...parseHolderReferralPercents(
        " Inner : 12.25% , holder:5, INSIDER:8 ",
        5,
      ),
    },
    { holder: 5, insider: 8, inner: 12.25 },
  );
  assert.deepEqual(
    { ...parseHolderReferralPercents("holder:50,insider:50,inner:50", 50) },
    { holder: 50, insider: 50, inner: 50 },
  );
  // Empty or "off": no boost at all.
  assert.equal(parseHolderReferralPercents("", 5), null);
  assert.equal(parseHolderReferralPercents("   ", 5), null);
  assert.equal(parseHolderReferralPercents("OFF", 5), null);
  // Config: unset uses the defaults, empty turns the boost off.
  assert.deepEqual(
    { ...config({}).holderReferralPercents },
    { holder: 6, insider: 7.5, inner: 10 },
  );
  assert.equal(
    config({ holderReferralPercents: "" }).holderReferralPercents,
    null,
  );
  assert.deepEqual(
    {
      ...config({ holderReferralPercents: "holder:5,insider:6,inner:7" })
        .holderReferralPercents,
    },
    { holder: 5, insider: 6, inner: 7 },
  );
});

test("HOLDER_REFERRAL_PERCENTS refuses what REFERRAL_PERCENT would, with clear errors", () => {
  const bad = (value, message, base = 5) =>
    assert.throws(
      () => parseHolderReferralPercents(value, base),
      message,
      String(value),
    );
  bad("holder:6,insider:7.5", /missing: inner/);
  bad("holder:6", /missing: insider, inner/);
  bad("holder:6,insider:7.5,inner:10,holder:7", /lists holder more than once/);
  bad(
    "holder:6,insider:7.5,circle:10",
    /tier:percent for holder, insider and inner/,
  );
  bad("holder:6,insider:7.5,inner", /tier:percent/);
  bad("holder:6,insider:7.5,inner:10:2", /tier:percent/);
  bad("holder:six,insider:7.5,inner:10", /tier:percent/);
  bad("holder:-1,insider:7.5,inner:10", /tier:percent/);
  bad("holder:6,insider:7.555,inner:10", /tier:percent/, 0);
  bad("holder:6,insider:.5,inner:10", /tier:percent/, 0);
  bad("holder:6,insider:7.5,inner:51", /between 0 and 50/);
  bad("holder:6,insider:7.5,inner:99.99", /between 0 and 50/);
  bad("holder:8,insider:7.5,inner:10", /can't be below the tier under it/);
  // Set explicitly, a tier below the base would pay a holder less.
  bad("holder:4,insider:7.5,inner:10", /at least REFERRAL_PERCENT \(5\)/);
  assert.throws(
    () =>
      config({
        referralPercent: 8,
        holderReferralPercents: "holder:6,insider:7.5,inner:10",
      }),
    /at least REFERRAL_PERCENT \(8\)/,
  );
  assert.throws(
    () => config({ holderReferralPercents: "insider:7" }),
    /HOLDER_REFERRAL_PERCENTS/,
  );
  // The defaults never stop a server whose base is higher: a tier's rate is
  // never below the base.
  const high = config({ referralPercent: 8 });
  assert.deepEqual(boostedRates(high.holderReferralPercents, 8), {
    holder: 8,
    insider: 8,
    inner: 10,
  });
  // REFERRAL_PERCENT 0 turns every referral reward off, boosted ones too.
  assert.equal(boostedRates(config({}).holderReferralPercents, 0), null);
  assert.equal(boostedRates(null, 5), null);
});

test("rewards are exact integer subcredits, rounded down, at any size", () => {
  // Whole percents match the formula they replace.
  for (const amount of [
    1,
    19,
    20,
    99,
    101,
    12345,
    usdUnits(20),
    987654321987,
    2 ** 53 - 1,
  ])
    assert.equal(
      referralUnits(amount, 5),
      Math.floor((amount * 5) / 100),
      String(amount),
    );
  assert.equal(referralUnits(usdUnits(20), 7.5), 15_000_000); // $1.50
  assert.equal(referralUnits(usdUnits(20), 6), 12_000_000);
  assert.equal(referralUnits(usdUnits(20), 10), 20_000_000);
  // Boundaries: a whole subcredit only once the share reaches one.
  assert.equal(referralUnits(13, 7.5), 0); // 0.975
  assert.equal(referralUnits(14, 7.5), 1); // 1.05
  assert.equal(referralUnits(39, 7.5), 2); // 2.925
  assert.equal(referralUnits(40, 7.5), 3); // exactly 3
  assert.equal(referralUnits(9999, 12.25), 1224); // 1224.8775
  assert.equal(referralUnits(10000, 12.25), 1225);
  // Past 2^53 the product would lose precision in floating point.
  assert.equal(
    referralUnits(2 ** 53 - 1, 7.5),
    Number(((2n ** 53n - 1n) * 75n) / 1000n),
  );
  assert.equal(referralUnits(2 ** 53 - 1, 50), Math.floor((2 ** 53 - 1) / 2));
  // Nothing for nothing.
  for (const [amount, percent] of [
    [0, 10],
    [-5, 10],
    [100, 0],
    [100, -1],
    [1.5, 10],
    [NaN, 10],
  ])
    assert.equal(referralUnits(amount, percent), 0);
});

// ---- The tier at the moment of crediting ----

test("each tier earns its own rate, recorded on the reward; no tier, a stale check or no wallet earn the base", async (t) => {
  const svc = await fixture(t);
  const { alice, bob } = await pair(svc);
  const cases = [
    [1_000_000, "Referral reward (6%, Holder boost)", 6],
    [5_000_000, "Referral reward (7.5%, Insider boost)", 7.5],
    [25_000_000, "Referral reward (10%, Inner Circle boost)", 10],
    [999_999, "Referral reward (5%)", 5], // below the Holder minimum
  ];
  for (const [amount, description, percent] of cases) {
    hold(svc, alice.id, amount);
    const inv = invoice(svc, bob.id, 20);
    const before = balance(svc.db, alice.id).total;
    pay(svc, inv, "finished");
    const row = svc.db
      .prepare("SELECT amount,description FROM ledger WHERE ref=?")
      .get(`referral_${inv.id}`);
    assert.equal(row.description, description);
    assert.equal(row.amount, referralUnits(usdUnits(20), percent));
    assert.equal(balance(svc.db, alice.id).total - before, row.amount);
  }
  // Inner Circle, but the last successful read is over 48 hours old.
  hold(svc, alice.id, 25_000_000, now() - CHECK_MAX_AGE - HOUR);
  const stale = invoice(svc, bob.id, 20);
  pay(svc, stale, "finished");
  assert.deepEqual(
    {
      ...svc.db
        .prepare("SELECT amount,description FROM ledger WHERE ref=?")
        .get(`referral_${stale.id}`),
    },
    { amount: usdUnits(1), description: "Referral reward (5%)" },
  );
  // Just inside the 48 hours, it still counts.
  hold(svc, alice.id, 25_000_000, now() - CHECK_MAX_AGE + 60_000);
  const fresh = invoice(svc, bob.id, 20);
  pay(svc, fresh, "finished");
  assert.equal(
    svc.db
      .prepare("SELECT amount FROM ledger WHERE ref=?")
      .get(`referral_${fresh.id}`).amount,
    usdUnits(2),
  );
  // No wallet at all.
  unlink(svc, alice.id);
  const plain = invoice(svc, bob.id, 20);
  pay(svc, plain, "finished");
  assert.equal(
    svc.db
      .prepare("SELECT description FROM ledger WHERE ref=?")
      .get(`referral_${plain.id}`).description,
    "Referral reward (5%)",
  );
  // The friend's own balance is only ever their deposit.
  assert.equal(
    svc.db
      .prepare(
        "SELECT COUNT(*) n FROM ledger WHERE user_id=? AND kind LIKE 'referral%'",
      )
      .get(bob.id).n,
    0,
  );
});

test("the tier that counts is the one when the deposit is credited, not when the invoice opened", async (t) => {
  const svc = await fixture(t);
  const { alice, bob } = await pair(svc);
  hold(svc, alice.id, 1_000_000); // Holder when the invoice opens
  const inv = invoice(svc, bob.id, 40);
  pay(svc, inv, "confirming");
  assert.equal(
    rewards(svc, alice.id).length,
    0,
    "nothing before it's credited",
  );
  hold(svc, alice.id, 25_000_000); // Inner Circle when it's credited
  pay(svc, inv, "finished");
  assert.deepEqual(rewards(svc, alice.id), [
    {
      amount: usdUnits(4),
      kind: "referral",
      ref: `referral_${inv.id}`,
      description: "Referral reward (10%, Inner Circle boost)",
    },
  ]);
});

test("a deposit credited twice pays one reward, at the rate of the first", async (t) => {
  const svc = await fixture(t);
  const { alice, bob } = await pair(svc);
  hold(svc, alice.id, 5_000_000);
  const inv = invoice(svc, bob.id, 20);
  pay(svc, inv, "finished");
  hold(svc, alice.id, 25_000_000);
  pay(svc, inv, "finished");
  pay(svc, inv, "finished");
  // A signed callback replaying the same status changes nothing either.
  recordPayment(
    svc.db,
    { ...inv.body, payment_status: "finished" },
    referralOptions(svc.cfg),
  );
  const all = rewards(svc, alice.id);
  assert.equal(all.length, 1);
  assert.equal(all[0].amount, usdUnits(1.5));
  assert.equal(all[0].description, "Referral reward (7.5%, Insider boost)");
});

test("reversal and reinstatement move exactly the recorded reward, whatever the tier is now", async (t) => {
  const svc = await fixture(t);
  const { alice, bob } = await pair(svc);
  hold(svc, alice.id, 5_000_000);
  const inv = invoice(svc, bob.id, 33.33);
  const start = balance(svc.db, alice.id).total;
  pay(svc, inv, "finished");
  const paid = referralUnits(usdUnits(33.33), 7.5);
  assert.equal(paid, 24_997_500);
  assert.equal(balance(svc.db, alice.id).total - start, paid);

  // Alice unlinks her wallet, then the deposit is refunded.
  unlink(svc, alice.id);
  pay(svc, inv, "refunded");
  assert.equal(balance(svc.db, alice.id).total, start);
  // Alice reaches Inner Circle, then the operator reinstates the deposit.
  hold(svc, alice.id, 25_000_000);
  pay(svc, inv, "finished", { allowReinstate: true });
  assert.equal(balance(svc.db, alice.id).total - start, paid, "7.5%, not 10%");
  // And again, with no tier at all.
  hold(svc, alice.id, 0);
  pay(svc, inv, "failed");
  assert.equal(balance(svc.db, alice.id).total, start);
  pay(svc, inv, "finished", { allowReinstate: true });
  assert.equal(balance(svc.db, alice.id).total - start, paid);
  assert.deepEqual(
    rewards(svc, alice.id).map((r) => [r.amount, r.kind, r.ref, r.description]),
    [
      [
        paid,
        "referral",
        `referral_${inv.id}`,
        "Referral reward (7.5%, Insider boost)",
      ],
      [
        -paid,
        "referral_correction",
        `referral_${inv.id}_correction_1`,
        "Referral reward reversed (7.5%, Insider boost)",
      ],
      [
        paid,
        "referral_correction",
        `referral_${inv.id}_correction_2`,
        "Referral reward reinstated (7.5%, Insider boost)",
      ],
      [
        -paid,
        "referral_correction",
        `referral_${inv.id}_correction_3`,
        "Referral reward reversed (7.5%, Insider boost)",
      ],
      [
        paid,
        "referral_correction",
        `referral_${inv.id}_correction_4`,
        "Referral reward reinstated (7.5%, Insider boost)",
      ],
    ],
  );
  // An ordinary status poll never reinstates a reversed deposit.
  pay(svc, inv, "refunded");
  pay(svc, inv, "finished");
  assert.equal(balance(svc.db, alice.id).total, start);
});

test("wallet deposits pay the boosted rate too, once per transaction", async (t) => {
  const svc = await fixture(t);
  const { alice, bob } = await pair(svc);
  hold(svc, alice.id, 1_000_000);
  const deposit = {
    user: bob.id,
    providerId: "wallet:4663:0x" + "ab".repeat(32),
    amount: usdUnits(50),
    currency: "usdg",
    payload: {},
  };
  const first = recordWalletPayment(svc.db, deposit, referralOptions(svc.cfg));
  recordWalletPayment(svc.db, deposit, referralOptions(svc.cfg));
  assert.deepEqual(rewards(svc, alice.id), [
    {
      amount: usdUnits(3),
      kind: "referral",
      ref: `referral_${first.id}`,
      description: "Referral reward (6%, Holder boost)",
    },
  ]);
});

// ---- Gates ----

test("unreleased, the boost has no effect and shows nowhere; rewards are exactly as before", async (t) => {
  const svc = await fixture(t, { released: allBut("referralboost") });
  const { alice, bob } = await pair(svc);
  hold(svc, alice.id, 25_000_000);
  assert.equal(boostLive(svc.cfg), false);
  assert.equal(
    referralRate(
      svc.cfg,
      svc.db.prepare("SELECT * FROM users WHERE id=?").get(alice.id),
    ),
    null,
  );
  const inv = invoice(svc, bob.id, 20);
  pay(svc, inv, "finished");
  assert.deepEqual(
    rewards(svc, alice.id).map((r) => [r.amount, r.description]),
    [[usdUnits(1), "Referral reward"]],
  );
  const mine = (await alice.agent.get("/api/referrals").expect(200)).body;
  assert.deepEqual(Object.keys(mine).sort(), [
    "code",
    "earned",
    "invited",
    "link",
    "percent",
  ]);
  assert.equal(mine.percent, 5);
  const cfg = (await request(svc.app).get("/api/config").expect(200)).body;
  assert.equal(cfg.releases.features.referralboost, false);
  assert.equal(cfg.releases.holderProgram.referralBoost, null);
  assert.doesNotMatch(
    JSON.stringify(cfg.releases.holderProgram),
    /referralPercent|"boost"/,
  );
});

test("without the Holder Program, with the boost off or with referral rewards off, nobody gets a boost", async (t) => {
  // The Holder Program isn't released: there are no tiers.
  const noProgram = await fixture(t, { released: allBut("holders") });
  {
    const { alice, bob } = await pair(noProgram);
    hold(noProgram, alice.id, 25_000_000);
    pay(noProgram, invoice(noProgram, bob.id, 20), "finished");
    assert.deepEqual(
      rewards(noProgram, alice.id).map((r) => r.description),
      ["Referral reward"],
    );
    assert.equal(releaseInfo(noProgram.cfg).holderProgram, null);
    const mine = (await alice.agent.get("/api/referrals").expect(200)).body;
    assert.equal(mine.rate, undefined);
  }
  // HOLDER_REFERRAL_PERCENTS set empty: the base for everyone.
  const off = await fixture(t, { holderReferralPercents: "" });
  {
    const { alice, bob } = await pair(off);
    hold(off, alice.id, 25_000_000);
    pay(off, invoice(off, bob.id, 20), "finished");
    assert.deepEqual(
      rewards(off, alice.id).map((r) => [r.amount, r.description]),
      [[usdUnits(1), "Referral reward"]],
    );
    assert.equal(releaseInfo(off.cfg).holderProgram.referralBoost, null);
    assert.equal(
      (await alice.agent.get("/api/referrals").expect(200)).body.boost,
      undefined,
    );
  }
  // REFERRAL_PERCENT 0 turns every referral reward off, Inner Circle too.
  const zero = await fixture(t, { referralPercent: 0 });
  {
    const { alice, bob } = await pair(zero);
    hold(zero, alice.id, 25_000_000);
    pay(zero, invoice(zero, bob.id, 20), "finished");
    assert.deepEqual(rewards(zero, alice.id), []);
    assert.equal(tierRates(zero.cfg), null);
  }
  // Balance reads not configured: nobody is at a tier.
  const unread = await fixture(t, { token: "" });
  {
    const { alice, bob } = await pair(unread);
    hold(unread, alice.id, 25_000_000);
    pay(unread, invoice(unread, bob.id, 20), "finished");
    assert.deepEqual(
      rewards(unread, alice.id).map((r) => r.description),
      ["Referral reward (5%)"],
    );
  }
});

test("a closed referrer's friend earns nobody anything", async (t) => {
  const svc = await fixture(t);
  const { alice, bob } = await pair(svc);
  hold(svc, alice.id, 25_000_000);
  svc.db.prepare("UPDATE users SET deleted=? WHERE id=?").run(now(), alice.id);
  pay(svc, invoice(svc, bob.id, 20), "finished");
  assert.deepEqual(rewards(svc, alice.id), []);
});

// ---- What the account sees ----

test("GET /api/referrals shows this account's rate now and every tier's", async (t) => {
  const svc = await fixture(t);
  const { alice } = await pair(svc);
  const read = async () =>
    (await alice.agent.get("/api/referrals").expect(200)).body;
  let mine = await read();
  assert.equal(mine.percent, 5, "the base, as before");
  assert.deepEqual(mine.rate, { percent: 5, base: 5, tier: null });
  assert.deepEqual(mine.boost, {
    base: 5,
    tiers: [
      { id: "holder", name: "Holder", min: 1_000_000, percent: 6 },
      { id: "insider", name: "Insider", min: 5_000_000, percent: 7.5 },
      { id: "inner", name: "Inner Circle", min: 25_000_000, percent: 10 },
    ],
  });
  hold(svc, alice.id, 5_000_000);
  mine = await read();
  assert.deepEqual(mine.rate, { percent: 7.5, base: 5, tier: "insider" });
  hold(svc, alice.id, 5_000_000, now() - CHECK_MAX_AGE - HOUR);
  assert.deepEqual((await read()).rate, { percent: 5, base: 5, tier: null });
  // Only the account's own rate: nothing about who it invited.
  assert.doesNotMatch(
    JSON.stringify(mine),
    /wallet|token_balance|holder_low|0x/,
  );
  // Signed out: refused as before.
  await request(svc.app).get("/api/referrals").expect(401);
  // The public config carries the same rates for everyone.
  const cfg = (await request(svc.app).get("/api/config").expect(200)).body;
  assert.deepEqual(cfg.releases.holderProgram.referralBoost, {
    base: 5,
    tiers: { holder: 6, insider: 7.5, inner: 10 },
  });
});

test("a tier set equal to the base shows no boost for that tier", async (t) => {
  const svc = await fixture(t, {
    holderReferralPercents: "holder:5,insider:7,inner:9",
  });
  const { alice, bob } = await pair(svc);
  hold(svc, alice.id, 1_000_000);
  assert.deepEqual(
    (await alice.agent.get("/api/referrals").expect(200)).body.rate,
    {
      percent: 5,
      base: 5,
      tier: null,
    },
  );
  pay(svc, invoice(svc, bob.id, 20), "finished");
  assert.deepEqual(
    rewards(svc, alice.id).map((r) => r.description),
    ["Referral reward (5%)"],
  );
});

test("the account export keeps each reward's recorded rate", async (t) => {
  const svc = await fixture(t);
  const { alice, bob } = await pair(svc);
  hold(svc, alice.id, 25_000_000);
  const inv = invoice(svc, bob.id, 20);
  pay(svc, inv, "finished");
  hold(svc, alice.id, 0);
  pay(svc, inv, "refunded");
  const exported = (await alice.agent.get("/api/account/export").expect(200))
    .body;
  const rows = exported.ledger.filter((r) => r.kind.startsWith("referral"));
  assert.deepEqual(
    rows.map((r) => [r.amount, r.description]),
    [
      [usdUnits(2), "Referral reward (10%, Inner Circle boost)"],
      [-usdUnits(2), "Referral reward reversed (10%, Inner Circle boost)"],
    ],
  );
  // The recent-activity list shows the same descriptions.
  const ledger = (await alice.agent.get("/api/account/ledger").expect(200))
    .body;
  assert.ok(
    (ledger.data || ledger).some(
      (r) => r.description === "Referral reward (10%, Inner Circle boost)",
    ),
  );
});

test("every payment path passes the boost: processor callbacks, polls, wallet deposits and the operator", () => {
  const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const paths = {
    "server/routes/payments.js": 3,
    "server/worker.js": 1,
    "scripts/operator.mjs": 1,
  };
  for (const [file, count] of Object.entries(paths)) {
    const code = read(file);
    assert.equal(code.match(/referralOptions\(cfg\)/g)?.length, count, file);
    assert.doesNotMatch(code, /referralPercent: cfg\.referralPercent/, file);
  }
  const options = referralOptions(config({ released: "all", ...HOLDING }));
  assert.equal(options.referralPercent, 5);
  assert.equal(typeof options.referralRate, "function");
});

test("the API contract documents the rate and the boost", () => {
  const op = openapi.paths["/api/referrals"].get;
  const schema = op.responses["200"].content["application/json"].schema;
  assert.ok(schema.properties.rate);
  assert.ok(schema.properties.boost);
  assert.match(op.description, /Referral Boost/);
});

// ---- The browser ----

const released = (extra = {}) => ({
  releases: {
    features: { holders: true, referralboost: true, social: true },
    holderProgram: {
      tiers: [
        {
          id: "holder",
          name: "Holder",
          perk: "library",
          min: 1e6,
          credits: 2000,
        },
        {
          id: "insider",
          name: "Insider",
          perk: "early",
          min: 5e6,
          credits: 15000,
        },
        {
          id: "inner",
          name: "Inner Circle",
          perk: "vote",
          min: 25e6,
          credits: 100000,
        },
      ],
      referralBoost: { base: 5, tiers: { holder: 6, insider: 7.5, inner: 10 } },
      ...extra,
    },
  },
});
const referrals = (rate) => ({
  code: "abcdefgh",
  link: "http://127.0.0.1/?ref=abcdefgh",
  percent: 5,
  invited: 2,
  earned: 150,
  rate,
  boost: {
    base: 5,
    tiers: [
      { id: "holder", name: "Holder", min: 1e6, percent: 6 },
      { id: "insider", name: "Insider", min: 5e6, percent: 7.5 },
      { id: "inner", name: "Inner Circle", min: 25e6, percent: 10 },
    ],
  },
});

test("browser helpers read the rates only while the boost is released", () => {
  assert.equal(boostReleased(released()), true);
  assert.deepEqual(referralBoost(released()), {
    base: 5,
    tiers: { holder: 6, insider: 7.5, inner: 10 },
  });
  const off = released();
  off.releases.features.referralboost = false;
  assert.equal(referralBoost(off), null);
  const noProgram = released();
  noProgram.releases.features.holders = false;
  assert.equal(referralBoost(noProgram), null);
  assert.equal(referralBoost(null), null);
  assert.equal(ownPercent({ percent: 5 }), 5);
  assert.equal(
    ownPercent(referrals({ percent: 7.5, base: 5, tier: "insider" })),
    7.5,
  );
  assert.equal(
    rateLine({ percent: 7.5, base: 5, tier: "insider" }),
    "Your rate: 7.5% (Insider boost)",
  );
  assert.equal(
    rateLine({ percent: 10, base: 5, tier: "inner" }),
    "Your rate: 10% (Inner Circle boost)",
  );
  assert.equal(
    rateLine({ percent: 5, base: 5, tier: null }),
    "Your rate: 5% (base rate)",
  );
  assert.equal(
    boostPerk(referralBoost(released()), "insider"),
    "Referral boost: 7.5%",
  );
  assert.equal(boostPerk({ base: 6, tiers: { holder: 6 } }, "holder"), null);
  assert.equal(boostPerk(null, "holder"), null);
  assert.equal(topPercent(referralBoost(released())), 10);
  assert.equal(percentText(12.25), "12.25%");
  assert.deepEqual(
    tierList(referralBoost(released())).map((t) => [
      t.name,
      t.percent,
      t.boosted,
    ]),
    [
      ["Holder", 6, true],
      ["Insider", 7.5, true],
      ["Inner Circle", 10, true],
    ],
  );
});

async function uiModule() {
  const src = new URL("../src/ReferralBoost.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(
    readFileSync(src, "utf8"),
    src.pathname,
    {
      jsx: "transform",
      format: "esm",
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "anonyma-referral-boost-ui-"));
  const out = code
    .replace(/^import "\.\/referral-boost\.css";$/m, "")
    .replace(
      /from "\.\/referral-boost\.js"/g,
      `from "${new URL("../src/referral-boost.js", import.meta.url)}"`,
    )
    .replace(/from "react"/g, `from "${import.meta.resolve("react")}"`);
  const file = join(dir, "ReferralBoost.mjs");
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
    ...[...html.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)].map(
      (m) => m[1],
    ),
  ]
    .map((s) => entities(s).trim())
    .filter((s) => /[A-Za-z]{2}/.test(s));

test("the invite card shows your rate and every tier's, and nothing while unreleased", async () => {
  const { ReferralRate, HoldingsBoost } = await uiModule();
  const boosted = renderToStaticMarkup(
    createElement(ReferralRate, {
      data: referrals({ percent: 7.5, base: 5, tier: "insider" }),
    }),
  );
  assert.match(boosted, /Your rate: 7\.5% \(Insider boost\)/);
  assert.match(boosted, /Base rate: 5%/);
  assert.match(
    boosted,
    /<li class="on"><span>Insider<\/span><b>7\.5%<\/b><\/li>/,
  );
  assert.match(boosted, /aria-label="Referral rate by NYMA tier"/);
  const base = renderToStaticMarkup(
    createElement(ReferralRate, {
      data: referrals({ percent: 5, base: 5, tier: null }),
    }),
  );
  assert.match(base, /Your rate: 5% \(base rate\)/);
  assert.doesNotMatch(base, /Base rate:/);
  assert.doesNotMatch(base, /class="on"/);
  assert.match(base, /Link a wallet that holds NYMA to get up to 10% back\./);
  // Unreleased: /api/referrals has no rate, and the card shows nothing new.
  assert.equal(
    renderToStaticMarkup(
      createElement(ReferralRate, { data: { percent: 5, link: "x" } }),
    ),
    "",
  );
  // Holdings: the boost as a perk of every tier, the account's own marked.
  const holdings = renderToStaticMarkup(
    createElement(HoldingsBoost, { config: released(), tierId: "inner" }),
  );
  assert.match(holdings, /<h3>Referral boost<\/h3>/);
  assert.match(holdings, /Without a tier: 5%\./);
  for (const [name, percent] of [
    ["Holder", "6%"],
    ["Insider", "7.5%"],
    ["Inner Circle", "10%"],
  ])
    assert.match(
      holdings,
      new RegExp(`<span>${name}</span><b>${percent.replace(".", "\\.")}</b>`),
    );
  assert.match(holdings, /<li class="on"><span>Inner Circle<\/span>/);
  const off = released();
  off.releases.features.referralboost = false;
  assert.equal(
    renderToStaticMarkup(
      createElement(HoldingsBoost, { config: off, tierId: "inner" }),
    ),
    "",
  );
  // Plain words only: credits back, never investment language.
  for (const text of textsOf(boosted + base + holdings))
    assert.doesNotMatch(text, PLAIN);
});

test("the Account page, dashboard, NYMA holdings and /token wire the boost in", () => {
  const read = (f) =>
    readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  const account = read("Account.jsx");
  assert.match(account, /<ReferralRate data=\{data\} \/>/);
  assert.match(
    account,
    /Get \$\{ownPercent\(data\)\}% back in credits when friends top up\./,
  );
  assert.match(
    read("WorkspaceHome.jsx"),
    /You get \$\{ownPercent\(referrals\)\}% back in credits when they top up\./,
  );
  const holders = read("Holders.jsx");
  assert.match(
    holders,
    /<HoldingsBoost config=\{config\} tierId=\{state\?\.tier\?\.id\} \/>/,
  );
  assert.match(holders, /boostPerk\(boost, state\.tier\.id\)/);
  const token = read("Token.jsx");
  assert.match(token, /boostPerk\(boost, t\.id\)/);
  assert.match(token, /Referral boost <small>Holder and up<\/small>/);
});

test("the Chinese dictionary covers the update, the rates, the perk and the ledger rows", async () => {
  const dict = compileDictionary(
    JSON.parse(
      readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"),
    ),
  );
  const han = /\p{Script=Han}/u;
  const { ReferralRate, HoldingsBoost } = await uiModule();
  const html = [
    renderToStaticMarkup(
      createElement(ReferralRate, {
        data: referrals({ percent: 7.5, base: 5, tier: "insider" }),
      }),
    ),
    renderToStaticMarkup(
      createElement(ReferralRate, {
        data: referrals({ percent: 5, base: 5, tier: null }),
      }),
    ),
    renderToStaticMarkup(
      createElement(HoldingsBoost, { config: released(), tierId: "holder" }),
    ),
  ].join("");
  const texts = textsOf(html);
  assert.ok(texts.includes("Your rate: 7.5% (Insider boost)"));
  for (const text of texts)
    assert.match(translateText(text, dict) ?? "", han, `untranslated: ${text}`);
  const entry = UPDATES.find((u) => u.id === "referralboost");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Referral Boost is coming soon.",
    "Your rate: 10% (Inner Circle boost)",
    "Your rate: 6% (Holder boost)",
    "Referral boost",
    "Referral boost: 7.5%",
    "Holder and up",
    "Without a tier",
    "More back in credits when a friend you invited tops up and the payment is confirmed. Your tier when each top-up is confirmed sets its rate.",
    "Get 7.5% back in credits when friends top up.",
    "You get 10% back in credits when they top up. Nobody has joined through your link yet.",
    "Referral reward",
    "Referral reward (5%)",
    "Referral reward (7.5%, Insider boost)",
    "Referral reward (10%, Inner Circle boost)",
    "Referral reward reversed (6%, Holder boost)",
    "Referral reward reinstated (6%, Holder boost)",
    "Referral reward reversed (5%)",
    "Referral reward reinstated (5%)",
    "Referral reward reinstated",
    // The NYMA holdings Perks row, with the boost for each tier.
    "Bigger library, Referral boost: 6%",
    "Bigger library, Early access, Referral boost: 7.5%",
    "Bigger library, Early access, Roadmap vote, Referral boost: 10%",
  ])
    assert.match(translateText(text, dict) ?? "", han, `untranslated: ${text}`);
  // Numbers and tier names survive translation.
  assert.equal(
    translateText("Your rate: 7.5% (Insider boost)", dict),
    "你的返还比例：7.5%（资深持有者加成）",
  );
  assert.equal(
    translateText("Bigger library, Early access, Referral boost: 7.5%", dict),
    "更大的媒体库、抢先体验、推荐加成：7.5%",
  );
  assert.equal(
    translateText("Referral reward (10%, Inner Circle boost)", dict),
    "推荐奖励（10%，核心圈加成）",
  );
});
