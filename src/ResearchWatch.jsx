import React, { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Icon, Notice, Empty } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import { DEPTHS } from "./deep-research.js";
import {
  NAME_LIMIT,
  DAY_NAMES,
  canonicalZone,
  describeSchedule,
  nextRunAfter,
  parseTime,
} from "./routines.js";
import { MAX_WATCHES, TOPIC_LIMIT, WATCH_REPEATS } from "./research-watch.js";
import "./research-watch.css";

// Research Watch (update "researchwatch"): the Research watch tab of the
// Routines page, and how a watch's reports look in its inbox. A watch is a
// routine whose run is Deep Research's (a plan, one web search per
// sub-question and a sourced report), run on the server on a schedule
// (server/research-watch.js). Topics, names, sub-questions, reports and model
// names are the user's or a model's words, so they're marked
// data-i18n="off".
//
// It shows only once Research Watch, Routines, Deep Research and Live Web
// Search are all released.

export const researchWatchLive = (config) =>
  isReleased(config, "researchwatch") &&
  isReleased(config, "routines") &&
  isReleased(config, "deepresearch") &&
  isReleased(config, "search");

const fmtCredits = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
const when = (ms) =>
  new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
const deviceZone = () => {
  try {
    return canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone) || "UTC";
  } catch {
    return "UTC";
  }
};
function zoneList(current) {
  let all = [];
  try {
    all = Intl.supportedValuesOf?.("timeZone") || [];
  } catch {}
  return [...new Set(["UTC", deviceZone(), current, ...all].filter(Boolean))];
}
export const DEPTH_LABEL = { quick: "Quick", thorough: "Thorough" };
const DEPTH_SEARCHES = { quick: "3 searches", thorough: "6 searches" };
const REPEAT_LABEL = { daily: "Every day", weekly: "Once a week" };

// How a run ended, for the reader: a report that couldn't be written, and why
// a run was refused or failed, in words about a watch.
export const RESEARCH_NOTES = {
  research_report_failed:
    "The report couldn't be written, so this is what the searches found. The report step wasn't charged.",
  research_stopped:
    "The run was stopped before its report was written, so this is what the searches found. Only finished steps were charged.",
  research_failed:
    "Research stopped unexpectedly, so this is what the searches found. Only finished steps were charged.",
};
export const RESEARCH_REASONS = {
  routine_budget: "This watch's monthly budget couldn't cover a whole run. Nothing was charged.",
  routine_run_cap:
    "A run of this watch now costs more than the maximum you agreed to. Open the watch and save it to accept the new maximum. Nothing was charged.",
  research_no_results: "None of the web searches finished, so no report was written. Nothing was charged.",
  research_stopped: "The run was stopped. Nothing was charged.",
  research_failed: "Research stopped unexpectedly. Nothing was charged.",
  research_unavailable: "Research Watch isn't available right now. Nothing was charged.",
  seed_phrase_blocked: "The topic looks like a wallet seed phrase, so nothing was sent. Nothing was charged.",
  unsupported_model: "This watch's model can't do research right now. Nothing was charged.",
};

