import { createHash } from "node:crypto";
import { now, uid, fail, transaction } from "./core.js";
import { isReleased } from "./releases.js";
import {
  vapidKeys,
  checkEndpoint,
  fromB64u,
  validPoint,
  pushRequest,
  postPush,
  PushError,
  PUSH_TTL_SECONDS,
} from "./web-push.js";
import {
  PUSH_EVENTS,
  EVENT_UPDATES,
  PUSH_KINDS,
  PUSH_LANGS,
  MAX_DEVICES,
  pushPayload,
} from "../src/push-alerts.js";
import {
  DAY_MS,
  ACTIVITY_STEP_MS,
  REMIND_MS,
  deadlineOf,
  remindAtOf,
} from "../src/inactivity-wipe.js";

// Push Alerts: browser notifications for an account's routines, page
// watches, balance, gifts and Inactivity Wipe, with no email address.
//
// - What's kept, per account: each subscribed browser (its push endpoint,
//   its two public encryption values, the push service's name, the page's
//   language, when it was added and last reached) and one row of switches
//   (push_settings), plus notifications waiting to be delivered
//   (push_queue: which browser, which kind, when, how many tries). Nothing
//   about what happened goes in a notification: each kind has one fixed
//   sentence (src/push-alerts.js). The switches go when the last browser
//   does.
// - Delivery: the worker sends what's due (Web Push, server/web-push.js),
//   at most 25 a tick, 4 at a time. A push service's 404 or 410 means the
//   browser unsubscribed: the subscription is deleted. 429, 5xx and network
//   failures are retried after 30 s, 2 min, 10 min, 1 h and 6 h, then
//   dropped; any other refusal drops that one message. A message older than
//   its 4-day TTL is dropped too. Two notifications of the same kind waiting
//   for the same browser are one.
// - Events: runChat's Routines and Page Watch record theirs as they finish,
//   Gift Links as a gift is claimed or expires, and the worker's sweep finds
//   balances that dropped below the Low-Balance Alerts level (the settled
//   balance, so a hold that's released never alerts) and Inactivity Wipe
//   reminders due (7 days before the deadline, once a period).
// - Available only with VAPID keys configured (VAPID_PUBLIC_KEY,
//   VAPID_PRIVATE_KEY, VAPID_SUBJECT) and "pushalerts" and "app" (whose
//   service worker receives them) released. /api/config's services.push says
//   which.
// - Erased with the account's content (Panic Wipe, Inactivity Wipe,
//   closure) and in the account export with endpoints cut to their host.
// Nothing here logs an endpoint, a key or an account.

export const pushReleased = (cfg) => isReleased(cfg, "pushalerts") && isReleased(cfg, "app");
// The VAPID keys, checked once per configuration (they're fixed at start).
const checked = new WeakMap();
let warned = false;
export function pushConfig(cfg) {
  const signature = `${cfg.vapidPublicKey}|${cfg.vapidPrivateKey}|${cfg.vapidSubject}`;
  let entry = checked.get(cfg);
  if (entry?.signature !== signature) {
    entry = { signature, ...vapidKeys(cfg) };
    checked.set(cfg, entry);
  }
  if (entry.problem && entry.problem !== "missing" && !warned) {
    warned = true;
    console.warn("Push Alerts: the VAPID settings aren't a valid key pair and contact, so push is off.");
  }
  return entry.keys;
}
export const pushAvailable = (cfg) => pushReleased(cfg) && !!pushConfig(cfg);
// A short id for the VAPID key a subscription was made with.
export const keyIdOf = (publicKey) => createHash("sha256").update(String(publicKey)).digest("hex").slice(0, 16);
export const tagOf = (endpoint) => createHash("sha256").update(String(endpoint)).digest("hex").slice(0, 16);
const eventLive = (cfg, event) => (EVENT_UPDATES[event] || []).every((id) => isReleased(cfg, id));

export const BACKOFF_MS = [30_000, 120_000, 600_000, 3_600_000, 6 * 3_600_000];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const TTL_MS = PUSH_TTL_SECONDS * 1000;
const LEASE_MS = 60_000;
const BATCH = 25;
const PARALLEL = 4;
const SWEEP_MS = 60_000;
const PERMANENT = ["push_endpoint", "push_service", "link_blocked", "link_invalid", "link_userinfo", "link_port"];

