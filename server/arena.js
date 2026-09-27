// Blind Arena (update "arena"): a public leaderboard from Blind Compare votes
// that accounts chose to contribute. Pure maths plus the two small tables it
// reads and writes (the migration is in core.js):
//
// - arena_consent: one row per account that has been asked, holding only
//   its choice ("asked" before an answer, then "yes" or "no"). Absent means
//   never asked, which counts as no. Off by default; erased with the
//   account's content (closure and Panic Wipe) and listed in its export.
// - arena_tally: the anonymous aggregate. Per UTC day and model pair, only
//   counts: how often each model won, ties and both bad. No account id, no
//   vote id, no time finer than the day, and one row per (day, pair) rather
//   than per vote (WITHOUT ROWID), so a count can't be traced back to the
//   vote or the account that added it, even by insertion order. It stays
//   when an account is erased or stops contributing.
//
// Ranking: Bradley–Terry scores (an Elo-like scale, the average model at
// 1000) fitted by the MM algorithm, with 95% intervals from a seeded Poisson
// bootstrap. A tie counts half a win for each model, and so does "both bad":
// it says neither reply was better. A light prior (one virtual tie with an
// average model each) keeps a short perfect record from an infinite score.

// The outcomes a Blind vote can have (src/blind.js OUTCOMES).
const OUTCOMES = ["a", "b", "tie", "bad"];
export const CHOICES = ["asked", "yes", "no"];
// A model is listed once at least this many contributed votes involve it.
export const MIN_VOTES = 20;
// The leaderboard is recomputed at most once an hour.
export const CACHE_MS = 60 * 60 * 1000;
export const BOOTSTRAP_ROUNDS = 200;
export const CONFIDENCE = 0.95;
export const PRIOR = 1;
export const BASE = 1000;
export const SCALE = 400;
const SEED = 0x5eed;

// The day a vote is counted under: its UTC date.
export const dayBucket = (t) => new Date(t).toISOString().slice(0, 10);

// A vote in the aggregate's form: the pair in id order, and the column its
// outcome adds to. Null for anything that isn't a vote between two models.
export function tallyCell(a, b, outcome) {
  if (typeof a !== "string" || typeof b !== "string" || !a || !b || a === b) return null;
  if (!OUTCOMES.includes(outcome)) return null;
  const flip = b < a;
  return {
    lo: flip ? b : a,
    hi: flip ? a : b,
    column:
      outcome === "tie"
        ? "ties"
        : outcome === "bad"
          ? "both_bad"
          : (outcome === "a") !== flip
            ? "lo_wins"
            : "hi_wins",
  };
}

// Adds one vote to the aggregate; only the pair, the outcome and the day.
export function addToTally(db, { a, b, outcome, at }) {
  const cell = tallyCell(a, b, outcome);
  if (!cell) return false;
  db.prepare(
    `INSERT INTO arena_tally(day,model_lo,model_hi,${cell.column}) VALUES(?,?,?,1)
     ON CONFLICT(day,model_lo,model_hi) DO UPDATE SET ${cell.column}=${cell.column}+1`,
  ).run(dayBucket(at), cell.lo, cell.hi);
  return true;
}

// The account's choice: "asked", "yes", "no", or null (never asked).
export function arenaChoice(db, user) {
  return db.prepare("SELECT choice FROM arena_consent WHERE user_id=?").get(user)?.choice ?? null;
}
export function setArenaChoice(db, user, choice) {
  if (!CHOICES.includes(choice)) throw Error("Unknown Arena choice");
  db.prepare(
    "INSERT INTO arena_consent(user_id,choice) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET choice=excluded.choice",
  ).run(user, choice);
}
// Account closure and Panic Wipe (eraseAccountContent in routes/account.js):
// the choice goes; votes already in the aggregate stay, since nothing there
// says whose they were.
export function forgetArenaChoice(db, user) {
  db.prepare("DELETE FROM arena_consent WHERE user_id=?").run(user);
}
// The account export: whether it contributes, and whether it was asked.
export function exportArenaChoice(db, user) {
  const choice = arenaChoice(db, user);
  return choice ? { contributing: choice === "yes", asked: true } : null;
}

