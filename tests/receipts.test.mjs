import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { createApp } from "../server/app.js";
import { UPDATES } from "../server/releases.js";

// This file exercises the "receipts" update in isolation, so it is pinned
// unreleased on UPDATES for its own duration exactly like releases.test.mjs,
// independent of whatever has actually shipped on main.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MVP_MODEL = "google/gemini-2.5-flash";
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-receipts-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: "all",
    mvpModels: [MVP_MODEL],
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function register(app, name = "tester") {
  const agent = request.agent(app);
  const result = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return { agent, user: result.body.user };
}
const chat = (extra = {}) => ({
  model: MVP_MODEL,
  messages: [{ role: "user", content: "Hello there" }],
  max_tokens: 40,
  ...extra,
});
// The final SSE event is the one carrying the settlement extension.
function lastEvent(sseText) {
  const line = sseText
    .split("\n\n")
    .filter((l) => l.startsWith("data: ") && l.includes('"anonyma"'))
    .pop();
  return JSON.parse(line.slice(6));
}
// Reassembles the streamed answer from its content deltas, the way a client would.
function assembleAnswer(sseText) {
  let out = "";
  for (const line of sseText.split("\n\n")) {
    if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
    let evt;
    try {
      evt = JSON.parse(line.slice(6));
    } catch {
      continue;
    }
    const delta = evt.choices?.[0]?.delta;
    if (typeof delta?.content === "string") out += delta.content;
  }
  return out;
}

test("a settled chat produces a signed receipt that verifies, and catches tampering", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const r = await agent
    .post("/api/chat")
    .send(chat({ requestId: "receipt-1" }))
    .expect(200);
  const final = lastEvent(r.text);
  const signed = final.anonyma.signed_receipt;
  assert.ok(signed, "the final event carries a signed receipt");
  assert.equal(signed.receipt.v, 1);
  assert.equal(signed.receipt.id, "receipt-1");
  assert.equal(signed.receipt.model, MVP_MODEL);
  assert.ok(signed.receipt.usage.input_tokens > 0);
  assert.ok(signed.receipt.usage.output_tokens > 0);
  assert.equal(signed.receipt.credits_charged, final.anonyma.credits_charged);
  assert.equal(signed.receipt.key_id, signed.key_id);
  // Never leaks who made the request.
  assert.ok(!JSON.stringify(signed.receipt).includes(user.id));

  const ok = (
    await request(s.app)
      .post("/api/receipts/verify")
      .send({ receipt: signed.receipt, signature: signed.signature })
      .expect(200)
  ).body;
  assert.equal(ok.valid, true);
  assert.equal(ok.key_id, signed.key_id);
  assert.ok(!("answer_matches" in ok));

  // The owner can fetch the same stored copy back by its requestId.
  const stored = await agent.get("/api/receipts/receipt-1").expect(200);
  assert.deepEqual(stored.body.receipt, signed.receipt);
  assert.equal(stored.body.signature, signed.signature);
  // A stranger — and an unknown id — get nothing.
  const other = await register(s.app, "stranger");
  await other.agent.get("/api/receipts/receipt-1").expect(404);
  await agent.get("/api/receipts/does-not-exist").expect(404);

  const answer = assembleAnswer(r.text);
  assert.ok(answer.length > 0);
  const matched = (
    await request(s.app)
      .post("/api/receipts/verify")
      .send({ receipt: signed.receipt, signature: signed.signature, answer })
      .expect(200)
  ).body;
  assert.equal(matched.valid, true);
  assert.equal(matched.answer_matches, true);

  const wrongAnswer = (
    await request(s.app)
      .post("/api/receipts/verify")
      .send({
        receipt: signed.receipt,
        signature: signed.signature,
        answer: answer + " actually not",
      })
      .expect(200)
  ).body;
  assert.equal(wrongAnswer.valid, true, "the receipt itself is still genuine");
  assert.equal(wrongAnswer.answer_matches, false);

  // Tampering with any signed field breaks the signature.
  for (const patch of [
    { credits_charged: signed.receipt.credits_charged + 1 },
    { model: "another/model" },
    { response_sha256: "0".repeat(64) },
  ]) {
    const tampered = (
      await request(s.app)
        .post("/api/receipts/verify")
        .send({ receipt: { ...signed.receipt, ...patch }, signature: signed.signature })
        .expect(200)
    ).body;
    assert.equal(tampered.valid, false, JSON.stringify(patch));
    assert.equal(tampered.reason, "invalid_signature");
  }
  // Tampering with the signature itself also fails.
  const tamperedSig = (
    await request(s.app)
      .post("/api/receipts/verify")
      .send({ receipt: signed.receipt, signature: signed.signature.slice(0, -4) + "AAAA" })
      .expect(200)
  ).body;
  assert.equal(tamperedSig.valid, false);
  // An unrecognized key is reported distinctly, not as an invalid signature.
  const unknownKey = (
    await request(s.app)
      .post("/api/receipts/verify")
      .send({
        receipt: { ...signed.receipt, key_id: "0000000000000000" },
        signature: signed.signature,
      })
      .expect(200)
  ).body;
  assert.equal(unknownKey.valid, false);
  assert.equal(unknownKey.reason, "unknown_key");

  // The public key is published two ways and agrees with the receipt's key_id.
  const key = (await request(s.app).get("/api/receipts/key").expect(200)).body;
  assert.equal(key.key_id, signed.key_id);
  assert.equal(key.algorithm, "Ed25519");
  assert.match(key.public_key_pem, /BEGIN PUBLIC KEY/);
  const wellKnown = await request(s.app)
    .get("/.well-known/anonyma-receipts.json")
    .expect(200);
  assert.deepEqual(wellKnown.body, key);
});

