import React, { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useApp } from "./context.jsx";
import { Icon, Button, Notice, Logo, Modal, Empty } from "./ui.jsx";
import { LanguageSwitch } from "./LanguageSwitch.jsx";
import { api, isReleased } from "./lib.js";
import { NotFound } from "./Pages.jsx";
import { PrivacyScreen } from "./PrivacyScreen.jsx";
import "./allowances.css";
import "./connect.css";

// Connect an App: an app asks for one-click access to the MCP server, and
// the user decides here what it may spend, for how long, and on which
// models. The app gets tokens and nothing about the user. Mirrors
// CONNECT_UPDATES in server/releases.js.
const NEEDS = ["api", "mcp", "allowances", "connect"];
export const connectReleased = (config) =>
  NEEDS.every((id) => isReleased(config, id));

const AUTHORIZE_PARAMS = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
];
const EXPIRY_LABEL = (days) => (days === 1 ? "1 day" : `${days} days`);
const BUDGET_PICKS = [500, 2000, 5000, 20000];
const number = (n) =>
  Number(n).toLocaleString(undefined, { maximumFractionDigits: 4 });
const day = 86400000;

// Only ever navigate to the address this request registered (the server
// builds the URL; this is a second look before the browser leaves).
function sameRedirect(url, registered) {
  try {
    const a = new URL(url),
      b = new URL(registered);
    return (
      a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname
    );
  } catch {
    return false;
  }
}

