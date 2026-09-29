import React, { memo, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import remarkGfm from "remark-gfm";
import { Icon, Notice } from "./ui.jsx";
import { api, ApiError, isReleased, spendingLimitMessage, uid, download } from "./lib.js";
import { readChatEvents } from "./stream.js";
import { getLanguage } from "./i18n.js";
import { createVeilState, veil, unveil } from "./veil.js";
import { VeilToggle, veilRemarkPlugin } from "./Veil.jsx";
import { PrivateModeToggle, NoPrivateModelsNotice, privateModeReleased } from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { useShieldLive, shieldMarkdown, SentAsDataTag } from "./Shield.jsx";
import { scanText, cleanText, shieldSummary, summaryText } from "./shield.js";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import { pickPreset } from "./model-finder.js";
import { formatCredits } from "./estimate.js";
import { extensionOf, formatBytes, MAX_FILE_BYTES } from "./documents.js";
import { browserInflate, textBytes } from "./file-formats.js";
import {
  MAX_DOC_CHARS,
  alignPart,
  buildDocx,
  fileStem,
  markdownBlocks,
  pdfBlocks,
  planParts,
  readDocx,
  translatedMarkdown,
  viewRows,
} from "./doc-translate.js";
import { LANGUAGES, LIMITS, languageOf, measure, parseGlossary, partUserText, pricedMessages, translateSystem } from "./translate-spec.js";
import "./translate.css";

// Translate Documents (update "doctranslate"): a whole document, translated
// a part at a time, shown side by side with the original and exported as
// DOCX, Markdown or PDF. The file is read in this browser (Documents' own
// readers, keeping headings, paragraphs, lists and tables) and never leaves
// it; only the parts' text goes to the model, through /api/translate
// (server/routes/translate.js), off the record. Nothing is kept once you
// leave unless you save the translation to Files yourself.

const ACCEPT = ".pdf,.docx,.txt,.md,.markdown";
const TONE_LABELS = { formal: "Formal", plain: "Plain" };
const n = (v) => Number(v || 0).toLocaleString("en-US");
const words = (text) => (String(text).match(/[\p{L}\p{N}]+/gu) || []).length;
const cjkChars = (text) => (String(text).match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length;
const STOP_WAIT = 5000;

// The language the page starts with: Chinese when the app is in Chinese,
// else the browser's own language when it isn't English, else Spanish.
function startLanguage() {
  if (getLanguage() === "zh") return "zh-CN";
  if (getLanguage() === "es") return "es";
  const nav = (typeof navigator !== "undefined" && navigator.language) || "";
  const exact = LANGUAGES.find((l) => l.code.toLowerCase() === nav.toLowerCase());
  const base = LANGUAGES.find((l) => l.code === nav.split("-")[0]);
  const pick = exact || base;
  return pick && pick.code !== "en" ? pick.code : "es";
}

// A file's blocks, read in this browser.
async function readFile(file, officeAllowed) {
  const name = file.name;
  const ext = extensionOf(name);
  if (![".pdf", ".docx", ".txt", ".md", ".markdown"].includes(ext) || (ext === ".docx" && !officeAllowed))
    throw Error(`"${name}" isn't a document Translate docs can read. Try PDF, DOCX, TXT or MD.`);
  if (file.size > MAX_FILE_BYTES) throw Error(`"${name}" is larger than 25 MB.`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  let blocks,
    pages = null,
    kind;
  if (ext === ".pdf") {
    const { pdfLayout } = await import("./pdf-text.js");
    const layout = await pdfLayout(bytes);
    pages = layout.count;
    blocks = pdfBlocks(layout.pages);
    kind = "PDF";
    if (!blocks.length) throw Error(`No text found in "${name}". It may be a scanned image; Local OCR can read images in chat.`);
  } else if (ext === ".docx") {
    blocks = await readDocx(bytes, browserInflate);
    kind = "DOCX";
  } else {
    let text;
    try {
      text = textBytes(bytes);
    } catch {
      throw Error(`"${name}" isn't UTF-8 text.`);
    }
    blocks = markdownBlocks(text);
    kind = ext === ".txt" ? "TXT" : "Markdown";
  }
  return { name, size: file.size, pages, kind, blocks };
}
// The document ready to translate: its blocks (long ones split) and parts.
function prepare(read) {
  const chars = read.blocks.reduce((sum, b) => sum + (b.send ? b.md.length : 0), 0);
  if (!chars) throw Error(`No text to translate in "${read.name}".`);
  if (chars > MAX_DOC_CHARS)
    throw Error(
      `"${read.name}" has more than ${n(MAX_DOC_CHARS)} characters of text (about 50 pages). Split it and translate it in parts.`,
    );
  const plan = planParts(read.blocks);
  if (plan.parts.length > LIMITS.parts)
    throw Error(`"${read.name}" splits into more than ${n(LIMITS.parts)} parts. Split it and translate it in parts.`);
  const text = plan.parts.map((p) => p.text).join("\n\n");
  // Chinese, Japanese and Korean count by character, as their readers do.
  const count = words(text.replace(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g, " ")) + cjkChars(text);
  return { ...read, id: uid(), blocks: plan.blocks, parts: plan.parts, words: count };
}

// A debounced /api/translate/quote for the parts Translate would send.
// Quoting sends only their sizes, and holds and charges nothing.
function useTranslateEstimate(body, tick) {
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
        const r = await api("/api/translate/quote", { method: "POST", body, signal: controller.signal });
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
const toneOf = (q) =>
  q?.available != null && q.credits > q.available
    ? "short"
    : q?.spending_limit?.remaining != null && q.credits > Number(q.spending_limit.remaining)
      ? "limited"
      : "ready";

// Runs /api/translate, handing each event to `onEvent`. Throws an ApiError
// for a refusal (nothing was held).
async function runTranslate(body, onEvent, signal) {
  let response;
  try {
    response = await fetch("/api/translate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    if (e.name === "AbortError") throw e;
    throw new ApiError("The service could not be reached. Please try again.");
  }
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
    let error;
    try {
      error = await response.json();
    } catch {}
    throw new ApiError(
      spendingLimitMessage(error) || error?.error?.message || "Translate docs is unavailable.",
      response.status,
      error?.error?.code,
      error,
    );
  }
  for await (const event of readChatEvents(response)) onEvent(event);
}
// A status line: each item its own element, so each translates on its own.
const Dots = ({ items }) =>
  items.filter(Boolean).map((t, k) => (
    <React.Fragment key={k}>
      {k > 0 && " · "}
      <span>{t}</span>
    </React.Fragment>
  ));
// UTF-8 text as base64, for saving to Files.
function base64(text) {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

export default function Translate({ demo, user, models, config, refresh, veilOn, setVeilOn, veilWords }) {
  const [doc, setDoc] = useState(null),
    [reading, setReading] = useState(false),
    [readError, setReadError] = useState(""),
    [dragging, setDragging] = useState(false),
    [target, setTarget] = useState(startLanguage),
    [tone, setTone] = useState("formal"),
    [glossaryText, setGlossaryText] = useState(""),
    [model, setModel] = useState(""),
    [privateOn, setPrivateOn] = useState(false),
    [results, setResults] = useState({}),
    [run, setRun] = useState(null),
    [runError, setRunError] = useState(""),
    [spent, setSpent] = useState(0),
    [summary, setSummary] = useState(null),
    [peek, setPeek] = useState(0),
    [save, setSave] = useState({ open: false, consent: false, busy: false, saved: "", error: "" }),
    [printing, setPrinting] = useState(false),
    [exporting, setExporting] = useState(""),
    [tick, setTick] = useState(0);
  const input = useRef(null),
    mounted = useRef(true),
    current = useRef(null);
  const live = !demo && !!user;
  const officeAllowed = isReleased(config, "files");
  const filesLive = isReleased(config, "files") && isReleased(config, "documents");
  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && !demo && (veilOn || privateOn);
  const privateLive = privateModeReleased(config);
  const shieldOn = useShieldLive(config);
  const trailLive = privacyTrailReleased(config);
  const busy = !!run;
  const lang = languageOf(target) || LANGUAGES[0];
  const uncensored = config?.releases?.uncensoredModels || [];
  const choices = useMemo(
    () =>
      models.filter(
        (m) => m.type === "chat" && m.callable && !m.imageCapable && !m.sealed && !uncensored.includes(m.id) && (!privateOn || m.private),
      ),
    [models, privateOn, config],
  );
  useEffect(() => {
    setModel((prev) =>
      choices.some((m) => m.id === prev) ? prev : pickPreset(choices, "balanced", { mode: "chat" })?.id || choices[0]?.id || "",
    );
  }, [choices]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.controller.abort();
    };
  }, []);
  const anyDone = Object.values(results).some((r) => r.status === "done");
  // A translation lives only on this page: say so before leaving it.
  useEffect(() => {
    if (!anyDone && !busy) return;
    const warn = (e) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [anyDone, busy]);

  function reset(next) {
    setDoc(next);
    setResults({});
    setSummary(null);
    setRunError("");
    setSpent(0);
    setPeek(0);
    setSave({ open: false, consent: false, busy: false, saved: "", error: "" });
  }
  async function readInto(file) {
    if (!file || reading || busy) return;
    setReadError("");
    setReading(true);
    try {
      const next = prepare(await readFile(file, officeAllowed));
      if (mounted.current) reset(next);
    } catch (e) {
      if (mounted.current) setReadError(e.message || "This file couldn't be read.");
    } finally {
      if (mounted.current) setReading(false);
    }
  }
  async function trySample() {
    const s = await import("./translate-sample.js");
    setReadError("");
    reset(
      prepare({
        name: s.SAMPLE_NAME,
        size: new Blob([s.SAMPLE_MARKDOWN]).size,
        pages: null,
        kind: "Markdown",
        blocks: markdownBlocks(s.SAMPLE_MARKDOWN),
        sample: true,
      }),
    );
  }

  const parts = doc?.parts || [];
  const glossary = useMemo(() => parseGlossary(glossaryText), [glossaryText]);
  // Injection Shield: invisible characters are taken out of what's sent, as
  // for attachments, and the document is checked for planted instructions.
  const clean = useMemo(() => (shieldOn ? (s) => cleanText(s, scanText(s, { phrases: false })) : (s) => s), [shieldOn]);
  const shield = useMemo(() => (shieldOn && doc ? shieldSummary(scanText(parts.map((p) => p.text).join("\n\n"))) : null), [shieldOn, doc]);
  // What's sent: every part (and glossary term) masked by Veil in order,
  // with one tag map for the document, so a part gets the same tags in a
  // quote, a run and a retry.
  const sent = useMemo(() => {
    if (!doc) return null;
    const state = createVeilState();
    const mask = (s) => (veiling ? veil(s, state, veilWords) : { text: s, count: 0 });
    const texts = [],
      counts = [];
    for (const p of parts) {
      const r = mask(clean(p.text));
      texts.push(r.text);
      counts.push(r.count);
    }
    const terms = glossary.entries.map((g) => ({ term: mask(g.term).text, ...(g.as ? { as: mask(g.as).text } : {}) }));
    return { texts, counts, glossary: terms, map: { ...state.map } };
  }, [doc, veiling, veilWords, clean, glossary]);
  const statusOf = (i) => results[i]?.status || "pending";
  const todo = parts.filter((p) => statusOf(p.index) !== "done").map((p) => p.index);
  const of = parts.length;
  const sizes = useMemo(
    () =>
      sent
        ? parts.map((p) =>
            measure(pricedMessages({ target, tone, part: { index: p.index, text: sent.texts[p.index] }, of, glossary: sent.glossary })),
          )
        : [],
    [sent, target, tone, of],
  );
  const chosen = choices.find((m) => m.id === model);
  const noPrivate = privateOn && !choices.length;
  const quoteBody = useMemo(() => {
    if (!live || !doc || busy || !todo.length || !chosen) return null;
    return { model, ...(privateOn ? { private: true } : {}), sizes: todo.map((i) => sizes[i]) };
  }, [live, doc, busy, todo.join(","), chosen, model, privateOn, sizes]);
  const estimate = useTranslateEstimate(quoteBody, tick);
  const quote = estimate.status === "ready" ? estimate : estimate.last;
  const quoteFresh = estimate.status === "ready" && estimate.key === JSON.stringify(quoteBody) && estimate.tick === tick;
  // Each part's own maximum, from a quote for exactly these parts, so a
  // Retry holds what its button shows.
  const partUnits = useMemo(() => {
    const map = new Map();
    if (quoteFresh && quote.part_units) quoteBody.sizes.forEach((_, k) => map.set(todo[k], quote.part_units[k]));
    return map;
  }, [quote, quoteBody, quoteFresh]);
  const seedTexts = useMemo(() => (doc ? [...parts.map((p) => p.text), glossaryText] : ""), [doc, glossaryText]);
  const seedHit = useSeedScan(live && seedGuardLive(config) && !!doc, seedTexts);

  // ---- A run: the given parts, or every part not yet translated ----
  async function translate(indices = todo, { allowSeed = false } = {}) {
    if (busy || !live || !doc || !indices.length || !chosen || noPrivate || (seedHit && !allowSeed)) return;
    const single = indices.length === 1 && indices.length !== todo.length;
    const max = single ? partUnits.get(indices[0]) : quoteFresh ? quote.units : null;
    if (!Number.isSafeInteger(max)) return;
    const controller = new AbortController();
    const requestId = uid();
    const masked = indices.reduce((sum, i) => sum + sent.counts[i], 0);
    const map = sent.map;
    const job = { controller, requestId, indices, stopping: false };
    current.current = job;
    setRun({ indices, reserved: 0, charged: 0 });
    setRunError("");
    setSummary(null);
    setSave((s) => ({ ...s, saved: "", error: "" }));
    setResults((r) => {
      const next = { ...r };
      for (const i of indices) next[i] = { status: "queued" };
      return next;
    });
    const body = {
      model,
      target,
      tone,
      of,
      glossary: sent.glossary,
      parts: indices.map((i) => ({ index: i, text: sent.texts[i] })),
      max_units: max,
      requestId,
      ...(privateOn ? { private: true } : {}),
      ...(trailLive ? { veil_masked: veiling ? masked : null } : {}),
      ...(allowSeed && seedHit?.kind === "seed" ? { allow_seed_phrase: true } : {}),
    };
    let final = null;
    try {
      await runTranslate(
        body,
        (event) => {
          if (!mounted.current) return;
          const t = event.translate;
          if (t?.stage === "started") setRun((r) => r && { ...r, reserved: Number(t.reserved) || 0 });
          else if (t?.stage === "part" && indices.includes(t.index)) {
            const part = parts[t.index];
            setResults((r) => ({
              ...r,
              [t.index]:
                t.status === "done"
                  ? {
                      status: "done",
                      text: t.text,
                      map,
                      aligned: alignPart(part, t.text),
                      credits: Number(t.credits) || 0,
                      retried: !!t.retried,
                      model: chosen.name,
                      masked: sent.counts[t.index] || 0,
                      private: privateOn,
                    }
                  : t.status === "failed"
                    ? { status: "failed", code: t.code, message: t.message }
                    : t.status === "stopped"
                      ? { status: "stopped" }
                      : { status: t.status === "running" ? "running" : "queued" },
            }));
            if (t.status === "done") {
              setRun((r) => r && { ...r, charged: r.charged + (Number(t.credits) || 0) });
              setSpent((s) => s + (Number(t.credits) || 0));
            }
          } else if (t?.stage === "done") final = event;
        },
        controller.signal,
      );
      if (!final) throw new ApiError("The connection ended before the translation finished. Check your activity before retrying.");
      if (mounted.current)
        setSummary({
          status: final.translate.status,
          charged: Number(final.anonyma?.credits_charged) || 0,
          privacy: final.anonyma?.privacy || null,
          private: !!final.anonyma?.private,
          masked,
          model: chosen.name,
          stopped: job.stopping,
        });
    } catch (e) {
      if (!mounted.current) return;
      if (e?.name !== "AbortError") setRunError(e.message || "Translate docs stopped.");
      // The page's figure was out of date: get the current one.
      if (e?.code === "estimate_changed") setTick((k) => k + 1);
    } finally {
      if (current.current === job) current.current = null;
      if (mounted.current) {
        // Whatever didn't finish is back to waiting its turn.
        setResults((r) => {
          const next = { ...r };
          for (const i of indices)
            if (["queued", "running"].includes(next[i]?.status)) next[i] = job.stopping ? { status: "stopped" } : { status: "pending" };
          return next;
        });
        setRun(null);
      }
      refresh?.();
    }
  }
  async function stop() {
    const job = current.current;
    if (!job || job.stopping) return;
    job.stopping = true;
    setRun((r) => r && { ...r, stopping: true });
    // Ask the server to stop, so what finished still arrives; leave only if
    // it doesn't answer.
    const fallback = setTimeout(() => job.controller.abort(), STOP_WAIT);
    try {
      const r = await api("/api/translate/stop", { method: "POST", body: { requestId: job.requestId } });
      if (!r.stopped) job.controller.abort();
    } catch {
      job.controller.abort();
    } finally {
      clearTimeout(fallback);
    }
  }

  // ---- Output ----
  const plainResults = useMemo(() => {
    const out = {};
    for (const [i, r] of Object.entries(results))
      out[i] = r.status === "done" ? { ...r, text: unveil(r.text, r.map), aligned: r.aligned?.map((t) => unveil(t, r.map)) || null } : r;
    return out;
  }, [results]);
  const rows = useMemo(() => (doc ? viewRows(doc.blocks, parts, results) : []), [doc, results]);
  const doneCount = parts.filter((p) => statusOf(p.index) === "done").length;
  const failed = parts.filter((p) => statusOf(p.index) === "failed").map((p) => p.index);
  const stem = doc ? `${fileStem(doc.name)} (${lang.name})` : "translation";
  const markdown = () => translatedMarkdown(doc.blocks, parts, plainResults);
  // What went into the translation on screen: details Veil masked, and
  // whether any part ran in Private Mode.
  const doneResults = Object.values(results).filter((r) => r.status === "done");
  const maskedTotal = doneResults.reduce((sum, r) => sum + (r.masked || 0), 0);
  const privateUsed = privateOn || doneResults.some((r) => r.private);
  async function exportDocx() {
    setExporting("docx");
    try {
      const { default: JSZip } = await import("jszip");
      const bytes = await buildDocx(JSZip, markdown(), { lang: target, rtl: lang.rtl, title: fileStem(doc.name) });
      download(`${stem}.docx`, bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    } catch {
      setRunError("The DOCX couldn't be made. Try Markdown instead.");
    } finally {
      setExporting("");
    }
  }
  useEffect(() => {
    if (!printing) return;
    const done = () => setPrinting(false);
    window.addEventListener("afterprint", done, { once: true });
    document.body.classList.add("translate-printing");
    const timer = setTimeout(() => window.print(), 60);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", done);
      document.body.classList.remove("translate-printing");
    };
  }, [printing]);
  async function saveToFiles() {
    if (!save.consent || save.busy) return;
    setSave((s) => ({ ...s, busy: true, error: "" }));
    try {
      await api("/api/files", {
        method: "POST",
        body: { filename: `${stem}.md`, data: base64(markdown()), consent: true, retention_seconds: 7 * 86400 },
      });
      if (mounted.current) setSave({ open: false, consent: false, busy: false, saved: `${stem}.md`, error: "" });
    } catch (e) {
      if (mounted.current) setSave((s) => ({ ...s, busy: false, error: e.message || "It couldn't be saved." }));
    }
  }

  const locked = anyDone || busy;
  const short = quote && toneOf(quote) !== "ready";
  const ready = live && !!doc && todo.length > 0 && !!chosen && !noPrivate && quoteFresh && !short;
  const progress = run ? run.indices.filter((i) => ["done", "failed", "stopped"].includes(statusOf(i))).length : 0;
  const mainLabel =
    !anyDone && !failed.length
      ? todo.length === 1
        ? "Translate 1 part"
        : `Translate ${n(todo.length)} parts`
      : failed.length === todo.length
        ? todo.length === 1
          ? "Retry the failed part"
          : `Retry ${n(todo.length)} failed parts`
        : todo.length === 1
          ? "Translate the last part"
          : `Translate the other ${n(todo.length)} parts`;
  const saveBlocked = privateUsed
    ? "Private Mode keeps nothing, so saving to Files is off. Download it instead."
    : maskedTotal
      ? "Veil kept details on this device, so this translation isn't saved to Files. Download it instead."
      : seedHit
        ? "Seed Guard found what looks like a wallet secret in this document, so it isn't saved to Files."
        : "";

  return (
    <section className="translate-page">
      <div className={"translate-head" + (doc ? " compact" : "")}>
        <div>
          <p className="eyebrow">YOUR FILE STAYS ON THIS DEVICE</p>
          <h1>Translate docs</h1>
          <p>
            Translate a whole document and keep its structure: headings, lists and tables. See it side by side, then export it. Only the
            text goes to the model, a part at a time, off the record.
          </p>
        </div>
        {!doc && (
          <button type="button" className="translate-secondary" disabled={busy || reading} onClick={trySample}>
            <Icon name="languages" size={15} />
            Try a sample policy
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept={officeAllowed ? ACCEPT : ACCEPT.replace(",.docx", "")}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          readInto(file);
        }}
      />
      {!doc ? (
        <>
          <div
            className={"translate-drop" + (dragging ? " dragging" : "")}
            onDragOver={(e) => {
              e.preventDefault();
              if (!busy) setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              readInto(e.dataTransfer.files?.[0]);
            }}
          >
            <span className="translate-tile" aria-hidden="true">
              <Icon name="upload" size={18} />
            </span>
            <b>{reading ? "Reading in this browser…" : "Drop a document here"}</b>
            <small>{officeAllowed ? "PDF, DOCX, TXT or Markdown, up to 25 MB" : "PDF, TXT or Markdown, up to 25 MB"}</small>
            <button type="button" className="translate-secondary" disabled={reading} onClick={() => input.current?.click()}>
              Choose a file
            </button>
            {readError && (
              <p className="translate-error" role="alert">
                {readError}
              </p>
            )}
          </div>
          <ul className="translate-promises">
            <li>
              <b>Stays here</b>
              <span>The file is read in this browser. Only its text goes to the model, a part at a time. Nothing is saved.</span>
            </li>
            <li>
              <b>Structure kept</b>
              <span>Headings, paragraphs, lists and tables come back in place, side by side with the original.</span>
            </li>
            <li>
              <b>Pay for what comes back</b>
              <span>See the most it can cost first. A part that fails or is stopped costs nothing.</span>
            </li>
          </ul>
        </>
      ) : (
        <>
          <div className="translate-file">
            <span className="translate-tile small" aria-hidden="true">
              <Icon name="file" size={15} />
            </span>
            <span className="translate-file-name">
              <b data-i18n="off">{doc.name}</b>
              <small>
                <Dots
                  items={[
                    doc.sample ? "Sample" : doc.kind,
                    doc.pages ? (doc.pages === 1 ? "1 page" : `${n(doc.pages)} pages`) : null,
                    formatBytes(doc.size),
                    doc.words === 1 ? "1 word" : `${n(doc.words)} words`,
                    of === 1 ? "1 part" : `${n(of)} parts`,
                  ]}
                />
              </small>
            </span>
            <button type="button" className="translate-secondary" disabled={busy || reading} onClick={() => input.current?.click()}>
              Replace
            </button>
            <button
              type="button"
              className="translate-icon"
              aria-label="Close this document"
              title="Close this document"
              disabled={busy}
              onClick={() => reset(null)}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
          {readError && <Notice type="error">{readError}</Notice>}
          {/* The settings step back while parts translate, and once every
              part is done; "Translate the rest" and Retry bring them back. */}
          {!busy && todo.length > 0 && (
            <div className="translate-settings">
              <label className="translate-field">
                <span>Translate into</span>
                <select value={target} disabled={locked} onChange={(e) => setTarget(e.target.value)}>
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>
                      {l.name === l.native ? l.name : `${l.name} · ${l.native}`}
                    </option>
                  ))}
                </select>
              </label>
              <div className="translate-field">
                <span>Tone</span>
                <div className="translate-tone" role="radiogroup" aria-label="Tone">
                  {["formal", "plain"].map((id) => (
                    <button
                      type="button"
                      role="radio"
                      aria-checked={tone === id}
                      className={tone === id ? "on" : ""}
                      key={id}
                      disabled={locked}
                      onClick={() => setTone(id)}
                    >
                      {TONE_LABELS[id]}
                    </button>
                  ))}
                </div>
              </div>
              <label className="translate-field translate-model">
                <span>Model</span>
                <select value={model} disabled={busy || !choices.length} onChange={(e) => setModel(e.target.value)}>
                  {choices.map((m) => (
                    <option key={m.id} value={m.id} data-i18n="off">
                      {m.name}
                    </option>
                  ))}
                </select>
              </label>
              {live && (privateLive || veilLive) && (
                <div className="translate-toggles">
                  {privateLive && (
                    <PrivateModeToggle
                      active={privateOn}
                      disabled={busy}
                      onToggle={() => {
                        setPrivateOn((on) => !on);
                        if (!privateOn && veilLive) setVeilOn(true);
                      }}
                    />
                  )}
                  {veilLive && (
                    <VeilToggle
                      on={veilOn || privateOn}
                      onToggle={() => {
                        if (!busy && !privateOn) setVeilOn((v) => !v);
                      }}
                    />
                  )}
                </div>
              )}
              <details className="translate-glossary" open={!!glossaryText || undefined}>
                <summary>
                  Glossary{" "}
                  <small>
                    {glossary.entries.length
                      ? glossary.entries.length === 1
                        ? "1 term"
                        : `${n(glossary.entries.length)} terms`
                      : "Optional"}
                  </small>
                </summary>
                <textarea
                  value={glossaryText}
                  disabled={locked}
                  rows={3}
                  data-i18n="off"
                  placeholder={"Northwind Studio\nlead = responsable"}
                  onChange={(e) => setGlossaryText(e.target.value)}
                />
                <small>
                  One per line. A term on its own is kept as written; “term = translation” says how to translate it. Only the terms a part
                  uses go with it.
                </small>
                {glossary.errors.includes("many") && (
                  <small className="translate-warn">{`Only the first ${LIMITS.glossary} terms are used.`}</small>
                )}
                {glossary.errors.includes("long") && (
                  <small className="translate-warn">{`Terms longer than ${LIMITS.term} characters are left out.`}</small>
                )}
              </details>
            </div>
          )}
          {noPrivate && <NoPrivateModelsNotice />}
          {locked && (
            <p className="translate-locked">
              <Icon name="lock" size={13} />
              <span>
                {glossary.entries.length
                  ? `Into ${lang.name}, ${TONE_LABELS[tone].toLowerCase()} tone, with ${glossary.entries.length === 1 ? "1 glossary term" : `${n(glossary.entries.length)} glossary terms`}. To change them, start over.`
                  : `Into ${lang.name}, ${TONE_LABELS[tone].toLowerCase()} tone. To change the language, tone or glossary, start over.`}
              </span>
              {!busy && (
                <button type="button" className="translate-link" onClick={() => reset({ ...doc })}>
                  Start over
                </button>
              )}
            </p>
          )}
          <SeedGuardNotice hit={!busy && todo.length ? seedHit : null} busy={busy} onProceed={() => translate(todo, { allowSeed: true })} />
          {!busy && todo.length > 0 && (
            <div className="translate-go">
              <button type="button" className="button" disabled={!ready || !!seedHit} onClick={() => translate()}>
                <Icon name="languages" size={15} />
                {mainLabel}
              </button>
              {!live ? (
                <small className="translate-signin">Sign in to translate. Reading a file works without an account.</small>
              ) : (
                <span
                  className={"credit-estimate translate-estimate " + (quote ? toneOf(quote) : "")}
                  role="status"
                  aria-busy={estimate.status === "loading"}
                >
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
              )}
              <small>
                The most it can cost is held first. Each part is then charged only on what it uses, usually a small share of that; a part
                that fails or is stopped costs nothing. Off the record: nothing is saved.
              </small>
            </div>
          )}
          {runError && <Notice type="error">{runError}</Notice>}
          {!busy && todo.length > 0 && sent && (
            <details className="translate-sees">
              <summary>
                <Icon name="eye" size={14} />
                What the AI sees
              </summary>
              <div className="translate-sees-body">
                <p>
                  {`Each part goes on its own, with the fixed instructions below. Never the file itself, its name or anything else from it${glossary.entries.length ? "; only the glossary terms a part uses" : ""}.`}
                </p>
                <label className="translate-field">
                  <span>Part</span>
                  <select value={Math.min(peek, of - 1)} onChange={(e) => setPeek(Number(e.target.value))}>
                    {parts.map((p) => (
                      <option key={p.index} value={p.index}>
                        {`Part ${p.index + 1} of ${of}`}
                      </option>
                    ))}
                  </select>
                </label>
                <pre data-i18n="off">
                  {partUserText({
                    part: { index: Math.min(peek, of - 1), text: sent.texts[Math.min(peek, of - 1)] },
                    of,
                    glossary: sent.glossary,
                  })}
                </pre>
                {veiling && (
                  <p className="translate-note">
                    Veil is on: details it recognises are masked before sending, as shown, and put back when the translation arrives.
                  </p>
                )}
                <p className="translate-note translate-data">
                  <SentAsDataTag />
                  {shield && !shield.clear ? (
                    <span>
                      {"Injection Shield: "}
                      {summaryText(shield)}
                    </span>
                  ) : (
                    <span>The text is marked as data to translate, never instructions to follow.</span>
                  )}
                </p>
                <details>
                  <summary>Show the fixed instructions</summary>
                  <pre data-i18n="off">{translateSystem(target, tone)}</pre>
                </details>
              </div>
            </details>
          )}
          {(busy || anyDone || failed.length > 0) && (
            <div className={"translate-progress" + (busy ? " running" : "")}>
              <div className="translate-progress-top">
                <b>
                  {busy
                    ? run.stopping
                      ? "Stopping…"
                      : `Translating · ${n(progress)} of ${n(run.indices.length)}`
                    : doneCount === of
                      ? "Translated"
                      : `${n(doneCount)} of ${n(of)} parts translated`}
                </b>
                <span>
                  <Dots
                    items={[
                      busy && run.reserved
                        ? `${formatCredits(Math.round(run.charged * 10000) / 10000)} of up to ${formatCredits(run.reserved)} credits`
                        : `${formatCredits(Math.round(spent * 10000) / 10000)} credits`,
                      privateUsed ? "Zero data retention" : null,
                      "Off the record: not saved",
                      maskedTotal ? (maskedTotal === 1 ? "1 detail masked" : `${n(maskedTotal)} details masked`) : null,
                    ]}
                  />
                </span>
                {busy && (
                  <button type="button" className="translate-secondary" disabled={run.stopping} onClick={stop}>
                    <Icon name="stop" size={13} />
                    Stop
                  </button>
                )}
              </div>
              <div
                className="translate-bar"
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={of}
                aria-valuenow={doneCount}
                aria-label="Parts translated"
              >
                {parts.map((p) => (
                  <span key={p.index} className={statusOf(p.index)} title={`Part ${p.index + 1}`} />
                ))}
              </div>
              {!busy && anyDone && (
                <div className="translate-exports">
                  <button type="button" className="translate-secondary" disabled={!!exporting} onClick={exportDocx}>
                    <Icon name="download" size={14} />
                    DOCX
                  </button>
                  <button type="button" className="translate-secondary" onClick={() => download(`${stem}.md`, markdown(), "text/markdown")}>
                    <Icon name="download" size={14} />
                    Markdown
                  </button>
                  <button type="button" className="translate-secondary" onClick={() => setPrinting(true)}>
                    <Icon name="file" size={14} />
                    Print or PDF
                  </button>
                  {filesLive && (
                    <button
                      type="button"
                      className="translate-secondary"
                      disabled={!!saveBlocked || save.busy}
                      title={saveBlocked || "Keep a copy in Files for up to 7 days"}
                      onClick={() => setSave((s) => ({ ...s, open: !s.open, saved: "" }))}
                    >
                      <Icon name="folder" size={14} />
                      Save to Files
                    </button>
                  )}
                  <small>
                    {doneCount < of
                      ? "Parts not translated yet are exported in the original language. Machine translation: check it before you rely on it."
                      : "Machine translation: check it before you rely on it."}
                  </small>
                </div>
              )}
              {filesLive && !busy && saveBlocked && anyDone && <p className="translate-note">{saveBlocked}</p>}
              {save.open && !saveBlocked && (
                <div className="translate-save">
                  <label>
                    <input type="checkbox" checked={save.consent} onChange={(e) => setSave((s) => ({ ...s, consent: e.target.checked }))} />
                    <span>
                      Upload this translation to my account as a Markdown file. It's kept in Files for 7 days, where I can delete it sooner.
                      The original file is never uploaded.
                    </span>
                  </label>
                  <div>
                    <button type="button" className="button" disabled={!save.consent || save.busy} onClick={saveToFiles}>
                      {save.busy ? "Saving…" : "Save"}
                    </button>
                    <button
                      type="button"
                      className="translate-secondary"
                      onClick={() => setSave((s) => ({ ...s, open: false, consent: false }))}
                    >
                      Cancel
                    </button>
                  </div>
                  {save.error && <p className="translate-error">{save.error}</p>}
                </div>
              )}
              {save.saved && (
                <p className="translate-note">
                  <Icon name="check" size={13} /> <span>{`Saved to Files as “${save.saved}” for 7 days.`}</span>
                </p>
              )}
              {summary?.status === "stopped" && (
                <p className="translate-note">Stopped. Finished parts are kept and charged; the rest weren't charged.</p>
              )}
              {!busy && trailLive && summary?.privacy && <PrivacyTrail privacy={summary.privacy} models={models} receiptsLive={false} />}
            </div>
          )}
          <Sheet
            rows={rows}
            parts={parts}
            results={results}
            lang={lang}
            tone={tone}
            busy={busy}
            live={live}
            partUnits={partUnits}
            shieldOn={shieldOn}
            onRetry={(i) => translate([i])}
          />
        </>
      )}
      {printing &&
        doc &&
        createPortal(
          <div className="translate-print" lang={target} dir={lang.rtl ? "rtl" : "ltr"} data-i18n="off">
            <div className="prose markdown">
              <ReplyMarkdown remarkPlugins={[remarkGfm]} rich={false}>
                {markdown()}
              </ReplyMarkdown>
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
}

// The side-by-side view: one row per block (or per part, when its
// translation doesn't line up block for block), so both sides scroll
// together and every block sits beside its translation.
function Sheet({ rows, parts, results, lang, tone, busy, live, partUnits, shieldOn, onRetry }) {
  const of = parts.length;
  return (
    <article className="translate-sheet" aria-label="Original and translation, side by side">
      <div className="translate-sheet-head">
        <span />
        <b>Original text</b>
        <b>
          {lang.name} <small>{TONE_LABELS[tone]}</small>
        </b>
      </div>
      {rows.map((row) => (
        <Row
          key={row.key}
          row={row}
          of={of}
          result={row.part != null ? results[row.part] : null}
          lang={lang}
          busy={busy}
          live={live}
          units={row.part != null ? partUnits.get(row.part) : null}
          shieldOn={shieldOn}
          onRetry={onRetry}
        />
      ))}
    </article>
  );
}

const Markdown = ({ text, map, shieldOn }) => (
  <ReplyMarkdown
    remarkPlugins={map ? [remarkGfm, [veilRemarkPlugin, { map }]] : [remarkGfm]}
    components={shieldOn ? shieldMarkdown() : undefined}
  >
    {text}
  </ReplyMarkdown>
);
const STATUS_TEXT = {
  pending: "Not translated yet",
  queued: "Waiting its turn…",
  running: "Translating…",
  stopped: "Stopped before this part finished. Not charged.",
};
const Row = memo(function Row({ row, of, result, lang, busy, live, units, shieldOn, onRetry }) {
  const state = row.kept ? "kept" : result?.status || "pending";
  return (
    <div className={"translate-row " + state + (row.first ? " first" : "")} id={row.first ? `translate-part-${row.part}` : undefined}>
      <span className="translate-gutter">
        {row.first && (
          <span className="translate-badge" title={`Part ${row.part + 1} of ${of}`}>
            {row.part + 1}
          </span>
        )}
      </span>
      <div className="translate-cell original">
        <div className="prose markdown" data-i18n="off">
          {row.left.map((b, k) => (
            <Markdown key={k} text={b.md} shieldOn={shieldOn} />
          ))}
        </div>
      </div>
      <div className="translate-cell translated" lang={lang.code} dir={lang.rtl ? "rtl" : undefined}>
        {row.kept ? (
          <div className="prose markdown" data-i18n="off">
            <Markdown text={row.right} shieldOn={shieldOn} />
          </div>
        ) : state === "done" ? (
          <div className="prose markdown" data-i18n="off">
            <Markdown text={row.right} map={result.map} shieldOn={shieldOn} />
          </div>
        ) : state === "failed" ? (
          row.first && (
            <div className="translate-failed" dir="ltr">
              <p>{result.message}</p>
              {live && (
                <button
                  type="button"
                  className="translate-secondary"
                  disabled={busy || !Number.isSafeInteger(units)}
                  onClick={() => onRetry(row.part)}
                >
                  <Icon name="refresh" size={13} />
                  {Number.isSafeInteger(units) ? `Retry · up to ${formatCredits(units / 10000)} credits` : "Retry"}
                </button>
              )}
            </div>
          )
        ) : (
          row.first && (
            <p className={"translate-waiting " + state} dir="ltr">
              {state === "running" && <span className="translate-pulse" aria-hidden="true" />}
              {STATUS_TEXT[state] || STATUS_TEXT.pending}
            </p>
          )
        )}
        {state === "done" && row.first && result.retried && (
          <p className="translate-note" dir="ltr">
            Translated on the second try: the first lost a masked detail and wasn't charged.
          </p>
        )}
      </div>
    </div>
  );
});
