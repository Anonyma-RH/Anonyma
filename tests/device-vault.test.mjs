import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { buildChatRequest } from "../src/estimate.js";
import { createVeilState } from "../src/veil.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  VAULT_FORMAT,
  VAULT_ITERATIONS,
  MIN_ITERATIONS,
  MIN_PASSPHRASE,
  IV_BYTES,
  SALT_BYTES,
  IDLE_CHOICES,
  DEFAULT_IDLE_MINUTES,
  idleExpired,
  vaultReleased,
  VAULT_LIMITS,
  VAULT_ERRORS,
  VaultError,
  createVault,
  unlockVault,
  deriveVaultKey,
  sealChat,
  openChat,
  sealJson,
  fromBase64,
  toBase64,
  passphraseProblem,
  vaultChat,
  vaultTitle,
  vaultFile,
  readVaultFile,
  openVaultFile,
  mergeChats,
  newestFirst,
  vaultFileName,
} from "../src/device-vault.js";

// Device Vault: "Save on this device only". The chat goes to the server as
// an off-the-record request and the browser keeps it, encrypted, in
// IndexedDB. These tests cover the WebCrypto helpers on Node's WebCrypto,
// the vault file format, that the server stores nothing for device-only
// chats, the release gate and the Chinese copy.
//
// Release commits flip `released` on UPDATES entries. The gate tests below
// pin every update to unreleased for this file, so they keep passing after
// the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const src = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const han = /\p{Script=Han}/u;
const PASS = "correct horse battery staple";
const rejectsWith = (promise, code) =>
  assert.rejects(promise, (e) => e instanceof VaultError && e.code === code);
const sample = (id = "chat-1", text = "What is a vault?") =>
  vaultChat({
    id,
    mode: "chat",
    privateMode: false,
    messages: [
      { role: "user", content: text },
      { role: "assistant", content: "A place to keep things.", model: "m" },
    ],
    veil: createVeilState(),
    created: 1000,
    now: 2000,
  });

// ---------------------------------------------------------------------------
// Crypto helpers
// ---------------------------------------------------------------------------

test("a new vault stores a salt and a verifier, never the passphrase or a key", async () => {
  const { meta, key } = await createVault(PASS);
  assert.equal(meta.format, VAULT_FORMAT);
  assert.equal(meta.kdf.name, "PBKDF2");
  assert.equal(meta.kdf.hash, "SHA-256");
  assert.ok(VAULT_ITERATIONS >= 600000 && meta.kdf.iterations >= 600000);
  assert.equal(fromBase64(meta.kdf.salt).length, SALT_BYTES);
  assert.equal(fromBase64(meta.verifier.iv).length, IV_BYTES);
  assert.equal(meta.idleMinutes, DEFAULT_IDLE_MINUTES);
  assert.deepEqual(Object.keys(meta).sort(), ["cipher", "format", "idleMinutes", "kdf", "verifier", "version"]);
  const stored = JSON.stringify(meta);
  assert.ok(!stored.includes(PASS) && !stored.includes(toBase64(new TextEncoder().encode(PASS))));
  // The key is AES-GCM-256 and can't be exported, so it can't be persisted.
  assert.equal(key.extractable, false);
  assert.equal(key.algorithm.name, "AES-GCM");
  assert.equal(key.algorithm.length, 256);
  assert.deepEqual([...key.usages].sort(), ["decrypt", "encrypt"]);
  await assert.rejects(crypto.subtle.exportKey("raw", key));
  // Two vaults with the same passphrase get different salts.
  const other = await createVault(PASS);
  assert.notEqual(other.meta.kdf.salt, meta.kdf.salt);
});

test("round trip: a sealed chat opens with the passphrase, exactly as saved", async () => {
  const { meta } = await createVault(PASS);
  const key = await unlockVault(meta, PASS);
  const chat = sample("chat-round", "Secret plan: tulips in October");
  const record = await sealChat(key, chat);
  assert.deepEqual(Object.keys(record).sort(), ["ct", "id", "iv"]);
  assert.equal(record.id, "chat-round");
  // Nothing readable is stored: not the text, not the title.
  const raw = JSON.stringify(record) + Buffer.from(fromBase64(record.ct)).toString("latin1");
  for (const secret of ["tulips", "Secret plan", "A place to keep things"])
    assert.ok(!raw.includes(secret), secret);
  assert.deepEqual(await openChat(key, record), chat);
  // A fresh unlock (another page load) opens it too.
  assert.deepEqual(await openChat(await unlockVault(meta, PASS), record), chat);
});

