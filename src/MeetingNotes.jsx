import React, { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Icon, Notice } from "./ui.jsx";
import { api, ApiError, uid, isReleased, readStore, saveStore, download, copyText, spendingLimitMessage } from "./lib.js";
import { readChatEvents } from "./stream.js";
import { formatCredits } from "./estimate.js";
import { formatBytes } from "./documents.js";
import { getLanguage } from "./i18n.js";
import { createVeilState, veil, unveil, saveVeilState, loadVeilState } from "./veil.js";
import { VeilToggle } from "./Veil.jsx";
import { scanSecrets, seedGuardMessage, isSoft } from "./seed-guard.js";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { CleanNote } from "./CleanUploads.jsx";
import { cleanUpload, AUDIO_EXTENSIONS } from "./clean-uploads.js";
import { pickPreset } from "./model-finder.js";
import { vaultChat } from "./device-vault.js";
import { openRecording, encodeWav16, dataUrl, RECORDING_ACCEPT, RecordingError } from "./meeting-audio.js";
import {
  MEETING_PRIVATE,
  NOTE_LANGUAGES,
  SPOKEN,
  clock,
  fileStem,
  fitTranscript,
  lengthLabel,
  maskSegments,
  notesMarkdown,
  notesPrompt,
  plainTranscript,
  planChunks,
  quietestPoint,
  restoreNotes,
  srtTranscript,
  stamp,
  transcriptFromMarkdown,
} from "./meeting-notes.js";
import "./meeting-notes.css";

// Meeting Notes (update "meetingnotes"): the page at /workspace/notes. A
// recording is read in this browser (src/meeting-audio.js) and cut into
// pieces of at most five minutes; each piece's sound goes to the
// transcription model, then the timed transcript (Veil-masked when Veil is
// on) goes to a text model for the notes. server/routes/meeting-notes.js
// holds exactly the quoted maximum and charges each finished step. The
// saved notes are an ordinary conversation, reopened here with ?c=.

const CHOICES = "meeting-notes:choices";
// A fast, inexpensive text model with a long context writes the notes
// unless another is picked (and remembered in this browser).
const NOTES_MODELS = ["gemini-3.7-flash", "google/gemini-2.5-flash", "deepseek/deepseek-v4.1-flash", "gpt-5.4-mini", "claude-haiku-4.5"];
const CLEAN_CHECK_BYTES = 64 * 1024 * 1024;
const STOPPED = "Stopped. Pieces already transcribed are charged; nothing else is.";

// A run's events into one state (the notes step streams). Resolves with
// the final event, or throws an ApiError carrying the event.
async function readFinish(response) {
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) {
    let error;
    try {
      error = await response.json();
    } catch {}
    throw new ApiError(spendingLimitMessage(error) || error?.error?.message || "Meeting notes are unavailable right now.", response.status, error?.error?.code, { ...error, refused: true });
  }
  for await (const event of readChatEvents(response)) {
    if (event.error) throw new ApiError(event.error.message || "The notes stopped.", 200, event.error.code, event);
    if (event.meeting?.stage === "done") return event;
  }
  throw new ApiError("The connection ended before the notes arrived.", 0, "stream_error");
}

