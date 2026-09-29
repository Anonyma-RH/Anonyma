import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import JSZip from "jszip";
import { createApp } from "../server/app.js";
import { now, uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { knownPage } from "../src/site-routes.js";
import { paletteActions } from "../src/command-palette.js";
import { modeReleased } from "../src/lib.js";
import { rankTools } from "../src/tool-search.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { createVault, openChat, sealChat } from "../src/device-vault.js";
import {
  MAX_CHATS_PER_REQUEST,
  MAX_CHAT_CHARS,
  MAX_FILE_BYTES,
  MAX_MESSAGES_PER_CHAT,
  MAX_MESSAGE_CHARS,
  MAX_REQUEST_CHARS,
  accountFit,
  checkUploadedChat,
  chatProblem,
  chosenIds,
  destinationRoom,
  selectAll,
  selectNone,
  cleanTitle,
  parseChatGPT,
  parseClaude,
  planBatches,
  searchMatcher,
  toMillis,
  uploadShape,
} from "../src/chat-import.js";
import { ImportError, isConversationsFile, loadExport } from "../src/chat-import-engine.js";
import { importToAccount, importToMarkdown, importToVault, toVaultChat } from "../src/chat-import-run.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const FIXTURES = new URL("./fixtures/chat-import/", import.meta.url);
const chatgptJson = readFileSync(new URL("chatgpt-conversations.json", FIXTURES));
const claudeJson = readFileSync(new URL("claude-conversations.json", FIXTURES));
const chatgptList = JSON.parse(chatgptJson.toString("utf8"));
const claudeList = JSON.parse(claudeJson.toString("utf8"));
const ABANDON_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// A wallet key, derived here rather than written out (none has held funds).
const sha = (b) => createHash("sha256").update(b).digest();
function base58check(payload) {
  const bytes = Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + bytes.toString("hex")),
    out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
}
const WIF = base58check(Buffer.concat([Buffer.from([0x80]), sha("chat import fixture"), Buffer.from([1])]));

function fixture(t, released = "all", extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-chat-import-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...(released !== "all" ? { mvpModels: ["google/gemini-2.5-flash"] } : {}),
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(app, username = "importer") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}

// A chat as the page uploads it.
const chat = (n, extra = {}) => ({
  source_id: "src-" + n,
  title: "Imported chat " + n,
  created: Date.UTC(2024, 0, 1 + n),
  updated: Date.UTC(2024, 0, 2 + n),
  messages: [
    { role: "user", text: "question " + n, created: Date.UTC(2024, 0, 1 + n, 9) },
    { role: "assistant", text: "answer " + n, created: Date.UTC(2024, 0, 1 + n, 9, 1) },
  ],
  ...extra,
});
const send = (p, source, chats) => p.agent.post("/api/import/chats").send({ source, chats });
const texts = (c) => c.messages.map((m) => `${m.role}: ${m.text}`);

// ---- Reading the two formats ----

test("ChatGPT: the branch on screen is rebuilt from current_node, and only the words are kept", () => {
  const { chats, empty } = parseChatGPT(chatgptList);
  assert.equal(empty, 1, "the system-prompt-only chat has nothing to import");
  const byKey = Object.fromEntries(chats.map((c) => [c.key, c]));
  // A regenerated answer: the old branch is not part of the chat.
  const a = byKey["chatgpt-conv-a"];
  assert.deepEqual(texts(a), [
    "user: I have three days in Lisbon. What should I see?",
    "assistant: Start with Alfama, then Belém, then a day trip to Sintra.",
    "user: Which day for Sintra?",
    "assistant: Day three, and go early to beat the crowds.",
  ]);
  assert.ok(!JSON.stringify(a).includes("OLD BRANCH"));
  assert.equal(a.title, "Planning a trip to Lisbon");
  assert.equal(a.created, 1710000000000);
  assert.equal(a.updated, 1710000600000);
  assert.equal(a.messages[0].at, 1710000010000, "message times are milliseconds");
  // Tool steps, an image and citations: the words only; the image is counted.
  const b = byKey["chatgpt-conv-b"];
  assert.deepEqual(texts(b), [
    "user: Plot this chart and tell me the trend.",
    "assistant: I plotted it.\n\nSales rise steadily from March and dip in August.",
  ]);
  assert.equal(b.attachments, 1, "the image was left out and counted once");
  assert.ok(!JSON.stringify(b).includes("plot()"), "the code call is a tool step");
  assert.ok(!/[-]/.test(JSON.stringify(b)), "citation markers are gone");
  // No current_node (older exports): the newest child at each step; no title
  // falls back to the first prompt.
  const c = byKey["chatgpt-conv-c"];
  assert.deepEqual(texts(c), ["user: What is 2 + 2?", "assistant: Four."]);
  assert.equal(c.title, "What is 2 + 2?");
  assert.ok(chats.every((x) => x.messages.every((m) => m.role === "user" || m.role === "assistant")));
  assert.ok(chats.every((x) => x.messages.every((m, i, all) => i === 0 || all[i - 1].role !== m.role)), "sides alternate");
});

test("ChatGPT: entities read as their name, odd shapes and cycles don't break it", () => {
  const T = 1710000000;
  const at = (id, parent, children, message) => ({ id, parent, children, message });
  const m = (role, parts, extra = {}) => ({ author: { role }, create_time: T, content: { content_type: "text", parts }, metadata: {}, recipient: "all", ...extra });
  const list = [
    {
      title: "Odd",
      create_time: T,
      current_node: "b",
      id: "odd",
      mapping: {
        // a and b point at each other: the walk stops instead of looping.
        a: at("a", "b", ["b"], m("user", ["Where is entity[\"city\",\"Lisbon\",\"a capital\"]?"])),
        b: at("b", "a", [], m("assistant", ["In Portugal.【4:0†source】"])),
      },
    },
    { title: "Broken", mapping: null },
    null,
    { title: "No mapping" },
  ];
  const { chats, empty } = parseChatGPT(list);
  assert.equal(chats.length, 1);
  assert.equal(empty, 3);
  assert.deepEqual(texts(chats[0]).sort(), ["assistant: In Portugal.", "user: Where is Lisbon?"].sort());
});

test("Claude: text blocks only; thinking, tool use, attachments and files are left out and counted", () => {
  const { chats, empty } = parseClaude(claudeList);
  assert.equal(empty, 1, "the chat with no messages isn't listed");
  const one = chats.find((c) => c.key === "claude-conv-1");
  assert.deepEqual(texts(one), [
    "user: Can you review this indemnity clause?",
    "assistant: It is broad.\n\nConsider a cap on liability.",
    "user: Thanks. Draft the cap.",
    "assistant: Liability is capped at fees paid in the prior twelve months.",
  ]);
  const flat = JSON.stringify(one);
  for (const secret of ["HIDDEN REASONING", "ARTIFACT BODY", "SECRET CONTRACT BODY"]) assert.ok(!flat.includes(secret), secret);
  assert.equal(one.attachments, 3, "one attachment and two files");
  assert.equal(one.created, Date.parse("2025-02-03T10:00:00.000000Z"));
  // The older shape (text only) and an empty name.
  const two = chats.find((c) => c.key === "claude-conv-2");
  assert.equal(two.title, "Give me a haiku about rain.");
  assert.match(two.messages[1].text, /^Soft rain on the roof,\nthe street/);
  assert.equal(two.attachments, 0);
});

