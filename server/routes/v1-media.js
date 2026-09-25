import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  now,
  hash,
  fail,
  usdUnits,
  reserve,
  settle,
  release,
  quote,
  assertPricedImageOption,
  markupFactor,
  API_MEDIA_TTL_MS,
} from "../core.js";
import { generateImages } from "../provider.js";
import {
  synthesizeSpeech,
  transcribeAudio,
  MAX_TRANSCRIPTION_MINUTES,
} from "../audio.js";
import { requestIdentifier } from "../middleware.js";
import { issueMediaReceipt } from "../receipts.js";
import { submitVideoJob } from "./videos.js";

// Matches /api/audio/transcriptions' recording cap.
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const SPEECH_FORMATS = new Set(["mp3", "opus", "aac", "flac", "wav", "pcm"]);

// A hand-rolled multipart/form-data reader for the single "file" + "model"
// upload /v1/audio/transcriptions needs. No dependency is added for this;
// the whole body is buffered (capped at maxBytes) then split on the
// boundary. Good enough for a single-file API upload, not a general parser.
function parseMultipart(req, maxBytes) {
  return new Promise((resolve, reject) => {
    const type = req.headers["content-type"] || "";
    const match = /^multipart\/form-data;.*boundary=(?:"([^"]+)"|([^;]+))/i.exec(
      type,
    );
    if (!match)
      return reject(
        Object.assign(new Error("Send a multipart/form-data request."), {
          status: 400,
          code: "invalid_request",
        }),
      );
    const boundary = Buffer.from("--" + (match[1] || match[2]).trim());
    const chunks = [];
    let size = 0,
      settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes)
        return finish(
          reject,
          Object.assign(new Error("Upload exceeds the 10 MB limit."), {
            status: 400,
            code: "invalid_request",
          }),
        );
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        finish(resolve, readMultipart(Buffer.concat(chunks), boundary));
      } catch (e) {
        finish(reject, e);
      }
    });
    req.on("error", (e) => finish(reject, e));
  });
}
function readMultipart(body, boundary) {
  const fields = {};
  let file = null;
  const delimiter = Buffer.concat([Buffer.from("\r\n"), boundary]);
  let pos = body.indexOf(boundary);
  if (pos === -1) fail(400, "Malformed multipart body.");
  pos += boundary.length;
  for (;;) {
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break; // closing "--"
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;
    const headerEnd = body.indexOf("\r\n\r\n", pos);
    if (headerEnd === -1) break;
    const header = body.subarray(pos, headerEnd).toString("latin1");
    const contentStart = headerEnd + 4;
    const next = body.indexOf(delimiter, contentStart);
    const contentEnd = next === -1 ? body.length : next;
    const content = body.subarray(contentStart, contentEnd);
    const name = /name="([^"]*)"/i.exec(header)?.[1];
    const filename = /filename="([^"]*)"/i.exec(header)?.[1];
    const type = /content-type:\s*([^\r\n]+)/i.exec(header)?.[1]?.trim();
    if (filename != null || name === "file")
      file = {
        filename: filename || "upload",
        mime: type || "application/octet-stream",
        bytes: Buffer.from(content),
      };
    else if (name) fields[name] = content.toString("utf8");
    if (next === -1) break;
    pos = next + delimiter.length;
  }
  return { fields, file };
}

