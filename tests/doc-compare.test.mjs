import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { createApp } from "../server/app.js";
import { addCredit, balance, now, uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { prepareCompareRequest, compareTestReply } from "../server/compare.js";
import { knownPage } from "../src/site-routes.js";
import { paletteActions } from "../src/command-palette.js";
import { modeReleased } from "../src/lib.js";
import { createVeilState, veil } from "../src/veil.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { DATA_NOTICE_BLOCK } from "../src/documents.js";
import { extractOffice } from "../src/file-formats.js";
import {
  COMPARE_MAX_TOKENS,
  COMPARE_SYSTEM,
  LIMITS,
  TEXT_BUDGET,
  checkComparePayload,
  compareBudget,
  compareMessages,
  comparePayload,
  compareUserText,
} from "../src/compare-spec.js";
import {
  buildHunks,
  changeLabel,
  changesMarkdown,
  compareTexts,
  countsLine,
  diffSequences,
  normalizeText,
  partsText,
  redlineHTML,
  splitSentences,
  unitsOf,
  whereLabel,
  wordDiff,
  windowed,
} from "../src/doc-compare.js";
import { SAMPLE_ORIGINAL, SAMPLE_REVISED } from "../src/compare-sample.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-compare-"));
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
async function person(app, username = "compare_user") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
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

// The payload the page sends for two texts.
function payloadFor(original, revised, options = {}) {
  const result = compareTexts(original, revised, options.kinds ? { kinds: options.kinds } : {});
  return comparePayload({
    hunks: buildHunks(result),
    total: result.changes.length,
    original: "v1.txt",
    revised: "v2.txt",
    ...options,
  });
}
const SAMPLE = () => payloadFor(SAMPLE_ORIGINAL, SAMPLE_REVISED);
const ask = (agent, compare, extra = {}) =>
  agent.post("/api/chat").send({ model: MODEL, ephemeral: true, compare, ...extra });

// ---- The release gate ----

