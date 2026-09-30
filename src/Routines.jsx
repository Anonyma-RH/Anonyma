import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import remarkGfm from "remark-gfm";
import { Button, Icon, Notice, Empty, CopyButton } from "./ui.jsx";
import SignedReceipt from "./SignedReceipt.jsx";
import { api, isReleased } from "./lib.js";
import {
  MAX_ROUTINES,
  NAME_LIMIT,
  PROMPT_LIMIT,
  DAY_NAMES,
  canonicalZone,
  describeSchedule,
  nextRunAfter,
  parseTime,
} from "./routines.js";
import { WatchesTab, WatchReportCard, demoWatchState, markWatchesSeen } from "./PageWatch.jsx";
import { MAX_WATCHES, mergeInbox, shortUrl } from "./page-watch.js";
import {
  ResearchRunDetails,
  ResearchTab,
  RESEARCH_NOTES,
  RESEARCH_REASONS,
  demoResearchState,
  researchWatchLive,
} from "./ResearchWatch.jsx";
import { MAX_WATCHES as MAX_RESEARCH } from "./research-watch.js";
import { SecretGuardNotice, useSecretGuard, useSecretScan } from "./SecretGuard.jsx";
import { maskSecrets, removeSecrets } from "./secret-guard.js";
import "./routines.css";

// Routines: saved prompts that run on a schedule with their own budget, and
// the inbox their answers land in (server/routines.js). Runs happen on the
// server, so Veil can't mask them: the page says the prompt is sent as
// written. Names, prompts, answers, sources and model names are the user's
// or a model's words, so they're marked data-i18n="off".
//
// Once Page Watch is released (src/PageWatch.jsx) the page gets a third tab
// for watched pages, and their reports join the inbox, newest first with
// the runs. Once Research Watch is released (src/ResearchWatch.jsx) it gets a
// tab for research watches, whose reports are runs in this inbox. The tab
// and the inbox filter are in the URL (?tab=, ?show=), so a reload opens
// what's on screen.

const fmtCredits = (v) =>
  Number(v).toLocaleString(undefined, { maximumFractionDigits: 4 });
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
const REPEAT_LABEL = {
  daily: "Every day",
  weekdays: "Weekdays (Monday to Friday)",
  weekly: "Once a week",
};
const STATUS_LABEL = {
  done: "Delivered",
  refused: "Refused",
  failed: "Failed",
  running: "Running",
};
// Why a run didn't deliver, in the page's own words where it knows the code.
const REASONS = {
  insufficient_credits: "Your balance couldn't cover this run. Nothing was charged.",
  routine_budget: "This routine's monthly budget couldn't cover this run. Nothing was charged.",
  routine_run_cap: "The per-run maximum couldn't cover this run with this model and prompt. Nothing was charged.",
  spending_limit: "Your spending limits couldn't cover this run. Nothing was charged.",
  routine_gone: "This routine was switched off or deleted before it ran. Nothing was charged.",
  model_not_found: "This routine's model isn't available right now. Nothing was charged.",
  model_unavailable: "This routine's model isn't available right now. Nothing was charged.",
  unpriced_model: "This routine's model isn't available right now. Nothing was charged.",
  private_model_required: "Private models only is on, and this model isn't a zero-data-retention model. Nothing was charged.",
  search_unavailable: "Web search isn't available right now. Nothing was charged.",
  private_unavailable: "Private Mode isn't available right now. Nothing was charged.",
  payment_reconciliation_pending: "Spending is paused while a payment is checked. Nothing was charged.",
  interrupted: "The service restarted during this run.",
};
const reasonFor = (run) =>
  (run.kind === "research" && RESEARCH_REASONS[run.code]) ||
  REASONS[run.code] ||
  run.message ||
  "The run didn't complete.";

