import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { addCredit } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import {
  CACHE_MS,
  DEGRADED_AT,
  DOWN_AT,
  MAX_EVENTS,
  MIN_SAMPLES,
  STATUS_WINDOW_MS,
  TIMING_WINDOW_MS,
  createModelStatus,
  displayName,
  outcomeOf,
  percentile,
  statusFrom,
  summarize,
} from "../server/model-status.js";
import { knownPage, sitemap } from "../src/site-routes.js";
import {
  STATUS_LABEL,
  familyCounts,
  seconds,
  statusByModel,
  statusHint,
  statusReleased,
} from "../src/model-status.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const IMAGE_MODEL = "google/gemini-2.5-flash-image";
const VIDEO_MODEL = "kling-2.5-turbo";
const MINUTE = 60 * 1000;

// A service whose Model Status clock runs `clock.offset` ms ahead of real
// time, so a test can move past the 30-second cache or out of a window.
function fixture(t, { released, dir: given, keep = false, ...extra } = {}) {
  const dir = given || mkdtempSync(join(tmpdir(), "anonyma-status-"));
  const clock = { offset: 0 };
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    statusClock: () => Date.now() + clock.offset,
    ...(released && released !== "all" ? { mvpModels: [MODEL] } : {}),
    ...extra,
  });
  if (!keep)
    t.after(() => {
      svc.close();
      if (!given) rmSync(dir, { recursive: true, force: true });
    });
  return { ...svc, clock, dir };
}
let visitor = 0;
async function person(app, username = "tester") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const chat = (p, content = "Hello status", extra = {}) =>
  p.agent
    .post("/api/chat")
    .send({ model: MODEL, messages: [{ role: "user", content }], max_tokens: 50, ...extra });
const status = async (app) => (await request(app).get("/api/status").expect(200)).body;
const family = (report, name) => report.families.find((f) => f.name === name);
async function mockServer(t, handler) {
  const s = createServer(handler);
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  t.after(() => {
    s.closeAllConnections?.();
    return new Promise((r) => s.close(r));
  });
  return "http://127.0.0.1:" + s.address().port;
}
async function drain(req) {
  for await (const _ of req);
}
// A gateway that answers chats with `reply(n)`: "ok", "hang", or a status.
async function gateway(t, reply) {
  let n = 0;
  return mockServer(t, async (req, res) => {
    await drain(req);
    const what = reply(++n);
    if (what === "hang") return;
    if (what === "ok") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"index":0,"delta":{"content":"Hi"}}]}\n\n');
      res.write('data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":1}}\n\n');
      return res.end("data: [DONE]\n\n");
    }
    res.writeHead(what, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Upstream says no" } }));
  });
}
async function liveFixture(t, reply, extra = {}) {
  const s = fixture(t, { testMode: false, gateway: await gateway(t, reply), gatewayKey: "fixture", ...extra });
  const p = await person(s.app);
  addCredit(s.db, p.user.id, 100000000, "status-fund");
  return { s, p };
}

// ---- The release gate ----

test("unreleased: the API refuses, the page is unknown, nothing is listed and nothing is recorded", async (t) => {
  const mvp = fixture(t, { released: "mvp" });
  for (const path of ["/api/status", "/API/Status/", "/api/status/models"]) {
    const res = await request(mvp.app).get(path).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Model Status is coming soon.");
  }
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.status, false);
  const doc = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.equal(doc.paths["/api/status"], undefined);
  assert.doesNotMatch((await request(mvp.app).get("/sitemap.xml").expect(200)).text, /\/status</);
  if (existsSync("dist/client/index.html")) await request(mvp.app).get("/status").expect(404);
  // Real traffic before release leaves nothing behind.
  const p = await person(mvp.app);
  await chat(p).expect(200);
  assert.deepEqual(mvp.modelStatus.events(), []);

  const live = fixture(t, { released: "mvp,status" });
  await request(live.app).get("/api/status").expect(200);
  assert.ok((await request(live.app).get("/api/openapi.json").expect(200)).body.paths["/api/status"]);
  assert.match((await request(live.app).get("/sitemap.xml").expect(200)).text, /\/status</);
  if (existsSync("dist/client/index.html")) await request(live.app).get("/status").expect(200);
});

