import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  api,
  claimWalletPayment,
  payWithWallet,
  readStore,
  saveStore,
  walletAvailable,
  walletSign,
} from "./lib.js";
import { Button, CopyButton, Icon, Notice } from "./ui.jsx";
import "./nyma-pay.css";

// NYMA top-ups exist only on Robinhood Chain (chain 4663), so its copy names
// the chain outright.
// Pay with NYMA (server/routes/nyma.js): ask for a quote, send the NYMA from
// your own wallet, then have the transaction credited. A sent hash is kept in
// this browser until it's credited, so closing the tab can't lose a payment.

// Refusals a later check can't change, so the saved hash is dropped.
const FINAL_ERRORS = [
  "payment_not_matched",
  "transaction_failed",
  "payment_already_claimed",
  "invalid_transaction",
  "wallet_payment_review",
];
const shortAddress = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
const fmt = (n, digits = 2) =>
  Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: digits });
const clock = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export const nymaPayAvailable = (config) =>
  !!(config?.nymaPayments && config?.walletPayments);

export default function NymaPayPanel({ config, user, demo, onChanged }) {
  const np = config?.nymaPayments;
  const wp = config?.walletPayments;
  const pendingKey = "nymaPending:" + (user?.id || "");
  const [usd, setUsd] = useState(10),
    [rate, setRate] = useState(null),
    [rateError, setRateError] = useState(""),
    [quote, setQuote] = useState(null),
    [left, setLeft] = useState(null),
    [clockNow, setClockNow] = useState(Date.now()),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [done, setDone] = useState(""),
    [pasted, setPasted] = useState("");
  const controller = useRef(null);
  const ready = !!np && !!wp && !!user && !demo;
  const pending = () => readStore(pendingKey, []);
  const forget = (txHash) =>
    saveStore(
      pendingKey,
      pending().filter((h) => h !== txHash),
    );

  function loadQuote() {
    return api("/api/nyma/quote")
      .then((r) => {
        setQuote(r.quote);
        setLeft(r.remainingTodayUsd);
      })
      .catch(() => {});
  }
  // The live rate, refreshed every minute while the panel is open.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const read = () =>
      api("/api/nyma/rate").then(
        (r) => alive && (setRate(r), setRateError("")),
        (e) => alive && (setRate(null), setRateError(e.message)),
      );
    read();
    loadQuote();
    const id = setInterval(read, 60000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [ready, user?.id]);
  // The quote's countdown.
  useEffect(() => {
    if (!quote) return;
    const id = setInterval(() => setClockNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [quote?.id]);
  useEffect(() => () => controller.current?.abort(), []);

  async function claim(txHash) {
    controller.current?.abort();
    controller.current = new AbortController();
    setStatus(`Checking your payment on ${wp.chainName}…`);
    try {
      const d = await claimWalletPayment(txHash, {
        path: "/api/nyma/claim",
        signal: controller.current.signal,
        onProgress: (r) =>
          setStatus(
            r.status === "confirming"
              ? `Confirming on ${wp.chainName}: ${r.confirmations} of ${r.required} blocks…`
              : `Waiting for the transaction to appear on ${wp.chainName}…`,
          ),
      });
      forget(txHash);
      setPasted("");
      setDone(
        `Payment confirmed. ${fmt(d.amount * 1000)} credits and ${fmt(d.payload?.bonus_credits)} bonus credits were added to your balance.`,
      );
      onChanged?.();
      loadQuote();
    } catch (e) {
      if (e.name === "AbortError") return;
      if (FINAL_ERRORS.includes(e.code)) forget(txHash);
      setError(e.message);
    } finally {
      setStatus("");
    }
  }
  async function run(task) {
    setError("");
    setDone("");
    setBusy(true);
    try {
      await task();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  // Finish payments sent before the page was closed.
  useEffect(() => {
    if (!ready || !user?.wallet || !pending().length) return;
    run(async () => {
      for (const txHash of pending()) await claim(txHash);
    });
  }, [ready, user?.id, user?.wallet]);

  if (!np || !wp) return null;
  const canSign = walletAvailable(config);
  const bonusPercent = Math.round(np.bonus * 1000) / 10;
  const open = quote && quote.expires > clockNow;
  const estimate =
    rate && Number(usd) > 0 ? Number(usd) / rate.usdPerNyma : 0;
  return (
    <section className="form-panel wallet-pay nyma-pay">
      <h2>Pay with NYMA</h2>
      <p className="fine-print">
        <Link to="/docs/billing">
          Read billing rules, fees and refund information before funding.
        </Link>
      </p>
      <div className="nyma-rate" aria-live="polite">
        <Icon name="coins" size={16} />
        <span>
          {rate
            ? `Rate now: 1,000,000 NYMA = ${fmt(rate.creditsPerMillion)} credits, plus a ${bonusPercent}% bonus.`
            : rateError || "Reading the NYMA rate on Robinhood Chain…"}
        </span>
      </div>
      <p className="fine-print">
        {`The rate is the lower of the current rate and its ${np.averageMinutes}-minute average on Robinhood Chain, so a sudden jump never raises it.`}
      </p>
      {!user?.wallet ? (
        <>
          <Notice>
            Link the wallet you'll pay from first. Payments are matched to your
            linked wallet, which is how they're credited automatically.
          </Notice>
          <Button
            type="button"
            disabled={demo || !user || busy || !canSign}
            title={canSign ? undefined : "No browser wallet found."}
            onClick={() =>
              run(async () => {
                await walletSign(config, true);
                onChanged?.();
              })
            }
          >
            {busy ? "Waiting for your wallet…" : "Link wallet"}
            <Icon name="arrow" />
          </Button>
        </>
      ) : open ? (
        <div className="nyma-quote">
          <div className="nyma-quote-head">
            <span>Your quote</span>
            <span className="nyma-timer">
              {`Valid for ${clock(quote.expires - clockNow)}`}
            </span>
          </div>
          <span className="nyma-quote-label">Send exactly</span>
          <div className="nyma-quote-amount">
            <b>{`${fmt(quote.nyma, 0)} NYMA`}</b>
            <CopyButton text={quote.nyma} label="Copy amount" />
          </div>
          <div className="funding-estimate">
            <span>You receive</span>
            <b>{`${fmt(quote.credits)} credits + ${fmt(quote.bonusCredits)} bonus`}</b>
          </div>
          <span className="nyma-quote-label">To this address</span>
          <div className="nyma-quote-address">
            <code data-i18n="off">{wp.address}</code>
            <CopyButton text={wp.address} label="Copy address" />
          </div>
          {canSign && (
            <Button
              type="button"
              disabled={busy || demo}
              onClick={() =>
                run(async () => {
                  setStatus("Confirm the payment in your wallet…");
                  let txHash;
                  try {
                    txHash = await payWithWallet(config, user.wallet, quote.nyma, {
                      token: np.token,
                      decimals: np.decimals,
                      symbol: np.symbol,
                    });
                  } finally {
                    setStatus("");
                  }
                  saveStore(pendingKey, [...new Set([...pending(), txHash])]);
                  await claim(txHash);
                })
              }
            >
              {busy ? "Waiting…" : `Send ${fmt(quote.nyma, 0)} NYMA from your wallet`}
              <Icon name="arrow" />
            </Button>
          )}
          <p className="fine-print">
            Less NYMA is credited proportionally and more is credited in full.
            A transfer after the quote ends gets the lower of the quoted and
            current rates.
          </p>
          <button
            type="button"
            className="small-button"
            disabled={busy}
            onClick={() => setQuote(null)}
          >
            New quote
          </button>
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const r = await api("/api/nyma/quote", {
                method: "POST",
                body: { usd: Number(usd) },
              });
              setQuote(r.quote);
              setLeft(r.remainingTodayUsd);
              setClockNow(Date.now());
            });
          }}
        >
          <label>
            Top-up value in USD
            <input
              type="number"
              min={np.minUsd}
              max={np.maxUsd}
              step="0.01"
              required
              value={usd}
              onChange={(e) => setUsd(e.target.value)}
            />
          </label>
          <div className="amount-shortcuts">
            {[5, 10, 25, 50]
              .filter((x) => x <= np.maxUsd)
              .map((x) => (
                <button
                  type="button"
                  className={Number(usd) === x ? "active" : ""}
                  key={x}
                  onClick={() => setUsd(x)}
                >
                  ${x}
                </button>
              ))}
          </div>
          <div className="funding-estimate">
            <span>You send about</span>
            <b>{rate ? `${fmt(estimate, 0)} NYMA` : "—"}</b>
          </div>
          <div className="funding-estimate nyma-receive">
            <span>You receive</span>
            <b>{`${fmt(Math.max(0, Number(usd)) * 1000)} credits + ${fmt(Math.max(0, Number(usd)) * 1000 * np.bonus)} bonus`}</b>
          </div>
          <Button disabled={busy || demo || !rate}>
            {busy ? "Waiting…" : "Get a quote"}
            <Icon name="arrow" />
          </Button>
          <p className="fine-print">
            <span>
              {`A quote holds the rate for ${np.quoteMinutes} minutes. Up to $${fmt(np.maxUsd)} per payment and $${fmt(np.dailyMaxUsd)} in 24 hours.`}
            </span>
            {left != null && left < np.dailyMaxUsd && (
              <>
                {" "}
                <span>{`$${fmt(Math.floor(left * 100) / 100)} left today.`}</span>
              </>
            )}
          </p>
        </form>
      )}
      {status && <Notice>{status}</Notice>}
      {done && <Notice>{done}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      {user?.wallet && (
        <details className="wallet-pay-manual" open={!!open && !canSign}>
          <summary>Already sent NYMA? Check a transaction</summary>
          <label>
            Transaction hash
            <input
              value={pasted}
              placeholder="0x…"
              spellCheck="false"
              autoComplete="off"
              onChange={(e) => setPasted(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="small-button"
            disabled={busy || demo || !pasted.trim()}
            onClick={() => run(() => claim(pasted.trim()))}
          >
            Check payment
          </button>
          <p className="fine-print">
            A transaction hash is public. Never paste a private key.
          </p>
        </details>
      )}
      <p className="nyma-own-wallet">
        <Icon name="lock" size={15} />
        <span>
          You send from your own wallet. ANONYMA never asks for your keys or
          seed phrase.
        </span>
      </p>
      {user?.wallet && (
        <p className="fine-print">
          {`Only NYMA on Robinhood Chain from your linked wallet ${shortAddress(user.wallet)} is credited automatically. You need a little ETH on Robinhood Chain for the network fee.`}
        </p>
      )}
    </section>
  );
}
