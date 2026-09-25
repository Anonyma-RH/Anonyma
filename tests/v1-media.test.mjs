import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance, reserve } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";

// Release commits flip `released` on UPDATES entries. Pin every update to
// unreleased for this file (mirrors tests/releases.test.mjs) so its
// assertions hold whichever updates have shipped by the time this runs.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// The granular list a real deployment would set once every dependency for
// this feature has shipped: mvp + api + v1media + each studio it needs.
const GRANULAR_RELEASED = "mvp,api,v1media,images,audio,video";
const imageModel = "google/gemini-2.5-flash-image";
const chatModel = "google/gemini-2.5-flash";
const videoModel = "kling-2.5-turbo";

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-v1media-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    // The server defaults to the MVP, so the default fixture opens every
    // update explicitly (including the full model catalog), so these tests
    // exercise endpoint behavior rather than release gating; the gating test
    // passes its own granular list.
    released: released ?? "all",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function register(app, name = "dev") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
async function keyFor(agent, cap = null) {
  return (await agent.post("/api/keys").send({ name: "v1", cap }).expect(201))
    .body;
}
const bearer = (key) => "Bearer " + key.key;
const count = (db, table, user) =>
  db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(user).n;
// One call to each /v1 media endpoint with a valid body.
const mediaCalls = (app, key) => ({
  image: () =>
    request(app)
      .post("/v1/images/generations")
      .set("Authorization", bearer(key))
      .send({ model: imageModel, prompt: "x", n: 1 }),
  speech: () =>
    request(app)
      .post("/v1/audio/speech")
      .set("Authorization", bearer(key))
      .send({ model: "fixture-voice", input: "Hello from Anonyma." }),
  transcription: () =>
    request(app)
      .post("/v1/audio/transcriptions")
      .set("Authorization", bearer(key))
      .field("model", "nova-3")
      .attach("file", Buffer.from("fake-wav-bytes"), {
        filename: "clip.wav",
        contentType: "audio/wav",
      }),
  video: () =>
    request(app)
      .post("/v1/videos")
      .set("Authorization", bearer(key))
      .send({
        model: videoModel,
        prompt: "Test clip",
        aspect_ratio: "16:9",
        duration: "5",
      }),
});
// Nothing reached a provider or the ledger: no hold, media, video job or
// charge exists for the account.
function assertUntouched(db, user, ledgerBaseline) {
  for (const table of ["holds", "media", "videos"])
    assert.equal(count(db, table, user), 0, `no ${table} row`);
  assert.equal(ledgerCount(db, user), ledgerBaseline);
}
const ledgerCount = (db, user) =>
  db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=?").get(user).n;

test("images: generates 1-4 images, charges once per request, both response formats work", async (t) => {
  const s = fixture(t);
  // Local test mode funds new accounts with 100,000 test credits, ample for
  // these cheap fixture generations.
  const { agent, user } = await register(s.app, "artist");
  const key = await keyFor(agent);
  const baseline = ledgerCount(s.db, user.id);
  const before = balance(s.db, user.id).total;

  const url = await request(s.app)
    .post("/v1/images/generations")
    .set("Authorization", bearer(key))
    .send({ model: imageModel, prompt: "A cobalt blue paper airplane", n: 2 })
    .expect(200);
  assert.equal(url.body.data.length, 2);
  assert.ok(url.body.data[0].url.startsWith("http"));
  assert.ok(url.body.created > 0);
  assert.ok(url.body.anonyma.credits_charged > 0);
  assert.equal(url.body.askr, undefined);
  assert.ok(before - balance(s.db, user.id).total > 0);
  assert.equal(ledgerCount(s.db, user.id), baseline + 1);

  const b64 = await request(s.app)
    .post("/v1/images/generations")
    .set("Authorization", bearer(key))
    .send({ model: imageModel, prompt: "x", n: 1, response_format: "b64_json" })
    .expect(200);
  assert.ok(b64.body.data[0].b64_json);
  assert.equal(ledgerCount(s.db, user.id), baseline + 2);

  const bad = await request(s.app)
    .post("/v1/images/generations")
    .set("Authorization", bearer(key))
    .send({ model: imageModel, prompt: "x", n: 9 })
    .expect(400);
  assert.equal(bad.body.error.code, "invalid_request");

  // A chat-only model isn't an image model.
  const wrongType = await request(s.app)
    .post("/v1/images/generations")
    .set("Authorization", bearer(key))
    .send({ model: chatModel, prompt: "x", n: 1 })
    .expect(400);
  assert.match(wrongType.body.error.message, /image model/);
  assert.equal(ledgerCount(s.db, user.id), baseline + 2);
});

