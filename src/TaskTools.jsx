import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import remarkGfm from "remark-gfm";
import { Notice, CopyButton } from "./ui.jsx";
import { api, streamChat, uid, isReleased, download } from "./lib.js";
import {
  calculate,
  taskMessages,
  appendAlternative,
  taskEvent,
  completeTask,
  TASK_INPUT_LIMIT,
  ALTERNATIVE_LIMIT,
} from "./task-tools.js";
import { createVeilState, veil, unveil, saveVeilState } from "./veil.js";
import { VeilToggle, veilRemarkPlugin } from "./Veil.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import "./task-tools.css";

export default function TaskTools({
  demo,
  user,
  models,
  config,
  refresh,
  veilOn,
  setVeilOn,
  veilWords,
}) {
  const [tab, setTab] = useState("research"),
    [input, setInput] = useState(""),
    [direction, setDirection] = useState("Clear and concise"),
    [model, setModel] = useState("");
  const [results, setResults] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [quote, setQuote] = useState(null),
    [expression, setExpression] = useState("(120 + 80) * 15 / 100"),
    [answer, setAnswer] = useState(null),
    [calcError, setCalcError] = useState("");
  // Seed Guard: the brief is scanned before a run or an estimate sends it.
  const seedHit = useSeedScan(
    !demo && seedGuardLive(config) && tab !== "calculator",
    input,
  );
  const controller = useRef(null),
    quoteController = useRef(null),
    lock = useRef(false),
    mounted = useRef(true);
  const uncensored = config?.releases?.uncensoredModels || [];
  const choices = models.filter(
    (m) =>
      m.type === "chat" &&
      m.callable &&
      !m.imageCapable &&
      !uncensored.includes(m.id),
  );
  useEffect(() => {
    setModel((prev) =>
      choices.some((m) => m.id === prev) ? prev : choices[0]?.id || "",
    );
  }, [models, config]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      quoteController.current?.abort();
    };
  }, []);
  useEffect(() => {
    quoteController.current?.abort();
    setQuote(null);
  }, [input, direction, model, tab, veilOn, veilWords]);
  const shown = results.filter((r) => r.kind === tab);
  function requestBody(allowSeed = false) {
    const messages = taskMessages(tab, input, direction),
      state = createVeilState();
    if (veilOn && isReleased(config, "veil"))
      messages[1].content = veil(messages[1].content, state, veilWords).text;
    return {
      state,
      body: {
        taskTool: tab,
        mode: "chat",
        model,
        messages,
        max_tokens: 2048,
        ...(tab === "research" ? { web_search: true } : {}),
        ...(allowSeed ? { allow_seed_phrase: true } : {}),
      },
    };
  }
  async function estimate() {
    if (lock.current || seedHit) return;
    setError("");
    quoteController.current?.abort();
    const ctl = new AbortController();
    quoteController.current = ctl;
    try {
      const { body } = requestBody();
      const q = await api("/api/quote", {
        method: "POST",
        body,
        signal: ctl.signal,
      });
      if (mounted.current && !ctl.signal.aborted) setQuote(q.credits);
    } catch (e) {
      if (mounted.current && !ctl.signal.aborted) setError(e.message);
    }
  }
  // `allowSeed` is Seed Guard's confirmed "Send anyway".
  async function generate(e, { allowSeed = false } = {}) {
    e?.preventDefault();
    if (lock.current || (seedHit && !allowSeed)) return;
    if (demo || !user) {
      setError(
        "Sign in to run a task. The calculator works locally without a model call.",
      );
      return;
    }
    let setup;
    try {
      if (!model) throw Error("No callable chat model is available.");
      setup = requestBody(seedHit?.kind === "seed");
      if (results.length >= ALTERNATIVE_LIMIT)
        throw Error(
          "Keep up to eight results. Download or remove one before adding another.",
        );
    } catch (e) {
      setError(e.message);
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    const ctl = new AbortController();
    controller.current = ctl;
    let item = {
      id: uid(),
      kind: tab,
      input,
      direction,
      model,
      modelName: choices.find((m) => m.id === model)?.name || model,
      text: "",
      sources: [],
      receipt: null,
      conversationId: null,
      status: "running",
      map: setup.state.map,
    };
    setResults((prev) => appendAlternative(prev, item));
    const update = () => {
      if (mounted.current)
        setResults((prev) =>
          prev.map((r) => (r.id === item.id ? { ...item } : r)),
        );
    };
    try {
      await streamChat(
        { ...setup.body, requestId: item.id },
        (event) => {
          try {
            item = taskEvent(item, event);
          } catch (e) {
            ctl.abort();
            throw e;
          }
          if (item.conversationId && veilOn)
            saveVeilState(item.conversationId, setup.state);
          update();
          if (item.status === "failed") {
            ctl.abort();
            throw Error(item.error);
          }
        },
        ctl.signal,
      );
      item = completeTask(item);
    } catch (e) {
      item.status = e.name === "AbortError" ? "stopped" : "failed";
      item.error =
        e.name === "AbortError"
          ? "Stopped. Partial output is preserved; check your ledger for any charge."
          : e.message;
    } finally {
      update();
      lock.current = false;
      if (mounted.current) setBusy(false);
      refresh?.();
    }
  }
  return (
    <section className="task-tools">
      <p className="eyebrow">A WORKBENCH FOR YOUR NEXT IDEA</p>
      <h1>Research, Writing & Calculators</h1>
      <p>
        Keep sources, alternative drafts and calculated values clearly apart.
      </p>
      <div className="filter-tabs" aria-label="Task tools">
        {["research", "writing", "calculator"].map((t) => (
          <button
            key={t}
            aria-pressed={tab === t}
            disabled={busy}
            className={tab === t ? "active" : ""}
            onClick={() => {
              setTab(t);
              setError("");
            }}
          >
            {t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      {tab === "calculator" ? (
        <form
          className="task-form"
          onSubmit={(e) => {
            e.preventDefault();
            try {
              setAnswer({ expression, value: calculate(expression) });
              setCalcError("");
            } catch (err) {
              setAnswer(null);
              setCalcError(err.message);
            }
          }}
        >
          <label htmlFor="arithmetic">Arithmetic expression</label>
          <input
            id="arithmetic"
            value={expression}
            maxLength={256}
            onChange={(e) => {
              setExpression(e.target.value);
              setAnswer(null);
              setCalcError("");
            }}
            spellCheck="false"
            autoComplete="off"
          />
          <p className="task-help">
            Numbers, parentheses, + − * / ^ and % (remainder). Powers associate
            right to left. No functions, variables or code. Up to 256
            characters.
          </p>
          <button className="button" type="submit">
            Calculate locally
          </button>
          {calcError && <Notice type="error">{calcError}</Notice>}
          {answer && (
            <div className="task-value" aria-live="polite">
              <span>CALCULATED LOCALLY · NO MODEL CALL</span>
              <code>
                {answer.expression} = {String(answer.value)}
              </code>
              <CopyButton text={String(answer.value)} />
            </div>
          )}
          <p className="task-help">
            Uses floating-point arithmetic: decimals may round. Values outside
            the safe supported range are refused. No credits are used.
          </p>
        </form>
      ) : (
        <>
          <p className="task-help">
            Each run uses prepaid credits and saves a separate chat in your
            history. This comparison keeps up to eight results while you remain
            on this page. Download them before leaving.
          </p>
          {tab === "research" && !isReleased(config, "search") ? (
            <Notice>
              Research requires Live Web Search, which is not released.
            </Notice>
          ) : (
            <form className="task-form" onSubmit={generate}>
              <label htmlFor="task-brief">
                {tab === "research"
                  ? "Research question"
                  : "Writing brief or original text"}
              </label>
              <textarea
                id="task-brief"
                rows={5}
                value={input}
                disabled={busy}
                maxLength={TASK_INPUT_LIMIT}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  tab === "research"
                    ? "What do you want to investigate?"
                    : "What are you writing, for whom, and what must stay true?"
                }
              />
              <div className="task-controls">
                <label>
                  Model
                  <select
                    value={model}
                    disabled={busy}
                    onChange={(e) => setModel(e.target.value)}
                  >
                    {choices.map((m) => (
                      <option key={m.id} value={m.id} data-i18n="off">
                        {m.name}
                      </option>
                    ))}
                  </select>
                </label>
                {tab === "writing" && (
                  <label>
                    Direction
                    <select
                      value={direction}
                      disabled={busy}
                      onChange={(e) => setDirection(e.target.value)}
                    >
                      {[
                        "Clear and concise",
                        "Warm and conversational",
                        "Formal and precise",
                      ].map((d) => (
                        // An explicit value: the label may show translated,
                        // the request always carries the English direction.
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {isReleased(config, "veil") && (
                  <VeilToggle
                    on={veilOn}
                    onToggle={() => {
                      if (!busy) setVeilOn((v) => !v);
                    }}
                  />
                )}
              </div>
              <SeedGuardNotice
                hit={seedHit}
                busy={busy}
                onProceed={() => generate(null, { allowSeed: true })}
              />
              <div className="task-actions">
                <button
                  type="button"
                  disabled={busy || !input.trim() || !model || demo || !user || !!seedHit}
                  onClick={estimate}
                >
                  Estimate credits
                </button>
                <button
                  className="button"
                  disabled={
                    busy ||
                    !input.trim() ||
                    !model ||
                    !!seedHit ||
                    results.length >= ALTERNATIVE_LIMIT
                  }
                  type="submit"
                >
                  {tab === "research"
                    ? "Research with Web"
                    : "Create another alternative"}
                </button>
                {busy && (
                  <button
                    type="button"
                    onClick={() => controller.current?.abort()}
                  >
                    Stop
                  </button>
                )}
              </div>
              {quote != null && (
                <p role="status">
                  Estimated {quote.toLocaleString()} credits; actual usage may
                  differ.
                </p>
              )}
            </form>
          )}
          {error && <Notice type="error">{error}</Notice>}
          <div className="task-results" aria-live="polite">
            {shown.map((r, i) => (
              <article className="task-result" key={r.id}>
                <header>
                  <h2>
                    {tab === "writing" ? "Alternative" : "Research"} {i + 1}
                  </h2>
                  <span>{r.status}</span>
                </header>
                <p>
                  <span data-i18n="off">{r.modelName}</span>
                  {r.kind === "writing" ? ` · ${r.direction}` : ""}
                </p>
                <details>
                  <summary>Original brief</summary>
                  <p className="task-original" data-i18n="off">
                    {r.input}
                  </p>
                </details>
                <p className="task-kind">
                  MODEL-GENERATED {r.kind === "writing" ? "DRAFT" : "ANALYSIS"}{" "}
                  · CHECK IMPORTANT CLAIMS
                </p>
                {/* Model output stays as written; only the placeholder translates. */}
                <div className="prose" data-i18n={r.text ? "off" : undefined}>
                  <ReplyMarkdown
                    rich={!!r.text}
                    remarkPlugins={[
                      remarkGfm,
                      [veilRemarkPlugin, { map: r.map }],
                    ]}
                  >
                    {r.text || "Waiting for the model…"}
                  </ReplyMarkdown>
                </div>
                {r.kind === "research" && (
                  <aside className="task-sources">
                    <h3>Provider-returned sources</h3>
                    <p>
                      Only links returned as source metadata appear here. Their
                      content is not independently verified here.
                    </p>
                    {r.sources.length ? (
                      <ol>
                        {r.sources.map((s) => (
                          <li key={s.url} data-i18n="off">
                            <a
                              href={s.url}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              {s.title}
                            </a>
                            <small>{new URL(s.url).hostname}</small>
                          </li>
                        ))}
                      </ol>
                    ) : r.status === "running" ? (
                      <p>Waiting for the provider's source metadata…</p>
                    ) : (
                      <p>
                        <strong>No source citations returned.</strong> This
                        answer is model prose, not verified research.
                      </p>
                    )}
                  </aside>
                )}
                {r.error && <Notice type="error">{r.error}</Notice>}
                {r.receipt && (
                  <p>
                    {Number(r.receipt.credits_charged || 0).toLocaleString()}{" "}
                    credits charged
                    {r.receipt.local_test ? " · Local test fixture" : ""}
                  </p>
                )}
                {!r.receipt && ["failed", "stopped"].includes(r.status) && (
                  <p role="status">
                    Charge status unknown. Check your activity before retrying;
                    stopping or losing the connection does not confirm no
                    charge.
                  </p>
                )}
                <div className="task-actions">
                  <CopyButton text={unveil(r.text, r.map)} />
                  <button
                    disabled={!r.text}
                    onClick={() =>
                      download(
                        `anonyma-${r.kind}-${i + 1}.md`,
                        `${r.input}\n\n${unveil(r.text, r.map)}\n\nProvider-returned sources:\n${r.sources.map((s) => `${s.title}: ${s.url}`).join("\n")}`,
                        "text/markdown",
                      )
                    }
                  >
                    Download
                  </button>
                  {r.conversationId && (
                    <Link
                      to={`/workspace/chat?c=${encodeURIComponent(r.conversationId)}`}
                    >
                      Open saved chat
                    </Link>
                  )}
                  <button
                    disabled={busy}
                    onClick={() =>
                      setResults((prev) => prev.filter((v) => v.id !== r.id))
                    }
                  >
                    Remove from comparison
                  </button>
                </div>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
