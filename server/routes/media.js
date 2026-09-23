import { resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import {
  now,
  fail,
  credits,
  usdUnits,
  reserve,
  settle,
  release,
  quote,
  markupFactor,
} from "../core.js";
import { generateImages } from "../provider.js";
import { requestIdentifier } from "../middleware.js";

// The private media library and image generation.
export function mediaRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight } = ctx;
  const { mediaJSON, signMedia, saveMedia, deleteMedia, assignCosts } =
    ctx.media;
  const { getModel, validateMessages } = ctx.models;
  app.get("/api/media", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT * FROM media WHERE user_id=? AND expires IS NULL ORDER BY created DESC",
        )
        .all(req.user.id)
        .map(mediaJSON),
    }),
  );
  app.get("/api/media/:id", (req, res) => {
    const m = db.prepare("SELECT * FROM media WHERE id=?").get(req.params.id);
    if (!m || (m.expires && m.expires < now())) fail(404, "Media not found.");
    const exp = Number(req.query.expires);
    const supplied = String(req.query.sig || "");
    const expected = signMedia(m.id, exp);
    const signed =
      m.expires &&
      exp === m.expires &&
      exp > now() &&
      /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (req.user?.id !== m.user_id && !signed) fail(404, "Media not found.");
    res.set("Content-Type", m.mime);
    if (req.query.download) res.attachment(m.filename);
    res.sendFile(resolve(cfg.mediaPath, m.filename));
  });
  app.delete("/api/media/:id", requireUser, (req, res) => {
    const m = db
      .prepare("SELECT * FROM media WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!m) fail(404, "Media not found.");
    deleteMedia(m);
    res.json({ ok: true });
  });
  app.post(
    "/api/images",
    requireUser,
    limit("images", 10, 60000),
    async (req, res) => {
      const m = getModel(req.body.model, "image"),
        prompt = String(req.body.prompt || "");
      if (!prompt.trim() || prompt.length > 48000)
        fail(400, "Enter a prompt up to 48,000 characters.");
      const n = req.body.n ?? 1;
      if (!Number.isInteger(n) || n < 1 || n > 4)
        fail(400, "Choose 1–4 images.");
      const refs = req.body.images || [];
      if (!Array.isArray(refs)) fail(400, "Reference images must be an array.");
      validateMessages(
        [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...refs.map((url) => ({ type: "image_url", image_url: { url } })),
            ],
          },
        ],
        m,
      );
      const hold = req.user.id + ":" + requestIdentifier(req),
        factor = markupFactor(req.user, cfg),
        amount = Math.ceil(
          quote(m, [{ role: "user", content: prompt }], 4096, {
            ...req.body,
            n,
          }) * factor,
        );
      reserve(db, {
        id: hold,
        user: req.user.id,
        amount,
        kind: "image",
        ttl: 240000,
      });
      const data = [];
      let deliveredCost = 0;
      const controller = new AbortController();
      inflight.controllers.add(controller);
      inflight.holds.add(hold);
      const deadline = setTimeout(() => controller.abort(), 240000);
      res.on("close", () => {
        if (!res.writableEnded)
          controller.abort(new Error("Client disconnected"));
      });
      const finish = (warning) => {
        const receipt = settle(
          db,
          hold,
          usdUnits(deliveredCost * factor),
          m.name,
        );
        assignCosts(
          data.map((item) => item.id),
          receipt.charged,
          req.user.id,
        ).forEach((cost, index) => (data[index].cost = credits(cost)));
        return {
          data,
          receipt,
          testMode: cfg.testMode,
          ...(warning ? { partial: true, warning } : {}),
        };
      };
      try {
        await generateImages(
          cfg,
          m,
          prompt,
          n,
          { ...req.body, images: refs },
          controller.signal,
          async (batch) => {
            for (const img of batch.data) {
              const saved = await saveMedia(
                req.user.id,
                "image",
                img.b64_json
                  ? "data:image/png;base64," + img.b64_json
                  : img.url,
                { prompt, model: m.id, signal: controller.signal },
              );
              data.push(saved);
              deliveredCost += batch.cost / batch.data.length;
              db.prepare(
                "UPDATE holds SET result=? WHERE id=? AND status='held'",
              ).run(
                JSON.stringify({
                  delivered: Math.min(amount, usdUnits(deliveredCost * factor)),
                  mediaIds: data.map((item) => item.id),
                  description: m.name,
                }),
                hold,
              );
            }
          },
        );
        if (!data.length) {
          fail(502, "Provider returned no image. No credits were charged.");
        }
        res.json(finish());
      } catch (e) {
        if (data.length) {
          return res.json(
            finish(
              `${data.length} image${data.length === 1 ? " was" : "s were"} saved before the batch stopped. Only saved images were charged. ${e.status ? e.message : "The remaining images could not be completed."}`,
            ),
          );
        }
        release(db, hold);
        throw e;
      } finally {
        clearTimeout(deadline);
        inflight.controllers.delete(controller);
        inflight.holds.delete(hold);
      }
    },
  );
}
