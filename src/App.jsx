import React, { useEffect, useState, lazy, Suspense } from "react";
import { Routes, Route, Link, useLocation } from "react-router-dom";
import { AppProvider, useApp, useStartPath } from "./context.jsx";
import { reducedMotion } from "./motion.js";
import { Logo, Icon, Button, Mark, SoonTag } from "./ui.jsx";
import { modeReleased } from "./lib.js";
import { featureEnabled } from "./release-copy.js";
import Home from "./Home.jsx";
import { Reveal, useClosingMotion } from "./ReferenceMotion.jsx";
import {
  Catalog,
  Pricing,
  Docs,
  Article,
  Developers,
  Roadmap,
  Support,
  Legal,
  Auth,
  NotFound,
} from "./Pages.jsx";
import Whitepaper from "./Whitepaper.jsx";
import { LanguageSwitch, Translation } from "./LanguageSwitch.jsx";
import Verify from "./Verify.jsx";
const Workspace = lazy(() => import("./Workspace.jsx"));
const Account = lazy(() => import("./Account.jsx"));
// Links into updates that aren't released yet lead to the roadmap, tagged "Soon".
function locked(config, to) {
  if (to.startsWith("/workspace/")) return !config?.releases ? to !== "/workspace/chat" : !modeReleased(config, to.slice(11));
  return (
    ["/developers", "/docs/api", "/account/keys", "/guides/one-api"].includes(to) &&
    !featureEnabled(config, "api")
  );
}
function Navigation() {
  const start = useStartPath();
  const { config } = useApp();
  const [open, setOpen] = useState(false),
    [drop, setDrop] = useState("");
  const location = useLocation();
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let last = window.scrollY;
    const update = () => {
      const y = window.scrollY;
      setHidden(y > 160 && y > last && !open);
      last = y;
    };
    window.addEventListener("scroll", update, { passive: true });
    return () => window.removeEventListener("scroll", update);
  }, [open]);
  useEffect(() => {
    setOpen(false);
    setDrop("");
  }, [location]);
  useEffect(() => {
    function key(e) {
      if (e.key === "Escape") {
        setOpen(false);
        setDrop("");
      }
    }
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  return (
    <header className={"header" + (hidden ? " n-header-hidden" : "")}>
      <Logo />
      <nav className={open ? "nav open" : "nav"} aria-label="Main navigation">
        <Link to="/#platform">Platform</Link>
        {[
          {
            id: "workflows",
            title: "Workflows",
            links: [
              ["/workspace/chat", "Chat & reasoning"],
              ["/workspace/code", "Code generation"],
              ["/workspace/image", "Image creation"],
              ["/workspace/video", "Video generation"],
            ],
          },
          {
            id: "models",
            title: "Models",
            links: [
              ["/models", "Explore models"],
              ["/pricing", "Credits & pricing"],
              ["/docs/billing", "Billing rules"],
              ["/developers", "Developer API"],
            ],
          },
          {
            id: "company",
            title: "Company",
            links: [
              ["/roadmap", "Roadmap"],
              ["/support", "Contact & support"],
              ["/privacy", "Privacy"],
              ["/terms", "Terms"],
            ],
          },
          {
            id: "knowledge",
            title: "Knowledge Base",
            links: [
              ["/docs", "Documentation"],
              ["/whitepaper", "Whitepaper"],
              ["/verify", "Verify a receipt"],
              ["/guides/choose-a-model", "Model guide"],
              ["/guides/understanding-credits", "Understanding credits"],
              ["/guides/one-api", "Developer guide"],
            ],
          },
        ].map((group) => (
          <div
            className="nav-drop"
            key={group.id}
            onMouseEnter={() => {
              if (window.innerWidth >= 940) setDrop(group.id);
            }}
            onMouseLeave={() => setDrop("")}
          >
            <button
              onClick={(event) =>
                setDrop(
                  window.innerWidth >= 940 && event.detail > 0
                    ? group.id
                    : drop === group.id
                      ? ""
                      : group.id,
                )
              }
              aria-expanded={drop === group.id}
            >
              {group.title} <Icon name="down" size={13} />
            </button>
            {drop === group.id && (
              <div className="dropdown">
                {group.links.map(([to, label]) =>
                  locked(config, to) ? (
                    <Link to="/roadmap" key={to}>
                      {label}
                      <SoonTag />
                    </Link>
                  ) : (
                    <Link to={to} key={to}>
                      {label}
                      <Icon name="arrow" size={14} />
                    </Link>
                  ),
                )}
              </div>
            )}
          </div>
        ))}
        <div className="mobile-actions">
          <Link to="/login">Log in</Link>
          <Link to={start()}>Explore workspace →</Link>
          <LanguageSwitch config={config} />
        </div>
      </nav>
      <div className="header-actions">
        <LanguageSwitch config={config} />
        <Link to="/login">Log in</Link>
        <Link to={start()} className="header-cta">
          Get started <Icon name="diagonal" size={15} />
        </Link>
      </div>
      <button
        className="mobile-toggle icon-button"
        onClick={() => setOpen(!open)}
        aria-label={open ? "Close navigation" : "Open navigation"}
        aria-expanded={open}
      >
        <Icon name={open ? "close" : "plus"} />
      </button>
    </header>
  );
}
function Footer() {
  const closing = useClosingMotion();
  const start = useStartPath();
  const { config } = useApp();
  return (
    <>
      <section className="closing-cta" ref={closing}>
        <Reveal>
        <h2>
          Move from switching tools
          <br />
          to bringing ideas to life.
        </h2></Reveal>
        <div className="step-blocks">
          <Button to={start()}>
            Explore workspace <Icon name="arrow" />
          </Button>
        </div>
      </section>
      <footer>
        <div className="footer-top">
          <div className="footer-brand">
            <Mark />
            <p>
              One account.
              <br />
              Many AI models.
            </p>
          </div>
          <div className="n-footer-links">
            {[
              {
                title: "AI Workflows",
                links: [
                  ["Chat & reasoning", "/workspace/chat"],
                  ["Code generation", "/workspace/code"],
                  ["Image generation", "/workspace/image"],
                  ["Video generation", "/workspace/video"],
                  ["Your library", "/workspace/library"],
                ],
              },
              {
                title: "Your Workspace",
                links: [
                  ["Explore the platform", "/#platform"],
                  ["Compare models", "/models"],
                  ["Credits & pricing", "/pricing"],
                  ["Billing rules", "/docs/billing"],
                  ["Savings calculator", "/pricing#calculator"],
                ],
              },
              {
                title: "ANONYMA",
                links: [
                  ["Our platform", "/#platform"],
                  ["Roadmap", "/roadmap"],
                  ["Privacy", "/privacy"],
                  ["Terms of use", "/terms"],
                ],
              },
              {
                title: "Developers",
                links: [
                  ["One API", "/developers"],
                  ["API documentation", "/docs/api"],
                  ["API keys", "/account/keys"],
                  ["Usage & receipts", "/account/credits"],
                ],
              },
              {
                title: "Knowledge Base",
                links: [
                  ["Documentation", "/docs"],
                  ["Whitepaper", "/whitepaper"],
                  ["Verify a receipt", "/verify"],
                  ["Model guide", "/guides/choose-a-model"],
                  ["Understanding credits", "/guides/understanding-credits"],
                  ["Developer guide", "/guides/one-api"],
                ],
              },
              {
                title: "Connect",
                links: [
                  ["Help & support", "/support"],
                  ["Your account", "/account"],
                  ["Log in", "/login"],
                  ["Create account", "/register"],
                ],
              },
            ].map((g) => (
              <div className="footer-group" key={g.title}>
                <span>{g.title}</span>
                {g.links.map(([t, h]) =>
                  locked(config, h) ? (
                    <Link to="/roadmap" key={t}>
                      {t} <SoonTag />
                    </Link>
                  ) : (
                    <Link to={h} key={t}>
                      {t}
                    </Link>
                  ),
                )}
              </div>
            ))}
          </div>
        </div>
        <div className="footer-bottom">
          <span>© {new Date().getFullYear()} ANONYMA</span>
          <Link to="/privacy">Privacy</Link>
          <Link to="/terms">Terms</Link>
          <span className="footer-note">Built for your next idea.</span>
          <LanguageSwitch config={config} className="on-light" />
        </div>
      </footer>
    </>
  );
}
function ScrollManager() {
  const { pathname, hash, key } = useLocation();
  useEffect(() => {
    let timer;
    if (hash) {
      timer = setTimeout(
        () =>
          document.getElementById(hash.slice(1))?.scrollIntoView({
            behavior: reducedMotion.matches
              ? "instant"
              : "smooth",
          }),
        100,
      );
    } else window.scrollTo(0, 0);
    document.title =
      pathname === "/"
        ? "ANONYMA — One account. Many AI models."
        : `${pathname.split("/").filter(Boolean).pop()?.replaceAll("-", " ")} — ANONYMA`;
    return () => clearTimeout(timer);
  }, [pathname, hash, key]);
  return null;
}
function Shell() {
  const location = useLocation();
  const { config } = useApp();
  const app =
    location.pathname.startsWith("/workspace") ||
    location.pathname.startsWith("/account");
  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <ScrollManager />
      <Translation config={config} />
      {!app && <Navigation />}
      <Suspense
        fallback={
          <main id="main" className="loading-page">
            Opening your workspace…
          </main>
        }
      >
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/models" element={<Catalog />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/docs/*" element={<Docs />} />
          <Route path="/whitepaper" element={<Whitepaper />} />
          <Route path="/verify" element={<Verify />} />
          <Route path="/developers" element={<Developers />} />
          <Route path="/guides/:slug" element={<Article />} />
          <Route path="/roadmap" element={<Roadmap />} />
          <Route path="/support" element={<Support />} />
          <Route path="/privacy" element={<Legal type="privacy" />} />
          <Route path="/terms" element={<Legal type="terms" />} />
          <Route path="/login" element={<Auth />} />
          <Route path="/register" element={<Auth register />} />
          <Route
            path="/workspace/:mode?"
            element={
              <Workspace
                key={new URLSearchParams(location.search).get("demo") || "live"}
              />
            }
          />
          <Route
            path="/account/:section?"
            element={
              <Account
                key={new URLSearchParams(location.search).get("demo") || "live"}
              />
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </Suspense>
      {!app && <Footer />}
    </>
  );
}
export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}
