import { chatLimits } from "../data/chat-limits.js";
import {
  now,
  uid,
  fail,
  credits,
  usdUnits,
  quote,
  callable,
  markupFactor,
  transaction,
} from "./core.js";
import { isReleased } from "./releases.js";
import { isPrivateModel } from "./private-mode.js";
import {
  MAX_ROUTINES,
  KEEP_RUNS,
  NAME_LIMIT,
  PROMPT_LIMIT,
  MAX_RUN_CREDITS,
  MAX_BUDGET_CREDITS,
  MIN_REPLY_TOKENS,
  MAX_REPLY_TOKENS,
  REPEATS,
  canonicalZone,
  parseTime,
  formatMinute,
  nextRunAfter,
  latestRunAtOrBefore,
  runsBetween,
  monthWindow,
} from "../src/routines.js";

// Routines: a saved prompt that runs on a schedule, with a per-run maximum
// and a monthly budget, and whose results land in the account's Routines
// inbox. The schedule math is shared with the page (src/routines.js).
//
// Runs start from the background worker (server/worker.js) and go through
// the same hold -> settle path as the API's chat (ctx.runChat, the way the
// MCP server uses it): the same pricing, balance and spending-limit checks,
// failure billing, ledger charge and signed receipt. On top of those, a
// guard inside the reservation's transaction refuses a hold larger than the
// per-run maximum or than what is left of the routine's monthly budget, and
// one for a routine that was switched off or deleted, or whose account was
// closed, since it was picked up. Settlement never exceeds the hold, so a
// run can't spend past either cap.
//
// Each run is claimed atomically (routines.running_since), so a routine has
// at most one run in flight. A routine that missed runs while the service
// was down runs its latest missed slot once and skips the older ones. The
// hold for a slot has a fixed id, so a slot can never be charged twice.
//
// Routines run on the server, where Veil can't mask anything: the prompt is
// sent as written. The answer is kept in the inbox (the newest KEEP_RUNS
// runs per routine) until deleted, including for Private models only
// routines, which route like Private Mode (zero data retention models only,
// never the backup gateway).

// Runs at once across the whole service; more wait for the next tick.
const MAX_CONCURRENT = 4;
const routinesLive = (cfg) => isReleased(cfg, "routines");
const units = (value, max, what) => {
  const n = Math.round(value * 10000);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > max ||
    Math.abs(n - value * 10000) > 1e-6
  )
    fail(
      400,
      `Set the ${what} in credits, above 0 and up to ${max.toLocaleString("en-US")}, with at most four decimals.`,
      "invalid_routine",
    );
  return n;
};
const bool = (value, name) => {
  if (typeof value !== "boolean")
    fail(400, `${name} must be true or false.`, "invalid_routine");
  return value ? 1 : 0;
};

export const scheduleOf = (row) => ({
  repeat: row.repeat,
  minute: row.minute,
  day: row.weekday,
  timezone: row.timezone,
});
// The hold id for one slot of one routine, and the prefix all its holds
// share: the monthly budget sums the ledger and open holds by it.
const requestIdFor = (routine, slot) => `routine_${routine.id}_${slot}`;
const holdPrefix = (routine) => `${routine.user_id}:routine_${routine.id}_`;

// What a routine has spent in the calendar month (in its own time zone)
// containing `at`, and what it has on hold right now.
export function monthSpend(db, routine, at = now()) {
  const { start, end } = monthWindow(routine.timezone, at);
  const prefix = holdPrefix(routine);
  const spent = db
    .prepare(
      "SELECT COALESCE(SUM(-amount),0) n FROM ledger WHERE user_id=? AND amount<0 AND created>=? AND created<? AND substr(ref,1,?)=?",
    )
    .get(routine.user_id, start, end, prefix.length, prefix).n;
  const held = db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM holds WHERE user_id=? AND status='held' AND substr(id,1,?)=?",
    )
    .get(routine.user_id, prefix.length, prefix).n;
  return { spent, held, start, end };
}

// ---- Input ----

