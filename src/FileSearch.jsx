import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { Icon, Notice } from "./ui.jsx";
import { api, isReleased, uid, copyText } from "./lib.js";
import { createVeilState, veil, saveVeilState, loadVeilState } from "./veil.js";
import { VeilToggle, veilRemarkPlugin } from "./Veil.jsx";
import { PrivateModeToggle, NoPrivateModelsNotice, privateModeReleased } from "./PrivateMode.jsx";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { ShieldLink, SentAsDataTag, shieldMarkdown, shieldReleased } from "./Shield.jsx";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { ReplyMarkdown } from "./RichMarkdown.jsx";
import { pickPreset } from "./model-finder.js";
import { formatCredits } from "./estimate.js";
import { formatBytes } from "./documents.js";
import { FILE_SEARCH_SYSTEM, LIMITS, fileSearchMessages, linkCitations, queryTerms } from "./file-search.js";
import "./file-search.css";

// File Search (update "filesearch", which needs Files & Reusable Uploads and
// Documents too): one question asked across all the account's saved files.
// Finding passages happens on the server against the text of the saved
// files (server/file-search.js) and sends nothing to a model. The person
// sees the best passages, unchecks any they don't want to send, looks at
// exactly what the AI will see ("What the AI sees") and only then asks: one
// model call on the question, the kept passages and fixed instructions
// (/api/file-search, server/routes/file-search.js). The answer cites
// passages by number, and every number names a passage that was sent. Veil
// masks the question and the passages in this browser first; Private Mode
// and off the record keep nothing; otherwise the answer is one ordinary
// conversation in History, naming the files and places it cites but never
// the passages' text.

