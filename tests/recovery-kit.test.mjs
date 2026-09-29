import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createHash, generateKeyPairSync, randomBytes, sign as cryptoSign } from "node:crypto";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import { hotp, stepAt, base32Decode } from "../server/two-step.js";
import { kitDigest, matchDigest, nudgeDue, USERNAME_TRIES, ADDRESS_TRIES, PENDING_MS } from "../server/recovery-kit.js";
import {
  KIT_ALPHABET,
  KIT_SIZE,
  kitCheckSymbol,
  kitCodeFromBytes,
  kitCodeInput,
  kitText,
  looksLikeTwoStepCode,
  readKitCode,
  recoveryKitReleased,
} from "../src/recovery-kit.js";
import { paletteActions } from "../src/command-palette.js";
import { compileDictionary, translateText, translateDate } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// WebAuthn needs a domain name: localhost is one (127.0.0.1 isn't).
const ORIGIN = "http://localhost:5175";
const PASSWORD = "long-fixture-password";
const NEW_PASSWORD = "a-brand-new-password";
const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
const han = /\p{Script=Han}/u;

function fixture(t, { released = "all", origin = ORIGIN } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-recovery-kit-"));
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
  s.dir = dir;
  return s;
}
const count = (s, sql, ...args) => s.db.prepare(sql).get(...args).n;
const cookieOf = (res) => (res.headers["set-cookie"] || []).join(";");
let visitor = 0;
// Each agent comes from its own address, so per-IP limits stay out of the
// way unless a test picks the address.
const agent = (s, ip = `198.51.100.${(++visitor % 250) + 1}`) => {
  const a = request.agent(s.app);
  for (const m of ["get", "post", "patch", "delete"]) {
    const orig = a[m].bind(a);
    a[m] = (...args) => orig(...args).set("X-Forwarded-For", ip);
  }
  a.ip = ip;
  return a;
};
async function passwordAccount(s, username = "bob") {
  const a = agent(s);
  const r = await a.post("/api/auth/register").send({ username, password: PASSWORD }).expect(201);
  return { a, id: r.body.user.id };
}
const confirmPassword = (a, password = PASSWORD) =>
  a.post("/api/account/two-step/reauth").send({ method: "password", password });
async function makeKit(a, body = {}) {
  await confirmPassword(a).expect(200);
  const r = await a.post("/api/account/recovery-kit").send(body);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.codes;
}
const redeem = (s, username, code, ip) =>
  agent(s, ip).post("/api/auth/recovery-kit/redeem").send({ username, code });
async function signedInAs(a) {
  return (await a.get("/api/me").expect(200)).body.user;
}

// ---- A software authenticator (ES256, "none" attestation) ----
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    const b = Buffer.alloc(3);
    b[0] = (major << 5) | 25;
    b.writeUInt16BE(n, 1);
    return b;
  };
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === "number") return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === "string") {
    const b = Buffer.from(v);
    return Buffer.concat([head(3, b.length), b]);
  }
  const parts = [head(5, v.size)];
  for (const [k, x] of v) parts.push(cbor(k), cbor(x));
  return Buffer.concat(parts);
}
const sha256 = (b) => createHash("sha256").update(b).digest();
const b64u = (b) => Buffer.from(b).toString("base64url");
function softAuthenticator() {
  const creds = [];
  const authData = (rpId, flags, counter, attested) => {
    const c = Buffer.alloc(4);
    c.writeUInt32BE(counter >>> 0);
    return Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([flags]), c, attested || Buffer.alloc(0)]);
  };
  const clientData = (type, challenge) =>
    Buffer.from(JSON.stringify({ type, challenge, origin: ORIGIN, crossOrigin: false }));
  return {
    creds,
    create(options) {
      const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const jwk = publicKey.export({ format: "jwk" });
      const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, "base64url")], [-3, Buffer.from(jwk.y, "base64url")]]));
      const id = randomBytes(16);
      const idLen = Buffer.alloc(2);
      idLen.writeUInt16BE(id.length);
      const attested = Buffer.concat([Buffer.alloc(16), idLen, id, cose]);
      const cred = { id: b64u(id), privateKey, userHandle: options.user.id, rpId: options.rp.id, counter: 0 };
      creds.push(cred);
      const attestationObject = cbor(new Map([["fmt", "none"], ["attStmt", new Map()], ["authData", authData(options.rp.id, 0x01 | 0x04 | 0x40, 0, attested)]]));
      return {
        id: cred.id,
        rawId: cred.id,
        type: "public-key",
        response: {
          clientDataJSON: b64u(clientData("webauthn.create", options.challenge)),
          attestationObject: b64u(attestationObject),
          transports: ["internal"],
        },
        clientExtensionResults: { credProps: { rk: true } },
        authenticatorAttachment: "platform",
      };
    },
    get(options, o = {}) {
      const allowed = options.allowCredentials?.length
        ? creds.filter((c) => options.allowCredentials.some((a) => a.id === c.id))
        : creds.filter((c) => c.rpId === options.rpId);
      const cred = o.cred ?? allowed.at(-1);
      cred.counter += 1;
      const ad = authData(options.rpId, 0x01 | 0x04, cred.counter);
      const cd = clientData("webauthn.get", options.challenge);
      return {
        id: cred.id,
        rawId: cred.id,
        type: "public-key",
        response: {
          clientDataJSON: b64u(cd),
          authenticatorData: b64u(ad),
          signature: b64u(cryptoSign("sha256", Buffer.concat([ad, sha256(cd)]), cred.privateKey)),
          userHandle: cred.userHandle,
        },
        clientExtensionResults: {},
        authenticatorAttachment: "platform",
      };
    },
  };
}
async function passkeyAccount(s, username) {
  const a = agent(s);
  const device = softAuthenticator();
  const start = await a.post("/api/auth/passkey/signup/options").send({ username }).expect(200);
  const done = await a.post("/api/auth/passkey/signup/verify").send({ response: device.create(start.body.options), name: "iPhone" });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  return { a, device, id: done.body.user.id };
}
async function passkeySignIn(s, device) {
  const a = agent(s);
  const start = await a.post("/api/auth/passkey/options").send({}).expect(200);
  return a.post("/api/auth/passkey/verify").send({ response: device.get(start.body.options) });
}

