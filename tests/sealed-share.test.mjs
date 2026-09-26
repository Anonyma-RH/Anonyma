import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import { withPreview } from "../server/routes/shares.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  MAX_SEALED_BYTES,
  MAX_SEALED_TOTAL_BYTES,
  MAX_SHARES_PER_CONVERSATION,
  SEALED_FACTS,
  SEALED_KEY,
  SHARE_BLOCK_MESSAGES,
  SHARE_TOKEN,
  deviceRows,
  deviceSnapshot,
  readSealedPayload,
  sealedLink,
  sealedPayload,
  shareBlocked,
  snapshotMessage,
} from "../src/share-links.js";
import {
  SEALED_ERRORS,
  captureShareKey,
  fromBase64Url,
  keyFromHash,
  openSnapshot,
  sealSnapshot,
  shareKeyFor,
  toBase64Url,
} from "../src/sealed-share.js";

// Release commits flip `released` on UPDATES entries; these tests cover the
// gate itself, so every update is pinned unreleased for this file.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const DAY = 86400000;
const src = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");

function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-sealed-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    publicUrl: "https://share.example.test",
    ...(released === "all" ? {} : { mvpModels: [MODEL] }),
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { ...svc, dir };
}
let visitor = 0;
async function person(s, username) {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `192.0.2.${++visitor % 250}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
async function say(agent, content, conversationId, extra = {}) {
  const r = await agent
    .post("/api/chat")
    .send({
      model: MODEL,
      messages: [{ role: "user", content }],
      max_tokens: 50,
      ...(conversationId ? { conversationId } : {}),
      ...extra,
    })
    .expect(200);
  return r.text
    .split("\n\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
    .find((e) => e.anonyma)?.conversationId ?? null;
}
const tokenOf = (link) => link.path.split("/").pop();
const view = (s, token, ip = "198.51.100.7") =>
  request(s.app).get("/api/s/" + token).set("X-Forwarded-For", ip);
const page = (s, token, ip = "198.51.100.7") =>
  request(s.app).get("/s/" + token).set("X-Forwarded-For", ip);
// What the Share dialog does for a saved chat: the server's draft, sealed in
// "the browser" (Node's WebCrypto here), then only the ciphertext uploaded.
async function sealSaved(agent, conversationId, { title, days } = {}) {
  const draft = (
    await agent
      .post("/api/shares/draft")
      .send({ conversationId, ...(title !== undefined ? { title } : {}) })
      .expect(200)
  ).body;
  const box = await sealSnapshot({ title: draft.title, messages: draft.messages });
  const r = await agent
    .post("/api/shares")
    .send({
      sealed: true,
      conversationId,
      ciphertext: box.ciphertext,
      ...(days !== undefined ? { expires_in_days: days } : {}),
    });
  return { r, box, draft };
}
// And for a Device-only chat: built from what the browser holds.
async function sealDevice(agent, messages, extra = {}) {
  const snapshot = deviceSnapshot(messages, "", (id) => id);
  const box = await sealSnapshot(snapshot);
  const r = await agent
    .post("/api/shares")
    .send({ sealed: true, device: true, ciphertext: box.ciphertext, ...extra });
  return { r, box, snapshot };
}
// Every byte the server has written: the database and its write-ahead log.
function storedBytes(s) {
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const file = join(s.dir, "test.sqlite");
  return Buffer.concat(
    [file, file + "-wal"].filter(existsSync).map((f) => readFileSync(f)),
  );
}

test("gated: registered unreleased after Routines, needs Share a Chat too, and says so in Chinese", async (t) => {
  const entry = UPDATES.find((u) => u.id === "sealedshare");
  assert.ok(entry, "registered in UPDATES");
  assert.equal(entry.title, "Sealed Share");
  assert.equal(entry.tagline, "Share a chat we can't read.");
  assert.equal(entry.points.length, 3);
  assert.equal(committed[UPDATES.indexOf(entry)], false, "not released until its release commit");
  assert.ok(UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "routines"));
  // Server gates: the draft and any sealed or Device-only create.
  const gate = (path, body = {}, method = "POST") => featuresFor({ path, method, body });
  assert.deepEqual(gate("/api/shares/draft"), ["sharelinks", "sealedshare"]);
  for (const body of [{ sealed: true }, { ciphertext: "x" }, { device: true }, { device: false }])
    assert.deepEqual(gate("/api/shares", body), ["sharelinks", "sealedshare"], JSON.stringify(body));
  assert.deepEqual(gate("/api/shares", { conversationId: "c" }), ["sharelinks"]);
  assert.deepEqual(gate("/api/shares", { sealed: false }), ["sharelinks"]);
  assert.deepEqual(gate("/api/s/x", {}, "GET"), ["sharelinks"]);
  // Released Share a Chat alone: open links work, sealed ones are refused.
  const s = fixture(t, "mvp,sharelinks");
  const { agent, user } = await person(s, "gated");
  const conversation = await say(agent, "Gate check");
  for (const res of [
    () => agent.post("/api/shares/draft").send({ conversationId: conversation }),
    () => agent.post("/api/shares").send({ sealed: true, conversationId: conversation, ciphertext: "AAAA" }),
    () => agent.post("/api/shares").send({ device: true, sealed: true, ciphertext: "AAAA" }),
    () => agent.post("/api/shares").send({ device: true, conversationId: conversation }),
  ]) {
    const r = await res().expect(403);
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.equal(r.body.error.message, "Sealed Share is coming soon.");
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sealed_shares").get().n, 0);
  const open = (await agent.post("/api/shares").send({ conversationId: conversation }).expect(201)).body;
  assert.equal(open.sealed, undefined);
  // A sealed row written some other way stays unreachable while unreleased.
  const token = "s".repeat(32);
  s.db
    .prepare("INSERT INTO sealed_shares(id,user_id,conversation_id,token,ciphertext,created) VALUES(?,?,?,?,randomblob(64),?)")
    .run(uid("share_"), user.id, conversation, token, Date.now());
  await view(s, token).expect(404);
  await page(s, token).expect(404);
  // The contract lists the draft only once both are released.
  assert.equal(openapiForConfig(s.cfg).paths["/api/shares/draft"], undefined);
  assert.ok(openapiForConfig({ released: "all" }).paths["/api/shares/draft"].post);
  // The export mentions sealed links only once released (or once one exists).
  const fresh = fixture(t, "mvp,sharelinks");
  const { agent: other } = await person(fresh, "fresh");
  assert.equal("sealedShares" in (await other.get("/api/account/export").expect(200)).body, false);
  // Chinese: the roadmap entry and every line the feature shows.
  const dict = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
  for (const line of [entry.title, entry.tagline, ...entry.points]) {
    const zh = translateText(line, dict);
    assert.ok(zh && /[一-鿿]/.test(zh), `zh: ${line}`);
  }
});

test("the server stores and serves only ciphertext: the plaintext is nowhere in its database", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s, "sealer");
  // A Device-only chat: the server never saw any of it.
  const secret = "Zanzibar orchard ledger 7731 and the blue heron";
  const reply = "Heron notes: a quiet answer about orchard ledgers";
  const device = [
    { role: "user", content: secret, images: [] },
    { role: "assistant", content: reply, model: MODEL, citations: [], privacy: { provider: "x" } },
  ];
  const { r, box, snapshot } = await sealDevice(agent, device, { expires_in_days: 30 });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const link = r.body;
  assert.match(tokenOf(link), SHARE_TOKEN);
  assert.equal(link.url, "https://share.example.test/s/" + tokenOf(link));
  assert.equal(link.sealed, true);
  assert.equal(link.device_only, true);
  assert.equal(link.conversation_id, null);
  assert.equal(link.title, null, "the title is sealed");
  assert.equal(link.messages, null, "so is the message count");
  assert.equal(link.bytes, fromBase64Url(box.ciphertext).length);
  assert.ok(Math.abs(link.expires - (link.created + 30 * DAY)) < 5);
  assert.match(box.key, SEALED_KEY);
  // Privacy Trail stays out of a snapshot.
  assert.doesNotMatch(JSON.stringify(snapshot), /privacy|provider/);
  // Nothing readable anywhere the server writes: not the chat, not its
  // title, not the key.
  const bytes = storedBytes(s);
  for (const plain of [secret, reply, "Zanzibar", "heron", snapshot.title, box.key])
    assert.equal(bytes.indexOf(Buffer.from(plain)), -1, `stored: ${plain}`);
  const row = s.db.prepare("SELECT * FROM sealed_shares WHERE id=?").get(link.id);
  assert.deepEqual(Object.keys(row).sort(), ["ciphertext", "conversation_id", "created", "expires", "id", "token", "user_id"]);
  assert.equal(Buffer.from(row.ciphertext).toString("base64url"), box.ciphertext, "exactly the bytes uploaded");
  // Served as it was stored, to anyone, with the privacy headers.
  const v = await view(s, tokenOf(link)).expect(200);
  assert.deepEqual(Object.keys(v.body).sort(), ["ciphertext", "created", "sealed"]);
  assert.equal(v.body.ciphertext, box.ciphertext);
  assert.equal(v.headers["referrer-policy"], "no-referrer");
  assert.equal(v.headers["x-robots-tag"], "noindex, nofollow");
  assert.equal(v.headers["cache-control"], "no-store");
  for (const leak of [secret, user.id, "sealer", link.id]) assert.ok(!v.text.includes(leak), leak);
  // The key opens it; the page shows exactly the snapshot.
  const opened = await openSnapshot(v.body.ciphertext, box.key);
  assert.deepEqual(opened, { title: snapshot.title, messages: snapshot.messages });
  assert.equal(opened.messages[0].text, secret);
  assert.equal(opened.messages[1].model, MODEL);
  const p = await page(s, tokenOf(link)).expect(200);
  assert.equal(p.headers["referrer-policy"], "no-referrer");
  assert.ok(!p.text.includes(secret) && !p.text.includes("og:title"), "no preview of a sealed link");

  // A saved chat, sealed with a title of its own: the conversation is saved
  // as before, but the sealed copy and its title are ciphertext only.
  const conversation = await say(agent, "Plan a quiet week in Porto");
  const { r: made, box: savedBox, draft } = await sealSaved(agent, conversation, {
    title: "Private itinerary Q9X",
  });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.device_only, false);
  assert.equal(made.body.conversation_id, conversation);
  assert.equal(made.body.conversation_title, "Plan a quiet week in Porto");
  assert.equal(draft.title, "Private itinerary Q9X");
  assert.equal(storedBytes(s).indexOf(Buffer.from("Private itinerary Q9X")), -1, "the sealed title");
  assert.deepEqual(
    (await openSnapshot((await view(s, tokenOf(made.body)).expect(200)).body.ciphertext, savedBox.key)).messages,
    draft.messages,
  );
  // The draft is the same snapshot an open link would publish.
  const open = (await agent.post("/api/shares").send({ conversationId: conversation }).expect(201)).body;
  assert.deepEqual((await view(s, tokenOf(open)).expect(200)).body.messages, draft.messages);
  // A sealed link never takes a plaintext title.
  const titled = await agent
    .post("/api/shares")
    .send({ sealed: true, conversationId: conversation, ciphertext: savedBox.ciphertext, title: "leak" })
    .expect(400);
  assert.match(titled.body.error.message, /sealed inside it/);
  // The owner's list: both links, no key, no sealed title.
  const list = (await agent.get("/api/shares").expect(200)).body.data;
  assert.deepEqual(list.filter((l) => l.sealed).map((l) => l.id).sort(), [link.id, made.body.id].sort());
  assert.ok(!JSON.stringify(list).includes(box.key) && !JSON.stringify(list).includes("Private itinerary"));
  // The export: addresses without keys, dates and the ciphertext as stored.
  const exported = (await agent.get("/api/account/export").expect(200)).body;
  const e = exported.sealedShares.find((l) => l.id === link.id);
  assert.deepEqual(Object.keys(e).sort(), ["ciphertext", "conversation_id", "created", "device_only", "expires", "id", "url"]);
  assert.equal(e.ciphertext, box.ciphertext);
  assert.equal(e.url, link.url);
  assert.equal(e.device_only, true);
});

test("a wrong, missing or damaged key never opens a sealed snapshot", async () => {
  const snapshot = {
    title: "Keys",
    messages: [
      { role: "user", text: "Mask [EMAIL_1] please", withheld: 1 },
      { role: "assistant", text: "Done.", model: "Some model", citations: [{ url: "https://example.org/a", title: "A" }] },
    ],
  };
  const a = await sealSnapshot(snapshot),
    b = await sealSnapshot(snapshot);
  assert.notEqual(a.key, b.key, "a fresh key every time");
  assert.notEqual(a.ciphertext, b.ciphertext, "and a fresh IV");
  assert.equal(fromBase64Url(a.key).length, 32, "256 bits");
  assert.deepEqual(await openSnapshot(a.ciphertext, a.key), snapshot);
  const code = async (fn) => {
    try {
      await fn();
    } catch (e) {
      return e.code;
    }
    return "opened";
  };
  // Someone else's key, a key one character off, a missing or short key.
  assert.equal(await code(() => openSnapshot(a.ciphertext, b.key)), "wrong_key");
  const off = a.key.slice(0, -1) + (a.key.endsWith("A") ? "B" : "A");
  assert.equal(await code(() => openSnapshot(a.ciphertext, off)), "wrong_key");
  for (const k of [undefined, "", "short", a.key + "x", a.key.slice(0, 42) + "="])
    assert.equal(await code(() => openSnapshot(a.ciphertext, k)), "no_key", String(k));
  // A tampered or truncated ciphertext.
  const bytes = fromBase64Url(a.ciphertext);
  bytes[20] ^= 1;
  assert.equal(await code(() => openSnapshot(toBase64Url(bytes), a.key)), "wrong_key");
  assert.equal(await code(() => openSnapshot(a.ciphertext.slice(0, 30), a.key)), "damaged");
  assert.equal(await code(() => openSnapshot("not base64!", a.key)), "damaged");
  // Correctly sealed but not a snapshot: refused before anything renders.
  for (const junk of [
    { format: "other", version: 1, title: "x", messages: [{ role: "user", text: "x" }] },
    { ...sealedPayload(snapshot), version: 2 },
    { ...sealedPayload(snapshot), messages: [] },
    { ...sealedPayload(snapshot), messages: [{ role: "system", text: "x" }] },
    { ...sealedPayload(snapshot), messages: [{ role: "user", text: 5 }] },
    { ...sealedPayload(snapshot), messages: [{ role: "user", text: "x", withheld: -1 }] },
  ])
    assert.equal(readSealedPayload(junk), null, JSON.stringify(junk));
  // Unknown fields are dropped and unsafe links never survive.
  assert.deepEqual(
    readSealedPayload({
      ...sealedPayload(snapshot),
      extra: "x",
      messages: [
        { role: "assistant", text: "Hi", html: "<b>", model: "M", citations: [{ url: "javascript:alert(1)" }, { url: "https://ok.example/" }] },
      ],
    }),
    { title: "Keys", messages: [{ role: "assistant", text: "Hi", model: "M", citations: [{ url: "https://ok.example/" }] }] },
  );
  for (const [k, v] of Object.entries(SEALED_ERRORS)) assert.ok(v.length > 10, k);
});

test("the key leaves the address bar before the app runs, and is never sent", () => {
  const key = "k".repeat(43),
    token = "t".repeat(32);
  const history = {
    state: { idx: 0 },
    calls: [],
    replaceState(state, _title, url) {
      this.state = state;
      this.calls.push(url);
    },
  };
  const loc = { pathname: "/s/" + token, search: "", hash: "#k=" + key };
  assert.deepEqual(captureShareKey(loc, history), { token, key });
  assert.deepEqual(history.calls, ["/s/" + token], "the address bar loses the fragment");
  assert.equal(history.state.idx, 0, "the router's own state is kept");
  assert.equal(shareKeyFor(token, history), key);
  assert.equal(shareKeyFor("u".repeat(32), history), null, "only for its own link");
  // A reload keeps it in this tab's history entry, not in the address.
  assert.deepEqual(captureShareKey({ ...loc, hash: "" }, history), { token, key });
  // A malformed key is stripped too, and read as none.
  const h2 = { state: null, calls: [], replaceState: history.replaceState };
  assert.equal(captureShareKey({ ...loc, hash: "#k=short" }, h2), null);
  assert.deepEqual(h2.calls, ["/s/" + token]);
  // Other pages and fragments are left alone.
  const h3 = { state: null, calls: [], replaceState: history.replaceState };
  assert.equal(captureShareKey({ pathname: "/docs", search: "", hash: "#k=" + key }, h3), null);
  assert.equal(captureShareKey({ ...loc, hash: "#section" }, h3), null);
  assert.deepEqual(h3.calls, []);
  assert.equal(keyFromHash("#k=" + key), key);
  assert.equal(sealedLink("https://a.test/s/" + token, key), `https://a.test/s/${token}#k=${key}`);
  // Nothing in the app reads the fragment or sends a key: main.jsx captures
  // it first, and the viewer only ever passes it to WebCrypto and the copy
  // button.
  const main = src("src/main.jsx");
  assert.ok(main.indexOf('import "./sealed-boot.js"') < main.indexOf("import React"), "captured before any other module");
  const viewer = src("src/SharedChat.jsx"),
    crypto = src("src/sealed-share.js");
  for (const code of [viewer, crypto]) {
    for (const call of [/\bfetch\(/, /sendBeacon/, /XMLHttpRequest/, /WebSocket/, /localStorage/, /sessionStorage/, /console\./, /document\.cookie/])
      assert.doesNotMatch(code, call);
    assert.doesNotMatch(code.replace(/^\s*\/\/.*$/gm, ""), /location\.(hash|href)/);
  }
  assert.equal((viewer.match(/\bapi\(/g) || []).length, 1, "one request: the ciphertext, by token");
  assert.match(viewer, /api\("\/api\/s\/" \+ token\)/);
});

test("expiry, revoke, auto-delete, deletion and account closure work as for open links", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "timer");
  const { agent: other } = await person(s, "stranger");
  const conversation = await say(agent, "Timing test");
  const made = {};
  for (const days of [1, 7, 30, null]) {
    const { r } = await sealSaved(agent, conversation, { days });
    assert.equal(r.status, 201);
    made[String(days)] = r.body;
    if (days == null) assert.equal(r.body.expires, null);
    else assert.ok(Math.abs(r.body.expires - (r.body.created + days * DAY)) < 5);
  }
  // Seven days when not chosen.
  const { r: plain } = await sealDevice(agent, [{ role: "user", content: "Default" }]);
  assert.ok(Math.abs(plain.body.expires - (plain.body.created + 7 * DAY)) < 5);
  // Sealed and open links share the five-per-conversation limit.
  await agent.post("/api/shares").send({ conversationId: conversation }).expect(201);
  const { r: sixth } = await sealSaved(agent, conversation);
  assert.equal(sixth.status, 400);
  assert.equal(sixth.body.error.code, "share_limit");
  assert.match(sixth.body.error.message, new RegExp(`up to ${MAX_SHARES_PER_CONVERSATION}`));
  // Revoke: only its owner, then gone at once, like a token never issued.
  const doomed = made["30"];
  await other.delete("/api/shares/" + doomed.id).expect(404);
  await view(s, tokenOf(doomed)).expect(200);
  await agent.delete("/api/shares/" + doomed.id).expect(200);
  await agent.delete("/api/shares/" + doomed.id).expect(404);
  const unknown = await view(s, "b".repeat(32)).expect(404);
  assert.deepEqual((await view(s, tokenOf(doomed)).expect(404)).body, unknown.body);
  await page(s, tokenOf(doomed)).expect(404);
  // Expired: the same 404 at its deadline, and maintenance reclaims it.
  s.db.prepare("UPDATE sealed_shares SET expires=? WHERE id=?").run(Date.now() - 1, made["1"].id);
  assert.deepEqual((await view(s, tokenOf(made["1"])).expect(404)).body, unknown.body);
  const ids = (await agent.get("/api/shares").expect(200)).body.data.map((l) => l.id);
  assert.ok(!ids.includes(made["1"].id) && !ids.includes(doomed.id) && ids.includes(made["7"].id));
  await s.tick();
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sealed_shares WHERE id=?").get(made["1"].id).n, 0);
  // A Device-only link expires the same way.
  s.db.prepare("UPDATE sealed_shares SET expires=? WHERE id=?").run(Date.now() - 1, plain.body.id);
  await view(s, tokenOf(plain.body)).expect(404);
  await s.tick();
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sealed_shares WHERE id=?").get(plain.body.id).n, 0);
  // Auto-delete bounds a sealed link, and a shorter one shortens it.
  const brief = await say(agent, "Short-lived chat");
  await agent.patch("/api/conversations/" + brief).send({ retention: 1 }).expect(200);
  const convExpires = s.db.prepare("SELECT expires FROM conversations WHERE id=?").get(brief).expires;
  const { r: bounded } = await sealSaved(agent, brief, { days: null });
  assert.equal(bounded.body.expires, convExpires);
  assert.equal(bounded.body.ends_with_conversation, true);
  s.db.prepare("UPDATE sealed_shares SET expires=NULL WHERE id=?").run(bounded.body.id);
  assert.equal(s.db.prepare("SELECT expires FROM sealed_shares WHERE id=?").get(bounded.body.id).expires, convExpires);
  const later = await say(agent, "Kept a while");
  const { r: open } = await sealSaved(agent, later, { days: null });
  await agent.patch("/api/conversations/" + later).send({ retention: 7 }).expect(200);
  const week = s.db.prepare("SELECT expires FROM conversations WHERE id=?").get(later).expires;
  assert.equal(s.db.prepare("SELECT expires FROM sealed_shares WHERE id=?").get(open.body.id).expires, week);
  // A conversation past its auto-delete takes its sealed links at once.
  s.db.prepare("UPDATE conversations SET expires=? WHERE id=?").run(Date.now() - 1, later);
  await view(s, tokenOf(open.body)).expect(404);
  // Deleting a conversation deletes its sealed links; Device-only ones stay.
  const { r: device } = await sealDevice(agent, [{ role: "user", content: "Kept on device" }], { expires_in_days: null });
  await agent.delete("/api/conversations/" + conversation).expect(200);
  await view(s, tokenOf(made["7"])).expect(404);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sealed_shares WHERE conversation_id=?").get(conversation).n, 0);
  await view(s, tokenOf(device.body)).expect(200);
  // Closing the account deletes every sealed link, Device-only ones too.
  await agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  await view(s, tokenOf(device.body)).expect(404);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM sealed_shares").get().n, 0);
});

