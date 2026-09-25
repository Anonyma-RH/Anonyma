import React, { useState } from "react";
import { Icon, Button, Modal, Notice } from "./ui.jsx";
import { api } from "./lib.js";
import "./allowances.css";

// A budgeted agent credential built on top of a regular API key: a lifetime
// credit allowance, an optional expiry and a pause switch. Mounted per key in
// the keys section of Account.jsx. In demo mode nothing is sent to the
// server; `onChange` receives a local patch instead of triggering a refetch.
export function KeyAllowance({ k, demo, onChange }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [creditsInput, setCreditsInput] = useState(k.allowance_total ?? "");

  const total = k.allowance_total;
  const spent = Number(k.allowance_spent || 0);
  const remaining =
    k.allowance_remaining != null
      ? Number(k.allowance_remaining)
      : total == null
        ? null
        : Math.max(0, total - spent);
  const pct = total ? Math.min(100, (spent / total) * 100) : 0;
  const expired = k.expires_at != null && k.expires_at <= Date.now();

  async function save(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    const total_credits =
      data.total_credits === "" ? null : Number(data.total_credits);
    const expires_at = data.expires_at
      ? new Date(data.expires_at + "T23:59:59").getTime()
      : null;
    const label = data.label.trim() || null;
    setBusy(true);
    setError("");
    try {
      if (demo) {
        onChange({
          allowance_total: total_credits,
          allowance_spent: k.allowance_spent || 0,
          allowance_remaining: total_credits,
          expires_at,
          label,
        });
      } else {
        await api(`/api/keys/${k.id}/allowance`, {
          method: "PATCH",
          body: { total_credits, expires_at, label },
        });
        onChange();
      }
      setOpen(false);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function togglePause() {
    setBusy(true);
    setError("");
    try {
      if (demo) onChange({ paused: !k.paused });
      else {
        await api(`/api/keys/${k.id}/${k.paused ? "resume" : "pause"}`, {
          method: "POST",
        });
        onChange();
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="key-allowance">
      {total != null ? (
        <>
          <div
            className="allowance-bar"
            role="img"
            aria-label={`${spent.toLocaleString()} of ${total.toLocaleString()} credits used`}
          >
            <div
              className="allowance-bar-fill"
              style={{ width: pct + "%" }}
            />
          </div>
          <p className="allowance-figures">
            {spent.toLocaleString()} / {total.toLocaleString()} credits
            <span className="allowance-remaining">
              {" "}
              · {remaining.toLocaleString()} left
            </span>
          </p>
        </>
      ) : (
        <p className="allowance-figures muted">No allowance set</p>
      )}
      <div className="allowance-meta">
        {k.label && <span className="allowance-tag">{k.label}</span>}
        {k.expires_at != null && (
          <span className={"allowance-tag" + (expired ? " expired" : "")}>
            {expired ? "Expired" : "Expires"}{" "}
            {new Date(k.expires_at).toLocaleDateString()}
          </span>
        )}
        {k.paused && <span className="allowance-tag paused">Paused</span>}
      </div>
      <div className="allowance-actions">
        <button
          type="button"
          className="small-button"
          disabled={busy}
          onClick={() => {
            setCreditsInput(k.allowance_total ?? "");
            setOpen(true);
          }}
        >
          Set allowance
        </button>
        <button
          type="button"
          className="small-button"
          disabled={busy}
          onClick={togglePause}
        >
          <Icon name={k.paused ? "play" : "pause"} size={13} />
          {k.paused ? "Resume" : "Pause"}
        </button>
      </div>
      {error && <Notice type="error">{error}</Notice>}
      {open && (
        <Modal title="Set an allowance." onClose={() => setOpen(false)}>
          <form onSubmit={save}>
            <label>
              Agent name
              <input
                name="label"
                defaultValue={k.label || ""}
                maxLength="60"
                placeholder="e.g. Research agent"
              />
            </label>
            <label>
              Lifetime allowance (credits)
              <input
                name="total_credits"
                type="number"
                min="0"
                step="1"
                value={creditsInput}
                onChange={(e) => setCreditsInput(e.target.value)}
                placeholder="Leave blank to remove the allowance"
              />
            </label>
            <p className="fine-print">
              {creditsInput === ""
                ? "1 USD = 1,000 credits."
                : `≈ $${(Number(creditsInput || 0) / 1000).toFixed(2)} at 1,000 credits per USD.`}
            </p>
            <label>
              Expires
              <input
                name="expires_at"
                type="date"
                defaultValue={
                  k.expires_at
                    ? new Date(k.expires_at).toISOString().slice(0, 10)
                    : ""
                }
              />
            </label>
            <Button disabled={busy}>
              {busy ? "Saving…" : "Save allowance"}
            </Button>
          </form>
        </Modal>
      )}
    </div>
  );
}
