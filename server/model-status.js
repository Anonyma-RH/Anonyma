// Model Status (update "status"): whether each model is up, and how fast it
// starts answering, measured from ANONYMA's own traffic.
//
// Kept IN MEMORY only, for the last hour: for each model, when a request
// ended, its outcome (ok, provider error or timeout) and its timings. Never
// who sent it, what it said, or anything else about the request, and never
// written anywhere: a restart starts it empty. Requests refused before they
// were sent (too few credits, a spending limit, Seed Guard, a bad request),
// requests the person stopped, and requests the provider turned down as
// invalid for that request alone (400, 413, 422) don't count: they say
// nothing about whether the model is up. Nothing is recorded until the
// update is released.
//
// What's published (GET /api/status and /status) is aggregated per model and
// per model family (the model's maker), and only once a window holds at least
// MIN_SAMPLES requests, so no one person's use can be picked out:
// - status, from the share of counted requests that failed or timed out in
//   the last 15 minutes: Degraded from DEGRADED_AT, Down from DOWN_AT;
// - the median and p90 time to first token, and the median time to a full
//   response, over the last hour (successful requests only).

export const STATUS_WINDOW_MS = 15 * 60 * 1000;
export const TIMING_WINDOW_MS = 60 * 60 * 1000;
export const MIN_SAMPLES = 5;
export const DEGRADED_AT = 0.2;
export const DOWN_AT = 0.5;
// GET /api/status is computed at most this often.
export const CACHE_MS = 30 * 1000;
// Memory bounds: the newest events per model, and how many models are kept.
export const MAX_EVENTS = 5000;
export const MAX_MODELS = 2000;

const OUTCOMES = new Set(["ok", "error", "timeout"]);
// Provider failures that count against a model.
const PROVIDER_ERRORS = new Set([
  "provider_down",
  "provider_busy",
  "provider_unavailable",
  "provider_interrupted",
  "provider_unreadable",
  "provider_rejected",
  "provider_ambiguous",
  "empty_output",
]);
// Upstream statuses that reject one request (malformed, too large, against
// the provider's rules) rather than say the model is down.
const REQUEST_REJECTIONS = new Set([400, 413, 422]);
// Why a request's own abort signal fired, when it wasn't the model's fault.
const NOT_THE_MODEL = new Set(["Client disconnected", "Service restarting"]);

// What a failed request says about its model: "timeout", "error", or null
// when it doesn't count (stopped, restarting, refused by ANONYMA, or turned
// down by the provider as invalid for that request alone).
export function outcomeOf(e, signal) {
  if (signal?.aborted) {
    const why = signal.reason?.message;
    if (NOT_THE_MODEL.has(why)) return null;
    // The request's own deadline (chat and research say "Provider timeout";
    // the image routes' deadline aborts without a reason).
    return "timeout";
  }
  if (e?.code === "provider_timeout" || e?.name === "TimeoutError") return "timeout";
  if (!PROVIDER_ERRORS.has(e?.code)) return null;
  if (e.code === "provider_rejected") {
    const upstream = Number(e.upstreamStatus ?? e.status);
    if (REQUEST_REJECTIONS.has(upstream)) return null;
  }
  return "error";
}

// Nearest-rank percentile of an ascending list: at least `p` of the values
// are at or below it.
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1];
}

// Up / degraded / down from outcomes, or "unknown" below MIN_SAMPLES.
export function statusFrom(counted, failed) {
  if (counted < MIN_SAMPLES) return "unknown";
  const rate = failed / counted;
  if (rate >= DOWN_AT) return "down";
  if (rate >= DEGRADED_AT) return "degraded";
  return "up";
}

// Median and p90 of a list of durations (ms), rounded to 0.1 s, or null
// below MIN_SAMPLES.
function timing(values, { p90 = true } = {}) {
  if (values.length < MIN_SAMPLES) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const round = (ms) => Math.round(ms / 100) * 100;
  return {
    median: round(percentile(sorted, 0.5)),
    ...(p90 ? { p90: round(percentile(sorted, 0.9)) } : {}),
  };
}

// The aggregates for one list of events at time `t`.
export function summarize(events, t) {
  let counted = 0,
    failed = 0;
  const firsts = [],
    totals = [];
  for (const e of events) {
    if (e.t <= t - TIMING_WINDOW_MS || e.t > t) continue;
    if (e.t > t - STATUS_WINDOW_MS) {
      counted++;
      if (e.outcome !== "ok") failed++;
    }
    if (e.outcome === "ok") {
      if (e.ttft != null) firsts.push(e.ttft);
      if (e.total != null) totals.push(e.total);
    }
  }
  return {
    status: statusFrom(counted, failed),
    ttft: timing(firsts),
    total: timing(totals, { p90: false }),
  };
}

const duration = (ms) =>
  Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : null;

