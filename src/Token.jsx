import React from "react";
import { Link } from "react-router-dom";
import { useApp } from "./context.jsx";
import { PageIntro, NotFound } from "./Pages.jsx";
import { Button, CopyButton, Icon } from "./ui.jsx";
import { CONTRACT_ADDRESS } from "./Home.jsx";
import {
  NYMA,
  tokenExplorerUrl,
  holdersReleased,
  earlyUpdates,
  earlyAccessThreshold,
} from "./holders.js";
import "./holders.css";

// /token: what NYMA is and what holding it does in ANONYMA. Plain facts
// only. It ships with Holder Early Access; until then it's an unknown page.
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
  if (!config && loading) return <main id="main" className="loading-page" />;
  if (!holdersReleased(config)) return <NotFound />;
  const threshold = amount(earlyAccessThreshold(config));
  const early = earlyUpdates(config);
  return (
    <main id="main" className="token-page">
      <PageIntro
        eyebrow="THE NYMA TOKEN"
        title={
          <>
            Hold NYMA.
            <br />
            Get what's next first.
          </>
        }
      >
        NYMA is ANONYMA's token on Robinhood Chain. Hold it in a linked
        wallet and new ANONYMA features open to you before their public
        release.
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
            {`Hold at least ${threshold} NYMA in a wallet linked to your ANONYMA account, and you get new features before their public release.`}
          </p>
          <p className="token-tagged">
            <span className="early-tag">Early access</span>
            <span>
              In the workspace, those features carry this tag. Once a feature
              is released to everyone, it's open to every account as usual.
            </span>
          </p>
          <h3>In early access now</h3>
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
              Nothing is in early access right now. The next one opens here.
            </p>
          )}
        </Section>

        <Section number="03" id="checked" title="How it's checked">
          <ol className="token-steps">
            <li>
              Link a wallet in Account by signing a one-time message. No
              transaction, no approval, nothing to spend.
            </li>
            <li>
              ANONYMA reads that wallet's NYMA balance and rechecks it in the
              background. Access follows the balance.
            </li>
          </ol>
          <p>
            {`Below ${threshold} NYMA, early access turns off at the next check. A balance that can't be rechecked for 48 hours stops counting until it can. You can also refresh it yourself in Account.`}
          </p>
        </Section>

        <Section number="04" id="privacy" title="Privacy">
          <ul className="token-list">
            <li>Linking is optional. ANONYMA works fully without a wallet.</li>
            <li>
              Linking ties that wallet to your account inside ANONYMA, so use
              one you're comfortable linking.
            </li>
            <li>You can unlink it any time in Account.</li>
            <li>
              Connected apps never learn you hold NYMA. They're treated like
              any account without early access.
            </li>
          </ul>
        </Section>

        <Section number="05" id="isnt" title="What NYMA isn't">
          <ul className="token-list">
            <li>Not needed to use ANONYMA. Credits are bought as usual.</li>
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