export default function Connect() {
  const { config, user, loading } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const request = useMemo(() => {
    const q = new URLSearchParams(location.search);
    const r = {};
    for (const k of AUTHORIZE_PARAMS) if (q.has(k)) r[k] = q.get(k);
    return r;
  }, [location.search]);
  const released = connectReleased(config);
  const [info, setInfo] = useState(null),
    [loadError, setLoadError] = useState(""),
    // A known app sent an otherwise bad request: where its error can go.
    [returnTo, setReturnTo] = useState(null),
    [error, setError] = useState(""),
    [form, setForm] = useState(null),
    [busy, setBusy] = useState(""),
    [done, setDone] = useState("");

  // Nothing about this page travels on as a referrer, however it was
  // reached (the server also sends Referrer-Policy: no-referrer).
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "referrer";
    meta.content = "no-referrer";
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);

  useEffect(() => {
    if (loading || !released) return;
    if (!user) {
      // Sign in first, then come straight back with the same request.
      navigate(
        "/login?next=" + encodeURIComponent(location.pathname + location.search),
        { replace: true },
      );
      return;
    }
    let current = true;
    api("/api/connections/authorize?" + new URLSearchParams(request)).then(
      (r) => {
        if (!current) return;
        setInfo(r);
        setForm({
          name: r.defaults.name,
          budget: String(r.defaults.budget),
          expiry: r.defaults.expiry_days,
          privateOnly: r.defaults.private_only,
        });
      },
      (e) => {
        if (!current) return;
        setLoadError(e.message);
        const back = e.data?.return_to,
          app = e.data?.app;
        if (back && app && sameRedirect(back, app.redirect_uri))
          setReturnTo({ url: back, host: app.redirect_host });
      },
    );
    return () => {
      current = false;
    };
  }, [loading, released, user?.id, request]);

  if (loading)
    return (
      <main id="main" className="loading-page">
        Opening your workspace…
      </main>
    );
  if (!released) return <NotFound />;

  function leave(url, state) {
    if (!sameRedirect(url, info.app.redirect_uri)) {
      setError("The app's return address didn't match. Nothing was sent.");
      setBusy("");
      return;
    }
    setDone(state);
    window.location.assign(url);
  }
  async function approve(e) {
    e.preventDefault();
    setBusy("approve");
    setError("");
    try {
      const r = await api("/api/connections/approve", {
        method: "POST",
        body: {
          request,
          name: form.name,
          budget: Number(form.budget),
          expiry_days: form.expiry,
          private_only: form.privateOnly,
        },
      });
      leave(r.redirect, "approved");
    } catch (err) {
      setError(err.message);
      setBusy("");
    }
  }
  async function deny() {
    setBusy("deny");
    setError("");
    try {
      const r = await api("/api/connections/deny", {
        method: "POST",
        body: { request },
      });
      leave(r.redirect, "denied");
    } catch (err) {
      setError(err.message);
      setBusy("");
    }
  }

  const budget = Number(form?.budget);
  const budgetOk = Number.isFinite(budget) && budget >= 1 && budget <= (info?.max_budget || 1e6);
  const until = form ? new Date(Date.now() + form.expiry * day).toLocaleDateString() : "";
  const kind = info?.app.redirect_kind;

  return (
    <main id="main" className="connect-page">
      {/* Privacy Screen: Esc twice covers the page (and idle locks it). */}
      <PrivacyScreen config={config} user={user} />
      <div className="connect-shell">
        <aside className="connect-band">
          <div className="connect-band-top">
            <Logo />
            <LanguageSwitch config={config} />
          </div>
          <p className="eyebrow">CONNECT AN APP</p>
          {info ? (
            <>
              <p className="connect-app-name" data-i18n="off">
                {info.app.name}
              </p>
              <p className="connect-self-reported">
                The app chose this name itself. ANONYMA can't verify it.
              </p>
              <h1>wants to use your ANONYMA balance.</h1>
              <dl className="connect-facts">
                <div>
                  <dt>Sends you back to</dt>
                  <dd>
                    <code data-i18n="off">{info.app.redirect_host}</code>
                    <small>
                      {kind === "loopback"
                        ? "A program on this computer. Approve only if you just started this connection yourself."
                        : kind === "app"
                          ? "An app installed on this device, at this address:"
                          : "A website."}
                    </small>
                    {kind === "app" && (
                      <small className="connect-full-uri" data-i18n="off">
                        {info.app.redirect_uri}
                      </small>
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Your account</dt>
                  <dd data-i18n="off">
                    {user?.username
                      ? "@" + user.username
                      : user?.email ||
                        (user?.wallet
                          ? user.wallet.slice(0, 6) + "…" + user.wallet.slice(-4)
                          : "—")}
                  </dd>
                </div>
              </dl>
              <ul className="connect-gets">
                <li>
                  <Icon name="check" size={16} />
                  Runs AI models on your balance, within the budget you set
                </li>
                <li>
                  <Icon name="close" size={16} />
                  Never gets your email, username, chats or balance
                </li>
              </ul>
            </>
          ) : (
            <h1>{loadError ? "This connection request can't be used." : "Checking the request…"}</h1>
          )}
        </aside>
        <section className="connect-card" aria-live="polite">
          {loadError && !done ? (
            <>
              <Notice type="error">{loadError}</Notice>
              <p className="connect-muted">
                Nothing was approved and nothing was sent to the app.
              </p>
              <div className="connect-actions">
                {returnTo && (
                  <Button
                    onClick={() => {
                      setDone("returned");
                      window.location.assign(returnTo.url);
                    }}
                  >
                    Tell the app and go back <Icon name="arrow" />
                  </Button>
                )}
                <Button to="/account/keys" secondary={!!returnTo}>
                  Go to your account {!returnTo && <Icon name="arrow" />}
                </Button>
              </div>
              {returnTo && (
                <p className="fine-print connect-return">
                  Goes back to{" "}
                  <code data-i18n="off">{returnTo.host}</code>
                </p>
              )}
            </>
          ) : done ? (
            <div className="connect-done">
              <Icon name={done === "approved" ? "check" : "close"} size={28} />
              <h2>
                {done === "approved"
                  ? "Approved. Taking you back to the app…"
                  : done === "denied"
                    ? "Declined. Taking you back to the app…"
                    : "Taking you back to the app…"}
              </h2>
              <p className="connect-muted">
                If nothing happens, the app may be waiting in another window.
                You can close this tab.
              </p>
              {done === "approved" && (
                <Link className="text-link" to="/account/keys#connected-apps">
                  Manage connected apps <Icon name="arrow" size={15} />
                </Link>
              )}
            </div>
          ) : !form ? (
            <p className="connect-muted">Checking the request…</p>
          ) : (
            <form onSubmit={approve}>
              <h2>Set its limits.</h2>
              <p className="connect-muted">
                You can change your mind later: pause or revoke it any time in
                Account → API keys.
              </p>
              <label>
                Connection name
                <input
                  value={form.name}
                  maxLength="60"
                  required
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label>
                Budget (credits)
                <input
                  type="number"
                  min="1"
                  max={info.max_budget}
                  step="any"
                  required
                  value={form.budget}
                  onChange={(e) => setForm({ ...form, budget: e.target.value })}
                />
              </label>
              <div className="amount-shortcuts">
                {BUDGET_PICKS.map((n) => (
                  <button
                    type="button"
                    key={n}
                    className={budget === n ? "active" : ""}
                    onClick={() => setForm({ ...form, budget: String(n) })}
                  >
                    {number(n)}
                  </button>
                ))}
              </div>
              <p className="fine-print">
                {budgetOk
                  ? `≈ $${(budget / 1000).toFixed(2)} at 1,000 credits per USD. It can never spend more.`
                  : `Choose from 1 to ${number(info.max_budget)} credits.`}
              </p>
              <fieldset className="connect-expiry">
                <legend>Expires after</legend>
                <div className="filter-tabs">
                  {info.expiry_days.map((d) => (
                    <button
                      type="button"
                      key={d}
                      aria-pressed={form.expiry === d}
                      className={form.expiry === d ? "active" : ""}
                      onClick={() => setForm({ ...form, expiry: d })}
                    >
                      {EXPIRY_LABEL(d)}
                    </button>
                  ))}
                </div>
              </fieldset>
              <label className="connect-switch">
                <input
                  type="checkbox"
                  role="switch"
                  checked={form.privateOnly}
                  onChange={(e) =>
                    setForm({ ...form, privateOnly: e.target.checked })
                  }
                />
                <span className="connect-switch-track" aria-hidden="true" />
                <span>
                  <b>Private models only (zero data retention)</b>
                  <small>
                    {form.privateOnly
                      ? "The app can list and run only models whose providers keep no prompts or answers, and its requests never fall back to another gateway."
                      : "Off: the app can use any available model, including ones whose providers may keep what it sends."}
                  </small>
                </span>
              </label>
              {budgetOk && budget > info.available && (
                <Notice>
                  This budget is more than your available balance. The app
                  can't spend until your balance covers what's left of its
                  budget, so it can never work out your balance.
                </Notice>
              )}
              {form.privateOnly && info.private_models === 0 && (
                <Notice>
                  No private models are available right now, so the app can't
                  run anything until one is.
                </Notice>
              )}
              {kind === "loopback" && (
                <Notice>
                  This app runs on your own computer. If you didn't just start
                  this connection, deny it.
                </Notice>
              )}
              <div className="connect-disclosure" role="note">
                <p>
                  <b data-i18n="off">{info.app.name}</b>{" "}
                  <span>(self-reported)</span>{" "}
                  <span>
                    {`will be able to use AI models on your balance, up to ${number(budgetOk ? budget : 0)} credits, until ${until}.`}
                  </span>
                </p>
                <p>
                  It will see what it sends and what comes back, and what it
                  does with that is up to it and its own terms. That's your
                  call.
                </p>
                <p>
                  From ANONYMA it gets no email, username, chats or balance,
                  and you can revoke it in Account at any time.
                </p>
              </div>
              {error && <Notice type="error">{error}</Notice>}
              <div className="connect-actions">
                <Button disabled={!!busy || !budgetOk || !form.name.trim()}>
                  {busy === "approve" ? "Approving…" : "Approve"}
                  <Icon name="arrow" />
                </Button>
                <Button
                  type="button"
                  secondary
                  disabled={!!busy}
                  onClick={deny}
                >
                  {busy === "deny" ? "Declining…" : "Deny"}
                </Button>
              </div>
            </form>
          )}
        </section>
      </div>
    </main>
  );
}

// Account → API keys: every approved app, with its limits, switches and a
// metadata-only activity list.
export function ConnectedApps({ demo, onError }) {
  const [list, setList] = useState(demo ? [] : null),
    [open, setOpen] = useState(""),
    [activity, setActivity] = useState({}),
    [confirm, setConfirm] = useState(null),
    [busy, setBusy] = useState("");
  const load = () =>
    api("/api/connections").then(
      (r) => setList(r.data),
      (e) => onError?.(e.message),
    );
  useEffect(() => {
    if (!demo) load();
  }, [demo]);
  async function act(c, action) {
    setBusy(c.id);
    try {
      if (action === "revoke")
        await api("/api/connections/" + c.id, { method: "DELETE" });
      else
        await api(`/api/connections/${c.id}/${action}`, {
          method: "POST",
          body: {},
        });
      await load();
      setConfirm(null);
    } catch (e) {
      onError?.(e.message);
    } finally {
      setBusy("");
    }
  }
  async function toggleActivity(c) {
    if (open === c.id) return setOpen("");
    setOpen(c.id);
    try {
      const r = await api(`/api/connections/${c.id}/activity`);
      setActivity((a) => ({ ...a, [c.id]: r.data }));
    } catch (e) {
      onError?.(e.message);
    }
  }
  return (
    <section className="connected-apps" id="connected-apps">
      <div className="account-section-head">
        <div>
          <h2>Connected apps.</h2>
          <p>
            Apps you let in with one click. Each has its own budget and expiry,
            and none of them sees your email, username, chats or balance.
          </p>
        </div>
      </div>
      {list === null ? null : !list.length ? (
        <Empty icon="plug" title="No connected apps yet.">
          When an app asks to connect, you choose its budget and expiry, and it
          appears here.
        </Empty>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>App</th>
                <th>Budget</th>
                <th>Dates</th>
                <th>Private models only</th>
                <th>Manage</th>
              </tr>
            </thead>
            <tbody>
              {list.map((c) => {
                const pct = c.budget ? Math.min(100, (c.spent / c.budget) * 100) : 0;
                return (
                  <React.Fragment key={c.id}>
                    <tr>
                      <td>
                        <b data-i18n="off">{c.name}</b>
                        <br />
                        <small>
                          Self-reported: <span data-i18n="off">{c.app_name}</span>
                        </small>
                        <br />
                        <code data-i18n="off">{c.redirect_host}</code>
                      </td>
                      <td>
                        <div className="key-allowance">
                          <div
                            className="allowance-bar"
                            role="img"
                            aria-label={`${number(c.spent)} of ${number(c.budget)} credits used`}
                          >
                            <div
                              className="allowance-bar-fill"
                              style={{ width: pct + "%" }}
                            />
                          </div>
                          <p className="allowance-figures">
                            {number(c.spent)} / {number(c.budget)} credits
                            <span className="allowance-remaining">
                              {" "}
                              · {number(c.remaining)} left
                            </span>
                          </p>
                          <div className="allowance-meta">
                            {c.paused && (
                              <span className="allowance-tag paused">Paused</span>
                            )}
                            {c.expired && (
                              <span className="allowance-tag expired">Expired</span>
                            )}
                            {!c.activated && (
                              <span className="allowance-tag">
                                Waiting for the app
                              </span>
                            )}
                            {c.activated && !c.signed_in && !c.expired && (
                              <span className="allowance-tag expired">
                                Signed out
                              </span>
                            )}
                            {c.balance_short && !c.expired && !c.paused && (
                              <span
                                className="allowance-tag expired"
                                title="Your balance is below what's left of this budget, so the app can't spend until you add credits."
                              >
                                Balance below budget
                              </span>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="connected-dates">
                        <small>Created {new Date(c.created).toLocaleDateString()}</small>
                        <small>
                          {c.last_used
                            ? `Last used ${new Date(c.last_used).toLocaleString()}`
                            : "Not used yet"}
                        </small>
                        <small>
                          {c.expired ? "Expired" : "Expires"}{" "}
                          {new Date(c.expires_at).toLocaleDateString()}
                        </small>
                      </td>
                      <td>
                        <span
                          className={
                            "allowance-tag" + (c.private_only ? " on" : "")
                          }
                        >
                          {c.private_only ? "On" : "Off"}
                        </span>
                      </td>
                      <td>
                        <div className="allowance-actions">
                          <button
                            type="button"
                            className="small-button"
                            disabled={busy === c.id}
                            onClick={() => act(c, c.paused ? "resume" : "pause")}
                          >
                            <Icon name={c.paused ? "play" : "pause"} size={13} />
                            {c.paused ? "Resume" : "Pause"}
                          </button>
                          <button
                            type="button"
                            className="small-button"
                            aria-expanded={open === c.id}
                            onClick={() => toggleActivity(c)}
                          >
                            <Icon name="history" size={13} />
                            Activity
                          </button>
                          <button
                            type="button"
                            className="small-button danger-text"
                            disabled={busy === c.id}
                            onClick={() => setConfirm(c)}
                          >
                            Revoke
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open === c.id && (
                      <tr className="connected-activity">
                        <td colSpan={5}>
                          {!activity[c.id] ? (
                            <small>Loading activity…</small>
                          ) : !activity[c.id].length ? (
                            <small>No charges yet.</small>
                          ) : (
                            <table>
                              <thead>
                                <tr>
                                  <th>Time</th>
                                  <th>Model</th>
                                  <th>Credits</th>
                                  <th>Receipt</th>
                                </tr>
                              </thead>
                              <tbody>
                                {activity[c.id].map((r) => (
                                  <tr key={r.id}>
                                    <td>{new Date(r.created).toLocaleString()}</td>
                                    <td>
                                      <code data-i18n="off">{r.model}</code>
                                    </td>
                                    <td>{number(r.credits)}</td>
                                    <td>
                                      <code data-i18n="off">{r.receipt_id}</code>
                                      {r.signed && (
                                        <small className="connected-signed">
                                          {" "}
                                          · Signed
                                        </small>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                          <p className="fine-print">
                            Metadata only. ANONYMA keeps no prompts or answers
                            for connected apps.
                          </p>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {confirm && (
        <Modal title="Revoke this connection?" onClose={() => setConfirm(null)}>
          <p>
            <b data-i18n="off">{confirm.name}</b>{" "}
            <span>
              loses access right away. Its tokens are deleted, and it can't
              spend again unless you connect it anew.
            </span>
          </p>
          <div className="inline-actions">
            <Button
              disabled={busy === confirm.id}
              onClick={() => act(confirm, "revoke")}
            >
              Revoke connection
            </Button>
            <Button secondary onClick={() => setConfirm(null)}>
              Keep it
            </Button>
          </div>
        </Modal>
      )}
    </section>
  );
}
