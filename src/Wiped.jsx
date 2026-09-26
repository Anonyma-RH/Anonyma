import React from "react";
import { Link } from "react-router-dom";
import { useApp } from "./context.jsx";
import { Icon, Button } from "./ui.jsx";
import { featureEnabled } from "./release-copy.js";
import { NotFound } from "./Pages.jsx";
import { WIPE_STAYS } from "./panic-wipe.js";
import "./panic-wipe.css";

// Where Panic Wipe lands (src/PanicWipe.jsx), after a full page load with
// this browser already cleared. It reads nothing about the account: there
// is no session left to read it with.
export default function Wiped() {
  const { config, loading } = useApp();
  if (loading)
    return (
      <main id="main" className="loading-page">
        Loading…
      </main>
    );
  if (!featureEnabled(config, "wipe")) return <NotFound />;
  return (
    <main id="main" className="wiped-page">
      <div className="page-intro">
        <p className="eyebrow">PANIC WIPE</p>
        <h1>Wiped.</h1>
        <p>
          Everything your account stored is gone, and every device is signed
          out. This browser is cleared too.
        </p>
      </div>
      <div className="wiped-body">
        <h2>
          <Icon name="shield" size={18} /> Still here
        </h2>
        <ul>
          {WIPE_STAYS.map((t) => (
            <li key={t}>
              <Icon name="check" size={16} />
              {t}
            </li>
          ))}
        </ul>
        <p className="fine-print">
          A wipe can’t reach copies outside your account: exports you
          downloaded, data already sent to AI providers, and server backups.{" "}
          <Link to="/docs/privacy">Read the data-controls guide.</Link>
        </p>
        <div className="inline-actions">
          <Button to="/login">
            Sign in again <Icon name="arrow" />
          </Button>
          <Button to="/" secondary>
            Back to ANONYMA
          </Button>
        </div>
      </div>
    </main>
  );
}
