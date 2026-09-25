import { fail } from "./core.js";
import {
  parseHolderRewards,
  parseHolderLoyalty,
  BASE_CAPS,
  HOLDER_CAPS,
  CYCLE_DAYS,
} from "./holder-tiers.js";

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
    released: true,
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
    released: true,
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
  {
    id: "documents",
    title: "Documents",
    tagline: "Bring the document. Ask the question.",
    points: [
      "PDFs, text, CSV and code files",
      "Text extracted in your browser",
      "Tidy document chips in every chat",
    ],
    released: true,
  },
  {
    id: "symposium",
    title: "Symposium",
    tagline: "Ask several models at once.",
    points: [
      "Up to four models side by side",
      "A receipt for every answer",
      "Fuse the answers into one",
    ],
    released: true,
  },
  {
    id: "receipts",
    title: "Signed Receipts",
    tagline: "Proof of what ran, and what it cost.",
    points: [
      "Every settled reply gets an Ed25519-signed receipt",
      "Anyone can verify it, including the answer text",
      "The public key is published for independent checks",
    ],
    released: true,
  },
  {
    id: "scrolls",
    title: "Scrolls",
    tagline: "Save the prompt. Skip the retyping.",
    points: [
      "Saved prompts with fill-in blanks",
      "Type / to insert one",
      "Standing instructions for every chat",
    ],
    released: true,
  },
  {
    id: "app",
    title: "Install the App",
    tagline: "Your workspace, one tap away.",
    points: [
      "Install on phone or desktop",
      "Opens straight into your workspace",
      "Share links and text into a chat",
    ],
    released: true,
  },
  {
    id: "training",
    title: "Training Labels",
    tagline: "Know when a provider learns from your prompts.",
    points: [
      "A clear label on models whose provider trains on what you send",
      "One tap to the version that doesn't",
      "Flagged in the API too",
    ],
    released: true,
  },
  {
    id: "mcp",
    title: "MCP Server",
    tagline: "Your balance, inside any AI tool.",
    points: [
      "A remote MCP server at /mcp",
      "Works with Claude Code, Cursor and other MCP clients",
      "Same keys, same ledger, no new account",
    ],
    released: true,
  },
  {
    id: "allowances",
    title: "Agent Allowances",
    tagline: "Give an agent a budget, not your wallet.",
    points: [
      "A lifetime credit cap per key",
      "Optional expiry and a pause switch",
      "One glance at what an agent spent",
    ],
    released: true,
  },
  {
    id: "connect",
    title: "Connect an App",
    tagline: "Let an app in. Keep the rest private.",
    points: [
      "One click, no key to paste",
      "Its own budget, expiry and off switch",
      "Private models only by default",
    ],
    released: true,
  },
  {
    id: "estimates",
    title: "Credit Estimates",
    tagline: "See the cost before you send.",
    points: [
      "A live credit estimate beside Send",
      "Updates as you type, switch models or turn on Web",
      "Priced on the same request Send makes, Veil masking included",
    ],
    released: true,
  },
  {
    id: "branches",
    title: "Edit, Regenerate & Branch Chats",
    tagline: "Try it another way. Keep the original.",
    points: [
      "Edit an earlier prompt and ask again",
      "Regenerate an answer without losing the first one",
      "Branches link back to where they started",
    ],
    released: true,
  },
  {
    id: "holders",
    title: "NYMA Holder Program",
    tagline: "Hold NYMA, get credits and perks.",
    points: [
      "ANONYMA credits every 30 days, by tier",
      "A bigger library, early access and a roadmap vote",
      "No staking or locking: your NYMA stays in your wallet",
    ],
    released: false,
  },
  {
    id: "v1media",
    title: "Multimodal API",
    tagline: "Images, voice and video in your code.",
    points: [
      "Generate images with one POST",
      "Text to speech and speech to text",
      "Submit and poll video jobs",
    ],
    released: false,
  },
];
// Connect an App issues MCP tokens that spend through an agent allowance on
// the API's hold/settle path, so it is live only when all four are.
export const CONNECT_UPDATES = ["api", "mcp", "allowances", "connect"];
const IDS = UPDATES.map((u) => u.id);
// The NYMA an account must hold for early access is the Insider tier's
// minimum in HOLDER_REWARDS (server/holder-tiers.js): 5,000,000 by default,
// 0.5% of the 1,000,000,000 supply.
const holderTiers = (cfg) => cfg?.holderRewards ?? parseHolderRewards();
export const earlyAccessMin = (cfg) => holderTiers(cfg)[1].min;

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
//
// Early access: an entry may also say `early: true`. Once the NYMA Holder
// Program ("holders") is live, an early update that isn't released yet opens
// for accounts at the Insider tier or above (the rule is earlyAccessHolder in
// server/holders.js), and for no one else.
// Absent means the update waits for its public release like any other.
export const isReleased = (cfg, id) =>
  cfg.released === "all" ||
  (cfg.released instanceof Set && cfg.released.has(id)) ||
  UPDATES.some((u) => u.id === id && u.released === true);
export const connectLive = (cfg) =>
  CONNECT_UPDATES.every((id) => isReleased(cfg, id));
