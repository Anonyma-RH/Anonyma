import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { addCredit } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { sharpenBudget, sharpenCosts, sharpenTestReply } from "../server/sharpen.js";
import {
  SHARPEN_LENGTH,
  SHARPEN_PLACEHOLDERS,
  SHARPEN_UNREADABLE,
  SHARPEN_CONTEXT,
} from "../server/routes/sharpen.js";
import {
  MAX_NOTE,
  SHARPEN_BUDGET,
  SHARPEN_SYSTEM,
  SHARPENERS,
  checkAnswers,
  checkPlaceholders,
  defaultSharpener,
  diffCounts,
  diffTokens,
  maskForSharpen,
  onlySentTags,
  parseSharpen,
  pickSharpener,
  placeholderTags,
  readSharpenMessages,
  sharpenBody,
  sharpenMessages,
  sharpenPool,
  wordDiff,
} from "../src/sharpen.js";
import { createVeilState, unveil, veil } from "../src/veil.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash-lite";
const PROMPT = "write something about our privacy update for customers";
const GOOD = (prompt = "Write a short announcement about our privacy update for customers.") =>
  JSON.stringify({ prompt, notes: ["Named the audience", "Asked for a short format"], questions: ["What tone should it take?"] });

// ---- A stand-in for the gateway ----

async function readJSON(req) {
  let s = "";
  for await (const b of req) s += b;
  return JSON.parse(s || "{}");
}
const event = (res, p) => res.write("data: " + JSON.stringify(p) + "\n\n");
// `answer(body, i)` returns { text, finish } or { status } or null (hang).
async function gateway(t, answer = () => ({ text: GOOD() })) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const body = await readJSON(req);
    calls.push(body);
    const a = answer(body, calls.length - 1);
    if (a === null) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": waiting\n\n");
      req.on("close", () => res.destroy());
      return;
    }
    if (a.status) {
      res.writeHead(a.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stand-in refusal" } }));
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const part of a.text.match(/[\s\S]{1,40}/g) || []) event(res, { choices: [{ delta: { content: part } }] });
    event(res, {
      choices: [{ delta: {}, finish_reason: a.finish || "stop" }],
      usage: { prompt_tokens: 400, completion_tokens: 200 },
    });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: "http://127.0.0.1:" + server.address().port, calls };
}

