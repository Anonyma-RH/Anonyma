import nodemailer from "nodemailer";
import { now, fail, transaction } from "./core.js";
import { isReleased } from "./releases.js";
import { configurationStatus } from "./readiness.js";
import { inactivityPush } from "./push-alerts.js";
import {
  WIPE_DAYS,
  DAY_MS,
  ACTIVITY_STEP_MS,
  REMIND_DAYS,
  REMIND_MS,
  validDays,
  deadlineOf,
  remindAtOf,
  nearDeadline,
  daysLeft,
} from "../src/inactivity-wipe.js";

// Inactivity Wipe: an account can choose to have its content erased once it
// has gone 30, 90, 180 or 365 days without activity. Off by default, and an
// account that never turns it on has nothing recorded (no row in
// inactivity_wipe). The deadline maths is in src/inactivity-wipe.js.
//
// - Activity (recordActivity): a successful sign-in, any request of a
//   signed-in session and, unless the account unticks it, an API key or
//   connected app using the account. Written at most once an hour per
//   account. Scheduled Routines and Page Watch runs are the server acting on
//   its own, so they never count.
// - The worker (sweep): erases each account past its deadline with Panic
//   Wipe's own erase (wipeAccountContent in routes/wipe.js), so exactly the
//   same things go and the account, its credits and its settings stay. It
//   follows Panic Wipe's rules: while a request is running, or a collab the
//   account owns holds Team Treasury credits, it waits and tries again an
//   hour later. It logs counts only, never an account.
// - The reminder: 7 days before the deadline, one email to the account's
//   verified email, only if it has one and this server can send email (the
//   same readiness as /api/config's services.email; test mode only records
//   it). Without email nothing is claimed, recorded or promised.
// - Released only with Panic Wipe ("wipe"). While either is switched off the
//   worker erases nothing and sends nothing, but activity is still recorded
//   for accounts that turned it on, so switching it back on can never erase
//   an account that was in use meanwhile.
export const inactivityLive = (cfg) =>
  isReleased(cfg, "deadswitch") && isReleased(cfg, "wipe");
// The reminder email can go out: exactly /api/config's services.email (an
// SMTP server and sender are set up, or test mode, which only records it).
export const remindersAvailable = (cfg) =>
  !!cfg.testMode || configurationStatus(cfg).configured.email;

// A blocked erase is retried after an hour; a reminder that couldn't be sent
// after six.
const RETRY_MS = 3_600_000;
const REMIND_RETRY_MS = 6 * 3_600_000;
const BATCH = 25;
// The worker runs every few seconds. A longer gap than this since it last
// ran (the service was down, a backup was restored, or the update was
// switched off) is added to every account's deadline in full.
export const OFFLINE_GAP_MS = 15 * 60_000;

const rowOf = (db, user) =>
  db.prepare("SELECT * FROM inactivity_wipe WHERE user_id=?").get(user) || null;
// The erase this row's current period already had (none, or one before the
// last activity, which started a new period).
const erasedThisPeriod = (row) =>
  row.erased != null && row.erased >= row.last_active;

// Records activity for an account that turned Inactivity Wipe on; does
// nothing for one that didn't. `kind` is "sign-in", "session" or "api" (API
// keys and connected apps, which count only while api_counts is on). At most
// one write an hour: the row is read first and written only when its last
// activity is an hour old or more. Returns whether it wrote.
//
// Coming back inside the last 7 days before the deadline (or after it, before
// the worker got to it) resets the clock and leaves a one-time "reset"
// notice for the workspace. After an erase, the "erased" notice stays until
// it's dismissed.
export function recordActivity(db, user, kind, at = now()) {
  if (!user) return false;
  const row = db
    .prepare(
      "SELECT days,api_counts,last_active,paused,erased FROM inactivity_wipe WHERE user_id=?",
    )
    .get(user);
  if (!row) return false;
  if (kind === "api" && !row.api_counts) return false;
  if (at - row.last_active < ACTIVITY_STEP_MS) return false;
  const reset =
    !erasedThisPeriod(row) && nearDeadline(row.last_active, row.days, at, row.paused);
  const r = db
    .prepare(
      `UPDATE inactivity_wipe SET last_active=?,paused=0,reminded=NULL,remind_tried=NULL,blocked=NULL,blocked_at=NULL
       ${reset ? ",notice='reset',notice_deadline=?" : ""} WHERE user_id=? AND last_active=?`,
    )
    .run(
      ...(reset
        ? [at, deadlineOf(row.last_active, row.days, row.paused), user, row.last_active]
        : [at, user, row.last_active]),
    );
  return r.changes > 0;
}

