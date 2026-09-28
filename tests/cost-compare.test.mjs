import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { addCredit, balance } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import { MAX_COMPARE_MODELS } from "../server/routes/cost-compare.js";
import { chatLimits } from "../data/chat-limits.js";
import { buildChatRequest, quoteBody, REPLY_BUDGET } from "../src/estimate.js";
import { factsToSend } from "../src/memory.js";
import { pickPreset, PRESETS } from "../src/model-finder.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  MAX_COMPARE,
  MAX_PICKED,
  REFUSALS,
  ROLE_LABELS,
  addable,
  compareBody,
  comparePresets,
  compareRows,
  compareSet,
  contextLabel,
  differenceLabel,
  overLabel,
  refusalText,
  relativeLabel,
} from "../src/cost-compare.js";

// Cost Compare: the message being written, priced on several models with
// the same quote as /api/quote and Send, under the model picker's rules, and
// never reserving, charging or storing anything. Server tests use isolated
// test-mode databases.
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-compare-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: "all",
    ...overrides,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(s, username = "comparer") {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
// Pins an update's committed `released` flag for one test.
function pin(t, id, released) {
  const u = UPDATES.find((x) => x.id === id);
  const was = u.released;
  u.released = released;
  t.after(() => (u.released = was));
}
const units = (credits) => Math.round(credits * 10000);
const CURRENT = "google/gemini-2.5-flash";
const MODELS = [
  CURRENT,
  "claude-sonnet-5",
  "glm-5.3",
  "gpt-5.4-mini",
  "deepseek/deepseek-v4.1-flash",
];
// A 4,095-token context: a long message doesn't fit, and its reply budget
// is capped at 3,839 tokens (chatLimits).
const SMALL = "openai/gpt-3.5-turbo-0613";
const UNCENSORED = "venice/venice-uncensored-1-2";
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// A realistic request, built exactly as the composer builds it.
function composed(
  text = "Summarize our plan in three bullet points",
  extra = {},
) {
  return buildChatRequest({
    messages: [
      { role: "user", content: "Earlier question about the launch" },
      { role: "assistant", content: "Earlier answer with some detail." },
    ],
    text,
    instructions: "Answer briefly and in British English.",
    documents: [
      {
        name: "notes.txt",
        text: "Launch notes: ship Tuesday, budget 40k.",
        chars: 40,
      },
    ],
    preserveHistory: true,
    ...extra,
  }).request;
}
const compare = (agent, body) => agent.post("/api/estimate/compare").send(body);
const baseBody = (request, extra = {}) =>
  compareBody(quoteBody({ model: CURRENT, request, ...extra }), {
    models: MODELS,
    mode: "chat",
    replyBudget: 8192,
  });

test("every model is priced exactly as /api/quote prices it, at the budget Send would ask for", async (t) => {
  // A markup makes the rate factor matter.
  const s = fixture(t, { markup: 12 });
  const { agent } = await person(s);
  const catalog = JSON.parse(
    readFileSync(
      new URL("../data/models.snapshot.json", import.meta.url),
      "utf8",
    ),
  );
  for (const [webSearch, request, models] of [
    [false, composed(), MODELS],
    [true, composed(), MODELS],
    // Short enough for the small model's 4,095-token context.
    [false, [{ role: "user", content: "Say hi" }], [...MODELS, SMALL]],
  ]) {
    const body = baseBody(request, { webSearch });
    body.models = models;
    const r = await compare(agent, body).expect(200);
    assert.equal(r.body.estimate, true);
    assert.equal(r.body.current, CURRENT);
    assert.equal(r.body.web_search, webSearch);
    assert.equal(r.body.results.length, body.models.length);
    for (const result of r.body.results) {
      assert.equal(result.status, "ok", result.model);
      // Send asks each model for the chosen budget, up to its own limit.
      const row = catalog.data.find((x) => x.id === result.model);
      const budget = Math.min(8192, chatLimits(row).maxOutputTokens);
      assert.equal(result.reply_budget, budget, result.model);
      const q = await agent
        .post("/api/quote")
        .send(
          quoteBody({
            model: result.model,
            request,
            webSearch,
            maxTokens: budget,
          }),
        )
        .expect(200);
      assert.equal(
        result.credits,
        q.body.credits,
        `parity for ${result.model} (web ${webSearch})`,
      );
      assert.equal(result.usd, q.body.usd);
      assert.equal(r.body.available, q.body.available);
    }
  }
  // The small-context model got a smaller reply budget, as Send would give it.
  const short = {
    ...baseBody([{ role: "user", content: "Say hi" }]),
    models: [CURRENT, SMALL],
  };
  assert.equal(
    (await compare(agent, short).expect(200)).body.results[1].reply_budget,
    3839,
  );
});

test("the model in use is priced as the chip prices it, and Send holds exactly that", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s);
  const request = composed();
  const chip = quoteBody({ model: CURRENT, request, maxTokens: 8192 });
  const q = await agent.post("/api/quote").send(chip).expect(200);
  const r = await compare(agent, baseBody(request)).expect(200);
  assert.equal(r.body.results[0].credits, q.body.credits);
  await agent
    .post("/api/chat")
    .send({ ...chip, requestId: "compare-send", ephemeral: true })
    .expect(200);
  const held = await agent.get("/api/requests/compare-send").expect(200);
  assert.equal(
    units(held.body.reserved),
    Math.ceil(units(r.body.results[0].credits) * s.cfg.holdMargin),
  );
});

