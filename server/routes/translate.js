import { fail, credits, usdUnits, balance, reserve, settle, release, imageCallable, tokenCost, markupFactor } from "../core.js";
import { chatStream, reportedProviderCost } from "../provider.js";
import { FAILOVER_CODES } from "../fallback.js";
import { requestIdentifier } from "../middleware.js";
import { isPrivateModel, ZDR_ROUTING } from "../private-mode.js";
import { isReleased } from "../releases.js";
import { tagUsage } from "../usage-insights.js";
import { privacyTrail, trailLive, veilMaskedFrom } from "../privacy-trail.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { viewerOf } from "../early-models.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import {
  CONCURRENCY,
  checkParts,
  checkPlaceholders,
  checkSettings,
  checkSizes,
  cleanTranslation,
  measure,
  partMessages,
  partTags,
  pricedMessages,
} from "../../src/translate-spec.js";
import { MIN_ROOM, partCost } from "../translate.js";

// Translate Documents (update "doctranslate"). The browser reads the
// document and splits it into parts by structure (src/doc-translate.js);
// each part is one model call with fixed instructions to return only its
// translation, keeping its Markdown structure (src/translate-spec.js).
//
// Money: /api/translate/quote prices the parts from their sizes alone (it's
// never sent their text). A run holds each part's maximum before anything
// is sent, exactly the quoted total and no more (the run is refused with
// 409 estimate_changed if its own total differs from the one the page
// showed). Each part settles on its actual usage as it finishes; a part
// that fails, is cut off at its reply budget, loses a Veil placeholder
// twice, is stopped or never starts is released, so only usable
// translations are charged. Retry and "Translate the rest" are new runs of
// just those parts. Balance and Spending Limits are checked on the holds.
// Workspace only, from the account's own balance.
//
// Privacy: always off the record. Nothing about a run is stored: no
// conversation, no text, no file name (the model sees "Part 3 of 12", never
// the name). Nothing is logged. The original file never reaches the server;
// only the parts' text does, masked by Veil in the browser when it's on.
// Private Mode runs on zero-data-retention models only, with ZDR routing
// and no failover. Its spend is filed as an ordinary chat in Usage Insights,
// as other off-the-record requests are.
export const TRANSLATE_LENGTH =
  "The model ran out of room before it finished this part, so it wasn't used or charged. Retry, or choose another model.";
export const TRANSLATE_EMPTY = "The model returned nothing for this part, so it wasn't charged. Retry, or choose another model.";
export const TRANSLATE_PLACEHOLDERS =
  "The translation of this part lost a detail Veil masked (such as [EMAIL_1]) twice, so it wasn't used or charged. Retry, or choose another model.";
export const TRANSLATE_FAILED = "This part couldn't be translated, so it wasn't charged. Retry, or choose another model.";
export const TRANSLATE_CHANGED = "The estimate changed since it was shown. Check the new one, then translate again. Nothing was charged.";
// Fields a translation never takes: it is only ever the parts.
const CONTEXT_FIELDS = [
  "auto",
  "messages",
  "conversationId",
  "project",
  "memory",
  "instructions",
  "documents",
  "files",
  "web_search",
  "plugins",
  "mode",
  "ephemeral",
  "compare",
  "study",
  "sheets",
  "catchup",
  "models",
  "question",
  "depth",
];
const validTokens = (value, fallback) => (Number.isSafeInteger(value) && value >= 0 ? value : fallback);

