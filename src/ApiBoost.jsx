import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "./lib.js";
import {
  apiBoostOf,
  boostedTiers,
  multiplierText,
  perMinuteText,
  rateLine,
  standardLimit,
  topTier,
} from "./api-boost.js";
import "./api-boost.css";

// API Boost in the app (the limits themselves are server/api-boost.js):
// - ApiRateLimit: the account's own limit on Account → API keys.
// - HoldingsApiBoost: every tier's limit in Account → Settings → NYMA
//   holdings.
// - ApiGuideLimits: the rate-limit paragraph in the API guide.
// Each renders nothing until the update is released.

const SPEND_NOTE =
  "Rates only: your balance, key caps, allowances and spending limits still set what's spent.";

// Account → API keys: "Your API rate limit: 360 requests/min (Insider
// boost)", with every tier's limit and the account's own marked.
export function ApiRateLimit({ config, user, demo }) {
  const boost = apiBoostOf(config);
  const live = !!boost;
  const [own, setOwn] = useState(null);
  useEffect(() => {
    setOwn(null);
    if (!live || demo || !user) return;
    let current = true;
    api("/api/account/api-limit")
      .then((limit) => current && setOwn(limit))
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [live, demo, user?.id, user?.tokenChecked, user?.wallet]);
  if (!boost) return null;
  // A sample account (demo) has no tier; a signed-in one waits for its own.
  const limit = own || (demo || !user ? standardLimit(boost) : null);
  return <ApiRateCard boost={boost} limit={limit} />;
}

// What ApiRateLimit shows, for the account's `limit` (null while loading).
export function ApiRateCard({ boost, limit }) {
  const tiers = boostedTiers(boost);
  const top = topTier(boost);
  return (
    <section className="api-rate" aria-label="API rate limit">
      <p className="api-rate-line">
        <b>{limit ? rateLine(limit) : "Loading your API rate limit…"}</b>
      </p>
      {tiers.length > 0 && (
        <ul className="api-rate-tiers" aria-label="API rate limit by NYMA tier">
          <li className={limit && !limit.tier ? "on" : undefined}>
            <span>Standard</span>
            <b>{`${boost.perMinute}/min`}</b>
          </li>
          {tiers.map((t) => (
            <li
              key={t.id}
              className={limit?.tier?.id === t.id ? "on" : undefined}
            >
              <span>{t.name}</span>
              <b>{`${t.perMinute}/min`}</b>
            </li>
          ))}
        </ul>
      )}
      <p className="api-rate-note">
        {limit
          ? `Chat completions, media and MCP share this limit, counted for your account from each IP address. File uploads have their own: ${perMinuteText(limit.filesPerMinute)}. ${SPEND_NOTE}`
          : SPEND_NOTE}
      </p>
      {limit && !limit.tier && top && (
        <p className="api-rate-note">
          {`Holding NYMA in a linked wallet raises it, up to ${perMinuteText(top.perMinute)} at ${top.name}.`}{" "}
          <Link to="/token">What NYMA does</Link>
        </p>
      )}
    </section>
  );
}

// Account → Settings → NYMA holdings: the boost as a perk of every tier,
// from /api/config (the same for everyone), with this account's tier
// marked.
export function HoldingsApiBoost({ config, tierId }) {
  const boost = apiBoostOf(config);
  const tiers = boostedTiers(boost);
  if (!tiers.length) return null;
  return (
    <div className="holdings-api-boost">
      <h3>API Boost</h3>
      <p>
        {`More API and MCP requests a minute at every tier, for your keys and connected apps. Standard: ${perMinuteText(boost.perMinute)}.`}
      </p>
      <ul aria-label="API rate limit by tier">
        {tiers.map((t) => (
          <li key={t.id} className={t.id === tierId ? "on" : undefined}>
            <span>{t.name}</span>
            <b>{perMinuteText(t.perMinute)}</b>
            <em>{multiplierText(t.multiplier)}</em>
          </li>
        ))}
      </ul>
      <p className="holdings-hint">
        {`Your current tier sets it, with the same fresh balance check as every perk. ${SPEND_NOTE}`}
      </p>
    </div>
  );
}

// The API guide's rate limits, once the update is released: the standard
// rule, and each tier's limits while the boost is on.
export function ApiGuideLimits({ config }) {
  const boost = apiBoostOf(config);
  if (!boost) return null;
  const tiers = boostedTiers(boost);
  return (
    <div className="api-guide-limits">
      <p>
        {`Rate limits: chat completions, the media endpoints and MCP share ${perMinuteText(boost.perMinute)} for each account from each IP address; file uploads have ${perMinuteText(boost.filesPerMinute)}. A request without a valid key counts per IP address. Over the limit you get 429 rate_limit with a Retry-After header.`}
      </p>
      {tiers.length > 0 && (
        <>
          <p>
            API Boost: NYMA holders get more. It follows your current holder
            tier, with a balance check from the last 48 hours. Connected apps
            get your limit but are never told your tier.
          </p>
          <ul aria-label="API rate limit by NYMA tier">
            {tiers.map((t) => (
              <li key={t.id}>
                {`${t.name}: ${perMinuteText(t.perMinute)}, file uploads ${perMinuteText(t.filesPerMinute)}`}
              </li>
            ))}
          </ul>
          <p>{SPEND_NOTE}</p>
        </>
      )}
    </div>
  );
}
