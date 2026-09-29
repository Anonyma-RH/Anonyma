import React, { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Icon } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import { getLanguage, useLanguage } from "./i18n.js";
import {
  PUSH_KINDS,
  SERVICE_NAMES,
  SERVICE_BROWSERS,
  deviceTag,
  keyBytes,
  sameKey,
} from "./push-alerts.js";
import "./push-alerts.css";

// Push Alerts in Account → Settings (server/push-alerts.js,
// server/routes/push-alerts.js): turn browser notifications on in this
// browser, choose which kinds, and see or remove every browser that gets
// them. Asking the browser for permission happens only on the button.
// Needs the installable app's service worker ("app"), which receives them.
export const pushAlertsReleased = (config) =>
  !!config && isReleased(config, "pushalerts") && isReleased(config, "app");

// Each switch, with the one sentence its notification says.
const EVENTS = [
  ["pagewatch", "Page watches", PUSH_KINDS.pagewatch.body],
  ["routines", "Routine results", PUSH_KINDS.routine.body],
  ["lowbalance", "Low balance", PUSH_KINDS.lowbalance.body],
  ["gifts", "Gift Links", PUSH_KINDS.gift_claimed.body],
  ["inactivity", "Inactivity Wipe reminder", PUSH_KINDS.inactivity.body],
  ["research", "Research watch briefings", PUSH_KINDS.research_report.body],
];

// What the push service said to a test (POST …/test's outcome).
const TEST_OUTCOMES = {
  accepted: "Sent. It should arrive in a few seconds.",
  pending: "The push service hasn’t taken it yet. ANONYMA will keep trying for a few hours.",
  gone: "That browser’s subscription had ended, so it was removed. Turn notifications on again there.",
  stale: "This browser needs to turn notifications on again.",
};
const day = (t) => new Date(t).toLocaleDateString();
const isApple = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () =>
  window.matchMedia?.("(display-mode: standalone)").matches || window.navigator?.standalone === true;

// What this browser can do: "ok", "unsupported" or "ios-home" (an iPhone
// or iPad browser tab, where Web Push works only from the Home Screen app).
function support() {
  if (typeof window === "undefined") return "unsupported";
  const ok =
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window;
  if (ok) return "ok";
  return isApple() && !standalone() ? "ios-home" : "unsupported";
}
const permissionNow = () => (typeof Notification === "undefined" ? "default" : Notification.permission);

// The installable app's worker (registered by useInstallAppGate); registered
// here too if this page loaded before it was. Gives up after 10 seconds.
async function workerRegistration() {
  if (!(await navigator.serviceWorker.getRegistration("/")))
    await navigator.serviceWorker.register("/sw.js");
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("This browser didn't start ANONYMA's notification worker. Reload and try again.")), 10000),
    ),
  ]);
}
async function currentSubscription() {
  if (support() !== "ok") return null;
  const reg = await navigator.serviceWorker.getRegistration("/");
  return (await reg?.pushManager.getSubscription()) || null;
}
const post = (sub) =>
  api("/api/push/subscriptions", { method: "POST", body: { ...sub.toJSON(), lang: getLanguage() } });

function DeviceRow({ d, here, busy, onTest, onRemove }) {
  return (
    <li className="push-device">
      <span className="push-device-glyph" aria-hidden="true">
        <Icon name="bell" size={18} />
      </span>
      <div className="push-device-main">
        <b>
          {SERVICE_BROWSERS[d.service] || "A browser"}
          {here && <span className="allowance-tag push-tag">This browser</span>}
        </b>
        <small>{SERVICE_NAMES[d.service] || "A push service"}</small>
        {/* One string, so the Chinese switch translates it as a whole. */}
        <small>
          {d.lastSuccess
            ? `Added ${day(d.created)} · Last alert ${day(d.lastSuccess)}`
            : `Added ${day(d.created)} · No alert yet`}
        </small>
        {d.stale && <small className="push-warn">Turn notifications on again in that browser to keep getting them.</small>}
      </div>
      <div className="push-device-actions">
        {here && !d.stale && (
          <button type="button" className="small-button" disabled={busy} onClick={onTest}>
            Send a test
          </button>
        )}
        <button type="button" className="small-button danger-text" disabled={busy} onClick={onRemove}>
          {here ? "Stop in this browser" : "Remove"}
        </button>
      </div>
    </li>
  );
}

