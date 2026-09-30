import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { addCredit, balance, credits, markupFactor, uid, now } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { eraseAccountContent } from "../server/routes/account.js";
import { cleanPiece, sttCharge, transcriptTokens, transcriptSegments } from "../server/meeting-notes.js";
import { pieceTokens, placeTokens, subtitleTestTranscript, subtitleTranslateTestReply } from "../server/subtitles.js";
import { encodeWav16 } from "../src/meeting-audio.js";
import {
  CUE,
  LIMITS,
  applyTranslation,
  batchDocument,
  buildCues,
  checkBatches,
  checkCues,
  checkSetRecord,
  checkTracks,
  cueIssues,
  editText,
  editTimes,
  endsSentence,
  firstJson,
  flat,
  mapTracks,
  mergeCues,
  cueAt,
  parseStamp,
  parseTranslation,
  removeCue,
  shiftCues,
  stampOf,
  splitCue,
  srtTime,
  subtitlesLive,
  tokensFromLines,
  toSrt,
  toVtt,
  translateMessages,
  usableCues,
  translationBatches,
  vttTime,
  widthOf,
  wrapCue,
  wrapLines,
} from "../src/subtitles.js";
import { knownPage } from "../src/site-routes.js";
import { createVeilState, veil, unveil } from "../src/veil.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { measure } from "../src/translate-spec.js";
import { rankTools } from "../src/tool-search.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const STT = { id: "nova-3", name: "Nova 3", provider: "deepgram", pricing: { unit: "per_minute", api_price: 0.0043 } };
const CATALOG = { object: "list", data: { tts: [], stt: [STT, { ...STT, id: "nova-2", name: "Nova 2" }] } };
const MODEL = "google/gemini-2.5-flash";
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
// A made-up detail that must never be stored, logged or sent once Veil masks it.
const SECRET_EMAIL = "dana.whitfield@example.org";

// ---- Audio the browser would send ----

// A WAV of mono 16-bit PCM at 16 kHz, `seconds` long (optionally with a LIST
// chunk before its samples, which must never reach the provider).
function wav(seconds, { rate = 16000, channels = 1, bits = 16, list = false } = {}) {
  const frames = Math.round(seconds * rate),
    block = (channels * bits) / 8;
  const extra = list ? Buffer.concat([Buffer.from("LIST"), Buffer.from([12, 0, 0, 0]), Buffer.from("INFOISFT\0\0\0\0")]) : Buffer.alloc(0);
  const head = Buffer.alloc(36);
  head.write("RIFF", 0);
  head.writeUInt32LE(28 + extra.length + 8 + frames * block, 4);
  head.write("WAVEfmt ", 8);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * block, 28);
  head.writeUInt16LE(block, 32);
  head.writeUInt16LE(bits, 34);
  const data = Buffer.alloc(8 + frames * block);
  data.write("data", 0);
  data.writeUInt32LE(frames * block, 4);
  return Buffer.concat([head, extra, data]);
}
const pieceUrl = (seconds, opts) => "data:audio/wav;base64," + wav(seconds, opts).toString("base64");

// ---- A stand-in for the gateway: speech catalog, transcription, translation ----

