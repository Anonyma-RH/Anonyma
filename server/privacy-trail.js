import { fail } from "./core.js";
import { isReleased } from "./releases.js";
import { trainingLabel } from "./training.js";

// Privacy Trail: where one prompt went, built only from facts the server
// already holds for that request. Nothing here is inferred or estimated, and
// none of it is prompt or answer text: an id, a provider name, a few fixed
// words and a count. The same object goes on the final chat event, the /v1
// response (anonyma.privacy), MCP ask results and, for saved chats, the
// stored assistant message, so the panel still works after a reload.
//
// - model, provider: the catalog id and its owned_by (null when unlisted).
// - route: "primary", or "backup" when the backup gateway served it after
//   the primary refused before accepting (server/fallback.js).
// - retention: "zero_data_retention" only when the request was sent with the
//   gateway's ZDR routing (Private Mode, or a private-only connected app);
//   ZDR is opt-in per request, so a ZDR-capable model sent without it is
//   "provider_may_retain" like any other.
// - trains_on_prompts: Training Labels' rule (server/training.js), present
//   once that update is released.
// - storage: "saved" (conversation history), "off_the_record", "private"
//   (Private Mode, never saved) or "not_saved" (the API and MCP).
// - veil_masked: workspace only. Veil runs in the browser, so this is the
//   count the browser reported for the request, or null when Veil was off.
//   Absent when nothing was reported (the API never is).
// - receipt_id: the signed receipt's id (the requestId), or null.
export const STORAGE = ["saved", "off_the_record", "private", "not_saved"];
export const TRAIL_FIELDS = [
  "model",
  "provider",
  "route",
  "retention",
  "trains_on_prompts",
  "storage",
  "veil_masked",
  "receipt_id",
];

export const trailLive = (cfg) => isReleased(cfg, "trail");

export function storageFor({ api, isPrivate, ephemeral }) {
  if (api) return "not_saved";
  if (isPrivate) return "private";
  return ephemeral ? "off_the_record" : "saved";
}

// The workspace's veil_masked body field: absent (not reported), null (Veil
// off) or a whole count. Gated in featuresFor (releases.js).
export function veilMaskedFrom(body) {
  if (!Object.hasOwn(body || {}, "veil_masked")) return undefined;
  const v = body.veil_masked;
  if (v === null) return null;
  if (!Number.isSafeInteger(v) || v < 0 || v > 10000)
    fail(400, "Veil's mask count must be a whole number, or null.", "invalid_request");
  return v;
}

export function privacyTrail(cfg, { model, route, zeroDataRetention, storage, veilMasked, receiptId }) {
  const provider =
    typeof model.owned_by === "string" && model.owned_by.trim()
      ? model.owned_by.trim().slice(0, 80)
      : null;
  return {
    model: model.id,
    provider,
    route: route === "backup" ? "backup" : "primary",
    retention: zeroDataRetention ? "zero_data_retention" : "provider_may_retain",
    ...(isReleased(cfg, "training")
      ? { trains_on_prompts: !!trainingLabel(model) }
      : {}),
    storage,
    ...(veilMasked !== undefined ? { veil_masked: veilMasked } : {}),
    receipt_id: typeof receiptId === "string" && receiptId ? receiptId : null,
  };
}
