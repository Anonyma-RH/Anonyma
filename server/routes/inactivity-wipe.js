import {
  inactivityView,
  changeInactivity,
  dismissNotice,
} from "../inactivity-wipe.js";

// Inactivity Wipe: read and change the account's setting, and dismiss the
// workspace notice (server/inactivity-wipe.js). The release gate in
// releases.js refuses every route while the update (or Panic Wipe, whose
// erase it uses) is unreleased. Each request is a signed-in session request,
// so the activity clock has already been brought up to date when it runs.
export function inactivityWipeRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  app.get("/api/inactivity-wipe", requireUser, (req, res) =>
    res.json(inactivityView(db, cfg, req.user)),
  );
  app.put(
    "/api/inactivity-wipe",
    requireUser,
    limit("inactivity_wipe", 60, 3600000),
    (req, res) => {
      changeInactivity(db, req.user.id, req.body || {});
      res.json(inactivityView(db, cfg, req.user));
    },
  );
  app.delete(
    "/api/inactivity-wipe/notice",
    requireUser,
    limit("inactivity_wipe", 60, 3600000),
    (req, res) => {
      dismissNotice(db, req.user.id);
      res.json(inactivityView(db, cfg, req.user));
    },
  );
}
