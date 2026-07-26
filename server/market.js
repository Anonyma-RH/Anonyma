// Public market data only: no exchange account, trading, or API secret.
export const marketSymbols = ["BTC", "ETH", "BNB", "XRP", "SOL", "DOGE"];
export function createMarketFeed({
  fetcher = fetch,
  clock = Date.now,
  ttl = 30000,
} = {}) {
  let cached = null,
    expires = 0,
    pending = null;
  return async function marketFeed() {
    if (cached && clock() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const url = new URL("https://data-api.binance.vision/api/v3/ticker/24hr");
      url.searchParams.set(
        "symbols",
        JSON.stringify(marketSymbols.map((s) => s + "USDT")),
      );
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw Error("Market data temporarily unavailable.");
      const rows = await response.json();
      if (!Array.isArray(rows)) throw Error("Invalid market response.");
      const data = marketSymbols.map((symbol) => {
        const row = rows.find((r) => r.symbol === symbol + "USDT");
        const price = Number(row?.lastPrice),
          change24h = Number(row?.priceChangePercent);
        if (
          !Number.isFinite(price) ||
          price <= 0 ||
          !Number.isFinite(change24h)
        )
          throw Error("Incomplete market response.");
        return { symbol, price, change24h };
      });
      cached = {
        data,
        quote: "USDT",
        source: "Binance public market data",
        updatedAt: new Date(clock()).toISOString(),
      };
      expires = clock() + ttl;
      return cached;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}
