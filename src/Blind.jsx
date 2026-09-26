import React, { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon, Modal } from "./ui.jsx";
import { api, isReleased } from "./lib.js";
import { veilRemarkPlugin } from "./Veil.jsx";
import { PrivacyTrail } from "./PrivacyTrail.jsx";
import { createEstimator, formatCredits } from "./estimate.js";
import { SIDES, canVote, formatSpeed, percent } from "./blind.js";
import "./blind.css";

// Blind Compare (src/blind.js, server/routes/blind.js): two models answer the
// same message, labelled A and B in a random order the server picks, with
// names and per-reply costs hidden until the person votes.

export const blindReleased = (config) => isReleased(config, "blind");

// The composer switch, styled like Web and Private.
export function BlindToggle({ active, onToggle, disabled, reason }) {
  return (
    <button
      type="button"
      className={"attachment-control web-toggle blind-toggle" + (active ? " on" : "")}
      aria-pressed={active}
      disabled={disabled}
      title={
        disabled && reason
          ? reason
          : "Blind: two models answer, names hidden until you vote"
      }
      onClick={onToggle}
    >
      <Icon name="scale" size={17} />
      <span>Blind</span>
    </button>
  );
}

// Above the composer while Blind is on: the two models (or a surprise pair)
// and the rankings. While the last comparison waits for its vote it shrinks
// to one line, so the replies and the vote keep the room.
export function BlindBar({
  pool,
  pair,
  surprise,
  current,
  busy,
  waiting = false,
  onPick,
  onSurprise,
  onChoose,
  onRankings,
  notes = [],
}) {
  const option = (m) => (
    <option value={m.id} key={m.id}>
      {m.name}
    </option>
  );
  const select = (i) => (
    <select
      aria-label={i === 0 ? "First model" : "Second model"}
      data-i18n="off"
      value={pair[i] || ""}
      disabled={busy}
      onChange={(e) => {
        const next = [...pair];
        next[i] = e.target.value;
        onPick(next);
      }}
    >
      {pool.map(option)}
    </select>
  );
  const title = (
    <span className="blind-bar-title">
      <Icon name="scale" size={15} />
      Blind compare
    </span>
  );
  if (waiting)
    return (
      <div className="blind-bar waiting" role="status">
        <div className="blind-bar-head">
          {title}
          <span className="blind-bar-text">Vote on the replies above to continue.</span>
        </div>
      </div>
    );
  return (
    <div className="blind-bar">
      <div className="blind-bar-head">
        {title}
        <span className="blind-bar-text">
          Names and costs stay hidden until you vote. Web search and Memory are off.
        </span>
      </div>
      {pool.length < 2 ? (
        <p className="blind-bar-note">Blind needs two models you can use here.</p>
      ) : surprise ? (
        <div className="blind-bar-row">
          <span className="blind-surprise">
            <Icon name="shuffle" size={14} />
            {current ? (
              <span>
                Two surprise models, priced like <b data-i18n="off">{current.name}</b>
              </span>
            ) : (
              <span>Two surprise models</span>
            )}
          </span>
          <button type="button" className="small-button" disabled={busy} onClick={onSurprise}>
            Pick again
          </button>
          <button type="button" className="small-button" disabled={busy} onClick={onChoose}>
            Choose models
          </button>
          <button type="button" className="small-button blind-rankings-button" onClick={onRankings}>
            <Icon name="trophy" size={14} />
            Your rankings
          </button>
        </div>
      ) : (
        <div className="blind-bar-row">
          {select(0)}
          <span className="blind-vs" aria-hidden="true">
            vs
          </span>
          {select(1)}
          <button type="button" className="small-button" disabled={busy} onClick={onSurprise}>
            <Icon name="shuffle" size={14} />
            Surprise me
          </button>
          <button type="button" className="small-button blind-rankings-button" onClick={onRankings}>
            <Icon name="trophy" size={14} />
            Your rankings
          </button>
        </div>
      )}
      {pair[0] && pair[0] === pair[1] && (
        <p className="blind-bar-note warn">Choose two different models.</p>
      )}
      {notes.map((n) => (
        <p className="blind-bar-note" key={n}>
          {n}
        </p>
      ))}
    </div>
  );
}

