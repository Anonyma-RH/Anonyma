import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  createVault,
  deriveVaultKey,
  fromBase64,
  sealChat,
  openChat,
  vaultChat,
  readVaultFile,
  openVaultFile,
  VaultError,
} from "../src/device-vault.js";
import {
  SYNC_LIMITS,
  SYNC_STOPPED,
  vaultSyncReleased,
  setupBody,
  sameVault,
  openSynced,
  turnOn,
  turnOff,
  syncVault,
  decide,
  batches,
  resolveConflict,
} from "../src/vault-sync.js";
import {
  SYNC_MAX_BYTES,
  SYNC_MAX_RECORD_BYTES,
  SYNC_MAX_RECORDS,
  SYNC_MAX_TOMBSTONES,
  SYNC_PUSH_RECORDS,
  RECORD_FIELDS,
  TOMBSTONE_FIELDS,
  decodedLength,
  recordSize,
  formatBytes,
} from "../src/vault-sync-spec.js";
import { WIPE_VAULT_SYNC } from "../src/panic-wipe.js";

// Vault Sync: an opt-in, end-to-end-encrypted copy of Device Vault on the
// server. These tests run the browser's sync (src/vault-sync.js) on Node's
// WebCrypto for simulated devices against the real server, and check that
// only sealed records ever leave a device, two devices converge, conflicts
// keep both versions, deletes travel as tombstones, a wrong passphrase opens
// nothing, the caps hold, and the copy is exported and erased with the
// account. Then the release gate, the app's wiring and the Chinese copy.
//
// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const src = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");
const han = /\p{Script=Han}/u;
const PASS = "correct horse battery staple";

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-vault-sync-"));
  const dbPath = join(dir, "test.sqlite");
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath,
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return Object.assign(svc, { dir, dbPath });
}
let visitor = 0;
async function person(app, username) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}

// ---- A simulated device: its vault (sealed records) and sync state in
// memory, talking to the real server through the account's session. Every
// request body it sends is recorded.
const OFF = { enabled: false, vault: null, salt: null, cursor: 0, last: null, reason: null };
function device(agent, sent = []) {
  const records = new Map();
  const state = { meta: { ...OFF }, known: new Map() };
  let chain = Promise.resolve();
  const local = {
    records: async () => [...records.values()].map((r) => ({ ...r })),
    get: async (ids) => ids.filter((id) => records.has(id)).map((id) => ({ ...records.get(id) })),
    put: async (list) => list.forEach((r) => records.set(r.id, { id: r.id, iv: r.iv, ct: r.ct })),
    remove: async (ids) => ids.forEach((id) => records.delete(id)),
    exclusive: (fn) => (chain = chain.then(fn, fn)),
    loadState: async () => ({ meta: { ...state.meta }, known: [...state.known.values()].map((k) => ({ ...k })) }),
    saveState: async ({ meta, reset = false, put = [], del = [] }) => {
      if (reset) state.known.clear();
      for (const id of del) state.known.delete(id);
      for (const k of put) state.known.set(k.id, { id: k.id, v: k.v, iv: k.iv });
      if (meta) state.meta = { ...OFF, ...meta };
    },
  };
  async function call(method, path, body) {
    if (body !== undefined) sent.push({ path, body: JSON.parse(JSON.stringify(body)) });
    const r = await agent[method](path).send(body);
    if (r.status >= 400)
      throw Object.assign(new Error(r.body.error?.message), { status: r.status, code: r.body.error?.code });
    return r.body;
  }
  const remote = {
    status: () => call("get", "/api/vault-sync"),
    setup: (body) => call("post", "/api/vault-sync", body),
    pull: (vault, since) => call("get", `/api/vault-sync/records?vault=${vault}&since=${since}`),
    push: (vault, list) => call("post", "/api/vault-sync/records", { vault, records: list }),
  };
  const d = {
    records,
    state,
    local,
    remote,
    sent,
    key: null,
    meta: null,
    async create(passphrase = PASS) {
      Object.assign(d, await createVault(passphrase));
    },
    // A device without a vault opening the synced one.
    async adopt(passphrase = PASS) {
      const { vault } = await remote.status();
      Object.assign(d, await openSynced(vault, passphrase));
      await turnOn({ key: d.key, meta: d.meta, remote, local });
    },
    turnOn: () => turnOn({ key: d.key, meta: d.meta, remote, local }),
    async save(chat) {
      records.set(chat.id, await sealChat(d.key, chat));
      return chat;
    },
    remove: (id) => records.delete(id),
    async chats() {
      const out = [];
      for (const r of records.values()) out.push(await openChat(d.key, r));
      return out.sort((a, b) => a.id.localeCompare(b.id));
    },
    sync: () => syncVault({ key: d.key, meta: d.meta, remote, local }),
  };
  return d;
}
let n = 0;
const chat = (text, { id = crypto.randomUUID(), at = 1000 + ++n, messages } = {}) =>
  vaultChat({
    id,
    mode: "chat",
    privateMode: false,
    messages: messages || [
      { role: "user", content: text },
      { role: "assistant", content: "Reply to " + text, model: "m" },
    ],
    veil: null,
    created: 1000,
    now: at,
  });
const edit = (c, text, at) => vaultChat({ ...c, messages: [...c.messages, { role: "user", content: text }], now: at });
// Every row of every table, and the database files' bytes, as text.
function everything(s) {
  const text = (v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v == null ? "" : String(v));
  const dump = [];
  for (const { name } of s.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all())
    for (const row of s.db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all())
      dump.push(name + ": " + Object.values(row).map(text).join(" | "));
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const files = [s.dbPath, s.dbPath + "-wal"]
    .filter(existsSync)
    .map((f) => readFileSync(f).toString("latin1"))
    .join("\n");
  return (dump.join("\n") + "\n" + files).toLowerCase();
}
const rows = (s, user) =>
  s.db.prepare("SELECT * FROM vault_sync_records WHERE user_id=? ORDER BY seq").all(user);

// ---------------------------------------------------------------------------
// The release gate
// ---------------------------------------------------------------------------

