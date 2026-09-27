import React, { useEffect, useMemo, useRef, useState } from "react";
import remarkGfm from "remark-gfm";
import { Icon, Notice } from "./ui.jsx";
import { isReleased, streamChat, uid, download, copyText } from "./lib.js";
import { t } from "./i18n.js";
import { createVeilState, veil, unveil } from "./veil.js";
import { VeilToggle, veilRemarkPlugin } from "./Veil.jsx";
import {
  PrivateModeToggle,
  NoPrivateModelsNotice,
  privateModeReleased,
} from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { useShieldLive, shieldMarkdown, SentAsDataTag } from "./Shield.jsx";
import { scanText, cleanText, shieldSummary, summaryText } from "./shield.js";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { useCreditEstimate, CreditEstimate } from "./CreditEstimate.jsx";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import { pickPreset } from "./model-finder.js";
import { pdfText } from "./pdf-text.js";
import { extractOffice, browserInflate, textBytes } from "./file-formats.js";
import { DOCUMENT_ACCEPT, documentKind, extensionOf, formatBytes } from "./documents.js";
import {
  MAX_FILE_BYTES,
  MAX_TEXT_CHARS,
  buildHunks,
  changeLabel,
  changesMarkdown,
  compareTexts,
  fileStem,
  redlineHTML,
  whereLabel,
} from "./doc-compare.js";
import {
  COMPARE_SYSTEM,
  compareBudget,
  compareMessages,
  comparePayload,
  compareUserText,
} from "./compare-spec.js";
import "./compare.css";

// Document Compare: two versions of a document, compared in this browser.
// The files are read here (Documents' own extraction), diffed in a Web
// Worker (src/compare.worker.js) and shown as a redline; nothing is uploaded
// or kept once you leave. "Summarize changes" is the only thing that goes to
// a model: just the changed passages with a little context, previewed
// exactly first, off the record.

const SLOTS = { a: "Original", b: "Revised" };
const KIND_LABELS = { changed: "Changed", added: "Added", removed: "Removed", moved: "Moved" };
const STOPPED = "Stopped. If the model had already started, that part may be charged; check your activity.";
const TRUNCATED = "The model ran out of room before it finished, so this summary stops short. It's charged for what it wrote.";
const n = (v) => Number(v || 0).toLocaleString("en-US");

// A file's text, read in this browser the way Documents reads attachments.
async function readDocument(file, officeAllowed) {
  const name = file.name;
  const kind = documentKind(file);
  if (!kind || (kind === "office" && !officeAllowed))
    throw Error(`"${name}" isn't a document Compare can read. Try PDF, DOCX, TXT or MD.`);
  if (file.size > MAX_FILE_BYTES) throw Error(`"${name}" is larger than 25 MB.`);
  let text = "",
    pages = null,
    trimmed = false;
  if (kind === "pdf") {
    const r = await pdfText(await file.arrayBuffer());
    text = r.text;
    pages = r.pages;
    if (!text.trim()) throw Error(`No text found in "${name}". It may be a scanned image.`);
  } else if (kind === "office") {
    const r = await extractOffice(await file.arrayBuffer(), extensionOf(name).slice(1), browserInflate, {
      limit: MAX_TEXT_CHARS,
    });
    text = r.text;
    trimmed = r.truncated;
  } else {
    if (file.size > MAX_TEXT_CHARS * 4) throw Error(`The text in "${name}" is longer than 5 MB.`);
    try {
      text = textBytes(new Uint8Array(await file.arrayBuffer()));
    } catch {
      throw Error(`"${name}" isn't UTF-8 text.`);
    }
  }
  if (text.length > MAX_TEXT_CHARS) throw Error(`The text in "${name}" is longer than 5 MB.`);
  if (!text.trim()) throw Error(`No text found in "${name}".`);
  return { id: uid(), name, kind, size: file.size, pages, text, trimmed };
}

