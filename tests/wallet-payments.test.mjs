import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { getAddress, id } from "ethers";
import { createApp } from "../server/app.js";
import { balance, config, now } from "../server/core.js";
import { formatTokenAmount, tokenCredits } from "../server/wallet-payments.js";

const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const PAY_TO = getAddress("0x00000000000000000000000000000000000000aa");
const ALICE_WALLET = getAddress("0x00000000000000000000000000000000000000a1");
const BOB_WALLET = getAddress("0x00000000000000000000000000000000000000b2");
const TRANSFER = id("Transfer(address,address,uint256)");
const topic = (address) =>
  "0x" + address.slice(2).toLowerCase().padStart(64, "0");
const word = (value) => "0x" + BigInt(value).toString(16).padStart(64, "0");
const hashOf = (n) => "0x" + n.toString(16).padStart(64, "0");

// A JSON-RPC node for chain 4663 whose receipts and head block tests control.
async function chain(t) {
  const state = {
    chainId: 4663,
    head: 1000,
    receipts: new Map(),
    time: now(),
    limited: 0,
    calls: 0,
  };
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const call = JSON.parse(raw);
    state.calls += 1;
    if (state.limited > 0) {
      state.limited -= 1;
      res.statusCode = 429;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: call.id,
          error: { code: -32005, message: "Too Many Requests" },
        }),
      );
    }
    const result = {
      eth_chainId: () => "0x" + state.chainId.toString(16),
      eth_blockNumber: () => "0x" + state.head.toString(16),
      eth_getTransactionReceipt: () =>
        state.receipts.get(call.params[0]) ?? null,
      eth_getBlockByNumber: () => ({
        number: call.params[0],
        timestamp: "0x" + Math.floor(state.time / 1000).toString(16),
      }),
    }[call.method]?.();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  state.url = `http://127.0.0.1:${server.address().port}`;
  // A receipt with one USDG transfer (6 decimals) unless overridden.
  state.pay = (
    hash,
    {
      from = ALICE_WALLET,
      to = PAY_TO,
      token = USDG,
      amount = 12_500_000n,
      block = 990,
      status = "0x1",
      logs,
    } = {},
  ) =>
    state.receipts.set(hash, {
      transactionHash: hash,
      status,
      blockNumber: "0x" + block.toString(16),
      logs: logs ?? [
        {
          address: token,
          topics: [TRANSFER, topic(from), topic(to)],
          data: word(amount),
          removed: false,
        },
      ],
    });
  return state;
}

function fixture(t, rpc, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-wallet-pay-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    walletPaymentAddress: PAY_TO,
    walletPaymentRpc: rpc,
    walletPaymentConfirmations: 3,
    walletPaymentRetryMs: 0,
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
const pay = (agent, txHash) =>
  agent.post("/api/deposits/wallet").send({ txHash });

test("a confirmed USDG transfer from the linked wallet is credited exactly once", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const bob = await register(svc, "bob", BOB_WALLET);
  const before = balance(svc.db, alice.user.id).total;
  node.pay(hashOf(1));

  const first = (await pay(alice.agent, hashOf(1)).expect(201)).body;
  assert.equal(first.credited, 1);
  assert.equal(first.status, "finished");
  assert.equal(first.amount, 12.5);
  assert.equal(first.currency, "usdg");
  assert.equal(first.payload.pay_amount, "12.5");
  assert.equal(first.payload.from_address, ALICE_WALLET);
  assert.equal(
    first.payload.explorer_url,
    `https://robinhoodchain.blockscout.com/tx/${hashOf(1)}`,
  );
  assert.equal(balance(svc.db, alice.user.id).total - before, 125_000_000);

  // Repeats return the same deposit, and nobody can claim it again.
  const again = (
    await pay(alice.agent, hashOf(1).toUpperCase().replace("0X", "0x")).expect(
      200,
    )
  ).body;
  assert.equal(again.id, first.id);
  assert.equal(
    (await pay(bob.agent, hashOf(1)).expect(409)).body.error.code,
    "payment_already_claimed",
  );
  assert.equal(balance(svc.db, alice.user.id).total - before, 125_000_000);
  const rows = svc.db
    .prepare("SELECT * FROM ledger WHERE kind='deposit'")
    .all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ref, `payment_wallet:4663:${hashOf(1)}`);

  // It shows in the deposit list and its detail read doesn't call a processor.
  const list = (await alice.agent.get("/api/deposits").expect(200)).body.data;
  assert.equal(list[0].id, first.id);
  assert.equal(
    (await alice.agent.get("/api/deposits/" + first.id).expect(200)).body
      .credited,
    1,
  );
});