function noticeOf(row) {
  if (row?.notice === "reset" && row.notice_deadline != null)
    return { kind: "reset", deadline: row.notice_deadline };
  if (row?.notice === "erased" && row.erased != null)
    return { kind: "erased", at: row.erased, days: row.days };
  return null;
}

// What GET /api/inactivity-wipe returns. `user` is the users row.
export function inactivityView(db, cfg, user, at = now()) {
  const row = rowOf(db, user.id);
  const deadline = row ? deadlineOf(row.last_active, row.days, row.paused) : null;
  const reminders = remindersAvailable(cfg);
  return {
    enabled: !!row,
    days: row?.days ?? null,
    // On unless the account unticks it (the default for a new setting).
    apiCounts: row ? !!row.api_counts : true,
    lastActive: row?.last_active ?? null,
    // Time the worker wasn't running since then, added to the deadline.
    paused: row?.paused ?? 0,
    deadline,
    daysLeft: row ? daysLeft(deadline, at) : null,
    // Whether a verified email is on the account (never the address), and
    // whether this server can send the reminder.
    email: !!user.email,
    emailReminders: reminders,
    remindAt:
      row && user.email && reminders
        ? remindAtOf(row.last_active, row.days, row.paused)
        : null,
    reminded: row?.reminded ?? null,
    erased: row?.erased ?? null,
    blocked: row?.blocked ? { code: row.blocked, at: row.blocked_at } : null,
    notice: noticeOf(row),
    options: WIPE_DAYS,
    remindDays: REMIND_DAYS,
    now: at,
    // Push Alerts' browser reminder, sent by its own sweep
    // (server/push-alerts.js), only while the account has a browser with it
    // switched on: when it's due and whether this period's was sent.
    ...pushReminder(db, cfg, user.id, row),
  };
}
function pushReminder(db, cfg, user, row) {
  const push = inactivityPush(db, cfg, user, row);
  return push ? { push } : {};
}

// PUT /api/inactivity-wipe: { days: 30 | 90 | 180 | 365 | null, api_counts?,
// confirm? }. days null turns it off and deletes the row. Turning it on, or
// choosing a shorter period, needs confirm: true. Any change starts a new
// period from now and clears the reminder, a waiting erase and the notice.
export function changeInactivity(db, user, body, at = now()) {
  const hasDays = Object.hasOwn(body, "days");
  const hasApi = Object.hasOwn(body, "api_counts");
  if (!hasDays && !hasApi)
    fail(400, "Send days, api_counts or both.", "invalid_inactivity");
  if (hasDays && body.days !== null && !validDays(body.days))
    fail(
      400,
      "Choose 30, 90, 180 or 365 days, or null to turn it off.",
      "invalid_days",
    );
  if (hasApi && typeof body.api_counts !== "boolean")
    fail(400, "Send api_counts as true or false.", "invalid_api_counts");
  transaction(db, () => {
    const row = rowOf(db, user);
    if (hasDays && body.days === null) {
      db.prepare("DELETE FROM inactivity_wipe WHERE user_id=?").run(user);
      return;
    }
    const days = hasDays ? body.days : row?.days;
    if (days == null)
      fail(400, "Choose a period to turn Inactivity Wipe on.", "invalid_days");
    if ((!row || days < row.days) && body.confirm !== true)
      fail(
        400,
        "Confirm to turn on Inactivity Wipe or shorten its period.",
        "confirmation_required",
      );
    const apiCounts = hasApi ? body.api_counts : row ? !!row.api_counts : true;
    db.prepare(
      `INSERT INTO inactivity_wipe(user_id,days,api_counts,last_active,updated) VALUES(?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET days=excluded.days,api_counts=excluded.api_counts,
         last_active=excluded.last_active,paused=0,updated=excluded.updated,reminded=NULL,remind_tried=NULL,
         blocked=NULL,blocked_at=NULL,notice=NULL,notice_deadline=NULL`,
    ).run(user, days, apiCounts ? 1 : 0, at, at);
  });
}

export function dismissNotice(db, user) {
  db.prepare(
    "UPDATE inactivity_wipe SET notice=NULL,notice_deadline=NULL WHERE user_id=?",
  ).run(user);
}

