import React, { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useApp } from "./context.jsx";
import { Icon, Modal } from "./ui.jsx";
import { PageIntro, NotFound } from "./Pages.jsx";
import {
  arenaReleased,
  barScale,
  loadArenaChoice,
  saveArenaChoice,
  useArena,
  winPercent,
} from "./arena.js";
import "./arena.css";

// Blind Arena (update "arena"; src/arena.js, server/arena.js): the public
// /arena leaderboard, the question asked once after a Blind vote, and the
// Account setting. Every number on the board is an aggregate from GET
// /api/arena; nothing on it is about an account.

const time = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const count = (n) => Number(n || 0).toLocaleString("en-US");

// One ranked model: its score, the 95% range drawn on a shared scale, its
// votes and its win rate.
function Row({ m, at }) {
  const [lo, hi] = m.ci || [m.score, m.score];
  return (
    <li className="arena-row">
      <span className="arena-rank">{m.rank}</span>
      <span className="arena-name" data-i18n="off">
        {m.name}
      </span>
      <span className="arena-score">
        <small>Score</small>
        {m.score}
      </span>
      <span className="arena-range">
        <small>95% range</small>
        <span className="arena-bar" aria-hidden="true">
          <span className="arena-bar-span" style={{ left: `${at(lo)}%`, width: `${Math.max(0.6, at(hi) - at(lo))}%` }} />
          <span className="arena-bar-dot" style={{ left: `${at(m.score)}%` }} />
        </span>
        <span className="arena-range-text">{`${lo}–${hi}`}</span>
      </span>
      <span className="arena-votes">
        <small>Votes</small>
        {count(m.votes)}
      </span>
      <span className="arena-win">
        <small>Win rate</small>
        {winPercent(m.win_rate)}
      </span>
    </li>
  );
}

// The page's body for one board (GET /api/arena): the summary, the ranked
// table or the honest empty state, and how it's measured.
export function ArenaBoard({ board, failed = false, testMode = false }) {
  const models = board?.models || [];
  const min = board?.minVotes ?? 20;
  const at = barScale(models);
  return (
    <div className="arena-body">
      {testMode && (
        <p className="arena-test">
          Local test installation: this board comes from its test votes, not from real people.
        </p>
      )}
      <div className="arena-summary" aria-live="polite">
        {board ? (
          <>
            <span className="arena-count">
              {board.votes === 1 ? "1 blind vote" : `${count(board.votes)} blind votes`}
            </span>
            <span className="arena-count">
              {models.length === 1 ? "1 model ranked" : `${models.length} models ranked`}
            </span>
            <span className="arena-checked">{`Updated at ${time(board.computedAt)} · once an hour`}</span>
          </>
        ) : failed ? (
          <span className="arena-checked">The Arena couldn't be loaded. Try again in a moment.</span>
        ) : (
          <span className="arena-checked">Loading the Arena…</span>
        )}
      </div>
      {board && (
        <section className="arena-board" aria-label="Ranked models">
          <div className="arena-row arena-head" aria-hidden="true">
            <span>#</span>
            <span>Model</span>
            <span>Score</span>
            <span>95% range</span>
            <span>Votes</span>
            <span>Win rate</span>
          </div>
          {models.length ? (
            <ol className="arena-list">
              {models.map((m) => (
                <Row m={m} at={at} key={m.id} />
              ))}
            </ol>
          ) : (
            <div className="arena-empty">
              <Icon name="podium" size={22} />
              <div>
                <b>Not enough votes yet.</b>
                <p>
                  {`A model is listed once at least ${min} blind votes involve it, so no one person's votes can be picked out. We don't add votes of our own to fill the board.`}
                </p>
              </div>
            </div>
          )}
          {board.waiting > 0 && (
            <p className="arena-waiting">
              {board.waiting === 1
                ? `1 more model has votes but fewer than ${min}, so it isn't listed yet.`
                : `${board.waiting} more models have votes but fewer than ${min}, so they aren't listed yet.`}
            </p>
          )}
        </section>
      )}
      <section className="arena-method" aria-labelledby="arena-method-title">
        <h2 id="arena-method-title">How it's measured</h2>
        <ul>
          <li>
            <b>Blind votes only.</b> In Blind Compare two models answer the same message with their names hidden, and
            the person picks the better reply, a tie or both bad. Only accounts that opt in add their votes, and only
            from saved chat and code rounds: off-the-record, Private, Device Vault and Uncensored rounds never count.
          </li>
          <li>
            <b>Score.</b> A Bradley–Terry model fitted to every vote, on an Elo-like scale: the average model scores
            1000, and 400 points means 10-to-1 odds of winning. A tie is half a win for each model, and so is both bad,
            since neither reply was better. Each model also starts with one tie against an average model, so a short
            perfect record can't run off the scale.
          </li>
          <li>
            <b>95% range.</b> The scores refitted on 200 resamples of the votes. When two models' ranges overlap, the
            votes don't yet say which is better. Win rate is wins plus half the ties, over votes.
          </li>
          <li>
            <b>Never who.</b>{" "}
            {`The Arena keeps only counts: the two models, the vote and the day, with no account. A model appears once at least ${min} votes involve it, and the board is recomputed once an hour.`}
          </li>
        </ul>
        <p className="arena-join">
          <Icon name="scale" size={16} />
          <span>
            To take part, turn on Blind in a chat, vote, and say yes when asked. You can switch it off any time in
            Account settings.
          </span>
          <Link to="/workspace/chat">Compare two models</Link>
        </p>
      </section>
    </div>
  );
}

