import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { addCredit, usdUnits, standardFactor, credits, now } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { orderPair, roundSealer, TOKEN_TTL_MS } from "../server/routes/blind.js";
import { buildChatRequest } from "../src/estimate.js";
import { messageFromServer } from "../src/lib.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  blindPool,
  surprisePair,
  defaultPair,
  validPair,
  chosenSide,
  historyText,
  blindText,
  rankings,
  applyBlindEvent,
  pendingBlind,
  canVote,
  revealTurn,
  closeTurn,
  formatSpeed,
  typicalPrice,
} from "../src/blind.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// Two ordinary chat models with different makers and prices.
const ONE = "google/gemini-2.5-flash";
const TWO = "glm-5.3";
// A private (zero data retention) model, by the operator override.
const PRIVATE = "venice/venice-uncensored-1-2";
// Each model's reply comes back with a word only this test knows, and a
// reported cost, so a side can be matched to its model without the stream
// ever naming one.
const WORD = { [ONE]: "saffron", [TWO]: "cobalt", [PRIVATE]: "umber" };
const COST = { [ONE]: 0.0012, [TWO]: 0.0034, [PRIVATE]: 0.0021 };

function fixture(t, { released, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-blind-"));
  const s = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "catalog.json"),
    origin: "http://localhost:5175",
    privateModels: [PRIVATE],
    ...(released && released !== "all" ? { mvpModels: [ONE, TWO] } : {}),
    ...extra,
  });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
// A stand-in gateway: answers per model, or refuses the models in `refuse`.
async function gateway(t, { refuse = [] } = {}) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    bodies.push(body);
    if (refuse.includes(body.model)) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end('{"error":{"message":"Fixture refusal"}}');
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "The answer is " } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: WORD[body.model] || "plain" }, finish_reason: "stop" }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 4 }, cost: COST[body.model] ?? 0.001 })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  return { url: `http://127.0.0.1:${server.address().port}`, bodies };
}
async function live(t, opts = {}, fixtureOpts = {}) {
  const g = await gateway(t, opts);
  const s = fixture(t, { testMode: false, gateway: g.url, gatewayKey: "fixture", ...fixtureOpts });
  return { s, g };
}
let visitor = 0;
async function person(s, name = "tester", balance = 1e8) {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username: name, password: "local-fixture-password" })
    .expect(201);
  if (balance) addCredit(s.db, r.body.user.id, balance, "fixture-" + r.body.user.id);
  return { agent, user: r.body.user };
}
const ask = (content = "Which is better for a quiet weekend?") => [{ role: "user", content }];
const round = (p, body = {}) =>
  p.agent.post("/api/blind").send({
    models: [ONE, TWO],
    messages: ask(),
    max_tokens: 1000,
    requestId: "r" + ++visitor,
    ...body,
  });
const eventsOf = (r) =>
  r.text
    .split("\n\n")
    .filter((x) => x.startsWith("data: {"))
    .map((x) => JSON.parse(x.slice(6)));
const finalOf = (r) => eventsOf(r).at(-1).blind;
const textOf = (r, side) =>
  eventsOf(r)
    .filter((e) => e.side === side && e.delta?.content)
    .map((e) => e.delta.content)
    .join("");
const holds = (s, user) =>
  s.db.prepare("SELECT id,status,amount,result FROM holds WHERE user_id=? ORDER BY id").all(user);
const ledger = (s, user) =>
  s.db.prepare("SELECT amount,description FROM ledger WHERE user_id=? AND amount<0 ORDER BY rowid").all(user);

// ---- The release gate ----