// The account export's inactivityWipe: null while it's off.
export function exportInactivity(db, user) {
  const row = rowOf(db, user);
  return row
    ? {
        days: row.days,
        apiCounts: !!row.api_counts,
        lastActive: row.last_active,
        paused: row.paused,
        deadline: deadlineOf(row.last_active, row.days, row.paused),
        reminded: row.reminded,
        erased: row.erased,
        updated: row.updated,
      }
    : null;
}
// Account closure deletes the setting (routes/account.js). Panic Wipe keeps
// it with the account's other settings.
export const forgetInactivity = (db, user) =>
  db.prepare("DELETE FROM inactivity_wipe WHERE user_id=?").run(user);

const dateText = (t) => new Date(t).toUTCString().replace(/:\d\d GMT$/, " UTC");

// The one reminder, 7 days before the deadline. Nothing about the account's
// content, and no link that signs anyone in.
export function reminderEmail(cfg, { idleDays, deadline }) {
  const origin = String(cfg.publicUrl || cfg.origin).replace(/\/+$/, "");
  return {
    subject: `Your ANONYMA content will be erased in ${REMIND_DAYS} days`,
    text: [
      `You turned on Inactivity Wipe for your ANONYMA account. It has had no activity for ${idleDays === 1 ? "1 day" : `${idleDays} days`}.`,
      "",
      `On ${dateText(deadline)} we will erase your content: your chats, saved files, memory, routines and everything else Panic Wipe erases. Your account and your credits stay.`,
      "",
      `To keep it, sign in before then: ${origin}/login`,
      "To let it happen, do nothing.",
      "",
      "You can change or turn off Inactivity Wipe in Account settings. This is the only reminder we send.",
    ].join("\n"),
  };
}

