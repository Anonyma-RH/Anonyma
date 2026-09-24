// Pure helpers for the Symposium workspace mode, kept framework-free so
// tests can import them directly (see tests/symposium.test.mjs).

// A sensible default selection: the first few callable chat models in the
// caller's order (sortModels in lib.js puts popular ones first), preferring
// one per provider so a symposium starts with genuinely different voices.
export function defaultSymposiumModels(models, count = 3) {
  const chat = models.filter((m) => m.type === "chat" && m.callable);
  const picked = [],
    providers = new Set();
  for (const m of chat) {
    const provider = m.provider || m.id;
    if (picked.length < count && !providers.has(provider)) {
      picked.push(m.id);
      providers.add(provider);
    }
  }
  for (const m of chat) if (picked.length < count && !picked.includes(m.id)) picked.push(m.id);
  return picked;
}

// Picker filter: selected models first, then name/id matches, capped so a
// catalog of hundreds of models stays a short, scannable list.
export function pickerModels(models, selected, query, limit = 60) {
  const q = query.trim().toLowerCase();
  const chosen = models.filter((m) => selected.includes(m.id));
  const rest = models.filter(
    (m) => !selected.includes(m.id) && (!q || (m.name + " " + m.id).toLowerCase().includes(q)),
  );
  return [...chosen, ...rest.slice(0, limit)];
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