test("concurrent 1 USDG claims credit only the paying account and expose its exact balance", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const bob = await register(svc, "bob", BOB_WALLET);
  const before = (await alice.agent.get("/api/me").expect(200)).body.user.balance;
  const bobBefore = (await bob.agent.get("/api/me").expect(200)).body.user.balance;
  node.pay(hashOf(20), { amount: 1_000_000n });
  const claims = await Promise.all([
    pay(alice.agent, hashOf(20)),
    pay(alice.agent, hashOf(20)),
  ]);
  assert.ok(claims.every((r) => [200, 201].includes(r.status)));
  assert.equal(claims[0].body.id, claims[1].body.id);
  assert.equal(claims[0].body.user_id, alice.user.id);
  assert.equal(claims[0].body.credited, 1);
  const after = (await alice.agent.get("/api/me").expect(200)).body.user;
  assert.equal(after.balance, before + 1000);
  assert.equal(after.available, after.balance);
  assert.equal(after.held, 0);
  const ledger = (await alice.agent.get("/api/account/ledger").expect(200)).body;
  const entries = ledger.data.filter((r) => r.ref === `payment_wallet:4663:${hashOf(20)}`);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].user_id, alice.user.id);
  assert.equal(entries[0].amount, 1000);
  assert.equal(ledger.balance.balance, after.balance);
  await bob.agent.get("/api/deposits/" + claims[0].body.id).expect(404);
  assert.equal((await bob.agent.get("/api/deposits").expect(200)).body.data.length, 0);
  assert.equal((await pay(bob.agent, hashOf(20)).expect(409)).body.error.code, "payment_already_claimed");
  assert.equal((await bob.agent.get("/api/me").expect(200)).body.user.balance, bobBefore);
});

test("a payment waits for confirmations before it is credited", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);

  // Not yet visible on the chain.
  let r = (await pay(alice.agent, hashOf(2)).expect(202)).body;
  assert.equal(r.status, "waiting");

  node.pay(hashOf(2), { block: 999 }); // head 1000: 2 of 3 confirmations
  r = (await pay(alice.agent, hashOf(2)).expect(202)).body;
  assert.deepEqual(
    [r.status, r.confirmations, r.required],
    ["confirming", 2, 3],
  );
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM deposits").get().n, 0);

  node.head = 1001;
  assert.equal(
    (await pay(alice.agent, hashOf(2)).expect(201)).body.credited,
    1,
  );
});

test("only the linked wallet's transfer of the right token to the payment address counts", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const before = balance(svc.db, alice.user.id).total;
  const code = async (hash) =>
    (await pay(alice.agent, hash).expect(400)).body.error.code;

  // Someone else's payment can't be claimed by pasting its hash.
  node.pay(hashOf(3), { from: BOB_WALLET });
  assert.equal(await code(hashOf(3)), "payment_not_matched");
  // A look-alike token contract, or a transfer to another address.
  node.pay(hashOf(4), {
    token: getAddress("0x00000000000000000000000000000000000000cc"),
  });
  assert.equal(await code(hashOf(4)), "payment_not_matched");
  node.pay(hashOf(5), { to: BOB_WALLET });
  assert.equal(await code(hashOf(5)), "payment_not_matched");
  // A reverted transaction moved nothing.
  node.pay(hashOf(6), { status: "0x0" });
  assert.equal(await code(hashOf(6)), "transaction_failed");
  // Malformed input never reaches the chain.
  assert.equal(await code("0x1234"), "invalid_transaction");

  assert.equal(balance(svc.db, alice.user.id).total, before);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM deposits").get().n, 0);
});

test("matching transfers in one transaction are summed; others in it are ignored", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const log = (from, to, amount, token = USDG) => ({
    address: token,
    topics: [TRANSFER, topic(from), topic(to)],
    data: word(amount),
  });
  node.pay(hashOf(7), {
    logs: [
      log(ALICE_WALLET, PAY_TO, 3_000_000n),
      log(ALICE_WALLET, BOB_WALLET, 50_000_000n),
      log(ALICE_WALLET, PAY_TO, 2_000_001n),
    ],
  });
  const r = (await pay(alice.agent, hashOf(7)).expect(201)).body;
  assert.equal(r.payload.pay_amount, "5.000001");
  assert.equal(r.amount, 5.000001);
});

