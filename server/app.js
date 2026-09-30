import express from "express";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config, database, uid } from "./core.js";
import { assertNoTestCredits } from "./readiness.js";
import { authRoutes } from "./auth.js";
import { createLimiter, applyMiddleware, errorHandler } from "./middleware.js";
import { releaseGuard, isReleased } from "./releases.js";
import { requestHolder } from "./holders.js";
import { holderRoutes } from "./routes/holders.js";
import { createModels } from "./models.js";
import { createEarlyModels } from "./early-models.js";
import { createMediaStore } from "./media.js";
import { createAudioCatalog } from "./audio.js";
import { createFallback } from "./fallback.js";
import { createReceiptSigner } from "./receipts.js";
import { createWorker } from "./worker.js";
import { createModelStatus } from "./model-status.js";
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
import { audioOverviewRoutes } from "./routes/audio-overview.js";
import { meetingNotesRoutes } from "./routes/meeting-notes.js";
import { photoToolsRoutes } from "./routes/photo-tools.js";
import { v1MediaRoutes } from "./routes/v1-media.js";
import { creditRoutes } from "./routes/credits.js";
import { giftRoutes } from "./routes/gifts.js";
import { collabRoutes } from "./routes/collabs.js";
import { treasuryRoutes } from "./routes/treasury.js";
import { retentionRoutes } from "./routes/retention.js";
import { scrollsRoutes } from "./routes/scrolls.js";
import { projectRoutes } from "./routes/projects.js";
import { characterRoutes } from "./routes/characters.js";
import { memoryRoutes } from "./routes/memory.js";
import { costCompareRoutes } from "./routes/cost-compare.js";
import { bookmarkRoutes } from "./routes/bookmarks.js";
import { chatImportRoutes } from "./routes/chat-import.js";
import { linkReaderRoutes } from "./routes/link-reader.js";
import { repoReaderRoutes } from "./routes/repo-reader.js";
import { blindRoutes } from "./routes/blind.js";
import { arenaRoutes } from "./routes/arena.js";
import { secretGuardRoutes } from "./routes/secret-guard.js";
import { researchRoutes } from "./routes/research.js";
import { translateRoutes } from "./routes/translate.js";
import { fileSearchRoutes } from "./routes/file-search.js";
import { sharpenRoutes } from "./routes/sharpen.js";
import { factCheckRoutes } from "./routes/factcheck.js";
import { catchupRoutes } from "./routes/catchup.js";
import { vaultSyncRoutes } from "./routes/vault-sync.js";
import { canvasRoutes } from "./routes/canvas.js";
import { slideRoutes } from "./routes/slides.js";
import { shareRoutes } from "./routes/shares.js";
import { routineRoutes } from "./routes/routines.js";
import { researchWatchRoutes } from "./routes/research-watch.js";
import { pageWatchRoutes } from "./routes/page-watch.js";
import { sealedRoutes } from "./routes/sealed.js";
import { accountRoutes } from "./routes/account.js";
import { wipeRoutes, wipeAccountContent } from "./routes/wipe.js";
import { inactivityWipeRoutes } from "./routes/inactivity-wipe.js";
import { createInactivityWipe } from "./inactivity-wipe.js";
import { twoStepRoutes } from "./routes/two-step.js";
import { passkeyRoutes } from "./routes/passkeys.js";
import { recoveryKitRoutes } from "./routes/recovery-kit.js";
import { createPasskeys } from "./passkeys.js";
import { unlockRoutes } from "./routes/unlock.js";
import { allowanceRoutes } from "./routes/allowances.js";
import { apiBoostRoutes } from "./routes/api-boost.js";
import { spendingLimitRoutes } from "./routes/spending-limits.js";
import { balanceAlertRoutes } from "./routes/balance-alerts.js";
import { pushAlertRoutes } from "./routes/push-alerts.js";
import { createPushAlerts } from "./push-alerts.js";
import { connectRoutes } from "./routes/connect.js";
import { paymentRoutes } from "./routes/payments.js";
import { nymaRoutes } from "./routes/nyma.js";
import { onchainRoutes } from "./routes/onchain.js";
import { historyLibrary } from "./history-library.js";
import { previewRoutes } from "./routes/preview.js";
import { statusRoutes } from "./routes/status.js";
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
    // Model Status: each model's recent outcomes and timings, in memory
    // only and only once released (server/model-status.js).
    modelStatus: createModelStatus({
      clock: cfg.statusClock || Date.now,
      enabled: () => isReleased(cfg, "status"),
    }),
  };
  // Push Alerts (server/push-alerts.js): created before the routes so
  // Routines, Page Watch and Gift Links can queue their notifications.
  ctx.push = createPushAlerts(ctx);
  // Research Watch tells Push Alerts about a delivered briefing through
  // ctx.pushAlerts (server/routines.js): ids only, and only the account and
  // kind reach the queue (tests replace it with setPushAlerts).
  ctx.pushAlerts = { notify: ({ user, kind }) => ctx.push.notify(user, kind) };
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
  // Audio Overview: a script from a text model, voiced with two speech
  // voices and kept in the library like other audio.
  audioOverviewRoutes(ctx);
  // Meeting Notes: a recording transcribed piece by piece, then notes from
  // a text model; each step held and settled on the ordinary billing path.
  // The worker ends runs left idle (ctx.meetingNotes.sweep).
  ctx.meetingNotes = meetingNotesRoutes(ctx);
  // Photo Tools: edit a photo with words, remove its background or upscale
  // it, on the gateway's image models; one held price, charged only for a
  // result that was checked and kept.
  photoToolsRoutes(ctx);
  creditRoutes(ctx);
  // Gift Links: credits held for a link anyone can claim once; the worker
  // returns the unclaimed ones after 30 days (ctx.gifts.expire).
  ctx.gifts = giftRoutes(ctx);
  collabRoutes(ctx);
  retentionRoutes(ctx);
  scrollsRoutes(ctx);
  // Projects: runChat files a new chat in one (ctx.projects.forChat/file).
  ctx.projects = projectRoutes(ctx);
  // Characters: runChat files a new chat with one (ctx.characters.forChat/
  // file); the character, its copy links and the account's own list live here.
  ctx.characters = characterRoutes(ctx);
  usageInsightRoutes(ctx);
  Object.assign(ctx, memoryRoutes(ctx));
  // Cost Compare: one message's estimate on several models (reads only).
  costCompareRoutes(ctx);
  // Bookmarks: stars on saved messages (after conversations, whose access
  // rules it uses).
  bookmarkRoutes(ctx);
  // Chat Import: chats brought from a ChatGPT or Claude export, saved as
  // ordinary conversations when the account destination is chosen.
  chatImportRoutes(ctx);
  // Link Reader: fetches one public page for a message (reads only).
  linkReaderRoutes(ctx);
  // Repo Reader: one public GitHub repo, read into a short-lived in-memory
  // cache (asking about it runs through runChat, registered above).
  ctx.repoReader = repoReaderRoutes(ctx);
  // Blind Compare: two chat replies through runChat, and the account's
  // votes (after projects, which a saved round can be filed in).
  blindRoutes(ctx);
  // Blind Arena: the public leaderboard from contributed Blind votes.
  arenaRoutes(ctx);
  // Secret Guard: the account's on/off switch (the guard runs in the browser).
  secretGuardRoutes(ctx);
  // Deep Research: plan, web searches and a sourced report, each step held
  // and settled on the ordinary billing path (after Memory and Projects,
  // whose checks it uses).
  researchRoutes(ctx);
  // Translate Documents: one model call per part of a document read in the
  // browser, each part held and settled on the ordinary billing path;
  // nothing is stored.
  translateRoutes(ctx);
  // File Search: a question matched against the text of the account's saved
  // files, then one model call on the passages kept, held and settled on the
  // ordinary billing path (after Conversations, where a saved answer goes).
  fileSearchRoutes(ctx);
  // Prompt Sharpen: one small model call that rewrites a prompt, held and
  // settled on the ordinary billing path; nothing is stored.
  sharpenRoutes(ctx);
  // Highlight & Ask's fact-check: one web search on selected text, held and
  // settled on the ordinary billing path (after Projects, which a new saved
  // check can be filed in).
  factCheckRoutes(ctx);
  // Summarize & Continue: Continue fresh for a saved chat (Catch me up
  // itself runs through runChat, registered above).
  catchupRoutes(ctx);
  // Vault Sync: sealed records only; the browser encrypts every chat first.
  vaultSyncRoutes(ctx);
  // Canvas: the canvases an account keeps (its suggestions run through
  // runChat, registered above).
  canvasRoutes(ctx);
  // Slides: saved decks (making one runs through runChat, registered above).
  slideRoutes(ctx);
  shareRoutes(ctx);
  holderRoutes(ctx);
  // Routines run from the worker, through runChat (registered above).
  ctx.routines = routineRoutes(ctx);
  // Research Watch: Deep Research's steps on a routine's schedule (its runs
  // are Routines' runs; these routes make and change the watches).
  researchWatchRoutes(ctx);
  // Page Watch checks run from the worker too; changes are summarised
  // through runChat and land in the Routines inbox.
  ctx.pageWatch = pageWatchRoutes(ctx);
  const worker = createWorker(ctx);
  // Passkeys' store, for the account export (routes are registered below).
  ctx.passkeys = createPasskeys(db, cfg);
  accountRoutes(ctx);
  // Panic Wipe: erases the account's content, keeps its credits.
  wipeRoutes(ctx);
  // Inactivity Wipe: the setting's routes, and the worker's sweep that
  // erases accounts past their deadline with Panic Wipe's erase.
  ctx.inactivity = createInactivityWipe(ctx, {
    erase: (user, steps) => wipeAccountContent(ctx, user, steps),
  });
  inactivityWipeRoutes(ctx);
  // Two-Step Sign-in's settings (its sign-in step is in authRoutes).
  twoStepRoutes(ctx);
  // Passkeys: sign-in, passwordless sign-up and Account → Security's list.
  passkeyRoutes(ctx);
  // Recovery Kit: ten one-time codes that get an account back in with its
  // username, then a new password or passkey (after Passkeys, whose
  // ceremony it reuses).
  recoveryKitRoutes(ctx);
  // Privacy Screen: the idle lock's unlock check (never touches the session).
  unlockRoutes(ctx);
  allowanceRoutes(ctx);
  // API Boost: the account's own API rate limit (the limits are applied by
  // the /v1 and /mcp routes, server/api-boost.js).
  apiBoostRoutes(ctx);
  // Also registers the Spending Limits check every reservation runs.
  spendingLimitRoutes(ctx);
  // Low-Balance Alerts: the account's alert level (a setting only).
  balanceAlertRoutes(ctx);
  // Push Alerts: the account's browsers and switches (delivery is the
  // worker's, ctx.push.tick).
  pushAlertRoutes(ctx);
  connectRoutes(ctx);
  paymentRoutes(ctx);
  // Pay with NYMA: quotes and claims on the wallet-payment address.
  nymaRoutes(ctx);
  // Onchain Explainer: read-only chain lookups (the explanation is a chat).
  ctx.onchain = onchainRoutes(ctx).onchain;
  // Model Status: the public, aggregated status of each model family.
  statusRoutes(ctx);
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
    // Page Watch's checker (server/page-watch.js), for tests and tooling.
    pageWatch: ctx.pageWatch,
    // Push Alerts' hook, when that update is wired in: a delivered research
    // report calls ctx.pushAlerts.notify (server/routines.js). For tests.
    setPushAlerts: (hook) => (ctx.pushAlerts = hook),
    // Sealed Mode's reconciler (server/sealed.js), for tests and tooling.
    sealed: ctx.sealed,
    // Model Status' in-memory window (server/model-status.js), for tests.
    modelStatus: ctx.modelStatus,
    // Recovery Kit's store (server/recovery-kit.js), for tests.
    recoveryKit: ctx.recoveryKit,
    // Inactivity Wipe's sweep and test-mode outbox, for tests and tooling.
    inactivity: ctx.inactivity,
    // Gift Links' expiry (server/routes/gifts.js), for tests and tooling.
    gifts: ctx.gifts,
    // Push Alerts' queue, sweeps and delivery, for tests and tooling.
    push: ctx.push,
    // Repo Reader's in-memory cache (server/repo-reader.js), for tests.
    repoReader: ctx.repoReader,
    stopWork: async () => {
      for (const c of ctx.inflight.controllers)
        c.abort(new Error("Service restarting"));
      await worker.stop();
    },
    close: () => {
      worker.close();
      ctx.repoReader.cache.clear();
      for (const c of ctx.inflight.controllers) c.abort();
      db.close();
    },
  };
}
