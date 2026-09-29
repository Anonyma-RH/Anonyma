import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { Button, Icon, Notice } from "./ui.jsx";
import { api, isReleased, readStore, saveStore } from "./lib.js";
import { t } from "./i18n.js";
import {
  SUGGESTED_CREDITS,
  THRESHOLD_RULE,
  EMPTY_MEMORY,
  bannerFor,
  cleanMemory,
  dismissBanner,
  isInsufficientMessage,
  notificationText,
  notifiedMemory,
  observe,
  parseThreshold,
  shouldNotify,
  showCredits,
  toUnits,
} from "./balance-alerts.js";
import "./balance-alerts.css";

// Low-Balance Alerts in the browser (rules in balance-alerts.js; the setting
// itself is server/balance-alerts.js):
// - LowBalanceBanner: the workspace and dashboard warning, with Top up.
// - LowBalanceRefusal: Top up beside a "Not enough credits" refusal.
// - BalanceAlertSettings: the Account panel that sets the level.
// - BalanceAlertWatch: the optional notification, on Account pages.
// No polling: the banner and the notification follow the balance the app
// already refreshes after each request (context.jsx refresh()).
export const alertsReleased = (config) => isReleased(config, "balancealerts");

// ---- The account's setting, shared by every component in this tab ----
let cache = { key: null, view: null };
let loading = null;
const listeners = new Set();
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => cache;
const serverSnapshot = () => ({ key: null, view: null });
export function setAlertView(userId, view) {
  cache = { key: userId, view };
  listeners.forEach((fn) => fn());
}
function load(userId) {
  if (loading === userId) return;
  loading = userId;
  api("/api/balance-alert")
    .then((view) => {
      if (loading === userId) setAlertView(userId, view);
    })
    .catch(() => {})
    .finally(() => {
      if (loading === userId) loading = null;
    });
}
// The signed-in account's alert (GET /api/balance-alert), fetched once per
// account per tab and kept current by the Account panel's saves.
export function useAlertSetting(config, user, demo) {
  const live = alertsReleased(config) && !demo && !!user?.id;
  const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    if (live && cache.key !== user.id) load(user.id);
  }, [live, user?.id]);
  return live && current.key === user.id ? current.view : null;
}

// ---- What this browser remembers (dismissal, notification sent) ----
const memoryKey = (userId) => "balance-alert:" + userId;
const readMemory = (userId) =>
  userId ? cleanMemory(readStore(memoryKey(userId), EMPTY_MEMORY)) : { ...EMPTY_MEMORY };
function writeMemory(userId, next) {
  const before = JSON.stringify(readMemory(userId));
  if (JSON.stringify(next) === before) return;
  saveStore(memoryKey(userId), next);
  memoryListeners.forEach((fn) => fn());
}
const memoryListeners = new Set();
// Re-renders when this tab or another one (the storage event) changes it.
function useMemory(userId) {
  const [, bump] = useState(0);
  useEffect(() => {
    const again = () => bump((n) => n + 1);
    memoryListeners.add(again);
    window.addEventListener("storage", again);
    return () => {
      memoryListeners.delete(again);
      window.removeEventListener("storage", again);
    };
  }, []);
  return readMemory(userId);
}

export const notificationPermission = () =>
  typeof window !== "undefined" && "Notification" in window
    ? window.Notification.permission
    : "unsupported";
// Asked only from a click (never on load); resolves "granted", "denied",
// "default" or "unsupported".
export async function askPermission() {
  if (notificationPermission() === "unsupported") return "unsupported";
  if (window.Notification.permission !== "default")
    return window.Notification.permission;
  try {
    return await new Promise((resolve) => {
      const p = window.Notification.requestPermission(resolve);
      if (p?.then) p.then(resolve, () => resolve(window.Notification.permission));
    });
  } catch {
    return window.Notification.permission;
  }
}
function notifyLow(available, threshold) {
  const text = notificationText({ available, threshold });
  try {
    const n = new window.Notification(t(text.title), {
      body: t(text.body),
      tag: "anonyma-low-balance",
      icon: "/brand/official/ionic-icon-180.png",
    });
    n.onclick = () => {
      window.focus();
      n.close();
    };
    return true;
  } catch {
    return false;
  }
}

// The last available balance this tab saw, per account: a crossing is only
// ever seen between two readings in the same tab, never on page load.
const lastSeen = { userId: null, available: null };
export function useLowBalanceWatch(user, view) {
  const available = user ? toUnits(user.available) : null;
  useEffect(() => {
    if (!user?.id || !Number.isFinite(available)) return;
    const previous = lastSeen.userId === user.id ? lastSeen.available : null;
    lastSeen.userId = user.id;
    lastSeen.available = available;
    if (!view?.enabled) return;
    const threshold = toUnits(view.threshold);
    let memory = observe(readMemory(user.id), { threshold, available });
    if (
      shouldNotify({
        previous,
        available,
        threshold,
        notify: view.notify,
        permission: notificationPermission(),
        memory,
      }) &&
      notifyLow(Number(user.available), Number(view.threshold))
    )
      memory = notifiedMemory(memory, threshold);
    writeMemory(user.id, memory);
  }, [user?.id, available, view?.enabled, view?.threshold, view?.notify]);
}