const settingsOf = (db, user) =>
  db.prepare("SELECT * FROM push_settings WHERE user_id=?").get(user) || null;
// The switches go with the last browser.
const pruneSettings = (db, user) =>
  db
    .prepare("DELETE FROM push_settings WHERE user_id=? AND NOT EXISTS (SELECT 1 FROM push_subscriptions WHERE user_id=?)")
    .run(user, user);

// A subscription as PushSubscription.toJSON() gives it, plus the page's
// language: { endpoint, keys: { p256dh, auth }, lang }.
export function subscriptionInput(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  let checked;
  try {
    checked = checkEndpoint(b.endpoint);
  } catch (e) {
    fail(400, e.message, e instanceof PushError ? e.code : "push_endpoint");
  }
  const p256dh = fromB64u(b.keys?.p256dh);
  const auth = fromB64u(b.keys?.auth);
  if (!p256dh || !validPoint(p256dh) || !auth || auth.length !== 16)
    fail(400, "That subscription's keys aren't valid. Turn notifications off and on again in this browser.", "push_keys");
  const lang = b.lang === undefined ? "en" : b.lang;
  if (!PUSH_LANGS.includes(lang)) fail(400, "Send lang as en or zh.", "invalid_request");
  return {
    endpoint: checked.url.href,
    service: checked.service,
    p256dh: p256dh.toString("base64url"),
    auth: auth.toString("base64url"),
    lang,
  };
}

// The switches from a PATCH body: booleans for any of PUSH_EVENTS.
export function settingsInput(body) {
  const b = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  const change = {};
  for (const [key, value] of Object.entries(b)) {
    if (!PUSH_EVENTS.includes(key)) fail(400, `Unknown setting: ${key.slice(0, 40)}.`, "invalid_request");
    if (typeof value !== "boolean") fail(400, `Send ${key} as true or false.`, "invalid_request");
    change[key] = value;
  }
  if (!Object.keys(change).length) fail(400, "Send at least one setting.", "invalid_request");
  return change;
}

// The account export's pushAlerts: each browser with its push service's
// host only, and the switches. Null when nothing is kept.
export function exportPush(db, user) {
  const devices = db
    .prepare("SELECT endpoint,service,lang,created,last_success FROM push_subscriptions WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((d) => ({
      pushService: new URL(d.endpoint).hostname,
      service: d.service,
      language: d.lang,
      created: d.created,
      lastSuccess: d.last_success,
    }));
  const s = settingsOf(db, user);
  if (!devices.length && !s) return null;
  return {
    devices,
    events: s ? Object.fromEntries(PUSH_EVENTS.map((e) => [e, !!s[e]])) : null,
  };
}
// Account closure, Panic Wipe and Inactivity Wipe (eraseAccountContent).
export function forgetPush(db, user) {
  db.prepare("DELETE FROM push_queue WHERE user_id=?").run(user);
  db.prepare("DELETE FROM push_subscriptions WHERE user_id=?").run(user);
  db.prepare("DELETE FROM push_settings WHERE user_id=?").run(user);
}

// Inactivity Wipe's view of the browser reminder: null unless Push Alerts
// is available and the account has a browser with the reminder switched on.
export function inactivityPush(db, cfg, user, row) {
  if (!pushAvailable(cfg)) return null;
  const s = settingsOf(db, user);
  if (!s?.inactivity) return null;
  if (!db.prepare("SELECT 1 FROM push_subscriptions WHERE user_id=? LIMIT 1").get(user)) return null;
  return {
    remindAt: row ? remindAtOf(row.last_active, row.days, row.paused) : null,
    sent: !!row && s.inactivity_for === row.last_active,
  };
}

