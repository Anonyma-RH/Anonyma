import React, { useState } from "react";
import { Icon } from "./ui.jsx";
import { isReleased } from "./lib.js";
import "./training-labels.css";

// Training Labels: the server flags a model whose provider uses what you
// send to improve its products (trainsOnPrompts), and names the listed
// version that isn't used that way (untrainedAlternative). See
// server/training.js for the rule. The fields only arrive once the update is
// released; the client checks the release too.
export const trainingLabelsReleased = (config) => isReleased(config, "training");

const providerOf = (m) => m.provider || m.owned_by || String(m.id).split("/")[0];

// The flagged model's alternative, if it's one of `models`.
export const untrainedAlternative = (m, models) =>
  m?.untrainedAlternative
    ? models.find((x) => x.id === m.untrainedAlternative) || null
    : null;

// Hover text for the tag.
export function trainingTitle(m, models) {
  const alternative = untrainedAlternative(m, models);
  const lead = `${providerOf(m)} says it uses what you send to this tier to improve its products.`;
  return alternative ? `${lead} ${alternative.name} isn't used that way.` : lead;
}

// Small tag next to a flagged model in a picker. A caution, unlike the
// Private tag, so it's outlined and marked rather than filled.
export function TrainingTag({ model, models }) {
  return (
    <span className="training-tag" title={trainingTitle(model, models)}>
      Trains on prompts
    </span>
  );
}

// The composer's per-model dismissals, kept in this browser only.
const KEY = "anonyma.trainingNotice.dismissed";
function loadDismissed() {
  try {
    const ids = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}
export function useTrainingDismissals() {
  const [dismissed, setDismissed] = useState(loadDismissed);
  function dismiss(id) {
    setDismissed((prev) => {
      const next = prev.includes(id) ? prev : [...prev, id].slice(-100);
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }
  return [dismissed, dismiss];
}

// Slim line above the composer while a flagged model is selected. It never
// blocks sending: switching and dismissing are both optional.
export function TrainingNotice({ model, alternative, onSwitch, onDismiss }) {
  return (
    <div className="training-notice" role="status">
      <span className="training-mark" aria-hidden="true" />
      <p>
        {providerOf(model)} says prompts sent to{" "}
        <b data-i18n="off">{model.name}</b> are used to improve its products.
      </p>
      {alternative && (
        <button type="button" className="training-switch" onClick={onSwitch}>
          Use <span data-i18n="off">{alternative.name}</span> instead
        </button>
      )}
      <button
        type="button"
        className="training-dismiss"
        aria-label="Dismiss"
        title="Dismiss"
        onClick={onDismiss}
      >
        <Icon name="close" size={14} />
      </button>
    </div>
  );
}
