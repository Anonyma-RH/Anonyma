import React, { useEffect, useRef, useState } from "react";
import { Icon, Button, Modal, Notice } from "./ui.jsx";
import { api, isReleased, readStore, releaseUpdate } from "./lib.js";
import { useDeviceVault } from "./DeviceVault.jsx";
import { vaultReleased } from "./device-vault.js";
import { decoyReleased } from "./decoy-vault.js";
import { openBackupEngine } from "./account-backup-client.js";
import { makeBackup, restoreBackup } from "./account-backup-run.js";
import { backupPassphraseProblem, passphraseStrength } from "./account-backup.js";
import {
  BACKUP_EXTENSION,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_LABEL,
  MAX_HEADER_BYTES,
  MIN_BACKUP_PASSPHRASE,
  backupFileName,
  kindLive,
  makeKinds,
} from "./account-backup-spec.js";
import { dayLabel } from "./AccountBackup.jsx";
import { saveVeilState } from "./veil.js";

// Encrypted Backup's two dialogs, opened from Account → Settings
// (src/AccountBackup.jsx). Making a backup reads the account's content and
// seals it in a worker in this browser, then saves the file here; restoring
// opens a file in the worker and sends only what the person chooses, through
// src/account-backup-run.js. The passphrase is cleared from the page once
// it's used.

// What a backup can hold, as the dialogs name it.
const LABELS = {
  chats: "Saved chats",
  projects: "Projects and their instructions",
  scrolls: "Scrolls",
  instructions: "Standing instructions",
  memory: "Memory facts",
  routines: "Routines (their settings)",
  research: "Research watches (their settings)",
  watches: "Page watches (their settings)",
  bookmarks: "Bookmarks",
  vault: "Device Vault chats",
};
const RESTORE_KINDS = ["projects", "chats", "bookmarks", "scrolls", "instructions", "memory", "routines", "research", "watches", "vault"];
// The modes a chat can be saved in, as the restore summary names them.
const MODE_NAMES = { code: "Code & Build", uncensored: "Uncensored Models", symposium: "Symposium" };
// Kinds whose held-back items the person may still choose to restore (the
// other kinds' own routes never save a seed phrase at all).
const OVERRIDABLE = ["chats", "scrolls"];
const count = (n) => Number(n || 0).toLocaleString("en-US");
// Saves the finished file. The link stays valid for a minute, so a large
// backup has time to start downloading before it's revoked.
function saveFile(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
// Today in this browser's time zone, as YYYY-MM-DD.
const localDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const size = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export default function BackupDialog({ kind, config, user, status, onClose }) {
  const vaultLive = vaultReleased(config);
  const vault = useDeviceVault({
    enabled: vaultLive,
    account: user?.id,
    decoy: vaultLive && decoyReleased(config),
  });
  return kind === "make" ? (
    <MakeBackup config={config} status={status} vault={vaultLive ? vault : null} onClose={onClose} />
  ) : (
    <RestoreBackup config={config} status={status} vault={vaultLive ? vault : null} onClose={onClose} />
  );
}

function PassphraseInput({ label, value, onChange, autoComplete, autoFocus }) {
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

// Device Vault, when it's in this browser: unlocked, its chats can go in (or
// come back); locked, it can be unlocked here with its own passphrase.
function VaultUnlock({ vault }) {
  const [pass, setPass] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <div className="backup-vault-unlock">
      <PassphraseInput label="Device Vault passphrase" value={pass} onChange={setPass} autoComplete="current-password" />
      <button
        type="button"
        className="small-button"
        disabled={busy || !pass}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            await vault.unlock(pass);
            setPass("");
          } catch (e) {
            setError(e.message);
          } finally {
            setBusy(false);
          }
        }}
      >
        {busy ? "Unlocking…" : "Unlock"}
      </button>
      {error && <p className="backup-field-error">{error}</p>}
    </div>
  );
}

function StrengthMeter({ passphrase }) {
  const { score, label } = passphraseStrength(passphrase);
  return (
    <div className={"backup-strength s" + score} aria-live="polite">
      <span className="backup-strength-bar" aria-hidden="true">
        {[1, 2, 3, 4].map((i) => (
          <i key={i} className={i <= score ? "on" : ""} />
        ))}
      </span>
      <span>{label || `At least ${MIN_BACKUP_PASSPHRASE} characters`}</span>
    </div>
  );
}