// ---- Registration and gating ----

test("the update is registered, unreleased, with three points, an icon and Chinese copy", () => {
  const i = UPDATES.findIndex((u) => u.id === "recovery");
  assert.ok(i >= 0);
  const u = UPDATES[i];
  assert.equal(typeof committed[i], "boolean");
  assert.equal(u.points.length, 3);
  for (const text of [u.title, u.tagline, ...u.points]) assert.match(translateText(text, zh) ?? "", han, text);
  assert.match(readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8"), /recovery: "lifebuoy"/);
  assert.ok(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8").includes("src/recovery-kit.js"), "the server imports it");
});

test("featuresFor gates every Recovery Kit route", () => {
  const gate = (method, path) => featuresFor({ method, path, body: {} });
  for (const p of ["/api/auth/recovery-kit/redeem", "/api/auth/recovery-kit/password", "/API/Auth/Recovery-Kit/Redeem"])
    assert.deepEqual(gate("POST", p), ["recovery"], p);
  for (const p of ["/api/auth/recovery-kit/passkey/options", "/api/auth/recovery-kit/passkey"])
    assert.deepEqual(gate("POST", p), ["recovery", "passkeys"], p);
  for (const [m, p] of [
    ["GET", "/api/account/recovery-kit"],
    ["POST", "/api/account/recovery-kit"],
    ["DELETE", "/api/account/recovery-kit"],
    ["DELETE", "/api/account/recovery-kit/nudge"],
  ])
    assert.deepEqual(gate(m, p), ["recovery", "twostep"], p);
});

test("before release every route refuses, and nothing shows", async (t) => {
  const s = fixture(t, { released: "twostep,passkeys" });
  const { a } = await passwordAccount(s, "early");
  for (const [m, p] of [
    ["get", "/api/account/recovery-kit"],
    ["post", "/api/account/recovery-kit"],
    ["delete", "/api/account/recovery-kit"],
    ["delete", "/api/account/recovery-kit/nudge"],
    ["post", "/api/auth/recovery-kit/redeem"],
    ["post", "/api/auth/recovery-kit/password"],
    ["post", "/api/auth/recovery-kit/passkey/options"],
    ["post", "/api/auth/recovery-kit/passkey"],
  ]) {
    const r = await a[m](p).send({ username: "early", code: "x" });
    assert.equal(r.status, 403, p);
    assert.equal(r.body.error.code, "feature_unreleased", p);
  }
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.recovery, false);
  assert.equal(recoveryKitReleased(config), false);
  assert.ok(!Object.keys(openapiForConfig(s.cfg).paths).some((p) => p.includes("recovery-kit")));
  const exp = await a.get("/api/account/export").expect(200);
  assert.equal(exp.body.recoveryKit, undefined);
  assert.equal(paletteActions({ config, user: { id: "u" } }).find((x) => x.id === "security")?.keywords?.includes("recovery kit") ?? false, false);
  // Released: listed, and the settings need Two-Step's confirmation too.
  const on = fixture(t);
  const onConfig = (await request(on.app).get("/api/config").expect(200)).body;
  assert.equal(recoveryKitReleased(onConfig), true);
  assert.equal(recoveryKitReleased({ releases: { features: { recovery: true, twostep: false } } }), false);
  const paths = Object.keys(openapiForConfig(on.cfg).paths);
  for (const p of ["/api/account/recovery-kit", "/api/auth/recovery-kit/redeem", "/api/auth/recovery-kit/passkey"])
    assert.ok(paths.includes(p), p);
});

// ---- The code format ----

test("codes: 95 random bits, readable groups, a check symbol that catches typos", () => {
  const code = kitCodeFromBytes(randomBytes(19));
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){4}$/);
  const read = readKitCode(code);
  assert.equal(read.typo, false);
  assert.equal(read.code, code);
  // Any case, spaces instead of dashes, and Crockford's lookalikes.
  const loose = code.toLowerCase().replace(/-/g, " ").replace(/0/g, "o").replace(/1/g, "l");
  assert.equal(readKitCode(loose)?.symbols, code.replace(/-/g, ""));
  // Every single wrong symbol in the random part is caught but one: 0 and
  // Z are 31 apart, which the modulus can't see (they don't look alike).
  const symbols = code.replace(/-/g, "");
  let caught = 0,
    tried = 0;
  for (let i = 0; i < 19; i++)
    for (const c of KIT_ALPHABET) {
      if (c === symbols[i]) continue;
      tried++;
      if (readKitCode(symbols.slice(0, i) + c + symbols.slice(i + 1)).typo) caught++;
    }
  assert.ok(caught / tried > 0.99, `${caught}/${tried}`);
  assert.equal(readKitCode("ABCD-EFGH"), null);
  assert.equal(readKitCode("U".repeat(20)), null, "U isn't in the alphabet");
  assert.equal(readKitCode("x".repeat(500)), null);
  assert.equal(kitCheckSymbol("0".repeat(19)), "0");
  // Two-step recovery codes are recognised only to say so.
  assert.equal(looksLikeTwoStepCode("abcd-efgh-ijkl-mnop"), true);
  assert.equal(looksLikeTwoStepCode(code), false);
  assert.equal(kitCodeInput("ab#cd-ef gh!"), "ABCD-EF GH");
  // The text file: every code, the username, the date, and nothing else.
  const codes = Array.from({ length: KIT_SIZE }, () => kitCodeFromBytes(randomBytes(19)));
  const text = kitText({ codes, username: "ann", created: Date.UTC(2026, 8, 29), origin: "https://askanonyma.com/" });
  for (const c of codes) assert.ok(text.includes(c));
  assert.match(text, /Username: ann/);
  assert.match(text, /Made: 2026-09-29/);
  assert.match(text, /https:\/\/askanonyma\.com\/login/);
  assert.match(text, /even with two-step sign-in on/);
});

