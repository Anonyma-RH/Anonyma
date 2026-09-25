import { isReleased } from "./releases.js";

// A model is private when its provider is on the configured allow-list
// (case-insensitive against the catalog's owned_by), or its id is listed
// explicitly. See server/core.js's config() for PRIVATE_MODEL_PROVIDERS
// (default: Venice) and PRIVATE_MODELS.
export function isPrivateModel(m, cfg) {
  const providers = (cfg.privateModelProviders || []).map((p) =>
    p.toLowerCase(),
  );
  return (
    providers.includes(String(m?.owned_by || "").toLowerCase()) ||
    (cfg.privateModels || []).includes(m?.id)
  );
}
