import { chatLimits } from "../data/chat-limits.js";
import { isReleased } from "./releases.js";
import { chatPrice } from "./core.js";
import {
  JUDGE_BUDGET,
  TURN_BUDGET,
  turnPlan,
  worstJudgeMessages,
  worstTurnMessages,
} from "../src/debate.js";

// Model Debate ("debate"): what each step of a debate can cost. The route
// that runs it is server/routes/debate.js; what's shared with the browser is
// src/debate.js.

// A step's reply room for this model: the step's own budget, within what
// /api/chat would allow the model (its output limit once Longer Answers is
// live, else the MVP's 8,192).
export function stepBudget(cfg, m, kind) {
  const cap = isReleased(cfg, "longanswers") ? chatLimits(m).maxOutputTokens : 8192;
  return Math.max(1, Math.min(kind === "judge" ? JUDGE_BUDGET : TURN_BUDGET, cap));
}

// Every step of a debate and the most each can cost, in integer units at the
// account's rate: each turn on its own model (priced on the longest request
// it could send, with every earlier turn at its longest) and the judge. The
// quote and the run use this same function, so the maximum the page shows,
// the balance and Spending Limits checks and the holds are one number: the
// sum of these amounts, with no headroom added.
//
// `models` is { a, b, judge } (catalog rows; judge may be null).
export function debateCosts({ cfg, models, setup, factor }) {
  const plan = turnPlan(setup.rounds);
  const steps = plan.map((turn, i) => {
    const m = models[turn.side];
    const messages = worstTurnMessages(setup, plan, i);
    const budget = stepBudget(cfg, m, "turn");
    return { key: "t" + turn.n, kind: "turn", ...turn, model: m, messages, budget, amount: chatPrice(m, messages, budget, 0, factor) };
  });
  if (models.judge) {
    const messages = worstJudgeMessages(setup, plan);
    const budget = stepBudget(cfg, models.judge, "judge");
    steps.push({ key: "judge", kind: "judge", model: models.judge, messages, budget, amount: chatPrice(models.judge, messages, budget, 0, factor) });
  }
  return { plan, steps, total: steps.reduce((n, s) => n + s.amount, 0) };
}
