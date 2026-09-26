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
import { addCredit, balance, credits } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { eraseAccountContent } from "../server/routes/account.js";
import {
  DEPTHS,
  MAX_SOURCES,
  cleanReport,
  collectSources,
  parsePlan,
  partialReport,
  stepSources,
  stripUrls,
} from "../src/deep-research.js";
import { messageFromServer } from "../src/lib.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const QUESTION = "How do passkeys compare with passwords for everyday security?";
const PLAN = [
  "How do passkeys work under the hood?",
  "Are passkeys resistant to phishing?",
  "How are passkeys synced and recovered across devices?",
  "Which services support passkeys today?",
  "What are the drawbacks of passkeys?",
  "How do passwords and password managers compare?",
  "What do security agencies recommend?",
  "What happens if a device is lost?",
];
const SOURCE = (n) => ({ url: `https://source-${n}.example.org/page`, title: `Source ${n}` });

// ---- A stand-in for the gateway ----

function event(res, p) {
  res.write("data: " + JSON.stringify(p) + "\n\n");
}
async function readJSON(req) {
  let s = "";
  for await (const b of req) s += b;
  return JSON.parse(s || "{}");
}
const kindOf = (body) =>
  body.plugins?.some((p) => p?.id === "web")
    ? "search"
    : String(body.messages?.[0]?.content || "").startsWith("You plan web research")
      ? "plan"
      : String(body.messages?.[0]?.content || "").startsWith("You write research reports")
        ? "write"
        : "chat";
// `script` answers each kind of step: { plan, search(i, body), write, hold }.
// A step whose answer is null hangs until the request is aborted.
async function gateway(t, script = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const body = await readJSON(req);
    const kind = kindOf(body);
    const index = calls.filter((c) => c.kind === kind).length;
    calls.push({ kind, body });
    const answer =
      kind === "plan"
        ? (script.plan ?? JSON.stringify({ questions: PLAN }))
        : kind === "search"
          ? (script.search ? script.search(index, body) : { text: `Findings for ${body.messages[1].content}`, sources: [SOURCE(index * 2 + 1), SOURCE(index * 2 + 2)] })
          : kind === "write"
            ? (script.write ?? "# Report\n\n**Key findings**\n\n- Passkeys resist phishing [1][3].")
            : "ok";
    if (answer === null) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": waiting\n\n");
      req.on("close", () => res.destroy());
      return;
    }
    if (answer?.status) {
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "stand-in refusal" } }));
      return;
    }
    const text = typeof answer === "string" ? answer : answer.text;
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { choices: [{ delta: { content: text } }] });
    if (answer?.sources)
      event(res, {
        choices: [
          {
            delta: {
              annotations: answer.sources.map((s) => ({ type: "url_citation", url_citation: s })),
            },
          },
        ],
      });
    event(res, { choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 200, completion_tokens: 100 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return {
    url: "http://127.0.0.1:" + server.address().port,
    calls,
    // Cuts every hanging answer off, as a provider dropping the connection.
    drop: () => server.closeAllConnections(),
  };
}

function fixture(t, { released = "all", gatewayUrl = "http://127.0.0.1:9", ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-research-"));
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
  const cookie = r.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
  return { agent, user: r.body.user, cookie };
}
// Reads an SSE body into its data events.
const events = (text) =>
  text
    .split("\n\n")
    .map((b) => b.replace(/^data: /, ""))
    .filter((b) => b && b !== "[DONE]" && !b.startsWith(":"))
    .map((b) => JSON.parse(b));
const ask = (p, extra = {}) =>
  p.agent
    .post("/api/research")
    .buffer(true)
    .parse((res, cb) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => {
        if (!String(res.headers["content-type"]).includes("json")) return cb(null, s);
        try {
          cb(null, JSON.parse(s));
        } catch (e) {
          cb(e);
        }
      });
    })
    .send({ model: MODEL, question: QUESTION, depth: "quick", requestId: "r-" + Math.random(), ...extra });
