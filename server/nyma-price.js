import { AbiCoder, getAddress, id, keccak256 } from "ethers";
import { UNITS, fail, now } from "./core.js";
import { rpc } from "./wallet-payments.js";

// The NYMA rate for Pay with NYMA: what one NYMA is worth in USD, read only
// from Robinhood Chain (chain 4663) through the server's own node, so a
// top-up never depends on a third-party price feed. Nothing here signs or
// sends anything.
//
// Source (read-only RPC research, 25 Sep 2026):
// - NYMA's main pool is a Uniswap v4 pool on the chain's v4 PoolManager
//   (POOL_MANAGER): native ETH / NYMA, fee 0, tick spacing 200, with the hook
//   below (it takes its fee after each swap). Pool id 0x20be4118…258f. About
//   8.8 ETH and 98M NYMA in range, and roughly 115 swaps an hour. Every other
//   NYMA pool on the PoolManager was a fraction of that (0.25 ETH or less in
//   range, most at 80-90% fees), and there is no v2 or v3 NYMA pool.
// - ETH/USD comes from the deepest ETH / USDG pool on the same PoolManager
//   (fee 0.01%, tick spacing 1, no hook, pool id 0x24107d15…3b66: about
//   1,550 ETH and $4.2M USDG in range). USDG counts as $1, as it does for
//   USDG top-ups.
//
// How the rate resists manipulation:
// - v4 pools have no built-in oracle (no observe()), and the NYMA pool's hook
//   has none either. So the server rebuilds a time-weighted average from the
//   pools' own Swap events: every price change with its block, over a window
//   of at least NYMA_TWAP_MINUTES (default 30), with block times from the
//   chain (block headers at the window's ends and at five points between,
//   interpolated in between). The average is taken in ticks (log price), like
//   a Uniswap v3 TWAP.
// - The rate used is the lower of the current (spot) value and that average,
//   for NYMA/ETH and ETH/USD alike, so a spike never raises it: pushing the
//   average up takes holding the pool's price up for the whole window.
// - If either pool's spot is more than NYMA_PRICE_MAX_DEVIATION (default
//   10%) from its average, if the NYMA pool has less than NYMA_MIN_POOL_ETH
//   (default 2 ETH) in range, or if the data is missing or inconsistent,
//   there is no rate, and quotes and late top-ups are refused.

export const ETH = "0x0000000000000000000000000000000000000000";
export const NYMA_CONTRACT = getAddress(
  "0x968be0c1a394bf1ce239e3b40909ec0f9d4f5583",
);
export const USDG_CONTRACT = getAddress(
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
);
// Uniswap v4's singleton PoolManager on Robinhood Chain.
export const POOL_MANAGER = getAddress(
  "0x8366a39cc670b4001a1121b8f6a443a643e40951",
);
export const NYMA_ETH_POOL = {
  currency0: ETH,
  currency1: NYMA_CONTRACT,
  fee: 0,
  tickSpacing: 200,
  hooks: getAddress("0xe5e702641ea86f4ae6cc3cdaed2b886f976be044"),
};
export const ETH_USDG_POOL = {
  currency0: ETH,
  currency1: USDG_CONTRACT,
  fee: 100,
  tickSpacing: 1,
  hooks: ETH,
};
const NYMA_DECIMALS = 18;
const USDG_DECIMALS = 6;
// The ETH/USDG pool must keep at least this much ETH in range.
const MIN_USD_POOL_ETH = 50n;
// A rate is subcredits per whole NYMA, times RATE_SCALE, as a BigInt.
export const RATE_SCALE = 10n ** 12n;
const WEI = 10n ** 18n;

