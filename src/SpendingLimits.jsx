import React, { useEffect, useRef, useState } from "react";
import { Button, Icon, Notice } from "./ui.jsx";
import { api } from "./lib.js";
import "./spending-limits.css";

// Spending Limits: the account's own daily (rolling 24 hours) and monthly
// (rolling 30 days) limits on what its personal balance can spend. Lowering
// or adding one applies at once; raising or removing one waits 24 hours and
// can be cancelled until then (server/spending-limits.js).
const HOUR = 3600000;
const WINDOW_TEXT = {
  daily: {
    title: "Daily limit",
    span: "Rolling 24 hours",
    since: "in the last 24 hours",
  },
  monthly: {
    title: "Monthly limit",
    span: "Rolling 30 days",
    since: "in the last 30 days",
  },
};
const fmt = (v) =>
  Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
const when = (ms) =>
  new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

// The sample account's limits (?demo=1): nothing is sent to the server.
function demoView() {
  const at = Date.now();
  return {
    raise_delay_hours: 24,
    held: 1.2,
    daily: {
      limit: 50,
      window_hours: 24,
      settled: 31.2,
      held: 1.2,
      used: 32.4,
      remaining: 17.6,
      pending: null,
      next_room_at: at + 5 * HOUR,
    },
    monthly: {
      limit: 1000,
      window_hours: 720,
      settled: 409.8,
      held: 1.2,
      used: 411,
      remaining: 589,
      pending: { limit: 1500, applies_at: at + 19 * HOUR },
      next_room_at: at + 6 * 24 * HOUR,
    },
  };
}
// A demo change follows the same rule as the server.
function demoChange(view, changes) {
  const next = structuredClone(view);
  const outcome = {};
  for (const [name, value] of Object.entries(changes)) {
    const w = next[name];
    if (value === w.limit) {
      w.pending = null;
      outcome[name + "_limit"] = "unchanged";
    } else if (value !== null && (w.limit === null || value < w.limit)) {
      w.limit = value;
      w.pending = null;
      w.remaining = Math.max(0, value - w.used);
      outcome[name + "_limit"] = "applied";
    } else {
      w.pending = { limit: value, applies_at: Date.now() + 24 * HOUR };
      outcome[name + "_limit"] = "pending";
    }
  }
  return { ...next, changes: outcome };
}

function LimitCard({ name, data, busy, onCancel }) {
  const text = WINDOW_TEXT[name];
  const limit = data.limit;
  const pct =
    limit == null
      ? 0
      : limit === 0
        ? 100
        : Math.min(100, (data.used / limit) * 100);
  const full = limit != null && data.remaining <= 0;
  return (
    <article className={"limit-card" + (full ? " full" : "")}>
      <header>
        <h3>{text.title}</h3>
        <span>{text.span}</span>
      </header>
      {limit == null ? (
        <>
          <p className="limit-figure muted">No limit</p>
          <p className="limit-caption">
            {`${fmt(data.used)} credits spent ${text.since}`}
          </p>
        </>
      ) : (
        <>
          <p className="limit-figure">
            {`${fmt(data.remaining)} of ${fmt(limit)} credits left`}
          </p>
          <div
            className="limit-bar"
            role="img"
            aria-label={`${fmt(data.used)} of ${fmt(limit)} credits used`}
          >
            <div className="limit-bar-fill" style={{ width: pct + "%" }} />
          </div>
          <p className="limit-caption">
            {`${fmt(data.used)} used ${text.since}`}
            {data.held > 0 && (
              <>
                {" · "}
                {`${fmt(data.held)} on hold`}
              </>
            )}
          </p>
          {full && data.next_room_at && (
            <p className="limit-caption">
              {`Room frees up from ${when(data.next_room_at)}.`}
            </p>
          )}
        </>
      )}
      {data.pending && (
        <div className="limit-pending">
          <p>
            <b>Pending</b>
            {" · "}
            {data.pending.limit == null
              ? `No limit from ${when(data.pending.applies_at)}.`
              : `Rises to ${fmt(data.pending.limit)} credits at ${when(data.pending.applies_at)}.`}
          </p>
          <button
            type="button"
            className="small-button"
            disabled={busy}
            onClick={() => onCancel(name)}
          >
            Cancel change
          </button>
        </div>
      )}
    </article>
  );
}

