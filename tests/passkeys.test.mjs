import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign as cryptoSign,
} from "node:crypto";
import { Wallet } from "ethers";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import { hotp, stepAt, base32Decode } from "../server/two-step.js";
import {
  CHALLENGE_MS,
  MAX_FAILURES,
  cleanName,
  cleanResponse,
  counterRegressed,
  lastWayIn,
  passkeysAvailable,
} from "../server/passkeys.js";
import {
  defaultPasskeyName,
  nameInput,
  onlyWayIn,
  passkeyError,
  passkeysReleased,
} from "../src/passkeys.js";
import { paletteActions } from "../src/command-palette.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// WebAuthn needs a domain name: localhost is one (127.0.0.1 isn't).
const ORIGIN = "http://localhost:5175";
const RP_ID = "localhost";
const PASSWORD = "long-fixture-password";

function fixture(t, { released = "all", origin = ORIGIN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-passkeys-"));
  const s = createApp({
    testMode: true,
    released,
    origin,
    secret: "fixture-app-secret-".repeat(3),
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
  });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
const count = (s, sql, ...args) => s.db.prepare(sql).get(...args).n;
const ok = (r, status = 200) => {
  assert.equal(r.status, status, JSON.stringify(r.body));
  return r;
};
const cookieOf = (res) => (res.headers["set-cookie"] || []).join(";");
let visitor = 0;
// Each agent comes from its own address, so per-IP limits stay out of the way.
const agent = (s) => {
  const ip = `198.51.100.${(++visitor % 250) + 1}`;
  const a = request.agent(s.app);
  for (const m of ["get", "post", "patch", "delete"]) {
    const orig = a[m].bind(a);
    a[m] = (...args) => orig(...args).set("X-Forwarded-For", ip);
  }
  return a;
};

// ---- A software authenticator (ES256, "none" attestation) ----

// Just enough CBOR (RFC 8949) for attestation objects and COSE keys.
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) {
      const b = Buffer.alloc(3);
      b[0] = (major << 5) | 25;
      b.writeUInt16BE(n, 1);
      return b;
    }
    const b = Buffer.alloc(5);
    b[0] = (major << 5) | 26;
    b.writeUInt32BE(n, 1);
    return b;
  };
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "number")
    return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v);
    return Buffer.concat([head(3, b.length), b]);
  }
  if (v instanceof Map) {
    const parts = [head(5, v.size)];
    for (const [k, x] of v) parts.push(cbor(k), cbor(x));
    return Buffer.concat(parts);
  }
  throw Error("cbor: unsupported value");
}
const sha256 = (b) => createHash("sha256").update(b).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");
const FLAG = { UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40 };

