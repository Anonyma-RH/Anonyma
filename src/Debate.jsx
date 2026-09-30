import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { Icon, Notice } from "./ui.jsx";
import { api, isReleased, uid, copyText, download, streamChat } from "./lib.js";
import { createVeilState, veil, unveil, saveVeilState, loadVeilState } from "./veil.js";
import { VeilToggle, veilRemarkPlugin } from "./Veil.jsx";
import { PrivateModeToggle, NoPrivateModelsNotice, privateModeReleased } from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { SecretGuardNotice, useSecretGuard, useSecretScan } from "./SecretGuard.jsx";
import { maskSecrets, removeSecrets, secretGuardTurn } from "./secret-guard.js";
import { shieldMarkdown, useShieldLive } from "./Shield.jsx";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import { LowBalanceRefusal } from "./BalanceAlerts.jsx";
import { formatCredits } from "./estimate.js";
import { getLanguage } from "./i18n.js";
import {
  LIMITS,
  WORDS,
  applyEvent,
  checkSetup,
  debateMarkdown,
  defaultModels,
  exportName,
  groupModels,
  newRun,
  runFromMessages,
  turnPlan,
} from "./debate.js";
import "./debate.css";
// Quote Cards' editor, loaded when a card is first made from a turn.
const QuoteCardDialog = lazy(() => import("./QuoteCards.jsx"));

// Model Debate (update "debate", which runs on Symposium's models): one
// question, two models arguing it in rounds (Side A then Side B in each: an
// opening, rebuttals, a closing) and, optionally, a third model that judges
// it blind, as Side A and Side B. Everything is one request to
// /api/debate (server/routes/debate.js): the most it can cost is held first
// (the quote is the hold), each turn streams as it is written, and only turns
// that finish are charged. Veil masks the question and positions in this
// browser first and puts the details back on this page; Private Mode and off
// the record keep nothing; otherwise a finished debate is one ordinary
// conversation in History, reopened here by ?c=.

const n = (v) => Number(v || 0).toLocaleString("en-US");
const ROUND_CHOICES = [1, 2, 3, 4];
const toneOf = (q) =>
  q?.available != null && q.credits > q.available
    ? "short"
    : q?.spending_limit?.remaining != null && q.credits > Number(q.spending_limit.remaining)
      ? "limited"
      : "ready";

