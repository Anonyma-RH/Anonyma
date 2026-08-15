import React, { useState, useMemo, useEffect } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import {
  ArrowUpRight,
  ArrowRight,
  Plus,
  Minus,
  Check,
  Search,
  SlidersHorizontal,
  ChevronDown,
  Copy,
  Download,
  Code2,
  MessageSquare,
  Image,
  Video,
  Wallet,
  Coins,
  LockKeyhole,
  Layers3,
  Shuffle,
  ExternalLink,
  BookOpen,
  Terminal,
  Braces,
  ShieldCheck,
} from "lucide-react";
import {
  useApp,
  PageTitle,
  Footer,
  Button,
  ProviderIcon,
  fmt,
  dollars,
  modelPrice,
  generationPrice,
  CopyButton,
  download,
  ErrorBox,
  api,
} from "./lib";
import { faqs, docSections, articles, roadmap } from "./content";
import { LiveMarket } from "./LiveMarket";
export function Home() {
  const { models, config, ready } = useApp(),
    [usecase, setUsecase] = useState(0),
    [faq, setFaq] = useState(0);
  const cases = [
    [
      "Chat & research",
      "TEXT",
      "Ask questions, research a topic and reason through complex ideas.",
      "chat",
    ],
    [
      "Code & websites",
      "CODE",
      "Write, explain and debug code, then download the files you create.",
      "code",
    ],
    [
      "Image generation",
      "IMAGE",
      "Create a picture from a prompt or work from reference images.",
      "image",
    ],
    [
      "Video generation",
      "VIDEO",
      "Turn a prompt or reference image into a generated clip.",
      "video",
    ],
    [
      "Voice & audio",
      "AUDIO",
      "Explore speech, music and voice models in the catalog.",
      "audio",
    ],
  ];
  const category = cases[usecase][3];
  const recommendations = models
    .filter(
      (m) =>
        m.status === "live" &&
        (category === "image"
          ? m.imageCapable
          : category === "code" || category === "chat"
            ? m.type === "chat" && !m.imageCapable
            : m.type === category),
    )
    .sort((a, b) => Number(b.popular || 0) - Number(a.popular || 0))
    .slice(0, 4);
  return (
    <>
      <section className="hero">
        <div className="hero-image" />
        <div className="hero-content">
          <h1>
            Every AI model.
            <br />
            <span>Funded by crypto.</span>
          </h1>
          <p>
            One workspace for the leading AI model families. Talk with GPT,
            Claude, Gemini, DeepSeek and Grok. Create images, build code, or
            generate a video. Fund a shared balance with crypto and pay for the
            work you actually use.
          </p>
          <div className="hero-buttons">
            <Link to="/ask" className="button">
              Ask
            </Link>
            <Link to="/how-it-works" className="button outline">
              How it works
            </Link>
          </div>
        </div>
        <div className="inference">
          <span>MODEL ACCESS</span>
          <strong>
            {models.filter((m) => m.callable).length || "—"}{" "}
            <small>runnable models</small>
          </strong>
          <span>
            {config?.testMode
              ? "Local test gateway"
              : config?.services?.generation
                ? "Configured gateway"
                : "Connect your gateway to begin"}
          </span>
        </div>
      </section>
      <div className="provider-marquee" aria-label="AI providers">
        <div className="provider-track">
          {[0, 1].map((copy) => (
            <div
              className="provider-group"
              key={copy}
              aria-hidden={copy === 1 ? true : undefined}
            >
              {[
                "OpenAI",
                "Anthropic",
                "Google",
                "xAI",
                "DeepSeek",
                "Runway",
                "Higgsfield",
                "Kling AI",
                "NVIDIA",
                "ElevenLabs",
                "FLUX",
                "Perplexity",
                "Freepik",
              ].map((provider) => (
                <ProviderIcon key={provider} provider={provider} size={42} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <LiveMarket />
      <div className="landing-width">
        <section id="how-it-works" className="landing-section funding-section">
          <h2>
            Crypto in.
            <br />
            <span className="array red">Intelligence out.</span>
          </h2>
          <p className="section-desc">
            Use BTC, ETH, SOL or another supported currency to fund one shared
            balance.
          </p>
          <div className="funding-links">
            <Link to="/how-it-works">/ See how it works</Link>
            <Link to="/calculator">/ Calculate credits</Link>
          </div>
          {[
            [
              "01 / FUND",
              "Your crypto",
              "Choose a currency and pay from your own wallet. Each invoice gives you the address, amount and payment status.",
              [
                "USDT, BTC, ETH and SOL",
                "Current rate when you fund",
                "Credits priced in USD",
              ],
              ["usdt", "btc", "eth", "sol"],
            ],
            [
              "02 / CONVERT",
              "AI credits",
              "Your deposit funds a balance shared across models. Switch providers without buying another subscription.",
              [
                "Open and proprietary models",
                "Pick a model for each task",
                "Published usage rates",
              ],
              ["openai", "anthropic", "google", "deepseek"],
            ],
            [
              "03 / SHIP",
              "Your output",
              "Ask questions, write code, create images or generate video. Your receipt records the cost of each request.",
              [
                "Chat, code, images and video",
                "One balance across your workflow",
                "Add funds when you need them",
              ],
              [],
            ],
          ].map(([step, title, description, details, marks]) => (
            <article className="funding-card" key={step}>
              <div className="funding-step">{step}</div>
              <div className="funding-body">
                <div>
                  <h3>{title}</h3>
                  <p>{description}</p>
                  <div className="funding-marks">
                    {marks.map((mark) => (
                      <img
                        key={mark}
                        src={`/assets/providers/${mark}.svg`}
                        alt={mark}
                      />
                    ))}
                    {!marks.length && (
                      <>
                        <span>
                          Product <b>SHIPPED</b>
                        </span>
                        <span>
                          Campaign <b>READY</b>
                        </span>
                        <span>
                          Video <b>RENDERED</b>
                        </span>
                      </>
                    )}
                  </div>
                </div>
                <ul>
                  {details.map((detail) => (
                    <li key={detail}>/ {detail}</li>
                  ))}
                </ul>
              </div>
            </article>
          ))}
        </section>
        <section className="landing-section token-benefits">
          <div className="eyebrow">TOKEN BENEFITS</div>
          <h2>
            Hold <span className="array red">ANON.</span>
            <br />
            Pay less.
          </h2>
          <p className="section-desc">
            Link a wallet to apply the holding benefits of this installation's
            token. Discounts reduce the platform markup; provider charges still
            apply. You can use the workspace without holding a token.
          </p>
          <div className="token-benefit-grid">
            <article>
              <div className="eyebrow">UTILITY</div>
              <h3>Lower platform fees</h3>
              <p>
                Holding tiers reduce markup by up to 100%. With the current{" "}
                {config?.markup || 0}% markup, provider costs determine your
                bill.
              </p>
            </article>
            <article>
              <div className="eyebrow">CONTRACT</div>
              <h3>{config?.token ? "Linked token" : "Awaiting token setup"}</h3>
              <p>
                {config?.token ||
                  "A token contract must be connected before balances and benefits can be verified."}
              </p>
            </article>
            <article>
              <div className="eyebrow">CHAIN</div>
              <h3>Chain {config?.chain || 4663}</h3>
              <p>
                {config?.services?.token
                  ? "Wallet holdings are checked against the configured chain."
                  : "The chain connection has not been configured yet."}
              </p>
            </article>
          </div>
          <Link to="/token" className="button outline">
            Explore token benefits
          </Link>
        </section>
        <section className="landing-section job-section">
          <h2>
            What are you <span className="array red">making?</span>
          </h2>
          <p className="section-desc">
            Choose a task and explore the available models. Chat, code, images
            and video share one prepaid balance.
          </p>
          <div
            className="pills usecase-tabs"
            role="tablist"
            aria-label="Choose a job"
          >
            {cases.map((c, i) => (
              <button
                key={c[3]}
                role="tab"
                id={`job-${c[3]}`}
                aria-selected={usecase === i}
                aria-controls="job-panel"
                tabIndex={usecase === i ? 0 : -1}
                className={usecase === i ? "active" : ""}
                onClick={() => setUsecase(i)}
                onKeyDown={(e) => {
                  let next;
                  if (e.key === "ArrowRight") next = (i + 1) % cases.length;
                  if (e.key === "ArrowLeft")
                    next = (i + cases.length - 1) % cases.length;
                  if (e.key === "Home") next = 0;
                  if (e.key === "End") next = cases.length - 1;
                  if (next !== undefined) {
                    e.preventDefault();
                    setUsecase(next);
                    document.getElementById(`job-${cases[next][3]}`)?.focus();
                  }
                }}
              >
                {c[0]}
              </button>
            ))}
          </div>
          <div
            className="job-panel"
            id="job-panel"
            role="tabpanel"
            aria-labelledby={`job-${category}`}
          >
            <div>
              <div className="eyebrow">{cases[usecase][1]}</div>
              <h3>{cases[usecase][0]}</h3>
              <p>{cases[usecase][2]}</p>
            </div>
            <div className="job-recommendations">
              <div className="eyebrow">RECOMMENDED</div>
              {!recommendations.length && (
                <p role="status">
                  {ready
                    ? "No matching models are currently listed. Browse the catalog for availability."
                    : "Loading model recommendations…"}
                </p>
              )}
              {recommendations.map((m) => (
                <Link
                  key={m.id}
                  to={
                    m.callable
                      ? `/ask?mode=${category}&model=${encodeURIComponent(m.id)}`
                      : `/models?task=${category === "code" ? "chat" : category}&q=${encodeURIComponent(m.id)}`
                  }
                >
                  <code>{m.id}</code>
                  <span>{m.name}</span>
                </Link>
              ))}
            </div>
            <Link
              className="job-all"
              to={`/models?task=${category === "code" ? "chat" : category}`}
            >
              / See every {cases[usecase][0].toLowerCase()} model
            </Link>
          </div>
        </section>
        <section className="landing-section faq">
          <div className="faq-head">
            <h2>FAQ</h2>
            <p>Models, funding, privacy and what each request costs.</p>
          </div>
          {faqs.map(([q, a], i) => (
            <div
              className={"faq-item " + (faq === i ? "expanded" : "")}
              key={q}
            >
              <button
                aria-expanded={faq === i}
                aria-controls={`faq-answer-${i}`}
                id={`faq-question-${i}`}
                onClick={() => setFaq(faq === i ? -1 : i)}
              >
                {q}
                <ChevronDown
                  size={18}
                  className={faq === i ? "faq-chevron open" : "faq-chevron"}
                />
              </button>
              {faq === i && (
                <p
                  id={`faq-answer-${i}`}
                  role="region"
                  aria-labelledby={`faq-question-${i}`}
                >
                  {a}
                </p>
              )}
            </div>
          ))}
        </section>
      </div>
      <Footer />
    </>
  );
}