test("unreleased: a summary is refused before anything else, and there's no page, place or link", async (t) => {
  const mvp = fixture(t, "mvp,ephemeral");
  const a = await person(mvp.app);
  const before = balance(mvp.db, a.user.id).total;
  const body = { model: MODEL, ephemeral: true, compare: SAMPLE() };
  for (const path of ["/api/chat", "/API/Chat"]) {
    const res = await a.agent.post(path).send(body).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Document Compare is coming soon.");
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
  assert.equal(config.releases.features.doccompare, false);
  const entry = config.releases.updates.find((u) => u.id === "doccompare");
  assert.equal(entry.title, "Document Compare");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  // The page: a 404 until release (served once the client is built).
  if (existsSync("dist/client/index.html")) {
    await request(mvp.app).get("/workspace/compare").expect(404);
    await request(fixture(t, "mvp,doccompare").app).get("/workspace/compare").expect(200);
  }
  assert.equal(knownPage("/workspace/compare"), false);
  assert.equal(knownPage("/workspace/compare", { compare: true }), true);
  // The client: no mode, no palette place.
  const cfg = (features) => ({ releases: { features } });
  assert.equal(modeReleased(cfg({}), "compare"), false);
  assert.equal(modeReleased(cfg({ doccompare: true }), "compare"), true);
  const ids = (c) => paletteActions({ config: c, mode: "chat", signedIn: true }).map((x) => x.id);
  assert.ok(!ids(cfg({})).includes("go-compare"));
  assert.ok(ids(cfg({ doccompare: true })).includes("go-compare"));
  // Named "Compare docs", apart from Blind Compare and Cost Compare.
  const place = paletteActions({ config: cfg({ doccompare: true }), mode: "chat", signedIn: true }).find((x) => x.id === "go-compare");
  assert.equal(place.label, "Compare docs");
});

test("the gate is expressed in featuresFor: doccompare plus the off-the-record path it always takes", () => {
  const needs = (body, path = "/api/chat", method = "POST") => featuresFor({ path, method, body });
  assert.deepEqual(needs({ compare: {}, ephemeral: true }).sort(), ["doccompare", "ephemeral"]);
  assert.deepEqual(
    needs({ compare: {}, ephemeral: true, private: true }).sort(),
    ["doccompare", "ephemeral", "ephemeral", "private"],
  );
  assert.ok(!needs({ ephemeral: true, messages: [] }).includes("doccompare"));
  assert.ok(!needs({ compare: {} }, "/api/chat", "GET").includes("doccompare"));
  assert.ok(!needs({ compare: {} }, "/v1/chat/completions").includes("doccompare"));
});

test("the workspace keeps Compare out of sight until it's released, and runs the diff in a worker", () => {
  const src = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(src, /\.filter\(\(\[id\]\) => id !== "compare" \|\| isReleased\(config, "doccompare"\)\)/);
  assert.match(src, /mode === "compare" && \(!config \|\| isReleased\(config, "doccompare"\)\)/);
  assert.match(src, /mode === "compare" \? \(\s*isReleased\(config, "doccompare"\) &&/);
  assert.match(src, /const Compare = lazy\(\(\) => import\("\.\/Compare\.jsx"\)\)/);
  assert.match(src, /\["compare", "Compare docs", "Compare two documents[^"\n]+"\]/);
  assert.match(src, /compare: "Compare docs",/);
  const page = readFileSync(new URL("../src/Compare.jsx", import.meta.url), "utf8");
  assert.match(page, /new Worker\(new URL\("\.\/compare\.worker\.js", import\.meta\.url\), \{ type: "module" \}\)/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML|localStorage|sessionStorage|indexedDB/);
  // Document and model text are never translated.
  assert.match(page, /<p data-i18n="off">/);
  assert.match(page, /className="prose markdown" data-i18n="off"/);
  assert.match(page, /<h1>Compare docs<\/h1>/);
  // The server copies the shared module it imports.
  assert.match(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"), /src\/compare-spec\.js/);
  assert.match(readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8"), /doccompare: "diff"/);
});

// ---- The diff ----

// The length of a longest common subsequence, by dynamic programming.
function lcs(a, b) {
  const row = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let prev = 0;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j];
      row[j] = a[i - 1] === b[j - 1] ? prev + 1 : Math.max(row[j], row[j - 1]);
      prev = keep;
    }
  }
  return row[b.length];
}
function apply(runs, a, b) {
  const left = [],
    right = [];
  let i = 0,
    j = 0;
  for (const [op, n] of runs) {
    if (op === 0) {
      for (let k = 0; k < n; k++) {
        assert.equal(a[i + k], b[j + k], "kept items match");
        left.push(a[i + k]);
        right.push(b[j + k]);
      }
      i += n;
      j += n;
    } else if (op === -1) {
      left.push(...a.slice(i, i + n));
      i += n;
    } else {
      right.push(...b.slice(j, j + n));
      j += n;
    }
  }
  return { left, right, kept: runs.filter(([op]) => op === 0).reduce((s, [, n]) => s + n, 0) };
}
let seed = 7;
const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);

test("Myers' diff rebuilds both sides and is minimal", () => {
  for (let round = 0; round < 400; round++) {
    const a = Array.from({ length: Math.floor(random() * 30) }, () => Math.floor(random() * 5));
    const b = Array.from({ length: Math.floor(random() * 30) }, () => Math.floor(random() * 5));
    const runs = diffSequences(a, b);
    const { left, right, kept } = apply(runs, a, b);
    assert.deepEqual(left, a);
    assert.deepEqual(right, b);
    assert.equal(kept, lcs(a, b), `minimal for ${a} / ${b}`);
  }
  // Past the deadline it stays correct, only coarser, and says so.
  const clock = { deadline: 0 };
  const a = [1, 2, 3, 4, 5, 6],
    b = [9, 2, 3, 8, 5, 7];
  const { left, right } = apply(diffSequences(a, b, clock), a, b);
  assert.deepEqual([left, right], [a, b]);
  assert.equal(clock.timedOut, true);
});

test("the word diff marks exactly what changed, and both versions can be read back", () => {
  const parts = wordDiff("The notice period is thirty (30) days.", "The notice period is ten (10) days.");
  assert.deepEqual(parts, [
    [0, "The notice period is "],
    [-1, "thirty"],
    [1, "ten"],
    [0, " ("],
    [-1, "30"],
    [1, "10"],
    [0, ") days."],
  ]);
  // A lone space between two replacements joins them.
  assert.deepEqual(wordDiff("a b c", "x y c"), [[-1, "a b"], [1, "x y"], [0, " c"]]);
  // Numbers and hyphenated words stay whole.
  assert.deepEqual(wordDiff("USD 1,000.50 for a 30-day term", "USD 1,200.00 for a 30-day term"), [
    [0, "USD "],
    [-1, "1,000.50"],
    [1, "1,200.00"],
    [0, " for a 30-day term"],
  ]);
  // Chinese is compared character by character.
  assert.deepEqual(wordDiff("期限为三年", "期限为五年"), [[0, "期限为"], [-1, "三"], [1, "五"], [0, "年"]]);
  const words = ["the", "party", "shall", "not", "disclose", "any", "information", "to", "third", "parties", "unless"];
  for (let round = 0; round < 200; round++) {
    const pick = () => Array.from({ length: Math.floor(random() * 14) }, () => words[Math.floor(random() * words.length)]).join(" ");
    const x = pick(),
      y = pick();
    const p = wordDiff(x, y);
    assert.equal(partsText(p, 0), x);
    assert.equal(partsText(p, 1), y);
    // Removals come before additions within each change.
    for (let k = 1; k < p.length; k++) assert.ok(!(p[k - 1][0] === 1 && p[k][0] === -1));
  }
});

test("paragraphs are compared as changed, added, removed or moved, with counts", () => {
  const A = [
    "Mutual NDA",
    "Term. This Agreement lasts two (2) years from the Effective Date.",
    "Return. Each party shall return or destroy Confidential Information on request.",
    "Entire Agreement. This is the entire agreement between the parties about its subject.",
    "Law. This Agreement is governed by the laws of Delaware.",
    "Notices. Notices must be in writing.",
  ].join("\n\n");
  const B = [
    "Mutual NDA",
    "Term. This Agreement lasts five (5) years from the Effective Date.",
    "Law. This Agreement is governed by the laws of New York.",
    "Notices. Notices must be in writing.",
    "Non-solicitation. Neither party shall solicit the other's employees for twelve months.",
    "Entire Agreement. This is the entire agreement between the parties about its subject.",
  ].join("\n\n");
  const r = compareTexts(A, B);
  assert.equal(r.mode, "paragraphs");
  assert.deepEqual(r.rows.map((x) => x.t), ["same", "changed", "removed", "moved-out", "changed", "same", "added", "moved-in"]);
  assert.deepEqual(
    r.changes.map((c) => [c.kind, c.a, c.b]),
    [
      ["changed", [2, 2], [2, 2]],
      ["removed", [3, 3], null],
      ["changed", [5, 5], [3, 3]],
      ["added", null, [5, 5]],
      ["moved", [4, 4], [6, 6]],
    ],
  );
  assert.deepEqual(
    { changed: r.counts.changed, added: r.counts.added, removed: r.counts.removed, moved: r.counts.moved, total: r.counts.total },
    { changed: 2, added: 1, removed: 1, moved: 1, total: 5 },
  );
  assert.deepEqual(changeLabel(r, r.changes[0]), { del: "two", ins: "five" });
  assert.equal(whereLabel(r.changes[4]), "¶ 4 → ¶ 6");
  // The moved-out row points at where it went.
  assert.equal(r.rows[r.rows[3].to].t, "moved-in");
  // Every unit of both versions is accounted for exactly once.
  const seenA = r.rows.filter((x) => x.a !== undefined && x.t !== "moved-in").map((x) => x.a);
  const seenB = r.rows.filter((x) => x.b !== undefined).map((x) => x.b);
  assert.deepEqual(seenA, r.a.map((_, i) => i));
  assert.deepEqual(seenB, r.b.map((_, i) => i));
  // A move that was also edited is still a move, with its edits.
  const edited = compareTexts(
    "Intro line.\n\nConfidentiality survives for three years after the end of this Agreement.\n\nMiddle clause stays.\n\nLast clause stays.",
    "Intro line.\n\nMiddle clause stays.\n\nLast clause stays.\n\nConfidentiality survives for five years after the end of this Agreement.",
  );
  const moved = edited.rows.find((x) => x.t === "moved-in");
  assert.ok(moved?.parts, "an edited move carries its word diff");
  assert.equal(partsText(moved.parts, 1), "Confidentiality survives for five years after the end of this Agreement.");
  // A run of new paragraphs is one change.
  const run = compareTexts("A one.\n\nD four.", "A one.\n\nB two, a new clause.\n\nC three, another one.\n\nD four.");
  assert.deepEqual(run.changes.map((c) => [c.kind, c.b]), [["added", [2, 3]]]);
});

test("spacing isn't a change, identical documents have none, and PDF page breaks don't count", () => {
  assert.equal(normalizeText("a  b\t c \r\n\r\n d\u0007"), "a b c\n\nd");
  const same = compareTexts("One.\n\nTwo  words.", "One.\r\n\r\n\r\nTwo words.   ");
  assert.equal(same.changes.length, 0);
  assert.deepEqual(same.counts.total, 0);
  // PDFs are compared sentence by sentence across pages.
  assert.deepEqual(splitSentences("1. Definitions. The Company, e.g. Acme Inc. pays U.S. taxes. It must pay! Really? Yes."), [
    "1. Definitions.",
    "The Company, e.g. Acme Inc. pays U.S. taxes.",
    "It must pay!",
    "Really?",
    "Yes.",
  ]);
  const page1 = "The Supplier shall deliver the goods. Payment is due within thirty days of the",
    page2 = "invoice date. Late payment bears interest at two percent per month.";
  const reflowed = "The Supplier shall deliver the goods. Payment is due within thirty days\n\nof the invoice date. Late payment bears interest at two percent per month.";
  const r = compareTexts(`${page1}\n\n${page2}`, reflowed, { kinds: { a: "pdf", b: "pdf" } });
  assert.equal(r.mode, "sentences");
  assert.equal(r.changes.length, 0, "a moved page break is not a change");
  assert.deepEqual(unitsOf(`${page1}\n\n${page2}`, "pdf", "sentences"), [
    "The Supplier shall deliver the goods.",
    "Payment is due within thirty days of the invoice date.",
    "Late payment bears interest at two percent per month.",
  ]);
  // A PDF against a DOCX: both sides in sentences.
  const mixed = compareTexts(`${page1}\n\n${page2}`, "The Supplier shall deliver the goods. Payment is due within ten days of the invoice date.", {
    kinds: { a: "pdf", b: "office" },
  });
  assert.deepEqual(mixed.changes.map((c) => c.kind), ["changed", "removed"]);
});

test("the sample NDAs show every kind of change", () => {
  const r = compareTexts(SAMPLE_ORIGINAL, SAMPLE_REVISED);
  assert.deepEqual(
    { changed: r.counts.changed, added: r.counts.added, removed: r.counts.removed, moved: r.counts.moved },
    { changed: 7, added: 1, removed: 1, moved: 1 },
  );
});

// ---- Only the changed parts go to the AI ----

test("the payload carries the changed passages and a little context, and no other text", () => {
  // Forty paragraphs, each with its own marker word; one word changes in
  // paragraph 20.
  const para = (i, word = "keeps") => `Clause M${String(i).padStart(2, "0")}X says the supplier ${word} the records for audit and review by the buyer.`;
  const original = Array.from({ length: 40 }, (_, i) => para(i + 1)).join("\n\n");
  const revised = Array.from({ length: 40 }, (_, i) => para(i + 1, i === 19 ? "destroys" : "keeps")).join("\n\n");
  const payload = payloadFor(original, revised);
  const sent = JSON.stringify(payload) + compareUserText(payload);
  const markers = [...sent.matchAll(/M(\d\d)X/g)].map((m) => Number(m[1]));
  assert.deepEqual([...new Set(markers)].sort((a, b) => a - b), [18, 19, 20, 21, 22], "the change and two paragraphs either side");
  assert.equal(payload.hunks.length, 1);
  const [h] = payload.hunks;
  assert.deepEqual([h.kind, h.a, h.b], ["changed", [20, 20], [20, 20]]);
  assert.match(h.lines[0].text, /\[-keeps-\]\{\+destroys\+\}/);
  assert.ok(h.before.length <= 161 && h.after.length <= 161, "context is cut short");
  // Inside a long changed paragraph only a window around the edit goes.
  const words = Array.from({ length: 200 }, (_, i) => `w${String(i + 1).padStart(3, "0")}`);
  const edited = [...words];
  edited[99] = "CHANGED";
  const long = payloadFor(words.join(" "), edited.join(" "));
  const line = long.hunks[0].lines[0].text;
  const kept = [...line.matchAll(/w(\d{3})/g)].map((m) => Number(m[1]));
  // The first three words (a clause's heading), eight either side, and the
  // removed word itself.
  assert.deepEqual(kept, [1, 2, 3, 92, 93, 94, 95, 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108]);
  assert.equal(line, "w001 w002 w003 … w092 w093 w094 w095 w096 w097 w098 w099 [-w100-]{+CHANGED+} w101 w102 w103 w104 w105 w106 w107 w108 …");
  // Neighbouring changes don't repeat context between them.
  const near = payloadFor("A one.\n\nB two.\n\nC three.\n\nD four.", "A one.\n\nB 2.\n\nC three.\n\nD 4.");
  assert.equal(near.hunks[0].after, "C three.");
  assert.equal(near.hunks[1].before, "");
});

test("the message is the passages as data, with the notice, and a request stays within its budget", () => {
  const payload = payloadFor("Keep this.\n\nThe fee is <b>100</b> & due now.", "Keep this.\n\nThe fee is <b>200</b> & due now.");
  const text = compareUserText(payload);
  assert.ok(text.startsWith("Summarize the changes between two versions of a document.\nOriginal: \"v1.txt\"\nRevised: \"v2.txt\"\nThere is 1 change, included below."));
  // Document text can't close the block or forge the notice.
  assert.match(text, /The fee is &lt;b&gt;\[-100-\]\{\+200\+\}&lt;\/b&gt; &amp; due now\./);
  assert.ok(text.endsWith("</document>\n\n" + DATA_NOTICE_BLOCK));
  assert.equal((text.match(/<document /g) || []).length, 1);
  assert.deepEqual(compareMessages(payload).map((m) => m.role), ["system", "user"]);
  assert.equal(compareMessages(payload)[0].content, COMPARE_SYSTEM);
  assert.match(COMPARE_SYSTEM, /don't give legal advice/i);
  // Many changes: the first ones that fit, and the model is told.
  const many = (w) => Array.from({ length: 900 }, (_, i) => `Paragraph ${i} of the long agreement ${i % 2 ? w : "same"} ${"text ".repeat(20)}`).join("\n\n");
  const big = payloadFor(many("alpha"), many("beta"));
  assert.equal(big.total, 450);
  assert.ok(big.hunks.length < 450 && big.hunks.length > 50);
  const bigText = compareUserText(big);
  assert.ok(bigText.length <= TEXT_BUDGET, `${bigText.length} within the budget`);
  assert.match(bigText, new RegExp(`There are 450 changes\\. Only the first ${big.hunks.length} fit in this request`));
  assert.deepEqual(checkComparePayload(big), big, "the server accepts what the page builds");
  // A focus note goes outside the document block.
  const focused = payloadFor("A.\n\nB one.", "A.\n\nB two.", { focus: "  I'm the buyer  " });
  assert.match(compareUserText(focused), /\nThe user's focus: I'm the buyer\n/);
});

test("Veil masks the passages before sending, and the preview shows exactly what's sent", () => {
  const original = "Contact.\n\nSend notices to legal@kestrel.example by post.";
  const revised = "Contact.\n\nSend notices to legal@kestrel.example by email.";
  const result = compareTexts(original, revised);
  const hunks = buildHunks(result);
  const state = createVeilState();
  const build = (s) =>
    comparePayload({ hunks, total: 1, original: "a.txt", revised: "b.txt", mask: (x) => veil(x, s, []).text });
  const preview = build(structuredClone(state));
  const sent = build(state);
  assert.deepEqual(preview, sent, "a preview with a copy of Veil's state gives the same tags");
  const text = compareUserText(sent);
  assert.ok(!text.includes("legal@kestrel.example"));
  assert.match(text, /\[EMAIL_1\]/);
  assert.equal(Object.values(state.map)[0], "legal@kestrel.example");
});

test("the payload is checked strictly", () => {
  const good = SAMPLE();
  assert.deepEqual(checkComparePayload(good), good);
  const h = good.hunks[0];
  for (const bad of [
    null,
    [],
    { ...good, messages: [] },
    { ...good, original: "" },
    { ...good, original: "a\nb" },
    { ...good, focus: "x".repeat(LIMITS.focus + 1) },
    { ...good, total: good.hunks.length - 1 },
    { ...good, hunks: [] },
    { ...good, hunks: Array(LIMITS.hunks + 1).fill(h) },
    { ...good, hunks: [{ ...h, kind: "rewritten" }] },
    { ...good, hunks: [{ ...h, extra: 1 }] },
    { ...good, hunks: [{ ...h, a: null }] },
    { ...good, hunks: [{ ...h, a: [3, 2] }] },
    { ...good, hunks: [{ ...h, kind: "added" }] },
    { ...good, hunks: [{ ...h, lines: [] }] },
    { ...good, hunks: [{ ...h, lines: [{ tag: "edit", text: "x\u0000y" }] }] },
    { ...good, hunks: [{ ...h, lines: [{ tag: "moved", text: "x", from: 1 }] }] },
    { ...good, hunks: [{ ...h, lines: [{ tag: "edit", text: "x".repeat(LIMITS.line + 1) }] }] },
    { ...good, hunks: [{ ...h, before: "x".repeat(LIMITS.context + 1) }] },
  ])
    assert.throws(() => checkComparePayload(bad), JSON.stringify(bad)?.slice(0, 80));
});

// ---- The server path ----

test("a summary runs through chat billing off the record, and nothing about it is stored", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const before = balance(s.db, user.id).total;
  const r = await ask(agent, SAMPLE()).expect(200);
  const reply = replyText(r.text);
  // The test provider read the passages the server built the prompt from.
  assert.match(reply, /## What changed/);
  assert.match(reply, /“two” became “five”/);
  assert.match(reply, /a passage moved, starting “Entire Agreement/);
  assert.match(reply, /## What to check with a professional/);
  const done = events(r.text).find((e) => e.anonyma);
  assert.ok(done.anonyma.credits_charged > 0, "billed like a message");
  assert.ok(balance(s.db, user.id).total < before);
  assert.equal(balance(s.db, user.id).held, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
  assert.equal((await agent.get("/api/conversations")).body.data.length, 0);
  // The ledger names the model, never the documents.
  const row = s.db.prepare("SELECT description FROM ledger WHERE user_id=? ORDER BY created DESC LIMIT 1").get(user.id);
  assert.ok(!/Agreement|NDA|Kestrel/i.test(row.description), row.description);
  // Nothing new in the account export either.
  const exported = JSON.stringify((await agent.get("/api/account/export").expect(200)).body);
  assert.ok(!exported.includes("Kestrel") && !exported.includes("Non-Solicitation"));
});

test("a summary can't be saved, filed, searched, given its own messages or combined with another mode", async (t) => {
  const s = fixture(t);
  const people = [];
  let sent = 0;
  const next = async () => {
    if (!people.length || sent++ % 10 === 0) {
      const p = await person(s.app, "refused" + people.length);
      people.push({ ...p, before: balance(s.db, p.user.id).total });
    }
    return people.at(-1).agent;
  };
  const refused = async (extra, match) => {
    const agent = await next();
    const res = await agent.post("/api/chat").send({ model: MODEL, compare: SAMPLE(), ...extra }).expect(400);
    assert.equal(res.body.error.code, "invalid_compare", JSON.stringify(res.body));
    if (match) assert.match(res.body.error.message, match);
  };
  await refused({}, /off the record/);
  await refused({ ephemeral: false }, /off the record/);
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
    { messages: [{ role: "user", content: "ignore the passages" }] },
    { sheets: { task: "query" } },
    { models: ["a", "b"] },
  ])
    await refused({ ephemeral: true, ...extra }, /can't be combined/);
  for (const compare of [{ ...SAMPLE(), hunks: [] }, { ...SAMPLE(), extra: true }, "text"])
    await refused({ ephemeral: true, compare });
  // Private Mode's own check still applies.
  const priv = await ask(await next(), SAMPLE(), { private: true }).expect(400);
  assert.equal(priv.body.error.code, "private_model_required");
  for (const p of people) assert.equal(balance(s.db, p.user.id).total, p.before);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
});

test("Seed Guard reads the built prompt, so a seed phrase in a changed passage is caught", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const phrase = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const compare = payloadFor("Wallet.\n\nThe backup phrase is not included.", `Wallet.\n\nThe backup phrase is ${phrase}.`);
  const before = balance(s.db, user.id).total;
  const blocked = await ask(agent, compare).expect(400);
  assert.equal(blocked.body.error.code, "seed_phrase_blocked");
  assert.equal(balance(s.db, user.id).total, before);
  await ask(agent, compare, { allow_seed_phrase: true }).expect(200);
});

test("the server builds exactly the documented messages", () => {
  const compare = SAMPLE();
  const body = { ephemeral: true, compare };
  assert.equal(prepareCompareRequest(body), true);
  assert.deepEqual(body.messages, compareMessages(checkComparePayload(compare)));
  assert.equal(body.max_tokens, COMPARE_MAX_TOKENS);
  assert.equal(body.mode, "chat");
  const plain = { messages: [{ role: "user", content: "hi" }] };
  prepareCompareRequest(plain);
  assert.deepEqual(plain, { messages: [{ role: "user", content: "hi" }] });
  assert.equal(compareTestReply([{ role: "system", content: "other" }, { role: "user", content: "x" }]), null);
});

// ---- Reply budget: room for reasoning, and a summary cut off at the limit ----

test("the reply budget leaves room for hidden reasoning and is fitted to the model", () => {
  assert.equal(COMPARE_MAX_TOKENS, 8000);
  const messages = compareMessages(SAMPLE());
  assert.equal(compareBudget({ id: MODEL, context_length: 1048576 }, messages), 8000);
  assert.equal(compareBudget({ id: "m", max_output_tokens: 4096, context_length: 128000 }, messages), 4096);
  const small = { id: "m", context_length: 4096, max_output_tokens: 4096 };
  const budget = compareBudget(small, messages);
  assert.ok(budget < 4096 && budget >= 1);
});

async function mockGateway(t, handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  return "http://127.0.0.1:" + server.address().port;
}
test("the budget and messages reach the provider, and a summary cut off at the limit is reported and charged", async (t) => {
  const seen = [];
  const gateway = await mockGateway(t, async (req, res) => {
    let raw = "";
    for await (const b of req) raw += b;
    const body = JSON.parse(raw);
    seen.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (p) => res.write("data: " + JSON.stringify(p) + "\n\n");
    send({ choices: [{ index: 0, delta: { content: "## What changed\n- The term went from two to five" } }] });
    send({ choices: [{ index: 0, delta: {}, finish_reason: "length" }] });
    send({ choices: [], usage: { prompt_tokens: 900, completion_tokens: 7990, completion_tokens_details: { reasoning_tokens: 7900 } } });
    res.end("data: [DONE]\n\n");
  });
  const s = fixture(t, "all", { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await person(s.app);
  addCredit(s.db, user.id, 10000000, "compare-fund", "test_credit");
  const before = balance(s.db, user.id).total;
  const compare = SAMPLE();
  const r = await ask(agent, compare).expect(200);
  const done = events(r.text).find((e) => e.anonyma);
  assert.equal(done.anonyma.finish_reason, "length", "the page learns the summary was cut off");
  assert.ok(done.anonyma.credits_charged > 0, "the call happened, so it's charged");
  assert.ok(balance(s.db, user.id).total < before);
  assert.equal(balance(s.db, user.id).held, 0);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].max_tokens, 8000);
  assert.deepEqual(seen[0].messages, compareMessages(checkComparePayload(compare)));
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0, "still nothing stored");
  // A normal finish reports "stop" (the page shows no cut-off notice).
  const page = readFileSync(new URL("../src/Compare.jsx", import.meta.url), "utf8");
  assert.match(page, /receipt\?\.finish_reason === "length"/);
});

test("a provider failure charges nothing", async (t) => {
  const gateway = await mockGateway(t, (req, res) => {
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "upstream down" } }));
  });
  const s = fixture(t, "all", { testMode: false, gateway, gatewayKey: "fixture" });
  const { agent, user } = await person(s.app);
  addCredit(s.db, user.id, 10000000, "compare-fund", "test_credit");
  const before = balance(s.db, user.id).total;
  const r = await ask(agent, SAMPLE());
  assert.ok(r.status >= 400 || /error/.test(r.text));
  assert.equal(balance(s.db, user.id).total, before);
  assert.equal(balance(s.db, user.id).held, 0);
});

