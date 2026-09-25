import { fail } from "./core.js";

// The app launches as an MVP (chat with a short list of models, credits and
// the account) and the rest ships as named feature releases, in this order. RELEASED_FEATURES
// lists the updates that are live: "mvp" (the default) plus any
// update ids, e.g. "mvp,code,search". Until an update is released the server
// refuses its routes and the app shows it as coming soon. The copy here also
// drives the roadmap page and the launch videos.
export const UPDATES = [
  {
    id: "code",
    released: true,
    title: "Code & Build",
    tagline: "Build with your favorite models.",
    points: [
      "A dedicated code mode",
      "Files in a live side panel",
      "Download the project as a ZIP",
    ],
  },
  {
    id: "search",
    released: true,
    title: "Live Web Search",
    tagline: "Answers from the live web, with sources.",
    points: [
      "One tap on Web in any chat",
      "Cited sources under every answer",
      "About 2 cents a search",
    ],
  },
  {
    id: "images",
    released: true,
    title: "Image Studio",
    tagline: "Turn words into images.",
    points: [
      "Leading image models",
      "Guide them with reference images",
      "Everything saved in your library",
    ],
  },
  {
    id: "catalog",
    released: true,
    title: "Full Model Catalog",
    tagline: "More models. One balance.",
    points: [
      "Models from OpenAI, Anthropic, Google and more",
      "@mention any model mid-conversation",
      "Pay per use, never a subscription",
    ],
  },
  {
    id: "audio",
    released: true,
    title: "Voice & Audio",
    tagline: "Talk to it. Hear it back.",
    points: [
      "Natural text-to-speech voices",
      "Dictate prompts with the mic",
      "Dictate prompts into your composer",
    ],
  },
  {
    id: "video",
    released: true,
    title: "Video Studio",
    tagline: "Direct AI video.",
    points: [
      "Text and image to video",
      "Choose the length and the frame",
      "Delivered to your library",
    ],
  },
  {
    id: "collab",
    released: true,
    title: "Collab",
    tagline: "Build it together.",
    points: [
      "Shared workspaces for up to 12 people",
      "Conversations everyone can join",
      "One balance per person, no surprises",
    ],
  },
  {
    id: "api",
    title: "Developer API & CLI",
    tagline: "Your balance, in your code.",
    points: [
      "OpenAI-compatible /v1 API",
      "Per-key spending caps",
      "A one-line CLI install",
    ],
  },
  {
    id: "social",
    title: "Referrals & Credits",
    tagline: "Invite friends. Get credits back.",
    points: [
      "Get 5% back in credits when friends top up",
      "Send credits to any account",
      "Instant, on the ledger",
    ],
  },
  {
    id: "veil",
    title: "Veil",
    tagline: "Private details stay in your browser.",
    points: [
      "Emails, cards, phone numbers and keys masked before sending",
      "Real values restored only on your screen",
      "Your own always-veil word list",
    ],
    released: true,
  },
  {
    id: "uncensored",
    released: true,
    title: "Uncensored Models",
    tagline: "Your space for uncensored models.",
    points: [
      "A dedicated uncensored collection",
      "Choose your model",
      "One prepaid balance",
    ],
  },
  {
    id: "ephemeral",
    title: "Ephemeral Chats",
    tagline: "Off the record, or gone on schedule.",
    points: [
      "Chats that are never saved",
      "Auto-delete after 1, 7 or 30 days",
      "A receipt either way",
    ],
    released: true,
  },
  {
    id: "private",
    title: "Private Mode",
    tagline: "Private models. Nothing saved.",
    points: [
      "Only zero-data-retention models",
      "Never saved on our servers",
      "Veil masks your details before sending",
    ],
    released: true,
  },
  {
    id: "zh",
    title: "简体中文",
    tagline: "The whole site in Simplified Chinese.",
    points: [
      "One switch between English and Chinese",
      "Every page, the workspace and your account",
      "Your chats stay exactly as written",
    ],
    released: true,
  },
];
const IDS = UPDATES.map((u) => u.id);

// The MVP's chat models when "catalog" isn't released (override: MVP_MODELS).
export const DEFAULT_MVP_MODELS = [
  "claude-opus-5.5",
  "claude-sonnet-5",
  "claude-haiku-4.5",
  "gpt-6-sol",
  "gpt-5.4-mini",
  "gemini-3.7-flash",
  "grok-4.6",
  "glm-5.3",
  "kimi-k3-fast",
  "deepseek/deepseek-v4.1-flash",
];

