import express from "express";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, database, uid } from "./core.js";
import { assertNoTestCredits } from "./readiness.js";
import { authRoutes } from "./auth.js";
import { createLimiter, applyMiddleware, errorHandler } from "./middleware.js";
import { releaseGuard } from "./releases.js";
import { requestHolder } from "./holders.js";
import { holderRoutes } from "./routes/holders.js";
import { createModels } from "./models.js";
import { createEarlyModels } from "./early-models.js";
import { createMediaStore } from "./media.js";
import { createAudioCatalog } from "./audio.js";
import { createFallback } from "./fallback.js";
import { createReceiptSigner } from "./receipts.js";
import { createWorker } from "./worker.js";
import { catalogRoutes } from "./routes/catalog.js";
import { conversationRoutes } from "./routes/conversations.js";
import { apiRoutes } from "./routes/api.js";
import { chatRoutes } from "./routes/chat.js";
import { receiptRoutes } from "./routes/receipts.js";
import { mcpRoutes } from "./routes/mcp.js";
import { mediaRoutes } from "./routes/media.js";
import { usageInsightRoutes } from "./routes/usage-insights.js";
import { videoRoutes } from "./routes/videos.js";
import { fileRoutes } from "./files.js";
import { audioRoutes } from "./routes/audio.js";
import { v1MediaRoutes } from "./routes/v1-media.js";
import { creditRoutes } from "./routes/credits.js";
import { collabRoutes } from "./routes/collabs.js";
import { treasuryRoutes } from "./routes/treasury.js";
import { retentionRoutes } from "./routes/retention.js";
import { scrollsRoutes } from "./routes/scrolls.js";
import { projectRoutes } from "./routes/projects.js";
import { memoryRoutes } from "./routes/memory.js";
import { costCompareRoutes } from "./routes/cost-compare.js";
import { bookmarkRoutes } from "./routes/bookmarks.js";
import { linkReaderRoutes } from "./routes/link-reader.js";
import { blindRoutes } from "./routes/blind.js";
import { researchRoutes } from "./routes/research.js";
import { shareRoutes } from "./routes/shares.js";
import { routineRoutes } from "./routes/routines.js";
import { sealedRoutes } from "./routes/sealed.js";
import { accountRoutes } from "./routes/account.js";
import { wipeRoutes } from "./routes/wipe.js";
import { twoStepRoutes } from "./routes/two-step.js";
import { allowanceRoutes } from "./routes/allowances.js";
import { apiBoostRoutes } from "./routes/api-boost.js";
import { spendingLimitRoutes } from "./routes/spending-limits.js";
import { balanceAlertRoutes } from "./routes/balance-alerts.js";
import { connectRoutes } from "./routes/connect.js";
import { paymentRoutes } from "./routes/payments.js";
import { nymaRoutes } from "./routes/nyma.js";
import { onchainRoutes } from "./routes/onchain.js";
import { historyLibrary } from "./history-library.js";
import { previewRoutes } from "./routes/preview.js";
import { siteRoutes } from "./routes/site.js";

