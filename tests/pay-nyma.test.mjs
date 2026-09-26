import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { AbiCoder, getAddress, id, keccak256 } from "ethers";
import { createApp } from "../server/app.js";
import { balance, config, now } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import {
  ETH_USDG_POOL,
  NYMA_CONTRACT,
  NYMA_ETH_POOL,
  POOL_MANAGER,
  RATE_SCALE,
  SWAP_TOPIC,
  USDG_CONTRACT,
  averageTick,
  creditsAt,
  nymaFor,
  poolId,
} from "../server/nyma-price.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const PAY_TO = getAddress("0x00000000000000000000000000000000000000aa");
const ALICE_WALLET = getAddress("0x00000000000000000000000000000000000000a1");
const BOB_WALLET = getAddress("0x00000000000000000000000000000000000000b2");
const LOOKALIKE = getAddress("0x00000000000000000000000000000000000000cc");
const TRANSFER = id("Transfer(address,address,uint256)");
const WEI = 10n ** 18n;
const UNITS = 10_000_000;
const topic = (address) =>
  "0x" + address.slice(2).toLowerCase().padStart(64, "0");
const word = (value) =>
  "0x" + BigInt.asUintN(256, BigInt(value)).toString(16).padStart(64, "0");
const hashOf = (n) => "0x" + n.toString(16).padStart(64, "0");
const abi = AbiCoder.defaultAbiCoder();

// Pool ticks: NYMA/ETH prices ETH in NYMA (currency0 ETH), ETH/USDG prices
// ETH in USDG. About $0.00021 per NYMA and $2,690 per ETH.
const TICK_NYMA = 163_000;
const TICK_USD = -197_352;
// The rate the module should reach for given ticks, as it computes it.
const rateFor = (tickNyma, tickUsd) =>
  BigInt(
    Math.floor(
      Math.pow(1.0001, tickUsd - tickNyma) * 1e12 * UNITS * Number(RATE_SCALE),
    ),
  );
const RATE = rateFor(TICK_NYMA, TICK_USD);