// A routine's stored fields from a create (every field) or an update (the
// fields sent; the rest are kept).
export function routineInput(ctx, body, existing = null) {
  const { cfg } = ctx;
  if (!body || typeof body !== "object" || Array.isArray(body))
    fail(400, "Send the routine as a JSON object.", "invalid_routine");
  const has = (k) => Object.hasOwn(body, k);
  const next = existing ? { ...existing } : {};
  const need = (k) => {
    if (!existing && !has(k)) fail(400, `Add the routine's ${k}.`, "invalid_routine");
    return has(k);
  };
  if (need("name")) {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > NAME_LIMIT)
      fail(400, `Give the routine a name of 1 to ${NAME_LIMIT} characters.`, "invalid_routine");
    next.name = name;
  }
  if (need("prompt")) {
    const prompt = typeof body.prompt === "string" ? body.prompt : "";
    if (!prompt.trim() || prompt.length > PROMPT_LIMIT)
      fail(400, `Write a prompt of 1 to ${PROMPT_LIMIT.toLocaleString("en-US")} characters.`, "invalid_routine");
    next.prompt = prompt;
  }
  if (need("model")) {
    if (typeof body.model !== "string" || body.model.length > 200)
      fail(400, "Choose a model.", "invalid_routine");
    next.model = body.model;
  }
  next.web_search = has("web_search")
    ? bool(body.web_search, "web_search")
    : (next.web_search ?? 0);
  next.private_only = has("private_only")
    ? bool(body.private_only, "private_only")
    : (next.private_only ?? 0);
  next.enabled = has("enabled") ? bool(body.enabled, "enabled") : (next.enabled ?? 1);
  if (need("schedule")) {
    const s = body.schedule;
    if (!s || typeof s !== "object" || Array.isArray(s))
      fail(400, "Send the schedule as an object.", "invalid_schedule");
    if (!REPEATS.includes(s.repeat))
      fail(400, "Repeat daily, on weekdays or weekly.", "invalid_schedule");
    const minute = parseTime(s.time);
    if (minute == null)
      fail(400, "Set the time as HH:MM, from 00:00 to 23:59.", "invalid_schedule");
    const timezone = canonicalZone(s.timezone ?? "UTC");
    if (!timezone)
      fail(400, "Choose a time zone such as UTC or Europe/London.", "invalid_schedule");
    let weekday = null;
    if (s.repeat === "weekly") {
      if (!Number.isInteger(s.day) || s.day < 0 || s.day > 6)
        fail(400, "Choose the day for a weekly routine: 0 (Sunday) to 6 (Saturday).", "invalid_schedule");
      weekday = s.day;
    }
    Object.assign(next, { repeat: s.repeat, minute, weekday, timezone });
  }
  if (need("per_run_credits"))
    next.run_cap = units(body.per_run_credits, MAX_RUN_CREDITS, "per-run maximum");
  if (need("monthly_budget_credits"))
    next.monthly_budget = units(body.monthly_budget_credits, MAX_BUDGET_CREDITS, "monthly budget");
  if (next.monthly_budget < next.run_cap)
    fail(400, "Set a monthly budget at least as large as the per-run maximum.", "invalid_routine");
  // The model, whenever it or the private choice changes: a text chat model
  // this installation can run, and a private one for Private models only.
  if (!existing || has("model") || has("private_only")) {
    const m = ctx.models.find(next.model);
    if (
      !m ||
      m.type !== "chat" ||
      !callable(m, cfg) ||
      (m.architecture?.output_modalities || []).includes("image")
    )
      fail(400, "Choose a chat model you can use.", "invalid_model");
    if (next.private_only && !isPrivateModel(m, cfg))
      fail(
        400,
        "Private models only needs a model with zero data retention.",
        "private_model_required",
      );
  }
  return next;
}

// ---- Views ----

