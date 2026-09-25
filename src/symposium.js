// Pure helpers for the Symposium workspace mode, kept framework-free so
// tests can import them directly (see tests/symposium.test.mjs).
import { veil } from "./veil.js";

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
// Quotes carry up to four decimals (whole subcredits), so the sum is rounded
// back to four to drop binary floating-point noise.
export function totalEstimate(quotes) {
  const sum = Object.values(quotes || {}).reduce(
    (total, q) => total + (Number.isFinite(q?.credits) ? q.credits : 0),
    0,
  );
  return Number(sum.toFixed(4));
}

// Veil for one Symposium run. The question is masked once with the run's veil
// state, and that masked text is what every column and the fusion step send,
// so all models see the same tags and one map restores every answer on
// screen. With Veil off the question passes through unchanged.
export function veilQuestion(question, { on = false, state, words = [] } = {}) {
  if (!on || !state) return { text: question, count: 0, entries: [] };
  const r = veil(question, state, words);
  return {
    text: r.text,
    count: r.count,
    entries: [...new Set(r.tags)].map((tag) => ({ tag, value: state.map[tag] })),
  };
}

// The asked question for display: plain text runs, and veil tags resolved to
// their real values from the run's map. A tag with no entry stays as written.
export function veilSegments(text, map = {}) {
  const source = text || "",
    out = [],
    re = /\[([A-Z]+_\d+)\]/g;
  let cursor = 0,
    m;
  while ((m = re.exec(source))) {
    if (!Object.prototype.hasOwnProperty.call(map, m[1])) continue;
    if (m.index > cursor) out.push({ text: source.slice(cursor, m.index) });
    out.push({ tag: m[1], value: map[m[1]] });
    cursor = m.index + m[0].length;
  }
  if (cursor < source.length) out.push({ text: source.slice(cursor) });
  return out;
}
