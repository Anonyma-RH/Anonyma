import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import "./recovery-kit.css";

// Encrypted Backup's one gentle reminder in the workspace: 30 days after the
// last backup, once (server/routes/account-backup.js decides when). Making a
// backup from it or "Not now" both mark it seen. An account that never made
// a backup isn't reminded. Styled like Recovery Kit's one-time nudge.
export function BackupReminder({ config, user, demo = false, q = "" }) {
  const live = isReleased(config, "backup");
  const [due, setDue] = useState(false);
  useEffect(() => {
    if (!live || demo || !user) return;
    let on = true;
    api("/api/account/backup")
      .then((s) => on && setDue(!!s.reminder))
      .catch(() => {});
    return () => {
      on = false;
    };
  }, [live, demo, user?.id]);
  if (!live || demo || !user || !due) return null;
  const seen = () => {
    setDue(false);
    api("/api/account/backup/reminder", { method: "POST", body: {} }).catch(() => {});
  };
  return <BackupNudge q={q} onMake={seen} onDismiss={seen} />;
}
export function BackupNudge({ q = "", onMake, onDismiss }) {
  return (
    <div className="recovery-nudge backup-nudge" role="status">
      <span className="recovery-nudge-mark" aria-hidden="true">
        <Icon name="backup" size={15} />
      </span>
      <p>
        <b>It’s been a month since your last backup.</b>{" "}
        <span>Make a fresh one so it has your newest chats.</span>
      </p>
      <div className="recovery-nudge-actions">
        <Link to={"/account/settings" + q + "#backup"} onClick={onMake}>
          Make a backup
        </Link>
        <button type="button" className="recovery-nudge-dismiss" onClick={onDismiss}>
          <Icon name="close" size={14} />
          <span>Not now</span>
        </button>
      </div>
    </div>
  );
}
