import { fail } from "./core.js";
import { isReleased } from "./releases.js";

// Usage Insights & Export (update "insights"): where an account's credits
// went, from its own ledger, and a file of those same ledger rows.
//
// Everything here is integer subcredits (10,000 per credit, 10,000,000 per
// USD) until the last step, which writes exact decimal strings; no amount is
// ever a float. Days are UTC days. Only the account's own ledger counts:
// "Team pays" requests settle on a Team Treasury's ledger, so they're totalled
// apart and never exported as the account's own rows. Nothing reads prompts,
// replies, media or conversation content.

export const DAY = 86400000;
export const MAX_RANGE_DAYS = 366;
// An export is complete or refused, never cut short: a range with more rows
// than this is refused with a count so a shorter range can be chosen.
export const MAX_EXPORT_ROWS = 100000;
const PAGE = 1000;

// ---- Exact decimals ----

// A safe integer of subunits as a signed decimal string with `places`
// decimals: 12345 at 4 places is "1.2345", -5 is "-0.0005", 0 is "0.0000".
export function decimal(units, places) {
  if (!Number.isSafeInteger(units))
    throw Error("Amounts must be safe integers.");
  const scale = 10n ** BigInt(places);
  const big = BigInt(units);
  const abs = big < 0n ? -big : big;
  return (
    (big < 0n ? "-" : "") +
    (abs / scale).toString() +
    "." +
    (abs % scale).toString().padStart(places, "0")
  );
}
// 1 credit = 10,000 subcredits; 1 USD = 1,000 credits = 10,000,000 subcredits.
export const creditString = (units) => decimal(units, 4);
export const usdString = (units) => decimal(units, 7);
export const money = (units) => ({
  units,
  credits: creditString(units),
  usd: usdString(units),
});
// The inverse, for tests and reconciliation: "-1.2345" credits → -12345.
export function parseCredits(text) {
  const m = /^(-?)(\d+)\.(\d{4})$/.exec(String(text));
  if (!m) throw Error(`Not an exact credit amount: ${text}`);
  const n = Number(m[2]) * 10000 + Number(m[3]);
  return m[1] ? -n : n;
}

// ---- Ranges (UTC days) ----

const isoDay = (day) => new Date(day * DAY).toISOString().slice(0, 10);
function dayNumber(text) {
  if (typeof text !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(text))
    return null;
  const t = Date.parse(text + "T00:00:00.000Z");
  // Rejects dates that don't exist (2026-02-30 would parse as March 2).
  if (!Number.isFinite(t) || isoDay(t / DAY) !== text) return null;
  return t / DAY;
}
// ?from=YYYY-MM-DD&to=YYYY-MM-DD (UTC days, both inclusive), or ?days=N
// ending today (UTC); 30 days when neither is given. At most 366 days, and
// never past today. `start` and `end` are epoch ms, end exclusive.
export function usageRange(query = {}, at = Date.now()) {
  const today = Math.floor(at / DAY);
  const { from, to, days } = query;
  let first, last;
  if (from !== undefined || to !== undefined) {
    first = dayNumber(from);
    last = dayNumber(to);
    if (first == null || last == null)
      fail(
        400,
        "Send both from and to as UTC dates (YYYY-MM-DD).",
        "invalid_range",
      );
    if (days !== undefined)
      fail(400, "Send either from and to, or days, not both.", "invalid_range");
  } else {
    const n = days === undefined ? 30 : Number(days);
    if (
      typeof (days ?? "30") !== "string" ||
      !Number.isInteger(n) ||
      n < 1 ||
      n > MAX_RANGE_DAYS
    )
      fail(
        400,
        `days must be a whole number from 1 to ${MAX_RANGE_DAYS}.`,
        "invalid_range",
      );
    last = today;
    first = today - n + 1;
  }
  if (first > last) fail(400, "from must be on or before to.", "invalid_range");
  if (last > today)
    fail(
      400,
      `to can't be after today's UTC date (${isoDay(today)}).`,
      "invalid_range",
    );
  if (last - first + 1 > MAX_RANGE_DAYS)
    fail(
      400,
      `Choose a range of at most ${MAX_RANGE_DAYS} days.`,
      "range_too_long",
    );
  return {
    from: isoDay(first),
    to: isoDay(last),
    days: last - first + 1,
    timezone: "UTC",
    start: first * DAY,
    end: (last + 1) * DAY,
  };
}

// ---- What each ledger row is ----

