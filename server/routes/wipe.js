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

// Panic Wipe: one confirmed request erases everything the account has stored
// except what the ledger and the data controls keep. It removes the same
// content as account closure (eraseAccountContent in routes/account.js),
// revokes every API key and connected app, and signs out every session,
// this one included. The account, its balance, the ledger, deposits, request
// records, receipts and settings (spending limits, auto-delete, the memory
// switch) stay. Everything is a DELETE or a first-time-only UPDATE, so a
// retry (or a second wipe after signing in again) is safe and changes
// nothing that is already gone.
export function wipeRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const { removeMediaFile } = ctx.media;
  function assertIdle(user) {
    if (db.prepare(IN_FLIGHT).get(user, user))
      fail(
        409,
        "Wait for your requests in progress to finish, then wipe again.",
        "requests_in_flight",
      );
    // Collabs the account owns go with their shared conversations, exactly
    // as in account closure, so their Team Treasuries must be empty.
    ctx.treasury.assertOwnedEmpty(user, "wiping your account");
  }
  app.post(
    "/api/account/wipe",
    requireUser,
    limit("account_wipe", 10, 3600000),
    (req, res) => {
      if (req.body?.confirm !== "WIPE")
        fail(400, "Type WIPE to confirm the wipe.", "confirmation_required");
      const user = req.user.id;
      assertIdle(user);
      // Files first: a file can't join the transaction. A file that can't be
      // removed stops the wipe before anything else changes, and a retry
      // skips the files already gone.
      for (const m of db
        .prepare("SELECT id,filename FROM media WHERE user_id=?")
        .all(user))
        removeMediaFile(m);
      // Deleted rows are overwritten in the database file rather than left in
      // its free pages. Backups are separate copies (see the data controls).
      const secure = db.prepare("PRAGMA secure_delete").get().secure_delete;
      db.exec("PRAGMA secure_delete=ON");
      try {
        transaction(db, () => {
          // Checked again with the deletion, atomically.
          assertIdle(user);
          eraseAccountContent(db, req.user);
          // Revoked, not deleted: the ledger still names the key or app
          // that spent. A connected app's key is revoked with it.
          const at = now();
          db.prepare(
            "UPDATE api_keys SET revoked=COALESCE(revoked,?) WHERE user_id=?",
          ).run(at, user);
          db.prepare(
            "UPDATE oauth_connections SET revoked=COALESCE(revoked,?) WHERE user_id=?",
          ).run(at, user);
        });
      } finally {
        db.exec(`PRAGMA secure_delete=${Number(secure) || 0}`);
      }
      res
        .clearCookie("anonyma_session", sessionCookieOptions(cfg))
        .json({ ok: true });
    },
  );
}