test("a wrong passphrase fails, and its key opens nothing", async () => {
  const { meta, key } = await createVault(PASS);
  const record = await sealChat(key, sample());
  for (const wrong of ["correct horse battery stapler", "Correct horse battery staple", "x".repeat(40), ""])
    await rejectsWith(unlockVault(meta, wrong), "wrong_passphrase");
  // Even bypassing the verifier, a key from the wrong passphrase can't read a chat.
  const wrongKey = await deriveVaultKey("not the passphrase", fromBase64(meta.kdf.salt), meta.kdf.iterations);
  await rejectsWith(openChat(wrongKey, record), "damaged");
  assert.equal(VAULT_ERRORS.wrong_passphrase, "That passphrase doesn't open this vault.");
});

test("every record gets its own random IV, even for the same chat", async () => {
  const { meta, key } = await createVault(PASS);
  const chat = sample();
  const records = [];
  for (let i = 0; i < 64; i++) records.push(await sealChat(key, chat));
  records.push(await sealChat(key, sample("chat-2")));
  const ivs = records.map((r) => r.iv);
  for (const iv of ivs) assert.equal(fromBase64(iv).length, IV_BYTES);
  assert.equal(new Set([...ivs, meta.verifier.iv]).size, ivs.length + 1, "IVs never repeat");
  assert.equal(new Set(records.map((r) => r.ct)).size, records.length, "same chat, different ciphertext");
  for (const r of records.slice(0, 3)) assert.deepEqual(await openChat(key, r), chat);
});

test("tampering, or moving a record under another id, is detected", async () => {
  const { key } = await createVault(PASS);
  const record = await sealChat(key, sample("chat-a"));
  const bytes = fromBase64(record.ct);
  bytes[3] ^= 1;
  await rejectsWith(openChat(key, { ...record, ct: toBase64(bytes) }), "damaged");
  await rejectsWith(openChat(key, { ...record, id: "chat-b" }), "damaged");
  await rejectsWith(openChat(key, { ...record, iv: toBase64(new Uint8Array(IV_BYTES)) }), "damaged");
  // A sealed value that isn't a chat is refused too.
  const box = await sealJson(key, { id: "chat-c", messages: "nope" }, "anonyma-vault:chat:chat-c");
  await rejectsWith(openChat(key, { id: "chat-c", ...box }), "damaged");
});

