import React, { useEffect, useState } from "react";
import { api, ApiError, isReleased, spendingLimitMessage } from "./lib.js";
import { readChatEvents } from "./stream.js";
import { Icon } from "./ui.jsx";
import { formatCredits } from "./estimate.js";
import { DEPTHS, collectSources, hostOf, partialReport } from "./deep-research.js";
import "./deep-research.css";

// Deep Research (update "deepresearch"): a composer mode next to Web. One
// question becomes a short plan, one web search per sub-question and a
// written report with numbered sources, run by server/routes/research.js.
// Only the question goes: not earlier turns, attachments or standing
// instructions. It needs Live Web Search, so it's offered exactly where Web
// is (chat and code, never Sealed Mode).
export const researchLive = (config) =>
  isReleased(config, "deepresearch") && isReleased(config, "search");

export const RESEARCH_VEILED_NOTE =
  "Veil masked details in this question, so Deep research won't run it: web searches with placeholders would find nothing, and the real details never leave this browser. Remove them, or turn Veil off for this question.";

// Why a run can't start right now, or null. Checked in this browser; the
// server refuses the same things.
export function researchBlock({ sealed, sealedThread, teamPays, veiled = 0 }) {
  if (sealed || sealedThread)
    return "Deep research isn't available in Sealed Mode: its web searches would leave the enclave.";
  if (teamPays) return "Deep research is paid from your own balance. Turn off Team pays to run it.";
  if (veiled) return RESEARCH_VEILED_NOTE;
  return null;
}

// The composer switch, styled like Web and Private.
export function ResearchToggle({ on, onToggle, disabled, title }) {
  return (
    <button
      type="button"
      className={"attachment-control web-toggle research-toggle" + (on ? " on" : "")}
      aria-pressed={on}
      disabled={disabled}
      title={title || "Deep research: plans your question, searches the web and writes a sourced report"}
      onClick={onToggle}
    >
      <Icon name="research" size={17} />
      <span>Deep research</span>
    </button>
  );
}

// A debounced /api/research/quote for what Send would run. Quoting holds
// and charges nothing.
export function useResearchEstimate(body) {
  const [state, setState] = useState({ status: "idle" });
  const key = body ? JSON.stringify(body) : "";
  useEffect(() => {
    if (!body) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ status: "loading", last: s.status === "ready" ? s : s.last }));
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/research/quote", { method: "POST", body, signal: controller.signal });
        setState({ status: "ready", ...r });
      } catch (e) {
        if (e?.name === "AbortError") return;
        setState({ status: "unavailable", message: e?.message || "The estimate is unavailable." });
      }
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key]);
  return state;
}
const tone = (s) =>
  s.available != null && s.credits > s.available
    ? "short"
    : s.spending_limit?.remaining != null && s.credits > Number(s.spending_limit.remaining)
      ? "limited"
      : "ready";

// The chip beside Send while Deep research is on: the most the run can cost.
export function ResearchEstimate({ state }) {
  const shown = state.status === "ready" ? state : state.status === "loading" ? state.last : null;
  if (state.status === "idle") return null;
  if (state.status === "unavailable")
    return (
      <span className="credit-estimate unavailable" role="status" title={state.message}>
        Estimate unavailable
      </span>
    );
  if (!shown)
    return (
      <span className="credit-estimate loading" role="status" aria-busy="true">
        Updating estimate…
      </span>
    );
  const t = tone(shown);
  return (
    <span
      className={"credit-estimate research-estimate " + t}
      role="status"
      title="The most this research can cost. Each step is charged on its actual usage as it finishes; steps that don't finish cost nothing."
    >
      <Icon name="coins" size={13} />
      {`Up to ≈${formatCredits(shown.credits)} credits`}
      {t === "short" && <b> · over your balance</b>}
      {t === "limited" && <b> · over your spending limit</b>}
    </span>
  );
}

