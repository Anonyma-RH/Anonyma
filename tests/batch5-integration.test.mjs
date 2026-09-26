import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { UPDATES } from "../server/releases.js";

// Batch 5 integration: the ten updates merged together (release/batch5).
// Each update has its own tests; these cover where they meet: Blind Compare,
// Deep research and Sheets never combine; replies render with Math &
// Diagrams and Injection Shield wherever they're shown; Link Reader's pages
// go through Shield like any attached document.

// Release commits flip `released` on UPDATES entries. These tests pin every
// update to unreleased for this file and keep passing after the release.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const PASSWORD = "correct-horse-battery";
function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-batch5-"));
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
async function person(app, username = "maya_lee") {
  const agent = request.agent(app);
  await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: PASSWORD })
    .expect(201);
  return agent;
}
const source = (file) => readFileSync(new URL(`../src/${file}`, import.meta.url), "utf8");

test("the server refuses Blind, Deep research and Sheets combined", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const ask = [{ role: "user", content: "Which is faster?" }];
  for (const extra of [{ sheets: { task: "query" } }, { depth: "quick" }, { question: "Which is faster?" }]) {
    const r = await a
      .post("/api/blind")
      .send({ models: ["test/one", "test/two"], messages: ask, ...extra })
      .expect(400);
    assert.equal(r.body.error.code, "blind_unsupported", JSON.stringify(extra));
    assert.equal(r.body.error.message, "Blind can't be combined with Deep research or Sheets.");
  }
  for (const path of ["/api/research", "/api/research/quote"])
    for (const extra of [{ models: ["test/one", "test/two"] }, { sheets: { task: "query" } }]) {
      const r = await a
        .post(path)
        .send({ question: "Which is faster?", depth: "quick", model: "test/one", ...extra })
        .expect(400);
      assert.equal(r.body.error.code, "invalid_request", path);
      assert.equal(r.body.error.message, "Deep research can't be combined with Blind or Sheets.");
    }
  for (const extra of [{ models: ["test/one", "test/two"] }, { depth: "quick" }, { question: "Which is faster?" }]) {
    const r = await a
      .post("/api/chat")
      .send({ model: "test/one", ephemeral: true, sheets: { task: "query" }, ...extra })
      .expect(400);
    assert.equal(r.body.error.code, "invalid_sheets", JSON.stringify(extra));
    assert.equal(r.body.error.message, "A sheets question can't be combined with other chat options.");
  }
});

