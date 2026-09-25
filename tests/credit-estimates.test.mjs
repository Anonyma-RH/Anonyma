import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";
import {
  buildChatRequest,
  cloneVeilState,
  createEstimator,
  estimateLabel,
  formatCredits,
  quoteBody,
  REPLY_BUDGET,
} from "../src/estimate.js";
import { createVeilState } from "../src/veil.js";

// Credit Estimates: the estimate beside Send quotes the request Send makes,
// never reserves or charges, and never shows a stale or failed answer as a
// number. Server tests use an isolated test-mode database.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-estimates-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: "all",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
async function register(app, name = "estimator") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const MODEL = "google/gemini-2.5-flash";
const units = (credits) => Math.round(credits * 10000);

test("quoting reserves, charges and stores nothing", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const before = balance(s.db, user.id);
  const ledger = s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n;
  for (let i = 0; i < 5; i++) {
    const r = await agent
      .post("/api/quote")
      .send(quoteBody({ model: MODEL, request: [{ role: "user", content: "Draft " + i }] }))
      .expect(200);
    assert.equal(r.body.estimate, true);
    assert.ok(r.body.credits > 0);
  }
  assert.deepEqual(balance(s.db, user.id), before);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, ledger);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
});

test("a chat Send holds exactly its quote times the reservation multiplier", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const { request: messages } = buildChatRequest({
    messages: [
      { role: "user", content: "Earlier question" },
      { role: "assistant", content: "Earlier answer" },
    ],
    text: "Summarize our plan in three bullet points",
    instructions: "Answer briefly.",
  });
  for (const webSearch of [false, true]) {
    const body = quoteBody({ model: MODEL, request: messages, webSearch });
    const q = await agent.post("/api/quote").send(body).expect(200);
    const requestId = "estimate-alignment-" + webSearch;
    await agent
      .post("/api/chat")
      .send({ ...body, requestId, ephemeral: true })
      .expect(200);
    const held = await agent.get("/api/requests/" + requestId).expect(200);
    assert.equal(
      units(held.body.reserved),
      Math.ceil(units(q.body.credits) * s.cfg.holdMargin),
      `hold matches quote (web search ${webSearch})`,
    );
  }
});

test("web search is quoted the same whether asked by flag or by plugin", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const messages = [{ role: "user", content: "What changed today?" }];
  const quoteWith = async (extra) =>
    (await agent.post("/api/quote").send({ model: MODEL, messages, max_tokens: REPLY_BUDGET, ...extra })).body
      .credits;
  const plain = await quoteWith({});
  const flag = await quoteWith({ web_search: true });
  const plugin = await quoteWith({ plugins: [{ id: "web" }] });
  assert.ok(flag > plain);
  assert.equal(plugin, flag);
});

test("quotes are rate limited per account and the limit is an error, not zero", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  const body = { model: MODEL, messages: [{ role: "user", content: "hi" }] };
  for (let i = 0; i < 120; i++) await agent.post("/api/quote").send(body).expect(200);
  const r = await agent.post("/api/quote").send(body).expect(429);
  assert.equal(r.body.credits, undefined);
  const other = await register(s.app, "second");
  await other.agent.post("/api/quote").send(body).expect(200);
});

test("the request builder applies the context window, instructions, documents and images", () => {
  const history = Array.from({ length: 25 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: "turn " + i,
  }));
  const plain = buildChatRequest({ messages: history, text: "new", attachments: [{ url: "data:image/png;base64,AAAA" }] });
  assert.equal(plain.request.length, 20);
  assert.equal(plain.request.at(-1).content[0].text, "new");
  assert.equal(plain.request.at(-1).content[1].image_url.url, "data:image/png;base64,AAAA");
  assert.equal(plain.next.length, 26);
  const standing = buildChatRequest({ messages: history, text: "new", instructions: "Be brief." });
  assert.equal(standing.request.length, 20);
  assert.deepEqual(standing.request[0], { role: "system", content: "Be brief." });
  const docs = buildChatRequest({
    text: "Read this",
    documents: [{ name: "notes.txt", text: "hello", chars: 5 }],
  });
  assert.match(docs.request.at(-1).content, /Read this/);
  assert.match(docs.request.at(-1).content, /hello/);
});

