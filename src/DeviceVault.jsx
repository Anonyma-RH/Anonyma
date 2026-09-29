import React, { useEffect, useRef, useState } from "react";
import { Icon, Button, Modal, Notice } from "./ui.jsx";
import { download } from "./lib.js";
import {
  IDLE_CHOICES,
  idleExpired,
  DEFAULT_IDLE_MINUTES,
  MIN_PASSPHRASE,
  VAULT_LIMITS,
  VaultError,
  VAULT_ERRORS,
  createVault,
  unlockVault,
  openChat,
  sealChat,
  passphraseProblem,
  newestFirst,
  vaultFile,
  vaultFileName,
  readVaultFile,
  openVaultFile,
  mergeChats,
} from "./device-vault.js";
import {
  loadMeta,
  saveMeta,
  listRecords,
  putRecords,
  deleteRecord,
  replaceVault,
  deleteVault,
  deleteAltVault,
  altStore,
  exclusive,
} from "./device-vault-store.js";
// Decoy Vault: a second passphrase that opens a separate, harmless vault
// (src/decoy-vault.js). Only when it's released (`decoy`).
import { openEither, createDecoy, decoyProblem, validSlot, DECOY_ERRORS, DECOY_LIMITS } from "./decoy-vault.js";
// A new decoy's sample chats are in the language the app is shown in.
import { getLanguage } from "./i18n.js";
import "./device-vault.css";
// Vault Sync: optional, end-to-end-encrypted sync of this vault. Its UI
// renders only when it's released and passed in (`sync`); it's the only
// part that talks to the server (src/VaultSync.jsx).
import { VaultSyncSection, VaultSyncJoin, VaultSyncStatus, ConflictCopyTag } from "./VaultSync.jsx";

// Device Vault: "Save on this device only" (see src/device-vault.js).
export { vaultReleased } from "./device-vault.js";

// Activity that keeps an unlocked vault open.
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"];
const idleLabel = (m) => (m === 60 ? "1 hour" : `${m} minutes`);

// The unlocked key, held in this tab's memory only (never in storage), so
// moving between the workspace and account pages keeps the vault open.
// Closing or reloading the tab loses it; the idle timer, Lock and a change
// of account drop it. Watching for idleness runs whichever page is open.
// Decoy Vault: `slot` says which of the two vaults the key opens ("main", or
// "alt" for the decoy). It never reaches the screen.
const session = { account: null, key: null, slot: "main", minutes: DEFAULT_IDLE_MINUTES, last: 0, timer: null };
const dropListeners = new Set();
const bump = () => (session.last = Date.now());
const checkIdle = () => {
  if (session.key && idleExpired(session.last, Date.now(), session.minutes)) dropKey("idle");
};
const onShown = () => document.visibilityState === "visible" && checkIdle();
const onGone = () => dropKey("closed");
function holdKey(account, key, minutes, slot = "main") {
  session.account = account;
  session.key = key;
  session.slot = slot;
  session.minutes = minutes;
  session.last = Date.now();
  if (session.timer) return;
  for (const e of ACTIVITY) window.addEventListener(e, bump, { passive: true, capture: true });
  window.addEventListener("pagehide", onGone);
  document.addEventListener("visibilitychange", onShown);
  session.timer = setInterval(checkIdle, 5000);
}
function dropKey(reason) {
  const had = !!session.key;
  session.key = null;
  session.account = null;
  session.slot = "main";
  if (session.timer) {
    for (const e of ACTIVITY) window.removeEventListener(e, bump, { capture: true });
    window.removeEventListener("pagehide", onGone);
    document.removeEventListener("visibilitychange", onShown);
    clearInterval(session.timer);
    session.timer = null;
  }
  if (had) for (const fn of [...dropListeners]) fn(reason);
}

