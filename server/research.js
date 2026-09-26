import { chatLimits } from "../data/chat-limits.js";
import { isReleased } from "./releases.js";
import { chatPrice } from "./core.js";
import { withMemory } from "../src/memory.js";
import {
  MAX_FINDINGS,
  MAX_SOURCES,
  MAX_STEP_SOURCES,
  MAX_SUBQUESTION,
  hostOf,
  stripUrls,
} from "../src/deep-research.js";

// Deep Research (update "deepresearch"): the prompts for its three kinds of
// step and what each step can cost at most. The route that runs them is
// server/routes/research.js; the parts shared with the browser are in
// src/deep-research.js.

// Reply budgets per step, in tokens. Reasoning models spend part of these
// thinking before they answer (gemini-2.5-flash was seen using about 1,900
// hidden tokens), so they're well above what the visible text needs: a plan
// cut short falls back to one search, and cut-short findings weaken the
// report. Each is also capped by the model's own output limit (stepBudget).
export const BUDGETS = { plan: 4000, search: 4000, write: 8000 };

export const plannerPrompt = (cap) =>
  `You plan web research. Split the user's question into at most ${cap} focused sub-questions. ` +
  "Each must be answerable by one web search, and together they must cover the question. " +
  "Write them in the language of the question. Reply with JSON only, exactly in this shape: " +
  '{"questions": ["...", "..."]}';

export const SEARCH_PROMPT =
  "Search the web to answer the question below. It is one part of a larger research task. " +
  "Report what you find in at most 250 words: facts, figures and dates as the pages state them, " +
  "which page each fact comes from, and where pages disagree or nothing reliable was found. " +
  "No advice and no preamble.";

export const WRITE_PROMPT = [
  "You write research reports from web search findings. Use only the findings given; add nothing from memory.",
  "Write in the language of the question, in Markdown:",
  "# A short title",
  "**Key findings**, then 3 to 6 bullet points.",
  "Then 2 to 5 sections, each with a ## heading.",
  "Cite sources with their numbers in square brackets, such as [2] or [1][4], right after the claim they support.",
  "Use only numbers from the source list. Never write URLs or a list of sources; the app shows them.",
  "If the findings are thin, one-sided or disagree, say so plainly. Report what sources say rather than giving financial, legal or medical advice.",
].join("\n");

// The line a report cut short by its reply budget ends with: Chinese for a
// question written in Chinese (the report follows the question's language),
// English otherwise.
export const CUT_SHORT_NOTE = {
  en: "*Cut short: the model reached its reply limit, so this report may be incomplete.*",
  zh: "*已截断：模型已达到回复上限，这份报告可能不完整。*",
};
export const cutShortNote = (question) =>
  /[\u3400-\u9fff]/.test(String(question)) ? CUT_SHORT_NOTE.zh : CUT_SHORT_NOTE.en;

// A step's reply budget for this model: the step's own budget, within what
// /api/chat would allow the model (its output limit once Longer Answers is
// live, else the MVP's 8,192).
export function stepBudget(cfg, m, step) {
  const cap = isReleased(cfg, "longanswers") ? chatLimits(m).maxOutputTokens : 8192;
  return Math.max(1, Math.min(BUDGETS[step], cap));
}

export const plannerMessages = (question, cap, memoryMessage) =>
  withMemory(
    [
      { role: "system", content: plannerPrompt(cap) },
      { role: "user", content: question },
    ],
    memoryMessage,
  );

export const searchMessages = (subQuestion) => [
  { role: "system", content: SEARCH_PROMPT },
  { role: "user", content: subQuestion },
];

const sourceLine = (s, n) =>
  `[${n}] ${(s.title || hostOf(s.url) || "Untitled").slice(0, 160)}${s.title ? ` (${hostOf(s.url).slice(0, 60)})` : ""}`;

// The report step's messages: the question, the numbered sources (titles
// and sites only, no addresses) and each finished search's findings with
// the numbers of the sources it found. Failed searches are left out.
export function writeMessages({ question, questions, results, sources, numbers, memoryMessage }) {
  const findings = questions
    .map((q, i) => {
      const r = results[i];
      if (r?.status !== "done") return null;
      const refs = (numbers[i] || []).map((n) => `[${n}]`).join(" ") || "none";
      return `Search ${i + 1}: ${q}\nSources found: ${refs}\n${stripUrls(r.findings).trim()}`;
    })
    .filter(Boolean)
    .join("\n\n");
  const list = sources.length ? sources.map((s, i) => sourceLine(s, i + 1)).join("\n") : "(none returned)";
  return withMemory(
    [
      { role: "system", content: WRITE_PROMPT },
      {
        role: "user",
        content: `Question: ${question}\n\nSources (cite by number):\n${list}\n\nFindings:\n\n${findings}`,
      },
    ],
    memoryMessage,
  );
}

// The largest report request this run could send: every search finished
// with its full findings and every source listed. Priced to hold the report
// step before any search has run, so the hold is a real upper bound.
export function worstWriteMessages({ question, cap, memoryMessage }) {
  const sources = Math.min(cap * MAX_STEP_SOURCES, MAX_SOURCES);
  const perSearch = MAX_SUBQUESTION + MAX_FINDINGS + 80;
  const filler = "x".repeat(sources * 240 + cap * perSearch + 200);
  return withMemory(
    [
      { role: "system", content: WRITE_PROMPT },
      { role: "user", content: `Question: ${question}\n\n${filler}` },
    ],
    memoryMessage,
  );
}

// What every step of a run can cost at most, in integer units at the
// account's rate: the plan, each search (with the web search fee) and the
// report. Quote and run use this same function, so the maximum the app
// shows is exactly what the run reserves (before hold headroom).
export function researchCosts({ cfg, m, question, cap, memoryMessage, factor }) {
  const budget = {
    plan: stepBudget(cfg, m, "plan"),
    search: stepBudget(cfg, m, "search"),
    write: stepBudget(cfg, m, "write"),
  };
  const messages = {
    plan: plannerMessages(question, cap, memoryMessage),
    search: searchMessages("x".repeat(MAX_SUBQUESTION)),
    write: worstWriteMessages({ question, cap, memoryMessage }),
  };
  const plan = chatPrice(m, messages.plan, budget.plan, 0, factor);
  const search = chatPrice(m, messages.search, budget.search, cfg.webSearchPrice, factor);
  const write = chatPrice(m, messages.write, budget.write, 0, factor);
  return {
    budget,
    messages,
    amounts: { plan, search, write },
    total: plan + search * cap + write,
  };
}
