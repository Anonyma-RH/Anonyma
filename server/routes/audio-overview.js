import {
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
import { synthesizeSpeech } from "../audio.js";
import { requestIdentifier } from "../middleware.js";
import { isReleased } from "../releases.js";
import { tagUsage } from "../usage-insights.js";
import { veilMaskedFrom } from "../privacy-trail.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { viewerOf } from "../early-models.js";
import { findSeedPhrase, findPrivateKey, SEED_MESSAGE, KEY_MESSAGE } from "../../src/seed-guard.js";
import {
  LANGUAGES,
  LENGTHS,
  MAX_SOURCE,
  MAX_TITLE,
  MAX_TURN,
  MIN_SOURCE,
  OVERVIEW_PRIVATE,
  OVERVIEW_VEILED,
  SCRIPT_CUT_SHORT,
  SCRIPT_UNUSABLE,
  SOURCE_KINDS,
  hasVeilTags,
  parseScript,
} from "../../src/audio-overview.js";
import { overviewCosts, scriptMessages, stitchClips, voiceCharge } from "../audio-overview.js";

// Audio Overview (update "audiooverview", which needs Voice & Audio too; see
// featuresFor). A document, a saved chat or a Deep Research report becomes a
// two-host script (strict JSON, from a text model), each turn of it is
// voiced with one of two voices, and the clips are joined into one file.
//
// Money: before anything runs, the script's maximum and the voices' maximum
// (the length's character cap at the voice model's price) are held; a run
// that can't hold both is refused with nothing charged. The script settles
// on its actual usage once the model has written it (it was run, whether or
// not it turned out usable). The voices settle once, at the end, on the
// characters actually voiced; a failed turn stops the run and nothing
// further is charged, and whatever was voiced is kept. Workspace only: no
// API key, so no allowance applies; Spending Limits apply to both holds.
//
// Privacy: the source goes to the chosen text model as one "send as data"
// document, and each turn of the script to the voice model. The source is
// never stored or logged. A saved overview is one audio file in the library
// (media) plus its script (audio_overviews), erased and exported with the
// account and deleted with the file. Off the record keeps nothing: the audio
// comes back in the response only.
const BUDGET_CODES = ["insufficient_credits", "spending_limit"];
const DEFAULT_TITLES = { document: "Document", chat: "This chat", research: "Research report" };
const validTokens = (value, fallback) =>
  Number.isSafeInteger(value) && value >= 0 ? value : fallback;
const round = (n) => Math.round(n * 100) / 100;

export function audioOverviewRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight, fallback, audio } = ctx;
  const { getModel } = ctx.models;
  const { saveMedia, assignCosts, mediaJSON } = ctx.media;
  // One overview at a time per account: a run holds its whole maximum.
  const running = new Set();

  // Everything a quote and a run share, checked before anything is held.
  async function prepare(req) {
    const body = req.body || {};
    if (body.treasury != null)
      fail(400, "Audio overviews are paid from your own balance, not a team treasury.", "invalid_request");
    if (body.private === true) fail(400, OVERVIEW_PRIVATE, "overview_private_unavailable");
    if (!Object.hasOwn(LENGTHS, body.length ?? "")) fail(400, "Choose about 3 or about 8 minutes.", "invalid_request");
    const language = body.language ?? "auto";
    if (!LANGUAGES.some(([code]) => code === language)) fail(400, "Choose a language from the list.", "invalid_request");
    const src = body.source;
    if (!src || typeof src !== "object" || !SOURCE_KINDS.includes(src.kind))
      fail(400, "Choose a document, a saved chat or a research report.", "invalid_request");
    const text = typeof src.text === "string" ? src.text.trim() : "";
    if (text.length < MIN_SOURCE)
      fail(400, "This source is too short for an overview. Use one with at least 200 characters.", "overview_source_short");
    if (text.length > MAX_SOURCE)
      fail(400, "This source is longer than 120,000 characters. Use a shorter one, or part of it.", "overview_source_long");
    const title =
      (typeof src.title === "string" ? src.title : "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) ||
      DEFAULT_TITLES[src.kind];
    // Seed Guard, with no override: the source is sent to two providers and
    // the audio of it is kept.
    if (isReleased(cfg, "seedguard")) {
      if (findSeedPhrase(text) || findSeedPhrase(title)) fail(400, SEED_MESSAGE, "seed_phrase_blocked");
      if (findPrivateKey(text)) fail(400, KEY_MESSAGE, "seed_phrase_blocked");
    }
    // Veil runs in the browser, which reports its mask count. A source that
    // still carries placeholders (a saved chat with masked details) would be
    // read aloud with them, so it's refused the same way.
    const veilMasked = veilMaskedFrom(body);
    if (veilMasked > 0 || hasVeilTags(text) || hasVeilTags(title)) fail(400, OVERVIEW_VEILED, "overview_veiled");
    const m = getModel(body.model);
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
    if (m.type !== "chat" || imageCallable(m)) fail(400, "The script needs a text model.", "unsupported_model");
    const tts = await audio.model("tts", String(body.tts || ""));
    ctx.earlyModels.check(viewerOf(req), "tts", tts.id);
    const asked = body.voices && typeof body.voices === "object" ? body.voices : {};
    const voices = { A: asked.A == null ? "" : String(asked.A), B: asked.B == null ? "" : String(asked.B) };
    if (tts.voices?.length) {
      if (![voices.A, voices.B].every((v) => tts.voices.some((x) => x.id === v)))
        fail(400, "Choose two of this voice model's voices.", "invalid_request");
      if (voices.A === voices.B && tts.voices.length > 1)
        fail(400, "Choose a different voice for each host.", "invalid_request");
    } else if (voices.A || voices.B) fail(400, "This voice model has no voices to choose from.", "invalid_request");
    const length = body.length;
    const source = { kind: src.kind, title, text };
    const messages = scriptMessages({ source, length, language });
    ctx.models.validateMessages(messages, m);
    const factor = markupFactor(req.user, cfg);
    const costs = overviewCosts({ cfg, m, tts, messages, length, factor });
    ctx.models.validateContext(messages, m, costs.budget);
    return {
      m,
      tts,
      voices,
      length,
      language,
      source,
      messages,
      costs,
      factor,
      ephemeral: body.ephemeral === true,
      maxTurn: Math.min(MAX_TURN, tts.char_limit || 5000),
    };
  }

  app.post("/api/audio/overview/quote", requireUser, limit("overview_quote", 120, 60000), async (req, res) => {
    const p = await prepare(req);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    // The same maximum with each voice model this account is offered, for
    // the picker: the script's share is the same whichever voices it gets.
    const offered = ctx.earlyModels.view(viewerOf(req), "tts");
    const voiceModels = (await audio.load()).tts
      .filter((t) => !offered.hides(t.id))
      .map((t) => ({
        id: t.id,
        credits: credits(p.costs.amounts.script + voiceCharge(LENGTHS[p.length].maxChars, t, p.factor)),
      }));
    res.json({
      credits: credits(p.costs.total),
      usd: p.costs.total / 1e7,
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      model: p.m.id,
      tts: p.tts.id,
      length: p.length,
      max_characters: LENGTHS[p.length].maxChars,
      source_characters: p.source.text.length,
      steps: { script: credits(p.costs.amounts.script), voices: credits(p.costs.amounts.voices) },
      voice_models: voiceModels,
      estimate: true,
    });
  });

  app.post("/api/audio/overview", requireUser, limit("overview", 4, 60000), async (req, res) => {
    const p = await prepare(req);
    const { m, tts, voices, costs, factor, ephemeral } = p;
    const user = req.user.id;
    const requestId = requestIdentifier(req);
    if (running.has(user))
      fail(409, "An audio overview is already being made. Wait for it, or stop it first.", "overview_running");

    // ---- Hold both maximums before anything runs ----
    const holdId = (step) => `${user}:${requestId}:${step}`;
    const holdAll = (margin) => {
      const made = [];
      try {
        reserve(db, {
          id: holdId("script"),
          user,
          amount: margin ? Math.ceil(costs.amounts.script * cfg.holdMargin) : costs.amounts.script,
          ttl: 45 * 60000,
        });
        made.push(holdId("script"));
        reserve(db, { id: holdId("voices"), user, amount: costs.amounts.voices, kind: "audio", ttl: 45 * 60000 });
        made.push(holdId("voices"));
      } catch (e) {
        // A partly held run is undone completely; none of it ever ran.
        for (const id of made) db.prepare("DELETE FROM holds WHERE id=? AND status='held'").run(id);
        throw e;
      }
    };
    // Published token prices are a floor (see routes/chat.js): hold headroom
    // for the script when the balance and limits allow, else exactly the
    // maximum shown. The voices are priced exactly, per character.
    try {
      holdAll(cfg.holdMargin > 1);
    } catch (e) {
      if (!(cfg.holdMargin > 1) || !BUDGET_CODES.includes(e.code)) throw e;
      holdAll(false);
    }
    // Only what billing needs: a chat request and a speech request.
    tagUsage(db, cfg, holdId("script"), { feature: "chat", model: m.id });
    running.add(user);
    inflight.holds.add(holdId("script"));
    inflight.holds.add(holdId("voices"));

    // ---- Stream progress ----
    res.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    const send = (v) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(v)}\n\n`);
    };
    const controller = new AbortController();
    inflight.controllers.add(controller);
    // Stop (or leaving) cancels the step in flight and every step after it.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
    });
    const stopped = () => controller.signal.aborted;

    // The script: one model call through the same gateway and failover
    // rules as a chat (nothing fails over once the provider accepted it).
    async function writeScript() {
      const step = new AbortController();
      const onStop = () => step.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", onStop, { once: true });
      const timer = setTimeout(() => step.abort(new Error("Provider timeout")), cfg.requestTimeoutMs || 240000);
      inflight.controllers.add(step);
      const upstream = { model: m.id, messages: p.messages, max_tokens: costs.budget };
      let accepted = false,
        route = "primary";
      const markAccepted = () => (accepted = true);
      async function* stream() {
        try {
          yield* chatStream(cfg, upstream, step.signal, markAccepted);
        } catch (e) {
          if (accepted || step.signal.aborted || !FAILOVER_CODES.has(e.code)) throw e;
          const backupModel = await fallback.modelFor(m.id);
          if (!backupModel) throw e;
          route = "backup";
          yield* chatStream(fallback.cfg, { ...upstream, model: backupModel }, step.signal, markAccepted);
        }
      }
      let text = "",
        reasoning = "",
        partUsage = null,
        upstreamCost = null,
        finish = null;
      try {
        for await (const part of stream()) {
          if (part.error) fail(502, part.error.message || "Provider error", "provider_rejected");
          const choice = part.choices?.[0];
          if (typeof choice?.finish_reason === "string") finish = choice.finish_reason;
          const delta = choice?.delta || {};
          if (typeof delta.content === "string") text += delta.content;
          if (typeof delta.reasoning === "string" || typeof delta.reasoning_content === "string")
            reasoning += delta.reasoning || delta.reasoning_content;
          if (part.usage) partUsage = part.usage;
          if (Number.isFinite(part.cost)) upstreamCost = part.cost;
        }
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onStop);
        inflight.controllers.delete(step);
      }
      const input = validTokens(
        partUsage?.prompt_tokens,
        validTokens(partUsage?.input_tokens, Math.ceil(JSON.stringify(p.messages).length / 4)),
      );
      const out = validTokens(
        partUsage?.completion_tokens,
        validTokens(partUsage?.output_tokens, Math.ceil((text + reasoning).length / 4)),
      );
      const fee = route === "backup" ? cfg.gateway2FeePercent : cfg.gatewayFeePercent;
      const dollars = reportedProviderCost(partUsage, upstreamCost, fee) ?? tokenCost(m, input, out);
      return { text, input, out, dollars, finish: finish || "stop" };
    }

    let scriptCharged = 0,
      voicesCharged = 0,
      script = null,
      error = null,
      finishReason = null,
      trimmed = 0;
    const clips = [];
    const voicedChars = () => clips.reduce((n, c) => n + c.chars, 0);
    try {
      send({ overview: { stage: "writing", reserved: credits(costs.total) } });
      // 1. The script. A call that fails, is stopped or never gets an answer
      // is released; a written one is charged on its usage.
      let r;
      try {
        r = await writeScript();
      } catch (e) {
        release(db, holdId("script"));
        throw e;
      }
      finishReason = r.finish;
      const receipt = settle(db, holdId("script"), usdUnits(r.dollars * factor), m.name, {
        model: m.id,
        usage: { prompt_tokens: r.input, completion_tokens: r.out, total_tokens: r.input + r.out },
        finish_reason: r.finish,
      });
      scriptCharged = receipt.charged;
      const parsed = parseScript(r.text, p.length, p.maxTurn);
      if (parsed.problem) {
        // A reply cut off at its budget isn't retried: it would hit the same wall.
        error =
          r.finish === "length"
            ? { message: SCRIPT_CUT_SHORT, code: "overview_script_length" }
            : { message: SCRIPT_UNUSABLE, code: "overview_script_invalid" };
      } else {
        script = { ...parsed.script, title: parsed.script.title || p.source.title };
        trimmed = parsed.trimmed;
        send({
          overview: {
            stage: "script",
            title: script.title,
            chapters: script.chapters,
            turns: script.turns,
            trimmed,
            finish_reason: r.finish,
            credits: credits(scriptCharged),
          },
        });
        // 2. The voices, one turn at a time. A failed turn stops the run.
        for (let i = 0; i < script.turns.length && !stopped(); i++) {
          const turn = script.turns[i];
          try {
            const { bytes, mime } = await synthesizeSpeech(
              cfg,
              { model: tts.id, input: turn.text, voice: voices[turn.speaker] },
              AbortSignal.any([controller.signal, AbortSignal.timeout(120000)]),
            );
            clips.push({ bytes, mime, chars: turn.text.length });
          } catch (e) {
            if (stopped()) break;
            error = {
              message: `The voice model failed on turn ${i + 1} of ${script.turns.length}, so the overview stopped there. What was voiced is kept; nothing further was charged.`,
              code: "overview_voice_failed",
            };
            break;
          }
          send({
            overview: {
              stage: "voiced",
              index: i,
              of: script.turns.length,
              credits: credits(voiceCharge(voicedChars(), tts, factor)),
            },
          });
        }
      }
    } catch (e) {
      // A failure's own message only when it's one of ours (it has a
      // status); anything unexpected gets a plain one.
      if (!stopped())
        error = {
          message: e?.status ? e.message : "The audio overview stopped unexpectedly. Only finished steps were charged.",
          code: e?.status && e.code ? e.code : "overview_failed",
        };
    } finally {
      // The voices: charged once, on the characters actually voiced.
      const chars = voicedChars();
      if (chars)
        voicesCharged = settle(db, holdId("voices"), voiceCharge(chars, tts, factor), "Speech: " + tts.name, {
          model: tts.id,
          characters: chars,
          clips: clips.length,
        }).charged;
      release(db, holdId("script"));
      release(db, holdId("voices"));
      inflight.holds.delete(holdId("script"));
      inflight.holds.delete(holdId("voices"));
      inflight.controllers.delete(controller);
      running.delete(user);
    }
    const charged = scriptCharged + voicesCharged;

    // ---- Keep and answer ----
    let result = null;
    if (script && clips.length) {
      const status = clips.length === script.turns.length ? "complete" : stopped() ? "stopped" : "partial";
      const stitched = stitchClips(clips);
      const voiceName = (id) => tts.voices?.find((v) => v.id === id)?.name || "";
      const record = {
        title: script.title,
        chapters: script.chapters.filter((c) => c.turn < clips.length),
        turns: script.turns
          .slice(0, clips.length)
          .map((t, i) => ({ ...t, start: stitched ? round(stitched.starts[i]) : null })),
        duration: stitched ? round(stitched.duration) : null,
        length: p.length,
        language: p.language,
        source: p.source.kind,
        tts: { id: tts.id, name: tts.name },
        voices: { A: voiceName(voices.A), B: voiceName(voices.B) },
        status,
      };
      if (stitched && !ephemeral) {
        try {
          const media = await saveMedia(user, "audio", stitched.bytes, {
            mime: stitched.mime,
            prompt: script.title,
            model: tts.id,
          });
          assignCosts([media.id], charged, user);
          db.prepare("INSERT INTO audio_overviews(media_id,user_id,title,script,created) VALUES(?,?,?,?,?)").run(
            media.id,
            user,
            script.title,
            JSON.stringify(record),
            now(),
          );
          result = { ...record, saved: true, media: { ...media, cost: credits(charged) } };
        } catch (e) {
          // Kept for this session instead; the charge stands for what was made.
          result = {
            ...record,
            saved: false,
            save_error: e?.status ? e.message : "The audio couldn't be saved to your library.",
            audio: { mime: stitched.mime, data: stitched.bytes.toString("base64") },
          };
        }
      } else if (stitched) {
        result = { ...record, saved: false, audio: { mime: stitched.mime, data: stitched.bytes.toString("base64") } };
      } else {
        // A format that can't simply be joined: the clips, in order, for
        // the browser's playlist player. Nothing is saved.
        result = {
          ...record,
          saved: false,
          clips: clips.map((c) => ({ mime: c.mime, data: c.bytes.toString("base64") })),
        };
      }
    }
    const anonyma = {
      credits_charged: credits(charged),
      steps: { script: credits(scriptCharged), voices: credits(voicesCharged) },
      request_id: requestId,
      ...(finishReason ? { finish_reason: finishReason } : {}),
      ...(trimmed ? { trimmed } : {}),
      ...(cfg.testMode ? { local_test: true } : {}),
      ...(ephemeral ? { ephemeral: { stored: false } } : {}),
    };
    if (error) send({ error, result, anonyma });
    else send({ overview: { stage: "done", status: result?.status || "stopped" }, result, anonyma });
    if (!res.destroyed && !res.writableEnded) res.end("data: [DONE]\n\n");
  });

  // Saved overviews: the list for the Voice studio, and one with its script
  // for the player. Deleting the file (DELETE /api/media/:id) deletes both.
  const SAVED = `SELECT m.*,o.title o_title,o.script o_script,o.created o_created FROM audio_overviews o
    JOIN media m ON m.id=o.media_id WHERE o.user_id=? AND m.user_id=? AND m.expires IS NULL`;
  app.get("/api/audio/overview", requireUser, (req, res) => {
    const rows = db.prepare(SAVED + " ORDER BY o.created DESC,o.rowid DESC LIMIT 120").all(req.user.id, req.user.id);
    res.json({
      data: rows.map((r) => {
        const s = JSON.parse(r.o_script);
        return {
          id: r.id,
          title: r.o_title,
          created: r.o_created,
          duration: s.duration,
          chapters: s.chapters?.length || 0,
          turns: s.turns?.length || 0,
          status: s.status,
          url: "/api/media/" + r.id,
          cost: credits(r.cost),
        };
      }),
    });
  });
  app.get("/api/audio/overview/:id", requireUser, (req, res) => {
    const r = db.prepare(SAVED + " AND o.media_id=?").get(req.user.id, req.user.id, String(req.params.id));
    if (!r) fail(404, "Audio overview not found.", "not_found");
    res.json({ ...JSON.parse(r.o_script), id: r.id, created: r.o_created, saved: true, media: mediaJSON(r) });
  });
}

// Account export: each saved overview's title, script and date (the audio
// itself is listed under media).
export const exportAudioOverviews = (db, user) =>
  db
    .prepare("SELECT media_id,title,script,created FROM audio_overviews WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((r) => ({ media_id: r.media_id, title: r.title, created: r.created, script: JSON.parse(r.script) }));
export const forgetAudioOverviews = (db, user) =>
  db.prepare("DELETE FROM audio_overviews WHERE user_id=?").run(user);
