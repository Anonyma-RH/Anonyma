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
import { requestIdentifier } from "../middleware.js";

// Streamed chat for the workspace and the compatible /v1 API.
export function chatRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, apiAuth, inflight } = ctx;
  const mediaStore = ctx.media;
  const { getModel, validateMessages, maxTokens } = ctx.models;
  const { ownConversation, newConversation } = ctx.conversations;
  const validTokenCount = (value, fallback) =>
    Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  async function runChat(req, res, api) {
    const m = getModel(req.body.model);
    if (!["chat", "image"].includes(m.type))
      fail(400, "This endpoint supports chat and compatible image models.");
    const messages = validateMessages(req.body.messages, m, api),
      max = maxTokens(req.body.max_tokens);
    const requestId = requestIdentifier(req);
    const hold = req.user.id + ":" + requestId;
    const factor = markupFactor(req.user, cfg);
    const amount = Math.ceil(quote(m, messages, max) * factor);
    let conversation = null;
    if (!api) {
      conversation = req.body.conversationId
        ? ownConversation(req.body.conversationId, req.user.id).id
        : null;
    }
    reserve(db, {
      id: hold,
      user: req.user.id,
      amount,
      key: req.apiKey?.id,
      ttl: api ? 300000 : 240000,
    });
    // Nothing can be sent upstream yet, so a failure here releases the hold
    // immediately instead of leaving credits reserved until it expires.
    if (!api)
      try {
        conversation ||= newConversation(
          req.user.id,
          typeof messages.at(-1).content === "string"
            ? messages.at(-1).content
            : "Image conversation",
          req.body.mode === "code" ? "code" : "chat",
        );
        db.prepare(
          "INSERT INTO messages(id,conversation_id,role,content,model,cost,created) VALUES(?,?,?,?,?,?,?)",
        ).run(
          uid("m_"),
          conversation,
          "user",
          JSON.stringify(messages.at(-1).content),
          m.id,
          0,
          now(),
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
    res.on("close", () => {
      if (!res.writableEnded)
        controller.abort(new Error("Client disconnected"));
    });
    const id = uid("chatcmpl_");
    let output = "",
      reasoning = "",
      usage = null,
      upstreamCost = null,
      receipt = null,
      accepted = false;
    const images = [];
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
    try {
      for await (const part of chatStream(
        cfg,
        { model: m.id, messages, max_tokens: max },
        controller.signal,
        () => (accepted = true),
      )) {
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
      const input = validTokenCount(
        usage?.prompt_tokens,
        validTokenCount(
          usage?.input_tokens,
          Math.ceil(JSON.stringify(messages).length / 4),
        ),
      );
      const out = validTokenCount(
        usage?.completion_tokens,
        validTokenCount(
          usage?.output_tokens,
          Math.ceil((output + reasoning).length / 4),
        ),
      );
      const dollars =
        reportedProviderCost(usage, upstreamCost) ??
        (imageCallable(m) ? generationPrice(m) : tokenCost(m, input, out));
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
      const extension = {
        credits_charged: receipt.credits_charged,
        request_id: requestId,
        ...(cfg.testMode ? { local_test: true } : {}),
      };
      if (
        conversation &&
        db.prepare("SELECT id FROM conversations WHERE id=?").get(conversation)
      )
        db.prepare(
          "INSERT INTO messages(id,conversation_id,role,content,model,cost,created) VALUES(?,?,?,?,?,?,?)",
        ).run(
          uid("m_"),
          conversation,
          "assistant",
          JSON.stringify({ text: output, reasoning, images: saved, usage }),
          m.id,
          receipt.charged,
          now(),
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
          " Reserved credits were charged under the failure-billing policy. Check activity before retrying.";
        e.receipt = receipt;
      } else if (output || reasoning || saved.length) {
        receipt = settle(
          db,
          hold,
          usdUnits(
            (saved.length && imageCallable(m)
              ? generationPrice(m)
              : tokenCost(
                  m,
                  validTokenCount(
                    usage?.prompt_tokens,
                    Math.ceil(JSON.stringify(messages).length / 4),
                  ),
                  validTokenCount(
                    usage?.completion_tokens,
                    Math.ceil((output + reasoning).length / 4),
                  ),
                )) * factor,
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
            "INSERT INTO messages(id,conversation_id,role,content,model,cost,created) VALUES(?,?,?,?,?,?,?)",
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
          );
      } else if (stoppedAfterAcceptance) {
        receipt = settle(
          db,
          hold,
          usdUnits(
            tokenCost(
              m,
              validTokenCount(
                usage?.prompt_tokens,
                Math.ceil(JSON.stringify(messages).length / 4),
              ),
              0,
            ) * factor,
          ),
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
}