const abi = AbiCoder.defaultAbiCoder();
export const poolId = (key) =>
  keccak256(
    abi.encode(
      ["address", "address", "uint24", "int24", "address"],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
export const SWAP_TOPIC = id(
  "Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)",
);
// StateLibrary: pools live at keccak256(poolId, 6); slot0 first, liquidity
// three slots on. extsload(bytes32) reads a slot.
const POOLS_SLOT = 6n;
const EXTSLOAD = "0x1e2eaeaf";
const hex = (n) => "0x" + n.toString(16);
const word = (n) => n.toString(16).padStart(64, "0");
const int24 = (v) => {
  const n = Number(v & 0xffffffn);
  return n >= 0x800000 ? n - 0x1000000 : n;
};

async function readPool(cfg, key, blockTag) {
  const slot = BigInt(
    keccak256(abi.encode(["bytes32", "uint256"], [poolId(key), POOLS_SLOT])),
  );
  const load = async (s) =>
    BigInt(
      await rpc(cfg, "eth_call", [
        { to: POOL_MANAGER, data: EXTSLOAD + word(s) },
        blockTag,
      ]),
    );
  const slot0 = await load(slot);
  const liquidity = (await load(slot + 3n)) & ((1n << 128n) - 1n);
  const sqrtPriceX96 = slot0 & ((1n << 160n) - 1n);
  if (!sqrtPriceX96) throw Error("pool not initialized");
  return { tick: int24(slot0 >> 160n), sqrtPriceX96, liquidity };
}

async function header(cfg, number) {
  const block = await rpc(cfg, "eth_getBlockByNumber", [hex(number), false]);
  const time = Number(block?.timestamp);
  if (!(time > 0)) throw Error("incomplete block");
  return { number, time };
}

// Swap events for the given pools, oldest first.
async function swaps(cfg, ids, from, to) {
  if (to < from) return [];
  const logs = await rpc(cfg, "eth_getLogs", [
    {
      address: POOL_MANAGER,
      topics: [SWAP_TOPIC, ids],
      fromBlock: hex(from),
      toBlock: hex(to),
    },
  ]);
  if (!Array.isArray(logs)) throw Error("no logs");
  return logs
    .filter((l) => !l?.removed && String(l.address).toLowerCase() === POOL_MANAGER.toLowerCase())
    .map((l) => {
      const data = String(l.data || "");
      // amount0, amount1, sqrtPriceX96, liquidity, tick, fee.
      if (!/^0x[0-9a-fA-F]{384}$/.test(data)) throw Error("malformed swap");
      return {
        pool: String(l.topics?.[1]).toLowerCase(),
        block: Number(l.blockNumber),
        index: Number(l.logIndex),
        tick: int24(BigInt("0x" + data.slice(2 + 64 * 4, 2 + 64 * 5))),
      };
    })
    .sort((a, b) => a.block - b.block || a.index - b.index);
}

// The window's first and last blocks, at least `seconds` apart, and a
// block -> time map interpolated between seven headers.
async function window(cfg, head, seconds, state) {
  const top = await header(cfg, head);
  let rate = state.blockRate || 4;
  let start = Math.max(1, head - Math.ceil(seconds * rate * 1.02) - 1);
  let first = await header(cfg, start);
  for (let i = 0; first.time > top.time - seconds; i++) {
    if (i >= 6 || start <= 1) throw Error("chain history too short");
    const observed = (head - start) / Math.max(1, top.time - first.time);
    if (observed > 0) rate = observed;
    const missing = first.time - (top.time - seconds);
    start = Math.max(1, start - Math.ceil(missing * rate * 1.1) - 1);
    first = await header(cfg, start);
  }
  state.blockRate = (head - start) / Math.max(1, top.time - first.time);
  const points = [first];
  for (let k = 1; k < 6; k++) {
    const n = start + Math.round((k * (head - start)) / 6);
    if (n > points.at(-1).number && n < head) points.push(await header(cfg, n));
  }
  points.push(top);
  // Block times never go backwards.
  for (let i = 1; i < points.length; i++)
    points[i].time = Math.max(points[i].time, points[i - 1].time);
  const at = (block) => {
    let i = 1;
    while (i < points.length - 1 && points[i].number < block) i++;
    const a = points[i - 1],
      b = points[i];
    if (b.number === a.number) return b.time;
    const f = Math.min(1, Math.max(0, (block - a.number) / (b.number - a.number)));
    return a.time + f * (b.time - a.time);
  };
  return { start, t0: first.time, t1: top.time, at };
}

// Time-weighted average tick over [t0, t1], from the tick before the window
// and each swap's resulting tick.
export function averageTick(logs, before, at, t0, t1) {
  let tick = before,
    cursor = t0,
    area = 0;
  for (const l of logs) {
    const t = Math.min(t1, Math.max(cursor, at(l.block)));
    area += tick * (t - cursor);
    cursor = t;
    tick = l.tick;
  }
  area += tick * (t1 - cursor);
  return { average: area / (t1 - t0), last: tick };
}

// The last tick before `start`, looking back up to 16 windows.
async function tickBefore(cfg, pool, start, span) {
  let to = start - 1;
  for (const m of [1, 3, 12]) {
    const from = Math.max(0, to - span * m + 1);
    const logs = await swaps(cfg, [pool], from, to);
    if (logs.length) return logs.at(-1).tick;
    if (from === 0) break;
    to = from - 1;
  }
  throw Error("no recent swaps before the window");
}

const tickPrice = (ticks) => Math.pow(1.0001, ticks);

// Measures the rate now. Throws when there's no trustworthy rate.
async function measure(cfg, state) {
  const seconds = cfg.nymaTwapMinutes * 60;
  // A few blocks behind the tip, so its logs are surely indexed.
  const head = Number(await rpc(cfg, "eth_blockNumber", [])) - 2;
  if (!(head > 0)) throw Error("no head block");
  const tag = hex(head);
  const legs = [
    // NYMA in ETH: the tick prices currency0 in currency1.
    { key: NYMA_ETH_POOL, sign: NYMA_ETH_POOL.currency1 === NYMA_CONTRACT ? -1 : 1 },
    // ETH in USDG.
    { key: ETH_USDG_POOL, sign: ETH_USDG_POOL.currency0 === ETH ? 1 : -1 },
  ].map((leg) => ({ ...leg, id: poolId(leg.key).toLowerCase() }));
  const span = await window(cfg, head, seconds, state);
  const logs = await swaps(cfg, legs.map((l) => l.id), span.start, head);
  const maxTicks = Math.log(1 + cfg.nymaMaxDeviation) / Math.log(1.0001);
  for (const leg of legs) {
    leg.state = await readPool(cfg, leg.key, tag);
    leg.logs = logs.filter((l) => l.pool === leg.id);
    const before = leg.logs.length
      ? await tickBefore(cfg, leg.id, span.start, head - span.start + 1)
      : leg.state.tick;
    const { average, last } = averageTick(leg.logs, before, span.at, span.t0, span.t1);
    if (last !== leg.state.tick) throw Error("swap history doesn't match the pool");
    if (Math.abs(leg.state.tick - average) > maxTicks)
      throw Error("spot is too far from the average");
    leg.average = average;
  }
  // In-range ETH: amount0 = L / sqrtP, amount1 = L * sqrtP.
  const inRangeEth = ({ key, state }) =>
    key.currency0 === ETH
      ? (state.liquidity << 96n) / state.sqrtPriceX96
      : (state.liquidity * state.sqrtPriceX96) >> 96n;
  const minEth = BigInt(Math.round(cfg.nymaMinPoolEth * 1e6)) * 10n ** 12n;
  if (inRangeEth(legs[0]) < minEth) throw Error("too little NYMA in range");
  if (inRangeEth(legs[1]) < MIN_USD_POOL_ETH * WEI)
    throw Error("too little ETH/USDG in range");
  // USD per whole NYMA: NYMA in ETH times ETH in USDG, in raw units, then
  // scaled by the decimals.
  const decimals = Math.pow(10, NYMA_DECIMALS - USDG_DECIMALS);
  const usd = (pick) =>
    tickPrice(legs.reduce((sum, leg) => sum + leg.sign * pick(leg), 0)) * decimals;
  const spot = usd((leg) => leg.state.tick);
  const average = usd((leg) => leg.average);
  const usdPerNyma = Math.min(spot, average);
  if (!(usdPerNyma > 0) || !Number.isFinite(usdPerNyma))
    throw Error("no usable rate");
  const rate = BigInt(Math.floor(usdPerNyma * UNITS * Number(RATE_SCALE)));
  if (rate <= 0n) throw Error("rate rounds to zero");
  return {
    rate,
    usdPerNyma,
    spotUsdPerNyma: spot,
    averageUsdPerNyma: average,
    windowSeconds: span.t1 - span.t0,
    block: head,
    time: span.t1 * 1000,
    swaps: legs[0].logs.length,
    measured: now(),
  };
}

export const RATE_UNAVAILABLE =
  "There's no reliable NYMA rate right now, so NYMA top-ups are paused. Try again in a few minutes, or pay with USDG.";
const states = new WeakMap();
// The current rate, measured at most once per NYMA_RATE_TTL_MS (default
// 30 seconds) and shared by concurrent requests. Fails with 503
// nyma_rate_unavailable when there's no trustworthy rate.
export async function nymaRate(cfg) {
  let state = states.get(cfg);
  if (!state) states.set(cfg, (state = {}));
  const ttl = cfg.nymaRateTtlMs ?? 30000;
  if (state.value && now() - state.at < ttl) return state.value;
  if (state.failed && now() - state.at < Math.min(ttl, 15000))
    fail(503, RATE_UNAVAILABLE, "nyma_rate_unavailable");
  state.pending ??= measure(cfg, state)
    .then(
      (value) => {
        Object.assign(state, { value, failed: false, at: now() });
        return value;
      },
      (e) => {
        Object.assign(state, { value: null, failed: true, at: now() });
        // Never logs the node URL, which may carry a provider key.
        console.error(`NYMA rate unavailable: ${e.message}`);
        fail(503, RATE_UNAVAILABLE, "nyma_rate_unavailable");
      },
    )
    .finally(() => (state.pending = null));
  return state.pending;
}

// Subcredits for an amount of NYMA (base units) at a rate, rounded down.
export const creditsAt = (value, rate) => (value * rate) / (WEI * RATE_SCALE);
// The whole NYMA to send for at least `units` subcredits at a rate.
export function nymaFor(units, rate) {
  const wei = (BigInt(units) * WEI * RATE_SCALE + rate - 1n) / rate;
  return ((wei + WEI - 1n) / WEI) * WEI;
}
