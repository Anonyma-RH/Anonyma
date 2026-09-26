import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Notice } from "./ui.jsx";
import { isReleased, streamChat, uid, download } from "./lib.js";
import { useLanguage } from "./i18n.js";
import { createVeilState, veil, unveil } from "./veil.js";
import { VeilToggle } from "./Veil.jsx";
import {
  PrivateModeToggle,
  NoPrivateModelsNotice,
  privateModeReleased,
} from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { pickPreset } from "./model-finder.js";
import { QUERY_SYSTEM, queryText, explainText } from "./sheets-spec.js";
import {
  MAX_BYTES,
  SAMPLE_NAME,
  chartSeries,
  describeSpec,
  displayCell,
  explainPayload,
  formatCompact,
  formatNumber,
  niceTicks,
  planQuery,
  queryPayload,
  realizeSpec,
  sampleSheetCSV,
  sheetKind,
  toCSV,
} from "./sheets.js";
import { createSheetEngine, tooLarge } from "./sheets-engine.js";
import "./sheets.css";

// Local Sheets: ask questions about a spreadsheet that never leaves this
// device. The file is read and calculated in a Web Worker; a model only
// plans the calculation from the sheet's profile (see src/sheets.js), and
// nothing about a session is saved on the server or in this browser.

const TYPE_LABELS = {
  number: "Number",
  date: "Date",
  text: "Text",
  boolean: "True/false",
};
const ACCEPT =
  ".csv,.tsv,.txt,.json,text/csv,text/tab-separated-values,application/json";
const TABLE_ROWS = 200;
const credits = (receipts) =>
  receipts.reduce((sum, r) => sum + (Number(r?.credits_charged) || 0), 0);
const slug = (s) =>
  String(s || "sheet-result")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "sheet-result";