test("times, titles and search text are read tolerantly", () => {
  assert.equal(toMillis(1710000000.5), 1710000000500);
  assert.equal(toMillis(1710000000500), 1710000000500);
  assert.equal(toMillis("2025-02-03T10:00:00Z"), Date.UTC(2025, 1, 3, 10));
  assert.equal(toMillis(null), 0);
  assert.equal(toMillis("nonsense"), 0);
  assert.equal(cleanTitle("  a\n\tb\u0000  c  "), "a b c");
  assert.equal(Array.from(cleanTitle("x".repeat(200))).length, 70);
  assert.equal(Array.from(cleanTitle("x".repeat(300), 200)).length, 200);
  assert.equal(cleanTitle("😀".repeat(100)), "😀".repeat(70), "never cut inside a character");
  const match = searchMatcher("lisbon");
  assert.ok(match({ title: "Trip to LISBON", messages: [] }));
  assert.ok(match({ title: "x", messages: [{ text: "we went to Lisbon" }] }));
  assert.ok(!match({ title: "x", messages: [{ text: "we went to Porto" }] }));
  assert.equal(searchMatcher("   "), null);
  assert.ok(searchMatcher("a.b")({ title: "a.b", messages: [] }) && !searchMatcher("a.b")({ title: "axb", messages: [] }), "the query is not a pattern");
});

// ---- Opening an export ----

const zipOf = async (files, options = {}) => {
  const zip = new JSZip();
  for (const [name, data] of Object.entries(files)) zip.file(name, data);
  return zip.generateAsync({ type: "uint8array", ...options });
};

test("a ZIP is opened in the browser: nested and numbered files, junk ignored, one service", async () => {
  const [first, second] = [chatgptList.slice(0, 2), chatgptList.slice(2)];
  const bytes = await zipOf({
    "export/conversations-000.json": JSON.stringify(first),
    "export/conversations-001.json": JSON.stringify(second),
    "export/user.json": "{}",
    "export/chat.html": "<html>not read</html>",
    "export/file-abc.png": "not an image",
    "__MACOSX/export/._conversations-000.json": "junk",
  });
  const seen = [];
  const session = await loadExport(bytes, { onProgress: (p) => seen.push(p.phase) });
  const view = session.overview();
  assert.equal(view.source, "chatgpt");
  assert.equal(view.chats.length, 4);
  assert.equal(view.empty, 1);
  assert.equal(view.messages, 10);
  assert.equal(view.attachments, 1);
  assert.ok(seen.includes("unzipping") && seen.includes("parsed"));
  // Newest first.
  assert.deepEqual(view.chats.map((c) => c.updated), [...view.chats.map((c) => c.updated)].sort((a, b) => b - a));
  // A plain conversations.json works the same, and Claude's is detected.
  assert.equal((await loadExport(new Uint8Array(chatgptJson))).overview().chats.length, 4);
  const claude = (await loadExport(new Uint8Array(claudeJson))).overview();
  assert.equal(claude.source, "claude");
  assert.equal(claude.chats.length, 2);
  assert.equal(claude.attachments, 3);
  // What counts as a conversations file.
  for (const name of ["conversations.json", "a/b/conversations-012.json", "Conversations.JSON"]) assert.ok(isConversationsFile(name), name);
  for (const name of ["conversations.jsonl", "user.json", "my-conversations.json", "__MACOSX/conversations.json", "a/._conversations.json"])
    assert.ok(!isConversationsFile(name), name);
});

test("a file that isn't an export is refused in plain words", async () => {
  const cases = [
    [new Uint8Array(Buffer.from("just some text")), "not_export"],
    [new Uint8Array(Buffer.from("{}")), "not_export"],
    [new Uint8Array(Buffer.from('[{"a":1}]')), "not_export"],
    [new Uint8Array(Buffer.from("[]")), "no_chats"],
    [new Uint8Array(0), "not_export"],
    [await zipOf({ "notes.txt": "hello" }), "no_conversations"],
    [new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "bad_zip"],
    [
      await zipOf({ "conversations-000.json": JSON.stringify(chatgptList), "conversations-001.json": JSON.stringify(claudeList) }),
      "mixed",
    ],
  ];
  for (const [input, code] of cases) {
    const error = await loadExport(input).then(() => null, (e) => e);
    assert.ok(error instanceof ImportError, code);
    assert.equal(error.code, code);
    assert.ok(error.message.length > 20 && !/undefined|\[object/.test(error.message), error.message);
  }
  // Chats that hold no text at all.
  const empty = await loadExport(new Uint8Array(Buffer.from(JSON.stringify([chatgptList[3]])))).then(() => null, (e) => e);
  assert.equal(empty.code, "no_chats");
});

test("size caps: an over-size file is refused before it is read, and a ZIP that declares a huge expansion is refused before it is unpacked", async () => {
  let read = false;
  const huge = {
    size: MAX_FILE_BYTES + 1,
    async arrayBuffer() {
      read = true;
      return new ArrayBuffer(0);
    },
  };
  const tooBig = await loadExport(huge).then(() => null, (e) => e);
  assert.equal(tooBig.code, "too_big");
  assert.match(tooBig.message, /200 MB/);
  assert.equal(read, false, "not even read");
  // A real ZIP whose central directory claims 400 MB for the conversations.
  const zip = Buffer.from(await zipOf({ "conversations.json": JSON.stringify(claudeList) }, { compression: "STORE" }));
  const central = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  assert.ok(central > 0);
  zip.writeUInt32LE(400 * 1024 * 1024, central + 24);
  const bomb = await loadExport(new Uint8Array(zip)).then(() => null, (e) => e);
  assert.equal(bomb.code, "too_big");
  // The same ZIP, honest, is fine.
  const fine = Buffer.from(await zipOf({ "conversations.json": JSON.stringify(claudeList) }, { compression: "STORE" }));
  assert.equal((await loadExport(new Uint8Array(fine))).overview().chats.length, 2);
});

// ---- Choosing ----

test("the list, search and selection: the reader gives titles, dates and counts, and only the chats asked for", async () => {
  const session = await loadExport(new Uint8Array(chatgptJson));
  const view = session.overview();
  assert.deepEqual(
    view.chats.map((c) => [c.title, c.messages, c.updated > c.created - 1]),
    [
      ["Wallet notes", 2, true],
      ["What is 2 + 2?", 2, true],
      ["Chart the sales data", 2, true],
      ["Planning a trip to Lisbon", 4, true],
    ],
  );
  // The list carries no message text.
  assert.ok(!JSON.stringify(view).includes("Alfama"));
  assert.deepEqual(view.chats.map((c) => c.id), [0, 1, 2, 3]);
  // Search: titles and messages, case-insensitively; empty means everything.
  assert.deepEqual(session.search("lisbon"), [3]);
  assert.deepEqual(session.search("SINTRA"), [3], "found in a message");
  assert.deepEqual(session.search("sales"), [2]);
  assert.deepEqual(session.search("OLD BRANCH"), [], "text from a branch that isn't shown can't be found");
  assert.deepEqual(session.search("zzzz"), []);
  assert.deepEqual(session.search(""), [0, 1, 2, 3]);
  assert.deepEqual(session.search("  "), [0, 1, 2, 3]);
  // Only the requested chats come back, in the order asked; bad ids are dropped.
  const got = session.get([3, 1, 99, -1, 1.5, "0"]);
  assert.deepEqual(got.map((c) => c.id), [3, 1]);
  assert.deepEqual(got.map((c) => c.title), ["Planning a trip to Lisbon", "What is 2 + 2?"]);
  assert.deepEqual(session.get([]), []);
});

test("Seed Guard flags chats with a seed phrase or key while reading, only when it is live", async () => {
  const on = (await loadExport(new Uint8Array(chatgptJson), { seedGuard: true })).overview();
  assert.deepEqual(on.chats.filter((c) => c.seed).map((c) => c.title), ["Wallet notes"]);
  const off = (await loadExport(new Uint8Array(chatgptJson))).overview();
  assert.ok(off.chats.every((c) => c.seed === false));
  // A key in a later message counts too, a bare hash does not.
  const withKey = structuredClone(claudeList);
  withKey[1].chat_messages[1].content = [{ type: "text", text: "the key is " + WIF }];
  withKey[0].chat_messages[0].content = [{ type: "text", text: "tx " + sha("x").toString("hex") }];
  const flagged = (await loadExport(new Uint8Array(Buffer.from(JSON.stringify(withKey))), { seedGuard: true })).overview();
  assert.deepEqual(flagged.chats.map((c) => [c.key, c.seed]), [["claude-conv-1", false], ["claude-conv-2", true]]);
});

test("a chat too big for the account is marked, and stays importable elsewhere", async () => {
  const many = { ...chat(1), messages: Array.from({ length: MAX_MESSAGES_PER_CHAT + 1 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "x", created: 1 })) };
  assert.equal(accountFit({ messages: many.messages.map((m) => ({ ...m, text: m.text })) }), "too_large");
  assert.equal(accountFit({ messages: [{ role: "user", text: "x".repeat(MAX_MESSAGE_CHARS + 1) }] }), "too_large");
  const long = Array.from({ length: 11 }, () => ({ role: "user", text: "y".repeat(MAX_CHAT_CHARS / 10) }));
  assert.equal(accountFit({ messages: long }), "too_large");
  assert.equal(accountFit({ messages: [{ role: "user", text: "fine" }] }), null);
  const list = structuredClone(claudeList);
  list[1].chat_messages[1].content = [{ type: "text", text: "z".repeat(MAX_MESSAGE_CHARS + 5) }];
  const view = (await loadExport(new Uint8Array(Buffer.from(JSON.stringify(list))))).overview();
  assert.deepEqual(view.chats.map((c) => c.fit), [null, "too_large"]);
});

