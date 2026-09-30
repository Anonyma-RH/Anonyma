import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { createApp } from "../server/app.js";
import { now, uid } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import { openapi, openapiForConfig } from "../server/openapi.js";
import { rankTools } from "../src/tool-search.js";
import { maskComposer, scanComposer } from "../src/secret-guard.js";
import { unveil } from "../src/veil.js";
import { BACKUP_KINDS, RESTORE_MODES, readItem } from "../src/account-backup-spec.js";
import { loadBackup, writerFor } from "../src/account-backup-engine.js";
import { makeBackup, restoreBackup } from "../src/account-backup-run.js";

// Batch 9 integration: the ten updates together. Secret Guard wherever text
// leaves the browser (dictated text included), Characters and saved
// subtitles in Encrypted Backup, one erase for everything (Panic Wipe,
// Inactivity Wipe and account closure), and the cross-feature rules: Auto
// Model, Model Status, the tool directory and the API contract.

const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ORIGIN = "http://localhost:5175";
const PASSWORD = "test-password-long";
const PASS = "correct horse battery staple";
const MODEL = "google/gemini-2.5-flash";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 30, 9, 0, 0);
const BATCH9 = ["secretguard", "burnlinks", "characters", "pdfredact", "dictation", "subtitles", "shottosite", "contractreader", "debate", "backup"];
// A key-shaped value Secret Guard knows (an OpenAI-style project key).
const KEY = "sk-proj-" + "Zq7Xw2Lm9Pv4Rt6Yb8Nc3Hd5Kf1Gj0Ts".repeat(2);
const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-batch9-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    origin: ORIGIN,
    publicUrl: "https://share.example.test",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    mvpModels: [MODEL],
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(svc, username) {
  const agent = request.agent(svc.app);
  const r = await agent
    .post("/api/auth/register")
    .set("Origin", ORIGIN)
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username: username + Math.random().toString(36).slice(2, 6), password: PASSWORD })
    .expect(201);
  return { agent, id: r.body.user.id };
}
const count = (svc, sql, ...args) => svc.db.prepare(sql).get(...args).n;
// The page's `api` over a signed-in supertest agent.
const apiFor = (agent) => async (path, { method = "GET", body } = {}) => {
  const r = await agent[method.toLowerCase()](path).send(body);
  if (r.status >= 400)
    throw Object.assign(Error(r.body?.error?.message || "failed"), { status: r.status, code: r.body?.error?.code });
  return r.body;
};
// The backup worker's protocol on this thread.
async function engineFor() {
  let writer = null,
    session = null;
  return {
    start: async (passphrase, created) => void (writer = await writerFor(passphrase, { created })),
    push: (items) => writer.push(items),
    finish: () => writer.finish(),
    open: async (file, passphrase, opts) => (session = await loadBackup(file, passphrase, opts)).overview(),
    get: async (kind, start, count) => session.get(kind, start, count),
  };
}
// A real 16 x 16 grey PNG, for a character's picture.
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, tail]);
};
function pngAvatar(size = 16) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  const raw = Buffer.alloc((size + 1) * size, 0x80);
  for (let y = 0; y < size; y++) raw[y * (size + 1)] = 0;
  const bytes = Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  return "data:image/png;base64," + bytes.toString("base64");
}
const PAGE =
  '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>Halden Coffee</title></head><body><main><h1>Small-batch coffee</h1><p>Roasted every week.</p></main></body></html>';
const SET = (title = "Team call") => ({
  title,
  duration: 120,
  language: "en",
  tracks: [{ lang: "en", source: true, cues: [{ start: 0.5, end: 2.5, text: "Hello there." }, { start: 3, end: 5.5, text: "This is a test." }] }],
});
// A saved debate, as /api/debate keeps one: an ordinary conversation in the
// chat mode with the question, each turn under its model and the judge.
function savedDebate(svc, user, question = "Should cities ban cars from their centres?") {
  const id = uid("c_"),
    at = now() - DAY;
  const add = (role, content, model, i) =>
    svc.db
      .prepare("INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(uid("m_"), id, role, JSON.stringify(content), model, 0, at + i, user);
  svc.db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)").run(id, user, question, "chat", at, at);
  add("user", question, MODEL, 0);
  add("assistant", { text: "Side A · Opening: yes, streets are for people.", debate: { v: 1, kind: "turn", n: 1, side: "a", round: 1, role: "opening" } }, MODEL, 1);
  add("assistant", { text: "Side B · Opening: no, deliveries need access.", debate: { v: 1, kind: "turn", n: 2, side: "b", round: 1, role: "opening" } }, MODEL, 2);
  add("assistant", { text: "Judge: too close to call.", debate: { v: 1, kind: "judge", verdict: { winner: "tie" } } }, MODEL, 3);
  return id;
}