test("audio: speech returns priced bytes, transcription returns priced text, wrong model types refused", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app, "narrator");
  const key = await keyFor(agent);
  const baseline = ledgerCount(s.db, user.id);
  const before = balance(s.db, user.id).total;

  const speech = await request(s.app)
    .post("/v1/audio/speech")
    .set("Authorization", bearer(key))
    .send({ model: "fixture-voice", input: "Hello from Anonyma." })
    .expect(200);
  assert.match(speech.headers["content-type"], /^audio\//);
  const speechCharged = Number(speech.headers["x-anonyma-credits-charged"]);
  assert.ok(speechCharged > 0);
  assert.ok(speech.headers["x-anonyma-media-id"]);
  assert.equal(before - balance(s.db, user.id).total, speechCharged * 10000);
  assert.equal(ledgerCount(s.db, user.id), baseline + 1);

  // A speech model that isn't in the tts catalog (an image model id) is
  // refused clearly, not silently accepted.
  const wrongSpeechModel = await request(s.app)
    .post("/v1/audio/speech")
    .set("Authorization", bearer(key))
    .send({ model: imageModel, input: "x" })
    .expect(404);
  assert.equal(wrongSpeechModel.body.error.code, "model_not_found");
  assert.equal(ledgerCount(s.db, user.id), baseline + 1);

  const afterSpeech = balance(s.db, user.id).total;
  const transcription = await request(s.app)
    .post("/v1/audio/transcriptions")
    .set("Authorization", bearer(key))
    .field("model", "nova-3")
    .attach("file", Buffer.from("fake-wav-bytes"), {
      filename: "clip.wav",
      contentType: "audio/wav",
    })
    .expect(200);
  assert.ok(transcription.body.text);
  assert.ok(transcription.body.anonyma.credits_charged > 0);
  assert.ok(afterSpeech - balance(s.db, user.id).total > 0);
  assert.equal(ledgerCount(s.db, user.id), baseline + 2);

  const noFile = await request(s.app)
    .post("/v1/audio/transcriptions")
    .set("Authorization", bearer(key))
    .field("model", "nova-3")
    .expect(400);
  assert.equal(noFile.body.error.code, "invalid_request");
});

test("video: submits, polls to completion with a signed URL, charges once, refuses a wrong model type", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app, "director");
  const key = await keyFor(agent);
  const baseline = ledgerCount(s.db, user.id);

  const submit = await request(s.app)
    .post("/v1/videos")
    .set("Authorization", bearer(key))
    .send({
      model: videoModel,
      prompt: "Test clip",
      aspect_ratio: "16:9",
      duration: "5",
    })
    .expect(202);
  assert.ok(submit.body.id);
  assert.equal(submit.body.status, "pending");
  assert.ok(balance(s.db, user.id).held > 0);
  assert.equal(ledgerCount(s.db, user.id), baseline); // held, not charged yet

  const queued = await request(s.app)
    .get("/v1/videos/" + submit.body.id)
    .set("Authorization", bearer(key))
    .expect(200);
  assert.equal(queued.body.status, "pending");
  assert.equal(queued.body.url, undefined);

  await s.tick();
  const done = await request(s.app)
    .get("/v1/videos/" + submit.body.id)
    .set("Authorization", bearer(key))
    .expect(200);
  assert.equal(done.body.status, "completed");
  assert.match(done.body.url, /^http.*\/api\/media\/.*\?expires=\d+&sig=[a-f0-9]{64}$/);
  assert.equal(balance(s.db, user.id).held, 0);
  assert.equal(ledgerCount(s.db, user.id), baseline + 1);

  const missing = await request(s.app)
    .get("/v1/videos/not-a-real-id")
    .set("Authorization", bearer(key))
    .expect(404);
  assert.equal(missing.body.error.code, "not_found");

  const wrongType = await request(s.app)
    .post("/v1/videos")
    .set("Authorization", bearer(key))
    .send({ model: chatModel, prompt: "x" })
    .expect(400);
  assert.match(wrongType.body.error.message, /video model/);
});

