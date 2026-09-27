import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError, isReleased, readStore, saveStore, uid } from "./lib.js";
import { useApp } from "./context.jsx";
import { Icon } from "./ui.jsx";
import { formatCredits } from "./estimate.js";
import { unveil } from "./veil.js";
import { scanSecrets } from "./seed-guard.js";
import {
  SHARPEN_MIN,
  SHARPEN_MAX,
  MAX_ANSWER,
  checkPlaceholders,
  defaultSharpener,
  diffCounts,
  maskForSharpen,
  onlySentTags,
  pickSharpener,
  sharpenBody,
  sharpenPool,
  wordDiff,
} from "./sharpen.js";
import "./sharpen.css";

// Prompt Sharpen (update "sharpen"): a composer button that sends the prompt
// (and only the prompt) to a fast, inexpensive model, then shows the rewrite
// beside the original. Use this, Edit, or keep yours; Undo puts yours back.
// Off the record: nothing about a sharpen is saved. The server side is
// server/routes/sharpen.js; the pure parts are src/sharpen.js.
export const sharpenLive = (config) => isReleased(config, "sharpen");

export const SHARPEN_PLACEHOLDERS_NOTE =
  "The sharpened prompt dropped or changed a Veil placeholder such as [EMAIL_1], so it wasn't used. Nothing was charged. Try again, or pick another model.";
export const SHARPEN_STOPPED = "Stopped. Nothing was charged.";

// The chosen sharpener, in this browser only (Account → Settings and the
// panel both change it). Empty means the default.
const STORE = "sharpen:model";
export const loadSharpenModel = () => {
  const v = readStore(STORE, "");
  return typeof v === "string" && v.length <= 200 ? v : "";
};
export const saveSharpenModel = (id) => saveStore(STORE, id || "");

// Why Sharpen can't run on this prompt right now, or null.
export function sharpenBlock({ length, seed, model, privateMode }) {
  if (!model)
    return privateMode
      ? "No zero-data-retention model is available to sharpen with in Private mode."
      : "No model is available to sharpen with right now.";
  if (seed) return "Seed Guard found what looks like a wallet secret in this prompt, so Sharpen won't send it.";
  if (length < SHARPEN_MIN) return `Type at least ${SHARPEN_MIN} characters to sharpen.`;
  if (length > SHARPEN_MAX) return "Sharpen works on prompts up to 6,000 characters.";
  return null;
}

// A debounced /api/sharpen/quote for a prompt this long. It sends the
// length, never the prompt, and holds or charges nothing.
export function useSharpenEstimate({ enabled, model, chars, privateMode }) {
  const [state, setState] = useState({ status: "idle" });
  const key = enabled && model ? JSON.stringify([model, chars, !!privateMode]) : "";
  useEffect(() => {
    if (!key) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ status: "loading", last: s.status === "ready" ? s : s.last }));
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/sharpen/quote", {
          method: "POST",
          body: { model, chars, ...(privateMode ? { private: true } : {}) },
          signal: controller.signal,
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
  }, [key]);
  return state;
}
const shownEstimate = (s) => (s?.status === "ready" ? s : s?.status === "loading" ? s.last : null);

