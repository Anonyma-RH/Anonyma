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
import { createApp } from "../server/app.js";
import { now, uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { VAULT_ITERATIONS, SALT_BYTES, IV_BYTES, deriveVaultKey, fromBase64 } from "../src/device-vault.js";
import {
  BACKUP_CIPHER,
  BACKUP_ERRORS,
  BACKUP_KDF,
  BackupError,
  backupPassphraseProblem,
  chunkAad,
  damagedMessage,
  headerBytes,
  openBackup,
  passphraseStrength,
  readHeader,
  startBackup,
} from "../src/account-backup.js";
import {
  BACKUP_EXTENSION,
  BACKUP_FORMAT,
  CHUNK_BYTES,
  MIN_BACKUP_PASSPHRASE,
  backupFileName,
  chatKey,
  itemSeedFinding,
  messageText,
  readItem,
  restoreShape,
  RESTORE_MODES,
  makeKinds,
  restoredMode,
} from "../src/account-backup-spec.js";
import { loadBackup, writerFor } from "../src/account-backup-engine.js";
import { makeBackup, restoreBackup } from "../src/account-backup-run.js";

// Encrypted Backup (update "backup"): the file is made and opened in the
// browser; the server hands over the account's own content, keeps the day
// of the last backup, and takes back what a restore chose.
//
// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const PASS = "correct horse battery staple";
const MODEL = "google/gemini-2.5-flash";
const ORIGIN = "http://localhost:5175";
const ABANDON_12 = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const DAY = 86400000;

function fixture(t, released = "all", extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-account-backup-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: ORIGIN,
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
async function person(app, username = "b" + (++visitor).toString(36) + Math.random().toString(36).slice(2, 6)) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("Origin", ORIGIN)
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
// The page's `api` over a signed-in supertest agent.
const apiFor = (agent) => async (path, { method = "GET", body } = {}) => {
  const r = await agent[method.toLowerCase()](path).send(body);
  if (r.status >= 400)
    throw Object.assign(Error(r.body?.error?.message || "failed"), { status: r.status, code: r.body?.error?.code });
  return r.body;
};
// A saved chat written straight into the database, as the chat route would.
function savedChat(s, user, { title = "A chat", words = ["hello", "hi there"], model = MODEL, at = now() - DAY, mode = "chat" } = {}) {
  const id = uid("c_");
  s.db
    .prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)")
    .run(id, user, title, mode, at, at + 1000);
  const ids = words.map((w, i) => {
    const mid = uid("m_");
    const role = i % 2 ? "assistant" : "user";
    s.db
      .prepare("INSERT INTO messages(id,conversation_id,role,content,model,cost,created,author_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(mid, id, role, JSON.stringify(role === "user" ? w : { text: w, finish_reason: "stop", reasoning: "hidden" }), role === "assistant" ? model : null, 12, at + i, role === "user" ? user : null);
    return mid;
  });
  return { id, messages: ids };
}
const bytesOf = (pieces) => {
  const out = new Uint8Array(pieces.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of pieces) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
};
// A backup of these lines, made with `chunkBytes`-sized parts.
async function sealed(lines, { passphrase = PASS, chunkBytes } = {}) {
  const w = await startBackup(passphrase, { chunkBytes });
  const parts = [];
  for (const line of lines) parts.push(...(await w.push(line)));
  const done = await w.finish();
  return { bytes: bytesOf([done.header, ...parts, ...done.parts]), chunks: done.chunks };
}
const reopen = async (bytes, passphrase = PASS) => {
  const lines = [];
  const header = await openBackup(bytes, passphrase, { onLine: (l) => lines.push(l) });
  return { header, lines };
};
const rejects = (promise, code) => assert.rejects(promise, (e) => e instanceof BackupError && e.code === code);

// ---- The file ---------------------------------------------------------------------

test("encrypt and decrypt round trip, across many parts, and at the real 4 MB part size", async () => {
  const lines = Array.from({ length: 60 }, (_, i) => JSON.stringify({ t: "chat", n: i, text: "ü€𝄞 ".repeat(40) + i }) + "\n");
  const small = await sealed(lines, { chunkBytes: 1024 });
  assert.ok(small.chunks > 8, "many parts");
  const back = await reopen(small.bytes);
  assert.deepEqual(back.lines.map((l) => l.n), lines.map((_, i) => i));
  assert.equal(back.lines[5].text, "ü€𝄞 ".repeat(40) + 5, "multi-byte characters split across parts come back whole");
  // The default size: a little over 8 MB of text is three parts.
  const big = Array.from({ length: 9 }, (_, i) => JSON.stringify({ t: "chat", n: i, text: "x".repeat(1024 * 1024) }) + "\n");
  const real = await sealed(big);
  assert.equal(real.chunks, 3);
  const { header, lines: out } = await reopen(new Blob([real.bytes]));
  assert.equal(header.chunk_bytes, CHUNK_BYTES);
  assert.deepEqual(out.map((l) => l.n), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  // Each part has its own random IV and is at most one part of ciphertext.
  let at = real.bytes.indexOf(10) + 1;
  const ivs = new Set();
  for (let i = 0; i < real.chunks; i++) {
    const n = new DataView(real.bytes.buffer, real.bytes.byteOffset + at).getUint32(0);
    assert.ok(n <= CHUNK_BYTES + 16);
    ivs.add(Buffer.from(real.bytes.subarray(at + 4, at + 4 + IV_BYTES)).toString("hex"));
    at += 4 + IV_BYTES + n;
  }
  assert.equal(ivs.size, real.chunks);
  assert.equal(at, real.bytes.length);
  // An empty backup (just the manifest) is one part.
  assert.equal((await sealed([JSON.stringify({ t: "manifest" }) + "\n"])).chunks, 1);
});

test("the header: format, version, Device Vault's KDF parameters, salt, part count and day; nothing about the content", async () => {
  const { bytes, chunks } = await sealed(['{"t":"manifest"}\n', '{"t":"chat","title":"Secret title"}\n'], { chunkBytes: 16 });
  const { header, length } = readHeader(bytes);
  assert.equal(header.format, BACKUP_FORMAT);
  assert.equal(header.version, 1);
  assert.deepEqual(
    { name: header.kdf.name, hash: header.kdf.hash, iterations: header.kdf.iterations },
    { name: "PBKDF2", hash: "SHA-256", iterations: VAULT_ITERATIONS },
  );
  assert.equal(VAULT_ITERATIONS, 600000);
  assert.equal(BACKUP_KDF.iterations, VAULT_ITERATIONS);
  assert.equal(BACKUP_KDF.saltBytes, SALT_BYTES);
  assert.equal(fromBase64(header.kdf.salt).length, SALT_BYTES);
  assert.equal(header.cipher, BACKUP_CIPHER);
  assert.equal(BACKUP_CIPHER, "AES-256-GCM");
  assert.equal(header.chunks, chunks);
  assert.match(header.created, /^\d{4}-\d{2}-\d{2}$/);
  const text = Buffer.from(bytes.subarray(0, length)).toString("utf8");
  assert.ok(!text.includes("Secret") && !text.includes("chat"), "the header says nothing of what's inside");
  // The key is Device Vault's own derivation: the vault's function opens part 1.
  const key = await deriveVaultKey(PASS, fromBase64(header.kdf.salt), header.kdf.iterations);
  const n = new DataView(bytes.buffer, bytes.byteOffset + length).getUint32(0);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: bytes.slice(length + 4, length + 4 + IV_BYTES), additionalData: new TextEncoder().encode(chunkAad(0, chunks === 1)) },
    key,
    bytes.slice(length + 4 + IV_BYTES, length + 4 + IV_BYTES + n),
  );
  assert.equal(new TextDecoder().decode(plain), '{"t":"manifest"}');
  // A file asking for fewer iterations, or a different cipher, is refused
  // before any key is derived.
  const edit = (change) => {
    const h = JSON.parse(Buffer.from(bytes.subarray(0, length - 1)).toString("utf8"));
    change(h);
    return new Uint8Array(Buffer.concat([Buffer.from(headerBytes(h)), Buffer.from(bytes.subarray(length))]));
  };
  for (const change of [
    (h) => (h.kdf.iterations = 1000),
    (h) => (h.kdf.hash = "SHA-1"),
    (h) => (h.cipher = "AES-128-CBC"),
    (h) => (h.format = "something-else"),
    (h) => (h.version = 2),
    (h) => (h.kdf.salt = "AAAA"),
    (h) => (h.chunks = 0),
    (h) => (h.chunk_bytes = CHUNK_BYTES * 4),
  ])
    await rejects(reopen(edit(change)), "not_backup");
  await rejects(reopen(new TextEncoder().encode("not a backup\n")), "not_backup");
  await rejects(reopen(new TextEncoder().encode("{}")), "not_backup");
  assert.equal(backupFileName(new Date("2026-09-29T10:00:00Z")), "anonyma-backup-2026-09-29" + BACKUP_EXTENSION);
  assert.equal(backupFileName("2026-09-28"), "anonyma-backup-2026-09-28" + BACKUP_EXTENSION);
});

test("a wrong passphrase fails cleanly, told apart from a damaged file", async () => {
  const { bytes } = await sealed(['{"t":"manifest"}\n', '{"t":"memory","text":"x"}\n']);
  const e = await openBackup(bytes, "a different passphrase entirely").catch((err) => err);
  assert.ok(e instanceof BackupError);
  assert.equal(e.code, "wrong_passphrase");
  assert.equal(e.message, BACKUP_ERRORS.wrong_passphrase);
  await rejects(openBackup(bytes, ""), "wrong_passphrase");
});

test("a tampered, reordered, cut or extended file fails, naming the part", async () => {
  const lines = Array.from({ length: 12 }, (_, i) => JSON.stringify({ t: "memory", text: "fact " + i }) + "\n");
  const { bytes, chunks } = await sealed(lines, { chunkBytes: 64 });
  assert.ok(chunks >= 4);
  const start = bytes.indexOf(10) + 1;
  const offsets = [];
  for (let at = start; at < bytes.length; ) {
    const n = new DataView(bytes.buffer, bytes.byteOffset + at).getUint32(0);
    offsets.push([at, 4 + IV_BYTES + n]);
    at += 4 + IV_BYTES + n;
  }
  // One flipped bit in part 2's ciphertext.
  const flipped = bytes.slice();
  flipped[offsets[1][0] + 4 + IV_BYTES + 3] ^= 1;
  const e = await openBackup(flipped, PASS).catch((err) => err);
  assert.equal(e.code, "damaged");
  assert.equal(e.message, damagedMessage(2, chunks));
  // Parts 2 and 3 swapped.
  const [a, b] = [offsets[1], offsets[2]];
  const swapped = bytesOf([bytes.subarray(0, a[0]), bytes.subarray(b[0], b[0] + b[1]), bytes.subarray(a[0], a[0] + a[1]), bytes.subarray(b[0] + b[1])]);
  assert.equal((await openBackup(swapped, PASS).catch((err) => err)).code, "damaged");
  // The last part dropped and the header's count lowered to match: the new
  // last part wasn't sealed as the last one.
  const h = readHeader(bytes).header;
  const shorter = bytesOf([headerBytes({ ...h, chunks: chunks - 1 }), bytes.subarray(start, offsets.at(-1)[0])]);
  assert.equal((await openBackup(shorter, PASS).catch((err) => err)).code, "damaged");
  // Cut off mid-part, or with bytes after the end.
  await rejects(openBackup(bytes.subarray(0, bytes.length - 5), PASS), "truncated");
  assert.equal((await openBackup(bytesOf([bytes, new Uint8Array([1, 2, 3])]), PASS).catch((err) => err)).code, "damaged");
  // Nothing before the failing part is lost silently: the caller gets an
  // error, not a partial restore.
  let seen = 0;
  await assert.rejects(openBackup(flipped, PASS, { onLine: () => seen++ }));
  assert.ok(seen < lines.length);
});

test("the passphrase: a minimum length, and weak ones refused; the meter's words", async () => {
  assert.equal(MIN_BACKUP_PASSPHRASE, 12);
  assert.equal(backupPassphraseProblem("short one"), BACKUP_ERRORS.short_passphrase);
  assert.equal(backupPassphraseProblem("aaaaaaaaaaaaaaaa"), BACKUP_ERRORS.weak_passphrase);
  assert.equal(backupPassphraseProblem("123456789012"), BACKUP_ERRORS.weak_passphrase);
  assert.equal(backupPassphraseProblem("password1234"), BACKUP_ERRORS.weak_passphrase);
  assert.equal(backupPassphraseProblem(PASS), null);
  assert.equal(backupPassphraseProblem("qmzvtrplkwxd"), null, "12 random letters are enough");
  assert.equal(passphraseStrength("").label, "");
  assert.equal(passphraseStrength("aaaaaaaaaaaaaaaa").label, "Weak");
  assert.equal(passphraseStrength(PASS).label, "Very strong");
  assert.ok(["Fair", "Strong"].includes(passphraseStrength("qmzvtrplkwxd").label));
  await assert.rejects(startBackup("too short"), (e) => e instanceof BackupError && e.message === BACKUP_ERRORS.short_passphrase);
});

// ---- Items, and the reader in the worker ---------------------------------------------

test("items are read back tolerantly but checked; the reader counts, flags and never touches the network", async () => {
  assert.equal(messageText("plain"), "plain");
  assert.equal(messageText({ text: "reply", reasoning: "r" }), "reply");
  assert.equal(messageText([{ type: "text", text: "a" }, { type: "image_url", image_url: { url: "data:..." } }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(messageText(null), "");
  assert.equal(readItem({ t: "chat", messages: [{ role: "system", text: "x" }] }), null);
  assert.equal(readItem({ t: "nope" }), null);
  assert.equal(readItem({ t: "scroll", title: "x" }), null);
  assert.equal(readItem({ t: "routine", name: "r", prompt: "p", model: MODEL, schedule: { repeat: "daily", time: "08:00" }, per_run_credits: 1, monthly_budget_credits: 10 }).schedule.timezone, "UTC");
  // A chat's key is its words: not its title, ids or dates, and the same
  // after Chat Import's cleaning.
  assert.equal(
    chatKey([{ role: "user", text: "hi\r\n" }, { role: "assistant", content: { text: "yo" } }]),
    chatKey([{ role: "user", text: " hi" }, { role: "assistant", text: "yo\u0007" }, { role: "assistant", text: "  " }]),
  );
  assert.notEqual(chatKey([{ role: "user", text: "hi" }]), chatKey([{ role: "assistant", text: "hi" }]));
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = (...a) => {
    calls.push(a);
    throw Error("no network expected");
  };
  try {
    const items = [
      { t: "manifest", format: BACKUP_FORMAT, created: "2026-09-01T10:00:00.000Z" },
      { t: "project", id: "prj_1", name: "Garden", color: "cobalt", instructions: "Be brief.", starts: "normal", model: null, created: 1 },
      { t: "chat", id: "c_1", title: "Tomatoes", created: Date.UTC(2025, 0, 3), updated: Date.UTC(2025, 0, 4), project: "prj_1", messages: [{ id: "m_1", role: "user", text: "When to plant?", created: 1 }, { id: "m_2", role: "assistant", text: "In spring.", model: MODEL, created: 2 }] },
      { t: "chat", id: "c_2", title: "Same words", created: Date.UTC(2026, 8, 1), updated: Date.UTC(2026, 8, 2), messages: [{ id: "m_3", role: "user", text: "When to plant?", created: 1 }, { id: "m_4", role: "assistant", text: "In spring.", created: 2 }] },
      { t: "chat", id: "c_3", title: "Wallet", created: Date.UTC(2026, 0, 1), updated: Date.UTC(2026, 0, 1), messages: [{ id: "m_5", role: "user", text: ABANDON_12, created: 1 }] },
      { t: "bookmark", message_id: "m_2", conversation_id: "c_1", note: "keep", created: 1 },
      { t: "bookmark", message_id: "m_missing", conversation_id: "c_9", note: "gone", created: 1 },
      { t: "scroll", title: "Recipe", body: "Write a {{dish}} recipe.", created: 1 },
      { t: "instructions", body: "Answer in English.", enabled: true },
      { t: "instructions", body: "A second one.", enabled: true },
      { t: "memory", text: "I live in Lisbon.", enabled: true, created: 1 },
      { t: "vault", chat: { id: "v1", title: "Vaulted", mode: "chat", messages: [{ role: "user", content: "secret" }] } },
      { t: "watch", url: "https://example.com", model: MODEL, every: "daily", monthly_budget_credits: 10 },
    ];
    const { bytes } = await sealed([...items.map((i) => JSON.stringify(i) + "\n"), "not json\n", JSON.stringify({ t: "chat" }) + "\n"], { chunkBytes: 100 });
    const session = await loadBackup(bytes, PASS, { seedGuard: true });
    const o = session.overview();
    assert.equal(o.made, "2026-09-01T10:00:00.000Z");
    assert.deepEqual(o.counts, { projects: 1, chats: 2, bookmarks: 1, scrolls: 1, instructions: 1, memory: 1, routines: 0, research: 0, watches: 1, vault: 1 });
    assert.equal(o.seed.chats, 1, "Seed Guard flags the chat with a seed phrase");
    assert.equal(o.unreadable, 2);
    assert.deepEqual(o.range, { from: Date.UTC(2025, 0, 3), to: Date.UTC(2026, 0, 1) });
    assert.deepEqual(session.get("chats", 0, 5).map((c) => c.title), ["Tomatoes", "Wallet"]);
    assert.deepEqual(session.get("chats", 1, 5).map((c) => c.n), [1]);
    // Without Seed Guard, nothing is flagged.
    assert.equal((await loadBackup(bytes, PASS)).overview().seed.chats, 0);
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(calls, [], "opening a backup and choosing sends nothing");
  assert.equal(itemSeedFinding({ t: "scroll", title: "x", body: ABANDON_12 }), true);
  assert.equal(itemSeedFinding({ t: "memory", text: "I like tea" }), false);
});

test("what a restore sends for a chat: words, dates, the model, its project and bookmark notes; never old ids", () => {
  const chat = readItem({
    t: "chat",
    id: "c_old",
    title: "T",
    created: 5,
    updated: 6,
    project: "prj_old",
    messages: [
      { id: "m_a", role: "user", text: "q", model: "ignored", created: 5 },
      { id: "m_b", role: "assistant", text: "a", model: MODEL, created: 6 },
    ],
  });
  const shaped = restoreShape(chat, { project: "prj_new", notes: new Map([["m_b", "star"]]) });
  assert.deepEqual(shaped, {
    title: "T",
    created: 5,
    updated: 6,
    project: "prj_new",
    messages: [
      { role: "user", text: "q", created: 5 },
      { role: "assistant", text: "a", created: 6, model: MODEL, bookmark: "star" },
    ],
  });
  assert.ok(!JSON.stringify(shaped).includes("_old") && !JSON.stringify(shaped).includes("m_"));
  assert.equal(restoreShape(chat, { allowSeed: true }).allow_seed_phrase, true);
});

// ---- The server ---------------------------------------------------------------------

const ROUTES = [
  ["get", "/api/account/backup"],
  ["get", "/api/account/backup/content"],
  ["get", "/api/account/backup/chats"],
  ["post", "/api/account/backup/made"],
  ["post", "/api/account/backup/reminder"],
  ["post", "/api/account/backup/restore/chats"],
  ["post", "/api/account/backup/restore/scrolls"],
];

test("unreleased: every route is refused and nothing is stored, listed, exported or documented", async (t) => {
  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app);
  savedChat(mvp, a.user.id);
  for (const [method, path] of [...ROUTES, ["get", "/API/Account/Backup"], ["post", "/api/account/backup/anything"]]) {
    const res = await a.agent[method](path).send({ chats: [{ messages: [{ role: "user", text: "x" }] }] }).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased", path);
    assert.equal(res.body.error.message, "Encrypted Backup is coming soon.");
  }
  assert.equal(mvp.db.prepare("SELECT COUNT(*) n FROM account_backups").get().n, 0);
  assert.equal(mvp.db.prepare("SELECT COUNT(*) n FROM backup_restores").get().n, 0);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.backup, false);
  const entry = config.releases.updates.find((u) => u.id === "backup");
  assert.equal(entry.title, "Encrypted Backup");
  assert.equal(entry.tagline, "Take everything with you in one file, locked with a passphrase only you know.");
  assert.equal(entry.points.length, 3);
  assert.equal(entry.released, false);
  assert.equal(typeof committed[UPDATES.findIndex((u) => u.id === "backup")], "boolean", "registered, and flipped only by a release commit");
  const docs = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(docs.paths).some((p) => p.startsWith("/api/account/backup")), "the served API docs leave it out");
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.ok(!("encryptedBackup" in exported));
  assert.ok(!JSON.stringify(exported.conversations).includes("restored_from_backup"));
  assert.ok((await a.agent.get("/api/conversations").expect(200)).body.data.every((c) => !("restored" in c)));
  // Released on its own it needs nothing else for its own routes; the docs list them.
  const own = fixture(t, "mvp,backup");
  const b = await person(own.app);
  await b.agent.get("/api/account/backup").expect(200);
  await b.agent.get("/api/account/backup/content").expect(200);
  await b.agent.get("/api/account/backup/chats").expect(200);
  await request(own.app).get("/api/account/backup").expect(401);
  const open = (await request(own.app).get("/api/openapi.json").expect(200)).body;
  for (const [method, path] of ROUTES.filter(([, p]) => !p.endsWith("/scrolls"))) assert.ok(open.paths[path]?.[method], path);
  assert.ok(!open.paths["/api/account/backup/restore/scrolls"], "restoring scrolls is documented once Scrolls is live too");
  // A restore that files chats in projects, restores bookmarks or scrolls
  // needs those updates too.
  const chats = (extra) => ({ chats: [{ title: "x", messages: [{ role: "user", text: "hello", ...extra.message }], ...extra.chat }] });
  const res = await b.agent.post("/api/account/backup/restore/chats").send(chats({ chat: { project: "prj_x" }, message: {} })).expect(403);
  assert.equal(res.body.error.message, "Projects is coming soon.");
  await b.agent.post("/api/account/backup/restore/chats").send(chats({ chat: {}, message: { bookmark: "n" } })).expect(403);
  await b.agent.post("/api/account/backup/restore/scrolls").send({ scrolls: [{ title: "t", body: "b" }] }).expect(403);
  await b.agent.post("/api/account/backup/restore/chats").send(chats({ chat: {}, message: {} })).expect(200);
  // The gate as the server states it.
  const gate = (path, method = "GET", body = {}) => featuresFor({ path, method, body });
  for (const [method, path] of ROUTES) assert.equal(gate(path, method.toUpperCase())[0], "backup", path);
  assert.deepEqual(gate("/api/account/backup/restore/scrolls", "POST"), ["backup", "scrolls"]);
  assert.deepEqual(gate("/api/account/backup/restore/chats", "POST", { chats: [{ project: "p", messages: [{ bookmark: "n" }] }] }), ["backup", "projects", "bookmarks"]);
  assert.ok(!gate("/api/account/export").includes("backup"));
  assert.ok(!gate("/api/account/backups").includes("backup"), "only /api/account/backup itself");
});

test("the last backup is a date only; the reminder comes once, 30 days later, and starts over with the next backup", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const status = async () => (await a.agent.get("/api/account/backup").expect(200)).body;
  assert.equal((await status()).last_backup, null);
  assert.equal((await status()).reminder, false);
  const made = (await a.agent.post("/api/account/backup/made").send({ file: "anything", size: 123 }).expect(200)).body;
  const today = new Date().toISOString().slice(0, 10);
  assert.deepEqual(made, { last_backup: today, reminder: false });
  const row = s.db.prepare("SELECT * FROM account_backups WHERE user_id=?").get(a.user.id);
  assert.deepEqual(Object.keys(row).sort(), ["last_backup", "reminded", "user_id"], "nothing but the day and the reminder");
  assert.equal(row.last_backup, today);
  // The browser's own day is kept when it is within a day of the server's;
  // anything else is the server's UTC day.
  const yesterday = new Date(Date.now() - DAY).toISOString().slice(0, 10);
  assert.equal((await a.agent.post("/api/account/backup/made").send({ day: yesterday }).expect(200)).body.last_backup, yesterday);
  for (const day of ["2020-01-01", "not a day", 20260929, "2026-13-45"])
    assert.equal((await a.agent.post("/api/account/backup/made").send({ day }).expect(200)).body.last_backup, today);
  // 29 days: not yet. 30 days: once.
  const ago = (days) => new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
  s.db.prepare("UPDATE account_backups SET last_backup=? WHERE user_id=?").run(ago(29), a.user.id);
  assert.equal((await status()).reminder, false);
  s.db.prepare("UPDATE account_backups SET last_backup=? WHERE user_id=?").run(ago(30), a.user.id);
  assert.equal((await status()).reminder, true);
  assert.equal((await a.agent.post("/api/account/backup/reminder").send({}).expect(200)).body.reminder, false);
  assert.equal((await status()).reminder, false, "once");
  s.db.prepare("UPDATE account_backups SET last_backup=? WHERE user_id=?").run(ago(90), a.user.id);
  assert.equal((await status()).reminder, false, "still once, however long it has been");
  // The next backup starts it over.
  await a.agent.post("/api/account/backup/made").send({}).expect(200);
  s.db.prepare("UPDATE account_backups SET last_backup=? WHERE user_id=?").run(ago(31), a.user.id);
  assert.equal((await status()).reminder, true);
  // Another account sees none of it; no backup means no reminder ever.
  const b = await person(s.app);
  assert.deepEqual((await b.agent.get("/api/account/backup").expect(200)).body.last_backup, null);
  assert.equal((await b.agent.post("/api/account/backup/reminder").send({}).expect(200)).body.reminder, false);
});

test("the content a backup holds: the account's own chats in pages, and settings without results", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const other = await person(s.app);
  savedChat(s, other.user.id, { title: "Not mine" });
  const chats = Array.from({ length: 30 }, (_, i) => savedChat(s, a.user.id, { title: "Chat " + i, words: ["q" + i, "a" + i] }));
  // A message with an image part and one with a reply object.
  s.db.prepare("UPDATE messages SET content=? WHERE id=?").run(JSON.stringify([{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }]), chats[0].messages[0]);
  // Expired chats and shared team chats aren't included.
  const gone = savedChat(s, a.user.id, { title: "Expired" });
  s.db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(now() - 1000, gone.id);
  await a.agent.post("/api/memory/facts").send({ text: "I live in Lisbon." }).expect(201);
  await a.agent.post("/api/scrolls").send({ title: "Recipe", body: "Write a {{dish}} recipe." }).expect(201);
  await a.agent.put("/api/instructions").send({ body: "Answer in English.", enabled: true }).expect(200);
  const project = (await a.agent.post("/api/projects").send({ name: "Garden", instructions: "Be brief." }).expect(201)).body;
  await a.agent.post(`/api/projects/${project.id}/chats`).send({ conversationId: chats[1].id }).expect(200);
  await a.agent.post("/api/bookmarks").send({ message_id: chats[2].messages[1], note: "keep" }).expect(201);
  await a.agent
    .post("/api/routines")
    .send({ name: "News", prompt: "Top AI news.", model: MODEL, schedule: { repeat: "weekdays", time: "08:00", timezone: "UTC" }, per_run_credits: 50, monthly_budget_credits: 500 })
    .expect(201);
  const status = (await a.agent.get("/api/account/backup").expect(200)).body;
  assert.deepEqual(status.counts, { chats: 30, bookmarks: 1, projects: 1, scrolls: 1, instructions: 1, memory: 1, routines: 1, research: 0, watches: 0 });
  const content = (await a.agent.get("/api/account/backup/content").expect(200)).body;
  assert.deepEqual(content.projects.map((p) => [p.name, p.instructions]), [["Garden", "Be brief."]]);
  assert.deepEqual(content.scrolls.map((x) => x.title), ["Recipe"]);
  assert.deepEqual(content.instructions, { body: "Answer in English.", enabled: true });
  assert.deepEqual(content.memory.map((f) => [f.text, f.enabled]), [["I live in Lisbon.", true]]);
  assert.equal(content.routines.length, 1);
  assert.deepEqual(Object.keys(content.routines[0]).sort(), ["created", "model", "monthly_budget_credits", "name", "per_run_credits", "private_only", "prompt", "schedule", "web_search"]);
  assert.deepEqual(content.bookmarks.map((b) => [b.message_id, b.note]), [[chats[2].messages[1], "keep"]]);
  // Pages: 25 then 5, oldest first, only this account's live personal chats.
  const first = (await a.agent.get("/api/account/backup/chats").expect(200)).body;
  assert.equal(first.chats.length, 25);
  assert.ok(Number.isInteger(first.next));
  const second = (await a.agent.get("/api/account/backup/chats").query({ after: first.next }).expect(200)).body;
  assert.equal(second.chats.length, 5);
  assert.equal(second.next, null);
  const all = [...first.chats, ...second.chats];
  assert.deepEqual(all.map((c) => c.title), chats.map((_, i) => "Chat " + i));
  assert.equal(all[1].project, project.id);
  assert.deepEqual(all[0].messages.map((m) => [m.role, m.text, m.model]), [["user", "look", null], ["assistant", "a0", MODEL]]);
  assert.deepEqual(Object.keys(all[0].messages[0]).sort(), ["created", "id", "model", "role", "text"], "words only: no costs, reasoning or images");
  assert.ok(!JSON.stringify(all).includes("data:image") && !JSON.stringify(all).includes("hidden"));
  await a.agent.get("/api/account/backup/chats").query({ after: "-1" }).expect(400);
  // The other account's view is its own.
  const theirs = (await other.agent.get("/api/account/backup/chats").expect(200)).body.chats;
  assert.deepEqual(theirs.map((c) => c.title), ["Not mine"]);
});