// The vault for the signed-in account in this browser: its state, and the
// decrypted chats while unlocked (dropped again with the key).
//
// Decoy Vault (`decoy`: released): the account may also have a decoy, a
// second vault opened by its own passphrase. Unlocking then always derives
// both keys (src/decoy-vault.js) and opens whichever vault the passphrase
// belongs to; everything below reads and writes only the open one. The
// returned state is the same shape for either vault: which one is open is
// kept out of it, apart from `syncable` (Vault Sync syncs only the real one)
// and `decoy.set`, which the decoy always reports as false.
const EMPTY = { status: "off", meta: null, main: null, slot: "main", altSet: false, chats: [], damaged: 0 };
export function useDeviceVault({ enabled, account, onLock, decoy = false }) {
  const [state, setState] = useState(EMPTY);
  // Counts this tab's own changes, so Vault Sync (src/VaultSync.jsx) knows
  // when there's something to send.
  const [rev, setRev] = useState(0);
  const changed = () => setRev((n) => n + 1);
  // And which chats the last sync brought from another device, so an open
  // one can reload (Workspace.jsx).
  const [remoteChanges, setRemoteChanges] = useState({ rev: 0, ids: [] });
  const stateRef = useRef(state);
  stateRef.current = state;
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;
  const accountRef = useRef(account);
  accountRef.current = account;
  const decoyRef = useRef(decoy);
  decoyRef.current = decoy;
  useEffect(() => {
    const listener = (reason) => {
      // Locked again: back to the real vault's settings, whichever was open.
      setState((s) =>
        s.status === "unlocked"
          ? { ...EMPTY, status: "locked", meta: s.main, main: s.main, reason }
          : s,
      );
      onLockRef.current?.(reason);
    };
    dropListeners.add(listener);
    return () => dropListeners.delete(listener);
  }, []);
  useEffect(() => {
    if (!enabled || !account) {
      if (session.key && session.account !== account) dropKey("account");
      setState(EMPTY);
      return;
    }
    if (session.key && session.account !== account) dropKey("account");
    let live = true;
    setState({ ...EMPTY, status: "loading" });
    loadMeta(account)
      .then(async (meta) => {
        if (!live) return;
        // Still unlocked from another page of this tab: the vault that was
        // open, with its own settings.
        if (meta && session.key && session.account === account) {
          const slot = session.slot;
          const opened = slot === "alt" ? await loadMeta(altStore(account)) : meta;
          if (live && opened) return open(session.key, opened, account, slot, meta);
          if (live) dropKey("closed");
        }
        if (live) setState({ ...EMPTY, status: meta ? "locked" : "none", meta, main: meta });
      })
      .catch(() => live && setState({ ...EMPTY, status: "unavailable" }));
    return () => {
      live = false;
    };
  }, [enabled, account]);

  // The database a slot's chats live in.
  const storeOf = (forAccount, slot) => (slot === "alt" ? altStore(forAccount) : forAccount);
  // Decrypts every chat of one vault with `k` and opens it, unless the
  // account changed meanwhile. `main` is the real vault's settings.
  async function open(k, meta, forAccount, slot = "main", main = meta) {
    const records = await listRecords(storeOf(forAccount, slot));
    const chats = [];
    let damaged = 0;
    for (const r of records) {
      try {
        chats.push(await openChat(k, r));
      } catch {
        damaged++;
      }
    }
    // Whether a decoy is set: read whichever vault opened, so both do the
    // same work; only the real vault is ever told.
    const alt = decoyRef.current ? await loadMeta(altStore(forAccount)).catch(() => null) : null;
    if (accountRef.current !== forAccount) return;
    holdKey(forAccount, k, meta.idleMinutes, slot);
    setState({
      ...EMPTY,
      status: "unlocked",
      meta,
      main,
      slot,
      altSet: slot === "main" && validSlot(alt),
      chats: newestFirst(chats),
      damaged,
    });
  }
  const need = () => {
    if (!session.key || session.account !== account)
      throw new VaultError("locked", "Device Vault is locked.");
    return session.key;
  };
  // Only the real vault: Vault Sync and its re-keying never touch the decoy.
  const needMain = () => {
    const k = need();
    if (session.slot !== "main") throw new VaultError("locked", "Device Vault is locked.");
    return k;
  };
  // The typed passphrase must be the open vault's: checked by deriving both
  // keys, exactly as unlocking does.
  async function confirmOpen(passphrase) {
    need();
    const slot = session.slot;
    const main = stateRef.current.main;
    const alt = await loadMeta(altStore(account)).catch(() => null);
    const found = await openEither({ main, alt }, passphrase);
    if (found.slot !== slot || session.slot !== slot)
      throw new VaultError("wrong_passphrase", VAULT_ERRORS.wrong_passphrase);
    return slot;
  }
  const { slot, main, altSet, ...shown } = state;
  return {
    ...shown,
    rev,
    remoteChanges,
    unlocked: state.status === "unlocked",
    // Vault Sync may run only while the real vault is open (or none is).
    syncable: !(state.status === "unlocked" && slot === "alt"),
    lock: (reason = "manual") => dropKey(reason),
    async create(passphrase, idle) {
      const forAccount = account;
      const { meta, key } = await createVault(passphrase, { idleMinutes: idle });
      // A decoy left from a vault deleted some other way goes first.
      await deleteAltVault(forAccount);
      await replaceVault(forAccount, meta, []);
      await open(key, meta, forAccount);
    },
    async unlock(passphrase) {
      const forAccount = account;
      const meta = stateRef.current.main || (await loadMeta(forAccount));
      if (!meta) throw new VaultError("missing", "There's no vault on this device yet.");
      if (!decoyRef.current) return open(await unlockVault(meta, passphrase), meta, forAccount);
      const alt = await loadMeta(altStore(forAccount)).catch(() => null);
      const found = await openEither({ main: meta, alt }, passphrase);
      await open(found.key, found.meta, forAccount, found.slot, meta);
    },
    async save(chat) {
      const k = need();
      const store = storeOf(account, session.slot);
      const record = await sealChat(k, chat);
      await exclusive(store, () => putRecords(store, [record]));
      if (session.key !== k) return;
      setState((s) => ({ ...s, chats: newestFirst([chat, ...s.chats.filter((c) => c.id !== chat.id)]) }));
      changed();
    },
    async remove(id) {
      need();
      const store = storeOf(account, session.slot);
      await exclusive(store, () => deleteRecord(store, id));
      setState((s) => ({ ...s, chats: s.chats.filter((c) => c.id !== id) }));
      changed();
    },
    // ---- Vault Sync (src/VaultSync.jsx); nothing here touches the network ----
    // The unlocked key, for sealing and opening synced records in this tab.
    // Never the decoy's.
    key: () => needMain(),
    // Chats another device changed or deleted, already written to this
    // vault by the sync: shown without decrypting the vault again. Never
    // into the decoy, if it was opened while a sync ran.
    applyRemote(shown = [], gone = []) {
      if (!shown.length && !gone.length) return;
      if (session.slot !== "main") return;
      const drop = new Set([...gone, ...shown.map((c) => c.id)]);
      setState((s) =>
        s.status === "unlocked" && s.slot === "main" && session.account === account
          ? { ...s, chats: newestFirst([...shown, ...s.chats.filter((c) => !drop.has(c.id))]) }
          : s,
      );
      setRemoteChanges((r) => ({ rev: r.rev + 1, ids: [...drop] }));
    },
    // A device joining a synced vault it doesn't have yet: the synced
    // settings, opened with the key its passphrase gave.
    async adopt(meta, key) {
      const forAccount = account;
      await deleteAltVault(forAccount);
      await exclusive(forAccount, () => replaceVault(forAccount, meta, []));
      await open(key, meta, forAccount);
    },
    // Joining a synced vault from a device that has its own: every chat here
    // is sealed again with the synced key, and this vault then opens with
    // the synced passphrase. A chat that can't be read here can't be moved.
    async rekey(meta, key) {
      const forAccount = account;
      needMain();
      const records = [];
      for (const c of stateRef.current.chats) records.push(await sealChat(key, c));
      await exclusive(forAccount, () => replaceVault(forAccount, meta, records));
      await open(key, meta, forAccount);
    },
    async setIdle(minutes) {
      need();
      const store = storeOf(account, session.slot);
      const meta = { ...stateRef.current.meta, idleMinutes: minutes };
      await saveMeta(store, meta);
      session.minutes = minutes;
      setState((s) => ({ ...s, meta, ...(s.slot === "main" ? { main: meta } : {}) }));
    },
    async exportFile() {
      need();
      download(vaultFileName(), vaultFile(stateRef.current.meta, await listRecords(storeOf(account, session.slot))));
    },
    // A vault file from another device: adopted whole when this browser has
    // no vault yet, otherwise re-encrypted with the open vault's key and
    // merged into it.
    async importFile(text, passphrase) {
      const forAccount = account;
      const parsed = readVaultFile(text);
      const { key: fileKey, chats } = await openVaultFile(parsed, passphrase);
      if (stateRef.current.status === "none") {
        await deleteAltVault(forAccount);
        await replaceVault(forAccount, parsed.meta, parsed.records);
        await open(fileKey, parsed.meta, forAccount);
        return { added: chats.length, kept: 0 };
      }
      const k = need();
      const openSlot = session.slot;
      const store = storeOf(forAccount, openSlot);
      const fresh = mergeChats(stateRef.current.chats, chats);
      const records = [];
      for (const c of fresh) records.push(await sealChat(k, c));
      await exclusive(store, () => putRecords(store, records));
      await open(k, stateRef.current.meta, forAccount, openSlot, stateRef.current.main);
      if (fresh.length) changed();
      return { added: fresh.length, kept: chats.length - fresh.length };
    },
    // Deleting the vault ("Forgot it?") deletes any decoy with it.
    async destroy() {
      const forAccount = account;
      dropKey("deleted");
      await deleteVault(forAccount);
      setState({ ...EMPTY, status: "none" });
    },
    // ---- Decoy Vault (Manage vault → Decoy passphrase) ----
    // Set, change or remove need the passphrase of the vault that's open.
    // Inside the decoy nothing is ever written: it reports no decoy, and
    // setting one is refused once the passphrase checks out.
    decoy: {
      live: !!decoy,
      set: slot === "main" && altSet,
      async save(decoyPassphrase, vaultPassphrase, { lang = "en", model = null } = {}) {
        const forAccount = account;
        const problem = decoyProblem(decoyPassphrase, vaultPassphrase);
        if (problem) throw new VaultError("decoy_passphrase", problem);
        const openSlot = await confirmOpen(vaultPassphrase);
        if (openSlot !== "main") throw new VaultError("decoy_here", DECOY_ERRORS.here);
        const made = await createDecoy(stateRef.current.main, decoyPassphrase, { lang, model });
        const store = altStore(forAccount);
        await exclusive(store, () => replaceVault(store, made.meta, made.records));
        setState((s) => (s.slot === "main" && s.status === "unlocked" ? { ...s, altSet: true } : s));
      },
      async remove(vaultPassphrase) {
        const forAccount = account;
        const openSlot = await confirmOpen(vaultPassphrase);
        if (openSlot !== "main") throw new VaultError("decoy_here", DECOY_ERRORS.here);
        await exclusive(altStore(forAccount), () => deleteAltVault(forAccount));
        setState((s) => (s.slot === "main" ? { ...s, altSet: false } : s));
      },
    },
  };
}

