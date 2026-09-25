import { splitSentences, speakable, speakVeilTags } from "./voice-mode.js";
// Reviewed branch text helpers; this controller has no network or paid loop.
export const localVoices = (voices) =>
  voices.filter((v) => v.localService === true);
export function micError(error) {
  if (["NotAllowedError", "SecurityError"].includes(error?.name))
    return "Microphone permission was denied. Allow it in browser settings, then press Record again. You can keep typing.";
  if (error?.name === "NotFoundError")
    return "No microphone was found. Connect one or keep typing.";
  if (error?.name === "NotReadableError")
    return "The microphone is busy or unavailable. Close other recording apps, then try again.";
  return "Recording is unavailable in this browser. Use HTTPS, check microphone access, or keep typing.";
}
export function createRecorder({
  getUserMedia,
  Recorder,
  onState,
  onBlob,
  onError,
  maxMs = 120000,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let generation = 0,
    stream,
    rec,
    timeout,
    state = "idle",
    disposed = false;
  const report = (value) => {
    state = value;
    if (!disposed) onState(value);
  };
  const stopTracks = (s) => s?.getTracks().forEach((t) => t.stop());
  function discard() {
    generation++;
    clearTimer(timeout);
    if (rec && rec.state !== "inactive") {
      rec.onstop = null;
      try {
        rec.stop();
      } catch {}
    }
    stopTracks(stream);
    stream = null;
    rec = null;
    report("idle");
  }
  async function start() {
    if (disposed || state !== "idle") return;
    const ticket = ++generation;
    report("permission");
    try {
      if (!getUserMedia || !Recorder) throw Error("unsupported");
      const s = await getUserMedia({ audio: true });
      if (disposed || ticket !== generation) {
        stopTracks(s);
        return;
      }
      stream = s;
      const mimeType = [
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/mp4",
      ].find((t) => Recorder.isTypeSupported?.(t));
      rec = new Recorder(s, mimeType ? { mimeType } : undefined);
      const current = rec,
        chunks = [];
      current.ondataavailable = (e) => {
        if (ticket === generation && e.data.size) chunks.push(e.data);
      };
      current.onerror = () => {
        if (ticket !== generation) return;
        discard();
        onError(
          "Recording stopped unexpectedly. No audio was sent. Record again or type your message.",
        );
      };
      current.onstop = () => {
        clearTimer(timeout);
        stopTracks(s);
        stream = null;
        rec = null;
        if (disposed || ticket !== generation) return;
        const blob = new Blob(chunks, {
          type: current.mimeType || mimeType || "audio/webm",
        });
        report("idle");
        if (blob.size) onBlob(blob);
        else
          onError(
            "No audio was captured. Nothing was sent; try recording again.",
          );
      };
      current.start();
      report("recording");
      timeout = setTimer(() => {
        if (ticket === generation) stop();
      }, maxMs);
    } catch (e) {
      if (ticket !== generation || disposed) return;
      discard();
      onError(micError(e));
    }
  }
  function stop() {
    if (rec?.state === "recording") {
      clearTimer(timeout);
      report("finishing");
      rec.stop();
      stopTracks(stream);
    }
  }
  function dispose() {
    disposed = true;
    discard();
  }
  return { start, stop, discard, dispose };
}
export function createDeviceReader({
  synth,
  Utterance,
  onState,
  onError,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  let generation = 0,
    timer,
    disposed = false,
    chunks = [],
    index = 0,
    voice,
    rate;
  const stop = () => {
    generation++;
    clearTimer(timer);
    chunks = [];
    synth?.cancel();
    if (!disposed) onState("idle");
  };
  function play() {
    const ticket = generation;
    if (!chunks[index] || disposed) {
      stop();
      return;
    }
    const item = new Utterance(chunks[index]);
    item.voice = voice;
    item.lang = voice.lang;
    item.rate = rate;
    const fail = (message) => {
      if (ticket !== generation || disposed) return;
      stop();
      onError(message);
    };
    // Mobile engines may reject playback without a fresh user gesture.
    item.onerror = (e) =>
      fail(
        e.error === "not-allowed"
          ? "Playback was blocked. Press Play again, choose another local voice, or read the text."
          : "The device voice could not finish. Choose another local voice or read the text.",
      );
    item.onend = () => {
      if (ticket !== generation || disposed) return;
      clearTimer(timer);
      index++;
      if (index < chunks.length) play();
      else stop();
    };
    timer = setTimer(
      () =>
        fail(
          "The device voice did not finish. Press Play again or read the text.",
        ),
      Math.max(15000, item.text.length * 120),
    );
    try {
      synth.speak(item);
    } catch {
      fail(
        "This device could not start speech. Choose another local voice or read the text.",
      );
    }
  }
  function start(text, selectedVoice, speed = 1) {
    stop();
    if (disposed) return;
    if (!synth || !Utterance || selectedVoice?.localService !== true) {
      onError(
        "No local device voice is available. Keep reading the text, or enable a device voice in browser or system settings.",
      );
      return;
    }
    voice = selectedVoice;
    rate = speed;
    index = 0;
    chunks = splitSentences(text, { maxChunkChars: 220 })
      .map((s) => speakVeilTags(speakable(s)))
      .filter(Boolean);
    if (!chunks.length) return;
    onState("speaking");
    play();
  }
  return {
    start,
    stop,
    dispose() {
      disposed = true;
      stop();
    },
  };
}

// A read started during a request can arrive after its settled receipt. Never
// replace a confirmed terminal result with an older held/unknown snapshot.
export function mergeTranscriptionReceipt(current, incoming) {
  if (["settled", "released"].includes(current?.status)) return current;
  return incoming;
}