// Shown above the composer while Deep research is on: the depth, what it
// sends, the most it can cost and why it can't run, if it can't.
// `compact` (a chat already under way) drops the explanation lines.
export function ResearchPanel({ depth, onDepth, estimate, block, attached = 0, compact = false, disabled }) {
  const q = estimate.status === "ready" ? estimate : estimate.last;
  return (
    <section className={"research-panel" + (compact ? " compact" : "")} aria-label="Deep research">
      <div className="research-panel-head">
        <span className="research-tile" aria-hidden="true">
          <Icon name="research" size={16} />
        </span>
        <div>
          <p className="research-eyebrow">DEEP RESEARCH</p>
          {!compact && (
            <p className="research-lede">
              Plans your question, searches the web, then writes a report with numbered sources.
            </p>
          )}
        </div>
        <div className="research-depth" role="radiogroup" aria-label="Research depth">
          {Object.entries(DEPTHS).map(([id, n]) => (
            <button
              type="button"
              role="radio"
              aria-checked={depth === id}
              className={depth === id ? "on" : ""}
              key={id}
              disabled={disabled}
              onClick={() => onDepth(id)}
            >
              <b>{id === "quick" ? "Quick" : "Thorough"}</b>
              <span>{`${n} searches`}</span>
            </button>
          ))}
        </div>
      </div>
      {block ? (
        <p className="research-block" role="alert">
          <Icon name="warning" size={14} />
          {block}
        </p>
      ) : (
        <p className="research-cost" role="status">
          {q ? (
            <>
              <b>{`Up to ${formatCredits(q.credits)} credits`}</b>
              {` · plan ${formatCredits(q.steps?.plan)}, ${q.searches} searches up to ${formatCredits(q.steps?.search)} each (web fee included), report ${formatCredits(q.steps?.write)}`}
            </>
          ) : estimate.status === "unavailable" ? (
            estimate.message
          ) : (
            "Type a question to see the most it can cost."
          )}
        </p>
      )}
      {!compact && (
        <p className="research-fine">
          Only this question is sent, not earlier messages. You pay only for steps that finish, and Stop ends the rest.
        </p>
      )}
      {compact && !block && (
        <p className="research-fine research-only">Only this question is sent, not earlier messages.</p>
      )}
      {attached > 0 && (
        <p className="research-fine">
          Attachments aren't used by Deep research. They stay here for your next message.
        </p>
      )}
    </section>
  );
}

// ---- Running ----

// Reads the run's events into one progress state, handing each new state
// to `onUpdate`. Resolves with the final event; throws an ApiError whose
// `data` carries the state (and the server's message, if any) otherwise.
export async function runResearch(body, onUpdate, signal) {
  const state = {
    live: true,
    stage: "planning",
    depth: body.depth,
    maxSearches: DEPTHS[body.depth] || 0,
    questions: [],
    results: [],
    planCredits: 0,
    conversationId: null,
  };
  const emit = () => onUpdate({ ...state, results: state.results.map((r) => ({ ...r })) });
  let response;
  try {
    response = await fetch("/api/research", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError("The service could not be reached. Please try again.");
  }
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
    let error;
    try {
      error = await response.json();
    } catch {}
    throw new ApiError(
      spendingLimitMessage(error) || error?.error?.message || "Deep research is unavailable.",
      response.status,
      error?.error?.code,
      { ...error, refused: true },
    );
  }
  emit();
  try {
    for await (const event of readChatEvents(response)) {
      if (event.conversationId) state.conversationId = event.conversationId;
      const r = event.research;
      if (event.error) {
        throw new ApiError(event.error.message || "Deep research stopped.", 200, event.error.code, {
          ...event,
          state,
        });
      }
      if (r?.stage === "planned") {
        state.stage = "searching";
        state.questions = r.questions || [];
        state.fallback = !!r.fallback;
        state.planCredits = Number(r.credits) || 0;
        state.results = state.questions.map(() => ({ status: "queued", sources: [], credits: 0 }));
      } else if (r?.stage === "searching" && state.results[r.index]) {
        state.results[r.index].status = "searching";
      } else if (r?.stage === "searched" && state.results[r.index]) {
        state.results[r.index] = {
          status: r.status,
          sources: Array.isArray(r.sources) ? r.sources : [],
          findings: typeof r.findings === "string" ? r.findings : "",
          credits: Number(r.credits) || 0,
          ...(typeof r.finish_reason === "string" ? { finish: r.finish_reason } : {}),
        };
      } else if (r?.stage === "writing") state.stage = "writing";
      else if (r?.stage === "done") return { ...event, state };
      emit();
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e?.name === "AbortError" || signal?.aborted) {
      const stopped = new DOMException("Aborted", "AbortError");
      stopped.state = state;
      throw stopped;
    }
    throw new ApiError(e?.message || "Deep research stopped.", 0, "stream_error", { state });
  }
  throw new ApiError("The connection ended before the report arrived.", 0, "stream_error", { state });
}

