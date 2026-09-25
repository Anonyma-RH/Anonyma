import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createApp } from "../server/app.js";
import { addCredit } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import { openapi } from "../server/openapi.js";
import { STORAGE, TRAIL_FIELDS } from "../server/privacy-trail.js";
import { readTrail, trailRows, veilLabel, STORAGE_LABELS, ROUTE_LABELS, RETENTION_LABELS } from "../src/privacy-trail.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// The reference snapshot carries no zero-data-retention labels, so one model
// counts as private through the operator override (as in private-mode tests).
const privateModel = "venice/venice-uncensored-1-2";
const publicModel = "google/gemini-2.5-flash";
const contributor = "meta/muse-spark-1.3-contributor";
const standard = "meta/muse-spark-1.3";
const chat = (model, content = "Privacy trail test", extra = {}) => ({
  model,
  messages: [{ role: "user", content }],
  max_tokens: 50,
  ...extra,
});

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-trail-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: released ?? "all",
    privateModels: [privateModel],
    mvpModels: [privateModel, publicModel, contributor, standard],
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
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
async function keyFor(agent) {
  return (await agent.post("/api/keys").send({ name: "trail", cap: null }).expect(201)).body.key;
}
const events = (text) =>
  text
    .split("\n\n")
    .map((l) => l.replace(/^data: /, "").trim())
    .filter((l) => l && l !== "[DONE]")
    .map((l) => JSON.parse(l));
// The final chat event's anonyma extension.
const finalExtension = (text) => events(text).findLast((e) => e.anonyma)?.anonyma;
async function send(agent, body) {
  const r = await agent.post("/api/chat").send(body).expect(200);
  return { text: r.text, anonyma: finalExtension(r.text), conversationId: events(r.text).findLast((e) => e.conversationId)?.conversationId };
}
const savedReply = (db, conversation) =>
  JSON.parse(
    db
      .prepare("SELECT content FROM messages WHERE conversation_id=? AND role='assistant' ORDER BY created DESC,rowid DESC")
      .get(conversation).content,
  );
const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));

test("the update is registered as off by default, with its icon and Chinese copy", () => {
  const entry = UPDATES.find((u) => u.id === "trail");
  assert.ok(entry, "trail is registered in UPDATES");
  assert.equal(committed[UPDATES.indexOf(entry)], false, "not released yet");
  assert.equal(entry.title, "Privacy Trail");
  assert.equal(entry.tagline, "See where every prompt went.");
  assert.equal(entry.points.length, 3);
  for (const line of [entry.title, entry.tagline, ...entry.points])
    assert.ok(zh.strings[line], `zh: ${line}`);
  const pages = readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8");
  assert.match(pages, /\btrail: "route"/, "featureIcons entry");
  assert.match(readFileSync(new URL("../src/ui.jsx", import.meta.url), "utf8"), /\broute: Route\b/);
});

test("a ZDR model in Private Mode and a non-ZDR model get their own facts", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const priv = await send(agent, chat(privateModel, "Private trail", { private: true, veil_masked: 2, requestId: "req-private" }));
  assert.deepEqual(priv.anonyma.privacy, {
    model: privateModel,
    provider: "Venice",
    route: "primary",
    retention: "zero_data_retention",
    trains_on_prompts: false,
    storage: "private",
    veil_masked: 2,
    receipt_id: "req-private",
  });
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0, "Private Mode saves nothing");

  const normal = await send(agent, chat(publicModel, "Normal trail", { veil_masked: null, requestId: "req-public" }));
  assert.deepEqual(normal.anonyma.privacy, {
    model: publicModel,
    provider: "Google",
    route: "primary",
    retention: "provider_may_retain",
    trains_on_prompts: false,
    storage: "saved",
    veil_masked: null,
    receipt_id: "req-public",
  });
  // ZDR is opt-in per request: a ZDR-capable model sent without Private
  // Mode isn't claimed as zero data retention.
  const unrouted = await send(agent, chat(privateModel, "Not private"));
  assert.equal(unrouted.anonyma.privacy.retention, "provider_may_retain");
  assert.equal(unrouted.anonyma.privacy.storage, "saved");
  assert.ok(!("veil_masked" in unrouted.anonyma.privacy), "nothing reported, nothing claimed");
  // No receipt row without Signed Receipts.
  const unsigned = fixture(t, "mvp,trail");
  const u = await register(unsigned.app);
  assert.equal((await send(u.agent, chat(publicModel))).anonyma.privacy.receipt_id, null);
});

