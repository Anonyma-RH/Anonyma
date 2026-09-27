import React, { useEffect, useId, useState } from "react";
import { isReleased, readStore, saveStore } from "./lib.js";
import { Icon } from "./ui.jsx";
import { estimateLabel, formatCredits } from "./estimate.js";
import {
  AUTO_STORE,
  PREFERENCES,
  TIER_LABELS,
  autoTiers,
  loadAuto,
  readAuto,
  reasonText,
  viaText,
} from "./auto-model.js";
import "./auto-model.css";

// Auto Model (update "automodel", src/auto-model.js): "Auto" at the top of
// the workspace's model picker, the estimate beside Send while it's on, the
// chip under each reply it chose for ("Auto → Model · because: code") with
// one click to try another model, and Account → Settings' preferences.
export const autoModelReleased = (config) => isReleased(config, "automodel");

const PREFER_LABELS = { cheaper: "Cheaper", balanced: "Balanced", stronger: "Stronger" };
const PREFER_NOTES = {
  cheaper: "Close calls go to the fast model.",
  balanced: "Close calls go to the balanced model.",
  stronger: "Close calls go to the reasoning model.",
};
// The tiers the picker lists, in order (images and long documents are
// decided by the message itself).
const LISTED = ["fast", "balanced", "reasoning", "code"];

// This browser's Auto choices, kept in step with Account → Settings and
// other tabs.
export function useAutoChoices() {
  const [state, setState] = useState(() => loadAuto(readStore));
  useEffect(() => {
    const reload = () => setState(loadAuto(readStore));
    window.addEventListener("storage", reload);
    window.addEventListener("focus", reload);
    return () => {
      window.removeEventListener("storage", reload);
      window.removeEventListener("focus", reload);
    };
  }, []);
  const update = (next) => {
    setState(next);
    saveStore(AUTO_STORE, next);
  };
  return [state, update];
}

// The models Auto may use here, as the picker offers them: callable, and not
// Down (Model Status). The server checks the same things again.
export const autoPoolFrom = (models, status) =>
  models.filter((m) => m.callable !== false && status?.[m.id]?.status !== "down");

// [{ tier, model }] for the listed tiers, one row per tier.
export function autoTierList(pool) {
  const tiers = autoTiers(pool);
  return tiers ? LISTED.map((tier) => ({ tier, model: tiers[tier] })).filter((t) => t.model) : [];
}

const name = (models, id) => models.find((m) => m.id === id)?.name || id;

// The estimate beside Send while Auto is on: the chosen model's estimate
// when the rules have decided, else the most it can cost until Auto
// chooses (the dearest model it could land on, plus the helper), which is
// also what's held.
export function autoEstimateText(state, models = []) {
  const a = state?.auto;
  if (!a) return null;
  const credits = formatCredits(state.credits);
  if (a.decided) return { text: `Auto → ${name(models, a.model)} · ≈${credits} credits`, model: name(models, a.model) };
  return { text: `Auto · up to ≈${credits} credits`, model: null };
}
export function autoEstimateTitle(state) {
  const a = state?.auto;
  if (!a) return "";
  if (a.decided)
    return "Auto's rules chose this model for this message. An estimate, not a final charge: you pay only for what's used.";
  return a.helper
    ? `Until Auto chooses, this is the most the message can cost: the dearest model it might pick, plus up to ≈${formatCredits(a.helper.credits)} credits for a small model to help choose. It's what's held while the reply runs; you pay only for what's used.`
    : "Until Auto chooses, this is the most the message can cost: the dearest model it might pick. It's what's held while the reply runs; you pay only for what's used.";
}
export function AutoEstimate({ state, models = [] }) {
  const label = estimateLabel(state);
  if (!label) return null;
  const ready = label.tone !== "loading" && label.tone !== "unavailable";
  const shown = ready ? autoEstimateText(state, models) : null;
  return (
    <span
      className={"credit-estimate auto-estimate " + label.tone}
      role="status"
      aria-busy={label.tone === "loading"}
      title={label.tone === "unavailable" ? state.message : ready ? autoEstimateTitle(state) : undefined}
    >
      {ready && <Icon name="auto" size={13} />}
      {shown ? (
        shown.model ? (
          <>
            <span>Auto →</span> <span data-i18n="off">{shown.model}</span>{" "}
            <span>{`· ≈${formatCredits(state.credits)} credits`}</span>
          </>
        ) : (
          shown.text
        )
      ) : (
        label.text
      )}
      {label.tone === "short" && <b> · over your balance</b>}
      {label.tone === "limited" && <b> · over your spending limit</b>}
    </span>
  );
}