export function translateRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight, fallback } = ctx;
  const { getModel } = ctx.models;
  // One run at a time per account (a run holds its whole maximum): the
  // run's request id and its controller, for Stop.
  const running = new Map();

  // What a quote and a run share: no other chat options, the model, Private
  // Mode and the account's rate.
  function prepare(req) {
    const body = req.body || {};
    if (body.treasury != null) fail(400, "Translations are paid from your own balance, not a team treasury.", "invalid_request");
    for (const key of CONTEXT_FIELDS)
      if (body[key] !== undefined && body[key] !== null)
        fail(400, "A translation sends only the document's parts, so it can't be combined with other chat options.", "invalid_request");
    const m = getModel(body.model);
    // Early Model Access applies here as it does to a chat.
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
    if (m.type !== "chat" || imageCallable(m)) fail(400, "Translate docs needs a text model.", "unsupported_model");
    const isPrivate = body.private === true;
    if (isPrivate && !isPrivateModel(m, cfg)) fail(400, "Private mode needs a model with zero data retention.", "private_model_required");
    return { body, m, isPrivate, factor: markupFactor(req.user, cfg) };
  }
  const priced = (m, size, factor) => {
    const cost = partCost(cfg, m, size, factor);
    if (cost.room < MIN_ROOM)
      fail(
        400,
        "A part of this document is too long for this model's context. Choose a model with a larger context.",
        "context_limit_exceeded",
      );
    return cost;
  };

  // Quoting holds, sends and stores nothing. It takes each part's size,
  // never its text.
  app.post("/api/translate/quote", requireUser, limit("translate_quote", 120, 60000), (req, res) => {
    const { body, m, factor } = prepare(req);
    if (body.parts !== undefined || body.glossary !== undefined)
      fail(400, "A quote takes each part's size, not its text.", "invalid_request");
    let sizes;
    try {
      sizes = checkSizes(body.sizes);
    } catch (e) {
      fail(400, e.message, "invalid_translate");
    }
    const units = sizes.map((s) => priced(m, s, factor).units);
    const total = units.reduce((a, b) => a + b, 0);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(total),
      units: total,
      // Each part's maximum, in the order sent: a Retry of one part holds
      // exactly its own.
      part_units: units,
      parts: units.map(credits),
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      model: m.id,
      estimate: true,
    });
  });

  // Stop: the running translation's parts in flight, and every part not
  // started, are released; the stream then reports what finished, so
  // nothing charged goes unseen.
  app.post("/api/translate/stop", requireUser, limit("translate_stop", 60, 60000), (req, res) => {
    const run = running.get(req.user.id);
    const id = req.body?.requestId;
    if (id !== undefined && typeof id !== "string") fail(400, "requestId must be text.", "invalid_request");
    const stop = !!run && (id === undefined || id === run.requestId);
    if (stop) run.controller.abort(new Error("Stopped"));
    res.json({ stopped: stop });
  });

  app.post("/api/translate", requireUser, limit("translate", 20, 60000), async (req, res) => {
    const { body, m, isPrivate, factor } = prepare(req);
    let settings, parts;
    try {
      settings = checkSettings(body);
      parts = checkParts(body.parts, settings.of);
    } catch (e) {
      fail(400, e.message, "invalid_translate");
    }
    // Seed Guard, with the chat's own "Send anyway" (allow_seed_phrase,
    // gated in featuresFor): a part or glossary entry holding a wallet
    // recovery phrase is refused before anything is held.
    if (
      isReleased(cfg, "seedguard") &&
      body.allow_seed_phrase !== true &&
      [...parts.map((p) => p.text), ...settings.glossary.flatMap((g) => [g.term, g.as || ""])].some((t) => findSeedPhrase(t))
    )
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    const veilMasked = veilMaskedFrom(body);
    const { target, tone, of, glossary } = settings;
    // Each part's messages, and its maximum priced on its longest request.
    const plan = parts.map((part) => {
      const priceMessages = pricedMessages({ target, tone, part, of, glossary });
      const cost = priced(m, measure(priceMessages), factor);
      ctx.models.validateContext(priceMessages, m, cost.budget);
      return { part, messages: partMessages({ target, tone, part, of, glossary }), tags: partTags(part.text), ...cost };
    });
    const total = plan.reduce((n, p) => n + p.units, 0);
    // The shown maximum is what's held: a page showing another figure (an
    // old quote) is refused, and quotes again.
    if (body.max_units !== total) fail(409, TRANSLATE_CHANGED, "estimate_changed");
    const user = req.user.id;
    const requestId = requestIdentifier(req);
    if (running.has(user)) fail(409, "A translation is already running. Wait for it, or stop it first.", "translate_running");

    // ---- Hold every part's maximum, exactly ----
    const holdId = (index) => `${user}:${requestId}:p${index}`;
    const made = [];
    try {
      for (const p of plan) {
        reserve(db, { id: holdId(p.part.index), user, amount: p.units, ttl: 60 * 60000 });
        made.push(holdId(p.part.index));
      }
    } catch (e) {
      // A partly held run is undone completely; none of it ever ran.
      for (const id of made) db.prepare("DELETE FROM holds WHERE id=? AND status='held'").run(id);
      throw e;
    }
    const open = new Set(made);
    for (const id of made) {
      // Filed like an off-the-record chat: the model, never what it was for.
      tagUsage(db, cfg, id, { feature: "chat", model: m.id });
      inflight.holds.add(id);
    }
    const controller = new AbortController();
    running.set(user, { requestId, controller });
    inflight.controllers.add(controller);
    const send = (v) => {
      if (res.headersSent && !res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(v)}\n\n`);
    };
    const stopped = () => controller.signal.aborted;
    let charged = 0,
      anyBackup = false;

    // One model call, through the same gateway, failover and ZDR rules as a
    // chat: a private part never fails over, and nothing fails over once the
    // provider has accepted it.
    async function call(messages, max) {
      const step = new AbortController();
      const onStop = () => step.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", onStop, { once: true });
      const timer = setTimeout(() => step.abort(new Error("Provider timeout")), cfg.requestTimeoutMs || 240000);
      inflight.controllers.add(step);
      const upstream = { model: m.id, messages, max_tokens: max, ...(isPrivate ? ZDR_ROUTING : {}) };
      let accepted = false,
        route = "primary";
      const markAccepted = () => (accepted = true);
      async function* stream() {
        try {
          yield* chatStream(cfg, upstream, step.signal, markAccepted);
        } catch (e) {
          if (accepted || step.signal.aborted || isPrivate || !FAILOVER_CODES.has(e.code)) throw e;
          const backupModel = await fallback.modelFor(m.id);
          if (!backupModel) throw e;
          route = "backup";
          yield* chatStream(fallback.cfg, { ...upstream, model: backupModel }, step.signal, markAccepted);
        }
      }
      let text = "",
        reasoning = "",
        usage = null,
        upstreamCost = null,
        finish = null;
      // Model Status: each call counts as one request to the model.
      const probe = ctx.modelStatus.start(m.id);
      probe.sent();
      try {
        for await (const part of stream()) {
          if (part.error) fail(502, part.error.message || "Provider error", "provider_rejected");
          const choice = part.choices?.[0];
          if (typeof choice?.finish_reason === "string") finish = choice.finish_reason;
          const delta = choice?.delta || {};
          if (typeof delta.content === "string") text += delta.content;
          if (typeof delta.reasoning === "string" || typeof delta.reasoning_content === "string")
            reasoning += delta.reasoning || delta.reasoning_content;
          if (delta.content || delta.reasoning || delta.reasoning_content) probe.first();
          if (part.usage) usage = part.usage;
          if (Number.isFinite(part.cost)) upstreamCost = part.cost;
        }
        probe.done(!!(text || reasoning));
      } catch (e) {
        probe.fail(e, step.signal);
        throw e;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onStop);
        inflight.controllers.delete(step);
      }
      if (step.signal.aborted) throw step.signal.reason || Error("Stopped");
      if (route === "backup") anyBackup = true;
      const input = validTokens(usage?.prompt_tokens, validTokens(usage?.input_tokens, Math.ceil(JSON.stringify(messages).length / 4)));
      const out = validTokens(usage?.completion_tokens, validTokens(usage?.output_tokens, Math.ceil((text + reasoning).length / 4)));
      const fee = route === "backup" ? cfg.gateway2FeePercent : cfg.gatewayFeePercent;
      const dollars = reportedProviderCost(usage, upstreamCost, fee) ?? tokenCost(m, input, out);
      return { text, input, out, dollars, finish: finish || "stop", route };
    }
    const unusable = (message, code) => Object.assign(Error(message), { status: 502, code });
    // One part: translate, check, and settle only a usable translation.
    async function translate(p) {
      const index = p.part.index;
      send({ translate: { stage: "part", index, status: "running" } });
      let r,
        text,
        retried = false;
      try {
        for (let attempt = 0; ; attempt++) {
          const messages = attempt === 0 ? p.messages : partMessages({ target, tone, part: p.part, of, glossary, missing: r.missing });
          const got = await call(messages, p.budget);
          text = cleanTranslation(got.text, p.part.text);
          if (!text) throw unusable(TRANSLATE_EMPTY, "translate_empty");
          if (got.finish === "length") throw unusable(TRANSLATE_LENGTH, "translate_length");
          // Veil's placeholders must all come back, exactly and only once
          // each kind: the browser puts the real details back in their place.
          const check = checkPlaceholders(p.tags, text);
          r = { ...got, missing: check.missing.length ? check.missing : p.tags };
          if (check.ok) break;
          if (attempt >= 1) throw unusable(TRANSLATE_PLACEHOLDERS, "translate_placeholders");
          retried = true;
        }
        const receipt = settle(db, holdId(index), usdUnits(r.dollars * factor), m.name, {
          model: m.id,
          usage: { prompt_tokens: r.input, completion_tokens: r.out, total_tokens: r.input + r.out },
          finish_reason: r.finish,
        });
        open.delete(holdId(index));
        charged += receipt.charged;
        done++;
        send({
          translate: {
            stage: "part",
            index,
            status: "done",
            text,
            credits: receipt.credits_charged,
            finish_reason: r.finish,
            ...(retried ? { retried: true } : {}),
            ...(trailLive(cfg) ? { route: r.route } : {}),
          },
        });
      } catch (e) {
        release(db, holdId(index));
        open.delete(holdId(index));
        if (stopped()) {
          send({ translate: { stage: "part", index, status: "stopped" } });
          return;
        }
        // Our own refusals say why; anything else gets a plain message.
        const known = e?.status && e.code && String(e.code).startsWith("translate_");
        send({
          translate: {
            stage: "part",
            index,
            status: "failed",
            code: known ? e.code : "translate_failed",
            message: known ? e.message : TRANSLATE_FAILED,
          },
        });
      }
    }

    // ---- Run, streaming progress ----
    let done = 0;
    try {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      // Stop (POST /api/translate/stop, or leaving) cancels the parts in
      // flight and every part after.
      res.on("close", () => {
        if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
      });
      send({ translate: { stage: "started", parts: plan.map((p) => p.part.index), reserved: credits(total) } });
      let next = 0;
      const worker = async () => {
        while (next < plan.length && !stopped()) await translate(plan[next++]);
      };
      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.length) }, worker));
    } finally {
      for (const id of open) release(db, id);
      open.clear();
      for (const id of made) inflight.holds.delete(id);
      inflight.controllers.delete(controller);
      running.delete(user);
    }
    const status = stopped() ? "stopped" : done < plan.length ? "partial" : "done";
    const trail = trailLive(cfg)
      ? privacyTrail(cfg, {
          model: m,
          route: anyBackup ? "backup" : "primary",
          zeroDataRetention: isPrivate,
          storage: isPrivate ? "private" : "off_the_record",
          veilMasked,
          receiptId: null,
        })
      : null;
    send({
      translate: { stage: "done", status, done, not_done: plan.length - done, credits_charged: credits(charged) },
      anonyma: {
        credits_charged: credits(charged),
        request_id: requestId,
        stored: false,
        ...(cfg.testMode ? { local_test: true } : {}),
        ...(isPrivate ? { private: { privacy: "zdr", stored: false } } : {}),
        ...(trail ? { privacy: trail } : {}),
      },
    });
    if (!res.destroyed && !res.writableEnded) res.end("data: [DONE]\n\n");
  });
}
