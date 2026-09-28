import { chatLimits } from "../../data/chat-limits.js";
import { withMemory } from "../../src/memory.js";
import { isReleased, UNCENSORED_MODELS } from "../releases.js";
import { isPrivateModel } from "../private-mode.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { viewerOf } from "../early-models.js";
import {
  fail,
  balance,
  credits,
  vision,
  chatPrice,
  markupFactor,
  standardFactor,
  wantsWebSearch,
} from "../core.js";

// Cost Compare: what the message being written would cost on other models,
// before it's sent. One request prices the same chat request (history,
// standing instructions, memory, documents, Web and Veil masking are already
// in the body, exactly as Send and the Credit Estimates chip build it) on up
// to MAX_COMPARE_MODELS models, with the same code /api/quote and /api/chat
// use (chatPrice in core.js). Like a quote, it reserves, charges and stores
// nothing.
export const MAX_COMPARE_MODELS = 8;
// The text modes whose model picker Cost Compare mirrors.
const MODES = ["chat", "code", "uncensored"];
// getModel's refusals that concern only the model asked about, and Early
// Model Access's (a model in its first days, for Insiders and up). Anything
// else (a bug, the database) fails the whole request as usual.
const MODEL_CODES = [
  "model_not_found",
  "model_unavailable",
  "unpriced_model",
  "early_model",
];

export function costCompareRoutes(ctx) {
  const { app, db, cfg, models, requireUser, limit } = ctx;
  // Opened by hand from the estimate chip, and each request prices several
  // models, so it has its own, lower limit than the typing-driven quotes.
  app.post(
    "/api/estimate/compare",
    requireUser,
    limit("compare", 30, 60000),
    (req, res) => {
      const body = req.body || {};
      const ids = body.models;
      if (
        !Array.isArray(ids) ||
        !ids.length ||
        ids.some((id) => typeof id !== "string" || !id || id.length > 200)
      )
        fail(
          400,
          "models must list the model ids to compare.",
          "invalid_request",
        );
      if (ids.length > MAX_COMPARE_MODELS)
        fail(
          400,
          `Compare up to ${MAX_COMPARE_MODELS} models at a time.`,
          "compare_limit",
        );
      if (new Set(ids).size !== ids.length)
        fail(400, "List each model once.", "invalid_request");
      const mode = body.mode ?? "chat";
      if (!MODES.includes(mode))
        fail(
          400,
          "Cost Compare works in chat, code and Uncensored.",
          "invalid_request",
        );
      if (body.private != null && typeof body.private !== "boolean")
        fail(400, "private must be true or false.", "invalid_request");
      const privateMode = body.private === true;

      // Everything that doesn't depend on the model, settled once, in the
      // order /api/quote settles it. A problem here (no message, a file that
      // isn't yours, an invalid budget) fails the whole comparison.
      const teamPaid = body.treasury === true;
      const team = teamPaid
        ? ctx.treasury.forQuote(req.user.id, body.conversationId)
        : null;
      const { messages, images } = models.checkMessages(
        ctx.files.expandMessages(req, body.messages),
      );
      const requested = body.max_tokens ?? 4096;
      if (!Number.isInteger(requested) || requested < 1)
        fail(400, "max_tokens must be a positive integer.");
      // The same saved memory /api/chat would add (none in Private Mode).
      const memory = ctx.memory.forRequest(req.user.id, body);
      const sent = withMemory(messages, memory?.message);
      const web = wantsWebSearch(body);
      const searchFee = web ? cfg.webSearchPrice : 0;
      const factor = teamPaid
        ? standardFactor(cfg)
        : markupFactor(req.user, cfg);
      const extended = isReleased(cfg, "longanswers");

      const refused = (id, code, message) => ({
        model: id,
        status: "refused",
        code,
        message,
      });
      function price(id) {
        let m;
        try {
          m = models.getModel(id);
          ctx.earlyModels.check(viewerOf(req), "models", m.id);
        } catch (e) {
          if (MODEL_CODES.includes(e?.code))
            return refused(id, e.code, e.message);
          throw e;
        }
        if (m.type !== "chat")
          return refused(
            m.id,
            "unsupported_model",
            "Cost Compare prices chat models only.",
          );
        // The model picker's sections: Uncensored offers only its curated
        // models, and chat and code leave them out.
        if ((mode === "uncensored") !== UNCENSORED_MODELS.includes(m.id))
          return refused(
            m.id,
            "other_section",
            mode === "uncensored"
              ? "This isn't one of the Uncensored models."
              : "This model is offered in the Uncensored section only.",
          );
        if (privateMode && !isPrivateModel(m, cfg))
          return refused(
            m.id,
            "private_model_required",
            "Private mode needs a model with zero data retention.",
          );
        if (images && !vision(m))
          return refused(
            m.id,
            "vision_required",
            "This model can't read the images in this message.",
          );
        // The reply budget Send would ask this model for: the one chosen,
        // up to the model's own limit (replyBudgetFor in src/long-answers.js).
        const max = models.maxTokens(
          extended
            ? Math.min(requested, chatLimits(m).maxOutputTokens)
            : requested,
          m,
        );
        const fit = models.contextFit(sent, m, max);
        const context = fit && {
          input_tokens_estimate: fit.input,
          reply_budget: max,
          allowance: fit.allowance,
          fits: fit.fits,
        };
        if (fit && !fit.fits)
          return {
            ...refused(
              m.id,
              "context_limit_exceeded",
              "This message and reply budget don't fit this model's context allowance.",
            ),
            reply_budget: max,
            context,
          };
        const amount = chatPrice(m, sent, max, searchFee, factor);
        return {
          model: m.id,
          status: "ok",
          amount,
          credits: credits(amount),
          usd: amount / 1e7,
          reply_budget: max,
          ...(context ? { context } : {}),
        };
      }
      const results = ids.map(price);
      // Differences against the first model (the one in use), computed in
      // whole units so they add up exactly.
      const base = results[0].status === "ok" ? results[0].amount : null;
      const room =
        !team && limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
      res.json({
        estimate: true,
        current: ids[0],
        available: credits(
          team ? team.available : balance(db, req.user.id).available,
        ),
        ...(room != null
          ? { spending_limit: { remaining: credits(room) } }
          : {}),
        web_search: web,
        ...(memory && body.memory != null
          ? { memory: { used: memory.facts.length, skipped: memory.skipped } }
          : {}),
        results: results.map(({ amount, ...r }) =>
          r.status === "ok"
            ? { ...r, difference: base == null ? null : credits(amount - base) }
            : r,
        ),
      });
    },
  );
}