export function PushAlertsSettings({ config, user }) {
  const live = pushAlertsReleased(config) && !!user;
  const available = !!config?.services?.push;
  const lang = useLanguage();
  const [view, setView] = useState(null),
    [hereTag, setHereTag] = useState(null),
    [permission, setPermission] = useState(permissionNow),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const can = support();

  const load = useCallback(async () => {
    const next = await api("/api/push");
    const sub = await currentSubscription().catch(() => null);
    const tag = sub ? await deviceTag(sub.endpoint) : null;
    if (!alive.current) return;
    setView(next);
    setHereTag(tag && next.devices.some((d) => d.tag === tag) ? tag : null);
    // This browser's subscription is kept current: after a key change it
    // subscribes again, and a new language is sent along (no prompt: the
    // permission is already granted).
    const mine = tag && next.devices.find((d) => d.tag === tag);
    if (mine && next.available && permissionNow() === "granted" && (mine.stale || mine.lang !== getLanguage())) {
      let fresh = sub;
      if (!sameKey(sub.options?.applicationServerKey, next.publicKey)) {
        await sub.unsubscribe().catch(() => {});
        const reg = await workerRegistration();
        fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(next.publicKey) });
      }
      const updated = await post(fresh);
      if (!alive.current) return;
      setView(updated);
      setHereTag(await deviceTag(fresh.endpoint));
    }
  }, []);
  useEffect(() => {
    if (!live) return;
    load().catch((e) => alive.current && setError(e.message));
  }, [live, load, lang]);

  if (!live) return null;

  async function run(work) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      if (alive.current) setError(e.message || "Something went wrong. Try again.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const turnOn = () =>
    run(async () => {
      // The browser asks only now, on this button.
      const answer = await Notification.requestPermission();
      setPermission(answer);
      if (answer !== "granted") {
        setError(
          answer === "denied"
            ? "Notifications are blocked for this site. Allow them in your browser’s site settings, then try again."
            : "Notifications weren’t allowed. Try again and choose Allow.",
        );
        return;
      }
      const reg = await workerRegistration();
      let sub = await reg.pushManager.getSubscription();
      if (sub && !sameKey(sub.options?.applicationServerKey, view.publicKey)) {
        await sub.unsubscribe().catch(() => {});
        sub = null;
      }
      sub ||= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(view.publicKey) });
      const next = await post(sub);
      if (!alive.current) return;
      setView(next);
      setHereTag(await deviceTag(sub.endpoint));
      setNotice("This browser will get your alerts. Send a test to see one.");
    });

  const remove = (d) =>
    run(async () => {
      const next = await api(`/api/push/subscriptions/${d.id}`, { method: "DELETE" });
      if (d.tag === hereTag) {
        const sub = await currentSubscription().catch(() => null);
        await sub?.unsubscribe().catch(() => {});
        setHereTag(null);
      }
      if (!alive.current) return;
      setView(next);
      setNotice(d.tag === hereTag ? "Stopped. This browser gets no more alerts." : "Removed. That browser gets no more alerts.");
    });

  const test = (d) =>
    run(async () => {
      const r = await api(`/api/push/subscriptions/${d.id}/test`, { method: "POST", body: {} });
      if (!alive.current) return;
      setView(r);
      setNotice(TEST_OUTCOMES[r.outcome] || TEST_OUTCOMES.pending);
    });

  const toggle = (event, on) =>
    run(async () => {
      const next = await api("/api/push/settings", { method: "PATCH", body: { [event]: on } });
      if (alive.current) setView(next);
    });

  return (
    <PushAlertsPanel
      available={available}
      view={view}
      hereTag={hereTag}
      can={can}
      permission={permission}
      busy={busy}
      error={error}
      notice={notice}
      onTurnOn={turnOn}
      onRemove={remove}
      onTest={test}
      onToggle={toggle}
    />
  );
}