// One authenticator holding discoverable passkeys, like a phone. Options
// tweak one ceremony: origin, rpId, flags, counter, type, userHandle.
function softAuthenticator() {
  const creds = [];
  function authData(rpId, flags, counter, attested) {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter >>> 0);
    return Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([flags]), c, attested || Buffer.alloc(0)]);
  }
  const clientData = (type, challenge, origin) =>
    Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  return {
    creds,
    create(options, o = {}) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const jwk = publicKey.export({ format: "jwk" });
      const cose = cbor(
        new Map([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x, "base64url")],
          [-3, Buffer.from(jwk.y, "base64url")],
        ]),
      );
      const id = randomBytes(16);
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(id.length);
      const attested = Buffer.concat([Buffer.alloc(16), idLen, id, cose]);
      const cred = {
        id: b64u(id),
        privateKey,
        userHandle: options.user.id,
        rpId: options.rp.id,
        counter: o.counter ?? 0,
        synced: o.synced ?? false,
      };
      const flags =
        o.flags ??
        FLAG.UP | FLAG.UV | FLAG.AT | (cred.synced ? FLAG.BE | FLAG.BS : 0);
      const attestationObject = cbor(
        new Map([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData(o.rpId ?? options.rp.id, flags, cred.counter, attested)],
        ]),
      );
      if (o.keep !== false) creds.push(cred);
      return {
        id: cred.id,
        rawId: cred.id,
        type: "public-key",
        response: {
          clientDataJSON: b64u(clientData(o.type ?? "webauthn.create", o.challenge ?? options.challenge, o.origin ?? ORIGIN)),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: { credProps: { rk: o.rk ?? true } },
        authenticatorAttachment: "platform",
      };
    },
    // Answers a get(): the credential picked (default: the newest allowed).
    get(options, o = {}) {
      const allowed = options.allowCredentials?.length
        ? creds.filter((c) => options.allowCredentials.some((a) => a.id === c.id))
        : creds.filter((c) => c.rpId === options.rpId);
      const cred = o.cred ?? allowed.at(-1);
      assert.ok(cred, "the authenticator has a passkey for this site");
      if (o.counter !== undefined) cred.counter = o.counter;
      else if (!cred.synced) cred.counter += 1;
      const flags = o.flags ?? FLAG.UP | FLAG.UV | (cred.synced ? FLAG.BE | FLAG.BS : 0);
      const ad = authData(o.rpId ?? options.rpId, flags, cred.synced && o.counter === undefined ? 0 : cred.counter);
      const cd = clientData(o.type ?? "webauthn.get", o.challenge ?? options.challenge, o.origin ?? ORIGIN);
      const signature = cryptoSign("sha256", Buffer.concat([ad, sha256(cd)]), o.key ?? cred.privateKey);
      return {
        id: cred.id,
        rawId: cred.id,
        type: "public-key",
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(ad),
          signature: b64u(signature),
          userHandle: o.userHandle !== undefined ? o.userHandle : cred.userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}

// A new account made with a passkey (no password, no email).
async function signUp(s, username = "alice", device = softAuthenticator(), o = {}) {
  const a = agent(s);
  const start = await a.post("/api/auth/passkey/signup/options").send({ username }).expect(200);
  const response = device.create(start.body.options, o);
  const done = await a
    .post("/api/auth/passkey/signup/verify")
    .send({ response, name: o.name ?? "iPhone" });
  return { a, device, start, done, response };
}
// Signs in with a passkey in a fresh browser; returns the agent and answer.
async function signIn(s, device, o = {}) {
  const a = o.agent ?? agent(s);
  const start = await a.post("/api/auth/passkey/options").send({}).expect(200);
  const response = device.get(start.body.options, o);
  const done = await a.post("/api/auth/passkey/verify").send({ response });
  return { a, start, done, response };
}
async function passwordAccount(s, username = "bob") {
  const a = agent(s);
  const r = await a.post("/api/auth/register").send({ username, password: PASSWORD }).expect(201);
  return { a, id: r.body.user.id };
}
const confirmPassword = (a) =>
  a.post("/api/account/two-step/reauth").send({ method: "password", password: PASSWORD });
async function confirmPasskey(a, device) {
  const start = await a.post("/api/account/passkeys/reauth/options").send({}).expect(200);
  return a.post("/api/account/passkeys/reauth").send({ response: device.get(start.body.options) });
}
async function addPasskey(a, device, name = "MacBook", o = {}) {
  const start = await a.post("/api/account/passkeys/options").send({}).expect(200);
  return a.post("/api/account/passkeys").send({ response: device.create(start.body.options, o), name });
}

// ---- Gating ----

test("the update is registered, unreleased, with three points", () => {
  const u = UPDATES.find((x) => x.id === "passkeys");
  assert.ok(u);
  assert.equal(committed[UPDATES.indexOf(u)], false, "ships unreleased");
  assert.equal(u.points.length, 3);
  assert.ok(u.title && u.tagline);
});

test("featuresFor gates every passkey route", () => {
  const gate = (method, path) => featuresFor({ method, path, body: {} });
  for (const p of [
    "/api/auth/passkey/options",
    "/api/auth/passkey/verify",
    "/api/auth/passkey/signup/options",
    "/api/auth/passkey/signup/verify",
    "/API/Auth/Passkey/Verify",
  ])
    assert.deepEqual(gate("POST", p), ["passkeys"], p);
  for (const [m, p] of [
    ["GET", "/api/account/passkeys"],
    ["POST", "/api/account/passkeys"],
    ["POST", "/api/account/passkeys/options"],
    ["POST", "/api/account/passkeys/reauth/options"],
    ["POST", "/api/account/passkeys/reauth"],
    ["PATCH", "/api/account/passkeys/pk_1"],
    ["DELETE", "/api/account/passkeys/pk_1"],
  ])
    assert.deepEqual(gate(m, p), ["passkeys", "twostep"], p);
});

test("before release every passkey route refuses, and nothing shows", async (t) => {
  const s = fixture(t, { released: "mvp" });
  const a = agent(s);
  for (const [m, p] of [
    ["post", "/api/auth/passkey/options"],
    ["post", "/api/auth/passkey/verify"],
    ["post", "/api/auth/passkey/signup/options"],
    ["post", "/api/auth/passkey/signup/verify"],
    ["get", "/api/account/passkeys"],
    ["post", "/api/account/passkeys"],
    ["post", "/api/account/passkeys/options"],
    ["post", "/api/account/passkeys/reauth/options"],
    ["post", "/api/account/passkeys/reauth"],
    ["patch", "/api/account/passkeys/x"],
    ["delete", "/api/account/passkeys/x"],
  ]) {
    const r = await a[m](p).send({ username: "carol" });
    assert.equal(r.status, 403, p);
    assert.equal(r.body.error.code, "feature_unreleased", p);
  }
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.passkeys, false);
  assert.equal(config.services.passkeys, false);
  assert.equal(passkeysReleased(config), false);
  assert.ok(!Object.keys(openapiForConfig(s.cfg).paths).some((p) => p.includes("passkey")));
  // The export doesn't mention passkeys until the update is live.
  const { a: bob } = await passwordAccount(s);
  const exp = await bob.get("/api/account/export").expect(200);
  assert.equal(exp.body.passkeys, undefined);
});

test("released: the config offers passkeys only on a domain browsers accept", async (t) => {
  const s = fixture(t);
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.services.passkeys, true);
  assert.equal(passkeysReleased(config), true);
  assert.ok(Object.keys(openapiForConfig(s.cfg).paths).includes("/api/auth/passkey/verify"));
  assert.equal(passkeysAvailable({ origin: "https://askanonyma.com" }), true);
  assert.equal(passkeysAvailable({ origin: "http://localhost:5175" }), true);
  assert.equal(passkeysAvailable({ origin: "http://127.0.0.1:5175" }), false);
  assert.equal(passkeysAvailable({ origin: "https://[::1]:5175" }), false);
  assert.equal(passkeysAvailable({ origin: "http://askanonyma.com" }), false);
  const ip = fixture(t, { origin: "http://127.0.0.1:5175" });
  const r = await request(ip.app).post("/api/auth/passkey/options").set("Origin", "http://127.0.0.1:5175").send({});
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "passkeys_unavailable");
  assert.equal((await request(ip.app).get("/api/config")).body.services.passkeys, false);
});

// ---- Sign-up and sign-in, end to end ----