test("differences are exact whole-unit subtractions from the model in use", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s);
  const r = await compare(agent, baseBody(composed())).expect(200);
  const [base, ...others] = r.body.results;
  assert.equal(base.difference, 0);
  for (const o of others)
    assert.equal(
      units(o.difference),
      units(o.credits) - units(base.credits),
      o.model,
    );
  assert.ok(
    others.some((o) => o.difference > 0) &&
      others.some((o) => o.difference < 0),
  );
  // With the model in use refused, there's nothing to subtract from.
  const long = baseBody(composed("x ".repeat(9000)));
  long.models = [SMALL, CURRENT];
  const r2 = await compare(agent, long).expect(200);
  assert.equal(r2.body.results[0].status, "refused");
  assert.equal(r2.body.results[1].status, "ok");
  assert.equal(r2.body.results[1].difference, null);
});

test("comparing reserves, charges and stores nothing", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s);
  const before = balance(s.db, user.id);
  const ledger = s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n;
  for (let i = 0; i < 4; i++)
    await compare(agent, baseBody(composed("Draft " + i))).expect(200);
  assert.deepEqual(balance(s.db, user.id), before);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger").get().n, ledger);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
});

test("a message too long for a model is flagged with its numbers, not priced", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s);
  const request = composed("word ".repeat(4000));
  const body = baseBody(request);
  body.models = [CURRENT, SMALL];
  const r = await compare(agent, body).expect(200);
  const [fits, tooLong] = r.body.results;
  assert.equal(fits.status, "ok");
  assert.equal(fits.context.fits, true);
  assert.ok(fits.context.allowance >= 1_000_000);
  assert.equal(tooLong.status, "refused");
  assert.equal(tooLong.code, "context_limit_exceeded");
  assert.equal(tooLong.credits, undefined);
  assert.equal(tooLong.context.fits, false);
  assert.equal(tooLong.context.allowance, 4095);
  assert.equal(tooLong.context.reply_budget, 3839);
  assert.equal(
    tooLong.context.input_tokens_estimate,
    fits.context.input_tokens_estimate,
  );
  // Send (and its quote) would refuse this model for the same reason.
  const q = await agent
    .post("/api/quote")
    .send(quoteBody({ model: SMALL, request, maxTokens: 3839 }))
    .expect(400);
  assert.equal(q.body.error.code, "context_limit_exceeded");
});