const ledgerSpend = (s, user) =>
  0 - s.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE user_id=? AND amount<0").get(user).n || 0;
const holdsOf = (s, user) =>
  s.db.prepare("SELECT id,status,amount FROM holds WHERE user_id=? ORDER BY id").all(user);
const savedMessages = (s, user) =>
  s.db
    .prepare("SELECT m.role,m.content,m.cost FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? ORDER BY m.created,m.rowid")
    .all(user)
    .map((m) => ({ ...m, content: JSON.parse(m.content) }));

// ---- The release gate ----

test("unreleased: both routes are refused before anything runs, and the API docs leave them out", async (t) => {
  const s = fixture(t, { released: "mvp" });
  const a = await person(s, "ana");
  for (const path of ["/api/research", "/api/research/quote", "/API/Research"]) {
    const res = await a.agent.post(path).send({ model: MODEL, question: QUESTION, depth: "quick" }).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Deep Research is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(s.app).post("/api/research").send({}).expect(403);
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.deepresearch, false);
  const entry = config.releases.updates.find((u) => u.id === "deepresearch");
  assert.equal(entry.title, "Deep Research");
  assert.equal(entry.points.length, 3);
  const docs = (await request(s.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!docs.paths["/api/research"] && !docs.paths["/api/research/quote"]);
  // Released, it still needs Live Web Search, and what a run turns on.
  const partly = fixture(t, { released: "mvp,deepresearch" });
  const b = await person(partly, "ben");
  const res = await b.agent.post("/api/research").send({ model: MODEL, question: QUESTION, depth: "quick" }).expect(403);
  assert.equal(res.body.error.message, "Live Web Search is coming soon.");
  const gates = (body) => featuresFor({ path: "/api/research", method: "POST", body });
  assert.deepEqual(gates({}), ["deepresearch", "search"]);
  assert.deepEqual(gates({ private: true, project: "p", memory: [], veil_masked: 0, mode: "code" }), [
    "deepresearch", "search", "private", "ephemeral", "projects", "memory", "trail", "code",
  ]);
  assert.deepEqual(gates({ ephemeral: true }), ["deepresearch", "search", "ephemeral"]);
});

// ---- Pure helpers ----

test("the plan is strict JSON, capped at the depth, and falls back to the question itself", () => {
  const json = JSON.stringify({ questions: PLAN });
  assert.deepEqual(parsePlan(json, QUESTION, DEPTHS.quick).questions, PLAN.slice(0, 3));
  assert.deepEqual(parsePlan(json, QUESTION, DEPTHS.thorough).questions, PLAN.slice(0, 6));
  assert.equal(parsePlan("```json\n" + json + "\n```", QUESTION, 3).fallback, false);
  // Duplicates, blanks and over-long entries go; what's left counts.
  assert.deepEqual(
    parsePlan(JSON.stringify({ questions: ["Same one", "same ONE", "", "x".repeat(301), "Other one"] }), QUESTION, 3).questions,
    ["Same one", "Other one"],
  );
  for (const bad of [
    "Sure! Here are some questions: 1. a 2. b",
    JSON.stringify(PLAN),
    JSON.stringify({ questions: [] }),
    JSON.stringify({ questions: ["fine", 7] }),
    JSON.stringify({ subquestions: PLAN }),
    "",
    null,
  ])
    assert.deepEqual(parsePlan(bad, QUESTION, 6), { questions: [QUESTION], fallback: true }, String(bad));
});

test("sources are numbered once, round-robin, and capped", () => {
  const { sources, numbers } = collectSources([
    { status: "done", sources: [SOURCE(1), SOURCE(2)] },
    { status: "failed", sources: [SOURCE(9)] },
    { status: "done", sources: [{ ...SOURCE(2), url: SOURCE(2).url + "/#top" }, SOURCE(3)] },
  ]);
  assert.deepEqual(sources.map((s) => s.title), ["Source 1", "Source 2", "Source 3"]);
  assert.deepEqual(numbers, [[1, 2], [], [2, 3]]);
  const many = collectSources(
    Array.from({ length: 6 }, (_, i) => ({
      status: "done",
      sources: Array.from({ length: 5 }, (_, k) => SOURCE(i * 10 + k)),
    })),
  );
  assert.equal(many.sources.length, MAX_SOURCES);
  // Every search still has pages to cite when the list is full.
  assert.ok(many.numbers.every((list) => list.length >= 3));
  // Only real web addresses count as sources.
  assert.deepEqual(
    stepSources([{ url: "javascript:alert(1)" }, { url: "https://u:p@x.org/" }, { url: "ftp://x.org" }, SOURCE(1), SOURCE(1)]),
    [SOURCE(1)],
  );
});

test("citations map only to real sources; invented links and numbers are removed", () => {
  const sources = [SOURCE(1), SOURCE(2)];
  const { text, cited } = cleanReport(
    [
      "# Passkeys",
      "",
      "They resist phishing [1]. Adoption grew [7]. Both agree [1, 2] and [2-4].",
      "See [the spec](https://invented.example.com/spec) or https://also-invented.example.net/x.",
      "The real page is [here](https://source-2.example.org/page).",
      "A footnote[^1] and an image ![x](https://tracker.example/p.png).",
      "",
      "[1]: https://invented.example.com/ref",
      "",
      "## Sources",
      "1. https://invented.example.com/ref",
    ].join("\n"),
    sources,
  );
  assert.deepEqual(cited, [1, 2]);
  assert.ok(!/invented|tracker/.test(text), text);
  assert.ok(!/\[[3-9]\]/.test(text), text);
  assert.match(text, /They resist phishing \[1\]\. Adoption grew\. Both agree \[1\]\[2\] and \[2\]\./);
  assert.match(text, /\[here\]\(https:\/\/source-2\.example\.org\/page\)/);
  assert.match(text, /A footnote\[1\]/);
  assert.ok(!/## Sources/.test(text));
  // The writer never sees addresses to copy.
  assert.equal(stripUrls("See [the page](https://x.org/a) and https://y.org/b"), "See the page and ");
  // A stopped run's findings keep only the list's numbers.
  const partial = partialReport({
    questions: ["One?", "Two?"],
    results: [{ status: "done", findings: "Found it [3] at https://invented.example.com." }, { status: "failed" }],
    sources,
    numbers: [[1, 2], []],
  });
  assert.equal(partial, "### 1. One?\n\nFound it at.\n\n[1][2]");
});

// ---- Runs ----

test("a quick run plans, searches 3 times, writes, charges each step and saves one turn", async (t) => {
  const g = await gateway(t, {
    write: "# Passkeys vs passwords\n\n**Key findings**\n\n- Phishing-resistant [1][2].\n- Synced across devices [5]; see https://invented.example.com [99].",
  });
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "cara");
  const quote = (await a.agent.post("/api/research/quote").send({ model: MODEL, question: QUESTION, depth: "quick" }).expect(200)).body;
  assert.equal(quote.searches, 3);
  const units = (c) => Math.round(c * 10000);
  assert.equal(units(quote.credits), units(quote.steps.plan) + 3 * units(quote.steps.search) + units(quote.steps.write));
  const before = balance(s.db, a.user.id).total;
  const res = await ask(a).expect(200);
  const list = events(res.body);
  const stages = list.map((e) => e.research?.stage).filter(Boolean);
  assert.deepEqual(stages.slice(0, 2), ["planning", "planned"]);
  assert.equal(stages.filter((x) => x === "searched").length, 3);
  assert.deepEqual(stages.slice(-2), ["writing", "done"]);
  // The plan was capped at Quick's 3; each search carried one sub-question
  // and the web plugin; only the plan and the report saw the whole question.
  assert.deepEqual(g.calls.map((c) => c.kind).sort(), ["plan", "search", "search", "search", "write"]);
  const searched = g.calls.filter((c) => c.kind === "search").map((c) => c.body.messages[1].content).sort();
  assert.deepEqual(searched, PLAN.slice(0, 3).sort());
  assert.ok(g.calls.filter((c) => c.kind === "search").every((c) => c.body.messages.length === 2));
  const final = list.at(-1);
  assert.equal(final.research.stage, "done");
  assert.equal(final.message.citations.length, 6);
  assert.match(final.message.text, /Phishing-resistant \[1\]\[2\]\./);
  assert.ok(!/invented|\[99\]/.test(final.message.text));
  assert.equal(final.message.research.status, "done");
  assert.deepEqual(final.message.research.steps.map((x) => x.status), ["done", "done", "done", "done", "done"]);
  // Charged exactly the settled steps, within the quoted maximum.
  const spent = ledgerSpend(s, a.user.id);
  assert.equal(before - balance(s.db, a.user.id).total, spent);
  assert.equal(credits(spent), final.anonyma.credits_charged);
  assert.ok(final.anonyma.credits_charged <= quote.credits);
  assert.ok(final.anonyma.credits_charged > 3 * 21, "three web search fees at least");
  assert.equal(balance(s.db, a.user.id).held, 0);
  const holds = holdsOf(s, a.user.id);
  assert.equal(holds.length, 5);
  assert.ok(holds.every((h) => h.status === "settled"));
  // The balance allowed headroom, so each step was held at 4x its maximum.
  const held = holds.reduce((n, h) => n + h.amount, 0);
  assert.ok(Math.abs(credits(held) - 4 * quote.credits) < 0.01, `${credits(held)} vs ${quote.credits}`);
  // One ordinary turn: the question, then the report with its sources.
  const saved = savedMessages(s, a.user.id);
  assert.deepEqual(saved.map((m) => m.role), ["user", "assistant"]);
  assert.equal(saved[0].content, QUESTION);
  assert.equal(saved[1].content.text, final.message.text);
  assert.deepEqual(saved[1].content.citations, final.message.citations);
  assert.equal(saved[1].content.research.depth, "quick");
  assert.equal(saved[1].cost, spent);
  const shown = messageFromServer({ role: "assistant", content: saved[1].content });
  assert.equal(shown.research.status, "done");
  assert.equal(shown.research.live, false);
  assert.equal(shown.citations.length, 6);
  // The account export has it; erasing the account's content removes it.
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.ok(JSON.stringify(exported.conversations).includes("Passkeys vs passwords"));
  eraseAccountContent(s.db, a.user);
  assert.equal(savedMessages(s, a.user.id).length, 0);
});

test("thorough runs up to 6 searches; invalid planner JSON falls back to one search of the question", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "dev");
  await ask(a, { depth: "thorough" }).expect(200);
  assert.equal(g.calls.filter((c) => c.kind === "search").length, 6);
  const g2 = await gateway(t, { plan: "I think you should search for passkeys, phishing and sync." });
  const s2 = fixture(t, { gatewayUrl: g2.url });
  const b = await person(s2, "eve");
  const list = events((await ask(b, { depth: "thorough" }).expect(200)).body);
  const planned = list.find((e) => e.research?.stage === "planned").research;
  assert.deepEqual(planned.questions, [QUESTION]);
  assert.equal(planned.fallback, true);
  const searches = g2.calls.filter((c) => c.kind === "search");
  assert.equal(searches.length, 1);
  assert.equal(searches[0].body.messages[1].content, QUESTION);
  // The planner still ran, so it's charged; the 5 unused searches are released.
  const holds = holdsOf(s2, b.user.id);
  assert.equal(holds.filter((h) => h.status === "settled").length, 3);
  assert.equal(holds.filter((h) => h.status === "released").length, 5);
});

