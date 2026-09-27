import React, { Suspense, lazy, useEffect, useRef, useState } from "react";
import { Icon, Notice, BandLines, BandSteps, Button } from "./ui.jsx";
import AsciiField from "./AsciiField.jsx";
import { api, uid, isReleased } from "./lib.js";
import { useApp } from "./context.jsx";
import { loadVeilOn, loadVeilWords } from "./veil.js";
import { formatClock, overviewLive } from "./audio-overview.js";
import "./audio-overview-entry.css";
import { SeedGuardNotice, seedGuardLive, useSeedScan } from "./SeedGuard.jsx";
import { LowBalanceRefusal } from "./BalanceAlerts.jsx";
import { earlyModelSuffix } from "./early-models.js";

const MAX_RECORDING_SECONDS = 10 * 60;
// Audio Overview's dialog and player, loaded only when opened.
const AudioOverviewDialog = lazy(() => import("./AudioOverview.jsx"));

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
  // Seed Guard: the script is scanned before it goes to a voice provider.
  const seedHit = useSeedScan(!demo && seedGuardLive(config), text);
  // Audio Overview: made here from a file or a saved chat, and the saved
  // ones listed above the library (src/AudioOverview.jsx).
  const { models } = useApp() || {};
  const overviewOn = !demo && !!user && overviewLive(config);
  const [overview, setOverview] = useState(null),
    [shelfKey, setShelfKey] = useState(0);
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
  // `allowSeed` is Seed Guard's confirmed "Send anyway".
  async function generate(e, { allowSeed = false } = {}) {
    e?.preventDefault();
    if (!text.trim() || busy || (seedHit && !allowSeed)) return;
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
  // Above the saved audio when there is some (the page is laid out as
  // results then), else below the composer, which overlaps the hero.
  const shelf = overviewOn && (
    <div className={"overview-shelf-zone" + (audio.length ? " above-results" : "")}>
      <OverviewShelf
        refreshKey={shelfKey}
        onMake={() => setOverview({})}
        onOpen={(id) => setOverview({ saved: id })}
      />
    </div>
  );
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
        {audio.length > 0 && shelf}
        {audio.length > 0 && (
          <div className="generation-results">
            <Grid media={audio.slice(0, 8)} onDelete={onDelete} />
          </div>
        )}
      </div>
      <div className="composer-zone">
        {error && (
          <Notice type="error">
            {error}
            <LowBalanceRefusal config={config} user={user} demo={demo} error={error} />
          </Notice>
        )}
        {receipt && (
          <div className="receipt">
            <span className="sq" aria-hidden="true" />
            {receipt.local_test ? "Test receipt" : "Receipt"} ·{" "}
            {receipt.credits_charged} credits charged
          </div>
        )}
        <SeedGuardNotice
          hit={seedHit}
          busy={busy}
          onProceed={() => generate(null, { allowSeed: true })}
        />
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
                    {earlyModelSuffix(m)}
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
              disabled={!text.trim() || busy || !!seedHit}
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
      {!audio.length && shelf}
      {overview && overviewOn && (
        <Suspense fallback={null}>
          <AudioOverviewDialog
            config={config}
            user={user}
            models={models || []}
            saved={overview.saved || null}
            pickChats
            veilWords={isReleased(config, "veil") && loadVeilOn() ? loadVeilWords() : null}
            office={isReleased(config, "files")}
            onSaved={(r) => {
              if (r.media) setMedia((prev) => [r.media, ...prev.filter((x) => x.id !== r.media.id)]);
              setShelfKey((k) => k + 1);
            }}
            onClose={() => setOverview(null)}
          />
        </Suspense>
      )}
    </>
  );
}

// Audio Overview's shelf in the Voice studio: the newest saved overviews,
// and the button that makes a new one.
function OverviewShelf({ refreshKey = 0, onMake, onOpen }) {
  const [list, setList] = useState(null);
  useEffect(() => {
    const ctl = new AbortController();
    api("/api/audio/overview", { signal: ctl.signal }).then(
      (r) => setList(r.data || []),
      () => !ctl.signal.aborted && setList([]),
    );
    return () => ctl.abort();
  }, [refreshKey]);
  return (
    <section className="overview-shelf" aria-label="Audio overviews">
      <div className="overview-shelf-head">
        <span className="overview-tile" aria-hidden="true">
          <Icon name="audio" size={18} />
        </span>
        <div>
          <p className="overview-eyebrow">AUDIO OVERVIEW</p>
          <p className="overview-shelf-lede">
            Turn a document, a saved chat or a research report into a two-voice briefing.
          </p>
        </div>
        <Button onClick={onMake}>Make an audio overview</Button>
      </div>
      {list?.length > 0 && (
        <ul className="overview-shelf-list">
          {list.slice(0, 6).map((o) => (
            <li key={o.id}>
              <button type="button" onClick={() => onOpen(o.id)}>
                <Icon name="play" size={14} />
                <b data-i18n="off">{o.title}</b>
                <small>
                  {[
                    Number.isFinite(o.duration) ? formatClock(o.duration) : null,
                    o.chapters === 1 ? "1 chapter" : `${o.chapters} chapters`,
                    o.status === "complete" ? null : "Stopped early",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
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
