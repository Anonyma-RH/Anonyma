import DataControls from "./DataControls.jsx";
import ApiGuide, { ApiExample } from "./ApiGuide.jsx";
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
import {
  api,
  download,
  savings,
  walletSign,
  walletAvailable,
  safeNext,
} from "./lib.js";
import { articles } from "./data.js";
import ReleaseStatus from "./ReleaseStatus.jsx";
import BillingRules from "./BillingRules.jsx";
import { featureEnabled, featureLabel, guideReleaseLabel, releaseCopy, modelAvailability } from "./release-copy.js";
import { TrainingTag, trainingLabelsReleased } from "./TrainingLabels.jsx";
import { EarlyModelTag } from "./early-models.js";
import "./mcp.css";
import V1Media from "./V1Media.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { TwoStepPrompt } from "./TwoStep.jsx";
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
  const { models, catalogMeta, config } = useApp();
  const trainingLive = trainingLabelsReleased(config);
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
        <ReleaseStatus />
        <Notice>
          {catalogMeta.connected
            ? `Connected catalog · ${catalogMeta.source || "ANONYMA service"}. Availability refers to this web workspace; developer API access has a separate release gate.`
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
          {results.slice((page - 1) * 6, page * 6).map((m) => {
            const availability = modelAvailability(m, config, catalogMeta);
            return (
              <article className="catalog-card" key={m.id}>
                <div className="catalog-card-top">
                  <span className={"model-symbol " + (m.color || "mint")}>
                    {m.icon || "✧"}
                  </span>
                  <span className={"status-tag " + (availability.workspaceReady ? "ready" : "")}>
                    {availability.workspace}
                  </span>
                </div>
                <p className="model-api-status">{availability.api}</p>
                <p className="eyebrow">{m.provider || m.id.split("/")[0]}</p>
                <h2>
                  {m.name}
                  <EarlyModelTag model={m} />
                </h2>
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
                  {trainingLive && m.trainsOnPrompts && (
                    <TrainingTag model={m} models={models} />
                  )}
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
            );
          })}
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
                    "Chat / workspace",
                    (m) => modelAvailability(m, config, catalogMeta).workspace,
                  ],
                  [
                    "Developer API",
                    (m) => modelAvailability(m, config, catalogMeta).api,
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
            {catalogMeta.connected
              ? "Chat availability and developer API access are separate. Labels reflect the latest loaded service configuration; provider availability can change."
              : "Illustrative catalog. Live availability and prices could not be verified."}
          </p>
        </Modal>
      )}
    </main>
  );
}
export function Pricing() {
  const { config } = useApp();
  const paymentCopy = releaseCopy(config).payment;
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
        <ReleaseStatus payment />
        <p><Link to="/docs/billing" className="text-link">Read billing rules: rates, fees, refunds and failed requests <Icon name="arrow" size={16} /></Link></p>
        <div className="pricing-main">
          <div>
            <p className="eyebrow">ONE BALANCE. EVERY WORKFLOW.</p>
            <h2>
              Pay for the work.
              <br />
              Keep the freedom.
            </h2>
            <p>
              Released workspace features draw from one credit balance.
              The roadmap shows which workflows are currently enabled.
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
              Conversion estimate only. {paymentCopy}
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
          Use the model catalog and request estimate for current rates. The final
          receipt records the charge. Published commercial policies still need
          operator completion; this calculator does not establish refund terms.
        </Notice>
      </div>
    </main>
  );
}
const docsTopics = [
  [
    "billing",
    "Billing rules",
    "Understand every charge",
    "Rates, fees, payment verification, refunds and what happens when a request stops or fails.",
  ],
  [
    "getting-started",
    "Getting started",
    "Your first workspace",
    "Check the current release below, create an account or sign in, and choose an available chat model. Add credits using the payment method shown in your account. The optional demo uses local sample outputs and makes no AI requests or payments.",
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
    "Use an ANONYMA customer key with the documented /v1 subset. Available contracts include model listing, balance and chat completions. Supported fields, streaming, retries and billing behavior are documented below.",
  ],
  [
    "privacy",
    "History & privacy",
    "Keep your work organized",
    "Review the actual storage limits, download your data and understand what content deletion and account closure remove.",
  ],
];
const guideFeatures = { images: ["images", "video"], api: ["api"] };
export function Docs() {
  const { config } = useApp();
  const [search, setSearch] = useState("");
  const location = useParams()["*"];
  const topic = docsTopics.find((t) => t[0] === location) || (!location ? docsTopics.find((t) => t[0] === "getting-started") : null);
  const guideStatus = guideReleaseLabel(config, guideFeatures[topic?.[0]]);
  const planned = !!guideStatus;
  const shown = docsTopics.filter((t) =>
    t.join(" ").toLowerCase().includes(search.toLowerCase()),
  );
  if (!topic) return <NotFound />;
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
                <span>{title}{guideReleaseLabel(config, guideFeatures[id]) && (
                  <> <span className="soon-tag">{guideReleaseLabel(config, guideFeatures[id])}</span></>
                )}</span>
                <Icon name="arrow" size={14} />
              </Link>
            ))}
          </nav>
          {!shown.length && <p>No topics found.</p>}
        </aside>
        <article className="doc-article">
          <ReleaseStatus payment={topic[0] === "credits"} />
          <p className="eyebrow">{guideStatus || "WORKSPACE GUIDE"}</p>
          <h2>{topic[2]}</h2>
          {planned ? <Notice>
            {topic[0] === "api"
              ? "Developer API & CLI is coming soon. Production API keys and completions are not available in this release."
              : "Image Studio and Video Studio are separate releases. The labels below show which studio is available; unreleased functionality is planned."}
            {" "}<Link to="/roadmap">View the roadmap</Link>.
          </Notice> : null}
          {topic[0] === "images" && (
            <ul>
              <li>{featureLabel(config, "images", "Image Studio")}</li>
              <li>{featureLabel(config, "video", "Video Studio")}</li>
            </ul>
          )}
          {(!planned || topic[0] !== "api") && <p className="lead">{topic[3]}</p>}
          {topic[0] === "billing" && <BillingRules />}
          {topic[0] === "privacy" && <DataControls />}
          {topic[0] === "credits" && <p><Link to="/docs/billing">Read the full billing rules, including fees, refunds and failed requests.</Link></p>}
          {topic[0] !== "api" && <>
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
          </>}
          {topic[0] === "api" && !planned && <ApiGuide />}
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
export function Developers() {
  const { config } = useApp();
  if (!featureEnabled(config, "api")) return (
    <main id="main">
      <PageIntro eyebrow="COMING SOON" title="Developer API & CLI">
        API keys, external client integrations and the CLI are not available in the current release.
      </PageIntro>
      <div className="content-width">
        <ReleaseStatus />
        <Button to="/roadmap">View the roadmap <Icon name="arrow" /></Button>
      </div>
    </main>
  );
  const mcpLive = featureEnabled(config, "mcp");
  const connectLive = ["api", "mcp", "allowances", "connect"].every((id) =>
    featureEnabled(config, id),
  );
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
              Developer API access is enabled for this installation. Create an
              account key, check available models, and review the API contract
              before connecting a client.
            </Notice>
          </div>
          <ApiExample />
        </div>
        <div
          className={"developer-features" + (mcpLive ? " mcp-live" : "")}
        >
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
            ...(mcpLive
              ? [
                  [
                    "command",
                    "An MCP server, too",
                    connectLive
                      ? "Point any MCP client at /mcp with a key, or approve an app in one click with its own budget."
                      : "Connect Claude Code, Cursor and other MCP clients to your balance at /mcp.",
                  ],
                ]
              : []),
          ].map(([i, t, b]) => (
            <article key={i}>
              <Icon name={i} size={27} />
              <h3>{t}</h3>
              <p>{b}</p>
            </article>
          ))}
        </div>
        {featureEnabled(config, "v1media") && <V1Media config={config} />}
      </div>
    </main>
  );
}
export function Article() {
  const { config } = useApp();
  const { slug } = useParams();
  const a = articles.find((a) => a.slug === slug);
  if (!a) return <NotFound />;
  return (
    <main id="main">
      <PageIntro eyebrow={a.tag} title={a.title}>
        {a.intro}
      </PageIntro>
      <article className="reading-width">
        <ReleaseStatus payment={slug === "understanding-credits"} />
        {slug === "understanding-credits" && <p><Link to="/docs/billing">Read billing rules: rates, fees, refunds and interrupted requests.</Link></p>}
        {slug === "choose-a-model" && (
          <Notice>
            {featureLabel(config, "images", "Image Studio")}.{" "}
            {featureLabel(config, "video", "Video Studio")}.
          </Notice>
        )}
        {slug === "one-api" && !featureEnabled(config, "api") && <Notice>
          Coming soon: Developer API & CLI. The notes below describe planned behavior, not an available integration.
        </Notice>}
        <Art kind={a.icon} color={a.color} />
        {(slug === "one-api" && !featureEnabled(config, "api") ? [] : a.body).map((b, i) => (
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
  veil: "eyeoff",
  uncensored: "chat",
  ephemeral: "shield",
  private: "shield",
  zh: "globe",
  documents: "file",
  files: "file",
  symposium: "panel",
  receipts: "shield",
  scrolls: "book",
  app: "download",
  training: "eye",
  mcp: "command",
  allowances: "coins",
  connect: "plug",
  finder: "search",
  estimates: "coins",
  longanswers: "book",
  holders: "credits",
  v1media: "image",
  treasury: "coins",
  chatcontrol: "book",
  voice: "audio",
  trail: "route",
  seedguard: "lock",
  cleanuploads: "eraser",
  wipe: "delete",
  vault: "lock",
  routines: "history",
  sealedshare: "lock",
  projects: "folder",
  costcompare: "coins",
  chatexport: "download",
  bookmarks: "star",
  sealed: "lock",
  paynyma: "coins",
  findinchat: "search",
  earlymodels: "models",
  diagrams: "sigma",
  shield: "shield",
  redact: "redact",
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
    { ...launch, points: [launch.points[0], launch.points[1], releaseCopy(config).payment, launch.points[3]], released: !!config && !config.testMode && !!config.services?.generation },
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
          : config?.testMode ? "Local test configuration; no live service is implied." : !config?.releases ? "Current release status could not be loaded." : "All listed features are enabled for this installation."}
      </PageIntro>
      <div className="content-width"><ReleaseStatus payment /></div>
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
            {/* An early update is open to NYMA holders already, so it says so
                even on a local test installation. */}
            <p className="eyebrow">{!config?.releases ? "STATUS UNAVAILABLE" : !u.released && u.early ? "EARLY ACCESS FOR NYMA HOLDERS" : config.testMode ? "LOCAL TEST" : u.released ? "LIVE NOW" : u.id === "mvp" ? "TEMPORARILY UNAVAILABLE" : "COMING SOON"}</p>
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
  const { connected, user, config } = useApp();
  const canSend = connected && config?.services?.support;
  const [email, setEmail] = useState(null);
  const [subject, setSubject] = useState(""),
    [body, setBody] = useState(""),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  // Seed Guard: a support request never carries a seed phrase or key, and
  // there is no "Send anyway": support never needs one. A transaction hash
  // (64-hex) is often exactly what support needs, so that asks once.
  const seedHit = useSeedScan(seedGuardLive(config), subject + "\n" + body);
  async function submit(e, { notKey = false } = {}) {
    e?.preventDefault();
    if (seedHit && !(notKey && seedHit.kind === "hex")) return;
    setMessage("");
    setBusy(true);
    try {
      const r = await api("/api/support", {
        method: "POST",
        body: { subject, body, email: email ?? user?.email ?? "" },
      });
      setMessage(r.message);
      if (r.delivery === "accepted") {
        setSubject("");
        setBody("");
      }
    } catch (e) {
      setMessage(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <main id="main">
      <PageIntro eyebrow="HELP & SUPPORT" title="A good place to ask.">
        Help with your account, payments, privacy or workspace.
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
            {canSend
              ? "Send a request to our support inbox. You do not need to sign in. Never include passwords, API keys or wallet recovery phrases."
              : "The support form is temporarily unavailable. You can keep a draft of your message."}
          </Notice>
          {config?.supportEmail && (
            <p>
              Or email{" "}
              <a href={`mailto:${config.supportEmail}`}>
                {config.supportEmail}
              </a>{" "}
              directly.
            </p>
          )}
        </div>
        <form onSubmit={submit} className="form-panel">
          <label>
            Reply email
            <input
              type="email"
              required
              autoComplete="email"
              maxLength="254"
              value={email ?? user?.email ?? ""}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
            />
          </label>
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
          {canSend && (
            <SeedGuardNotice
              hit={seedHit}
              busy={busy}
              hardOverride={false}
              onProceed={() => submit(null, { notKey: true })}
            >
              <p className="seed-guard-note">
                ANONYMA support will never ask for your seed phrase or private key.
              </p>
            </SeedGuardNotice>
          )}
          {canSend ? (
            <Button type="submit" disabled={busy || !!seedHit}>
              {busy ? "Sending…" : "Send support request"}
              <Icon name="arrow" />
            </Button>
          ) : (
            <Button
              type="button"
              disabled={!subject.trim() || !body.trim()}
              onClick={() => {
                download(
                  "anonyma-support-draft.txt",
                  `Reply email: ${email || user?.email || ""}\nSubject: ${subject}\n\n${body}`,
                  "text/plain",
                );
                setMessage("Draft downloaded. It has not been sent.");
              }}
            >
              Download draft <Icon name="download" />
            </Button>
          )}
          {message && (
            <div role="status">
              <Notice>{message}</Notice>
            </div>
          )}
        </form>
      </div>
    </main>
  );
}
export function Legal({ type }) {
  return (
    <main id="main">
      <PageIntro
        eyebrow={type === "privacy" ? "PRIVACY INFORMATION" : "SERVICE INFORMATION"}
        title={
          type === "privacy"
            ? "Your work, considered."
            : "A clear starting point."
        }
      >
        {type === "privacy"
          ? "How the connected service and optional demo handle information."
          : "Current service availability and outstanding policy information."}
      </PageIntro>
      <article className="reading-width legal">
        <ReleaseStatus payment />
        <Notice>
          These disclosures are incomplete. Final operator identity, jurisdiction,
          contact details and commercial policies still need to be published.
          This page does not present them as finalized Terms or a complete Privacy Policy.
        </Notice>
        {type === "privacy" && <p><Link to="/docs/privacy">Data controls: retention, export, deletion and retained records.</Link></p>}
        {type === "terms" && <p><Link to="/docs/billing">Billing rules: rates, fees, refunds, payment failures and interrupted requests.</Link></p>}
        {(type === "privacy"
          ? [
              [
                "Local demo storage",
                "If you choose the demo, sample conversations, locally uploaded reference previews, draft settings and illustrative account activity may be stored in this browser. Use account settings to export or clear the demo. Do not enter sensitive information.",
              ],
              [
                "Service connections",
                "In the connected service, account data is stored on the server and submitted prompts are sent to configured AI providers. The data-controls guide documents application retention and deletion. Provider and backup retention, processing locations and operator contact details remain to be disclosed.",
              ],
              [
                "No invented privacy promises",
                "ANONYMA does not claim end-to-end encryption or independent security certification. Account access controls restrict saved work. Application export and deletion controls have the limitations described in the data-controls guide.",
              ],
            ]
          : [
              [
                "Connected service and optional demo",
                "The connected service provides the features shown in the current release above. The optional interactive demo uses prepared examples stored in your browser, makes no provider requests and cannot accept payments. Demo balances are not purchased credits.",
              ],
              [
                "Usage and availability",
                "Current rates and availability are shown in the connected catalog and request estimates. Final receipts record usage charges; interrupted requests may still incur costs. Refund requests are reviewed individually, with no automatic refunds. See the billing rules for the review process. Calculator amounts are assumptions, not invoices.",
              ],
              [
                "Outstanding policies",
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
  // An app's connection request waiting for sign-in: go back to it after,
  // with a full page load so its own headers (no referrer) apply.
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));
  const done = () =>
    next ? window.location.assign(next) : navigate("/workspace");
  const [method, setMethod] = useState("password"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [challenge, setChallenge] = useState(null),
    [recover, setRecover] = useState(false),
    // Two-Step Sign-in: the first step succeeded and a code is needed.
    [twoStep, setTwoStep] = useState(null);
  async function finish() {
    await refresh();
    done();
  }
  async function walletSubmit() {
    setBusy(true);
    setError("");
    try {
      const r = await walletSign(config);
      if (r?.twoStep) return setTwoStep(r.twoStep);
      await refresh();
      done();
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
      const r = await api(
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
      if (r.twoStep) return setTwoStep(r.twoStep);
      await refresh();
      done();
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
          {twoStep
            ? "One more step."
            : recover
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
        {next && (
          <Notice>
            An app is asking to connect. Sign in to review it: nothing is
            shared until you approve.
          </Notice>
        )}
        {twoStep ? (
          <TwoStepPrompt
            challenge={twoStep}
            onDone={finish}
            onCancel={() => {
              setTwoStep(null);
              setChallenge(null);
              setError("");
            }}
          />
        ) : (
        <>
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
        </>
        )}
        {!connected && (
          <p className="auth-status">
            Account services are currently unavailable. Try again when the service reconnects.
          </p>
        )}
        <div className="auth-bottom">
          {!register && !twoStep && (
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
            <Link
              to={
                (register ? "/login" : "/register") +
                (next ? "?next=" + encodeURIComponent(next) : "")
              }
            >
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