function event(res, p) {
  res.write("data: " + JSON.stringify(p) + "\n\n");
}
// Deepgram-shaped words (punctuated_word) for "Hello there. This is a test."
const WORDS = [
  ["Hello", 0.2, 0.5],
  ["there.", 0.55, 1.0],
  ["This", 2.2, 2.4],
  ["is", 2.45, 2.55],
  ["a", 2.6, 2.65],
  ["test.", 2.7, 3.2],
].map(([w, start, end]) => ({ word: w.toLowerCase().replace(/[^a-z]/g, ""), punctuated_word: w, start, end }));
const DEFAULT_REPLY = () => ({
  text: "Hello there. This is a test.",
  duration: 299.5,
  words: WORDS,
  segments: [{ id: 0, start: 0.2, end: 3.2, text: "Hello there. This is a test." }],
});
// `plan`: { transcribe(i, raw) -> { status } | json, translate (text) | (i, body) => text, finish, chatStatus }.
async function gateway(t, plan = {}) {
  const calls = { chat: [], transcribe: [] };
  const server = createServer(async (req, res) => {
    if (req.url === "/v1/audio/models") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(CATALOG));
    }
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    if (req.url === "/v1/audio/transcriptions") {
      const i = calls.transcribe.length;
      calls.transcribe.push(raw);
      const answer = plan.transcribe ? plan.transcribe(i, raw) : DEFAULT_REPLY();
      if (answer.status) {
        res.writeHead(answer.status, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "stand-in transcription failure" } }));
      }
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(answer));
    }
    const body = JSON.parse(raw.toString() || "{}");
    calls.chat.push(body);
    if (plan.chatStatus) {
      res.writeHead(plan.chatStatus, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "stand-in model failure" } }));
    }
    const echo = () => JSON.stringify(cuesIn(body).map((c) => ({ n: c.n, text: "ES " + c.text })));
    const text = typeof plan.translate === "function" ? plan.translate(calls.chat.length - 1, body) : plan.translate ?? echo();
    res.writeHead(200, { "content-type": "text/event-stream" });
    event(res, { choices: [{ delta: { content: text } }] });
    event(res, { choices: [{ delta: {}, finish_reason: plan.finish || "stop" }], usage: { prompt_tokens: 900, completion_tokens: 300 } });
    res.end("data: [DONE]\n\n");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: "http://127.0.0.1:" + server.address().port, calls };
}
// The cues a translation request carried, read back out of its prompt.
function cuesIn(body) {
  const user = String(body.messages?.find((m) => m.role === "user")?.content || "");
  const doc = /<document name="[^"]*"[^>]*>([\s\S]*?)<\/document>/.exec(user)?.[1] || "[]";
  return JSON.parse(doc.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

function fixture(t, { released, gatewayUrl = "http://127.0.0.1:9", ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-subtitles-"));
  const svc = createApp({
    testMode: false,
    gateway: gatewayUrl,
    gatewayKey: "fixture",
    released: released ?? "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  svc.dir = dir;
  return svc;
}
let visitor = 0;
async function person(s, username, fund = 5_000_000) {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.101.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  if (fund) addCredit(s.db, r.body.user.id, fund, "fund-" + username, "test_credit");
  return { agent, user: r.body.user };
}
const events = (text) =>
  text
    .split("\n\n")
    .map((b) => b.replace(/^data: /, ""))
    .filter((b) => b && b !== "[DONE]" && !b.startsWith(":"))
    .map((b) => JSON.parse(b));
const sse = (req) =>
  req.buffer(true).parse((res, cb) => {
    let s = "";
    res.on("data", (c) => (s += c));
    res.on("end", () => {
      if (!String(res.headers["content-type"]).includes("json")) return cb(null, events(s));
      try {
        cb(null, JSON.parse(s));
      } catch (e) {
        cb(e);
      }
    });
  });
// A ten-minute video in two pieces of five minutes.
const BODY = (extra = {}) => ({ duration: 600, chunks: [300, 300], stt: "nova-3", ...extra });
const start = (p, extra = {}) => p.agent.post("/api/subtitles").send({ ...BODY(extra), requestId: "st-" + Math.random() });
const piece = (p, id, i, seconds = 300, opts) => p.agent.post(`/api/subtitles/${id}/pieces/${i}`).send({ audio: pieceUrl(seconds, opts) });
const heldOf = (s, user) => s.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM holds WHERE user_id=? AND status='held'").get(user).n;
const spends = (s, user) => s.db.prepare("SELECT amount,description FROM ledger WHERE user_id=? AND amount<0 ORDER BY created,rowid").all(user);
const count = (s, table) => s.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;

// A run of speech as tokens: `n` words, each 0.3 s, a pause after every
// `per` words.
function speech(n, { per = 12, pause = 0.9, sentence = true } = {}) {
  const tokens = [];
  let at = 0;
  for (let i = 0; i < n; i++) {
    const last = (i + 1) % per === 0;
    const w = "word" + "abcdefghij"[i % 10].repeat(1 + (i % 5));
    tokens.push({ text: last && sentence ? w + "." : w, start: at, end: at + 0.28 });
    at += 0.3 + (last ? pause : 0);
  }
  return tokens;
}
const SET = (extra = {}) => ({
  title: "Team call",
  duration: 120,
  language: "en",
  tracks: [{ lang: "en", source: true, cues: [{ start: 0.5, end: 2.5, text: "Hello there." }, { start: 3, end: 5.5, text: "This is a test." }] }],
  ...extra,
});

// ---- The release gate ----

test("unreleased: every route is refused before anything runs, the page is unknown and the docs leave them out", async (t) => {
  const s = fixture(t, { released: "mvp" });
  const a = await person(s, "ana");
  for (const [method, path] of [
    ["post", "/api/subtitles/quote"],
    ["post", "/api/subtitles"],
    ["post", "/api/subtitles/sub_x/pieces/0"],
    ["delete", "/api/subtitles/sub_x"],
    ["post", "/api/subtitles/translate/quote"],
    ["post", "/api/subtitles/translate"],
    ["post", "/api/subtitles/translate/stop"],
    ["get", "/api/subtitles/sets"],
    ["post", "/api/subtitles/sets"],
    ["get", "/api/subtitles/sets/subs_x"],
    ["patch", "/api/subtitles/sets/subs_x"],
    ["delete", "/api/subtitles/sets/subs_x"],
    ["post", "/API/Subtitles"],
  ]) {
    const res = await a.agent[method](path).send(BODY()).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased", path);
    assert.equal(res.body.error.message, "Subtitles is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(s.app).post("/api/subtitles").send({}).expect(403);
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.subtitles, false);
  const entry = config.releases.updates.find((u) => u.id === "subtitles");
  assert.equal(entry.title, "Subtitles");
  assert.equal(entry.points.length, 3);
  // A committed flag is a boolean; it flips at release.
  assert.equal(typeof committed[UPDATES.findIndex((u) => u.id === "subtitles")], "boolean");
  const docs = (await request(s.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(docs.paths).some((p) => p.startsWith("/api/subtitles")));
  // The page is a 404 until release.
  await request(s.app).get("/workspace/subtitles").expect(404);
  assert.equal(knownPage("/workspace/subtitles", {}), false);
  assert.equal(knownPage("/workspace/subtitles", { subtitles: true }), true);
  // Released on its own, it still needs Voice & Audio.
  const partly = fixture(t, { released: "mvp,subtitles" });
  const b = await person(partly, "ben");
  const res = await b.agent.post("/api/subtitles/quote").send(BODY()).expect(403);
  assert.equal(res.body.error.message, "Voice & Audio is coming soon.");
  const gates = (body, method = "POST", path = "/api/subtitles") => featuresFor({ path, method, body });
  assert.deepEqual(gates({}), ["subtitles", "audio"]);
  assert.deepEqual(gates({ ephemeral: true }), ["subtitles", "audio", "ephemeral"]);
  assert.deepEqual(gates({ private: true }, "POST", "/api/subtitles/translate"), ["subtitles", "audio", "private", "ephemeral"]);
  assert.deepEqual(gates({ veil_masked: 2 }, "POST", "/api/subtitles/translate"), ["subtitles", "audio", "trail"]);
  assert.deepEqual(gates({}, "DELETE", "/api/subtitles/sub_1"), ["subtitles", "audio"]);
  assert.deepEqual(gates({}, "GET", "/api/subtitles/sets"), ["subtitles", "audio"]);
  // The plain transcription route keeps its own gate.
  assert.deepEqual(featuresFor({ path: "/api/audio/transcriptions", method: "POST", body: {} }), ["audio"]);
  // The app shows it only when both are released.
  assert.equal(subtitlesLive({}), false);
  assert.equal(subtitlesLive({ releases: { features: { subtitles: true } } }), false);
  assert.equal(subtitlesLive({ releases: { features: { subtitles: true, audio: true } } }), true);
});

test("released: the page is served, and the docs list the routes", async (t) => {
  const s = fixture(t);
  await request(s.app).get("/workspace/subtitles").expect((r) => assert.notEqual(r.status, 404));
  const docs = (await request(s.app).get("/api/openapi.json").expect(200)).body;
  for (const path of [
    "/api/subtitles/quote",
    "/api/subtitles",
    "/api/subtitles/{id}/pieces/{index}",
    "/api/subtitles/{id}",
    "/api/subtitles/translate/quote",
    "/api/subtitles/translate",
    "/api/subtitles/translate/stop",
    "/api/subtitles/sets",
    "/api/subtitles/sets/{id}",
  ])
    assert.ok(docs.paths[path], path);
});

test("the app's entry points are gated: the sidebar, the page, the palette, the wipe lists and the lazy chunk", () => {
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(ws, /\.filter\(\(\[id\]\) => id !== "subtitles" \|\| modeReleased\(config, "subtitles"\)\)/);
  assert.match(ws, /\(mode === "subtitles" && \(!config \|\| modeReleased\(config, "subtitles"\)\)\)/);
  assert.match(ws, /\) : mode === "subtitles" \? \(\s*modeReleased\(config, "subtitles"\) && \(/);
  assert.doesNotMatch(ws, /from "\.\/subtitles\.js"/);
  assert.match(ws, /const Subtitles = lazy\(\(\) => import\("\.\/Subtitles\.jsx"\)\);/);
  const lib = readFileSync(new URL("../src/lib.js", import.meta.url), "utf8");
  assert.match(lib, /subtitles: "subtitles"/);
  assert.match(lib, /if \(mode === "subtitles"\) return isReleased\(config, "subtitles"\) && isReleased\(config, "audio"\);/);
  const site = readFileSync(new URL("../server/routes/site.js", import.meta.url), "utf8");
  assert.match(site, /subtitles: isReleased\(cfg, "subtitles"\) && isReleased\(cfg, "audio"\)/);
  const pages = readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8");
  assert.match(pages, /subtitles: "captions"/);
  const palette = readFileSync(new URL("../src/command-palette.js", import.meta.url), "utf8");
  assert.match(palette, /\["subtitles", "Subtitles"/);
  const panic = readFileSync(new URL("../src/PanicWipe.jsx", import.meta.url), "utf8");
  assert.match(panic, /isReleased\(config, "subtitles"\)/);
  const inactivity = readFileSync(new URL("../src/InactivityWipe.jsx", import.meta.url), "utf8");
  assert.match(inactivity, /on\("subtitles"\)/);
  const dockerfile = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /src\/subtitles\.js/, "server code imports src/subtitles.js");
});

// ---- Cues from word timings ----

const linesOf = (cue) => cue.text.split("\n");
test("cues: at most two lines of 42 characters, one to seven seconds, in order and never overlapping", () => {
  // Fast talk with no punctuation and no pauses, slow talk, and normal talk.
  for (const [n, opts] of [
    [400, { per: 10000, sentence: false }],
    [400, { per: 9, pause: 0.8 }],
    [300, { per: 25, pause: 0.5 }],
    [120, { per: 3, pause: 0.75 }],
  ]) {
    const cues = buildCues(speech(n, opts));
    assert.ok(cues.length > 3);
    cues.forEach((c, i) => {
      const lines = linesOf(c);
      assert.ok(lines.length <= CUE.lines, `${lines.length} lines`);
      assert.ok(lines.every((l) => widthOf(l) <= CUE.lineChars), c.text);
      const seconds = c.end - c.start;
      assert.ok(seconds >= CUE.minSeconds - 1e-6, `${seconds}s: ${c.text}`);
      assert.ok(seconds <= CUE.maxSeconds + 1e-6, `${seconds}s: ${c.text}`);
      if (i) assert.ok(c.start >= cues[i - 1].end - 1e-6, "no overlap");
    });
    // Nothing said is lost or reordered.
    const said = flat(cues.map((c) => c.text).join(" "));
    assert.equal(said, flat(speech(n, opts).map((t) => t.text).join(" ")));
    assert.deepEqual(cues.flatMap((c) => cueIssues(c)), []);
  }
});

test("cues: a sentence end or a pause starts a new cue, and a long sentence breaks near its middle at a comma", () => {
  const at = (words, start, gap = 0.04) => {
    let t = start;
    return words.split(" ").map((w) => {
      const tok = { text: w, start: t, end: t + 0.3 };
      t += 0.3 + gap;
      return tok;
    });
  };
  // Two sentences with no pause between them: two cues, once each has a second.
  const two = buildCues([...at("Okay let's get started.", 0), ...at("This is the weekly sync.", 2.0)]);
  assert.deepEqual(two.map((c) => flat(c.text)), ["Okay let's get started.", "This is the weekly sync."]);
  // A short sentence joins the next one rather than showing for under a second.
  const joined = buildCues([...at("Yes.", 0), ...at("We shipped it on Friday.", 0.4)]);
  assert.deepEqual(joined.map((c) => flat(c.text)), ["Yes. We shipped it on Friday."]);
  // A pause of 0.7 s always starts a cue, even mid-sentence.
  const paused = buildCues([...at("So we decided", 0), ...at("to keep the free tier", 2.5)]);
  assert.equal(paused.length, 2);
  assert.equal(paused[1].start, 2.5);
  // A long sentence is cut where it reads best: after the comma, not after "the".
  const sentence = at("Last week we had two options for the free tier, and after looking at the numbers again we decided to keep it as it was", 0);
  const long = buildCues(sentence);
  assert.equal(long.length, 2);
  assert.match(flat(long[0].text), /free tier,$/);
  assert.ok(!/ (the|to|of|a)$/i.test(flat(long[0].text)));
  // Times are the first word's start and the last word's end.
  assert.equal(long[0].start, sentence[0].start);
  assert.ok(Math.abs(long[1].end - sentence.at(-1).end) < 1e-3);
});

test("cues: a cue shorter than a second is held to a second, never into the next cue", () => {
  const cues = buildCues([
    { text: "Yes.", start: 10, end: 10.3 },
    { text: "Later we spoke again for a while.", start: 20, end: 22.5 },
  ]);
  assert.equal(cues.length, 2);
  assert.deepEqual([cues[0].start, cues[0].end], [10, 11]);
  // Right up to the next cue when it starts sooner, and no further.
  const tight = buildCues([
    { text: "Ok.", start: 0, end: 0.2 },
    { text: "And here is the next thing we will talk about at length.", start: 0.95, end: 3.2 },
  ]);
  assert.equal(tight.length, 2);
  assert.equal(tight[0].end, tight[1].start);
  // A short cue right next to another joins it when they fit together.
  const near = buildCues([
    { text: "Ok.", start: 0, end: 0.2 },
    { text: "Here is the next thing.", start: 0.5, end: 2.2 },
  ]);
  assert.deepEqual(near.map((c) => flat(c.text)), ["Ok. Here is the next thing."]);
});

test("cues: Chinese lines are half as many characters, a word longer than a line is cut, and empty input is empty", () => {
  const zh = [...("今天我们来讨论一下下个季度的产品发布计划，并且确认每个人负责的工作和时间安排。")].map((ch, i) => ({ text: ch, start: i * 0.25, end: i * 0.25 + 0.22 }));
  const cues = buildCues(zh);
  assert.ok(cues.length >= 1);
  for (const c of cues) assert.ok(linesOf(c).every((l) => widthOf(l) <= 42 && [...l].length <= 21), c.text);
  assert.equal(cues.map((c) => c.text.replace(/\n/g, "")).join(""), "今天我们来讨论一下下个季度的产品发布计划，并且确认每个人负责的工作和时间安排。");
  // A URL with no place to break is cut at the line's width.
  const url = "https://example.org/" + "a".repeat(70);
  const lines = wrapLines(url);
  assert.ok(lines.every((l) => widthOf(l) <= 42));
  assert.equal(lines.join(""), url);
  assert.deepEqual(buildCues([]), []);
  assert.deepEqual(buildCues([{ text: "", start: 1, end: 2 }, { text: "x", start: NaN, end: 3 }, { text: "y", start: -1, end: 2 }]), []);
  assert.equal(endsSentence("Mr."), false);
  assert.equal(endsSentence("done."), true);
  assert.equal(endsSentence('said "no."'), true);
  assert.equal(endsSentence("wait,"), false);
});

test("lines: one line when it fits, else two balanced lines, breaking after punctuation where it can", () => {
  assert.deepEqual(wrapLines("Short one."), ["Short one."]);
  assert.deepEqual(wrapLines("The pricing page, the beta feedback, and the Android build."), ["The pricing page, the beta feedback,", "and the Android build."]);
  assert.equal(wrapCue("A line\nby hand"), "A line\nby hand", "the person's own break is kept when it fits");
  assert.equal(wrapCue("one\ntwo\nthree"), "one two three");
  assert.equal(wrapCue("x ".repeat(60)), wrapLines("x ".repeat(60)).join("\n"));
  assert.ok(wrapLines("word ".repeat(40)).length >= 3, "more than two lines when it must");
  assert.equal(flat("  a \n b\t c  "), "a b c");
});

test("time fields: stamps read and write the same way, and a cue is found by the time", () => {
  assert.equal(stampOf(0), "0:00.000");
  assert.equal(stampOf(65.25), "1:05.250");
  assert.equal(stampOf(3723.5), "1:02:03.500");
  for (const s of [0, 0.001, 59.999, 65.25, 600, 3599.5, 3723.5, 10799.999]) assert.equal(parseStamp(stampOf(s)), s);
  assert.equal(parseStamp("65"), 65);
  assert.equal(parseStamp("1:05.25"), 65.25);
  assert.equal(parseStamp("01:02:03,250"), 3723.25);
  assert.equal(parseStamp(" 7.5 "), 7.5);
  for (const bad of ["", "abc", "1:99", "1:2:3:4", "-3", "1..2", "1:75:00", null]) assert.equal(parseStamp(bad), null, String(bad));
  const cues = [{ start: 1, end: 2, text: "a" }, { start: 3, end: 4, text: "b" }, { start: 6, end: 7, text: "c" }];
  assert.deepEqual([0, 1, 2.5, 3, 5, 6, 99].map((t) => cueAt(cues, t)), [-1, 0, 0, 1, 1, 2, 2]);
  assert.equal(cueAt([], 3), -1);
});

// ---- Files ----

test("SRT and VTT output is exact", () => {
  const cues = [
    { start: 0.5, end: 2.5, text: "Hello there." },
    { start: 3661.007, end: 3662.25, text: "Tom & Jerry <3\nsecond line" },
    { start: 5, end: 6, text: "a --> b\n\n  spaced   out " },
  ];
  assert.equal(srtTime(0), "00:00:00,000");
  assert.equal(srtTime(3661.007), "01:01:01,007");
  assert.equal(srtTime(59.9996), "00:01:00,000");
  assert.equal(vttTime(3661.007), "01:01:01.007");
  assert.equal(
    toSrt(cues),
    "1\n00:00:00,500 --> 00:00:02,500\nHello there.\n\n" +
      "2\n01:01:01,007 --> 01:01:02,250\nTom & Jerry <3\nsecond line\n\n" +
      "3\n00:00:05,000 --> 00:00:06,000\na -> b\nspaced out\n",
  );
  assert.equal(
    toVtt(cues),
    "WEBVTT\n\n" +
      "00:00:00.500 --> 00:00:02.500\nHello there.\n\n" +
      "01:01:01.007 --> 01:01:02.250\nTom &amp; Jerry &lt;3\nsecond line\n\n" +
      "00:00:05.000 --> 00:00:06.000\na -&gt; b\nspaced out\n\n",
  );
  assert.equal(toSrt([]), "");
  assert.equal(toVtt([]), "WEBVTT\n\n");
  // Every SRT block is number, timing, text; blocks are separated by one blank line.
  const blocks = toSrt(cues).trimEnd().split("\n\n");
  assert.equal(blocks.length, 3);
  blocks.forEach((b, i) => assert.match(b, new RegExp(`^${i + 1}\\n\\d\\d:\\d\\d:\\d\\d,\\d{3} --> \\d\\d:\\d\\d:\\d\\d,\\d{3}\\n[^\\n]+`)));
  // Built cues round-trip through the files in order.
  const built = buildCues(speech(60));
  assert.equal(toSrt(built).match(/-->/g).length, built.length);
  assert.equal(toVtt(built).match(/-->/g).length, built.length);
});

// ---- Editing ----

test("editing: text, times, merge and split keep the cues valid and in order", () => {
  const cues = [
    { start: 0, end: 2, text: "One two three four." },
    { start: 2.5, end: 4, text: "Five six." },
    { start: 6, end: 8, text: "Seven." },
  ];
  // Typing keeps what was typed (a space at the end of a word survives); saving and downloading tidy it.
  assert.equal(editText(cues, 1, "Cinco   seis ").at(1).text, "Cinco   seis ");
  assert.deepEqual(usableCues(editText(cues, 1, "Cinco   seis ")).map((c) => c.text), ["One two three four.", "Cinco seis", "Seven."]);
  assert.deepEqual(usableCues(editText(cues, 1, "   ")).map((c) => c.text), ["One two three four.", "Seven."], "a cue with no text is left out");
  assert.deepEqual(removeCue(cues, 1).map((c) => c.text), ["One two three four.", "Seven."]);
  assert.deepEqual(cueIssues({ start: 0, end: 2, text: "  " }), ["empty"]);
  const moved = editTimes(cues, 2, { start: 1, end: 0.5 }, 10);
  assert.ok(moved.every((c) => c.end > c.start));
  assert.deepEqual(moved.map((c) => c.start), [0, 1, 2.5], "kept in order of start");
  assert.equal(editTimes(cues, 0, { start: -5, end: 99 }, 10)[0].end, 12);
  const merged = mergeCues(cues, 0);
  assert.equal(merged.length, 2);
  assert.deepEqual([merged[0].start, merged[0].end], [0, 4]);
  assert.equal(flat(merged[0].text), "One two three four. Five six.");
  assert.equal(mergeCues(cues, 2), cues, "nothing to merge with");
  const split = splitCue(cues, 0);
  assert.equal(split.length, 4);
  assert.equal(split[0].start, 0);
  assert.equal(split[1].end, 2);
  assert.equal(split[0].end, split[1].start);
  assert.equal(flat(split[0].text + " " + split[1].text), "One two three four.");
  assert.ok(split[0].end > 0.5 && split[0].end < 1.5);
  const at = splitCue(cues, 0, 4);
  assert.equal(flat(at[0].text), "One");
  assert.equal(splitCue([{ start: 0, end: 1, text: "Single" }], 0).length, 1, "one word can't split");
  assert.deepEqual(shiftCues(cues, -1).map((c) => c.start), [0, 1.5, 5]);
  // Warnings the editor shows.
  assert.deepEqual(cueIssues({ start: 0, end: 0.4, text: "Hi" }), ["short"]);
  assert.deepEqual(cueIssues({ start: 0, end: 9, text: "Hi" }), ["long"]);
  assert.deepEqual(cueIssues({ start: 0, end: 3, text: "a\nb\nc" }), ["many_lines"]);
  assert.ok(cueIssues({ start: 0, end: 3, text: "x".repeat(50) }).includes("long_line"));
  assert.ok(cueIssues({ start: 0, end: 3, text: "ok" }, null, { start: 2, end: 4, text: "ok" }).includes("overlap"));
  assert.ok(cueIssues({ start: 0, end: 1, text: "x".repeat(60) }).includes("fast"));
});

test("saved cues and sets are checked: shape, times inside the video, the first track heard and each translation once", () => {
  const cues = [{ start: 1, end: 2, text: " Hi \n\n there " }];
  assert.deepEqual(checkCues(cues, 10), [{ start: 1, end: 2, text: "Hi\nthere" }]);
  for (const [list, message] of [
    [[{ start: 2, end: 1, text: "x" }], /end must come after/],
    [[{ start: 0, end: 20, text: "x" }], /inside the video/],
    [[{ start: 0, end: 1, text: "" }], /1 to 500/],
    [[{ start: 0, end: 1, text: "x".repeat(501) }], /1 to 500/],
    [[{ start: 0, end: 1, text: "x", extra: 1 }], /unexpected field/],
    [[null], /start, an end/],
    ["nope", /up to 6,000/],
  ])
    assert.throws(() => checkCues(list, 10), message);
  assert.deepEqual(checkCues([{ start: 5, end: 6, text: "b" }, { start: 1, end: 2, text: "a" }], 10).map((c) => c.text), ["a", "b"]);
  const ok = checkSetRecord(SET());
  assert.equal(ok.tracks[0].source, true);
  assert.equal(checkTracks(ok.tracks, ok.duration)[0].cues[1].text, "This is a test.");
  const es = { lang: "es", source: false, cues: [{ start: 1, end: 2, text: "Hola." }] };
  assert.equal(checkSetRecord(SET({ tracks: [...SET().tracks, es] })).tracks.length, 2);
  for (const [body, message] of [
    [SET({ tracks: [{ ...SET().tracks[0], source: false }] }), /first track/],
    [SET({ tracks: [SET().tracks[0], { ...SET().tracks[0] }] }), /first track is the one that was heard, and only the first/],
    [SET({ tracks: [SET().tracks[0], es, es] }), /only one track/],
    [SET({ tracks: [SET().tracks[0], { ...es, lang: "xx" }] }), /language isn't valid/],
    [SET({ tracks: [] }), /1 to 8 tracks/],
    [SET({ title: "" }), /title is 1 to 120/],
    [SET({ duration: 99999 }), /up to 3 hours/],
    [SET({ language: "english" }), /spoken language/],
    [{ ...SET(), surprise: 1 }, /unexpected field/],
  ])
    assert.throws(() => checkSetRecord(body), message);
  assert.throws(() => checkSetRecord({ ...SET(), duration: 5 }, { partial: true }), /title, the tracks, or both/);
  // Too big to keep says so.
  const big = Array.from({ length: 4000 }, (_, i) => ({ start: i, end: i + 0.9, text: "x".repeat(200) }));
  assert.throws(() => checkTracks([{ lang: "en", source: true, cues: big }], 5000), /too large to keep/);
});

// ---- Timed words from the provider ----

test("a reply's words become tokens: Deepgram's punctuated words, OpenAI-style words with the segment's punctuation, and lines alone", () => {
  // Deepgram: the punctuated word as written.
  const deepgram = {
    results: { channels: [{ alternatives: [{ words: WORDS.map((w) => ({ ...w })) }] }] },
  };
  assert.deepEqual(transcriptTokens(deepgram).map((t) => t.text), ["Hello", "there.", "This", "is", "a", "test."]);
  // OpenAI-style: bare words, punctuation and capitals only in the segment.
  const openai = {
    words: WORDS.map(({ word, start, end }) => ({ word, start, end })),
    segments: [{ start: 0.2, end: 1.0, text: "Hello there." }, { start: 2.2, end: 3.2, text: " This is a test." }],
  };
  const tokens = transcriptTokens(openai);
  assert.deepEqual(tokens.map((t) => t.text), ["Hello", "there.", "This", "is", "a", "test."]);
  assert.deepEqual(tokens.map((t) => t.start), [0.2, 0.55, 2.2, 2.45, 2.6, 2.7]);
  // Words with nothing else: as they are. No words: nothing (the caller uses the lines).
  assert.deepEqual(transcriptTokens({ words: [{ word: "hi", start: 1, end: 1.2 }] }), [{ text: "hi", start: 1, end: 1.2 }]);
  assert.deepEqual(transcriptTokens({ segments: [{ start: 0, end: 2, text: "Hello." }] }), []);
  assert.deepEqual(transcriptTokens(null), []);
  // Segments alone (no words): words spread over each line, none outside it.
  const lines = transcriptSegments({ segments: [{ start: 1, end: 5, text: "Hello there my friend." }, { start: 6, end: 8, text: "Bye now." }] });
  const spread = tokensFromLines(lines);
  assert.deepEqual(spread.map((t) => t.text), ["Hello", "there", "my", "friend.", "Bye", "now."]);
  assert.ok(spread.slice(0, 4).every((t) => t.start >= 1 && t.end <= 5));
  assert.equal(spread[3].end, 5);
  assert.ok(spread.every((t, i) => i === 0 || t.start >= spread[i - 1].start));
  // A piece: the reply's tokens, else fine lines, else nothing rather than a guess.
  assert.equal(pieceTokens({ tokens: [{ text: "Hi", start: 1, end: 1.5 }] }, 300).length, 1);
  assert.equal(pieceTokens({ segments: lines }, 300).length, 6);
  assert.deepEqual(pieceTokens({ segments: [{ start: 0, end: 300, text: "A whole piece as one line." }] }, 300), []);
  assert.deepEqual(pieceTokens({ segments: [{ start: 0, end: 300, text: "x", untimed: true }] }, 300), []);
  assert.deepEqual(pieceTokens({ text: "no timings" }, 300), []);
  // Placed in the whole video, never outside the piece.
  assert.deepEqual(placeTokens([{ text: "Hi", start: 1, end: 2 }, { text: "late", start: 400, end: 401 }], 300, 300), [
    { text: "Hi", start: 301, end: 302 },
    { text: "late", start: 600, end: 600 },
  ]);
});

// ---- Money and privacy: transcription ----

test("the quote is exactly what a start holds; each piece is charged its own length and only the sound goes to the provider", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "cara");
  const q = (await p.agent.post("/api/subtitles/quote").send(BODY()).expect(200)).body;
  const factor = markupFactor({ token_balance: "0" }, s.cfg);
  assert.equal(q.units, 2 * sttCharge(300, STT, factor));
  assert.equal(q.credits, credits(q.units));
  assert.equal(q.pieces, 2);
  assert.equal(q.stt.provider, "deepgram");
  const before = balance(s.db, p.user.id);
  const run = (await start(p, { max_units: q.units }).expect(201)).body;
  // The shown maximum, the reserve, the hold and the balance drop are one number.
  assert.equal(run.reserved, q.credits);
  assert.equal(heldOf(s, p.user.id), q.units);
  assert.equal(balance(s.db, p.user.id).available, before.available - q.units);
  const holds = s.db.prepare("SELECT amount,kind FROM holds WHERE user_id=? ORDER BY rowid").all(p.user.id);
  assert.deepEqual(holds.map((h) => h.kind), ["audio", "audio"]);
  assert.equal(holds[0].amount, sttCharge(300, STT, factor));
  // A quote that's out of date is refused before anything is held.
  const stale = await p.agent.post("/api/subtitles").send({ ...BODY(), max_units: q.units + 1, requestId: "stale-1" });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "estimate_changed");
  assert.equal(heldOf(s, p.user.id), q.units, "and nothing more was held");
  // The provider says the piece ran 299.5 seconds: that's what's charged.
  const one = (await piece(p, run.id, 0).expect(200)).body;
  assert.equal(one.credits, sttCharge(299.5, STT, factor) / 10000);
  assert.deepEqual(one.tokens.map((x) => x.text), ["Hello", "there.", "This", "is", "a", "test."]);
  await piece(p, run.id, 0).expect(409);
  // A piece carrying a LIST chunk: only its format and samples go on.
  const two = (await piece(p, run.id, 1, 300, { list: true }).expect(200)).body;
  // Times are placed in the whole video.
  assert.equal(two.tokens[0].start, 300.2);
  assert.equal(two.done, 2);
  // The last piece ended the run: nothing is left held.
  assert.equal(heldOf(s, p.user.id), 0);
  await piece(p, run.id, 0).expect(404);
  const charged = spends(s, p.user.id);
  assert.deepEqual(charged.map((x) => x.description), ["Transcription: Nova 3", "Transcription: Nova 3"]);
  assert.equal(-charged[0].amount, sttCharge(299.5, STT, factor));
  assert.ok(-charged.reduce((n, x) => n + x.amount, 0) <= q.units);
  // What the provider got is plain WAV audio and fixed fields: no video, no name, no LIST chunk.
  assert.equal(g.calls.transcribe.length, 2);
  for (const raw of g.calls.transcribe) {
    const text = raw.toString("latin1");
    assert.match(text, /name="file"; filename="recording\.wav"/);
    assert.match(text, /Content-Type: audio\/wav/);
    assert.ok(text.includes("RIFF") && !text.includes("INFOISFT") && !text.includes("LIST"));
    // (The form's own boundary spells "formdata", so look at the file part.)
    const file = text.slice(text.indexOf("RIFF"), text.indexOf("\r\n--", text.indexOf("RIFF")));
    assert.ok(!/ftyp|moov|mdat/.test(file) && !/video\//.test(text), "no video container bytes");
    assert.deepEqual([...text.matchAll(/Content-Disposition: form-data; name="([^"]+)"/gi)].map((m) => m[1]).sort(), ["file", "model", "response_format", "timestamp_granularities[]", "timestamp_granularities[]"]);
  }
});

test("only audio is accepted: a video container, a wrong format or a wrong length is refused before the provider is called", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "dana");
  const run = (await start(p).expect(201)).body;
  const fakeMp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.alloc(300000)]);
  for (const audio of [
    "data:video/mp4;base64," + fakeMp4.toString("base64"),
    "data:audio/wav;base64," + fakeMp4.toString("base64"),
    "data:audio/wav;base64," + wav(3, { rate: 44100 }).toString("base64"),
    "data:audio/wav;base64," + wav(3, { channels: 2 }).toString("base64"),
    pieceUrl(200),
    "not a data url",
  ]) {
    const res = await p.agent.post(`/api/subtitles/${run.id}/pieces/0`).send({ audio });
    assert.equal(res.status, 400, audio.slice(0, 30));
    assert.equal(res.body.error.code, "invalid_audio");
  }
  assert.equal(g.calls.transcribe.length, 0, "the provider never saw any of it");
  assert.equal(heldOf(s, p.user.id) > 0, true);
  await p.agent.delete(`/api/subtitles/${run.id}`).expect(200);
  assert.equal(heldOf(s, p.user.id), 0);
  assert.equal(spends(s, p.user.id).length, 0);
  // The page sends a piece as plain sound only (src/Subtitles.jsx): never the file.
  const page = readFileSync(new URL("../src/Subtitles.jsx", import.meta.url), "utf8");
  assert.match(page, /const samples = await rec\.read\(piece\.start, piece\.start \+ piece\.seconds\);/);
  assert.match(page, /dataUrl\(encodeWav16\(samples\)\)/);
  assert.match(page, /body: \{ audio \}/);
  assert.ok(!/FormData|readAsDataURL\(file|body: file\b|body: \{[^}]*\bfile\b/.test(page), "the file itself is never posted");
  // Only the local player gets the video, from a Blob URL that's revoked.
  assert.match(page, /URL\.createObjectURL\(media\)/);
  assert.match(page, /URL\.revokeObjectURL/);
});

test("a piece that fails, or has no usable timing, is charged nothing and can be retried; discarding releases everything left", async (t) => {
  let mode = "fail";
  const g = await gateway(t, {
    transcribe: () =>
      mode === "fail"
        ? { status: 500 }
        : mode === "coarse"
          ? { text: "A whole piece said in one go.", duration: 300, segments: [{ start: 0, end: 300, text: "A whole piece said in one go." }] }
          : mode === "silent"
            ? { text: "", duration: 300, words: [], segments: [] }
            : DEFAULT_REPLY(),
  });
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "eli");
  const before = balance(s.db, p.user.id);
  const run = (await start(p).expect(201)).body;
  const held = heldOf(s, p.user.id);
  const failed = await piece(p, run.id, 0);
  assert.ok(failed.status >= 400);
  assert.match(failed.body.error.message, /Nothing was charged for this piece/);
  assert.equal(heldOf(s, p.user.id), held, "the hold stays for a retry");
  assert.equal(spends(s, p.user.id).length, 0);
  // Words the provider can't time are refused, not guessed: charged nothing.
  mode = "coarse";
  const coarse = await piece(p, run.id, 0);
  assert.equal(coarse.status, 502);
  assert.equal(coarse.body.error.code, "subtitles_no_timings");
  assert.match(coarse.body.error.message, /Nothing was charged/);
  assert.equal(spends(s, p.user.id).length, 0);
  assert.equal(heldOf(s, p.user.id), held);
  // The retry works.
  mode = "ok";
  await piece(p, run.id, 0).expect(200);
  assert.equal(spends(s, p.user.id).length, 1);
  // Discard: the second piece's hold is released; the first stays charged.
  const gone = (await p.agent.delete(`/api/subtitles/${run.id}`).expect(200)).body;
  assert.equal(gone.ended, true);
  assert.equal(gone.credits_charged, credits(spends(s, p.user.id).reduce((n, x) => n - x.amount, 0)));
  assert.equal(heldOf(s, p.user.id), 0);
  assert.ok(balance(s.db, p.user.id).available > before.available - 2 * sttCharge(300, STT, markupFactor({ token_balance: "0" }, s.cfg)));
  await p.agent.delete(`/api/subtitles/${run.id}`).expect(200);
  // A silent piece is charged for the sound it was given and says nothing was heard.
  const again = (await start(p, { duration: 60, chunks: [60] }).expect(201)).body;
  mode = "silent";
  const quiet = (await piece(p, again.id, 0, 60).expect(200)).body;
  assert.deepEqual(quiet.tokens, []);
});

test("Private Mode is refused for transcription, Auto is declined, and other accounts' runs are out of reach", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "fay");
  const b = await person(s, "gus");
  const refused = await a.agent.post("/api/subtitles/quote").send(BODY({ private: true })).expect(400);
  assert.equal(refused.body.error.code, "subtitles_private_unavailable");
  assert.match(refused.body.error.message, /Private Mode/);
  assert.equal((await a.agent.post("/api/subtitles").send({ ...BODY({ private: true }), requestId: "p1" })).status, 400);
  assert.equal((await a.agent.post("/api/subtitles/quote").send(BODY({ auto: {} })).expect(400)).body.error.code, "auto_not_offered");
  assert.equal((await a.agent.post("/api/subtitles/quote").send(BODY({ language: "klingon" })).expect(400)).body.error.code, "invalid_request");
  assert.equal((await a.agent.post("/api/subtitles/quote").send(BODY({ chunks: [100, 100] })).expect(400)).body.error.code, "invalid_plan");
  assert.equal((await a.agent.post("/api/subtitles/quote").send(BODY({ stt: "no-such-model" }))).status >= 400, true);
  const run = (await start(a).expect(201)).body;
  const theirs = await b.agent.post(`/api/subtitles/${run.id}/pieces/0`).send({ audio: pieceUrl(300) });
  assert.equal(theirs.status, 404);
  assert.equal(theirs.body.error.code, "subtitles_not_found");
  // A stranger's discard changes nothing.
  await b.agent.delete(`/api/subtitles/${run.id}`).expect(200);
  assert.ok(heldOf(s, a.user.id) > 0);
  // Off the record runs the same, and files nothing about itself.
  const off = (await start(a, { ephemeral: true }).expect(201)).body;
  assert.ok(off.id);
  // A new run replaces the last, releasing what it held.
  assert.equal(count(s, "subtitle_sets"), 0);
});

test("the worker's sweep ends a run nobody has touched for 30 minutes, releasing what it held", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "hal");
  const first = (await start(p).expect(201)).body;
  await piece(p, first.id, 0).expect(200);
  // A second start ends the first: its open holds are released.
  const second = (await start(p).expect(201)).body;
  await piece(p, first.id, 1).expect(404);
  assert.ok(heldOf(s, p.user.id) > 0);
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31 * 60000;
    await s.tick();
  } finally {
    Date.now = realNow;
  }
  assert.equal(heldOf(s, p.user.id), 0);
  await piece(p, second.id, 0).expect(404);
  assert.equal(spends(s, p.user.id).length, 1, "only the finished piece was charged");
});

