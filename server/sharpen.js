import { chatLimits, contextEstimate } from "../data/chat-limits.js";
import { isReleased } from "./releases.js";
import { chatPrice, tokenCost, usdUnits } from "./core.js";
import {
  SHARPEN_BUDGET,
  placeholderTags,
  readSharpenMessages,
  typicalOutputTokens,
} from "../src/sharpen.js";

// Prompt Sharpen (update "sharpen"): the reply room and prices for one
// sharpen, and the local test stand-in. The route is
// server/routes/sharpen.js; what's shared with the browser is src/sharpen.js.

// The reply room for this model: SHARPEN_BUDGET, within what /api/chat
// would allow it (its output limit once Longer Answers is live, else the
// MVP's 8,192) and what its context has left after the prompt.
export function sharpenBudget(cfg, m, messages) {
  const limits = chatLimits(m);
  const cap = isReleased(cfg, "longanswers") ? limits.maxOutputTokens : 8192;
  const room = (limits.contextTokens || 32768) - contextEstimate(messages);
  return Math.max(1, Math.min(SHARPEN_BUDGET, cap, room));
}

// What a sharpen costs, in integer units at the account's rate: `max`, the
// most it can cost (the messages and the whole reply room, priced exactly as
// /api/chat prices a request; this is what's held), and `typical`, what a
// sharpen of a prompt this long usually costs (shown as "about"). Quote and
// run use this same function.
export function sharpenCosts({ cfg, m, messages, chars, factor }) {
  const budget = sharpenBudget(cfg, m, messages);
  const max = chatPrice(m, messages, budget, 0, factor);
  const input = Math.ceil(JSON.stringify(messages).length / 4);
  const typical = Math.min(
    max,
    Math.ceil(usdUnits(tokenCost(m, input, Math.min(budget, typicalOutputTokens(chars)))) * factor),
  );
  return { budget, max, typical };
}

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for
// the sharpener, so the flow can be driven without a provider. It keeps the
// prompt (and every placeholder in it) and adds structure around it, like a
// real sharpen would. Never used live.
export function sharpenTestReply(messages) {
  const read = readSharpenMessages(messages);
  if (!read) return null;
  let task = read.prompt.replace(/\s+/g, " ").trim();
  task = task.charAt(0).toUpperCase() + task.slice(1);
  if (!/[.!?。！？]$/.test(task)) task += ".";
  const zh = /[㐀-鿿]/.test(task);
  const answered = read.answers.filter((a) => a.answer.trim());
  const label = (q) => (/tone|语气/i.test(q) ? "Tone" : /who|谁/i.test(q) ? "Audience" : "Detail");
  const lines = zh
    ? [
        task,
        ...answered.map((a) => `补充信息：${a.answer.trim()}`),
        "",
        "请：",
        "1. 先用一句话概括要点。",
        "2. 使用简短的段落或要点。",
        "3. 控制在 200 字以内。",
        "",
        "如果缺少重要信息，请先问我，再开始。",
      ]
    : [
        task,
        ...answered.map((a) => `${label(a.question)}: ${a.answer.trim()}`),
        "",
        "Please:",
        "1. Open with a one-sentence summary.",
        "2. Use short paragraphs or bullet points.",
        "3. Keep it under 200 words.",
        "",
        "If anything important is missing, ask me before you start.",
      ];
  const tags = placeholderTags(read.prompt);
  return JSON.stringify({
    prompt: lines.join("\n"),
    notes: zh
      ? ["说明了你想要的格式", "限定了篇幅，让回答更聚焦", "请模型先提问，而不是猜测"]
      : [
          "Stated the format you want",
          "Set a length so the answer stays focused",
          tags.length ? "Kept your masked details exactly where they were" : "Asked the model to check before guessing",
        ],
    questions: answered.length
      ? []
      : zh
        ? ["读者是谁？", "应该用什么语气？"]
        : ["Who is it for?", "What tone should it take?"],
  });
}
