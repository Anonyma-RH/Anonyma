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
import {
  fail,
  balance,
  credits,
  usdUnits,
  callable,
  imageCallable,
  vision,
  quote,
  generationPrice,
  markupFactor,
} from "../core.js";

// Public service information, the model catalog, prices and quotes.
export function catalogRoutes({ app, db, cfg, models, requireUser }) {
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
    res.json({
      ...current,
      availabilityScope: "web-workspace",
      developerApiReleased: isReleased(cfg, "api"),
      data: current.data
        .filter((m) => modelReleased(m, cfg))
        .map((m) => ({
        ...m,
        callable: callable(m, cfg),
        apiCallable: isReleased(cfg, "api") && m.type === "chat" && callable(m, cfg),
        imageCapable: imageCallable(m),
        imagePrice: generationPrice(m),
        vision: vision(m),
        ...(privateFlagged && isPrivateModel(m, cfg) ? { private: true } : {}),
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
  app.post("/api/quote", requireUser, (req, res) => {
    const m = getModel(req.body.model);
    const video = m.type === "video" ? videoOptions(m, req.body) : null;
    const messages = validateMessages(
      req.body.messages || [{ role: "user", content: req.body.prompt || " " }],
      m,
    );
    const amount = Math.ceil(
      (video
        ? usdUnits(video.price)
        : quote(m, messages, maxTokens(req.body.max_tokens), req.body) +
          (req.body.web_search === true ? usdUnits(cfg.webSearchPrice) : 0)) *
        markupFactor(req.user, cfg),
    );
    res.json({
      credits: credits(amount),
      usd: amount / 1e7,
      available: credits(balance(db, req.user.id).available),
      model: m.id,
      estimate: true,
    });
  });
}