const count = (n) => (Number.isSafeInteger(n) && n > 0 ? n : 0);

// Totals per pair over every day. Rows whose pair isn't in id order are
// ignored (the table's CHECK keeps them out).
export function pairTotals(rows) {
  const pairs = new Map();
  for (const r of rows || []) {
    const lo = r?.model_lo,
      hi = r?.model_hi;
    if (typeof lo !== "string" || typeof hi !== "string" || !(lo < hi)) continue;
    const key = lo + "\n" + hi;
    const p = pairs.get(key) || { lo, hi, lo_wins: 0, hi_wins: 0, ties: 0, both_bad: 0 };
    p.lo_wins += count(r.lo_wins);
    p.hi_wins += count(r.hi_wins);
    p.ties += count(r.ties);
    p.both_bad += count(r.both_bad);
    pairs.set(key, p);
  }
  return [...pairs.values()];
}

// Bradley–Terry strengths by the MM algorithm (Hunter 2004). `pairs` are
// { lo, hi, wl, wh, t }: wins each way and ties, each tie half a win for
// both. Every model also has `prior` virtual ties with the average model
// (strength 1, the geometric mean), so each strength is finite and positive.
export function fitStrengths(pairs, { prior = PRIOR, start = null, tolerance = 1e-9, maxIterations = 5000 } = {}) {
  if (!(prior > 0)) throw Error("The prior must be positive");
  const ids = [...new Set((pairs || []).flatMap((p) => [p.lo, p.hi]))].sort();
  const index = new Map(ids.map((id, i) => [id, i]));
  const n = ids.length;
  const wins = new Float64Array(n).fill(prior / 2);
  const list = pairs || [];
  const from = new Int32Array(list.length),
    to = new Int32Array(list.length),
    games = new Float64Array(list.length);
  let m = 0;
  for (const p of list) {
    const g = p.wl + p.wh + p.t;
    if (!(g > 0)) continue;
    const i = index.get(p.lo),
      j = index.get(p.hi);
    wins[i] += p.wl + p.t / 2;
    wins[j] += p.wh + p.t / 2;
    from[m] = i;
    to[m] = j;
    games[m++] = g;
  }
  let s = start && start.length === n ? Float64Array.from(start) : new Float64Array(n).fill(1);
  const denom = new Float64Array(n);
  let iterations = 0;
  while (iterations++ < maxIterations) {
    for (let i = 0; i < n; i++) denom[i] = prior / (s[i] + 1);
    for (let e = 0; e < m; e++) {
      const i = from[e],
        j = to[e];
      const d = games[e] / (s[i] + s[j]);
      denom[i] += d;
      denom[j] += d;
    }
    // Rescaled so the geometric mean stays 1: the virtual opponent is the
    // average model, and the overall level can't drift.
    const next = new Float64Array(n);
    let level = 0;
    for (let i = 0; i < n; i++) {
      next[i] = wins[i] / denom[i];
      level += Math.log(next[i]);
    }
    const scale = Math.exp(-level / n);
    let change = 0;
    for (let i = 0; i < n; i++) {
      next[i] *= scale;
      change = Math.max(change, Math.abs(Math.log(next[i] / s[i])));
    }
    s = next;
    if (change < tolerance) break;
  }
  return { ids, strength: s, iterations };
}

// Strengths on the Elo-like scale: 400 points is 10-to-1 odds, and the
// average (geometric mean) model scores 1000.
export function toScores({ ids, strength }) {
  const logs = Array.from(strength, (v) => Math.log10(v));
  const mean = logs.length ? logs.reduce((a, b) => a + b, 0) / logs.length : 0;
  return new Map(ids.map((id, i) => [id, BASE + SCALE * (logs[i] - mean)]));
}

