import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { config } from "../server/core.js";
import {
  UPDATES,
  parseReleased,
  isReleased,
  releaseInfo,
} from "../server/releases.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MVP_MODEL = "google/gemini-2.5-flash";
function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-releases-"));
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
  model: MVP_MODEL,
  messages: [{ role: "user", content: "Hello" }],
  max_tokens: 20,
  ...extra,
});
const refused = async (res, title) => {
  const r = await res.expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(r.body.error.message, `${title} is coming soon.`);
};

test("the MVP refuses every unreleased update on the server", async (t) => {
  const svc = fixture(t, "mvp");
  const a = await signedIn(svc);
  await refused(
    a.post("/api/chat").send(chat({ mode: "code" })),
    "Code & Build",
  );
  await refused(
    a.post("/api/conversations").send({ mode: "code" }),
    "Code & Build",
  );
  await refused(
    a.post("/api/chat").send(chat({ web_search: true })),
    "Live Web Search",
  );
  await refused(
    a.post("/api/chat").send(chat({ plugins: [{ id: "web" }] })),
    "Live Web Search",
  );
  await refused(a.post("/api/images").send({ prompt: "x" }), "Image Studio");
  await refused(a.get("/api/audio/models"), "Voice & Audio");
  await refused(a.post("/api/audio/speech").send({}), "Voice & Audio");
  await refused(a.get("/api/videos"), "Video Studio");
  await refused(a.post("/api/videos").send({}), "Video Studio");
  await refused(a.get("/api/collabs"), "Collab");
  await refused(a.post("/api/collabs/join").send({}), "Collab");
  await refused(a.post("/api/keys").send({ name: "k" }), "Developer API & CLI");
  await refused(request(svc.app).get("/v1/models"), "Developer API & CLI");
  await refused(
    request(svc.app).post("/v1/chat/completions").send(chat()),
    "Developer API & CLI",
  );
  await refused(request(svc.app).get("/install.sh"), "Developer API & CLI");
  await refused(a.get("/api/referrals"), "Referrals & Credits");
  await refused(a.post("/api/credits/send").send({}), "Referrals & Credits");

  // What the MVP keeps: plain chat, conversations, keys list, credits, account.
  const r = await a.post("/api/chat").send(chat()).expect(200);
  assert.match(r.text, /"credits_charged"/);
  await a.post("/api/conversations").send({ title: "Hi" }).expect(201);
  await a.get("/api/keys").expect(200);
  await a.get("/api/deposits").expect(200);
  await a.get("/api/account/ledger").expect(200);
});

test("the MVP offers only its chat models", async (t) => {
  const svc = fixture(t, "mvp");
  const a = await signedIn(svc);
  const list = (await a.get("/api/models").expect(200)).body.data;
  assert.deepEqual(
    list.map((m) => m.id),
    [MVP_MODEL],
  );
  assert.equal(list[0].callable, true);
  assert.equal(list[0].apiCallable, false);
  const metadata = (await a.get("/api/models")).body;
  assert.equal(metadata.availabilityScope, "web-workspace");
  assert.equal(metadata.developerApiReleased, false);
  const other = (
    await a
      .post("/api/chat")
      .send(chat({ model: "openai/gpt-4o-mini" }))
      .expect(503)
  ).body;
  assert.equal(other.error.code, "model_unavailable");
});

test("releasing an update opens exactly that update", async (t) => {
  const svc = fixture(t, "mvp,code,catalog");
  const a = await signedIn(svc);
  const r = await a
    .post("/api/chat")
    .send(chat({ mode: "code" }))
    .expect(200);
  assert.match(r.text, /"credits_charged"/);
  await refused(
    a.post("/api/chat").send(chat({ web_search: true })),
    "Live Web Search",
  );
  const list = (await a.get("/api/models").expect(200)).body.data;
  assert.ok(list.filter((m) => m.type === "chat").length > 1);
  assert.ok(!list.some((m) => m.type === "video"));
  const info = (await request(svc.app).get("/api/config").expect(200)).body
    .releases;
  assert.equal(info.all, false);
  assert.equal(info.features.code, true);
  assert.equal(info.features.search, false);
  assert.deepEqual(
    info.updates.map((u) => [u.number, u.id, u.released]).slice(0, 4),
    [
      [1, "code", true],
      [2, "search", false],
      [3, "images", false],
      [4, "catalog", true],
    ],
  );
});

test("missing release configuration keeps unreleased features closed", async (t) => {
  const svc = fixture(t, undefined);
  const info = (await request(svc.app).get("/api/config").expect(200)).body
    .releases;
  assert.equal(info.all, false);
  assert.ok(Object.values(info.features).every((v) => v === false));
  const a = await signedIn(svc);
  await a.get("/api/collabs").expect(403);
  // Refused before the API's own key check instead of the release gate.
  await request(svc.app).get("/v1/models").expect(403);
});

test("release settings are validated", () => {
  assert.equal(parseReleased("all"), "all");
  for (const value of [undefined, null, "", " , "])
    assert.deepEqual([...parseReleased(value)], []);
  assert.throws(() => parseReleased("all,typo"), /Unknown RELEASED_FEATURES/);
  assert.deepEqual([...parseReleased("mvp")], []);
  assert.deepEqual(
    [...parseReleased(" MVP, Code ,search")],
    ["code", "search"],
  );
  assert.throws(
    () => parseReleased("mvp,vidoe"),
    /Unknown RELEASED_FEATURES: vidoe/,
  );
  assert.deepEqual([...config({ released: undefined }).released], []);
  assert.equal(config({}).mvpModels.length, 10);
  // The launch updates stay first and in order; later updates append.
  assert.deepEqual(
    UPDATES.slice(0, 9).map((u) => u.id),
    [
      "code",
      "search",
      "images",
      "catalog",
      "audio",
      "video",
      "collab",
      "api",
      "social",
    ],
  );
  assert.equal(new Set(UPDATES.map((u) => u.id)).size, UPDATES.length);
  for (const u of UPDATES) assert.equal(u.points.length, 3);
});

