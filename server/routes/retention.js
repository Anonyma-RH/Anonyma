import { fail } from "../core.js";

// Days an auto-delete choice may hold; null clears it (kept forever). Kept
// in sync with the same list in conversations.js.
const RETENTION_DAYS = [1, 7, 30];
const validDays = (value) => {
  if (value === null || RETENTION_DAYS.includes(value)) return value;
  fail(400, "Retention must be null, 1, 7 or 30 days.", "invalid_request");
};

// Account default auto-delete, applied to conversations created after it is
// set. Existing conversations keep whatever expiry (or none) they already had.
export function retentionRoutes({ app, db, requireUser }) {
  app.get("/api/retention", requireUser, (req, res) =>
    res.json({
      days:
        db
          .prepare("SELECT days FROM retention_defaults WHERE user_id=?")
          .get(req.user.id)?.days ?? null,
    }),
  );
  app.put("/api/retention", requireUser, (req, res) => {
    const days = validDays(req.body.days ?? null);
    if (days === null)
      db.prepare("DELETE FROM retention_defaults WHERE user_id=?").run(
        req.user.id,
      );
    else
      db.prepare(
        "INSERT INTO retention_defaults(user_id,days) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET days=excluded.days",
      ).run(req.user.id, days);
    res.json({ ok: true, days });
  });
}