const restoreChats = (p, chats) => p.agent.post("/api/account/backup/restore/chats").send({ chats });
const backupChat = (n, extra = {}) => ({
  title: "Restored " + n,
  created: Date.UTC(2025, 0, 1 + n),
  updated: Date.UTC(2025, 0, 2 + n),
  messages: [
    { role: "user", text: "question " + n, created: Date.UTC(2025, 0, 1 + n, 9) },
    { role: "assistant", text: "answer " + n, created: Date.UTC(2025, 0, 1 + n, 9, 1), model: MODEL },
  ],
  ...extra,
});

test("restoring chats adds ordinary saved chats marked as restored, with their words, dates and models", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const res = (await restoreChats(a, [backupChat(1), backupChat(2)]).expect(200)).body;
  assert.equal(res.saved.length, 2);
  assert.deepEqual(res.skipped, []);
  const opened = (await a.agent.get("/api/conversations/" + res.saved[0].id).expect(200)).body;
  assert.equal(opened.restored, true);
  assert.equal(opened.title, "Restored 1");
  assert.equal(opened.mode, "chat");
  assert.deepEqual(opened.messages.map((m) => [m.role, m.model]), [["user", null], ["assistant", MODEL]]);
  const rows = s.db.prepare("SELECT role,content,cost,created FROM messages WHERE conversation_id=? ORDER BY created").all(res.saved[0].id);
  assert.deepEqual(rows.map((m) => [m.role, JSON.parse(m.content).text ?? JSON.parse(m.content), m.cost]), [["user", "question 1", 0], ["assistant", "answer 1", 0]]);
  assert.equal(rows[0].created, Date.UTC(2025, 0, 2, 9));
  const listed = (await a.agent.get("/api/conversations").expect(200)).body.data;
  assert.ok(listed.filter((c) => res.saved.some((x) => x.id === c.id)).every((c) => c.restored === true));
  const mark = s.db.prepare("SELECT * FROM backup_restores WHERE conversation_id=?").get(res.saved[0].id);
  assert.equal(mark.user_id, a.user.id);
  assert.match(mark.content_hash, /^[0-9a-f]{64}$/);
  // An ordinary chat isn't marked.
  const plain = savedChat(s, a.user.id);
  assert.ok(!("restored" in (await a.agent.get("/api/conversations/" + plain.id).expect(200)).body));
  // Nothing is charged: no model is called.
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM holds WHERE user_id=?").get(a.user.id).n, 0);
  await request(s.app).post("/api/account/backup/restore/chats").send({ chats: [backupChat(3)] }).expect(401);
});

