import React, { useEffect, useMemo, useState } from "react";
import { Icon, Notice } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import { scanParts, secretGuardActive } from "./secret-guard.js";
import "./seed-guard.css";
import "./secret-guard.css";

// Secret Guard (src/secret-guard.js): passwords, API keys and tokens are
// spotted in this tab before a message, Canvas suggestion, routine or
// research watch is sent or saved, and the person chooses: mask them (a
// placeholder like [SECRET_1] goes instead, and the reply shows the value
// again in this browser only), remove them, or send anyway for this one
// time. It's a soft guard, so there's no server check: nothing about a
// match is logged, stored or sent, and the notice shows each one only
// partly (its first 4 and last 2 characters).
// On by default; Account → Security can switch it off per account. Seed
// Guard's hard block for wallet seed phrases is separate and always first.
export const secretGuardReleased = (config) => isReleased(config, "secretguard");

// The account's switch, read once per page load and shared by every surface
// (/api/secret-guard). Until it's read, the guard is on.
const setting = { user: null, enabled: true, loaded: false, loading: null, subs: new Set() };
const publish = () => setting.subs.forEach((f) => f());
function loadSetting(userId) {
  if ((setting.user === userId && setting.loaded) || setting.loading?.user === userId) return;
  const loading = { user: userId };
  setting.loading = loading;
  api("/api/secret-guard")
    .then((r) => {
      if (setting.loading !== loading) return;
      Object.assign(setting, { user: userId, enabled: r?.enabled !== false, loaded: true });
      publish();
    })
    .catch(() => {})
    .finally(() => {
      if (setting.loading === loading) setting.loading = null;
    });
}
function rememberSetting(userId, enabled) {
  Object.assign(setting, { user: userId, enabled, loaded: true, loading: null });
  publish();
}
function useSetting(live, userId) {
  const [, tick] = useState(0);
  useEffect(() => {
    const f = () => tick((n) => n + 1);
    setting.subs.add(f);
    return () => setting.subs.delete(f);
  }, []);
  useEffect(() => {
    if (live && userId) loadSetting(userId);
  }, [live, userId]);
  return setting.user === userId && setting.loaded ? setting.enabled : true;
}

// Whether Secret Guard checks what this person sends: released, signed in,
// not the demo, and not switched off for the account.
export function useSecretGuard(config, user, demo = false) {
  const released = secretGuardReleased(config) && !demo && !!user?.id;
  const enabled = useSetting(released, user?.id);
  return secretGuardActive({ released, demo, enabled });
}

// The finds in what a surface is about to send. Pass a stable array or
// string (useMemo) so large attachments are scanned only when they change.
export function useSecretScan(active, parts) {
  return useMemo(() => (active ? scanParts(parts) : []), [active, parts]);
}

const VERBS = {
  send: { mask: "Mask and send", anyway: "Send anyway" },
  save: { mask: "Mask and save", anyway: "Save anyway" },
};
const where = (f) => (f.name ? `line ${f.line} of ${f.name}` : `line ${f.line}`);
export function secretHeadline(finds) {
  if (finds.length !== 1) return `These look like ${finds.length} secrets.`;
  const f = finds[0];
  return f.name
    ? `This looks like a secret (${f.label}, line ${f.line} of ${f.name}).`
    : `This looks like a secret (${f.label}, line ${f.line}).`;
}
const SHOWN = 6;