test("the size cap: one link, and everything an account keeps sealed", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s, "hefty");
  const post = (ciphertext, extra = {}) =>
    agent.post("/api/shares").send({ sealed: true, device: true, ciphertext, ...extra });
  const b64 = (n) => Buffer.alloc(n, 7).toString("base64url");
  // Exactly the cap is accepted; one byte over isn't.
  const at = await post(b64(MAX_SEALED_BYTES)).expect(201);
  assert.equal(at.body.bytes, MAX_SEALED_BYTES);
  const over = await post(b64(MAX_SEALED_BYTES + 1)).expect(400);
  assert.equal(over.body.error.code, "share_too_large");
  assert.match(over.body.error.message, /3 MB at most/);
  // The browser refuses before uploading, too.
  const huge = "x".repeat(MAX_SEALED_BYTES);
  await assert.rejects(
    sealSnapshot({ title: "Big", messages: [{ role: "user", text: huge }] }),
    (e) => e.code === "too_large",
  );
  // Malformed ciphertext.
  for (const bad of [undefined, 42, "", "has spaces", "a+b/", b64(20), b64(30) + "=", "A"])
    assert.equal((await post(bad).expect(400)).body.error.code, "invalid_request", String(bad));
  // Everything live and sealed for one account: at most 32 MB.
  const insert = s.db.prepare(
    "INSERT INTO sealed_shares(id,user_id,conversation_id,token,ciphertext,created) VALUES(?,?,NULL,?,zeroblob(?),?)",
  );
  const held = Math.floor(MAX_SEALED_TOTAL_BYTES / MAX_SEALED_BYTES) - 1;
  for (let i = 0; i < held; i++) insert.run(uid("share_"), user.id, uid().slice(0, 32), MAX_SEALED_BYTES, Date.now());
  const full = await post(b64(MAX_SEALED_BYTES)).expect(400);
  assert.equal(full.body.error.code, "share_limit");
  assert.match(full.body.error.message, /32 MB in all/);
  await post(b64(1024)).expect(201);
  // Expired ones don't count.
  s.db.prepare("UPDATE sealed_shares SET expires=? WHERE user_id=?").run(Date.now() - 1, user.id);
  await post(b64(MAX_SEALED_BYTES)).expect(201);
});