test("a restore never replaces: chats already in the account, restored before, or twice in one request are skipped", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  // The account already has these words (a chat written here, with a reply
  // object, extra whitespace and a different title).
  savedChat(s, a.user.id, { title: "Mine", words: ["question 1  ", "answer 1"] });
  const before = s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(a.user.id).n;
  const res = (await restoreChats(a, [backupChat(1), backupChat(2), backupChat(2, { title: "Renamed" })]).expect(200)).body;
  assert.deepEqual(res.saved.map((x) => x.index), [1]);
  assert.deepEqual(res.skipped, [{ index: 0, reason: "duplicate" }, { index: 2, reason: "duplicate" }]);
  const again = (await restoreChats(a, [backupChat(2), backupChat(3)]).expect(200)).body;
  assert.deepEqual(again.skipped, [{ index: 0, reason: "duplicate" }]);
  assert.equal(again.saved.length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(a.user.id).n, before + 2);
  // Another account restores the same file freely.
  const b = await person(s.app);
  assert.equal((await restoreChats(b, [backupChat(1), backupChat(2)]).expect(200)).body.saved.length, 2);
});

test("a restored chat goes back into its project with its bookmarks; limits are kept and nothing is pruned", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const project = (await a.agent.post("/api/projects").send({ name: "Garden" }).expect(201)).body;
  const other = await person(s.app);
  const theirs = (await other.agent.post("/api/projects").send({ name: "Theirs" }).expect(201)).body;
  const withNote = backupChat(1, { project: project.id });
  withNote.messages[1].bookmark = "the answer";
  const res = (await restoreChats(a, [withNote, backupChat(2, { project: theirs.id })]).expect(200)).body;
  assert.equal(res.saved[0].project, project.id);
  assert.equal(res.saved[0].bookmarks, 1);
  assert.ok(!("project" in res.saved[1]), "another account's project is never used");
  const filed = s.db.prepare("SELECT project_id FROM project_chats WHERE conversation_id=?").get(res.saved[0].id);
  assert.equal(filed.project_id, project.id);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM project_chats WHERE conversation_id=?").get(res.saved[1].id).n, 0);
  const marks = (await a.agent.get("/api/bookmarks").expect(200)).body.data || (await a.agent.get("/api/bookmarks").expect(200)).body.bookmarks;
  assert.equal(marks.length, 1);
  assert.equal(marks[0].note, "the answer");
  assert.equal(marks[0].conversation_id, res.saved[0].id);
  // The saved-chat cap is never pruned by a restore.
  const c = await person(s.app);
  const cap = (await c.agent.get("/api/import/status").expect(200)).body.cap;
  const insert = s.db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)");
  for (let i = 0; i < cap - 1; i++) insert.run(uid("c_"), c.user.id, "old " + i, "chat", i + 1, i + 1);
  const full = (await restoreChats(c, [backupChat(1), backupChat(2)]).expect(200)).body;
  assert.equal(full.saved.length, 1);
  assert.deepEqual(full.skipped, [{ index: 1, reason: "conversation_limit" }]);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(c.user.id).n, cap);
  // What the route accepts.
  await a.agent.post("/api/account/backup/restore/chats").send({ chats: [] }).expect(400);
  await a.agent.post("/api/account/backup/restore/chats").send({ chats: Array(21).fill(backupChat(1)) }).expect(400);
  const odd = (await restoreChats(a, [{ messages: "x" }, { messages: [{ role: "user", text: "   " }] }, { messages: [{ role: "system", text: "x" }] }]).expect(200)).body;
  assert.deepEqual(odd.skipped.map((x) => x.reason), ["invalid", "empty", "invalid"]);
});