// The sample account's research watch and report (?demo=1): nothing is sent.
export function demoResearchState() {
  const at = Date.now();
  const hour = 3600000;
  const watches = [
    {
      id: "demo-research",
      kind: "research",
      name: "EU AI Act enforcement",
      topic: "What is changing in how the EU AI Act is being enforced?",
      depth: "quick",
      new_only: true,
      model: "demo-model",
      web_search: true,
      private_only: false,
      schedule: { repeat: "weekly", day: 1, time: "08:00", timezone: "UTC" },
      per_run_credits: 95.2568,
      monthly_budget_credits: 500,
      enabled: true,
      next_run_at: at + 60 * hour,
      running: false,
      month: { spent: 61.4, held: 0, remaining: 438.6 },
    },
  ];
  const runs = [
    {
      id: "demo-research-run",
      kind: "research",
      routine_id: "demo-research",
      routine_name: "EU AI Act enforcement",
      scheduled_for: at - 20 * hour,
      started_at: at - 20 * hour + 5000,
      status: "done",
      skipped: 0,
      model: "demo-model",
      web_search: true,
      private_only: false,
      credits_charged: 61.4,
      finish_reason: "stop",
      answer:
        "# EU AI Act: what changed this week\n\n**What's new**\n\n- Sample: a prepared demo report, not a model's [1].\n- Each run plans, searches the web and writes a report like this one [2].\n\n**Key findings**\n\n- Every claim points to a numbered source below [1][2].\n- Nothing here was searched or charged.",
      citations: [
        { url: "https://example.com/ai-act-guidance", title: "Example source one" },
        { url: "https://example.org/enforcement", title: "Example source two" },
      ],
      research: {
        depth: "quick",
        new_only: true,
        previous: true,
        questions: [
          "What has the EU AI Office announced this week?",
          "Which enforcement steps were reported?",
          "What changed for general-purpose models?",
        ],
        steps: [
          { kind: "plan", status: "done", credits: 1.2, route: "primary" },
          { kind: "search", status: "done", sources: 2, credits: 22.1, route: "primary" },
          { kind: "search", status: "done", sources: 3, credits: 21.6, route: "primary" },
          { kind: "search", status: "failed", sources: 0, credits: 0 },
          { kind: "write", status: "done", credits: 16.5, route: "backup" },
        ],
        credits_charged: 61.4,
      },
      signed_receipt: null,
    },
  ];
  return { watches, runs };
}

// A new watch starts on the cheapest priced model: a run makes several calls,
// so the maximum shown is worth keeping low until the person chooses.
const price = (m) => Number(m.pricing?.input_per_1M_tokens) + Number(m.pricing?.output_per_1M_tokens);
export function defaultModel(models) {
  const priced = models.filter((m) => price(m) > 0);
  return (priced.length ? priced.reduce((a, b) => (price(b) < price(a) ? b : a)) : models[0])?.id || "";
}
function blankDraft(models) {
  return {
    id: null,
    name: "",
    topic: "",
    model: defaultModel(models),
    depth: "quick",
    new_only: true,
    private_only: false,
    repeat: "weekly",
    day: 1,
    time: "08:00",
    timezone: deviceZone(),
    monthly_budget_credits: "",
    enabled: true,
  };
}
const draftOf = (w) => ({
  id: w.id,
  name: w.name,
  topic: w.topic,
  model: w.model,
  depth: w.depth,
  new_only: w.new_only,
  private_only: w.private_only,
  repeat: w.schedule.repeat,
  day: w.schedule.day ?? 1,
  time: w.schedule.time,
  timezone: w.schedule.timezone,
  monthly_budget_credits: String(w.monthly_budget_credits),
  enabled: w.enabled,
});
export const bodyOf = (d) => ({
  topic: d.topic.trim(),
  name: d.name.trim(),
  model: d.model,
  depth: d.depth,
  new_only: d.new_only,
  private_only: d.private_only,
  schedule: {
    repeat: d.repeat,
    time: d.time,
    timezone: d.timezone,
    ...(d.repeat === "weekly" ? { day: Number(d.day) } : {}),
  },
  monthly_budget_credits: Number(d.monthly_budget_credits),
  enabled: d.enabled,
});
const scheduleOfDraft = (d) => ({
  repeat: d.repeat,
  minute: parseTime(d.time),
  day: Number(d.day),
  timezone: d.timezone,
});

