// Public display conversions only. Invoice settlement always uses its USD amount.
export function createRatesFeed({
  fetcher = fetch,
  clock = Date.now,
  ttl = 60000,
} = {}) {
  let cached,
    expires = 0,
    pending;
  return async () => {
    if (cached && clock() < expires) return cached;
    if (pending) return pending;
    pending = (async () => {
      const response = await fetcher(
        "https://api.coinbase.com/v2/exchange-rates?currency=USD",
        { signal: AbortSignal.timeout(8000) },
      );
      if (!response.ok) throw Error("Exchange rate source unavailable.");
      const body = await response.json();
      const rates = {};
      for (const currency of ["BTC", "ETH", "SOL", "USDT"]) {
        const raw = body?.data?.rates?.[currency];
        const value =
          typeof raw === "string" || typeof raw === "number"
            ? Number(raw)
            : NaN;
        if (!Number.isFinite(value) || value <= 0)
          throw Error("Invalid exchange rate.");
        rates[currency] = value;
      }
      cached = {
        rates,
        source: "Coinbase",
        updatedAt: new Date(clock()).toISOString(),
      };
      expires = clock() + ttl;
      return cached;
    })();
    try {
      return await pending;
    } finally {
      pending = null;
    }
  };
}
