import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import http, { createServer } from "node:http";
import vm from "node:vm";
import { spawn } from "node:child_process";
import {
  createDecipheriv,
  createECDH,
  createHash,
  createPublicKey,
  hkdfSync,
  randomBytes,
  verify,
} from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import { configurationStatus } from "../server/readiness.js";
import {
  PAD_TO,
  PUSH_TTL_SECONDS,
  JWT_SECONDS,
  checkEndpoint,
  encryptPush,
  encryptRecord,
  generateVapidKeys,
  postPush,
  publicKeyObject,
  vapidKeys,
  vapidSigningInput,
  vapidToken,
} from "../server/web-push.js";
import { BACKOFF_MS, MAX_ATTEMPTS, keyIdOf } from "../server/push-alerts.js";
import {
  PUSH_KINDS,
  PUSH_BODIES_ZH,
  PUSH_BODIES_ES,
  PUSH_EVENTS,
  MAX_DEVICES,
  deviceTag,
  keyBytes,
  pushPayload,
  pushService,
  safePushUrl,
} from "../src/push-alerts.js";
import { DAY_MS, ACTIVITY_STEP_MS, REMIND_MS } from "../src/inactivity-wipe.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const b64u = (s) => Buffer.from(s.replace(/\s+/g, ""), "base64url");
const zhDict = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
const esDict = JSON.parse(readFileSync(new URL("../src/i18n/es.json", import.meta.url), "utf8"));
const zh = compileDictionary(zhDict);
const han = /\p{Script=Han}/u;
const VAPID = generateVapidKeys();
const SUBJECT = "mailto:push@anonyma.test";
const PUBLIC = "142.250.1.1";

// ---- A browser, as the push service sees it ----

// A subscription with its private half, the way a browser would hold it.
function browser(host = "fcm.googleapis.com") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  const path = host === "fcm.googleapis.com" ? "/fcm/send/" : "/wpush/v2/";
  return {
    ecdh,
    auth,
    json: {
      endpoint: `https://${host}${path}${randomBytes(18).toString("base64url")}`,
      keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") },
    },
  };
}
// RFC 8291 decryption with node's own HKDF, independent of server/web-push.js.
function decrypt(b, body) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const record = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const secret = b.ecdh.computeSecret(asPublic);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), b.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", secret, b.auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(record.subarray(record.length - 16));
  const plain = Buffer.concat([d.update(record.subarray(0, record.length - 16)), d.final()]);
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  assert.equal(plain[end], 2, "the last record's delimiter");
  return { plaintext: plain.subarray(0, end), padded: plain.length };
}
// The VAPID header checked the way a push service would (RFC 8292).
function checkVapid(authorization, endpoint, publicKey = VAPID.publicKey, subject = SUBJECT) {
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(authorization);
  assert.ok(m, "vapid t=…, k=…");
  const [, token, k] = m;
  assert.equal(k, publicKey);
  const raw = Buffer.from(k, "base64url");
  const key = createPublicKey({
    key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") },
    format: "jwk",
  });
  const [h, c, sig] = token.split(".");
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig, "base64url")));
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(c, "base64url"));
  assert.equal(claims.aud, new URL(endpoint).origin);
  assert.equal(claims.sub, subject);
  const left = claims.exp - Math.floor(Date.now() / 1000);
  assert.ok(left > 0 && left <= 24 * 3600, "valid for at most 24 hours (RFC 8292)");
  return claims;
}

// ---- The app ----

let sent = [];
let answer = () => ({ status: 201 });
function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-push-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
    vapidPublicKey: VAPID.publicKey,
    vapidPrivateKey: VAPID.privateKey,
    vapidSubject: SUBJECT,
    // Push Alerts' test transport: what would go to the push service.
    push: {
      transport: async (endpoint, req) => {
        sent.push({ endpoint, ...req });
        return answer(endpoint, req);
      },
    },
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  sent = [];
  answer = () => ({ status: 201 });
  return svc;
}
let visitor = 0;
async function person(app, username = "u" + randomBytes(4).toString("hex")) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user, ip: `203.0.113.${(visitor % 250) + 1}` };
}
async function subscribe(p, b = browser(), lang) {
  const r = await p.agent
    .post("/api/push/subscriptions")
    .send({ ...b.json, ...(lang ? { lang } : {}) })
    .expect(201);
  return { b, id: r.body.device, view: r.body };
}
const queue = (s, user) => s.db.prepare("SELECT * FROM push_queue WHERE user_id=? ORDER BY rowid").all(user);
const subs = (s, user) => s.db.prepare("SELECT * FROM push_subscriptions WHERE user_id=?").all(user);
const settings = (s, user) => s.db.prepare("SELECT * FROM push_settings WHERE user_id=?").get(user);
// What the browser received, decrypted.
function received(b, message) {
  const { plaintext, padded } = decrypt(b, message.body);
  return { payload: JSON.parse(plaintext), padded };
}
// Everything delivered to one browser so far, decrypted. (The worker's own
// ticks deliver too, so tests look at what arrived rather than the queue.)
async function arrived(s, b) {
  await s.push.idle();
  await s.push.deliver();
  return sent.filter((m) => m.endpoint === b.json.endpoint).map((m) => received(b, m).payload);
}
function clock(t, start) {
  let at = start;
  t.mock.method(Date, "now", () => at);
  return {
    get now() {
      return at;
    },
    set(ms) {
      at = ms;
    },
    advance(ms) {
      at += ms;
    },
  };
}

// ---- RFC test vectors ----

test("RFC 8188 section 3.1: aes128gcm with one record", () => {
  const body = encryptRecord({
    ikm: b64u("yqdlZ-tYemfogSmv7Ws5PQ"),
    salt: b64u("I1BsxtFttlv3u_Oo94xnmw"),
    rs: 4096,
    plaintext: Buffer.from("I am the walrus"),
  });
  assert.equal(
    body.toString("base64url"),
    "I1BsxtFttlv3u_Oo94xnmwAAEAAA-NAVub2qFgBEuQKRapoZu-IxkIva3MEB1PD-ly8Thjg",
  );
});

