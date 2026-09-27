import { HELPER_SYSTEM } from "../src/auto-model.js";

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for
// Auto Model's helper (server/auto-model.js), so the flow can be driven
// without a provider. Never used live.
export function autoHelperTestReply(messages) {
  if (messages?.[0]?.role !== "system" || messages[0].content !== HELPER_SYSTEM) return null;
  const said = String(messages[1]?.content || "").split("<message>")[1] || "";
  if (/\b(plan|compare|trade-?offs?|strategy|why|risks?)\b|(计划|比较|策略|为什么|风险)/i.test(said))
    return JSON.stringify({ tier: "reasoning", reason: "analysis" });
  if (/\b(write|draft|email|letter|story|poem|announcement)\b|(写|起草|邮件|故事)/i.test(said))
    return JSON.stringify({ tier: "balanced", reason: "writing" });
  return JSON.stringify({ tier: "balanced", reason: "general" });
}
