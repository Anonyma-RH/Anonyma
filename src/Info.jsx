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