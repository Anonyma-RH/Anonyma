// Privacy Trail, client side: turns the server's privacy object (the final
// chat event's anonyma.privacy, or a saved reply's content.privacy) into the
// panel's rows. See server/privacy-trail.js for where each field comes from.
// Only facts in that object are shown; anything missing or unrecognised is
// left out rather than guessed.

export const ROUTE_LABELS = {
  primary: "Primary gateway",
  backup: "Backup gateway",
};
export const RETENTION_LABELS = {
  zero_data_retention: "Zero data retention",
  provider_may_retain: "Provider may retain",
};
export const STORAGE_LABELS = {
  saved: "Saved to your history",
  off_the_record: "Off the record (not saved)",
  private: "Private Mode (not saved)",
  not_saved: "Not saved",
};

// A privacy object with the fields the panel needs, or null. Saved replies
// come back from storage as written, so this checks rather than trusts.
export function readTrail(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (typeof p.model !== "string" || !p.model) return null;
  if (!ROUTE_LABELS[p.route] || !RETENTION_LABELS[p.retention] || !STORAGE_LABELS[p.storage])
    return null;
  const veil = p.veil_masked;
  return {
    model: p.model,
    provider: typeof p.provider === "string" && p.provider ? p.provider : null,
    route: p.route,
    retention: p.retention,
    trainsOnPrompts: p.trains_on_prompts === true,
    storage: p.storage,
    // undefined: not reported; null: Veil off; a number: masked details.
    veil: veil === null || (Number.isSafeInteger(veil) && veil >= 0) ? veil : undefined,
    receiptId: typeof p.receipt_id === "string" && p.receipt_id ? p.receipt_id : null,
  };
}

// One template string per count, so the language switch sees whole phrases.
export function veilLabel(veil) {
  if (veil === undefined) return null;
  if (veil === null) return "Off";
  if (veil === 0) return "On · nothing found to mask";
  return veil === 1 ? "1 detail masked" : `${veil} details masked`;
}

// The panel's rows, in order: [{ key, label, value, ... }]. `modelName` is
// the catalog's display name when this browser has it; `privateModel` says
// the catalog marks the model private (it offers zero data retention, which
// applies only when a request asks for it: Private Mode). `receiptsLive`
// adds the receipt row even when this reply has no signed receipt.
export function trailRows(trail, { modelName, privateModel = false, receiptsLive = false } = {}) {
  if (!trail) return [];
  const rows = [
    {
      key: "model",
      label: "Model",
      value: modelName || trail.model,
      provider: trail.provider,
    },
    { key: "route", label: "Route", value: ROUTE_LABELS[trail.route] },
    {
      key: "retention",
      label: "Retention",
      value: RETENTION_LABELS[trail.retention],
      zdr: trail.retention === "zero_data_retention",
      trainsOnPrompts: trail.trainsOnPrompts,
      note:
        trail.retention !== "zero_data_retention" && privateModel
          ? "Zero data retention applies only in Private Mode."
          : null,
    },
  ];
  const veil = veilLabel(trail.veil);
  if (veil) rows.push({ key: "veil", label: "Veil", value: veil, on: trail.veil !== null });
  rows.push({ key: "storage", label: "Storage", value: STORAGE_LABELS[trail.storage] });
  if (trail.receiptId || receiptsLive)
    rows.push({
      key: "receipt",
      label: "Receipt",
      value: trail.receiptId ? "Signed" : "Not signed",
      receiptId: trail.receiptId,
    });
  return rows;
}