test("create an account with a username and a passkey: no password, no email", async (t) => {
  const s = fixture(t);
  const { a, start, done } = await signUp(s, "alice");
  const o = start.body.options;
  assert.equal(o.rp.id, RP_ID);
  assert.equal(o.user.name, "alice");
  assert.equal(o.attestation, "none");
  assert.equal(o.authenticatorSelection.residentKey, "required");
  assert.equal(o.authenticatorSelection.userVerification, "required");
  assert.deepEqual(o.pubKeyCredParams.map((p) => p.alg), [-8, -7, -257]);
  // The user handle is random, never the username.
  assert.notEqual(Buffer.from(o.user.id, "base64url").toString(), "alice");
  assert.equal(Buffer.from(o.user.id, "base64url").length, 32);
  // The pending cookie: HttpOnly, SameSite=Strict, only for the passkey routes.
  const pending = cookieOf(start);
  assert.match(pending, /anonyma_passkey=/);
  assert.match(pending, /HttpOnly/);
  assert.match(pending, /SameSite=Strict/);
  assert.match(pending, /Path=\/api\/auth\/passkey/);
  assert.equal(done.status, 201, JSON.stringify(done.body));
  assert.match(cookieOf(done), /anonyma_session=/);
  assert.equal(done.body.user.username, "alice");
  const row = s.db.prepare("SELECT * FROM users WHERE username='alice'").get();
  assert.equal(row.password, null);
  assert.equal(row.email, null);
  assert.equal(row.wallet, null);
  const me = await a.get("/api/me").expect(200);
  assert.equal(me.body.user.username, "alice");
  const list = await a.get("/api/account/passkeys").expect(200);
  assert.equal(list.body.data.length, 1);
  assert.equal(list.body.data[0].name, "iPhone");
  assert.deepEqual(list.body.methods, { password: false, email: false, wallet: false, passkeys: 1 });
  assert.deepEqual(list.body.reauthMethods, ["passkey"]);
  // Never the credential id or public key.
  assert.deepEqual(Object.keys(list.body.data[0]).sort(), ["created", "id", "lastUsed", "name", "synced"]);
  // The ceremony is gone once answered.
  assert.equal(count(s, "SELECT COUNT(*) n FROM passkey_challenges WHERE purpose='signup'"), 0);
});

test("a taken username is refused before and after the ceremony", async (t) => {
  const s = fixture(t);
  await passwordAccount(s, "dora");
  const r = await agent(s).post("/api/auth/passkey/signup/options").send({ username: "DORA" });
  assert.equal(r.status, 409);
  const bad = await agent(s).post("/api/auth/passkey/signup/options").send({ username: "a b" });
  assert.equal(bad.status, 400);
  // Taken while the device was busy.
  const a = agent(s);
  const start = await a.post("/api/auth/passkey/signup/options").send({ username: "erin" }).expect(200);
  await passwordAccount(s, "erin");
  const done = await a
    .post("/api/auth/passkey/signup/verify")
    .send({ response: softAuthenticator().create(start.body.options) });
  assert.equal(done.status, 409);
  assert.equal(count(s, "SELECT COUNT(*) n FROM passkeys"), 0);
  assert.doesNotMatch(cookieOf(done), /anonyma_session=/);
});

test("sign in with a passkey, no username; the counter moves on", async (t) => {
  const s = fixture(t);
  const { device } = await signUp(s, "alice");
  const { start, done, a } = await signIn(s, device);
  assert.equal(start.body.options.rpId, RP_ID);
  assert.equal(start.body.options.userVerification, "required");
  assert.equal(start.body.options.allowCredentials, undefined, "usernameless");
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.user.username, "alice");
  assert.equal(done.body.passkey.name, "iPhone");
  assert.match(cookieOf(done), /anonyma_session=/);
  // The pending cookie is cleared.
  assert.match(cookieOf(done), /anonyma_passkey=;/);
  assert.equal((await a.get("/api/me")).body.user.username, "alice");
  const p = s.db.prepare("SELECT counter,last_used FROM passkeys").get();
  assert.equal(p.counter, 1);
  assert.ok(p.last_used);
  const again = await signIn(s, device);
  assert.equal(again.done.status, 200);
  assert.equal(s.db.prepare("SELECT counter FROM passkeys").get().counter, 2);
});

test("synced passkeys may keep a zero counter", async (t) => {
  const s = fixture(t);
  const { device, a } = await signUp(s, "alice", softAuthenticator(), { synced: true });
  assert.equal((await a.get("/api/account/passkeys")).body.data[0].synced, true);
  for (let i = 0; i < 2; i++) {
    const { done } = await signIn(s, device);
    assert.equal(done.status, 200, JSON.stringify(done.body));
  }
  assert.equal(s.db.prepare("SELECT counter FROM passkeys").get().counter, 0);
});

// ---- Refusals ----

async function refused(s, device, o, code, status = 401) {
  const sessions = count(s, "SELECT COUNT(*) n FROM sessions");
  const { done } = await signIn(s, device, o);
  assert.equal(done.status, status, JSON.stringify(done.body));
  assert.equal(done.body.error.code, code);
  assert.doesNotMatch(cookieOf(done), /anonyma_session=[^;]/);
  assert.equal(count(s, "SELECT COUNT(*) n FROM sessions"), sessions, "no session");
  return done;
}

test("a wrong origin is refused", async (t) => {
  const s = fixture(t);
  const { device } = await signUp(s);
  const done = await refused(s, device, { origin: "https://askanonyma.com.evil.example" }, "passkey_invalid");
  // The library's message (with the origin in it) never reaches the client.
  assert.doesNotMatch(done.body.error.message, /evil/);
});

test("a wrong RP ID is refused", async (t) => {
  const s = fixture(t);
  const { device } = await signUp(s);
  await refused(s, device, { rpId: "evil.example" }, "passkey_invalid");
});