test("Seed Guard: a restored chat or scroll with a seed phrase is skipped unless that item is allowed, only when it's live", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const risky = backupChat(1, { title: "Wallet" });
  risky.messages[0].text = "my words: " + ABANDON_12;
  const res = (await restoreChats(a, [risky]).expect(200)).body;
  assert.deepEqual(res.skipped, [{ index: 0, reason: "seed_phrase_blocked" }]);
  assert.equal((await restoreChats(a, [{ ...risky, allow_seed_phrase: true }]).expect(200)).body.saved.length, 1);
  const scroll = { title: "Keys", body: ABANDON_12 };
  const sres = (await a.agent.post("/api/account/backup/restore/scrolls").send({ scrolls: [scroll] }).expect(200)).body;
  assert.deepEqual(sres.skipped, [{ index: 0, reason: "seed_phrase_blocked" }]);
  assert.equal((await a.agent.post("/api/account/backup/restore/scrolls").send({ scrolls: [{ ...scroll, allow_seed_phrase: true }] }).expect(200)).body.saved.length, 1);
  // Before Seed Guard is live, nothing is held back.
  const early = fixture(t, [...UPDATES.map((u) => u.id).filter((id) => id !== "seedguard")].join(","));
  const b = await person(early.app);
  assert.equal((await restoreChats(b, [risky]).expect(200)).body.saved.length, 1);
});

