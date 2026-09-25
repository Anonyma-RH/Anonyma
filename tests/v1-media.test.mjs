import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance, reserve } from "../server/core.js";
import { UPDATES } from "../server/releases.js";

// Release commits flip `released` on UPDATES entries. Pin every update to
// unreleased for this file (mirrors tests/releases.test.mjs) so its
// assertions hold whichever updates have shipped by the time this runs.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// Every update released, including the full model catalog, so these tests
// exercise endpoint behavior rather than release gating (that's covered by
// its own test below with a granular RELEASED_FEATURES list).
const ALL_RELEASED = "all";
// The granular list a real deployment would set once every dependency for
// this feature has shipped: mvp + api + v1media + each studio it needs.
const GRANULAR_RELEASED = "mvp,api,v1media,images,audio,video";
const imageModel = "google/gemini-2.5-flash-image";
const chatModel = "google/gemini-2.5-flash";
const videoModel = "kling-2.5-turbo";

function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-v1media-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: ALL_RELEASED,
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
  assert.equal(url.body.askr.credits_charged, url.body.anonyma.credits_charged);
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
  const mvpOnly = fixture(t, { released: "mvp" });
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

  const apiOnly = fixture(t, { released: "mvp,api" });
  await refused(
    request(apiOnly.app).post("/v1/images/generations").send({}),
    "Multimodal API",
  );

  const noStudio = fixture(t, { released: "mvp,api,v1media" });
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
  const full = fixture(t, { released: GRANULAR_RELEASED });
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