test("a flagged Contributor model says it trains on prompts; its Standard twin doesn't", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  assert.equal((await send(agent, chat(contributor))).anonyma.privacy.trains_on_prompts, true);
  assert.equal((await send(agent, chat(standard))).anonyma.privacy.trains_on_prompts, false);
  // Before Training Labels is released, the trail says nothing about it.
  const early = fixture(t, "mvp,trail");
  const e = await register(early.app);
  assert.ok(!("trains_on_prompts" in (await send(e.agent, chat(contributor))).anonyma.privacy));
});

test("off the record stores nothing; a saved reply keeps its trail for reloads", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const off = await send(agent, chat(publicModel, "Off the record", { ephemeral: true, veil_masked: 1 }));
  assert.equal(off.anonyma.privacy.storage, "off_the_record");
  assert.equal(off.anonyma.privacy.veil_masked, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);

  const saved = await send(agent, chat(publicModel, "Keep this one", { veil_masked: 3 }));
  assert.equal(saved.anonyma.privacy.storage, "saved");
  // Stored with the reply, exactly as streamed, and returned on reload.
  assert.deepEqual(savedReply(s.db, saved.conversationId).privacy, saved.anonyma.privacy);
  const reopened = (await agent.get("/api/conversations/" + saved.conversationId).expect(200)).body;
  const reply = reopened.messages.find((m) => m.role === "assistant");
  assert.deepEqual(reply.content.privacy, saved.anonyma.privacy);
  // The user's own message carries no trail.
  assert.doesNotMatch(JSON.stringify(reopened.messages.find((m) => m.role === "user").content), /privacy|veil_masked/);

  // The panel reads the same object the same way, whichever way it arrived.
  const offRows = trailRows(readTrail(off.anonyma.privacy));
  const savedRows = trailRows(readTrail(reply.content.privacy), { receiptsLive: true });
  assert.equal(offRows.find((r) => r.key === "storage").value, "Off the record (not saved)");
  assert.equal(savedRows.find((r) => r.key === "storage").value, "Saved to your history");
  assert.equal(savedRows.find((r) => r.key === "veil").value, "3 details masked");
  assert.equal(savedRows.find((r) => r.key === "receipt").receiptId, saved.anonyma.request_id);
});

test("the backup gateway's route is reported, on /v1 and in the workspace", async (t) => {
  // The same fixtures as the failover test in api.test.mjs.
  let primaryMode = "unfunded";
  const primary = await new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      for await (const _ of req);
      if (primaryMode === "ok") {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "from primary" } }] }) + "\n\n");
        res.write("data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0002 } }) + "\n\n");
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "primary says no" } }));
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  const backup = await new Promise((resolve) => {
    const srv = createServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/models") {
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ data: [{ id: publicModel }] }));
      }
      for await (const _ of req);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: " + JSON.stringify({ choices: [{ delta: { content: "from backup" } }] }) + "\n\n");
      res.write("data: " + JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 5, cost: 0.0002 } }) + "\n\n");
      res.end("data: [DONE]\n\n");
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
  t.after(() => Promise.all([primary, backup].map((srv) => new Promise((r) => srv.close(r)))));
  const url = (srv) => "http://127.0.0.1:" + srv.address().port;
  const s = fixture(t, undefined, {
    testMode: false,
    gateway: url(primary),
    gatewayKey: "fixture",
    gateway2: url(backup),
    gateway2Key: "backup-key",
    gateway2FeePercent: 0,
  });
  const { agent, user } = await register(s.app);
  addCredit(s.db, user.id, 100000000, "trail-fund", "test_credit");
  const key = await keyFor(agent);
  t.mock.method(console, "error", () => {});
  const v1 = () =>
    request(s.app).post("/v1/chat/completions").set("Authorization", "Bearer " + key).send(chat(publicModel));

  const served = (await v1().expect(200)).body;
  assert.equal(served.choices[0].message.content, "from backup");
  assert.equal(served.anonyma.privacy.route, "backup");
  assert.equal(served.anonyma.privacy.provider, "Google");

  const workspace = await send(agent, chat(publicModel, "Backup trail", { veil_masked: null }));
  assert.equal(workspace.anonyma.privacy.route, "backup");
  assert.equal(savedReply(s.db, workspace.conversationId).privacy.route, "backup");
  assert.equal(trailRows(readTrail(workspace.anonyma.privacy)).find((r) => r.key === "route").value, "Backup gateway");

  primaryMode = "ok";
  const direct = (await v1().expect(200)).body;
  assert.equal(direct.choices[0].message.content, "from primary");
  assert.equal(direct.anonyma.privacy.route, "primary");
});