test("restoring scrolls keeps Scrolls' limits and skips what's already here", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  await a.agent.post("/api/scrolls").send({ title: "Recipe", body: "Write a {{dish}} recipe." }).expect(201);
  const res = (
    await a.agent
      .post("/api/account/backup/restore/scrolls")
      .send({ scrolls: [{ title: "Recipe", body: "Write a {{dish}} recipe." }, { title: "Poem", body: "A poem about {{topic}}.", created: Date.UTC(2025, 1, 1) }, { title: "x".repeat(81), body: "b" }, { title: "Empty", body: "  " }] })
      .expect(200)
  ).body;
  assert.equal(res.saved.length, 1);
  assert.deepEqual(res.skipped, [{ index: 0, reason: "duplicate" }, { index: 2, reason: "invalid" }, { index: 3, reason: "invalid" }]);
  const poem = s.db.prepare("SELECT * FROM scrolls WHERE id=?").get(res.saved[0].id);
  assert.equal(poem.created, Date.UTC(2025, 1, 1));
  const insert = s.db.prepare("INSERT INTO scrolls(id,user_id,title,body,created,updated) VALUES(?,?,?,?,?,?)");
  for (let i = 0; i < 198; i++) insert.run(uid("scroll_"), a.user.id, "s" + i, "b" + i, 1, 1);
  const full = (await a.agent.post("/api/account/backup/restore/scrolls").send({ scrolls: [{ title: "One", body: "more" }] }).expect(200)).body;
  assert.deepEqual(full.skipped, [{ index: 0, reason: "scroll_limit" }]);
  await a.agent.post("/api/account/backup/restore/scrolls").send({ scrolls: Array(101).fill({ title: "t", body: "b" }) }).expect(400);
});

test("the date and the marks are exported, and account closure, Panic Wipe and Inactivity Wipe's erase remove them", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  await a.agent.post("/api/account/backup/made").send({}).expect(200);
  const saved = (await restoreChats(a, [backupChat(1)]).expect(200)).body.saved[0];
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.deepEqual(exported.encryptedBackup, { last_backup: new Date().toISOString().slice(0, 10), reminder_seen: null });
  const mine = exported.conversations.find((c) => c.id === saved.id);
  assert.ok(Number.isInteger(mine.restored_from_backup.restored));
  assert.match(mine.restored_from_backup.words_sha256, /^[0-9a-f]{64}$/);
  // Before any backup, the export says so.
  const fresh = await person(s.app);
  assert.equal((await fresh.agent.get("/api/account/export").expect(200)).body.encryptedBackup, null);
  // Panic Wipe.
  await a.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM account_backups WHERE user_id=?").get(a.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM backup_restores WHERE user_id=?").get(a.user.id).n, 0);
  // Account closure.
  const b = await person(s.app);
  await b.agent.post("/api/account/backup/made").send({}).expect(200);
  await restoreChats(b, [backupChat(2)]).expect(200);
  await b.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM account_backups WHERE user_id=?").get(b.user.id).n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM backup_restores WHERE user_id=?").get(b.user.id).n, 0);
  // Deleting the chats takes their marks.
  const c = await person(s.app);
  await restoreChats(c, [backupChat(3)]).expect(200);
  await c.agent.delete("/api/conversations").expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM backup_restores WHERE user_id=?").get(c.user.id).n, 0);
  // The erase is the shared one Inactivity Wipe also runs.
  assert.match(readFileSync(new URL("../server/routes/account.js", import.meta.url), "utf8"), /forgetAccountBackup\(db, id\)/);
});

test("nothing about a backup or a restore is logged", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const written = [];
  const keep = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  for (const name of Object.keys(keep)) console[name] = (...args) => written.push(args.map(String).join(" "));
  try {
    savedChat(s, a.user.id, { title: "Secret title marker", words: ["secret words marker", "reply marker"] });
    await a.agent.get("/api/account/backup/chats").expect(200);
    await a.agent.post("/api/account/backup/made").send({}).expect(200);
    await restoreChats(a, [backupChat(1, { title: "Restored marker" }), { messages: "bad marker" }]).expect(200);
    await a.agent.post("/api/account/backup/restore/scrolls").send({ scrolls: [{ title: "Scroll marker", body: "body marker" }] }).expect(200);
  } finally {
    Object.assign(console, keep);
  }
  const log = written.join("\n");
  assert.ok(!log.includes("marker"), log.slice(0, 200));
});

// ---- The page's runs: making and restoring ------------------------------------------

// The worker's protocol on this thread (the in-page engine the client falls
// back to), with `get` over an opened session.
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

test("making a backup reads only what was chosen, sends nothing, and the file opens with its passphrase", async () => {
  const calls = [];
  const content = {
    projects: [{ id: "prj_1", name: "Garden", color: "cobalt", instructions: "Be brief.", starts: "normal", model: null, created: 1 }],
    scrolls: [{ title: "Recipe", body: "Write a {{dish}} recipe.", created: 2 }],
    instructions: { body: "Answer in English.", enabled: true },
    memory: [{ text: "I live in Lisbon.", enabled: true, created: 3 }],
    routines: [],
    research: [],
    watches: [],
    bookmarks: [{ message_id: "m_2", conversation_id: "c_1", note: "keep", created: 4 }],
  };
  const pages = {
    "": { chats: [{ id: "c_1", title: "One", created: 10, updated: 11, project: "prj_1", messages: [{ id: "m_1", role: "user", text: "q", model: null, created: 10 }, { id: "m_2", role: "assistant", text: "a", model: MODEL, created: 11 }] }], next: 7 },
    7: { chats: [{ id: "c_2", title: "Two", created: 12, updated: 13, project: null, messages: [{ id: "m_3", role: "user", text: "q2", model: null, created: 12 }] }], next: null },
  };
  const api = async (path, opts = {}) => {
    calls.push([opts.method || "GET", path]);
    if (path === "/api/account/backup/content") return content;
    const after = new URL(path, "http://x").searchParams.get("after") ?? "";
    return pages[after];
  };
  const engine = await engineFor();
  const vaultChats = [{ id: "v1", title: "Vaulted", mode: "chat", messages: [{ role: "user", content: "device only" }], updated: 1 }];
  const progress = [];
  const made = await makeBackup({
    api,
    engine,
    passphrase: PASS,
    include: new Set(["chats", "bookmarks", "projects", "scrolls", "memory", "vault"]),
    vaultChats,
    created: Date.UTC(2026, 8, 29, 12),
    onProgress: (p) => progress.push(p.step),
  });
  assert.ok(calls.every(([method]) => method === "GET"), "making a backup only reads");
  assert.deepEqual(calls.map(([, p]) => p), ["/api/account/backup/content", "/api/account/backup/chats", "/api/account/backup/chats?after=7"]);
  assert.deepEqual(made.counts, { projects: 1, scrolls: 1, memory: 1, bookmarks: 1, chats: 2, vault: 1 });
  assert.ok(progress.includes("sealing"));
  const file = new Blob(made.pieces);
  assert.equal(file.size, made.bytes);
  const engine2 = await engineFor();
  const o = await engine2.open(file, PASS);
  assert.equal(o.made, "2026-09-29T12:00:00.000Z");
  assert.deepEqual(o.counts, { projects: 1, chats: 2, bookmarks: 1, scrolls: 1, instructions: 0, memory: 1, routines: 0, research: 0, watches: 0, vault: 1 });
  assert.deepEqual((await engine2.get("vault", 0, 5))[0].chat, vaultChats[0]);
  // Without the vault, the vault's chats aren't in it; the words never
  // appear unencrypted in the file.
  const plain = await makeBackup({ api, engine: await engineFor(), passphrase: PASS, include: new Set(["memory"]), vaultChats });
  const bytes = Buffer.from(bytesOf(plain.pieces));
  assert.ok(!bytes.includes("device only") && !bytes.includes("Lisbon"));
  const e3 = await engineFor();
  assert.deepEqual((await e3.open(new Blob(plain.pieces), PASS)).counts.vault, 0);
  // Stopping stops.
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(makeBackup({ api, engine: await engineFor(), passphrase: PASS, include: new Set(["chats"]), signal: controller.signal }), (e) => e.code === "stopped");
});

