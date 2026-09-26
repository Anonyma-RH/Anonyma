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
  tokenCost,
  markupFactor,
} from "../core.js";
import { chatStream, reportedProviderCost } from "../provider.js";
import { FAILOVER_CODES } from "../fallback.js";
import { requestIdentifier } from "../middleware.js";
import { isPrivateModel, ZDR_ROUTING } from "../private-mode.js";
import { isReleased } from "../releases.js";
import { tagUsage } from "../usage-insights.js";
import { privacyTrail, storageFor, trailLive, veilMaskedFrom } from "../privacy-trail.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import {
  DEPTHS,
  MAX_FINDINGS,
  MAX_QUESTION,
  SEARCH_CONCURRENCY,
  cleanReport,
  collectSources,
  parsePlan,
  partialReport,
  stepSources,
} from "../../src/deep-research.js";
import { researchCosts, searchMessages, writeMessages, cutShortNote } from "../research.js";

// Deep Research (update "deepresearch", which needs Live Web Search too; see
// featuresFor). One question becomes a short plan of sub-questions, one web
// search per sub-question, and a written report whose numbered citations
// point only at pages those searches returned.
//
// Money: every step is held before anything runs (the plan's maximum), each
// step settles on its own actual usage through the ordinary hold/settle path
// as it finishes, and a step that fails, is stopped or never starts is
// released, so only finished steps are charged. Balance and Spending Limits
// are checked on those holds; a run that can't hold its maximum is refused
// with nothing charged. Workspace only: no API key, so no allowance applies.
//
// Privacy: the question goes to the chosen model and, as sub-questions, to
// the gateway's web search. Nothing is logged. A saved run is an ordinary
// conversation turn (the question, then the report with its sources), so
// History, Bookmarks, Export, Share, erase and the account export already
// cover it; off the record and Private Mode store nothing.
export const RESEARCH_VEILED =
  "Veil masked details in this question, so Deep research won't run it: web searches with placeholders would find nothing, and the real details never leave this browser. Remove them, or turn Veil off for this question.";
const BUDGET_CODES = [
  "insufficient_credits",
  "spending_limit",
];
const validTokens = (value, fallback) =>
  Number.isSafeInteger(value) && value >= 0 ? value : fallback;