test("the check compares every digest in constant time and never stops at a match", async () => {
  const salt = "a".repeat(32);
  const digest = await kitDigest("SYMBOLS", salt);
  assert.equal(digest.length, 64);
  let reads = 0;
  const row = (hex, slot) => ({
    slot,
    get digest() {
      reads++;
      return hex;
    },
  });
  const rows = [row(digest.toString("hex"), 1), ...Array.from({ length: 9 }, (_, i) => row("00".repeat(64), i + 2))];
  assert.equal(matchDigest(rows, digest).slot, 1);
  assert.equal(reads, 10, "all ten are read");
  const src = readFileSync(new URL("../server/recovery-kit.js", import.meta.url), "utf8");
  assert.match(src, /timingSafeEqual\(stored, digest\)/);
  assert.match(src, /scrypt\(/);
  assert.equal(matchDigest(rows.slice(1), digest), null);
});

// ---- Making a kit ----

test("making a kit needs confirm-it's-you; only scrypt digests are stored", async (t) => {
  const s = fixture(t);
  const { a, id } = await passwordAccount(s, "Alice");
  const status = (await a.get("/api/account/recovery-kit").expect(200)).body;
  assert.equal(status.kit, null);
  assert.equal(status.username, true);
  assert.equal(status.nudge, true, "no email and only a password");
  const refused = await a.post("/api/account/recovery-kit").send({});
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "recovery_reauth_required");
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_kits"), 0);
  const codes = await makeKit(a);
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) assert.equal(readKitCode(c)?.typo, false, c);
  const after = (await a.get("/api/account/recovery-kit").expect(200)).body;
  assert.deepEqual({ ...after.kit, created: 0 }, { created: 0, total: 10, unused: 10, lastUsed: null });
  assert.equal(after.nudge, false);
  assert.equal(after.codes, undefined, "shown once");
  const kit = s.db.prepare("SELECT * FROM recovery_kits WHERE user_id=?").get(id);
  assert.match(kit.salt, /^[0-9a-f]{32}$/);
  const rows = s.db.prepare("SELECT * FROM recovery_kit_codes WHERE user_id=? ORDER BY slot").all(id);
  assert.equal(rows.length, 10);
  for (const [i, r] of rows.entries()) {
    assert.match(r.digest, /^[0-9a-f]{128}$/);
    assert.equal(r.digest, (await kitDigest(codes[i].replace(/-/g, ""), kit.salt)).toString("hex"));
    assert.equal(r.digest.includes(codes[i]), false);
  }
  // No code, in any form, anywhere in the database files.
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const files = readdirSync(s.dir).filter((f) => f.startsWith("db.sqlite")).map((f) => readFileSync(join(s.dir, f)).toString("latin1"));
  for (const c of codes)
    for (const form of [c, c.replace(/-/g, ""), c.toLowerCase()])
      assert.ok(files.every((f) => !f.includes(form)), "no code in the database: " + form);
  // A second kit needs replace: true.
  const again = await a.post("/api/account/recovery-kit").send({});
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "recovery_kit_exists");
});

test("a session signed out while its kit is being made can't store it", async (t) => {
  const s = fixture(t);
  const { a, id } = await passwordAccount(s, "midway");
  await confirmPassword(a).expect(200);
  const issue = s.recoveryKit.issue;
  s.recoveryKit.issue = async (userId) => {
    const made = await issue(userId);
    // A recovery elsewhere signs every session out while the codes hash.
    s.db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);
    return made;
  };
  const r = await a.post("/api/account/recovery-kit").send({});
  assert.equal(r.status, 401);
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_kits WHERE user_id=?", id), 0);
});

test("an account without a username can't make a kit", async (t) => {
  const s = fixture(t);
  const a = agent(s);
  const sent = await a.post("/api/auth/email/send").send({ email: "nameless@example.com" }).expect(200);
  await a.post("/api/auth/email/verify").send({ id: sent.body.id, code: sent.body.testCode }).expect(200);
  const status = (await a.get("/api/account/recovery-kit").expect(200)).body;
  assert.equal(status.username, false);
  assert.equal(status.nudge, false);
  const r = await a.post("/api/account/recovery-kit").send({});
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, "recovery_kit_username");
});

// ---- Using a code ----

test("a code gets you back in once, and only after a new password", async (t) => {
  const s = fixture(t);
  const { a: owner, id } = await passwordAccount(s, "Alice");
  const codes = await makeKit(owner);
  const other = agent(s);
  await other.post("/api/auth/password").send({ username: "alice", password: PASSWORD }).expect(200);
  assert.ok(await signedInAs(other));
  // Any case for the username; any case, spaces and lookalikes for the code.
  const b = agent(s);
  const r = await b.post("/api/auth/recovery-kit/redeem").send({ username: "ALICE", code: codes[0].toLowerCase().replace(/-/g, " ") });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.recovery.token, /^kitrec_/);
  assert.equal(r.body.recovery.codesLeft, 9);
  assert.ok(r.body.recovery.expires - Date.now() <= PENDING_MS);
  // No session yet, and every existing one is gone.
  assert.doesNotMatch(cookieOf(r), /anonyma_session=/);
  assert.equal(await signedInAs(b), null);
  assert.equal(await signedInAs(owner), null);
  assert.equal(await signedInAs(other), null);
  assert.equal(count(s, "SELECT COUNT(*) n FROM sessions WHERE user_id=?", id), 0);
  // The token isn't a session.
  const forged = request(s.app).get("/api/me").set("Cookie", "anonyma_session=" + r.body.recovery.token);
  assert.equal((await forged.expect(200)).body.user, null);
  // A short password is refused without using the token up.
  const short = await b.post("/api/auth/recovery-kit/password").send({ token: r.body.recovery.token, password: "short" });
  assert.equal(short.status, 400);
  assert.equal(short.body.error.code, "recovery_password");
  const done = await b.post("/api/auth/recovery-kit/password").send({ token: r.body.recovery.token, password: NEW_PASSWORD });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.match(cookieOf(done), /anonyma_session=/);
  assert.deepEqual(done.body.recovery, { method: "password", codesLeft: 9, twoStep: false });
  assert.equal((await signedInAs(b)).id, id);
  // The old password is gone; the new one works.
  assert.equal((await request(s.app).post("/api/auth/password").send({ username: "alice", password: PASSWORD })).status, 401);
  await request(s.app).post("/api/auth/password").send({ username: "alice", password: NEW_PASSWORD }).expect(200);
  // One time: the same code, and the same token, never work again.
  const reused = await redeem(s, "alice", codes[0]);
  assert.equal(reused.status, 401);
  assert.equal(reused.body.error.code, "recovery_code_used");
  const token = await b.post("/api/auth/recovery-kit/password").send({ token: r.body.recovery.token, password: NEW_PASSWORD });
  assert.equal(token.status, 400);
  assert.equal(token.body.error.code, "recovery_expired");
  const view = (await b.get("/api/account/recovery-kit").expect(200)).body.kit;
  assert.equal(view.unused, 9);
  assert.ok(view.lastUsed > 0);
});