test("a replayed answer is refused: each challenge works once", async (t) => {
  const s = fixture(t);
  const { device } = await signUp(s);
  const pendingOf = (res) => /anonyma_passkey=([^;]+)/.exec(cookieOf(res))[1];
  const { start, done, response } = await signIn(s, device);
  assert.equal(done.status, 200);
  // The same answer again, with the same pending cookie.
  const replay = await request(s.app)
    .post("/api/auth/passkey/verify")
    .set("Cookie", "anonyma_passkey=" + pendingOf(start))
    .send({ response });
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error.code, "passkey_expired");
  assert.doesNotMatch(cookieOf(replay), /anonyma_session=[^;]/);
  // A failed answer uses its challenge up too.
  const b = agent(s);
  const first = await b.post("/api/auth/passkey/options").send({});
  const wrong = device.get(first.body.options, { origin: "https://evil.example" });
  assert.equal((await b.post("/api/auth/passkey/verify").send({ response: wrong })).status, 401);
  const late = await request(s.app)
    .post("/api/auth/passkey/verify")
    .set("Cookie", "anonyma_passkey=" + pendingOf(first))
    .send({ response: device.get(first.body.options) });
  assert.equal(late.body.error.code, "passkey_expired");
});

test("a challenge expires after 5 minutes", async (t) => {
  const s = fixture(t);
  const { device } = await signUp(s);
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const a = agent(s);
  const start = await a.post("/api/auth/passkey/options").send({}).expect(200);
  t.mock.timers.setTime(Date.now() + CHALLENGE_MS + 1000);
  const r = await a.post("/api/auth/passkey/verify").send({ response: device.get(start.body.options) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "passkey_expired");
  assert.doesNotMatch(cookieOf(r), /anonyma_session=[^;]/);
});

test("an answer finishes only in the browser that started it", async (t) => {
  const s = fixture(t);
  const { device } = await signUp(s);
  const start = await agent(s).post("/api/auth/passkey/options").send({});
  // Another browser (no pending cookie, or its own) can't use that challenge.
  const other = agent(s);
  const r = await other.post("/api/auth/passkey/verify").send({ response: device.get(start.body.options) });
  assert.equal(r.body.error.code, "passkey_expired");
  await other.post("/api/auth/passkey/options").send({});
  const r2 = await other.post("/api/auth/passkey/verify").send({ response: device.get(start.body.options) });
  assert.equal(r2.body.error.code, "passkey_expired");
});

test("a counter that goes backwards is refused", async (t) => {
  const s = fixture(t);
  const { device } = await signUp(s);
  assert.equal((await signIn(s, device, { counter: 7 })).done.status, 200);
  await refused(s, device, { counter: 3 }, "passkey_counter");
  await refused(s, device, { counter: 7 }, "passkey_counter");
  assert.equal(s.db.prepare("SELECT counter FROM passkeys").get().counter, 7);
  assert.equal((await signIn(s, device, { counter: 8 })).done.status, 200);
});

test("no user verification, a wrong user handle, a bad signature or an unknown passkey are refused", async (t) => {
  const s = fixture(t);
  const { device } = await signUp(s);
  await refused(s, device, { flags: FLAG.UP }, "passkey_invalid");
  await refused(s, device, { userHandle: b64u(randomBytes(32)) }, "passkey_invalid");
  await refused(s, device, { userHandle: null }, "passkey_invalid");
  await refused(s, device, { key: generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey }, "passkey_invalid");
  await refused(s, device, { type: "webauthn.create" }, "passkey_invalid");
  const stranger = softAuthenticator();
  stranger.create({ rp: { id: RP_ID }, user: { id: b64u(randomBytes(32)) }, challenge: "x" });
  await refused(s, stranger, {}, "passkey_unknown");
  // Malformed answers never reach the library.
  const a = agent(s);
  await a.post("/api/auth/passkey/options").send({});
  for (const response of [null, "x", { id: "a", rawId: "b", type: "public-key", response: {} }, { id: "a b", rawId: "a b", type: "public-key", response: { clientDataJSON: "e30" } }]) {
    const r = await a.post("/api/auth/passkey/verify").send({ response });
    assert.equal(r.status, 400);
    assert.equal(r.body.error.code, "passkey_invalid_response");
  }
});

test("registration refuses a wrong origin, a wrong RP ID, no user verification and a non-discoverable key", async (t) => {
  const s = fixture(t);
  for (const [o, code] of [
    [{ origin: "https://evil.example" }, "passkey_invalid"],
    [{ rpId: "evil.example" }, "passkey_invalid"],
    [{ flags: FLAG.UP | FLAG.AT }, "passkey_invalid"],
    [{ type: "webauthn.get" }, "passkey_invalid"],
    [{ rk: false }, "passkey_not_discoverable"],
  ]) {
    const { done } = await signUp(s, "frank", softAuthenticator(), o);
    assert.equal(done.body.error?.code, code, JSON.stringify(o));
    assert.doesNotMatch(cookieOf(done), /anonyma_session=[^;]/);
  }
  assert.equal(count(s, "SELECT COUNT(*) n FROM users WHERE username='frank'"), 0);
  assert.equal(count(s, "SELECT COUNT(*) n FROM passkeys"), 0);
});

test("five failed answers lock that passkey for 15 minutes", async (t) => {
  const s = fixture(t);
  const { device } = await signUp(s);
  const wrongKey = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
  for (let i = 0; i < MAX_FAILURES; i++)
    await refused(s, device, { key: wrongKey }, "passkey_invalid");
  const locked = await refused(s, device, {}, "passkey_locked", 429);
  assert.match(locked.headers["retry-after"], /^\d+$/);
});

test("the sign-in routes are rate limited per address", async (t) => {
  const s = fixture(t);
  let last;
  for (let i = 0; i < 31; i++)
    last = await request(s.app).post("/api/auth/passkey/options").set("X-Forwarded-For", "203.0.113.9").send({});
  assert.equal(last.status, 429);
});

// ---- Two-Step Sign-in ----

test("a passkey sign-in skips the two-step code; the password still asks for it", async (t) => {
  const s = fixture(t);
  const { a } = await passwordAccount(s, "gwen");
  await confirmPassword(a).expect(200);
  const setup = await a.post("/api/account/two-step/setup").send({}).expect(200);
  await a
    .post("/api/account/two-step/enable")
    .send({ code: hotp(base32Decode(setup.body.secret), stepAt(Date.now())) })
    .expect(200);
  const device = softAuthenticator();
  const added = await addPasskey(a, device, "iPhone");
  assert.equal(added.status, 201, JSON.stringify(added.body));
  const pw = await request(s.app).post("/api/auth/password").send({ username: "gwen", password: PASSWORD }).expect(200);
  assert.ok(pw.body.twoStep?.token, "the password waits for a code");
  assert.doesNotMatch(cookieOf(pw), /anonyma_session=/);
  const { done } = await signIn(s, device);
  assert.equal(done.status, 200);
  assert.equal(done.body.twoStep, undefined);
  assert.match(cookieOf(done), /anonyma_session=/);
  assert.equal(count(s, "SELECT COUNT(*) n FROM two_step_pending WHERE user_id=?", done.body.user.id), 1, "only the password's");
});

// ---- Account → Security ----

test("adding a passkey needs a fresh confirmation from this session", async (t) => {
  const s = fixture(t);
  const { a, id } = await passwordAccount(s, "hana");
  const r = await a.post("/api/account/passkeys/options").send({});
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, "passkey_reauth_required");
  await confirmPassword(a).expect(200);
  const device = softAuthenticator();
  const added = await addPasskey(a, device, "  My   iPhone ");
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.data[0].name, "My iPhone");
  // The options name the account by its username and exclude its passkeys.
  const again = await a.post("/api/account/passkeys/options").send({}).expect(200);
  assert.equal(again.body.options.user.name, "hana");
  assert.deepEqual(again.body.options.excludeCredentials.map((c) => c.id), [device.creds[0].id]);
  // Every passkey of one account shares its handle.
  const second = await a.post("/api/account/passkeys").send({ response: softAuthenticator().create(again.body.options), name: "YubiKey" });
  assert.equal(second.status, 201);
  assert.equal(count(s, "SELECT COUNT(DISTINCT user_handle) n FROM passkeys WHERE user_id=?", id), 1);
  // Another session of the same account isn't confirmed.
  const other = agent(s);
  await other.post("/api/auth/password").send({ username: "hana", password: PASSWORD }).expect(200);
  assert.equal((await other.post("/api/account/passkeys/options").send({})).status, 403);
  // The confirmation lapses after 10 minutes.
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() + 11 * 60000 });
  assert.equal((await a.post("/api/account/passkeys/options").send({})).status, 403);
});