// Ledger kinds that aren't request charges. Anything else tied to one of the
// account's own holds is a settled request ("spend"); the rest is "other".
const CATEGORY = {
  deposit: "topup",
  test_credit: "topup",
  payment_correction: "topup",
  transfer_out: "sent",
  transfer_in: "received",
  referral: "reward",
  referral_correction: "reward",
  holder_reward: "reward",
  treasury_contribution: "team",
  treasury_withdrawal: "team",
  treasury_return: "team",
};
export const CATEGORIES = [
  "spend",
  "topup",
  "sent",
  "received",
  "reward",
  "team",
  "other",
];
export function categoryOf(kind, holdKind, amount) {
  return CATEGORY[kind] ?? (holdKind != null && amount < 0 ? "spend" : "other");
}
// Chat labels recorded in usage_tags when the request was reserved.
export const CHAT_FEATURES = [
  "chat",
  "web_search",
  "symposium",
  "double_check",
  "blind",
];
// What a settled request was for: the hold's kind, the chat label recorded
// for it (a chat from before labels were recorded counts as chat), and for
// audio the server-written description ("Speech: …" / "Transcription: …").
export function featureOf(holdKind, tagFeature, description) {
  if (holdKind === "chat")
    return CHAT_FEATURES.includes(tagFeature) ? tagFeature : "chat";
  if (holdKind === "audio") {
    const d = String(description || "");
    if (d.startsWith("Speech: ")) return "speech";
    if (d.startsWith("Transcription: ")) return "transcription";
    return "audio";
  }
  return holdKind || "other";
}
// Settlement descriptions are written by the server: the model's name, with
// one of these prefixes for policy charges and audio (see settle() callers).
const PREFIXES = [
  "Timeout policy: ",
  "Unreadable response policy: ",
  "Interrupted: ",
  "Stopped before output: ",
  "Recovered image batch: ",
  "Reconciled: ",
  "Speech: ",
  "Transcription: ",
];
export function recordedModel(holdKind, modelId, description) {
  const id = typeof modelId === "string" && modelId ? modelId : null;
  const d = String(description || "");
  // Video settles with the model id as its description.
  if (holdKind === "video") return { id: id || d || null, name: null };
  const prefix = PREFIXES.find((p) => d.startsWith(p));
  return { id, name: (prefix ? d.slice(prefix.length) : d) || null };
}
const sourceOf = (key) =>
  !key ? "web" : key.connection_id ? "connected_app" : "api_key";

// ---- Labels written while the update is released ----

export const FEATURE_TAG_SQL =
  "INSERT OR IGNORE INTO usage_tags(hold_id,feature,model) VALUES(?,?,?)";
// The label a chat request's spend is filed under. Off the record and in
// Private Mode only what billing already reflects is kept (the model and the
// web-search fee), never which kind of conversation it was.
export function chatFeature({ api, ephemeral, body = {}, webSearch }) {
  if (!api && !ephemeral) {
    if (body.double_check != null) return "double_check";
    if (body.mode === "symposium") return "symposium";
  }
  return webSearch ? "web_search" : "chat";
}
// Best effort and content-free: a label must never cost anyone a request.
export function tagUsage(db, cfg, hold, { feature, model }) {
  if (!isReleased(cfg, "insights")) return;
  try {
    db.prepare(FEATURE_TAG_SQL).run(hold, feature, model ?? null);
  } catch (e) {
    console.error("Usage label not saved:", e.message);
  }
}

// ---- Aggregates ----

// The account's keys and connected apps, by key id, for labels.
function keysOf(db, user) {
  return new Map(
    db
      .prepare(
        "SELECT id,name,revoked,connection_id FROM api_keys WHERE user_id=?",
      )
      .all(user)
      .map((k) => [k.id, k]),
  );
}
// Aliases never match a column name, so GROUP BY can't mean a column.
const GROUPS = `
  SELECT (l.created/${DAY}) AS g_day, l.kind AS g_kind, h.kind AS g_hold_kind,
    t.feature AS g_feature,
    COALESCE(t.model, CASE WHEN json_valid(h.result) THEN json_extract(h.result,'$.model') END) AS g_model,
    CASE WHEN h.id IS NULL THEN NULL ELSE l.description END AS g_description,
    CASE WHEN h.id IS NULL THEN NULL ELSE l.key_id END AS g_key,
    SUM(l.amount) AS g_units, COUNT(*) AS g_entries
  FROM ledger l
  LEFT JOIN holds h ON h.id=l.ref AND h.user_id=l.user_id
  LEFT JOIN usage_tags t ON t.hold_id=h.id
  WHERE l.user_id=? AND l.created>=? AND l.created<?
  GROUP BY g_day, g_kind, g_hold_kind, g_feature, g_model, g_description, g_key`;