test("RFC 8291 section 5 and appendix A: the Web Push message", () => {
  const body = encryptPush({
    uaPublic: b64u("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
    authSecret: b64u("BTBZMqHH6r4Tts7J_aSIgg"),
    plaintext: Buffer.from("When I grow up, I want to be a watermelon"),
    asPrivate: b64u("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"),
    salt: b64u("DGv6ra1nlYgDCS1FRnbzlw"),
  });
  assert.equal(
    body.toString("base64url"),
    b64u(`DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
      mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT
      pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN`).toString("base64url"),
  );
  // The 86-octet header of appendix A.
  assert.equal(
    body.subarray(0, 86).toString("base64url"),
    b64u("DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z 9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml mlMoZIIgDll6e3vCYLocInmYWAmS6Tlz AC8wEqKK6PBru3jl7A8").toString("base64url"),
  );
  // The receiver's side (with the receiver's private key) reads it back, and
  // a padded message reads back the same.
  const ecdh = createECDH("prime256v1");
  ecdh.setPrivateKey(b64u("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"));
  const receiver = { ecdh, auth: b64u("BTBZMqHH6r4Tts7J_aSIgg") };
  assert.equal(decrypt(receiver, body).plaintext.toString(), "When I grow up, I want to be a watermelon");
  const padded = encryptPush({
    uaPublic: ecdh.getPublicKey(),
    authSecret: receiver.auth,
    plaintext: Buffer.from("short"),
    padTo: PAD_TO,
  });
  const back = decrypt(receiver, padded);
  assert.equal(back.plaintext.toString(), "short");
  assert.equal(back.padded, PAD_TO);
});

test("RFC 8292 section 2.4: the VAPID token's signing input, its signature and ours", () => {
  // The example token's three parts (kept apart so the source holds no
  // token-shaped string for the secret scanner; it expired in 2016).
  const h = "eyJ0eXAiOiJKV1QiLCJhbGciOiJFUzI1NiJ9";
  const c = "eyJhdWQiOiJodHRwczovL3B1c2guZXhhbXBsZS5uZXQiLCJleHAiOjE0NTM1MjM3NjgsInN1YiI6Im1haWx0bzpwdXNoQGV4YW1wbGUuY29tIn0";
  const sig = "i3CYb7t4xfxCDquptFOepC9GAu_HLGkMlMuCGSK2rpiUfnK9ojFwDXb1JrErtmysazNjjvW2L9OkSSHzvoD1oA";
  const k = "BA1Hxzyi1RUM1b5wjxsn7nGxAszw2u61m164i3MrAIxHF6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs";
  // The same claims give exactly the RFC's header and body.
  assert.equal(vapidSigningInput({ aud: "https://push.example.net", exp: 1453523768, sub: "mailto:push@example.com" }), `${h}.${c}`);
  // The RFC's signature verifies under the RFC's key, read the way ours are
  // (uncompressed point, r || s signature).
  const rfcKey = publicKeyObject(b64u(k));
  assert.deepEqual(rfcKey.export({ format: "jwk" }), {
    kty: "EC",
    crv: "P-256",
    x: "DUfHPKLVFQzVvnCPGyfucbECzPDa7rWbXriLcysAjEc",
    y: "F6YK5h4SDYic-dRuU_RCPCfA5aq9ojSwk5Y2EmClBPs",
  });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key: rfcKey, dsaEncoding: "ieee-p1363" }, b64u(sig)));
  // Ours verifies the same way, with our key and claims.
  const { keys } = vapidKeys({ vapidPublicKey: VAPID.publicKey, vapidPrivateKey: VAPID.privateKey, vapidSubject: SUBJECT });
  const at = Date.parse("2026-09-29T12:00:00Z");
  const token = vapidToken(keys, "https://fcm.googleapis.com", at);
  const [, claims, ours] = token.split(".");
  assert.equal(b64u(ours).length, 64, "r || s, 64 bytes");
  assert.ok(verify("sha256", Buffer.from(token.split(".").slice(0, 2).join(".")), { key: publicKeyObject(b64u(VAPID.publicKey)), dsaEncoding: "ieee-p1363" }, b64u(ours)));
  assert.deepEqual(JSON.parse(b64u(claims)), { aud: "https://fcm.googleapis.com", exp: at / 1000 + JWT_SECONDS, sub: SUBJECT });
});

test("VAPID keys: missing, malformed, mismatched or with a bad contact means unavailable", () => {
  const other = generateVapidKeys();
  const ok = { vapidPublicKey: VAPID.publicKey, vapidPrivateKey: VAPID.privateKey, vapidSubject: SUBJECT };
  assert.equal(vapidKeys({}).problem, "missing");
  assert.ok(vapidKeys(ok).keys);
  assert.ok(vapidKeys({ ...ok, vapidSubject: "https://anonyma.test/contact" }).keys);
  assert.equal(vapidKeys({ ...ok, vapidPrivateKey: other.privateKey }).problem, "mismatch");
  assert.equal(vapidKeys({ ...ok, vapidPublicKey: "not a key" }).problem, "invalid_keys");
  assert.equal(vapidKeys({ ...ok, vapidPrivateKey: VAPID.privateKey.slice(0, 20) }).problem, "invalid_keys");
  assert.equal(vapidKeys({ ...ok, vapidPublicKey: Buffer.alloc(65, 4).toString("base64url") }).problem, "invalid_keys");
  for (const vapidSubject of ["", "push@anonyma.test", "http://anonyma.test", "mailto:"])
    assert.equal(vapidKeys({ ...ok, vapidSubject }).problem, "invalid_subject", vapidSubject);
  // Readiness names the settings without their values.
  const ready = configurationStatus({ ...ok, testMode: true });
  assert.equal(ready.configured.push, true);
  assert.deepEqual(configurationStatus({ testMode: true }).missing.push, ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]);
  assert.ok(!JSON.stringify(ready).includes(VAPID.privateKey));
});

// ---- Registration and the gate ----

test("Push Alerts is registered unreleased, gated with the app's worker, and invisible before release", async (t) => {
  const i = UPDATES.findIndex((u) => u.id === "pushalerts");
  const entry = UPDATES[i];
  assert.ok(entry, "registered");
  assert.equal(typeof committed[i], "boolean");
  assert.equal(entry.title, "Push Alerts");
  assert.equal(entry.points.length, 3);
  assert.match(entry.tagline, /without giving us an email/);
  assert.deepEqual(featuresFor({ path: "/api/push", method: "GET", body: {} }), ["pushalerts", "app"]);
  assert.deepEqual(featuresFor({ path: "/API/Push/Subscriptions/ps_x", method: "DELETE", body: {} }), ["pushalerts", "app"]);
  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app);
  for (const send of [
    () => a.agent.get("/api/push"),
    () => a.agent.post("/api/push/subscriptions").send(browser().json),
    () => a.agent.delete("/api/push/subscriptions/ps_" + "0".repeat(32)),
    () => a.agent.post(`/api/push/subscriptions/ps_${"0".repeat(32)}/test`).send({}),
    () => a.agent.patch("/api/push/settings").send({ routines: false }),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Push Alerts is coming soon.");
  }
  // "app" (the worker that receives them) must be live too.
  const alone = fixture(t, "pushalerts");
  const b = await person(alone.app);
  assert.equal((await b.agent.get("/api/push").expect(403)).body.error.message, `${UPDATES.find((u) => u.id === "app").title} is coming soon.`);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.services.push, false);
  assert.equal(config.releases.features.pushalerts, false);
  assert.ok(!Object.keys(openapiForConfig(mvp.cfg).paths).some((p) => p.startsWith("/api/push")));
  // Nothing queues and nothing is exported while it's off.
  assert.equal(mvp.push.notify(a.user.id, "test"), 0);
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.equal("pushAlerts" in exported, false);
  const open = fixture(t);
  const docs = openapiForConfig(open.cfg).paths;
  assert.ok(docs["/api/push"].get && docs["/api/push/subscriptions"].post && docs["/api/push/settings"].patch);
  assert.ok(docs["/api/push/subscriptions/{id}"].delete && docs["/api/push/subscriptions/{id}/test"].post);
  assert.equal((await request(open.app).get("/api/config").expect(200)).body.services.push, true);
});

test("without VAPID keys the server says it isn't available and refuses to subscribe", async (t) => {
  const s = fixture(t, undefined, { vapidPublicKey: "", vapidPrivateKey: "", vapidSubject: "" });
  const p = await person(s.app);
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.services.push, false);
  assert.deepEqual(config.readiness.missing.push, ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]);
  const v = (await p.agent.get("/api/push").expect(200)).body;
  assert.equal(v.available, false);
  assert.equal(v.publicKey, null);
  const r = await p.agent.post("/api/push/subscriptions").send(browser().json).expect(503);
  assert.equal(r.body.error.code, "push_unavailable");
  assert.equal(r.body.error.message, "Browser notifications aren't available on this server yet.");
  assert.equal(s.push.notify(p.user.id, "test"), 0);
  // A key pair that doesn't match is the same as none (and never logged).
  const bad = fixture(t, undefined, { vapidPrivateKey: generateVapidKeys().privateKey });
  assert.equal((await request(bad.app).get("/api/config").expect(200)).body.services.push, false);
});

// ---- Subscribing ----