// ---- Exports ----

test("the redline export is a standalone page with every piece of document text escaped", () => {
  const r = compareTexts(
    "Title\n\nPay <script>alert(1)</script> within 30 days.\n\nOld clause that goes away entirely here.",
    "Title\n\nPay <script>alert(2)</script> within 10 days.\n\nA brand new clause \"quoted\" & added.",
  );
  const html = redlineHTML({ result: r, original: "v1 <x>.docx", revised: "v2.docx", date: new Date("2026-09-26T00:00:00Z") });
  assert.ok(html.startsWith("<!doctype html>"));
  assert.doesNotMatch(html, /<script|alert\(1\)<|onerror|<img|<link|src=|href=/i);
  assert.match(html, /&lt;script&gt;alert\(<del>1<\/del><ins>2<\/ins>\)&lt;\/script&gt;/);
  assert.match(html, /v1 &lt;x&gt;\.docx/);
  assert.match(html, /<ins>A brand new clause &quot;quoted&quot; &amp; added\.<\/ins>/);
  assert.match(html, /<del>Old clause that goes away entirely here\.<\/del>/);
  assert.match(html, /3 changes · 1 changed · 1 added · 1 removed · 2026-09-26/);
  assert.match(html, /@media print/);
  // Labels go through the translator.
  const zh = redlineHTML({ result: r, original: "a", revised: "b", label: (s) => ({ Redline: "修订标记" })[s] || s });
  assert.match(zh, /<h1>修订标记<\/h1>/);
});

