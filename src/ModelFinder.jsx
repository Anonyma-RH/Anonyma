import React, { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "./ui.jsx";
import { formatCredits } from "./estimate.js";
import {
  PRESETS,
  TYPICAL,
  creditPrice,
  moveActive,
  pickPreset,
  qualityGuidance,
  searchModels,
} from "./model-finder.js";
import "./model-finder.css";

// What a price in this mode is for, said once under the list.
const PRICE_BASIS = {
  image: "one image",
  video: "the model's cheapest length and size",
  text: `a typical exchange (${TYPICAL.input.toLocaleString("en-US")} tokens in, ${TYPICAL.output.toLocaleString("en-US")} out)`,
};

// Model Finder & Presets: the model choice beside the composer. A button
// shows the model in use; it opens a panel with the three presets and a
// searchable list (combobox + listbox, arrow keys, Enter, Escape).
export default function ModelFinder({
  models,
  mode,
  markup,
  resolved,
  onChoose,
  opts,
  notes = [],
  trainingLive = false,
  demo = false,
}) {
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState(""),
    [active, setActive] = useState(-1),
    // Opens on the side of the button with more room, never off-screen.
    [place, setPlace] = useState({ below: false, max: 540 });
  const trigger = useRef(null),
    panel = useRef(null),
    input = useRef(null),
    list = useRef(null);
  const id = useId();
  const results = useMemo(() => searchModels(models, query, { mode }), [models, query, mode]);
  const presets = useMemo(
    () => PRESETS.map((p) => ({ ...p, model: pickPreset(models, p.id, { mode, ...opts }) })),
    [models, mode, opts],
  );
  const current = resolved?.model || null;
  const recommended = presets.find(p => p.id === "best")?.model;
  const guidance = qualityGuidance(recommended, mode);
  const preset = resolved?.via === "preset" && !resolved.fallback ? resolved.preset : null;
  const price = (m) => {
    const c = creditPrice(m, mode, markup);
    return c == null ? "No published price" : `≈${formatCredits(c)} credits`;
  };

  function close(returnFocus = true) {
    setOpen(false);
    setQuery("");
    if (returnFocus) trigger.current?.focus();
  }
  function choose(choice) {
    onChoose(choice);
    close();
  }
  function openPanel() {
    const r = trigger.current?.getBoundingClientRect();
    const above = r ? r.top : 600,
      below = r ? window.innerHeight - r.bottom : 0;
    const roomy = above >= 420 || above >= below;
    setPlace({ below: !roomy, max: Math.max(240, Math.min(540, (roomy ? above : below) - 16)) });
    setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    setActive(Math.max(0, results.findIndex((m) => m.id === current?.id)));
    input.current?.focus();
    const outside = (e) => {
      if (!panel.current?.contains(e.target) && !trigger.current?.contains(e.target)) close(false);
    };
    document.addEventListener("mousedown", outside);
    document.addEventListener("touchstart", outside);
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("touchstart", outside);
    };
  }, [open]);
  useEffect(() => {
    setActive((a) => (results.length ? Math.min(Math.max(a, 0), results.length - 1) : -1));
  }, [results.length]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[active]) choose({ model: results[active].id });
    } else if (["ArrowDown", "ArrowUp", "PageDown", "PageUp"].includes(e.key)) {
      e.preventDefault();
      setActive((i) => moveActive(i, e.key, results.length));
    }
  }

  return (
    <div className="mf">
      <button
        ref={trigger}
        type="button"
        className="mf-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model: ${current?.name || "none"}${preset ? `, ${PRESETS.find((p) => p.id === preset).label} preset` : ""}. Change model`}
        onClick={() => (open ? close() : openPanel())}
      >
        {preset && <small>{PRESETS.find((p) => p.id === preset).label}</small>}
        <b data-i18n="off">{current?.name || "Choose a model"}</b>
        <Icon name="down" size={14} />
      </button>
      {resolved?.fallback && (
        <p className="mf-fallback" role="status">
          <span data-i18n="off">{resolved.fallback.wanted}</span> {resolved.fallback.reason}
          {current ? (
            <>
              . Using <span data-i18n="off">{current.name}</span> instead.
            </>
          ) : (
            ", and no model here qualifies right now."
          )}
        </p>
      )}
      {open && (
        <div
          ref={panel}
          className={"mf-panel" + (place.below ? " below" : "")}
          style={{ "--mf-max": place.max + "px" }}
          role="dialog"
          aria-label="Choose a model"
          onKeyDown={(e) => e.key === "Escape" && (e.preventDefault(), close())}
          onBlur={(e) => {
            if (e.relatedTarget && !panel.current?.contains(e.relatedTarget) && e.relatedTarget !== trigger.current) close(false);
          }}
        >
          <div className="mf-presets" role="group" aria-label="Presets">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className="mf-preset"
                aria-pressed={preset === p.id}
                disabled={!p.model}
                title={p.id === "best" && guidance ? `${p.note}: ${guidance.reason}` : p.note}
                onClick={() => choose({ preset: p.id })}
              >
                <b>{p.label}</b>
                <span data-i18n="off">{p.model?.name || (p.id === "best" ? "No reviewed pick available" : "None available")}</span>
                {p.model && <small>{price(p.model)}</small>}
              </button>
            ))}
          </div>
          <label className="sr-only" htmlFor={id + "-search"}>
            Search models
          </label>
          <input
            ref={input}
            id={id + "-search"}
            className="mf-search"
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={id + "-list"}
            aria-autocomplete="list"
            aria-activedescendant={active >= 0 ? `${id}-opt-${active}` : undefined}
            placeholder="Search by name, provider or feature"
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
          />
          <ul ref={list} id={id + "-list"} className="mf-list" role="listbox" aria-label="Models">
            {results.map((m, i) => (
              <li
                key={m.id}
                id={`${id}-opt-${i}`}
                role="option"
                data-index={i}
                aria-selected={m.id === current?.id}
                className={i === active ? "active" : undefined}
                onMouseDown={(e) => e.preventDefault()}
                onMouseMove={() => i !== active && setActive(i)}
                onClick={() => choose({ model: m.id })}
              >
                <span className="mf-name" data-i18n="off">
                  {m.name}
                </span>
                <span className="mf-meta">
                  <span data-i18n="off">{m.provider}</span>
                  {!demo && m.private && <span className="mf-tag">Private</span>}
                  {m.vision && <span className="mf-tag">Sees images</span>}
                  {trainingLive && m.trainsOnPrompts && <span className="mf-tag warn">Trains on prompts</span>}
                </span>
                <span className="mf-price">{price(m)}</span>
              </li>
            ))}
            {!results.length && (
              <li className="mf-empty">
                {query ? "No model here matches that search." : "No model is available here right now."}
              </li>
            )}
          </ul>
          <p className="mf-foot">
            {notes.map((n) => (
              <span key={n}>{n} </span>
            ))}
            Prices are for {PRICE_BASIS[mode] || PRICE_BASIS.text} at the standard rate, from the live catalog.
            Best quality is our task recommendation, not a benchmark or price ranking.
            {guidance ? <> {guidance.reason}. <a href={guidance.source} target="_blank" rel="noreferrer">Provider capability notes</a>.</> : " No reviewed recommendation is available for this selection."}
          </p>
        </div>
      )}
    </div>
  );
}
