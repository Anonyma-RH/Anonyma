import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance, credits } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { prepareSiteRequest, siteAcceptor, siteBudget, siteTestReply } from "../server/shot-to-site.js";
import { fencedPage } from "../server/routes/shot-to-site.js";
import { chatLimits } from "../data/chat-limits.js";
import { knownPage } from "../src/site-routes.js";
import { paletteActions } from "../src/command-palette.js";
import { modeReleased } from "../src/lib.js";
import { rankTools } from "../src/tool-search.js";
import { PREVIEW_SANDBOX, previewPages, projectFiles } from "../src/live-preview.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { DATA_NOTICE_BLOCK, unescapeDocumentText } from "../src/documents.js";
import {
  CHANGE_SYSTEM,
  MAX_INSTRUCTION_CHARS,
  MAX_NOTES_CHARS,
  MAX_PAGE_BLOCK,
  MAX_PAGE_CHARS,
  MAX_VERSIONS,
  SITE_BASE_TOKENS,
  SITE_CHANGE_CUT_SHORT,
  SITE_CUT_SHORT,
  SITE_PAGE_TOO_LONG_TO_CHANGE,
  SITE_SYSTEM,
  SITE_TOO_LONG,
  SITE_UNUSABLE,
  checkSitePayload,
  codeFences,
  externalRefs,
  pageBlock,
  pageTitle,
  readPage,
  renderable,
  siteMaxTokens,
  siteMessages,
  siteProblem,
  siteRefusedMessage,
  siteText,
  streamedPage,
  stripExternal,
} from "../src/site-spec.js";
import {
  addVersion,
  labelFor,
  labelText,
  makePayload,
  newVersion,
  pageFileName,
  pageSlug,
  pastedImage,
  seenText,
  sizeText,
  versionsFromConversation,
} from "../src/shot-to-site.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-shottosite-"));
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
async function person(app, username = "site_user") {
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

// A picture is only ever checked for its kind and length here, so a run of
// base64 stands in for it.
const picture = (chars = 3000, mime = "image/jpeg") => {
  const prefix = `data:${mime};base64,`;
  return prefix + "A".repeat(chars - prefix.length);
};
const MAKE = (extra = {}) => ({ task: "make", image: { url: picture() }, notes: "Halden Coffee: Small-batch coffee, roasted every week.", ...extra });
const ask = (agent, shottosite, extra = {}) => agent.post("/api/chat").send({ model: MODEL, ephemeral: true, shottosite, ...extra });
const quote = async (agent, shottosite, extra = {}) =>
  (await agent.post("/api/quote").send({ model: MODEL, shottosite, ...extra }).expect(200)).body;
const PAGE = [
  "<!doctype html>",
  '<html lang="en"><head><meta charset="utf-8"><title>Halden Coffee</title><style>:root{--accent:#0135df}body{font-family:system-ui}</style></head>',
  "<body><main><h1>Small-batch coffee</h1><p>Roasted every week & shipped fast.</p><a href=\"#\">Shop</a></main></body></html>",
].join("\n");
const CHANGE = (extra = {}) => ({ task: "change", page: { html: PAGE }, instruction: "Make the button green", ...extra });

// ---- The release gate ----

test("unreleased: making, estimating and saving pages are refused, and there's no page, place or link", async (t) => {
  const mvp = fixture(t, "mvp,ephemeral");
  const a = await person(mvp.app);
  const before = balance(mvp.db, a.user.id).total;
  for (const [method, path, body] of [
    ["post", "/api/chat", { model: MODEL, ephemeral: true, shottosite: MAKE() }],
    ["post", "/API/Chat", { model: MODEL, ephemeral: true, shottosite: MAKE() }],
    ["post", "/api/quote", { model: MODEL, shottosite: MAKE({ image: { mime: "image/jpeg", chars: 3000 } }) }],
    ["get", "/api/site-pages"],
    ["post", "/api/site-pages", { versions: [{ label: "x", html: PAGE }] }],
    ["get", "/API/Site-Pages"],
  ]) {
    const res = await a.agent[method](path).send(body).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased", `${method} ${path}`);
    assert.equal(res.body.error.message, "Screenshot to site is coming soon.");
  }
  await request(mvp.app).get("/api/site-pages").expect(403);
  await request(mvp.app).post("/api/chat").send({ ephemeral: true, shottosite: MAKE() }).expect(403);
  assert.equal(balance(mvp.db, a.user.id).total, before, "nothing charged");
  // Ordinary chats and quotes are untouched by the gate.
  await a.agent.post("/api/chat").send({ model: MODEL, ephemeral: true, messages: [{ role: "user", content: "hi" }] }).expect(200);
  await a.agent.post("/api/quote").send({ model: MODEL, messages: [{ role: "user", content: "hi" }] }).expect(200);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.shottosite, false);
  const entry = config.releases.updates.find((u) => u.id === "shottosite");
  assert.equal(entry.title, "Screenshot to site");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  assert.equal(typeof committed[UPDATES.findIndex((u) => u.id === "shottosite")], "boolean", "registered release flag");
  // The API docs say nothing about it, and the export has nothing of its own.
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(closed.paths).some((p) => p.includes("site-pages")));
  // The page itself: a 404 until release (served once the client is built).
  if (existsSync("dist/client/index.html")) {
    await request(mvp.app).get("/workspace/screenshot").expect(404);
    await request(fixture(t, "mvp,shottosite,preview,ephemeral").app).get("/workspace/screenshot").expect(200);
    // It shows its result in Live Preview, so it isn't served without it.
    await request(fixture(t, "mvp,shottosite,ephemeral").app).get("/workspace/screenshot").expect(404);
  }
  assert.equal(knownPage("/workspace/screenshot"), false);
  assert.equal(knownPage("/workspace/screenshot", { screenshot: true }), true);
  // The client: no mode, no palette place, no search result.
  const cfg = (features) => ({ releases: { features } });
  assert.equal(modeReleased(cfg({}), "screenshot"), false);
  assert.equal(modeReleased(cfg({ shottosite: true }), "screenshot"), false, "needs Live Preview");
  assert.equal(modeReleased(cfg({ shottosite: true, preview: true }), "screenshot"), false, "needs off the record");
  assert.equal(modeReleased(cfg({ shottosite: true, preview: true, ephemeral: true }), "screenshot"), true);
  const ids = (c) => paletteActions({ config: c, mode: "chat", signedIn: true }).map((x) => x.id);
  assert.ok(!ids(cfg({})).includes("go-screenshot"));
  assert.ok(ids(cfg({ shottosite: true, preview: true, ephemeral: true })).includes("go-screenshot"));
  // Released, the routes are documented.
  const open = (await request(fixture(t, "mvp,shottosite,preview,code,ephemeral").app).get("/api/openapi.json").expect(200)).body;
  for (const m of ["get", "post"]) assert.ok(open.paths["/api/site-pages"]?.[m], `${m} /api/site-pages`);
});

