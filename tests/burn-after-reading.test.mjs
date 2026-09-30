import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { MIGRATIONS, uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import { burnFingerprint } from "../server/routes/shares.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { BURN_FACTS, BURN_GONE, SHARE_TOKEN, deviceSnapshot } from "../src/share-links.js";
import { forgetShareKey, openSnapshot, sealSnapshot } from "../src/sealed-share.js";

// Release commits flip `released` on UPDATES entries; these tests cover the
// gate itself, so every update is pinned unreleased for this file.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const DAY = 86400000;
const src = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");

function fixture(t, released) {
  released = released ?? "all";
  const dir = mkdtempSync(join(tmpdir(), "anonyma-burn-"));
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
async function say(agent, content) {
  const r = await agent
    .post("/api/chat")
    .send({ model: MODEL, messages: [{ role: "user", content }], max_tokens: 50 })
    .expect(200);
  return r.text
    .split("\n\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)))
    .find((e) => e.anonyma)?.conversationId;
}
const tokenOf = (link) => link.path.split("/").pop();
const IP = "198.51.100.7";
const view = (s, token) => request(s.app).get("/api/s/" + token).set("X-Forwarded-For", IP);
const page = (s, token) => request(s.app).get("/s/" + token).set("X-Forwarded-For", IP);
const reveal = (s, token) =>
  request(s.app).post("/api/s/" + token + "/open").set("X-Forwarded-For", IP).send({});
// What the Share dialog does for a sealed link: the server's draft, sealed
// in "the browser" (Node's WebCrypto), then only the ciphertext uploaded.
async function sealBurn(agent, conversationId, extra = {}) {
  const draft = (await agent.post("/api/shares/draft").send({ conversationId }).expect(200)).body;
  const box = await sealSnapshot({ title: draft.title, messages: draft.messages });
  const r = await agent
    .post("/api/shares")
    .send({ sealed: true, conversationId, ciphertext: box.ciphertext, burn: true, ...extra });
  return { r, box, draft };
}
// Every byte the server has written: the database and its write-ahead log.
function storedBytes(s) {
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const file = join(s.dir, "test.sqlite");
  return Buffer.concat([file, file + "-wal"].filter(existsSync).map((f) => readFileSync(f)));
}
const burnRow = (s, id) => s.db.prepare("SELECT * FROM share_burns WHERE id=?").get(id);

// The Share dialog, rendered with the app's pieces stubbed.
async function shareLinksModule() {
  const file = new URL("../src/ShareLinks.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(file, "utf8"), file.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-burn-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `const box = (tag) => ({ children }) => React.createElement(tag, null, children);
     export const Icon = ({ name }) => React.createElement("i", { "data-icon": name });
     export const Button = ({ children, type }) => React.createElement("button", { type }, children);
     export const Modal = ({ title, children }) => React.createElement("section", null, React.createElement("h2", null, title), children);
     export const CopyButton = ({ label }) => React.createElement("button", null, label);
     export const Notice = box("div");`,
  );
  const context = stub("context.mjs", `export const useApp = () => globalThis.__burnApp;`);
  const router = stub(
    "router.mjs",
    `export const Link = ({ children, to }) => React.createElement("a", { href: to }, children);`,
  );
  const out = code
    .replace(/^import "\.\/share-links\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/context\.jsx"/g, `from "${context}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "\.\/(lib|share-links|sealed-share)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const path = join(dir, "ShareLinks.mjs");
  writeFileSync(path, out);
  try {
    return await import(pathToFileURL(path).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("gated: registered unreleased, needs Share a Chat, hidden and refused until released", async (t) => {
  const entry = UPDATES.find((u) => u.id === "burnlinks");
  assert.ok(entry, "registered in UPDATES");
  assert.equal(entry.title, "Burn After Reading");
  assert.equal(entry.tagline, "Share a chat that deletes itself once it's read.");
  assert.equal(entry.points.length, 3);
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.match(src("src/Pages.jsx"), /burnlinks: "flame"/);
  // Server gates: a create that asks for it either way, and the one POST.
  const gate = (path, body = {}, method = "POST") => featuresFor({ path, method, body });
  assert.deepEqual(gate("/api/shares", { conversationId: "c", burn: true }), ["sharelinks", "burnlinks"]);
  assert.deepEqual(gate("/api/shares", { conversationId: "c", burn: false }), ["sharelinks", "burnlinks"]);
  assert.deepEqual(gate("/api/shares", { sealed: true, burn: true }), ["sharelinks", "sealedshare", "burnlinks"]);
  assert.deepEqual(gate("/api/shares", { conversationId: "c" }), ["sharelinks"]);
  assert.deepEqual(gate("/api/s/" + "a".repeat(32) + "/open"), ["sharelinks", "burnlinks"]);
  assert.deepEqual(gate("/API/S/" + "A".repeat(32) + "/OPEN"), ["sharelinks", "burnlinks"]);
  assert.deepEqual(gate("/api/s/x", {}, "GET"), ["sharelinks"]);

  // Share a Chat and Sealed Share live, this one not.
  const s = fixture(t, "mvp,sharelinks,sealedshare");
  const { agent, user } = await person(s, "gated");
  const conversation = await say(agent, "Gate check");
  for (const res of [
    () => agent.post("/api/shares").send({ conversationId: conversation, burn: true }),
    () => agent.post("/api/shares").send({ conversationId: conversation, burn: false }),
    () => sealBurn(agent, conversation).then((x) => x.r),
    () => reveal(s, "b".repeat(32)),
  ]) {
    const r = await res();
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.equal(r.body.error.message, "Burn After Reading is coming soon.");
  }
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_burns").get().n, 0);
  // Ordinary links still work.
  await agent.post("/api/shares").send({ conversationId: conversation }).expect(201);
  // A burn link written some other way looks like one that doesn't exist.
  const token = "b".repeat(32),
    id = uid("share_");
  s.db
    .prepare("INSERT INTO share_links(id,user_id,conversation_id,token,title,snapshot,message_count,created) VALUES(?,?,?,?,'t','[]',0,?)")
    .run(id, user.id, conversation, burnFingerprint(token), Date.now());
  s.db.prepare("INSERT INTO share_burns(id,user_id) VALUES(?,?)").run(id, user.id);
  await view(s, token).expect(404);
  await page(s, token).expect(404);
  assert.equal(burnRow(s, id).opened, null);
  // The contract lists the open route only once it's released.
  assert.equal(openapiForConfig(s.cfg).paths["/api/s/{token}/open"], undefined);
  assert.ok(openapiForConfig({ released: "all" }).paths["/api/s/{token}/open"].post);

  // The Share dialog offers it only once released.
  const { ShareDialog, burnLinksLive } = await shareLinksModule();
  const render = (features) => {
    globalThis.__burnApp = { config: { releases: { features } } };
    try {
      return renderToStaticMarkup(
        createElement(ShareDialog, { conversation: { id: "c1", title: "A chat" }, blocked: null, onClose() {} }),
      );
    } finally {
      delete globalThis.__burnApp;
    }
  };
  const before = render({ sharelinks: true, sealedshare: true });
  assert.doesNotMatch(before, /Burn after reading|flame/);
  const live = render({ sharelinks: true, sealedshare: true, burnlinks: true });
  assert.match(live, /Burn after reading/);
  assert.match(live, /type="checkbox"/);
  assert.doesNotMatch(live, /type="checkbox"[^>]*checked/, "off unless chosen");
  assert.equal(burnLinksLive({ releases: { features: { burnlinks: true } } }), false, "needs Share a Chat too");
  assert.equal(burnLinksLive({ releases: { features: { sharelinks: true, burnlinks: true } } }), true);
});

test("a GET never opens it: previews, unfurlers and prefetchers see only that it opens once", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "burner");
  const conversation = await say(agent, "Plan a quiet week in Porto");
  const made = await agent
    .post("/api/shares")
    .send({ conversationId: conversation, title: "Burn title Q7Z Lisbon", burn: true })
    .expect(201);
  const link = made.body;
  const token = tokenOf(link);
  assert.match(token, SHARE_TOKEN);
  assert.equal(link.url, "https://share.example.test/s/" + token);
  assert.equal(link.burn, true);
  assert.equal(link.opened, null);
  assert.equal(link.title, "Burn title Q7Z Lisbon");
  // The token itself is never stored: only its SHA-256.
  const row = s.db.prepare("SELECT token FROM share_links WHERE id=?").get(link.id);
  assert.equal(row.token, burnFingerprint(token));
  assert.doesNotMatch(row.token, SHARE_TOKEN, "never a token an earlier build could look up");
  assert.equal(storedBytes(s).indexOf(Buffer.from(token)), -1);
  // Nor does the owner's list give the address again.
  const listed = (await agent.get("/api/shares").expect(200)).body.data.find((l) => l.id === link.id);
  assert.equal(listed.url, null);
  assert.equal(listed.path, null);
  assert.equal(listed.burn, true);
  assert.equal(listed.opened, null);

  // Every kind of GET, as often as any bot likes.
  for (const ua of [
    "Twitterbot/1.0",
    "TelegramBot (like TwitterBot)",
    "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
  ]) {
    const v = await view(s, token).set("User-Agent", ua).expect(200);
    assert.deepEqual(v.body, { burn: true, sealed: false });
    assert.equal(v.headers["referrer-policy"], "no-referrer");
    assert.equal(v.headers["x-robots-tag"], "noindex, nofollow");
    assert.equal(v.headers["cache-control"], "no-store");
    const p = await page(s, token).set("User-Agent", ua).set("Purpose", "prefetch").expect(200);
    assert.ok(!p.text.includes("Q7Z") && !p.text.includes("Porto"), "nothing of it in the page");
  }
  await request(s.app).head("/s/" + token).set("X-Forwarded-For", IP).expect(200);
  assert.equal(burnRow(s, link.id).opened, null, "still unopened after every GET");
  assert.ok(storedBytes(s).indexOf(Buffer.from("Burn title Q7Z Lisbon")) > -1, "still held");
  // A form post or another site's script can't open it either.
  await request(s.app)
    .post("/api/s/" + token + "/open")
    .set("X-Forwarded-For", IP)
    .type("form")
    .send("go=1")
    .expect(415);
  await request(s.app)
    .post("/api/s/" + token + "/open")
    .set("X-Forwarded-For", IP)
    .set("Origin", "https://unfurler.example")
    .send({})
    .expect(403);
  assert.equal(burnRow(s, link.id).opened, null);

  // The click: the snapshot, once, and then it's gone from the server.
  const before = Date.now();
  const opened = await reveal(s, token).expect(200);
  assert.equal(opened.headers["cache-control"], "no-store");
  assert.equal(opened.body.title, "Burn title Q7Z Lisbon");
  assert.equal(opened.body.messages[0].text, "Plan a quiet week in Porto");
  assert.ok(opened.body.opened >= before);
  assert.equal(burnRow(s, link.id).opened, opened.body.opened);
  const gone = s.db.prepare("SELECT title,snapshot,message_count FROM share_links WHERE id=?").get(link.id);
  assert.deepEqual({ ...gone }, { title: "", snapshot: "", message_count: 0 });
  assert.equal(storedBytes(s).indexOf(Buffer.from("Burn title Q7Z Lisbon")), -1, "overwritten in the file");
  assert.equal(s.db.prepare("PRAGMA secure_delete").get().secure_delete, 0, "restored");
  // A reload gets the page for a link that's gone.
  await view(s, token).expect(404);
  await page(s, token).expect(404);
  // The owner sees when, and nothing else.
  const after = (await agent.get("/api/shares").expect(200)).body.data.find((l) => l.id === link.id);
  assert.equal(after.opened, opened.body.opened);
  assert.equal(after.title, null);
  assert.equal(after.messages, null);
  assert.equal(after.url, null);
});

test("opens once under concurrency, and a spent link looks exactly like a revoked, expired or unknown one", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "racer");
  const conversation = await say(agent, "Race me");
  const make = async (extra = {}) =>
    (await agent.post("/api/shares").send({ conversationId: conversation, burn: true, ...extra }).expect(201)).body;
  // Two at once: exactly one wins.
  const a = await make();
  const pair = await Promise.all([reveal(s, tokenOf(a)), reveal(s, tokenOf(a))]);
  assert.deepEqual(pair.map((r) => r.status).sort(), [200, 404]);
  // And five at once, on another.
  const b = await make();
  const five = await Promise.all(Array.from({ length: 5 }, () => reveal(s, tokenOf(b))));
  assert.equal(five.filter((r) => r.status === 200).length, 1);
  // Revoked, expired, unknown, malformed and an ordinary revoked link: the
  // same answer as a spent one, on every route.
  const revoked = await make();
  await agent.delete("/api/shares/" + revoked.id).expect(200);
  const expired = await make({ expires_in_days: 1 });
  s.db.prepare("UPDATE share_links SET expires=? WHERE id=?").run(Date.now() - 1, expired.id);
  const ordinary = (await agent.post("/api/shares").send({ conversationId: conversation }).expect(201)).body;
  await agent.delete("/api/shares/" + ordinary.id).expect(200);
  const tokens = {
    spent: tokenOf(a),
    revoked: tokenOf(revoked),
    expired: tokenOf(expired),
    unknown: "z".repeat(32),
    malformed: "short",
    ordinary: tokenOf(ordinary),
  };
  const answers = {};
  for (const [name, token] of Object.entries(tokens)) {
    const v = await view(s, token);
    const o = await reveal(s, token);
    const p = await page(s, token);
    answers[name] = JSON.stringify([v.status, v.body, o.status, o.body, p.status, p.headers["referrer-policy"]]);
  }
  for (const name of Object.keys(tokens)) assert.equal(answers[name], answers.spent, name);
  assert.equal(JSON.parse(answers.spent)[1].error.code, "share_not_found");
  // The page says the same for all of them, naming no reason.
  assert.equal(BURN_GONE.title, "This chat was already opened, or isn't available.");
  const viewer = src("src/SharedChat.jsx");
  assert.match(viewer, /state\.status === "missing" && burnLive/);
  // An expired burn link that was never opened is refused too.
  assert.equal(burnRow(s, expired.id).opened, null);
});

test("sealed: the server holds only ciphertext, gives it once, then deletes it", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "sealer");
  const conversation = await say(agent, "Sealed secret Zanzibar 7731");
  const { r, box, draft } = await sealBurn(agent, conversation);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const link = r.body;
  assert.equal(link.sealed, true);
  assert.equal(link.burn, true);
  assert.equal(link.url, "https://share.example.test/s/" + tokenOf(link), "the address, in this reply only");
  // A GET: only that it's sealed and opens once, never the ciphertext.
  const v = await view(s, tokenOf(link)).expect(200);
  assert.deepEqual(v.body, { burn: true, sealed: true });
  // The click: the ciphertext, which the link's key opens.
  const opened = await reveal(s, tokenOf(link)).expect(200);
  assert.deepEqual(Object.keys(opened.body).sort(), ["ciphertext", "created", "opened", "sealed"]);
  assert.equal(opened.body.ciphertext, box.ciphertext);
  const snapshot = await openSnapshot(opened.body.ciphertext, box.key);
  assert.deepEqual(snapshot.messages, draft.messages);
  assert.equal(
    s.db.prepare("SELECT length(ciphertext) n FROM sealed_shares WHERE id=?").get(link.id).n,
    0,
    "the ciphertext is gone",
  );
  await reveal(s, tokenOf(link)).expect(404);
  await view(s, tokenOf(link)).expect(404);
  // A Device-only chat can burn too.
  const device = deviceSnapshot([{ role: "user", content: "Device secret" }, { role: "assistant", content: "ok", model: MODEL }], "", (id) => id);
  const dbox = await sealSnapshot(device);
  const d = (
    await agent
      .post("/api/shares")
      .send({ sealed: true, device: true, ciphertext: dbox.ciphertext, burn: true })
      .expect(201)
  ).body;
  assert.equal(d.device_only, true);
  assert.equal(d.burn, true);
  const dopen = await reveal(s, tokenOf(d)).expect(200);
  assert.equal((await openSnapshot(dopen.body.ciphertext, dbox.key)).messages[0].text, "Device secret");
  // The key leaves this tab's history once the link is spent.
  const history = {
    state: { idx: 3, anonymaSealedKey: { token: tokenOf(d), key: dbox.key } },
    replaceState(state) {
      this.state = state;
    },
  };
  forgetShareKey(tokenOf(d), history);
  assert.deepEqual(history.state, { idx: 3 });

  // Without Sealed Share released, a sealed burn link is unreachable.
  const s2 = fixture(t, "mvp,sharelinks,burnlinks");
  const { agent: other, user } = await person(s2, "other");
  const c2 = await say(other, "Hello");
  const token = "q".repeat(32),
    id = uid("share_");
  s2.db
    .prepare("INSERT INTO sealed_shares(id,user_id,conversation_id,token,ciphertext,created) VALUES(?,?,?,?,randomblob(64),?)")
    .run(id, user.id, c2, burnFingerprint(token), Date.now());
  s2.db.prepare("INSERT INTO share_burns(id,user_id) VALUES(?,?)").run(id, user.id);
  await view(s2, token).expect(404);
  await reveal(s2, token).expect(404);
  assert.equal(burnRow(s2, id).opened, null);
});

test("the owner's list, revoke, expiry and limits", async (t) => {
  const s = fixture(t);
  const { agent } = await person(s, "owner");
  const conversation = await say(agent, "Limits");
  const bad = await agent.post("/api/shares").send({ conversationId: conversation, burn: "yes" }).expect(400);
  assert.equal(bad.body.error.message, "burn must be true or false.");
  // The existing expiry still applies.
  const day = (await agent.post("/api/shares").send({ conversationId: conversation, burn: true, expires_in_days: 1 }).expect(201)).body;
  assert.ok(Math.abs(day.expires - (day.created + DAY)) < 5);
  // Revoking an unopened one: gone for everyone, with its burn row.
  await agent.delete("/api/shares/" + day.id).expect(200);
  assert.equal(burnRow(s, day.id), undefined);
  await view(s, tokenOf(day)).expect(404);
  // Five per conversation; an opened one no longer counts.
  const links = [];
  for (let i = 0; i < 5; i++)
    links.push((await agent.post("/api/shares").send({ conversationId: conversation, burn: true }).expect(201)).body);
  const full = await agent.post("/api/shares").send({ conversationId: conversation, burn: true }).expect(400);
  assert.equal(full.body.error.code, "share_limit");
  await reveal(s, tokenOf(links[0])).expect(200);
  await agent.post("/api/shares").send({ conversationId: conversation, burn: true }).expect(201);
  // The list: opened ones say when; removing one deletes its dates too.
  const list = (await agent.get("/api/shares?conversation=" + conversation).expect(200)).body.data;
  const spent = list.find((l) => l.id === links[0].id);
  assert.equal(typeof spent.opened, "number");
  assert.equal(list.filter((l) => l.burn && l.opened === null).length, 5);
  await agent.delete("/api/shares/" + spent.id).expect(200);
  assert.equal(burnRow(s, spent.id), undefined);
  // Deleting the conversation takes every link and its dates with it.
  await agent.delete("/api/conversations/" + conversation).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_burns").get().n, 0);
});

test("export shows dates only; Panic Wipe and account closure erase them", async (t) => {
  const s = fixture(t);
  const { agent, user } = await person(s, "exporter");
  const conversation = await say(agent, "Export secret Marrakesh 4412");
  const plain = (await agent.post("/api/shares").send({ conversationId: conversation, burn: true, title: "Kept title" }).expect(201)).body;
  const spent = (await agent.post("/api/shares").send({ conversationId: conversation, burn: true, title: "Spent title" }).expect(201)).body;
  const { r: sealed, box } = await sealBurn(agent, conversation);
  await reveal(s, tokenOf(spent)).expect(200);
  const exported = (await agent.get("/api/account/export").expect(200)).body;
  const text = JSON.stringify(exported.shareLinks) + JSON.stringify(exported.sealedShares);
  for (const token of [tokenOf(plain), tokenOf(spent), tokenOf(sealed.body)]) {
    assert.ok(!text.includes(token), "no address");
    assert.ok(!text.includes(burnFingerprint(token)), "no fingerprint");
  }
  assert.ok(!text.includes(box.ciphertext), "never the sealed copy");
  assert.ok(!text.includes("Spent title"));
  const byId = Object.fromEntries([...exported.shareLinks, ...exported.sealedShares].map((l) => [l.id, l]));
  assert.equal(byId[plain.id].burn_after_reading, true);
  assert.equal(byId[plain.id].opened, null);
  assert.equal(byId[plain.id].url, null);
  assert.equal(byId[spent.id].burn_after_reading, true);
  assert.equal(typeof byId[spent.id].opened, "number");
  assert.equal(byId[spent.id].title, null);
  assert.equal(byId[spent.id].messages, null);
  assert.equal(byId[sealed.body.id].ciphertext, null);
  assert.equal(typeof byId[sealed.body.id].created, "number");
  // Panic Wipe: every link and every date.
  await agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_burns WHERE user_id=?").get(user.id).n, 0);
  await view(s, tokenOf(plain)).expect(404);
  // Account closure, through the same erase.
  const { agent: closer, user: gone } = await person(s, "closer");
  const c2 = await say(closer, "Close me");
  await closer.post("/api/shares").send({ conversationId: c2, burn: true }).expect(201);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_burns WHERE user_id=?").get(gone.id).n, 1);
  await closer.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM share_burns WHERE user_id=?").get(gone.id).n, 0);
});

test("the migration is additive, its rows follow their links, and an earlier build can't serve one", () => {
  // Found by what it creates, not by its position.
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  let version = null;
  for (let v = 0; v < MIGRATIONS.length; v++) {
    MIGRATIONS[v](db);
    db.exec(`PRAGMA user_version=${v + 1}`);
    if (version === null && db.prepare("SELECT 1 FROM sqlite_master WHERE name='share_burns'").get()) version = v + 1;
  }
  assert.ok(version, "creates share_burns");
  assert.ok(db.prepare("SELECT 1 FROM schema_additive WHERE version=?").get(version), "recorded as additive");
  // Running it again changes nothing.
  MIGRATIONS[version - 1](db);
  db.prepare("INSERT INTO users(id,created) VALUES('u1',0),('u2',0)").run();
  db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES('c1','u1','t','chat',0,0)").run();
  const token = "t".repeat(32);
  db.prepare(
    "INSERT INTO share_links(id,user_id,conversation_id,token,title,snapshot,message_count,created) VALUES('s1','u1','c1',?,'t','[]',0,0)",
  ).run(burnFingerprint(token));
  // Only for a link of the same account.
  assert.throws(() => db.prepare("INSERT INTO share_burns(id,user_id) VALUES('s1','u2')").run(), /share_burn_own_link/);
  assert.throws(() => db.prepare("INSERT INTO share_burns(id,user_id) VALUES('nope','u1')").run(), /share_burn_own_link/);
  db.prepare("INSERT INTO share_burns(id,user_id) VALUES('s1','u1')").run();
  // An earlier build finds links by the token as sent: never this one.
  assert.equal(db.prepare("SELECT 1 FROM share_links WHERE token=?").get(token), undefined);
  assert.doesNotMatch(burnFingerprint(token), SHARE_TOKEN);
  // The row goes with its link, however it goes.
  db.prepare("DELETE FROM conversations WHERE id='c1'").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM share_burns").get().n, 0);
  db.prepare("INSERT INTO sealed_shares(id,user_id,token,ciphertext,created) VALUES('s2','u1','x',randomblob(40),0)").run();
  db.prepare("INSERT INTO share_burns(id,user_id) VALUES('s2','u1')").run();
  db.prepare("DELETE FROM sealed_shares WHERE id='s2'").run();
  assert.equal(db.prepare("SELECT COUNT(*) n FROM share_burns").get().n, 0);
  db.close();
});

test("the viewer opens it only on a click, keeps it in memory, and the copy is honest in every language", () => {
  const viewer = src("src/SharedChat.jsx").replace(/\s+/g, " ");
  // The POST lives in openOnce, which only the Open button calls.
  assert.equal((viewer.match(/\bopenOnce\b/g) || []).length, 2);
  assert.match(viewer, /onClick=\{openOnce\}/);
  assert.match(viewer, /api\("\/api\/s\/" \+ token \+ "\/open", \{ method: "POST", body: \{\} \}\)/);
  // Nothing about it is written anywhere in the browser.
  assert.doesNotMatch(viewer, /localStorage|sessionStorage|indexedDB|caches\./);
  // The dialog never offers its owner an Open that would spend it.
  const dialog = src("src/ShareLinks.jsx").replace(/\s+/g, " ");
  assert.match(dialog, /\{!created\.burn && \( <a className="small-button"/);
  assert.match(BURN_FACTS.copy, /copy or screenshot/);
  const rendered = [
    "Burn after reading",
    "Not opened yet",
    "Opens once, then it's deleted from our servers. Unopened, it still expires as chosen above.",
    "Links that open once show whether and when they were opened. Their address was shown only when you made them, so here they can only be revoked.",
    "Opened once.",
    "This chat was deleted from ANONYMA's servers when you opened it. It stays on this page only until you close or reload it.",
    "You can still copy or screenshot what you see.",
    "BURN AFTER READING",
    "This chat can be opened once. Open it now?",
    "It's deleted from our servers as soon as it opens, and this link won't work again. Keep this page open while you read: closing or reloading it ends the chat.",
    "Opening…",
    "Open it now",
  ];
  const ui = [dialog, viewer, src("src/DataControls.jsx"), src("src/Whitepaper.jsx")].join(" ").replace(/\s+/g, " ");
  for (const line of rendered) assert.ok(ui.includes(line), `still used: ${line}`);
  const entry = UPDATES.find((u) => u.id === "burnlinks");
  const lines = [
    ...rendered,
    entry.title,
    entry.tagline,
    ...entry.points,
    ...Object.values(BURN_FACTS),
    ...Object.values(BURN_GONE),
    "Burn-after-reading links are exported as their dates only: when each was made, when it expires and when it was opened. Never their address or their copy.",
    "A burn-after-reading link opens once: its copy is deleted the first time someone opens it, and only its dates are kept.",
  ];
  for (const line of lines.slice(-2)) assert.ok(ui.includes(line), `still used: ${line}`);
  const zh = compileDictionary(JSON.parse(src("src/i18n/zh.json")), "zh");
  const es = compileDictionary(JSON.parse(src("src/i18n/es.json")), "es");
  for (const line of lines) {
    const z = translateText(line, zh);
    assert.ok(z && /[一-鿿]/.test(z), `zh: ${line}`);
    const e = translateText(line, es);
    assert.ok(e && e !== line, `es: ${line}`);
  }
  // With a date, in both.
  assert.equal(translateText("Opened on 9/29/2026, 3:04 PM", zh), "打开于 2026/9/29 15:04");
  assert.equal(translateText("Opened on 9/29/2026, 3:04 PM", es), "Abierto el 29/9/2026, 3:04 p. m.");
  // Never "safe", "secure" or "guaranteed" about what the reader does next.
  for (const line of lines) assert.doesNotMatch(line, /\b(safe|secure|guarantee)/i, line);
});