test("one code, two requests at once: only one wins", async (t) => {
  const s = fixture(t);
  const { a } = await passwordAccount(s, "racer");
  const [code] = await makeKit(a);
  const results = await Promise.all([redeem(s, "racer", code), redeem(s, "racer", code), redeem(s, "racer", code)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 401, 401]);
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_pending"), 1);
});

test("the recovery step expires, and its token does nothing else", async (t) => {
  const s = fixture(t);
  const { a, id } = await passwordAccount(s, "slow");
  const codes = await makeKit(a);
  const r = await redeem(s, "slow", codes[1]).expect(200);
  s.db.prepare("UPDATE recovery_pending SET expires=? WHERE user_id=?").run(Date.now() - 1, id);
  const late = await agent(s).post("/api/auth/recovery-kit/password").send({ token: r.body.recovery.token, password: NEW_PASSWORD });
  assert.equal(late.status, 400);
  assert.equal(late.body.error.code, "recovery_expired");
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_pending"), 0);
  // The code stays spent; the old password still works (nothing changed).
  assert.equal((await redeem(s, "slow", codes[1])).body.error.code, "recovery_code_used");
  await request(s.app).post("/api/auth/password").send({ username: "slow", password: PASSWORD }).expect(200);
  // A token is no two-step sign-in token either.
  const fresh = await redeem(s, "slow", codes[2]).expect(200);
  const twoStep = await request(s.app).post("/api/auth/two-step").send({ token: fresh.body.recovery.token, code: "123456" });
  assert.equal(twoStep.status, 400);
  assert.equal(twoStep.body.error.code, "two_step_expired");
  for (const token of [undefined, "", "x".repeat(300), "kitrec_nope"]) {
    const bad = await agent(s).post("/api/auth/recovery-kit/password").send({ token, password: NEW_PASSWORD });
    assert.equal(bad.body.error.code, "recovery_expired");
  }
});

test("regenerating invalidates the old set and a recovery waiting on it", async (t) => {
  const s = fixture(t);
  const { a } = await passwordAccount(s, "regen");
  const old = await makeKit(a);
  const waiting = await redeem(s, "regen", old[0]).expect(200);
  // The redeem signed everyone out: sign in again to replace the kit.
  const b = agent(s);
  await b.post("/api/auth/password").send({ username: "regen", password: PASSWORD }).expect(200);
  const fresh = await makeKit(b, { replace: true });
  assert.equal(fresh.length, 10);
  assert.ok(fresh.every((c) => !old.includes(c)));
  const stale = await redeem(s, "regen", old[1]);
  assert.equal(stale.status, 401);
  assert.equal(stale.body.error.code, "recovery_invalid");
  const lost = await agent(s).post("/api/auth/recovery-kit/password").send({ token: waiting.body.recovery.token, password: NEW_PASSWORD });
  assert.equal(lost.body.error.code, "recovery_expired");
  await redeem(s, "regen", fresh[0]).expect(200);
});

test("deleting the kit needs confirm-it's-you and stops every code", async (t) => {
  const s = fixture(t);
  const { a, id } = await passwordAccount(s, "deleter");
  const codes = await makeKit(a);
  s.db.prepare("DELETE FROM two_step_reauth").run();
  const refused = await a.delete("/api/account/recovery-kit");
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, "recovery_reauth_required");
  await confirmPassword(a).expect(200);
  const r = await a.delete("/api/account/recovery-kit").expect(200);
  assert.equal(r.body.kit, null);
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_kit_codes WHERE user_id=?", id), 0);
  assert.equal((await redeem(s, "deleter", codes[0])).body.error.code, "recovery_invalid");
});

// ---- Lockouts and answers ----

test("an unknown username, a username without a kit and a wrong code get the same answer", async (t) => {
  const s = fixture(t);
  const { a } = await passwordAccount(s, "haskit");
  await passwordAccount(s, "nokit");
  await makeKit(a);
  const wrong = kitCodeFromBytes(randomBytes(19));
  const answers = [];
  for (const name of ["nobody-here", "nokit", "haskit"]) {
    const r = await redeem(s, name, wrong);
    answers.push([r.status, r.body.error.code, r.body.error.message]);
  }
  assert.deepEqual(answers[0], answers[1]);
  assert.deepEqual(answers[1], answers[2]);
  assert.deepEqual(answers[0].slice(0, 2), [401, "recovery_invalid"]);
});

