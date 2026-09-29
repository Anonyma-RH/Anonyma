import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { Icon, Button, Notice } from "./ui.jsx";
import { api, download } from "./lib.js";
import { t } from "./i18n.js";
import { ConfirmItsYou } from "./TwoStep.jsx";
import {
  browserSupportsPasskeys,
  confirmWithPasskey,
  defaultPasskeyName,
  passkeyError,
  passkeysReleased,
} from "./passkeys.js";
import {
  KIT_PENDING_MINUTES,
  KIT_SIZE,
  KIT_TWO_STEP_MESSAGE,
  KIT_FORMAT_MESSAGE,
  KIT_TYPO_MESSAGE,
  KIT_USERNAME_TRIES,
  kitCodeInput,
  kitText,
  looksLikeTwoStepCode,
  readKitCode,
  recoveryKitReleased,
} from "./recovery-kit.js";
import "./recovery-kit.css";

// Recovery Kit (server/recovery-kit.js, server/routes/recovery-kit.js):
// - RecoveryKitSettings: Account → Security, beside Passkeys and Two-Step;
// - RecoveryKitSignIn: the sign-in page's "Use a recovery code" (the link
//   itself is src/RecoveryKitLink.jsx), then a new password or passkey;
// - RecoveryKitNudge: the workspace's one-time nudge for accounts with no
//   email and only one kind of way in.
// The codes exist in the clear only in the response that made them and on
// this page until Done; nothing is kept in the browser.

const day = (ms) => new Date(ms).toLocaleDateString();

// A sample kit for the demo account; nothing here reaches a server.
const DEMO_STATUS = {
  kit: { created: Date.now() - 20 * 86400000, total: KIT_SIZE, unused: 9, lastUsed: Date.now() - 3 * 86400000 },
  username: true,
  nudge: false,
  reauthMethods: ["password"],
  reauthUntil: null,
};

// The printed kit: a copy of the sheet alone, mounted at the top of the page
// for as long as the print dialog is open (as Gift Links' card is).
function usePrintSheet() {
  const [printing, setPrinting] = useState(null);
  useEffect(() => {
    if (!printing) return;
    const root = document.documentElement;
    root.classList.add("recovery-printing");
    const done = () => {
      root.classList.remove("recovery-printing");
      setPrinting(null);
    };
    window.addEventListener("afterprint", done, { once: true });
    // Let the copy render before the dialog opens.
    const timer = setTimeout(() => {
      try {
        window.print();
      } catch {
        done();
      }
    }, 60);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", done);
      root.classList.remove("recovery-printing");
    };
  }, [printing]);
  const sheet = printing
    ? createPortal(
        <div className="recovery-print-root">
          <KitSheet {...printing} />
        </div>,
        document.body,
      )
    : null;
  return [sheet, setPrinting];
}

// The kit on paper.
export function KitSheet({ codes, username, created }) {
  return (
    <article className="recovery-sheet">
      <p className="eyebrow">ANONYMA</p>
      <h2>Recovery kit</h2>
      <dl>
        <div>
          <dt>Username</dt>
          <dd data-i18n="off">{username}</dd>
        </div>
        <div>
          <dt>Made</dt>
          <dd>{day(created)}</dd>
        </div>
      </dl>
      <ol data-i18n="off">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <p>
        Each code gets you back into your account once, if you lose your
        password or passkey. On the sign-in page, choose “Use a recovery
        code”, then enter your username and one code.
      </p>
      <p>
        Anyone with your username and one of these codes can get in, even with
        two-step sign-in on. Keep this page private.
      </p>
    </article>
  );
}

// The ten codes, shown once after making a kit.
export function KitCodes({ codes, username, created, onPrint, onDone }) {
  const [saved, setSaved] = useState(false);
  const file = () =>
    download(
      "anonyma-recovery-kit.txt",
      kitText({ codes, username, created, origin: globalThis.location?.origin }, t),
      "text/plain",
    );
  return (
    <div className="two-step-codes recovery-codes">
      <h3>Save your recovery kit.</h3>
      <p>
        Each code gets you back in once if you lose your password or passkey.
        They’re shown only now; ANONYMA keeps only scrambled copies and can’t
        show them again.
      </p>
      <ol data-i18n="off">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="inline-actions">
        <button type="button" className="small-button" onClick={file}>
          <Icon name="download" size={14} /> Download (.txt)
        </button>
        <button type="button" className="small-button" onClick={onPrint}>
          <Icon name="printer" size={14} /> Print
        </button>
      </div>
      <label className="two-step-check">
        <input
          type="checkbox"
          checked={saved}
          onChange={(e) => setSaved(e.target.checked)}
        />
        I’ve saved my kit somewhere safe
      </label>
      <Button disabled={!saved} onClick={onDone}>
        Done
      </Button>
    </div>
  );
}

