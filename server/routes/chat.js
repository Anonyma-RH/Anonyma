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
} from "../core.js";
import { chatStream, reportedProviderCost } from "../provider.js";
import { FAILOVER_CODES } from "../fallback.js";
import { requestIdentifier } from "../middleware.js";
import { isPrivateModel, ZDR_ROUTING } from "../private-mode.js";
import { isReleased } from "../releases.js";
import { buildReceiptPayload } from "../receipts.js";

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
  const mediaStore = ctx.media;
  const { getModel, validateMessages, maxTokens } = ctx.models;
  const { accessConversation, newConversation } = ctx.conversations;
  const validTokenCount = (value, fallback) =>
    Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  async function runChat(req, res, api) {
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
    // only the chosen model itself is checked.
    const isPrivate = !api && req.body.private === true;
    if (isPrivate && !isPrivateModel(m, cfg))
      fail(
        400,
        "Private mode needs a model with zero data retention.",
        "private_model_required",
      );
    const messages = validateMessages(req.body.messages, m, api),
      max = maxTokens(req.body.max_tokens);
    const requestId = requestIdentifier(req);
    const hold = req.user.id + ":" + requestId;
    const factor = markupFactor(req.user, cfg);
    // Web search is a PPQ plugin with its own per-request fee.
    const webSearch =
      req.body.web_search === true ||
      (Array.isArray(req.body.plugins) &&
        req.body.plugins.some((p) => p?.id === "web"));
    const searchFee = webSearch ? cfg.webSearchPrice : 0;
    const amount = Math.ceil(
      (quote(m, messages, max) + usdUnits(searchFee)) * factor,
    );
    // Off the record: nothing about the chat is written to storage, not even
    // the user's message. Billing is unaffected — only persistence changes.
    // Private Mode always takes this path too, so nothing it sends is saved.
    const ephemeral = !api && (req.body.ephemeral === true || isPrivate);
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
    // Published token prices are a floor: the gateway may route to a pricier
    // provider (a live Llama request cost about 3x its listed rate). Hold
    // headroom when the balance and key cap allow it; settlement still
    // charges only the actual cost, and failure policies use `amount`.
    const reservation = (held) =>
      reserve(db, {
        id: hold,
        user: req.user.id,
        amount: held,
        key: req.apiKey?.id,
        ttl: api ? 300000 : 240000,
      });
    const headroom = Math.ceil(amount * cfg.holdMargin);
    try {
      reservation(headroom);
    } catch (e) {
      if (
        headroom <= amount ||
        !["insufficient_credits", "key_cap_exceeded", "allowance_exhausted"].includes(
          e.code,
        )
      )
        throw e;
      reservation(amount);
    }
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
    let clientGone = false;
    const stopForClient = () =>
      controller.abort(new Error("Client disconnected"));
    res.on("close", () => {
      if (res.writableEnded) return;
      clientGone = true;
      if (accepted) stopForClient();
      else setTimeout(stopForClient, 15000).unref();
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
          Math.ceil(JSON.stringify(messages).length / 4),
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
    // Serve from the primary gateway, or from the backup when the primary
    // refuses before accepting; never after, so nothing is paid twice.
    let servedBy = "primary";
    const upstreamBody = {
      model: m.id,
      messages,
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
      for (const img of images) {
        const source = img.image_url?.url || img.url;
        if (source) {
          const media = await mediaStore.saveMedia(
            req.user.id,
            "image",
            source,
            {
              prompt:
                typeof messages.at(-1).content === "string"
                  ? messages.at(-1).content
                  : "",
              model: m.id,
              expires: api ? now() + 86400000 : null,
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
            requestMessages: messages,
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
      const extension = {
        credits_charged: receipt.credits_charged,
        request_id: requestId,
        ...(citations.length ? { citations } : {}),
        ...(servedBy === "backup" ? { provider: "backup" } : {}),
        ...(cfg.testMode ? { local_test: true } : {}),
        ...(isPrivate
          ? { private: { privacy: "zdr", stored: false } }
          : {}),
        ...(signedReceipt ? { signed_receipt: signedReceipt } : {}),
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
            ...(citations.length ? { citations } : {}),
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
              finish_reason: "stop",
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
        if (
          conversation &&
          db
            .prepare("SELECT id FROM conversations WHERE id=?")
            .get(conversation)
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
              interrupted: true,
            }),
            m.id,
            receipt.charged,
            now(),
            req.user.id,
          );
      } else if (stoppedAfterAcceptance) {
        receipt = settle(
          db,
          hold,
          usdUnits((tokenCost(m, tokenCounts().input, 0) + searchFee) * factor),
          "Stopped before output: " + m.name,
        );
        e.receipt = receipt;
      } else release(db, hold);
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
            ? { credits_charged: receipt.credits_charged }
            : undefined,
          conversationId: conversation,
          ...(saved.length ? { images: saved } : {}),
        });
        if (!res.destroyed) res.end("data: [DONE]\n\n");
      } else throw e;
    } finally {
      clearTimeout(timeout);
      inflight.controllers.delete(controller);
      inflight.holds.delete(hold);
    }
  }
  app.get("/api/requests/:id", requireUser, (req, res) => {
    const row = db
      .prepare("SELECT * FROM holds WHERE id=? AND user_id=?")
      .get(req.user.id + ":" + req.params.id, req.user.id);
    if (!row) fail(404, "Request not found.");
    res.json({
      requestId: req.params.id,
      kind: row.kind,
      status: row.status,
      reserved: credits(row.amount),
      created: row.created,
      expires: row.expires,
      receipt: row.result ? JSON.parse(row.result) : null,
    });
  });
  app.post("/api/chat", requireUser, limit("chat", 20, 60000), (req, res) =>
    runChat(req, res, false),
  );
  app.post(
    "/v1/chat/completions",
    limit("api_ip", 120, 60000),
    apiAuth,
    (req, res) => runChat(req, res, true),
  );
  app.all("/v1/*rest", (req, res) =>
    fail(
      404,
      "Unsupported endpoint. Use /v1/models or /v1/chat/completions.",
      "unsupported_endpoint",
    ),
  );
  // Exposed so other entry points (the MCP server) can run a request through
  // the exact same hold -> settle path as /v1/chat/completions.
  return { runChat };
}
