// Model Finder & Presets: searchable model choice with Cheap / Balanced /
// Best quality presets. Pure and DOM-free so it can be unit tested in node;
// the React side is ModelFinder.jsx.
//
// Prices come only from the live catalog. Cost does not establish quality.
// Best quality is our documented editorial recommendation by task, using
// exact reviewed catalog IDs. Neither a provider name nor price is evidence.
import { videoPresets } from "./lib.js";

export const PRESETS = [
  { id: "cheap", label: "Cheap", note: "Lowest eligible published price" },
  { id: "balanced", label: "Balanced", note: "A popular model at a middle price" },
  {
    id: "best",
    label: "Best quality",
    note: "Our task recommendation, based on documented capabilities; not a benchmark",
  },
];
const PRESET_IDS = PRESETS.map((p) => p.id);
export const DEFAULT_CHOICE = { preset: "balanced" };
// A typical text exchange, used to compare token prices on one number.
export const TYPICAL = { input: 2000, output: 1000 };

const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

// USD for one typical request in this mode, or null when the catalog has no
// published price: a text exchange, one image, or the cheapest video option.
export function usdPrice(m, mode) {
  if (mode === "image") return finite(m?.imagePrice) ? m.imagePrice : null;
  if (mode === "video") {
    const prices = videoPresets(m).map((p) => p.price).filter(finite);
    return prices.length ? Math.min(...prices) : null;
  }
  const i = m?.pricing?.input_per_1M_tokens,
    o = m?.pricing?.output_per_1M_tokens;
  if (!finite(i) || !finite(o)) return null;
  return (i * TYPICAL.input + o * TYPICAL.output) / 1e6;
}
// Credits at the standard rate (1,000 credits per USD plus the markup).
export const toCredits = (usd, markup = 0) =>
  usd == null ? null : usd * 1000 * (1 + (Number(markup) || 0) / 100);
export const creditPrice = (m, mode, markup) => toCredits(usdPrice(m, mode), markup);

// What each preset chooses from: priced, callable models (the demo's sample
// catalog isn't callable), and (when
// asked) models whose provider doesn't train on prompts whenever any remain.
// Sorted by price, then name.
export function presetPool(models, { mode, avoidTraining = false, demo = false } = {}) {
  const priced = models.filter(
    (m) => (demo || m.callable !== false) && usdPrice(m, mode) != null,
  );
  let pool = priced;
  if (avoidTraining) {
    const clean = pool.filter((m) => !m.trainsOnPrompts);
    if (clean.length) pool = clean;
  }
  return [...pool].sort(
    (a, b) =>
      usdPrice(a, mode) - usdPrice(b, mode) ||
      String(a.name).localeCompare(String(b.name)),
  );
}
// Reviewed 2026-09-25 against the public callable catalog and primary provider
// documentation. Ordering is editorial preference for this task, not a
// cross-provider score or a claim of universal superiority. Unknown IDs,
// router aliases and future model versions are never inferred into this list.
export const QUALITY_GUIDANCE = [
  { id: "gpt-5.3-codex", modes: ["code"],
    reason: "Coding and software-engineering work",
    source: "https://openai.com/index/introducing-gpt-5-3-codex/" },
  { id: "anthropic/claude-opus-5", modes: ["chat", "code"],
    reason: "Careful knowledge work and complex problem-solving",
    source: "https://www.anthropic.com/news/claude-opus-5" },
  { id: "qwen/qwen3.5-397b-a17b", modes: ["chat", "code"],
    reason: "Multimodal reasoning and coding; a reviewed alternative for Private mode",
    source: "https://huggingface.co/Qwen/Qwen3.5-397B-A17B" },
  { id: "gpt-image-2.5-sunburst", modes: ["image"],
    reason: "Precision for detailed image creation and editing",
    source: "https://openai.com/index/introducing-chatgpt-images-2-5/" },
  { id: "gpt-image-2", modes: ["image"],
    reason: "High-fidelity image generation and editing",
    source: "https://developers.openai.com/api/docs/models/gpt-image-2" },
  { id: "veo3", modes: ["video"],
    reason: "Video realism, prompt adherence and native audio",
    source: "https://deepmind.google/models/veo/" },
];
export function qualityGuidance(model, mode) {
  return QUALITY_GUIDANCE.find((g) => g.id === model?.id && g.modes.includes(mode)) || null;
}
export function pickQuality(models, opts = {}) {
  const pool = presetPool(models, opts).filter(m => m.callable === true &&
    (!opts.privateMode || m.private) && (!opts.needsVision || m.vision));
  for (const g of QUALITY_GUIDANCE) {
    if (!g.modes.includes(opts.mode)) continue;
    const m = pool.find(m => m.id === g.id);
    if (m) return m;
  }
  return null;
}
export function pickPreset(models, preset, opts = {}) {
  if (preset === "best") return pickQuality(models, opts);
  const pool = presetPool(models, opts);
  if (!pool.length) return null;
  if (preset === "cheap") return pool[0];
  const popular = pool.filter((m) => m.popular);
  const balanced = popular.length >= 3 ? popular : pool;
  return balanced[Math.floor((balanced.length - 1) / 2)];
}