function fixture(t, { released = "all", gatewayUrl = "http://127.0.0.1:9", ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-sharpen-"));
  const svc = createApp({
    testMode: false,
    gateway: gatewayUrl,
    gatewayKey: "fixture",
    released,
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
let visitor = 0;
async function person(s, username, fund = 5_000_000) {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  if (fund) addCredit(s.db, r.body.user.id, fund, "fund-" + username, "test_credit");
  return { agent, user: r.body.user };
}
const sharpen = (p, extra = {}) =>
  p.agent.post("/api/sharpen").send({ model: MODEL, prompt: PROMPT, requestId: "s-" + Math.random(), ...extra });
const spent = (s, user) =>
  0 - s.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE user_id=? AND amount<0").get(user).n;
const holds = (s, user) => s.db.prepare("SELECT id,status,amount,kind FROM holds WHERE user_id=?").all(user);

// ---- The release gate ----

test("unreleased: both routes are refused before anything runs; the API docs and the app leave it out", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { released: "mvp", gatewayUrl: g.url, mvpModels: [MODEL] });
  const a = await person(s, "ana");
  for (const path of ["/api/sharpen", "/api/sharpen/quote", "/API/Sharpen"]) {
    const res = await a.agent.post(path).send({ model: MODEL, prompt: PROMPT, chars: 20 }).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Prompt Sharpen is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(s.app).post("/api/sharpen").send({}).expect(403);
  assert.equal(g.calls.length, 0);
  assert.equal(holds(s, a.user.id).length, 0);
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.sharpen, false);
  const entry = config.releases.updates.find((u) => u.id === "sharpen");
  assert.equal(entry.title, "Prompt Sharpen");
  assert.equal(entry.points.length, 3);
  const docs = (await request(s.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!docs.paths["/api/sharpen"] && !docs.paths["/api/sharpen/quote"]);
  // Released, Private Mode still needs its own update.
  const gates = (body) => featuresFor({ path: "/api/sharpen", method: "POST", body });
  assert.deepEqual(gates({}), ["sharpen"]);
  assert.deepEqual(gates({ private: true }), ["sharpen", "private"]);
  assert.deepEqual(featuresFor({ path: "/api/sharpen/quote", method: "POST", body: { private: true } }), ["sharpen", "private"]);
  const partly = fixture(t, { released: "mvp,sharpen", gatewayUrl: g.url, mvpModels: [MODEL] });
  const b = await person(partly, "ben");
  const res = await sharpen(b, { private: true }).expect(403);
  assert.match(res.body.error.message, /coming soon/);
  await sharpen(b).expect(200);
  // The app: nothing is shown until it's released, and never in Sealed Mode.
  const ui = await uiModule();
  assert.equal(ui.sharpenLive({}), false);
  assert.equal(ui.sharpenLive({ releases: { features: { sharpen: false } } }), false);
  assert.equal(ui.sharpenLive({ releases: { features: { sharpen: true } } }), true);
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(ws, /const sharpenAvailable =\s*!demo && !!user && textMode && sharpenLive\(config\) && !sealedOn && !sealedThread;/);
  assert.match(ws, /\{sharpenAvailable && \(\s*<SharpenPanel/);
  assert.match(ws, /\{sharpenAvailable && \(\s*<SharpenButton/);
  const account = readFileSync(new URL("../src/Sharpen.jsx", import.meta.url), "utf8");
  assert.match(account, /if \(!sharpenLive\(config\) \|\| !user\) return null;/);
});

// ---- The sharpener's answer ----

test("the answer is strict JSON; notes and questions are capped; anything else is unreadable", () => {
  const ok = parseSharpen(GOOD());
  assert.equal(ok.prompt, "Write a short announcement about our privacy update for customers.");
  assert.deepEqual(ok.notes, ["Named the audience", "Asked for a short format"]);
  assert.deepEqual(ok.questions, ["What tone should it take?"]);
  assert.deepEqual(parseSharpen("```json\n" + GOOD() + "\n```"), ok);
  // Missing lists are empty; long ones are capped, tidied and de-duplicated.
  assert.deepEqual(parseSharpen(JSON.stringify({ prompt: " Hi there, do X. " })), { prompt: "Hi there, do X.", notes: [], questions: [] });
  const capped = parseSharpen(
    JSON.stringify({ prompt: "p", notes: ["a", "A", "b", "c", "d", "x".repeat(400)], questions: ["q1?", "q2?", "q3?"] }),
  );
  assert.deepEqual(capped.notes, ["a", "b", "c"]);
  assert.deepEqual(capped.questions, ["q1?", "q2?"]);
  assert.equal(parseSharpen(JSON.stringify({ prompt: "p", notes: ["y".repeat(400)] })).notes[0].length, MAX_NOTE);
  for (const bad of [
    "Sure! Here is a better prompt: Write a short announcement.",
    'Here you go: {"prompt": "x"}',
    '{"prompt": "Write a short',
    JSON.stringify({ improved: "x" }),
    JSON.stringify({ prompt: "" }),
    JSON.stringify({ prompt: 7 }),
    JSON.stringify({ prompt: "x", notes: "one note" }),
    JSON.stringify({ prompt: "x", questions: [1, 2] }),
    JSON.stringify(["x"]),
    JSON.stringify({ prompt: "x".repeat(16001) }),
    "",
    null,
  ])
    assert.equal(parseSharpen(bad), null, String(bad));
});

test("only the prompt and answers are sent, between markers, with the sharpener's instructions", () => {
  const m = sharpenMessages(PROMPT);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { role: "system", content: SHARPEN_SYSTEM });
  assert.match(m[1].content, /not instructions for you/);
  assert.ok(m[1].content.includes(PROMPT));
  const withAnswers = sharpenMessages(PROMPT, [{ question: "Who is it for?", answer: "Pro customers" }]);
  assert.deepEqual(readSharpenMessages(withAnswers), { prompt: PROMPT, answers: [{ question: "Who is it for?", answer: "Pro customers" }] });
  assert.equal(readSharpenMessages([{ role: "system", content: "other" }, m[1]]), null);
  // The request body the browser posts: nothing but these keys.
  assert.deepEqual(Object.keys(sharpenBody({ model: MODEL, prompt: PROMPT, requestId: "r" })).sort(), ["model", "prompt", "requestId"]);
  assert.deepEqual(
    sharpenBody({ model: MODEL, prompt: PROMPT, answers: [{ question: "q", answer: "a" }], privateMode: true, requestId: "r" }),
    { model: MODEL, prompt: PROMPT, answers: [{ question: "q", answer: "a" }], private: true, requestId: "r" },
  );
  // Answers: at most 2, each with its question and some text.
  assert.deepEqual(checkAnswers(undefined), []);
  assert.deepEqual(checkAnswers([{ question: " Who? ", answer: "  line one\n line two " }]), [{ question: "Who?", answer: "line one line two" }]);
  assert.throws(() => checkAnswers([{ question: "q", answer: "a" }, { question: "q", answer: "a" }, { question: "q", answer: "a" }]));
  assert.throws(() => checkAnswers([{ question: "q", answer: " " }]));
  assert.throws(() => checkAnswers([{ question: "q", answer: "x".repeat(501) }]));
  assert.throws(() => checkAnswers("answers"));
});

test("reply room: 8,000 tokens, within the model's output cap and context", () => {
  const cfgAll = { released: "all" };
  assert.equal(SHARPEN_BUDGET, 8000);
  const m = sharpenMessages(PROMPT);
  assert.equal(sharpenBudget(cfgAll, { id: "big", context_length: 1_000_000, max_completion_tokens: 65536 }, m), 8000);
  assert.equal(sharpenBudget(cfgAll, { id: "small", context_length: 1_000_000, max_completion_tokens: 2048 }, m), 2048);
  assert.equal(sharpenBudget({ released: new Set() }, { id: "any", context_length: 1_000_000 }, m), 8000);
  // A tiny context leaves only what the prompt doesn't use.
  assert.ok(sharpenBudget(cfgAll, { id: "tiny", context_length: 3000, max_completion_tokens: 65536 }, m) < 3000);
});

// ---- Veil ----

test("Veil placeholders must come back exactly: none lost, changed or added", () => {
  const sent = ["EMAIL_1", "PHONE_1"];
  const ok = checkPlaceholders(sent, "Email [EMAIL_1] and call [PHONE_1]; cc [EMAIL_1].");
  assert.equal(ok.ok, true);
  const lost = checkPlaceholders(sent, "Email [EMAIL_1].");
  assert.equal(lost.ok, false);
  assert.deepEqual(lost.missing, ["PHONE_1"]);
  const added = checkPlaceholders(sent, "Email [EMAIL_1] or [EMAIL_2], call [PHONE_1].");
  assert.deepEqual(added.extra, ["EMAIL_2"]);
  assert.equal(added.ok, false);
  for (const altered of [
    "Email EMAIL_1 and call [PHONE_1].",
    "Email [EMAIL_1] (EMAIL_1) and call [PHONE_1].",
    "Email [email_1] and [EMAIL_1], call [PHONE_1].",
    "Email [EMAIL 1] and [EMAIL_1], call [PHONE_1].",
  ])
    assert.equal(checkPlaceholders(sent, altered).ok, false, altered);
  // Nothing sent, nothing to keep; an invented tag is still refused.
  assert.equal(checkPlaceholders([], "Write a card for EMAIL_1 day.").ok, true);
  assert.equal(checkPlaceholders([], "Write to [EMAIL_1].").ok, false);
  assert.deepEqual(placeholderTags("a [KEY_2] b [PRIVATE_10] [not_a_tag]"), ["KEY_2", "PRIVATE_10"]);
  // Notes and questions may name only what was sent.
  assert.equal(onlySentTags("Kept [EMAIL_1] as it was", ["EMAIL_1"]), true);
  assert.equal(onlySentTags("Mentioned [EMAIL_3]", ["EMAIL_1"]), false);
  assert.equal(onlySentTags("Kept EMAIL_1 as it was", ["EMAIL_1"]), false);
});

test("the browser masks with a copy of the chat's map and restores only what it sent", () => {
  // This chat already masked one address; the copy keeps its tag.
  const live = createVeilState();
  veil("earlier: old@example.org", live);
  const copy = structuredClone(live);
  const sent = maskForSharpen(
    "email jane@acme.co and old@example.org about it",
    [{ question: "Who signs it?", answer: "cc boss@acme.co" }],
    { state: copy, words: [] },
  );
  assert.equal(sent.prompt, "email [EMAIL_2] and [EMAIL_1] about it");
  assert.deepEqual(sent.answers, [{ question: "Who signs it?", answer: "cc [EMAIL_3]" }]);
  assert.deepEqual(sent.tags.sort(), ["EMAIL_1", "EMAIL_2", "EMAIL_3"]);
  assert.deepEqual(sent.map, { EMAIL_1: "old@example.org", EMAIL_2: "jane@acme.co", EMAIL_3: "boss@acme.co" });
  assert.equal(sent.masked, 3);
  // The chat's own map is untouched: nothing is recorded for a sharpen.
  assert.deepEqual(Object.keys(live.map), ["EMAIL_1"]);
  assert.equal(
    unveil("Write to [EMAIL_2], cc [EMAIL_3] and [EMAIL_1].", sent.map),
    "Write to jane@acme.co, cc boss@acme.co and old@example.org.",
  );
  // Veil off: what's typed is sent as it is; its own tags still count.
  const plain = maskForSharpen("fill in [PRIVATE_1] please", [], null);
  assert.equal(plain.prompt, "fill in [PRIVATE_1] please");
  assert.deepEqual(plain.tags, ["PRIVATE_1"]);
});

// ---- Running it ----

test("a sharpen sends only the prompt, off the record, and charges its actual use", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "cai");
  // Memory is on, with a fact: it never goes near a sharpen (and a project,
  // its instructions or any other context is refused below).
  await a.agent.put("/api/memory/settings").send({ enabled: true }).expect(200);
  await a.agent.post("/api/memory/facts").send({ text: "I work at Acme" }).expect(201);
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(orig)) console[k] = (...args) => logs.push(args.join(" "));
  let res;
  try {
    res = await sharpen(a).expect(200);
  } finally {
    Object.assign(console, orig);
  }
  assert.equal(res.body.prompt, "Write a short announcement about our privacy update for customers.");
  assert.deepEqual(res.body.notes, ["Named the audience", "Asked for a short format"]);
  assert.deepEqual(res.body.questions, ["What tone should it take?"]);
  assert.equal(res.body.unchanged, false);
  assert.equal(res.body.stored, false);
  assert.equal(res.body.finish_reason, "stop");
  assert.ok(res.body.credits_charged > 0);
  // Upstream: two messages, the whole reply room, nothing else.
  assert.equal(g.calls.length, 1);
  const up = g.calls[0];
  assert.equal(up.model, MODEL);
  assert.equal(up.max_tokens, 8000);
  assert.equal(up.messages.length, 2);
  assert.equal(up.messages[0].content, SHARPEN_SYSTEM);
  assert.ok(!JSON.stringify(up).includes("Acme"));
  assert.ok(!up.plugins && !up.provider);
  // Off the record: no conversation, no message; one charge, filed as chat.
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(a.user.id).n, 0);
  assert.ok(spent(s, a.user.id) > 0);
  const [hold] = holds(s, a.user.id);
  assert.equal(hold.status, "settled");
  assert.equal(s.db.prepare("SELECT feature FROM usage_tags WHERE hold_id=?").get(hold.id).feature, "chat");
  // The export holds no trace of the prompt or the result; nothing is logged.
  const exported = JSON.stringify((await a.agent.get("/api/account/export").expect(200)).body);
  assert.ok(!exported.includes("privacy update"));
  assert.ok(!logs.some((l) => l.includes("privacy update")));
  // Context of any kind is refused, before anything is held or sent.
  for (const extra of [{ project: "p_1" }, { memory: [] }, { conversationId: "c_1" }, { messages: [] }, { instructions: "x" }]) {
    const r = await sharpen(a, extra).expect(400);
    assert.equal(r.body.error.message, SHARPEN_CONTEXT);
  }
  assert.equal((await sharpen(a, { treasury: true }).expect(400)).body.error.code, "invalid_request");
  assert.equal((await sharpen(a, { prompt: "too short" }).expect(400)).body.error.code, "invalid_request");
  assert.equal((await sharpen(a, { prompt: "x".repeat(6001) }).expect(400)).body.error.code, "sharpen_too_long");
  assert.equal(g.calls.length, 1);
  // A repeated request id is refused, never charged twice.
  await sharpen(a, { requestId: "same" }).expect(200);
  assert.equal((await sharpen(a, { requestId: "same" }).expect(409)).body.error.code, "duplicate_request");
});

test("answers go with the prompt again; the result can be unchanged", async (t) => {
  const g = await gateway(t, (body, i) =>
    i === 0
      ? { text: JSON.stringify({ prompt: body.messages[1].content.split("<<<\n")[1].split("\n>>>")[0], notes: [] }) }
      : { text: GOOD("Write a short, friendly announcement for Pro customers.") },
  );
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "dee");
  const same = await sharpen(a).expect(200);
  assert.equal(same.body.unchanged, true);
  await sharpen(a, { answers: [{ question: "Who is it for?", answer: "Pro customers" }] }).expect(200);
  assert.match(g.calls[1].messages[1].content, /Q: Who is it for\?\nA: Pro customers/);
  assert.equal((await sharpen(a, { answers: [{ question: "q", answer: "" }] }).expect(400)).body.error.code, "invalid_request");
});

test("cut short or unreadable: refused, and nothing is charged", async (t) => {
  const answers = [
    { text: '{"prompt": "Write a short announcement about', finish: "length" },
    { text: "Sure! Here's a clearer version: Write a short announcement." },
    { text: GOOD(), finish: "length" },
    { text: "" },
  ];
  const g = await gateway(t, (_, i) => answers[i]);
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "eve");
  const cut = await sharpen(a).expect(502);
  assert.equal(cut.body.error.code, "sharpen_length");
  assert.equal(cut.body.error.message, SHARPEN_LENGTH);
  const prose = await sharpen(a).expect(502);
  assert.equal(prose.body.error.code, "sharpen_unreadable");
  assert.equal(prose.body.error.message, SHARPEN_UNREADABLE);
  assert.equal(spent(s, a.user.id), 0);
  assert.ok(holds(s, a.user.id).every((h) => h.status === "released"));
  // Complete JSON that happened to end at the limit is kept and charged,
  // and says how it finished.
  const whole = await sharpen(a).expect(200);
  assert.equal(whole.body.finish_reason, "length");
  assert.ok(spent(s, a.user.id) > 0);
  assert.equal((await sharpen(a).expect(502)).body.error.code, "empty_output");
});