// What a finished step cost, summed from the progress events.
export const chargedSoFar = (state) =>
  Math.round(
    ((state?.planCredits || 0) + (state?.results || []).reduce((n, r) => n + (r.credits || 0), 0)) * 10000,
  ) / 10000;

// A stopped run's reply, built here from what finished (the server keeps the
// same): each finished search's findings, with their sources.
export function stoppedReply(state) {
  const results = state.results || [];
  const { sources, numbers } = collectSources(results);
  const text = partialReport({ questions: state.questions || [], results, sources, numbers });
  const steps = [
    { kind: "plan", status: state.questions?.length ? "done" : "stopped", credits: state.planCredits || 0 },
    ...results.map((r) => ({
      kind: "search",
      status: r.status === "queued" ? "skipped" : r.status === "searching" ? "stopped" : r.status,
      sources: r.sources?.length || 0,
      credits: r.credits || 0,
      ...(r.status === "done" && r.finish ? { finish_reason: r.finish } : {}),
    })),
    { kind: "write", status: state.stage === "writing" ? "stopped" : "skipped", credits: 0 },
  ];
  return {
    content: text,
    citations: sources,
    research: {
      depth: state.depth,
      questions: state.questions || [],
      fallback: !!state.fallback,
      status: "stopped",
      steps,
      credits_charged: chargedSoFar(state),
    },
  };
}

// ---- In the conversation ----

const STATUS = {
  queued: "Waiting",
  searching: "Searching…",
  done: "Done",
  failed: "Failed, not charged",
  stopped: "Stopped, not charged",
  skipped: "Not run",
};
const sourcesLabel = (n) => (n === 1 ? "1 source" : `${n} sources`);
// A step that hit its reply budget: what it wrote is kept, marked as such.
const CUT = " · cut short";
export const cutShort = (step) => step?.finish_reason === "length" || step?.finish === "length";