test("the gate covers the route and the page, and the update reads plainly", () => {
  assert.deepEqual(featuresFor({ path: "/api/status", method: "GET", body: {} }), ["status"]);
  assert.deepEqual(featuresFor({ path: "/API/STATUS/", method: "GET", body: {} }), ["status"]);
  assert.deepEqual(featuresFor({ path: "/api/statuses", method: "GET", body: {} }), []);
  assert.equal(knownPage("/status"), false);
  assert.equal(knownPage("/status", { status: true }), true);
  assert.doesNotMatch(sitemap("https://a.example"), /\/status</);
  assert.match(sitemap("https://a.example", { status: true }), /https:\/\/a\.example\/status</);
  const entry = UPDATES.find((u) => u.id === "status");
  assert.equal(entry.title, "Model Status");
  assert.equal(entry.points.length, 3);
});

// ---- The rolling window ----

test("percentiles are nearest-rank, and status follows the thresholds with a minimum sample", () => {
  const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(ten, 0.5), 5);
  assert.equal(percentile(ten, 0.9), 9);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 5);
  assert.equal(percentile([7], 0.5), 7);
  assert.equal(percentile([], 0.5), null);
  assert.equal(MIN_SAMPLES, 5);
  assert.equal(DEGRADED_AT, 0.2);
  assert.equal(DOWN_AT, 0.5);
  assert.equal(statusFrom(4, 0), "unknown");
  assert.equal(statusFrom(4, 4), "unknown");
  assert.equal(statusFrom(5, 0), "up");
  assert.equal(statusFrom(6, 1), "up"); // 17%
  assert.equal(statusFrom(5, 1), "degraded"); // 20%
  assert.equal(statusFrom(10, 4), "degraded"); // 40%
  assert.equal(statusFrom(6, 3), "down"); // 50%
  assert.equal(statusFrom(5, 5), "down");
});

test("the windows: 15 minutes for status, an hour for timings, older events dropped", () => {
  let now = 10 * TIMING_WINDOW_MS;
  const store = createModelStatus({ clock: () => now });
  const at = (ago, outcome, ttft = null, total = null) => {
    now -= ago;
    store.record(MODEL, outcome, { ttft, total });
    now += ago;
  };
  // Four successes: too few for anything.
  for (const ms of [800, 900, 1000, 1100]) at(MINUTE, "ok", ms, ms * 4);
  let s = summarize(store.events(), now);
  assert.deepEqual(s, { status: "unknown", ttft: null, total: null });
  // The fifth shows numbers, rounded to a tenth of a second.
  at(MINUTE, "ok", 1449, 5000);
  s = summarize(store.events(), now);
  assert.equal(s.status, "up");
  assert.deepEqual(s.ttft, { median: 1000, p90: 1400 });
  assert.deepEqual(s.total, { median: 4000 });
  // Failures from 20 minutes ago count for nothing in the status...
  for (let i = 0; i < 10; i++) at(20 * MINUTE, "error");
  assert.equal(summarize(store.events(), now).status, "up");
  // ...but failures inside the last 15 minutes do.
  at(14 * MINUTE, "timeout");
  at(2 * MINUTE, "error");
  assert.equal(summarize(store.events(), now).status, "degraded"); // 2 of 7
  for (let i = 0; i < 5; i++) at(MINUTE, "error");
  assert.equal(summarize(store.events(), now).status, "down"); // 7 of 12
  // Failures never carry timings.
  assert.ok(store.events().filter((e) => e.outcome !== "ok").every((e) => e.ttft === null && e.total === null));
  // Sixteen minutes on, the status window has emptied; timings remain.
  now += 16 * MINUTE;
  s = summarize(store.events(), now);
  assert.equal(s.status, "unknown");
  assert.deepEqual(s.ttft, { median: 1000, p90: 1400 });
  // An hour on, everything is gone, from the numbers and from memory.
  now += TIMING_WINDOW_MS;
  assert.deepEqual(summarize(store.events(), now), { status: "unknown", ttft: null, total: null });
  store.record(MODEL, "ok", { ttft: 100, total: 200 });
  assert.equal(store.events().length, 1);
  assert.equal(STATUS_WINDOW_MS, 15 * MINUTE);
});

