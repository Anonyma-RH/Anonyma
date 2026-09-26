import { mediaRecipe } from "./history-library.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  now,
  usdUnits,
  settle,
  release,
  generationPrice,
  markupFactor,
  API_MEDIA_TTL_MS,
} from "./core.js";
import { pollVideo, payment } from "./provider.js";
import { recordPayment, OPEN_PAYMENT_STATUSES, sqlList } from "./payments.js";
import { refreshTokenHoldings } from "./auth.js";
import { sweepOAuth } from "./oauth.js";
import { settleHolderCycles, monthOf } from "./holders.js";
import { issueMediaReceipt } from "./receipts.js";

// Background maintenance: due routines, video completion, payment status
// checks, expired media and reservations, token holdings and table cleanup.
export function createWorker(ctx) {
  const { db, cfg, inflight, routines } = ctx;
  const { mediaJSON, saveMedia, deleteMedia, assignCosts } = ctx.media;
  const workerController = new AbortController();
  let workerPromise = null;
  let working = false;
  let closed = false;
  function recoverExpiredHolds() {
    const expired = db
      .prepare(
        "SELECT * FROM holds WHERE status='held' AND kind!='video' AND expires<?",
      )
      .all(now());
    for (const hold of expired) {
      if (inflight.holds.has(hold.id)) continue;
      const progress = hold.result ? JSON.parse(hold.result) : null;
      if (
        hold.kind === "image" &&
        progress?.mediaIds?.length &&
        Number.isSafeInteger(progress.delivered)
      ) {
        const receipt = settle(
          db,
          hold.id,
          progress.delivered,
          "Recovered image batch: " + progress.description,
        );
        assignCosts(progress.mediaIds, receipt.charged, hold.user_id);
      } else release(db, hold.id);
    }
  }
  async function runTick() {
    if (working || closed) return;
    working = true;
    try {
      // Routines (server/routines.js): start the runs that are due. They go
      // on alongside the rest of maintenance rather than holding it up.
      routines?.startDue();
      const jobs = db
        .prepare(
          "SELECT * FROM videos WHERE status IN ('pending','processing') ORDER BY updated ASC,created ASC LIMIT 20",
        )
        .all();
      const pollJob = async (job) => {
        if (closed) return;
        try {
          const result = await pollVideo(
            cfg,
            job.provider_id,
            workerController.signal,
          );
          if (result.status === "completed") {
            const request = JSON.parse(job.request);
            const existingMedia =
              job.media_id &&
              db
                .prepare("SELECT * FROM media WHERE id=? AND user_id=?")
                .get(job.media_id, job.user_id);
            let media =
              existingMedia &&
              existsSync(join(cfg.mediaPath, existingMedia.filename))
                ? mediaJSON(existingMedia)
                : null;
            if (!media && cfg.testMode && result.data?.test) {
              const testPath = resolve("data/test-video.mp4");
              if (!existsSync(testPath))
                throw Error("Local video test fixture is missing.");
              media = await saveMedia(
                job.user_id,
                "video",
                readFileSync(testPath),
                {
                  mime: "video/mp4",
                  prompt: "LOCAL TEST FIXTURE: " + request.prompt,
                  model: request.model,
                  ...(!request.api ? { protectMedia: request.library_source, recipe: mediaRecipe("video", { ...request, ratio: request.aspect_ratio }) } : {}),
                  ...(request.api ? { expires: now() + API_MEDIA_TTL_MS } : {}),
                },
              );
            } else if (!media)
              media = await saveMedia(job.user_id, "video", result.data?.url, {
                prompt: request.prompt,
                model: request.model,
                  ...(!request.api ? { protectMedia: request.library_source, recipe: mediaRecipe("video", { ...request, ratio: request.aspect_ratio }) } : {}),
                signal: workerController.signal,
                ...(request.api ? { expires: now() + API_MEDIA_TTL_MS } : {}),
              });
            db.prepare("UPDATE videos SET media_id=? WHERE id=?").run(
              media.id,
              job.id,
            );
            const user = db
              .prepare("SELECT * FROM users WHERE id=?")
              .get(job.user_id);
            const reportedCost = result.cost;
            const providerCost =
              typeof reportedCost === "number" &&
              Number.isFinite(reportedCost) &&
              reportedCost >= 0
                ? reportedCost
                : (request.quoted_provider_cost ??
                  generationPrice(ctx.models.find(request.model), {
                    ratio: request.aspect_ratio,
                    ...request,
                  }));
            const receipt = settle(
              db,
              job.hold_id,
              usdUnits(providerCost * markupFactor(user, cfg)),
              request.model,
            );
            db.prepare("UPDATE media SET cost=? WHERE id=?").run(
              receipt.charged,
              media.id,
            );
            // A /v1/videos job gets the same signed receipt as the rest of
            // the API; GET /v1/videos/:id returns it.
            if (request.api) {
              issueMediaReceipt(ctx, {
                hold: job.hold_id,
                user: job.user_id,
                requestId: job.hold_id.slice(job.user_id.length + 1),
                receipt,
                model: request.model,
                kind: "video",
                request: {
                  model: request.model,
                  prompt: request.prompt,
                  aspect_ratio: request.aspect_ratio,
                  duration: request.duration,
                  quality: request.quality,
                  image_url: request.image_url ?? null,
                },
                output: () => {
                  const file = db
                    .prepare("SELECT filename FROM media WHERE id=?")
                    .get(media.id);
                  return readFileSync(join(cfg.mediaPath, file.filename));
                },
              });
            }
            db.prepare(
              "UPDATE videos SET status='completed',media_id=?,updated=? WHERE id=?",
            ).run(media.id, now(), job.id);
          } else if (result.status === "failed") {
            release(db, job.hold_id);
            db.prepare(
              "UPDATE videos SET status='failed',error=?,updated=? WHERE id=?",
            ).run(
              result.error?.message ||
                result.error ||
                "Video generation failed.",
              now(),
              job.id,
            );
          } else {
            db.prepare(
              "UPDATE videos SET status='processing',updated=? WHERE id=?",
            ).run(now(), job.id);
            if (now() - job.created > 1200000)
              db.prepare(
                "UPDATE videos SET error='Provider is taking longer than expected; reservation retained until status is known.' WHERE id=?",
              ).run(job.id);
          }
        } catch (e) {
          if (closed) return;
          db.prepare("UPDATE videos SET error=?,updated=? WHERE id=?").run(
            "Retrying status check: " + e.message,
            now(),
            job.id,
          );
        }
      };
      for (let offset = 0; offset < jobs.length && !closed; offset += 4) {
        await Promise.all(jobs.slice(offset, offset + 4).map(pollJob));
      }
      if (closed) return;
      if (!cfg.testMode && cfg.paymentKey) {
        const pending = db
          .prepare(
            `SELECT * FROM deposits WHERE provider_id IS NOT NULL AND (status='reconciliation' OR credited=0 AND status IN (${sqlList(OPEN_PAYMENT_STATUSES)})) AND updated<? ORDER BY updated,created LIMIT 10`,
          )
          .all(now() - (cfg.paymentPollIntervalMs ?? 60000));
        const check = async (deposit) => {
          try {
            const update = await payment(
              cfg,
              "/payment/" + encodeURIComponent(deposit.provider_id),
              undefined,
              workerController.signal,
            );
            if (String(update.payment_id) !== deposit.provider_id)
              throw Error("Processor invoice identity mismatch.");
            recordPayment(db, update, {
              current: true,
              referralPercent: cfg.referralPercent,
            });
          } catch {
            db.prepare("UPDATE deposits SET updated=? WHERE id=?").run(
              now(),
              deposit.id,
            );
          }
        };
        for (let offset = 0; offset < pending.length && !closed; offset += 4)
          await Promise.all(pending.slice(offset, offset + 4).map(check));
      }
      if (closed) return;
      for (const m of db
        .prepare("SELECT * FROM media WHERE expires IS NOT NULL AND expires<?")
        .all(now()))
        deleteMedia(m);
      ctx.files.cleanup();
      // Auto-delete: messages cascade with their conversation. Access
      // already treats an expired conversation as gone before this runs.
      db.prepare(
        "DELETE FROM conversations WHERE expires IS NOT NULL AND expires<?",
      ).run(now());
      // Share a Chat: an expired link's snapshot goes too. Viewing already
      // refuses it at its deadline; this only reclaims the storage.
      db.prepare(
        "DELETE FROM share_links WHERE expires IS NOT NULL AND expires<=?",
      ).run(now());
      recoverExpiredHolds();
      if (cfg.rpc && cfg.token) {
        // About daily: each read schedules the next 12 to 36 hours on, at a
        // random time (token_due, server/holders.js). A failed read is
        // retried after an hour and never touches token_checked: tiers and
        // early access need a recent successful read, so a balance nobody
        // can confirm lapses, and a Holder Program cycle waits for one.
        for (const user of db
          .prepare(
            "SELECT * FROM users WHERE wallet IS NOT NULL AND deleted IS NULL AND COALESCE(token_due,0)<=? AND COALESCE(token_retry,0)<? ORDER BY COALESCE(token_due,0) LIMIT 5",
          )
          .all(now(), now() - 3600000)) {
          if (closed) break;
          try {
            await refreshTokenHoldings(db, cfg, user, { scheduled: true });
          } catch {
            db.prepare(
              "UPDATE users SET token_retry=? WHERE id=? AND wallet=? AND deleted IS NULL",
            ).run(now(), user.id, user.wallet);
          }
        }
      }
      if (closed) return;
      // NYMA Holder Program: pay every cycle that's due, each in its own
      // transaction and at most once. Then keep roadmap votes only for this
      // month and the last.
      settleHolderCycles(db, cfg);
      const today = new Date(now());
      db.prepare("DELETE FROM roadmap_votes WHERE month<?").run(
        monthOf(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1)),
      );
      db.prepare("DELETE FROM challenges WHERE expires<?").run(now() - 3600000);
      db.prepare("DELETE FROM rate_events WHERE created<?").run(
        now() - 86400000,
      );
      db.prepare("DELETE FROM sessions WHERE expires<?").run(now());
      sweepOAuth(db);
    } finally {
      working = false;
    }
  }
  // A crashed submission is deliberately not blindly resubmitted.
  db.prepare(
    "UPDATE videos SET status='reconciliation',error='Service restarted during submission; operator must reconcile upstream status.' WHERE status='submitting'",
  ).run();
  db.prepare(
    "UPDATE deposits SET status='reconciliation',updated=? WHERE status IN ('creating','error') AND provider_id IS NULL",
  ).run(now());
  recoverExpiredHolds();
  // Settles once this round of maintenance and the routine runs due by
  // then have finished (a routine that came due during a round still starts).
  function tick() {
    workerPromise ||= runTick().finally(() => {
      workerPromise = null;
    });
    if (!routines) return workerPromise;
    return workerPromise.then(() => {
      if (!closed) routines.startDue();
      return routines.idle();
    });
  }
  const timer = setInterval(
    () => {
      tick().catch(() =>
        console.error("Background maintenance failed; it will retry."),
      );
    },
    cfg.testMode ? 1500 : 7000,
  );
  timer.unref();
  return {
    tick,
    async stop() {
      closed = true;
      clearInterval(timer);
      workerController.abort();
      await workerPromise?.catch(() => {});
      await routines?.stop();
    },
    close() {
      closed = true;
      clearInterval(timer);
      workerController.abort();
      routines?.stop();
    },
  };
}
