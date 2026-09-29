import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { isReleased } from "./lib.js";
import { Icon } from "./ui.jsx";
import { useLanguage, loadDictionary, t } from "./i18n.js";
import {
  HONEST_LINE,
  PYTHON_UPDATE,
  errorHint,
  firstRunNote,
  isPythonBlock,
  onRunnerChange,
  pythonWarm,
  runPython,
  runnerBusy,
} from "./python-runner.js";
import { PYODIDE_NOTICE_FILE, PYODIDE_PATH, RUN_TIMEOUTS, RUN_TIMEOUT_DEFAULT } from "./python-assets.js";
import "./python-runner.css";

// Python Runner (the "python" update): a Run button on ```python blocks in
// the workspace's replies. The code runs in this browser, in a Web Worker
// with no network (src/python.worker.js); printed output and matplotlib
// figures appear under the block. Nothing is sent to ANONYMA, nothing is
// charged, and the output isn't saved with the chat, exported or shared.
// Files are given only when the person ticks them: an attached CSV (or other
// text file) from this conversation, copied into the run's home folder.
//
// Labels sit inside the reply, which is fenced off from the page translator
// (data-i18n="off"), so they translate themselves; the code, its output and
// file names are never translated.

export const pythonReleased = (config) => isReleased(config, PYTHON_UPDATE);

// Asked once per browser, before the first run.
const ACK_KEY = "anonyma.python.ack";
const acknowledged = () => {
  try {
    return localStorage.getItem(ACK_KEY) === "1";
  } catch {
    return false;
  }
};
const acknowledge = () => {
  try {
    localStorage.setItem(ACK_KEY, "1");
  } catch {
    // Private windows: asked again next time.
  }
};