test("under Veil, a result that loses, changes or adds a placeholder is refused and not charged", async (t) => {
  const veiled = "email the draft to [EMAIL_1] and call [PHONE_1] tomorrow";
  const replies = [
    GOOD("Email the draft to [EMAIL_1] tomorrow."),
    GOOD("Email the draft to EMAIL_1 and call [PHONE_1] tomorrow."),
    GOOD("Email the draft to [EMAIL_1] and [EMAIL_2], call [PHONE_1] tomorrow."),
    JSON.stringify({
      prompt: "Email the draft to [EMAIL_1] and call [PHONE_1] tomorrow.",
      notes: ["Kept [EMAIL_1] as it was", "Mentioned [EMAIL_7]"],
      questions: ["Is [PHONE_1] a mobile?", "Should EMAIL_1 get a copy?"],
    }),
  ];
  const g = await gateway(t, (_, i) => ({ text: replies[i] }));
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "fay");
  for (let i = 0; i < 3; i++) {
    const r = await sharpen(a, { prompt: veiled }).expect(502);
    assert.equal(r.body.error.code, "sharpen_placeholders");
    assert.equal(r.body.error.message, SHARPEN_PLACEHOLDERS);
  }
  assert.equal(spent(s, a.user.id), 0);
  const kept = await sharpen(a, { prompt: veiled }).expect(200);
  assert.equal(kept.body.prompt, "Email the draft to [EMAIL_1] and call [PHONE_1] tomorrow.");
  // Notes and questions naming anything else are dropped.
  assert.deepEqual(kept.body.notes, ["Kept [EMAIL_1] as it was"]);
  assert.deepEqual(kept.body.questions, ["Is [PHONE_1] a mobile?"]);
  assert.ok(spent(s, a.user.id) > 0);
  // The placeholders reached the model exactly as the browser masked them.
  assert.ok(g.calls.every((c) => c.messages[1].content.includes(veiled)));
});

