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
import { viewerOf } from "../early-models.js";
import { findSeedPhrase, SEED_MESSAGE } from "../../src/seed-guard.js";
import {
  FACTCHECK_VEILED,
  MAX_CLAIM,
  claimLanguage,
  factCheckText,
  factCheckUserText,
  finishVerdict,
  hasVeilPlaceholder,
  parseVerdict,
  tidySelection,
} from "../../src/highlight-ask.js";
import { factCheckCost } from "../factcheck.js";

// Highlight & Ask's fact-check (update "highlight", which needs Live Web
// Search too; see featuresFor). The text someone selected in a reply is
// checked by one web search through the same plugin and fee as Web, and
// the model answers with a strict JSON verdict: Supported, Disputed, Mixed
// or Couldn't verify, a one-paragraph reason and the pages it relied on,
// kept only if the search returned them.
//
// Money: the check's maximum (the claim, the whole reply budget and the web
// search fee) is held first on the ordinary hold/settle path, so balance
// and Spending Limits apply; a check that can't hold it is refused with
// nothing charged. It settles on actual usage only when it produced a
// verdict. A refused, failed, stopped or unreadable check is released and
// charges nothing. Workspace only: no API key, so no allowance applies.
//
// Privacy: only the selected text goes to the model and its web search, not
// the rest of the chat. Nothing is logged. A saved check is two ordinary
// turns (the quote, then the card's text and sources), so History,
// Bookmarks, Export, Share, erase and the account export already cover it;
// off the record and Private Mode store nothing.
const BUDGET_CODES = ["insufficient_credits", "spending_limit"];
const validTokens = (value, fallback) =>
  Number.isSafeInteger(value) && value >= 0 ? value : fallback;
export const FACTCHECK_CUT_SHORT =
  "The model ran out of room before it finished its verdict, so there's no result. Nothing was charged. Try again, or choose another model.";
export const FACTCHECK_UNREADABLE =
  "The model's answer wasn't a verdict ANONYMA could read, so there's no result. Nothing was charged. Try again, or choose another model.";

