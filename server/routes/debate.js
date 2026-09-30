import {
  uid,
  now,
  fail,
  credits,
  usdUnits,
  balance,
  reserve,
  settle,
  release,
  imageCallable,
  markupFactor,
  transaction,
} from "../core.js";
import { requestIdentifier } from "../middleware.js";
import { isPrivateModel } from "../private-mode.js";
import { isReleased } from "../releases.js";
import { tagUsage } from "../usage-insights.js";
import { privacyTrail, storageFor, trailLive, veilMaskedFrom } from "../privacy-trail.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { viewerOf } from "../early-models.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import { isSealedModel } from "../../src/sealed.js";
import {
  LANGS,
  checkSetup,
  cleanTurn,
  judgeMessages,
  judgeText,
  parseVerdict,
  questionText,
  titleFor,
  turnMessages,
  turnText,
} from "../../src/debate.js";
import { researchCaller } from "../research.js";
import { debateCosts } from "../debate.js";

// Model Debate (update "debate", which runs on Symposium's models and
// billing, so it needs "symposium" too; see featuresFor). One question, two
// models arguing it in rounds (Side A then Side B in each: an opening,
// rebuttals, a closing) and, optionally, a third model that judges it.
//
// Each turn is one model call on the transcript so far, made through the
// same gateway, failover and zero-data-retention rules as a chat
// (server/research.js researchCaller, shared with Deep Research), with a
// word limit in the prompt and a hard character limit on what is kept, so
// what a turn adds to later requests is bounded. Turns run one at a time, in
// order, and stream as they are written.
//
// Money: /api/debate/quote prices every step (each turn on its own model and
// the judge) on the largest request it could send. A run holds each step's
// maximum before anything is sent, exactly the quoted total and no more (the
// run is refused with 409 estimate_changed if the page's figure is any
// other), so the maximum shown, the balance and Spending Limits checks and
// the holds are one number. Each step settles on its own usage as it
// finishes. A turn that fails, comes back empty, is cut off with nothing
// usable, is stopped or never starts is released; the debate stops at the
// first turn that can't be used, and the turns and the judge after it are
// released too, so only turns that finished are charged. A judge whose reply
// can't be read is released and charges nothing. Workspace only, from the
// account's own balance: no API key, so no allowance applies.
//
// Blind judging: the judge is sent the question, the positions and the
// transcript labelled by side (A and B), with the debaters' model names taken
// out of the turns' own text. It never sees a model name.
//
// Privacy: the question (masked by Veil in the browser when it's on) and the
// turns go to the chosen models, nothing else, and nothing is logged. Seed
// Guard checks the question and positions. Private Mode uses zero-data-
// retention models only, with ZDR routing and no failover, and keeps
// nothing. Off the record keeps nothing. Otherwise the finished turns and
// the judge's summary are saved as one ordinary conversation (the question,
// then one reply per turn under its own model, then the judge), so History,
// Bookmarks, Export, Share a Chat, erase and the account export already
// cover it. Never saved: the models' hidden reasoning, a Veil map.
export const DEBATE_CHANGED =
  "The estimate changed since it was shown. Check the new one, then start the debate again. Nothing was charged.";
export const DEBATE_EMPTY = "The model returned nothing for this turn, so it wasn't charged. The debate stopped here.";
export const DEBATE_LENGTH =
  "The model ran out of room before it wrote this turn, so it wasn't charged. The debate stopped here.";
export const DEBATE_FAILED = "This turn couldn't be written, so it wasn't charged. The debate stopped here.";
export const JUDGE_LENGTH =
  "The judge ran out of room before it finished, so there's no summary. The judge wasn't charged.";
export const JUDGE_UNUSABLE = "The judge's reply couldn't be read, so there's no summary. The judge wasn't charged.";
export const JUDGE_FAILED = "The judge couldn't answer, so there's no summary. The judge wasn't charged.";
// Fields a debate never takes: it is only the question, the two sides and the
// judge.
const CONTEXT_FIELDS = [
  "auto",
  "messages",
  "conversationId",
  "project",
  "files",
  "memory",
  "instructions",
  "documents",
  "web_search",
  "plugins",
  "mode",
  "compare",
  "study",
  "sheets",
  "catchup",
  "canvas",
  "slides",
  "models",
  "model",
  "depth",
  "treasury",
  "translate",
  "passages",
];