test("the estimate comes first, from the prompt's length only, and matches what's held", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url, holdMargin: 1 });
  const a = await person(s, "gus");
  const q = (await a.agent.post("/api/sharpen/quote").send({ model: MODEL, chars: PROMPT.length }).expect(200)).body;
  assert.equal(q.model, MODEL);
  assert.equal(q.estimate, true);
  // "About 0.0x credits" on the default model, at most the whole reply room.
  assert.ok(q.credits > 0 && q.credits < 0.1, `about ${q.credits}`);
  assert.ok(q.max > q.credits);
  assert.ok(q.available > 0);
  // A quote holds nothing and sends nothing, and never takes the prompt.
  assert.equal(holds(s, a.user.id).length, 0);
  assert.equal(g.calls.length, 0);
  assert.equal((await a.agent.post("/api/sharpen/quote").send({ model: MODEL, chars: 20, prompt: PROMPT }).expect(400)).body.error.code, "invalid_request");
  assert.equal((await a.agent.post("/api/sharpen/quote").send({ model: MODEL, chars: -1 }).expect(400)).body.error.code, "invalid_request");
  assert.equal((await a.agent.post("/api/sharpen/quote").send({ model: MODEL, chars: 1e6 }).expect(400)).body.error.code, "invalid_request");
  // The run holds exactly the quoted maximum (no headroom here) and
  // settles on actual use, which is less.
  await sharpen(a).expect(200);
  const [hold] = holds(s, a.user.id);
  assert.equal(hold.amount / 10000, q.max);
  assert.ok(spent(s, a.user.id) / 10000 < q.max);
  // Server and quote price the same way.
  const m = { id: MODEL, pricing: { input_per_1M_tokens: 0.05, output_per_1M_tokens: 0.2 }, context_length: 1048576 };
  const c = sharpenCosts({ cfg: { released: "all" }, m, messages: sharpenMessages("x".repeat(PROMPT.length)), chars: PROMPT.length, factor: 1 });
  assert.ok(c.typical <= c.max && c.budget === 8000);
});