test("the signing key persists across app restarts on the same database", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-receipts-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const dbPath = join(dir, "test.sqlite");
  const opts = {
    testMode: true,
    dbPath,
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    mvpModels: [MVP_MODEL],
  };
  const first = createApp(opts);
  const keyA = (await request(first.app).get("/api/receipts/key").expect(200)).body;
  first.close();
  const second = createApp(opts);
  t.after(() => second.close());
  const keyB = (await request(second.app).get("/api/receipts/key").expect(200)).body;
  assert.equal(keyB.key_id, keyA.key_id);
  assert.equal(keyB.public_key_pem, keyA.public_key_pem);
});

test("RECEIPT_SIGNING_KEY, when set, is used instead of generating and storing one", async (t) => {
  const { privateKey } = generateKeyPairSync("ed25519");
  const der = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
  const a = fixture(t, { receiptSigningKey: der });
  const b = fixture(t, { receiptSigningKey: der }); // a separate, empty database
  const keyA = (await request(a.app).get("/api/receipts/key").expect(200)).body;
  const keyB = (await request(b.app).get("/api/receipts/key").expect(200)).body;
  assert.equal(keyA.key_id, keyB.key_id);
  assert.equal(keyA.public_key_pem, keyB.public_key_pem);
  assert.equal(a.db.prepare("SELECT COUNT(*) n FROM receipt_keys").get().n, 0);
});

test("nothing is signed or exposed while the update is unreleased, and gating matches the release system", async (t) => {
  const entry = UPDATES.find((u) => u.id === "receipts");
  assert.ok(entry, "the receipts update is registered");
  assert.equal(entry.title, "Signed Receipts");
  assert.equal(entry.tagline, "Proof of what ran, and what it cost.");

  const off = fixture(t, { released: "mvp" });
  const { agent } = await register(off.app);
  const r = await agent.post("/api/chat").send(chat({ requestId: "gated-1" })).expect(200);
  const final = lastEvent(r.text);
  assert.equal(final.anonyma.signed_receipt, undefined);
  assert.equal(
    off.db.prepare("SELECT COUNT(*) n FROM receipt_signatures").get().n,
    0,
    "nothing was persisted either",
  );
  for (const attempt of [
    () => agent.get("/api/receipts/key"),
    () => request(off.app).get("/.well-known/anonyma-receipts.json"),
    () => agent.post("/api/receipts/verify").send({ receipt: {}, signature: "x" }),
    () => agent.get("/api/receipts/gated-1"),
  ]) {
    const res = await attempt().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Signed Receipts is coming soon.");
  }

  const on = fixture(t, { released: "mvp,receipts" });
  const signedIn = await register(on.app);
  const r2 = await signedIn.agent
    .post("/api/chat")
    .send(chat({ requestId: "gated-2" }))
    .expect(200);
  const final2 = lastEvent(r2.text);
  assert.ok(final2.anonyma.signed_receipt, "releasing receipts turns it on");
  await signedIn.agent.get("/api/receipts/key").expect(200);
  await signedIn.agent.get("/api/receipts/gated-2").expect(200);
});