// A JSON-RPC node for chain 4663: ten blocks a second, transaction receipts,
// and Uniswap v4 pool state and Swap events the tests control.
async function chain(t) {
  const H0 = 5_000_000;
  const T0 = Math.floor(now() / 1000);
  const state = {
    chainId: 4663,
    head: H0,
    receipts: new Map(),
    calls: [],
    fail: null,
    time: (n) => Math.floor(T0 + (n - H0) / 10),
    // Blocks for a time relative to the start (seconds, may be negative).
    at: (seconds) => H0 + Math.round(seconds * 10),
    pools: {
      [poolId(NYMA_ETH_POOL).toLowerCase()]: {
        base: TICK_NYMA,
        eth: 10,
        swaps: [],
      },
      [poolId(ETH_USDG_POOL).toLowerCase()]: {
        base: TICK_USD,
        eth: 1500,
        swaps: [],
      },
    },
  };
  const nymaPool = poolId(NYMA_ETH_POOL).toLowerCase();
  const usdPool = poolId(ETH_USDG_POOL).toLowerCase();
  state.nyma = state.pools[nymaPool];
  state.usd = state.pools[usdPool];
  const slots = Object.fromEntries(
    Object.keys(state.pools).map((p) => [
      BigInt(keccak256(abi.encode(["bytes32", "uint256"], [p, 6]))),
      p,
    ]),
  );
  const tickAt = (pool, block) => {
    let tick = pool.base;
    for (const s of pool.swaps) if (s.block <= block) tick = s.tick;
    return tick;
  };
  const sqrtOf = (tick) =>
    BigInt(Math.floor(Math.sqrt(Math.pow(1.0001, tick)) * 2 ** 96));
  // In-range liquidity for `eth` ETH as currency0: L = amount0 * sqrtP.
  const liquidity = (pool, tick) =>
    BigInt(Math.floor(pool.eth * 1e18 * Math.sqrt(Math.pow(1.0001, tick))));
  const call = ({ to, data }, tag) => {
    if (to.toLowerCase() !== POOL_MANAGER.toLowerCase()) return "0x";
    const slot = BigInt("0x" + data.slice(10));
    const block = tag === "latest" ? state.head : Number(tag);
    const p = slots[slot] ?? slots[slot - 3n];
    if (!p) return word(0);
    const pool = state.pools[p];
    if (pool.uninitialized) return word(0);
    const tick = tickAt(pool, block);
    if (slots[slot]) {
      const packed =
        sqrtOf(tick) | (BigInt.asUintN(24, BigInt(tick)) << 160n);
      return word(packed);
    }
    return word(liquidity(pool, tick));
  };
  const logs = (filter) => {
    const from = Number(filter.fromBlock),
      to = Number(filter.toBlock);
    const wanted = [].concat(filter.topics?.[1] ?? []).map((x) => x.toLowerCase());
    const out = [];
    for (const [p, pool] of Object.entries(state.pools)) {
      if (!wanted.includes(p)) continue;
      for (const s of pool.swaps)
        if (s.block >= from && s.block <= to)
          out.push({
            address: POOL_MANAGER,
            topics: [SWAP_TOPIC, p, topic(ALICE_WALLET)],
            data:
              "0x" +
              [0, 0, sqrtOf(s.tick), liquidity(pool, s.tick), s.tick, 0]
                .map((v) => word(v).slice(2))
                .join(""),
            blockNumber: "0x" + s.block.toString(16),
            logIndex: "0x" + (s.index ?? 1).toString(16),
            removed: false,
          });
    }
    return out;
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const rpc = JSON.parse(raw);
    state.calls.push(rpc.method);
    res.setHeader("Content-Type", "application/json");
    if (state.fail?.(rpc))
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32000, message: "unavailable" },
        }),
      );
    const result = {
      eth_chainId: () => "0x" + state.chainId.toString(16),
      eth_blockNumber: () => "0x" + state.head.toString(16),
      eth_getTransactionReceipt: () =>
        state.receipts.get(rpc.params[0]) ?? null,
      eth_getBlockByNumber: () => ({
        number: rpc.params[0],
        timestamp: "0x" + state.time(Number(rpc.params[0])).toString(16),
      }),
      eth_call: () => call(rpc.params[0], rpc.params[1]),
      eth_getLogs: () => logs(rpc.params[0]),
    }[rpc.method]?.();
    res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  state.url = `http://127.0.0.1:${server.address().port}`;
  // A receipt with one NYMA transfer unless overridden. Block defaults to
  // five before the head, which is enough confirmations (3).
  state.pay = (
    hash,
    {
      from = ALICE_WALLET,
      to = PAY_TO,
      token = NYMA_CONTRACT,
      amount = 1000n * WEI,
      block = state.head - 5,
      status = "0x1",
      logs: custom,
    } = {},
  ) =>
    state.receipts.set(hash, {
      transactionHash: hash,
      status,
      blockNumber: "0x" + block.toString(16),
      logs: custom ?? [
        {
          address: token,
          topics: [TRANSFER, topic(from), topic(to)],
          data: word(amount),
          logIndex: "0x4",
          removed: false,
        },
      ],
    });
  return state;
}

