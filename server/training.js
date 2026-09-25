// Models whose provider uses what you send them to improve its products.
// One small, explicit rule per provider, each citing the provider's own
// wording, so another provider is one more entry here. A model can name an
// untrained alternative: the same model on terms that don't train on prompts.
export const TRAINING_RULES = [
  {
    // Meta sells Muse Spark in two tiers. Its model page
    // (dev.meta.ai/models/muse-spark) says the Contributor tier is "Used to
    // improve our products." and the Standard tier is "Not used to improve
    // our products." Contributor ids end in -contributor; the Standard twin
    // is the same id without it.
    provider: "Meta",
    matches: (m) =>
      (m.owned_by === "Meta" || m.id.startsWith("meta/")) &&
      m.id.endsWith("-contributor"),
    alternative: (m) => m.id.slice(0, -"-contributor".length),
  },
];

// { provider, alternative } when a rule flags the model, else null. The
// alternative is offered only when `offered` (a Set of ids listed alongside
// it) contains it, so it's always something the same response can pick.
export function trainingLabel(m, offered = new Set()) {
  if (typeof m?.id !== "string") return null;
  const rule = TRAINING_RULES.find((r) => r.matches(m));
  if (!rule) return null;
  const id = rule.alternative(m);
  return {
    provider: rule.provider,
    alternative: id && id !== m.id && offered.has(id) ? id : null,
  };
}

// The live ids a response lists, which an alternative must be one of.
export const liveIds = (list) =>
  new Set(list.filter((m) => m.status === "live").map((m) => m.id));

// /api/models' fields (the workspace and site read these).
export function trainingFields(m, offered) {
  const label = trainingLabel(m, offered);
  if (!label) return {};
  return label.alternative
    ? { trainsOnPrompts: true, untrainedAlternative: label.alternative }
    : { trainsOnPrompts: true };
}

// /v1/models' fields, in its OpenAI-style snake_case.
export function apiTrainingFields(m, offered) {
  const label = trainingLabel(m, offered);
  if (!label) return {};
  return label.alternative
    ? { trains_on_prompts: true, untrained_alternative: label.alternative }
    : { trains_on_prompts: true };
}