test("five wrong codes lock a username for an hour, a right code too; formats and typos don't count", async (t) => {
  const s = fixture(t);
  const { a } = await passwordAccount(s, "target");
  const codes = await makeKit(a);
  const typo = (() => {
    const sym = codes[0].replace(/-/g, "");
    const last = sym.at(-1) === "0" ? "1" : "0";
    return sym.slice(0, 19) + last;
  })();
  for (let i = 0; i < 8; i++) {
    const f = await redeem(s, "target", "not a code");
    assert.equal(f.body.error.code, "recovery_code_format");
    const ty = await redeem(s, "target", typo);
    assert.equal(ty.body.error.code, "recovery_code_typo");
  }
  const two = await redeem(s, "target", "abcd-efgh-ijkl-mnop");
  assert.equal(two.body.error.code, "recovery_code_format");
  assert.match(two.body.error.message, /two-step recovery code/);
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_lockouts"), 0, "nothing was tried");
  // Five wrong codes, each from a different address.
  for (let i = 0; i < USERNAME_TRIES; i++) {
    const r = await redeem(s, "TARGET", kitCodeFromBytes(randomBytes(19)));
    assert.equal(r.status, 401);
  }
  const locked = await redeem(s, "target", codes[0]);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, "recovery_locked");
  assert.ok(Number(locked.headers["retry-after"]) > 3000);
  assert.match(locked.body.error.message, /^Too many recovery attempts\. Try again in \d+ min\.$/);
  // The keys hold neither the username nor an address.
  for (const { key } of s.db.prepare("SELECT key FROM recovery_lockouts").all()) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.notEqual(key, createHash("sha256").update("target").digest("hex"));
  }
  // Another username is unaffected; after the hour the right code works.
  await passwordAccount(s, "bystander");
  assert.equal((await redeem(s, "bystander", kitCodeFromBytes(randomBytes(19)))).status, 401);
  s.db.prepare("UPDATE recovery_lockouts SET window_end=?").run(Date.now() - 1);
  await redeem(s, "target", codes[0]).expect(200);
});

test("ten wrong codes lock a network address; a right code gives its try back", async (t) => {
  const s = fixture(t);
  const { a } = await passwordAccount(s, "carol");
  const codes = await makeKit(a);
  const ip = "203.0.113.77";
  await redeem(s, "carol", codes[0], ip).expect(200);
  for (let i = 0; i < ADDRESS_TRIES; i++) {
    const r = await redeem(s, "guess" + i, kitCodeFromBytes(randomBytes(19)), ip);
    assert.equal(r.status, 401, "try " + i);
  }
  const locked = await redeem(s, "carol", codes[1], ip);
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, "recovery_locked");
  // The same username from another address still works.
  await redeem(s, "carol", codes[1], "203.0.113.78").expect(200);
});

test("parallel wrong codes can't slip past the username lock", async (t) => {
  const s = fixture(t);
  const { a } = await passwordAccount(s, "burst");
  await makeKit(a);
  const results = await Promise.all(Array.from({ length: 12 }, () => redeem(s, "burst", kitCodeFromBytes(randomBytes(19)))));
  const statuses = results.map((r) => r.status);
  assert.equal(statuses.filter((x) => x === 401).length, USERNAME_TRIES);
  assert.equal(statuses.filter((x) => x === 429).length, 12 - USERNAME_TRIES);
});

// ---- What a recovery revokes, and Two-Step Sign-in ----

test("a recovery drops every session, waiting sign-in, confirmation and email code", async (t) => {
  const s = fixture(t);
  const { a, id } = await passwordAccount(s, "wide");
  const codes = await makeKit(a);
  // Link an email, then start an email sign-in somewhere else.
  const link = await a.post("/api/auth/email/send").send({ email: "wide@example.com", purpose: "link" }).expect(200);
  await a.post("/api/auth/email/verify").send({ id: link.body.id, code: link.body.testCode }).expect(200);
  const pending = await agent(s).post("/api/auth/email/send").send({ email: "wide@example.com" }).expect(200);
  s.db.prepare("INSERT INTO two_step_pending(hash,user_id,method,expires,created) VALUES('h',?,'password',?,?)").run(id, Date.now() + 60000, Date.now());
  assert.ok(count(s, "SELECT COUNT(*) n FROM two_step_reauth WHERE user_id=?", id) > 0);
  await redeem(s, "wide", codes[0]).expect(200);
  for (const table of ["sessions", "two_step_pending", "two_step_reauth", "passkey_reauth", "passkey_challenges"])
    assert.equal(count(s, `SELECT COUNT(*) n FROM ${table} WHERE user_id=?`, id), 0, table);
  const late = await agent(s).post("/api/auth/email/verify").send({ id: pending.body.id, code: pending.body.testCode });
  assert.equal(late.status, 400, "the pending email code is gone");
});

test("two-step: the kit skips its code this once; later sign-ins still ask; the codes never mix", async (t) => {
  const s = fixture(t);
  const { a, id } = await passwordAccount(s, "gwen");
  await confirmPassword(a).expect(200);
  const setup = await a.post("/api/account/two-step/setup").send({}).expect(200);
  const on = await a
    .post("/api/account/two-step/enable")
    .send({ code: hotp(base32Decode(setup.body.secret), stepAt(Date.now())) })
    .expect(200);
  const twoStepCode = on.body.recoveryCodes[0];
  const codes = await makeKit(a);
  // A kit code isn't a two-step code.
  const pw = await request(s.app).post("/api/auth/password").send({ username: "gwen", password: PASSWORD }).expect(200);
  const mixed = await request(s.app).post("/api/auth/two-step").send({ token: pw.body.twoStep.token, code: codes[0] });
  assert.equal(mixed.status, 400);
  assert.equal(mixed.body.error.code, "two_step_code_format");
  // And a two-step recovery code isn't a kit code (and costs no try).
  const other = await redeem(s, "gwen", twoStepCode);
  assert.equal(other.body.error.code, "recovery_code_format");
  assert.match(other.body.error.message, /two-step recovery code/);
  // The kit gets in without the authenticator.
  const b = agent(s);
  const r = await b.post("/api/auth/recovery-kit/redeem").send({ username: "gwen", code: codes[0] }).expect(200);
  const done = await b.post("/api/auth/recovery-kit/password").send({ token: r.body.recovery.token, password: NEW_PASSWORD }).expect(200);
  assert.equal(done.body.twoStep, undefined);
  assert.equal(done.body.recovery.twoStep, true);
  assert.equal((await signedInAs(b)).id, id);
  // Two-step is still on: the next password sign-in waits for a code.
  const next = await request(s.app).post("/api/auth/password").send({ username: "gwen", password: NEW_PASSWORD }).expect(200);
  assert.ok(next.body.twoStep?.token);
  assert.doesNotMatch(cookieOf(next), /anonyma_session=/);
  // And the two-step recovery code still works where it belongs.
  const second = await request(s.app).post("/api/auth/two-step").send({ token: next.body.twoStep.token, code: twoStepCode }).expect(200);
  assert.equal(second.body.twoStep.method, "recovery");
});

