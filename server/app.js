import express from "express";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, database, uid } from "./core.js";
import { assertNoTestCredits } from "./readiness.js";
import { authRoutes } from "./auth.js";
import { createLimiter, applyMiddleware, errorHandler } from "./middleware.js";
import { releaseGuard } from "./releases.js";
import { createModels } from "./models.js";
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
import { videoRoutes } from "./routes/videos.js";
import { audioRoutes } from "./routes/audio.js";
import { v1MediaRoutes } from "./routes/v1-media.js";
import { creditRoutes } from "./routes/credits.js";
import { collabRoutes } from "./routes/collabs.js";
import { retentionRoutes } from "./routes/retention.js";
import { scrollsRoutes } from "./routes/scrolls.js";
import { accountRoutes } from "./routes/account.js";
import { allowanceRoutes } from "./routes/allowances.js";
import { connectRoutes } from "./routes/connect.js";
import { paymentRoutes } from "./routes/payments.js";
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
  // Shared by every route module. Requests register their abort controller
  // and reservation here so shutdown can cancel them and maintenance never
  // releases a reservation that is still being worked on.
  const ctx = {
    app,
    db,
    cfg,
    limit: createLimiter(db, cfg),
    models: createModels(cfg),
    media: createMediaStore(db, cfg),
    audio: createAudioCatalog(cfg),
    fallback: createFallback(cfg),
    receipts: createReceiptSigner(db, cfg),
    inflight: { controllers: new Set(), holds: new Set() },
  };
  applyMiddleware(app, cfg);
  // Features not yet released are refused before any route runs.
  app.use(releaseGuard(cfg));
  // Registration order matters: Express matches routes in this order, and
  // /v1/* and the /api 404 fallbacks must come after the real endpoints.
  Object.assign(ctx, authRoutes(app, db, cfg, ctx.limit));
  catalogRoutes(ctx);
  ctx.conversations = conversationRoutes(ctx);
  Object.assign(ctx, apiRoutes(ctx));
  // Registered before chatRoutes: its /v1/*rest fallback must come last.
  v1MediaRoutes(ctx);
  Object.assign(ctx, chatRoutes(ctx));
  receiptRoutes(ctx);
  mcpRoutes(ctx);
  mediaRoutes(ctx);
  videoRoutes(ctx);
  audioRoutes(ctx);
  creditRoutes(ctx);
  collabRoutes(ctx);
  retentionRoutes(ctx);
  scrollsRoutes(ctx);
  const worker = createWorker(ctx);
  accountRoutes(ctx);
  allowanceRoutes(ctx);
  connectRoutes(ctx);
  paymentRoutes(ctx);
  siteRoutes(ctx);
  app.use(errorHandler(cfg));
  return {
    app,
    db,
    cfg,
    tick: worker.tick,
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
