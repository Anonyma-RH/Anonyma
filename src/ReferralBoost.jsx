import React from "react";
import {
  referralBoost,
  percentText,
  rateLine,
  topPercent,
  tierList,
} from "./referral-boost.js";
import "./referral-boost.css";

// Referral Boost on the Account page's invite card: this account's rate
// now, and every tier's. GET /api/referrals includes `rate` and `boost`
// only while the boost is live, so this renders nothing before that.
export function ReferralRate({ data }) {
  const rate = data?.rate;
  if (!rate || !data?.boost) return null;
  const tiers = tierList(data.boost);
  return (
    <div className="referral-rate">
      <p className="referral-rate-line">
        <b>{rateLine(rate)}</b>
        {rate.tier && <span>{`Base rate: ${percentText(rate.base)}`}</span>}
      </p>
      <ul
        className="referral-rate-tiers"
        aria-label="Referral rate by NYMA tier"
      >
        {tiers.map((t) => (
          <li key={t.id} className={t.id === rate.tier ? "on" : undefined}>
            <span>{t.name}</span>
            <b>{percentText(t.percent)}</b>
          </li>
        ))}
      </ul>
      <p className="referral-rate-note">
        {rate.tier
          ? "Your NYMA tier when each friend's top-up is confirmed sets the rate for that top-up."
          : `Link a wallet that holds NYMA to get up to ${percentText(topPercent(data.boost))} back. Your tier when each friend's top-up is confirmed sets the rate for that top-up.`}
      </p>
    </div>
  );
}

// Account → Settings → NYMA holdings: the boost as a perk of every tier,
// with the account's own tier marked. From /api/config, so it's the same
// list for everyone; nothing shows until the boost is live.
export function HoldingsBoost({ config, tierId }) {
  const boost = referralBoost(config);
  if (!boost) return null;
  const tiers = tierList(boost);
  return (
    <div className="holdings-boost">
      <h3>Referral boost</h3>
      <p>
        {`Back in credits when a friend you invited tops up and the payment is confirmed. Without a tier: ${percentText(boost.base)}.`}
      </p>
      <ul aria-label="Referral boost by tier">
        {tiers.map((t) => (
          <li key={t.id} className={t.id === tierId ? "on" : undefined}>
            <span>{t.name}</span>
            <b>{percentText(t.percent)}</b>
          </li>
        ))}
      </ul>
      <p className="holdings-hint">
        Your tier when each top-up is confirmed sets its rate, with the same
        fresh balance check as every perk.
      </p>
    </div>
  );
}
