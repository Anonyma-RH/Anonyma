import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Icon, Notice } from "./ui.jsx";
import { api, ApiError, uid, isReleased, readStore, saveStore, download, spendingLimitMessage } from "./lib.js";
import { readChatEvents } from "./stream.js";
import { formatCredits } from "./estimate.js";
import { formatBytes } from "./documents.js";
import { getLanguage } from "./i18n.js";
import { createVeilState, veil, unveil, saveVeilState, loadVeilState } from "./veil.js";
import { VeilToggle } from "./Veil.jsx";
import { scanSecrets, seedGuardMessage, isSoft } from "./seed-guard.js";
import { SecretGuardNotice, useSecretGuard, useSecretScan } from "./SecretGuard.jsx";
import { maskSecrets } from "./secret-guard.js";
import { PrivacyTrail, privacyTrailReleased } from "./PrivacyTrail.jsx";
import { PrivateModeToggle, NoPrivateModelsNotice, privateModeReleased } from "./PrivateMode.jsx";
import { CleanNote } from "./CleanUploads.jsx";
import { cleanUpload, AUDIO_EXTENSIONS } from "./clean-uploads.js";
import { pickPreset } from "./model-finder.js";
import { openRecording, encodeWav16, dataUrl, RECORDING_ACCEPT, RecordingError } from "./meeting-audio.js";
import { SPOKEN, clock, lengthLabel, planChunks, quietestPoint } from "./meeting-notes.js";
import {
  LIMITS,
  NOTHING_HEARD,
  SUBTITLES_PRIVATE,
  TRANSLATE_LANGUAGE_LIST,
  applyTranslation,
  buildCues,
  cueAt,
  cueIssues,
  editText,
  editTimes,
  fileStem,
  flat,
  mapTracks,
  measure,
  mergeCues,
  parseStamp,
  removeCue,
  shiftCues,
  splitCue,
  stampOf,
  toSrt,
  toVtt,
  translateMessages,
  translationBatches,
  usableCues,
  wrapCue,
} from "./subtitles.js";
import "./subtitles.css";

// Subtitles (update "subtitles"): the page at /workspace/subtitles. A video
// is read in this browser (src/meeting-audio.js, the reader Meeting Notes
// uses: the picture is never read) and cut into pieces of at most five
// minutes; each piece's sound goes to the transcription model, which times
// every word. The words are cut into cues here (src/subtitles.js), edited
// against the video playing on this device, optionally translated (the text
// only, timing kept) and downloaded as .srt or .vtt. server/routes/subtitles.js
// holds exactly the quoted maximum and charges each finished step. Saved
// subtitles are a set of tracks (times and text), reopened here with ?s=.

const CHOICES = "subtitles:choices";
// A fast, inexpensive text model with a long context translates unless
// another is picked (and remembered in this browser).
const TRANSLATE_MODELS = ["gemini-3.7-flash", "google/gemini-2.5-flash", "deepseek/deepseek-v4.1-flash", "gpt-5.4-mini", "claude-haiku-4.5"];
const CLEAN_CHECK_BYTES = 64 * 1024 * 1024;
const STOPPED = "Stopped. Pieces already transcribed are charged; nothing else is.";
const STOP_WAIT = 4000;
const veilKey = (id) => "subtitles:" + id;
const hasMap = (state) => !!state && Object.keys(state.map || {}).length > 0;
const nameOf = (lang, source) => {
  const spoken = SPOKEN.find(([code]) => code === lang);
  const known = TRANSLATE_LANGUAGE_LIST.find((l) => l.code === lang);
  return known?.native || (spoken && spoken[2]) || (lang === "multi" ? "" : lang) || "";
};
const RTL = new Set(["ar", "he", "fa", "ur"]);

