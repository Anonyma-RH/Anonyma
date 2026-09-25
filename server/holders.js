import { hash, now } from "./core.js";
import { isReleased, earlyUpdates, EARLY_ACCESS_MIN_NYMA } from "./releases.js";
import { ACCESS_PREFIX } from "./oauth.js";

// Holder Early Access. Accounts holding NYMA in a linked wallet use updates
// marked `early: true` in server/releases.js before their public release.
// Holdings come from refreshTokenHoldings (server/auth.js), which the worker
// runs daily for every linked wallet and Account runs on request.

// A balance counts only if it was read successfully this recently. The
// worker rereads daily, so this allows one missed day before access lapses.
export const EARLY_ACCESS_MAX_AGE = 48 * 3600000;

export const earlyAccessThreshold = (cfg) =>
  cfg?.earlyAccessMin ?? EARLY_ACCESS_MIN_NYMA;

// The holder rule, in one place. All of these must hold:
// - token holdings are configured (TOKEN_RPC_URL and TOKEN_CONTRACT);
// - the account is live and has a linked wallet;
// - that wallet's balance was read successfully in the last 48 hours;
// - the balance is at least the threshold (EARLY_ACCESS_MIN_NYMA).
export function earlyAccessHolder(cfg, user, t = now()) {
  if (!cfg?.rpc || !cfg?.token) return false;
  if (!user || user.deleted != null || !user.wallet) return false;
  const checked = Number(user.token_checked);
  if (!Number.isFinite(checked) || checked <= 0) return false;
  if (t - checked > EARLY_ACCESS_MAX_AGE) return false;
  const min = earlyAccessThreshold(cfg);
  const balance = Number(user.token_balance);
  return (
    Number.isFinite(min) &&
    min > 0 &&
    Number.isFinite(balance) &&
    balance >= min
  );
}

// Early access is on for an account when Holder Early Access is live and
// the account passes the holder rule.
export const earlyAccessOn = (cfg, user, t = now()) =>
  isReleased(cfg, "holders") && earlyAccessHolder(cfg, user, t);

// For the account's own session JSON only: the early updates it can use
// now, and whether early access is on. /api/config and every public page
// stay the same for everyone.
export function earlyAccessFor(cfg, user, t = now()) {
  const eligible = earlyAccessOn(cfg, user, t);
  return {
    earlyAccess: eligible ? earlyUpdates(cfg) : [],
    holder: { eligible, threshold: earlyAccessThreshold(cfg) },
  };
}

// For releaseGuard (server/releases.js): whether a request comes from an
// early-access holder. It runs before the routes, so it identifies the
// account exactly the way the route that follows will:
// - /v1 and /mcp: only the account's own API key (a Bearer secret). The
//   session cookie is ignored there, since those routes ignore it too.
// - /mcp with a connected app's OAuth access token: never. An outside app
//   must not learn that the account holds NYMA, so it gets the same
//   403 feature_unreleased as everyone else.
// - every other route: the session cookie.
export function requestHolder(db, cfg) {
  const liveUser = (id) =>
    db.prepare("SELECT * FROM users WHERE id=? AND deleted IS NULL").get(id);
  return (req) => {
    const p = String(req.path).toLowerCase();
    let user = null;
    if (p === "/v1" || p.startsWith("/v1/") || p === "/mcp" || p.startsWith("/mcp/")) {
      const bearer = req.headers?.authorization?.match(/^Bearer (\S+)$/)?.[1];
      if (!bearer || bearer.startsWith(ACCESS_PREFIX)) return false;
      // A connected app's own key has no secret; excluded all the same.
      const key = db
        .prepare(
          "SELECT user_id FROM api_keys WHERE hash=? AND revoked IS NULL AND connection_id IS NULL",
        )
        .get(hash(bearer));
      user = key ? liveUser(key.user_id) : null;
    } else {
      const token = req.cookies?.anonyma_session;
      const session =
        typeof token === "string" && token
          ? db
              .prepare("SELECT user_id FROM sessions WHERE hash=? AND expires>?")
              .get(hash(token), now())
          : null;
      user = session ? liveUser(session.user_id) : null;
    }
    return earlyAccessOn(cfg, user);
  };
}