test("unreleased: every route is refused, nothing is listed or exported, and it needs Device Vault too", async (t) => {
  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app, "ana");
  for (const send of [
    () => a.agent.get("/api/vault-sync"),
    () => a.agent.post("/api/vault-sync").send({}),
    () => a.agent.delete("/api/vault-sync"),
    () => a.agent.get("/api/vault-sync/records?vault=x"),
    () => a.agent.post("/api/vault-sync/records").send({}),
    () => a.agent.get("/API/Vault-Sync/Records/"),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Vault Sync is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(mvp.app).get("/api/vault-sync").expect(403);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.vaultsync, false);
  assert.equal(vaultSyncReleased(config), false);
  const entry = config.releases.updates.find((u) => u.id === "vaultsync");
  assert.equal(entry.title, "Vault Sync");
  assert.equal(entry.released, false);
  const docs = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(docs.paths).some((p) => p.includes("vault")));
  assert.ok(!("vaultSync" in (await a.agent.get("/api/account/export").expect(200)).body));
  assert.deepEqual(featuresFor({ path: "/api/vault-sync/records", method: "POST", body: {} }), ["vaultsync", "vault"]);
  for (const path of ["/api/chat", "/api/conversations", "/api/account/export", "/api/account/wipe"])
    assert.ok(!featuresFor({ path, method: "POST", body: {} }).includes("vaultsync"), path);

  // Released without Device Vault: still refused, as Device Vault.
  const alone = fixture(t, "mvp,vaultsync");
  const b = await person(alone.app, "ben");
  assert.equal((await b.agent.get("/api/vault-sync").expect(403)).body.error.message, "Device Vault is coming soon.");
  // With it: open to signed-in accounts, listed in the docs, and in the
  // export (null while nothing is synced).
  const open = fixture(t, "mvp,ephemeral,vault,vaultsync");
  const c = await person(open.app, "cyd");
  await request(open.app).get("/api/vault-sync").expect(401);
  const status = (await c.agent.get("/api/vault-sync").expect(200)).body;
  assert.equal(status.vault, null);
  assert.deepEqual(status.limits, { bytes: SYNC_MAX_BYTES, recordBytes: SYNC_MAX_RECORD_BYTES, records: SYNC_MAX_RECORDS });
  const listed = (await request(open.app).get("/api/openapi.json").expect(200)).body;
  for (const [path, methods] of [
    ["/api/vault-sync", ["get", "post", "delete"]],
    ["/api/vault-sync/records", ["get", "post"]],
  ])
    for (const m of methods) assert.ok(listed.paths[path]?.[m], `${m} ${path}`);
  assert.equal((await c.agent.get("/api/account/export").expect(200)).body.vaultSync, null);
  const cfg = (await request(open.app).get("/api/config").expect(200)).body;
  assert.equal(vaultSyncReleased(cfg), true);
  // The app also needs Ephemeral Chats, like Device Vault itself.
  const noEph = (await request(fixture(t, "mvp,vault,vaultsync").app).get("/api/config").expect(200)).body;
  assert.equal(vaultSyncReleased(noEph), false);
});

test("Vault Sync is registered once, off until released, with an icon and honest points", () => {
  const index = UPDATES.findIndex((u) => u.id === "vaultsync");
  const entry = UPDATES[index];
  assert.equal(UPDATES.filter((u) => u.id === "vaultsync").length, 1);
  assert.equal(entry.id, "vaultsync");
  assert.equal(typeof committed[index], "boolean", "registered release flag");
  assert.equal(entry.title, "Vault Sync");
  assert.equal(entry.tagline, "Your Device Vault on all your devices.");
  assert.equal(entry.points.length, 3);
  assert.ok(entry.points.some((p) => /ciphertext/.test(p)));
  assert.ok(entry.points.some((p) => /passphrase never leaves/.test(p)));
  assert.equal(entry.early, undefined);
  assert.match(src("src/Pages.jsx"), /\n  vaultsync: "devices",\n/);
  assert.match(src("src/ui.jsx"), /\n  devices: MonitorSmartphone,\n/);
  assert.match(src("Dockerfile"), /src\/vault-sync-spec\.js/);
});

// ---------------------------------------------------------------------------
// Two devices, end to end
// ---------------------------------------------------------------------------

test("two devices sync end to end, and the server only ever receives sealed records", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ana");
  const sent = [];
  const A = device(agent, sent),
    B = device(agent, sent);
  const markers = ["lighthousekeeperqx7", "tidetablezk4", "saltmarshrr5", "harbourlightmm9"];
  await A.create();
  const [one, two, three] = [
    await A.save(chat(`Plan ${markers[0]}`)),
    await A.save(chat(`Notes ${markers[1]}`)),
    await A.save(chat(`Draft ${markers[2]}`)),
  ];
  // Turning sync on uploads the salt, iteration count and verifier only.
  const vault = await A.turnOn();
  assert.match(vault.id, /^vs_[0-9a-f]{32}$/);
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["kdf", "verifier"]);
  assert.deepEqual(sent[0].body, setupBody(A.meta));
  let r = await A.sync();
  assert.equal(r.status, "synced");
  assert.equal(r.pushed, 3);
  assert.equal(r.stats.records, 3);
  // Device B has no vault: the passphrase opens the synced one.
  await B.adopt();
  assert.equal(B.meta.kdf.salt, A.meta.kdf.salt);
  r = await B.sync();
  assert.equal(r.pulled, 3);
  assert.equal(r.pushed, 0);
  assert.deepEqual(await B.chats(), await A.chats());
  assert.deepEqual(r.shown.map((c) => c.id).sort(), [one.id, two.id, three.id].sort());
  // B continues one chat and deletes another; A adds a fourth.
  const oneOnB = await B.save(edit(one, "and the ferry times", 5000));
  B.remove(two.id);
  r = await B.sync();
  assert.equal(r.pushed, 2);
  const tomb = rows(s, user.id).find((x) => x.id === two.id);
  assert.equal(tomb.deleted, 1);
  assert.equal(tomb.iv, null);
  assert.equal(tomb.ct, null);
  assert.equal(tomb.size, 0);
  const four = await A.save(chat(`Later ${markers[3]}`));
  r = await A.sync();
  assert.equal(r.pulled, 1);
  assert.equal(r.removed, 1);
  assert.deepEqual(r.gone, [two.id]);
  assert.equal(r.pushed, 1);
  r = await B.sync();
  assert.equal(r.pulled, 1);
  assert.deepEqual(await B.chats(), await A.chats());
  assert.deepEqual((await A.chats()).map((c) => c.id).sort(), [one.id, three.id, four.id].sort());
  assert.deepEqual((await A.chats()).find((c) => c.id === one.id).messages, oneOnB.messages);
  // Nothing changed: a sync sends nothing.
  const before = sent.length;
  r = await A.sync();
  assert.equal(r.pushed + r.pulled, 0);
  assert.equal(sent.length, before);

  // What went up: only ids, bases and sealed bytes (or tombstones), never a
  // title, a message, the passphrase or the key.
  const bodies = JSON.stringify(sent).toLowerCase();
  for (const m of [...markers, PASS, "reply to", "title", "messages"])
    assert.ok(!bodies.includes(m.toLowerCase()), `sent: ${m}`);
  for (const { path, body } of sent.slice(1)) {
    assert.equal(path, "/api/vault-sync/records");
    assert.deepEqual(Object.keys(body).sort(), ["records", "vault"]);
    for (const rec of body.records) {
      const keys = Object.keys(rec).sort();
      assert.ok(
        JSON.stringify(keys) === JSON.stringify([...RECORD_FIELDS].sort()) ||
          JSON.stringify(keys) === JSON.stringify([...TOMBSTONE_FIELDS].sort()),
        keys.join(","),
      );
      assert.match(rec.id, /^[0-9a-f-]{36}$/);
    }
  }
  // And what the server keeps: nothing readable, anywhere in the database.
  const stored = everything(s);
  for (const m of [...markers, PASS]) assert.ok(!stored.includes(m.toLowerCase()), `stored: ${m}`);
  // The sealed bytes are exactly what the device holds.
  const kept = rows(s, user.id).find((x) => x.id === three.id);
  assert.equal(Buffer.from(kept.ct).toString("base64"), A.records.get(three.id).ct);
  assert.equal(kept.size, recordSize(A.records.get(three.id).iv, A.records.get(three.id).ct));
});