test("public discovery and the served contract withhold unreleased developer operations", async (t) => {
  const svc = fixture(t, "mvp");
  const client = request(svc.app);
  const short = (await client.get("/llms.txt").expect(200)).text;
  const full = (await client.get("/llms-full.txt").expect(200)).text;
  const spec = (await client.get("/api/openapi.json").expect(200)).body;
  assert.match(short, /Developer API & CLI: Coming soon/);
  assert.doesNotMatch(short, /API: \/v1/);
  assert.match(full, /403 feature_unreleased/);
  assert.doesNotMatch(
    full,
    /POST \/v1\/chat\/completions|POST \/api\/keys|GET \/install.sh/,
  );
  assert.equal(spec["x-anonyma-releases"].features.api, false);
  assert.equal(spec.paths["/v1/chat/completions"], undefined);
  assert.equal(spec.paths["/api/keys"].post, undefined);
  assert.ok(
    spec.paths["/api/keys"].get,
    "existing key management remains documented",
  );
  assert.equal(spec.paths["/api/audio/models"], undefined);
});

test("enabled developer docs match authenticated models, balances, completions and duplicate behavior", async (t) => {
  const svc = fixture(t, "mvp,api");
  const client = request(svc.app);
  const spec = (await client.get("/api/openapi.json").expect(200)).body;
  assert.equal(spec["x-anonyma-releases"].features.api, true);
  assert.ok(spec.paths["/v1/chat/completions"].post);
  assert.equal(spec.paths["/api/audio/models"], undefined);
  assert.match(
    (await client.get("/llms.txt")).text,
    /Developer API & CLI: enabled/,
  );
  assert.match(
    (await client.get("/llms-full.txt")).text,
    /POST \/v1\/chat\/completions/,
  );
  await client.get("/v1/models").expect(401);
  const connection = (
    await client.get("/v1").set("User-Agent", "integration-client")
  ).body;
  assert.equal(connection.authenticated, false);
  assert.equal(connection.credits_charged, 0);
  const account = await signedIn(svc);
  const key = (
    await account.post("/api/keys").send({ name: "docs-test" }).expect(201)
  ).body;
  const auth = `Bearer ${key.key}`;
  const models = (
    await client.get("/v1/models").set("Authorization", auth).expect(200)
  ).body;
  assert.equal(models.object, "list");
  assert.ok(models.data.some((m) => m.id === MVP_MODEL));
  const before = (
    await client.get("/v1/balance").set("Authorization", auth).expect(200)
  ).body;
  const completion = (
    await client
      .post("/v1/chat/completions")
      .set("Authorization", auth)
      .set("Idempotency-Key", "docs-request")
      .send(chat())
      .expect(200)
  ).body;
  assert.equal(completion.object, "chat.completion");
  assert.equal(completion.anonyma.request_id, "docs-request");
  assert.equal(typeof completion.anonyma.credits_charged, "number");
  const duplicate = await client
    .post("/v1/chat/completions")
    .set("Authorization", auth)
    .set("Idempotency-Key", "docs-request")
    .send(chat())
    .expect(409);
  assert.equal(duplicate.body.error.code, "duplicate_request");
  const after = (await client.get("/v1/balance").set("Authorization", auth))
    .body;
  assert.ok(
    Math.abs(
      before.balance - after.balance - completion.anonyma.credits_charged,
    ) < 0.00001,
  );
  const stream = await client
    .post("/v1/chat/completions")
    .set("Authorization", auth)
    .set("Idempotency-Key", "docs-stream")
    .send(chat({ stream: true }))
    .expect(200);
  assert.match(stream.headers["content-type"], /text\/event-stream/);
  assert.match(stream.text, /"choices":\[\],"usage":/);
  assert.match(stream.text, /data: \[DONE\]/);
});

test("catalog API availability is limited to callable chat models after API release", async (t) => {
  const svc = fixture(t, "all");
  const catalog = (await request(svc.app).get("/api/models").expect(200)).body;
  assert.equal(catalog.developerApiReleased, true);
  assert.ok(catalog.data.some((m) => m.type === "chat" && m.callable));
  assert.ok(
    catalog.data.some((m) => m.type !== "chat"),
    "non-chat entries exercise the distinction",
  );
  for (const model of catalog.data) {
    assert.equal(
      model.apiCallable,
      model.type === "chat" && model.callable,
      model.id,
    );
  }
});

test("direct helpers fail closed on absent config and the browser requires explicit true", async () => {
  assert.equal(isReleased({}, "api"), false);
  assert.equal(releaseInfo({}).all, false);
  const { isReleased: browserReleased } = await import("../src/lib.js");
  for (const config of [
    undefined,
    {},
    { releases: {} },
    { releases: { features: { api: "true" } } },
  ])
    assert.equal(browserReleased(config, "api"), false);
  assert.equal(
    browserReleased({ releases: { features: { api: true } } }, "api"),
    true,
  );
});
