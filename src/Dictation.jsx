import React, { useEffect, useRef, useState } from "react";
import { Icon } from "./ui.jsx";
import { createRecorder } from "./voice-session.js";
import {
  DEFAULT_DICTATION_MODEL,
  DICTATION_ENGINE_BYTES,
  DICTATION_LANGUAGES,
  DICTATION_MODELS,
  LICENCE_LINE,
  MAX_RECORDING_MS,
  audioCheck,
  buildBytes,
  cleanTranscript,
  detectDictationBuild,
  dictationLanguage,
  dictationModel,
  dictationStorage,
  formatBytes,
  friendlyError,
  removeDictationModel,
} from "./dictation.js";
import {
  decodeRecording,
  loadDictation,
  stopDictationEngine,
  transcribeOnDevice,
} from "./dictation-engine.js";
import "./dictation.css";

// Private Dictation's panel, above the composer: pick a model and a
// language, record, and the words are written into the message on this
// device. Nothing is sent: the person reviews the text and presses Send.
// The model and language are remembered in this browser only.
const PREFS = "anonyma.dictation";
function readPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS) || "{}");
    return {
      model: dictationModel(p.model)?.key || DEFAULT_DICTATION_MODEL,
      language: dictationLanguage(p.language),
    };
  } catch {
    return { model: DEFAULT_DICTATION_MODEL, language: "auto" };
  }
}
function savePrefs(p) {
  try {
    localStorage.setItem(PREFS, JSON.stringify(p));
  } catch {}
}
const clock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
const MAX_SECONDS = MAX_RECORDING_MS / 1000;

