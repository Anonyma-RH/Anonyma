import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createApp } from "../server/app.js";
import { addCredit, balance } from "../server/core.js";
import {
  nearLatest,
  chargePresentation,
  mergeCharge,
  chatFailureMessage,
} from "../src/chat-control.js";
import { UPDATES } from "../server/releases.js";
import { completionNotice } from "../src/long-answers.js";
import { messageFromServer } from "../src/lib.js";
import { streamChat, ApiError } from "../src/lib.js";
const MODEL = "google/gemini-2.5-flash";
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-chat-control-"));
  const s = createApp({
    testMode: true,
    released: "all",
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "catalog.json"),
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
async function person(s, name = "reader") {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "local-fixture-password" })
    .expect(201);
  addCredit(s.db, r.body.user.id, 1e8, "local-fixture");
  return { agent, user: r.body.user };
}
async function upstream(t, handler) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) {
    }
    await handler(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}
const body = {
  model: MODEL,
  messages: [{ role: "user", content: "Read carefully" }],
  max_tokens: 50,
};
const events = (r) =>
  r.text
    .split("\n\n")
    .filter((x) => x.startsWith("data: {"))
    .map((x) => JSON.parse(x.slice(6)));

test("reading distance accounts for composer; charge language never guesses free or a refund", () => {
  assert.doesNotMatch(
    chatFailureMessage({
      code: "provider_interrupted",
      message: "may have been billed",
    }),
    /may have/,
  );
  assert.match(
    chatFailureMessage(new TypeError("Failed to fetch")),
    /connection was lost/,
  );
  assert.match(
    chatFailureMessage({ name: "AbortError" }),
    /Check charge status/,
  );
  assert.equal(nearLatest(750, 900, 200), true);
  assert.equal(nearLatest(900, 900, 200), false);
  assert.match(
    chargePresentation({ status: "held", reserved: 5 }).title,
    /reserved/,
  );
  assert.match(
    chargePresentation({
      status: "settled",
      receipt: { credits_charged: 2, released: 3 },
    }).detail,
    /3 unused reserved credits released/,
  );
  assert.equal(
    chargePresentation({ status: "settled", receipt: { credits_charged: 0 } })
      .title,
    "No credits charged",
  );
  assert.equal(
    chargePresentation({ status: "settled", receipt: {} }).title,
    "Charge status unknown",
  );
  assert.equal(
    chargePresentation({
      status: "settled",
      receipt: { credits_charged: null },
    }).title,
    "Charge status unknown",
  );
  assert.match(
    chargePresentation({ status: "released", reserved: 5 }).detail,
    /not a refund/,
  );
  assert.match(
    chargePresentation({ status: "held", reserved: 5, payer: "team" }).detail,
    /Team balance/,
  );
  const terminal = {
    requestId: "one",
    status: "settled",
    receipt: { credits_charged: 2 },
  };
  assert.equal(
    mergeCharge(terminal, { requestId: "other", status: "released" }),
    terminal,
  );
  assert.equal(
    mergeCharge(terminal, { requestId: "one", status: "held", reserved: 8 }),
    terminal,
    "late recovery cannot regress a settled stream receipt",
  );
  assert.equal(
    mergeCharge(terminal, { requestId: "one", status: "unknown" }).status,
    "settled",
  );
});

