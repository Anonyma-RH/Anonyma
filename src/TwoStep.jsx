import React, { useEffect, useMemo, useState } from "react";
import { Icon, Button, Notice, CopyButton } from "./ui.jsx";
import { api, download, walletAvailable, walletReauth } from "./lib.js";
import { encodeQR, qrPath } from "./qr.js";
import {
  TWO_STEP_API_NOTE,
  codeInput,
  formatSecret,
  recoveryText,
} from "./two-step.js";
import "./two-step.css";

// Two-Step Sign-in (server/two-step.js, server/routes/two-step.js).
// Account → Security holds the settings; the sign-in page shows
// TwoStepPrompt when a first step comes back asking for a code.

// The setup link as a QR code, drawn here: the key never leaves this page
// for a QR service.
export function QrCode({ text, label = "QR code" }) {
  const qr = useMemo(() => qrPath(encodeQR(text)), [text]);
  return (
    <svg
      className="two-step-qr"
      viewBox={qr.viewBox}
      role="img"
      aria-label={label}
      shapeRendering="crispEdges"
    >
      <rect width="100%" height="100%" fill="#fff" />
      <path d={qr.d} fill="#000" />
    </svg>
  );
}

function CodeField({ label, value, onChange, recovery = false, autoFocus }) {
  return (
    <label className="two-step-field">
      {label}
      <input
        name="code"
        value={value}
        onChange={(e) => onChange(codeInput(e.target.value, recovery))}
        inputMode={recovery ? "text" : "numeric"}
        autoComplete="one-time-code"
        autoCapitalize="off"
        spellCheck={false}
        placeholder={recovery ? "xxxx-xxxx-xxxx-xxxx" : "6-digit code"}
        maxLength={recovery ? 24 : 6}
        required
        autoFocus={autoFocus}
      />
    </label>
  );
}

