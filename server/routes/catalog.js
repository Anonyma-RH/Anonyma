import { openapi } from "../openapi.js";
import { createRatesFeed } from "../rates.js";
import { createMarketFeed } from "../market.js";
import { configurationStatus } from "../readiness.js";
import { videoOptions } from "../video-options.js";
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
  app.get("/api/openapi.json", (req, res) => res.json(openapi));
  app.get("/api/config", (req, res) =>
    res.json({
      name: "Anonyma",
      testMode: cfg.testMode,
      services: {
        generation: cfg.testMode || !!cfg.gatewayKey,
        payments: configurationStatus(cfg).configured.payments && !cfg.testMode,
        email: configurationStatus(cfg).configured.email || cfg.testMode,
        walletConnect: !!cfg.walletProject,
        token: !!cfg.rpc && !!cfg.token,
      },
      walletProject: cfg.walletProject,
      walletChain: cfg.walletChain,
      chain: cfg.chain,
      token: cfg.token,
      markup: cfg.markup,
      supportEmail: cfg.supportEmail,
      telegram: cfg.telegram,
      catalogUpdatedAt: models.snapshot.updatedAt,
      readiness: configurationStatus(cfg),
    }),
  );
  app.get("/api/models", async (req, res) => {
    const current = await models.current();
    res.json({
      ...current,
      data: current.data.map((m) => ({
        ...m,
        callable: callable(m, cfg),
        imageCapable: imageCallable(m),
        imagePrice: generationPrice(m),
        vision: vision(m),
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
        : quote(m, messages, maxTokens(req.body.max_tokens), req.body)) *
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