// The sample account's routines and inbox (?demo=1): nothing is sent.
export function demoState() {
  const at = Date.now();
  const hour = 3600000;
  const routines = [
    {
      id: "demo-news",
      name: "Morning AI news",
      prompt: "With web search, summarise the top AI news of the last 24 hours in 5 bullets, each with its source.",
      model: "demo-model",
      web_search: true,
      private_only: false,
      schedule: { repeat: "weekdays", time: "08:00", timezone: "UTC" },
      per_run_credits: 40,
      monthly_budget_credits: 600,
      enabled: true,
      next_run_at: at + 14 * hour,
      running: false,
      month: { spent: 212.4, held: 0, remaining: 387.6 },
    },
    {
      id: "demo-review",
      name: "Friday review",
      prompt: "Draft a short, upbeat checklist for wrapping up the week and planning Monday.",
      model: "demo-model",
      web_search: false,
      private_only: true,
      schedule: { repeat: "weekly", day: 5, time: "16:30", timezone: "Europe/London" },
      per_run_credits: 10,
      monthly_budget_credits: 50,
      enabled: false,
      next_run_at: null,
      running: false,
      month: { spent: 6.1, held: 0, remaining: 43.9 },
    },
  ];
  const runs = [
    {
      id: "demo-run-1",
      routine_id: "demo-news",
      routine_name: "Morning AI news",
      scheduled_for: at - 10 * hour,
      started_at: at - 10 * hour + 4000,
      status: "done",
      skipped: 0,
      model: "demo-model",
      web_search: true,
      credits_charged: 23.8,
      answer:
        "- **Sample:** a prepared demo answer, not a model's.\n- Each run's answer lands here with its time and charge.\n- Sources the search returned are listed under it.\n- A signed receipt comes with every live run.\n- Nothing here was charged.",
      citations: [{ url: "https://example.com/ai-news", title: "Example source" }],
      signed_receipt: null,
    },
    {
      id: "demo-run-2",
      routine_id: "demo-news",
      routine_name: "Morning AI news",
      scheduled_for: at - 34 * hour,
      started_at: at - 34 * hour + 3000,
      status: "refused",
      skipped: 2,
      model: "demo-model",
      web_search: true,
      credits_charged: 0,
      code: "routine_budget",
      citations: [],
      signed_receipt: null,
    },
  ];
  return { routines, runs };
}

