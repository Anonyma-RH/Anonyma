import React, { useEffect, useMemo, useRef, useState } from "react";
import { Notice } from "./ui.jsx";
import { api } from "./lib.js";
import {
  RANGES,
  SOURCE_LABELS,
  featureLabel,
  formatAmount,
  magnitude,
  plural,
  lastDays,
  exportRangeError,
  exportUrl,
  shortDate,
  demoUsage,
} from "./usage-insights.js";
import "./usage-insights.css";

// Usage Insights & Export (update "insights"): Account → Usage. Where the
// account's credits went over the last 7, 30 or 90 UTC days, and its own
// ledger rows as a CSV or JSON file. Every figure is the server's exact
// decimal string; bars are sized from integer subcredits.
const requests = (n) => plural(n, "request", "requests");

function Chart({ days }) {
  const [active, setActive] = useState(null);
  const max = Math.max(0, ...days.map((d) => d.spent.units));
  const peak = max > 0 ? days.findIndex((d) => d.spent.units === max) : -1;
  const shown = active ?? peak;
  const day = days[shown];
  const move = (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    let next = null;
    if (step)
      next = Math.min(
        days.length - 1,
        Math.max(0, (active ?? peak ?? 0) + step),
      );
    if (e.key === "Home") next = 0;
    if (e.key === "End") next = days.length - 1;
    if (next == null) return;
    e.preventDefault();
    setActive(next);
  };
  const ticks = [0, Math.floor((days.length - 1) / 2), days.length - 1];
  return (
    <div className="usage-chart-wrap">
      <div
        className={"usage-chart" + (days.length > 31 ? " dense" : "")}
        role="group"
        aria-label="Credits spent per UTC day"
        tabIndex={0}
        onKeyDown={move}
        onMouseLeave={() => setActive(null)}
        onBlur={() => setActive(null)}
      >
        {days.map((d, i) => (
          <div
            key={d.date}
            className={"usage-col" + (i === shown ? " on" : "")}
            onMouseEnter={() => setActive(i)}
            onClick={() => setActive(i)}
          >
            <div
              className="usage-bar"
              style={{
                height: max
                  ? Math.max(
                      d.spent.units ? 2 : 0,
                      (d.spent.units / max) * 100,
                    ) + "%"
                  : 0,
                "--n": i,
              }}
            />
          </div>
        ))}
        {max === 0 && (
          <p className="usage-chart-empty">Nothing spent in this range.</p>
        )}
      </div>
      <div className="usage-axis" aria-hidden="true">
        {ticks.map((i, n) => (
          <span key={n}>{shortDate(days[i].date)}</span>
        ))}
      </div>
      <p className="usage-readout" aria-live="polite">
        {day && max > 0 && (
          <>
            <span>{shortDate(day.date)}</span>
            {" · "}
            <span>{`${formatAmount(day.spent.credits)} credits`}</span>
            {" · "}
            <span>{requests(day.requests)}</span>
          </>
        )}
      </p>
    </div>
  );
}