// ---- Translation ----

const TRACK = () => Array.from({ length: 95 }, (_, i) => ({ start: i * 3, end: i * 3 + 2.5, text: `Cue number ${i + 1} says something.` }));
const partsOf = (cues) => translationBatches(cues);
const messagesOf = (batches, target = "es") => batches.map((batch) => translateMessages({ target, batch, of: batches.length }));
const sizesOf = (batches, target) => messagesOf(batches, target).map(measure);
const quoteBody = (batches, extra = {}) => ({ target: "es", model: MODEL, sizes: sizesOf(batches, extra.target || "es"), ...extra });
const runBody = (batches, units, extra = {}) => ({ target: "es", model: MODEL, of: batches.length, batches, max_units: units, requestId: "tr-" + Math.random(), ...extra });

test("translation: batches, the quote is the hold, timings are kept and every cue comes back once", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ida");
  const cues = TRACK();
  const batches = partsOf(cues);
  assert.equal(batches.length, 3, "95 cues, 40 at a time");
  assert.deepEqual(batches.map((b) => b.items.length), [40, 40, 15]);
  assert.equal(batches[1].items[0].n, 41);
  const q = (await p.agent.post("/api/subtitles/translate/quote").send(quoteBody(batches)).expect(200)).body;
  assert.equal(q.parts.length, 3);
  assert.equal(q.credits, credits(q.part_units.reduce((a, b) => a + b, 0)));
  // A quote is sent sizes, never text.
  await p.agent.post("/api/subtitles/translate/quote").send({ ...quoteBody(batches), batches }).expect(400);
  const before = balance(s.db, p.user.id).available;
  const res = await sse(p.agent.post("/api/subtitles/translate").send(runBody(batches, q.units))).expect(200);
  const started = res.body[0].translate;
  assert.equal(started.stage, "started");
  assert.equal(started.reserved, q.credits, "the shown maximum is the hold");
  const done = res.body.at(-1);
  assert.equal(done.translate.status, "done");
  assert.equal(done.translate.done, 3);
  assert.equal(done.anonyma.stored, false);
  const parts = res.body.filter((e) => e.translate.stage === "part" && e.translate.status === "done");
  assert.equal(parts.length, 3);
  const translated = parts.flatMap((e) => e.translate.cues).sort((a, b) => a.n - b.n);
  assert.equal(translated.length, 95);
  // Timings are the track's own: applying the translation moves nothing.
  const es = applyTranslation(cues, translated);
  assert.equal(es.length, cues.length);
  es.forEach((c, i) => {
    assert.equal(c.start, cues[i].start);
    assert.equal(c.end, cues[i].end);
    assert.equal(flat(c.text), "ES " + cues[i].text);
  });
  // Charged on usage, never more than held; nothing is left held.
  const spent = before - balance(s.db, p.user.id).available;
  assert.ok(spent > 0 && spent <= q.units, `${spent} of ${q.units}`);
  assert.equal(heldOf(s, p.user.id), 0);
  assert.equal(spends(s, p.user.id).length, 3);
  // What the model saw: fixed instructions and the cues as data, nothing else.
  assert.equal(g.calls.chat.length, 3);
  const sent = g.calls.chat[0].messages;
  assert.match(sent[0].content, /^You translate subtitles for ANONYMA Subtitles\./);
  assert.match(sent[1].content, /<document name="Part 1 of 3"/);
  assert.match(sent[1].content, /data-notice|data/i);
  assert.ok(g.calls.chat.every((b) => b.max_tokens >= 8000 || b.max_tokens > 0));
  assert.equal(g.calls.chat.reduce((n, b) => n + cuesIn(b).length, 0), 95);
  // A run whose total isn't the shown one is refused with nothing held.
  const stale = await p.agent.post("/api/subtitles/translate").send(runBody(batches, q.units + 1));
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "estimate_changed");
  assert.equal(heldOf(s, p.user.id), 0);
});