test("too few credits, a spending limit or a provider failure: nothing is sent or charged", async (t) => {
  const g = await gateway(t, () => ({ status: 500 }));
  const s = fixture(t, { gatewayUrl: g.url });
  const poor = await person(s, "hal", 1);
  assert.equal((await sharpen(poor).expect(402)).body.error.code, "insufficient_credits");
  assert.equal(g.calls.length, 0);
  const a = await person(s, "ian");
  await a.agent.patch("/api/spending-limits").send({ daily_limit: 0 }).expect(200);
  assert.equal((await sharpen(a).expect(402)).body.error.code, "spending_limit");
  assert.equal(g.calls.length, 0);
  const b = await person(s, "jon");
  await sharpen(b).expect((r) => assert.ok(r.status >= 500));
  assert.equal(spent(s, b.user.id), 0);
  assert.ok(holds(s, b.user.id).every((h) => h.status === "released"));
});

test("Stop releases the hold: nothing is charged", async (t) => {
  const g = await gateway(t, () => null);
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "kim");
  const pending = sharpen(a).timeout({ response: 400 }).then(
    () => assert.fail("should not answer"),
    (e) => e,
  );
  await pending;
  for (let i = 0; i < 40 && holds(s, a.user.id).some((h) => h.status === "held"); i++)
    await new Promise((r) => setTimeout(r, 50));
  assert.ok(holds(s, a.user.id).every((h) => h.status === "released"));
  assert.equal(spent(s, a.user.id), 0);
});

