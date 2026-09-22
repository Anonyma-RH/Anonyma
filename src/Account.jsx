import React, { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { useApp } from "./context.jsx";
import { AppSidebar } from "./Workspace.jsx";
import {
  Icon,
  Button,
  Notice,
  Empty,
  Modal,
  CopyButton,
  BandLines,
  BandSteps,
  CountUp,
} from "./ui.jsx";
import AsciiField from "./AsciiField.jsx";
import { Reveal } from "./ReferenceMotion.jsx";
import { api, readStore, saveStore, download, uid } from "./lib.js";
import { EmailLink, InvoiceDetails } from "./AccountFlows.jsx";
export default function Account() {
  const { section = "overview" } = useParams();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const demo = params.get("demo") === "1";
  const { user, connected, config, refresh } = useApp();
  const [menu, setMenu] = useState(false),
    [keys, setKeys] = useState(() => (demo ? readStore("keys", []) : [])),
    [ledger, setLedger] = useState([]),
    [deposits, setDeposits] = useState([]),
    [sessions, setSessions] = useState([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [modal, setModal] = useState(null),
    [secret, setSecret] = useState(""),
    [busy, setBusy] = useState(false),
    [amount, setAmount] = useState(10),
    [currency, setCurrency] = useState(""),
    [currencies, setCurrencies] = useState([]),
    [invoiceIntent, setInvoiceIntent] = useState(uid);
  useEffect(() => setInvoiceIntent(uid()), [amount, currency]);
  const q = demo ? "?demo=1" : "";
  const bandRef = useRef();
  const balance = demo
    ? { available: 1000, held: 0, balance: 1000 }
    : user || { available: 0, held: 0, balance: 0 };
  useEffect(() => {
    if (demo) {
      saveStore("keys", keys);
      return;
    }
    if (user) {
      Promise.allSettled([
        api("/api/keys"),
        api("/api/account/ledger"),
        api("/api/deposits"),
        api("/api/account/sessions"),
        api("/api/payments/currencies"),
      ]).then(([k, l, d, s, c]) => {
        if (k.status === "fulfilled") setKeys(k.value.data);
        if (l.status === "fulfilled") setLedger(l.value.data);
        if (d.status === "fulfilled") setDeposits(d.value.data);
        if (s.status === "fulfilled") setSessions(s.value.data);
        if (c.status === "fulfilled" && c.value.live) setCurrencies(c.value.data);
        const failed = [k, l, d, s].find((r) => r.status === "rejected");
        if (failed) setError(failed.reason.message);
      });
    }
  }, [demo, user]);
  useEffect(() => {
    if (demo) saveStore("keys", keys);
  }, [keys, demo]);
  async function createKey(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      if (demo) {
        const id = uid();
        const k = "demo_anonyma_" + uid().replaceAll("-", "");
        setKeys((prev) => [
          ...prev,
          {
            id,
            name: data.name,
            cap: data.cap ? Number(data.cap) : null,
            prefix: k.slice(0, 18) + "…",
            created: Date.now(),
          },
        ]);
        setSecret(k);
      } else {
        const r = await api("/api/keys", {
          method: "POST",
          body: { name: data.name, cap: data.cap ? Number(data.cap) : null },
        });
        setSecret(r.key);
        const k = await api("/api/keys");
        setKeys(k.data);
      }
      setModal({ type: "secret" });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function revoke() {
    try {
      if (demo) setKeys((prev) => prev.filter((k) => k.id !== modal.key.id));
      else {
        await api("/api/keys/" + modal.key.id, { method: "DELETE" });
        setKeys((await api("/api/keys")).data);
      }
      setModal(null);
      setNotice("Key revoked.");
    } catch (e) {
      setError(e.message);
    }
  }
  async function exportAccount() {
    if (demo) {
      download(
        "anonyma-demo-export.json",
        JSON.stringify(
          {
            demo: true,
            conversations: readStore("conversations", []),
            media: readStore("media", []),
            keys: keys.map(({ prefix, ...k }) => k),
          },
          null,
          2,
        ),
      );
      setNotice(
        "Demo export downloaded. No production account data is included.",
      );
    } else {
      try {
        const data = await api("/api/account/export");
        download("anonyma-account.json", JSON.stringify(data, null, 2));
      } catch (e) {
        setError(e.message);
      }
    }
  }
  async function submitDeposit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const invoice = await api("/api/deposits", {
        method: "POST",
        body: { amount: Number(amount), currency, requestId: invoiceIntent },
      });
      setNotice(
        "Invoice created. Check the funding activity for its processor-confirmed state.",
      );
      setDeposits((await api("/api/deposits")).data);
      setModal({ type: "invoice", invoice });
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function closeModal() {
    setModal(null);
    setSecret("");
  }
  const tabs = [
    ["overview", "Overview"],
    ["credits", "Credits & funding"],
    ["keys", "API keys"],
    ["settings", "Account settings"],
  ];
  return (
    <main id="main" className="app-shell">
      <AppSidebar
        demo={demo}
        active="account"
        open={menu}
        onClose={() => setMenu(false)}
      />
      {menu && (
        <button
          className="sidebar-scrim"
          aria-label="Close sidebar"
          onClick={() => setMenu(false)}
        />
      )}
      <div className="workspace-main">
        <header className="workspace-header">
          <button
            className="icon-button mobile-only"
            aria-label="Open account menu"
            onClick={() => setMenu(true)}
          >
            <Icon name="menu" />
          </button>
          <span>
            Your account <span className="workspace-slash">/</span>
            <small>{demo ? "Demo workspace" : "Personal workspace"}</small>
          </span>
          <Link to={"/workspace" + q} className="small-button">
            Back to workspace <Icon name="arrow" size={15} />
          </Link>
        </header>
        <div className="workspace-notice">
          <span className="dot" />
          {demo
            ? "Sample account · No money or production credentials"
            : connected
              ? config?.testMode
                ? "Local test mode · Fixture balance · No real payments"
                : "Connected account service"
              : "Preview · Production account services require a backend"}
          {!demo && (
            <Link to={"/account/" + section + "?demo=1"}>
              Explore sample account →
            </Link>
          )}
        </div>
        <div className="page-band" ref={bandRef}>
          <AsciiField sectionRef={bandRef} />
          <BandLines />
          <div className="page-band-inner">
            <p className="eyebrow">ACCOUNT</p>
            <Reveal key={section}>
            <h1>
              {section === "keys"
                ? "API keys"
                : section === "credits"
                  ? "Credits & funding"
                  : section === "settings"
                    ? "Account settings"
                    : "Workspace overview"}
            </h1>
            </Reveal>
            <p>1 USD = 1,000 credits. One balance for the workspace and the API.</p>
          </div>
          <BandSteps />
        </div>
        <div className="account-content" key={section}>
          <nav className="account-tabs" aria-label="Account sections">
            {tabs.map(([id, label]) => (
              <Link
                key={id}
                to={"/account/" + id + q}
                className={id === section ? "active" : ""}
              >
                {label}
              </Link>
            ))}
          </nav>
          {error && <Notice type="error">{error}</Notice>}
          {notice && <Notice>{notice}</Notice>}
          {!demo && !user && (
            <Notice>
              Sign in when the account service is connected, or explore a sample
              account. <Link to="/login">Go to sign-in</Link>
            </Notice>
          )}
          {(section === "overview" || section === "credits") && (
            <div className="balance-grid">
              {[
                [
                  "Available credits",
                  balance.available,
                  "Ready for your next idea",
                  "mint",
                ],
                [
                  "Reserved credits",
                  balance.held,
                  "Held for work in progress",
                  "lavender",
                ],
                [
                  "Total balance",
                  balance.balance,
                  "Available + reserved",
                  "yellow",
                ],
              ].map(([label, value, caption, c]) => (
                <article className={c} key={label}>
                  <span>{label}</span>
                  <b>
                    <CountUp value={value} />
                  </b>
                  <small>
                    {demo ? "Sample · " : ""}
                    {caption}
                  </small>
                </article>
              ))}
            </div>
          )}
          {section === "overview" && (
            <>
              <div className="account-section-head">
                <h2>Recent activity</h2>
                <Button secondary to={"/account/credits" + q}>
                  Explore funding <Icon name="plus" size={16} />
                </Button>
              </div>
              {ledger.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Activity</th>
                        <th>Credits</th>
                        <th>Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ledger.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <b>{r.description || r.kind}</b>
                            <br />
                            <small>
                              {r.kind}
                              {r.key_name ? " · API key " + r.key_name : ""}
                            </small>
                          </td>
                          <td className={Number(r.amount) > 0 ? "amount-in" : ""}>
                            {Number(r.amount) > 0 ? "+" : ""}
                            {Number(r.amount).toLocaleString()}
                          </td>
                          <td>{new Date(r.created).toLocaleString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty icon="history" title="No activity yet">
                  Completed usage and funding receipts will appear here. The
                  demo has no real ledger entries.
                </Empty>
              )}
              <div className="account-quicklinks">
                <Link to={"/account/keys" + q}>
                  <Icon name="key" />
                  <h3>Connect your tools.</h3>
                  <p>Explore API keys and usage caps.</p>
                  <Icon name="diagonal" />
                </Link>
                <Link to={"/account/settings" + q}>
                  <Icon name="settings" />
                  <h3>Your account, considered.</h3>
                  <p>Identity, sessions and your data.</p>
                  <Icon name="diagonal" />
                </Link>
              </div>
            </>
          )}
          {section === "credits" && (
            <div className="funding-layout">
              <form className="form-panel" onSubmit={submitDeposit}>
                <h2>Add credits</h2>
                <p>1 USD = 1,000 credits</p>
                <label>
                  Amount in USD
                  <input
                    type="number"
                    min="5"
                    max="10000"
                    step="1"
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
                <label>
                  Payment currency / network
                  <select
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                    disabled={!currencies.length}
                    required
                  >
                    <option value="">
                      {currencies.length
                        ? "Choose a supported currency"
                        : "Waiting for verified payment currencies"}
                    </option>
                    {currencies.map((c) => (
                      <option key={c} value={c}>
                        {c.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="funding-estimate">
                  <span>Credit conversion</span>
                  <b>
                    {(Math.max(0, Number(amount)) * 1000).toLocaleString()}{" "}
                    credits
                  </b>
                </div>
                <Button
                  disabled={
                    busy ||
                    demo ||
                    !user ||
                    !config?.services?.payments ||
                    !currency
                  }
                >
                  {busy ? "Creating invoice…" : "Create invoice"}
                  <Icon name="arrow" />
                </Button>
                <Notice>
                  {!connected
                    ? "Checkout is unavailable in the preview."
                    : !config?.services?.payments
                      ? "Payments are not configured on this service yet."
                      : currencies.length
                        ? "Invoices come from the payment processor."
                        : "Payment currencies are still loading."}{" "}
                  Credits are added only after verified payment confirmation; no
                  sample payment address is used.
                </Notice>
              </form>
              <div>
                <h2>Funding activity</h2>
                {deposits.length ? (
                  deposits.map((d) => (
                    <article className="deposit-row" key={d.id}>
                      <b>${d.amount}</b>
                      <span>{d.status}</span>
                      <span>{d.credited ? "Credited" : "Not credited"}</span>
                      <button
                        className="small-button"
                        onClick={() =>
                          setModal({ type: "invoice", invoice: d })
                        }
                      >
                        Details
                      </button>
                    </article>
                  ))
                ) : (
                  <Empty icon="credits" title="No deposits yet.">
                    Your invoices and their confirmed status will appear here.
                  </Empty>
                )}
                <div className="info-card">
                  <h3>A note on timing.</h3>
                  <p>
                    A pending or confirming payment does not update your
                    balance. A completed receipt comes from the backend after
                    processor verification.
                  </p>
                  <Link
                    to="/guides/understanding-credits"
                    className="text-link"
                  >
                    Understand credits <Icon name="arrow" size={15} />
                  </Link>
                </div>
              </div>
            </div>
          )}
          {section === "keys" && (
            <>
              <div className="account-section-head">
                <div>
                  <h2>A connection you control.</h2>
                  <p>
                    Named keys. Optional spending caps. Access you can revoke.
                  </p>
                </div>
                <Button
                  disabled={!demo && !user}
                  onClick={() => setModal({ type: "create" })}
                >
                  <Icon name="plus" size={16} />
                  Create {demo ? "sample " : ""}key
                </Button>
              </div>
              {keys.length ? (
                <div className="table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Name / prefix</th>
                        <th>Rolling 24h cap</th>
                        <th>Created</th>
                        <th>Manage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {keys.map((k) => (
                        <tr key={k.id}>
                          <td>
                            <b>{k.name}</b>
                            <br />
                            <code>{k.prefix}</code>
                          </td>
                          <td>
                            {k.cap == null
                              ? "Unlimited"
                              : `${Number(k.spent || 0).toLocaleString()} / ${Number(k.cap).toLocaleString()} credits`}
                            {k.last_used && (
                              <>
                                <br />
                                <small>Last used {new Date(k.last_used).toLocaleString()}</small>
                              </>
                            )}
                          </td>
                          <td>
                            {new Date(
                              k.created || Date.now(),
                            ).toLocaleDateString()}
                          </td>
                          <td>
                            {k.revoked ? (
                              <small>Revoked {new Date(k.revoked).toLocaleDateString()}</small>
                            ) : (
                              <button
                                className="small-button danger-text"
                                onClick={() =>
                                  setModal({ type: "revoke", key: k })
                                }
                              >
                                Revoke
                              </button>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty icon="key" title="Your first connection starts here.">
                  Create a named key to explore the flow. Sample keys cannot
                  authenticate real requests.
                </Empty>
              )}
              <Notice>
                Secrets are shown once and cleared when their dialog closes. A
                rolling key cap includes spend and in-flight reservations. It
                does not cap all operator spending.
              </Notice>
              <Link to="/developers" className="text-link">
                Read the API guide <Icon name="arrow" size={16} />
              </Link>
            </>
          )}
          {section === "settings" && (
            <div className="settings-stack">
              <section>
                <div>
                  <h2>Your identity.</h2>
                  <p>Username, verified email and linked wallet.</p>
                </div>
                <div className="identity-rows">
                  <div>
                    <span>Username</span>
                    <b>
                      {demo
                        ? "demo_explorer"
                        : user?.username || "Not signed in"}
                    </b>
                  </div>
                  <div>
                    <span>Email</span>
                    <b>{user?.email || "Not linked"}</b>
                    <button
                      className="small-button"
                      disabled={!config?.services?.email || !user}
                      onClick={() => setModal({ type: "email" })}
                    >
                      Link email
                    </button>
                  </div>
                  <div>
                    <span>Wallet</span>
                    <b>{user?.wallet || "Not linked"}</b>
                    <button className="small-button" disabled>
                      Wallet setup pending
                    </button>
                  </div>
                </div>
              </section>
              <section>
                <div>
                  <h2>Active sessions.</h2>
                  <p>Review access to your account.</p>
                </div>
                <div>
                  <div className="session-card">
                    <Icon name="shield" />
                    <span>
                      {demo
                        ? "This browser · local demo"
                        : sessions.length
                          ? sessions.length +
                            (sessions.length === 1 ? " active session" : " active sessions")
                          : "No authenticated session"}
                    </span>
                  </div>
                  <button
                    className="small-button"
                    disabled={demo || !user}
                    onClick={async () => {
                      try {
                        await api("/api/auth/logout-all", {
                          method: "POST",
                          body: {},
                        });
                        await refresh();
                        setNotice("All sessions signed out.");
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                  >
                    Sign out all sessions
                  </button>
                  <button
                    className="small-button"
                    disabled={demo || !user}
                    onClick={async () => {
                      try {
                        await api("/api/auth/logout", { method: "POST", body: {} });
                        await refresh();
                        navigate("/login");
                      } catch (e) {
                        setError(e.message);
                      }
                    }}
                  >
                    Sign out
                  </button>
                </div>
              </section>
              <section>
                <div>
                  <h2>Your data.</h2>
                  <p>Take a copy of your work with you.</p>
                </div>
                <Button
                  secondary
                  disabled={!demo && !user}
                  onClick={exportAccount}
                >
                  Export {demo ? "demo " : "account "}data{" "}
                  <Icon name="download" size={16} />
                </Button>
              </section>
              <section className="danger-zone">
                <div>
                  <h2>{demo ? "Reset the demo." : "Close your account."}</h2>
                  <p>
                    {demo
                      ? "Clear the sample work stored in this browser."
                      : "Account closure requires review of unused credits and pending work."}
                  </p>
                </div>
                <button
                  className="small-button danger-text"
                  disabled={!demo && !user}
                  onClick={() => setModal({ type: "close" })}
                >
                  {demo ? "Clear local demo" : "Request account closure"}
                </button>
              </section>
            </div>
          )}
        </div>
      </div>
      {modal && (
        <Modal
          title={
            modal.type === "create"
              ? "A name for your connection."
              : modal.type === "secret"
                ? "Copy it. Keep it somewhere safe."
                : modal.type === "revoke"
                  ? "Revoke this key?"
                  : modal.type === "email"
                    ? "Link an email."
                    : modal.type === "invoice"
                      ? "Your funding invoice."
                      : demo
                        ? "Reset this local demo?"
                        : "Close your account?"
          }
          onClose={closeModal}
        >
          {modal.type === "create" ? (
            <form onSubmit={createKey}>
              <label>
                Key name
                <input
                  name="name"
                  required
                  maxLength="80"
                  placeholder="My local project"
                  autoFocus
                />
              </label>
              <label>
                Rolling 24-hour cap (credits)
                <input
                  name="cap"
                  type="number"
                  min="1"
                  step="1"
                  placeholder="Leave blank for unlimited"
                />
              </label>
              <p className="fine-print">
                1 USD = 1,000 credits. Caps apply to one key.
              </p>
              <Button disabled={busy}>
                {busy
                  ? "Creating…"
                  : "Create " + (demo ? "sample " : "") + "key"}
              </Button>
            </form>
          ) : modal.type === "secret" ? (
            <>
              <Notice>
                {demo
                  ? "This is a sample key. It cannot access any real service."
                  : "This secret is shown only once."}
              </Notice>
              <code className="key-secret">{secret}</code>
              <CopyButton text={secret} label="Copy key" />
              <Button onClick={closeModal}>Done</Button>
            </>
          ) : modal.type === "revoke" ? (
            <>
              <p>{modal.key.name} will no longer be available.</p>
              <div className="inline-actions">
                <Button onClick={revoke}>Revoke key</Button>
                <Button secondary onClick={closeModal}>
                  Keep it
                </Button>
              </div>
            </>
          ) : modal.type === "email" ? (
            <EmailLink
              onDone={() => {
                refresh();
                closeModal();
                setNotice("Email verified and linked.");
              }}
            />
          ) : modal.type === "invoice" ? (
            <InvoiceDetails initial={modal.invoice} onCredited={refresh} />
          ) : (
            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (new FormData(e.currentTarget).get("confirm") !== "DELETE")
                  return;
                try {
                  if (demo) {
                    ["conversations", "media", "keys"].forEach((k) =>
                      localStorage.removeItem("anonyma:" + k),
                    );
                    setKeys([]);
                    setNotice("Local demo data cleared.");
                  } else {
                    await api("/api/account", {
                      method: "DELETE",
                      body: { confirm: "DELETE" },
                    });
                    await refresh();
                    setNotice("Account closed.");
                  }
                  closeModal();
                } catch (e) {
                  setError(e.message);
                }
              }}
            >
              <p>
                {demo
                  ? "This removes the demo conversations, media references and sample key metadata from this browser."
                  : "Unused credits may be forfeited. Unresolved holds or invoices block closure. Financial audit records may be retained."}
              </p>
              <label>
                Type DELETE to confirm
                <input
                  name="confirm"
                  pattern="DELETE"
                  required
                  autoComplete="off"
                />
              </label>
              <Button>Confirm {demo ? "reset" : "closure"}</Button>
            </form>
          )}
        </Modal>
      )}
    </main>
  );
}
