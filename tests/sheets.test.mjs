import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { addCredit, balance, now, uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { prepareSheetsRequest, sheetsBudget, sheetsTestReply } from "../server/sheets.js";
import { knownPage } from "../src/site-routes.js";
import { paletteActions } from "../src/command-palette.js";
import { modeReleased } from "../src/lib.js";
import { createVeilState, veil, unveil } from "../src/veil.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  QUERY_SYSTEM,
  EXPLAIN_SYSTEM,
  LIMITS,
  SHEETS_MAX_TOKENS,
  checkSheetsPayload,
  queryText,
  sheetsMessages,
} from "../src/sheets-spec.js";
import {
  DEFAULT_LIST_LIMIT,
  chartSeries,
  decodeBytes,
  describeSpec,
  detectDelimiter,
  explainPayload,
  extractJSON,
  headerNames,
  inferType,
  interpretReply,
  loadSheet,
  niceTicks,
  parseDate,
  parseDelimited,
  parseNumber,
  planQuery,
  queryPayload,
  realizeSpec,
  runSpec,
  sampleSheetCSV,
  sheetKind,
  sheetProfile,
  toCSV,
  validateSpec,
  TRUNCATED_MESSAGE,
} from "../src/sheets.js";
import { handleSheetMessage } from "../src/sheets-engine.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-sheets-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...(released && released !== "all" ? { mvpModels: [MODEL] } : {}),
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(app, username = "sheet_user") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
// The events of a streamed chat reply.
const events = (text) =>
  text
    .split("\n\n")
    .map((b) => b.replace(/^data: /, "").trim())
    .filter((b) => b && b !== "[DONE]")
    .map((b) => JSON.parse(b));
const replyText = (text) =>
  events(text)
    .map((e) => e.choices?.[0]?.delta?.content || "")
    .join("");

// A small sheet with known answers.
const SALES = [
  "Date,Region,Rep,Units,Price,Paid,Note",
  '2026-01-05,North,Ana,3,10.50,yes,"first, of the year"',
  "2026-01-20,north,Ben,1,99,no,",
  '2026-02-03,South,Ana,5,"1,000.00",yes,"line one',
  'line two"',
  "2026-02-28,East,Cy,2,20,yes,",
  "2026-03-01,,Ben,,5,no,NA",
  '2026-03-15T09:30:00Z,South,Cy,4,12.25,true,"he said ""hi"""',
].join("\r\n");
const loaded = () => loadSheet(SALES, { name: "sales.csv" });
const cols = (sheet) => sheetProfile(sheet).columns;
const plan = (sheet, raw) => {
  const r = validateSpec(raw, cols(sheet));
  assert.equal(r.problems, undefined, JSON.stringify(r.problems));
  return r.spec;
};
const run = (sheet, raw) => runSpec(sheet, realizeSpec(plan(sheet, raw)));

// ---- The release gate ----

test("unreleased: a sheets question is refused before anything else, and there's no page, place or link", async (t) => {
  const mvp = fixture(t, "mvp,ephemeral");
  const a = await person(mvp.app);
  const before = balance(mvp.db, a.user.id).total;
  const body = {
    model: MODEL,
    ephemeral: true,
    sheets: { task: "query", question: "Total?", rows: 2, columns: [{ name: "A", type: "number" }] },
  };
  for (const path of ["/api/chat", "/API/Chat"]) {
    const res = await a.agent.post(path).send(body).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Local Sheets is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(mvp.app).post("/api/chat").send(body).expect(403);
  assert.equal(balance(mvp.db, a.user.id).total, before, "nothing charged");
  // An ordinary off-the-record chat is untouched by the gate.
  await a.agent
    .post("/api/chat")
    .send({ model: MODEL, ephemeral: true, messages: [{ role: "user", content: "hello" }] })
    .expect(200);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.sheets, false);
  const entry = config.releases.updates.find((u) => u.id === "sheets");
  assert.equal(entry.title, "Local Sheets");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  // The page itself: a 404 until release (served once the client is built).
  if (existsSync("dist/client/index.html")) {
    await request(mvp.app).get("/workspace/sheets").expect(404);
    await request(fixture(t, "mvp,sheets").app).get("/workspace/sheets").expect(200);
  }
  assert.equal(knownPage("/workspace/sheets"), false);
  assert.equal(knownPage("/workspace/sheets", { sheets: true }), true);
  // The client: no mode, no palette place.
  const cfg = (features) => ({ releases: { features } });
  assert.equal(modeReleased(cfg({}), "sheets"), false);
  assert.equal(modeReleased(cfg({ sheets: true }), "sheets"), true);
  const ids = (c) => paletteActions({ config: c, mode: "chat", signedIn: true }).map((x) => x.id);
  assert.ok(!ids(cfg({})).includes("go-sheets"));
  assert.ok(ids(cfg({ sheets: true })).includes("go-sheets"));
});

test("the gate is expressed in featuresFor: sheets plus the off-the-record path it always takes", () => {
  const needs = (body, path = "/api/chat", method = "POST") => featuresFor({ path, method, body });
  assert.deepEqual(needs({ sheets: {}, ephemeral: true }).sort(), ["ephemeral", "sheets"]);
  assert.deepEqual(needs({ sheets: {}, ephemeral: true, private: true }).sort(), ["ephemeral", "ephemeral", "private", "sheets"].sort());
  assert.ok(!needs({ ephemeral: true, messages: [] }).includes("sheets"));
  assert.ok(!needs({ sheets: {} }, "/api/chat", "GET").includes("sheets"));
  assert.ok(!needs({ sheets: {} }, "/v1/chat/completions").includes("sheets"));
});