export default function DictationPanel({ onText, onClose, disabled }) {
  const [prefs, setPrefs] = useState(readPrefs),
    [build, setBuild] = useState(null),
    [storage, setStorage] = useState(null),
    [phase, setPhase] = useState("idle"),
    [progress, setProgress] = useState(null),
    [device, setDevice] = useState(null),
    [seconds, setSeconds] = useState(0),
    [partial, setPartial] = useState(""),
    [error, setError] = useState(""),
    [done, setDone] = useState("");
  const recorder = useRef(null),
    alive = useRef(true),
    ticket = useRef(0),
    timer = useRef(null),
    micState = useRef("idle"),
    // The recorder is made once; it hands each recording to the latest
    // render's transcribe (with the model, build and language on screen).
    latest = useRef(null);
  const model = dictationModel(prefs.model);
  const size = build ? buildBytes(model, build) : null;

  const refresh = () =>
    build &&
    dictationStorage(model, build)
      .then((s) => alive.current && setStorage(s))
      .catch(() => alive.current && setStorage({ complete: false, partial: false, bytes: 0, files: 0 }));

  useEffect(() => {
    alive.current = true;
    detectDictationBuild().then((b) => alive.current && setBuild(b));
    recorder.current = createRecorder({
      getUserMedia: navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices),
      Recorder: globalThis.MediaRecorder,
      maxMs: MAX_RECORDING_MS,
      onState: (s) => {
        micState.current = s;
        if (!alive.current) return;
        if (s === "recording") {
          setSeconds(0);
          clearInterval(timer.current);
          timer.current = setInterval(() => setSeconds((n) => Math.min(MAX_SECONDS, n + 1)), 1000);
        } else clearInterval(timer.current);
        setPhase((p) => (s === "idle" ? (["permission", "recording", "finishing"].includes(p) ? "idle" : p) : s));
      },
      onBlob: (blob) => latest.current(blob),
      onError: (m) => {
        if (!alive.current) return;
        setPhase("idle");
        setError(m);
      },
    });
    const hide = () => {
      if (document.hidden && recorder.current && micState.current !== "idle") {
        recorder.current.discard();
        setError("Recording stopped when the tab was hidden. Press Record to start again.");
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      alive.current = false;
      ticket.current++;
      clearInterval(timer.current);
      recorder.current?.dispose();
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  useEffect(() => {
    setStorage(null);
    setDevice(null);
    refresh();
  }, [prefs.model, build]);
  useEffect(() => {
    if (disabled) recorder.current?.discard();
  }, [disabled]);

  const choose = (patch) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    savePrefs(next);
  };

  // Downloads (the first time) and starts the model, with progress.
  async function prepare() {
    const mine = ++ticket.current;
    setError("");
    setDone("");
    setPhase("download");
    setProgress({ loaded: 0, total: size });
    try {
      const r = await loadDictation(model.key, build, {
        onProgress: (p) => alive.current && mine === ticket.current && setProgress(p),
      });
      if (!alive.current || mine !== ticket.current) return false;
      setDevice(r.device);
      setPhase("idle");
      refresh();
      return true;
    } catch (err) {
      if (alive.current && mine === ticket.current) {
        setPhase("idle");
        if (err?.name !== "AbortError") setError(friendlyError(err, "load"));
        refresh();
      }
      return false;
    } finally {
      if (alive.current && mine === ticket.current) setProgress(null);
    }
  }

  function record() {
    setError("");
    setDone("");
    setPartial("");
    recorder.current.start();
    // Start the model while the person speaks, so the words come quickly.
    if (!device) {
      const mine = ticket.current;
      loadDictation(model.key, build)
        .then((r) => alive.current && mine === ticket.current && setDevice(r.device))
        .catch(() => {});
    }
  }

  async function transcribe(blob) {
    const mine = ++ticket.current;
    setPhase("transcribing");
    setPartial("");
    try {
      const samples = await decodeRecording(blob);
      const check = audioCheck(samples);
      if (check !== "ok") {
        if (alive.current && mine === ticket.current) {
          setPhase("idle");
          setError(
            check === "short"
              ? "That recording was too short. Record a little longer."
              : "No speech was heard. Check your microphone, then record again.",
          );
        }
        return;
      }
      const r = await transcribeOnDevice(model.key, build, samples, prefs.language, {
        onPartial: (t) => alive.current && mine === ticket.current && setPartial(t),
      });
      if (!alive.current || mine !== ticket.current) return;
      setDevice(r.device);
      const text = cleanTranscript(r.text);
      setPhase("idle");
      setPartial("");
      if (!text) return setError("No words were recognised. Record again, or type instead.");
      onText(text);
      setDone("Added to your message. Check it, then press Send: nothing is sent until you do.");
      refresh();
    } catch (err) {
      if (alive.current && mine === ticket.current) {
        setPhase("idle");
        setPartial("");
        if (err?.name !== "AbortError") setError(friendlyError(err, device ? "transcribe" : "load"));
      }
    }
  }

  latest.current = transcribe;

  function cancel() {
    const downloading = phase === "download";
    ticket.current++;
    recorder.current?.discard();
    stopDictationEngine();
    setPhase("idle");
    setProgress(null);
    setPartial("");
    setDevice(null);
    setError(downloading ? "Stopped. Files already downloaded are kept." : "Stopped. Nothing was added to your message.");
    refresh();
  }

  async function remove() {
    ticket.current++;
    stopDictationEngine();
    setDevice(null);
    setDone("");
    await removeDictationModel(model).catch(() => {});
    refresh();
  }

  // Downloaded, or running (a browser without Cache Storage keeps the model
  // only while the page is open).
  const ready = !!storage?.complete || !!device;
  const recording = ["permission", "recording", "finishing"].includes(phase);
  const busy = phase === "download" || phase === "transcribing";
  const pct = progress?.total ? Math.min(100, Math.round((progress.loaded / progress.total) * 100)) : 0;

  return (
    <section className="dictation-panel" aria-label="Private dictation">
      <div className="dictation-head">
        <span className="dictation-icon" aria-hidden="true">
          <Icon name="mic" size={17} />
        </span>
        <div>
          <strong>Private dictation</strong>
          <p>
            {`Free. Your recording never leaves this device. The first use downloads the model (about ${size ? formatBytes(size) : "…"}) from Hugging Face; after that it works offline.`}
          </p>
        </div>
        <button type="button" className="dictation-close" onClick={onClose} aria-label="Close private dictation">
          Close
        </button>
      </div>

      <div className="dictation-controls">
        <label>
          <span>Model</span>
          <select
            aria-label="Dictation model"
            value={model.key}
            disabled={busy || recording}
            onChange={(e) => choose({ model: e.target.value })}
          >
            {DICTATION_MODELS.map((m) => (
              <option key={m.key} value={m.key}>
                {build ? `${m.name} · ${formatBytes(buildBytes(m, build))}` : m.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Language</span>
          <select
            aria-label="Spoken language"
            value={prefs.language}
            disabled={busy || recording}
            onChange={(e) => choose({ language: e.target.value })}
          >
            {DICTATION_LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.name}
              </option>
            ))}
          </select>
        </label>
        <div className="dictation-actions">
          {phase === "download" || phase === "transcribing" ? (
            <button type="button" className="dictation-secondary" onClick={cancel}>
              Cancel
            </button>
          ) : recording ? (
            <button
              type="button"
              className="dictation-primary recording"
              disabled={phase !== "recording"}
              onClick={() => recorder.current.stop()}
            >
              <span className="dictation-dot" aria-hidden="true" />
              {`Stop · ${clock(seconds)}`}
            </button>
          ) : ready ? (
            <button type="button" className="dictation-primary" disabled={disabled || !build} onClick={record}>
              <Icon name="mic" size={15} />
              Record
            </button>
          ) : (
            <button
              type="button"
              className="dictation-primary"
              disabled={disabled || !build || !storage}
              onClick={prepare}
            >
              <Icon name="download" size={15} />
              {size ? `Download the model (${formatBytes(size)})` : "Download the model"}
            </button>
          )}
        </div>
      </div>

      <p className="dictation-model-line">
        {model.note}{" "}
        {ready ? (
          <>
            <span className="dictation-tag">Downloaded</span>{" "}
            <button type="button" className="dictation-link" disabled={busy || recording} onClick={remove}>
              Remove from this device
            </button>
          </>
        ) : storage?.partial ? (
          <span className="dictation-tag muted">Partly downloaded</span>
        ) : null}
      </p>

      {phase === "download" && (
        <div className="dictation-progress-wrap" role="status">
          <span>
            {progress?.loaded && progress.loaded < progress.total
              ? `Downloading from Hugging Face… ${formatBytes(progress.loaded)} of ${formatBytes(progress.total)}`
              : "Starting the model on this device…"}
          </span>
          <span className="dictation-progress" aria-hidden="true">
            <span style={{ width: `${progress?.loaded && progress.loaded < progress.total ? pct : 100}%` }} />
          </span>
        </div>
      )}
      {phase === "permission" && <p role="status">Waiting for microphone permission…</p>}
      {phase === "recording" && (
        <p role="status" className="dictation-live">
          {`Listening… up to ${clock(MAX_SECONDS)}. Press Stop when you're done.`}
        </p>
      )}
      {phase === "finishing" && <p role="status">Finishing the recording…</p>}
      {phase === "transcribing" && (
        <div className="dictation-transcribing" role="status">
          <p className="dictation-live">Transcribing on your device…</p>
          {partial && (
            <p className="dictation-partial" data-i18n="off">
              {partial}
            </p>
          )}
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      {done && (
        <p role="status" className="dictation-done">
          <Icon name="check" size={14} /> {done}
        </p>
      )}

      <ul className="dictation-fine">
        {device && (
          <li>
            {device === "webgpu"
              ? "Running on this device's graphics processor (WebGPU)."
              : "Running on this device's processor."}
          </li>
        )}
        <li>It's less accurate than paid transcription, so check the words before you send.</li>
        <li>Works in every mode, including Private Mode and off the record.</li>
        {!ready && <li>{`The first use also loads the speech engine (${formatBytes(DICTATION_ENGINE_BYTES)}) from ANONYMA.`}</li>}
        <li>{LICENCE_LINE}</li>
      </ul>
    </section>
  );
}
