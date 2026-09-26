import React, {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { Button, Icon, Mark, Notice } from "./ui.jsx";
import { api, isReleased, walletAvailable, walletUnlock } from "./lib.js";
import {
  activate,
  coverLayer,
  getSettings,
  getView,
  hideScreen,
  leaveToSignIn,
  privacyScreenReleased,
  revealScreen,
  saveSettings,
  subscribe,
  unlocked,
} from "./privacy-screen.js";
import "./privacy-screen.css";

export { hideScreen, privacyScreenReleased };

// Privacy Screen (update "privacyscreen"): the cover, the lock screen, the
// header's Hide button and the Account setting. The logic is in
// src/privacy-screen.js; each signed-in page (the workspace, Account and the
// Connect an App consent page) mounts <PrivacyScreen>.

// Once this page has seen the update released for a signed-in account, it
// stays on until the page closes: a config or session refresh that fails
// for a moment must never uncover a locked screen.
export function PrivacyScreen({ config, user }) {
  const sticky = useRef({ on: false, user: null });
  if (privacyScreenReleased(config) && user?.id) {
    sticky.current.on = true;
    sticky.current.user = user.id;
  }
  const { on, user: userId } = sticky.current;
  const view = useSyncExternalStore(subscribe, getView, () => "shown");
  useLayoutEffect(() => {
    if (on) activate({ user: userId });
  }, [on, userId]);
  useLayoutEffect(() => () => activate(null), []);
  const layer = on ? coverLayer() : null;
  if (!layer) return null;
  return createPortal(
    view === "locked" ? (
      <LockScreen config={config} user={user} />
    ) : (
      <HiddenCover />
    ),
    layer,
  );
}

// Rendered all the time (into the layer, which is out of the document until
// the screen is hidden), so switching away shows it at once.
function HiddenCover() {
  return (
    <button type="button" className="privacy-cover" onClick={revealScreen}>
      <span className="privacy-cover-mark">
        <Mark />
      </span>
      <span className="privacy-cover-text">
        Hidden — press any key or tap to return
      </span>
    </button>
  );
}

const lockedMessage = (seconds) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return minutes === 1
    ? "Too many incorrect attempts. Try again in 1 minute, or sign out instead."
    : `Too many incorrect attempts. Try again in ${minutes} minutes, or sign out instead.`;
};