test("conflicts keep both versions; identical edits don't; an edit outlives a delete", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ana");
  const A = device(agent),
    B = device(agent);
  await A.create();
  const x = await A.save(chat("Itinerary"));
  const y = await A.save(chat("Packing list"));
  const z = await A.save(chat("Budget"));
  await A.turnOn();
  await A.sync();
  await B.adopt();
  await B.sync();

  // Both edit x without syncing; B's edit is newer, so it keeps the id and
  // A's version is kept beside it as a conflict copy, on both devices.
  const onA = await A.save(edit(x, "Day one: Athens", 7000));
  const onB = await B.save(edit(x, "Day one: Naxos", 8000));
  assert.equal((await A.sync()).pushed, 1);
  let r = await B.sync();
  assert.equal(r.conflicts, 1);
  // Both are the same identical edit on y: no copy.
  const same = { ...y, messages: [...y.messages, { role: "user", content: "socks" }], updated: 9000 };
  await A.save(same);
  await B.save(same);
  await A.sync();
  r = await B.sync();
  assert.equal(r.conflicts, 0, "identical content isn't a conflict");
  // z: deleted on A, changed on B. The edit comes back everywhere.
  A.remove(z.id);
  await A.sync();
  const zOnB = await B.save(edit(z, "plus ferry tickets", 9500));
  r = await B.sync();
  await A.sync();
  await B.sync();
  const a = await A.chats(),
    b = await B.chats();
  assert.deepEqual(a, b, "both devices converge");
  assert.equal(a.length, 4, "x, its conflict copy, y and z");
  assert.deepEqual(a.find((c) => c.id === x.id).messages, onB.messages, "the newer edit keeps the id");
  const copy = a.find((c) => c.conflictCopy);
  assert.ok(copy && copy.id !== x.id);
  assert.deepEqual(copy.messages, onA.messages, "the other edit is kept as a copy");
  assert.deepEqual(a.find((c) => c.id === y.id).messages, same.messages);
  assert.deepEqual(a.find((c) => c.id === z.id).messages, zOnB.messages, "the edit outlived the delete");
  assert.equal(rows(s, user.id).filter((row) => row.deleted).length, 0);

  // At the server: a push based on a stale version gets the current record
  // back, and nothing changes.
  const { vault } = (await agent.get("/api/vault-sync").expect(200)).body;
  const cur = rows(s, user.id).find((row) => row.id === x.id);
  const stale = await agent
    .post("/api/vault-sync/records")
    .send({ vault: vault.id, records: [{ id: x.id, base: cur.version - 1, ...(await sealChat(A.key, onA)), id: x.id }] })
    .expect(200);
  assert.equal(stale.body.results[0].conflict.version, cur.version);
  assert.equal(stale.body.results[0].conflict.ct, Buffer.from(cur.ct).toString("base64"));
  assert.equal(rows(s, user.id).find((row) => row.id === x.id).version, cur.version);
  // A new record under an id the server has is a conflict too (base 0).
  const again = await agent
    .post("/api/vault-sync/records")
    .send({ vault: vault.id, records: [{ id: y.id, base: 0, iv: A.records.get(y.id).iv, ct: A.records.get(y.id).ct }] })
    .expect(200);
  assert.ok(again.body.results[0].conflict);
});

test("the conflict rules on their own: which way a change goes, ties and damaged copies", async () => {
  const known = { v: 3, iv: "AAAAAAAAAAAAAAAA" };
  const local = { id: "c", iv: "AAAAAAAAAAAAAAAA", ct: "x" };
  assert.equal(decide({ id: "c", version: 3, iv: "B" }, local, known), "skip");
  assert.equal(decide({ id: "c", version: 4, iv: "B" }, local, known), "apply");
  assert.equal(decide({ id: "c", version: 4, iv: local.iv }, { ...local }, { v: 2, iv: "Z" }), "same");
  assert.equal(decide({ id: "c", version: 4, iv: "B" }, { ...local, iv: "C" }, known), "conflict");
  assert.equal(decide({ id: "c", version: 4, deleted: true }, undefined, known), "conflict", "deleted here, changed there");
  assert.equal(decide({ id: "c", version: 1, iv: "B" }, local, undefined), "conflict", "new on both sides");
  assert.equal(decide({ id: "c", version: 1, iv: "B" }, undefined, undefined), "apply");
  // Equal times: the higher IV wins, so both devices choose the same one.
  const { key } = await createVault(PASS);
  const base = chat("Tie", { at: 5000 });
  const mine = await sealChat(key, edit(base, "mine", 6000));
  const theirs = await sealChat(key, edit(base, "theirs", 6000));
  const ids = ["copy-1", "copy-2"];
  const one = await resolveConflict({ key, remote: { ...theirs, id: base.id, version: 2 }, local: { ...mine, id: base.id }, newId: () => ids[0] });
  const two = await resolveConflict({ key, remote: { ...mine, id: base.id, version: 2 }, local: { ...theirs, id: base.id }, newId: () => ids[1] });
  const winner = (out, localRec) => (out.known.iv === "" ? localRec.iv : out.known.iv);
  assert.equal(winner(one, mine), winner(two, theirs), "both sides keep the same version at the id");
  // A remote record that doesn't open with this key: ours stays and goes up.
  const bad = await resolveConflict({ key, remote: { id: base.id, version: 5, iv: mine.iv, ct: theirs.ct }, local: { ...mine, id: base.id }, newId: () => "n" });
  assert.equal(bad.damaged, 1);
  assert.deepEqual(bad.known, { v: 5, iv: "" });
  assert.equal(bad.put.length, 0);
  // Batches keep to the per-request limits.
  const many = Array.from({ length: 250 }, (_, i) => ({ id: "r" + i, size: 1000 }));
  assert.deepEqual(batches(many).map((b) => b.length), [SYNC_PUSH_RECORDS, SYNC_PUSH_RECORDS, 50]);
  const big = Array.from({ length: 5 }, (_, i) => ({ id: "b" + i, size: 3 * 1024 * 1024 }));
  assert.deepEqual(batches(big).map((b) => b.length), [2, 2, 1]);
});