function fixture(t, rpc, { released, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-pay-nyma-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: released ?? "all",
    walletPaymentAddress: PAY_TO,
    walletPaymentRpc: rpc,
    walletPaymentConfirmations: 3,
    walletPaymentRetryMs: 0,
    nymaRateTtlMs: 0,
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function register(svc, name, wallet) {
  const agent = request.agent(svc.app);
  const { user } = (
    await agent
      .post("/api/auth/register")
      .send({ username: name, password: "test-password-long" })
      .expect(201)
  ).body;
  if (wallet)
    svc.db.prepare("UPDATE users SET wallet=? WHERE id=?").run(wallet, user.id);
  return { agent, user };
}
const quote = (agent, usd) => agent.post("/api/nyma/quote").send({ usd });
const claim = (agent, txHash) =>
  agent.post("/api/nyma/claim").send({ txHash });
const ledger = (svc, user, kind) =>
  svc.db
    .prepare("SELECT * FROM ledger WHERE user_id=? AND kind=? ORDER BY created")
    .all(user, kind);
const units = (credits) => Math.round(credits * 10000);

test("a quote locks the rate, and the quoted NYMA is credited at it with a 10% bonus", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const before = balance(svc.db, alice.user.id).total;

  const rate = (await alice.agent.get("/api/nyma/rate").expect(200)).body;
  const usd = Number(RATE) / 1e19;
  assert.ok(Math.abs(rate.usdPerNyma - usd) / usd < 1e-9);
  assert.equal(rate.bonus, 0.1);
  assert.ok(rate.averageMinutes >= 30);

  const q = (await quote(alice.agent, 10).expect(201)).body;
  const nyma = nymaFor(10 * UNITS, RATE);
  assert.equal(q.quote.nyma, (nyma / WEI).toString());
  const value = Number(creditsAt(nyma, RATE));
  assert.ok(value >= 10 * UNITS && value < 10 * UNITS + Number(creditsAt(WEI, RATE)) + 1);
  assert.equal(q.quote.credits, value / 10000);
  assert.equal(q.quote.bonusCredits, Math.floor(value / 10) / 10000);
  assert.equal(q.quote.open, true);
  assert.equal(q.quote.expires - q.quote.created, 20 * 60000);
  assert.equal(q.remainingTodayUsd, 1000);
  // The open quote comes back for a reloaded page.
  const open = (await alice.agent.get("/api/nyma/quote").expect(200)).body;
  assert.equal(open.quote.id, q.quote.id);

  node.pay(hashOf(1), { amount: nyma });
  const d = (await claim(alice.agent, hashOf(1)).expect(201)).body;
  assert.equal(d.credited, 1);
  assert.equal(d.currency, "nyma");
  assert.equal(d.amount, value / UNITS);
  assert.equal(d.payload.rate_basis, "quote");
  assert.equal(d.payload.quote_id, q.quote.id);
  assert.equal(d.payload.pay_amount, q.quote.nyma);
  assert.equal(d.payload.pay_currency, "NYMA on Robinhood Chain");
  assert.equal(d.payload.bonus_percent, 10);
  const bonus = Math.floor(value / 10);
  assert.equal(balance(svc.db, alice.user.id).total - before, value + bonus);

  // Ledger kinds: the value and the bonus, each once.
  const [topup] = ledger(svc, alice.user.id, "nyma_topup");
  const [extra] = ledger(svc, alice.user.id, "nyma_bonus");
  assert.equal(topup.amount, value);
  assert.equal(topup.ref, `payment_nyma:4663:${hashOf(1)}`);
  assert.equal(topup.description, "NYMA top-up");
  assert.equal(extra.amount, bonus);
  assert.equal(extra.description, "NYMA top-up bonus");
  // The log is claimed by transaction hash and log index.
  assert.deepEqual(
    svc.db.prepare("SELECT chain,tx_hash,log_index FROM nyma_claims").all().map((r) => ({ ...r })),
    [{ chain: 4663, tx_hash: hashOf(1), log_index: 4 }],
  );
  // It's in the deposits list, and counts against the 24-hour limit.
  const list = (await alice.agent.get("/api/deposits").expect(200)).body.data;
  assert.equal(list[0].id, d.id);
  const after = (await alice.agent.get("/api/nyma/quote").expect(200)).body;
  assert.ok(Math.abs(after.remainingTodayUsd - (1000 - value / UNITS)) < 1e-9);
});

test("repeats return the same top-up and nobody can claim a transfer twice", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const bob = await register(svc, "bob", BOB_WALLET);
  await quote(alice.agent, 5).expect(201);
  await quote(bob.agent, 5).expect(201);
  node.pay(hashOf(2));
  const first = (await claim(alice.agent, hashOf(2)).expect(201)).body;
  const again = (await claim(alice.agent, hashOf(2).toUpperCase().replace("0X", "0x")).expect(200)).body;
  assert.equal(again.id, first.id);
  assert.equal((await claim(bob.agent, hashOf(2)).expect(409)).body.error.code, "payment_already_claimed");
  // Concurrent claims credit once.
  node.pay(hashOf(3), { amount: 500n * WEI });
  const both = await Promise.all([claim(alice.agent, hashOf(3)), claim(alice.agent, hashOf(3))]);
  assert.ok(both.every((r) => [200, 201].includes(r.status)));
  assert.equal(both[0].body.id, both[1].body.id);
  assert.equal(ledger(svc, alice.user.id, "nyma_topup").length, 2);
  assert.equal(ledger(svc, alice.user.id, "nyma_bonus").length, 2);
  // The Transfer log itself is unique too.
  assert.throws(
    () =>
      svc.db
        .prepare("INSERT INTO nyma_claims(chain,tx_hash,log_index,deposit_id) VALUES(?,?,?,?)")
        .run(4663, hashOf(2), 4, first.id),
    /UNIQUE|PRIMARY KEY/,
  );
  // A NYMA transfer isn't a USDG payment, and a USDG claim can't take it.
  assert.equal(
    (await alice.agent.post("/api/deposits/wallet").send({ txHash: hashOf(3) }).expect(400)).body.error.code,
    "payment_not_matched",
  );
});