// `enabled()` says whether to record at all (the update is released).
export function createModelStatus({ clock = Date.now, enabled = () => true } = {}) {
  // model id -> [{ t, outcome, ttft, total }], oldest first.
  const byModel = new Map();
  const prune = (list, t) => {
    let drop = 0;
    while (drop < list.length && list[drop].t <= t - TIMING_WINDOW_MS) drop++;
    if (list.length - drop > MAX_EVENTS) drop = list.length - MAX_EVENTS;
    if (drop) list.splice(0, drop);
  };
  function record(model, outcome, { ttft = null, total = null } = {}) {
    if (!enabled() || typeof model !== "string" || !model || !OUTCOMES.has(outcome))
      return;
    const t = clock();
    let list = byModel.get(model);
    if (!list) {
      if (byModel.size >= MAX_MODELS) {
        // Make room: drop models with nothing left in the window, then the
        // least recently used one.
        for (const [id, events] of byModel) {
          prune(events, t);
          if (!events.length) byModel.delete(id);
        }
        if (byModel.size >= MAX_MODELS) {
          let oldest = null;
          for (const [id, events] of byModel)
            if (!oldest || events.at(-1).t < oldest[1]) oldest = [id, events.at(-1).t];
          byModel.delete(oldest[0]);
        }
      }
      byModel.set(model, (list = []));
    }
    list.push({
      t,
      outcome,
      ttft: outcome === "ok" ? duration(ttft) : null,
      total: outcome === "ok" ? duration(total) : null,
    });
    prune(list, t);
  }
  // One request to `model`, from the moment it's sent upstream: first()
  // marks its first token, ok() or done() its end, fail(e, signal) a failure.
  // Only the first ending counts; nothing counts if it was never sent.
  function start(model) {
    let sentAt = null,
      firstAt = null,
      ended = false;
    const end = () => {
      if (ended || sentAt == null) return false;
      ended = true;
      return true;
    };
    const probe = {
      sent() {
        sentAt ??= clock();
      },
      first() {
        if (sentAt != null && firstAt == null) firstAt = clock();
      },
      ok({ timed = true } = {}) {
        if (!end()) return;
        record(
          model,
          "ok",
          timed
            ? { ttft: firstAt == null ? null : firstAt - sentAt, total: clock() - sentAt }
            : {},
        );
      },
      // A stream that ended: ok with output, a provider error without.
      done(hadOutput) {
        if (hadOutput) probe.ok();
        else probe.fail({ code: "empty_output" });
      },
      fail(e, signal) {
        if (!end()) return;
        const outcome = outcomeOf(e, signal);
        if (outcome) record(model, outcome);
      },
    };
    return probe;
  }
  // A single provider call (images, video submissions): sent now, ok when it
  // resolves, classified when it throws. `timed: false` keeps no timings.
  async function timed(model, fn, { signal, timed: keepTime = true } = {}) {
    const probe = start(model);
    probe.sent();
    try {
      const result = await fn();
      probe.ok({ timed: keepTime });
      return result;
    } catch (e) {
      probe.fail(e, signal);
      throw e;
    }
  }
  // The public report for `models` (the released, callable catalog rows) at
  // time `t`: every family with at least one of them, and only the models
  // whose numbers can be shown. Nothing about any request or person.
  function report(models, t = clock()) {
    const families = new Map();
    for (const m of models) {
      const name = String(m.owned_by || m.provider || "Other");
      if (!families.has(name)) families.set(name, { name, events: [], models: [] });
      const family = families.get(name);
      const events = byModel.get(m.id);
      if (!events?.length) continue;
      family.events.push(...events);
      const summary = summarize(events, t);
      if (summary.status !== "unknown" || summary.ttft || summary.total)
        family.models.push({ id: m.id, name: m.name || m.id, type: m.type, ...summary });
    }
    const ORDER = { down: 0, degraded: 1, up: 2, unknown: 3 };
    const list = [...families.values()]
      .map(({ name, events, models: shown }) => ({
        name,
        ...summarize(events, t),
        models: shown.sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .sort(
        (a, b) =>
          ORDER[a.status] - ORDER[b.status] ||
          (a.ttft || a.total ? 0 : 1) - (b.ttft || b.total ? 0 : 1) ||
          a.name.localeCompare(b.name),
      );
    return {
      checkedAt: t,
      windows: { statusMinutes: STATUS_WINDOW_MS / 60000, timingMinutes: TIMING_WINDOW_MS / 60000 },
      minSamples: MIN_SAMPLES,
      thresholds: { degraded: DEGRADED_AT, down: DOWN_AT },
      families: list,
    };
  }
  return {
    record,
    start,
    timed,
    report,
    now: () => clock(),
    // For tests: every stored event's fields (never more than these four).
    events: () => [...byModel.values()].flat().map((e) => ({ ...e })),
  };
}