test("translation: a part that fails, loses a cue, loses a Veil detail or is cut short is charged nothing", async (t) => {
  const cues = TRACK().slice(0, 6);
  const batches = partsOf(cues);
  assert.equal(batches.length, 1);
  const cases = [
    ["a provider failure", { chatStatus: 500 }, "translate_failed"],
    ["not JSON at all", { translate: "Sorry, I can't help with that." }, "translate_empty"],
    ["a missing cue", { translate: (i, body) => JSON.stringify(cuesIn(body).slice(1).map((c) => ({ n: c.n, text: "x" }))) }, "translate_count"],
    ["an empty translation", { translate: (i, body) => JSON.stringify(cuesIn(body).map((c) => ({ n: c.n, text: c.n === 2 ? "" : "x" }))) }, "translate_empty"],
    ["cut short", { translate: '[{"n": 1, "text": "Hola', finish: "length" }, "translate_length"],
  ];
  for (const [name, plan, code] of cases) {
    const g = await gateway(t, plan);
    const s = fixture(t, { gatewayUrl: g.url });
    const p = await person(s, "fail" + Math.abs(name.length * 7 + code.length));
    const q = (await p.agent.post("/api/subtitles/translate/quote").send(quoteBody(batches)).expect(200)).body;
    const before = balance(s.db, p.user.id).available;
    const res = await sse(p.agent.post("/api/subtitles/translate").send(runBody(batches, q.units))).expect(200);
    const part = res.body.find((e) => e.translate.stage === "part" && e.translate.status === "failed");
    assert.ok(part, name);
    assert.equal(part.translate.code, code, name);
    assert.match(part.translate.message, /wasn't (used or )?charged/, name);
    const end = res.body.at(-1).translate;
    assert.equal(end.status, "partial", name);
    assert.equal(end.credits_charged, 0, name);
    assert.equal(balance(s.db, p.user.id).available, before, name + ": nothing charged");
    assert.equal(heldOf(s, p.user.id), 0, name + ": nothing left held");
    assert.equal(spends(s, p.user.id).length, 0, name);
  }
  // Veil's placeholders must all come back.
  const masked = [{ start: 0, end: 2, text: "Write to [EMAIL_1] today." }, { start: 3, end: 5, text: "Then call [PHONE_1]." }];
  const mb = partsOf(masked);
  const lost = await gateway(t, { translate: (i, body) => JSON.stringify(cuesIn(body).map((c) => ({ n: c.n, text: "Escribe hoy." }))) });
  const s = fixture(t, { gatewayUrl: lost.url });
  const p = await person(s, "veil-lost");
  const q = (await p.agent.post("/api/subtitles/translate/quote").send(quoteBody(mb)).expect(200)).body;
  const res = await sse(p.agent.post("/api/subtitles/translate").send(runBody(mb, q.units, { veil_masked: 2 }))).expect(200);
  assert.equal(res.body.find((e) => e.translate.status === "failed").translate.code, "translate_placeholders");
  assert.equal(spends(s, p.user.id).length, 0);
  // And kept ones settle, with the tags untouched.
  const kept = await gateway(t, { translate: (i, body) => JSON.stringify(cuesIn(body).map((c) => ({ n: c.n, text: c.text.replace("Write to", "Escribe a").replace("Then call", "Luego llama a") }))) });
  const s2 = fixture(t, { gatewayUrl: kept.url });
  const p2 = await person(s2, "veil-kept");
  const q2 = (await p2.agent.post("/api/subtitles/translate/quote").send(quoteBody(mb)).expect(200)).body;
  const ok = await sse(p2.agent.post("/api/subtitles/translate").send(runBody(mb, q2.units, { veil_masked: 2 }))).expect(200);
  assert.deepEqual(ok.body.find((e) => e.translate.status === "done").translate.cues.map((c) => c.text), ["Escribe a [EMAIL_1] today.", "Luego llama a [PHONE_1]."]);
  assert.ok(ok.body.at(-1).anonyma.privacy === undefined || typeof ok.body.at(-1).anonyma.privacy === "object");
});

test("translation: replies are read tolerantly, and a reply that isn't the cues is unusable", () => {
  const items = [{ n: 1, text: "Hello" }, { n: 2, text: "Goodbye" }];
  const same = { texts: [{ n: 1, text: "Hola" }, { n: 2, text: "Adiós" }] };
  // The shapes: a list of objects, of strings, a fenced one, one with prose around it, an object holding the list, numbers to text.
  assert.deepEqual(parseTranslation('[{"n":1,"text":"Hola"},{"n":2,"text":"Adiós"}]', items), same);
  assert.deepEqual(parseTranslation('["Hola","Adiós"]', items), same);
  assert.deepEqual(parseTranslation('```json\n[{"n":1,"text":"Hola"},{"n":2,"text":"Adiós"}]\n```', items), same);
  assert.deepEqual(parseTranslation('Here you go:\n[{"n":1,"text":"Hola"},{"n":2,"text":"Adiós"}]\nHope that helps!', items), same);
  assert.deepEqual(parseTranslation('{"cues":[{"n":2,"text":"Adiós"},{"n":1,"text":"Hola"}]}', items), same, "by number, not by position");
  assert.deepEqual(parseTranslation('{"1":"Hola","2":"Adiós"}', items), same);
  assert.deepEqual(parseTranslation('[{"n":1,"text":["Ho","la"]},{"n":2,"text":{"text":"Adiós"}}]', items), { texts: [{ n: 1, text: "Ho la" }, { n: 2, text: "Adiós" }] });
  assert.deepEqual(parseTranslation('[{"id":1,"translation":"Hola"},{"id":2,"translation":"Adiós"}]', items), same);
  // Not usable: not JSON, a missing cue, an empty text, a wrong count.
  assert.equal(parseTranslation("I can't do that.", items).problem, "json");
  assert.equal(parseTranslation('["Hola"]', items).problem, "count");
  assert.equal(parseTranslation('[{"n":1,"text":"Hola"},{"n":3,"text":"x"},{"n":4,"text":"y"}]', items).problem, "count");
  assert.equal(parseTranslation('["Hola",""]', items).problem, "empty");
  assert.equal(parseTranslation(null, items).problem, "json");
  assert.deepEqual(firstJson('```\n{"a":1}\n```'), { a: 1 });
  assert.equal(firstJson("no json"), null);
  // A reply that nests brackets inside a string is still read whole.
  assert.deepEqual(parseTranslation('Sure: [{"n":1,"text":"a ] b"},{"n":2,"text":"c"}] done', items).texts.map((x) => x.text), ["a ] b", "c"]);
  // The request's checks.
  const batches = translationBatches([{ start: 0, end: 1, text: "Hi\nthere" }, { start: 1, end: 2, text: "Bye" }]);
  assert.deepEqual(batches[0].items, [{ n: 1, text: "Hi there" }, { n: 2, text: "Bye" }]);
  assert.match(batchDocument(batches[0].items), /^\[\n\{"n":1,"text":"Hi there"\},\n\{"n":2,"text":"Bye"\}\n\]$/);
  for (const [raw, of, message] of [
    [[{ index: 0, items: [{ n: 1, text: "a" }, { n: 1, text: "b" }] }], 1, /number is invalid/],
    [[{ index: 3, items: [{ n: 1, text: "a" }] }], 1, /number is invalid/],
    [[{ index: 0, items: [{ n: 1, text: "a\nb" }] }], 1, /one line/],
    [[{ index: 0, items: [{ n: 1, text: "" }] }], 1, /one line/],
    [[{ index: 0, items: [{ n: 1, text: "a", extra: 1 }] }], 1, /malformed/],
    [[{ index: 0, items: [] }], 1, /1 to 40/],
    [[], 1, /nothing to translate/],
    [[{ index: 0, items: [{ n: 1, text: "a" }] }], 0, /1 to 150/],
  ])
    assert.throws(() => checkBatches(raw, of), message);
});

test("translation: Seed Guard, unknown fields, Private Mode's zero-data-retention rule and one run at a time", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "joanna");
  const seedBatches = partsOf([{ start: 0, end: 5, text: SEED }]);
  const q = (await p.agent.post("/api/subtitles/translate/quote").send(quoteBody(seedBatches)).expect(200)).body;
  const seed = await p.agent.post("/api/subtitles/translate").send(runBody(seedBatches, q.units));
  assert.equal(seed.status, 400);
  assert.equal(seed.body.error.code, "seed_phrase_blocked");
  assert.equal(heldOf(s, p.user.id), 0);
  assert.equal(g.calls.chat.length, 0, "never sent");
  const batches = partsOf(TRACK().slice(0, 3));
  const bad = await p.agent.post("/api/subtitles/translate/quote").send({ ...quoteBody(batches), memory: true }).expect(400);
  assert.equal(bad.body.error.code, "invalid_request");
  assert.equal((await p.agent.post("/api/subtitles/translate/quote").send({ ...quoteBody(batches), target: "tlh" }).expect(400)).body.error.code, "invalid_request");
  assert.equal((await p.agent.post("/api/subtitles/translate/quote").send({ ...quoteBody(batches), auto: {} }).expect(400)).body.error.code, "auto_not_offered");
  // A model with no zero data retention can't take Private Mode.
  const priv = await p.agent.post("/api/subtitles/translate/quote").send({ ...quoteBody(batches), private: true }).expect(400);
  assert.equal(priv.body.error.code, "private_model_required");
});