// The two texts, compared in a worker of their own (or on the page where
// workers aren't available). `cancel` stops a comparison nobody needs now.
function runCompare(a, b) {
  let worker = null;
  const message = { original: a.text, revised: b.text, kinds: { a: a.kind, b: b.kind } };
  const promise = new Promise((resolve, reject) => {
    try {
      worker = new Worker(new URL("./compare.worker.js", import.meta.url), { type: "module" });
    } catch {
      worker = null;
    }
    if (!worker) {
      setTimeout(() => {
        try {
          resolve(compareTexts(message.original, message.revised, { kinds: message.kinds }));
        } catch (e) {
          reject(e);
        }
      }, 0);
      return;
    }
    worker.onmessage = (e) => {
      worker.terminate();
      if (e.data?.error) reject(Error(e.data.error));
      else resolve(e.data.result);
    };
    worker.onerror = () => {
      worker.terminate();
      reject(Error("The comparison stopped. Try again, or try shorter documents."));
    };
    worker.postMessage({ id: 1, ...message });
  });
  return { promise, cancel: () => worker?.terminate() };
}

export default function Compare({ demo, user, models, config, refresh, veilOn, setVeilOn, veilWords }) {
  const [docs, setDocs] = useState({ a: null, b: null }),
    [reading, setReading] = useState({ a: false, b: false }),
    [errors, setErrors] = useState({ a: "", b: "" }),
    [dragging, setDragging] = useState(""),
    [result, setResult] = useState(null),
    [comparing, setComparing] = useState(false),
    [compareError, setCompareError] = useState(""),
    [hide, setHide] = useState(false),
    [current, setCurrent] = useState(0),
    [opened, setOpened] = useState(() => new Set()),
    [panel, setPanel] = useState("changes"),
    [model, setModel] = useState(""),
    [privateOn, setPrivateOn] = useState(false),
    [focus, setFocus] = useState(""),
    [step, setStep] = useState("idle"),
    [summary, setSummary] = useState(null),
    [copied, setCopied] = useState(false);
  const inputs = { a: useRef(null), b: useRef(null) };
  const controller = useRef(null),
    mounted = useRef(true),
    // Veil's placeholders for this pair of documents, in memory only.
    veilState = useRef(createVeilState());
  const live = !demo && !!user;
  const officeAllowed = isReleased(config, "files");
  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && !demo && (veilOn || privateOn);
  const privateLive = privateModeReleased(config);
  const shieldOn = useShieldLive(config);
  const trailLive = privacyTrailReleased(config);
  const busy = step === "sending";
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
        : pickPreset(choices, "balanced", { mode: "chat" })?.id || choices[0]?.id || "",
    );
  }, [choices]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
    };
  }, []);

  // Compare once both versions are in; a newer pair cancels the older run.
  useEffect(() => {
    controller.current?.abort();
    veilState.current = createVeilState();
    setSummary(null);
    setStep("idle");
    setResult(null);
    setCompareError("");
    if (!docs.a || !docs.b) return;
    setComparing(true);
    let active = true;
    const job = runCompare(docs.a, docs.b);
    job.promise.then(
      (r) => {
        if (!active) return;
        setResult(r);
        setCurrent(0);
        setOpened(new Set());
        setPanel("changes");
      },
      (e) => active && setCompareError(e.message),
    ).finally(() => active && setComparing(false));
    return () => {
      active = false;
      job.cancel();
    };
  }, [docs.a, docs.b]);

  async function readInto(slot, file) {
    if (!file || reading[slot] || busy) return;
    setErrors((e) => ({ ...e, [slot]: "" }));
    setReading((r) => ({ ...r, [slot]: true }));
    try {
      const doc = await readDocument(file, officeAllowed);
      if (mounted.current) setDocs((d) => ({ ...d, [slot]: doc }));
    } catch (e) {
      if (mounted.current) setErrors((x) => ({ ...x, [slot]: e.message || "This file couldn't be read." }));
    } finally {
      if (mounted.current) setReading((r) => ({ ...r, [slot]: false }));
    }
  }
  async function trySample() {
    const s = await import("./compare-sample.js");
    const doc = (name, text) => ({ id: uid(), name, kind: "text", size: new Blob([text]).size, pages: null, text, sample: true });
    setErrors({ a: "", b: "" });
    setDocs({ a: doc(s.SAMPLE_NAMES[0], s.SAMPLE_ORIGINAL), b: doc(s.SAMPLE_NAMES[1], s.SAMPLE_REVISED) });
  }

  const changes = result?.changes || [];
  const total = changes.length;
  const hunks = useMemo(() => (result ? buildHunks(result) : []), [result]);
  // Injection Shield: invisible characters are taken out of what's sent, as
  // for attachments, and the passages are checked for planted instructions.
  const clean = useMemo(
    () => (shieldOn ? (s) => cleanText(s, scanText(s, { phrases: false })) : (s) => s),
    [shieldOn],
  );
  const shield = useMemo(() => {
    if (!shieldOn || !hunks.length) return null;
    const text = hunks
      .flatMap((h) => [h.before, ...h.lines.map((l) => l.text), h.after])
      .filter(Boolean)
      .join("\n");
    return shieldSummary(scanText(text));
  }, [shieldOn, hunks]);
  // What "Summarize changes" sends, as the preview shows it. Masked with a
  // copy of Veil's state, so previewing doesn't add placeholders; sending
  // uses the real state and gives the same ones.
  const preview = useMemo(() => {
    if (!result || !total || !docs.a || !docs.b) return null;
    const copy = structuredClone(veilState.current);
    const mask = veiling ? (s) => veil(clean(s), copy, veilWords).text : clean;
    const payload = comparePayload({ hunks, total, original: docs.a.name, revised: docs.b.name, focus, mask });
    const text = compareUserText(payload);
    const docChars = payload.hunks.reduce(
      (sum, h) => sum + h.before.length + h.after.length + h.lines.reduce((s, l) => s + l.text.length, 0),
      0,
    );
    const share = (100 * docChars) / Math.max(1, result.chars.a + result.chars.b);
    return { payload, text, share };
  }, [result, hunks, total, docs.a, docs.b, focus, veiling, veilWords, clean]);
  const seedHit = useSeedScan(live && seedGuardLive(config) && step === "confirm", preview?.text || "");
  const chosen = choices.find((m) => m.id === model);
  const quote = useMemo(() => {
    if (step !== "confirm" || !live || !chosen || !preview || !isReleased(config, "estimates")) return null;
    const messages = compareMessages(preview.payload);
    return { model, messages, max_tokens: compareBudget(chosen, messages) };
  }, [step, live, chosen, preview, model, config]);
  const estimate = useCreditEstimate(quote);

  async function send({ allowSeed = false } = {}) {
    if (busy || !preview || !live || !model || (seedHit && !allowSeed)) return;
    const ctl = new AbortController();
    controller.current = ctl;
    let masked = 0;
    const mask = veiling
      ? (s) => {
          const r = veil(clean(s), veilState.current, veilWords);
          masked += r.count;
          return r.text;
        }
      : clean;
    const payload = comparePayload({
      hunks,
      total,
      original: docs.a.name,
      revised: docs.b.name,
      focus,
      mask,
    });
    const modelName = chosen?.name || model;
    const base = {
      modelName,
      private: privateOn,
      veiled: veiling ? masked : null,
      map: { ...veilState.current.map },
      sent: payload.hunks.length,
      total,
      text: "",
    };
    setSummary(base);
    setStep("sending");
    setPanel("ai");
    let text = "",
      receipt = null,
      failure = null;
    try {
      await streamChat(
        {
          compare: payload,
          model,
          ephemeral: true,
          requestId: uid(),
          ...(privateOn ? { private: true } : {}),
          ...(allowSeed && seedHit?.kind === "seed" ? { allow_seed_phrase: true } : {}),
          ...(trailLive ? { veil_masked: veiling ? masked : null } : {}),
        },
        (event) => {
          const delta = event.choices?.[0]?.delta?.content;
          if (typeof delta === "string" && text.length < 60000) {
            text += delta;
            if (mounted.current) setSummary((s) => (s ? { ...s, text } : s));
          }
          if (event.anonyma && Number.isFinite(event.anonyma.credits_charged)) receipt = event.anonyma;
          if (event.error) failure = event.error;
        },
        ctl.signal,
      );
      if (failure) throw Error(failure.message || "The model request failed.");
      if (!mounted.current) return;
      setSummary((s) => ({ ...s, text, receipt }));
      setStep("done");
    } catch (err) {
      if (!mounted.current) return;
      const stopped = err.name === "AbortError";
      setSummary((s) => ({ ...s, text, receipt, error: stopped ? STOPPED : err.message }));
      setStep(stopped ? "stopped" : "failed");
    } finally {
      if (controller.current === ctl) controller.current = null;
      refresh?.();
    }
  }

  function go(index) {
    if (!total) return;
    const i = (index + total) % total;
    setCurrent(i);
    requestAnimationFrame(() =>
      document.getElementById(`compare-change-${changes[i].id}`)?.scrollIntoView({ block: "center", behavior: "smooth" }),
    );
  }
  const stem = docs.a && docs.b ? `${fileStem(docs.a.name)}-vs-${fileStem(docs.b.name)}` : "compare";
  function exportRedline() {
    download(
      `${stem}-redline.html`,
      redlineHTML({ result, original: docs.a.name, revised: docs.b.name, label: t }),
      "text/html",
    );
  }
  function exportChanges() {
    const done = step === "done" && summary?.text;
    download(
      `${stem}-changes.md`,
      changesMarkdown({
        result,
        original: docs.a.name,
        revised: docs.b.name,
        label: t,
        summary: done ? { text: unveil(summary.text, summary.map), model: summary.modelName } : null,
      }),
      "text/markdown",
    );
  }

  const noPrivate = privateOn && !choices.length;
  const both = docs.a && docs.b;
  const slot = (id) => (
    <FileSlot
      key={id}
      side={id}
      label={SLOTS[id]}
      doc={docs[id]}
      reading={reading[id]}
      error={errors[id]}
      compact={!!result}
      dragging={dragging === id}
      disabled={busy}
      onDrag={(on) => setDragging(on ? id : "")}
      onFile={(file) => readInto(id, file)}
      onPick={() => inputs[id].current?.click()}
      onClear={() => setDocs((d) => ({ ...d, [id]: null }))}
    />
  );

  return (
    <section className="compare-page">
      <div className={"compare-head" + (result ? " compact" : "")}>
        <div>
          <p className="eyebrow">YOUR DOCUMENTS STAY ON THIS DEVICE</p>
          <h1>Compare</h1>
          <p>
            See every change between two versions of a document. Only the
            changed parts go to the AI, and only if you ask for a summary.
          </p>
        </div>
        {!both && (
          <button type="button" className="compare-secondary" disabled={busy} onClick={trySample}>
            <Icon name="diff" size={15} />
            Try a sample NDA
          </button>
        )}
      </div>
      {["a", "b"].map((id) => (
        <input
          key={id}
          ref={inputs[id]}
          type="file"
          hidden
          accept={officeAllowed ? DOCUMENT_ACCEPT : DOCUMENT_ACCEPT.replace(/,\.(docx|xlsx|pptx)/g, "")}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            readInto(id, file);
          }}
        />
      ))}
      <div className={"compare-files" + (result ? " compact" : "")}>
        {slot("a")}
        <button
          type="button"
          className="compare-swap"
          aria-label="Swap the original and the revised version"
          title="Swap the original and the revised version"
          disabled={busy || (!docs.a && !docs.b)}
          onClick={() => setDocs((d) => ({ a: d.b, b: d.a }))}
        >
          <Icon name="shuffle" size={15} />
        </button>
        {slot("b")}
      </div>
      {!both && (
        <ul className="compare-promises">
          <li>
            <b>Stays here</b>
            <span>Both files are read in this browser. They aren't uploaded, saved or kept after you leave.</span>
          </li>
          <li>
            <b>Every change</b>
            <span>A word-level redline, like track changes, with a change list. Moved paragraphs are spotted too.</span>
          </li>
          <li>
            <b>Only changes go out</b>
            <span>Ask for a summary and the AI gets only the changed passages, with a little context. You see exactly what's sent first.</span>
          </li>
        </ul>
      )}
      {comparing && <p className="compare-progress">Comparing on this device…</p>}
      {compareError && <Notice type="error">{compareError}</Notice>}
      {result && (
        <>
          {result.approximate && (
            <Notice>These versions are very long or very different, so parts of the comparison are coarser than word by word.</Notice>
          )}
          {[docs.a, docs.b].some((d) => d?.trimmed) && (
            <Notice>Only the first 5 MB of text in a file was read, so changes after that aren't shown.</Notice>
          )}
          <div className="compare-toolbar">
            <div className="compare-counts">
              {/* Numbers and words apart, so each word translates on its own. */}
              <b className="compare-total">
                <span>{n(total)}</span> <span>{total === 1 ? "change" : "changes"}</span>
              </b>
              {["changed", "added", "removed", "moved"].map(
                (k) =>
                  result.counts[k] > 0 && (
                    <span key={k} className={"compare-kind " + k}>
                      <span>{n(result.counts[k])}</span> <span>{k}</span>
                    </span>
                  ),
              )}
              {total > 0 && (
                <small title="Words added and removed">{`+${n(result.counts.wordsAdded)} / −${n(result.counts.wordsRemoved)} words`}</small>
              )}
            </div>
            <div className="compare-tools">
              {total > 0 && (
                <div className="compare-nav">
                  <button type="button" aria-label="Previous change" title="Previous change" onClick={() => go(current - 1)}>
                    <Icon name="up" size={15} />
                  </button>
                  <span>{`${current + 1} / ${n(total)}`}</span>
                  <button type="button" aria-label="Next change" title="Next change" onClick={() => go(current + 1)}>
                    <Icon name="down" size={15} />
                  </button>
                </div>
              )}
              <label className="compare-toggle">
                <input type="checkbox" checked={hide} onChange={(e) => setHide(e.target.checked)} />
                <span>Hide unchanged</span>
              </label>
              <button type="button" className="compare-secondary" title="Download the redline as a web page. Open it and print to PDF." onClick={exportRedline}>
                <Icon name="download" size={14} />
                Redline (HTML)
              </button>
              <button type="button" className="compare-secondary" title="Download the change list as Markdown" onClick={exportChanges}>
                <Icon name="download" size={14} />
                Changes (Markdown)
              </button>
            </div>
          </div>
          {total === 0 ? (
            <Notice>No differences found: the two versions have the same text. Spacing isn't compared.</Notice>
          ) : (
            <div className="compare-grid">
              <Redline
                result={result}
                hide={hide}
                opened={opened}
                current={changes[current]}
                onOpen={(k) => setOpened((s) => new Set(s).add(k))}
                onPick={(i) => setCurrent(i)}
              />
              <aside className="compare-side">
                <div className="compare-tabs" role="tablist">
                  <button type="button" role="tab" aria-selected={panel === "changes"} className={panel === "changes" ? "on" : ""} onClick={() => setPanel("changes")}>
                    Changes <span>{n(total)}</span>
                  </button>
                  <button type="button" role="tab" aria-selected={panel === "ai"} className={panel === "ai" ? "on" : ""} onClick={() => setPanel("ai")}>
                    <Icon name="eye" size={14} />
                    AI summary
                  </button>
                </div>
                {panel === "changes" ? (
                  <ol className="compare-list">
                    {changes.map((c, i) => (
                      <li key={c.id}>
                        <button type="button" className={i === current ? "current" : ""} onClick={() => go(i)}>
                          <span className="compare-list-top">
                            <span className={"compare-kind " + c.kind}>{KIND_LABELS[c.kind]}</span>
                            <span className="compare-where">{whereLabel(c)}</span>
                          </span>
                          <ChangeLabel label={changeLabel(result, c)} />
                        </button>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <div className="compare-ai">
                    {(step === "idle" || step === "confirm") && (
                      <>
                        <p className="compare-ai-lead">
                          {preview &&
                            (() => {
                              const share = preview.share < 1 ? "less than 1%" : `about ${Math.round(preview.share)}%`;
                              return preview.payload.hunks.length === 1
                                ? `The AI gets only the changed passage, with a little context: ${share} of the text in your two documents. Never the whole files.`
                                : `The AI gets only the ${n(preview.payload.hunks.length)} changed passages, each with a little context: ${share} of the text in your two documents. Never the whole files.`;
                            })()}
                        </p>
                        <label className="compare-field">
                          <span>
                            Anything to focus on? <small>Optional</small>
                          </span>
                          <input
                            value={focus}
                            maxLength={500}
                            disabled={busy}
                            placeholder="For example: I'm the receiving party"
                            onChange={(e) => setFocus(e.target.value)}
                          />
                        </label>
                        <div className="compare-controls">
                          <label className="compare-model">
                            Model
                            <select value={model} disabled={busy || !choices.length} onChange={(e) => setModel(e.target.value)}>
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
                        {step === "idle" && (
                          <div className="compare-actions">
                            <button
                              type="button"
                              className="button"
                              disabled={!live || !preview || !model || noPrivate}
                              onClick={() => {
                                setStep("confirm");
                                // The preview opens below: bring it and Send into view.
                                requestAnimationFrame(() =>
                                  document.querySelector(".compare-sees")?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
                                );
                              }}
                            >
                              Summarize changes…
                            </button>
                            <small>
                              {live
                                ? "You see exactly what's sent before anything goes. Billed as one message, off the record: nothing is saved."
                                : "Sign in to summarize. Comparing works without an account."}
                            </small>
                          </div>
                        )}
                      </>
                    )}
                    {step === "confirm" && preview && (
                      <div className="compare-sees">
                        <h3>
                          <Icon name="eye" size={15} />
                          What the AI sees
                        </h3>
                        <p>
                          {`Exactly these ${n(preview.text.length)} characters, from ${
                            preview.payload.hunks.length === preview.payload.total
                              ? preview.payload.total === 1
                                ? "the 1 change"
                                : `all ${n(preview.payload.total)} changes`
                              : `the first ${n(preview.payload.hunks.length)} of ${n(preview.payload.total)} changes`
                          }, plus ANONYMA's fixed instructions. Nothing else from your files.`}
                        </p>
                        <pre data-i18n="off">{preview.text}</pre>
                        {veiling && <p className="compare-note">Veil is on: details it recognises are masked before sending, as shown.</p>}
                        <p className="compare-note compare-data">
                          <SentAsDataTag />
                          {shield && !shield.clear ? (
                            <span>
                              {"Injection Shield: "}
                              {summaryText(shield)}
                            </span>
                          ) : (
                            <span>The passages are marked as data, not instructions.</span>
                          )}
                        </p>
                        <details>
                          <summary>Show the fixed instructions</summary>
                          <pre data-i18n="off">{COMPARE_SYSTEM}</pre>
                        </details>
                        <SeedGuardNotice hit={seedHit} busy={busy} onProceed={() => send({ allowSeed: true })} />
                        <div className="compare-actions">
                          <button type="button" className="button" disabled={!!seedHit || !model || noPrivate} onClick={() => send()}>
                            {`Send to ${chosen?.name || "the model"}`}
                          </button>
                          <button type="button" className="compare-secondary light" onClick={() => setStep("idle")}>
                            Cancel
                          </button>
                          {quote && <CreditEstimate state={estimate} />}
                        </div>
                        <small>Billed as one message, off the record: nothing is saved. Not legal advice.</small>
                      </div>
                    )}
                    {summary && step !== "idle" && step !== "confirm" && (
                      <SummaryCard
                        summary={summary}
                        step={step}
                        models={models}
                        shieldOn={shieldOn}
                        trailLive={trailLive}
                        receiptsLive={isReleased(config, "receipts")}
                        copied={copied}
                        onStop={() => controller.current?.abort()}
                        onCopy={async () => {
                          if (await copyText(unveil(summary.text, summary.map))) {
                            setCopied(true);
                            setTimeout(() => mounted.current && setCopied(false), 1500);
                          }
                        }}
                        onAgain={() => {
                          setSummary(null);
                          setStep("idle");
                        }}
                      />
                    )}
                  </div>
                )}
              </aside>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function FileSlot({ side, label, doc, reading, error, compact, dragging, disabled, onDrag, onFile, onPick, onClear }) {
  const meta = doc
    ? [doc.sample ? "Sample" : null, doc.pages ? (doc.pages === 1 ? "1 page" : `${n(doc.pages)} pages`) : null, formatBytes(doc.size)]
        .filter(Boolean)
        .join(" · ")
    : "";
  return (
    <div
      className={"compare-slot" + (doc ? " loaded" : "") + (dragging ? " dragging" : "") + (compact ? " compact" : "")}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) onDrag(true);
      }}
      onDragLeave={() => onDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        onDrag(false);
        if (!disabled) onFile(e.dataTransfer.files?.[0]);
      }}
    >
      <span className={"compare-slot-tag " + side}>{label}</span>
      {doc ? (
        <div className="compare-slot-file">
          <span className="compare-slot-icon" aria-hidden="true">
            <Icon name="file" size={16} />
          </span>
          <span className="compare-slot-name">
            <b data-i18n="off">{doc.name}</b>
            <small>{meta}</small>
          </span>
          <button type="button" className="compare-slot-change" disabled={disabled || reading} onClick={onPick}>
            Replace
          </button>
          <button type="button" className="compare-slot-clear" aria-label={`Remove ${doc.name}`} disabled={disabled} onClick={onClear}>
            <Icon name="close" size={13} />
          </button>
        </div>
      ) : (
        <div className="compare-slot-empty">
          <span className="compare-slot-icon" aria-hidden="true">
            <Icon name="upload" size={18} />
          </span>
          <b>{reading ? "Reading in this browser…" : side === "a" ? "Drop the original here" : "Drop the revised version here"}</b>
          <small>PDF, DOCX, TXT, MD and other text files, up to 25 MB</small>
          <button type="button" className="compare-secondary" disabled={disabled || reading} onClick={onPick}>
            Choose a file
          </button>
        </div>
      )}
      {error && <p className="compare-slot-error" role="alert">{error}</p>}
    </div>
  );
}

function ChangeLabel({ label }) {
  if (label.text) return <span className="compare-list-text" data-i18n="off">{label.text}</span>;
  return (
    <span className="compare-list-text" data-i18n="off">
      {label.del && <del>{label.del}</del>}
      {label.del && label.ins ? " → " : ""}
      {label.ins && <ins>{label.ins}</ins>}
    </span>
  );
}

// The redline: every paragraph in reading order, changes marked like track
// changes. Long unchanged stretches fold away in long documents, and all of
// them with "Hide unchanged"; a fold opens with a click.
function Redline({ result, hide, opened, current, onOpen, onPick }) {
  const { rows, a, b, changes, mode } = result;
  const starts = useMemo(() => new Map(changes.map((c, i) => [c.start, [c, i]])), [changes]);
  const items = useMemo(() => {
    const out = [];
    const long = rows.length > 1500;
    for (let k = 0; k < rows.length; ) {
      if (rows[k].t !== "same") {
        out.push({ k });
        k++;
        continue;
      }
      let e = k;
      while (e < rows.length && rows[e].t === "same") e++;
      const count = e - k;
      if (opened.has(k) || (!hide && !(long && count > 10))) for (let r = k; r < e; r++) out.push({ k: r });
      else if (hide) out.push({ gap: k, count });
      else {
        for (let r = k; r < k + 3; r++) out.push({ k: r });
        out.push({ gap: k, count: count - 6 });
        for (let r = e - 3; r < e; r++) out.push({ k: r });
      }
      k = e;
    }
    return out;
  }, [rows, hide, opened]);
  const unit = (count) =>
    mode === "sentences"
      ? count === 1
        ? "1 unchanged sentence"
        : `${n(count)} unchanged sentences`
      : count === 1
        ? "1 unchanged paragraph"
        : `${n(count)} unchanged paragraphs`;
  const inCurrent = (k) => current && k >= current.start && k <= current.end;
  const parts = (ps) =>
    ps.map(([op, text], i) => (op === -1 ? <del key={i}>{text}</del> : op === 1 ? <ins key={i}>{text}</ins> : <React.Fragment key={i}>{text}</React.Fragment>));
  return (
    <article className="compare-redline" aria-label="Redline">
      {items.map((item) =>
        item.gap !== undefined ? (
          <button key={"g" + item.gap} type="button" className="compare-gap" onClick={() => onOpen(item.gap)}>
            <span>{unit(item.count)}</span>
            <span className="compare-gap-show">Show</span>
          </button>
        ) : (
          (() => {
            const k = item.k,
              r = rows[k],
              start = starts.get(k);
            const num = r.t === "removed" || r.t === "moved-out" ? r.a + 1 : r.b + 1;
            return (
              <div
                key={k}
                id={start ? `compare-change-${start[0].id}` : undefined}
                className={"compare-row " + r.t + (inCurrent(k) ? " current" : "")}
                onClick={start || r.t !== "same" ? () => {
                  const found = changes.findIndex((c) => k >= c.start && k <= c.end);
                  if (found >= 0) onPick(found);
                } : undefined}
              >
                <span className="compare-gutter">
                  {start ? <span className="compare-badge">{start[0].id}</span> : null}
                  <span className="compare-num">{num}</span>
                </span>
                <div className="compare-text">
                  {r.t === "moved-out" && <span className="compare-move">{`Moved to ¶ ${rows[r.to].b + 1}`}</span>}
                  {r.t === "moved-in" && <span className="compare-move">{`Moved from ¶ ${r.a + 1}`}</span>}
                  <p data-i18n="off">
                    {r.t === "same"
                      ? b[r.b]
                      : r.t === "changed"
                        ? parts(r.parts)
                        : r.t === "added"
                          ? <ins>{b[r.b]}</ins>
                          : r.t === "removed"
                            ? <del>{a[r.a]}</del>
                            : r.t === "moved-out"
                              ? <s>{a[r.a]}</s>
                              : r.parts
                                ? parts(r.parts)
                                : b[r.b]}
                  </p>
                </div>
              </div>
            );
          })()
        ),
      )}
    </article>
  );
}

function SummaryCard({ summary, step, models, shieldOn, trailLive, receiptsLive, copied, onStop, onCopy, onAgain }) {
  const receipt = summary.receipt;
  const cut = receipt?.finish_reason === "length";
  return (
    <div className={"compare-summary" + (step === "sending" ? " running" : "")}>
      <header>
        <b>AI summary</b>
        <span data-i18n="off">{summary.modelName}</span>
      </header>
      <p className="compare-note">
        {summary.sent === summary.total
          ? summary.total === 1
            ? "Written from the 1 changed passage only. Not legal advice."
            : `Written from the ${n(summary.total)} changed passages only. Not legal advice.`
          : `Written from the first ${n(summary.sent)} of ${n(summary.total)} changed passages only. Not legal advice.`}
      </p>
      {summary.text ? (
        <div className="prose markdown" data-i18n="off">
          <ReplyMarkdown
            remarkPlugins={[remarkGfm, [veilRemarkPlugin, { map: summary.map }]]}
            components={shieldOn ? shieldMarkdown() : undefined}
          >
            {summary.text}
          </ReplyMarkdown>
        </div>
      ) : (
        step === "sending" && <p className="compare-progress">Waiting for the model…</p>
      )}
      {cut && <Notice>{TRUNCATED}</Notice>}
      {summary.error && <Notice type={step === "stopped" ? "" : "error"}>{summary.error}</Notice>}
      <footer>
        {step === "sending" ? (
          <button type="button" className="compare-secondary" onClick={onStop}>
            <Icon name="stop" size={13} />
            Stop
          </button>
        ) : (
          <>
            {summary.text && (
              <button type="button" className="compare-secondary" onClick={onCopy}>
                <Icon name={copied ? "check" : "copy"} size={13} />
                {copied ? "Copied" : "Copy"}
              </button>
            )}
            <button type="button" className="compare-secondary" onClick={onAgain}>
              <Icon name="refresh" size={13} />
              Summarize again
            </button>
          </>
        )}
        <small>
          {[
            receipt ? `${Number(receipt.credits_charged).toLocaleString("en-US", { maximumFractionDigits: 3 })} credits` : null,
            "Off the record: not saved",
            summary.private ? "Zero data retention" : null,
            summary.veiled ? (summary.veiled === 1 ? "1 detail masked" : `${n(summary.veiled)} details masked`) : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </small>
      </footer>
      {trailLive && receipt?.privacy && <PrivacyTrail privacy={receipt.privacy} models={models} receiptsLive={receiptsLive} />}
    </div>
  );
}