// The kit's status rows.
export function KitStatus({ kit }) {
  return (
    <div className="identity-rows two-step-status">
      <div>
        <span>Made</span>
        <b>{day(kit.created)}</b>
      </div>
      <div>
        <span>Codes</span>
        <b>{`${kit.unused} of ${kit.total} unused`}</b>
      </div>
      <div>
        <span>Last used</span>
        <b>{kit.lastUsed ? day(kit.lastUsed) : "Never"}</b>
      </div>
    </div>
  );
}

// What the section says before any kit exists, and around it.
export function KitIntro() {
  return (
    <div>
      <h2>Recovery kit.</h2>
      <p>
        Ten one-time codes that get you back into your account if you lose your
        password or passkey. No email needed.
      </p>
      <p>
        Anyone with your username and one of these codes can get in, even with
        two-step sign-in on, so keep the kit offline, like a spare key. Using a
        code signs out every session and asks for a new password or passkey.
      </p>
      <p>
        ANONYMA keeps only scrambled copies of the codes. Making or deleting a
        kit asks you to confirm it’s you first. It doesn’t replace two-step
        sign-in’s own recovery codes.
      </p>
    </div>
  );
}

export function RecoveryKitSettings({ user, demo = false, config }) {
  const live = recoveryKitReleased(config);
  const [status, setStatus] = useState(demo ? DEMO_STATUS : null),
    [made, setMade] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    // An inline "are you sure": "replace" or "delete".
    [ask, setAsk] = useState(null),
    // What's waiting for "confirm it's you": "make", "replace" or "delete".
    [reauth, setReauth] = useState(null);
  const [sheet, print] = usePrintSheet();
  useEffect(() => {
    if (!live || demo || !user) return;
    api("/api/account/recovery-kit")
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, [live, demo, user?.id]);
  if (!live) return null;
  const confirmed = () => !!status?.reauthUntil && status.reauthUntil > Date.now();
  async function run(fn, step) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      // The 10-minute confirmation lapsed: confirm again, then carry on.
      if (e.code === "recovery_reauth_required") {
        setStatus((s) => ({ ...s, reauthUntil: null }));
        setReauth(step);
      } else setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const make = (replace) =>
    run(async () => {
      const r = await api("/api/account/recovery-kit", {
        method: "POST",
        body: replace ? { replace: true } : {},
      });
      const { codes, ...rest } = r;
      setAsk(null);
      setStatus(rest);
      setMade({ codes, username: user?.username, created: rest.kit?.created ?? Date.now() });
      if (replace) setNotice("Your new kit is ready. The old codes no longer work.");
    }, replace ? "replace" : "make");
  const remove = () =>
    run(async () => {
      setStatus(await api("/api/account/recovery-kit", { method: "DELETE" }));
      setAsk(null);
      setNotice("Recovery kit deleted. Its codes no longer work.");
    }, "delete");
  const go = (step) => {
    setNotice("");
    if (!confirmed()) return setReauth(step);
    if (step === "delete") remove();
    else make(step === "replace");
  };
  function reauthDone(until) {
    const step = reauth;
    setStatus((s) => ({ ...s, reauthUntil: until }));
    setReauth(null);
    if (step === "delete") remove();
    else if (step) make(step === "replace");
  }

  let body;
  if (!status) body = !error && <p className="fine-print">Loading…</p>;
  else if (reauth)
    body = (
      <ConfirmItsYou
        methods={status.reauthMethods || []}
        config={config}
        user={user}
        intro="Making or deleting a recovery kit needs a fresh confirmation from this session."
        onPasskey={async () => (await confirmWithPasskey()).reauthUntil}
        passkeyError={passkeyError}
        onDone={reauthDone}
        onCancel={() => setReauth(null)}
      />
    );
  else if (made)
    body = (
      <KitCodes
        {...made}
        onPrint={() => print(made)}
        onDone={() => {
          setMade(null);
          setNotice("");
        }}
      />
    );
  else if (!status.username)
    body = (
      <Notice>
        A recovery kit needs a username to recover with, and this account
        doesn’t have one. Use email or wallet sign-in to get back in.
      </Notice>
    );
  else if (status.kit)
    body = (
      <>
        <KitStatus kit={status.kit} />
        {status.kit.unused === 0 ? (
          <Notice type="error">Every code has been used. Make a new kit.</Notice>
        ) : status.kit.unused <= 3 ? (
          <Notice>
            {status.kit.unused === 1
              ? "Only 1 code left. Make a new kit before you run out."
              : `Only ${status.kit.unused} codes left. Make a new kit before you run out.`}
          </Notice>
        ) : null}
        {ask ? (
          <div className="recovery-ask">
            <p>
              {ask === "replace"
                ? "Make a new kit? Your current codes stop working at once."
                : "Delete your recovery kit? Its codes stop working at once, and you’ll need your password or passkey to sign in."}
            </p>
            <div className="inline-actions">
              <Button
                className={ask === "delete" ? "danger" : ""}
                disabled={busy || demo}
                onClick={() => go(ask)}
              >
                {busy ? "Working…" : ask === "replace" ? "Make a new kit" : "Delete kit"}
              </Button>
              <Button type="button" secondary disabled={busy} onClick={() => setAsk(null)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <div className="inline-actions">
            <button
              type="button"
              className="small-button"
              disabled={busy || demo}
              onClick={() => setAsk("replace")}
            >
              <Icon name="refresh" size={14} /> Make a new kit
            </button>
            <button
              type="button"
              className="small-button danger-text"
              disabled={busy || demo}
              onClick={() => setAsk("delete")}
            >
              Delete kit
            </button>
          </div>
        )}
        {demo && <Notice>Sign in to a real account to make a recovery kit.</Notice>}
      </>
    );
  else
    body = (
      <>
        <p className="recovery-empty">
          No kit yet. Make one now, while you can still sign in.
        </p>
        <Button disabled={busy || demo || !user} onClick={() => go("make")}>
          <Icon name="lifebuoy" size={16} />
          {busy ? "Making your kit…" : "Make a recovery kit"}
        </Button>
      </>
    );

  return (
    <div className="settings-stack two-step recovery-kit" id="recovery-kit">
      <section>
        <KitIntro />
        <div className="two-step-body">
          {notice && <Notice>{notice}</Notice>}
          {error && <Notice type="error">{error}</Notice>}
          {body}
        </div>
      </section>
      {sheet}
    </div>
  );
}

// ---- The sign-in page ----

export const codesLeftText = (n) =>
  n === 0
    ? "Your kit has no unused codes left. Make a new one in Account → Security."
    : n === 1
      ? "Your kit has 1 unused code left."
      : `Your kit has ${n} unused codes left.`;

// What a typed code says before it's sent: the same checks as the server,
// so a typo never uses up one of the username's tries.
export function codeProblem(code) {
  const read = readKitCode(code);
  if (!read) return looksLikeTwoStepCode(code) ? KIT_TWO_STEP_MESSAGE : KIT_FORMAT_MESSAGE;
  return read.typo ? KIT_TYPO_MESSAGE : "";
}

// A code, then a new password or passkey, then a session. `onSignedIn` runs
// once the person has read the result.
export function RecoveryKitSignIn({ config, connected = true, onSignedIn, onCancel, initial = null }) {
  const [step, setStep] = useState(initial?.step || "code"),
    [recovery, setRecovery] = useState(initial?.recovery || null),
    [result, setResult] = useState(initial?.result || null),
    [username, setUsername] = useState(""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [again, setAgain] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  // The code is spent once accepted: leaving before a new password or
  // passkey is set would waste it, so the browser asks first.
  useEffect(() => {
    if (step !== "new") return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [step]);
  async function run(fn, said = (e) => e.message) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(said(e));
      if (e.code === "recovery_expired") {
        setRecovery(null);
        setStep("code");
      }
    } finally {
      setBusy(false);
    }
  }
  const redeem = (e) => {
    e.preventDefault();
    const problem = codeProblem(code);
    if (problem) return setError(problem);
    run(async () => {
      const r = await api("/api/auth/recovery-kit/redeem", {
        method: "POST",
        body: { username: username.trim(), code },
      });
      setCode("");
      setRecovery(r.recovery);
      setStep("new");
    });
  };
  const setNew = (e) => {
    e.preventDefault();
    if (password !== again) return setError("The two passwords don’t match.");
    run(async () => {
      const r = await api("/api/auth/recovery-kit/password", {
        method: "POST",
        body: { token: recovery.token, password },
      });
      setPassword("");
      setAgain("");
      setResult(r.recovery);
      setRecovery(null);
      setStep("done");
    });
  };
  const withPasskey = () =>
    run(async () => {
      const { startRegistration } = await import("@simplewebauthn/browser");
      const { options } = await api("/api/auth/recovery-kit/passkey/options", {
        method: "POST",
        body: { token: recovery.token },
      });
      const response = await startRegistration({ optionsJSON: options });
      const r = await api("/api/auth/recovery-kit/passkey", {
        method: "POST",
        body: { token: recovery.token, response, name: defaultPasskeyName() },
      });
      setResult(r.recovery);
      setRecovery(null);
      setStep("done");
    }, passkeyError);

  if (step === "done" && result)
    return (
      <div className="recovery-signin" aria-live="polite">
        <p className="eyebrow">RECOVERY KIT</p>
        <Notice>
          {result.method === "passkey"
            ? "You’re back in with your new passkey."
            : "You’re back in with your new password."}
        </Notice>
        <p>{codesLeftText(result.codesLeft)}</p>
        {result.codesLeft > 0 && result.codesLeft <= 3 && (
          <p>Make a new kit in Account → Security before you run out.</p>
        )}
        {result.twoStep && (
          <p>
            Two-step sign-in is still on: your next password sign-in asks for
            your authenticator code.
          </p>
        )}
        <p className="fine-print">
          API keys and connected apps weren’t changed. If you don’t recognise
          one, revoke it in Account.
        </p>
        <Button onClick={onSignedIn}>
          Continue <Icon name="arrow" />
        </Button>
      </div>
    );
  if (step === "new" && recovery) {
    const passkeyOk =
      recovery.passkey && passkeysReleased(config) && browserSupportsPasskeys();
    return (
      <div className="recovery-signin">
        <p className="eyebrow">RECOVERY KIT</p>
        <Notice>
          Code accepted. Every session on this account was signed out.
        </Notice>
        <p>{codesLeftText(recovery.codesLeft)}</p>
        <form onSubmit={setNew}>
          <h3>Choose a new password.</h3>
          <label>
            New password
            <input
              name="password"
              type="password"
              autoComplete="new-password"
              minLength="10"
              maxLength="256"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 10 characters"
              autoFocus
            />
          </label>
          <label>
            Type it again
            <input
              name="password-again"
              type="password"
              autoComplete="new-password"
              minLength="10"
              maxLength="256"
              required
              value={again}
              onChange={(e) => setAgain(e.target.value)}
            />
          </label>
          {error && <Notice type="error">{error}</Notice>}
          <Button type="submit" disabled={busy || password.length < 10 || !again}>
            {busy ? "Please wait…" : "Set password and sign in"} <Icon name="arrow" />
          </Button>
        </form>
        {passkeyOk && (
          <div className="recovery-or">
            <span>or</span>
            <Button type="button" secondary disabled={busy} onClick={withPasskey}>
              <Icon name="fingerprint" size={16} /> Add a passkey instead
            </Button>
          </div>
        )}
        <p className="fine-print">
          {`Finish within ${KIT_PENDING_MINUTES} minutes. The code is spent either way; until you finish, your current password or passkey still works.`}
        </p>
      </div>
    );
  }
  return (
    <form className="recovery-signin" onSubmit={redeem}>
      <p className="eyebrow">RECOVERY KIT</p>
      <p>Enter your username and one code from your recovery kit.</p>
      <label>
        Username
        <input
          name="username"
          autoComplete="username"
          required
          maxLength="32"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder="Your username"
          autoFocus
        />
      </label>
      <label>
        Recovery kit code
        <input
          name="code"
          className="recovery-code-input"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          required
          value={code}
          onChange={(e) => setCode(kitCodeInput(e.target.value))}
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX"
        />
      </label>
      {error && <Notice type="error">{error}</Notice>}
      <Button type="submit" disabled={busy || !connected || !username.trim() || !code.trim()}>
        {busy ? "Checking…" : "Continue"} <Icon name="arrow" />
      </Button>
      <p className="fine-print">
        {`Each code works once. After ${KIT_USERNAME_TRIES} wrong codes, recovery for that username locks for an hour.`}
      </p>
      <div className="two-step-links">
        <button type="button" className="text-link" onClick={onCancel}>
          Back to sign in
        </button>
      </div>
    </form>
  );
}

// ---- The workspace's one-time nudge ----
export function RecoveryKitNudge({ config, user, demo = false, q = "" }) {
  const live = recoveryKitReleased(config);
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (!live || demo || !user) return;
    let on = true;
    api("/api/account/recovery-kit")
      .then((s) => on && setDue(!!s.nudge))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [live, demo, user?.id]);
  if (!live || demo || !user || !due) return null;
  // One time: making a kit or not now, it's dismissed for good.
  const dismiss = () => {
    setDue(false);
    api("/api/account/recovery-kit/nudge", { method: "DELETE" }).catch(() => {});
  };
  return <KitNudge q={q} onMake={dismiss} onDismiss={dismiss} />;
}
export function KitNudge({ q = "", onMake, onDismiss }) {
  return (
    <div className="recovery-nudge" role="status">
      <span className="recovery-nudge-mark" aria-hidden="true">
        <Icon name="lifebuoy" size={15} />
      </span>
      <p>
        <b>No email on this account?</b>{" "}
        <span>
          Keep a recovery kit: ten one-time codes that get you back in if you
          lose your password or passkey.
        </span>
      </p>
      <div className="recovery-nudge-actions">
        <Link to={"/account/security" + q + "#recovery-kit"} onClick={onMake}>
          Make a recovery kit
        </Link>
        <button type="button" className="recovery-nudge-dismiss" onClick={onDismiss}>
          <Icon name="close" size={14} />
          <span>Not now</span>
        </button>
      </div>
    </div>
  );
}
