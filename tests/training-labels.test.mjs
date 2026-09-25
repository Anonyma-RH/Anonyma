import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { UPDATES } from "../server/releases.js";
import { trainingLabel } from "../server/training.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const snapshot = JSON.parse(
  readFileSync(new URL("../data/models.snapshot.json", import.meta.url), "utf8"),
);
const CONTRIBUTORS = {
  "meta/muse-spark-1.3-contributor": "meta/muse-spark-1.3",
  "meta/muse-spark-1.2-contributor": "meta/muse-spark-1.2",
};
const STANDARD = [
  "meta/muse-spark-1.3",
  "meta/muse-spark-1.2",
  "meta/muse-spark-1.1",
  "meta/muse-glimmer-30b",
];

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-training-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: released ?? "all",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function signedIn(app) {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .send({ username: "tester", password: "test-password-long" })
    .expect(201);
  const key = (
    await agent.post("/api/keys").send({ name: "training", cap: null }).expect(201)
  ).body.key;
  return { agent, key };
}
async function listings(svc) {
  const { agent, key } = await signedIn(svc.app);
  const site = (await agent.get("/api/models").expect(200)).body.data;
  const api = (
    await request(svc.app)
      .get("/v1/models")
      .set("Authorization", "Bearer " + key)
      .expect(200)
  ).body.data;
  return { site, api };
}
const byId = (list, id) => list.find((m) => m.id === id);

test("the update is registered as off by default", () => {
  const entry = UPDATES.find((u) => u.id === "training");
  assert.ok(entry, "training is registered in UPDATES");
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "Training Labels");
  assert.equal(entry.tagline, "Know when a provider learns from your prompts.");
  assert.deepEqual(entry.points, [
    "A clear label on models whose provider trains on what you send",
    "One tap to the version that doesn't",
    "Flagged in the API too",
  ]);
});

test("the rule flags Meta's contributor tier only, with its standard twin", () => {
  const ids = new Set(snapshot.data.map((m) => m.id));
  const flagged = snapshot.data.filter((m) => trainingLabel(m, ids));
  assert.deepEqual(
    flagged.map((m) => m.id).sort(),
    Object.keys(CONTRIBUTORS).sort(),
    "the contributor ids are the only flagged models in the catalog",
  );
  for (const [id, alternative] of Object.entries(CONTRIBUTORS))
    assert.deepEqual(trainingLabel(byId(snapshot.data, id), ids), {
      provider: "Meta",
      alternative,
    });
  for (const id of STANDARD)
    assert.equal(trainingLabel(byId(snapshot.data, id), ids), null, id);
  // Meta by owner or by id prefix; a -contributor id elsewhere isn't Meta's tier.
  const all = new Set(["x/model"]);
  assert.ok(trainingLabel({ id: "muse-x-contributor", owned_by: "Meta" }, all));
  assert.ok(trainingLabel({ id: "meta/muse-x-contributor" }, all));
  assert.equal(trainingLabel({ id: "acme/model-contributor", owned_by: "Acme" }, all), null);
  assert.equal(trainingLabel({ id: "meta/muse-x" }, all), null);
});

test("the models APIs carry no training fields while the update is unreleased", async (t) => {
  const svc = fixture(t, "mvp,catalog,api,private,ephemeral");
  const { site, api } = await listings(svc);
  assert.ok(byId(site, "meta/muse-spark-1.3-contributor"), "the model is listed");
  assert.ok(byId(api, "meta/muse-spark-1.3-contributor"), "the model is callable");
  for (const m of site) {
    assert.equal(m.trainsOnPrompts, undefined, m.id);
    assert.equal(m.untrainedAlternative, undefined, m.id);
  }
  for (const m of api) {
    assert.equal(m.trains_on_prompts, undefined, m.id);
    assert.equal(m.untrained_alternative, undefined, m.id);
  }
});

test("once released, both models APIs flag the contributor tier and name the alternative", async (t) => {
  const svc = fixture(t, "mvp,catalog,api,private,ephemeral,training");
  const { site, api } = await listings(svc);
  for (const [id, alternative] of Object.entries(CONTRIBUTORS)) {
    const m = byId(site, id);
    assert.equal(m.trainsOnPrompts, true, id);
    assert.equal(m.untrainedAlternative, alternative, id);
    // Private mode lists private models only; flagged models never are.
    assert.equal(m.private, undefined, id);
    assert.deepEqual(byId(api, id), {
      id,
      object: "model",
      owned_by: "Meta",
      created: 0,
      trains_on_prompts: true,
      untrained_alternative: alternative,
    });
  }
  assert.deepEqual(
    site.filter((m) => m.trainsOnPrompts).map((m) => m.id).sort(),
    Object.keys(CONTRIBUTORS).sort(),
  );
  assert.deepEqual(
    api.filter((m) => m.trains_on_prompts).map((m) => m.id).sort(),
    Object.keys(CONTRIBUTORS).sort(),
  );
  for (const id of STANDARD) {
    assert.equal(byId(site, id).trainsOnPrompts, undefined, id);
    assert.equal(byId(api, id).trains_on_prompts, undefined, id);
  }
});

test("a contributor model without a standard twin is flagged with no alternative", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-training-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "models.json");
  writeFileSync(
    catalogPath,
    JSON.stringify({
      ...snapshot,
      data: snapshot.data.filter((m) => m.id !== "meta/muse-spark-1.3"),
    }),
  );
  const svc = fixture(t, "all", { catalogPath });
  const { site, api } = await listings(svc);
  const lone = "meta/muse-spark-1.3-contributor";
  assert.equal(byId(site, lone).trainsOnPrompts, true);
  assert.ok(!("untrainedAlternative" in byId(site, lone)));
  assert.equal(byId(api, lone).trains_on_prompts, true);
  assert.ok(!("untrained_alternative" in byId(api, lone)));
  // Its sibling still has its twin.
  assert.equal(
    byId(site, "meta/muse-spark-1.2-contributor").untrainedAlternative,
    "meta/muse-spark-1.2",
  );
});