test("the gate is expressed in featuresFor: the page, Live Preview, and the off-the-record path a request always takes", () => {
  const needs = (body, path = "/api/chat", method = "POST") => featuresFor({ path, method, body });
  assert.deepEqual(needs({ shottosite: {}, ephemeral: true }).sort(), ["ephemeral", "preview", "shottosite"]);
  assert.deepEqual(needs({ shottosite: {}, ephemeral: true, private: true }).sort(), ["ephemeral", "ephemeral", "preview", "private", "shottosite"]);
  assert.deepEqual(needs({ shottosite: {}, ephemeral: true, veil_masked: 2 }).sort(), ["ephemeral", "preview", "shottosite", "trail"]);
  assert.deepEqual(needs({ shottosite: {} }, "/api/quote").sort(), ["preview", "shottosite"]);
  for (const method of ["GET", "POST"]) assert.deepEqual(needs({}, "/api/site-pages", method), ["shottosite", "preview", "code"]);
  assert.ok(!needs({ ephemeral: true, messages: [] }).includes("shottosite"));
  assert.ok(!needs({ shottosite: {} }, "/api/chat", "GET").includes("shottosite"));
  assert.ok(!needs({ shottosite: {} }, "/v1/chat/completions").includes("shottosite"));
  for (const path of ["/api/conversations", "/api/account/export", "/api/site"]) assert.ok(!needs({}, path, "GET").includes("shottosite"), path);
});

test("the workspace keeps the page out of sight until it's released, and it never builds a sandbox of its own", () => {
  const src = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(src, /\.filter\(\(\[id\]\) => id !== "screenshot" \|\| modeReleased\(config, "screenshot"\)\)/);
  assert.match(src, /mode === "screenshot" && \(!config \|\| modeReleased\(config, "screenshot"\)\)/);
  assert.match(src, /mode === "screenshot" \? \(\s*modeReleased\(config, "screenshot"\) &&/);
  assert.match(src, /const ShotToSite = lazy\(\(\) => import\("\.\/ShotToSite\.jsx"\)\)/);
  // A tool-directory entry (More tools), not a top-level row beside Chat.
  assert.match(src, /\["screenshot", "Screenshot to site", "Drop a screenshot, sketch or wireframe/);
  assert.doesNotMatch(src, /primaryModes = \[[^\]]*screenshot/);
  // The server copies the shared module it imports.
  assert.match(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"), /src\/site-spec\.js/);
  // The page shows its result in Live Preview's own component, whose frame is
  // sandboxed with allow-scripts only; it has no iframe, no sandbox token and
  // no way in for HTML of its own.
  const page = readFileSync(new URL("../src/ShotToSite.jsx", import.meta.url), "utf8");
  assert.match(page, /import \{ LivePreview \} from "\.\/LivePreview\.jsx"/);
  assert.match(page, /<LivePreview files=\{files\} \/>/);
  const frame = readFileSync(new URL("../src/LivePreview.jsx", import.meta.url), "utf8");
  assert.match(frame, /sandbox=\{PREVIEW_SANDBOX\}/);
  assert.equal(PREVIEW_SANDBOX, "allow-scripts");
  for (const file of ["../src/ShotToSite.jsx", "../src/shot-to-site.js", "../src/site-spec.js", "../server/shot-to-site.js", "../server/routes/shot-to-site.js"]) {
    const code = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(code, /dangerouslySetInnerHTML|\binnerHTML\b|\beval\(|new Function/, file);
  }
  for (const file of ["../src/ShotToSite.jsx", "../src/shot-to-site.js"]) {
    const code = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(code, /<iframe|allow-same-origin|\bsandbox=/, file);
  }
  // The page is in the address, so a reload opens it.
  assert.match(page, /params\.get\("page"\)/);
  assert.match(page, /patch\(\{ page: r\.id \}\)/);
  // Open in Code & build goes to the saved conversation.
  assert.match(page, /navigate\("\/workspace\/code\?c=" \+ encodeURIComponent\(id\)\)/);
});

// ---- Making a page: billing, holding back, charging only what's usable ----

test("a page is made off the record, held at exactly the quoted maximum, and sent only once it reads as a page", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const before = balance(s.db, user.id).total;
  // The estimate carries only the picture's kind and length, never the picture.
  const q = await quote(agent, { task: "make", image: { mime: "image/jpeg", chars: 3000 }, notes: MAKE().notes });
  assert.ok(q.credits > 0);
  assert.equal(q.budget.replyBudget, SITE_BASE_TOKENS);
  const r = await ask(agent, MAKE()).expect(200);
  const list = events(r.text);
  // Progress is a count only; the text arrives once, whole, at the end.
  const progress = list.filter((e) => e.shottosite);
  assert.ok(progress.length >= 1, "characters written while it's made");
  assert.deepEqual(Object.keys(progress[0].shottosite), ["chars"]);
  const content = list.filter((e) => typeof e.choices?.[0]?.delta?.content === "string");
  assert.equal(content.length, 1, "the reply is sent in one piece");
  assert.ok(list.indexOf(content[0]) > list.indexOf(progress.at(-1)));
  const done = list.find((e) => e.anonyma);
  assert.ok(done.anonyma.credits_charged > 0, "billed like a message");
  assert.equal(done.anonyma.finish_reason, "stop");
  // The hold was exactly the quote: no hold margin.
  const hold = s.db.prepare("SELECT * FROM holds WHERE user_id=?").get(user.id);
  assert.equal(credits(hold.amount), q.credits);
  assert.equal(hold.status, "settled");
  assert.ok(balance(s.db, user.id).total < before);
  // The browser reads the page with the same reader.
  const read = readPage(replyText(r.text), { finishReason: "stop" });
  assert.match(read.html, /^<!doctype html>/);
  assert.equal(read.title, "Halden Coffee");
  assert.match(read.html, /<h1>Small-batch coffee, roasted every week<\/h1>/, "the brand and headline from the notes");
  // Nothing saved: no conversation, no message, and not the picture.
  for (const table of ["conversations", "messages"]) assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0, table);
  // The ledger names the model, never the notes.
  const row = s.db.prepare("SELECT description FROM ledger WHERE user_id=? ORDER BY created DESC LIMIT 1").get(user.id);
  assert.ok(!/Halden|coffee|picture/i.test(row.description), row.description);
  // A normal chat holds its margin; a page doesn't.
  const plain = await agent.post("/api/quote").send({ model: MODEL, messages: [{ role: "user", content: "hello there" }] }).expect(200);
  await agent.post("/api/chat").send({ model: MODEL, ephemeral: true, messages: [{ role: "user", content: "hello there" }] }).expect(200);
  const chatHold = s.db.prepare("SELECT amount FROM holds WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 1").get(user.id);
  assert.ok(credits(chatHold.amount) > plain.body.credits, "an ordinary chat still holds headroom");
});

test("the estimate on a picture's kind and length equals the hold on the picture itself, and changes with its size", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const small = await quote(agent, { task: "make", image: { mime: "image/png", chars: 4000 } });
  const big = await quote(agent, { task: "make", image: { mime: "image/png", chars: 200000 } });
  assert.ok(big.credits > small.credits, "a bigger picture costs more, as any image in a chat does");
  for (const chars of [4000, 200000]) {
    const url = picture(chars, "image/png");
    const est = await quote(agent, { task: "make", image: { mime: "image/png", chars: url.length } });
    await ask(agent, { task: "make", image: { url } }).expect(200);
    const hold = s.db.prepare("SELECT * FROM holds WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 1").get(user.id);
    assert.equal(credits(hold.amount), est.credits, `${chars} characters`);
  }
  // With a change, the page is part of the price and the same rule holds.
  const change = CHANGE();
  const est = await quote(agent, change);
  await ask(agent, change).expect(200);
  const hold = s.db.prepare("SELECT * FROM holds WHERE user_id=? ORDER BY created DESC,rowid DESC LIMIT 1").get(user.id);
  assert.equal(credits(hold.amount), est.credits);
  // The estimate refuses a picture bigger than a request may carry.
  await agent.post("/api/quote").send({ model: MODEL, shottosite: { task: "make", image: { mime: "image/png", chars: 700000 } } }).expect(400);
  await agent.post("/api/quote").send({ model: MODEL, shottosite: { task: "make", image: { mime: "image/gif", chars: 4000 } } }).expect(400);
});

test("a reply that isn't a usable page charges nothing and is never sent: cut short, prose, a refusal, too long", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const start = balance(s.db, user.id).total;
  for (const [marker, code, message] of [
    ["[[site:length]]", "site_cut_short", SITE_CUT_SHORT],
    ["[[site:prose]]", "site_unreadable", SITE_UNUSABLE],
    ["[[site:refuse]]", "site_refused", siteRefusedMessage("The picture is blank, so there is nothing to build a page from.")],
    ["[[site:long]]", "site_too_long", SITE_TOO_LONG],
  ]) {
    const r = await ask(agent, MAKE({ notes: "A page " + marker })).expect(200);
    const list = events(r.text);
    const error = list.find((e) => e.error)?.error;
    assert.equal(error?.code, code, marker);
    assert.equal(error.message, message, marker);
    assert.equal(replyText(r.text), "", "none of the reply reached the browser");
    assert.equal(list.find((e) => e.error).anonyma, undefined, "no charge receipt");
  }
  assert.equal(balance(s.db, user.id).total, start, "nothing charged");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds WHERE status='held'").get().n, 0, "no hold left");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds WHERE status='settled'").get().n, 0);
  // The same reader decides for the browser.
  const p = checkSitePayload(MAKE());
  assert.equal(siteProblem(p, "<!doctype html><html><body><p>cut", "length").code, "site_cut_short");
  assert.equal(siteProblem(p, "no page here", "stop").code, "site_unreadable");
  assert.equal(siteProblem(p, "ERROR: Nothing here.", "stop").code, "site_refused");
  assert.equal(siteProblem(p, "<!doctype html><html><body><p>Hi</p></body></html>", "stop"), null);
  assert.equal(siteProblem(checkSitePayload(CHANGE()), "<html><body><p>cut", "length").message, SITE_CHANGE_CUT_SHORT);
  // The acceptor is what refuses (runChat then releases the hold).
  assert.throws(() => siteAcceptor(p)("just words", "stop"), /wasn't a web page/);
  assert.equal(siteAcceptor(p)(PAGE, "stop"), true);
});