// Under a reply Auto chose for: which model and why, how it was chosen, and
// "Use a different model", which regenerates the reply on another model
// through the ordinary regenerate flow (a new branch of a saved chat).
export function AutoChip({ auto, models = [], alternatives = [], onUse = null, disabled = false }) {
  const a = readAuto(auto);
  const [open, setOpen] = useState(false);
  const [picking, setPicking] = useState(false);
  const id = useId();
  if (!a) return null;
  const choices = alternatives.filter((t) => t.model && t.model.id !== a.model);
  const helperName = a.helper ? name(models, a.helper.model) : null;
  return (
    <div className={"auto-chip-row" + (open ? " open" : "")}>
      <button
        type="button"
        className="auto-chip"
        aria-expanded={open}
        aria-controls={id + "-how"}
        title="How Auto chose this model"
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="auto" size={12} />
        <span>Auto →</span>
        <b data-i18n="off">{name(models, a.model)}</b>
        <span>{`· because: ${reasonText(a.reason)}`}</span>
      </button>
      {onUse && choices.length > 0 && (
        <button
          type="button"
          className="auto-other"
          aria-expanded={picking}
          disabled={disabled}
          onClick={() => setPicking((v) => !v)}
        >
          Use a different model
          <Icon name="down" size={12} />
        </button>
      )}
      {open && (
        <section className="auto-how" id={id + "-how"} aria-label="How Auto chose">
          <p className="auto-how-title">How Auto chose</p>
          <dl>
            <div>
              <dt>Tier</dt>
              <dd>{TIER_LABELS[a.tier]}</dd>
            </div>
            <div>
              <dt>Reason</dt>
              <dd className="auto-reason">{reasonText(a.reason)}</dd>
            </div>
            <div>
              <dt>Chosen by</dt>
              <dd>{viaText(a)}</dd>
            </div>
            {a.helper && (
              <div>
                <dt>Helper model</dt>
                <dd>
                  <span data-i18n="off">{helperName}</span>
                  <small>
                    {a.via === "helper"
                      ? `≈${formatCredits(a.helper.credits) || "0"} credits, included in this reply's charge`
                      : "Nothing charged"}
                  </small>
                </dd>
              </div>
            )}
            <div>
              <dt>Auto prefers</dt>
              <dd>{PREFER_LABELS[a.prefer]}</dd>
            </div>
          </dl>
          {a.sealed && <p className="auto-how-note">Sealed Mode: chosen in this browser by rules only, so your message went nowhere else.</p>}
        </section>
      )}
      {picking && onUse && (
        <div className="auto-alternatives" role="group" aria-label="Regenerate with another model">
          {choices.map((t) => (
            <button
              type="button"
              key={t.tier + t.model.id}
              disabled={disabled}
              onClick={() => {
                setPicking(false);
                onUse(t.model.id);
              }}
            >
              <em>{TIER_LABELS[t.tier]}</em>
              <span data-i18n="off">{t.model.name}</span>
            </button>
          ))}
          <p>Regenerates this reply on that model, as a new message. Auto stays on for your next one.</p>
        </div>
      )}
    </div>
  );
}

// Account → Settings: how Auto picks, in this browser.
export function AutoSettings({ config, demo = false }) {
  const [state, update] = useAutoChoices();
  const id = useId();
  if (!autoModelReleased(config) || demo) return null;
  return (
    <section className="auto-settings">
      <div>
        <h2>Auto Model.</h2>
        <p>
          How Auto picks a model for each message, in this browser. Choose Auto at the top of the model picker in
          Chat, Code and Uncensored. It never changes Private Mode, Sealed Mode or Uncensored: it only picks among the
          models they allow.
        </p>
      </div>
      <div className="auto-settings-body">
        <div className="auto-prefer" role="radiogroup" aria-labelledby={id + "-prefer"}>
          <span id={id + "-prefer"}>Auto prefers</span>
          <div>
            {PREFERENCES.map((p) => (
              <button
                key={p}
                type="button"
                role="radio"
                aria-checked={state.prefer === p}
                onClick={() => update({ ...state, prefer: p })}
              >
                {PREFER_LABELS[p]}
              </button>
            ))}
          </div>
          <small>{PREFER_NOTES[state.prefer]}</small>
        </div>
        <label className="shield-switch auto-helper-switch">
          <input
            type="checkbox"
            checked={state.helper}
            onChange={(e) => update({ ...state, helper: e.target.checked })}
          />
          <span>When the rules are unsure, ask a small model to choose</span>
        </label>
        <small className="auto-settings-fine">
          {state.helper
            ? "It reads only your newest message (Veil's tags stay tags), never your files, history or memory, and costs a fraction of a credit, included in that message's charge. If its answer can't be used, Auto uses Balanced and charges nothing for it."
            : "Off: nothing but the model that answers sees your message. An unsure message goes where your preference sends it."}
        </small>
      </div>
    </section>
  );
}
