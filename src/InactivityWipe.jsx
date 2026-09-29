import React, { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import { Button, Icon, Modal, Notice } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import {
  WIPE_GOES_PROJECTS,
  WIPE_BOOKMARKS,
  WIPE_BLIND,
  WIPE_WATCHES,
  WIPE_GIFTS,
  WIPE_VAULT_SYNC,
  WIPE_CANVAS,
  WIPE_FILE_SEARCH,
  WIPE_ARENA,
  WIPE_ARENA_STAYS,
  WIPE_KEEPS_PASSKEYS,
} from "./panic-wipe.js";
import {
  ERASES,
  KEEPS,
  BLOCKED_TEXT,
  DAY_MS,
  bannerOf,
  daysLeftText,
} from "./inactivity-wipe.js";
import "./panic-wipe.css";
import "./inactivity-wipe.css";

// Inactivity Wipe in the browser (rules in inactivity-wipe.js; the setting,
// the activity clock and the erase are server/inactivity-wipe.js):
// - InactivityWipeSettings: Account → Account settings, beside Panic Wipe.
// - InactivityWipeBanner: the workspace's one-time notice after coming back
//   in the last 7 days (the clock was reset) or after an erase.
// Both need the update and Panic Wipe, whose erase it is.
export const inactivityReleased = (config) =>
  !!config && isReleased(config, "deadswitch") && isReleased(config, "wipe");

// A date and time the language switch can translate ("12/26/2026, 1:05 PM").
export const when = (t) =>
  new Date(t).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const span = (ms) => {
  const hours = Math.round(ms / 3_600_000);
  if (ms < DAY_MS) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(ms / DAY_MS);
  return days === 1 ? "1 day" : `${days} days`;
};

// ---- The account's setting, shared by the section and the banner ----
let cache = { key: null, view: null };
let loading = null;
const listeners = new Set();
const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const snapshot = () => cache;
const serverSnapshot = () => ({ key: null, view: null });
export function setInactivityView(userId, view) {
  cache = { key: userId, view };
  listeners.forEach((fn) => fn());
}
function load(userId) {
  if (loading === userId) return;
  loading = userId;
  api("/api/inactivity-wipe")
    .then((view) => {
      if (loading === userId) setInactivityView(userId, view);
    })
    .catch(() => {})
    .finally(() => {
      if (loading === userId) loading = null;
    });
}
// GET /api/inactivity-wipe, fetched once per account per tab and kept
// current by the section's saves and the banner's Dismiss.
export function useInactivity(config, user, demo) {
  const live = inactivityReleased(config) && !demo && !!user?.id;
  const current = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  useEffect(() => {
    if (live && cache.key !== user.id) load(user.id);
  }, [live, user?.id]);
  return live && current.key === user.id ? current.view : null;
}

// What goes and what stays, with the items of updates that are live, the
// way Panic Wipe's dialog lists them.
export function WipeLists({ config }) {
  const on = (id) => !!config && isReleased(config, id);
  return (
    <div className="panic-wipe-lists">
      <div>
        <h3>What goes</h3>
        <ul>
          {ERASES.map((t) => (
            <li key={t}>{t}</li>
          ))}
          {on("projects") && <li>{WIPE_GOES_PROJECTS}</li>}
          {on("bookmarks") && <li>{WIPE_BOOKMARKS}</li>}
          {on("blind") && <li>{WIPE_BLIND}</li>}
          {on("pagewatch") && <li>{WIPE_WATCHES}</li>}
          {on("giftlinks") && <li>{WIPE_GIFTS}</li>}
          {on("vaultsync") && <li>{WIPE_VAULT_SYNC}</li>}
          {on("canvas") && <li>{WIPE_CANVAS}</li>}
          {on("filesearch") && <li>{WIPE_FILE_SEARCH}</li>}
          {on("slides") && <li>Slide decks saved to your account</li>}
          {on("arena") && <li>{WIPE_ARENA}</li>}
        </ul>
      </div>
      <div>
        <h3>What stays</h3>
        <ul>
          {KEEPS.map((t) => (
            <li key={t}>{t}</li>
          ))}
          {on("passkeys") && <li>{WIPE_KEEPS_PASSKEYS}</li>}
          {on("arena") && <li>{WIPE_ARENA_STAYS}</li>}
          <li>Anything kept in your browsers, such as Device Vault chats</li>
        </ul>
      </div>
    </div>
  );
}

// The reminder row. A date only when this server can send email and the
// account has a verified one (the server's remindAt is null otherwise).
export function reminderText(view) {
  if (view.reminded) return `Sent ${when(view.reminded)}`;
  if (!view.emailReminders) return "None, since email reminders aren’t available";
  if (!view.email || view.remindAt == null) return "None: add a verified email in Account";
  return `By email, ${when(view.remindAt)}`;
}
// The confirm dialog's line about the reminder.
export function reminderPromise(view) {
  if (!view?.emailReminders) return "No reminder email: email reminders aren’t available.";
  if (!view.email) return "No reminder email: add a verified email in Account to get one.";
  return "We’ll email you a reminder 7 days before.";
}

// The status rows while it's on.
export function InactivityStatus({ view }) {
  return (
    <div className="identity-rows inactivity-status">
      <div>
        <span>Status</span>
        <b>
          <Icon name="hourglass" size={14} /> {`On · ${view.days} days`}
        </b>
      </div>
      <div>
        <span>Last active</span>
        <b>{when(view.lastActive)}</b>
      </div>
      <div>
        <span>Erases after</span>
        <b>{when(view.deadline)}</b>
      </div>
      <div>
        <span>Time left</span>
        <b>{daysLeftText(view.daysLeft)}</b>
      </div>
      <div>
        <span>Reminder</span>
        <b>{reminderText(view)}</b>
      </div>
      {view.paused >= 3_600_000 && (
        <div>
          <span>Offline time added</span>
          <b>{span(view.paused)}</b>
        </div>
      )}
      {view.erased && (
        <div>
          <span>Last erased</span>
          <b>{when(view.erased)}</b>
        </div>
      )}
    </div>
  );
}

export function InactivityWipeSettings({ config, user }) {
  const view = useInactivity(config, user, false);
  const [draft, setDraft] = useState(null);
  const [confirming, setConfirming] = useState(false);
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
    if (view) setDraft({ days: view.days, apiCounts: view.apiCounts });
  }, [view?.enabled, view?.days, view?.apiCounts]);
  if (!inactivityReleased(config) || !user) return null;

  const changed =
    !!view &&
    !!draft &&
    (draft.days !== view.days ||
      (draft.days != null && draft.apiCounts !== view.apiCounts));
  // Turning it on, or a shorter period, is confirmed first (the server asks
  // for that too).
  const needsConfirm =
    !!draft && draft.days != null && (!view?.enabled || draft.days < view.days);

  async function save(confirmed) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body =
        draft.days == null
          ? { days: null }
          : {
              days: draft.days,
              api_counts: draft.apiCounts,
              ...(confirmed ? { confirm: true } : {}),
            };
      const next = await api("/api/inactivity-wipe", { method: "PUT", body });
      setInactivityView(user.id, next);
      if (!alive.current) return;
      setConfirming(false);
      setNotice(
        next.enabled
          ? `On. If you don’t sign in before ${when(next.deadline)}, your content is erased.`
          : "Off. Nothing will be erased for inactivity, and your last-active time is deleted.",
      );
    } catch (err) {
      if (alive.current) setError(err.message);
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function submit(e) {
    e.preventDefault();
    if (!changed || busy) return;
    if (needsConfirm) setConfirming(true);
    else save(false);
  }
  const blocked = view?.blocked;
  return (
    <section className="inactivity-wipe" id="inactivity-wipe">
      <div>
        <h2>Inactivity wipe.</h2>
        <p>
          If you stop signing in, your content erases itself. Off until you
          choose a period.
        </p>
      </div>
      <form className="inactivity-wipe-body" onSubmit={submit}>
        {error && <Notice type="error">{error}</Notice>}
        {notice && <Notice>{notice}</Notice>}
        {!view || !draft ? (
          <p className="inactivity-hint">Loading…</p>
        ) : (
          <>
            <label className="inactivity-field">
              <span>Erase my content if I don’t sign in for</span>
              <select
                value={draft.days == null ? "" : String(draft.days)}
                disabled={busy}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    days: e.target.value ? Number(e.target.value) : null,
                  }))
                }
              >
                <option value="">Off</option>
                {view.options.map((d) => (
                  <option key={d} value={d}>{`${d} days`}</option>
                ))}
              </select>
            </label>
            <label className="inactivity-check">
              <input
                type="checkbox"
                checked={draft.apiCounts}
                disabled={busy || draft.days == null}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, apiCounts: e.target.checked }))
                }
              />
              <span>API and connected-app use counts as activity</span>
            </label>
            <p className="inactivity-hint">
              An agent using your API key keeps your content. Untick this so
              only you signing in counts.
            </p>
            <div className="inline-actions">
              <Button disabled={busy || !changed}>
                {busy ? "Saving…" : "Save"}
              </Button>
            </div>
            {view.enabled && <InactivityStatus view={view} />}
            {view.enabled && blocked && (
              <Notice type="error">
                <span>The erase is waiting.</span>{" "}
                <span>{BLOCKED_TEXT[blocked.code] || BLOCKED_TEXT.failed}</span>{" "}
                <span>It tries again every hour.</span>
              </Notice>
            )}
            <details className="inactivity-lists">
              <summary>What gets erased, and what stays</summary>
              <WipeLists config={config} />
            </details>
            <ul className="inactivity-notes">
              <li>
                Signing in, or using ANONYMA while signed in, resets the clock.
                Scheduled Routines and Page Watch runs don’t.
              </li>
              <li>
                We’ll email a reminder 7 days before, if email is set up and
                you’ve added one.
              </li>
              <li>
                It can’t reach your devices: Device Vault chats and anything
                else kept in a browser stay there.
              </li>
              <li>
                Like Panic Wipe, it waits while a request is running or a
                collab you own holds Team Treasury credits.
              </li>
              <li>
                While it’s on, we keep when you were last active, updated at
                most once an hour. Turning it off deletes that. Time ANONYMA is
                offline doesn’t count.
              </li>
              <li>
                Backups are separate copies.{" "}
                <Link to="/docs/privacy">Read the data-controls guide.</Link>
              </li>
            </ul>
          </>
        )}
      </form>
      {confirming && draft && (
        <Modal
          title="Turn on Inactivity Wipe?"
          onClose={() => !busy && setConfirming(false)}
        >
          <div className="panic-wipe-confirm inactivity-confirm">
            <p>
              {`If you don’t sign in for ${draft.days} days, your content will be erased. This can’t be undone.`}
            </p>
            <WipeLists config={config} />
            <p className="inactivity-hint">{reminderPromise(view)}</p>
            {error && <Notice type="error">{error}</Notice>}
            <div className="inline-actions">
              <Button
                type="button"
                className="danger"
                disabled={busy}
                onClick={() => save(true)}
              >
                {busy ? "Saving…" : view?.enabled ? "Shorten it" : "Turn on"}
              </Button>
              <Button
                type="button"
                secondary
                disabled={busy}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

// ---- The workspace banner ----
export function InactivityNotice({ banner, onDismiss, q = "" }) {
  return (
    <div className="inactivity-banner" role="status" data-testid="inactivity-banner">
      <span className="inactivity-banner-mark" aria-hidden="true">
        <Icon name="hourglass" size={15} />
      </span>
      <p>
        {banner.kind === "reset" ? (
          <>
            <b>
              {banner.left > 0
                ? `Inactivity Wipe was ${daysLeftText(banner.left)} away.`
                : "Inactivity Wipe was due."}
            </b>{" "}
            <span>Signing in reset the clock.</span>{" "}
            {banner.next && (
              <span>{`If you stop signing in, it erases your content after ${when(banner.next)}.`}</span>
            )}
          </>
        ) : (
          <>
            <b>{`Inactivity Wipe erased your content on ${when(banner.at)}.`}</b>{" "}
            <span>
              {banner.days
                ? `There was no activity for ${banner.days} days. Your account and credits are here.`
                : "Your account and credits are here."}
            </span>
          </>
        )}
      </p>
      <div className="inactivity-banner-actions">
        <Link to={"/account/settings" + q + "#inactivity-wipe"}>Inactivity settings</Link>
        {onDismiss && (
          <button
            type="button"
            className="inactivity-banner-dismiss"
            aria-label="Dismiss the Inactivity Wipe notice"
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
export function InactivityWipeBanner({ config, user, demo }) {
  const view = useInactivity(config, user, demo);
  const banner = bannerOf(view);
  if (!banner) return null;
  return (
    <InactivityNotice
      banner={banner}
      onDismiss={async () => {
        // Hidden at once; the server forgets the notice too.
        setInactivityView(user.id, { ...view, notice: null });
        try {
          setInactivityView(
            user.id,
            await api("/api/inactivity-wipe/notice", { method: "DELETE" }),
          );
        } catch {}
      }}
    />
  );
}
