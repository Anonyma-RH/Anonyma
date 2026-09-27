import { chatLimits, contextEstimate } from "../data/chat-limits.js";
import {
  fail,
  callable,
  imageCallable,
  hasPublishedTokenRates,
  vision,
  chatPrice,
  tokenCost,
  usdUnits,
} from "./core.js";
import { isReleased, modelReleased, UNCENSORED_MODELS } from "./releases.js";
import { isPrivateModel, ZDR_ROUTING } from "./private-mode.js";
import { chatStream, reportedProviderCost } from "./provider.js";
import { viewerOf } from "./early-models.js";
import { trainingLabel } from "./training.js";
import {
  HELPER_BUDGET,
  isRouter,
  autoPlan,
  autoSettings,
  helperMessages,
  parseHelper,
} from "../src/auto-model.js";

// Auto Model (update "automodel"), server side: the models Auto may use for
// one workspace request, the plan and its prices, and the helper call. The
// rules and parsing are shared with the browser (src/auto-model.js); the
// request itself runs through routes/chat.js's ordinary hold → settle path,
// and /api/quote prices it with the same functions, so the estimate and the
// hold are one number.
//
// Nothing new is stored: a reply keeps its chip data (model and helper ids,
// tier and reason codes, the helper's cost) with the message, as it keeps
// its privacy trail. The helper's own words are never kept or logged.

export const autoLive = (cfg) => isReleased(cfg, "automodel");
export const HELPER_TIMEOUT_MS = 20000;
export const AUTO_SECTIONS = ["chat", "code", "uncensored"];
export const AUTO_NOT_OFFERED = "Auto isn't offered here. Choose a model.";

// The reply budget a model would get for this request: what was asked (the
// workspace's reply budget), lowered to what /api/chat allows that model.
export function fittedBudget(cfg, requested, m) {
  const n = requested ?? 4096;
  if (!Number.isInteger(n) || n < 1) fail(400, "max_tokens must be a positive integer.");
  return Math.min(n, isReleased(cfg, "longanswers") ? chatLimits(m).maxOutputTokens : 8192);
}

// The helper's reply room: HELPER_BUDGET, within the model's output limit and
// what its context has left after the question.
export function helperBudget(cfg, m, messages) {
  const limits = chatLimits(m);
  const cap = isReleased(cfg, "longanswers") ? limits.maxOutputTokens : 8192;
  const room = (limits.contextTokens || 32768) - contextEstimate(messages);
  return Math.max(1, Math.min(HELPER_BUDGET, cap, room));
}

// Settings from the request body, or a 400.
export function requestSettings(body) {
  try {
    return autoSettings(body?.auto);
  } catch (e) {
    fail(400, e.message, "invalid_request");
  }
}

// The models Auto may use for this request: released, callable, priced text
// models in the request's section (Uncensored's own, or everything else),
// private ones only in Private Mode, none the account can't use yet (Early
// Model Access) and none Model Status shows Down. Decorated with the fields
// the shared planner reads, as /api/models does (Training Labels' flag
// always: Auto avoids such models whenever others remain).
export function autoPool(ctx, req, { isPrivate, mode }) {
  const { cfg } = ctx;
  const early = ctx.earlyModels.view(viewerOf(req), "models");
  const uncensored = mode === "uncensored";
  return ctx.models.snapshot.data
    .filter(
      (m) =>
        m.type === "chat" &&
        !isRouter(m) &&
        !imageCallable(m) &&
        hasPublishedTokenRates(m) &&
        callable(m, cfg) &&
        modelReleased(m, cfg) &&
        UNCENSORED_MODELS.includes(m.id) === uncensored &&
        (!isPrivate || isPrivateModel(m, cfg)) &&
        !early.hides(m.id) &&
        ctx.modelStatus.statusOf(m.id) !== "down",
    )
    .map((m) => ({
      ...m,
      callable: true,
      vision: vision(m),
      ...(isPrivateModel(m, cfg) ? { private: true } : {}),
      ...(trainingLabel(m) ? { trainsOnPrompts: true } : {}),
    }));
}

// Refuses what Auto doesn't do: a request that also names a model, and
// anything but a plain chat, code or Uncensored message (Blind, Deep
// Research, Sheets, Study, Document Compare, Catch me up, Double-check,
// Symposium and task tools pick their own model). The API never reads
// `auto`: a request there always names its model.
export function refuseAutoTask(body, { task = false, blind = false } = {}) {
  if (body.model !== undefined)
    fail(400, "Send a model or auto, not both.", "invalid_request");
  if (
    task ||
    blind ||
    body.double_check != null ||
    body.taskTool !== undefined ||
    body.canvas !== undefined ||
    body.slides !== undefined ||
    !AUTO_SECTIONS.includes(body.mode ?? "chat")
  )
    fail(400, AUTO_NOT_OFFERED, "auto_not_offered");
}