test("memory stays bounded, and nothing is recorded while the update is off", () => {
  let now = 1_000_000;
  const store = createModelStatus({ clock: () => now++ });
  for (let i = 0; i < MAX_EVENTS + 25; i++) store.record(MODEL, "ok", { ttft: 5, total: 9 });
  assert.equal(store.events().length, MAX_EVENTS);
  // Bad input is ignored.
  store.record("", "ok");
  store.record(MODEL, "stopped");
  store.record({ id: MODEL }, "ok");
  assert.equal(store.events().length, MAX_EVENTS);
  let on = false;
  const gated = createModelStatus({ enabled: () => on });
  gated.record(MODEL, "ok");
  gated.start(MODEL).sent();
  assert.deepEqual(gated.events(), []);
  on = true;
  gated.record(MODEL, "ok");
  assert.equal(gated.events().length, 1);
});

test("a request counts from when it's sent, once, with its first-token time", async () => {
  let now = 5000;
  const store = createModelStatus({ clock: () => now });
  // Never sent (refused before sending): nothing.
  const refused = store.start(MODEL);
  refused.fail({ code: "insufficient_credits" });
  refused.ok();
  assert.deepEqual(store.events(), []);
  const probe = store.start(MODEL);
  probe.sent();
  now += 700;
  probe.first();
  now += 50;
  probe.first(); // only the first token counts
  now += 1250;
  probe.done(true);
  probe.fail({ code: "provider_down" }); // already ended
  assert.deepEqual(store.events(), [{ t: 7000, outcome: "ok", ttft: 700, total: 2000 }]);
  // A stream that ends without output is a provider error.
  const empty = store.start(MODEL);
  empty.sent();
  empty.done(false);
  assert.equal(store.events().at(-1).outcome, "error");
  // A single media call: timed, or outcome only.
  await store.timed(IMAGE_MODEL, async () => (now += 3000));
  assert.deepEqual(store.events().at(-1), { t: 10000, outcome: "ok", ttft: null, total: 3000 });
  await store.timed(VIDEO_MODEL, async () => "job", { timed: false });
  assert.deepEqual(store.events().at(-1), { t: 10000, outcome: "ok", ttft: null, total: null });
  await assert.rejects(
    store.timed(VIDEO_MODEL, async () => {
      throw Object.assign(Error("no"), { code: "provider_down" });
    }),
    /no/,
  );
  assert.equal(store.events().at(-1).outcome, "error");
});

test("what counts against a model, and what doesn't", () => {
  const aborted = (reason) => {
    const c = new AbortController();
    c.abort(reason);
    return c.signal;
  };
  const e = (code, extra = {}) => Object.assign(Error(code), { code, ...extra });
  // The person stopped, or the service restarted: not the model.
  assert.equal(outcomeOf(e("x"), aborted(new Error("Client disconnected"))), null);
  assert.equal(outcomeOf(e("x"), aborted(new Error("Service restarting"))), null);
  // The request's own deadline.
  assert.equal(outcomeOf(e("x"), aborted(new Error("Provider timeout"))), "timeout");
  assert.equal(outcomeOf(e("x"), aborted()), "timeout");
  assert.equal(outcomeOf(e("provider_timeout")), "timeout");
  assert.equal(outcomeOf(Object.assign(Error("t"), { name: "TimeoutError" })), "timeout");
  // Provider failures.
  for (const code of ["provider_down", "provider_busy", "provider_unavailable", "provider_interrupted", "provider_unreadable", "provider_ambiguous", "empty_output"])
    assert.equal(outcomeOf(e(code)), "error", code);
  // A mid-stream error, and a model the provider no longer has.
  assert.equal(outcomeOf(e("provider_rejected", { status: 502 })), "error");
  assert.equal(outcomeOf(e("provider_rejected", { status: 400, upstreamStatus: 404 })), "error");
  // The provider turned down this one request as invalid: not counted.
  assert.equal(outcomeOf(e("provider_rejected", { status: 400, upstreamStatus: 400 })), null);
  assert.equal(outcomeOf(e("provider_rejected", { status: 502, upstreamStatus: 422 })), null);
  assert.equal(outcomeOf(e("provider_rejected", { status: 400, upstreamStatus: 413 })), null);
  // Refused by ANONYMA before sending, or ANONYMA's own trouble.
  for (const code of ["insufficient_credits", "spending_limit", "seed_phrase_blocked", "invalid_request", "model_not_found", "server_error", undefined])
    assert.equal(outcomeOf(e(code)), null, String(code));
});