function LockScreen({ config, user }) {
  const [methods, setMethods] = useState(null),
    [password, setPassword] = useState(""),
    [code, setCode] = useState(""),
    [challenge, setChallenge] = useState(null),
    [busy, setBusy] = useState(""),
    [error, setError] = useState(""),
    [signedOut, setSignedOut] = useState(false),
    [attempt, setAttempt] = useState(0);
  const field = useRef(null);
  useEffect(() => {
    let live = true;
    setError("");
    api("/api/auth/unlock").then(
      (r) => {
        if (!live) return;
        setMethods(r.methods);
        if (r.retryAfter) setError(lockedMessage(r.retryAfter));
      },
      (e) => {
        if (!live) return;
        if (e.status === 401) setSignedOut(true);
        else setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [attempt]);
  useEffect(() => {
    field.current?.focus({ preventScroll: true });
  }, [methods, challenge, signedOut]);
  function failed(e) {
    if (e?.status === 401 && e.code === "authentication_required")
      return setSignedOut(true);
    setError(e?.message || "The request could not be completed.");
    setPassword("");
    setCode("");
    setTimeout(() => field.current?.focus({ preventScroll: true }), 0);
  }
  async function check(body) {
    setBusy("check");
    setError("");
    try {
      await api("/api/auth/unlock", { method: "POST", body });
      setPassword("");
      unlocked();
    } catch (e) {
      failed(e);
    } finally {
      setBusy("");
    }
  }
  async function sendCode() {
    setBusy("email");
    setError("");
    try {
      setChallenge(
        await api("/api/auth/unlock/start", {
          method: "POST",
          body: { method: "email" },
        }),
      );
    } catch (e) {
      failed(e);
    } finally {
      setBusy("");
    }
  }
  async function signWallet() {
    setBusy("wallet");
    setError("");
    try {
      await walletUnlock(config, user?.wallet);
      unlocked();
    } catch (e) {
      failed(e);
    } finally {
      setBusy("");
    }
  }
  // Only once the session is really gone: a failed sign-out keeps the lock.
  async function signOut() {
    setBusy("signout");
    setError("");
    try {
      await api("/api/auth/logout", { method: "POST", body: {} });
    } catch (e) {
      setBusy("");
      if (e?.status === 401) return leaveToSignIn();
      setError(e?.message || "The request could not be completed.");
      return;
    }
    leaveToSignIn();
  }
  let body;
  if (signedOut)
    body = (
      <>
        <p>You’re signed out. Sign in again to continue.</p>
        <Button
          type="button"
          ref={field}
          className="privacy-lock-wide"
          onClick={leaveToSignIn}
        >
          Sign in
        </Button>
      </>
    );
  else if (!methods)
    body = error ? (
      <Button
        type="button"
        secondary
        className="privacy-lock-wide"
        onClick={() => setAttempt((n) => n + 1)}
      >
        <Icon name="refresh" size={15} /> Try again
      </Button>
    ) : (
      <p className="privacy-lock-quiet">Checking how to unlock…</p>
    );
  else if (methods.includes("password"))
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (password && !busy) check({ method: "password", password });
        }}
      >
        {/* For password managers only; never shown. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          data-i18n="off"
          value={user?.username || ""}
          readOnly
          hidden
        />
        <label className="privacy-lock-field">
          Your password
          <input
            ref={field}
            name="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            maxLength="256"
            required
          />
        </label>
        <Button className="privacy-lock-wide" disabled={!!busy || !password}>
          <Icon name="unlock" size={16} />{" "}
          {busy === "check" ? "Checking…" : "Unlock"}
        </Button>
      </form>
    );
  else if (challenge)
    body = (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (code.length === 6 && !busy)
            check({ method: "email", id: challenge.id, code });
        }}
      >
        <p className="privacy-lock-quiet">
          Enter the code from your email. It expires after 10 minutes.
          {challenge.testCode &&
            ` Local test mode: no email was sent; your code is ${challenge.testCode}.`}
        </p>
        <label className="privacy-lock-field">
          Email code
          <input
            ref={field}
            name="code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]{6}"
            maxLength="6"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            required
          />
        </label>
        <Button
          className="privacy-lock-wide"
          disabled={!!busy || code.length !== 6}
        >
          <Icon name="unlock" size={16} />{" "}
          {busy === "check" ? "Checking…" : "Unlock"}
        </Button>
      </form>
    );
  else
    body = (
      <div className="privacy-lock-choices">
        {methods.includes("wallet") && (
          <Button
            type="button"
            ref={field}
            className="privacy-lock-wide"
            disabled={!!busy || !walletAvailable(config)}
            onClick={signWallet}
          >
            {busy === "wallet" ? "Waiting for your wallet…" : "Sign with your wallet"}
          </Button>
        )}
        {methods.includes("email") && (
          <Button
            type="button"
            secondary={methods.includes("wallet")}
            ref={methods.includes("wallet") ? undefined : field}
            className="privacy-lock-wide"
            disabled={!!busy}
            onClick={sendCode}
          >
            Email me a code
          </Button>
        )}
        {methods.includes("wallet") && (
          <p className="privacy-lock-quiet">
            The wallet signs a one-time message. It authorizes no transaction
            and can’t be used to sign in.
          </p>
        )}
      </div>
    );
  return (
    <div
      className="privacy-cover privacy-lock"
      role="dialog"
      aria-modal="true"
      aria-labelledby="privacy-lock-title"
    >
      <div className="privacy-lock-card">
        <span className="privacy-lock-mark">
          <Mark />
        </span>
        <p className="eyebrow">PRIVACY SCREEN</p>
        <h1 id="privacy-lock-title">Locked.</h1>
        {!signedOut && (
          <p>
            Locked while you were away. Your chats are still here; unlock to
            see them.
          </p>
        )}
        {error && <Notice type="error">{error}</Notice>}
        {body}
        {!signedOut && (
          <button
            type="button"
            className="privacy-lock-signout"
            disabled={!!busy}
            onClick={signOut}
          >
            <Icon name="logout" size={14} />{" "}
            {busy === "signout" ? "Signing out…" : "Sign out instead"}
          </button>
        )}
      </div>
    </div>
  );
}

// The header's Hide button, next to the Command Palette's.
export function HideScreenButton({ config, user }) {
  if (!privacyScreenReleased(config) || !user) return null;
  return (
    <button
      type="button"
      className="privacy-hide-button"
      aria-label="Hide the screen"
      aria-keyshortcuts="Escape Escape"
      title="Hide the screen (Esc twice)"
      onClick={hideScreen}
    >
      <Icon name="eyeoff" size={15} />
      <span>Hide</span>
    </button>
  );
}

// Account → Account settings. Per browser, so nothing is sent or saved.
export function PrivacyScreenSettings({ config, user }) {
  const s = useSyncExternalStore(subscribe, getSettings, getSettings);
  if (!privacyScreenReleased(config) || !user) return null;
  return (
    <section id="privacy-screen" className="privacy-screen-settings">
      <div>
        <h2>Privacy Screen.</h2>
        <p>
          Press Esc twice, or Hide at the top of the page, and your chats leave
          the screen until you press a key or tap. These choices apply to this
          browser only.
        </p>
      </div>
      <div className="privacy-screen-options">
        <label className="privacy-screen-row">
          <input
            type="checkbox"
            checked={s.blur}
            onChange={(e) => saveSettings({ blur: e.target.checked })}
          />
          <span>
            <b>Hide when I switch away</b>
            <small>
              Covers the screen when you switch to another tab or app, and keeps
              your chats out of app-switcher previews where the browser allows.
            </small>
          </span>
        </label>
        <label className="privacy-screen-row privacy-screen-idle">
          <span>
            <b>Lock after idle</b>
            <small>
              After no typing, clicking or scrolling for this long. Locking
              doesn’t sign you out: unlock with your password, or with an email
              code or wallet signature if your account has no password.
            </small>
          </span>
          <select
            value={s.idle}
            onChange={(e) => saveSettings({ idle: Number(e.target.value) })}
          >
            <option value="0">Off</option>
            <option value="5">After 5 minutes</option>
            <option value="15">After 15 minutes</option>
            <option value="60">After 1 hour</option>
          </select>
        </label>
        <p className="privacy-screen-honest">
          <Icon name="shield" size={15} />
          <span>
            {isReleased(config, "vault")
              ? "Privacy Screen hides your screen from people nearby. It isn't encryption; for chats that never leave this device, use Device Vault."
              : "Privacy Screen hides your screen from people nearby. It isn't encryption."}
          </span>
        </p>
      </div>
    </section>
  );
}