// ---- Secret Guard wherever text leaves the browser ------------------------------

test("Secret Guard: dictated text lands in the composer and is scanned at Send like typed text", () => {
  const ws = source("src/Workspace.jsx");
  // The dictation panel hands its words to the composer's own prompt state,
  // the one typing writes; nothing is sent from the panel.
  const handler = /<DictationPanel[\s\S]*?onText=\{\(t\) => \{([\s\S]*?)\}\}\s*\/>/.exec(ws)?.[1];
  assert.ok(handler, "the dictation panel's onText");
  const insert = /setPrompt\((\(p\) => \(p\.trim\(\) \? p\.trimEnd\(\) \+ " " \+ t : t\))\);/.exec(handler)?.[1];
  assert.ok(insert, "dictated words go into the prompt");
  assert.doesNotMatch(handler, /send\(|api\(|fetch\(/);
  // The words the composer sends are the prompt's, and Secret Guard scans
  // exactly those (plus attached text) before Send.
  assert.match(ws, /const sendText = mentioned \? mention\[2\]\.trim\(\) : prompt\.trim\(\);/);
  assert.match(ws, /const secretParts = useMemo\(\s*\(\) => \[\s*\{ text: sendText \},/);
  assert.match(ws, /if \(!redo && secretHeld && !allowSecret\) \{/);
  // Run the panel's own insertion: a key spoken aloud is found, and Mask
  // swaps it for a placeholder the reply restores.
  const put = new Function("t", `return ${insert};`);
  let prompt = "Here is the staging config.";
  prompt = put("my key is " + KEY)(prompt);
  assert.equal(prompt, "Here is the staging config. my key is " + KEY);
  const finds = scanComposer({ prompt });
  assert.equal(finds.length, 1);
  assert.equal(finds[0].part, 0);
  assert.ok(!finds[0].preview.includes(KEY.slice(6, -2)), "shown partly hidden");
  const state = {};
  const masked = maskComposer({ prompt, documents: [] }, state);
  assert.ok(!masked.prompt.includes(KEY));
  assert.match(masked.prompt, /\[SECRET_1\]/);
  assert.equal(unveil("Reply about [SECRET_1].", state.map), `Reply about ${KEY}.`);
});

test("Secret Guard: Characters, Screenshot to site, Debate and subtitle translations hold a secret before sending", () => {
  const chars = source("src/Characters.jsx");
  assert.match(chars, /const secretFinds = useSecretScan\(secretLive, secretTexts\);/);
  assert.match(chars, /draft\.instructions, draft\.opening/);
  assert.match(chars, /disabled=\{busy \|\| hasProblem \|\| !!seedHit \|\| secretHeld\}/);
  assert.match(chars, /secretGuardTurn\(\{ seedHit, finds: secretHeld \? secretFinds : \[\], seedAnswered \}\)/);
  // Adding a shared copy: its instructions and opening message are scanned
  // and can be masked before the copy is saved.
  assert.match(chars, /const secretFinds = useSecretScan\(secretLive && !!view, secretTexts\);/);
  assert.match(chars, /add\(\{ instructions: maskSecrets\(view\.instructions, state\)\.text, opening: maskSecrets\(view\.opening, state\)\.text \}\)/);
  const sts = source("src/ShotToSite.jsx");
  assert.match(sts, /const secretFinds = useSecretScan\(secretLive, words\);/);
  assert.match(sts, /const words = \(changing \? instruction : notes\)\.trim\(\);/);
  assert.match(sts, /if \(!live \|\| !model \|\| seedBlocked \|\| secretHeld \|\| veiled > 0\) return null;/, "no estimate while held");
  assert.match(sts, /!seedBlocked &&\n\s+!secretHeld &&/);
  const debate = source("src/Debate.jsx");
  assert.match(debate, /const secretFinds = useSecretScan\(secretLive && !running && !run, secretTexts\);/);
  assert.match(debate, /noPrivate \|\| settled \|\| run \|\| secretHeld\) return null;/, "no estimate while held");
  assert.match(debate, /const ready = startable && !seedHit && !secretHeld;/);
  const subs = source("src/Subtitles.jsx");
  assert.match(subs, /const secretFinds = useSecretScan\(secretLive, cueText\);/);
  assert.match(subs, /const text = maskingSecrets \? maskSecrets\(i\.text, state\)\.text : i\.text;/);
  assert.match(subs, /if \(run \|\| !todo\.length \|\| !chosen \|\| secretHeld\) return null;/);
  assert.match(subs, /if \(run \|\| !quoteFresh \|\| !chosen \|\| noPrivate \|\| !todo\.length \|\| secretHeld\) return;/);
  // Each surface asks whether the guard is on for this account.
  for (const [file, code] of [["Characters", chars], ["ShotToSite", sts], ["Debate", debate], ["Subtitles", subs]])
    assert.match(code, /useSecretGuard\(config, user, demo\)/, file);
});

test("Secret Guard: a shared character's copy can be added with its secrets masked, and nothing else changes", async (t) => {
  const svc = fixture(t);
  const owner = await person(svc, "olga");
  const reader = await person(svc, "rui");
  const made = (
    await owner.agent
      .post("/api/characters")
      .send({ name: "Deploy bot", description: "Ships things", instructions: `Use the key ${KEY} for staging.`, opening: "Ready." })
      .expect(201)
  ).body;
  const link = (await owner.agent.post(`/api/characters/${made.id}/shares`).send({ expires_in_days: 7 }).expect(201)).body;
  const token = new URL(link.url).hash.replace(/^#copy=/, "") || link.url.split("copy=").pop();
  const view = (await reader.agent.get(`/api/character-shares/${encodeURIComponent(token)}`).expect(200)).body;
  assert.ok(view.instructions.includes(KEY), "the reader sees the instructions in full first");
  const copy = (
    await reader.agent
      .post(`/api/character-shares/${encodeURIComponent(token)}/import`)
      .send({ instructions: "Use the key [SECRET_1] for staging.", opening: "Ready." })
      .expect(201)
  ).body;
  assert.equal(copy.instructions, "Use the key [SECRET_1] for staging.");
  assert.equal(copy.name, "Deploy bot");
  assert.equal(copy.description, "Ships things");
  const stored = svc.db.prepare("SELECT instructions FROM characters WHERE user_id=?").all(reader.id);
  assert.deepEqual(stored.map((r) => r.instructions), ["Use the key [SECRET_1] for staging."]);
  // Seed Guard still applies to what's sent, and the limits hold.
  await reader.agent
    .post(`/api/character-shares/${encodeURIComponent(token)}/import`)
    .send({ instructions: "x".repeat(10_000) })
    .expect(400);
});

// ---- Encrypted Backup: Characters, saved subtitles, debates and pages ----------

test("the whole trip with batch 9: characters (with pictures), saved subtitles, debates and Screenshot to site pages; never links", async (t) => {
  const svc = fixture(t);
  const a = await person(svc, "ada");
  const avatar = pngAvatar();
  const ada = (await a.agent.post("/api/characters").send({ name: "Ada", description: "A librarian", instructions: "You are Ada.", opening: "Hello, reader.", model: MODEL, avatar }).expect(201)).body;
  await a.agent.post("/api/characters").send({ name: "Vex", instructions: "You are Vex.", avatar: "mono:amber" }).expect(201);
  await a.agent.post(`/api/characters/${ada.id}/shares`).send({ expires_in_days: 30 }).expect(201);
  await a.agent.post("/api/subtitles/sets").send(SET()).expect(201);
  const debateId = savedDebate(svc, a.id);
  const page = (await a.agent.post("/api/site-pages").send({ versions: [{ label: "First try", html: PAGE }] }).expect(201)).body;
  // A burn-after-reading link on the debate: never in a backup.
  const burn = (await a.agent.post("/api/shares").send({ conversationId: debateId, burn: true }).expect(201)).body;

  // Debates are ordinary chats and pages are Code & Build chats, so both go
  // back in a mode a restore keeps.
  assert.match(source("server/routes/debate.js"), /newConversation\(user, titleFor\(setup\.question, lang\), "chat"\)/);
  assert.match(source("server/routes/shot-to-site.js"), /newConversation\(user, checked\[0\]\.title\.slice\(0, TITLE_MAX\), "code"\)/);
  assert.deepEqual(RESTORE_MODES.chat, []);
  assert.deepEqual(RESTORE_MODES.code, ["code"]);
  assert.ok(BACKUP_KINDS.includes("characters") && BACKUP_KINDS.includes("subtitles"));

  const status = (await a.agent.get("/api/account/backup").expect(200)).body;
  assert.equal(status.counts.characters, 2);
  assert.equal(status.counts.subtitles, 1);
  const made = await makeBackup({
    api: apiFor(a.agent),
    engine: await engineFor(),
    passphrase: PASS,
    include: new Set(["chats", "characters", "subtitles"]),
  });
  assert.equal(made.counts.characters, 2);
  assert.equal(made.counts.subtitles, 1);
  assert.equal(made.counts.chats, 2);
  const file = new Blob(made.pieces);
  // Nothing about a link is in the file: not the copy link, not the burn link.
  const lines = [];
  await (await import("../src/account-backup.js")).openBackup(file, PASS, { onLine: (l) => lines.push(l) });
  const text = JSON.stringify(lines);
  assert.ok(!text.includes(burn.path.split("/").pop()), "no burn link");
  assert.doesNotMatch(text, /share_links|character_shares|copy=|"token"/);
  assert.ok(lines.filter((l) => l.t === "character").every((l) => readItem(l)), "characters read back");

  // Another account, which already has Vex.
  const b = await person(svc, "bea");
  await b.agent.post("/api/characters").send({ name: "vex", instructions: "You are Vex.", avatar: "mono:navy" }).expect(201);
  const engine = await engineFor();
  const overview = await engine.open(file, PASS, { seedGuard: true });
  assert.equal(overview.counts.characters, 2);
  assert.equal(overview.counts.subtitles, 1);
  const choice = new Set(["chats", "characters", "subtitles"]);
  const { report, error } = await restoreBackup({ api: apiFor(b.agent), engine, choice });
  assert.equal(error, null);
  assert.equal(report.characters.added, 1);
  assert.equal(report.characters.duplicate, 1, "Vex is already here: skipped, never replaced");
  assert.equal(report.subtitles.added, 1);
  assert.equal(report.chats.added, 2);
  const theirs = (await b.agent.get("/api/characters").expect(200)).body.characters;
  const restored = theirs.find((c) => c.name === "Ada");
  assert.equal(restored.avatar, avatar, "the picture comes back as it was");
  assert.equal(restored.instructions, "You are Ada.");
  assert.equal(restored.opening, "Hello, reader.");
  assert.equal(restored.model, MODEL);
  assert.equal(theirs.find((c) => c.name.toLowerCase() === "vex").avatar, "mono:navy", "the one already here is unchanged");
  assert.equal(count(svc, "SELECT COUNT(*) n FROM character_shares WHERE user_id=?", b.id), 0, "no copy links");
  assert.equal(count(svc, "SELECT COUNT(*) n FROM share_burns WHERE user_id=?", b.id), 0, "no burn links");
  const sets = (await b.agent.get("/api/subtitles/sets").expect(200)).body.data;
  assert.equal(sets.length, 1);
  const set = (await b.agent.get("/api/subtitles/sets/" + sets[0].id).expect(200)).body;
  assert.deepEqual(set.tracks, SET().tracks);
  // The debate and the page come back as chats with their words, the page in
  // Code & Build's mode.
  const chats = svc.db.prepare("SELECT id,title,mode FROM conversations WHERE user_id=? ORDER BY created").all(b.id);
  assert.deepEqual(chats.map((c) => c.mode).sort(), ["chat", "code"]);
  const words = (id) => svc.db.prepare("SELECT content FROM messages WHERE conversation_id=? ORDER BY created,rowid").all(id).map((m) => m.content).join("\n");
  assert.match(words(chats.find((c) => c.mode === "chat").id), /Judge: too close to call\./);
  assert.match(words(chats.find((c) => c.mode === "code").id), /Small-batch coffee/);
  assert.ok(page.id);
  // The same backup again adds nothing.
  const again = await restoreBackup({ api: apiFor(b.agent), engine, choice });
  assert.equal(again.report.characters.added, 0);
  assert.equal(again.report.characters.duplicate, 2);
  assert.equal(again.report.subtitles.duplicate, 1);
  assert.equal(again.report.chats.duplicate, 2);
  // The first account is unchanged.
  assert.equal(count(svc, "SELECT COUNT(*) n FROM characters WHERE user_id=?", a.id), 2);
});

// ---- One erase for everything ----------------------------------------------------

// One of every server-side thing batch 9 keeps for an account.
async function seed(svc, p) {
  const c = (await p.agent.post("/api/characters").send({ name: "Ada", instructions: "You are Ada.", avatar: "mono:cobalt" }).expect(201)).body;
  await p.agent.post(`/api/characters/${c.id}/shares`).send({ expires_in_days: 7 }).expect(201);
  const debate = savedDebate(svc, p.id);
  await p.agent.post("/api/shares").send({ conversationId: debate, burn: true }).expect(201);
  await p.agent.post("/api/subtitles/sets").send(SET()).expect(201);
  await p.agent.post("/api/site-pages").send({ versions: [{ label: "First try", html: PAGE }] }).expect(201);
  await p.agent.post("/api/account/backup/made").send({}).expect(200);
  await p.agent
    .post("/api/account/backup/restore/chats")
    .send({ chats: [{ title: "Restored", messages: [{ role: "user", text: "q" + p.id }, { role: "assistant", text: "a" }] }] })
    .expect(200);
  await p.agent.put("/api/secret-guard").send({ enabled: false }).expect(200);
}
function left(svc, id) {
  const n = (sql) => count(svc, sql, id);
  return {
    characters: n("SELECT COUNT(*) n FROM characters WHERE user_id=?"),
    characterLinks: n("SELECT COUNT(*) n FROM character_shares WHERE user_id=?"),
    burnLinks: n("SELECT COUNT(*) n FROM share_links WHERE user_id=?") + n("SELECT COUNT(*) n FROM share_burns WHERE user_id=?"),
    subtitleSets: n("SELECT COUNT(*) n FROM subtitle_sets WHERE user_id=?"),
    debates: n(
      "SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND json_valid(m.content) AND json_extract(m.content,'$.debate') IS NOT NULL",
    ),
    pages: n(
      "SELECT COUNT(*) n FROM messages m JOIN conversations c ON c.id=m.conversation_id WHERE c.user_id=? AND json_valid(m.content) AND json_extract(m.content,'$.site') IS NOT NULL",
    ),
    lastBackup: n("SELECT COUNT(*) n FROM account_backups WHERE user_id=?") + n("SELECT COUNT(*) n FROM backup_restores WHERE user_id=?"),
    secretGuardOff: n("SELECT COUNT(*) n FROM secret_guard_off WHERE user_id=?"),
  };
}
const SEEDED = { characters: 1, characterLinks: 1, burnLinks: 2, subtitleSets: 1, debates: 3, pages: 1, lastBackup: 2, secretGuardOff: 1 };
const ERASED = { characters: 0, characterLinks: 0, burnLinks: 0, subtitleSets: 0, debates: 0, pages: 0, lastBackup: 0, secretGuardOff: 0 };

test("one erase for everything: Panic Wipe, Inactivity Wipe and closure remove batch 9's data, and the export has it first", async (t) => {
  const svc = fixture(t);
  await svc.stopWork();
  let at = T0;
  t.mock.method(Date, "now", () => at);
  const panic = await person(svc, "petra");
  const idle = await person(svc, "ivan");
  const closing = await person(svc, "cleo");
  for (const p of [panic, idle, closing]) await seed(svc, p);
  for (const p of [panic, idle, closing]) assert.deepEqual(left(svc, p.id), SEEDED);

  // The account export has each server-side item.
  const exported = (await panic.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.characters.length, 1);
  assert.equal(exported.characters[0].share_links.length, 1);
  assert.equal(exported.characters[0].avatar, "mono:cobalt");
  const burnt = exported.shareLinks.filter((l) => l.burn_after_reading);
  assert.equal(burnt.length, 1);
  assert.equal(burnt[0].url, null, "a burn link's address is never exported");
  assert.equal(exported.subtitleSets.length, 1);
  assert.deepEqual(exported.subtitleSets[0].tracks, SET().tracks);
  assert.ok(exported.conversations.some((c) => JSON.stringify(c).includes("Judge: too close to call.")), "the debate");
  assert.ok(exported.conversations.some((c) => c.mode === "code" && JSON.stringify(c).includes("Small-batch coffee")), "the page");
  assert.equal(typeof exported.encryptedBackup.last_backup, "string");
  assert.ok(exported.conversations.some((c) => c.restored_from_backup), "the restore mark");

  // Panic Wipe.
  await panic.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.deepEqual(left(svc, panic.id), ERASED);
  // Closure.
  await closing.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.deepEqual(left(svc, closing.id), ERASED);
  // The other account is untouched so far.
  assert.deepEqual(left(svc, idle.id), SEEDED);

  // Inactivity Wipe: the worker's erase, past the deadline, as Panic Wipe.
  await idle.agent.put("/api/inactivity-wipe").send({ days: 30, confirm: true }).expect(200);
  const row = svc.db.prepare("SELECT * FROM inactivity_wipe WHERE user_id=?").get(idle.id);
  at = row.last_active + 32 * DAY;
  svc.db
    .prepare("INSERT INTO inactivity_clock(id,last_sweep) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_sweep=excluded.last_sweep")
    .run(at - 60_000);
  assert.equal((await svc.inactivity.sweep(at)).erased, 1);
  assert.deepEqual(left(svc, idle.id), ERASED);
  // All three share the one erase.
  const wipe = source("server/routes/account.js");
  for (const f of ["forgetCharacters", "forgetSubtitleSets", "forgetAccountBackup", "forgetSecretGuard", "forgetContracts"])
    assert.match(wipe, new RegExp(`\\n  ${f}\\(db, id\\);`), f);
  assert.match(wipe, /DELETE FROM share_burns WHERE user_id=\?/);
});

// ---- Cross-feature rules --------------------------------------------------------

test("Auto Model: the new feature pages offer no Auto, and their servers refuse an auto field", async (t) => {
  for (const page of ["Characters", "ShotToSite", "ContractReader", "Subtitles", "PdfRedact", "Debate"])
    assert.doesNotMatch(source(`src/${page}.jsx`), /auto-model|AutoModel/, page);
  const svc = fixture(t);
  const p = await person(svc, "auto");
  const refused = async (path, body, code) => {
    const r = await p.agent.post(path).send({ ...body, auto: {} }).expect(400);
    assert.equal(r.body.error.code, code, path);
  };
  await refused("/api/debate/quote", { question: "Is tea better than coffee?", rounds: 1, model_a: MODEL, model_b: MODEL }, "invalid_request");
  await refused("/api/debate", { question: "Is tea better than coffee?", rounds: 1, model_a: MODEL, model_b: MODEL }, "invalid_request");
  await refused("/api/subtitles/translate/quote", { target: "es", model: MODEL, sizes: [100] }, "auto_not_offered");
  await refused("/api/chat", { model: MODEL, ephemeral: true, shottosite: { task: "make", notes: "x" } }, "invalid_shottosite");
  await refused("/api/chat", { model: MODEL, contract: { id: "x" } }, "invalid_contract");
});

test("Model Status: every new model-calling route is instrumented", () => {
  // Debate's turns and judge use Deep Research's caller.
  assert.match(source("server/routes/debate.js"), /researchCaller\(ctx, \{ m, isPrivate, controller \}\)/);
  assert.match(source("server/research.js"), /const probe = ctx\.modelStatus\.start\(m\.id\);/);
  // Subtitles' transcription and translation.
  const subs = source("server/routes/subtitles.js");
  assert.match(subs, /const probe = ctx\.modelStatus\.start\(run\.stt\.id\);/);
  assert.match(subs, /const probe = ctx\.modelStatus\.start\(m\.id\);/);
  // Screenshot to site, Contract Reader and character chats run in runChat.
  const chat = source("server/routes/chat.js");
  assert.match(chat, /prepareSiteRequest\(req\.body\)/);
  assert.match(chat, /prepareContractRequest\(req, ctx\.contractReader\.cache\)/);
  assert.match(chat, /const probe = ctx\.modelStatus\.start\(m\.id\);/);
});

test("the tool directory finds the new tools by intent, in English and Chinese", () => {
  const ws = source("src/Workspace.jsx");
  const entries = [...ws.matchAll(/^\s+\["(\w+)", "([^"]+)", "([^"]+)"\],$/gm)].map((m) => [m[1], m[2], m[3]]);
  const nav = entries.slice(entries.findIndex((e) => e[0] === "home"), entries.findIndex((e) => e[0] === "library") + 1);
  const first = (q) => rankTools(nav, q)[0]?.[0];
  for (const [q, id] of [
    ["make a character", "characters"],
    ["roleplay", "characters"],
    ["角色扮演", "characters"],
    ["screenshot to website", "screenshot"],
    ["wireframe to html", "screenshot"],
    ["截图转网站", "screenshot"],
    ["who controls this token", "contracts"],
    ["智能合约", "contracts"],
    ["add subtitles to my video", "subtitles"],
    ["字幕", "subtitles"],
    ["redact a pdf", "pdfredact"],
    ["black out names", "pdfredact"],
    ["涂黑", "pdfredact"],
    ["debate two models", "debate"],
    ["pros and cons", "debate"],
    ["辩论", "debate"],
  ])
    assert.equal(first(q), id, q);
  const tags = source("src/tool-search.js");
  for (const id of ["characters", "screenshot", "contracts", "subtitles", "pdfredact", "debate"])
    assert.match(tags, new RegExp(`^  ${id}: '[^']*\\p{Script=Han}`, "mu"), id);
});

test("the API contract documents every new route, lists them only once released, and has no garbled text", () => {
  const files = ["characters", "shot-to-site", "contract-reader", "secret-guard", "account-backup", "subtitles", "debate"];
  let seen = 0;
  for (const file of files.map((f) => `server/routes/${f}.js`))
    for (const [, method, path] of source(file).matchAll(/app\.(get|post|patch|delete|put)\(\s*"([^"*]+)"/g)) {
      seen++;
      const spec = openapi.paths[path.replace(/:(\w+)/g, "{$1}")]?.[method];
      assert.ok(spec, `${method} ${path}`);
      assert.ok(spec.summary && spec.summary.length > 5, `${method} ${path} has a summary`);
    }
  assert.ok(seen >= 40, `${seen} new routes`);
  assert.ok(openapi.paths["/api/s/{token}/open"]?.post, "Burn After Reading's open");
  const text = JSON.stringify(openapi);
  assert.doesNotMatch(text, /�|Ã.|â€|<<<<<<<|>>>>>>>|=======/);
  const all = JSON.stringify(openapiForConfig({ released: "all" }).paths);
  const mvp = JSON.stringify(openapiForConfig({ released: "mvp" }).paths);
  for (const p of ["/api/characters", "/api/site-pages", "/api/contracts", "/api/secret-guard", "/api/account/backup", "/api/subtitles", "/api/debate"]) {
    assert.ok(all.includes(`"${p}`), p);
    assert.ok(!mvp.includes(`"${p}`), p);
  }
});

test("the ten updates are registered unreleased with an icon each", () => {
  for (const id of BATCH9) {
    const u = UPDATES.find((x) => x.id === id);
    assert.ok(u, id);
    assert.equal(typeof committed[UPDATES.indexOf(u)], "boolean");
    assert.equal(u.points.length, 3, id);
  }
  const pages = source("src/Pages.jsx");
  const icons = pages.slice(pages.indexOf("const featureIcons = {"), pages.indexOf("};", pages.indexOf("const featureIcons = {")));
  for (const id of BATCH9) assert.match(icons, new RegExp(`\\n  ${id}: "`), id);
});

test("the strings batch 9's integration adds have Chinese and Spanish", () => {
  const zh = JSON.parse(source("src/i18n/zh.json")).strings;
  const es = JSON.parse(source("src/i18n/es.json")).strings;
  for (const s of [
    "Mask and add",
    "Add anyway",
    "Characters and their pictures",
    "Saved subtitles",
    "Share links, Burn After Reading links and character copy links never go in a backup.",
    "On by default. The chat composer (and Code & Build), attached text files, Canvas, Routines, Research Watch, Characters, Screenshot to site, Debate and subtitle translations.",
  ]) {
    assert.ok(zh[s], "zh: " + s);
    assert.ok(es[s], "es: " + s);
  }
  for (const file of ["src/Characters.jsx", "src/ShotToSite.jsx", "src/Debate.jsx", "src/Subtitles.jsx"]) {
    const note = /note="([^"]+)"/g;
    for (const [, s] of source(file).matchAll(note))
      if (s.startsWith("Mask swaps")) {
        assert.ok(zh[s], "zh: " + s);
        assert.ok(es[s], "es: " + s);
      }
  }
});
