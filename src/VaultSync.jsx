import React, { useEffect, useRef, useState } from "react";
import { Icon, Button, Notice } from "./ui.jsx";
import { api } from "./lib.js";
import { VaultError } from "./device-vault.js";
import {
  SYNC_LIMITS,
  SYNC_STOPPED,
  SYNC_MAX_BYTES,
  SYNC_MAX_RECORD_BYTES,
  formatBytes,
  syncVault,
  turnOn,
  turnOff,
  openSynced,
  sameVault,
} from "./vault-sync.js";
import { localSyncStore, loadSyncState } from "./vault-sync-store.js";
import "./vault-sync.css";

// Vault Sync: Device Vault on every device, end-to-end encrypted. This is
// the only part of Device Vault that talks to the server, and all it sends
// are sealed records, the vault's salt, iteration count and verifier
// (src/vault-sync.js). Off until the person turns it on for a vault; each
// device joins with the vault's passphrase.

export { vaultSyncReleased } from "./vault-sync.js";

// The server, as src/vault-sync.js calls it.
const remote = {
  status: () => api("/api/vault-sync"),
  setup: (body) => api("/api/vault-sync", { method: "POST", body }),
  pull: (vault, since) =>
    api(`/api/vault-sync/records?vault=${encodeURIComponent(vault)}&since=${since}`),
  push: (vault, records) =>
    api("/api/vault-sync/records", { method: "POST", body: { vault, records } }),
  forget: () => api("/api/vault-sync", { method: "DELETE" }),
};
const MB = (n) => formatBytes(n);
function errorText(e) {
  if (e instanceof VaultError) return e.message;
  if (e?.status === 429) return "Sync is paused for a moment. It will try again shortly.";
  if (!e?.status) return "Couldn't reach ANONYMA to sync. Your chats are safe on this device; it will try again.";
  return e.message || "Sync didn't finish. It will try again.";
}
const syncedAt = (t, now = Date.now()) =>
  now - t < 60000
    ? "Synced just now"
    : `Last synced ${new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
const plural = (n, one, many) => (n === 1 ? one : many.replace("{n}", n));
// Decoy Vault: sync never runs for the decoy (src/decoy-vault.js).
export const SYNC_PAUSED = "Sync can't be turned on for this vault.";
const refusePaused = async () => {
  throw new VaultError("sync_paused", SYNC_PAUSED);
};

// The sync state for the signed-in account and its vault in this tab. Runs
// a sync when the vault unlocks, a moment after each change here, every
// minute while the tab is visible, and on "Sync now".
export function useVaultSync({ enabled, account, vault }) {
  const [server, setServer] = useState(undefined), // undefined: loading; null: unavailable
    [local, setLocal] = useState(null),
    [run, setRun] = useState({ busy: false, result: null, error: "", at: 0 }),
    [match, setMatch] = useState(undefined);
  const vaultRef = useRef(vault);
  vaultRef.current = vault;
  const running = useRef(null),
    again = useRef(false),
    lastRun = useRef(0);
  const store = account ? localSyncStore(account) : null;
  // Decoy Vault (src/decoy-vault.js): while the decoy is open, sync is
  // paused. Nothing is read, sent or changed for it, the real vault's sync
  // setting is left alone, and sync shows as off (see `paused` below).
  const paused = vault.syncable === false;
  const synced = server?.vault || null;
  const on = !!local?.enabled && !!synced && local.vault === synced.id;

  async function refreshServer() {
    try {
      const s = await remote.status();
      setServer(s);
      return s;
    } catch {
      setServer((s) => (s === undefined ? null : s));
      return null;
    }
  }
  const refreshLocal = async () => {
    try {
      const st = await loadSyncState(account);
      setLocal(st.meta);
      return st.meta;
    } catch {
      return null;
    }
  };

  useEffect(() => {
    setServer(undefined);
    setLocal(null);
    setRun({ busy: false, result: null, error: "", at: 0 });
  }, [enabled, account]);
  // Asked once this browser's vault state is known, and again when it
  // changes (set up, unlocked, locked, deleted).
  useEffect(() => {
    if (!enabled || !account || ["off", "loading", "unavailable"].includes(vault.status)) return;
    refreshServer();
    refreshLocal();
  }, [enabled, account, vault.status]);
  // Whether this vault is the synced one (same key), for "Turn on" vs "Join".
  useEffect(() => {
    setMatch(undefined);
    if (!vault.unlocked || !synced || paused) return;
    let live = true;
    sameVault(vault.key(), vault.meta, synced).then((m) => live && setMatch(m));
    return () => {
      live = false;
    };
  }, [vault.unlocked, vault.meta, synced?.id, paused]);

  // One sync at a time; a request while one runs queues one more.
  function sync(opened) {
    const v = vaultRef.current;
    if (!enabled || !store || (!opened && (!v.unlocked || v.syncable === false))) return null;
    if (running.current) {
      again.current = true;
      return running.current;
    }
    running.current = (async () => {
      setRun((r) => ({ ...r, busy: true, error: "" }));
      lastRun.current = Date.now();
      try {
        const result = await syncVault({
          key: opened?.key || v.key(),
          meta: opened?.meta || v.meta,
          remote,
          local: store,
        });
        vaultRef.current.applyRemote(result.shown, result.gone);
        setRun({ busy: false, result, error: "", at: Date.now() });
        setServer((s) =>
          s?.vault && result.stats ? { ...s, vault: { ...s.vault, ...result.stats } } : s,
        );
        await refreshLocal();
        if (result.status !== "synced") await refreshServer();
      } catch (e) {
        setRun((r) => ({ ...r, busy: false, error: errorText(e) }));
      } finally {
        running.current = null;
        if (again.current) {
          again.current = false;
          setTimeout(() => sync(), 0);
        }
      }
    })();
    return running.current;
  }

  // On unlock (and when sync is turned on here).
  useEffect(() => {
    if (vault.unlocked && local?.enabled) sync();
  }, [vault.unlocked, local?.enabled]);
  // A moment after each change made in this tab.
  useEffect(() => {
    if (!vault.rev || !vault.unlocked || !local?.enabled) return;
    const t = setTimeout(() => sync(), 1200);
    return () => clearTimeout(t);
  }, [vault.rev]);
  // Every minute while visible, and on coming back to the tab.
  useEffect(() => {
    if (!vault.unlocked || !local?.enabled) return;
    const tick = () => document.visibilityState === "visible" && sync();
    const shown = () => Date.now() - lastRun.current > 15000 && tick();
    const id = setInterval(tick, 60000);
    document.addEventListener("visibilitychange", shown);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", shown);
    };
  }, [vault.unlocked, local?.enabled]);

  const unlockedVault = () => {
    const v = vaultRef.current;
    return { key: v.key(), meta: v.meta };
  };
  const limits = server?.limits || { bytes: SYNC_MAX_BYTES, recordBytes: SYNC_MAX_RECORD_BYTES };
  // The decoy is open: sync looks as it does for a vault that doesn't sync,
  // and nothing in it can be turned on, joined or forgotten.
  if (paused)
    return {
      live: !!enabled,
      server: server && { ...server, vault: null },
      synced: null,
      local: null,
      on: false,
      match: undefined,
      busy: false,
      result: null,
      error: "",
      at: 0,
      limits,
      refresh: refreshServer,
      syncNow: () => null,
      turnOn: refusePaused,
      turnOff: async () => {},
      join: refusePaused,
      adopt: refusePaused,
      forget: refusePaused,
    };
  return {
    live: !!enabled,
    server,
    synced,
    local,
    on,
    match,
    busy: run.busy,
    result: run.result,
    error: run.error,
    at: run.at || local?.last || 0,
    limits,
    refresh: refreshServer,
    syncNow: () => sync(),
    // This device's vault becomes (or joins, with the same key) the synced one.
    async turnOn() {
      const { key, meta } = unlockedVault();
      await turnOn({ key, meta, remote, local: store });
      await refreshLocal();
      await refreshServer();
    },
    // Stops syncing here; the synced copy stays for other devices.
    async turnOff() {
      await turnOff({ local: store });
      await refreshLocal();
      setRun({ busy: false, result: null, error: "", at: 0 });
    },
    // A device with its own vault joins the synced one: its chats are sealed
    // again with the synced key, then merged by the first sync.
    async join(passphrase) {
      if (!synced) return;
      const opened = await openSynced(synced, passphrase, vaultRef.current.meta?.idleMinutes);
      await vaultRef.current.rekey(opened.meta, opened.key);
      await turnOn({ ...opened, remote, local: store });
      await refreshLocal();
      await sync(opened);
    },
    // A device without a vault opens the synced one with its passphrase.
    async adopt(passphrase) {
      if (!synced) return;
      const opened = await openSynced(synced, passphrase);
      await vaultRef.current.adopt(opened.meta, opened.key);
      await turnOn({ ...opened, remote, local: store });
      await refreshLocal();
      await sync(opened);
    },
    // Forget synced copy: the server's ciphertext goes; every device keeps
    // its own vault and stops syncing.
    async forget() {
      await remote.forget();
      if (store) await turnOff({ local: store, reason: null });
      await refreshLocal();
      await refreshServer();
      setRun({ busy: false, result: null, error: "", at: 0 });
    },
  };
}

// ---- UI ----

function PassField({ label, value, onChange, autoFocus }) {
  return (
    <label>
      {label}
      <input
        type="password"
        data-i18n="off"
        value={value}
        autoComplete="current-password"
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
export function VaultSyncLimits() {
  return (
    <ul className="vault-limits vault-sync-limits">
      {SYNC_LIMITS.map((line) => (
        <li key={line}>
          <Icon name="warning" size={14} />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}
function Switch({ checked, disabled, onChange, children }) {
  return (
    <label className={"vault-sync-switch" + (disabled ? " disabled" : "")}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="vault-sync-track" aria-hidden="true" />
      <span>{children}</span>
    </label>
  );
}
// What the last sync said, in plain words.
export function syncNotes(result, reason) {
  const notes = [];
  if (reason && SYNC_STOPPED[reason]) notes.push(SYNC_STOPPED[reason]);
  if (!result) return notes;
  if (result.conflicts)
    notes.push(
      plural(
        result.conflicts,
        "1 chat changed on two devices at once. Both versions are kept; the older one is marked Conflict copy.",
        "{n} chats changed on two devices at once. Both versions are kept; the older ones are marked Conflict copy.",
      ),
    );
  if (result.tooBig)
    notes.push(
      plural(
        result.tooBig,
        "1 chat is over 4 MB, so it stays on this device only.",
        "{n} chats are over 4 MB, so they stay on this device only.",
      ),
    );
  if (result.full)
    notes.push("Synced storage is full (50 MB). New changes stay on this device until you delete some chats.");
  if (result.tooMany)
    notes.push("You've reached 5,000 synced chats. New chats stay on this device until you delete some.");
  if (result.damaged)
    notes.push(
      plural(
        result.damaged,
        "1 synced chat couldn't be read and was skipped.",
        "{n} synced chats couldn't be read and were skipped.",
      ),
    );
  return notes;
}
function ForgetConfirm({ sync, onDone, onCancel }) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="vault-sync-confirm" role="group" aria-label="Forget synced copy">
      <p>
        Delete the synced copy from ANONYMA's servers? Your devices keep their
        own vaults and stop syncing. Backups are separate copies; without your
        passphrase they can't be read.
      </p>
      {error && <Notice type="error">{error}</Notice>}
      <div className="inline-actions">
        <button
          type="button"
          className="small-button danger-text"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError("");
            try {
              await sync.forget();
              onDone?.();
            } catch (e) {
              setError(errorText(e));
              setBusy(false);
            }
          }}
        >
          <Icon name="delete" size={14} />
          {busy ? "Forgetting…" : "Forget synced copy"}
        </button>
        <button type="button" className="small-button" disabled={busy} onClick={onCancel}>
          Keep it
        </button>
      </div>
    </div>
  );
}
function Stats({ vault, limits }) {
  if (!vault) return null;
  return (
    <p className="vault-sync-stats">
      {vault.records === 1
        ? `1 chat synced · ${MB(vault.bytes)} of ${MB(limits.bytes)} used`
        : `${vault.records} chats synced · ${MB(vault.bytes)} of ${MB(limits.bytes)} used`}
    </p>
  );
}

// Device Vault → Manage vault: the sync switch and its state.
export function VaultSyncSection({ sync }) {
  const [confirming, setConfirming] = useState(false),
    [forgetting, setForgetting] = useState(false),
    [pass, setPass] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!sync?.live) return null;
  async function act(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  const notes = syncNotes(sync.on ? sync.result : null, sync.on ? null : sync.local?.reason);
  const loading = sync.server === undefined || (sync.synced && !sync.on && sync.match === undefined);
  return (
    <div className="vault-block vault-sync">
      <h3>Sync across devices</h3>
      {sync.server === null ? (
        <>
          <p>Sync status couldn't be loaded.</p>
          <button type="button" className="small-button" onClick={() => sync.refresh()}>
            <Icon name="refresh" size={14} />
            Try again
          </button>
        </>
      ) : loading ? (
        <p>Checking sync…</p>
      ) : sync.synced && !sync.on && sync.match === false ? (
        // Another device syncs a vault with a different key.
        <form
          onSubmit={(e) => {
            e.preventDefault();
            act(async () => {
              await sync.join(pass);
              setPass("");
            });
          }}
        >
          <p>
            Another of your devices syncs a different vault. To join it, enter
            that vault's passphrase. The chats here are encrypted again with
            its key, and this device then unlocks with that passphrase.
          </p>
          <PassField label="Synced vault's passphrase" value={pass} onChange={setPass} />
          <VaultSyncLimits />
          {error && <Notice type="error">{error}</Notice>}
          <div className="inline-actions">
            <Button disabled={busy || !pass}>{busy ? "Joining…" : "Join synced vault"}</Button>
            {!forgetting && (
              <button type="button" className="link-button" onClick={() => setForgetting(true)}>
                Forget synced copy
              </button>
            )}
          </div>
          {forgetting && <ForgetConfirm sync={sync} onDone={() => setForgetting(false)} onCancel={() => setForgetting(false)} />}
        </form>
      ) : (
        <>
          <Switch
            checked={sync.on}
            disabled={busy}
            onChange={() => {
              setError("");
              // Off: the switch asks first (below). On: it stops syncing here.
              if (!sync.on) setConfirming((c) => !c);
              else act(() => sync.turnOff());
            }}
          >
            <b>Sync this vault across my devices (end-to-end encrypted)</b>
            <small>
              Your browser encrypts each chat before it's uploaded, so ANONYMA
              stores only ciphertext. Unlock with the same passphrase on
              another device to see the same chats.
            </small>
          </Switch>
          {sync.on ? (
            <>
              <p className="vault-sync-status" aria-live="polite">
                <Icon name={sync.busy ? "refresh" : "check"} size={14} />
                {sync.busy ? "Syncing…" : sync.error ? "Sync didn't finish." : sync.at ? syncedAt(sync.at) : "Waiting to sync…"}
              </p>
              <Stats vault={sync.synced} limits={sync.limits} />
            </>
          ) : (
            sync.synced &&
            !confirming && <p className="vault-sync-hint">Your other devices sync this vault. Turn sync on to add this device.</p>
          )}
          {confirming && !sync.on && (
            <div className="vault-sync-confirm">
              <VaultSyncLimits />
              <p className="vault-sync-hint">
                {`Up to ${MB(sync.limits.bytes)} in all; a chat over ${MB(sync.limits.recordBytes)} stays on this device only.`}
              </p>
              <div className="inline-actions">
                <Button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await sync.turnOn();
                      setConfirming(false);
                    })
                  }
                >
                  {busy ? "Turning on…" : "Turn on sync"}
                </Button>
                <Button secondary type="button" disabled={busy} onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {[...notes, ...(sync.on && sync.error ? [sync.error] : [])].map((n) => (
            <Notice key={n}>{n}</Notice>
          ))}
          {error && <Notice type="error">{error}</Notice>}
          {sync.on && <VaultSyncLimits />}
          {(sync.on || (sync.synced && !confirming)) &&
            (forgetting ? (
              <ForgetConfirm sync={sync} onDone={() => setForgetting(false)} onCancel={() => setForgetting(false)} />
            ) : (
              <div className="inline-actions">
                {sync.on && (
                  <button type="button" className="small-button" disabled={sync.busy} onClick={() => sync.syncNow()}>
                    <Icon name="refresh" size={14} />
                    Sync now
                  </button>
                )}
                <button type="button" className="small-button danger-text" onClick={() => setForgetting(true)}>
                  <Icon name="delete" size={14} />
                  Forget synced copy
                </button>
              </div>
            ))}
        </>
      )}
    </div>
  );
}

// Setting up Device Vault on a device while the account syncs one: open the
// synced vault with its passphrase instead of making a separate one.
export function VaultSyncJoin({ sync, onDone, onCreate }) {
  const [pass, setPass] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [forgetting, setForgetting] = useState(false);
  return (
    <form
      className="vault-sync-join"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
          await sync.adopt(pass);
          setPass("");
          onDone?.();
        } catch (err) {
          setError(errorText(err));
          setBusy(false);
        }
      }}
    >
      <p>
        You sync a Device Vault from another device. Enter its passphrase to
        bring those chats here, end-to-end encrypted.
      </p>
      <PassField label="Passphrase" value={pass} onChange={setPass} autoFocus />
      {error && <Notice type="error">{error}</Notice>}
      <div className="inline-actions">
        <Button disabled={busy || !pass}>{busy ? "Unlocking…" : "Unlock synced vault"}</Button>
        <button type="button" className="small-button" onClick={onCreate}>
          Create a separate vault here instead
        </button>
      </div>
      <VaultSyncLimits />
      {forgetting ? (
        <ForgetConfirm sync={sync} onDone={() => setForgetting(false)} onCancel={() => setForgetting(false)} />
      ) : (
        <p className="vault-forgot">
          Forgot it? Nobody can recover the synced chats, including us.{" "}
          <button type="button" className="link-button" onClick={() => setForgetting(true)}>
            Forget synced copy
          </button>
        </p>
      )}
    </form>
  );
}

// The sidebar line under the vault's chats: sync on, working or stopped.
export function VaultSyncStatus({ sync, onManage }) {
  if (!sync?.live) return null;
  const reason = !sync.on && sync.local?.reason && SYNC_STOPPED[sync.local.reason];
  if (!sync.on && !reason) return null;
  const text = reason
    ? "Sync stopped on this device"
    : sync.busy
      ? "Syncing…"
      : sync.error
        ? "Sync will try again"
        : sync.result?.conflicts
          ? "Synced · conflict copies kept"
          : "Synced across your devices";
  return (
    <button type="button" className="vault-sync-line" onClick={onManage} title="Vault Sync settings">
      <Icon name={sync.busy ? "refresh" : "devices"} size={13} />
      <span>{text}</span>
    </button>
  );
}
// Before a chat's title in the sidebar: a conflict copy is marked.
export const ConflictCopyTag = () => <span className="vault-copy-tag">Conflict copy</span>;