test("old transfers, a missing wallet link, the wrong network and no configuration are refused", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  const carol = await register(svc, "carol");

  node.time = now() - 8 * 86400000;
  node.pay(hashOf(8));
  assert.equal(
    (await pay(alice.agent, hashOf(8)).expect(409)).body.error.code,
    "wallet_payment_review",
  );
  node.time = now();

  node.pay(hashOf(9));
  assert.equal(
    (await pay(carol.agent, hashOf(9)).expect(400)).body.error.code,
    "wallet_not_linked",
  );

  const wrong = await chain(t);
  wrong.chainId = 1;
  wrong.pay(hashOf(9));
  const other = fixture(t, wrong.url);
  const erin = await register(other, "erin", ALICE_WALLET);
  assert.equal(
    (await pay(erin.agent, hashOf(9)).expect(503)).body.error.code,
    "chain_unavailable",
  );
  assert.equal(other.db.prepare("SELECT COUNT(*) n FROM deposits").get().n, 0);

  const off = fixture(t, node.url, { walletPaymentAddress: "" });
  const dave = await register(off, "dave", ALICE_WALLET);
  assert.equal(
    (await pay(dave.agent, hashOf(9)).expect(503)).body.error.code,
    "wallet_payments_unconfigured",
  );
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM deposits").get().n, 0);
});

test("a rate-limited node is retried once, then reported as unavailable", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const alice = await register(svc, "alice", ALICE_WALLET);
  node.pay(hashOf(11));
  node.limited = 1;
  assert.equal(
    (await pay(alice.agent, hashOf(11)).expect(201)).body.credited,
    1,
  );
  node.pay(hashOf(12));
  node.limited = 2;
  assert.equal(
    (await pay(alice.agent, hashOf(12)).expect(503)).body.error.code,
    "chain_unavailable",
  );
  assert.equal(
    (await pay(alice.agent, hashOf(12)).expect(201)).body.credited,
    1,
  );
});

test("a referred account's wallet payment rewards the referrer", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url, { referralPercent: 5 });
  const alice = await register(svc, "alice");
  const bob = await register(svc, "bob", BOB_WALLET);
  svc.db
    .prepare("UPDATE users SET referred_by=? WHERE id=?")
    .run(alice.user.id, bob.user.id);
  node.pay(hashOf(10), { from: BOB_WALLET, amount: 20_000_000n });
  await pay(bob.agent, hashOf(10)).expect(201);
  const reward = svc.db
    .prepare("SELECT * FROM ledger WHERE user_id=? AND kind='referral'")
    .get(alice.user.id);
  assert.equal(reward.amount, 10_000_000); // 5% of $20
});

test("the public config describes wallet payments without exposing the server RPC", async (t) => {
  const node = await chain(t);
  const svc = fixture(t, node.url);
  const body = (await request(svc.app).get("/api/config").expect(200)).body;
  assert.equal(body.services.walletPayments, true);
  assert.deepEqual(body.walletPayments, {
    address: PAY_TO,
    chainId: 4663,
    chainName: "Robinhood Chain",
    publicRpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: "https://robinhoodchain.blockscout.com",
    token: USDG,
    symbol: "USDG",
    decimals: 6,
    confirmations: 3,
  });
  assert.ok(!JSON.stringify(body).includes(node.url));
});

test("token amounts convert to whole subcredits, rounding down", () => {
  assert.equal(tokenCredits(1_000_000n, 6), 10_000_000);
  assert.equal(tokenCredits(1n, 6), 10);
  assert.equal(tokenCredits(10n ** 18n, 18), 10_000_000);
  assert.equal(tokenCredits(10n ** 11n - 1n, 18), 0);
  assert.equal(formatTokenAmount(12_500_000n, 6), "12.5");
  assert.equal(formatTokenAmount(7n, 6), "0.000007");
  assert.equal(formatTokenAmount(3_000_000n, 6), "3");
});

test("wallet payment settings are validated", () => {
  assert.throws(
    () => config({ walletPaymentAddress: "0x123" }),
    /walletPaymentAddress/,
  );
  assert.throws(
    () => config({ walletPaymentConfirmations: 0 }),
    /confirmations/,
  );
  assert.throws(
    () => config({ walletPaymentRpc: "ftp://node" }),
    /walletPaymentRpc/,
  );
  assert.equal(config({}).walletPaymentChain, 4663);
});