test("Seed Guard and Private Mode", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url, privateModels: [MODEL] });
  const a = await person(s, "lee");
  const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const r = await sharpen(a, { prompt: "fix this: " + seed, allow_seed_phrase: true }).expect(400);
  assert.equal(r.body.error.code, "seed_phrase_blocked");
  const r2 = await sharpen(a, { answers: [{ question: "Which wallet?", answer: seed }] }).expect(400);
  assert.equal(r2.body.error.code, "seed_phrase_blocked");
  assert.equal(g.calls.length, 0);
  // Private Mode: zero-data-retention routing, no failover, nothing stored.
  const p = await sharpen(a, { private: true }).expect(200);
  assert.deepEqual(p.body.private, { privacy: "zdr", stored: false });
  assert.equal(g.calls[0].provider?.zdr, true);
  const s2 = fixture(t, { gatewayUrl: g.url });
  const b = await person(s2, "moe");
  assert.equal((await sharpen(b, { private: true }).expect(400)).body.error.code, "private_model_required");
  assert.equal((await b.agent.post("/api/sharpen/quote").send({ model: MODEL, chars: 40, private: true }).expect(400)).body.error.code, "private_model_required");
});

// ---- The default model ----

test("the default sharpener: a reviewed fast model that doesn't train on prompts, cheapest first otherwise", () => {
  const row = (id, i, o, extra = {}) => ({ id, name: id, type: "chat", callable: true, pricing: { input_per_1M_tokens: i, output_per_1M_tokens: o }, ...extra });
  const models = [
    row("big/opus", 5, 25, { popular: true }),
    row("tiny/obscure-flash", 0.01, 0.02),
    row(SHARPENERS[1], 0.23, 0.7),
    row(SHARPENERS[0], 0.05, 0.2, { trainsOnPrompts: true }),
    row("img/gen", 0.01, 0.01, { imageCapable: true }),
    row("off/line", 0.01, 0.01, { callable: false }),
    row("zdr/mini", 0.3, 1, { private: true }),
  ];
  const pool = sharpenPool(models);
  assert.deepEqual(pool.map((m) => m.id), ["tiny/obscure-flash", SHARPENERS[0], SHARPENERS[1], "zdr/mini", "big/opus"]);
  // The first reviewed model that doesn't train on prompts.
  assert.equal(defaultSharpener(pool).id, SHARPENERS[1]);
  // None reviewed: the cheapest popular fast one, then the cheapest fast one.
  assert.equal(defaultSharpener(sharpenPool([row("pop/mini", 1, 2, { popular: true }), row("x/flash", 0.1, 0.1), row("y/large", 0.01, 0.01)])).id, "pop/mini");
  assert.equal(defaultSharpener(sharpenPool([row("x/flash", 0.1, 0.1), row("y/large", 0.01, 0.01)])).id, "x/flash");
  // Private Mode: private models only.
  assert.deepEqual(sharpenPool(models, { privateMode: true }).map((m) => m.id), ["zdr/mini"]);
  // Uncensored keeps its own models.
  assert.deepEqual(sharpenPool(models, { inSection: (m) => m.id === "big/opus" }).map((m) => m.id), ["big/opus"]);
  // A chosen model is used when it's offered here, else the default.
  assert.equal(pickSharpener(pool, "big/opus").id, "big/opus");
  assert.equal(pickSharpener(pool, "gone/model").id, SHARPENERS[1]);
  assert.equal(pickSharpener([], ""), null);
});

// ---- The word diff ----

test("the word diff rebuilds both texts, splits Chinese by character and stays bounded", () => {
  const before = "write something about our privacy update";
  const after = "Write a short announcement about our privacy update.\n\nKeep it under 200 words.";
  const ops = wordDiff(before, after);
  const side = (types) => ops.filter((o) => types.includes(o.type)).map((o) => o.text).join("");
  assert.equal(side(["same", "del"]), before);
  assert.equal(side(["same", "add"]), after);
  assert.ok(ops.some((o) => o.type === "del" && o.text.includes("write")));
  assert.ok(ops.some((o) => o.type === "same" && o.text.includes("about our privacy update")));
  assert.deepEqual(diffCounts(ops), { added: 9, removed: 2 });
  assert.deepEqual(diffTokens("给客户写 email"), ["给", "客", "户", "写", " ", "email"]);
  const zh = wordDiff("给客户写点东西", "给现有客户写一封短信");
  assert.equal(zh.filter((o) => o.type !== "add").map((o) => o.text).join(""), "给客户写点东西");
  assert.equal(zh.filter((o) => o.type !== "del").map((o) => o.text).join(""), "给现有客户写一封短信");
  // Too big to compare word by word: one block out, one in, same ends kept.
  const big = wordDiff("start " + "a ".repeat(50) + "end", "start " + "b ".repeat(50) + "end", 100);
  assert.deepEqual(big.map((o) => o.type), ["same", "del", "add", "same"]);
  assert.deepEqual(wordDiff("same text", "same text"), [{ type: "same", text: "same text" }]);
});

