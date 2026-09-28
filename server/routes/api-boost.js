import { apiLimitFor } from "../api-boost.js";

// API Boost: the signed-in account's own API and MCP request limits, for
// its API keys page. The update's gate (server/releases.js) refuses this
// route until it's released; the limits themselves are in server/api-boost.js.
export function apiBoostRoutes({ app, cfg, requireUser }) {
  app.get("/api/account/api-limit", requireUser, (req, res) =>
    res.json(apiLimitFor(cfg, req.user)),
  );
}