export function researchRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight, fallback } = ctx;
  const { getModel } = ctx.models;
  const { accessConversation, newConversation } = ctx.conversations;
  // One run at a time per account: a run holds its whole maximum.
  const running = new Set();

  // Everything a quote and a run share, checked before anything is held.
  function prepare(req) {
    const body = req.body || {};
    const question = typeof body.question === "string" ? body.question.trim() : "";
    if (!question) fail(400, "Enter a question to research.", "invalid_request");
    if (question.length > MAX_QUESTION)
      fail(400, "Keep a research question under 2,000 characters.", "invalid_request");
    if (!Object.hasOwn(DEPTHS, body.depth))
      fail(400, "Choose Quick or Thorough research.", "invalid_request");
    // Seed Guard, with no override: sub-questions become web searches.
    if (isReleased(cfg, "seedguard") && findSeedPhrase(question))
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    // Veil runs in the browser, which reports its mask count (see
    // privacy-trail.js). Anything masked means the question can't be searched.
    const veilMasked = veilMaskedFrom(body);
    if (veilMasked > 0) fail(400, RESEARCH_VEILED, "research_veiled");
    const mode = body.mode ?? "chat";
    if (!["chat", "code"].includes(mode))
      fail(400, "Deep research runs in chat and code.", "invalid_request");
    if (body.treasury != null)
      fail(400, "Deep research is paid from your own balance, not a team treasury.", "invalid_request");
    const m = getModel(body.model);
    if (m.type !== "chat" || imageCallable(m))
      fail(400, "Deep research needs a text model.", "unsupported_model");
    const isPrivate = body.private === true;
    if (isPrivate && !isPrivateModel(m, cfg))
      fail(400, "Private mode needs a model with zero data retention.", "private_model_required");
    const ephemeral = body.ephemeral === true || isPrivate;
    if (ephemeral && body.conversationId != null)
      fail(400, "An off-the-record chat can't be added to a saved conversation.", "invalid_request");
    if (ephemeral && body.project != null)
      fail(
        400,
        "Off-the-record and Private chats are never saved, so they aren't filed in a project.",
        "invalid_request",
      );
    if (body.project != null && body.conversationId != null)
      fail(
        400,
        "A saved chat moves between projects from its details, not with a new message.",
        "invalid_request",
      );
    // Memory, exactly as a chat would use it (never off the record, in
    // Private Mode or in a shared chat). It goes with the plan and the
    // report, never into a search itself.
    const memory = ctx.memory.forRequest(req.user.id, { ...body, mode });
    const cap = DEPTHS[body.depth];
    const factor = markupFactor(req.user, cfg);
    const costs = researchCosts({ cfg, m, question, cap, memoryMessage: memory?.message, factor });
    ctx.models.validateContext(costs.messages.plan, m, costs.budget.plan);
    ctx.models.validateContext(costs.messages.write, m, costs.budget.write);
    return { body, question, depth: body.depth, cap, mode, m, isPrivate, ephemeral, veilMasked, memory, factor, costs };
  }

  app.post("/api/research/quote", requireUser, limit("research_quote", 120, 60000), (req, res) => {
    const { m, depth, cap, costs, factor } = prepare(req);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(costs.total),
      usd: costs.total / 1e7,
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      model: m.id,
      depth,
      searches: cap,
      steps: {
        plan: credits(costs.amounts.plan),
        search: credits(costs.amounts.search),
        write: credits(costs.amounts.write),
      },
      web_search_fee: credits(Math.ceil(usdUnits(cfg.webSearchPrice) * factor)),
      estimate: true,
    });
  });

  app.post("/api/research", requireUser, limit("research", 6, 60000), async (req, res) => {
    const { body, question, depth, cap, mode, m, isPrivate, ephemeral, veilMasked, memory, factor, costs } =
      prepare(req);
    const user = req.user.id;
    const requestId = requestIdentifier(req);
    if (running.has(user))
      fail(409, "A deep research run is already going. Wait for it, or stop it first.", "research_running");
    let conversation = !ephemeral && body.conversationId != null
      ? accessConversation(body.conversationId, user).id
      : null;
    const project = !ephemeral && body.project != null ? ctx.projects.forChat(user, body.project) : null;
    const storage = storageFor({ api: false, isPrivate, ephemeral });

    // ---- Hold the plan's maximum: one hold per step ----
    const steps = ["plan", ...Array.from({ length: cap }, (_, i) => "search" + (i + 1)), "write"];
    const holdId = (step) => `${user}:${requestId}:${step}`;
    const amountOf = (step) => costs.amounts[step.startsWith("search") ? "search" : step];
    const holdAll = (margin) => {
      const made = [];
      try {
        for (const step of steps) {
          const base = amountOf(step);
          reserve(db, {
            id: holdId(step),
            user,
            amount: margin ? Math.ceil(base * cfg.holdMargin) : base,
            ttl: 45 * 60000,
          });
          made.push(holdId(step));
        }
      } catch (e) {
        // A partly held run is undone completely; none of it ever ran.
        for (const id of made) db.prepare("DELETE FROM holds WHERE id=? AND status='held'").run(id);
        throw e;
      }
    };
    // Published prices are a floor (see routes/chat.js): hold headroom when
    // the balance and limits allow, else exactly the maximum shown.
    try {
      holdAll(cfg.holdMargin > 1);
    } catch (e) {
      if (!(cfg.holdMargin > 1) || !BUDGET_CODES.includes(e.code)) throw e;
      holdAll(false);
    }
    const open = new Set(steps.map(holdId));
    const releaseRest = () => {
      for (const id of open) release(db, id);
      open.clear();
    };
    for (const step of steps)
      tagUsage(db, cfg, holdId(step), {
        // Off the record and in Private Mode only what billing reflects.
        feature: ephemeral ? (step.startsWith("search") ? "web_search" : "chat") : "deep_research",
        model: m.id,
      });
    running.add(user);
    for (const id of open) inflight.holds.add(id);
    try {
      if (!ephemeral) {
        conversation ||= newConversation(user, question.slice(0, 70), mode);
        if (project) ctx.projects.file(conversation, project.id, user);
        db.prepare(
          "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
        ).run(uid("m_"), conversation, "user", JSON.stringify(question), m.id, 0, now(), user);
        db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(now(), conversation);
      }
    } catch (e) {
      releaseRest();
      for (const step of steps) inflight.holds.delete(holdId(step));
      running.delete(user);
      throw e;
    }

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

    let charged = 0;
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    let anyBackup = false;
    const trail = trailLive(cfg);
    const withRoute = (route) => (trail ? { route } : {});

    // One model call, through the same gateway, failover and ZDR rules as a
    // chat: a private step never fails over, and nothing fails over once the
    // provider has accepted it.
    async function call(messages, max, web) {
      const step = new AbortController();
      const onStop = () => step.abort(controller.signal.reason);
      controller.signal.addEventListener("abort", onStop, { once: true });
      const timer = setTimeout(() => step.abort(new Error("Provider timeout")), cfg.requestTimeoutMs || 240000);
      inflight.controllers.add(step);
      const upstream = {
        model: m.id,
        messages,
        max_tokens: max,
        ...(web ? { plugins: [{ id: "web", max_results: 5 }] } : {}),
        ...(isPrivate ? ZDR_ROUTING : {}),
      };
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
        partUsage = null,
        upstreamCost = null,
        finish = null;
      // The pages the provider cited, as it reports them (deduplicated and
      // checked in stepSources); never taken from the model's text.
      const cited = [];
      const citedUrls = new Set();
      const cite = (url, title) => {
        if (typeof url !== "string" || citedUrls.has(url) || cited.length >= 50) return;
        citedUrls.add(url);
        cited.push({ url, title });
      };
      try {
        for await (const part of stream()) {
          if (part.error) fail(502, part.error.message || "Provider error", "provider_rejected");
          const choice = part.choices?.[0];
          if (typeof choice?.finish_reason === "string") finish = choice.finish_reason;
          const delta = choice?.delta || {};
          if (typeof delta.content === "string") text += delta.content;
          if (typeof delta.reasoning === "string" || typeof delta.reasoning_content === "string")
            reasoning += delta.reasoning || delta.reasoning_content;
          for (const a of [...(delta.annotations || []), ...(choice?.message?.annotations || [])])
            cite(a?.url_citation?.url, a?.url_citation?.title);
          for (const url of part.citations || []) cite(url);
          if (part.usage) partUsage = part.usage;
          if (Number.isFinite(part.cost)) upstreamCost = part.cost;
        }
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onStop);
        inflight.controllers.delete(step);
      }
      if (route === "backup") anyBackup = true;
      const input = validTokens(
        partUsage?.prompt_tokens,
        validTokens(partUsage?.input_tokens, Math.ceil(JSON.stringify(messages).length / 4)),
      );
      const out = validTokens(
        partUsage?.completion_tokens,
        validTokens(partUsage?.output_tokens, Math.ceil((text + reasoning).length / 4)),
      );
      const fee = route === "backup" ? cfg.gateway2FeePercent : cfg.gatewayFeePercent;
      const reported = reportedProviderCost(partUsage, upstreamCost, fee);
      // As in a chat: a searched step costs at least its tokens plus the fee.
      const dollars = Math.max(
        reported ?? tokenCost(m, input, out),
        web ? tokenCost(m, input, out) + cfg.webSearchPrice : 0,
      );
      return { text, reasoning, input, out, dollars, finish, route, sources: stepSources(cited) };
    }
    // Settles a finished step on its actual usage; its hold closes.
    const settleStep = (step, r) => {
      const receipt = settle(db, holdId(step), usdUnits(r.dollars * factor), m.name, {
        model: m.id,
        usage: { prompt_tokens: r.input, completion_tokens: r.out, total_tokens: r.input + r.out },
        finish_reason: r.finish || "stop",
      });
      open.delete(holdId(step));
      charged += receipt.charged;
      usage.prompt_tokens += r.input;
      usage.completion_tokens += r.out;
      return receipt.credits_charged;
    };
    const releaseStep = (step) => {
      release(db, holdId(step));
      open.delete(holdId(step));
    };
    // A failure's own message only when it's one of ours (it has a status);
    // anything unexpected gets a plain one.
    const failure = (e) => ({
      message: e?.status ? e.message : "Deep research stopped unexpectedly. Only finished steps were charged.",
      code: e?.status && e.code ? e.code : "research_failed",
    });

    // ---- Run ----
    // What each step did: status is "done", "failed", "stopped" or "skipped".
    const planStep = { kind: "plan", status: "skipped", credits: 0 };
    const writeStep = { kind: "write", status: "skipped", credits: 0 };
    let plan = { questions: [question], fallback: true };
    let results = [];
    let outcome = null; // { status, text?, sources?, finish?, error? }
    const leftovers = () => {
      const { sources, numbers } = collectSources(results);
      return { text: partialReport({ questions: plan.questions, results, sources, numbers }), sources };
    };
    try {
      send({
        research: { stage: "planning", depth, max_searches: cap, reserved: credits(costs.total) },
        conversationId: conversation,
      });
      // 1. Plan: strict JSON sub-questions, else the question itself.
      try {
        const r = await call(costs.messages.plan, costs.budget.plan, false);
        if (!r.text.trim()) fail(502, "The planner returned nothing.", "empty_output");
        Object.assign(planStep, {
          status: "done",
          credits: settleStep("plan", r),
          finish_reason: r.finish || "stop",
          ...withRoute(r.route),
        });
        plan = parsePlan(r.text, question, cap);
      } catch (e) {
        releaseStep("plan");
        planStep.status = stopped() ? "stopped" : "failed";
        if (stopped()) throw e;
      }
      for (let i = plan.questions.length; i < cap; i++) releaseStep("search" + (i + 1));
      results = plan.questions.map(() => ({ status: "skipped", sources: [], credits: 0 }));
      send({
        research: { stage: "planned", questions: plan.questions, fallback: plan.fallback, credits: planStep.credits },
      });
      // 2. Searches, a few at a time, each settled as it finishes.
      let next = 0;
      const worker = async () => {
        while (next < plan.questions.length && !stopped()) {
          const i = next++;
          const step = "search" + (i + 1);
          send({ research: { stage: "searching", index: i } });
          try {
            const r = await call(searchMessages(plan.questions[i]), costs.budget.search, true);
            if (!r.text.trim()) fail(502, "The search returned nothing.", "empty_output");
            // A search that hit its reply budget keeps what it wrote; the
            // step says it was cut short.
            results[i] = {
              status: "done",
              findings: r.text.slice(0, MAX_FINDINGS),
              sources: r.sources,
              credits: settleStep(step, r),
              route: r.route,
              finish: r.finish || "stop",
            };
          } catch {
            releaseStep(step);
            results[i] = { status: stopped() ? "stopped" : "failed", sources: [], credits: 0 };
          }
          send({
            research: {
              stage: "searched",
              index: i,
              status: results[i].status,
              sources: results[i].sources,
              findings: results[i].findings,
              credits: results[i].credits,
              ...(results[i].finish ? { finish_reason: results[i].finish } : {}),
            },
          });
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(SEARCH_CONCURRENCY, plan.questions.length) }, worker),
      );
      if (stopped()) throw controller.signal.reason;
      if (!results.some((r) => r.status === "done"))
        outcome = {
          status: "failed",
          error: {
            message: "None of the web searches finished, so no report was written. Only finished steps were charged.",
            code: "research_no_results",
          },
        };
      else {
        // 3. The report, cited only against the sources collected above.
        send({ research: { stage: "writing" } });
        const { sources, numbers } = collectSources(results);
        try {
          const r = await call(
            writeMessages({ question, questions: plan.questions, results, sources, numbers, memoryMessage: memory?.message }),
            costs.budget.write,
            false,
          );
          if (!r.text.trim()) fail(502, "The report came back empty.", "empty_output");
          Object.assign(writeStep, {
            status: "done",
            credits: settleStep("write", r),
            finish_reason: r.finish || "stop",
            ...withRoute(r.route),
          });
          // A report that hit its reply budget is kept, and ends by saying so
          // (in the question's language, as the report is written), so the
          // note goes with it into History, Export and Share.
          const report = cleanReport(r.text, sources).text;
          outcome = {
            status: "done",
            text: r.finish === "length" ? `${report}\n\n---\n\n${cutShortNote(question)}` : report,
            sources,
            finish: r.finish || "stop",
          };
        } catch (e) {
          releaseStep("write");
          writeStep.status = stopped() ? "stopped" : "failed";
          if (stopped()) throw e;
          outcome = {
            status: "partial",
            ...leftovers(),
            error: {
              message: "The report couldn't be written, so here is what the searches found. The report step wasn't charged.",
              code: "research_report_failed",
            },
          };
        }
      }
    } catch (e) {
      // Stopped: finished steps stay charged, the rest is released, and what
      // finished is kept (the browser shows the same). Anything else ends the
      // run the same way, with the reason.
      outcome = stopped()
        ? { status: "stopped", ...leftovers() }
        : {
            status: "partial",
            ...leftovers(),
            error: { message: failure(e).message, code: failure(e).code },
          };
    } finally {
      releaseRest();
      for (const step of steps) inflight.holds.delete(holdId(step));
      inflight.controllers.delete(controller);
      running.delete(user);
    }
    const record = [
      planStep,
      ...results.map((r) => ({
        kind: "search",
        status: r.status,
        sources: r.sources.length,
        credits: r.credits,
        ...(r.status === "done" ? { finish_reason: r.finish || "stop", ...withRoute(r.route) } : {}),
      })),
      writeStep,
    ];

    // ---- Keep and answer ----
    const sources = outcome.sources || [];
    const research = {
      depth,
      questions: plan.questions,
      fallback: plan.fallback,
      status: outcome.status,
      steps: record,
      credits_charged: credits(charged),
    };
    const privacy = trail
      ? privacyTrail(cfg, {
          model: m,
          route: anyBackup ? "backup" : "primary",
          zeroDataRetention: isPrivate,
          storage,
          veilMasked,
          receiptId: null,
        })
      : null;
    const text = outcome.text || "";
    const saved = {
      text,
      reasoning: "",
      images: [],
      usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
      finish_reason: outcome.status === "done" ? outcome.finish : "interrupted",
      request_id: requestId,
      ...(sources.length ? { citations: sources } : {}),
      research,
      ...(privacy ? { privacy } : {}),
    };
    // Only something paid for and worth reading is kept with the chat.
    if (text && conversation && db.prepare("SELECT id FROM conversations WHERE id=?").get(conversation)) {
      db.prepare(
        "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
      ).run(uid("m_"), conversation, "assistant", JSON.stringify(saved), m.id, charged, now(), user);
      db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(now(), conversation);
    }
    const anonyma = {
      credits_charged: credits(charged),
      request_id: requestId,
      finish_reason: saved.finish_reason,
      ...(cfg.testMode ? { local_test: true } : {}),
      ...(isPrivate ? { private: { privacy: "zdr", stored: false } } : {}),
      ...(privacy ? { privacy } : {}),
      ...(body.memory != null && memory
        ? { memory: { used: memory.facts.length, facts: memory.facts, skipped: memory.skipped, ...(memory.reason ? { reason: memory.reason } : {}) } }
        : {}),
    };
    const message = { text, citations: sources, research };
    if (outcome.error) send({ error: outcome.error, message, anonyma, conversationId: conversation });
    else send({ research: { stage: "done" }, message, anonyma, conversationId: conversation });
    if (!res.destroyed && !res.writableEnded) res.end("data: [DONE]\n\n");
  });
}
