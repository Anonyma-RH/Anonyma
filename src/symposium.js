// Pure helpers for the Symposium workspace mode, kept framework-free so
// tests can import them directly (see tests/symposium.test.mjs).

// A sensible default selection: the first few callable chat models, in
// whatever order the caller's list is already sorted (sortModels in lib.js
// puts popular, callable models first).
export function defaultSymposiumModels(models, count = 3) {
  return models
    .filter((m) => m.type === "chat" && m.callable)
    .slice(0, count)
    .map((m) => m.id);
}

// The fusion request: one system instruction, then the original question and
// every model's answer labelled by name, so the fusing model can compare
// them instead of just concatenating them.
export function buildFusionMessages({ question, answers }) {
  const labelled = (answers || [])
    .filter((a) => a?.text?.trim())
    .map((a) => `### ${a.name}\n${a.text.trim()}`)
    .join("\n\n");
  return [
    {
      role: "system",
      content:
        "You are fusing answers from several AI models that were each asked the same question. " +
        "Write one best answer. Then add a short closing section noting briefly where the models " +
        "agreed and where they disagreed. Do not simply concatenate the answers.",
    },
    {
      role: "user",
      content: `Question:\n${question || ""}\n\nAnswers:\n\n${labelled}`,
    },
  ];
}

// Sums per-model credit quotes into a total estimate; unresolved or failed
// quotes (no numeric credits) are skipped rather than breaking the total.
export function totalEstimate(quotes) {
  return Object.values(quotes || {}).reduce(
    (sum, q) => sum + (Number.isFinite(q?.credits) ? q.credits : 0),
    0,
  );
}