test("a Device-only chat can only be shared sealed, never from Private Mode", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "device");
  const conversation = await say(agent, "A saved chat");
  const { box } = await sealDevice(agent, [{ role: "user", content: "x" }]);
  // Unsealed, or with a conversation, or without ciphertext: refused.
  const refused = [
    [{ device: true }, "share_device_sealed"],
    [{ device: true, sealed: false, ciphertext: box.ciphertext }, "share_device_sealed"],
    [{ device: true, sealed: true, conversationId: conversation, ciphertext: box.ciphertext }, "invalid_request"],
    [{ device: true, sealed: true }, "invalid_request"],
    [{ device: "yes", sealed: true, ciphertext: box.ciphertext }, "invalid_request"],
    [{ sealed: true, ciphertext: box.ciphertext }, "invalid_request"],
    [{ sealed: "true", conversationId: conversation, ciphertext: box.ciphertext }, "invalid_request"],
    [{ conversationId: conversation, ciphertext: box.ciphertext }, "invalid_request"],
    // Off the record and Private Mode, whatever else the request says.
    [{ device: true, sealed: true, ciphertext: box.ciphertext, private: true }, "share_excluded"],
    [{ device: true, sealed: true, ciphertext: box.ciphertext, ephemeral: true }, "share_excluded"],
  ];
  for (const [body, code] of refused) {
    const r = await agent.post("/api/shares").send(body).expect(400);
    assert.equal(r.body.error.code, code, JSON.stringify(body));
  }
  assert.equal(
    (await agent.post("/api/shares").send({ device: true }).expect(400)).body.error.message,
    SHARE_BLOCK_MESSAGES.device_unsealed,
  );
  // Sealed Share's gate: Device-only chats need it, and never Private Mode.
  assert.equal(shareBlocked({ deviceOnly: true, saved: true, ephemeral: true, mode: "chat" }), "device");
  assert.equal(shareBlocked({ deviceOnly: true, saved: true, ephemeral: true, mode: "chat", sealed: true }), null);
  assert.equal(shareBlocked({ deviceOnly: true, saved: false, ephemeral: true, sealed: true }), "unsaved");
  assert.equal(
    shareBlocked({ deviceOnly: true, saved: true, ephemeral: true, privateMode: true, sealed: true }),
    "device_private",
  );
  // Plain off the record, Private Mode and collab chats stay unshareable.
  assert.equal(shareBlocked({ ephemeral: true, sealed: true }), "off_record");
  assert.equal(shareBlocked({ privateMode: true, ephemeral: true, sealed: true }), "private");
  assert.equal(shareBlocked({ saved: true, collab: true, sealed: true }), "collab");
  // The workspace hands the dialog a Device-only chat only when it may be
  // shared, and the dialog offers no open option for it.
  const ws = src("src/Workspace.jsx"),
    dialog = src("src/ShareLinks.jsx");
  assert.match(ws, /deviceOnly && !blocked\s*\?\s*\{ messages: messages\.filter\(\(m\) => !m\.sample\) \}/);
  assert.match(ws, /sealed: sealedLive/);
  assert.match(dialog, /\{device \? \(\s*<div className="share-device-note"/);
  assert.match(dialog, /\.\.\.\(device \? \{ device: true \} : \{ conversationId: id \}\)/);
  assert.match(dialog, /\[sealed, setSealed\] = useState\(sealedOffered\)/, "sealed by default");
});

