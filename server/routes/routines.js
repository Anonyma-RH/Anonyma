import { now, uid, fail, transaction } from "../core.js";
import {
  MAX_ROUTINES,
  KEEP_RUNS,
  createRoutineRunner,
  routineInput,
  routineView,
  runView,
  listRoutines,
  scheduleOf,
} from "../routines.js";
import { nextRunAfter } from "../../src/routines.js";
import { viewerOf } from "../early-models.js";

// Routines: saved prompts on a schedule with their own budget, and the
// inbox their runs land in (server/routines.js). The release gate in
// releases.js refuses these routes while the update is unreleased (and asks
// for Live Web Search or Private Mode when a routine turns those on), and the
// worker starts no runs then.
export function routineRoutes(ctx) {
  const { app, db, limit, requireUser } = ctx;
  const runner = createRoutineRunner(ctx);
  const read = limit("routines-read", 120, 60000);
  const write = limit("routines", 120, 3600000);
  const owned = (id, user) => {
    const row =
      typeof id === "string" &&
      db.prepare("SELECT * FROM routines WHERE id=? AND user_id=?").get(id, user);
    if (!row) fail(404, "Routine not found.", "routine_not_found");
    return row;
  };
  // Switching on, or changing when it runs, starts from the next slot after
  // now: saving never makes a routine run at once.
  const nextFor = (row) =>
    row.enabled ? nextRunAfter(scheduleOf(row), now()) : null;
  app.get("/api/routines", requireUser, read, (req, res) =>
    res.json({
      routines: listRoutines(db, req.user.id),
      max_routines: MAX_ROUTINES,
      keep_runs: KEEP_RUNS,
    }),
  );
  app.post("/api/routines", requireUser, write, (req, res) => {
    const r = routineInput(ctx, req.body);
    // Early Model Access: a model in its early days needs Insider tier and
    // up to be chosen (and again at every run, in runChat).
    ctx.earlyModels.check(viewerOf(req), "models", r.model);
    const id = uid("rt_");
    transaction(db, () => {
      const n = db
        .prepare("SELECT COUNT(*) n FROM routines WHERE user_id=?")
        .get(req.user.id).n;
      if (n >= MAX_ROUTINES)
        fail(
          409,
          `You can have up to ${MAX_ROUTINES} routines. Delete one to add another.`,
          "routine_limit",
        );
      const at = now();
      db.prepare(
        "INSERT INTO routines(id,user_id,name,prompt,model,web_search,private_only,repeat,minute,weekday,timezone,run_cap,monthly_budget,enabled,next_run,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        req.user.id,
        r.name,
        r.prompt,
        r.model,
        r.web_search,
        r.private_only,
        r.repeat,
        r.minute,
        r.weekday,
        r.timezone,
        r.run_cap,
        r.monthly_budget,
        r.enabled,
        nextFor(r),
        at,
        at,
      );
    });
    res
      .status(201)
      .json(
        routineView(db, db.prepare("SELECT * FROM routines WHERE id=?").get(id)),
      );
  });
  app.patch("/api/routines/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    const r = routineInput(ctx, req.body, row);
    if (Object.hasOwn(req.body || {}, "model"))
      ctx.earlyModels.check(viewerOf(req), "models", r.model);
    const reschedule =
      Object.hasOwn(req.body, "schedule") || !!r.enabled !== !!row.enabled;
    db.prepare(
      "UPDATE routines SET name=?,prompt=?,model=?,web_search=?,private_only=?,repeat=?,minute=?,weekday=?,timezone=?,run_cap=?,monthly_budget=?,enabled=?,next_run=?,updated=? WHERE id=? AND user_id=?",
    ).run(
      r.name,
      r.prompt,
      r.model,
      r.web_search,
      r.private_only,
      r.repeat,
      r.minute,
      r.weekday,
      r.timezone,
      r.run_cap,
      r.monthly_budget,
      r.enabled,
      reschedule ? nextFor(r) : row.next_run,
      now(),
      row.id,
      req.user.id,
    );
    res.json(
      routineView(db, db.prepare("SELECT * FROM routines WHERE id=?").get(row.id)),
    );
  });
  app.delete("/api/routines/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    if (row.running_since != null || runner.isRunning(row.id))
      fail(
        409,
        "This routine is running. Delete it once the run finishes.",
        "routine_running",
      );
    // Its inbox goes with it (ON DELETE CASCADE).
    db.prepare("DELETE FROM routines WHERE id=? AND user_id=?").run(
      row.id,
      req.user.id,
    );
    res.json({ ok: true });
  });
  // The inbox, newest first: every routine's runs, or one routine's.
  app.get("/api/routines/runs", requireUser, read, (req, res) => {
    const filter = req.query.routine;
    if (filter != null) owned(filter, req.user.id);
    const before = req.query.before == null ? null : Number(req.query.before);
    if (before != null && !Number.isSafeInteger(before))
      fail(400, "before must be a run's started_at time.", "invalid_request");
    const rows = db
      .prepare(
        `SELECT x.*,r.name routine_name FROM routine_runs x JOIN routines r ON r.id=x.routine_id
          WHERE x.user_id=? ${filter != null ? "AND x.routine_id=?" : ""} ${before != null ? "AND x.started<?" : ""}
          ORDER BY x.started DESC,x.rowid DESC LIMIT ?`,
      )
      .all(
        req.user.id,
        ...(filter != null ? [filter] : []),
        ...(before != null ? [before] : []),
        KEEP_RUNS + 1,
      );
    res.json({
      runs: rows.slice(0, KEEP_RUNS).map(runView),
      more: rows.length > KEEP_RUNS,
    });
  });
  app.delete("/api/routines/runs/:id", requireUser, write, (req, res) => {
    const run = db
      .prepare("SELECT * FROM routine_runs WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!run) fail(404, "Run not found.", "run_not_found");
    if (run.status === "running")
      fail(409, "This run is still in progress.", "routine_running");
    db.prepare("DELETE FROM routine_runs WHERE id=?").run(run.id);
    res.json({ ok: true });
  });
  return runner;
}