// Runs sharpens and keeps what the panel shows. States: idle, running,
// done (a result), error, used (the result is in the composer; Undo puts
// the original back).
export function useSharpen() {
  const [state, setState] = useState({ status: "idle" });
  const flight = useRef(null);
  const abort = () => {
    flight.current?.abort();
    flight.current = null;
  };
  // `text` is the prompt (without an @mention, which `prefix` keeps);
  // `veilWith` is { state, words } when Veil is on (a copy of the chat's
  // map: nothing is recorded for a sharpen).
  async function run({ text, prefix = "", model, modelName, privateMode, veilWith, answers = [] }) {
    abort();
    const c = new AbortController();
    flight.current = c;
    const base = { original: text, prefix, answers, model, modelName };
    setState({ status: "running", ...base });
    const sent = maskForSharpen(text, answers, veilWith);
    try {
      const r = await api("/api/sharpen", {
        method: "POST",
        body: sharpenBody({ model, prompt: sent.prompt, answers: sent.answers, privateMode, requestId: "sharpen-" + uid() }),
        signal: c.signal,
      });
      // Checked here too: nothing is restored unless every placeholder came
      // back exactly, and a note naming anything else is dropped.
      if (!checkPlaceholders(sent.tags, r.prompt).ok)
        throw new ApiError(SHARPEN_PLACEHOLDERS_NOTE, 502, "sharpen_placeholders");
      const restore = (t) => unveil(t, sent.map);
      const result = restore(r.prompt);
      setState({
        status: "done",
        ...base,
        result,
        notes: (r.notes || []).filter((n) => onlySentTags(n, sent.tags)).map(restore),
        questions: (r.questions || []).filter((q) => onlySentTags(q, sent.tags)).map(restore),
        credits: r.credits_charged,
        unchanged: r.unchanged === true || result.trim() === text.trim(),
        veiled: sent.masked,
      });
    } catch (e) {
      if (e?.name === "AbortError") return;
      setState({ status: "error", ...base, message: e?.message || "Sharpen didn't finish. Nothing was charged.", code: e?.code });
    } finally {
      if (flight.current === c) flight.current = null;
    }
  }
  return {
    state,
    run,
    // Stop: the server releases the hold, so nothing is charged.
    stop() {
      if (!flight.current) return;
      abort();
      setState((s) => ({ ...s, status: "error", message: SHARPEN_STOPPED, code: "sharpen_stopped" }));
    },
    reset() {
      abort();
      setState({ status: "idle" });
    },
    used(applied) {
      setState((s) => ({ status: "used", original: s.original, prefix: s.prefix, applied }));
    },
  };
}

// The composer button: its estimate is shown before it's pressed.
export function SharpenButton({ block, estimate, running, onSharpen, onStop }) {
  const q = shownEstimate(estimate);
  if (running)
    return (
      <button type="button" className="attachment-control sharpen-button running" onClick={onStop} title="Stop sharpening. Nothing is charged.">
        <Icon name="sharpen" size={17} />
        <span>Sharpening…</span>
      </button>
    );
  return (
    <button
      type="button"
      className="attachment-control sharpen-button"
      disabled={!!block}
      onClick={onSharpen}
      title={
        block ||
        (q
          ? `Sharpen this prompt: about ${formatCredits(q.credits)} credits, at most ${formatCredits(q.max)}. Off the record.`
          : "Sharpen this prompt. Off the record.")
      }
    >
      <Icon name="sharpen" size={17} />
      <span>Sharpen</span>
      {!block && q && (
        <small className="sharpen-cost">
          <Icon name="coins" size={11} />
          {`≈${formatCredits(q.credits)}`}
        </small>
      )}
    </button>
  );
}

// Before and after, with what changed marked in each.
function Diff({ ops, side }) {
  return (
    <p className="sharpen-text" data-i18n="off">
      {ops.map((op, i) =>
        op.type === "same" ? (
          <span key={i}>{op.text}</span>
        ) : op.type === (side === "before" ? "del" : "add") ? (
          side === "before" ? (
            <del key={i}>{op.text}</del>
          ) : (
            <ins key={i}>{op.text}</ins>
          )
        ) : null,
      )}
    </p>
  );
}

function ModelSelect({ pool, model, onModel, disabled }) {
  if (!pool.length) return null;
  const fallback = defaultSharpener(pool);
  return (
    <label className="sharpen-model">
      <span>Model</span>
      <select
        aria-label="Sharpen model"
        value={model?.id || ""}
        disabled={disabled}
        onChange={(e) => onModel(e.target.value === fallback?.id ? "" : e.target.value)}
      >
        {pool.map((m) => (
          <option key={m.id} value={m.id}>
            {m.name}
            {m.id === fallback?.id ? " · default" : ""}
          </option>
        ))}
      </select>
    </label>
  );
}