test("only NYMA from the linked wallet to the payment address counts", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const before = balance(svc.db, alice.user.id).total;
  await quote(alice.agent, 5).expect(201);
  const code = async (hash, status = 400) =>
    (await claim(alice.agent, hash).expect(status)).body.error.code;
  // Wrong token: USDG, and a look-alike contract.
  node.pay(hashOf(10), { token: USDG_CONTRACT });
  assert.equal(await code(hashOf(10)), "payment_not_matched");
  node.pay(hashOf(11), { token: LOOKALIKE });
  assert.equal(await code(hashOf(11)), "payment_not_matched");
  // Wrong recipient, and someone else's transfer.
  node.pay(hashOf(12), { to: BOB_WALLET });
  assert.equal(await code(hashOf(12)), "payment_not_matched");
  node.pay(hashOf(13), { from: BOB_WALLET });
  assert.equal(await code(hashOf(13)), "payment_not_matched");
  node.pay(hashOf(14), { status: "0x0" });
  assert.equal(await code(hashOf(14)), "transaction_failed");
  assert.equal(await code("0x1234"), "invalid_transaction");
  assert.equal(balance(svc.db, alice.user.id).total, before);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM deposits").get().n, 0);
});

test("the wrong chain is refused", async (t) => {
  const node = await chain(t);
  node.chainId = 1;
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  svc.db
    .prepare("INSERT INTO nyma_quotes(id,user_id,wallet,nyma,value,bonus,bonus_bps,rate,usd_per_nyma,created,expires) VALUES('nq_x',?,?,?,?,?,?,?,?,?,?)")
    .run(alice.user.id, ALICE_WALLET, (1000n * WEI).toString(), 2_000_000, 200_000, 1000, RATE.toString(), 0.0002, now(), now() + 1200000);
  node.pay(hashOf(20));
  assert.equal((await claim(alice.agent, hashOf(20)).expect(503)).body.error.code, "chain_unavailable");
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM deposits").get().n, 0);
  // A payment chain other than Robinhood Chain has no NYMA top-ups at all.
  const other = fixture(t, node.url, { walletPaymentChain: 1 });
  const erin = await register(other, "erin", ALICE_WALLET);
  assert.equal((await quote(erin.agent, 5).expect(503)).body.error.code, "nyma_payments_unconfigured");
  assert.equal((await request(other.app).get("/api/config").expect(200)).body.nymaPayments, null);
});

test("a transfer waits for confirmations", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  await quote(alice.agent, 5).expect(201);
  let r = (await claim(alice.agent, hashOf(30)).expect(202)).body;
  assert.equal(r.status, "waiting");
  node.pay(hashOf(30), { block: node.head - 1 }); // 2 of 3
  r = (await claim(alice.agent, hashOf(30)).expect(202)).body;
  assert.deepEqual([r.status, r.confirmations, r.required], ["confirming", 2, 3]);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM deposits").get().n, 0);
  node.head += 1;
  assert.equal((await claim(alice.agent, hashOf(30)).expect(201)).body.credited, 1);
});

test("less NYMA is credited proportionally and more NYMA in full, at the quoted rate", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const q = (await quote(alice.agent, 20).expect(201)).body.quote;
  const quoted = BigInt(q.nyma) * WEI;
  node.pay(hashOf(40), { amount: quoted / 2n });
  const half = (await claim(alice.agent, hashOf(40)).expect(201)).body;
  const halfValue = Number(creditsAt(quoted / 2n, RATE));
  assert.equal(half.amount, halfValue / UNITS);
  assert.equal(ledger(svc, alice.user.id, "nyma_bonus")[0].amount, Math.floor(halfValue / 10));
  // A second transfer inside the same window gets the same rate.
  node.pay(hashOf(41), { amount: (quoted * 3n) / 2n });
  const more = (await claim(alice.agent, hashOf(41)).expect(201)).body;
  assert.equal(more.amount, Number(creditsAt((quoted * 3n) / 2n, RATE)) / UNITS);
  assert.equal(more.payload.rate_basis, "quote");
  // Transfers summed within one transaction, each log claimed.
  const log = (amount, index) => ({
    address: NYMA_CONTRACT,
    topics: [TRANSFER, topic(ALICE_WALLET), topic(PAY_TO)],
    data: word(amount),
    logIndex: "0x" + index.toString(16),
  });
  node.pay(hashOf(42), { logs: [log(100n * WEI, 2), log(50n * WEI, 7)] });
  const summed = (await claim(alice.agent, hashOf(42)).expect(201)).body;
  assert.equal(summed.payload.pay_amount, "150");
  assert.deepEqual(
    svc.db.prepare("SELECT log_index FROM nyma_claims WHERE tx_hash=? ORDER BY log_index").all(hashOf(42)).map((r) => r.log_index),
    [2, 7],
  );
});