export default function MeetingNotes({
  demo,
  user,
  models = [],
  config,
  refresh,
  veilOn,
  setVeilOn,
  veilWords,
  vault,
  vaultLive,
  onUnlockVault,
  projects = [],
}) {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const savedId = params.get("c");
  const live = !demo && !!user;
  const remembered = useMemo(() => readStore(CHOICES, {}) || {}, []);
  const veilLive = isReleased(config, "veil");
  const veiling = veilLive && live && !!veilOn;
  const trailLive = privacyTrailReleased(config);
  const seedGuard = isReleased(config, "seedguard");
  const offRecordLive = isReleased(config, "ephemeral");
  const projectsLive = isReleased(config, "projects");
  const cleanLive = isReleased(config, "cleanuploads");
  const uncensored = config?.releases?.uncensoredModels || [];

  const [file, setFile] = useState(null),
    [rec, setRec] = useState(null),
    [plan, setPlan] = useState(null),
    [reading, setReading] = useState(false),
    [fileError, setFileError] = useState(""),
    [clean, setClean] = useState(null),
    [dragging, setDragging] = useState(false),
    [catalog, setCatalog] = useState(null),
    [stt, setStt] = useState(remembered.stt || "nova-3"),
    [spoken, setSpoken] = useState(SPOKEN.some(([c]) => c === remembered.spoken) ? remembered.spoken : getLanguage() === "zh" ? "zh" : "en"),
    [notesLanguage, setNotesLanguage] = useState(NOTE_LANGUAGES.some(([c]) => c === remembered.notesLanguage) ? remembered.notesLanguage : "auto"),
    [save, setSave] = useState(["history", "device", "none"].includes(remembered.save) ? remembered.save : "history"),
    [project, setProject] = useState(""),
    [quote, setQuote] = useState({ status: "idle" }),
    [run, setRun] = useState(null),
    [result, setResult] = useState(null),
    [error, setError] = useState("");
  const input = useRef(null),
    // Seed Guard's "It's not a key, continue" for this run's transcript.
    seedOk = useRef(false),
    controller = useRef(null),
    veilState = useRef(createVeilState()),
    mounted = useRef(true),
    // The run in progress, so leaving the page ends it at once (releasing
    // what it still holds) instead of after 30 idle minutes.
    runId = useRef(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (runId.current)
        fetch(`/api/meeting-notes/${encodeURIComponent(runId.current)}`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => {});
    };
  }, []);

  // The notes models: text models this account can call here.
  const choices = useMemo(
    () => models.filter((m) => m.type === "chat" && m.callable && !m.imageCapable && !m.sealed && !uncensored.includes(m.id)),
    [models, config],
  );
  const [model, setModel] = useState("");
  useEffect(() => {
    const ids = choices.map((m) => m.id);
    setModel((prev) =>
      ids.includes(prev)
        ? prev
        : [remembered.model, ...NOTES_MODELS].find((id) => id && ids.includes(id)) ||
          pickPreset(choices, "balanced", { mode: "chat" })?.id ||
          ids[0] ||
          "",
    );
  }, [choices]);
  const modelName = choices.find((m) => m.id === model)?.name || model;
  // The transcription models, from Voice & Audio's catalog.
  useEffect(() => {
    if (!live) return;
    const ctl = new AbortController();
    api("/api/audio/models", { signal: ctl.signal }).then(
      (c) => {
        setCatalog(c.stt || []);
        setStt((prev) => ((c.stt || []).some((m) => m.id === prev) ? prev : c.stt?.[0]?.id || ""));
      },
      (e) => !ctl.signal.aborted && setCatalog([]),
    );
    return () => ctl.abort();
  }, [live]);
  const sttModel = catalog?.find((m) => m.id === stt) || null;
  const vaultOpen = vaultLive && vault?.unlocked;
  const saveTarget = save === "device" && !vaultLive ? "history" : save === "none" && !offRecordLive ? "history" : save;
  const ephemeral = saveTarget !== "history";

  // ---- Reading the recording ----
  async function pick(f) {
    if (!f || reading || run) return;
    if (!live) {
      setFileError(demo ? "The demo doesn't transcribe recordings. Sign in to make meeting notes." : "Sign in to make meeting notes.");
      return;
    }
    setFileError("");
    setError("");
    setResult(null);
    setRec(null);
    setPlan(null);
    setClean(null);
    setFile(f);
    setReading(true);
    try {
      const opened = await openRecording(f);
      // Cut at the quietest moment near each five-minute mark.
      const pieces = await planChunks(opened.duration, {
        quiet: async (from, to) => from + (quietestPoint(await opened.read(from, to)) ?? to - from),
      });
      if (!mounted.current) return;
      setRec(opened);
      setPlan(pieces);
      // Clean Uploads: what the file carries that isn't sent (the pieces
      // are plain sound, so none of it can be).
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (cleanLive && AUDIO_EXTENSIONS.includes(ext) && f.size <= CLEAN_CHECK_BYTES)
        cleanUpload(new Uint8Array(await f.arrayBuffer()), { name: f.name }).then(
          (r) => mounted.current && setClean(r.status === "failed" ? null : r),
          () => {},
        );
    } catch (e) {
      if (!mounted.current) return;
      setFile(null);
      setFileError(e instanceof RecordingError ? e.message : "This recording couldn't be read in this browser. Try MP3, M4A or WAV.");
    } finally {
      if (mounted.current) setReading(false);
    }
  }
  function onDrop(e) {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) pick(f);
  }

  // ---- The quote: exactly what a start would hold ----
  const body = useMemo(() => {
    if (!rec || !plan || !model || !stt) return null;
    return {
      duration: plan.reduce((n, p) => n + p.samples, 0) / 16000,
      chunks: plan.map((p) => p.seconds),
      stt,
      ...(spoken ? { language: spoken } : {}),
      model,
      notes_language: notesLanguage,
      ...(ephemeral ? { ephemeral: true } : {}),
      ...(saveTarget === "history" && projectsLive && project ? { project } : {}),
    };
  }, [rec, plan, model, stt, spoken, notesLanguage, ephemeral, saveTarget, project, projectsLive]);
  const quoteKey = body ? JSON.stringify(body) : "";
  useEffect(() => {
    if (!body || run || result) return setQuote((q) => (q.status === "idle" ? q : { status: "idle" }));
    const ctl = new AbortController();
    setQuote((q) => ({ status: "loading", last: q.status === "ready" ? q : q.last }));
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/meeting-notes/quote", { method: "POST", body, signal: ctl.signal });
        setQuote({ status: "ready", ...r });
      } catch (e) {
        if (e?.name !== "AbortError") setQuote({ status: "unavailable", message: e.message });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [quoteKey, !!run, !!result]);
  const q = quote.status === "ready" ? quote : quote.status === "loading" ? quote.last : null;

  // ---- Running ----
  const patchRun = (patch) => mounted.current && setRun((r) => (r ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r));
  async function start() {
    if (!body || run) return;
    saveStore(CHOICES, { model, stt, spoken, notesLanguage, save });
    setError("");
    setResult(null);
    seedOk.current = false;
    veilState.current = createVeilState();
    try {
      const r = await api("/api/meeting-notes", { method: "POST", body: { ...body, requestId: uid() } });
      const next = {
        id: r.id,
        pieces: r.pieces,
        stt: r.stt,
        reserved: r.reserved,
        done: 0,
        charged: 0,
        segments: [],
        stage: "transcribing",
        current: 0,
      };
      runId.current = r.id;
      setRun(next);
      await transcribe(next, 0);
    } catch (e) {
      setError(e.message);
    }
  }
  // Transcribes pieces from `from` on, one at a time.
  async function transcribe(state, from) {
    const ctl = new AbortController();
    controller.current = ctl;
    let segments = state.segments,
      lost = state.lost || [];
    for (let i = from; i < state.pieces.length; i++) {
      const piece = state.pieces[i];
      patchRun({ stage: "transcribing", current: i, error: "" });
      try {
        const samples = await rec.read(piece.start, piece.start + piece.seconds);
        const audio = await dataUrl(encodeWav16(samples));
        if (ctl.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const r = await api(`/api/meeting-notes/${encodeURIComponent(state.id)}/pieces/${i}`, {
          method: "POST",
          body: { audio },
          signal: ctl.signal,
        });
        segments = [...segments, ...r.segments.map((s) => ({ ...s, piece: i }))];
        patchRun({ segments, done: r.done, charged: r.charged });
      } catch (e) {
        // Transcribed (and charged) already, but its answer never arrived:
        // go on without its text, and say so.
        if (e?.code === "piece_done") {
          lost = [...lost, i];
          patchRun({ lost });
          continue;
        }
        controller.current = null;
        if (e?.name === "AbortError" || ctl.signal.aborted) {
          patchRun({ stage: "stopped", segments, error: STOPPED });
          return;
        }
        if (e?.code === "meeting_not_found") runId.current = null;
        patchRun({
          stage: "failed",
          failedAt: i,
          segments,
          error: e.message,
          ended: e?.code === "meeting_not_found",
        });
        return;
      }
    }
    controller.current = null;
    await finish({ ...state, segments, lost });
  }
  // The notes step (or the transcript alone, with `skip`).
  async function finish(state, { skip = false } = {}) {
    const segments = [...state.segments].sort((a, b) => a.start - b.start).map(({ piece, ...s }) => s);
    if (!segments.length) {
      await discard(state, "No speech was found in this recording, so there's nothing to make notes from.");
      return;
    }
    // Seed Guard: the transcript won't go to a model or be kept.
    if (seedGuard && !skip) {
      const hit = scanSecrets(segments.map((s) => s.text));
      if (hit && !(isSoft(hit) && seedOk.current)) {
        patchRun({ stage: "seed", segments: state.segments, seed: { message: seedGuardMessage(hit), soft: isSoft(hit) } });
        return;
      }
    }
    const masked = veiling ? maskSegments(segments, (t) => veil(t, veilState.current, veilWords || [])) : { segments, count: 0 };
    patchRun({ stage: skip ? "saving" : "writing", segments: state.segments, error: "", sent: masked.segments, masked: masked.count });
    const ctl = new AbortController();
    controller.current = ctl;
    try {
      const response = await fetch(`/api/meeting-notes/${encodeURIComponent(state.id)}/finish`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          segments: masked.segments,
          ...(trailLive ? { veil_masked: veiling ? masked.count : null } : {}),
          headings: getLanguage() === "zh" ? "zh" : "en",
          ...(skip ? { skip_notes: true } : {}),
        }),
        signal: ctl.signal,
      });
      const done = await readFinish(response);
      controller.current = null;
      await finished(state, segments, masked, done);
    } catch (e) {
      controller.current = null;
      if (e?.name === "AbortError") {
        // Stopping the notes ends the run on the server too.
        runId.current = null;
        patchRun({ stage: "stopped", ended: true, error: "Stopped. The notes weren't made, and nothing was charged for them." });
        return;
      }
      const retry = e?.data?.error?.retry === true;
      if (!retry) runId.current = null;
      patchRun({ stage: "notes_failed", error: e.message, retry, ended: !retry, charged: e?.data?.anonyma?.steps?.transcription ?? state.charged });
    }
  }
  async function finished(state, segments, masked, done) {
    const r = done.result || {};
    const restore = (s) => (masked.count ? unveil(s, veilState.current.map) : s);
    const notes = r.notes ? restoreNotes(r.notes, restore) : null;
    let vaultId = null,
      vaultError = "";
    // Veil's map for the saved notes stays in this browser, under the
    // conversation's id, so the chat shows the real details again.
    if (r.conversationId && masked.count) saveVeilState(r.conversationId, veilState.current);
    if (saveTarget === "device" && vaultOpen) {
      // Device Vault: sealed here, never on the server.
      try {
        vaultId = uid();
        const markdown = notesMarkdown({
          title: r.notes?.title || r.title,
          duration: body.duration,
          notes: r.notes,
          segments: masked.segments,
          stt: state.stt?.name,
          model: modelName,
          lang: getLanguage() === "zh" ? "zh" : "en",
          cutAt: r.cut_at,
        });
        const asked = getLanguage() === "zh" ? `会议纪要 · ${clock(body.duration)} 录音` : `Meeting notes · ${clock(body.duration)} recording`;
        await vault.save(
          vaultChat({
            id: vaultId,
            mode: "chat",
            messages: [
              { role: "user", content: asked },
              { role: "assistant", content: markdown },
            ],
            veil: masked.count ? veilState.current : null,
            created: Date.now(),
          }),
        );
      } catch (e) {
        vaultId = null;
        vaultError = e?.message || "The notes couldn't be kept in Device Vault. Export them before you leave.";
      }
    }
    runId.current = null;
    if (!mounted.current) return;
    setRun(null);
    setResult({
      live: true,
      title: notes?.title || r.title || "",
      notes,
      segments,
      duration: body.duration,
      stt: state.stt,
      model: r.notes ? { id: model, name: modelName } : null,
      saved: r.saved,
      conversationId: r.conversationId,
      vaultId,
      vaultError,
      ephemeral,
      cutAt: r.cut_at,
      ownersDropped: r.owners_dropped || 0,
      anonyma: done.anonyma,
      sent: r.lines_sent != null ? masked.segments.slice(0, r.lines_sent) : null,
      masked: masked.count,
      notesLanguage,
    });
    // A reload opens what's on screen.
    if (r.conversationId) {
      const next = new URLSearchParams(params);
      next.set("c", r.conversationId);
      setParams(next, { replace: true });
    }
    refresh?.();
  }
  async function discard(state, message = "") {
    controller.current?.abort();
    runId.current = null;
    try {
      if (state?.id) await api(`/api/meeting-notes/${encodeURIComponent(state.id)}`, { method: "DELETE" });
    } catch {}
    if (!mounted.current) return;
    setRun(null);
    setError(message);
    refresh?.();
  }
  function reset() {
    setRun(null);
    setResult(null);
    setFile(null);
    setRec(null);
    setPlan(null);
    setClean(null);
    setError("");
    if (params.get("c")) {
      const next = new URLSearchParams(params);
      next.delete("c");
      setParams(next, { replace: true });
    }
  }

  const showSaved = savedId && !(result && result.conversationId === savedId);
  const compact = !!(run || result || showSaved);
  return (
    <section
      className={"meeting-page" + (dragging ? " dragging" : "")}
      onDragOver={(e) => {
        if (run || result || showSaved) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget) || setDragging(false)}
      onDrop={(e) => (run || result || showSaved ? e.preventDefault() : onDrop(e))}
    >
      <div className={"meeting-head" + (compact ? " compact" : "")}>
        <div>
          <p className="eyebrow">MEETING NOTES</p>
          <h1>Meeting notes</h1>
          <p>Drop a recording. Get a timestamped transcript, the decisions and the action items.</p>
        </div>
        {(result || showSaved) && (
          <button type="button" className="meeting-secondary" onClick={reset}>
            <Icon name="plus" size={14} />
            New recording
          </button>
        )}
      </div>
      {showSaved ? (
        <SavedNotes id={savedId} models={models} testMode={!!config?.testMode} onMissing={reset} />
      ) : result ? (
        <NotesView result={result} file={file} models={models} testMode={!!config?.testMode} navigate={navigate} />
      ) : run ? (
        <Progress
          run={run}
          plan={plan}
          onStop={() => controller.current?.abort()}
          onRetry={() => transcribe(run, run.failedAt ?? run.done)}
          onNotes={() => finish(run)}
          onRetryNotes={() => finish(run)}
          onTranscriptOnly={() => finish(run, { skip: true })}
          onDiscard={() => discard(run, "Discarded. Pieces already transcribed are charged; the rest was released.")}
          onSeedOk={() => {
            seedOk.current = true;
            finish(run);
          }}
          saveTarget={saveTarget}
        />
      ) : (
        <>
          <input
            ref={input}
            type="file"
            hidden
            accept={RECORDING_ACCEPT}
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              pick(f);
            }}
          />
          {error && <Notice type="error">{error}</Notice>}
          {!rec ? (
            <>
              <div className={"meeting-drop" + (dragging ? " dragging" : "") + (reading ? " busy" : "")}>
                <span className="meeting-drop-icon" aria-hidden="true">
                  <Icon name="mic" size={22} />
                </span>
                <b>{reading ? "Reading the recording on this device…" : "Drop a recording here"}</b>
                {reading && file ? (
                  <small data-i18n="off">{file.name}</small>
                ) : (
                  <small>MP3, M4A, WAV, WebM or OGG, or an MP4 or MOV video. Up to 3 hours.</small>
                )}
                <button type="button" className="button" disabled={reading} onClick={() => input.current?.click()}>
                  <Icon name="upload" size={15} />
                  Choose a recording
                </button>
                {fileError && (
                  <p className="meeting-drop-error" role="alert">
                    <Icon name="warning" size={14} />
                    {fileError}
                  </p>
                )}
              </div>
              <ul className="meeting-promises">
                <li>
                  <b>Only the sound goes out</b>
                  <span>The file is read in this browser. Its sound goes to the transcription provider in pieces of up to five minutes; the file, its name, tags and any video stay here.</span>
                </li>
                <li>
                  <b>Nothing kept you didn't ask for</b>
                  <span>ANONYMA doesn't store the recording. The transcript and notes are saved to History, to this device, or nowhere.</span>
                </li>
                <li>
                  <b>The maximum, first</b>
                  <span>See the most it can cost before you start; that's exactly what's held. A piece that fails costs nothing.</span>
                </li>
              </ul>
            </>
          ) : (
            <Setup
              file={file}
              rec={rec}
              plan={plan}
              clean={clean}
              catalog={catalog}
              stt={stt}
              setStt={setStt}
              sttModel={sttModel}
              spoken={spoken}
              setSpoken={setSpoken}
              choices={choices}
              model={model}
              setModel={setModel}
              notesLanguage={notesLanguage}
              setNotesLanguage={setNotesLanguage}
              save={saveTarget}
              setSave={setSave}
              offRecordLive={offRecordLive}
              vaultLive={vaultLive}
              vault={vault}
              onUnlockVault={onUnlockVault}
              projects={projectsLive ? projects : []}
              project={project}
              setProject={setProject}
              veilLive={veilLive}
              veilOn={!!veilOn}
              setVeilOn={setVeilOn}
              quote={quote}
              q={q}
              canStart={!!body && quote.status === "ready" && (saveTarget !== "device" || vaultOpen)}
              onStart={start}
              onChange={() => input.current?.click()}
            />
          )}
        </>
      )}
    </section>
  );
}

