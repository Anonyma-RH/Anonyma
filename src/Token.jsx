import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "./context.jsx";
import { PageIntro, NotFound } from "./Pages.jsx";
import { Button, CopyButton, Icon } from "./ui.jsx";
import { api } from "./lib.js";
import { CONTRACT_ADDRESS } from "./Home.jsx";
import {
  NYMA,
  tokenExplorerUrl,
  holdersReleased,
  holderProgram,
  earlyUpdates,
  tierPerks,
  nymaAmount,
  creditAmount,
  usageValue,
  multiplierText,
} from "./holders.js";
import { referralBoost, boostPerk, tierList, percentText } from "./referral-boost.js";
import "./referral-boost.css";
import "./holders.css";

// /token: what NYMA is and what holding it does in ANONYMA: the NYMA Holder
// Program's tiers, credits and perks, and its public totals. Plain facts
// only. It ships with the program; until then it's an unknown page.
const amount = (n) => Number(n).toLocaleString("en-US");

function Section({ number, id, title, children }) {
  return (
    <section id={id} className="token-section" aria-labelledby={id + "-title"}>
      <p className="eyebrow token-number">{number}</p>
      <h2 id={id + "-title"}>{title}</h2>
      {children}
    </section>
  );
}

export default function Token() {
  const { config, user, loading } = useApp();
  const [summary, setSummary] = useState(null);
  const live = holdersReleased(config);
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    api("/api/holders/summary", { signal: controller.signal })
      .then(setSummary)
      .catch(() => {});
    return () => controller.abort();
  }, [live]);
  if (!config && loading) return <main id="main" className="loading-page" />;
  if (!live) return <NotFound />;
  const program = holderProgram(config);
  const tiers = program?.tiers || [];
  const loyalty = program?.loyalty;
  const caps = program?.caps;
  // Referral Boost, once live: each tier's referral rate, as a perk.
  const boost = referralBoost(config);
  const holderMin = nymaAmount(tiers[0]?.min ?? 1_000_000);
  const creditsOn = tiers.some((t) => t.credits > 0);
  const early = earlyUpdates(config);
  const votes = summary?.vote?.candidates;
  return (
    <main id="main" className="token-page">
      <PageIntro
        eyebrow="THE NYMA TOKEN"
        title={
          <>
            Hold NYMA.
            <br />
            Get credits and perks.
          </>
        }
      >
        NYMA is ANONYMA's token on Robinhood Chain. Hold it in a linked
        wallet and your account gets ANONYMA credits every 30 days, plus perks
        by tier.
      </PageIntro>
      <div className="token-body">
        <Section number="01" id="glance" title="NYMA at a glance">
          <dl className="token-facts">
            <dt>Name</dt>
            <dd data-i18n="off">{NYMA.name}</dd>
            <dt>Symbol</dt>
            <dd data-i18n="off">{NYMA.symbol}</dd>
            <dt>Network</dt>
            <dd>{`${NYMA.network}, chain ID ${NYMA.chainId}`}</dd>
            <dt>Contract</dt>
            <dd className="token-contract">
              <code data-i18n="off">{CONTRACT_ADDRESS}</code>
              <span className="token-contract-actions">
                <CopyButton text={CONTRACT_ADDRESS} label="Copy address" />
                <a
                  className="small-button"
                  href={tokenExplorerUrl(CONTRACT_ADDRESS)}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Blockscout <Icon name="external" size={14} />
                </a>
              </span>
            </dd>
            <dt>Decimals</dt>
            <dd>{NYMA.decimals}</dd>
            <dt>Total supply</dt>
            <dd>{`${amount(NYMA.totalSupply)} NYMA`}</dd>
          </dl>
        </Section>

        <Section number="02" id="holding" title="What holding does">
          <p>
            Hold NYMA in a wallet linked to your ANONYMA account. Every 30
            days, your account gets the credits for its tier, plus the tier's
            perk and every perk below it.
          </p>
          <div className="table-scroll token-tiers-scroll">
            <table className="token-tiers">
              <thead>
                <tr>
                  <th>Tier</th>
                  <th>Lowest balance</th>
                  <th>Credits every 30 days</th>
                  <th>Perks</th>
                </tr>
              </thead>
              <tbody>
                {tiers.map((t, i) => (
                  <tr key={t.id}>
                    <th scope="row">{t.name}</th>
                    <td>{nymaAmount(t.min)}</td>
                    <td>
                      {t.credits > 0 ? (
                        <>
                          <b>{creditAmount(t.credits)}</b>
                          <small>{usageValue(t.credits)}</small>
                        </>
                      ) : (
                        "No credits"
                      )}
                    </td>
                    <td>
                      <ul>
                        {tierPerks(program, i).map((perk) => (
                          <li key={perk}>{perk}</li>
                        ))}
                        {boostPerk(boost, t.id) && (
                          <li>{boostPerk(boost, t.id)}</li>
                        )}
                      </ul>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {loyalty && loyalty.multiplier > 1 && (
            <p className="token-bonus">
              {`Loyal bonus: after ${loyalty.after} paid cycles in a row, every later payout is ${multiplierText(loyalty.multiplier)}, until a cycle ends unpaid.`}
            </p>
          )}
          {!creditsOn && (
            <p className="token-none">
              Credit rewards are off right now. The perks still apply.
            </p>
          )}
          <p className="token-plain">
            No staking, no locking, no deposits. Your NYMA stays in your own
            wallet. You link it by signing a message and hold.
          </p>

          <h3>How a cycle works</h3>
          <ul className="token-list">
            <li>
              {`A cycle is 30 days. It starts at the first check that sees at least ${holderMin} in your linked wallet.`}
            </li>
            <li>
              Your tier is the lowest balance any check sees during the cycle,
              so adding NYMA just before it ends doesn't raise it. It counts
              from the next cycle.
            </li>
            <li>
              After 30 days, the cycle's credits go to your balance and the
              next cycle starts. They need a check from the last 48 hours; if
              there isn't one yet, the cycle waits for it.
            </li>
            <li>
              {`If a check sees less than ${holderMin}, the cycle ends unpaid, and a new one starts at the next check at or above it.`}
            </li>
          </ul>

          <h3>The perks</h3>
          <dl className="token-perks">
            <dt>
              Bigger library <small>Holder and up</small>
            </dt>
            <dd>
              {caps &&
                `Twice the saved items: ${caps.holder.conversations} conversations instead of ${caps.standard.conversations}, ${caps.holder.symposium} Symposium runs instead of ${caps.standard.symposium}, and ${caps.holder.image} images, ${caps.holder.video} videos and ${caps.holder.audio} audio files.`}{" "}
              {`If your balance drops below ${holderMin}, nothing is deleted at once. The normal caps simply apply again, so the oldest items beyond them are removed as new ones are saved.`}
            </dd>
            <dt>
              Early access <small>Insider and up</small>
            </dt>
            <dd>
              <p className="token-tagged">
                <span className="early-tag">Early access</span>
                <span>
                  New features before their public release, marked with this
                  tag in the workspace.
                </span>
              </p>
              {early.length ? (
                <ul className="token-early">
                  {early.map((u) => (
                    <li key={u.id}>
                      <strong>{u.title}</strong>
                      <span>{u.tagline}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="token-none">
                  Nothing is in early access right now. The next one opens
                  here.
                </p>
              )}
            </dd>
            <dt>
              Roadmap vote <small>Inner Circle</small>
            </dt>
            <dd>
              Each month, vote for one update that isn't released yet, in
              Account. You can change it until the month ends. Inner Circle
              votes help decide what ships next.
            </dd>
            {boost && (
              <>
                <dt>
                  Referral boost <small>Holder and up</small>
                </dt>
                <dd>
                  <p>
                    More back in credits when a friend you invited tops up
                    and the payment is confirmed. Your tier when each top-up
                    is confirmed sets its rate.
                  </p>
                  <ul className="token-boost" aria-label="Referral boost by tier">
                    {tierList(boost).map((t) => (
                      <li key={t.id}>
                        <span>{t.name}</span>
                        <b>{percentText(t.percent)}</b>
                      </li>
                    ))}
                    <li>
                      <span>Without a tier</span>
                      <b>{percentText(boost.base)}</b>
                    </li>
                  </ul>
                </dd>
              </>
            )}
          </dl>
        </Section>

        <Section number="03" id="numbers" title="Transparency">
          <p>
            Totals only, updated daily. ANONYMA never publishes who holds, who
            was paid or who voted.
          </p>
          <dl className="token-stats">
            <div>
              <dt>Credits paid, last 30 days</dt>
              <dd>{summary ? amount(summary.rewards.credits) : "…"}</dd>
            </div>
            <div>
              <dt>Holders rewarded, last 30 days</dt>
              <dd>{summary ? amount(summary.rewards.holders) : "…"}</dd>
            </div>
          </dl>
          <h3>Roadmap vote this month</h3>
          {votes?.length ? (
            <ul className="token-votes">
              {votes.map((c) => (
                <li key={c.id}>
                  <strong>{c.title}</strong>
                  <span>{`${c.votes} ${c.votes === 1 ? "vote" : "votes"}`}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="token-none">
              {summary
                ? "Every update is out or in early access. The next vote opens here."
                : "Loading the vote…"}
            </p>
          )}
        </Section>

        <Section number="04" id="checked" title="How it's checked">
          <ol className="token-steps">
            <li>
              Link a wallet in Account by signing a one-time message. No
              transaction, no approval, nothing to spend.
            </li>
            <li>
              ANONYMA reads that wallet's NYMA balance about once a day, at a
              random time, and you can refresh it yourself in Account. Your
              tier and perks follow the balance.
            </li>
          </ol>
          <p>
            A check that can't reach the chain changes nothing: it neither
            ends a cycle nor counts toward one. A balance that can't be
            rechecked for 48 hours stops counting until it can.
          </p>
        </Section>

        <Section number="05" id="privacy" title="Privacy">
          <ul className="token-list">
            <li>Linking is optional. ANONYMA works fully without a wallet.</li>
            <li>
              Linking ties that wallet to your account inside ANONYMA, so use
              one you're comfortable linking.
            </li>
            <li>You can unlink it any time in Account.</li>
            <li>
              Public numbers are totals only: never who holds, who was paid or
              who voted.
            </li>
            <li>
              Connected apps never learn you hold NYMA. They're treated like
              any account without early access.
            </li>
          </ul>
        </Section>

        <Section number="06" id="isnt" title="What NYMA isn't">
          <ul className="token-list">
            <li>Not needed to use ANONYMA. Credits are bought as usual.</li>
            <li>
              Rewards are ANONYMA credits, not tokens or cash, and have no cash
              value.
            </li>
            <li>Not a share of the company, and no revenue share.</li>
            <li>No promise of value.</li>
            <li>Not financial advice.</li>
          </ul>
        </Section>

        <div className="token-next">
          <Button to={user ? "/account/settings" : "/login"}>
            {user ? "Link a wallet in Account" : "Log in to link a wallet"}{" "}
            <Icon name="arrow" />
          </Button>
          <Link to="/roadmap" className="text-link">
            See the roadmap <Icon name="arrow" size={16} />
          </Link>
        </div>
      </div>
    </main>
  );
}
