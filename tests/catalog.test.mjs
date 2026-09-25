import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncCatalog } from "../server/catalog.js";

test("catalog joins chat and dedicated media feeds atomically and preserves cache on partial failure", async (t) => {
  let mediaFails = false;
  const server = createServer((req, res) => {
    const media = req.url.includes("type=image,video");
    res.writeHead(media && mediaFails ? 503 : 200, {
      "Content-Type": "application/json",
    });
    res.end(
      JSON.stringify({
        data: [
          {
            id: media ? "live-video" : "live-chat",
            type: media ? "video" : "chat",
            pricing: { base_price: 0.4 },
          },
        ],
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const dir = mkdtempSync(join(tmpdir(), "anonyma-feeds-"));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, { recursive: true });
  });
  const cfg = {
    gateway: `http://127.0.0.1:${server.address().port}`,
    catalogPath: join(dir, "catalog.json"),
  };
  const snapshot = await syncCatalog(cfg, {
    data: [{ id: "old", type: "video", status: "live" }],
  });
  assert.equal(snapshot.data.find((m) => m.id === "live-video").status, "live");
  assert.equal(snapshot.data.find((m) => m.id === "live-chat").status, "live");
  assert.equal(snapshot.data.find((m) => m.id === "old").status, "unavailable");
  const before = readFileSync(cfg.catalogPath, "utf8");
  mediaFails = true;
  await assert.rejects(syncCatalog(cfg, snapshot), /503/);
  assert.equal(readFileSync(cfg.catalogPath, "utf8"), before);
});
test("retired snapshot models are named entries, and damaged caches are repaired", async (t) => {
  const { catalog } = await import("../server/core.js");
  const { loadCatalog } = await import("../server/catalog.js");
  const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const bundled = catalog().data;
  assert.ok(
    bundled.every(
      (m) => typeof m.id === "string" && typeof m.name === "string",
    ),
  );
  const retired = bundled.find((m) => m.id === "ai21/jamba-large-1.7");
  assert.equal(retired.status, "unavailable");

  // A cache written by the old code: retired IDs spread into character maps.
  const dir = mkdtempSync(join(tmpdir(), "anonyma-catalog-repair-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "models.json");
  writeFileSync(
    path,
    JSON.stringify({
      updatedAt: "2026-09-21T00:00:00.000Z",
      data: [
        { id: "live/model", name: "Live model", status: "live" },
        { ...[..."ai21/jamba-large-1.7"], status: "unavailable" },
      ],
    }),
  );
  const repaired = loadCatalog(path).data;
  assert.ok(
    repaired.every(
      (m) => typeof m.id === "string" && typeof m.name === "string",
    ),
  );
  assert.equal(
    repaired.filter((m) => m.id === "ai21/jamba-large-1.7").length,
    1,
  );
  assert.ok(repaired.some((m) => m.id === "live/model"));
});


test("chat availability rejects unsupported audio/video output without banning free text models", async (t) => {
  const { writeFileSync } = await import("node:fs");
  const { default: request } = await import("supertest");
  const { createApp } = await import("../server/app.js");
  const { callable } = await import("../server/core.js");
  const { pickPreset } = await import("../src/model-finder.js");
  const dir = mkdtempSync(join(tmpdir(), "anonyma-chat-contract-"));
  const base = {
    type: "chat", status: "live", context_length: 32768,
    architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "audio"] },
    pricing: { input_per_1M_tokens: 0, output_per_1M_tokens: 0 },
  };
  const unsupported = ["google/lyria-3-clip-preview", "google/lyria-3-pro-preview", "openai/gpt-audio", "openai/gpt-audio-mini"]
    .map((id) => ({ ...base, id, name: id }));
  unsupported.push({ ...base, id: "fixture/video-chat", name: "Video chat", architecture: { output_modalities: ["text", "video"] } });
  const free = { ...base, id: "fixture/free-text", name: "Free text", architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] } };
  const paid = { ...free, id: "fixture/paid-text", name: "Paid text", pricing: { input_per_1M_tokens: 1, output_per_1M_tokens: 2 } };
  const catalogPath = join(dir, "models.json");
  writeFileSync(catalogPath, JSON.stringify({ updatedAt: new Date().toISOString(), data: [...unsupported, free, paid] }));
  const s = createApp({ testMode: true, released: "all", catalogPath, syncModels: false, dbPath: join(dir, "db.sqlite"), mediaPath: join(dir, "media") });
  t.after(() => { s.close(); rmSync(dir, { recursive: true, force: true }); });
  for (const m of unsupported) {
    assert.equal(callable(m, s.cfg), false, m.id);
    assert.equal(callable({ ...m, pricing: paid.pricing }, { ...s.cfg, testMode: false, gatewayKey: "fixture" }), false, "positive token rates do not establish an audio contract");
  }
  assert.equal(callable(free, s.cfg), true, "published zero rates alone are legitimate");
  const catalog = (await request(s.app).get("/api/models").expect(200)).body.data;
  for (const m of unsupported) {
    const publicModel = catalog.find((v) => v.id === m.id);
    assert.equal(publicModel.callable, false);
    assert.equal(publicModel.apiCallable, false);
    assert.equal(publicModel.type, "chat", "retain upstream metadata without unverified route remapping");
  }
  const eligible = catalog.filter((m) => m.type === "chat" && m.callable);
  assert.equal(pickPreset(eligible, "cheap", { mode: "chat" }).id, free.id);
  assert.equal(pickPreset(eligible.filter((m) => m.id !== free.id), "cheap", { mode: "chat" }).id, paid.id);
  const agent = request.agent(s.app);
  await agent.post("/api/auth/register").send({ username: "contractreview", password: "fixture-password-long" }).expect(201);
  const key = (await agent.post("/api/keys").send({ name: "contract regression" }).expect(201)).body.key;
  const apiModels = (await request(s.app).get("/v1/models").set("Authorization", "Bearer " + key).expect(200)).body.data;
  assert.ok(apiModels.some((m) => m.id === free.id));
  const before = s.db.prepare("SELECT COUNT(*) n FROM holds").get().n;
  for (const m of unsupported) {
    const body = { model: m.id, messages: [{ role: "user", content: "Hello" }] };
    for (const route of ["/api/quote", "/api/chat"])
      assert.equal((await agent.post(route).send(body).expect(503)).body.error.code, "model_unavailable");
    assert.ok(!apiModels.some((row) => row.id === m.id));
    assert.equal((await request(s.app).post("/v1/chat/completions").set("Authorization", "Bearer " + key).send(body).expect(503)).body.error.code, "model_unavailable");
  }
  const quote = await agent.post("/api/quote").send({ model: free.id, messages: [{ role: "user", content: "Hello" }] }).expect(200);
  assert.equal(quote.body.credits, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, before);
});
