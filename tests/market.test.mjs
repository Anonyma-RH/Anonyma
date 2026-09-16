import test from "node:test";
import assert from "node:assert/strict";
import { createMarketFeed, marketSymbols } from "../server/market.js";
test("market feed normalizes six prices, coalesces requests, caches, and refuses invalid refreshes", async () => {
  let calls = 0,
    time = 0,
    invalid = false;
  const feed = createMarketFeed({
    clock: () => time,
    ttl: 30,
    fetcher: async (url) => {
      calls++;
      assert.equal(new URL(url).hostname, "data-api.binance.vision");
      return {
        ok: true,
        json: async () =>
          marketSymbols.map((s) => ({
            symbol: s + "USDT",
            lastPrice: invalid ? "NaN" : "100",
            priceChangePercent: "-1.25",
          })),
      };
    },
  });
  const [a, b] = await Promise.all([feed(), feed()]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(a.data.length, 6);
  assert.equal(a.data[0].price, 100);
  assert.equal(a.data[0].change24h, -1.25);
  await feed();
  assert.equal(calls, 1);
  time = 31;
  invalid = true;
  await assert.rejects(feed(), /Incomplete/);
  invalid = false;
  await feed();
  assert.equal(calls, 3);
});
