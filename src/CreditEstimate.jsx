import React, { useEffect, useRef, useState } from "react";
import { api } from "./lib.js";
import { Icon } from "./ui.jsx";
import { createEstimator, estimateLabel, formatCredits, REPLY_BUDGET } from "./estimate.js";

// Credit Estimates: keeps a debounced /api/quote estimate for the request
// Send would make. `body` is that quote body, or null when there's nothing
// to estimate. Quoting never reserves or charges anything.
export function useCreditEstimate(body) {
  const [state, setState] = useState({ status: "idle" });
  const estimator = useRef(null);
  if (!estimator.current)
    estimator.current = createEstimator({
      quote: (b, signal) => api("/api/quote", { method: "POST", body: b, signal }),
      onChange: setState,
    });
  useEffect(() => {
    estimator.current.update(body);
  }, [body]);
  useEffect(() => () => estimator.current.dispose(), []);
  return state;
}

// Priced on the message and the reply budget at published rates; actual
// usage, and the amount held while a reply runs, can differ.
const explain = (budget = REPLY_BUDGET) => `An estimate, not a final charge: this message and a ${budget.toLocaleString("en-US")}-token reply budget at the model's published rates. Actual usage, and the amount held while the reply runs, can differ.`;

// The chip beside Send. Loading and unavailable never read as a number.
export function CreditEstimate({ state }) {
  const label = estimateLabel(state);
  if (!label) return null;
  const short = label.tone === "short";
  const limited = label.tone === "limited";
  const EXPLAIN = explain(state.replyBudget);
  return (
    <span
      className={"credit-estimate " + label.tone}
      role="status"
      aria-busy={label.tone === "loading"}
      title={
        label.tone === "unavailable"
          ? state.message
          : short
            ? `${EXPLAIN} You have ${formatCredits(state.available)} credits available.`
            : limited
              ? `${EXPLAIN} ${formatCredits(state.room)} credits are left under your spending limits.`
              : EXPLAIN
      }
    >
      {label.tone !== "loading" && label.tone !== "unavailable" && <Icon name="coins" size={13} />}
      {label.text}
      {short && <b> · over your balance</b>}
      {limited && <b> · over your spending limit</b>}
    </span>
  );
}
