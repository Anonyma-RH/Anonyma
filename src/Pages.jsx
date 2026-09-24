import React, { useMemo, useState } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useApp } from "./context.jsx";
import {
  Icon,
  Button,
  SectionTitle,
  Art,
  Notice,
  Empty,
  CopyButton,
  Modal,
} from "./ui.jsx";
import { api, download, savings, walletSign, walletAvailable } from "./lib.js";
import { articles } from "./data.js";
export function PageIntro({ eyebrow, title, children }) {
  return (
    <div className="page-intro">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  );
}
export function Catalog() {
  const { models, catalogMeta } = useApp();
  const [params] = useSearchParams();
  const [query, setQuery] = useState(""),
    [type, setType] = useState("all"),
    [provider, setProvider] = useState(params.get("provider") || "all"),
    [sort, setSort] = useState("name"),
    [selected, setSelected] = useState([]),
    [compare, setCompare] = useState(false),
    [page, setPage] = useState(1);
  const results = useMemo(
    () =>
      models
        .filter(
          (m) =>
            (type === "all" || m.type === type) &&
            (provider === "all" || m.provider === provider) &&
            `${m.name} ${m.id} ${m.provider || ""}`
              .toLowerCase()
              .includes(query.toLowerCase()),
        )
        .sort((a, b) =>
          sort === "context"
            ? (b.context_length || 0) - (a.context_length || 0)
            : String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)),
        ),
    [models, type, provider, query, sort],
  );
  function filter(fn, value) {
    fn(value);
    setPage(1);
  }
  return (
    <main id="main" className="catalog-page">
      <PageIntro
        eyebrow="THE MODEL CATALOG"
        title={
          <>
            Find your kind
            <br />
            of intelligence.
          </>
        }
      >
        Different strengths. One place to explore them.
      </PageIntro>
      <div className="content-width">
        <Notice>
          {catalogMeta.connected
            ? `Connected catalog · ${catalogMeta.source || "ANONYMA service"}. Only models marked available can run.`
            : "Illustrative catalog · Live availability and pricing are not connected."}
          {catalogMeta.refreshError && " Last refresh failed: " + catalogMeta.refreshError}
          {catalogMeta.updatedAt &&
            " Updated " + new Date(catalogMeta.updatedAt).toLocaleString()}
        </Notice>
        <div className="catalog-toolbar">
          <label className="search-field">
            <Icon name="search" />
            <input
              value={query}
              onChange={(e) => filter(setQuery, e.target.value)}
              placeholder="Find a model or provider"
              aria-label="Search models"
            />
          </label>
          <select
            aria-label="Filter provider"
            value={provider}
            onChange={(e) => filter(setProvider, e.target.value)}
          >
            <option value="all">All providers</option>
            {[...new Set(models.map((m) => m.provider).filter(Boolean))].map(
              (p) => (
                <option key={p}>{p}</option>
              ),
            )}
          </select>
          <select
            aria-label="Sort models"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            <option value="name">Name A–Z</option>
            <option value="context">Largest context</option>
          </select>
        </div>
        <div className="filter-tabs" role="group" aria-label="Model type">
          {["all", "chat", "image", "video"].map((t) => (
            <button
              key={t}
              className={t === type ? "active" : ""}
              onClick={() => filter(setType, t)}
              aria-pressed={type === t}
            >
              {t === "all"
                ? "All models"
                : t === "chat"
                  ? "Chat & code"
                  : t === "image"
                    ? "Images"
                    : "Video"}
            </button>
          ))}
        </div>
        <p className="result-count" aria-live="polite">
          {results.length} models · Compare up to 4
        </p>
        <div className="catalog-grid">
          {results.slice((page - 1) * 6, page * 6).map((m) => (
            <article className="catalog-card" key={m.id}>
              <div className="catalog-card-top">
                <span className={"model-symbol " + (m.color || "mint")}>
                  {m.icon || "✧"}
                </span>
                <span className={"status-tag " + (m.callable ? "ready" : "")}>
                  {m.callable ? "Available" : "Catalog only"}
                </span>
              </div>
              <p className="eyebrow">{m.provider || m.id.split("/")[0]}</p>
              <h2>{m.name}</h2>
              <p>
                {m.description ||
                  "Explore the model’s documented capabilities."}
              </p>
              <div className="model-properties">
                <span>
                  <Icon name={m.type || "chat"} size={13} />
                  {m.type === "image"
                    ? "Image generation"
                    : m.type === "video"
                      ? "Video generation"
                      : "Chat & code"}
                </span>
                {m.context_length && (
                  <span>
                    {Math.round(m.context_length / 1000).toLocaleString()}k
                    context
                  </span>
                )}
                {m.vision && <span>Vision</span>}
              </div>
              <div className="catalog-card-bottom">
                <Link
                  to={
                    "/workspace/" +
                    (m.type === "image"
                      ? "image"
                      : m.type === "video"
                        ? "video"
                        : "chat") +
                    "?model=" +
                    encodeURIComponent(m.id)
                  }
                >
                  Open workspace <Icon name="diagonal" size={15} />
                </Link>
                <label className="compare-check">
                  <input
                    type="checkbox"
                    checked={selected.includes(m.id)}
                    disabled={!selected.includes(m.id) && selected.length >= 4}
                    onChange={() =>
                      setSelected((prev) =>
                        prev.includes(m.id)
                          ? prev.filter((id) => id !== m.id)
                          : [...prev, m.id],
                      )
                    }
                  />
                  Compare
                </label>
              </div>
            </article>
          ))}
        </div>
        {!results.length && (
          <Empty
            title="No models found"
            icon="search"
            action={
              <Button
                secondary
                onClick={() => {
                  setQuery("");
                  setType("all");
                  setProvider("all");
                }}
              >
                Clear filters
              </Button>
            }
          >
            Try another name or broaden your filters.
          </Empty>
        )}
        {results.length > 6 && (
          <div className="pagination">
            <button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous
            </button>
            <span>
              Page {page} of {Math.ceil(results.length / 6)}
            </span>
            <button
              disabled={page * 6 >= results.length}
              onClick={() => setPage(page + 1)}
            >
              Next
            </button>
          </div>
        )}
        {selected.length > 0 && (
          <div className="compare-bar">
            <span>{selected.length} selected</span>
            <button onClick={() => setSelected([])}>Clear</button>
            <Button
              onClick={() => setCompare(true)}
              disabled={selected.length < 2}
            >
              Compare models <Icon name="arrow" size={15} />
            </Button>
          </div>
        )}
      </div>
      {compare && (
        <Modal title="A closer look." onClose={() => setCompare(false)}>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Capability</th>
                  {selected.map((id) => (
                    <th key={id}>{models.find((m) => m.id === id)?.name}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  ["Type", (m) => m.type],
                  [
                    "Context",
                    (m) =>
                      m.context_length
                        ? m.context_length.toLocaleString() + " tokens"
                        : "Not verified",
                  ],
                  [
                    "Reference images",
                    (m) => (m.vision ? "Supported by catalog" : "Not listed"),
                  ],
                  [
                    "Availability",
                    (m) => (m.callable ? "Available" : "Not connected"),
                  ],
                  [
                    "Price",
                    (m) =>
                      m.pricing ? JSON.stringify(m.pricing) : "Not connected",
                  ],
                ].map(([label, get]) => (
                  <tr key={label}>
                    <th>{label}</th>
                    {selected.map((id) => (
                      <td key={id}>{get(models.find((m) => m.id === id))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="fine-print">
            Catalog information is illustrative until the shared backend
            supplies verified models and prices.
          </p>
        </Modal>
      )}
    </main>
  );
}
export function Pricing() {
  const [monthly, setMonthly] = useState(60),
    [usage, setUsage] = useState(15),
    [amount, setAmount] = useState(10);
  const result = savings(monthly, usage);
  return (
    <main id="main">
      <PageIntro
        eyebrow="PRICING & CREDITS"
        title={
          <>
            More possibility.
            <br />
            On your terms.
          </>
        }
      >
        A shared prepaid balance. Use what you need, when you need it.
      </PageIntro>
      <div className="content-width">
        <div className="pricing-main">
          <div>
            <p className="eyebrow">ONE BALANCE. EVERY WORKFLOW.</p>
            <h2>
              Pay for the work.
              <br />
              Keep the freedom.
            </h2>
            <p>
              Chat, code, images and video draw from the same credit balance.
              Your developer API does, too.
            </p>
            <ul className="check-list">
              {[
                "No automatic subscription",
                "Estimate before you generate",
                "Usage receipts after your request",
                "Available and reserved credits shown separately",
              ].map((t) => (
                <li key={t}>
                  <Icon name="check" />
                  {t}
                </li>
              ))}
            </ul>
            <Button to="/account/credits">
              Explore credits <Icon name="arrow" />
            </Button>
          </div>
          <div className="credit-card">
            <span className="eyebrow">THE CREDIT CONVERSION</span>
            <h3>
              $1 <span>=</span> 1,000
            </h3>
            <p>
              US dollar <span>ANONYMA credits</span>
            </p>
            <label>
              Explore an amount{" "}
              <div className="currency-input">
                <span>$</span>
                <input
                  type="number"
                  min="5"
                  max="10000"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  aria-label="Credit conversion amount"
                />
              </div>
            </label>
            <div className="conversion">
              <b>{(Math.max(0, Number(amount)) * 1000).toLocaleString()}</b>
              <span>credits</span>
            </div>
            <small>
              Conversion only. Checkout and live model rates are not connected
              in this preview.
            </small>
          </div>
        </div>
        <section className="calculator" id="calculator">
          <div>
            <p className="eyebrow">A LITTLE PERSPECTIVE</p>
            <h2>
              What could a different
              <br />
              way look like?
            </h2>
            <p>
              Adjust your own assumptions. Compare a monthly subscription budget
              with an estimated usage budget.
            </p>
            <p className="fine-print">
              Illustrative arithmetic, not a savings guarantee or a provider
              quote. Enter budgets for comparable usage.
            </p>
          </div>
          <div className="calculator-panel">
            <label>
              Monthly subscription budget <strong>${monthly}</strong>
              <input
                aria-label="Monthly subscription budget"
                type="range"
                min="0"
                max="300"
                step="5"
                value={monthly}
                onChange={(e) => setMonthly(Number(e.target.value))}
              />
            </label>
            <label>
              Estimated monthly usage budget <strong>${usage}</strong>
              <input
                aria-label="Estimated usage budget"
                type="range"
                min="0"
                max="300"
                step="5"
                value={usage}
                onChange={(e) => setUsage(Number(e.target.value))}
              />
            </label>
            <div className="calculator-result" aria-live="polite">
              <span>
                {result.monthly >= 0
                  ? "Potential annual difference"
                  : "Additional annual usage budget"}
              </span>
              <b>${Math.abs(result.monthly * 12).toLocaleString()}</b>
              <small>
                Based on your ${monthly} / ${usage} monthly assumptions
              </small>
            </div>
            <div className="inline-actions">
              <CopyButton
                text={`ANONYMA budget comparison: subscriptions $${monthly}/month; estimated usage $${usage}/month; annual difference $${result.monthly * 12}. Illustrative assumptions, not a quote.`}
                label="Copy estimate"
              />
              <button
                className="small-button"
                onClick={() =>
                  download(
                    "anonyma-budget-estimate.json",
                    JSON.stringify(
                      {
                        subscriptionMonthly: monthly,
                        usageMonthly: usage,
                        annualDifference: result.monthly * 12,
                        disclaimer: "User assumptions, not a provider quote",
                      },
                      null,
                      2,
                    ),
                  )
                }
              >
                <Icon name="download" size={14} />
                Export
              </button>
            </div>
          </div>
        </section>
        <Notice>
          Live prices must come from the shared model catalog. Payment processor
          fees, platform markup and commercial terms require operator approval
          before launch.
        </Notice>
      </div>
    </main>
  );
}
const docsTopics = [
  [
    "getting-started",
    "Getting started",
    "Your first workspace",
    "Choose a workflow, explore the model catalog and sign in when the service is connected. The demo opens a local sample workspace so you can explore the experience without creating an account.",
  ],
  [
    "models",
    "Choosing a model",
    "Find a model that fits",
    "Models have distinct capabilities. Chat/code, image generation, reference input and video options are checked independently. Catalog-only models are never silently replaced with another model.",
  ],
  [
    "credits",
    "Credits & receipts",
    "Know where every credit goes",
    "1 USD equals 1,000 displayed credits. Available balance excludes held credits. A quote is an estimate; the final receipt carries credits_charged. Stopping a request may still incur partial charges.",
  ],
  [
    "images",
    "Images & video",
    "Make something visual",
    "Images support 1–4 outputs, up to eight PNG/JPEG/WebP/GIF references, and independent comparison of up to four compatible models. Videos have persistent submitting, pending, processing, completed, failed or reconciliation states.",
  ],
  [
    "api",
    "Developer API",
    "Bring your own tools",
    "Use an ANONYMA customer key with the documented /v1 subset. Available contracts include model listing, balance and chat completions. Audio, embeddings, tools, web search and the Responses API are excluded.",
  ],
  [
    "privacy",
    "History & privacy",
    "Keep your work organized",
    "The documented retention limits are 300 conversations, 100 images and 60 videos per account. API images have separate 24-hour expiry. Demo data lives only in this browser and can be exported or cleared.",
  ],
];
export function Docs() {
  const [search, setSearch] = useState("");
  const location = useParams()["*"];
  const topic = docsTopics.find((t) => t[0] === location) || docsTopics[0];
  const shown = docsTopics.filter((t) =>
    t.join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <main id="main">
      <PageIntro
        eyebrow="DOCUMENTATION"
        title="A little guidance goes a long way."
      >
        Get to know your workspace, credits and connected tools.
      </PageIntro>
      <div className="docs-layout content-width">
        <aside>
          <label className="search-field">
            <Icon name="search" size={16} />
            <input
              aria-label="Search documentation"
              placeholder="Search documentation"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <nav aria-label="Documentation topics">
            {shown.map(([id, title]) => (
              <Link
                key={id}
                className={topic[0] === id ? "active" : ""}
                to={"/docs/" + id}
              >
                {title}
                <Icon name="arrow" size={14} />
              </Link>
            ))}
          </nav>
          {!shown.length && <p>No topics found.</p>}
        </aside>
        <article className="doc-article">
          <p className="eyebrow">WORKSPACE GUIDE</p>
          <h2>{topic[2]}</h2>
          <p className="lead">{topic[3]}</p>
          <h3>Try the experience</h3>
          <p>
            Open the interactive demo to explore the interface. Every sample
            result is labeled. Real accounts, AI generation and payment
            confirmation require the connected ANONYMA service.
          </p>
          <Button to="/workspace/chat?demo=1">
            Open the demo <Icon name="arrow" />
          </Button>
          <h3>Keep these distinctions in mind</h3>
          <ul className="check-list">
            <li>
              <Icon name="check" />A model listing is different from confirmed
              availability.
            </li>
            <li>
              <Icon name="check" />
              An estimated charge is different from a final receipt.
            </li>
            <li>
              <Icon name="check" />A wallet connection is different from
              authentication or payment.
            </li>
            <li>
              <Icon name="check" />
              Local demo data is different from an account saved on a server.
            </li>
          </ul>
          {topic[0] === "api" && <ApiExample />}
          <div className="doc-next">
            <span>Need a hand?</span>
            <Link to="/support">
              Visit help & support <Icon name="arrow" size={16} />
            </Link>
          </div>
        </article>
      </div>
    </main>
  );
}
const example = `curl https://YOUR_ANONYMA_DOMAIN/v1/chat/completions \\\n  -H "Authorization: Bearer $ANONYMA_API_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{"model":"YOUR_CALLABLE_MODEL_ID",\n       "messages":[{"role":"user","content":"Hello"}],\n       "stream":true}'`;
function ApiExample() {
  return (
    <div className="code-example">
      <div>
        <span>CHAT COMPLETIONS</span>
        <CopyButton text={example} />
      </div>
      <pre>
        <code>{example}</code>
      </pre>
      <small>
        Replace domain and model ID with your verified service settings. Keep
        keys private.
      </small>
    </div>
  );
}
export function Developers() {
  return (
    <main id="main">
      <PageIntro
        eyebrow="FOR DEVELOPERS"
        title={
          <>
            Your tools.
            <br />A shared starting point.
          </>
        }
      >
        Connect a supported client to your ANONYMA balance.
      </PageIntro>
      <div className="content-width">
        <div className="developer-split">
          <div>
            <h2>
              One API.
              <br />
              Your kind of workflow.
            </h2>
            <p>
              Use a customer API key for the documented chat-completions
              interface. Track usage alongside your web workspace.
            </p>
            <div className="inline-actions">
              <Button to="/account/keys">
                Explore API keys <Icon name="arrow" />
              </Button>
              <Button to="/docs/api" secondary>
                Read the docs
              </Button>
            </div>
            <Notice>
              The API is a documented integration contract. This preview does
              not serve live completions or issue production keys.
            </Notice>
          </div>
          <ApiExample />
        </div>
        <div className="developer-features">
          {[
            [
              "key",
              "Keys you control",
              "Name keys, set a rolling 24-hour spending cap, and revoke access.",
            ],
            [
              "credits",
              "A shared ledger",
              "Web and API requests use the same available and reserved credit balances.",
            ],
            [
              "code",
              "A defined interface",
              "Chat completions, model listing and balance. Supported compatibility stays explicit.",
            ],
          ].map(([i, t, b]) => (
            <article key={i}>
              <Icon name={i} size={27} />
              <h3>{t}</h3>
              <p>{b}</p>
            </article>
          ))}
        </div>
      </div>
    </main>
  );
}
export function Article() {
  const { slug } = useParams();
  const a = articles.find((a) => a.slug === slug);
  if (!a) return <NotFound />;
  return (
    <main id="main">
      <PageIntro eyebrow={a.tag} title={a.title}>
        {a.intro}
      </PageIntro>
      <article className="reading-width">
        <Art kind={a.icon} color={a.color} />
        {a.body.map((b, i) => (
          <section key={b}>
            <p className="eyebrow">0{i + 1}</p>
            <p className="article-paragraph">{b}</p>
          </section>
        ))}
        <Link className="text-link" to="/docs">
          Continue exploring <Icon name="arrow" />
        </Link>
      </article>
    </main>
  );
}
// What ships at launch; everything else comes from config.releases.updates.
// Features are presented by name, never by release number.
const featureIcons = {
  mvp: "chat",
  code: "code",
  search: "globe",
  images: "image",
  catalog: "models",
  audio: "audio",
  video: "video",
  collab: "users",
  api: "key",
  social: "gift",
};
const launch = {
  id: "mvp",
  title: "Chat & Credits",
  tagline: "Top models on one prepaid balance.",
  points: [
    "Chat with top models from leading labs",
    "One prepaid credit balance",
    "Pay with USDG on Robinhood Chain from your own wallet",
    "No subscription",
  ],
  released: true,
};
export function Roadmap() {
  const { config } = useApp();
  const updates = config?.releases?.updates || [];
  // Live first (launch, then released updates), then what's coming, in order.
  const cards = [
    launch,
    ...updates.filter((u) => u.released),
    ...updates.filter((u) => !u.released),
  ];
  const pending = cards.some((u) => !u.released);
  return (
    <main id="main">
      <PageIntro
        eyebrow="THE ROAD AHEAD"
        title={
          <>
            Live now,
            <br />
            and what's next.
          </>
        }
      >
        {pending
          ? "What you can use today comes first. The rest arrives feature by feature, in the order below."
          : "Everything below is live today, on one prepaid balance."}
      </PageIntro>
      <div className="content-width roadmap-grid">
        {cards.map((u, i) => (
          <article key={u.id}>
            <span
              className={
                "roadmap-number " + ["mint", "lavender", "yellow"][i % 3]
              }
            >
              <Icon name={featureIcons[u.id] || "chat"} size={20} />
            </span>
            <p className="eyebrow">{u.released ? "LIVE NOW" : "COMING SOON"}</p>
            <h2>{u.title}</h2>
            <p className="coming-soon-tagline">{u.tagline}</p>
            <ul>
              {u.points.map((t) => (
                <li key={t}>
                  <Icon name={u.released ? "check" : "history"} size={17} />
                  {t}
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>
    </main>
  );
}
export function Support() {
  const { connected, user } = useApp();
  const [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setMessage("");
    setBusy(true);
    try {
      const r = await api("/api/support", {
        method: "POST",
        body: { subject, body },
      });
      setMessage(
        `Support ticket ${r.id} saved for the operator. No email delivery is implied.`,
      );
      setSubject("");
      setBody("");
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main">
      <PageIntro eyebrow="HELP & SUPPORT" title="A good place to ask.">
        Find an answer, or prepare a note for the team.
      </PageIntro>
      <div className="support-layout content-width">
        <div>
          <h2>
            A little help,
            <br />
            when you need it.
          </h2>
          <p>Explore guides to models, credits and your workspace.</p>
          <Link to="/docs" className="text-link">
            Browse documentation <Icon name="arrow" />
          </Link>
          <Notice>
            {connected && user
              ? "Your note will be saved as a support ticket for the operator."
              : "Support delivery is not connected. You can download a draft of your note."}
          </Notice>
        </div>
        <form onSubmit={submit} className="form-panel">
          <label>
            Subject
            <input
              required
              maxLength="200"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="What can we help with?"
            />
          </label>
          <label>
            Your message
            <textarea
              required
              rows="7"
              maxLength="10000"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="A little context goes a long way."
            />
          </label>
          {connected && user ? (
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : "Save support ticket"}
              <Icon name="arrow" />
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!subject.trim() || !body.trim()}
              onClick={() => {
                download(
                  "anonyma-support-draft.txt",
                  `Subject: ${subject}\n\n${body}`,
                  "text/plain",
                );
                setMessage("Draft downloaded. It has not been sent.");
              }}
            >
              Download draft <Icon name="download" />
            </Button>
          )}
          {message && <Notice>{message}</Notice>}
        </form>
      </div>
    </main>
  );
}
export function Legal({ type }) {
  return (
    <main id="main">
      <PageIntro
        eyebrow="PREVIEW INFORMATION"
        title={
          type === "privacy"
            ? "Your work, considered."
            : "A clear starting point."
        }
      >
        {type === "privacy"
          ? "How this preview handles information."
          : "The boundaries of this interactive preview."}
      </PageIntro>
      <article className="reading-width legal">
        <Notice>
          This is a frontend preview notice. Final operator policies and legal
          entity details must be supplied before a public service launch.
        </Notice>
        {(type === "privacy"
          ? [
              [
                "Local demo storage",
                "If you choose the demo, sample conversations, locally uploaded reference previews, draft settings and illustrative account activity may be stored in this browser. Use account settings to export or clear the demo. Do not enter sensitive information.",
              ],
              [
                "Service connections",
                "When a backend is configured, account data and submitted prompts go to that service and its configured providers. Production retention, processing locations and contact details must be disclosed by the operator.",
              ],
              [
                "No invented privacy promises",
                "This preview does not claim end-to-end encryption, independent security certification or a production deletion guarantee. The intended account service scopes stored work to its owner.",
              ],
            ]
          : [
              [
                "An interface you can explore",
                "Demo outputs are prepared examples. They are not live model responses, purchased credits or proof that a provider request succeeded. No payment can be made in the standalone preview.",
              ],
              [
                "Usage and availability",
                "Live model rates, service availability, refund terms and interrupted-request billing must be confirmed by the operator. Calculator amounts are user assumptions and do not create a commercial offer.",
              ],
              [
                "Before launch",
                "The operator must supply final service terms, privacy policy, contact details, pricing policies and confirmed integrations. Planned capabilities are not included in current service availability.",
              ],
            ]
        ).map(([h, b]) => (
          <section key={h}>
            <h2>{h}</h2>
            <p>{b}</p>
          </section>
        ))}
      </article>
    </main>
  );
}
export function Auth({ register = false }) {
  const { config, connected, refresh } = useApp();
  const navigate = useNavigate();
  const [method, setMethod] = useState("password"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [challenge, setChallenge] = useState(null),
    [recover, setRecover] = useState(false);
  async function walletSubmit() {
    setBusy(true);
    setError("");
    try {
      await walletSign(config);
      await refresh();
      navigate("/workspace");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(e) {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true);
    setError("");
    try {
      if (method === "email" && !challenge) {
        const r = await api("/api/auth/email/send", {
          method: "POST",
          body: { email: data.email, purpose: recover ? "recover" : "login" },
        });
        setChallenge(r);
        return;
      }
      await api(
        method === "email"
          ? "/api/auth/email/verify"
          : register
            ? "/api/auth/register"
            : "/api/auth/password",
        {
          method: "POST",
          body:
            method === "email"
              ? {
                  id: challenge.id,
                  code: data.code,
                  ...(recover ? { password: data.password } : {}),
                }
              : { username: data.username, password: data.password },
        },
      );
      await refresh();
      navigate("/workspace");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main" className="auth-page">
      <div className="auth-art">
        <Art kind="models" color="mint" />
        <h2>
          A little more
          <br />
          possibility awaits.
        </h2>
        <p>Your ideas. Your workspace. Your next beginning.</p>
      </div>
      <div className="auth-card">
        <p className="eyebrow">YOUR ANONYMA ACCOUNT</p>
        <h1>
          {recover
            ? "A fresh start."
            : register
              ? "Make room for your ideas."
              : "Welcome back."}
        </h1>
        <p>
          {register
            ? "Start with a username and password."
            : "Pick up where your last idea left off."}
        </p>
        <div className="filter-tabs">
          {["password", "email", "wallet"].map((m) => (
            <button
              key={m}
              aria-pressed={m === method}
              className={m === method ? "active" : ""}
              onClick={() => {
                setMethod(m);
                setError("");
                setChallenge(null);
                setRecover(false);
              }}
            >
              {m[0].toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
        {method === "wallet" ? (
          <>
            <Notice>
              Sign a one-time message to prove you control a wallet. No
              transfer, approval or payment is requested, and ANONYMA never asks
              for a recovery phrase.
            </Notice>
            {connected ? (
              <Button onClick={walletSubmit} disabled={busy || !walletAvailable(config)}>
                {busy ? "Waiting for your wallet…" : "Connect wallet"}
              </Button>
            ) : (
              <Button disabled>Wallet sign-in needs the account service</Button>
            )}
            {connected && !walletAvailable(config) && (
              <p className="fine-print">
                No browser wallet was found, and WalletConnect is not configured on
                this service.
              </p>
            )}
            {error && <Notice type="error">{error}</Notice>}
          </>
        ) : (
          <form onSubmit={submit}>
            {method === "password" ? (
              <>
                <label>
                  Username
                  <input
                    name="username"
                    autoComplete="username"
                    required
                    minLength="3"
                    maxLength="32"
                    pattern="[A-Za-z0-9_\-]+"
                    placeholder="Your username"
                  />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    autoComplete={
                      register ? "new-password" : "current-password"
                    }
                    required
                    minLength={register ? 10 : 1}
                    maxLength="256"
                    placeholder={
                      register ? "At least 10 characters" : "Your password"
                    }
                  />
                </label>
              </>
            ) : challenge ? (
              <>
                <Notice>
                  Enter the code from your email. It expires after 10 minutes.
                  {challenge.testCode &&
                    ` Local test mode: no email was sent; your code is ${challenge.testCode}.`}
                </Notice>
                <label>
                  Email code
                  <input
                    name="code"
                    inputMode="numeric"
                    pattern="[0-9]{6}"
                    required
                    maxLength="6"
                    placeholder="6-digit code"
                  />
                </label>
                {recover && (
                  <label>
                    New password
                    <input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      minLength="10"
                      maxLength="256"
                      required
                      placeholder="At least 10 characters"
                    />
                  </label>
                )}
              </>
            ) : (
              <label>
                Email
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@example.com"
                />
              </label>
            )}
            {error && <Notice type="error">{error}</Notice>}
            <Button
              type="submit"
              disabled={
                busy ||
                !connected ||
                (method === "email" && !config?.services?.email)
              }
            >
              {busy
                ? "Please wait…"
                : method === "email"
                  ? challenge
                    ? "Verify code"
                    : "Send a code"
                  : register
                    ? "Create account"
                    : "Log in"}
              <Icon name="arrow" />
            </Button>
          </form>
        )}
        {!connected && (
          <p className="auth-status">
            Account services are not connected in this preview.
          </p>
        )}
        <div className="auth-bottom">
          {!register && (
            <button
              className="text-link recovery-link"
              onClick={() => {
                setRecover(!recover);
                setMethod(recover ? "password" : "email");
                setChallenge(null);
                setError("");
              }}
            >
              {recover ? "Back to sign in" : "Forgot your password?"}
            </button>
          )}
          <p>
            {register ? "Already have an account?" : "New here?"}{" "}
            <Link to={register ? "/login" : "/register"}>
              {register ? "Log in" : "Create an account"}
            </Link>
          </p>
          <Link to="/workspace/chat?demo=1" className="text-link">
            Explore the interactive demo <Icon name="arrow" size={15} />
          </Link>
        </div>
      </div>
    </main>
  );
}
export function NotFound() {
  return (
    <main id="main">
      <PageIntro
        eyebrow="404 · A SMALL DETOUR"
        title="This page has wandered off."
      >
        Let’s get you back to a good starting point.
      </PageIntro>
      <div className="centered">
        <Button to="/">
          Back to ANONYMA <Icon name="arrow" />
        </Button>
      </div>
    </main>
  );
}