test("other shapes are read: a fenced reply with prose around it, a fragment, JSON around the page, and outside links", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app);
  for (const marker of ["fenced", "fragment", "json", "external"]) {
    const r = await ask(agent, MAKE({ notes: `A page [[site:${marker}]]` })).expect(200);
    const read = readPage(replyText(r.text), { finishReason: "stop" });
    assert.ok(read.html, marker);
    assert.match(read.html, /^<!doctype html>/i, marker);
    assert.ok(events(r.text).find((e) => e.anonyma).anonyma.credits_charged > 0, `${marker} is charged`);
    if (marker === "fragment") assert.deepEqual(read.notes, ["wrapped"]);
    if (marker === "json") assert.deepEqual(read.notes, ["json"]);
    if (marker === "external") {
      const refs = externalRefs(read.html);
      assert.deepEqual(refs.map((x) => x.kind).sort(), ["link", "script"]);
      assert.doesNotMatch(stripExternal(read.html), /example\.invalid/);
    }
  }
});

test("readPage: strings, lists, {text} objects, fences, cut-short pages, refusals and limits", () => {
  const doc = "<!doctype html><html><head><title>A &amp; B</title></head><body><h1>Hi</h1></body></html>";
  // A plain string.
  assert.equal(readPage(doc).html, doc);
  assert.equal(readPage(doc).title, "A & B");
  // A fence with prose around it; the longest HTML block wins.
  const fenced = readPage("Here you go:\n```html\n" + doc + "\n```\nAnd a note:\n```js\nconsole.log(1)\n```\nEnjoy!");
  assert.equal(fenced.html, doc);
  assert.equal(readPage("```\n<p>x</p>\n```\n```html\n" + doc + "\n```").html, doc, "an html fence beats an unlabelled one");
  // Prose around a bare document.
  assert.equal(readPage("Sure thing.\n" + doc + "\nHope that helps!").html, doc);
  // Arrays of strings (joined), {text} objects and other keys, in a fence or not.
  assert.equal(readPage(JSON.stringify({ html: ["<!doctype html>", "<html><body><p>a</p></body></html>"] })).html, "<!doctype html>\n<html><body><p>a</p></body></html>");
  assert.match(readPage(JSON.stringify({ page: { text: doc } })).html, /<h1>Hi<\/h1>/);
  assert.match(readPage("```json\n" + JSON.stringify({ code: doc }) + "\n```").html, /<h1>Hi<\/h1>/);
  assert.match(readPage(JSON.stringify([doc])).html, /<h1>Hi<\/h1>/);
  // A cut-off page: closed when the model just stopped, refused when it ran out of room.
  const cut = "<!doctype html><html><body><p>Half a page";
  assert.deepEqual(readPage(cut, { finishReason: "length" }), { truncated: true });
  assert.deepEqual(readPage("```html\n" + cut, { finishReason: "length" }), { truncated: true });
  const closed = readPage(cut, { finishReason: "stop" });
  assert.deepEqual(closed.notes, ["closed"]);
  assert.match(closed.html, /<\/body>\n<\/html>$/);
  // A page cut short by the budget but already closed is complete.
  assert.ok(readPage(doc, { finishReason: "length" }).html);
  // A fragment is put in a document; nothing renderable is refused.
  assert.match(readPage("<div><h2>Just a block</h2></div>").html, /^<!doctype html>[\s\S]*<body>\n<div><h2>Just a block<\/h2><\/div>\n<\/body>/);
  assert.ok(readPage("<!doctype html><html><head><style>a{}</style></head><body></body></html>").problems);
  assert.ok(readPage("<!doctype html><html><body><img src=\"data:,\"></body></html>").html, "a picture is something");
  assert.ok(renderable("<p>x</p>") && !renderable("<script>x()</script><style>a{}</style>"));
  // A refusal, unreadable prose, and nothing at all.
  assert.deepEqual(readPage("ERROR:  The picture is blank. "), { refusal: "The picture is blank." });
  assert.deepEqual(readPage("Error - this isn't an interface"), { refusal: "this isn't an interface" });
  assert.ok(readPage("I can't help with that.").problems);
  assert.ok(readPage("").problems);
  assert.deepEqual(readPage("", { finishReason: "length" }), { truncated: true });
  // Too long to keep.
  assert.deepEqual(readPage("<!doctype html><html><body><!--" + "x".repeat(MAX_PAGE_CHARS) + "--><p>a</p></body></html>"), { tooLong: true });
  // Titles.
  assert.equal(pageTitle("<title> Halden   Coffee </title>"), "Halden Coffee");
  assert.equal(pageTitle("<h1>The <b>heading</b></h1>"), "The heading");
  assert.equal(pageTitle("<p>none</p>"), "Untitled page");
  assert.equal(pageTitle("<title>Page</title>"), "Untitled page");
  // Fences report whether they closed.
  assert.deepEqual(codeFences("```html x\nA\n```\n~~~\nB").map((f) => [f.info, f.body, f.closed]), [["html x", "A", true], ["", "B", false]]);
  assert.equal(streamedPage("abcd"), 4);
});