test("stopping mid-way charges only the finished steps and keeps what they found", async (t) => {
  // The first search answers; the other two hang until the run is stopped.
  const g = await gateway(t, {
    search: (i, body) => (i === 0 ? { text: "Passkeys use public keys.", sources: [SOURCE(1)] } : null),
  });
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "fay");
  const server = s.app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const controller = new AbortController();
  const res = await fetch(`http://127.0.0.1:${server.address().port}/api/research`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie: a.cookie, origin: "http://localhost:5175" },
    body: JSON.stringify({ model: MODEL, question: QUESTION, depth: "quick", requestId: "stop-1" }),
    signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  let text = "";
  while (!text.includes('"stage":"searched"')) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  controller.abort();
  // Wait for the server to wind the run down.
  for (let i = 0; i < 100 && holdsOf(s, a.user.id).some((h) => h.status === "held"); i++)
    await new Promise((r) => setTimeout(r, 20));
  await new Promise((r) => setTimeout(r, 50));
  const holds = Object.fromEntries(holdsOf(s, a.user.id).map((h) => [h.id.split(":").at(-1), h.status]));
  assert.deepEqual(holds, {
    plan: "settled",
    search1: "settled",
    search2: "released",
    search3: "released",
    write: "released",
  });
  const spent = ledgerSpend(s, a.user.id);
  const settled = s.db
    .prepare("SELECT result FROM holds WHERE user_id=? AND status='settled'")
    .all(a.user.id)
    .reduce((n, h) => n + JSON.parse(h.result).charged, 0);
  assert.equal(spent, settled);
  assert.equal(balance(s.db, a.user.id).held, 0);
  // No report was asked for, and what finished is kept with the chat.
  assert.equal(g.calls.filter((c) => c.kind === "write").length, 0);
  const saved = savedMessages(s, a.user.id);
  assert.deepEqual(saved.map((m) => m.role), ["user", "assistant"]);
  assert.equal(saved[1].content.research.status, "stopped");
  assert.match(saved[1].content.text, /Passkeys use public keys\./);
  assert.deepEqual(saved[1].content.citations, [SOURCE(1)]);
  assert.deepEqual(saved[1].content.research.steps.map((x) => x.status), ["done", "done", "stopped", "stopped", "skipped"]);
  assert.equal(saved[1].cost, spent);
});