test("/v1 and MCP ask carry the same anonyma.privacy object, documented in the OpenAPI", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const key = await keyFor(agent);
  const json = (
    await request(s.app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer " + key)
      .send({ ...chat(publicModel), requestId: "api-trail", veil_masked: 4 })
      .expect(200)
  ).body;
  assert.deepEqual(json.anonyma.privacy, {
    model: publicModel,
    provider: "Google",
    route: "primary",
    retention: "provider_may_retain",
    trains_on_prompts: false,
    storage: "not_saved",
    receipt_id: "api-trail",
  });
  assert.deepEqual(Object.keys(json.anonyma.privacy).filter((k) => !TRAIL_FIELDS.includes(k)), []);
  // Streaming /v1: the final event carries it too.
  const streamed = await request(s.app)
    .post("/v1/chat/completions")
    .set("Authorization", "Bearer " + key)
    .send({ ...chat(publicModel), stream: true })
    .expect(200);
  assert.equal(finalExtension(streamed.text).privacy.storage, "not_saved");

  const mcp = (
    await request(s.app)
      .post("/mcp")
      .set("Authorization", "Bearer " + key)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { model: publicModel, prompt: "MCP trail" } } })
      .expect(200)
  ).body.result.structuredContent;
  assert.equal(mcp.privacy.storage, "not_saved");
  assert.equal(mcp.privacy.receipt_id, mcp.request_id);

  const schema = openapi.components.schemas;
  assert.equal(schema.ChatCompletion.properties.anonyma.properties.privacy.$ref, "#/components/schemas/PrivacyTrail");
  assert.deepEqual(Object.keys(schema.PrivacyTrail.properties), TRAIL_FIELDS);
  assert.deepEqual(schema.PrivacyTrail.properties.storage.enum, STORAGE);
  assert.deepEqual(schema.ChatRequest.properties.veil_masked.type, ["integer", "null"]);
  assert.equal(schema.ApiChatRequest.properties.veil_masked, undefined, "the API reports no Veil count");
});