// Totals, a daily series and breakdowns for a range, all from the same
// grouped integer sums, so every figure adds up to the ledger's net change.
// `modelName(id)` names a model from the live catalog when the ledger only
// recorded its id.
export function usageSummary(db, user, range, { modelName = () => null } = {}) {
  const totals = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
  let net = 0,
    entries = 0,
    requests = 0;
  const firstDay = range.start / DAY;
  const daily = Array.from({ length: range.days }, (_, i) => ({
    date: isoDay(firstDay + i),
    units: 0,
    requests: 0,
  }));
  const features = new Map(),
    sources = new Map(),
    models = [];
  const keys = keysOf(db, user);
  for (const row of db.prepare(GROUPS).all(user, range.start, range.end)) {
    const g = {
      day: row.g_day,
      kind: row.g_kind,
      hold_kind: row.g_hold_kind,
      tag_feature: row.g_feature,
      model_id: row.g_model,
      description: row.g_description,
      key_id: row.g_key,
      units: row.g_units,
      entries: row.g_entries,
    };
    const category = categoryOf(g.kind, g.hold_kind, g.units);
    net += g.units;
    entries += g.entries;
    totals[category] += g.units;
    if (category !== "spend") continue;
    const spent = -g.units;
    requests += g.entries;
    const day = daily[g.day - firstDay];
    if (day) {
      day.units += spent;
      day.requests += g.entries;
    }
    const feature = featureOf(g.hold_kind, g.tag_feature, g.description);
    const f = features.get(feature) || { feature, units: 0, requests: 0 };
    f.units += spent;
    f.requests += g.entries;
    features.set(feature, f);
    const key = g.key_id ? keys.get(g.key_id) : null;
    const source = sourceOf(g.key_id ? key || { id: g.key_id } : null);
    const sourceId = g.key_id || "web";
    const s = sources.get(sourceId) || {
      source,
      id: g.key_id || null,
      label: key?.name ?? null,
      revoked: !!key?.revoked,
      units: 0,
      requests: 0,
    };
    s.units += spent;
    s.requests += g.entries;
    sources.set(sourceId, s);
    models.push({
      ...recordedModel(g.hold_kind, g.model_id, g.description),
      units: spent,
      requests: g.entries,
    });
  }
  // One row per model. A charge recorded by name only (an interrupted chat
  // from before labels were kept) joins the model that the same name was
  // recorded with elsewhere in this range.
  const idByName = new Map();
  for (const m of models) if (m.id && m.name) idByName.set(m.name, m.id);
  const byModel = new Map();
  for (const m of models) {
    const id = m.id || (m.name ? idByName.get(m.name) : null) || null;
    const label = m.name || (id && modelName(id)) || id || "Unrecorded model";
    const k = id ? "id:" + id : "name:" + label;
    const row = byModel.get(k) || { model: label, id, units: 0, requests: 0 };
    row.units += m.units;
    row.requests += m.requests;
    if (m.name && row.model === id) row.model = m.name;
    byModel.set(k, row);
  }
  const sorted = (list) =>
    [...list].sort(
      (a, b) =>
        b.units - a.units ||
        b.requests - a.requests ||
        String(a.model ?? a.feature ?? a.label ?? "").localeCompare(
          String(b.model ?? b.feature ?? b.label ?? ""),
        ),
    );
  const withMoney = ({ units, ...rest }) => ({ ...rest, spent: money(units) });
  const held = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) units, COUNT(*) n FROM holds WHERE user_id=? AND status='held'",
    )
    .get(user);
  const team = db
    .prepare(
      `SELECT COALESCE(SUM(-l.amount),0) units, COUNT(*) n
       FROM treasury_spends s JOIN holds h ON h.id=s.hold_id
       JOIN ledger l ON l.ref=h.id AND l.user_id=h.user_id
       WHERE s.user_id=? AND l.amount<0 AND l.created>=? AND l.created<?`,
    )
    .get(user, range.start, range.end);
  return {
    range: {
      from: range.from,
      to: range.to,
      days: range.days,
      timezone: "UTC",
      start: new Date(range.start).toISOString(),
      end: new Date(range.end).toISOString(),
    },
    units: {
      credits: "1 credit = 10,000 subcredits",
      usd: "1 USD = 1,000 credits = 10,000,000 subcredits",
    },
    totals: {
      spent: money(-totals.spend),
      topups: money(totals.topup),
      sent: money(-totals.sent),
      received: money(totals.received),
      rewards: money(totals.reward),
      team_transfers: money(totals.team),
      other: money(totals.other),
      net: money(net),
      requests,
      entries,
    },
    // Right now, not for the range: reserved for requests still running.
    held: { ...money(held.units), requests: held.n },
    // Charged to a Team Treasury, not to this account's balance, so not in
    // the totals above, the breakdowns or the export.
    team_paid: { ...money(team.units), requests: team.n },
    daily: daily.map(({ units, ...d }) => ({ ...d, spent: money(units) })),
    by_model: sorted(byModel.values()).map(withMoney),
    by_feature: sorted(features.values()).map(withMoney),
    by_source: sorted(sources.values()).map(withMoney),
  };
}

