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
import { Button, Notice, CopyButton, Icon } from "./ui.jsx";

// Refusals that a later check can't change, so the saved hash is dropped.
const FINAL_WALLET_ERRORS = [
  "payment_not_matched",
  "transaction_failed",
  "payment_already_claimed",
  "invalid_transaction",
  "wallet_payment_review",
];
const shortAddress = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");

// Pay with the configured stablecoin from the linked wallet. The server
// credits the transaction once the chain confirms it; a sent hash is kept in
// this browser until then, so closing the tab can't lose a payment.
export function WalletPayPanel({ config, user, demo, onChanged }) {
  const wp = config?.walletPayments;
  const pendingKey = "walletPending:" + (user?.id || "");
  const [amount, setAmount] = useState(10),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [error, setError] = useState(""),
    [done, setDone] = useState(""),
    [pasted, setPasted] = useState("");
  const controller = useRef(null);
  const pending = () => readStore(pendingKey, []);
  const forget = (txHash) =>
    saveStore(
      pendingKey,
      pending().filter((h) => h !== txHash),
    );
  useEffect(() => () => controller.current?.abort(), []);

  async function claim(txHash) {
    controller.current?.abort();
    controller.current = new AbortController();
    setStatus(`Checking your payment on ${wp.chainName}…`);
    try {
      const d = await claimWalletPayment(txHash, {
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
      setDone(`Payment confirmed. $${d.amount} was added to your balance.`);
      onChanged?.();
    } catch (e) {
      if (e.name === "AbortError") return;
      if (FINAL_WALLET_ERRORS.includes(e.code)) forget(txHash);
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
    if (!wp || !user?.wallet || demo || !pending().length) return;
    run(async () => {
      for (const txHash of pending()) await claim(txHash);
    });
  }, [wp?.address, user?.id, user?.wallet]);

  if (!wp) return null;
  const canSign = walletAvailable(config);
  return (
    <form
      className="form-panel wallet-pay"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          setStatus("Confirm the payment in your wallet…");
          let txHash;
          try {
            txHash = await payWithWallet(config, user.wallet, amount);
          } finally {
            setStatus("");
          }
          saveStore(pendingKey, [...new Set([...pending(), txHash])]);
          await claim(txHash);
        });
      }}
    >
      <h2>Pay with {wp.symbol}</h2>
      <p className="fine-print"><Link to="/docs/billing">Read billing rules, fees and refund information before funding.</Link></p>
      <p>
        1 {wp.symbol} = $1 = 1,000 credits, on {wp.chainName}. Credited
        automatically after the transfer is verified. Confirmation times can vary.
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
          {error && <Notice type="error">{error}</Notice>}
        </>
      ) : (
        <>
          <label>
            Amount in {wp.symbol}
            <input
              type="number"
              min="1"
              max="10000"
              step="0.01"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <div className="amount-shortcuts">
            {[5, 10, 25, 50].map((x) => (
              <button
                type="button"
                className={Number(amount) === x ? "active" : ""}
                key={x}
                onClick={() => setAmount(x)}
              >
                ${x}
              </button>
            ))}
          </div>
          <div className="funding-estimate">
            <span>You receive</span>
            <b>
              {(Math.max(0, Number(amount)) * 1000).toLocaleString()} credits
            </b>
          </div>
          <Button disabled={busy || demo || !canSign}>
            {busy ? "Waiting…" : `Pay ${amount} ${wp.symbol}`}
            <Icon name="arrow" />
          </Button>
          {status && <Notice>{status}</Notice>}
          {done && <Notice>{done}</Notice>}
          {error && <Notice type="error">{error}</Notice>}
          <p className="fine-print">
            {canSign
              ? `Sent from your linked wallet ${shortAddress(user.wallet)}.`
              : `No browser wallet found here. Send ${wp.symbol} from your linked wallet ${shortAddress(user.wallet)} to the address below, then paste the transaction hash.`}{" "}
            You need a little ETH on {wp.chainName} for the network fee. Only{" "}
            {wp.symbol} on {wp.chainName} is credited automatically.
          </p>
          <details className="wallet-pay-manual" open={!canSign}>
            <summary>Already sent {wp.symbol}? Check a transaction</summary>
            <p className="fine-print">
              Payment address <code>{wp.address}</code>
            </p>
            <CopyButton text={wp.address} label="Copy address" />
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
          </details>
        </>
      )}
    </form>
  );
}
export function EmailLink({ onDone }) {
  const [challenge, setChallenge] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function submit(e) {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      if (!challenge) {
        setChallenge(
          await api("/api/auth/email/send", {
            method: "POST",
            body: { email: fields.email, purpose: "link" },
          }),
        );
      } else {
        await api("/api/auth/email/verify", {
          method: "POST",
          body: { id: challenge.id, code: fields.code },
        });
        onDone();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit}>
      <p className="fine-print">
        Link a verified email to your current account. A code is valid for ten
        minutes.
      </p>
      {challenge ? (
        <label>
          Verification code
          <input
            name="code"
            required
            pattern="[0-9]{6}"
            inputMode="numeric"
            maxLength="6"
            autoComplete="one-time-code"
          />
        </label>
      ) : (
        <label>
          Email address
          <input
            name="email"
            type="email"
            required
            autoComplete="email"
            placeholder="you@example.com"
          />
        </label>
      )}
      {error && <Notice type="error">{error}</Notice>}
      <Button disabled={busy}>
        {busy
          ? "Please wait…"
          : challenge
            ? "Verify & link"
            : "Send verification code"}
      </Button>
    </form>
  );
}
export function InvoiceDetails({ initial, onCredited }) {
  const [invoice, setInvoice] = useState(initial),
    [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    let id;
    async function poll() {
      try {
        const r = await api("/api/deposits/" + initial.id);
        if (!alive) return;
        setInvoice(r);
        if (r.credited) {
          onCredited();
          return;
        }
        if (!["failed", "expired", "refunded", "finished"].includes(r.status))
          id = setTimeout(poll, 15000);
      } catch (e) {
        if (alive) {
          setError(e.message);
          id = setTimeout(poll, 15000);
        }
      }
    }
    poll();
    return () => {
      alive = false;
      clearTimeout(id);
    };
  }, [initial.id]);
  const p = invoice.payload || invoice;
  return (
    <div className="invoice-details">
      <Notice>
        {invoice.credited
          ? "Payment verified. Your account balance has been refreshed."
          : `Payment status: ${invoice.status || "creating"}. Credits are pending until the service confirms settlement.`}
      </Notice>
      <dl>
        <dt>Invoice</dt>
        <dd>{invoice.id}</dd>
        <dt>Invoice value</dt>
        <dd>${invoice.amount} USD</dd>
        <dt>Currency / network</dt>
        <dd>{p.pay_currency || "Waiting for processor"}</dd>
        <dt>Exact payment amount</dt>
        <dd>{p.pay_amount ?? "Waiting for processor"}</dd>
        {p.bonus_credits != null && (
          <>
            <dt>Bonus credits</dt>
            <dd>{p.bonus_credits.toLocaleString()}</dd>
          </>
        )}
        <dt>Payment address</dt>
        <dd>{p.pay_address || "No address returned yet"}</dd>
        {p.tx_hash && (
          <>
            <dt>Transaction</dt>
            <dd>
              {p.explorer_url ? (
                <a href={p.explorer_url} target="_blank" rel="noreferrer">
                  {p.tx_hash}
                </a>
              ) : (
                p.tx_hash
              )}
            </dd>
          </>
        )}
      </dl>
      {p.pay_address && (
        <CopyButton text={p.pay_address} label="Copy payment address" />
      )}
      {p.expiration_estimate_date && (
        <p className="fine-print">
          Expires: {new Date(p.expiration_estimate_date).toLocaleString()}
        </p>
      )}
      {error && (
        <Notice type="error">
          {error} Status will be checked again. Do not create a duplicate
          payment.
        </Notice>
      )}
      {!p.tx_hash && (
        <p className="fine-print">
          Use only the exact network, address and amount returned for this
          invoice. Closing this dialog does not cancel the invoice.
        </p>
      )}
    </div>
  );
}
