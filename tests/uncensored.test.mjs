import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { UNCENSORED_MODELS, UPDATES } from "../server/releases.js";

// These fixtures test an unreleased catalog independently of release commits.
const controlled = UPDATES.filter((u) => ["uncensored", "catalog", "images"].includes(u.id));
const committedReleases = controlled.map((u) => u.released);
before(() => controlled.forEach((u) => { u.released = false; }));
after(() => controlled.forEach((u, i) => { u.released = committedReleases[i]; }));

const MVP_MODEL = "google/gemini-2.5-flash";
const UNCENSORED = "venice/venice-uncensored-1-2";
const ENCLAVE = "venice/e2ee-gemma-4-26b-a4b-uncensored-p";
function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-uncensored-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released,
    mvpModels: [MVP_MODEL],
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function signedIn(svc) {
  const agent = request.agent(svc.app);
  await agent
    .post("/api/auth/register")
    .send({ username: "tester", password: "test-password-long" })
    .expect(201);
  return agent;
}
const chat = (extra = {}) => ({
  model: UNCENSORED,
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 20,
  mode: "uncensored",
  ...extra,
});
const chatIds = async (a) =>
  (await a.get("/api/models").expect(200)).body.data
    .filter((m) => m.type === "chat")
    .map((m) => m.id)
    .sort();

test("the curated uncensored models are live, explicitly labelled chat models", () => {
  const catalog = JSON.parse(
    readFileSync(new URL("../data/models.snapshot.json", import.meta.url)),
  ).data;
  assert.equal(new Set(UNCENSORED_MODELS).size, UNCENSORED_MODELS.length);
  for (const id of UNCENSORED_MODELS) {
    const m = catalog.find((v) => v.id === id);
    assert.ok(m, `${id} is in the catalog`);
    assert.equal(m.type, "chat");
    assert.equal(m.status, "live");
    assert.match(`${m.name} ${m.description}`, /uncensored/i, `${id} is labelled uncensored`);
    assert.ok(m.pricing.input_per_1M_tokens > 0 && m.pricing.output_per_1M_tokens > 0);
  }
  // The enclave variant is deliberately not offered.
  assert.ok(!UNCENSORED_MODELS.includes(ENCLAVE));
});

test("until released, the Uncensored section and its models stay closed", async (t) => {
  const svc = fixture(t, "mvp");
  const a = await signedIn(svc);
  const r = await a.post("/api/chat").send(chat()).expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(r.body.error.message, "Uncensored Models is coming soon.");
  await a.post("/api/conversations").send({ mode: "uncensored" }).expect(403);
  // Not reachable from plain chat either while the catalog is closed.
  const plain = await a.post("/api/chat").send(chat({ mode: undefined })).expect(503);
  assert.equal(plain.body.error.code, "model_unavailable");
  assert.ok(!(await chatIds(a)).some((id) => UNCENSORED_MODELS.includes(id)));
  const info = (await request(svc.app).get("/api/config").expect(200)).body.releases;
  assert.equal(info.features.uncensored, false);
  assert.deepEqual(info.uncensoredModels, UNCENSORED_MODELS);
  const update = info.updates.find((u) => u.id === "uncensored");
  assert.equal(update.title, "Uncensored Models");
  assert.equal(update.released, false);
});

test("releasing Uncensored opens exactly its curated models and routes billed chat", async (t) => {
  const svc = fixture(t, "mvp,uncensored");
  const a = await signedIn(svc);
  assert.deepEqual(await chatIds(a), [MVP_MODEL, ...UNCENSORED_MODELS].sort());
  const before = (await a.get("/api/me").expect(200)).body.user.available;
  const r = await a.post("/api/chat").send(chat()).expect(200);
  assert.match(r.text, /"credits_charged"/);
  const after = (await a.get("/api/me").expect(200)).body.user.available;
  assert.ok(after < before, "the reply was billed to the prepaid balance");
  const saved = (await a.get("/api/conversations").expect(200)).body.data[0];
  assert.equal(saved.mode, "uncensored");
  // Uncensored models the curation leaves out stay closed, and so does the
  // rest of the catalog.
  await a.post("/api/chat").send(chat({ model: ENCLAVE })).expect(503);
  await a.post("/api/chat").send(chat({ model: "openai/gpt-4o-mini" })).expect(503);
});

test("releasing Uncensored leaves every other gate as it was", async (t) => {
  const svc = fixture(t, "mvp,uncensored");
  const a = await signedIn(svc);
  const info = (await request(svc.app).get("/api/config").expect(200)).body.releases;
  const expected = Object.fromEntries(
    UPDATES.map((u) => [u.id, u.id === "uncensored" || u.released === true]),
  );
  assert.deepEqual(info.features, expected);
  for (const [path, feature] of [
    ["/api/videos", "video"],
    ["/api/collabs", "collab"],
    ["/api/audio/models", "audio"],
    ["/api/referrals", "social"],
  ]) {
    const response = await a.get(path).expect(expected[feature] ? 200 : 403);
    if (!expected[feature])
      assert.equal(response.body.error.code, "feature_unreleased");
  }
  await request(svc.app).get("/v1/models").expect(expected.api ? 401 : 403);
  // A request needing two releases is checked against both.
  if (!expected.search)
    await a.post("/api/chat").send(chat({ web_search: true })).expect(403);
});