test("a late transfer gets the lower of the quoted and current rates", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const q = (await quote(alice.agent, 10).expect(201)).body.quote;
  // The quote ended ten minutes before the transfer.
  svc.db
    .prepare("UPDATE nyma_quotes SET created=?,expires=? WHERE id=?")
    .run(now() - 30 * 60000, now() - 10 * 60000, q.id);
  const sent = BigInt(q.nyma) * WEI;
  // NYMA is worth more now: the quoted rate stands.
  node.nyma.base = TICK_NYMA - 300;
  node.pay(hashOf(50), { amount: sent });
  const up = (await claim(alice.agent, hashOf(50)).expect(201)).body;
  assert.equal(up.payload.rate_basis, "late");
  assert.equal(up.amount, Number(creditsAt(sent, RATE)) / UNITS);
  // NYMA is worth less now: the current rate applies.
  node.nyma.base = TICK_NYMA + 300;
  node.pay(hashOf(51), { amount: sent });
  const down = (await claim(alice.agent, hashOf(51)).expect(201)).body;
  const lower = rateFor(TICK_NYMA + 300, TICK_USD);
  assert.equal(down.amount, Number(creditsAt(sent, lower)) / UNITS);
  assert.ok(down.amount < up.amount);
  // With no current rate, a late transfer waits: nothing is credited.
  node.nyma.base = TICK_NYMA;
  node.fail = (rpc) => rpc.method === "eth_getLogs";
  node.pay(hashOf(52), { amount: sent });
  assert.equal((await claim(alice.agent, hashOf(52)).expect(503)).body.error.code, "nyma_rate_unavailable");
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM deposits WHERE provider_id LIKE ?").get("%" + hashOf(52)).n, 0);
  node.fail = null;
  assert.equal((await claim(alice.agent, hashOf(52)).expect(201)).body.credited, 1);
  // A transfer before any quote needs support.
  const bob = await register(svc, "bob", BOB_WALLET);
  node.pay(hashOf(53), { from: BOB_WALLET });
  assert.equal((await claim(bob.agent, hashOf(53)).expect(409)).body.error.code, "wallet_payment_review");
  // A transfer sent a little before its quote, within the clock allowance,
  // belongs to it; a newer quote ends the old one's window.
  const first = (await quote(bob.agent, 5).expect(201)).body.quote;
  const second = (await quote(bob.agent, 6).expect(201)).body.quote;
  const rows = svc.db.prepare("SELECT id,expires FROM nyma_quotes WHERE user_id=? ORDER BY created").all(bob.user.id);
  assert.equal(rows[0].id, first.id);
  assert.ok(rows[0].expires <= second.created);
  assert.equal((await bob.agent.get("/api/nyma/quote").expect(200)).body.quote.id, second.id);
});