// The notice. `onMask` is the default; `onRemove` and `onProceed` ("Send
// anyway", this time only) are offered when passed. `note` says what masking
// means on this surface.
export function SecretGuardNotice({
  finds,
  verb = "send",
  busy = false,
  onMask,
  onRemove,
  onProceed,
  note = "Mask swaps each one for a placeholder like [SECRET_1] before anything leaves this browser. The reply shows your value again, here only.",
}) {
  if (!finds?.length) return null;
  const words = VERBS[verb] || VERBS.send;
  const many = finds.length > 1;
  return (
    <div className="seed-guard secret-guard" role="alert">
      <span className="seed-guard-tile" aria-hidden="true">
        <Icon name="key" size={16} />
      </span>
      <div className="seed-guard-body">
        <p className="seed-guard-eyebrow">SECRET GUARD</p>
        <p className="seed-guard-message">{secretHeadline(finds)}</p>
        <ul className="secret-guard-list">
          {finds.slice(0, SHOWN).map((f, i) => (
            <li key={i}>
              {many && <b>{f.label}</b>}
              {many && <span>{where(f)}</span>}
              <code data-i18n="off">{f.preview}</code>
            </li>
          ))}
          {finds.length > SHOWN && <li className="secret-guard-more">{`and ${finds.length - SHOWN} more`}</li>}
        </ul>
        {note && <p className="seed-guard-note">{note}</p>}
        <p className="seed-guard-note">Checked in this browser. Nothing about it is saved or sent.</p>
        <div className="seed-guard-actions">
          {onMask && (
            <button type="button" className="seed-guard-button solid" disabled={busy} onClick={onMask}>
              {words.mask}
            </button>
          )}
          {onRemove && (
            <button type="button" className="seed-guard-button" disabled={busy} onClick={onRemove}>
              {many ? "Remove them" : "Remove it"}
            </button>
          )}
          {onProceed && (
            <button type="button" className="seed-guard-button" disabled={busy} onClick={onProceed}>
              {words.anyway}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// Account → Security: the per-account switch. Switching it off asks once,
// with a plain warning; switching it on doesn't.
export function SecretGuardSettings({ config, user, demo = false }) {
  const live = secretGuardReleased(config) && (demo || !!user);
  const enabled = useSetting(live && !demo, user?.id);
  const [on, setOn] = useState(true),
    [confirming, setConfirming] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  useEffect(() => {
    if (!demo) setOn(enabled);
  }, [enabled, demo]);
  if (!live) return null;
  async function change(next) {
    setError("");
    setSaved("");
    setConfirming(false);
    if (demo) {
      setOn(next);
      return;
    }
    setBusy(true);
    try {
      const r = await api("/api/secret-guard", { method: "PUT", body: { enabled: next } });
      rememberSetting(user.id, r.enabled !== false);
      setOn(r.enabled !== false);
      setSaved(r.enabled !== false ? "On. Secrets are caught before they're sent." : "Off. Messages are sent as written.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="settings-stack two-step secret-guard-settings" id="secret-guard">
      <section>
        <div>
          <h2>Secret Guard.</h2>
          <p>
            Catches passwords, API keys and tokens in what you type, paste or attach, before it’s sent, and offers to
            mask them. It’s checked in your browser: nothing about a match is saved or sent.
          </p>
          <p>
            It looks for known key formats and labelled values like PASSWORD=, so it can’t catch every secret. It
            doesn’t check the developer API (/v1) or MCP: those callers are programs, and holding their requests would
            break them.
          </p>
        </div>
        <div className="secret-guard-settings-body">
          {error && <Notice type="error">{error}</Notice>}
          <label className="secret-guard-row">
            <input
              type="checkbox"
              role="switch"
              checked={on}
              disabled={busy}
              onChange={(e) => (e.target.checked ? change(true) : setConfirming(true))}
            />
            <span>
              <b>Check what I send for secrets</b>
              <small>
                On by default. The chat composer (and Code & Build), attached text files, Canvas, Routines and Research
                Watch.
              </small>
            </span>
          </label>
          {confirming && (
            <div className="secret-guard-confirm" role="group" aria-label="Turn off Secret Guard">
              <p>
                Turn off Secret Guard? Passwords, keys and tokens you paste will be sent as written. Seed Guard still
                stops wallet seed phrases.
              </p>
              <div className="seed-guard-actions">
                <button type="button" className="seed-guard-button solid" disabled={busy} onClick={() => change(false)}>
                  Turn off
                </button>
                <button type="button" className="seed-guard-button" disabled={busy} onClick={() => setConfirming(false)}>
                  Keep it on
                </button>
              </div>
            </div>
          )}
          {!on && !confirming && (
            <p className="secret-guard-off">
              Off: passwords, keys and tokens you paste are sent as written. Seed Guard still stops wallet seed
              phrases.
            </p>
          )}
          {saved && (
            <p className="secret-guard-saved" role="status">
              {saved}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
