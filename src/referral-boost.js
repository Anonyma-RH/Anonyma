// Referral Boost in the browser. The server picks each reward's rate, by
// the referrer's NYMA tier when a referred top-up is confirmed
// (server/referral-boost.js); this only shows the rates it publishes.
import { holderProgram, TIER_NAMES } from "./holders.js";

export const TIER_IDS = ["holder", "insider", "inner"];

export const boostReleased = (config) =>
  config?.releases?.features?.referralboost === true;

// { base, tiers: { holder, insider, inner } } from /api/config while the
// boost has effect (released, with the Holder Program), else null.
export const referralBoost = (config) =>
  boostReleased(config) ? holderProgram(config)?.referralBoost || null : null;

export const percentText = (n) =>
  `${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;

// The percent GET /api/referrals says this account earns now: its boosted
// rate while Referral Boost is live, otherwise the base.
export const ownPercent = (referrals) =>
  Number(referrals?.rate?.percent ?? referrals?.percent ?? 0);

// "Your rate: 7.5% (Insider boost)" or "Your rate: 5% (base rate)".
export const rateLine = (rate) =>
  rate?.tier
    ? `Your rate: ${percentText(rate.percent)} (${TIER_NAMES[rate.tier] || rate.tier} boost)`
    : `Your rate: ${percentText(rate?.percent)} (base rate)`;

// A tier's perk text, or null when that tier earns only the base.
export const boostPerk = (boost, tierId) => {
  const percent = boost?.tiers?.[tierId];
  return percent != null && percent > boost.base
    ? `Referral boost: ${percentText(percent)}`
    : null;
};

// [{ id, name, percent, boosted }] lowest tier first, from either the
// config's { holder: 6, … } or the referrals response's tier list.
export function tierList(boost) {
  if (!boost) return [];
  const tiers = Array.isArray(boost?.tiers)
    ? boost.tiers
    : TIER_IDS.map((id) => ({ id, percent: boost?.tiers?.[id] }));
  return tiers
    .filter((t) => t.percent != null)
    .map((t) => ({
      id: t.id,
      name: TIER_NAMES[t.id] || t.name || t.id,
      percent: Number(t.percent),
      boosted: Number(t.percent) > Number(boost.base),
    }));
}

// The highest tier's percent: "up to 10%".
export const topPercent = (boost) =>
  Math.max(0, ...tierList(boost).map((t) => t.percent));