export function createApp(overrides = {}) {
  const cfg = config(overrides),
    db = database(cfg.dbPath),
    app = express();
  try {
    assertNoTestCredits(db, cfg);
  } catch (e) {
    db.close();
    throw e;
  }
  mkdirSync(cfg.mediaPath, { recursive: true });
  // A persistent installation secret makes signed URLs survive restarts.
  const secretFile = join(cfg.mediaPath, ".secret");
  if (!cfg.secret) {
    if (!existsSync(secretFile))
      writeFileSync(secretFile, uid() + uid(), { mode: 0o600 });
    cfg.secret = readFileSync(secretFile, "utf8");
  }
  // Early Model Access: every catalog is recorded before it's used, so a
  // model is known as new from the first moment it can be offered.
  const earlyModels = createEarlyModels(db, cfg);
  // Shared by every route module. Requests register their abort controller
  // and reservation here so shutdown can cancel them and maintenance never
  // releases a reservation that is still being worked on.
  const ctx = {
    app,
    db,
    cfg,
    limit: createLimiter(db, cfg),
    models: createModels(cfg, {
      onCatalog: (next) => earlyModels.recordCatalog(next),
    }),
    earlyModels,
    media: createMediaStore(db, cfg),
    audio: createAudioCatalog(cfg, {
      onLoad: (next, live) => earlyModels.recordAudio(next, live),
    }),
    fallback: createFallback(cfg),
    receipts: createReceiptSigner(db, cfg),
    inflight: { controllers: new Set(), holds: new Set() },
  };
  // The catalog this process starts with. On a new or just-upgraded
  // database it becomes the baseline: nothing already listed is new.
  earlyModels.recordCatalog(ctx.models.snapshot);
  applyMiddleware(app, cfg);
  // Features not yet released are refused before any route runs, except an
  // early update for an early-access holder (Insider tier and up in the
  // NYMA Holder Program, server/holders.js).
  app.use(releaseGuard(cfg, requestHolder(db, cfg)));
  // Registration order matters: Express matches routes in this order, and
  // /v1/* and the /api 404 fallbacks must come after the real endpoints.
  Object.assign(ctx, authRoutes(app, db, cfg, ctx.limit));
  catalogRoutes(ctx);
  ctx.conversations = conversationRoutes(ctx);
  ctx.library = historyLibrary(ctx);
  ctx.treasury = treasuryRoutes(ctx);
  Object.assign(ctx, apiRoutes(ctx));
  ctx.files = fileRoutes(ctx);
  // Registered before chatRoutes: its /v1/*rest fallback must come last.
  v1MediaRoutes(ctx);
  Object.assign(ctx, chatRoutes(ctx));
  // Sealed Mode: the ciphertext relay, and its reconciler for the worker.
  Object.assign(ctx, sealedRoutes(ctx));
  receiptRoutes(ctx);
  mcpRoutes(ctx);
  mediaRoutes(ctx);
  videoRoutes(ctx);
  audioRoutes(ctx);
  creditRoutes(ctx);
  collabRoutes(ctx);
  retentionRoutes(ctx);
  scrollsRoutes(ctx);
  // Projects: runChat files a new chat in one (ctx.projects.forChat/file).
  ctx.projects = projectRoutes(ctx);
  usageInsightRoutes(ctx);
  Object.assign(ctx, memoryRoutes(ctx));
  // Cost Compare: one message's estimate on several models (reads only).
  costCompareRoutes(ctx);
  // Bookmarks: stars on saved messages (after conversations, whose access
  // rules it uses).
  bookmarkRoutes(ctx);
  // Link Reader: fetches one public page for a message (reads only).
  linkReaderRoutes(ctx);
  // Blind Compare: two chat replies through runChat, and the account's
  // votes (after projects, which a saved round can be filed in).
  blindRoutes(ctx);
  // Deep Research: plan, web searches and a sourced report, each step held
  // and settled on the ordinary billing path (after Memory and Projects,
  // whose checks it uses).
  researchRoutes(ctx);
  shareRoutes(ctx);
  holderRoutes(ctx);
  // Routines run from the worker, through runChat (registered above).
  ctx.routines = routineRoutes(ctx);
  const worker = createWorker(ctx);
  accountRoutes(ctx);
  // Panic Wipe: erases the account's content, keeps its credits.
  wipeRoutes(ctx);
  // Two-Step Sign-in's settings (its sign-in step is in authRoutes).
  twoStepRoutes(ctx);
  allowanceRoutes(ctx);
  // API Boost: the account's own API rate limit (the limits are applied by
  // the /v1 and /mcp routes, server/api-boost.js).
  apiBoostRoutes(ctx);
  // Also registers the Spending Limits check every reservation runs.
  spendingLimitRoutes(ctx);
  // Low-Balance Alerts: the account's alert level (a setting only).
  balanceAlertRoutes(ctx);
  connectRoutes(ctx);
  paymentRoutes(ctx);
  // Pay with NYMA: quotes and claims on the wallet-payment address.
  nymaRoutes(ctx);
  // Onchain Explainer: read-only chain lookups (the explanation is a chat).
  ctx.onchain = onchainRoutes(ctx).onchain;
  // Live Preview's frame page, before the site's static files and fallback.
  previewRoutes(ctx);
  siteRoutes(ctx);
  app.use(errorHandler(cfg));
  return {
    app,
    db,
    cfg,
    tick: worker.tick,
    // The Routines runner (server/routines.js), for tests and tooling.
    routines: ctx.routines,
    // Sealed Mode's reconciler (server/sealed.js), for tests and tooling.
    sealed: ctx.sealed,
    stopWork: async () => {
      for (const c of ctx.inflight.controllers)
        c.abort(new Error("Service restarting"));
      await worker.stop();
    },
    close: () => {
      worker.close();
      for (const c of ctx.inflight.controllers) c.abort();
      db.close();
    },
  };
}
