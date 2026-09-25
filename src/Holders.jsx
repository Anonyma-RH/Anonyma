import React, { useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./ui.jsx";
import { api } from "./lib.js";
import { holdersReleased, earlyAccessThreshold } from "./holders.js";
import "./holders.css";

// The small tag on a feature a holder is using before its public release.
// A cobalt badge with the brand-yellow square, beside the Private tag's
// light cobalt and the Training Labels' outline.
export function EarlyTag() {
  return (
    <span
      className="early-tag"
      title="Open early for NYMA holders, before its public release"
    >
      Early access
    </span>
  );
}

const nyma = (n) =>
  `${Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 })} NYMA`;

// Account → Settings → NYMA holdings, once Holder Early Access is live.
export function HoldingsSettings({ config, user, demo, refresh, onNotice, onError }) {
  const [busy, setBusy] = useState(false);
  if (!holdersReleased(config)) return null;
  const wallet = !demo && user?.wallet;
  const checking = !!config?.services?.token;
  const checked = user?.tokenChecked ? new Date(user.tokenChecked) : null;
  const on = !demo && user?.holder?.eligible === true;
  const balance = !wallet
    ? "No wallet linked"
    : !checking
      ? "Balance checks are off on this service"
      : checked
        ? nyma(user.tokenBalance)
        : "Not checked yet";
  return (
    <section className="holdings">
      <div>
        <h2>NYMA holdings.</h2>
        <p>
          Linking a wallet is optional. ANONYMA only reads its NYMA balance.
        </p>
        <Link to="/token" className="holdings-more">
          What NYMA does <Icon name="arrow" size={13} />
        </Link>
      </div>
      <div className="identity-rows holdings-rows">
        <div>
          <span>NYMA balance</span>
          <b>{balance}</b>
        </div>
        <div>
          <span>Threshold</span>
          <b>{nyma(earlyAccessThreshold(config, user))}</b>
        </div>
        <div>
          <span>Early access</span>
          <b className={on ? "holdings-state on" : "holdings-state"}>
            {on ? "On" : "Off"}
          </b>
        </div>
        <div>
          <span>Last checked</span>
          <b>{checked ? checked.toLocaleString() : "Not yet"}</b>
          <button
            className="small-button"
            disabled={!wallet || !checking || busy}
            onClick={async () => {
              setBusy(true);
              onError("");
              try {
                await api("/api/account/token/refresh", { method: "POST", body: {} });
                await refresh();
                onNotice("NYMA balance checked.");
              } catch (e) {
                onError(e.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Icon name="refresh" size={14} /> Refresh
          </button>
        </div>
      </div>
    </section>
  );
}

// The Wallet row's Unlink button, once Holder Early Access is live.
export function UnlinkWallet({ config, user, demo, refresh, onNotice, onError }) {
  const [busy, setBusy] = useState(false);
  if (!holdersReleased(config) || demo || !user?.wallet) return null;
  return (
    <button
      className="small-button"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        onError("");
        try {
          await api("/api/account/wallet/unlink", { method: "POST", body: {} });
          await refresh();
          onNotice("Wallet unlinked.");
        } catch (e) {
          onError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      Unlink
    </button>
  );
}