test("a wrong passphrase opens nothing, and a different vault is never written into the synced one", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ana");
  const A = device(agent);
  await A.create();
  const secret = await A.save(chat("Only with the right words"));
  await A.turnOn();
  await A.sync();
  const { vault } = (await agent.get("/api/vault-sync").expect(200)).body;
  await assert.rejects(openSynced(vault, "not the passphrase at all"), (e) => e instanceof VaultError && e.code === "wrong_passphrase");
  // A key made from the wrong passphrase can't open a synced record.
  const wrong = await deriveVaultKey("not the passphrase at all", fromBase64(vault.kdf.salt), vault.kdf.iterations);
  const page = (await agent.get(`/api/vault-sync/records?vault=${vault.id}&since=0`).expect(200)).body;
  await assert.rejects(openChat(wrong, page.records[0]), (e) => e instanceof VaultError);
  assert.equal((await openChat(A.key, page.records[0])).id, secret.id);
  // A device with its own vault (another passphrase) can't turn sync on for
  // it, and a stale sync state doesn't let it push.
  const C = device(agent);
  await C.create("a completely different phrase");
  await C.save(chat("C's own chat"));
  assert.equal(await sameVault(C.key, C.meta, vault), false);
  await assert.rejects(C.turnOn(), (e) => e instanceof VaultError && e.code === "other_vault");
  C.state.meta = { ...C.state.meta, enabled: true, vault: vault.id, salt: C.meta.kdf.salt };
  const r = await C.sync();
  assert.equal(r.status, "other_vault");
  assert.equal(C.state.meta.enabled, false);
  assert.equal(rows(s, user.id).length, 1, "nothing from C reached the server");
  // Joining: C re-seals its chats with the synced key, then they sync.
  const cChats = await C.chats();
  Object.assign(C, await openSynced(vault, PASS));
  C.records.clear();
  for (const c of cChats) await C.save(c);
  await C.turnOn();
  await C.sync();
  await A.sync();
  assert.deepEqual(await A.chats(), await C.chats());
  assert.equal((await A.chats()).length, 2);
});

// ---------------------------------------------------------------------------
// Input, caps and limits
// ---------------------------------------------------------------------------

test("only sealed records are accepted: fields, canonical base64, ids, bases and batch sizes", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ana");
  const { meta, key } = await createVault(PASS);
  // Setup: exactly kdf and verifier, with safe settings.
  const good = setupBody(meta);
  for (const bad of [
    { ...good, passphrase: PASS },
    { ...good, key: "x" },
    { kdf: { ...good.kdf, iterations: 1000 }, verifier: good.verifier },
    { kdf: { ...good.kdf, iterations: 2e7 }, verifier: good.verifier },
    { kdf: { ...good.kdf, salt: "AAAA" }, verifier: good.verifier },
    { kdf: { ...good.kdf, name: "scrypt" }, verifier: good.verifier },
    { kdf: { ...good.kdf, extra: 1 }, verifier: good.verifier },
    { kdf: good.kdf, verifier: { ...good.verifier, iv: "AAAAAAAAAAAAAAAAAAAAAA==" } },
    { kdf: good.kdf, verifier: { ...good.verifier, text: "ANONYMA" } },
    { kdf: good.kdf },
  ])
    assert.equal((await agent.post("/api/vault-sync").send(bad).expect(400)).body.error.code, "invalid_request");
  // Pulls and pushes need a synced vault.
  assert.equal((await agent.get("/api/vault-sync/records?vault=vs_x").expect(404)).body.error.code, "vault_sync_missing");
  const { vault } = (await agent.post("/api/vault-sync").send(good).expect(201)).body;
  assert.equal((await agent.post("/api/vault-sync").send(good).expect(409)).body.error.code, "vault_sync_exists");
  const rec = await sealChat(key, chat("q"));
  const ok = { id: rec.id, base: 0, iv: rec.iv, ct: rec.ct };
  const push = (body) => agent.post("/api/vault-sync/records").send(body);
  for (const bad of [
    { vault: vault.id, records: [{ ...ok, title: "Trip" }] },
    { vault: vault.id, records: [{ ...ok, messages: [] }] },
    { vault: vault.id, records: [ok], chats: [] },
    { vault: vault.id, records: [{ ...ok, id: "has space" }] },
    { vault: vault.id, records: [{ ...ok, id: "x".repeat(101) }] },
    { vault: vault.id, records: [ok, ok] },
    { vault: vault.id, records: [{ ...ok, base: -1 }] },
    { vault: vault.id, records: [{ ...ok, base: 1.5 }] },
    { vault: vault.id, records: [{ ...ok, iv: ok.iv + "==" }] },
    { vault: vault.id, records: [{ ...ok, iv: "AAAAAAAAAAAAAAAAAAAAAA==" }] },
    { vault: vault.id, records: [{ ...ok, ct: "AAAA" }] },
    { vault: vault.id, records: [{ ...ok, ct: ok.ct.slice(0, -2) + "=" }] },
    { vault: vault.id, records: [{ ...ok, ct: ok.ct.replace(/[A-Za-z0-9+/](?=={0,2}$)/, "!") }] },
    { vault: vault.id, records: [{ id: rec.id, base: 1, deleted: false }] },
    { vault: vault.id, records: [{ id: rec.id, base: 1, deleted: true, iv: ok.iv }] },
    { vault: vault.id, records: [{ id: rec.id, base: 0 }] },
    { vault: vault.id, records: [] },
    { vault: vault.id, records: Array.from({ length: SYNC_PUSH_RECORDS + 1 }, (_, i) => ({ ...ok, id: "r" + i })) },
    { vault: vault.id },
    { records: [ok] },
  ])
    assert.equal((await push(bad).expect(400)).body.error.code, "invalid_request", JSON.stringify(bad).slice(0, 80));
  assert.equal(rows(s, user.id).length, 0, "nothing written by a refused request");
  // Non-canonical base64 (stray bits in the last character) is refused too,
  // so what a device reads back is exactly the string it sent.
  const canonical = Buffer.alloc(16).toString("base64");
  assert.equal(canonical, "AAAAAAAAAAAAAAAAAAAAAA==");
  assert.equal(decodedLength("AAAAAAAAAAAAAAAAAAAAAB=="), 16);
  await push({ vault: vault.id, records: [{ ...ok, ct: "AAAAAAAAAAAAAAAAAAAAAB==" }] }).expect(400);
  assert.equal(rows(s, user.id).length, 0);
  // The wrong vault id is refused whole.
  assert.equal((await push({ vault: "vs_other", records: [ok] }).expect(409)).body.error.code, "vault_sync_changed");
  assert.equal((await agent.get("/api/vault-sync/records?vault=vs_other").expect(409)).body.error.code, "vault_sync_changed");
  for (const q of ["", "?vault=" + vault.id + "&since=-1", "?vault=" + vault.id + "&limit=0", "?vault=" + vault.id + "&limit=501", "?vault=" + vault.id + "&since=x"])
    await agent.get("/api/vault-sync/records" + q).expect(400);
  // And a good one is stored.
  assert.equal((await push({ vault: vault.id, records: [ok] }).expect(200)).body.results[0].version, 1);
  // Another account sees none of it.
  const ben = await person(s.app, "ben");
  assert.equal((await ben.agent.get("/api/vault-sync").expect(200)).body.vault, null);
  assert.equal((await ben.agent.get(`/api/vault-sync/records?vault=${vault.id}`).expect(404)).body.error.code, "vault_sync_missing");
});