test("selection: select all takes only what can be chosen and only what is in view; none clears the same; the destination decides the room", async () => {
  const list = structuredClone(chatgptList);
  const session = await loadExport(new Uint8Array(Buffer.from(JSON.stringify(list))), { seedGuard: true });
  const chats = session.overview().chats;
  const byTitle = Object.fromEntries(chats.map((c) => [c.title, c]));
  const seed = byTitle["Wallet notes"];
  const big = { ...byTitle["What is 2 + 2?"], fit: "too_large" };
  const all = chats.map((c) => (c.id === big.id ? big : c));
  const ids = (set) => [...set].sort((a, b) => a - b);
  // Markdown and the vault take everything; the account holds back a seed phrase and a chat over its limits.
  const rules = (dest, more = {}) => ({ dest, known: null, allow: new Set(), seedLive: true, ...more });
  assert.deepEqual(ids(selectAll(new Set(), all, rules("markdown"))), [0, 1, 2, 3]);
  assert.deepEqual(ids(selectAll(new Set(), all, rules("vault"))), [0, 1, 2, 3]);
  assert.deepEqual(ids(selectAll(new Set(), all, rules("account"))), [2, 3]);
  assert.equal(chatProblem(seed, rules("account")), "seed");
  assert.equal(chatProblem(big, rules("account")), "big");
  assert.equal(chatProblem(seed, rules("vault")), null, "Seed Guard is for the account only");
  assert.equal(chatProblem(seed, rules("account", { seedLive: false })), null, "and only once it is live");
  // Allowing one chat (after the second confirm) lets that chat, and only it, be chosen.
  const allowed = rules("account", { allow: new Set([seed.id]) });
  assert.equal(chatProblem(seed, allowed), null);
  assert.deepEqual(ids(selectAll(new Set(), all, allowed)), [0, 2, 3]);
  // Already imported chats can't be chosen again, wherever they were imported.
  const known = rules("vault", { known: new Set(["chatgpt-conv-a"]) });
  assert.equal(chatProblem(byTitle["Planning a trip to Lisbon"], known), "known");
  assert.deepEqual(ids(selectAll(new Set(), all, known)), [0, 1, 2]);
  // Only what is in view: a search narrows what "all" and "none" touch.
  const inView = session.search("lisbon").map((i) => all[i]);
  const some = selectAll(new Set([0]), inView, rules("markdown"));
  assert.deepEqual(ids(some), [0, 3]);
  assert.deepEqual(ids(selectNone(some, inView, true)), [0], "none clears the chats in view, not the rest");
  assert.deepEqual(ids(selectNone(some, all, false)), [], "with nothing filtered, none clears everything");
  // What is imported: chosen, and still allowed, in the list's order.
  const picked = new Set([3, 0, 2, 9]);
  assert.deepEqual(chosenIds(picked, all, rules("account")), [2, 3], "a chat that became unchoosable drops out; unknown ids are ignored");
  assert.deepEqual(chosenIds(picked, all, rules("markdown")).length, 3);
  // Room: the account's and the vault's, and Markdown has none to run out of.
  assert.equal(destinationRoom("account", { status: { room: 12 } }), 12);
  assert.equal(destinationRoom("account", { status: null }), 0, "not known yet: not chosen");
  assert.equal(destinationRoom("vault", { vaultCount: 4990, vaultMax: 5000 }), 10);
  assert.equal(destinationRoom("vault", { vaultCount: 6000, vaultMax: 5000 }), 0);
  assert.equal(destinationRoom("markdown"), Infinity);
});

// ---- The vault's sidebar ----