test("the report: families by maker, models only with enough data, nothing about requests", () => {
  let now = 50 * MINUTE;
  const store = createModelStatus({ clock: () => now });
  const catalog = [
    { id: "a/one", name: "One", owned_by: "Alpha", type: "chat" },
    { id: "a/two", name: "Two", owned_by: "Alpha", type: "chat" },
    { id: "b/one", name: "Bee", owned_by: "Beta", type: "chat" },
    { id: "c/one", name: "Sea", owned_by: "Gamma", type: "image" },
    { id: "d/one", name: "Dee", type: "chat" },
  ];
  // Alpha: three each on two models (the family has six; each model too few).
  for (let i = 0; i < 3; i++) {
    store.record("a/one", "ok", { ttft: 300, total: 900 });
    store.record("a/two", "ok", { ttft: 500, total: 1500 });
  }
  // Beta: down.
  for (let i = 0; i < 5; i++) store.record("b/one", "error");
  store.record("b/one", "ok", { ttft: 900, total: 1000 });
  // A model outside the listed catalog is never reported.
  for (let i = 0; i < 9; i++) store.record("hidden/model", "ok", { ttft: 1, total: 2 });
  const report = store.report(catalog, now);
  assert.equal(report.checkedAt, now);
  assert.deepEqual(report.windows, { statusMinutes: 15, timingMinutes: 60 });
  assert.equal(report.minSamples, 5);
  assert.deepEqual(report.thresholds, { degraded: 0.2, down: 0.5 });
  assert.deepEqual(report.families.map((f) => [f.name, f.status]), [
    ["Beta", "down"],
    ["Alpha", "up"],
    ["Gamma", "unknown"],
    ["Other", "unknown"],
  ]);
  const alpha = family(report, "Alpha");
  assert.deepEqual(alpha.ttft, { median: 300, p90: 500 });
  assert.deepEqual(alpha.models, []);
  const beta = family(report, "Beta");
  assert.deepEqual(beta.models.map((m) => [m.id, m.name, m.status, m.ttft]), [["b/one", "Bee", "down", null]]);
  assert.doesNotMatch(JSON.stringify(report), /hidden\/model/);
  // Only aggregates: no event, count or time of any request.
  const keys = (o, out = new Set()) => {
    if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) (out.add(k), keys(v, out));
    return out;
  };
  assert.deepEqual(
    [...keys(report)].filter((k) => !/^\d+$/.test(k)).sort(),
    ["checkedAt", "degraded", "down", "families", "id", "median", "minSamples", "models", "name", "p90", "status", "statusMinutes", "thresholds", "timingMinutes", "total", "ttft", "type", "windows"].sort(),
  );
});

test("families are grouped case-insensitively, under the catalog's properly cased name, once", () => {
  let now = 50 * MINUTE;
  const store = createModelStatus({ clock: () => now });
  const catalog = [
    { id: "google/a", name: "G A", owned_by: "google", type: "chat" },
    { id: "google/b", name: "G B", owned_by: "Google", type: "chat" },
    { id: "google/c", name: "G C", owned_by: " GOOGLE ", type: "image" },
    { id: "openai/a", name: "O A", owned_by: "openai", type: "chat" },
    { id: "openai/b", name: "O B", owned_by: "OpenAI", type: "chat" },
    { id: "openai/c", name: "O C", owned_by: "OpenAI", type: "chat" },
    { id: "xai/a", name: "X A", owned_by: "xai", type: "chat" },
    { id: "xai/b", name: "X B", owned_by: "xAI", type: "chat" },
    { id: "flux/a", name: "F A", owned_by: "flux", type: "image" },
    { id: "none/a", name: "N A", owned_by: "", type: "chat" },
    { id: "none/b", name: "N B", provider: "other", type: "chat" },
  ];
  // Traffic split across two spellings of the same maker counts as one family.
  for (let i = 0; i < 3; i++) {
    store.record("google/a", "ok", { ttft: 400, total: 900 });
    store.record("google/b", "ok", { ttft: 600, total: 1100 });
  }
  const report = store.report(catalog, now);
  const names = report.families.map((f) => f.name);
  assert.deepEqual(names, ["Google", "flux", "OpenAI", "Other", "xAI"]);
  assert.equal(new Set(names.map((n) => n.toLowerCase())).size, names.length, "each family once");
  const google = family(report, "Google");
  assert.equal(google.status, "up");
  assert.deepEqual(google.ttft, { median: 400, p90: 600 });
  // Unknown families are all still listed, once each, for "Not enough data yet".
  assert.deepEqual(
    report.families.filter((f) => f.status === "unknown").map((f) => f.name),
    ["flux", "OpenAI", "Other", "xAI"],
  );
  // The display name: mixed case first, then capitals, then the most used.
  assert.equal(displayName(new Map([["openai", 5], ["OpenAI", 1]])), "OpenAI");
  assert.equal(displayName(new Map([["xai", 1], ["xAI", 1]])), "xAI");
  assert.equal(displayName(new Map([["GOOGLE", 1], ["Google", 3], ["google", 9]])), "Google");
  assert.equal(displayName(new Map([["GOOGLE", 2], ["Google", 1]])), "Google");
  assert.equal(displayName(new Map([["IBM", 1], ["ibm", 4]])), "IBM");
  assert.equal(displayName(new Map([["flux", 1]])), "flux");
});

