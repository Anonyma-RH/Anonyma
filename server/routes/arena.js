import { fail, now, transaction } from "../core.js";
import { roundSealer, TOKEN_TTL_MS } from "./blind.js";
import {
  CACHE_MS,
  BOOTSTRAP_ROUNDS,
  CONFIDENCE,
  PRIOR,
  addToTally,
  arenaChoice,
  arenaEligible,
  leaderboard,
  setArenaChoice,
} from "../arena.js";

// Blind Arena (update "arena"; server/arena.js). Gated by featuresFor
// ("arena"), so every route here is 403 feature_unreleased until release.
// - GET /api/arena: the public leaderboard. No sign-in, the same answer for
//   everyone, from the anonymous aggregate only, recomputed at most once an
//   hour.
// - GET and PUT /api/arena/consent: the signed-in account's own choice.
//   Saying yes to the question asked after a vote can also add that vote
//   (`round`), once; otherwise only later votes are added.
export function arenaRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  const clock = cfg.arenaClock || Date.now;
  const { open } = roundSealer(cfg.secret);
  let cached = null;

  app.get("/api/arena", (req, res) => {
    const t = clock();
    if (!cached || t - cached.at >= CACHE_MS || t < cached.at) {
      const rows = db
        .prepare("SELECT model_lo,model_hi,lo_wins,hi_wins,ties,both_bad FROM arena_tally")
        .all();
      const board = leaderboard(rows, { name: (id) => ctx.models.find(id)?.name || id });
      cached = {
        at: t,
        body: {
          computedAt: t,
          nextUpdate: t + CACHE_MS,
          ...board,
          method: {
            model: "bradley-terry",
            ties: "half",
            bothBad: "tie",
            prior: PRIOR,
            interval: { confidence: CONFIDENCE, bootstrap: BOOTSTRAP_ROUNDS },
          },
        },
      };
    }
    const left = Math.max(1, Math.ceil((cached.at + CACHE_MS - t) / 1000));
    res.set("Cache-Control", `public, max-age=${Math.min(left, CACHE_MS / 1000)}`).json(cached.body);
  });

  const view = (user) => {
    const choice = arenaChoice(db, user);
    return { contribute: choice === "yes", asked: choice != null };
  };
  app.get("/api/arena/consent", requireUser, (req, res) => res.json(view(req.user.id)));
  app.put("/api/arena/consent", requireUser, limit("arena-consent", 60, 3600000), (req, res) => {
    const { contribute, round } = req.body || {};
    if (typeof contribute !== "boolean")
      fail(400, "contribute must be true or false.", "invalid_request");
    if (round !== undefined && (typeof round !== "string" || contribute !== true))
      fail(400, "round goes only with a yes.", "invalid_request");
    const user = req.user.id;
    const added = transaction(db, () => {
      const before = arenaChoice(db, user);
      setArenaChoice(db, user, contribute ? "yes" : "no");
      // The answer to the question asked after a vote: that vote joins too,
      // once, when it's this account's, eligible and within the voting
      // window. Its outcome and models come from the stored vote.
      if (!contribute || before !== "asked" || round === undefined) return false;
      const p = open(round);
      if (!p || p.v !== 1 || p.u !== user || !arenaEligible(p) || !(now() - p.t <= TOKEN_TTL_MS))
        return false;
      const vote = db
        .prepare("SELECT model_a,model_b,outcome,created FROM blind_votes WHERE id=? AND user_id=?")
        .get(p.id, user);
      return vote
        ? addToTally(db, { a: vote.model_a, b: vote.model_b, outcome: vote.outcome, at: vote.created })
        : false;
    });
    res.json({ ...view(user), added });
  });
}