// ---- Passkeys ----

test("a passkey-only account recovers by adding a passkey", async (t) => {
  const s = fixture(t);
  const { a, device, id } = await passkeyAccount(s, "keyonly");
  const status = (await a.get("/api/account/recovery-kit").expect(200)).body;
  assert.equal(status.nudge, true, "no email and only passkeys");
  assert.deepEqual(status.reauthMethods, ["passkey"]);
  // Confirm it's you with the passkey, then make the kit.
  const start = await a.post("/api/account/passkeys/reauth/options").send({}).expect(200);
  await a.post("/api/account/passkeys/reauth").send({ response: device.get(start.body.options) }).expect(200);
  const made = await a.post("/api/account/recovery-kit").send({}).expect(201);
  // The phone is lost: a new device, a code, and a new passkey.
  const b = agent(s);
  const r = await b.post("/api/auth/recovery-kit/redeem").send({ username: "keyonly", code: made.body.codes[3] }).expect(200);
  assert.equal(r.body.recovery.passkey, true);
  assert.equal(await signedInAs(a), null);
  const opts = await b.post("/api/auth/recovery-kit/passkey/options").send({ token: r.body.recovery.token }).expect(200);
  assert.equal(opts.body.options.excludeCredentials.length, 1, "the lost passkey is excluded");
  const phone = softAuthenticator();
  const response = phone.create(opts.body.options);
  // The ceremony belongs to this recovery: a session's add route can't use it.
  const wrongToken = await b.post("/api/auth/recovery-kit/passkey").send({ token: "kitrec_other", response, name: "New phone" });
  assert.equal(wrongToken.body.error.code, "recovery_expired");
  const done = await b.post("/api/auth/recovery-kit/passkey").send({ token: r.body.recovery.token, response, name: "New phone" });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal(done.body.recovery.method, "passkey");
  assert.equal(done.body.passkey.name, "New phone");
  assert.match(cookieOf(done), /anonyma_session=/);
  assert.equal(count(s, "SELECT COUNT(*) n FROM passkeys WHERE user_id=?", id), 2);
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_pending"), 0);
  // The new passkey signs in; the password was never set.
  const back = await passkeySignIn(s, phone);
  assert.equal(back.status, 200);
  assert.equal(back.body.user.id, id);
  assert.equal(s.db.prepare("SELECT password FROM users WHERE id=?").get(id).password, null);
  // The token was used up with the passkey.
  const again = await b.post("/api/auth/recovery-kit/password").send({ token: r.body.recovery.token, password: NEW_PASSWORD });
  assert.equal(again.body.error.code, "recovery_expired");
});

test("where passkeys can't work, only a new password is offered", async (t) => {
  const s = fixture(t, { origin: "http://127.0.0.1:5175" });
  const a = agent(s);
  await a.post("/api/auth/register").set("Origin", "http://127.0.0.1:5175").send({ username: "iponly", password: PASSWORD }).expect(201);
  await confirmPassword(a).set("Origin", "http://127.0.0.1:5175").expect(200);
  const made = await a.post("/api/account/recovery-kit").set("Origin", "http://127.0.0.1:5175").send({}).expect(201);
  const r = await agent(s).post("/api/auth/recovery-kit/redeem").set("Origin", "http://127.0.0.1:5175").send({ username: "iponly", code: made.body.codes[0] }).expect(200);
  assert.equal(r.body.recovery.passkey, false);
  const p = await agent(s).post("/api/auth/recovery-kit/passkey/options").set("Origin", "http://127.0.0.1:5175").send({ token: r.body.recovery.token });
  assert.equal(p.status, 503);
  assert.equal(p.body.error.code, "passkeys_unavailable");
});

// ---- The nudge ----

test("the nudge: once, only for accounts with no email and one kind of way in", async (t) => {
  const s = fixture(t);
  const { a, id } = await passwordAccount(s, "nudged");
  const user = () => s.db.prepare("SELECT * FROM users WHERE id=?").get(id);
  assert.equal(nudgeDue(s.db, user()), true);
  assert.equal(nudgeDue(s.db, { ...user(), email: "x@example.com" }), false, "an email can reset it");
  assert.equal(nudgeDue(s.db, { ...user(), wallet: "0xabc" }), false, "a wallet is another way in");
  assert.equal(nudgeDue(s.db, { ...user(), username: null }), false, "nothing to recover with");
  s.db.prepare("INSERT INTO passkeys(id,user_id,credential_id,public_key,counter,user_handle,name,created) VALUES('pk_x',?,'cred',x'00',0,'h','Key',?)").run(id, Date.now());
  assert.equal(nudgeDue(s.db, user()), false, "a password and a passkey");
  assert.equal(nudgeDue(s.db, { ...user(), password: null }), true, "passkeys only");
  s.db.prepare("DELETE FROM passkeys WHERE id='pk_x'").run();
  const r = await a.delete("/api/account/recovery-kit/nudge").expect(200);
  assert.equal(r.body.nudge, false);
  await a.delete("/api/account/recovery-kit/nudge").expect(200);
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_nudges WHERE user_id=?", id), 1);
  assert.equal((await a.get("/api/account/recovery-kit").expect(200)).body.nudge, false);
});

// ---- The account lifecycle ----