// ---- Real traffic ----

test("chats, images and video submissions are measured, served cached for 30 seconds, and never who", async (t) => {
  const s = fixture(t);
  const logs = [];
  for (const level of ["log", "info", "warn", "error"])
    t.mock.method(console, level, (...args) => logs.push(args.join(" ")));
  const p = await person(s.app, "zelda-private");
  const secret = "PURPLE-ELEPHANT-7 is my secret prompt";
  // Refused before sending (Seed Guard, a bad request): not counted.
  await chat(p, "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about").expect(400);
  await chat(p, "hello", { model: "no/such-model" }).expect(404);
  assert.deepEqual(s.modelStatus.events(), []);
  const empty = await status(s.app);
  assert.ok(empty.families.length > 3);
  assert.ok(empty.families.every((f) => f.status === "unknown" && !f.ttft && !f.models.length));
  // Four chats (one off the record) are not enough to show anything.
  for (let i = 0; i < 3; i++) await chat(p, secret).expect(200);
  await chat(p, secret, { ephemeral: true }).expect(200);
  assert.equal(s.modelStatus.events().length, 4);
  // Cached: the same answer for 30 seconds.
  const cached = await request(s.app).get("/api/status").expect(200);
  assert.equal(cached.headers["cache-control"], `public, max-age=${CACHE_MS / 1000}`);
  assert.deepEqual(cached.body, empty);
  await chat(p, secret).expect(200);
  assert.deepEqual(await status(s.app), empty);
  s.clock.offset += CACHE_MS + 1000;
  const report = await status(s.app);
  assert.ok(report.checkedAt > empty.checkedAt);
  const google = family(report, "Google");
  assert.equal(google.status, "up");
  assert.ok(google.ttft && Number.isInteger(google.ttft.median) && Number.isInteger(google.ttft.p90));
  const entry = google.models.find((m) => m.id === MODEL);
  assert.equal(entry.status, "up");
  assert.ok(entry.ttft && entry.total);
  // Media: an image (timed) and a video submission (outcome only).
  await p.agent.post("/api/images").send({ model: IMAGE_MODEL, prompt: secret }).expect(200);
  await p.agent.post("/api/videos").send({ model: VIDEO_MODEL, prompt: secret, ratio: "16:9", duration: "5" }).expect(202);
  const events = s.modelStatus.events();
  assert.equal(events.length, 7);
  assert.deepEqual(events.filter((e) => e.total !== null).length, 6);
  // Only the model's outcome and timings are kept: nothing about the person.
  for (const e of events) assert.deepEqual(Object.keys(e).sort(), ["outcome", "t", "total", "ttft"]);
  const text = JSON.stringify(report);
  for (const leak of [p.user.id, "zelda-private", "PURPLE-ELEPHANT", "c_", "m_", "198.51.100"])
    assert.ok(!text.includes(leak), "no " + leak);
  for (const line of logs)
    for (const leak of ["PURPLE-ELEPHANT", "zelda-private", p.user.id, MODEL])
      assert.ok(!line.includes(leak), "logged " + leak + ": " + line);
  // Public: no sign-in needed, and the same for everyone.
  const other = await person(s.app, "someone-else");
  assert.deepEqual((await other.agent.get("/api/status").expect(200)).body, report);
});