function Switch({ checked, onChange, disabled, title, detail }) {
  return (
    <label className={"routine-switch" + (disabled ? " disabled" : "")}>
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="routine-switch-track" aria-hidden="true" />
      <span>
        <b>{title}</b>
        {detail && <small>{detail}</small>}
      </span>
    </label>
  );
}
function ConfirmDelete({ busy, onConfirm, onCancel }) {
  return (
    <div className="routine-confirm" role="group" aria-label="Delete research watch">
      <span>Delete this research watch and its reports? This can't be undone.</span>
      <button type="button" className="small-button danger" onClick={onConfirm} disabled={busy}>
        Delete
      </button>
      <button type="button" className="small-button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}

// The most one run can cost with the chosen model, depth and options (the
// server's worst case, which is also what a run holds), fetched as they
// change. Quoting holds and charges nothing.
export function useQuote(draft, live) {
  const [state, setState] = useState({ status: "idle" });
  const key = JSON.stringify([draft.model, draft.depth, draft.topic.trim(), draft.new_only, draft.private_only]);
  useEffect(() => {
    if (!live || !draft.model) return setState({ status: "idle" });
    const controller = new AbortController();
    setState((s) => ({ status: "loading", last: s.status === "ready" ? s : s.last }));
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/research-watches/quote", {
          method: "POST",
          signal: controller.signal,
          body: {
            model: draft.model,
            depth: draft.depth,
            ...(draft.topic.trim() ? { topic: draft.topic.trim() } : {}),
            new_only: draft.new_only,
            private_only: draft.private_only,
          },
        });
        setState({ status: "ready", ...r });
      } catch (e) {
        if (e?.name === "AbortError") return;
        setState({ status: "unavailable", message: e?.message || "The estimate is unavailable." });
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, live]);
  return state;
}

