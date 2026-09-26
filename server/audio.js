import { fail } from "./core.js";
import { providerFailure } from "./provider.js";

// Speech models come from the gateway's audio catalog. Its `api_price` already
// includes the gateway fee (PPQ: base price x 1.055).
const REFRESH_MS = 10 * 60 * 1000;
const FIXTURE = {
  tts: [
    {
      id: "fixture-voice",
      name: "Fixture voice",
      provider: "local",
      pricing: { unit: "per_1k_chars", api_price: 0.1 },
      char_limit: 3000,
      voices: [
        {
          id: "fixture-1",
          name: "Fixture",
          gender: "neutral",
          language: "multi",
        },
      ],
    },
  ],
  stt: [
    {
      id: "nova-3",
      name: "Nova 3",
      provider: "local",
      pricing: { unit: "per_minute", api_price: 0.00633 },
    },
  ],
};
// General-purpose transcription models; the gateway also lists niche
// variants (medical, drive-thru...) that the workspace doesn't need.
const STT_MODELS = new Set(["nova-3", "nova-2"]);
export const MAX_TRANSCRIPTION_MINUTES = 10;

// `onLoad(catalog, live)` sees each catalog before it's used (Early Model
// Access records the ids it lists); if it throws, that catalog isn't used.
export function createAudioCatalog(cfg, { onLoad } = {}) {
  let cached = null,
    fetchedAt = 0,
    pending = null,
    fixtureSeen = false;
  async function load() {
    if (cfg.testMode) {
      if (!fixtureSeen) {
        onLoad?.(FIXTURE, false);
        fixtureSeen = true;
      }
      return FIXTURE;
    }
    if (!cfg.gatewayKey) return { tts: [], stt: [] };
    if (cached && Date.now() - fetchedAt < REFRESH_MS) return cached;
    pending ||= fetch(cfg.gateway.replace(/\/$/, "") + "/v1/audio/models", {
      headers: { authorization: `Bearer ${cfg.gatewayKey}` },
      signal: AbortSignal.timeout(15000),
    })
      .then(async (r) => {
        if (!r.ok) throw Error(`Audio catalog unavailable (${r.status}).`);
        const j = await r.json();
        const priced = (m) =>
          Number.isFinite(m.pricing?.api_price) && m.pricing.api_price > 0;
        const next = {
          tts: (j.data?.tts || []).filter(priced),
          stt: (j.data?.stt || []).filter(
            (m) => priced(m) && STT_MODELS.has(m.id),
          ),
        };
        onLoad?.(next, true);
        cached = next;
        fetchedAt = Date.now();
        return cached;
      })
      .finally(() => (pending = null));
    try {
      return await pending;
    } catch (e) {
      if (cached) return cached;
      fail(
        503,
        "Speech models are temporarily unavailable.",
        "audio_unavailable",
      );
    }
  }
  async function model(kind, id) {
    const m = (await load())[kind].find((x) => x.id === id);
    if (!m) fail(404, "Unknown speech model.", "model_not_found");
    return m;
  }
  return { load, model };
}

// A short silent WAV stands in for provider audio in local test mode.
function silentWav(seconds = 0.5, rate = 8000) {
  const samples = Math.round(seconds * rate);
  const b = Buffer.alloc(44 + samples);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + samples, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write("data", 36);
  b.writeUInt32LE(samples, 40);
  b.fill(128, 44);
  return b;
}

const AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/webm",
  "audio/mp4",
  "audio/aac",
  "audio/flac",
]);

export async function synthesizeSpeech(
  cfg,
  { model, input, voice, language },
  signal,
) {
  if (cfg.testMode) return { bytes: silentWav(), mime: "audio/wav" };
  const r = await fetch(cfg.gateway.replace(/\/$/, "") + "/v1/audio/speech", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${cfg.gatewayKey}`,
    },
    body: JSON.stringify({
      model,
      input,
      ...(voice ? { voice } : {}),
      ...(language ? { language } : {}),
    }),
    signal,
  });
  if (!r.ok) {
    let detail;
    try {
      detail = (await r.json()).error?.message;
    } catch {}
    providerFailure(r.status, detail, "Speech provider");
  }
  let mime = (r.headers.get("content-type") || "audio/mpeg")
    .split(";")[0]
    .trim();
  if (!AUDIO_TYPES.has(mime)) mime = "audio/mpeg";
  const bytes = Buffer.from(await r.arrayBuffer());
  if (!bytes.length)
    fail(502, "The provider returned no audio.", "empty_output");
  if (bytes.length > 50 * 1024 * 1024)
    fail(502, "Generated audio exceeds 50 MB.");
  return { bytes, mime };
}

export async function transcribeAudio(
  cfg,
  { model, bytes, mime, language },
  signal,
) {
  if (cfg.testMode)
    return {
      text: "Local test transcription. No provider was called.",
      duration: 3,
    };
  const form = new FormData();
  const ext = mime.split("/")[1].replace("mpeg", "mp3").replace("x-wav", "wav");
  form.append("file", new Blob([bytes], { type: mime }), `recording.${ext}`);
  form.append("model", model);
  form.append("response_format", "verbose_json");
  if (language) form.append("language", language);
  const r = await fetch(
    cfg.gateway.replace(/\/$/, "") + "/v1/audio/transcriptions",
    {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.gatewayKey}` },
      body: form,
      signal,
    },
  );
  if (!r.ok) {
    let detail;
    try {
      detail = (await r.json()).error?.message;
    } catch {}
    providerFailure(r.status, detail, "Transcription provider");
  }
  const j = await r.json();
  const text = typeof j.text === "string" ? j.text : "";
  const duration = Number(j.duration ?? j.metadata?.duration);
  return {
    text,
    duration: Number.isFinite(duration) && duration >= 0 ? duration : null,
  };
}