// What the section shows, from its state (kept apart so it renders without
// a browser: tests/push-alerts.test.mjs).
export function PushAlertsPanel({
  available,
  view,
  hereTag,
  can,
  permission,
  busy,
  error,
  notice,
  onTurnOn,
  onRemove,
  onTest,
  onToggle,
}) {
  const devices = view?.devices || [];
  const here = hereTag ? devices.find((d) => d.tag === hereTag) : null;
  let body;
  if (!available)
    body = <p className="push-note">Browser notifications aren’t available on this server yet.</p>;
  else if (!view) body = !error && <p className="push-note">Loading…</p>;
  else
    body = (
      <>
        {can === "ok" && !here && permission !== "denied" && (
          <div className="push-start">
            <Button type="button" disabled={busy || devices.length >= view.max} onClick={onTurnOn}>
              <Icon name="bell" size={16} /> Notify me in this browser
            </Button>
            {devices.length >= view.max && (
              <p className="push-note">{`You can have alerts in up to ${view.max} browsers. Remove one first.`}</p>
            )}
          </div>
        )}
        {can === "ok" && !here && permission === "denied" && (
          <p className="push-note push-warn">
            Notifications are blocked for this site. Allow them in your browser’s site settings, then reload this page.
          </p>
        )}
        {can === "ios-home" && (
          <p className="push-note">
            On iPhone and iPad, alerts work only from the Home Screen app. Add ANONYMA to your Home Screen, open it
            from there and turn this on.
          </p>
        )}
        {can === "unsupported" && <p className="push-note">This browser can’t receive push notifications.</p>}
        {devices.length > 0 ? (
          <ul className="push-devices">
            {devices.map((d) => (
              <DeviceRow
                key={d.id}
                d={d}
                here={d.tag === hereTag}
                busy={busy}
                onTest={() => onTest(d)}
                onRemove={() => onRemove(d)}
              />
            ))}
          </ul>
        ) : (
          <p className="push-empty">No browsers get alerts yet.</p>
        )}
        {notice && (
          <p className="push-saved" role="status">
            {notice}
          </p>
        )}
        <div className="push-events" role="group" aria-label="What to send">
          <h3>What to send</h3>
          {EVENTS.filter(([id]) => id in view.events).map(([id, label, sentence]) => (
            <label key={id} className="push-event">
              <input
                type="checkbox"
                role="switch"
                checked={view.events[id] === true}
                disabled={busy || !devices.length}
                onChange={(e) => onToggle(id, e.target.checked)}
              />
              <span>
                <b>{label}</b>
                <small className="push-sentence">
                  <q>{sentence}</q>
                </small>
                {id === "lowbalance" && !view.lowBalanceLevel && (
                  <small>
                    Uses your Low-Balance Alerts level. <Link to="/account/credits">Set one in Credits.</Link>
                  </small>
                )}
                {id === "inactivity" && !view.inactivityOn && <small>Only while Inactivity Wipe is on.</small>}
              </span>
            </label>
          ))}
        </div>
      </>
    );

  return (
    <section id="push-alerts" className="push-alerts">
      <div>
        <h2>Push Alerts.</h2>
        <p>Browser notifications for your routines, page watches, balance and gifts. No email needed.</p>
      </div>
      <div className="push-body">
        {body}
        {error && <p className="push-error">{error}</p>}
        <ul className="push-notes">
          <li>Each alert is one fixed sentence, like the ones above. It never includes your chats, page text, amounts or names.</li>
          <li>
            Alerts travel through your browser’s push service (Google, Mozilla, Apple or Microsoft). It sees that this
            browser gets alerts from ANONYMA and when, not what they say: each one is encrypted and the same size.
          </li>
          <li>Signing out doesn’t stop alerts in a browser. Remove it here, or block notifications in the browser.</li>
          <li>Nothing here costs credits. Panic Wipe, Inactivity Wipe and closing your account remove every browser.</li>
        </ul>
      </div>
    </section>
  );
}
