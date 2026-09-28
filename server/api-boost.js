import { hash, now } from "./core.js";
import { isReleased, connectLive } from "./releases.js";
import { currentTier } from "./holders.js";
import { ACCESS_PREFIX, authenticateAccessToken } from "./oauth.js";
import { TIERS } from "./holder-tiers.js";

// API Boost (update "apiboost"): NYMA holders get higher API and MCP
// request-rate limits, by tier.
//
// The standard limits, for everyone:
//   /v1/chat/completions, the /v1 media endpoints and POST /mcp share one
//   limit of API_RATE requests a minute;
//   /v1/files has its own, FILES_RATE a minute per account.
//
// Before this update, the shared limit counts every request per IP
// address, whoever sends it. Once it's released:
// - A request whose Bearer credential belongs to an account (its own API
//   key, or on /mcp a connected app's access token) counts for that account
//   from that IP address, against API_RATE times the account's multiplier.
//   One account's requests never use up, or raise, another account's limit.
// - A request with no valid credential still counts per IP address, at the
//   standard limit, so floods of bad keys stay limited.
// - /v1/files keeps counting per account, at FILES_RATE times the same
//   multiplier.
//
// The multiplier is the account's current tier's in HOLDER_API_MULTIPLIERS
// (server/holder-tiers.js), under the Holder Program's own rule
// (currentTier in server/holders.js: the lowest balance this cycle, with a
// successful read in the last 48 hours). No tier, a stale read or no wallet
// means 1. It's worked out from the account row each request reads anyway,
// so there's nothing to cache or invalidate: a tier change applies to the
// very next request. A lower limit applies at once to the same counter, so
// an account already past it waits for the window to end.
//
// Rates only. Every paid request still reserves against the balance, the
// key's rolling 24-hour cap, its allowance and the account's spending
// limits, exactly as before.
//
// Connected apps get the standard limit whatever the tier, and a 429
// is the same message, code and Retry-After header for everyone, and
// nothing about the limit is sent in headers.

export const API_RATE = 120;
export const FILES_RATE = 60;
export const API_WINDOW_MS = 60_000;

export const apiBoostLive = (cfg) => isReleased(cfg, "apiboost");

// The configured multipliers while the boost can apply: the update and the
// Holder Program released, and HOLDER_API_MULTIPLIERS not off.
export const apiMultipliers = (cfg) =>
  apiBoostLive(cfg) && isReleased(cfg, "holders")
    ? (cfg.holderApiMultipliers ?? null)
    : null;

// A boosted rate is a whole number of requests, rounded down.
export const boostedRate = (base, multiplier) =>
  Math.max(1, Math.floor(base * multiplier));

// The multiplier the account's requests get right now.
export function apiMultiplier(cfg, user, t = now()) {
  const multipliers = apiMultipliers(cfg);
  if (!multipliers || !user) return 1;
  const tier = currentTier(cfg, user, t);
  return tier ? (multipliers[tier.id] ?? 1) : 1;
}

// The public settings for /api/config once the update is released, the
// same for everyone: the standard rates and each tier's boosted ones.
export function apiBoostInfo(cfg) {
  if (!apiBoostLive(cfg)) return null;
  const multipliers = apiMultipliers(cfg);
  return {
    perMinute: API_RATE,
    filesPerMinute: FILES_RATE,
    tiers: multipliers
      ? TIERS.map(({ id, name }) => ({
          id,
          name,
          multiplier: multipliers[id],
          perMinute: boostedRate(API_RATE, multipliers[id]),
          filesPerMinute: boostedRate(FILES_RATE, multipliers[id]),
        }))
      : [],
  };
}

// The account's own limits, for its API keys page (session only; never
// sent to an API key or a connected app).
export function apiLimitFor(cfg, user, t = now()) {
  const multipliers = apiMultipliers(cfg);
  const tier = multipliers ? currentTier(cfg, user, t) : null;
  const multiplier = tier ? (multipliers[tier.id] ?? 1) : 1;
  return {
    perMinute: boostedRate(API_RATE, multiplier),
    filesPerMinute: boostedRate(FILES_RATE, multiplier),
    standard: { perMinute: API_RATE, filesPerMinute: FILES_RATE },
    multiplier,
    // The tier behind a boost; null when there's no boost to show.
    tier: tier && multiplier > 1 ? { id: tier.id, name: tier.name } : null,
    windowSeconds: API_WINDOW_MS / 1000,
  };
}

// The account a /v1 or /mcp request's Bearer credential belongs to, found
// the way apiAuth (server/routes/api.js) and mcpAuth (server/routes/mcp.js)
// will find it, without refusing anything: null for a missing, unknown,
// revoked or expired credential, which the auth step then refuses. Access
// tokens count only on /mcp, and only once Connect an App is live.
function bearerOwner(db, cfg, req, oauth) {
  const bearer = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1];
  if (!bearer) return null;
  if (bearer.startsWith(ACCESS_PREFIX) && oauth && connectLive(cfg))
    return authenticateAccessToken(db, bearer)?.user ?? null;
  const key = db
    .prepare("SELECT user_id FROM api_keys WHERE hash=? AND revoked IS NULL")
    .get(hash(bearer));
  return key
    ? (db
        .prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL")
        .get(key.user_id) ?? null)
    : null;
}

// The shared /v1 and /mcp request limit, in place of limit("api_ip", ...).
// Runs before the auth step, as that limit did. `oauth`: the route also
// accepts connected apps' access tokens (/mcp).
export function apiRateLimit({ db, cfg, limit }, { oauth = false } = {}) {
  const perIp = limit("api_ip", API_RATE, API_WINDOW_MS);
  return (req, res, next) => {
    if (!apiBoostLive(cfg)) return perIp(req, res, next);
    const user = bearerOwner(db, cfg, req, oauth);
    if (!user) return perIp(req, res, next);
    // A connected app always gets the standard limit on its own counter: a
    // boosted limit would let an app that sends past 120 a minute work out
    // the account's NYMA tier, which connected apps must never learn.
    if (req.headers.authorization?.startsWith("Bearer " + ACCESS_PREFIX))
      return limit(
        "api_app",
        API_RATE,
        API_WINDOW_MS,
        () => `${user.id}:${req.ip}`,
      )(req, res, next);
    return limit(
      "api_account",
      boostedRate(API_RATE, apiMultiplier(cfg, user)),
      API_WINDOW_MS,
      () => `${user.id}:${req.ip}`,
    )(req, res, next);
  };
}

// /v1/files' own limit, after the auth step: per account, boosted.
export const filesRateLimit = ({ cfg, limit }) =>
  limit(
    "api-files",
    (req) => boostedRate(FILES_RATE, apiMultiplier(cfg, req.user)),
    API_WINDOW_MS,
  );