export default function ArenaPage() {
  const { config, loading } = useApp();
  const live = arenaReleased(config);
  const { board, failed } = useArena(live);
  if (!config && loading) return <main id="main" className="loading-page" />;
  if (!live) return <NotFound />;
  return (
    <main id="main" className="arena-page">
      <PageIntro
        eyebrow="BLIND ARENA"
        title={
          <>
            Which model wins when
            <br />
            nobody knows the names?
          </>
        }
      >
        Models ranked from blind votes in Blind Compare. Aggregates only: never who voted, and never what they asked.
      </PageIntro>
      <ArenaBoard board={board} failed={failed} testMode={config?.testMode === true} />
    </main>
  );
}

// Asked once, after the first Blind vote once the Arena is live, as a dialog
// so it's in view on any screen. Yes adds this vote (when it can count) and
// later ones; closing it without an answer leaves it at no.
export function ArenaAsk({ busy = false, onAnswer, onClose }) {
  return (
    <Modal title="Add your blind votes to the public Arena?" onClose={onClose}>
      <div className="arena-ask">
        <div className="arena-ask-lead">
          <span className="arena-ask-icon" aria-hidden="true">
            <Icon name="podium" size={18} />
          </span>
          <p>The Blind Arena ranks models from blind votes. Yes adds this vote and your next ones.</p>
        </div>
        <ul className="arena-ask-points">
          <li>Only the two models, your vote and the day, with no account attached.</li>
          <li>Off-the-record, Private, Device Vault and Uncensored rounds are never added.</li>
          <li>Change it any time in Account settings.</li>
        </ul>
        <div className="arena-ask-actions">
          <button type="button" className="small-button primary" disabled={busy} onClick={() => onAnswer(true)}>
            Yes, add my votes
          </button>
          <button type="button" className="small-button" disabled={busy} onClick={() => onAnswer(false)}>
            No thanks
          </button>
        </div>
      </div>
    </Modal>
  );
}

// Account → Settings: switch contributing on or off.
export function ArenaSettings({ config, user }) {
  const live = arenaReleased(config) && !!user;
  const [choice, setChoice] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [saved, setSaved] = useState("");
  useEffect(() => {
    if (!live) return;
    loadArenaChoice()
      .then(setChoice)
      .catch((e) => setError(e.message));
  }, [live]);
  if (!live) return null;
  async function change(on) {
    setBusy(true);
    setError("");
    setSaved("");
    try {
      setChoice(await saveArenaChoice(on));
      setSaved(on ? "Your next Blind votes will be added to the Arena." : "Stopped. Your next Blind votes stay yours.");
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section id="blind-arena" className="arena-settings">
      <div>
        <h2>Blind Arena.</h2>
        <p>Add your Blind Compare votes to the public leaderboard. Off unless you switch it on.</p>
      </div>
      <div className="arena-settings-options">
        <label className="arena-settings-row">
          <input
            type="checkbox"
            role="switch"
            checked={choice?.contribute === true}
            disabled={busy || !choice}
            onChange={(e) => change(e.target.checked)}
          />
          <span>
            <b>Add my Blind votes to the Arena</b>
            <small>
              Only the two models, your vote and the day, with no account attached. Off-the-record, Private, Device
              Vault and Uncensored rounds never are.
            </small>
          </span>
        </label>
        <p className="arena-settings-note">
          Switching it off stops future votes. Votes already added stay in the Arena: nothing there says they were
          yours, so they can't be picked out to remove. <Link to="/arena">See the Arena</Link>
        </p>
        {saved && (
          <p className="arena-settings-saved" role="status">
            {saved}
          </p>
        )}
        {error && <p className="arena-settings-error">{error}</p>}
      </div>
    </section>
  );
}
