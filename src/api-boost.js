// API Boost in the browser. The server applies the limits (server/api-boost.js);
// this only mirrors what /api/config and /api/account/api-limit say.

export const apiBoostLive = (config) =>
  config?.releases?.features?.apiboost === true;

// The public settings from /api/config once the update is released: the
// standard rates and, while the boost is on, each tier's.
export const apiBoostOf = (config) =>
  apiBoostLive(config) ? config?.apiBoost || null : null;

const count = (n) => Number(n || 0).toLocaleString("en-US");
export const perMinuteText = (n) => `${count(n)} requests/min`;
export const multiplierText = (m) => `${Number(m)}×`;

// What the API keys page shows before (or without) the account's own limit:
// the standard rate, as for an account without a tier.
export const standardLimit = (boost) => ({
  perMinute: boost?.perMinute ?? 120,
  filesPerMinute: boost?.filesPerMinute ?? 60,
  multiplier: 1,
  tier: null,
});

// "Your API rate limit: 360 requests/min (Insider boost)".
export const rateLine = (limit) =>
  limit?.tier
    ? `Your API rate limit: ${perMinuteText(limit.perMinute)} (${limit.tier.name} boost)`
    : `Your API rate limit: ${perMinuteText(limit?.perMinute)}`;

// Tiers whose limit is above the standard one.
export const boostedTiers = (boost) =>
  (boost?.tiers || []).filter((t) => t.multiplier > 1);
export const topTier = (boost) => boostedTiers(boost).at(-1) || null;

// The boost as one of a tier's perks ("API limit 3×"), or null.
export function apiBoostPerk(boost, tierId) {
  const tier = boostedTiers(boost).find((t) => t.id === tierId);
  return tier ? `API limit ${multiplierText(tier.multiplier)}` : null;
}