test("insufficient credits refuse every /v1 media endpoint before any work is done", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app, "broke");
  const key = await keyFor(agent);
  // Local test mode funds new accounts with 100,000 test credits; lock all
  // of it under an unrelated hold so nothing is available for these calls.
  reserve(s.db, {
    id: "lockup:" + user.id,
    user: user.id,
    amount: balance(s.db, user.id).available,
    kind: "chat",
  });
  assert.equal(balance(s.db, user.id).available, 0);

  const image = await request(s.app)
    .post("/v1/images/generations")
    .set("Authorization", bearer(key))
    .send({ model: imageModel, prompt: "x", n: 1 })
    .expect(402);
  assert.equal(image.body.error.code, "insufficient_credits");

  const video = await request(s.app)
    .post("/v1/videos")
    .set("Authorization", bearer(key))
    .send({ model: videoModel, prompt: "x", aspect_ratio: "16:9", duration: "5" })
    .expect(402);
  assert.equal(video.body.error.code, "insufficient_credits");

  // Only the lockup hold exists; neither refused call created one.
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM holds WHERE user_id=?").get(user.id).n,
    1,
  );
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM media WHERE user_id=?").get(user.id).n,
    0,
  );
});

test("a key's rolling 24-hour spending cap refuses before any work is done", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app, "capped");
  // 1 displayed credit is far under one generated image's cost.
  const key = await keyFor(agent, 1);
  const r = await request(s.app)
    .post("/v1/images/generations")
    .set("Authorization", bearer(key))
    .send({ model: imageModel, prompt: "x", n: 1 })
    .expect(429);
  assert.equal(r.body.error.code, "key_cap_exceeded");
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM media WHERE user_id=?").get(user.id).n,
    0,
  );
});

test("release gating needs api, v1media and the matching studio update", async (t) => {
  const refused = async (res, title) => {
    const r = await res.expect(403);
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.equal(r.body.error.message, `${title} is coming soon.`);
  };
  const mvpOnly = fixture(t, "mvp");
  await refused(
    request(mvpOnly.app).post("/v1/images/generations").send({}),
    "Developer API & CLI",
  );
  await refused(
    request(mvpOnly.app).post("/v1/audio/speech").send({}),
    "Developer API & CLI",
  );
  await refused(
    request(mvpOnly.app).post("/v1/audio/transcriptions").send({}),
    "Developer API & CLI",
  );
  await refused(
    request(mvpOnly.app).post("/v1/videos").send({}),
    "Developer API & CLI",
  );
  await refused(
    request(mvpOnly.app).get("/v1/videos/x"),
    "Developer API & CLI",
  );

  const apiOnly = fixture(t, "mvp,api");
  await refused(
    request(apiOnly.app).post("/v1/images/generations").send({}),
    "Multimodal API",
  );

  const noStudio = fixture(t, "mvp,api,v1media");
  await refused(
    request(noStudio.app).post("/v1/images/generations").send({}),
    "Image Studio",
  );
  await refused(
    request(noStudio.app).post("/v1/audio/speech").send({}),
    "Voice & Audio",
  );
  await refused(
    request(noStudio.app).post("/v1/audio/transcriptions").send({}),
    "Voice & Audio",
  );
  await refused(request(noStudio.app).post("/v1/videos").send({}), "Video Studio");
  await refused(request(noStudio.app).get("/v1/videos/x"), "Video Studio");

  // Every dependency released (granular, not "all"): the same request now
  // reaches the API key check instead of the release gate.
  const full = fixture(t, GRANULAR_RELEASED);
  const r = await request(full.app).post("/v1/images/generations").send({});
  assert.equal(r.status, 401);

  const { agent } = await register(full.app, "gate-full");
  const key = await keyFor(agent);
  await request(full.app)
    .post("/v1/images/generations")
    .set("Authorization", bearer(key))
    .send({ model: imageModel, prompt: "x", n: 1 })
    .expect(200);
});