test("a failed search is released and the report uses the rest; a failed report returns the findings", async (t) => {
  const g = await gateway(t, {
    search: (i) => (i === 1 ? { status: 400 } : { text: `Finding ${i}`, sources: [SOURCE(i)] }),
    write: "",
  });
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "gus");
  const list = events((await ask(a).expect(200)).body);
  const final = list.at(-1);
  assert.equal(final.error.code, "research_report_failed");
  assert.equal(final.message.research.status, "partial");
  assert.deepEqual(final.message.research.steps.map((x) => x.status), ["done", "done", "failed", "done", "failed"]);
  assert.match(final.message.text, /### 1\./);
  assert.ok(!/### 2\./.test(final.message.text));
  const holds = Object.fromEntries(holdsOf(s, a.user.id).map((h) => [h.id.split(":").at(-1), h.status]));
  assert.equal(holds.search2, "released");
  assert.equal(holds.write, "released");
  assert.equal(credits(ledgerSpend(s, a.user.id)), final.anonyma.credits_charged);
});

test("too little balance, or a spending limit, refuses before anything is charged or sent", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "hal", 30_000); // 3 credits: less than three web searches
  const res = await ask(a).expect(402);
  assert.equal(res.body.error.code, "insufficient_credits");
  assert.equal(g.calls.length, 0);
  assert.equal(ledgerSpend(s, a.user.id), 0);
  assert.equal(holdsOf(s, a.user.id).length, 0);
  assert.equal(savedMessages(s, a.user.id).length, 0);
  // Spending Limits apply to the same holds.
  const b = await person(s, "ida");
  await b.agent.patch("/api/spending-limits").send({ daily_limit: 5 }).expect(200);
  const limited = await ask(b).expect(402);
  assert.equal(limited.body.error.code, "spending_limit");
  assert.equal(g.calls.length, 0);
  assert.equal(holdsOf(s, b.user.id).length, 0);
});

