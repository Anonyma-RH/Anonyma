import React, { useEffect, useState } from "react";
import { api } from "./lib.js";
import { Button, Notice, CopyButton, Icon } from "./ui.jsx";
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
        <dt>Payment address</dt>
        <dd>{p.pay_address || "No address returned yet"}</dd>
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
      <p className="fine-print">
        Use only the exact network, address and amount returned for this
        invoice. Closing this dialog does not cancel the invoice.
      </p>
    </div>
  );
}