test("featuresFor expresses the /v1 media gates as arrays: api, v1media and the studio", () => {
  const gates = (method, path) => featuresFor({ method, path, body: {} });
  assert.deepEqual(gates("POST", "/v1/images/generations"), [
    "api",
    "v1media",
    "images",
  ]);
  assert.deepEqual(gates("POST", "/v1/audio/speech"), ["api", "v1media", "audio"]);
  assert.deepEqual(gates("POST", "/V1/Audio/Transcriptions"), [
    "api",
    "v1media",
    "audio",
  ]);
  assert.deepEqual(gates("POST", "/v1/videos"), ["api", "v1media", "video"]);
  assert.deepEqual(gates("GET", "/v1/videos/abc"), ["api", "v1media", "video"]);
  // Chat completions keeps needing only the API.
  assert.deepEqual(gates("POST", "/v1/chat/completions"), ["api"]);
  // The published contract hides the media routes until they're live.
  const hidden = openapiForConfig({ released: new Set(["api"]) }).paths;
  assert.ok(hidden["/v1/chat/completions"]);
  assert.equal(hidden["/v1/images/generations"], undefined);
  assert.equal(hidden["/v1/videos/{id}"], undefined);
  const live = openapiForConfig({
    released: new Set(["api", "v1media", "images", "audio", "video"]),
  }).paths;
  for (const path of [
    "/v1/images/generations",
    "/v1/audio/speech",
    "/v1/audio/transcriptions",
    "/v1/videos",
    "/v1/videos/{id}",
  ])
    assert.ok(live[path], path);
});

test("a paused key stops every /v1 media request before any work, until resumed", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app, "paused");
  const key = await keyFor(agent);
  const baseline = ledgerCount(s.db, user.id);
  await agent.post(`/api/keys/${key.id}/pause`).send({}).expect(200);
  const calls = mediaCalls(s.app, key);
  for (const [name, call] of Object.entries(calls)) {
    const r = await call();
    assert.equal(r.status, 403, name);
    assert.equal(r.body.error.code, "key_paused", name);
  }
  assertUntouched(s.db, user.id, baseline);

  await agent.post(`/api/keys/${key.id}/resume`).send({}).expect(200);
  await calls.image().expect(200);
  assert.equal(ledgerCount(s.db, user.id), baseline + 1);
});

test("an expired allowance stops every /v1 media request before any work", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app, "expired");
  const key = await keyFor(agent);
  const baseline = ledgerCount(s.db, user.id);
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ expires_at: Date.now() - 1000 })
    .expect(200);
  for (const [name, call] of Object.entries(mediaCalls(s.app, key))) {
    const r = await call();
    assert.equal(r.status, 403, name);
    assert.equal(r.body.error.code, "key_expired", name);
  }
  assertUntouched(s.db, user.id, baseline);
});

test("an allowance stops a /v1 media request that could exceed it, and media spend counts against it", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app, "allowance");
  const key = await keyFor(agent);
  const baseline = ledgerCount(s.db, user.id);
  // 0.0001 credits: far below any media request's worst-case hold.
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: 0.0001 })
    .expect(200);
  for (const [name, call] of Object.entries(mediaCalls(s.app, key))) {
    const r = await call();
    assert.equal(r.status, 402, name);
    assert.equal(r.body.error.code, "allowance_exhausted", name);
    assert.match(r.body.error.message, /allowance/, name);
  }
  assertUntouched(s.db, user.id, baseline);

  // A generous allowance lets one image through; its charge is what the
  // key's usage reports, and an allowance set to exactly that spend then
  // refuses the next media request as used up.
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: 1000 })
    .expect(200);
  const ok = await mediaCalls(s.app, key).image().expect(200);
  const usage = (await agent.get(`/api/keys/${key.id}/usage`).expect(200)).body;
  assert.equal(usage.spent_total, ok.body.anonyma.credits_charged);
  assert.equal(usage.requests, 1);
  await agent
    .patch(`/api/keys/${key.id}/allowance`)
    .send({ total_credits: usage.spent_total })
    .expect(200);
  const used = await mediaCalls(s.app, key).speech().expect(402);
  assert.equal(used.body.error.code, "allowance_exhausted");
  assert.equal(used.body.error.message, "This API key has used its full allowance.");
  assert.equal(ledgerCount(s.db, user.id), baseline + 1);
});