// The recovery codes, shown once after turning on or replacing them.
function RecoveryCodes({ codes, label, onDone }) {
  const [saved, setSaved] = useState(false);
  return (
    <div className="two-step-codes">
      <h3>Save your recovery codes.</h3>
      <p>
        Each code signs you in once if you lose your authenticator app. They’re
        shown only now; ANONYMA keeps only a scrambled copy.
      </p>
      <ol>
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="inline-actions">
        <CopyButton text={codes.join("\n")} label="Copy codes" />
        <button
          type="button"
          className="small-button"
          onClick={() =>
            download(
              "anonyma-recovery-codes.txt",
              recoveryText(codes, label),
              "text/plain",
            )
          }
        >
          <Icon name="download" size={14} /> Download as text
        </button>
      </div>
      <label className="two-step-check">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        I’ve saved these codes
      </label>
      <Button disabled={!saved} onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

// "Confirm it's you": turning two-step on and new recovery codes need this
// session to have confirmed it's its owner in the last 10 minutes (checked
// by the server, bound to this session): the password, or for an account
// without one, a fresh email code or wallet signature. A stolen session
// can't do either. Passkeys (src/Passkeys.jsx) reuse it with their own
// `intro`, and add "passkey" to `methods` with `onPasskey` doing the
// ceremony and returning the new reauthUntil.
export function ConfirmItsYou({
  methods,
  config,
  user,
  onDone,
  onCancel,
  intro = "Turning on two-step sign-in and making new recovery codes need a fresh confirmation from this session.",
  onPasskey,
  passkeyError = (e) => e.message,
}) {
  const [password, setPassword] = useState(""),
    [challenge, setChallenge] = useState(null),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e.message);
      if (e.code === "two_step_reauth_expired") setChallenge(null);
    } finally {
      setBusy(false);
    }
  }
  const confirmWith = (body) =>
    run(async () => {
      const r = await api("/api/account/two-step/reauth", {
        method: "POST",
        body,
      });
      onDone(r.reauthUntil);
    });
  const sendCode = () =>
    run(async () => {
      setCode("");
      setChallenge(
        await api("/api/account/two-step/reauth/start", {
          method: "POST",
          body: { method: "email" },
        }),
      );
    });
  const signWallet = () =>
    run(async () => {
      const r = await walletReauth(config, user?.wallet);
      onDone(r.reauthUntil);
    });
  const withPasskey =
    onPasskey && methods.includes("passkey")
      ? async () => {
          setBusy(true);
          setError("");
          try {
            onDone(await onPasskey());
          } catch (e) {
            setError(passkeyError(e));
          } finally {
            setBusy(false);
          }
        }
      : null;
  const passkeyButton = (secondary) =>
    withPasskey && (
      <Button type="button" secondary={secondary} disabled={busy} onClick={withPasskey}>
        <Icon name="fingerprint" size={16} /> Use a passkey
      </Button>
    );
  const cancel = (
    <Button type="button" secondary disabled={busy} onClick={onCancel}>
      Cancel
    </Button>
  );
  return (
    <div className="two-step-reauth">
      <h3>Confirm it’s you.</h3>
      <p>{intro}</p>
      {error && <Notice type="error">{error}</Notice>}
      {methods.includes("password") ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirmWith({ method: "password", password });
          }}
        >
          <label className="two-step-field">
            Your password
            <input
              name="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              maxLength="256"
              required
              autoFocus
            />
          </label>
          <div className="inline-actions">
            <Button disabled={busy || !password}>
              {busy ? "Checking…" : "Confirm"}
            </Button>
            {passkeyButton(true)}
            {cancel}
          </div>
        </form>
      ) : challenge ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirmWith({ method: "email", id: challenge.id, code });
          }}
        >
          <Notice>
            Enter the code from your email. It expires after 10 minutes.
            {challenge.testCode &&
              ` Local test mode: no email was sent; your code is ${challenge.testCode}.`}
          </Notice>
          <CodeField
            label="Email code"
            value={code}
            onChange={setCode}
            autoFocus
          />
          <div className="inline-actions">
            <Button disabled={busy || code.length !== 6}>
              {busy ? "Checking…" : "Confirm"}
            </Button>
            {cancel}
          </div>
        </form>
      ) : (
        <div className="inline-actions">
          {passkeyButton(false)}
          {methods.includes("email") && (
            <Button secondary={!!withPasskey} disabled={busy} onClick={sendCode}>
              Email me a code
            </Button>
          )}
          {methods.includes("wallet") && (
            <Button
              secondary={methods.includes("email") || !!withPasskey}
              disabled={busy || !walletAvailable(config)}
              onClick={signWallet}
            >
              {busy ? "Waiting for your wallet…" : "Sign with your wallet"}
            </Button>
          )}
          {cancel}
        </div>
      )}
    </div>
  );
}