const json = (v) => (v == null ? null : JSON.parse(v));
export function routineView(db, row, at = now()) {
  const month = monthSpend(db, row, at);
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    model: row.model,
    web_search: !!row.web_search,
    private_only: !!row.private_only,
    schedule: {
      repeat: row.repeat,
      time: formatMinute(row.minute),
      ...(row.repeat === "weekly" ? { day: row.weekday } : {}),
      timezone: row.timezone,
    },
    per_run_credits: credits(row.run_cap),
    monthly_budget_credits: credits(row.monthly_budget),
    enabled: !!row.enabled,
    next_run_at: row.enabled ? row.next_run : null,
    running: row.running_since != null,
    last_run_at: row.last_run,
    last_status: row.last_status,
    month: {
      spent: credits(month.spent),
      held: credits(month.held),
      remaining: credits(Math.max(0, row.monthly_budget - month.spent - month.held)),
      resets_at: month.end,
    },
    created: row.created,
    updated: row.updated,
  };
}
export function runView(row) {
  return {
    id: row.id,
    routine_id: row.routine_id,
    routine_name: row.routine_name ?? null,
    scheduled_for: row.slot,
    started_at: row.started,
    finished_at: row.finished,
    status: row.status,
    skipped: row.skipped,
    model: row.model,
    web_search: !!row.web_search,
    private_only: !!row.private_only,
    request_id: row.request_id,
    credits_charged: credits(row.charged),
    reply_budget: row.reply_budget,
    finish_reason: row.finish_reason,
    answer: row.answer,
    citations: json(row.citations) || [],
    signed_receipt: json(row.receipt),
    code: row.code,
    message: row.message,
  };
}
export const listRoutines = (db, user, at = now()) =>
  db
    .prepare("SELECT * FROM routines WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((r) => routineView(db, r, at));

// Everything a routine keeps, for the account export.
export function exportRoutines(db, user) {
  return {
    routines: listRoutines(db, user),
    runs: db
      .prepare(
        "SELECT x.*,r.name routine_name FROM routine_runs x JOIN routines r ON r.id=x.routine_id WHERE x.user_id=? ORDER BY x.started,x.rowid",
      )
      .all(user)
      .map(runView),
  };
}
// Account closure: the routines and their inbox go. A run already claimed
// is refused by its reservation guard, which finds the routine gone.
export function forgetRoutines(db, user) {
  db.prepare("DELETE FROM routine_runs WHERE user_id=?").run(user);
  db.prepare("DELETE FROM routines WHERE user_id=?").run(user);
}

// ---- Runs ----

const refusal = (status, message, code) => {
  const e = new Error(message);
  e.status = status;
  e.code = code;
  return e;
};

// The reply budget a run gets: the largest, up to MAX_REPLY_TOKENS and the
// model's own limit, whose worst-case hold (computed the way runChat
// computes it) fits `cap`; null when even MIN_REPLY_TOKENS doesn't.
export function replyBudgetFor(m, messages, { factor, feeUnits, cap, longAnswers }) {
  const cost = (max) => Math.ceil((quote(m, messages, max) + feeUnits) * factor);
  const top = Math.max(
    MIN_REPLY_TOKENS,
    Math.min(
      MAX_REPLY_TOKENS,
      longAnswers ? chatLimits(m).maxOutputTokens : 8192,
    ),
  );
  if (cost(MIN_REPLY_TOKENS) > cap) return null;
  if (cost(top) <= cap) return { max: top, amount: cost(top) };
  let lo = MIN_REPLY_TOKENS,
    hi = top;
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (cost(mid) <= cap) lo = mid;
    else hi = mid;
  }
  return { max: lo, amount: cost(lo) };
}