// ---- Saved sets ----

test("saved sets: save, list, open, rename, edit and delete, only ever your own, without a title from the file", async (t) => {
  const s = fixture(t);
  const a = await person(s, "kim");
  const b = await person(s, "lou");
  const made = (await a.agent.post("/api/subtitles/sets").send(SET()).expect(201)).body;
  assert.match(made.id, /^subs_/);
  assert.equal(made.tracks[0].cues[0].text, "Hello there.");
  assert.deepEqual(made.track_list, [{ lang: "en", source: true, cues: 2 }]);
  const list = (await a.agent.get("/api/subtitles/sets").expect(200)).body;
  assert.equal(list.data.length, 1);
  assert.ok(!("tracks" in list.data[0]), "the list carries no cues");
  assert.equal((await a.agent.get(`/api/subtitles/sets/${made.id}`).expect(200)).body.tracks.length, 1);
  // Someone else's is never found, changed or deleted.
  await b.agent.get(`/api/subtitles/sets/${made.id}`).expect(404);
  await b.agent.patch(`/api/subtitles/sets/${made.id}`).send({ title: "mine now" }).expect(404);
  await b.agent.delete(`/api/subtitles/sets/${made.id}`).expect(404);
  assert.equal((await b.agent.get("/api/subtitles/sets").expect(200)).body.data.length, 0);
  // Rename, then edit and add a translation.
  const renamed = (await a.agent.patch(`/api/subtitles/sets/${made.id}`).send({ title: "Standup" }).expect(200)).body;
  assert.equal(renamed.title, "Standup");
  assert.equal(renamed.tracks.length, 1);
  const es = { lang: "es", source: false, cues: [{ start: 0.5, end: 2.5, text: "Hola." }, { start: 3, end: 5.5, text: "Esto es una prueba." }] };
  const edited = (await a.agent.patch(`/api/subtitles/sets/${made.id}`).send({ tracks: [{ ...made.tracks[0], cues: [{ start: 0.5, end: 2.5, text: "Hello, there." }] }, es] }).expect(200)).body;
  assert.equal(edited.tracks.length, 2);
  assert.equal(edited.tracks[0].cues[0].text, "Hello, there.");
  assert.equal(edited.title, "Standup");
  await a.agent.patch(`/api/subtitles/sets/${made.id}`).send({}).expect(400);
  await a.agent.patch(`/api/subtitles/sets/${made.id}`).send({ duration: 5 }).expect(400);
  // Bad sets say why, and Seed Guard keeps a phrase out of storage.
  const bad = async (body, code = "invalid_subtitles") => assert.equal((await a.agent.post("/api/subtitles/sets").send(body).expect(400)).body.error.code, code);
  await bad(SET({ duration: 0.5 }), "invalid_subtitles");
  await bad(SET({ tracks: [{ ...SET().tracks[0], cues: [{ start: 0, end: 30, text: "past the end" }] }], duration: 5 }));
  await bad({ title: "x" });
  await bad(SET({ tracks: [{ lang: "en", source: true, cues: [{ start: 0, end: 3, text: SEED }] }] }), "seed_phrase_blocked");
  assert.equal((await a.agent.patch(`/api/subtitles/sets/${made.id}`).send({ title: "ok", tracks: [{ lang: "en", source: true, cues: [{ start: 0, end: 3, text: SEED }] }] }).expect(400)).body.error.code, "seed_phrase_blocked");
  const huge = Array.from({ length: 3000 }, (_, i) => ({ start: i * 0.03, end: i * 0.03 + 0.02, text: "x".repeat(200) }));
  const tooBig = await a.agent.post("/api/subtitles/sets").send(SET({ duration: 3600, tracks: [{ lang: "en", source: true, cues: huge }] })).expect(400);
  assert.equal(tooBig.body.error.code, "subtitles_too_large");
  // At most 100 per account, enforced by the database too.
  const insert = s.db.prepare("INSERT INTO subtitle_sets(id,user_id,title,duration,language,tracks,created,updated) VALUES(?,?,?,?,?,?,?,?)");
  for (let i = 1; i < 100; i++) insert.run(uid("subs_"), a.user.id, "S" + i, 10, "", "[]", now(), now());
  const full = await a.agent.post("/api/subtitles/sets").send(SET()).expect(409);
  assert.equal(full.body.error.code, "subtitles_limit");
  await a.agent.delete(`/api/subtitles/sets/${made.id}`).expect(200);
  await a.agent.delete(`/api/subtitles/sets/${made.id}`).expect(404);
  await a.agent.get(`/api/subtitles/sets/${made.id}`).expect(404);
});