export function debateRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight } = ctx;
  const { getModel } = ctx.models;
  const { newConversation } = ctx.conversations;
  // One run at a time per account (a run holds its whole maximum): the run's
  // request id and its controller, for Stop.
  const running = new Map();

  // One chosen model, checked the way a chat checks it.
  function chosen(req, id, what, isPrivate) {
    if (typeof id !== "string" || !id) fail(400, `Choose ${what}.`, "invalid_request");
    const m = getModel(id);
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
    if (m.type !== "chat" || imageCallable(m)) fail(400, "Debate needs text models.", "unsupported_model");
    if (isSealedModel(m))
      fail(400, "Sealed Mode models can't join a debate: they only take requests sealed in your browser. Choose another model.", "unsupported_model");
    if (isPrivate && !isPrivateModel(m, cfg)) fail(400, "Private mode needs a model with zero data retention.", "private_model_required");
    return m;
  }

  // What a quote and a run share: no chat options, the setup, the models,
  // Private Mode and the account's rate, and every step priced.
  function prepare(req) {
    const body = req.body || {};
    for (const key of CONTEXT_FIELDS)
      if (body[key] !== undefined && body[key] !== null)
        fail(400, "A debate takes only a question, two models and an optional judge, so it can't be combined with other chat options.", "invalid_request");
    let setup;
    try {
      setup = checkSetup(body);
    } catch (e) {
      fail(400, e.message, "invalid_debate");
    }
    const isPrivate = body.private === true;
    const models = {
      a: chosen(req, body.model_a, "a model for Side A", isPrivate),
      b: chosen(req, body.model_b, "a model for Side B", isPrivate),
      judge: body.judge_model == null || body.judge_model === "" ? null : chosen(req, body.judge_model, "a judge model", isPrivate),
    };
    const ephemeral = body.ephemeral === true || isPrivate;
    const lang = LANGS.includes(body.lang) ? body.lang : "en";
    const factor = markupFactor(req.user, cfg);
    const cost = debateCosts({ cfg, models, setup, factor });
    for (const step of cost.steps) ctx.models.validateContext(step.messages, step.model, step.budget);
    return { body, setup, models, isPrivate, ephemeral, lang, factor, cost };
  }

  // Quoting holds, sends and stores nothing.
  app.post("/api/debate/quote", requireUser, limit("debate_quote", 120, 60000), (req, res) => {
    const { models, cost } = prepare(req);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    const judge = cost.steps.find((s) => s.kind === "judge");
    res.json({
      credits: credits(cost.total),
      units: cost.total,
      // Each turn's maximum in order, and the judge's.
      turns: cost.steps.filter((s) => s.kind === "turn").map((s) => ({ n: s.n, side: s.side, credits: credits(s.amount) })),
      judge: judge ? credits(judge.amount) : null,
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      models: { a: models.a.id, b: models.b.id, judge: models.judge?.id ?? null },
      estimate: true,
    });
  });

  // Stop: the turn in flight, and every step after it, are released; the
  // stream then reports what finished (and saves it), so nothing charged
  // goes unseen.
  app.post("/api/debate/stop", requireUser, limit("debate_stop", 60, 60000), (req, res) => {
    const run = running.get(req.user.id);
    const id = req.body?.requestId;
    if (id !== undefined && typeof id !== "string") fail(400, "requestId must be text.", "invalid_request");
    const stop = !!run && (id === undefined || id === run.requestId);
    if (stop) run.controller.abort(new Error("Stopped"));
    res.json({ stopped: stop });
  });

  app.post("/api/debate", requireUser, limit("debate", 10, 60000), async (req, res) => {
    const { body, setup, models, isPrivate, ephemeral, lang, factor, cost } = prepare(req);
    // Seed Guard, with the chat's own "Send anyway" (allow_seed_phrase, gated
    // in featuresFor): a question or position holding a wallet recovery
    // phrase is refused before anything is held.
    if (
      isReleased(cfg, "seedguard") &&
      body.allow_seed_phrase !== true &&
      [setup.question, setup.stances.a, setup.stances.b].some((t) => t && findSeedPhrase(t))
    )
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    const veilMasked = veilMaskedFrom(body);
    // The shown maximum is what's held: a page showing another figure (an
    // old quote) is refused, and quotes again.
    if (body.max_units !== cost.total) fail(409, DEBATE_CHANGED, "estimate_changed");
    const user = req.user.id;
    const requestId = requestIdentifier(req);
    if (running.has(user)) fail(409, "A debate is already running. Wait for it, or stop it first.", "debate_running");
    const storage = storageFor({ api: false, isPrivate, ephemeral });

    // ---- Hold every step's maximum, exactly ----
    const holdId = (step) => `${user}:${requestId}:${step.key}`;
    const made = [];
    try {
      for (const step of cost.steps) {
        reserve(db, { id: holdId(step), user, amount: step.amount, ttl: 90 * 60000 });
        made.push(holdId(step));
      }
    } catch (e) {
      // A partly held run is undone completely; none of it ever ran.
      for (const id of made) db.prepare("DELETE FROM holds WHERE id=? AND status='held'").run(id);
      throw e;
    }
    const open = new Set(made);
    for (const step of cost.steps) {
      // Off the record and in Private Mode only what billing reflects.
      tagUsage(db, cfg, holdId(step), { feature: ephemeral ? "chat" : "debate", model: step.model.id });
      inflight.holds.add(holdId(step));
    }
    const controller = new AbortController();
    running.set(user, { requestId, controller });
    inflight.controllers.add(controller);
    const stopped = () => controller.signal.aborted;
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
    // Stop (POST /api/debate/stop, or leaving) cancels the turn in flight
    // and every step after it.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
    });

    let charged = 0;
    // One caller per model (the same model on both sides shares one).
    const callers = new Map();
    const callerFor = (m) => {
      if (!callers.has(m.id)) callers.set(m.id, researchCaller(ctx, { m, isPrivate, controller }));
      return callers.get(m.id);
    };
    const settleStep = (step, r) => {
      const receipt = settle(db, holdId(step), usdUnits(r.dollars * factor), step.model.name, {
        model: step.model.id,
        usage: { prompt_tokens: r.input, completion_tokens: r.out, total_tokens: r.input + r.out },
        finish_reason: r.finish || "stop",
      });
      open.delete(holdId(step));
      charged += receipt.charged;
      return receipt;
    };
    const releaseStep = (step) => {
      release(db, holdId(step));
      open.delete(holdId(step));
    };
    const unusable = (message, code) => Object.assign(Error(message), { status: 502, code });
    const trailOf = (step, r) =>
      trailLive(cfg)
        ? privacyTrail(cfg, { model: step.model, route: r.route, zeroDataRetention: isPrivate, storage, veilMasked, receiptId: null })
        : null;

    // ---- Run ----
    const finished = []; // { n, side, round, role, text, model, credits, ... }
    let verdict = null,
      judgeRecord = null,
      failure = null;
    const turnSteps = cost.steps.filter((s) => s.kind === "turn");
    const judgeStep = cost.steps.find((s) => s.kind === "judge");
    try {
      send({
        debate: {
          stage: "started",
          turns: turnSteps.map((s) => ({ n: s.n, side: s.side, round: s.round, role: s.role, model: s.model.id })),
          judge: judgeStep ? { model: judgeStep.model.id } : null,
          reserved: credits(cost.total),
        },
      });
      for (const step of turnSteps) {
        if (stopped()) break;
        send({ debate: { stage: "turn", n: step.n, status: "speaking" } });
        try {
          const messages = turnMessages({ setup, turns: finished, next: step });
          const r = await callerFor(step.model).call(messages, step.budget, false, (text) =>
            send({ debate: { stage: "delta", n: step.n, text } }),
          );
          if (stopped()) throw controller.signal.reason || Error("Stopped");
          const turn = cleanTurn(r.text, r.finish);
          if (!turn.text) throw unusable(r.finish === "length" ? DEBATE_LENGTH : DEBATE_EMPTY, r.finish === "length" ? "debate_length" : "debate_empty");
          const receipt = settleStep(step, r);
          const record = {
            n: step.n,
            side: step.side,
            round: step.round,
            role: step.role,
            model: step.model.id,
            text: turn.text,
            trimmed: turn.trimmed,
            cut_short: turn.cut,
            credits: receipt.credits_charged,
            charged: receipt.charged,
            usage: { prompt_tokens: r.input, completion_tokens: r.out, total_tokens: r.input + r.out },
            finish_reason: r.finish || "stop",
            privacy: trailOf(step, r),
          };
          finished.push(record);
          send({
            debate: {
              stage: "turn",
              n: step.n,
              status: "done",
              text: turn.text,
              credits: receipt.credits_charged,
              ...(turn.cut ? { cut_short: true } : {}),
              ...(turn.trimmed ? { trimmed: true } : {}),
              ...(record.privacy ? { privacy: record.privacy } : {}),
            },
          });
        } catch (e) {
          releaseStep(step);
          if (stopped()) {
            send({ debate: { stage: "turn", n: step.n, status: "stopped" } });
            break;
          }
          // Our own refusals say why; anything else gets a plain message.
          const known = e?.status && e.code && String(e.code).startsWith("debate_");
          failure = { message: known ? e.message : DEBATE_FAILED, code: known ? e.code : "debate_failed" };
          send({ debate: { stage: "turn", n: step.n, status: "failed", ...failure } });
          break;
        }
      }
      // The judge reads the whole debate, so it runs only when every turn
      // finished. A reply it can't read is released, uncharged.
      if (judgeStep && !failure && !stopped() && finished.length === turnSteps.length) {
        send({ debate: { stage: "judge", status: "judging" } });
        try {
          const names = [models.a, models.b].flatMap((m) => [m.name, m.id, String(m.id).split("/").pop()]);
          const messages = judgeMessages({ setup, turns: finished, names });
          const r = await callerFor(judgeStep.model).call(messages, judgeStep.budget, false);
          if (stopped()) throw controller.signal.reason || Error("Stopped");
          const read = parseVerdict(r.text, { format: setup.format });
          if (!read.verdict)
            throw unusable(r.finish === "length" ? JUDGE_LENGTH : JUDGE_UNUSABLE, r.finish === "length" ? "debate_judge_length" : "debate_judge_unusable");
          const receipt = settleStep(judgeStep, r);
          verdict = read.verdict;
          judgeRecord = {
            model: judgeStep.model.id,
            credits: receipt.credits_charged,
            charged: receipt.charged,
            usage: { prompt_tokens: r.input, completion_tokens: r.out, total_tokens: r.input + r.out },
            finish_reason: r.finish || "stop",
            privacy: trailOf(judgeStep, r),
          };
          send({
            debate: {
              stage: "judge",
              status: "done",
              verdict,
              credits: receipt.credits_charged,
              ...(judgeRecord.privacy ? { privacy: judgeRecord.privacy } : {}),
            },
          });
        } catch (e) {
          releaseStep(judgeStep);
          if (stopped()) send({ debate: { stage: "judge", status: "stopped" } });
          else {
            const known = e?.status && e.code && String(e.code).startsWith("debate_");
            failure = { message: known ? e.message : JUDGE_FAILED, code: known ? e.code : "debate_judge_failed" };
            send({ debate: { stage: "judge", status: "failed", ...failure } });
          }
        }
      }
    } finally {
      for (const id of open) release(db, id);
      open.clear();
      for (const id of made) inflight.holds.delete(id);
      inflight.controllers.delete(controller);
      running.delete(user);
    }

    // ---- Keep and answer ----
    let conversation = null;
    if (!ephemeral && finished.length) {
      try {
        conversation = transaction(db, () => {
          const id = newConversation(user, titleFor(setup.question, lang), "chat");
          const insert = db.prepare(
            "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
          );
          const at = now();
          let i = 0;
          // The question first, as the person asked it (with each side's
          // position when it was a debate between two positions).
          insert.run(uid("m_"), id, "user", JSON.stringify(questionText(setup, lang)), models.a.id, 0, at + i++, user);
          for (const t of finished) {
            const saved = {
              text: turnText(t, setup, lang),
              reasoning: "",
              images: [],
              usage: t.usage,
              finish_reason: t.finish_reason,
              debate: {
                v: 1,
                kind: "turn",
                n: t.n,
                side: t.side,
                round: t.round,
                role: t.role,
                of: turnSteps.length,
                judge: !!judgeStep,
                turn_chars: t.text.length,
                credits: t.credits,
                ...(t.cut_short ? { cut_short: true } : {}),
                ...(t.trimmed ? { trimmed: true } : {}),
                // The first turn also carries the setup, so a reload can
                // rebuild the page (the question as the server saw it).
                ...(t.n === 1 ? { question: setup.question, format: setup.format, stances: setup.stances, rounds: setup.rounds } : {}),
              },
              ...(t.privacy ? { privacy: t.privacy } : {}),
            };
            insert.run(uid("m_"), id, "assistant", JSON.stringify(saved), t.model, t.charged, at + i++, user);
          }
          if (verdict) {
            const saved = {
              text: judgeText(verdict, setup, lang),
              reasoning: "",
              images: [],
              usage: judgeRecord.usage,
              finish_reason: judgeRecord.finish_reason,
              debate: { v: 1, kind: "judge", credits: judgeRecord.credits, verdict },
              ...(judgeRecord.privacy ? { privacy: judgeRecord.privacy } : {}),
            };
            insert.run(uid("m_"), id, "assistant", JSON.stringify(saved), judgeRecord.model, judgeRecord.charged, at + i++, user);
          }
          db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(now(), id);
          return id;
        });
      } catch (e) {
        // Everything was charged for and shown; only the copy in History is
        // missing, and the page says so.
        console.error("Debate not saved:", e.message);
      }
    }
    const status = stopped() ? "stopped" : failure || finished.length < turnSteps.length ? "partial" : "done";
    send({
      debate: {
        stage: "done",
        status,
        turns_done: finished.length,
        turns_planned: turnSteps.length,
        judged: !!verdict,
        credits_charged: credits(charged),
        saved: !!conversation,
      },
      conversationId: conversation,
      anonyma: {
        credits_charged: credits(charged),
        request_id: requestId,
        stored: !!conversation,
        ...(cfg.testMode ? { local_test: true } : {}),
        ...(isPrivate ? { private: { privacy: "zdr", stored: false } } : {}),
      },
    });
    if (!res.destroyed && !res.writableEnded) res.end("data: [DONE]\n\n");
  });
}
