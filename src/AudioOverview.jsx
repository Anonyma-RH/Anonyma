import React, { useEffect, useMemo, useRef, useState } from "react";
import { Icon, Modal, Notice, Button } from "./ui.jsx";
import { api, ApiError, uid, readStore, saveStore, spendingLimitMessage, messageFromServer, copyText } from "./lib.js";
import { readChatEvents } from "./stream.js";
import { formatCredits } from "./estimate.js";
import { veil, createVeilState } from "./veil.js";
import { scanSecrets, seedGuardMessage, isSoft } from "./seed-guard.js";
import { pdfText } from "./pdf-text.js";
import { extractOffice, browserInflate, textBytes } from "./file-formats.js";
import { DOCUMENT_ACCEPT, MAX_FILE_BYTES, documentKind, formatBytes } from "./documents.js";
import {
  LANGUAGES,
  LENGTHS,
  MIN_SOURCE,
  MAX_SOURCE,
  OVERVIEW_PRIVATE,
  OVERVIEW_VEILED,
  chapterOf,
  chatSource,
  documentSource,
  formatClock,
  hasVeilTags,
  researchSource,
  turnAt,
} from "./audio-overview.js";
import "./audio-overview.css";

// Audio Overview (update "audiooverview"): the dialog that makes one, and
// the player for a made or saved one. Loaded only when opened (Workspace
// and the Voice studio import it lazily). The source is built in this
// browser (src/audio-overview.js) and sent once, to make the script;
// server/routes/audio-overview.js runs the rest.

const CHOICES = "audio-overview:choices";
// A fast, inexpensive text model with a long context writes the script
// unless another is picked (and remembered in this browser).
const SCRIPT_MODELS = ["gemini-3.7-flash", "deepseek/deepseek-v4.1-flash", "gpt-5.4-mini", "claude-haiku-4.5"];
const KIND_LABELS = { document: "Document", chat: "Chat", research: "Research report" };
const KIND_ICONS = { document: "file", chat: "chat", research: "research" };

// A picked file's text, extracted in this browser the way Documents does.
async function readDocumentFile(file, office) {
  const kind = documentKind(file);
  if (!kind || (kind === "office" && !office)) throw Error(`"${file.name}" isn't a supported document type.`);
  if (file.size > MAX_FILE_BYTES) throw Error(`"${file.name}" is larger than ${formatBytes(MAX_FILE_BYTES)}.`);
  let text;
  if (kind === "pdf") text = (await pdfText(await file.arrayBuffer())).text;
  else if (kind === "office")
    text = (await extractOffice(await file.arrayBuffer(), file.name.split(".").at(-1).toLowerCase(), browserInflate)).text;
  else text = textBytes(new Uint8Array(await file.arrayBuffer()));
  if (!String(text || "").trim()) throw Error("No text was found in this file. A scanned PDF has none to read.");
  return documentSource({ name: file.name, text });
}