function Breakdown({ title, rows, label }) {
  const max = Math.max(0, ...rows.map((r) => r.spent.units));
  return (
    <section className="usage-breakdown">
      <h3>{title}</h3>
      {rows.length ? (
        <ol>
          {rows.map((r, i) => (
            <li key={i} style={{ "--n": i }}>
              <div className="usage-row-head">{label(r)}</div>
              <div className="usage-track">
                <div
                  style={{
                    width: (max ? (r.spent.units / max) * 100 : 0) + "%",
                  }}
                />
              </div>
              <div className="usage-row-figures">
                <b>{formatAmount(r.spent.credits)}</b>
                <small>{requests(r.requests)}</small>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <p className="usage-empty">No requests in this range.</p>
      )}
    </section>
  );
}

function ExportPanel({ demo, range }) {
  const [from, setFrom] = useState(range.from);
  const [to, setTo] = useState(range.to);
  const [format, setFormat] = useState("csv");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState({ type: "", text: "" });
  useEffect(() => {
    setFrom(range.from);
    setTo(range.to);
  }, [range.from, range.to]);
  const today = lastDays(1).to;
  const problem = exportRangeError(from, to);
  async function save(e) {
    e.preventDefault();
    if (demo || busy || problem) return;
    setBusy(true);
    setMessage({ type: "", text: "" });
    try {
      const response = await fetch(exportUrl(format, from, to), {
        credentials: "same-origin",
      });
      if (!response.ok) {
        let data = null;
        try {
          data = await response.json();
        } catch {}
        throw new Error(
          data?.error?.message || "The export failed. Try again.",
        );
      }
      const blob = await response.blob();
      const name =
        /filename="([^"]+)"/.exec(
          response.headers.get("content-disposition") || "",
        )?.[1] || `anonyma-usage.${format}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const rows = Number(response.headers.get("x-export-rows"));
      setMessage({
        type: "ok",
        text: Number.isFinite(rows)
          ? `${rows.toLocaleString("en-US")} entries exported.`
          : "",
      });
    } catch (err) {
      setMessage({
        type: "error",
        text: err.message || "The export failed. Try again.",
      });
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="usage-export" onSubmit={save}>
      <div className="usage-export-copy">
        <h3>Export your ledger</h3>
        <p>
          Every ledger entry in the range, oldest first: time (UTC), type,
          credits and USD (exact), model, feature, key or app, receipt ID and
          ledger reference. Never prompts or replies.
        </p>
      </div>
      <div className="usage-export-fields">
        <label>
          <span>From (UTC)</span>
          <input
            type="date"
            value={from}
            max={to || today}
            onChange={(e) => setFrom(e.target.value)}
            disabled={demo}
          />
        </label>
        <label>
          <span>To (UTC)</span>
          <input
            type="date"
            value={to}
            min={from}
            max={today}
            onChange={(e) => setTo(e.target.value)}
            disabled={demo}
          />
        </label>
        <fieldset className="usage-format">
          <legend>Format</legend>
          {["csv", "json"].map((f) => (
            <label key={f} className={format === f ? "on" : ""}>
              <input
                type="radio"
                name="usage-format"
                value={f}
                checked={format === f}
                onChange={() => setFormat(f)}
                disabled={demo}
              />
              {f.toUpperCase()}
            </label>
          ))}
        </fieldset>
        <button
          type="submit"
          className="usage-export-go"
          disabled={demo || busy || !!problem}
        >
          {busy ? "Preparing file…" : `Export ${format.toUpperCase()}`}
        </button>
      </div>
      {demo ? (
        <p className="usage-note">
          Sign in to export your own ledger. The sample account has no ledger.
        </p>
      ) : problem ? (
        <p className="usage-note error">{problem}</p>
      ) : message.text ? (
        <p className={"usage-note " + message.type} role="status">
          {message.text}
        </p>
      ) : null}
      <p className="usage-note">
        Up to 366 days and 100,000 entries per file. Cells that a spreadsheet
        could run as a formula start with an apostrophe.
      </p>
    </form>
  );
}

export default function UsageInsights({ demo = false }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(() => (demo ? demoUsage(30) : null));
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!demo);
  const request = useRef(0);
  useEffect(() => {
    if (demo) {
      setData(demoUsage(days));
      return;
    }
    const id = ++request.current;
    const controller = new AbortController();
    setLoading(true);
    setError("");
    api("/api/account/usage?days=" + days, { signal: controller.signal })
      .then((value) => {
        if (id === request.current) setData(value);
      })
      .catch((e) => {
        if (e.name !== "AbortError" && id === request.current)
          setError(e.message);
      })
      .finally(() => {
        if (id === request.current) setLoading(false);
      });
    return () => controller.abort();
  }, [demo, days]);
  const range = useMemo(() => lastDays(days), [days]);
  const t = data?.totals;
  const tiles = t
    ? [
        ["Spent", t.spent, "Settled requests", "spent"],
        ["Top-ups", t.topups, "Deposits, net of any reversals"],
        ["Credits sent", t.sent, "To other accounts"],
        ["Credits received", t.received, "From other accounts"],
        ["Held now", data.held, "Reserved for requests still running"],
        ...(t.rewards.units
          ? [["Rewards", t.rewards, "Referral and holder rewards"]]
          : []),
        ...(t.team_transfers.units
          ? [
              [
                "Team Treasury transfers",
                t.team_transfers,
                "Into and out of Team Treasuries",
              ],
            ]
          : []),
      ]
    : [];
  const net = t ? formatAmount(t.net.credits) : "";
  return (
    <div className={"usage" + (loading && data ? " is-loading" : "")}>
      <div className="usage-head">
        <div>
          <h2>Where your credits went</h2>
          <p>
            From your own ledger, exact to 0.0001 credit. Days are UTC days
            (00:00–24:00 UTC).
          </p>
        </div>
        <div className="usage-range" role="group" aria-label="Range">
          {RANGES.map((n) => (
            <button
              key={n}
              type="button"
              className={n === days ? "on" : ""}
              aria-pressed={n === days}
              onClick={() => setDays(n)}
            >
              {`${n} days`}
            </button>
          ))}
        </div>
      </div>
      {demo && <p className="usage-sample">Sample figures for the demo.</p>}
      {error && <Notice type="error">{error}</Notice>}
      {!data && loading && (
        <div className="usage-loading" role="status">
          <span />
          Loading usage…
        </div>
      )}
      {data && (
        <>
          <div className="usage-tiles">
            {tiles.map(([label, value, caption, accent]) => (
              <article key={label} className={accent || ""}>
                <span>{label}</span>
                <b>{formatAmount(magnitude(value.credits))}</b>
                <small>
                  {accent === "spent"
                    ? `$${formatAmount(value.usd)} · ${requests(t.requests)}`
                    : caption}
                </small>
              </article>
            ))}
          </div>
          <p className="usage-net">
            {`Net change in this range: ${t.net.units > 0 ? "+" : ""}${net} credits`}
          </p>
          <Chart days={data.daily} />
          <div className="usage-breakdowns">
            <Breakdown
              title="By model"
              rows={data.by_model}
              label={(r) => (
                <span
                  data-i18n={
                    !r.id && r.model === "Unrecorded model" ? undefined : "off"
                  }
                >
                  {r.model}
                </span>
              )}
            />
            <Breakdown
              title="By feature"
              rows={data.by_feature}
              label={(r) => <span>{featureLabel(r.feature)}</span>}
            />
            <Breakdown
              title="By key or app"
              rows={data.by_source}
              label={(r) => (
                <>
                  {r.source === "web" ? (
                    <span>{SOURCE_LABELS.web}</span>
                  ) : (
                    <>
                      <em>{SOURCE_LABELS[r.source] || r.source}</em>{" "}
                      <span data-i18n="off">{r.label}</span>
                    </>
                  )}
                  {r.revoked && <em className="usage-tag">Revoked</em>}
                </>
              )}
            />
          </div>
          {data.team_paid.units > 0 && (
            <p className="usage-team">
              {`Team pays: ${formatAmount(data.team_paid.credits)} credits across ${requests(data.team_paid.requests)} were charged to Team Treasuries, not your balance, so they're not counted above or exported.`}
            </p>
          )}
          <p className="usage-note">
            Web search, Symposium and Double-check labels start with this
            release; earlier chat requests show as Chat. Off-the-record and
            Private chats are labelled only by model and web search.
          </p>
        </>
      )}
      <ExportPanel demo={demo} range={data?.range?.from ? data.range : range} />
    </div>
  );
}