test("no prompt text lands in the trail or any new column", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const scan = (marker) => {
    const hits = [];
    for (const { name } of s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
      for (const { name: column } of s.db.prepare(`PRAGMA table_info(${name})`).all())
        if (s.db.prepare(`SELECT COUNT(*) n FROM ${name} WHERE CAST(${column} AS TEXT) LIKE ?`).get(`%${marker}%`).n)
          hits.push(`${name}.${column}`);
    return hits.sort();
  };
  // Privacy Trail adds no column anywhere.
  for (const { name } of s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
    for (const { name: column } of s.db.prepare(`PRAGMA table_info(${name})`).all())
      assert.doesNotMatch(column, /privacy|trail|veil/i, `${name}.${column}`);

  const off = await send(agent, chat(publicModel, "ZEBRA-OFF secret words", { ephemeral: true, veil_masked: 0 }));
  const priv = await send(agent, chat(privateModel, "ZEBRA-PRIVATE secret words", { private: true, veil_masked: 0 }));
  assert.deepEqual(scan("ZEBRA-OFF"), [], "off the record stores nothing");
  assert.deepEqual(scan("ZEBRA-PRIVATE"), [], "Private Mode stores nothing");

  const saved = await send(agent, chat(publicModel, "ZEBRA-SAVED secret words", { veil_masked: 1 }));
  // Only the conversation's own, pre-existing places hold the prompt (the
  // test provider's answer echoes it, which is the answer, not the trail).
  assert.deepEqual(scan("ZEBRA-SAVED"), ["conversations.title", "messages.content"]);
  for (const trail of [off.anonyma.privacy, priv.anonyma.privacy, saved.anonyma.privacy, savedReply(s.db, saved.conversationId).privacy]) {
    assert.doesNotMatch(JSON.stringify(trail), /ZEBRA|secret/);
    assert.deepEqual(Object.keys(trail).filter((k) => !TRAIL_FIELDS.includes(k)), []);
    for (const [k, v] of Object.entries(trail))
      assert.ok(v === null || typeof v === "boolean" || typeof v === "number" || (typeof v === "string" && v.length <= 200), k);
  }
  // A malformed count is refused before anything is reserved.
  const bad = await agent.post("/api/chat").send(chat(publicModel, "x", { veil_masked: "three" })).expect(400);
  assert.equal(bad.body.error.code, "invalid_request");
});

test("the trail stays off until Privacy Trail is released", async (t) => {
  const s = fixture(t, "mvp,api,mcp,receipts,ephemeral,private,training");
  const { agent } = await register(s.app);
  const saved = await send(agent, chat(publicModel));
  assert.equal(saved.anonyma.privacy, undefined);
  assert.equal(savedReply(s.db, saved.conversationId).privacy, undefined);
  assert.equal((await send(agent, chat(privateModel, "p", { private: true }))).anonyma.privacy, undefined);
  const key = await keyFor(agent);
  const v1 = (await request(s.app).post("/v1/chat/completions").set("Authorization", "Bearer " + key).send(chat(publicModel)).expect(200)).body;
  assert.equal(v1.anonyma.privacy, undefined);
  const mcp = (
    await request(s.app)
      .post("/mcp")
      .set("Authorization", "Bearer " + key)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { model: publicModel, prompt: "gated" } } })
      .expect(200)
  ).body.result.structuredContent;
  assert.equal(mcp.privacy, undefined);
  // The workspace's Veil count is refused rather than kept.
  const refused = await agent.post("/api/chat").send(chat(publicModel, "x", { veil_masked: 1 })).expect(403);
  assert.equal(refused.body.error.code, "feature_unreleased");
  assert.equal(refused.body.error.message, "Privacy Trail is coming soon.");
  const config = (await agent.get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.trail, false);
  assert.equal(config.releases.updates.find((u) => u.id === "trail").released, false);
});

test("the panel shows only what the object says, in whole translatable phrases", () => {
  assert.equal(readTrail(null), null);
  assert.equal(readTrail({ model: "m", route: "sideways", retention: "zero_data_retention", storage: "saved" }), null);
  assert.equal(veilLabel(undefined), null, "not reported: no Veil row");
  assert.equal(veilLabel(null), "Off");
  assert.equal(veilLabel(0), "On · nothing found to mask");
  assert.equal(veilLabel(1), "1 detail masked");
  const zdrModel = { model: "x", provider: null, route: "primary", retention: "provider_may_retain", storage: "saved", receipt_id: null };
  const rows = trailRows(readTrail(zdrModel), { privateModel: true });
  assert.deepEqual(rows.map((r) => r.key), ["model", "route", "retention", "storage"], "no Veil or receipt row without facts");
  assert.equal(rows.find((r) => r.key === "retention").note, "Zero data retention applies only in Private Mode.");
  assert.equal(trailRows(readTrail(zdrModel), { receiptsLive: true }).at(-1).value, "Not signed");
  // Every phrase the panel can show has a Chinese entry (counts via the
  // existing "{0} detail(s) masked" patterns).
  const component = readFileSync(new URL("../src/PrivacyTrail.jsx", import.meta.url), "utf8");
  for (const phrase of [
    ...Object.values(ROUTE_LABELS),
    ...Object.values(RETENTION_LABELS),
    ...Object.values(STORAGE_LABELS),
    "Privacy", "Where this prompt went", "Model", "Route", "Retention", "Storage", "Receipt",
    "Off", "On · nothing found to mask", "Signed", "Not signed", "Verify", "Provider not listed",
    "Trains on prompts", "Zero data retention applies only in Private Mode.",
    "Couldn't load the signed receipt.",
    "The provider says it uses what you send to this model to improve its products.",
  ])
    assert.ok(zh.strings[phrase], `zh: ${phrase}`);
  for (const en of ["{0} detail masked", "{0} details masked"])
    assert.ok(zh.patterns.some((p) => p.en === en), en);
  // Model names, providers and receipt ids are never translated.
  assert.equal((component.match(/data-i18n="off"/g) || []).length, 3);
});