// DeviceVault.jsx with its UI and Vault Sync stand-ins, as the vault tests load it.
async function vaultModule() {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-chat-import-dv-"));
  const react = import.meta.resolve("react");
  const ui = join(dir, "ui.mjs");
  writeFileSync(
    ui,
    `import React from "${react}";
     export const Icon = () => React.createElement("svg");
     export const Button = ({ children, secondary, ...rest }) => React.createElement("button", rest, children);
     export const Notice = ({ children }) => React.createElement("div", null, children);
     export const Modal = ({ title, children }) => React.createElement("div", { className: "modal" }, React.createElement("h2", null, title), children);`,
  );
  const sync = join(dir, "sync.mjs");
  writeFileSync(
    sync,
    `import React from "${react}";
     export const VaultSyncSection = () => null;
     export const VaultSyncJoin = () => null;
     export const VaultSyncStatus = () => null;
     export const ConflictCopyTag = () => null;`,
  );
  try {
    const file = new URL("../src/DeviceVault.jsx", import.meta.url);
    const { code } = await transformWithEsbuild(readFileSync(file, "utf8"), file.pathname, { jsx: "transform", format: "esm" });
    const out = code
      .replace(/^import "\.\/[\w-]+\.css";$/m, "")
      .replace(/from "\.\/ui\.jsx"/g, `from "${pathToFileURL(ui).href}"`)
      .replace(/from "\.\/VaultSync\.jsx"/g, `from "${pathToFileURL(sync).href}"`)
      .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
      .replace(/from "react"/g, `from "${react}"`);
    const mod = join(dir, "DeviceVault.mjs");
    writeFileSync(mod, out);
    return await import(pathToFileURL(mod).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the vault's sidebar lists every chat as it always has, and folds a vault that imported chats fill; each imported chat carries its mark", async () => {
  const { VaultSection } = await vaultModule();
  const chatOf = (i, extra = {}) => ({ id: "v" + i, title: "Chat " + i, mode: "chat", messages: [], updated: 1000 - i, ...extra });
  const render = (chats, currentId = null) =>
    renderToStaticMarkup(
      createElement(VaultSection, { vault: { status: "unlocked", unlocked: true, chats, meta: {}, damaged: 0, lock() {} }, currentId, onOpen() {}, onDialog() {} }),
    );
  const rows = (html) => (html.match(/<span data-i18n="off">/g) || []).length;
  // No imported chats: everything, and no button, however many.
  const plain = render(Array.from({ length: 60 }, (_, i) => chatOf(i)));
  assert.equal(rows(plain), 60);
  assert.ok(!plain.includes("Show all"));
  assert.ok(!plain.includes("chat-imported"));
  // Imported chats: the newest 40 and a button for the rest, each imported one marked.
  const filled = render(Array.from({ length: 60 }, (_, i) => chatOf(i, { importedFrom: i % 2 ? "claude" : "chatgpt", importKey: "k" + i })));
  assert.equal(rows(filled), 40);
  assert.match(filled, /Show all 60 chats/);
  assert.equal((filled.match(/class="chat-imported"/g) || []).length, 40);
  assert.match(filled, /title="Imported from ChatGPT"/);
  assert.match(filled, /title="Imported from Claude"/);
  // The open chat stays in view even past the fold.
  const open = render(Array.from({ length: 60 }, (_, i) => chatOf(i, { importedFrom: "chatgpt" })), "v55");
  assert.equal(rows(open), 41);
  assert.ok(open.includes("Chat 55"));
  // A few imported chats are simply listed.
  const few = render(Array.from({ length: 5 }, (_, i) => chatOf(i, { importedFrom: "claude" })));
  assert.equal(rows(few), 5);
  assert.ok(!few.includes("Show all"));
});

// ---- What leaves the browser ----

const fakeEngine = (session) => ({ get: async (ids) => session.get(ids) });

test("reading, listing and searching never touch the network", async () => {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...a) => {
    calls.push(a);
    throw Error("no network expected");
  };
  try {
    const session = await loadExport(await zipOf({ "conversations.json": chatgptJson }), { seedGuard: true });
    session.overview();
    session.search("lisbon");
    session.get([0]);
    await importToVault({ engine: fakeEngine(session), ids: [0], source: "chatgpt", vault: { saveMany: async () => {} } });
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(calls, []);
});

test("the account destination sends only the chosen chats, as words and dates, in batches", async () => {
  const session = await loadExport(new Uint8Array(chatgptJson));
  const bodies = [];
  const post = async (body) => {
    bodies.push(structuredClone(body));
    return { saved: body.chats.map((_, index) => ({ index, id: "c_" + bodies.length + "_" + index })), skipped: [] };
  };
  const chosen = [3, 1];
  const progress = [];
  const out = await importToAccount({ engine: fakeEngine(session), ids: chosen, source: "chatgpt", post, onProgress: (p) => progress.push(p.done) });
  const flat = JSON.stringify(bodies);
  // Exactly the two chosen chats, nothing about the others.
  assert.equal(bodies.reduce((n, b) => n + b.chats.length, 0), 2);
  assert.deepEqual(bodies.flatMap((b) => b.chats.map((c) => c.title)).sort(), ["Planning a trip to Lisbon", "What is 2 + 2?"]);
  for (const other of ["Wallet notes", "Chart the sales data", "abandon", "plot()"]) assert.ok(!flat.includes(other), other);
  // Their words and dates, and the export's id for the repeat check; no more.
  for (const b of bodies) {
    assert.deepEqual(Object.keys(b).sort(), ["chats", "source"]);
    for (const c of b.chats) {
      assert.deepEqual(Object.keys(c).sort(), ["created", "messages", "source_id", "title", "updated"]);
      for (const m of c.messages) assert.deepEqual(Object.keys(m).sort(), ["created", "role", "text"]);
    }
  }
  assert.equal(out.saved.length, 2);
  assert.deepEqual(out.saved.map((s) => s.title), ["Planning a trip to Lisbon", "What is 2 + 2?"]);
  assert.deepEqual(out.left, []);
  assert.equal(out.error, null);
  assert.deepEqual(progress.at(-1), 2);
  // A per-chat Seed Guard override is sent for that chat alone.
  const overridden = [];
  await importToAccount({
    engine: fakeEngine(session),
    ids: [0, 1],
    source: "chatgpt",
    allow: new Set([0]),
    post: async (body) => {
      overridden.push(...body.chats.map((c) => [c.title, c.allow_seed_phrase === true]));
      return { saved: [], skipped: body.chats.map((_, index) => ({ index, reason: "already_imported" })) };
    },
  });
  assert.deepEqual(overridden, [["Wallet notes", true], ["What is 2 + 2?", false]]);
});

test("a failed or stopped import says what was done and what was not", async () => {
  const session = await loadExport(new Uint8Array(chatgptJson));
  let n = 0;
  const failing = await importToAccount({
    engine: fakeEngine(session),
    ids: [0, 1, 2, 3],
    source: "chatgpt",
    post: async (body) => {
      if (++n === 2) throw Error("The service could not be reached.");
      return { saved: body.chats.map((_, index) => ({ index, id: "c" + index })), skipped: [] };
    },
  }).then((r) => r);
  // Every chat fits one batch here, so the first request carries all four.
  assert.equal(failing.saved.length, 4);
  // Many batches: the second fails, the first is kept, the rest is reported as left.
  const big = Array.from({ length: 45 }, (_, i) => ({ ...chat(i), id: i, key: "k" + i, at: 0, messages: chat(i).messages.map((m) => ({ ...m, at: m.created })) }));
  let calls = 0;
  const partial = await importToAccount({
    engine: { get: async (ids) => ids.map((i) => big[i]) },
    ids: big.map((c) => c.id),
    source: "claude",
    post: async (body) => {
      if (++calls === 2) throw Object.assign(Error("Too many requests."), { status: 429 });
      return { saved: body.chats.map((_, index) => ({ index, id: "c" })), skipped: [] };
    },
  });
  assert.equal(partial.saved.length, 20);
  assert.equal(partial.left.length, 25);
  assert.equal(partial.error.message, "Too many requests.");
  // Stop between batches.
  const ctl = new AbortController();
  const stopped = await importToAccount({
    engine: { get: async (ids) => ids.map((i) => big[i]) },
    ids: big.map((c) => c.id),
    source: "claude",
    signal: ctl.signal,
    post: async (body) => {
      ctl.abort();
      return { saved: body.chats.map((_, index) => ({ index, id: "c" })), skipped: [] };
    },
  });
  assert.equal(stopped.error, "stopped");
  assert.equal(stopped.saved.length, 20);
  assert.equal(stopped.left.length, 25);
});

test("batches stay under the request limits, in order", () => {
  const mk = (n, chars) => ({ id: n, messages: [{ role: "user", text: "a".repeat(chars) }] });
  assert.deepEqual(planBatches([]), []);
  const many = planBatches(Array.from({ length: 45 }, (_, i) => mk(i, 10)));
  assert.deepEqual(many.map((b) => b.length), [20, 20, 5]);
  assert.deepEqual(many.flat().map((c) => c.id), Array.from({ length: 45 }, (_, i) => i));
  const heavy = planBatches(Array.from({ length: 5 }, (_, i) => mk(i, MAX_CHAT_CHARS)));
  assert.ok(heavy.every((b) => b.reduce((n, c) => n + c.messages[0].text.length, 0) <= MAX_REQUEST_CHARS));
  assert.deepEqual(heavy.map((b) => b.length), [1, 1, 1, 1, 1], "two 2 MB chats would pass 4 MB with their overhead");
  assert.equal(planBatches([mk(1, 5)]).length, 1);
});

test("Device Vault: chats are sealed on this device with their own title, dates and origin, and a repeat is recognised", async () => {
  const session = await loadExport(new Uint8Array(chatgptJson));
  const { key } = await createVault("a long enough passphrase");
  const kept = [];
  const vault = {
    saveMany: async (list) => {
      for (const c of list) kept.push(await sealChat(key, c));
    },
  };
  const out = await importToVault({ engine: fakeEngine(session), ids: [3, 2], source: "chatgpt", vault });
  assert.equal(out.saved.length, 2);
  assert.equal(kept.length, 2);
  // Sealed: nothing readable in what is stored.
  assert.ok(!JSON.stringify(kept).includes("Lisbon") && !JSON.stringify(kept).includes("Alfama"));
  const opened = await Promise.all(kept.map((r) => openChat(key, r)));
  const trip = opened.find((c) => c.title === "Planning a trip to Lisbon");
  assert.equal(trip.importedFrom, "chatgpt");
  assert.equal(trip.importKey, "chatgpt-conv-a");
  assert.equal(trip.mode, "chat");
  assert.equal(trip.private, false);
  assert.equal(trip.created, 1710000000000);
  assert.equal(trip.updated, 1710000600000);
  assert.deepEqual(trip.messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.equal(trip.messages[1].content, "Start with Alfama, then Belém, then a day trip to Sintra.");
  assert.ok(trip.veil === null && !trip.sealed);
  assert.notEqual(opened[0].id, opened[1].id);
  assert.match(opened[0].id, /^[0-9a-f-]{36}$/, "vault ids are random, never readable text");
  // A failing vault stops the run and reports what is left.
  const failing = await importToVault({
    engine: fakeEngine(session),
    ids: [0, 1, 2, 3],
    source: "chatgpt",
    vault: { saveMany: async () => { throw Error("Vault storage was interrupted."); } },
  });
  assert.equal(failing.saved.length, 0);
  assert.deepEqual(failing.left, [0, 1, 2, 3]);
  assert.equal(failing.error.message, "Vault storage was interrupted.");
  // The chat object is the ordinary vault shape.
  const shaped = toVaultChat({ ...session.get([3])[0] }, "chatgpt");
  assert.deepEqual(Object.keys(shaped).sort(), ["created", "id", "importKey", "importedFrom", "messages", "mode", "private", "title", "updated", "veil"]);
});

test("Markdown files: made here, safely, one per chat, named by date, zipped when there are several", async () => {
  const session = await loadExport(new Uint8Array(chatgptJson));
  const progress = [];
  const out = await importToMarkdown({ engine: fakeEngine(session), ids: [3, 2, 1], source: "chatgpt", onProgress: (p) => progress.push(p.done) });
  assert.equal(out.error, null);
  assert.equal(out.download.count, 3);
  assert.match(out.download.name, /^anonyma-chatgpt-import-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = await JSZip.loadAsync(await out.download.blob.arrayBuffer());
  const names = Object.keys(zip.files).sort();
  assert.deepEqual(names, [
    "anonyma-chart-the-sales-data-2024-03-09.md",
    "anonyma-planning-a-trip-to-lisbon-2024-03-09.md",
    "anonyma-what-is-2-2-2024-03-09.md",
  ]);
  const trip = await zip.file("anonyma-planning-a-trip-to-lisbon-2024-03-09.md").async("string");
  assert.match(trip, /^# Planning a trip to Lisbon\n\n- Written in ChatGPT\n- Exported from ANONYMA/);
  assert.match(trip, /## You/);
  assert.match(trip, /## ChatGPT/);
  assert.ok(trip.includes("Start with Alfama, then Belém, then a day trip to Sintra."));
  assert.ok(!trip.includes("OLD BRANCH"));
  // One chat is a single .md file, not a ZIP.
  const one = await importToMarkdown({ engine: fakeEngine(session), ids: [1], source: "chatgpt" });
  assert.equal(one.download.name, "anonyma-what-is-2-2-2024-03-09.md");
  assert.match(one.download.blob.type, /text\/markdown/);
  // Raw HTML in a chat is shown as text, never left live.
  const hostile = {
    get: async () => [{ id: 0, key: "k", title: "<img src=x onerror=alert(1)>", created: 1, updated: 2, messages: [{ role: "user", text: "<script>alert(1)</script> [a](javascript:alert(1))", at: 1 }, { role: "assistant", text: "fine", at: 2 }] }],
  };
  const safe = await importToMarkdown({ engine: hostile, ids: [0], source: "claude" });
  const text = await safe.download.blob.text();
  assert.ok(!/(^|[^\\])<(script|img)/i.test(text), "raw HTML stays escaped: " + text);
  assert.ok(!text.includes("javascript:"));
  assert.deepEqual(progress.at(-1), 3);
});

// ---- The release gate ----

test("unreleased: both routes are refused, nothing is listed, and there's no page, place or link", async (t) => {
  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app);
  for (const send of [
    () => a.agent.get("/api/import/status"),
    () => a.agent.post("/api/import/chats").send({ source: "chatgpt", chats: [chat(1)] }),
    () => a.agent.get("/API/Import/Status"),
    () => a.agent.post("/api/import/anything").send({}),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Chat Import is coming soon.");
  }
  await request(mvp.app).get("/api/import/status").expect(403);
  assert.equal(mvp.db.prepare("SELECT COUNT(*) n FROM chat_imports").get().n, 0);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.chatimport, false);
  const entry = config.releases.updates.find((u) => u.id === "chatimport");
  assert.equal(entry.title, "Chat Import");
  assert.equal(entry.tagline, "Bring your ChatGPT or Claude history with you.");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  assert.equal(typeof committed[UPDATES.findIndex((u) => u.id === "chatimport")], "boolean", "registered, and flipped only by a release commit");
  const docs = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(docs.paths).some((p) => p.startsWith("/api/import")), "the served API docs leave it out");
  // The list of chats says nothing of imports before release.
  const listed = (await a.agent.get("/api/conversations").expect(200)).body.data;
  assert.ok(listed.every((c) => !("imported_from" in c)));
  // The page: a 404 until release.
  if (existsSync("dist/client/index.html")) {
    await request(mvp.app).get("/workspace/import").expect(404);
    await request(fixture(t, "mvp,chatimport").app).get("/workspace/import").expect(200);
  }
  assert.equal(knownPage("/workspace/import"), false);
  assert.equal(knownPage("/workspace/import", { chatimport: true }), true);
  // The client: no mode, no palette place, no tool-directory entry.
  const cfg = (features) => ({ releases: { features } });
  assert.equal(modeReleased(cfg({}), "import"), false);
  assert.equal(modeReleased(cfg({ chatimport: true }), "import"), true);
  const ids = (c) => paletteActions({ config: c, mode: "chat", signedIn: true }).map((x) => x.id);
  assert.ok(!ids(cfg({})).includes("go-import"));
  assert.ok(ids(cfg({ chatimport: true })).includes("go-import"));
  // Released on its own, it needs nothing else, and the docs list both routes.
  const own = fixture(t, "mvp,chatimport");
  const b = await person(own.app, "ben");
  await b.agent.get("/api/import/status").expect(200);
  await request(own.app).get("/api/import/status").expect(401);
  const open = (await request(own.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(open.paths["/api/import/status"]?.get && open.paths["/api/import/chats"]?.post);
  // The gate as the server states it.
  for (const path of ["/api/import/status", "/api/import/chats", "/API/IMPORT/x"])
    for (const method of ["GET", "POST"]) assert.deepEqual(featuresFor({ path, method, body: {} }), ["chatimport"], path);
  assert.ok(!featuresFor({ path: "/api/conversations", method: "GET", body: {} }).includes("chatimport"));
  assert.ok(!featuresFor({ path: "/api/important", method: "GET", body: {} }).includes("chatimport"), "only /api/import itself");
});

test("the workspace keeps Import chats out of sight until it's released; its code loads only on its page", () => {
  const src = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(src, /\.filter\(\(\[id\]\) => id !== "import" \|\| isReleased\(config, "chatimport"\)\)/);
  assert.match(src, /mode === "import" && \(!config \|\| isReleased\(config, "chatimport"\)\)/);
  assert.match(src, /mode === "import" \? \(\s*isReleased\(config, "chatimport"\) &&/);
  assert.match(src, /const ChatImport = lazy\(\(\) => import\("\.\/ChatImport\.jsx"\)\)/);
  // The mark and the banner only once released.
  assert.match(src, /const importedFrom = !demo && isReleased\(config, "chatimport"\)/);
  // The server copies the shared module it imports.
  assert.match(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"), /src\/chat-import\.js/);
  // It is found by intent, in both languages, and by name.
  const entries = [["import", "Import chats", "Bring your ChatGPT or Claude history here."], ["sheets", "Sheets", "Explore spreadsheet data."], ["notes", "Meeting notes", "Turn a recording into notes."]];
  for (const q of ["chatgpt", "move my old chats", "import", "导入聊天", "migrate from claude"]) assert.equal(rankTools(entries, q)[0]?.[0], "import", q);
  assert.notEqual(rankTools(entries, "import csv")[0]?.[0], "import", "a spreadsheet import still finds Sheets");
});

// ---- Saving to the account ----

test("chosen chats become ordinary saved chats, marked as imported, with their own dates and words", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const res = (await send(a, "chatgpt", [chat(1), chat(2)]).expect(200)).body;
  assert.deepEqual(res.skipped, []);
  assert.equal(res.saved.length, 2);
  assert.match(res.saved[0].id, /^c_/);
  // Listed like any chat, newest first by the chat's own date, and marked.
  const list = (await a.agent.get("/api/conversations").expect(200)).body.data;
  assert.deepEqual(list.map((c) => [c.title, c.imported_from, c.mode]), [["Imported chat 2", "chatgpt", "chat"], ["Imported chat 1", "chatgpt", "chat"]]);
  assert.equal(list[1].created, Date.UTC(2024, 0, 2));
  assert.equal(list[1].updated, Date.UTC(2024, 0, 3));
  // Opened like any chat: words as written, in order, uncharged.
  const opened = (await a.agent.get("/api/conversations/" + res.saved[0].id).expect(200)).body;
  assert.equal(opened.imported_from, "chatgpt");
  assert.deepEqual(opened.messages.map((m) => [m.role, m.content.text ?? m.content, m.credits]), [["user", "question 1", 0], ["assistant", "answer 1", 0]]);
  assert.deepEqual(opened.messages.map((m) => m.created), [Date.UTC(2024, 0, 2, 9), Date.UTC(2024, 0, 2, 9, 1)]);
  assert.equal(opened.messages[1].model, null);
  assert.equal(s.db.prepare("SELECT COALESCE(SUM(cost),0) n FROM messages").get().n, 0);
  // Nothing was held or charged: no model was called.
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds WHERE user_id=?").get(a.user.id).n, 0);
  // It works as a chat: it can be renamed, exported and searched.
  await a.agent.patch("/api/conversations/" + res.saved[0].id).send({ title: "Renamed" }).expect(200);
  const exported = (await a.agent.get("/api/conversations/export").expect(200)).body.conversations;
  assert.equal(exported.length, 2);
  // Marked as coming from Claude works the same.
  const claude = (await send(a, "claude", [chat(3, { source_id: "same-id-other-service" })]).expect(200)).body;
  assert.equal(claude.saved.length, 1);
  assert.equal((await a.agent.get("/api/conversations/" + claude.saved[0].id).expect(200)).body.imported_from, "claude");
});

test("another account sees none of it, and a repeat of the same chat is skipped, not duplicated", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const b = await person(s.app, "ben");
  const first = (await send(a, "chatgpt", [chat(1), chat(2)]).expect(200)).body;
  await a.agent.get("/api/conversations/" + first.saved[0].id).expect(200);
  await b.agent.get("/api/conversations/" + first.saved[0].id).expect(404);
  assert.deepEqual((await b.agent.get("/api/conversations").expect(200)).body.data, []);
  assert.deepEqual((await b.agent.get("/api/import/status").expect(200)).body.imported, { chatgpt: [], claude: [] });
  // The same export again: everything is recognised; a new one is added.
  const again = (await send(a, "chatgpt", [chat(1), chat(2), chat(3)]).expect(200)).body;
  assert.deepEqual(again.skipped, [{ index: 0, reason: "already_imported" }, { index: 1, reason: "already_imported" }]);
  assert.deepEqual(again.saved.map((x) => x.index), [2]);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(a.user.id).n, 3);
  // The same id from the other service is a different chat; another account may import the same one.
  assert.equal((await send(a, "claude", [chat(1)]).expect(200)).body.saved.length, 1);
  assert.equal((await send(b, "chatgpt", [chat(1)]).expect(200)).body.saved.length, 1);
  // Deleting an imported chat lets it be imported again.
  await a.agent.delete("/api/conversations/" + first.saved[0].id).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM chat_imports WHERE conversation_id=?").get(first.saved[0].id).n, 0);
  const status = (await a.agent.get("/api/import/status").expect(200)).body;
  assert.deepEqual(status.imported.chatgpt.sort(), ["src-2", "src-3"]);
  assert.equal((await send(a, "chatgpt", [chat(1)]).expect(200)).body.saved.length, 1);
  // A chat with no export id is never treated as a repeat.
  const bare = { ...chat(9), source_id: undefined };
  assert.equal((await send(a, "chatgpt", [bare]).expect(200)).body.saved.length, 1);
  assert.equal((await send(a, "chatgpt", [bare]).expect(200)).body.saved.length, 1);
});

test("Seed Guard: a chat with a seed phrase or key is skipped unless that chat is allowed; only when the update is live", async (t) => {
  const guarded = fixture(t, "mvp,chatimport,seedguard");
  const a = await person(guarded.app, "ana");
  const seedChat = chat(1, { messages: [{ role: "user", text: "my test phrase: " + ABANDON_12, created: 1 }, { role: "assistant", text: "ok", created: 2 }] });
  const keyChat = chat(2, { messages: [{ role: "user", text: "the key " + WIF, created: 1 }, { role: "assistant", text: "ok", created: 2 }] });
  const titled = chat(3, { title: ABANDON_12 });
  const hexOnly = chat(4, { messages: [{ role: "user", text: "commit " + sha("hash").toString("hex"), created: 1 }, { role: "assistant", text: "ok", created: 2 }] });
  const res = (await send(a, "chatgpt", [seedChat, keyChat, titled, hexOnly, chat(5)]).expect(200)).body;
  assert.deepEqual(res.skipped, [0, 1, 2].map((index) => ({ index, reason: "seed_phrase_blocked" })));
  assert.deepEqual(res.saved.map((x) => x.index), [3, 4], "the other chats in the request are saved; a bare hash is not a key");
  assert.equal(guarded.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(a.user.id).n, 2);
  // Nothing about the finding was kept: no row, no trace of the words.
  const raw = guarded.db.prepare("SELECT group_concat(content) c FROM messages").get().c;
  assert.ok(!raw.includes("abandon"));
  // Allowed for one chat, the second confirm having happened in the page.
  const allowed = (await send(a, "chatgpt", [{ ...seedChat, allow_seed_phrase: true }, keyChat]).expect(200)).body;
  assert.deepEqual(allowed.saved.map((x) => x.index), [0]);
  assert.deepEqual(allowed.skipped, [{ index: 1, reason: "seed_phrase_blocked" }]);
  // Not live: nothing is checked.
  const open = fixture(t, "mvp,chatimport");
  const b = await person(open.app, "ben");
  assert.equal((await send(b, "chatgpt", [seedChat, keyChat]).expect(200)).body.saved.length, 2);
  assert.equal((await b.agent.get("/api/import/status").expect(200)).body.seed_guard, false);
  assert.equal((await a.agent.get("/api/import/status").expect(200)).body.seed_guard, true);
});

test("the account's chat cap is never pruned by an import: chats that don't fit are skipped and nothing is deleted", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const cap = (await a.agent.get("/api/import/status").expect(200)).body.cap;
  assert.equal(cap, 300);
  const t0 = now();
  const insert = s.db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)");
  for (let i = 0; i < 298; i++) insert.run(uid("c_"), a.user.id, "own " + i, "chat", t0 - i, t0 - i);
  // Symposium runs have their own cap and aren't counted.
  insert.run(uid("c_"), a.user.id, "run", "symposium", t0, t0);
  const status = (await a.agent.get("/api/import/status").expect(200)).body;
  assert.deepEqual([status.have, status.room], [298, 2]);
  const res = (await send(a, "chatgpt", [chat(1), chat(2), chat(3), chat(4)]).expect(200)).body;
  assert.deepEqual(res.saved.map((x) => x.index), [0, 1]);
  assert.deepEqual(res.skipped, [{ index: 2, reason: "conversation_limit" }, { index: 3, reason: "conversation_limit" }]);
  assert.equal(res.room, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=? AND title LIKE 'own %'").get(a.user.id).n, 298, "no chat of theirs was removed");
  assert.equal((await a.agent.get("/api/import/status").expect(200)).body.room, 0);
});

test("the account's auto-delete default applies to imported chats", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  await a.agent.put("/api/retention").send({ days: 7 }).expect(200);
  assert.equal((await a.agent.get("/api/import/status").expect(200)).body.retention_days, 7);
  const res = (await send(a, "claude", [chat(1)]).expect(200)).body;
  const row = s.db.prepare("SELECT expires FROM conversations WHERE id=?").get(res.saved[0].id);
  assert.ok(Math.abs(row.expires - (now() + 7 * 86400000)) < 60000);
  const plain = await person(s.app, "pat");
  assert.equal((await plain.agent.get("/api/import/status").expect(200)).body.retention_days, null);
  const kept = (await send(plain, "claude", [chat(1)]).expect(200)).body;
  assert.equal(s.db.prepare("SELECT expires FROM conversations WHERE id=?").get(kept.saved[0].id).expires, null);
});

test("what the route accepts: sources, sizes, shapes and cleaning", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const bad = async (body, status, code) => {
    const res = await a.agent.post("/api/import/chats").send(body).expect(status);
    assert.equal(res.body.error.code, code, JSON.stringify(body).slice(0, 80));
  };
  await bad({ chats: [chat(1)] }, 400, "invalid_request");
  await bad({ source: "gemini", chats: [chat(1)] }, 400, "invalid_request");
  await bad({ source: "chatgpt" }, 400, "invalid_request");
  await bad({ source: "chatgpt", chats: [] }, 400, "invalid_request");
  await bad({ source: "chatgpt", chats: Array.from({ length: MAX_CHATS_PER_REQUEST + 1 }, (_, i) => chat(i)) }, 400, "invalid_request");
  await bad({ source: "chatgpt", chats: [{ ...chat(1), messages: [{ role: "user", text: "x".repeat(MAX_MESSAGE_CHARS) }] }, { ...chat(2), messages: [{ role: "user", text: "x".repeat(MAX_MESSAGE_CHARS) }] }, ...Array.from({ length: 4 }, (_, i) => ({ ...chat(3 + i), messages: Array.from({ length: 5 }, () => ({ role: "user", text: "y".repeat(MAX_MESSAGE_CHARS) })) }))] }, 413, "import_too_large");
  assert.ok(MAX_REQUEST_CHARS < 6 * 5 * MAX_MESSAGE_CHARS);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  // Per chat: skipped with a reason, the rest saved.
  const res = (
    await send(a, "chatgpt", [
      null,
      "text",
      { title: "no messages" },
      { title: "empty", messages: [] },
      { title: "blank", messages: [{ role: "user", text: "   " }] },
      { title: "role", messages: [{ role: "system", text: "x" }] },
      { title: "text", messages: [{ role: "user", text: 5 }] },
      { title: "id", source_id: "x".repeat(101), messages: [{ role: "user", text: "hi" }] },
      { title: "long", messages: [{ role: "user", text: "x".repeat(MAX_MESSAGE_CHARS + 1) }] },
      { title: "many", messages: Array.from({ length: MAX_MESSAGES_PER_CHAT + 1 }, () => ({ role: "user", text: "x" })) },
      chat(1),
    ]).expect(200)
  ).body;
  assert.deepEqual(
    res.skipped.map((x) => [x.index, x.reason]),
    [[0, "invalid"], [1, "invalid"], [2, "invalid"], [3, "empty"], [4, "empty"], [5, "invalid"], [6, "invalid"], [7, "invalid"], [8, "too_large"], [9, "too_large"]],
  );
  assert.deepEqual(res.saved.map((x) => x.index), [10]);
  // Cleaning: a long title is cut at 70 characters, control characters go, blank
  // messages are dropped, times are never in the future or out of order.
  const future = Date.now() + 5 * 86400000;
  const cleaned = (
    await send(a, "claude", [
      {
        title: "  A\u0000 title\nwith   breaks " + "x".repeat(100),
        created: future,
        messages: [
          { role: "user", text: "first\r\nline", created: 5000 },
          { role: "assistant", text: "  ", created: 6000 },
          { role: "assistant", text: "second", created: 1000 },
          { role: "user", text: "third", created: future },
        ],
      },
    ]).expect(200)
  ).body;
  const row = s.db.prepare("SELECT * FROM conversations WHERE id=?").get(cleaned.saved[0].id);
  assert.equal(row.title.length, 70);
  assert.ok(row.title.startsWith("A title with breaks x"));
  assert.ok(row.created <= now() && row.updated <= now());
  const msgs = s.db.prepare("SELECT role,content,created FROM messages WHERE conversation_id=? ORDER BY created,rowid").all(cleaned.saved[0].id);
  assert.deepEqual(msgs.map((m) => [m.role, JSON.parse(m.content).text ?? JSON.parse(m.content)]), [["user", "first\nline"], ["assistant", "second"], ["user", "third"]]);
  assert.ok(msgs.every((m, i) => i === 0 || m.created >= msgs[i - 1].created));
  assert.ok(msgs.every((m) => m.created <= now()));
  // Requests need a signed-in account.
  await request(s.app).post("/api/import/chats").send({ source: "chatgpt", chats: [chat(1)] }).expect(401);
});

test("nothing about an import is logged", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const written = [];
  const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const name of Object.keys(keep)) console[name] = (...args) => written.push(args.map(String).join(" "));
  try {
    await send(a, "chatgpt", [chat(1, { title: "Secret title marker", messages: [{ role: "user", text: "secret words marker", created: 1 }] }), { messages: "bad" }]).expect(200);
    await a.agent.post("/api/import/chats").send({ source: "nope", chats: [] }).expect(400);
    await a.agent.post("/api/import/chats").send({ source: "chatgpt", chats: [chat(2, { title: "Another title marker" })].concat(Array(MAX_CHATS_PER_REQUEST)) }).expect(400);
  } finally {
    Object.assign(console, keep);
  }
  const log = written.join("\n");
  assert.ok(!log.includes("marker") && !log.includes("src-1"), log.slice(0, 200));
});