test("the workspace keeps Sheets out of sight until it's released", () => {
  const src = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(src, /\.filter\(\(\[id\]\) => id !== "sheets" \|\| isReleased\(config, "sheets"\)\)/);
  assert.match(src, /mode === "sheets" && \(!config \|\| isReleased\(config, "sheets"\)\)/);
  assert.match(src, /mode === "sheets" \? \(\s*isReleased\(config, "sheets"\) &&/);
  // Its code is its own chunk, loaded only on the page.
  assert.match(src, /const Sheets = lazy\(\(\) => import\("\.\/Sheets\.jsx"\)\)/);
  // The server copies the shared module it imports.
  assert.match(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"), /src\/sheets-spec\.js/);
});

// ---- The server path ----

const PROFILE = {
  task: "query",
  question: "Which region had the most revenue?",
  rows: 1200,
  columns: [
    { name: "Order date", type: "date" },
    { name: "Region", type: "text", distinct: 4 },
    { name: "Revenue", type: "number" },
  ],
};
const ask = (agent, sheets, extra = {}) =>
  agent.post("/api/chat").send({ model: MODEL, ephemeral: true, sheets, ...extra });

test("a sheets question runs through chat billing off the record, and nothing about it is stored", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const before = balance(s.db, user.id).total;
  const r = await ask(agent, PROFILE).expect(200);
  const reply = replyText(r.text);
  // The test provider planned from the profile the server built the prompt from.
  const planned = JSON.parse(reply);
  assert.deepEqual(planned.groupBy, ["Region"]);
  assert.deepEqual(planned.aggregates, [{ fn: "sum", col: "Revenue", as: "Total Revenue" }]);
  const done = events(r.text).find((e) => e.anonyma);
  assert.ok(done.anonyma.credits_charged > 0, "billed like a message");
  assert.ok(balance(s.db, user.id).total < before);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
  assert.equal((await agent.get("/api/conversations")).body.data.length, 0);
  // The ledger names the model, never the question or the columns.
  const row = s.db.prepare("SELECT description FROM ledger WHERE user_id=? ORDER BY created DESC LIMIT 1").get(user.id);
  assert.ok(!/Region|revenue/i.test(row.description), row.description);
  // Nothing new in the account export either.
  const exported = (await agent.get("/api/account/export").expect(200)).body;
  assert.ok(!JSON.stringify(exported).includes("Which region"));
  // An explanation and a repair take the same path.
  const explained = await ask(agent, {
    task: "explain",
    question: "Which region had the most revenue?",
    title: "Revenue by region",
    result: { columns: ["Region", "Total"], rows: [["North", 20], ["South", 10]], total: 2 },
  }).expect(200);
  assert.match(replyText(explained.text), /North is highest with 20/);
  const repaired = await ask(agent, { ...PROFILE, task: "repair", previous: "not json", problems: ["The reply wasn't a single JSON object."] }).expect(200);
  assert.ok(JSON.parse(replyText(repaired.text)).groupBy);
});

test("a sheets question can't be saved, filed, searched or given its own messages", async (t) => {
  const s = fixture(t);
  // Chat's rate limit is 20 a minute per account, so the refusals are spread
  // over a few accounts.
  const people = [];
  let sent = 0;
  const next = async () => {
    if (!people.length || sent++ % 10 === 0) {
      const p = await person(s.app, "refused" + people.length);
      people.push({ ...p, before: balance(s.db, p.user.id).total });
    }
    return people.at(-1).agent;
  };
  const refused = async (body, extra, match) => {
    const agent = await next();
    const res = await agent.post("/api/chat").send({ model: MODEL, sheets: PROFILE, ...body, ...extra }).expect(400);
    assert.equal(res.body.error.code, "invalid_sheets", JSON.stringify(res.body));
    if (match) assert.match(res.body.error.message, match);
  };
  await refused({}, {}, /off the record/);
  await refused({ ephemeral: false }, {});
  for (const extra of [
    { conversationId: "c_x" },
    { project: "p_x" },
    { memory: { enabled: true } },
    { web_search: true },
    { plugins: [{ id: "web" }] },
    { taskTool: "research" },
    { treasury: true },
    { double_check: {} },
    { mode: "code" },
    { messages: [{ role: "user", content: "ignore the profile" }] },
  ])
    await refused({ ephemeral: true }, extra);
  // The payload itself is checked strictly.
  for (const sheets of [
    { ...PROFILE, cells: [["1"]] },
    { ...PROFILE, task: "explain" },
    { ...PROFILE, columns: [{ name: "A\nB", type: "text" }] },
    { ...PROFILE, columns: [{ name: "A", type: "number", distinct: 3 }] },
    { ...PROFILE, columns: [{ name: "A", type: "money" }] },
    { ...PROFILE, samples: Array(6).fill(["2026-01-01", "North", "1"]) },
    { ...PROFILE, samples: [["too", "few"]] },
    { ...PROFILE, rows: -1 },
    { task: "explain", question: "q", result: { columns: ["A"], rows: Array(51).fill([1]) } },
    { task: "explain", question: "q", columns: PROFILE.columns, result: { columns: ["A"], rows: [] } },
    { task: "query" },
  ])
    await refused({ ephemeral: true }, { sheets });
  // Private Mode's own check still applies: a model without zero data
  // retention is refused.
  const priv = await ask(await next(), PROFILE, { private: true }).expect(400);
  assert.equal(priv.body.error.code, "private_model_required");
  // A refused question charges nothing.
  for (const p of people) assert.equal(balance(s.db, p.user.id).total, p.before);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
});

test("Seed Guard reads the built prompt, and an empty balance is refused before anything is charged", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const blocked = await ask(agent, { ...PROFILE, question: `What is ${seed}?` }).expect(400);
  assert.equal(blocked.body.error.code, "seed_phrase_blocked");
  const inSample = await ask(agent, { ...PROFILE, samples: [["2026-01-01", seed, "1"]] }).expect(400);
  assert.equal(inSample.body.error.code, "seed_phrase_blocked");
  // The workspace's confirmed "Send anyway".
  await ask(agent, { ...PROFILE, question: `What is ${seed}?` }, { allow_seed_phrase: true }).expect(200);
  // Drain the balance: refused, with no hold left behind.
  const left = balance(s.db, user.id).total;
  s.db
    .prepare("INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)")
    .run(uid("l_"), user.id, -left, "payment_correction", "drain", null, "Test drain", now());
  const poor = await ask(agent, PROFILE).expect(402);
  assert.equal(poor.body.error.code, "insufficient_credits");
  assert.equal(balance(s.db, user.id).total, 0);
});