test("Veil: the estimate prices the masked request and remembers nothing", () => {
  const live = createVeilState();
  const words = [];
  const input = {
    messages: [],
    text: "Email me at jane.doe@example.com about card 4111 1111 1111 1111",
    instructions: "My phone is +1 415 555 0100",
  };
  const snapshot = JSON.stringify(live);
  const estimated = buildChatRequest({ ...input, veilWith: { state: cloneVeilState(live), words } });
  // Nothing sensitive leaves in the quote body.
  const body = JSON.stringify(quoteBody({ model: MODEL, request: estimated.request }));
  assert.ok(!body.includes("jane.doe@example.com"));
  assert.ok(!body.includes("4111 1111 1111 1111"));
  assert.ok(estimated.masked >= 2);
  // Estimating recorded no tags in the conversation's map.
  assert.equal(JSON.stringify(live), snapshot);
  // Send then posts exactly the request that was priced.
  const sent = buildChatRequest({ ...input, veilWith: { state: live, words } });
  assert.deepEqual(sent.request, estimated.request);
  assert.equal(sent.masked, estimated.masked);
  assert.notEqual(JSON.stringify(live), snapshot, "Send records its tags");
  assert.equal(sent.next.at(-1).content, sent.request.at(-1).content);
});

test("the quote body carries the reply budget and nothing that saves or reserves", () => {
  const body = quoteBody({ model: MODEL, request: [{ role: "user", content: "x" }] });
  assert.deepEqual(Object.keys(body).sort(), ["max_tokens", "messages", "model"]);
  assert.equal(body.max_tokens, REPLY_BUDGET);
  assert.equal(quoteBody({ model: MODEL, request: [], webSearch: true }).web_search, true);
});

// A manual clock for the estimator's debounce.
function clock() {
  let next = 1;
  const pending = new Map();
  return {
    setTimeout: (fn, ms) => (pending.set(next, { fn, ms }), next++),
    clearTimeout: (id) => pending.delete(id),
    delays: () => [...pending.values()].map((p) => p.ms),
    // Fires what's due without waiting on a quote that may never answer,
    // then lets settled promises run.
    flush() {
      const due = [...pending.values()];
      pending.clear();
      for (const p of due) p.fn();
      return new Promise((r) => setImmediate(r));
    },
  };
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setImmediate(r));

test("estimator debounces edits into one quote for the latest request", async () => {
  const timers = clock();
  const calls = [];
  const states = [];
  const est = createEstimator({
    timers,
    onChange: (s) => states.push(s),
    quote: async (body) => (calls.push(body), { credits: 1.25, available: 50, model: body.model }),
  });
  est.update({ model: "a", n: 1 });
  est.update({ model: "a", n: 2 });
  est.update({ model: "a", n: 3 });
  assert.equal(est.state.status, "loading");
  assert.equal(calls.length, 0);
  await timers.flush();
  assert.deepEqual(calls, [{ model: "a", n: 3 }]);
  assert.deepEqual(est.state, { status: "ready", credits: 1.25, available: 50, model: "a" });
  // An unchanged request is not quoted again.
  est.update({ model: "a", n: 3 });
  await timers.flush();
  assert.equal(calls.length, 1);
  assert.equal(est.state.status, "ready");
});

test("estimator ignores a slow stale response and aborts it", async () => {
  const timers = clock();
  const first = deferred(),
    second = deferred();
  const signals = [];
  const answers = [first, second];
  const est = createEstimator({
    timers,
    onChange: () => {},
    quote: (body, signal) => (signals.push(signal), answers.shift().promise),
  });
  est.update({ model: "slow" });
  await timers.flush();
  est.update({ model: "fast" });
  assert.equal(signals[0].aborted, true, "the superseded request is aborted");
  await timers.flush();
  second.resolve({ credits: 2, available: 10, model: "fast" });
  await tick();
  first.resolve({ credits: 99, available: 10, model: "slow" });
  await tick();
  assert.equal(est.state.status, "ready");
  assert.equal(est.state.model, "fast");
  assert.equal(est.state.credits, 2);
});

