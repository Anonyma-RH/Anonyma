import React, { useEffect, useState, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  ArrowUpRight,
  Menu,
  X,
  ChevronDown,
  Copy,
  Check,
  LoaderCircle,
  AlertCircle,
  Plus,
  Wallet,
  LogOut,
  Coins,
} from "lucide-react";
import { useApp } from "./context";
export { Context, useApp } from "./context";
export async function api(path, options = {}) {
  const r = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
    ...(options.body !== undefined
      ? { body: JSON.stringify(options.body) }
      : {}),
  });
  let j;
  try {
    j = await r.json();
  } catch {
    throw Error("The service returned an unreadable response.");
  }
  if (!r.ok) {
    const error = new Error(j.error?.message || "Request failed.");
    error.status = r.status;
    error.code = j.error?.code;
    error.receipt = j.anonyma;
    error.retryAfter = r.headers.get("Retry-After");
    throw error;
  }
  return j;
}
export const fmt = (n, d = 2) =>
  Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d });
export const dollars = (n) =>
  "$" +
  Number(n || 0).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
export const date = (n) => new Date(n).toLocaleString();
export const modelPrice = (m) =>
  m?.pricing?.input_per_1M_tokens ??
  m?.pricing?.base_price ??
  m?.pricing?.per_generation ??
  m?.pricing?.variants?.[0]?.options?.[0]?.price ??
  0;
