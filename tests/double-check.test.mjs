import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import { veil, createVeilState } from "../src/veil.js";
import {
  providerKey,
  providerLabel,
  sameProvider,
  differentProvider,
  checkerCandidates,
  buildCheckMessages,
  checkSnapshot,
  canAsk,
  DISCLOSURE,
} from "../src/double-check.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const GOOGLE = "google/gemini-2.5-flash",
  GOOGLE2 = "google/gemini-3.6-flash",
  OPENAI = "openai/gpt-4o-mini",
  PRIVATE = "venice/venice-uncensored-1-2";

function fixture(t, released = "all", extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-doublecheck-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    privateModels: [PRIVATE],
    ...(released === "all"
      ? {}
      : { mvpModels: [GOOGLE, GOOGLE2, OPENAI, PRIVATE] }),
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(app, username) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `192.0.2.${++visitor}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const check = (model, source, extra = {}) => ({
  model,
  messages: buildCheckMessages({
    question: "Is 17 prime?",
    answer: "Yes, 17 is prime.",
    answerModel: source,
  }),
  max_tokens: 50,
  mode: "symposium",
  double_check: { source_model: source },
  ...extra,
});
const counts = (db) => ({
  conversations: db.prepare("SELECT COUNT(*) n FROM conversations").get().n,
  messages: db.prepare("SELECT COUNT(*) n FROM messages").get().n,
});

test("a second opinion from another provider runs and is billed; the reviewed chat is untouched", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ana");
  await agent
    .post("/api/chat")
    .send({
      model: GOOGLE,
      messages: [{ role: "user", content: "Is 17 prime?" }],
      max_tokens: 50,
    })
    .expect(200);
  const source = (await agent.get("/api/conversations")).body.data[0];
  const sourceRows = s.db
    .prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid")
    .all(source.id);
  const before = balance(s.db, user.id).total;
  const r = await agent
    .post("/api/chat")
    .send(
      check(OPENAI, GOOGLE, {
        double_check: { source_model: GOOGLE, source_conversation: source.id },
      }),
    )
    .expect(200);
  assert.match(r.text, /\[DONE\]/);
  assert.match(r.text, /credits_charged/);
  assert.ok(balance(s.db, user.id).total < before, "billed like any chat");
  // The reviewed conversation is exactly as it was; the check is a separate Symposium run.
  assert.deepEqual(
    s.db
      .prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid")
      .all(source.id),
    sourceRows,
  );
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM conversations WHERE mode='symposium'")
      .get().n,
    1,
  );
  assert.equal(
    (await agent.get("/api/conversations")).body.data.length,
    1,
    "the check isn't listed with ordinary chats",
  );
});

test("the checker must come from a different provider, and must be a known answering model", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ben");
  const before = balance(s.db, user.id).total;
  // Same provider, different model: refused before anything is reserved or stored.
  const same = await agent
    .post("/api/chat")
    .send(check(GOOGLE2, GOOGLE))
    .expect(400);
  assert.equal(same.body.error.code, "double_check_same_provider");
  await agent.post("/api/chat").send(check(GOOGLE, GOOGLE)).expect(400);
  for (const bad of [
    {},
    { source_model: 7 },
    { source_model: "nobody/unknown-model" },
  ])
    await agent
      .post("/api/chat")
      .send(check(OPENAI, GOOGLE, { double_check: bad }))
      .expect(400);
  assert.equal(balance(s.db, user.id).total, before);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  assert.deepEqual(counts(s.db), { conversations: 0, messages: 0 });
});

test("a double-check can't be added to the reviewed conversation or run outside Symposium", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "cai");
  await agent
    .post("/api/chat")
    .send({
      model: GOOGLE,
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 50,
    })
    .expect(200);
  const source = (await agent.get("/api/conversations")).body.data[0];
  const n = counts(s.db);
  await agent
    .post("/api/chat")
    .send(check(OPENAI, GOOGLE, { conversationId: source.id }))
    .expect(400);
  await agent
    .post("/api/chat")
    .send(check(OPENAI, GOOGLE, { mode: "chat" }))
    .expect(400);
  assert.deepEqual(counts(s.db), n);
});

test("off the record and private flags carry over: nothing is stored", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "dee");
  await agent
    .post("/api/chat")
    .send(check(OPENAI, GOOGLE, { ephemeral: true }))
    .expect(200);
  assert.deepEqual(counts(s.db), { conversations: 0, messages: 0 });
  // Private: the checker must itself be a private model (same rule as any private chat).
  const notPrivate = await agent
    .post("/api/chat")
    .send(check(OPENAI, GOOGLE, { private: true }))
    .expect(400);
  assert.equal(notPrivate.body.error.code, "private_model_required");
  const r = await agent
    .post("/api/chat")
    .send(check(PRIVATE, GOOGLE, { private: true }))
    .expect(200);
  assert.match(r.text, /"stored":false/);
  assert.deepEqual(counts(s.db), { conversations: 0, messages: 0 });
});

test("gated until Double-check This (and Symposium) are released", async (t) => {
  for (const released of ["mvp", "mvp,symposium", "mvp,doublecheck"]) {
    const s = fixture(t, released);
    const { agent } = await person(s.app, "eve" + released.length);
    const r = await agent
      .post("/api/chat")
      .send(check(OPENAI, GOOGLE))
      .expect(403);
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.deepEqual(counts(s.db), { conversations: 0, messages: 0 });
  }
  const s = fixture(t, "mvp,symposium,doublecheck");
  const { agent } = await person(s.app, "fay");
  await agent
    .post("/api/chat")
    .send({
      model: GOOGLE,
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 50,
    })
    .expect(200);
  const source = (await agent.get("/api/conversations")).body.data[0];
  await agent
    .post("/api/chat")
    .send(
      check(OPENAI, GOOGLE, {
        double_check: { source_model: GOOGLE, source_conversation: source.id },
      }),
    )
    .expect(200);
  const entry = UPDATES.find((u) => u.id === "doublecheck");
  assert.equal(entry.title, "Double-check This");
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean", "release activation is explicit");
});

// --- Client helpers (src/double-check.js) ------------------------------------

test("providers normalise catalog spellings and compare makers, not model ids", () => {
  assert.equal(
    providerKey({ owned_by: "Google" }),
    providerKey({ owned_by: "google" }),
  );
  assert.equal(
    providerKey({ owned_by: "Z.ai" }),
    providerKey({ id: "z-ai/glm-5.2" }),
  );
  assert.equal(providerKey({ id: "meta-llama/llama-4-scout" }), "meta");
  assert.ok(
    sameProvider(
      { id: GOOGLE, owned_by: "Google" },
      { id: GOOGLE2, owned_by: "google" },
    ),
  );
  assert.ok(
    !sameProvider(
      { id: GOOGLE, owned_by: "Google" },
      { id: OPENAI, owned_by: "OpenAI" },
    ),
  );
  assert.ok(!sameProvider({}, {}), "unknown providers are never 'the same'");
  assert.ok(!differentProvider({}, {}), "...and never 'different' either");
});

test("checker candidates exclude the answering provider and respect private mode; none is a graceful empty list", () => {
  const models = [
    { id: "a/1", owned_by: "Anthropic", type: "chat", callable: true },
    { id: "a/2", owned_by: "anthropic", type: "chat", callable: true },
    { id: "o/1", owned_by: "OpenAI", type: "chat", callable: true },
    { id: "g/1", owned_by: "Google", type: "chat", callable: false },
    {
      id: "v/1",
      owned_by: "Venice",
      type: "chat",
      callable: true,
      private: true,
    },
    { id: "i/1", owned_by: "OpenAI", type: "image", callable: true },
  ];
  const src = models[0];
  assert.deepEqual(
    checkerCandidates(models, src).map((m) => m.id),
    ["o/1", "v/1"],
  );
  assert.deepEqual(
    checkerCandidates(models, src, { privateOnly: true }).map((m) => m.id),
    ["v/1"],
  );
  assert.deepEqual(checkerCandidates(models.slice(0, 2), src), []);
});

test("the request frames a review, not a verdict, and keeps the answer as written", () => {
  const msgs = buildCheckMessages({
    question: "Q?",
    answer: "A [NAME_1].",
    answerModel: "Model X",
  });
  assert.equal(msgs[0].role, "system");
  assert.match(msgs[0].content, /second opinion/);
  assert.match(msgs[0].content, /don't claim certainty/);
  assert.match(msgs[1].content, /Question:\nQ\?/);
  assert.match(
    msgs[1].content,
    /Answer from Model X:\nA \[NAME_1\]\./,
    "veiled tags are sent as-is, never unveiled",
  );
  assert.match(DISCLOSURE, /not fact verification/);
});

// --- Review fixes (CODEX-REVIEW.md) ------------------------------------------

test("Veil on: the question and answer are masked with the chat's map and words before the quote and the check", () => {
  // Written with Veil off, then Veil switched on before double-checking.
  const answer = {
    model: GOOGLE,
    content: "Email me at review.person@example.com about Project Nimbus.",
  };
  const original = structuredClone(answer);
  const question = "Can review.person@example.com see Project Nimbus?";
  const state = createVeilState();
  const words = ["Project Nimbus"];
  const mask = (text) => veil(text, state, words);
  const on = checkSnapshot({
    question,
    answer: answer.content,
    answerModel: "Gemini",
    mask,
    policy: "veil:" + JSON.stringify(words),
  });
  const sent = on.messages.map((m) => m.content).join("\n");
  assert.doesNotMatch(
    sent,
    /review\.person@example\.com/,
    "no raw email in the question or the answer",
  );
  assert.doesNotMatch(
    sent,
    /Project Nimbus/,
    "always-veil words are masked too",
  );
  assert.match(
    on.messages[1].content,
    /Question:\nCan \[EMAIL_1\] see \[PRIVATE_1\]\?/,
  );
  assert.match(
    on.messages[1].content,
    /Answer from Gemini:\nEmail me at \[EMAIL_1\] about \[PRIVATE_1\]\./,
    "one tag per value, shared with the chat's map",
  );
  assert.equal(on.masked, 4);
  assert.equal(
    state.map.EMAIL_1,
    "review.person@example.com",
    "the map stays in this browser to unveil the reply",
  );
  assert.deepEqual(answer, original, "the stored answer is never changed");
  // Existing tags pass through, and re-masking is stable (same snapshot key).
  assert.equal(
    checkSnapshot({
      question,
      answer: answer.content,
      answerModel: "Gemini",
      mask,
      policy: "veil:" + JSON.stringify(words),
    }).key,
    on.key,
  );
  // Veil off sends the text as written; a different policy is a different snapshot.
  const off = checkSnapshot({
    question,
    answer: answer.content,
    answerModel: "Gemini",
  });
  assert.match(off.messages[1].content, /review\.person@example\.com/);
  assert.notEqual(off.key, on.key);
  const fewerWords = checkSnapshot({
    question: "hello",
    answer: "world",
    answerModel: "Gemini",
    mask: (t) => veil(t, createVeilState(), []),
    policy: "veil:[]",
  });
  const moreWords = checkSnapshot({
    question: "hello",
    answer: "world",
    answerModel: "Gemini",
    mask: (t) => veil(t, createVeilState(), ["x"]),
    policy: 'veil:["x"]',
  });
  assert.notEqual(
    fewerWords.key,
    moreWords.key,
    "a changed word list invalidates the estimate even when nothing new matches",
  );
});

test("Ask needs a settled estimate for this exact checker and snapshot, and nothing in flight", () => {
  const good = {
    checker: OPENAI,
    snapshotKey: "k1",
    quote: { checker: OPENAI, key: "k1", credits: 3 },
    running: false,
  };
  assert.equal(canAsk(good), true);
  assert.equal(canAsk({ ...good, quote: null }), false, "still estimating");
  assert.equal(
    canAsk({ ...good, quote: { checker: OPENAI, key: "k1", error: "down" } }),
    false,
    "estimate failed",
  );
  assert.equal(
    canAsk({ ...good, quote: { checker: GOOGLE, key: "k1", credits: 3 } }),
    false,
    "estimate for another checker",
  );
  assert.equal(
    canAsk({ ...good, snapshotKey: "k2" }),
    false,
    "content or masking changed since the estimate",
  );
  assert.equal(canAsk({ ...good, running: true }), false, "already running");
  assert.equal(canAsk({ ...good, checker: "" }), false);
  assert.equal(
    canAsk({ ...good, quote: { checker: OPENAI, key: "k1", credits: 0 } }),
    true,
    "a zero estimate is still an estimate",
  );
});

test("a saved check never outlives its source conversation", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "gus");
  const expiresOfCheck = () =>
    s.db
      .prepare(
        "SELECT expires FROM conversations WHERE mode='symposium' ORDER BY rowid DESC",
      )
      .get().expires;
  await agent
    .post("/api/chat")
    .send({
      model: GOOGLE,
      messages: [{ role: "user", content: "Is 17 prime?" }],
      max_tokens: 50,
    })
    .expect(200);
  const source = (await agent.get("/api/conversations")).body.data[0];
  // The source auto-deletes in one day; the account default is Never.
  await agent
    .patch("/api/conversations/" + source.id)
    .send({ retention: 1 })
    .expect(200);
  const sourceExpires = s.db
    .prepare("SELECT expires FROM conversations WHERE id=?")
    .get(source.id).expires;
  assert.ok(sourceExpires > Date.now());
  const sourceRows = s.db
    .prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid")
    .all(source.id);
  const saved = (extra = {}) =>
    check(OPENAI, GOOGLE, {
      double_check: { source_model: GOOGLE, source_conversation: source.id },
      ...extra,
    });
  await agent.post("/api/chat").send(saved()).expect(200);
  assert.equal(
    expiresOfCheck(),
    sourceExpires,
    "the same deadline, not a fresh interval",
  );
  // A sooner account default still wins.
  await agent.put("/api/retention").send({ days: 1 }).expect(200);
  await agent
    .patch("/api/conversations/" + source.id)
    .send({ retention: 30 })
    .expect(200);
  const before = Date.now();
  await agent.post("/api/chat").send(saved()).expect(200);
  assert.ok(
    expiresOfCheck() <= before + 86400000 + 5000 &&
      expiresOfCheck() >= before + 86400000 - 5000,
  );
  // A saved check must name its source; a foreign or expired source is refused
  // before anything is reserved or stored.
  const n = counts(s.db);
  const holds = s.db.prepare("SELECT COUNT(*) n FROM holds").get().n;
  const unnamed = await agent
    .post("/api/chat")
    .send(check(OPENAI, GOOGLE))
    .expect(400);
  assert.equal(unnamed.body.error.code, "invalid_request");
  await agent
    .post("/api/chat")
    .send(
      check(OPENAI, GOOGLE, {
        double_check: { source_model: GOOGLE, source_conversation: 7 },
      }),
    )
    .expect(400);
  const other = await person(s.app, "hal");
  await other.agent.post("/api/chat").send(saved()).expect(404);
  s.db
    .prepare("UPDATE conversations SET expires=? WHERE id=?")
    .run(Date.now() - 1, source.id);
  await agent.post("/api/chat").send(saved()).expect(404);
  assert.deepEqual(counts(s.db), n);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, holds);
  assert.deepEqual(
    s.db
      .prepare("SELECT * FROM messages WHERE conversation_id=? ORDER BY rowid")
      .all(source.id),
    sourceRows,
  );
  assert.ok(balance(s.db, user.id).total > 0);
});

test("catalog aliases of one maker are the same provider; unknown makers are refused", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-doublecheck-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const catalogPath = join(dir, "models.json");
  const row = (id, owned_by) => ({
    id,
    type: "chat",
    status: "live",
    ...(owned_by ? { owned_by } : {}),
    pricing: { input_per_1M_tokens: 1, output_per_1M_tokens: 2 },
  });
  // The exact spellings the live catalog uses for xAI, plus a model with no
  // maker at all and a router that picks one per request.
  writeFileSync(
    catalogPath,
    JSON.stringify({
      updatedAt: new Date().toISOString(),
      data: [
        row("grok-4.6", "SpaceXAI"),
        row("~x-ai/grok-latest", "xAI"),
        row("gpt-6-sol", "OpenAI"),
        row("mystery-model"),
        row("auto", "PPQ.AI"),
      ],
    }),
  );
  const s = fixture(t, "all", { catalogPath });
  const { agent } = await person(s.app, "ida");
  const code = async (model, source) =>
    (
      await agent
        .post("/api/chat")
        .send(check(model, source, { ephemeral: true }))
        .expect(400)
    ).body.error.code;
  assert.equal(
    await code("~x-ai/grok-latest", "grok-4.6"),
    "double_check_same_provider",
  );
  assert.equal(
    await code("grok-4.6", "~x-ai/grok-latest"),
    "double_check_same_provider",
  );
  assert.equal(
    await code("gpt-6-sol", "mystery-model"),
    "double_check_provider_unknown",
  );
  assert.equal(
    await code("mystery-model", "grok-4.6"),
    "double_check_provider_unknown",
  );
  assert.equal(await code("auto", "grok-4.6"), "double_check_provider_unknown");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  await agent
    .post("/api/chat")
    .send(check("gpt-6-sol", "grok-4.6", { ephemeral: true }))
    .expect(200);
  // The client offers the same set.
  const listed = (await agent.get("/api/models")).body.data;
  const grok = listed.find((m) => m.id === "grok-4.6");
  assert.deepEqual(
    checkerCandidates(listed, grok).map((m) => m.id),
    ["gpt-6-sol"],
  );
  assert.deepEqual(
    checkerCandidates(
      listed,
      listed.find((m) => m.id === "mystery-model"),
    ),
    [],
    "unknown source: no checker",
  );
});

test("provider identity: aliases, id families and hosts resolve to one maker; unknown stays unknown", () => {
  const same = [
    [
      { owned_by: "SpaceXAI" },
      { owned_by: "xAI" },
      { id: "x-ai/grok-4.7" },
      { id: "grok-4.6" },
    ],
    [
      { owned_by: "Google" },
      { owned_by: "google" },
      { owned_by: "Google DeepMind" },
      { id: "gemini-3.7-flash" },
      { id: "gemma-4-31b" },
    ],
    [
      { owned_by: "MoonshotAI" },
      { owned_by: "moonshot" },
      { id: "kimi-k3-fast" },
    ],
    [
      { owned_by: "Meta" },
      { id: "meta-llama/llama-4-scout" },
      { id: "llama-3.3-70b" },
    ],
    [
      { owned_by: "Mistral" },
      { owned_by: "mistralai" },
      { id: "devstral-2512" },
      { id: "ministral-14b" },
    ],
    [
      { owned_by: "Z.ai" },
      { id: "z-ai/glm-5.3" },
      { owned_by: "Zhipu" },
      { id: "glm-5.3" },
    ],
    [{ owned_by: "Qwen" }, { owned_by: "alibaba" }, { id: "qwen3.8-max" }],
    [{ owned_by: "Anthropic" }, { id: "claude-opus-5.5" }],
    [
      { owned_by: "OpenAI" },
      { id: "gpt-6-sol" },
      { id: "private/gpt-oss-120b", owned_by: "Tinfoil" },
    ],
    [{ owned_by: "DeepSeek" }, { id: "deepseek-v4" }],
  ];
  for (const group of same) {
    const keys = new Set(group.map(providerKey));
    assert.equal(keys.size, 1, JSON.stringify(group) + " → " + [...keys]);
    assert.ok([...keys][0]);
  }
  // A host names itself for models others made: the family decides.
  assert.equal(
    providerKey({ id: "private/glm-5-3", owned_by: "Tinfoil" }),
    "zai",
  );
  assert.equal(
    providerKey({ id: "venice/gemma-4-uncensored", owned_by: "Venice" }),
    "google",
  );
  assert.equal(
    providerKey({ id: "venice/venice-uncensored-1-2", owned_by: "Venice" }),
    "venice",
  );
  assert.equal(
    providerLabel({ id: "private/glm-5-3", owned_by: "Tinfoil" }),
    "Z.ai via Tinfoil",
  );
  assert.equal(providerLabel({ id: "grok-4.6", owned_by: "SpaceXAI" }), "xAI");
  // Unknown: no maker, a router, a hidden (stealth) model, or a host with no family.
  for (const m of [
    {},
    { id: "mystery-model" },
    { id: "auto", owned_by: "PPQ.AI" },
    { id: "stealth/space-bunny-alpha", owned_by: "stealth" },
    { id: "private/unknown-7b", owned_by: "Tinfoil" },
  ])
    assert.equal(providerKey(m), "", JSON.stringify(m));
  // The live catalog's two xAI spellings were the reviewed failure.
  assert.ok(
    sameProvider(
      { id: "grok-4.6", owned_by: "SpaceXAI" },
      { id: "~x-ai/grok-latest", owned_by: "xAI" },
    ),
  );
  const models = [
    { id: "grok-4.6", owned_by: "SpaceXAI", type: "chat", callable: true },
    { id: "~x-ai/grok-latest", owned_by: "xAI", type: "chat", callable: true },
    { id: "mystery-model", type: "chat", callable: true },
    { id: "gpt-6-sol", owned_by: "OpenAI", type: "chat", callable: true },
  ];
  assert.deepEqual(
    checkerCandidates(models, models[0]).map((m) => m.id),
    ["gpt-6-sol"],
  );
});

// --- Source lifecycle: a saved check lives and dies with its source ----------

async function sourceChat(s, agent, content = "Is 17 prime?") {
  await agent
    .post("/api/chat")
    .send({
      model: GOOGLE,
      messages: [{ role: "user", content }],
      max_tokens: 50,
    })
    .expect(200);
  return s.db
    .prepare(
      "SELECT id FROM conversations WHERE mode='chat' ORDER BY rowid DESC",
    )
    .get().id;
}
async function savedCheck(s, agent, source) {
  await agent
    .post("/api/chat")
    .send(
      check(OPENAI, GOOGLE, {
        double_check: { source_model: GOOGLE, source_conversation: source },
      }),
    )
    .expect(200);
  return s.db
    .prepare(
      "SELECT id FROM conversations WHERE source_id=? ORDER BY rowid DESC",
    )
    .get(source).id;
}
const row = (s, id) =>
  s.db.prepare("SELECT * FROM conversations WHERE id=?").get(id);
const messagesOf = (s, id) =>
  s.db
    .prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?")
    .get(id).n;

test("deleting the source deletes its saved checks, and only them", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "joan");
  const source = await sourceChat(s, agent);
  const other = await sourceChat(s, agent, "Is 19 prime?");
  const a = await savedCheck(s, agent, source),
    b = await savedCheck(s, agent, source),
    kept = await savedCheck(s, agent, other);
  assert.equal(
    row(s, a).source_id,
    source,
    "the check is linked to what it reviewed",
  );
  assert.ok(messagesOf(s, a) > 0);
  await agent.delete("/api/conversations/" + source).expect(200);
  for (const id of [source, a, b]) {
    assert.equal(row(s, id), undefined);
    assert.equal(messagesOf(s, id), 0, "messages go with their conversation");
  }
  assert.ok(row(s, kept), "another source's check is untouched");
  assert.ok(row(s, other));
  // Delete-all takes the rest, checks included.
  await agent.delete("/api/conversations").expect(200);
  assert.deepEqual(counts(s.db), { conversations: 0, messages: 0 });
});

test("shortening the source's auto-delete shortens its checks; nothing extends them", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "kim");
  const source = await sourceChat(s, agent);
  const c = await savedCheck(s, agent, source);
  const expires = (id) => row(s, id).expires;
  assert.equal(
    expires(c),
    null,
    "source kept forever: so is the check (account default Never)",
  );
  const retain = (id, retention) =>
    agent
      .patch("/api/conversations/" + id)
      .send({ retention })
      .expect(200);
  await retain(source, 7);
  assert.equal(expires(c), expires(source), "shortened with the source");
  const sevenDays = expires(c);
  await retain(source, 30);
  assert.equal(
    expires(c),
    sevenDays,
    "a longer source deadline never extends the check",
  );
  await retain(source, null);
  assert.equal(
    expires(c),
    sevenDays,
    "nor does turning the source's auto-delete off",
  );
  await retain(source, 1);
  assert.equal(expires(c), expires(source));
  const oneDay = expires(c);
  // The check's own auto-delete can be shortened, never set past its source.
  await retain(c, null);
  assert.equal(expires(c), oneDay);
  await retain(c, 30);
  assert.equal(expires(c), oneDay);
  s.db
    .prepare("UPDATE conversations SET expires=? WHERE id=?")
    .run(oneDay + 86400000, c);
  assert.equal(
    expires(c),
    oneDay,
    "enforced by the schema, not only the route",
  );
  const sooner = oneDay - 3600000;
  s.db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(sooner, c);
  assert.equal(expires(c), sooner, "shortening the check itself is allowed");
  await retain(source, 30);
  await retain(c, null);
  assert.equal(expires(c), sooner, "turning off check retention cannot extend an existing deadline");
  await retain(c, 30);
  assert.equal(expires(c), sooner, "a longer check setting cannot extend its deadline");
  s.db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(sooner + 86400000, c);
  assert.equal(expires(c), sooner, "direct SQL is bounded by its own earlier deadline too");
  await retain(source, 1);
  // A check made after the source is shortened starts at the source's deadline.
  const later = await savedCheck(s, agent, source);
  assert.equal(expires(later), expires(source));
});

test("an expired source takes its checks with it at cleanup", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "lou");
  const source = await sourceChat(s, agent);
  const c = await savedCheck(s, agent, source);
  const keep = await sourceChat(s, agent, "Is 23 prime?");
  s.db
    .prepare("UPDATE conversations SET expires=? WHERE id=?")
    .run(Date.now() - 1000, source);
  assert.ok(
    row(s, c).expires <= row(s, source).expires,
    "the check expires with the source",
  );
  // Gone for reading at once, and reclaimed by the worker's cleanup.
  await agent.get("/api/conversations/" + source).expect(404);
  await agent.get("/api/conversations/" + c).expect(404);
  await s.tick();
  assert.equal(row(s, source), undefined);
  assert.equal(row(s, c), undefined);
  assert.equal(messagesOf(s, c), 0);
  assert.ok(row(s, keep));
});

test("checks follow access: no linking to others' chats, and leaving a collab removes checks of its chats", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana2");
  const ben = await person(s.app, "ben2");
  const eve = await person(s.app, "eve2");
  // Nobody can link a check to a conversation they can't read.
  const private_ = await sourceChat(s, ana.agent);
  const n = counts(s.db);
  await eve.agent
    .post("/api/chat")
    .send(
      check(OPENAI, GOOGLE, {
        double_check: { source_model: GOOGLE, source_conversation: private_ },
      }),
    )
    .expect(404);
  assert.deepEqual(counts(s.db), n);
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM holds WHERE user_id=?")
      .get(eve.user.id).n,
    0,
  );
  // A second opinion can't be the source of another.
  const first = await savedCheck(s, ana.agent, private_);
  await ana.agent
    .post("/api/chat")
    .send(
      check(OPENAI, GOOGLE, {
        double_check: { source_model: GOOGLE, source_conversation: first },
      }),
    )
    .expect(400);
  // Shared conversation: Ben checks it as a member.
  const { id } = (
    await ana.agent.post("/api/collabs").send({ name: "Team" }).expect(201)
  ).body;
  const invite = (
    await ana.agent.post(`/api/collabs/${id}/invite`).send({}).expect(200)
  ).body;
  await ben.agent
    .post("/api/collabs/join")
    .send({ token: invite.token })
    .expect(200);
  const shared = (
    await ben.agent
      .post(`/api/collabs/${id}/conversations`)
      .send({ title: "Shared" })
      .expect(201)
  ).body.id;
  await ben.agent
    .post("/api/chat")
    .send({
      model: GOOGLE,
      conversationId: shared,
      messages: [{ role: "user", content: "Is 29 prime?" }],
      max_tokens: 50,
    })
    .expect(200);
  const bensShared = await savedCheck(s, ben.agent, shared);
  const anasShared = await savedCheck(s, ana.agent, shared);
  const bensOwn = await savedCheck(
    s,
    ben.agent,
    await sourceChat(s, ben.agent, "Is 31 prime?"),
  );
  // The collab owner shortening the shared chat shortens every member's check.
  await ana.agent
    .patch("/api/conversations/" + shared)
    .send({ retention: 7 })
    .expect(200);
  assert.equal(row(s, bensShared).expires, row(s, shared).expires);
  // Ben leaves: his copy of the shared chat goes with his access; his own
  // checks and the owner's check stay.
  await ben.agent.delete(`/api/collabs/${id}/members/ben2`).expect(200);
  await ben.agent.get("/api/conversations/" + shared).expect(404);
  assert.equal(row(s, bensShared), undefined);
  assert.equal(messagesOf(s, bensShared), 0);
  assert.ok(row(s, bensOwn));
  assert.ok(row(s, anasShared));
  // Deleting the collab deletes its conversations and their checks.
  await ana.agent.delete("/api/collabs/" + id).expect(200);
  assert.equal(row(s, shared), undefined);
  assert.equal(row(s, anasShared), undefined);
  assert.ok(row(s, first), "unrelated checks stay");
});