export default function Sheets({
  demo,
  user,
  models,
  config,
  refresh,
  veilOn,
  setVeilOn,
  veilWords,
}) {
  const lang = useLanguage();
  const [sheet, setSheet] = useState(null),
    [loading, setLoading] = useState(false),
    [loadError, setLoadError] = useState(""),
    [dragging, setDragging] = useState(false),
    [question, setQuestion] = useState(""),
    [shareSamples, setShareSamples] = useState(false),
    [privateOn, setPrivateOn] = useState(false),
    [model, setModel] = useState(""),
    [results, setResults] = useState([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const engine = useRef(null),
    controller = useRef(null),
    fileInput = useRef(null),
    mounted = useRef(true),
    // Veil's placeholders for this sheet, in memory only.
    veilState = useRef(createVeilState());
  const live = !demo && !!user;
  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && !demo && (veilOn || privateOn);
  const privateLive = privateModeReleased(config);
  const uncensored = config?.releases?.uncensoredModels || [];
  const choices = useMemo(
    () =>
      models.filter(
        (m) =>
          m.type === "chat" &&
          m.callable &&
          !m.imageCapable &&
          !m.sealed &&
          !uncensored.includes(m.id) &&
          (!privateOn || m.private),
      ),
    [models, privateOn, config],
  );
  useEffect(() => {
    setModel((prev) =>
      choices.some((m) => m.id === prev)
        ? prev
        : pickPreset(choices, "balanced", { mode: "chat" })?.id ||
          choices[0]?.id ||
          "",
    );
  }, [choices]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      engine.current?.close();
    };
  }, []);

  // What the model is sent with a question, as the "What the AI sees"
  // preview shows it. Masked with a copy of Veil's state, so typing doesn't
  // add placeholders; sending uses the real state and gives the same ones.
  const preview = useMemo(() => {
    if (!sheet) return "";
    const copy = structuredClone(veilState.current);
    const mask = veiling ? (s) => veil(s, copy, veilWords).text : (s) => s;
    const { payload } = queryPayload(sheet.profile, question.trim() || "…", {
      samples: shareSamples ? sheet.samples : null,
      mask,
    });
    return queryText(payload);
  }, [sheet, question, shareSamples, veiling, veilWords]);
  const seedHit = useSeedScan(live && seedGuardLive(config), preview);

  async function open(source) {
    if (busy || loading) return;
    setLoadError("");
    if (source.file) {
      if (sheetKind(source.file.name) === "workbook") {
        setLoadError(
          "Sheets reads CSV, TSV and JSON files. Save the workbook as CSV first.",
        );
        return;
      }
      if (source.file.size > MAX_BYTES) {
        setLoadError(tooLarge());
        return;
      }
    }
    setLoading(true);
    engine.current?.close();
    const next = createSheetEngine();
    engine.current = next;
    try {
      const loaded = await next.load(source);
      if (!mounted.current || engine.current !== next) return;
      veilState.current = createVeilState();
      setSheet(loaded);
      setResults([]);
      setShareSamples(false);
      setError("");
    } catch (e) {
      if (engine.current === next) {
        next.close();
        engine.current = null;
        setSheet(null);
      }
      if (mounted.current) setLoadError(e.message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }
  function closeSheet() {
    controller.current?.abort();
    engine.current?.close();
    engine.current = null;
    veilState.current = createVeilState();
    setSheet(null);
    setResults([]);
    setQuestion("");
    setShareSamples(false);
    setError("");
    setLoadError("");
  }
  const update = (id, patch) => {
    if (mounted.current)
      setResults((prev) =>
        prev.map((r) =>
          r.id === id
            ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) }
            : r,
        ),
      );
  };
  // One model call through the normal chat billing path, off the record.
  async function callModel(payload, { signal, allowSeed, spent }) {
    let text = "",
      receipt = null,
      failure = null;
    await streamChat(
      {
        sheets: payload,
        model,
        ephemeral: true,
        requestId: uid(),
        ...(privateOn ? { private: true } : {}),
        ...(allowSeed ? { allow_seed_phrase: true } : {}),
      },
      (event) => {
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && text.length < 20000) text += delta;
        if (event.anonyma && Number.isFinite(event.anonyma.credits_charged)) {
          receipt = event.anonyma;
          spent.push(receipt);
        }
        if (event.error) failure = event.error;
      },
      signal,
    );
    if (failure) throw Error(failure.message || "The model request failed.");
    return { text, receipt };
  }
  const unmask = (s) =>
    typeof s === "string" ? unveil(s, veilState.current.map) : s;

  async function ask(e, { allowSeed = false } = {}) {
    e?.preventDefault();
    if (busy || !sheet || !question.trim() || (seedHit && !allowSeed)) return;
    if (!live) {
      setError(
        "Sign in to ask questions. Opening and reading a sheet works without an account.",
      );
      return;
    }
    if (!model) {
      setError(
        privateOn
          ? "No private models are available right now."
          : "No callable chat model is available.",
      );
      return;
    }
    setError("");
    setBusy(true);
    const ctl = new AbortController();
    controller.current = ctl;
    const mask = veiling
      ? (s) => veil(s, veilState.current, veilWords).text
      : (s) => s;
    const { payload, columns } = queryPayload(sheet.profile, question, {
      samples: shareSamples ? sheet.samples : null,
      mask,
    });
    const spent = [];
    const id = uid();
    const modelName = choices.find((m) => m.id === model)?.name || model;
    setResults((prev) => [
      {
        id,
        question: question.trim(),
        status: "planning",
        modelName,
        private: privateOn,
        veiled: veiling,
        samples: payload.samples?.length || 0,
        spent,
      },
      ...prev,
    ]);
    try {
      const plan = await planQuery({
        payload,
        columns,
        send: (p) => {
          if (p.task === "repair") update(id, { status: "repairing" });
          return callModel(p, {
            signal: ctl.signal,
            allowSeed: allowSeed && seedHit?.kind === "seed",
            spent,
          });
        },
      });
      if (plan.refusal) {
        update(id, {
          status: "refused",
          refusal: unmask(plan.refusal),
          spent: [...spent],
        });
        return;
      }
      if (plan.problems) {
        update(id, {
          status: "failed",
          error:
            "The model's plan still wasn't one Sheets can run after one retry. Try rephrasing the question, or choose another model.",
          problems: plan.problems.map(unmask),
          reply: unmask(plan.text),
          spent: [...spent],
        });
        return;
      }
      const spec = realizeSpec(plan.spec, unmask);
      update(id, { status: "calculating", spent: [...spent] });
      const result = await engine.current.run(spec);
      update(id, {
        status: "done",
        spec,
        result,
        title: spec.title || question.trim(),
        reply: unmask(plan.text),
        spent: [...spent],
      });
    } catch (err) {
      const stopped = err.name === "AbortError";
      update(id, {
        status: stopped ? "stopped" : "failed",
        error: stopped
          ? "Stopped. If the model had already started, that part may be charged; check your activity."
          : err.message,
        spent: [...spent],
      });
    } finally {
      if (controller.current === ctl) controller.current = null;
      if (mounted.current) setBusy(false);
      refresh?.();
    }
  }

  async function explain(item) {
    if (busy || !["confirm", "failed"].includes(item.explain?.status)) return;
    setBusy(true);
    const ctl = new AbortController();
    controller.current = ctl;
    const spent = [];
    update(item.id, (r) => ({ explain: { ...r.explain, status: "sending" } }));
    try {
      const { text } = await callModel(item.explain.payload, {
        signal: ctl.signal,
        allowSeed: false,
        spent,
      });
      update(item.id, (r) => ({
        explain: {
          ...r.explain,
          status: "done",
          text: unmask(text.trim()) || "The model returned no text.",
        },
        spent: [...r.spent, ...spent],
      }));
    } catch (err) {
      update(item.id, (r) => ({
        explain: {
          ...r.explain,
          status: "failed",
          error: err.name === "AbortError" ? "Stopped." : err.message,
        },
        spent: [...r.spent, ...spent],
      }));
    } finally {
      if (controller.current === ctl) controller.current = null;
      if (mounted.current) setBusy(false);
      refresh?.();
    }
  }
  function confirmExplain(item) {
    const mask = veiling
      ? (s) => veil(s, veilState.current, veilWords).text
      : (s) => s;
    const payload = explainPayload(item.result, item.question, item.title, {
      mask,
    });
    update(item.id, { explain: { status: "confirm", payload } });
  }

  const sessionCredits = results.reduce(
    (sum, r) => sum + credits(r.spent || []),
    0,
  );
  const noPrivate = privateOn && !choices.length;

  return (
    <section className="sheets-page">
      <div className="sheets-head">
        <div>
          <p className="eyebrow">YOUR SPREADSHEET STAYS ON THIS DEVICE</p>
          <h1>Sheets</h1>
          <p>
            Ask questions about a spreadsheet. The file never leaves your
            device; the AI only sees the column names.
          </p>
        </div>
        {sheet && (
          <button
            type="button"
            className="sheets-secondary"
            disabled={busy || loading}
            onClick={() => fileInput.current?.click()}
          >
            <Icon name="upload" size={15} />
            Open another file
          </button>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        accept={ACCEPT}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) open({ file, name: file.name });
        }}
      />
      {!sheet ? (
        <>
          <div
            className={"sheets-drop" + (dragging ? " dragging" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files?.[0];
              if (file) open({ file, name: file.name });
            }}
          >
            <span className="sheets-drop-icon" aria-hidden="true">
              <Icon name="sheet" size={26} />
            </span>
            <h2>
              {loading ? "Reading your sheet…" : "Drop a CSV, TSV or JSON file"}
            </h2>
            <p>
              Read in this browser only, up to 50 MB and 500,000 rows. Nothing
              is uploaded.
            </p>
            <div className="sheets-drop-actions">
              <button
                type="button"
                className="button"
                disabled={loading}
                onClick={() => fileInput.current?.click()}
              >
                Choose a file
              </button>
              <button
                type="button"
                className="sheets-secondary"
                disabled={loading}
                onClick={() =>
                  open({ text: sampleSheetCSV(), name: SAMPLE_NAME })
                }
              >
                Try a sample sheet
              </button>
            </div>
            <small>
              The sample is made-up shop sales, generated in your browser.
            </small>
          </div>
          {loadError && <Notice type="error">{loadError}</Notice>}
          <ul className="sheets-promises">
            <li>
              <b>Stays here</b>
              <span>
                Your browser reads the file. It isn't uploaded, saved or kept
                after you close it.
              </span>
            </li>
            <li>
              <b>The AI sees the shape</b>
              <span>
                Column names and types, the row count and how many different
                values each text column has.
              </span>
            </li>
            <li>
              <b>Calculated here</b>
              <span>
                The AI answers with a query plan, not code. Your device runs it
                on every row.
              </span>
            </li>
          </ul>
        </>
      ) : (
        <>
          {loadError && <Notice type="error">{loadError}</Notice>}
          <div className="sheets-bar">
            <span className="sheets-bar-icon" aria-hidden="true">
              <Icon name="sheet" size={18} />
            </span>
            <div className="sheets-bar-name">
              <b data-i18n="off">{sheet.name}</b>
              <small>
                {`${sheet.profile.rows.toLocaleString("en-US")} ${sheet.profile.rows === 1 ? "row" : "rows"} · ${
                  sheet.profile.columns.length
                } ${sheet.profile.columns.length === 1 ? "column" : "columns"} · Read on this device`}
              </small>
            </div>
            <button
              type="button"
              className="sheets-secondary"
              disabled={loading}
              onClick={closeSheet}
            >
              <Icon name="close" size={15} />
              Close sheet
            </button>
          </div>
          {sheet.warnings.map((w) => (
            <Notice key={w.key}>
              {w.key === "extra"
                ? w.count === 1
                  ? "1 row had more cells than there are columns; the extra cells were left out."
                  : `${w.count.toLocaleString("en-US")} rows had more cells than there are columns; the extra cells were left out.`
                : "The file ended inside a quoted value, so its last value may be cut short."}
            </Notice>
          ))}
          <div className="sheets-grid">
            <div className="sheets-main">
              <details
                className="sheets-columns"
                open={sheet.profile.columns.length <= 12}
              >
                <summary>
                  Columns <span>{sheet.profile.columns.length}</span>
                </summary>
                <ul>
                  {sheet.profile.columns.map((c) => (
                    <li key={c.name}>
                      <b data-i18n="off">{c.name}</b>
                      <span className="sheets-type">{TYPE_LABELS[c.type]}</span>
                      {c.type === "text" && (
                        <small>
                          {c.distinct === 1
                            ? "1 different value"
                            : `${c.distinct.toLocaleString("en-US")} different values`}
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
              <form className="sheets-ask" onSubmit={ask}>
                <label htmlFor="sheets-question">
                  Ask a question about this sheet
                </label>
                <textarea
                  id="sheets-question"
                  rows={3}
                  value={question}
                  maxLength={2000}
                  disabled={busy}
                  placeholder="For example: which region had the most revenue?"
                  onChange={(e) => setQuestion(e.target.value)}
                  onKeyDown={(e) => {
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    )
                      ask(e);
                  }}
                />
                <div className="sheets-controls">
                  <label className="sheets-model">
                    Model
                    <select
                      value={model}
                      disabled={busy || !choices.length}
                      onChange={(e) => setModel(e.target.value)}
                    >
                      {choices.map((m) => (
                        <option key={m.id} value={m.id} data-i18n="off">
                          {m.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {live && privateLive && (
                    <PrivateModeToggle
                      active={privateOn}
                      disabled={busy}
                      onToggle={() => {
                        setPrivateOn((on) => !on);
                        if (!privateOn && veilLive) setVeilOn(true);
                      }}
                    />
                  )}
                  {live && veilLive && (
                    <VeilToggle
                      on={veilOn || privateOn}
                      onToggle={() => {
                        if (!busy && !privateOn) setVeilOn((v) => !v);
                      }}
                    />
                  )}
                </div>
                {noPrivate && <NoPrivateModelsNotice />}
                <label className="sheets-check">
                  <input
                    type="checkbox"
                    checked={shareSamples}
                    disabled={busy}
                    onChange={(e) => setShareSamples(e.target.checked)}
                  />
                  <span>
                    <b>
                      {sheet.samples.length === 1
                        ? "Also share 1 sample row"
                        : `Also share ${sheet.samples.length} sample rows`}
                    </b>
                    <small>
                      Off by default. When on, exactly these rows go with each
                      question, so the model can see what values look like.
                    </small>
                  </span>
                </label>
                {shareSamples && (
                  <div className="sheets-table-wrap sheets-samples">
                    <table className="sheets-table" data-i18n="off">
                      <thead>
                        <tr>
                          {sheet.profile.columns.map((c) => (
                            <th key={c.name}>{c.name}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sheet.samples.map((row, i) => (
                          <tr key={i}>
                            {row.map((cell, j) => (
                              <td key={j}>{cell}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <SeedGuardNotice
                  hit={seedHit}
                  busy={busy}
                  onProceed={() => ask(null, { allowSeed: true })}
                />
                {error && <Notice type="error">{error}</Notice>}
                <div className="sheets-actions">
                  <button
                    className="button"
                    type="submit"
                    disabled={
                      !live ||
                      busy ||
                      !question.trim() ||
                      !!seedHit ||
                      noPrivate ||
                      !model
                    }
                  >
                    Ask
                  </button>
                  {busy && (
                    <button
                      type="button"
                      className="sheets-secondary"
                      onClick={() => controller.current?.abort()}
                    >
                      Stop
                    </button>
                  )}
                  <small>
                    {live
                      ? "Each question is one short message on your balance, two if the first plan needs fixing. Nothing is saved."
                      : "Sign in to ask questions. Opening and reading a sheet works without an account."}
                  </small>
                </div>
              </form>
              {results.length > 0 && (
                <div className="sheets-results" aria-live="polite">
                  <div className="sheets-results-head">
                    <h2>Answers</h2>
                    <small>
                      <span>{`${sessionCredits.toLocaleString("en-US", { maximumFractionDigits: 3 })} credits this session`}</span>
                      <span>
                        Kept in this tab only, gone when you close the sheet or
                        leave
                      </span>
                    </small>
                  </div>
                  {results.map((r) => (
                    <SheetResult
                      key={r.id}
                      item={r}
                      columns={sheet.profile.columns}
                      lang={lang}
                      busy={busy}
                      live={live}
                      onExplain={() => confirmExplain(r)}
                      onSendExplain={() => explain(r)}
                      onCancelExplain={() => update(r.id, { explain: null })}
                      onRemove={() =>
                        setResults((prev) => prev.filter((x) => x.id !== r.id))
                      }
                    />
                  ))}
                </div>
              )}
            </div>
            <aside className="sheets-sees" aria-label="What the AI sees">
              <h2>
                <Icon name="eye" size={16} />
                What the AI sees
              </h2>
              <p>
                Exactly this goes with each question, plus ANONYMA's fixed
                instructions for the plan format. Nothing else from your file.
              </p>
              <pre data-i18n="off">{preview}</pre>
              {veiling && (
                <p className="sheets-note">
                  Veil is on: details it recognises are masked before sending,
                  as shown.
                </p>
              )}
              <details>
                <summary>Show the fixed instructions</summary>
                <pre data-i18n="off">{QUERY_SYSTEM}</pre>
              </details>
            </aside>
          </div>
        </>
      )}
    </section>
  );
}

const STATUS = {
  planning: "Asking the model for a plan…",
  repairing: "Asking the model to fix its plan…",
  calculating: "Calculating on this device…",
  done: "Calculated on this device",
  refused: "Couldn't answer",
  failed: "Couldn't answer",
  stopped: "Stopped",
};

function SheetResult({
  item,
  columns,
  lang,
  busy,
  live,
  onExplain,
  onSendExplain,
  onCancelExplain,
  onRemove,
}) {
  const chartRef = useRef(null);
  const series = useMemo(
    () => (item.result ? chartSeries(item.result, item.spec.chart) : null),
    [item.result, item.spec],
  );
  const how = useMemo(
    () =>
      item.result
        ? describeSpec(item.spec, columns, item.result.stats, lang)
        : [],
    [item.result, item.spec, columns, lang],
  );
  const charged = credits(item.spent || []);
  const localTest = (item.spent || []).some((r) => r?.local_test);
  const name = slug(item.title);
  const svgText = () => {
    const svg = chartRef.current;
    if (!svg) return null;
    const copy = svg.cloneNode(true);
    copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    return new XMLSerializer().serializeToString(copy);
  };
  const savePNG = () => {
    const text = svgText();
    if (!text) return;
    const url = URL.createObjectURL(
      new Blob([text], { type: "image/svg+xml" }),
    );
    const img = new Image();
    img.onload = () => {
      const [, , w, h] = chartRef.current
        .getAttribute("viewBox")
        .split(" ")
        .map(Number);
      const canvas = document.createElement("canvas");
      canvas.width = w * 2;
      canvas.height = h * 2;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(url);
      canvas.toBlob(
        (blob) => blob && download(`${name}.png`, blob, "image/png"),
        "image/png",
      );
    };
    img.onerror = () => URL.revokeObjectURL(url);
    img.src = url;
  };
  const running = ["planning", "repairing", "calculating"].includes(
    item.status,
  );
  return (
    <article className={"sheets-result" + (running ? " running" : "")}>
      <header>
        <p className="sheets-result-q" data-i18n="off">
          {item.question}
        </p>
        <span className={"sheets-status " + item.status}>
          {STATUS[item.status]}
        </span>
      </header>
      {item.status === "done" && (
        <>
          {/* A chart carries the title itself, so an exported image has it. */}
          {!(series && series.points.length > 0) && (
            <h3 data-i18n="off">{item.title}</h3>
          )}
          {series && series.points.length > 0 && (
            <div className="sheets-chart" data-i18n="off">
              <SheetChart
                series={series}
                title={item.title}
                svgRef={chartRef}
                lang={lang}
              />
              {series.hidden > 0 && (
                <small>
                  {series.hidden === 1
                    ? "1 more row is in the table but not the chart."
                    : `${series.hidden.toLocaleString("en-US")} more rows are in the table but not the chart.`}
                </small>
              )}
            </div>
          )}
          <ResultTable result={item.result} />
          <section className="sheets-how">
            <h4>How this was calculated</h4>
            <ol data-i18n="off">
              {how.map((line, i) => (
                <li key={i}>
                  {line.map((part, j) =>
                    typeof part === "string" ? (
                      <React.Fragment key={j}>{part}</React.Fragment>
                    ) : (
                      <b key={j}>{part.v}</b>
                    ),
                  )}
                </li>
              ))}
            </ol>
            <details>
              <summary>The plan the model returned</summary>
              <pre data-i18n="off">{item.reply}</pre>
            </details>
          </section>
          <div className="sheets-actions">
            <button
              type="button"
              className="sheets-secondary"
              onClick={() =>
                download(
                  `${name}.csv`,
                  toCSV(item.result),
                  "text/csv;charset=utf-8",
                )
              }
            >
              <Icon name="download" size={15} />
              Download CSV
            </button>
            {series && series.points.length > 0 && (
              <>
                <button
                  type="button"
                  className="sheets-secondary"
                  onClick={() => {
                    const text = svgText();
                    if (text) download(`${name}.svg`, text, "image/svg+xml");
                  }}
                >
                  <Icon name="download" size={15} />
                  Download SVG
                </button>
                <button
                  type="button"
                  className="sheets-secondary"
                  onClick={savePNG}
                >
                  <Icon name="download" size={15} />
                  Download PNG
                </button>
              </>
            )}
            {live && !item.explain && item.result.rows.length > 0 && (
              <button
                type="button"
                className="sheets-secondary"
                disabled={busy}
                onClick={onExplain}
              >
                <Icon name="chat" size={15} />
                Explain this result
              </button>
            )}
          </div>
          {item.explain && (
            <ExplainPanel
              explain={item.explain}
              busy={busy}
              onSend={onSendExplain}
              onCancel={onCancelExplain}
            />
          )}
        </>
      )}
      {item.status === "refused" && (
        <Notice>
          The model says these columns can't answer this:{" "}
          <span data-i18n="off">{item.refusal}</span>
        </Notice>
      )}
      {(item.status === "failed" || item.status === "stopped") && (
        <>
          <Notice type="error">{item.error}</Notice>
          {item.problems?.length > 0 && (
            <details className="sheets-problems">
              <summary>What was wrong with the plan</summary>
              <ul data-i18n="off">
                {item.problems.map((p, i) => (
                  <li key={i}>{p}</li>
                ))}
              </ul>
              {item.reply && <pre data-i18n="off">{item.reply}</pre>}
            </details>
          )}
        </>
      )}
      <footer>
        <span data-i18n="off">{item.modelName}</span>
        <span>{`${charged.toLocaleString("en-US", { maximumFractionDigits: 3 })} credits`}</span>
        {localTest && <span>Local test fixture</span>}
        {item.samples > 0 && (
          <span>
            {item.samples === 1
              ? "1 sample row shared"
              : `${item.samples} sample rows shared`}
          </span>
        )}
        {item.private && <span>Private: zero data retention</span>}
        {item.veiled && <span>Veil on</span>}
        <span>Not saved</span>
        {!running && (
          <button
            type="button"
            className="sheets-link"
            disabled={busy}
            onClick={onRemove}
          >
            Remove
          </button>
        )}
      </footer>
    </article>
  );
}

function ResultTable({ result }) {
  const shown = result.rows.slice(0, TABLE_ROWS);
  const numeric = result.columns.map((c) => c.type === "number");
  return (
    <>
      <div className="sheets-table-wrap">
        <table className="sheets-table" data-i18n="off">
          <thead>
            <tr>
              {result.columns.map((c, i) => (
                <th key={i} className={numeric[i] ? "num" : ""}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, i) => (
              <tr key={i}>
                {row.map((v, j) => (
                  <td
                    key={j}
                    className={
                      typeof v === "number" ? "num" : v === null ? "empty" : ""
                    }
                  >
                    {v === null ? "—" : displayCell(v)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!result.rows.length && <p className="sheets-note">No rows matched.</p>}
      {result.rows.length > TABLE_ROWS && (
        <p className="sheets-note">
          {`Showing ${TABLE_ROWS} of ${result.rows.length.toLocaleString("en-US")} rows here; the CSV has them all.`}
        </p>
      )}
    </>
  );
}

function ExplainPanel({ explain, busy, onSend, onCancel }) {
  const p = explain.payload;
  if (explain.status === "done")
    return (
      <div className="sheets-explain">
        <h4>Explanation</h4>
        <p data-i18n="off">{explain.text}</p>
        <small>
          Written by the model from the table only. Check it against the numbers
          above.
        </small>
      </div>
    );
  return (
    <div className="sheets-explain">
      <h4>Explain this result</h4>
      <p>
        {p.result.rows.length === 1
          ? "Only this is sent: your question, the result's title and this 1-row table."
          : `Only this is sent: your question, the result's title and this ${p.result.rows.length}-row table.`}
      </p>
      <pre data-i18n="off">{explainText(p)}</pre>
      {explain.status === "failed" && (
        <Notice type="error">{explain.error}</Notice>
      )}
      <div className="sheets-actions">
        <button
          type="button"
          className="button"
          disabled={busy}
          onClick={onSend}
        >
          {explain.status === "sending"
            ? "Explaining…"
            : "Send for an explanation"}
        </button>
        <button
          type="button"
          className="sheets-secondary"
          disabled={explain.status === "sending"}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---- The chart: plain SVG in the house colours ----

const COBALT = "#0135df",
  DEEP = "#061b69",
  YELLOW = "#ffb21c",
  INK = "#142343",
  MUTED = "#68748a",
  LINE = "#e3e8f0";
const PIE = [
  COBALT,
  YELLOW,
  DEEP,
  "#6f8ff0",
  "#ffd27a",
  "#3a5ce8",
  "#b8c7fb",
  "#c98a0b",
  "#9aa9d6",
  "#ffe7b0",
  "#2a3f8f",
  "#dfe6ff",
];
const FONT = "Inter, system-ui, -apple-system, 'Segoe UI', sans-serif";
const clipLabel = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// "Total Revenue by Region", or its Chinese form, under the chart's title.
// Left out when the title already says it.
const subtitle = (series, lang, title = "") => {
  const text =
    lang === "zh"
      ? `${series.y}（按 ${series.x}）`
      : `${series.y} by ${series.x}`;
  return title.trim().toLowerCase() ===
    `${series.y} by ${series.x}`.toLowerCase()
    ? ""
    : clipLabel(text, 100);
};
// A phone-width chart is drawn on a narrower canvas, so its text stays legible.
function useNarrow() {
  const query =
    typeof window !== "undefined" && window.matchMedia
      ? window.matchMedia("(max-width: 600px)")
      : null;
  const [narrow, setNarrow] = useState(() => !!query?.matches);
  useEffect(() => {
    if (!query) return;
    const on = () => setNarrow(query.matches);
    query.addEventListener?.("change", on);
    return () => query.removeEventListener?.("change", on);
  }, []);
  return narrow;
}
export function SheetChart({ series, title, svgRef, lang = "en" }) {
  const narrow = useNarrow();
  const { type, points } = series;
  if (type === "pie")
    return (
      <PieChart
        series={series}
        title={title}
        svgRef={svgRef}
        lang={lang}
        narrow={narrow}
      />
    );
  const horizontal =
    type === "bar" &&
    (points.length > (narrow ? 6 : 12) ||
      points.some((p) => p.label.length > (narrow ? 8 : 14)));
  if (horizontal)
    return (
      <HorizontalBars
        series={series}
        title={title}
        svgRef={svgRef}
        lang={lang}
        narrow={narrow}
      />
    );
  const W = narrow ? 400 : 720,
    H = narrow ? 300 : 380,
    left = narrow ? 44 : 64,
    right = 20,
    top = 52,
    bottom = narrow ? 44 : 48;
  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...values), Math.max(...values));
  const lo = ticks[0],
    hi = ticks.at(-1);
  const y = (v) => top + (H - top - bottom) * (1 - (v - lo) / (hi - lo || 1));
  const band = (W - left - right) / points.length;
  const x = (i) => left + band * i + band / 2;
  const every = Math.max(1, Math.ceil(points.length / (narrow ? 6 : 12)));
  const maxAt = values.indexOf(Math.max(...values));
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={title}
      fontFamily={FONT}
      className="sheets-svg"
    >
      <rect width={W} height={H} fill="#fff" />
      <text
        x={narrow ? 12 : left}
        y={26}
        fontSize="15"
        fontWeight="600"
        fill={INK}
      >
        {clipLabel(title, narrow ? 44 : 80)}
      </text>
      <text x={narrow ? 12 : left} y={42} fontSize="11" fill={MUTED}>
        {subtitle(series, lang, title)}
      </text>
      {ticks.map((t) => (
        <g key={t}>
          <line
            x1={left}
            x2={W - right}
            y1={y(t)}
            y2={y(t)}
            stroke={t === 0 ? "#c9d2e1" : LINE}
            strokeWidth="1"
          />
          <text
            x={left - 8}
            y={y(t) + 4}
            fontSize="11"
            fill={MUTED}
            textAnchor="end"
          >
            {formatCompact(t)}
          </text>
        </g>
      ))}
      {type === "line" ? (
        <>
          <path
            d={`M${x(0)},${y(Math.max(lo, 0))} ${points.map((p, i) => `L${x(i)},${y(p.value)}`).join(" ")} L${x(points.length - 1)},${y(Math.max(lo, 0))} Z`}
            fill={COBALT}
            fillOpacity="0.08"
          />
          <polyline
            points={points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ")}
            fill="none"
            stroke={COBALT}
            strokeWidth="2.5"
            strokeLinejoin="round"
          />
          {points.map((p, i) => (
            <circle
              key={i}
              cx={x(i)}
              cy={y(p.value)}
              r="4"
              fill={i === maxAt ? YELLOW : "#fff"}
              stroke={COBALT}
              strokeWidth="2"
            />
          ))}
        </>
      ) : (
        points.map((p, i) => {
          const w = Math.min(64, band * 0.62);
          const y0 = y(Math.max(lo, 0)),
            y1 = y(p.value);
          return (
            <g key={i}>
              <rect
                x={x(i) - w / 2}
                y={Math.min(y0, y1)}
                width={w}
                height={Math.max(1, Math.abs(y0 - y1))}
                fill={i === maxAt ? YELLOW : COBALT}
              />
              {points.length <= 16 && (
                <text
                  x={x(i)}
                  y={Math.min(y0, y1) - 6}
                  fontSize="11"
                  fontWeight="600"
                  fill={INK}
                  textAnchor="middle"
                >
                  {formatCompact(p.value)}
                </text>
              )}
            </g>
          );
        })
      )}
      {points.map((p, i) =>
        i % every === 0 ? (
          <text
            key={i}
            x={x(i)}
            y={H - bottom + 20}
            fontSize="11.5"
            fill={INK}
            textAnchor="middle"
          >
            {clipLabel(p.label, Math.max(4, Math.floor((band * every) / 7)))}
          </text>
        ) : null,
      )}
    </svg>
  );
}
function HorizontalBars({ series, title, svgRef, lang, narrow }) {
  const { points } = series;
  const W = narrow ? 400 : 720,
    row = 26,
    top = 58,
    left = narrow ? 118 : 180,
    right = narrow ? 48 : 64,
    H = top + points.length * row + 24;
  const values = points.map((p) => p.value);
  const ticks = niceTicks(Math.min(...values), Math.max(...values), 4);
  const lo = ticks[0],
    hi = ticks.at(-1);
  const x = (v) => left + (W - left - right) * ((v - lo) / (hi - lo || 1));
  const maxAt = values.indexOf(Math.max(...values));
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={title}
      fontFamily={FONT}
      className="sheets-svg"
    >
      <rect width={W} height={H} fill="#fff" />
      <text x={16} y={26} fontSize="15" fontWeight="600" fill={INK}>
        {clipLabel(title, 80)}
      </text>
      <text x={16} y={42} fontSize="11" fill={MUTED}>
        {subtitle(series, lang, title)}
      </text>
      {ticks.map((t) => (
        <line
          key={t}
          x1={x(t)}
          x2={x(t)}
          y1={top - 6}
          y2={H - 20}
          stroke={t === 0 ? "#c9d2e1" : LINE}
        />
      ))}
      {points.map((p, i) => {
        const x0 = x(Math.max(lo, 0)),
          x1 = x(p.value),
          yy = top + i * row;
        return (
          <g key={i}>
            <text
              x={left - 10}
              y={yy + 16}
              fontSize="11.5"
              fill={INK}
              textAnchor="end"
            >
              {clipLabel(p.label, narrow ? 16 : 26)}
            </text>
            <rect
              x={Math.min(x0, x1)}
              y={yy + 5}
              width={Math.max(1, Math.abs(x1 - x0))}
              height={row - 10}
              fill={i === maxAt ? YELLOW : COBALT}
            />
            <text
              x={Math.max(x0, x1) + 6}
              y={yy + 16}
              fontSize="11"
              fontWeight="600"
              fill={INK}
            >
              {formatCompact(p.value)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
function PieChart({ series, title, svgRef, lang, narrow }) {
  const { points } = series;
  // Side by side on a wide canvas; the legend under the ring on a narrow one.
  const W = narrow ? 400 : 720,
    r = narrow
      ? 100
      : Math.min(120, (Math.max(320, 90 + points.length * 24) - 100) / 2),
    H = narrow
      ? 60 + 2 * r + 30 + points.length * 24
      : Math.max(320, 90 + points.length * 24),
    cx = narrow ? W / 2 : 190,
    cy = narrow ? 60 + r : 60 + (H - 60) / 2 - 10,
    inner = r * 0.55,
    legendX = narrow ? 16 : 360,
    legendY = narrow ? 60 + 2 * r + 36 : 72,
    legendW = narrow ? W - 32 : 340;
  const total = points.reduce((s, p) => s + p.value, 0) || 1;
  let angle = -Math.PI / 2;
  const arc = (a0, a1) => {
    const large = a1 - a0 > Math.PI ? 1 : 0;
    const p = (rad, a) => `${cx + rad * Math.cos(a)},${cy + rad * Math.sin(a)}`;
    return `M${p(r, a0)} A${r},${r} 0 ${large} 1 ${p(r, a1)} L${p(inner, a1)} A${inner},${inner} 0 ${large} 0 ${p(inner, a0)} Z`;
  };
  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={title}
      fontFamily={FONT}
      className="sheets-svg"
    >
      <rect width={W} height={H} fill="#fff" />
      <text x={16} y={26} fontSize="15" fontWeight="600" fill={INK}>
        {clipLabel(title, 80)}
      </text>
      <text x={16} y={42} fontSize="11" fill={MUTED}>
        {subtitle(series, lang, title)}
      </text>
      {points.map((p, i) => {
        const a0 = angle,
          a1 = angle + (p.value / total) * Math.PI * 2 * 0.99999;
        angle = a0 + (p.value / total) * Math.PI * 2;
        return (
          <path
            key={i}
            d={arc(a0, a1)}
            fill={PIE[i % PIE.length]}
            stroke="#fff"
            strokeWidth="2"
          />
        );
      })}
      {points.map((p, i) => (
        <g key={i} transform={`translate(${legendX}, ${legendY + i * 24})`}>
          <rect width="12" height="12" y="-10" fill={PIE[i % PIE.length]} />
          <text x="20" fontSize="12" fill={INK}>
            {clipLabel(p.label, narrow ? 22 : 30)}
          </text>
          <text
            x={legendW}
            fontSize="12"
            fill={INK}
            textAnchor="end"
            fontWeight="600"
          >
            {formatNumber(p.value)} ·{" "}
            {Math.round((p.value / total) * 1000) / 10}%
          </text>
        </g>
      ))}
    </svg>
  );
}
