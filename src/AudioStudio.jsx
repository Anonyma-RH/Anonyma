import React, { useEffect, useRef, useState } from "react";
import { Icon, Notice, BandLines, BandSteps } from "./ui.jsx";
import AsciiField from "./AsciiField.jsx";
import { api, uid } from "./lib.js";

const MAX_RECORDING_SECONDS = 10 * 60;

// Text to speech: pick a voice, write, and keep the result in the library.
export default function AudioStudio({
  demo,
  user,
  config,
  media,
  setMedia,
  refresh,
  onDelete,
  Grid,
}) {
  const welcome = useRef();
  const [catalog, setCatalog] = useState(null),
    [model, setModel] = useState(""),
    [voice, setVoice] = useState(""),
    [text, setText] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [receipt, setReceipt] = useState(null),
    preview = useRef(new Audio());
  useEffect(() => {
    if (demo) return;
    api("/api/audio/models")
      .then((c) => {
        setCatalog(c);
        setModel((m) => m || c.tts[0]?.id || "");
      })
      .catch((e) => setError(e.message));
    return () => preview.current.pause();
  }, [demo]);
  const selected = catalog?.tts.find((m) => m.id === model);
  useEffect(() => {
    if (selected && !selected.voices.some((v) => v.id === voice))
      setVoice(selected.voices[0]?.id || "");
  }, [model, catalog]);
  const limit = selected?.char_limit || 3000;
  const estimate = selected
    ? Math.ceil((text.length / 1000) * selected.credits_per_1k_chars * 10000) /
      10000
    : 0;
  const available = !demo && user && config?.services?.generation && selected;
  async function generate(e) {
    e.preventDefault();
    if (!text.trim() || busy) return;
    if (!available) {
      setError(
        demo
          ? "The demo doesn't call voice models. Sign in to create audio."
          : "Sign in and choose a voice model to create audio.",
      );
      return;
    }
    setBusy(true);
    setError("");
    setReceipt(null);
    try {
      const r = await api("/api/audio/speech", {
        method: "POST",
        body: { model, voice, text: text.trim(), requestId: uid() },
      });
      setMedia((prev) => [r.data, ...prev]);
      setReceipt({ ...r.receipt, local_test: r.testMode });
      setText("");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
      refresh();
    }
  }
  function playPreview() {
    const url = selected?.voices.find((v) => v.id === voice)?.preview_url;
    if (!url) return;
    preview.current.pause();
    preview.current.src = url;
    preview.current.play().catch(() => {});
  }
  const audio = media.filter((m) => m.kind === "audio");
  return (
    <>
      <div className="chat-area">
        <div className="workspace-welcome" ref={welcome}>
          <AsciiField sectionRef={welcome} />
          <BandLines />
          <p className="eyebrow">VOICE STUDIO</p>
          <h1>Give your words a voice.</h1>
          <p>
            Choose a voice, write your script, and keep every take in your
            library.
          </p>
          <BandSteps />
        </div>
        {audio.length > 0 && (
          <div className="generation-results">
            <Grid media={audio.slice(0, 8)} onDelete={onDelete} />
          </div>
        )}
      </div>
      <div className="composer-zone">
        {error && <Notice type="error">{error}</Notice>}
        {receipt && (
          <div className="receipt">
            <span className="sq" aria-hidden="true" />
            {receipt.local_test ? "Test receipt" : "Receipt"} ·{" "}
            {receipt.credits_charged} credits charged
          </div>
        )}
        <form className="composer" onSubmit={generate}>
          <textarea
            aria-label="Text to speak"
            placeholder="Write what the voice should say…"
            value={text}
            maxLength={limit}
            onChange={(e) => setText(e.target.value)}
            rows="4"
          />
          <div className="composer-controls">
            <div>
              <select
                aria-label="Voice model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                disabled={demo}
              >
                {demo && <option>Sample voices</option>}
                {catalog?.tts.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
              {selected?.voices.length > 0 && (
                <select
                  aria-label="Voice"
                  value={voice}
                  onChange={(e) => setVoice(e.target.value)}
                >
                  {selected.voices.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              )}
              {selected?.voices.find((v) => v.id === voice)?.preview_url && (
                <button
                  type="button"
                  className="small-button"
                  onClick={playPreview}
                  title="Plays the provider's sample clip"
                >
                  <Icon name="play" size={14} /> Preview
                </button>
              )}
            </div>
            <button
              type="submit"
              className="send-button"
              disabled={!text.trim() || busy}
              aria-label="Create audio"
            >
              {busy ? (
                <Icon name="refresh" size={18} />
              ) : (
                <Icon name="arrow" size={21} />
              )}
            </button>
          </div>
        </form>
        <div className="composer-caption">
          <span>
            {text.length.toLocaleString()} / {limit.toLocaleString()} characters
            {selected ? ` · about ${estimate} credits` : ""}
          </span>
        </div>
        <p className="fine-print">
          Charged per character at the model's published rate. Voice previews
          are served by the voice provider.
        </p>
      </div>
    </>
  );
}

// Records from the microphone and turns speech into text for the composer.
export function MicButton({ demo, onText, onError, disabled }) {
  const [state, setState] = useState("idle"),
    [seconds, setSeconds] = useState(0),
    recorder = useRef(null),
    clock = useRef(null);
  useEffect(() => () => stopTracks(), []);
  function stopTracks() {
    clearInterval(clock.current);
    recorder.current?.stream.getTracks().forEach((t) => t.stop());
  }
  async function start() {
    if (demo)
      return onError(
        "The demo doesn't transcribe audio. Sign in to use voice input.",
      );
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(
        (t) => MediaRecorder.isTypeSupported?.(t),
      );
      const rec = new MediaRecorder(
        stream,
        type ? { mimeType: type } : undefined,
      );
      const chunks = [];
      rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
      rec.onstop = () => {
        stopTracks();
        const blob = new Blob(chunks, {
          type: rec.mimeType || type || "audio/webm",
        });
        const reader = new FileReader();
        reader.onload = () => transcribe(reader.result);
        reader.readAsDataURL(blob);
      };
      recorder.current = rec;
      rec.start();
      setSeconds(0);
      setState("recording");
      clock.current = setInterval(
        () =>
          setSeconds((s) => {
            if (s + 1 >= MAX_RECORDING_SECONDS) rec.stop();
            return s + 1;
          }),
        1000,
      );
    } catch {
      onError(
        "Microphone access was blocked. Allow it in your browser to dictate.",
      );
    }
  }
  async function transcribe(audio) {
    setState("transcribing");
    try {
      const r = await api("/api/audio/transcriptions", {
        method: "POST",
        body: { audio, requestId: uid() },
      });
      if (r.text?.trim()) onText(r.text.trim());
      else onError("No speech was recognised in that recording.");
    } catch (e) {
      onError(e.message);
    } finally {
      setState("idle");
    }
  }
  const label =
    state === "recording"
      ? `Stop recording (${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")})`
      : state === "transcribing"
        ? "Transcribing…"
        : "Dictate with your voice";
  return (
    <button
      type="button"
      className={"attachment-control mic-button " + state}
      aria-label={label}
      title={label}
      disabled={disabled || state === "transcribing"}
      onClick={() =>
        state === "recording" ? recorder.current.stop() : start()
      }
    >
      <Icon name="mic" size={17} />
      {state === "recording" && (
        <span className="mic-time">
          {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, "0")}
        </span>
      )}
    </button>
  );
}