test("subscribing: a known push service over https, valid keys, 10 browsers, one account per browser", async (t) => {
  const s = fixture(t);
  const p = await person(s.app);
  const empty = (await p.agent.get("/api/push").expect(200)).body;
  assert.equal(empty.available, true);
  assert.equal(empty.publicKey, VAPID.publicKey);
  assert.deepEqual(empty.devices, []);
  assert.deepEqual(Object.keys(empty.events).sort(), [...PUSH_EVENTS].sort());
  assert.ok(Object.values(empty.events).every((x) => x === true), "on by default");
  // Switches can't be set before a browser is subscribed.
  assert.equal((await p.agent.patch("/api/push/settings").send({ gifts: false }).expect(400)).body.error.code, "push_no_devices");

  const good = browser();
  const bad = (json, code) =>
    p.agent
      .post("/api/push/subscriptions")
      .send(json)
      .expect(400)
      .then((r) => assert.equal(r.body.error.code, code, JSON.stringify(json).slice(0, 80)));
  await bad({ ...good.json, endpoint: "https://push.example.com/abc" }, "push_service");
  await bad({ ...good.json, endpoint: "http://fcm.googleapis.com/fcm/send/abc" }, "push_endpoint");
  await bad({ ...good.json, endpoint: "https://fcm.googleapis.com:8443/fcm/send/abc" }, "push_endpoint");
  await bad({ ...good.json, endpoint: "https://user:pw@fcm.googleapis.com/fcm/send/abc" }, "push_endpoint");
  await bad({ ...good.json, endpoint: "https://127.0.0.1/fcm/send/abc" }, "push_endpoint");
  await bad({ ...good.json, endpoint: "https://localhost/fcm/send/abc" }, "push_endpoint");
  await bad({ ...good.json, endpoint: "https://fcm.googleapis.com/x?utm_source=1" }, "push_endpoint");
  await bad({ ...good.json, endpoint: 42 }, "push_endpoint");
  await bad({ ...good.json, keys: { ...good.json.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } }, "push_keys");
  await bad({ ...good.json, keys: { ...good.json.keys, auth: randomBytes(8).toString("base64url") } }, "push_keys");
  await bad({ ...good.json, keys: { ...good.json.keys, p256dh: "not+base64/url" } }, "push_keys");
  await bad({ ...good.json, lang: "fr" }, "invalid_request");

  const { id, view } = await subscribe(p, good, "zh");
  assert.match(id, /^ps_[0-9a-f]{32}$/);
  assert.equal(view.devices.length, 1);
  const [d] = view.devices;
  assert.equal(d.service, "google");
  assert.equal(d.lang, "zh");
  assert.equal(d.lastSuccess, null);
  assert.equal(d.stale, false);
  // The page finds itself by a fingerprint; the endpoint never comes back.
  assert.equal(d.tag, await deviceTag(good.json.endpoint));
  assert.ok(!JSON.stringify(view).includes(good.json.endpoint));
  assert.ok(!JSON.stringify(view).includes(good.json.keys.p256dh));
  assert.ok(settings(s, p.user.id), "switches made with the first browser");
  // The same browser again refreshes it (a new language) rather than adding one.
  const again = await subscribe(p, good, "en");
  assert.equal(again.id, id);
  assert.equal(subs(s, p.user.id).length, 1);
  assert.equal(subs(s, p.user.id)[0].lang, "en");
  // Firefox, Safari and Edge endpoints work too.
  for (const host of ["updates.push.services.mozilla.com", "web.push.apple.com", "wns2-par02p.notify.windows.com"]) {
    const other = browser(host);
    const r = await subscribe(p, other);
    assert.equal(r.view.devices.find((x) => x.id === r.id).service, pushService(host));
  }
  while (subs(s, p.user.id).length < MAX_DEVICES) await subscribe(p);
  const full = await p.agent.post("/api/push/subscriptions").send(browser().json).expect(400);
  assert.equal(full.body.error.code, "push_limit");
  // The database refuses an eleventh too.
  assert.throws(
    () =>
      s.db
        .prepare("INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,service,lang,key_id,created) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(uid("ps_"), p.user.id, "https://fcm.googleapis.com/fcm/send/x", good.json.keys.p256dh, good.json.keys.auth, "google", "en", "k", 1),
    /push_limit/,
  );
  // A browser another account subscribes moves to it.
  const q = await person(s.app);
  await subscribe(q, good);
  assert.equal(subs(s, q.user.id).length, 1);
  assert.ok(!subs(s, p.user.id).some((x) => x.endpoint === good.json.endpoint));
  // Removing: someone else's is a 404; your own goes.
  const mine = subs(s, q.user.id)[0].id;
  await p.agent.delete("/api/push/subscriptions/" + mine).expect(404);
  await p.agent.delete("/api/push/subscriptions/../x").expect(404);
  const left = (await q.agent.delete("/api/push/subscriptions/" + mine).expect(200)).body;
  assert.deepEqual(left.devices, []);
  // The switches go with the last browser.
  assert.equal(settings(s, q.user.id), undefined);
});

test("switches: each kind can be turned off, and an unknown or non-boolean one is refused", async (t) => {
  const s = fixture(t);
  const p = await person(s.app);
  await subscribe(p);
  const v = (await p.agent.patch("/api/push/settings").send({ gifts: false, routines: false }).expect(200)).body;
  assert.equal(v.events.gifts, false);
  assert.equal(v.events.routines, false);
  assert.equal(v.events.pagewatch, true);
  await p.agent.patch("/api/push/settings").send({ gifts: "no" }).expect(400);
  await p.agent.patch("/api/push/settings").send({ email: true }).expect(400);
  await p.agent.patch("/api/push/settings").send({}).expect(400);
  // Off means nothing queues for it.
  assert.equal(s.push.notify(p.user.id, "gift_claimed"), 0);
  assert.equal(s.push.notify(p.user.id, "routine"), 0);
  assert.equal(s.push.notify(p.user.id, "pagewatch"), 1);
  // A kind whose update isn't live isn't offered or sent.
  const partial = fixture(t, "pushalerts,app,routines");
  const r = await person(partial.app);
  await subscribe(r);
  const pv = (await r.agent.get("/api/push").expect(200)).body;
  assert.deepEqual(Object.keys(pv.events), ["routines"]);
  assert.equal(partial.push.notify(r.user.id, "gift_claimed"), 0);
  assert.equal((await r.agent.patch("/api/push/settings").send({ gifts: false }).expect(400)).body.error.message, "That notification isn't available.");
});

// ---- Delivery ----

test("a test notification: VAPID-signed, encrypted to the browser, fixed size and content-free", async (t) => {
  const s = fixture(t);
  const p = await person(s.app);
  const { b, id } = await subscribe(p, browser(), "zh");
  const r = await p.agent.post(`/api/push/subscriptions/${id}/test`).send({}).expect(202);
  assert.equal(r.body.queued, true);
  assert.equal(r.body.outcome, "accepted", "sent before the answer");
  assert.ok(r.body.devices[0].lastSuccess > 0);
  assert.equal(sent.length, 1);
  const [m] = sent;
  assert.equal(m.endpoint, b.json.endpoint);
  assert.equal(m.headers.TTL, String(PUSH_TTL_SECONDS));
  assert.equal(m.headers.Urgency, "normal");
  assert.equal(m.headers["Content-Encoding"], "aes128gcm");
  assert.equal(m.headers.Topic, undefined, "no Topic: it would tell the push service the kind");
  checkVapid(m.headers.Authorization, b.json.endpoint);
  const { payload, padded } = received(b, m);
  assert.deepEqual(payload, pushPayload("test", "zh"));
  assert.equal(payload.body, "ANONYMA 的通知已正常工作。");
  assert.equal(padded, PAD_TO);
  // Delivered: the queue is empty and the browser shows when.
  assert.equal(queue(s, p.user.id).length, 0);
  const v = (await p.agent.get("/api/push").expect(200)).body;
  assert.ok(v.devices[0].lastSuccess > 0);
  // Someone else's browser can't be tested.
  const q = await person(s.app);
  await q.agent.post(`/api/push/subscriptions/${id}/test`).send({}).expect(404);
  // Every kind has the same encrypted size.
  const sizes = new Set();
  for (const kind of Object.keys(PUSH_KINDS))
    for (const lang of ["en", "zh", "es"]) {
      const body = encryptPush({
        uaPublic: b.ecdh.getPublicKey(),
        authSecret: b.auth,
        plaintext: Buffer.from(JSON.stringify(pushPayload(kind, lang))),
        padTo: PAD_TO,
      });
      sizes.add(body.length);
    }
  assert.deepEqual([...sizes], [86 + PAD_TO + 16]);
});

test("the push service's answers: 410 and 404 remove the browser, 5xx and 429 retry with backoff, others drop", async (t) => {
  const c = clock(t, Date.UTC(2026, 8, 29, 12));
  const s = fixture(t);
  const p = await person(s.app);
  const one = await subscribe(p);
  const two = await subscribe(p);
  // 410 Gone: that browser unsubscribed. Its row and its waiting messages go.
  answer = (endpoint) => ({ status: endpoint === one.b.json.endpoint ? 410 : 201 });
  s.push.notify(p.user.id, "routine");
  s.push.notify(p.user.id, "gift_claimed", { only: one.id });
  assert.equal(queue(s, p.user.id).length, 3);
  const counts = await s.push.deliver();
  assert.equal(counts.sent, 1);
  assert.equal(counts.gone, 2, "both of its messages were answered 410");
  assert.deepEqual(subs(s, p.user.id).map((x) => x.id), [two.id]);
  assert.equal(queue(s, p.user.id).length, 0, "the gone browser's messages went with it");
  // 404 too; with the last browser gone, so are the switches.
  answer = () => ({ status: 404 });
  s.push.notify(p.user.id, "routine");
  await s.push.deliver();
  assert.equal(subs(s, p.user.id).length, 0);
  assert.equal(settings(s, p.user.id), undefined);

  // 503: retried after 30 s, 2 min, 10 min, 1 h and 6 h, then dropped.
  const three = await subscribe(p);
  answer = () => ({ status: 503 });
  s.push.notify(p.user.id, "routine");
  // Two of a kind waiting for one browser are one.
  s.push.notify(p.user.id, "routine");
  assert.equal(queue(s, p.user.id).length, 1);
  for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
    const before = sent.length;
    await s.push.deliver();
    assert.equal(sent.length, before + 1);
    const [row] = queue(s, p.user.id);
    assert.equal(row.attempts, i + 1);
    assert.equal(row.next_try, c.now + BACKOFF_MS[i]);
    // Not before its time.
    c.advance(BACKOFF_MS[i] - 1);
    await s.push.deliver();
    assert.equal(sent.length, before + 1);
    c.advance(1);
  }
  await s.push.deliver();
  assert.equal(queue(s, p.user.id).length, 0, "dropped after the last try");
  assert.equal(subs(s, p.user.id).length, 1, "the browser stays");
  // 429 honours a longer Retry-After, up to the longest backoff.
  answer = () => ({ status: 429, retryAfter: 900 });
  s.push.notify(p.user.id, "routine");
  await s.push.deliver();
  assert.equal(queue(s, p.user.id)[0].next_try, c.now + 900_000);
  // No answer at all is retried too.
  s.db.prepare("DELETE FROM push_queue").run();
  answer = () => {
    throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  };
  s.push.notify(p.user.id, "routine");
  await s.push.deliver();
  assert.equal(queue(s, p.user.id)[0].attempts, 1);
  // 400, 401, 403 and 413 drop that message, keep the browser.
  for (const status of [400, 401, 403, 413]) {
    s.db.prepare("DELETE FROM push_queue").run();
    answer = () => ({ status });
    s.push.notify(p.user.id, "routine");
    await s.push.deliver();
    assert.equal(queue(s, p.user.id).length, 0, String(status));
    assert.equal(subs(s, p.user.id)[0].id, three.id);
  }
  // A message past its 4-day TTL is dropped unsent.
  answer = () => ({ status: 201 });
  s.push.notify(p.user.id, "routine");
  c.advance(PUSH_TTL_SECONDS * 1000 + 1);
  const before = sent.length;
  await s.push.deliver();
  assert.equal(sent.length, before);
  assert.equal(queue(s, p.user.id).length, 0);
  // A browser subscribed with an older key gets nothing until it subscribes again.
  s.db.prepare("UPDATE push_subscriptions SET key_id='old' WHERE id=?").run(three.id);
  assert.equal(s.push.notify(p.user.id, "routine"), 0);
  assert.equal((await p.agent.get("/api/push").expect(200)).body.devices[0].stale, true);
  const stale = (await p.agent.post(`/api/push/subscriptions/${three.id}/test`).send({}).expect(202)).body;
  assert.equal(stale.queued, false);
  assert.equal(stale.outcome, "stale");
  // A test the push service refuses for now, and one to an ended subscription.
  s.db.prepare("UPDATE push_subscriptions SET key_id=? WHERE id=?").run(keyIdOf(VAPID.publicKey), three.id);
  answer = () => ({ status: 503 });
  assert.equal((await p.agent.post(`/api/push/subscriptions/${three.id}/test`).send({}).expect(202)).body.outcome, "pending");
  s.db.prepare("DELETE FROM push_queue").run();
  answer = () => ({ status: 410 });
  const gone = (await p.agent.post(`/api/push/subscriptions/${three.id}/test`).send({}).expect(202)).body;
  assert.equal(gone.outcome, "gone");
  assert.deepEqual(gone.devices, []);
  assert.equal(keyIdOf(VAPID.publicKey).length, 16);
});