const n = (v) => Number(v || 0).toLocaleString("en-US");
const one = (count, singular, plural) => (count === 1 ? singular : plural(n(count)));
const passagesLabel = (count) => one(count, "1 passage", (v) => `${v} passages`);
const SNIPPET = 260;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// What to mark in a passage: the question's words (a stem of each, so a
// plural finds its singular) and its Chinese, Japanese and Korean pairs.
function markers(question) {
  const { words, runs } = queryTerms(question);
  const parts = [
    ...words.map((w) => `\\b${escapeRe(w.length > 4 ? w.replace(/(ing|ed|es|s)$/, "") : w)}[\\p{L}\\p{N}]*`),
    ...runs.map((r) => escapeRe(r.join(""))),
  ];
  return parts.length ? new RegExp(parts.join("|"), "giu") : null;
}
// A passage's opening, or, when it's long, the stretch around the first word
// of the question in it.
function snippet(text, re) {
  if (text.length <= SNIPPET) return text;
  if (re) re.lastIndex = 0;
  const at = re ? (re.exec(text)?.index ?? 0) : 0;
  let start = Math.max(0, at - 80),
    end = Math.min(text.length, start + SNIPPET);
  if (start > 0) {
    const space = text.indexOf(" ", start);
    if (space > -1 && space < at) start = space + 1;
  }
  if (end < text.length) {
    const space = text.lastIndexOf(" ", end);
    if (space > start + SNIPPET / 2) end = space;
  }
  return (start > 0 ? "… " : "") + text.slice(start, end).trim() + (end < text.length ? " …" : "");
}
// The text with the question's words marked.
function Marked({ text, re }) {
  if (!re) return text;
  const out = [];
  let last = 0,
    m;
  re.lastIndex = 0;
  while ((m = re.exec(text))) {
    if (!m[0]) {
      re.lastIndex++;
      continue;
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(<mark key={m.index}>{m[0]}</mark>);
    last = m.index + m[0].length;
  }
  out.push(text.slice(last));
  return out;
}
// A status line: each item its own element, so each translates on its own.
const Dots = ({ items }) =>
  items.filter(Boolean).map((t, k) => (
    <React.Fragment key={k}>
      {k > 0 && " · "}
      <span>{t}</span>
    </React.Fragment>
  ));
// Where a passage sits: a heading's own words are the file's text, so they
// never translate; the rest ("Slide 3", "Part 2 of 9") are ours.
const Place = ({ p }) => <span data-i18n={p.kind === "heading" ? "off" : undefined}>{p.section}</span>;
const toneOf = (q) =>
  q?.available != null && q.credits > q.available
    ? "short"
    : q?.spending_limit?.remaining != null && q.credits > Number(q.spending_limit.remaining)
      ? "limited"
      : "ready";

// A debounced /api/file-search/quote for what would be sent. Quoting holds,
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
        const r = await api("/api/file-search/quote", { method: "POST", body, signal: controller.signal });
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

// A citation in an answer: a button that opens its source below.
const Cite = ({ n: number, onOpen, children }) => (
  <button type="button" className="fsearch-cite" onClick={() => onOpen(number)}>
    {children}
  </button>
);

export default function FileSearch({ demo, user, models, config, refresh, veilOn, setVeilOn, veilWords, vaultLive }) {
  const [params, setParams] = useSearchParams();
  const savedId = params.get("c");
  const [files, setFiles] = useState(null),
    [filesError, setFilesError] = useState(""),
    [chosen, setChosen] = useState(null),
    [question, setQuestion] = useState(""),
    [searching, setSearching] = useState(false),
    [result, setResult] = useState(null),
    [kept, setKept] = useState(new Set()),
    [error, setError] = useState(""),
    [model, setModel] = useState(""),
    [privateOn, setPrivateOn] = useState(false),
    [keep, setKeep] = useState("history"),
    [run, setRun] = useState(null),
    [answer, setAnswer] = useState(null),
    [tick, setTick] = useState(0),
    [open, setOpen] = useState(new Set()),
    [flash, setFlash] = useState(0);
  const mounted = useRef(true),
    controller = useRef(null),
    input = useRef(null);
  const live = !demo && !!user;
  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && live && (veilOn || privateOn);
  const privateLive = privateModeReleased(config);
  const offRecordLive = isReleased(config, "ephemeral");
  const trailLive = privacyTrailReleased(config);
  const uncensored = config?.releases?.uncensoredModels || [];
  const choices = useMemo(
    () => models.filter((m) => m.type === "chat" && m.callable && !m.imageCapable && !m.sealed && !uncensored.includes(m.id) && (!privateOn || m.private)),
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
      controller.current?.abort();
    };
  }, []);

  // ---- The saved files ----
  useEffect(() => {
    if (!live) return;
    const ctl = new AbortController();
    api("/api/file-search/files", { signal: ctl.signal }).then(
      (r) => {
        setFiles(r);
        setChosen(new Set(r.files.filter((f) => f.passages > 0).map((f) => f.id)));
      },
      (e) => !ctl.signal.aborted && setFilesError(e?.message || "Your saved files couldn't be loaded."),
    );
    return () => ctl.abort();
  }, [live]);
  const searchable = files?.files.filter((f) => f.passages > 0) || [];
  const allChosen = !!files && searchable.every((f) => chosen?.has(f.id));
  const scopeCount = searchable.filter((f) => chosen?.has(f.id)).length;
  function choose(next) {
    setChosen(next);
    // Passages found in other files aren't shown for a different choice.
    setResult(null);
    setAnswer(null);
    setError("");
  }

  // ---- Finding passages ----
  async function find(event) {
    event?.preventDefault();
    const text = question.trim();
    if (!live || searching || run || text.length < 2 || !scopeCount) return;
    controller.current?.abort();
    const ctl = (controller.current = new AbortController());
    setSearching(true);
    setError("");
    setAnswer(null);
    dropSaved();
    try {
      const r = await api("/api/file-search/search", {
        method: "POST",
        body: { question: text, ...(allChosen ? {} : { files: searchable.filter((f) => chosen.has(f.id)).map((f) => f.id) }) },
        signal: ctl.signal,
      });
      if (!mounted.current) return;
      setResult({ ...r, question: text });
      setKept(new Set(r.passages.map((p) => p.id)));
      setOpen(new Set());
    } catch (e) {
      if (mounted.current && e?.name !== "AbortError") {
        setResult(null);
        setError(e?.message || "The search couldn't run.");
      }
    } finally {
      if (controller.current === ctl) controller.current = null;
      if (mounted.current) setSearching(false);
    }
  }
  function dropSaved() {
    if (!params.get("c")) return;
    const next = new URLSearchParams(params);
    next.delete("c");
    setParams(next, { replace: true });
  }
  function reset() {
    controller.current?.abort();
    setResult(null);
    setAnswer(null);
    setError("");
    setRun(null);
    dropSaved();
    setTimeout(() => input.current?.focus(), 0);
  }

  // ---- What is sent: the question and the kept passages, masked by Veil in
  // order with one tag map, so a quote and a run see the same text ----
  const sent = useMemo(() => {
    if (!result) return null;
    const state = createVeilState();
    const mask = (s) => (veiling ? veil(s, state, veilWords) : { text: s, count: 0 });
    const q = mask(result.question);
    const passages = result.passages.map((p) => {
      const r = mask(p.text);
      return { id: p.id, file: p.file_id, text: r.text, count: r.count };
    });
    return { question: q.text, questionCount: q.count, passages, state };
  }, [result, veiling, veilWords]);
  const keptList = sent ? sent.passages.filter((p) => kept.has(p.id)) : [];
  const masked = sent ? sent.questionCount + keptList.reduce((sum, p) => sum + p.count, 0) : 0;
  const messages = useMemo(
    () => (sent && keptList.length ? fileSearchMessages(sent.question, keptList.map((p) => ({ text: p.text, file: p.file }))) : null),
    [sent, kept],
  );
  const ephemeral = privateOn || (keep === "none" && offRecordLive);
  const chosenModel = choices.find((m) => m.id === model);
  const noPrivate = privateOn && !choices.length;
  const quoteBody = useMemo(() => {
    if (!live || !sent || !keptList.length || run || !chosenModel || noPrivate) return null;
    return {
      model,
      question: sent.question,
      passages: keptList.map((p) => ({ id: p.id, text: p.text })),
      ...(privateOn ? { private: true } : ephemeral ? { ephemeral: true } : {}),
    };
  }, [live, sent, kept, run, chosenModel, model, privateOn, ephemeral, noPrivate]);
  const estimate = useQuote(quoteBody, tick);
  const quote = estimate.status === "ready" ? estimate : estimate.last;
  const quoteFresh = estimate.status === "ready" && estimate.key === JSON.stringify(quoteBody) && estimate.tick === tick;
  const seedTexts = useMemo(() => (result ? [result.question, ...result.passages.filter((p) => kept.has(p.id)).map((p) => p.text)] : ""), [result, kept]);
  const seedHit = useSeedScan(live && seedGuardLive(config) && !!result, seedTexts);
  const flagged = result ? result.passages.filter((p) => kept.has(p.id) && p.flagged > 0).length : 0;

  // ---- Asking ----
  async function ask({ allowSeed = false } = {}) {
    if (run || !live || !sent || !keptList.length || !chosenModel || noPrivate || (seedHit && !allowSeed) || !quoteFresh) return;
    const ctl = (controller.current = new AbortController());
    const requestId = uid();
    const map = { ...sent.state.map };
    const list = result.passages.filter((p) => kept.has(p.id));
    setRun({ requestId, stopping: false });
    setError("");
    setAnswer(null);
    try {
      const r = await api("/api/file-search", {
        method: "POST",
        signal: ctl.signal,
        body: {
          model,
          question: sent.question,
          passages: keptList.map((p) => ({ id: p.id, text: p.text })),
          max_units: quote.units,
          requestId,
          ...(privateOn ? { private: true } : ephemeral ? { ephemeral: true } : {}),
          ...(trailLive ? { veil_masked: veiling ? masked : null } : {}),
          ...(allowSeed && seedHit?.kind === "seed" ? { allow_seed_phrase: true } : {}),
        },
      });
      if (!mounted.current) return;
      // A masked answer is put back from a map kept in this browser only, so
      // History can put it back too.
      if (r.conversationId && masked) saveVeilState(r.conversationId, sent.state);
      setAnswer({
        question: result.question,
        text: r.message.text,
        sources: r.message.sources.map((s) => ({ ...s, text: list.find((p) => p.id === s.passage)?.text ?? null })),
        credits: Number(r.anonyma?.credits_charged) || 0,
        model: chosenModel.name,
        conversationId: r.conversationId,
        private: !!r.anonyma?.private,
        privacy: r.anonyma?.privacy || null,
        cutShort: !!r.message.cut_short,
        masked,
        map,
      });
      setOpen(new Set());
      if (r.conversationId) {
        // A reload opens what's on screen.
        const next = new URLSearchParams(params);
        next.set("c", r.conversationId);
        setParams(next, { replace: true });
      }
    } catch (e) {
      if (!mounted.current || e?.name === "AbortError") return;
      setError(e?.message || "The question couldn't be answered. Nothing was charged.");
      // The page's figure was out of date: get the current one.
      if (e?.code === "estimate_changed") setTick((k) => k + 1);
    } finally {
      if (controller.current === ctl) controller.current = null;
      if (mounted.current) setRun(null);
      refresh?.();
    }
  }
  // Stopping leaves at once; the server releases what was held.
  function stop() {
    setRun((r) => r && { ...r, stopping: true });
    controller.current?.abort();
  }

  // ---- Sources ----
  const openSource = useCallback((number) => {
    setOpen((s) => new Set(s).add(number));
    setFlash(number);
    setTimeout(() => {
      document.getElementById("fsearch-source-" + number)?.scrollIntoView({ block: "center", behavior: "smooth" });
    }, 30);
    setTimeout(() => setFlash((f) => (f === number ? 0 : f)), 2400);
  }, []);
  const citeRef = useRef(openSource);
  citeRef.current = openSource;
  // The reply's renderer, with Shield's links and images and citations that
  // open their source.
  const components = useMemo(
    () => ({
      ...shieldMarkdown(),
      a: (props) =>
        /^#source-\d+$/.test(props.href || "") ? (
          <Cite n={Number(props.href.slice(8))} onOpen={(k) => citeRef.current(k)}>
            {props.children}
          </Cite>
        ) : (
          <ShieldLink {...props} />
        ),
    }),
    [],
  );

  const short = quote && toneOf(quote) !== "ready";
  const ready = live && !!sent && keptList.length > 0 && !!chosenModel && !noPrivate && quoteFresh && !short && !run;
  const shown = answer || null;
  const canFind = live && !searching && !run && question.trim().length >= 2 && scopeCount > 0;
  const noFiles = live && files && !searchable.length;

  return (
    <section className="fsearch-page">
      <div className="fsearch-head">
        <p className="eyebrow">YOUR SAVED FILES</p>
        <h1>Search files</h1>
        <p>
          Ask one question across all your saved files. ANONYMA finds the best passages, shows you what would be sent, and the AI answers
          from those passages only, citing the file and the place.
        </p>
      </div>

      {!live ? (
        <>
          <Notice>
            {demo ? "The demo has no saved files. Sign in to search yours." : "Sign in to search your saved files."}
          </Notice>
          <Promises />
        </>
      ) : filesError ? (
        <Notice type="error">{filesError}</Notice>
      ) : !files ? (
        <p className="fsearch-loading">Reading your saved files…</p>
      ) : noFiles ? (
        <>
          <div className="fsearch-empty">
            <span className="fsearch-tile" aria-hidden="true">
              <Icon name="folder" size={18} />
            </span>
            <b>No saved files to search yet</b>
            <small>
              Save a text, code, Word, Excel or PowerPoint file from the paperclip menu in Chat (Saved files). It stays for the days you
              choose, up to 30, and you can ask across all of them here.
            </small>
            <Link className="fsearch-secondary" to="/workspace/chat">
              Open Chat
            </Link>
          </div>
          <Promises />
        </>
      ) : (
        <>
          <details className="fsearch-files">
            <summary>
              <Icon name="file" size={14} />
              <span className="fsearch-summary-text">
                <Dots
                  items={[
                    allChosen ? (searchable.length === 1 ? "Searching your 1 saved file" : `Searching all ${n(searchable.length)} saved files`) : `Searching ${n(scopeCount)} of ${n(searchable.length)} files`,
                    passagesLabel(searchable.filter((f) => chosen.has(f.id)).reduce((sum, f) => sum + f.passages, 0)),
                  ]}
                />
              </span>
              <Icon name="down" size={14} className="fsearch-chev" />
            </summary>
            <div className="fsearch-files-body">
              <div className="fsearch-files-tools">
                <button type="button" className="fsearch-link" disabled={searching || !!run} onClick={() => choose(new Set(searchable.map((f) => f.id)))}>
                  All
                </button>
                <button type="button" className="fsearch-link" disabled={searching || !!run} onClick={() => choose(new Set())}>
                  None
                </button>
                {files.projects.length > 0 && (
                  <label className="fsearch-project">
                    <span>Only a project's pinned files</span>
                    <select
                      value=""
                      disabled={searching || !!run}
                      onChange={(e) => {
                        const p = files.projects.find((x) => x.id === e.target.value);
                        if (!p) return;
                        choose(new Set(p.files));
                        // A project's default privacy carries over.
                        if (p.privacy === "private" && privateLive) {
                          setPrivateOn(true);
                          if (veilLive) setVeilOn?.(true);
                        } else if (p.privacy === "off_record" && offRecordLive) setKeep("none");
                      }}
                    >
                      <option value="">Choose a project…</option>
                      {files.projects.map((p) => (
                        <option key={p.id} value={p.id} data-i18n="off">
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <ul className="fsearch-file-list">
                {files.files.map((f) => (
                  <li key={f.id} className={f.passages ? "" : "empty"}>
                    <label>
                      <input
                        type="checkbox"
                        checked={f.passages > 0 && chosen.has(f.id)}
                        disabled={!f.passages || searching || !!run}
                        onChange={(e) => {
                          const next = new Set(chosen);
                          if (e.target.checked) next.add(f.id);
                          else next.delete(f.id);
                          choose(next);
                        }}
                      />
                      <b data-i18n="off">{f.name}</b>
                      <small>
                        <Dots items={[formatBytes(f.bytes), f.passages ? passagesLabel(f.passages) : "No text found"]} />
                      </small>
                    </label>
                  </li>
                ))}
              </ul>
              <p className="fsearch-note">
                Files are saved from the paperclip menu in Chat and stay for the days you chose, up to 30. Audio, PDFs and images aren't
                searched.
              </p>
            </div>
          </details>

          <form className="fsearch-ask" onSubmit={find}>
            <label htmlFor="fsearch-question">Your question</label>
            <div className="fsearch-ask-row">
              <textarea
                id="fsearch-question"
                ref={input}
                rows={2}
                value={question}
                maxLength={LIMITS.question}
                disabled={searching || !!run}
                placeholder="What notice do I have to give before ending the lease?"
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) find(e);
                }}
              />
              <button type="submit" className="button" disabled={!canFind}>
                <Icon name="search" size={15} />
                {searching ? "Searching…" : "Find passages"}
              </button>
            </div>
            <small className="fsearch-note">
              This looks for the words of your question in your files, on ANONYMA's server. Nothing goes to an AI yet, and your question isn't
              saved.
            </small>
          </form>
          {!result && !shown && !savedId && <Promises />}
        </>
      )}

      {error && <Notice type="error">{error}</Notice>}

      {live && files && result && !shown && (
        <Passages
          result={result}
          kept={kept}
          setKept={setKept}
          open={open}
          setOpen={setOpen}
          busy={!!run}
          searchedFiles={result.searched.files}
          searchedPassages={result.searched.passages}
        />
      )}

      {live && files && result && !shown && result.passages.length > 0 && keptList.length > 0 && (
        <>
          <details className="fsearch-sees">
            <summary>
              <Icon name="eye" size={14} />
              <span className="fsearch-summary-text">What the AI sees</span>
              <Icon name="down" size={14} className="fsearch-chev" />
            </summary>
            <div className="fsearch-sees-body">
              <p>
                The question, the passages you kept and fixed instructions go on one request. Never the files, their names or anything else in
                them.
              </p>
              <pre data-i18n="off">{messages?.[1]?.content}</pre>
              {veiling && (
                <p className="fsearch-note light">
                  Veil is on: details it recognises are masked before sending, as shown, and put back in the answer here.
                </p>
              )}
              <p className="fsearch-note light fsearch-data">
                <SentAsDataTag />
                {shieldReleased(config) && flagged > 0 ? (
                  <span>
                    {flagged === 1
                      ? "Injection Shield: 1 passage has wording that looks like an instruction to an AI. It's sent as data, with a note not to follow it."
                      : `Injection Shield: ${n(flagged)} passages have wording that looks like an instruction to an AI. They're sent as data, with a note not to follow them.`}
                  </span>
                ) : (
                  <span>The passages are marked as data to read, never instructions to follow.</span>
                )}
              </p>
              <details>
                <summary>Show the fixed instructions</summary>
                <pre data-i18n="off">{FILE_SEARCH_SYSTEM}</pre>
              </details>
            </div>
          </details>

          <div className="fsearch-settings">
            <label className="fsearch-field">
              <span>Model</span>
              <select value={model} disabled={!!run || !choices.length} onChange={(e) => setModel(e.target.value)}>
                {choices.map((m) => (
                  <option key={m.id} value={m.id} data-i18n="off">
                    {m.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="fsearch-field">
              <span>Keep the answer</span>
              <select value={privateOn ? "none" : keep} disabled={!!run || privateOn} onChange={(e) => setKeep(e.target.value)}>
                <option value="history">In History</option>
                {(offRecordLive || privateOn) && <option value="none">{privateOn ? "Nowhere (Private mode)" : "Nowhere (off the record)"}</option>}
              </select>
            </label>
            {(privateLive || veilLive) && (
              <div className="fsearch-toggles">
                {privateLive && (
                  <PrivateModeToggle
                    active={privateOn}
                    disabled={!!run}
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
                      if (!run && !privateOn) setVeilOn?.((v) => !v);
                    }}
                  />
                )}
              </div>
            )}
          </div>
          {vaultLive && (
            <p className="fsearch-note fsearch-vault">
              <Icon name="lock" size={13} />
              <span>
                Device Vault isn't offered here. Your saved files live on ANONYMA's server, so an answer built from them can't be kept only on this
                device. Ask off the record to keep nothing.
              </span>
            </p>
          )}
          {noPrivate && <NoPrivateModelsNotice />}
          <SeedGuardNotice hit={!run ? seedHit : null} busy={!!run} onProceed={() => ask({ allowSeed: true })} />

          <div className="fsearch-go">
            {run ? (
              <button type="button" className="button" disabled={run.stopping} onClick={stop}>
                <Icon name="stop" size={14} />
                {run.stopping ? "Stopping…" : "Stop"}
              </button>
            ) : (
              <button type="button" className="button" disabled={!ready || !!seedHit} onClick={() => ask()}>
                <Icon name="search" size={15} />
                {keptList.length === 1 ? "Ask about 1 passage" : `Ask about ${n(keptList.length)} passages`}
              </button>
            )}
            <span
              className={"credit-estimate fsearch-estimate " + (quote ? toneOf(quote) : "")}
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
            <small>
              {run
                ? "Reading the passages… If you stop, nothing is charged."
                : "The most it can cost is held first. You're charged only for what the answer uses, usually a small share of that. An answer that fails or can't be used costs nothing."}
            </small>
          </div>
        </>
      )}

      {shown && (
        <Answer
          answer={shown}
          components={components}
          open={open}
          setOpen={setOpen}
          flash={flash}
          models={models}
          trailLive={trailLive}
          onAgain={() => {
            setAnswer(null);
            dropSaved();
          }}
          onNew={reset}
        />
      )}
      {live && !shown && savedId && <SavedAnswer key={savedId} id={savedId} components={components} open={open} setOpen={setOpen} flash={flash} onMissing={reset} onNew={reset} />}
    </section>
  );
}

function Promises() {
  return (
    <ul className="fsearch-promises">
      <li>
        <b>Only passages go</b>
        <span>Only the few best passages you keep are sent to the model. Never whole files, and never their names.</span>
      </li>
      <li>
        <b>You see it first</b>
        <span>Look at exactly what the AI will see before you ask. Uncheck any passage to leave it out.</span>
      </li>
      <li>
        <b>Every answer cites</b>
        <span>Each claim points to a numbered passage, with its file and place. Open it to check the answer yourself.</span>
      </li>
    </ul>
  );
}

// The passages a search found, each with a checkbox: only the checked ones
// are sent.
function Passages({ result, kept, setKept, open, setOpen, busy, searchedFiles, searchedPassages }) {
  const { passages } = result;
  const re = useMemo(() => markers(result.question), [result.question]);
  let order = 0;
  return (
    <section className="fsearch-results" aria-label="Passages found">
      <div className="fsearch-results-head">
        <div>
          <h2>Best matches</h2>
          <p data-i18n="off" className="fsearch-asked">
            {result.question}
          </p>
        </div>
        <small>
          <Dots
            items={[
              passages.length ? passagesLabel(passages.length) : "No matches",
              searchedFiles === 1 ? "Searched 1 file" : `Searched ${n(searchedFiles)} files`,
              passagesLabel(searchedPassages),
            ]}
          />
        </small>
      </div>
      {!passages.length ? (
        <div className="fsearch-none">
          <p>No passage matched. This finds the words of your question in your files, not their meaning, so try words the file is likely to use, or fewer of them.</p>
        </div>
      ) : (
        <ol className="fsearch-passages">
          {passages.map((p) => {
            const on = kept.has(p.id);
            const number = on ? ++order : null;
            const full = open.has("p" + p.id);
            return (
              <li key={p.id} className={on ? "kept" : "left-out"}>
                <label className="fsearch-check">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy}
                    onChange={(e) => {
                      const next = new Set(kept);
                      if (e.target.checked) next.add(p.id);
                      else next.delete(p.id);
                      setKept(next);
                    }}
                  />
                  <span className="fsearch-badge" aria-hidden="true">
                    {number ?? "–"}
                  </span>
                  <span className="fsearch-where">
                    <b data-i18n="off">{p.file}</b>
                    <small>
                      <Place p={p} />
                      {p.flagged > 0 && (
                        <>
                          {" · "}
                          <span className="fsearch-flag">Looks like an instruction to an AI</span>
                        </>
                      )}
                    </small>
                  </span>
                  <span className="fsearch-sr">{on ? "Send this passage" : "Leave this passage out"}</span>
                </label>
                <p className="fsearch-text" data-i18n="off">
                  <Marked text={full ? p.text : snippet(p.text, re)} re={re} />
                </p>
                {p.text.length > SNIPPET && (
                  <button
                    type="button"
                    className="fsearch-link"
                    onClick={() =>
                      setOpen((s) => {
                        const next = new Set(s);
                        if (full) next.delete("p" + p.id);
                        else next.add("p" + p.id);
                        return next;
                      })
                    }
                  >
                    {full ? "Show less" : "Show the whole passage"}
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

// An answer, live or reopened from History.
function Answer({ answer, components, open, setOpen, flash, models, trailLive, onAgain, onNew, saved = false }) {
  const [copied, setCopied] = useState(false);
  const map = answer.map;
  const plugins = useMemo(() => (map ? [remarkGfm, [veilRemarkPlugin, { map }]] : [remarkGfm]), [map]);
  const cited = answer.sources.filter((s) => s.cited);
  const rest = answer.sources.filter((s) => !s.cited);
  const text = useMemo(() => linkCitations(answer.text), [answer.text]);
  async function copy() {
    try {
      await copyText(answer.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {}
  }
  return (
    <article className="fsearch-answer" aria-label="Answer">
      <div className="fsearch-answer-q">
        <small>Your question</small>
        <p data-i18n="off">{answer.question}</p>
      </div>
      <div className="fsearch-answer-body prose markdown" data-i18n="off">
        <ReplyMarkdown remarkPlugins={plugins} components={components}>
          {text}
        </ReplyMarkdown>
      </div>
      {answer.cutShort && <p className="fsearch-note warn">The answer was cut off at the model's reply limit. You're charged only for what it used.</p>}
      <p className="fsearch-note">AI answers can be wrong. Open a source and check it against your file.</p>
      {cited.length > 0 && (
        <section className="fsearch-sources" aria-label="Sources">
          <h3>Sources</h3>
          <ul>
            {cited.map((s) => (
              <Source key={s.n} s={s} open={open} setOpen={setOpen} flash={flash} map={map} />
            ))}
          </ul>
        </section>
      )}
      {!cited.length && (
        <p className="fsearch-note">The answer doesn't cite any passage. Read the passages below before you rely on it.</p>
      )}
      {rest.length > 0 && (
        <section className="fsearch-sources rest" aria-label="Also read">
          <h3>Also read, not cited</h3>
          <ul>
            {rest.map((s) => (
              <Source key={s.n} s={s} open={open} setOpen={setOpen} flash={flash} map={map} />
            ))}
          </ul>
        </section>
      )}
      <div className="fsearch-meta">
        <span>
          <Dots
            items={[
              saved ? null : answer.credits ? `${formatCredits(Math.round(answer.credits * 10000) / 10000)} credits charged` : "Nothing charged",
              answer.model ? <span data-i18n="off">{answer.model}</span> : null,
              answer.conversationId ? "Saved in History" : answer.private ? "Zero data retention · not saved" : "Off the record: not saved",
              answer.masked ? (answer.masked === 1 ? "1 detail masked" : `${n(answer.masked)} details masked`) : null,
            ]}
          />
        </span>
        {trailLive && answer.privacy && <PrivacyTrail privacy={answer.privacy} models={models} receiptsLive={false} />}
      </div>
      <div className="fsearch-actions">
        {!saved && (
          <button type="button" className="fsearch-secondary" onClick={onAgain}>
            <Icon name="refresh" size={14} />
            Change the passages
          </button>
        )}
        <button type="button" className="fsearch-secondary" onClick={onNew}>
          <Icon name="search" size={14} />
          Ask another question
        </button>
        <button type="button" className="fsearch-secondary" onClick={copy}>
          <Icon name={copied ? "check" : "copy"} size={14} />
          {copied ? "Copied" : "Copy the answer"}
        </button>
        {answer.conversationId && (
          <Link className="fsearch-secondary" to={"/workspace/chat?c=" + encodeURIComponent(answer.conversationId)}>
            <Icon name="history" size={14} />
            Open in History
          </Link>
        )}
      </div>
    </article>
  );
}

// One source under an answer: its number, file and place, and (while the
// page still has it) the passage.
function Source({ s, open, setOpen, flash, map }) {
  const shown = open.has(s.n);
  return (
    <li id={"fsearch-source-" + s.n} className={(shown ? "open " : "") + (flash === s.n ? "flash" : "")}>
      <button
        type="button"
        className="fsearch-source-head"
        aria-expanded={shown}
        onClick={() =>
          setOpen((set) => {
            const next = new Set(set);
            if (shown) next.delete(s.n);
            else next.add(s.n);
            return next;
          })
        }
      >
        <span className="fsearch-badge">{s.n}</span>
        <span className="fsearch-where">
          <b data-i18n="off">{s.file}</b>
          <small>
            <Place p={s} />
          </small>
        </span>
        <Icon name={shown ? "up" : "down"} size={14} />
      </button>
      {shown &&
        (s.text != null ? (
          <p className="fsearch-text" data-i18n="off">
            {s.text}
          </p>
        ) : (
          <p className="fsearch-text muted">The passage's text isn't kept. Ask again to read it.</p>
        ))}
    </li>
  );
}

// A saved answer, reopened from its conversation (?c=). The passages' text
// was never kept, so only the files and places are shown.
function SavedAnswer({ id, components, open, setOpen, flash, onMissing, onNew }) {
  const [state, setState] = useState({ status: "loading" });
  useEffect(() => {
    const ctl = new AbortController();
    api("/api/conversations/" + encodeURIComponent(id), { signal: ctl.signal }).then(
      (r) => {
        const message = (r.messages || []).find((m) => m.role === "assistant" && m.content && typeof m.content === "object" && m.content.filesearch);
        const asked = (r.messages || []).find((m) => m.role === "user");
        if (!message) return setState({ status: "missing" });
        const c = message.content;
        setState({
          status: "ready",
          answer: {
            question: typeof asked?.content === "string" ? asked.content : "",
            text: c.text.slice(0, c.filesearch.answer_chars),
            sources: c.filesearch.sources.map((s) => ({ ...s, text: null })),
            credits: 0,
            model: null,
            conversationId: id,
            privacy: c.privacy || null,
            cutShort: !!c.filesearch.cut_short,
            masked: 0,
            map: loadVeilState(id).map,
          },
        });
      },
      (e) => !ctl.signal.aborted && setState({ status: e.status === 404 ? "missing" : "error", message: e.message }),
    );
    return () => ctl.abort();
  }, [id]);
  if (state.status === "loading") return <p className="fsearch-loading">Opening the answer…</p>;
  if (state.status !== "ready")
    return (
      <Notice type="error">
        {state.status === "missing" ? "This answer isn't in your History any more." : state.message}{" "}
        <button type="button" className="link-button" onClick={onMissing}>
          Ask a new question
        </button>
      </Notice>
    );
  return <Answer answer={state.answer} components={components} open={open} setOpen={setOpen} flash={flash} models={[]} trailLive={false} onNew={onNew} saved />;
}
