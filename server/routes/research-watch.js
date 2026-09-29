import {
  now,
  uid,
  fail,
  credits,
  balance,
  callable,
  markupFactor,
  transaction,
  imageCallable,
} from "../core.js";
import { isReleased } from "../releases.js";
import { isPrivateModel } from "../private-mode.js";
import { viewerOf } from "../early-models.js";
import { AUTO_NOT_OFFERED } from "../auto-model.js";
import { limitsLive, spendingRoom } from "../spending-limits.js";
import { KEEP_RUNS, bool, listRoutines, parseSchedule, routineView, units } from "../routines.js";
import { watchCosts } from "../research-watch.js";
import { MAX_BUDGET_CREDITS, NAME_LIMIT, nextRunAfter } from "../../src/routines.js";
import { DEPTHS } from "../../src/deep-research.js";
import {
  MAX_WATCHES,
  TOPIC_LIMIT,
  WATCH_REPEATS,
  defaultName,
} from "../../src/research-watch.js";
import { findSeedPhrase } from "../../src/seed-guard.js";

// Research Watch's routes (update "researchwatch", which also needs Routines,
// Deep Research and Live Web Search; see featuresFor). A watch is a routine
// of kind "research" (server/research-watch.js runs it): these routes make,
// change, switch and delete one, and quote what a run can cost. Its reports
// are in the Routines inbox (/api/routines/runs), and it is erased and
// exported with the account's routines.
const WATCH_SEED_MESSAGE =
  "This looks like a wallet seed phrase. A watch's topic is saved and sent to web searches on every run, so ANONYMA won't save one. Remove it to continue.";

