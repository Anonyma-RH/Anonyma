import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Icon } from "./ui.jsx";
import { api } from "./lib.js";
import {
  holdersReleased,
  holderProgram,
  tierPerks,
  nymaAmount,
  creditAmount,
  multiplierText,
  TIER_NAMES,
} from "./holders.js";
import { HoldingsBoost } from "./ReferralBoost.jsx";
import { referralBoost, boostPerk } from "./referral-boost.js";
import { opensLabel } from "./early-models.js";
import { HoldingsApiBoost } from "./ApiBoost.jsx";
import { apiBoostOf, apiBoostPerk } from "./api-boost.js";
import "./holders.css";

// The small tag on a feature a holder is using before its public release.
// A cobalt badge with the brand-yellow square, beside the Private tag's
// light cobalt and the Training Labels' outline.
export function EarlyTag() {
  return (
    <span
      className="early-tag"
      title="Open early for NYMA holders at the Insider tier and up, before its public release"
    >
      Early access
    </span>
  );
}


// Early Model Access in Holdings and on /token: the models open to Insiders
// first right now, and when each opens to everyone. The same list for
// everyone (the server sends it only while the feature is live).
export function EarlyModelList({ early, eligible }) {
  if (!early) return null;
  const models = (early.models || []).filter((m) => m.opensAt > Date.now());
  return (
    <div className="holdings-early-models">
      <h3>New models open to Insiders first</h3>
      <p>
        {`For their first ${early.days} ${early.days === 1 ? "day" : "days"}, newly added models are open to the Insider tier and up, then to everyone.`}
      </p>
      {eligible && <p>They're in your model pickers now, tagged Early.</p>}
      {models.length ? (
        <ul>
          {models.map((m) => (
            <li key={m.type + ":" + m.id}>
              <strong data-i18n="off">{m.name}</strong>
              <span>{`Opens to everyone ${opensLabel(m.opensAt)}`}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="holdings-hint">
          No new models in early access right now. The next ones show here.
        </p>
      )}
    </div>
  );
}

// Account → Settings → NYMA holdings, once the Holder Program is live: the
// tier, the open 30-day cycle, what it pays, the last reward, the perks and
// the Inner Circle's roadmap ballot. Only this account's own state.
export function HoldingsSettings({ config, user, demo, refresh, onNotice, onError }) {
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(null);
  const [choice, setChoice] = useState("");
  const live = holdersReleased(config);
  const wallet = !demo && user?.wallet;
  const load = useCallback(async () => {
    if (!live || demo || !user) return setState(null);
    try {
      const next = await api("/api/account/holdings");
      setState(next);
      setChoice(next.vote?.choice || next.vote?.candidates?.[0]?.id || "");
    } catch {
      setState(null);
    }
  }, [live, demo, user?.id, user?.tokenChecked, user?.wallet]);
  useEffect(() => {
    load();
  }, [load]);
  if (!live) return null;
  const program = holderProgram(config);
  const checking = !!config?.services?.token;
  const checked = user?.tokenChecked ? new Date(user.tokenChecked) : null;
  const on = !demo && user?.holder?.eligible === true;
  const cycle = state?.cycle;
  const holderMin = program?.tiers?.[0]?.min ?? 1_000_000;
  const innerMin = program?.tiers?.[2]?.min ?? 25_000_000;
  const tierIndex = (program?.tiers || []).findIndex((t) => t.id === state?.tier?.id);
  const boost = referralBoost(config);
  const perks = tierIndex >= 0 ? tierPerks(program, tierIndex) : [];
  // Referral Boost, once live, is one more perk of the account's tier.
  const boostText = tierIndex >= 0 ? boostPerk(boost, state.tier.id) : null;
  if (boostText) perks.push(boostText);
  // API Boost, once live, is one more perk of the account's tier (on its
  // own line, so it translates on its own).
  const apiPerk = tierIndex >= 0 ? apiBoostPerk(apiBoostOf(config), state.tier.id) : null;
  const caps = program?.caps?.holder;
  const balance = !wallet
    ? "No wallet linked"
    : !checking
      ? "Balance checks are off on this service"
      : checked
        ? nymaAmount(user.tokenBalance)
        : "Not checked yet";
  const daysLeft = !cycle
    ? "No cycle open"
    : cycle.daysLeft > 0
      ? `${cycle.daysLeft} ${cycle.daysLeft === 1 ? "day" : "days"} left`
      : cycle.waiting
        ? "Due, waiting for a balance check"
        : "Due now";
  const vote = state?.vote;
  const bonus = state?.loyalty;
  return (
    <section className="holdings">
      <div>
        <h2>NYMA holdings.</h2>
        <p>
          Linking a wallet is optional. ANONYMA only reads its NYMA balance.
        </p>
        <p>
          No staking, no locking, no deposits. Your NYMA stays in your own
          wallet.
        </p>
        <Link to="/token" className="holdings-more">
          What NYMA does <Icon name="arrow" size={13} />
        </Link>
      </div>
      <div>
        <div className="identity-rows holdings-rows">
          <div>
            <span>NYMA balance</span>
            <b>{balance}</b>
          </div>
          <div>
            <span>Tier</span>
            <b className={state?.tier ? "holdings-state on" : "holdings-state"}>
              {state?.tier ? TIER_NAMES[state.tier.id] : "None yet"}
            </b>
          </div>
          <div>
            <span>Lowest this cycle</span>
            <b>{cycle ? nymaAmount(cycle.low) : "No cycle open"}</b>
          </div>
          <div>
            <span>Cycle</span>
            <b>{daysLeft}</b>
          </div>
          <div>
            <span>At cycle end</span>
            <b>
              {!cycle
                ? `A cycle opens at ${nymaAmount(holderMin)} or more`
                : cycle.due.credits > 0
                  ? creditAmount(cycle.due.credits)
                  : "No credits for this tier"}
              {cycle?.due.bonus && bonus && (
                <em className="holdings-bonus">
                  {`Loyal bonus ${multiplierText(bonus.multiplier)}`}
                </em>
              )}
            </b>
          </div>
          <div>
            <span>Paid in a row</span>
            <b>
              {`${state?.paidInARow ?? 0} ${state?.paidInARow === 1 ? "cycle" : "cycles"}`}
              {bonus && !cycle?.due.bonus && (
                <em className="holdings-hint">
                  {`Loyal bonus after ${bonus.after}`}
                </em>
              )}
            </b>
          </div>
          <div>
            <span>Last reward</span>
            <b>
              {state?.lastReward ? (
                <>
                  {creditAmount(state.lastReward.credits)}
                  <em className="holdings-hint">
                    {new Date(state.lastReward.paid).toLocaleDateString()}
                  </em>
                </>
              ) : (
                "None yet"
              )}
            </b>
          </div>
          <div>
            <span>Perks</span>
            <b>
              {perks.length ? perks.join(", ") : "None yet"}
              {apiPerk && <em className="holdings-perk">{apiPerk}</em>}
            </b>
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
                  await load();
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
        {caps && (
          <p className="holdings-note">
            {`Bigger library, from the Holder tier: ${caps.conversations} saved conversations, ${caps.symposium} Symposium runs, ${caps.image} images, ${caps.video} videos and ${caps.audio} audio files.`}{" "}
            {`If your balance drops below ${nymaAmount(holderMin)}, nothing is deleted at once. The normal caps simply apply again, so the oldest items beyond them are removed as new ones are saved.`}
          </p>
        )}
        <HoldingsBoost config={config} tierId={state?.tier?.id} />
        <HoldingsApiBoost config={config} tierId={state?.tier?.id} />
        <EarlyModelList early={state?.earlyModels} eligible={on} />
        {vote && (
          <div className="holdings-vote">
            <h3>Roadmap vote</h3>
            <p>Inner Circle votes help decide what ships next.</p>
            {!vote.open ? (
              <p className="holdings-hint">
                {`Open to Inner Circle accounts, from ${nymaAmount(innerMin)}.`}
              </p>
            ) : !vote.candidates.length ? (
              <p className="holdings-hint">
                Nothing to vote on this month: every update is out or in early
                access.
              </p>
            ) : (
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  onError("");
                  try {
                    const next = await api("/api/holders/vote", {
                      method: "PUT",
                      body: { update: choice },
                    });
                    setState((s) => ({ ...s, vote: next }));
                    onNotice("Vote saved. You can change it until the month ends.");
                  } catch (err) {
                    onError(err.message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                <select
                  aria-label="Update to vote for"
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                >
                  {vote.candidates.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </select>
                <button className="small-button" disabled={busy || !choice}>
                  {vote.choice ? "Change vote" : "Vote"}
                </button>
                <p className="holdings-hint">
                  {vote.choice
                    ? `Your vote this month: ${vote.candidates.find((c) => c.id === vote.choice)?.title}`
                    : "One vote a month, changeable until the month ends."}
                </p>
              </form>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

// The Wallet row's Unlink button, once the Holder Program is live.
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
