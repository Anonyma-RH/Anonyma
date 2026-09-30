import { fail } from "../core.js";
import { secretGuardEnabled, setSecretGuard } from "../secret-guard.js";

// Secret Guard's switch (update "secretguard"; server/secret-guard.js).
// Gated by featuresFor, so both routes are 403 feature_unreleased until
// release. The guard runs in the browser; these only read and change
// whether it's on for the signed-in account.
export function secretGuardRoutes(ctx) {
  const { app, db, limit, requireUser } = ctx;
  app.get("/api/secret-guard", requireUser, (req, res) =>
    res.json({ enabled: secretGuardEnabled(db, req.user.id) }),
  );
  app.put("/api/secret-guard", requireUser, limit("secret-guard", 60, 3600000), (req, res) => {
    const { enabled } = req.body || {};
    if (typeof enabled !== "boolean") fail(400, "enabled must be true or false.", "invalid_request");
    res.json({ enabled: setSecretGuard(db, req.user.id, enabled) });
  });
}