test("images need a model that can read them", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s);
  const request = buildChatRequest({
    text: "What is in this picture?",
    attachments: [{ url: PNG }],
  }).request;
  const body = baseBody(request);
  body.models = [CURRENT, "glm-5.3"];
  const r = await compare(agent, body).expect(200);
  assert.equal(r.body.results[0].status, "ok");
  assert.deepEqual(
    { status: r.body.results[1].status, code: r.body.results[1].code },
    { status: "refused", code: "vision_required" },
  );
  const q = await agent
    .post("/api/quote")
    .send(quoteBody({ model: CURRENT, request, maxTokens: 8192 }))
    .expect(200);
  assert.equal(r.body.results[0].credits, q.body.credits);
  // The same model refuses the image at Send.
  await agent
    .post("/api/quote")
    .send(quoteBody({ model: "glm-5.3", request }))
    .expect(400);
});

test("Private mode prices only zero-data-retention models, and never with memory", async (t) => {
  const s = fixture(t, { privateModels: [CURRENT] });
  const { agent } = await person(s);
  await agent.put("/api/memory/settings").send({ enabled: true }).expect(200);
  const fact = (
    await agent
      .post("/api/memory/facts")
      .send({ text: "I prefer metric units." })
      .expect(201)
  ).body;
  const memory = factsToSend([fact]);
  const request = composed();
  const body = {
    ...baseBody(request),
    models: [CURRENT, "claude-sonnet-5"],
    private: true,
    memory,
  };
  const r = await compare(agent, body).expect(200);
  assert.equal(r.body.results[0].status, "ok");
  assert.equal(r.body.results[1].code, "private_model_required");
  assert.deepEqual(r.body.memory, { used: 0, skipped: 1 });
  // Priced like a plain request: Private Mode never adds memory.
  const q = await agent
    .post("/api/quote")
    .send(quoteBody({ model: CURRENT, request, maxTokens: 8192 }))
    .expect(200);
  assert.equal(r.body.results[0].credits, q.body.credits);
  // Outside Private mode the same memory is priced in, as Send adds it.
  const open = await compare(agent, {
    ...body,
    private: false,
    models: [CURRENT],
  }).expect(200);
  assert.deepEqual(open.body.memory, { used: 1, skipped: 0 });
  const withMemory = await agent
    .post("/api/quote")
    .send(
      quoteBody({
        model: CURRENT,
        request,
        maxTokens: 8192,
        memory,
        mode: "chat",
      }),
    )
    .expect(200);
  assert.equal(open.body.results[0].credits, withMemory.body.credits);
  assert.ok(open.body.results[0].credits > r.body.results[0].credits);
});

test("Uncensored and the other sections keep their own models, as the picker does", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s);
  const request = composed();
  const uncensored = await compare(agent, {
    ...baseBody(request),
    mode: "uncensored",
    models: [UNCENSORED, CURRENT],
  }).expect(200);
  assert.equal(uncensored.body.results[0].status, "ok");
  assert.equal(uncensored.body.results[1].code, "other_section");
  const q = await agent
    .post("/api/quote")
    .send(quoteBody({ model: UNCENSORED, request, maxTokens: 8192 }))
    .expect(200);
  assert.equal(uncensored.body.results[0].credits, q.body.credits);
  for (const mode of ["chat", "code"]) {
    const r = await compare(agent, {
      ...baseBody(request),
      mode,
      models: [CURRENT, UNCENSORED],
    }).expect(200);
    assert.equal(r.body.results[1].code, "other_section", mode);
  }
});

test("unknown, unavailable and non-chat models are refused one by one", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s);
  const body = {
    ...baseBody(composed()),
    models: [CURRENT, "no/such-model", "gpt-image-1"],
  };
  const r = await compare(agent, body).expect(200);
  assert.equal(r.body.results[0].status, "ok");
  assert.equal(r.body.results[1].code, "model_not_found");
  assert.equal(r.body.results[2].status, "refused");
  assert.ok(
    ["unsupported_model", "model_unavailable"].includes(r.body.results[2].code),
  );
});