test("per-payment and 24-hour limits hold", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url, { nymaMaxUsd: 50, nymaDailyMaxUsd: 80 });
  const alice = await register(svc, "alice", ALICE_WALLET);
  assert.equal((await quote(alice.agent, 51).expect(400)).body.error.code, "invalid_amount");
  assert.equal((await quote(alice.agent, 0.5).expect(400)).body.error.code, "invalid_amount");
  const q = (await quote(alice.agent, 50).expect(201)).body.quote;
  node.pay(hashOf(60), { amount: BigInt(q.nyma) * WEI });
  await claim(alice.agent, hashOf(60)).expect(201);
  // $30 of the day's $80 is left.
  const left = (await quote(alice.agent, 31).expect(409)).body.error;
  assert.equal(left.code, "nyma_daily_limit");
  assert.match(left.message, /\$29\.99 more now|\$30 more now/);
  const small = (await quote(alice.agent, 29).expect(201)).body.quote;
  // Sending far more than a payment may be worth waits for support.
  node.pay(hashOf(61), { amount: BigInt(small.nyma) * WEI * 3n });
  assert.equal((await claim(alice.agent, hashOf(61)).expect(409)).body.error.code, "wallet_payment_review");
  // Within the per-payment limit but past the day's: support too.
  node.pay(hashOf(62), { amount: (BigInt(small.nyma) * WEI * 3n) / 2n });
  const over = (await claim(alice.agent, hashOf(62)).expect(409)).body.error;
  assert.equal(over.code, "wallet_payment_review");
  assert.match(over.message, /\$80 limit for NYMA top-ups in 24 hours/);
  assert.equal(ledger(svc, alice.user.id, "nyma_topup").length, 1);
  // The exact quoted amount still fits.
  node.pay(hashOf(63), { amount: BigInt(small.nyma) * WEI });
  await claim(alice.agent, hashOf(63)).expect(201);
  // Quotes are rate limited.
  const bob = await register(svc, "bob", BOB_WALLET);
  let status;
  for (let i = 0; i < 31; i++) status = (await quote(bob.agent, 1)).status;
  assert.equal(status, 429);
});

test("a spot spike never raises credits past the 30-minute average", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  // Steady trading for an hour, then NYMA pushed up about 5% (500 ticks) in
  // the last 30 seconds.
  node.nyma.swaps = [
    { block: node.at(-3600), tick: TICK_NYMA },
    { block: node.at(-1500), tick: TICK_NYMA + 10 },
    { block: node.at(-900), tick: TICK_NYMA },
    { block: node.at(-30), tick: TICK_NYMA - 500 },
  ];
  node.usd.swaps = [{ block: node.at(-7200), tick: TICK_USD }];
  const r = (await alice.agent.get("/api/nyma/rate").expect(200)).body;
  const spot = Number(rateFor(TICK_NYMA - 500, TICK_USD)) / 1e19;
  const steady = Number(RATE) / 1e19;
  assert.ok(r.usdPerNyma < spot * 0.97, "well under the spiked spot");
  assert.ok(r.usdPerNyma < steady * 1.01, "within 1% of the steady rate");
  const q = (await quote(alice.agent, 10).expect(201)).body.quote;
  const atSpot = nymaFor(10 * UNITS, rateFor(TICK_NYMA - 500, TICK_USD)) / WEI;
  assert.ok(BigInt(q.nyma) > atSpot, "the quote asks for more NYMA than the spike would");
  // The average is time-weighted in ticks.
  const avg = averageTick(
    [{ block: 10, tick: 110 }],
    100,
    (b) => b,
    0,
    40,
  );
  assert.deepEqual(avg, { average: 107.5, last: 110 });
  // A dip below the average is used as it is: the lower of the two.
  node.nyma.swaps.push({ block: node.at(-10), tick: TICK_NYMA + 200 });
  const dip = (await alice.agent.get("/api/nyma/rate").expect(200)).body;
  assert.ok(Math.abs(dip.usdPerNyma - Number(rateFor(TICK_NYMA + 200, TICK_USD)) / 1e19) < 1e-12);
});

test("no trustworthy rate means no quotes", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const refused = async () =>
    (await quote(alice.agent, 10).expect(503)).body.error.code;
  // A spike more than 10% from the average.
  node.nyma.swaps = [
    { block: node.at(-3600), tick: TICK_NYMA },
    { block: node.at(-60), tick: TICK_NYMA - 1500 },
  ];
  assert.equal(await refused(), "nyma_rate_unavailable");
  // ETH/USD swinging the same way.
  node.nyma.swaps = [];
  node.usd.swaps = [
    { block: node.at(-3600), tick: TICK_USD },
    { block: node.at(-60), tick: TICK_USD + 1500 },
  ];
  assert.equal(await refused(), "nyma_rate_unavailable");
  node.usd.swaps = [];
  // Too little NYMA in the pool.
  node.nyma.eth = 1;
  assert.equal(await refused(), "nyma_rate_unavailable");
  node.nyma.eth = 10;
  // Swaps in the window but no history before it.
  node.nyma.swaps = [{ block: node.at(-60), tick: TICK_NYMA }];
  assert.equal(await refused(), "nyma_rate_unavailable");
  node.nyma.swaps = [];
  // An uninitialized pool, or a node that can't answer.
  node.nyma.uninitialized = true;
  assert.equal(await refused(), "nyma_rate_unavailable");
  node.nyma.uninitialized = false;
  node.fail = () => true;
  assert.equal(await refused(), "nyma_rate_unavailable");
  assert.equal((await alice.agent.get("/api/nyma/rate").expect(503)).body.error.code, "nyma_rate_unavailable");
  node.fail = null;
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM nyma_quotes").get().n, 0);
  await quote(alice.agent, 10).expect(201);
});