test("a Device-only snapshot follows the same rules: tags stay tags, attachments are placeholders", () => {
  const messages = [
    { role: "user", content: '<document name="salary.pdf">SECRET 123</document>', images: [] },
    { role: "assistant", content: "Summarised.", model: "m1", images: ["blob:x"], citations: [{ url: "https://e.test/" }, { url: "data:x" }] },
    { role: "user", content: "Email [EMAIL_1] about it", images: ["data:image/png;base64,AAAA"] },
    { role: "assistant", content: "Sure", model: "m1", interrupted: true, reasoning: "PRIVATE", requestId: "req_1", privacy: { provider: "p" } },
    { role: "assistant", content: "sample", sample: true },
    { role: "system", content: "never" },
  ];
  const snapshot = deviceSnapshot(messages, "", (id) => "Model " + id);
  assert.deepEqual(snapshot.messages, [
    { role: "user", text: "", withheld: 1 },
    { role: "assistant", text: "Summarised.", withheld: 1, model: "Model m1", citations: [{ url: "https://e.test/" }] },
    { role: "user", text: "Email [EMAIL_1] about it", withheld: 1 },
    { role: "assistant", text: "Sure", model: "Model m1", interrupted: true },
  ]);
  // Titled after the first thing typed as sent, never an attachment's name.
  assert.equal(snapshot.title, "Email [EMAIL_1] about it");
  assert.equal(deviceSnapshot(messages.slice(0, 2), "salary.pdf").title, "Shared conversation");
  assert.equal(deviceSnapshot(messages, "  My   title ").title, "My title");
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|salary|blob:|data:|PRIVATE|req_1|provider/);
  // The rows are what snapshotMessage reads for a saved chat.
  const rows = deviceRows(messages);
  assert.equal(rows.length, 4);
  assert.deepEqual(snapshotMessage(rows[2]), { role: "user", text: "Email [EMAIL_1] about it", withheld: 1 });
});

