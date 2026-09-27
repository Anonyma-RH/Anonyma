import { callable } from "../core.js";
import { modelReleased } from "../releases.js";
import { CACHE_MS } from "../model-status.js";

// Model Status: the public, aggregated status of each model family and the
// models with enough traffic to show (server/model-status.js). No sign-in,
// the same answer for everyone, recomputed at most every 30 seconds. Gated
// by featuresFor ("status").
export function statusRoutes(ctx) {
  const { app, cfg, models, modelStatus } = ctx;
  let cached = null;
  app.get("/api/status", async (req, res) => {
    const t = modelStatus.now();
    if (!cached || t - cached.at >= CACHE_MS || t < cached.at) {
      const current = await models.current();
      // What anyone can pick: released, callable catalog models. Sealed
      // Mode's enclave models aren't callable here and aren't measured.
      const listed = current.data.filter(
        (m) => modelReleased(m, cfg) && callable(m, cfg),
      );
      cached = { at: t, body: modelStatus.report(listed, t) };
    }
    res.set("Cache-Control", `public, max-age=${CACHE_MS / 1000}`).json(cached.body);
  });
}