test("the request is checked as a whole: model list, cap, mode, budget and message", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s);
  const good = baseBody(composed());
  const refuse = async (body, code = "invalid_request") => {
    const r = await compare(agent, body).expect(400);
    assert.equal(r.body.error.code, code, JSON.stringify(body).slice(0, 80));
  };
  assert.equal(
    MAX_COMPARE_MODELS,
    MAX_COMPARE,
    "the browser and the server share the cap",
  );
  const nine = Array.from(
    { length: MAX_COMPARE_MODELS + 1 },
    (_, i) => "model-" + i,
  );
  await refuse({ ...good, models: nine }, "compare_limit");
  await refuse({ ...good, models: [] });
  await refuse({ ...good, models: "claude-sonnet-5" });
  await refuse({ ...good, models: [CURRENT, CURRENT] });
  await refuse({ ...good, models: [CURRENT, 7] });
  await refuse({ ...good, mode: "symposium" });
  await refuse({ ...good, private: "yes" });
  await refuse({ ...good, max_tokens: 0 });
  await refuse({ ...good, max_tokens: 1.5 });
  await refuse({ ...good, messages: [] });
  await refuse({ ...good, messages: [{ role: "tool", content: "x" }] });
  // Exactly the cap is fine.
  const eight = [
    ...MODELS,
    "claude-haiku-4.5",
    "gemini-3.7-flash",
    "grok-4.6",
  ].slice(0, MAX_COMPARE_MODELS);
  const r = await compare(agent, { ...good, models: eight }).expect(200);
  assert.equal(r.body.results.length, MAX_COMPARE_MODELS);
  // Signed out.
  await request(s.app).post("/api/estimate/compare").send(good).expect(401);
});

test("comparisons are rate limited per account, and the limit is an error, not a price", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s);
  const body = {
    ...baseBody([{ role: "user", content: "hi" }]),
    models: [CURRENT, "glm-5.3"],
  };
  for (let i = 0; i < 30; i++) await compare(agent, body).expect(200);
  const r = await compare(agent, body).expect(429);
  assert.equal(r.body.results, undefined);
  const other = await person(s, "second");
  await compare(other.agent, body).expect(200);
});

test("balance and spending-limit room come back with the estimates", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s);
  addCredit(s.db, user.id, 50_000_000, "compare-fund");
  const r = await compare(agent, baseBody(composed())).expect(200);
  assert.equal(
    r.body.available,
    (
      await agent
        .post("/api/quote")
        .send(quoteBody({ model: CURRENT, request: composed() }))
    ).body.available,
  );
  await agent
    .patch("/api/spending-limits")
    .send({ daily_limit: 1 })
    .expect(200);
  const limited = await compare(agent, baseBody(composed())).expect(200);
  assert.ok(limited.body.spending_limit.remaining <= 1);
});

test("unreleased, Cost Compare is refused and unlisted; body-dependent gates follow the chat's", async (t) => {
  pin(t, "costcompare", false);
  const closed = fixture(t, { released: "mvp" });
  const a = await person(closed);
  const r = await compare(a.agent, baseBody(composed())).expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.match(r.body.error.message, /Cost Compare is coming soon/);
  const spec = (await request(closed.app).get("/api/openapi.json").expect(200))
    .body;
  assert.equal(spec.paths["/api/estimate/compare"], undefined);
  assert.equal(spec["x-anonyma-releases"].features.costcompare, false);

  // Released: listed, and it needs Credit Estimates too.
  const open = fixture(t, { released: "mvp,costcompare" });
  const listed = (await request(open.app).get("/api/openapi.json").expect(200))
    .body;
  assert.ok(listed.paths["/api/estimate/compare"].post);
  const b = await person(open, "gated");
  await compare(b.agent, baseBody(composed())).expect(200);
  pin(t, "estimates", false);
  await compare(b.agent, baseBody(composed())).expect(403);
});

test("Private mode and memory in a comparison need their own updates released", async (t) => {
  const s = fixture(t, { released: "mvp,costcompare,estimates" });
  const { agent } = await person(s);
  pin(t, "private", false);
  pin(t, "memory", false);
  pin(t, "uncensored", false);
  const good = baseBody(composed());
  await compare(agent, good).expect(200);
  for (const extra of [
    { private: true },
    { memory: [] },
    { mode: "uncensored" },
  ]) {
    const r = await compare(agent, { ...good, ...extra }).expect(403);
    assert.equal(
      r.body.error.code,
      "feature_unreleased",
      JSON.stringify(extra),
    );
  }
});

