import { createElement } from "react";

// Early Model Access in the browser (the server's rule is in
// server/early-models.js). /api/models is the same for everyone and marks a
// model in its first days with earlyUntil, when it opens to everyone. The
// workspace offers such a model only when the account's own session says
// it's eligible (user.holder.eligible: Insider tier and up, with a fresh
// balance check). The server refuses anyone else's request for it anyway.

export const earlyModelsReleased = (config) =>
  config?.releases?.features?.earlymodels === true &&
  config?.releases?.features?.holders === true;

export const earlyEligible = (user) => user?.holder?.eligible === true;

// Whether `m` is still in its early days at `t`.
export const isEarlyModel = (m, t = Date.now()) =>
  Number.isFinite(m?.earlyUntil) && m.earlyUntil > t;

// The catalog as this viewer may use it: every model for an eligible
// account, the rest without models still in their early days.
export function withEarlyModels(models, user, t = Date.now()) {
  if (!Array.isArray(models) || earlyEligible(user)) return models;
  const kept = models.filter((m) => !isEarlyModel(m, t));
  return kept.length === models.length ? models : kept;
}

// When a model opens to everyone, in the viewer's own locale and time zone:
// "10/9/2026, 2:05 PM" in English, which the 中文 switch rewrites as
// "2026/10/9 14:05" (translateDate in src/i18n.js), like other dates.
export const opensLabel = (t) =>
  new Date(t).toLocaleString(undefined, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });

// The text form of the Early tag, for a model's <option> in a select.
export const earlyModelSuffix = (m) => (isEarlyModel(m) ? " · Early" : "");

export const earlyModelTitle = (t) =>
  `New model: open to NYMA Insiders and up first. Opens to everyone ${opensLabel(t)}.`;

// The "Early" tag beside a model in its first days, which only an eligible
// account is offered: the Early access tag's cobalt badge (holders.css).
// Nothing once the model opens to everyone.
export function EarlyModelTag({ model }) {
  if (!isEarlyModel(model)) return null;
  return createElement(
    "span",
    {
      className: "early-tag early-model",
      title: earlyModelTitle(model.earlyUntil),
    },
    "Early",
  );
}