test("outside links are found and can be taken out locally", () => {
  const html = [
    "<!doctype html><html><head>",
    '<link rel="stylesheet" href="https://fonts.example.invalid/a.css">',
    '<link rel="icon" href="data:image/png;base64,AAAA">',
    '<link rel="stylesheet" href="local.css">',
    '<script src="//cdn.example.invalid/x.js"></script>',
    "<style>@import url('https://f.example.invalid/x.css'); .a{background:url(https://img.example.invalid/a.png)} .b{background:url(data:image/png;base64,AAAA)}</style>",
    '</head><body><img src="https://img.example.invalid/b.png" alt="b"><iframe src="https://frame.example.invalid"></iframe><a href="https://ok.example.invalid">a link is not a request</a></body></html>',
  ].join("\n");
  const refs = externalRefs(html);
  assert.deepEqual(
    refs.map((r) => r.kind),
    ["link", "script", "img", "iframe", "import", "css"],
  );
  assert.ok(!refs.some((r) => /ok\.example|data:|local\.css/.test(r.url)));
  const clean = stripExternal(html);
  assert.equal(externalRefs(clean).length, 0);
  assert.match(clean, /local\.css/, "a page's own files stay");
  assert.match(clean, /url\(data:image\/png;base64,AAAA\)/);
  assert.match(clean, /href="https:\/\/ok\.example\.invalid"/, "a plain link is not touched");
  assert.doesNotMatch(clean, /example\.invalid\/(a|b|x)/);
});

// ---- Changing a page ----

test("a change sends the current page as data beside the instruction, and edits that page", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  // The messages the server builds.
  const body = { model: MODEL, ephemeral: true, shottosite: CHANGE({ instruction: "Make the button  green\tplease" }) };
  const task = prepareSiteRequest(body);
  assert.equal(task.instruction, "Make the button green please", "spaces are tidied");
  const [system, message] = body.messages;
  assert.equal(system.content, CHANGE_SYSTEM);
  assert.equal(typeof message.content, "string", "no picture unless one was added");
  assert.match(message.content, /^Task: change the page below\.\nInstruction: Make the button green please\n\n<document name="Current page">/);
  assert.ok(message.content.endsWith(DATA_NOTICE_BLOCK), "the data notice comes last");
  // The page is escaped so it can't close the tag or pose as an instruction.
  const block = /<document name="Current page">([\s\S]*)<\/document>/.exec(message.content)[1];
  assert.ok(!/[<>]/.test(block));
  assert.equal(unescapeDocumentText(block), PAGE);
  assert.equal(body.max_tokens, SITE_BASE_TOKENS);
  assert.equal(body.mode, "chat");
  // A picture on a change rides beside the text.
  const withPicture = { model: MODEL, ephemeral: true, shottosite: CHANGE({ image: { url: picture(4000, "image/png") } }) };
  prepareSiteRequest(withPicture);
  assert.equal(withPicture.messages[1].content[0].type, "text");
  assert.match(withPicture.messages[1].content[0].text, /A picture is attached/);
  assert.equal(withPicture.messages[1].content[1].image_url.url.length, 4000);
  // Through the route: the page comes back changed, and only a usable one is charged.
  const r = await ask(agent, CHANGE({ instruction: "Make the button green and add free shipping" })).expect(200);
  const read = readPage(replyText(r.text), { finishReason: "stop" });
  assert.match(read.html, /--accent:#0a7f4f/);
  assert.match(read.html, /Changed: Make the button green and add free shipping/);
  assert.equal(read.title, "Halden Coffee");
  assert.ok(events(r.text).find((e) => e.anonyma).anonyma.credits_charged > 0);
  const start = balance(s.db, user.id).total;
  for (const [marker, code] of [["[[site:length]]", "site_cut_short"], ["[[site:refuse]]", "site_refused"], ["[[site:long]]", "site_too_long"]]) {
    const bad = await ask(agent, CHANGE({ instruction: "Change it " + marker })).expect(200);
    assert.equal(events(bad.text).find((e) => e.error)?.error.code, code, marker);
  }
  assert.equal(balance(s.db, user.id).total, start, "nothing charged for a change that gave nothing");
  // A page too long to send back is refused before anything is held.
  const huge = "<!doctype html><html><body>" + "<p>a &amp; b</p>".repeat(2000) + "</body></html>";
  assert.ok(huge.length < MAX_PAGE_CHARS && pageBlock(huge).length > MAX_PAGE_BLOCK);
  const refused = await agent.post("/api/chat").send({ model: MODEL, ephemeral: true, shottosite: CHANGE({ page: { html: huge } }) }).expect(400);
  assert.equal(refused.body.error.code, "invalid_shottosite");
  assert.equal(refused.body.error.message, SITE_PAGE_TOO_LONG_TO_CHANGE);
  assert.equal(balance(s.db, user.id).total, start);
});

