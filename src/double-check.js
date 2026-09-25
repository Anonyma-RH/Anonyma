// Double-check This: ask a model from a different provider for a second
// opinion on an answer. Shared by the workspace (choosing the checker, building
// the request) and the server (refusing a checker from the same provider).
// "Provider" is the model's maker, so a second opinion never comes from a
// sibling model of the same family. It is not the hosting endpoint: the
// gateway may route either model to any host.

// Catalog maker names, lowercased with punctuation removed, mapped to one
// canonical maker. The live catalog spells the same maker several ways
// ("SpaceXAI", "xAI", "x-ai"; "Google", "google"; "Z.ai", "z-ai").
const MAKERS = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  googledeepmind: "google",
  deepmind: "google",
  xai: "xai",
  spacexai: "xai",
  meta: "meta",
  metallama: "meta",
  facebook: "meta",
  mistral: "mistral",
  mistralai: "mistral",
  zai: "zai",
  zhipu: "zai",
  zhipuai: "zai",
  thudm: "zai",
  moonshot: "moonshot",
  moonshotai: "moonshot",
  qwen: "alibaba",
  alibaba: "alibaba",
  alibabacloud: "alibaba",
  deepseek: "deepseek",
  deepseekai: "deepseek",
  bytedance: "bytedance",
  bytedanceseed: "bytedance",
  minimax: "minimax",
  microsoft: "microsoft",
  nvidia: "nvidia",
  amazon: "amazon",
  cohere: "cohere",
  nous: "nous",
  nousresearch: "nous",
};
// Hosts and routers name themselves in owned_by for models someone else
// made, so their rows are identified by model family instead. A host that
// also makes models (Venice) owns what no family matches; a router's, a pure
// host's or an undisclosed ("stealth") row stays unknown.
const HOSTS = {
  venice: "venice",
  tinfoil: "",
  ppqai: "",
  openrouter: "",
  private: "",
  stealth: "",
};
// Model families, matched at the start of the id (after any namespace) or
// after a separator, for ids without a namespace ("claude-opus-5.5",
// "grok-4.6") and for hosted rows ("private/gemma4-31b").
const FAMILIES = [
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["chatgpt", "openai"],
  ["gemini", "google"],
  ["gemma", "google"],
  ["grok", "xai"],
  ["llama", "meta"],
  ["glm", "zai"],
  ["kimi", "moonshot"],
  ["deepseek", "deepseek"],
  ["qwen", "alibaba"],
  ["qwq", "alibaba"],
  ["mistral", "mistral"],
  ["mixtral", "mistral"],
  ["devstral", "mistral"],
  ["ministral", "mistral"],
  ["magistral", "mistral"],
  ["codestral", "mistral"],
  ["pixtral", "mistral"],
];
const norm = (v) =>
  String(v || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");

function family(id) {
  const base = String(id || "")
    .toLowerCase()
    .split("/")
    .at(-1);
  let best = null;
  for (const [name, maker] of FAMILIES) {
    const at = base.search(new RegExp(`(?:^|[^a-z])${name}`));
    if (at >= 0 && (!best || at < best.at)) best = { at, maker };
  }
  return best?.maker || "";
}

// The canonical maker of a catalog model, or "" when it can't be
// established. Unknown is never treated as "different".
export function providerKey(m) {
  const owner = norm(m?.owned_by || m?.provider);
  const id = String(m?.id || "");
  const namespace = id.includes("/") ? norm(id.split("/")[0]) : "";
  for (const name of [owner, namespace]) {
    if (!name) continue;
    if (Object.hasOwn(HOSTS, name)) return family(id) || HOSTS[name];
    // A maker named by the catalog (or the id namespace) is taken as is,
    // canonicalised when it's a known spelling.
    return MAKERS[name] || name;
  }
  return family(id);
}

const LABELS = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  xai: "xAI",
  meta: "Meta",
  mistral: "Mistral",
  zai: "Z.ai",
  moonshot: "Moonshot AI",
  alibaba: "Alibaba (Qwen)",
  deepseek: "DeepSeek",
  venice: "Venice",
};
// The maker shown next to a checker; a hosted row says where it runs.
export function providerLabel(m) {
  const key = providerKey(m);
  if (!key) return "";
  const label = LABELS[key] || m?.owned_by || m?.provider || key;
  const host = norm(m?.owned_by || m?.provider);
  return Object.hasOwn(HOSTS, host) && HOSTS[host] !== key
    ? `${label} via ${m.owned_by || m.provider}`
    : label;
}

export const sameProvider = (a, b) => {
  const x = providerKey(a),
    y = providerKey(b);
  return !!x && x === y;
};
// Both makers are known and differ. This is what makes a checker eligible.
export const differentProvider = (a, b) => {
  const x = providerKey(a),
    y = providerKey(b);
  return !!x && !!y && x !== y;
};

// Callable chat models from other known providers, in the caller's order
// (popular first). With privateOnly, only models flagged private (zero
// retention). An answer whose provider can't be established gets none.
export function checkerCandidates(
  models,
  source,
  { privateOnly = false } = {},
) {
  if (!providerKey(source)) return [];
  return (models || []).filter(
    (m) =>
      m.type === "chat" &&
      m.callable &&
      m.id !== source?.id &&
      differentProvider(m, source) &&
      (!privateOnly || m.private),
  );
}

export const CHECK_TOKENS = 1500;

export const DISCLOSURE =
  "A second opinion from another provider's model, not fact verification. It can be wrong too.";

// The critique request: the question and the answer under review, labelled,
// with an instruction to review rather than re-answer or claim certainty.
export function buildCheckMessages({ question, answer, answerModel }) {
  return [
    {
      role: "system",
      content:
        "You are giving a second opinion on an answer written by a different AI model. " +
        "Review it: say what looks right, point out likely mistakes, missing caveats or " +
        "reasoning gaps, and what the reader should check independently. Be specific and brief. " +
        "You cannot verify facts beyond your own knowledge, so don't claim certainty, and " +
        "don't rewrite the whole answer.",
    },
    {
      role: "user",
      content:
        `Question:\n${question || "(not shown)"}\n\n` +
        `Answer from ${answerModel || "another model"}:\n${answer || ""}`,
    },
  ];
}

// Message content as plain text (image parts are left out).
const asText = (content) =>
  Array.isArray(content)
    ? content
        .filter((p) => p?.type === "text")
        .map((p) => p.text)
        .join("\n")
    : String(content || "");

// One request snapshot, used for both the estimate and the critique. With
// Veil active, `mask` (the chat's masker, with this conversation's map and
// the always-veil words) is applied to the question and the answer before
// anything leaves the browser, exactly as ordinary chat remasks its history.
// The stored answer itself is never changed. `key` identifies the exact
// content and masking policy, so an estimate for other content (or another
// policy) is stale.
export function checkSnapshot({
  question,
  answer,
  answerModel,
  mask,
  policy = "off",
}) {
  let masked = 0;
  const apply = (content) => {
    const text = asText(content);
    if (!mask || !text) return text;
    const r = mask(text);
    masked += r.count || 0;
    return r.text;
  };
  const messages = buildCheckMessages({
    question: apply(question),
    answer: apply(answer),
    answerModel,
  });
  return { messages, masked, key: JSON.stringify([policy, messages]) };
}

// Ask is allowed only with a settled estimate for this exact checker and
// snapshot, and never while a request is in flight.
export function canAsk({ checker, snapshotKey, quote, running }) {
  return (
    !!checker &&
    !running &&
    quote?.checker === checker &&
    quote?.key === snapshotKey &&
    quote?.credits != null
  );
}