test("export shows the date and count, never codes; Panic Wipe keeps the kit; closure deletes it", async (t) => {
  const s = fixture(t);
  const { a, id } = await passwordAccount(s, "life");
  const codes = await makeKit(a);
  await a.delete("/api/account/recovery-kit/nudge").expect(200);
  const b = agent(s);
  const r = await b.post("/api/auth/recovery-kit/redeem").send({ username: "life", code: codes[0] }).expect(200);
  await b.post("/api/auth/recovery-kit/password").send({ token: r.body.recovery.token, password: NEW_PASSWORD }).expect(200);
  const exp = await b.get("/api/account/export").expect(200);
  assert.deepEqual(Object.keys(exp.body.recoveryKit).sort(), ["created", "lastUsed", "total", "unused"]);
  assert.equal(exp.body.recoveryKit.unused, 9);
  assert.equal(exp.body.recoveryKit.total, 10);
  const text = JSON.stringify(exp.body);
  const salt = s.db.prepare("SELECT salt FROM recovery_kits WHERE user_id=?").get(id).salt;
  for (const c of codes) assert.ok(!text.includes(c) && !text.includes(c.replace(/-/g, "")));
  assert.ok(!text.includes(salt));
  for (const { digest } of s.db.prepare("SELECT digest FROM recovery_kit_codes").all()) assert.ok(!text.includes(digest));
  // A recovery waiting for its new password goes with the sessions.
  await redeem(s, "life", codes[1]).expect(200);
  const c = agent(s);
  await c.post("/api/auth/password").send({ username: "life", password: NEW_PASSWORD }).expect(200);
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_pending WHERE user_id=?", id), 1);
  await c.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_pending WHERE user_id=?", id), 0);
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_kit_codes WHERE user_id=?", id), 10, "Panic Wipe keeps the kit");
  assert.equal(count(s, "SELECT COUNT(*) n FROM recovery_nudges WHERE user_id=?", id), 1);
  // It still works after the wipe.
  const d = agent(s);
  const again = await d.post("/api/auth/recovery-kit/redeem").send({ username: "life", code: codes[2] }).expect(200);
  await d.post("/api/auth/recovery-kit/password").send({ token: again.body.recovery.token, password: PASSWORD }).expect(200);
  // Closure deletes all of it.
  await d.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  for (const table of ["recovery_kits", "recovery_kit_codes", "recovery_pending", "recovery_nudges"])
    assert.equal(count(s, `SELECT COUNT(*) n FROM ${table} WHERE user_id=?`, id), 0, table);
  assert.equal((await redeem(s, "life", codes[3])).body.error.code, "recovery_invalid");
});

test("the migration is additive and comes after the ones before it", async () => {
  const { MIGRATIONS } = await import("../server/core.js");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  let at = -1;
  for (let v = 0; v < MIGRATIONS.length && at < 0; v++) {
    MIGRATIONS[v](db);
    db.exec(`PRAGMA user_version=${v + 1}`);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='recovery_kits'").get()) at = v;
  }
  assert.ok(at >= 0, "found by content");
  assert.ok(db.prepare("SELECT 1 FROM schema_additive WHERE version=?").get(at + 1), "recorded as additive");
  for (const table of ["recovery_kit_codes", "recovery_pending", "recovery_lockouts", "recovery_nudges"])
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table), table);
  const src = readFileSync(new URL("../server/core.js", import.meta.url), "utf8");
  assert.ok(src.indexOf("CREATE TABLE IF NOT EXISTS recovery_kits") > src.indexOf("CREATE TABLE IF NOT EXISTS slide_decks"));
  db.close();
});

// ---- The browser ----

// RecoveryKit.jsx compiled for Node with the same esbuild Vite uses; shared
// UI, routing, Two-Step's confirmation and Passkeys' helpers are swapped for
// plain stand-ins so only its own text renders.
async function uiModule(name = "RecoveryKit") {
  const src = new URL(`../src/${name}.jsx`, import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-recovery-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Notice = ({ children }) => React.createElement("div", null, children);
     export const Icon = () => React.createElement("svg");
     export const Button = ({ children }) => React.createElement("button", null, children);`,
  );
  const router = stub("router.mjs", `export const Link = ({ children, to }) => React.createElement("a", { href: to }, children);`);
  const dom = stub("dom.mjs", `export const createPortal = (x) => x;`);
  const lib = stub("lib.mjs", `export const api = async () => { throw Error("no network in tests"); }; export const download = () => {};`);
  const i18n = stub("i18n.mjs", `export const t = (s) => s;`);
  const twoStep = stub("two-step.mjs", `export const ConfirmItsYou = () => React.createElement("div", null, "confirm");`);
  const passkeys = stub(
    "passkeys.mjs",
    `export const browserSupportsPasskeys = () => true; export const confirmWithPasskey = async () => ({});
     export const defaultPasskeyName = () => "Mac"; export const passkeyError = (e) => e.message;
     export const passkeysReleased = (c) => c?.releases?.features?.passkeys === true;`,
  );
  const out = code
    .replace(/^import "\.\/recovery-kit(-link)?\.css";$/gm, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "react-dom"/g, `from "${dom}"`)
    .replace(/from "\.\/lib\.js"/g, `from "${lib}"`)
    .replace(/from "\.\/i18n\.js"/g, `from "${i18n}"`)
    .replace(/from "\.\/TwoStep\.jsx"/g, `from "${twoStep}"`)
    .replace(/from "\.\/passkeys\.js"/g, `from "${passkeys}"`)
    .replace(/from "\.\/recovery-kit\.js"/g, `from "${new URL("../src/recovery-kit.js", import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, name + ".mjs");
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
  // Skip user content (the codes and the username are data-i18n="off").
  const visible = html.replace(/<(ol|dd)[^>]*data-i18n="off"[^>]*>[\s\S]*?<\/\1>/g, "");
  for (const [, tag, text] of visible.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g)) out.push(entities(attr));
    } else if (entities(text).trim()) out.push(entities(text).trim());
  }
  return out.filter((x) => /[A-Za-z]{2}/.test(x) && x !== "ANONYMA" && !/^X{4}(-X{4}){4}$/.test(x));
}