test("quotes need a linked wallet, no payment under reconciliation, and configuration", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const carol = await register(svc, "carol");
  assert.equal((await quote(carol.agent, 5).expect(400)).body.error.code, "wallet_not_linked");
  node.pay(hashOf(70));
  assert.equal((await claim(carol.agent, hashOf(70)).expect(400)).body.error.code, "wallet_not_linked");
  const alice = await register(svc, "alice", ALICE_WALLET);
  svc.db
    .prepare("INSERT INTO deposits(id,user_id,provider_id,amount,currency,status,payload,credited,created,updated) VALUES('d_r',?,'p_r',1,'usdg','reconciliation','{}',1,?,?)")
    .run(alice.user.id, now(), now());
  assert.equal((await quote(alice.agent, 5).expect(409)).body.error.code, "payment_reconciliation_pending");
  const off = fixture(t, node.url, { walletPaymentAddress: "" });
  const dave = await register(off, "dave", ALICE_WALLET);
  assert.equal((await quote(dave.agent, 5).expect(503)).body.error.code, "nyma_payments_unconfigured");
  assert.equal((await claim(dave.agent, hashOf(70)).expect(503)).body.error.code, "nyma_payments_unconfigured");
});

test("a referred account's NYMA top-up rewards the referrer on its value, not the bonus", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url, { referralPercent: 5 });
  const alice = await register(svc, "alice");
  const bob = await register(svc, "bob", BOB_WALLET);
  svc.db.prepare("UPDATE users SET referred_by=? WHERE id=?").run(alice.user.id, bob.user.id);
  const q = (await quote(bob.agent, 20).expect(201)).body.quote;
  node.pay(hashOf(80), { from: BOB_WALLET, amount: BigInt(q.nyma) * WEI });
  await claim(bob.agent, hashOf(80)).expect(201);
  const [reward] = ledger(svc, alice.user.id, "referral");
  assert.equal(reward.amount, Math.floor((units(q.credits) * 5) / 100));
});

test("quotes are exported, erased by Panic Wipe and block closure while open; top-ups stay", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const q = (await quote(alice.agent, 5).expect(201)).body.quote;
  node.pay(hashOf(90), { amount: BigInt(q.nyma) * WEI });
  await claim(alice.agent, hashOf(90)).expect(201);
  const exported = (await alice.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.nymaQuotes.length, 1);
  assert.equal(exported.nymaQuotes[0].id, q.id);
  assert.equal(exported.nymaQuotes[0].user_id, undefined);
  assert.equal(exported.deposits[0].currency, "nyma");
  // Closing waits for the open quote.
  assert.match(
    (await alice.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(409)).body.error.message,
    /NYMA top-up quote is still open/,
  );
  const total = balance(svc.db, alice.user.id).total;
  await alice.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM nyma_quotes").get().n, 0);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM nyma_claims").get().n, 1);
  assert.equal(balance(svc.db, alice.user.id).total, total);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM deposits WHERE currency='nyma'").get().n, 1);
});

