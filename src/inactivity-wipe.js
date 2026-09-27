// Inactivity Wipe: the rules the server (the setting, the activity clock and
// the worker, server/inactivity-wipe.js) and the browser (the Account section
// and the workspace banner, src/InactivityWipe.jsx) share. No DOM and no
// network here.
//
// Off until the account chooses a period. While it's on, the account's last
// activity is kept, and once the account has gone that long without any, the
// worker erases exactly what Panic Wipe erases (server/routes/wipe.js). The
// account and its credits stay. Times are milliseconds since the epoch; a
// "day" is 24 hours, so daylight-saving changes never move a deadline.

export const WIPE_DAYS = [30, 90, 180, 365];
export const DAY_MS = 86_400_000;
// Activity is written at most once an hour per account, so the recorded time
// can be up to this much older than the real last activity.
export const ACTIVITY_STEP_MS = 3_600_000;
// The in-app notice and the email reminder look at the last 7 days.
export const REMIND_DAYS = 7;
export const REMIND_MS = REMIND_DAYS * DAY_MS;

export const validDays = (days) => WIPE_DAYS.includes(days);

// When erasing becomes due: the chosen number of whole days after the last
// recorded activity, plus the hour a recorded time can lag behind, so it is
// never early, plus `paused`: time the server's worker wasn't running (the
// service down, or the update switched off), which never counts. The
// server's worker and every screen use this one formula.
export function deadlineOf(lastActive, days, paused = 0) {
  if (!Number.isFinite(lastActive) || !validDays(days)) return null;
  return lastActive + days * DAY_MS + ACTIVITY_STEP_MS + Math.max(0, Number(paused) || 0);
}
// When the email reminder is due: 7 days before the deadline.
export function remindAtOf(lastActive, days, paused = 0) {
  const deadline = deadlineOf(lastActive, days, paused);
  return deadline == null ? null : deadline - REMIND_MS;
}
// Whether `at` falls inside the last 7 days before the deadline (or past it).
export function nearDeadline(lastActive, days, at, paused = 0) {
  const remindAt = remindAtOf(lastActive, days, paused);
  return remindAt != null && at >= remindAt;
}
// Whole days from `at` until `deadline`, rounded down (the deadline's extra
// hour never shows as an extra day); 0 in its last day and once it's passed.
export function daysLeft(deadline, at) {
  if (!Number.isFinite(deadline) || !Number.isFinite(at)) return null;
  return Math.max(0, Math.floor((deadline - at) / DAY_MS));
}

// ---- Words ----

// The period, as the select and the status line say it.
export const periodLabel = (days) => `${days} days`;
export const daysLeftText = (n) =>
  n === 0 ? "less than a day" : n === 1 ? "1 day" : `${n} days`;

// What it erases: Panic Wipe's server-side list (src/panic-wipe.js), without
// what only a browser can clear. The Account section adds the items of
// updates that are live (projects, bookmarks and so on), as Panic Wipe does.
export const ERASES = [
  "All your chats and messages, including Symposium runs, branches and share links",
  "Saved images, videos and audio, and the files themselves",
  "Saved uploads and video jobs",
  "Memory facts, Scrolls and standing instructions",
  "Routines and their inbox",
  "Collabs you own, with everything shared in them",
  "Support requests you sent while signed in",
  "API keys and connected apps, revoked",
  "Every sign-in, on every device",
];
export const KEEPS = [
  "Your account and every credit in it",
  "Your ledger, deposits and receipts",
  "Your settings, including this one",
  "What you wrote in other people’s collabs. You leave those collabs.",
];

// The workspace banner, from GET /api/inactivity-wipe's notice: null, or
// - { kind: "reset", deadline, left, next }: coming back inside the last 7
//   days reset the clock. `left` is the whole days that were left then (0:
//   it was already due), `next` the new deadline;
// - { kind: "erased", at, days }: the worker erased the account's content
//   after `days` days without activity.
export function bannerOf(view) {
  const n = view?.notice;
  if (!n || !view.enabled) return null;
  if (n.kind === "reset" && Number.isFinite(n.deadline))
    return {
      kind: "reset",
      deadline: n.deadline,
      left: daysLeft(n.deadline, view.lastActive) ?? 0,
      next: view.deadline,
    };
  if (n.kind === "erased" && Number.isFinite(n.at))
    return { kind: "erased", at: n.at, days: n.days ?? null };
  return null;
}

// Why an erase is waiting (the worker's blocked code), in plain words.
export const BLOCKED_TEXT = {
  requests_in_flight: "A request was still running on your account.",
  treasury_not_empty: "A collab you own still holds Team Treasury credits.",
  treasury_busy: "A team-paid request was still running in a collab you own.",
  media_delete_failed: "A saved file couldn’t be removed.",
  failed: "Something went wrong.",
};