test("the local test stand-in answers like a sharpener and keeps every placeholder", () => {
  const reply = sharpenTestReply(sharpenMessages("email the draft to [EMAIL_1] please"));
  const parsed = parseSharpen(reply);
  assert.ok(parsed.prompt.startsWith("Email the draft to [EMAIL_1] please."));
  assert.equal(checkPlaceholders(["EMAIL_1"], parsed.prompt).ok, true);
  assert.equal(parsed.questions.length, 2);
  const again = parseSharpen(sharpenTestReply(sharpenMessages("email the draft to [EMAIL_1] please", [{ question: "Who is it for?", answer: "Pro customers" }])));
  assert.match(again.prompt, /Audience: Pro customers/);
  assert.deepEqual(again.questions, []);
  assert.equal(sharpenTestReply([{ role: "user", content: "hi" }]), null);
});

// ---- The workspace UI ----

async function uiModule() {
  const src = new URL("../src/Sharpen.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-sharpen-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub("ui.mjs", `export const Icon = ({ name }) => React.createElement("i", { "data-icon": name });`);
  const ctx = stub("context.mjs", `export const useApp = () => globalThis.__sharpenApp || {};`);
  const here = (f) => new URL("../src/" + f, import.meta.url).href;
  const out = code
    .replace(/^import "\.\/sharpen\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/context\.jsx"/g, `from "${ctx}"`)
    .replace(/from "\.\/(lib|estimate|veil|seed-guard|sharpen)\.js"/g, (_, f) => `from "${here(f + ".js")}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "Sharpen.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const panelState = (over = {}) => ({
  state: {
    status: "done",
    original: "write <b>something</b> about it",
    prefix: "",
    answers: [],
    result: 'Write <img src=x onerror="alert(1)"> about it.',
    notes: ["Stated the format <script>"],
    questions: ["Who is it for?"],
    credits: 0.0412,
    unchanged: false,
    veiled: 1,
    ...over,
  },
  reset() {},
  stop() {},
});

test("the UI: before and after as plain text, user and model content kept untranslated", async () => {
  const ui = await uiModule();
  const pool = [{ id: MODEL, name: "Gemini 2.5 Flash Lite", type: "chat", callable: true, pricing: { input_per_1M_tokens: 0.05, output_per_1M_tokens: 0.2 } }];
  const html = renderToStaticMarkup(
    createElement(ui.SharpenPanel, { sharpen: panelState(), pool, model: pool[0], onModel() {}, estimate: { status: "ready", credits: 0.0487, max: 1.6 } }),
  );
  assert.match(html, /PROMPT SHARPEN/);
  assert.match(html, /<del>write<\/del>/);
  assert.match(html, /<ins>Write<\/ins>/);
  // Model output is text, never markup.
  assert.ok(!/<img|<script|<b>/.test(html));
  assert.match(html, /&lt;<\/span><ins>img src=x onerror=&quot;alert\(1\)&quot;<\/ins><span>&gt;/);
  assert.equal((html.match(/class="sharpen-text" data-i18n="off"/g) || []).length, 2);
  assert.match(html, /<li data-i18n="off">Stated the format &lt;script&gt;<\/li>/);
  assert.match(html, /<span data-i18n="off">Who is it for\?<\/span>/);
  assert.match(html, /Use this/);
  assert.match(html, /Keep mine/);
  assert.match(html, /Veil masked 1 detail before sending and restored it here\./);
  assert.match(html, /Gemini 2\.5 Flash Lite · default/);
  assert.match(html, /Sends your prompt and answers again: about 0\.0487 credits\./);
  // Unchanged: no Use this.
  const same = renderToStaticMarkup(createElement(ui.SharpenPanel, { sharpen: panelState({ unchanged: true, result: "same" }), pool, model: pool[0], onModel() {}, estimate: {} }));
  assert.match(same, /Already clear: no changes suggested\./);
  assert.ok(!/Use this/.test(same));
  // Errors, the used bar and nothing at all.
  const err = renderToStaticMarkup(createElement(ui.SharpenPanel, { sharpen: panelState({ status: "error", message: SHARPEN_LENGTH }), pool, model: pool[0], onModel() {}, estimate: {} }));
  assert.match(err, /role="alert"/);
  assert.match(err, /Try again/);
  const used = renderToStaticMarkup(createElement(ui.SharpenPanel, { sharpen: panelState({ status: "used" }), pool, model: pool[0], onModel() {}, estimate: {} }));
  assert.match(used, /The sharpened prompt is in the composer\./);
  assert.match(used, /Undo/);
  assert.equal(renderToStaticMarkup(createElement(ui.SharpenPanel, { sharpen: panelState({ status: "idle" }), pool, model: pool[0], onModel() {}, estimate: {} })), "");
  // The button shows its estimate before it's pressed, or why it can't run.
  const button = renderToStaticMarkup(createElement(ui.SharpenButton, { block: null, estimate: { status: "ready", credits: 0.0487, max: 1.63 } }));
  assert.match(button, /Sharpen this prompt: about 0\.0487 credits, at most 1\.63\. Off the record\./);
  assert.match(button, /≈0\.0487/);
  const blocked = renderToStaticMarkup(createElement(ui.SharpenButton, { block: ui.sharpenBlock({ length: 5, model: pool[0] }), estimate: {} }));
  assert.match(blocked, /disabled=""/);
  assert.match(blocked, /Type at least 12 characters to sharpen\./);
  assert.equal(ui.sharpenBlock({ length: 40, model: null, privateMode: true }), "No zero-data-retention model is available to sharpen with in Private mode.");
  assert.match(ui.sharpenBlock({ length: 40, seed: { kind: "seed" }, model: pool[0] }), /Seed Guard/);
  assert.equal(ui.sharpenBlock({ length: 6001, model: pool[0] }), "Sharpen works on prompts up to 6,000 characters.");
  assert.equal(ui.sharpenBlock({ length: 40, model: pool[0] }), null);
  // Account → Settings: only once released, for a signed-in account.
  globalThis.__sharpenApp = { models: pool, user: { id: "u" } };
  try {
    assert.equal(renderToStaticMarkup(createElement(ui.SharpenSettings, { config: {} })), "");
    const settings = renderToStaticMarkup(createElement(ui.SharpenSettings, { config: { releases: { features: { sharpen: true } } } }));
    assert.match(settings, /Prompt Sharpen\./);
    assert.match(settings, /Gemini 2\.5 Flash Lite · default/);
  } finally {
    delete globalThis.__sharpenApp;
  }
});

test("every visible string has a Chinese entry, including the release copy and server messages", () => {
  const dict = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const entry = UPDATES.find((u) => u.id === "sharpen");
  const strings = [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Sharpen",
    "Sharpening…",
    "Stop sharpening. Nothing is charged.",
    "Sharpen this prompt: about 0.0487 credits, at most 1.63. Off the record.",
    "Sharpen this prompt. Off the record.",
    "No zero-data-retention model is available to sharpen with in Private mode.",
    "No model is available to sharpen with right now.",
    "Seed Guard found what looks like a wallet secret in this prompt, so Sharpen won't send it.",
    "Type at least 12 characters to sharpen.",
    "Sharpen works on prompts up to 6,000 characters.",
    "Wait for the reply to finish.",
    "PROMPT SHARPEN",
    "Prompt Sharpen",
    "Sharpening your prompt…",
    "Already clear: no changes suggested.",
    "32 added · 1 removed",
    "0.0412 credits",
    "Off the record",
    "Your prompt wasn't changed.",
    "Model",
    "Gemini 2.5 Flash Lite · default",
    "Stop",
    "Try again",
    "Before",
    "After",
    "Edit the sharpened prompt",
    "What changed",
    "Answer to sharpen it further",
    "Your answer",
    "Sharpen again",
    "Seed Guard found what looks like a wallet secret in your answer, so Sharpen won't send it.",
    "Sends your prompt and answers again: about 0.0487 credits.",
    "Use this",
    "Edit",
    "Cancel",
    "Keep mine",
    "Undo",
    "Dismiss",
    "Close",
    "The sharpened prompt is in the composer.",
    "Veil masked 1 detail before sending and restored it here.",
    "Veil masked 3 details before sending and restored them here.",
    "Only this prompt is sent, off the record: not your chat, files, memory or instructions. Nothing is saved.",
    "Prompt Sharpen.",
    "The model that sharpens your prompts, in this browser. The default is a fast, inexpensive model that doesn't train on prompts. Private mode always uses a zero-data-retention model, and Uncensored its own models.",
    "Sharpen model",
    "Stopped. Nothing was charged.",
    "Sharpen didn't finish. Nothing was charged.",
    "The estimate is unavailable.",
    SHARPEN_CONTEXT,
    "Sharpen is paid from your own balance, not a team treasury.",
    SHARPEN_LENGTH,
    SHARPEN_UNREADABLE,
    SHARPEN_PLACEHOLDERS,
    "The model returned nothing, so your prompt wasn't changed. Nothing was charged.",
    "The model took too long, so your prompt wasn't changed. Nothing was charged.",
    "Sharpen needs a text model.",
    "Answer at most 2 questions.",
    "Each answer needs its question and some text.",
    "Keep each answer under 500 characters.",
    "Send the prompt's length in characters.",
    "A quote takes the prompt's length, not the prompt.",
    "Private mode needs a model with zero data retention.",
    "Prompt Sharpen is coming soon.",
  ];
  const missing = strings.filter((s) => {
    const zh = translateText(s, dict);
    return !zh || !/\p{Script=Han}/u.test(zh);
  });
  assert.deepEqual(missing, []);
});