// A debounced /api/debate/quote for what would be sent. Quoting holds,
// stores and sends nothing to a model.
function useQuote(body, tick) {
  const [state, setState] = useState({ status: "idle" });
  const key = body ? JSON.stringify(body) : "";
  useEffect(() => {
    if (!body) {
      setState({ status: "idle" });
      return;
    }
    const controller = new AbortController();
    setState((s) => ({ status: "loading", last: s.status === "ready" ? s : s.last }));
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/debate/quote", { method: "POST", body, signal: controller.signal });
        setState({ status: "ready", ...r, key, tick });
      } catch (e) {
        if (e?.name === "AbortError") return;
        setState({ status: "unavailable", message: e?.message || "The estimate is unavailable." });
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [key, tick]);
  return state;
}

const sideName = (side) => "Side " + side.toUpperCase();
const roleLabel = { opening: "Opening", rebuttal: "Rebuttal", closing: "Closing" };
const forAgainst = (side) => (side === "a" ? "For" : "Against");
// A model picker grouped by maker, the maker written once.
function ModelSelect({ value, onChange, groups, disabled, none }) {
  return (
    <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {none && <option value="">{none}</option>}
      {groups.map((g) => (
        <optgroup key={g.key} label={g.label}>
          {g.models.map((m) => (
            <option key={m.id} value={m.id} data-i18n="off">
              {m.name}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

export default function Debate({ demo, user, models, config, refresh, veilOn, setVeilOn, veilWords, vaultLive }) {
  const [params, setParams] = useSearchParams();
  const savedId = params.get("c");
  const live = !demo && !!user;
  const [question, setQuestion] = useState(""),
    [format, setFormat] = useState("for_against"),
    [stanceA, setStanceA] = useState(""),
    [stanceB, setStanceB] = useState(""),
    [rounds, setRounds] = useState(2),
    [modelA, setModelA] = useState(""),
    [modelB, setModelB] = useState(""),
    [judgeChoice, setJudgeChoice] = useState("default"),
    [keep, setKeep] = useState("history"),
    [privateOn, setPrivateOn] = useState(false),
    [tick, setTick] = useState(0),
    [running, setRunning] = useState(null),
    [run, setRun] = useState(null),
    [veilMap, setVeilMap] = useState({}),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [card, setCard] = useState(null),
    [copied, setCopied] = useState(false);
  const mounted = useRef(true),
    controller = useRef(null),
    input = useRef(null);
  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && live && (veilOn || privateOn);
  const privateLive = privateModeReleased(config);
  const offRecordLive = isReleased(config, "ephemeral");
  const trailLive = privacyTrailReleased(config);
  const cardsLive = isReleased(config, "quotecards");
  const uncensored = config?.releases?.uncensoredModels || [];
  const choices = useMemo(
    () => models.filter((m) => m.type === "chat" && m.callable && !m.imageCapable && !m.sealed && !uncensored.includes(m.id) && (!privateOn || m.private)),
    [models, privateOn, config],
  );
  const groups = useMemo(() => groupModels(choices), [choices]);
  const defaults = useMemo(() => defaultModels(choices), [choices]);
  const has = (id) => choices.some((m) => m.id === id);
  // Keep the picks valid as the catalog loads or Private Mode narrows it.
  useEffect(() => {
    setModelA((prev) => (has(prev) ? prev : defaults[0] || ""));
    setModelB((prev) => (has(prev) ? prev : defaults[1] || defaults[0] || ""));
  }, [choices]);
  const judge = judgeChoice === "none" ? "" : has(judgeChoice) ? judgeChoice : (defaults[2] ?? "");
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);
  const nameOf = (id) => models.find((m) => m.id === id)?.name || id || "";

  // ---- Reopening a saved debate (?c=) ----
  // A link to another saved debate (Open in Debate) replaces the one shown.
  useEffect(() => {
    if (savedId && run?.conversationId && run.conversationId !== savedId && !running) setRun(null);
  }, [savedId]);
  useEffect(() => {
    if (!live || !savedId || run || running) return;
    const ctl = new AbortController();
    setLoading(true);
    setError("");
    api("/api/conversations/" + encodeURIComponent(savedId), { signal: ctl.signal }).then(
      (r) => {
        const found = runFromMessages(r.messages || []);
        setLoading(false);
        if (!found) return setError("This isn't a saved debate.");
        setVeilMap(loadVeilState(savedId).map);
        setRun({ ...found, conversationId: savedId });
      },
      (e) => {
        if (ctl.signal.aborted) return;
        setLoading(false);
        setError(e.status === 404 ? "This debate isn't in your History any more." : e?.message || "The debate couldn't be opened.");
      },
    );
    return () => ctl.abort();
  }, [live, savedId, !!run]);
  function dropSaved() {
    if (!params.get("c")) return;
    const next = new URLSearchParams(params);
    next.delete("c");
    setParams(next, { replace: true });
  }
  function reset() {
    controller.current?.abort();
    setRun(null);
    setError("");
    setRunning(null);
    dropSaved();
    setTimeout(() => input.current?.focus(), 0);
  }

  // ---- What is sent: the question and positions, masked by Veil in order
  // with one tag map, so a quote and a run see the same text ----
  const sent = useMemo(() => {
    const state = createVeilState();
    const mask = (s) => (veiling && s ? veil(s, state, veilWords) : { text: s, count: 0 });
    const q = mask(question.trim()),
      a = mask(stanceA.trim()),
      b = mask(stanceB.trim());
    return { question: q.text, a: a.text, b: b.text, count: q.count + (format === "positions" ? a.count + b.count : 0), state };
  }, [question, stanceA, stanceB, format, veiling, veilWords]);
  const ephemeral = privateOn || (keep === "none" && offRecordLive);
  const setup = useMemo(() => {
    try {
      return checkSetup({ question: sent.question, format, ...(format === "positions" ? { stance_a: sent.a, stance_b: sent.b } : {}), rounds });
    } catch {
      return null;
    }
  }, [sent, format, rounds]);
  const noPrivate = privateOn && !choices.length;
  const settled = !!running;
  // Secret Guard: a password, key or token in the question or a position
  // holds the debate (and its estimate, which posts the same words), after
  // Seed Guard's notice, until it's masked, removed or sent anyway. Masked,
  // the models and the saved debate see a placeholder like [SECRET_1].
  const secretLive = useSecretGuard(config, user, demo);
  const secretTexts = useMemo(() => [question, format === "positions" ? stanceA : "", format === "positions" ? stanceB : ""], [question, stanceA, stanceB, format]);
  const secretFinds = useSecretScan(secretLive && !running && !run, secretTexts);
  const [secretOk, setSecretOk] = useState(false),
    [seedAnswered, setSeedAnswered] = useState(false),
    [secretQueued, setSecretQueued] = useState(null);
  useEffect(() => {
    setSecretOk(false);
    setSeedAnswered(false);
  }, [secretTexts]);
  const secretHeld = secretFinds.length > 0 && !secretOk;
  const body = useMemo(() => {
    if (!live || !setup || !modelA || !modelB || noPrivate || settled || run || secretHeld) return null;
    return {
      question: setup.question,
      format,
      ...(format === "positions" ? { stance_a: setup.stances.a, stance_b: setup.stances.b } : {}),
      rounds,
      model_a: modelA,
      model_b: modelB,
      ...(judge ? { judge_model: judge } : {}),
      ...(privateOn ? { private: true } : ephemeral ? { ephemeral: true } : {}),
    };
  }, [live, setup, format, rounds, modelA, modelB, judge, privateOn, ephemeral, noPrivate, settled, run, secretHeld]);
  const estimate = useQuote(body, tick);
  const quote = estimate.status === "ready" ? estimate : estimate.last;
  const quoteFresh = estimate.status === "ready" && estimate.key === JSON.stringify(body) && estimate.tick === tick;
  const seedTexts = useMemo(() => [question, format === "positions" ? stanceA : "", format === "positions" ? stanceB : ""], [question, stanceA, stanceB, format]);
  const seedHit = useSeedScan(live && seedGuardLive(config), seedTexts);
  const short = quote && toneOf(quote) !== "ready";
  const startable = live && !!body && !noPrivate && quoteFresh && !short && !running;
  const ready = startable && !seedHit && !secretHeld;
  const secretTurn = secretGuardTurn({ seedHit, finds: secretHeld ? secretFinds : [], seedAnswered });
  // Secret Guard's Mask and send, or Send anyway: the debate starts once the
  // estimate for the words as they now are is in (never on a stale one).
  useEffect(() => {
    if (!secretQueued) return;
    if (startable && !secretHeld) {
      setSecretQueued(null);
      start({ allowSeed: secretQueued.allowSeed });
    } else if (running || noPrivate || short || estimate.status === "unavailable") setSecretQueued(null);
  }, [secretQueued, startable, secretHeld, running, noPrivate, short, estimate.status]);
  function maskDebateSecrets() {
    const state = {};
    setQuestion((q) => maskSecrets(q, state).text);
    setStanceA((a) => maskSecrets(a, state).text);
    setStanceB((b) => maskSecrets(b, state).text);
    setSecretQueued({ allowSeed: seedAnswered });
  }
  const judgeIsDebater = !!judge && (judge === modelA || judge === modelB);

  // ---- Running ----
  async function start({ allowSeed = false } = {}) {
    if (running || !live || !body || noPrivate || (seedHit && !allowSeed) || !quoteFresh || short) return;
    const ctl = (controller.current = new AbortController());
    const requestId = uid();
    const plan = turnPlan(rounds).map((t) => ({ ...t, model: t.side === "a" ? modelA : modelB }));
    let current = newRun({ setup, plan, judge: judge || null });
    setVeilMap({ ...sent.state.map });
    setRun(current);
    setRunning({ requestId, stopping: false });
    setError("");
    dropSaved();
    let finalEvent = null,
      cleared = false;
    try {
      await streamChat(
        {
          ...body,
          max_units: quote.units,
          requestId,
          lang: getLanguage(),
          ...(isReleased(config, "trail") ? { veil_masked: veiling ? sent.count : null } : {}),
          ...(allowSeed && seedHit?.kind === "seed" ? { allow_seed_phrase: true } : {}),
        },
        (ev) => {
          if (!mounted.current) return;
          if (ev.debate?.stage === "done") finalEvent = ev;
          current = applyEvent(current, ev);
          setRun(current);
        },
        ctl.signal,
        "/api/debate",
      );
    } catch (e) {
      if (mounted.current && e?.name !== "AbortError") {
        // Nothing ran (refused before the first event): back to the form.
        if (!finalEvent && !Object.values(current.turns).some((t) => t.status === "done")) {
          cleared = true;
          setRun(null);
        }
        setError(e?.message || "The debate couldn't run. Nothing was charged.");
        // The page's figure was out of date: get the current one.
        if (e?.code === "estimate_changed") setTick((k) => k + 1);
      }
    } finally {
      if (controller.current === ctl) controller.current = null;
      if (mounted.current) {
        // A stream that ended without saying so (the connection dropped) is
        // shown as stopped: what finished was charged and, if it was kept, is
        // in History.
        if (!finalEvent && !cleared && current.status === "running") setRun(applyEvent(current, { debate: { stage: "done", status: "stopped" } }));
        setRunning(null);
      }
      refresh?.();
    }
    if (!mounted.current || !finalEvent) return;
    const id = finalEvent.conversationId;
    // The details Veil masked come back from a map kept in this browser
    // only, so History and a reload can put them back too.
    if (id && sent.count) saveVeilState(id, sent.state);
    if (id) {
      // A reload opens what's on screen.
      const next = new URLSearchParams(params);
      next.set("c", id);
      setParams(next, { replace: true });
    }
  }
  // Stopping asks the server to stop: the turn in flight and every step
  // after it are released, and the stream reports what finished. If that
  // can't be asked, the connection is dropped, which stops it too.
  async function stop() {
    if (!running) return;
    setRunning((r) => r && { ...r, stopping: true });
    try {
      const r = await api("/api/debate/stop", { method: "POST", body: { requestId: running.requestId } });
      if (!r.stopped) controller.current?.abort();
    } catch {
      controller.current?.abort();
    }
  }

  const restore = (s) => unveil(s, veilMap);
  const shieldParts = useShieldLive(config) ? shieldMarkdown() : undefined;
  const marks = useMemo(() => [remarkGfm, [veilRemarkPlugin, { map: veilMap }]], [veilMap]);

  async function copyAll() {
    const ok = await copyText(debateMarkdown(run, { name: nameOf, restore, lang: getLanguage(), date: new Date().toISOString().slice(0, 10) }));
    if (ok) {
      setCopied(true);
      setTimeout(() => mounted.current && setCopied(false), 1800);
    }
  }
  function exportIt() {
    download(exportName(run.setup), debateMarkdown(run, { name: nameOf, restore, lang: getLanguage(), date: new Date().toISOString().slice(0, 10) }), "text/markdown");
  }

  const showForm = !run && !loading;
  const positions = format === "positions";
  return (
    <section className="debate-page">
      <div className="debate-head">
        <p className="eyebrow">MODEL DEBATE</p>
        <h1>Debate</h1>
        <p>
          Pick a question and two models. They argue it out in rounds, and a third model sums up who made the better case.
        </p>
      </div>

      {!live ? (
        <>
          <Notice>{demo ? "The demo can't run debates. Sign in to start one." : "Sign in to start a debate."}</Notice>
          <Promises />
        </>
      ) : (
        <>
          {loading && <p className="debate-loading">Opening the debate…</p>}
          {showForm && (
            <form
              className="debate-form"
              onSubmit={(e) => {
                e.preventDefault();
                start();
              }}
            >
              <label className="debate-field wide" htmlFor="debate-question">
                <span>The question or claim</span>
              </label>
              <textarea
                id="debate-question"
                ref={input}
                rows={3}
                value={question}
                maxLength={LIMITS.question}
                disabled={!!running}
                placeholder="Should cities ban cars from their centres?"
                onChange={(e) => setQuestion(e.target.value)}
              />
              <div className="debate-row">
                <fieldset className="debate-field">
                  <legend>The sides</legend>
                  <div className="debate-seg" role="radiogroup" aria-label="The sides">
                    {[
                      ["for_against", "For and against"],
                      ["positions", "Two positions"],
                    ].map(([id, label]) => (
                      <button key={id} type="button" role="radio" aria-checked={format === id} className={format === id ? "on" : ""} disabled={!!running} onClick={() => setFormat(id)}>
                        {label}
                      </button>
                    ))}
                  </div>
                  <small>
                    {positions
                      ? "Write what each side argues. Neither has to be a yes or no."
                      : "Side A argues for it, or says yes. Side B argues against it, or says no."}
                  </small>
                </fieldset>
                <fieldset className="debate-field">
                  <legend>Rounds</legend>
                  <div className="debate-seg" role="radiogroup" aria-label="Rounds">
                    {ROUND_CHOICES.map((r) => (
                      <button key={r} type="button" role="radio" aria-checked={rounds === r} className={rounds === r ? "on" : ""} disabled={!!running} onClick={() => setRounds(r)}>
                        {String(r)}
                      </button>
                    ))}
                  </div>
                  <small>
                    {rounds === 1 ? "An opening statement each." : rounds === 2 ? "An opening and a closing each." : rounds === 3 ? "An opening, a rebuttal and a closing each." : "An opening, two rebuttals and a closing each."}
                  </small>
                </fieldset>
              </div>
              {positions && (
                <div className="debate-row">
                  {[
                    ["a", stanceA, setStanceA],
                    ["b", stanceB, setStanceB],
                  ].map(([side, value, set]) => (
                    <label key={side} className="debate-field">
                      <span>{side === "a" ? "Side A argues" : "Side B argues"}</span>
                      <input
                        type="text"
                        value={value}
                        maxLength={LIMITS.stance}
                        disabled={!!running}
                        placeholder={side === "a" ? "Cities should ban cars from their centres" : "Cars should stay, with better rules"}
                        onChange={(e) => set(e.target.value)}
                      />
                    </label>
                  ))}
                </div>
              )}
              <div className="debate-row three">
                <label className="debate-field">
                  <span>{positions ? "Side A" : "Side A · For"}</span>
                  <ModelSelect value={modelA} onChange={setModelA} groups={groups} disabled={!!running || !choices.length} />
                </label>
                <label className="debate-field">
                  <span>{positions ? "Side B" : "Side B · Against"}</span>
                  <ModelSelect value={modelB} onChange={setModelB} groups={groups} disabled={!!running || !choices.length} />
                </label>
                <label className="debate-field">
                  <span>Judge</span>
                  <ModelSelect value={judge} onChange={(v) => setJudgeChoice(v === "" ? "none" : v)} groups={groups} disabled={!!running || !choices.length} none="No judge" />
                </label>
              </div>
              <p className="debate-note">
                <Icon name="eye" size={13} />
                <span>
                  {judge
                    ? "Blind judging: the judge sees the sides as A and B, never the model names."
                    : "Without a judge the debate ends after the last turn."}
                </span>
              </p>
              {judgeIsDebater && (
                <p className="debate-note warn">
                  <Icon name="warning" size={13} />
                  <span>This judge also argues a side. It won't know which, but a third model is the fairer judge.</span>
                </p>
              )}
              <div className="debate-settings">
                <label className="debate-field">
                  <span>Keep the debate</span>
                  <select value={privateOn ? "none" : keep} disabled={!!running || privateOn} onChange={(e) => setKeep(e.target.value)}>
                    <option value="history">In History</option>
                    {(offRecordLive || privateOn) && <option value="none">{privateOn ? "Nowhere (Private mode)" : "Nowhere (off the record)"}</option>}
                  </select>
                </label>
                {(privateLive || veilLive) && (
                  <div className="debate-toggles">
                    {privateLive && (
                      <PrivateModeToggle
                        active={privateOn}
                        disabled={!!running}
                        onToggle={() => {
                          setPrivateOn((on) => !on);
                          if (!privateOn && veilLive) setVeilOn?.(true);
                        }}
                      />
                    )}
                    {veilLive && (
                      <VeilToggle
                        on={veilOn || privateOn}
                        onToggle={() => {
                          if (!running && !privateOn) setVeilOn?.((v) => !v);
                        }}
                      />
                    )}
                  </div>
                )}
              </div>
              {vaultLive && (
                <p className="debate-note">
                  <Icon name="lock" size={13} />
                  <span>
                    Device Vault isn't offered here. The models run through ANONYMA's server, so a debate can't be kept only on this device. Keep it nowhere
                    to save nothing.
                  </span>
                </p>
              )}
              {privateOn && <p className="debate-note">Private mode: only models that keep no data are offered, and nothing is saved.</p>}
              {noPrivate && <NoPrivateModelsNotice />}
              <SeedGuardNotice
                hit={!running && secretTurn !== "secret" ? seedHit : null}
                busy={!!running}
                onProceed={() => (secretHeld ? setSeedAnswered(true) : start({ allowSeed: true }))}
              />
              <SecretGuardNotice
                finds={!running && secretTurn === "secret" ? secretFinds : []}
                busy={!!running || !!secretQueued}
                note="Mask swaps each one for a placeholder like [SECRET_1] before anything is sent. The models, the judge and the saved debate see only the placeholder."
                onMask={maskDebateSecrets}
                onRemove={() => {
                  setQuestion((q) => removeSecrets(q).text);
                  setStanceA((a) => removeSecrets(a).text);
                  setStanceB((b) => removeSecrets(b).text);
                }}
                onProceed={() => {
                  setSecretOk(true);
                  setSecretQueued({ allowSeed: seedAnswered });
                }}
              />
              {error && (
                <Notice type="error">
                  {error}
                  <LowBalanceRefusal config={config} user={user} demo={demo} error={error} />
                </Notice>
              )}
              <div className="debate-go">
                <button type="submit" className="button" disabled={!ready}>
                  <Icon name="scale" size={15} />
                  Start the debate
                </button>
                <span className={"credit-estimate debate-estimate " + (quote ? toneOf(quote) : "")} role="status" aria-busy={estimate.status === "loading"}>
                  {estimate.status === "unavailable" ? (
                    estimate.message
                  ) : quote ? (
                    <>
                      <Icon name="coins" size={13} />
                      {`Up to ${formatCredits(quote.credits)} credits`}
                      {toneOf(quote) === "short" && <b> · over your balance</b>}
                      {toneOf(quote) === "limited" && <b> · over your spending limit</b>}
                    </>
                  ) : (
                    "Working out the most it can cost…"
                  )}
                </span>
                <small>
                  The most every turn and the judge can cost is held first. You're charged only for the turns that finish, usually a small share of that. A
                  turn that fails stops the debate, and what didn't run costs nothing.
                </small>
              </div>
              {quote && (
                <details className="debate-costs">
                  <summary>Cost by step</summary>
                  <ol>
                    {quote.turns.map((t) => (
                      <li key={t.n}>
                        <span>{`Turn ${t.n}`}</span>
                        <span>{roleLabel[turnPlan(rounds).find((x) => x.n === t.n)?.role]}</span>
                        <span className="debate-cost-who">
                          <span>{sideName(t.side)}</span> <span data-i18n="off">{nameOf(quote.models?.[t.side])}</span>
                        </span>
                        <b>{`${formatCredits(t.credits)} credits`}</b>
                      </li>
                    ))}
                    {quote.judge != null && (
                      <li>
                        <span>Judge</span>
                        <span />
                        <span className="debate-cost-who">
                          <span data-i18n="off">{nameOf(quote.models?.judge)}</span>
                        </span>
                        <b>{`${formatCredits(quote.judge)} credits`}</b>
                      </li>
                    )}
                  </ol>
                  <p>
                    Each figure is the most that step can cost. A turn is priced on the longest debate it could read, so later turns cost more, and the
                    judge reads all of it. The total above is these added up, and it is what is held. You're charged for what each step actually uses.
                  </p>
                </details>
              )}
              <Promises />
            </form>
          )}
          {!showForm && error && !run && (
            <Notice type="error">
              {error}{" "}
              <button type="button" className="link-button" onClick={reset}>
                Start a new debate
              </button>
            </Notice>
          )}
          {run && (
            <DebateView
              run={run}
              running={running}
              nameOf={nameOf}
              map={veilMap}
              marks={marks}
              shieldParts={shieldParts}
              models={models}
              trailLive={trailLive}
              receiptsLive={isReleased(config, "receipts")}
              cardsLive={cardsLive}
              onCard={setCard}
              onStop={stop}
              onNew={reset}
              onCopy={copyAll}
              copied={copied}
              onExport={exportIt}
              ephemeral={ephemeral && !run.saved}
              privateRun={privateOn}
              error={error}
              config={config}
              user={user}
              demo={demo}
            />
          )}
          {card && (
            <Suspense fallback={null}>
              <QuoteCardDialog source={{ markdown: restore(card.text) }} modelName={nameOf(card.model)} veilMap={veilMap} seedGuard={seedGuardLive(config)} onClose={() => setCard(null)} />
            </Suspense>
          )}
        </>
      )}
    </section>
  );
}

function Promises() {
  return (
    <ul className="debate-promises">
      <li>
        <b>Two sides, in turns</b>
        <span>Side A speaks first, then Side B, round after round. Each turn is short, and each model reads what the other one said.</span>
      </li>
      <li>
        <b>A blind judge</b>
        <span>A third model reads the whole debate as Side A and Side B, with no model names, and says who made the better case, or that it's too close.</span>
      </li>
      <li>
        <b>Pay for what finishes</b>
        <span>You see the most it can cost before you start. If a turn fails the debate stops, and the turns that never ran cost nothing.</span>
      </li>
    </ul>
  );
}

// A run: the question and who is arguing, the turns as they are written, the
// judge's summary and what it cost.
function DebateView({
  run,
  running,
  nameOf,
  map,
  marks,
  shieldParts,
  models,
  trailLive,
  receiptsLive,
  cardsLive,
  onCard,
  onStop,
  onNew,
  onCopy,
  copied,
  onExport,
  ephemeral,
  privateRun,
  error,
  config,
  user,
  demo,
}) {
  const { setup, plan } = run;
  const total = plan.length;
  const done = plan.filter((t) => run.turns[t.n]?.status === "done").length;
  const live = run.status === "running";
  const modelOfSide = (side) => plan.find((t) => t.side === side)?.model;
  const verdict = run.judge?.verdict;
  const failed = plan.map((t) => run.turns[t.n]).find((t) => t?.status === "failed");
  let lastRound = 0;
  return (
    <div className="debate-run" aria-live="polite">
      <div className="debate-asked">
        <span className="debate-tag">The question</span>
        <p data-i18n="off">{unveil(setup.question, map)}</p>
        {setup.format === "positions" && (
          <ul>
            {["a", "b"].map((side) => (
              <li key={side}>
                <b>{sideName(side) + ":"}</b> <span data-i18n="off">{unveil(setup.stances[side], map)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="debate-legend">
          {["a", "b"].map((side) => (
            <span key={side} className={"debate-chip " + side}>
              <b>{sideName(side)}</b>
              {setup.format === "for_against" && <em>{forAgainst(side)}</em>}
              <span data-i18n="off">{nameOf(modelOfSide(side))}</span>
            </span>
          ))}
          <span className="debate-chip judge">
            <b>Judge</b>
            <span data-i18n="off">{run.judge ? nameOf(run.judge.model) : ""}</span>
            {!run.judge && <span>None</span>}
          </span>
        </div>
      </div>

      <div className="debate-progress" role="status">
        <span>{`${done} of ${total} turns`}</span>
        <i style={{ "--done": (total ? done / total : 0) * 100 + "%" }} aria-hidden="true" />
        {live && (
          <button type="button" className="debate-secondary" disabled={!running || running.stopping} onClick={onStop}>
            <Icon name="stop" size={13} />
            {running?.stopping ? "Stopping…" : "Stop"}
          </button>
        )}
      </div>

      <ol className="debate-turns">
        {plan.map((t) => {
          const turn = run.turns[t.n];
          const first = t.round !== lastRound;
          lastRound = t.round;
          return (
            <React.Fragment key={t.n}>
              {first && (
                <li className="debate-round" aria-hidden="true">
                  <span>{`Round ${t.round}`}</span>
                  <b>{roleLabel[t.role]}</b>
                </li>
              )}
              <li className={"debate-turn " + t.side + " " + turn.status}>
                <div className="debate-turn-head">
                  <span className={"debate-chip " + t.side}>
                    <b>{sideName(t.side)}</b>
                    {setup.format === "for_against" && <em>{forAgainst(t.side)}</em>}
                  </span>
                  <span className="debate-model" data-i18n="off">
                    {nameOf(t.model)}
                  </span>
                  <span className={"debate-status " + turn.status}>
                    {turn.status === "waiting" ? "Waiting…" : turn.status === "speaking" ? "Speaking…" : turn.status === "stopped" ? "Stopped" : turn.status === "failed" ? "Didn't finish" : ""}
                  </span>
                </div>
                {turn.text && (
                  <div className="markdown debate-text" data-i18n="off">
                    <ReplyMarkdown rich={turn.status === "done"} remarkPlugins={marks} components={shieldParts}>
                      {turn.text}
                    </ReplyMarkdown>
                  </div>
                )}
                {turn.status === "failed" && turn.error && <p className="debate-error">{turn.error}</p>}
                {turn.status === "done" && (
                  <div className="debate-turn-foot">
                    <span className="debate-credits">{`${formatCredits(turn.credits)} credits`}</span>
                    {turn.cutShort && <span>Cut short at the reply limit</span>}
                    {!turn.cutShort && turn.trimmed && <span>Trimmed to the word limit</span>}
                    {cardsLive && (
                      <button type="button" className="debate-link" onClick={() => onCard({ text: turn.text, model: t.model })}>
                        <Icon name="quotemark" size={12} />
                        Card
                      </button>
                    )}
                    {trailLive && turn.privacy && <PrivacyTrail privacy={turn.privacy} models={models} receiptsLive={receiptsLive} />}
                  </div>
                )}
              </li>
            </React.Fragment>
          );
        })}
      </ol>

      {run.judge && run.judge.status !== "waiting" && (
        <section className={"debate-judge " + run.judge.status} aria-label="The judge's summary">
          <div className="debate-turn-head">
            <span className="debate-tag">The judge</span>
            <span className="debate-model" data-i18n="off">
              {nameOf(run.judge.model)}
            </span>
            <span className={"debate-status " + run.judge.status}>
              {run.judge.status === "judging" ? "Reading the debate…" : run.judge.status === "stopped" ? "Stopped" : run.judge.status === "failed" ? "No summary" : ""}
            </span>
          </div>
          {run.judge.status === "failed" && run.judge.error && <p className="debate-error">{run.judge.error}</p>}
          {verdict && (
            <div className="debate-verdict">
              <p className={"debate-outcome " + verdict.verdict}>
                <b>{verdict.verdict === "a" ? "Side A made the better case." : verdict.verdict === "b" ? "Side B made the better case." : "Too close to call."}</b>{" "}
                <span data-i18n="off">{unveil(verdict.why, map)}</span>
              </p>
              {verdict.summary && <p data-i18n="off">{unveil(verdict.summary, map)}</p>}
              {(verdict.strongest.a || verdict.strongest.b) && (
                <div className="debate-points">
                  <h3>Strongest point</h3>
                  <div>
                    {["a", "b"].map((side) => (
                      <p key={side} className={side}>
                        <span className="debate-tag">{sideName(side)}</span>
                        <span data-i18n="off">{unveil(verdict.strongest[side], map) || "—"}</span>
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {(verdict.weakest.a || verdict.weakest.b) && (
                <div className="debate-points">
                  <h3>Where each side was weak</h3>
                  <div>
                    {["a", "b"].map((side) => (
                      <p key={side} className={side}>
                        <span className="debate-tag">{sideName(side)}</span>
                        <span data-i18n="off">{unveil(verdict.weakest[side], map) || "—"}</span>
                      </p>
                    ))}
                  </div>
                </div>
              )}
              {verdict.settle && (
                <div className="debate-points">
                  <h3>What would settle it</h3>
                  <p data-i18n="off">{unveil(verdict.settle, map)}</p>
                </div>
              )}
            </div>
          )}
          {verdict && (
            <p className="debate-blind">
              <Icon name="eye" size={13} />
              <span>The judge saw the sides as A and B, without model names.</span>
              <span>{`Side A was ${nameOf(modelOfSide("a"))}, and Side B was ${nameOf(modelOfSide("b"))}.`}</span>
            </p>
          )}
        </section>
      )}

      {error && (
        <Notice type="error">
          {error}
          <LowBalanceRefusal config={config} user={user} demo={demo} error={error} />
        </Notice>
      )}
      {!live && (
        <div className="debate-end">
          <div className="debate-summary" role="status">
            {run.status === "done" ? (
              <b>The debate finished.</b>
            ) : (
              <b>{done === 0 ? "Nothing finished, so nothing was charged." : `Stopped after ${done} of ${total} turns.`}</b>
            )}
            <span>
              {run.credits ? `Charged ${formatCredits(run.credits)} credits in all.` : "Nothing was charged."}
            </span>
            {failed?.error && !error && <span>{failed.error}</span>}
            {run.judge && run.judge.status === "failed" && <span>The judge's summary wasn't charged.</span>}
            {run.saved || run.conversationId ? (
              <span>Saved in your History.</span>
            ) : (
              <span>{privateRun ? "Not saved: Private mode keeps nothing." : ephemeral ? "Not saved: this debate was off the record." : "This debate isn't saved."}</span>
            )}
          </div>
          <div className="debate-actions">
            {done > 0 && (
              <>
                <button type="button" className="debate-secondary" onClick={onExport}>
                  <Icon name="download" size={14} />
                  Export Markdown
                </button>
                <button type="button" className="debate-secondary" onClick={onCopy}>
                  <Icon name="copy" size={14} />
                  {copied ? "Copied" : "Copy"}
                </button>
              </>
            )}
            {run.conversationId && (
              <Link className="debate-secondary" to={"/workspace/chat?c=" + encodeURIComponent(run.conversationId)}>
                <Icon name="chat" size={14} />
                Open in chat
              </Link>
            )}
            <button type="button" className="debate-secondary primary" onClick={onNew}>
              <Icon name="plus" size={14} />
              New debate
            </button>
          </div>
          {run.conversationId && (
            <p className="debate-note">
              <Icon name="share" size={13} />
              <span>To share it, open it in chat and use Share. Each turn is kept as a reply under its own model.</span>
            </p>
          )}
        </div>
      )}
      <p className="debate-note foot">
        <span>{`Each turn is asked to keep under about ${WORDS} words.`}</span>
        <span>The models argue the side they're given. What they write is a debating exercise, not advice or their own views, and they can be wrong.</span>
      </p>
    </div>
  );
}
