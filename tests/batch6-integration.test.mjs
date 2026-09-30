import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import { comparePayload } from "../src/compare-spec.js";
import { buildHunks, compareTexts } from "../src/doc-compare.js";
import { SAMPLE_ORIGINAL, SAMPLE_REVISED } from "../src/compare-sample.js";

// Batch 6 integration: the ten updates merged together (release/batch6).
// Each update has its own tests; these cover where they meet: the requests
// /api/chat builds itself (Study, Document Compare, Summarize & Continue and
// Sheets) never combine; Highlight & Ask's quote and Prompt Sharpen share the
// composer; replies' tables scroll in their own box; the header and the
// sidebar make room for the new tools and places.

// Release commits flip `released` on UPDATES entries. These tests pin every
// update to unreleased for this file and keep passing after the release.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const BATCH6 = ["status", "ocr", "sharpen", "ondevice", "study", "doccompare", "pagewatch", "audiooverview", "highlight", "catchup"];
const MODEL = "google/gemini-2.5-flash";
function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-batch6-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(app, username = "noor_haddad") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "correct-horse-battery" })
    .expect(201);
  return { agent, user: r.body.user };
}
const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

const NOTES = [
  "Photosynthesis turns light energy into chemical energy stored in glucose.",
  "Chlorophyll absorbs mostly blue and red light and reflects green light.",
  "The light reactions split water and release oxygen as a by-product.",
  "The Calvin cycle uses carbon dioxide to build sugars.",
].join(" ");
const STUDY = { make: "both", count: 10, level: "medium", source: { kind: "text", name: "Biology notes", text: NOTES } };
const COMPARE = (() => {
  const r = compareTexts(SAMPLE_ORIGINAL, SAMPLE_REVISED);
  return comparePayload({ hunks: buildHunks(r), total: r.changes.length, original: "v1.txt", revised: "v2.txt" });
})();
const CATCHUP = {
  transcript: Array.from({ length: 8 }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    text: i % 2 ? `Reply ${i}: here is some detail.` : `Question ${i}?`,
  })),
};

test("the ten updates are registered unreleased, and each works alone", async (t) => {
  for (const id of BATCH6) {
    const u = UPDATES.find((x) => x.id === id);
    assert.ok(u, id);
    assert.equal(typeof committed[UPDATES.indexOf(u)], "boolean", id);
    assert.equal(u.points.length, 3, id);
  }
  const s = fixture(t);
  const a = await person(s.app);
  for (const [name, extra] of [
    ["study", { study: STUDY }],
    ["compare", { compare: COMPARE }],
    ["catchup", { catchup: CATCHUP }],
  ]) {
    const r = await a.agent.post("/api/chat").send({ model: MODEL, ephemeral: true, ...extra });
    assert.equal(r.status, 200, name + ": " + r.text.slice(0, 200));
  }
});

test("Study, Document Compare, Summarize & Continue and Sheets never combine in one request", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const start = balance(s.db, a.user.id).total;
  const parts = { study: STUDY, compare: COMPARE, catchup: CATCHUP, sheets: { task: "query" } };
  const names = Object.keys(parts);
  for (let i = 0; i < names.length; i++)
    for (let j = i + 1; j < names.length; j++) {
      const body = { model: MODEL, ephemeral: true, [names[i]]: parts[names[i]], [names[j]]: parts[names[j]] };
      const r = await a.agent.post("/api/chat").send(body);
      assert.equal(r.status, 400, `${names[i]} + ${names[j]}: ${r.text.slice(0, 200)}`);
      assert.match(r.body.error.code, /^invalid_(study|compare|catchup|sheets)$/, `${names[i]} + ${names[j]}`);
    }
  // Their estimates too.
  const q = await a.agent.post("/api/quote").send({ model: MODEL, ephemeral: true, study: STUDY, catchup: CATCHUP });
  assert.equal(q.status, 400, q.text.slice(0, 200));
  assert.equal(balance(s.db, a.user.id).total, start, "nothing charged");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds WHERE user_id=?").get(a.user.id).n, 0, "nothing held");
});

