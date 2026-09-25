import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  calculate,
  returnedSources,
  taskMessages,
  appendAlternative,
  taskEvent,
  completeTask,
} from "../src/task-tools.js";
import { validateTaskRequest } from "../server/task-tools.js";
import { createApp } from "../server/app.js";
import { UPDATES } from "../server/releases.js";
import { knownPage } from "../src/site-routes.js";
import { createServer } from "node:http";
import { addCredit, balance } from "../server/core.js";

test("calculator respects arithmetic precedence, signed powers, scientific notation and remainder", () => {
  for (const [s, n] of [
    ["(120 + 80) * 15 / 100", 30],
    ["2^3^2", 512],
    ["-2^2", -4],
    ["(-2)^2", 4],
    ["2^-2", 0.25],
    ["1e-3 + .004", 0.005],
    ["10%3", 1],
    ["-0", 0],
  ])
    assert.equal(calculate(s), n, s);
  assert.equal(
    calculate("0.1+0.2"),
    0.1 + 0.2,
    "floating-point results are not presented as exact decimal arithmetic",
  );
});
test("calculator refuses executable input, malformed syntax and complexity abuse", () => {
  for (const s of [
    "globalThis.process.exit()",
    "1;alert(1)",
    "constructor.constructor('return 1')()",
    "Math.sqrt(4)",
    "[1][0]",
    "1/*x*/+2",
    "2(3)",
    "1 2",
    "1e",
    ".",
    "()",
    "(1+2",
    "1+",
    "1,000",
    "(".repeat(17) + "1" + ")".repeat(17),
    "-".repeat(17) + "1",
    "1+".repeat(130) + "1",
  ])
    assert.throws(() => calculate(s), undefined, s);
});
test("calculator rejects undefined, overflow, unsafe integer and underflow results", () => {
  for (const s of [
    "1/0",
    "1%0",
    "0^0",
    "0^-1",
    "(-1)^.5",
    "2^53",
    "9007199254740992",
    "1e400",
    "1e-400",
    "1e-200*1e-200",
    "2^1025",
  ])
    assert.throws(() => calculate(s), undefined, s);
  assert.equal(calculate("9007199254740991"), Number.MAX_SAFE_INTEGER);
  assert.equal(calculate("0*5"), 0);
});
test("research sources use only valid returned metadata and never model prose", () => {
  assert.deepEqual(returnedSources(undefined), []);
  assert.deepEqual(returnedSources("See https://fabricated.example"), []);
  const credentialUrl = new URL("https://example.org");
  credentialUrl.username = "fixture";
  const sources = returnedSources([
    { url: "https://example.org/paper", title: "A real returned title" },
    { url: "https://example.org/paper", title: "duplicate" },
    { url: "javascript:alert(1)" },
    { url: "data:text/html,x" },
    { url: credentialUrl.href },
    { url: "not a URL" },
    { url: "https://other.example/path" },
  ]);
  assert.deepEqual(sources, [
    { url: "https://example.org/paper", title: "A real returned title" },
    { url: "https://other.example/path", title: "other.example" },
  ]);
  assert.equal(
    returnedSources(
      Array.from({ length: 30 }, (_, i) => ({
        url: `https://example.org/${i}`,
      })),
    ).length,
    12,
  );
});
test("writing alternatives are appended without overwriting original versions", () => {
  const first = Object.freeze({ id: "a", text: "original" }),
    list = Object.freeze([first]);
  const next = appendAlternative(list, { id: "b", text: "new" });
  assert.deepEqual(list, [first]);
  assert.equal(next[0], first);
  assert.equal(next.length, 2);
  assert.throws(() => appendAlternative(next, { id: "a" }));
  assert.throws(() =>
    appendAlternative(
      Array.from({ length: 8 }, (_, i) => ({ id: String(i) })),
      { id: "n" },
    ),
  );
});
test("task briefs are bounded and server markers cannot append to an existing conversation", () => {
  assert.equal(knownPage("/workspace/tools"), true);
  assert.throws(() => taskMessages("research", " "));
  assert.throws(() => taskMessages("writing", "x".repeat(10001)));
  assert.throws(() => taskMessages("writing", "hello", "arbitrary direction"));
  const body = {
    taskTool: "research",
    mode: "chat",
    web_search: true,
    messages: taskMessages("research", "A question"),
  };
  assert.doesNotThrow(() => validateTaskRequest(body));
  assert.doesNotThrow(() => validateTaskRequest({}));
  for (const change of [
    { taskTool: "code" },
    { conversationId: "other" },
    { mode: "code" },
    { web_search: false },
    { messages: [{ role: "user", content: "hello" }] },
    {
      messages: [
        body.messages[0],
        { role: "user", content: "x".repeat(10001) },
      ],
    },
  ])
    assert.throws(() => validateTaskRequest({ ...body, ...change }));
});
test("streamed results bind sources to final metadata and preserve previous or partial output", () => {
  const original = Object.freeze({
    text: "Original alternative",
    sources: [],
    receipt: { credits_charged: 1 },
  });
  let result = { text: "", sources: [], receipt: null };
  result = taskEvent(result, {
    choices: [
      { delta: { content: "A link in prose: https://invented.example/" } },
    ],
  });
  assert.deepEqual(result.sources, []);
  assert.throws(() => completeTask(result));
  const partial = result;
  const failed = taskEvent(result, {
    error: { message: "Provider unavailable" },
  });
  assert.equal(failed.status, "failed");
  assert.equal(
    failed.receipt,
    null,
    "No terminal receipt means charge is unknown",
  );
  assert.throws(() => completeTask(failed), /Provider unavailable/);
  assert.equal(result, partial);
  result = taskEvent(result, {
    anonyma: {
      credits_charged: 0.75,
      citations: [
        { url: "https://returned.example/source", title: "Returned source" },
      ],
    },
    conversationId: "c_test",
  });
  assert.equal(completeTask(result).status, "complete");
  assert.equal(result.sources[0].url, "https://returned.example/source");
  assert.equal(result.conversationId, "c_test");
  assert.equal(original.text, "Original alternative");
  assert.deepEqual(
    taskEvent(
      { text: "answer", sources: [], receipt: null },
      { anonyma: { credits_charged: 1 } },
    ).sources,
    [],
  );
  assert.match(
    taskEvent(
      { text: "x".repeat(100000) },
      { choices: [{ delta: { content: "overflow" } }] },
    ).error,
    /display limit/,
  );
});
test("failed terminal events retain settled charge, saved chat and local Veil map", () => {
  const previous = Object.freeze({
    text: "Partial answer for [EMAIL_1]",
    sources: [],
    receipt: null,
    conversationId: null,
    map: Object.freeze({ EMAIL_1: "reader@example.invalid" }),
  });
  for (const credits of [0, 2.5]) {
    const failed = taskEvent(previous, {
      error: { message: "Provider failed after output" },
      anonyma: { credits_charged: credits },
      conversationId: "c_failed",
    });
    assert.equal(failed.status, "failed");
    assert.equal(failed.text, previous.text);
    assert.equal(failed.receipt.credits_charged, credits);
    assert.equal(failed.conversationId, "c_failed");
    assert.equal(failed.map, previous.map);
    assert.throws(() => completeTask(failed), /Provider failed after output/);
  }
  assert.equal(previous.receipt, null);
  assert.equal(previous.conversationId, null);
});
test("task release gate refuses generation before auth and invalid task input does not reserve credits", async (t) => {
  const gate = UPDATES.find((u) => u.id === "tasktools"),
    old = gate.released;
  gate.released = false;
  const dir = mkdtempSync(join(tmpdir(), "anonyma-task-tools-"));
  const svc = createApp({
    testMode: true,
    released: new Set(),
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
  });
  t.after(() => {
    gate.released = old;
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const body = {
    taskTool: "writing",
    mode: "chat",
    model: "google/gemini-2.5-flash",
    messages: taskMessages("writing", "Draft a note"),
    max_tokens: 50,
  };
  const blocked = await request(svc.app)
    .post("/api/chat")
    .send(body)
    .expect(403);
  assert.equal(blocked.body.error.code, "feature_unreleased");
  svc.cfg.released = "all";
  const agent = request.agent(svc.app);
  await agent
    .post("/api/auth/register")
    .send({ username: "task_reader", password: "test-password-long" })
    .expect(201);
  const before = svc.db.prepare("SELECT COUNT(*) n FROM holds").get().n;
  await agent
    .post("/api/chat")
    .send({
      ...body,
      messages: [
        body.messages[0],
        { role: "user", content: "x".repeat(10001) },
      ],
    })
    .expect(400);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM holds").get().n, before);
});

test("research citations survive the real streaming/saved path; new alternatives and duplicate requests preserve originals", async (t) => {
  let calls = 0;
  const gateway = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls++;
    assert.ok(body.plugins?.some((p) => p.id === "web"));
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (x) => res.write("data: " + JSON.stringify(x) + "\n\n");
    send({
      choices: [
        {
          delta: {
            content: `Research result ${calls}. A prose-only URL is https://not-evidence.example/.`,
            ...(calls === 1
              ? {
                  annotations: [
                    {
                      type: "url_citation",
                      url_citation: {
                        url: "https://example.org/returned",
                        title: "Returned evidence",
                      },
                    },
                    {
                      type: "url_citation",
                      url_citation: {
                        url: "javascript:alert(1)",
                        title: "Unsafe",
                      },
                    },
                  ],
                }
              : {}),
          },
        },
      ],
    });
    send({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 10, cost: 0.000001 },
    });
    if (calls === 3)
      send({ error: { message: "Fixture failure after output" } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => gateway.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "anonyma-task-stream-"));
  const svc = createApp({
    testMode: false,
    released: "all",
    gateway: `http://127.0.0.1:${gateway.address().port}`,
    gatewayKey: "local-fixture",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
  });
  t.after(async () => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
    await new Promise((r) => gateway.close(r));
  });
  const agent = request.agent(svc.app),
    signup = await agent
      .post("/api/auth/register")
      .send({ username: "task_stream", password: "test-password-long" })
      .expect(201);
  addCredit(
    svc.db,
    signup.body.user.id,
    100000000,
    "fixture-credit",
    "test_credit",
  );
  const body = {
    taskTool: "research",
    mode: "chat",
    model: "google/gemini-2.5-flash",
    messages: taskMessages("research", "Compare research methods"),
    web_search: true,
    max_tokens: 50,
    requestId: "task-first",
  };
  const one = await agent.post("/api/chat").send(body).expect(200);
  const consume = (response) =>
    response.text
      .split("\n\n")
      .filter((s) => s.startsWith("data: {"))
      .reduce((r, line) => taskEvent(r, JSON.parse(line.slice(6))), {
        text: "",
        sources: [],
        receipt: null,
      });
  const first = completeTask(consume(one));
  assert.equal(first.sources.length, 1);
  assert.equal(first.sources[0].title, "Returned evidence");
  assert.ok(first.receipt.credits_charged > 0);
  const original = svc.db
    .prepare(
      "SELECT content FROM messages WHERE conversation_id=? ORDER BY created,rowid",
    )
    .all(first.conversationId);
  const two = await agent
    .post("/api/chat")
    .send({ ...body, requestId: "task-second" })
    .expect(200);
  const second = completeTask(consume(two));
  assert.deepEqual(second.sources, []);
  assert.notEqual(first.conversationId, second.conversationId);
  assert.deepEqual(
    svc.db
      .prepare(
        "SELECT content FROM messages WHERE conversation_id=? ORDER BY created,rowid",
      )
      .all(first.conversationId),
    original,
  );
  await agent.post("/api/chat").send(body).expect(409);
  assert.equal(calls, 2);
  assert.equal(balance(svc.db, signup.body.user.id).held, 0);
  const interrupted = consume(
    await agent
      .post("/api/chat")
      .send({ ...body, requestId: "task-third" })
      .expect(200),
  );
  assert.equal(interrupted.status, "failed");
  assert.match(interrupted.error, /Fixture failure after output/);
  assert.match(interrupted.text, /Research result 3/);
  assert.ok(interrupted.receipt.credits_charged > 0);
  assert.ok(interrupted.conversationId);
  assert.throws(() => completeTask(interrupted), /Fixture failure/);
  const saved = svc.db
    .prepare(
      "SELECT content FROM messages WHERE conversation_id=? AND role='assistant'",
    )
    .get(interrupted.conversationId);
  assert.equal(JSON.parse(saved.content).interrupted, true);
  assert.equal(balance(svc.db, signup.body.user.id).held, 0);
});
