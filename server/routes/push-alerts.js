import { fail, now } from "../core.js";
import { subscriptionInput, settingsInput } from "../push-alerts.js";

// Push Alerts (update "pushalerts", which also needs "app": its service
// worker receives the notifications). Every route is gated by featuresFor,
// so each is 403 feature_unreleased until release. The logic is
// server/push-alerts.js.
// - GET /api/push: this account's browsers, switches and the VAPID public
//   key (null, with available false, when this server has no keys).
// - POST /api/push/subscriptions: add this browser (503 push_unavailable
//   without keys).
// - DELETE /api/push/subscriptions/:id: remove one browser.
// - POST /api/push/subscriptions/:id/test: one test notification to it.
// - PATCH /api/push/settings: switch kinds of notification on or off.
export function pushAlertRoutes(ctx) {
  const { app, db, limit, requireUser, push } = ctx;
  const idOf = (req) => {
    const id = String(req.params.id || "");
    if (!/^ps_[0-9a-f]{32}$/.test(id)) fail(404, "That browser isn't on your list.", "push_not_found");
    return id;
  };
  app.get("/api/push", requireUser, (req, res) => res.json(push.view(req.user.id)));
  app.post("/api/push/subscriptions", requireUser, limit("push-subscribe", 30, 3600000), (req, res) => {
    push.assertAvailable();
    const sub = subscriptionInput(req.body);
    const device = push.subscribe(req.user.id, sub);
    res.status(201).json({ device, ...push.view(req.user.id) });
  });
  app.delete("/api/push/subscriptions/:id", requireUser, limit("push-change", 120, 3600000), (req, res) => {
    push.unsubscribe(req.user.id, idOf(req));
    res.json(push.view(req.user.id));
  });
  // Sent at once rather than at the worker's next tick, and answered with
  // what the push service said: accepted, pending (it will be retried),
  // gone (the browser's subscription had ended, so it was removed) or stale
  // (subscribed with an older key; nothing was sent).
  app.post("/api/push/subscriptions/:id/test", requireUser, limit("push-test", 10, 3600000), async (req, res) => {
    push.assertAvailable();
    const id = idOf(req);
    const sub = db.prepare("SELECT key_id FROM push_subscriptions WHERE id=? AND user_id=?").get(id, req.user.id);
    if (!sub) fail(404, "That browser isn't on your list.", "push_not_found");
    const at = now();
    const queued = sub.key_id === push.keyId();
    if (queued) {
      // A test already waiting for this browser is the same one.
      push.notify(req.user.id, "test", { only: id });
      await push.idle();
      await push.deliver();
    }
    const row = db.prepare("SELECT last_success FROM push_subscriptions WHERE id=?").get(id);
    const outcome = !queued ? "stale" : !row ? "gone" : row.last_success >= at ? "accepted" : "pending";
    res.status(202).json({ queued, outcome, ...push.view(req.user.id) });
  });
  app.patch("/api/push/settings", requireUser, limit("push-change", 120, 3600000), (req, res) => {
    push.changeSettings(req.user.id, settingsInput(req.body));
    res.json(push.view(req.user.id));
  });
}