// Batch 6's model calls that don't go through /api/chat are measured the
// same way (Study, Document Compare, Summarize & Continue and Page Watch run
// through runChat, so they're counted as chats).
test("Prompt Sharpen, fact-checks and Audio Overview's script are measured like chats", async (t) => {
  const s = fixture(t);
  const p = await person(s.app, "measured-tools");
  addCredit(s.db, p.user.id, 100000000, "status-fund-tools");
  await p.agent
    .post("/api/sharpen")
    .send({ model: MODEL, prompt: "write a short note to my landlord about the heating" })
    .expect(200);
  assert.equal(s.modelStatus.events().length, 1);
  await p.agent
    .post("/api/factcheck")
    .send({ model: MODEL, claim: "The Eiffel Tower is in Paris.", ephemeral: true })
    .expect(200);
  assert.equal(s.modelStatus.events().length, 2);
  const overview = await p.agent
    .post("/api/audio/overview")
    .send({
      model: MODEL,
      tts: "fixture-voice",
      voices: { A: "fixture-1", B: "fixture-2" },
      length: "short",
      ephemeral: true,
      source: {
        kind: "document",
        title: "Night bus briefing.md",
        text: "Starting 3 March, four night lines replace six late-night routes, every 20 minutes from midnight to 5 a.m. ".repeat(4),
      },
    });
  assert.ok(overview.status < 400, "overview " + overview.status);
  // The script call counts once; the voices go through the speech path,
  // which Model Status doesn't measure.
  const events = s.modelStatus.events();
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.outcome === "ok"));
  for (const e of events) assert.deepEqual(Object.keys(e).sort(), ["outcome", "t", "total", "ttft"]);
});

test("provider failures and timeouts count; stops, refusals and invalid requests don't", async (t) => {
  // Five 500s: down.
  {
    const { s, p } = await liveFixture(t, () => 500);
    for (let i = 0; i < 5; i++) await chat(p);
    const google = family(await status(s.app), "Google");
    assert.equal(google.status, "down");
    assert.deepEqual(google.models.map((m) => [m.id, m.status, m.ttft]), [[MODEL, "down", null]]);
  }
  // Four good answers and one outage: degraded (20%).
  {
    const { s, p } = await liveFixture(t, (n) => (n === 3 ? 503 : "ok"));
    for (let i = 0; i < 5; i++) await chat(p);
    assert.equal(family(await status(s.app), "Google").status, "degraded");
  }
  // The provider turned these down as invalid (400): they say nothing.
  {
    const { s, p } = await liveFixture(t, () => 400);
    for (let i = 0; i < 5; i++) await chat(p);
    assert.deepEqual(s.modelStatus.events(), []);
    assert.equal(family(await status(s.app), "Google").status, "unknown");
  }
  // A model the provider no longer has (404) does count.
  {
    const { s, p } = await liveFixture(t, () => 404);
    await chat(p);
    assert.deepEqual(s.modelStatus.events().map((e) => e.outcome), ["error"]);
  }
  // Timeouts count, as failures.
  {
    const { s, p } = await liveFixture(t, () => "hang", { requestTimeoutMs: 150 });
    await chat(p);
    assert.deepEqual(s.modelStatus.events().map((e) => e.outcome), ["timeout"]);
  }
  // Too few credits: refused before sending.
  {
    const { s } = await liveFixture(t, () => "ok");
    const broke = await person(s.app, "broke");
    await chat(broke).expect(402);
    assert.deepEqual(s.modelStatus.events(), []);
  }
});

test("a restart clears it: nothing is written to the database", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-status-restart-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = fixture(t, { dir, keep: true });
  const p = await person(first.app);
  for (let i = 0; i < 6; i++) await chat(p).expect(200);
  assert.equal(family(await status(first.app), "Google").status, "up");
  const tables = first.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  assert.ok(!tables.some((n) => /status/i.test(n)), tables.join());
  first.close();
  const second = fixture(t, { dir });
  assert.deepEqual(second.modelStatus.events(), []);
  const report = await status(second.app);
  assert.ok(report.families.every((f) => f.status === "unknown" && !f.ttft && !f.models.length));
});

test("Sealed Mode is never measured, and the account has nothing to erase or export", () => {
  const src = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
  assert.doesNotMatch(src("server/routes/sealed.js"), /modelStatus/);
  // In memory only: no table, no migration, no account section.
  assert.doesNotMatch(src("server/core.js"), /model_status|modelStatus/);
  assert.doesNotMatch(src("server/routes/account.js"), /modelStatus/);
});

// ---- The app ----

const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
const han = /\p{Script=Han}/u;

