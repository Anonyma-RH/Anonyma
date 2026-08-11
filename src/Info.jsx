import React from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowUpRight,
  Wallet,
  MessageSquare,
  Coins,
  KeyRound,
  Terminal,
  Braces,
  ArrowRight,
} from "lucide-react";
import { PageTitle, Footer, useApp, CopyButton } from "./lib";
export function HowItWorks() {
  return (
    <>
      <PageTitle
        title="Fund once."
        accent="Ask anything."
        description="From a crypto deposit to your next answer, image, line of code or video. A clear view of what happens at each step."
      />
      <main className="landing-width how-page">
        <div className="steps">
          {[
            [
              KeyRound,
              "01",
              "Create your account",
              "Use a username and password, a verified email, or a signed wallet message. Email is optional for username accounts; add recovery later.",
              "Create account",
              "/signin",
            ],
            [
              Wallet,
              "02",
              "Add a balance",
              "Select an amount and a supported currency. Pay the exact invoice, and credits arrive after verified processor confirmation.",
              "Add credits",
              "/account/deposit",
            ],
            [
              MessageSquare,
              "03",
              "Choose your model",
              "Ask, code, make images or create video. Search the catalog, compare rates, and select a model that is runnable on this installation.",
              "Explore models",
              "/models",
            ],
            [
              Coins,
              "04",
              "Pay for the work",
              "Review the estimate before sending. A reservation covers the maximum usage, then the final receipt settles the actual charge.",
              "Open workspace",
              "/ask",
            ],
          ].map(([Icon, n, title, text, link, to]) => (
            <article key={n}>
              <div className="step-top">
                <Icon />
                <span>{n}</span>
              </div>
              <h2>{title}</h2>
              <p>{text}</p>
              <Link to={to}>
                {link}
                <ArrowUpRight size={15} />
              </Link>
            </article>
          ))}
        </div>
        <div className="usage-flow">
          <span>Prepaid balance</span>
          <ArrowRight />
          <span>Reserve estimate</span>
          <ArrowRight />
          <span>Generate output</span>
          <ArrowRight />
          <span>Settle receipt</span>
        </div>
        <h2>One account beyond the browser.</h2>
        <p>
          Your API keys, terminal and workspace use the same prepaid balance.
          Set a rolling spending cap for an integration and revoke its key
          whenever you need to.
        </p>
        <Link className="button outline" to="/developers">
          Build with the API <ArrowUpRight size={16} />
        </Link>
        <h2>Only configured services are live.</h2>
        <p>
          The installation tells you when an external provider is unavailable. A
          local test banner means outputs and credits are fixtures. Planned
          functions stay marked as planned.
        </p>
      </main>
      <Footer />
    </>
  );
}
export function Developers() {
  const base = location.origin + "/v1";
  const code = `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"google/gemini-2.5-flash","messages":[{"role":"user","content":"Hello"}],"stream":true}'`;
  return (
    <>
      <PageTitle
        eyebrow="FOR BUILDERS"
        title="Every model."
        accent="One endpoint."
        description="An OpenAI-compatible chat API and a small terminal client, connected to your workspace balance."
      />
      <main className="landing-width developers-page">
        <div className="developer-cards">
          <article>
            <Braces />
            <h2>Drop into your code.</h2>
            <p>
              Use ordinary chat-completions clients with a custom base URL and
              your API key. Streaming and usage receipts are built in.
            </p>
            <Link className="button" to="/docs/api">
              API reference <ArrowUpRight size={16} />
            </Link>
          </article>
          <article>
            <Terminal />
            <h2>Stay in your terminal.</h2>
            <p>
              Chat interactively, send a single prompt, switch models and check
              your balance. Node 18 or newer is required.
            </p>
            <Link className="button outline" to="/docs/cli">
              Install the CLI <ArrowUpRight size={16} />
            </Link>
          </article>
        </div>
        <div className="code-block">
          <div>
            First request
            <CopyButton text={code} />
          </div>
          <pre>{code}</pre>
        </div>
        <div className="button-row">
          <Link className="button" to="/account">
            Create an API key
          </Link>
          <Link className="button outline" to="/docs/integrations">
            SDKs & integrations
          </Link>
        </div>
        <h2>Know the compatibility boundary.</h2>
        <p>
          Use model, messages, max_tokens and stream. Function calling,
          structured-output schemas, Responses, Assistants, embeddings and audio
          endpoints are not supported. Source consumer subscriptions can include
          additional tools that a chat endpoint does not reproduce.
        </p>
        <div className="feature-grid">
          <article className="feature-card">
            <h3>Rolling spending caps</h3>
            <p>
              Each key can have a 24-hour credit ceiling that includes in-flight
              reservations.
            </p>
          </article>
          <article className="feature-card">
            <h3>Usage you can account for</h3>
            <p>
              Final responses include token usage and credit charges, backed by
              an append-only ledger.
            </p>
          </article>
        </div>
      </main>
      <Footer />
    </>
  );
}
export function Methodology() {
  return (
    <>
      <article className="prose article-page">
        <div className="eyebrow">CLEAR ASSUMPTIONS</div>
        <h1>How we compare models and costs.</h1>
        <p className="lead">
          Catalog data, estimates and comparisons answer different questions.
          This page explains what each one can tell you.
        </p>
        <h2>Where the catalog comes from</h2>
        <p>
          The initial catalog is a public reference snapshot captured on 19
          September 2026. It retains the model identifier, provider, modality,
          context length, architecture and quoted rates. The source’s upstream
          status is not a guarantee that a model can run on this installation.
          Configured gateway snapshots can be refreshed by the operator.
        </p>
        <h2>How token prices are calculated</h2>
        <p>
          Text cost = input tokens × input rate ÷ 1,000,000 + output tokens ×
          output rate ÷ 1,000,000. Multiply by request count for a workload
          estimate. Provider-billed reasoning can be included in output usage.
          Rates marked per generation use the selected model variant instead.
        </p>
        <h2>Reservations versus estimates</h2>
        <p>
          The workspace reserves a conservative input estimate plus the selected
          maximum output. Actual settlement uses provider-reported usage where
          available. If an interrupted stream lacks final usage, a visible
          partial-output estimate is used and never exceeds the reservation.
        </p>
        <h2>What “savings” means</h2>
        <p>
          The calculator subtracts an estimated usage cost from selected
          subscription list prices. It does not equate product features, compute
          a benchmark, or guarantee that every user will save money.
          Subscription bundles, included tools, taxes, transfer fees and
          operator markup can differ.
        </p>
        <h2>Quality needs a task</h2>
        <p>
          There is no universal model winner in this interface. The comparison
          workbench reports differences in listed capability and estimated cost.
          Evaluate outputs on representative prompts and review important work
          yourself.
        </p>
        <h2>Corrections</h2>
        <p>
          If a rate, model capability or description is wrong, include the model
          ID and the source of the discrepancy in a support request.
        </p>
        <Link className="button outline" to="/support">
          Report a correction
        </Link>
      </article>
      <Footer />
    </>
  );
}
export function About() {
  return (
    <>
      <PageTitle
        title="More models."
        accent="Less friction."
        description="An independent prepaid AI workspace built to put model choice, costs and account controls in one place."
      />
      <article className="prose article-page">
        <h2>The product</h2>
        <p>
          Anonyma connects a web workspace and developer endpoint to configured
          AI and payment services. The software stores account state,
          conversation history, private files and an auditable credit ledger
          locally on the operator’s infrastructure.
        </p>
        <h2>The implementation</h2>
        <p>
          This project recreates the publicly observable functionality and
          visual structure of HeyAskr for the requested build. It is
          independently implemented and is not affiliated with or endorsed by
          HeyAskr or the model providers listed in the catalog.
        </p>
        <h2>Operational transparency</h2>
        <p>
          Live provider, payment, email and blockchain services require real
          configuration. Local test mode is visibly labeled. The operator must
          supply its identity, finalized commercial terms and support contact
          before a public launch.
        </p>
        <Link className="button" to="/how-it-works">
          How it works <ArrowUpRight size={16} />
        </Link>
      </article>
      <Footer />
    </>
  );
}
const alternatives = [
  [
    "openrouter",
    "Model routing services",
    "A gateway comparison",
    "Compare endpoint compatibility, model availability, per-request costs, routing controls, account funding and saved-work features. Verify whether a client depends on unsupported tools or endpoints before moving it.",
  ],
  [
    "chatgpt",
    "Single-provider chat subscriptions",
    "A workflow comparison",
    "Start with your actual tasks: conversations, coding, images and files. Compare the complete workflow, including bundled tools and limits, rather than treating a token-priced API as an identical replacement for a consumer subscription.",
  ],
  [
    "poe",
    "Multi-model chat subscriptions",
    "A billing comparison",
    "A shared model interface can be priced as a fixed subscription, points or metered credits. Check how each option handles usage limits, model switching, saved work and integrations for your workload.",
  ],
  [
    "claude",
    "Writing and coding subscriptions",
    "A task comparison",
    "Estimate the input and output volume of your writing or coding sessions. Compare model quality on your tasks and check any project, editor or tool integrations you rely on.",
  ],
  [
    "perplexity",
    "Research subscriptions",
    "A capability comparison",
    "Research products can bundle search, citations, retrieval and source browsing. Ordinary chat endpoints do not automatically include those capabilities. Compare the whole task before relying on a usage-cost estimate.",
  ],
];