export function createRoutineRunner(ctx) {
  const { db, cfg } = ctx;
  const running = new Map();
  let closed = false;
  // A run the service was restarting through can't finish: say so, and free
  // its routine. Its hold, if any, is released when it expires (worker.js).
  db.prepare(
    "UPDATE routine_runs SET status='failed',code='interrupted',message='The service restarted during this run.',finished=? WHERE status='running'",
  ).run(now());
  db.prepare(
    "UPDATE routines SET running_since=NULL,last_status='failed' WHERE running_since IS NOT NULL",
  ).run();

  // Takes a due routine for one run, atomically: its latest due slot runs,
  // older missed ones are skipped, and next_run moves past now.
  function claim(id, at) {
    return transaction(db, () => {
      const r = db
        .prepare(
          "SELECT r.* FROM routines r JOIN users u ON u.id=r.user_id AND u.deleted IS NULL WHERE r.id=? AND r.enabled=1 AND r.running_since IS NULL AND r.next_run<=?",
        )
        .get(id, at);
      if (!r) return null;
      const schedule = scheduleOf(r);
      const slot = Math.max(r.next_run, latestRunAtOrBefore(schedule, at) ?? r.next_run);
      const skipped = runsBetween(schedule, r.next_run, slot);
      db.prepare(
        "UPDATE routines SET running_since=?,next_run=? WHERE id=?",
      ).run(at, nextRunAfter(schedule, at), r.id);
      const runId = uid("rr_");
      db.prepare(
        "INSERT INTO routine_runs(id,routine_id,user_id,slot,started,status,skipped,model,web_search,private_only,request_id) VALUES(?,?,?,?,?,'running',?,?,?,?,?)",
      ).run(
        runId,
        r.id,
        r.user_id,
        slot,
        at,
        skipped,
        r.model,
        r.web_search,
        r.private_only,
        requestIdFor(r, slot),
      );
      return { routine: r, slot, runId };
    });
  }

  async function perform({ routine, slot }, closeListeners) {
    const user = db
      .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
      .get(routine.user_id);
    if (!user)
      throw refusal(409, "This routine was switched off or deleted before it ran.", "routine_gone");
    if (routine.web_search && !isReleased(cfg, "search"))
      throw refusal(403, "Live Web Search isn't available right now.", "search_unavailable");
    if (routine.private_only && !isReleased(cfg, "private"))
      throw refusal(403, "Private Mode isn't available right now.", "private_unavailable");
    const m = ctx.models.getModel(routine.model);
    if (m.type !== "chat")
      throw refusal(400, "This endpoint supports chat models.", "unsupported_model");
    if (routine.private_only && !isPrivateModel(m, cfg))
      throw refusal(400, "Private mode needs a model with zero data retention.", "private_model_required");
    const messages = [{ role: "user", content: routine.prompt }];
    const month = monthSpend(db, routine);
    const left = routine.monthly_budget - month.spent - month.held;
    const sizing = {
      factor: markupFactor(user, cfg),
      feeUnits: routine.web_search ? usdUnits(cfg.webSearchPrice) : 0,
      longAnswers: isReleased(cfg, "longanswers"),
    };
    const fitted = replyBudgetFor(m, messages, {
      ...sizing,
      cap: Math.min(routine.run_cap, left),
    });
    if (!fitted) {
      if (!replyBudgetFor(m, messages, { ...sizing, cap: routine.run_cap }))
        throw refusal(
          402,
          `This run could cost more than the routine's per-run maximum of ${credits(routine.run_cap)} credits with this model and prompt.`,
          "routine_run_cap",
        );
      throw refusal(
        402,
        `This routine's monthly budget has ${credits(Math.max(0, left))} of ${credits(routine.monthly_budget)} credits left, not enough for this run.`,
        "routine_budget",
      );
    }
    // Checked with the reservation, atomically (core.js reserve()).
    const reserveGuard = (held) => {
      const alive = db
        .prepare(
          "SELECT r.* FROM routines r JOIN users u ON u.id=r.user_id AND u.deleted IS NULL WHERE r.id=? AND r.enabled=1",
        )
        .get(routine.id);
      if (!alive)
        fail(409, "This routine was switched off or deleted before it ran.", "routine_gone");
      if (held > alive.run_cap)
        fail(402, `This run could cost more than the routine's per-run maximum of ${credits(alive.run_cap)} credits.`, "routine_run_cap");
      const month = monthSpend(db, alive);
      if (month.spent + month.held + held > alive.monthly_budget)
        fail(402, "This routine's monthly budget can't cover this run.", "routine_budget");
    };
    let captured = null;
    const fakeReq = {
      body: {
        model: m.id,
        messages,
        max_tokens: fitted.max,
        stream: false,
        ...(routine.web_search ? { web_search: true } : {}),
      },
      user,
      headers: { "idempotency-key": requestIdFor(routine, slot) },
      privateOnly: !!routine.private_only,
      discardMedia: true,
      reserveGuard,
    };
    const fakeRes = {
      set() {
        return this;
      },
      flushHeaders() {},
      write() {},
      end() {},
      on(event, fn) {
        if (event === "close") closeListeners.add(fn);
        return this;
      },
      json(payload) {
        captured = payload;
      },
      destroyed: false,
      writableEnded: false,
    };
    await ctx.runChat(fakeReq, fakeRes, true);
    const message = captured?.choices?.[0]?.message || {};
    const extension = captured?.anonyma || {};
    return {
      answer: typeof message.content === "string" ? message.content : "",
      citations: message.citations || null,
      receipt: extension.signed_receipt || null,
      finish_reason: extension.finish_reason || null,
      reply_budget: fitted.max,
    };
  }

  function finish(claimed, outcome) {
    const hold = `${claimed.routine.user_id}:${requestIdFor(claimed.routine, claimed.slot)}`;
    const h = db.prepare("SELECT status,result FROM holds WHERE id=?").get(hold);
    const charged = h?.status === "settled" ? JSON.parse(h.result).charged || 0 : 0;
    const status = outcome.error ? (h ? "failed" : "refused") : "done";
    const at = now();
    // A routine deleted mid-run took its inbox row with it: nothing to keep.
    db.prepare(
      "UPDATE routine_runs SET status=?,finished=?,charged=?,answer=?,citations=?,receipt=?,finish_reason=?,reply_budget=?,code=?,message=? WHERE id=?",
    ).run(
      status,
      at,
      charged,
      outcome.answer ?? null,
      outcome.citations?.length ? JSON.stringify(outcome.citations) : null,
      outcome.receipt ? JSON.stringify(outcome.receipt) : null,
      outcome.finish_reason ?? null,
      outcome.reply_budget ?? null,
      outcome.error?.code || null,
      outcome.error ? String(outcome.error.message || "The run failed.").slice(0, 1000) : null,
      claimed.runId,
    );
    db.prepare(
      "UPDATE routines SET running_since=NULL,last_run=?,last_status=? WHERE id=?",
    ).run(claimed.slot, status, claimed.routine.id);
    // The inbox keeps each routine's newest KEEP_RUNS runs.
    db.prepare(
      `DELETE FROM routine_runs WHERE routine_id=? AND id NOT IN
        (SELECT id FROM routine_runs WHERE routine_id=? ORDER BY started DESC,rowid DESC LIMIT ${KEEP_RUNS})`,
    ).run(claimed.routine.id, claimed.routine.id);
  }

  async function execute(claimed, closeListeners) {
    let outcome;
    try {
      outcome = await perform(claimed, closeListeners);
    } catch (e) {
      outcome = { error: e };
    }
    try {
      finish(claimed, outcome);
    } catch (e) {
      // The database may be closing with the service. A lock left behind
      // is cleared at the next start, like any interrupted run.
      if (closed) return;
      console.error("Routine run not recorded:", e.message);
      try {
        db.prepare("UPDATE routines SET running_since=NULL WHERE id=?").run(
          claimed.routine.id,
        );
      } catch {}
    }
  }

  // Starts every due run there's room for; returns without waiting.
  function startDue() {
    if (closed || !routinesLive(cfg)) return;
    const at = now();
    const due = db
      .prepare(
        "SELECT r.id FROM routines r JOIN users u ON u.id=r.user_id AND u.deleted IS NULL WHERE r.enabled=1 AND r.next_run<=? AND r.running_since IS NULL ORDER BY r.next_run LIMIT ?",
      )
      .all(at, MAX_CONCURRENT * 2);
    for (const { id } of due) {
      if (running.size >= MAX_CONCURRENT) break;
      if (running.has(id)) continue;
      const claimed = claim(id, at);
      if (!claimed) continue;
      const closeListeners = new Set();
      const promise = execute(claimed, closeListeners).finally(() =>
        running.delete(id),
      );
      running.set(id, {
        promise,
        user: claimed.routine.user_id,
        // Stops the run like a client leaving: at once if the provider has
        // accepted it, otherwise once it does (or after 15 seconds).
        cancel: () => closeListeners.forEach((fn) => fn()),
      });
    }
  }
  const idle = () =>
    Promise.allSettled([...running.values()].map((r) => r.promise));
  return {
    startDue,
    idle,
    isRunning: (id) => running.has(id),
    // Stops an account's runs in flight (its routines are being wiped).
    cancelFor(user) {
      for (const r of running.values()) if (r.user === user) r.cancel();
    },
    async stop() {
      closed = true;
      for (const r of running.values()) r.cancel();
      await idle();
    },
  };
}

export { MAX_ROUTINES, KEEP_RUNS };
