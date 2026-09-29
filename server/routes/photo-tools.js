import { fail, credits, usdUnits, balance, reserve, settle, release, markupFactor } from "../core.js";
import { generateImages } from "../provider.js";
import { requestIdentifier } from "../middleware.js";
import { isPrivateModel, ZDR_ROUTING } from "../private-mode.js";
import { isReleased } from "../releases.js";
import { privacyTrail, trailLive, veilMaskedFrom } from "../privacy-trail.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { viewerOf } from "../early-models.js";
import { AUTO_NOT_OFFERED } from "../auto-model.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import {
  EXTEND_UNAVAILABLE,
  IMAGE_LIMIT,
  INLINE_LIMIT,
  PROMPT_MAX,
  TOOLS,
  checkOutput,
  holdUnits,
  holdUsd,
  offerOf,
  photoIssue,
  photoModels,
  resultLabel,
  sniff,
  testOutput,
  unusable,
} from "../photo-tools.js";
import { tagUsage } from "../usage-insights.js";

// Photo Tools (update "phototools"): edit a photo with words, remove its
// background or upscale it. See server/photo-tools.js for which models, and
// src/PhotoTools.jsx for the page.
//
// Money: a run holds one price, the highest the catalog publishes for that
// model at the account's rate, and that is exactly what /api/photo-tools/quote
// returns and what the page shows as "up to". A run is refused with 409
// estimate_changed if its own price differs from the one the page showed.
// The hold is settled only for a result that was checked and kept; a
// provider failure, a timeout, a result that can't be used (not a picture,
// or, for a cut-out, one that can't be transparent) or one that can't be
// saved is released and charges nothing. What's charged is the provider's own
// reported cost, never more than the hold.
//
// Privacy: the photo goes to the model as sent by the browser (metadata is
// removed there, and any redaction is done there). Nothing about the photo,
// the words or the result is logged. A result is saved to the library like
// an Image Studio one, without the request's settings (so there is nothing
// to rerun and no photo kept as a "recipe"); off the record (or Private
// Mode) the result is sent back to the page only and kept nowhere.
export const PHOTO_CHANGED = "The price changed since it was shown. Check the new one, then try again. Nothing was charged.";
export const PHOTO_FAILED = "The photo couldn't be processed, so nothing was charged. Try again, or choose another model.";
const HOLD_TTL = 300000;
const IMAGE_URL = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/]+={0,2})$/;
// The longest data URL a 1.5 MiB photo can make, with a little to spare.
const IMAGE_URL_MAX = Math.ceil((IMAGE_LIMIT * 4) / 3) + 200;