test("unreleased: every route is refused, nothing shows, nothing is exported, and the API docs leave it out", async (t) => {
  const mvp = fixture(t, { released: "mvp" });
  const a = await person(mvp, "ana");
  for (const send of [
    () => a.agent.post("/api/blind").send({ models: [ONE, TWO], messages: ask() }),
    () => a.agent.post("/api/blind/votes").send({ round: "x", outcome: "a" }),
    () => a.agent.get("/api/blind/rankings"),
    () => a.agent.delete("/api/blind/rankings"),
    () => a.agent.post("/API/Blind/").send({}),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Blind Compare is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(mvp.app).get("/api/blind/rankings").expect(403);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.blind, false);
  const entry = config.releases.updates.find((u) => u.id === "blind");
  assert.equal(entry.title, "Blind Compare");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(closed.paths).some((p) => p.includes("blind")));
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.ok(!("blindVotes" in exported), "no blindVotes key while unreleased and empty");
  assert.equal(mvp.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);

  // The committed entry, with its icon on the roadmap.
  const committedEntry = UPDATES.findIndex((u) => u.id === "blind");
  assert.equal(typeof committed[committedEntry], "boolean");
  assert.match(readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8"), /\bblind: "scale"/);

  // A round needs whatever the same chat would.
  const gates = (body, path = "/api/blind") => featuresFor({ path, method: "POST", body });
  assert.deepEqual(gates({}), ["blind"]);
  assert.deepEqual(gates({ mode: "code" }), ["blind", "code"]);
  assert.deepEqual(gates({ mode: "uncensored" }), ["blind", "uncensored"]);
  assert.deepEqual(gates({ ephemeral: true }), ["blind", "ephemeral"]);
  assert.deepEqual(gates({ private: true }), ["blind", "ephemeral", "private"]);
  assert.deepEqual(gates({ project: "p_1" }), ["blind", "projects"]);
  assert.deepEqual(gates({ veil_masked: 2 }), ["blind", "trail"]);
  assert.deepEqual(gates({ allow_seed_phrase: true }), ["blind", "seedguard"]);
  assert.deepEqual(gates({ mode: "code" }, "/api/blind/votes"), ["blind"]);
  assert.deepEqual(featuresFor({ path: "/api/blind/rankings", method: "DELETE", body: {} }), ["blind"]);
  // Nothing else is gated by it.
  for (const path of ["/api/chat", "/api/conversations", "/api/account/export", "/api/blindfold"])
    assert.ok(!featuresFor({ path, method: "POST", body: {} }).includes("blind"), path);

  // Released on its own (with the MVP's models), it needs nothing else.
  const g = await gateway(t);
  const own = fixture(t, { released: "mvp,blind", testMode: false, gateway: g.url, gatewayKey: "fixture" });
  const b = await person(own, "ben");
  const r = await round(b).expect(200);
  assert.ok(finalOf(r).round);
  const open = (await request(own.app).get("/api/openapi.json").expect(200)).body;
  for (const [path, methods] of [
    ["/api/blind", ["post"]],
    ["/api/blind/votes", ["post"]],
    ["/api/blind/rankings", ["get", "delete"]],
  ])
    for (const m of methods) assert.ok(open.paths[path]?.[m], `${m} ${path}`);
  // A code round needs Code & Build too.
  const code = await round(b, { mode: "code" }).expect(403);
  assert.equal(code.body.error.message, "Code & Build is coming soon.");
});

test("the workspace shows Blind only once it's released, signed in, outside the demo and a shared or sealed chat", () => {
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  const blindUi = readFileSync(new URL("../src/Blind.jsx", import.meta.url), "utf8");
  assert.match(blindUi, /export const blindReleased = \(config\) => isReleased\(config, "blind"\);/);
  assert.match(ws, /const blindLive = !demo && !!user && blindReleased\(config\) && textMode;/);
  assert.match(ws, /const blindActive = blindLive && blindOn && !sealedOn && !sealedThread && !shared;/);
  // Every Blind surface hangs off those two.
  assert.match(ws, /\{blindLive && !shared && \(\s*<BlindToggle/);
  assert.match(ws, /\{blindActive && \(\s*<BlindBar/);
  assert.match(ws, /\{blindRankings && blindLive && <BlindRankings/);
  assert.match(ws, /blindActive \? \(\s*<BlindEstimate/);
  assert.match(ws, /voting=\{blindVoting != null \|\| !blindLive\}/);
  // Web search, Cost Compare and @mentions step aside in Blind (Team pays
  // lives in shared chats, where Blind never is).
  assert.match(ws, /isReleased\(config, "search"\) &&\s*\/\/ Blind never searches the web\.\s*!blindActive && \(/);
  assert.match(ws, /costCompareLive && !blindActive/);
  assert.match(ws, /const mention = textMode && !sealedOn && !blindActive/);
  // Data controls and Panic Wipe say what's kept and wiped, once released.
  const read = (f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  assert.match(read("DataControls.jsx"), /const blind = !!config && isReleased\(config, "blind"\);/);
  assert.match(read("PanicWipe.jsx"), /\{blindLive && <li>\{WIPE_BLIND\}<\/li>\}/);
  // Sealed Mode switches Blind off.
  assert.match(ws, /setWebSearch\(false\);\s*setBlindOn\(false\);/);
});

// ---- Billing ----

test("both replies are billed through the normal hold and settle path, each for what it used", async (t) => {
  const { s, g } = await live(t);
  const p = await person(s);
  const r = await round(p).expect(200);
  const done = finalOf(r);
  assert.equal(g.bodies.length, 2);
  assert.deepEqual(g.bodies.map((b) => b.model).sort(), [ONE, TWO].sort());
  const factor = standardFactor(s.cfg);
  const expected = { [ONE]: usdUnits(COST[ONE] * factor), [TWO]: usdUnits(COST[TWO] * factor) };
  // Two holds, both settled on their own reported cost; two ledger entries.
  const h = holds(s, p.user.id);
  assert.equal(h.length, 2);
  assert.ok(h.every((x) => x.status === "settled"));
  const spent = ledger(s, p.user.id);
  assert.equal(spent.length, 2);
  const total = expected[ONE] + expected[TWO];
  assert.equal(-spent.reduce((n, x) => n + x.amount, 0), total);
  assert.equal(done.credits_charged, credits(total));
  // The reveal gives each side its own charge, matching its model.
  const v = await p.agent.post("/api/blind/votes").send({ round: done.round, outcome: "a" }).expect(200);
  for (const side of ["a", "b"]) {
    const { model, credits: c } = v.body.reveal[side];
    assert.equal(c, credits(expected[model]), side);
    assert.ok(textOf(r, side).includes(WORD[model]), "side " + side + " is " + model);
    const hold = h.find((x) => x.id.endsWith(":" + side));
    assert.equal(JSON.parse(hold.result).charged, expected[model]);
  }
});

test("one side failing charges only the other, and the round is revealed without a vote", async (t) => {
  const { s, g } = await live(t, { refuse: [TWO] });
  const p = await person(s);
  const r = await round(p).expect(200);
  const done = finalOf(r);
  assert.equal(g.bodies.length, 2, "both were sent");
  const failed = Object.entries(done.sides).find(([, x]) => x.status === "failed");
  const ok = Object.entries(done.sides).find(([, x]) => x.status === "done");
  assert.ok(failed && ok);
  assert.equal(done.round, null, "nothing to vote on");
  assert.equal(done.reveal.outcome, null);
  assert.equal(done.reveal[failed[0]].model, TWO);
  assert.equal(done.reveal[failed[0]].credits, 0);
  assert.equal(done.reveal[ok[0]].model, ONE);
  const expected = usdUnits(COST[ONE] * standardFactor(s.cfg));
  assert.equal(done.credits_charged, credits(expected));
  const h = holds(s, p.user.id);
  assert.deepEqual(h.map((x) => x.status).sort(), ["released", "settled"]);
  assert.equal(-ledger(s, p.user.id).reduce((n, x) => n + x.amount, 0), expected);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM blind_votes").get().n, 0);
  // The saved reply keeps both sides and the reveal.
  const conv = (await p.agent.get("/api/conversations/" + done.conversationId).expect(200)).body;
  const saved = messageFromServer(conv.messages.at(-1));
  assert.equal(saved.blind.reveal.outcome, null);
  assert.equal(saved.blind[failed[0]].status, "failed");
  assert.ok(!("token" in saved.blind));
});

test("a side refused before sending releases the other: nothing is sent or charged", async (t) => {
  // Two models priced the same, so whichever side reserves first leaves
  // too little for the other.
  const A = "gpt-6-astra-pro",
    B = "claude-fable-5.1";
  const { s, g } = await live(t);
  const probe = await person(s, "probe");
  const q = (await probe.agent.post("/api/quote").send({ model: A, messages: ask(), max_tokens: 1000 }).expect(200)).body;
  const unit = usdUnits(q.usd);
  const p = await person(s, "short", Math.floor(unit * s.cfg.holdMargin + unit / 2));
  const r = await round(p, { models: [A, B] }).expect(402);
  assert.equal(r.body.error.code, "insufficient_credits");
  assert.equal(g.bodies.length, 0, "no provider call");
  const h = holds(s, p.user.id);
  assert.ok(h.every((x) => x.status === "released"), JSON.stringify(h));
  assert.equal(ledger(s, p.user.id).length, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0, "nothing saved");
});

// ---- Order and identity stay hidden ----

test("the order is random per round, and nothing streamed names a model or a side's own cost", async (t) => {
  // orderPair: a fair coin, both ways.
  assert.deepEqual(orderPair(["x", "y"], () => 0), ["x", "y"]);
  assert.deepEqual(orderPair(["x", "y"], () => 1), ["y", "x"]);
  let flipped = 0;
  for (let i = 0; i < 4000; i++) if (orderPair(["x", "y"])[0] === "y") flipped++;
  assert.ok(flipped > 1800 && flipped < 2200, "about half flipped: " + flipped);

  const { s } = await live(t);
  const names = [ONE, TWO, "Gemini 2.5 Flash", "GLM 5.3"];
  let firstWasA = 0,
    rounds = 0;
  for (const who of ["owl1", "owl2", "owl3", "owl4"]) {
    const p = await person(s, who);
    for (let i = 0; i < 4; i++) {
      const r = await round(p).expect(200);
      rounds++;
      for (const needle of names) assert.ok(!r.text.includes(needle), "stream names " + needle);
      const events = eventsOf(r);
      // Only the final event carries a charge, and only both sides' total.
      assert.equal(events.filter((e) => JSON.stringify(e).includes("credits")).length, 1);
      assert.ok(!r.text.includes("request_id") && !r.text.includes("privacy"));
      const done = finalOf(r);
      assert.equal(done.reveal, null);
      const v = await p.agent.post("/api/blind/votes").send({ round: done.round, outcome: "tie" }).expect(200);
      if (v.body.reveal.a.model === ONE) firstWasA++;
      // The token can't be read in the browser: it's sealed.
      assert.ok(!Buffer.from(done.round, "base64url").toString("latin1").includes(ONE));
    }
  }
  assert.ok(firstWasA > 0 && firstWasA < rounds, `A was the first model ${firstWasA}/${rounds} times`);
});

// ---- Vote API ----

test("vote: only yours, once, within 30 days; the reveal names both and updates the saved reply", async (t) => {
  const { s } = await live(t);
  const p = await person(s, "voter");
  const other = await person(s, "other");
  const r = await round(p).expect(200);
  const done = finalOf(r);
  const vote = (who, body) => who.agent.post("/api/blind/votes").send(body);
  // Before the vote the saved reply names nobody.
  const before = (await p.agent.get("/api/conversations/" + done.conversationId).expect(200)).body;
  const raw = JSON.stringify(before.messages);
  for (const id of [ONE, TWO, "Gemini 2.5 Flash", "GLM 5.3"]) assert.ok(!raw.includes(id), id);
  assert.equal(before.messages.at(-1).model, null);
  assert.match(before.messages.at(-1).content.text, /\*\*Blind compare · Reply A\*\*/);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM blind_votes").get().n, 0, "nothing stored before the vote");

  assert.equal((await vote(p, { round: done.round, outcome: "maybe" }).expect(400)).body.error.code, "invalid_request");
  assert.equal((await vote(p, { round: "garbled", outcome: "a" }).expect(404)).body.error.code, "blind_round_not_found");
  assert.equal((await vote(p, { round: done.round.slice(0, -2) + "AA", outcome: "a" }).expect(404)).body.error.code, "blind_round_not_found");
  assert.equal((await vote(other, { round: done.round, outcome: "a" }).expect(404)).body.error.code, "blind_round_not_found");
  // Another account's reply is never touched, even with a valid round.
  const first = (await vote(p, { round: done.round, outcome: "b", message_id: done.message_id }).expect(200)).body;
  assert.equal(first.counted, true);
  assert.equal(first.message_id, done.message_id);
  assert.equal(first.reveal.outcome, "b");
  for (const side of ["a", "b"]) {
    assert.ok([ONE, TWO].includes(first.reveal[side].model));
    assert.ok(first.reveal[side].name);
    assert.ok(Number.isInteger(first.reveal[side].ms) && first.reveal[side].ms >= 0);
    assert.ok(first.reveal[side].privacy, "Privacy Trail per side");
  }
  assert.notEqual(first.reveal.a.model, first.reveal.b.model);
  // Asking again reveals the same result; the first vote stands.
  const again = (await vote(p, { round: done.round, outcome: "a" }).expect(200)).body;
  assert.equal(again.counted, false);
  assert.equal(again.reveal.outcome, "b");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM blind_votes").get().n, 1);
  const row = s.db.prepare("SELECT * FROM blind_votes").get();
  assert.deepEqual(Object.keys(row).sort(), ["created", "id", "model_a", "model_b", "outcome", "user_id"]);
  assert.equal(row.model_a, first.reveal.a.model);
  assert.equal(row.outcome, "b");
  // The saved reply now carries the reveal, names both, and has no token.
  const afterConv = (await p.agent.get("/api/conversations/" + done.conversationId).expect(200)).body;
  const saved = messageFromServer(afterConv.messages.at(-1));
  assert.equal(saved.blind.reveal.outcome, "b");
  assert.ok(!("token" in saved.blind));
  assert.match(saved.content, new RegExp(`Reply B · ${first.reveal.b.name} · your pick`));
  // 30 days on, voting has closed.
  const sealer = roundSealer(s.cfg.secret);
  const old = sealer.seal({ v: 1, id: "br_old", u: p.user.id, a: ONE, b: TWO, t: now() - TOKEN_TTL_MS - 1000, d: {} });
  assert.equal((await vote(p, { round: old, outcome: "a" }).expect(410)).body.error.code, "blind_vote_closed");
  assert.equal(sealer.open(old.replace(/^./, (c) => (c === "A" ? "B" : "A"))), null, "tampering is refused");
});

// ---- Rankings ----

test("rankings: win rates from the account's own votes, with ties as half and both bad as a loss", async (t) => {
  const math = rankings([
    { model_a: "x", model_b: "y", outcome: "a" },
    { model_a: "y", model_b: "x", outcome: "b" },
    { model_a: "x", model_b: "z", outcome: "tie" },
    { model_a: "y", model_b: "z", outcome: "bad" },
    { model_a: "z", model_b: "z", outcome: "a" }, // never counted
    { model_a: "x", model_b: "y", outcome: "nope" }, // never counted
  ]);
  assert.deepEqual(
    math.map((r) => [r.model, r.rounds, r.wins, r.ties, r.losses, r.both_bad, r.win_rate]),
    [
      ["x", 3, 2, 1, 0, 0, 0.833],
      ["z", 2, 0, 1, 1, 1, 0.25],
      ["y", 3, 0, 0, 3, 1, 0],
    ],
  );
  assert.deepEqual(rankings([]), []);

  const { s } = await live(t);
  const p = await person(s, "ranker");
  const other = await person(s, "stranger");
  for (const outcome of ["a", "b", "tie"]) {
    const done = finalOf(await round(p).expect(200));
    await p.agent.post("/api/blind/votes").send({ round: done.round, outcome }).expect(200);
  }
  const theirs = finalOf(await round(other).expect(200));
  await other.agent.post("/api/blind/votes").send({ round: theirs.round, outcome: "bad" }).expect(200);
  const mine = (await p.agent.get("/api/blind/rankings").expect(200)).body;
  assert.equal(mine.votes, 3);
  assert.deepEqual(mine.data.map((r) => r.model).sort(), [ONE, TWO].sort());
  for (const r of mine.data) {
    assert.equal(r.rounds, 3);
    assert.equal(r.both_bad, 0, "another account's votes never count");
    assert.ok(r.name);
  }
  assert.equal(mine.data.reduce((n, r) => n + r.wins, 0), 2);
  // Reset: this account's votes only.
  assert.deepEqual((await p.agent.delete("/api/blind/rankings").expect(200)).body, { deleted: 3 });
  assert.deepEqual((await p.agent.get("/api/blind/rankings").expect(200)).body, { votes: 0, data: [] });
  assert.equal((await other.agent.get("/api/blind/rankings").expect(200)).body.votes, 1);
});

// ---- Erase and export ----

test("the export lists votes only (never a prompt), and Panic Wipe and closure erase them", async (t) => {
  const { s } = await live(t);
  const p = await person(s, "exporter");
  const secret = "My landlord's name is Orsolya";
  const done = finalOf(await round(p, { messages: ask(secret), ephemeral: true }).expect(200));
  assert.equal(done.conversationId, null);
  assert.equal(done.message_id, null);
  await p.agent.post("/api/blind/votes").send({ round: done.round, outcome: "a" }).expect(200);
  const exported = (await p.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.blindVotes.length, 1);
  assert.deepEqual(Object.keys(exported.blindVotes[0]).sort(), ["created", "id", "model_a", "model_b", "outcome"]);
  assert.ok(!JSON.stringify(exported).includes("Orsolya"), "an off-the-record prompt is in no export");
  await p.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM blind_votes WHERE user_id=?").get(p.user.id).n, 0);

  const q = await person(s, "closer");
  const d2 = finalOf(await round(q).expect(200));
  await q.agent.post("/api/blind/votes").send({ round: d2.round, outcome: "b" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM blind_votes WHERE user_id=?").get(q.user.id).n, 1);
  await q.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM blind_votes WHERE user_id=?").get(q.user.id).n, 0);
});

// ---- Privacy and the modes ----

test("off the record and Private Mode save nothing but a vote; Private needs two private models", async (t) => {
  const { s, g } = await live(t);
  const p = await person(s, "private");
  const logged = [];
  const spy = ["log", "warn", "error", "info"].map((k) => {
    const orig = console[k];
    console[k] = (...args) => logged.push(args.join(" "));
    return () => (console[k] = orig);
  });
  try {
    const off = finalOf(await round(p, { messages: ask("Unsaved salmon question"), ephemeral: true }).expect(200));
    assert.equal(off.conversationId, null);
    const priv = await round(p, { private: true }).expect(400);
    assert.equal(priv.body.error.code, "private_model_required");
    const other = "venice/venice-uncensored-role-play";
    const two = await live(t, {}, { privateModels: [PRIVATE, other] });
    const q = await person(two.s, "private2");
    const done = finalOf(await round(q, { models: [PRIVATE, other], private: true, mode: "uncensored" }).expect(200));
    assert.equal(done.conversationId, null);
    // Private routing on both sides.
    assert.ok(two.g.bodies.every((b) => b.provider?.zdr === true));
    const v = (await q.agent.post("/api/blind/votes").send({ round: done.round, outcome: "a" }).expect(200)).body;
    assert.equal(v.reveal.a.privacy.storage, "private");
    assert.equal(two.s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
    assert.equal(two.s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
    const w = (await p.agent.post("/api/blind/votes").send({ round: off.round, outcome: "b" }).expect(200)).body;
    assert.equal(w.reveal.a.privacy.storage, "off_the_record");
  } finally {
    spy.forEach((undo) => undo());
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM blind_votes").get().n, 1);
  assert.ok(!logged.some((l) => /salmon|weekend/i.test(l)), "no content in server logs");
  assert.ok(g.bodies.length >= 2);
});

test("Veil's masked payload goes to both, Seed Guard refuses before anything, and unsupported mixes are declined", async (t) => {
  const { s, g } = await live(t);
  const p = await person(s, "modes");
  const masked = [{ role: "user", content: "Email [EMAIL_1] about the lease" }];
  const done = finalOf(await round(p, { messages: masked, veil_masked: 1 }).expect(200));
  assert.equal(g.bodies.length, 2);
  assert.deepEqual(g.bodies[0].messages, g.bodies[1].messages);
  assert.equal(g.bodies[0].messages.at(-1).content, masked[0].content);
  const v = (await p.agent.post("/api/blind/votes").send({ round: done.round, outcome: "a" }).expect(200)).body;
  assert.equal(v.reveal.a.privacy.veil_masked, 1);
  assert.equal(v.reveal.b.privacy.veil_masked, 1);

  const seed = Array(11).fill("abandon").join(" ") + " about";
  const refused = await round(p, { messages: ask(seed) }).expect(400);
  assert.equal(refused.body.error.code, "seed_phrase_blocked");
  assert.equal(g.bodies.length, 2, "nothing sent");

  const q = await person(s, "modes2");
  for (const [body, code] of [
    [{ models: [ONE, ONE] }, "blind_same_model"],
    [{ models: [ONE] }, "invalid_request"],
    [{ web_search: true }, "blind_unsupported"],
    [{ plugins: [{ id: "web" }] }, "blind_unsupported"],
    [{ memory: [] }, "blind_unsupported"],
    [{ treasury: true }, "blind_unsupported"],
    [{ ephemeral: true, conversationId: done.conversationId }, "invalid_request"],
    [{ mode: "symposium" }, "invalid_request"],
  ]) {
    const r = await round(q, body).expect(400);
    assert.equal(r.body.error.code, code, JSON.stringify(body));
  }
  assert.equal(g.bodies.length, 2, "still nothing sent");
  assert.equal(holds(s, q.user.id).length, 0);
});

test("a saved round joins its conversation and project; the next turn goes on from the pick", async (t) => {
  const { s, g } = await live(t);
  const p = await person(s, "saver");
  const project = (await p.agent.post("/api/projects").send({ name: "Trips" }).expect(201)).body;
  const done = finalOf(await round(p, { project: project.id }).expect(200));
  assert.ok(done.conversationId && done.message_id);
  assert.equal(
    s.db.prepare("SELECT project_id FROM project_chats WHERE conversation_id=?").get(done.conversationId).project_id,
    project.id,
  );
  const v = (await p.agent.post("/api/blind/votes").send({ round: done.round, outcome: "b", message_id: done.message_id }).expect(200)).body;
  // The next message in the same conversation carries only the pick.
  const conv = (await p.agent.get("/api/conversations/" + done.conversationId).expect(200)).body;
  const shown = conv.messages.map(messageFromServer);
  const { request: sent } = buildChatRequest({ messages: shown, text: "Tell me more" });
  assert.deepEqual(sent.map((m) => m.role), ["user", "assistant", "user"]);
  assert.equal(sent[1].content, "The answer is " + WORD[v.reveal.b.model]);
  const next = finalOf(await round(p, { conversationId: done.conversationId, messages: sent }).expect(200));
  assert.equal(next.conversationId, done.conversationId);
  assert.equal(g.bodies.at(-1).messages[1].content, sent[1].content);
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM messages WHERE conversation_id=?").get(done.conversationId).n,
    4,
  );
  // A shared (collab) conversation is declined.
  const collab = (await p.agent.post("/api/collabs").send({ name: "Team" }).expect(201)).body;
  const shared = (await p.agent.post("/api/conversations").send({ title: "x" }).expect(201)).body.id;
  s.db.prepare("UPDATE conversations SET collab_id=? WHERE id=?").run(collab.id, shared);
  const refused = await round(p, { conversationId: shared }).expect(400);
  assert.equal(refused.body.error.code, "blind_unsupported");
});

// ---- The browser's helpers ----

test("pool, surprise pair and default pair follow Private Mode, Uncensored, images and the price band", () => {
  const m = (id, input, output, extra = {}) => ({
    id,
    name: id,
    type: "chat",
    callable: true,
    owned_by: extra.owned_by || id.split("-")[0],
    pricing: { input_per_1M_tokens: input, output_per_1M_tokens: output },
    ...extra,
  });
  const models = [
    m("cheap-a", 0.1, 0.4, { owned_by: "Acme" }),
    m("cheap-b", 0.15, 0.5, { owned_by: "Bolt", vision: true }),
    m("cheap-c", 0.12, 0.45, { owned_by: "Acme", private: true }),
    m("mid-a", 3, 15, { owned_by: "Core", private: true, vision: true }),
    m("mid-b", 2.5, 12, { owned_by: "Dune", private: true }),
    m("top-a", 15, 75, { owned_by: "Echo" }),
    m("wild-a", 0.2, 0.2, { owned_by: "Venice" }),
    m("sealed-a", 1, 1, { sealed: true }),
    m("gone-a", 1, 1, { callable: false }),
    { id: "img", type: "image", callable: true },
  ];
  const uncensored = ["wild-a"];
  const ids = (list) => list.map((x) => x.id);
  assert.deepEqual(ids(blindPool(models, { uncensored })), ["cheap-a", "cheap-b", "cheap-c", "mid-a", "mid-b", "top-a"]);
  assert.deepEqual(ids(blindPool(models, { mode: "uncensored", uncensored })), ["wild-a"]);
  assert.deepEqual(ids(blindPool(models, { privateMode: true, uncensored })), ["cheap-c", "mid-a", "mid-b"]);
  assert.deepEqual(ids(blindPool(models, { needsVision: true, uncensored })), ["cheap-b", "mid-a"]);
  const pool = blindPool(models, { uncensored });
  // Surprise: two different models near the current one's price, from two makers.
  for (let i = 0; i < 200; i++) {
    const r = Math.random;
    const pair = surprisePair(pool, models[0], r);
    assert.equal(pair.length, 2);
    assert.notEqual(pair[0], pair[1]);
    assert.ok(pair.every((id) => id.startsWith("cheap-")), pair.join());
    const makers = pair.map((id) => pool.find((x) => x.id === id).owned_by);
    assert.notEqual(makers[0], makers[1]);
    const mid = surprisePair(pool, models[3], r);
    assert.ok(mid.every((id) => id.startsWith("mid-")), mid.join());
  }
  // A band too small widens rather than failing; a pool of one can't pair.
  const lonely = surprisePair(pool, models[5], () => 0);
  assert.equal(lonely.length, 2);
  assert.equal(surprisePair([models[0]], models[0]), null);
  assert.ok(typicalPrice(models[0]) > 0);
  assert.equal(typicalPrice({}), null);
  assert.deepEqual(defaultPair(pool, models[3]), ["mid-a", "cheap-a"]);
  assert.deepEqual(defaultPair(pool, null), ["cheap-a", "cheap-b"]);
  assert.equal(validPair(["cheap-a", "cheap-a"], pool), false);
  assert.equal(validPair(["cheap-a", "wild-a"], pool), false);
  assert.equal(validPair(["cheap-a", "top-a"], pool), true);
});

test("the round on screen: events fill A and B, the reveal names them, and history keeps only the pick", () => {
  let b = pendingBlind();
  for (const e of [
    { blind: { conversationId: "c_1" } },
    { side: "a", delta: { content: "Hello " } },
    { side: "b", delta: { content: "Hi", reasoning: "thinking" } },
    { side: "a", delta: { content: "there" } },
    { side: "a", status: "done" },
    { side: "b", status: "done" },
  ])
    b = applyBlindEvent(b, e);
  assert.equal(b.a.text, "Hello there");
  assert.equal(b.b.reasoning, "thinking");
  assert.equal(canVote(b), false, "not before the final event");
  b = applyBlindEvent(b, { blind: { done: true, round: "tok", credits_charged: 1.2, sides: { a: { status: "done" }, b: { status: "done" } } } });
  assert.equal(canVote(b), true);
  assert.equal(b.credits, 1.2);
  assert.doesNotMatch(blindText(b), /GLM|Gemini/);
  assert.match(blindText(b), /^\*\*Blind compare · Reply A\*\*\n\nHello there/);
  const message = { role: "assistant", content: blindText(b), blind: b };
  assert.equal(historyText(b), "Hello there", "unvoted: reply A");
  const reveal = {
    outcome: "b",
    a: { model: "glm-5.3", name: "GLM 5.3", credits: 0.4, ms: 900 },
    b: { model: ONE, name: "Gemini 2.5 Flash", credits: 0.8, ms: 4200 },
  };
  const shown = revealTurn(message, reveal);
  assert.ok(!("token" in shown.blind));
  assert.equal(chosenSide(shown.blind), "b");
  assert.match(shown.content, /Reply A · GLM 5\.3\*\*/);
  assert.match(shown.content, /Reply B · Gemini 2\.5 Flash · your pick/);
  const { request: sent, next } = buildChatRequest({
    messages: [{ role: "user", content: "Q" }, shown],
    text: "More?",
  });
  assert.deepEqual(sent, [
    { role: "user", content: "Q" },
    { role: "assistant", content: "Hi" },
    { role: "user", content: "More?" },
  ]);
  assert.equal(next[1], shown, "the screen keeps both replies");
  assert.equal(historyText({ ...b, reveal: { outcome: "tie" } }), "Hello there");
  assert.equal(historyText({ a: { text: "" }, b: { text: "only b" } }), "only b");
  assert.equal(canVote(closeTurn(message).blind), false);
  assert.equal(formatSpeed(850), "850 ms");
  assert.equal(formatSpeed(4200), "4.2 s");
  // A saved round comes back from the server with its sides.
  const back = messageFromServer({ role: "assistant", content: { text: "t", blind: { a: { text: "x" }, b: { text: "y" }, token: "tok" } } });
  assert.equal(back.content, "t");
  assert.equal(back.blind.token, "tok");
});

// ---- Chinese ----

const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
const han = /\p{Script=Han}/u;

// Blind.jsx compiled for Node with the same esbuild Vite uses; shared UI is
// swapped for plain stand-ins so only its own text renders.
async function blindModule() {
  const src = new URL("../src/Blind.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-blind-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Icon = () => React.createElement("svg");
     export const Modal = ({ title, children }) => React.createElement("dialog", { "aria-label": title }, React.createElement("h2", null, title), children);`,
  );
  const veil = stub("veil.mjs", `export const veilRemarkPlugin = () => () => {};`);
  const trail = stub("trail.mjs", `export const PrivacyTrail = () => React.createElement("span", null, "Privacy Trail");`);
  const out = code
    .replace(/^import "\.\/blind\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/Veil\.jsx"/g, `from "${veil}"`)
    .replace(/from "\.\/PrivacyTrail\.jsx"/g, `from "${trail}"`)
    .replace(/from "\.\/(lib|estimate|blind)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "(react-markdown|remark-gfm)"/g, (_, f) => `from "${import.meta.resolve(f)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "Blind.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Text split by whether it sits inside data-i18n="off" (the user's and the
// model's words) or not (the page's own, to be translated).
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr"]);
  const stack = [],
    page = [],
    kept = [];
  for (const [, tag, text] of html.replace(/<!-- -->/g, "").matchAll(/(<[^>]+>)|([^<]+)/g)) {
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

test("Blind's own words are translated; replies, prompts and model names are not", async () => {
  const { BlindToggle, BlindBar, BlindTurn, BlindEstimate, BlindRankings } = await blindModule();
  const pool = [
    { id: ONE, name: "Gemini 2.5 Flash" },
    { id: TWO, name: "GLM 5.3" },
  ];
  const reply = (text, extra = {}) => ({ text, reasoning: "", status: "done", ...extra });
  const reveal = (outcome) => ({
    outcome,
    a: { model: TWO, name: "GLM 5.3", credits: 0.4, ms: 900, privacy: { storage: "saved" } },
    b: { model: ONE, name: "Gemini 2.5 Flash", credits: 0.8, ms: 4200 },
  });
  const turn = (blind, extra = {}) =>
    renderToStaticMarkup(
      createElement(BlindTurn, { blind, last: true, busy: false, voting: false, trailLive: true, models: [], onVote() {}, onContinue() {}, onKeepComparing() {}, ...extra }),
    );
  const html = [
    renderToStaticMarkup(createElement(BlindToggle, { active: true, onToggle() {} })),
    renderToStaticMarkup(createElement(BlindToggle, { active: false, disabled: true, reason: "Blind isn't available in Sealed Mode", onToggle() {} })),
    renderToStaticMarkup(createElement(BlindBar, { pool, pair: [ONE, TWO], surprise: false, notes: ["Private mode: zero-data-retention models only.", "Showing models that can read your images."] })),
    renderToStaticMarkup(createElement(BlindBar, { pool, pair: [ONE, TWO], surprise: false, waiting: true })),
    renderToStaticMarkup(createElement(BlindBar, { pool, pair: [ONE, ONE], surprise: true, current: pool[0] })),
    renderToStaticMarkup(createElement(BlindBar, { pool: [pool[0]], pair: [ONE], surprise: false, current: null })),
    renderToStaticMarkup(createElement(BlindBar, { pool, pair: [ONE, TWO], surprise: true, current: null })),
    turn({ ...pendingBlind() }),
    turn({ a: reply("Take the coastal path"), b: reply("Stay in town"), token: "t", credits: 1.2 }),
    turn({ a: reply("Take the coastal path"), b: reply("Stay in town"), reveal: reveal("a") }),
    turn({ a: reply("Take the coastal path"), b: reply("Stay in town"), reveal: reveal("tie") }),
    turn({ a: reply("Take the coastal path"), b: reply("Stay in town"), reveal: reveal("bad") }),
    turn({ a: reply("Take the coastal path"), b: reply("", { status: "failed", error: "The model didn't answer." }), reveal: reveal(null) }),
    turn({ a: reply("Take the coastal path", { status: "stopped" }), b: reply("Stay", { status: "streaming" }) }),
    turn({ a: reply("x"), b: reply("y"), closed: true }),
    renderToStaticMarkup(createElement(BlindEstimate, { state: { status: "ready", credits: 0.35, available: 0.1 } })),
    renderToStaticMarkup(createElement(BlindEstimate, { state: { status: "ready", credits: 0.35, available: 10, room: 0.2 } })),
    renderToStaticMarkup(createElement(BlindEstimate, { state: { status: "loading" } })),
    renderToStaticMarkup(createElement(BlindEstimate, { state: { status: "unavailable", message: "Chat is unavailable." } })),
    renderToStaticMarkup(createElement(BlindRankings, { onClose() {} })),
  ].join("");
  const { page, kept } = textsOf(html);
  for (const text of ["Gemini 2.5 Flash", "GLM 5.3", "Take the coastal path", "Stay in town"])
    assert.ok(kept.includes(text), "kept as written: " + text);
  for (const text of ["Which is better?", "A is better", "Both bad", "Your rankings", "Keep comparing", "Continue with", "Reply A", "Your pick"])
    assert.ok(page.includes(text), "shown: " + text);
  for (const text of page) assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
  // What the workspace and the rankings dialog say that this render can't reach.
  for (const text of [
    "Blind Compare",
    "Two models answer. You pick the better one.",
    ...UPDATES.find((u) => u.id === "blind").points,
    "Vote on the replies above to continue.",
    "Choose two different models to compare.",
    "Blind: memory isn't used when two models answer.",
    "Blind is off. Your next message goes to GLM 5.3.",
    "This comparison already had a vote. The first one stands.",
    "Stopped. A reply that had started may be charged for what it used; check your activity.",
    "No votes yet. Compare two models and vote to start your rankings.",
    "1 win",
    "3 wins",
    "1 tie",
    "0 ties",
    "1 loss",
    "2 losses",
    "Delete your 1 vote? Saved chats keep their reveals.",
    "Delete all 4 votes? Saved chats keep their reveals.",
    "Reset rankings",
    "Cancel",
    "BLIND COMPARE",
    "This comparison wasn't found.",
    "Voting on this comparison has closed.",
    "Vote A, B, tie or both bad.",
    "Choose two different models to compare.",
    "Web search is off in Blind.",
    "Memory isn't used in Blind.",
    "Blind isn't available with Team pays.",
    "Blind isn't available in shared chats.",
    "Private mode needs two models with zero data retention.",
    "The other model couldn't start, so nothing was sent.",
    // Data controls and Panic Wipe, once released.
    "Blind Compare votes: the two models compared, your vote and its date, for Your rankings. Never the prompt or the replies, and nothing about a comparison before you vote. Reset them from Your rankings; Panic Wipe and closing your account delete them.",
    "The export also lists your Blind Compare votes: the two models, the outcome and the date.",
    "Your Blind Compare votes and rankings",
  ])
    assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
});