test("the payload is checked strictly: pictures, words and fields", () => {
  const ok = (raw, opts) => checkSitePayload(raw, opts);
  const bad = (raw, message, opts) => assert.throws(() => checkSitePayload(raw, opts), message);
  assert.equal(ok(MAKE()).image.url.length, 3000);
  // Pictures: PNG, JPEG or WebP data URLs, nothing else, and not too large.
  bad({ task: "make" }, /Choose a picture first/);
  bad({ task: "make", image: { url: "https://example.invalid/a.png" } }, /PNG, JPEG or WebP/);
  bad({ task: "make", image: { url: "data:image/gif;base64,AAAA" } }, /PNG, JPEG or WebP/);
  bad({ task: "make", image: { url: "data:image/svg+xml;base64,AAAA" } }, /PNG, JPEG or WebP/);
  bad({ task: "make", image: { url: "data:image/png;base64,AA AA" } }, /PNG, JPEG or WebP/);
  bad({ task: "make", image: { url: picture(700000) } }, /too large/);
  bad({ task: "make", image: { url: picture(), extra: 1 } }, /unexpected field/);
  bad({ task: "make", image: "data:image/png;base64,AAAA" }, /malformed/);
  bad({ task: "make", image: { mime: "image/png", chars: 4000 } }, /unexpected field/, undefined);
  // An estimate's picture is its kind and length, and only that.
  assert.equal(ok({ task: "make", image: { mime: "image/webp", chars: 5000 } }, { quote: true }).image.url.length, 5000);
  bad({ task: "make", image: { url: picture() } }, /unexpected field/, { quote: true });
  bad({ task: "make", image: { mime: "image/png", chars: 10 } }, /too large/, { quote: true });
  bad({ task: "make", image: { mime: "image/png", chars: 4000.5 } }, /too large/, { quote: true });
  // Words: notes and instructions, trimmed and bounded.
  assert.equal(ok(MAKE({ notes: "  Use  my\tblue \n" })).notes, "Use my blue");
  assert.equal(ok(MAKE({ notes: undefined })).notes, "");
  bad(MAKE({ notes: "x".repeat(MAX_NOTES_CHARS + 1) }), /Keep the notes to 1,000 characters/);
  bad(MAKE({ notes: "bad\u0007bell" }), /notes to 1,000 characters/);
  bad(MAKE({ notes: 5 }), /notes must be text/);
  bad(CHANGE({ instruction: "ab" }), /Say what to change/);
  bad(CHANGE({ instruction: "x".repeat(MAX_INSTRUCTION_CHARS + 1) }), /instruction to 1,000 characters/);
  bad(CHANGE({ instruction: undefined }), /Say what to change/);
  // Changes need a page, of a size that can go back.
  bad({ task: "change", instruction: "Make it blue" }, /page to change is missing/);
  bad(CHANGE({ page: { html: "<p>" } }), /page to change is missing/);
  bad(CHANGE({ page: { html: "x".repeat(MAX_PAGE_CHARS + 1) } }), /too long to send back/);
  bad(CHANGE({ page: { html: PAGE, extra: 1 } }), /unexpected field/);
  // Tasks and fields.
  bad({ task: "burn" }, /make a page or change one/);
  bad(null, /malformed/);
  bad([], /malformed/);
  bad(MAKE({ model: "x" }), /unexpected field/);
  bad(Object.assign(Object.create({ task: "make" }), {}), /malformed/);
  // Messages are the same text the page shows under "What the AI sees".
  const p = ok(MAKE());
  const [sys, user] = siteMessages(p);
  assert.equal(sys.content, SITE_SYSTEM);
  assert.equal(user.content[0].text, siteText(p));
  assert.equal(user.content[1].image_url.url, p.image.url);
  assert.equal(seenText({ task: "make", image: { mime: "image/jpeg", chars: 3000 }, notes: "Halden" }), "Task: build one web page from the picture attached.\nNotes from the person: Halden");
  assert.match(seenText({ task: "change", page: { html: PAGE }, instruction: "Make it blue" }), /Instruction: Make it blue/);
  assert.equal(siteMaxTokens(p), 12000);
  assert.ok(siteMaxTokens(p) >= 8000, "parsed output gets at least 8,000 tokens of room");
});

test("the budget is fitted to the model, and refused when its context leaves too little room", () => {
  const p = checkSitePayload(MAKE());
  const messages = siteMessages(p);
  const roomy = { id: "x", context_length: 1000000, max_output_tokens: 65536 };
  assert.equal(siteBudget(p, roomy, messages), 12000);
  const capped = { id: "y", context_length: 1000000, max_output_tokens: 9000 };
  assert.equal(siteBudget(p, capped, messages), 9000, "clamped to the model's output cap");
  assert.ok(chatLimits(capped).maxOutputTokens >= 8000);
  // A model whose whole output cap is under 8,000 tokens is still allowed the cap.
  assert.equal(siteBudget(p, { id: "z", context_length: 1000000, max_output_tokens: 4096 }, messages), 4096);
  // Not enough context left for the reply: refused with nothing sent.
  assert.throws(() => siteBudget(p, { id: "w", context_length: 9000, max_output_tokens: 65536 }, messages), (e) => e.code === "site_too_long" && e.status === 400);
});

// ---- What a request may be combined with ----

test("a page request refuses ready-made messages, other tasks, Auto, memory, web, projects and Seed Guard's override", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const start = balance(s.db, user.id).total;
  const conv = (await agent.post("/api/conversations").send({ title: "x" }).expect(201)).body.id;
  for (const extra of [
    { messages: [{ role: "user", content: "hi" }] },
    { auto: true },
    { memory: true },
    { web_search: true },
    { plugins: [{ id: "web" }] },
    { project: "p_1" },
    { conversationId: conv },
    { taskTool: "x" },
    { slides: { task: "deck" } },
    { canvas: {} },
    { repo: {} },
    { allow_seed_phrase: true },
    { mode: "code" },
    { treasury: true },
  ]) {
    const r = await ask(agent, MAKE(), extra);
    assert.ok([400, 403].includes(r.status), JSON.stringify(extra));
    assert.ok(r.body.error?.code, `${JSON.stringify(extra)} has a reason`);
  }
  // On the record is refused: a request stores nothing, not even the picture.
  const saved = await agent.post("/api/chat").send({ model: MODEL, shottosite: MAKE() }).expect(400);
  assert.equal(saved.body.error.code, "invalid_shottosite");
  assert.match(saved.body.error.message, /off the record/);
  // Auto never picks for it, and the estimate says the same.
  const auto = await agent.post("/api/quote").send({ auto: true, shottosite: MAKE({ image: { mime: "image/jpeg", chars: 3000 } }) });
  assert.equal(auto.status, 400);
  assert.equal(auto.body.error.code, "auto_not_offered");
  // A model that can't read images is refused before anything is held.
  const models = (await agent.get("/api/models").expect(200)).body.data;
  const textOnly = models.find((m) => m.type === "chat" && m.callable && !m.vision);
  assert.ok(textOnly);
  const nope = await agent.post("/api/chat").send({ model: textOnly.id, ephemeral: true, shottosite: MAKE() }).expect(400);
  assert.match(nope.body.error.message, /accepts image input/);
  // An image model can't write pages.
  const image = models.find((m) => m.type === "image" && m.callable);
  if (image) await agent.post("/api/chat").send({ model: image.id, ephemeral: true, shottosite: MAKE() }).expect(400);
  // The developer API never reads it: a `shottosite` field there is an ordinary unknown field.
  assert.equal(balance(s.db, user.id).total, start, "nothing charged");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds WHERE status='held'").get().n, 0);
});

