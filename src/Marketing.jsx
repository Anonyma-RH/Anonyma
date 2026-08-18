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
const subscriptions = [
  ["ChatGPT Plus", 20, "OpenAI"],
  ["Claude Pro", 20, "Anthropic"],
  ["Google AI Pro", 20, "Google"],
  ["Perplexity Pro", 20, "DeepSeek"],
  ["Grok Premium+", 30, "xAI"],
  ["Midjourney Standard", 35, "Mistral"],
];
export function Calculator() {
  const { models } = useApp(),
    [params] = useSearchParams(),
    [selected, setSelected] = useState(
      (params.get("subs") || "0,1,2").split(",").map(Number),
    ),
    [prompts, setPrompts] = useState(Number(params.get("prompts") || 1000)),
    [size, setSize] = useState(params.get("size") || "typical"),
    [model, setModel] = useState(params.get("model") || ""),
    [message, setMessage] = useState("");
  const chats = models.filter(
    (m) => m.type === "chat" && m.pricing?.input_per_1M_tokens != null,
  );
  const m =
    chats.find((m) => m.id === model) ||
    chats.find((m) => m.id === "google/gemini-2.5-flash") ||
    chats[0];
  const [input, output] = {
    short: [250, 125],
    typical: [1000, 500],
    long: [4000, 2000],
  }[size];
  const spend =
    (prompts *
      ((m?.pricing?.input_per_1M_tokens || 0) * input +
        (m?.pricing?.output_per_1M_tokens || 0) * output)) /
    1e6;
  const monthly = selected.reduce((s, i) => s + subscriptions[i][1], 0),
    saved = monthly - spend;
  const link = () =>
    `${location.origin}/calculator?${new URLSearchParams({ subs: selected.join(","), prompts, size, model: m?.id || "" })}`;
  const save = () => {
    const c = document.createElement("canvas");
    c.width = 1200;
    c.height = 630;
    const g = c.getContext("2d");
    g.fillStyle = "#100e0f";
    g.fillRect(0, 0, 1200, 630);
    g.fillStyle = "#f2f0ec";
    g.font = "32px sans-serif";
    g.fillText("ANONYMA / USAGE ESTIMATE", 64, 80);
    g.font = "62px sans-serif";
    g.fillText(`${dollars(spend)} estimated per month`, 64, 220);
    g.fillStyle = "#c8102e";
    g.fillText(`${dollars(saved)} estimated savings`, 64, 320);
    g.fillStyle = "#aaa5a0";
    g.font = "23px sans-serif";
    g.fillText(
      `${fmt(prompts)} prompts · ${input} input / ${output} output tokens`,
      64,
      420,
    );
    g.fillText(m?.name || "", 64, 465);
    g.fillText(
      "Different products and bundled benefits. Estimate, not a guarantee.",
      64,
      560,
    );
    const a = document.createElement("a");
    a.download = "anonyma-savings.png";
    a.href = c.toDataURL();
    a.click();
  };
  return (
    <>
      <PageTitle
        title="Stop subscribing."
        accent="Start saving."
        description="See what your AI usage could cost. Adjust your subscriptions, prompts and preferred model."
      />
      <main className="calculator-layout">
        <section>
          <h2>Your current subscriptions</h2>
          <p className="muted">Select the plans you pay for each month.</p>
          <div className="subscription-grid">
            {subscriptions.map(([name, price, provider], i) => (
              <button
                className={
                  "subscription " + (selected.includes(i) ? "active" : "")
                }
                key={name}
                onClick={() =>
                  setSelected(
                    selected.includes(i)
                      ? selected.filter((n) => n !== i)
                      : [...selected, i],
                  )
                }
              >
                <ProviderIcon provider={provider} />
                <div>
                  <strong>{name}</strong>
                  <small>${price}/mo</small>
                </div>
                <span className="check-box">
                  {selected.includes(i) && <Check size={12} />}
                </span>
              </button>
            ))}
          </div>
          <div className="form-section">
            <label>
              Monthly prompts <b>{fmt(prompts)}</b>
            </label>
            <input
              type="range"
              aria-label="Monthly prompts"
              min="10"
              max="10000"
              step="10"
              value={prompts}
              onChange={(e) => setPrompts(Number(e.target.value))}
            />
            <div className="range-labels">
              <span>10</span>
              <span>10,000</span>
            </div>
          </div>
          <div className="form-section">
            <label>Typical prompt size</label>
            <div className="segments">
              {["short", "typical", "long"].map((v) => (
                <button
                  className={size === v ? "active" : ""}
                  key={v}
                  onClick={() => setSize(v)}
                >
                  {v}
                </button>
              ))}
            </div>
            <small>
              {fmt(input)} input + {fmt(output)} output tokens per prompt
            </small>
          </div>
          <div className="form-section">
            <label>Your model</label>
            <select
              value={m?.id || ""}
              onChange={(e) => setModel(e.target.value)}
            >
              {chats.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </div>
        </section>
        <aside className="calculator-result">
          <span className="eyebrow">WITH ANONYMA</span>
          <div className="result-money">
            {dollars(spend)}
            <small>/ month</small>
          </div>
          <p>Estimated usage cost. No monthly commitment.</p>
          <div className="savings-box">
            <span>
              {saved >= 0 ? "You could save" : "Estimated extra cost"}
            </span>
            <strong>
              {dollars(Math.abs(saved))}
              <small> /mo</small>
            </strong>
            <small>
              {monthly ? fmt((saved / monthly) * 100, 0) : 0}% compared with
              your selected subscriptions
            </small>
          </div>
          <div className="cost-bar-label">
            <span>Subscriptions</span>
            <b>{dollars(monthly)}</b>
          </div>
          <div className="cost-bar">
            <i
              style={{
                width: (monthly / Math.max(monthly, spend, 1)) * 100 + "%",
              }}
            />
          </div>
          <div className="cost-bar-label">
            <span>Anonyma estimate</span>
            <b>{dollars(spend)}</b>
          </div>
          <div className="cost-bar red-bar">
            <i
              style={{
                width: (spend / Math.max(monthly, spend, 1)) * 100 + "%",
              }}
            />
          </div>
          <Link to="/ask" className="button full">
            Start with Anonyma <ArrowUpRight size={16} />
          </Link>
          <div className="result-actions">
            <CopyButton text={link()} label="Copy link" />
            <button
              className="copy-button"
              onClick={async () => {
                if (navigator.share) {
                  try {
                    await navigator.share({
                      title: "Anonyma savings estimate",
                      url: link(),
                    });
                  } catch {}
                } else {
                  await navigator.clipboard.writeText(link());
                  setMessage("Share link copied.");
                }
              }}
            >
              <ArrowUpRight size={14} /> Share
            </button>
            <button className="copy-button" onClick={save}>
              <Download size={14} /> Save image
            </button>
          </div>
          {message && <small>{message}</small>}
          <p className="fineprint">
            Based on catalog rates and your token assumptions. Subscriptions may
            include features and benefits this gateway does not offer. Taxes,
            transfer fees and configured platform markup are excluded.
          </p>
        </aside>
      </main>
      <Footer />
    </>
  );
}
export function Compare() {
  const { models } = useApp(),
    [params] = useSearchParams(),
    [type, setType] = useState(
      ["chat", "image", "video"].includes(params.get("type"))
        ? params.get("type")
        : "chat",
    ),
    [a, setA] = useState(params.get("a") || ""),
    [b, setB] = useState(params.get("b") || ""),
    [input, setInput] = useState(
      Math.max(0, Number(params.get("input") || 1000)) || 0,
    ),
    [output, setOutput] = useState(
      Math.max(0, Number(params.get("output") || 500)) || 0,
    ),
    [count, setCount] = useState(
      Math.max(1, Number(params.get("count") || 1000)) || 1,
    );
  const list = models.filter((m) => m.type === type && m.status === "live"),
    left = list.find((m) => m.id === a) || list[0],
    right = list.find((m) => m.id === b) || list[1];
  const cost = (m) =>
    type === "chat"
      ? (count *
          ((m?.pricing?.input_per_1M_tokens || 0) * input +
            (m?.pricing?.output_per_1M_tokens || 0) * output)) /
        1e6
      : count * generationPrice(m);
  return (
    <>
      <PageTitle
        eyebrow="COMPARE BEFORE YOU COMMIT"
        title="Two models."
        accent="One clear choice."
        description="Compare capabilities and estimated costs side by side. Then try the models on your own task."
      />
      <main className="compare-page">
        <div className="compare-share">
          <CopyButton
            label="Share comparison"
            text={`${location.origin}/compare?${new URLSearchParams({ type, a: left?.id || "", b: right?.id || "", input, output, count })}`}
          />
        </div>
        <div className="pills centered">
          {["chat", "image", "video"].map((t) => (
            <button
              className={type === t ? "active" : ""}
              onClick={() => {
                setType(t);
                setA("");
                setB("");
              }}
              key={t}
            >
              {t}
            </button>
          ))}
        </div>
        <div className="compare-select">
          <select value={left?.id || ""} onChange={(e) => setA(e.target.value)}>
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            className="icon-button"
            aria-label="Swap models"
            onClick={() => {
              setA(right?.id);
              setB(left?.id);
            }}
          >
            <Shuffle />
          </button>
          <select
            value={right?.id || ""}
            onChange={(e) => setB(e.target.value)}
          >
            {list.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div className="compare-cards">
          {[left, right].map((m, i) => (
            <article className="compare-card" key={i}>
              <ProviderIcon provider={m?.owned_by || ""} size={44} />
              <h2>{m?.name}</h2>
              <p>{m?.owned_by}</p>
              <dl>
                <dt>Context</dt>
                <dd>
                  {m?.context_length ? fmt(m.context_length) + " tokens" : "—"}
                </dd>
                <dt>Vision input</dt>
                <dd>{m?.vision ? "Yes" : "Not listed"}</dd>
                <dt>Input / generation</dt>
                <dd>
                  {dollars(modelPrice(m))}
                  {type === "chat" ? " / 1M" : ""}
                </dd>
                {type === "chat" && (
                  <>
                    <dt>Output</dt>
                    <dd>{dollars(m?.pricing?.output_per_1M_tokens)} / 1M</dd>
                  </>
                )}
                <dt>Estimated total</dt>
                <dd className="red">{dollars(cost(m))}</dd>
              </dl>
              <Link
                className="button outline full"
                to={`/ask?mode=${type}&model=${m?.id || ""}`}
              >
                Try model <ArrowUpRight size={15} />
              </Link>
            </article>
          ))}
        </div>
        <div className="compare-inputs">
          <label>
            {type === "chat" ? "Requests" : "Generations"}
            <input
              type="number"
              min="1"
              value={count}
              onChange={(e) => setCount(Math.max(1, Number(e.target.value)))}
            />
          </label>
          {type === "chat" && (
            <>
              <label>
                Input tokens / request
                <input
                  type="number"
                  min="0"
                  value={input}
                  onChange={(e) =>
                    setInput(Math.max(0, Number(e.target.value)))
                  }
                />
              </label>
              <label>
                Output tokens / request
                <input
                  type="number"
                  min="0"
                  value={output}
                  onChange={(e) =>
                    setOutput(Math.max(0, Number(e.target.value)))
                  }
                />
              </label>
            </>
          )}
        </div>
        <p className="comparison-verdict">
          {cost(left) === cost(right)
            ? "Estimated costs are equal."
            : `${cost(left) < cost(right) ? left?.name : right?.name} is ${dollars(Math.abs(cost(left) - cost(right)))} less at these usage assumptions.`}
        </p>
        <p className="fineprint">
          Price comparison is not a quality ranking. Image/video figures use
          default variants. Actual output, reasoning and selected generation
          settings can change the bill.
        </p>
        <ArticleGrid />
      </main>
      <Footer />
    </>
  );
}
export function ArticleGrid() {
  return (
    <div className="article-grid">
      {articles.map((a) => (
        <Link to={"/learn/" + a.slug} className="article-card" key={a.slug}>
          <span className="eyebrow">{a.category}</span>
          <h3>{a.title}</h3>
          <p>{a.intro}</p>
          <span>
            Read article <ArrowUpRight size={15} />
          </span>
        </Link>
      ))}
    </div>
  );
}
export function Learn() {
  const { slug } = useParams(),
    a = articles.find((v) => v.slug === slug);
  return (
    <>
      {a ? (
        <article className="prose article-page">
          <Link to="/learn">← All articles</Link>
          <div className="eyebrow">{a.category}</div>
          <h1>{a.title}</h1>
          <p className="lead">{a.intro}</p>
          {a.paragraphs.map((p) => (
            <p key={p}>{p}</p>
          ))}
          <Link className="button" to="/compare">
            Compare models <ArrowUpRight size={16} />
          </Link>
        </article>
      ) : (
        <>
          <PageTitle
            title="Learn. Compare."
            accent="Make more."
            description="Practical guides to models, costs and getting the most out of your workspace."
          />
          <main className="landing-width">
            <ArticleGrid />
          </main>
        </>
      )}
      <Footer />
    </>
  );
}
export function Roadmap() {
  return (
    <>
      <PageTitle
        title="Built in public."
        accent="Moving forward."
        description="What is available in this implementation, what is planned, and what still requires external services."
      />
      <main className="roadmap landing-width">
        {roadmap.map(([status, title, text]) => (
          <article key={title}>
            <span className={"status-tag " + status.toLowerCase()}>
              {status}
            </span>
            <h2>{title}</h2>
            <p>{text}</p>
          </article>
        ))}
        <p className="fineprint">
          “Available” describes implemented software. Live generation, payments,
          email and token utilities still require operator configuration.
          Planned items are not launch promises.
        </p>
      </main>
      <Footer />
    </>
  );
}
export function Token() {
  const { config } = useApp();
  const tiers = [
    ["1,000,000", "0.1%", "2.5%", "Status tier"],
    ["5,000,000", "0.5%", "12.5%", "No holding delay"],
    ["10,000,000", "1%", "25%", "Priority tier"],
    ["20,000,000", "2%", "50%", "Advanced tier"],
    ["40,000,000", "4%", "100%", "Platform-markup waiver"],
  ];
  return (
    <>
      <PageTitle
        eyebrow="OPTIONAL BY DESIGN"
        title="A token with"
        accent="a purpose."
        description="A configurable utility layer for a prepaid AI workspace. Tokens and spendable credits are separate."
      />
      <main className="landing-width token-page">
        <div className="notice">
          <LockKeyhole size={19} />
          <p>
            {config?.services?.token
              ? "A token contract is configured. Link your wallet in Account to check your holdings."
              : "This installation has no configured token contract. No token has been launched or offered for sale here."}
          </p>
        </div>
        <div className="token-summary">
          <div>
            <small>REFERENCE SUPPLY</small>
            <strong>1,000,000,000</strong>
          </div>
          <div>
            <small>ACCESS REQUIREMENT</small>
            <strong>None</strong>
          </div>
          <div>
            <small>CURRENT PLATFORM MARKUP</small>
            <strong>{config?.markup || 0}%</strong>
          </div>
        </div>
        <h2>Holding tiers</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Tokens held</th>
                <th>Of reference supply</th>
                <th>Markup reduction</th>
                <th>Condition</th>
              </tr>
            </thead>
            <tbody>
              {tiers.map((row) => (
                <tr key={row[0]}>
                  {row.map((v) => (
                    <td key={v}>{v}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p>
          These reductions apply only to a configured platform markup. Provider
          costs remain payable. A 100% markup reduction does not mean free AI
          generation. At a 0% platform markup, these tiers produce no additional
          price reduction.
        </p>
        {config?.token && (
          <p>
            Configured contract: <code>{config.token}</code> · chain{" "}
            {config.chain}
          </p>
        )}
        <Link className="button" to="/account">
          Connect your account <ArrowUpRight size={16} />
        </Link>
        <h2>Designed to stay optional</h2>
        <p>
          Use the workspace with ordinary prepaid credits. Wallet ownership is
          verified with a message signature. Holdings are read through the
          configured blockchain RPC; no transfers are requested by the sign-in
          flow.
        </p>
        <Link to="/docs/wallets" className="text-link">
          Read the utility and holding rules →
        </Link>
      </main>
      <Footer />
    </>
  );
}
export function Docs() {
  const { slug } = useParams(),
    [query, setQuery] = useState("");
  const section = docSections.find((s) => s.id === slug),
    base = location.origin + "/v1";
  useEffect(() => {
    const fn = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        document.getElementById("docs-search")?.focus();
      }
    };
    window.addEventListener("keydown", fn);
    return () => window.removeEventListener("keydown", fn);
  }, []);
  const filtered = docSections.filter((s) =>
    (s.title + " " + s.summary + " " + s.body.flat().join(" "))
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const code = {
    curl: `curl ${base}/chat/completions \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -H 'Content-Type: application/json' \\\n  -d '{"model":"google/gemini-2.5-flash","messages":[{"role":"user","content":"Hello"}],"max_tokens":512}'`,
    python: `from openai import OpenAI\nimport os\nclient = OpenAI(base_url="${base}", api_key=os.environ["ANONYMA_API_KEY"])\nr = client.chat.completions.create(\n    model="google/gemini-2.5-flash",\n    messages=[{"role": "user", "content": "Hello"}],\n    max_tokens=512,\n)\nprint(r.choices[0].message.content)`,
    node: `import OpenAI from 'openai';\nconst client = new OpenAI({ baseURL: '${base}', apiKey: process.env.ANONYMA_API_KEY });\nconst result = await client.chat.completions.create({\n  model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: 'Hello' }], max_tokens: 512\n});\nconsole.log(result.choices[0].message.content);`,
  };
  return (
    <>
      <div className="docs-subnav">
        <Link to="/docs">Documentation</Link>
        <Link to="/docs/getting-started">Quickstart</Link>
        <Link to="/docs/api">API reference</Link>
        <Link to="/docs/cli">CLI</Link>
        <Link to="/support">Support</Link>
      </div>
      {!section ? (
        <main className="docs-home">
          <div className="docs-mark">✳</div>
          <h1>
            Everything you need
            <br />
            to <span className="array red">just ask.</span>
          </h1>
          <p>The guides, references, and details behind your workspace.</p>
          <div className="search-field docs-search">
            <Search size={19} />
            <input
              id="docs-search"
              placeholder="Search the docs…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <kbd>⌘ K</kbd>
          </div>
          <div className="docs-grid">
            {filtered.map((s, i) => (
              <Link to={"/docs/" + s.id} key={s.id}>
                <span className="eyebrow">{s.group}</span>
                <h3>
                  {s.title} <ArrowUpRight size={17} />
                </h3>
                <p>{s.summary}</p>
              </Link>
            ))}
          </div>
          {!filtered.length && (
            <p>No results. Try “credits”, “keys” or “video”.</p>
          )}
        </main>
      ) : (
        <div className="docs-layout">
          <aside>
            <div className="search-field">
              <Search size={15} />
              <input
                id="docs-search"
                placeholder="Search docs"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {filtered.map((s) => (
              <Link
                key={s.id}
                className={slug === s.id ? "active" : ""}
                to={"/docs/" + s.id}
              >
                {s.title}
              </Link>
            ))}
            <a href="/llms-full.txt">Machine-readable docs ↗</a>
          </aside>
          <article className="prose">
            <div className="eyebrow">{section.group}</div>
            <h1>{section.title}</h1>
            <p className="lead">{section.summary}</p>
            {section.body.map(([heading, text]) => (
              <section key={heading}>
                <h2>{heading}</h2>
                <p>{text}</p>
              </section>
            ))}
            {["api", "integrations"].includes(slug) &&
              Object.entries(code).map(([lang, text]) => (
                <div className="code-block" key={lang}>
                  <div>
                    {lang}
                    <CopyButton text={text} />
                  </div>
                  <pre>
                    <code>{text}</code>
                  </pre>
                </div>
              ))}
            {slug === "cli" && (
              <div className="code-block">
                <div>
                  Terminal
                  <CopyButton
                    text={`curl -fsSL ${location.origin}/cli.mjs -o anonyma.mjs\nnode anonyma.mjs config\nnode anonyma.mjs`}
                  />
                </div>
                <pre>{`curl -fsSL ${location.origin}/cli.mjs -o anonyma.mjs\nnode anonyma.mjs config\nnode anonyma.mjs`}</pre>
              </div>
            )}
            <div className="doc-bottom">
              <Link to="/docs">← All documentation</Link>
              <Link to="/support">Need help? →</Link>
            </div>
          </article>
        </div>
      )}
      <Footer />
    </>
  );
}