function Questions({ questions, disabled, onAnswer, estimate }) {
  const [open, setOpen] = useState(0);
  const [drafts, setDrafts] = useState({});
  const answers = questions
    .map((question) => ({ question, answer: (drafts[question] || "").trim() }))
    .filter((a) => a.answer);
  const secret = scanSecrets(answers.map((a) => a.answer));
  const q = shownEstimate(estimate);
  const submit = (e) => {
    e.preventDefault();
    if (answers.length && !secret && !disabled) onAnswer(answers);
  };
  return (
    <form className="sharpen-questions" onSubmit={submit}>
      <p className="sharpen-label">Answer to sharpen it further</p>
      <div className="sharpen-chips">
        {questions.map((question, i) => (
          <button
            type="button"
            key={question}
            className={"sharpen-chip" + (open === i ? " on" : "") + (drafts[question]?.trim() ? " answered" : "")}
            aria-pressed={open === i}
            onClick={() => setOpen(i)}
          >
            <span data-i18n="off">{question}</span>
            {drafts[question]?.trim() && <Icon name="check" size={12} />}
          </button>
        ))}
      </div>
      {questions[open] != null && (
        <div className="sharpen-answer">
          <input
            aria-label="Your answer"
            placeholder="Your answer"
            maxLength={MAX_ANSWER}
            value={drafts[questions[open]] || ""}
            disabled={disabled}
            onChange={(e) => setDrafts((d) => ({ ...d, [questions[open]]: e.target.value }))}
          />
          <button type="submit" className="small-button" disabled={disabled || !answers.length || !!secret}>
            Sharpen again
          </button>
        </div>
      )}
      {secret ? (
        <p className="sharpen-fine sharpen-warn">
          Seed Guard found what looks like a wallet secret in your answer, so Sharpen won't send it.
        </p>
      ) : (
        q && (
          <p className="sharpen-fine">{`Sends your prompt and answers again: about ${formatCredits(q.credits)} credits.`}</p>
        )
      )}
    </form>
  );
}

