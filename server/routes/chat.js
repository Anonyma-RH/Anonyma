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
  quote,
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

// Attached documents follow the typed prompt as <document> blocks
// (src/documents.js): the prompt names the chat, or the first file's name
// when only documents were sent.
function chatTitle(content) {
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
    // Seed Guard: refused before anything is validated, reserved or stored.
    refuseSeedPhrase(cfg, req, api);
    if (!api) validateTaskRequest(req.body);
    const m = getModel(req.body.model);
    // Dedicated image models are priced per option and served by
    // /v1/images/generations; through chat they would be held at the
    // cheapest variant while the provider chooses the quality.
    if (m.type !== "chat")
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
    if (isPrivate && !isPrivateModel(m, cfg))
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
    const messages = validateMessages(ctx.files.expandMessages(req, req.body.messages), m, api),
      max = maxTokens(req.body.max_tokens, m);
    // Optional Memory Across Models (routes/memory.js): only this user's own
    // stored, enabled facts, and never over the API, off the record, in
    // Private Mode, in Symposium or Double-check, or in a shared
    // conversation. Sent upstream and priced like the rest of the request
    // (and counted against the context allowance); never saved with the
    // conversation.
    const memory = api ? null : ctx.memory.forRequest(req.user.id, req.body);
    const sent = withMemory(messages, memory?.message);
    ctx.models.validateContext(sent, m, max);
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
    const amount = Math.ceil(
      (quote(m, sent, max) + usdUnits(searchFee)) * factor,
    );
    // Off the record: nothing about the chat is written to storage, not even
    // the user's message. Billing is unaffected — only persistence changes.
    // Private Mode always takes this path too, so nothing it sends is saved.
    const ephemeral = !api && (req.body.ephemeral === true || isPrivate);
    const storage = storageFor({ api, isPrivate, ephemeral });
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
    // Team Treasury: with "Team pays" on, a collab conversation's request is
    // held on the collab's treasury account, within the member's limits.
    const team = teamPaid
      ? ctx.treasury.forChat(req.user.id, conversation, m.id, hold)
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
        // monthly budget), set in code, never from the request body.
        guard: team?.guard ?? req.reserveGuard,
      });
    const headroom = Math.ceil(amount * cfg.holdMargin);
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
        ].includes(e.code)
      )
        throw e;
      reservation(amount);
    }
    // Usage Insights: what this spend is filed under, without content.
    tagUsage(db, cfg, hold, {
      feature: chatFeature({ api, ephemeral, body: req.body, webSearch }),
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
    const showBilling = !api && isReleased(cfg, "chatcontrol");
    if (showBilling) send({ billing: billingFor(req.user.id, requestId), conversationId: conversation });
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
    try {
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
        for (const a of [
          ...(delta.annotations || []),
          ...(part.choices?.[0]?.message?.annotations || []),
        ])
          addCitation(a?.url_citation?.url, a?.url_citation?.title);
        for (const url of part.citations || []) addCitation(url);
        if (part.usage) usage = part.usage;
        if (Number.isFinite(part.cost)) upstreamCost = part.cost;
        if (part.choices?.length) {
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
      receipt = settle(db, hold, usdUnits(Number(dollars) * factor), m.name, {
        model: m.id,
        usage,
        finish_reason: finishReason || "stop",
      });
      attributeMediaCost(receipt);
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
      if (chargeReservation) {
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
          ),
          "Interrupted: " + m.name,
        );
        e.receipt = receipt;
      } else if (stoppedAfterAcceptance) {
        receipt = settle(
          db,
          hold,
          usdUnits((tokenCost(m, tokenCounts().input, 0) + searchFee) * factor),
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
    limit("api_ip", 120, 60000),
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