// Why a remembered model can't be used here, in words for the notice.
export function whyUnavailable(m, { privateMode = false, needsVision = false } = {}) {
  if (!m) return "isn't in the catalog any more";
  if (m.callable === false) return "isn't available right now";
  if (privateMode && !m.private)
    return "isn't a zero-data-retention model, which Private mode needs";
  if (needsVision && !m.vision) return "can't read the images you attached";
  return "isn't available here";
}

// The model to use for a saved or explicit choice among `models` (already
// filtered to what this task, section, privacy and release allow).
// A remembered model that isn't there falls back to Balanced, with a reason.
export function resolveChoice(choice, models, allModels = models, opts = {}) {
  const c = validChoice(choice) || DEFAULT_CHOICE;
  if (c.model) {
    const m = models.find((x) => x.id === c.model);
    if (m) return { model: m, via: "model" };
    const wanted = allModels.find((x) => x.id === c.model);
    const fallback = pickPreset(models, "balanced", opts) || models[0] || null;
    return {
      model: fallback,
      via: "preset",
      preset: "balanced",
      fallback: { wanted: wanted?.name || c.model, reason: whyUnavailable(wanted, opts) },
    };
  }
  if (c.preset === "best" && !pickQuality(models, opts)) {
    return {
      model: pickPreset(models, "balanced", opts) || models[0] || null,
      via: "preset",
      preset: "balanced",
      fallback: {
        wanted: "Best quality",
        reason: "has no reviewed recommendation among the models available here",
      },
    };
  }
  return {
    model: pickPreset(models, c.preset, opts) || models[0] || null,
    via: "preset",
    preset: c.preset,
  };
}

// Every word must match the name, id, provider, description or a tag.
export function searchModels(models, query, { mode } = {}) {
  const terms = String(query || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/\s+/)
    .filter(Boolean);
  if (!terms.length) return models;
  return models.filter((m) => {
    const hay = [
      m.name,
      m.id,
      m.provider,
      m.description,
      m.private ? "private zero data retention zdr" : "",
      m.vision ? "vision images sees" : "",
      m.trainsOnPrompts ? "trains on prompts" : "",
      usdPrice(m, mode) === 0 ? "free" : "",
    ]
      .join(" ")
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "");
    return terms.every((t) => hay.includes(t));
  });
}

// Keyboard movement through a list of `length` options.
export function moveActive(index, key, length) {
  if (!length) return -1;
  const i = index < 0 ? -1 : Math.min(index, length - 1);
  switch (key) {
    case "ArrowDown":
      return i + 1 >= length ? 0 : i + 1;
    case "ArrowUp":
      return i <= 0 ? length - 1 : i - 1;
    case "Home":
      return 0;
    case "End":
      return length - 1;
    case "PageDown":
      return Math.min(length - 1, Math.max(0, i) + 5);
    case "PageUp":
      return Math.max(0, i - 5);
    default:
      return i;
  }
}

// Saved choices: per workspace mode, in this browser only, and only what the
// person chose themselves (never a fallback).
export const STORAGE_KEY = "model-choices";
const MODES = ["chat", "code", "uncensored", "image", "video"];
export function validChoice(c) {
  if (!c || typeof c !== "object") return null;
  if (PRESET_IDS.includes(c.preset)) return { preset: c.preset };
  if (typeof c.model === "string" && c.model && c.model.length <= 200) return { model: c.model };
  return null;
}
export function loadChoices(read) {
  const saved = read(STORAGE_KEY, {});
  const out = {};
  if (saved && typeof saved === "object")
    for (const mode of MODES) {
      const c = validChoice(saved[mode]);
      if (c) out[mode] = c;
    }
  return out;
}
export function withChoice(choices, mode, choice) {
  const c = validChoice(choice);
  return c && MODES.includes(mode) ? { ...choices, [mode]: c } : choices;
}

// Inspect the same built request used by quote/Send, including retained image
// history. Image capability must not disappear when the composer is cleared.
export function requestNeedsVision(request = []) {
  return request.some((m) => Array.isArray(m.content) &&
    m.content.some((part) => part.type === "image_url"));
}
