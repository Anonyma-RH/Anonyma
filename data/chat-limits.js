// Service limits, not a promise that every provider can return this much.
// Exact stable IDs only; moving aliases never inherit a guessed capacity.
// Official limits checked 2026-09-25:
// https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash
// https://platform.claude.com/docs/en/models/overview
const DOCUMENTED_OUTPUT = {
  "google/gemini-2.5-flash": 65536,
  "gemini-2.5-flash": 65536,
  "claude-fable-5.1": 128000,
  "anthropic/claude-fable-5.1": 128000,
  "claude-sonnet-5": 128000,
  "anthropic/claude-sonnet-5": 128000,
  "anthropic/claude-haiku-4.5": 64000,
  "claude-haiku-4.5": 64000,
  "claude-opus-5.5": 128000,
  "anthropic/claude-opus-5.5": 128000,
};
export const CHAT_SERVICE_OUTPUT = 32768;
export const CHAT_SERVICE_MESSAGES = 200;
export const CHAT_SERVICE_CHARACTERS = 240000;
const positive = (n) => Number.isSafeInteger(n) && n > 0;
export function chatLimits(model = {}) {
  const published = [model.max_output_tokens, model.max_completion_tokens,
    model.top_provider?.max_completion_tokens, DOCUMENTED_OUTPUT[model.id]].filter(positive);
  const context = [model.context_length, model.top_provider?.context_length,
    model.max_input_tokens].filter(positive);
  const contextTokens = context.length ? Math.min(...context) : null;
  return {
    contextTokens,
    maxOutputTokens: Math.min(CHAT_SERVICE_OUTPUT, published.length ? Math.min(...published) : 8192,
      contextTokens ? Math.max(1, contextTokens - 256) : 8192),
    outputLimitKnown: published.length > 0,
    outputSource: published.length ? "Published model limit, bounded by the service" : "Conservative service limit; provider output limit unavailable",
    maxMessages: CHAT_SERVICE_MESSAGES,
    maxCharacters: CHAT_SERVICE_CHARACTERS,
  };
}
// A deliberately conservative text estimate, not an exact tokenizer. The
// provider remains authoritative (particularly for image token accounting).
export function contextEstimate(messages) {
  const encoder = new TextEncoder();
  return messages.reduce((sum, m) => sum + 8 + (typeof m.content === "string"
    ? encoder.encode(m.content).length
    : m.content.reduce((n, p) => n + (p.type === "image_url" ? 8192 : encoder.encode(p.text || "").length), 0)), 8);
}
