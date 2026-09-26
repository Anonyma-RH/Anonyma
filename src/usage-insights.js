// Usage Insights & Export (update "insights"): pure helpers for the Account
// → Usage view. Amounts arrive from the server as exact decimal strings and
// integer subcredits (server/usage-insights.js); nothing here does float math
// on money. Bars are sized from integer subcredits, labels from the strings.

export const RANGES = [7, 30, 90];
export const MAX_RANGE_DAYS = 366;
const DAY = 86400000;

// What a settled request was for, and where it came from.
export const FEATURE_LABELS = {
  chat: "Chat",
  web_search: "Web search",
  symposium: "Symposium",
  double_check: "Double-check",
  blind: "Blind Compare",
  image: "Images",
  video: "Video",
  speech: "Text to speech",
  transcription: "Transcription",
  audio: "Audio",
  sealed: "Sealed Mode",
  other: "Other",
};
export const SOURCE_LABELS = {
  web: "Workspace",
  api_key: "API key",
  connected_app: "Connected app",
};
export const featureLabel = (id) =>
  FEATURE_LABELS[id] ||
  String(id || "other")
    .replace(/_/g, " ")
    .replace(/^./, (c) => c.toUpperCase());

// "12345.6700" → "12,345.67"; "-0.0709" → "-0.0709"; "0.0000" → "0". Exact:
// trailing zeros go, nothing is rounded.
export function formatAmount(text) {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text ?? ""));
  if (!m) return String(text ?? "");
  const whole = m[2].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (m[3] || "").replace(/0+$/, "");
  const sign = m[1] && (m[2] !== "0" || frac) ? "-" : "";
  return sign + whole + (frac ? "." + frac : "");
}
// A credits string without its sign, for totals shown as magnitudes.
export const magnitude = (text) => String(text ?? "").replace(/^-/, "");
export const plural = (n, one, many) =>
  `${Number(n).toLocaleString("en-US")} ${n === 1 ? one : many}`;

// UTC calendar dates for the last `days` days, today included.
export const utcDate = (t) => new Date(t).toISOString().slice(0, 10);
export function lastDays(days, at = Date.now()) {
  const today = Math.floor(at / DAY);
  return { from: utcDate((today - days + 1) * DAY), to: utcDate(today * DAY) };
}
export function spanDays(from, to) {
  const a = Date.parse(from + "T00:00:00Z"),
    b = Date.parse(to + "T00:00:00Z");
  return Number.isFinite(a) && Number.isFinite(b) ? (b - a) / DAY + 1 : NaN;
}
// Client-side check before asking the server (which checks again).
export function exportRangeError(from, to, at = Date.now()) {
  const span = spanDays(from, to);
  if (!Number.isFinite(span)) return "Choose both dates.";
  if (span < 1) return "The start date must be on or before the end date.";
  if (to > utcDate(at)) return "The end date can't be after today (UTC).";
  if (span > MAX_RANGE_DAYS) return "Choose a range of at most 366 days.";
  return "";
}
export const exportUrl = (format, from, to) =>
  `/api/account/usage/export?format=${format}&from=${from}&to=${to}`;
// "09-25" under a bar: numbers only, the same in every language.
export const shortDate = (iso) => iso.slice(5);