test("the maximum is held up front: headroom when it fits, exactly the quote when it doesn't", async (t) => {
  const g = await gateway(t, { search: () => null });
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "jose");
  const quote = (await a.agent.post("/api/research/quote").send({ model: MODEL, question: QUESTION, depth: "quick" }).expect(200)).body;
  // Fund exactly the quote: the 4x headroom can't be held, the maximum can.
  const c = await person(s, "kima", Math.round(quote.credits * 10000) + 1);
  const pending = ask(c).then(() => {}, () => {});
  for (let i = 0; i < 100 && holdsOf(s, c.user.id).length < 5; i++) await new Promise((r) => setTimeout(r, 10));
  const held = holdsOf(s, c.user.id).reduce((n, h) => n + h.amount, 0);
  assert.equal(credits(held), quote.credits);
  // A second run while one is going is refused, with nothing held for it.
  const again = await ask(c).expect(409);
  assert.equal(again.body.error.code, "research_running");
  // The searches' connections drop: they fail, are released, and the run
  // ends having charged only its plan.
  for (let i = 0; i < 100 && g.calls.filter((x) => x.kind === "search").length < 3; i++)
    await new Promise((r) => setTimeout(r, 10));
  g.drop();
  await pending;
  const statuses = holdsOf(s, c.user.id).map((h) => h.status).sort();
  assert.deepEqual(statuses, ["released", "released", "released", "released", "settled"]);
  assert.equal(balance(s.db, c.user.id).held, 0);
});

