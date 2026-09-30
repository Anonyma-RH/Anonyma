import React, { Suspense, lazy, useEffect, useState } from "react";
import { Icon, Button, Notice } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import "./account-backup.css";

// Encrypted Backup (update "backup"): Account → Settings, beside "Your
// data". The section shows the day of the last backup and opens the make
// and restore dialogs (src/BackupDialog.jsx, loaded only when opened: the
// crypto, the worker and the restore code aren't in the page until then).
// Renders nothing until the update is released.
const BackupDialog = lazy(() => import("./BackupDialog.jsx"));

export const backupReleased = (config) => isReleased(config, "backup");
// "2026-09-29" as this browser writes a date (the i18n switch reads en-US).
export function dayLabel(day) {
  const [y, m, d] = String(day || "").split("-").map(Number);
  return y && m && d ? new Date(y, m - 1, d).toLocaleDateString() : "";
}

export function BackupSettings({ config, user }) {
  const live = backupReleased(config) && !!user;
  const [status, setStatus] = useState(null),
    [dialog, setDialog] = useState(null),
    [error, setError] = useState("");
  const load = () =>
    api("/api/account/backup")
      .then((s) => {
        setStatus(s);
        setError("");
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    if (live) load();
  }, [live, user?.id]);
  if (!live) return null;
  return (
    <section id="backup" className="backup-settings">
      <div>
        <h2>Encrypted backup.</h2>
        <p>
          Take everything with you in one file, locked with a passphrase only
          you know. Restore it into any ANONYMA account.
        </p>
      </div>
      <div className="backup-panel">
        <p className="backup-last">
          <Icon name="backup" size={16} />
          <span>
            {!status
              ? "Checking your last backup…"
              : status.last_backup
                ? `Last backup: ${dayLabel(status.last_backup)}`
                : "No backup made yet."}
          </span>
        </p>
        <div className="backup-actions">
          <Button type="button" onClick={() => setDialog("make")} disabled={!status}>
            Make a backup
          </Button>
          <button type="button" className="small-button" onClick={() => setDialog("restore")} disabled={!status}>
            Restore a backup
          </button>
        </div>
        <p className="backup-fine">
          Lose the passphrase and the backup can’t be opened, by you or by us.
        </p>
        {error && <Notice type="error">{error}</Notice>}
      </div>
      {dialog && (
        <Suspense fallback={null}>
          <BackupDialog
            kind={dialog}
            config={config}
            user={user}
            status={status}
            onClose={(changed) => {
              setDialog(null);
              if (changed) load();
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