test("once released, an open link's page carries a link preview; a sealed one's never does", () => {
  const html =
    '<!doctype html><html><head><meta name="description" content="Site"/><title>ANONYMA — Site</title></head><body></body></html>';
  const out = withPreview(html, { title: 'Trip <script>"x"</script> & more', message_count: 4 });
  assert.match(out, /<title>Trip &lt;script&gt;&quot;x&quot;&lt;\/script&gt; &amp; more · ANONYMA<\/title>/);
  assert.match(out, /<meta property="og:title" content="Trip &lt;script&gt;/);
  assert.match(out, /A read-only snapshot of 4 messages, shared from ANONYMA\./);
  assert.match(out, /<meta name="robots" content="noindex, nofollow"\/>/);
  assert.doesNotMatch(out, /<script>/);
  assert.match(withPreview(html, { title: "$& $1", message_count: 1 }), /<title>\$&amp; \$1 · ANONYMA<\/title>/);
  assert.match(withPreview(html, { title: "One", message_count: 1 }), /snapshot of 1 message,/);
  // Only when Sealed Share is live, only for an open link.
  const route = src("server/routes/shares.js");
  assert.match(route, /if \(s && !s\.sealed && sealedLive\(\)\)/);
});

test("the copy is honest, and every visible line has Chinese", () => {
  assert.equal(SEALED_FACTS.who, "Anyone with the full link can read it. ANONYMA can't: the key never reaches our servers.");
  assert.equal(SEALED_FACTS.lost, "Lose the link and it can't be recovered.");
  assert.match(SEALED_FACTS.preview, /No link preview/);
  const dict = compileDictionary(JSON.parse(src("src/i18n/zh.json")));
  const ui = src("src/ShareLinks.jsx").replace(/\s+/g, " ") + src("src/SharedChat.jsx").replace(/\s+/g, " ");
  // Lines the dialog, the account list and the shared page render.
  const rendered = [
    "Device-only chat",
    "Sealed",
    "Its key is only in the link you copied.",
    "SEALED LINK CREATED",
    "Copy it now: it isn't saved anywhere else, not even in your account.",
    "Sealed in your browser: ANONYMA stores only the encrypted copy.",
    "This chat is kept only on this device.",
    "Sharing it copies it out: an encrypted copy is stored on our servers until the link expires or you revoke it. Device-only chats can only be shared sealed.",
    "How it's shared",
    "Recommended",
    "Encrypted in your browser. ANONYMA can't read it, and there's no link preview.",
    "Unsealed",
    "ANONYMA stores a readable copy, so apps can show its title in a link preview.",
    "The chat itself stays saved in your account as before; only the copy behind the link is sealed.",
    "Sealing…",
    "Seal and create link",
    "Sealed links can only be revoked here: their key is only in the link you copied, which ANONYMA never receives.",
    "Sealed snapshot",
    "Sealed.",
    "Opened in your browser with the key in your link. ANONYMA stores only the encrypted copy.",
    "SEALED CONVERSATION",
    "This link is missing its key.",
    "This sealed conversation can't be opened.",
  ];
  for (const line of rendered) assert.ok(ui.includes(line), `still used: ${line}`);
  const lines = [
    ...rendered,
    ...Object.values(SEALED_FACTS),
    ...Object.values(SEALED_ERRORS),
    SHARE_BLOCK_MESSAGES.device_private,
    SHARE_BLOCK_MESSAGES.device_unsealed,
    // Refusals the dialog can show.
    "Your sealed links can hold up to 32 MB in all. Revoke one first.",
    "This conversation is too long to share as one sealed link (3 MB at most).",
    // The data-controls and whitepaper paragraphs.
    "Sealed links are exported as their addresses without keys, their dates and the encrypted copy exactly as stored.",
    "A sealed link is encrypted in your browser first: we store only the encrypted copy, and the key stays in the link, so we can't read it.",
  ];
  for (const line of lines) {
    const zh = translateText(line, dict);
    assert.ok(zh && /[一-鿿]/.test(zh), `zh: ${line} → ${zh}`);
    const leftover = (zh.match(/[A-Za-z]{4,}/g) || []).filter((w) => !["ANONYMA"].includes(w));
    assert.deepEqual(leftover, [], `half-translated: ${line} → ${zh}`);
  }
});