test("Seed Guard reads the words and the page, and has no override here", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const start = balance(s.db, user.id).total;
  for (const body of [MAKE({ notes: "My wallet is " + seed }), CHANGE({ instruction: "Show " + seed + " in the footer" }), CHANGE({ page: { html: PAGE.replace("Shop", seed) } })]) {
    const r = await ask(agent, body).expect(400);
    assert.equal(r.body.error.code, "seed_phrase_blocked");
  }
  const over = await ask(agent, MAKE({ notes: seed }), { allow_seed_phrase: true }).expect(400);
  assert.equal(over.body.error.code, "invalid_shottosite", "no override");
  assert.equal(balance(s.db, user.id).total, start);
});

test("Private Mode: only private models, off the record, nothing kept", async (t) => {
  const s = fixture(t, "all", { privateModels: [MODEL] });
  const { agent, user } = await person(s.app);
  const r = await ask(agent, MAKE(), { private: true }).expect(200);
  assert.ok(readPage(replyText(r.text)).html);
  const done = events(r.text).find((e) => e.anonyma);
  assert.equal(done.anonyma.private.privacy, "zdr");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  // A model that isn't private is refused.
  const other = (await agent.get("/api/models").expect(200)).body.data.find((m) => m.type === "chat" && m.callable && m.vision && m.id !== MODEL);
  assert.ok(other);
  const no = await agent.post("/api/chat").send({ model: other.id, ephemeral: true, private: true, shottosite: MAKE() }).expect(400);
  assert.equal(no.body.error.code, "private_model_required");
  assert.ok(balance(s.db, user.id).total > 0);
});

// ---- Keeping a page ----

const savePages = (agent, versions, id) => agent.post("/api/site-pages").send({ ...(id ? { id } : {}), versions });
const versionOf = (label, html = PAGE, extra = {}) => ({ label, html, ...extra });