test("the network path: only a known push service, only a public address, pinned, with the right headers", async (t) => {
  // checkEndpoint is the allowlist, after Link Reader's own URL checks.
  assert.equal(checkEndpoint("https://fcm.googleapis.com/fcm/send/abc").service, "google");
  for (const bad of [
    "https://evil.example/fcm/send/abc",
    "https://fcm.googleapis.com.evil.example/x",
    "https://169.254.169.254/latest/meta-data",
    "https://[::1]/x",
    "file:///etc/passwd",
    "https://fcm.googleapis.com:444/x",
  ])
    assert.throws(() => checkEndpoint(bad), /push service|can use/, bad);
  // DNS that points at a private address is refused before any connection.
  let dialled = 0;
  await assert.rejects(
    postPush("https://fcm.googleapis.com/fcm/send/abc", { headers: {}, body: Buffer.alloc(1) }, {
      lookup: async () => [{ address: "10.0.0.7", family: 4 }],
      route: () => {
        dialled++;
        return { host: "127.0.0.1", port: 9, plain: true };
      },
    }),
    (e) => e.code === "link_blocked",
  );
  assert.equal(dialled, 0);
  // A public address: the vetted connection goes to the (test) server with the
  // push service's name as Host, and the answer's status comes back.
  const got = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      got.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(201, { "Retry-After": "7" }).end("ok");
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const routed = [];
  const r = await postPush(
    "https://fcm.googleapis.com/fcm/send/abc",
    { headers: { TTL: "60", "Content-Encoding": "aes128gcm" }, body: Buffer.from("sealed") },
    {
      lookup: async () => [{ address: PUBLIC, family: 4 }],
      route: (ip, port) => {
        routed.push({ ip, port });
        return { host: "127.0.0.1", port: srv.address().port, plain: true };
      },
    },
  );
  assert.deepEqual(r, { status: 201, retryAfter: 7 });
  assert.deepEqual(routed, [{ ip: PUBLIC, port: 443 }]);
  assert.equal(got[0].method, "POST");
  assert.equal(got[0].url, "/fcm/send/abc");
  assert.equal(got[0].headers.host, "fcm.googleapis.com");
  assert.equal(got[0].headers.ttl, "60");
  assert.equal(got[0].headers["content-encoding"], "aes128gcm");
  assert.equal(got[0].headers.cookie, undefined);
  assert.equal(got[0].headers.referer, undefined);
  assert.equal(got[0].body.toString(), "sealed");
});

