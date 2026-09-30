import { now } from "./core.js";

// Secret Guard's per-account switch (update "secretguard"). The guard itself
// runs in the browser (src/secret-guard.js, src/SecretGuard.jsx): it's a
// soft guard, so the server never checks messages for secrets, never sees
// a match and keeps nothing about one. The developer API (/v1) and MCP are
// never checked: those callers are programs, and holding their requests
// would break them.
//
// On by default: only an account that switched it off has a row
// (secret_guard_off), holding when it did.
export function secretGuardEnabled(db, user) {
  return !db.prepare("SELECT 1 FROM secret_guard_off WHERE user_id=?").get(user);
}
export function setSecretGuard(db, user, enabled) {
  if (enabled) db.prepare("DELETE FROM secret_guard_off WHERE user_id=?").run(user);
  else
    db.prepare(
      "INSERT INTO secret_guard_off(user_id,updated) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET updated=excluded.updated",
    ).run(user, now());
  return secretGuardEnabled(db, user);
}
// Account closure, Panic Wipe and Inactivity Wipe (eraseAccountContent in
// routes/account.js): the switch goes, so the guard is back on.
export function forgetSecretGuard(db, user) {
  db.prepare("DELETE FROM secret_guard_off WHERE user_id=?").run(user);
}
// The account export: whether it's on, and since when it's been off.
export function exportSecretGuard(db, user) {
  const row = db.prepare("SELECT updated FROM secret_guard_off WHERE user_id=?").get(user);
  return row ? { enabled: false, switchedOff: row.updated } : { enabled: true };
}