test("erase and export: sets are in the account export, and Panic Wipe, Inactivity Wipe's erase and closing the account remove them", async (t) => {
  const s = fixture(t);
  const a = await person(s, "wiper");
  const other = await person(s, "keeper");
  await a.agent.post("/api/subtitles/sets").send(SET()).expect(201);
  await a.agent.post("/api/subtitles/sets").send(SET({ title: "Second" })).expect(201);
  await other.agent.post("/api/subtitles/sets").send(SET({ title: "Not yours" })).expect(201);
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.subtitleSets.length, 2);
  assert.deepEqual(exported.subtitleSets[0].tracks, checkTracks(SET().tracks.map((tr) => ({ ...tr })), 120), "whole sets");
  assert.ok(!JSON.stringify(exported.subtitleSets).includes("Not yours"));
  // The shared erase (what Inactivity Wipe and closure call).
  const third = await person(s, "shared-erase");
  await third.agent.post("/api/subtitles/sets").send(SET()).expect(201);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM subtitle_sets WHERE user_id=?").get(third.user.id).n, 1);
  eraseAccountContent(s.db, { id: third.user.id });
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM subtitle_sets WHERE user_id=?").get(third.user.id).n, 0);
  const before = balance(s.db, a.user.id).total;
  await a.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM subtitle_sets WHERE user_id=?").get(a.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM subtitle_sets WHERE user_id=?").get(other.user.id).n, 1, "others keep theirs");
  assert.equal(balance(s.db, a.user.id).total, before, "credits stay");
  // Closing the account erases them too.
  await other.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(count(s, "subtitle_sets"), 0);
});

