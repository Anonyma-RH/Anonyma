import { fail } from "../core.js";
import { alertView, changeAlert, thresholdUnits } from "../balance-alerts.js";

// Low-Balance Alerts: read and change the account's alert level and its
// browser-notification choice (server/balance-alerts.js). The release gate
// in releases.js refuses both routes while the update is unreleased.
export function balanceAlertRoutes(ctx) {
  const { app, db, limit, requireUser } = ctx;
  app.get("/api/balance-alert", requireUser, (req, res) =>
    res.json(alertView(db, req.user.id)),
  );
  // Fields left out keep their value; threshold null turns the alert off.
  app.patch(
    "/api/balance-alert",
    requireUser,
    limit("balance-alert", 60, 3600000),
    (req, res) => {
      const body =
        req.body && typeof req.body === "object" && !Array.isArray(req.body)
          ? req.body
          : {};
      const change = {};
      if (Object.hasOwn(body, "threshold"))
        change.threshold = thresholdUnits(body.threshold);
      if (Object.hasOwn(body, "notify")) {
        if (typeof body.notify !== "boolean")
          fail(400, "Send notify as true or false.", "invalid_notify");
        change.notify = body.notify;
      }
      if (!Object.keys(change).length)
        fail(400, "Send threshold, notify or both.", "invalid_alert");
      changeAlert(db, req.user.id, change);
      res.json(alertView(db, req.user.id));
    },
  );
}