// The Uncensored section's models, offered once "uncensored" is released even
// while the full catalog stays closed. Curated, never inferred from a
// provider: add a model only when its catalog metadata explicitly labels it
// uncensored and it is a live chat model with published token rates. The
// current list is every such row in the catalog (all hosted by Venice) except
// venice/e2ee-gemma-4-26b-a4b-uncensored-p, an enclave ("e2ee") variant that
// publishes no supported parameters and hasn't been tested on this chat path.
export const UNCENSORED_MODELS = [
  "venice/venice-uncensored-1-2",
  "cognitivecomputations/dolphin-mistral-24b-venice-edition",
  "venice/venice-uncensored-role-play",
  "venice/gemma-4-uncensored",
  "venice/olafangensan-glm-4.7-flash-heretic",
];

export function parseReleased(value) {
  const parts = String(value ?? "mvp")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const unknown = parts.filter(
    (p) => p !== "mvp" && p !== "all" && !IDS.includes(p),
  );
  if (unknown.length)
    throw Error(
      `Unknown RELEASED_FEATURES: ${unknown.join(", ")}. Use all, or mvp plus any of: ${IDS.join(", ")}.`,
    );
  if (parts.includes("all")) return "all";
  return new Set(parts.filter((p) => p !== "mvp"));
}

// An update is live when RELEASED_FEATURES includes it, or when its entry in
// UPDATES says `released: true`. The second way makes turning a feature on a
// public commit ("Release Veil") rather than a hosting setting.
export const isReleased = (cfg, id) =>
  cfg.released === "all" ||
  (cfg.released instanceof Set && cfg.released.has(id)) ||
  UPDATES.some((u) => u.id === id && u.released === true);

// Whether a model is part of what's released: chat models need the full
// catalog, a place on the MVP list, or (for the curated uncensored models)
// the Uncensored release; generators need their studio.
export function modelReleased(m, cfg) {
  if (cfg.released === "all") return true;
  if (m.type === "video") return isReleased(cfg, "video");
  if (m.type === "image") return isReleased(cfg, "images");
  if (m.type !== "chat") return false;
  if ((m.architecture?.output_modalities || []).includes("image"))
    return isReleased(cfg, "images");
  return (
    isReleased(cfg, "catalog") ||
    (cfg.mvpModels || DEFAULT_MVP_MODELS).includes(m.id) ||
    (isReleased(cfg, "uncensored") && UNCENSORED_MODELS.includes(m.id))
  );
}

// All release gates required by a request. Discovery uses the first gate.
export const featureFor = (req) => featuresFor(req)[0] || null;
function featuresFor(req) {
  const p = req.path,
    post = req.method === "POST",
    body = req.body || {};
  if (p.startsWith("/api/videos")) return ["video"];
  if (p.startsWith("/api/audio")) return ["audio"];
  if (p.startsWith("/api/collabs")) return ["collab"];
  if (p === "/api/images" && post) return ["images"];
  if (p === "/v1" || p.startsWith("/v1/")) return ["api"];
  if (p === "/api/keys" && post) return ["api"];
  if (["/install.sh", "/install.ps1", "/cli.mjs"].includes(p)) return ["api"];
  if (p === "/api/credits/send" || p === "/api/referrals") return ["social"];
  if (p.startsWith("/api/retention")) return ["ephemeral"];
  if (
    req.method === "PATCH" &&
    p.startsWith("/api/conversations/") &&
    Object.prototype.hasOwnProperty.call(body, "retention")
  )
    return ["ephemeral"];
  const needed = [];
  if ((p === "/api/chat" || p === "/api/conversations") && post) {
    if (body.mode === "code") needed.push("code");
    if (body.mode === "uncensored") needed.push("uncensored");
    if (p === "/api/chat" && body.ephemeral === true) needed.push("ephemeral");
    // Private mode always takes the ephemeral path, so it needs both.
    if (p === "/api/chat" && body.private === true)
      needed.push("private", "ephemeral");
    if (
      p === "/api/chat" &&
      (body.web_search === true ||
        (Array.isArray(body.plugins) &&
          body.plugins.some((x) => x?.id === "web")))
    )
      needed.push("search");
  }
  return needed;
}

export function releaseGuard(cfg) {
  return (req, res, next) => {
    const feature = featuresFor(req).find((id) => !isReleased(cfg, id));
    if (feature) {
      const update = UPDATES.find((u) => u.id === feature);
      fail(403, `${update.title} is coming soon.`, "feature_unreleased");
    }
    next();
  };
}

// What the app needs to show released features and the roadmap.
export function releaseInfo(cfg) {
  return {
    all: cfg.released === "all",
    features: Object.fromEntries(IDS.map((id) => [id, isReleased(cfg, id)])),
    updates: UPDATES.map((u, i) => ({
      ...u,
      number: i + 1,
      released: isReleased(cfg, u.id),
    })),
    uncensoredModels: UNCENSORED_MODELS,
  };
}
