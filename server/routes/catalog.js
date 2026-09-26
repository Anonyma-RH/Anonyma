import { chatLimits } from "../../data/chat-limits.js";
import { openapiForConfig } from "../openapi.js";
import { supportConfigured } from "../support.js";
import { createRatesFeed } from "../rates.js";
import { createMarketFeed } from "../market.js";
import { configurationStatus } from "../readiness.js";
import { videoOptions } from "../video-options.js";
import {
  walletPaymentInfo,
  walletPaymentsEnabled,
} from "../wallet-payments.js";
import { modelReleased, releaseInfo, isReleased } from "../releases.js";
import { isPrivateModel } from "../private-mode.js";
import { withMemory } from "../../src/memory.js";
import { trainingFields, liveIds } from "../training.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import {
  fail,
  balance,
  credits,
  usdUnits,
  callable,
  imageCallable,
  vision,
  quote,
  chatPrice,
  generationPrice,
  markupFactor,
  standardFactor,
  wantsWebSearch,
} from "../core.js";

// Public service information, the model catalog, prices and quotes.
export function catalogRoutes(ctx) {
  const { app, db, cfg, models, requireUser, limit } = ctx;
  const { getModel, validateMessages, maxTokens } = models;
  const marketFeed = createMarketFeed();
  app.get("/api/market", async (req, res) => {
    try {
      res.set("Cache-Control", "public, max-age=15").json(await marketFeed());
    } catch {
      fail(503, "Market data temporarily unavailable.", "market_unavailable");
    }
  });
  app.get("/api/openapi.json", (req, res) => res.json(openapiForConfig(cfg)));
  app.get("/api/config", (req, res) =>
    res.json({
      name: "Anonyma",
      testMode: cfg.testMode,
      // Public origin for client-side snippets (e.g. connecting an MCP tool).
      origin: cfg.publicUrl || cfg.origin,
      services: {
        generation: cfg.testMode || !!cfg.gatewayKey,
        payments: configurationStatus(cfg).configured.payments && !cfg.testMode,
        email: configurationStatus(cfg).configured.email || cfg.testMode,
        support: supportConfigured(cfg),
        walletConnect: !!cfg.walletProject,
        token: !!cfg.rpc && !!cfg.token,
        walletPayments: walletPaymentsEnabled(cfg),
      },
      walletPayments: walletPaymentInfo(cfg),
      walletProject: cfg.walletProject,
      walletChain: cfg.walletChain,
      chain: cfg.chain,
      token: cfg.token,
      markup: cfg.markup,
      billing: {
        creditsPerUsd: 1000,
        creditPrecision: 4,
        platformMarkupPercent: cfg.markup,
        gatewayFeePercent: cfg.gatewayFeePercent,
        backupGatewayFeePercent: cfg.gateway2Key ? cfg.gateway2FeePercent : null,
        reservationMultiplier: cfg.holdMargin,
        webSearchUsd: cfg.webSearchPrice,
        timeoutCharge: "base_estimate",
        unreadableResponseCharge: "base_estimate",
      },
      supportEmail: cfg.supportEmail,
      telegram: cfg.telegram,
      catalogUpdatedAt: models.snapshot.updatedAt,
      readiness: configurationStatus(cfg),
      releases: releaseInfo(cfg),
    }),
  );
  app.get("/api/models", async (req, res) => {
    const current = await models.current();
    const privateFlagged = isReleased(cfg, "private");
    // Training Labels: models whose provider trains on prompts, and the
    // listed version that doesn't (see server/training.js).
    const trainingFlagged = isReleased(cfg, "training");
    const listed = current.data.filter((m) => modelReleased(m, cfg));
    const offered = trainingFlagged ? liveIds(listed) : null;
    res.json({
      ...current,
      availabilityScope: "web-workspace",
      developerApiReleased: isReleased(cfg, "api"),
      data: listed.map((m) => ({
        ...m,
        callable: callable(m, cfg),
        apiCallable: isReleased(cfg, "api") && m.type === "chat" && callable(m, cfg),
        imageCapable: imageCallable(m),
        imagePrice: generationPrice(m),
        vision: vision(m),
        ...(m.type === "chat" && isReleased(cfg, "longanswers") ? { chatLimits: chatLimits(m) } : {}),
        ...(privateFlagged && isPrivateModel(m, cfg) ? { private: true } : {}),
        ...(trainingFlagged ? trainingFields(m, offered) : {}),
      })),
    });
  });
  const ratesFeed = createRatesFeed();
  app.get("/api/rates", async (req, res) => {
    try {
      res.json(await ratesFeed());
    } catch {
      fail(
        503,
        "Live exchange rates are unavailable. USD prices remain available.",
        "rates_unavailable",
      );
    }
  });
  // Quoting reads prices only: nothing is reserved, charged or stored. The
  // workspace asks automatically while a prompt is typed (Credit Estimates),
  // debounced, so the limit leaves room for that and for Symposium's columns.
  app.post("/api/quote", requireUser, limit("quote", 120, 60000), (req, res) => {
    const m = getModel(req.body.model);
    const teamPaid = req.body.treasury === true;
    if (teamPaid && m.type !== "chat") fail(400, "Team pays supports chat requests only.");
    const team = teamPaid ? ctx.treasury.forQuote(req.user.id, req.body.conversationId) : null;
    const video = m.type === "video" ? videoOptions(m, req.body) : null;
    const messages = validateMessages(
      ctx.files.expandMessages(req, req.body.messages || [{ role: "user", content: req.body.prompt || " " }]),
      m,
    );
    const max = maxTokens(req.body.max_tokens, m);
    // A chat model is priced exactly as /api/chat prices the request (see
    // routes/chat.js), which then holds up to HOLD_MARGIN times this amount
    // while it runs; other models keep their per-option prices. That includes
    // the same saved memory /api/chat would add (routes/memory.js), which also
    // counts against the context allowance.
    const memory = m.type === "chat" ? ctx.memory.forRequest(req.user.id, req.body) : null;
    const sent = m.type === "chat" ? withMemory(messages, memory?.message) : messages;
    const budget = models.validateContext(sent, m, max);
    const factor = teamPaid ? standardFactor(cfg) : markupFactor(req.user, cfg);
    const searchFee = wantsWebSearch(req.body) ? cfg.webSearchPrice : 0;
    const amount =
      m.type === "chat"
        ? chatPrice(m, sent, max, searchFee, factor)
        : Math.ceil(
            (video
              ? usdUnits(video.price)
              : quote(m, messages, max, req.body) + usdUnits(searchFee)) * factor,
          );
    // Spending Limits: the room left under the account's own limits, which
    // a personal request can't go over (team-paid requests don't count).
    const room =
      !team && limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(amount),
      usd: amount / 1e7,
      available: credits(team ? team.available : balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      model: m.id,
      estimate: true,
      ...(budget ? { budget } : {}),
      ...(memory && req.body.memory != null
        ? { memory: { used: memory.facts.length, skipped: memory.skipped } }
        : {}),
    });
  });
}