export const generationPrice = (m, quality, size) => {
  const v =
    m?.pricing?.variants?.find((v) => v.quality === quality) ||
    m?.pricing?.variants?.[0];
  return (
    v?.options?.find((o) => o.size === size)?.price ??
    v?.options?.find((o) => o.size === "default")?.price ??
    modelPrice(m)
  );
};
export function ProviderIcon({ provider = "", size = 28 }) {
  const artwork = {
    OpenAI: "openai",
    Anthropic: "anthropic",
    Google: "google",
    "Google Gemini": "google",
    DeepSeek: "deepseek",
    xAI: "xai",
    "Kling AI": "klingai",
    Runway: "runway",
    Higgsfield: "higgsfield",
    NVIDIA: "nvidia",
    ElevenLabs: "elevenlabs",
    FLUX: "flux",
    Perplexity: "perplexity",
    Freepik: "freepik",
    ByteDance: "bytedance",
    MiniMax: "minimax",
  };
  const providerSlug = provider.toLowerCase().replace(/[^a-z0-9]/g, "");
  const artworkKey =
    artwork[provider] ||
    Object.entries(artwork).find(([name]) => name.toLowerCase().replace(/[^a-z0-9]/g, "") === providerSlug)?.[1] ||
    {
      openai: "openai",
      anthropic: "anthropic",
      google: "google",
      googlegemini: "google",
      xai: "xai",
      deepseek: "deepseek",
      runway: "runway",
      kling: "klingai",
      klingai: "klingai",
      nvidia: "nvidia",
      elevenlabs: "elevenlabs",
      perplexity: "perplexity",
      flux: "flux",
    }[providerSlug];
  if (artworkKey)
    return (
      <img
        className="provider-icon provider-artwork"
        src={`/assets/providers/${artworkKey}.${artworkKey === "minimax" ? "png" : "svg"}`}
        alt={provider}
        width={size}
        height={size}
      />
    );
  const labels = {
    OpenAI: "✺",
    Anthropic: "✳",
    Google: "✦",
    DeepSeek: "◒",
    Meta: "∞",
    xAI: "𝕏",
    "Kling AI": "◈",
    Qwen: "✻",
    Mistral: "▦",
  };
  return (
    <span
      className={"provider-icon p-" + provider.toLowerCase().replace(/\W/g, "")}
      style={{ width: size, height: size, fontSize: size * 0.8 }}
    >
      {labels[provider] || provider.slice(0, 1) || "✧"}
    </span>
  );
}
export function Button({
  children,
  busy,
  variant = "",
  className = "",
  ...props
}) {
  return (
    <button
      className={`button ${variant} ${className}`}
      disabled={busy || props.disabled}
      {...props}
    >
      {busy ? <LoaderCircle size={16} className="spin" /> : null}
      {children}
    </button>
  );
}
export function ErrorBox({ error }) {
  return error ? (
    <div className="error" role="alert">
      <AlertCircle size={17} />
      <span>{error}</span>
    </div>
  ) : null;
}
export function CopyButton({ text, label = "Copy", className = "" }) {
  const [copied, set] = useState(false);
  return (
    <button
      className={"copy-button " + className}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          set(true);
          setTimeout(() => set(false), 1800);
        } catch {
          set(false);
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}{" "}
      {copied ? "Copied" : label}
    </button>
  );
}
export function Modal({ title, onClose, children, wide = false }) {
  const ref = useRef(null),
    closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement,
      overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const controls = () =>
      [
        ...ref.current.querySelectorAll(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
        ),
      ].filter((e) => e.offsetParent !== null);
    controls()[0]?.focus();
    const handler = (e) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const items = controls();
        if (!items.length) {
          e.preventDefault();
          return;
        }
        if (e.shiftKey && document.activeElement === items[0]) {
          e.preventDefault();
          items.at(-1).focus();
        } else if (!e.shiftKey && document.activeElement === items.at(-1)) {
          e.preventDefault();
          items[0].focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      document.body.style.overflow = overflow;
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-shade"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <section
        ref={ref}
        className={"modal " + (wide ? "wide" : "")}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-title">
          <h2>{title}</h2>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
          >
            <X />
          </button>
        </div>
        {children}
      </section>
    </div>
  );
}
export function Header() {
  const { user, config } = useApp(),
    [open, setOpen] = useState(false),
    loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <>
      <header className={`header${loc.pathname === "/" ? " header-home" : ""}`}>
        <Link to="/" className="wordmark">
          anonyma<span className="brand-dot">•</span>
        </Link>
        <nav className="desktop-nav">
          <Link to="/how-it-works">How it works</Link>
          <Link to="/models">Models</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/calculator">Calculator</Link>
          <details className="developer-menu">
            <summary>
              Developers <ChevronDown size={12} />
            </summary>
            <div>
              <Link to="/developers">API & CLI</Link>
              <Link to="/docs">Documentation</Link>
              <Link to="/docs/api">API reference</Link>
              <Link to="/docs/cli">Command line</Link>
              <Link to="/roadmap">Roadmap</Link>
            </div>
          </details>
        </nav>
        <div className="header-actions">
          <Link to="/token" className="token-badge">
            <span className="tiny-dot" /> $ANON
          </Link>
          <Link to="/ask" className="button small">
            Ask <ArrowUpRight size={15} />
          </Link>
          <Link
            to={user ? "/account" : "/signin"}
            className="button small outline account-link"
          >
            Account
          </Link>
          <button
            aria-label="Open navigation"
            className="icon-button mobile-menu"
            onClick={() => setOpen(!open)}
          >
            {open ? <X /> : <Menu />}
          </button>
        </div>
      </header>
      {open && (
        <nav className="mobile-nav">
          {[
            "How it works",
            "Models",
            "Pricing",
            "Calculator",
            "Docs",
            "Roadmap",
            "Account",
          ].map((v) => (
            <Link key={v} to={"/" + v.toLowerCase().replaceAll(" ", "-")}>
              {v}
            </Link>
          ))}
        </nav>
      )}
      {config?.testMode && (
        <div className="test-banner">
          LOCAL TEST MODE · Test credits and deterministic output · No real
          payments or AI calls
        </div>
      )}
    </>
  );
}
export function Footer() {
  const { config } = useApp();
  const groups = [
    [
      "Product",
      [
        ["How it works", "/how-it-works"],
        ["Models", "/models"],
        ["Pricing", "/pricing"],
        ["Calculator", "/calculator"],
        ["API and CLI", "/developers"],
        ["Token", "/token"],
        ["Roadmap", "/roadmap"],
        ["Docs", "/docs"],
      ],
    ],
    [
      "Research",
      [
        ["Compare", "/compare"],
        ["Alternatives", "/alternatives"],
        ["Learn", "/learn"],
        ["Methodology", "/methodology"],
      ],
    ],
    [
      "Company",
      [
        ["About", "/about"],
        ["Support", "/support"],
        ["Contact", "/contact"],
        ["Privacy", "/privacy"],
        ["Terms", "/terms"],
        ["Cookies", "/cookies"],
      ],
    ],
  ];
  return (
    <footer className="site-footer">
      <div className="footer-cta">
        <h2>
          Every <em>AI</em> model.
          <br />
          No <em>subscriptions</em>.<br />
          Pay for what you use, with <em>crypto</em>.
        </h2>
        <Link className="button" to="/ask">
          Start asking
        </Link>
      </div>
      <div className="footer-grid">
        <Link className="wordmark" to="/" aria-label="Anonyma home">
          anonyma<span className="brand-dot">•</span>
        </Link>
        <nav className="footer-links" aria-label="Footer navigation">
          {groups.map(([title, links]) => (
            <div key={title}>
              <strong>{title}</strong>
              {links.map(([label, to]) => (
                <Link key={to} to={to}>
                  {label}
                </Link>
              ))}
            </div>
          ))}
        </nav>
        <div className="footer-contact">
          <Link to="/token">Explore token benefits</Link>
          {config?.supportEmail && (
            <a href={`mailto:${config.supportEmail}`}>{config.supportEmail}</a>
          )}
          {config?.telegram && (
            <a href={config.telegram} target="_blank" rel="noreferrer">
              Telegram
            </a>
          )}
          <span>© {new Date().getFullYear()} Anonyma</span>
        </div>
      </div>
    </footer>
  );
}
export function PageTitle({ eyebrow, title, accent, description }) {
  return (
    <div className="page-title">
      {eyebrow && <div className="eyebrow">{eyebrow}</div>}
      <h1>
        {title} <span>{accent}</span>
      </h1>
      {description && <p>{description}</p>}
    </div>
  );
}
export function Empty({ title, children }) {
  return (
    <div className="empty">
      <div className="empty-symbol">✧</div>
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}