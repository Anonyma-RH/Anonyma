import { chatLimits } from "../../data/chat-limits.js";
import {
  uid,
  now,
  fail,
  credits,
  usdUnits,
  reserve,
  settle,
  release,
  imageCallable,
  chatPrice,
  tokenCost,
  generationPrice,
  markupFactor,
  standardFactor,
  wantsWebSearch,
  API_MEDIA_TTL_MS,
} from "../core.js";
import { chatStream, reportedProviderCost } from "../provider.js";
import { FAILOVER_CODES } from "../fallback.js";
import { requestIdentifier } from "../middleware.js";
import { isPrivateModel, ZDR_ROUTING } from "../private-mode.js";
import { isReleased } from "../releases.js";
import { buildReceiptPayload } from "../receipts.js";
import { providerKey, sameProvider } from "../../src/double-check.js";
import { validateTaskRequest } from "../task-tools.js";
import { withMemory } from "../../src/memory.js";
import { tagUsage, chatFeature } from "../usage-insights.js";
import { privacyTrail, storageFor, trailLive, veilMaskedFrom } from "../privacy-trail.js";
import { refuseSeedPhrase } from "../seed-guard.js";
import { viewerOf } from "../early-models.js";
import { apiRateLimit } from "../api-boost.js";
import { prepareSheetsRequest, sheetsBudget } from "../sheets.js";
import { prepareStudyRequest, studyBudget } from "../study.js";
import { prepareCompareRequest } from "../compare.js";
import { compareBudget } from "../../src/compare-spec.js";
import { prepareCatchupRequest, catchupBudget } from "../catchup.js";
import {
  askHelper,
  helperCharge,
  planAutoRequest,
  refuseAutoTask,
  requestSettings,
} from "../auto-model.js";
import { prepareCanvasRequest, canvasBudget, canvasVerdict } from "../canvas.js";
import { prepareSlidesRequest, slidesBudget, slidesAcceptor, streamedSlides } from "../slides.js";
import { prepareRepoRequest, repoBudget } from "../repo-reader.js";
import { prepareContractRequest, contractBudget, contractAcceptor } from "../contract-reader.js";
import { streamedItems } from "../../src/contract-reader.js";

// Attached documents follow the typed prompt as <document> blocks
// (src/documents.js): the prompt names the chat, or the first file's name
// when only documents were sent.
export function chatTitle(content) {
  const typed = content.split("\n\n<document ")[0];
  if (!typed.startsWith("<document")) return typed;
  return /\bname="([^"]*)"/.exec(typed)?.[1] || "Documents";
}