// ---- The browser side ----

const model = (id, input, output, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  type: "chat",
  provider: "Lab",
  callable: true,
  popular: true,
  pricing: { input_per_1M_tokens: input, output_per_1M_tokens: output },
  ...extra,
});
const POOL = [
  model("tiny", 0.1, 0.4),
  model("mid", 1, 4, { vision: true }),
  model("upper", 3, 15, { private: true }),
  model("top", 15, 75, { vision: true, private: true }),
];

test("the comparison set: the model in use, then presets, then picks, each once and capped", () => {
  const presets = [
    { id: "cheap", model: POOL[0] },
    { id: "balanced", model: POOL[1] },
    { id: "best", model: null },
  ];
  const set = compareSet({ current: "mid", presets, picked: ["top", "tiny"] });
  assert.deepEqual(set, [
    { id: "mid", roles: ["current", "balanced"] },
    { id: "tiny", roles: ["cheap", "picked"] },
    { id: "top", roles: ["picked"] },
  ]);
  const many = compareSet({
    current: "a",
    presets: [
      { id: "cheap", model: { id: "b" } },
      { id: "balanced", model: { id: "c" } },
      { id: "best", model: { id: "d" } },
    ],
    picked: ["e", "f", "g", "h", "i", "j"],
  });
  assert.equal(many.length, MAX_COMPARE);
  assert.deepEqual(
    many.map((r) => r.id),
    ["a", "b", "c", "d", "e", "f", "g", "h"],
  );
  assert.ok(
    MAX_PICKED + 4 <= MAX_COMPARE,
    "current, three presets and every pick fit",
  );
  assert.deepEqual(
    compareSet({ current: undefined, presets: [], picked: [] }),
    [],
  );
  // Search results that can still be added.
  assert.deepEqual(
    addable(POOL, set, ["top"]).map((m) => m.id),
    ["upper"],
  );
  assert.deepEqual(addable(POOL, set, ["a", "b", "c", "d"]), []);
});

test("presets are the picker's own, with the picker's Private and image rules", () => {
  for (const opts of [
    { mode: "chat" },
    { mode: "chat", privateMode: true },
    { mode: "chat", needsVision: true },
  ]) {
    const pool = POOL.filter(
      (m) =>
        (!opts.privateMode || m.private) && (!opts.needsVision || m.vision),
    );
    const presets = comparePresets(pool, opts);
    assert.deepEqual(
      presets.map((p) => p.id),
      PRESETS.map((p) => p.id),
    );
    for (const p of presets)
      assert.equal(
        p.model,
        pickPreset(pool, p.id, opts),
        `${p.id} ${JSON.stringify(opts)}`,
      );
    if (opts.privateMode)
      assert.ok(presets.every((p) => !p.model || p.model.private));
  }
  assert.deepEqual(comparePresets(POOL, { mode: "chat" }, false), []);
});

test("the request is the chip's quote body with the chosen budget, mode and Private mode", () => {
  const request = composed();
  const chip = quoteBody({
    model: CURRENT,
    request,
    webSearch: true,
    maxTokens: 4096,
  });
  const body = compareBody(chip, {
    models: ["a", "b"],
    mode: "code",
    replyBudget: 16384,
    privateMode: true,
  });
  assert.deepEqual(Object.keys(body).sort(), [
    "max_tokens",
    "messages",
    "mode",
    "models",
    "private",
    "web_search",
  ]);
  assert.equal(
    body.messages,
    chip.messages,
    "the very request the chip priced",
  );
  assert.equal(body.max_tokens, 16384);
  assert.equal(chip.model, CURRENT, "the chip's body is left alone");
  // Nothing that would reserve, save or send.
  for (const k of ["requestId", "ephemeral", "conversationId", "model"])
    assert.equal(body[k], undefined);
  assert.equal(compareBody(null, { models: ["a"] }), null);
  assert.equal(compareBody(chip, { models: [] }), null);
  const plain = compareBody(quoteBody({ model: CURRENT, request }), {
    models: ["a"],
  });
  assert.equal(plain.max_tokens, REPLY_BUDGET);
  assert.equal(plain.private, undefined);
  assert.equal(plain.mode, "chat");
});

