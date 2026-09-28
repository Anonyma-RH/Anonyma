// Low-Balance Alerts: the rules the server (validation) and the browser (the
// banner and the optional notification) share. No DOM and no network here.
//
// The alert watches the account's *available* balance: its credits minus
// every hold still open, as server/core.js balance() reports it (and as the
// workspace header shows it). It is not a Spending Limit: a limit caps what
// can be spent even with credits left; this only says the balance is low.
// Team Treasury balances are the team's, not the account's, and aren't
// watched.
//
// The server stores the alert level in integer subcredits (10,000 per
// credit, like the ledger); the API and the browser use credits with at
// most four decimals. Nothing here writes the ledger or holds anything.

export const UNITS_PER_CREDIT = 10000;
// Offered when the alert is turned on. One long reply from a frontier model
// can hold well over 100 credits while it runs, so 100 would warn too late.
export const SUGGESTED_CREDITS = 500;
export const MIN_CREDITS = 1;
export const MAX_CREDITS = 1_000_000_000;
export const THRESHOLD_RULE =
  "Set the alert level in credits, from 1 to 1,000,000,000 with at most four decimals.";

export const toUnits = (credits) =>
  Math.round(Number(credits) * UNITS_PER_CREDIT);

// Whether `value` (a JSON number of credits) can be stored as an alert level.
export function validThreshold(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  if (value < MIN_CREDITS || value > MAX_CREDITS) return false;
  // At most four decimals: a whole number of subcredits.
  return Math.abs(value * UNITS_PER_CREDIT - toUnits(value)) < 1e-6;
}

// The alert level typed into the Account panel, as a number of credits, or
// null when it isn't one the server would accept.
export function parseThreshold(text) {
  const clean = String(text ?? "")
    .trim()
    .replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) return null;
  const value = Number(clean);
  return validThreshold(value) ? value : null;
}

// ---- The banner ----
//
// Bands of the available balance under the alert level L:
//   0  at or above L (no banner)
//   1  below L
//   2  below half of L
//   3  below a quarter of L
//   4  nothing available at all
// A dismissed banner stays away for the rest of that local day, unless the
// balance falls into a lower band than the one it was dismissed in. Getting
// back to L or above (a top-up) forgets the dismissal, so the next drop
// below L shows it again. All amounts here are integer subcredits.
export function bandOf(available, threshold) {
  if (!(threshold > 0) || !(available < threshold)) return 0;
  if (available <= 0) return 4;
  if (available * 4 < threshold) return 3;
  if (available * 2 < threshold) return 2;
  return 1;
}
const pad = (n) => String(n).padStart(2, "0");
// The viewer's own calendar day, "2026-09-25".
export function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// What this browser remembers per account (localStorage, never the server):
// { dismissed: { threshold, band, day } | null, notified: { threshold } | null }.
export const EMPTY_MEMORY = Object.freeze({ dismissed: null, notified: null });
export function cleanMemory(value) {
  const m = value && typeof value === "object" ? value : {};
  const d = m.dismissed;
  const n = m.notified;
  return {
    dismissed:
      d &&
      Number.isSafeInteger(d.threshold) &&
      Number.isInteger(d.band) &&
      typeof d.day === "string"
        ? { threshold: d.threshold, band: d.band, day: d.day }
        : null,
    notified:
      n && Number.isSafeInteger(n.threshold) ? { threshold: n.threshold } : null,
  };
}

// The banner to show now, or null: { band, empty }.
export function bannerFor({ threshold, available, memory, at }) {
  const band = bandOf(available, threshold);
  if (!band) return null;
  const d = memory?.dismissed;
  if (
    d &&
    d.threshold === threshold &&
    d.day === localDay(at) &&
    band <= d.band
  )
    return null;
  return { band, empty: band === 4 };
}
export function dismissBanner(memory, { threshold, available, at }) {
  return {
    ...cleanMemory(memory),
    dismissed: {
      threshold,
      band: bandOf(available, threshold),
      day: localDay(at),
    },
  };
}
// After the app sees the balance: at or above the alert level again, the
// dismissal and the notification are both forgotten (re-armed).
export function observe(memory, { threshold, available }) {
  const m = cleanMemory(memory);
  if (!(threshold > 0) || available < threshold) return m;
  return m.dismissed || m.notified ? { ...EMPTY_MEMORY } : m;
}

// ---- The browser notification ----
//
// One notification when this tab sees the available balance cross from at
// or above the alert level to below it, and only if the account asked for
// notifications and this browser granted permission. Not on page load (no
// crossing was seen), not again until the balance is back above the level
// (the `notified` memory is shared by every tab of this browser), and never
// from a background server push: this version has none.
export function shouldNotify({
  previous,
  available,
  threshold,
  notify,
  permission,
  memory,
}) {
  return (
    notify === true &&
    permission === "granted" &&
    threshold > 0 &&
    Number.isFinite(previous) &&
    previous >= threshold &&
    available < threshold &&
    !memory?.notified
  );
}
export function notifiedMemory(memory, threshold) {
  return { ...cleanMemory(memory), notified: { threshold } };
}

// Credits as the app shows them: never rounded up to look larger.
export function showCredits(value) {
  const n = Math.max(0, Number(value) || 0);
  return (Math.floor(n * 100) / 100).toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}
export function notificationText({ available, threshold }) {
  return {
    title: "Low balance on ANONYMA",
    body:
      available <= 0
        ? "No credits available. Top up to keep going."
        : `${showCredits(available)} credits available, below your alert at ${showCredits(threshold)} credits.`,
  };
}

// A refusal because the balance can't cover a request (402
// insufficient_credits), from its message: the server's, or Symposium's own.
// A spending-limit refusal ("…your daily spending limit…") never matches.
export const isInsufficientMessage = (text) =>
  /^Not enough (available )?credits\b/.test(String(text || ""));
