import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PageIntro } from "./Pages.jsx";
import { Button, Icon } from "./ui.jsx";
import { useApp } from "./context.jsx";
import ReleaseStatus from "./ReleaseStatus.jsx";
import { isReleased, releaseUpdate } from "./lib.js";
import "./whitepaper.css";

// Every statement below is drawn from the server code (server/*.js). Anything
// that belongs to an unreleased update reads its state from /api/config, so
// the paper changes the moment that update ships.
const SECTIONS = [
  ["abstract", "Abstract"],
  ["problem", "The problem"],
  ["principles", "Design principles"],
  ["how-it-works", "How it works"],
  ["ledger", "The credit ledger"],
  ["payments", "Payments"],
  ["privacy", "Privacy and data"],
  ["security", "Security"],
  ["releases", "The release model"],
  ["roadmap", "Roadmap"],
  ["limitations", "Limitations and open questions"],
];

function Section({ index, children }) {
  const [id, title] = SECTIONS[index];
  const number = String(index + 1).padStart(2, "0");
  return (
    <section id={id} className="wp-section" aria-labelledby={id + "-title"}>
      <p className="eyebrow wp-number">{number}</p>
      <h2 id={id + "-title"}>
        <a href={"#" + id} className="wp-anchor">
          {title}
        </a>
      </h2>
      {children}
    </section>
  );
}

// A small status label for anything that ships with a later update.
function Soon({ config, id }) {
  const update = releaseUpdate(config, id);
  return (
    <span className="wp-soon">
      Coming soon{update ? ` with ${update.title}` : ""}
    </span>
  );
}

