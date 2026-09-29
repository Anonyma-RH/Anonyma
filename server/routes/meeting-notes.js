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
import { isReleased } from "../releases.js";
import { tagUsage } from "../usage-insights.js";
import { privacyTrail, trailLive, veilMaskedFrom } from "../privacy-trail.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { viewerOf } from "../early-models.js";
import { findSeedPhrase, findPrivateKey, SEED_MESSAGE, KEY_MESSAGE } from "../../src/seed-guard.js";
import {
  MEETING_PRIVATE,
  NOTHING_HEARD,
  NOTE_LANGUAGES,
  SPOKEN,
  checkPlan,
  checkSegments,
  chunkStarts,
  clock,
  fitTranscript,
  notesMarkdown,
  notesMessages,
  readNotes,
} from "../../src/meeting-notes.js";
import { cleanPiece, meetingTestTranscript, notesContextShort, notesPlan, sttCharge, timedLines } from "../meeting-notes.js";

// Meeting Notes (update "meetingnotes", which needs Voice & Audio too; see
// featuresFor). The browser reads a recording, cuts it into pieces of at
// most five minutes and sends each as plain 16 kHz mono PCM to be
// transcribed with a speech model from the audio catalog (the same
// transcribeAudio as /api/audio/transcriptions). The timed transcript then
// goes to a text model that writes the notes as strict JSON.
//
// Money: when a run starts, exactly the maximum the quote shows is held, one
// hold per piece (its length at the model's per-minute price) and one for
// the notes (the prompt with the longest transcript this recording can
// have, plus the whole reply budget), with no extra margin. Each piece
// settles on its own length (or the provider's, if shorter) as it's
// transcribed; a piece that fails is charged nothing and can be retried.
// The notes settle on their usage only when they're usable; notes that
// fail, come back unusable or are cut short are charged nothing and can be
// tried again. Whatever is left is released when the run ends (finished,
// discarded or idle for 30 minutes). Workspace only: no API key, so no
// allowance applies; Spending Limits apply to every hold.
//
// Privacy: the recording's sound goes to the transcription provider; the
// file itself, its name and its metadata never leave the browser, and no
// audio is stored or logged here. A run in progress keeps only its plan and
// holds in memory, never the transcript. The transcript goes to the notes
// model as one "send as data" document (Veil-masked in the browser when
// Veil is on). The transcript and notes are saved as one conversation in
// History (so History, Bookmarks, Export, Share, erase and the account
// export already cover them), or not at all off the record. Private Mode is
// refused: no transcription model offers zero data retention.
const IDLE_MS = 30 * 60000;
const HOLD_TTL = 3 * 3600000;
const MAX_PIECE_BYTES = 10 * 1024 * 1024;
const MAX_NOTE_TRIES = 3;
const PIECE = /^data:audio\/wav;base64,([A-Za-z0-9+/=]+)$/;
const SPOKEN_CODES = SPOKEN.map(([code]) => code);
const validTokens = (value, fallback) => (Number.isSafeInteger(value) && value >= 0 ? value : fallback);
const round2 = (n) => Math.round(n * 100) / 100;