test("chat sends actual held then settled state; GET recovery never generates or charges again", async (t) => {
  let calls = 0;
  const gateway = await upstream(t, (res) => {
    calls++;
    res.write('data: {"choices":[{"delta":{"content":"A clear answer"}}]}\n\n');
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" }),
    { agent, user } = await person(s);
  const r = await agent
    .post("/api/chat")
    .send({ ...body, requestId: "clear" })
    .expect(200);
  const states = events(r)
    .filter((e) => e.billing)
    .map((e) => e.billing);
  assert.deepEqual(
    states.map((s) => s.status),
    ["held", "settled"],
  );
  assert.equal(states[0].payer, "personal");
  assert.ok(states[0].reserved > 0);
  const before = balance(s.db, user.id);
  for (let i = 0; i < 3; i++) {
    const r = await agent.get("/api/requests/clear").expect(200);
    assert.equal(r.body.status, "settled");
    assert.equal(
      r.body.receipt.credits_charged,
      states[1].receipt.credits_charged,
    );
  }
  assert.equal(calls, 1);
  assert.deepEqual(balance(s.db, user.id), before);
  const outsider = await person(s, "outsider");
  await outsider.agent.get("/api/requests/clear").expect(404);
  await agent
    .post("/api/chat")
    .send({ ...body, requestId: "clear" })
    .expect(409);
  assert.equal(calls, 1);
});

test("definite pre-hold refusals differ from released provider refusals and missing recovery records", async (t) => {
  let calls = 0;
  const gateway = await upstream(t, (res) => {
    calls++;
    res.writeHead(400, { "content-type": "application/json" });
    res.end('{"error":{"message":"Fixture refusal"}}');
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" }),
    { agent, user } = await person(s);
  const invalid = await agent
    .post("/api/chat")
    .send({ ...body, model: "missing", requestId: "no-hold" })
    .expect(404);
  assert.equal(invalid.body.billing.status, "not_charged");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  assert.equal(calls, 0);
  const r = await agent
    .post("/api/chat")
    .send({ ...body, requestId: "refused" })
    .expect(200);
  const final = events(r).at(-1);
  assert.ok(final.error);
  assert.equal(final.billing.status, "released");
  assert.equal(final.billing.receipt, null);
  assert.equal(balance(s.db, user.id).held, 0);
  assert.equal(
    s.db
      .prepare("SELECT COUNT(*) n FROM ledger WHERE ref=?")
      .get(user.id + ":refused").n,
    0,
  );
  const absent = await agent.get("/api/requests/not-seen").expect(404);
  assert.equal(absent.body.billing, undefined);
});

test("broken output carries its settled charge alongside the error and retains the original answer", async (t) => {
  const gateway = await upstream(t, (res) => {
    res.write(
      'data: {"choices":[{"delta":{"content":"Keep this answer"}}]}\n\n',
    );
    res.end();
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture" }),
    { agent } = await person(s);
  const r = await agent
      .post("/api/chat")
      .send({ ...body, requestId: "broken" })
      .expect(200),
    final = events(r).at(-1);
  assert.ok(final.error);
  assert.equal(final.billing.status, "settled");
  assert.ok(final.billing.receipt.credits_charged > 0);
  assert.equal(
    final.billing.receipt.credits_charged,
    final.anonyma.credits_charged,
  );
  assert.match(
    s.db.prepare("SELECT content FROM messages WHERE role='assistant'").get()
      .content,
    /Keep this answer/,
  );
});

test("stream HTTP errors preserve server billing evidence without automatically repeating fetch", async () => {
  const old = globalThis.fetch;
  let calls = 0;
  const data = {
    error: { message: "Refused", code: "invalid" },
    billing: { requestId: "id", status: "not_charged" },
  };
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify(data), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await assert.rejects(
      () => streamChat({}, () => {}),
      (e) =>
        e instanceof ApiError &&
        e.data.billing.status === "not_charged" &&
        e.code === "invalid",
    );
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = old;
  }
});

test("the new request-state events stay behind their release gate", async (t) => {
  const gate = UPDATES.find((update) => update.id === "chatcontrol");
  const released = gate.released;
  gate.released = false;
  t.after(() => { gate.released = released; });
  const s = fixture(t, { released: "mvp" }),
    { agent } = await person(s);
  const r = await agent
    .post("/api/chat")
    .send({ ...body, requestId: "legacy" })
    .expect(200);
  assert.equal(
    events(r).some((e) => e.billing),
    false,
  );
  const c = (await agent.get("/api/config").expect(200)).body;
  assert.equal(c.releases.features.chatcontrol, false);
});

test("a lost generation POST is never retried and absent recovery evidence stays unknown", async () => {
  const previousFetch = globalThis.fetch;
  let posts = 0, callbacks = 0;
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.method, "POST");
    posts++;
    throw new TypeError("Fixture connection lost before a response");
  };
  try {
    await assert.rejects(
      () => streamChat({ ...body, requestId: "lost" }, () => callbacks++),
      TypeError,
    );
    assert.equal(posts, 1, "recovery must not replay a potentially paid POST");
    assert.equal(callbacks, 0, "no server billing evidence was received");
    const state = mergeCharge(
      { requestId: "lost", status: "sending" },
      { requestId: "lost", status: "unknown" },
    );
    assert.equal(chargePresentation(state).title, "Charge status unknown");
    assert.doesNotMatch(chargePresentation(state).detail, /no credits charged/i);
  } finally {
    globalThis.fetch = previousFetch;
  }
});


test("long-answer timeout preserves partial content, finish state and authoritative charge together", async (t) => {
  let calls = 0;
  const gateway = await upstream(t, (res) => {
    calls++;
    res.write('data: {"choices":[{"delta":{"content":"Keep the partial chapter","reasoning":"Keep the reasoning"}}]}\n\n');
    // Stay open until the application's bounded timeout aborts the connection.
  });
  const s = fixture(t, { testMode: false, gateway, gatewayKey: "fixture", requestTimeoutMs: 150 }),
    { agent, user } = await person(s);
  const sent = { ...body, max_tokens: 32768, requestId: "long-timeout",
    messages: Array.from({ length: 24 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "Context turn " + i })) };
  const quote = (await agent.post("/api/quote").send(sent).expect(200)).body;
  assert.equal(quote.budget.replyBudget, 32768);
  const result = await agent.post("/api/chat").send(sent).expect(200);
  const chunks = events(result), final = chunks.at(-1);
  assert.equal(chunks[0].billing.status, "held");
  assert.equal(final.error.code, "provider_timeout");
  assert.equal(final.anonyma.finish_reason, "timeout");
  assert.equal(final.billing.status, "settled");
  assert.equal(final.billing.receipt.credits_charged, final.anonyma.credits_charged);
  const saved = s.db.prepare("SELECT * FROM messages WHERE conversation_id=? AND role='assistant'").all(final.conversationId);
  assert.equal(saved.length, 1);
  const message = messageFromServer({ ...saved[0], content: JSON.parse(saved[0].content) });
  assert.equal(message.content, "Keep the partial chapter");
  assert.equal(message.reasoning, "Keep the reasoning");
  assert.equal(message.finishReason, "timeout");
  assert.equal(message.interrupted, true);
  assert.match(completionNotice(message), /partial answer is kept/);
  assert.match(chargePresentation(final.billing).title, /credits charged/);
  const before = balance(s.db, user.id);
  assert.equal(before.held, 0);
  const recovered = (await agent.get("/api/requests/long-timeout").expect(200)).body;
  assert.deepEqual(recovered, final.billing);
  assert.deepEqual(balance(s.db, user.id), before);
  assert.equal(calls, 1, "reading the receipt and preparing continuation cannot generate again");
});