// The combined estimate beside Send: the same request quoted on both models
// and added up. Quoting never reserves or charges anything.
export function useBlindEstimate(body) {
  const [state, setState] = useState({ status: "idle" });
  const estimator = useRef(null);
  if (!estimator.current)
    estimator.current = createEstimator({
      quote: async ({ models, ...rest }, signal) => {
        const quotes = await Promise.all(
          models.map((model) =>
            api("/api/quote", { method: "POST", body: { ...rest, model }, signal }),
          ),
        );
        const credits = quotes.reduce((sum, q) => sum + Number(q.credits || 0), 0);
        return {
          credits: Number(credits.toFixed(4)),
          available: quotes[0]?.available,
          spending_limit: quotes[0]?.spending_limit,
          model: null,
        };
      },
      onChange: setState,
    });
  useEffect(() => {
    estimator.current.update(body);
  }, [body]);
  useEffect(() => () => estimator.current.dispose(), []);
  return state;
}
export function BlindEstimate({ state }) {
  if (!state || state.status === "idle") return null;
  const ready = state.status === "ready";
  const short = ready && state.available != null && state.credits > state.available;
  const limited = ready && !short && state.room != null && state.credits > state.room;
  const tone = ready ? (short || limited ? "short" : "ready") : state.status;
  return (
    <span
      className={"credit-estimate blind-estimate " + tone}
      role="status"
      aria-busy={state.status === "loading"}
      title={
        state.status === "unavailable"
          ? state.message
          : "An estimate, not a final charge: this message and each reply budget at both models' published rates, added together. Each reply is charged for what it uses."
      }
    >
      {ready ? (
        <>
          <Icon name="coins" size={13} />
          {`Both replies ≈${formatCredits(state.credits)} credits`}
          {short && <b> · over your balance</b>}
          {limited && <b> · over your spending limit</b>}
        </>
      ) : state.status === "loading" ? (
        "Updating estimate…"
      ) : (
        "Estimate unavailable"
      )}
    </span>
  );
}

// Copy one reply: a small icon button in its header.
function CopyReply({ text, side }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="blind-copy"
      aria-label={side === "a" ? "Copy reply A" : "Copy reply B"}
      title={done ? "Copied" : "Copy"}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {}
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} />
    </button>
  );
}