test("rows read in order, and every label says exactly what the server said", () => {
  const set = [
    { id: "c", roles: ["current"] },
    { id: "x", roles: ["picked"] },
    { id: "a", roles: ["cheap"] },
    { id: "b", roles: ["best"] },
  ];
  const response = {
    available: 20,
    results: [
      { model: "c", status: "ok", credits: 10, difference: 0 },
      { model: "x", status: "refused", code: "context_limit_exceeded" },
      { model: "a", status: "ok", credits: 2.5, difference: -7.5 },
      { model: "b", status: "ok", credits: 32, difference: 22 },
    ],
  };
  assert.deepEqual(
    compareRows(response, set).map((r) => r.id),
    ["c", "a", "b", "x"],
  );
  assert.deepEqual(differenceLabel(response.results[2]), {
    text: "−7.5 credits",
    tone: "cheaper",
  });
  assert.deepEqual(differenceLabel(response.results[3]), {
    text: "+22 credits",
    tone: "dearer",
  });
  assert.deepEqual(differenceLabel(response.results[0]), {
    text: "Same price",
    tone: "same",
  });
  assert.equal(differenceLabel(response.results[1]), null);
  assert.equal(
    differenceLabel({ status: "ok", credits: 1, difference: null }),
    null,
  );
  assert.equal(relativeLabel(2.5, 10), "75% less");
  assert.equal(relativeLabel(13, 10), "30% more");
  assert.equal(relativeLabel(32, 10), "3.2× the price");
  assert.equal(
    relativeLabel(0.0456, 10),
    "99% less",
    "never 100% less unless it's free",
  );
  assert.equal(relativeLabel(0, 10), "100% less");
  assert.equal(relativeLabel(10, 10), null);
  assert.equal(relativeLabel(5, 0), null);
  assert.equal(overLabel(response.results[3], response), "over your balance");
  assert.equal(
    overLabel(response.results[2], {
      ...response,
      spending_limit: { remaining: 1 },
    }),
    "over your spending limit",
  );
  assert.equal(overLabel(response.results[2], response), null);
  assert.equal(refusalText("vision_required"), REFUSALS.vision_required);
  assert.equal(
    refusalText("something_new"),
    "Can't be priced for this message",
  );
  assert.equal(
    contextLabel({
      input_tokens_estimate: 36016,
      reply_budget: 3839,
      allowance: 4095,
    }),
    "≈36,016 input + 3,839 reply tokens; allowance 4,095",
  );
});

// ---- 中文 ----

const zh = () =>
  compileDictionary(
    JSON.parse(
      readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"),
    ),
  );
const han = /\p{Script=Han}/u;

test("the Chinese dictionary covers the update and every Cost Compare string", () => {
  const dict = zh();
  const entry = UPDATES.find((u) => u.id === "costcompare");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Cost Compare is coming soon.",
    "Compare",
    "Compare this message's cost on other models",
    "This message, priced on other models before you send it.",
    "Web search fee included.",
    "Type a message to compare what it would cost.",
    "Estimates by model",
    "Pricing this message…",
    "Estimates are unavailable right now.",
    "Try again",
    "Now using Claude Sonnet 5. Nothing was sent.",
    "Add a model to compare",
    "Search by name, provider or feature",
    "You can add up to 4 models.",
    "Models to add",
    "No other model here matches that search.",
    "Private mode: zero-data-retention models only.",
    "Showing models that can read your images.",
    "Close",
    "Estimates, not final charges: each model is priced by the same quote as Send, with the reply budget Send would give it. Actual usage and the amount held can differ. Comparing sends and charges nothing.",
    "Compare up to 8 models at a time.",
    "List each model once.",
    ...Object.values(ROLE_LABELS),
    ...Object.values(REFUSALS),
    refusalText("unknown"),
  ])
    assert.match(translateText(text, dict) ?? "", han, text);
});