test("an email-only or wallet-only account's passkey is labelled without its email or wallet", async (t) => {
  const s = fixture(t);
  const a = agent(s);
  const sent = await a.post("/api/auth/email/send").send({ email: "ivy@example.com" }).expect(200);
  await a.post("/api/auth/email/verify").send({ id: sent.body.id, code: sent.body.testCode }).expect(200);
  const start = await a.post("/api/account/two-step/reauth/start").send({ method: "email" }).expect(200);
  await a.post("/api/account/two-step/reauth").send({ method: "email", id: start.body.id, code: start.body.testCode }).expect(200);
  const o = (await a.post("/api/account/passkeys/options").send({}).expect(200)).body.options;
  assert.equal(o.user.name, "ANONYMA account");
  assert.doesNotMatch(JSON.stringify(o), /ivy|example\.com/);
});

test("confirm it's you with a passkey; only this account's passkeys are offered", async (t) => {
  const s = fixture(t);
  const { a, device } = await signUp(s, "jade");
  const b = await signUp(s, "kim");
  const start = await a.post("/api/account/passkeys/reauth/options").send({}).expect(200);
  assert.deepEqual(start.body.options.allowCredentials.map((c) => c.id), [device.creds[0].id]);
  // Kim's passkey can't confirm Jade's session.
  const wrong = b.device.get({ ...start.body.options, allowCredentials: [] }, { cred: b.device.creds[0] });
  const r = await a.post("/api/account/passkeys/reauth").send({ response: wrong });
  assert.equal(r.body.error.code, "passkey_unknown");
  const ok = await confirmPasskey(a, device);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.reauthUntil > Date.now());
  assert.ok((await a.get("/api/account/passkeys")).body.reauthUntil);
  const added = await addPasskey(a, softAuthenticator(), "Laptop");
  assert.equal(added.status, 201);
});

test("rename a passkey; names are checked", async (t) => {
  const s = fixture(t);
  const { a } = await signUp(s, "lena");
  const [p] = (await a.get("/api/account/passkeys")).body.data;
  const r = await a.patch(`/api/account/passkeys/${p.id}`).send({ name: " Work​ phone " }).expect(200);
  assert.equal(r.body.data[0].name, "Work phone");
  for (const name of ["", "   ", "x".repeat(41), 5, null])
    assert.equal((await a.patch(`/api/account/passkeys/${p.id}`).send({ name })).status, 400);
  // Someone else's passkey is not found.
  const other = await signUp(s, "mona");
  assert.equal((await other.a.patch(`/api/account/passkeys/${p.id}`).send({ name: "Mine" })).status, 404);
  assert.equal((await other.a.delete(`/api/account/passkeys/${p.id}`)).status, 404);
});