// Reads a run's events into one state, handing each new state to
// `onUpdate`. Resolves with the final event; throws an ApiError carrying
// the state (and whatever was made) otherwise.
export async function runOverview(body, onUpdate, signal) {
  const state = { stage: "writing", title: "", chapters: [], turns: [], voiced: 0, scriptCredits: 0, voiceCredits: 0 };
  const emit = () => onUpdate({ ...state });
  let response;
  try {
    response = await fetch("/api/audio/overview", {
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
      spendingLimitMessage(error) || error?.error?.message || "Audio overviews are unavailable right now.",
      response.status,
      error?.error?.code,
      { ...error, refused: true },
    );
  }
  emit();
  try {
    for await (const event of readChatEvents(response)) {
      if (event.error)
        throw new ApiError(event.error.message || "The audio overview stopped.", 200, event.error.code, { ...event, state });
      const o = event.overview;
      if (o?.stage === "script") {
        state.stage = "voicing";
        state.title = o.title || "";
        state.chapters = Array.isArray(o.chapters) ? o.chapters : [];
        state.turns = Array.isArray(o.turns) ? o.turns : [];
        state.scriptCredits = Number(o.credits) || 0;
        state.trimmed = Number(o.trimmed) || 0;
      } else if (o?.stage === "voiced") {
        state.voiced = (Number(o.index) || 0) + 1;
        state.voiceCredits = Number(o.credits) || 0;
      } else if (o?.stage === "done") return { ...event, state };
      emit();
    }
  } catch (e) {
    if (e instanceof ApiError) throw e;
    if (e?.name === "AbortError" || signal?.aborted) {
      const stopped = new DOMException("Aborted", "AbortError");
      stopped.state = state;
      throw stopped;
    }
    throw new ApiError(e?.message || "The audio overview stopped.", 0, "stream_error", { state });
  }
  throw new ApiError("The connection ended before the audio arrived.", 0, "stream_error", { state });
}

// Why this source can't be sent, or null: Veil's mask (only while Veil is
// on; placeholders already in the source always count) and Seed Guard.
export function sourceBlock(source, { veilWords = null, seedGuard = false } = {}) {
  if (!source) return null;
  const text = source.text || "";
  if (text.trim().length < MIN_SOURCE)
    return "This source is too short for an overview. Use one with at least 200 characters.";
  if (hasVeilTags(text) || hasVeilTags(source.title)) return OVERVIEW_VEILED;
  if (veilWords && veil(text, createVeilState(), veilWords).count > 0) return OVERVIEW_VEILED;
  if (seedGuard) {
    const hit = scanSecrets(text, source.title);
    if (hit) return { soft: isSoft(hit), message: seedGuardMessage(hit) };
  }
  return null;
}

// The /api/audio/overview (and quote) body.
export function overviewRequest({ source, choices, offRecord, veilOn }) {
  return {
    model: choices.model,
    tts: choices.tts,
    voices: { A: choices.voiceA, B: choices.voiceB },
    length: choices.length,
    language: choices.language,
    source: { kind: source.kind, title: source.title, text: source.text },
    ...(offRecord ? { ephemeral: true } : {}),
    ...(veilOn ? { veil_masked: 0 } : {}),
  };
}

// `sources`: what the opener offers ({ kind, title, text, truncated }), the
// first one chosen. `pickFiles` adds "Choose a file", `pickChats` a saved
// chat picker (the Voice studio). `offRecord` is forced on (and why) for
// chats that are never saved: off the record, Device Vault. `saved` opens a
// saved overview's player instead.
export default function AudioOverviewDialog({
  config,
  user,
  models = [],
  sources = [],
  pickFiles = true,
  pickChats = false,
  offRecord = null,
  privateMode = false,
  veilWords = null,
  office = false,
  saved = null,
  onSaved,
  onClose,
}) {
  return (
    <Modal title="Audio overview" onClose={onClose}>
      <div className="overview">
        {saved ? (
          <SavedOverview id={saved} onClose={onClose} />
        ) : privateMode ? (
          <>
            <p className="overview-block" role="alert">
              <Icon name="warning" size={14} />
              {OVERVIEW_PRIVATE}
            </p>
            <div className="inline-actions">
              <Button secondary onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : (
          <OverviewMaker
            config={config}
            user={user}
            models={models}
            sources={sources}
            pickFiles={pickFiles}
            pickChats={pickChats}
            offRecord={offRecord}
            veilWords={veilWords}
            office={office}
            onSaved={onSaved}
            onClose={onClose}
          />
        )}
      </div>
    </Modal>
  );
}

function OverviewMaker({ config, user, models, sources, pickFiles, pickChats, offRecord, veilWords, office, onSaved, onClose }) {
  const remembered = useMemo(() => readStore(CHOICES, {}) || {}, []);
  const [picked, setPicked] = useState(sources.length ? 0 : null),
    [file, setFile] = useState(null),
    [reading, setReading] = useState(false),
    [chats, setChats] = useState(null),
    [chat, setChat] = useState(null),
    [length, setLength] = useState(LENGTHS[remembered.length] ? remembered.length : "short"),
    [language, setLanguage] = useState(LANGUAGES.some(([c]) => c === remembered.language) ? remembered.language : "auto"),
    [catalog, setCatalog] = useState(null),
    [tts, setTts] = useState(remembered.tts || ""),
    [voiceA, setVoiceA] = useState(remembered.voiceA || ""),
    [voiceB, setVoiceB] = useState(remembered.voiceB || ""),
    [ephemeral, setEphemeral] = useState(!!offRecord),
    [seedOk, setSeedOk] = useState(false),
    [error, setError] = useState(""),
    [quote, setQuote] = useState({ status: "idle" }),
    [run, setRun] = useState(null),
    [result, setResult] = useState(null);
  const controller = useRef(null);
  useEffect(() => () => controller.current?.abort(), []);
  const scriptModels = useMemo(
    () => models.filter((m) => m.type === "chat" && m.callable && !m.imageCapable && !m.sealed),
    [models],
  );
  const [model, setModel] = useState(() => {
    const ids = scriptModels.map((m) => m.id);
    return [remembered.model, ...SCRIPT_MODELS].find((id) => id && ids.includes(id)) || ids[0] || "";
  });
  useEffect(() => {
    if (!model && scriptModels[0]) setModel(scriptModels[0].id);
  }, [scriptModels]);
  useEffect(() => {
    const ctl = new AbortController();
    api("/api/audio/models", { signal: ctl.signal }).then(
      (c) => setCatalog(c.tts || []),
      (e) => !ctl.signal.aborted && setError(e.message),
    );
    return () => ctl.abort();
  }, []);
  const voiceModel = catalog?.find((m) => m.id === tts) || null;
  // A remembered choice that's no longer offered falls back to the first.
  useEffect(() => {
    if (catalog && !voiceModel && catalog[0]) setTts(catalog[0].id);
  }, [catalog, voiceModel]);
  useEffect(() => {
    const voices = voiceModel?.voices || [];
    if (!voiceModel) return;
    const has = (id) => voices.some((v) => v.id === id);
    const a = has(voiceA) ? voiceA : voices[0]?.id || "";
    setVoiceA(a);
    setVoiceB((b) => (has(b) && (b !== a || voices.length < 2) ? b : voices.find((v) => v.id !== a)?.id || a));
  }, [voiceModel]);
  // The Voice studio: saved chats to pick from, loaded on first use.
  useEffect(() => {
    if (!pickChats || chats) return;
    api("/api/conversations").then(
      (r) => setChats((r.data || []).filter((c) => ["chat", "code", "uncensored", null, undefined].includes(c.mode))),
      () => setChats([]),
    );
  }, [pickChats]);
  async function openChat(id) {
    setChat({ id, loading: true });
    setError("");
    try {
      const r = await api("/api/conversations/" + encodeURIComponent(id));
      const messages = (r.messages || []).map(messageFromServer);
      const options = [chatSource(messages, r.title), ...messages.filter((m) => m.research && m.content).map(researchSource)];
      setChat({ id, options });
      setPicked("chat:0");
    } catch (e) {
      setChat(null);
      setError(e.message);
    }
  }
  async function pickFile(e) {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    setError("");
    setReading(true);
    try {
      setFile(await readDocumentFile(f, office));
      setPicked("file");
    } catch (err) {
      setError(err.message);
    } finally {
      setReading(false);
    }
  }
  const source =
    picked === "file"
      ? file
      : typeof picked === "string" && picked.startsWith("chat:")
        ? chat?.options?.[Number(picked.slice(5))] || null
        : picked != null
          ? sources[picked]
          : null;
  const seedGuard = config?.releases?.features?.seedguard === true;
  const block = useMemo(() => sourceBlock(source, { veilWords, seedGuard }), [source, veilWords, seedGuard]);
  const blocked = block && !(typeof block === "object" && block.soft && seedOk);
  useEffect(() => setSeedOk(false), [source]);
  const choices = { model, tts, voiceA, voiceB, length, language };
  const ready = !!(source && model && voiceModel && !blocked && (voiceA || !voiceModel.voices?.length));
  const body = useMemo(
    () => (ready ? overviewRequest({ source, choices, offRecord: ephemeral, veilOn: !!veilWords }) : null),
    [ready, source, model, tts, voiceA, voiceB, length, language, ephemeral, !!veilWords],
  );
  const quoteKey = useMemo(() => (body ? JSON.stringify(body) : ""), [body]);
  // The most it can cost, quoted by the server for exactly this request.
  useEffect(() => {
    if (!body || run || result) return setQuote((q) => (q.status === "idle" ? q : { status: "idle" }));
    const ctl = new AbortController();
    setQuote((q) => ({ status: "loading", last: q.status === "ready" ? q : q.last }));
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/audio/overview/quote", { method: "POST", body, signal: ctl.signal });
        setQuote({ status: "ready", ...r });
      } catch (e) {
        if (e?.name !== "AbortError") setQuote({ status: "unavailable", message: e.message });
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [quoteKey, !!run, !!result]);
  async function start() {
    if (!body) return;
    saveStore(CHOICES, choices);
    setError("");
    setResult(null);
    const ctl = new AbortController();
    controller.current = ctl;
    setRun({ stage: "writing", turns: [], voiced: 0, scriptCredits: 0, voiceCredits: 0, length });
    try {
      const done = await runOverview({ ...body, requestId: uid() }, (s) => setRun({ ...s, length }), ctl.signal);
      setResult({ ...done.result, anonyma: done.anonyma });
      if (done.result?.saved) onSaved?.(done.result);
    } catch (e) {
      if (e?.name === "AbortError") {
        setResult(null);
        setError(
          ephemeral
            ? "Stopped. Off the record, nothing was kept. Only finished steps were charged."
            : "Stopped. Anything already voiced is saved to your library. Only finished steps were charged.",
        );
      } else {
        const made = e?.data?.result;
        if (made) {
          setResult({ ...made, anonyma: e.data.anonyma });
          if (made.saved) onSaved?.(made);
        }
        setError(e.message);
        if (e?.data?.anonyma && !made) setResult({ failed: true, anonyma: e.data.anonyma });
      }
    } finally {
      controller.current = null;
      setRun(null);
    }
  }
  if (result && !result.failed)
    return (
      <>
        {error && <Notice type="error">{error}</Notice>}
        <OverviewPlayer overview={result} testMode={!!config?.testMode} />
        <div className="inline-actions">
          <Button secondary onClick={onClose}>
            Close
          </Button>
        </div>
      </>
    );
  if (run) return <OverviewProgress run={run} onStop={() => controller.current?.abort()} />;
  const q = quote.status === "ready" ? quote : quote.last;
  const voices = voiceModel?.voices || [];
  const voiceLabel = (v) => `${v.name}${v.language && v.language !== "multi" ? ` · ${v.language}` : ""}`;
  return (
    <>
      <p className="overview-lede">
        A short two-voice briefing of one source, with a transcript. The hosts use only what the source says.
      </p>
      {error && <Notice type="error">{error}</Notice>}
      {catalog?.length === 0 && <Notice type="error">No voice models are available right now.</Notice>}
      {result?.failed && (
        <p className="overview-fine" role="status">
          {`Charged: ${formatCredits(result.anonyma?.credits_charged || 0)} credits.`}
        </p>
      )}
      <fieldset className="overview-sources">
        <legend>Made from</legend>
        {sources.map((s, i) => (
          <SourceOption key={i} source={s} active={picked === i} onPick={() => setPicked(i)} />
        ))}
        {pickChats && (
          <div className="overview-chat-pick">
            <label>
              <span>Saved chat</span>
              <select
                value={chat?.id || ""}
                disabled={!chats}
                onChange={(e) =>
                  e.target.value ? openChat(e.target.value) : (setChat(null), setPicked(sources.length ? 0 : null))
                }
              >
                <option value="">{chats ? (chats.length ? "Choose a chat…" : "No saved chats yet") : "Loading…"}</option>
                {chats?.map((c) => (
                  <option key={c.id} value={c.id} data-i18n={c.title ? "off" : undefined}>
                    {c.title || "Untitled conversation"}
                  </option>
                ))}
              </select>
            </label>
            {chat?.loading && <p className="overview-fine">Loading the conversation…</p>}
          </div>
        )}
        {chat?.options?.map((o, i) => (
          <SourceOption key={"chat" + i} source={o} active={picked === "chat:" + i} onPick={() => setPicked("chat:" + i)} />
        ))}
        {file && <SourceOption source={file} active={picked === "file"} onPick={() => setPicked("file")} />}
        {pickFiles && (
          <label className={"overview-file" + (reading ? " busy" : "")}>
            <Icon name="upload" size={15} />
            <span>{reading ? "Reading the file…" : file ? "Choose another file" : "Choose a file"}</span>
            <small>
              {office
                ? "PDF, text, Markdown or code, DOCX, XLSX or PPTX. Read in this browser."
                : "PDF, text, Markdown or code. Read in this browser."}
            </small>
            <input type="file" accept={office ? DOCUMENT_ACCEPT : DOCUMENT_ACCEPT.replace(/,\.(docx|xlsx|pptx)/g, "")} disabled={reading} onChange={pickFile} />
          </label>
        )}
        {source?.truncated && (
          <p className="overview-fine">Long source: only the first 120,000 characters are used.</p>
        )}
      </fieldset>
      <div className="overview-grid">
        <fieldset className="overview-length">
          <legend>Length</legend>
          <div role="radiogroup" aria-label="Length">
            {Object.entries(LENGTHS).map(([id, spec]) => (
              <button
                type="button"
                role="radio"
                aria-checked={length === id}
                className={length === id ? "on" : ""}
                key={id}
                onClick={() => setLength(id)}
              >
                {`About ${spec.minutes} min`}
              </button>
            ))}
          </div>
        </fieldset>
        <label>
          <span>Language</span>
          <select value={language} onChange={(e) => setLanguage(e.target.value)}>
            {LANGUAGES.map(([code, , own]) =>
              code === "auto" ? (
                <option key={code} value={code}>
                  Same as the source
                </option>
              ) : (
                <option key={code} value={code} data-i18n="off">
                  {own}
                </option>
              ),
            )}
          </select>
        </label>
        <label>
          <span>Voice model</span>
          <select value={tts} onChange={(e) => setTts(e.target.value)} disabled={!catalog?.length}>
            {!catalog && <option value="">Loading…</option>}
            {catalog?.map((m) => (
              <option key={m.id} value={m.id} data-i18n="off">
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {voices.length > 0 && (
          <>
            <label>
              <span>Host A</span>
              <select value={voiceA} onChange={(e) => setVoiceA(e.target.value)} data-i18n="off">
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {voiceLabel(v)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Host B</span>
              <select value={voiceB} onChange={(e) => setVoiceB(e.target.value)} data-i18n="off">
                {voices.map((v) => (
                  <option key={v.id} value={v.id} disabled={v.id === voiceA && voices.length > 1}>
                    {voiceLabel(v)}
                  </option>
                ))}
              </select>
            </label>
          </>
        )}
        <label>
          <span>Script written by</span>
          <select value={model} onChange={(e) => setModel(e.target.value)} data-i18n="off">
            {scriptModels.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="overview-check">
        <input type="checkbox" checked={ephemeral} disabled={!!offRecord} onChange={(e) => setEphemeral(e.target.checked)} />
        <span>
          Off the record: it plays and downloads here only, and nothing is saved.
          {offRecord && <small>{offRecord}</small>}
        </span>
      </label>
      {block ? (
        <div className="overview-block" role="alert">
          <Icon name="warning" size={14} />
          <span>{typeof block === "object" ? block.message : block}</span>
          {typeof block === "object" && block.soft && !seedOk && (
            <button type="button" className="small-button" onClick={() => setSeedOk(true)}>
              It's not a key, continue
            </button>
          )}
        </div>
      ) : (
        <p className="overview-cost" role="status">
          {!source ? (
            "Choose a source to see the most it can cost."
          ) : q ? (
            <>
              <b>{`Up to ${formatCredits(q.credits)} credits`}</b>
              {` · script up to ${formatCredits(q.steps?.script)}, voices up to ${formatCredits(q.steps?.voices)} for at most ${Number(q.max_characters).toLocaleString("en-US")} characters`}
              {q.available != null && q.credits > q.available && <b className="overview-short"> · over your balance</b>}
            </>
          ) : quote.status === "unavailable" ? (
            quote.message
          ) : (
            "Working out the most it can cost…"
          )}
        </p>
      )}
      <p className="overview-fine">
        Only this source is sent: to the script model, then the script to the voice model. You pay only for what's made, and Stop ends the rest.
      </p>
      <div className="inline-actions">
        <Button onClick={start} disabled={!body || quote.status === "unavailable"}>
          <Icon name="audio" size={15} />
          Make audio overview
        </Button>
        <Button secondary onClick={onClose}>
          Cancel
        </Button>
      </div>
    </>
  );
}

function SourceOption({ source, active, onPick }) {
  const chars = source.text.length;
  return (
    <label className={"overview-source" + (active ? " active" : "")}>
      <input type="radio" name="overview-source" checked={active} onChange={onPick} />
      <Icon name={KIND_ICONS[source.kind] || "file"} size={15} />
      <b data-i18n="off">{source.title}</b>
      <small>{`${KIND_LABELS[source.kind]} · ${chars.toLocaleString("en-US")} characters`}</small>
    </label>
  );
}

// While it's being made: the script, then each turn voiced.
export function OverviewProgress({ run, onStop }) {
  const total = run.turns?.length || 0;
  const charged = Math.round(((run.scriptCredits || 0) + (run.voiceCredits || 0)) * 10000) / 10000;
  const pct = run.stage === "writing" ? 6 : Math.round(8 + (92 * (run.voiced || 0)) / Math.max(1, total));
  return (
    <section className="overview-progress" aria-live="polite">
      <p className="overview-eyebrow">{`AUDIO OVERVIEW · ABOUT ${LENGTHS[run.length]?.minutes || 3} MIN`}</p>
      {run.title && (
        <h3 data-i18n="off">{run.title}</h3>
      )}
      <ol className="overview-steps">
        <li className={run.stage === "writing" ? "active" : "done"}>
          {run.stage === "writing" ? "Writing the script…" : "Script written"}
        </li>
        <li className={run.stage === "writing" ? "" : "active"}>
          {run.stage === "writing" ? "Voices" : `Voicing ${Math.min(run.voiced + 1, total)}/${total}`}
        </li>
      </ol>
      <div className="overview-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: pct + "%" }} />
      </div>
      <p className="overview-fine">{`Charged so far: ${formatCredits(charged)} credits`}</p>
      {total > 0 && (
        <ol className="overview-transcript compact">
          {run.turns.map((t, i) => (
            <li key={i} className={i < run.voiced ? "voiced" : i === run.voiced ? "current" : ""}>
              <span className={"overview-host host-" + t.speaker}>{t.speaker}</span>
              <p data-i18n="off">{t.text}</p>
            </li>
          ))}
        </ol>
      )}
      <div className="inline-actions">
        <Button secondary onClick={onStop}>
          <Icon name="stop" size={13} />
          Stop
        </Button>
      </div>
    </section>
  );
}

// A saved overview, loaded for the player.
function SavedOverview({ id, onClose }) {
  const [overview, setOverview] = useState(null),
    [error, setError] = useState("");
  useEffect(() => {
    const ctl = new AbortController();
    api("/api/audio/overview/" + encodeURIComponent(id), { signal: ctl.signal }).then(
      (r) => setOverview(r),
      (e) => !ctl.signal.aborted && setError(e.message),
    );
    return () => ctl.abort();
  }, [id]);
  return (
    <>
      {error && <Notice type="error">{error}</Notice>}
      {!overview && !error && <p className="overview-fine">Loading the overview…</p>}
      {overview && <OverviewPlayer overview={overview} />}
      <div className="inline-actions">
        <Button secondary onClick={onClose}>
          Close
        </Button>
      </div>
    </>
  );
}

const base64Blob = (data, mime) => {
  const bin = atob(data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
};
const extension = (mime) => (mime === "audio/mpeg" ? "mp3" : mime?.includes("wav") ? "wav" : mime?.split("/")[1] || "audio");
const fileName = (title, ext) =>
  (String(title || "audio-overview").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "audio-overview") +
  "." + ext;

// Joins playlist clips into one WAV in this browser, for a voice model
// whose format the server can't simply join.
async function joinClips(blobs) {
  const Context = window.AudioContext || window.webkitAudioContext;
  const ctx = new Context();
  try {
    const decoded = [];
    for (const b of blobs) decoded.push(await ctx.decodeAudioData(await b.arrayBuffer()));
    const rate = decoded[0].sampleRate;
    const frames = decoded.reduce((n, d) => n + Math.ceil(d.duration * rate), 0);
    const offline = new OfflineAudioContext(1, frames, rate);
    let at = 0;
    for (const d of decoded) {
      const node = offline.createBufferSource();
      node.buffer = d;
      node.connect(offline.destination);
      node.start(at);
      at += d.duration;
    }
    const pcm = (await offline.startRendering()).getChannelData(0);
    const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
    const text = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
    text(0, "RIFF");
    out.setUint32(4, 36 + pcm.length * 2, true);
    text(8, "WAVEfmt ");
    out.setUint32(16, 16, true);
    out.setUint16(20, 1, true);
    out.setUint16(22, 1, true);
    out.setUint32(24, rate, true);
    out.setUint32(28, rate * 2, true);
    out.setUint16(32, 2, true);
    out.setUint16(34, 16, true);
    text(36, "data");
    out.setUint32(40, pcm.length * 2, true);
    pcm.forEach((v, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, v)) * 0x7fff, true));
    return new Blob([out], { type: "audio/wav" });
  } finally {
    ctx.close?.();
  }
}

// The audio with its chapters and transcript. One file seeks to a turn's
// start; a playlist (clips) plays turn by turn.
export function OverviewPlayer({ overview, testMode = false }) {
  const audio = useRef(null);
  const [time, setTime] = useState(0),
    [clip, setClip] = useState(0),
    [copied, setCopied] = useState(false),
    [joining, setJoining] = useState(false);
  const playlist = Array.isArray(overview.clips) && overview.clips.length > 0;
  const blobs = useMemo(
    () => (playlist ? overview.clips.map((c) => base64Blob(c.data, c.mime)) : overview.audio ? [base64Blob(overview.audio.data, overview.audio.mime)] : []),
    [overview],
  );
  const urls = useMemo(() => blobs.map((b) => URL.createObjectURL(b)), [blobs]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  const src = overview.media?.url || (playlist ? urls[clip] : urls[0]);
  const turns = overview.turns || [];
  const chapters = overview.chapters || [];
  const current = playlist ? clip : turnAt(turns, time);
  const chapter = chapterOf(chapters, Math.max(0, current));
  function seek(i) {
    const el = audio.current;
    if (!el) return;
    if (playlist) {
      setClip(i);
      requestAnimationFrame(() => audio.current?.play().catch(() => {}));
      return;
    }
    if (Number.isFinite(turns[i]?.start)) {
      el.currentTime = turns[i].start;
      el.play().catch(() => {});
    }
  }
  async function saveFile() {
    if (overview.media?.url) {
      const a = document.createElement("a");
      a.href = overview.media.url + "?download=1";
      a.download = fileName(overview.title, extension(overview.media.mime));
      a.click();
      return;
    }
    let blob = blobs[0];
    if (playlist) {
      setJoining(true);
      try {
        blob = await joinClips(blobs);
      } finally {
        setJoining(false);
      }
    }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName(overview.title, extension(blob.type));
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const transcript = () =>
    [overview.title, "", ...turns.map((t) => `${t.speaker === "A" ? "Host A" : "Host B"}: ${t.text}`)].join("\n");
  const voices = overview.voices || {};
  const receipt = overview.anonyma;
  return (
    <section className="overview-player">
      <div className="overview-player-head">
        <span className="overview-tile" aria-hidden="true">
          <Icon name="audio" size={18} />
        </span>
        <div>
          <p className="overview-eyebrow">AUDIO OVERVIEW</p>
          <h3 data-i18n="off">{overview.title}</h3>
          <p className="overview-meta">
            {Number.isFinite(overview.duration) && <span>{formatClock(overview.duration)}</span>}
            <span>{chapters.length === 1 ? "1 chapter" : `${chapters.length} chapters`}</span>
            {(voices.A || voices.B) && (
              <span>
                <span className="overview-host host-A">A</span>
                <span data-i18n="off">{voices.A}</span>
                <span className="overview-host host-B">B</span>
                <span data-i18n="off">{voices.B}</span>
              </span>
            )}
          </p>
        </div>
      </div>
      <audio
        ref={audio}
        controls
        preload="metadata"
        src={src}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onEnded={() => playlist && clip < urls.length - 1 && seek(clip + 1)}
      />
      {chapters.length > 0 && (
        <ol className="overview-chapters" aria-label="Chapters">
          {chapters.map((c, i) => (
            <li key={i}>
              <button type="button" className={i === chapter ? "on" : ""} onClick={() => seek(c.turn)}>
                <span className="overview-chapter-n">{String(i + 1).padStart(2, "0")}</span>
                <span data-i18n="off">{c.title}</span>
                {!playlist && Number.isFinite(turns[c.turn]?.start) && (
                  <span className="overview-chapter-t">{formatClock(turns[c.turn].start)}</span>
                )}
              </button>
            </li>
          ))}
        </ol>
      )}
      <ol className="overview-transcript" aria-label="Transcript">
        {turns.map((t, i) => (
          <li key={i} className={i === current ? "current" : ""}>
            <button type="button" onClick={() => seek(i)} aria-label={`Play from turn ${i + 1}`}>
              <span className={"overview-host host-" + t.speaker}>{t.speaker}</span>
            </button>
            <p data-i18n="off">{t.text}</p>
          </li>
        ))}
      </ol>
      <div className="inline-actions">
        <Button onClick={saveFile} disabled={joining}>
          <Icon name="download" size={15} />
          {joining ? "Joining the clips…" : "Download"}
        </Button>
        <Button
          secondary
          onClick={async () => {
            setCopied(await copyText(transcript()));
            setTimeout(() => setCopied(false), 1600);
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={15} />
          {copied ? "Copied" : "Copy transcript"}
        </Button>
      </div>
      <ul className="overview-notes">
        {overview.saved ? (
          <li>
            <Icon name="check" size={13} />
            <span>Saved to your library with its transcript. Deleting it there deletes both.</span>
          </li>
        ) : playlist ? (
          <li>
            <Icon name="warning" size={13} />
            <span>
              This voice model's audio can't be joined on our server, so it plays here turn by turn and isn't saved. Download joins it in this browser.
            </span>
          </li>
        ) : (
          overview.audio && (
            <li>
              <Icon name="shield" size={13} />
              <span>{overview.save_error || "Off the record: nothing was saved. Download it before you close this."}</span>
            </li>
          )
        )}
        {overview.status === "partial" && (
          <li>
            <Icon name="warning" size={13} />
            <span>Stopped early: only the turns above were voiced and charged.</span>
          </li>
        )}
        {overview.status === "stopped" && (
          <li>
            <Icon name="warning" size={13} />
            <span>Stopped before the end: only the turns above were voiced and charged.</span>
          </li>
        )}
        <li>
          <Icon name="shield" size={13} />
          <span>Written by a model from your source only. Check anything important against the source.</span>
        </li>
      </ul>
      {receipt && (
        <div className="receipt">
          <span className="sq" aria-hidden="true" />
          {`${receipt.local_test || testMode ? "Test receipt" : "Receipt"} · ${formatCredits(receipt.credits_charged)} credits charged · script ${formatCredits(receipt.steps?.script)}, voices ${formatCredits(receipt.steps?.voices)}`}
        </div>
      )}
    </section>
  );
}