test("a saved page is an ordinary conversation in Code & Build's mode, one message pair per version, opening there with its file", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app);
  // Make a page, then save it: the cost is read from the account's own hold.
  const ran = await agent.post("/api/chat").send({ model: MODEL, ephemeral: true, requestId: "req-site-1", shottosite: MAKE() }).expect(200);
  const html = readPage(replyText(ran.text)).html;
  const charged = events(ran.text).find((e) => e.anonyma).anonyma.credits_charged;
  const first = await savePages(agent, [versionOf("From a picture: Halden Coffee", html, { request_id: "req-site-1" })]).expect(201);
  assert.equal(first.body.saved, 1);
  assert.equal(first.body.title, "Halden Coffee");
  const id = first.body.id;
  const conv = (await agent.get("/api/conversations/" + id).expect(200)).body;
  assert.equal(conv.mode, "code");
  assert.deepEqual(conv.messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(conv.messages[0].content, "From a picture: Halden Coffee");
  assert.equal(conv.messages[1].credits, charged, "what the request cost, from the hold");
  assert.equal(conv.messages[1].model, MODEL);
  assert.equal(conv.messages[1].content.site.n, 1);
  // Code & Build reads the message as index.html, with the page as it is.
  const text = conv.messages[1].content.text;
  const files = projectFiles([{ role: "assistant", content: text }]);
  assert.deepEqual(files.map((f) => f.path), ["index.html"]);
  assert.equal(files[0].content.trim(), html.trim());
  assert.deepEqual(previewPages(files), ["index.html"]);
  // A change is added to the same page, as a second version.
  const second = await savePages(agent, [versionOf("Change: make it blue", PAGE.replace("Small-batch", "Freshly roasted"))], id).expect(200);
  assert.equal(second.body.id, id);
  const list = (await agent.get("/api/site-pages").expect(200)).body;
  assert.deepEqual(list.data.map((p) => [p.id, p.versions]), [[id, 2]]);
  assert.equal(list.max_versions, MAX_VERSIONS);
  // It reads back as versions, oldest first, with what asked for each.
  const versions = versionsFromConversation((await agent.get("/api/conversations/" + id).expect(200)).body);
  assert.deepEqual(versions.map((v) => v.label), ["From a picture: Halden Coffee", "Change: make it blue"]);
  assert.match(versions[1].html, /Freshly roasted/);
  assert.equal(versions[0].credits, charged);
  assert.ok(versions.every((v) => v.saved));
  // It's in the ordinary conversation list, and a fence longer than any run of backticks holds pages that contain fences.
  assert.ok((await agent.get("/api/conversations").expect(200)).body.data.some((c) => c.id === id));
  const tricky = PAGE.replace("Shop", "```` and ``` inside");
  assert.match(fencedPage(tricky), /^`{5}html index\.html\n/);
  const trickyId = (await savePages(agent, [versionOf("Fences", tricky)]).expect(201)).body.id;
  const back = versionsFromConversation((await agent.get("/api/conversations/" + trickyId).expect(200)).body);
  assert.equal(back[0].html, tricky);
  // Nothing about the request was kept, and no picture anywhere.
  assert.ok(!JSON.stringify(s.db.prepare("SELECT content FROM messages").all()).includes("AAAA"));
  assert.ok(balance(s.db, user.id).total > 0);
});

test("saving: only pages this tool can show, no seed phrases, the newest 12 versions, and only your own pages", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "site_owner");
  const b = await person(s.app, "site_other");
  await savePages(a.agent, [versionOf("Nothing", "not a page at all")]).expect(400);
  await savePages(a.agent, [versionOf("", PAGE)]).expect(400);
  await savePages(a.agent, [{ html: PAGE }]).expect(400);
  await savePages(a.agent, [versionOf("Too long", "<html><body>" + "x".repeat(MAX_PAGE_CHARS) + "</body></html>")]).expect(400);
  await savePages(a.agent, []).expect(400);
  await savePages(a.agent, Array.from({ length: MAX_VERSIONS + 1 }, (_, i) => versionOf("v" + i))).expect(400);
  await a.agent.post("/api/site-pages").send({ versions: "x" }).expect(400);
  await a.agent.post("/api/site-pages").send({ versions: [versionOf("x")], id: 5 }).expect(404);
  const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  const blocked = await savePages(a.agent, [versionOf("Seed", PAGE.replace("Shop", seed))]).expect(400);
  assert.equal(blocked.body.error.code, "seed_phrase_blocked");
  assert.equal((await savePages(a.agent, [versionOf("The words: " + seed)]).expect(400)).body.error.code, "seed_phrase_blocked");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0, "nothing stored by a refused save");
  // A fragment is stored as the document it was shown as.
  const frag = await savePages(a.agent, [versionOf("Fragment", "<div><h1>Only a block</h1></div>")]).expect(201);
  const stored = versionsFromConversation((await a.agent.get("/api/conversations/" + frag.body.id).expect(200)).body);
  assert.match(stored[0].html, /^<!doctype html>/);
  // Only the newest 12 versions stay, oldest first out.
  const id = (await savePages(a.agent, [versionOf("v1", PAGE.replace("Shop", "page-1"))]).expect(201)).body.id;
  for (let i = 2; i <= 15; i++) await savePages(a.agent, [versionOf("v" + i, PAGE.replace("Shop", "page-" + i))], id).expect(200);
  const conv = (await a.agent.get("/api/conversations/" + id).expect(200)).body;
  const kept = versionsFromConversation(conv);
  assert.equal(kept.length, MAX_VERSIONS);
  assert.deepEqual(kept.map((v) => v.label), Array.from({ length: MAX_VERSIONS }, (_, i) => "v" + (i + 4)));
  assert.equal(conv.messages.length, MAX_VERSIONS * 2, "each version's words go with it");
  assert.equal((await a.agent.get("/api/site-pages").expect(200)).body.data.find((p) => p.id === id).versions, MAX_VERSIONS);
  // Several versions at once (a retry after a failed save), in order.
  const bulk = await savePages(a.agent, [versionOf("one"), versionOf("two", PAGE.replace("Shop", "two"))]).expect(201);
  assert.deepEqual(versionsFromConversation((await a.agent.get("/api/conversations/" + bulk.body.id).expect(200)).body).map((v) => v.label), ["one", "two"]);
  // Another account can't see, add to or read a page; nor can a chat this tool didn't make be added to.
  assert.deepEqual((await b.agent.get("/api/site-pages").expect(200)).body.data, []);
  assert.equal((await savePages(b.agent, [versionOf("mine now")], id).expect(404)).body.error.code, "page_not_found");
  await b.agent.get("/api/conversations/" + id).expect(404);
  const plain = (await a.agent.post("/api/conversations").send({ title: "A chat" }).expect(201)).body.id;
  assert.equal((await savePages(a.agent, [versionOf("x")], plain).expect(404)).body.error.code, "page_not_found");
  // Cost only comes from the account's own settled hold.
  await b.agent.post("/api/chat").send({ model: MODEL, ephemeral: true, requestId: "req-b", shottosite: MAKE() }).expect(200);
  const stolen = await savePages(a.agent, [versionOf("borrowed", PAGE, { request_id: "req-b" })]).expect(201);
  assert.equal(versionsFromConversation((await a.agent.get("/api/conversations/" + stolen.body.id).expect(200)).body)[0].credits, null);
});

test("erase and export: saved pages are in the account export, and Panic Wipe and closing the account erase them", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "site_wiper");
  const other = await person(s.app, "site_keeper");
  await savePages(a.agent, [versionOf("From a picture", PAGE)]).expect(201);
  await savePages(a.agent, [versionOf("From another", PAGE.replace("Small-batch", "Second"))]).expect(201);
  await savePages(other.agent, [versionOf("Not yours", PAGE.replace("Small-batch", "Keeper"))]).expect(201);
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  const mine = (exported.conversations || []).filter((c) => c.messages.some((m) => m.content?.site));
  assert.equal(mine.length, 2, "the account export holds each page");
  assert.match(JSON.stringify(mine), /Small-batch coffee/, "whole pages");
  assert.ok(!JSON.stringify(exported).includes("Keeper"));
  const before = balance(s.db, a.user.id).total;
  await a.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(a.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=?").get(a.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(other.user.id).n, 1, "others keep theirs");
  assert.equal(balance(s.db, a.user.id).total, before, "credits stay");
  await other.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
});

test("nothing about the picture, the notes or the pages is written to the server's logs", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app);
  const lines = [];
  const original = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(original)) console[k] = (...args) => lines.push(args.map(String).join(" "));
  try {
    await ask(agent, MAKE({ notes: "Secret Brand: private plan" })).expect(200);
    await ask(agent, MAKE({ notes: "Secret Brand [[site:prose]]" })).expect(200);
    await ask(agent, CHANGE({ instruction: "Secret change" })).expect(200);
    const id = (await savePages(agent, [versionOf("Secret label", PAGE.replace("Shop", "Secret shop"))]).expect(201)).body.id;
    await savePages(agent, [versionOf("nope", "not a page")], id).expect(400);
  } finally {
    Object.assign(console, original);
  }
  const all = lines.join("\n");
  assert.doesNotMatch(all, /Secret|Halden|AAAA|<html|data:image/i);
});

// ---- The browser's side ----

test("the browser's helpers: labels, payloads, versions, file names and pasted pictures", () => {
  assert.equal(labelFor("make", { notes: "  Use my  blue " }), "From a picture: Use my blue");
  assert.equal(labelFor("make", {}), "From a picture");
  assert.equal(labelFor("change", { instruction: " Make it \n blue " }), "Change: Make it blue");
  assert.equal(labelFor("change", { instruction: "x".repeat(900) }).length, 300);
  // The fixed beginnings read in the reader's language; the person's own words stay.
  const say = (s) => ({ "From a picture": "来自图片", "Requested change": "修改要求" })[s] || s;
  assert.equal(labelText("From a picture: Halden, brown", say), "来自图片: Halden, brown");
  assert.equal(labelText("From a picture", say), "来自图片");
  assert.equal(labelText("Change: Make it blue", say), "修改要求: Make it blue");
  assert.equal(labelText("Something they wrote", say), "Something they wrote");
  assert.equal(labelText("Changes are welcome", say), "Changes are welcome");
  const image = { url: picture(), mime: "image/jpeg", chars: 3000, width: 800, height: 500 };
  assert.deepEqual(makePayload({ task: "make", image, notes: " hi " }), { task: "make", image: { url: image.url }, notes: "hi" });
  assert.deepEqual(makePayload({ task: "make", image, quote: true }), { task: "make", image: { mime: "image/jpeg", chars: 3000 } });
  assert.deepEqual(makePayload({ task: "change", html: PAGE, instruction: " Blue ", quote: true }), { task: "change", page: { html: PAGE }, instruction: "Blue" });
  // What the browser builds passes the server's own check.
  checkSitePayload(makePayload({ task: "make", image, notes: "hi" }));
  checkSitePayload(makePayload({ task: "make", image, quote: true }), { quote: true });
  checkSitePayload(makePayload({ task: "change", html: PAGE, instruction: "Blue", image }));
  // Versions keep the newest MAX_VERSIONS.
  let list = [];
  for (let i = 0; i < MAX_VERSIONS + 3; i++) list = addVersion(list, newVersion({ html: PAGE, label: "v" + i }));
  assert.equal(list.length, MAX_VERSIONS);
  assert.equal(list[0].label, "v3");
  assert.equal(new Set(list.map((v) => v.id)).size, MAX_VERSIONS, "unique ids");
  assert.ok(list.every((v) => v.saved === false));
  // Files.
  assert.equal(pageSlug("Halden Coffee: Small-batch!"), "halden-coffee-small-batch");
  assert.equal(pageSlug(""), "page");
  assert.equal(pageFileName("Halden Coffee"), "halden-coffee.html");
  assert.equal(sizeText(999), "999 B");
  assert.equal(sizeText(2450), "2.5 KB");
  // A pasted picture: only PNG, JPEG or WebP files.
  const file = { type: "image/png", getAsFile: () => "F" };
  assert.equal(pastedImage({ clipboardData: { items: [{ kind: "string", type: "text/plain" }, { kind: "file", type: "image/png", getAsFile: file.getAsFile }] } }), "F");
  assert.equal(pastedImage({ clipboardData: { items: [{ kind: "file", type: "image/gif", getAsFile: () => "G" }] } }), null);
  assert.equal(pastedImage({ clipboardData: { items: [], files: [{ type: "image/webp" }] } }).type, "image/webp");
  assert.equal(pastedImage({}), null);
  // A conversation that isn't a page reads as no versions.
  assert.deepEqual(versionsFromConversation({ messages: [{ role: "user", content: "hi" }, { role: "assistant", content: { text: "```html\n" + PAGE + "\n```" } }] }), []);
  assert.deepEqual(versionsFromConversation(null), []);
});

test("the stand-in provider behaves like a model would, and only for this tool's prompts", () => {
  assert.equal(siteTestReply([{ role: "system", content: "You are helpful" }, { role: "user", content: "hi" }]), null);
  const make = (notes) => siteTestReply(siteMessages(checkSitePayload(MAKE({ notes }))));
  assert.match(make("Halden: Coffee.").text, /<h1>Coffee<\/h1>/);
  assert.match(make("Make it teal").text, /--accent:#0a7f86/);
  assert.equal(make("[[site:length]]").finish, "length");
  assert.match(make("[[site:refuse]]").text, /^ERROR:/);
  assert.match(make("<b>&\"x\"</b> notes").text, /&lt;b&gt;&amp;&quot;x&quot;&lt;\/b&gt;/, "notes are escaped into the page");
});

// ---- Finding it, and its words ----

test("intent search finds the tool for screenshots, wireframes and mockups", () => {
  const entries = [
    ["home", "Home", "See your recent work, credit usage and account activity in one place."],
    ["code", "Code & build", "Write, explain and debug code with AI. Keep generated files together as you build."],
    ["screenshot", "Screenshot to site", "Drop a screenshot, sketch or wireframe and get a working web page. Change it with words, then download it."],
    ["photos", "Photo tools", "Edit a photo with words, remove its background or upscale it. See the price first."],
    ["slides", "Slides", "Turn a prompt, document or chat into a slide deck. Edit, present or export it."],
  ];
  const first = (q) => rankTools(entries, q)[0]?.[0];
  for (const q of ["screenshot", "turn my screenshot into a site", "wireframe", "mockup", "sketch to page", "image to html", "design to code", "截图", "草图"]) assert.equal(first(q), "screenshot", q);
  assert.equal(first("code"), "code");
  assert.equal(first("website"), "code", "a plain website request still starts at Code & build");
  assert.ok(rankTools(entries, "website").some(([id]) => id === "screenshot"), "and offers this one too");
  assert.equal(first("edit a photo"), "photos");
});

test("zh and es: the update, the page's words and its patterns are in both dictionaries", () => {
  const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")), "zh");
  const es = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/es.json", import.meta.url), "utf8")), "es");
  const u = UPDATES.find((x) => x.id === "shottosite");
  const strings = [
    u.title,
    u.tagline,
    ...u.points,
    "SCREENSHOT TO SITE",
    "Drop a screenshot. Get a working page.",
    "Drop a picture here",
    "Choose a picture",
    "Paste from clipboard",
    "Make the page",
    "Change the page",
    "Change it",
    "Versions",
    "New page",
    "Undo",
    "Redo",
    "Download .html",
    "Copy the page's code",
    "Open in Code & build",
    "Take them out",
    "Your picture",
    "Preview",
    "Code",
    "What the AI sees",
    "Building the page…",
    "Changing the page…",
    "Drop a screenshot, sketch or wireframe and get a working web page. Change it with words, then download it.",
    "Opening Screenshot to site…",
    "Sign in to use Screenshot to site.",
    "In your history, to reopen and change",
    "Saved to your history as a page you can reopen and change. Deleting it there deletes it here.",
    "Off the record: nothing was saved. Download the page before you leave.",
    "This page holds what looks like a seed phrase, so it wasn't saved. Download it instead.",
    "Veil is on. It can't hide details inside a picture, so a page is made only if your words hold nothing Veil would mask.",
    "Veil would mask 1 detail in these words, and a page needs them as written. Remove it, or turn Veil off.",
    "Pages are never kept in Device Vault: they're saved to your history or nowhere.",
    "Stopped. The page wasn't changed, and nothing was charged.",
    "That page wasn't found. It may have been deleted.",
    SITE_CUT_SHORT,
    SITE_CHANGE_CUT_SHORT,
    SITE_UNUSABLE,
    SITE_TOO_LONG,
    SITE_PAGE_TOO_LONG_TO_CHANGE,
    "Choose a picture first.",
    "Say what to change.",
    "Making a page can't be combined with other chat options.",
    "Screenshot to site is coming soon.",
  ];
  for (const en of strings) {
    assert.match(translateText(en, zh) || "", /\p{Script=Han}/u, `zh: ${en}`);
    const text = translateText(en, es);
    assert.ok(text && text !== en, `es: ${en}`);
  }
  for (const en of [
    "Version 3",
    "VERSION 2 OF 5",
    "4 versions",
    "1 version",
    "Sent to the model as a JPEG of 84.3 KB.",
    "1,240 characters written so far",
    "Made with Gemini 2.5 Flash.",
    "Changed with Claude Sonnet 5.",
    "The newest 12 versions are kept. Going back to one is free; changing it makes a new version.",
    "This page reaches for 3 outside resources, such as fonts, scripts or pictures. They're blocked in the preview and won't load offline.",
    "Veil would mask 2 details in these words, and a page needs them as written. Remove them, or turn Veil off.",
    siteRefusedMessage("The picture is blank."),
    "Keep the notes to 1,000 characters.",
    "Up to 12.47 credits",
  ]) {
    assert.match(translateText(en, zh) || "", /\p{Script=Han}/u, `zh: ${en}`);
    const text = translateText(en, es);
    assert.ok(text && text !== en, `es: ${en}`);
  }
  assert.equal(translateText("Version 3", es), "Versión 3");
  assert.equal(translateText("VERSION 2 OF 5", zh), "第 2 版，共 5 版");
});

test("the stream shape: progress events never carry the page, and the reply is one piece", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app);
  const r = await ask(agent, MAKE()).expect(200);
  for (const e of events(r.text).filter((x) => x.shottosite)) assert.deepEqual(Object.keys(e.shottosite), ["chars"]);
  assert.ok(!r.text.split("data: ").slice(0, -1).some((chunk) => /<html|<!doctype/i.test(chunk) && !chunk.includes('"choices"')));
  assert.equal(r.headers["content-type"].split(";")[0], "text/event-stream");
});