const STATUS = {
  streaming: "Answering…",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

// One compared turn: A and B side by side (stacked on a phone), the vote,
// and after it the reveal with names, costs and speeds. `Markdown` renders
// each reply (the workspace passes its reply renderer, so Math & Diagrams
// apply) with `markdown` components (Injection Shield's image and link
// guards when it's on).
export function BlindTurn({
  blind,
  last,
  busy,
  voting,
  veilMap,
  trailLive,
  receiptsLive,
  models,
  onVote,
  onContinue,
  onKeepComparing,
  Markdown = ReactMarkdown,
  markdown,
}) {
  const reveal = blind.reveal || null;
  const outcome = reveal?.outcome || null;
  const votable = canVote(blind);
  const name = (side) => reveal?.[side]?.name || reveal?.[side]?.model || "";
  const marks = [remarkGfm, [veilRemarkPlugin, { map: veilMap || {} }]];
  const result = !reveal
    ? null
    : outcome === "a" || outcome === "b"
      ? { key: "pick", side: outcome }
      : outcome === "tie"
        ? { key: "tie" }
        : outcome === "bad"
          ? { key: "bad" }
          : { key: "uncounted" };
  return (
    <div className={"blind-turn" + (reveal ? " revealed" : "")}>
      <div className="blind-columns">
        {SIDES.map((side) => {
          const x = blind[side] || {};
          const picked = outcome === side;
          const status = blind.pending && !x.status ? "streaming" : x.status;
          return (
            <section
              key={side}
              className={"blind-reply" + (picked ? " picked" : "") + (status === "failed" ? " failed" : "")}
              aria-label={"Reply " + side.toUpperCase()}
            >
              <header>
                <span className="blind-letter" aria-hidden="true">
                  {side.toUpperCase()}
                </span>
                {reveal ? (
                  <b className="blind-name" data-i18n="off">
                    {name(side)}
                  </b>
                ) : (
                  <b className="blind-name">{side === "a" ? "Reply A" : "Reply B"}</b>
                )}
                {picked && <span className="blind-pick">Your pick</span>}
                {status && status !== "done" && (
                  <span className={"blind-status " + status}>{STATUS[status] || status}</span>
                )}
                {x.text && !blind.pending && <CopyReply text={x.text} side={side} />}
              </header>
              <div className="markdown" data-i18n="off">
                {x.text ? (
                  <Markdown remarkPlugins={marks} components={markdown}>
                    {x.text}
                  </Markdown>
                ) : status === "streaming" ? (
                  <p className="blind-waiting">…</p>
                ) : null}
              </div>
              {x.error && <p className="blind-error">{x.error}</p>}
              {x.reasoning && (
                <details>
                  <summary>Reasoning</summary>
                  <p data-i18n="off">{x.reasoning}</p>
                </details>
              )}
              {reveal && (
                <div className="blind-facts">
                  <span>{`${formatCredits(reveal[side]?.credits ?? 0)} credits`}</span>
                  {reveal[side]?.ms != null && <span>{`Took ${formatSpeed(reveal[side].ms)}`}</span>}
                  {trailLive && reveal[side]?.privacy && (
                    <PrivacyTrail
                      privacy={reveal[side].privacy}
                      models={models}
                      receiptsLive={receiptsLive}
                    />
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      {blind.pending && (
        <p className="blind-foot" role="status">
          Both models are answering. Names stay hidden until you vote.
        </p>
      )}
      {votable && (
        <div className="blind-vote" role="group" aria-label="Which reply is better?">
          <span className="blind-vote-q">Which is better?</span>
          <button type="button" disabled={voting} onClick={() => onVote("a")}>
            A is better
          </button>
          <button type="button" disabled={voting} onClick={() => onVote("b")}>
            B is better
          </button>
          <button type="button" disabled={voting} onClick={() => onVote("tie")}>
            Tie
          </button>
          <button type="button" disabled={voting} onClick={() => onVote("bad")}>
            Both bad
          </button>
          {blind.credits != null && (
            <span className="blind-vote-cost">{`${formatCredits(blind.credits)} credits for both`}</span>
          )}
        </div>
      )}
      {!votable && !reveal && !blind.pending && (
        <p className="blind-foot">
          {blind.closed
            ? "Voting on this comparison has closed."
            : "Stopped before both replies finished, so there's nothing to vote on."}
        </p>
      )}
      {result && (
        <div className="blind-result">
          <p>
            {result.key === "pick" ? (
              <>
                {`You picked ${result.side.toUpperCase()}:`}
                <b className="blind-picked" data-i18n="off">
                  {name(result.side)}
                </b>
              </>
            ) : result.key === "tie" ? (
              "You called it a tie."
            ) : result.key === "bad" ? (
              "You marked both replies as bad."
            ) : (
              "A reply failed, so this comparison isn't counted in your rankings."
            )}
          </p>
          {last && !busy && (
            <div className="blind-next">
              {(result.key === "pick" ? [result.side] : result.key === "tie" ? SIDES : []).map(
                (side) =>
                  reveal[side]?.model && (
                    <button
                      type="button"
                      key={side}
                      className="small-button primary"
                      onClick={() => onContinue(reveal[side].model)}
                    >
                      Continue with <span data-i18n="off">{name(side)}</span>
                    </button>
                  ),
              )}
              <button type="button" className="small-button" onClick={onKeepComparing}>
                <Icon name="scale" size={14} />
                Keep comparing
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Your rankings: win rates from your own votes, and Reset.
export function BlindRankings({ onClose }) {
  const [data, setData] = useState(null),
    [error, setError] = useState(""),
    [confirming, setConfirming] = useState(false),
    [working, setWorking] = useState(false);
  const load = () =>
    api("/api/blind/rankings")
      .then(setData)
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);
  async function reset() {
    setWorking(true);
    setError("");
    try {
      await api("/api/blind/rankings", { method: "DELETE" });
      setConfirming(false);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setWorking(false);
    }
  }
  const rows = data?.data || [];
  return (
    <Modal title="Your rankings" onClose={onClose}>
      <div className="blind-rankings">
        <p className="blind-rankings-lead">
          Win rates from your own Blind votes. A tie counts as half a win; both bad counts as a loss for both.
        </p>
        {error && <p className="blind-error">{error}</p>}
        {!data && !error ? (
          <p className="blind-rankings-empty">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="blind-rankings-empty">
            No votes yet. Compare two models and vote to start your rankings.
          </p>
        ) : (
          <ol className="blind-rank-list">
            {rows.map((r, i) => (
              <li key={r.model}>
                <span className="blind-rank-n">{i + 1}</span>
                <span className="blind-rank-main">
                  <b data-i18n="off">{r.name}</b>
                  <span className="blind-rank-bar" aria-hidden="true">
                    <span style={{ width: percent(r.win_rate) }} />
                  </span>
                  <small className="blind-rank-counts">
                    <span>{r.wins === 1 ? "1 win" : `${r.wins} wins`}</span>
                    <span>{r.ties === 1 ? "1 tie" : `${r.ties} ties`}</span>
                    <span>{r.losses === 1 ? "1 loss" : `${r.losses} losses`}</span>
                  </small>
                </span>
                <span className="blind-rank-rate">{percent(r.win_rate)}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="blind-rankings-note">
          Only the two model names, your vote and its date are kept for this. Never your prompts or the replies.
        </p>
        {rows.length > 0 &&
          (confirming ? (
            <div className="blind-reset-confirm" role="group" aria-label="Reset rankings">
              <span>
                {data.votes === 1
                  ? "Delete your 1 vote? Saved chats keep their reveals."
                  : `Delete all ${data.votes} votes? Saved chats keep their reveals.`}
              </span>
              <button type="button" className="small-button" disabled={working} onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button type="button" className="small-button danger" disabled={working} onClick={reset}>
                Reset rankings
              </button>
            </div>
          ) : (
            <button type="button" className="small-button" onClick={() => setConfirming(true)}>
              Reset rankings
            </button>
          ))}
      </div>
    </Modal>
  );
}