// Never early: the Holder Program itself, and Connect an App, whose OAuth
// flow is driven by the outside app, which would learn from it whether the
// account holds NYMA.
const NEVER_EARLY = ["connect", "holders"];
// An update open to early-access holders right now: marked `early`, not yet
// released, and the Holder Program itself is live. Global, never per user.
export const earlyOpen = (cfg, id) =>
  !NEVER_EARLY.includes(id) &&
  !isReleased(cfg, id) &&
  isReleased(cfg, "holders") &&
  UPDATES.some((u) => u.id === id && u.early === true);
export const earlyUpdates = (cfg) => IDS.filter((id) => earlyOpen(cfg, id));

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

// All release gates required by a request. featureFor is the first gate.
export const featureFor = (req) => featuresFor(req)[0] || null;
export function featuresFor(req) {
  // Express matches routes regardless of case, so the gates must too:
  // /OAuth/register reaches the same handler as /oauth/register.
  const p = String(req.path).toLowerCase(),
    post = req.method === "POST",
    body = req.body || {};
  if (p.startsWith("/api/videos")) return ["video"];
  if (p.startsWith("/api/audio")) return ["audio"];
  if (p.startsWith("/api/collabs")) return ["collab"];
  if (p === "/api/images" && post) return ["images"];
  // The /v1 media endpoints need the API, the multimodal update itself, and
  // whichever studio update backs that media type.
  if (p.startsWith("/v1/images")) return ["api", "v1media", "images"];
  if (p.startsWith("/v1/audio")) return ["api", "v1media", "audio"];
  if (p.startsWith("/v1/videos")) return ["api", "v1media", "video"];
  if (p === "/v1" || p.startsWith("/v1/")) return ["api"];
  if (p === "/api/keys" && post) return ["api"];
  // Allowances extend an API key's authorization, so they need the API
  // update released too.
  if (/^\/api\/keys\/[^/]+\/(allowance|pause|resume|usage)$/.test(p))
    return ["api", "allowances"];
  if (["/install.sh", "/install.ps1", "/cli.mjs"].includes(p)) return ["api"];
  // The MCP server runs on the API's key auth, rate limits and hold/settle
  // path, so it needs "api" released as well as "mcp".
  if (p === "/mcp" || p.startsWith("/mcp/")) return ["mcp", "api"];
  // One-click connect: OAuth discovery, registration, authorization, tokens
  // and the account's connected-apps controls.
  if (
    p.startsWith("/.well-known/oauth-") ||
    p === "/oauth" ||
    p.startsWith("/oauth/") ||
    p === "/api/connections" ||
    p.startsWith("/api/connections/")
  )
    return [...CONNECT_UPDATES];
  // The installable app's manifest, service worker and offline page.
  if (
    ["/manifest.webmanifest", "/sw.js", "/offline.html", "/offline.js"].includes(
      p,
    )
  )
    return ["app"];
  if (p === "/api/credits/send" || p === "/api/referrals") return ["social"];
  if (
    p === "/api/account/wallet/unlink" ||
    p === "/api/account/holdings" ||
    p === "/api/holders" ||
    p.startsWith("/api/holders/")
  )
    return ["holders"];
  if (p.startsWith("/api/receipts") || p === "/.well-known/anonyma-receipts.json")
    return ["receipts"];
  if (p.startsWith("/api/retention")) return ["ephemeral"];
  // Branching a saved conversation (edit and regenerate use it too).
  if (/^\/api\/conversations\/[^/]+\/branch$/.test(p)) return ["branches"];
  if (
    p === "/api/scrolls" ||
    p.startsWith("/api/scrolls/") ||
    p === "/api/instructions" ||
    p.startsWith("/api/instructions/")
  )
    return ["scrolls"];
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
    if (body.mode === "symposium") needed.push("symposium");
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

// `holder(req)` says whether the request comes from an early-access holder
// (requestHolder in server/holders.js). It's asked only when a gate is an
// early update, at most once per request. Without it, nobody gets in early.
export function releaseGuard(cfg, holder = () => false) {
  return (req, res, next) => {
    let isHolder;
    const open = (id) =>
      isReleased(cfg, id) ||
      (earlyOpen(cfg, id) && (isHolder ??= holder(req) === true));
    const feature = featuresFor(req).find((id) => !open(id));
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
      // Public product information: which updates holders can use early.
      early: earlyOpen(cfg, u.id),
    })),
    uncensoredModels: UNCENSORED_MODELS,
    earlyAccess: {
      threshold: earlyAccessMin(cfg),
    },
    // The NYMA Holder Program's public settings, once it's live: the same
    // for everyone, never anything about an account.
    holderProgram: isReleased(cfg, "holders")
      ? {
          cycleDays: CYCLE_DAYS,
          tiers: holderTiers(cfg).map(({ id, name, perk, min, credits }) => ({
            id,
            name,
            perk,
            min,
            credits,
          })),
          loyalty: cfg?.holderLoyalty ?? parseHolderLoyalty(),
          caps: { standard: BASE_CAPS, holder: HOLDER_CAPS },
        }
      : null,
  };
}