test("removing the last way to sign in is refused", async (t) => {
  const s = fixture(t);
  const { a, device } = await signUp(s, "nora");
  const [only] = (await a.get("/api/account/passkeys")).body.data;
  // Needs a confirmation first.
  assert.equal((await a.delete(`/api/account/passkeys/${only.id}`)).body.error.code, "passkey_reauth_required");
  ok(await confirmPasskey(a, device));
  const r = await a.delete(`/api/account/passkeys/${only.id}`);
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "passkey_last_method");
  // With a second passkey, one can go; then the other is the last again.
  const second = softAuthenticator();
  assert.equal((await addPasskey(a, second, "YubiKey")).status, 201);
  const gone = await a.delete(`/api/account/passkeys/${only.id}`).expect(200);
  assert.equal(gone.body.data.length, 1);
  assert.equal((await signIn(s, device)).done.body.error.code, "passkey_unknown");
  const [left] = gone.body.data;
  assert.equal((await a.delete(`/api/account/passkeys/${left.id}`)).body.error.code, "passkey_last_method");
  // A password account can remove all of its passkeys.
  const { a: pw } = await passwordAccount(s, "owen");
  await confirmPassword(pw).expect(200);
  ok(await addPasskey(pw, softAuthenticator()), 201);
  const [mine] = (await pw.get("/api/account/passkeys")).body.data;
  await pw.delete(`/api/account/passkeys/${mine.id}`).expect(200);
  assert.equal(lastWayIn({ password: false, email: false, wallet: false, passkeys: 1 }), true);
  assert.equal(lastWayIn({ password: false, email: true, wallet: false, passkeys: 1 }), false);
  assert.equal(onlyWayIn({ password: false, email: false, wallet: false, passkeys: 1 }), true);
  assert.equal(onlyWayIn({ password: false, email: false, wallet: false, passkeys: 2 }), false);
});

test("a wallet can be unlinked when a passkey still signs in", async (t) => {
  const s = fixture(t);
  const wallet = Wallet.createRandom();
  const a = agent(s);
  const ch = await a.post("/api/auth/wallet/challenge").send({ address: wallet.address }).expect(200);
  await a.post("/api/auth/wallet/verify").send({ id: ch.body.id, signature: await wallet.signMessage(ch.body.message) }).expect(200);
  // Wallet only: unlinking would lock the account out.
  assert.equal((await a.post("/api/account/wallet/unlink").send({})).body.error.code, "wallet_sign_in_only");
  const re = await a.post("/api/account/two-step/reauth/start").send({ method: "wallet" }).expect(200);
  await a.post("/api/account/two-step/reauth").send({ method: "wallet", id: re.body.id, signature: await wallet.signMessage(re.body.message) }).expect(200);
  ok(await addPasskey(a, softAuthenticator(), "Phone"), 201);
  await a.post("/api/account/wallet/unlink").send({}).expect(200);
  const status = (await a.get("/api/account/passkeys")).body;
  assert.deepEqual(status.methods, { password: false, email: false, wallet: false, passkeys: 1 });
});

test("up to 10 passkeys per account", async (t) => {
  const s = fixture(t);
  const { a, device } = await signUp(s, "pia");
  ok(await confirmPasskey(a, device));
  for (let i = 0; i < 9; i++) ok(await addPasskey(a, softAuthenticator(), "Key " + i), 201);
  const r = await a.post("/api/account/passkeys/options").send({});
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "passkey_limit");
});

// ---- Account lifecycle ----

test("the export lists names and dates only", async (t) => {
  const s = fixture(t);
  const { a, device, response } = await signUp(s, "quinn");
  await signIn(s, device);
  const exp = await a.get("/api/account/export").expect(200);
  assert.equal(exp.body.passkeys.length, 1);
  assert.deepEqual(Object.keys(exp.body.passkeys[0]).sort(), ["created", "lastUsed", "name", "synced"]);
  assert.equal(exp.body.passkeys[0].name, "iPhone");
  const text = JSON.stringify(exp.body);
  assert.ok(!text.includes(response.id), "no credential id");
  const pk = s.db.prepare("SELECT public_key,user_handle FROM passkeys").get();
  assert.ok(!text.includes(Buffer.from(pk.public_key).toString("base64url")));
  assert.ok(!text.includes(Buffer.from(pk.public_key).toString("base64")));
  assert.ok(!text.includes(pk.user_handle), "no user handle");
});

test("Panic Wipe keeps passkeys (you can still sign in) and erases ceremonies and confirmations", async (t) => {
  const s = fixture(t);
  const { a, device } = await signUp(s, "rae");
  const user = s.db.prepare("SELECT id FROM users WHERE username='rae'").get().id;
  ok(await confirmPasskey(a, device));
  await a.post("/api/account/passkeys/options").send({}).expect(200);
  assert.equal(count(s, "SELECT COUNT(*) n FROM passkey_challenges WHERE user_id=?", user), 1);
  await a.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(count(s, "SELECT COUNT(*) n FROM passkey_challenges WHERE user_id=?", user), 0);
  assert.equal(count(s, "SELECT COUNT(*) n FROM passkey_reauth WHERE user_id=?", user), 0);
  assert.equal(count(s, "SELECT COUNT(*) n FROM sessions WHERE user_id=?", user), 0);
  assert.equal(count(s, "SELECT COUNT(*) n FROM passkeys WHERE user_id=?", user), 1);
  const { done } = await signIn(s, device);
  assert.equal(done.status, 200);
  assert.equal(done.body.user.username, "rae");
});