test("a quote from Highlight & Ask closes an open Prompt Sharpen result, so neither drops the other", () => {
  const ws = source("Workspace.jsx");
  assert.match(
    ws,
    /function quoteIntoComposer\(text, \{ clipped \} = \{\}\) \{\n\s+if \(!text\) return;\n(\s+\/\/[^\n]*\n)+\s+if \(sharpen\.state\.status !== "idle"\) sharpen\.reset\(\);\n\s+setPrompt\(\(p\) => insertIntoPrompt\(p, text\)/,
  );
  // Sharpen reads the composer as it is (quote included) and never files:
  // Local OCR's "Use text" swaps an image for a document, which Sharpen
  // doesn't send.
  assert.match(ws, /const sendText = mentioned \? mention\[2\]\.trim\(\) : prompt\.trim\(\);/);
  assert.match(ws, /text: again \? sharpen\.state\.original : sendText,/);
});

test("reply tables scroll inside their own box on a phone", () => {
  const rich = source("RichMarkdown.jsx");
  assert.match(rich, /function ReplyTable\(\{ node: _node, \.\.\.props \}\) \{\n\s+return \(\n\s+<div className="table-scroll reply-table-scroll">\n\s+<table \{\.\.\.props\} \/>/);
  // Both renderings, and a caller's own table component still wins.
  assert.match(rich, /components=\{\{ \.\.\.TABLE_PARTS, \.\.\.components \}\}/);
  assert.match(rich, /components=\{\{ \.\.\.TABLE_PARTS, \.\.\.components, \.\.\.RICH_PARTS \}\}/);
  assert.match(readFileSync(new URL("../src/styles.css", import.meta.url), "utf8"), /\.table-scroll \{\n\s+overflow-x: auto;\n\s+max-width: 100%;/);
});

test("the header's chat tools compact to icons when crowded, and the sidebar fits its places", () => {
  const ws = source("Workspace.jsx");
  assert.match(ws, /const headerTools = \[!!find\.button, catchupOn, shareShown, studyShown, slidesShown, exportShown, listenShown\]\.filter\(Boolean\)\.length;/);
  assert.match(ws, /"workspace-header" \+ \(headerTools >= 5 \? " tools-5" : ""\) \+ \(headerTools >= 4 \? " tools-4" : ""\)/);
  const css = source("workspace.css");
  assert.match(css, /@media\(max-width:1680px\)\{\.app-shell \.workspace-header\.tools-5 :is\(\.find-open,\.catchup-open,\.share-open-button,\.chat-export-open\)\{padding:8px\}/);
  assert.match(css, /@media\(max-width:480px\)\{\.app-shell \.workspace-header\.tools-4>span\{display:none\}/);
  assert.match(css, /\.app-sidebar nav:has\(>a:nth-child\(15\)\) a\{min-height:38px;padding-block:5px\}/);
  // The directory retains the navigation order, with optional descriptions.
  // Primary destinations remain up front; other entries live in More tools.
  assert.match(ws, /const primaryModes = \["chat", "image", "video"\];/);
  assert.match(ws, /navigation\.filter\(\(\[id\]\) => primaryModes\.includes\(id\)\)\.map\(toolLink\)/);
  assert.match(ws, /navigation\.filter\(\(\[id\]\) => !primaryModes\.includes\(id\)\)/);
  const order = [...ws.matchAll(/^\s+\["(\w+)", "[^"]+"(?:, "[^"]+")?\],$/gm)].map((m) => m[1]);
  const nav = order.slice(order.indexOf("home"), order.indexOf("library") + 1);
  assert.deepEqual(nav, ["home", "chat", "uncensored", "symposium", "debate", "device", "code", "screenshot", "image", "video", "audio", "collab", "tools", "sheets", "compare", "canvas", "translate", "study", "slides", "repos", "contracts", "notes", "subtitles", "import", "photos", "filesearch", "pdfredact", "routines", "projects", "characters", "library"]);
  const palette = source("command-palette.js");
  const at = (id) => palette.indexOf(`["${id}", `);
  assert.ok(at("symposium") < at("device") && at("device") < at("code"));
  assert.ok(at("sheets") < at("compare") && at("compare") < at("study") && at("study") < at("slides"));
});

test("every string the integration added has Chinese", async () => {
  const { compileDictionary, translateText } = await import("../src/i18n.js");
  const zh = compileDictionary(JSON.parse(source("i18n/zh.json")));
  for (const text of ["Share this chat", "Make a study deck from this chat", "Export this chat"])
    assert.match(translateText(text, zh) ?? "", /\p{Script=Han}/u, text);
});