test("every settled /v1 media request carries a signed receipt that verifies", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app, "receipts");
  const key = await keyFor(agent);
  const calls = mediaCalls(s.app, key);
  const verify = async (signed, answer) =>
    (
      await request(s.app)
        .post("/api/receipts/verify")
        .send({
          receipt: signed.receipt,
          signature: signed.signature,
          ...(answer ? { answer } : {}),
        })
        .expect(200)
    ).body;

  const image = (await calls.image().set("Idempotency-Key", "img-1").expect(200))
    .body.anonyma;
  assert.equal(image.request_id, "img-1");
  assert.equal(image.signed_receipt.receipt.id, "img-1");
  assert.equal(image.signed_receipt.receipt.kind, "image");
  assert.equal(image.signed_receipt.receipt.model, imageModel);
  assert.equal(image.signed_receipt.receipt.credits_charged, image.credits_charged);
  assert.ok(!JSON.stringify(image.signed_receipt.receipt).includes(user.id));
  assert.equal((await verify(image.signed_receipt)).valid, true);
  // Stored under its request id like a chat receipt.
  const stored = await agent.get("/api/receipts/img-1").expect(200);
  assert.deepEqual(stored.body.receipt, image.signed_receipt.receipt);
  // Tampering breaks it.
  const forged = await request(s.app)
    .post("/api/receipts/verify")
    .send({
      receipt: { ...image.signed_receipt.receipt, credits_charged: 0 },
      signature: image.signed_receipt.signature,
    })
    .expect(200);
  assert.equal(forged.body.valid, false);

  const speech = await calls.speech().set("Idempotency-Key", "tts-1").expect(200);
  assert.equal(speech.headers["x-anonyma-request-id"], "tts-1");
  const spoken = JSON.parse(
    Buffer.from(speech.headers["x-anonyma-signed-receipt"], "base64").toString(),
  );
  assert.equal(spoken.receipt.kind, "speech");
  assert.equal(
    spoken.receipt.credits_charged,
    Number(speech.headers["x-anonyma-credits-charged"]),
  );
  assert.equal(
    spoken.receipt.response_sha256,
    createHash("sha256").update(speech.body).digest("hex"),
  );
  assert.equal((await verify(spoken)).valid, true);
  // A requestId a header can't carry still settles and is named only in the
  // signed receipt.
  const unicode = await request(s.app)
    .post("/v1/audio/speech")
    .set("Authorization", bearer(key))
    .send({ model: "fixture-voice", input: "Hi", requestId: "语音-1" })
    .expect(200);
  assert.equal(unicode.headers["x-anonyma-request-id"], undefined);
  assert.equal(
    JSON.parse(
      Buffer.from(unicode.headers["x-anonyma-signed-receipt"], "base64").toString(),
    ).receipt.id,
    "语音-1",
  );

  const heard = (await calls.transcription().expect(200)).body;
  assert.equal(heard.anonyma.signed_receipt.receipt.kind, "transcription");
  const checked = await verify(heard.anonyma.signed_receipt, heard.text);
  assert.equal(checked.valid, true);
  assert.equal(checked.answer_matches, true);

  const job = (await calls.video().set("Idempotency-Key", "vid-1").expect(202))
    .body;
  const pending = (
    await request(s.app)
      .get("/v1/videos/" + job.id)
      .set("Authorization", bearer(key))
      .expect(200)
  ).body;
  assert.equal(pending.anonyma, undefined);
  await s.tick();
  const done = (
    await request(s.app)
      .get("/v1/videos/" + job.id)
      .set("Authorization", bearer(key))
      .expect(200)
  ).body;
  assert.equal(done.status, "completed");
  assert.equal(done.anonyma.request_id, "vid-1");
  assert.ok(done.anonyma.credits_charged > 0);
  assert.equal(done.anonyma.signed_receipt.receipt.kind, "video");
  assert.equal(done.anonyma.signed_receipt.receipt.id, "vid-1");
  assert.equal((await verify(done.anonyma.signed_receipt)).valid, true);
});

test("without the receipts update, /v1 media responses carry no signed receipt", async (t) => {
  const s = fixture(t, GRANULAR_RELEASED);
  const { agent } = await register(s.app, "unsigned");
  const key = await keyFor(agent);
  const image = (await mediaCalls(s.app, key).image().expect(200)).body;
  assert.ok(image.anonyma.credits_charged > 0);
  assert.ok(image.anonyma.request_id);
  assert.equal(image.anonyma.signed_receipt, undefined);
  const speech = await mediaCalls(s.app, key).speech().expect(200);
  assert.equal(speech.headers["x-anonyma-signed-receipt"], undefined);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM receipt_signatures").get().n,
    0,
  );
});
