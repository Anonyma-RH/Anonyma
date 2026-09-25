import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createApp } from "../server/app.js";
import { addCredit, balance, usdUnits } from "../server/core.js";

function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-audio-"));
  const svc = createApp({
    testMode: true, released: "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function signUp(app, name = "listener") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
async function gateway(t, handler) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => s.close(r)));
  return "http://127.0.0.1:" + s.address().port;
}
const catalog = {
  object: "list",
  data: {
    tts: [
      {
        id: "eleven_flash_v2_5",
        name: "Eleven Flash v2.5",
        provider: "elevenlabs",
        pricing: { unit: "per_1k_chars", api_price: 0.0422 },
        voices: [{ id: "voice-1", name: "Roger", language: "multi" }],
      },
      { id: "unpriced", name: "No price", pricing: {} },
    ],
    stt: [
      {
        id: "nova-3",
        name: "Nova 3",
        pricing: { unit: "per_minute", api_price: 0.00633 },
      },
      {
        id: "2-medical",
        name: "Medical",
        pricing: { unit: "per_minute", api_price: 0.00633 },
      },
    ],
  },
};

test("speech is charged per character, stored privately and listed in the library", async (t) => {
  let spoken;
  const url = await gateway(t, async (req, res) => {
    if (req.url === "/v1/audio/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(catalog));
    }
    let raw = "";
    for await (const c of req) raw += c;
    spoken = JSON.parse(raw);
    res.writeHead(200, { "content-type": "audio/mpeg" });
    res.end(Buffer.from("ID3fake-mp3-bytes"));
  });
  const s = fixture(t, {
    testMode: false,
    gateway: url,
    gatewayKey: "fixture",
  });
  const { agent, user } = await signUp(s.app);
  addCredit(s.db, user.id, 10_000_000, "audio-fund", "test_credit");
  const models = (await agent.get("/api/audio/models").expect(200)).body;
  assert.deepEqual(
    models.tts.map((m) => m.id),
    ["eleven_flash_v2_5"],
    "unpriced models hidden",
  );
  assert.deepEqual(
    models.stt.map((m) => m.id),
    ["nova-3"],
    "niche transcription models hidden",
  );

  const text = "Hello from Anonyma. ".repeat(10).trim();
  const before = balance(s.db, user.id).total;
  const r = await agent
    .post("/api/audio/speech")
    .send({ model: "eleven_flash_v2_5", voice: "voice-1", text })
    .expect(200);
  assert.deepEqual(spoken, {
    model: "eleven_flash_v2_5",
    input: text,
    voice: "voice-1",
  });
  assert.equal(r.body.data.kind, "audio");
  assert.equal(r.body.data.mime, "audio/mpeg");
  assert.equal(
    before - balance(s.db, user.id).total,
    usdUnits((text.length / 1000) * 0.0422),
  );
  const library = (await agent.get("/api/media").expect(200)).body.data;
  assert.equal(library[0].kind, "audio");
  const file = await agent.get(library[0].url).expect(200);
  assert.equal(file.headers["content-type"], "audio/mpeg");

  // Invalid requests are refused before anything is reserved.
  await agent
    .post("/api/audio/speech")
    .send({ model: "eleven_flash_v2_5", voice: "nope", text })
    .expect(400);
  await agent
    .post("/api/audio/speech")
    .send({ model: "eleven_flash_v2_5", text: "" })
    .expect(400);
  await agent
    .post("/api/audio/speech")
    .send({ model: "missing", text })
    .expect(404);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 1);
});

test("transcription holds ten minutes and charges the transcribed duration", async (t) => {
  let received;
  const url = await gateway(t, async (req, res) => {
    if (req.url === "/v1/audio/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(catalog));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    received = {
      type: req.headers["content-type"],
      body: Buffer.concat(chunks).toString("latin1"),
    };
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ text: "Build the thing.", duration: 90 }));
  });
  const s = fixture(t, {
    testMode: false,
    gateway: url,
    gatewayKey: "fixture",
  });
  const { agent, user } = await signUp(s.app);
  addCredit(s.db, user.id, 10_000_000, "stt-fund", "test_credit");
  const recording =
    "data:audio/webm;codecs=opus;base64," +
    Buffer.from("fake-webm").toString("base64");
  const before = balance(s.db, user.id).total;
  const r = await agent
    .post("/api/audio/transcriptions")
    .send({ audio: recording })
    .expect(200);
  assert.equal(r.body.text, "Build the thing.");
  assert.match(received.type, /^multipart\/form-data/);
  assert.match(received.body, /name="model"\r\n\r\nnova-3/);
  assert.match(received.body, /filename="recording.webm"/);
  assert.equal(before - balance(s.db, user.id).total, usdUnits(1.5 * 0.00633));
  const hold = s.db.prepare("SELECT amount FROM holds").get();
  assert.equal(hold.amount, usdUnits(10 * 0.00633));

  await agent
    .post("/api/audio/transcriptions")
    .send({ audio: "data:image/png;base64,AAAA" })
    .expect(400);
});

test("a provider failure during speech releases the reservation", async (t) => {
  const url = await gateway(t, async (req, res) => {
    if (req.url === "/v1/audio/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(catalog));
    }
    for await (const _ of req);
    res.writeHead(500, { "content-type": "application/json" });
    res.end("{}");
  });
  const s = fixture(t, {
    testMode: false,
    gateway: url,
    gatewayKey: "fixture",
  });
  const { agent, user } = await signUp(s.app);
  addCredit(s.db, user.id, 10_000_000, "fail-fund", "test_credit");
  const before = balance(s.db, user.id).total;
  await agent
    .post("/api/audio/speech")
    .send({ model: "eleven_flash_v2_5", text: "Hello" })
    .expect(502);
  assert.equal(balance(s.db, user.id).total, before);
  assert.equal(balance(s.db, user.id).held, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM media").get().n, 0);
});

test("local test mode speaks and transcribes without a provider", async (t) => {
  const s = fixture(t);
  const { agent } = await signUp(s.app);
  const models = (await agent.get("/api/audio/models").expect(200)).body;
  const spoken = await agent
    .post("/api/audio/speech")
    .send({
      model: models.tts[0].id,
      voice: models.tts[0].voices[0].id,
      text: "Test",
    })
    .expect(200);
  assert.equal(spoken.body.data.mime, "audio/wav");
  assert.equal(spoken.body.testMode, true);
  const heard = await agent
    .post("/api/audio/transcriptions")
    .send({
      audio: "data:audio/wav;base64," + Buffer.from("RIFF").toString("base64"),
    })
    .expect(200);
  assert.match(heard.body.text, /Local test transcription/);
});