test("Veil, Seed Guard, Private Mode and off the record", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url, privateModels: [MODEL] });
  const a = await person(s, "lee");
  // Veil masked something in the question: refused, nothing sent.
  const veiled = await ask(a, { veil_masked: 2 }).expect(400);
  assert.equal(veiled.body.error.code, "research_veiled");
  // A seed phrase is refused with no override: it would become searches.
  const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const phrase = await ask(a, { question: "What is " + seed, allow_seed_phrase: true }).expect(400);
  assert.equal(phrase.body.error.code, "seed_phrase_blocked");
  assert.equal(g.calls.length, 0);
  // Private Mode: ZDR routing on every step, and nothing saved.
  const list = events((await ask(a, { private: true, veil_masked: 0 }).expect(200)).body);
  assert.ok(g.calls.every((c) => c.body.provider?.zdr === true));
  assert.deepEqual(list.at(-1).anonyma.private, { privacy: "zdr", stored: false });
  assert.equal(list.at(-1).anonyma.privacy.retention, "zero_data_retention");
  assert.equal(list.at(-1).anonyma.privacy.storage, "private");
  assert.equal(list.at(-1).conversationId, null);
  // Off the record: runs, charged, nothing saved.
  await ask(a, { ephemeral: true }).expect(200);
  assert.equal(savedMessages(s, a.user.id).length, 0);
  assert.ok(ledgerSpend(s, a.user.id) > 0);
  // Neither can join a saved chat or a project.
  assert.equal((await ask(a, { ephemeral: true, conversationId: "c_x" }).expect(400)).body.error.code, "invalid_request");
  // A non-private model in Private Mode is refused.
  const s2 = fixture(t, { gatewayUrl: g.url });
  const b = await person(s2, "max");
  assert.equal((await ask(b, { private: true }).expect(400)).body.error.code, "private_model_required");
  // Team pays doesn't cover it; image models can't run it.
  assert.equal((await ask(b, { treasury: true }).expect(400)).body.error.code, "invalid_request");
  assert.equal((await ask(b, { mode: "uncensored" }).expect(400)).body.error.code, "invalid_request");
});

