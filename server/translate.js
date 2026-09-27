import { chatLimits } from "../data/chat-limits.js";
import { isReleased } from "./releases.js";
import { tokenCost, usdUnits } from "./core.js";
import { TRANSLATE_MAX_TOKENS } from "../src/translate-spec.js";

// Translate Documents ("doctranslate"): what one part may cost. The route is
// server/routes/translate.js; what's shared with the browser is
// src/translate-spec.js; the local test stand-in is server/translate-test.js.

// The smallest reply room worth sending a part with. A model whose context
// can't leave this much after the part is refused before anything is held.
export const MIN_ROOM = 2000;

// The reply room for one part on this model: TRANSLATE_MAX_TOKENS, within
// what /api/chat would allow it (its output limit once Longer Answers is
// live, else the MVP's 8,192) and what its context leaves after the request.
export function partBudget(cfg, m, bytes) {
  const limits = chatLimits(m);
  const cap = isReleased(cfg, "longanswers") ? limits.maxOutputTokens : 8192;
  const room = (limits.contextTokens || 32768) - bytes;
  return { budget: Math.max(1, Math.min(TRANSLATE_MAX_TOKENS, cap, room)), room };
}

// The most one part can cost, in integer units at the account's rate, from
// its priced request's size ({ json, bytes }, src/translate-spec.js
// measure): the request's token estimate plus the whole reply room, priced
// the way chat prices a request (core.js quote and chatPrice). A quote
// (sizes only) and a run (the real messages) both use this, so the maximum
// shown is exactly what's held.
export function partCost(cfg, m, size, factor) {
  const { budget, room } = partBudget(cfg, m, size.bytes);
  const units = Math.ceil(usdUnits(tokenCost(m, Math.ceil(size.json / 2), budget)) * factor);
  return { budget, room, units };
}