test("estimator reports failure as unavailable, zero as zero, and clears to idle", async () => {
  const timers = clock();
  let next = () => Promise.reject(Object.assign(new Error("Too many requests"), { code: "rate_limited" }));
  const est = createEstimator({ timers, onChange: () => {}, quote: () => next() });
  est.update({ model: "a" });
  await timers.flush();
  await tick();
  assert.equal(est.state.status, "unavailable");
  assert.equal(est.state.credits, undefined);
  assert.equal(est.state.code, "rate_limited");
  // The same request is retried after a failure rather than cached.
  next = () => Promise.resolve({ credits: 0, available: 5, model: "a" });
  est.update({ model: "a" });
  await timers.flush();
  assert.deepEqual(est.state, { status: "ready", credits: 0, available: 5, model: "a" });
  // A loading state keeps the previous answer only as `last`.
  est.update({ model: "b" });
  assert.equal(est.state.status, "loading");
  assert.equal(est.state.last.credits, 0);
  est.update(null);
  assert.equal(est.state.status, "idle");
  await timers.flush();
  assert.equal(est.state.status, "idle");
});

test("estimator waits longer before sending requests with images", () => {
  const timers = clock();
  const est = createEstimator({ timers, onChange: () => {}, quote: async () => ({}) });
  est.update({ messages: [{ role: "user", content: "text only" }] });
  assert.deepEqual(timers.delays(), [500]);
  est.update({
    messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:image/png;base64,AA" } }] }],
  });
  assert.deepEqual(timers.delays(), [1500]);
  est.dispose();
  assert.deepEqual(timers.delays(), []);
});

test("credits are formatted for a glance without float noise", () => {
  assert.equal(formatCredits(0), "0");
  assert.equal(formatCredits(0.04213), "0.0421");
  assert.equal(formatCredits(3.2768), "3.28");
  assert.equal(formatCredits(1204.6), "1,205");
  assert.equal(formatCredits("x"), "");
});

test("the workspace sends and estimates through the same builder", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  // Send posts the built request with the shared reply budget.
  assert.match(src, /const built = buildChatRequest\(/);
  assert.match(src, /messages: built\.request,/);
  assert.match(src, /max_tokens: REPLY_BUDGET,/);
  // Both the automatic estimate and the explicit button quote estimateRequest(),
  // which masks with a copy of the Veil map.
  assert.match(src, /cloneVeilState\(veilStateRef\.current\)/);
  assert.match(src, /autoEstimate \? estimateRequest\(\) : null/);
  assert.match(src, /body: estimateRequest\(\)/);
});

test("the chip labels an estimate as one and never shows a previous number while updating", () => {
  assert.deepEqual(estimateLabel({ status: "ready", credits: 42.5, available: 100 }), {
    text: "Estimated ≈42.5 credits",
    tone: "ready",
  });
  assert.equal(estimateLabel({ status: "ready", credits: 0, available: 1 }).text, "Estimated ≈0 credits");
  assert.equal(estimateLabel({ status: "ready", credits: 12, available: 3 }).tone, "short");
  const updating = estimateLabel({ status: "loading", last: { status: "ready", credits: 216 } });
  assert.equal(updating.text, "Updating estimate…");
  assert.doesNotMatch(updating.text, /\d/);
  assert.doesNotMatch(estimateLabel({ status: "unavailable", message: "x" }).text, /\d/);
  assert.equal(estimateLabel({ status: "idle" }), null);
  // No label claims a ceiling or a guaranteed charge.
  for (const state of [{ status: "ready", credits: 5 }, { status: "loading" }, { status: "unavailable" }])
    assert.doesNotMatch(estimateLabel(state).text, /up to|max|exact|guarantee/i);
});
