import test from "node:test";
import assert from "node:assert/strict";
import {
  createRecorder,
  createDeviceReader,
  localVoices,
  micError,
  mergeTranscriptionReceipt,
} from "../src/voice-session.js";
import { splitSentences, speakable, speakVeilTags } from "../src/voice-mode.js";
import { UPDATES } from "../server/releases.js";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { createApp } from "../server/app.js";

const stream = () => {
  const track = {
    stopped: 0,
    stop() {
      this.stopped++;
    },
  };
  return { track, getTracks: () => [track] };
};
class Recorder {
  static isTypeSupported(t) {
    return t === "audio/webm";
  }
  constructor(s, options) {
    this.stream = s;
    this.mimeType = options?.mimeType;
    this.state = "inactive";
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["local audio"]) });
    this.onstop?.();
  }
}
function recordingHarness(getUserMedia) {
  const states = [],
    blobs = [],
    errors = [],
    timers = [];
  const r = createRecorder({
    getUserMedia,
    Recorder,
    onState: (s) => states.push(s),
    onBlob: (b) => blobs.push(b),
    onError: (e) => errors.push(e),
    setTimer: (f) => (timers.push(f), f),
    clearTimer: () => {},
  });
  return { r, states, blobs, errors, timers };
}

test("the voice entry has an explicit release gate", () => {
  const item = UPDATES.find((x) => x.id === "voice");
  assert.equal(item.title, "Read-aloud & Voice Conversations");
  assert.equal(typeof item.released, "boolean");
});
// Activation: the committed flag, not a test override, shows Voice under production's default
// RELEASED_FEATURES (mvp). The client also requires "audio" (the paid transcription route's gate).
test("released Voice is live under the default config with its audio dependency, and its copy stays truthful", async (t) => {
  const item = UPDATES.find((x) => x.id === "voice");
  assert.equal(item.released, true, "the activation commit sets released: true");
  const dir = mkdtempSync(join(tmpdir(), "anonyma-voice-activation-"));
  const s = createApp({ testMode: true, dbPath: join(dir, "test.sqlite"), mediaPath: join(dir, "media"), origin: "http://localhost:5175" });
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.voice, true);
  assert.equal(config.releases.features.audio, true, "voice input needs the released audio routes");
  assert.equal(config.releases.updates.find((u) => u.id === "voice").released, true);
  // Read-aloud is the browser's own speech and turns are explicit: no provider-voice, automatic,
  // hands-free or real-time claims.
  for (const line of [item.title, item.tagline, ...item.points])
    assert.doesNotMatch(line, /automatic|hands[- ]?free|real[- ]?time|always listening|cloud voice|AI voice|natural voices/i, line);
  assert.match(item.points.join(" "), /paid transcription/i);
  assert.match(item.points.join(" "), /device voice/i);
});
test("recording only starts explicitly; stop releases the microphone and returns local audio once", async () => {
  let calls = 0;
  const s = stream(),
    h = recordingHarness(async () => {
      calls++;
      return s;
    });
  assert.equal(calls, 0);
  await h.r.start();
  await h.r.start();
  assert.equal(calls, 1);
  assert.equal(h.states.at(-1), "recording");
  h.r.stop();
  assert.equal(s.track.stopped, 1);
  assert.equal(h.blobs.length, 1);
  assert.equal(h.blobs[0].type, "audio/webm");
  h.r.dispose();
  assert.equal(h.blobs.length, 1);
});
test("permission resolving after mute or close cannot record or upload", async () => {
  let resolve;
  const s = stream(),
    h = recordingHarness(() => new Promise((r) => (resolve = r)));
  const start = h.r.start();
  h.r.discard();
  resolve(s);
  await start;
  assert.equal(s.track.stopped, 1);
  assert.equal(h.blobs.length, 0);
  assert.equal(h.states.at(-1), "idle");
  const s2 = stream(),
    j = recordingHarness(() => new Promise((r) => (resolve = r)));
  const pending = j.r.start();
  j.r.dispose();
  resolve(s2);
  await pending;
  assert.equal(s2.track.stopped, 1);
  assert.equal(j.blobs.length, 0);
});
test("mute discards recording; maximum duration stops capture without a paid action", async () => {
  const s = stream(),
    h = recordingHarness(async () => s);
  await h.r.start();
  h.r.discard();
  assert.equal(h.blobs.length, 0);
  assert.equal(s.track.stopped, 1);
  const s2 = stream(),
    j = recordingHarness(async () => s2);
  await j.r.start();
  j.timers[0]();
  assert.equal(j.blobs.length, 1);
  assert.equal(s2.track.stopped, 1);
});
test("permission/mobile failures keep a typing fallback and no recorder", async () => {
  const h = recordingHarness(async () => {
    throw Object.assign(Error(), { name: "NotAllowedError" });
  });
  await h.r.start();
  assert.equal(h.blobs.length, 0);
  assert.match(h.errors[0], /browser settings/);
  assert.match(micError({ name: "NotFoundError" }), /No microphone/);
  assert.match(micError({ name: "NotReadableError" }), /busy/);
  assert.match(micError({}), /HTTPS/);
});
function readerHarness() {
  const spoken = [],
    states = [],
    errors = [];
  const synth = {
    cancels: 0,
    cancel() {
      this.cancels++;
    },
    speak(u) {
      spoken.push(u);
    },
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  const reader = createDeviceReader({
    synth,
    Utterance,
    onState: (s) => states.push(s),
    onError: (e) => errors.push(e),
    setTimer: () => 1,
    clearTimer: () => {},
  });
  return { reader, synth, spoken, states, errors };
}
const local = {
  voiceURI: "local-1",
  name: "Device",
  lang: "en-US",
  localService: true,
};
test("only browser-reported local voices are selectable; unsupported playback never sends anything", () => {
  assert.deepEqual(
    localVoices([local, { localService: false }, { name: "unknown" }]),
    [local],
  );
  const h = readerHarness();
  h.reader.start("hello", { localService: false });
  assert.equal(h.spoken.length, 0);
  assert.match(h.errors[0], /No local device voice/);
});
test("read aloud chunks the whole answer, preserves masked tags and stops stale callbacks", () => {
  const h = readerHarness(),
    text = "Hello [EMAIL_1]. " + "A long but clear sentence. ".repeat(35);
  h.reader.start(text, local, 1.2);
  assert.equal(h.spoken.length, 1);
  assert.equal(h.spoken[0].voice, local);
  assert.match(h.spoken[0].text, /email 1/);
  h.spoken[0].onend();
  assert.equal(h.spoken.length, 2);
  const old = h.spoken[1];
  h.reader.stop();
  old.onend();
  assert.equal(h.spoken.length, 2);
  h.reader.start("New answer.", local);
  assert.equal(h.spoken.length, 3);
  h.reader.dispose();
  h.spoken[2].onend();
  assert.equal(h.spoken.length, 3);
});
test("autoplay rejection is visible and never retries automatically", () => {
  const h = readerHarness();
  h.reader.start("Answer.", local);
  h.spoken[0].onerror({ error: "not-allowed" });
  assert.match(h.errors[0], /Press Play again/);
  assert.equal(h.spoken.length, 1);
  assert.equal(h.states.at(-1), "idle");
});
test("reviewed branch speech helpers keep decimals, replace code and do not expose Veil values", () => {
  const chunks = splitSentences(
    "Dr. Smith measured 3.14. Next result.\n```js\nconst secret = 1;\n```",
  );
  assert.match(chunks.join(" "), /3\.14/);
  assert.doesNotMatch(chunks.join(" "), /const secret/);
  assert.match(chunks.join(" "), /code block/);
  assert.equal(
    speakVeilTags(
      speakable("**Hello** [EMAIL_1] [docs](https://example.invalid)"),
    ),
    "Hello email 1 docs",
  );
});

test("a late charge check cannot replace a settled or released transcription receipt", () => {
  const settled = { status: "settled", receipt: { credits_charged: 1.25 } };
  assert.equal(
    mergeTranscriptionReceipt(settled, { status: "held", reserved: 5 }),
    settled,
  );
  assert.equal(
    mergeTranscriptionReceipt(settled, { status: "unknown" }),
    settled,
  );
  const released = { status: "released" };
  assert.equal(
    mergeTranscriptionReceipt(released, { status: "held" }),
    released,
  );
  assert.equal(mergeTranscriptionReceipt({ status: "held" }, settled), settled);
});

test("voice panels close on chat, mode and account changes", () => {
  const src = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  // Mode switch, new chat and opening a chat each close both panels...
  assert.equal(src.match(/setVoiceOpen\(false\);\n\s*setReadAloud\(null\);/g)?.length, 4);
  // ...and so does an account change, keyed on the user id so a balance
  // refresh (a new user object for the same account) leaves them open.
  assert.match(
    src,
    /useEffect\(\(\) => \{\n\s*setVoiceOpen\(false\);\n\s*setReadAloud\(null\);\n\s*\}, \[user\?\.id\]\);/,
  );
});