test("imported chats are in the account export, and account closure and Panic Wipe erase them", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const saved = (await send(a, "chatgpt", [chat(1), chat(2)]).expect(200)).body.saved;
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  const mine = exported.conversations.find((c) => c.id === saved[0].id);
  assert.equal(mine.imported_from.source, "chatgpt");
  assert.equal(mine.imported_from.source_id, "src-1");
  assert.ok(Number.isInteger(mine.imported_from.imported));
  assert.deepEqual(mine.messages.map((m) => m.role), ["user", "assistant"]);
  assert.ok(exported.conversations.every((c) => c.id !== undefined));
  // An ordinary chat's export is unchanged.
  const plain = uid("c_");
  s.db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)").run(plain, a.user.id, "plain", "chat", 1, 1);
  const again = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.ok(!("imported_from" in again.conversations.find((c) => c.id === plain)));
  // Panic Wipe.
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM chat_imports WHERE user_id=?").get(a.user.id).n, 2);
  await a.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM chat_imports WHERE user_id=?").get(a.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(a.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
  // Account closure.
  const b = await person(s.app, "ben");
  await send(b, "claude", [chat(1)]).expect(200);
  await b.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM chat_imports WHERE user_id=?").get(b.user.id).n, 0);
  // Cap pruning and "delete all" take the marks with the chats.
  const c = await person(s.app, "cyd");
  await send(c, "claude", [chat(1), chat(2)]).expect(200);
  await c.agent.delete("/api/conversations").expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM chat_imports WHERE user_id=?").get(c.user.id).n, 0);
  // Before release an account with none exports no import marks at all.
  const mvp = fixture(t, "mvp");
  const e = await person(mvp.app, "eve");
  assert.ok(!JSON.stringify((await e.agent.get("/api/account/export").expect(200)).body.conversations).includes("imported_from"));
});

