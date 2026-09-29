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
import { isSealedModel } from "../../src/sealed.js";
import {
  LIMITS,
  cleanAnswer,
  maskedFrom,
  queryTerms,
  questionLanguage,
  sourcesMarkdown,
  titleFor,
} from "../../src/file-search.js";
import {
  fileSearchCost,
  ownedDocuments,
  pinnedIds,
  scopeSize,
  searchPassages,
  searchableFiles,
  storedPassages,
} from "../file-search.js";

// File Search (update "filesearch", which needs Files & Reusable Uploads and
// Documents too; see featuresFor). A question is matched against the text of
// the account's saved files (server/file-search.js), the best few passages
// are shown, and only the passages the person keeps go to the chosen model,
// as numbered data (src/file-search.js). The answer cites them by number,
// and only numbers that were sent are kept.
//
// Money: /api/file-search/quote prices the question and passages exactly as
// they will be sent. A run holds that same maximum before anything is sent
// (the run is refused with 409 estimate_changed if the page's figure is any
// other), so the maximum shown, the balance and Spending Limits checks and
// the hold are one number. It settles on actual usage only when the answer
// can be used. A failed, refused, stopped, empty or cut-off-with-nothing
// answer is released and charges nothing. Workspace only, from the
// account's own balance: no API key, so no allowance applies.
//
// Privacy: retrieval (the search route) sends nothing to a model, stores
// nothing and logs nothing. A run sends the question, the kept passages and
// fixed instructions, never the files, their names or their other text. The
// page masks the question and passages with Veil first; the server accepts
// a passage only if it is the stored one, or the stored one with details
// replaced by Veil's tags. Private Mode uses zero-data-retention models
// only, with no failover, and keeps nothing. Off the record keeps nothing.
// A saved answer is an ordinary conversation (the question, the answer and
// the files and places it cites, never the passage text), so History,
// Bookmarks, Export, Share, erase and the account export cover it.
export const FILE_SEARCH_CUT_SHORT =
  "The model ran out of room before it wrote an answer, so there's no result. Nothing was charged. Try again, or choose another model.";
export const FILE_SEARCH_EMPTY =
  "The model returned no answer, so there's no result. Nothing was charged. Try again, or choose another model.";
export const FILE_SEARCH_CHANGED =
  "The estimate changed since it was shown. Check the new one, then ask again. Nothing was charged.";
export const FILE_SEARCH_FAILED = "The question couldn't be answered. Nothing was charged. Try again, or choose another model.";
const BUDGET_CODES = ["insufficient_credits", "spending_limit"];
// Fields a File Search run never takes: it is only the question and passages.
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
  "depth",
  "treasury",
  "translate",
];
const validTokens = (value, fallback) => (Number.isSafeInteger(value) && value >= 0 ? value : fallback);
const questionOf = (body) => {
  const question = typeof body?.question === "string" ? body.question.trim() : "";
  if (question.length < 2 || question.length > LIMITS.question)
    fail(400, `Ask a question of 2 to ${LIMITS.question.toLocaleString("en-US")} characters.`, "invalid_request");
  return question;
};