export function createPushAlerts(ctx, { transport } = {}) {
  const { db, cfg } = ctx;
  const hooks = cfg.testMode ? cfg.push || {} : {};
  const send = transport || hooks.transport || ((endpoint, req) => postPush(endpoint, req, hooks));
  const live = () => pushReleased(cfg);
  const keys = () => (live() ? pushConfig(cfg) : null);

  function assertAvailable() {
    if (!keys())
      fail(503, "Browser notifications aren't available on this server yet.", "push_unavailable");
  }

  // Queues one notification for each of the account's browsers (or just
  // `only`), when its switch is on. Single statements only: callers may be
  // inside a transaction. Never throws.
  function notify(user, kind, { only = null, at = now() } = {}) {
    try {
      const k = PUSH_KINDS[kind];
      const key = keys();
      if (!k || !key || !user) return 0;
      if (k.event) {
        if (!eventLive(cfg, k.event)) return 0;
        const s = settingsOf(db, user);
        if (!s || !s[k.event]) return 0;
      }
      const subs = db
        .prepare(
          `SELECT id FROM push_subscriptions WHERE user_id=? AND key_id=?${only ? " AND id=?" : ""}`,
        )
        .all(...(only ? [user, keyIdOf(key.publicKey), only] : [user, keyIdOf(key.publicKey)]));
      let queued = 0;
      const insert = db.prepare(
        "INSERT OR IGNORE INTO push_queue(id,subscription_id,user_id,kind,created,attempts,next_try) VALUES(?,?,?,?,?,0,?)",
      );
      for (const { id } of subs) queued += insert.run(uid("pq_"), id, user, kind, at, at).changes;
      return queued;
    } catch {
      return 0;
    }
  }

  function view(user) {
    const key = keys();
    const keyId = key ? keyIdOf(key.publicKey) : null;
    const s = settingsOf(db, user);
    const devices = db
      .prepare("SELECT id,endpoint,service,lang,key_id,created,last_success FROM push_subscriptions WHERE user_id=? ORDER BY created,rowid")
      .all(user)
      .map((d) => ({
        id: d.id,
        service: d.service,
        tag: tagOf(d.endpoint),
        lang: d.lang,
        created: d.created,
        lastSuccess: d.last_success,
        // Made with an older VAPID key: that browser subscribes again the
        // next time this page is open in it.
        stale: keyId != null && d.key_id !== keyId,
      }));
    const events = {};
    for (const e of PUSH_EVENTS) if (eventLive(cfg, e)) events[e] = s ? !!s[e] : true;
    return {
      available: !!key,
      publicKey: key?.publicKey || null,
      devices,
      events,
      // Low balance uses the Low-Balance Alerts level; without one it
      // can't fire.
      lowBalanceLevel: !!db.prepare("SELECT 1 FROM balance_alerts WHERE user_id=?").get(user),
      inactivityOn: !!db.prepare("SELECT 1 FROM inactivity_wipe WHERE user_id=?").get(user),
      max: MAX_DEVICES,
    };
  }

  // Adds (or refreshes) this browser for the account. An endpoint another
  // account had moves here: a browser alerts one account at a time.
  function subscribe(user, sub, at = now()) {
    const key = keys();
    return transaction(db, () => {
      const existing = db.prepare("SELECT id,user_id FROM push_subscriptions WHERE endpoint=?").get(sub.endpoint);
      if (existing && existing.user_id !== user) {
        db.prepare("DELETE FROM push_subscriptions WHERE id=?").run(existing.id);
        pruneSettings(db, existing.user_id);
      }
      let id = existing?.user_id === user ? existing.id : null;
      if (id)
        db.prepare("UPDATE push_subscriptions SET p256dh=?,auth=?,service=?,lang=?,key_id=? WHERE id=?").run(
          sub.p256dh,
          sub.auth,
          sub.service,
          sub.lang,
          keyIdOf(key.publicKey),
          id,
        );
      else {
        const count = db.prepare("SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?").get(user).n;
        if (count >= MAX_DEVICES)
          fail(400, `You can have notifications in up to ${MAX_DEVICES} browsers. Remove one first.`, "push_limit");
        id = uid("ps_");
        db.prepare(
          "INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,service,lang,key_id,created) VALUES(?,?,?,?,?,?,?,?,?)",
        ).run(id, user, sub.endpoint, sub.p256dh, sub.auth, sub.service, sub.lang, keyIdOf(key.publicKey), at);
      }
      db.prepare("INSERT OR IGNORE INTO push_settings(user_id,updated) VALUES(?,?)").run(user, at);
      return id;
    });
  }

  function unsubscribe(user, id) {
    return transaction(db, () => {
      const gone = db.prepare("DELETE FROM push_subscriptions WHERE id=? AND user_id=?").run(id, user).changes;
      if (!gone) fail(404, "That browser isn't on your list.", "push_not_found");
      pruneSettings(db, user);
    });
  }

  function changeSettings(user, change, at = now()) {
    transaction(db, () => {
      if (!settingsOf(db, user))
        fail(400, "Turn on notifications in a browser first.", "push_no_devices");
      for (const [event, on] of Object.entries(change)) {
        if (!eventLive(cfg, event)) fail(400, "That notification isn't available.", "invalid_request");
        // Switching low balance back on starts from the balance as it is.
        const reset = event === "lowbalance" ? ",low_state=NULL" : "";
        db.prepare(`UPDATE push_settings SET ${event}=?,updated=?${reset} WHERE user_id=?`).run(on ? 1 : 0, at, user);
      }
    });
  }

  // ---- Delivery ----

  let delivering = null;
  let closed = false;
  async function deliverOne(key, row) {
    let result;
    try {
      const req = pushRequest(key, row, pushPayload(row.kind, row.lang), now());
      result = await send(row.endpoint, req);
    } catch (e) {
      result = { error: e };
    }
    // The service is stopping: the lease runs out and it's sent later.
    if (closed) return "retrying";
    const at = now();
    const status = result?.status;
    if (status >= 200 && status < 300) {
      db.prepare("DELETE FROM push_queue WHERE id=?").run(row.id);
      db.prepare("UPDATE push_subscriptions SET last_success=? WHERE id=?").run(at, row.subscription_id);
      return "sent";
    }
    if (status === 404 || status === 410) {
      // The browser unsubscribed, or the push service forgot it.
      transaction(db, () => {
        db.prepare("DELETE FROM push_subscriptions WHERE id=?").run(row.subscription_id);
        pruneSettings(db, row.user_id);
      });
      return "gone";
    }
    // No answer at all (DNS, the connection, a timeout) is worth another
    // try; an address the checks refuse never is.
    const retry =
      status === 429 || status >= 500 || (!!result?.error && !PERMANENT.includes(result.error.code));
    if (!retry || row.attempts + 1 >= MAX_ATTEMPTS) {
      db.prepare("DELETE FROM push_queue WHERE id=?").run(row.id);
      return "dropped";
    }
    const wait = Math.min(Math.max(BACKOFF_MS[row.attempts], (result?.retryAfter || 0) * 1000), BACKOFF_MS.at(-1));
    db.prepare("UPDATE push_queue SET attempts=attempts+1,next_try=? WHERE id=?").run(at + wait, row.id);
    return "retrying";
  }
  // Sends what's due. One run at a time; resolves with counts.
  function deliver(at = now()) {
    delivering ||= (async () => {
      const counts = { sent: 0, retrying: 0, dropped: 0, gone: 0 };
      // Past its TTL the push service would drop it too.
      db.prepare("DELETE FROM push_queue WHERE created<?").run(at - TTL_MS);
      const key = keys();
      if (!key) return counts;
      const rows = db
        .prepare(
          `SELECT q.*,s.endpoint,s.p256dh,s.auth,s.lang FROM push_queue q JOIN push_subscriptions s ON s.id=q.subscription_id
           WHERE q.next_try<=? AND s.key_id=? ORDER BY q.next_try,q.rowid LIMIT ${BATCH}`,
        )
        .all(at, keyIdOf(key.publicKey));
      // Leased first, so an overlapping run never sends one twice.
      const claimed = rows.filter(
        (r) => db.prepare("UPDATE push_queue SET next_try=? WHERE id=? AND next_try=?").run(at + LEASE_MS, r.id, r.next_try).changes,
      );
      for (let i = 0; i < claimed.length && !closed; i += PARALLEL) {
        const outcomes = await Promise.all(claimed.slice(i, i + PARALLEL).map((r) => deliverOne(key, r)));
        for (const o of outcomes) counts[o]++;
      }
      return counts;
    })().finally(() => {
      delivering = null;
    });
    return delivering;
  }

  // ---- The worker's sweeps ----

  // Low balance: an account whose settled balance went from at or above its
  // Low-Balance Alerts level to below it gets one notification; it's armed
  // again once the balance is back at or above the level. The first look
  // only records where the balance is.
  function sweepBalances() {
    if (!keys() || !eventLive(cfg, "lowbalance")) return 0;
    let sent = 0;
    const rows = db
      .prepare(
        `SELECT s.user_id,s.low_state,a.threshold FROM push_settings s
         JOIN balance_alerts a ON a.user_id=s.user_id
         JOIN users u ON u.id=s.user_id AND u.deleted IS NULL
         WHERE s.lowbalance=1`,
      )
      .all();
    for (const r of rows) {
      const total = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE user_id=?").get(r.user_id).n;
      const below = total < r.threshold ? 1 : 0;
      if (r.low_state == null || (r.low_state === 1 && !below)) {
        db.prepare("UPDATE push_settings SET low_state=? WHERE user_id=?").run(below, r.user_id);
      } else if (r.low_state === 0 && below) {
        const won = db
          .prepare("UPDATE push_settings SET low_state=1 WHERE user_id=? AND low_state=0")
          .run(r.user_id).changes;
        if (won) sent += notify(r.user_id, "lowbalance") ? 1 : 0;
      }
    }
    return sent;
  }
  // Inactivity Wipe's reminder, 7 days before the deadline, once a period
  // (a new activity or a changed setting starts a new one).
  function sweepInactivity(at = now()) {
    if (!keys() || !eventLive(cfg, "inactivity")) return 0;
    let sent = 0;
    const rows = db
      .prepare(
        `SELECT w.user_id,w.days,w.last_active,w.paused FROM inactivity_wipe w
         JOIN push_settings s ON s.user_id=w.user_id
         JOIN users u ON u.id=w.user_id AND u.deleted IS NULL
         WHERE s.inactivity=1 AND (s.inactivity_for IS NULL OR s.inactivity_for<>w.last_active)
           AND w.last_active+w.days*?+?+w.paused-?<=?
           AND (w.erased IS NULL OR w.erased<w.last_active)
         LIMIT 100`,
      )
      .all(DAY_MS, ACTIVITY_STEP_MS, REMIND_MS, at);
    for (const r of rows) {
      if (!(remindAtOf(r.last_active, r.days, r.paused) <= at && at < deadlineOf(r.last_active, r.days, r.paused)))
        continue;
      const won = db
        .prepare(
          "UPDATE push_settings SET inactivity_for=? WHERE user_id=? AND (inactivity_for IS NULL OR inactivity_for<>?)",
        )
        .run(r.last_active, r.user_id, r.last_active).changes;
      if (won) sent += notify(r.user_id, "inactivity", { at }) ? 1 : 0;
    }
    return sent;
  }
  let lastSweep = 0;
  // Once per worker tick: the sweeps at most once a minute, then delivery
  // (not awaited; it runs alongside the rest of maintenance).
  function tick(at = now()) {
    if (closed || !live()) return null;
    if (at - lastSweep >= SWEEP_MS || at < lastSweep) {
      lastSweep = at;
      try {
        sweepBalances();
        sweepInactivity(at);
      } catch {
        console.error("Push Alerts sweep failed; it will retry.");
      }
    }
    return deliver(at).catch(() => console.error("Push Alerts delivery failed; it will retry."));
  }

  return {
    assertAvailable,
    // The current VAPID key's short id (null without keys).
    keyId: () => {
      const key = keys();
      return key ? keyIdOf(key.publicKey) : null;
    },
    notify,
    view,
    subscribe,
    unsubscribe,
    changeSettings,
    deliver,
    sweepBalances,
    sweepInactivity,
    tick,
    idle: () => delivering || Promise.resolve(),
    stop() {
      closed = true;
      return delivering || Promise.resolve();
    },
  };
}