test("restoring sends only the chosen kinds, holds back Seed Guard's finds unless allowed, and brings routines and watches back switched off", async () => {
  const items = [
    { t: "manifest", format: BACKUP_FORMAT, created: "2026-09-01T00:00:00.000Z" },
    { t: "project", id: "prj_old", name: "Garden", color: "cobalt", instructions: "Be brief.", starts: "private", model: "gone/model" },
    { t: "project", id: "prj_dup", name: "Existing", instructions: "Same." },
    { t: "chat", id: "c_1", title: "One", created: 1, updated: 2, project: "prj_old", messages: [{ id: "m_1", role: "user", text: "q", created: 1 }, { id: "m_2", role: "assistant", text: "a", model: MODEL, created: 2 }] },
    { t: "chat", id: "c_2", title: "Seed", created: 3, updated: 4, project: "prj_dup", messages: [{ id: "m_3", role: "user", text: ABANDON_12, created: 3 }] },
    { t: "bookmark", message_id: "m_2", conversation_id: "c_1", note: "keep", created: 1 },
    { t: "scroll", title: "Recipe", body: "Write it." },
    { t: "memory", text: "I live in Lisbon.", enabled: true },
    { t: "memory", text: "i live in lisbon.", enabled: true },
    { t: "routine", name: "News", prompt: "Top news.", model: MODEL, schedule: { repeat: "daily", time: "08:00", timezone: "UTC" }, per_run_credits: 5, monthly_budget_credits: 50 },
    { t: "research", name: "", topic: "Fusion", model: MODEL, depth: "quick", schedule: { repeat: "weekly", time: "09:00", day: 1, timezone: "UTC" }, monthly_budget_credits: 100 },
    { t: "watch", url: "https://example.com/a", hint: "prices", model: MODEL, every: "daily", monthly_budget_credits: 20 },
    { t: "watch", url: "https://example.com/b", model: MODEL, every: "weekly", monthly_budget_credits: 20 },
    { t: "vault", chat: { id: "v_new", title: "New", mode: "chat", messages: [{ role: "user", content: "new words" }], updated: 1 } },
    { t: "vault", chat: { id: "v_have", title: "Have", mode: "chat", messages: [{ role: "user", content: "old words" }], updated: 1 } },
  ];
  const { bytes } = await sealed(items.map((i) => JSON.stringify(i) + "\n"));
  const calls = [];
  let projectTries = 0;
  const api = async (path, { method = "GET", body } = {}) => {
    calls.push([method, path, body]);
    if (method === "GET") {
      if (path === "/api/projects") return { projects: [{ id: "prj_here", name: "existing", instructions: "Same." }] };
      if (path === "/api/memory") return { facts: [] };
      if (path === "/api/routines") return { routines: [] };
      if (path === "/api/research-watches") return { watches: [] };
      if (path === "/api/watches") return { watches: [{ url: "https://example.com/b" }] };
      throw Error("unexpected " + path);
    }
    if (path === "/api/projects") {
      if (++projectTries === 1) throw Object.assign(Error("Choose a chat model, or no default."), { status: 400, code: "invalid_model" });
      return { id: "prj_new" };
    }
    if (path === "/api/account/backup/restore/chats") return { saved: body.chats.map((_, index) => ({ index, id: "c_new" + index, bookmarks: body.chats[index].messages.filter((m) => m.bookmark).length })), skipped: [] };
    if (path === "/api/account/backup/restore/scrolls") return { saved: body.scrolls.map((_, index) => ({ index, id: "s" })), skipped: [] };
    if (path === "/api/watches" && body.url.endsWith("/a")) return {};
    return {};
  };
  const engine = await engineFor();
  const real = globalThis.fetch;
  globalThis.fetch = () => {
    throw Error("no network expected");
  };
  let overview;
  try {
    overview = await engine.open(bytes, PASS, { seedGuard: true });
  } finally {
    globalThis.fetch = real;
  }
  assert.equal(overview.seed.chats, 1);
  assert.deepEqual(calls, [], "nothing is sent before the restore is chosen");
  // Only chats and bookmarks: nothing else is read or sent.
  const only = await restoreBackup({ api, engine, choice: new Set(["chats", "bookmarks"]) });
  assert.equal(only.error, null);
  assert.deepEqual([...new Set(calls.map(([m, p]) => m + " " + p))], ["POST /api/account/backup/restore/chats"]);
  const sent = calls.flatMap(([, , b]) => b.chats);
  assert.deepEqual(sent.map((c) => c.title), ["One"], "the seed-phrase chat is held back, not sent");
  assert.ok(!JSON.stringify(sent).includes("abandon"));
  assert.equal(sent[0].project, undefined, "no project restored, so no project to file in");
  assert.equal(sent[0].messages[1].bookmark, "keep");
  assert.deepEqual(only.report.chats, { added: 1, duplicate: 0, seed: 1, limit: 0, failed: 0, message: null, fallback: 0, modes: [] });
  assert.equal(only.report.bookmarks.added, 1);
  // Everything, the seed-phrase chat allowed; the vault is unlocked.
  calls.length = 0;
  const saved = [];
  const vault = {
    unlocked: true,
    chats: [{ id: "v_other", messages: [{ role: "user", content: "old words" }] }],
    saveMany: async (list) => void saved.push(...list),
  };
  const every = await restoreBackup({
    api,
    engine,
    choice: new Set(["projects", "chats", "bookmarks", "scrolls", "memory", "routines", "research", "watches", "vault"]),
    allowSeed: new Set(["chats"]),
    vault,
  });
  assert.equal(every.error, null);
  // A project whose model is gone comes back with its name and instructions.
  const projectPosts = calls.filter(([m, p]) => m === "POST" && p === "/api/projects").map(([, , b]) => b);
  assert.deepEqual(projectPosts, [
    { name: "Garden", color: "cobalt", instructions: "Be brief.", privacy: "private", model: "gone/model" },
    { name: "Garden", instructions: "Be brief." },
  ]);
  assert.deepEqual(every.report.projects, { added: 1, duplicate: 1, seed: 0, limit: 0, failed: 0, message: null });
  const chats = calls.filter(([, p]) => p === "/api/account/backup/restore/chats").flatMap(([, , b]) => b.chats);
  assert.deepEqual(chats.map((c) => [c.title, c.project ?? null, c.allow_seed_phrase ?? false]), [["One", "prj_new", false], ["Seed", "prj_here", true]]);
  // Memory: the same fact twice is added once.
  assert.deepEqual(every.report.memory, { added: 1, duplicate: 1, seed: 0, limit: 0, failed: 0, message: null });
  // Routines and watches: switched off.
  const posted = (path) => calls.filter(([m, p]) => m === "POST" && p === path).map(([, , b]) => b);
  assert.deepEqual(posted("/api/routines").map((b) => b.enabled), [false]);
  assert.deepEqual(posted("/api/research-watches").map((b) => [b.topic, b.enabled, "name" in b]), [["Fusion", false, false]]);
  assert.deepEqual(posted("/api/watches").map((b) => [b.url, b.enabled]), [["https://example.com/a", false]]);
  assert.equal(every.report.watches.duplicate, 1, "a page already watched is skipped");
  // Vault chats go into the vault only, never to the server; one with the
  // same words as a chat already there is skipped.
  assert.deepEqual(saved.map((c) => c.id), ["v_new"]);
  assert.ok(!JSON.stringify(calls).includes("new words"));
  assert.deepEqual(every.report.vault, { added: 1, duplicate: 1, seed: 0, limit: 0, failed: 0, message: null });
  // A failure that can't be skipped stops the restore and says so.
  const broken = await restoreBackup({
    api: async () => {
      throw Object.assign(Error("The service could not be reached. Please try again."), { status: 0 });
    },
    engine,
    choice: new Set(["chats"]),
  });
  assert.equal(broken.error.message, "The service could not be reached. Please try again.");
});

test("the whole trip: one account's backup restored into another, adding, skipping repeats, and never replacing", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const chats = [0, 1, 2].map((i) => savedChat(s, a.user.id, { title: "Chat " + i, words: ["question " + i, "answer " + i] }));
  const project = (await a.agent.post("/api/projects").send({ name: "Garden", instructions: "Be brief." }).expect(201)).body;
  await a.agent.post(`/api/projects/${project.id}/chats`).send({ conversationId: chats[0].id }).expect(200);
  await a.agent.post("/api/bookmarks").send({ message_id: chats[1].messages[1], note: "keep" }).expect(201);
  await a.agent.post("/api/scrolls").send({ title: "Recipe", body: "Write a {{dish}} recipe." }).expect(201);
  await a.agent.post("/api/memory/facts").send({ text: "I live in Lisbon." }).expect(201);
  await a.agent.put("/api/instructions").send({ body: "Answer in English.", enabled: true }).expect(200);
  await a.agent
    .post("/api/routines")
    .send({ name: "News", prompt: "Top AI news.", model: MODEL, schedule: { repeat: "weekdays", time: "08:00", timezone: "UTC" }, per_run_credits: 50, monthly_budget_credits: 500 })
    .expect(201);
  const made = await makeBackup({
    api: apiFor(a.agent),
    engine: await engineFor(),
    passphrase: PASS,
    include: new Set(["chats", "bookmarks", "projects", "scrolls", "instructions", "memory", "routines"]),
  });
  const file = new Blob(made.pieces);
  // Another account, which already has one of the chats and a fact.
  const b = await person(s.app);
  savedChat(s, b.user.id, { title: "Mine already", words: ["question 2", "answer 2"] });
  await b.agent.post("/api/memory/facts").send({ text: "I live in Lisbon." }).expect(201);
  await b.agent.put("/api/instructions").send({ body: "Mine stay.", enabled: true }).expect(200);
  const before = s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(b.user.id).n;
  const engine = await engineFor();
  const overview = await engine.open(file, PASS, { seedGuard: true });
  assert.equal(overview.counts.chats, 3);
  const choice = new Set(["projects", "chats", "bookmarks", "scrolls", "instructions", "memory", "routines"]);
  const { report, error } = await restoreBackup({ api: apiFor(b.agent), engine, choice });
  assert.equal(error, null);
  assert.equal(report.chats.added, 2);
  assert.equal(report.chats.duplicate, 1);
  assert.equal(report.projects.added, 1);
  assert.equal(report.bookmarks.added, 1);
  assert.equal(report.scrolls.added, 1);
  assert.equal(report.memory.duplicate, 1);
  assert.equal(report.instructions.duplicate, 1, "one per account: yours stay");
  assert.equal(report.routines.added, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(b.user.id).n, before + 2);
  const theirProject = s.db.prepare("SELECT id FROM projects WHERE user_id=?").get(b.user.id).id;
  const filed = s.db.prepare("SELECT c.title FROM project_chats pc JOIN conversations c ON c.id=pc.conversation_id WHERE pc.project_id=?").all(theirProject);
  assert.deepEqual(filed.map((r) => r.title), ["Chat 0"]);
  const routine = s.db.prepare("SELECT enabled,next_run FROM routines WHERE user_id=?").get(b.user.id);
  assert.deepEqual({ ...routine }, { enabled: 0, next_run: null }, "a restored routine is off until turned on");
  assert.equal(s.db.prepare("SELECT body FROM user_instructions WHERE user_id=?").get(b.user.id).body, "Mine stay.");
  // The same backup again adds nothing.
  const again = await restoreBackup({ api: apiFor(b.agent), engine, choice });
  assert.equal(again.report.chats.added, 0);
  assert.equal(again.report.chats.duplicate, 3);
  assert.equal(again.report.projects.duplicate, 1);
  assert.equal(again.report.scrolls.duplicate, 1);
  assert.equal(again.report.routines.duplicate, 1);
  // The first account is unchanged by all of it.
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations WHERE user_id=?").get(a.user.id).n, 3);
});

