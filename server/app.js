import express from "express";
import { openapi } from "./openapi.js";
import { publicDocumentation } from "./public-documentation.js";
import { recordPayment } from "./payments.js";
import {
  cliDownload,
  shellInstaller,
  powershellInstaller,
} from "./installers.js";
import cookieParser from "cookie-parser";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { loadCatalog, syncCatalog } from "./catalog.js";
import { createRatesFeed } from "./rates.js";
import { createMarketFeed } from "./market.js";
import { configurationStatus, assertNoTestCredits } from "./readiness.js";
import { videoOptions } from "./video-options.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  config,
  database,
  uid,
  hash,
  now,
  fail,
  balance,
  credits,
  usdUnits,
  addCredit,
  reserve,
  settle,
  release,
  catalog,
  callable,
  imageCallable,
  hasPublishedTokenRates,
  vision,
  quote,
  tokenCost,
  generationPrice,
  markupFactor,
  transaction,
} from "./core.js";
import { authRoutes, validIPN, refreshTokenHoldings } from "./auth.js";
import {
  chatStream,
  generateImages,
  createVideo,
  pollVideo,
  payment,
} from "./provider.js";

export function createApp(overrides = {}) {
  const cfg = config(overrides),
    db = database(cfg.dbPath),
    app = express();
  try {
    assertNoTestCredits(db, cfg);
  } catch (e) {
    db.close();
    throw e;
  }
  mkdirSync(cfg.mediaPath, { recursive: true });
  // A persistent installation secret makes signed URLs survive restarts.
  const secretFile = join(cfg.mediaPath, ".secret");
  if (!cfg.secret) {
    if (!existsSync(secretFile))
      writeFileSync(secretFile, uid() + uid(), { mode: 0o600 });
    cfg.secret = readFileSync(secretFile, "utf8");
  }
  let models = loadCatalog(cfg.catalogPath);
  let catalogRefresh = null;
  let catalogAttempt = 0;
  const rates = new Map();
  const activeControllers = new Set();
  const activeHolds = new Set();
  const workerController = new AbortController();
  let workerPromise = null;
  let working = false;
  let closed = false;
  const limit = (name, max, window) => (req, res, next) => {
    const key =
      name + ":" + (name === "api_ip" ? req.ip : req.user?.id || req.ip);
    let record = rates.get(key);
    if (!record || record.until < now())
      rates.set(key, (record = { count: 0, until: now() + window }));
    if (++record.count > max) {
      res.set("Retry-After", String(Math.ceil((record.until - now()) / 1000)));
      return next(
        Object.assign(new Error("Too many requests. Try again shortly."), {
          status: 429,
          code: "rate_limit",
        }),
      );
    }
    if (rates.size > 10000)
      for (const [key, r] of rates) if (r.until < now()) rates.delete(key);
    next();
  };
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
    });
    if (req.path.startsWith("/api") || req.path.startsWith("/v1"))
      res.set("Cache-Control", "no-store");
    next();
  });
  app.use("/v1", express.json({ limit: "256kb" }));
  app.use(express.json({ limit: "18mb" }));
  app.use((req, res, next) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
      if (req.body == null) req.body = {};
      if (Array.isArray(req.body) || typeof req.body !== "object")
        return next(
          Object.assign(new Error("Send a JSON object."), {
            status: 400,
            code: "invalid_body",
          }),
        );
    }
    next();
  });
  app.use(cookieParser());
  app.use((req, res, next) => {
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      !req.path.startsWith("/v1") &&
      req.path !== "/api/payments/ipn"
    ) {
      if (req.headers.origin && req.headers.origin !== cfg.origin)
        return next(
          Object.assign(new Error("Request origin is not allowed."), {
            status: 403,
          }),
        );
      if (req.method !== "DELETE" && !req.is("application/json"))
        return next(
          Object.assign(new Error("Use application/json."), { status: 415 }),
        );
    }
    next();
  });
  const { requireUser, publicUser } = authRoutes(app, db, cfg, limit);
  const marketFeed = createMarketFeed();
  app.get("/api/market", async (req, res) => {
    try {
      res.set("Cache-Control", "public, max-age=15").json(await marketFeed());
    } catch {
      fail(503, "Market data temporarily unavailable.", "market_unavailable");
    }
  });
  app.get("/api/openapi.json", (req, res) => res.json(openapi));
  app.get("/api/config", (req, res) =>
    res.json({
      name: "Anonyma",
      testMode: cfg.testMode,
      services: {
        generation: cfg.testMode || !!cfg.gatewayKey,
        payments: configurationStatus(cfg).configured.payments && !cfg.testMode,
        email: configurationStatus(cfg).configured.email || cfg.testMode,
        walletConnect: !!cfg.walletProject,
        token: !!cfg.rpc && !!cfg.token,
      },
      walletProject: cfg.walletProject,
      walletChain: cfg.walletChain,
      chain: cfg.chain,
      token: cfg.token,
      markup: cfg.markup,
      supportEmail: cfg.supportEmail,
      telegram: cfg.telegram,
      catalogUpdatedAt: models.updatedAt,
      readiness: configurationStatus(cfg),
    }),
  );
  app.get("/api/models", async (req, res) => {
    if (cfg.syncModels && now() - catalogAttempt > 300000) {
      catalogAttempt = now();
      catalogRefresh = syncCatalog(cfg, models)
        .then((next) => {
          models = next;
        })
        .catch((e) => {
          models = { ...models, refreshError: e.message };
        })
        .finally(() => {
          catalogRefresh = null;
        });
    }
    if (catalogRefresh) await catalogRefresh;
    res.json({
      ...models,
      data: models.data.map((m) => ({
        ...m,
        callable: callable(m, cfg),
        imageCapable: imageCallable(m),
        imagePrice: generationPrice(m),
        vision: vision(m),
      })),
    });
  });
  const ratesFeed = createRatesFeed();
  app.get("/api/rates", async (req, res) => {
    try {
      res.json(await ratesFeed());
    } catch {
      fail(
        503,
        "Live exchange rates are unavailable. USD prices remain available.",
        "rates_unavailable",
      );
    }
  });
  const getModel = (id, type) => {
    const m = models.data.find((v) => v.id === id);
    if (!m) fail(404, "Unknown model.", "model_not_found");
    if (m.type === "chat" && !imageCallable(m) && !hasPublishedTokenRates(m))
      fail(
        400,
        "This model has no valid published token rate.",
        "unpriced_model",
      );
    if (!callable(m, cfg))
      fail(
        503,
        cfg.gatewayKey || cfg.testMode
          ? "This model is catalog-only or unavailable."
          : "Configure an AI gateway to run models.",
        "model_unavailable",
      );
    if (type && m.type !== type && !(type === "image" && imageCallable(m)))
      fail(400, `Choose a ${type} model.`);
    return m;
  };
  function validateMessages(input, m, api = false) {
    if (!Array.isArray(input) || !input.length)
      fail(400, "Provide a non-empty messages array.");
    if (
      input.some((v) => !v || !["system", "user", "assistant"].includes(v.role))
    )
      fail(400, "Only system, user and assistant messages are supported.");
    input = (
      api ? input.filter((v) => typeof v.content === "string") : input
    ).slice(api ? -40 : -20);
    if (!input.length)
      fail(
        400,
        "No usable messages were provided. API content must be a string.",
      );
    let total = 0,
      images = 0;
    const messages = input.map((v) => {
      if (!v || !["system", "user", "assistant"].includes(v.role))
        fail(400, "Only system, user and assistant messages are supported.");
      let content = v.content;
      if (typeof content === "string") {
        if (content.length > 48000 && !api)
          fail(400, "A message cannot exceed 48,000 characters.");
        total += content.length;
      } else if (Array.isArray(content)) {
        if (
          content.reduce(
            (n, p) => n + (typeof p?.text === "string" ? p.text.length : 0),
            0,
          ) > 48000
        )
          fail(400, "A message cannot exceed 48,000 characters.");
        content = content.map((p) => {
          if (p?.type === "text" && typeof p.text === "string") {
            total += p.text.length;
            return { type: "text", text: p.text };
          }
          if (p?.type === "image_url" && typeof p.image_url?.url === "string") {
            images++;
            const url = p.image_url.url;
            if (
              !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(
                url,
              ) &&
              !/^https:\/\//.test(url)
            )
              fail(
                400,
                "Images must be PNG, JPEG, WebP, GIF data URLs or public HTTPS image URLs.",
              );
            if (url.length > 2 * 1024 * 1024)
              fail(400, "Each image must be smaller than 1.5 MB.");
            return { type: "image_url", image_url: { url } };
          }
          fail(400, "Unsupported message content.");
        });
      } else
        fail(400, "Message content must be text or supported image parts.");
      return { role: v.role, content };
    });
    if (total > 120000 && api)
      fail(400, "Conversation exceeds 120,000 characters.");
    while (total > 120000 && messages.length > 1) {
      const removed = messages.shift();
      total -=
        typeof removed.content === "string"
          ? removed.content.length
          : removed.content.reduce((n, p) => n + (p.text?.length || 0), 0);
    }
    if (images > 8) fail(400, "At most eight images are allowed.");
    if (images && !vision(m))
      fail(400, "Choose a model that accepts image input.");
    if (!total && !images) fail(400, "Enter a message.");
    return messages;
  }
  const maxTokens = (value) => {
    const n = value ?? 4096;
    if (!Number.isInteger(n) || n < 1)
      fail(400, "max_tokens must be a positive integer.");
    return Math.min(n, 8192);
  };
  function ownConversation(id, user) {
    const c = db
      .prepare("SELECT * FROM conversations WHERE id=? AND user_id=?")
      .get(id, user);
    if (!c) fail(404, "Conversation not found.");
    return c;
  }
  function newConversation(user, title = "New conversation", mode = "chat") {
    const id = uid("c_");
    db.prepare("INSERT INTO conversations VALUES(?,?,?,?,?,?)").run(
      id,
      user,
      title.slice(0, 70),
      mode,
      now(),
      now(),
    );
    db.prepare(
      "DELETE FROM conversations WHERE user_id=? AND id NOT IN (SELECT id FROM conversations WHERE user_id=? ORDER BY updated DESC LIMIT 300)",
    ).run(user, user);
    return id;
  }
  app.get("/api/conversations", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT * FROM conversations WHERE user_id=? ORDER BY updated DESC LIMIT 300",
        )
        .all(req.user.id),
    }),
  );
  app.post("/api/conversations", requireUser, (req, res) =>
    res.status(201).json({
      id: newConversation(
        req.user.id,
        String(req.body.title || "New conversation"),
        String(req.body.mode || "chat"),
      ),
    }),
  );
  app.get("/api/conversations/export", requireUser, (req, res) => {
    res.attachment("anonyma-conversations.json").json({
      conversations: db
        .prepare(
          "SELECT * FROM conversations WHERE user_id=? ORDER BY updated DESC",
        )
        .all(req.user.id)
        .map((c) => ({
          ...c,
          messages: db
            .prepare(
              "SELECT * FROM messages WHERE conversation_id=? ORDER BY created,rowid",
            )
            .all(c.id)
            .map((m) => ({ ...m, content: JSON.parse(m.content) })),
        })),
    });
  });
  app.delete("/api/conversations", requireUser, (req, res) => {
    db.prepare("DELETE FROM conversations WHERE user_id=?").run(req.user.id);
    res.json({ ok: true });
  });
  app.get("/api/conversations/:id", requireUser, (req, res) => {
    const c = ownConversation(req.params.id, req.user.id);
    res.json({
      ...c,
      messages: db
        .prepare(
          "SELECT * FROM messages WHERE conversation_id=? ORDER BY created,rowid",
        )
        .all(c.id)
        .map((m) => ({
          ...m,
          content: JSON.parse(m.content),
          credits: credits(m.cost),
        })),
    });
  });
  app.patch("/api/conversations/:id", requireUser, (req, res) => {
    ownConversation(req.params.id, req.user.id);
    db.prepare("UPDATE conversations SET title=?,updated=? WHERE id=?").run(
      String(req.body.title || "Untitled")
        .trim()
        .slice(0, 70) || "Untitled",
      now(),
      req.params.id,
    );
    res.json({ ok: true });
  });
  app.delete("/api/conversations/:id", requireUser, (req, res) => {
    ownConversation(req.params.id, req.user.id);
    db.prepare("DELETE FROM conversations WHERE id=?").run(req.params.id);
    res.json({ ok: true });
  });
  app.post("/api/quote", requireUser, (req, res) => {
    const m = getModel(req.body.model);
    const video = m.type === "video" ? videoOptions(m, req.body) : null;
    const messages = validateMessages(
      req.body.messages || [{ role: "user", content: req.body.prompt || " " }],
      m,
    );
    const amount = Math.ceil(
      (video
        ? usdUnits(video.price)
        : quote(m, messages, maxTokens(req.body.max_tokens), req.body)) *
        markupFactor(req.user, cfg),
    );
    res.json({
      credits: credits(amount),
      usd: amount / 1e7,
      available: credits(balance(db, req.user.id).available),
      model: m.id,
      estimate: true,
    });
  });
  function apiAuth(req, res, next) {
    const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const key = bearer
      ? db
          .prepare("SELECT * FROM api_keys WHERE hash=? AND revoked IS NULL")
          .get(hash(bearer))
      : null;
    if (!key)
      fail(
        401,
        "Provide a valid API key as Bearer authorization.",
        "invalid_api_key",
      );
    const user = db
      .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
      .get(key.user_id);
    if (!user) fail(401, "Account is unavailable.");
    req.user = user;
    req.apiKey = key;
    db.prepare("UPDATE api_keys SET last_used=? WHERE id=?").run(now(), key.id);
    next();
  }
  app.get("/v1", (req, res) => {
    const secret = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
    const key = secret
      ? db
          .prepare("SELECT * FROM api_keys WHERE hash=? AND revoked IS NULL")
          .get(hash(secret))
      : null;
    const account = key
      ? db
          .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
          .get(key.user_id)
      : null;
    const msg = {
      service: "Anonyma",
      status: "ok",
      object: "connection",
      endpoints: ["/v1/models", "/v1/chat/completions"],
      credits_charged: 0,
      authenticated: !!account,
      models: models.data.filter((m) => m.type === "chat" && callable(m, cfg))
        .length,
      ...(account
        ? {
            account: {
              credits: credits(balance(db, account.id).total),
              available: credits(balance(db, account.id).available),
            },
            key: { name: key.name, prefix: key.prefix },
          }
        : {}),
    };
    if (
      /curl|wget|httpie|powershell|fetch/i.test(req.headers["user-agent"] || "")
    )
      res
        .type("text")
        .send(
          `Anonyma API is reachable. ${msg.models} callable chat models.\n${account ? `Authenticated · ${key.name} (${key.prefix}…)\n${msg.account.available} available / ${msg.account.credits} total credits.\n` : "Provide a Bearer key to see your balance.\n"}`,
        );
    else res.json(msg);
  });
  app.get("/v1/models", apiAuth, (req, res) =>
    res.json({
      object: "list",
      data: models.data
        .filter((m) => callable(m, cfg) && ["chat", "image"].includes(m.type))
        .map((m) => ({
          id: m.id,
          object: "model",
          owned_by: m.owned_by,
          created: 0,
        })),
    }),
  );
  app.get("/v1/balance", apiAuth, (req, res) =>
    res.json({
      balance: credits(balance(db, req.user.id).total),
      available: credits(balance(db, req.user.id).available),
    }),
  );
  function requestIdentifier(req) {
    const value = req.headers["idempotency-key"] ?? req.body.requestId ?? uid();
    if (typeof value !== "string" || !value.trim() || value.length > 200)
      fail(
        400,
        "Request ID must contain 1–200 characters.",
        "invalid_request_id",
      );
    return value;
  }
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
    if (!api) {
      conversation ||= newConversation(
        req.user.id,
        typeof messages.at(-1).content === "string"
          ? messages.at(-1).content
          : "Image conversation",
        req.body.mode === "code" ? "code" : "chat",
      );
      db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(
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
    }
    const streaming = api ? req.body.stream === true : true;
    const controller = new AbortController();
    activeControllers.add(controller);
    activeHolds.add(hold);
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
      receipt = null;
    const images = [];
    const saved = [];
    const savedMediaIds = [];
    function attributeMediaCost(receipt) {
      savedMediaIds.forEach((id, index) => {
        const cost =
          Math.floor(receipt.charged / savedMediaIds.length) +
          (index < receipt.charged % savedMediaIds.length ? 1 : 0);
        db.prepare("UPDATE media SET cost=? WHERE id=? AND user_id=?").run(
          cost,
          id,
          req.user.id,
        );
      });
    }
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
          const media = await saveMedia(req.user.id, "image", source, {
            prompt:
              typeof messages.at(-1).content === "string"
                ? messages.at(-1).content
                : "",
            model: m.id,
            expires: api ? now() + 86400000 : null,
            signal: controller.signal,
          });
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
        Math.ceil(JSON.stringify(messages).length / 4),
      );
      const out = validTokenCount(
        usage?.completion_tokens,
        Math.ceil((output + reasoning).length / 4),
      );
      const reportedCost = upstreamCost ?? usage?.cost;
      const dollars =
        typeof reportedCost === "number" &&
        Number.isFinite(reportedCost) &&
        reportedCost >= 0
          ? reportedCost
          : imageCallable(m)
            ? generationPrice(m)
            : tokenCost(m, input, out);
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
        db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(
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
          db.prepare("INSERT INTO messages VALUES(?,?,?,?,?,?,?)").run(
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
      activeControllers.delete(controller);
      activeHolds.delete(hold);
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

  function mediaJSON(m) {
    return {
      id: m.id,
      kind: m.kind,
      mime: m.mime,
      prompt: m.prompt,
      model: m.model,
      cost: credits(m.cost),
      created: m.created,
      url: "/api/media/" + m.id,
      expires: m.expires,
    };
  }
  function signMedia(id, expires) {
    return createHmac("sha256", cfg.secret)
      .update(`${id}:${expires}`)
      .digest("hex");
  }
  async function saveMedia(user, kind, source, meta = {}) {
    let bytes, mime;
    if (typeof source === "string" && source.startsWith("data:")) {
      const match = source.match(
        /^data:(image\/(?:png|jpeg|webp|gif)|video\/mp4);base64,([A-Za-z0-9+/=]+)$/,
      );
      if (!match) fail(502, "Unsupported generated media format.");
      mime = match[1];
      bytes = Buffer.from(match[2], "base64");
    } else if (Buffer.isBuffer(source)) {
      bytes = source;
      mime = meta.mime;
    } else {
      let url;
      try {
        url = new URL(source);
      } catch {
        fail(502, "Provider returned an invalid media URL.");
      }
      if (
        url.protocol !== "https:" ||
        !cfg.mediaHosts.includes(url.hostname) ||
        url.username ||
        url.password ||
        (url.port && url.port !== "443")
      )
        fail(
          502,
          "Generated media host is not on the configured download allowlist.",
        );
      const response = await fetch(url, {
        redirect: "error",
        signal: meta.signal
          ? AbortSignal.any([meta.signal, AbortSignal.timeout(60000)])
          : AbortSignal.timeout(60000),
      });
      if (!response.ok) fail(502, "Could not download generated media.");
      mime = response.headers.get("content-type")?.split(";")[0];
      if (
        ![
          "image/png",
          "image/jpeg",
          "image/webp",
          "image/gif",
          "video/mp4",
        ].includes(mime)
      )
        fail(502, "Provider returned unsupported media.");
      const parts = [];
      let size = 0;
      for await (const part of response.body) {
        size += part.length;
        if (size > 100 * 1024 * 1024)
          fail(502, "Generated file exceeds 100 MB.");
        parts.push(part);
      }
      bytes = Buffer.concat(parts);
    }
    if (bytes.length > 100 * 1024 * 1024)
      fail(502, "Generated file too large.");
    const id = uid("asset_"),
      ext = mime === "video/mp4" ? "mp4" : mime.split("/")[1];
    const filename = id + "." + ext;
    writeFileSync(join(cfg.mediaPath, filename), bytes, { mode: 0o600 });
    db.prepare("INSERT INTO media VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      id,
      user,
      kind,
      mime,
      filename,
      meta.prompt || "",
      meta.model || "",
      meta.cost || 0,
      now(),
      meta.expires || null,
    );
    const old = db
      .prepare(
        "SELECT * FROM media WHERE user_id=? AND kind=? AND expires IS NULL AND id NOT IN (SELECT id FROM media WHERE user_id=? AND kind=? AND expires IS NULL ORDER BY created DESC LIMIT ?)",
      )
      .all(user, kind, user, kind, kind === "image" ? 100 : 60);
    for (const item of old) deleteMedia(item);
    const result = mediaJSON(
      db.prepare("SELECT * FROM media WHERE id=?").get(id),
    );
    if (meta.expires)
      result.url =
        (cfg.publicUrl || cfg.origin) +
        result.url +
        `?expires=${meta.expires}&sig=${signMedia(id, meta.expires)}`;
    return result;
  }
  function deleteMedia(m) {
    try {
      unlinkSync(join(cfg.mediaPath, m.filename));
    } catch {}
    db.prepare("DELETE FROM media WHERE id=?").run(m.id);
  }
  app.get("/api/media", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT * FROM media WHERE user_id=? AND expires IS NULL ORDER BY created DESC",
        )
        .all(req.user.id)
        .map(mediaJSON),
    }),
  );
  app.get("/api/media/:id", (req, res) => {
    const m = db.prepare("SELECT * FROM media WHERE id=?").get(req.params.id);
    if (!m || (m.expires && m.expires < now())) fail(404, "Media not found.");
    const exp = Number(req.query.expires);
    const supplied = String(req.query.sig || "");
    const expected = signMedia(m.id, exp);
    const signed =
      m.expires &&
      exp === m.expires &&
      exp > now() &&
      /^[a-f0-9]{64}$/.test(supplied) &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
    if (req.user?.id !== m.user_id && !signed) fail(404, "Media not found.");
    res.set("Content-Type", m.mime);
    if (req.query.download) res.attachment(m.filename);
    res.sendFile(resolve(cfg.mediaPath, m.filename));
  });
  app.delete("/api/media/:id", requireUser, (req, res) => {
    const m = db
      .prepare("SELECT * FROM media WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!m) fail(404, "Media not found.");
    deleteMedia(m);
    res.json({ ok: true });
  });
  app.post(
    "/api/images",
    requireUser,
    limit("images", 10, 60000),
    async (req, res) => {
      const m = getModel(req.body.model, "image"),
        prompt = String(req.body.prompt || "");
      if (!prompt.trim() || prompt.length > 48000)
        fail(400, "Enter a prompt up to 48,000 characters.");
      const n = req.body.n ?? 1;
      if (!Number.isInteger(n) || n < 1 || n > 4)
        fail(400, "Choose 1–4 images.");
      const refs = req.body.images || [];
      if (!Array.isArray(refs)) fail(400, "Reference images must be an array.");
      validateMessages(
        [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              ...refs.map((url) => ({ type: "image_url", image_url: { url } })),
            ],
          },
        ],
        m,
      );
      const hold = req.user.id + ":" + requestIdentifier(req),
        factor = markupFactor(req.user, cfg),
        amount = Math.ceil(
          quote(m, [{ role: "user", content: prompt }], 4096, {
            ...req.body,
            n,
          }) * factor,
        );
      reserve(db, {
        id: hold,
        user: req.user.id,
        amount,
        kind: "image",
        ttl: 240000,
      });
      const data = [];
      let deliveredCost = 0;
      const controller = new AbortController();
      activeControllers.add(controller);
      activeHolds.add(hold);
      const deadline = setTimeout(() => controller.abort(), 240000);
      res.on("close", () => {
        if (!res.writableEnded)
          controller.abort(new Error("Client disconnected"));
      });
      const finish = (warning) => {
        const receipt = settle(
          db,
          hold,
          usdUnits(deliveredCost * factor),
          m.name,
        );
        // Distribute integer subcredits exactly, including the rounding remainder.
        data.forEach((item, index) => {
          const cost =
            Math.floor(receipt.charged / data.length) +
            (index < receipt.charged % data.length ? 1 : 0);
          db.prepare("UPDATE media SET cost=? WHERE id=?").run(cost, item.id);
          item.cost = credits(cost);
        });
        return {
          data,
          receipt,
          testMode: cfg.testMode,
          ...(warning ? { partial: true, warning } : {}),
        };
      };
      try {
        await generateImages(
          cfg,
          m,
          prompt,
          n,
          { ...req.body, images: refs },
          controller.signal,
          async (batch) => {
            for (const img of batch.data) {
              const saved = await saveMedia(
                req.user.id,
                "image",
                img.b64_json
                  ? "data:image/png;base64," + img.b64_json
                  : img.url,
                { prompt, model: m.id, signal: controller.signal },
              );
              data.push(saved);
              deliveredCost += batch.cost / batch.data.length;
              db.prepare(
                "UPDATE holds SET result=? WHERE id=? AND status='held'",
              ).run(
                JSON.stringify({
                  delivered: Math.min(amount, usdUnits(deliveredCost * factor)),
                  mediaIds: data.map((item) => item.id),
                  description: m.name,
                }),
                hold,
              );
            }
          },
        );
        if (!data.length) {
          fail(502, "Provider returned no image. No credits were charged.");
        }
        res.json(finish());
      } catch (e) {
        if (data.length) {
          return res.json(
            finish(
              `${data.length} image${data.length === 1 ? " was" : "s were"} saved before the batch stopped. Only saved images were charged. ${e.status ? e.message : "The remaining images could not be completed."}`,
            ),
          );
        }
        release(db, hold);
        throw e;
      } finally {
        clearTimeout(deadline);
        activeControllers.delete(controller);
        activeHolds.delete(hold);
      }
    },
  );
  app.post(
    "/api/videos",
    requireUser,
    limit("videos", 10, 60000),
    async (req, res) => {
      const m = getModel(req.body.model, "video"),
        prompt = String(req.body.prompt || "");
      if (!prompt.trim() || prompt.length > 2000)
        fail(400, "Video prompt must contain 1–2,000 characters.");
      const { ratio, duration, quality, price } = videoOptions(m, req.body);
      const request = {
        model: m.id,
        prompt,
        aspect_ratio: ratio,
        duration,
        quality,
        ...(req.body.image_url ? { image_url: req.body.image_url } : {}),
      };
      const id = uid("video_"),
        hold = req.user.id + ":" + requestIdentifier(req);
      reserve(db, {
        id: hold,
        user: req.user.id,
        amount: Math.ceil(usdUnits(price) * markupFactor(req.user, cfg)),
        kind: "video",
        ttl: 1200000,
      });
      db.prepare("INSERT INTO videos VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        id,
        req.user.id,
        hold,
        null,
        "submitting",
        JSON.stringify({ ...request, quoted_provider_cost: price }),
        null,
        null,
        now(),
        now(),
      );
      try {
        const job = await createVideo(cfg, request);
        if (!job.id) throw Error("Provider did not return a video job ID.");
        db.prepare(
          "UPDATE videos SET provider_id=?,status='pending',updated=? WHERE id=?",
        ).run(job.id, now(), id);
        res.status(202).json({ id, status: "pending" });
      } catch (e) {
        if (e.code === "provider_rejected") {
          release(db, hold);
          db.prepare(
            "UPDATE videos SET status='failed',error=?,updated=? WHERE id=?",
          ).run(e.message, now(), id);
        } else
          db.prepare(
            "UPDATE videos SET status='reconciliation',error=?,updated=? WHERE id=?",
          ).run(
            "Submission outcome unknown. Operator reconciliation required; request will not be submitted twice.",
            now(),
            id,
          );
        throw e;
      }
    },
  );
  app.get("/api/videos", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT id,status,error,media_id,created,request FROM videos WHERE user_id=? ORDER BY created DESC LIMIT 60",
        )
        .all(req.user.id)
        .map((v) => ({ ...v, request: JSON.parse(v.request) })),
    }),
  );
  function recoverExpiredHolds() {
    const expired = db
      .prepare(
        "SELECT * FROM holds WHERE status='held' AND kind!='video' AND expires<?",
      )
      .all(now());
    for (const hold of expired) {
      if (activeHolds.has(hold.id)) continue;
      const progress = hold.result ? JSON.parse(hold.result) : null;
      if (
        hold.kind === "image" &&
        progress?.mediaIds?.length &&
        Number.isSafeInteger(progress.delivered)
      ) {
        const receipt = settle(
          db,
          hold.id,
          progress.delivered,
          "Recovered image batch: " + progress.description,
        );
        progress.mediaIds.forEach((id, index) => {
          const cost =
            Math.floor(receipt.charged / progress.mediaIds.length) +
            (index < receipt.charged % progress.mediaIds.length ? 1 : 0);
          db.prepare("UPDATE media SET cost=? WHERE id=? AND user_id=?").run(
            cost,
            id,
            hold.user_id,
          );
        });
      } else release(db, hold.id);
    }
  }
  async function runTick() {
    if (working || closed) return;
    working = true;
    try {
      const jobs = db
        .prepare(
          "SELECT * FROM videos WHERE status IN ('pending','processing') ORDER BY updated ASC,created ASC LIMIT 20",
        )
        .all();
      const pollJob = async (job) => {
        if (closed) return;
        try {
          const result = await pollVideo(
            cfg,
            job.provider_id,
            workerController.signal,
          );
          if (result.status === "completed") {
            const request = JSON.parse(job.request);
            const existingMedia =
              job.media_id &&
              db
                .prepare("SELECT * FROM media WHERE id=? AND user_id=?")
                .get(job.media_id, job.user_id);
            let media =
              existingMedia &&
              existsSync(join(cfg.mediaPath, existingMedia.filename))
                ? mediaJSON(existingMedia)
                : null;
            if (!media && cfg.testMode && result.data?.test) {
              const testPath = resolve("data/test-video.mp4");
              if (!existsSync(testPath))
                throw Error("Local video test fixture is missing.");
              media = await saveMedia(
                job.user_id,
                "video",
                readFileSync(testPath),
                {
                  mime: "video/mp4",
                  prompt: "LOCAL TEST FIXTURE: " + request.prompt,
                  model: request.model,
                },
              );
            } else if (!media)
              media = await saveMedia(job.user_id, "video", result.data?.url, {
                prompt: request.prompt,
                model: request.model,
                signal: workerController.signal,
              });
            db.prepare("UPDATE videos SET media_id=? WHERE id=?").run(
              media.id,
              job.id,
            );
            const user = db
              .prepare("SELECT * FROM users WHERE id=?")
              .get(job.user_id);
            const reportedCost = result.cost;
            const providerCost =
              typeof reportedCost === "number" &&
              Number.isFinite(reportedCost) &&
              reportedCost >= 0
                ? reportedCost
                : (request.quoted_provider_cost ??
                  generationPrice(
                    models.data.find((m) => m.id === request.model),
                    { ratio: request.aspect_ratio, ...request },
                  ));
            const receipt = settle(
              db,
              job.hold_id,
              usdUnits(providerCost * markupFactor(user, cfg)),
              request.model,
            );
            db.prepare("UPDATE media SET cost=? WHERE id=?").run(
              receipt.charged,
              media.id,
            );
            db.prepare(
              "UPDATE videos SET status='completed',media_id=?,updated=? WHERE id=?",
            ).run(media.id, now(), job.id);
          } else if (result.status === "failed") {
            release(db, job.hold_id);
            db.prepare(
              "UPDATE videos SET status='failed',error=?,updated=? WHERE id=?",
            ).run(
              result.error?.message ||
                result.error ||
                "Video generation failed.",
              now(),
              job.id,
            );
          } else {
            db.prepare(
              "UPDATE videos SET status='processing',updated=? WHERE id=?",
            ).run(now(), job.id);
            if (now() - job.created > 1200000)
              db.prepare(
                "UPDATE videos SET error='Provider is taking longer than expected; reservation retained until status is known.' WHERE id=?",
              ).run(job.id);
          }
        } catch (e) {
          if (closed) return;
          db.prepare("UPDATE videos SET error=?,updated=? WHERE id=?").run(
            "Retrying status check: " + e.message,
            now(),
            job.id,
          );
        }
      };
      for (let offset = 0; offset < jobs.length && !closed; offset += 4) {
        await Promise.all(jobs.slice(offset, offset + 4).map(pollJob));
      }
      if (closed) return;
      if (!cfg.testMode && cfg.paymentKey) {
        const pending = db
          .prepare(
            "SELECT * FROM deposits WHERE provider_id IS NOT NULL AND credited=0 AND status IN ('waiting','confirming','confirmed','sending','partially_paid') AND updated<? ORDER BY updated,created LIMIT 10",
          )
          .all(now() - (cfg.paymentPollIntervalMs ?? 60000));
        const check = async (deposit) => {
          try {
            const update = await payment(
              cfg,
              "/payment/" + encodeURIComponent(deposit.provider_id),
              undefined,
              workerController.signal,
            );
            if (String(update.payment_id) !== deposit.provider_id)
              throw Error("Processor invoice identity mismatch.");
            recordPayment(db, update, { current: true });
          } catch {
            db.prepare("UPDATE deposits SET updated=? WHERE id=?").run(
              now(),
              deposit.id,
            );
          }
        };
        for (let offset = 0; offset < pending.length && !closed; offset += 4)
          await Promise.all(pending.slice(offset, offset + 4).map(check));
      }
      if (closed) return;
      for (const m of db
        .prepare("SELECT * FROM media WHERE expires IS NOT NULL AND expires<?")
        .all(now()))
        deleteMedia(m);
      recoverExpiredHolds();
      if (cfg.rpc && cfg.token) {
        for (const user of db
          .prepare(
            "SELECT * FROM users WHERE wallet IS NOT NULL AND deleted IS NULL AND COALESCE(token_checked,0)<? LIMIT 5",
          )
          .all(now() - 86400000)) {
          if (closed) break;
          try {
            await refreshTokenHoldings(db, cfg, user);
          } catch {
            db.prepare(
              "UPDATE users SET token_checked=? WHERE id=? AND wallet=? AND deleted IS NULL",
            ).run(now() - 23 * 3600000, user.id, user.wallet);
          }
        }
      }
      db.prepare("DELETE FROM challenges WHERE expires<?").run(now() - 3600000);
      db.prepare("DELETE FROM rate_events WHERE created<?").run(
        now() - 86400000,
      );
      db.prepare("DELETE FROM sessions WHERE expires<?").run(now());
    } finally {
      working = false;
    }
  }
  // A crashed submission is deliberately not blindly resubmitted.
  db.prepare(
    "UPDATE videos SET status='reconciliation',error='Service restarted during submission; operator must reconcile upstream status.' WHERE status='submitting'",
  ).run();
  db.prepare(
    "UPDATE deposits SET status='reconciliation',updated=? WHERE status IN ('creating','error') AND provider_id IS NULL",
  ).run(now());
  recoverExpiredHolds();
  function tick() {
    if (workerPromise) return workerPromise;
    workerPromise = runTick().finally(() => {
      workerPromise = null;
    });
    return workerPromise;
  }
  const timer = setInterval(
    () => {
      tick().catch(() =>
        console.error("Background maintenance failed; it will retry."),
      );
    },
    cfg.testMode ? 1500 : 7000,
  );
  timer.unref();

  app.get("/api/account/ledger", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT l.*,k.name key_name,h.result receipt_json FROM ledger l LEFT JOIN api_keys k ON k.id=l.key_id LEFT JOIN holds h ON h.id=l.ref WHERE l.user_id=? ORDER BY l.created DESC LIMIT 50",
        )
        .all(req.user.id)
        .map(({ receipt_json, ...v }) => ({
          ...v,
          amount: credits(v.amount),
          receipt: receipt_json ? JSON.parse(receipt_json) : null,
        })),
      balance: publicUser(req.user),
    }),
  );
  app.get("/api/keys", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT id,name,prefix,cap,created,revoked,last_used FROM api_keys WHERE user_id=? ORDER BY created DESC",
        )
        .all(req.user.id)
        .map((k) => ({
          ...k,
          cap: k.cap == null ? null : credits(k.cap),
          spent: credits(
            -db
              .prepare(
                "SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE key_id=? AND amount<0 AND created>?",
              )
              .get(k.id, now() - 86400000).n,
          ),
        })),
    }),
  );
  app.post("/api/keys", requireUser, limit("keys", 10, 3600000), (req, res) => {
    if (
      db
        .prepare(
          "SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND revoked IS NULL",
        )
        .get(req.user.id).n >= 20
    )
      fail(400, "Maximum 20 active API keys.");
    if (
      db
        .prepare(
          "SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND created>?",
        )
        .get(req.user.id, now() - 3600000).n >= 10
    )
      fail(429, "Maximum ten key creations per hour.");
    const name = String(req.body.name || "Untitled key").slice(0, 60);
    const cap =
      req.body.cap == null || req.body.cap === "" ? null : Number(req.body.cap);
    if (cap != null && (!Number.isFinite(cap) || cap < 0 || cap > 1e9))
      fail(400, "Invalid credit cap.");
    const secret = uid("anonyma_live_") + uid();
    const id = uid("key_");
    db.prepare("INSERT INTO api_keys VALUES(?,?,?,?,?,?,?,?,?)").run(
      id,
      req.user.id,
      hash(secret),
      name,
      secret.slice(0, 20),
      cap == null ? null : Math.floor(cap * 10000),
      now(),
      null,
      null,
    );
    res.status(201).json({
      id,
      key: secret,
      name,
      message: "Copy this key now. It will never be shown again.",
    });
  });
  app.delete("/api/keys/:id", requireUser, (req, res) => {
    const r = db
      .prepare(
        "UPDATE api_keys SET revoked=? WHERE id=? AND user_id=? AND revoked IS NULL",
      )
      .run(now(), req.params.id, req.user.id);
    if (!r.changes) fail(404, "Key not found.");
    res.json({ ok: true });
  });
  app.get("/api/payments/currencies", requireUser, async (req, res) => {
    if (!cfg.paymentKey || cfg.testMode)
      return res.json({
        data: ["btc", "eth", "sol", "usdttrc20", "usdtbsc", "usdc", "ltc"],
        live: false,
      });
    const result = await payment(cfg, "/currencies");
    res.json({ data: result.currencies || [], live: true });
  });
  app.get("/api/deposits", requireUser, (req, res) =>
    res.json({
      data: db
        .prepare(
          "SELECT * FROM deposits WHERE user_id=? ORDER BY created DESC LIMIT 50",
        )
        .all(req.user.id)
        .map((d) => ({
          ...d,
          amount: d.amount / 1e7,
          payload: JSON.parse(d.payload),
        })),
    }),
  );
  app.post(
    "/api/deposits",
    requireUser,
    limit("deposits", 10, 3600000),
    async (req, res) => {
      if (cfg.testMode || !configurationStatus(cfg).configured.payments)
        fail(
          503,
          "Configure a public HTTPS callback URL and IPN secret before accepting deposits.",
        );
      const dollars = Number(req.body.amount);
      if (!Number.isFinite(dollars) || dollars < 5 || dollars > 10000)
        fail(400, "Deposit must be $5–$10,000.");
      const currency = String(req.body.currency || "");
      if (!/^[a-z0-9]{2,30}$/.test(currency))
        fail(400, "Invalid payment currency.");
      const requestId = requestIdentifier(req);
      const id = "deposit_" + hash(req.user.id + ":" + requestId).slice(0, 32);
      const existing = db.prepare("SELECT * FROM deposits WHERE id=?").get(id);
      if (existing) {
        if (
          existing.amount !== usdUnits(dollars) ||
          existing.currency !== currency
        )
          fail(
            409,
            "Idempotency key was already used for a different invoice.",
          );
        if (existing.provider_id)
          return res.status(200).json({ id, ...JSON.parse(existing.payload) });
        fail(409, "Invoice creation is pending or requires reconciliation.");
      }
      const created = now();
      db.prepare("INSERT INTO deposits VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        id,
        req.user.id,
        null,
        usdUnits(dollars),
        currency,
        "creating",
        "{}",
        0,
        created,
        created,
      );
      try {
        const invoice = await payment(cfg, "/payment", {
          price_amount: dollars,
          price_currency: "usd",
          pay_currency: currency,
          order_id: id,
          order_description: "Anonyma prepaid AI credits",
          ipn_callback_url: cfg.publicUrl + "/api/payments/ipn",
          is_fee_paid_by_user: false,
        });
        if (!invoice.payment_id)
          throw Error("Processor did not return a payment ID.");
        const stored = recordPayment(
          db,
          {
            ...invoice,
            payment_status: invoice.payment_status || "waiting",
            order_id: invoice.order_id ?? id,
            price_amount: invoice.price_amount ?? dollars,
            price_currency: invoice.price_currency ?? "usd",
          },
          { current: true },
        );
        res.status(201).json({ id, ...JSON.parse(stored.payload) });
      } catch (e) {
        db.prepare(
          "UPDATE deposits SET status=?,updated=? WHERE id=? AND provider_id IS NULL",
        ).run(
          e.code === "payment_rejected" ? "failed" : "reconciliation",
          now(),
          id,
        );
        if (!e.status)
          fail(
            502,
            "Invoice creation could not be confirmed. Check deposit status before retrying; the order is held for reconciliation.",
            "payment_uncertain",
          );
        throw e;
      }
    },
  );
  const applyPayment = (body, current = false) =>
    recordPayment(db, body, { current });
  app.post("/api/payments/ipn", (req, res) => {
    if (
      !validIPN(req.body, req.headers["x-nowpayments-sig"], cfg.paymentSecret)
    )
      fail(401, "Invalid payment signature.");
    applyPayment(req.body);
    res.json({ ok: true });
  });
  app.get("/api/deposits/:id", requireUser, async (req, res) => {
    const d = db
      .prepare("SELECT * FROM deposits WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!d) fail(404, "Invoice not found.");
    let refreshError = null;
    if (
      d.provider_id &&
      !["finished", "failed", "expired", "refunded"].includes(d.status)
    ) {
      let result;
      try {
        result = await payment(
          cfg,
          "/payment/" + encodeURIComponent(d.provider_id),
        );
      } catch {
        refreshError =
          "Processor status is temporarily unavailable. Showing the last verified invoice details.";
      }
      if (result == null || typeof result !== "object" || Array.isArray(result))
        refreshError =
          "Processor status is temporarily unavailable. Showing the last verified invoice details.";
      else {
        if (String(result.payment_id) !== d.provider_id)
          fail(
            502,
            "Processor returned a different invoice.",
            "payment_identity_mismatch",
          );
        applyPayment(result, true);
      }
    }
    const updated = db.prepare("SELECT * FROM deposits WHERE id=?").get(d.id);
    res.json({
      ...updated,
      amount: updated.amount / 1e7,
      payload: JSON.parse(updated.payload),
      ...(refreshError ? { refreshError } : {}),
    });
  });
  app.post(
    "/api/support",
    requireUser,
    limit("support", 5, 3600000),
    (req, res) => {
      const subject = String(req.body.subject || ""),
        body = String(req.body.body || "");
      if (
        !subject.trim() ||
        subject.length > 200 ||
        !body.trim() ||
        body.length > 10000
      )
        fail(400, "Include a subject and a message (up to 10,000 characters).");
      const id = uid("ticket_");
      db.prepare("INSERT INTO tickets VALUES(?,?,?,?,?)").run(
        id,
        req.user.id,
        subject,
        body,
        now(),
      );
      res.status(201).json({
        id,
        message:
          "Saved for this installation’s operator. No external message has been sent.",
      });
    },
  );
  app.get("/api/account/export", requireUser, (req, res) =>
    res.attachment("anonyma-account.json").json({
      user: publicUser(req.user),
      ledger: db
        .prepare("SELECT * FROM ledger WHERE user_id=?")
        .all(req.user.id),
      conversations: db
        .prepare("SELECT * FROM conversations WHERE user_id=?")
        .all(req.user.id)
        .map((c) => ({
          ...c,
          messages: db
            .prepare("SELECT * FROM messages WHERE conversation_id=?")
            .all(c.id),
        })),
      media: db
        .prepare("SELECT * FROM media WHERE user_id=?")
        .all(req.user.id)
        .map(mediaJSON),
    }),
  );
  app.delete("/api/account", requireUser, (req, res) => {
    if (req.body.confirm !== "DELETE")
      fail(
        400,
        "Type DELETE to confirm closure and forfeiture of unused credits.",
      );
    if (
      db
        .prepare("SELECT id FROM holds WHERE user_id=? AND status='held'")
        .get(req.user.id)
    )
      fail(
        409,
        "Wait for pending requests and payment reconciliation before closing the account.",
      );
    if (
      db
        .prepare(
          "SELECT id FROM deposits WHERE user_id=? AND status IN ('creating','reconciliation','error','waiting','confirming','confirmed','sending','partially_paid')",
        )
        .get(req.user.id)
    )
      fail(
        409,
        "Resolve pending payment invoices before closing this account.",
      );
    for (const m of db
      .prepare("SELECT * FROM media WHERE user_id=?")
      .all(req.user.id))
      deleteMedia(m);
    transaction(db, () => {
      db.prepare("DELETE FROM conversations WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM sessions WHERE user_id=?").run(req.user.id);
      db.prepare("UPDATE api_keys SET revoked=? WHERE user_id=?").run(
        now(),
        req.user.id,
      );
      db.prepare(
        "DELETE FROM challenges WHERE target IN (?,?) OR payload=?",
      ).run(req.user.email || "", req.user.wallet || "", req.user.id);
      db.prepare("DELETE FROM tickets WHERE user_id=?").run(req.user.id);
      db.prepare("DELETE FROM videos WHERE user_id=?").run(req.user.id);
      db.prepare(
        "UPDATE users SET username=NULL,password=NULL,email=NULL,wallet=NULL,token_balance='0',token_since=NULL,deleted=? WHERE id=?",
      ).run(now(), req.user.id);
    });
    res.clearCookie("anonyma_session", { path: "/" }).json({ ok: true });
  });
  app.get("/health", (req, res) =>
    res.json({
      ok: true,
      mode: cfg.testMode ? "local-test" : "live",
      database: !!db.prepare("SELECT 1").get(),
      integrations: configurationStatus(cfg).configured,
      ready: configurationStatus(cfg).requiredConfigured,
    }),
  );
  app.get("/llms.txt", (req, res) =>
    res
      .type("text")
      .send(
        "# Anonyma\nPrepaid model gateway.\n- Documentation: /docs\n- API: /v1\n- Full documentation: /llms-full.txt\n",
      ),
  );
  app.get("/llms-full.txt", (req, res) =>
    res.type("text").send(publicDocumentation()),
  );
  app.get("/install.sh", (req, res) =>
    res.type("text").send(shellInstaller(cfg)),
  );
  app.get("/install.ps1", (req, res) =>
    res.type("text").send(powershellInstaller(cfg)),
  );
  app.get("/cli.mjs", (req, res) => res.type("text").send(cliDownload(cfg)));
  app.use("/api", (req, res) => fail(404, "API route not found."));
  if (existsSync("dist/client")) {
    app.use(express.static("dist/client"));
    app.get("/*path", (req, res) =>
      res.sendFile(resolve("dist/client/index.html")),
    );
  }
  app.use((e, req, res, next) => {
    if (res.headersSent) return next(e);
    res.status(e.status || 500).json({
      error: {
        message: e.status
          ? e.message
          : cfg.testMode
            ? e.message
            : "An internal error occurred. Please try again.",
        code: e.code || "server_error",
        type:
          e.status === 401
            ? "authentication_error"
            : e.status === 402
              ? "insufficient_quota"
              : e.status === 429
                ? "rate_limit_error"
                : e.status >= 500
                  ? "api_error"
                  : "invalid_request_error",
        param: null,
      },
      ...(e.receipt
        ? {
            askr: { credits_charged: e.receipt.credits_charged },
            anonyma: { credits_charged: e.receipt.credits_charged },
          }
        : {}),
    });
    if (!e.status) console.error(e.message);
  });
  return {
    app,
    db,
    cfg,
    tick,
    stopWork: async () => {
      closed = true;
      clearInterval(timer);
      for (const c of activeControllers)
        c.abort(new Error("Service restarting"));
      workerController.abort();
      await workerPromise?.catch(() => {});
    },
    close: () => {
      closed = true;
      clearInterval(timer);
      for (const c of activeControllers) c.abort();
      workerController.abort();
      db.close();
    },
  };
}