test("closing the account deletes its passkeys; they can't sign in again", async (t) => {
  const s = fixture(t);
  const { a, device } = await signUp(s, "sol");
  const user = s.db.prepare("SELECT id FROM users WHERE username='sol'").get().id;
  ok(await confirmPasskey(a, device));
  await a.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  for (const table of ["passkeys", "passkey_challenges", "passkey_reauth"])
    assert.equal(count(s, `SELECT COUNT(*) n FROM ${table} WHERE user_id=?`, user), 0, table);
  assert.equal((await signIn(s, device)).done.body.error.code, "passkey_unknown");
  // The username is free again.
  assert.equal((await signUp(s, "sol")).done.status, 201);
});

test("nothing about a ceremony reaches the server log", async (t) => {
  const s = fixture(t);
  const lines = [];
  const orig = [console.log, console.error, console.warn, console.info];
  console.log = console.error = console.warn = console.info = (...x) => lines.push(x.join(" "));
  try {
    const { device, response } = await signUp(s, "tess");
    await signIn(s, device);
    await signIn(s, device, { origin: "https://evil.example" });
    await signIn(s, device, { counter: 0 });
    assert.ok(!lines.join("\n").includes(response.id));
    assert.ok(!lines.join("\n").includes("tess"));
  } finally {
    [console.log, console.error, console.warn, console.info] = orig;
  }
});

// ---- Pure helpers ----