export function fileSearchRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight, fallback } = ctx;
  const { getModel } = ctx.models;
  const { newConversation } = ctx.conversations;

  // The files a search covers: the ones named, or a project's pinned files
  // (its own, checked), or null for all of them.
  function fileScope(req, body) {
    const named = Object.hasOwn(body, "files"),
      project = Object.hasOwn(body, "project");
    if (named && project) fail(400, "Choose files or a project, not both.", "invalid_request");
    if (named) return ownedDocuments(db, req.user.id, body.files);
    if (project) {
      const id = body.project;
      const row =
        typeof id === "string" && db.prepare("SELECT id FROM projects WHERE id=? AND user_id=?").get(id, req.user.id);
      if (!row) fail(404, "Project not found.", "project_not_found");
      return pinnedIds(db, req.user.id, row.id);
    }
    return null;
  }

  // The account's searchable files, and its projects' pins when Projects is
  // live. Reading them takes the first search's work: the index is filled.
  app.get("/api/file-search/files", requireUser, limit("filesearch_files", 120, 60000), (req, res) => {
    ctx.files.cleanup();
    const files = searchableFiles(db, cfg, req.user.id);
    const projects = isReleased(cfg, "projects")
      ? db
          .prepare("SELECT id,name,color,starts privacy FROM projects WHERE user_id=? ORDER BY created,rowid")
          .all(req.user.id)
          .map((p) => ({ ...p, files: pinnedIds(db, req.user.id, p.id).filter((id) => files.some((f) => f.id === id)) }))
          .filter((p) => p.files.length)
      : [];
    res.json({
      files: files.map(({ created, ...f }) => f),
      projects,
      passages: files.reduce((n, f) => n + f.passages, 0),
      top: LIMITS.top,
      most: LIMITS.most,
    });
  });

  // Retrieval: the best passages for a question, in order. It sends nothing
  // to a model, holds nothing, stores nothing and logs nothing.
  app.post("/api/file-search/search", requireUser, limit("filesearch_search", 60, 60000), (req, res) => {
    const body = req.body || {};
    const question = questionOf(body);
    ctx.files.cleanup();
    const files = fileScope(req, body);
    const { words, runs } = queryTerms(question);
    if (!words.length && !runs.length)
      fail(400, "That question has nothing to look for. Add a few words about what you want to find.", "no_search_terms");
    const passages = searchPassages(db, cfg, req.user.id, question, { files });
    res.json({ passages, searched: scopeSize(db, req.user.id, files), top: LIMITS.top });
  });

  // Everything a quote and a run share, checked before anything is held.
  function prepare(req) {
    const body = req.body || {};
    for (const key of CONTEXT_FIELDS)
      if (body[key] !== undefined && body[key] !== null)
        fail(400, "File Search sends only your question and the passages you keep, so it can't be combined with other chat options.", "invalid_request");
    const question = questionOf(body);
    const list = body.passages;
    if (!Array.isArray(list) || !list.length || list.length > LIMITS.most)
      fail(400, `Send 1 to ${LIMITS.most} passages.`, "invalid_request");
    if (list.some((p) => !p || typeof p !== "object" || Array.isArray(p)))
      fail(400, "Each passage needs its id and its text.", "invalid_request");
    const ids = list.map((p) => p.id);
    if (
      ids.some((id) => !Number.isSafeInteger(id) || id < 1) ||
      new Set(ids).size !== ids.length ||
      list.some(
        (p) => typeof p.text !== "string" || !p.text.trim() || p.text.length > LIMITS.passage || Object.keys(p).some((k) => !["id", "text"].includes(k)),
      )
    )
      fail(400, "Each passage needs its id and its text.", "invalid_request");
    const stored = storedPassages(db, req.user.id, ids);
    // The text of each, exactly the stored passage or the stored passage
    // with details masked by Veil.
    const passages = list.map((p) => {
      const row = stored.get(p.id);
      if (!row) fail(404, "A passage is no longer there: its file was deleted or has expired. Search again.", "passage_unavailable");
      if (!maskedFrom(row.text, p.text)) fail(400, "A passage doesn't match your saved file. Search again.", "passage_changed");
      return { id: row.id, file: row.file_id, name: row.file, kind: row.kind, section: row.section, text: p.text };
    });
    const m = getModel(body.model);
    // Early Model Access applies here as it does to a chat.
    ctx.earlyModels.check(viewerOf(req), "models", m.id);
    if (m.type !== "chat" || imageCallable(m)) fail(400, "File Search needs a text model.", "unsupported_model");
    if (isSealedModel(m))
      fail(400, "Sealed Mode models can't search saved files: those live on ANONYMA's server. Choose another model.", "unsupported_model");
    const isPrivate = body.private === true;
    if (isPrivate && !isPrivateModel(m, cfg)) fail(400, "Private mode needs a model with zero data retention.", "private_model_required");
    const ephemeral = body.ephemeral === true || isPrivate;
    const factor = markupFactor(req.user, cfg);
    const cost = fileSearchCost({ cfg, m, question, passages, factor });
    ctx.models.validateContext(cost.messages, m, cost.budget);
    return { body, question, passages, m, isPrivate, ephemeral, factor, cost };
  }

  // Quoting holds, sends and stores nothing.
  app.post("/api/file-search/quote", requireUser, limit("filesearch_quote", 120, 60000), (req, res) => {
    const { m, cost, passages } = prepare(req);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(cost.amount),
      units: cost.amount,
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      model: m.id,
      passages: passages.length,
      estimate: true,
    });
  });

  app.post("/api/file-search", requireUser, limit("filesearch", 20, 60000), async (req, res) => {
    const { body, question, passages, m, isPrivate, ephemeral, factor, cost } = prepare(req);
    const veilMasked = veilMaskedFrom(body);
    // Seed Guard, with the chat's own "Send anyway" (allow_seed_phrase,
    // gated in featuresFor): a question or passage holding a wallet recovery
    // phrase is refused before anything is held.
    if (
      isReleased(cfg, "seedguard") &&
      body.allow_seed_phrase !== true &&
      [question, ...passages.map((p) => p.text)].some((t) => findSeedPhrase(t))
    )
      fail(400, SEED_MESSAGE, "seed_phrase_blocked");
    // The shown maximum is what's held: a page showing another figure (an
    // old quote) is refused, and quotes again.
    if (body.max_units !== cost.amount) fail(409, FILE_SEARCH_CHANGED, "estimate_changed");
    const user = req.user.id;
    const requestId = requestIdentifier(req);
    const storage = storageFor({ api: false, isPrivate, ephemeral });

    // ---- Hold the maximum, exactly what was shown ----
    const hold = `${user}:${requestId}`;
    reserve(db, { id: hold, user, amount: cost.amount, ttl: 10 * 60000 });
    // Filed like an ordinary chat in Usage Insights: the model, never what
    // it was for.
    tagUsage(db, cfg, hold, { feature: "chat", model: m.id });
    inflight.holds.add(hold);
    const controller = new AbortController();
    inflight.controllers.add(controller);
    // Leaving (Stop) cancels the answer; it's released, not charged.
    res.on("close", () => {
      if (!res.writableEnded) controller.abort(new Error("Client disconnected"));
    });
    const timer = setTimeout(() => controller.abort(new Error("Provider timeout")), cfg.requestTimeoutMs || 240000);
    const done = () => {
      clearTimeout(timer);
      inflight.controllers.delete(controller);
      inflight.holds.delete(hold);
    };

    // ---- One model call, through the same gateway, failover and ZDR rules
    // as a chat: a private answer never fails over, and nothing fails over
    // once the provider has accepted it. ----
    const upstream = { model: m.id, messages: cost.messages, max_tokens: cost.budget, ...(isPrivate ? ZDR_ROUTING : {}) };
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
    // Model Status (server/model-status.js): this call's outcome and
    // timings, counted like a chat's. Only the model id.
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
      probe.fail(e, controller.signal);
      release(db, hold);
      done();
      if (controller.signal.aborted && res.destroyed) return;
      if (e?.status) throw e;
      fail(502, FILE_SEARCH_FAILED, "file_search_failed");
    }

    // ---- Read the answer: only numbers that were sent stay cited ----
    const answer = cleanAnswer(text, passages.length);
    if (!answer.text) {
      release(db, hold);
      done();
      fail(502, finish === "length" ? FILE_SEARCH_CUT_SHORT : FILE_SEARCH_EMPTY, finish === "length" ? "file_search_cut_short" : "file_search_empty");
    }
    const cutShort = finish === "length";

    // ---- Charge what it used ----
    const input = validTokens(usage?.prompt_tokens, validTokens(usage?.input_tokens, Math.ceil(JSON.stringify(cost.messages).length / 4)));
    const out = validTokens(usage?.completion_tokens, validTokens(usage?.output_tokens, Math.ceil((text + reasoning).length / 4)));
    const fee = route === "backup" ? cfg.gateway2FeePercent : cfg.gatewayFeePercent;
    const dollars = reportedProviderCost(usage, upstreamCost, fee) ?? tokenCost(m, input, out);
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
    const sources = passages.map((p, i) => ({
      n: i + 1,
      passage: p.id,
      file_id: p.file,
      file: p.name,
      kind: p.kind,
      section: p.section,
      cited: answer.cited.includes(i + 1),
    }));
    const privacy = trailLive(cfg)
      ? privacyTrail(cfg, { model: m, route, zeroDataRetention: isPrivate, storage, veilMasked, receiptId: null })
      : null;
    let ids = null,
      conversation = null;
    if (!ephemeral) {
      // Both turns at once, so a failed answer never leaves half of one. The
      // saved text names the files and places cited, never the passages.
      const lang = questionLanguage(question);
      const saved = {
        text: answer.text + "\n\n" + sourcesMarkdown(sources, lang),
        reasoning: "",
        images: [],
        usage: { prompt_tokens: input, completion_tokens: out, total_tokens: input + out },
        finish_reason: finish || "stop",
        request_id: requestId,
        filesearch: { answer_chars: answer.text.length, sources, ...(cutShort ? { cut_short: true } : {}) },
        ...(privacy ? { privacy } : {}),
      };
      conversation = newConversation(user, titleFor(question, lang), "chat");
      ids = { user: uid("m_"), assistant: uid("m_") };
      const insert = db.prepare(
        "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
      );
      const at = now();
      insert.run(ids.user, conversation, "user", JSON.stringify(question), m.id, 0, at, user);
      insert.run(ids.assistant, conversation, "assistant", JSON.stringify(saved), m.id, receipt.charged, at + 1, user);
      db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(now(), conversation);
    }
    res.json({
      conversationId: conversation,
      user_message: { ...(ids ? { id: ids.user } : {}), text: question },
      message: { ...(ids ? { id: ids.assistant } : {}), text: answer.text, sources, ...(cutShort ? { cut_short: true } : {}) },
      anonyma: {
        credits_charged: receipt.credits_charged,
        request_id: requestId,
        finish_reason: finish || "stop",
        stored: !ephemeral,
        ...(cfg.testMode ? { local_test: true } : {}),
        ...(isPrivate ? { private: { privacy: "zdr", stored: false } } : {}),
        ...(privacy ? { privacy } : {}),
      },
    });
  });
}