// Streamed chat for the workspace and the compatible /v1 API.
export function chatRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, apiAuth, inflight, fallback, receipts } =
    ctx;
  // Only the requesting account (including its team-paid spend) can read this.
  const billingFor = (user, requestId) => {
    const row = db.prepare(`SELECT h.* FROM holds h WHERE h.id=? AND (h.user_id=? OR EXISTS (SELECT 1 FROM treasury_spends s WHERE s.hold_id=h.id AND s.user_id=?))`)
      .get(user + ":" + requestId, user, user);
    return row ? {
      requestId, kind: row.kind, status: row.status, payer: row.user_id === user ? "personal" : "team",
      reserved: credits(row.amount), created: row.created, expires: row.expires,
      receipt: row.result ? JSON.parse(row.result) : null,
    } : null;
  };
  const mediaStore = ctx.media;
  const { getModel, validateMessages, maxTokens } = ctx.models;
  const { accessConversation, newConversation } = ctx.conversations;
  const validTokenCount = (value, fallback) =>
    Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  async function runChat(req, res, api) {
    // Study Mode: making a deck, whose messages are built here from its
    // checked `study` payload (server/study.js). It runs first, so a request
    // carrying `sheets` too is refused as a study request.
    const study = api ? undefined : prepareStudyRequest(req.body);
    // Slides: making a deck or regenerating one slide, built the same way
    // from its checked `slides` payload (server/slides.js), right after
    // Study, so a request carrying both is refused (each refuses ready-made
    // `messages`). Its release gate is in featuresFor. Only a reply that
    // reads as slides is paid for, and nothing else of it is sent (below).
    const slidesTask = api ? undefined : prepareSlidesRequest(req.body);
    if (slidesTask) req.acceptOutput = slidesAcceptor(slidesTask);
    // Document Compare: "Summarize changes" builds its messages here from
    // its checked `compare` payload (server/compare.js), before Sheets and
    // Seed Guard read them; after Study, so a request carrying both is
    // refused (each refuses ready-made `messages`). Its release gate is in
    // featuresFor.
    const compareTask = api ? undefined : prepareCompareRequest(req.body);
    // Local Sheets: a workspace sheets question's messages are built here
    // from its checked `sheets` payload (server/sheets.js), before Seed
    // Guard reads them. Its release gate is in featuresFor.
    const sheetsTask = api ? undefined : prepareSheetsRequest(req.body);
    // Summarize & Continue: a Catch me up request's messages are built the
    // same way from its checked transcript (server/catchup.js). Its release
    // gate is in featuresFor.
    const catchupTask = !api && prepareCatchupRequest(req.body);
    // Canvas: a suggestion's messages are built the same way from its
    // checked `canvas` payload (server/canvas.js), after the other built-
    // message modes, each of which refuses ready-made `messages`. Its
    // release gate is in featuresFor.
    const canvasTask = api ? undefined : prepareCanvasRequest(req.body);
    // Repo Reader: a question's messages are built the same way from its
    // checked `repo` payload (server/repo-reader.js): the question, a file
    // list and the excerpts the page showed, as data. After the other
    // built-message modes, each of which refuses ready-made `messages`. Its
    // release gate is in featuresFor. Seed Guard reads only the question
    // (the excerpts are a public repo's files, like a read page), with no
    // override.
    const repoTask = api ? undefined : prepareRepoRequest(req.body);
    if (repoTask) req.seedTexts = [repoTask.question];
    // Contract Reader: an explanation's messages are built the same way from
    // the read the server holds for `contract.id` (server/contract-reader.js):
    // the facts it read and the verified source, as data. Its release gate is
    // in featuresFor. Nothing the person typed is sent (only the address and
    // public code), so Seed Guard has nothing to read. Only a reply that
    // reads as a contract reading is paid for, and nothing else of it is sent
    // (below); an unusable one releases its hold.
    const contractTask = api ? undefined : prepareContractRequest(req, ctx.contractReader.cache);
    if (contractTask) {
      req.seedTexts = [];
      req.acceptOutput = contractAcceptor();
    }
    // Seed Guard: refused before anything is validated, reserved or stored.
    refuseSeedPhrase(cfg, req, api);
    if (!api) validateTaskRequest(req.body);
    // Auto Model (server/auto-model.js): a workspace chat, code or Uncensored
    // message that sends `auto` (and no model) has its model chosen below,
    // from the models that request may use; everything that picks its own
    // model is refused. Its release gate is in featuresFor. Never the API.
    const autoAsked = !api && req.body.auto !== undefined;
    if (autoAsked)
      refuseAutoTask(req.body, {
        task: !!(study || compareTask || sheetsTask || catchupTask || repoTask || contractTask),
        blind: !!req.blind,
      });
    const autoSettings = autoAsked ? requestSettings(req.body) : null;
    // Chosen once Auto has decided (at once by its rules, or after its
    // helper, once the most it can cost is held).
    let m = autoAsked ? null : getModel(req.body.model);
    // Early Model Access: a model in its first days is for Insiders and up
    // (never a connected app), refused here before anything is reserved.
    // Covers the workspace, /v1, MCP ask and Routines, which all run here.
    // Auto never offers such a model to an account that can't use it.
    if (m) ctx.earlyModels.check(viewerOf(req), "models", m.id);
    // A sheets reply budget fitted to the chosen model (server/sheets.js).
    if (sheetsTask && m?.type === "chat")
      req.body.max_tokens = sheetsBudget(sheetsTask, m, req.body.messages);
    // A deck's reply budget fitted to the chosen model (server/study.js).
    if (study && m?.type === "chat")
      req.body.max_tokens = studyBudget(study, m, req.body.messages);
    // A deck's (or a slide's) reply budget fitted to the model (server/slides.js).
    if (slidesTask && m.type === "chat") {
      if (imageCallable(m)) fail(400, "Slides need a text model.", "unsupported_model");
      req.body.max_tokens = slidesBudget(slidesTask, m, req.body.messages);
    }
    // A summary's reply budget fitted to the chosen model (src/compare-spec.js).
    if (compareTask && m?.type === "chat")
      req.body.max_tokens = compareBudget(m, req.body.messages);
    // The summary's reply room, fitted to the model (server/catchup.js).
    if (catchupTask && m?.type === "chat") {
      if (imageCallable(m)) fail(400, "Catch me up needs a text model.", "unsupported_model");
      req.body.max_tokens = catchupBudget(m, req.body.messages);
    }
    // A repo answer's budget, fitted to the model (server/repo-reader.js).
    if (repoTask && m.type === "chat") {
      if (imageCallable(m)) fail(400, "Repo Reader needs a text model.", "unsupported_model");
      req.body.max_tokens = repoBudget(m, req.body.messages);
    }
    // A contract reading's reply room, fitted to the model (server/contract-reader.js).
    if (contractTask && m.type === "chat") {
      if (imageCallable(m)) fail(400, "Contract Reader needs a text model.", "unsupported_model");
      req.body.max_tokens = contractBudget(m, req.body.messages);
    }
    // A suggestion's reply budget, fitted to the model (refused when the
    // rewrite can't fit), and only a usable reply is paid for: one that
    // can't be read or was cut off releases its hold (canvasVerdict).
    if (canvasTask && m.type === "chat") {
      if (imageCallable(m)) fail(400, "Canvas needs a text model.", "unsupported_model");
      req.body.max_tokens = canvasBudget(canvasTask, m, req.body.messages);
      req.acceptOutput = canvasVerdict(canvasTask);
    }
    // Dedicated image models are priced per option and served by
    // /v1/images/generations; through chat they would be held at the
    // cheapest variant while the provider chooses the quality.
    if (m && m.type !== "chat")
      fail(
        400,
        m.type === "image"
          ? "Image models are available through image generation, not chat."
          : "This endpoint supports chat models.",
        "unsupported_model",
      );
    // Private Mode is released and dependency-gated in releases.js; here
    // only the chosen model itself is checked. Over the API only a
    // private-only connected app routes this way (set by the MCP server,
    // never by the request body).
    const isPrivate = api
      ? req.privateOnly === true
      : req.body.private === true;
    if (m && isPrivate && !isPrivateModel(m, cfg))
      fail(
        400,
        "Private mode needs a model with zero data retention.",
        "private_model_required",
      );
    // Privacy Trail: the browser's own Veil count (workspace only).
    const veilMasked = api ? undefined : veilMaskedFrom(req.body);
    // Double-check This: a second opinion must come from another provider,
    // and it never joins the conversation it reviews. It runs as a Symposium
    // request (saved apart, if saved at all), with the same ephemeral and
    // private handling as any chat, so the reviewed chat's storage is kept.
    // A saved check is a copy of the reviewed question and answer, so it
    // must name its source conversation (one this user can read) and is
    // linked to it: the schema then keeps it no longer than the source (its
    // absolute deadline, or the account default if sooner) and deletes it
    // with the source (see the source_id migration in core.js). Off the
    // record and Private checks store nothing.
    let checkSource;
    if (!api && req.body.double_check != null) {
      const id = req.body.double_check?.source_model;
      const source = typeof id === "string" ? ctx.models.find(id) : null;
      if (!source)
        fail(400, "Double-check needs the model that wrote the answer.", "invalid_request");
      // Unknown makers are never assumed to differ.
      if (!providerKey(source) || !providerKey(m))
        fail(
          400,
          "A second opinion needs models whose providers are known.",
          "double_check_provider_unknown",
        );
      if (sameProvider(m, source))
        fail(
          400,
          "Choose a model from a different provider for a second opinion.",
          "double_check_same_provider",
        );
      if (req.body.mode !== "symposium" || req.body.conversationId)
        fail(400, "A double-check runs on its own, apart from the conversation.", "invalid_request");
      const from = req.body.double_check.source_conversation;
      if (from != null) {
        if (typeof from !== "string")
          fail(400, "source_conversation must be a conversation id.", "invalid_request");
        checkSource = accessConversation(from, req.user.id);
        if (checkSource.source_id)
          fail(400, "A second opinion can't itself be double-checked.", "invalid_request");
      } else if (req.body.ephemeral !== true && !isPrivate)
        fail(
          400,
          "A saved double-check needs its source conversation.",
          "invalid_request",
        );
    }
    // Auto checks the messages without a model; which models can read their
    // images and fit them is part of its choice.
    const expanded = ctx.files.expandMessages(req, req.body.messages);
    const messages = m ? validateMessages(expanded, m, api) : ctx.models.checkMessages(expanded, api).messages;
    let max = m ? maxTokens(req.body.max_tokens, m) : 0;
    // Optional Memory Across Models (routes/memory.js): only this user's own
    // stored, enabled facts, and never over the API, off the record, in
    // Private Mode, in Symposium or Double-check, or in a shared
    // conversation. Sent upstream and priced like the rest of the request
    // (and counted against the context allowance); never saved with the
    // conversation.
    const memory = api ? null : ctx.memory.forRequest(req.user.id, req.body);
    const sent = withMemory(messages, memory?.message);
    const requestId = requestIdentifier(req);
    const hold = req.user.id + ":" + requestId;
    // Team Treasury "Team pays": held on the collab's treasury (see below).
    const teamPaid = !api && req.body.treasury === true;
    // A connected app (set by the MCP server, never by the request body)
    // pays the standard rate. So does a team-paid request: every member sees
    // its charge, so it must say nothing about the requester's account.
    const factor =
      req.standardRate === true || teamPaid
        ? standardFactor(cfg)
        : markupFactor(req.user, cfg);
    // Web search is a PPQ plugin with its own per-request fee.
    const webSearch = wantsWebSearch(req.body);
    const searchFee = webSearch ? cfg.webSearchPrice : 0;
    // Auto's plan: decided by its rules (a model now), or pending its helper,
    // in which case the most it can cost (the dearest model it could land
    // on, plus the helper) is what's held, exactly as /api/quote shows it.
    const auto = autoAsked
      ? planAutoRequest(ctx, req, {
          sent,
          isPrivate,
          mode: req.body.mode ?? "chat",
          settings: autoSettings,
          factor,
          searchFee,
        })
      : null;
    // What the reply's chip says: ids and codes only (src/auto-model.js).
    let autoInfo = null,
      helperCharged = 0,
      helperAsked = false;
    const chooseAuto = ({ tier, reason, model }, via) => {
      m = model;
      max = auto.budget(m);
      autoInfo = {
        model: m.id,
        tier,
        reason,
        via,
        prefer: auto.settings.prefer,
        helper: helperAsked ? { model: auto.helper.id, credits: credits(helperCharged) } : null,
      };
    };
    if (auto?.chosen) chooseAuto(auto.chosen, "rules");
    if (m) ctx.models.validateContext(sent, m, max);
    let amount = m ? chatPrice(m, sent, max, searchFee, factor) : auto.amount;
    // Off the record: nothing about the chat is written to storage, not even
    // the user's message. Billing is unaffected — only persistence changes.
    // Private Mode always takes this path too, so nothing it sends is saved.
    const ephemeral = !api && (req.body.ephemeral === true || isPrivate);
    // Blind Compare (routes/blind.js) runs each side as an unsaved chat and
    // saves the round itself, so the trail reports where the round is kept.
    const storage = req.blind?.storage || storageFor({ api, isPrivate, ephemeral });
    if (ephemeral && req.body.conversationId)
      fail(
        400,
        "An off-the-record chat can't be added to a saved conversation.",
        "invalid_request",
      );
    let conversation = null;
    if (!api && !ephemeral) {
      conversation = req.body.conversationId
        ? accessConversation(req.body.conversationId, req.user.id).id
        : null;
    }
    // Projects: a new saved chat (or Symposium run) can be filed in one of
    // the account's own projects, checked before anything is reserved. Off
    // the record, Private Mode and Device only chats are never saved, so
    // never filed: such a request is refused rather than tell the server
    // which project an unsaved chat belongs to. A saved chat is moved with
    // /api/projects/{id}/chats, never by a message added to it.
    let project = null;
    if (!api && req.body.project != null) {
      if (ephemeral)
        fail(
          400,
          "Off-the-record and Private chats are never saved, so they aren't filed in a project.",
          "invalid_request",
        );
      if (req.body.conversationId)
        fail(
          400,
          "A saved chat moves between projects from its details, not with a new message.",
          "invalid_request",
        );
      project = ctx.projects.forChat(req.user.id, req.body.project);
    }
    // Team Treasury: with "Team pays" on, a collab conversation's request is
    // held on the collab's treasury account, within the member's limits.
    const team = teamPaid
      ? ctx.treasury.forChat(req.user.id, conversation, m?.id ?? "auto", hold)
      : null;
    // Published token prices are a floor: the gateway may route to a pricier
    // provider (a live Llama request cost about 3x its listed rate). Hold
    // headroom when the balance and key cap allow it; settlement still
    // charges only the actual cost, and failure policies use `amount`.
    const reservation = (held) =>
      reserve(db, {
        id: hold,
        user: team?.account ?? req.user.id,
        amount: held,
        key: req.apiKey?.id,
        ttl: api ? 300000 : 240000,
        // A server-side caller's own rules (Routines' per-run maximum and
        // monthly budget, Page Watch's monthly budget), set in code, never
        // from the request body.
        guard: team?.guard ?? req.reserveGuard,
      });
    // Auto promises one maximum for its quote, limit check and reservation.
    // Slides, Repo Reader questions and Contract Reader explanations hold
    // exactly the quoted maximum (server/slides.js, server/repo-reader.js,
    // server/contract-reader.js): the "up to" figure shown, the balance and
    // limit checks and the hold are one number.
    const headroom = auto || slidesTask || repoTask || contractTask ? amount : Math.ceil(amount * cfg.holdMargin);
    try {
      reservation(headroom);
    } catch (e) {
      if (
        headroom <= amount ||
        ![
          "insufficient_credits",
          "key_cap_exceeded",
          "allowance_exhausted",
          "treasury_insufficient",
          "treasury_limit",
          "spending_limit",
          "routine_run_cap",
          "routine_budget",
          "watch_budget",
        ].includes(e.code)
      )
        throw e;
      reservation(amount);
    }
    // Auto's helper, when its rules were unsure: one small call on this same
    // hold, sent only the newest message's typed text and a few counts. A
    // usable answer picks the tier and is charged with the message; anything
    // else (a failure, a timeout, an unusable answer) leaves the message on
    // Balanced and costs nothing. Leaving now releases the hold.
    if (auto?.pending) {
      helperAsked = true;
      const helperStop = new AbortController();
      const leave = () => {
        if (!res.writableEnded) helperStop.abort(new Error("Client disconnected"));
      };
      res.on("close", leave);
      inflight.controllers.add(helperStop);
      inflight.holds.add(hold);
      let asked;
      try {
        asked = await askHelper(ctx, {
          model: auto.helper,
          messages: auto.helperSent,
          budget: auto.helperRoom,
          isPrivate,
          signal: helperStop.signal,
        });
      } finally {
        res.off("close", leave);
        inflight.controllers.delete(helperStop);
        inflight.holds.delete(hold);
      }
      if (helperStop.signal.aborted) {
        release(db, hold);
        return;
      }
      const choice = asked.choice;
      if (choice) helperCharged = helperCharge(asked.usd, factor, auto.helperMax);
      const tier = choice?.tier || "balanced";
      chooseAuto(
        { tier, reason: choice ? choice.reason : "general", model: auto.row(auto.plan.tiers[tier] || auto.plan.tiers.balanced) },
        choice ? "helper" : "fallback",
      );
      // After the choice, a failure-policy charge is the chosen model's
      // estimate plus the helper's actual cost; settlement is on actuals.
      amount = chatPrice(m, sent, max, searchFee, factor) + helperCharged;
      if (team) db.prepare("UPDATE treasury_spends SET model=? WHERE hold_id=?").run(m.id, hold);
    }
    // Usage Insights: what this spend is filed under, without content.
    tagUsage(db, cfg, hold, {
      feature: req.blind?.feature || chatFeature({ api, ephemeral, body: req.body, webSearch }),
      model: m.id,
    });
    // Nothing can be sent upstream yet, so a failure here releases the hold
    // immediately instead of leaving credits reserved until it expires.
    if (!api && !ephemeral)
      try {
        conversation ||= newConversation(
          req.user.id,
          typeof messages.at(-1).content === "string"
            ? chatTitle(messages.at(-1).content)
            : "Image conversation",
          ["code", "uncensored", "symposium"].includes(req.body.mode) ? req.body.mode : "chat",
        );
        if (checkSource)
          db.prepare("UPDATE conversations SET source_id=? WHERE id=?").run(
            checkSource.id,
            conversation,
          );
        if (project) ctx.projects.file(conversation, project.id, req.user.id);
        db.prepare(
          "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          uid("m_"),
          conversation,
          "user",
          JSON.stringify(messages.at(-1).content),
          m.id,
          0,
          now(),
          req.user.id,
        );
        db.prepare("UPDATE conversations SET updated=? WHERE id=?").run(
          now(),
          conversation,
        );
      } catch (e) {
        release(db, hold);
        throw e;
      }
    const streaming = api ? req.body.stream === true : true;
    const controller = new AbortController();
    inflight.controllers.add(controller);
    inflight.holds.add(hold);
    const timeout = setTimeout(
      () => controller.abort(new Error("Provider timeout")),
      cfg.requestTimeoutMs || (api ? 120000 : 240000),
    );
    // Cancelling before the provider answers doesn't reliably stop its work
    // (a live check was billed for generation after such an abort), while
    // cancelling once it has accepted does. So a client that leaves early is
    // held until acceptance (or 15 seconds), then stopped like Stop.
    let clientGone = false, clientStopTimer;
    const stopForClient = () =>
      controller.abort(new Error("Client disconnected"));
    res.on("close", () => {
      if (res.writableEnded) return;
      clientGone = true;
      if (accepted) stopForClient();
      else clientStopTimer = setTimeout(stopForClient, 15000).unref();
    });
    const id = uid("chatcmpl_");
    let output = "",
      reasoning = "",
      usage = null,
      upstreamCost = null,
      receipt = null,
      accepted = false;
    // Provider token counts (OpenAI or PPQ field names), else estimates.
    const tokenCounts = () => ({
      input: validTokenCount(
        usage?.prompt_tokens,
        validTokenCount(
          usage?.input_tokens,
          Math.ceil(JSON.stringify(sent).length / 4),
        ),
      ),
      out: validTokenCount(
        usage?.completion_tokens,
        validTokenCount(
          usage?.output_tokens,
          Math.ceil((output + reasoning).length / 4),
        ),
      ),
    });
    const images = [];
    const citations = [];
    let slidesStarted = 0,
      contractItems = 0;
    // Sources the provider cited for a web search, deduplicated and capped.
    const addCitation = (url, title) => {
      if (
        typeof url !== "string" ||
        !/^https?:\/\//.test(url) ||
        citations.length >= 12 ||
        citations.some((c) => c.url === url)
      )
        return;
      citations.push({
        url: url.slice(0, 2000),
        title: typeof title === "string" ? title.slice(0, 300) : "",
      });
    };
    const saved = [];
    const savedMediaIds = [];
    const attributeMediaCost = (receipt) =>
      mediaStore.assignCosts(savedMediaIds, receipt.charged, req.user.id);
    const chunk = (delta) => ({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(now() / 1000),
      model: m.id,
      ...delta,
    });
    if (streaming) {
      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.flushHeaders();
    }
    const send = (v) => {
      if (streaming && !res.destroyed)
        res.write(`data: ${JSON.stringify(v)}\n\n`);
    };
    const showBilling = !api && !req.blind && isReleased(cfg, "chatcontrol");
    if (showBilling) send({ billing: billingFor(req.user.id, requestId), conversationId: conversation });
    // Auto Model: which model is answering and why, before the reply starts.
    if (autoInfo) send({ auto: autoInfo });
    // Serve from the primary gateway, or from the backup when the primary
    // refuses before accepting; never after, so nothing is paid twice.
    let servedBy = "primary";
    let finishReason = null;
    // Privacy Trail for this request, once released: what the server knows
    // about where it went (server/privacy-trail.js). Never any prompt text.
    const trailFor = (receiptId) =>
      trailLive(cfg)
        ? privacyTrail(cfg, {
            model: m,
            route: servedBy,
            zeroDataRetention: isPrivate,
            storage,
            veilMasked,
            receiptId,
            // Auto's helper read the newest message too.
            helper: helperAsked ? auto.helper : null,
          })
        : null;
    const upstreamBody = {
      model: m.id,
      messages: sent,
      max_tokens: max,
      ...(webSearch ? { plugins: [{ id: "web", max_results: 5 }] } : {}),
      ...(isPrivate ? ZDR_ROUTING : {}),
    };
    const markAccepted = () => {
      accepted = true;
      if (clientGone) stopForClient();
    };
    async function* stream() {
      try {
        yield* chatStream(cfg, upstreamBody, controller.signal, markAccepted);
      } catch (e) {
        // A private request never fails over: the backup gateway's
        // retention terms aren't known.
        if (
          accepted ||
          controller.signal.aborted ||
          isPrivate ||
          !FAILOVER_CODES.has(e.code)
        )
          throw e;
        const backupModel = await fallback.modelFor(m.id);
        if (!backupModel) throw e;
        // A larger request cannot silently move to an unverified backup cap.
        if (isReleased(cfg, "longanswers") && max > chatLimits(fallback.infoFor(backupModel)).maxOutputTokens) throw e;
        // The same model can have a smaller context window on another route.
        // Missing backup metadata uses the same conservative context allowance.
        try {
          ctx.models.validateContext(sent, { ...fallback.infoFor(backupModel), id: backupModel, type: "chat" }, max);
        } catch {
          throw e; // Keep the primary refusal; never send an incompatible fallback.
        }
        servedBy = "backup";
        yield* chatStream(
          fallback.cfg,
          { ...upstreamBody, model: backupModel },
          controller.signal,
          markAccepted,
        );
      }
    }
    const feePercent = () =>
      servedBy === "backup" ? cfg.gateway2FeePercent : cfg.gatewayFeePercent;
    // Model Status: this request's outcome and timings, from when it's sent
    // (server/model-status.js). Only the model id; nothing about the person.
    const probe = ctx.modelStatus.start(m.id);
    try {
      // Blind Compare holds both sides here until both are reserved, so a
      // refused side releases the other before anything is sent (set in
      // code by routes/blind.js, never from the request body).
      if (req.beforeSend) await req.beforeSend();
      probe.sent();
      for await (const part of stream()) {
        if (part.error)
          fail(
            502,
            part.error.message || "Provider error",
            "provider_rejected",
          );
        if (typeof part.choices?.[0]?.finish_reason === "string") finishReason = part.choices[0].finish_reason;
        const delta = part.choices?.[0]?.delta || {};
        if (typeof delta.content === "string") output += delta.content;
        if (
          typeof delta.reasoning === "string" ||
          typeof delta.reasoning_content === "string"
        )
          reasoning += delta.reasoning || delta.reasoning_content;
        if (delta.images) images.push(...delta.images);
        if (delta.content || delta.reasoning || delta.reasoning_content || delta.images?.length)
          probe.first();
        for (const a of [
          ...(delta.annotations || []),
          ...(part.choices?.[0]?.message?.annotations || []),
        ])
          addCitation(a?.url_citation?.url, a?.url_citation?.title);
        for (const url of part.citations || []) addCitation(url);
        if (part.usage) usage = part.usage;
        if (Number.isFinite(part.cost)) upstreamCost = part.cost;
        // Slides: the reply is held back until it reads as slides (sent
        // whole below); meanwhile only how many slides have started.
        if (slidesTask) {
          const started = streamedSlides(output);
          if (started !== slidesStarted) send({ slides: { started: (slidesStarted = started) } });
        } else if (contractTask) {
          // Contract Reader: held back the same way; only a count.
          const started = streamedItems(output);
          if (started !== contractItems) send({ contract: { started: (contractItems = started) } });
        } else if (part.choices?.length) {
          const { images: upstreamImages, ...normalizedDelta } = delta;
          send(
            chunk({
              choices: [
                {
                  index: 0,
                  delta: normalizedDelta,
                  finish_reason: part.choices[0].finish_reason || null,
                },
              ],
            }),
          );
        }
      }
      probe.done(!!(output || reasoning || images.length));
      // Images are downloaded before returning durable/private references.
      // A caller that returns text only (the MCP server) keeps none of them.
      const mediaSource = !api && !ephemeral && conversation && images.length
        ? accessConversation(conversation, req.user.id) : null;
      for (const img of req.discardMedia === true ? [] : images) {
        const source = img.image_url?.url || img.url;
        if (source) {
          const media = await mediaStore.saveMedia(
            req.user.id,
            "image",
            source,
            {
              prompt:
                !ephemeral && typeof messages.at(-1).content === "string"
                  ? messages.at(-1).content
                  : "",
              model: m.id,
              expires: api || ephemeral ? now() + API_MEDIA_TTL_MS : mediaSource?.expires || null,
              ...(!api && !ephemeral && conversation ? { sourceConversation: conversation } : {}),
              signal: controller.signal,
            },
          );
          saved.push({ type: "image_url", image_url: { url: media.url } });
          savedMediaIds.push(media.id);
        }
      }
      if (!output && !reasoning && !saved.length)
        fail(
          502,
          "The model returned no content. Nothing was charged.",
          "empty_output",
        );
      // A server-side caller that pays only for a reply it can use (Page
      // Watch, which runs unattended, and Canvas suggestions; set in code,
      // never from the request body) isn't charged for one it can't read:
      // the hold is released below, as for an empty reply. It may say why,
      // as { message, code }.
      const verdict = req.acceptOutput ? req.acceptOutput(output, finishReason || "stop") : true;
      if (verdict !== true)
        fail(
          502,
          verdict?.message || "The model's reply couldn't be used. Nothing was charged.",
          verdict?.code || "unusable_output",
        );
      const { input, out } = tokenCounts();
      const reported = reportedProviderCost(usage, upstreamCost, feePercent());
      // Whether the provider folds the search fee into its reported cost
      // isn't documented, so a searched request costs at least the token
      // estimate plus the fee.
      const dollars = Math.max(
        reported ??
          (imageCallable(m) ? generationPrice(m) : tokenCost(m, input, out)),
        webSearch ? tokenCost(m, input, out) + searchFee : 0,
      );
      usage = {
        ...usage,
        prompt_tokens: input,
        completion_tokens: out,
        total_tokens: input + out,
      };
      receipt = settle(db, hold, usdUnits(Number(dollars) * factor) + helperCharged, m.name, {
        model: m.id,
        usage,
        finish_reason: finishReason || "stop",
      });
      attributeMediaCost(receipt);
      // Slides and Contract Reader: the reply, whole, once it's known to be
      // usable and is paid for.
      if (slidesTask || contractTask)
        send(chunk({ choices: [{ index: 0, delta: { content: output }, finish_reason: finishReason || "stop" }] }));
      // An Ed25519-signed, independently verifiable copy of this receipt.
      // The signed id is the requestId alone, never the user-prefixed hold.
      let signedReceipt = null;
      if (isReleased(cfg, "receipts")) {
        // Best effort: the request is already settled, so a signing failure
        // must never cost the user the answer they paid for.
        try {
          const payload = buildReceiptPayload({
            id: requestId,
            service: cfg.publicUrl || cfg.origin,
            model: receipt.model,
            inputTokens: receipt.usage?.prompt_tokens,
            outputTokens: receipt.usage?.completion_tokens,
            creditsCharged: receipt.credits_charged,
            creditsReleased: receipt.released,
            keyId: receipts.keyId,
            requestMessages: sent,
            answerText: output,
          });
          const signature = receipts.sign(payload);
          db.prepare(
            "INSERT OR IGNORE INTO receipt_signatures(receipt_id,user_id,key_id,payload,signature,created) VALUES(?,?,?,?,?,?)",
          ).run(hold, req.user.id, receipts.keyId, JSON.stringify(payload), signature, now());
          signedReceipt = { receipt: payload, signature, key_id: receipts.keyId };
        } catch (e) {
          console.error("Receipt signing failed:", e.message);
        }
      }
      const privacy = trailFor(signedReceipt ? requestId : null);
      const extension = {
        credits_charged: receipt.credits_charged,
        request_id: requestId,
        finish_reason: finishReason || "stop",
        reply_budget: max,
        ...(citations.length ? { citations } : {}),
        ...(servedBy === "backup" ? { provider: "backup" } : {}),
        ...(cfg.testMode ? { local_test: true } : {}),
        ...(isPrivate
          ? { private: { privacy: "zdr", stored: false } }
          : {}),
        ...(signedReceipt ? { signed_receipt: signedReceipt } : {}),
        ...(privacy ? { privacy } : {}),
        ...(autoInfo ? { auto: autoInfo } : {}),
        // Exactly which facts went with this request, as sent.
        ...(req.body.memory != null && memory
          ? {
              memory: {
                used: memory.facts.length,
                facts: memory.facts,
                skipped: memory.skipped,
                ...(memory.reason ? { reason: memory.reason } : {}),
              },
            }
          : {}),
      };
      if (
        conversation &&
        db.prepare("SELECT id FROM conversations WHERE id=?").get(conversation)
      )
        db.prepare(
          "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
        ).run(
          uid("m_"),
          conversation,
          "assistant",
          JSON.stringify({
            text: output,
            reasoning,
            images: saved,
            usage,
            finish_reason: finishReason || "stop",
            request_id: requestId,
            ...(citations.length ? { citations } : {}),
            ...(privacy ? { privacy } : {}),
            ...(autoInfo ? { auto: autoInfo } : {}),
          }),
          m.id,
          receipt.charged,
          now(),
          req.user.id,
        );
      if (streaming) {
        if (saved.length)
          send(
            chunk({
              choices: [
                { index: 0, delta: { images: saved }, finish_reason: null },
              ],
            }),
          );
        send(
          chunk({
            choices: [],
            usage,
            askr: extension,
            anonyma: extension,
            ...(showBilling ? { billing: billingFor(req.user.id, requestId) } : {}),
            conversationId: conversation,
          }),
        );
        if (!res.destroyed) res.end("data: [DONE]\n\n");
      } else
        res.json({
          id,
          object: "chat.completion",
          created: Math.floor(now() / 1000),
          model: m.id,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: output,
                ...(reasoning ? { reasoning } : {}),
                ...(saved.length ? { images: saved } : {}),
                ...(citations.length ? { citations } : {}),
              },
              finish_reason: finishReason || "stop",
            },
          ],
          usage,
          askr: extension,
          anonyma: extension,
        });
    } catch (e) {
      probe.fail(e, controller.signal);
      const timedOut =
        controller.signal.aborted &&
        controller.signal.reason?.message === "Provider timeout";
      const chargeReservation = timedOut || e.code === "provider_unreadable";
      // The provider bills the prompt once it accepts a request, even if the
      // user stops before any output arrives.
      const stoppedAfterAcceptance =
        accepted &&
        controller.signal.aborted &&
        controller.signal.reason?.message === "Client disconnected";
      if (req.acceptOutput) {
        // Only a usable reply is paid for (see acceptOutput above): an
        // unusable, failed, timed-out or stopped request releases its hold,
        // whatever the failure-billing policy below would charge.
        release(db, hold);
        // A Contract Reader explanation always starts its own conversation;
        // one that ends with no reading isn't kept half-made.
        if (contractTask && conversation) {
          db.prepare("DELETE FROM conversations WHERE id=? AND user_id=?").run(conversation, req.user.id);
          conversation = null;
        }
        if (timedOut) {
          e.status = 504;
          e.code = "provider_timeout";
          e.message = "The provider deadline expired. Nothing was charged.";
        }
      } else if (chargeReservation) {
        receipt = settle(
          db,
          hold,
          amount,
          (timedOut ? "Timeout policy: " : "Unreadable response policy: ") +
            m.name,
        );
        e.status = timedOut ? 504 : 502;
        e.code = timedOut ? "provider_timeout" : "provider_unreadable";
        e.message =
          (timedOut
            ? "The provider deadline expired."
            : "The provider response could not be decoded.") +
          " The estimated cost was charged under the failure-billing policy. Check activity before retrying.";
        e.receipt = receipt;
      } else if (output || reasoning || saved.length) {
        receipt = settle(
          db,
          hold,
          usdUnits(
            (saved.length && imageCallable(m)
              ? generationPrice(m)
              : (reportedProviderCost(usage, upstreamCost, feePercent()) ??
                  tokenCost(m, tokenCounts().input, tokenCounts().out)) +
                (accepted ? searchFee : 0)) * factor,
          ) + helperCharged,
          "Interrupted: " + m.name,
        );
        e.receipt = receipt;
      } else if (stoppedAfterAcceptance) {
        receipt = settle(
          db,
          hold,
          usdUnits((tokenCost(m, tokenCounts().input, 0) + searchFee) * factor) + helperCharged,
          "Stopped before output: " + m.name,
        );
        e.receipt = receipt;
      } else release(db, hold);
      // A charged, interrupted reply still went somewhere; it has no signed
      // receipt.
      const privacy = receipt ? trailFor(null) : null;
      if ((output || reasoning || saved.length) &&
        receipt && (
          conversation &&
          db
            .prepare("SELECT id FROM conversations WHERE id=?")
            .get(conversation)
        ))
          db.prepare(
            "INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)",
          ).run(
            uid("m_"),
            conversation,
            "assistant",
            JSON.stringify({
              text: output,
              reasoning,
              images: saved,
              interrupted: true,
              finish_reason: timedOut ? "timeout" : "interrupted",
              request_id: requestId,
              ...(privacy ? { privacy } : {}),
              ...(autoInfo ? { auto: autoInfo } : {}),
            }),
            m.id,
            receipt.charged,
            now(),
            req.user.id,
          );

      if (receipt) attributeMediaCost(receipt);
      if (streaming) {
        send({
          error: {
            message:
              controller.signal.aborted && !timedOut
                ? "Generation stopped. Partial output may have been billed."
                : e.message,
            code: e.code || "generation_error",
          },
          anonyma: receipt
            ? {
                credits_charged: receipt.credits_charged,
                request_id: requestId,
                finish_reason: timedOut ? "timeout" : "interrupted",
                ...(privacy ? { privacy } : {}),
                ...(autoInfo ? { auto: autoInfo } : {}),
              }
            : undefined,
          ...(showBilling ? { billing: billingFor(req.user.id, requestId) } : {}),
          conversationId: conversation,
          ...(saved.length ? { images: saved } : {}),
        });
        if (!res.destroyed) res.end("data: [DONE]\n\n");
      } else throw e;
    } finally {
      clearTimeout(timeout);
      clearTimeout(clientStopTimer);
      inflight.controllers.delete(controller);
      inflight.holds.delete(hold);
    }
  }
  app.get("/api/requests/:id", requireUser, (req, res) => {
    const state = billingFor(req.user.id, req.params.id);
    if (!state) fail(404, "Request not found.");
    res.json(state);
  });
  app.post("/api/chat", requireUser, limit("chat", 20, 60000), async (req, res) => {
    try { await runChat(req, res, false); }
    catch (e) {
      // An explicit terminal refusal is different from a missing recovery
      // record after a network failure. Never turn a read-side 404 into free.
      const requestId = req.headers["idempotency-key"] ?? req.body.requestId;
      if (!res.headersSent && isReleased(cfg, "chatcontrol") && typeof requestId === "string" && requestId.trim() && requestId.length <= 200)
        e.billing = billingFor(req.user.id, requestId) || { requestId, status: "not_charged" };
      throw e;
    }
  });
  app.post(
    "/v1/chat/completions",
    // 120 a minute per IP; once API Boost is live, per account and IP,
    // raised by NYMA tier (server/api-boost.js).
    apiRateLimit(ctx),
    apiAuth,
    (req, res) => runChat(req, res, true),
  );
  app.all("/v1/*rest", (req, res) =>
    fail(
      404,
      isReleased(cfg, "v1media")
        ? "Unsupported endpoint. Use /v1/models, /v1/chat/completions, /v1/images/generations, /v1/audio/speech, /v1/audio/transcriptions or /v1/videos."
        : "Unsupported endpoint. Use /v1/models or /v1/chat/completions.",
      "unsupported_endpoint",
    ),
  );
  // Exposed so other entry points (the MCP server) can run a request through
  // the exact same hold -> settle path as /v1/chat/completions.
  return { runChat };
}