// Only the watch, for pages without the banner (Account).
export function BalanceAlertWatch({ config, user, demo }) {
  useLowBalanceWatch(user, useAlertSetting(config, user, demo));
  return null;
}

// ---- The banner: workspace and dashboard ----
export function LowBalanceBanner({ config, user, demo }) {
  const view = useAlertSetting(config, user, demo);
  useLowBalanceWatch(user, view);
  const memory = useMemory(user?.id);
  if (!view?.enabled || !user) return null;
  const threshold = toUnits(view.threshold);
  const available = toUnits(user.available);
  const banner = bannerFor({ threshold, available, memory, at: Date.now() });
  if (!banner) return null;
  const held = Number(user.held) || 0;
  return (
    <LowBalanceNotice
      empty={banner.empty}
      available={Number(user.available)}
      threshold={Number(view.threshold)}
      held={held}
      onDismiss={() =>
        writeMemory(
          user.id,
          dismissBanner(memory, { threshold, available, at: Date.now() }),
        )
      }
    />
  );
}
// The banner's markup on its own, for the Account preview and tests.
export function LowBalanceNotice({ empty, available, threshold, held, onDismiss, q = "" }) {
  return (
    <div
      className={"low-balance" + (empty ? " empty" : "")}
      role="status"
      data-testid="low-balance"
    >
      <span className="low-balance-mark" aria-hidden="true" />
      <p>
        <b>{empty ? "Out of credits." : "Low balance."}</b>{" "}
        <span>
          {empty
            ? "No credits available. Top up to keep going."
            : `${showCredits(available)} credits available, below your alert at ${showCredits(threshold)} credits.`}
        </span>
        {held > 0 && (
          <>
            {" "}
            <span>{`${showCredits(held)} more are on hold for requests in progress.`}</span>
          </>
        )}
      </p>
      <div className="low-balance-actions">
        <Link className="low-balance-topup" to={"/account/credits" + q}>
          Top up
        </Link>
        <Link className="low-balance-settings" to={"/account/credits" + q + "#balance-alert"}>
          Alert settings
        </Link>
        {onDismiss && (
          <button
            type="button"
            className="low-balance-dismiss"
            aria-label="Dismiss the low-balance warning"
            onClick={onDismiss}
          >
            <Icon name="close" size={14} />
            <span>Dismiss</span>
          </button>
        )}
      </div>
    </div>
  );
}

// ---- Beside a refusal for too few credits ----
export function LowBalanceRefusal({ config, user, demo, error }) {
  if (!alertsReleased(config) || !isInsufficientMessage(error)) return null;
  return (
    <span className="low-balance-inline">
      {user && !demo && (
        <span>{`${showCredits(user.available)} credits available.`}</span>
      )}
      <Link to={"/account/credits" + (demo ? "?demo=1" : "")}>Top up</Link>
    </span>
  );
}

// ---- The Account panel (Credits & funding) ----
const DEMO_VIEW = {
  enabled: true,
  threshold: SUGGESTED_CREDITS,
  notify: false,
  available: 1000,
  below: false,
  suggested: SUGGESTED_CREDITS,
};
const PERMISSION_TEXT = {
  granted: "This browser will show the notification.",
  denied:
    "Notifications are blocked for this site. Allow them in your browser's site settings to get one.",
  default: "Your browser will ask for permission when you tick this box.",
  unsupported: "This browser can't show notifications. The workspace banner still works.",
};
const usd = (credits) =>
  (Number(credits) / 1000).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

// The form's editable copy of a stored setting.
const draftOf = (view) => ({
  on: view.enabled,
  level: String(view.enabled ? view.threshold : (view.suggested ?? SUGGESTED_CREDITS)),
  notify: view.notify,
});