// CostCompare.jsx compiled for Node with the same esbuild Vite uses; the
// icon set is swapped for a stand-in so only the panel's own text renders.
async function panelModule() {
  const src = new URL("../src/CostCompare.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(
    readFileSync(src, "utf8"),
    src.pathname,
    {
      jsx: "transform",
      format: "esm",
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "anonyma-compare-ui-"));
  const react = import.meta.resolve("react");
  writeFileSync(join(dir, "ui.mjs"), `export const Icon = () => null;`);
  const out = code
    .replace(/^import "\.\/cost-compare\.css";$/m, "")
    .replace(
      /from "\.\/ui\.jsx"/g,
      `from "${pathToFileURL(join(dir, "ui.mjs")).href}"`,
    )
    .replace(
      /from "\.\/(lib|estimate|model-finder|cost-compare|early-models)\.js"/g,
      (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`,
    )
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "CostCompare.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("each row keeps model names as written and translates everything else", async () => {
  const dict = zh();
  const { CompareRow } = await panelModule();
  const response = {
    available: 30,
    spending_limit: { remaining: 25 },
    results: [
      {
        model: "cur",
        status: "ok",
        credits: 10,
        difference: 0,
        reply_budget: 8192,
      },
      {
        model: "cheap",
        status: "ok",
        credits: 2.5,
        difference: -7.5,
        reply_budget: 8192,
      },
      {
        model: "dear",
        status: "ok",
        credits: 26,
        difference: 16,
        reply_budget: 3839,
      },
      {
        model: "over",
        status: "ok",
        credits: 40,
        difference: 30,
        reply_budget: 8192,
      },
      {
        model: "long",
        status: "refused",
        code: "context_limit_exceeded",
        reply_budget: 3839,
        context: {
          input_tokens_estimate: 36016,
          reply_budget: 3839,
          allowance: 4095,
          fits: false,
        },
      },
      ...Object.keys(REFUSALS)
        .filter((c) => c !== "context_limit_exceeded")
        .map((code) => ({ model: code, status: "refused", code })),
    ],
  };
  const roles = {
    cur: ["current", "balanced"],
    cheap: ["cheap"],
    dear: ["best", "picked"],
    over: ["picked"],
  };
  const html = response.results
    .map((result) =>
      renderToStaticMarkup(
        createElement(CompareRow, {
          row: {
            id: result.model,
            roles: roles[result.model] || ["picked"],
            result,
          },
          response,
          replyBudget: 8192,
          name: "Model " + result.model.toUpperCase(),
          model: { vision: true, private: result.model === "cur" },
          onUse() {},
          onRemove() {},
        }),
      ),
    )
    .join("");
  // Loading and failed rows show no number at all.
  const waiting = renderToStaticMarkup(
    createElement(CompareRow, {
      row: { id: "w", roles: ["picked"], result: null },
      name: "Waiting",
      replyBudget: 8192,
    }),
  );
  assert.doesNotMatch(waiting, /credits/);
  const texts = [];
  for (const [, attr] of html.matchAll(/(?:aria-label|title)="([^"]*)"/g))
    texts.push(attr);
  const page = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g))
    if (text?.trim()) page.push(text.trim());
  const decode = (s) =>
    s
      .replace(/&#x27;/g, "'")
      .replace(/&quot;/g, '"')
      .replace(/&amp;/g, "&");
  // Model names sit in data-i18n="off" spans.
  assert.equal(
    (html.match(/<span class="cc-name" data-i18n="off">Model /g) || []).length,
    response.results.length,
  );
  for (const raw of [...texts, ...page].map(decode)) {
    if (!/[A-Za-z]{2}/.test(raw) || raw.startsWith("Model ")) continue;
    assert.match(translateText(raw, dict) ?? "", han, `untranslated: ${raw}`);
  }
  // Separate runs the translator sees as one (differences and ratios).
  for (const text of [
    "+16 credits",
    "−7.5 credits",
    "≈2.5 credits",
    "75% less",
    "2.6× the price",
    "Use Model DEAR",
    "Remove Model DEAR from the comparison",
    "Reply budget 3,839 tokens",
  ])
    assert.match(translateText(text, dict) ?? "", han, text);
});
