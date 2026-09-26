// The NYMA Holder Program's settings: three tiers, the credits each earns
// every 30-day cycle, each tier's perk and the Loyal bonus. Plain data with
// no imports, so config() (server/core.js) and the program itself
// (server/holders.js) share it without an import cycle.

// Ledger subcredits per displayed credit (see credits() in server/core.js).
export const CREDIT_UNITS = 10_000;
export const CYCLE_DAYS = 30;

// Perks are cumulative: each tier also gets every perk below it.
export const TIERS = [
  { id: "holder", name: "Holder", perk: "library" },
  { id: "insider", name: "Insider", perk: "early" },
  { id: "inner", name: "Inner Circle", perk: "vote" },
];

// "min:credits" per tier, lowest first. An amount of 0 turns that tier's
// credits off; all three at 0 turns the credit rewards off.
export const DEFAULT_HOLDER_REWARDS =
  "1000000:2000,5000000:15000,25000000:100000";
// "cycles:multiplier": after that many paid cycles in a row, each later
// payout is multiplied, until a cycle ends unpaid.
export const DEFAULT_HOLDER_LOYALTY = "3:1.5";

const NUMBER = /^\d+(\.\d+)?$/;

export function parseHolderRewards(value) {
  const text = String(value ?? "").trim() || DEFAULT_HOLDER_REWARDS;
  const pairs = text.split(",").map((pair) => pair.split(":").map((s) => s.trim()));
  if (
    pairs.length !== TIERS.length ||
    pairs.some((p) => p.length !== 2 || !NUMBER.test(p[0]) || !NUMBER.test(p[1]))
  )
    throw Error(
      `HOLDER_REWARDS must be three min:credits pairs, lowest tier first, e.g. "${DEFAULT_HOLDER_REWARDS}".`,
    );
  let previous = 0;
  return pairs.map(([minText, creditsText], i) => {
    const min = Number(minText),
      credits = Number(creditsText),
      units = Math.round(credits * CREDIT_UNITS);
    if (!Number.isFinite(min) || min <= previous)
      throw Error("HOLDER_REWARDS tier minimums must be positive and increasing.");
    if (
      !Number.isSafeInteger(units) ||
      Math.abs(units - credits * CREDIT_UNITS) > 1e-6
    )
      throw Error(
        "HOLDER_REWARDS credits must be whole credits or have at most four decimals.",
      );
    previous = min;
    return { ...TIERS[i], min, credits, units };
  });
}

export function parseHolderLoyalty(value) {
  const text = String(value ?? "").trim() || DEFAULT_HOLDER_LOYALTY;
  const [after, multiplier] = text.split(":").map((s) => s.trim());
  if (
    !/^\d+$/.test(after ?? "") ||
    !NUMBER.test(multiplier ?? "") ||
    Number(after) < 1 ||
    Number(multiplier) < 1 ||
    Number(multiplier) > 10
  )
    throw Error(
      `HOLDER_LOYALTY must be "cycles:multiplier" with at least 1 cycle and a multiplier from 1 to 10, e.g. "${DEFAULT_HOLDER_LOYALTY}".`,
    );
  return { after: Number(after), multiplier: Number(multiplier) };
}

// Everything the Holder Program pays is off when every tier's amount is 0.
export const rewardsOn = (tiers) => tiers.some((t) => t.units > 0);

// Referral Boost (server/referral-boost.js): the referral percent a
// referrer at each tier earns on a referred account's credited deposits,
// instead of the base REFERRAL_PERCENT. "tier:percent" for all three tiers.
// Unset: these defaults. Empty (or "off"): no boost, everyone earns the base.
export const DEFAULT_HOLDER_REFERRAL_PERCENTS = "holder:6,insider:7.5,inner:10";
const PERCENT = /^\d{1,2}(\.\d{1,2})?$/;

// Returns { holder, insider, inner } percents, or null when the boost is
// off. Like REFERRAL_PERCENT, each is from 0 to 50; at most two decimals, so
// a rate is a whole number of basis points. A higher tier never earns less
// than the one below it. Set explicitly, no tier may be below `base` (the
// REFERRAL_PERCENT); the defaults never lower anyone either, since a tier's
// rate is never below the base (boostedRates).
export function parseHolderReferralPercents(value, base) {
  const usingDefault = value === undefined || value === null;
  const text = usingDefault
    ? DEFAULT_HOLDER_REFERRAL_PERCENTS
    : String(value).trim();
  if (!text || text.toLowerCase() === "off") return null;
  const ids = TIERS.map((t) => t.id);
  const rates = {};
  for (const pair of text.split(",")) {
    const [id, percent, ...rest] = pair
      .split(":")
      .map((s) => s.trim().toLowerCase());
    const number = String(percent ?? "").replace(/%$/, "");
    if (rest.length || !ids.includes(id) || !PERCENT.test(number))
      throw Error(
        `HOLDER_REFERRAL_PERCENTS must be tier:percent for holder, insider and inner, e.g. "${DEFAULT_HOLDER_REFERRAL_PERCENTS}", or empty (or off) for no boost.`,
      );
    if (Object.hasOwn(rates, id))
      throw Error(`HOLDER_REFERRAL_PERCENTS lists ${id} more than once.`);
    rates[id] = Number(number);
  }
  const missing = ids.filter((id) => !Object.hasOwn(rates, id));
  if (missing.length)
    throw Error(
      `HOLDER_REFERRAL_PERCENTS needs a percent for every tier; missing: ${missing.join(", ")}.`,
    );
  if (ids.some((id) => rates[id] > 50))
    throw Error(
      "HOLDER_REFERRAL_PERCENTS: each tier's percent must be between 0 and 50.",
    );
  if (ids.some((id, i) => i > 0 && rates[id] < rates[ids[i - 1]]))
    throw Error(
      "HOLDER_REFERRAL_PERCENTS: a higher tier's percent can't be below the tier under it.",
    );
  if (
    !usingDefault &&
    Number.isFinite(base) &&
    ids.some((id) => rates[id] < base)
  )
    throw Error(
      `HOLDER_REFERRAL_PERCENTS: each tier's percent must be at least REFERRAL_PERCENT (${base}).`,
    );
  return Object.freeze(rates);
}

// Each tier's effective referral percent, never below the base: or null
// when there's no boost (off, or REFERRAL_PERCENT 0, which turns every
// referral reward off, boosted ones included).
export function boostedRates(rates, base) {
  if (!rates || !(base > 0)) return null;
  return Object.fromEntries(
    TIERS.map((t) => [t.id, Math.max(base, rates[t.id])]),
  );
}
// The same from a config: its parsed HOLDER_REFERRAL_PERCENTS (the
// defaults when a config has none) and its REFERRAL_PERCENT.
export const referralTierRates = (cfg) =>
  boostedRates(
    cfg?.holderReferralPercents === undefined
      ? parseHolderReferralPercents(undefined)
      : cfg.holderReferralPercents,
    cfg?.referralPercent,
  );

// Retention caps, and the doubled caps of the Holder tier's "Bigger
// library" perk. Every place that prunes uses retentionCaps in
// server/holders.js to pick one or the other per account.
export const BASE_CAPS = Object.freeze({
  conversations: 300,
  symposium: 150,
  image: 100,
  video: 60,
  audio: 60,
});
export const HOLDER_CAPS = Object.freeze(
  Object.fromEntries(Object.entries(BASE_CAPS).map(([k, v]) => [k, v * 2])),
);