test("the server builds exactly the documented messages, and nothing else", () => {
  const body = { ephemeral: true, sheets: { ...PROFILE, samples: [["2026-01-02", "North", "12.5"]] } };
  prepareSheetsRequest(body);
  assert.equal(body.messages.length, 2);
  assert.equal(body.messages[0].role, "system");
  assert.equal(body.messages[0].content, QUERY_SYSTEM);
  assert.equal(body.messages[1].content, queryText(checkSheetsPayload(body.sheets)));
  assert.equal(body.max_tokens, 8000);
  assert.equal(body.mode, "chat");
  assert.equal(
    body.messages[1].content,
    [
      "Question: Which region had the most revenue?",
      "",
      "The sheet has 1200 rows and 3 columns:",
      '1. "Order date" (date)',
      '2. "Region" (text, 4 different values)',
      '3. "Revenue" (number)',
      "",
      "1 sample row the user chose to share, as JSON arrays in column order:",
      '["2026-01-02","North","12.5"]',
    ].join("\n"),
  );
  const repair = sheetsMessages(checkSheetsPayload({ ...PROFILE, task: "repair", previous: "{oops", problems: ["a", "b"] }));
  assert.deepEqual(repair.map((m) => m.role), ["system", "user", "assistant", "user"]);
  assert.equal(repair[2].content, "{oops");
  assert.match(repair[3].content, /- a\n- b\nReply with the corrected JSON object only\./);
  const explain = sheetsMessages(
    checkSheetsPayload({ task: "explain", question: "Why?", result: { columns: ["A", "B"], rows: [["x", 1]], total: 9 } }),
  );
  assert.equal(explain[0].content, EXPLAIN_SYSTEM);
  assert.equal(explain[1].content, 'Question: Why?\n\nThe result table, as JSON arrays with the header row first:\n["A","B"]\n["x",1]\n\n(These are the first 1 of 9 result rows.)');
  // Requests without `sheets` are untouched.
  const plain = { messages: [{ role: "user", content: "hi" }] };
  prepareSheetsRequest(plain);
  assert.deepEqual(plain, { messages: [{ role: "user", content: "hi" }] });
});

// ---- Reply budgets: room for reasoning, and a plan cut off at the limit ----

test("reply budgets leave room for hidden reasoning and are fitted to the model", () => {
  assert.deepEqual(SHEETS_MAX_TOKENS, { query: 8000, repair: 8000, explain: 3000 });
  const messages = sheetsMessages(checkSheetsPayload(PROFILE));
  // A model with room keeps the full budget.
  assert.equal(sheetsBudget("query", { id: "google/gemini-2.5-flash", context_length: 1048576 }, messages), 8000);
  assert.equal(sheetsBudget("explain", { id: "google/gemini-2.5-flash", context_length: 1048576 }, messages), 3000);
  // Lowered to a smaller output cap, as chat's own max_tokens check would demand.
  assert.equal(sheetsBudget("query", { id: "m", max_output_tokens: 4096, context_length: 128000 }, messages), 4096);
  // An unknown output cap uses the service's conservative 8,192.
  assert.equal(sheetsBudget("repair", { id: "m" }, messages), 8000);
  // And to what the context has left after the prompt.
  const small = { id: "m", context_length: 4096, max_output_tokens: 4096 };
  const budget = sheetsBudget("query", small, messages);
  assert.ok(budget < 4096 && budget > 1000, String(budget));
  assert.ok(budget + messages.reduce((n, m) => n + m.content.length, 0) <= 4096 + 64);
});