// ---- Events ----

test("a routine's result queues one content-free notification per browser", async (t) => {
  const MODEL = "google/gemini-2.5-flash";
  const c = clock(t, Date.UTC(2026, 8, 25, 7, 59));
  const s = fixture(t, undefined, { mvpModels: [MODEL] });
  const p = await person(s.app);
  const one = await subscribe(p);
  const two = await subscribe(p, browser(), "zh");
  const prompt = "Summarise the secret Northwind merger memo";
  const made = (
    await p.agent
      .post("/api/routines")
      .send({ name: "Northwind digest", prompt, model: MODEL, schedule: { repeat: "daily", time: "08:00", timezone: "UTC" }, per_run_credits: 50, monthly_budget_credits: 500 })
      .expect(201)
  ).body;
  c.set(Date.UTC(2026, 8, 25, 8, 0, 30));
  await s.tick();
  await s.tick();
  const run = s.db.prepare("SELECT * FROM routine_runs WHERE routine_id=?").get(made.id);
  assert.equal(run.status, "done");
  for (const [b, lang] of [[one.b, "en"], [two.b, "zh"]]) {
    const got = await arrived(s, b);
    assert.deepEqual(got, [pushPayload("routine", lang)]);
    const text = JSON.stringify(got);
    for (const secret of ["Northwind", "merger", "Local test provider", made.id, "digest", "50"])
      assert.ok(!text.includes(secret), secret);
  }
  assert.equal(pushPayload("routine").url, "/workspace/routines");
});