function useUiText() {
  const language = useLanguage();
  const [, redraw] = useState(0);
  useEffect(() => {
    if (language === "en") return;
    let current = true;
    loadDictionary(language).then(
      () => setTimeout(() => current && redraw((n) => n + 1), 0),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [language]);
  return (text) => (language !== "en" ? t(text) : text);
}

const busyNow = () => runnerBusy();
const useBusy = () => useSyncExternalStore(onRunnerChange, busyNow, busyNow);

const hastText = (node) =>
  node?.type === "text" ? node.value : (node?.children || []).map(hastText).join("");

const seconds = (ms) => (ms < 1000 ? `${Math.max(0.1, Math.round(ms / 100) / 10)} s` : `${Math.round(ms / 100) / 10} s`);

// What the panel's header says.
function statusLine(state, L, elapsed) {
  if (state.phase === "starting") return L("Starting Python…");
  if (state.phase === "packages")
    return state.packages.length ? L(`Loading ${state.packages.join(", ")}…`) : L("Loading packages…");
  if (state.phase === "running") return elapsed >= 1000 ? L(`Running… ${seconds(elapsed)}`) : L("Running…");
  const r = state.result;
  if (!r) return "";
  if (r.ok) return L(`Finished in ${seconds(r.ms || 0)}`);
  if (r.reason === "timeout") return L(`Stopped: still running after ${r.seconds} s`);
  if (r.reason === "load-timeout") return L("Python didn't start in time. Try again.");
  if (r.reason === "stopped") return L("Stopped");
  if (r.reason === "replaced") return L("Stopped: another block started");
  if (r.reason === "fatal") return L("Python couldn't run here.");
  return L("Finished with an error");
}

function Output({ state, L }) {
  const figures = useMemo(
    () => state.figures.map((png) => URL.createObjectURL(new Blob([png], { type: "image/png" }))),
    [state.figures],
  );
  useEffect(() => () => figures.forEach((u) => URL.revokeObjectURL(u)), [figures]);
  const text = state.chunks;
  const hint = state.result && !state.result.ok ? errorHint(text.map((c) => c.text).join("")) : null;
  return (
    <>
      {text.length > 0 && (
        <pre className="python-output" data-i18n="off" tabIndex={0} aria-label={L("Output")}>
          {text.map((c, i) => (
            <span key={i} className={c.stream === "stderr" ? "python-stderr" : undefined}>
              {c.text}
            </span>
          ))}
        </pre>
      )}
      {state.value !== null && (
        <pre className="python-output python-value" data-i18n="off" aria-label={L("Result")}>
          {state.value}
        </pre>
      )}
      {state.truncated && <p className="python-note">{L("Output cut short: only the first 200,000 characters are shown.")}</p>}
      {figures.length > 0 && (
        <div className="python-figures">
          {figures.map((url, i) => (
            <figure key={url}>
              <img src={url} alt={L(`Figure ${i + 1}`)} />
              <figcaption>
                <span>{L(`Figure ${i + 1}`)}</span>
                <a className="small-button python-save" href={url} download={`figure-${i + 1}.png`}>
                  <Icon name="download" size={12} />
                  <span>{L("Download PNG")}</span>
                </a>
              </figcaption>
            </figure>
          ))}
        </div>
      )}
      {state.figuresDropped && <p className="python-note">{L("Only the first 12 figures are shown.")}</p>}
      {hint && <p className="python-note">{L(hint)}</p>}
      {state.result?.reason === "fatal" && state.result.message && (
        <p className="python-note" data-i18n="off">
          {state.result.message}
        </p>
      )}
      {state.result && !state.result.ok && !text.length && !state.figures.length && state.result.reason === "timeout" && (
        <p className="python-note">{L("Python was stopped, so nothing it was doing carries on.")}</p>
      )}
    </>
  );
}

const IDLE = { phase: "idle", packages: [], files: [], chunks: [], figures: [], value: null, truncated: false, figuresDropped: false, result: null, started: 0 };

// A reply's code block with Run, when it's Python.
function RunnablePre({ node, base: Base, live, files, children, ...rest }) {
  const L = useUiText();
  const busy = useBusy();
  const code = node?.children?.find((c) => c.type === "element" && c.tagName === "code");
  const python = isPythonBlock(code?.properties?.className);
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState(IDLE);
  const [limit, setLimit] = useState(RUN_TIMEOUT_DEFAULT);
  const [chosen, setChosen] = useState(() => new Set());
  const [elapsed, setElapsed] = useState(0);
  const stop = useRef(null);
  const mine = state.phase !== "idle" && state.phase !== "done";
  useEffect(() => () => stop.current?.(), []);
  useEffect(() => {
    if (state.phase !== "running") return;
    const id = setInterval(() => setElapsed(Date.now() - state.started), 250);
    return () => clearInterval(id);
  }, [state.phase, state.started]);
  const plain = Base ? <Base node={node} {...rest}>{children}</Base> : <pre {...rest}>{children}</pre>;
  if (!python || !live) return plain;
  const source = hastText(code);
  const available = files || [];
  const given = available.filter((f) => chosen.has(f.name));

  const start = () => {
    setConfirming(false);
    setOpen(true);
    setElapsed(0);
    setState({ ...IDLE, phase: pythonWarm() ? "running" : "starting", started: Date.now(), files: given.map((f) => f.name) });
    stop.current = runPython({
      code: source,
      timeout: limit,
      files: given,
      onEvent: (e) => {
        if (e.type === "done") stop.current = null;
        setState((s) => {
          if (e.type === "status") return { ...s, phase: e.phase, packages: e.packages };
          if (e.type === "running") return { ...s, phase: "running", started: Date.now() };
          if (e.type === "out") {
            const last = s.chunks.at(-1);
            const chunks =
              last && last.stream === e.stream
                ? [...s.chunks.slice(0, -1), { stream: e.stream, text: last.text + e.text }]
                : [...s.chunks, { stream: e.stream, text: e.text }];
            return { ...s, chunks };
          }
          if (e.type === "figure") return { ...s, figures: [...s.figures, e.png] };
          if (e.type === "truncated") return { ...s, truncated: true };
          if (e.type === "figures-dropped") return { ...s, figuresDropped: true };
          if (e.type === "done") return { ...s, phase: "done", value: e.value ?? null, result: e };
          return s;
        });
      },
    });
  };
  const onRun = () => {
    if (acknowledged()) start();
    else {
      setOpen(true);
      setConfirming(true);
    }
  };
  const toggle = (name) =>
    setChosen((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });

  return (
    <div className="python-block">
      {plain}
      <div className="python-tools">
        {mine ? (
          <button type="button" className="small-button python-stop" onClick={() => stop.current?.()}>
            <Icon name="stop" size={12} />
            <span>{L("Stop")}</span>
          </button>
        ) : (
          <button
            type="button"
            className="small-button python-run"
            disabled={busy || confirming}
            title={busy ? L("Another block is running.") : L(HONEST_LINE)}
            onClick={onRun}
          >
            <Icon name="play" size={12} />
            <span>{state.phase === "done" ? L("Run again") : L("Run")}</span>
          </button>
        )}
        <label className="python-limit">
          <span>{L("Time limit")}</span>
          <select value={limit} disabled={mine} onChange={(e) => setLimit(Number(e.target.value))}>
            {RUN_TIMEOUTS.map((s) => (
              <option key={s} value={s}>
                {L(s < 60 ? `${s} seconds` : s === 60 ? "1 minute" : `${s / 60} minutes`)}
              </option>
            ))}
          </select>
        </label>
        {available.map((f) => (
          <label key={f.name} className={"python-file" + (chosen.has(f.name) ? " on" : "")}>
            <input type="checkbox" checked={chosen.has(f.name)} disabled={mine} onChange={() => toggle(f.name)} />
            <span>{/\.csv$/i.test(f.name) ? L("Use my attached CSV") : L("Use my attached file")}</span>
            <span className="python-file-name" data-i18n="off">
              {f.name}
            </span>
            {f.truncated && <span className="python-file-cut">{L("shortened")}</span>}
          </label>
        ))}
      </div>
      {open && (
        <section className="python-panel" aria-live="polite">
          {confirming ? (
            <div className="python-confirm">
              <p className="python-confirm-title">{L("Run this code in your browser?")}</p>
              <p>{L(HONEST_LINE)}</p>
              <p className="python-fine">
                {L(firstRunNote())}{" "}
                <a href={`${PYODIDE_PATH}/${PYODIDE_NOTICE_FILE}`} target="_blank" rel="noopener noreferrer">
                  {L("Open-source licences")}
                </a>
              </p>
              <div className="python-confirm-actions">
                <button
                  type="button"
                  className="small-button python-run primary"
                  onClick={() => {
                    acknowledge();
                    start();
                  }}
                >
                  <Icon name="play" size={12} />
                  <span>{L("Run code")}</span>
                </button>
                <button
                  type="button"
                  className="small-button"
                  onClick={() => {
                    setConfirming(false);
                    setOpen(false);
                  }}
                >
                  {L("Cancel")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <header className="python-head">
                <span className="python-eyebrow">{L("Python · in your browser")}</span>
                <span className={"python-status" + (state.result && !state.result.ok ? " bad" : "")}>
                  {statusLine(state, L, elapsed)}
                </span>
                {state.files.length > 0 && (
                  <span className="python-given" title={L("Files given to this run")}>
                    <Icon name="file" size={12} />
                    <span data-i18n="off">{state.files.join(", ")}</span>
                  </span>
                )}
                {!mine && (
                  <button
                    type="button"
                    className="icon-button python-close"
                    aria-label={L("Close output")}
                    onClick={() => {
                      setOpen(false);
                      setState(IDLE);
                    }}
                  >
                    <Icon name="close" size={14} />
                  </button>
                )}
              </header>
              {(state.phase === "starting" || state.phase === "packages") && (
                <p className="python-fine">{L(firstRunNote())}</p>
              )}
              <Output state={state} L={L} />
              {state.phase === "done" && state.result?.ok && !state.chunks.length && !state.figures.length && state.value === null && (
                <p className="python-note">{L("The code finished without printing anything.")}</p>
              )}
              <p className="python-fine python-honest">{L(HONEST_LINE)}</p>
            </>
          )}
        </section>
      )}
    </div>
  );
}

// Markdown components for replies: `pre` gains Run on Python blocks and
// hands every other block to `base` (Live Preview's, when it's on).
// `streaming` gives the same blocks without Run, for a reply still arriving.
export function usePythonRunner({ enabled, base, files }) {
  const filesRef = useRef(files);
  filesRef.current = files;
  return useMemo(() => {
    if (!enabled) return { components: base, streamingComponents: base };
    const BasePre = base?.pre;
    const make = (live) => ({
      ...(base || {}),
      pre: (props) => <RunnablePre {...props} base={BasePre} live={live} files={filesRef.current} />,
    });
    return { components: make(true), streamingComponents: make(false) };
  }, [enabled, base]);
}