test("weak settings are refused: short passphrases and too few iterations", async () => {
  assert.equal(passphraseProblem("short"), `Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  assert.equal(passphraseProblem("x".repeat(MIN_PASSPHRASE)), null);
  await rejectsWith(createVault("too short"), "short_passphrase");
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  await assert.rejects(deriveVaultKey(PASS, salt, MIN_ITERATIONS - 1));
  await assert.rejects(deriveVaultKey(PASS, salt, 100000000));
  await assert.rejects(deriveVaultKey(PASS, new Uint8Array(4)));
  // The same words typed with composed or decomposed accents open the vault.
  const { meta } = await createVault("café au lait, s'il vous plaît");
  await unlockVault(meta, "café au lait, s'il vous plaît");
});

// ---------------------------------------------------------------------------
// The vault file and what a vault chat holds
// ---------------------------------------------------------------------------

test("the exported file stays encrypted and imports with its own passphrase", async () => {
  const { meta, key } = await createVault(PASS, { idleMinutes: 30 });
  const chats = [sample("a", "first private question"), sample("b", "second private question")];
  const records = [];
  for (const c of chats) records.push(await sealChat(key, c));
  const text = vaultFile(meta, records);
  assert.ok(!text.includes("private question"));
  assert.ok(!text.includes(PASS));
  const parsed = readVaultFile(text);
  assert.deepEqual(parsed.meta, meta);
  assert.deepEqual(parsed.records, records);
  const opened = await openVaultFile(parsed, PASS);
  assert.deepEqual(opened.chats, chats);
  await rejectsWith(openVaultFile(parsed, "the wrong passphrase"), "wrong_passphrase");
  assert.match(vaultFileName(new Date("2026-09-25T10:00:00Z")), /^anonyma-device-vault-2026-09-25\.json$/);
});

test("damaged or hostile vault files are refused before any key is derived", async () => {
  const { meta, key } = await createVault(PASS);
  const good = JSON.parse(vaultFile(meta, [await sealChat(key, sample())]));
  const bad = (change) => () => readVaultFile(JSON.stringify(change(structuredClone(good))));
  const refused = (fn) => assert.throws(fn, (e) => e.code === "bad_file");
  refused(() => readVaultFile("not json"));
  refused(() => readVaultFile("null"));
  refused(bad((f) => ({ ...f, format: "something-else" })));
  refused(bad((f) => ({ ...f, version: 2 })));
  refused(bad((f) => ({ ...f, kdf: { ...f.kdf, iterations: 1000 } })));
  refused(bad((f) => ({ ...f, kdf: { ...f.kdf, hash: "SHA-1" } })));
  refused(bad((f) => ({ ...f, kdf: { ...f.kdf, salt: "AAAA" } })));
  refused(bad((f) => ({ ...f, verifier: null })));
  refused(bad((f) => ({ ...f, chats: [{ ...f.chats[0], iv: "AAAA" }] })));
  refused(bad((f) => ({ ...f, chats: [f.chats[0], f.chats[0]] })));
  refused(bad((f) => ({ ...f, chats: [{ ...f.chats[0], id: "" }] })));
  refused(bad((f) => ({ ...f, chats: "all of them" })));
  // An unknown idle setting falls back to the default.
  assert.equal(readVaultFile(JSON.stringify({ ...good, idleMinutes: 9999 })).meta.idleMinutes, DEFAULT_IDLE_MINUTES);
});

test("importing keeps new chats and newer copies, and nothing older", () => {
  const here = [{ id: "a", updated: 5 }, { id: "b", updated: 5 }];
  const incoming = [{ id: "a", updated: 9 }, { id: "b", updated: 1 }, { id: "c", updated: 2 }];
  assert.deepEqual(mergeChats(here, incoming).map((c) => c.id), ["a", "c"]);
  assert.deepEqual(newestFirst(incoming).map((c) => c.id), ["a", "c", "b"]);
});

test("a vault chat keeps the conversation as shown, its Veil map and Private Mode", () => {
  const veil = { map: { EMAIL_1: "ana@example.com" }, counters: { EMAIL: 1 }, valueToTag: { "EMAIL\u0000ana@example.com": "EMAIL_1" } };
  const chat = vaultChat({
    id: "v1",
    mode: "code",
    privateMode: true,
    messages: [
      { role: "user", content: 'Write to [EMAIL_1]\n\n<document name="notes.txt">x</document>' },
      { role: "assistant", content: "Done, [EMAIL_1].", model: "m" },
      { role: "assistant", content: "sample", sample: true },
    ],
    veil,
    now: 42,
  });
  assert.equal(chat.title, "Write to ana@example.com", "the title is unveiled and skips documents");
  assert.equal(chat.mode, "code");
  assert.equal(chat.private, true);
  assert.equal(chat.messages.length, 2, "samples are never kept");
  assert.deepEqual(chat.veil.map, veil.map);
  assert.notEqual(chat.veil.map, veil.map, "a copy, not the live map");
  assert.equal(chat.created, 42);
  assert.equal(vaultChat({ id: "x", mode: "image", messages: [] }).mode, "chat");
  assert.equal(vaultTitle([{ role: "user", content: '<document name="plan.pdf">x</document>' }]), "plan.pdf");
  assert.equal(vaultTitle([{ role: "user", content: "", images: ["data:"] }]), "Image conversation");
  assert.equal(vaultTitle([]), "New chat");
  assert.equal(vaultTitle([{ role: "user", content: "a".repeat(200) }]).length, 80);
});

test("the idle lock defaults to 15 minutes and offers a few choices", () => {
  assert.deepEqual(IDLE_CHOICES, [5, 15, 30, 60]);
  assert.equal(DEFAULT_IDLE_MINUTES, 15);
  const t0 = Date.parse("2026-09-25T12:00:00Z"), min = 60000;
  assert.equal(idleExpired(t0, t0 + 14 * min, undefined), false);
  assert.equal(idleExpired(t0, t0 + 15 * min, undefined), true, "15 minutes by default");
  assert.equal(idleExpired(t0, t0 + 4 * min, 5), false);
  assert.equal(idleExpired(t0, t0 + 5 * min, 5), true);
  assert.equal(idleExpired(t0, t0 + 59 * min, 60), false);
  assert.equal(idleExpired(t0, t0 + 20 * min, 7), true, "an unknown choice falls back to 15");
  const jsx = src("src/DeviceVault.jsx");
  assert.match(jsx, /idleExpired\(session\.last, Date\.now\(\), session\.minutes\)/);
  // Locks: on the idle timer, when the tab goes away, on Lock, and when the
  // account changes. The key lives in memory only.
  for (const needle of ['dropKey("idle")', 'dropKey("closed")', 'window.addEventListener("pagehide", onGone)', 'dropKey("account")', "lock: (reason = \"manual\") => dropKey(reason)"])
    assert.ok(jsx.includes(needle), needle);
});

// ---------------------------------------------------------------------------
// The server stores nothing for a device-only chat
// ---------------------------------------------------------------------------

const MODEL = "google/gemini-2.5-flash";
const PRIVATE_MODEL = "venice/venice-uncensored-1-2";
function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-vault-"));
  const dbPath = join(dir, "test.sqlite");
  const svc = createApp({
    testMode: true,
    dbPath,
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
    released: released ?? "all",
    mvpModels: [MODEL, PRIVATE_MODEL],
    privateModels: [PRIVATE_MODEL],
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return Object.assign(svc, { dir, dbPath });
}
async function register(app, name = "vaulter") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
// Every row of every table (virtual and shadow tables included), plus the
// database files' raw bytes, as searchable text.
function everything(s) {
  const tables = s.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.length > 10, "found the schema");
  const text = (v) =>
    v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v == null ? "" : String(v);
  const dump = [];
  for (const name of tables)
    for (const row of s.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())
      dump.push(name + ": " + Object.values(row).map(text).join(" | "));
  const rows = dump.join("\n").toLowerCase();
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const files = [s.dbPath, s.dbPath + "-wal", s.dbPath + "-journal"]
    .filter(existsSync)
    .map((f) => readFileSync(f).toString("latin1"))
    .join("\n")
    .toLowerCase();
  return { rows, files, tables };
}
// The body Workspace.jsx posts for a device-only turn: the vault chat's
// history and the new message, sent off the record.
const deviceOnlyBody = (extra, built) => ({
  model: MODEL,
  messages: built.request,
  ephemeral: true,
  mode: "chat",
  max_tokens: 64,
  ...extra,
});

test("device-only chats leave nothing on the server: every table is scanned", async (t) => {
  const s = fixture(t);
  const { agent, user } = await register(s.app);
  const start = balance(s.db, user.id).total;
  const markers = {
    first: "vaultfirstturnqx7",
    history: "vaulthistoryturnzk4",
    reply: "vaultreplytextjj2",
    followup: "vaultfollowupmm9",
    document: "vaultdocumentbodyrr5",
    instruction: "vaultstandinginstructionww3",
    code: "vaultcodemodepp8",
    private: "vaultprivatemodeyy6",
    veiled: "vaultveilednamehh1",
  };
  // Turn one of a new device-only chat.
  const one = buildChatRequest({ text: `Plan ${markers.first} please` });
  await agent.post("/api/chat").send(deviceOnlyBody({ requestId: "vault-1" }, one)).expect(200);
  // After a reload and unlock: the vault's history goes with the next turn,
  // with a document, standing instructions (Scrolls) and Veil.
  const veilState = createVeilState();
  const two = buildChatRequest({
    messages: [
      { role: "user", content: `Earlier ${markers.history}` },
      { role: "assistant", content: `Earlier reply ${markers.reply}` },
    ],
    text: `Follow up ${markers.followup}, write to ${markers.veiled}@example.com`,
    documents: [{ name: "notes.txt", text: `Body ${markers.document}`, chars: 30 }],
    instructions: `Always ${markers.instruction}`,
    veilWith: { state: veilState, words: [] },
  });
  assert.ok(!JSON.stringify(two.request).includes(markers.veiled), "Veil masked it before sending");
  assert.ok(JSON.stringify(two.request).includes(markers.document), "the document is sent");
  const r2 = await agent.post("/api/chat").send(deviceOnlyBody({ requestId: "vault-2" }, two)).expect(200);
  assert.match(r2.text, /"credits_charged"/);
  assert.ok(!/"conversationId":"c_/.test(r2.text), "no conversation id is streamed");
  // Code & Build, and Private Mode (which always takes this path too).
  const three = buildChatRequest({ text: `Build ${markers.code}` });
  await agent.post("/api/chat").send(deviceOnlyBody({ requestId: "vault-3", mode: "code" }, three)).expect(200);
  const four = buildChatRequest({ text: `Private ${markers.private}` });
  const r4 = await agent
    .post("/api/chat")
    .send(deviceOnlyBody({ requestId: "vault-4", model: PRIVATE_MODEL, private: true }, four))
    .expect(200);
  assert.match(r4.text, /"stored":false/);

  // Billing still happens, like any off-the-record chat.
  assert.ok(balance(s.db, user.id).total < start);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
  assert.equal((await agent.get("/api/conversations")).body.data.length, 0);
  const { rows, files, tables } = everything(s);
  for (const [name, marker] of Object.entries(markers)) {
    assert.ok(!rows.includes(marker), `${name} found in a table (${tables.length} scanned)`);
    assert.ok(!files.includes(marker), `${name} found in the database file`);
  }
  // The media directory holds no media either (only its own signing secret).
  const media = existsSync(join(s.dir, "media")) ? readdirSync(join(s.dir, "media"), { recursive: true }) : [];
  assert.deepEqual(media.filter((f) => !String(f).startsWith(".")), []);

  // The scan does find text the server keeps: a saved chat, for contrast.
  const saved = "vaultcontrolsavedaa0";
  await agent
    .post("/api/chat")
    .send({ model: MODEL, messages: [{ role: "user", content: `Keep ${saved}` }], max_tokens: 64 })
    .expect(200);
  assert.ok(everything(s).rows.includes(saved), "the scanner sees saved chats");
});

test("a device-only request is an off-the-record request, and can't join a saved chat", async (t) => {
  const s = fixture(t);
  const { agent } = await register(s.app);
  await agent
    .post("/api/chat")
    .send({ model: MODEL, messages: [{ role: "user", content: "Saved" }], max_tokens: 20 })
    .expect(200);
  const saved = (await agent.get("/api/conversations")).body.data[0];
  const r = await agent
    .post("/api/chat")
    .send({ ...deviceOnlyBody({}, buildChatRequest({ text: "Mixed" })), conversationId: saved.id })
    .expect(400);
  assert.equal(r.body.error.code, "invalid_request");
});

// ---------------------------------------------------------------------------
// The release gate
// ---------------------------------------------------------------------------

test("Device Vault is registered last and off until released", () => {
  const entry = UPDATES.find((u) => u.id === "vault");
  assert.ok(entry, "vault is registered in UPDATES");
  assert.equal(UPDATES.at(-1), entry, "added after the updates before it");
  // `false` until its release commit flips it; the gate tests pin it anyway.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "Device Vault");
  assert.equal(entry.tagline, "Keep your chats, but only on your device.");
  assert.equal(entry.points.length, 3);
  assert.equal(entry.early, undefined, "not an early-access update");
});

test("the app shows it only with Device Vault and Ephemeral Chats released", async (t) => {
  for (const [released, vault, shown] of [
    ["mvp", false, false],
    ["mvp,ephemeral", false, false],
    ["mvp,vault", true, false],
    ["mvp,ephemeral,vault", true, true],
    ["all", true, true],
  ]) {
    const s = fixture(t, released);
    const config = (await request(s.app).get("/api/config").expect(200)).body;
    assert.equal(config.releases.features.vault, vault, released);
    assert.equal(config.releases.updates.find((u) => u.id === "vault").released, vault);
    assert.equal(vaultReleased(config), shown, released);
  }
  assert.equal(vaultReleased(undefined), false);
  assert.equal(vaultReleased({ releases: { features: { vault: "true", ephemeral: true } } }), false);
  assert.match(src("src/DeviceVault.jsx"), /export \{ vaultReleased \} from "\.\/device-vault\.js";/);
});

test("the server gates a device-only chat as off the record and never learns of a vault", async (t) => {
  const body = deviceOnlyBody({}, buildChatRequest({ text: "hi" }));
  assert.deepEqual(featuresFor({ path: "/api/chat", method: "POST", body }), ["ephemeral"]);
  // With Private Mode too: exactly what a private off-the-record chat needs.
  assert.deepEqual(
    [...new Set(featuresFor({ path: "/api/chat", method: "POST", body: { ...body, private: true } }))].sort(),
    ["ephemeral", "private"],
  );
  for (const path of ["/api/vault", "/api/chat", "/api/conversations", "/api/quote"])
    assert.ok(!featuresFor({ path, method: "POST", body }).includes("vault"), path);
  // Refused while Ephemeral Chats is unreleased...
  const mvp = fixture(t, "mvp");
  const { agent } = await register(mvp.app);
  const r = await agent.post("/api/chat").send(body).expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(r.body.error.message, "Ephemeral Chats is coming soon.");
  // ...and exactly an off-the-record chat once it is.
  const eph = fixture(t, "mvp,ephemeral");
  const { agent: a2 } = await register(eph.app, "vault-two");
  await a2.post("/api/chat").send(body).expect(200);
  assert.equal(eph.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
  // No route, contract or server code knows about it.
  for (const f of readdirSync(new URL("../server/routes/", import.meta.url)))
    assert.doesNotMatch(src("server/routes/" + f), /vault/i, f);
  for (const f of ["server/app.js", "server/core.js", "server/openapi.js", "server/middleware.js"])
    assert.doesNotMatch(src(f), /vault/i, f);
  const contract = (await request(eph.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(contract.paths).some((p) => /vault/i.test(p)), "no vault route");
  assert.doesNotMatch(JSON.stringify(contract.paths["/api/chat"]), /vault/i, "no vault field on a chat");
});

test("the vault's code never touches the network, and never stores the key or plain text", () => {
  for (const file of ["src/device-vault.js", "src/device-vault-store.js", "src/DeviceVault.jsx"]) {
    const code = src(file);
    for (const call of [/\bapi\(/, /\bfetch\(/, /streamChat/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /localStorage/, /sessionStorage/, /saveStore/, /document\.cookie/])
      assert.doesNotMatch(code, call, `${file}: ${call}`);
  }
  // The store writes only sealed records: { id, iv, ct }.
  const store = src("src/device-vault-store.js");
  assert.equal(store.match(/\.put\(/g).length, 4);
  assert.equal(store.match(/put\(\{ id: r\.id, iv: r\.iv, ct: r\.ct \}\)/g).length, 2);
  // Keys are derived non-extractable.
  assert.match(src("src/device-vault.js"), /\{ name: "AES-GCM", length: 256 \},\s*false,\s*\["encrypt", "decrypt"\]/);
});

test("the workspace wires Device only behind its release, on the off-the-record path", () => {
  const ws = src("src/Workspace.jsx");
  assert.match(ws, /const vaultLive = !demo && !!user && vaultReleased\(config\);/);
  assert.match(ws, /\{vaultLive && textMode && \(\s*<DeviceOnlyToggle/);
  assert.match(ws, /\{vaultLive && \(\s*<VaultSection/);
  assert.match(ws, /\{vaultDialog && vaultLive && \(\s*<VaultDialog/);
  // Device only turns off-the-record on, and the chat body is the same one.
  assert.match(ws, /function startDeviceOnly\(\) \{\s*newChat\(\);\s*setDeviceOnly\(true\);\s*setEphemeral\(true\);/);
  assert.match(ws, /\.\.\.\(ephemeral \? \{ ephemeral: true \} : \{ conversationId \}\),/);
  const body = ws.slice(ws.indexOf("await streamChat("), ws.indexOf("(event) =>", ws.indexOf("await streamChat(")));
  assert.doesNotMatch(body, /vault|deviceOnly/i, "nothing in the request says it's a vault chat");
  // Private Mode keeps it off the record either way; Veil's map goes in the
  // vault, not in plain-text storage; documents stay a private context.
  assert.match(ws, /setEphemeral\(next \|\| deviceOnly\);/);
  assert.match(ws, /if \(!deviceOnly\) saveVeilState\(veilKeyRef\.current, veilStateRef\.current\);/);
  assert.match(ws, /\.then\(\(\) => forgetVeilState\(veilKey\)\)/);
  assert.match(ws, /privateContext=\{privateMode \|\| ephemeral \|\| veilOn\}/);
  assert.match(ws, /if \(deviceOnly && textMode && !vault\.unlocked\) \{/);
  // Vault chat titles are content, never translated.
  assert.match(src("src/DeviceVault.jsx"), /<button data-i18n="off" onClick=\{\(\) => onOpen\(c\)\}>/);
  // Its roadmap card has an icon.
  assert.match(src("src/Pages.jsx"), /\n  vault: "lock",\n/);
});

// ---------------------------------------------------------------------------
// Chinese
// ---------------------------------------------------------------------------

test("every string Device Vault shows has a Chinese translation", () => {
  const dict = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
  const entry = UPDATES.find((u) => u.id === "vault");
  const jsx = src("src/DeviceVault.jsx"),
    ws = src("src/Workspace.jsx");
  const ui = [
    "Device only",
    "Device only: saved encrypted in this browser, never on ANONYMA's servers",
    "Device Vault is locked. Unlock it to keep saving this chat on this device.",
    "Unlock",
    "DEVICE VAULT",
    "Lock",
    "Lock Device Vault",
    "This browser can't store a vault.",
    "Keep chats encrypted on this device only.",
    "Set up Device Vault",
    "Locked. Unlock to see the chats saved on this device.",
    "Delete this vault chat",
    "No device-only chats yet. Turn on Device only in the composer.",
    "1 chat couldn't be read.",
    "Manage vault",
    "Lock after this long idle",
    "1 hour",
    "Vault file",
    "That file's passphrase",
    "Import",
    "Importing…",
    "1 chat imported.",
    "The vault file couldn't be imported.",
    "Unlock Device Vault",
    "Delete this vault chat?",
    "Repeat the passphrase",
    "The passphrases don't match.",
    "I understand that a lost passphrase can't be recovered.",
    "Creating…",
    "Create vault",
    "Import a vault file instead",
    "Create a new vault instead",
    "Passphrase",
    "Unlocking…",
    "Delete this vault",
    "Delete vault",
    "1 chat is saved on this device, encrypted.",
    "Move to another device",
    "Export vault file",
    "Import a vault file",
    "Lock now",
  ];
  const lines = new Set([entry.title, entry.tagline, ...entry.points, ...VAULT_LIMITS, ...Object.values(VAULT_ERRORS)]);
  for (const s of ui) {
    assert.ok(jsx.includes(s), `still used: ${s}`);
    lines.add(s);
  }
  // Longer JSX text, as the page renders it (whitespace collapsed).
  const flat = jsx.replace(/\s+/g, " ");
  for (const s of [
    "Device only: this chat is encrypted and saved in this browser. ANONYMA's servers store none of it; the model provider still receives what you send.",
    "It's removed from this browser's vault. It was never on ANONYMA's servers, so this can't be undone.",
    "Device-only chats are encrypted in this browser with a key made from your passphrase. ANONYMA never receives the passphrase or the chats.",
    "Bring a vault from another device: choose its exported file and enter the passphrase it was made with.",
    "Enter your vault passphrase to see and continue the chats saved on this device.",
    "Forgot it? ANONYMA can't recover it or these chats. You can delete this vault and start again.",
    "Delete Device Vault and every chat in it from this browser? This can't be undone.",
    "The exported file stays encrypted: it opens only with this vault's passphrase.",
    "Chats from the file are added to this vault; newer copies replace older ones.",
  ]) {
    assert.ok(flat.includes(s), `still used: ${s}`);
    lines.add(s);
  }
  for (const s of [
    "Device Vault locked after being idle. Unlock it to continue.",
    "Unlock Device Vault to keep chatting on this device only.",
    "This chat couldn't be saved to Device Vault.",
    "Sends from this point again. Device Vault keeps the new version.",
  ]) {
    assert.ok(ws.includes(s), `still used: ${s}`);
    lines.add(s);
  }
  lines.add("Device-only chats are kept only in this browser, so they can't be shared by link.");
  // Numbers and plurals.
  for (const s of [
    "3 chats couldn't be read.",
    "12 chats imported.",
    "0 chats are saved on this device, encrypted.",
    "4 chats are saved on this device, encrypted.",
    `Passphrase (at least ${MIN_PASSPHRASE} characters)`,
    "5 minutes",
    "15 minutes",
    "30 minutes",
  ])
    lines.add(s);
  for (const line of lines) {
    const zh = translateText(line, dict);
    assert.ok(zh && han.test(zh), `zh: ${line} → ${zh}`);
    const leftover = (zh.match(/[A-Za-z]{4,}/g) || []).filter((w) => !["ANONYMA"].includes(w));
    assert.deepEqual(leftover, [], `half-translated: ${line} → ${zh}`);
    assert.ok(!zh.includes("账簿"), "the glossary says 账本");
  }
  assert.equal(translateText("Device Vault", dict), "本机保险库");
  assert.equal(translateText("Device only", dict), "仅存本机");
});