export function WatchEditor({ draft, setDraft, models, config, busy, error, onSave, onCancel, onDelete, live, demo }) {
  const [confirming, setConfirming] = useState(false);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  const choices = models.filter((m) => !draft.private_only || m.private);
  const zones = useMemo(() => zoneList(draft.timezone), [draft.timezone]);
  const privateLive = isReleased(config, "private");
  const minute = parseTime(draft.time);
  const next = minute == null ? null : nextRunAfter(scheduleOfDraft(draft), Date.now());
  const fetched = useQuote(draft, live);
  // The sample account has no server to ask: a fixed sample.
  const state = demo
    ? { status: "ready", credits: draft.depth === "thorough" ? 175.2299 : 95.2568, searches: DEPTHS[draft.depth] }
    : fetched;
  const q = state.status === "ready" ? state : state.last;
  const budget = Number(draft.monthly_budget_credits);
  const short = q && budget > 0 && budget < q.credits;
  // Enough for every run of the month at its maximum: a cap, not a charge.
  const suggested = q ? Math.ceil(q.credits * (draft.repeat === "daily" ? 31 : 5)) : null;
  const touched = useRef(!!draft.monthly_budget_credits);
  useEffect(() => {
    if (suggested != null && !touched.current)
      setDraft((d) => (d.monthly_budget_credits === "" ? { ...d, monthly_budget_credits: String(suggested) } : d));
  }, [suggested]);
  return (
    <form
      className="routine-editor research-editor"
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <div className="routine-editor-head">
        <h2>{draft.id ? "Edit research watch" : "New research watch"}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onCancel}>
          <Icon name="close" size={17} />
        </button>
      </div>
      <div className="routine-editor-grid">
        <div className="routine-editor-col">
          <label className="routine-field">
            <span>Topic</span>
            <textarea
              rows={4}
              value={draft.topic}
              maxLength={TOPIC_LIMIT}
              placeholder="What is changing in EU AI Act enforcement"
              onChange={(e) => set("topic")(e.target.value)}
              required
            />
          </label>
          <label className="routine-field">
            <span>Name (optional)</span>
            <input
              value={draft.name}
              maxLength={NAME_LIMIT}
              placeholder="Defaults to the topic"
              onChange={(e) => set("name")(e.target.value)}
            />
          </label>
          <fieldset className="routine-field">
            <legend>Depth</legend>
            <div className="routine-repeat">
              {Object.keys(DEPTHS).map((id) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={draft.depth === id}
                  className={draft.depth === id ? "active" : ""}
                  onClick={() => set("depth")(id)}
                >
                  {DEPTH_LABEL[id]}
                  <span className="research-depth-note">{DEPTH_SEARCHES[id]}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <Switch
            checked={draft.new_only}
            onChange={set("new_only")}
            title="Only what's new since last time"
            detail="Each report covers what changed since the last one. The last report's key findings are sent with the next run to compare against."
          />
          <p className="routine-veil-note">
            <Icon name="eyeoff" size={15} />
            <span>
              Watches run on our server, where Veil can't mask anything: the
              topic is sent to the model and, as searches, to web search as
              written.
            </span>
          </p>
        </div>
        <div className="routine-editor-col">
          <label className="routine-field">
            <span>Model</span>
            <select
              value={choices.some((m) => m.id === draft.model) ? draft.model : ""}
              onChange={(e) => set("model")(e.target.value)}
              required
            >
              {!choices.some((m) => m.id === draft.model) && <option value="">Choose a model</option>}
              {choices.map((m) => (
                <option key={m.id} value={m.id} data-i18n="off">
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          {privateLive && (
            <Switch
              checked={draft.private_only}
              onChange={(v) =>
                setDraft((d) => ({
                  ...d,
                  private_only: v,
                  model:
                    v && !models.some((m) => m.id === d.model && m.private)
                      ? models.find((m) => m.private)?.id || ""
                      : d.model,
                }))
              }
              title="Private models only"
              detail="Zero-data-retention models only, never the backup gateway. Reports are still kept in your inbox."
            />
          )}
          <fieldset className="routine-field">
            <legend>Repeat</legend>
            <div className="routine-repeat">
              {WATCH_REPEATS.map((id) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={draft.repeat === id}
                  className={draft.repeat === id ? "active" : ""}
                  onClick={() => set("repeat")(id)}
                >
                  {REPEAT_LABEL[id]}
                </button>
              ))}
            </div>
          </fieldset>
          <div className="routine-row">
            {draft.repeat === "weekly" && (
              <label className="routine-field">
                <span>Day</span>
                <select value={draft.day} onChange={(e) => set("day")(Number(e.target.value))}>
                  {DAY_NAMES.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="routine-field">
              <span>Time</span>
              <input
                type="time"
                step="60"
                value={draft.time}
                onChange={(e) => set("time")(e.target.value)}
                required
              />
            </label>
            <label className="routine-field routine-zone">
              <span>Time zone</span>
              <select value={draft.timezone} onChange={(e) => set("timezone")(e.target.value)}>
                {zones.map((z) => (
                  <option key={z} value={z} data-i18n="off">
                    {z}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="research-cost" role="status" aria-live="polite">
            <p className="research-cost-line">
              <Icon name="coins" size={15} />
              {q ? (
                <span className={state.status === "loading" ? "research-updating" : ""}>
                  <b>{`Up to ${fmtCredits(q.credits)} credits per run`}</b>
                </span>
              ) : state.status === "unavailable" ? (
                <span title={state.message}>The estimate is unavailable.</span>
              ) : (
                <span>Choose a model to see the most a run can cost.</span>
              )}
            </p>
            <p className="routine-help">
              That is the most a run can cost: it is checked against your
              balance and spending limits, and it is what a run holds. You pay
              only for steps that finish and give a result, usually far less. A
              step that fails, or that can't be used, is free.
            </p>
            {q?.spending_limit != null && q.credits > Number(q.spending_limit.remaining) && (
              <p className="research-warn">Over your spending limit right now.</p>
            )}
            {q?.available != null && q.credits > q.available && (
              <p className="research-warn">Over your balance right now.</p>
            )}
          </div>
          <label className="routine-field">
            <span>Monthly budget (credits)</span>
            <input
              type="number"
              min="0.0001"
              step="any"
              inputMode="decimal"
              value={draft.monthly_budget_credits}
              placeholder={suggested != null ? String(suggested) : ""}
              onChange={(e) => {
                touched.current = true;
                set("monthly_budget_credits")(e.target.value);
              }}
              required
            />
          </label>
          {q && (
            <p className="routine-help">
              {`At least ${fmtCredits(q.credits)} credits, the most one run can cost. ${fmtCredits(suggested)} credits covers every run this month at its maximum. It's a cap, not a charge.`}
            </p>
          )}
          <p className="routine-help">
            A run stops before it starts, and nothing is charged, when your
            balance, your spending limits or what is left of the month's
            budget can't cover it. The budget resets each calendar month in the
            watch's time zone.
          </p>
          {short && <p className="research-warn">{`This budget is below one run's maximum of ${fmtCredits(q.credits)} credits.`}</p>}
          <Switch
            checked={draft.enabled}
            onChange={set("enabled")}
            title={draft.enabled ? "On" : "Off"}
            detail={
              draft.enabled
                ? "Runs on schedule. Saving never runs it straight away."
                : "Saved, but it won't run until you switch it on."
            }
          />
          {draft.enabled && next != null && (
            <p className="routine-next">
              <Icon name="history" size={15} />
              <span>{`Next run: ${when(next)} (your time)`}</span>
            </p>
          )}
        </div>
      </div>
      <p className="research-honest">
        <Icon name="shield" size={15} />
        <span>
          ANONYMA keeps the topic, the schedule and your reports (the newest
          50) until you delete them. It doesn't use Memory, and Device Vault
          and Sealed Mode don't apply to scheduled runs. Delete a report and
          the watch forgets it.
        </span>
      </p>
      {error && <Notice type="error">{error}</Notice>}
      <div className="routine-editor-actions">
        <Button type="submit" disabled={busy}>
          Save research watch
        </Button>
        <Button type="button" secondary onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {draft.id && !confirming && (
          <button type="button" className="routine-delete" onClick={() => setConfirming(true)} disabled={busy}>
            <Icon name="delete" size={15} />
            Delete research watch
          </button>
        )}
      </div>
      {confirming && <ConfirmDelete busy={busy} onConfirm={onDelete} onCancel={() => setConfirming(false)} />}
    </form>
  );
}

function ScheduleText({ schedule }) {
  return (
    <p className="routine-schedule">
      <Icon name="history" size={14} />
      <span>
        {describeSchedule({
          repeat: schedule.repeat,
          minute: parseTime(schedule.time),
          day: schedule.day,
        })}
      </span>
      <span className="routine-sep" aria-hidden="true">
        ·
      </span>
      <span data-i18n="off">{schedule.timezone}</span>
    </p>
  );
}

export function WatchCard({ w, modelName, busy, onEdit, onToggle, onDelete, onReports }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <article className={"routine-card research-card" + (w.enabled ? "" : " off")}>
      <div className="routine-card-head">
        <h3 data-i18n="off">{w.name}</h3>
        <Switch checked={w.enabled} disabled={busy} onChange={onToggle} title={w.enabled ? "On" : "Off"} />
      </div>
      <ScheduleText schedule={w.schedule} />
      <p className="routine-prompt" data-i18n="off">
        {w.topic}
      </p>
      <div className="routine-tags">
        <span className="routine-tag">{DEPTH_LABEL[w.depth]}</span>
        {w.new_only && <span className="routine-tag">Only what's new</span>}
        <span className="routine-tag" data-i18n="off">
          {modelName}
        </span>
        {w.private_only && <span className="routine-tag">Private models only</span>}
        {w.running && <span className="routine-tag live">Running</span>}
      </div>
      <dl className="routine-facts">
        <div>
          <dt>Next run</dt>
          <dd>{w.enabled && w.next_run_at ? when(w.next_run_at) : "Off"}</dd>
        </div>
        <div>
          <dt>Per run</dt>
          <dd>{`Up to ${fmtCredits(w.per_run_credits)} credits`}</dd>
        </div>
        <div>
          <dt>This month</dt>
          <dd>{`${fmtCredits(w.month.spent)} of ${fmtCredits(w.monthly_budget_credits)} credits spent this month`}</dd>
        </div>
      </dl>
      <div
        className="routine-bar"
        role="img"
        aria-label={`${fmtCredits(w.month.spent)} of ${fmtCredits(w.monthly_budget_credits)} credits spent this month`}
      >
        <div style={{ width: Math.min(100, (w.month.spent / w.monthly_budget_credits) * 100) + "%" }} />
      </div>
      <div className="routine-actions">
        <button type="button" className="small-button" onClick={onEdit} disabled={busy}>
          Edit
        </button>
        <button type="button" className="small-button" onClick={onReports}>
          View reports
        </button>
        <button
          type="button"
          className="small-button"
          onClick={() => setConfirming(true)}
          disabled={busy || w.running || confirming}
        >
          Delete
        </button>
      </div>
      {confirming && <ConfirmDelete busy={busy} onConfirm={onDelete} onCancel={() => setConfirming(false)} />}
    </article>
  );
}

// What a research report's run did, under its answer in the inbox: the depth,
// whether it compared with the last report, how many searches finished, and
// each step's charge, with the sub-questions searched. `run.research` never
// holds the report itself.
export function ResearchRunDetails({ run }) {
  const r = run.research;
  if (!r) return null;
  const searches = r.steps.filter((s) => s.kind === "search");
  const done = searches.filter((s) => s.status === "done");
  const sources = done.reduce((n, s) => n + (s.sources || 0), 0);
  let q = -1;
  return (
    <details className="research-steps">
      <summary>
        <span>{DEPTH_LABEL[r.depth] || "Research"}</span>
        <span>{`${done.length} of ${searches.length} searches`}</span>
        <span>{sources === 1 ? "1 source" : `${sources} sources`}</span>
        {r.new_only && <span>{r.previous ? "Compared with the last report" : "First report: nothing to compare with yet"}</span>}
      </summary>
      <ul>
        {r.steps.map((s, i) => {
          if (s.kind === "search") q += 1;
          const label = s.kind === "plan" ? "Plan" : s.kind === "write" ? "Report" : r.questions?.[q] || "Search";
          return (
            <li key={i} className={"research-step " + s.status}>
              <span className="research-step-status">{STEP_STATUS[s.status] || s.status}</span>
              <span className="research-step-label">
                <span data-i18n={s.kind === "search" ? "off" : undefined}>{label}</span>
                {s.route && <small>{s.route === "backup" ? "Backup route" : "Primary route"}</small>}
              </span>
              <span className="research-step-credits">{s.credits > 0 ? `${fmtCredits(s.credits)} credits` : "Not charged"}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
}
const STEP_STATUS = {
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
  skipped: "Not run",
};

// The Research watch tab of the Routines page.
export function ResearchTab({ demo, live, models, config, watches, setWatches, reload, onReports, onRemoved, setError, nameOf }) {
  const [params, setParams] = useSearchParams();
  // The URL says which watch is being edited (?watch=new or ?watch=<id>), so
  // a reload opens what's on screen.
  const wanted = params.get("watch");
  const opened = useRef(null);
  const [draft, setDraft] = useState(() => {
      if (wanted === "new") return (opened.current = "new"), blankDraft(models);
      const w = wanted && watches.find((x) => x.id === wanted);
      return w ? ((opened.current = wanted), draftOf(w)) : null;
    }),
    [busy, setBusy] = useState(false),
    [formError, setFormError] = useState("");
  const atLimit = watches.length >= MAX_WATCHES;
  useEffect(() => {
    if (!wanted) {
      opened.current = null;
      return setDraft(null);
    }
    if (opened.current === wanted) return;
    if (wanted === "new") {
      opened.current = wanted;
      return setDraft((d) => d || blankDraft(models));
    }
    const w = watches.find((x) => x.id === wanted);
    if (w) {
      opened.current = wanted;
      setDraft(draftOf(w));
    }
  }, [wanted, watches.length]);
  // Models load after the page: a new watch takes the first one offered.
  useEffect(() => {
    if (draft && !draft.model && models[0])
      setDraft((d) => (d && !d.model ? { ...d, model: defaultModel(models) } : d));
  }, [models.length, !!draft]);
  function mark(id) {
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        if (id) n.set("watch", id);
        else n.delete("watch");
        return n;
      },
      { replace: true },
    );
  }
  function open(w) {
    setFormError("");
    opened.current = w ? w.id : "new";
    setDraft(w ? draftOf(w) : blankDraft(models));
    mark(w ? w.id : "new");
  }
  function close() {
    opened.current = null;
    setDraft(null);
    mark(null);
  }
  async function save() {
    setFormError("");
    const body = bodyOf(draft);
    if (demo) {
      const w = {
        ...(watches.find((x) => x.id === draft.id) || {
          id: "demo-research-" + Date.now(),
          kind: "research",
          web_search: true,
          running: false,
          month: { spent: 0, held: 0, remaining: body.monthly_budget_credits },
        }),
        ...body,
        name: body.name || body.topic.slice(0, 60),
        topic: body.topic,
        per_run_credits: body.depth === "thorough" ? 175.2299 : 95.2568,
        next_run_at: body.enabled ? nextRunAfter(scheduleOfDraft(draft), Date.now()) : null,
      };
      setWatches((list) => (draft.id ? list.map((x) => (x.id === draft.id ? w : x)) : [...list, w]));
      close();
      return;
    }
    setBusy(true);
    try {
      await api(draft.id ? "/api/research-watches/" + draft.id : "/api/research-watches", {
        method: draft.id ? "PATCH" : "POST",
        body,
      });
      close();
      await reload();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(w, enabled) {
    if (demo) {
      setWatches((list) => list.map((x) => (x.id === w.id ? { ...x, enabled } : x)));
      return;
    }
    setBusy(true);
    try {
      await api("/api/research-watches/" + w.id, { method: "PATCH", body: { enabled } });
      await reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(w) {
    if (!w) return;
    if (demo) {
      setWatches((list) => list.filter((x) => x.id !== w.id));
      onRemoved?.(w.id);
      close();
      return;
    }
    setBusy(true);
    try {
      await api("/api/research-watches/" + w.id, { method: "DELETE" });
      close();
      onRemoved?.(w.id);
      await reload();
    } catch (e) {
      setError(e.message);
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="watches-tab research-tab">
      <div className="watches-intro">
        <div>
          <h2>Research watch</h2>
          <p>
            Pick a topic and a schedule. Each run plans, searches the web and
            writes a sourced report, delivered to your inbox: Deep Research
            that runs itself. You set a monthly budget, and you see the most a
            run can cost before you save.
          </p>
        </div>
        {!draft && (
          <Button type="button" onClick={() => open(null)} disabled={atLimit || busy}>
            New research watch <Icon name="plus" size={16} />
          </Button>
        )}
      </div>
      {atLimit && !draft && (
        <p className="routine-help">You have the most research watches an account can keep. Delete one to add another.</p>
      )}
      {draft && (
        <WatchEditor
          draft={draft}
          setDraft={setDraft}
          models={models}
          config={config}
          busy={busy}
          error={formError}
          live={live}
          demo={demo}
          onSave={save}
          onCancel={close}
          onDelete={() => remove(watches.find((w) => w.id === draft.id))}
        />
      )}
      {watches.length ? (
        <div className="routine-grid">
          {watches.map((w) => (
            <WatchCard
              key={w.id}
              w={w}
              modelName={nameOf(w.model)}
              busy={busy}
              onEdit={() => open(w)}
              onToggle={(v) => toggle(w, v)}
              onDelete={() => remove(w)}
              onReports={() => onReports(w.id)}
            />
          ))}
        </div>
      ) : (
        !draft && (
          <Empty icon="research" title="No research watches yet.">
            Watch a market, a regulation, a technology or a rival, and get a
            sourced briefing on your schedule.
          </Empty>
        )
      )}
    </div>
  );
}