// Images, speech, transcription and video generation for the OpenAI-style
// /v1 API. Every endpoint reserves, generates and settles through the same
// core ledger helpers, provider adapters and media store as the matching web
// studio (images, audio, video); only request/response shape and auth differ.
// Every hold carries the caller's key, so reserve() applies the key's pause
// switch, expiry, allowance and rolling 24-hour cap before any provider work,
// and every settled request gets a signed receipt once receipts are live.
export function v1MediaRoutes(ctx) {
  const { app, db, cfg, limit, apiAuth, inflight } = ctx;
  const { saveMedia, assignCosts, signMedia } = ctx.media;
  const { getModel } = ctx.models;
  const guard = [limit("api_ip", 120, 60000), apiAuth];

  function signedMediaURL(media) {
    const base = (cfg.publicUrl || cfg.origin) + "/api/media/" + media.id;
    return media.expires
      ? `${base}?expires=${media.expires}&sig=${signMedia(media.id, media.expires)}`
      : base;
  }
  function fileBytes(id) {
    const row = db.prepare("SELECT filename FROM media WHERE id=?").get(id);
    return readFileSync(join(cfg.mediaPath, row.filename));
  }
  // The anonyma extension every /v1 media response carries.
  const extension = (receipt, requestId, signed) => ({
    credits_charged: receipt.credits_charged,
    request_id: requestId,
    ...(signed ? { signed_receipt: signed } : {}),
  });

  app.post(
    "/v1/images/generations",
    ...guard,
    async (req, res) => {
      const m = getModel(req.body.model, "image"),
        prompt = String(req.body.prompt || "");
      if (!prompt.trim() || prompt.length > 48000)
        fail(400, "Enter a prompt up to 48,000 characters.");
      const n = req.body.n ?? 1;
      if (!Number.isInteger(n) || n < 1 || n > 4)
        fail(400, "Choose 1–4 images.");
      const format = req.body.response_format ?? "url";
      if (!["url", "b64_json"].includes(format))
        fail(400, 'response_format must be "url" or "b64_json".');
      assertPricedImageOption(m, req.body);
      const requestId = requestIdentifier(req),
        hold = req.user.id + ":" + requestId,
        factor = markupFactor(req.user, cfg),
        amount = Math.ceil(
          quote(m, [{ role: "user", content: prompt }], 4096, {
            ...req.body,
            n,
          }) * factor,
        );
      reserve(db, {
        id: hold,
        user: req.user.id,
        amount,
        key: req.apiKey.id,
        kind: "image",
        ttl: 240000,
      });
      const data = [];
      let deliveredCost = 0;
      const controller = new AbortController();
      inflight.controllers.add(controller);
      inflight.holds.add(hold);
      const deadline = setTimeout(() => controller.abort(), 240000);
      res.on("close", () => {
        if (!res.writableEnded)
          controller.abort(new Error("Client disconnected"));
      });
      const respond = ({ receipt, signed }, extra = {}) =>
        res.json({
          created: Math.floor(now() / 1000),
          data: data.map((item) =>
            format === "b64_json"
              ? { b64_json: fileBytes(item.id).toString("base64") }
              : { url: item.url },
          ),
          anonyma: extension(receipt, requestId, signed),
          testMode: cfg.testMode,
          ...extra,
        });
      const finish = () => {
        const receipt = settle(db, hold, usdUnits(deliveredCost * factor), m.name);
        assignCosts(data.map((item) => item.id), receipt.charged, req.user.id);
        const signed = issueMediaReceipt(ctx, {
          hold,
          user: req.user.id,
          requestId,
          receipt,
          model: m.id,
          kind: "image",
          request: {
            model: m.id,
            prompt,
            n,
            size: req.body.size ?? null,
            quality: req.body.quality ?? null,
          },
          output: () => data.map((item) => fileBytes(item.id)),
        });
        return { receipt, signed };
      };
      try {
        await generateImages(
          cfg,
          m,
          prompt,
          n,
          { ...req.body, images: [] },
          controller.signal,
          async (batch) => {
            for (const img of batch.data) {
              const saved = await saveMedia(
                req.user.id,
                "image",
                img.b64_json
                  ? "data:image/png;base64," + img.b64_json
                  : img.url,
                {
                  prompt,
                  model: m.id,
                  expires: now() + API_MEDIA_TTL_MS,
                  signal: controller.signal,
                },
              );
              data.push(saved);
              deliveredCost += batch.cost / batch.data.length;
              db.prepare(
                "UPDATE holds SET result=? WHERE id=? AND status='held'",
              ).run(
                JSON.stringify({
                  delivered: Math.min(amount, usdUnits(deliveredCost * factor)),
                  mediaIds: data.map((item) => item.id),
                  description: m.name,
                }),
                hold,
              );
            }
          },
        );
        if (!data.length)
          fail(502, "Provider returned no image. No credits were charged.");
        respond(finish());
      } catch (e) {
        if (data.length) {
          return respond(finish(), {
            partial: true,
            warning: `${data.length} image${data.length === 1 ? " was" : "s were"} saved before the batch stopped. Only saved images were charged. ${e.status ? e.message : "The remaining images could not be completed."}`,
          });
        }
        release(db, hold);
        throw e;
      } finally {
        clearTimeout(deadline);
        inflight.controllers.delete(controller);
        inflight.holds.delete(hold);
      }
    },
  );

  app.post(
    "/v1/audio/speech",
    ...guard,
    async (req, res) => {
      const m = await ctx.audio.model("tts", String(req.body.model || ""));
      const text =
        typeof req.body.input === "string" ? req.body.input.trim() : "";
      const maxChars = m.char_limit || 5000;
      if (!text || text.length > maxChars)
        fail(400, `Enter text up to ${maxChars.toLocaleString()} characters.`);
      const voice = req.body.voice == null ? "" : String(req.body.voice);
      if (voice && m.voices?.length && !m.voices.some((v) => v.id === voice))
        fail(400, "Choose one of this model's voices.");
      if (
        req.body.response_format != null &&
        !SPEECH_FORMATS.has(String(req.body.response_format))
      )
        fail(400, "Choose a supported response_format.");
      const factor = markupFactor(req.user, cfg);
      const amount = usdUnits((text.length / 1000) * m.pricing.api_price * factor);
      const requestId = requestIdentifier(req),
        hold = req.user.id + ":" + requestId;
      reserve(db, {
        id: hold,
        user: req.user.id,
        amount,
        key: req.apiKey.id,
        kind: "audio",
        ttl: 240000,
      });
      const controller = new AbortController();
      inflight.controllers.add(controller);
      inflight.holds.add(hold);
      res.on("close", () => {
        if (!res.writableEnded)
          controller.abort(new Error("Client disconnected"));
      });
      try {
        const { bytes, mime } = await synthesizeSpeech(
          cfg,
          { model: m.id, input: text, voice, language: "" },
          controller.signal,
        );
        const media = await saveMedia(req.user.id, "audio", bytes, {
          mime,
          prompt: text.slice(0, 500),
          model: m.id,
          expires: now() + API_MEDIA_TTL_MS,
        });
        const receipt = settle(db, hold, amount, "Speech: " + m.name, {
          model: m.id,
          characters: text.length,
        });
        assignCosts([media.id], receipt.charged, req.user.id);
        const signed = issueMediaReceipt(ctx, {
          hold,
          user: req.user.id,
          requestId,
          receipt,
          model: m.id,
          kind: "speech",
          request: { model: m.id, input: text, voice },
          output: bytes,
        });
        // The body is the audio itself, so the extension travels in headers;
        // the signed receipt is base64 JSON of { receipt, signature, key_id }.
        res.set("Content-Type", mime);
        res.set("X-Anonyma-Credits-Charged", String(receipt.credits_charged));
        // A body requestId may hold characters a header can't carry; the
        // signed receipt (base64) still names it.
        if (/^[\x20-\x7e]+$/.test(requestId))
          res.set("X-Anonyma-Request-Id", requestId);
        res.set("X-Anonyma-Media-Id", media.id);
        if (signed)
          res.set(
            "X-Anonyma-Signed-Receipt",
            Buffer.from(JSON.stringify(signed)).toString("base64"),
          );
        res.send(bytes);
      } catch (e) {
        release(db, hold);
        throw e;
      } finally {
        inflight.controllers.delete(controller);
        inflight.holds.delete(hold);
      }
    },
  );

  app.post(
    "/v1/audio/transcriptions",
    ...guard,
    async (req, res) => {
      const { fields, file } = await parseMultipart(req, MAX_UPLOAD_BYTES);
      if (!file)
        fail(400, 'Send the recording as multipart/form-data under "file".');
      if (!/^audio\//.test(file.mime)) fail(400, "Upload must be an audio file.");
      const m = await ctx.audio.model("stt", String(fields.model || "nova-3"));
      const language = fields.language == null ? "" : String(fields.language);
      if (language && !/^[a-z]{2}(-[A-Z]{2})?$|^multi$/.test(language))
        fail(400, "Language must be an ISO 639-1 code.");
      const factor = markupFactor(req.user, cfg);
      const perMinute = m.pricing.api_price * factor;
      // Duration is only known afterwards: hold the maximum, charge the actual.
      const amount = usdUnits(MAX_TRANSCRIPTION_MINUTES * perMinute);
      const requestId = requestIdentifier(req),
        hold = req.user.id + ":" + requestId;
      reserve(db, {
        id: hold,
        user: req.user.id,
        amount,
        key: req.apiKey.id,
        kind: "audio",
        ttl: 240000,
      });
      const controller = new AbortController();
      inflight.controllers.add(controller);
      inflight.holds.add(hold);
      res.on("close", () => {
        if (!res.writableEnded)
          controller.abort(new Error("Client disconnected"));
      });
      try {
        const { text, duration } = await transcribeAudio(
          cfg,
          { model: m.id, bytes: file.bytes, mime: file.mime, language },
          controller.signal,
        );
        const minutes =
          duration == null ? MAX_TRANSCRIPTION_MINUTES : duration / 60;
        const receipt = settle(
          db,
          hold,
          usdUnits(minutes * perMinute),
          "Transcription: " + m.name,
          { model: m.id, seconds: duration },
        );
        const signed = issueMediaReceipt(ctx, {
          hold,
          user: req.user.id,
          requestId,
          receipt,
          model: m.id,
          kind: "transcription",
          request: {
            model: m.id,
            file_sha256: hash(file.bytes),
            language,
          },
          output: text,
        });
        res.json({ text, anonyma: extension(receipt, requestId, signed) });
      } catch (e) {
        release(db, hold);
        throw e;
      } finally {
        inflight.controllers.delete(controller);
        inflight.holds.delete(hold);
      }
    },
  );

  app.post("/v1/videos", ...guard, async (req, res) => {
    const body = await submitVideoJob(ctx, req, {
      key: req.apiKey.id,
      api: true,
    });
    res.status(202).json(body);
  });
  app.get("/v1/videos/:id", ...guard, (req, res) => {
    const job = db
      .prepare("SELECT * FROM videos WHERE id=? AND user_id=?")
      .get(req.params.id, req.user.id);
    if (!job) fail(404, "Unknown video job.", "not_found");
    const media =
      job.media_id &&
      db.prepare("SELECT * FROM media WHERE id=?").get(job.media_id);
    // Once the worker has settled the job: what it cost and, when receipts
    // are live, the receipt the worker signed.
    const hold =
      job.status === "completed" &&
      db
        .prepare("SELECT result FROM holds WHERE id=? AND status='settled'")
        .get(job.hold_id);
    const signed =
      hold &&
      db
        .prepare(
          "SELECT payload,signature,key_id FROM receipt_signatures WHERE receipt_id=? AND user_id=?",
        )
        .get(job.hold_id, req.user.id);
    res.json({
      id: job.id,
      status: job.status,
      ...(media ? { url: signedMediaURL(media) } : {}),
      ...(job.error ? { error: job.error } : {}),
      ...(hold
        ? {
            anonyma: extension(
              JSON.parse(hold.result),
              job.hold_id.slice(req.user.id.length + 1),
              signed && {
                receipt: JSON.parse(signed.payload),
                signature: signed.signature,
                key_id: signed.key_id,
              },
            ),
          }
        : {}),
    });
  });
}