export function TwoStepSettings({ user, demo = false, config }) {
  const [status, setStatus] = useState(null),
    [setup, setSetup] = useState(null),
    [codes, setCodes] = useState(null),
    [form, setForm] = useState(null),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState([]),
    // The step waiting for "confirm it's you": "on", "enable" or "codes".
    [reauth, setReauth] = useState(null);
  useEffect(() => {
    if (demo || !user) return;
    api("/api/account/two-step")
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, [demo, user?.id]);
  const label = user?.username || user?.email || "your account";
  const signedOut = (n) =>
    n === 1
      ? ["1 other session was signed out."]
      : n > 1
        ? [`${n} other sessions were signed out.`]
        : [];
  function reset() {
    setForm(null);
    setCode("");
    setError("");
    setReauth(null);
  }
  // Whether this session's last "confirm it's you" still counts.
  const confirmed = () =>
    !!status?.reauthUntil && status.reauthUntil > Date.now();
  async function run(fn, step) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      // It lapsed (10 minutes) since the page loaded: confirm again, then
      // carry on from the same step.
      if (e.code === "two_step_reauth_required") {
        setStatus((s) => ({ ...s, reauthUntil: null }));
        setReauth(step);
      } else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function reauthDone(until) {
    const step = reauth;
    setStatus((s) => ({ ...s, reauthUntil: until }));
    setReauth(null);
    if (step === "on") start();
    if (step === "codes") setForm("codes");
  }
  const start = () =>
    run(async () => {
      setNotice([]);
      setSetup(
        await api("/api/account/two-step/setup", { method: "POST", body: {} }),
      );
      setCode("");
    }, "on");
  const confirm = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api("/api/account/two-step/enable", {
        method: "POST",
        body: { code },
      });
      setSetup(null);
      setCode("");
      setStatus(r);
      setCodes(r.recoveryCodes);
      setNotice(["Two-step sign-in is on.", ...signedOut(r.signedOutSessions)]);
    }, "enable");
  };
  const regenerate = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api("/api/account/two-step/recovery-codes", {
        method: "POST",
        body: { code },
      });
      reset();
      setStatus(r);
      setCodes(r.recoveryCodes);
      setNotice(["New recovery codes are ready. The old ones no longer work."]);
    }, "codes");
  };
  const turnOff = (e) => {
    e.preventDefault();
    run(async () => {
      const r = await api("/api/account/two-step/disable", {
        method: "POST",
        body: { code },
      });
      reset();
      setStatus(r);
      setNotice([
        "Two-step sign-in is off.",
        ...signedOut(r.signedOutSessions),
      ]);
    });
  };

  let body;
  if (demo)
    body = (
      <>
        <Notice>Sign in to a real account to turn on two-step sign-in.</Notice>
        <Button disabled>Turn on two-step sign-in</Button>
      </>
    );
  else if (!status) body = !error && <p className="fine-print">Loading…</p>;
  else if (reauth && reauth !== "enable")
    body = (
      <ConfirmItsYou
        methods={status.reauthMethods}
        config={config}
        user={user}
        onDone={reauthDone}
        onCancel={() => setReauth(null)}
      />
    );
  else if (codes)
    body = (
      <RecoveryCodes
        codes={codes}
        label={label}
        onDone={() => {
          setCodes(null);
          setNotice([]);
        }}
      />
    );
  else if (setup)
    body = (
      <form className="two-step-setup" onSubmit={confirm}>
        {reauth === "enable" && (
          <ConfirmItsYou
            methods={status.reauthMethods}
            config={config}
            user={user}
            onDone={reauthDone}
            onCancel={() => setReauth(null)}
          />
        )}
        <div className="two-step-scan">
          <QrCode text={setup.uri} label="QR code for your authenticator app" />
          <div>
            <h3>Scan this QR code with your authenticator app.</h3>
            <details>
              <summary>Or enter this key by hand</summary>
              <code className="two-step-key">{formatSecret(setup.secret)}</code>
              <CopyButton text={setup.secret} label="Copy key" />
            </details>
            <p className="fine-print">
              Only you should see this. Anyone with this key can make your
              codes.
            </p>
          </div>
        </div>
        <CodeField
          label="Enter the 6-digit code your app shows."
          value={code}
          onChange={setCode}
          autoFocus
        />
        <div className="inline-actions">
          <Button disabled={busy || code.length !== 6}>
            {busy ? "Checking…" : "Turn on"}
          </Button>
          <Button
            type="button"
            secondary
            disabled={busy}
            onClick={() => {
              setSetup(null);
              reset();
            }}
          >
            Cancel
          </Button>
        </div>
      </form>
    );
  else if (status.enabled)
    body = (
      <>
        <div className="identity-rows two-step-status">
          <div>
            <span>Status</span>
            <b>
              <Icon name="shield" size={14} /> Two-step sign-in is on.
            </b>
          </div>
          <div>
            <span>On since</span>
            <b>{new Date(status.enabledAt).toLocaleDateString()}</b>
          </div>
          <div>
            <span>Recovery codes left</span>
            <b>{status.recoveryCodesLeft}</b>
          </div>
        </div>
        {form ? (
          <form
            className="two-step-manage"
            onSubmit={form === "off" ? turnOff : regenerate}
          >
            <p>
              {form === "off"
                ? "Enter a current code from your authenticator app, or a recovery code."
                : "Enter a current 6-digit code from your authenticator app. Your old recovery codes stop working."}
            </p>
            <CodeField
              label={form === "off" ? "Code or recovery code" : "6-digit code"}
              value={code}
              onChange={setCode}
              recovery={form === "off"}
              autoFocus
            />
            <div className="inline-actions">
              <Button
                className={form === "off" ? "danger" : ""}
                disabled={busy || !code}
              >
                {busy
                  ? "Checking…"
                  : form === "off"
                    ? "Turn off two-step sign-in"
                    : "Make new codes"}
              </Button>
              <Button type="button" secondary disabled={busy} onClick={reset}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="inline-actions">
            <button
              type="button"
              className="small-button"
              onClick={() => {
                setNotice([]);
                if (confirmed()) setForm("codes");
                else setReauth("codes");
              }}
            >
              <Icon name="key" size={14} /> New recovery codes
            </button>
            <button
              type="button"
              className="small-button danger-text"
              onClick={() => {
                setNotice([]);
                setForm("off");
              }}
            >
              Turn off
            </button>
          </div>
        )}
      </>
    );
  else if (!status.reauthMethods?.length)
    // No password, email or wallet: the account signs in only with passkeys
    // (src/Passkeys.jsx), which never ask for a code.
    body = (
      <Notice>
        This account signs in only with passkeys, which already check it’s you
        twice. Two-step sign-in applies once you link an email or a wallet.
      </Notice>
    );
  else
    body = (
      <Button
        disabled={busy || !user}
        onClick={() => (confirmed() ? start() : setReauth("on"))}
      >
        <Icon name="shield" size={16} /> Turn on two-step sign-in
      </Button>
    );

  return (
    <div className="settings-stack two-step">
      <section>
        <div>
          <h2>Two-step sign-in.</h2>
          <p>
            After your password, email code or wallet signature, ANONYMA asks
            for a 6-digit code from an authenticator app. A stolen password
            alone can’t reach your balance.
          </p>
          <p>
            Turning it on or off signs out your other sessions. Turning it on
            asks you to confirm it’s you first.
          </p>
          <p>{TWO_STEP_API_NOTE}</p>
        </div>
        <div className="two-step-body">
          {notice.map((n) => (
            <Notice key={n}>{n}</Notice>
          ))}
          {error && <Notice type="error">{error}</Notice>}
          {body}
        </div>
      </section>
    </div>
  );
}