test("a page watch's change queues a notification that says nothing about the page", async (t) => {
  const MODEL = "google/gemini-2.5-flash";
  const pages = new Map();
  const srv = http.createServer((req, res) => {
    const body = pages.get(new URL(req.url, "http://x").pathname);
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" }).end(body);
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const page = (price) =>
    ["Acme pricing", ...Array.from({ length: 30 }, (_, i) => `Feature ${i}: included in every plan.`), `Pro plan price: $${price} per month`].join("\n");
  pages.set("/pricing", page(49));
  const c = clock(t, Date.UTC(2026, 8, 26, 8));
  const s = fixture(t, undefined, {
    mvpModels: [MODEL],
    linkReader: {
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      route: () => ({ host: "127.0.0.1", port: srv.address().port }),
      timeoutMs: 1500,
    },
  });
  const p = await person(s.app);
  const { b } = await subscribe(p);
  await p.agent.post("/api/watches").send({ url: "http://shop.example.com/pricing", every: "6h", model: MODEL, monthly_budget_credits: 200 }).expect(201);
  await s.tick();
  await s.tick();
  assert.deepEqual(await arrived(s, b), [], "the first look is only a baseline");
  pages.set("/pricing", page(39));
  c.advance(6 * 3600000 + 1000);
  await s.tick();
  await s.tick();
  const report = s.db.prepare("SELECT status FROM page_watch_reports WHERE user_id=?").get(p.user.id);
  assert.equal(report.status, "changed");
  const got = await arrived(s, b);
  assert.deepEqual(got, [pushPayload("pagewatch")]);
  for (const secret of ["shop.example.com", "Acme", "39", "49", "pricing"])
    assert.ok(!JSON.stringify(got).includes(secret), secret);
  // Switched off, the next change queues nothing.
  await p.agent.patch("/api/push/settings").send({ pagewatch: false }).expect(200);
  pages.set("/pricing", page(29));
  c.advance(6 * 3600000 + 1000);
  await s.tick();
  await s.tick();
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM page_watch_reports WHERE user_id=?").get(p.user.id).n, 2);
  assert.equal((await arrived(s, b)).length, 1, "nothing more");
});

test("gifts: the giver learns only that a gift was claimed, or came back", async (t) => {
  const s = fixture(t);
  const giver = await person(s.app);
  const friend = await person(s.app);
  const { b } = await subscribe(giver);
  const made = (await giver.agent.post("/api/gifts").set("X-Forwarded-For", giver.ip).send({ amount: 1234, note: "For Priya's birthday" }).expect(201)).body;
  const other = await subscribe(friend);
  await friend.agent.post("/api/gifts/claim").set("X-Forwarded-For", friend.ip).send({ code: made.code }).expect(200);
  assert.deepEqual(await arrived(s, b), [pushPayload("gift_claimed")]);
  assert.deepEqual(await arrived(s, other.b), [], "the claimer gets nothing");
  // Unclaimed and expired: it comes back.
  const later = (await giver.agent.post("/api/gifts").set("X-Forwarded-For", giver.ip).send({ amount: 500 }).expect(201)).body;
  assert.equal(s.gifts.expire(Date.now() + 31 * DAY_MS), 1);
  const bodies = await arrived(s, b);
  assert.deepEqual(bodies, [pushPayload("gift_claimed"), pushPayload("gift_returned")]);
  for (const secret of ["1234", "1,234", "500", "Priya", "birthday", made.code, later.code, friend.user.username])
    assert.ok(!JSON.stringify(bodies).includes(secret), secret);
});

test("low balance: once when the settled balance drops below the Low-Balance Alerts level, again after a top-up", async (t) => {
  const s = fixture(t);
  const p = await person(s.app);
  const { b } = await subscribe(p);
  const spend = (credits) =>
    s.db
      .prepare("INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)")
      .run(uid("l_"), p.user.id, -credits * 10000, "chat", uid("ref_"), null, "test spend", Date.now());
  // No level set: nothing to compare with.
  assert.equal((await p.agent.get("/api/push").expect(200)).body.lowBalanceLevel, false);
  assert.equal(s.push.sweepBalances(), 0);
  await p.agent.patch("/api/balance-alert").send({ threshold: 500 }).expect(200);
  assert.equal((await p.agent.get("/api/push").expect(200)).body.lowBalanceLevel, true);
  // The first look only records where the balance is.
  assert.equal(s.push.sweepBalances(), 0);
  assert.equal(settings(s, p.user.id).low_state, 0);
  // A hold that's never settled doesn't count.
  s.db
    .prepare("INSERT INTO holds(id,user_id,amount,kind,status,created,expires) VALUES(?,?,?,?,?,?,?)")
    .run(p.user.id + ":h1", p.user.id, 99_900 * 10000, "chat", "held", Date.now(), Date.now() + 60000);
  assert.equal(s.push.sweepBalances(), 0);
  s.db.prepare("DELETE FROM holds WHERE id=?").run(p.user.id + ":h1");
  spend(99_600); // 100,000 test credits → 400
  assert.equal(s.push.sweepBalances(), 1);
  assert.deepEqual(queue(s, p.user.id).map((q) => q.kind), ["lowbalance"]);
  spend(100);
  assert.equal(s.push.sweepBalances(), 0, "once per drop");
  // Back above the level re-arms it.
  s.db
    .prepare("INSERT INTO ledger(id,user_id,amount,kind,ref,key_id,description,created) VALUES(?,?,?,?,?,?,?,?)")
    .run(uid("l_"), p.user.id, 1000 * 10000, "deposit", uid("ref_"), null, "top up", Date.now());
  assert.equal(s.push.sweepBalances(), 0);
  s.db.prepare("DELETE FROM push_queue").run();
  spend(900);
  assert.equal(s.push.sweepBalances(), 1);
  await s.push.deliver();
  assert.equal(sent.length, 1);
  assert.deepEqual(received(b, sent[0]).payload, pushPayload("lowbalance"));
  assert.equal(settings(s, p.user.id).low_state, 1);
  // Switching it off and on starts from the balance as it is.
  await p.agent.patch("/api/push/settings").send({ lowbalance: false }).expect(200);
  await p.agent.patch("/api/push/settings").send({ lowbalance: true }).expect(200);
  assert.equal(settings(s, p.user.id).low_state, null);
  assert.equal(s.push.sweepBalances(), 0);
});

test("Inactivity Wipe's reminder goes to browsers 7 days before, once a period, and shows in its view", async (t) => {
  const c = clock(t, Date.UTC(2026, 8, 1, 12));
  const s = fixture(t);
  const p = await person(s.app);
  const { b } = await subscribe(p);
  await p.agent.put("/api/inactivity-wipe").send({ days: 30, confirm: true }).expect(200);
  const row = s.db.prepare("SELECT * FROM inactivity_wipe WHERE user_id=?").get(p.user.id);
  const deadline = row.last_active + 30 * DAY_MS + ACTIVITY_STEP_MS;
  const remindAt = deadline - REMIND_MS;
  const view = (await p.agent.get("/api/inactivity-wipe").expect(200)).body;
  assert.deepEqual(view.push, { remindAt, sent: false });
  assert.equal(s.push.sweepInactivity(remindAt - 1), 0);
  assert.equal(s.push.sweepInactivity(remindAt), 1);
  assert.equal(s.push.sweepInactivity(remindAt + 1000), 0, "once a period");
  assert.deepEqual(queue(s, p.user.id).map((q) => q.kind), ["inactivity"]);
  c.set(remindAt);
  await s.push.deliver();
  assert.deepEqual(received(b, sent[0]).payload, pushPayload("inactivity"));
  // (Reading the view is itself activity; it's checked before and after.)
  assert.equal(s.db.prepare("SELECT inactivity_for FROM push_settings WHERE user_id=?").get(p.user.id).inactivity_for, row.last_active);
  // A new period (the account was used) can be reminded again.
  s.db.prepare("UPDATE inactivity_wipe SET last_active=? WHERE user_id=?").run(remindAt + 5000, p.user.id);
  assert.equal(s.push.sweepInactivity(remindAt + 5000 + 30 * DAY_MS + ACTIVITY_STEP_MS - REMIND_MS), 1);
  // Off, or no browser: no reminder and no push field.
  await p.agent.patch("/api/push/settings").send({ inactivity: false }).expect(200);
  assert.equal("push" in (await p.agent.get("/api/inactivity-wipe").expect(200)).body, false);
});

// ---- Erase and export ----

test("export lists browsers by push service only; Panic Wipe and closure erase every trace", async (t) => {
  const s = fixture(t);
  const p = await person(s.app);
  const { b } = await subscribe(p, browser(), "zh");
  await subscribe(p, browser("updates.push.services.mozilla.com"));
  await p.agent.patch("/api/push/settings").send({ gifts: false }).expect(200);
  s.push.notify(p.user.id, "routine");
  const exported = (await p.agent.get("/api/account/export").expect(200)).body.pushAlerts;
  assert.deepEqual(
    exported.devices.map(({ pushService, service, language, lastSuccess }) => ({ pushService, service, language, lastSuccess })),
    [
      { pushService: "fcm.googleapis.com", service: "google", language: "zh", lastSuccess: null },
      { pushService: "updates.push.services.mozilla.com", service: "mozilla", language: "en", lastSuccess: null },
    ],
  );
  assert.ok(exported.devices.every((d) => d.created > 0));
  assert.equal(exported.events.gifts, false);
  assert.equal(exported.events.routines, true);
  const text = JSON.stringify(exported);
  assert.ok(!text.includes(b.json.endpoint) && !text.includes(b.json.keys.p256dh) && !text.includes(b.json.keys.auth));
  // Panic Wipe.
  await p.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(subs(s, p.user.id).length, 0);
  assert.equal(settings(s, p.user.id), undefined);
  assert.equal(queue(s, p.user.id).length, 0);
  // Closing an account.
  const q = await person(s.app);
  await subscribe(q);
  s.push.notify(q.user.id, "routine");
  await q.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  for (const table of ["push_subscriptions", "push_settings", "push_queue"])
    assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE user_id=?`).get(q.user.id).n, 0, table);
  // Nothing is logged about it: the module has no console output with data.
  const src = readFileSync(new URL("../server/push-alerts.js", import.meta.url), "utf8") + readFileSync(new URL("../server/web-push.js", import.meta.url), "utf8");
  const logged = [...src.matchAll(/console\.\w+\(([^)]*)\)/g)].map((m) => m[1]);
  assert.ok(logged.length > 0);
  for (const arg of logged) assert.match(arg, /^"[^"`$]*"$/, "a fixed message only");
});

// ---- The service worker ----

function worker() {
  const listeners = {};
  const shown = [];
  const opened = [];
  const focused = [];
  let windows = [];
  const self = {
    location: new URL("https://askanonyma.com/sw.js"),
    addEventListener: (type, fn) => (listeners[type] = fn),
    registration: { showNotification: async (title, options) => shown.push({ title, options }) },
    clients: {
      claim: async () => {},
      matchAll: async () => windows,
      openWindow: async (url) => opened.push(url),
    },
    skipWaiting: async () => {},
  };
  vm.runInContext(readFileSync("public/sw.js", "utf8"), vm.createContext({ self, caches: {}, fetch, Request, Response, URL }));
  const fire = async (type, event) => {
    const waits = [];
    listeners[type]({ ...event, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return {
    shown,
    opened,
    focused,
    setWindows: (list) =>
      (windows = list.map((url) => ({ url, focus: async () => focused.push(url) }))),
    push: (data) => fire("push", { data: data === undefined ? null : { json: () => JSON.parse(data) } }),
    click: (url) => fire("notificationclick", { notification: { data: { url }, close: () => {} } }),
  };
}

test("the service worker shows the message as it came and opens only our own pages", async () => {
  const sw = worker();
  await sw.push(JSON.stringify(pushPayload("pagewatch", "zh")));
  assert.deepEqual(JSON.parse(JSON.stringify(sw.shown[0])), {
    title: "ANONYMA",
    options: { body: "你的网页监测发现了变化。", tag: "anonyma-pagewatch", icon: "/icons/icon-192.png", data: { url: "/workspace/routines" } },
  });
  // Unreadable: the plain name, still shown (a push must show something).
  await sw.push("not json");
  await sw.push(undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(sw.shown.slice(1).map((x) => [x.title, x.options.body, x.options.data.url]))), [
    ["ANONYMA", "", "/workspace"],
    ["ANONYMA", "", "/workspace"],
  ]);
  // A path that isn't one of ours opens the workspace instead.
  await sw.push(JSON.stringify({ ...pushPayload("routine"), url: "https://evil.example/" }));
  assert.equal(sw.shown.at(-1).options.data.url, "/workspace");
  await sw.click("//evil.example/x");
  assert.deepEqual(sw.opened, ["https://askanonyma.com/workspace"]);
  await sw.click("/account/credits#gift-links");
  assert.equal(sw.opened.at(-1), "https://askanonyma.com/account/credits#gift-links");
  // A window already on that page is focused, never navigated.
  sw.setWindows(["https://askanonyma.com/workspace/chat", "https://askanonyma.com/workspace/routines"]);
  await sw.click("/workspace/routines");
  assert.deepEqual(sw.focused, ["https://askanonyma.com/workspace/routines"]);
  assert.equal(sw.opened.length, 2);
  // Its list of pages is exactly the notifications' own.
  const src = readFileSync("public/sw.js", "utf8");
  const listed = JSON.parse("[" + /const PUSH_PATHS = \[([\s\S]*?)\];/.exec(src)[1].replace(/,\s*$/, "") + "]");
  assert.deepEqual(listed.sort(), [...new Set(Object.values(PUSH_KINDS).map((k) => k.url))].sort());
  assert.equal(safePushUrl("/account/credits"), "/account/credits");
  assert.equal(safePushUrl("javascript:alert(1)"), "/workspace");
});

// ---- The page ----

async function uiModule() {
  const src = new URL("../src/PushAlerts.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-push-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Icon = () => React.createElement("svg");
     export const Button = ({ children }) => React.createElement("button", null, children);`,
  );
  const router = stub("router.mjs", `export const Link = ({ children, to }) => React.createElement("a", { href: to }, children);`);
  const out = code
    .replace(/^import "\.\/push-alerts\.css";$/gm, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "\.\/(lib|i18n|push-alerts)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "PushAlerts.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function pageTexts(html) {
  const out = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)) out.push(entities(attr));
    else if (entities(text).trim()) out.push(entities(text).trim());
  }
  return out.filter((x) => /[A-Za-z]{2}/.test(x));
}

test("the section is gated, honest about what it does, and every word on it translates", async () => {
  const mod = await uiModule();
  const on = { services: { push: true }, releases: { features: { pushalerts: true, app: true } } };
  const soon = { services: { push: true }, releases: { features: { pushalerts: false, app: true } } };
  const user = { id: "u_1" };
  assert.equal(mod.pushAlertsReleased(on), true);
  assert.equal(mod.pushAlertsReleased(soon), false);
  assert.equal(mod.pushAlertsReleased({ releases: { features: { pushalerts: true, app: false } } }), false);
  assert.equal(renderToStaticMarkup(createElement(mod.PushAlertsSettings, { config: soon, user })), "");
  assert.equal(renderToStaticMarkup(createElement(mod.PushAlertsSettings, { config: on, user: null })), "");
  const loading = renderToStaticMarkup(createElement(mod.PushAlertsSettings, { config: on, user }));
  assert.match(loading, /id="push-alerts"/);
  assert.match(loading, /Loading…/);
  const off = renderToStaticMarkup(createElement(mod.PushAlertsSettings, { config: { ...on, services: { push: false } }, user }));
  assert.match(off, /aren’t available on this server yet/);
  assert.doesNotMatch(off, /Notify me/);
  const view = {
    available: true,
    publicKey: VAPID.publicKey,
    devices: [
      { id: "ps_1", service: "google", tag: "aaaa", lang: "en", created: Date.UTC(2026, 8, 20), lastSuccess: Date.UTC(2026, 8, 28), stale: false },
      { id: "ps_2", service: "apple", tag: "bbbb", lang: "zh", created: Date.UTC(2026, 8, 21), lastSuccess: null, stale: true },
    ],
    events: Object.fromEntries(PUSH_EVENTS.map((e) => [e, e !== "gifts"])),
    lowBalanceLevel: false,
    inactivityOn: false,
    max: 10,
  };
  const panel = (props) => renderToStaticMarkup(createElement(mod.PushAlertsPanel, { available: true, view, can: "ok", permission: "default", ...props }));
  const texts = new Set();
  for (const props of [
    { hereTag: "aaaa", notice: "Sent. It should arrive in a few seconds." },
    { hereTag: "aaaa", notice: "The push service hasn’t taken it yet. ANONYMA will keep trying for a few hours." },
    { hereTag: "aaaa", notice: "That browser’s subscription had ended, so it was removed. Turn notifications on again there." },
    { hereTag: "aaaa", notice: "This browser needs to turn notifications on again." },
    { hereTag: null, error: "Notifications weren’t allowed. Try again and choose Allow." },
    { hereTag: null, permission: "denied" },
    { hereTag: null, can: "ios-home", view: { ...view, devices: [] } },
    { hereTag: null, can: "unsupported" },
    { available: false },
  ])
    for (const x of pageTexts(panel(props))) texts.add(x);
  const html = panel({ hereTag: "aaaa" });
  assert.match(html, /This browser/);
  assert.match(html, /Send a test/);
  assert.match(html, /Stop in this browser/);
  assert.doesNotMatch(html, /Notify me in this browser/, "not while this browser is on the list");
  assert.match(panel({ hereTag: null }), /Notify me in this browser/);
  assert.doesNotMatch(panel({ hereTag: null, permission: "denied" }), /Notify me in this browser/);
  // Each switch shows the exact sentence it sends.
  for (const kind of ["pagewatch", "routine", "lowbalance", "gift_claimed", "inactivity"]) assert.ok(html.includes(PUSH_KINDS[kind].body), kind);
  assert.match(html, /never includes your chats, page text, amounts or names/);
  assert.match(html, /encrypted and the same size/);
  assert.match(html, /Signing out doesn’t stop alerts/);
  assert.match(html, /Nothing here costs credits/);
  for (const text of texts) assert.match(translateText(text, zh) ?? "", han, text);
  // The update's copy and the server's messages translate too.
  const entry = UPDATES.find((u) => u.id === "pushalerts");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Push Alerts is coming soon.",
    "Browser notifications aren't available on this server yet.",
    "That isn't a push subscription this browser can use.",
    "This browser uses a push service ANONYMA doesn't send to. Chrome, Edge, Firefox and Safari work.",
    "That subscription's keys aren't valid. Turn notifications off and on again in this browser.",
    "You can have notifications in up to 10 browsers. Remove one first.",
    "That browser isn't on your list.",
    "Turn on notifications in a browser first.",
    "That notification isn't available.",
    "Added 9/20/2026 · Last alert 9/28/2026",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
  // The notifications' Chinese is the dictionary's.
  for (const k of Object.values(PUSH_KINDS)) assert.equal(PUSH_BODIES_ZH[k.body], zhDict.strings[k.body], k.body);
  assert.deepEqual(Object.keys(PUSH_BODIES_ZH).sort(), [...new Set(Object.values(PUSH_KINDS).map((k) => k.body))].sort());
  // And the Spanish (batch 8: a browser can subscribe with the site in Spanish).
  for (const k of Object.values(PUSH_KINDS)) assert.equal(PUSH_BODIES_ES[k.body], esDict.strings[k.body], k.body);
  assert.deepEqual(Object.keys(PUSH_BODIES_ES).sort(), Object.keys(PUSH_BODIES_ZH).sort());
  assert.equal(pushPayload("research_report", "es").body, esDict.strings["Your research watch has a new briefing."]);
  // The key the page subscribes with is the server's.
  assert.deepEqual(Buffer.from(keyBytes(VAPID.publicKey)), Buffer.from(VAPID.publicKey, "base64url"));
  assert.equal(await deviceTag("x"), createHash("sha256").update("x").digest("hex").slice(0, 16));
});

test("wiring: the server image has the shared module, and the other pages mention it only once released", () => {
  const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
  assert.match(read("Dockerfile"), / src\/push-alerts\.js /);
  assert.match(read("src/Account.jsx"), /<PushAlertsSettings config=\{config\} user=\{user\} \/>/);
  assert.match(read("src/DataControls.jsx"), /const push = !!config && isReleased\(config, "pushalerts"\) && isReleased\(config, "app"\);/);
  assert.match(read("src/PanicWipe.jsx"), /\{pushLive && <li>\{WIPE_PUSH\}<\/li>\}/);
  assert.match(read("src/BalanceAlerts.jsx"), /isReleased\(config, "pushalerts"\) && isReleased\(config, "app"\) \?/);
  assert.match(read("src/Pages.jsx"), /pushalerts: "bell"/);
  // Nothing new in the page's security policy: subscribing is the browser's own.
  assert.doesNotMatch(read("src/security-headers.js"), /push/i);
});

// ---- Headless Chrome: a real service worker, a test push service ----

const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((p) => p && existsSync(p));
const BUILT = existsSync("dist/client/index.html");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () =>
  new Promise((resolve) => {
    const srv = createServer().listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
async function chrome(t) {
  const profile = mkdtempSync(join(tmpdir(), "anonyma-push-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,900", "about:blank"], { stdio: "ignore" });
  const exited = new Promise((r) => proc.once("exit", r));
  t.after(async () => {
    proc.kill();
    await Promise.race([exited, sleep(5000)]);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    await sleep(100);
    try {
      port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]);
    } catch {}
  }
  const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page");
    } catch {}
    if (!target) await sleep(100);
  }
  const connect = async (url) => {
    const ws = new WebSocket(url);
    await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
    t.after(() => ws.close());
    let seq = 0;
    const pending = new Map();
    const events = [];
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
      } else if (msg.method) events.push(msg);
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    return { send, events };
  };
  const page = await connect(target.webSocketDebuggerUrl);
  const browserSession = await connect(version.webSocketDebuggerUrl);
  const run = async (expression) => {
    const r = await page.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        const v = await run(expression);
        if (v) return v;
      } catch {}
      await sleep(100);
    }
    throw new Error("timed out: " + expression);
  };
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  return { page, browser: browserSession, run, until };
}

// The page's PushManager is the one stand-in: Chrome's real one talks to
// Google's servers. The keys are made in the page with WebCrypto, exactly as
// a browser holds them, and everything after that is real: the app's
// permission prompt and subscribe call, the server's encryption and VAPID
// signature, delivery to a local push service that checks and decrypts it,
// and the real service worker showing the notification Chrome delivers.
const FAKE_PUSH = `(() => {
  const state = { sub: null };
  const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  PushManager.prototype.getSubscription = async function () { return state.sub; };
  PushManager.prototype.subscribe = async function (options) {
    const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
    const raw = await crypto.subtle.exportKey("raw", pair.publicKey);
    const auth = crypto.getRandomValues(new Uint8Array(16));
    window.__pushSecret = { jwk: await crypto.subtle.exportKey("jwk", pair.privateKey), auth: b64u(auth), p256dh: b64u(raw), serverKey: b64u(options.applicationServerKey) };
    const endpoint = "https://fcm.googleapis.com/fcm/send/e2e-" + b64u(crypto.getRandomValues(new Uint8Array(12)));
    state.sub = {
      endpoint,
      options: { applicationServerKey: options.applicationServerKey },
      toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh: b64u(raw), auth: b64u(auth) } }),
      unsubscribe: async () => { state.sub = null; return true; },
    };
    return state.sub;
  };
})();`;

test(
  "headless Chrome: turn it on, send a test, the push service gets a signed, sealed message and the worker shows it",
  { skip: !CHROME ? "Chrome isn't installed" : !BUILT ? "run npm run build first" : false, timeout: 120000 },
  async (t) => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    // The local push service: what fcm.googleapis.com would receive.
    const service = [];
    const pushServer = createServer((req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        service.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
        res.writeHead(201).end();
      });
    });
    await new Promise((r) => pushServer.listen(0, "127.0.0.1", r));
    t.after(() => pushServer.close());
    const s = fixture(t, "all", {
      origin,
      push: {
        lookup: async () => [{ address: PUBLIC, family: 4 }],
        route: () => ({ host: "127.0.0.1", port: pushServer.address().port, plain: true }),
      },
    });
    const server = s.app.listen(port, "127.0.0.1");
    t.after(() => server.close());
    const reg = await request(s.app).post("/api/auth/register").send({ username: "push_e2e", password: "test-password-long" }).expect(201);
    const cookie = reg.headers["set-cookie"][0].split(";")[0].split("=")[1];

    const b = await chrome(t);
    await b.browser.send("Browser.grantPermissions", { origin, permissions: ["notifications"] });
    await b.page.send("Page.addScriptToEvaluateOnNewDocument", { source: FAKE_PUSH });
    await b.page.send("Network.enable");
    await b.page.send("Network.setCookie", { name: "anonyma_session", value: cookie, domain: "127.0.0.1", path: "/", httpOnly: true });
    await b.page.send("Page.navigate", { url: origin + "/account/settings" });
    await b.until(`[...document.querySelectorAll("#push-alerts button")].some((x) => x.textContent.includes("Notify me in this browser"))`);
    await b.run(`[...document.querySelectorAll("#push-alerts button")].find((x) => x.textContent.includes("Notify me in this browser")).click(), true`);
    await b.until(`document.querySelector("#push-alerts")?.innerText.includes("This browser")`);
    const secret = await b.run("window.__pushSecret");
    assert.equal(secret.serverKey, VAPID.publicKey, "subscribed with the server's VAPID key");
    const [row] = s.db.prepare("SELECT * FROM push_subscriptions").all();
    assert.equal(row.p256dh, secret.p256dh);
    // A test notification, through the real network path to the push service.
    await b.run(`[...document.querySelectorAll("#push-alerts button")].find((x) => x.textContent.includes("Send a test")).click(), true`);
    await b.until(`document.querySelector("#push-alerts")?.innerText.includes("Sent. It should arrive")`);
    await s.push.idle();
    for (let i = 0; i < 50 && !service.length; i++) await sleep(100);
    assert.equal(service.length, 1);
    const [m] = service;
    assert.match(m.url, /^\/fcm\/send\/e2e-/);
    assert.equal(m.headers.host, "fcm.googleapis.com");
    assert.equal(m.headers["content-encoding"], "aes128gcm");
    checkVapid(m.headers.authorization, "https://fcm.googleapis.com" + m.url);
    // The push service can't read it; the browser's key can.
    const priv = createECDH("prime256v1");
    priv.setPrivateKey(Buffer.from(secret.jwk.d, "base64url"));
    const { payload } = received({ ecdh: priv, auth: Buffer.from(secret.auth, "base64url") }, m);
    assert.deepEqual(payload, pushPayload("test", "en"));
    // Chrome delivers it to the real service worker, which shows it.
    await b.browser.send("Target.setDiscoverTargets", { discover: true });
    const sw = await b.run(`navigator.serviceWorker.ready.then((r) => !!r.active)`);
    assert.equal(sw, true);
    const regs = await b.page.send("ServiceWorker.enable").then(async () => {
      for (let i = 0; i < 50; i++) {
        const found = b.page.events.filter((e) => e.method === "ServiceWorker.workerRegistrationUpdated").flatMap((e) => e.params.registrations);
        if (found.length) return found;
        await sleep(100);
      }
      return [];
    });
    const registrationId = regs.find((r) => r.scopeURL === origin + "/")?.registrationId;
    assert.ok(registrationId, "the app's worker is registered");
    await b.until(`navigator.serviceWorker.ready.then((r) => r.active && r.active.state === "activated")`);
    const notifications = `navigator.serviceWorker.ready.then((r) => r.getNotifications()).then((list) => list.length && list.map((n) => ({ title: n.title, body: n.body, tag: n.tag, url: n.data && n.data.url })))`;
    // Delivered as Chrome would; under heavy load it's offered again (the
    // tag keeps it to one notification).
    let shown;
    for (let i = 0; i < 6 && !shown; i++) {
      await b.page.send("ServiceWorker.deliverPushMessage", { origin: origin + "/", registrationId, data: JSON.stringify(payload) });
      shown = await b.until(notifications, 5000).catch(() => null);
    }
    assert.deepEqual(shown, [{ title: "ANONYMA", body: "Notifications from ANONYMA are working.", tag: "anonyma-test", url: "/account/settings#push-alerts" }]);
    // Stop in this browser: the server forgets it and the page unsubscribes.
    await b.run(`[...document.querySelectorAll("#push-alerts button")].find((x) => x.textContent.includes("Stop in this browser")).click(), true`);
    await b.until(`document.querySelector("#push-alerts")?.innerText.includes("Stopped.")`);
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM push_subscriptions").get().n, 0);
    assert.equal(await b.run(`navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((x) => x === null)`), true);
  },
);