export function SpendingLimits({ demo }) {
  const [view, setView] = useState(() => (demo ? demoView() : null));
  const [inputs, setInputs] = useState({ daily: "", monthly: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const show = (v) => {
    setView(v);
    setInputs({
      daily: v.daily.limit == null ? "" : String(v.daily.limit),
      monthly: v.monthly.limit == null ? "" : String(v.monthly.limit),
    });
  };
  useEffect(() => {
    if (demo) return show(demoView());
    api("/api/spending-limits")
      .then((v) => alive.current && show(v))
      .catch((e) => alive.current && setError(e.message));
  }, [demo]);

  async function save(e) {
    e.preventDefault();
    if (!view) return;
    setError("");
    setNotice("");
    // Only what changed is sent: resending a limit as it is would also
    // cancel its pending change.
    const changes = {};
    for (const name of ["daily", "monthly"]) {
      const raw = inputs[name].trim();
      const value = raw === "" ? null : Number(raw);
      if (value !== null && !(Number.isFinite(value) && value >= 0))
        return setError(
          "Enter each limit in credits, 0 or more, or leave it blank for no limit.",
        );
      if (value !== view[name].limit) changes[name] = value;
    }
    if (!Object.keys(changes).length) return setNotice("Nothing to change.");
    setBusy(true);
    try {
      const result = demo
        ? demoChange(view, changes)
        : await api("/api/spending-limits", {
            method: "PATCH",
            body: Object.fromEntries(
              Object.entries(changes).map(([k, v]) => [k + "_limit", v]),
            ),
          });
      if (!alive.current) return;
      show(result);
      const said = [];
      for (const name of ["daily", "monthly"]) {
        const outcome = result.changes?.[name + "_limit"];
        const w = result[name];
        const title = WINDOW_TEXT[name].title;
        if (outcome === "applied")
          said.push(`${title}: ${fmt(w.limit)} credits, in force now.`);
        if (outcome === "pending")
          said.push(
            w.pending.limit == null
              ? `${title}: removed at ${when(w.pending.applies_at)}, 24 hours from now. You can cancel it until then.`
              : `${title}: rises to ${fmt(w.pending.limit)} credits at ${when(w.pending.applies_at)}, 24 hours from now. You can cancel it until then.`,
          );
      }
      setNotice(said.length ? said : "Nothing to change.");
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function cancel(name) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const result = demo
        ? { ...view, [name]: { ...view[name], pending: null } }
        : await api("/api/spending-limits/pending/" + name, {
            method: "DELETE",
          });
      if (!alive.current) return;
      show(result);
      setNotice(
        `${WINDOW_TEXT[name].title}: pending change cancelled. The current limit stays.`,
      );
    } catch (e) {
      if (alive.current) setError(e.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <div className="spending-limits">
      <div className="account-section-head">
        <div>
          <h2>Set the ceiling.</h2>
          <p>
            Daily and monthly limits on what your own balance can spend, so a
            runaway session, script or leaked key can't drain it.
          </p>
        </div>
      </div>
      {error && <Notice type="error">{error}</Notice>}
      {notice && (
        <Notice>
          {/* One sentence per limit, each its own text for translation. */}
          {[].concat(notice).map((text, i) => (
            <React.Fragment key={i}>
              {i > 0 && " "}
              <span>{text}</span>
            </React.Fragment>
          ))}
        </Notice>
      )}
      {view ? (
        <div className="limit-cards">
          {["daily", "monthly"].map((name) => (
            <LimitCard
              key={name}
              name={name}
              data={view[name]}
              busy={busy}
              onCancel={cancel}
            />
          ))}
        </div>
      ) : (
        !error && <p className="limit-caption">Loading your limits…</p>
      )}
      <div className="limit-layout">
        <form className="form-panel limit-form" onSubmit={save}>
          <h3>Change your limits</h3>
          {["daily", "monthly"].map((name) => (
            <label key={name}>
              {name === "daily"
                ? "Daily limit (credits)"
                : "Monthly limit (credits)"}
              <input
                type="number"
                min="0"
                step="any"
                inputMode="decimal"
                placeholder="No limit"
                value={inputs[name]}
                disabled={!view}
                onChange={(e) =>
                  setInputs((v) => ({ ...v, [name]: e.target.value }))
                }
              />
            </label>
          ))}
          <p className="fine-print">
            Lowering or adding a limit applies now. Raising or removing one
            waits 24 hours, and you can cancel it until then.
          </p>
          <Button disabled={busy || !view}>
            {busy ? "Saving…" : "Save limits"}
            <Icon name="arrow" />
          </Button>
        </form>
        <div className="info-card limit-rules">
          <h3>What counts.</h3>
          <ul>
            <li>
              Chat, image, video and voice requests paid from your balance
            </li>
            <li>The API, your API keys, connected apps and the MCP server</li>
            <li>Credits you send and treasury contributions</li>
            <li>Requests still in progress, at the most they could cost</li>
          </ul>
          <h3>What doesn't.</h3>
          <ul>
            <li>Team-paid collab requests, which spend the team treasury</li>
            <li>Top-ups, refunds and rewards</li>
          </ul>
          <p>
            A request that would go over a limit is refused before anything is
            reserved or spent, with the time room frees up.
          </p>
        </div>
      </div>
    </div>
  );
}
