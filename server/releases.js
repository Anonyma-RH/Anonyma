import { fail } from "./core.js";

// The app launches as an MVP (chat with a short list of models, credits and
// the account) and the rest ships as numbered updates. RELEASED_FEATURES
// lists the updates that are live: "all" (the default) or "mvp" plus any
// update ids, e.g. "mvp,code,search". Until an update is released the server
// refuses its routes and the app shows it as coming soon. The copy here also
// drives the roadmap page and the launch videos.
export const UPDATES = [
  {
    id: "code",
    title: "Code & build",
    tagline: "Ship code with every frontier model.",
    points: [
      "A dedicated code mode",
      "Files in a live side panel",
      "Download the project as a ZIP",
    ],
  },
  {
    id: "search",
    title: "Live web search",
    tagline: "Answers from the live web, with sources.",
    points: [
      "One tap on Web in any chat",
      "Cited sources under every answer",
      "About 2 cents a search",
    ],
  },
  {
    id: "images",
    title: "Image studio",
    tagline: "Turn words into images.",
    points: [
      "Leading image models",
      "Guide them with reference images",
      "Everything saved in your library",
    ],
  },
  {
    id: "catalog",
    title: "500+ models",
    tagline: "Every major model. One balance.",
    points: [
      "OpenAI, Anthropic, Google and hundreds more",
      "@mention any model mid-conversation",
      "Pay per use, never a subscription",
    ],
  },
  {
    id: "audio",
    title: "Voice & audio",
    tagline: "Talk to it. Hear it back.",
    points: [
      "Natural text-to-speech voices",
      "Dictate prompts with the mic",
      "Transcribe any recording",
    ],
  },
  {
    id: "video",
    title: "Video studio",
    tagline: "Direct AI video.",
    points: [
      "Text and image to video",
      "Choose the length and the frame",
      "Delivered to your library",
    ],
  },
  {
    id: "collab",
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
    title: "Referrals & sending credits",
    tagline: "Share it. Earn from it.",
    points: [
      "Earn a share of friends' deposits",
      "Send credits to any account",
      "Instant, on the ledger",
    ],
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

export function parseReleased(value) {
  const parts = String(value ?? "all")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  if (!parts.length || parts.includes("all")) return "all";
  const unknown = parts.filter((p) => p !== "mvp" && !IDS.includes(p));
  if (unknown.length)
    throw Error(
      `Unknown RELEASED_FEATURES: ${unknown.join(", ")}. Use all, or mvp plus any of: ${IDS.join(", ")}.`,
    );
  return new Set(parts.filter((p) => p !== "mvp"));
}

export const isReleased = (cfg, id) =>
  !cfg.released || cfg.released === "all" || cfg.released.has(id);

// Whether a model is part of what's released: chat models need the full
// catalog or a place on the MVP list; generators need their studio.
export function modelReleased(m, cfg) {
  if (!cfg.released || cfg.released === "all") return true;
  if (m.type === "video") return isReleased(cfg, "video");
  if (m.type === "image") return isReleased(cfg, "images");
  if (m.type !== "chat") return false;
  if ((m.architecture?.output_modalities || []).includes("image"))
    return isReleased(cfg, "images");
  return isReleased(cfg, "catalog") || (cfg.mvpModels || []).includes(m.id);
}

// Which update a request belongs to, if it isn't part of the MVP.
function featureFor(req) {
  const p = req.path,
    post = req.method === "POST",
    body = req.body || {};
  if (p.startsWith("/api/videos")) return "video";
  if (p.startsWith("/api/audio")) return "audio";
  if (p.startsWith("/api/collabs")) return "collab";
  if (p === "/api/images" && post) return "images";
  if (p === "/v1" || p.startsWith("/v1/")) return "api";
  if (p === "/api/keys" && post) return "api";
  if (["/install.sh", "/install.ps1", "/cli.mjs"].includes(p)) return "api";
  if (p === "/api/credits/send" || p === "/api/referrals") return "social";
  if ((p === "/api/chat" || p === "/api/conversations") && post) {
    if (body.mode === "code") return "code";
    if (
      p === "/api/chat" &&
      (body.web_search === true ||
        (Array.isArray(body.plugins) && body.plugins.some((x) => x?.id === "web")))
    )
      return "search";
  }
  return null;
}

export function releaseGuard(cfg) {
  return (req, res, next) => {
    const feature = featureFor(req);
    if (feature && !isReleased(cfg, feature)) {
      const update = UPDATES.find((u) => u.id === feature);
      fail(403, `${update.title} is coming soon.`, "feature_unreleased");
    }
    next();
  };
}

// What the app needs to show released features and the roadmap.
export function releaseInfo(cfg) {
  return {
    all: !cfg.released || cfg.released === "all",
    features: Object.fromEntries(IDS.map((id) => [id, isReleased(cfg, id)])),
    updates: UPDATES.map((u, i) => ({
      ...u,
      number: i + 1,
      released: isReleased(cfg, u.id),
    })),
  };
}
