import { fail } from "../core.js";
import {
  WINDOWS,
  changeLimits,
  cancelPending,
  enforceSpendingLimits,
  limitUnits,
  limitsView,
} from "../spending-limits.js";

// Spending Limits: the account's own daily and monthly limits (see
// server/spending-limits.js for what counts and how they're enforced). The
// release gate in releases.js refuses these routes while it's unreleased,
// and the reservation check does nothing then.
export function spendingLimitRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  enforceSpendingLimits(db, cfg);
  app.get("/api/spending-limits", requireUser, (req, res) =>
    res.json(limitsView(db, req.user.id)),
  );
  // Fields left out keep their value; null removes that limit (after the
  // wait, like any raise).
  app.patch(
    "/api/spending-limits",
    requireUser,
    limit("spending-limits", 60, 3600000),
    (req, res) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const changes = {};
      for (const name of Object.keys(WINDOWS)) {
        const field = `${name}_limit`;
        if (Object.hasOwn(body, field)) changes[name] = limitUnits(body[field]);
      }
      if (!Object.keys(changes).length)
        fail(400, "Send daily_limit, monthly_limit or both.", "invalid_limit");
      const outcome = changeLimits(db, req.user.id, changes);
      res.json({
        ...limitsView(db, req.user.id),
        changes: Object.fromEntries(
          Object.entries(outcome).map(([name, v]) => [`${name}_limit`, v]),
        ),
      });
    },
  );
  app.delete(
    "/api/spending-limits/pending/:limit",
    requireUser,
    limit("spending-limits", 60, 3600000),
    (req, res) => {
      const name = req.params.limit;
      if (!Object.hasOwn(WINDOWS, name))
        fail(400, "Choose the daily or monthly limit.", "invalid_limit");
      cancelPending(db, req.user.id, name);
      res.json(limitsView(db, req.user.id));
    },
  );
}
