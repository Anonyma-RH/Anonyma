import {
  uid,
  now,
  fail,
  credits,
  balance,
  reserve,
  settle,
  release,
  imageCallable,
  tokenCost,
  usdUnits,
  markupFactor,
} from "../core.js";
import { chatStream, reportedProviderCost } from "../provider.js";
import { FAILOVER_CODES } from "../fallback.js";
import { transcribeAudio } from "../audio.js";
import { AUTO_NOT_OFFERED } from "../auto-model.js";
import { requestIdentifier } from "../middleware.js";
import { isPrivateModel, ZDR_ROUTING } from "../private-mode.js";
import { isReleased } from "../releases.js";
import { tagUsage } from "../usage-insights.js";
import { privacyTrail, trailLive, veilMaskedFrom } from "../privacy-trail.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { viewerOf } from "../early-models.js";
import { findSeedPhrase, findPrivateKey, SEED_MESSAGE, KEY_MESSAGE } from "../../src/seed-guard.js";
import { SPOKEN, checkPlan, chunkStarts } from "../../src/meeting-notes.js";
import { checkPlaceholders } from "../../src/sharpen.js";
import { checkSizes, languageOf } from "../../src/translate-spec.js";
import {
  MAX_SETS,
  NO_TIMINGS,
  SUBTITLES_PRIVATE,
  TRANSLATE_CHANGED,
  TRANSLATE_COUNT,
  TRANSLATE_EMPTY,
  TRANSLATE_FAILED,
  TRANSLATE_LENGTH,
  TRANSLATE_PLACEHOLDERS,
  batchTags,
  checkBatches,
  checkSetRecord,
  checkTracks,
  measure,
  parseTranslation,
  translateMessages,
} from "../../src/subtitles.js";
import { cleanPiece, sttCharge } from "../meeting-notes.js";
import { pieceTokens, placeTokens, subtitleTestTranscript } from "../subtitles.js";
import { MIN_ROOM, partCost } from "../translate.js";

// Subtitles (update "subtitles", which needs Voice & Audio too; see
// featuresFor). The browser reads a video's sound (never its picture),
// cuts it into pieces of at most five minutes and sends each as plain
// 16 kHz mono PCM, exactly as Meeting Notes does, to be transcribed with a
// speech model from the audio catalog, asking for word timings. The words
// come back and the browser cuts them into cues (src/subtitles.js).
// Translating a track is a separate, priced step: the cues' text only,
// in batches, one off-the-record model call each, with the timings kept.
//
// Money: when a run starts, exactly the maximum the quote shows is held, one
// hold per piece (its length at the model's per-minute price), with no extra
// margin. Each piece settles on its own length (or the provider's, if
// shorter) as it's transcribed; a piece that fails, or comes back with no
// usable word timings, is charged nothing and stays open for a retry.
// Whatever is left is released when the run ends (finished, discarded or idle
// for 30 minutes). A translation holds every batch's maximum, exactly the
// total the page showed (409 estimate_changed otherwise), and settles each
// batch on its usage only when its answer is usable. Workspace only: no API
// key, so no allowance applies; Spending Limits apply to every hold.
//
// Privacy: the video's sound goes to the transcription provider; the file, its
// name and its picture never leave the browser, and no audio is stored or
// logged here. A run in progress keeps only its plan and holds in memory,
// never the words. A translation sends only the cues' text (Veil-masked in the
// browser when Veil is on) as one "send as data" document a batch. Nothing is
// kept about either but what the person saves: a set of subtitle tracks (the
// cues' times and text, never the video or the sound), off the record not at
// all. Private Mode is refused for transcription, since no transcription model
// offers zero data retention; a translation can run in Private Mode on a
// zero-data-retention model.
const IDLE_MS = 30 * 60000;
const HOLD_TTL = 3 * 3600000;
const MAX_PIECE_BYTES = 10 * 1024 * 1024;
const PIECE = /^data:audio\/wav;base64,([A-Za-z0-9+/=]+)$/;
const SPOKEN_CODES = SPOKEN.map(([code]) => code);
const CONCURRENCY = 3;
const validTokens = (value, fallback) => (Number.isSafeInteger(value) && value >= 0 ? value : fallback);
const round2 = (n) => Math.round(n * 100) / 100;
const TRANSLATE_FIELDS = new Set(["target", "model", "private", "sizes", "of", "batches", "max_units", "veil_masked", "requestId"]);