test("imported chats behave as ordinary chats: bookmarks, sharing and search reach them", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const saved = (await send(a, "chatgpt", [chat(1)]).expect(200)).body.saved[0];
  const opened = (await a.agent.get("/api/conversations/" + saved.id).expect(200)).body;
  const star = await a.agent.post("/api/bookmarks").send({ message_id: opened.messages[1].id, note: "keep" }).expect(201);
  assert.equal(star.body.conversation_id, saved.id);
  const shared = await a.agent.post("/api/shares").send({ conversationId: saved.id }).expect(201);
  assert.ok(shared.body.token || shared.body.url || shared.body.id);
  const found = (await a.agent.get("/api/history/search").query({ q: "answer 1" }).expect(200)).body;
  assert.ok(JSON.stringify(found).includes(saved.id));
});

// ---- Words for the language switch ----

test("every string the update adds has a Chinese translation", () => {
  const dict = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
  const compiled = compileDictionary(dict);
  const entry = UPDATES.find((u) => u.id === "chatimport");
  for (const text of [entry.title, entry.tagline, ...entry.points])
    assert.match(translateText(text, compiled) || "", /\p{Script=Han}/u, text);
  for (const text of [
    "Import chats",
    "Choose your export",
    "Device Vault",
    "Your account",
    "Markdown files",
    "Recommended",
    "Select all",
    "Select none",
    "Import anyway…",
    "Yes, import it",
    "Seed Guard: allowed",
    "Already imported",
    "Import more from this file",
    "1 chat found",
    "5 chats found",
    "12 of 340 chats selected.",
    "Import 1 chat",
    "Import 7 chats",
    "Download 3 chats as Markdown",
    "3 chats saved to your account",
    "2 held back by Seed Guard",
    "Imported from ChatGPT",
    "Imported from Claude",
    "Show all 120 chats",
    "Written in",
    "Stopped.",
    "3 done; 2 not imported.",
    "ChatGPT export",
    "Import chats",
    "Your auto-delete setting of 7 days applies to imported chats too.",
    "Your account keeps up to 300 saved chats and has room for 212 more. Older chats are removed first as you add new ones.",
    "The ZIP from ChatGPT or Claude, or the conversations.json inside it. Up to 200 MB.",
    "This isn't a ChatGPT or Claude export. Choose the ZIP you were sent, or the conversations.json inside it.",
    "No ChatGPT chats with text were found in this file.",
  ])
    assert.match(translateText(text, compiled) || "", /\p{Script=Han}/u, text);
});
