import { createHash } from "node:crypto";

// One atomic Redis operation; TTL uses the store clock, so server clock skew
// cannot reset the window. No retries: a timed-out write may have succeeded.
export const RATE_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then return redis.error_reply('Rate counter has no expiry') end
return {count, ttl}
`;
export function createLimiter(db, cfg) {
  const increment =
    db.prepare(`INSERT INTO rate_limits(key,count,expires) VALUES(?,1,?)
    ON CONFLICT(key) DO UPDATE SET
      count=CASE WHEN expires<=? THEN 1 ELSE count+1 END,
      expires=CASE WHEN expires<=? THEN excluded.expires ELSE expires END
    RETURNING count,expires`);
  const cleanup = db.prepare("DELETE FROM rate_limits WHERE expires<=?");
  let nextCleanup = 0;
  return (name, max, window) => async (req, res, next) => {
    // Hash identifiers so shared-store keys never include account IDs or IPs.
    const subject = name === "api_ip" ? req.ip : req.user?.id || req.ip;
    const key = `${cfg.rateLimitNamespace}:${name}:${createHash("sha256").update(String(subject)).digest("hex")}`;
    try {
      let count, remaining;
      if (cfg.rateLimitUrl) {
        const response = await fetch(cfg.rateLimitUrl, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(2000),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cfg.rateLimitToken}`,
          },
          body: JSON.stringify(["EVAL", RATE_SCRIPT, "1", key, String(window)]),
        });
        if (!response.ok) throw Error("Rate store unavailable");
        const data = await response.json();
        if (
          data.error ||
          !Array.isArray(data.result) ||
          data.result.length !== 2
        )
          throw Error("Invalid rate store response");
        [count, remaining] = data.result;
        if (
          !Number.isSafeInteger(count) ||
          count < 1 ||
          !Number.isSafeInteger(remaining) ||
          remaining < 0 ||
          remaining > window
        )
          throw Error("Invalid rate counter");
      } else {
        const time = Date.now();
        if (time >= nextCleanup) {
          cleanup.run(time);
          nextCleanup = time + 60000;
        }
        const record = increment.get(key, time + window, time, time);
        count = record.count;
        remaining = record.expires - time;
      }
      if (count > max) {
        res.set(
          "Retry-After",
          String(Math.max(1, Math.ceil(remaining / 1000))),
        );
        return next(
          Object.assign(new Error("Too many requests. Try again shortly."), {
            status: 429,
            code: "rate_limit",
          }),
        );
      }
      next();
    } catch {
      // Never fall back to independent local quotas on a shared-store outage.
      res.set("Retry-After", "5");
      next(
        Object.assign(
          new Error(
            "Request protection is temporarily unavailable. Try again shortly.",
          ),
          { status: 503, code: "rate_limit_unavailable" },
        ),
      );
    }
  };
}
