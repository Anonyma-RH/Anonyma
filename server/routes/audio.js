import {
  fail,
  credits,
  usdUnits,
  reserve,
  settle,
  release,
  markupFactor,
} from "../core.js";
import {
  synthesizeSpeech,
  transcribeAudio,
  MAX_TRANSCRIPTION_MINUTES,
} from "../audio.js";
import { mediaRecipe } from "../history-library.js";
import { requestIdentifier } from "../middleware.js";
import { viewerOf } from "../early-models.js";

const RECORDING =
  /^data:(audio\/(?:webm|ogg|mp4|mpeg|wav|x-wav|aac|flac))(?:;codecs=[\w.,-]+)?;base64,([A-Za-z0-9+/=]+)$/;
const MAX_RECORDING_BYTES = 10 * 1024 * 1024;

// Text to speech (saved to the library) and speech to text (for the composer).
export function audioRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, inflight, audio } = ctx;
  const { saveMedia, assignCosts } = ctx.media;

  app.get("/api/audio/models", async (req, res) => {
    const catalog = await audio.load();
    const factor = req.user ? markupFactor(req.user, cfg) : 1;
    // Early Model Access. This list is already the account's own (priced at
    // its rate), so a speech model in its first days is listed, with its
    // earlyUntil, only for an eligible signed-in account. The routes below
    // check every request too.
    const tts = ctx.earlyModels.view(viewerOf(req), "tts"),
      stt = ctx.earlyModels.view(viewerOf(req), "stt");
    const early = (view, id) =>
      view.earlyUntil(id) ? { earlyUntil: view.earlyUntil(id) } : {};
    res.json({
      tts: catalog.tts.filter((m) => !tts.hides(m.id)).map((m) => ({
        id: m.id,
        name: m.name,
        provider: m.provider,
        description: m.description,
        char_limit: m.char_limit || 5000,
        credits_per_1k_chars: credits(usdUnits(m.pricing.api_price * factor)),
        voices: (m.voices || []).slice(0, 60).map((v) => ({
          id: v.id,
          name: v.name,
          gender: v.gender,
          language: v.language,
          preview_url: v.preview_url,
        })),
        ...early(tts, m.id),
      })),
      stt: catalog.stt.filter((m) => !stt.hides(m.id)).map((m) => ({
        id: m.id,
        name: m.name,
        credits_per_minute: credits(usdUnits(m.pricing.api_price * factor)),
        max_minutes: MAX_TRANSCRIPTION_MINUTES,
        ...early(stt, m.id),
      })),
    });
  });

  // Run one paid audio request under a reservation that is released on
  // failure and settled once on success.
  async function paid(req, res, amount, kind, run) {
    const hold = req.user.id + ":" + requestIdentifier(req);
    reserve(db, { id: hold, user: req.user.id, amount, kind, ttl: 240000 });
    const controller = new AbortController();
    inflight.controllers.add(controller);
    inflight.holds.add(hold);
    res.on("close", () => {
      if (!res.writableEnded)
        controller.abort(new Error("Client disconnected"));
    });
    try {
      return await run(controller.signal, hold);
    } catch (e) {
      release(db, hold);
      throw e;
    } finally {
      inflight.controllers.delete(controller);
      inflight.holds.delete(hold);
    }
  }

  app.post(
    "/api/audio/speech",
    requireUser,
    limit("audio", 20, 60000),
    async (req, res) => {
      await ctx.library.validateReplay(req, "audio");
      const m = await audio.model("tts", String(req.body.model || ""));
      ctx.earlyModels.check(viewerOf(req), "tts", m.id);
      const text =
        typeof req.body.text === "string" ? req.body.text.trim() : "";
      const maxChars = m.char_limit || 5000;
      if (!text || text.length > maxChars)
        fail(400, `Enter text up to ${maxChars.toLocaleString()} characters.`);
      const voice = req.body.voice == null ? "" : String(req.body.voice);
      if (voice && m.voices?.length && !m.voices.some((v) => v.id === voice))
        fail(400, "Choose one of this model's voices.");
      const language =
        req.body.language == null ? "" : String(req.body.language);
      if (language && !/^[a-z]{2}(-[A-Z]{2})?$|^multi$/.test(language))
        fail(400, "Language must be an ISO 639-1 code.");
      const factor = markupFactor(req.user, cfg);
      const amount = usdUnits(
        (text.length / 1000) * m.pricing.api_price * factor,
      );
      const result = await paid(
        req,
        res,
        amount,
        "audio",
        async (signal, hold) => {
          const { bytes, mime } = await synthesizeSpeech(
            cfg,
            { model: m.id, input: text, voice, language },
            signal,
          );
          const media = await saveMedia(req.user.id, "audio", bytes, {
            mime,
            prompt: text.slice(0, 500),
            model: m.id,
            protectMedia: req.body.libraryMediaId,
            recipe: mediaRecipe("audio", { model: m.id, text, voice, language }),
          });
          const receipt = settle(db, hold, amount, "Speech: " + m.name, {
            model: m.id,
            characters: text.length,
          });
          assignCosts([media.id], receipt.charged, req.user.id);
          return {
            data: { ...media, cost: receipt.credits_charged },
            receipt,
            testMode: cfg.testMode,
          };
        },
      );
      res.json(result);
    },
  );

  app.post(
    "/api/audio/transcriptions",
    requireUser,
    limit("transcribe", 20, 60000),
    async (req, res) => {
      const m = await audio.model("stt", String(req.body.model || "nova-3"));
      ctx.earlyModels.check(viewerOf(req), "stt", m.id);
      const match =
        typeof req.body.audio === "string"
          ? req.body.audio.match(RECORDING)
          : null;
      if (!match) fail(400, "Send the recording as a base64 audio data URL.");
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > MAX_RECORDING_BYTES)
        fail(400, "Recordings must be under 10 MB.");
      const language =
        req.body.language == null ? "" : String(req.body.language);
      if (language && !/^[a-z]{2}(-[A-Z]{2})?$|^multi$/.test(language))
        fail(400, "Language must be an ISO 639-1 code.");
      const factor = markupFactor(req.user, cfg);
      const perMinute = m.pricing.api_price * factor;
      // Duration is only known afterwards: hold the maximum, charge the actual.
      const amount = usdUnits(MAX_TRANSCRIPTION_MINUTES * perMinute);
      const result = await paid(
        req,
        res,
        amount,
        "audio",
        async (signal, hold) => {
          const { text, duration } = await transcribeAudio(
            cfg,
            { model: m.id, bytes, mime: match[1], language },
            signal,
          );
          const minutes =
            duration == null ? MAX_TRANSCRIPTION_MINUTES : duration / 60;
          const receipt = settle(
            db,
            hold,
            usdUnits(minutes * perMinute),
            "Transcription: " + m.name,
            {
              model: m.id,
              seconds: duration,
            },
          );
          return { text, duration, receipt, testMode: cfg.testMode };
        },
      );
      res.json(result);
    },
  );
}