test("the composer turns Blind and Deep research off for each other", () => {
  const ws = source("Workspace.jsx");
  // Deep research is never on together with Blind.
  assert.match(ws, /const researchOn = researchAvailable && !!researchDepth && !sealedOn && !blindActive;/);
  // Turning Blind on turns Web and Deep research off.
  assert.match(ws, /function toggleBlind\(\) \{\n    if \(blindOn\) return setBlindOn\(false\);\n    setBlindOn\(true\);\n    setWebSearch\(false\);\n[^\n]*\n    setResearchDepth\(null\);/);
  assert.match(ws, /function keepComparing\(reveal\) \{\n    setBlindOn\(true\);\n    setWebSearch\(false\);\n    setResearchDepth\(null\);/);
  // Turning Deep research on turns Web and Blind off.
  assert.match(ws, /if \(!researchDepth\) \{\n\s+setWebSearch\(false\);\n[^\n]*\n\s+setBlindOn\(false\);\n\s+\}\n\s+setResearchDepth\(\(d\) => \(d \? null : "quick"\)\);/);
  // Send goes to one of them, never both, and Onchain's chip waits for both
  // to be off (their requests carry no chain facts).
  assert.match(ws, /if \(blindActive && !redo\) return sendBlind\(allowSeedPhrase\);\n\s+\/\/[^\n]*\n\s+if \(researchOn && !redo\) return sendResearch\(\);/);
  assert.match(ws, /const onchainLive =[\s\S]{0,300}!blindActive && !researchOn;/);
  // One estimate at a time, and Cost Compare only for a plain chat.
  assert.match(ws, /\{blindActive \? \(\s*<BlindEstimate[^]*?\) : researchOn \? \(\s*<ResearchEstimate[^]*?\)\}\s*\{costCompareLive && !blindActive && !researchOn && \(/);
  // Sheets is its own workspace page, not a composer toggle.
  assert.match(ws, /\) : mode === "sheets" \? \(\n\s+isReleased\(config, "sheets"\) &&/);
});

test("replies render with Math & Diagrams and Injection Shield wherever they're shown", () => {
  const ws = source("Workspace.jsx");
  // Blind Compare's A and B panes use the workspace's reply renderer and
  // Shield's image and link guards.
  assert.match(ws, /<BlindTurn[\s\S]{0,900}Markdown=\{ReplyMarkdown\}\s+markdown=\{shieldView \? shieldMarkdown\(\) : undefined\}/);
  const blind = source("Blind.jsx");
  assert.match(blind, /Markdown = ReactMarkdown,\n\s+markdown,/);
  assert.match(blind, /<Markdown remarkPlugins=\{marks\} components=\{markdown\}>/);
  assert.doesNotMatch(blind, /<ReactMarkdown /);
  // Deep research reports and Onchain explanations are ordinary replies: the
  // one ReplyMarkdown body, with Shield's components when it's on.
  assert.match(ws, /\{m\.research\?\.live \? \(\s*<ResearchProgress research=\{m\.research\} \/>\s*\) : hasDocuments \? \(/);
  assert.match(ws, /<ReplyMarkdown[\s\S]{0,700}shieldView\s+\? shieldMarkdown\(/);
  // Everywhere else replies show, both apply.
  for (const [file, pattern] of [
    ["Symposium.jsx", /<ReplyMarkdown rich=\{!!col\.text\} remarkPlugins=\{\[remarkGfm, veilMarks\]\} components=\{shieldParts\}>/],
    ["HistoryLibrary.jsx", /<ReplyMarkdown rich=\{m\.role !== "user"\} remarkPlugins=\{\[remarkGfm\]\} components=\{shieldParts\}>/],
    ["Routines.jsx", /<ReplyMarkdown remarkPlugins=\{\[remarkGfm\]\} components=\{markdown\}>/],
    ["SharedChat.jsx", /<ReplyMarkdown[\s\S]{0,200}components=\{shield \? shieldedParts : markdownParts\}/],
    ["DoubleCheck.jsx", /<ReplyMarkdown[\s\S]{0,300}components=\{shield \? shieldMarkdown\(\) : undefined\}/],
    ["TaskTools.jsx", /<ReplyMarkdown[\s\S]{0,300}components=\{shieldParts\}/],
  ])
    assert.match(source(file), pattern, file);
  // Mermaid diagrams are drawn by RichMarkdown's own element, never an
  // <img>, so Shield's remote-image placeholder doesn't touch them.
  const rich = source("RichMarkdown.jsx");
  assert.match(rich, /components=\{\{ \.\.\.components, \.\.\.RICH_PARTS \}\}/);
  assert.match(rich, /"rich-diagram": DiagramBlock/);
});

test("Link Reader's pages go through Injection Shield like attached documents", () => {
  const docs = source("Documents.jsx");
  // The composer's link card carries Shield's chip; every document is scanned.
  assert.match(docs, /<LinkCard key=\{doc\.id\} doc=\{doc\} onRemove=\{remove\}>\s*\{shieldFor && \(\s*<ShieldChip/);
  assert.match(docs, /<DocumentChip key=\{doc\.id\} doc=\{doc\} onRemove=\{remove\} shield=\{shieldFor\} \/>/);
  const ws = source("Workspace.jsx");
  assert.match(ws, /if \(shieldOn\) for \(const d of documents\) scans\.set\(d\.id, scanDocument\(d\)\);/);
  // Sent as Shield sends them: cleaned, and "as data" when on.
  assert.match(ws, /documents: redo\s+\? \[\]\s+: chainFacts\s+\? \[chainFactsDocument\(chainFacts, \{ lang: getLanguage\(\) \}\), \.\.\.sentDocuments\]\s+: sentDocuments,\s+asData: !redo && documentsAsData,/);
  // Blind sends documents the same way.
  assert.match(ws, /documents: sentDocuments,\s+asData: documentsAsData,\s+instructions: sentInstructions,/);
  // A PDF read from a link gets Shield's hidden-text check too.
  assert.match(ws, /pdfHidden=\{shieldOn \? pdfHiddenText : null\}/);
  assert.match(source("LinkReader.jsx"), /pdfText\(bytes, false, pdfHidden\)/);
  // Seed Guard skips a read page but checks the rest as they'll be sent.
  assert.match(ws, /sentDocuments\.filter\(\(d\) => d\.source !== "link"\)\.map\(\(d\) => d\.text \|\| ""\)/);
});

test("every string the integration added has Chinese", async () => {
  const { compileDictionary, translateText } = await import("../src/i18n.js");
  const zh = compileDictionary(JSON.parse(source("i18n/zh.json")));
  for (const text of [
    "Blind can't be combined with Deep research or Sheets.",
    "Deep research can't be combined with Blind or Sheets.",
  ])
    assert.match(translateText(text, zh) ?? "", /\p{Script=Han}/u, text);
});