// ---- The page ------------------------------------------------------------------------

// A JSX module with its UI stand-ins, loaded as the other page tests load them.
async function jsxModule(name) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-account-backup-ui-"));
  const react = import.meta.resolve("react");
  const router = import.meta.resolve("react-router-dom");
  const ui = join(dir, "ui.mjs");
  writeFileSync(
    ui,
    `import React from "${react}";
     export const Icon = () => React.createElement("svg");
     export const Button = ({ children, secondary, ...rest }) => React.createElement("button", rest, children);
     export const Notice = ({ children }) => React.createElement("div", null, children);
     export const Modal = ({ title, children }) => React.createElement("div", { className: "modal" }, React.createElement("h2", null, title), children);`,
  );
  try {
    const file = new URL(`../src/${name}`, import.meta.url);
    const { code } = await transformWithEsbuild(readFileSync(file, "utf8"), file.pathname, { jsx: "transform", format: "esm" });
    const out = code
      .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
      .replace(/from "\.\/ui\.jsx"/g, `from "${pathToFileURL(ui).href}"`)
      .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
      .replace(/from "react-router-dom"/g, `from "${router}"`)
      .replace(/from "react"/g, `from "${react}"`);
    const mod = join(dir, name.replace(/\.jsx$/, ".mjs"));
    writeFileSync(mod, out);
    return await import(pathToFileURL(mod).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const cfg = (features) => ({ releases: { features } });

test("the page: nothing shows until it's released; then Account → Settings has the section and the workspace the reminder", async () => {
  const { BackupSettings, backupReleased, dayLabel } = await jsxModule("AccountBackup.jsx");
  const user = { id: "u1" };
  assert.equal(renderToStaticMarkup(createElement(BackupSettings, { config: cfg({}), user })), "");
  assert.equal(renderToStaticMarkup(createElement(BackupSettings, { config: cfg({ backup: true }), user: null })), "");
  const html = renderToStaticMarkup(createElement(BackupSettings, { config: cfg({ backup: true }), user }));
  assert.match(html, /id="backup"/);
  assert.match(html, /Encrypted backup\./);
  assert.match(html, /Make a backup/);
  assert.match(html, /Restore a backup/);
  assert.match(html, /Lose the passphrase and the backup can’t be opened, by you or by us\./);
  assert.equal(backupReleased(cfg({})), false);
  assert.equal(dayLabel("2026-09-29"), new Date(2026, 8, 29).toLocaleDateString());
  // Where it's placed, and that its heavy code loads only when a dialog opens.
  const account = readFileSync(new URL("../src/Account.jsx", import.meta.url), "utf8");
  assert.match(account, /\{!demo && user && <BackupSettings config=\{config\} user=\{user\} \/>\}/);
  const section = readFileSync(new URL("../src/AccountBackup.jsx", import.meta.url), "utf8");
  assert.match(section, /const BackupDialog = lazy\(\(\) => import\("\.\/BackupDialog\.jsx"\)\)/);
  assert.ok(!/account-backup-run|account-backup\.js"|account-backup-client/.test(section), "no crypto or restore code in the Account page itself");
  assert.match(readFileSync(new URL("../src/account-backup-client.js", import.meta.url), "utf8"), /new Worker\(new URL\("\.\/account-backup\.worker\.js", import\.meta\.url\), \{ type: "module" \}\)/);
  // The workspace: the reminder, the list's mark and the chat's banner, each
  // only once released.
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(ws, /<BackupReminder config=\{config\} user=\{user\} demo=\{demo\} \/>/);
  assert.match(ws, /\{c\.restored && isReleased\(config, "backup"\) && \(/);
  assert.match(ws, /const restoredChat = !demo && isReleased\(config, "backup"\)/);
  const { BackupReminder, BackupNudge } = await jsxModule("BackupReminder.jsx");
  assert.equal(renderToStaticMarkup(createElement(BackupReminder, { config: cfg({}), user })), "");
  assert.equal(renderToStaticMarkup(createElement(BackupReminder, { config: cfg({ backup: true }), user })), "", "shown only when the server says it's due");
  const { MemoryRouter } = await import("react-router-dom");
  const nudge = renderToStaticMarkup(createElement(MemoryRouter, null, createElement(BackupNudge, { q: "" })));
  assert.match(nudge, /href="\/account\/settings#backup"/);
  assert.match(nudge, /Not now/);
  // The privacy guide and Panic Wipe's lists say what's kept and what isn't.
  assert.match(readFileSync(new URL("../src/DataControls.jsx", import.meta.url), "utf8"), /const backup = !!config && isReleased\(config, "backup"\)/);
  assert.match(readFileSync(new URL("../src/PanicWipe.jsx", import.meta.url), "utf8"), /\{backupLive && <li>\{WIPE_BACKUP_FILES_STAY\}<\/li>\}/);
  // The server copies the shared module it imports.
  assert.match(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"), /src\/account-backup-spec\.js/);
});

test("every string the update adds has Chinese and Spanish", () => {
  const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const es = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/es.json", import.meta.url), "utf8")), "es");
  const entry = UPDATES.find((u) => u.id === "backup");
  const texts = [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Encrypted Backup is coming soon.",
    ...Object.values(BACKUP_ERRORS),
    damagedMessage(2, 5),
    "Encrypted backup.",
    "Take everything with you in one file, locked with a passphrase only you know. Restore it into any ANONYMA account.",
    "Checking your last backup…",
    "Last backup: 9/29/2026",
    "No backup made yet.",
    "Make a backup",
    "Restore a backup",
    "Lose the passphrase and the backup can’t be opened, by you or by us.",
    "Saved chats",
    "Projects and their instructions",
    "Memory facts",
    "Routines (their settings)",
    "Research watches (their settings)",
    "Page watches (their settings)",
    "Device Vault chats",
    "Device Vault passphrase",
    ...["Weak", "Fair", "Strong", "Very strong"],
    "At least 12 characters",
    "Stopped. No file was saved.",
    "Backup saved",
    "Make an encrypted backup",
    "What goes in",
    "Backup passphrase (at least 12 characters)",
    "Encrypting your chats… 120 so far",
    "Preparing the key… this takes a few seconds.",
    "Make and save the backup",
    "Backup restored",
    "Restore stopped",
    "3 added",
    "1 already here",
    "2 held back by Seed Guard",
    "1 over your account’s limit",
    "1 not restored",
    "Choose what to restore",
    "In this backup",
    "Made on 9/29/2026.",
    "Chats from 1/3/2025 to 9/28/2026.",
    "Seed Guard is holding back 2 items that look like they contain a seed phrase or private key. They won’t be restored.",
    "Restore chats and scrolls anyway…",
    "Yes, restore them",
    "Keep them out",
    "Restoring: Saved chats",
    "Restore",
    "Open backup",
    "Opening… part 3 of 12",
    "Backup file (.anonyma-backup, up to 512 MB)",
    "Backup passphrase",
    "Restored from a backup.",
    "Restored from a backup",
    "Its words and dates came from your backup file.",
    "It’s been a month since your last backup.",
    "Make a fresh one so it has your newest chats.",
    "The day of your last encrypted backup",
    "Backup files you saved. They were never on our servers, so delete them yourself if you need to.",
    "Restored routines and watches are switched off, so nothing runs or costs anything until you turn them on in Routines.",
  ];
  for (const text of texts) {
    assert.match(translateText(text, zh) || "", /\p{Script=Han}/u, text);
    const spanish = translateText(text, es) || "";
    assert.ok(spanish && spanish !== text, "Spanish for " + text);
  }
});

test("Veil: a chat's unmask map travels inside the encrypted file and comes back in this browser under the new id, never sent", async () => {
  const veil = { map: { EMAIL_1: "ana@example.com" }, counters: { EMAIL: 1 }, valueToTag: { "ana@example.com": "EMAIL_1" } };
  const api = async (path) =>
    path === "/api/account/backup/chats"
      ? { chats: [{ id: "c_1", title: "Mail", created: 1, updated: 2, project: null, messages: [{ id: "m_1", role: "user", text: "Write to [EMAIL_1]", created: 1 }] }], next: null }
      : { chats: [], next: null };
  const made = await makeBackup({ api, engine: await engineFor(), passphrase: PASS, include: new Set(["chats"]), veilFor: (id) => (id === "c_1" ? veil : null) });
  assert.ok(!Buffer.from(bytesOf(made.pieces)).includes("ana@example.com"), "encrypted, like everything else");
  const engine = await engineFor();
  await engine.open(new Blob(made.pieces), PASS);
  assert.deepEqual((await engine.get("chats", 0, 1))[0].veil, veil);
  const sent = [],
    kept = [];
  const out = await restoreBackup({
    api: async (path, { body }) => {
      sent.push(JSON.stringify(body));
      return { saved: [{ index: 0, id: "c_new" }], skipped: [] };
    },
    engine,
    choice: new Set(["chats"]),
    saveVeil: (id, state) => kept.push([id, state]),
  });
  assert.equal(out.error, null);
  assert.deepEqual(kept, [["c_new", veil]]);
  assert.ok(sent.every((b) => !b.includes("ana@example.com")), "the map is never sent");
  assert.ok(sent[0].includes("[EMAIL_1]"), "the chat's words stay masked, as saved");
  // A malformed map in a file is dropped, not trusted.
  assert.equal(readItem({ t: "chat", messages: [], veil: { map: { A: { x: 1 } } } }).veil, undefined);
});

// ---- Modes and bookmarks ---------------------------------------------------------------

test("a restored chat keeps its mode when this server has it live, and otherwise comes back as an ordinary chat that says so", async (t) => {
  assert.deepEqual(Object.keys(RESTORE_MODES), ["chat", "code", "uncensored", "symposium"]);
  const live = (ids) => (id) => ids.includes(id);
  assert.deepEqual(restoredMode("code", live(["code"])), { mode: "code", fallback: false });
  assert.deepEqual(restoredMode("code", live([])), { mode: "chat", fallback: true });
  assert.deepEqual(restoredMode("debate", live(["debate"])), { mode: "chat", fallback: true }, "an unknown mode is never stored");
  assert.deepEqual(restoredMode(undefined, live([])), { mode: "chat", fallback: false });
  const s = fixture(t);
  const a = await person(s.app);
  // The backup's pages carry each chat's mode.
  const code = savedChat(s, a.user.id, { title: "Landing page", mode: "code", words: ["make a page", "<html>…</html>"] });
  savedChat(s, a.user.id, { title: "Run", mode: "symposium", words: ["compare", "one view"] });
  const page = (await a.agent.get("/api/account/backup/chats").expect(200)).body.chats;
  assert.deepEqual(page.map((c) => [c.title, c.mode]), [["Landing page", "code"], ["Run", "symposium"]]);
  assert.equal(page[0].id, code.id);
  // Everything live: kept.
  const b = await person(s.app);
  const res = (
    await restoreChats(b, [
      backupChat(1, { mode: "code" }),
      backupChat(2, { mode: "symposium" }),
      backupChat(3, { mode: "uncensored" }),
      backupChat(4, { mode: "debate" }),
      backupChat(5),
    ]).expect(200)
  ).body;
  assert.deepEqual(res.saved.map((x) => [x.mode, x.mode_fallback ?? null]), [["code", null], ["symposium", null], ["uncensored", null], ["chat", "debate"], ["chat", null]]);
  const modes = s.db.prepare("SELECT mode FROM conversations WHERE id IN (" + res.saved.map(() => "?").join(",") + ") ORDER BY created").all(...res.saved.map((x) => x.id));
  assert.deepEqual(modes.map((m) => m.mode), ["code", "symposium", "uncensored", "chat", "chat"]);
  // A Symposium run fills the Symposium cap, not the saved-chat room, and
  // stays out of the chat list like any run.
  assert.equal(res.room, (await b.agent.get("/api/import/status").expect(200)).body.room);
  assert.ok(!(await b.agent.get("/api/conversations").expect(200)).body.data.some((c) => c.id === res.saved[1].id));
  // Code & Build and Symposium not live here: ordinary chats, marked.
  const early = fixture(t, UPDATES.map((u) => u.id).filter((id) => !["code", "symposium", "doublecheck"].includes(id)).join(","));
  const c = await person(early.app);
  const fell = (await restoreChats(c, [backupChat(1, { mode: "code" }), backupChat(2, { mode: "symposium" }), backupChat(3, { mode: "uncensored" })]).expect(200)).body;
  assert.deepEqual(fell.saved.map((x) => [x.mode, x.mode_fallback ?? null]), [["chat", "code"], ["chat", "symposium"], ["uncensored", null]]);
  // The page's run reports them.
  const { bytes } = await sealed([
    JSON.stringify({ t: "chat", id: "c1", mode: "code", title: "Site", messages: [{ id: "m1", role: "user", text: "site please" }] }) + "\n",
    JSON.stringify({ t: "chat", id: "c2", mode: "symposium", title: "Run", messages: [{ id: "m2", role: "user", text: "compare please" }] }) + "\n",
    JSON.stringify({ t: "chat", id: "c3", mode: "chat", title: "Plain", messages: [{ id: "m3", role: "user", text: "plain please" }] }) + "\n",
  ]);
  const engine = await engineFor();
  await engine.open(bytes, PASS);
  const d = await person(early.app);
  const run = await restoreBackup({ api: apiFor(d.agent), engine, choice: new Set(["chats"]) });
  assert.equal(run.error, null);
  assert.equal(run.report.chats.added, 3);
  assert.equal(run.report.chats.fallback, 2);
  assert.deepEqual(run.report.chats.modes, ["code", "symposium"]);
});

test("bookmarks: listed in what goes in, back on the same message of their restored chat, and skipped (and counted) when their chat isn't restored", async (t) => {
  const on = (ids) => (id) => ids.includes(id);
  const counts = { chats: 3, bookmarks: 2, projects: 1, scrolls: 0 };
  assert.deepEqual(makeKinds(counts, on(["bookmarks", "projects", "scrolls"])), ["chats", "bookmarks", "projects"]);
  assert.deepEqual(makeKinds(counts, on(["projects"])), ["chats", "projects"], "not before Bookmarks is live");
  assert.deepEqual(makeKinds({ bookmarks: 2 }, on(["bookmarks"])), [], "never without chats");
  const dialog = readFileSync(new URL("../src/BackupDialog.jsx", import.meta.url), "utf8");
  assert.match(dialog, /const kinds = makeKinds\(counts, released\);/);
  assert.match(dialog, /if \(!chosen\.has\("chats"\)\) chosen\.delete\("bookmarks"\);/);
  // One account with three chats, two bookmarked; another that already has
  // the first chat.
  const s = fixture(t);
  const a = await person(s.app);
  const chats = [0, 1, 2].map((i) => savedChat(s, a.user.id, { title: "Chat " + i, words: ["question " + i, "answer " + i, "more " + i] }));
  await a.agent.post("/api/bookmarks").send({ message_id: chats[0].messages[1], note: "first" }).expect(201);
  await a.agent.post("/api/bookmarks").send({ message_id: chats[2].messages[2], note: "third" }).expect(201);
  assert.equal((await a.agent.get("/api/account/backup").expect(200)).body.counts.bookmarks, 2);
  const made = await makeBackup({ api: apiFor(a.agent), engine: await engineFor(), passphrase: PASS, include: new Set(["chats", "bookmarks"]) });
  const b = await person(s.app);
  savedChat(s, b.user.id, { title: "Already", words: ["question 0", "answer 0", "more 0"] });
  const engine = await engineFor();
  const o = await engine.open(new Blob(made.pieces), PASS);
  assert.equal(o.counts.bookmarks, 2);
  const { report, error } = await restoreBackup({ api: apiFor(b.agent), engine, choice: new Set(["chats", "bookmarks"]) });
  assert.equal(error, null);
  assert.equal(report.chats.added, 2);
  assert.equal(report.chats.duplicate, 1);
  assert.equal(report.bookmarks.added, 1);
  assert.equal(report.bookmarks.unlinked, 1, "the first chat was already here, so its bookmark is skipped");
  const marks = (await b.agent.get("/api/bookmarks").expect(200)).body;
  const list = marks.data || marks.bookmarks;
  assert.equal(list.length, 1);
  assert.equal(list[0].note, "third");
  // It is on the same message: the third message of "Chat 2".
  const row = s.db.prepare("SELECT m.content,c.title FROM bookmarks k JOIN messages m ON m.id=k.message_id JOIN conversations c ON c.id=m.conversation_id WHERE k.user_id=?").get(b.user.id);
  assert.equal(row.title, "Chat 2");
  assert.equal(messageText(JSON.parse(row.content)), "more 2");
  // Without choosing bookmarks, none are sent.
  const c = await person(s.app);
  const none = await restoreBackup({ api: apiFor(c.agent), engine, choice: new Set(["chats"]) });
  assert.equal(none.report.chats.added, 3);
  assert.equal(none.report.bookmarks, undefined);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM bookmarks WHERE user_id=?").get(c.user.id).n, 0);
});

test("the new summary lines have Chinese and Spanish", () => {
  const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const es = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/es.json", import.meta.url), "utf8")), "es");
  for (const text of [
    "1 skipped: their chat wasn’t restored",
    "2 came back as ordinary chats because their mode isn’t available on this account: Code & Build, Symposium.",
    "1 came back as ordinary chats because their mode isn’t available on this account: Code & Build.",
  ]) {
    assert.match(translateText(text, zh) || "", /\p{Script=Han}/u, text);
    const spanish = translateText(text, es) || "";
    assert.ok(spanish && spanish !== text, text);
  }
});