// The translation run's events into callbacks. Throws an ApiError for a
// refusal (nothing was held).
async function runTranslate(body, onEvent, signal) {
  let response;
  try {
    response = await fetch("/api/subtitles/translate", {
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
    throw new ApiError(spendingLimitMessage(error) || error?.error?.message || "Subtitles are unavailable right now.", response.status, error?.error?.code, error);
  }
  for await (const event of readChatEvents(response)) onEvent(event);
}
const toneOf = (q) =>
  q?.available != null && q.credits > q.available
    ? "short"
    : q?.spending_limit?.remaining != null && q.credits > Number(q.spending_limit.remaining)
      ? "limited"
      : "ready";

export default function Subtitles({ demo, user, models = [], config, refresh, veilOn, setVeilOn, veilWords, vaultLive }) {
  const [params, setParams] = useSearchParams();
  const live = !demo && !!user;
  const savedId = live ? params.get("s") : null;
  const remembered = useMemo(() => readStore(CHOICES, {}) || {}, []);
  const veilLive = isReleased(config, "veil");
  const trailLive = privacyTrailReleased(config);
  const seedGuard = isReleased(config, "seedguard");
  const offRecordLive = isReleased(config, "ephemeral");
  const cleanLive = isReleased(config, "cleanuploads");
  // Secret Guard, for the cue text a translation sends.
  const secretLive = useSecretGuard(config, user, demo);

  const [file, setFile] = useState(null),
    [rec, setRec] = useState(null),
    [plan, setPlan] = useState(null),
    [reading, setReading] = useState(false),
    [fileError, setFileError] = useState(""),
    [clean, setClean] = useState(null),
    [dragging, setDragging] = useState(false),
    [catalog, setCatalog] = useState(null),
    [stt, setStt] = useState(remembered.stt || "nova-3"),
    [spoken, setSpoken] = useState(SPOKEN.some(([c]) => c === remembered.spoken) ? remembered.spoken : getLanguage() === "zh" ? "zh" : getLanguage() === "es" ? "es" : "en"),
    [save, setSave] = useState(["account", "none"].includes(remembered.save) ? remembered.save : "account"),
    [quote, setQuote] = useState({ status: "idle" }),
    [run, setRun] = useState(null),
    [doc, setDoc] = useState(null),
    [opening, setOpening] = useState(null),
    [error, setError] = useState(""),
    [list, setList] = useState(null);
  const input = useRef(null),
    controller = useRef(null),
    mounted = useRef(true),
    // The run in progress, so leaving the page ends it at once (releasing
    // what it still holds) instead of after 30 idle minutes.
    runId = useRef(null),
    veilState = useRef(createVeilState());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      controller.current?.abort();
      if (runId.current)
        fetch(`/api/subtitles/${encodeURIComponent(runId.current)}`, { method: "DELETE", credentials: "same-origin", keepalive: true }).catch(() => {});
    };
  }, []);

  // The video plays from this device only, from a Blob URL that goes when the
  // file does.
  const [media, setMedia] = useState(null);
  const mediaUrl = useMemo(() => (media ? URL.createObjectURL(media) : null), [media]);
  useEffect(() => () => mediaUrl && URL.revokeObjectURL(mediaUrl), [mediaUrl]);

  // The transcription models, from Voice & Audio's catalog.
  useEffect(() => {
    if (!live) return;
    const ctl = new AbortController();
    api("/api/audio/models", { signal: ctl.signal }).then(
      (c) => {
        setCatalog(c.stt || []);
        setStt((prev) => ((c.stt || []).some((m) => m.id === prev) ? prev : c.stt?.[0]?.id || ""));
      },
      () => !ctl.signal.aborted && setCatalog([]),
    );
    return () => ctl.abort();
  }, [live]);
  const sttModel = catalog?.find((m) => m.id === stt) || null;
  const ephemeral = save === "none" && offRecordLive;
  const saveTarget = ephemeral ? "none" : "account";

  // Saved subtitles, listed while no video or set is open.
  const loadList = useCallback(() => {
    if (!live) return;
    api("/api/subtitles/sets").then(
      (r) => mounted.current && setList(r.data || []),
      () => mounted.current && setList([]),
    );
  }, [live]);
  useEffect(() => {
    loadList();
  }, [loadList]);

  // ---- Reading the video ----
  async function pick(f) {
    if (!f || reading || run) return;
    if (!live) {
      setFileError(demo ? "The demo doesn't transcribe videos. Sign in to make subtitles." : "Sign in to make subtitles.");
      return;
    }
    setFileError("");
    setError("");
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
      setMedia(f);
      // Clean Uploads: what the file carries that isn't sent (the pieces
      // are plain sound, so none of it can be).
      const ext = (f.name.split(".").pop() || "").toLowerCase();
      if (cleanLive && AUDIO_EXTENSIONS.includes(ext) && !opened.video && f.size <= CLEAN_CHECK_BYTES)
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
    if (!rec || !plan || !stt) return null;
    return {
      duration: plan.reduce((n, p) => n + p.samples, 0) / 16000,
      chunks: plan.map((p) => p.seconds),
      stt,
      ...(spoken ? { language: spoken } : {}),
      ...(ephemeral ? { ephemeral: true } : {}),
    };
  }, [rec, plan, stt, spoken, ephemeral]);
  const quoteKey = body ? JSON.stringify(body) : "";
  useEffect(() => {
    if (!body || run || doc) return setQuote((q) => (q.status === "idle" ? q : { status: "idle" }));
    const ctl = new AbortController();
    setQuote((q) => ({ status: "loading", last: q.status === "ready" ? q : q.last }));
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/subtitles/quote", { method: "POST", body, signal: ctl.signal });
        setQuote({ status: "ready", ...r });
      } catch (e) {
        if (e?.name !== "AbortError") setQuote({ status: "unavailable", message: e.message });
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [quoteKey, !!run, !!doc]);
  const q = quote.status === "ready" ? quote : quote.status === "loading" ? quote.last : null;

  // ---- Transcribing ----
  const patchRun = (patch) => mounted.current && setRun((r) => (r ? { ...r, ...(typeof patch === "function" ? patch(r) : patch) } : r));
  async function start() {
    if (!body || run || quote.status !== "ready") return;
    saveStore(CHOICES, { ...remembered, stt, spoken, save });
    setError("");
    try {
      const r = await api("/api/subtitles", { method: "POST", body: { ...body, max_units: quote.units, requestId: uid() } });
      const next = { id: r.id, pieces: r.pieces, stt: r.stt, reserved: r.reserved, done: 0, charged: 0, tokens: [], stage: "transcribing", current: 0, privacy: null };
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
    let tokens = state.tokens,
      lost = state.lost || [],
      privacy = state.privacy,
      done = state.done,
      charged = state.charged;
    for (let i = from; i < state.pieces.length; i++) {
      const piece = state.pieces[i];
      patchRun({ stage: "transcribing", current: i, error: "" });
      try {
        const samples = await rec.read(piece.start, piece.start + piece.seconds);
        const audio = await dataUrl(encodeWav16(samples));
        if (ctl.signal.aborted) throw new DOMException("Aborted", "AbortError");
        const r = await api(`/api/subtitles/${encodeURIComponent(state.id)}/pieces/${i}`, { method: "POST", body: { audio }, signal: ctl.signal });
        tokens = [...tokens, ...r.tokens];
        privacy = r.privacy || privacy;
        done = r.done;
        charged = r.charged;
        patchRun({ tokens, done, charged, privacy });
        // The last piece ends the run on the server.
        if (r.done === r.of) runId.current = null;
      } catch (e) {
        // Transcribed (and charged) already, but its answer never arrived:
        // go on without its words, and say so.
        if (e?.code === "piece_done") {
          lost = [...lost, i];
          patchRun({ lost });
          continue;
        }
        controller.current = null;
        if (e?.name === "AbortError" || ctl.signal.aborted) {
          patchRun({ stage: "stopped", tokens, done, charged, error: STOPPED });
          return;
        }
        if (e?.code === "subtitles_not_found") runId.current = null;
        patchRun({ stage: "failed", failedAt: i, tokens, done, charged, error: e.message, ended: e?.code === "subtitles_not_found" });
        return;
      }
    }
    controller.current = null;
    await finishRun({ ...state, tokens, lost, privacy, done, charged });
  }
  // Every piece is in (or the person chose what's there): the cues.
  async function finishRun(state) {
    const cues = buildCues(state.tokens);
    if (!cues.length) {
      await discard(state, NOTHING_HEARD);
      return;
    }
    // Whatever is still held is released; what was transcribed stays charged.
    if (runId.current) {
      try {
        await api(`/api/subtitles/${encodeURIComponent(state.id)}`, { method: "DELETE" });
      } catch {}
      runId.current = null;
    }
    if (!mounted.current) return;
    const covered = state.done < state.pieces.length ? state.pieces.slice(0, state.done).reduce((n, p) => n + p.seconds, 0) : null;
    setRun(null);
    const duration = plan.reduce((n, p) => n + p.samples, 0) / 16000;
    const long = lengthLabel(duration);
    await openFresh({
      title: getLanguage() === "zh" ? "字幕 · " + long.replace(" h ", " 小时 ").replace(/ min$/, " 分钟").replace(/ s$/, " 秒") : (getLanguage() === "es" ? "Subtítulos · " : "Subtitles · ") + long,
      duration,
      language: spoken === "multi" ? "multi" : spoken,
      tracks: [{ lang: spoken === "multi" ? "multi" : spoken, source: true, cues }],
      receipt: { charged: state.charged, sttName: state.stt?.name, privacy: state.privacy, local: !!config?.testMode },
      covered,
    });
  }
  async function discard(state, message = "") {
    controller.current?.abort();
    runId.current = null;
    try {
      if (state?.id) await api(`/api/subtitles/${encodeURIComponent(state.id)}`, { method: "DELETE" });
    } catch {}
    if (!mounted.current) return;
    setRun(null);
    setError(message);
    refresh?.();
  }

  // ---- The set on screen ----
  // A fresh set from a run: kept in the account (masked by Veil when it's on)
  // unless it's off the record.
  async function openFresh(next) {
    const state = { id: null, key: uid(), ...next, active: 0, sync: { status: "idle" }, revision: 0, savedRevision: 0 };
    setDoc(state);
    setError("");
    refresh?.();
    if (saveTarget === "account") await create(state);
  }
  const seedText = useMemo(() => (doc ? doc.tracks.flatMap((t) => t.cues.map((c) => c.text)).join("\n") : ""), [doc?.tracks]);
  const secret = useMemo(() => (seedGuard && doc ? scanSecrets(seedText) : null), [seedGuard, seedText, !!doc]);
  const blocked = !!secret && !isSoft(secret);
  const masking = () => veilLive && (veilOn || hasMap(veilState.current));
  const forServer = (tracks) => {
    const usable = tracks.map((t) => ({ ...t, cues: usableCues(t.cues) }));
    if (!masking()) return usable;
    const masked = mapTracks(usable, (text) => veil(text, veilState.current, veilWords || []).text);
    return masked;
  };
  async function create(state = doc) {
    if (!state || state.id || saveTarget !== "account" || !live) return;
    const hit = seedGuard ? scanSecrets(state.tracks.flatMap((t) => t.cues.map((c) => c.text))) : null;
    if (hit && !isSoft(hit)) {
      setDoc((d) => d && { ...d, sync: { status: "blocked" } });
      return;
    }
    setDoc((d) => d && { ...d, sync: { status: "saving" } });
    try {
      const tracks = forServer(state.tracks);
      const r = await api("/api/subtitles/sets", {
        method: "POST",
        body: { title: state.title, duration: state.duration, language: state.language, tracks },
      });
      if (hasMap(veilState.current)) saveVeilState(veilKey(r.id), veilState.current);
      if (!mounted.current) return;
      setDoc((d) => d && { ...d, id: r.id, sync: { status: "saved" }, savedRevision: d.revision || 0 });
      const next = new URLSearchParams(params);
      next.set("s", r.id);
      setParams(next, { replace: true });
      loadList();
    } catch (e) {
      if (mounted.current) setDoc((d) => d && { ...d, sync: { status: "error", message: e.message } });
    }
  }
  // Every edit bumps the revision; a saved set follows about a second later.
  const update = useCallback((fn) => setDoc((d) => (d ? { ...fn(d), revision: (d.revision || 0) + 1 } : d)), []);
  useEffect(() => {
    if (!doc || !doc.id || saveTarget !== "account" || blocked) return;
    if ((doc.revision || 0) === (doc.savedRevision ?? 0)) return;
    const revision = doc.revision;
    const timer = setTimeout(async () => {
      setDoc((d) => d && { ...d, sync: { status: "saving" } });
      try {
        const tracks = forServer(doc.tracks);
        await api(`/api/subtitles/sets/${encodeURIComponent(doc.id)}`, { method: "PATCH", body: { title: doc.title, tracks } });
        if (hasMap(veilState.current)) saveVeilState(veilKey(doc.id), veilState.current);
        if (mounted.current) setDoc((d) => d && { ...d, savedRevision: revision, sync: { status: "saved" } });
      } catch (e) {
        if (mounted.current) setDoc((d) => d && { ...d, sync: { status: "error", message: e.message } });
      }
    }, 800);
    return () => clearTimeout(timer);
  }, [doc?.revision, doc?.id, saveTarget, blocked]);
  const dirty = !!doc && !!doc.id && (doc.revision || 0) !== (doc.savedRevision ?? 0);
  // Leaving with an edit not yet sent (closing the tab, or going to another
  // page here): it goes on the way out, when it's small enough for the browser
  // to send after the page has gone.
  const leaving = useRef(null);
  leaving.current = { doc, dirty, saveTarget, blocked, forServer };
  useEffect(() => {
    const flush = () => {
      const { doc, dirty, saveTarget, blocked, forServer } = leaving.current;
      if (!doc?.id || !dirty || saveTarget !== "account" || blocked) return;
      try {
        const body = JSON.stringify({ title: doc.title, tracks: forServer(doc.tracks) });
        if (body.length > 60000) return;
        if (hasMap(veilState.current)) saveVeilState(veilKey(doc.id), veilState.current);
        fetch(`/api/subtitles/sets/${encodeURIComponent(doc.id)}`, { method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
      } catch {}
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      flush();
    };
  }, []);
  // Someone leaves with an unsaved edit: send it before the page goes.
  async function retrySave() {
    if (!doc) return;
    if (!doc.id) return create(doc);
    setDoc((d) => d && { ...d, revision: (d.revision || 0) + 1 });
  }

  // A saved set, reopened from ?s=.
  useEffect(() => {
    if (!savedId || run || !live) return;
    if (doc?.id === savedId) return;
    const ctl = new AbortController();
    setOpening({ status: "loading" });
    api("/api/subtitles/sets/" + encodeURIComponent(savedId), { signal: ctl.signal }).then(
      (r) => {
        const state = loadVeilState(veilKey(r.id));
        veilState.current = state;
        const show = hasMap(state) ? (s) => unveil(s, state.map) : (s) => s;
        const wanted = params.get("track");
        const at = Math.max(0, r.tracks.findIndex((t) => (t.source ? "orig" : t.lang) === wanted));
        setDoc({
          id: r.id,
          key: uid(),
          title: r.title,
          duration: r.duration,
          language: r.language,
          tracks: mapTracks(r.tracks, show),
          active: wanted ? at : 0,
          sync: { status: "saved" },
          revision: 0,
          savedRevision: 0,
        });
        setOpening(null);
      },
      (e) => !ctl.signal.aborted && setOpening({ status: e.status === 404 ? "missing" : "error", message: e.message }),
    );
    return () => ctl.abort();
  }, [savedId, live]);
  function reset() {
    setRun(null);
    setDoc(null);
    setOpening(null);
    setFile(null);
    setRec(null);
    setPlan(null);
    setClean(null);
    setMedia(null);
    setError("");
    veilState.current = createVeilState();
    if (params.get("s") || params.get("track")) {
      const next = new URLSearchParams(params);
      next.delete("s");
      next.delete("track");
      setParams(next, { replace: true });
    }
    loadList();
  }
  async function remove(id) {
    try {
      await api("/api/subtitles/sets/" + encodeURIComponent(id), { method: "DELETE" });
    } catch (e) {
      if (e.status !== 404) return setError(e.message);
    }
    try {
      localStorage.removeItem("anonyma:veil:state:" + veilKey(id));
    } catch {}
    if (doc?.id === id) reset();
    else loadList();
  }
  // Switching track updates the address, so a reload opens the same one.
  function setActive(active) {
    setDoc((d) => d && { ...d, active: Math.min(Math.max(0, active), d.tracks.length - 1) });
    const t = doc?.tracks[active];
    const next = new URLSearchParams(params);
    if (t && !t.source) next.set("track", t.lang);
    else next.delete("track");
    if (doc?.id) setParams(next, { replace: true });
  }
  function focusTrack(lang) {
    setDoc((d) => d && { ...d, active: Math.max(0, d.tracks.findIndex((t) => !t.source && t.lang === lang)) });
    if (doc?.id) {
      const next = new URLSearchParams(params);
      next.set("track", lang);
      setParams(next, { replace: true });
    }
  }

  const compact = !!(run || doc || savedId);
  return (
    <section
      className={"subs-page" + (dragging ? " dragging" : "")}
      onDragOver={(e) => {
        if (run || doc || savedId) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => e.currentTarget.contains(e.relatedTarget) || setDragging(false)}
      onDrop={(e) => (run || doc || savedId ? e.preventDefault() : onDrop(e))}
    >
      <div className={"subs-head" + (compact ? " compact" : "")}>
        <div>
          <p className="eyebrow">SUBTITLES</p>
          <h1>Subtitles</h1>
          <p>Drop a video. Get subtitles you can edit, translate and download.</p>
        </div>
        {(doc || savedId) && (
          <button type="button" className="subs-secondary" onClick={reset}>
            <Icon name="plus" size={14} />
            New video
          </button>
        )}
      </div>
      {savedId && !doc ? (
        opening?.status === "loading" || !opening ? (
          <p className="subs-fine">Opening the subtitles…</p>
        ) : (
          <Notice type="error">
            {opening.status === "missing" ? "These subtitles aren't saved in your account any more." : opening.message}{" "}
            <button type="button" className="link-button" onClick={reset}>
              Start a new one
            </button>
          </Notice>
        )
      ) : doc ? (
        <Editor
          key={doc.key}
          doc={doc}
          dirty={dirty}
          update={update}
          setActive={setActive}
          focusTrack={focusTrack}
          media={media}
          mediaUrl={mediaUrl}
          onMedia={setMedia}
          models={models}
          config={config}
          refresh={refresh}
          veilOn={veilOn}
          setVeilOn={setVeilOn}
          veilWords={veilWords}
          veilState={veilState}
          veilLive={veilLive}
          trailLive={trailLive}
          live={live}
          saveTarget={saveTarget}
          blocked={blocked}
          secret={secret}
          onRetrySave={retrySave}
          onDelete={() => remove(doc.id)}
          mounted={mounted}
          vaultLive={vaultLive}
          secretLive={secretLive}
        />
      ) : run ? (
        <Progress
          run={run}
          onStop={() => controller.current?.abort()}
          onRetry={() => transcribe(run, run.failedAt ?? run.done)}
          onUse={() => finishRun(run)}
          onDiscard={() => discard(run, "Discarded. Pieces already transcribed are charged; the rest was released.")}
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
              <div className={"subs-drop" + (dragging ? " dragging" : "") + (reading ? " busy" : "")}>
                <span className="subs-drop-icon" aria-hidden="true">
                  <Icon name="captions" size={22} />
                </span>
                <b>{reading ? "Reading the video on this device…" : "Drop a video here"}</b>
                {reading && file ? <small data-i18n="off">{file.name}</small> : <small>MP4, MOV, WebM, MP3, M4A, WAV or OGG. Up to 3 hours.</small>}
                <button type="button" className="button" disabled={reading} onClick={() => input.current?.click()}>
                  <Icon name="upload" size={15} />
                  Choose a video
                </button>
                {fileError && (
                  <p className="subs-drop-error" role="alert">
                    <Icon name="warning" size={14} />
                    {fileError}
                  </p>
                )}
              </div>
              <ul className="subs-promises">
                <li>
                  <b>Only the sound goes out</b>
                  <span>The video is read in this browser. Its sound goes to the transcription provider in pieces of up to five minutes; the picture, the file and its name stay here.</span>
                </li>
                <li>
                  <b>Nothing kept you didn't ask for</b>
                  <span>ANONYMA doesn't store the video or its sound. The subtitles are saved to your account, or nowhere.</span>
                </li>
                <li>
                  <b>The maximum, first</b>
                  <span>See the most it can cost before you start; that's exactly what's held. A piece that fails costs nothing.</span>
                </li>
              </ul>
              {live && list?.length > 0 && <SavedList list={list} onOpen={(id) => setParams({ s: id })} onDelete={remove} />}
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
              save={save}
              setSave={setSave}
              offRecordLive={offRecordLive}
              vaultLive={vaultLive}
              veilLive={veilLive}
              veilOn={!!veilOn}
              setVeilOn={setVeilOn}
              quote={quote}
              q={q}
              canStart={!!body && quote.status === "ready"}
              onStart={start}
              onChange={() => input.current?.click()}
            />
          )}
        </>
      )}
    </section>
  );
}

// ---- Saved subtitles ----

function SavedList({ list, onOpen, onDelete }) {
  const [asking, setAsking] = useState(null);
  return (
    <section className="subs-saved" aria-label="Your saved subtitles">
      <h2>Your saved subtitles</h2>
      <ul>
        {list.map((s) => (
          <li key={s.id}>
            <button type="button" className="subs-saved-open" onClick={() => onOpen(s.id)}>
              <b data-i18n="off">{s.title}</b>
              <small>
                <span>{clock(s.duration)}</span>
                <span data-i18n="off">{s.track_list.map((t) => nameOf(t.lang, t.source) || "…").join(", ")}</span>
              </small>
            </button>
            {asking === s.id ? (
              <span className="subs-ask">
                <button type="button" className="subs-secondary danger" onClick={() => onDelete(s.id)}>
                  Delete
                </button>
                <button type="button" className="subs-secondary" onClick={() => setAsking(null)}>
                  Keep
                </button>
              </span>
            ) : (
              <button type="button" className="subs-icon" title="Delete these subtitles" aria-label="Delete these subtitles" onClick={() => setAsking(s.id)}>
                <Icon name="delete" size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
      <p className="subs-fine">Only the subtitles are saved, never the video.</p>
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
  save,
  setSave,
  offRecordLive,
  vaultLive,
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
    <div className="subs-setup">
      <div className="subs-file">
        <span className="subs-drop-icon" aria-hidden="true">
          <Icon name={rec.video ? "video" : "mic"} size={20} />
        </span>
        <div className="subs-file-text">
          <b data-i18n="off">{file.name}</b>
          <small>{`${clock(rec.duration)} · ${rec.format} · ${formatBytes(file.size)}`}</small>
          {rec.video && <small>Only its sound is read. The picture never leaves this device.</small>}
          <small>{plan.length === 1 ? "Sent as 1 piece of plain sound" : `Sent as ${plan.length} pieces of plain sound, cut at quiet moments`}</small>
          {clean && <CleanNote result={clean} notSent />}
        </div>
        <button type="button" className="subs-secondary" onClick={onChange}>
          Choose another
        </button>
      </div>
      <div className="subs-options">
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
          <span>Keep the subtitles</span>
          <select value={save} onChange={(e) => setSave(e.target.value)}>
            <option value="account">In your account</option>
            {offRecordLive && <option value="none">Nowhere (off the record)</option>}
          </select>
        </label>
      </div>
      {veilLive && (
        <div className="subs-veil">
          <VeilToggle on={veilOn} onToggle={() => setVeilOn?.((v) => !v)} />
          <span>{veilOn ? "Veil masks emails, numbers and keys in translations and in saved subtitles, and puts them back here." : "Veil is off: translations and saved subtitles carry the text as it was heard."}</span>
        </div>
      )}
      <p className="subs-cost" role="status">
        {q ? (
          <>
            <b>{`Up to ${formatCredits(q.credits)} credits`}</b>
            {` · ${formatCredits(q.minutes)} min at ${formatCredits(q.credits_per_minute)} / min`}
            {q.available != null && q.credits > q.available && <b className="subs-short"> · over your balance</b>}
            {q.spending_limit?.remaining != null && q.credits > Number(q.spending_limit.remaining) && <b className="subs-short"> · over your spending limit</b>}
          </>
        ) : quote.status === "unavailable" ? (
          quote.message
        ) : (
          "Working out the most it can cost…"
        )}
      </p>
      <p className="subs-fine stacked">
        <span>
          {provider
            ? `The video's sound goes to ${provider} (${sttName}) to be transcribed. ANONYMA doesn't keep it.`
            : `The video's sound goes to the transcription provider (${sttName}). ANONYMA doesn't keep it.`}
        </span>
        <span>{SUBTITLES_PRIVATE}</span>
        {vaultLive && <span>Device Vault keeps chats, not subtitles, so nothing here goes into it.</span>}
      </p>
      <div className="subs-actions">
        <button type="button" className="button" disabled={!canStart} onClick={onStart}>
          <Icon name="captions" size={15} />
          Make subtitles
        </button>
      </div>
    </div>
  );
}

// ---- While it runs ----

function Progress({ run, onStop, onRetry, onUse, onDiscard }) {
  const total = run.pieces.length;
  const duration = run.pieces.reduce((n, p) => n + p.seconds, 0);
  const heard = run.pieces.filter((p, i) => i < run.done).reduce((n, p) => n + p.seconds, 0);
  const pct = Math.round(4 + (92 * run.done) / Math.max(1, total));
  const cues = useMemo(() => buildCues(run.tokens), [run.tokens]);
  const list = useRef(null);
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [cues.length]);
  const busy = run.stage === "transcribing";
  return (
    <section className="subs-progress" aria-live="polite">
      <div className="subs-progress-head">
        <div>
          <p className="subs-eyebrow">{busy ? `TRANSCRIBING · PIECE ${Math.min(run.current + 1, total)} OF ${total}` : "PAUSED"}</p>
          <h3>{`${clock(heard)} of ${clock(duration)} transcribed`}</h3>
        </div>
        {busy && (
          <button type="button" className="subs-secondary" onClick={onStop}>
            <Icon name="stop" size={13} />
            Stop
          </button>
        )}
      </div>
      <div className="subs-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <span style={{ width: pct + "%" }} />
      </div>
      <ol className="subs-pieces" aria-label="Pieces">
        {run.pieces.map((p, i) => (
          <li
            key={i}
            className={i < run.done ? "done" : i === run.current && busy ? "current" : i === run.failedAt && run.stage === "failed" ? "failed" : ""}
            title={`${clock(p.start)}–${clock(p.start + p.seconds)}`}
          />
        ))}
      </ol>
      <p className="subs-fine">{`Charged so far: ${formatCredits(run.charged)} credits · held up to ${formatCredits(run.reserved)}`}</p>
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
      <div className="subs-actions">
        {run.stage === "failed" && !run.ended && (
          <button type="button" className="button" onClick={onRetry}>
            <Icon name="refresh" size={14} />
            Retry this piece
          </button>
        )}
        {(run.stage === "stopped" || run.stage === "failed") && !run.ended && run.done > 0 && (
          <button type="button" className="subs-secondary" onClick={onUse}>
            Use what's transcribed
          </button>
        )}
        {!busy && (
          <button type="button" className="subs-secondary" onClick={onDiscard}>
            {run.ended ? "Close" : "Discard"}
          </button>
        )}
      </div>
      {cues.length > 0 && (
        <ol className="subs-live" ref={list} aria-label="Subtitles so far">
          {cues.map((c, i) => (
            <li key={i}>
              <span className="subs-stamp">{stampOf(c.start)}</span>
              <p data-i18n="off">{c.text.replace(/\n/g, " ")}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ---- The editor ----

const ISSUE_LABELS = {
  empty: "Empty",
  long_line: "Long line",
  many_lines: "Too many lines",
  short: "Under 1 s",
  long: "Over 7 s",
  overlap: "Overlaps",
  fast: "Fast",
};

function TimeField({ value, label, onCommit }) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? stampOf(value);
  function commit() {
    const t = parseStamp(draft ?? "");
    if (draft !== null && t !== null && Math.abs(t - value) > 0.0004) onCommit(t);
    setDraft(null);
  }
  return (
    <input
      className={"subs-time" + (draft !== null && parseStamp(draft) === null ? " bad" : "")}
      value={shown}
      aria-label={label}
      inputMode="decimal"
      spellCheck={false}
      onFocus={(e) => e.target.select()}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        if (e.key === "Escape") setDraft(null);
      }}
    />
  );
}

// One cue: its times, its text, and what can be done to it. Memoised, so a
// keystroke re-renders one row, not thousands.
const CueRow = memo(function CueRow({ cue, i, active, flags, last, rtl, onSeek, onText, onTimes, onMerge, onSplit, onDelete }) {
  const area = useRef(null);
  const issues = flags ? flags.split(",") : [];
  const rows = Math.min(4, Math.max(2, cue.text.split("\n").length));
  return (
    <li className={"subs-cue" + (active ? " current" : "") + (issues.length ? " flagged" : "")} data-cue={i}>
      <button type="button" className="subs-index" onClick={() => onSeek(i)} aria-label={`Play from ${stampOf(cue.start)}`}>
        {i + 1}
      </button>
      <div className="subs-cue-body">
        <div className="subs-times">
          <TimeField value={cue.start} label="Start" onCommit={(t) => onTimes(i, { start: t })} />
          <span aria-hidden="true">→</span>
          <TimeField value={cue.end} label="End" onCommit={(t) => onTimes(i, { end: t })} />
          {issues.map((code) => (
            <span key={code} className={"subs-flag " + code}>
              {ISSUE_LABELS[code]}
            </span>
          ))}
        </div>
        <textarea
          ref={area}
          value={cue.text}
          rows={rows}
          maxLength={LIMITS.cueChars}
          dir={rtl ? "rtl" : undefined}
          aria-label="Subtitle text"
          spellCheck={false}
          data-i18n="off"
          onFocus={() => onSeek(i, false)}
          onChange={(e) => onText(i, e.target.value)}
          onBlur={(e) => {
            const wrapped = wrapCue(e.target.value);
            if (wrapped !== e.target.value && wrapped) onText(i, wrapped);
          }}
        />
      </div>
      <div className="subs-cue-tools">
        <button
          type="button"
          className="subs-icon"
          title="Split at the cursor"
          aria-label="Split at the cursor"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const el = area.current;
            const at = el ? flat(cue.text.slice(0, el.selectionStart)).length : null;
            onSplit(i, el && document.activeElement === el && at ? at : null);
          }}
        >
          <Icon name="split" size={14} />
        </button>
        <button type="button" className="subs-icon" title="Join with the next cue" aria-label="Join with the next cue" disabled={last} onClick={() => onMerge(i)}>
          <Icon name="merge" size={14} />
        </button>
        <button type="button" className="subs-icon" title="Delete this cue" aria-label="Delete this cue" onClick={() => onDelete(i)}>
          <Icon name="delete" size={14} />
        </button>
      </div>
    </li>
  );
});

function Editor({
  doc,
  dirty,
  update,
  setActive,
  focusTrack,
  media,
  mediaUrl,
  onMedia,
  models,
  config,
  refresh,
  veilOn,
  setVeilOn,
  veilWords,
  veilState,
  veilLive,
  trailLive,
  live,
  saveTarget,
  blocked,
  secret,
  onRetrySave,
  onDelete,
  mounted,
  vaultLive,
  secretLive = false,
}) {
  const track = doc.tracks[doc.active] || doc.tracks[0];
  const cues = track.cues;
  const video = useRef(null),
    listRef = useRef(null),
    attach = useRef(null),
    playing = useRef(false);
  const [now, setNow] = useState(0),
    [vttUrl, setVttUrl] = useState(null),
    [shift, setShift] = useState("0"),
    [asking, setAsking] = useState(false),
    [mismatch, setMismatch] = useState(null),
    [translated, setTranslated] = useState([]),
    [translateOpen, setTranslateOpen] = useState(false);
  const rtl = RTL.has(track.lang);

  // The track the player shows: a WebVTT Blob URL of the cues as they are,
  // made again a moment after an edit.
  useEffect(() => {
    const timer = setTimeout(() => {
      const url = URL.createObjectURL(new Blob([toVtt(usableCues(cues))], { type: "text/vtt" }));
      setVttUrl((old) => {
        if (old) setTimeout(() => URL.revokeObjectURL(old), 2000);
        return url;
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [cues]);
  const lastVtt = useRef(null);
  lastVtt.current = vttUrl;
  useEffect(() => () => lastVtt.current && URL.revokeObjectURL(lastVtt.current), []);

  const activeIndex = cueAt(cues, now);
  const current = activeIndex >= 0 && cues[activeIndex] && now <= cues[activeIndex].end + 0.001 ? activeIndex : -1;
  // Follow the video while it plays.
  useEffect(() => {
    if (!playing.current || current < 0) return;
    listRef.current?.querySelector(`[data-cue="${current}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);

  // Stable, so a keystroke re-renders one row: it reads the cues through a ref.
  const cuesRef = useRef(cues);
  cuesRef.current = cues;
  const seek = useCallback(
    (i, play = true) => {
      const c = cuesRef.current[i];
      const v = video.current;
      if (!c || !v) return;
      v.currentTime = c.start + 0.01;
      setNow(c.start + 0.01);
      if (play) v.play().catch(() => {});
    },
    [],
  );
  const setCues = useCallback(
    (fn) =>
      update((d) => ({
        ...d,
        tracks: d.tracks.map((t, k) => (k === d.active ? { ...t, cues: fn(t.cues, d) } : t)),
      })),
    [update],
  );
  const onText = useCallback((i, text) => setCues((c) => editText(c, i, text)), [setCues]);
  const onTimes = useCallback((i, t) => setCues((c, d) => editTimes(c, i, t, d.duration)), [setCues]);
  const onMerge = useCallback((i) => setCues((c) => mergeCues(c, i)), [setCues]);
  const onSplit = useCallback((i, at) => setCues((c) => splitCue(c, i, at)), [setCues]);
  const onRemoveCue = useCallback((i) => setCues((c) => removeCue(c, i)), [setCues]);
  const flags = useMemo(() => cues.map((c, i) => cueIssues(c, cues[i - 1], cues[i + 1]).join(",")), [cues]);
  const flagged = flags.filter(Boolean).length;
  const stem = fileStem(doc.title);
  const suffix = track.source ? "" : "." + track.lang;
  const downloadAs = (ext) => {
    const usable = usableCues(cues);
    if (ext === "srt") download(stem + suffix + ".srt", toSrt(usable), "application/x-subrip;charset=utf-8");
    else download(stem + suffix + ".vtt", toVtt(usable), "text/vtt;charset=utf-8");
  };
  const label = nameOf(track.lang, track.source) || "Original";

  // Choosing the video again for a set that was reopened (it isn't kept).
  function onAttach(f) {
    if (!f) return;
    const probe = document.createElement("video");
    const url = URL.createObjectURL(f);
    probe.preload = "metadata";
    probe.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      const d = probe.duration;
      setMismatch(Number.isFinite(d) && Math.abs(d - doc.duration) > 2.5 ? d : null);
      onMedia(f);
    };
    probe.onerror = () => {
      URL.revokeObjectURL(url);
      onMedia(f);
    };
    probe.src = url;
  }
  const receipt = doc.receipt;
  const sync = doc.sync || { status: "idle" };
  return (
    <section className="subs-editor">
      <div className="subs-title-row">
        <input
          className="subs-title"
          value={doc.title}
          maxLength={LIMITS.title}
          placeholder="Name these subtitles"
          aria-label="Name these subtitles"
          data-i18n="off"
          onChange={(e) => update((d) => ({ ...d, title: e.target.value }))}
        />
        <span className={"subs-sync " + sync.status} role="status">
          {saveTarget === "none" ? (
            <>
              <Icon name="shield" size={13} />
              <span>Off the record: nothing is saved. Download before you leave this page.</span>
            </>
          ) : blocked ? (
            <>
              <Icon name="warning" size={13} />
              <span>Not saved</span>
            </>
          ) : sync.status === "saving" || (dirty && sync.status !== "error") ? (
            <span>Saving…</span>
          ) : sync.status === "error" ? (
            <>
              <Icon name="warning" size={13} />
              <span data-i18n="off">{sync.message}</span>
              <button type="button" className="link-button" onClick={onRetrySave}>
                Try again
              </button>
            </>
          ) : sync.status === "saved" ? (
            <>
              <Icon name="check" size={13} />
              <span>Saved to your account</span>
            </>
          ) : null}
        </span>
      </div>
      {blocked && (
        <Notice type="error">
          {seedGuardMessage(secret)} <span>These subtitles aren't saved or translated, and you can still download them.</span>
        </Notice>
      )}
      {doc.covered != null && (
        <Notice>{`Only the first ${lengthLabel(doc.covered)} of the video was transcribed, so the subtitles end there.`}</Notice>
      )}
      <div className="subs-tabs">
        <div className="subs-tablist" role="tablist">
          {doc.tracks.map((t, k) => (
            <button
              key={t.lang + k}
              type="button"
              role="tab"
              aria-selected={k === doc.active}
              className={k === doc.active ? "on" : ""}
              onClick={() => setActive(k)}
              title={t.source ? "What was said" : undefined}
            >
              {nameOf(t.lang, t.source) ? <span data-i18n="off">{nameOf(t.lang, t.source)}</span> : <span>Original</span>}
            </button>
          ))}
        </div>
        {live && !blocked && (
          <button type="button" className={"subs-tab-add" + (translateOpen ? " on" : "")} aria-expanded={translateOpen} onClick={() => setTranslateOpen((o) => !o)}>
            <Icon name="languages" size={14} />
            Translate
          </button>
        )}
        <span className="subs-tabs-fill" />
        <button type="button" className="subs-secondary" onClick={() => downloadAs("srt")}>
          <Icon name="download" size={14} />
          Download .srt
        </button>
        <button type="button" className="subs-secondary" onClick={() => downloadAs("vtt")}>
          <Icon name="download" size={14} />
          Download .vtt
        </button>
      </div>
      {translateOpen && live && !blocked && (
        <TranslatePanel
          doc={doc}
          track={track}
          update={update}
          models={models}
          config={config}
          refresh={refresh}
          veilOn={veilOn}
          setVeilOn={setVeilOn}
          veilWords={veilWords}
          veilState={veilState}
          veilLive={veilLive}
          trailLive={trailLive}
          mounted={mounted}
          secretLive={secretLive}
          onDone={(lang, summary) => {
            setTranslated((list) => [...list, { lang, ...summary }]);
            focusTrack(lang);
            setTranslateOpen(false);
          }}
        />
      )}
      <div className="subs-grid">
        <div className="subs-player">
          {mediaUrl ? (
            <video
              ref={video}
              src={mediaUrl}
              controls
              playsInline
              preload="metadata"
              onTimeUpdate={(e) => setNow(e.currentTarget.currentTime)}
              onSeeked={(e) => setNow(e.currentTarget.currentTime)}
              onPlay={() => (playing.current = true)}
              onPause={() => (playing.current = false)}
            >
              {vttUrl && <track key={vttUrl} kind="subtitles" src={vttUrl} srcLang={track.lang || "und"} label={label} default />}
            </video>
          ) : (
            <div className="subs-no-video">
              <Icon name="video" size={22} />
              <p>The video isn't kept, so it can't play here. Choose it again to play it with these subtitles.</p>
              <input ref={attach} type="file" hidden accept={RECORDING_ACCEPT} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; onAttach(f); }} />
              <button type="button" className="subs-secondary" onClick={() => attach.current?.click()}>
                <Icon name="upload" size={14} />
                Choose the video
              </button>
            </div>
          )}
          {mismatch != null && <p className="subs-fine warn">{`This video is ${clock(mismatch)} long; these subtitles were made for ${clock(doc.duration)}.`}</p>}
          <div className="subs-shift">
            <label>
              <span>Move all cues by</span>
              <input
                type="number"
                step="0.1"
                value={shift}
                aria-label="Move all cues by"
                onChange={(e) => setShift(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && e.currentTarget.nextSibling?.click()}
              />
              <span>seconds</span>
            </label>
            <button
              type="button"
              className="subs-secondary"
              disabled={!Number(shift)}
              onClick={() => {
                const d = Number(shift);
                if (d) setCues((c) => shiftCues(c, d));
                setShift("0");
              }}
            >
              Move
            </button>
          </div>
          <ul className="subs-fine-list">
            {saveTarget === "account" && !blocked && (
              <li>
                <Icon name="check" size={13} />
                <span>Only the subtitles are saved, in your account. The video and its sound never are.</span>
              </li>
            )}
            {vaultLive && (
              <li>
                <Icon name="lock" size={13} />
                <span>Device Vault keeps chats, not subtitles, so nothing here goes into it.</span>
              </li>
            )}
            {veilLive && (veilOn || Object.keys(veilState.current.map || {}).length > 0) && (
              <li>
                <Icon name="shield" size={13} />
                <span>Veil's placeholders are shown with their values in this browser only.</span>
              </li>
            )}
          </ul>
          {receipt && (
            <div className="subs-receipt">
              <div className="receipt">
                <span className="sq" aria-hidden="true" />
                {receipt.local ? `Test receipt · ${formatCredits(receipt.charged)} credits charged` : `Receipt · ${formatCredits(receipt.charged)} credits charged`}
              </div>
              {receipt.privacy && trailLive && (
                <span className="subs-trail">
                  <small>Recording</small>
                  <PrivacyTrail privacy={receipt.privacy} models={models} />
                </span>
              )}
            </div>
          )}
          {translated.map((r, k) => (
            <div className="subs-receipt" key={k}>
              <div className="receipt">
                <span className="sq" aria-hidden="true" />
                {r.local ? `Test receipt · ${formatCredits(r.spent)} credits charged` : `Receipt · ${formatCredits(r.spent)} credits charged`}
              </div>
              <span className="subs-trail">
                <small data-i18n="off">{nameOf(r.lang, false)}</small>
                {r.privacy && trailLive && <PrivacyTrail privacy={r.privacy} models={models} />}
              </span>
            </div>
          ))}
          {doc.id && (
            <div className="subs-delete">
              {asking ? (
                <>
                  <span>Delete these subtitles from your account? The video isn't touched.</span>
                  <button type="button" className="subs-secondary danger" onClick={onDelete}>
                    Delete
                  </button>
                  <button type="button" className="subs-secondary" onClick={() => setAsking(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className="subs-secondary" onClick={() => setAsking(true)}>
                  <Icon name="delete" size={14} />
                  Delete these subtitles
                </button>
              )}
            </div>
          )}
        </div>
        <div className="subs-cues">
          <div className="subs-cues-head">
            <h3>Cues</h3>
            <small>{cues.length === 1 ? "1 cue" : `${cues.length} cues`}</small>
            {flagged > 0 && <small className="subs-flagged">{flagged === 1 ? "1 to check" : `${flagged} to check`}</small>}
          </div>
          <p className="subs-fine">Click a number to jump to a cue. Times are m:ss.mmm.</p>
          <ol ref={listRef} aria-label="Subtitle cues">
            {cues.map((c, i) => (
              <CueRow
                key={i}
                cue={c}
                i={i}
                active={i === current}
                flags={flags[i]}
                last={i === cues.length - 1}
                rtl={rtl}
                onSeek={seek}
                onText={onText}
                onTimes={onTimes}
                onMerge={onMerge}
                onSplit={onSplit}
                onDelete={onRemoveCue}
              />
            ))}
          </ol>
          {cues.length === 0 && <p className="subs-none">No cues left in this track.</p>}
        </div>
      </div>
    </section>
  );
}

// ---- Translating ----

function TranslatePanel({ doc, track, update, models, config, refresh, veilOn, setVeilOn, veilWords, veilState, veilLive, trailLive, mounted, onDone, secretLive = false }) {
  const remembered = useMemo(() => readStore(CHOICES, {}) || {}, []);
  const privateLive = privateModeReleased(config);
  const uncensored = config?.releases?.uncensoredModels || [];
  const [target, setTarget] = useState(() => {
      const own = (track.lang || "").split("-")[0];
      const ok = (code) => code.split("-")[0] !== own;
      const prefer = [remembered.target, getLanguage() === "es" ? "en" : "es", "en", "fr"];
      return prefer.find((c) => c && TRANSLATE_LANGUAGE_LIST.some((l) => l.code === c) && ok(c)) || "en";
    }),
    [privateOn, setPrivateOn] = useState(false),
    [job, setJob] = useState(null),
    [quote, setQuote] = useState({ status: "idle" }),
    [run, setRun] = useState(null),
    [runError, setRunError] = useState(""),
    [tick, setTick] = useState(0);
  const current = useRef(null);
  const veiling = veilLive && (veilOn || privateOn);
  const choices = useMemo(
    () => models.filter((m) => m.type === "chat" && m.callable && !m.imageCapable && !m.sealed && !uncensored.includes(m.id) && (!privateOn || m.private)),
    [models, config, privateOn],
  );
  const [model, setModel] = useState("");
  useEffect(() => {
    const ids = choices.map((m) => m.id);
    setModel((prev) => (ids.includes(prev) ? prev : [remembered.model, ...TRANSLATE_MODELS].find((id) => id && ids.includes(id)) || pickPreset(choices, "balanced", { mode: "chat" })?.id || ids[0] || ""));
  }, [choices]);
  const chosen = choices.find((m) => m.id === model);
  const noPrivate = privateOn && !choices.length;
  // Secret Guard: a password, key or token in the cues holds the
  // translation until it's masked (the default) or sent anyway. Masked, each
  // goes as a placeholder like [SECRET_1] in the set's tag map, so the
  // translated cues show the value again here; your own cues don't change.
  const cueText = useMemo(() => usableCues(track.cues).map((c) => c.text).join("\n"), [track.cues]);
  const secretFinds = useSecretScan(secretLive, cueText);
  const [secretChoice, setSecretChoice] = useState(null);
  useEffect(() => setSecretChoice(null), [cueText]);
  const secretHeld = secretFinds.length > 0 && !secretChoice && !job;
  const maskingSecrets = secretFinds.length > 0 && secretChoice === "mask";
  const [secretQueued, setSecretQueued] = useState(false);

  // What would be sent: the track's cues in batches, masked by Veil with a
  // copy of the set's tag map, so a quote and its run send the same text.
  const fresh = useMemo(() => {
    const cues = usableCues(track.cues);
    // The set's own tag map, so a value has the same tag in a quote, a run,
    // a retry and the saved set (masking is the same every time). Secret
    // Guard's placeholders go in a copy of it, used by this translation only,
    // so the set's own map (and what's saved with it) never holds a secret.
    const base = veilState.current;
    const state = maskingSecrets
      ? { map: { ...base.map }, counters: { ...base.counters }, valueToTag: { ...base.valueToTag } }
      : base;
    let masked = 0;
    const batches = translationBatches(cues).map((b) => ({
      index: b.index,
      items: b.items.map((i) => {
        const text = maskingSecrets ? maskSecrets(i.text, state).text : i.text;
        if (!veiling) return text === i.text ? i : { n: i.n, text };
        const r = veil(text, state, veilWords || []);
        masked += r.count;
        return { n: i.n, text: r.text };
      }),
    }));
    return { cues, batches, state, masked };
  }, [track.cues, veiling, veilWords, maskingSecrets]);
  const plan = job || fresh;
  const of = plan.batches.length;
  const done = job ? job.results : {};
  const todo = plan.batches.map((b) => b.index).filter((i) => !done[i]);
  const sizes = useMemo(() => plan.batches.map((b) => measure(translateMessages({ target: job?.target || target, batch: b, of }))), [plan, target, of]);
  const quoteBody = useMemo(() => {
    if (run || !todo.length || !chosen || secretHeld) return null;
    return { target: job?.target || target, model, ...(privateOn ? { private: true } : {}), sizes: todo.map((i) => sizes[i]) };
  }, [run, todo.join(","), chosen, model, target, privateOn, sizes, secretHeld]);
  const quoteKey = quoteBody ? JSON.stringify(quoteBody) : "";
  useEffect(() => {
    if (!quoteBody) return setQuote({ status: "idle" });
    const ctl = new AbortController();
    setQuote((s) => ({ status: "loading", last: s.status === "ready" ? s : s.last }));
    const timer = setTimeout(async () => {
      try {
        const r = await api("/api/subtitles/translate/quote", { method: "POST", body: quoteBody, signal: ctl.signal });
        setQuote({ status: "ready", ...r, key: quoteKey, tick });
      } catch (e) {
        if (e?.name !== "AbortError") setQuote({ status: "unavailable", message: e?.message || "The estimate is unavailable." });
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [quoteKey, tick]);
  const q = quote.status === "ready" ? quote : quote.last;
  const quoteFresh = quote.status === "ready" && quote.key === quoteKey && quote.tick === tick;
  const tone = toneOf(q);
  // Secret Guard's Mask and send, or Send anyway: the translation starts
  // once the estimate for what will now be sent is in.
  useEffect(() => {
    if (!secretQueued) return;
    if (quoteFresh && tone === "ready" && !secretHeld) {
      setSecretQueued(false);
      translate();
    } else if (run || quote.status === "unavailable" || (quoteFresh && tone !== "ready")) setSecretQueued(false);
  }, [secretQueued, quoteFresh, tone, secretHeld, run, quote.status]);

  async function translate() {
    if (run || !quoteFresh || !chosen || noPrivate || !todo.length || secretHeld) return;
    saveStore(CHOICES, { ...remembered, target, model });
    const snapshot =
      job || {
        target,
        privateOn,
        modelName: chosen.name,
        cues: fresh.cues,
        batches: fresh.batches,
        state: fresh.state,
        results: {},
        failed: {},
        spent: 0,
        masked: fresh.masked,
      };
    const controller = new AbortController();
    const requestId = uid();
    const indices = todo;
    const info = { controller, requestId, stopping: false };
    current.current = info;
    setJob(snapshot);
    setRun({ reserved: 0, charged: 0, indices });
    setRunError("");
    const body = {
      target: snapshot.target,
      model,
      of,
      batches: snapshot.batches.filter((b) => indices.includes(b.index)),
      max_units: quote.units,
      requestId,
      ...(snapshot.privateOn ? { private: true } : {}),
      ...(trailLive ? { veil_masked: veiling ? snapshot.masked : null } : {}),
    };
    const results = { ...snapshot.results },
      failed = { ...snapshot.failed };
    for (const i of indices) delete failed[i];
    let charged = 0,
      final = null;
    try {
      await runTranslate(
        body,
        (event) => {
          if (!mounted.current) return;
          const t = event.translate;
          if (t?.stage === "started") setRun((r) => r && { ...r, reserved: Number(t.reserved) || 0 });
          else if (t?.stage === "part") {
            if (t.status === "done") {
              results[t.index] = t.cues;
              charged += Number(t.credits) || 0;
              setRun((r) => r && { ...r, charged, finished: Object.keys(results).length });
            } else if (t.status === "failed") failed[t.index] = t.message;
          } else if (t?.stage === "done") final = event;
        },
        controller.signal,
      );
      if (!final) throw new ApiError("The connection ended before the translation finished. Check your activity before retrying.");
    } catch (e) {
      if (mounted.current && e?.name !== "AbortError") setRunError(e.message || "The translation stopped.");
      if (e?.code === "estimate_changed") setTick((k) => k + 1);
    }
    if (current.current === info) current.current = null;
    if (!mounted.current) return;
    const next = { ...snapshot, results, failed, spent: snapshot.spent + charged, privacy: final?.anonyma?.privacy || snapshot.privacy };
    setRun(null);
    setJob(next);
    refresh?.();
    // Every part came back: the track joins the set.
    if (Object.keys(results).length === snapshot.batches.length) {
      const map = next.state.map;
      const show = hasMap(next.state) ? (s) => unveil(s, map) : (s) => s;
      const translated = Object.values(results)
        .flat()
        .map((x) => ({ n: x.n, text: show(x.text) }));
      const cues = applyTranslation(next.cues, translated);
      update((d) => {
        const track = { lang: next.target, source: false, cues };
        const at = d.tracks.findIndex((t) => !t.source && t.lang === next.target);
        const tracks = at >= 0 ? d.tracks.map((t, k) => (k === at ? track : t)) : [...d.tracks, track];
        return { ...d, tracks: tracks.slice(0, LIMITS.tracks) };
      });
      setJob(null);
      onDone(next.target, { spent: next.spent, privacy: next.privacy, local: !!config?.testMode, model: next.modelName });
    }
  }
  async function stop() {
    const info = current.current;
    if (!info || info.stopping) return;
    info.stopping = true;
    setRun((r) => r && { ...r, stopping: true });
    // Ask the server to stop, so what finished still arrives; leave only if
    // it doesn't answer.
    const fallback = setTimeout(() => info.controller.abort(), STOP_WAIT);
    try {
      const r = await api("/api/subtitles/translate/stop", { method: "POST", body: { requestId: info.requestId } });
      if (!r.stopped) info.controller.abort();
    } catch {
      info.controller.abort();
    } finally {
      clearTimeout(fallback);
    }
  }
  useEffect(
    () => () => {
      current.current?.controller.abort();
    },
    [],
  );
  const failedCount = job ? Object.keys(job.failed).length : 0;
  // Not into the language the track is already in.
  const own = (track.lang || "").split("-")[0];
  const languages = TRANSLATE_LANGUAGE_LIST.filter((l) => !own || own === "multi" || l.code.split("-")[0] !== own);
  useEffect(() => {
    if (!job && !languages.some((l) => l.code === target)) setTarget(languages[0]?.code || "en");
  }, [track.lang]);
  return (
    <section className="subs-translate" aria-label="Translate these subtitles">
      <h3>Translate these subtitles</h3>
      <p className="subs-fine">Only the subtitle text goes to the model, in parts of up to 40 cues. The timing stays as it is.</p>
      <div className="subs-options">
        <label>
          <span>Translate into</span>
          <select value={job?.target || target} disabled={!!job || !!run} onChange={(e) => setTarget(e.target.value)}>
            {languages.map((l) => (
              <option key={l.code} value={l.code} data-i18n="off">
                {l.native === l.name ? l.name : `${l.native} · ${l.name}`}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Translated by</span>
          <select value={model} disabled={!choices.length || !!job || !!run} onChange={(e) => setModel(e.target.value)} data-i18n="off">
            {choices.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        {(privateLive || veilLive) && (
          <div className="subs-toggles">
            {privateLive && (
              <PrivateModeToggle
                active={privateOn}
                disabled={!!job || !!run}
                onToggle={() => {
                  setPrivateOn((on) => !on);
                  if (!privateOn && veilLive) setVeilOn?.(true);
                }}
              />
            )}
            {veilLive && <VeilToggle on={veilOn || privateOn} onToggle={() => !privateOn && !run && !job && setVeilOn?.((v) => !v)} />}
          </div>
        )}
      </div>
      {noPrivate && <NoPrivateModelsNotice />}
      <SecretGuardNotice
        finds={secretHeld ? secretFinds : []}
        busy={secretQueued}
        onMask={() => {
          setSecretChoice("mask");
          setSecretQueued(true);
        }}
        onProceed={() => {
          setSecretChoice("anyway");
          setSecretQueued(true);
        }}
        note="Mask swaps each one for a placeholder like [SECRET_1] in what's sent. The translation shows your value again here, and your own subtitles don't change."
      />
      <p className={"subs-cost " + tone} role="status">
        {q ? (
          <>
            <b>{`Up to ${formatCredits(q.credits)} credits`}</b>
            {` · ${todo.length === 1 ? "1 part" : `${todo.length} parts`}`}
            {tone === "short" && <b className="subs-short"> · over your balance</b>}
            {tone === "limited" && <b className="subs-short"> · over your spending limit</b>}
          </>
        ) : quote.status === "unavailable" ? (
          quote.message
        ) : todo.length ? (
          "Working out the most it can cost…"
        ) : (
          ""
        )}
      </p>
      {run && (
        <div className="subs-tr-run" aria-live="polite">
          <div className="subs-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(((Object.keys(job?.results || {}).length + (run.finished || 0)) * 100) / Math.max(1, of))}>
            <span style={{ width: Math.round(((run.finished || 0) + Object.keys(job?.results || {}).length) * 100 / Math.max(1, of)) + "%" }} />
          </div>
          <p className="subs-fine">{`Charged so far: ${formatCredits(run.charged)} credits · held up to ${formatCredits(run.reserved)}`}</p>
        </div>
      )}
      {runError && <Notice type="error">{runError}</Notice>}
      {failedCount > 0 && !run && (
        <Notice type="error">
          <span>{failedCount === 1 ? "1 part didn't go through and wasn't charged." : `${failedCount} parts didn't go through and weren't charged.`}</span>{" "}
          <span data-i18n="off">{Object.values(job.failed)[0]}</span>
        </Notice>
      )}
      {job && !run && job.spent > 0 && <p className="subs-fine">{`Charged so far: ${formatCredits(job.spent)} credits`}</p>}
      <div className="subs-actions">
        {run ? (
          <button type="button" className="subs-secondary" disabled={run.stopping} onClick={stop}>
            <Icon name="stop" size={13} />
            Stop
          </button>
        ) : (
          <button type="button" className="button" disabled={!quoteFresh || !chosen || noPrivate || !todo.length || secretHeld || tone !== "ready"} onClick={translate}>
            <Icon name="languages" size={15} />
            {job && failedCount ? "Retry those parts" : "Translate"}
          </button>
        )}
        {job && !run && (
          <button type="button" className="subs-secondary" onClick={() => setJob(null)}>
            Discard
          </button>
        )}
      </div>
    </section>
  );
}
