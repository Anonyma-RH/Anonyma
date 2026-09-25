import { existsSync } from "node:fs";
import { config, database } from "../server/core.js";
import { createBackup, verifyBackup, restoreBackup } from "../server/backup.js";
const [command, source, destination] = process.argv.slice(2);
if (
  !source ||
  !["create", "verify", "restore"].includes(command) ||
  (command === "restore" && !destination)
)
  throw Error(
    "Usage: backup.mjs create NEW_DIRECTORY | verify BACKUP_DIRECTORY | restore BACKUP_DIRECTORY NEW_DIRECTORY",
  );
if (command === "verify") console.log(JSON.stringify(verifyBackup(source)));
else if (command === "restore")
  console.log(JSON.stringify(restoreBackup(source, destination)));
else {
  const cfg = config();
  if (!existsSync(cfg.dbPath))
    throw Error("Database does not exist; refusing an empty backup.");
  if (!process.argv.includes("--writes-paused"))
    throw Error(
      "Stop service writes and workers, then confirm with --writes-paused.",
    );
  const db = database(cfg.dbPath);
  try {
    console.log(JSON.stringify(createBackup(db, cfg, source)));
  } finally {
    db.close();
  }
}