test("caps: 4 MB per chat, 50 MB and 5,000 chats per account, oldest tombstones dropped; the device keeps what doesn't fit", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ana");
  const A = device(agent);
  await A.create();
  await A.turnOn();
  const { vault } = (await agent.get("/api/vault-sync").expect(200)).body;
  // One chat over 4 MB: refused at the server, and never sent by a device.
  const huge = Buffer.alloc(SYNC_MAX_RECORD_BYTES).toString("base64");
  const iv = Buffer.alloc(12, 1).toString("base64");
  const r1 = await agent
    .post("/api/vault-sync/records")
    .send({ vault: vault.id, records: [{ id: "big", base: 0, iv, ct: huge }] })
    .expect(200);
  assert.deepEqual(r1.body.results, [{ id: "big", error: "too_large" }]);
  const bigChat = chat("x".repeat(10), { messages: [{ role: "user", content: "y".repeat(SYNC_MAX_RECORD_BYTES) }] });
  await A.save(bigChat);
  await A.save(chat("small"));
  let r = await A.sync();
  assert.equal(r.tooBig, 1);
  assert.equal(r.pushed, 1);
  assert.ok(A.records.has(bigChat.id), "it stays on the device");
  // Near 50 MB: the next chat is refused as storage_full, deletes still go.
  const insert = s.db.prepare(
    "INSERT INTO vault_sync_records(user_id,id,version,seq,iv,ct,size,deleted,updated) VALUES(?,?,1,?,?,?,?,0,1)",
  );
  insert.run(user.id, "filler", 1000, Buffer.alloc(12), Buffer.alloc(16), SYNC_MAX_BYTES - 50);
  s.db.prepare("UPDATE vault_sync SET seq=1000 WHERE user_id=?").run(user.id);
  const another = await A.save(chat("one more"));
  r = await A.sync();
  assert.equal(r.full, true);
  assert.ok(!rows(s, user.id).some((x) => x.id === another.id));
  s.db.prepare("DELETE FROM vault_sync_records WHERE id='filler'").run();
  // 5,000 chats: a new one is refused, a change to an existing one isn't.
  s.db.exec("BEGIN");
  for (let i = 0; i < SYNC_MAX_RECORDS - 2; i++) insert.run(user.id, "n" + i, 2000 + i, Buffer.alloc(12), Buffer.alloc(16), 28);
  s.db.exec("COMMIT");
  s.db.prepare("UPDATE vault_sync SET seq=? WHERE user_id=?").run(2000 + SYNC_MAX_RECORDS, user.id);
  const live = s.db.prepare("SELECT COUNT(*) n FROM vault_sync_records WHERE user_id=? AND deleted=0").get(user.id).n;
  assert.equal(live, SYNC_MAX_RECORDS - 1);
  const push = (records) => agent.post("/api/vault-sync/records").send({ vault: vault.id, records }).expect(200);
  const box = { iv, ct: Buffer.alloc(20).toString("base64") };
  assert.equal((await push([{ id: "last", base: 0, ...box }])).body.results[0].version, 1);
  assert.equal((await push([{ id: "over", base: 0, ...box }])).body.results[0].error, "record_limit");
  assert.equal((await push([{ id: "last", base: 1, ...box }])).body.results[0].version, 2);
  // A device says so and keeps the chat; records it can't open are skipped.
  const extra = await A.save(chat("one too many"));
  r = await A.sync();
  assert.equal(r.tooMany, true);
  assert.equal(r.full, false);
  assert.ok(r.damaged >= SYNC_MAX_RECORDS - 2, "the filler rows don't open with this key");
  assert.ok(A.records.has(extra.id));
  assert.ok(!rows(s, user.id).some((x) => x.id === extra.id));
  // Tombstones past 20,000: the oldest go.
  s.db.exec("BEGIN");
  s.db.prepare("UPDATE vault_sync_records SET deleted=1,iv=NULL,ct=NULL,size=0 WHERE user_id=? AND id LIKE 'n%'").run(user.id);
  const tomb = s.db.prepare(
    "INSERT INTO vault_sync_records(user_id,id,version,seq,size,deleted,updated) VALUES(?,?,1,?,0,1,1)",
  );
  for (let i = 0; i < SYNC_MAX_TOMBSTONES - (SYNC_MAX_RECORDS - 2); i++) tomb.run(user.id, "t" + i, 10000 + i);
  s.db.exec("COMMIT");
  s.db.prepare("UPDATE vault_sync SET seq=100000 WHERE user_id=?").run(user.id);
  const count = () => s.db.prepare("SELECT COUNT(*) n FROM vault_sync_records WHERE user_id=? AND deleted=1").get(user.id).n;
  assert.equal(count(), SYNC_MAX_TOMBSTONES);
  await push([{ id: "last", base: 2, deleted: true }]);
  assert.equal(count(), SYNC_MAX_TOMBSTONES);
  assert.ok(!s.db.prepare("SELECT 1 FROM vault_sync_records WHERE user_id=? AND id='n0'").get(user.id), "the oldest tombstone went");
  assert.ok(s.db.prepare("SELECT 1 FROM vault_sync_records WHERE user_id=? AND id='last' AND deleted=1").get(user.id));
});

test("pushes, reads and changes are rate limited per account", async (t) => {
  const s = fixture(t);
  // One listening server for the few hundred requests below.
  const server = s.app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  const { agent } = await person(server, "ana");
  let status = 0;
  for (let i = 0; i < 241 && status !== 429; i++)
    status = (await agent.post("/api/vault-sync/records").send({})).status;
  assert.equal(status, 429);
  status = 0;
  for (let i = 0; i < 31 && status !== 429; i++) status = (await agent.post("/api/vault-sync").send({})).status;
  assert.equal(status, 429);
  // Another account isn't affected.
  const ben = await person(s.app, "ben");
  await ben.agent.post("/api/vault-sync/records").send({}).expect(400);
});

// ---------------------------------------------------------------------------
// Forget, replace, export and erase
// ---------------------------------------------------------------------------

