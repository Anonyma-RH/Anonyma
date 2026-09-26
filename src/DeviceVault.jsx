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
} from "./device-vault-store.js";
import "./device-vault.css";

// Device Vault: "Save on this device only" (see src/device-vault.js).
export { vaultReleased } from "./device-vault.js";

// Activity that keeps an unlocked vault open.
const ACTIVITY = ["pointerdown", "pointermove", "keydown", "wheel", "touchstart", "scroll"];
const idleLabel = (m) => (m === 60 ? "1 hour" : `${m} minutes`);

// The unlocked key, held in this tab's memory only (never in storage), so
// moving between the workspace and account pages keeps the vault open.
// Closing or reloading the tab loses it; the idle timer, Lock and a change
// of account drop it. Watching for idleness runs whichever page is open.
const session = { account: null, key: null, minutes: DEFAULT_IDLE_MINUTES, last: 0, timer: null };
const dropListeners = new Set();
const bump = () => (session.last = Date.now());
const checkIdle = () => {
  if (session.key && idleExpired(session.last, Date.now(), session.minutes)) dropKey("idle");
};
const onShown = () => document.visibilityState === "visible" && checkIdle();
const onGone = () => dropKey("closed");
function holdKey(account, key, minutes) {
  session.account = account;
  session.key = key;
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
export function useDeviceVault({ enabled, account, onLock }) {
  const [state, setState] = useState({ status: "off", meta: null, chats: [], damaged: 0 });
  const stateRef = useRef(state);
  stateRef.current = state;
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;
  const accountRef = useRef(account);
  accountRef.current = account;
  useEffect(() => {
    const listener = (reason) => {
      setState((s) =>
        s.status === "unlocked" ? { status: "locked", meta: s.meta, chats: [], damaged: 0, reason } : s,
      );
      onLockRef.current?.(reason);
    };
    dropListeners.add(listener);
    return () => dropListeners.delete(listener);
  }, []);
  useEffect(() => {
    if (!enabled || !account) {
      if (session.key && session.account !== account) dropKey("account");
      setState({ status: "off", meta: null, chats: [], damaged: 0 });
      return;
    }
    if (session.key && session.account !== account) dropKey("account");
    let live = true;
    setState({ status: "loading", meta: null, chats: [], damaged: 0 });
    loadMeta(account)
      .then(async (meta) => {
        if (!live) return;
        // Still unlocked from another page of this tab.
        if (meta && session.key && session.account === account)
          return open(session.key, meta, account);
        setState({ status: meta ? "locked" : "none", meta, chats: [], damaged: 0 });
      })
      .catch(() => live && setState({ status: "unavailable", meta: null, chats: [], damaged: 0 }));
    return () => {
      live = false;
    };
  }, [enabled, account]);

  // Decrypts every chat with `k` and opens the vault, unless the account
  // changed meanwhile.
  async function open(k, meta, forAccount) {
    const records = await listRecords(forAccount);
    const chats = [];
    let damaged = 0;
    for (const r of records) {
      try {
        chats.push(await openChat(k, r));
      } catch {
        damaged++;
      }
    }
    if (accountRef.current !== forAccount) return;
    holdKey(forAccount, k, meta.idleMinutes);
    setState({ status: "unlocked", meta, chats: newestFirst(chats), damaged });
  }
  const need = () => {
    if (!session.key || session.account !== account)
      throw new VaultError("locked", "Device Vault is locked.");
    return session.key;
  };
  return {
    ...state,
    unlocked: state.status === "unlocked",
    lock: (reason = "manual") => dropKey(reason),
    async create(passphrase, idle) {
      const forAccount = account;
      const { meta, key } = await createVault(passphrase, { idleMinutes: idle });
      await replaceVault(forAccount, meta, []);
      await open(key, meta, forAccount);
    },
    async unlock(passphrase) {
      const forAccount = account;
      const meta = stateRef.current.meta || (await loadMeta(forAccount));
      if (!meta) throw new VaultError("missing", "There's no vault on this device yet.");
      await open(await unlockVault(meta, passphrase), meta, forAccount);
    },
    async save(chat) {
      const k = need();
      const record = await sealChat(k, chat);
      await putRecords(account, [record]);
      if (session.key !== k) return;
      setState((s) => ({ ...s, chats: newestFirst([chat, ...s.chats.filter((c) => c.id !== chat.id)]) }));
    },
    async remove(id) {
      need();
      await deleteRecord(account, id);
      setState((s) => ({ ...s, chats: s.chats.filter((c) => c.id !== id) }));
    },
    async setIdle(minutes) {
      need();
      const meta = { ...stateRef.current.meta, idleMinutes: minutes };
      await saveMeta(account, meta);
      session.minutes = minutes;
      setState((s) => ({ ...s, meta }));
    },
    async exportFile() {
      need();
      download(vaultFileName(), vaultFile(stateRef.current.meta, await listRecords(account)));
    },
    // A vault file from another device: adopted whole when this browser has
    // no vault yet, otherwise re-encrypted with this vault's key and merged.
    async importFile(text, passphrase) {
      const forAccount = account;
      const parsed = readVaultFile(text);
      const { key: fileKey, chats } = await openVaultFile(parsed, passphrase);
      if (stateRef.current.status === "none") {
        await replaceVault(forAccount, parsed.meta, parsed.records);
        await open(fileKey, parsed.meta, forAccount);
        return { added: chats.length, kept: 0 };
      }
      const k = need();
      const fresh = mergeChats(stateRef.current.chats, chats);
      const records = [];
      for (const c of fresh) records.push(await sealChat(k, c));
      await putRecords(forAccount, records);
      await open(k, stateRef.current.meta, forAccount);
      return { added: fresh.length, kept: chats.length - fresh.length };
    },
    async destroy() {
      const forAccount = account;
      dropKey("deleted");
      await deleteVault(forAccount);
      setState({ status: "none", meta: null, chats: [], damaged: 0 });
    },
  };
}

// Composer control beside Off the record, styled the same way.
export function DeviceOnlyToggle({ active, onToggle, disabled }) {
  return (
    <button
      type="button"
      className={"attachment-control web-toggle device-only-toggle" + (active ? " on" : "")}
      aria-pressed={active}
      disabled={disabled}
      title="Device only: saved encrypted in this browser, never on ANONYMA's servers"
      onClick={onToggle}
    >
      <Icon name={active ? "lock" : "unlock"} size={17} />
      <span>Device only</span>
    </button>
  );
}
// Shown above the composer while Device only is on.
export function DeviceOnlyNotice({ locked, onUnlock }) {
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
export function VaultSection({ vault, currentId, onOpen, onDialog, filter = null, mark = null }) {
  if (vault.status === "off" || vault.status === "loading") return null;
  const chats = filter ? vault.chats.filter(filter) : vault.chats;
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
                <button data-i18n="off" onClick={() => onOpen(c)}>
                  {mark?.(c)}
                  {c.title}
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
          {!vault.chats.length ? (
            <p className="vault-hint">No device-only chats yet. Turn on Device only in the composer.</p>
          ) : (
            !chats.length && <p className="vault-hint">None here for this filter.</p>
          )}
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

// Set up, unlock, manage, or delete a chat from the vault.
export function VaultDialog({ vault, dialog, onClose, onUnlocked }) {
  const [pass, setPass] = useState(""),
    [again, setAgain] = useState(""),
    [idle, setIdle] = useState(DEFAULT_IDLE_MINUTES),
    [understood, setUnderstood] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [confirmDelete, setConfirmDelete] = useState(false),
    [importing, setImporting] = useState(false);
  const kind = dialog.kind;
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
    kind === "setup"
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
            <p>
              It's removed from this browser's vault. It was never on ANONYMA's
              servers, so this can't be undone.
            </p>
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
            {error && <Notice type="error">{error}</Notice>}
            <div className="inline-actions">
              <Button
                disabled={busy}
                onClick={() => run(async () => {
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
              {vault.chats.length === 1
                ? "1 chat is saved on this device, encrypted."
                : `${vault.chats.length} chats are saved on this device, encrypted.`}
            </p>
            <IdleSelect
              value={vault.meta?.idleMinutes || DEFAULT_IDLE_MINUTES}
              onChange={(m) => run(() => vault.setIdle(m))}
            />
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
