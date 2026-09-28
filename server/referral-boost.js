import { now } from "./core.js";
import { isReleased } from "./releases.js";
import { currentTier, holderTiers, programLive } from "./holders.js";
import { referralTierRates } from "./holder-tiers.js";

// Referral Boost: a referrer who holds NYMA earns a higher referral reward,
// by Holder Program tier. The reward itself is still paid by referralReward
// in server/payments.js, once per credited deposit; this only picks its
// rate:
//
//   no tier (or a stale check)   REFERRAL_PERCENT, 5% by default
//   Holder                       6%    \
//   Insider                      7.5%   } HOLDER_REFERRAL_PERCENTS
//   Inner Circle                 10%   /  (defaults, server/holder-tiers.js)
//
// The tier is the referrer's currentTier (server/holders.js) at the moment
// the referred deposit is credited: the same rule, and the same 48-hour
// freshness, as every other Holder Program perk. The rate used is written
// into the reward's ledger description, and a reversal or reinstatement
// moves exactly the amount first recorded, so a later tier change never
// alters a reward already paid.

// The boost applies once its update and the Holder Program are released,
// tier percents are set and referral rewards are on (REFERRAL_PERCENT > 0).
export const boostLive = (cfg) =>
  isReleased(cfg, "referralboost") &&
  programLive(cfg) &&
  !!referralTierRates(cfg);

// Each tier's effective percent (never below the base), or null.
export const tierRates = (cfg) =>
  boostLive(cfg) ? referralTierRates(cfg) : null;

// The rate a referrer earns right now: { percent, base, tier }, where tier
// is { id, name } only when it raises the rate above the base. Null when
// the boost isn't live, so rewards stay exactly as they were before it.
export function referralRate(cfg, referrer, t = now()) {
  const rates = tierRates(cfg);
  if (!rates) return null;
  const base = cfg.referralPercent;
  const tier = currentTier(cfg, referrer, t);
  const percent = tier ? rates[tier.id] : base;
  return {
    percent,
    base,
    tier: tier && percent > base ? { id: tier.id, name: tier.name } : null,
  };
}

// What recordPayment and recordWalletPayment (server/payments.js) take to
// pay a referral reward: the base percent and, while the boost is live,
// the referrer's rate at the moment of crediting.
export const referralOptions = (cfg) => ({
  referralPercent: cfg.referralPercent,
  referralRate: (referrer) => referralRate(cfg, referrer),
});

// For GET /api/referrals: this account's own current rate and every tier's,
// or nothing at all while the boost isn't live.
export function referralBoostFor(cfg, user, t = now()) {
  const rate = referralRate(cfg, user, t);
  if (!rate) return {};
  const rates = tierRates(cfg);
  return {
    rate: {
      percent: rate.percent,
      base: rate.base,
      tier: rate.tier?.id ?? null,
    },
    boost: {
      base: rate.base,
      tiers: holderTiers(cfg).map(({ id, name, min }) => ({
        id,
        name,
        min,
        percent: rates[id],
      })),
    },
  };
}
