export const CONTINUE_PROMPT = "Continue from where your last answer stopped. Do not repeat the part already written.";
export const replyBudgetFor = (model, requested = 8192) =>
  Math.min(requested, model?.chatLimits?.maxOutputTokens || 8192);
export function replyBudgets(model, selected) {
  const cap = model?.chatLimits?.maxOutputTokens || 8192;
  // A budget selected on a previous model may be a nonstandard cap. Keep it
  // visible when it still fits, so the select never hides the actual request.
  return [...new Set([... [4096, 8192, 16384, 32768, selected].filter(n => Number.isSafeInteger(n) && n > 0 && n <= cap), cap])].sort((a,b) => a-b);
}
export const completionNotice = (m) => m.finishReason === "length"
  ? "The model reached its reply limit. Your answer is kept."
  : m.interrupted ? "The reply was interrupted. The partial answer is kept; check its receipt before continuing." : null;
