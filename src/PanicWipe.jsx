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
  WIPE_ARENA,
  WIPE_ARENA_STAYS,
  WIPE_STUDY,
  WIPE_SLIDES,
  WIPE_REPOS,
  WIPE_WATCHES,
  WIPE_GIFTS,
  WIPE_VAULT_SYNC,
  WIPE_CANVAS,
  WIPE_PUSH,
  WIPE_FILE_SEARCH,
  WIPE_SUBTITLES,
  WIPE_STAYS,
  WIPE_KEEPS_PASSKEYS,
  WIPE_KEEPS_RECOVERY_KIT,
  WIPED_PATH,
  clearBrowserData,
  walletPaymentPending,
} from "./panic-wipe.js";
import { vaultDbNames } from "./device-vault-store.js";
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
  // And Blind Arena's choice (the votes already added stay).
  const arenaLive = blindLive && isReleased(config, "arena");
  // And Study Mode's decks in this browser.
  const studyLive = !!config && isReleased(config, "study");
  // And Slides' decks.
  const slidesLive = !!config && isReleased(config, "slides");
  // And Repo Reader's open repos.
  const reposLive = !!config && isReleased(config, "reporeader");
  // And Page Watch's watches.
  const watchesLive = isReleased(config, "pagewatch");
  // And Gift Links' gifts (unclaimed ones come back first).
  const giftsLive = isReleased(config, "giftlinks");
  // And Vault Sync's synced ciphertext.
  const vaultSyncLive = isReleased(config, "vaultsync");
  // And canvases saved to the account.
  const canvasLive = isReleased(config, "canvas");
  // And Push Alerts' browsers.
  const pushLive = isReleased(config, "pushalerts") && isReleased(config, "app");
  const fileSearchLive = isReleased(config, "filesearch");
  // And Subtitles' saved sets.
  const subtitlesLive = !!config && isReleased(config, "subtitles");
  // Passkeys stay, like the password: listed once that update is live.
  const passkeysLive = !!config && isReleased(config, "passkeys");
  // And the Recovery Kit, like the password.
  const recoveryKitLive = !!config && isReleased(config, "recovery");
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
    // Device Vault and any decoy go even where the browser can't list its
    // databases.
    await clearBrowserData({ names: user?.id ? vaultDbNames(user.id) : [] });
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
                  {arenaLive && <li>{WIPE_ARENA}</li>}
                  {studyLive && <li>{WIPE_STUDY}</li>}
                  {slidesLive && <li>{WIPE_SLIDES}</li>}
                  {reposLive && <li>{WIPE_REPOS}</li>}
                  {watchesLive && <li>{WIPE_WATCHES}</li>}
                  {giftsLive && <li>{WIPE_GIFTS}</li>}
                  {vaultSyncLive && <li>{WIPE_VAULT_SYNC}</li>}
                  {canvasLive && <li>{WIPE_CANVAS}</li>}
                  {pushLive && <li>{WIPE_PUSH}</li>}
                  {fileSearchLive && <li>{WIPE_FILE_SEARCH}</li>}
                  {subtitlesLive && <li>{WIPE_SUBTITLES}</li>}
                </ul>
              </div>
              <div>
                <h3>What stays</h3>
                <ul>
                  {WIPE_STAYS.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                  {passkeysLive && <li>{WIPE_KEEPS_PASSKEYS}</li>}
                  {recoveryKitLive && <li>{WIPE_KEEPS_RECOVERY_KIT}</li>}
                  {arenaLive && <li>{WIPE_ARENA_STAYS}</li>}
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
