import React, { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowRight,
  Wallet,
  Mail,
  User,
  KeyRound,
  Plus,
  Trash2,
  Download,
  Copy,
  LogOut,
  RefreshCw,
  Check,
  ShieldCheck,
  Coins,
  Clock,
  ExternalLink,
} from "lucide-react";
import {
  api,
  useApp,
  Button,
  ErrorBox,
  CopyButton,
  Modal,
  fmt,
  date,
  walletSign,
  PageTitle,
  Footer,
  Empty,
} from "./lib";
export function SignIn() {
  const { user, refresh, config } = useApp(),
    navigate = useNavigate(),
    [mode, setMode] = useState("username"),
    [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [username, setUsername] = useState(""),
    [password, setPassword] = useState(""),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [challenge, setChallenge] = useState(null),
    [recover, setRecover] = useState(false);
  const next = new URLSearchParams(location.search).get("next");
  const destination =
    next?.startsWith("/") && !next.startsWith("//") ? next : "/ask";
  useEffect(() => {
    if (user) navigate(destination, { replace: true });
  }, [user]);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (mode === "wallet") {
        await walletSign(config);
      } else if (mode === "username") {
        await api(register ? "/api/auth/register" : "/api/auth/password", {
          method: "POST",
          body: { username, password },
        });
      } else if (!challenge) {
        setChallenge(
          await api("/api/auth/email/send", {
            method: "POST",
            body: { email, purpose: recover ? "recover" : "login" },
          }),
        );
        return;
      } else
        await api("/api/auth/email/verify", {
          method: "POST",
          body: { id: challenge.id, code, ...(recover ? { password } : {}) },
        });
      await refresh();
      navigate(destination);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={submit}>
        <div className="eyebrow">YOUR MODELS. YOUR BALANCE.</div>
        <h1>
          {recover
            ? "Recover account"
            : register
              ? "Create account"
              : "Welcome back."}
        </h1>
        <p>
          {register
            ? "Start with a username. Email is optional."
            : "One account for everything you want to make."}
        </p>
        <div className="segments auth-tabs">
          {[
            ["username", User, "Username"],
            ["wallet", Wallet, "Wallet"],
            ["email", Mail, "Email"],
          ].map(([id, Icon, label]) => (
            <button
              type="button"
              key={id}
              className={mode === id ? "active" : ""}
              onClick={() => {
                setMode(id);
                setError("");
                setChallenge(null);
                setRecover(false);
              }}
            >
              <Icon size={15} />
              {label}
            </button>
          ))}
        </div>
        <ErrorBox error={error} />
        {mode === "username" ? (
          <>
            <label>
              Username
              <input
                autoComplete="username"
                required
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Your username"
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete={register ? "new-password" : "current-password"}
                required
                minLength={register ? 10 : undefined}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={
                  register ? "At least 10 characters" : "Your password"
                }
              />
            </label>
            {!register && (
              <button
                className="text-link forgot"
                type="button"
                onClick={() => {
                  setMode("email");
                  setRecover(true);
                }}
              >
                Forgot password?
              </button>
            )}
            <Button className="full" busy={busy}>
              {register ? "Create account" : "Sign in"} <ArrowRight size={16} />
            </Button>
            <div className="auth-switch">
              {register ? "Already have an account?" : "New here?"}{" "}
              <button
                type="button"
                className="text-link"
                onClick={() => setRegister(!register)}
              >
                {register ? "Sign in" : "Create an account"}
              </button>
            </div>
          </>
        ) : mode === "email" ? (
          <>
            <label>
              Email address
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                disabled={!!challenge}
              />
            </label>
            {challenge && (
              <>
                <p className="notice">{challenge.message}</p>
                {challenge.testCode && (
                  <p className="test-note">
                    Local test code: <b>{challenge.testCode}</b>
                  </p>
                )}
                <label>
                  Verification code
                  <input
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="000000"
                  />
                </label>
                {recover && (
                  <label>
                    New password
                    <input
                      type="password"
                      autoComplete="new-password"
                      minLength={10}
                      required
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  </label>
                )}
              </>
            )}
            <Button className="full" busy={busy}>
              {challenge ? "Verify & continue" : "Send verification code"}
              <ArrowRight size={16} />
            </Button>
            {challenge && (
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setChallenge(null);
                  setCode("");
                }}
              >
                Use a different email / resend
              </button>
            )}
          </>
        ) : (
          <>
            <div className="wallet-intro">
              <Wallet size={38} />
              <h3>Your wallet is your account.</h3>
              <p>
                Sign a message to prove ownership. No transaction or gas fee
                required.
              </p>
            </div>
            <Button className="full" busy={busy}>
              Connect wallet <ArrowUpRight size={16} />
            </Button>
          </>
        )}
        <p className="auth-terms">
          By continuing, you agree to the <Link to="/terms">Terms</Link> and{" "}
          <Link to="/privacy">Privacy Policy</Link>.
        </p>
      </form>
      <Link to="/" className="back-home">
        ← Back to home
      </Link>
    </main>
  );
}
export function Account() {
  const { user, refresh, config } = useApp(),
    navigate = useNavigate(),
    loc = useLocation(),
    [tab, setTab] = useState(
      loc.pathname.endsWith("/deposit") ? "deposits" : "overview",
    ),
    [ledger, setLedger] = useState([]),
    [keys, setKeys] = useState([]),
    [deposits, setDeposits] = useState([]),
    [sessions, setSessions] = useState([]),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [modal, setModal] = useState(""),
    [activeInvoice, setActiveInvoice] = useState(null),
    [busy, setBusy] = useState(false),
    [keyName, setKeyName] = useState(""),
    [keyCap, setKeyCap] = useState(""),
    [secret, setSecret] = useState(""),
    [email, setEmail] = useState(""),
    [code, setCode] = useState(""),
    [challenge, setChallenge] = useState(null),
    [confirm, setConfirm] = useState("");
  async function load() {
    try {
      const [l, k, d, s] = await Promise.all([
        api("/api/account/ledger"),
        api("/api/keys"),
        api("/api/deposits"),
        api("/api/account/sessions"),
      ]);
      setLedger(l.data);
      setKeys(k.data);
      setDeposits(d.data);
      setSessions(s.data);
    } catch (e) {
      setError(e.message);
    }
  }
  useEffect(() => {
    if (user) load();
  }, [user?.id]);
  useEffect(() => {
    if (loc.pathname.endsWith("/deposit")) setModal("deposit");
  }, [loc.pathname]);
  async function action(fn) {
    setError("");
    setBusy(true);
    try {
      await fn();
      await refresh();
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  if (!user)
    return (
      <main className="signed-out">
        <KeyRound size={38} />
        <h1>Your account, all in one place.</h1>
        <p>Sign in to manage credits, keys, history and privacy.</p>
        <Link className="button" to="/signin?next=/account">
          Sign in <ArrowRight size={16} />
        </Link>
      </main>
    );
  return (
    <>
      <main className="account-page">
        <div className="account-heading">
          <div>
            <span className="eyebrow">YOUR WORKSPACE</span>
            <h1>Account</h1>
            <p className="muted">
              {user.username || user.email || user.wallet?.slice(0, 10) + "…"}
            </p>
          </div>
          <Button onClick={() => setModal("deposit")}>
            <Plus size={16} /> Add credits
          </Button>
        </div>
        <div className="balance-cards">
          <article>
            <span>Credit balance</span>
            <strong>{fmt(user.balance, 4)}</strong>
            <small>≈ ${(user.balance / 1000).toFixed(2)} in usage value</small>
          </article>
          <article>
            <span>Available to spend</span>
            <strong>{fmt(user.available, 4)}</strong>
            <small>Shared by workspace and API keys</small>
          </article>
          <article>
            <span>Reserved for requests</span>
            <strong>{fmt(user.held, 4)}</strong>
            <small>Released or settled when complete</small>
          </article>
        </div>
        <div className="account-tabs">
          {["overview", "keys", "deposits", "security", "data"].map((t) => (
            <button
              className={tab === t ? "active" : ""}
              onClick={() => setTab(t)}
              key={t}
            >
              {t === "keys" ? "API keys" : t === "data" ? "Data & privacy" : t}
            </button>
          ))}
        </div>
        <ErrorBox error={error} />
        {message && <div className="success">{message}</div>}
        {tab === "overview" && (
          <section className="panel">
            <div className="panel-title">
              <h2>Recent activity</h2>
              <Button variant="ghost small" onClick={() => action(load)}>
                <RefreshCw size={14} /> Refresh
              </Button>
            </div>
            {ledger.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Activity</th>
                      <th>Key</th>
                      <th>Date</th>
                      <th>Credits</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ledger.map((l) => (
                      <tr key={l.id}>
                        <td>
                          <strong>{l.description}</strong>
                          <small>
                            {l.kind} · {l.ref.slice(0, 24)}
                          </small>
                          {l.receipt?.usage && (
                            <small>
                              {fmt(l.receipt.usage.prompt_tokens)} input ·{" "}
                              {fmt(l.receipt.usage.completion_tokens)} output
                              tokens
                            </small>
                          )}
                        </td>
                        <td>{l.key_name || "Workspace"}</td>
                        <td>{date(l.created)}</td>
                        <td className={l.amount > 0 ? "green" : ""}>
                          {l.amount > 0 ? "+" : ""}
                          {fmt(l.amount, 4)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No activity yet">
                Add credits and make your first request.
              </Empty>
            )}
          </section>
        )}
        {tab === "keys" && (
          <section className="panel">
            <div className="panel-title">
              <div>
                <h2>API keys</h2>
                <p>One balance for your apps and your workspace.</p>
              </div>
              <Button
                onClick={() => {
                  setSecret("");
                  setModal("key");
                }}
              >
                <Plus size={15} /> Create key
              </Button>
            </div>
            {keys.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Key</th>
                      <th>Rolling 24h spend / cap</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {keys.map((k) => (
                      <tr key={k.id}>
                        <td>{k.name}</td>
                        <td>
                          <code>{k.prefix}…</code>
                        </td>
                        <td>
                          {fmt(k.spent, 4)} /{" "}
                          {k.cap == null ? "Unlimited" : fmt(k.cap)}
                        </td>
                        <td>{k.revoked ? "Revoked" : "Active"}</td>
                        <td>
                          {!k.revoked && (
                            <button
                              className="text-link danger"
                              onClick={() =>
                                action(() =>
                                  api("/api/keys/" + k.id, {
                                    method: "DELETE",
                                  }),
                                )
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
              <Empty title="Connect your first application">
                Create a key, set an optional cap, and copy it once.
              </Empty>
            )}
            <p className="fineprint">
              20 active keys maximum. Caps include spend during the previous 24
              hours plus pending reservations. Revocation prevents new requests.
            </p>
            <Link to="/docs/api" className="text-link">
              API documentation →
            </Link>
          </section>
        )}
        {tab === "deposits" && (
          <section className="panel">
            <div className="panel-title">
              <h2>Deposits</h2>
              <Button onClick={() => setModal("deposit")}>
                <Plus size={15} /> Add credits
              </Button>
            </div>
            {deposits.length ? (
              <div className="deposit-list">
                {deposits.map((d) => (
                  <div key={d.id}>
                    <div>
                      <strong>
                        ${d.amount.toFixed(2)} · {d.currency.toUpperCase()}
                      </strong>
                      <small>
                        {date(d.created)} · {d.id}
                      </small>
                    </div>
                    <span className="status-tag">{d.status}</span>
                    {d.provider_id && (
                      <Button
                        variant="outline small"
                        onClick={() => {
                          setActiveInvoice({
                            ...d.payload,
                            id: d.id,
                            payment_status: d.status,
                          });
                          setModal("deposit");
                        }}
                      >
                        View invoice
                      </Button>
                    )}
                    <Button
                      variant="outline small"
                      onClick={() =>
                        action(async () => {
                          await api("/api/deposits/" + d.id);
                          setMessage("Payment status refreshed.");
                        })
                      }
                    >
                      Refresh
                    </Button>
                  </div>
                ))}
              </div>
            ) : (
              <Empty title="No deposits yet">
                Credits are added after verified payment confirmation.
              </Empty>
            )}
          </section>
        )}
        {tab === "security" && (
          <div className="security-grid">
            <section className="panel">
              <Mail size={24} />
              <h2>Recovery email</h2>
              <p>
                {user.email ||
                  "No email linked. Add one so you can recover a password account."}
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  setModal("email");
                  setChallenge(null);
                  setEmail(user.email || "");
                }}
              >
                Verify email
              </Button>
            </section>
            <section className="panel">
              <Wallet size={24} />
              <h2>Linked wallet</h2>
              <p className="break">
                {user.wallet ||
                  "Link a wallet for signature sign-in and optional token utility."}
              </p>
              <Button
                variant="outline"
                busy={busy}
                onClick={() =>
                  action(async () => {
                    await walletSign(config, true);
                    setMessage("Wallet linked.");
                  })
                }
              >
                {user.wallet ? "Change wallet" : "Link wallet"}
              </Button>
              {user.wallet && (
                <>
                  <p>
                    Observed holdings: {fmt(user.tokenBalance)} tokens
                    <br />
                    Markup reduction: {fmt(user.discount * 100)}%
                  </p>
                  <Button
                    variant="ghost"
                    onClick={() =>
                      action(async () => {
                        await api("/api/account/token/refresh", {
                          method: "POST",
                          body: {},
                        });
                        setMessage("Wallet holdings refreshed.");
                      })
                    }
                  >
                    Refresh holdings
                  </Button>
                </>
              )}
            </section>
            <section className="panel">
              <ShieldCheck size={24} />
              <h2>Active sessions</h2>
              <p>
                {sessions.length} signed-in session
                {sessions.length === 1 ? "" : "s"}. Sessions expire after 30
                days.
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  action(async () => {
                    await api("/api/auth/logout-all", {
                      method: "POST",
                      body: {},
                    });
                    navigate("/signin");
                  })
                }
              >
                Sign out everywhere
              </Button>
            </section>
            <section className="panel">
              <LogOut size={24} />
              <h2>This device</h2>
              <p>
                Sign out here. Your saved conversations stay in your account.
              </p>
              <Button
                variant="outline"
                onClick={() =>
                  action(async () => {
                    await api("/api/auth/logout", { method: "POST", body: {} });
                    navigate("/");
                  })
                }
              >
                Sign out
              </Button>
            </section>
          </div>
        )}
        {tab === "data" && (
          <section className="panel">
            <h2>Your data, your controls.</h2>
            <p>
              Export before deleting. Exports contain account data, usage
              history and saved conversations.
            </p>
            <div className="button-row">
              <a className="button outline" href="/api/account/export" download>
                <Download size={16} /> Export account
              </a>
              <a
                className="button outline"
                href="/api/conversations/export"
                download
              >
                <Download size={16} /> Export conversations
              </a>
            </div>
            <hr />
            <h3>Delete conversation history</h3>
            <p>
              Remove all saved conversations. Generated files can be managed
              separately in the Library.
            </p>
            <Button
              variant="outline"
              onClick={() => {
                setConfirm("");
                setModal("history");
              }}
            >
              Delete all conversations
            </Button>
            <hr />
            <h3>Close account</h3>
            <p>
              Revokes keys and sessions, deletes private content, and forfeits
              unused credits. Financial audit entries remain attached to a
              tombstoned account identifier.
            </p>
            <Button
              variant="danger-button"
              onClick={() => {
                setConfirm("");
                setModal("delete");
              }}
            >
              Close account
            </Button>
          </section>
        )}
      </main>
      {modal === "deposit" && (
        <Deposit
          initialInvoice={activeInvoice}
          onClose={() => {
            setModal("");
            setActiveInvoice(null);
            load();
            refresh();
          }}
        />
      )}
      {modal === "key" && (
        <Modal title="Create API key" onClose={() => setModal("")}>
          <ErrorBox error={error} />
          {secret ? (
            <>
              <p>Copy this key now. It will never be shown again.</p>
              <div className="secret-value">
                <code>{secret}</code>
                <CopyButton text={secret} />
              </div>
              <Button className="full" onClick={() => setModal("")}>
                I've saved my key
              </Button>
            </>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                action(async () => {
                  const j = await api("/api/keys", {
                    method: "POST",
                    body: {
                      name: keyName,
                      cap: keyCap === "" ? null : Number(keyCap),
                    },
                  });
                  setSecret(j.key);
                });
              }}
            >
              <label>
                Name
                <input
                  value={keyName}
                  maxLength={60}
                  onChange={(e) => setKeyName(e.target.value)}
                  placeholder="My application"
                />
              </label>
              <label>
                Rolling 24-hour cap (credits)
                <input
                  type="number"
                  min="0"
                  step="0.0001"
                  value={keyCap}
                  onChange={(e) => setKeyCap(e.target.value)}
                  placeholder="Leave empty for unlimited"
                />
              </label>
              <Button className="full" busy={busy}>
                Create key
              </Button>
            </form>
          )}
        </Modal>
      )}
      {modal === "email" && (
        <Modal title="Verify recovery email" onClose={() => setModal("")}>
          <ErrorBox error={error} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              action(async () => {
                if (challenge) {
                  await api("/api/auth/email/verify", {
                    method: "POST",
                    body: { id: challenge.id, code },
                  });
                  setModal("");
                  setMessage("Recovery email verified.");
                } else
                  setChallenge(
                    await api("/api/auth/email/send", {
                      method: "POST",
                      body: { email, purpose: "link" },
                    }),
                  );
              });
            }}
          >
            <label>
              Email
              <input
                required
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={!!challenge}
              />
            </label>
            {challenge && (
              <>
                <label>
                  Code
                  <input
                    required
                    pattern="[0-9]{6}"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                  />
                </label>
                {challenge.testCode && (
                  <p className="test-note">
                    Local test code: {challenge.testCode}
                  </p>
                )}
              </>
            )}
            <Button busy={busy} className="full">
              {challenge ? "Verify email" : "Send code"}
            </Button>
          </form>
        </Modal>
      )}
      {["history", "delete"].includes(modal) && (
        <Modal
          title={
            modal === "delete"
              ? "Permanently close account"
              : "Delete all conversations"
          }
          onClose={() => setModal("")}
        >
          <p>
            This cannot be undone. Type DELETE to confirm
            {modal === "delete" ? " and forfeit your unused credits" : ""}.
          </p>
          <ErrorBox error={error} />
          <input
            aria-label="Confirmation"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="DELETE"
          />
          <Button
            busy={busy}
            variant="danger-button full"
            disabled={confirm !== "DELETE"}
            onClick={() =>
              action(async () => {
                await api(
                  modal === "delete" ? "/api/account" : "/api/conversations",
                  { method: "DELETE", body: { confirm } },
                );
                setModal("");
                if (modal === "delete") navigate("/");
                else setMessage("Conversation history deleted.");
              })
            }
          >
            Permanently delete
          </Button>
        </Modal>
      )}
    </>
  );
}
export function Deposit({ onClose, initialInvoice = null }) {
  const { config, refresh } = useApp(),
    [amount, setAmount] = useState(20),
    [currency, setCurrency] = useState("btc"),
    [coins, setCoins] = useState([]),
    [invoice, setInvoice] = useState(initialInvoice),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [time, setTime] = useState(Date.now());
  const attempt = useRef(null);
  useEffect(() => {
    api("/api/payments/currencies")
      .then((j) => setCoins(j.data))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    if (!invoice) return;
    const timer = setInterval(() => setTime(Date.now()), 1000);
    const poll = setInterval(async () => {
      try {
        const j = await api("/api/deposits/" + invoice.id);
        setInvoice((v) => ({
          ...v,
          ...j.payload,
          id: v.id,
          payment_status: j.status,
        }));
        if (j.credited) refresh();
      } catch (e) {
        setError(e.message);
      }
    }, 15000);
    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, [invoice?.id]);
  async function create(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const signature = JSON.stringify([amount, currency]);
      if (attempt.current?.signature !== signature)
        attempt.current = { signature, id: crypto.randomUUID() };
      setInvoice(
        await api("/api/deposits", {
          method: "POST",
          body: { amount, currency, requestId: attempt.current.id },
        }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const expiration = invoice?.expiration_estimate_date || invoice?.valid_until;
  return (
    <Modal title="Add credits" onClose={onClose}>
      <ErrorBox error={error} />
      {!config?.services?.payments && (
        <div className="notice">
          {config?.testMode
            ? "Real payments are disabled in local test mode."
            : "Payments are not available yet. Please try again after the service is connected."}
        </div>
      )}
      {!invoice ? (
        <form onSubmit={create}>
          <p>1,000 credits = $1. No subscription. No expiry.</p>
          <label>
            Amount (USD)
            <input
              type="number"
              min="5"
              max="10000"
              step=".01"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              required
            />
          </label>
          <div className="pills">
            {[5, 20, 50, 100].map((n) => (
              <button
                type="button"
                key={n}
                onClick={() => setAmount(n)}
                className={n === amount ? "active" : ""}
              >
                ${n}
              </button>
            ))}
          </div>
          <label>
            Payment currency / network
            <select
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
            >
              {coins.map((c) => (
                <option key={c} value={c}>
                  {c.toUpperCase()}
                </option>
              ))}
            </select>
          </label>
          <div className="deposit-quote">
            <span>You'll receive</span>
            <strong>{fmt(amount * 1000)} credits</strong>
          </div>
          <Button
            className="full"
            busy={busy}
            disabled={!config?.services?.payments}
          >
            Create payment invoice <ArrowRight size={16} />
          </Button>
          <p className="fineprint">
            Send only the specified currency and network. Wallet/network fees
            may apply. Credits arrive after processor confirmation.
          </p>
        </form>
      ) : (
        <div className="invoice">
          <span className="status-tag">{invoice.payment_status}</span>
          <h3>
            {invoice.payment_status === "waiting"
              ? "Send exactly"
              : "Invoice amount:"}{" "}
            {invoice.pay_amount} {String(invoice.pay_currency).toUpperCase()}
          </h3>
          <div className="secret-value">
            <code>{invoice.pay_address}</code>
            <CopyButton text={invoice.pay_address} />
          </div>
          {invoice.payin_extra_id && <p>Memo/tag: {invoice.payin_extra_id}</p>}
          {invoice.payment_status === "partially_paid" && (
            <p className="notice">
              This invoice is only partly paid. Verify the remaining amount with
              support before sending more.
            </p>
          )}
          {["failed", "expired", "refunded"].includes(
            invoice.payment_status,
          ) && (
            <p className="notice">
              This invoice is {invoice.payment_status}. Do not send another
              payment to it.
            </p>
          )}
          {expiration && (
            <p>
              Invoice expires in{" "}
              {Math.max(0, Math.floor((new Date(expiration) - time) / 60000))}{" "}
              minutes.
            </p>
          )}
          <p>Payment ID: {invoice.payment_id}</p>
          <p className="fineprint">
            This screen updates every 15 seconds. The invoice status is checked
            with the payment processor; it is never inferred from a timer.
          </p>
          {invoice.payment_status === "finished" && (
            <div className="success">
              <Check size={16} /> Payment confirmed. Credits added.
            </div>
          )}
          <CopyButton
            text={JSON.stringify(invoice, null, 2)}
            label="Copy receipt"
          />
        </div>
      )}
    </Modal>
  );
}
export function Support() {
  const { user, config } = useApp(),
    [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  return (
    <>
      <PageTitle
        title="Here to"
        accent="help."
        description="Find an answer in the docs, or save a support request for this installation’s operator."
      />
      <main className="support-layout">
        <aside>
          <h2>Start here</h2>
          <Link to="/docs/errors">Errors & troubleshooting →</Link>
          <Link to="/docs/credits">Credits & deposits →</Link>
          <Link to="/docs/keys">API keys & caps →</Link>
          <Link to="/docs/security">Privacy & account controls →</Link>
          {config?.supportEmail && (
            <a href={"mailto:" + config.supportEmail}>Email support ↗</a>
          )}
          {config?.telegram && (
            <a href={config.telegram} target="_blank" rel="noreferrer">
              Telegram ↗
            </a>
          )}
        </aside>
        <form
          className="panel"
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            setBusy(true);
            try {
              const j = await api("/api/support", {
                method: "POST",
                body: { subject, body },
              });
              setMessage(`${j.message} Ticket ${j.id}`);
              setBody("");
              setSubject("");
            } catch (e) {
              setError(e.message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>Support request</h2>
          <ErrorBox error={error} />
          {message && <div className="success">{message}</div>}
          <label>
            Subject
            <input
              required
              maxLength={200}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
            />
          </label>
          <label>
            How can we help?
            <textarea
              rows={6}
              required
              maxLength={10000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          {user ? (
            <Button busy={busy}>
              Save support request <ArrowRight size={16} />
            </Button>
          ) : (
            <Link className="button" to="/signin?next=/support">
              Sign in to contact support
            </Link>
          )}
          <p className="fineprint">
            Include a request or invoice ID where relevant. Never include a
            password, secret API key or wallet recovery phrase.
          </p>
        </form>
      </main>
      <Footer />
    </>
  );
}