export function researchWatchRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const runner = ctx.routines;
  const read = limit("research-watch-read", 120, 60000);
  const write = limit("research-watch", 120, 3600000);
  const quoteLimit = limit("research-watch-quote", 120, 60000);
  const owned = (id, user) => {
    const row =
      typeof id === "string" &&
      db
        .prepare("SELECT * FROM routines WHERE id=? AND user_id=? AND kind='research'")
        .get(id, user);
    if (!row) fail(404, "Research watch not found.", "watch_not_found");
    return row;
  };
  const nextFor = (row) =>
    row.enabled ? nextRunAfter({ repeat: row.repeat, minute: row.minute, day: row.weekday, timezone: row.timezone }, now()) : null;

  // The model, depth and mode a watch runs with, checked the way a run
  // would: a text model this installation can run, private when asked.
  function modelOf(next) {
    const m = ctx.models.find(next.model);
    if (
      !m ||
      m.type !== "chat" ||
      !callable(m, cfg) ||
      imageCallable(m) ||
      (m.architecture?.output_modalities || []).includes("image")
    )
      fail(400, "Choose a chat model you can use.", "invalid_model");
    if (next.private_only && !isPrivateModel(m, cfg))
      fail(400, "Private models only needs a model with zero data retention.", "private_model_required");
    return m;
  }

  // A watch's stored fields from a create (every field but the optional
  // ones) or an update (the fields sent; the rest are kept).
  function watchInput(body, existing = null) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      fail(400, "Send the watch as a JSON object.", "invalid_watch");
    // Auto Model is for chat composers: a watch runs on the one model chosen.
    if (body.auto !== undefined) fail(400, AUTO_NOT_OFFERED, "auto_not_offered");
    const has = (k) => Object.hasOwn(body, k);
    const next = existing ? { ...existing } : { kind: "research", web_search: 1 };
    const need = (k) => {
      if (!existing && !has(k)) fail(400, `Add the watch's ${k}.`, "invalid_watch");
      return has(k);
    };
    if (need("topic")) {
      const topic = typeof body.topic === "string" ? body.topic.trim() : "";
      if (!topic || topic.length > TOPIC_LIMIT)
        fail(400, `Give the watch a topic of 1 to ${TOPIC_LIMIT} characters.`, "invalid_watch");
      // Seed Guard, with no override: the topic becomes web searches on every run.
      if (isReleased(cfg, "seedguard") && findSeedPhrase(topic))
        fail(400, WATCH_SEED_MESSAGE, "seed_phrase_blocked");
      next.prompt = topic;
    }
    if (has("name") || !existing) {
      const raw = typeof body.name === "string" ? body.name.trim() : "";
      if (raw.length > NAME_LIMIT)
        fail(400, `Keep the name to ${NAME_LIMIT} characters or fewer.`, "invalid_watch");
      next.name = raw || defaultName(next.prompt, 60);
    }
    if (need("model")) {
      if (typeof body.model !== "string" || body.model.length > 200)
        fail(400, "Choose a model.", "invalid_watch");
      next.model = body.model;
    }
    if (need("depth")) {
      if (!Object.hasOwn(DEPTHS, body.depth))
        fail(400, "Choose Quick or Thorough research.", "invalid_watch");
      next.depth = body.depth;
    }
    next.new_only = has("new_only") ? bool(body.new_only, "new_only") : (next.new_only ?? 0);
    next.private_only = has("private_only")
      ? bool(body.private_only, "private_only")
      : (next.private_only ?? 0);
    next.enabled = has("enabled") ? bool(body.enabled, "enabled") : (next.enabled ?? 1);
    if (need("schedule"))
      Object.assign(
        next,
        parseSchedule(body.schedule, {
          repeats: WATCH_REPEATS,
          repeatMessage: "Repeat daily or weekly.",
          what: "watch",
        }),
      );
    if (need("monthly_budget_credits"))
      next.monthly_budget = units(body.monthly_budget_credits, MAX_BUDGET_CREDITS, "monthly budget");
    return next;
  }

  // The most one run can cost with this watch's model, depth, topic and mode,
  // at this account's rate: the number the page shows, the watch keeps as its
  // per-run maximum and a run holds.
  function costOf(user, next) {
    const m = modelOf(next);
    const costs = watchCosts({
      cfg,
      m,
      topic: next.prompt,
      depth: next.depth,
      newOnly: !!next.new_only,
      factor: markupFactor(user, cfg),
    });
    ctx.models.validateContext(costs.messages.plan, m, costs.budget.plan);
    ctx.models.validateContext(costs.messages.write, m, costs.budget.write);
    return { m, costs };
  }

  app.get("/api/research-watches", requireUser, read, (req, res) =>
    res.json({
      watches: listRoutines(db, req.user.id, now(), "research"),
      max_watches: MAX_WATCHES,
      keep_runs: KEEP_RUNS,
    }),
  );

  // What a run can cost at most, before anything is saved. Holds and charges
  // nothing.
  app.post("/api/research-watches/quote", requireUser, quoteLimit, (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    if (body.auto !== undefined) fail(400, AUTO_NOT_OFFERED, "auto_not_offered");
    if (!Object.hasOwn(DEPTHS, body.depth))
      fail(400, "Choose Quick or Thorough research.", "invalid_watch");
    const topic =
      typeof body.topic === "string" && body.topic.trim()
        ? body.topic.trim().slice(0, TOPIC_LIMIT)
        : "x".repeat(TOPIC_LIMIT);
    const next = {
      prompt: topic,
      model: typeof body.model === "string" ? body.model : "",
      depth: body.depth,
      new_only: body.new_only === true ? 1 : 0,
      private_only: body.private_only === true ? 1 : 0,
    };
    ctx.earlyModels.check(viewerOf(req), "models", next.model);
    const { m, costs } = costOf(req.user, next);
    const room = limitsLive(cfg) ? spendingRoom(db, req.user.id) : null;
    res.json({
      credits: credits(costs.total),
      usd: costs.total / 1e7,
      available: credits(balance(db, req.user.id).available),
      ...(room != null ? { spending_limit: { remaining: credits(room) } } : {}),
      model: m.id,
      depth: body.depth,
      searches: costs.cap,
      steps: {
        plan: credits(costs.amounts.plan),
        search: credits(costs.amounts.search),
        write: credits(costs.amounts.write),
      },
      min_monthly_budget_credits: credits(costs.total),
      estimate: true,
    });
  });

  const budgetMessage = (total) =>
    `A run can cost up to ${credits(total)} credits, so the monthly budget must be at least that.`;

  app.post("/api/research-watches", requireUser, write, (req, res) => {
    const r = watchInput(req.body);
    // Early Model Access: a model in its early days needs Insider tier and
    // up (and again at every run, when the watch's steps are made).
    ctx.earlyModels.check(viewerOf(req), "models", r.model);
    const { costs } = costOf(req.user, r);
    r.run_cap = costs.total;
    if (r.monthly_budget < r.run_cap)
      fail(400, budgetMessage(r.run_cap), "watch_budget_too_small");
    const id = uid("rt_");
    transaction(db, () => {
      const n = db
        .prepare("SELECT COUNT(*) n FROM routines WHERE user_id=? AND kind='research'")
        .get(req.user.id).n;
      if (n >= MAX_WATCHES)
        fail(
          409,
          `You can have up to ${MAX_WATCHES} research watches. Delete one to add another.`,
          "watch_limit",
        );
      const at = now();
      db.prepare(
        "INSERT INTO routines(id,user_id,name,prompt,model,web_search,private_only,repeat,minute,weekday,timezone,run_cap,monthly_budget,enabled,next_due,created,updated,kind,depth,new_only) VALUES(?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?,'research',?,?)",
      ).run(
        id,
        req.user.id,
        r.name,
        r.prompt,
        r.model,
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
        r.depth,
        r.new_only,
      );
    });
    res
      .status(201)
      .json(routineView(db, db.prepare("SELECT * FROM routines WHERE id=?").get(id)));
  });

  app.patch("/api/research-watches/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    const r = watchInput(req.body, row);
    if (Object.hasOwn(req.body, "model"))
      ctx.earlyModels.check(viewerOf(req), "models", r.model);
    // Switching a watch off never needs a new quote; anything else re-prices
    // it, so its per-run maximum is what a run would hold now.
    const keys = Object.keys(req.body);
    const offOnly = keys.length === 1 && keys[0] === "enabled" && !r.enabled;
    if (!offOnly) {
      const { costs } = costOf(req.user, r);
      r.run_cap = costs.total;
      if (r.monthly_budget < r.run_cap)
        fail(400, budgetMessage(r.run_cap), "watch_budget_too_small");
    }
    const reschedule =
      Object.hasOwn(req.body, "schedule") || !!r.enabled !== !!row.enabled;
    db.prepare(
      "UPDATE routines SET name=?,prompt=?,model=?,private_only=?,repeat=?,minute=?,weekday=?,timezone=?,run_cap=?,monthly_budget=?,enabled=?,next_due=?,updated=?,depth=?,new_only=? WHERE id=? AND user_id=? AND kind='research'",
    ).run(
      r.name,
      r.prompt,
      r.model,
      r.private_only,
      r.repeat,
      r.minute,
      r.weekday,
      r.timezone,
      r.run_cap,
      r.monthly_budget,
      r.enabled,
      reschedule ? nextFor(r) : row.next_due,
      now(),
      r.depth,
      r.new_only,
      row.id,
      req.user.id,
    );
    res.json(routineView(db, db.prepare("SELECT * FROM routines WHERE id=?").get(row.id)));
  });

  app.delete("/api/research-watches/:id", requireUser, write, (req, res) => {
    const row = owned(req.params.id, req.user.id);
    if (row.running_since != null || runner.isRunning(row.id))
      fail(409, "This watch is running. Delete it once the run finishes.", "routine_running");
    // Its reports go with it (ON DELETE CASCADE).
    db.prepare("DELETE FROM routines WHERE id=? AND user_id=? AND kind='research'").run(
      row.id,
      req.user.id,
    );
    res.json({ ok: true });
  });
}