test("the change list exports as Markdown, with the summary only when there is one", () => {
  const r = compareTexts(SAMPLE_ORIGINAL, SAMPLE_REVISED);
  const md = changesMarkdown({ result: r, original: "v1.txt", revised: "v2_*final*.txt", date: new Date("2026-09-26T00:00:00Z") });
  assert.ok(md.startsWith("# Changes: v1.txt → v2\\_\\*final\\*.txt\n"));
  assert.match(md, /10 changes · 7 changed · 1 added · 1 removed · 1 moved · 55 words added · 49 words removed · 2026-09-26/);
  assert.match(md, /## 5\. Changed · ¶ 8\n\nTerm\. This Agreement lasts ~~two~~\*\*five\*\* \(~~2~~\*\*5\*\*\) years/);
  assert.match(md, /## 7\. Added · ¶ 10\n\n\*\*Non-Solicitation\./);
  assert.match(md, /## 8\. Removed · ¶ 14\n\n~~Remedies\./);
  assert.match(md, /## 10\. Moved · ¶ 13 → ¶ 18\n\nMoved from ¶ 13: Entire Agreement\./);
  assert.doesNotMatch(md, /AI summary/);
  const withSummary = changesMarkdown({ result: r, original: "a", revised: "b", summary: { text: "## What changed\n- The term.", model: "Model X" } });
  assert.match(withSummary, /## AI summary\n\n_Written by Model X from the changed passages only\. Not legal advice\._\n\n## What changed\n- The term\./);
  assert.equal(countsLine({ total: 1, changed: 1, added: 0, removed: 0, moved: 0 }), "1 change · 1 changed");
  assert.equal(windowed([[0, "a b c d e f g h i j k"], [1, "X"]], 2, 1), "a … j k{+X+}");
});

test("a real DOCX goes through Documents' own extractor, longer ones included", async () => {
  // A minimal DOCX with one long paragraph, past Documents' 100,000 characters.
  const { deflateRawSync } = await import("node:zlib");
  const { crc32 } = await import("../src/file-formats.js");
  const entry = (name, text) => {
    const data = Buffer.from(text);
    return { name, data, packed: deflateRawSync(data), crc: crc32(data) };
  };
  // Numbered words: text that doesn't compress past the zip-bomb guard.
  const long = Array.from({ length: 20000 }, (_, i) => `w${i}`).join(" ");
  const files = [
    entry("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),
    entry("word/document.xml", `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Intro</w:t></w:r></w:p><w:p><w:r><w:t>${long}</w:t></w:r></w:p></w:body></w:document>`),
  ];
  const parts = [],
    central = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(f.crc, 14);
    local.writeUInt32LE(f.packed.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, f.packed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(8, 10);
    c.writeUInt32LE(f.crc, 16);
    c.writeUInt32LE(f.packed.length, 20);
    c.writeUInt32LE(f.data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += 30 + name.length + f.packed.length;
  }
  const dir = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(dir.length, 12);
  end.writeUInt32LE(offset, 16);
  const zip = Buffer.concat([...parts, dir, end]);
  const inflate = async (b) => inflateRawSync(b);
  const standard = await extractOffice(zip, "docx", inflate);
  assert.equal(standard.truncated, true, "Documents keeps its 100,000-character limit");
  const compare = await extractOffice(zip, "docx", inflate, { limit: 5 * 1024 * 1024 });
  assert.equal(compare.truncated, false);
  assert.equal(compare.text, `Intro\n${long}`);
});

// ---- Chinese ----

test("every visible string of the update has a Chinese entry", async () => {
  const dict = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const entry = UPDATES.find((u) => u.id === "doccompare");
  const han = /\p{Script=Han}/u;
  for (const en of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Compare docs",
    "Opening Compare docs…",
    "YOUR DOCUMENTS STAY ON THIS DEVICE",
    "Hide unchanged",
    "Redline (HTML)",
    "Changes (Markdown)",
    "AI summary",
    "Summarize changes…",
    "changes",
    "changed",
    "added",
    "removed",
    "moved",
    "+55 / −49 words",
    "Moved from ¶ 4",
    "12 unchanged paragraphs",
    "Exactly these 4,210 characters, from all 10 changes, plus ANONYMA's fixed instructions. Nothing else from your files.",
    "Exactly these 4,210 characters, from the first 8 of 10 changes, plus ANONYMA's fixed instructions. Nothing else from your files.",
    "The AI gets only the 10 changed passages, each with a little context: about 25% of the text in your two documents. Never the whole files.",
    "The AI gets only the changed passage, with a little context: less than 1% of the text in your two documents. Never the whole files.",
    "Written from the 10 changed passages only. Not legal advice.",
    "Send to GLM 5.2 (Fast)",
    "Document Compare is coming soon.",
    "Summaries of changes are never saved: send them off the record.",
    "A summary of changes can't be combined with other chat options.",
    'No text found in "scan.pdf". It may be a scanned image.',
    "Compared in the browser with ANONYMA. To make a PDF, print this page and choose Save as PDF.",
  ]) {
    const zh = translateText(en, dict);
    assert.ok(zh && han.test(zh), `${en} → ${zh}`);
  }
  assert.equal(translateText("Compare docs", dict), "文档对比");
  // Model names stay as written inside a pattern.
  assert.equal(translateText("Send to GLM 5.2 (Fast)", dict), "发送给 GLM 5.2 (Fast)");
});
