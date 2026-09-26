// Routines: a saved prompt that runs on a schedule with its own budget.
// Shared by the server (server/routines.js) and the page (src/Routines.jsx):
// the limits, the schedule math and the schedule's English description.
//
// A schedule is daily, weekdays (Monday to Friday) or weekly on one day, at
// a wall-clock time in an IANA time zone ("UTC" or e.g. "Europe/London").
// Days are counted in that zone, so "weekdays at 08:00 in Asia/Tokyo" runs
// Monday to Friday morning in Tokyo, whatever day it is in UTC.
//
// Daylight saving: a time the clocks skip (02:30 when they jump from 02:00
// to 03:00) runs at the same distance past the jump (03:30); a time that
// happens twice (01:30 when they fall back) runs once, the first time.

export const MAX_ROUTINES = 10;
export const KEEP_RUNS = 50;
export const NAME_LIMIT = 80;
export const PROMPT_LIMIT = 8000;
// Credits a routine may be given, per run and per calendar month.
export const MAX_RUN_CREDITS = 100_000;
export const MAX_BUDGET_CREDITS = 1_000_000;
// A run's reply budget in tokens: as large as the per-run maximum (and what
// is left of the month's budget) allows, from MIN_REPLY_TOKENS up to
// MAX_REPLY_TOKENS. Below the minimum the run is refused instead.
export const MIN_REPLY_TOKENS = 256;
export const MAX_REPLY_TOKENS = 4096;
export const REPEATS = ["daily", "weekdays", "weekly"];
export const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

const MINUTE = 60000;
const DAY = 86400000;

// ---- Time zones ----

const formatters = new Map();
function formatter(timeZone) {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}
// The zone's canonical name ("utc" → "UTC"), or null when it isn't a time
// zone this runtime knows.
export function canonicalZone(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(value))
    return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions()
      .timeZone;
  } catch {
    return null;
  }
}
// The wall clock in `timeZone` at the instant `ms`.
export function wallClock(timeZone, ms) {
  const v = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms)))
    if (p.type !== "literal") v[p.type] = Number(p.value);
  return {
    year: v.year,
    month: v.month,
    day: v.day,
    hour: v.hour % 24,
    minute: v.minute,
    second: v.second,
  };
}
// How many minutes the zone is ahead of UTC at the instant `ms`.
export function offsetMinutes(timeZone, ms) {
  const w = wallClock(timeZone, ms);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / MINUTE);
}
// The instant a wall-clock time happens in `timeZone` (month 1-12, minutes
// past midnight). Offsets are sampled a day either side, as Temporal does:
// one that maps back to itself is a real instant. Two are the repeated hour
// (the earlier wins); none is the skipped hour, which moves forward by the
// size of the jump.
export function zonedTime(timeZone, year, month, day, minutes) {
  const wall = Date.UTC(year, month - 1, day, 0, minutes);
  const before = offsetMinutes(timeZone, wall - DAY);
  const after = offsetMinutes(timeZone, wall + DAY);
  const real = [before, after]
    .map((o) => wall - o * MINUTE)
    .filter((t, i) => offsetMinutes(timeZone, t) === [before, after][i]);
  return real.length ? Math.min(...real) : wall - before * MINUTE;
}

// ---- Schedules ----

// { repeat, minute (0-1439), day (0-6, Sunday first; weekly only), timezone }
export const runsOn = (schedule, weekday) =>
  schedule.repeat === "daily" ||
  (schedule.repeat === "weekdays" && weekday >= 1 && weekday <= 5) ||
  (schedule.repeat === "weekly" && weekday === schedule.day);
// The schedule's run times on the local calendar days around `at`, in order.
function slotsAround(schedule, at, from, to) {
  const w = wallClock(schedule.timezone, at);
  const out = [];
  for (let i = from; i <= to; i++) {
    const date = new Date(Date.UTC(w.year, w.month - 1, w.day + i));
    if (!runsOn(schedule, date.getUTCDay())) continue;
    out.push(
      zonedTime(
        schedule.timezone,
        date.getUTCFullYear(),
        date.getUTCMonth() + 1,
        date.getUTCDate(),
        schedule.minute,
      ),
    );
  }
  return out;
}
// The first run time strictly after `after`.
export function nextRunAfter(schedule, after) {
  return slotsAround(schedule, after, -1, 8).find((t) => t > after) ?? null;
}
// The latest run time at or before `at`: the one slot a routine catches up
// on after downtime, however many it missed.
export function latestRunAtOrBefore(schedule, at) {
  return (
    slotsAround(schedule, at, -8, 1)
      .reverse()
      .find((t) => t <= at) ?? null
  );
}
// Run times in [from, to), counted up to `cap`: the missed runs skipped.
export function runsBetween(schedule, from, to, cap = 1000) {
  let n = 0;
  for (let t = from; t != null && t < to && n < cap; t = nextRunAfter(schedule, t))
    n++;
  return n;
}
// The calendar month containing `at` in the schedule's zone: its budget
// window.
export function monthWindow(timeZone, at) {
  const w = wallClock(timeZone, at);
  return {
    start: zonedTime(timeZone, w.year, w.month, 1, 0),
    end: zonedTime(
      timeZone,
      w.month === 12 ? w.year + 1 : w.year,
      w.month === 12 ? 1 : w.month + 1,
      1,
      0,
    ),
  };
}

// ---- Text ----

export const formatMinute = (m) =>
  String(Math.floor(m / 60)).padStart(2, "0") +
  ":" +
  String(m % 60).padStart(2, "0");
// "08:00" → 480; null for anything else.
export function parseTime(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ""));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
// "Weekdays at 08:00", "Every Monday at 08:00", "Every day at 08:00".
export function describeSchedule(schedule) {
  const time = formatMinute(schedule.minute);
  if (schedule.repeat === "weekdays") return `Weekdays at ${time}`;
  if (schedule.repeat === "weekly")
    return `Every ${DAY_NAMES[schedule.day]} at ${time}`;
  return `Every day at ${time}`;
}
