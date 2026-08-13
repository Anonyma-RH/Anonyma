import React, { useEffect, useState } from "react";
import { api } from "./lib";
export function LiveMarket() {
  const [feed, setFeed] = useState(null),
    [error, setError] = useState(false);
  useEffect(() => {
    let stopped = false;
    async function refresh() {
      try {
        const next = await api("/api/market");
        if (!stopped) {
          setFeed(next);
          setError(false);
        }
      } catch {
        if (!stopped) setError(true);
      }
    }
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);
  return (
    <section
      className="market-strip"
      aria-label="Live cryptocurrency prices"
      title={
        feed
          ? `${feed.source} · USDT · ${new Date(feed.updatedAt).toLocaleTimeString()}`
          : "Loading market prices"
      }
    >
      {(
        feed?.data ||
        ["BTC", "ETH", "BNB", "XRP", "SOL", "DOGE"].map((symbol) => ({
          symbol,
        }))
      ).map((row) => (
        <div
          className="market-coin"
          key={row.symbol}
          aria-label={`${row.symbol} price in USDT`}
        >
          <span className={`coin-mark coin-${row.symbol.toLowerCase()}`}>
            <img
              src={`/assets/providers/${row.symbol.toLowerCase()}.svg`}
              alt={row.symbol}
            />
          </span>
          <span>
            {row.price
              ? row.price.toLocaleString("en-US", {
                  maximumFractionDigits: row.price < 1 ? 4 : 2,
                })
              : "—"}
          </span>
          <small className={row.change24h >= 0 ? "positive" : "negative"}>
            {row.change24h == null
              ? ""
              : `${row.change24h > 0 ? "+" : ""}${row.change24h.toFixed(2)}%`}
          </small>
        </div>
      ))}
      {error && (
        <small className="market-unavailable" role="status">
          {feed
            ? "Price updates unavailable · last received values"
            : "Market prices unavailable"}
        </small>
      )}
    </section>
  );
}