function Contents({ active }) {
  const [open, setOpen] = useState(false);
  return (
    <nav className="wp-toc" aria-label="Contents">
      <button
        type="button"
        className="wp-toc-toggle"
        aria-expanded={open}
        aria-controls="wp-toc-list"
        onClick={() => setOpen((v) => !v)}
      >
        Contents
        <Icon name="down" size={16} />
      </button>
      <p className="eyebrow wp-toc-label">CONTENTS</p>
      <ol id="wp-toc-list" className={open ? "open" : ""}>
        {SECTIONS.map(([id, title], i) => (
          <li key={id}>
            <a
              href={"#" + id}
              aria-current={active === id ? "location" : undefined}
              onClick={() => setOpen(false)}
            >
              <span>{String(i + 1).padStart(2, "0")}</span>
              {title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

// The credit lifecycle, drawn in the walkthrough's cobalt-and-white style.
function LifecycleDiagram() {
  const steps = [
    ["Deposit", "A confirmed USDG transfer adds a ledger entry."],
    ["Balance", "The sum of your entries, minus what's on hold."],
    ["Hold", "The estimate is reserved before the model runs."],
    ["Receipt", "The actual cost is charged; the rest is released."],
  ];
  return (
    <figure className="wp-figure">
      <ol className="wp-flow">
        {steps.map(([title, body], i) => (
          <li key={title}>
            <span className="wp-flow-step">0{i + 1}</span>
            <strong>{title}</strong>
            <span>{body}</span>
          </li>
        ))}
      </ol>
      <p className="wp-flow-branch">
        <Icon name="refresh" size={15} />
        Refused, unreachable or empty: the hold is released in full.
      </p>
      <figcaption>
        Figure 1. The credit lifecycle. Every step is a row in one
        append-only ledger.
      </figcaption>
    </figure>
  );
}

function Roadmap({ config }) {
  const updates = config?.releases?.updates;
  if (!updates)
    return (
      <p>
        The live release list couldn't be loaded here. The{" "}
        <Link to="/roadmap">roadmap page</Link> shows the current state.
      </p>
    );
  return (
    <ol className="wp-roadmap">
      <li className="live">
        <span className="wp-status">{config.testMode ? "Local test" : config.services?.generation ? "Live" : "Unavailable"}</span>
        <strong>Chat &amp; Credits</strong>
        <span>The launch: top models on one prepaid balance.</span>
      </li>
      {updates.map((u) => (
        <li key={u.id} className={u.released ? "live" : ""}>
          <span className="wp-status">
            {config.testMode ? "Local test" : u.released ? "Live" : "Coming soon"}
          </span>
          <strong>{u.title}</strong>
          <span>{u.tagline}</span>
        </li>
      ))}
    </ol>
  );
}

export default function Whitepaper() {
  const { config } = useApp();
  // Treat an unloaded config as unreleased, so nothing is overstated.
  const live = (id) => !!config && isReleased(config, id);
  const [active, setActive] = useState(SECTIONS[0][0]);
  const pending = (config?.releases?.updates || []).filter(
    (u) => !u.released,
  ).length;

  // Highlight the section being read in the table of contents.
  useEffect(() => {
    if (!("IntersectionObserver" in window)) return;
    const seen = new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const current = SECTIONS.find(([id]) => seen.get(id));
        if (current) setActive(current[0]);
      },
      { rootMargin: "-20% 0px -65% 0px" },
    );
    for (const [id] of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, []);

  return (
    <main id="main" className="wp-page">
      <PageIntro
        eyebrow="WHITEPAPER"
        title={
          <>
            How ANONYMA works,
            <br />
            and why.
          </>
        }
      >
        The accounting, payments and data handling behind a prepaid AI
        workspace, described from the code that runs it.
      </PageIntro>
      <div className="wp-meta">
        <p>Version 1.0 · September 2026</p>
        <Button type="button" secondary onClick={() => window.print()}>
          Print or save as PDF <Icon name="download" size={16} />
        </Button>
      </div>
      <div className="wp-layout">
        <Contents active={active} />
        <article className="wp-body">
          <ReleaseStatus payment />
          <Section index={0}>
            <p>
              ANONYMA is a prepaid AI workspace: one account and one credit
              balance for chatting with models from several AI labs. You add
              credit up front. Each request reserves an estimate before it
              runs, then settles at its actual cost with a receipt.
            </p>
            <p>
              This paper describes how that works: the ledger that keeps the
              balance, the stablecoin deposits that fund it, the data the
              service keeps and sends, and how new features are released. Every
              statement is taken from the source code that runs the service.
              Where something isn't live yet, the paper says so.
            </p>
          </Section>

          <Section index={1}>
            <p>
              Using several AI models usually means several accounts, several
              subscriptions and several bills. Monthly plans charge whether you
              use them or not. Usage-based plans can bill more than you
              expected. Every new vendor is one more place that holds your
              details.
            </p>
            <p>
              ANONYMA's answer is deliberately narrow: one account, one prepaid
              balance, and one server between you and the model providers.
            </p>
          </Section>

          <Section index={2}>
            <dl className="wp-principles">
              <dt>Prepaid</dt>
              <dd>
                A request runs only if its estimated cost can be reserved from
                your available credits. If it can't, it's refused before
                anything reaches a provider.
              </dd>
              <dt>No subscription</dt>
              <dd>
                Credit is added only when you make a deposit. Nothing in the
                code bills you on a schedule.
              </dd>
              <dt>One balance</dt>
              <dd>
                Every paid action draws on a single ledger for your account.
              </dd>
              <dt>A receipt for every request</dt>
              <dd>
                Each settled request records what was reserved, what was
                charged and what was released.
              </dd>
              <dt>Minimal data</dt>
              <dd>
                You can sign up with just a username, or just a wallet
                signature. Requests to model providers carry your conversation,
                not your account details.
              </dd>
            </dl>
          </Section>

          <Section index={3}>
            <h3>Accounts and sign-in</h3>
            <p>
              You sign in with a username and password, or with a signature
              from an Ethereum wallet. Passwords are hashed with scrypt and a
              random salt. The wallet message expires after ten minutes and
              states that it doesn't authorize a blockchain transaction. The
              code also supports one-time email codes (six digits, valid for
              ten minutes, five attempts), which work only where the operator
              has set up email delivery.
            </p>
            <h3>Models and routing</h3>
            <p>
              {live("catalog")
                ? "Chat runs on the full model catalog. "
                : "At launch, chat runs on a short list of models chosen by the operator, ten by default. "}
              A chat model can run only if it's live in the catalog and has a
              published per-token price, so every estimate has a rate behind
              it.
              {!live("catalog") && (
                <>
                  {" "}
                  <Soon config={config} id="catalog" />
                </>
              )}
            </p>
            <p>
              The server forwards each request to an OpenAI-compatible model
              gateway under the operator's key. The code supports an optional
              backup gateway. It's used only when the primary refuses a request
              before accepting it (unfunded, throttling or unreachable) and the
              backup offers the same model. Either way, you're charged once.
            </p>
            <h3>Streaming</h3>
            <p>
              Replies stream back as server-sent events in the OpenAI
              chat-completion format. The final event carries the token usage
              and the credits charged.
              {live("api")
                ? " The same interface is available to your own tools at /v1, with an API key, on the same balance."
                : " An OpenAI-compatible API for your own tools will draw on the same balance. "}
              {!live("api") && <Soon config={config} id="api" />}
            </p>
          </Section>

          <Section index={4}>
            <p>
              The ledger is the core of ANONYMA. It decides what you can spend,
              what each request costs and what you see afterwards.
            </p>
            <LifecycleDiagram />
            <h3>The unit</h3>
            <p>
              $1 buys 1,000 credits. Internally, the ledger counts whole
              subcredits, ten million to the dollar, so every amount is an
              exact integer. Your balance is the sum of your ledger entries.
              Your available balance is that sum minus what's on hold.
            </p>
            <h3>Append-only</h3>
            <p>
              Entries are never edited or deleted: the database itself rejects
              updates and deletes on the ledger. Each entry has a unique
              reference, so the same deposit or charge can't be recorded twice.
              A correction is a new entry.
            </p>
            <h3>Holds</h3>
            <p>
              Before a request runs, the server estimates its cost from the
              model's published rates: your input, sized conservatively, plus
              the full output limit (4,096 tokens by default, at most 8,192).
              Published rates are a floor, because the gateway can route to a
              pricier host. So when your balance allows it, the hold includes
              headroom, four times the estimate by default. Otherwise it holds
              the estimate alone. Each hold carries a request ID, and a repeated
              ID is refused. A hold that expires while nothing is working on it
              is released.
            </p>
            <h3>Charges and receipts</h3>
            <p>
              When the reply finishes, the server charges the actual cost: the
              cost the gateway reports or, failing that, the published rates
              applied to the counted tokens, plus any platform markup the
              operator sets. The charge never exceeds the hold. If the real
              cost was higher, the operator absorbs the difference and it's
              flagged for reconciliation. The rest of the hold is released. The
              receipt records the model, the token usage, the credits charged
              and the credits released, and it's attached to the ledger entry
              in your account.
            </p>
            <h3>Stops and failures</h3>
            <ul className="wp-list">
              <li>
                <b>Refused, unreachable or empty.</b> Nothing is charged, and
                the hold is released in full.
              </li>
              <li>
                <b>Stopped mid-reply.</b> You pay for what was generated.
              </li>
              <li>
                <b>Stopped before any output.</b> Once the provider has accepted
                the request, you pay for the prompt only.
              </li>
              <li>
                <b>Left early.</b> If you leave before the provider accepts, the
                server waits up to 15 seconds for acceptance, then stops the
                request the same way.
              </li>
              <li>
                <b>Timed out or unreadable.</b> If the provider's deadline
                passes (four minutes in the workspace) or its reply can't be
                decoded, the estimate is charged under the failure-billing
                policy, and the error says so.
              </li>
            </ul>
            <h3>Per-key spending caps</h3>
            <p>
              API keys can carry a rolling 24-hour cap. A request is refused if
              the key's settled spend over the last 24 hours, plus its requests
              in flight, plus the new hold would pass the cap.
              {!live("api") && (
                <>
                  {" "}
                  <Soon config={config} id="api" />
                </>
              )}
            </p>
          </Section>

          <Section index={5}>
            <p>
              Credit is added with USDG, a dollar stablecoin, on Robinhood
              Chain, sent from your own self-custodial wallet. 1 USDG = $1 =
              1,000 credits. The server only reads the chain. It never holds a
              private key.
            </p>
            <ol className="wp-steps">
              <li>
                <b>Link your wallet.</b> You sign a message, which is not a
                transaction, and the address is attached to your account.
                Payments are matched to this address.
              </li>
              <li>
                <b>Send.</b> The app asks your wallet to transfer USDG to the
                operator's public payment address on Robinhood Chain (chain ID
                4663), adding the network to your wallet if needed.
              </li>
              <li>
                <b>Confirm.</b> The app sends the transaction hash to the
                server and keeps it in your browser until it's credited, so
                closing the tab can't lose it. The server checks that its node
                is on the configured chain, reads the transaction receipt and
                waits for the required confirmations, ten by default.
              </li>
              <li>
                <b>Credit.</b> The server adds up the USDG transfers in that
                transaction from your linked wallet to the payment address, and
                credits that amount. The chain and transaction hash form a
                unique key, so a transaction is credited once, to one account.
              </li>
            </ol>
            <p>
              Failed transactions and transfers from a different wallet aren't
              credited. A payment more than seven days old needs support, with
              the transaction hash.
            </p>
            <p>
              The rail is defined by a few settings: the receiving address, the
              chain ID, the token contract, its symbol and decimals, the
              required confirmations and the node the server reads from. Wallet
              payments switch on only when a receiving address is set. The
              browser gets what it needs to build the transfer, but never the
              server's node URL, which may carry a provider key.
            </p>
          </Section>

          <Section index={6}>
            <h3>What's stored</h3>
            <p>
              Your account (username, password hash, and an email or wallet
              address if you add one), session hashes, your conversations and
              their messages, your ledger and receipts, deposit records, and
              any support tickets you write.
            </p>
            <h3>What providers receive</h3>
            <p>
              The model ID, the recent messages of the conversation (up to the
              last 20 in the workspace) and the output limit, sent under the
              operator's gateway key. Your username, email and wallet address
              aren't included. Anything you type into a conversation does reach
              the provider.
            </p>
            <h3>Retention</h3>
            <p>
              The server keeps your 300 most recently updated personal conversations and
              deletes older ones; Symposium runs are kept separately, the newest
              150. Sign-in codes and wallet challenges are
              deleted an hour after they expire, rate-limit records after a
              day, and expired sessions are removed.
            </p>
            <h3>Export and deletion</h3>
            <p>
              You can export your account as JSON: your profile, ledger,
              accessible conversations and messages, deposits, support requests and key/session metadata. Media files require separate downloads. You can delete one personal conversation or
              all of them. Closing your account deletes your conversations,
              media, sessions and support tickets, revokes your API keys and
              clears your username, password, email and wallet address. Unused
              credits are forfeited. Financial records, meaning ledger entries
              and deposit records, are kept without automatic expiry. Shared content in other owners’ workspaces and external copies can remain. See the data-controls guide at /docs/privacy for the full limits.
            </p>
            <p>
              Conversations are stored on the server in readable form so they
              can be shown back to you. ANONYMA doesn't claim end-to-end
              encryption or an independent security certification. The
              operator's own policy governs retention, processing locations and
              contact details.
            </p>
          </Section>

          <Section index={7}>
            <ul className="wp-list">
              <li>
                <b>Sessions.</b> A session is a random token in an HttpOnly,
                SameSite=Lax cookie, marked Secure over HTTPS. The server
                stores only its SHA-256 hash, and it lasts 30 days. You can
                sign out everywhere, and a password reset does so
                automatically.
              </li>
              <li>
                <b>Origin checks.</b> State-changing browser requests from
                another origin are refused, and requests with a body must be
                JSON. Pages can't be framed, and API responses aren't cached.
              </li>
              <li>
                <b>Rate limits.</b> Sign-up, sign-in, email codes, chat,
                deposits and key creation are limited per account or per
                address, for example 20 chat requests a minute and 20 password
                attempts every 15 minutes.
              </li>
              <li>
                <b>API keys.</b> A key is shown once and stored only as a
                SHA-256 hash. Up to 20 can be active, and each can be revoked.
                {!live("api") && (
                  <>
                    {" "}
                    <Soon config={config} id="api" />
                  </>
                )}
              </li>
              <li>
                <b>Test isolation.</b> In live mode, the server refuses to
                start on a database that contains local test credits.
              </li>
            </ul>
          </Section>

          <Section index={8}>
            <p>
              ANONYMA launched as an MVP: chat with a short list of models,
              credits and the account. Everything else ships as named updates,
              in a fixed order.
            </p>
            <p>
              An update goes live in one of two ways: through the hosting
              setting that lists released updates, or through a public commit
              to the repository that marks the update{" "}
              <code>released: true</code>. Until then, the server refuses the
              update's routes with a "coming soon" error, and the app shows it
              as coming soon. This paper reads the same release list, so it
              changes the moment an update ships.
            </p>
          </Section>

          <Section index={9}>
            <p>
              {config?.releases
                ? pending
                  ? `Live now, and what's next, in release order. ${pending} of ${config.releases.updates.length} updates are still coming soon.`
                  : "Every update below is live today, on one prepaid balance."
                : "Live now, and what's next, in release order."}
            </p>
            <Roadmap config={config} />
          </Section>

          <Section index={10}>
            <ul className="wp-list">
              <li>
                <b>Third-party providers.</b> Models run on third-party
                providers through a gateway. Their availability, pricing and
                data handling are outside ANONYMA's control. A backup gateway
                helps only when one is configured.
              </li>
              <li>
                <b>One payment rail.</b> Credit is added with USDG on Robinhood
                Chain, from a linked wallet. The code also has an invoice route
                for a hosted payment processor, offered only if the operator
                configures it.
              </li>
              <li>
                <b>Estimates are a floor.</b> A provider can cost more than its
                published rate. You're never charged beyond your hold. The
                operator absorbs the difference.
              </li>
              <li>
                <b>Failure billing.</b> A request that times out is charged its
                estimate, because the provider may already have done the work.
              </li>
              <li>
                <b>Early cancellation.</b> Cancelling before a provider accepts
                a request doesn't reliably stop its work. That's why the server
                waits for acceptance before stopping a request you've left.
              </li>
              <li>
                <b>One process.</b> The server keeps its data in SQLite and
                runs as a single backend process. Most rate limits live in that
                process's memory and reset on restart.
              </li>
              <li>
                <b>Not everything is live.</b>{" "}
                {config?.releases
                  ? pending
                    ? `${pending} of the ${config.releases.updates.length} planned updates haven't shipped yet. Until they do, their features aren't available.`
                    : "Every planned update has shipped."
                  : "Updates beyond the launch arrive one at a time; see the roadmap."}
              </li>
            </ul>
          </Section>
        </article>
      </div>
    </main>
  );
}