test("a run in progress is ended by Panic Wipe and account closure, releasing its holds", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const a = await person(s, "mona");
  await start(a).expect(201);
  assert.ok(heldOf(s, a.user.id) > 0);
  await a.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(heldOf(s, a.user.id), 0);
  const b = await person(s, "nate");
  await start(b).expect(201);
  await b.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
});

test("nothing about the video, the words or the cues is written to the server's logs, and the export shows no media", async (t) => {
  const g = await gateway(t, { transcribe: () => ({ ...DEFAULT_REPLY(), text: `Mail ${SECRET_EMAIL} now.`, words: [{ word: "mail", punctuated_word: SECRET_EMAIL, start: 0.2, end: 0.9 }], segments: [] }) });
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "olga");
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(original)) console[k] = (...args) => lines.push(args.map(String).join(" "));
  try {
    const run = (await start(p).expect(201)).body;
    await piece(p, run.id, 0).expect(200);
    await piece(p, run.id, 1).expect(200);
    const id = (await p.agent.post("/api/subtitles/sets").send(SET({ title: "Secret board plan" })).expect(201)).body.id;
    await p.agent.patch(`/api/subtitles/sets/${id}`).send({ title: "Secret board plan v2" }).expect(200);
    await p.agent.post("/api/subtitles/sets").send({ ...SET(), duration: "x" }).expect(400);
    const b = partsOf([{ start: 0, end: 2, text: `Write to ${SECRET_EMAIL}.` }]);
    const q = (await p.agent.post("/api/subtitles/translate/quote").send(quoteBody(b)).expect(200)).body;
    await sse(p.agent.post("/api/subtitles/translate").send(runBody(b, q.units))).expect(200);
  } finally {
    Object.assign(console, original);
  }
  const all = lines.join("\n");
  for (const text of [SECRET_EMAIL, "Secret board plan", "Hello there", "recording.wav"]) assert.ok(!all.includes(text), `logged: ${text}`);
  // Only the sets the person saved are stored; the run kept nothing.
  const stored = JSON.stringify(s.db.prepare("SELECT * FROM subtitle_sets").all());
  assert.ok(!stored.includes(SECRET_EMAIL));
  const tables = s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
  for (const name of tables) {
    if (name === "subtitle_sets" || name === "users") continue;
    const dump = JSON.stringify(s.db.prepare(`SELECT * FROM ${name}`).all());
    assert.ok(!dump.includes(SECRET_EMAIL), `${name} holds a detail from the video`);
  }
});