test("names, responses and counters", () => {
  assert.equal(cleanName("  iPhone\n15  "), "iPhone 15");
  assert.equal(cleanName("a‮b"), "ab");
  assert.equal(cleanName("é".repeat(40)), "é".repeat(40));
  assert.equal(cleanName("é".repeat(41)), null);
  assert.equal(cleanName(""), null);
  assert.equal(nameInput("x".repeat(60)).length, 40);
  assert.equal(nameInput("a\nb"), "ab");
  assert.equal(counterRegressed(0, 0), false);
  assert.equal(counterRegressed(0, 1), false);
  assert.equal(counterRegressed(5, 5), true);
  assert.equal(counterRegressed(5, 4), true);
  assert.equal(counterRegressed(5, 0), true);
  assert.equal(cleanResponse({ id: "YQ", rawId: "YQ", type: "public-key", response: { clientDataJSON: "e30" } }, "get"), null);
  assert.equal(cleanResponse({ id: "YQ", rawId: "YQ", type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" } }, "get")?.id, "YQ");
  assert.equal(cleanResponse({ id: "YQ", rawId: "YQ", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "AA", transports: ["x".repeat(30)] } }, "create"), null);
  assert.equal(defaultPasskeyName({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X)" }), "iPhone");
  assert.equal(defaultPasskeyName({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", platform: "MacIntel" }), "Mac");
  assert.equal(defaultPasskeyName({ userAgent: "Mozilla/5.0 (Linux; Android 16)" }), "Android");
  assert.equal(defaultPasskeyName({}), "Passkey");
  assert.equal(passkeyError({ name: "NotAllowedError" }), "The passkey prompt was closed or timed out. Nothing changed.");
  assert.equal(passkeyError({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" }), "This device already has a passkey for this account.");
  assert.equal(passkeyError({ status: 401, message: "That passkey couldn’t be verified. Try again." }), "That passkey couldn’t be verified. Try again.");
});

test("the command palette finds Security by passkey words once released", () => {
  const cfg = (...ids) => ({ releases: { features: Object.fromEntries(["palette", "twostep", ...ids].map((id) => [id, true])) } });
  const security = (config) =>
    paletteActions({ config, page: "workspace", signedIn: true }).find((a) => a.id === "security");
  assert.ok(!security(cfg()).keywords.includes("passkey"));
  assert.ok(security(cfg("passkeys")).keywords.includes("passkey"));
});

// ---- Chinese ----

const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
const han = /\p{Script=Han}/u;

test("the Chinese dictionary covers the update, the sign-in tab, Security and the server's messages", () => {
  const entry = UPDATES.find((u) => u.id === "passkeys");
  const d = new Date(2026, 8, 26).toLocaleDateString("en-US");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Passkeys is coming soon.",
    "Passkey",
    "Start with a username and a passkey.",
    "Pick a username. Your device’s Face ID, fingerprint or PIN is your sign-in: no password, no email.",
    "Use Face ID, your fingerprint or your device’s PIN. No username or password to type.",
    "Create an account with a passkey",
    "Sign in with a passkey",
    "Waiting for your device…",
    "Your passkey is saved on this device or in your passkey manager. Keep it: without a password or email, it’s how you get back in.",
    "Your face or fingerprint never leaves your device. ANONYMA only checks a signature.",
    "This browser can’t use passkeys. Try a current browser, or your phone.",
    "Passkeys.",
    "Sign in with Face ID, your fingerprint or your device’s PIN. Your device keeps the private key and ANONYMA stores only the public one, so there’s no password to leak and no email needed.",
    "A passkey sign-in counts as both steps of two-step sign-in: your device already checked it’s you, so ANONYMA doesn’t ask for an authenticator code.",
    "Adding or removing one asks you to confirm it’s you first. Your data export lists each passkey’s name and dates, never its keys.",
    "No passkeys yet. Add one and sign in with Face ID, your fingerprint or your device’s PIN.",
    "This passkey is your only way to sign in, so it can’t be removed. Add another passkey, link an email or link a wallet first.",
    "Sign in to a real account to add a passkey.",
    "Passkeys need this site on a domain name over HTTPS.",
    "Name this passkey",
    "Passkey name",
    "Add a passkey",
    `Added ${d} · Last used ${d}`,
    `Added ${d} · Not used yet`,
    "Synced",
    "This device only",
    "Rename",
    "Remove",
    "Remove passkey",
    "Save",
    "Cancel",
    "You won’t be able to sign in with this passkey. It stays saved on the device until you delete it there too.",
    "3 of 10 passkeys",
    "1 of 10 passkeys",
    "You have 10 of 10 passkeys. Remove one to add another.",
    "Passkey added. Next time, sign in with it: no password needed.",
    "Passkey removed.",
    "Confirmed. Now add your passkey.",
    "Adding or removing a passkey needs a fresh confirmation from this session.",
    "Use a passkey",
    "This account signs in only with passkeys, which already check it’s you twice. Two-step sign-in applies once you link an email or a wallet.",
    "The passkey prompt was closed or timed out. Nothing changed.",
    "This device already has a passkey for this account.",
    "This authenticator can’t check it’s you or store a passkey. Try your phone or computer’s built-in passkeys.",
    "Your browser couldn’t use a passkey here. Try again, or sign in another way.",
    "That passkey couldn’t be verified. Try again.",
    "This passkey request expired or was already used. Try again.",
    "This passkey isn’t registered with ANONYMA. It may have been removed.",
    "This passkey’s use count went backwards, which can mean it was copied. Sign in another way, then remove it and add it again.",
    "This passkey is locked after too many failed tries. Try again in 12 minutes.",
    "This passkey is locked after too many failed tries. Try again in 1 minute.",
    "That passkey response wasn’t readable. Try again.",
    "This authenticator couldn’t save a passkey that signs in on its own. Try your phone or computer’s built-in passkeys.",
    "This passkey is already added.",
    "You can add up to 10 passkeys. Remove one to add another.",
    "Name your passkey in 1 to 40 characters.",
    "Passkey not found.",
    "This passkey is your only way to sign in. Add another passkey, link an email or link a wallet first.",
    "Confirm it’s you first. Adding or removing a passkey needs your password, a passkey (or a fresh email code or wallet signature) from the last 10 minutes.",
    "This account has no passkeys yet.",
    "Passkeys need this service on a domain name over HTTPS.",
    "Your passkeys, so you can still sign in",
    "Passkeys: each passkey’s public key, credential id, sign counter, name, dates and whether it’s synced, plus a random account handle the passkey stores instead of your username, email or wallet. Your face, fingerprint and PIN never leave your device. A sign-in or setup waiting for your device lasts 5 minutes. Your export lists each passkey’s name and dates, not its keys. Removing a passkey or closing your account deletes it; Panic Wipe keeps your passkeys so you can still sign in.",
    "The export also lists your passkeys: each one’s name, when it was added and last used, and whether it’s synced. Public keys and credential ids are left out: only ANONYMA’s sign-in check uses them.",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
  // Glossary: passkey is 通行密钥 throughout.
  assert.match(translateText("Sign in with a passkey", zh), /通行密钥/);
  // The dates line is one string, translated as a whole.
  assert.equal(translateText(`Added ${d} · Not used yet`, zh), "添加于 2026/9/26 · 尚未使用");
  assert.equal(translateText(`Added ${d} · Last used ${d}`, zh), "添加于 2026/9/26 · 上次使用 2026/9/26");
});

// Passkeys.jsx compiled for Node with the same esbuild Vite uses; shared UI
// is swapped for plain stand-ins so only its own text renders.
async function pageModule() {
  const src = new URL("../src/Passkeys.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-passkeys-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Notice = ({ children }) => React.createElement("div", null, children);
     export const Button = ({ children }) => React.createElement("button", null, children);
     export const Icon = () => React.createElement("svg");`,
  );
  const twoStep = stub("two-step.mjs", `export const ConfirmItsYou = () => null;`);
  const out = code
    .replace(/^import "\.\/passkeys\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/TwoStep\.jsx"/g, `from "${twoStep}"`)
    .replace(/from "\.\/(lib|passkeys)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "Passkeys.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Text split by whether it sits inside data-i18n="off" (the person's own
// words) or not (the page's, to be translated).
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr"]);
  const stack = [],
    page = [],
    kept = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g))
        (off || stack.some((x) => x.off) ? kept : page).push(entities(attr));
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>")) stack.push({ off });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    }
  }
  const words = (list) => list.filter((x) => /[A-Za-z]{2}/.test(x));
  return { page: words(page), kept: words(kept) };
}

test("the passkey list keeps names untranslated and translates the rest", async () => {
  const { PasskeySettings, PasskeyAuth } = await pageModule();
  const settings = renderToStaticMarkup(createElement(PasskeySettings, { demo: true, config: {} }));
  const { page, kept } = textsOf(settings);
  assert.ok(kept.includes("iPhone") && kept.includes("YubiKey"), "passkey names are the person's words");
  assert.ok(page.some((t) => t.startsWith("Added ")));
  assert.ok(page.includes("e.g. iPhone"), "the placeholder is translated");
  for (const t of page) assert.match(translateText(t, zh) ?? "", han, t);
  for (const register of [false, true]) {
    const html = renderToStaticMarkup(createElement(PasskeyAuth, { register, connected: true, onSignedIn() {} }));
    const texts = textsOf(html);
    assert.ok(texts.page.includes(register ? "Create an account with a passkey" : "Sign in with a passkey"));
    for (const t of texts.page) assert.match(translateText(t, zh) ?? "", han, t);
    // Inputs hold the person's text as values, which are never translated;
    // their placeholders are.
    if (register) assert.ok(texts.page.includes("Your username"));
  }
});
