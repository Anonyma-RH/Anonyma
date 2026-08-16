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
export function Models({ pricing = false }) {
  const { models, modelInfo } = useApp(),
    [params, setParams] = useSearchParams(),
    [query, setQuery] = useState(params.get("q") || ""),
    [type, setType] = useState(
      ["chat", "image", "video", "audio", "embedding"].includes(
        params.get("task"),
      )
        ? params.get("task")
        : "all",
    ),
    [provider, setProvider] = useState("all"),
    [availability, setAvailability] = useState("all"),
    [sort, setSort] = useState("popular"),
    [variantPrices, setVariantPrices] = useState({}),
    [limit, setLimit] = useState(60),
    [currency, setCurrency] = useState("USD"),
    [rates, setRates] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    setLimit(60);
  }, [query, type, provider, availability]);
  useEffect(() => {
    if (currency !== "USD" && !rates)
      api("/api/rates")
        .then(setRates)
        .catch((e) => {
          setError(e.message);
          setCurrency("USD");
        });
  }, [currency]);
  const filtered = useMemo(
    () =>
      models
        .filter(
          (m) =>
            (type === "all" ||
              m.type === type ||
              (type === "image" && m.imageCapable)) &&
            (provider === "all" || m.owned_by === provider) &&
            (availability === "all" ||
              (availability === "runnable"
                ? m.callable
                : m.status === availability)) &&
            `${m.id} ${m.name} ${m.owned_by}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "name"
            ? a.name.localeCompare(b.name)
            : sort === "cheap"
              ? modelPrice(a) - modelPrice(b)
              : sort === "expensive"
                ? modelPrice(b) - modelPrice(a)
                : Number(b.popular) - Number(a.popular),
        ),
    [models, type, provider, availability, query, sort],
  );
  const providers = [
    ...new Set(models.map((m) => m.owned_by).filter(Boolean)),
  ].sort();
  const price = (n) =>
    currency === "USD"
      ? dollars(n)
      : rates
        ? `${(n * rates.rates[currency]).toLocaleString("en", { maximumSignificantDigits: 6 })} ${currency}`
        : "—";
  return (
    <>
      <PageTitle
        title={pricing ? "Transparent" : "Explore every"}
        accent={pricing ? "pricing." : "model."}
        description={
          pricing
            ? "Pay for what you use. Compare rates across models, with one balance for everything."
            : "Discover the models behind the workspace. Compare capabilities, context windows and pricing."
        }
      />
      <div className="catalog-badge">
        <span className="tiny-dot" />{" "}
        {models.filter((m) => m.status === "live").length} listed live upstream
        · {models.filter((m) => m.callable).length} runnable here{" "}
        <span className="muted">
          {" "}
          · {modelInfo?.live ? "updated" : "snapshot"}{" "}
          {modelInfo?.updatedAt?.slice(0, 10)}
        </span>
      </div>
      <main className="catalog-layout">
        <aside className="filters">
          <h3>
            <SlidersHorizontal size={17} /> Filters
          </h3>
          <label>MODALITY</label>
          {[
            ["all", "All models"],
            ["chat", "Chat & code"],
            ["image", "Images"],
            ["video", "Video"],
            ["audio", "Audio"],
            ["embedding", "Embeddings"],
          ].map(([id, label]) => (
            <button
              key={id}
              onClick={() => setType(id)}
              className={type === id ? "selected" : ""}
            >
              {label}
              <span>
                {
                  models.filter(
                    (m) =>
                      id === "all" ||
                      m.type === id ||
                      (id === "image" && m.imageCapable),
                  ).length
                }
              </span>
            </button>
          ))}
          <label>PROVIDER</label>
          <select
            aria-label="Provider"
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="all">All providers</option>
            {providers.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
          <label>AVAILABILITY</label>
          <select
            aria-label="Availability"
            value={availability}
            onChange={(e) => setAvailability(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="runnable">Runnable here</option>
            <option value="live">Listed live upstream</option>
            <option value="planned">Planned</option>
            <option value="unavailable">Unavailable</option>
          </select>
          {pricing && (
            <>
              <label>DISPLAY CURRENCY</label>
              <select
                aria-label="Currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
              >
                {["USD", "USDT", "BTC", "ETH", "SOL"].map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </select>
              {rates && (
                <small>
                  Rates: Coinbase ·{" "}
                  {new Date(rates.updatedAt).toLocaleTimeString()}
                </small>
              )}
            </>
          )}
          <p className="filter-note">
            Catalog availability is separate from this installation’s configured
            generation access. Audio and embeddings are discovery only.
          </p>
          <button
            className="text-link"
            onClick={() => {
              setQuery("");
              setType("all");
              setProvider("all");
              setAvailability("all");
            }}
          >
            Reset filters
          </button>
        </aside>
        <section className="catalog-results">
          <div className="catalog-toolbar">
            <div className="search-field">
              <Search size={17} />
              <input
                placeholder="Search models or providers…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              aria-label="Sort models"
              value={sort}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="popular">Most popular</option>
              <option value="cheap">Price: low to high</option>
              <option value="expensive">Price: high to low</option>
              <option value="name">Name A–Z</option>
            </select>
          </div>
          <ErrorBox error={error} />
          <div className="result-label">
            {filtered.length} models{" "}
            <span>
              Prices in {currency}
              {!pricing ? " · per 1M tokens or generation" : ""}
            </span>
          </div>
          <div className="model-list">
            {filtered.slice(0, limit).map((m) => (
              <details className="model-row" key={m.id}>
                <summary>
                  <ProviderIcon provider={m.owned_by} />
                  <div className="model-name">
                    <strong>
                      {m.name}
                      {m.popular && <span className="popular">POPULAR</span>}
                    </strong>
                    <small>{m.id}</small>
                  </div>
                  <span className="model-type">{m.type || "planned"}</span>
                  <span className="model-context">
                    {m.context_length
                      ? fmt(m.context_length / 1000, 0) + "K"
                      : "—"}
                  </span>
                  <div className="model-price">
                    <strong>
                      {price(variantPrices[m.id] ?? modelPrice(m))}
                    </strong>
                    <small>
                      {m.pricing?.type === "per_token"
                        ? "input / 1M tokens"
                        : "per generation"}
                    </small>
                  </div>
                  {m.callable ? (
                    <Link
                      onClick={(e) => e.stopPropagation()}
                      to={`/ask?mode=${m.imageCapable || m.type === "image" ? "image" : m.type === "video" ? "video" : "chat"}&model=${encodeURIComponent(m.id)}`}
                      className={"run-link " + (!m.callable ? "muted" : "")}
                    >
                      {m.callable
                        ? "Run"
                        : m.status === "planned"
                          ? "Planned"
                          : "Details"}{" "}
                      <ArrowUpRight size={13} />
                    </Link>
                  ) : (
                    <button
                      className="run-link muted"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        const details = e.currentTarget.closest("details");
                        details.open = !details.open;
                      }}
                    >
                      {m.status === "planned" ? "Planned" : "Details"}
                    </button>
                  )}
                </summary>
                <div className="model-detail">
                  <p>
                    {m.description ||
                      `${m.name} by ${m.owned_by}. ${m.vision ? "Supports image input." : ""}`}
                  </p>
                  <div>
                    <span>
                      Status:{" "}
                      <b>
                        {m.callable
                          ? "Runnable"
                          : m.status + " · catalog listing"}
                      </b>
                    </span>
                    {m.context_length && (
                      <span>
                        Context: <b>{fmt(m.context_length)} tokens</b>
                      </span>
                    )}
                    {m.pricing?.output_per_1M_tokens != null && (
                      <span>
                        Output:{" "}
                        <b>
                          {price(m.pricing.output_per_1M_tokens)} / 1M tokens
                        </b>
                      </span>
                    )}
                  </div>
                  {m.pricing?.variants?.map((v) => (
                    <p key={v.quality}>
                      <b>{v.quality}:</b>{" "}
                      {v.options
                        .map((o) => `${o.size}: ${price(o.price)}`)
                        .join(" · ")}
                    </p>
                  ))}
                  {pricing && m.pricing?.variants?.length > 0 && (
                    <label>
                      Generation variant
                      <select
                        aria-label={`${m.name} generation variant`}
                        onChange={(e) =>
                          setVariantPrices((v) => ({
                            ...v,
                            [m.id]: Number(e.target.value),
                          }))
                        }
                      >
                        <option value={modelPrice(m)}>
                          Default · {price(modelPrice(m))}
                        </option>
                        {m.pricing.variants.flatMap((v) =>
                          v.options.map((o) => (
                            <option key={v.quality + o.size} value={o.price}>
                              {v.quality} · {o.size} · {price(o.price)}
                            </option>
                          )),
                        )}
                      </select>
                    </label>
                  )}
                </div>
              </details>
            ))}
          </div>
          {!filtered.length && (
            <div className="empty">No models match those filters.</div>
          )}
          {filtered.length > limit && (
            <Button
              variant="outline load-more"
              onClick={() => setLimit(limit + 60)}
            >
              Show 60 more <ChevronDown size={16} />
            </Button>
          )}
        </section>
      </main>
      <Footer />
    </>
  );
}