// Integer subcredits → the server's { units, credits, usd } for sample data.
function sampleMoney(units) {
  const abs = Math.abs(units);
  const sign = units < 0 ? "-" : "";
  return {
    units,
    credits: `${sign}${Math.floor(abs / 10000)}.${String(abs % 10000).padStart(4, "0")}`,
    usd: `${sign}${Math.floor(abs / 10000000)}.${String(abs % 10000000).padStart(7, "0")}`,
  };
}
// Sample figures for ?demo=1: shaped exactly like GET /api/account/usage.
export function demoUsage(days = 30, at = Date.now()) {
  const today = Math.floor(at / DAY);
  const daily = Array.from({ length: days }, (_, i) => {
    const d = today - days + 1 + i;
    // A steady weekday rhythm with a few heavier days; integers only.
    const units =
      ((d * 7919) % 23) * 41000 + (d % 7 === 3 ? 1850000 : 0) + 120000;
    return {
      date: utcDate(d * DAY),
      requests: 3 + ((d * 31) % 9),
      spent: sampleMoney(units),
    };
  });
  const spent = daily.reduce((n, d) => n + d.spent.units, 0);
  const requests = daily.reduce((n, d) => n + d.requests, 0);
  const split = (parts) => {
    let left = spent;
    return parts.map(([share, row], i) => {
      const units =
        i === parts.length - 1 ? left : Math.floor((spent * share) / 100);
      left -= units;
      return { ...row, spent: sampleMoney(units) };
    });
  };
  const n = (share) => Math.max(1, Math.round((requests * share) / 100));
  return {
    sample: true,
    range: { ...lastDays(days, at), days, timezone: "UTC" },
    totals: {
      spent: sampleMoney(spent),
      topups: sampleMoney(250000000),
      sent: sampleMoney(5000000),
      received: sampleMoney(0),
      rewards: sampleMoney(0),
      team_transfers: sampleMoney(0),
      other: sampleMoney(0),
      net: sampleMoney(250000000 - 5000000 - spent),
      requests,
      entries: requests + 2,
    },
    held: { ...sampleMoney(84000), requests: 1 },
    team_paid: { ...sampleMoney(0), requests: 0 },
    daily,
    by_model: split([
      [
        46,
        { model: "Claude Sonnet 5", id: "claude-sonnet-5", requests: n(30) },
      ],
      [22, { model: "GPT-5.4 Mini", id: "gpt-5.4-mini", requests: n(25) }],
      [
        14,
        {
          model: "Nano Banana 2 (Gemini 3.1 Flash Image)",
          id: "google/gemini-3.1-flash-image",
          requests: n(10),
        },
      ],
      [10, { model: "Kimi K3 (Fast)", id: "kimi-k3-fast", requests: n(25) }],
      [8, { model: "Nova 3", id: "nova-3", requests: n(10) }],
    ]),
    by_feature: split([
      [52, { feature: "chat", requests: n(50) }],
      [16, { feature: "web_search", requests: n(12) }],
      [14, { feature: "image", requests: n(10) }],
      [10, { feature: "symposium", requests: n(18) }],
      [8, { feature: "transcription", requests: n(10) }],
    ]),
    by_source: split([
      [
        71,
        {
          source: "web",
          id: null,
          label: null,
          revoked: false,
          requests: n(70),
        },
      ],
      [
        21,
        {
          source: "api_key",
          id: "sample-key",
          label: "Research agent",
          revoked: false,
          requests: n(22),
        },
      ],
      [
        8,
        {
          source: "connected_app",
          id: "sample-app",
          label: "Notes app",
          revoked: false,
          requests: n(8),
        },
      ],
    ]),
  };
}

// Every fixed English string the Usage view renders, so the 中文 dictionary
// can be checked against it (tests/usage-insights.test.mjs). Dynamic text
// uses the patterns listed with a sample value.
export const UI_STRINGS = [
  "Usage",
  "Usage insights",
  "Where your credits went",
  "From your own ledger, exact to 0.0001 credit. Days are UTC days (00:00–24:00 UTC).",
  "Range",
  "Spent",
  "Top-ups",
  "Credits sent",
  "Credits received",
  "Held now",
  "Rewards",
  "Team Treasury transfers",
  "Settled requests",
  "Deposits, net of any reversals",
  "To other accounts",
  "From other accounts",
  "Reserved for requests still running",
  "Referral and holder rewards",
  "Into and out of Team Treasuries",
  "Credits spent per UTC day",
  "Nothing spent in this range.",
  "By model",
  "By feature",
  "By key or app",
  "No requests in this range.",
  "Revoked",
  "Unrecorded model",
  "Web search, Symposium and Double-check labels start with this release; earlier chat requests show as Chat. Off-the-record and Private chats are labelled only by model and web search.",
  "Export your ledger",
  "Every ledger entry in the range, oldest first: time (UTC), type, credits and USD (exact), model, feature, key or app, receipt ID and ledger reference. Never prompts or replies.",
  "From (UTC)",
  "To (UTC)",
  "Format",
  "Preparing file…",
  "Up to 366 days and 100,000 entries per file. Cells that a spreadsheet could run as a formula start with an apostrophe.",
  "Sign in to export your own ledger. The sample account has no ledger.",
  "Loading usage…",
  "Sample figures for the demo.",
  "Choose both dates.",
  "The start date must be on or before the end date.",
  "The end date can't be after today (UTC).",
  "Choose a range of at most 366 days.",
  "The export failed. Try again.",
  "Usage insights and export",
  "Export CSV",
  "Export JSON",
  ...Object.values(FEATURE_LABELS),
  ...Object.values(SOURCE_LABELS),
];
export const UI_PATTERNS = [
  ["{0} requests", "12 requests"],
  ["{0} request", "1 request"],
  [
    "Net change in this range: {0} credits",
    "Net change in this range: +12.5 credits",
  ],
  [
    "Team pays: {0} credits across {1} were charged to Team Treasuries, not your balance, so they're not counted above or exported.",
    "Team pays: 3.5 credits across 2 requests were charged to Team Treasuries, not your balance, so they're not counted above or exported.",
  ],
  ["{0} entries exported.", "25 entries exported."],
  ["{0} credits", "1.2 credits"],
];