// Seed Guard's message for text holding a wallet recovery phrase or private
// key (no override: the text would go to a model or be kept), else null.
const secretIn = (text) => (findSeedPhrase(text) ? SEED_MESSAGE : findPrivateKey(text) ? KEY_MESSAGE : null);
const view = (r, full = true) => {
  const tracks = JSON.parse(r.tracks);
  return {
    id: r.id,
    title: r.title,
    duration: r.duration,
    language: r.language,
    ...(full ? { tracks } : {}),
    track_list: tracks.map((t) => ({ lang: t.lang, source: t.source, cues: t.cues.length })),
    created: r.created,
    updated: r.updated,
  };
};
// Account export: every set, whole (it's the account's own content).
export const exportSubtitleSets = (db, user) =>
  db
    .prepare("SELECT * FROM subtitle_sets WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((r) => view(r));
// Account closure and Panic Wipe (eraseAccountContent in routes/account.js).
export const forgetSubtitleSets = (db, user) => db.prepare("DELETE FROM subtitle_sets WHERE user_id=?").run(user);

export function subtitleRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight, fallback, audio } = ctx;
  const { getModel } = ctx.models;
  // Runs in progress, by id; one per account. Only the plan, the holds and
  // what's been charged: never audio or words.
  const runs = new Map();
  const runOf = (user) => [...runs.values()].find((r) => r.user === user);
  // A translation running, by account: its request id and controller, for Stop.
  const translating = new Map();

  // Ends a run: every hold still open is released (nothing more is
  // charged), and the run is forgotten.
  function end(run) {
    for (const piece of run.pieces) if (piece.status !== "done") release(db, piece.hold);
    runs.delete(run.id);
  }
  // Runs nobody has touched for 30 minutes (a closed tab) end; the worker
  // calls this on each tick. A request in flight is never interrupted.
  function sweep(at = now()) {
    for (const run of runs.values()) if (!run.busy && at - run.touched > IDLE_MS) end(run);
  }
  function ownRun(req) {
    const run = runs.get(String(req.params.id));
    if (!run || run.user !== req.user.id) fail(404, "This transcription has ended. Start again from the video.", "subtitles_not_found");
    if (run.busy) fail(409, "A step of this transcription is still running. Wait for it to finish.", "subtitles_busy");
    return run;
  }

  // ---- Transcription ----

  // Everything a quote and a start share, checked before anything is held.
  async function prepare(req) {
    const body = req.body || {};
    if (body.auto !== undefined) fail(400, AUTO_NOT_OFFERED, "auto_not_offered");
    if (body.treasury != null) fail(400, "Subtitles are paid from your own balance, not a team treasury.", "invalid_request");
    if (body.private === true) fail(400, SUBTITLES_PRIVATE, "subtitles_private_unavailable");
    let seconds;
    try {
      seconds = checkPlan(body.chunks, body.duration);
    } catch (e) {
      fail(400, e.message, "invalid_plan");
    }
    const duration = Number(body.duration);
    const stt = await audio.model("stt", String(body.stt || "nova-3"));
    ctx.earlyModels.check(viewerOf(req), "stt", stt.id);
    const spoken = body.language == null || body.language === "" ? "" : String(body.language);
    if (spoken && !SPOKEN_CODES.includes(spoken)) fail(400, "Choose a spoken language from the list.", "invalid_request");
    const ephemeral = body.ephemeral === true;
    const factor = markupFactor(req.user, cfg);
    const starts = chunkStarts(seconds);
    const pieces = seconds.map((s, i) => ({ index: i, start: starts[i], seconds: s, amount: sttCharge(s, stt, factor) }));
    const total = pieces.reduce((n, p) => n + p.amount, 0);
    return { duration, stt, spoken, ephemeral, factor, pieces, total };
  }

  app.post("/api/subtitles/quote", requireUser, limit("subtitles_quote", 120, 60000), async (req, res) => {
    const p = await prepare(req);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(p.total),
      units: p.total,
      usd: p.total / 1e7,
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      pieces: p.pieces.length,
      minutes: round2(p.duration / 60),
      credits_per_minute: credits(usdUnits(p.stt.pricing.api_price * p.factor)),
      stt: { id: p.stt.id, name: p.stt.name, provider: p.stt.provider || null },
      estimate: true,
    });
  });

  app.post("/api/subtitles", requireUser, limit("subtitles_start", 6, 60000), async (req, res) => {
    sweep();
    const p = await prepare(req);
    const user = req.user.id;
    // The shown maximum is what's held: a page showing another figure (an
    // old quote) is refused, and quotes again.
    if (req.body.max_units !== undefined && req.body.max_units !== p.total)
      fail(409, "The estimate changed since it was shown. Check the new one, then start again. Nothing was charged.", "estimate_changed");
    const requestId = requestIdentifier(req);
    // A new run replaces this account's earlier one: whatever it still held
    // is released (its finished pieces stay charged).
    const earlier = runOf(user);
    if (earlier?.busy) fail(409, "A transcription is already running. Wait for it, or stop it first.", "subtitles_running");
    if (earlier) end(earlier);
    const holdId = (i) => `${user}:${requestId}:p${i}`;
    // Exactly the maximum the quote shows: each piece.
    const made = [];
    try {
      for (const piece of p.pieces) {
        reserve(db, { id: holdId(piece.index), user, amount: piece.amount, kind: "audio", ttl: HOLD_TTL });
        made.push(holdId(piece.index));
      }
    } catch (e) {
      // A partly held run is undone completely; none of it ever ran.
      for (const id of made) db.prepare("DELETE FROM holds WHERE id=? AND status='held'").run(id);
      throw e;
    }
    const run = {
      id: uid("sub_"),
      user,
      requestId,
      duration: p.duration,
      stt: p.stt,
      spoken: p.spoken,
      ephemeral: p.ephemeral,
      factor: p.factor,
      pieces: p.pieces.map((piece) => ({ ...piece, hold: holdId(piece.index), status: "open", charged: 0 })),
      busy: false,
      touched: now(),
    };
    runs.set(run.id, run);
    res.status(201).json({
      id: run.id,
      pieces: run.pieces.map((x) => ({ index: x.index, start: x.start, seconds: x.seconds })),
      reserved: credits(p.total),
      stt: { id: p.stt.id, name: p.stt.name, provider: p.stt.provider || null },
      idle_minutes: IDLE_MS / 60000,
    });
  });

  // One piece: transcribed, then charged for its length. A failed piece, or
  // one the provider gave no usable word timings for, is charged nothing and
  // stays open for a retry.
  app.post("/api/subtitles/:id/pieces/:index", requireUser, limit("subtitles_piece", 60, 60000), async (req, res) => {
    const run = ownRun(req);
    const piece = run.pieces[Number(req.params.index)];
    if (!piece || !/^\d+$/.test(req.params.index)) fail(404, "There's no such piece in this video.", "not_found");
    if (piece.status === "done") fail(409, "This piece is already transcribed.", "piece_done");
    const match = typeof req.body?.audio === "string" ? PIECE.exec(req.body.audio) : null;
    if (!match) fail(400, "Send the piece as a base64 WAV data URL.", "invalid_audio");
    const raw = Buffer.from(match[1], "base64");
    if (!raw.length || raw.length > MAX_PIECE_BYTES) fail(400, "Each piece must be under 10 MB.", "invalid_audio");
    const { bytes, seconds } = cleanPiece(raw);
    if (Math.abs(seconds - piece.seconds) > 0.05)
      fail(400, "This piece isn't the length the video was planned with. Start again from the video.", "invalid_audio");
    run.busy = true;
    run.touched = now();
    inflight.holds.add(piece.hold);
    const controller = new AbortController();
    inflight.controllers.add(controller);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
    });
    try {
      let r;
      const probe = ctx.modelStatus.start(run.stt.id);
      try {
        probe.sent();
        r = cfg.testMode
          ? subtitleTestTranscript({ start: piece.start, seconds })
          : await transcribeAudio(
              cfg,
              { model: run.stt.id, bytes, mime: "audio/wav", language: run.spoken, timestamps: true },
              AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
            );
        probe.done(!!(r.text?.trim() || r.tokens?.length));
      } catch (e) {
        probe.fail(e, controller.signal);
        if (controller.signal.aborted) fail(400, "Stopped. Nothing was charged for this piece.", "piece_stopped");
        // Ours has a status (a provider refusal); anything else, a plain one.
        fail(e?.status || 502, `${e?.status ? e.message : "The transcription provider couldn't be reached."} Nothing was charged for this piece.`, e?.code || "provider_down");
      }
      // The words with their times. Speech the provider gave no usable
      // timing for isn't guessed at: the piece is charged nothing.
      const tokens = pieceTokens(r, seconds);
      if (!tokens.length && (r.text || "").trim()) fail(502, NO_TIMINGS, "subtitles_no_timings");
      // Charged for the piece's own length, or the provider's if shorter.
      const billed = Number.isFinite(r.duration) && r.duration >= 0 ? Math.min(seconds, r.duration) : seconds;
      const receipt = settle(db, piece.hold, sttCharge(billed, run.stt, run.factor), "Transcription: " + run.stt.name, {
        model: run.stt.id,
        seconds: round2(billed),
      });
      piece.status = "done";
      piece.charged = receipt.charged;
      const charged = run.pieces.reduce((n, x) => n + x.charged, 0);
      const done = run.pieces.filter((x) => x.status === "done").length;
      const body = {
        index: piece.index,
        tokens: placeTokens(tokens, piece.start, seconds),
        seconds: round2(billed),
        credits: credits(receipt.charged),
        charged: credits(charged),
        done,
        of: run.pieces.length,
        ...(cfg.testMode ? { local_test: true } : {}),
        // Where the sound went, when Privacy Trail is live.
        ...(trailLive(cfg)
          ? {
              privacy: privacyTrail(cfg, {
                model: { id: run.stt.id, owned_by: run.stt.provider },
                route: "primary",
                zeroDataRetention: false,
                storage: run.ephemeral ? "off_the_record" : "saved",
                receiptId: null,
              }),
            }
          : {}),
      };
      // The last piece ends the run (nothing is left to hold).
      if (done === run.pieces.length) end(run);
      res.json(body);
    } finally {
      inflight.holds.delete(piece.hold);
      inflight.controllers.delete(controller);
      run.busy = false;
      run.touched = now();
    }
  });

  // Discard, or finish with what's transcribed: everything still held is
  // released, and the run ends.
  app.delete("/api/subtitles/:id", requireUser, limit("subtitles_end", 30, 60000), (req, res) => {
    const run = runs.get(String(req.params.id));
    if (!run || run.user !== req.user.id) return res.json({ ended: true, credits_charged: 0 });
    if (run.busy) fail(409, "A step of this transcription is still running. Wait for it to finish.", "subtitles_busy");
    const charged = run.pieces.reduce((n, x) => n + x.charged, 0);
    end(run);
    res.json({ ended: true, credits_charged: credits(charged) });
  });

  // ---- Translation ----

  // What a quote and a run share: the model, Private Mode and the account's
  // rate, and nothing else about a chat.
  function prepareTranslate(req) {
    const body = req.body || {};
    if (body.auto !== undefined) fail(400, AUTO_NOT_OFFERED, "auto_not_offered");
    if (body.treasury != null) fail(400, "Translations are paid from your own balance, not a team treasury.", "invalid_request");
    for (const key of Object.keys(body))
      if (!TRANSLATE_FIELDS.has(key))
        fail(400, "A translation sends only the cues' text, so it can't be combined with other chat options.", "invalid_request");
    if (!languageOf(body.target)) fail(400, "Choose a language to translate into.", "invalid_request");
    const m = getModel(body.model);
    // Early Model Access applies here as it does to a chat.
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
    if (m.type !== "chat" || imageCallable(m)) fail(400, "Translating subtitles needs a text model.", "unsupported_model");
    const isPrivate = body.private === true;
    if (isPrivate && !isPrivateModel(m, cfg)) fail(400, "Private mode needs a model with zero data retention.", "private_model_required");
    return { body, m, isPrivate, target: body.target, factor: markupFactor(req.user, cfg) };
  }
  const priced = (m, size, factor) => {
    const cost = partCost(cfg, m, size, factor);
    if (cost.room < MIN_ROOM)
      fail(400, "A part of this track is too long for this model's context. Choose a model with a larger context.", "context_limit_exceeded");
    return cost;
  };

  // Quoting holds, sends and stores nothing. It takes each part's size,
  // never its text.
  app.post("/api/subtitles/translate/quote", requireUser, limit("subtitles_translate_quote", 120, 60000), (req, res) => {
    const { body, m, factor } = prepareTranslate(req);
    if (body.batches !== undefined) fail(400, "A quote takes each part's size, not its text.", "invalid_request");
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
      part_units: units,
      parts: units.map(credits),
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      model: m.id,
      estimate: true,
    });
  });

  // Stop: the parts in flight and every part not started are released; the
  // stream then reports what finished, so nothing charged goes unseen.
  app.post("/api/subtitles/translate/stop", requireUser, limit("subtitles_translate_stop", 60, 60000), (req, res) => {
    const run = translating.get(req.user.id);
    const id = req.body?.requestId;
    if (id !== undefined && typeof id !== "string") fail(400, "requestId must be text.", "invalid_request");
    const stop = !!run && (id === undefined || id === run.requestId);
    if (stop) run.controller.abort(new Error("Stopped"));
    res.json({ stopped: stop });
  });

  app.post("/api/subtitles/translate", requireUser, limit("subtitles_translate", 20, 60000), async (req, res) => {
    const { body, m, isPrivate, target, factor } = prepareTranslate(req);
    let batches;
    try {
      batches = checkBatches(body.batches, body.of);
    } catch (e) {
      fail(400, e.message, "invalid_translate");
    }
    // Seed Guard: cues holding a wallet recovery phrase are refused before
    // anything is held (the browser keeps them; nothing is sent).
    const spoken = batches
      .slice()
      .sort((a, b) => a.index - b.index)
      .flatMap((b) => b.items.map((i) => i.text))
      .join("\n");
    if (isReleased(cfg, "seedguard")) {
      const secret = secretIn(spoken);
      if (secret) fail(400, secret, "seed_phrase_blocked");
    }
    const veilMasked = veilMaskedFrom(body);
    const of = body.of;
    // Each part's messages, and its maximum priced on its longest request.
    const plan = batches.map((batch) => {
      const messages = translateMessages({ target, batch, of });
      const cost = priced(m, measure(messages), factor);
      ctx.models.validateContext(messages, m, cost.budget);
      return { batch, messages, tags: batchTags(batch.items), ...cost };
    });
    const total = plan.reduce((n, p) => n + p.units, 0);
    // The shown maximum is what's held: a page showing another figure (an
    // old quote) is refused, and quotes again.
    if (body.max_units !== total) fail(409, TRANSLATE_CHANGED, "estimate_changed");
    const user = req.user.id;
    const requestId = requestIdentifier(req);
    if (translating.has(user)) fail(409, "A translation is already running. Wait for it, or stop it first.", "translate_running");

    // ---- Hold every part's maximum, exactly ----
    const holdId = (index) => `${user}:${requestId}:t${index}`;
    const made = [];
    try {
      for (const p of plan) {
        reserve(db, { id: holdId(p.batch.index), user, amount: p.units, ttl: 60 * 60000 });
        made.push(holdId(p.batch.index));
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
    translating.set(user, { requestId, controller });
    inflight.controllers.add(controller);
    const send = (v) => {
      if (res.headersSent && !res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(v)}\n\n`);
    };
    const stopped = () => controller.signal.aborted;
    let charged = 0,
      anyBackup = false,
      done = 0;

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
    // One part: translate, check, and settle only a usable answer.
    async function translate(p) {
      const index = p.batch.index;
      send({ translate: { stage: "part", index, status: "running" } });
      try {
        const got = await call(p.messages, p.budget);
        // Every cue must come back, once, by its number (or in order).
        const read = parseTranslation(got.text, p.batch.items);
        if (!read.texts) {
          if (got.finish === "length") throw unusable(TRANSLATE_LENGTH, "translate_length");
          throw unusable(read.problem === "count" ? TRANSLATE_COUNT : TRANSLATE_EMPTY, read.problem === "count" ? "translate_count" : "translate_empty");
        }
        // Veil's placeholders must all come back, exactly and only once
        // each kind: the browser puts the real details back in their place.
        const check = checkPlaceholders(p.tags, read.texts.map((x) => x.text).join("\n"));
        if (!check.ok) throw unusable(TRANSLATE_PLACEHOLDERS, "translate_placeholders");
        const receipt = settle(db, holdId(index), usdUnits(got.dollars * factor), m.name, {
          model: m.id,
          usage: { prompt_tokens: got.input, completion_tokens: got.out, total_tokens: got.input + got.out },
          finish_reason: got.finish,
        });
        open.delete(holdId(index));
        charged += receipt.charged;
        done++;
        send({
          translate: {
            stage: "part",
            index,
            status: "done",
            cues: read.texts,
            credits: receipt.credits_charged,
            finish_reason: got.finish,
            ...(trailLive(cfg) ? { route: got.route } : {}),
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
    try {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
      // Stop (POST /api/subtitles/translate/stop, or leaving) cancels the
      // parts in flight and every part after.
      res.on("close", () => {
        if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
      });
      send({ translate: { stage: "started", parts: plan.map((p) => p.batch.index), reserved: credits(total) } });
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
      translating.delete(user);
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

  // ---- Saved sets ----

  const read = limit("subtitles-read", 240, 60000);
  // Autosave sends an edit about a second after typing stops.
  const write = limit("subtitles-sets", 240, 60000);
  function checked(body, partial) {
    let record;
    try {
      record = checkSetRecord(body, { partial });
    } catch (e) {
      fail(400, e.message, "invalid_subtitles");
    }
    return record;
  }
  const finishTracks = (tracks, duration) => {
    let out;
    try {
      out = checkTracks(tracks, duration);
    } catch (e) {
      fail(400, e.message, e.message.includes("too large") ? "subtitles_too_large" : "invalid_subtitles");
    }
    // Seed Guard: a set is stored, so a seed phrase is never saved in one.
    if (isReleased(cfg, "seedguard")) {
      const secret = out.map((t) => secretIn(t.cues.map((c) => c.text).join("\n"))).find(Boolean);
      if (secret) fail(400, secret, "seed_phrase_blocked");
    }
    return out;
  };
  const one = (id, user) => {
    const r = typeof id === "string" && id.length <= 100 && db.prepare("SELECT * FROM subtitle_sets WHERE id=? AND user_id=?").get(id, user);
    if (!r) fail(404, "Subtitle set not found.", "subtitles_set_not_found");
    return r;
  };

  app.get("/api/subtitles/sets", requireUser, read, (req, res) => {
    const rows = db.prepare("SELECT * FROM subtitle_sets WHERE user_id=? ORDER BY updated DESC,rowid DESC LIMIT ?").all(req.user.id, MAX_SETS);
    res.json({ data: rows.map((r) => view(r, false)), limit: MAX_SETS });
  });

  app.post("/api/subtitles/sets", requireUser, write, (req, res) => {
    const record = checked(req.body, false);
    const tracks = finishTracks(record.tracks, record.duration);
    const id = uid("subs_"),
      at = now();
    try {
      db.prepare("INSERT INTO subtitle_sets(id,user_id,title,duration,language,tracks,created,updated) VALUES(?,?,?,?,?,?,?,?)").run(
        id,
        req.user.id,
        record.title,
        record.duration,
        record.language,
        JSON.stringify(tracks),
        at,
        at,
      );
    } catch (e) {
      if (String(e.message).includes("subtitles_limit"))
        fail(409, `You can keep up to ${MAX_SETS} subtitle sets. Delete one to save another.`, "subtitles_limit");
      throw e;
    }
    res.status(201).json(view(one(id, req.user.id)));
  });

  app.get("/api/subtitles/sets/:id", requireUser, read, (req, res) => res.json(view(one(req.params.id, req.user.id))));

  // Rename, or save the tracks; either or both.
  app.patch("/api/subtitles/sets/:id", requireUser, write, (req, res) => {
    const row = one(req.params.id, req.user.id);
    const record = checked(req.body, true);
    if (!Object.keys(record).length) fail(400, "Send a title or the tracks to save.", "invalid_subtitles");
    const tracks = record.tracks ? finishTracks(record.tracks, row.duration) : null;
    db.prepare("UPDATE subtitle_sets SET title=?,tracks=?,updated=? WHERE id=? AND user_id=?").run(
      record.title ?? row.title,
      tracks ? JSON.stringify(tracks) : row.tracks,
      now(),
      row.id,
      req.user.id,
    );
    res.json(view(one(row.id, req.user.id)));
  });

  app.delete("/api/subtitles/sets/:id", requireUser, write, (req, res) => {
    const r = db.prepare("DELETE FROM subtitle_sets WHERE id=? AND user_id=?").run(String(req.params.id), req.user.id);
    if (!r.changes) fail(404, "Subtitle set not found.", "subtitles_set_not_found");
    res.json({ ok: true });
  });

  // Panic Wipe and account closure: a run that isn't mid-step ends first,
  // so the holds it keeps between steps never block them (nothing more is
  // charged). A step still running blocks them like any request in flight.
  function endFor(user) {
    const run = runOf(user);
    if (run && !run.busy) end(run);
  }
  return { sweep, endFor, runs };
}