// The plan and its prices for a request whose (checked) messages as sent are
// `sent`: the most it can cost is the dearest model it could still land on,
// plus the most the helper can cost when it will be asked.
export function planAutoRequest(ctx, req, { sent, isPrivate, mode, settings, factor, searchFee }) {
  const { cfg } = ctx;
  const requested = req.body.max_tokens;
  const pool = autoPool(ctx, req, { isPrivate, mode });
  const budget = (m) => fittedBudget(cfg, requested, m);
  const fitting = pool.filter((m) => {
    const fit = ctx.models.contextFit(sent, m, budget(m));
    return !fit || fit.fits;
  });
  const plan = autoPlan({ messages: sent, mode, settings, pool: fitting, helperPool: pool });
  if (plan.error)
    fail(
      400,
      plan.error === "vision"
        ? "No model Auto can use here reads images. Choose a model, or remove the images. Nothing was sent or charged."
        : "No model Auto can use here fits this request right now. Choose a model. Nothing was sent or charged.",
      "auto_unavailable",
    );
  // The catalog's own row for a planned model (the plan works on copies).
  const row = (m) => ctx.models.find(m.id) || m;
  const price = (m) => chatPrice(row(m), sent, budget(m), searchFee, factor);
  const helper = plan.helper ? row(plan.helper) : null;
  const helperSent = helper ? helperMessages(plan.facts, plan.prefer) : null;
  const helperRoom = helper ? helperBudget(cfg, helper, helperSent) : 0;
  const helperMax = helper ? chatPrice(helper, helperSent, helperRoom, 0, factor) : 0;
  const candidates = plan.candidates.map((c) => ({ tier: c.tier, model: row(c.model), amount: price(c.model) }));
  const worst = Math.max(...candidates.map((c) => c.amount));
  return {
    plan,
    row,
    budget,
    price,
    candidates,
    chosen: plan.chosen ? { ...plan.chosen, model: row(plan.chosen.model) } : null,
    pending: !plan.chosen,
    helper,
    helperSent,
    helperRoom,
    helperMax,
    // The one number the estimate shows and the hold is placed from.
    amount: plan.chosen ? price(plan.chosen.model) : worst + helperMax,
    settings: { prefer: plan.prefer ?? settings.prefer, helper: settings.helper },
  };
}

// Asks the helper which tier fits. Never throws for the helper's own
// failure: returns { choice: {tier, reason} } with its cost in USD, or
// { choice: null } when it failed, timed out or answered unusably (which
// costs nothing). `signal` stops it when the person leaves. No failover: a
// helper that fails simply leaves the message on Balanced.
export async function askHelper(ctx, { model, messages, budget, isPrivate, signal }) {
  const { cfg } = ctx;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Provider timeout")), cfg.autoHelperTimeoutMs || HELPER_TIMEOUT_MS);
  const stop = () => controller.abort(signal.reason);
  if (signal?.aborted) stop();
  else signal?.addEventListener("abort", stop, { once: true });
  // Model Status: the helper's outcome and timings, counted like a chat's.
  const probe = ctx.modelStatus.start(model.id);
  let text = "",
    reasoning = "",
    usage = null,
    upstreamCost = null,
    finish = null;
  try {
    probe.sent();
    for await (const part of chatStream(
      cfg,
      { model: model.id, messages, max_tokens: budget, ...(isPrivate ? ZDR_ROUTING : {}) },
      controller.signal,
    )) {
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
    probe.fail(e, controller.signal);
    return { choice: null, failure: controller.signal.aborted ? "stopped" : "error" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", stop);
  }
  const choice = parseHelper(text);
  if (!choice) return { choice: null, failure: finish === "length" ? "length" : "unreadable", finish };
  const valid = (v, fallback) => (Number.isSafeInteger(v) && v >= 0 ? v : fallback);
  const input = valid(usage?.prompt_tokens, valid(usage?.input_tokens, Math.ceil(JSON.stringify(messages).length / 4)));
  const out = valid(usage?.completion_tokens, valid(usage?.output_tokens, Math.ceil((text + reasoning).length / 4)));
  const usd = reportedProviderCost(usage, upstreamCost, cfg.gatewayFeePercent) ?? tokenCost(model, input, out);
  return { choice, usd, finish: finish || "stop" };
}

// The helper's cost in integer units at the account's rate, never above
// what was held for it.
export const helperCharge = (usd, factor, max) => Math.min(max, Math.ceil(usdUnits(usd) * factor));