export function photoToolsRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight } = ctx;
  const { saveMedia, loadMedia, assignCosts } = ctx.media;

  const offersFor = async (req) =>
    photoModels(await ctx.models.current(), cfg, { hides: ctx.earlyModels.view(viewerOf(req)).hides });

  // What a quote and a run share: the tool, the model, the modes and the
  // price.
  async function prepare(req) {
    const body = req.body || {};
    // Auto Model is for chat composers: a photo tool is always one chosen model.
    if (body.auto !== undefined) fail(400, AUTO_NOT_OFFERED, "auto_not_offered");
    if (body.tool === "extend") fail(400, EXTEND_UNAVAILABLE, "tool_unavailable");
    if (!TOOLS.includes(body.tool)) fail(400, "Choose a photo tool: edit, background or upscale.", "invalid_tool");
    const current = await ctx.models.current();
    const m = current.data.find((x) => x.id === body.model);
    if (!m) fail(404, "Unknown model.", "model_not_found");
    if (photoIssue(m, body.tool, cfg)) fail(400, "This model can't do that with a photo right now.", "unsupported_model");
    // Early Model Access applies here as it does to a chat.
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
    const isPrivate = body.private === true;
    if (body.ephemeral !== undefined && typeof body.ephemeral !== "boolean") fail(400, "ephemeral must be true or false.", "invalid_request");
    if (isPrivate && !isPrivateModel(m, cfg))
      fail(400, "Private mode needs a model with zero data retention. No photo model offers it right now.", "private_model_required");
    // Private Mode never keeps anything, so its result stays off the record.
    const ephemeral = isPrivate || body.ephemeral === true;
    const factor = markupFactor(req.user, cfg);
    return { body, tool: body.tool, m, isPrivate, ephemeral, factor, amount: holdUnits(m, factor) };
  }

  // The tools, their models with prices, and what isn't offered.
  app.get("/api/photo-tools", requireUser, limit("photo_tools", 60, 60000), async (req, res) => {
    const offers = await offersFor(req);
    const factor = markupFactor(req.user, cfg);
    const models = (tool) => offers[tool].map((m) => offerOf(m, factor, cfg));
    const tools = TOOLS.map((id) => {
      const list = models(id);
      return { id, default: list[0]?.id ?? null, models: list };
    });
    res.json({
      tools,
      unavailable: offers.unavailable,
      private_available: tools.some((t) => t.models.some((m) => m.private)),
      limits: { image_bytes: IMAGE_LIMIT, prompt_characters: PROMPT_MAX },
      available: credits(balance(db, req.user.id).available),
      testMode: cfg.testMode,
    });
  });

  // Quoting reserves, sends and stores nothing.
  app.post("/api/photo-tools/quote", requireUser, limit("photo_quote", 120, 60000), async (req, res) => {
    const { m, tool, amount } = await prepare(req);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(amount),
      // The hold in ledger units: what a run must send back as max_units.
      units: amount,
      usd: amount / 1e7,
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      tool,
      model: m.id,
      estimate: true,
    });
  });

  // One run per account at a time: a run holds its whole price.
  const running = new Map();

  app.post("/api/photo-tools/run", requireUser, limit("photo_run", 10, 60000), async (req, res) => {
    const { body, tool, m, isPrivate, ephemeral, factor, amount } = await prepare(req);
    // What was asked, checked before anything is held.
    const prompt = tool === "edit" ? String(body.prompt ?? "").trim() : "";
    if (tool === "edit" && (!prompt || prompt.length > PROMPT_MAX))
      fail(400, `Say what to change, in up to ${PROMPT_MAX.toLocaleString("en-US")} characters.`, "invalid_prompt");
    // Seed Guard, with the chat's own "Send anyway" (allow_seed_phrase, gated
    // in featuresFor): a recovery phrase in the words is refused unheld.
    if (isReleased(cfg, "seedguard") && body.allow_seed_phrase !== true && findSeedPhrase(prompt))
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    const veilMasked = veilMaskedFrom(body);
    const photo = typeof body.image === "string" && body.image.length <= IMAGE_URL_MAX ? IMAGE_URL.exec(body.image) : null;
    if (!photo) {
      if (typeof body.image === "string" && body.image.length > IMAGE_URL_MAX)
        fail(400, "The photo is larger than 1.5 MiB. Shrink it and try again.", "image_too_large");
      fail(400, "Send the photo as a PNG, JPEG, WebP or GIF data URL.", "invalid_image");
    }
    const bytes = Buffer.from(photo[2], "base64");
    // What the file is, not what its label says.
    if (sniff(bytes) !== photo[1]) fail(400, "That file isn't the kind of picture it says it is.", "invalid_image");
    if (bytes.length > IMAGE_LIMIT) fail(400, "The photo is larger than 1.5 MiB. Shrink it and try again.", "image_too_large");
    if (!Number.isSafeInteger(body.max_units) || body.max_units !== amount) fail(409, PHOTO_CHANGED, "estimate_changed");
    // The library item a result may sit beside, kept from the library's
    // cap while this result is saved. Optional, and only your own.
    let source = null;
    if (body.source !== undefined && body.source !== null) {
      if (typeof body.source !== "string") fail(400, "source must be text.", "invalid_request");
      source = db
        .prepare("SELECT id FROM media WHERE id=? AND user_id=? AND kind='image' AND expires IS NULL")
        .get(body.source, req.user.id)?.id;
      if (!source) fail(404, "Media not found.");
    }
    const user = req.user.id;
    if (running.has(user)) fail(409, "A photo is already being processed. Wait for it to finish.", "photo_running");

    const hold = `${user}:${requestIdentifier(req)}`;
    // Saved results are ordinary images in Usage Insights; off the record
    // is filed like an off-the-record chat, by model only.
    reserve(db, { id: hold, user, amount, kind: ephemeral ? "chat" : "image", ttl: HOLD_TTL });
    if (ephemeral) tagUsage(db, cfg, hold, { feature: "chat", model: m.id });
    const controller = new AbortController();
    running.set(user, controller);
    inflight.controllers.add(controller);
    inflight.holds.add(hold);
    const deadline = setTimeout(() => controller.abort(new Error("Provider timeout")), cfg.requestTimeoutMs || 240000);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
    });
    let settled = false;
    try {
      let batch = null;
      // Model Status: the call's outcome and how long it took.
      await ctx.modelStatus.timed(
        m.id,
        () =>
          generateImages(
            cfg,
            m,
            prompt,
            1,
            { images: [body.image], testImage: cfg.testMode ? testOutput(tool) : undefined, extraBody: isPrivate ? ZDR_ROUTING : undefined },
            controller.signal,
            async (b) => {
              batch = b;
            },
          ),
        { signal: controller.signal, timed: true },
      );
      const item = batch?.data?.[0];
      if (!item) throw unusable("The provider returned no picture, so nothing was charged.", "empty_output");
      // The picture, from the reply or the provider's own download, then
      // checked: only a usable result is kept or charged.
      const got = await loadMedia(item.b64_json ? "data:image/png;base64," + item.b64_json : item.url, { signal: controller.signal });
      const mime = checkOutput(tool, got.bytes);
      if (ephemeral && got.bytes.length > INLINE_LIMIT)
        throw unusable("The result is too large to hand back without saving it, so nothing was charged. Save it to your library instead.", "photo_too_large");
      const saved = ephemeral
        ? null
        : await saveMedia(user, "image", got.bytes, {
            mime,
            prompt: resultLabel(tool, prompt),
            model: m.id,
            signal: controller.signal,
            protectMedia: source,
          });
      // What's charged is the provider's reported cost at the account's
      // rate, never more than the hold (settle keeps it under).
      const dollars = Number.isFinite(batch.cost) && batch.cost >= 0 ? batch.cost : holdUsd(m);
      const receipt = settle(db, hold, usdUnits(dollars * factor), m.name, { model: m.id });
      settled = true;
      if (saved) {
        assignCosts([saved.id], receipt.charged, user);
        saved.cost = credits(receipt.charged);
      }
      const privacy = trailLive(cfg)
        ? privacyTrail(cfg, {
            model: m,
            route: "primary",
            zeroDataRetention: isPrivate,
            storage: isPrivate ? "private" : ephemeral ? "off_the_record" : "saved",
            veilMasked,
            receiptId: null,
          })
        : null;
      res.json({
        tool,
        model: m.id,
        saved: !!saved,
        media: saved,
        image: ephemeral ? `data:${mime};base64,${got.bytes.toString("base64")}` : null,
        mime,
        receipt,
        testMode: cfg.testMode,
        ...(privacy ? { privacy } : {}),
      });
    } catch (e) {
      if (!settled) release(db, hold);
      if (controller.signal.aborted && !res.destroyed) {
        if (controller.signal.reason?.message === "Provider timeout")
          fail(504, "The model took too long, so nothing was charged. Try again, or choose another model.", "provider_timeout");
      }
      // Whatever went wrong before a result was kept charged nothing; say so.
      if (e?.status && !/charged/i.test(e.message)) e.message += " Nothing was charged.";
      throw e;
    } finally {
      clearTimeout(deadline);
      inflight.controllers.delete(controller);
      inflight.holds.delete(hold);
      running.delete(user);
    }
  });
}