function blankDraft(models) {
  return {
    id: null,
    name: "",
    prompt: "",
    model: models[0]?.id || "",
    web_search: false,
    private_only: false,
    repeat: "weekdays",
    day: 1,
    time: "08:00",
    timezone: deviceZone(),
    per_run_credits: "25",
    monthly_budget_credits: "500",
    enabled: true,
  };
}
const draftOf = (r) => ({
  id: r.id,
  name: r.name,
  prompt: r.prompt,
  model: r.model,
  web_search: r.web_search,
  private_only: r.private_only,
  repeat: r.schedule.repeat,
  day: r.schedule.day ?? 1,
  time: r.schedule.time,
  timezone: r.schedule.timezone,
  per_run_credits: String(r.per_run_credits),
  monthly_budget_credits: String(r.monthly_budget_credits),
  enabled: r.enabled,
});
const bodyOf = (d) => ({
  name: d.name,
  prompt: d.prompt,
  model: d.model,
  web_search: d.web_search,
  private_only: d.private_only,
  schedule: {
    repeat: d.repeat,
    time: d.time,
    timezone: d.timezone,
    ...(d.repeat === "weekly" ? { day: Number(d.day) } : {}),
  },
  per_run_credits: Number(d.per_run_credits),
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

// Deleting asks once more, in the page (so it's translated like the rest).
function ConfirmDelete({ busy, onConfirm, onCancel }) {
  return (
    <div className="routine-confirm" role="group" aria-label="Delete routine">
      <span>Delete this routine and its inbox? This can't be undone.</span>
      <button type="button" className="small-button danger" onClick={onConfirm} disabled={busy}>
        Delete
      </button>
      <button type="button" className="small-button" onClick={onCancel} disabled={busy}>
        Cancel
      </button>
    </div>
  );
}

export function Editor({ draft, setDraft, models, config, busy, error, onSave, onCancel, onDelete, secretLive = false }) {
  const [confirming, setConfirming] = useState(false);
  const set = (k) => (v) => setDraft((d) => ({ ...d, [k]: v }));
  // Secret Guard: a password, key or token in the prompt holds Save until
  // it's masked, removed or saved anyway (for this save only). A routine
  // runs on our server, so a masked value stays a placeholder: the real
  // one isn't kept anywhere.
  const secretFinds = useSecretScan(secretLive, draft.prompt);
  const [secretOk, setSecretOk] = useState(false);
  useEffect(() => setSecretOk(false), [draft.prompt]);
  const secretHeld = secretFinds.length > 0 && !secretOk;
  const choices = models.filter((m) => !draft.private_only || m.private);
  const zones = useMemo(() => zoneList(draft.timezone), [draft.timezone]);
  const minute = parseTime(draft.time);
  const next =
    minute == null
      ? null
      : nextRunAfter(scheduleOfDraft(draft), Date.now());
  const searchLive = isReleased(config, "search");
  const privateLive = isReleased(config, "private");
  return (
    <form
      className="routine-editor"
      onSubmit={(e) => {
        e.preventDefault();
        if (!secretHeld) onSave();
      }}
    >
      <div className="routine-editor-head">
        <h2>{draft.id ? "Edit routine" : "New routine"}</h2>
        <button type="button" className="icon-button" aria-label="Close" onClick={onCancel}>
          <Icon name="close" size={17} />
        </button>
      </div>
      <div className="routine-editor-grid">
        <div className="routine-editor-col">
          <label className="routine-field">
            <span>Name</span>
            <input
              value={draft.name}
              maxLength={NAME_LIMIT}
              placeholder="Morning AI news"
              onChange={(e) => set("name")(e.target.value)}
              required
            />
          </label>
          <label className="routine-field">
            <span>Prompt</span>
            <textarea
              rows={6}
              value={draft.prompt}
              maxLength={PROMPT_LIMIT}
              placeholder="Summarise the top AI news in 5 bullets."
              onChange={(e) => set("prompt")(e.target.value)}
              required
            />
          </label>
          <p className="routine-veil-note">
            <Icon name="eyeoff" size={15} />
            <span>
              Routines run on our server, where Veil can't mask anything: the
              prompt is sent as written.
            </span>
          </p>
          <SecretGuardNotice
            finds={secretHeld ? secretFinds : []}
            verb="save"
            busy={busy}
            note="Mask swaps each one for a placeholder like [SECRET_1]. The routine runs on our server with the placeholder, and the real value isn't kept anywhere."
            onMask={() => {
              const prompt = maskSecrets(draft.prompt, {}).text;
              setDraft((d) => ({ ...d, prompt }));
              onSave({ ...draft, prompt });
            }}
            onRemove={() => set("prompt")(removeSecrets(draft.prompt).text)}
            onProceed={() => {
              setSecretOk(true);
              onSave(draft);
            }}
          />
          <label className="routine-field">
            <span>Model</span>
            <select
              value={choices.some((m) => m.id === draft.model) ? draft.model : ""}
              onChange={(e) => set("model")(e.target.value)}
              required
            >
              {!choices.some((m) => m.id === draft.model) && (
                <option value="">Choose a model</option>
              )}
              {choices.map((m) => (
                <option key={m.id} value={m.id} data-i18n="off">
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          {searchLive && (
            <Switch
              checked={draft.web_search}
              onChange={set("web_search")}
              title="Web search"
              detail="Answers from the live web, with sources. Each run also pays the search fee."
            />
          )}
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
              detail="Zero-data-retention models only, never the backup gateway. Answers are still kept in your inbox."
            />
          )}
        </div>
        <div className="routine-editor-col">
          <fieldset className="routine-field">
            <legend>Repeat</legend>
            <div className="routine-repeat">
              {Object.entries(REPEAT_LABEL).map(([id, label]) => (
                <button
                  type="button"
                  key={id}
                  aria-pressed={draft.repeat === id}
                  className={draft.repeat === id ? "active" : ""}
                  onClick={() => set("repeat")(id)}
                >
                  {label}
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
          <div className="routine-row">
            <label className="routine-field">
              <span>Per-run maximum (credits)</span>
              <input
                type="number"
                min="0.0001"
                step="any"
                inputMode="decimal"
                value={draft.per_run_credits}
                onChange={(e) => set("per_run_credits")(e.target.value)}
                required
              />
            </label>
            <label className="routine-field">
              <span>Monthly budget (credits)</span>
              <input
                type="number"
                min="0.0001"
                step="any"
                inputMode="decimal"
                value={draft.monthly_budget_credits}
                onChange={(e) => set("monthly_budget_credits")(e.target.value)}
                required
              />
            </label>
          </div>
          <p className="routine-help">
            A run is refused, and nothing is charged, when your balance, your
            spending limits, this routine's monthly budget or its per-run
            maximum can't cover it. The per-run maximum also caps how long a
            reply can be. The budget resets each calendar month in the
            routine's time zone.
          </p>
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
      {error && <Notice type="error">{error}</Notice>}
      <div className="routine-editor-actions">
        <Button type="submit" disabled={busy || secretHeld}>
          Save routine
        </Button>
        <Button type="button" secondary onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {draft.id && !confirming && (
          <button type="button" className="routine-delete" onClick={() => setConfirming(true)} disabled={busy}>
            <Icon name="delete" size={15} />
            Delete routine
          </button>
        )}
      </div>
      {confirming && (
        <ConfirmDelete busy={busy} onConfirm={onDelete} onCancel={() => setConfirming(false)} />
      )}
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

export function RoutineCard({ r, modelName, busy, onEdit, onToggle, onDelete, onInbox }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <article className={"routine-card" + (r.enabled ? "" : " off")}>
      <div className="routine-card-head">
        <h3 data-i18n="off">{r.name}</h3>
        <Switch
          checked={r.enabled}
          disabled={busy}
          onChange={onToggle}
          title={r.enabled ? "On" : "Off"}
        />
      </div>
      <ScheduleText schedule={r.schedule} />
      <p className="routine-prompt" data-i18n="off">
        {r.prompt}
      </p>
      <div className="routine-tags">
        <span className="routine-tag" data-i18n="off">
          {modelName}
        </span>
        {r.web_search && <span className="routine-tag">Web search</span>}
        {r.private_only && <span className="routine-tag">Private models only</span>}
        {r.running && <span className="routine-tag live">Running</span>}
      </div>
      <dl className="routine-facts">
        <div>
          <dt>Next run</dt>
          <dd>{r.enabled && r.next_run_at ? when(r.next_run_at) : "Off"}</dd>
        </div>
        <div>
          <dt>Per run</dt>
          <dd>{`Up to ${fmtCredits(r.per_run_credits)} credits`}</dd>
        </div>
        <div>
          <dt>This month</dt>
          <dd>{`${fmtCredits(r.month.spent)} of ${fmtCredits(r.monthly_budget_credits)} credits spent this month`}</dd>
        </div>
      </dl>
      <div
        className="routine-bar"
        role="img"
        aria-label={`${fmtCredits(r.month.spent)} of ${fmtCredits(r.monthly_budget_credits)} credits spent this month`}
      >
        <div
          style={{
            width:
              Math.min(100, (r.month.spent / r.monthly_budget_credits) * 100) + "%",
          }}
        />
      </div>
      <div className="routine-actions">
        <button type="button" className="small-button" onClick={onEdit} disabled={busy}>
          Edit
        </button>
        <button type="button" className="small-button" onClick={onInbox}>
          View inbox
        </button>
        <button type="button" className="small-button" onClick={() => setConfirming(true)} disabled={busy || r.running || confirming}>
          Delete
        </button>
      </div>
      {confirming && (
        <ConfirmDelete busy={busy} onConfirm={onDelete} onCancel={() => setConfirming(false)} />
      )}
    </article>
  );
}

// `markdown`: the answer's markdown components. With Injection Shield on
// (src/Shield.jsx) a remote image waits for the user and links show their host.
export function RunCard({ run, modelName, onDelete, busy, markdown }) {
  const skipped = run.skipped || 0;
  const research = run.kind === "research";
  return (
    <article className={"run-card " + run.status + (research ? " research" : "")}>
      <div className="run-head">
        <span className={"run-status " + run.status}>{STATUS_LABEL[run.status]}</span>
        {research && <span className="run-kind">Research watch</span>}
        <b data-i18n="off">{run.routine_name}</b>
        <time dateTime={new Date(run.started_at).toISOString()}>{when(run.started_at)}</time>
        <span className="run-credits">{`${fmtCredits(run.credits_charged)} credits`}</span>
      </div>
      <p className="run-meta">
        <span>{`Scheduled for ${when(run.scheduled_for)}`}</span>
        <span className="run-model" data-i18n="off">
          {modelName}
        </span>
        {run.web_search && !research && <span>Web search</span>}
        {run.private_only && <span>Private models only</span>}
        {skipped > 0 && (
          <span>
            {skipped === 1
              ? "Skipped 1 missed run"
              : `Skipped ${skipped} missed runs`}
          </span>
        )}
      </p>
      {run.status === "done" ? (
        <>
          <div className="run-answer" data-i18n="off">
            <ReplyMarkdown remarkPlugins={[remarkGfm]} components={markdown}>
              {run.answer || ""}
            </ReplyMarkdown>
          </div>
          {run.finish_reason === "length" && !research && (
            <p className="run-note">
              The reply reached this routine's length limit. Raise the per-run
              maximum for longer answers.
            </p>
          )}
          {research && run.code && (
            <p className="run-note">{RESEARCH_NOTES[run.code] || run.message}</p>
          )}
        </>
      ) : run.status === "running" ? (
        <p className="run-note">Running now…</p>
      ) : (
        <p className="run-reason">{reasonFor(run)}</p>
      )}
      {run.citations?.length > 0 && (
        <div className="run-sources">
          <p>Sources</p>
          {/* A research report's [n] citations are these numbers. */}
          {React.createElement(
            research ? "ol" : "ul",
            null,
            run.citations.map((c) => (
              <li key={c.url}>
                <a href={c.url} target="_blank" rel="noreferrer noopener" data-i18n="off">
                  {c.title || c.url}
                </a>
              </li>
            )),
          )}
        </div>
      )}
      {research && <ResearchRunDetails run={run} />}
      <div className="run-actions">
        {run.signed_receipt && <SignedReceipt signedReceipt={run.signed_receipt} />}
        {run.status === "done" && run.answer && (
          <CopyButton text={run.answer} label="Copy answer" />
        )}
        {run.status !== "running" && (
          <button type="button" className="small-button" onClick={onDelete} disabled={busy}>
            <Icon name="delete" size={14} />
            Delete
          </button>
        )}
      </div>
    </article>
  );
}

export default function Routines({ demo, user, models, config, refresh, markdown }) {
  // Secret Guard, for routine prompts and research watch topics.
  const secretLive = useSecretGuard(config, user, demo);
  const [params, setParams] = useSearchParams();
  const researchLive = researchWatchLive(config);
  const [tab, setTabState] = useState(() => {
      const t = params.get("tab");
      return t === "routines" ||
        (t === "watches" && isReleased(config, "pagewatch")) ||
        (t === "research" && researchLive)
        ? t
        : "inbox";
    }),
    [routines, setRoutines] = useState(() => (demo ? demoState().routines : [])),
    [runs, setRuns] = useState(() =>
      demo
        ? [...demoState().runs, ...(researchLive ? demoResearchState().runs : [])].sort(
            (a, b) => b.started_at - a.started_at,
          )
        : [],
    ),
    [researchWatches, setResearchWatches] = useState(() =>
      demo && researchLive ? demoResearchState().watches : [],
    ),
    [more, setMore] = useState(false),
    [filter, setFilterState] = useState(() => params.get("show") || ""),
    [draft, setDraft] = useState(null),
    [loaded, setLoaded] = useState(demo),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [formError, setFormError] = useState(""),
    [watches, setWatches] = useState(() => (demo ? demoWatchState().watches : [])),
    [reports, setReports] = useState(() => (demo ? demoWatchState().reports : [])),
    [reportsMore, setReportsMore] = useState(false),
    // Reports that were unread when this page showed them keep their
    // "Unread" tag while it stays open, even once they're marked seen.
    [fresh, setFresh] = useState(() => new Set());
  // The tab and the inbox filter live in the URL, beside anything else in it
  // (?demo=1), so a reload opens what's on screen.
  const syncParams = (changes) =>
    setParams(
      (p) => {
        const n = new URLSearchParams(p);
        for (const [k, v] of Object.entries(changes)) v ? n.set(k, v) : n.delete(k);
        return n;
      },
      { replace: true },
    );
  const setTab = (next) => {
    setTabState(next);
    syncParams({ tab: next === "inbox" ? null : next, ...(next === "research" ? {} : { watch: null }) });
  };
  const setFilter = (next) => {
    setFilterState(next);
    syncParams({ show: next || null });
  };
  const live = !demo && !!user;
  // Page Watch: its tab, and its reports in this inbox.
  const watchLive = isReleased(config, "pagewatch");
  const watchFilter = filter.startsWith("w:") ? filter.slice(2) : "";
  const routineFilter = watchFilter ? "" : filter;
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  const choices = models.filter(
    (m) =>
      m.type === "chat" &&
      (demo || m.callable) &&
      !m.imageCapable &&
      !(m.architecture?.output_modalities || []).includes("image"),
  );
  const nameOf = (id) =>
    demo && id === "demo-model"
      ? choices[0]?.name || "Sample model"
      : models.find((m) => m.id === id)?.name || id;

  async function load(quiet = false) {
    if (!live) return;
    try {
      const q = routineFilter ? "?routine=" + encodeURIComponent(routineFilter) : "";
      const wq = watchFilter ? "?watch=" + encodeURIComponent(watchFilter) : "";
      const none = { runs: [], reports: [], more: false };
      const [list, inbox, watched, reported, researched] = await Promise.all([
        api("/api/routines"),
        watchFilter ? none : api("/api/routines/runs" + q),
        watchLive ? api("/api/watches") : null,
        watchLive && !routineFilter ? api("/api/watches/reports" + wq) : none,
        researchLive ? api("/api/research-watches") : null,
      ]);
      if (!mounted.current) return;
      setRoutines(list.routines);
      if (researched) setResearchWatches(researched.watches);
      setRuns(inbox.runs);
      setMore(inbox.more);
      if (watched) setWatches(watched.watches);
      setReports(reported.reports);
      setReportsMore(reported.more);
      addFresh(reported.reports);
      setLoaded(true);
      if (!quiet) setError("");
    } catch (e) {
      // A filter left in the URL for a routine or watch that's gone.
      if (mounted.current && filter && /not_found$/.test(e.code || "")) return setFilter("");
      if (mounted.current && !quiet) setError(e.message);
    }
  }
  useEffect(() => {
    load();
  }, [live, filter, watchLive, researchLive]);
  // Keep the inbox current while the page is open: often while a run is in
  // flight, otherwise now and then.
  const anyRunning =
    routines.some((r) => r.running) ||
    runs.some((r) => r.status === "running") ||
    (watchLive && watches.some((w) => w.running)) ||
    (researchLive && researchWatches.some((w) => w.running));
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") load(true).then(() => anyRunning && refresh?.());
    }, anyRunning ? 4000 : 30000);
    return () => clearInterval(timer);
  }, [live, filter, anyRunning]);

  function addFresh(list) {
    const unread = list.filter((r) => !r.seen).map((r) => r.id);
    if (unread.length) setFresh((set) => new Set([...set, ...unread]));
  }
  async function olderRuns() {
    const last = runs.at(-1);
    const lastReport = reports.at(-1);
    try {
      if (more && last) {
        const q = new URLSearchParams({ before: String(last.started_at) });
        if (routineFilter) q.set("routine", routineFilter);
        const page = await api("/api/routines/runs?" + q);
        setRuns((r) => [...r, ...page.runs]);
        setMore(page.more);
      }
      if (watchLive && reportsMore && lastReport) {
        const q = new URLSearchParams({ before: String(lastReport.checked_at) });
        if (watchFilter) q.set("watch", watchFilter);
        const page = await api("/api/watches/reports?" + q);
        setReports((r) => [...r, ...page.reports]);
        setReportsMore(page.more);
        addFresh(page.reports);
      }
    } catch (e) {
      setError(e.message);
    }
  }
  async function removeReport(report) {
    if (demo) {
      setReports((list) => list.filter((x) => x.id !== report.id));
      return;
    }
    setBusy(true);
    try {
      await api("/api/watches/reports/" + report.id, { method: "DELETE" });
      setReports((list) => list.filter((x) => x.id !== report.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  // Reports shown in the inbox count as seen (the workspace badge clears);
  // they keep their "Unread" tag while the page stays open (`fresh`).
  const newest = reports.find((r) => !r.seen)?.checked_at;
  useEffect(() => {
    if (!live || !watchLive || tab !== "inbox" || newest == null) return;
    markWatchesSeen(Math.max(...reports.map((r) => r.checked_at)));
  }, [live, watchLive, tab, newest]);
  function openEditor(r) {
    setFormError("");
    setDraft(r ? draftOf(r) : blankDraft(choices));
    setTab("routines");
  }
  // `d` is the draft to save: Secret Guard's Mask and save passes the
  // masked one, before the state update lands.
  async function save(d = draft) {
    setFormError("");
    const body = bodyOf(d);
    if (demo) {
      const r = {
        ...body,
        id: d.id || "demo-" + Date.now(),
        schedule: body.schedule,
        next_run_at: body.enabled ? nextRunAfter(scheduleOfDraft(d), Date.now()) : null,
        running: false,
        month: routines.find((x) => x.id === d.id)?.month || { spent: 0, held: 0, remaining: body.monthly_budget_credits },
      };
      setRoutines((list) =>
        d.id ? list.map((x) => (x.id === d.id ? r : x)) : [...list, r],
      );
      setDraft(null);
      return;
    }
    setBusy(true);
    try {
      await api(d.id ? "/api/routines/" + d.id : "/api/routines", {
        method: d.id ? "PATCH" : "POST",
        body,
      });
      setDraft(null);
      await load();
    } catch (e) {
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(r, enabled) {
    if (demo) {
      setRoutines((list) => list.map((x) => (x.id === r.id ? { ...x, enabled } : x)));
      return;
    }
    setBusy(true);
    try {
      await api("/api/routines/" + r.id, { method: "PATCH", body: { enabled } });
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(r) {
    if (!r) return;
    if (demo) {
      setRoutines((list) => list.filter((x) => x.id !== r.id));
      setRuns((list) => list.filter((x) => x.routine_id !== r.id));
      setDraft(null);
      return;
    }
    setBusy(true);
    try {
      await api("/api/routines/" + r.id, { method: "DELETE" });
      if (filter === r.id) setFilter("");
      setDraft(null);
      await load();
    } catch (e) {
      setError(e.message);
      setFormError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function removeRun(run) {
    if (demo) {
      setRuns((list) => list.filter((x) => x.id !== run.id));
      return;
    }
    setBusy(true);
    try {
      await api("/api/routines/runs/" + run.id, { method: "DELETE" });
      setRuns((list) => list.filter((x) => x.id !== run.id));
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const shown = demo && filter ? runs.filter((r) => !watchFilter && r.routine_id === routineFilter) : runs;
  const shownReports = !watchLive
    ? []
    : demo && filter
      ? reports.filter((r) => r.watch_id === watchFilter)
      : reports;
  const items = mergeInbox({ runs: shown, runsMore: more, reports: shownReports, reportsMore });
  const atLimit = routines.length >= MAX_ROUTINES;
  return (
    <section className="routines-page">
      <div className="routines-head">
        <div>
          <p className="eyebrow">YOUR PROMPTS, ON A SCHEDULE</p>
          <h1>Routines</h1>
          <p>
            Save a prompt, choose when it runs and what it may spend. Every
            answer lands in your inbox.
          </p>
        </div>
        {(live || demo) && tab !== "watches" && tab !== "research" && (
          <Button type="button" onClick={() => openEditor(null)} disabled={atLimit || busy}>
            New routine <Icon name="plus" size={16} />
          </Button>
        )}
      </div>
      {demo && (
        <Notice>
          Demo: these routines are samples. Nothing runs and nothing is charged.
        </Notice>
      )}
      {!demo && !user && (
        <Notice>
          <Link to="/login">Sign in</Link> to create routines.
        </Notice>
      )}
      {error && <Notice type="error">{error}</Notice>}
      {(live || demo) && (
        <>
          <div className="filter-tabs routines-tabs" aria-label="Routines">
            <button
              type="button"
              aria-pressed={tab === "inbox"}
              className={tab === "inbox" ? "active" : ""}
              onClick={() => setTab("inbox")}
            >
              Inbox
            </button>
            <button
              type="button"
              aria-pressed={tab === "routines"}
              className={tab === "routines" ? "active" : ""}
              onClick={() => setTab("routines")}
            >
              Your routines
              <span className="routines-count">{`${routines.length}/${MAX_ROUTINES}`}</span>
            </button>
            {watchLive && (
              <button
                type="button"
                aria-pressed={tab === "watches"}
                className={tab === "watches" ? "active" : ""}
                onClick={() => setTab("watches")}
              >
                Page Watch
                <span className="routines-count">{`${watches.length}/${MAX_WATCHES}`}</span>
              </button>
            )}
            {researchLive && (
              <button
                type="button"
                aria-pressed={tab === "research"}
                className={tab === "research" ? "active" : ""}
                onClick={() => setTab("research")}
              >
                Research watch
                <span className="routines-count">{`${researchWatches.length}/${MAX_RESEARCH}`}</span>
              </button>
            )}
          </div>
          {atLimit && tab === "routines" && !draft && (
            <p className="routine-help">
              You have the most routines an account can keep. Delete one to add another.
            </p>
          )}
          {tab === "routines" && draft && (
            <Editor
              draft={draft}
              setDraft={setDraft}
              models={choices}
              config={config}
              busy={busy}
              error={formError}
              onSave={save}
              onCancel={() => setDraft(null)}
              onDelete={() => remove(routines.find((r) => r.id === draft.id))}
              secretLive={secretLive}
            />
          )}
          {tab === "research" && researchLive ? (
            <ResearchTab
              demo={demo}
              live={live}
              secretLive={secretLive}
              models={choices}
              config={config}
              watches={researchWatches}
              setWatches={setResearchWatches}
              reload={load}
              setError={setError}
              nameOf={nameOf}
              onRemoved={(id) => filter === id && setFilter("")}
              onReports={(id) => {
                setFilter(id);
                setTab("inbox");
              }}
            />
          ) : tab === "watches" && watchLive ? (
            <WatchesTab
              demo={demo}
              live={live}
              models={choices}
              config={config}
              watches={watches}
              setWatches={setWatches}
              reload={load}
              setError={setError}
              nameOf={nameOf}
              onRemoved={(id) => filter === "w:" + id && setFilter("")}
              onReports={(id) => {
                setFilter("w:" + id);
                setTab("inbox");
              }}
            />
          ) : tab === "routines" ? (
            routines.length ? (
              <div className="routine-grid">
                {routines.map((r) => (
                  <RoutineCard
                    key={r.id}
                    r={r}
                    modelName={nameOf(r.model)}
                    busy={busy}
                    onEdit={() => openEditor(r)}
                    onToggle={(v) => toggle(r, v)}
                    onDelete={() => remove(r)}
                    onInbox={() => {
                      setFilter(r.id);
                      setTab("inbox");
                    }}
                  />
                ))}
              </div>
            ) : (
              loaded &&
              !draft && (
                <Empty icon="history" title="No routines yet.">
                  A routine is a saved prompt that runs on a schedule, with its
                  own budget.
                </Empty>
              )
            )
          ) : (
            <div className="routines-inbox">
              <div className="routines-toolbar">
                <label>
                  <span>Show</span>
                  <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="">{watchLive || researchLive ? "Everything" : "All routines"}</option>
                    {/* With Page Watch or Research Watch, a heading row before
                        each group (a plain option, so the language switch
                        translates it). */}
                    {(watchLive || researchLive) && routines.length > 0 && (
                      <option value="#routines" disabled>
                        Routines
                      </option>
                    )}
                    {routines.map((r) => (
                      <option key={r.id} value={r.id} data-i18n="off">
                        {r.name}
                      </option>
                    ))}
                    {watchLive && watches.length > 0 && (
                      <option value="#watches" disabled>
                        Page Watch
                      </option>
                    )}
                    {watchLive &&
                      watches.map((w) => (
                        <option key={w.id} value={"w:" + w.id} data-i18n="off">
                          {shortUrl(w.url)}
                        </option>
                      ))}
                    {researchLive && researchWatches.length > 0 && (
                      <option value="#research" disabled>
                        Research watch
                      </option>
                    )}
                    {researchLive &&
                      researchWatches.map((w) => (
                        <option key={w.id} value={w.id} data-i18n="off">
                          {w.name}
                        </option>
                      ))}
                  </select>
                </label>
                {live && (
                  <button type="button" className="small-button" onClick={() => load()}>
                    <Icon name="refresh" size={14} />
                    Refresh
                  </button>
                )}
              </div>
              {items.map(({ kind, item }) =>
                kind === "run" ? (
                  <RunCard
                    key={item.id}
                    run={item}
                    modelName={nameOf(item.model)}
                    markdown={markdown}
                    busy={busy}
                    onDelete={() => removeRun(item)}
                  />
                ) : (
                  <WatchReportCard
                    key={item.id}
                    report={item}
                    modelName={nameOf(item.model)}
                    markdown={markdown}
                    busy={busy}
                    fresh={!item.seen || fresh.has(item.id)}
                    onDelete={() => removeReport(item)}
                  />
                ),
              )}
              {loaded && !items.length && (
                <Empty icon="history" title="Nothing here yet.">
                  Each run's answer lands here, with its time, status, charge
                  and signed receipt.
                </Empty>
              )}
              {(more || (watchLive && reportsMore)) && (
                <button type="button" className="small-button routines-more" onClick={olderRuns}>
                  Show older runs
                </button>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