export function meetingNotesRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight, fallback, audio } = ctx;
  const { getModel } = ctx.models;
  // Runs in progress, by id; one per account. Only the plan, the holds and
  // what's been charged: never audio, transcript or notes.
  const runs = new Map();
  const runOf = (user) => [...runs.values()].find((r) => r.user === user);

  // Ends a run: every hold still open is released (nothing more is
  // charged), and the run is forgotten.
  function end(run) {
    for (const piece of run.pieces) if (piece.status !== "done") release(db, piece.hold);
    if (run.notes.status !== "done") release(db, run.notes.hold);
    runs.delete(run.id);
  }
  // Runs nobody has touched for 30 minutes (a closed tab) end; the worker
  // calls this on each tick. A request in flight is never interrupted.
  function sweep(at = now()) {
    for (const run of runs.values()) if (!run.busy && at - run.touched > IDLE_MS) end(run);
  }
  function ownRun(req) {
    const run = runs.get(String(req.params.id));
    if (!run || run.user !== req.user.id) fail(404, "This transcription has ended. Start again from the recording.", "meeting_not_found");
    if (run.busy) fail(409, "A step of this transcription is still running. Wait for it to finish.", "meeting_busy");
    return run;
  }

  // Everything a quote and a start share, checked before anything is held.
  async function prepare(req) {
    const body = req.body || {};
    if (body.auto !== undefined) fail(400, AUTO_NOT_OFFERED, "auto_not_offered");
    if (body.treasury != null)
      fail(400, "Meeting notes are paid from your own balance, not a team treasury.", "invalid_request");
    if (body.private === true) fail(400, MEETING_PRIVATE, "meeting_private_unavailable");
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
    const language = body.notes_language ?? "auto";
    if (!NOTE_LANGUAGES.some(([code]) => code === language))
      fail(400, "Choose a language for the notes from the list.", "invalid_request");
    const m = getModel(body.model);
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
    if (m.type !== "chat" || imageCallable(m)) fail(400, "The notes need a text model.", "unsupported_model");
    const ephemeral = body.ephemeral === true;
    if (ephemeral && body.project != null)
      fail(400, "Off-the-record notes are never saved, so they aren't filed in a project.", "invalid_request");
    const project = !ephemeral && body.project != null ? ctx.projects.forChat(req.user.id, body.project) : null;
    const factor = markupFactor(req.user, cfg);
    const starts = chunkStarts(seconds);
    const pieces = seconds.map((s, i) => ({ index: i, start: starts[i], seconds: s, amount: sttCharge(s, stt, factor) }));
    const plan = notesPlan({ cfg, m, duration, language, factor });
    ctx.models.validateMessages(plan.messages, m);
    if (notesContextShort(plan, duration))
      fail(400, `${m.name} can't take a meeting transcript. Pick a model with a longer context.`, "notes_context");
    const transcription = pieces.reduce((n, p) => n + p.amount, 0);
    return { duration, stt, spoken, language, m, ephemeral, project, factor, pieces, plan, transcription, total: transcription + plan.amount };
  }

  app.post("/api/meeting-notes/quote", requireUser, limit("meeting_quote", 120, 60000), async (req, res) => {
    const p = await prepare(req);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(p.total),
      usd: p.total / 1e7,
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      steps: { transcription: credits(p.transcription), notes: credits(p.plan.amount) },
      pieces: p.pieces.length,
      minutes: round2(p.duration / 60),
      credits_per_minute: credits(usdUnits(p.stt.pricing.api_price * p.factor)),
      stt: { id: p.stt.id, name: p.stt.name, provider: p.stt.provider || null },
      model: p.m.id,
      reply_budget: p.plan.budget,
      max_transcript_characters: p.plan.maxChars,
      covers_seconds: p.plan.covers,
      estimate: true,
    });
  });

  app.post("/api/meeting-notes", requireUser, limit("meeting_start", 6, 60000), async (req, res) => {
    sweep();
    const p = await prepare(req);
    const user = req.user.id;
    const requestId = requestIdentifier(req);
    // A new run replaces this account's earlier one: whatever it still held
    // is released (its finished pieces stay charged).
    const earlier = runOf(user);
    if (earlier?.busy) fail(409, "A transcription is already running. Wait for it, or stop it first.", "meeting_running");
    if (earlier) end(earlier);
    const holdId = (step) => `${user}:${requestId}:${step}`;
    // Exactly the maximum the quote shows: each piece, then the notes.
    const made = [];
    try {
      for (const piece of p.pieces) {
        reserve(db, { id: holdId("p" + piece.index), user, amount: piece.amount, kind: "audio", ttl: HOLD_TTL });
        made.push(holdId("p" + piece.index));
      }
      reserve(db, { id: holdId("notes"), user, amount: p.plan.amount, ttl: HOLD_TTL });
      made.push(holdId("notes"));
    } catch (e) {
      // A partly held run is undone completely; none of it ever ran.
      for (const id of made) db.prepare("DELETE FROM holds WHERE id=? AND status='held'").run(id);
      throw e;
    }
    // Off the record, only what billing already shows (a chat request).
    tagUsage(db, cfg, holdId("notes"), { feature: p.ephemeral ? "chat" : "meeting_notes", model: p.m.id });
    const run = {
      id: uid("mn_"),
      user,
      requestId,
      duration: p.duration,
      stt: p.stt,
      spoken: p.spoken,
      language: p.language,
      model: p.m.id,
      ephemeral: p.ephemeral,
      project: p.project?.id || null,
      factor: p.factor,
      plan: { budget: p.plan.budget, maxChars: p.plan.maxChars, maxBytes: p.plan.maxBytes },
      pieces: p.pieces.map((piece) => ({ ...piece, hold: holdId("p" + piece.index), status: "open", charged: 0 })),
      notes: { hold: holdId("notes"), amount: p.plan.amount, status: "open", tries: 0 },
      busy: false,
      touched: now(),
    };
    runs.set(run.id, run);
    res.status(201).json({
      id: run.id,
      pieces: run.pieces.map((x) => ({ index: x.index, start: x.start, seconds: x.seconds })),
      reserved: credits(p.total),
      steps: { transcription: credits(p.transcription), notes: credits(p.plan.amount) },
      stt: { id: p.stt.id, name: p.stt.name, provider: p.stt.provider || null },
      idle_minutes: IDLE_MS / 60000,
    });
  });

  // One piece: transcribed, then charged for its length. A failed piece is
  // charged nothing and stays open for a retry.
  app.post("/api/meeting-notes/:id/pieces/:index", requireUser, limit("meeting_piece", 60, 60000), async (req, res) => {
    const run = ownRun(req);
    const piece = run.pieces[Number(req.params.index)];
    if (!piece || !/^\d+$/.test(req.params.index)) fail(404, "There's no such piece in this recording.", "not_found");
    if (piece.status === "done") fail(409, "This piece is already transcribed.", "piece_done");
    const match = typeof req.body?.audio === "string" ? PIECE.exec(req.body.audio) : null;
    if (!match) fail(400, "Send the piece as a base64 WAV data URL.", "invalid_audio");
    const raw = Buffer.from(match[1], "base64");
    if (!raw.length || raw.length > MAX_PIECE_BYTES) fail(400, "Each piece must be under 10 MB.", "invalid_audio");
    const { bytes, seconds } = cleanPiece(raw);
    if (Math.abs(seconds - piece.seconds) > 0.05)
      fail(400, "This piece isn't the length the recording was planned with. Start again from the recording.", "invalid_audio");
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
          ? meetingTestTranscript({ start: piece.start, seconds })
          : await transcribeAudio(
              cfg,
              { model: run.stt.id, bytes, mime: "audio/wav", language: run.spoken, timestamps: true },
              AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]),
            );
        probe.done(!!r.text?.trim());
      } catch (e) {
        probe.fail(e, controller.signal);
        if (controller.signal.aborted) fail(400, "Stopped. Nothing was charged for this piece.", "piece_stopped");
        // Ours has a status (a provider refusal); anything else, a plain one.
        fail(e?.status || 502, `${e?.status ? e.message : "The transcription provider couldn't be reached."} Nothing was charged for this piece.`, e?.code || "provider_down");
      }
      // The provider's timings (a coarse line cut by its word timings), else
      // the whole piece as one line marked untimed, and any line the
      // provider couldn't time finely marked so too; never outside the
      // piece, then placed in the recording.
      const segments = timedLines(Array.isArray(r.segments) ? r.segments : [], r.text, seconds).map((s) => ({
        start: round2(piece.start + Math.min(seconds, s.start)),
        end: round2(piece.start + Math.min(seconds, Math.max(s.start, s.end))),
        text: s.text,
        ...(s.speaker ? { speaker: s.speaker } : {}),
        ...(s.untimed ? { untimed: true } : {}),
      }));
      // Charged for the piece's own length, or the provider's if shorter.
      const billed = Number.isFinite(r.duration) && r.duration >= 0 ? Math.min(seconds, r.duration) : seconds;
      const receipt = settle(db, piece.hold, sttCharge(billed, run.stt, run.factor), "Transcription: " + run.stt.name, {
        model: run.stt.id,
        seconds: round2(billed),
      });
      piece.status = "done";
      piece.charged = receipt.charged;
      const charged = run.pieces.reduce((n, x) => n + x.charged, 0);
      res.json({
        index: piece.index,
        segments,
        seconds: round2(billed),
        credits: credits(receipt.charged),
        charged: credits(charged),
        done: run.pieces.filter((x) => x.status === "done").length,
        of: run.pieces.length,
        ...(cfg.testMode ? { local_test: true } : {}),
      });
    } finally {
      inflight.holds.delete(piece.hold);
      inflight.controllers.delete(controller);
      run.busy = false;
      run.touched = now();
    }
  });

  // The notes, from the transcript the browser sends (Veil-masked when Veil
  // is on). Transcription is over: pieces not transcribed are released.
  // `skip_notes` saves the transcript alone and charges nothing more.
  app.post("/api/meeting-notes/:id/finish", requireUser, limit("meeting_finish", 12, 60000), async (req, res) => {
    const run = ownRun(req);
    const body = req.body || {};
    const user = req.user.id;
    for (const piece of run.pieces)
      if (piece.status === "open") {
        release(db, piece.hold);
        piece.status = "released";
      }
    if (!run.pieces.some((x) => x.status === "done")) {
      end(run);
      fail(400, "No part of the recording was transcribed, so there's nothing to make notes from. Nothing more was charged.", "meeting_empty");
    }
    let segments;
    try {
      segments = checkSegments(body.segments, run.duration);
    } catch (e) {
      fail(400, e.message, "invalid_transcript");
    }
    if (!segments.length) {
      end(run);
      fail(400, NOTHING_HEARD, "meeting_empty");
    }
    const all = segments.map((s) => s.text).join("\n");
    // Seed Guard, with no override: the transcript would go to a model and
    // be kept. The browser keeps it for export; nothing more is charged.
    if (isReleased(cfg, "seedguard") && (findSeedPhrase(all) || findPrivateKey(all))) {
      end(run);
      fail(400, (findSeedPhrase(all) ? SEED_MESSAGE : KEY_MESSAGE) + " Your transcript is kept here for export; no notes were made.", "seed_phrase_blocked");
    }
    const veilMasked = veilMaskedFrom(body);
    const headings = body.headings === "zh" ? "zh" : "en";
    const skip = body.skip_notes === true;
    const m = getModel(run.model);
    const fitted = fitTranscript(segments, run.duration, { maxChars: run.plan.maxChars, maxBytes: run.plan.maxBytes });
    const messages = notesMessages({ text: fitted.text, duration: run.duration, language: run.language });
    if (!skip) {
      ctx.models.validateMessages(messages, m);
      ctx.models.validateContext(messages, m, run.plan.budget);
    }
    run.busy = true;
    run.touched = now();
    inflight.holds.add(run.notes.hold);

    // ---- Stream progress ----
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.flushHeaders();
    const send = (v) => {
      if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(v)}\n\n`);
    };
    const controller = new AbortController();
    inflight.controllers.add(controller);
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
    });

    // The notes: one model call through the same gateway and failover rules
    // as a chat (nothing fails over once the provider accepted it).
    async function writeNotes() {
      const step = new AbortController();
      const onStop = () => step.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", onStop, { once: true });
      const timer = setTimeout(() => step.abort(new Error("Provider timeout")), cfg.requestTimeoutMs || 240000);
      inflight.controllers.add(step);
      const upstream = { model: m.id, messages, max_tokens: run.plan.budget };
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
      // Model Status: the notes call's outcome and timings, like a chat's.
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
          if (part.usage) partUsage = part.usage;
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
      const input = validTokens(partUsage?.prompt_tokens, validTokens(partUsage?.input_tokens, Math.ceil(JSON.stringify(messages).length / 4)));
      const out = validTokens(partUsage?.completion_tokens, validTokens(partUsage?.output_tokens, Math.ceil((text + reasoning).length / 4)));
      const fee = route === "backup" ? cfg.gateway2FeePercent : cfg.gatewayFeePercent;
      const dollars = reportedProviderCost(partUsage, upstreamCost, fee) ?? tokenCost(m, input, out);
      return { text, input, out, dollars, route, finish: finish || "stop" };
    }

    let notes = null,
      notesCharged = 0,
      error = null,
      finishReason = null,
      route = "primary",
      dropped = 0;
    try {
      if (!skip) {
        send({ meeting: { stage: "writing", lines: fitted.lines, cut_at: fitted.cutAt } });
        run.notes.tries++;
        let r;
        try {
          r = await writeNotes();
        } catch (e) {
          // Failed, stopped or never answered: nothing is charged, and the
          // hold stays for another try.
          if (controller.signal.aborted) throw e;
          error = {
            message: `${e?.status ? e.message : "The notes model couldn't be reached."} Nothing was charged for the notes. Your transcript is kept here.`,
            code: e?.status && e.code ? e.code : "notes_failed",
          };
        }
        if (r) {
          finishReason = r.finish;
          route = r.route;
          const read = readNotes(r.text, r.finish, { transcript: fitted.text, duration: run.duration, timed: fitted.timed });
          if (read.notes) {
            // Usable: charged on its usage (never above what's held).
            const receipt = settle(db, run.notes.hold, usdUnits(r.dollars * run.factor), m.name, {
              model: m.id,
              usage: { prompt_tokens: r.input, completion_tokens: r.out, total_tokens: r.input + r.out },
              finish_reason: r.finish,
            });
            run.notes.status = "done";
            notesCharged = receipt.charged;
            notes = read.notes;
            dropped = read.dropped;
          } else {
            // You pay only for results you get: unusable notes are charged
            // nothing, and the hold stays for another try.
            error = { message: read.message, code: read.code };
          }
        }
      }
    } catch (e) {
      if (!controller.signal.aborted)
        error = { message: "The notes stopped unexpectedly. Nothing was charged for them.", code: "notes_failed" };
    } finally {
      inflight.holds.delete(run.notes.hold);
      inflight.controllers.delete(controller);
      run.busy = false;
      run.touched = now();
    }
    const stopped = controller.signal.aborted;
    const transcription = run.pieces.reduce((n, x) => n + x.charged, 0);
    const trail = trailLive(cfg);
    const storage = run.ephemeral ? "off_the_record" : "saved";
    const privacy = trail
      ? {
          transcription: privacyTrail(cfg, {
            model: { id: run.stt.id, owned_by: run.stt.provider },
            route: "primary",
            zeroDataRetention: false,
            storage,
            receiptId: null,
          }),
          ...(notes
            ? { notes: privacyTrail(cfg, { model: m, route, zeroDataRetention: false, storage, veilMasked, receiptId: null }) }
            : {}),
        }
      : null;

    // ---- Keep and answer ----
    // Kept once there's something to keep: the notes, or the transcript on
    // its own when asked. Off the record, nothing is.
    let conversation = null;
    const title = (notes?.title || "").trim() || (headings === "zh" ? "会议纪要" : "Meeting notes");
    if ((notes || skip) && !stopped && !run.ephemeral) {
      try {
        const markdown = notesMarkdown({
          title,
          duration: run.duration,
          notes,
          segments,
          stt: run.stt.name,
          model: m.name,
          lang: headings,
          cutAt: notes ? fitted.cutAt : null,
        });
        conversation = ctx.conversations.newConversation(user, title.slice(0, 70), "chat");
        if (run.project) ctx.projects.file(conversation, run.project, user);
        const asked = headings === "zh" ? `会议纪要 · ${clock(run.duration)} 录音` : `Meeting notes · ${clock(run.duration)} recording`;
        db.prepare(
          "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
        ).run(uid("m_"), conversation, "user", JSON.stringify(asked), m.id, 0, now(), user);
        const saved = {
          text: markdown,
          reasoning: "",
          images: [],
          finish_reason: notes ? finishReason : "stop",
          request_id: run.requestId,
          ...(privacy?.notes ? { privacy: privacy.notes } : {}),
          // What the Meeting notes page needs to reopen it: never audio.
          meeting: {
            version: 1,
            title,
            duration: run.duration,
            stt: { id: run.stt.id, name: run.stt.name, provider: run.stt.provider || null },
            model: notes ? { id: m.id, name: m.name } : null,
            notes,
            cut_at: notes ? fitted.cutAt : null,
            headings,
            credits: credits(transcription + notesCharged),
          },
        };
        db.prepare(
          "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
        ).run(uid("m_"), conversation, "assistant", JSON.stringify(saved), m.id, transcription + notesCharged, now(), user);
        db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(now(), conversation);
      } catch {
        conversation = null;
        error ||= { message: "The notes couldn't be saved to History. They're here to export.", code: "save_failed" };
      }
    }
    // Done when there's a result, or when it was stopped; a failed try keeps
    // the run (and the notes' hold) for another, up to three tries.
    const retry = !notes && !skip && !stopped && run.notes.tries < MAX_NOTE_TRIES;
    if (!retry && runs.has(run.id)) end(run);
    const anonyma = {
      credits_charged: credits(transcription + notesCharged),
      steps: { transcription: credits(transcription), notes: credits(notesCharged) },
      request_id: run.requestId,
      ...(finishReason ? { finish_reason: finishReason } : {}),
      ...(privacy ? { privacy } : {}),
      ...(cfg.testMode ? { local_test: true } : {}),
      ...(run.ephemeral ? { ephemeral: { stored: false } } : {}),
    };
    const result = {
      title: notes ? title : null,
      notes,
      saved: !!conversation,
      conversationId: conversation,
      cut_at: notes ? fitted.cutAt : null,
      // How many transcript lines the notes model read (all of them, unless
      // cut_at says where it stopped).
      lines_sent: notes ? fitted.lines : null,
      owners_dropped: dropped,
      skipped: skip,
    };
    if (error) send({ error: { ...error, retry }, result, anonyma });
    else send({ meeting: { stage: "done" }, result, anonyma });
    if (!res.destroyed && !res.writableEnded) res.end("data: [DONE]\n\n");
  });

  // Discard: everything still held is released, and the run ends.
  app.delete("/api/meeting-notes/:id", requireUser, limit("meeting_end", 30, 60000), (req, res) => {
    const run = runs.get(String(req.params.id));
    if (!run || run.user !== req.user.id) return res.json({ ended: true, credits_charged: 0 });
    if (run.busy) fail(409, "A step of this transcription is still running. Wait for it to finish.", "meeting_busy");
    const charged = run.pieces.reduce((n, x) => n + x.charged, 0);
    end(run);
    res.json({ ended: true, credits_charged: credits(charged) });
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