test("Forget synced copy: devices keep their chats and stop syncing; an old device never writes a replaced vault", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s.app, "ana");
  const A = device(agent),
    B = device(agent);
  await A.create();
  await A.save(chat("Keep me"));
  await A.turnOn();
  await A.sync();
  await B.adopt();
  await B.sync();
  const oldId = B.state.meta.vault;
  const f = await agent.delete("/api/vault-sync").expect(200);
  assert.deepEqual(f.body, { ok: true, forgotten: true });
  assert.equal(rows(s, user.id).length, 0);
  assert.ok(!s.db.prepare("SELECT 1 FROM vault_sync WHERE user_id=?").get(user.id));
  assert.equal((await agent.delete("/api/vault-sync").expect(200)).body.forgotten, false);
  await turnOff({ local: A.local });
  // B finds the copy gone: it stops and keeps its chats, uploading nothing.
  await B.save(chat("Made on B after the forget"));
  let r = await B.sync();
  assert.equal(r.status, "forgotten");
  assert.equal(B.state.meta.enabled, false);
  assert.equal(B.state.meta.reason, "forgotten");
  assert.equal(B.records.size, 2);
  assert.equal(rows(s, user.id).length, 0);
  assert.equal((await B.sync()).status, "off");
  // A turns sync on again: a new synced vault. B, still pointed at the old
  // one, stops instead of writing into it, and the server refuses the old id.
  await A.turnOn();
  await A.sync();
  B.state.meta = { ...B.state.meta, enabled: true, vault: oldId, reason: null };
  r = await B.sync();
  assert.equal(r.status, "replaced");
  assert.equal(B.state.meta.enabled, false);
  assert.equal(rows(s, user.id).length, 1);
  await agent.get(`/api/vault-sync/records?vault=${oldId}`).expect(409);
  // B joins the new one on purpose: same passphrase, same vault.
  await B.turnOn();
  await B.sync();
  assert.equal(rows(s, user.id).length, 2);
});

test("the export carries the ciphertext as an importable vault file; closure and Panic Wipe erase it", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana");
  const A = device(ana.agent);
  await A.create();
  const kept = await A.save(chat("Exported and encrypted"));
  const gone = await A.save(chat("Deleted later"));
  await A.turnOn();
  await A.sync();
  A.remove(gone.id);
  await A.sync();
  const exported = (await ana.agent.get("/api/account/export").expect(200)).body.vaultSync;
  assert.match(exported.note, /passphrase/);
  assert.deepEqual(exported.records.map((r) => [r.id, r.deleted]), [
    [kept.id, false],
    [gone.id, true],
  ]);
  assert.ok(!JSON.stringify(exported).includes("Exported and encrypted"), "still sealed");
  // It opens as a Device Vault file, only with the passphrase.
  const parsed = readVaultFile(JSON.stringify(exported.file));
  const { chats } = await openVaultFile(parsed, PASS);
  assert.deepEqual(chats, [kept]);
  await assert.rejects(openVaultFile(parsed, "the wrong passphrase!"), (e) => e.code === "wrong_passphrase");
  // Another account's export has none of it.
  const ben = await person(s.app, "ben");
  const B = device(ben.agent);
  await B.create();
  await B.save(chat("Ben's"));
  await B.turnOn();
  await B.sync();
  // Panic Wipe erases Ana's synced copy and settings; Ben's stays.
  await ana.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(rows(s, ana.user.id).length, 0);
  assert.ok(!s.db.prepare("SELECT 1 FROM vault_sync WHERE user_id=?").get(ana.user.id));
  assert.equal(rows(s, ben.user.id).length, 1);
  // Closing the account does too.
  await ben.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(rows(s, ben.user.id).length, 0);
  assert.ok(!s.db.prepare("SELECT 1 FROM vault_sync WHERE user_id=?").get(ben.user.id));
  // The code: eraseAccountContent and the export both name it.
  const account = src("server/routes/account.js");
  assert.match(account, /forgetVaultSync\(db, id\);/);
  assert.match(account, /\.\.\.vaultSyncExport\(req\.user\.id\),/);
});

test("nothing about a sync is logged", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s.app, "ana");
  const A = device(agent);
  const logged = [];
  const orig = {};
  for (const m of ["log", "info", "warn", "error", "debug"]) {
    orig[m] = console[m];
    console[m] = (...args) => logged.push(args.map(String).join(" "));
  }
  try {
    await A.create();
    const c = await A.save(chat("Quiet please"));
    await A.turnOn();
    await A.sync();
    await agent.post("/api/vault-sync/records").send({ vault: "vs_x", records: [{ id: c.id, base: 0, title: "Quiet" }] });
    await agent.delete("/api/vault-sync");
    const text = logged.join("\n");
    assert.ok(!text.includes(c.id), "no record ids");
    assert.ok(!text.includes(A.records.get(c.id).ct.slice(0, 24)), "no ciphertext");
    assert.ok(!text.includes(A.meta.kdf.salt), "no salt");
    assert.ok(!/quiet/i.test(text));
  } finally {
    Object.assign(console, orig);
  }
  assert.doesNotMatch(src("server/routes/vault-sync.js"), /console\./);
});

// ---------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------