// ---- Veil ----

test("Veil: masked text in a saved set and in translation is restored from the browser's map", () => {
  const state = createVeilState();
  const tracks = [{ lang: "en", source: true, cues: [{ start: 0, end: 2, text: `Write to ${SECRET_EMAIL} today.` }] }];
  const masked = mapTracks(tracks, (text) => veil(text, state).text);
  assert.ok(!JSON.stringify(masked).includes(SECRET_EMAIL));
  assert.match(masked[0].cues[0].text, /\[EMAIL_1\]/);
  assert.deepEqual(mapTracks(masked, (text) => unveil(text, state.map)), tracks);
  // The same value keeps the same tag across cues and tracks.
  const again = veil(`Also ${SECRET_EMAIL}`, state);
  assert.match(again.text, /\[EMAIL_1\]/);
  assert.equal(mapTracks(tracks, (x) => x)[0].cues[0].start, 0, "times untouched");
});

// ---- Local test mode ----

test("local test mode runs the whole flow with no provider: scripted words, a stand-in translation, and a saved set", async (t) => {
  const s = fixture(t, { testMode: true });
  const p = await person(s, "pia");
  const ts = subtitleTestTranscript({ start: 0, seconds: 300 });
  assert.equal(ts.tokens[0].text, "Okay,");
  assert.ok(ts.tokens.at(-1).end <= 300);
  const second = subtitleTestTranscript({ start: 300, seconds: 300 });
  assert.ok(second.tokens[0].start >= 0 && second.tokens[0].start < 300);
  const built = buildCues(ts.tokens);
  assert.ok(built.length > 20);
  assert.equal(flat(built[0].text), "Okay, let's get started.");
  const run = (await start(p).expect(201)).body;
  const one = (await piece(p, run.id, 0).expect(200)).body;
  assert.equal(one.local_test, true);
  assert.equal(one.tokens[0].text, "Okay,");
  const two = (await piece(p, run.id, 1).expect(200)).body;
  assert.ok(two.tokens[0].start >= 300);
  const cues = buildCues([...one.tokens, ...two.tokens]);
  const batches = partsOf(cues);
  const q = (await p.agent.post("/api/subtitles/translate/quote").send(quoteBody(batches)).expect(200)).body;
  const res = await sse(p.agent.post("/api/subtitles/translate").send(runBody(batches, q.units))).expect(200);
  assert.equal(res.body.at(-1).anonyma.local_test, true);
  const translated = res.body.filter((e) => e.translate.stage === "part" && e.translate.status === "done").flatMap((e) => e.translate.cues).sort((a, b) => a.n - b.n);
  assert.equal(translated.length, cues.length);
  assert.equal(translated[0].text, "Bien, empecemos.");
  const reply = subtitleTranslateTestReply(translateMessages({ target: "es", batch: batches[0], of: batches.length }));
  assert.equal(JSON.parse(reply).length, batches[0].items.length);
  assert.equal(subtitleTranslateTestReply([{ role: "system", content: "Something else." }]), null);
  const saved = await p.agent
    .post("/api/subtitles/sets")
    .send({ title: "Local test", duration: 600, language: "en", tracks: [{ lang: "en", source: true, cues }, { lang: "es", source: false, cues: applyTranslation(cues, translated) }] })
    .expect(201);
  assert.equal(saved.body.track_list.length, 2);
});

test("Chinese and Spanish: the update, the page and its messages are in both dictionaries", () => {
  const entry = UPDATES.find((u) => u.id === "subtitles");
  for (const file of ["zh", "es"]) {
    const raw = JSON.parse(readFileSync(new URL(`../src/i18n/${file}.json`, import.meta.url), "utf8"));
    const dict = compileDictionary(raw, file);
    for (const text of [entry.title, entry.tagline, ...entry.points]) assert.ok(raw.strings[text], `${file}: ${text}`);
    for (const text of [
      "Drop a video here",
      "Choose a video",
      "Only the sound goes out",
      "Make subtitles",
      "Download .srt",
      "Download .vtt",
      "Translate",
      "New video",
    ])
      assert.notEqual(translateText(text, dict) || text, text, `${file}: ${text}`);
  }
});

test("limits the browser and server share are consistent", () => {
  assert.equal(LIMITS.batchCues, 40);
  assert.ok(LIMITS.batches * LIMITS.batchCues >= LIMITS.cues, "every cue of a full track fits in a run");
  assert.equal(encodeWav16(new Float32Array(16000)).length, 44 + 32000);
  assert.equal(cleanPiece(Buffer.from(encodeWav16(new Float32Array(16000)))).seconds, 1);
});

test("the tool directory finds Subtitles by intent, in English and Chinese, and the other tools keep theirs", () => {
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  const entries = [...ws.matchAll(/^\s+\["(\w+)", "([^"]+)", "([^"]+)"\],$/gm)].map((m) => [m[1], m[2], m[3]]);
  const nav = entries.slice(entries.findIndex((e) => e[0] === "home"), entries.findIndex((e) => e[0] === "library") + 1);
  assert.ok(nav.some((e) => e[0] === "subtitles"), "registered in the directory, not as a top-level row");
  const first = (q) => rankTools(nav, q)[0]?.[0];
  for (const [q, id] of [
    ["subtitles", "subtitles"],
    ["add subtitles to my video", "subtitles"],
    ["make an srt file", "subtitles"],
    ["closed captions", "subtitles"],
    ["字幕", "subtitles"],
    ["meeting minutes", "notes"],
    ["translate a document", "translate"],
    ["read aloud", "audio"],
  ])
    assert.equal(first(q), id, q);
  assert.match(readFileSync(new URL("../src/tool-search.js", import.meta.url), "utf8"), /^  subtitles: '[^']*\p{Script=Han}/mu);
  // Not a top-level sidebar row beside Chat.
  assert.match(ws, /const primaryModes = \["chat", "image", "video"\];/);
});

test("the workspace copy and the update's own text are in both dictionaries", () => {
  const strings = [
    "Turn a video into subtitles you can edit, translate and download. Only its sound is sent.",
    "Opening Subtitles…",
    "Saved subtitles: their cues and timing, never a video",
    "Subtitles aren't available in Private Mode: no transcription model offers zero data retention.",
    "No speech was found in this video, so there are no subtitles to make.",
  ];
  for (const file of ["zh", "es"]) {
    const raw = JSON.parse(readFileSync(new URL(`../src/i18n/${file}.json`, import.meta.url), "utf8"));
    const dict = compileDictionary(raw, file);
    for (const text of strings) assert.ok(raw.strings[text], `${file}: ${text}`);
    // Patterns fill their numbers and names.
    for (const [text, want] of file === "zh"
      ? [["22 cues", "22 条"], ["Only the first 1 h 05 min of the video was transcribed, so the subtitles end there.", "1 小时 05 分钟"], ["3 parts didn't go through and weren't charged.", "3"]]
      : [["22 cues", "22 líneas"], ["Only the first 5 min of the video was transcribed, so the subtitles end there.", "5 min"], ["3 parts didn't go through and weren't charged.", "3"]])
      assert.ok((translateText(text, dict) || "").includes(want), `${file}: ${text} -> ${translateText(text, dict)}`);
  }
});

test("editing a saved set never re-sends the video: the page's requests carry cues, titles and pieces of sound only", () => {
  const page = readFileSync(new URL("../src/Subtitles.jsx", import.meta.url), "utf8");
  const calls = [...page.matchAll(/api\(\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]);
  assert.ok(calls.length >= 6);
  for (const path of calls) assert.match(path, /^\/api\/(subtitles|audio\/models)/, path);
  // The set's body is its title, duration, spoken language and tracks; a patch, its title and tracks.
  assert.match(page, /body: \{ title: state\.title, duration: state\.duration, language: state\.language, tracks \}/);
  assert.match(page, /body: \{ title: doc\.title, tracks \}/);
});

test("Model Status sees both model calls, and Auto is never offered on this page", () => {
  const route = readFileSync(new URL("../server/routes/subtitles.js", import.meta.url), "utf8");
  // The transcription of a piece and each translation call are counted like a chat's.
  assert.equal([...route.matchAll(/ctx\.modelStatus\.start\(/g)].length, 2);
  assert.equal([...route.matchAll(/probe\.fail\(/g)].length, 2);
  assert.equal([...route.matchAll(/probe\.done\(/g)].length, 2);
  // No Auto: the page has its own model pickers and the server declines the field.
  assert.equal([...route.matchAll(/AUTO_NOT_OFFERED/g)].length >= 3, true);
  const page = readFileSync(new URL("../src/Subtitles.jsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /AutoChip|autoModelReleased|"auto"/);
});