test("the UI is gated, and every word on it translates", async () => {
  const mod = { ...(await uiModule()), ...(await uiModule("RecoveryKitLink")) };
  const soon = { releases: { features: { recovery: false, twostep: true, passkeys: true } } };
  const on = { releases: { features: { recovery: true, twostep: true, passkeys: true } } };
  const user = { id: "u_1", username: "ann" };
  const render = (C, props) => renderToStaticMarkup(createElement(C, props));
  // Before release: no section, no link, no nudge.
  assert.equal(render(mod.RecoveryKitSettings, { config: soon, user }), "");
  assert.equal(render(mod.RecoveryKitLink, { config: soon, onClick() {} }), "");
  assert.equal(render(mod.RecoveryKitNudge, { config: soon, user }), "");
  // Released: a link on the sign-in page; the nudge waits for the server.
  assert.match(render(mod.RecoveryKitLink, { config: on, onClick() {} }), /Use a recovery code/);
  assert.equal(render(mod.RecoveryKitNudge, { config: on, user, demo: true }), "", "never in the demo");
  const codes = Array.from({ length: 10 }, () => kitCodeFromBytes(randomBytes(19)));
  const html = [
    render(mod.RecoveryKitSettings, { config: on, user, demo: true }),
    render(mod.KitIntro, {}),
    render(mod.KitStatus, { kit: { created: Date.UTC(2026, 8, 1), total: 10, unused: 3, lastUsed: null } }),
    render(mod.KitCodes, { codes, username: "ann", created: Date.now(), onPrint() {}, onDone() {} }),
    render(mod.KitSheet, { codes, username: "ann", created: Date.UTC(2026, 8, 1) }),
    render(mod.KitNudge, { onMake() {}, onDismiss() {} }),
    render(mod.RecoveryKitSignIn, { config: on, onSignedIn() {}, onCancel() {} }),
    render(mod.RecoveryKitSignIn, { config: on, onSignedIn() {}, onCancel() {}, initial: { step: "new", recovery: { token: "x", codesLeft: 9, passkey: true } } }),
    render(mod.RecoveryKitSignIn, { config: on, onSignedIn() {}, onCancel() {}, initial: { step: "done", result: { method: "password", codesLeft: 2, twoStep: true } } }),
    render(mod.RecoveryKitSignIn, { config: on, onSignedIn() {}, onCancel() {}, initial: { step: "done", result: { method: "passkey", codesLeft: 1, twoStep: false } } }),
  ].join("");
  // The codes and the username are marked as content the switch leaves alone.
  assert.match(html, /<ol data-i18n="off">/);
  for (const c of codes) assert.ok(html.includes(c));
  assert.match(html, /href="\/account\/security#recovery-kit"/);
  for (const expected of ["Recovery kit.", "Save your recovery kit.", "Download (.txt)", "Print", "Add a passkey instead", "Not now"])
    assert.ok(pageTexts(html).includes(expected), expected);
  const texts = pageTexts(html);
  for (const text of texts)
    if (translateDate(text) === undefined) assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
  // The texts built in code, and the server's messages the page shows.
  for (const text of [
    mod.codesLeftText(0),
    mod.codesLeftText(1),
    mod.codesLeftText(7),
    mod.codeProblem("nope"),
    mod.codeProblem("abcd-efgh-ijkl-mnop"),
    "Only 1 code left. Make a new kit before you run out.",
    "Only 2 codes left. Make a new kit before you run out.",
    "Every code has been used. Make a new kit.",
    "Your new kit is ready. The old codes no longer work.",
    "Recovery kit deleted. Its codes no longer work.",
    "Make a new kit? Your current codes stop working at once.",
    "Delete your recovery kit? Its codes stop working at once, and you’ll need your password or passkey to sign in.",
    "Making or deleting a recovery kit needs a fresh confirmation from this session.",
    "A recovery kit needs a username to recover with, and this account doesn’t have one. Use email or wallet sign-in to get back in.",
    "No kit yet. Make one now, while you can still sign in.",
    "Make a recovery kit",
    "Making your kit…",
    "Delete kit",
    "The two passwords don’t match.",
    "That code has a typo. Check it against your kit and try again.",
    "That username and code don’t match.",
    "That code was already used. Each code works once; try another from your kit.",
    "Too many recovery attempts. Try again in 42 min.",
    "This recovery step expired. The code you used is spent; start again with another code from your kit.",
    "Confirm it’s you first. Making or deleting a recovery kit needs your password, a passkey (or a fresh email code or wallet signature) from the last 10 minutes.",
    "You already have a recovery kit. Make a new one to replace it.",
    "A recovery kit needs a username to recover with, and this account has none.",
    "Use a password between 10 and 256 characters.",
    "Enter your username.",
    "This account already has 10 passkeys. Set a new password instead.",
    "Your recovery kit, so you can still get back in",
    "Back into your account.",
    "No email needed: your username and one code from your kit.",
    "Use a recovery code",
    "Recovery Kit is coming soon.",
  ])
    assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
  // The text file's lines translate too (the page passes the switch's t).
  const file = kitText({ codes, username: "ann", created: Date.now() }, (s) => translateText(s, zh) ?? s);
  for (const line of file.split("\n").slice(0, 7)) if (/[A-Za-z]{3}/.test(line.replace(/ann|ANONYMA|http\S+/g, ""))) assert.match(line, han, line);
});

test("the sign-in page and the account wire it in behind the gate", () => {
  const pages = readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8");
  assert.match(pages, /<RecoveryKitLink\s+config=\{config\}/);
  assert.match(pages, /<RecoveryKitSignIn/);
  // The flow itself loads only when opened; the link is all the page carries.
  assert.match(pages, /lazy\(\(\) =>\s+import\("\.\/RecoveryKit\.jsx"\)/);
  assert.doesNotMatch(pages, /from "\.\/RecoveryKit\.jsx"/);
  const account = readFileSync(new URL("../src/Account.jsx", import.meta.url), "utf8");
  assert.match(account, /<RecoveryKitSettings user=\{user\} demo=\{demo\} config=\{config\} \/>/);
  const workspace = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(workspace, /<RecoveryKitNudge config=\{config\} user=\{user\} demo=\{demo\} \/>/);
  // The palette finds it under Security once it's live.
  const config = { releases: { features: { twostep: true, recovery: true } } };
  const security = paletteActions({ config, user: { id: "u" } }).find((x) => x.id === "security");
  assert.ok(security?.keywords?.includes("recovery kit"));
});
