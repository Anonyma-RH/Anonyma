import test from "node:test";
import assert from "node:assert/strict";
import { createRatesFeed } from "../server/rates.js";
test("exchange rates coalesce concurrent calls, cache briefly, and reject corrupt upstream prices", async () => {
  let calls = 0,
    clock = 1000,
    invalid = false;
  const feed = createRatesFeed({
    clock: () => clock,
    ttl: 100,
    fetcher: async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({
          data: {
            rates: {
              BTC: invalid ? "Infinity" : "0.00001",
              ETH: "0.0002",
              SOL: "0.01",
              USDT: "1",
            },
          },
        }),
      };
    },
  });
  const first = await Promise.all([feed(), feed(), feed()]);
  assert.equal(calls, 1);
  assert.equal(first[0].rates.BTC, 0.00001);
  await feed();
  assert.equal(calls, 1);
  clock += 101;
  invalid = true;
  await assert.rejects(feed(), /Invalid exchange rate/);
  invalid = false;
  await feed();
  assert.equal(calls, 3);
});
