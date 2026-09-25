import React, { useEffect, useState } from "react";
import { Icon, Button, Notice, Modal } from "./ui.jsx";
import { api, isReleased, uid } from "./lib.js";
import { useApp } from "./context.jsx";
import "./treasury.css";

// Team Treasury: a collab's shared credit balance. Gated on both the
// "collab" and "treasury" updates; renders nothing and calls nothing until
// both are released.
const released = (config) =>
  isReleased(config, "collab") && isReleased(config, "treasury");
const fmt = (n) =>
  Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 4 });
const usd = (c) =>
  "$" +
  (Number(c || 0) / 1000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
// The same form as the rest of the app, which the Chinese switch localises.
const when = (t) => new Date(t).toLocaleString();
// "1 credit", "2.5 credits".
const unit = (n) => (Number(n) === 1 ? "credit" : "credits");
// Names, collab titles and model names are never translated.
const Name = ({ children }) => <span data-i18n="off">{children}</span>;
const validCredits = (v) => /^\d+(\.\d{1,4})?$/.test(String(v).trim());
const left = (limit, used) =>
  limit == null ? Infinity : Math.max(0, limit - used);

// "Team pays" in the composer, for collab conversations only.
export function useTeamPays(config, shared, demo, conversationId) {
  const [on, setOn] = useState(false);
  const available = !demo && !!shared && released(config);
  useEffect(() => setOn(false), [shared?.id, conversationId]);
  return {
    on: available && on,
    body: available && on ? { treasury: true } : {},
    toggle: available ? (
      <button
        type="button"
        className={"attachment-control web-toggle" + (on ? " on" : "")}
        aria-pressed={on}
        title="Charge requests to this collab's treasury, within your limits"
        onClick={() => setOn((v) => !v)}
      >
        <Icon name="coins" size={17} />
        <span>Team pays</span>
      </button>
    ) : null,
  };
}

export default function TreasuryPanel({ collab }) {
  const { config, user, models, refresh } = useApp();
  // With Team Treasury switched off again, a treasury that still has credits
  // shows its balance so the owner can withdraw them (paused).
  const enabled = !!user && isReleased(config, "collab");
  const full = released(config);
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [dialog, setDialog] = useState(null),
    [editing, setEditing] = useState(null),
    [busy, setBusy] = useState(false);
  const path = `/api/collabs/${collab.id}/treasury`;
  const reload = () =>
    api(path)
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    setData(null);
    setError("");
    setNotice("");
    setEditing(null);
    api(path)
      .then((r) => live && setData(r))
      // Switched off with no treasury here: show nothing.
      .catch((e) => live && full && setError(e.message));
    return () => {
      live = false;
    };
  }, [enabled, collab.id, collab.members.length]);
  const paused = !!data?.paused;
  if (!enabled || (!full && (!data || (!data.balance && !data.held))))
    return null;
  const owner = data?.role === "owner";
  const you = data?.you;
  const canSpend = you
    ? Math.min(
        left(you.daily_limit, you.daily_used),
        left(you.monthly_limit, you.monthly_used),
        data.available,
      )
    : 0;
  async function saveLimits(member, limits) {
    setBusy(true);
    setError("");
    try {
      await api(`${path}/members/${encodeURIComponent(member.id)}`, {
        method: "PATCH",
        body: limits,
      });
      setEditing(null);
      setNotice("Limits saved.");
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const modelName = (id) => models.find((m) => m.id === id)?.name || id;
  return (
    <section className="treasury-panel" aria-labelledby="treasury-title">
      <div className="account-section-head">
        <h2 id="treasury-title">Team treasury</h2>
        {data && (
          <div className="treasury-actions">
            {!paused && (
              <Button onClick={() => setDialog("contribute")}>
                Contribute <Icon name="plus" size={16} />
              </Button>
            )}
            {owner && (
              <button
                className="small-button"
                onClick={() => setDialog("withdraw")}
              >
                Withdraw
              </button>
            )}
          </div>
        )}
      </div>
      <p className="fine-print treasury-intro">
        {paused
          ? "Team Treasury is paused. Its balance stays on the ledger, and the owner can withdraw it."
          : `Credits pooled for this collab. Members spend them by turning on Team pays in a shared conversation, within the limits ${owner ? "you set" : "the owner sets"}.`}
      </p>
      {notice && <Notice>{notice}</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      {!data ? (
        !error && <p className="fine-print">Loading the treasury…</p>
      ) : (
        <>
          <div className="balance-grid treasury-summary">
            <article>
              <span>Treasury balance</span>
              <b>{fmt(data.balance)}</b>
              <small>
                {usd(data.balance)}
                {data.held > 0
                  ? ` · ${fmt(data.held)} held for requests in progress`
                  : " in credits"}
              </small>
            </article>
            {!paused && (
              <article>
                <span>You can spend now</span>
                <b>{fmt(canSpend)}</b>
                <small>
                  {you.daily_limit === 0 || you.monthly_limit === 0
                    ? "Your limit is 0 until the owner raises it."
                    : "With Team pays, within your limits"}
                </small>
              </article>
            )}
            <article>
              <span>Team spend, 30 days</span>
              <b>
                {fmt(data.monthly_used)}
              </b>
              <small>Including requests in progress</small>
            </article>
          </div>
          <div className="collab-columns treasury-columns">
            <div>
              <h3>Member limits</h3>
              <ul className="treasury-members">
                {data.members.map((m) => (
                  <li key={m.id}>
                    <div className="treasury-member-head">
                      <span className="avatar">
                        {m.username[0]?.toUpperCase()}
                      </span>
                      <span>
                        <Name>{m.username}</Name>
                        {m.role === "owner" && <small> · owner</small>}
                        {m.id === you.id && <small> · you</small>}
                      </span>
                      {owner && !paused && editing !== m.id && (
                        <button
                          className="small-button"
                          aria-label={"Set limits for " + m.username}
                          onClick={() => setEditing(m.id)}
                        >
                          Set limits
                        </button>
                      )}
                    </div>
                    {editing === m.id ? (
                      <LimitForm
                        member={m}
                        busy={busy}
                        onSave={(limits) => saveLimits(m, limits)}
                        onCancel={() => setEditing(null)}
                        onInvalid={setError}
                      />
                    ) : (
                      <>
                        <Usage
                          label="Last 24 hours"
                          used={m.daily_used}
                          limit={m.daily_limit}
                        />
                        <Usage
                          label="Last 30 days"
                          used={m.monthly_used}
                          limit={m.monthly_limit}
                        />
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <h3>Activity</h3>
              {data.activity.length ? (
                <ul className="treasury-activity">
                  {data.activity.map((a, i) => (
                    <li key={i}>
                      <span className={"treasury-mark " + a.type} aria-hidden="true" />
                      <span>
                        <b>
                          {a.type === "contribution" ? (
                            <>
                              <Name>{a.member}</Name> contributed
                            </>
                          ) : a.type === "withdrawal" ? (
                            <>
                              <Name>{a.member}</Name> withdrew
                            </>
                          ) : a.type === "return" ? (
                            <>
                              Returned to <Name>{a.member}</Name>
                            </>
                          ) : (
                            <Name>
                              {a.member} · {modelName(a.model)}
                            </Name>
                          )}
                        </b>
                        <small>{when(a.created)}</small>
                      </span>
                      <span
                        className={
                          "treasury-amount" +
                          (a.type === "contribution" ? " in" : "")
                        }
                      >
                        {a.type === "contribution"
                          ? `+${fmt(a.credits)}`
                          : a.type !== "spend" || a.status === "charged"
                            ? `−${fmt(a.credits)}`
                            : a.status === "pending"
                              ? `Holding ${fmt(a.credits)}`
                              : "Not charged"}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="fine-print">
                  No activity yet. Contributions and team-paid requests
                  appear here.
                </p>
              )}
            </div>
          </div>
        </>
      )}
      {dialog && data && (
        <TransferDialog
          kind={dialog}
          collab={collab}
          available={dialog === "contribute" ? user.available : data.available}
          onClose={() => setDialog(null)}
          onDone={(message) => {
            setDialog(null);
            setNotice(message);
            reload();
            refresh();
          }}
        />
      )}
    </section>
  );
}

function Usage({ label, used, limit }) {
  return (
    <div className="treasury-usage">
      <span>{label}</span>
      <span>
        {limit === null
          ? `${fmt(used)} used · no limit`
          : limit === 0
            ? "Can't spend"
            : `${fmt(used)} / ${fmt(limit)}`}
      </span>
      {limit > 0 && (
        <div
          className="treasury-bar"
          role="meter"
          aria-label={label + " team spend"}
          aria-valuemin={0}
          aria-valuemax={limit}
          aria-valuenow={Math.min(used, limit)}
        >
          <i style={{ width: Math.min(100, (used / limit) * 100) + "%" }} />
        </div>
      )}
    </div>
  );
}

function LimitForm({ member, busy, onSave, onCancel, onInvalid }) {
  const [daily, setDaily] = useState(String(member.daily_limit ?? "")),
    [monthly, setMonthly] = useState(String(member.monthly_limit ?? ""));
  return (
    <form
      className="treasury-limit-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (![daily, monthly].every((v) => !v.trim() || validCredits(v)))
          return onInvalid(
            "Use whole credits or up to four decimals, or leave a limit blank for none.",
          );
        const value = (v) => (v.trim() ? Number(v) : null);
        onSave({ daily_limit: value(daily), monthly_limit: value(monthly) });
      }}
    >
      <label>
        Per 24 hours
        <input
          inputMode="decimal"
          value={daily}
          placeholder="No limit"
          onChange={(e) => setDaily(e.target.value)}
        />
      </label>
      <label>
        Per 30 days
        <input
          inputMode="decimal"
          value={monthly}
          placeholder="No limit"
          onChange={(e) => setMonthly(e.target.value)}
        />
      </label>
      <div className="inline-actions">
        <button className="small-button" disabled={busy}>
          Save
        </button>
        <button type="button" className="small-button" onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="fine-print">Credits. 0 stops spending; blank means no limit.</p>
    </form>
  );
}

function TransferDialog({ kind, collab, available, onClose, onDone }) {
  const contribute = kind === "contribute";
  // One key per dialog: a retry after a lost response can't move credits twice.
  const [key] = useState(uid),
    [amount, setAmount] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const valid = validCredits(amount) && Number(amount) >= 1;
  async function submit(e) {
    e.preventDefault();
    if (!valid) {
      setError("Enter at least 1 credit, with up to four decimals.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const r = await api(`/api/collabs/${collab.id}/treasury/${kind}`, {
        method: "POST",
        body: { credits: Number(amount), idempotency_key: key },
      });
      onDone(
        contribute
          ? `You contributed ${fmt(r.credits)} ${unit(r.credits)}.`
          : `${fmt(r.credits)} ${unit(r.credits)} moved to your balance.`,
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal
      title={contribute ? "Add to the treasury." : "Withdraw to your balance."}
      onClose={onClose}
    >
      <form className="treasury-dialog" onSubmit={submit}>
        {contribute ? (
          <>
            <p>
              Credits move from your balance to the{" "}
              <Name>{collab.name}</Name> treasury. Only the owner can withdraw
              them, and if the collab is deleted what's left returns to the
              owner.
            </p>
            <p className="fine-print">
              Credits you add belong to the team treasury, which its owner
              controls, and can't be taken back.
            </p>
          </>
        ) : (
          <p>
            Credits move from the treasury to your own balance. Credits held
            for requests in progress stay put.
          </p>
        )}
        <label>
          Credits
          <input
            inputMode="decimal"
            value={amount}
            placeholder="500"
            autoFocus
            required
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>
        <p className="treasury-equivalent">
          <b>{valid ? usd(Number(amount)) : "$0.00"}</b>
          <span>
            {`${fmt(available)} ${unit(available)} available ${
              contribute ? "in your balance" : "in the treasury"
            }. 1,000 credits = $1.`}
          </span>
        </p>
        {error && <Notice type="error">{error}</Notice>}
        <Button disabled={busy}>
          {busy ? "Moving credits…" : contribute ? "Contribute" : "Withdraw"}
        </Button>
      </form>
    </Modal>
  );
}