test("the app wires Vault Sync into Device Vault, behind its release, and only it talks to the server", () => {
  const ws = src("src/Workspace.jsx");
  assert.match(ws, /const vaultSync = useVaultSync\(\{\s*enabled: vaultLive && vaultSyncReleased\(config\),/);
  assert.match(ws, /onDialog=\{setVaultDialog\}\s*sync=\{vaultSync\}/);
  assert.match(ws, /dialog=\{vaultDialog\}\s*sync=\{vaultSync\}/);
  // A vault chat open here reloads when another device changed it, and a
  // turn written meanwhile is kept as a copy instead of overwriting it.
  assert.match(ws, /if \(!vault\.remoteChanges\.ids\.includes\(ref\.id\)\) return;/);
  assert.match(ws, /if \(ref\.stale\) \{\s*ref = vaultChatRef\.current = \{ id: uid\(\), created: Date\.now\(\), copy: true \};/);
  // Device Vault's own files still never touch the network.
  for (const file of ["src/device-vault.js", "src/device-vault-store.js", "src/DeviceVault.jsx", "src/vault-sync-store.js", "src/vault-sync.js"])
    for (const call of [/\bapi\(/, /\bfetch\(/, /XMLHttpRequest/, /sendBeacon/, /WebSocket/, /localStorage/, /sessionStorage/])
      assert.doesNotMatch(src(file), call, `${file}: ${call}`);
  // VaultSync.jsx calls only its own routes.
  const ui = src("src/VaultSync.jsx");
  const calls = [...ui.matchAll(/api\(\s*[`"]([^`"?]+)/g)].map((m) => m[1]);
  assert.ok(calls.length >= 4);
  for (const c of calls) assert.match(c, /^\/api\/vault-sync(\/records)?$/);
  assert.doesNotMatch(ui, /\bfetch\(|localStorage|sessionStorage/);
  // The sync state stores ids, versions and IVs only.
  assert.match(src("src/vault-sync-store.js"), /known\.put\(\{ id: k\.id, v: k\.v, iv: k\.iv \}\)/);
  // Passphrase fields are the person's words: never translated.
  assert.match(ui, /type="password"\s*data-i18n="off"/);
  // Panic Wipe and the data-controls guide mention it once it's live.
  assert.match(src("src/PanicWipe.jsx"), /\{vaultSyncLive && <li>\{WIPE_VAULT_SYNC\}<\/li>\}/);
  assert.match(src("src/DataControls.jsx"), /\{vaultSync && \(\s*<li>\s*Vault Sync, if you turn it on:/);
});

// VaultSync.jsx rendered on the server, with ui.jsx stubbed.
async function syncModule() {
  const file = new URL("../src/VaultSync.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(file, "utf8"), file.pathname, { jsx: "transform", format: "esm" });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-vault-sync-ui-"));
  const react = import.meta.resolve("react");
  const ui = join(dir, "ui.mjs");
  writeFileSync(
    ui,
    `import React from "${react}";
     export const Icon = () => React.createElement("svg");
     export const Button = ({ children, secondary, ...rest }) => React.createElement("button", rest, children);
     export const Notice = ({ children }) => React.createElement("div", null, children);`,
  );
  const out = code
    .replace(/^import "\.\/vault-sync\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${pathToFileURL(ui).href}"`)
    .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const mod = join(dir, "VaultSync.mjs");
  writeFileSync(mod, out);
  try {
    return await import(pathToFileURL(mod).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr"]);
  const stack = [],
    page = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g))
        if (!off && !stack.some((x) => x.off)) page.push(entities(attr));
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>")) stack.push({ off });
    } else {
      const t = entities(text).trim();
      if (t && !stack.some((x) => x.off)) page.push(t);
    }
  }
  return page.filter((x) => /[A-Za-z]{2}/.test(x));
}

test("every Vault Sync screen is translated, and nothing shows until it's released", async () => {
  const { VaultSyncSection, VaultSyncJoin, VaultSyncStatus, ConflictCopyTag, VaultSyncLimits, syncNotes } = await syncModule();
  const synced = { id: "vs_1", records: 12, bytes: 188416, kdf: {}, verifier: {} };
  const limits = { bytes: SYNC_MAX_BYTES, recordBytes: SYNC_MAX_RECORD_BYTES };
  const base = { live: true, server: { vault: synced, limits }, synced, local: { enabled: true, vault: "vs_1" }, on: true, match: true, busy: false, result: null, error: "", at: Date.now(), limits };
  const states = [
    base,
    { ...base, busy: true },
    { ...base, error: "Sync didn't finish. It will try again.", result: { conflicts: 2, tooBig: 1, full: true, damaged: 3 } },
    { ...base, result: { conflicts: 1, tooBig: 2, damaged: 1 }, at: Date.now() - 3600000 },
    { ...base, on: false, local: { enabled: false, reason: "forgotten" }, server: { vault: null, limits }, synced: null },
    { ...base, on: false, local: { enabled: false, reason: "replaced" } },
    { ...base, on: false, local: { enabled: false } },
    { ...base, on: false, local: { enabled: false }, match: false },
    { ...base, server: undefined },
    { ...base, server: null, synced: null, on: false },
  ];
  const html = [
    ...states.map((sync) => renderToStaticMarkup(createElement(VaultSyncSection, { sync }))),
    renderToStaticMarkup(createElement(VaultSyncJoin, { sync: base })),
    ...states.map((sync) => renderToStaticMarkup(createElement(VaultSyncStatus, { sync }))),
    renderToStaticMarkup(createElement(VaultSyncStatus, { sync: { ...base, result: { conflicts: 1 } } })),
    renderToStaticMarkup(createElement(ConflictCopyTag)),
    renderToStaticMarkup(createElement(VaultSyncLimits)),
  ].join("");
  // Nothing renders while it's off (not released).
  assert.equal(renderToStaticMarkup(createElement(VaultSyncSection, { sync: { ...base, live: false } })), "");
  assert.equal(renderToStaticMarkup(createElement(VaultSyncSection, { sync: null })), "");
  assert.equal(renderToStaticMarkup(createElement(VaultSyncStatus, { sync: { ...base, live: false } })), "");
  const page = textsOf(html);
  for (const text of [
    "Sync across devices",
    "Sync this vault across my devices (end-to-end encrypted)",
    "12 chats synced · 184 KB of 50 MB used",
    "Synced just now",
    "Syncing…",
    "Forget synced copy",
    "Join synced vault",
    "Conflict copy",
    "Synced across your devices",
    SYNC_STOPPED.forgotten,
  ])
    assert.ok(page.includes(text), "shown: " + text);
  assert.ok(page.some((x) => /^Last synced \d/.test(x)));
  // The notes, and the confirm and forget views, which need a click.
  const extra = [
    ...syncNotes({ conflicts: 4, tooBig: 3, full: true, tooMany: true, damaged: 2 }, "other_vault"),
    ...syncNotes({ conflicts: 1, tooBig: 1, damaged: 1 }),
    "Up to 50 MB in all; a chat over 4 MB stays on this device only.",
    "Turn on sync",
    "Turning on…",
    "Forgetting…",
    "Joining…",
    "Delete the synced copy from ANONYMA's servers? Your devices keep their own vaults and stop syncing. Backups are separate copies; without your passphrase they can't be read.",
    "Sync is paused for a moment. It will try again shortly.",
    "Couldn't reach ANONYMA to sync. Your chats are safe on this device; it will try again.",
    "Another of your devices syncs a different vault.",
    "The synced vault was replaced on another device.",
    "This account doesn't sync a vault.",
    "This account already syncs a vault. Join it, or forget it first.",
    "Also forget the synced copy on ANONYMA's servers. Your other devices keep their vaults and stop syncing.",
    "This chat changed on another device while you were writing here, so your version is kept as a separate copy.",
    "1 chat synced · 4 KB of 50 MB used",
    WIPE_VAULT_SYNC,
    "Vault Sync is coming soon.",
    ...SYNC_LIMITS,
    ...Object.values(SYNC_STOPPED),
  ];
  const dict = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
  const entry = UPDATES.find((u) => u.id === "vaultsync");
  const flat = (f) => src(f).replace(/\s+/g, " ");
  const dataControls = flat("src/DataControls.jsx").match(/Vault Sync, if you turn it on:[^<]+/)[0].trim();
  for (const line of new Set([...page, ...extra, entry.title, entry.tagline, ...entry.points, dataControls])) {
    const zh = translateText(line, dict);
    assert.ok(zh && han.test(zh), `zh: ${line} → ${zh}`);
    const leftover = (zh.match(/[A-Za-z]{4,}/g) || []).filter((w) => !["ANONYMA"].includes(w));
    assert.deepEqual(leftover, [], `half-translated: ${line} → ${zh}`);
  }
  assert.equal(translateText("Vault Sync", dict), "保险库同步");
  assert.equal(translateText("Conflict copy", dict), "冲突副本");
  // The copy's own words, as the source has them.
  for (const s of ["Delete the synced copy from ANONYMA's servers?", "Your browser encrypts each chat before it's uploaded"])
    assert.ok(flat("src/VaultSync.jsx").includes(s), s);
  assert.ok(flat("src/DeviceVault.jsx").includes("Also forget the synced copy on ANONYMA's servers. Your other devices keep their vaults and stop syncing."));
  assert.ok(src("src/Workspace.jsx").includes("This chat changed on another device while you were writing here, so your version is kept as a separate copy."));
  assert.equal(formatBytes(188416), "184 KB");
  assert.equal(formatBytes(SYNC_MAX_BYTES), "50 MB");
  assert.equal(formatBytes(1.5 * 1024 * 1024), "1.5 MB");
});

// DeviceVault.jsx rendered on the server with Vault Sync wired in (ui.jsx
// stubbed): the dialogs and the sidebar section in each sync state.
async function vaultModule() {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-vault-sync-dv-"));
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
  const load = async (name, extra = (c) => c) => {
    const file = new URL("../src/" + name, import.meta.url);
    const { code } = await transformWithEsbuild(readFileSync(file, "utf8"), file.pathname, { jsx: "transform", format: "esm" });
    const out = extra(code)
      .replace(/^import "\.\/[\w-]+\.css";$/m, "")
      .replace(/from "\.\/ui\.jsx"/g, `from "${pathToFileURL(ui).href}"`)
      .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
      .replace(/from "react"/g, `from "${react}"`);
    const mod = join(dir, name.replace(/\.jsx$/, ".mjs"));
    writeFileSync(mod, out);
    return pathToFileURL(mod).href;
  };
  try {
    const sync = await load("VaultSync.jsx");
    return await import(await load("DeviceVault.jsx", (c) => c.replace(/from "\.\/VaultSync\.jsx"/g, `from "${sync}"`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Device Vault's dialogs and sidebar render every sync state, with honest copy while syncing", async () => {
  const { VaultDialog, VaultSection, DeviceOnlyNotice, DeviceOnlyToggle } = await vaultModule();
  const limits = { bytes: SYNC_MAX_BYTES, recordBytes: SYNC_MAX_RECORD_BYTES };
  const synced = { id: "vs_1", records: 7, bytes: 4096, kdf: {}, verifier: {} };
  const sync = { live: true, server: { vault: synced, limits }, synced, local: { enabled: true, vault: "vs_1" }, on: true, match: true, busy: false, result: null, error: "", at: Date.now(), limits };
  const chats = [chat("A trip"), { ...chat("A trip, other device"), conflictCopy: true }];
  const vault = { status: "unlocked", unlocked: true, chats, meta: { idleMinutes: 15 }, damaged: 0, lock() {} };
  const render = (el) => renderToStaticMarkup(el);
  const noop = () => {};
  // A new device while the account syncs a vault: open it, don't make one.
  const join = render(createElement(VaultDialog, { vault: { ...vault, status: "none", unlocked: false, chats: [] }, dialog: { kind: "setup" }, onClose: noop, onUnlocked: noop, sync: { ...sync, on: false, local: null } }));
  assert.match(join, /Open your synced vault/);
  assert.match(join, /Unlock synced vault/);
  assert.match(join, /type="password" data-i18n="off"/);
  // Without Vault Sync (unreleased: no `sync`), setup is unchanged.
  const setup = render(createElement(VaultDialog, { vault: { ...vault, status: "none" }, dialog: { kind: "setup" }, onClose: noop, onUnlocked: noop }));
  assert.match(setup, /Set up Device Vault/);
  assert.doesNotMatch(setup, /synced|Sync/);
  // Managing: the sync block comes first after the idle lock.
  const manage = render(createElement(VaultDialog, { vault, dialog: { kind: "manage" }, onClose: noop, onUnlocked: noop, sync }));
  assert.ok(manage.indexOf("Sync across devices") < manage.indexOf("Move to another device"));
  assert.match(manage, /7 chats synced · 4 KB of 50 MB used/);
  assert.doesNotMatch(render(createElement(VaultDialog, { vault, dialog: { kind: "manage" }, onClose: noop, onUnlocked: noop })), /Sync across devices/);
  // Deleting a chat says where it goes.
  const del = (s) => render(createElement(VaultDialog, { vault, dialog: { kind: "delete", chat: chats[0] }, onClose: noop, onUnlocked: noop, sync: s }));
  assert.match(del(sync), /deleted from this vault on every device that syncs it/);
  assert.match(del(null), /It was never on ANONYMA(&#x27;|')s\s+servers/);
  // The sidebar: the conflict copy's tag (translated) before its title
  // (kept as written), and the sync line.
  const side = render(createElement(VaultSection, { vault, currentId: null, onOpen: noop, onDialog: noop, sync }));
  assert.match(side, /<span class="vault-copy-tag">Conflict copy<\/span><span data-i18n="off">A trip, other device<\/span>/);
  assert.match(side, /Synced across your devices/);
  const plain = render(createElement(VaultSection, { vault, currentId: null, onOpen: noop, onDialog: noop }));
  assert.doesNotMatch(plain, /Conflict copy|Synced/);
  // The composer's notice and toggle while syncing.
  assert.match(render(createElement(DeviceOnlyNotice, { locked: false, synced: true })), /store only\s+ciphertext/);
  assert.match(render(createElement(DeviceOnlyNotice, { locked: false })), /store none of it/);
  assert.match(render(createElement(DeviceOnlyToggle, { active: true, synced: true })), /ANONYMA stores only ciphertext/);
  // Every one of these, and the On-device and Projects variants, in Chinese.
  const dict = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
  const lines = [
    ...textsOf(join + manage + del(sync) + side),
    ...textsOf(render(createElement(DeviceOnlyNotice, { locked: false, synced: true }))),
    "Device only: encrypted in this browser and synced end-to-end encrypted; ANONYMA stores only ciphertext",
    "Encrypted on this device with your passphrase. Vault Sync keeps only ciphertext on our servers.",
    "New chats here start Device only: they're kept encrypted in this browser and listed below while Device Vault is unlocked. Vault Sync keeps only ciphertext on our servers.",
    "New chats are kept encrypted in this browser's Device Vault; Vault Sync keeps only ciphertext on our servers. This choice stays in this browser; elsewhere they start off the record.",
  ];
  for (const line of new Set(lines)) {
    if (/^\d+ minutes$|^1 hour$/.test(line)) continue;
    const zh = translateText(line, dict);
    assert.ok(zh && han.test(zh), `zh: ${line} → ${zh}`);
  }
  assert.ok(src("src/OnDevice.jsx").includes("Encrypted on this device with your passphrase. Vault Sync keeps only ciphertext on our servers."));
  assert.match(src("src/Projects.jsx"), /vaultSynced=\{!!vault\?\.synced\}/);
  assert.match(src("src/Workspace.jsx"), /vault\.synced = vaultSync\.on;/);
});