// A small, seeded generator (mulberry32), so the same votes always give the
// same intervals.
export function seeded(seed = SEED) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// A Poisson draw: Knuth's method for small means, the normal approximation
// from 30 up.
export function poisson(lambda, random) {
  if (!(lambda > 0)) return 0;
  if (lambda < 30) {
    const limit = Math.exp(-lambda);
    let k = 0,
      p = 1;
    do {
      k++;
      p *= random();
    } while (p > limit);
    return k - 1;
  }
  const u = random() || Number.MIN_VALUE;
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * random());
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * z));
}
// The value at quantile q of sorted numbers, interpolated.
export function quantile(sorted, q) {
  if (!sorted.length) return NaN;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at),
    hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

// 95% intervals for each model's score: refit on `rounds` resamples, where
// each pair's win and tie counts are drawn from a Poisson with that count as
// its mean (the Poisson bootstrap), and take the middle 95%.
export function bootstrapIntervals(pairs, fit, { rounds = BOOTSTRAP_ROUNDS, confidence = CONFIDENCE, seed = SEED, prior = PRIOR } = {}) {
  const random = seeded(seed);
  const samples = fit.ids.map(() => []);
  for (let b = 0; b < rounds; b++) {
    const drawn = pairs.map((p) => ({
      lo: p.lo,
      hi: p.hi,
      wl: poisson(p.wl, random),
      wh: poisson(p.wh, random),
      t: poisson(p.t, random),
    }));
    const scores = toScores(
      fitStrengths(drawn, { prior, start: fit.strength, tolerance: 1e-5, maxIterations: 1000 }),
    );
    fit.ids.forEach((id, i) => samples[i].push(scores.get(id)));
  }
  const tail = (1 - confidence) / 2;
  return new Map(
    fit.ids.map((id, i) => {
      const sorted = samples[i].sort((x, y) => x - y);
      return [id, [quantile(sorted, tail), quantile(sorted, 1 - tail)]];
    }),
  );
}

// The public leaderboard from the aggregate's rows: every model is fitted,
// and only those with at least `minVotes` votes are listed, ranked by score.
// Nothing here is about an account or a single vote.
export function leaderboard(rows, { minVotes = MIN_VOTES, rounds = BOOTSTRAP_ROUNDS, name = (id) => id } = {}) {
  const totals = pairTotals(rows);
  const stats = new Map();
  const stat = (id) => {
    if (!stats.has(id)) stats.set(id, { votes: 0, points: 0 });
    return stats.get(id);
  };
  let votes = 0;
  const pairs = totals.map((p) => {
    const t = p.ties + p.both_bad;
    const games = p.lo_wins + p.hi_wins + t;
    votes += games;
    const lo = stat(p.lo),
      hi = stat(p.hi);
    lo.votes += games;
    hi.votes += games;
    lo.points += p.lo_wins + t / 2;
    hi.points += p.hi_wins + t / 2;
    return { lo: p.lo, hi: p.hi, wl: p.lo_wins, wh: p.hi_wins, t };
  });
  const listed = [...stats].filter(([, s]) => s.votes >= minVotes && s.votes > 0);
  let models = [];
  if (listed.length) {
    const fit = fitStrengths(pairs);
    const scores = toScores(fit);
    const intervals = bootstrapIntervals(pairs, fit, { rounds });
    models = listed
      .map(([id, s]) => ({
        id,
        name: name(id),
        score: Math.round(scores.get(id)),
        ci: intervals.get(id).map((v) => Math.round(v)),
        votes: s.votes,
        win_rate: Math.round((s.points / s.votes) * 1000) / 1000,
      }))
      .sort((x, y) => y.score - x.score || y.votes - x.votes || x.id.localeCompare(y.id))
      .map((m, i) => ({ rank: i + 1, ...m }));
  }
  return {
    votes,
    minVotes,
    waiting: [...stats.values()].filter((s) => s.votes > 0).length - listed.length,
    models,
  };
}

// Whether a round's vote can be added: a sealed round token marks rounds
// that are saved chats in chat or code (routes/blind.js). Off-the-record
// rounds (device-only chats are sent off the record) and Private Mode ones
// never are, and neither are Uncensored ones, whose models are only ever
// compared with each other.
export const arenaEligible = (round) => round?.ar === 1;