// The sign-in page's second step. `challenge` is the first step's twoStep
// answer; onDone runs once a session exists.
export function TwoStepPrompt({ challenge, onDone, onCancel }) {
  const [recovery, setRecovery] = useState(false),
    [code, setCode] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [left, setLeft] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api("/api/auth/two-step", {
        method: "POST",
        body: { token: challenge.token, code },
      });
      if (r.twoStep?.method === "recovery")
        setLeft(r.twoStep.recoveryCodesLeft);
      else await onDone();
    } catch (err) {
      setError(err.message);
      if (err.code === "two_step_expired") setCode("");
    } finally {
      setBusy(false);
    }
  }
  if (left != null)
    return (
      <div className="two-step-prompt">
        <Notice>
          {`You used a recovery code. ${left} left. Make new ones in Account → Security.`}
        </Notice>
        <Button onClick={onDone}>
          Continue <Icon name="arrow" />
        </Button>
      </div>
    );
  return (
    <form className="two-step-prompt" onSubmit={submit}>
      <p className="eyebrow">TWO-STEP SIGN-IN</p>
      <p>
        {recovery
          ? "Enter one of your recovery codes."
          : "Enter the 6-digit code from your authenticator app."}
      </p>
      {challenge.method === "recover" && (
        <p>Your new password applies once the code is right.</p>
      )}
      <CodeField
        key={recovery ? "recovery" : "totp"}
        label={recovery ? "Recovery code" : "6-digit code"}
        value={code}
        onChange={setCode}
        recovery={recovery}
        autoFocus
      />
      {error && <Notice type="error">{error}</Notice>}
      <Button disabled={busy || (!recovery && code.length !== 6) || !code}>
        {busy ? "Checking…" : "Verify"} <Icon name="arrow" />
      </Button>
      <div className="two-step-links">
        <button
          type="button"
          className="text-link"
          onClick={() => {
            setRecovery(!recovery);
            setCode("");
            setError("");
          }}
        >
          {recovery
            ? "Use your authenticator app instead"
            : "Use a recovery code instead"}
        </button>
        <button type="button" className="text-link" onClick={onCancel}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}