// The live panel in the reply while a run goes: Planning, then each search
// as it runs, then Writing.
export function ResearchProgress({ research }) {
  const results = research.results || [];
  const done = results.filter((r) => ["done", "failed", "stopped"].includes(r.status)).length;
  const phase = (name) =>
    research.stage === name ? "active" : ["planning", "searching", "writing"].indexOf(research.stage) > ["planning", "searching", "writing"].indexOf(name) ? "done" : "";
  return (
    <div className="research-progress" role="status" aria-live="polite">
      <p className="research-eyebrow">
        {`DEEP RESEARCH · ${research.depth === "thorough" ? "THOROUGH" : "QUICK"}`}
      </p>
      <ol className="research-stages">
        <li className={phase("planning")}>
          <span className="research-dot" aria-hidden="true" />
          <b>Planning</b>
          {research.questions?.length > 0 && (
            <span>
              {research.fallback
                ? "Searching your question as it is"
                : research.questions.length === 1
                  ? "1 sub-question"
                  : `${research.questions.length} sub-questions`}
            </span>
          )}
        </li>
        <li className={phase("searching")}>
          <span className="research-dot" aria-hidden="true" />
          <b>{results.length ? `Searching ${done}/${results.length}` : "Searching"}</b>
          {results.length > 0 && (
            <ul className="research-searches">
              {results.map((r, i) => (
                <li key={i} className={"search-" + r.status}>
                  <span className="research-q" data-i18n="off">
                    {research.questions[i]}
                  </span>
                  <span className="research-state">
                    {r.status === "done"
                      ? sourcesLabel(r.sources?.length || 0) + (cutShort(r) ? CUT : "")
                      : STATUS[r.status] || ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </li>
        <li className={phase("writing")}>
          <span className="research-dot" aria-hidden="true" />
          <b>Writing</b>
          {research.stage === "writing" && <span>Writing the report from what the searches found…</span>}
        </li>
      </ol>
      <p className="research-fine">
        {`Charged so far: ${formatCredits(chargedSoFar(research)) || "0"} credits`}
      </p>
    </div>
  );
}

const ENDED = {
  stopped: "Stopped before the report. Here is what the finished searches found; only finished steps were charged.",
  partial: "The report couldn't be written. Here is what the searches found; the report step wasn't charged.",
};

// Under a finished (or stopped) run: how it went, the plan it followed and
// the numbered sources its [n] citations point to.
export function ResearchDetails({ research, citations = [], trail = false }) {
  const steps = research.steps || [];
  const searches = steps.filter((s) => s.kind === "search");
  const searched = searches.filter((s) => s.status === "done").length;
  const numbered = citations.filter((c) => typeof c?.url === "string");
  return (
    <div className="research-details">
      {ENDED[research.status] && <p className="research-ended">{ENDED[research.status]}</p>}
      <p className="research-summary">
        <Icon name="research" size={14} />
        <span>
          {`Deep research · ${searched} of ${searches.length} ${searches.length === 1 ? "search" : "searches"} · ${sourcesLabel(numbered.length)} · ${formatCredits(research.credits_charged) || "0"} credits`}
        </span>
      </p>
      {numbered.length > 0 && (
        <ol className="research-sources">
          {numbered.map((c, i) => (
            <li key={c.url + i}>
              <span className="research-n">{i + 1}</span>
              {/* Only a web address is ever a link; anything else is shown as
                  text so the numbers still line up with the report's [n]. */}
              {/^https?:\/\//i.test(c.url) ? (
                <a data-i18n="off" href={c.url} target="_blank" rel="noopener noreferrer nofollow">
                  {c.title || hostOf(c.url)}
                </a>
              ) : (
                <span data-i18n="off">{c.title || "Source"}</span>
              )}
              <span className="research-host" data-i18n="off">
                {hostOf(c.url)}
              </span>
            </li>
          ))}
        </ol>
      )}
      {research.questions?.length > 0 && (
        <details className="research-plan">
          <summary>How this was researched</summary>
          <ol>
            {research.questions.map((q, i) => {
              const s = searches[i];
              return (
                <li key={i}>
                  <span data-i18n="off">{q}</span>
                  <small>
                    {s?.status === "done" ? sourcesLabel(s.sources || 0) + (cutShort(s) ? CUT : "") : STATUS[s?.status] || ""}
                    {trail && s?.route ? ` · ${s.route === "backup" ? "Backup route" : "Primary route"}` : ""}
                  </small>
                </li>
              );
            })}
          </ol>
          {research.fallback && (
            <p className="research-fine">The plan wasn't usable, so your question was searched as it is.</p>
          )}
          <p className="research-fine">
            Citations point only to pages these searches returned. Check important facts at the source.
          </p>
        </details>
      )}
    </div>
  );
}