test("Memory goes with the plan and the report, never into a search; Privacy Trail records each step's route", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "ned");
  await a.agent.put("/api/memory/settings").send({ enabled: true }).expect(200);
  const fact = (await a.agent.post("/api/memory/facts").send({ text: "I use an iPhone and a Windows laptop" }).expect(201)).body;
  const res = await ask(a, { memory: [{ id: fact.id, text: fact.text, updated: fact.updated }], veil_masked: null }).expect(200);
  const final = events(res.body).at(-1);
  assert.equal(final.anonyma.memory.used, 1);
  const has = (c) => JSON.stringify(c.body.messages).includes("Windows laptop");
  assert.ok(g.calls.filter((c) => c.kind !== "search").every(has));
  assert.ok(!g.calls.filter((c) => c.kind === "search").some(has));
  assert.equal(final.anonyma.privacy.route, "primary");
  assert.equal(final.anonyma.privacy.veil_masked, null);
  assert.ok(final.message.research.steps.filter((x) => x.status === "done").every((x) => x.route === "primary"));
});

// ---- The workspace UI ----

async function uiModule() {
  const src = new URL("../src/DeepResearch.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-research-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub("ui.mjs", `export const Icon = ({ name }) => React.createElement("i", { "data-icon": name });`);
  const here = (f) => new URL("../src/" + f, import.meta.url).href;
  const out = code
    .replace(/^import "\.\/deep-research\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/(lib|stream|estimate|deep-research)\.js"/g, (_, f) => `from "${here(f + ".js")}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "DeepResearch.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the UI: gated on the release, live progress and numbered sources, model text kept untranslated", async () => {
  const ui = await uiModule();
  const on = { releases: { features: { deepresearch: true, search: true } } };
  assert.equal(ui.researchLive({}), false);
  assert.equal(ui.researchLive({ releases: { features: { deepresearch: true } } }), false);
  assert.equal(ui.researchLive(on), true);
  assert.equal(ui.researchBlock({ sealed: true }).startsWith("Deep research isn't available in Sealed Mode"), true);
  assert.equal(ui.researchBlock({ veiled: 1 }), ui.RESEARCH_VEILED_NOTE);
  assert.equal(ui.researchBlock({}), null);
  const progress = renderToStaticMarkup(
    createElement(ui.ResearchProgress, {
      research: {
        live: true,
        stage: "searching",
        depth: "thorough",
        questions: ["Sub one?", "Sub two?"],
        results: [{ status: "done", sources: [SOURCE(1)], credits: 22.4 }, { status: "searching", sources: [], credits: 0 }],
        planCredits: 1.2,
      },
    }),
  );
  assert.match(progress, /DEEP RESEARCH · THOROUGH/);
  assert.match(progress, /Searching 1\/2/);
  assert.match(progress, /<span class="research-q" data-i18n="off">Sub one\?<\/span>/);
  assert.match(progress, /Charged so far: 23\.6 credits/);
  const details = renderToStaticMarkup(
    createElement(ui.ResearchDetails, {
      research: {
        depth: "quick",
        questions: ["Sub one?"],
        status: "stopped",
        steps: [{ kind: "plan", status: "done" }, { kind: "search", status: "done", sources: 1, route: "primary" }, { kind: "write", status: "skipped" }],
        credits_charged: 23.6,
      },
      citations: [SOURCE(1)],
      trail: true,
    }),
  );
  assert.match(details, /Stopped before the report/);
  assert.match(details, /<span class="research-n">1<\/span><a data-i18n="off" href="https:\/\/source-1\.example\.org\/page"[^>]*rel="noopener noreferrer nofollow">Source 1<\/a>/);
  assert.match(details, /Primary route/);
  // Only a web address is ever a link, and the numbering never shifts.
  const unsafe = renderToStaticMarkup(
    createElement(ui.ResearchDetails, {
      research: { status: "done", steps: [], credits_charged: 1 },
      citations: [{ url: "javascript:alert(1)", title: "Trap" }, SOURCE(2)],
    }),
  );
  assert.ok(!/javascript:/.test(unsafe));
  assert.match(unsafe, /<span class="research-n">1<\/span><span data-i18n="off">Trap<\/span>/);
  assert.match(unsafe, /<span class="research-n">2<\/span><a data-i18n="off" href="https:\/\/source-2/);
  // A stopped run's reply, built in the browser the way the server keeps it.
  const kept = ui.stoppedReply({
    depth: "quick",
    stage: "searching",
    questions: ["Sub one?", "Sub two?"],
    results: [{ status: "done", findings: "Found.", sources: [SOURCE(1)], credits: 2 }, { status: "searching", sources: [], credits: 0 }],
    planCredits: 1,
  });
  assert.equal(kept.content, "### 1. Sub one?\n\nFound.\n\n[1]");
  assert.deepEqual(kept.research.steps.map((x) => x.status), ["done", "done", "stopped", "skipped"]);
  assert.equal(kept.research.credits_charged, 3);
});

test("every visible string has a Chinese entry, including the release copy", async () => {
  const dict = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const entry = UPDATES.find((u) => u.id === "deepresearch");
  const strings = [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Deep research",
    "DEEP RESEARCH",
    "Plans your question, searches the web, then writes a report with numbered sources.",
    "Quick",
    "Thorough",
    "3 searches",
    "6 searches",
    "Type a question to see the most it can cost.",
    "Only this question is sent, not earlier messages. You pay only for steps that finish, and Stop ends the rest.",
    "Attachments aren't used by Deep research. They stay here for your next message.",
    "Only this question is sent, not earlier messages.",
    "Up to ≈142 credits",
    "Up to 142 credits",
    " · plan 1.2, 6 searches up to 22 each (web fee included), report 14",
    "DEEP RESEARCH · QUICK",
    "DEEP RESEARCH · THOROUGH",
    "Planning",
    "Searching",
    "Searching 2/6",
    "Writing",
    "Writing the report from what the searches found…",
    "6 sub-questions",
    "Searching your question as it is",
    "Waiting",
    "Searching…",
    "Failed, not charged",
    "Stopped, not charged",
    "Not run",
    "5 sources",
    "1 source",
    "Charged so far: 23.6 credits",
    "Deep research · 5 of 6 searches · 18 sources · 142.5 credits",
    "How this was researched",
    "Primary route",
    "Backup route",
    "The plan wasn't usable, so your question was searched as it is.",
    "Citations point only to pages these searches returned. Check important facts at the source.",
    "Stopped before the report. Here is what the finished searches found; only finished steps were charged.",
    "The report couldn't be written. Here is what the searches found; the report step wasn't charged.",
    "Deep research turns your question into web searches, so it never sends this.",
    "Stopped. Only finished steps were charged: 23.6 credits.",
    "Deep research isn't available in Sealed Mode: its web searches would leave the enclave.",
    "Deep research is paid from your own balance. Turn off Team pays to run it.",
    "Veil masked details in this question, so Deep research won't run it: web searches with placeholders would find nothing, and the real details never leave this browser. Remove them, or turn Veil off for this question.",
    "None of the web searches finished, so no report was written. Only finished steps were charged.",
    "The report couldn't be written, so here is what the searches found. The report step wasn't charged.",
    "A deep research run is already going. Wait for it, or stop it first.",
    "Deep research: plans your question, searches the web and writes a sourced report",
    "The most this research can cost. Each step is charged on its actual usage as it finishes; steps that don't finish cost nothing.",
    "Deep Research is coming soon.",
    "Deep research",
  ];
  for (const s of strings) {
    const zh = translateText(s, dict);
    assert.ok(zh && zh !== s && /[一-鿿]/.test(zh), `no Chinese for ${JSON.stringify(s)} (${zh})`);
  }
});
