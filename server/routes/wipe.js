import { sessionCookieOptions } from "../auth.js";
import { now, fail, transaction } from "../core.js";
import { eraseAccountContent } from "./account.js";

// A request still running on this account: one reserved on its own balance,
// or a team-paid one it started on a collab's treasury. A sealed request
// waiting only for its charge (server/sealed.js) isn't running and holds no
// content, so it never blocks a wipe.
const IN_FLIGHT = `SELECT 1 FROM holds WHERE status='held' AND (user_id=?
  OR id IN (SELECT hold_id FROM treasury_spends WHERE user_id=?))
  AND id NOT IN (SELECT hold_id FROM sealed_requests WHERE status='reconcile_pending') LIMIT 1`;

function assertIdle(ctx, user) {
  if (ctx.db.prepare(IN_FLIGHT).get(user, user))
    fail(
      409,
      "Wait for your requests in progress to finish, then wipe again.",
      "requests_in_flight",
    );
  // Collabs the account owns go with their shared conversations, exactly
  // as in account closure, so their Team Treasuries must be empty.
  ctx.treasury.assertOwnedEmpty(user, "wiping your account");
}

// The erase itself, shared by Panic Wipe (below) and Inactivity Wipe's
// worker (server/inactivity-wipe.js), so both remove exactly the same
// things: saved media files first (a file can't join a transaction; one
// that can't be removed stops the wipe before anything else changes, and a
// retry skips the files already gone), then one transaction that checks the
// account is idle again, erases its content (eraseAccountContent in
// routes/account.js) and revokes every API key and connected app. The
// account, its balance, the ledger, deposits, request records, receipts and
// settings stay. Synchronous from start to finish, so no request of this
// process runs in between.
// - check(): runs before the files and again inside the transaction; throw
//   to stop (Inactivity Wipe re-checks the deadline there).
// - record(): runs inside the transaction after the erase.
export function wipeAccountContent(ctx, user, { check, record } = {}) {
  const { db } = ctx;
  const { removeMediaFile } = ctx.media;
  check?.();
  // Release paused Meeting Notes runs through the shared wipe path.
  ctx.meetingNotes?.endFor(user.id);
  // Likewise Subtitles' run between steps.
  ctx.subtitles?.endFor(user.id);
  assertIdle(ctx, user.id);
  for (const m of db
    .prepare("SELECT id,filename FROM media WHERE user_id=?")
    .all(user.id))
    removeMediaFile(m);
  // Deleted rows are overwritten in the database file rather than left in
  // its free pages. Backups are separate copies (see the data controls).
  const secure = db.prepare("PRAGMA secure_delete").get().secure_delete;
  db.exec("PRAGMA secure_delete=ON");
  try {
    transaction(db, () => {
      // Checked again with the deletion, atomically.
      check?.();
      assertIdle(ctx, user.id);
      eraseAccountContent(db, user);
      // Revoked, not deleted: the ledger still names the key or app
      // that spent. A connected app's key is revoked with it.
      const at = now();
      db.prepare(
        "UPDATE api_keys SET revoked=COALESCE(revoked,?) WHERE user_id=?",
      ).run(at, user.id);
      db.prepare(
        "UPDATE oauth_connections SET revoked=COALESCE(revoked,?) WHERE user_id=?",
      ).run(at, user.id);
      record?.();
    });
  } finally {
    db.exec(`PRAGMA secure_delete=${Number(secure) || 0}`);
  }
}

// Panic Wipe: one confirmed request erases everything the account has stored
// except what the ledger and the data controls keep. It removes the same
// content as account closure (eraseAccountContent in routes/account.js),
// revokes every API key and connected app, and signs out every session,
// this one included. The account, its balance, the ledger, deposits, request
// records, receipts and settings (spending limits, auto-delete, the memory
// switch, two-step sign-in, passkeys, the Recovery Kit, Inactivity Wipe)
// stay. Everything is a
// DELETE or a first-time-only UPDATE, so a retry (or a second wipe after
// signing in again) is safe and changes nothing that is already gone.
export function wipeRoutes(ctx) {
  const { app, cfg, limit, requireUser } = ctx;
  app.post(
    "/api/account/wipe",
    requireUser,
    limit("account_wipe", 10, 3600000),
    (req, res) => {
      if (req.body?.confirm !== "WIPE")
        fail(400, "Type WIPE to confirm the wipe.", "confirmation_required");
      wipeAccountContent(ctx, req.user);
      res
        .clearCookie("anonyma_session", sessionCookieOptions(cfg))
        .json({ ok: true });
    },
  );
}