// Composer control beside Off the record, styled the same way.
// `synced`: Vault Sync is on, so the vault's ciphertext is on the server too.
export function DeviceOnlyToggle({ active, onToggle, disabled, synced = false }) {
  return (
    <button
      type="button"
      className={"attachment-control web-toggle device-only-toggle" + (active ? " on" : "")}
      aria-pressed={active}
      disabled={disabled}
      title={
        synced
          ? "Device only: encrypted in this browser and synced end-to-end encrypted; ANONYMA stores only ciphertext"
          : "Device only: saved encrypted in this browser, never on ANONYMA's servers"
      }
      onClick={onToggle}
    >
      <Icon name={active ? "lock" : "unlock"} size={17} />
      <span>Device only</span>
    </button>
  );
}
// Shown above the composer while Device only is on.
export function DeviceOnlyNotice({ locked, onUnlock, synced = false }) {
  return locked ? (
    <div className="notice error device-only-notice" role="alert">
      <Icon name="lock" size={17} />
      <span>
        Device Vault is locked. Unlock it to keep saving this chat on this device.
      </span>
      <button type="button" className="small-button" onClick={onUnlock}>
        Unlock
      </button>
    </div>
  ) : synced ? (
    <Notice>
      Device only: this chat is encrypted in this browser and synced to your
      other devices end-to-end encrypted. ANONYMA's servers store only
      ciphertext; the model provider still receives what you send.
    </Notice>
  ) : (
    <Notice>
      Device only: this chat is encrypted and saved in this browser. ANONYMA's
      servers store none of it; the model provider still receives what you send.
    </Notice>
  );
}
export function VaultLimits() {
  return (
    <ul className="vault-limits">
      {VAULT_LIMITS.map((line) => (
        <li key={line}>
          <Icon name="warning" size={14} />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}

// The sidebar's Device Vault section: its chats while unlocked, otherwise a
// prompt to set it up or unlock it.
// `filter` narrows the list (the sidebar's project filter) and `mark` adds a
// tag before a chat's title (its project's colour); both are optional.
export function VaultSection({ vault, currentId, onOpen, onDialog, filter = null, mark = null, sync = null }) {
  if (vault.status === "off" || vault.status === "loading") return null;
  // Canvas keeps its device-only canvases here too; they're listed on the
  // Canvas page, not with the chats.
  const own = vault.chats.filter((c) => c.mode !== "canvas");
  const chats = filter ? own.filter(filter) : own;
  return (
    <section className="vault-section" aria-label="Device Vault">
      <div className="sidebar-group-label vault-label">
        <span>DEVICE VAULT</span>
        {vault.unlocked && (
          <button
            type="button"
            className="vault-lock"
            title="Lock Device Vault"
            onClick={() => vault.lock("manual")}
          >
            <Icon name="lock" size={13} />
            Lock
          </button>
        )}
      </div>
      {vault.status === "unavailable" ? (
        <p className="vault-hint">This browser can't store a vault.</p>
      ) : vault.status === "none" ? (
        <>
          <p className="vault-hint">Keep chats encrypted on this device only.</p>
          <button type="button" className="vault-action" onClick={() => onDialog({ kind: "setup" })}>
            <Icon name="lock" size={14} />
            Set up Device Vault
          </button>
        </>
      ) : vault.status === "locked" ? (
        <>
          <p className="vault-hint">Locked. Unlock to see the chats saved on this device.</p>
          <button type="button" className="vault-action" onClick={() => onDialog({ kind: "unlock" })}>
            <Icon name="unlock" size={14} />
            Unlock
          </button>
        </>
      ) : (
        <>
          <div className="conversation-list vault-list">
            {chats.map((c) => (
              <div className={c.id === currentId ? "current" : ""} key={c.id}>
                <button onClick={() => onOpen(c)}>
                  {sync?.live && c.conflictCopy && <ConflictCopyTag />}
                  <span data-i18n="off">
                    {mark?.(c)}
                    {c.title}
                  </span>
                </button>
                <button
                  className="conversation-options"
                  aria-label="Delete this vault chat"
                  title="Delete this vault chat"
                  onClick={() => onDialog({ kind: "delete", chat: c })}
                >
                  <Icon name="close" size={13} />
                </button>
              </div>
            ))}
          </div>
          {!own.length ? (
            <p className="vault-hint">No device-only chats yet. Turn on Device only in the composer.</p>
          ) : (
            !chats.length && <p className="vault-hint">None here for this filter.</p>
          )}
          <VaultSyncStatus sync={sync} onManage={() => onDialog({ kind: "manage" })} />
          {vault.damaged > 0 && (
            <p className="vault-hint">
              {vault.damaged === 1
                ? "1 chat couldn't be read."
                : `${vault.damaged} chats couldn't be read.`}
            </p>
          )}
          <button type="button" className="vault-action" onClick={() => onDialog({ kind: "manage" })}>
            <Icon name="settings" size={14} />
            Manage vault
          </button>
        </>
      )}
    </section>
  );
}

function PassphraseField({ label, value, onChange, autoComplete, autoFocus }) {
  return (
    <label>
      {label}
      <input
        type="password"
        data-i18n="off"
        value={value}
        autoComplete={autoComplete}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function IdleSelect({ value, onChange }) {
  return (
    <label>
      Lock after this long idle
      <select value={value} onChange={(e) => onChange(Number(e.target.value))}>
        {IDLE_CHOICES.map((m) => (
          <option key={m} value={m}>
            {idleLabel(m)}
          </option>
        ))}
      </select>
    </label>
  );
}
// Import a vault file made on another device, with that file's passphrase.
function ImportForm({ vault, onDone }) {
  const [text, setText] = useState(null),
    [name, setName] = useState(""),
    [pass, setPass] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [result, setResult] = useState(null);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await vault.importFile(text, pass);
      setResult(r);
      setPass("");
      onDone?.(r);
    } catch (err) {
      setError(err instanceof VaultError ? err.message : "The vault file couldn't be imported.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="vault-import" onSubmit={submit}>
      <label>
        Vault file
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (e) => {
            const f = e.target.files?.[0];
            setResult(null);
            setError("");
            setName(f?.name || "");
            setText(f ? await f.text() : null);
          }}
        />
      </label>
      <PassphraseField
        label="That file's passphrase"
        value={pass}
        onChange={setPass}
        autoComplete="current-password"
      />
      {error && <Notice type="error">{error}</Notice>}
      {result && (
        <Notice>
          {result.added === 1 ? "1 chat imported." : `${result.added} chats imported.`}
        </Notice>
      )}
      <div className="inline-actions">
        <button className="small-button" disabled={!text || !pass || busy}>
          <Icon name="download" size={14} />
          {busy ? "Importing…" : "Import"}
        </button>
        {name && <small className="vault-file-name" data-i18n="off">{name}</small>}
      </div>
    </form>
  );
}

// Decoy Vault's honest limits, next to where a decoy passphrase is set.
export function DecoyLimits() {
  return (
    <ul className="vault-limits">
      {DECOY_LIMITS.map((line) => (
        <li key={line}>
          <Icon name="warning" size={14} />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
}
// Manage vault → Decoy passphrase: set, change or remove it, each confirmed
// with the open vault's passphrase. The decoy shows this exactly as a real
// vault without a decoy does (vault.decoy.set is false there).
export function DecoySection({ vault, sampleModel = null }) {
  const [view, setView] = useState(""), // "", "set" or "remove"
    [pass, setPass] = useState(""),
    [again, setAgain] = useState(""),
    [current, setCurrent] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [note, setNote] = useState("");
  if (!vault.decoy?.live) return null;
  const set = !!vault.decoy.set;
  const changing = view === "set" && set;
  const mismatch = again && pass !== again;
  const reset = (next = "") => {
    setView(next);
    setPass("");
    setAgain("");
    setCurrent("");
    setError("");
  };
  async function run(fn, done) {
    setBusy(true);
    setError("");
    setNote("");
    try {
      await fn();
      reset();
      setNote(done);
    } catch (err) {
      setError(err instanceof VaultError ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="vault-block vault-decoy">
      <h3>Decoy passphrase</h3>
      {view === "set" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(
              () => vault.decoy.save(pass, current, { lang: getLanguage(), model: sampleModel }),
              "Decoy passphrase set. Lock the vault and unlock with it to see the decoy.",
            );
          }}
        >
          <p>
            {changing
              ? "Choose a new decoy passphrase. The decoy starts over with fresh sample chats."
              : "Unlocking with a decoy passphrase opens a separate vault instead of this one. It starts with a few ordinary sample chats you can continue, delete or add to."}
          </p>
          <PassphraseField
            label={`Decoy passphrase (at least ${MIN_PASSPHRASE} characters)`}
            value={pass}
            onChange={setPass}
            autoComplete="new-password"
            autoFocus
          />
          <PassphraseField
            label="Repeat the decoy passphrase"
            value={again}
            onChange={setAgain}
            autoComplete="new-password"
          />
          {mismatch && <p className="vault-field-error">The passphrases don't match.</p>}
          <PassphraseField
            label="This vault's passphrase, to confirm"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
          />
          <DecoyLimits />
          {error && <Notice type="error">{error}</Notice>}
          <div className="inline-actions">
            <Button disabled={busy || !!passphraseProblem(pass) || pass !== again || !current}>
              {busy ? "Saving…" : changing ? "Change decoy passphrase" : "Set decoy passphrase"}
            </Button>
            <Button secondary type="button" disabled={busy} onClick={() => reset()}>
              Cancel
            </Button>
          </div>
        </form>
      ) : view === "remove" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            run(() => vault.decoy.remove(current), "Decoy removed. Only this vault's passphrase unlocks now.");
          }}
        >
          <p>
            Remove the decoy passphrase? The decoy vault and its chats are
            deleted from this browser.
          </p>
          <PassphraseField
            label="This vault's passphrase, to confirm"
            value={current}
            onChange={setCurrent}
            autoComplete="current-password"
            autoFocus
          />
          {error && <Notice type="error">{error}</Notice>}
          <div className="inline-actions">
            <Button disabled={busy || !current}>{busy ? "Removing…" : "Remove decoy"}</Button>
            <Button secondary type="button" disabled={busy} onClick={() => reset()}>
              Keep it
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p>
            {set
              ? "A decoy passphrase is set. Unlocking with it opens a separate vault instead of this one."
              : "If someone makes you unlock this vault, a second passphrase can open a separate, harmless vault instead."}
          </p>
          {note && <Notice>{note}</Notice>}
          {set && <DecoyLimits />}
          <div className="inline-actions">
            <button type="button" className="small-button" onClick={() => reset("set")}>
              <Icon name="key" size={14} />
              {set ? "Change decoy passphrase" : "Set a decoy passphrase"}
            </button>
            {set && (
              <button type="button" className="small-button danger-text" onClick={() => reset("remove")}>
                <Icon name="delete" size={14} />
                Remove decoy
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

// Set up, unlock, manage, or delete a chat from the vault.
// `sampleModel`: the model picked in the composer, for a new decoy's chats.
export function VaultDialog({ vault, dialog, onClose, onUnlocked, sync = null, sampleModel = null }) {
  const [pass, setPass] = useState(""),
    [again, setAgain] = useState(""),
    [idle, setIdle] = useState(DEFAULT_IDLE_MINUTES),
    [understood, setUnderstood] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false),
    [importing, setImporting] = useState(false),
    // Vault Sync: set up a separate vault here instead of opening the synced
    // one, and forget the synced copy along with a deleted vault.
    [separate, setSeparate] = useState(false),
    [forgetSynced, setForgetSynced] = useState(false);
  const kind = dialog.kind;
  const joinSynced = kind === "setup" && !separate && !!sync?.live && !!sync.synced;
  // Canvas keeps its device-only canvases in the vault too (mode "canvas").
  const canvases = vault.chats.filter((c) => c.mode === "canvas").length,
    chats = vault.chats.length - canvases;
  async function run(fn) {
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (err) {
      setError(err instanceof VaultError ? err.message : err?.message || "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }
  const title =
    joinSynced
      ? "Open your synced vault"
      : kind === "setup"
      ? "Set up Device Vault"
      : kind === "unlock"
        ? "Unlock Device Vault"
        : kind === "delete"
          ? "Delete this vault chat?"
          : "Device Vault";
  const mismatch = kind === "setup" && again && pass !== again;
  return (
    <Modal title={title} onClose={onClose}>
      <div className="vault-dialog">
        {kind === "delete" ? (
          <>
            {sync?.on ? (
              <p>
                It's deleted from this vault on every device that syncs it.
                ANONYMA only ever had its ciphertext, so this can't be undone.
              </p>
            ) : (
              <p>
                It's removed from this browser's vault. It was never on ANONYMA's
                servers, so this can't be undone.
              </p>
            )}
            <p className="vault-chat-title" data-i18n="off">{dialog.chat.title}</p>
            {error && <Notice type="error">{error}</Notice>}
            <div className="inline-actions">
              <Button
                disabled={busy}
                onClick={() => run(async () => {
                  await vault.remove(dialog.chat.id);
                  onClose("deleted");
                })}
              >
                Delete
              </Button>
              <Button secondary onClick={() => onClose()}>
                Keep it
              </Button>
            </div>
          </>
        ) : joinSynced ? (
          <VaultSyncJoin sync={sync} onDone={() => onUnlocked()} onCreate={() => setSeparate(true)} />
        ) : kind === "setup" && !importing ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await vault.create(pass, idle);
                onUnlocked();
              });
            }}
          >
            <p>
              Device-only chats are encrypted in this browser with a key made
              from your passphrase. ANONYMA never receives the passphrase or
              the chats.
            </p>
            <PassphraseField
              label={`Passphrase (at least ${MIN_PASSPHRASE} characters)`}
              value={pass}
              onChange={setPass}
              autoComplete="new-password"
              autoFocus
            />
            <PassphraseField
              label="Repeat the passphrase"
              value={again}
              onChange={setAgain}
              autoComplete="new-password"
            />
            {mismatch && <p className="vault-field-error">The passphrases don't match.</p>}
            <IdleSelect value={idle} onChange={setIdle} />
            <VaultLimits />
            <label className="vault-check">
              <input
                type="checkbox"
                checked={understood}
                onChange={(e) => setUnderstood(e.target.checked)}
              />
              I understand that a lost passphrase can't be recovered.
            </label>
            {error && <Notice type="error">{error}</Notice>}
            <div className="inline-actions">
              <Button disabled={busy || !understood || !!passphraseProblem(pass) || pass !== again}>
                {busy ? "Creating…" : "Create vault"}
              </Button>
              <button type="button" className="small-button" onClick={() => setImporting(true)}>
                Import a vault file instead
              </button>
            </div>
          </form>
        ) : kind === "setup" ? (
          <>
            <p>
              Bring a vault from another device: choose its exported file and
              enter the passphrase it was made with.
            </p>
            <ImportForm vault={vault} onDone={() => onUnlocked()} />
            <VaultLimits />
            <button type="button" className="small-button" onClick={() => setImporting(false)}>
              Create a new vault instead
            </button>
          </>
        ) : kind === "unlock" && !confirmDelete ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await vault.unlock(pass);
                setPass("");
                onUnlocked();
              });
            }}
          >
            <p>Enter your vault passphrase to see and continue the chats saved on this device.</p>
            <PassphraseField
              label="Passphrase"
              value={pass}
              onChange={setPass}
              autoComplete="current-password"
              autoFocus
            />
            {error && <Notice type="error">{error}</Notice>}
            <div className="inline-actions">
              <Button disabled={busy || !pass}>{busy ? "Unlocking…" : "Unlock"}</Button>
              <Button secondary type="button" onClick={() => onClose()}>
                Cancel
              </Button>
            </div>
            <VaultLimits />
            <p className="vault-forgot">
              Forgot it? ANONYMA can't recover it or these chats. You can delete
              this vault and start again.{" "}
              <button type="button" className="link-button" onClick={() => setConfirmDelete(true)}>
                Delete this vault
              </button>
            </p>
          </form>
        ) : kind === "unlock" ? (
          <>
            <p>
              Delete Device Vault and every chat in it from this browser? This
              can't be undone.
            </p>
            {sync?.live && sync.synced && (
              <label className="vault-check">
                <input
                  type="checkbox"
                  checked={forgetSynced}
                  onChange={(e) => setForgetSynced(e.target.checked)}
                />
                Also forget the synced copy on ANONYMA's servers. Your other
                devices keep their vaults and stop syncing.
              </label>
            )}
            {error && <Notice type="error">{error}</Notice>}
            <div className="inline-actions">
              <Button
                disabled={busy}
                onClick={() => run(async () => {
                  if (forgetSynced && sync?.synced) await sync.forget();
                  await vault.destroy();
                  onClose("deleted");
                })}
              >
                Delete vault
              </Button>
              <Button secondary onClick={() => setConfirmDelete(false)}>
                Keep it
              </Button>
            </div>
          </>
        ) : (
          <>
            <p>
              {chats === 1
                ? "1 chat is saved on this device, encrypted."
                : `${chats} chats are saved on this device, encrypted.`}
            </p>
            {canvases > 0 && <p>{canvases === 1 ? "So is 1 canvas." : `So are ${canvases} canvases.`}</p>}
            <IdleSelect
              value={vault.meta?.idleMinutes || DEFAULT_IDLE_MINUTES}
              onChange={(m) => run(() => vault.setIdle(m))}
            />
            <VaultSyncSection sync={sync} />
            <DecoySection vault={vault} sampleModel={sampleModel} />
            <div className="vault-block">
              <h3>Move to another device</h3>
              <p>
                The exported file stays encrypted: it opens only with this
                vault's passphrase.
              </p>
              <button
                type="button"
                className="small-button"
                disabled={busy}
                onClick={() => run(() => vault.exportFile())}
              >
                <Icon name="upload" size={14} />
                Export vault file
              </button>
            </div>
            <div className="vault-block">
              <h3>Import a vault file</h3>
              <p>Chats from the file are added to this vault; newer copies replace older ones.</p>
              <ImportForm vault={vault} />
            </div>
            <VaultLimits />
            {error && <Notice type="error">{error}</Notice>}
            <div className="inline-actions">
              <Button
                onClick={() => {
                  vault.lock("manual");
                  onClose();
                }}
              >
                <Icon name="lock" size={15} />
                Lock now
              </Button>
              <Button secondary onClick={() => onClose()}>
                Close
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
