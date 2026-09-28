import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { api } from "./lib.js";
import { Icon } from "./ui.jsx";
import { EarlyModelTag } from "./early-models.js";
import { formatCredits } from "./estimate.js";
import { searchModels } from "./model-finder.js";
import {
  MAX_PICKED,
  ROLE_LABELS,
  addable,
  compareBody,
  comparePresets,
  compareRows,
  compareSet,
  contextLabel,
  differenceLabel,
  overLabel,
  refusalText,
  relativeLabel,
} from "./cost-compare.js";
import "./cost-compare.css";

const FOOT =
  "Estimates, not final charges: each model is priced by the same quote as Send, with the reply budget Send would give it. Actual usage and the amount held can differ. Comparing sends and charges nothing.";

// Cost Compare: a "Compare" button beside the credit estimate chip, and a
// panel that prices the message being written on the model in use, the
// Model Finder presets and up to MAX_PICKED models the person adds, from
// the same pool (and with the same Private mode, Uncensored and image rules)
// as the model picker. "Use" switches the chat's model; nothing is sent.
export default function CostCompare({
  base, // the chip's /api/quote body, or null when nothing can be estimated
  mode,
  privateMode = false,
  replyBudget, // the reply budget as chosen, before any model's limit
  current, // the model in use
  pool, // the models the picker offers here
  allModels = pool,
  presetOpts,
  presetsLive = false,
  notes = [],
  busy = false,
  onSwitch,
}) {
  const [open, setOpen] = useState(false),
    [picked, setPicked] = useState([]),
    [query, setQuery] = useState(""),
    [state, setState] = useState({ status: "idle" }),
    [switched, setSwitched] = useState(null),
    [attempt, setAttempt] = useState(0),
    // Opens on the side of the button with more room, never off-screen.
    [place, setPlace] = useState({ below: false, max: 620 });
  const trigger = useRef(null),
    panel = useRef(null);
  const id = useId();
  const presets = useMemo(
    () => comparePresets(pool, presetOpts, presetsLive),
    [pool, presetOpts, presetsLive],
  );
  // A pick leaves the comparison when the picker stops offering it (Private
  // mode switched on, images attached): the same rules as the picker.
  const picks = picked.filter((p) => pool.some((m) => m.id === p));
  const set = useMemo(
    () => compareSet({ current: current?.id, presets, picked: picks }),
    [current?.id, presets, picks.join("\n")],
  );
  // Serialised once per change (a message can carry images), and only while open.
  const ids = set.map((s) => s.id).join("\n");
  const key = useMemo(() => {
    const body = open
      ? compareBody(base, {
          models: ids.split("\n").filter(Boolean),
          mode,
          replyBudget,
          privateMode,
        })
      : null;
    return body ? JSON.stringify(body) : null;
  }, [open, base, ids, mode, replyBudget, privateMode]);
  useEffect(() => {
    if (!key) return;
    const controller = new AbortController();
    setState({ status: "loading" });
    // A short pause so typing or several quick picks cost one request.
    const timer = setTimeout(async () => {
      try {
        const response = await api("/api/estimate/compare", {
          method: "POST",
          body: JSON.parse(key),
          signal: controller.signal,
        });
        setState({ status: "ready", response, key });
      } catch (e) {
        if (e?.name === "AbortError") return;
        setState({ status: "error", message: e?.message || "", key });
      }
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, attempt]);
  // Sending closes the comparison: it was for the message just sent.
  useEffect(() => {
    if (busy && open) setOpen(false);
  }, [busy]);
  useEffect(() => {
    if (!open) return;
    panel.current?.focus();
    const outside = (e) => {
      if (
        !panel.current?.contains(e.target) &&
        !trigger.current?.contains(e.target)
      )
        setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("touchstart", outside);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("touchstart", outside);
    };
  }, [open]);

  const name = (modelId) =>
    allModels.find((m) => m.id === modelId)?.name ||
    pool.find((m) => m.id === modelId)?.name ||
    modelId;
  const model = (modelId) =>
    allModels.find((m) => m.id === modelId) ||
    pool.find((m) => m.id === modelId);
  // Prices shown are only ever the answer for the request on screen.
  const fresh =
    state.status === "ready" && state.key === key ? state.response : null;
  const rows = fresh
    ? compareRows(fresh, set)
    : set.map((s) => ({ ...s, result: null }));
  const results = useMemo(
    () => (query.trim() ? searchModels(pool, query, { mode }) : []),
    [pool, query, mode],
  );
  const canAdd = addable(results, set, picks).slice(0, 6);
  const full = picks.length >= MAX_PICKED;

  function close() {
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  }
  function use(modelId) {
    // The model left behind stays in the comparison when there's room.
    const previous = current?.id;
    if (
      previous &&
      previous !== modelId &&
      !set.some((s) => s.id === previous && s.roles.length > 1)
    )
      setPicked((p) =>
        p.includes(previous) || p.length >= MAX_PICKED ? p : [...p, previous],
      );
    setPicked((p) => p.filter((x) => x !== modelId));
    setSwitched(name(modelId));
    onSwitch(modelId);
  }

  if (!base && !open) return null;
  return (
    <span className="cc">
      <button
        ref={trigger}
        type="button"
        className="cc-open"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? id + "-panel" : undefined}
        title="Compare this message's cost on other models"
        onClick={() => {
          if (open) close();
          else {
            const r = trigger.current?.getBoundingClientRect();
            const above = r ? r.top - 16 : 620,
              below = r ? window.innerHeight - r.bottom - 16 : 0;
            const up = above >= 420 || above >= below;
            setPlace({
              below: !up,
              max: Math.max(260, Math.min(620, (up ? above : below) - 10)),
            });
            setSwitched(null);
            setOpen(true);
          }
        }}
      >
        <Icon name="filter" size={13} />
        Compare
      </button>
      {open && (
        <div
          ref={panel}
          id={id + "-panel"}
          className={"cc-panel" + (place.below ? " below" : "")}
          style={{ "--cc-max": place.max + "px" }}
          role="dialog"
          aria-labelledby={id + "-title"}
          tabIndex={-1}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            }
          }}
        >
          <header className="cc-head">
            <div>
              <h3 id={id + "-title"}>Cost Compare</h3>
              <p>This message, priced on other models before you send it.</p>
            </div>
            <button
              type="button"
              className="cc-close"
              aria-label="Close"
              onClick={close}
            >
              <Icon name="close" size={16} />
            </button>
          </header>
          {(notes.length > 0 || fresh?.web_search) && (
            <p className="cc-notes">
              {notes.map((n) => (
                <span key={n}>{n} </span>
              ))}
              {fresh?.web_search && <span>Web search fee included.</span>}
            </p>
          )}
          {!base ? (
            <p className="cc-empty">
              Type a message to compare what it would cost.
            </p>
          ) : (
            <>
              <ul
                className="cc-list"
                aria-busy={state.status === "loading"}
                aria-label="Estimates by model"
              >
                {rows.map((row) => (
                  <CompareRow
                    key={row.id}
                    row={row}
                    response={fresh}
                    failed={state.status === "error"}
                    replyBudget={replyBudget}
                    name={name(row.id)}
                    model={model(row.id)}
                    onUse={() => use(row.id)}
                    onRemove={() =>
                      setPicked((p) => p.filter((x) => x !== row.id))
                    }
                  />
                ))}
              </ul>
              {state.status === "loading" && (
                <p className="cc-status" role="status">
                  Pricing this message…
                </p>
              )}
              {state.status === "error" && state.key === key && (
                <p className="cc-status error" role="alert">
                  {state.message || "Estimates are unavailable right now."}{" "}
                  <button
                    type="button"
                    onClick={() => setAttempt((n) => n + 1)}
                  >
                    Try again
                  </button>
                </p>
              )}
              {switched && state.status !== "loading" && (
                <p className="cc-status" role="status">
                  {`Now using ${switched}. Nothing was sent.`}
                </p>
              )}
              <div className="cc-add">
                <label htmlFor={id + "-add"}>Add a model to compare</label>
                <input
                  id={id + "-add"}
                  type="search"
                  placeholder="Search by name, provider or feature"
                  autoComplete="off"
                  value={query}
                  disabled={full}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {full && (
                  <small>{`You can add up to ${MAX_PICKED} models.`}</small>
                )}
                {canAdd.length > 0 && (
                  <ul className="cc-found" aria-label="Models to add">
                    {canAdd.map((m) => (
                      <li key={m.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setPicked((p) =>
                              p.includes(m.id) ? p : [...p, m.id],
                            );
                            setQuery("");
                          }}
                        >
                          <Icon name="plus" size={13} />
                          <span data-i18n="off">{m.name}</span>
                          <EarlyModelTag model={m} />
                          <small data-i18n="off">{m.provider}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {query.trim() && !full && !canAdd.length && (
                  <small>No other model here matches that search.</small>
                )}
              </div>
            </>
          )}
          <p className="cc-foot">{FOOT}</p>
        </div>
      )}
    </span>
  );
}

// One model's line: its roles and tags, why it can't take this message (if
// so), its estimate and the difference from the model in use, and Use.
export function CompareRow({
  row,
  response,
  failed = false,
  replyBudget,
  name,
  model,
  onUse,
  onRemove,
}) {
  const r = row.result;
  const inUse = row.roles.includes("current");
  const currentResult = response?.results?.[0];
  const diff = !inUse && differenceLabel(r);
  const rel =
    !inUse && r?.status === "ok" && currentResult?.status === "ok"
      ? relativeLabel(r.credits, currentResult.credits)
      : null;
  const over = overLabel(r, response);
  const capped =
    r?.reply_budget != null && replyBudget && r.reply_budget < replyBudget;
  return (
    <li
      className={
        "cc-row" +
        (inUse ? " current" : "") +
        (r?.status === "refused" ? " refused" : "") +
        (diff ? " " + diff.tone : "")
      }
    >
      <div className="cc-model">
        <span className="cc-name" data-i18n="off">
          {name}
        </span>
        <span className="cc-roles">
          {row.roles.map((role) => (
            <span key={role} className={"cc-role " + role}>
              {ROLE_LABELS[role]}
            </span>
          ))}
          {model?.vision && <span className="cc-tag">Sees images</span>}
          {model?.private && <span className="cc-tag">Private</span>}
          {model && <EarlyModelTag model={model} />}
          {capped && (
            <span
              className="cc-tag"
              title={`Priced with the ${r.reply_budget.toLocaleString("en-US")}-token reply budget Send would ask this model for.`}
            >
              {`Reply budget ${r.reply_budget.toLocaleString("en-US")} tokens`}
            </span>
          )}
        </span>
        {r?.status === "refused" && (
          <span className="cc-why">
            <Icon name="warning" size={12} />
            {refusalText(r.code)}
            {r.code === "context_limit_exceeded" && r.context && (
              <small>{contextLabel(r.context)}</small>
            )}
          </span>
        )}
        {over && <span className="cc-why">{over}</span>}
      </div>
      <div className="cc-price">
        {!r ? (
          <span className="cc-wait">{failed ? "—" : "…"}</span>
        ) : r.status === "ok" ? (
          <>
            <b>{`≈${formatCredits(r.credits)} credits`}</b>
            {inUse ? (
              <small>In use</small>
            ) : (
              diff && (
                <small className={"cc-diff " + diff.tone}>
                  {diff.text}
                  {rel && <em>{rel}</em>}
                </small>
              )
            )}
          </>
        ) : (
          <span className="cc-wait">—</span>
        )}
      </div>
      <div className="cc-act">
        {row.roles.includes("picked") && !inUse && (
          <button
            type="button"
            className="cc-remove"
            aria-label={`Remove ${name} from the comparison`}
            onClick={onRemove}
          >
            <Icon name="close" size={13} />
          </button>
        )}
        {!inUse && (
          <button
            type="button"
            className="cc-use"
            disabled={r?.status !== "ok"}
            aria-label={`Use ${name}`}
            onClick={onUse}
          >
            Use
          </button>
        )}
      </div>
    </li>
  );
}
