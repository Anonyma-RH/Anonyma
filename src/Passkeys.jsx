import React, { useEffect, useState } from "react";
import { Icon, Button, Notice } from "./ui.jsx";
import { api } from "./lib.js";
import { ConfirmItsYou } from "./TwoStep.jsx";
import {
  PASSKEY_LIMIT,
  PASSKEY_NAME_MAX,
  addPasskey,
  browserSupportsPasskeys,
  confirmWithPasskey,
  defaultPasskeyName,
  nameInput,
  onlyWayIn,
  passkeyError,
  passkeySignIn,
  passkeySignUp,
} from "./passkeys.js";
import "./passkeys.css";

// Passkeys (server/passkeys.js, server/routes/passkeys.js). Account →
// Security holds PasskeySettings; the sign-in page's Passkey tab is
// PasskeyAuth.

const day = (t) => new Date(t).toLocaleDateString();

// A sample list for the demo account; nothing here reaches a server.
const DEMO = [
  { id: "demo-1", name: "iPhone", created: Date.now() - 12 * 86400000, lastUsed: Date.now() - 3600000, synced: true },
  { id: "demo-2", name: "YubiKey", created: Date.now() - 40 * 86400000, lastUsed: null, synced: false },
];

function PasskeyRow({ p, busy, canRemove, onRename, onRemove }) {
  const [mode, setMode] = useState(null),
    [name, setName] = useState(p.name);
  return (
    <li className="passkey-row">
      <span className="passkey-glyph" aria-hidden="true">
        <Icon name="fingerprint" size={20} />
      </span>
      <div className="passkey-main">
        {mode === "rename" ? (
          <form
            className="passkey-rename"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await onRename(p, name.trim())) setMode(null);
            }}
          >
            <label>
              <span className="sr-only">Passkey name</span>
              <input
                value={name}
                onChange={(e) => setName(nameInput(e.target.value))}
                maxLength={PASSKEY_NAME_MAX}
                required
                autoFocus
              />
            </label>
            <button className="small-button" disabled={busy || !name.trim()}>
              Save
            </button>
            <button
              type="button"
              className="small-button"
              onClick={() => {
                setName(p.name);
                setMode(null);
              }}
            >
              Cancel
            </button>
          </form>
        ) : (
          <b data-i18n="off">{p.name}</b>
        )}
        {/* One string, so the Chinese switch translates it as a whole. */}
        <small>
          {p.lastUsed
            ? `Added ${day(p.created)} · Last used ${day(p.lastUsed)}`
            : `Added ${day(p.created)} · Not used yet`}
        </small>
        {mode === "remove" && (
          <div className="passkey-remove">
            <p>
              You won’t be able to sign in with this passkey. It stays saved on
              the device until you delete it there too.
            </p>
            <div className="inline-actions">
              <button
                type="button"
                className="small-button danger-text"
                disabled={busy}
                onClick={async () => {
                  if (await onRemove(p)) setMode(null);
                }}
              >
                Remove passkey
              </button>
              <button type="button" className="small-button" onClick={() => setMode(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
      <span className={"allowance-tag passkey-tag" + (p.synced ? " on" : "")}>
        {p.synced ? "Synced" : "This device only"}
      </span>
      {!mode && (
        <div className="passkey-actions">
          <button type="button" className="small-button" disabled={busy} onClick={() => setMode("rename")}>
            Rename
          </button>
          {canRemove && (
            <button
              type="button"
              className="small-button danger-text"
              disabled={busy}
              onClick={() => setMode("remove")}
            >
              Remove
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function PasskeySettings({ user, demo = false, config }) {
  const supported = browserSupportsPasskeys();
  const [status, setStatus] = useState(demo ? { data: DEMO, max: PASSKEY_LIMIT, available: true, methods: { password: true, passkeys: 2 } } : null),
    [name, setName] = useState(() => defaultPasskeyName()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    // What's waiting for "confirm it's you": "add", or a passkey to remove.
    [reauth, setReauth] = useState(null);
  useEffect(() => {
    if (demo || !user) return;
    api("/api/account/passkeys")
      .then(setStatus)
      .catch((e) => setError(e.message));
  }, [demo, user?.id]);
  const confirmed = () => !!status?.reauthUntil && status.reauthUntil > Date.now();
  async function run(fn, step) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      return true;
    } catch (e) {
      // The 10-minute confirmation lapsed: confirm again, then carry on.
      if (e.code === "passkey_reauth_required") {
        setStatus((s) => ({ ...s, reauthUntil: null }));
        setReauth(step);
      } else setError(passkeyError(e));
      return false;
    } finally {
      setBusy(false);
    }
  }
  const add = () =>
    run(async () => {
      const r = await addPasskey(name.trim() || defaultPasskeyName());
      setStatus(r);
      // Cleared, so a second passkey isn't saved under the same name.
      setName("");
      setNotice("Passkey added. Next time, sign in with it: no password needed.");
    }, "add");
  const remove = (p) =>
    run(async () => {
      setStatus(await api(`/api/account/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }));
      setNotice("Passkey removed.");
    }, p);
  const rename = (p, next) =>
    run(async () => {
      setStatus(
        await api(`/api/account/passkeys/${encodeURIComponent(p.id)}`, {
          method: "PATCH",
          body: { name: next },
        }),
      );
    });
  function reauthDone(until) {
    const step = reauth;
    setStatus((s) => ({ ...s, reauthUntil: until }));
    setReauth(null);
    // Removing carries on at once. A new passkey waits for a tap, since
    // some browsers only open the passkey prompt right after one.
    if (step && step !== "add") remove(step);
    else setNotice("Confirmed. Now add your passkey.");
  }

  let body;
  if (!status) body = !error && <p className="fine-print">Loading…</p>;
  else if (reauth)
    body = (
      <ConfirmItsYou
        methods={status.reauthMethods || []}
        config={config}
        user={user}
        intro="Adding or removing a passkey needs a fresh confirmation from this session."
        onPasskey={async () => (await confirmWithPasskey()).reauthUntil}
        passkeyError={passkeyError}
        onDone={reauthDone}
        onCancel={() => setReauth(null)}
      />
    );
  else {
    const list = status.data || [];
    const full = list.length >= (status.max || PASSKEY_LIMIT);
    const last = onlyWayIn(status.methods);
    const blocked = demo || !user || !status.available || !supported;
    body = (
      <>
        {list.length ? (
          <ul className="passkey-list">
            {list.map((p) => (
              <PasskeyRow
                key={p.id + p.name}
                p={p}
                busy={busy || demo}
                canRemove={!last}
                onRename={rename}
                onRemove={(x) => (confirmed() ? remove(x) : (setReauth(x), false))}
              />
            ))}
          </ul>
        ) : (
          <p className="passkey-empty">
            No passkeys yet. Add one and sign in with Face ID, your fingerprint
            or your device’s PIN.
          </p>
        )}
        {last && list.length > 0 && (
          <p className="fine-print">
            This passkey is your only way to sign in, so it can’t be removed.
            Add another passkey, link an email or link a wallet first.
          </p>
        )}
        {demo && <Notice>Sign in to a real account to add a passkey.</Notice>}
        {!demo && !status.available && (
          <Notice>Passkeys need this site on a domain name over HTTPS.</Notice>
        )}
        {!demo && status.available && !supported && (
          <Notice>This browser can’t use passkeys. Try a current browser, or your phone.</Notice>
        )}
        <form
          className="passkey-add"
          onSubmit={(e) => {
            e.preventDefault();
            if (confirmed()) add();
            else setReauth("add");
          }}
        >
          <label className="two-step-field">
            Name this passkey
            <input
              value={name}
              onChange={(e) => setName(nameInput(e.target.value))}
              maxLength={PASSKEY_NAME_MAX}
              placeholder="e.g. iPhone"
              disabled={blocked || full}
            />
          </label>
          <Button disabled={busy || blocked || full}>
            <Icon name="fingerprint" size={16} />
            {busy ? "Waiting for your device…" : "Add a passkey"}
          </Button>
        </form>
        <p className="fine-print">
          {full
            ? `You have ${list.length} of ${status.max || PASSKEY_LIMIT} passkeys. Remove one to add another.`
            : `${list.length} of ${status.max || PASSKEY_LIMIT} passkeys`}
        </p>
      </>
    );
  }

  return (
    <div className="settings-stack two-step passkeys">
      <section>
        <div>
          <h2>Passkeys.</h2>
          <p>
            Sign in with Face ID, your fingerprint or your device’s PIN. Your
            device keeps the private key and ANONYMA stores only the public
            one, so there’s no password to leak and no email needed.
          </p>
          <p>
            A passkey sign-in counts as both steps of two-step sign-in: your
            device already checked it’s you, so ANONYMA doesn’t ask for an
            authenticator code.
          </p>
          <p>
            Adding or removing one asks you to confirm it’s you first. Your data
            export lists each passkey’s name and dates, never its keys.
          </p>
        </div>
        <div className="two-step-body">
          {notice && <Notice>{notice}</Notice>}
          {error && <Notice type="error">{error}</Notice>}
          {body}
        </div>
      </section>
    </div>
  );
}

// The sign-in page's Passkey tab: sign in with any passkey (no username),
// or on the register page, a username and a passkey (no password, no email).
// `onSignedIn` runs once a session exists.
export function PasskeyAuth({ register = false, connected, onSignedIn }) {
  const supported = browserSupportsPasskeys();
  const [username, setUsername] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function go(e) {
    e?.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (register) await passkeySignUp(username, defaultPasskeyName());
      else await passkeySignIn();
      await onSignedIn();
    } catch (err) {
      setError(passkeyError(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="passkey-auth" onSubmit={go}>
      <div className="passkey-hero" aria-hidden="true">
        <Icon name="fingerprint" size={34} />
      </div>
      <p className="passkey-lede">
        {register
          ? "Pick a username. Your device’s Face ID, fingerprint or PIN is your sign-in: no password, no email."
          : "Use Face ID, your fingerprint or your device’s PIN. No username or password to type."}
      </p>
      {register && (
        <label>
          Username
          <input
            name="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
            minLength="3"
            maxLength="32"
            pattern="[A-Za-z0-9_.\-]+"
            placeholder="Your username"
          />
        </label>
      )}
      {!supported && <Notice>This browser can’t use passkeys. Try a current browser, or your phone.</Notice>}
      {error && <Notice type="error">{error}</Notice>}
      <Button type="submit" disabled={busy || !connected || !supported}>
        <Icon name="fingerprint" size={16} />
        {busy
          ? "Waiting for your device…"
          : register
            ? "Create an account with a passkey"
            : "Sign in with a passkey"}
      </Button>
      <p className="fine-print">
        {register
          ? "Your passkey is saved on this device or in your passkey manager. Keep it: without a password or email, it’s how you get back in."
          : "Your face or fingerprint never leaves your device. ANONYMA only checks a signature."}
      </p>
    </form>
  );
}