export function factCheckRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight, fallback } = ctx;
  const { getModel } = ctx.models;
  const { accessConversation, newConversation } = ctx.conversations;

  // Everything a quote and a check share, checked before anything is held.
  function prepare(req) {
    const body = req.body || {};
    const claim = tidySelection(typeof body.claim === "string" ? body.claim : "");
    if (!claim) fail(400, "Select some text in a reply to fact-check.", "invalid_request");
    if (claim.length > MAX_CLAIM)
      fail(400, "Select a shorter passage to fact-check: up to 1,000 characters.", "claim_too_long");
    // Seed Guard, with no override: the claim becomes a web search.
    if (isReleased(cfg, "seedguard") && findSeedPhrase(claim))
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    // Veil runs in the browser, which reports its mask count (see
    // privacy-trail.js). Anything masked, or a placeholder left in the
    // text, means it can't be searched.
    const veilMasked = veilMaskedFrom(body);
    if (veilMasked > 0 || hasVeilPlaceholder(claim)) fail(400, FACTCHECK_VEILED, "factcheck_veiled");
    if (body.treasury != null)
      fail(400, "A fact-check is paid from your own balance, not a team treasury.", "invalid_request");
    const m = getModel(body.model);
    if (m.type !== "chat" || imageCallable(m))
      fail(400, "A fact-check needs a text model.", "unsupported_model");
    // Early Model Access applies as it does to a chat.
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
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
    const factor = markupFactor(req.user, cfg);
    const cost = factCheckCost({ cfg, m, claim, factor });
    ctx.models.validateContext(cost.messages, m, cost.budget);
    return { body, claim, m, isPrivate, ephemeral, veilMasked, factor, cost };
  }

  app.post("/api/factcheck/quote", requireUser, limit("factcheck_quote", 120, 60000), (req, res) => {
    const { m, cost, factor } = prepare(req);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(cost.amount),
      usd: cost.amount / 1e7,
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      model: m.id,
      web_search_fee: credits(Math.ceil(usdUnits(cfg.webSearchPrice) * factor)),
      estimate: true,
    });
  });

  app.post("/api/factcheck", requireUser, limit("factcheck", 20, 60000), async (req, res) => {
    const { body, claim, m, isPrivate, ephemeral, veilMasked, factor, cost } = prepare(req);
    const user = req.user.id;
    const requestId = requestIdentifier(req);
    // A saved check joins its chat (never a Symposium run, which has no
    // thread), or starts one, filed in a project if asked.
    let conversation = null;
    if (!ephemeral && body.conversationId != null) {
      const c = accessConversation(body.conversationId, user);
      if (c.mode === "symposium")
        fail(400, "A fact-check can't be added to a Symposium run.", "invalid_request");
      conversation = c.id;
    }
    const project = !ephemeral && body.project != null ? ctx.projects.forChat(user, body.project) : null;
    const storage = storageFor({ api: false, isPrivate, ephemeral });

    // ---- Hold the maximum ----
    const hold = `${user}:${requestId}`;
    const holdFor = (amount) => reserve(db, { id: hold, user, amount, ttl: 10 * 60000 });
    // Published prices are a floor (see routes/chat.js): hold headroom when
    // the balance and limits allow, else exactly the maximum shown.
    const headroom = Math.ceil(cost.amount * cfg.holdMargin);
    try {
      holdFor(headroom);
    } catch (e) {
      if (headroom <= cost.amount || !BUDGET_CODES.includes(e.code)) throw e;
      holdFor(cost.amount);
    }
    // Usage Insights files it as the web search it is, whatever the storage.
    tagUsage(db, cfg, hold, { feature: "web_search", model: m.id });
    inflight.holds.add(hold);
    const controller = new AbortController();
    inflight.controllers.add(controller);
    // Leaving (Stop) cancels the check; it's released, not charged.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
    });
    const timer = setTimeout(
      () => controller.abort(new Error("Provider timeout")),
      cfg.requestTimeoutMs || 240000,
    );
    const done = () => {
      clearTimeout(timer);
      inflight.controllers.delete(controller);
      inflight.holds.delete(hold);
    };

    // ---- One web search, through the same gateway, failover and ZDR
    // rules as a chat: a private check never fails over, and nothing fails
    // over once the provider has accepted it. ----
    const upstream = {
      model: m.id,
      messages: cost.messages,
      max_tokens: cost.budget,
      plugins: [{ id: "web", max_results: 5 }],
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
      partUsage = null,
      upstreamCost = null,
      finish = null;
    // The pages the provider says the search returned; never taken from
    // the model's own text.
    const returned = [];
    const seen = new Set();
    const cite = (url, title) => {
      if (typeof url !== "string" || seen.has(url) || returned.length >= 50) return;
      seen.add(url);
      returned.push({ url, title });
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
    } catch (e) {
      release(db, hold);
      done();
      if (controller.signal.aborted && res.destroyed) return;
      if (e?.status) throw e;
      fail(502, "The fact-check couldn't finish. Nothing was charged.", "factcheck_failed");
    }

    // ---- Read the verdict ----
    const parsed = parseVerdict(text);
    if (!parsed) {
      release(db, hold);
      done();
      if (finish === "length")
        fail(502, FACTCHECK_CUT_SHORT, "factcheck_cut_short");
      fail(502, FACTCHECK_UNREADABLE, "factcheck_unreadable");
    }
    const lang = claimLanguage(claim);
    const verdict = finishVerdict(parsed, returned, lang);

    // ---- Charge what it used ----
    const input = validTokens(
      partUsage?.prompt_tokens,
      validTokens(partUsage?.input_tokens, Math.ceil(JSON.stringify(cost.messages).length / 4)),
    );
    const out = validTokens(
      partUsage?.completion_tokens,
      validTokens(partUsage?.output_tokens, Math.ceil((text + reasoning).length / 4)),
    );
    const fee = route === "backup" ? cfg.gateway2FeePercent : cfg.gatewayFeePercent;
    const reported = reportedProviderCost(partUsage, upstreamCost, fee);
    // As in a chat: a searched request costs at least its tokens plus the fee.
    const dollars = Math.max(reported ?? tokenCost(m, input, out), tokenCost(m, input, out) + cfg.webSearchPrice);
    let receipt;
    try {
      receipt = settle(db, hold, usdUnits(dollars * factor), m.name, {
        model: m.id,
        usage: { prompt_tokens: input, completion_tokens: out, total_tokens: input + out },
        finish_reason: finish || "stop",
      });
    } finally {
      done();
    }

    // ---- Keep and answer ----
    const factcheck = {
      verdict: verdict.verdict,
      reason: verdict.reason,
      named: verdict.named,
      lang,
      credits_charged: receipt.credits_charged,
    };
    const privacy = trailLive(cfg)
      ? privacyTrail(cfg, {
          model: m,
          route,
          zeroDataRetention: isPrivate,
          storage,
          veilMasked,
          receiptId: null,
        })
      : null;
    const userText = factCheckUserText(claim);
    const replyText = factCheckText(verdict, lang);
    const saved = {
      text: replyText,
      reasoning: "",
      images: [],
      usage: { prompt_tokens: input, completion_tokens: out, total_tokens: input + out },
      finish_reason: finish || "stop",
      request_id: requestId,
      ...(verdict.sources.length ? { citations: verdict.sources } : {}),
      factcheck,
      ...(privacy ? { privacy } : {}),
    };
    let ids = null;
    if (!ephemeral) {
      // Both turns at once, so a failed check never leaves half of one.
      const title = (lang === "zh" ? "事实核查：" : "Fact-check: ") + claim.replace(/\s+/g, " ").slice(0, 58);
      conversation ||= newConversation(user, title, "chat");
      if (project) ctx.projects.file(conversation, project.id, user);
      ids = { user: uid("m_"), assistant: uid("m_") };
      const insert = db.prepare(
        "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
      );
      const at = now();
      insert.run(ids.user, conversation, "user", JSON.stringify(userText), m.id, 0, at, user);
      insert.run(ids.assistant, conversation, "assistant", JSON.stringify(saved), m.id, receipt.charged, at + 1, user);
      db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(now(), conversation);
    }
    res.json({
      conversationId: conversation,
      user_message: { ...(ids ? { id: ids.user } : {}), text: userText },
      message: {
        ...(ids ? { id: ids.assistant } : {}),
        text: replyText,
        citations: verdict.sources,
        factcheck,
      },
      anonyma: {
        credits_charged: receipt.credits_charged,
        request_id: requestId,
        finish_reason: finish || "stop",
        ...(cfg.testMode ? { local_test: true } : {}),
        ...(isPrivate ? { private: { privacy: "zdr", stored: false } } : {}),
        ...(privacy ? { privacy } : {}),
      },
    });
  });
}
