import { now, fail, credits, keySpendTotal } from "../core.js";

// Owner-only endpoints that turn an API key into a budgeted agent
// credential: a lifetime credit allowance, an expiry, a pause switch and a
// label. The limits themselves are enforced where the key is authorized and
// its hold is reserved, in core.js reserve() — this file only manages them.
function ownedKey(db, req) {
  const k = db
    .prepare(
      "SELECT * FROM api_keys WHERE id=? AND user_id=? AND revoked IS NULL",
    )
    .get(req.params.id, req.user.id);
  if (!k) fail(404, "Key not found.");
  return k;
}
function inFlight(db, id) {
  return db
    .prepare(
      "SELECT COALESCE(SUM(amount),0) n FROM holds WHERE key_id=? AND status='held'",
    )
    .get(id).n;
}
function usageJSON(db, k) {
  const spentTotal = keySpendTotal(db, k.id);
  const held = inFlight(db, k.id);
  const requests = db
    .prepare("SELECT COUNT(*) n FROM ledger WHERE key_id=? AND amount<0")
    .get(k.id).n;
  return {
    spent_total: credits(spentTotal),
    in_flight: credits(held),
    allowance_total:
      k.allowance_total == null ? null : credits(k.allowance_total),
    remaining:
      k.allowance_total == null
        ? null
        : credits(Math.max(0, k.allowance_total - spentTotal - held)),
    expires_at: k.allowance_expires,
    paused: k.paused_at != null,
    last_used: k.last_used,
    requests,
  };
}

export function allowanceRoutes({ app, db, requireUser }) {
  app.patch("/api/keys/:id/allowance", requireUser, (req, res) => {
    const k = ownedKey(db, req);
    let total = k.allowance_total,
      expires = k.allowance_expires,
      label = k.agent_label;
    if (Object.hasOwn(req.body, "total_credits")) {
      const v = req.body.total_credits;
      if (v == null) total = null;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1e9)
          fail(400, "Invalid allowance total.");
        total = Math.floor(n * 10000);
      }
    }
    if (Object.hasOwn(req.body, "expires_at")) {
      const v = req.body.expires_at;
      if (v == null) expires = null;
      else {
        const n = Number(v);
        if (!Number.isSafeInteger(n) || n < 0) fail(400, "Invalid expiry.");
        expires = n;
      }
    }
    if (Object.hasOwn(req.body, "label")) {
      const v = req.body.label;
      label = v == null ? null : String(v).trim().slice(0, 60) || null;
    }
    db.prepare(
      "UPDATE api_keys SET allowance_total=?,allowance_expires=?,agent_label=? WHERE id=?",
    ).run(total, expires, label, k.id);
    res.json(
      usageJSON(db, {
        ...k,
        allowance_total: total,
        allowance_expires: expires,
        agent_label: label,
      }),
    );
  });
  app.post("/api/keys/:id/pause", requireUser, (req, res) => {
    const k = ownedKey(db, req);
    const at = now();
    db.prepare("UPDATE api_keys SET paused_at=? WHERE id=?").run(at, k.id);
    res.json(usageJSON(db, { ...k, paused_at: at }));
  });
  app.post("/api/keys/:id/resume", requireUser, (req, res) => {
    const k = ownedKey(db, req);
    db.prepare("UPDATE api_keys SET paused_at=NULL WHERE id=?").run(k.id);
    res.json(usageJSON(db, { ...k, paused_at: null }));
  });
  app.get("/api/keys/:id/usage", requireUser, (req, res) => {
    const k = ownedKey(db, req);
    res.json(usageJSON(db, k));
  });
}