// ---- Export ----

export const EXPORT_COLUMNS = [
  "timestamp_utc",
  "entry_id",
  "type",
  "category",
  "credits",
  "usd",
  "subcredits",
  "model",
  "feature",
  "source",
  "key_or_app",
  "receipt_id",
  "ledger_ref",
  "description",
];
const ROWS = `
  SELECT l.rowid AS rowid, l.id, l.amount, l.kind, l.ref, l.key_id, l.description, l.created,
    h.kind AS hold_kind, t.feature AS tag_feature,
    COALESCE(t.model, CASE WHEN json_valid(h.result) THEN json_extract(h.result,'$.model') END) AS model_id,
    k.name AS key_name, k.connection_id,
    r.receipt_id AS signed
  FROM ledger l
  LEFT JOIN holds h ON h.id=l.ref AND h.user_id=l.user_id
  LEFT JOIN usage_tags t ON t.hold_id=h.id
  LEFT JOIN api_keys k ON k.id=l.key_id AND k.user_id=l.user_id
  LEFT JOIN receipt_signatures r ON r.receipt_id=l.ref AND r.user_id=l.user_id
  WHERE l.user_id=? AND l.created>=? AND l.created<?
    AND (l.created>? OR (l.created=? AND l.rowid>?))
  ORDER BY l.created, l.rowid LIMIT ${PAGE}`;
export const countRows = (db, user, start, end) =>
  db
    .prepare(
      "SELECT COUNT(*) n FROM ledger WHERE user_id=? AND created>=? AND created<?",
    )
    .get(user, start, end).n;
// The account's ledger rows in [start, end), oldest first, a page at a time
// (keyset paging on created and rowid, so no long-lived statement is held).
export function* exportRows(db, user, start, end) {
  let created = start - 1,
    rowid = 0;
  const page = db.prepare(ROWS);
  for (;;) {
    const rows = page.all(user, start, end, created, created, rowid);
    for (const r of rows) yield exportEntry(user, r);
    if (rows.length < PAGE) return;
    ({ created, rowid } = rows.at(-1));
  }
}
function exportEntry(user, r) {
  const category = categoryOf(r.kind, r.hold_kind, r.amount);
  const spend = category === "spend";
  const model = spend
    ? recordedModel(r.hold_kind, r.model_id, r.description)
    : null;
  return {
    timestamp_utc: new Date(r.created).toISOString(),
    entry_id: r.id,
    type: r.kind,
    category,
    credits: creditString(r.amount),
    usd: usdString(r.amount),
    subcredits: r.amount,
    model: model ? model.id || model.name : null,
    feature: spend
      ? featureOf(r.hold_kind, r.tag_feature, r.description)
      : null,
    source: spend
      ? sourceOf(r.key_id ? { connection_id: r.connection_id } : null)
      : null,
    key_or_app: r.key_id ? (r.key_name ?? null) : null,
    // A signed receipt is fetched by its request id (GET /api/receipts/{id}),
    // which is the hold id without the account prefix.
    receipt_id:
      r.signed && r.ref.startsWith(user + ":")
        ? r.ref.slice(user.length + 1)
        : null,
    ledger_ref: r.ref,
    description: r.description ?? null,
  };
}

// CSV (RFC 4180, CRLF) that a spreadsheet can't run: a text cell that starts
// with = + - @, a tab or a line break (or their full-width forms) gets a
// leading apostrophe so it's read as text, not a formula. Numbers written by
// this module are plain decimals and stay numbers.
const NUMERIC = /^-?\d+(\.\d+)?$/;
const FORMULA = /^[=+\-@\t\r\n＝＋－＠]/;
export function csvCell(value) {
  if (value == null) return "";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw Error("Only integers are written.");
    return String(value);
  }
  let s = String(value);
  if (NUMERIC.test(s)) return s;
  if (FORMULA.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
export const csvLine = (values) => values.map(csvCell).join(",") + "\r\n";