test("Pay with NYMA is registered off, gated and described without investment language", async (t) => {
  const entry = UPDATES.find((u) => u.id === "paynyma");
  assert.equal(entry.title, "Pay with NYMA");
  assert.equal(entry.tagline, "Top up with NYMA. Get more credits for it.");
  assert.equal(entry.points.length, 3);
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  const gate = (path, method = "GET") => featuresFor({ path, method, body: {} });
  assert.deepEqual(gate("/api/nyma/rate"), ["paynyma"]);
  assert.deepEqual(gate("/api/nyma/quote", "POST"), ["paynyma"]);
  assert.deepEqual(gate("/API/NYMA/Claim", "POST"), ["paynyma"]);
  assert.deepEqual(gate("/api/deposits/wallet", "POST"), []);

  const node = await chain(t);
  const svc = fixture(t, node.url, { released: "mvp" });
  const alice = await register(svc, "alice", ALICE_WALLET);
  for (const [method, path] of [["get", "/api/nyma/rate"], ["get", "/api/nyma/quote"], ["post", "/api/nyma/quote"], ["post", "/api/nyma/claim"]])
    assert.equal((await alice.agent[method](path).send({ usd: 5, txHash: hashOf(1) }).expect(403)).body.error.code, "feature_unreleased");
  const cfg = (await request(svc.app).get("/api/config").expect(200)).body;
  assert.equal(cfg.nymaPayments, null);
  assert.equal(cfg.services.nymaPayments, false);
  // USDG payments are untouched by the gate.
  node.receipts.clear();
  assert.equal((await alice.agent.post("/api/deposits/wallet").send({ txHash: hashOf(1) }).expect(202)).body.status, "waiting");
  const open = (await request(fixture(t, node.url).app).get("/api/config").expect(200)).body;
  assert.deepEqual(open.nymaPayments, {
    token: NYMA_CONTRACT,
    symbol: "NYMA",
    decimals: 18,
    bonus: 0.1,
    quoteMinutes: 20,
    averageMinutes: 30,
    minUsd: 1,
    maxUsd: 250,
    dailyMaxUsd: 1000,
  });
  assert.ok(!JSON.stringify(open).includes(node.url));

  // Copy: no investment, yield, price or discount language, in English or
  // Chinese.
  const BANNED = /\b(yield|APY|APR|dividends?|returns?|profits?|invest(ment|ments|ing|or|ors)?|prices?|buy-?backs?|discount|markup|allocation|vesting|liquidity|moon|pump|gains?)\b/i;
  const BANNED_ZH = /收益|回报|利润|投资|价格|回购|分红|股息|年化|折扣|加价|涨/;
  const panel = readFileSync(new URL("../src/NymaPay.jsx", import.meta.url), "utf8");
  const visible = [
    ...panel.matchAll(/"((?:[^"\\\n]|\\.)*)"/g),
    ...panel.matchAll(/`([^`]*)`/g),
    ...[...panel.matchAll(/>([^<>{}]+)</g)].filter((m) => !/[;=]|&&|\?\./.test(m[1])),
  ].map((m) => m[1]).join("\n");
  for (const text of [visible, JSON.stringify(entry)]) assert.doesNotMatch(text, BANNED);
  assert.match(panel.replace(/\s+/g, " "), /You send from your own wallet\. ANONYMA never asks for your keys or seed phrase\./);
  const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
  const mine = [...Object.entries(zh.strings), ...zh.patterns.map((p) => [p.en, p.zh])].filter(([en]) => /\bNYMA\b/.test(en));
  for (const [en, text] of mine) if (!/financial advice|revenue share/.test(en)) assert.doesNotMatch(text, BANNED_ZH, en);
  for (const en of [entry.title, entry.tagline, ...entry.points, "NYMA top-up", "NYMA top-up bonus", "You send from your own wallet. ANONYMA never asks for your keys or seed phrase."])
    assert.ok(zh.strings[en], `zh for ${en}`);
  // The Account ledger names both kinds.
  const account = readFileSync(new URL("../src/Account.jsx", import.meta.url), "utf8");
  assert.match(account, /nyma_topup: "NYMA top-up"/);
  assert.match(account, /nyma_bonus: "NYMA top-up bonus"/);
});

test("NYMA top-up settings are validated", () => {
  assert.throws(() => config({ nymaTopupBonus: 1.5 }), /NYMA_TOPUP_BONUS/);
  assert.throws(() => config({ nymaTopupBonus: -0.1 }), /NYMA_TOPUP_BONUS/);
  assert.throws(() => config({ nymaMaxUsd: 2000, nymaDailyMaxUsd: 1000 }), /limits/);
  assert.throws(() => config({ nymaTwapMinutes: 10 }), /NYMA_TWAP_MINUTES/);
  assert.throws(() => config({ nymaMaxDeviation: 0 }), /DEVIATION/);
  const cfg = config({});
  assert.equal(cfg.nymaTopupBonus, 0.1);
  assert.equal(cfg.nymaTwapMinutes, 30);
  // The documented pools are the ones the module reads.
  assert.equal(poolId(NYMA_ETH_POOL), "0x20be4118815ff481c1f5c16ce67a850dcdf0913978e13787c11d26594f98258f");
  assert.equal(poolId(ETH_USDG_POOL), "0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e");
  assert.equal(SWAP_TOPIC, "0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f");
});
