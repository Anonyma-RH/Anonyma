import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultUrlTransform } from "react-markdown";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { messageFromServer } from "../src/lib.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  CHAT_EXPORT_FORMAT,
  CHAT_EXPORT_SCHEMA,
  CHAT_EXPORT_VERSION,
  EXPORT_LABELS,
  EXPORT_TYPES,
  SCREEN_NOTES,
  buildChatExport,
  cleanCitations,
  escapeInline,
  exportFilename,
  exportJSON,
  exportMarkdown,
  exportMessage,
  exportPlan,
  parseMarkdown,
  receiptLabel,
  restorableCount,
  safeMarkdown,
  speaker,
} from "../src/chat-export.js";

// Chat Export (update "chatexport"): the file formats, Markdown safety,
// Veil, placeholders, where messages come from (the conversation read, or
// the screen for chats that were never saved), access through that read,
// the release gate, the dialog and print page, and the Chinese copy.

// Release commits flip `released` on UPDATES entries; these tests cover the
// gate itself, so every update is pinned unreleased for this file.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// Local times in the Markdown and print page are pinned to UTC here.
process.env.TZ = "UTC";

const MODEL = "google/gemini-2.5-flash";
const src = (path) =>
  readFileSync(new URL("../" + path, import.meta.url), "utf8");
const han = /\p{Script=Han}/u;
const zh = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
const T0 = Date.UTC(2026, 8, 21, 9, 30);
const MIN = 60000;
const DAY = () => 86400000;

function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-chat-export-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...(released === "all" ? {} : { mvpModels: [MODEL] }),
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(s, username) {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor % 250}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const events = (text) =>
  text
    .split("\n\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)));
async function say(agent, content, extra = {}) {
  const r = await agent
    .post("/api/chat")
    .send({
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens: 50,
      ...extra,
    })
    .expect(200);
  return events(r.text);
}
// What the workspace keeps on screen for a streamed reply (Workspace.jsx's
// send handler): the text, the model, the request id and, once the final
// event arrives, what it charged.
function onScreen(list, model, requestId) {
  let content = "",
    credits = null;
  for (const e of list) {
    content += e.choices?.[0]?.delta?.content || "";
    if (e.anonyma?.credits_charged != null) credits = e.anonyma.credits_charged;
  }
  return {
    role: "assistant",
    content,
    model,
    requestId,
    ...(credits != null ? { credits } : {}),
  };
}
// The dialog's one request for a saved conversation, and the messages as
// the workspace holds them.
async function read(agent, id) {
  const r = await agent.get("/api/conversations/" + id);
  return r.status === 200
    ? {
        status: 200,
        ...r.body,
        messages: r.body.messages.map(messageFromServer),
      }
    : { status: r.status, error: r.body.error };
}
const docFor = (chat, user, options = {}) =>
  buildChatExport({
    conversation: {
      id: chat.id,
      title: chat.title,
      mode: chat.mode,
      collab: chat.collab || null,
    },
    messages: chat.messages,
    userId: user.id,
    username: user.username,
    ...options,
  });

// A small JSON Schema check (type, const, enum, required, properties,
// additionalProperties, items, oneOf): enough for CHAT_EXPORT_SCHEMA.
function schemaErrors(s, v, p = "$") {
  const out = [];
  const kind = v === null ? "null" : Array.isArray(v) ? "array" : typeof v;
  if (s.oneOf) {
    const passing = s.oneOf.filter(
      (alt) => !schemaErrors(alt, v, p).length,
    ).length;
    if (passing !== 1) out.push(`${p}: matches ${passing} of oneOf`);
    return out;
  }
  if ("const" in s && v !== s.const)
    out.push(`${p}: expected ${JSON.stringify(s.const)}`);
  if (s.enum && !s.enum.includes(v))
    out.push(`${p}: ${JSON.stringify(v)} not in enum`);
  if (s.type) {
    const types = [].concat(s.type);
    const ok = types.some(
      (t) =>
        t === kind ||
        (t === "integer" && Number.isInteger(v)) ||
        (t === "number" && kind === "number"),
    );
    if (!ok) return [...out, `${p}: expected ${types.join("|")}, got ${kind}`];
  }
  if (kind === "object") {
    for (const r of s.required || [])
      if (!(r in v)) out.push(`${p}.${r}: missing`);
    for (const [k, val] of Object.entries(v)) {
      if (s.properties?.[k])
        out.push(...schemaErrors(s.properties[k], val, `${p}.${k}`));
      else if (s.additionalProperties === false)
        out.push(`${p}.${k}: not allowed`);
    }
  }
  if (kind === "array" && s.items)
    v.forEach((x, i) => out.push(...schemaErrors(s.items, x, `${p}[${i}]`)));
  return out;
}

// A saved personal chat as the workspace holds it after messageFromServer.
const ME = { id: "u_me", username: "ana_k" };
function sampleChat() {
  return {
    id: "c_trip",
    title: "Lisbon trip for [EMAIL_1]",
    mode: "chat",
    messages: [
      {
        id: "m1",
        role: "user",
        author: "ana_k",
        author_id: "u_me",
        created: T0,
        content:
          'Plan three days in Lisbon and send it to [EMAIL_1].\n\n<document name="itinerary [NAME_1].pdf" pages="2">TOP SECRET DOCUMENT BODY</document>',
        images: ["data:image/png;base64,AAAA"],
        credits: 0,
        cost: 0,
      },
      {
        id: "m2",
        role: "assistant",
        author_id: "u_me",
        created: T0 + 2 * MIN,
        model: "claude-opus-5.5",
        content:
          "## Day 1\n\nStart in **Alfama**. Book at [the site](https://example.com/book).",
        requestId: "req_day_plan",
        credits: 0.0421,
        cost: 421,
        citations: [
          { url: "https://visitlisboa.example/alfama", title: "Alfama guide" },
          { url: "javascript:alert(1)", title: "bad" },
          { url: "https://visitlisboa.example/alfama", title: "duplicate" },
        ],
        privacy: { receipt_id: "req_day_plan" },
      },
      {
        id: "m3",
        role: "user",
        author: "ana_k",
        author_id: "u_me",
        created: T0 + 30 * MIN,
        content: "Now a packing list.",
        credits: 0,
      },
      {
        id: "m4",
        role: "assistant",
        author_id: "u_me",
        created: T0 + 31 * MIN,
        model: "gpt-6-sol",
        content: "- Shoes\n- Hat",
        requestId: "req_packing",
        credits: 0.01,
        images: ["https://media.example/generated.png"],
      },
    ],
  };
}
const NAMES = {
  "claude-opus-5.5": "Claude Opus 5.5",
  "gpt-6-sol": "GPT-6 Sol",
};
const modelName = (id) => NAMES[id] || id;

// ---- The release gate ----------------------------------------------------

test("registered last and unreleased; off under the MVP, on by id or all", async (t) => {
  const entry = UPDATES.find((u) => u.id === "chatexport");
  assert.ok(entry, "registered in UPDATES");
  assert.ok(
    UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "routines"),
    "added after the releases before it",
  );
  assert.equal(
    committed[UPDATES.indexOf(entry)],
    true,
    "released by its release commit",
  );
  assert.equal(entry.title, "Chat Export");
  assert.equal(entry.points.length, 3);
  for (const [released, on] of [
    ["mvp", false],
    ["mvp,chatexport", true],
    ["all", true],
  ]) {
    const s = fixture(t, released);
    const config = (await request(s.app).get("/api/config").expect(200)).body;
    assert.equal(config.releases.features.chatexport, on, released);
    assert.equal(
      config.releases.updates.find((u) => u.id === "chatexport").released,
      on,
      released,
    );
  }
});

