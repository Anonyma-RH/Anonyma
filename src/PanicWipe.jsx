import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Icon, Button, Modal, Notice } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import { useApp } from "./context.jsx";
import {
  WIPE_WORD,
  WIPE_GOES,
  WIPE_GOES_PROJECTS,
  WIPE_BOOKMARKS,
  WIPE_BLIND,
  WIPE_STAYS,
  WIPE_KEEPS_PASSKEYS,
  WIPED_PATH,
  clearBrowserData,
  walletPaymentPending,
} from "./panic-wipe.js";
import "./panic-wipe.css";

// Account → Settings: the one button, and the confirm dialog that lists
// exactly what goes and what stays. The server erases everything in one
// transaction (server/routes/wipe.js); this browser is cleared after it
// succeeds, then a full page load lands on the Wiped page so nothing from
// this session stays in memory either.
export function PanicWipe({ user }) {
  const { config } = useApp() || {};
  const projectsLive = !!config && isReleased(config, "projects");
  // Bookmarks are listed once that update is live.
  const bookmarksLive = isReleased(useApp()?.config, "bookmarks");
  // And Blind Compare's votes.
  const blindLive = isReleased(useApp()?.config, "blind");
  // Passkeys stay, like the password: listed once that update is live.
  const passkeysLive = !!config && isReleased(config, "passkeys");
  const [open, setOpen] = useState(false),
    [typed, setTyped] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const walletPending = (() => {
    try {
      return walletPaymentPending(window.localStorage, user?.id);
    } catch {
      return false;
    }
  })();
  function close() {
    if (busy) return;
    setOpen(false);
    setTyped("");
    setError("");
  }
  async function wipe(e) {
    e.preventDefault();
    if (typed.trim() !== WIPE_WORD || busy || walletPending) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/account/wipe", {
        method: "POST",
        body: { confirm: WIPE_WORD },
      });
    } catch (err) {
      setBusy(false);
      setError(err.message);
      return;
    }
    await clearBrowserData();
    window.location.replace(WIPED_PATH);
  }
  return (
    <section className="danger-zone panic-wipe">
      <div>
        <h2>Wipe everything now.</h2>
        <p>
          Erase your chats, files, memory and keys in one step, and sign out
          everywhere. Your credits stay.
        </p>
      </div>
      <button
        className="small-button danger-text"
        disabled={!user}
        onClick={() => setOpen(true)}
      >
        <Icon name="delete" size={15} /> Wipe everything now
      </button>
      {open && (
        <Modal title="Wipe everything now?" onClose={close}>
          <form className="panic-wipe-confirm" onSubmit={wipe}>
            <p>
              This can’t be undone. If you want a copy, export your data first.
            </p>
            <div className="panic-wipe-lists">
              <div>
                <h3>What goes</h3>
                <ul>
                  {WIPE_GOES.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                  {projectsLive && <li>{WIPE_GOES_PROJECTS}</li>}
                  {bookmarksLive && <li>{WIPE_BOOKMARKS}</li>}
                  {blindLive && <li>{WIPE_BLIND}</li>}
                </ul>
              </div>
              <div>
                <h3>What stays</h3>
                <ul>
                  {WIPE_STAYS.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                  {passkeysLive && <li>{WIPE_KEEPS_PASSKEYS}</li>}
                </ul>
                <p className="fine-print">
                  <Link to="/docs/privacy" onClick={close}>
                    Read the data-controls guide.
                  </Link>
                </p>
              </div>
            </div>
            {walletPending && (
              <Notice type="error">
                A wallet payment from this browser is still being confirmed.
                Wait until it’s credited, then wipe.
              </Notice>
            )}
            {error && <Notice type="error">{error}</Notice>}
            <label>
              Type WIPE to confirm
              <input
                name="confirm"
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                disabled={busy}
              />
            </label>
            <div className="inline-actions">
              <Button
                className="danger"
                disabled={typed.trim() !== WIPE_WORD || busy || walletPending}
              >
                {busy ? "Wiping…" : "Wipe everything now"}
              </Button>
              <Button type="button" secondary onClick={close} disabled={busy}>
                Cancel
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </section>
  );
}