// The worker's side.
// - erase(user, { check, record }): Panic Wipe's erase (wipeAccountContent in
//   routes/wipe.js, passed in by app.js).
// - send({ to, subject, text }): delivers a reminder and resolves true once
//   the mail server accepted it. The default uses SMTP; test mode keeps it in
//   `outbox` instead (the last 50, in memory only) and sends nothing.
export function createInactivityWipe(ctx, { erase, send } = {}) {
  const { db, cfg } = ctx;
  const outbox = [];
  async function smtpSend(mail) {
    if (cfg.testMode) {
      outbox.push({ ...mail, at: now() });
      if (outbox.length > 50) outbox.shift();
      return true;
    }
    if (!remindersAvailable(cfg)) return false;
    const transport = nodemailer.createTransport({
      url: cfg.smtp,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    });
    try {
      const result = await transport.sendMail({
        from: cfg.smtpFrom,
        ...mail,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return !!result.accepted?.length && !result.rejected?.length;
    } catch {
      // SMTP errors can carry credentials or the address: never logged.
      return false;
    } finally {
      transport.close();
    }
  }
  const deliver = send || smtpSend;

  // One account past its deadline, erased with Panic Wipe's erase (which
  // removes its files, then deletes and revokes in one transaction). check()
  // runs before the files go and again inside the transaction, so an
  // account that became active, changed its period or turned the setting
  // off is left alone.
  function eraseOne(id, at) {
    const user = db
      .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
      .get(id);
    if (!user) return "skipped";
    let row;
    const check = () => {
      row = rowOf(db, id);
      if (
        !row ||
        erasedThisPeriod(row) ||
        !(deadlineOf(row.last_active, row.days, row.paused) <= at)
      )
        throw Object.assign(new Error("not due"), { notDue: true });
    };
    try {
      erase(user, {
        check,
        record: () =>
          db
            .prepare(
              "UPDATE inactivity_wipe SET erased=?,notice='erased',notice_deadline=?,blocked=NULL,blocked_at=NULL WHERE user_id=? AND last_active=?",
            )
            .run(at, deadlineOf(row.last_active, row.days, row.paused), id, row.last_active),
      });
      return "erased";
    } catch (e) {
      if (e.notDue) return "skipped";
      // Waiting, for Panic Wipe's reasons (or an unexpected failure): kept
      // with the code only, and tried again after an hour.
      const code = [
        "requests_in_flight",
        "treasury_not_empty",
        "treasury_busy",
        "media_delete_failed",
      ].includes(e.code)
        ? e.code
        : "failed";
      db.prepare(
        "UPDATE inactivity_wipe SET blocked=?,blocked_at=? WHERE user_id=?",
      ).run(code, at, id);
      return "waiting";
    }
  }

  // Time the worker wasn't running never counts as inactivity: after a gap
  // longer than OFFLINE_GAP_MS since its last run, each account's deadline
  // moves by the part of the gap after its own last activity (activity is
  // still recorded while the worker is off). The first run has nothing to
  // measure from. The run time is written at most once a minute.
  const lastSweep = () =>
    db.prepare("SELECT last_sweep FROM inactivity_clock WHERE id=1").get()
      ?.last_sweep;
  function catchUp(at) {
    const seen = lastSweep();
    if (seen != null && at - seen < 60_000) return;
    transaction(db, () => {
      const last = lastSweep();
      if (last != null && at - last > OFFLINE_GAP_MS)
        db.prepare(
          "UPDATE inactivity_wipe SET paused=paused+(?-MAX(?,last_active)) WHERE last_active<?",
        ).run(at, last, at);
      db.prepare(
        "INSERT INTO inactivity_clock(id,last_sweep) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_sweep=MAX(last_sweep,excluded.last_sweep)",
      ).run(at);
    });
  }

  // Everything due at `at`: erases first (synchronously, account by
  // account), then reminders. Safe to run as often as the worker ticks: an
  // erased period is never erased again, a waiting one is retried hourly,
  // and a reminder goes once per period.
  async function sweep(at = now()) {
    const counts = { erased: 0, waiting: 0, reminded: 0 };
    if (!inactivityLive(cfg)) return counts;
    catchUp(at);
    const due = db
      .prepare(
        `SELECT w.user_id FROM inactivity_wipe w JOIN users u ON u.id=w.user_id
         WHERE u.deleted IS NULL AND w.last_active+w.days*?+?+w.paused<=?
           AND (w.erased IS NULL OR w.erased<w.last_active)
           AND (w.blocked_at IS NULL OR w.blocked_at<=?)
         ORDER BY w.last_active LIMIT ${BATCH}`,
      )
      .all(DAY_MS, ACTIVITY_STEP_MS, at, at - RETRY_MS);
    for (const { user_id } of due) {
      const outcome = eraseOne(user_id, at);
      if (outcome === "erased") counts.erased++;
      else if (outcome === "waiting") counts.waiting++;
    }
    // No email service: no reminder is claimed, recorded or counted.
    if (!remindersAvailable(cfg)) return report(counts);
    const remind = db
      .prepare(
        `SELECT w.user_id,w.days,w.last_active,w.paused,u.email FROM inactivity_wipe w JOIN users u ON u.id=w.user_id
         WHERE u.deleted IS NULL AND u.email IS NOT NULL AND w.reminded IS NULL
           AND w.last_active+w.days*?+?+w.paused-?<=?
           AND (w.erased IS NULL OR w.erased<w.last_active)
           AND (w.remind_tried IS NULL OR w.remind_tried<=?)
         ORDER BY w.last_active LIMIT ${BATCH}`,
      )
      .all(DAY_MS, ACTIVITY_STEP_MS, REMIND_MS, at, at - REMIND_RETRY_MS);
    for (const r of remind) {
      const deadline = deadlineOf(r.last_active, r.days, r.paused);
      // Inside the last 7 days and not yet due (a due one is the erase's).
      if (!(remindAtOf(r.last_active, r.days, r.paused) <= at && at < deadline))
        continue;
      // Claimed before sending, so a second sweep never sends it twice.
      const claim = db
        .prepare(
          "UPDATE inactivity_wipe SET remind_tried=? WHERE user_id=? AND last_active=? AND reminded IS NULL AND (remind_tried IS NULL OR remind_tried<=?)",
        )
        .run(at, r.user_id, r.last_active, at - REMIND_RETRY_MS);
      if (!claim.changes) continue;
      let sent = false;
      try {
        sent = await deliver({
          to: r.email,
          ...reminderEmail(cfg, {
            idleDays: Math.floor((at - r.last_active) / DAY_MS),
            deadline,
          }),
        });
      } catch {
        sent = false;
      }
      if (!sent) continue;
      db.prepare(
        "UPDATE inactivity_wipe SET reminded=? WHERE user_id=? AND last_active=?",
      ).run(at, r.user_id, r.last_active);
      counts.reminded++;
    }
    return report(counts);
  }
  function report(counts) {
    if (counts.erased || counts.waiting || counts.reminded)
      console.log(
        `Inactivity Wipe: ${counts.erased} erased, ${counts.waiting} waiting, ${counts.reminded} reminded.`,
      );
    return counts;
  }
  return { sweep, outbox };
}