// Shown above the composer once Sharpen is pressed.
export function SharpenPanel({ sharpen, pool, model, onModel, estimate, onUse, onUndo, onAnswer, onRetry, teamPays = false }) {
  const { state } = sharpen;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  useEffect(() => setEditing(false), [state.status, state.result]);
  const ops = useMemo(
    () => (state.status === "done" ? wordDiff(state.original, state.result) : []),
    [state.status, state.original, state.result],
  );
  if (state.status === "idle") return null;
  if (state.status === "used")
    return (
      <div className="sharpen-used" role="status">
        <Icon name="sharpen" size={14} />
        <span>The sharpened prompt is in the composer.</span>
        <button type="button" className="small-button" onClick={onUndo}>
          <Icon name="undo" size={13} />
          Undo
        </button>
        <button type="button" className="sharpen-x" aria-label="Dismiss" onClick={sharpen.reset}>
          <Icon name="close" size={13} />
        </button>
      </div>
    );
  const running = state.status === "running";
  const counts = diffCounts(ops);
  return (
    <section className="sharpen-panel" aria-label="Prompt Sharpen" aria-busy={running}>
      <div className="sharpen-head">
        <span className="sharpen-tile" aria-hidden="true">
          <Icon name="sharpen" size={16} />
        </span>
        <div>
          <p className="sharpen-eyebrow">PROMPT SHARPEN</p>
          <p className="sharpen-meta">
            {running ? (
              <span>Sharpening your prompt…</span>
            ) : state.status === "done" ? (
              <>
                {state.unchanged ? (
                  <span>Already clear: no changes suggested.</span>
                ) : (
                  <span>{`${counts.added} added · ${counts.removed} removed`}</span>
                )}
                <span className="sharpen-dot" aria-hidden="true">·</span>
                <span>{`${formatCredits(state.credits)} credits`}</span>
                <span className="sharpen-dot" aria-hidden="true">·</span>
                <span>Off the record</span>
              </>
            ) : (
              <span>Your prompt wasn't changed.</span>
            )}
          </p>
        </div>
        <ModelSelect pool={pool} model={model} onModel={onModel} disabled={running} />
        <button type="button" className="sharpen-x" aria-label="Close" onClick={sharpen.reset}>
          <Icon name="close" size={14} />
        </button>
      </div>

      {running && (
        <div className="sharpen-running">
          <span className="sharpen-bar" aria-hidden="true" />
          <button type="button" className="small-button" onClick={sharpen.stop}>
            <Icon name="stop" size={12} />
            Stop
          </button>
        </div>
      )}

      {state.status === "error" && (
        <div className="sharpen-error" role="alert">
          <Icon name="warning" size={14} />
          <span>{state.message}</span>
          {state.code !== "seed_phrase_blocked" && (
            <button type="button" className="small-button" onClick={onRetry}>
              Try again
            </button>
          )}
        </div>
      )}

      {state.status === "done" && (
        <>
          <div className="sharpen-diff">
            <div className="sharpen-col before">
              <p className="sharpen-label">Before</p>
              {editing ? (
                <p className="sharpen-text" data-i18n="off">
                  {state.original}
                </p>
              ) : (
                <Diff ops={ops} side="before" />
              )}
            </div>
            <div className="sharpen-col after">
              <p className="sharpen-label">After</p>
              {editing ? (
                <textarea
                  aria-label="Edit the sharpened prompt"
                  value={draft}
                  autoFocus
                  onChange={(e) => setDraft(e.target.value)}
                />
              ) : (
                <Diff ops={ops} side="after" />
              )}
            </div>
          </div>
          {state.notes.length > 0 && (
            <div className="sharpen-notes">
              <p className="sharpen-label">What changed</p>
              <ul>
                {state.notes.map((n) => (
                  <li key={n} data-i18n="off">
                    {n}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {state.questions.length > 0 && !editing && (
            <Questions
              key={state.result}
              questions={state.questions}
              estimate={estimate}
              onAnswer={onAnswer}
            />
          )}
          <div className="sharpen-actions">
            {editing ? (
              <>
                <button type="button" className="sharpen-use" disabled={!draft.trim()} onClick={() => onUse(draft.trim())}>
                  <Icon name="check" size={14} />
                  Use this
                </button>
                <button type="button" className="small-button" onClick={() => setEditing(false)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                {!state.unchanged && (
                  <button type="button" className="sharpen-use" onClick={() => onUse(state.result)}>
                    <Icon name="check" size={14} />
                    Use this
                  </button>
                )}
                <button
                  type="button"
                  className="small-button"
                  onClick={() => {
                    setDraft(state.result);
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
                <button type="button" className="small-button" onClick={sharpen.reset}>
                  Keep mine
                </button>
              </>
            )}
          </div>
          {state.veiled > 0 && (
            <p className="sharpen-fine">
              {state.veiled === 1
                ? "Veil masked 1 detail before sending and restored it here."
                : `Veil masked ${state.veiled} details before sending and restored them here.`}
            </p>
          )}
        </>
      )}
      <p className="sharpen-fine">
        Only this prompt is sent, off the record: not your chat, files, memory or instructions. Nothing is saved.
      </p>
      {teamPays && <p className="sharpen-fine">Sharpen is paid from your own balance, not a team treasury.</p>}
    </section>
  );
}

// Account → Settings: the sharpener for this browser.
export function SharpenSettings({ config }) {
  const { models, user } = useApp();
  const [chosen, setChosen] = useState(loadSharpenModel);
  const pool = useMemo(() => sharpenPool(models, { inSection: (m) => !(config?.releases?.uncensoredModels || []).includes(m.id) }), [models, config]);
  if (!sharpenLive(config) || !user) return null;
  const fallback = defaultSharpener(pool);
  const current = pickSharpener(pool, chosen);
  return (
    <section className="sharpen-settings">
      <div>
        <h2>Prompt Sharpen.</h2>
        <p>
          The model that sharpens your prompts, in this browser. The default is a fast, inexpensive model that doesn't
          train on prompts. Private mode always uses a zero-data-retention model, and Uncensored its own models.
        </p>
      </div>
      <label className="retention-select">
        Sharpen model
        <select
          aria-label="Sharpen model"
          value={current?.id || ""}
          disabled={!pool.length}
          onChange={(e) => {
            const id = e.target.value === fallback?.id ? "" : e.target.value;
            saveSharpenModel(id);
            setChosen(id);
          }}
        >
          {pool.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
              {m.id === fallback?.id ? " · default" : ""}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}