test("browser only: no route, gate or API contract; the dialog's one request is the conversation read", async (t) => {
  for (const [path, method] of [
    ["/api/conversations/c_1", "GET"],
    ["/api/conversations/c_1/export", "GET"],
    ["/api/history/search", "GET"],
    ["/api/chat", "POST"],
  ])
    assert.ok(
      !featuresFor({ path, method, body: {} }).includes("chatexport"),
      path,
    );
  for (const f of readdirSync(new URL("../server/routes/", import.meta.url)))
    assert.doesNotMatch(
      src("server/routes/" + f),
      /chatexport|chat-export/i,
      f,
    );
  assert.doesNotMatch(src("server/app.js"), /chatexport|chat-export/i);
  const s = fixture(t, "all");
  const contract = (await request(s.app).get("/api/openapi.json").expect(200))
    .body;
  assert.doesNotMatch(
    JSON.stringify(contract.paths),
    /chatexport|chat-export|\/export\?format/i,
  );
  // Under the MVP the conversation read it relies on is open as before.
  const mvp = fixture(t, "mvp");
  const { agent } = await person(mvp, "gate_reader");
  const id = (await say(agent, "hello")).find((e) => e.anonyma)?.conversationId;
  assert.equal((await read(agent, id)).status, 200);
  // The builder can't reach the network; the dialog makes exactly one
  // request, the conversation read, and never sends anything.
  const lib = src("src/chat-export.js");
  for (const call of [
    /\bapi\(/,
    /\bfetch\(/,
    /streamChat/,
    /XMLHttpRequest/,
    /sendBeacon/,
    /WebSocket/,
  ])
    assert.doesNotMatch(lib, call, `chat-export.js: ${call}`);
  const jsx = src("src/ChatExport.jsx");
  assert.equal(jsx.match(/\bapi\(/g).length, 1);
  assert.match(
    jsx,
    /api\("\/api\/conversations\/" \+ encodeURIComponent\(target\.id\), \{\s*signal: ctl\.signal,?\s*\}\)/,
  );
  for (const call of [
    /\bfetch\(/,
    /streamChat/,
    /method:/,
    /XMLHttpRequest/,
    /sendBeacon/,
    /WebSocket/,
  ])
    assert.doesNotMatch(jsx, call, `ChatExport.jsx: ${call}`);
  // A chat that was never saved is exported without that request.
  assert.match(jsx, /if \(screen\) return;/);
});

test("the workspace and History wire Export behind the release, and keep the old export without it", () => {
  const ws = src("src/Workspace.jsx");
  assert.match(
    ws,
    /const exportLive = !demo && !!user && chatExportReleased\(config\);/,
  );
  assert.match(
    ws,
    /\{exportLive && textMode && messages\.length > 0 && \(\s*<button[^>]*?\s+className="chat-export-open"/,
  );
  assert.match(ws, /disabled=\{busy\}\s+onClick=\{openExport\}/);
  assert.match(ws, /\{exporting && exportLive && \(\s*<ExportDialog/);
  // The plan decides the source: never-saved chats pass what's on screen.
  assert.match(
    ws,
    /exportPlan\(\{ id: current, ephemeral, privateMode, deviceOnly \}\)/,
  );
  assert.match(
    ws,
    /messages: plan\.source === "screen" \? messages : undefined/,
  );
  // Veil's map is copied from this browser; it's only used to restore.
  assert.match(ws, /veilMap: \{ \.\.\.veilStateRef\.current\.map \}/);
  assert.match(ws, /veilMap: loadVeilState\(c\.id\)\.map/);
  // The conversation details dialog keeps its old download until release.
  assert.match(
    ws,
    /if \(!exportLive\)\s+return download\(\s+"conversation\.json",\s+JSON\.stringify\(dialog\.item, null, 2\),\s+\);/,
  );
  assert.match(ws, /onExport=\{exportLive \? exportSaved : null\}/);
  const lib = src("src/HistoryLibrary.jsx");
  assert.match(lib, /onExport = null,/);
  assert.match(lib, /return onExport \? \(/);
  assert.match(lib, /\{onExport && \(\s*<button/);
  // Replies on screen keep their charge, for unsaved chats' receipts.
  assert.match(
    ws,
    /if \(event\.anonyma\?\.credits_charged != null\) charged = event\.anonyma\.credits_charged;/,
  );
  assert.equal(
    ws.match(/\.\.\.\(charged != null \? \{ credits: charged \} : \{\}\)/g)
      .length,
    2,
  );
});

// ---- Formats ---------------------------------------------------------------

test("JSON: a versioned format that matches its documented schema", () => {
  assert.equal(CHAT_EXPORT_FORMAT, "anonyma.chat-export");
  assert.equal(CHAT_EXPORT_VERSION, 1);
  assert.equal(CHAT_EXPORT_SCHEMA.properties.version.const, 1);
  // The schema is written out in the module's header comment too.
  assert.match(
    src("src/chat-export.js"),
    /"format": "anonyma\.chat-export",\n\/\/   "version": 1,/,
  );
  const chat = sampleChat();
  const variants = [
    {},
    { receipts: true },
    { citations: false },
    {
      receipts: true,
      citations: true,
      restore: { EMAIL_1: "ana@example.com" },
      testMode: true,
    },
  ];
  for (const options of variants) {
    const doc = docFor(chat, ME, { modelName, now: T0 + DAY(), ...options });
    assert.deepEqual(
      schemaErrors(CHAT_EXPORT_SCHEMA, doc),
      [],
      JSON.stringify(options),
    );
    // What JSON.parse gives back is the same document.
    assert.deepEqual(JSON.parse(exportJSON(doc)), doc);
  }
  const doc = docFor(chat, ME, { modelName, now: T0 + DAY() });
  assert.equal(doc.format, CHAT_EXPORT_FORMAT);
  assert.equal(doc.version, 1);
  assert.equal(doc.exported_at, new Date(T0 + DAY()).toISOString());
  assert.deepEqual(doc.conversation, {
    id: "c_trip",
    title: "Lisbon trip for [EMAIL_1]",
    mode: "chat",
    saved: true,
    collab: null,
    started_at: new Date(T0).toISOString(),
    last_message_at: new Date(T0 + 31 * MIN).toISOString(),
  });
  assert.deepEqual(doc.options, {
    receipts: false,
    citations: true,
    veil_restored: false,
  });
  assert.deepEqual(doc.summary, {
    messages: 4,
    attachments: 3,
    masked_details: 2,
  });
  assert.equal("local_test" in doc, false);
  const [q, a] = doc.messages;
  assert.deepEqual(q, {
    role: "user",
    you: true,
    author: null,
    created_at: new Date(T0).toISOString(),
    text: "Plan three days in Lisbon and send it to [EMAIL_1].",
    attachments: [
      { type: "document", name: "itinerary [NAME_1].pdf", included: false },
      { type: "image", included: false },
    ],
  });
  assert.equal(a.model, "Claude Opus 5.5");
  assert.equal(a.model_id, "claude-opus-5.5");
  assert.equal(a.interrupted, false);
  // Receipts only when asked for; sources by default, web addresses only.
  assert.equal("receipt" in a, false);
  assert.deepEqual(a.citations, [
    { url: "https://visitlisboa.example/alfama", title: "Alfama guide" },
  ]);
  const withReceipts = docFor(chat, ME, {
    modelName,
    receipts: true,
    citations: false,
  });
  assert.deepEqual(withReceipts.messages[1].receipt, {
    credits_charged: 0.0421,
    id: "req_day_plan",
    signed: true,
  });
  assert.deepEqual(withReceipts.messages[3].receipt, {
    credits_charged: 0.01,
    id: "req_packing",
    signed: false,
  });
  assert.equal("citations" in withReceipts.messages[1], false);
  assert.deepEqual(EXPORT_TYPES.json, {
    extension: "json",
    type: "application/json;charset=utf-8",
  });
});

test("Markdown: title, dates, the model on every reply, placeholders; receipts and sources only when chosen", () => {
  const chat = sampleChat();
  const plain = exportMarkdown(
    docFor(chat, ME, { modelName, citations: false, now: T0 + DAY() }),
  );
  assert.ok(plain.startsWith("# Lisbon trip for \\[EMAIL\\_1\\]\n\n"));
  assert.match(plain, /^- Exported from ANONYMA: 2026-09-22 09:30$/m);
  assert.match(plain, /^- Conversation: 2026-09-21 09:30 – 2026-09-21 10:01$/m);
  assert.match(plain, /^- Messages: 4$/m);
  assert.match(plain, /^- Times are local \(UTC\+00:00\)$/m);
  assert.match(
    plain,
    /^- Masked details stay masked, shown as tags like \\\[EMAIL\\_1\\\]\.$/m,
  );
  assert.match(
    plain,
    /^- Attachments and images appear as placeholders; their contents aren't included\.$/m,
  );
  // One heading per message, the reply's model name on each reply.
  assert.deepEqual(plain.match(/^## .* · .*$/gm), [
    "## You · 2026-09-21 09:30",
    "## Claude Opus 5.5 · 2026-09-21 09:32",
    "## You · 2026-09-21 10:00",
    "## GPT-6 Sol · 2026-09-21 10:01",
  ]);
  // The reply's own Markdown is kept as written (its own headings too).
  assert.match(plain, /^## Day 1$/m);
  assert.match(
    plain,
    /Start in \*\*Alfama\*\*\. Book at \[the site\]\(https:\/\/example\.com\/book\)\./,
  );
  assert.match(
    plain,
    /^\*Attached document: itinerary \\\[NAME\\_1\\\]\.pdf \(its text isn't included in this export\)\*$/m,
  );
  assert.equal(
    plain.match(/^\*Image \(not included in this export\)\*$/gm).length,
    2,
  );
  assert.doesNotMatch(plain, /Sources|Receipt/);
  assert.doesNotMatch(plain, /TOP SECRET|data:image|media\.example/);
  const full = exportMarkdown(
    docFor(chat, ME, { modelName, receipts: true, citations: true }),
  );
  assert.match(
    full,
    /^\*\*Sources\*\*\n\n1\. \[Alfama guide\]\(<https:\/\/visitlisboa\.example\/alfama>\)$/m,
  );
  assert.doesNotMatch(full, /javascript:/);
  assert.match(
    full,
    /^\*Receipt · 0\.0421 credits charged · Receipt ID req\\_day\\_plan · Signed\*$/m,
  );
  assert.match(
    full,
    /^\*Receipt · 0\.01 credits charged · Receipt ID req\\_packing\*$/m,
  );
  // Local test mode says its credits are fixtures.
  const test = exportMarkdown(
    docFor(chat, ME, { modelName, receipts: true, testMode: true }),
  );
  assert.match(test, /^- Local test mode: receipts show fixture credits\.$/m);
  assert.match(
    test,
    /^\*Test receipt · 0\.0421 fixture credits charged · Receipt ID/m,
  );
  assert.deepEqual(EXPORT_TYPES.markdown, {
    extension: "md",
    type: "text/markdown;charset=utf-8",
  });
  // An interrupted reply says so, and a missing model reads "Assistant".
  const cut = exportMarkdown(
    buildChatExport({
      conversation: { id: "c_x", title: "Cut" },
      messages: [
        { role: "assistant", content: "Half an ans", interrupted: true },
      ],
    }),
  );
  assert.match(cut, /^## Assistant$/m);
  assert.match(cut, /^\*Reply interrupted\.\*$/m);
});

test("Markdown safety: raw HTML and unsafe links can't run, open code can't swallow the file, code stays verbatim", () => {
  const hostile = [
    "<script>alert(1)</script>",
    'Hi <img src=x onerror="alert(2)"> there <b>bold</b>',
    "<div>\n    # not a heading\n\n    <iframe src=https://evil.example></iframe>\n</div>",
    "<!-- open comment that never closes\n\n# still inside",
    "[click](javascript:alert(3)) and <javascript:alert(4)> and ![pic](data:text/html,x) and [ref][evil]\n\n[evil]: vbscript:msgbox",
    'Inline `<code>` stays and so does\n\n```html\n<div onclick="x()">kept</div>\n```',
    "An answer cut off mid-code:\n\n```js\nconst a = '<b>';\n",
    "~~~~python\nprint('<x>')\n~~~",
    "- a list\n  ```\n  nested and open\n<script>alert(5)</script>",
  ];
  const doc = buildChatExport({
    conversation: {
      id: "c_h",
      title: "<script>alert('title')</script> [x](javascript:y)",
    },
    messages: hostile.flatMap((content, i) => [
      { role: "user", content: "Question " + i },
      { role: "assistant", content, model: "m <b>" },
    ]),
  });
  const md = exportMarkdown(doc);
  const tree = parseMarkdown(md);
  const nodes = [];
  (function walk(n) {
    nodes.push(n);
    (n.children || []).forEach(walk);
  })(tree);
  // Nothing in the file parses as raw HTML, and every link or image is one
  // the chat itself would follow.
  assert.deepEqual(
    nodes.filter((n) => n.type === "html"),
    [],
  );
  for (const n of nodes.filter((n) =>
    ["link", "image", "definition"].includes(n.type),
  ))
    assert.notEqual(defaultUrlTransform(n.url), "", n.url);
  // The structure survives: the title, then one heading per message at the
  // top level, whatever the messages held.
  const headings = tree.children.filter((n) => n.type === "heading");
  assert.equal(headings.filter((h) => h.depth === 1).length, 1);
  assert.equal(
    tree.children.filter(
      (n) =>
        n.type === "heading" &&
        n.depth === 2 &&
        /^(You|m <b>)$/.test(n.children.map((c) => c.value).join("")),
    ).length,
    hostile.length * 2,
  );
  // Code and inline code keep their text exactly.
  const code = nodes.filter((n) => n.type === "code").map((n) => n.value);
  assert.ok(code.includes('<div onclick="x()">kept</div>'));
  assert.ok(code.includes("const a = '<b>';"));
  // A longer opening fence isn't closed by a shorter one: that line is code.
  assert.ok(code.includes("print('<x>')\n~~~"));
  assert.ok(nodes.some((n) => n.type === "inlineCode" && n.value === "<code>"));
  // Raw HTML reads as the chat shows it: as text.
  const text = nodes
    .filter((n) => n.type === "text")
    .map((n) => n.value)
    .join(" ");
  assert.match(text, /<script>alert\(1\)<\/script>/);
  assert.match(text, /<img src=x onerror="alert\(2\)">/);
  // Unsafe links keep only their words.
  assert.match(text, /click/);
  assert.doesNotMatch(md, /javascript:alert\(3\)|data:text|vbscript/);
  // Unit cases.
  assert.equal(safeMarkdown("```\nopen"), "```\nopen\n```");
  assert.equal(
    safeMarkdown("````md\n```\ninner\n```\n"),
    "````md\n```\ninner\n```\n````",
  );
  assert.equal(safeMarkdown("```\nclosed\n```"), "```\nclosed\n```");
  assert.equal(safeMarkdown("~~~\nx\n~~~~"), "~~~\nx\n~~~~");
  assert.equal(safeMarkdown("a < b and c > d"), "a < b and c > d");
  assert.equal(
    safeMarkdown("[ok](https://example.com) [rel](/docs)"),
    "[ok](https://example.com) [rel](/docs)",
  );
  assert.equal(safeMarkdown("   "), "");
  assert.equal(
    escapeInline("a *b* [c](d) <e> #f `g` _h_ |i| ~j~ &k;"),
    "a \\*b\\* \\[c\\]\\(d\\) \\<e\\> \\#f \\`g\\` \\_h\\_ \\|i\\| \\~j\\~ \\&k;",
  );
});

test("placeholders: document names and image counts, never their contents", () => {
  const chat = sampleChat();
  for (const options of [
    {},
    { receipts: true },
    { restore: { NAME_1: "Ana" } },
  ]) {
    const doc = docFor(chat, ME, { modelName, ...options });
    const files = [exportJSON(doc), exportMarkdown(doc)];
    for (const file of files) {
      assert.doesNotMatch(file, /TOP SECRET DOCUMENT BODY/);
      assert.doesNotMatch(file, /<document/);
      assert.doesNotMatch(file, /data:image|AAAA|media\.example/);
    }
  }
  // A prompt that was only a document still exports, as its placeholder.
  const only = exportMessage({
    role: "user",
    content: '<document name="a.csv">1,2</document>',
  });
  assert.deepEqual(only, {
    role: "user",
    you: true,
    author: null,
    created_at: null,
    text: "",
    attachments: [{ type: "document", name: "a.csv", included: false }],
  });
  // An image-only reply keeps its placeholder; an empty reply is skipped.
  assert.equal(
    exportMessage({ role: "assistant", content: "", images: ["x", "y"] })
      .attachments.length,
    2,
  );
  assert.equal(exportMessage({ role: "assistant", content: "  " }), null);
  assert.equal(exportMessage({ role: "system", content: "x" }), null);
  assert.equal(
    exportMessage({ role: "assistant", content: "demo", sample: true }),
    null,
  );
  // Source links: web addresses only, no duplicates.
  assert.deepEqual(
    cleanCitations([
      { url: "ftp://x.example/a" },
      { url: "https://a.example/?q=1", title: "  A\n title " },
      { url: "not a url" },
    ]),
    [{ url: "https://a.example/?q=1", title: "A title" }],
  );
});

test("Veil: tags stay tags by default; restoring is opt-in, only in the file, and never names the file", () => {
  const chat = sampleChat();
  const map = {
    EMAIL_1: "ana@example.com",
    NAME_1: "Ana Costa",
    PHONE_9: "+351 900 000 000",
  };
  const context = { userId: ME.id, username: ME.username, modelName };
  // Two tags in the chat are in this browser's map; PHONE_9 isn't used.
  assert.equal(restorableCount(chat, map, context), 2);
  assert.equal(restorableCount(chat, { OTHER_1: "x" }, context), 0);
  assert.equal(restorableCount(chat, null, context), 0);
  const masked = docFor(chat, ME, { modelName });
  assert.match(exportJSON(masked), /\[EMAIL_1\]/);
  assert.doesNotMatch(exportJSON(masked), /ana@example\.com|Ana Costa/);
  const restored = docFor(chat, ME, { modelName, restore: map });
  assert.equal(restored.options.veil_restored, true);
  assert.equal(restored.summary.masked_details, 0);
  assert.equal(restored.conversation.title, "Lisbon trip for ana@example.com");
  assert.equal(
    restored.messages[0].text,
    "Plan three days in Lisbon and send it to ana@example.com.",
  );
  assert.equal(
    restored.messages[0].attachments[0].name,
    "itinerary Ana Costa.pdf",
  );
  const md = exportMarkdown(restored);
  assert.match(
    md,
    /^- Masked details were restored in this browser for this file\.$/m,
  );
  assert.doesNotMatch(md, /\[EMAIL_1\]|Masked details stay masked/);
  // A tag the map doesn't hold stays a tag.
  const partial = docFor(chat, ME, {
    modelName,
    restore: { EMAIL_1: "ana@example.com" },
  });
  assert.equal(partial.summary.masked_details, 1);
  assert.equal(
    partial.messages[0].attachments[0].name,
    "itinerary [NAME_1].pdf",
  );
  // An empty map restores nothing and says so.
  assert.equal(docFor(chat, ME, { restore: {} }).options.veil_restored, false);
  // The file is named from the saved title: no restored value, no tag.
  assert.equal(
    exportFilename(chat.title, "md", T0),
    "anonyma-lisbon-trip-for-2026-09-21.md",
  );
  // Restoring is pure: no request can happen while building or writing.
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => {
    throw Error("no network");
  };
  try {
    exportMarkdown(
      docFor(chat, ME, { modelName, restore: map, receipts: true }),
    );
    exportJSON(docFor(chat, ME, { modelName, restore: map }));
  } finally {
    globalThis.fetch = realFetch;
  }
  // The dialog passes the map only to the builder, and says where it goes.
  const jsx = src("src/ChatExport.jsx");
  assert.match(jsx, /restore: restore && restorable \? map : null/);
  assert.match(jsx, /\{restorable > 0 && \(/);
  assert.match(jsx, /never to our\s+servers/);
});

// ---- Where messages come from, and who can read them -----------------------

test("access follows the conversation read: owner, collab member, removed member, other account", async (t) => {
  const s = fixture(t);
  const ana = await person(s, "ana_x");
  const ben = await person(s, "ben_x");
  const eve = await person(s, "eve_x");
  // A personal chat: the owner exports it, with receipts for every reply.
  const own = (
    await say(ana.agent, "Plan a trip", { requestId: "ana-own-1" })
  ).find((e) => e.anonyma);
  const chat = await read(ana.agent, own.conversationId);
  assert.equal(chat.status, 200);
  const doc = docFor(chat, ana.user, { receipts: true });
  assert.deepEqual(schemaErrors(CHAT_EXPORT_SCHEMA, doc), []);
  assert.equal(doc.conversation.id, own.conversationId);
  assert.equal(doc.messages.length, 2);
  assert.equal(doc.messages[0].you, true);
  assert.equal(doc.messages[1].model_id, MODEL);
  assert.equal(doc.messages[1].receipt.id, "ana-own-1");
  assert.equal(
    doc.messages[1].receipt.credits_charged,
    own.anonyma.credits_charged,
  );
  assert.equal(doc.messages[1].receipt.signed, !!own.anonyma.signed_receipt);
  assert.ok(doc.conversation.started_at && doc.conversation.last_message_at);
  // Anyone else gets the same 404 as opening it, so there's nothing to export.
  for (const other of [ben, eve]) {
    const r = await read(other.agent, own.conversationId);
    assert.equal(r.status, 404);
    assert.equal(r.error.message, "Conversation not found.");
  }
  // A branch copies earlier replies without charging them again.
  const branch = (
    await ana.agent
      .post(`/api/conversations/${own.conversationId}/branch`)
      .send({ through: chat.messages[1].id, requestId: "branch-1" })
      .expect(201)
  ).body;
  const copied = docFor(await read(ana.agent, branch.id), ana.user, {
    receipts: true,
  });
  assert.deepEqual(copied.messages[1].receipt, {
    credits_charged: 0,
    id: "ana-own-1",
    signed: copied.messages[1].receipt.signed,
    branch_copy: true,
  });
  assert.match(
    exportMarkdown(copied),
    /Receipt · copied from the original conversation, charged there/,
  );
  // A collab conversation: every member's messages, names as shown, and
  // receipts only for your own replies.
  const { id: collab } = (
    await ana.agent
      .post("/api/collabs")
      .send({ name: "Atlas team" })
      .expect(201)
  ).body;
  const invite = (
    await ana.agent.post(`/api/collabs/${collab}/invite`).send({}).expect(200)
  ).body;
  await ben.agent
    .post("/api/collabs/join")
    .send({ token: invite.token })
    .expect(200);
  const convo = (
    await ben.agent
      .post(`/api/collabs/${collab}/conversations`)
      .send({ title: "Tagline ideas" })
      .expect(201)
  ).body.id;
  await say(ana.agent, "Ana's idea", {
    conversationId: convo,
    requestId: "ana-collab-1",
  });
  await say(ben.agent, "Ben's idea", {
    conversationId: convo,
    requestId: "ben-collab-1",
  });
  const shared = await read(ben.agent, convo);
  const forBen = docFor(shared, ben.user, { receipts: true });
  assert.deepEqual(forBen.conversation.collab, { name: "Atlas team" });
  assert.deepEqual(
    forBen.messages.map((m) =>
      m.role === "user" ? [m.you, m.author] : (m.receipt?.id ?? null),
    ),
    [[false, "ana_x"], null, [true, null], "ben-collab-1"],
  );
  const md = exportMarkdown(forBen);
  assert.match(md, /^- Shared in: Atlas team$/m);
  assert.deepEqual(md.match(/^## (ana\\_x|You)\b/gm), ["## ana\\_x", "## You"]);
  assert.equal(md.match(/Receipt · /g).length, 1, "only Ben's own reply");
  assert.doesNotMatch(md, /ana-collab-1/);
  // Removed from the collab: the read is refused, so nothing is exported.
  await ana.agent.delete(`/api/collabs/${collab}/members/ben_x`).expect(200);
  assert.equal((await read(ben.agent, convo)).status, 404);
  assert.equal((await read(eve.agent, convo)).status, 404);
  // An auto-deleted conversation is gone at once, here too.
  s.db
    .prepare("UPDATE conversations SET expires=? WHERE id=?")
    .run(Date.now() - 1000, own.conversationId);
  assert.equal((await read(ana.agent, own.conversationId)).status, 404);
});

test("off the record, Private Mode, device-only and unsaved chats export what's on screen, with nothing fetched", async (t) => {
  assert.deepEqual(exportPlan({ id: "c_1" }), {
    source: "server",
    reason: null,
  });
  assert.deepEqual(exportPlan({ id: null }), {
    source: "screen",
    reason: "unsaved",
  });
  // Never the server for a chat that wasn't saved, even with a stale id.
  assert.deepEqual(exportPlan({ id: "c_1", ephemeral: true }), {
    source: "screen",
    reason: "off_record",
  });
  assert.deepEqual(
    exportPlan({ id: "c_1", ephemeral: true, privateMode: true }),
    { source: "screen", reason: "private" },
  );
  assert.deepEqual(exportPlan({ ephemeral: true, deviceOnly: true }), {
    source: "screen",
    reason: "device",
  });
  const s = fixture(t);
  const { agent, user } = await person(s, "offrec");
  const stream = await say(agent, "Off the record question [EMAIL_1]", {
    ephemeral: true,
    requestId: "off-1",
  });
  const final = stream.find((e) => e.anonyma);
  assert.equal(final.conversationId ?? null, null);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  // The screen, as the workspace holds it: the prompt as sent (masked) and
  // the reply with the charge from its final event.
  const screen = [
    { role: "user", content: "Off the record question [EMAIL_1]" },
    onScreen(stream, MODEL, "off-1"),
  ];
  assert.equal(screen[1].credits, final.anonyma.credits_charged);
  const doc = buildChatExport({
    conversation: {
      id: null,
      saved: false,
      title: "Off-the-record chat",
      mode: "chat",
    },
    messages: screen,
    userId: user.id,
    username: user.username,
    receipts: true,
    testMode: true,
    restore: { EMAIL_1: "me@example.com" },
  });
  assert.deepEqual(schemaErrors(CHAT_EXPORT_SCHEMA, doc), []);
  assert.equal(doc.conversation.id, null);
  assert.equal(doc.conversation.saved, false);
  assert.equal(doc.conversation.started_at, null);
  assert.equal(doc.local_test, true);
  assert.deepEqual(doc.messages[1].receipt, {
    credits_charged: final.anonyma.credits_charged,
    id: "off-1",
    signed: false,
  });
  assert.equal(doc.messages[0].text, "Off the record question me@example.com");
  const md = exportMarkdown(doc, { note: SCREEN_NOTES.off_record });
  assert.match(
    md,
    /^- Off the record: nothing was saved, so the download holds only what's on screen now\.$/m,
  );
  assert.doesNotMatch(md, /^- Conversation:/m);
  assert.match(md, /^## You$/m);
  // Still nothing saved on the server, and nothing to read back.
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
  // Every reason has its own note and a neutral title (never the prompt).
  for (const reason of ["device", "private", "off_record", "unsaved"])
    assert.ok(SCREEN_NOTES[reason]);
  const jsx = src("src/ChatExport.jsx");
  assert.match(
    jsx,
    /title: t\(SCREEN_TITLES\[target\.reason\] \|\| SCREEN_TITLES\.unsaved\)/,
  );
  assert.match(
    jsx,
    /fileTitle: SCREEN_TITLES\[target\.reason\] \|\| SCREEN_TITLES\.unsaved/,
  );
});

test("filenames: sanitized, prefixed and dated; any script's letters kept", () => {
  const at = Date.UTC(2026, 8, 25, 12);
  const cases = [
    ["Lisbon trip", "anonyma-lisbon-trip-2026-09-25.md"],
    ["../../etc/hosts", "anonyma-etc-hosts-2026-09-25.md"],
    [
      "C:\\Windows\\System32\\cmd.exe",
      "anonyma-c-windows-system32-cmd-exe-2026-09-25.md",
    ],
    ["CON", "anonyma-con-2026-09-25.md"],
    [".hidden", "anonyma-hidden-2026-09-25.md"],
    ['a<b>c:"d"|e?f*g', "anonyma-a-b-c-d-e-f-g-2026-09-25.md"],
    ["invoice\u202Etxt.exe", "anonyma-invoice-txt-exe-2026-09-25.md"],
    ["line\nbreak\u0000null", "anonyma-line-break-null-2026-09-25.md"],
    ["我的旅行计划", "anonyma-我的旅行计划-2026-09-25.md"],
    ["Café résumé", "anonyma-café-résumé-2026-09-25.md"],
    ["🔥🔥🔥", "anonyma-chat-2026-09-25.md"],
    ["", "anonyma-chat-2026-09-25.md"],
    [null, "anonyma-chat-2026-09-25.md"],
    ["[EMAIL_1] notes", "anonyma-notes-2026-09-25.md"],
  ];
  for (const [title, name] of cases)
    assert.equal(exportFilename(title, "md", at), name, JSON.stringify(title));
  const long = exportFilename("word ".repeat(40), "json", at);
  assert.ok(
    long.length <= "anonyma-".length + 60 + "-2026-09-25.json".length,
    long,
  );
  assert.doesNotMatch(long, /--/);
  // Astral characters are never cut in half.
  const astral = exportFilename("𠀀".repeat(80), "md", at);
  assert.equal(Array.from(astral.slice(8, -14)).length, 60);
  assert.doesNotMatch(astral, /\uFFFD/);
  // Only known extensions.
  assert.equal(exportFilename("x", "exe", at), "anonyma-x-2026-09-25.txt");
  assert.equal(exportFilename("x", "json", at), "anonyma-x-2026-09-25.json");
  for (const [title] of cases)
    assert.match(
      exportFilename(title, "md", at),
      /^anonyma-[\p{L}\p{M}\p{N}-]+-\d{4}-\d{2}-\d{2}\.md$/u,
    );
});

// ---- The dialog and the print page (rendered as the workspace would) -------

// ChatExport.jsx compiled for Node with the same esbuild Vite uses; the
// shared UI kit and the portal are swapped for plain stand-ins.
async function uiModule() {
  const file = new URL("../src/ChatExport.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(
    readFileSync(file, "utf8"),
    file.pathname,
    {
      jsx: "transform",
      format: "esm",
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "anonyma-chat-export-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Icon = () => null;
     export const Button = ({ children, secondary, ...p }) => React.createElement("button", p, children);
     export const Notice = ({ children }) => React.createElement("div", { className: "notice" }, children);
     export const Modal = ({ title, children }) => React.createElement("dialog", { open: true, "aria-label": title }, React.createElement("h2", null, title), children);`,
  );
  const dom = stub("dom.mjs", "export const createPortal = (node) => node;");
  // Math & Diagrams' reply renderer, unreleased here: plain react-markdown.
  const rich = stub(
    "rich.mjs",
    `import Markdown from "${import.meta.resolve("react-markdown")}";
     export const ReplyMarkdown = ({ rich, live, ...p }) => React.createElement(Markdown, p);`,
  );
  const local = (name) => new URL("../src/" + name, import.meta.url).href;
  const out = code
    .replace(/^import "\.\/chat-export\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "react-dom"/g, `from "${dom}"`)
    .replace(/from "\.\/RichMarkdown\.jsx"/g, `from "${rich}"`)
    .replace(
      /from "react-markdown"/g,
      `from "${import.meta.resolve("react-markdown")}"`,
    )
    .replace(
      /from "remark-gfm"/g,
      `from "${import.meta.resolve("remark-gfm")}"`,
    )
    .replace(/from "\.\/lib\.js"/g, `from "${local("lib.js")}"`)
    .replace(/from "\.\/i18n\.js"/g, `from "${local("i18n.js")}"`)
    .replace(/from "\.\/chat-export\.js"/g, `from "${local("chat-export.js")}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const path = join(dir, "ChatExport.mjs");
  writeFileSync(path, out);
  try {
    return await import(pathToFileURL(path).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
// Rendered text, split by whether it sits inside data-i18n="off" (the
// chat's own words and names) or not (the page's, to be translated).
function textsOf(html) {
  const VOID = new Set([
    "input",
    "br",
    "img",
    "hr",
    "meta",
    "link",
    "source",
    "wbr",
  ]);
  const stack = [],
    page = [],
    kept = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(
        /(?:placeholder|aria-label|title)="([^"]*)"/g,
      ))
        (off || stack.some((x) => x.off) ? kept : page).push(entities(attr));
      const noText =
        /^(script|style|code|pre|textarea|noscript|kbd|samp)$/i.test(m[2]);
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>"))
        stack.push({ off: off || noText });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    }
  }
  const words = (list) => list.filter((s) => /[A-Za-z]{2}/.test(s));
  return { page: words(page), kept: words(kept) };
}
const untranslated = (texts) =>
  texts.filter((line) => {
    if (["Markdown", "JSON", "ANONYMA"].includes(line)) return false;
    const out = translateText(line, zh);
    return !(out && han.test(out));
  });

test("the Export dialog: formats, toggles, what's in the file, and the restore offer only when it applies", async () => {
  const { ExportDialog, SCREEN_TITLES, chatExportReleased } = await uiModule();
  assert.equal(
    chatExportReleased({ releases: { features: { chatexport: true } } }),
    true,
  );
  assert.equal(
    chatExportReleased({ releases: { features: { chatexport: "true" } } }),
    false,
  );
  assert.equal(chatExportReleased(undefined), false);
  const chat = sampleChat();
  const render = (props) =>
    renderToStaticMarkup(
      createElement(ExportDialog, {
        target: {
          source: "screen",
          reason: "private",
          mode: "chat",
          messages: chat.messages,
        },
        user: ME,
        modelName,
        onClose() {},
        ...props,
      }),
    );
  const html = render({ veilMap: { EMAIL_1: "ana@example.com" } });
  assert.match(html, /aria-label="Export this chat"/);
  for (const needle of [
    "Private Mode chat",
    "Made in this browser from what&#x27;s on screen. Nothing is sent anywhere.",
    'checked="" value="markdown"',
    'value="json"',
    'value="print"',
    "Receipts: credits charged and receipt ID for each of your replies",
    "Web sources cited in replies",
    "Restore masked details in this download",
    "1 masked detail can be restored from what Veil keeps in this browser.",
    "The restored values go only into the file, never to our servers.",
    "4 messages, with the model name on every reply.",
    "Private Mode: nothing was saved, so the download holds only what&#x27;s on screen now.",
    "2 masked details stay masked, as tags like [EMAIL_1].",
    "3 attachments appear as placeholders with their names; their contents aren&#x27;t included.",
    "Download Markdown",
  ])
    assert.ok(html.includes(needle), needle);
  // Receipts are off until chosen; sources are on.
  assert.match(html, /<input type="checkbox"\/><span>Receipts:/);
  assert.match(html, /<input type="checkbox" checked=""\/><span>Web sources/);
  // No Veil map in this browser (or none of its tags): no restore offer.
  for (const veilMap of [null, {}, { OTHER_1: "x" }])
    assert.doesNotMatch(render({ veilMap }), /Restore masked details/);
  // Nothing to receipt or cite: the toggles say so and are disabled.
  const bare = render({
    target: {
      source: "screen",
      reason: "off_record",
      mode: "chat",
      messages: [{ role: "user", content: "hi" }],
    },
  });
  assert.equal(bare.match(/disabled=""/g).length, 2);
  assert.equal(bare.match(/None in this chat/g).length, 2);
  assert.match(bare, /1 message, with the model name on every reply\./);
  // An empty chat has nothing to export.
  assert.match(
    render({
      target: {
        source: "screen",
        reason: "unsaved",
        mode: "chat",
        messages: [],
      },
    }),
    /There&#x27;s nothing to export in this chat yet\./,
  );
  // A saved chat waits for its read.
  assert.match(
    render({ target: { source: "server", id: "c_1" } }),
    /Loading the conversation…/,
  );
  // A collab conversation says whose messages and whose receipts.
  assert.match(
    render({
      target: {
        source: "screen",
        reason: "unsaved",
        mode: "chat",
        messages: chat.messages,
        collab: { name: "Team" },
      },
    }),
    /Only your own replies have receipts\./,
  );
  assert.deepEqual(
    Object.keys(SCREEN_TITLES).sort(),
    Object.keys(SCREEN_NOTES).sort(),
  );
  // Every word of the dialog's own has a Chinese translation; the chat's
  // title stays as written.
  const { page } = textsOf(html + bare);
  assert.deepEqual(untranslated(page), []);
});

test("the print page: a clean document, printed on its own by the print stylesheet", async () => {
  const { ChatPrintView } = await uiModule();
  const chat = sampleChat();
  const doc = docFor(chat, ME, { modelName, receipts: true, now: T0 + DAY() });
  // The collab member's name and a model's words are content, not labels.
  doc.messages.push({
    role: "user",
    you: false,
    author: "Settings",
    created_at: null,
    text: "Settings",
    attachments: [],
  });
  doc.messages.push({
    role: "assistant",
    model: "Model",
    model_id: "m",
    created_at: null,
    text: "<script>alert(1)</script>\n\n![x](https://tracker.example/p.png)",
    interrupted: true,
    attachments: [],
    citations: [],
    receipt: null,
  });
  globalThis.document = { body: {} };
  let html;
  try {
    html = renderToStaticMarkup(
      createElement(ChatPrintView, {
        doc,
        filename: "anonyma-lisbon-2026-09-22",
        onBack() {},
        onClose() {},
      }),
    );
  } finally {
    delete globalThis.document;
  }
  assert.match(
    html,
    /^<div class="chat-print-root" role="dialog" aria-modal="true" aria-label="Print view">/,
  );
  assert.match(html, /<h1 data-i18n="off">Lisbon trip for \[EMAIL_1\]<\/h1>/);
  for (const needle of [
    "Print or save as PDF",
    "In the print dialog, choose Save as PDF to keep a PDF copy.",

    'data-i18n="off">Claude Opus 5.5</b>',
    'data-i18n="off">GPT-6 Sol</b>',
    "<b>You</b>",
    '<b data-i18n="off">itinerary [NAME_1].pdf</b>',
    "Receipt · 0.0421 credits charged",
    '<code data-i18n="off">req_day_plan</code>',
    "<span>Signed</span>",
    "Alfama guide · ",
    "https://visitlisboa.example/alfama",
    "Reply interrupted.",
    "Masked details stay masked, shown as tags like [EMAIL_1].",
  ])
    assert.ok(html.includes(needle), needle);
  // Raw HTML is text, pictures are placeholders: nothing loads or runs.
  assert.doesNotMatch(html, /<script|<img|<iframe/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(
    html,
    /<dt>Conversation<\/dt><dd>2026-09-21 09:30(<!-- -->)? – 2026-09-21 10:01<\/dd>/,
  );
  assert.match(
    html,
    /class="chat-print-inline-image"><span>Image<\/span><span data-i18n="off">x<\/span>/,
  );
  assert.equal(
    (html.match(/<span>Image<\/span><span>Not included\.<\/span>/g) || [])
      .length,
    2,
  );
  assert.doesNotMatch(html, /TOP SECRET|data:image|media\.example/);
  // A member called "Settings" and a message saying it are kept as written.
  assert.match(html, /<b data-i18n="off">Settings<\/b>/);
  const { page } = textsOf(html);
  assert.deepEqual(
    untranslated(
      page.filter((l) => !/^\d{4}-\d{2}-\d{2}/.test(l) && !/^\d+$/.test(l)),
    ),
    [],
  );
  // The print stylesheet prints only this page.
  const css = src("src/chat-export.css");
  assert.match(
    css,
    /@media print \{\s+html\.chat-printing body > \*:not\(\.chat-print-root\) \{\s+display: none !important;/,
  );
  assert.match(css, /\.chat-print-toolbar \{\s+display: none;\s+\}/);
  assert.match(css, /@page \{/);
  const jsx = src("src/ChatExport.jsx");
  assert.match(jsx, /root\.classList\.add\("chat-printing"\)/);
  assert.match(jsx, /root\.classList\.remove\("chat-printing"\)/);
  assert.match(jsx, /onClick=\{\(\) => window\.print\(\)\}/);
  // No PDF library: the browser's own print dialog saves the PDF.
  assert.doesNotMatch(
    jsx + src("src/chat-export.js"),
    /jspdf|pdfmake|pdf-lib|pdfjs/i,
  );
});

// ---- Chinese --------------------------------------------------------------

test("Chinese: the update, the dialog's phrases and the file's labels; chat content is never translated", () => {
  const entry = UPDATES.find((u) => u.id === "chatexport");
  const lines = [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Chat Export is coming soon.",
    "Export",
    "Export this chat",
    "Export this conversation",
    "Wait for the reply to finish",
    ...Object.values(SCREEN_NOTES),
    ...EXPORT_LABELS,
    receiptLabel({ credits_charged: 0.5 }),
    receiptLabel({ credits_charged: 12.25 }, true),
    receiptLabel({ branch_copy: true, credits_charged: 0 }),
    "12 masked details can be restored from what Veil keeps in this browser.",
    "30 messages, with the model name on every reply.",
    "5 masked details stay masked, as tags like [EMAIL_1].",
    "2 attachments appear as placeholders with their names; their contents aren't included.",
    "Downloaded",
    "Download JSON",
    "Open print view",
    "Loading the conversation…",
    "Made in this browser from the saved conversation. Nothing is sent back.",
    "Shared conversation: every message you can see now, with members' names as shown here. Only your own replies have receipts.",
    "Back",
    "Close print view",
    "Exported",
    "Masked details were restored in this browser for this page.",
    "Its text isn't included.",
    "Not included.",
    "Device-only chat",
    "Private Mode chat",
    "Off-the-record chat",
    "Untitled conversation",
  ];
  for (const line of lines) {
    const out = translateText(line, zh);
    assert.ok(out && han.test(out), `zh: ${line} → ${out}`);
    const leftover = (out.match(/[A-Za-z]{4,}/g) || []).filter(
      (w) => !["ANONYMA", "Veil", "EMAIL", "Markdown", "JSON"].includes(w),
    );
    assert.deepEqual(leftover, [], `half-translated: ${line} → ${out}`);
  }
  // A Chinese download: labels in Chinese, the chat exactly as written.
  const label = (s) => translateText(s, zh) ?? s;
  const doc = buildChatExport({
    conversation: { id: "c_z", title: "Settings" },
    messages: [
      { role: "user", content: "Settings", created: T0 },
      {
        role: "assistant",
        content: "Export",
        model: "m",
        credits: 0.5,
        requestId: "r1",
        created: T0 + MIN,
      },
      {
        role: "user",
        content: "hi",
        author: "Close",
        author_id: "u_other",
        created: T0 + 2 * MIN,
      },
    ],
    userId: "u_me",
    receipts: true,
    now: T0 + 3 * MIN,
  });
  const md = exportMarkdown(doc, { label, note: SCREEN_NOTES.unsaved });
  assert.match(md, /^# Settings$/m);
  assert.match(md, /^- 导出自 ANONYMA: 2026-09-21 09:33$/m);
  assert.match(md, /^## 你 · 2026-09-21 09:30\n\nSettings$/m);
  assert.match(md, /^## m · 2026-09-21 09:31\n\nExport$/m);
  assert.match(md, /^## Close · 2026-09-21 09:32$/m);
  assert.match(md, /^\*收据 · 已扣除 0\.5 积分 · 收据 ID r1\*$/m);
  assert.equal(
    speaker({ role: "user", you: false, author: null }, label),
    "前成员",
  );
});
