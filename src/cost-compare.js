// Cost Compare: the message being written, priced on other models before
// it's sent. Pure and DOM-free so it can be unit tested in node; the React
// side is CostCompare.jsx and the server side server/routes/cost-compare.js,
// which prices every model with the same code as /api/quote and Send.
import { formatCredits } from "./estimate.js";
import { PRESETS, pickPreset } from "./model-finder.js";

// The server prices at most this many models per request
// (MAX_COMPARE_MODELS in server/routes/cost-compare.js).
export const MAX_COMPARE = 8;
// Models the person adds by hand, on top of the one in use and the presets.
export const MAX_PICKED = 4;

export const ROLE_LABELS = {
  current: "In use",
  cheap: "Cheap",
  balanced: "Balanced",
  best: "Best quality",
  picked: "Added",
};

// The Model Finder presets for this pool, chosen exactly as the picker
// chooses them (same models, same options), or none when it isn't live.
export function comparePresets(models, opts, live = true) {
  if (!live) return [];
  return PRESETS.map((p) => ({
    id: p.id,
    model: pickPreset(models, p.id, opts),
  }));
}

// The models a comparison prices, in order: the one in use, then the
// presets, then the person's own picks. Each model appears once, with every
// role it has, and never more than the server's cap.
export function compareSet({ current, presets = [], picked = [] }) {
  const out = [];
  const add = (id, role) => {
    if (typeof id !== "string" || !id) return;
    const row = out.find((r) => r.id === id);
    if (row) {
      if (!row.roles.includes(role)) row.roles.push(role);
      return;
    }
    if (out.length < MAX_COMPARE) out.push({ id, roles: [role] });
  };
  add(current, "current");
  for (const p of presets) add(p.model?.id, p.id);
  for (const id of picked.slice(0, MAX_PICKED)) add(id, "picked");
  return out;
}

// The comparison's request: the chip's quote body (the same messages,
// memory, Web and team settings Send would post) with the reply budget as
// chosen, before any one model's limit, so each model is priced at the
// budget Send would ask it for. Private mode and the section are sent so
// the server applies the picker's rules too.
export function compareBody(
  base,
  { models, mode = "chat", replyBudget, privateMode = false },
) {
  if (!base || !models?.length) return null;
  const rest = { ...base };
  delete rest.model;
  return {
    ...rest,
    ...(replyBudget ? { max_tokens: replyBudget } : {}),
    mode,
    ...(privateMode ? { private: true } : {}),
    models,
  };
}

// What the person reads when a model can't take this message. Codes come
// from the server; the words are the app's own (translated in zh.json).
export const REFUSALS = {
  context_limit_exceeded: "Too long for this model",
  vision_required: "Can't read your images",
  private_model_required: "Not a private model",
  other_section: "Not offered in this section",
  model_unavailable: "Not available right now",
  model_not_found: "No longer in the catalog",
  unpriced_model: "No published price",
  unsupported_model: "Not a chat model",
  early_model: "Open to NYMA Insiders first",
};
export const refusalText = (code) =>
  REFUSALS[code] || "Can't be priced for this message";

// Rows in reading order: the model in use first, then every priced model
// from cheapest to dearest, then the ones that can't take this message.
export function compareRows(response, set) {
  const byId = new Map((response?.results || []).map((r) => [r.model, r]));
  const rows = set.map((s) => ({ ...s, result: byId.get(s.id) || null }));
  const rank = (r) =>
    r.roles.includes("current") ? 0 : r.result?.status === "ok" ? 1 : 2;
  return rows
    .map((r, i) => ({ r, i }))
    .sort(
      (a, b) =>
        rank(a.r) - rank(b.r) ||
        (rank(a.r) === 1 ? a.r.result.credits - b.r.result.credits : 0) ||
        a.i - b.i,
    )
    .map(({ r }) => r);
}

// The difference against the model in use, from the server's own
// subtraction (whole units), never recomputed from rounded figures.
export function differenceLabel(result) {
  const d = result?.difference;
  if (result?.status !== "ok" || d == null || !Number.isFinite(d)) return null;
  if (d === 0) return { text: "Same price", tone: "same" };
  return {
    text: `${d > 0 ? "+" : "−"}${formatCredits(Math.abs(d))} credits`,
    tone: d > 0 ? "dearer" : "cheaper",
  };
}

// How the price compares, in words: "25% less", "40% more", "3.2× the price".
export function relativeLabel(credits, base) {
  const c = Number(credits),
    b = Number(base);
  if (!Number.isFinite(c) || !Number.isFinite(b) || b <= 0 || c === b)
    return null;
  const r = c / b;
  if (r >= 1.995) return `${r.toFixed(1)}× the price`;
  // A saving is rounded down, so a model that isn't free never reads
  // "100% less"; an increase is rounded to the nearest percent.
  const pct = r < 1 ? Math.floor((1 - r) * 100) : Math.round((r - 1) * 100);
  if (!pct) return null;
  return r > 1 ? `${pct}% more` : `${pct}% less`;
}

// Whether a price would be refused anyway: over the balance, or over what's
// left under the account's own spending limits. Same wording as the chip.
export function overLabel(result, response) {
  if (result?.status !== "ok") return null;
  if (response?.available != null && result.credits > response.available)
    return "over your balance";
  const room = response?.spending_limit?.remaining;
  if (room != null && result.credits > room) return "over your spending limit";
  return null;
}

// "≈36,016 input + 8,192 reply tokens; allowance 1,048,576"
export function contextLabel(context) {
  if (!context) return null;
  const n = (v) => Number(v).toLocaleString("en-US");
  return `≈${n(context.input_tokens_estimate)} input + ${n(context.reply_budget)} reply tokens; allowance ${n(context.allowance)}`;
}

// Search results the person could still add: not already compared, and
// only while there's room for another pick.
export function addable(results, set, picked = []) {
  if (picked.length >= MAX_PICKED || set.length >= MAX_COMPARE) return [];
  const taken = new Set(set.map((s) => s.id));
  return results.filter((m) => !taken.has(m.id));
}
