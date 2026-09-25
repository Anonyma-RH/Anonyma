import {
  uid,
  now,
  fail,
  usdUnits,
  reserve,
  release,
  markupFactor,
} from "../core.js";
import { createVideo, PROVIDER_REFUSALS } from "../provider.js";
import { videoOptions } from "../video-options.js";
import { requestIdentifier } from "../middleware.js";

// Submit a video job: hold funds, persist the row and kick off the provider
// job. Completion is handled by the background worker. Shared by the
// workspace video studio and the /v1/videos API route; `key` applies the
// caller's API-key spending cap and `api` marks the eventual media as
// API-delivered so it gets a time-limited signed URL instead of a permanent
// library entry.
export async function submitVideoJob(ctx, req, { key, api = false } = {}) {
  const { db, cfg } = ctx;
  const { getModel } = ctx.models;
  if (!api) await ctx.library.validateReplay(req, "video");
  const m = getModel(req.body.model, "video"),
    prompt = String(req.body.prompt || "");
  if (!prompt.trim() || prompt.length > 2000)
    fail(400, "Video prompt must contain 1–2,000 characters.");
  const { ratio, duration, quality, price } = videoOptions(m, req.body);
  const request = {
    model: m.id,
    prompt,
    aspect_ratio: ratio,
    duration,
    quality,
    ...(req.body.image_url ? { image_url: req.body.image_url } : {}),
  };
  const id = uid("video_"),
    hold = req.user.id + ":" + requestIdentifier(req);
  reserve(db, {
    id: hold,
    user: req.user.id,
    amount: Math.ceil(usdUnits(price) * markupFactor(req.user, cfg)),
    key,
    kind: "video",
    ttl: 1200000,
  });
  db.prepare(
    "INSERT INTO videos(id,user_id,hold_id,provider_id,status,request,error,media_id,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)",
  ).run(
    id,
    req.user.id,
    hold,
    null,
    "submitting",
    JSON.stringify({
      ...request,
      quoted_provider_cost: price,
      ...(api ? { api: true } : {}),
      ...(!api && req.body.libraryMediaId ? { library_source: req.body.libraryMediaId } : {}),
    }),
    null,
    null,
    now(),
    now(),
  );
  try {
    const job = await createVideo(cfg, request);
    if (!job.id) throw Error("Provider did not return a video job ID.");
    db.prepare(
      "UPDATE videos SET provider_id=?,status='pending',updated=? WHERE id=?",
    ).run(job.id, now(), id);
    return { id, status: "pending" };
  } catch (e) {
    if (PROVIDER_REFUSALS.has(e.code)) {
      release(db, hold);
      db.prepare(
        "UPDATE videos SET status='failed',error=?,updated=? WHERE id=?",
      ).run(e.message, now(), id);
    } else
      db.prepare(
        "UPDATE videos SET status='reconciliation',error=?,updated=? WHERE id=?",
      ).run(
        "Submission outcome unknown. Operator reconciliation required; request will not be submitted twice.",
        now(),
        id,
      );
    throw e;
  }
}
// Video submission; completion is handled by the background worker.
export function videoRoutes(ctx) {
  const { app, db, limit, requireUser } = ctx;
  app.post(
    "/api/videos",
    requireUser,
    limit("videos", 10, 60000),
    async (req, res) => {
      const body = await submitVideoJob(ctx, req);
      res.status(202).json(body);
    },
  );
  app.get("/api/videos", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT id,status,error,media_id,created,request FROM videos WHERE user_id=? ORDER BY created DESC LIMIT 60",
        )
        .all(req.user.id)
        .map((v) => ({ ...v, request: JSON.parse(v.request) })),
    }),
  );
}
