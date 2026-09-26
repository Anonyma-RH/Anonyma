import { now, fail, reserve, release, markupFactor, credits } from "../core.js";
import { requestIdentifier } from "../middleware.js";
import {
  isSealedModel,
  parseUsageMetrics,
  responseByteCap,
} from "../../src/sealed.js";
import {
  sealedLive,
  sealedHold,
  sealedOutputCap,
  createAttestationCache,
  relayUpstream,
  readSmall,
  isKeyConfigProblem,
  refusal,
  finishSealed,
  sealedView,
  createSealedReconciler,
} from "../sealed.js";

// Sealed Mode's routes (see server/sealed.js). All three need the "sealed"
// update (releases.js) and a configured billing mode.
export function sealedRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight } = ctx;
  const attestation = createAttestationCache(cfg);
  const available = () => {
    if (!sealedLive(cfg))
      fail(503, "Sealed Mode isn't available right now.", "sealed_unavailable");
  };
  const sealedModel = (id) => {
    const m = typeof id === "string" ? ctx.models.find(id) : null;
    if (!m || m.status !== "live" || !isSealedModel(m))
      fail(
        400,
        "Sealed Mode works only with open-weight private models, which run inside the enclave.",
        "sealed_model_required",
      );
    return m;
  };

  // The enclave's attestation bundle, as PPQ serves it. The browser verifies
  // it (and its age) itself; nothing here is trusted by the browser.
  app.get(
    "/api/sealed/attestation",
    requireUser,
    limit("sealed_attestation", 30, 60000),
    async (req, res) => {
      available();
      let bundle;
      try {
        bundle = await attestation({ fresh: req.query.fresh === "1" });
      } catch {
        fail(503, "The enclave's attestation couldn't be fetched. Nothing was sent.", "attestation_unavailable");
      }
      res.set("Cache-Control", "no-store").json(bundle);
    },
  );

  // The relay. The body is EHBP ciphertext (a 4-byte length, then the
  // sealed request), read raw by middleware.js and forwarded untouched.
  app.post(
    "/api/sealed/chat",
    requireUser,
    limit("sealed", 20, 60000),
    async (req, res) => {
      available();
      const body = req.body;
      const enc = req.get("ehbp-encapsulated-key");
      if (
        !Buffer.isBuffer(body) ||
        body.length < 21 ||
        body.readUInt32BE(0) !== body.length - 4 ||
        typeof enc !== "string" ||
        !/^[0-9a-f]{64}$/i.test(enc)
      )
        fail(400, "This isn't a sealed request.", "sealed_protocol");
      const m = sealedModel(req.get("x-private-model"));
      const requestId = requestIdentifier(req);
      const holdId = req.user.id + ":" + requestId;
      const factor = markupFactor(req.user, cfg);
      const { inputBound, outputCap, amount, cap } = sealedHold(m, cfg, body.length, factor);
      if (amount > cap)
        fail(
          413,
          `This sealed request could cost up to ${credits(amount)} credits, more than the ${credits(cap)} a sealed request may hold. Start a new conversation or send less. Nothing was sent or charged.`,
          "sealed_hold_cap",
        );
      reserve(db, { id: holdId, user: req.user.id, amount, kind: "sealed", ttl: 240000 });
      db.prepare(
        "INSERT INTO sealed_requests(hold_id,user_id,request_id,model,ciphertext_bytes,input_bound,output_cap,factor,held,status,created) VALUES(?,?,?,?,?,?,?,?,?,'relaying',?)",
      ).run(holdId, req.user.id, requestId, m.id, body.length, inputBound, outputCap, factor, amount, now());
      // Released with no charge: the provider never accepted the request.
      const releaseFor = (reason) => {
        release(db, holdId);
        db.prepare(
          "UPDATE sealed_requests SET status='released',reason=?,finished=? WHERE hold_id=?",
        ).run(reason, now(), holdId);
      };

      const controller = new AbortController();
      inflight.controllers.add(controller);
      inflight.holds.add(holdId);
      const timeout = setTimeout(
        () => controller.abort(new Error("Provider timeout")),
        cfg.requestTimeoutMs || 240000,
      );
      let accepted = false,
        done = false,
        clientStopTimer;
      // As in chat: stopping before the provider accepts doesn't reliably
      // stop its work, so a client that leaves early is held until
      // acceptance (or 15 seconds), then stopped.
      res.on("close", () => {
        if (res.writableEnded || done) return;
        if (accepted) controller.abort(new Error("Client disconnected"));
        else
          clientStopTimer = setTimeout(
            () => controller.abort(new Error("Client disconnected")),
            15000,
          ).unref();
      });
      const cleanup = () => {
        done = true;
        clearTimeout(timeout);
        clearTimeout(clientStopTimer);
        inflight.controllers.delete(controller);
        inflight.holds.delete(holdId);
      };

      let upstream;
      try {
        upstream = await relayUpstream(cfg, {
          body,
          model: m.id,
          encapsulatedKey: enc,
          signal: controller.signal,
        });
      } catch {
        // No answer at all: nothing was accepted.
        cleanup();
        releaseFor(controller.signal.aborted ? "stopped" : "unreachable");
        if (!res.headersSent && !res.destroyed)
          fail(502, "The private endpoint couldn't be reached. Nothing was charged.", "provider_down");
        return;
      }
      const status = upstream.statusCode;
      const contentType = upstream.headers["content-type"];
      const nonce = upstream.headers["ehbp-response-nonce"];
      if (status === 200 && !nonce) {
        // A 200 that isn't sealed: it's never read or passed on. The enclave
        // may have answered, so the hold stays for reconciliation.
        upstream.on("error", () => {});
        controller.abort(new Error("Unsealed reply"));
        upstream.resume();
        cleanup();
        finishSealed(db, cfg, m, holdId, { outcome: "protocol", metrics: null, responseBytes: 0 });
        fail(502, "The private endpoint's reply wasn't sealed, so it wasn't passed on. Your hold waits for reconciliation.", "sealed_protocol");
      }
      if (status !== 200) {
        const problem = await readSmall(upstream);
        cleanup();
        releaseFor(isKeyConfigProblem(status, contentType) ? "key_config" : "refused_" + status);
        // The enclave rotated its key: the browser re-verifies and resends.
        if (isKeyConfigProblem(status, contentType))
          return res.status(422).type(contentType).send(problem);
        const r = refusal(status);
        fail(r.status, r.message, r.code);
      }

      // Accepted: stream the encrypted reply through as it arrives.
      accepted = true;
      db.prepare("UPDATE sealed_requests SET accepted=? WHERE hold_id=?").run(now(), holdId);
      clearTimeout(clientStopTimer);
      if (res.destroyed) controller.abort(new Error("Client disconnected"));
      res.status(200).set({
        "Content-Type": contentType || "text/event-stream",
        "Ehbp-Response-Nonce": nonce,
        "Cache-Control": "no-store",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      const maxBytes = responseByteCap(outputCap);
      let responseBytes = 0,
        cutOff = false;
      await new Promise((resolve) => {
        let settledOnce = false;
        const finish = (outcome) => {
          if (settledOnce) return;
          settledOnce = true;
          const metrics = parseUsageMetrics(
            upstream.trailers?.["x-tinfoil-usage-metrics"] ??
              upstream.headers["x-tinfoil-usage-metrics"],
          );
          try {
            // A usage record only counts on a reply that ended normally.
            finishSealed(db, cfg, m, holdId, {
              outcome,
              metrics: outcome === "complete" ? metrics : null,
              responseBytes,
            });
          } catch (e) {
            // The hold stays held; the sweep marks the request for
            // reconciliation. Nothing about the request is logged.
            console.error("Sealed settlement failed:", e.code || "error");
          } finally {
            resolve();
          }
        };
        upstream.on("data", (chunk) => {
          responseBytes += chunk.length;
          if (responseBytes > maxBytes) {
            cutOff = true;
            controller.abort(new Error("Output cap"));
            return;
          }
          if (!res.destroyed && !res.write(chunk)) {
            upstream.pause();
            res.once("drain", () => upstream.resume());
          }
        });
        upstream.on("end", () => finish(upstream.complete === false ? "interrupted" : "complete"));
        const stopped = () => {
          const reason = controller.signal.reason?.message;
          finish(
            cutOff
              ? "cutoff"
              : reason === "Provider timeout"
                ? "timeout"
                : reason === "Client disconnected"
                  ? "stopped"
                  : "interrupted",
          );
        };
        upstream.on("aborted", stopped);
        upstream.on("error", stopped);
        upstream.on("close", () => {
          if (!upstream.complete) stopped();
        });
      });
      cleanup();
      if (!res.destroyed) res.end();
    },
  );

  // A sealed request's billing: held, settled or waiting for reconciliation.
  app.get("/api/sealed/requests/:id", requireUser, (req, res) => {
    const row = db
      .prepare("SELECT * FROM sealed_requests WHERE hold_id=? AND user_id=?")
      .get(req.user.id + ":" + req.params.id, req.user.id);
    if (!row) fail(404, "Request not found.");
    res.json(sealedView(row, req.params.id));
  });

  return {
    sealed: createSealedReconciler({ db, cfg, models: ctx.models }),
    // For the model list: which models Sealed Mode offers, and their cap.
    sealedFields: (m) =>
      sealedLive(cfg) && m.status === "live" && isSealedModel(m)
        ? { sealed: true, sealedOutputCap: sealedOutputCap(m, cfg) }
        : {},
  };
}