// ---- Before it starts ----

function Setup({
  file,
  rec,
  plan,
  clean,
  catalog,
  stt,
  setStt,
  sttModel,
  spoken,
  setSpoken,
  choices,
  model,
  setModel,
  notesLanguage,
  setNotesLanguage,
  save,
  setSave,
  offRecordLive,
  vaultLive,
  vault,
  onUnlockVault,
  projects,
  project,
  setProject,
  veilLive,
  veilOn,
  setVeilOn,
  quote,
  q,
  canStart,
  onStart,
  onChange,
}) {
  const provider = q?.stt?.provider || sttModel?.provider || "";
  const sttName = q?.stt?.name || sttModel?.name || stt;
  return (
    <div className="meeting-setup">
      <div className="meeting-file">
        <span className="meeting-drop-icon" aria-hidden="true">
          <Icon name={rec.video ? "video" : "mic"} size={20} />
        </span>
        <div className="meeting-file-text">
          <b data-i18n="off">{file.name}</b>
          <small>{`${clock(rec.duration)} · ${rec.format} · ${formatBytes(file.size)}`}</small>
          {rec.video && <small>Only its sound is read. The picture never leaves this device.</small>}
          <small>
            {plan.length === 1 ? "Sent as 1 piece of plain sound" : `Sent as ${plan.length} pieces of plain sound, cut at quiet moments`}
          </small>
          {clean && <CleanNote result={clean} notSent />}
        </div>
        <button type="button" className="meeting-secondary" onClick={onChange}>
          Choose another
        </button>
      </div>
      <div className="meeting-options">
        <label>
          <span>Spoken language</span>
          <select value={spoken} onChange={(e) => setSpoken(e.target.value)}>
            {SPOKEN.map(([code, , own]) =>
              code === "multi" ? (
                <option key={code} value={code}>
                  Several languages
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
          <span>Transcribed by</span>
          <select value={stt} disabled={!catalog?.length} onChange={(e) => setStt(e.target.value)}>
            {!catalog && <option value="">Loading…</option>}
            {catalog?.length === 0 && <option value="">No transcription models right now</option>}
            {catalog?.map((m) => (
              <option key={m.id} value={m.id} data-i18n="off">
                {`${m.name} · ${formatCredits(m.credits_per_minute)} / min`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Notes written by</span>
          <select value={model} disabled={!choices.length} onChange={(e) => setModel(e.target.value)} data-i18n="off">
            {choices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Notes in</span>
          <select value={notesLanguage} onChange={(e) => setNotesLanguage(e.target.value)}>
            {NOTE_LANGUAGES.map(([code, , own]) =>
              code === "auto" ? (
                <option key={code} value={code}>
                  Same as the recording
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
          <span>Keep the notes</span>
          <select value={save} onChange={(e) => setSave(e.target.value)}>
            <option value="history">In History</option>
            {vaultLive && <option value="device">On this device only (Device Vault)</option>}
            {offRecordLive && <option value="none">Nowhere (off the record)</option>}
          </select>
        </label>
        {save === "history" && projects.length > 0 && (
          <label>
            <span>Project</span>
            <select value={project} onChange={(e) => setProject(e.target.value)}>
              <option value="">No project</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id} data-i18n="off">
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {save === "device" && vault?.status !== "unavailable" && !vault?.unlocked && (
        <div className="meeting-inline">
          <Icon name="lock" size={14} />
          <span>{vault?.status === "none" ? "Set up Device Vault to keep the notes on this device." : "Unlock Device Vault to keep the notes on this device."}</span>
          <button type="button" className="small-button" onClick={onUnlockVault}>
            {vault?.status === "none" ? "Set up" : "Unlock"}
          </button>
        </div>
      )}
      {veilLive && (
        <div className="meeting-veil">
          <VeilToggle on={veilOn} onToggle={() => setVeilOn?.((v) => !v)} />
          <span>{veilOn ? "Veil masks emails, numbers and keys in the transcript before the notes model sees it, and puts them back here." : "Veil is off: the notes model sees the transcript as it was heard."}</span>
        </div>
      )}
      <p className="meeting-cost" role="status">
        {q ? (
          <>
            <b>{`Up to ${formatCredits(q.credits)} credits`}</b>
            {` · transcription up to ${formatCredits(q.steps?.transcription)} (${formatCredits(q.minutes)} min at ${formatCredits(q.credits_per_minute)} / min), notes up to ${formatCredits(q.steps?.notes)}`}
            {q.available != null && q.credits > q.available && <b className="meeting-short"> · over your balance</b>}
          </>
        ) : quote.status === "unavailable" ? (
          quote.message
        ) : (
          "Working out the most it can cost…"
        )}
      </p>
      {q?.covers_seconds != null && (
        <p className="meeting-fine warn">
          <Icon name="warning" size={13} />
          {`This model can read about the first ${lengthLabel(q.covers_seconds)} of the transcript. Pick a model with a longer context to cover all of it.`}
        </p>
      )}
      <p className="meeting-fine stacked">
        <span>
          {provider
            ? `The recording's sound goes to ${provider} (${sttName}) to be transcribed. ANONYMA doesn't keep it. The transcript then goes to the notes model.`
            : `The recording's sound goes to the transcription provider (${sttName}). ANONYMA doesn't keep it. The transcript then goes to the notes model.`}
        </span>
        <span>{MEETING_PRIVATE}</span>
      </p>
      <div className="meeting-actions">
        <button type="button" className="button" disabled={!canStart} onClick={onStart}>
          <Icon name="mic" size={15} />
          Transcribe and write notes
        </button>
      </div>
    </div>
  );
}

// ---- While it runs ----

function Progress({ run, onStop, onRetry, onNotes, onRetryNotes, onTranscriptOnly, onDiscard, onSeedOk, saveTarget }) {
  const total = run.pieces.length;
  const list = useRef(null);
  const segments = useMemo(() => [...run.segments].sort((a, b) => a.start - b.start), [run.segments]);
  const duration = run.pieces.reduce((n, p) => n + p.seconds, 0);
  const heard = run.pieces.filter((p, i) => i < run.done).reduce((n, p) => n + p.seconds, 0);
  const pct = run.stage === "writing" || run.stage === "saving" ? 96 : Math.round(4 + (88 * run.done) / Math.max(1, total));
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [segments.length]);
  const busy = run.stage === "transcribing" || run.stage === "writing" || run.stage === "saving";
  return (
    <section className="meeting-progress" aria-live="polite">
      <div className="meeting-progress-head">
        <div>
          <p className="meeting-eyebrow">
            {run.stage === "writing"
              ? "WRITING THE NOTES"
              : run.stage === "saving"
                ? "SAVING THE TRANSCRIPT"
                : run.stage === "transcribing"
                  ? `TRANSCRIBING · PIECE ${Math.min(run.current + 1, total)} OF ${total}`
                  : "PAUSED"}
          </p>
          <h3>{`${clock(heard)} of ${clock(duration)} transcribed`}</h3>
        </div>
        {busy && (
          <button type="button" className="meeting-secondary" onClick={onStop}>
            <Icon name="stop" size={13} />
            Stop
          </button>
        )}
      </div>
      <div className="meeting-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: pct + "%" }} />
      </div>
      <ol className="meeting-pieces" aria-label="Pieces">
        {run.pieces.map((p, i) => (
          <li
            key={i}
            className={i < run.done ? "done" : i === run.current && run.stage === "transcribing" ? "current" : i === run.failedAt && run.stage === "failed" ? "failed" : ""}
            title={`${clock(p.start)}–${clock(p.start + p.seconds)}`}
          />
        ))}
      </ol>
      <p className="meeting-fine">{`Charged so far: ${formatCredits(run.charged)} credits · held up to ${formatCredits(run.reserved)}`}</p>
      {run.lost?.length > 0 && (
        <Notice>
          {run.lost.length === 1
            ? `Piece ${run.lost[0] + 1} was transcribed, but its text didn't arrive, so that part is missing from the transcript.`
            : `${run.lost.length} pieces were transcribed, but their text didn't arrive, so those parts are missing from the transcript.`}
        </Notice>
      )}
      {run.error && (
        <Notice type={run.stage === "stopped" ? "" : "error"}>
          {run.stage === "failed" && !run.ended ? `Piece ${run.failedAt + 1} of ${total} didn't go through: ${run.error}` : run.error}
        </Notice>
      )}
      {run.stage === "seed" && (
        <div className="meeting-block" role="alert">
          <Icon name="warning" size={14} />
          <span>
            <span>{run.seed.message}</span> <span>It was heard in this recording, so the transcript won't go to a model or be saved. Export it below, or discard it.</span>
          </span>
          {run.seed.soft && (
            <button type="button" className="small-button" onClick={onSeedOk}>
              It's not a key, continue
            </button>
          )}
        </div>
      )}
      <div className="meeting-actions">
        {run.stage === "failed" && !run.ended && (
          <button type="button" className="button" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            Retry this piece
          </button>
        )}
        {(run.stage === "stopped" || run.stage === "failed") && !run.ended && run.done > 0 && (
          <button type="button" className="button" onClick={onNotes}>
            Make notes from what's transcribed
          </button>
        )}
        {run.stage === "notes_failed" && run.retry && (
          <button type="button" className="button" onClick={onRetryNotes}>
            <Icon name="refresh" size={14} />
            Try the notes again
          </button>
        )}
        {(run.stage === "notes_failed" && run.retry && saveTarget === "history") && (
          <button type="button" className="meeting-secondary" onClick={onTranscriptOnly}>
            Save the transcript without notes
          </button>
        )}
        {segments.length > 0 && !busy && <TranscriptExports title="" segments={segments} duration={duration} />}
        {!busy && (
          <button type="button" className="meeting-secondary" onClick={onDiscard}>
            {run.ended ? "Close" : "Discard"}
          </button>
        )}
      </div>
      {segments.length > 0 && (
        <ol className="meeting-live" ref={list} aria-label="Transcript so far">
          {segments.map((s, i) => (
            <li key={i}>
              <span className="meeting-stamp">{stamp(s.start, duration)}</span>
              {s.speaker && (
                <span className="meeting-speaker" data-i18n="off">
                  {s.speaker}
                </span>
              )}
              <p data-i18n="off">{s.text}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function TranscriptExports({ title, segments, duration }) {
  const stem = fileStem(title || "transcript");
  return (
    <>
      <button type="button" className="meeting-secondary" onClick={() => download(stem + ".txt", plainTranscript({ title, segments }), "text/plain;charset=utf-8")}>
        <Icon name="download" size={14} />
        Transcript (.txt)
      </button>
      <button type="button" className="meeting-secondary" onClick={() => download(stem + ".srt", srtTranscript(segments, duration), "application/x-subrip;charset=utf-8")}>
        <Icon name="download" size={14} />
        Subtitles (.srt)
      </button>
    </>
  );
}

// ---- The notes ----

// A saved meeting, reopened from its conversation (?c=).
function SavedNotes({ id, models, testMode, onMissing }) {
  const [state, setState] = useState({ status: "loading" });
  const navigate = useNavigate();
  useEffect(() => {
    const ctl = new AbortController();
    api("/api/conversations/" + encodeURIComponent(id), { signal: ctl.signal }).then(
      (r) => {
        const message = (r.messages || []).find((m) => m.role === "assistant" && m.content && typeof m.content === "object" && m.content.meeting);
        if (!message) return setState({ status: "missing" });
        const c = message.content,
          meta = c.meeting;
        const map = loadVeilState(id).map;
        const restore = (s) => unveil(s, map);
        const segments = transcriptFromMarkdown(c.text, meta.duration).map((s) => ({ ...s, text: restore(s.text), ...(s.speaker ? { speaker: restore(s.speaker) } : {}) }));
        const notes = meta.notes ? restoreNotes(meta.notes, restore) : null;
        setState({
          status: "ready",
          result: {
            live: false,
            title: restore(meta.title || ""),
            notes,
            segments,
            duration: meta.duration,
            stt: meta.stt,
            model: meta.model,
            saved: true,
            conversationId: id,
            cutAt: meta.cut_at,
            credits: meta.credits,
            privacy: c.privacy || null,
          },
        });
      },
      (e) => !ctl.signal.aborted && setState({ status: e.status === 404 ? "missing" : "error", message: e.message }),
    );
    return () => ctl.abort();
  }, [id]);
  if (state.status === "loading") return <p className="meeting-fine">Opening the notes…</p>;
  if (state.status !== "ready")
    return (
      <Notice type="error">
        {state.status === "missing" ? "These notes aren't in your History any more." : state.message}{" "}
        <button type="button" className="link-button" onClick={onMissing}>
          Start a new one
        </button>
      </Notice>
    );
  return <NotesView result={state.result} models={models} testMode={testMode} navigate={navigate} />;
}

function NotesView({ result, file = null, models, testMode, navigate }) {
  const { notes, segments, duration } = result;
  const [tab, setTab] = useState("notes"),
    [current, setCurrent] = useState(null),
    [copied, setCopied] = useState(false),
    [seen, setSeen] = useState(false);
  const audio = useRef(null),
    lines = useRef(null);
  // The recording plays from this device only while it's still open here.
  const src = useMemo(() => (file && result.live ? URL.createObjectURL(file) : null), [file, result.live]);
  useEffect(() => () => src && URL.revokeObjectURL(src), [src]);
  const lang = getLanguage() === "zh" ? "zh" : "en";
  const title = result.title || notes?.title || (lang === "zh" ? "会议纪要" : "Meeting notes");
  const stem = fileStem(title);
  const markdown = () =>
    notesMarkdown({ title, duration, notes, segments, stt: result.stt?.name || "", model: result.model?.name || "", lang, cutAt: result.cutAt });
  function jump(at) {
    if (at == null) return;
    const i = segments.reduce((best, s, k) => (s.start <= at + 0.5 ? k : best), 0);
    setCurrent(i);
    setTab("transcript");
    requestAnimationFrame(() => lines.current?.querySelector(`[data-line="${i}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" }));
    if (audio.current) {
      audio.current.currentTime = segments[i]?.start ?? at;
      audio.current.play().catch(() => {});
    }
  }
  const time = (at) =>
    at != null && (
      <button type="button" className="meeting-time" onClick={() => jump(at)} aria-label={`Go to ${stamp(at, duration)} in the transcript`}>
        {stamp(at, duration)}
      </button>
    );
  const receipt = result.anonyma;
  const privacy = receipt?.privacy;
  const counts = notes
    ? [
        notes.decisions.length === 1 ? "1 decision" : `${notes.decisions.length} decisions`,
        notes.actions.length === 1 ? "1 action item" : `${notes.actions.length} action items`,
        notes.questions.length === 1 ? "1 open question" : `${notes.questions.length} open questions`,
      ]
    : [];
  return (
    <section className="meeting-result">
      <div className="meeting-result-head">
        <span className="meeting-drop-icon" aria-hidden="true">
          <Icon name="memory" size={20} />
        </span>
        <div>
          {!notes && <p className="meeting-eyebrow">TRANSCRIPT</p>}
          <h2 data-i18n="off">{title}</h2>
          <p className="meeting-meta">
            <span>{clock(duration)}</span>
            {result.stt?.name && <span data-i18n="off">{result.stt.name}</span>}
            {result.model?.name && <span data-i18n="off">{result.model.name}</span>}
            {counts.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </p>
        </div>
      </div>
      <div className="meeting-toolbar">
        <button type="button" className="meeting-secondary" onClick={() => download(stem + ".md", markdown(), "text/markdown;charset=utf-8")}>
          <Icon name="download" size={14} />
          Markdown
        </button>
        <TranscriptExports title={title} segments={segments} duration={duration} />
        <button
          type="button"
          className="meeting-secondary"
          onClick={async () => {
            setCopied(await copyText(markdown()));
            setTimeout(() => setCopied(false), 1600);
          }}
        >
          <Icon name={copied ? "check" : "copy"} size={14} />
          {copied ? "Copied" : "Copy"}
        </button>
        {result.conversationId && (
          <Link className="meeting-secondary" to={"/workspace/chat?c=" + encodeURIComponent(result.conversationId)}>
            <Icon name="chat" size={14} />
            Ask about it in chat
          </Link>
        )}
        {result.vaultId && (
          <button type="button" className="meeting-secondary" onClick={() => navigate("/workspace/chat", { state: { vaultChat: result.vaultId } })}>
            <Icon name="lock" size={14} />
            Open from Device Vault
          </button>
        )}
      </div>
      <div className="meeting-tabs" role="tablist">
        {notes && (
          <button type="button" role="tab" aria-selected={tab === "notes"} className={tab === "notes" ? "on" : ""} onClick={() => setTab("notes")}>
            Notes
          </button>
        )}
        <button type="button" role="tab" aria-selected={tab === "transcript" || !notes} className={tab === "transcript" || !notes ? "on" : ""} onClick={() => setTab("transcript")}>
          Transcript
        </button>
      </div>
      <div className={"meeting-grid" + (notes ? "" : " single") + " show-" + (notes ? tab : "transcript")}>
        {notes && (
          <div className="meeting-notes">
            <article className="meeting-card">
              <h3>Summary</h3>
              {notes.summary ? <p data-i18n="off">{notes.summary}</p> : <p className="meeting-none">Nothing to summarise.</p>}
            </article>
            <article className="meeting-card">
              <h3>
                Decisions <span className="meeting-count">{notes.decisions.length}</span>
              </h3>
              {notes.decisions.length ? (
                <ul className="meeting-items">
                  {notes.decisions.map((d, i) => (
                    <li key={i}>
                      <span className="meeting-mark decision" aria-hidden="true" />
                      <p data-i18n="off">{d.text}</p>
                      {time(d.at)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="meeting-none">No decisions were said.</p>
              )}
            </article>
            <article className="meeting-card">
              <h3>
                Action items <span className="meeting-count">{notes.actions.length}</span>
              </h3>
              {notes.actions.length ? (
                <ul className="meeting-items actions">
                  {notes.actions.map((a, i) => (
                    <li key={i}>
                      <span className="meeting-mark action" aria-hidden="true" />
                      <div>
                        <p data-i18n="off">{a.task}</p>
                        <span className="meeting-tags">
                          {a.owner ? (
                            <span className="meeting-owner" data-i18n="off">
                              {a.owner}
                            </span>
                          ) : (
                            <span className="meeting-owner none">No owner named</span>
                          )}
                          {a.due && (
                            <span className="meeting-due" data-i18n="off">
                              {a.due}
                            </span>
                          )}
                        </span>
                      </div>
                      {time(a.at)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="meeting-none">No action items were said.</p>
              )}
            </article>
            <article className="meeting-card">
              <h3>
                Open questions <span className="meeting-count">{notes.questions.length}</span>
              </h3>
              {notes.questions.length ? (
                <ul className="meeting-items">
                  {notes.questions.map((d, i) => (
                    <li key={i}>
                      <span className="meeting-mark question" aria-hidden="true" />
                      <p data-i18n="off">{d.text}</p>
                      {time(d.at)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="meeting-none">No open questions.</p>
              )}
            </article>
          </div>
        )}
        <div className="meeting-transcript">
          <div className="meeting-transcript-head">
            <h3>Transcript</h3>
            <small>{segments.length === 1 ? "1 line" : `${segments.length} lines`}</small>
          </div>
          {src ? (
            <audio ref={audio} controls preload="metadata" src={src} />
          ) : (
            <p className="meeting-fine">The recording isn't kept, so it can't be played here. The times still match it.</p>
          )}
          {segments.some((s) => s.end - s.start > 30) && (
            <p>Timing comes from the transcription provider. Some sections may span up to five minutes.</p>
          )}
          <ol ref={lines} aria-label="Transcript">
            {segments.map((s, i) => (
              <li key={i} data-line={i} className={i === current ? "current" : ""}>
                <button
                  type="button"
                  className="meeting-stamp"
                  onClick={() => {
                    setCurrent(i);
                    if (audio.current) {
                      audio.current.currentTime = s.start;
                      audio.current.play().catch(() => {});
                    }
                  }}
                  aria-label={`Play from ${stamp(s.start, duration)}`}
                >
                  {stamp(s.start, duration)}
                </button>
                <p>
                  {s.speaker && (
                    <span className="meeting-speaker" data-i18n="off">
                      {s.speaker}
                    </span>
                  )}
                  <span data-i18n="off">{s.text}</span>
                </p>
              </li>
            ))}
          </ol>
        </div>
      </div>
      <ul className="meeting-notes-fine">
        {result.saved ? (
          <li>
            <Icon name="check" size={13} />
            <span>Saved to History as a chat with its transcript. Deleting the chat deletes both.</span>
          </li>
        ) : result.vaultId ? (
          <li>
            <Icon name="lock" size={13} />
            <span>Kept in Device Vault on this device only. ANONYMA didn't save it.</span>
          </li>
        ) : (
          result.live && (
            <li>
              <Icon name="shield" size={13} />
              <span>{result.vaultError || "Off the record: nothing was saved. Export it before you leave this page."}</span>
            </li>
          )
        )}
        {result.cutAt != null && (
          <li>
            <Icon name="warning" size={13} />
            <span>{`The notes cover the transcript up to ${stamp(result.cutAt, duration)}: the rest was longer than the notes model can read at once.`}</span>
          </li>
        )}
        {result.ownersDropped > 0 && (
          <li>
            <Icon name="shield" size={13} />
            <span>
              {result.ownersDropped === 1
                ? "1 owner the model gave was left out: the transcript doesn't name them."
                : `${result.ownersDropped} owners the model gave were left out: the transcript doesn't name them.`}
            </span>
          </li>
        )}
        {notes && (
          <li>
            <Icon name="shield" size={13} />
            <span>Written by a model from the transcript only. An owner shows only when the transcript names them. Check anything important against the recording.</span>
          </li>
        )}
        {result.masked > 0 && (
          <li>
            <Icon name="shield" size={13} />
            <span>{result.masked === 1 ? "Veil masked 1 detail before the notes model saw the transcript." : `Veil masked ${result.masked} details before the notes model saw the transcript.`}</span>
          </li>
        )}
      </ul>
      {(receipt || result.credits != null) && (
        <div className="meeting-receipt">
          <div className="receipt">
            <span className="sq" aria-hidden="true" />
            {receipt
              ? (receipt.local_test || testMode
                  ? `Test receipt · ${formatCredits(receipt.credits_charged)} credits charged · transcription ${formatCredits(receipt.steps?.transcription)}, notes ${formatCredits(receipt.steps?.notes)}`
                  : `Receipt · ${formatCredits(receipt.credits_charged)} credits charged · transcription ${formatCredits(receipt.steps?.transcription)}, notes ${formatCredits(receipt.steps?.notes)}`)
              : `Charged ${formatCredits(result.credits)} credits`}
          </div>
          {privacy?.transcription && (
            <span className="meeting-trail">
              <small>Recording</small>
              <PrivacyTrail privacy={privacy.transcription} models={models} />
            </span>
          )}
          {(privacy?.notes || result.privacy) && (
            <span className="meeting-trail">
              <small>Notes</small>
              <PrivacyTrail privacy={privacy?.notes || result.privacy} models={models} />
            </span>
          )}
        </div>
      )}
      {result.live && result.sent && notes && (
        <details className="meeting-sees" open={seen} onToggle={(e) => setSeen(e.currentTarget.open)}>
          <summary>What the notes model saw</summary>
          <p className="meeting-fine">
            {result.masked
              ? "Its instructions, then the transcript exactly as sent, with Veil's placeholders. Nothing else about the recording: not its name, date or sound."
              : "Its instructions, then the transcript exactly as sent. Nothing else about the recording: not its name, date or sound."}
          </p>
          <pre data-i18n="off">{notesPrompt(result.notesLanguage)}</pre>
          <pre data-i18n="off">{fitTranscript(result.sent, duration).text}</pre>
        </details>
      )}
    </section>
  );
}
