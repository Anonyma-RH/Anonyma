import React, { useEffect, useRef, useState } from "react";
import { api, uid } from "./lib.js";
import { Modal } from "./ui.jsx";
import {
  createRecorder,
  createDeviceReader,
  localVoices,
  mergeTranscriptionReceipt,
} from "./voice-session.js";
import "./voice-assist.css";
import { earlyModelSuffix } from "./early-models.js";
const toData = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(Error("The recording could not be read."));
    r.readAsDataURL(blob);
  });

export function VoiceAssist({ onText, onClose, refresh, ephemeral, disabled }) {
  const [recording, setRecording] = useState("idle"),
    [blob, setBlob] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [transcript, setTranscript] = useState(""),
    [models, setModels] = useState(null),
    [model, setModel] = useState(""),
    [receipt, setReceipt] = useState(null),
    [requestId, setRequestId] = useState(null),
    [checking, setChecking] = useState(false);
  const recorder = useRef(),
    upload = useRef(),
    alive = useRef(true),
    epoch = useRef(0),
    flight = useRef(false),
    currentRequest = useRef(null);
  useEffect(() => {
    alive.current = true;
    recorder.current = createRecorder({
      getUserMedia: navigator.mediaDevices?.getUserMedia?.bind(
        navigator.mediaDevices,
      ),
      Recorder: globalThis.MediaRecorder,
      onState: setRecording,
      onBlob: (b) => {
        setBlob(b);
        setError("");
      },
      onError: setError,
    });
    api("/api/audio/models")
      .then((r) => {
        if (alive.current) {
          setModels(r.stt || []);
          setModel(r.stt?.[0]?.id || "");
        }
      })
      .catch(() => {
        if (alive.current)
          setError(
            "Transcription models are unavailable. You can still type your message.",
          );
      });
    const hide = () => {
      if (document.hidden) {
        epoch.current++;
        recorder.current.discard();
        setBlob(null);
        upload.current?.abort();
        setError(
          "Voice input stopped when the tab was hidden. Press Record to start again. A submitted transcription may still have a charge; check its status.",
        );
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      alive.current = false;
      epoch.current++;
      recorder.current.dispose();
      upload.current?.abort();
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  useEffect(() => {
    if (disabled) recorder.current?.discard();
  }, [disabled]);
  const selected = models?.find((m) => m.id === model);
  const busyRecording = recording !== "idle";
  async function transcribe() {
    if (!blob || !selected || flight.current) return;
    flight.current = true;
    setBusy(true);
    setError("");
    setReceipt(null);
    const ticket = ++epoch.current,
      id = uid();
    currentRequest.current = id;
    setRequestId(id);
    upload.current = new AbortController();
    try {
      const audio = await toData(blob);
      if (!alive.current || ticket !== epoch.current) return;
      const r = await api("/api/audio/transcriptions", {
        method: "POST",
        body: { audio, model, requestId: id },
        signal: upload.current.signal,
      });
      if (!alive.current || ticket !== epoch.current) return;
      setReceipt({ status: "settled", receipt: r.receipt });
      setTranscript(r.text?.trim() || "");
      setBlob(null);
      if (!r.text?.trim())
        setError(
          "No words were recognised. Check the receipt, then record again or type.",
        );
    } catch (e) {
      if (alive.current) {
        setError(
          e.name === "AbortError"
            ? "Stopped waiting. The transcription may still have a charge; check status before another paid request."
            : e.message,
        );
        setBlob(null);
      }
    } finally {
      flight.current = false;
      if (alive.current) {
        setBusy(false);
        refresh?.();
      }
    }
  }
  async function check() {
    if (!requestId || checking) return;
    setChecking(true);
    const id = requestId;
    try {
      const r = await api("/api/requests/" + encodeURIComponent(id));
      if (alive.current && currentRequest.current === id)
        setReceipt((previous) => mergeTranscriptionReceipt(previous, r));
    } catch {
      if (alive.current && currentRequest.current === id)
        setError(
          "Could not refresh the charge status. Any last confirmed receipt remains below. Checking never resends the transcription.",
        );
    } finally {
      if (alive.current) setChecking(false);
    }
  }
  function discard() {
    epoch.current++;
    recorder.current.discard();
    setBlob(null);
    setTranscript("");
    upload.current?.abort();
  }
  const cost = receipt?.receipt?.credits_charged;
  return (
    <section className="voice-assist" aria-label="Voice-assisted chat">
      <div className="voice-assist-head">
        <strong>Voice-assisted chat</strong>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close voice-assisted chat"
        >
          Close
        </button>
      </div>
      <p>
        Record → transcribe → review in the composer → Send. Then use Read aloud
        on the reply. Each new turn starts with you.
      </p>
      <p className="fine-print">
        Recording stays in this tab until you choose paid transcription. Audio
        goes to the speech provider and cannot be masked by Veil.{" "}
        {ephemeral
          ? "Off the record does not save the chat here; provider retention still applies."
          : "Review the text before sending it through your usual chat settings."}
      </p>
      {error && <p role="alert">{error}</p>}
      <div className="voice-assist-controls">
        {!busyRecording && !blob && !transcript && !busy && (
          <button
            type="button"
            className="small-button"
            disabled={disabled}
            onClick={() => {
              setError("");
              recorder.current.start();
            }}
          >
            Record a turn
          </button>
        )}
        {recording === "permission" && (
          <span role="status">Waiting for microphone permission…</span>
        )}
        {recording === "recording" && (
          <>
            <strong role="status">Microphone on · up to 2 minutes</strong>
            <button
              type="button"
              className="small-button"
              onClick={() => recorder.current.stop()}
            >
              Stop recording
            </button>
          </>
        )}
        {recording === "finishing" && (
          <span role="status">Finishing recording…</span>
        )}
        {(busyRecording || blob || busy) && (
          <button type="button" className="small-button" onClick={discard}>
            {busy ? "Cancel waiting" : "Mute & discard"}
          </button>
        )}
        {blob && !busy && (
          <>
            <select
              aria-label="Transcription model"
              value={model}
              onChange={(e) => setModel(e.target.value)}
            >
              {models?.map((m) => (
                <option value={m.id} key={m.id}>
                  {m.name}
                  {earlyModelSuffix(m)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="small-button"
              disabled={!selected}
              onClick={transcribe}
            >
              Transcribe · paid
            </button>
          </>
        )}
        {busy && <span role="status">Transcribing…</span>}
      </div>
      {blob && selected && (
        <p className="fine-print">
          {selected.credits_per_minute} credits/minute. The service may reserve
          up to{" "}
          {(selected.credits_per_minute * selected.max_minutes).toFixed(4)}{" "}
          credits from your personal balance, including in a shared chat. The
          receipt uses provider-reported duration; if unavailable, the maximum
          applies. Sending the reviewed text is a separate chat charge using
          your chat settings. Recording is local until Transcribe.
        </p>
      )}
      {transcript && (
        <>
          <label>
            Review transcript
            <textarea
              aria-label="Review transcript"
              value={transcript}
              onChange={(e) => setTranscript(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="small-button"
            disabled={!transcript.trim() || disabled}
            onClick={() => {
              onText(transcript.trim());
              setTranscript("");
            }}
          >
            Use transcript in composer
          </button>
          <button
            type="button"
            className="small-button"
            onClick={() => setTranscript("")}
          >
            Discard transcript
          </button>
        </>
      )}
      {requestId && (
        <div className="fine-print" role="status">
          {receipt?.status === "settled" && Number.isFinite(cost)
            ? `${cost} credits charged for transcription.`
            : receipt?.status === "released"
              ? "Transcription hold released; no credits charged."
              : receipt?.status === "held"
                ? `${receipt.reserved} credits reserved; final charge pending.`
                : "Transcription charge not confirmed here."}{" "}
          <button type="button" disabled={checking} onClick={check}>
            {checking ? "Checking…" : "Check transcription charge"}
          </button>
        </div>
      )}
    </section>
  );
}

export function ReadAloud({ text, onClose }) {
  const [voices, setVoices] = useState([]),
    [voice, setVoice] = useState(""),
    [rate, setRate] = useState(1),
    [state, setState] = useState("idle"),
    [error, setError] = useState("");
  const reader = useRef();
  useEffect(() => {
    const synth = window.speechSynthesis;
    const load = () => {
      const list = localVoices(synth?.getVoices() || []);
      setVoices(list);
      setVoice((v) =>
        list.some((x) => x.voiceURI === v) ? v : list[0]?.voiceURI || "",
      );
    };
    load();
    synth?.addEventListener("voiceschanged", load);
    reader.current = createDeviceReader({
      synth,
      Utterance: window.SpeechSynthesisUtterance,
      onState: setState,
      onError: setError,
    });
    const hide = () => {
      if (document.hidden) {
        reader.current.stop();
        setError(
          "Playback stopped when the tab was hidden. Press Play to start again.",
        );
      }
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      reader.current.dispose();
      synth?.removeEventListener("voiceschanged", load);
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  return (
    <Modal title="Read aloud" onClose={onClose}>
      <p>
        Device speech · no Anonyma credits. Only voices your browser reports as
        local are offered. Masked details stay masked.
      </p>
      {error && <p role="alert">{error}</p>}
      {!voices.length ? (
        <p role="status">
          No local device voice is available. Keep reading, or enable a voice in
          browser/system settings. Reopen this panel after adding one.
        </p>
      ) : (
        <div className="voice-assist-controls">
          <select
            aria-label="Device voice"
            value={voice}
            disabled={state === "speaking"}
            onChange={(e) => setVoice(e.target.value)}
          >
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} · {v.lang}
              </option>
            ))}
          </select>
          <select
            aria-label="Reading speed"
            value={rate}
            disabled={state === "speaking"}
            onChange={(e) => setRate(Number(e.target.value))}
          >
            {[0.8, 1, 1.2].map((n) => (
              <option key={n} value={n}>
                {n}×
              </option>
            ))}
          </select>
          {state === "speaking" ? (
            <button
              type="button"
              className="small-button"
              onClick={() => reader.current.stop()}
            >
              Stop reading
            </button>
          ) : (
            <button
              type="button"
              className="small-button"
              onClick={() => {
                setError("");
                reader.current.start(
                  text,
                  voices.find((v) => v.voiceURI === voice),
                  rate,
                );
              }}
            >
              Play answer
            </button>
          )}
        </div>
      )}
      <p role="status">
        {state === "speaking"
          ? "Reading with the selected device voice…"
          : "Nothing plays until you press Play."}
      </p>
    </Modal>
  );
}