export function BalanceAlertSettings({ config, user, demo }) {
  const stored = useAlertSetting(config, user, demo);
  const [demoView, setDemoView] = useState(DEMO_VIEW);
  const view = demo ? demoView : stored;
  const [draft, setDraft] = useState(() => (view ? draftOf(view) : null));
  const [permission, setPermission] = useState(notificationPermission);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  // A fresh draft whenever the stored setting changes (a save, a sign-in).
  useEffect(() => {
    if (view) setDraft(draftOf(view));
  }, [view?.enabled, view?.threshold, view?.notify]);
  useEffect(() => setPermission(notificationPermission()), []);

  async function toggleNotify(e) {
    const want = e.target.checked;
    setError("");
    setNotice("");
    if (!want) return setDraft((d) => ({ ...d, notify: false }));
    // The permission prompt only ever comes from this click.
    const answer = await askPermission();
    if (!alive.current) return;
    setPermission(answer);
    if (answer === "granted") setDraft((d) => ({ ...d, notify: true }));
    else setError(PERMISSION_TEXT[answer] || PERMISSION_TEXT.denied);
  }
  async function allowHere() {
    const answer = await askPermission();
    if (alive.current) setPermission(answer);
  }
  async function save(e) {
    e.preventDefault();
    if (!view || !draft) return;
    setError("");
    setNotice("");
    let body;
    if (!draft.on) body = { threshold: null };
    else {
      const level = parseThreshold(draft.level);
      if (level == null) return setError(THRESHOLD_RULE);
      body = { threshold: level, notify: draft.notify };
    }
    setBusy(true);
    try {
      let result;
      if (demo) {
        result = {
          ...demoView,
          enabled: body.threshold != null,
          threshold: body.threshold,
          notify: body.threshold != null && !!body.notify,
        };
        setDemoView(result);
      } else {
        result = await api("/api/balance-alert", { method: "PATCH", body });
        setAlertView(user.id, result);
      }
      if (!alive.current) return;
      setNotice(
        result.enabled
          ? `Alert on: you'll be warned below ${showCredits(result.threshold)} credits.`
          : "Alert off. No low-balance warnings will show.",
      );
    } catch (err) {
      if (alive.current) setError(err.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const level = draft ? parseThreshold(draft.level) : null;
  return (
    <form className="form-panel balance-alert" id="balance-alert" onSubmit={save}>
      <h2>Low-balance alert</h2>
      <p>
        Get a heads-up before you run out. The alert watches your available
        balance: your credits minus any on hold for requests in progress.
      </p>
      {error && <Notice type="error">{error}</Notice>}
      {notice && <Notice>{notice}</Notice>}
      {!view || !draft ? (
        <p className="balance-alert-hint">Loading your alert…</p>
      ) : (
        <>
          <label className="balance-alert-check">
            <input
              type="checkbox"
              checked={draft.on}
              onChange={(e) => {
                const on = e.target.checked;
                setDraft((d) => ({
                  ...d,
                  on,
                  level: on && !d.level ? String(SUGGESTED_CREDITS) : d.level,
                }));
              }}
            />
            <span>Warn me when my available balance drops below</span>
          </label>
          <label className="balance-alert-level">
            <span>Alert level (credits)</span>
            <input
              type="number"
              min="1"
              step="any"
              inputMode="decimal"
              value={draft.level}
              disabled={!draft.on}
              aria-invalid={draft.on && level == null ? "true" : undefined}
              onChange={(e) => setDraft((d) => ({ ...d, level: e.target.value }))}
            />
          </label>
          <p className="balance-alert-hint">
            {draft.on && level != null
              ? `About $${usd(level)}. We suggest ${SUGGESTED_CREDITS.toLocaleString()} credits: one long reply from a large model can hold over 100.`
              : `We suggest ${SUGGESTED_CREDITS.toLocaleString()} credits: one long reply from a large model can hold over 100.`}
          </p>
          <label className="balance-alert-check">
            <input
              type="checkbox"
              checked={draft.on && draft.notify}
              disabled={!draft.on || permission === "unsupported"}
              onChange={toggleNotify}
            />
            <span>Also show a browser notification</span>
          </label>
          <p className="balance-alert-hint">
            {PERMISSION_TEXT[permission] || PERMISSION_TEXT.default}{" "}
            {view.notify && permission === "default" && (
              <button type="button" className="small-button" onClick={allowHere}>
                Allow in this browser
              </button>
            )}
          </p>
          <Button disabled={busy}>
            {busy ? "Saving…" : "Save alert"}
            <Icon name="arrow" />
          </Button>
          {!demo && view.enabled && (
            <p className="balance-alert-now">
              {Number(user?.available ?? view.available) < Number(view.threshold)
                ? `Now: ${showCredits(user?.available ?? view.available)} credits available, below your alert.`
                : `Now: ${showCredits(user?.available ?? view.available)} credits available, above your alert.`}
            </p>
          )}
          <ul className="balance-alert-notes">
            <li>
              A banner shows in the workspace, with a Top up button. Dismiss it
              and it stays away until your balance drops further, or until
              tomorrow.
            </li>
            {isReleased(config, "pushalerts") && isReleased(config, "app") ? (
              <li>
                The notification shows once, when your balance first drops
                below the level while ANONYMA is open in a tab. There's no
                email. For an alert when ANONYMA isn't open, turn on Push
                Alerts in Account settings.
              </li>
            ) : (
              <li>
                The notification shows once, when your balance first drops below
                the level while ANONYMA is open in a tab. There's no email and no
                background push.
              </li>
            )}
            <li>
              It watches your personal balance only, not a team treasury.
            </li>
            <li>
              Spending limits are separate: they cap what you can spend even
              with credits left.
            </li>
          </ul>
        </>
      )}
    </form>
  );
}
