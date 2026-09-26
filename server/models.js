import { chatLimits, contextEstimate, CHAT_SERVICE_MESSAGES, CHAT_SERVICE_CHARACTERS } from "../data/chat-limits.js";
import { isReleased } from "./releases.js";
import { loadCatalog, syncCatalog } from "./catalog.js";
import {
  now,
  fail,
  callable,
  imageCallable,
  hasPublishedTokenRates,
  vision,
} from "./core.js";

// The model catalog (refreshed from the gateway when AUTO_SYNC_MODELS is on)
// and validation of what a request may send to a model. `onCatalog` sees
// every refreshed catalog before it's used (Early Model Access records the
// ids it lists); if it throws, the refresh is dropped and the previous
// catalog stays, so no model is ever offered unrecorded.
export function createModels(cfg, { onCatalog } = {}) {
  let models = loadCatalog(cfg.catalogPath);
  let catalogRefresh = null;
  let catalogAttempt = 0;
  async function current() {
    if (cfg.syncModels && now() - catalogAttempt > 300000) {
      catalogAttempt = now();
      catalogRefresh = syncCatalog(cfg, models)
        .then((next) => {
          onCatalog?.(next);
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
    return models;
  }
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
  // Everything about a request's messages that doesn't depend on the model:
  // the checked messages and how many images they carry. Only whether the
  // model can read those images is left to validateMessages.
  function checkMessages(input, api = false) {
    if (!Array.isArray(input) || !input.length)
      fail(400, "Provide a non-empty messages array.");
    if (
      input.some((v) => !v || !["system", "user", "assistant"].includes(v.role))
    )
      fail(400, "Only system, user and assistant messages are supported.");
    const extended = isReleased(cfg, "longanswers");
    if (extended && input.length > CHAT_SERVICE_MESSAGES)
      fail(400, `This conversation exceeds the ${CHAT_SERVICE_MESSAGES}-message service limit. Start a new conversation with the context you want to keep. Nothing was sent or charged.`, "context_limit_exceeded");
    if (!extended) input = (api ? input.filter((v) => typeof v.content === "string") : input).slice(api ? -40 : -20);
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
        if (content.length > (extended ? CHAT_SERVICE_CHARACTERS : 48000) && !api)
          fail(400, `A message cannot exceed ${extended ? "240,000" : "48,000"} characters.`);
        total += content.length;
      } else if (Array.isArray(content)) {
        if (
          content.reduce(
            (n, p) => n + (typeof p?.text === "string" ? p.text.length : 0),
            0,
          ) > (extended ? CHAT_SERVICE_CHARACTERS : 48000)
        )
          fail(400, `A message cannot exceed ${extended ? "240,000" : "48,000"} characters.`);
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
    if (extended && total > CHAT_SERVICE_CHARACTERS)
      fail(400, "Conversation exceeds 240,000 characters. Start a new conversation with the context you want to keep. Nothing was sent or charged.", "context_limit_exceeded");
    if (!extended && total > 120000 && api)
      fail(400, "Conversation exceeds 120,000 characters.");
    while (!extended && total > 120000 && messages.length > 1) {
      const removed = messages.shift();
      total -=
        typeof removed.content === "string"
          ? removed.content.length
          : removed.content.reduce((n, p) => n + (p.text?.length || 0), 0);
    }
    if (images > 8) fail(400, "At most eight images are allowed.");
    if (!total && !images) fail(400, "Enter a message.");
    return { messages, images };
  }
  function validateMessages(input, m, api = false) {
    const { messages, images } = checkMessages(input, api);
    if (images && !vision(m))
      fail(400, "Choose a model that accepts image input.");
    return messages;
  }
  // Whether the messages and reply budget fit the model's context
  // allowance, without refusing: null when no allowance applies (Longer
  // Answers unreleased, or not a chat model). Cost Compare flags a model
  // this says no to; validateContext refuses the request.
  function contextFit(messages, model, output) {
    if (!isReleased(cfg, "longanswers") || model.type !== "chat") return null;
    const limits = chatLimits(model), input = contextEstimate(messages);
    const allowance = limits.contextTokens || 32768;
    return { limits, input, output, allowance, fits: input + output <= allowance };
  }
  const maxTokens = (value, model) => {
    const n = value ?? 4096;
    if (!Number.isInteger(n) || n < 1)
      fail(400, "max_tokens must be a positive integer.");
    if (!isReleased(cfg, "longanswers")) return Math.min(n, 8192);
    const cap = chatLimits(model).maxOutputTokens;
    if (n > cap) fail(400, `Choose a reply budget of ${cap.toLocaleString("en-US")} tokens or less for this model. Nothing was sent or charged.`, "output_limit_exceeded");
    return n;
  };
  return {
    get snapshot() {
      return models;
    },
    current,
    find: (id) => models.data.find((m) => m.id === id),
    getModel,
    checkMessages,
    validateMessages,
    maxTokens,
    contextFit,
    validateContext(messages, model, output) {
      const fit = contextFit(messages, model, output);
      if (!fit) return null;
      const { limits, input, allowance: context } = fit;
      if (!fit.fits)
        fail(400, `This conversation and reply budget exceed the ${limits.contextTokens ? "model's" : "service's conservative"} context allowance (conservative estimate: ${input.toLocaleString("en-US")} input + ${output.toLocaleString("en-US")} reply tokens; allowance ${context.toLocaleString("en-US")}). Reduce the reply budget or start a new conversation with selected context. Nothing was sent or charged.`, "context_limit_exceeded");
      return { ...limits, inputTokensEstimate: input, replyBudget: output };
    },
  };
}
