import {
  holdingsFor,
  castVote,
  rewardsSummary,
  voteTally,
} from "../holders.js";

// The NYMA Holder Program's routes (server/holders.js). All three are gated
// with the "holders" update in featuresFor (server/releases.js).
export function holderRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  // Account → NYMA holdings: the signed-in account's own tier, cycle,
  // Loyal bonus, last reward, retention caps and roadmap ballot.
  app.get("/api/account/holdings", requireUser, (req, res) =>
    res.json(holdingsFor(db, cfg, req.user)),
  );
  // The Inner Circle's roadmap vote: one per account per UTC month, which
  // voting again changes. 403 inner_circle_only below that tier.
  app.put(
    "/api/holders/vote",
    requireUser,
    limit("holder_vote", 30, 3600000),
    (req, res) => {
      castVote(db, cfg, req.user, String(req.body?.update ?? ""));
      res.json(holdingsFor(db, cfg, req.user).vote);
    },
  );
  // Public transparency for /token: aggregates and counts only, the same
  // for everyone, never who holds, who was paid or who voted.
  app.get("/api/holders/summary", (req, res) =>
    res.json({ rewards: rewardsSummary(db), vote: voteTally(db, cfg) }),
  );
}
