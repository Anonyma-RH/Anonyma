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