// ---- Making a backup ----------------------------------------------------------------
function MakeBackup({ config, status, vault, onClose }) {
  const counts = status?.counts || {};
  const released = (id) => isReleased(config, id);
  const kinds = makeKinds(counts, released);
  const [include, setInclude] = useState(() => new Set(kinds)),
    [withVault, setWithVault] = useState(false),
    [pass, setPass] = useState(""),
    [again, setAgain] = useState(""),
    [understood, setUnderstood] = useState(false),
    [phase, setPhase] = useState("choose"),
    [progress, setProgress] = useState(null),
    [error, setError] = useState(""),
    [result, setResult] = useState(null);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  const vaultChats = vault?.unlocked ? vault.chats.length : 0;
  const problem = backupPassphraseProblem(pass);
  const mismatch = again && pass !== again;
  const nothing = !include.size && !(withVault && vaultChats);
  const toggle = (k) =>
    setInclude((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  async function run(e) {
    e.preventDefault();
    if (problem || pass !== again || !understood || nothing) return;
    const chosen = new Set(include);
    // Bookmarks go only with their chats.
    if (!chosen.has("chats")) chosen.delete("bookmarks");
    if (withVault && vault?.unlocked) chosen.add("vault");
    setPhase("working");
    setError("");
    setProgress(null);
    const engine = openBackupEngine();
    controller.current = new AbortController();
    try {
      const made = await makeBackup({
        api,
        engine,
        passphrase: pass,
        include: chosen,
        vaultChats: chosen.has("vault") ? vault.chats : [],
        // Veil's maps for saved chats live in this browser only.
        veilFor: (id) => readStore("veil:state:" + id, null),
        onProgress: setProgress,
        signal: controller.current.signal,
      });
      const name = backupFileName(localDay());
      saveFile(name, new Blob(made.pieces, { type: "application/octet-stream" }));
      setPass("");
      setAgain("");
      // Only today's date is kept, for "Last backup".
      await api("/api/account/backup/made", { method: "POST", body: { day: localDay() } }).catch(() => null);
      setResult({ name, bytes: made.bytes, counts: made.counts });
      setPhase("done");
    } catch (err) {
      setError(err?.code === "stopped" ? "Stopped. No file was saved." : err?.message || "The backup couldn't be made.");
      setPhase("choose");
    } finally {
      engine.close();
    }
  }

  if (phase === "done")
    return (
      <Modal title="Backup saved" onClose={() => onClose(true)}>
        <div className="backup-dialog">
          <p className="backup-done">
            <Icon name="check" size={18} />
            <span>
              <b data-i18n="off">{result.name}</b> <span>{`(${size(result.bytes)})`}</span>
            </span>
          </p>
          <ul className="backup-report">
            {RESTORE_KINDS.map((k) => [k, result.counts[k]])
              .filter(([k, n]) => n > 0 && LABELS[k])
              .map(([k, n]) => (
                <li key={k}>
                  <span>{LABELS[k]}</span>
                  <b>{count(n)}</b>
                </li>
              ))}
          </ul>
          <p>
            Keep it somewhere safe, like a USB drive or your own cloud storage,
            and keep the passphrase somewhere else. Anyone with both can read it.
          </p>
          <div className="inline-actions">
            <Button type="button" onClick={() => onClose(true)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal title="Make an encrypted backup" onClose={() => phase !== "working" && onClose(false)}>
      <form className="backup-dialog" onSubmit={run}>
        <p>
          Your account’s content is gathered and encrypted in this browser,
          then saved as one file. ANONYMA never sees the passphrase or a
          readable copy.
        </p>
        <fieldset className="backup-kinds" disabled={phase === "working"}>
          <legend>What goes in</legend>
          {kinds.map((k) => (
            <label key={k} className={"backup-kind" + (k === "bookmarks" && !include.has("chats") ? " unavailable" : "")}>
              <input
                type="checkbox"
                checked={include.has(k) && (k !== "bookmarks" || include.has("chats"))}
                disabled={k === "bookmarks" && !include.has("chats")}
                onChange={() => toggle(k)}
              />
              <span>{LABELS[k]}</span>
              <small>{count(counts[k])}</small>
            </label>
          ))}
          {!kinds.length && <p className="backup-empty">There’s nothing saved on this account yet.</p>}
          {vault && (vault.unlocked || vault.status === "locked") && (
            <div className="backup-vault">
              {vault.unlocked ? (
                <label className="backup-kind">
                  <input type="checkbox" checked={withVault} onChange={(e) => setWithVault(e.target.checked)} />
                  <span>{LABELS.vault}</span>
                  <small>{count(vaultChats)}</small>
                </label>
              ) : (
                <>
                  <p className="backup-note">
                    Device Vault is locked. Unlock it to add its chats: they’re
                    decrypted here and encrypted again into the backup.
                  </p>
                  <VaultUnlock vault={vault} />
                </>
              )}
            </div>
          )}
        </fieldset>
        <p className="backup-note">
          Not included: files, images, audio and video (download them from
          Files and your library), shared team chats, and chats that were never
          saved, like off-the-record ones. Routines and watches go in as
          settings, without their results.
        </p>
        <PassphraseInput
          label={`Backup passphrase (at least ${MIN_BACKUP_PASSPHRASE} characters)`}
          value={pass}
          onChange={setPass}
          autoComplete="new-password"
          autoFocus
        />
        <StrengthMeter passphrase={pass} />
        {pass && problem && <p className="backup-field-error">{problem}</p>}
        <PassphraseInput label="Repeat the passphrase" value={again} onChange={setAgain} autoComplete="new-password" />
        {mismatch && <p className="backup-field-error">The passphrases don't match.</p>}
        <label className="backup-check">
          <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} />
          Lose the passphrase and the backup can’t be opened, by you or by us.
        </label>
        {error && <Notice type="error">{error}</Notice>}
        {phase === "working" && (
          <p className="backup-progress" role="status">
            {progress?.step === "chats"
              ? `Encrypting your chats… ${count(progress.done)} so far`
              : progress?.step === "sealing"
                ? "Finishing the file…"
                : "Preparing the key… this takes a few seconds."}
          </p>
        )}
        <div className="inline-actions">
          {phase === "working" ? (
            <button type="button" className="small-button" onClick={() => controller.current?.abort()}>
              Stop
            </button>
          ) : (
            <>
              <Button disabled={!!problem || pass !== again || !understood || nothing}>
                Make and save the backup <Icon name="download" size={15} />
              </Button>
              <button type="button" className="small-button" onClick={() => onClose(false)}>
                Cancel
              </button>
            </>
          )}
        </div>
      </form>
    </Modal>
  );
}

// ---- Restoring a backup --------------------------------------------------------------
function RestoreBackup({ config, status, vault, onClose }) {
  const released = (id) => isReleased(config, id);
  const [file, setFile] = useState(null),
    [pass, setPass] = useState(""),
    [phase, setPhase] = useState("pick"),
    [overview, setOverview] = useState(null),
    [choice, setChoice] = useState(new Set()),
    [allowSeed, setAllowSeed] = useState(new Set()),
    [asking, setAsking] = useState(null),
    [progress, setProgress] = useState(null),
    [error, setError] = useState(""),
    [done, setDone] = useState(null);
  const engine = useRef(null);
  const controller = useRef(null);
  useEffect(
    () => () => {
      controller.current?.abort();
      engine.current?.close();
    },
    [],
  );
  // What this account and browser can take back.
  const possible = (k) => (k === "vault" ? !!vault?.unlocked : kindLive(k, released));
  const counts = overview?.counts || {};
  const offered = RESTORE_KINDS.filter((k) => counts[k] > 0);
  // Bookmarks come back only on their restored chats.
  const choosable = (k) => possible(k) && (k !== "bookmarks" || (possible("chats") && choice.has("chats")));

  async function open(e) {
    e.preventDefault();
    if (!file || !pass) return;
    if (file.size > MAX_BACKUP_BYTES + MAX_HEADER_BYTES) {
      setError(`A backup can be at most ${MAX_BACKUP_LABEL}. This one is larger.`);
      return;
    }
    setPhase("opening");
    setError("");
    engine.current?.close();
    engine.current = openBackupEngine();
    try {
      const o = await engine.current.open(file, pass, {
        seedGuard: status?.seed_guard === true,
        onProgress: setProgress,
      });
      setPass("");
      setOverview(o);
      setChoice(new Set(RESTORE_KINDS.filter((k) => o.counts[k] > 0 && (k === "vault" ? !!vault?.unlocked : kindLive(k, released)))));
      setPhase("choose");
    } catch (err) {
      setError(err?.message || "This backup couldn't be opened.");
      setPhase("pick");
    }
  }
  async function restore() {
    const chosen = new Set([...choice].filter(choosable));
    if (!chosen.size) return;
    setPhase("working");
    setError("");
    setProgress(null);
    controller.current = new AbortController();
    const out = await restoreBackup({
      api,
      engine: engine.current,
      choice: chosen,
      allowSeed,
      vault,
      saveVeil: (id, state) => saveVeilState(id, state),
      onProgress: setProgress,
      signal: controller.current.signal,
    });
    setDone(out);
    setPhase("done");
  }
  const toggle = (k) =>
    setChoice((s) => {
      const next = new Set(s);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  const held = RESTORE_KINDS.filter((k) => choice.has(k) && overview?.seed?.[k] > 0 && !allowSeed.has(k));

  if (phase === "done") {
    const rows = RESTORE_KINDS.filter((k) => done.report[k]);
    const off = ["routines", "research", "watches"].some((k) => done.report[k]?.added);
    return (
      <Modal title={done.error ? "Restore stopped" : "Backup restored"} onClose={() => onClose(true)}>
        <div className="backup-dialog">
          {done.error && (
            <Notice type="error">
              {done.error.code === "stopped" ? "Stopped. What’s listed below was restored." : done.error.message}
            </Notice>
          )}
          <ul className="backup-report">
            {rows.map((k) => {
              const r = done.report[k];
              return (
                <li key={k}>
                  <span>{LABELS[k]}</span>
                  <span className="backup-report-counts">
                    <span>{`${count(r.added)} added`}</span>
                    {r.duplicate > 0 && <span>{`${count(r.duplicate)} already here`}</span>}
                    {r.seed > 0 && <span>{`${count(r.seed)} held back by Seed Guard`}</span>}
                    {r.limit > 0 && <span>{`${count(r.limit)} over your account’s limit`}</span>}
                    {r.failed > 0 && <span>{`${count(r.failed)} not restored`}</span>}
                    {r.unlinked > 0 && <span>{`${count(r.unlinked)} skipped: their chat wasn’t restored`}</span>}
                  </span>
                  {r.message && <small className="backup-report-why">{r.message}</small>}
                </li>
              );
            })}
          </ul>
          {done.report.chats?.added > 0 && <p className="backup-note">Restored chats are marked Restored in your chat list.</p>}
          {done.report.chats?.fallback > 0 && (
            <p className="backup-note">
              {`${count(done.report.chats.fallback)} came back as ordinary chats because their mode isn’t available on this account: ${done.report.chats.modes
                .map((m) => MODE_NAMES[m] || releaseUpdate(config, m)?.title || m)
                .join(", ")}.`}
            </p>
          )}
          {off && (
            <p className="backup-note">
              Restored routines and watches are switched off, so nothing runs or
              costs anything until you turn them on in Routines.
            </p>
          )}
          <div className="inline-actions">
            <Button type="button" onClick={() => onClose(true)}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  if (phase === "choose" || phase === "working")
    return (
      <Modal title="Choose what to restore" onClose={() => phase !== "working" && onClose(false)}>
        <div className="backup-dialog">
          <p className="backup-made">
            <span>
              {`Made on ${/T/.test(overview.made) ? new Date(overview.made).toLocaleDateString() : dayLabel(overview.made)}.`}
            </span>{" "}
            {overview.range && (
              <span>
                {`Chats from ${new Date(overview.range.from).toLocaleDateString()} to ${new Date(overview.range.to).toLocaleDateString()}.`}
              </span>
            )}
          </p>
          <fieldset className="backup-kinds" disabled={phase === "working"}>
            <legend>In this backup</legend>
            {offered.map((k) => (
              <label key={k} className={"backup-kind" + (choosable(k) ? "" : " unavailable")}>
                <input type="checkbox" checked={choosable(k) && choice.has(k)} disabled={!choosable(k)} onChange={() => toggle(k)} />
                <span>{LABELS[k]}</span>
                <small>{count(counts[k])}</small>
              </label>
            ))}
          </fieldset>
          {counts.vault > 0 && !vault?.unlocked && vault?.status !== "loading" && (
            <div className="backup-vault">
              {vault && vault.status === "locked" ? (
                <>
                  <p className="backup-note">Unlock Device Vault to put its chats back into this browser.</p>
                  <VaultUnlock vault={vault} />
                </>
              ) : (
                <p className="backup-note">
                  To restore Device Vault chats, set up Device Vault in this browser
                  first. They go back only into the vault, never to our server.
                </p>
              )}
            </div>
          )}
          {held.length > 0 && (
            <div className="backup-seed" role="status">
              <p>
                <Icon name="shield" size={15} />
                <span>
                  {`Seed Guard is holding back ${count(held.reduce((n, k) => n + overview.seed[k], 0))} items that look like they contain a seed phrase or private key. They won’t be restored.`}
                </span>
              </p>
              {held.some((k) => OVERRIDABLE.includes(k)) &&
                (asking ? (
                  <div className="backup-seed-confirm">
                    <p>They’ll be saved to your account as they are. Anyone who can read this account could read them.</p>
                    <button
                      type="button"
                      className="small-button danger-text"
                      onClick={() => {
                        setAllowSeed(new Set([...allowSeed, ...held.filter((k) => OVERRIDABLE.includes(k))]));
                        setAsking(null);
                      }}
                    >
                      Yes, restore them
                    </button>
                    <button type="button" className="small-button" onClick={() => setAsking(null)}>
                      Keep them out
                    </button>
                  </div>
                ) : (
                  <button type="button" className="small-button" onClick={() => setAsking(true)}>
                    Restore chats and scrolls anyway…
                  </button>
                ))}
            </div>
          )}
          {overview.unreadable > 0 && (
            <p className="backup-note">{`${count(overview.unreadable)} items in this file couldn’t be read and will be skipped.`}</p>
          )}
          <p className="backup-note">
            Restoring adds to what you have. Nothing is replaced or deleted, and
            anything already here is skipped. Routines and watches come back
            switched off, and a page watch reads its page once when it’s added.
          </p>
          {phase === "working" && (
            <p className="backup-progress" role="status">
              {progress?.kind ? (
                <>
                  <span>{`Restoring: ${LABELS[progress.kind]}`}</span> <span>{`${count(progress.added)} added`}</span>
                </>
              ) : (
                "Restoring…"
              )}
            </p>
          )}
          <div className="inline-actions">
            {phase === "working" ? (
              <button type="button" className="small-button" onClick={() => controller.current?.abort()}>
                Stop
              </button>
            ) : (
              <>
                <Button type="button" disabled={![...choice].some(possible)} onClick={restore}>
                  Restore <Icon name="backup" size={15} />
                </Button>
                <button type="button" className="small-button" onClick={() => onClose(false)}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      </Modal>
    );

  return (
    <Modal title="Restore a backup" onClose={() => phase !== "opening" && onClose(false)}>
      <form className="backup-dialog" onSubmit={open}>
        <p>
          Choose a backup file and enter its passphrase. It’s opened in this
          browser, and nothing is sent until you choose what to restore.
        </p>
        <label>
          Backup file (.anonyma-backup, up to 512 MB)
          <input
            type="file"
            accept={BACKUP_EXTENSION}
            disabled={phase === "opening"}
            onChange={(e) => {
              setFile(e.target.files?.[0] || null);
              setError("");
            }}
          />
        </label>
        <PassphraseInput label="Backup passphrase" value={pass} onChange={setPass} autoComplete="current-password" />
        {error && <Notice type="error">{error}</Notice>}
        {phase === "opening" && (
          <p className="backup-progress" role="status">
            {progress?.total ? `Opening… part ${count(progress.done)} of ${count(progress.total)}` : "Checking the passphrase…"}
          </p>
        )}
        <div className="inline-actions">
          <Button disabled={!file || !pass || phase === "opening"}>
            {phase === "opening" ? "Opening…" : "Open backup"}
          </Button>
          <button type="button" className="small-button" disabled={phase === "opening"} onClick={() => onClose(false)}>
            Cancel
          </button>
        </div>
        <p className="backup-fine">
          Lose the passphrase and the backup can’t be opened, by you or by us.
        </p>
      </form>
    </Modal>
  );
}