async function mockGateway(t, handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return "http://127.0.0.1:" + server.address().port;
}
test("the budgets reach the provider, and a reply cut off at the limit is reported and still charged", async (t) => {
  const seen = [];
  const gateway = await mockGateway(t, async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    const body = JSON.parse(raw);
    seen.push({ max_tokens: body.max_tokens, messages: body.messages.length });
    res.writeHead(200, { "content-type": "text/event-stream" });
    // What the live test saw: the plan cut off mid-string, hidden reasoning
    // having used most of the budget.
    const send = (p) => res.write("data: " + JSON.stringify(p) + "\n\n");
    send({ choices: [{ index: 0, delta: { content: '{"filters":[{"col":"Order date","op":"in","value":["2023-04-01","2023-' } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
    send({ choices: [], usage: { prompt_tokens: 583, completion_tokens: 1996, completion_tokens_details: { reasoning_tokens: 1919 } } });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, "all", { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await person(s.app);
  addCredit(s.db, user.id, 10000000, "sheets-fund", "test_credit");
  const before = balance(s.db, user.id).total;
  const query = await ask(agent, PROFILE).expect(200);
  const done = events(query.text).find((e) => e.anonyma);
  assert.equal(done.anonyma.finish_reason, "length", "the browser learns the reply was cut off");
  assert.ok(done.anonyma.credits_charged > 0, "the call happened, so it's charged");
  assert.ok(balance(s.db, user.id).total < before);
  assert.equal(balance(s.db, user.id).held, 0, "only actual usage settles; the hold is released");
  await ask(agent, { ...PROFILE, task: "repair", previous: "{", problems: ["x"] }).expect(200);
  await ask(agent, {
    task: "explain",
    question: "Why?",
    result: { columns: ["Region", "Total"], rows: [["North", 1]], total: 1 },
  }).expect(200);
  assert.deepEqual(seen, [
    { max_tokens: 8000, messages: 2 },
    { max_tokens: 8000, messages: 4 },
    { max_tokens: 3000, messages: 2 },
  ]);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0, "still nothing stored");
});

test("a plan cut off at the limit isn't sent for repair or run, and says so plainly", async () => {
  const sheet = loaded();
  const { payload, columns } = queryPayload(sheetProfile(sheet), "Sales in April?");
  const truncated = '{"filters":[{"col":"Date","op":"in","value":["2023-04-01","2023-';
  const calls = [];
  const send = (...replies) => async (p) => {
    calls.push(p);
    return replies[calls.length - 1];
  };
  const receipt = (finish_reason) => ({ credits_charged: 2, finish_reason });
  // Cut off: one call, no repair.
  let r = await planQuery({ payload, columns, send: send({ text: truncated, receipt: receipt("length"), finishReason: "length" }) });
  assert.equal(calls.length, 1);
  assert.equal(r.truncated, true);
  assert.equal(r.spec, undefined);
  assert.deepEqual(r.calls, [receipt("length")], "the charge stands");
  // The receipt alone is enough to tell.
  calls.length = 0;
  r = await planQuery({ payload, columns, send: send({ text: truncated, receipt: receipt("length") }) });
  assert.equal(calls.length, 1);
  assert.equal(r.truncated, true);
  // An ordinary bad plan still gets its one repair, and a repair cut off
  // at the limit says so too.
  calls.length = 0;
  r = await planQuery({
    payload,
    columns,
    send: send({ text: "not json", receipt: receipt("stop") }, { text: truncated, receipt: receipt("length") }),
  });
  assert.equal(calls.length, 2);
  assert.equal(r.truncated, true);
  // A plan that parses is used even at the limit.
  calls.length = 0;
  r = await planQuery({
    payload,
    columns,
    send: send({ text: '{"aggregates":[{"fn":"count"}]}', receipt: receipt("length"), finishReason: "length" }),
  });
  assert.equal(calls.length, 1);
  assert.ok(r.spec);
  // The page shows the message for it, as a failed answer with nothing run.
  assert.equal(TRUNCATED_MESSAGE, "The model ran out of room while planning. Try again, or pick a faster model.");
  const page = readFileSync(new URL("../src/Sheets.jsx", import.meta.url), "utf8");
  assert.match(page, /if \(plan\.truncated\) \{\s*update\(id, \{\s*status: "failed",\s*error: TRUNCATED_MESSAGE,/);
  assert.ok(page.indexOf("plan.truncated") < page.indexOf("engine.current.run(spec)"), "returns before running anything");
  assert.match(page, /finishReason: receipt\?\.finish_reason/);
  const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")).strings[TRUNCATED_MESSAGE];
  assert.match(zh, /\p{Script=Han}/u);
});

// ---- Reading files ----

test("the parser follows RFC 4180: quotes, doubled quotes, line breaks in quotes, CRLF, BOM and delimiters", () => {
  assert.deepEqual(parseDelimited('a,b\r\n"x, y","say ""hi"""\r\n'), [["a", "b"], ["x, y", 'say "hi"']]);
  assert.deepEqual(parseDelimited('a,b\n"one\ntwo",3\n'), [["a", "b"], ["one\ntwo", "3"]]);
  assert.deepEqual(parseDelimited('a,b\r"1",2\r'), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseDelimited("﻿a,b\n1,2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseDelimited("a,b,\n1,,\n"), [["a", "b", ""], ["1", "", ""]]);
  assert.deepEqual(parseDelimited('a\n""\n'), [["a"], [""]]);
  // Lenient where real files aren't tidy.
  assert.deepEqual(parseDelimited('a,b\n"x"y,2\n'), [["a", "b"], ["xy", "2"]]);
  assert.deepEqual(parseDelimited('a,b\n1,"open'), [["a", "b"], ["1", "open"]]);
  assert.equal(detectDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.equal(detectDelimiter("a;b;c\n1,5;2;3"), ";");
  assert.equal(detectDelimiter("a|b\n1|2"), "|");
  assert.equal(detectDelimiter('"a,b";c;d\n'), ";", "delimiters inside quotes don't count");
  assert.equal(detectDelimiter("name\tnote, with comma\n", "tsv"), "\t");
  assert.equal(detectDelimiter("single\n1\n"), ",");
  assert.deepEqual(parseDelimited("x;y\n1,5;2", ";"), [["x", "y"], ["1,5", "2"]]);
  assert.equal(sheetKind("A.TSV"), "tsv");
  assert.equal(sheetKind("a.json"), "json");
  assert.equal(sheetKind("book.xlsx"), "workbook");
  assert.equal(sheetKind("notes.txt"), "csv");
  // UTF-16 with a byte-order mark, and UTF-8 with one.
  const utf16 = new Uint8Array([0xff, 0xfe, ...[..."a,b"].flatMap((c) => [c.charCodeAt(0), 0])]);
  assert.equal(decodeBytes(utf16.buffer), "a,b");
  assert.equal(decodeBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]).buffer), "a");
});

test("a loaded sheet: header names cleaned and made unique, blank lines skipped, warnings kept", () => {
  assert.deepEqual(headerNames(["  Name ", "", "Name", "a\u0007b", "x".repeat(200)]), [
    "Name",
    "Column 2",
    "Name (2)",
    "a b",
    "x".repeat(120),
  ]);
  const sheet = loadSheet("\n\nA,B\n1,2\n\n3,4,5\n6\n", { name: "t.csv" });
  assert.equal(sheet.rows, 3);
  assert.deepEqual(sheet.warnings, [{ key: "extra", count: 1 }]);
  assert.deepEqual(sheet.samples, [["1", "2"], ["3", "4"], ["6", ""]]);
  assert.deepEqual(loadSheet('A\n"open', {}).warnings, [{ key: "unterminated" }]);
  assert.throws(() => loadSheet("", {}), /empty/);
  assert.throws(() => loadSheet("A,B\n", {}), /no rows/);
  assert.throws(() => loadSheet("x", { name: "a.xlsx" }), /Save the workbook as CSV/);
  assert.throws(() => loadSheet(Array.from({ length: 201 }, (_, i) => "c" + i).join(",") + "\n1", {}), /more than 200 columns/);
  // JSON: a list of objects (keys in first-seen order) or of arrays.
  const objects = loadSheet(JSON.stringify([{ a: 1, b: "x" }, { b: "y", c: true }, { a: null, d: { n: 1 } }]), { name: "r.json" });
  assert.deepEqual(sheetProfile(objects), {
    rows: 3,
    columns: [
      { name: "a", type: "number" },
      { name: "b", type: "text", distinct: 2 },
      { name: "c", type: "boolean" },
      { name: "d", type: "text", distinct: 1 },
    ],
  });
  assert.equal(sheetProfile(loadSheet('[["n","v"],["a",1],["b",2]]', { name: "r.json" })).rows, 2);
  assert.throws(() => loadSheet("{}", { name: "r.json" }), /list of rows/);
  assert.throws(() => loadSheet("[1,2]", { name: "r.json" }), /objects or a list of arrays/);
  assert.throws(() => loadSheet("{oops", { name: "r.json" }), /couldn't be read/);
});

test("the 500,000-row cap is enforced", () => {
  const big = "n\n" + "1\n".repeat(500001);
  assert.throws(() => loadSheet(big, {}), /more than 500,000 rows/);
  assert.equal(loadSheet("n\n" + "1\n".repeat(500000), {}).rows, 500000);
});

test("types are inferred from the values: numbers, dates, true/false and text", () => {
  for (const [v, n] of [
    ["1,234.50", 1234.5],
    ["-$12", -12],
    ["$-12", -12],
    ["7.5%", 7.5],
    ["1e3", 1000],
    [".5", 0.5],
    ["0", 0],
    ["0.25", 0.25],
    ["+3", 3],
  ])
    assert.equal(parseNumber(v), n, v);
  for (const v of ["00123", "1,23", "12 000", "abc", "", "-", "--1", "1.2.3", "€"]) assert.equal(parseNumber(v), null, v);
  assert.deepEqual(parseDate("2026-03-05"), { t: Date.UTC(2026, 2, 5), time: false });
  assert.deepEqual(parseDate("2026/3/5"), { t: Date.UTC(2026, 2, 5), time: false });
  assert.deepEqual(parseDate("2026-03"), { t: Date.UTC(2026, 2, 1), time: false });
  assert.deepEqual(parseDate("2026-03-05T10:30:00Z"), { t: Date.UTC(2026, 2, 5, 10, 30), time: true });
  assert.deepEqual(parseDate("2026-03-05 10:30"), { t: Date.UTC(2026, 2, 5, 10, 30), time: true });
  assert.deepEqual(parseDate("2026-03-05T10:30:00+02:00"), { t: Date.UTC(2026, 2, 5, 8, 30), time: true });
  for (const v of ["2026-02-30", "2026-13-01", "05/03/2026", "March 5", "2026"]) assert.equal(parseDate(v), null, v);
  assert.equal(inferType(["1", "2.5", "NA"]).type, "number");
  assert.equal(inferType(["yes", "No", "TRUE"]).type, "boolean");
  assert.equal(inferType(["2026-01-01", "2026-02-01"]).type, "date");
  assert.deepEqual(inferType(["2026-01-01", "2026-02-01T10:00:00Z"]), { type: "date", time: true });
  assert.equal(inferType(["1", "two"]).type, "text");
  assert.equal(inferType(["0123", "0456"]).type, "text", "leading zeros are identifiers");
  assert.equal(inferType(["NA", "null"]).type, "text", "only placeholders");
  assert.equal(inferType([]).type, "text");
  assert.deepEqual(sheetProfile(loaded()), {
    rows: 6,
    columns: [
      { name: "Date", type: "date" },
      { name: "Region", type: "text", distinct: 4 },
      { name: "Rep", type: "text", distinct: 3 },
      { name: "Units", type: "number" },
      { name: "Price", type: "number" },
      { name: "Paid", type: "boolean" },
      { name: "Note", type: "text", distinct: 4 },
    ],
  });
});

// ---- The query plan ----

test("plans are checked strictly: unknown fields, columns, ops, types and oversized limits are refused", () => {
  const c = cols(loaded());
  const problems = (raw) => validateSpec(raw, c).problems || [];
  assert.match(problems({ select: ["Region"] }).join(), /Unknown field "select"/);
  assert.match(problems({ filters: [{ col: "Revenue", op: "=", value: 1 }] }).join(), /"Revenue" isn't a column/);
  assert.match(problems({ filters: [{ col: "Units", op: "like", value: 1 }] }).join(), /unknown op "like"/);
  assert.match(problems({ filters: [{ col: "Units", op: "=", value: 1, extra: 1 }] }).join(), /must be \{"col", "op", "value"\}/);
  assert.match(problems({ filters: [{ col: "Region", op: ">", value: "a" }] }).join(), /needs a number or date column/);
  assert.match(problems({ filters: [{ col: "Units", op: "contains", value: "1" }] }).join(), /contains needs a text column/);
  assert.match(problems({ filters: [{ col: "Units", op: "=", value: "many" }] }).join(), /must be a number/);
  assert.match(problems({ filters: [{ col: "Date", op: "=", value: "yesterday" }] }).join(), /must be a date/);
  assert.match(problems({ filters: [{ col: "Units", op: "between", value: [5, 1] }] }).join(), /low value is above/);
  assert.match(problems({ filters: [{ col: "Units", op: "in", value: [] }] }).join(), /needs a list/);
  assert.match(problems({ filters: [{ col: "Units", op: ">", value: null }] }).join(), /null works only/);
  assert.match(problems({ aggregates: [{ fn: "sum", col: "Region" }] }).join(), /sum needs a number column/);
  assert.match(problems({ aggregates: [{ fn: "max", col: "Paid" }] }).join(), /number or date column/);
  assert.match(problems({ aggregates: [{ fn: "avg" }] }).join(), /avg needs a column/);
  assert.match(problems({ aggregates: [{ fn: "stddev", col: "Units" }] }).join(), /unknown fn/);
  assert.match(problems({ groupBy: [{ col: "Region", bucket: "month" }] }).join(), /bucket needs a date column/);
  assert.match(problems({ groupBy: ["Region"], aggregates: [{ fn: "count", as: "Region" }] }).join(), /used twice/);
  assert.match(problems({ groupBy: ["Region"], sort: [{ by: "Units", dir: "desc" }] }).join(), /isn't an output name/);
  assert.match(problems({ groupBy: ["Region"], sort: [{ by: "Region", dir: "down" }] }).join(), /dir must be/);
  assert.match(problems({ groupBy: ["Region"], chart: { type: "bar", x: "Region", y: "Region" } }).join(), /must be a number/);
  assert.match(problems({ chart: { type: "radar" } }).join(), /chart type/);
  for (const limit of [0, 1001, 2.5, "10", 1e9]) assert.match(problems({ limit }).join(), /"limit" must be/, String(limit));
  assert.match(problems({ filters: Array(21).fill({ col: "Units", op: ">", value: 1 }) }).join(), /at most 20/);
  assert.equal(validateSpec([], c).problems[0], "The reply must be one JSON object.");
  assert.ok(problems({}).length === 0, "an empty plan lists rows");
  assert.equal(validateSpec({ limit: 1000 }, c).spec.limit, 1000);
});

test("replies: JSON is pulled out of code fences, a refusal is kept, anything else goes back for one repair", async () => {
  const c = cols(loaded());
  assert.deepEqual(extractJSON('Sure!\n```json\n{"limit": 3}\n```'), { limit: 3 });
  assert.equal(extractJSON("no json here"), undefined);
  assert.deepEqual(interpretReply('{"error": "There is no cost column."}', c), { refusal: "There is no cost column." });
  assert.deepEqual(interpretReply("I think the answer is North", c).problems, ["The reply wasn't a single JSON object."]);
  // planQuery: one repair with the problems and the previous reply, then give up.
  const sent = [];
  const scripted = (...replies) => async (p) => {
    sent.push(p);
    return { text: replies[sent.length - 1], receipt: { credits_charged: 1 } };
  };
  const { payload, columns } = queryPayload(sheetProfile(loaded()), "Units by region?");
  let r = await planQuery({ payload, columns, send: scripted("nope", '{"groupBy":["Region"],"aggregates":[{"fn":"sum","col":"Units"}]}') });
  assert.equal(sent.length, 2);
  assert.equal(sent[1].task, "repair");
  assert.equal(sent[1].previous, "nope");
  assert.deepEqual(sent[1].problems, ["The reply wasn't a single JSON object."]);
  checkSheetsPayload(sent[1]);
  assert.ok(r.spec);
  assert.equal(r.calls.length, 2);
  sent.length = 0;
  r = await planQuery({ payload, columns, send: scripted('{"limit": 5000}', '{"limit": 9999}') });
  assert.equal(sent.length, 2, "only one repair");
  assert.match(r.problems[0], /"limit" must be/);
  assert.equal(r.text, '{"limit": 9999}');
  sent.length = 0;
  r = await planQuery({ payload, columns, send: scripted('{"error":"No region column."}') });
  assert.equal(sent.length, 1, "a refusal isn't retried");
  assert.equal(r.refusal, "No region column.");
  sent.length = 0;
  r = await planQuery({ payload, columns, send: scripted("") });
  assert.equal(sent[1].previous, "(an empty reply)");
});

// ---- Running a plan ----

test("filters: numbers, dates by whole day, text ignoring case, true/false, empty cells, in and between", () => {
  const sheet = loaded();
  const count = (filters) => run(sheet, { filters, aggregates: [{ fn: "count" }] }).rows[0][0];
  assert.equal(count([]), 6);
  assert.equal(count([{ col: "Region", op: "=", value: "NORTH" }]), 2);
  assert.equal(count([{ col: "Region", op: "!=", value: "north" }]), 3, "empty cells never match !=");
  assert.equal(count([{ col: "Region", op: "=", value: null }]), 1);
  assert.equal(count([{ col: "Region", op: "!=", value: null }]), 5);
  assert.equal(count([{ col: "Region", op: "in", value: ["south", "East"] }]), 3);
  assert.equal(count([{ col: "Note", op: "contains", value: "LINE" }]), 1);
  assert.equal(count([{ col: "Units", op: ">", value: 3 }]), 2);
  assert.equal(count([{ col: "Units", op: ">=", value: 3 }]), 3);
  assert.equal(count([{ col: "Units", op: "<", value: 3 }]), 2);
  assert.equal(count([{ col: "Units", op: "<=", value: 3 }]), 3);
  assert.equal(count([{ col: "Units", op: "between", value: [2, 4] }]), 3);
  assert.equal(count([{ col: "Units", op: "=", value: null }]), 1);
  assert.equal(count([{ col: "Price", op: ">", value: "999" }]), 1, "numeric strings are read as numbers");
  assert.equal(count([{ col: "Paid", op: "=", value: true }]), 4);
  assert.equal(count([{ col: "Paid", op: "!=", value: "yes" }]), 2);
  assert.equal(count([{ col: "Date", op: "=", value: "2026-03-15" }]), 1, "a date matches its whole day");
  assert.equal(count([{ col: "Date", op: ">", value: "2026-03-01" }]), 1);
  assert.equal(count([{ col: "Date", op: ">=", value: "2026-03-01" }]), 2);
  assert.equal(count([{ col: "Date", op: "<", value: "2026-02-03" }]), 2);
  assert.equal(count([{ col: "Date", op: "<=", value: "2026-02-03" }]), 3);
  assert.equal(count([{ col: "Date", op: "between", value: ["2026-02-01", "2026-03-01"] }]), 3);
  assert.equal(count([{ col: "Date", op: ">=", value: "2026-03-15T10:00:00Z" }]), 0);
  assert.equal(count([{ col: "Region", op: "=", value: "south" }, { col: "Paid", op: "=", value: true }]), 2);
});

test("grouping and aggregates: count, sum, avg, min, max, median and distinct, with date buckets", () => {
  const sheet = loaded();
  const byRegion = run(sheet, {
    groupBy: ["Region"],
    aggregates: [
      { fn: "count", as: "rows" },
      { fn: "sum", col: "Units" },
      { fn: "avg", col: "Price" },
      { fn: "distinct", col: "Rep" },
    ],
    sort: [{ by: "sum(Units)", dir: "desc" }],
  });
  assert.deepEqual(byRegion.columns.map((c) => c.name), ["Region", "rows", "sum(Units)", "avg(Price)", "distinct(Rep)"]);
  // Text groups keep case as written; "North" and "north" are different values.
  assert.deepEqual(byRegion.rows, [
    ["South", 2, 9, 506.125, 2],
    ["North", 1, 3, 10.5, 1],
    ["East", 1, 2, 20, 1],
    ["north", 1, 1, 99, 1],
    [null, 1, 0, 5, 1],
  ]);
  assert.deepEqual(byRegion.stats, { total: 6, matched: 6, groups: 5, shown: 5, truncated: false });
  const monthly = run(sheet, {
    groupBy: [{ col: "Date", bucket: "month" }],
    aggregates: [{ fn: "median", col: "Price" }, { fn: "min", col: "Date" }, { fn: "max", col: "Units" }],
  });
  assert.deepEqual(monthly.rows, [
    ["2026-01", 54.75, "2026-01-05T00:00:00Z", 3],
    ["2026-02", 510, "2026-02-03T00:00:00Z", 5],
    ["2026-03", 8.625, "2026-03-01T00:00:00Z", 4],
  ]);
  assert.deepEqual(run(sheet, { groupBy: [{ col: "Date", bucket: "quarter" }] }).rows, [["2026-Q1", 6]], "grouping alone counts rows");
  assert.deepEqual(run(sheet, { groupBy: [{ col: "Date", bucket: "year" }] }).rows, [["2026", 6]]);
  assert.deepEqual(run(sheet, { groupBy: ["Paid", "Rep"], limit: 2 }).rows, [
    [false, "Ben", 2],
    [true, "Ana", 2],
  ]);
  const totals = run(sheet, { aggregates: [{ fn: "sum", col: "Price" }, { fn: "count", col: "Units" }] });
  assert.deepEqual(totals.rows, [[1146.75, 5]]);
  // Floating-point noise is tidied: 0.1 + 0.2 is 0.3.
  const tidy = loadSheet("n\n0.1\n0.2\n");
  assert.equal(runSpec(tidy, validateSpec({ aggregates: [{ fn: "sum", col: "n" }] }, cols(tidy)).spec).rows[0][0], 0.3);
  // Nothing matched: counts are 0, averages empty.
  const none = run(sheet, { filters: [{ col: "Units", op: ">", value: 100 }], aggregates: [{ fn: "count" }, { fn: "avg", col: "Units" }] });
  assert.deepEqual(none.rows, [[0, null]]);
});

test("listing rows: sorted with empty cells last, limited, all columns shown", () => {
  const sheet = loaded();
  const r = run(sheet, { sort: [{ by: "Units", dir: "desc" }], limit: 3 });
  assert.deepEqual(r.columns.map((c) => c.name), ["Date", "Region", "Rep", "Units", "Price", "Paid", "Note"]);
  assert.deepEqual(r.rows.map((x) => x[3]), [5, 4, 3]);
  // A line break inside quotes is kept as written (CRLF here).
  assert.deepEqual(r.rows[0], ["2026-02-03T00:00:00Z", "South", "Ana", 5, 1000, true, "line one\r\nline two"]);
  assert.deepEqual(r.stats, { total: 6, matched: 6, groups: 6, shown: 3, truncated: true });
  const asc = run(sheet, { sort: [{ by: "Units", dir: "asc" }] });
  assert.equal(asc.rows.at(-1)[3], null, "empty last");
  const text = run(sheet, { sort: [{ by: "Rep", dir: "asc" }, { by: "Price", dir: "desc" }] });
  assert.deepEqual(text.rows.map((x) => [x[2], x[4]]), [["Ana", 1000], ["Ana", 10.5], ["Ben", 99], ["Ben", 5], ["Cy", 20], ["Cy", 12.25]]);
  const many = loadSheet("n\n" + Array.from({ length: 250 }, (_, i) => i).join("\n"));
  assert.equal(runSpec(many, validateSpec({}, cols(many)).spec).rows.length, DEFAULT_LIST_LIMIT);
});

test("the sample sheet is made up, stable, and answers the demo question", () => {
  const csv = sampleSheetCSV();
  assert.equal(csv, sampleSheetCSV(), "the same every time");
  const sheet = loadSheet(csv, { name: "sample-sales.csv" });
  assert.equal(sheet.rows, 1200);
  const reply = sheetsTestReply(sheetsMessages(checkSheetsPayload(queryPayload(sheetProfile(sheet), "Which region had the most revenue?").payload)));
  const r = interpretReply(reply, cols(sheet));
  assert.ok(r.spec, JSON.stringify(r));
  const result = runSpec(sheet, realizeSpec(r.spec));
  assert.deepEqual(result.rows.map((x) => x[0]), ["North", "South", "East", "West"]);
  assert.equal(chartSeries(result, r.spec.chart).type, "bar");
  // Over time: a line by month.
  const monthly = interpretReply(
    sheetsTestReply(sheetsMessages(checkSheetsPayload(queryPayload(sheetProfile(sheet), "Revenue by month?").payload))),
    cols(sheet),
  );
  assert.equal(runSpec(sheet, monthly.spec).rows.length, 6);
  assert.equal(monthly.spec.chart.type, "line");
});

// ---- What the model is sent ----

test("a question's payload has no cell values unless sample rows are ticked, and then exactly those", () => {
  const sheet = loaded();
  const cells = new Set(
    SALES.split(/\r\n|,/)
      .map((c) => c.replace(/"/g, "").trim())
      // Distinctive cells only: a digit like "3" is also in "3 columns".
      .filter((c) => c.length >= 4 && !/^\d+$/.test(c) && !/^(Date|Region|Rep|Units|Price|Paid|Note)$/.test(c)),
  );
  const { payload } = queryPayload(sheetProfile(sheet), "How many units?");
  const sent = JSON.stringify(payload) + sheetsMessages(checkSheetsPayload(payload)).map((m) => m.content).join();
  for (const cell of cells) assert.ok(!sent.includes(cell), `cell ${cell} leaked`);
  assert.deepEqual(Object.keys(payload).sort(), ["columns", "question", "rows", "task"]);
  const withRows = queryPayload(sheetProfile(sheet), "How many units?", { samples: sheet.samples }).payload;
  assert.equal(withRows.samples.length, 5);
  assert.deepEqual(withRows.samples[0], ["2026-01-05", "North", "Ana", "3", "10.50", "yes", "first, of the year"]);
  assert.deepEqual(withRows.samples[2][6], "line one line two", "line breaks in a sample become spaces");
  assert.ok(!JSON.stringify(withRows).includes("2026-03-15"), "the sixth row isn't a sample");
  checkSheetsPayload(withRows);
  // Long sample cells are cut to 100 characters.
  const long = loadSheet(`a\n${"x".repeat(300)}\n`);
  assert.equal(queryPayload(sheetProfile(long), "q", { samples: long.samples }).payload.samples[0][0].length, LIMITS.cell);
});

test("an explanation sends only the question, the title and the result table, at most 50 rows", () => {
  const rows = Array.from({ length: 80 }, (_, i) => [`r${i}`, i, i % 2 === 0, null]);
  const result = { columns: [{ name: "Name" }, { name: "n" }, { name: "even" }, { name: "gap" }], rows, stats: {} };
  const p = explainPayload(result, " Why? ", "Title\nhere");
  assert.deepEqual(Object.keys(p).sort(), ["question", "result", "task", "title"]);
  assert.equal(p.result.rows.length, 50);
  assert.equal(p.result.total, 80);
  assert.equal(p.title, "Title here");
  assert.equal(p.question, "Why?");
  checkSheetsPayload(p);
  const wide = { columns: Array.from({ length: 20 }, (_, i) => ({ name: "c" + i })), rows: [Array(20).fill(1)] };
  assert.equal(explainPayload(wide, "q").result.columns.length, 12);
});

test("Veil masks the question, column names and samples; the plan is unmasked in the browser before it runs", () => {
  const sheet = loadSheet("Owner email,Amount\nana@example.com,5\nben@example.com,7\nana@example.com,1\n");
  const state = createVeilState();
  const mask = (s) => veil(s, state, []).text;
  const { payload, columns } = queryPayload(sheetProfile(sheet), "Total for ana@example.com?", { samples: sheet.samples, mask });
  const sent = JSON.stringify(payload);
  assert.ok(!sent.includes("ana@example.com") && !sent.includes("ben@example.com"), sent);
  assert.match(payload.question, /\[EMAIL_1\]/);
  // The model's plan uses the placeholder it was shown.
  const reply = JSON.stringify({
    title: "Total for [EMAIL_1]",
    filters: [{ col: "Owner email", op: "=", value: "[EMAIL_1]" }],
    aggregates: [{ fn: "sum", col: "Amount", as: "Total" }],
  });
  const r = interpretReply(reply, columns);
  const spec = realizeSpec(r.spec, (s) => unveil(s, state.map));
  assert.equal(spec.title, "Total for ana@example.com");
  assert.deepEqual(runSpec(sheet, spec).rows, [[6]]);
});

// ---- Output ----

test("CSV export quotes what it must and defuses spreadsheet formulas", () => {
  const csv = toCSV({
    columns: [{ name: "Name" }, { name: "=SUM(A1)" }],
    rows: [
      ['say "hi", ok', -5],
      ["+1 555", null],
      ["@cmd", 1.5],
      [" padded", true],
    ],
  });
  assert.equal(
    csv,
    '﻿Name,\'=SUM(A1)\r\n"say ""hi"", ok",-5\r\n\'+1 555,\r\n\'@cmd,1.5\r\n" padded",true\r\n',
  );
  assert.deepEqual(niceTicks(0, 94185), [0, 20000, 40000, 60000, 80000, 100000]);
  assert.deepEqual(niceTicks(-5, 5, 4), [-5, -2.5, 0, 2.5, 5]);
  assert.deepEqual(niceTicks(0, 0), [0, 1]);
  const series = chartSeries(
    { columns: [{ name: "k" }, { name: "v" }], rows: [["a", 1], ["b", null], ["c", -2]] },
    { type: "pie", x: 0, y: 1 },
  );
  assert.equal(series.type, "bar", "a pie can't show negative values");
  assert.equal(series.points.length, 2);
});

test("how it was calculated reads as plain words in English and Chinese, values shown as written", () => {
  const sheet = loaded();
  const spec = realizeSpec(
    plan(sheet, {
      filters: [{ col: "Region", op: "in", value: ["South", "East"] }, { col: "Date", op: ">=", value: "2026-02-01" }],
      groupBy: ["Region"],
      aggregates: [{ fn: "sum", col: "Units", as: "Units sold" }],
      sort: [{ by: "Units sold", dir: "desc" }],
      limit: 1,
    }),
  );
  const result = runSpec(sheet, spec);
  const words = (lang) =>
    describeSpec(spec, cols(sheet), result.stats, lang).map((l) => l.map((p) => (typeof p === "string" ? p : `[${p.v}]`)).join(""));
  assert.deepEqual(words("en"), [
    "Kept the 3 of 6 rows where [Region] is [South] or [East] and [Date] is on or after [2026-02-01].",
    "Grouped them by [Region]: 2 groups.",
    "Calculated the sum of [Units] (shown as [Units sold]) for each group.",
    "Sorted by [Units sold], largest first.",
    "Showing the first 1 of 2 rows.",
    "All calculated on this device: the AI only planned the steps and never saw the rows.",
  ]);
  const zh = words("zh");
  assert.equal(zh[0], "在 6 行中保留了 [Region] 为 [South] 或 [East]，且 [Date] 不早于 [2026-02-01] 的 3 行。");
  for (const line of zh) assert.doesNotMatch(line.replace(/\[[^\]]*\]/g, "").replaceAll("AI", ""), /[A-Za-z]{2}/, line);
});

// ---- The engine (in-page fallback for the worker) ----

test("the engine loads, runs and forgets a sheet, and refuses files over 50 MB before reading them", async () => {
  const state = { sheet: null };
  const load = await handleSheetMessage(state, { id: 1, type: "load", text: SALES, name: "sales.csv" });
  assert.equal(load.profile.rows, 6);
  assert.equal(load.samples.length, 5);
  const spec = plan(loaded(), { aggregates: [{ fn: "count" }] });
  assert.deepEqual((await handleSheetMessage(state, { id: 2, type: "run", spec })).result.rows, [[6]]);
  assert.deepEqual(await handleSheetMessage(state, { id: 3, type: "close" }), { id: 3, closed: true });
  assert.equal(state.sheet, null);
  assert.match((await handleSheetMessage(state, { id: 4, type: "run", spec })).error, /Open a sheet first/);
  let read = false;
  const huge = { size: 50 * 1024 * 1024 + 1, arrayBuffer: async () => ((read = true), new ArrayBuffer(0)) };
  assert.match((await handleSheetMessage(state, { id: 5, type: "load", file: huge, name: "big.csv" })).error, /larger than 50 MB/);
  assert.equal(read, false);
  const file = { size: 12, arrayBuffer: async () => new TextEncoder().encode("a,b\n1,2\n").buffer };
  assert.equal((await handleSheetMessage(state, { id: 6, type: "load", file, name: "f.csv" })).profile.rows, 1);
});

// ---- Chinese ----

test("Chinese covers the update's copy and the page's strings", () => {
  const raw = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
  const dict = compileDictionary(raw);
  const zh = (en) => translateText(en, dict);
  const entry = UPDATES.find((u) => u.id === "sheets");
  for (const s of [entry.title, entry.tagline, ...entry.points]) assert.match(zh(s) || "", /\p{Script=Han}/u, s);
  for (const s of [
    "Sheets",
    "What the AI sees",
    "Try a sample sheet",
    "How this was calculated",
    "Explain this result",
    "Download CSV",
    "Also share 5 sample rows",
    "1,200 rows · 7 columns · Read on this device",
    "12.5 credits this session",
    "4 different values",
    "Showing 200 of 1,000 rows here; the CSV has them all.",
    "This sheet has more than 500,000 rows. Split it into smaller files and open one at a time.",
    "Local Sheets is coming soon.",
  ])
    assert.match(zh(s) || "", /\p{Script=Han}/u, s);
  assert.equal(zh("1,200 rows · 7 columns · Read on this device"), "1,200 行 · 7 列 · 在本设备上读取");
});
