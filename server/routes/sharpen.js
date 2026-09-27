import {
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
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { viewerOf } from "../early-models.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import {
  SHARPEN_MIN,
  SHARPEN_MAX,
  MAX_ANSWER,
  MAX_QUESTIONS,
  checkAnswers,
  checkPlaceholders,
  onlySentTags,
  parseSharpen,
  placeholderTags,
  sharpenMessages,
} from "../../src/sharpen.js";
import { sharpenCosts } from "../sharpen.js";

// Prompt Sharpen (update "sharpen"; in Private Mode it needs "private" too,
// see featuresFor). One small model call rewrites the prompt the person is
// about to send; the browser shows the change and lets them use, edit or
// drop it.
//
// Only the prompt is sent, with any answers to the sharpener's own
// questions: never the chat, files, memory, standing or project
// instructions. Always off the record: no conversation, no message, no
// prompt or result is stored, and nothing is logged. Its spend is filed as
// an ordinary chat in Usage Insights, as off-the-record chats are.
//
// Money: the most it can cost is held first, on the ordinary hold/settle
// path (balance and Spending Limits apply), and a finished sharpen settles
// on its actual usage. Anything that leaves the person without a usable
// result charges nothing: a refusal, a provider failure, Stop, an
// unreadable reply, a reply cut short by its room, or a result that lost or
// changed a Veil placeholder. Such a reply is never shown either, so there's
// nothing to gain from one.
export const SHARPEN_SHORT = `Type at least ${SHARPEN_MIN} characters to sharpen.`;
export const SHARPEN_LONG = "Sharpen works on prompts up to 6,000 characters.";
export const SHARPEN_CONTEXT =
  "Sharpen sends only your prompt, never the chat, files, memory or instructions.";
export const SHARPEN_TREASURY = "Sharpen is paid from your own balance, not a team treasury.";
export const SHARPEN_LENGTH =
  "The model ran out of room before it finished, so your prompt wasn't changed. Nothing was charged. Try a shorter prompt or another model.";
export const SHARPEN_UNREADABLE =
  "The model's answer couldn't be read, so your prompt wasn't changed. Nothing was charged. Try again, or pick another model.";
export const SHARPEN_PLACEHOLDERS =
  "The sharpened prompt dropped or changed a Veil placeholder such as [EMAIL_1], so it wasn't used. Nothing was charged. Try again, or pick another model.";
export const SHARPEN_EMPTY = "The model returned nothing, so your prompt wasn't changed. Nothing was charged.";
// Fields a sharpen never takes: it is only ever the prompt.
const CONTEXT_FIELDS = [
  "messages",
  "conversationId",
  "project",
  "memory",
  "instructions",
  "documents",
  "files",
  "web_search",
  "plugins",
];
const BUDGET_CODES = ["insufficient_credits", "spending_limit"];
const validTokens = (value, fallback) => (Number.isSafeInteger(value) && value >= 0 ? value : fallback);

