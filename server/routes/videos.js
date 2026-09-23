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

// Video submission; completion is handled by the background worker.
export function videoRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const { getModel } = ctx.models;
  app.post(
    "/api/videos",
    requireUser,
    limit("videos", 10, 60000),
    async (req, res) => {
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
        JSON.stringify({ ...request, quoted_provider_cost: price }),
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
        res.status(202).json({ id, status: "pending" });
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
