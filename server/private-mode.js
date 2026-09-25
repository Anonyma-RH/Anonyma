// A model is private when the gateway labels it zero data retention: its
// providers have agreed not to store prompts or answers, and PPQ doesn't
// store prompts either. Requests still have to opt in (see ZDR_ROUTING).
// "e2e" models need client-side encryption and aren't callable here yet.
// PRIVATE_MODELS lists extra ids an operator counts as private.
export function isPrivateModel(m, cfg) {
  return (
    m?.privacyLevel === "zdr" || (cfg.privateModels || []).includes(m?.id)
  );
}

// Zero data retention is opt-in per request on the gateway. Asking for it on
// a model without a ZDR endpoint fails to route rather than falling back.
export const ZDR_ROUTING = { provider: { zdr: true, data_collection: "deny" } };