export function sharpenRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight, fallback } = ctx;
  const { getModel } = ctx.models;

  // What a quote and a run share: the model, Private Mode, and the price of
  // `messages` (the real ones for a run; for a quote, a stand-in of the same
  // length, since a quote is never sent the prompt).
  function priced(req, messages, chars) {
    const body = req.body || {};
    if (body.treasury != null) fail(400, SHARPEN_TREASURY, "invalid_request");
    for (const key of CONTEXT_FIELDS)
      if (body[key] !== undefined && body[key] !== null) fail(400, SHARPEN_CONTEXT, "invalid_request");
    const m = getModel(body.model);
    // Early Model Access applies here as it does to a chat.
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
    if (m.type !== "chat" || imageCallable(m)) fail(400, "Sharpen needs a text model.", "unsupported_model");
    const isPrivate = body.private === true;
    if (isPrivate && !isPrivateModel(m, cfg))
      fail(400, "Private mode needs a model with zero data retention.", "private_model_required");
    const factor = markupFactor(req.user, cfg);
    const costs = sharpenCosts({ cfg, m, messages, chars, factor });
    ctx.models.validateContext(messages, m, costs.budget);
    return { m, isPrivate, factor, costs };
  }

  // Quoting sends nothing anywhere and holds nothing. It takes the prompt's
  // length, never the prompt itself.
  app.post("/api/sharpen/quote", requireUser, limit("sharpen_quote", 120, 60000), (req, res) => {
    const body = req.body || {};
    const chars = body.chars;
    if (!Number.isSafeInteger(chars) || chars < 0 || chars > SHARPEN_MAX + MAX_QUESTIONS * MAX_ANSWER)
      fail(400, "Send the prompt's length in characters.", "invalid_request");
    if (body.prompt !== undefined) fail(400, "A quote takes the prompt's length, not the prompt.", "invalid_request");
    const { m, costs } = priced(req, sharpenMessages("x".repeat(chars)), chars);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(costs.typical),
      max: credits(costs.max),
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      model: m.id,
      estimate: true,
    });
  });

  app.post("/api/sharpen", requireUser, limit("sharpen", 30, 60000), async (req, res) => {
    const body = req.body || {};
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    if (prompt.length < SHARPEN_MIN) fail(400, SHARPEN_SHORT, "invalid_request");
    if (prompt.length > SHARPEN_MAX) fail(400, SHARPEN_LONG, "sharpen_too_long");
    let answers;
    try {
      answers = checkAnswers(body.answers);
    } catch (e) {
      fail(400, e.message, "invalid_request");
    }
    // Seed Guard, with no override: a sharpen is optional, so it simply
    // never sends a seed phrase.
    if (isReleased(cfg, "seedguard") && [prompt, ...answers.map((a) => a.answer)].some((t) => findSeedPhrase(t)))
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    const messages = sharpenMessages(prompt, answers);
    const chars = prompt.length + answers.reduce((n, a) => n + a.answer.length, 0);
    const { m, isPrivate, factor, costs } = priced(req, messages, chars);
    // Every placeholder sent (Veil's tags) must come back exactly.
    const sent = [...new Set(placeholderTags(prompt + "\n" + answers.map((a) => a.answer).join("\n")))];
    const user = req.user.id;
    const requestId = requestIdentifier(req);
    const hold = `${user}:${requestId}`;

    // ---- Hold the most it can cost ----
    // Published prices are a floor (see routes/chat.js): hold headroom when
    // the balance and limits allow, else exactly the maximum.
    const holdAt = (amount) => reserve(db, { id: hold, user, amount, ttl: 5 * 60000 });
    const headroom = Math.ceil(costs.max * cfg.holdMargin);
    try {
      holdAt(headroom);
    } catch (e) {
      if (headroom <= costs.max || !BUDGET_CODES.includes(e.code)) throw e;
      holdAt(costs.max);
    }
    // Filed like an off-the-record chat: the model, never what it was for.
    tagUsage(db, cfg, hold, { feature: "chat", model: m.id });
    inflight.holds.add(hold);
    const controller = new AbortController();
    inflight.controllers.add(controller);
    // Leaving (Stop) cancels the call; nothing is charged for it.
    let left = false;
    res.on("close", () => {
      if (res.writableEnded) return;
      left = true;
      controller.abort(new Error("Client disconnected"));
    });
    const timer = setTimeout(() => controller.abort(new Error("Provider timeout")), cfg.requestTimeoutMs || 240000);
    let settled = false;
    try {
      // ---- One model call, with chat's failover and ZDR rules ----
      const upstream = {
        model: m.id,
        messages,
        max_tokens: costs.budget,
        ...(isPrivate ? ZDR_ROUTING : {}),
      };
      let accepted = false,
        route = "primary";
      const markAccepted = () => (accepted = true);
      async function* stream() {
        try {
          yield* chatStream(cfg, upstream, controller.signal, markAccepted);
        } catch (e) {
          if (accepted || controller.signal.aborted || isPrivate || !FAILOVER_CODES.has(e.code)) throw e;
          const backupModel = await fallback.modelFor(m.id);
          if (!backupModel) throw e;
          route = "backup";
          yield* chatStream(fallback.cfg, { ...upstream, model: backupModel }, controller.signal, markAccepted);
        }
      }
      let text = "",
        reasoning = "",
        usage = null,
        upstreamCost = null,
        finish = null;
      for await (const part of stream()) {
        if (part.error) fail(502, part.error.message || "Provider error", "provider_rejected");
        const choice = part.choices?.[0];
        if (typeof choice?.finish_reason === "string") finish = choice.finish_reason;
        const delta = choice?.delta || {};
        if (typeof delta.content === "string") text += delta.content;
        if (typeof delta.reasoning === "string" || typeof delta.reasoning_content === "string")
          reasoning += delta.reasoning || delta.reasoning_content;
        if (part.usage) usage = part.usage;
        if (Number.isFinite(part.cost)) upstreamCost = part.cost;
      }
      if (controller.signal.aborted) throw controller.signal.reason;

      // ---- Only a usable result is charged ----
      if (!text.trim()) fail(502, SHARPEN_EMPTY, "empty_output");
      const parsed = parseSharpen(text);
      if (!parsed)
        fail(
          502,
          finish === "length" ? SHARPEN_LENGTH : SHARPEN_UNREADABLE,
          finish === "length" ? "sharpen_length" : "sharpen_unreadable",
        );
      if (!checkPlaceholders(sent, parsed.prompt).ok)
        fail(502, SHARPEN_PLACEHOLDERS, "sharpen_placeholders");
      // A note or question that names a placeholder never sent is dropped.
      const notes = parsed.notes.filter((n) => onlySentTags(n, sent));
      const questions = parsed.questions.filter((q) => onlySentTags(q, sent));

      const input = validTokens(
        usage?.prompt_tokens,
        validTokens(usage?.input_tokens, Math.ceil(JSON.stringify(messages).length / 4)),
      );
      const out = validTokens(
        usage?.completion_tokens,
        validTokens(usage?.output_tokens, Math.ceil((text + reasoning).length / 4)),
      );
      const fee = route === "backup" ? cfg.gateway2FeePercent : cfg.gatewayFeePercent;
      const dollars = reportedProviderCost(usage, upstreamCost, fee) ?? tokenCost(m, input, out);
      const receipt = settle(db, hold, usdUnits(dollars * factor), m.name, {
        model: m.id,
        usage: { prompt_tokens: input, completion_tokens: out, total_tokens: input + out },
        finish_reason: finish || "stop",
      });
      settled = true;
      res.json({
        prompt: parsed.prompt,
        notes,
        questions,
        unchanged: parsed.prompt === prompt,
        model: m.id,
        credits_charged: receipt.credits_charged,
        finish_reason: finish || "stop",
        request_id: requestId,
        ...(cfg.testMode ? { local_test: true } : {}),
        ...(isPrivate ? { private: { privacy: "zdr", stored: false } } : {}),
        stored: false,
      });
    } catch (e) {
      if (!settled) release(db, hold);
      // Stopped: there's no one left to answer.
      if (left) return;
      if (controller.signal.aborted && !e?.status)
        fail(504, "The model took too long, so your prompt wasn't changed. Nothing was charged.", "provider_timeout");
      throw e;
    } finally {
      clearTimeout(timer);
      if (!settled) release(db, hold);
      inflight.holds.delete(hold);
      inflight.controllers.delete(controller);
    }
  });
}