test("client helpers: the gate, labels, seconds and the per-model map", () => {
  assert.equal(statusReleased(null), false);
  assert.equal(statusReleased({ releases: { features: { status: false } } }), false);
  assert.equal(statusReleased({ releases: { features: { status: true } } }), true);
  assert.equal(seconds(1234), "1.2 s");
  assert.equal(seconds(undefined), "—");
  assert.deepEqual(STATUS_LABEL, { up: "Up", degraded: "Degraded", down: "Down", unknown: "Not enough data" });
  const report = {
    families: [
      { name: "Alpha", status: "down", models: [{ id: "a/1", name: "A1", status: "down", ttft: null, total: null }] },
      { name: "Beta", status: "up", models: [] },
      { name: "Gamma", status: "unknown", models: [] },
    ],
  };
  assert.deepEqual(statusByModel(report), { "a/1": { id: "a/1", name: "A1", status: "down", ttft: null, total: null, family: "Alpha" } });
  assert.deepEqual(statusByModel(null), {});
  assert.deepEqual(familyCounts(report), { up: 1, degraded: 0, down: 1, unknown: 1 });
  assert.equal(statusHint({ status: "unknown" }), "");
  assert.equal(statusHint({ status: "up", ttft: { median: 800 } }), "Up: requests went through in the last 15 minutes. Typical first token: 0.8 s.");
});

test("the workspace shows the dot and the notice only once released, never in the demo", () => {
  const src = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
  const ws = src("src/Workspace.jsx");
  assert.match(ws, /const statusLive = !demo && statusReleased\(config\);/);
  assert.match(ws, /useModelStatus\(statusLive\)/);
  assert.match(ws, /statusLive \? statusByModel\(statusReport\) : null/);
  assert.match(ws, /status=\{modelStatus\}/);
  assert.match(ws, /\{selectedDown && !sealedOn && !blindActive && <ModelDownNotice model=\{selectedDown\} \/>\}/);
  const finder = src("src/ModelFinder.jsx");
  assert.match(finder, /\{current && status && <StatusDot entry=\{status\[current\.id\]\} \/>\}/);
  assert.match(finder, /\{status && <StatusDot entry=\{status\[m\.id\]\} \/>\}/);
  // Nothing is fetched unless it's live.
  assert.match(src("src/model-status.js"), /if \(!live\) \{\s*setReport\(null\);\s*return;\s*\}/);
  // The page is its own chunk, and no link to it shows before release.
  const app = src("src/App.jsx");
  assert.match(app, /const ModelStatus = lazy\(\(\) => import\("\.\/ModelStatus\.jsx"\)\)/);
  assert.match(app, /\(to === "\/status" && !featureEnabled\(config, "status"\)\)/);
  assert.match(src("src/ModelStatus.jsx"), /if \(!live\) return <NotFound \/>;/);
});

// JSX compiled for Node with the same esbuild Vite uses; shared UI, routing
// and app context are swapped for plain stand-ins so only their own text
// renders.
async function compileAll() {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-status-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub("ui.mjs", `export const Icon = () => React.createElement("svg");`);
  const context = stub("context.mjs", `export const useApp = () => ({ config: null, loading: false });`);
  const pages = stub(
    "pages.mjs",
    `export const PageIntro = ({ eyebrow, title, children }) => React.createElement("div", null, React.createElement("p", null, eyebrow), React.createElement("h1", null, title), React.createElement("p", null, children));
     export const NotFound = () => React.createElement("main", null, "404");`,
  );
  const compiled = {};
  async function compile(file) {
    const src = new URL("../src/" + file, import.meta.url);
    const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
    const out = code
      .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
      .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
      .replace(/from "\.\/context\.jsx"/g, `from "${context}"`)
      .replace(/from "\.\/Pages\.jsx"/g, `from "${pages}"`)
      .replace(/from "\.\/StatusDot\.jsx"/g, () => `from "${compiled["StatusDot.jsx"]}"`)
      .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
      .replace(/from "react"/g, `from "${react}"`);
    const path = join(dir, file.replace(/\.jsx$/, ".mjs"));
    writeFileSync(path, out);
    compiled[file] = pathToFileURL(path).href;
    return import(compiled[file]);
  }
  try {
    const dot = await compile("StatusDot.jsx");
    const finder = await compile("ModelFinder.jsx");
    const page = await compile("ModelStatus.jsx");
    return { ...dot, ModelFinder: finder.default, StatusBoard: page.StatusBoard, Page: page.default };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Text split by whether it sits inside data-i18n="off" (names) or not (the
// page's own words, to be translated).
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr"]);
  const stack = [],
    page = [],
    kept = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g))
        (off || stack.some((x) => x.off) ? kept : page).push(entities(attr));
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>")) stack.push({ off });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    }
  }
  const words = (list) => list.filter((x) => /[A-Za-z]{2}/.test(x));
  return { page: words(page), kept: words(kept) };
}

