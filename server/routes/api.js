import { hash, now, fail, balance, credits, callable } from "../core.js";
import { isReleased } from "../releases.js";
import { apiTrainingFields, liveIds } from "../training.js";

const bearerKey = (db, req) => {
  const secret = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  return secret
    ? db
        .prepare("SELECT * FROM api_keys WHERE hash=? AND revoked IS NULL")
        .get(hash(secret))
    : null;
};

// OpenAI-compatible connection, model list and balance endpoints.
export function apiRoutes({ app, db, cfg, models }) {
  function apiAuth(req, res, next) {
    const key = bearerKey(db, req);
    if (!key)
      fail(
        401,
        "Provide a valid API key as Bearer authorization.",
        "invalid_api_key",
      );
    const user = db
      .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
      .get(key.user_id);
    if (!user) fail(401, "Account is unavailable.");
    req.user = user;
    req.apiKey = key;
    db.prepare("UPDATE api_keys SET last_used=? WHERE id=?").run(now(), key.id);
    next();
  }
  app.get("/v1", (req, res) => {
    const key = bearerKey(db, req);
    const account = key
      ? db
          .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
          .get(key.user_id)
      : null;
    const msg = {
      service: "Anonyma",
      status: "ok",
      object: "connection",
      endpoints: [
        "/v1/models",
        "/v1/chat/completions",
        ...(isReleased(cfg, "files") ? ["/v1/files"] : []),
        ...(isReleased(cfg, "v1media")
          ? [
              "/v1/images/generations",
              "/v1/audio/speech",
              "/v1/audio/transcriptions",
              "/v1/videos",
            ]
          : []),
      ],
      credits_charged: 0,
      authenticated: !!account,
      models: models.snapshot.data.filter(
        (m) => m.type === "chat" && callable(m, cfg),
      ).length,
      ...(account
        ? {
            account: {
              credits: credits(balance(db, account.id).total),
              available: credits(balance(db, account.id).available),
            },
            key: { name: key.name, prefix: key.prefix },
          }
        : {}),
    };
    if (
      /curl|wget|httpie|powershell|fetch/i.test(req.headers["user-agent"] || "")
    )
      res
        .type("text")
        .send(
          `Anonyma API is reachable. ${msg.models} callable chat models.\n${account ? `Authenticated · ${key.name} (${key.prefix}…)\n${msg.account.available} available / ${msg.account.credits} total credits.\n` : "Provide a Bearer key to see your balance.\n"}`,
        );
    else res.json(msg);
  });
  app.get("/v1/models", apiAuth, (req, res) => {
    const listed = models.snapshot.data.filter(
      (m) => callable(m, cfg) && ["chat", "image"].includes(m.type),
    );
    // Training Labels (see server/training.js), once released.
    const offered = isReleased(cfg, "training") ? liveIds(listed) : null;
    res.json({
      object: "list",
      data: listed.map((m) => ({
        id: m.id,
        object: "model",
        owned_by: m.owned_by,
        created: 0,
        ...(offered ? apiTrainingFields(m, offered) : {}),
      })),
    });
  });
  app.get("/v1/balance", apiAuth, (req, res) =>
    res.json({
      balance: credits(balance(db, req.user.id).total),
      available: credits(balance(db, req.user.id).available),
    }),
  );
  return { apiAuth };
}