const REPORT = {
  checkedAt: Date.UTC(2026, 8, 26, 12, 30),
  windows: { statusMinutes: 15, timingMinutes: 60 },
  minSamples: 5,
  thresholds: { degraded: 0.2, down: 0.5 },
  families: [
    {
      name: "Moonfall Labs",
      status: "down",
      ttft: { median: 2100, p90: 4800 },
      total: { median: 9100 },
      models: [{ id: "moon/1", name: "Moonfall One", type: "chat", status: "down", ttft: null, total: null }],
    },
    {
      name: "Brightline",
      status: "degraded",
      ttft: { median: 900, p90: 1900 },
      total: { median: 4200 },
      models: [{ id: "bright/1", name: "Brightline Swift", type: "chat", status: "degraded", ttft: { median: 900, p90: 1900 }, total: { median: 4200 } }],
    },
    { name: "Oakridge AI", status: "up", ttft: { median: 600, p90: 1100 }, total: { median: 3000 }, models: [] },
    { name: "Quietwater", status: "unknown", ttft: null, total: null, models: [] },
  ],
};

test("the picker dot, the notice and the status page: names kept as written, the rest translated", async () => {
  const { StatusDot, ModelDownNotice, ModelFinder, StatusBoard } = await compileAll();
  // No dot without a status: before release the workspace passes none.
  const models = [{ id: "moon/1", name: "Moonfall One", provider: "Moonfall Labs", type: "chat", pricing: {} }];
  const picker = (status) =>
    renderToStaticMarkup(
      createElement(ModelFinder, { models, mode: "chat", resolved: { model: models[0] }, onChoose() {}, opts: {}, status }),
    );
  assert.doesNotMatch(picker(null), /ms-dot/);
  assert.doesNotMatch(picker({}), /ms-dot/);
  assert.match(picker(statusByModel(REPORT)), /class="ms-dot down" role="img" aria-label="Down" title="Down: most requests/);
  // A dot only for a known status.
  assert.equal(renderToStaticMarkup(createElement(StatusDot, { entry: { status: "unknown" } })), "");
  assert.equal(renderToStaticMarkup(createElement(StatusDot, { entry: undefined })), "");
  const html = [
    ...["up", "degraded", "down"].map((s) =>
      renderToStaticMarkup(createElement(StatusDot, { entry: { status: s, ttft: { median: 1200, p90: 2000 } } })),
    ),
    ...["up", "degraded", "down"].map((s) => renderToStaticMarkup(createElement(StatusDot, { entry: { status: s } }))),
    renderToStaticMarkup(createElement(ModelDownNotice, { model: models[0] })),
    renderToStaticMarkup(createElement(StatusBoard, { report: REPORT, testMode: true })),
    renderToStaticMarkup(createElement(StatusBoard, { report: { ...REPORT, families: [REPORT.families[3]] } })),
    renderToStaticMarkup(createElement(StatusBoard, { report: null, failed: true })),
    renderToStaticMarkup(createElement(StatusBoard, { report: null })),
  ].join("");
  const { page, kept } = textsOf(html);
  for (const name of ["Moonfall One", "Moonfall Labs", "Brightline", "Brightline Swift", "Oakridge AI", "Quietwater"])
    assert.ok(kept.includes(name), "kept as written: " + name);
  assert.ok(page.includes("Not enough data yet"));
  assert.ok(page.some((x) => x.startsWith("Checked at ")));
  assert.match(html, /2\.1 s/);
  assert.match(html, /href="\/status"/);
  for (const text of page) assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
});

test("the Chinese dictionary covers the update and the page's own words", () => {
  const entry = UPDATES.find((u) => u.id === "status");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Model Status is coming soon.",
    "MODEL STATUS",
    "Which models are up,",
    "right now.",
    "Measured from ANONYMA's own traffic in the last hour. It isn't a promise from the provider.",
    "Model status",
    "status",
    "1 family up",
    "12 families up",
    "0 families down",
    "Up",
    "Degraded",
    "Down",
    "Not enough data",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
});
