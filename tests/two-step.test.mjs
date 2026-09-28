import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { Wallet } from "ethers";
import { createApp } from "../server/app.js";
import { hash } from "../server/core.js";
import { UPDATES, featuresFor, releaseInfo } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import {
  hotp,
  totp,
  stepAt,
  matchTotp,
  base32Encode,
  base32Decode,
  sealSecret,
  openSecret,
  otpauthUri,
  accountLabel,
  newRecoveryCode,
  normalizeRecovery,
  looksLikeRecovery,
  STEP_MS,
  MAX_FAILURES,
  PENDING_ATTEMPTS,
  RECOVERY_COUNT,
} from "../server/two-step.js";
import { encodeQR, qrPath, ECL } from "../src/qr.js";
import {
  TWO_STEP_API_NOTE,
  codeInput,
  formatSecret,
  recoveryText,
  twoStepReleased,
} from "../src/two-step.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ORIGIN = "http://localhost:5175";
const PASSWORD = "long-fixture-password";
const APP_SECRET = "fixture-app-secret-".repeat(3);

// Codes depend on the time, so every test that uses them runs on a mocked
// clock (Date only; timers stay real), starting 10 seconds into a step.
const T0 = 1_800_000_000_000 + 10_000;
function fixture(
  t,
  { released = "all", dir, secret = APP_SECRET, clock = true } = {},
) {
  if (clock && !t.clockOn) {
    t.mock.timers.enable({ apis: ["Date"], now: T0 });
    t.clockOn = true;
  }
  const own = !dir;
  dir ||= mkdtempSync(join(tmpdir(), "anonyma-twostep-"));
  const s = createApp({
    testMode: true,
    released,
    origin: ORIGIN,
    secret,
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
  });
  let closed = false;
  const close = s.close;
  s.close = () => {
    if (closed) return;
    closed = true;
    close();
  };
  t.after(() => {
    s.close();
    if (own) rmSync(dir, { recursive: true, force: true });
  });
  return Object.assign(s, { dir });
}
// Moves the mocked clock on.
const advance = (t, ms) => t.mock.timers.setTime(Date.now() + ms);
async function account(s, username = "alice") {
  const a = request.agent(s.app);
  const r = await a
    .post("/api/auth/register")
    .send({ username, password: PASSWORD })
    .expect(201);
  return { a, id: r.body.user.id, username };
}
const login = (s, username = "alice", password = PASSWORD) =>
  request(s.app).post("/api/auth/password").send({ username, password });
// Codes are computed from the secret shown at setup, like an authenticator.
const codeFor = (secret, offsetSteps = 0, at = Date.now()) =>
  hotp(base32Decode(secret), stepAt(at) + offsetSteps);
// Turns two-step on with the current step's code, which is then used up.
// "Confirm it's you" with the account's password, for this session.
const confirm = (a, password = PASSWORD) =>
  a.post("/api/account/two-step/reauth").send({ method: "password", password });
async function enable(a) {
  await confirm(a).expect(200);
  const setup = await a
    .post("/api/account/two-step/setup")
    .send({})
    .expect(200);
  const on = await a
    .post("/api/account/two-step/enable")
    .send({ code: codeFor(setup.body.secret) })
    .expect(200);
  return {
    secret: setup.body.secret,
    codes: on.body.recoveryCodes,
    on: on.body,
  };
}
const cookieOf = (res) => (res.headers["set-cookie"] || []).join(";");
// A signed-in agent for an account that has two-step on.
async function signInWithCode(s, username, code) {
  const agent = request.agent(s.app);
  const first = await agent
    .post("/api/auth/password")
    .send({ username, password: PASSWORD })
    .expect(200);
  assert.ok(first.body.twoStep?.token);
  const done = await agent
    .post("/api/auth/two-step")
    .send({ token: first.body.twoStep.token, code })
    .expect(200);
  return { agent, done };
}
const count = (s, sql, ...args) => s.db.prepare(sql).get(...args).n;

// ---- TOTP ----

test("HOTP and TOTP match the RFC 4226 and RFC 6238 test vectors", () => {
  const sha1 = Buffer.from("12345678901234567890");
  assert.deepEqual(
    Array.from({ length: 10 }, (_, i) => hotp(sha1, i)),
    [
      "755224",
      "287082",
      "359152",
      "969429",
      "338314",
      "254676",
      "287922",
      "162583",
      "399871",
      "520489",
    ],
  );
  const vectors = {
    sha1: [
      sha1,
      ["94287082", "07081804", "14050471", "89005924", "69279037", "65353130"],
    ],
    sha256: [
      Buffer.from("12345678901234567890123456789012"),
      ["46119246", "68084774", "67062674", "91819424", "90698825", "77737706"],
    ],
    sha512: [
      Buffer.from("1234567890".repeat(6) + "1234"),
      ["90693936", "25091201", "99943326", "93441116", "38618901", "47863826"],
    ],
  };
  const times = [
    59, 1111111109, 1111111111, 1234567890, 2000000000, 20000000000,
  ];
  for (const [algorithm, [key, expected]] of Object.entries(vectors))
    assert.deepEqual(
      times.map((t) => totp(key, t * 1000, 8, algorithm)),
      expected,
      algorithm,
    );
  // Accounts use 6 digits: the last six of the SHA-1 vectors.
  assert.equal(totp(sha1, 59000), "287082");
});

test("base32 follows RFC 4648 without padding and round-trips secrets", () => {
  const cases = {
    "": "",
    f: "MY",
    fo: "MZXQ",
    foo: "MZXW6",
    foob: "MZXW6YQ",
    fooba: "MZXW6YTB",
    foobar: "MZXW6YTBOI",
  };
  for (const [plain, encoded] of Object.entries(cases)) {
    assert.equal(base32Encode(Buffer.from(plain)), encoded);
    assert.equal(base32Decode(encoded).toString(), plain);
  }
  assert.equal(base32Decode("mzxw 6ytb-oi").toString(), "foobar");
  assert.throws(() => base32Decode("MZXW1"), /Invalid base32/);
  const secret = Buffer.from("0123456789abcdefghij");
  assert.equal(base32Encode(secret).length, 32);
  assert.deepEqual(base32Decode(base32Encode(secret)), secret);
});

test("a code matches only within one step either side, and only once", () => {
  const key = Buffer.from("12345678901234567890");
  const at = 1_800_000_000_000 + 12_000;
  const step = stepAt(at);
  for (const d of [-1, 0, 1])
    assert.deepEqual(
      matchTotp(key, hotp(key, step + d), { at }),
      { step: step + d },
      `offset ${d}`,
    );
  for (const d of [-2, 2, 10])
    assert.equal(
      matchTotp(key, hotp(key, step + d), { at }),
      null,
      `offset ${d}`,
    );
  // Already used: the same step or any earlier one.
  assert.deepEqual(matchTotp(key, hotp(key, step), { at, lastStep: step }), {
    replay: true,
  });
  assert.deepEqual(
    matchTotp(key, hotp(key, step - 1), { at, lastStep: step }),
    { replay: true },
  );
  assert.deepEqual(
    matchTotp(key, hotp(key, step + 1), { at, lastStep: step }),
    { step: step + 1 },
  );
  for (const bad of ["", "12345", "1234567", "abcdef", "12 456"])
    assert.equal(matchTotp(key, bad, { at }), null);
});

test("the secret is sealed at rest, bound to its account and app secret", () => {
  const secret = Buffer.from("0123456789abcdefghij");
  const sealed = sealSecret("app-secret", "u_1", secret);
  assert.match(sealed, /^v1\.[A-Za-z0-9_-]+$/);
  assert.ok(!sealed.includes(base32Encode(secret)));
  assert.ok(!Buffer.from(sealed.slice(3), "base64url").includes(secret));
  assert.deepEqual(openSecret("app-secret", "u_1", sealed), secret);
  assert.notEqual(
    sealSecret("app-secret", "u_1", secret),
    sealed,
    "fresh IV each time",
  );
  assert.throws(() => openSecret("app-secret", "u_2", sealed));
  assert.throws(() => openSecret("other-secret", "u_1", sealed));
  assert.throws(() => openSecret("app-secret", "u_1", "plain"));
});

test("setup links and recovery codes have the standard shapes", () => {
  const uri = otpauthUri("JBSWY3DPEHPK3PXP", "ali ce");
  assert.equal(
    uri,
    "otpauth://totp/Anonyma:ali%20ce?secret=JBSWY3DPEHPK3PXP&issuer=Anonyma&algorithm=SHA1&digits=6&period=30",
  );
  assert.equal(
    accountLabel({ username: "alice", email: "a@example.com" }),
    "alice",
  );
  assert.equal(accountLabel({ email: "a@example.com" }), "a@example.com");
  assert.equal(
    accountLabel({ wallet: "0x1234567890abcdef1234567890abcdef12345678" }),
    "0x1234…5678",
  );
  assert.equal(accountLabel({}), "account");
  const codes = new Set(Array.from({ length: 200 }, newRecoveryCode));
  assert.equal(codes.size, 200);
  for (const c of codes) {
    assert.match(c, /^[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}-[a-z2-7]{4}$/);
    assert.ok(looksLikeRecovery(c.toUpperCase().replaceAll("-", " ")));
  }
  assert.equal(normalizeRecovery(" ABCD-efgh ijkl-MNOP "), "abcdefghijklmnop");
  assert.ok(!looksLikeRecovery("123456"));
  assert.ok(!looksLikeRecovery("abcd-efgh-ijkl-mno1"));
});

// ---- QR code ----

test("the QR encoder matches an independent encoder module for module", (t) => {
  let QR;
  try {
    QR = createRequire(import.meta.url)("qrcode");
  } catch {
    return t.skip(
      "qrcode (a dependency of WalletConnect) isn't installed here",
    );
  }
  const texts = [
    "A",
    otpauthUri("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", "alice"),
    otpauthUri("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", "someone.long@example.com"),
    "x".repeat(300),
    "中文 two-step ✓",
    "y".repeat(1200),
  ];
  let compared = 0;
  const versions = new Set();
  for (const text of texts)
    for (const ecl of Object.keys(ECL))
      for (let mask = 0; mask < 8; mask++) {
        const mine = encodeQR(text, { ecl, mask });
        const ref = QR.create([{ data: text, mode: "byte" }], {
          errorCorrectionLevel: ecl,
          maskPattern: mask,
          version: mine.version,
        });
        assert.equal(ref.modules.size, mine.size);
        for (let y = 0; y < mine.size; y++)
          for (let x = 0; x < mine.size; x++)
            assert.equal(
              !!ref.modules.get(y, x),
              mine.modules[y][x],
              `${ecl} mask ${mask} v${mine.version} (${x},${y})`,
            );
        versions.add(mine.version);
        compared++;
      }
  assert.equal(compared, texts.length * 32);
  // Small and large versions, with and without version information.
  assert.ok(
    [...versions].some((v) => v < 7) &&
      [...versions].some((v) => v >= 7 && v < 10) &&
      [...versions].some((v) => v >= 10),
  );
  // Each picks the smallest version that fits, as the reference does.
  for (const text of texts)
    assert.equal(
      encodeQR(text).version,
      QR.create([{ data: text, mode: "byte" }], { errorCorrectionLevel: "M" })
        .version,
    );
});

test("QR codes carry readable format information and the finder patterns", () => {
  const uri = otpauthUri("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP", "alice");
  const qr = encodeQR(uri);
  assert.equal(qr.size, qr.version * 4 + 17);
  assert.ok(qr.version <= 7, `a setup link stays small (v${qr.version})`);
  // Finder: a dark 7×7 ring, a light ring, a dark 3×3 core, in three corners.
  for (const [ox, oy] of [
    [0, 0],
    [qr.size - 7, 0],
    [0, qr.size - 7],
  ])
    for (let y = 0; y < 7; y++)
      for (let x = 0; x < 7; x++) {
        const d = Math.max(Math.abs(x - 3), Math.abs(y - 3));
        assert.equal(
          qr.modules[oy + y][ox + x],
          d !== 2,
          `finder (${ox + x},${oy + y})`,
        );
      }
  // The first format copy decodes (BCH, mask 0x5412) to level M and the mask.
  const m = qr.modules;
  const bits = [
    m[0][8],
    m[1][8],
    m[2][8],
    m[3][8],
    m[4][8],
    m[5][8],
    m[7][8],
    m[8][8],
    m[8][7],
    m[8][5],
    m[8][4],
    m[8][3],
    m[8][2],
    m[8][1],
    m[8][0],
  ];
  const word = bits.reduce((a, b, i) => a | ((b ? 1 : 0) << i), 0) ^ 0x5412;
  assert.equal(word >> 13, ECL.M.bits);
  assert.equal((word >> 10) & 7, qr.mask);
  assert.ok(m[qr.size - 8][8], "dark module");
  const { d, viewBox } = qrPath(qr);
  assert.equal(viewBox, `0 0 ${qr.size + 8} ${qr.size + 8}`);
  assert.equal((d.match(/M/g) || []).length, m.flat().filter(Boolean).length);
  assert.throws(() => encodeQR("z".repeat(3000), { ecl: "H" }), /too long/);
  assert.throws(() => encodeQR("a", { ecl: "X" }), /Unknown/);
});

// ---- Release gate ----

test("while unreleased, settings are refused and sign-in is unchanged", async (t) => {
  const s = fixture(t, { released: "mvp" });
  const { a } = await account(s);
  for (const [method, path] of [
    ["get", "/api/account/two-step"],
    ["post", "/api/account/two-step/setup"],
    ["post", "/api/account/two-step/enable"],
    ["post", "/api/account/two-step/recovery-codes"],
    ["post", "/api/account/two-step/disable"],
    ["post", "/api/account/two-step/reauth"],
    ["post", "/api/account/two-step/reauth/start"],
    ["post", "/API/Account/Two-Step/Setup"],
  ]) {
    const r = await a[method](path).send({});
    assert.equal(r.status, 403, path);
    assert.equal(r.body.error.code, "feature_unreleased");
    assert.match(r.body.error.message, /Two-Step Sign-in is coming soon/);
  }
  const r = await login(s).expect(200);
  assert.ok(r.body.user?.id);
  assert.equal(r.body.twoStep, undefined);
  assert.match(cookieOf(r), /anonyma_session=/);
  const exported = await a.get("/api/account/export").expect(200);
  assert.equal(exported.body.twoStep, undefined);
  assert.equal(exported.body.user.twoStep, undefined);
  assert.equal((await a.get("/api/me")).body.user.twoStep, undefined);
  const spec = openapiForConfig(s.cfg);
  assert.ok(!Object.keys(spec.paths).some((p) => p.includes("two-step")));
  assert.equal(releaseInfo(s.cfg).features.twostep, false);
  // An unknown pending token is just expired; nothing else is revealed.
  const step = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: "twostep_x", code: "123456" });
  assert.equal(step.status, 400);
  assert.equal(step.body.error.code, "two_step_expired");
  assert.equal(count(s, "SELECT COUNT(*) n FROM two_step"), 0);
});

test("the release entry, the route gates and the published contract", (t) => {
  const entry = UPDATES.find((u) => u.id === "twostep");
  assert.ok(
    UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "routines"),
    "added after the releases before it",
  );
  assert.equal(entry.title, "Two-Step Sign-in");
  assert.equal(entry.points.length, 3);
  assert.equal(committed[UPDATES.indexOf(entry)], true, "released by its release commit");
  const gate = (path, method = "POST") =>
    featuresFor({ path, method, body: {} });
  for (const p of [
    "/api/account/two-step",
    "/api/account/two-step/setup",
    "/api/account/two-step/disable",
    "/API/ACCOUNT/TWO-STEP/ENABLE",
  ])
    assert.deepEqual(gate(p), ["twostep"], p);
  assert.deepEqual(gate("/api/auth/two-step"), []);
  assert.deepEqual(gate("/api/auth/password"), []);
  const s = fixture(t);
  const paths = Object.keys(openapiForConfig(s.cfg).paths).filter((p) =>
    p.includes("two-step"),
  );
  assert.deepEqual(paths.sort(), [
    "/api/account/two-step",
    "/api/account/two-step/disable",
    "/api/account/two-step/enable",
    "/api/account/two-step/reauth",
    "/api/account/two-step/reauth/start",
    "/api/account/two-step/recovery-codes",
    "/api/account/two-step/setup",
    "/api/auth/two-step",
  ]);
});

// ---- Setup ----

test("setup shows a key and link, and turns on only after a current code", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const other = request.agent(s.app);
  await other
    .post("/api/auth/password")
    .send({ username: "alice", password: PASSWORD })
    .expect(200);
  assert.deepEqual((await a.get("/api/account/two-step").expect(200)).body, {
    enabled: false,
    enabledAt: null,
    recoveryCodesLeft: 0,
    reauthMethods: ["password"],
    reauthUntil: null,
  });
  await confirm(a).expect(200);
  const setup = await a
    .post("/api/account/two-step/setup")
    .send({})
    .expect(200);
  const { secret, uri, label } = setup.body;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.equal(label, "alice");
  assert.equal(uri, otpauthUri(secret, "alice"));
  assert.ok(setup.body.expires > Date.now());
  // Sealed in the database, never the key itself.
  const row = s.db.prepare("SELECT * FROM two_step WHERE user_id=?").get(id);
  assert.equal(row.enabled, 0);
  assert.match(row.secret, /^v1\./);
  assert.ok(!row.secret.includes(secret));
  assert.deepEqual(
    openSecret(APP_SECRET, id, row.secret),
    base32Decode(secret),
  );
  // A setup alone changes nothing for sign-in (this makes a second session).
  assert.ok((await login(s).expect(200)).body.user);
  // Wrong or malformed codes don't turn it on.
  const wrong = await a
    .post("/api/account/two-step/enable")
    .send({ code: codeFor(secret, 3) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, "two_step_invalid");
  const bad = await a
    .post("/api/account/two-step/enable")
    .send({ code: "12ab56" });
  assert.equal(bad.body.error.code, "two_step_code_format");
  assert.equal((await a.get("/api/account/two-step")).body.enabled, false);
  // A second setup replaces the first key.
  const again = await a
    .post("/api/account/two-step/setup")
    .send({})
    .expect(200);
  assert.notEqual(again.body.secret, secret);
  const stale = await a
    .post("/api/account/two-step/enable")
    .send({ code: codeFor(secret) });
  assert.equal(stale.status, 401, "the replaced key no longer confirms");
  const on = await a
    .post("/api/account/two-step/enable")
    .send({ code: codeFor(again.body.secret) })
    .expect(200);
  assert.equal(on.body.enabled, true);
  assert.ok(on.body.enabledAt > 0);
  assert.equal(on.body.recoveryCodesLeft, RECOVERY_COUNT);
  assert.equal(on.body.recoveryCodes.length, RECOVERY_COUNT);
  assert.equal(new Set(on.body.recoveryCodes).size, RECOVERY_COUNT);
  for (const c of on.body.recoveryCodes)
    assert.match(c, /^[a-z2-7]{4}(-[a-z2-7]{4}){3}$/);
  // Other sessions are signed out; this one stays.
  assert.equal(on.body.signedOutSessions, 2);
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM sessions WHERE user_id=?", id),
    1,
  );
  assert.equal((await other.get("/api/me")).body.user, null);
  assert.equal((await a.get("/api/me")).body.user.id, id);
  // Recovery codes are stored only as hashes.
  const stored = s.db
    .prepare("SELECT hash,used FROM two_step_recovery WHERE user_id=?")
    .all(id);
  assert.equal(stored.length, RECOVERY_COUNT);
  const dump =
    JSON.stringify(s.db.prepare("SELECT * FROM two_step_recovery").all()) +
    JSON.stringify(s.db.prepare("SELECT * FROM two_step").all());
  for (const c of on.body.recoveryCodes) {
    assert.ok(!dump.includes(c) && !dump.includes(normalizeRecovery(c)));
  }
  assert.ok(!dump.includes(again.body.secret));
  // Status never repeats them; setting up again is refused.
  const status = (await a.get("/api/account/two-step").expect(200)).body;
  assert.deepEqual(Object.keys(status).sort(), [
    "enabled",
    "enabledAt",
    "reauthMethods",
    "reauthUntil",
    "recoveryCodesLeft",
  ]);
  const dup = await a.post("/api/account/two-step/setup").send({});
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, "two_step_on");
  const dupOn = await a
    .post("/api/account/two-step/enable")
    .send({ code: "123456" });
  assert.equal(dupOn.status, 409);
});

test("a setup expires after 15 minutes", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  await confirm(a).expect(200);
  const setup = await a
    .post("/api/account/two-step/setup")
    .send({})
    .expect(200);
  s.db
    .prepare("UPDATE two_step SET created=? WHERE user_id=?")
    .run(Date.now() - 16 * 60000, id);
  const r = await a
    .post("/api/account/two-step/enable")
    .send({ code: codeFor(setup.body.secret) });
  assert.equal(r.status, 400);
  assert.equal(r.body.error.code, "two_step_setup_expired");
  // The worker drops setups nobody confirmed.
  await s.tick();
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM two_step WHERE user_id=?", id),
    0,
  );
  const none = await a
    .post("/api/account/two-step/enable")
    .send({ code: "123456" });
  assert.equal(none.body.error.code, "two_step_setup_expired");
});

// ---- Confirm it's you ----

// Another session of the same account whose cookie was stolen: a real
// session, but whoever holds it doesn't know the password.
async function stolenSession(s) {
  const r = await login(s).expect(200);
  const cookie = cookieOf(r).match(/anonyma_session=[^;]+/)[0];
  const as = (method, path) =>
    request(s.app)[method](path).set("Cookie", cookie);
  return { get: (p) => as("get", p), post: (p) => as("post", p) };
}

test("a stolen session can't turn it on or take new recovery codes", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const thief = await stolenSession(s);
  const st = (await thief.get("/api/account/two-step").expect(200)).body;
  assert.deepEqual(st.reauthMethods, ["password"]);
  assert.equal(st.reauthUntil, null);
  for (const path of [
    "/api/account/two-step/setup",
    "/api/account/two-step/enable",
  ]) {
    const r = await thief.post(path).send({ code: "123456" });
    assert.equal(r.status, 403, path);
    assert.equal(r.body.error.code, "two_step_reauth_required");
    assert.match(r.body.error.message, /^Confirm it’s you first\./);
  }
  // Guessing the password doesn't help, and a password account can't
  // switch to an email code.
  const wrong = await thief
    .post("/api/account/two-step/reauth")
    .send({ method: "password", password: "not-it-at-all" });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, "two_step_reauth_failed");
  for (const [path, body] of [
    [
      "/api/account/two-step/reauth",
      { method: "email", id: "e_x", code: "123456" },
    ],
    ["/api/account/two-step/reauth/start", { method: "email" }],
    ["/api/account/two-step/reauth/start", { method: "wallet" }],
    ["/api/account/two-step/reauth/start", { method: "password" }],
    ["/api/account/two-step/reauth", { method: "nope" }],
  ]) {
    const r = await thief.post(path).send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.body.error.code, "two_step_reauth_method");
  }
  assert.equal(
    (await thief.post("/api/account/two-step/setup").send({})).status,
    403,
  );
  assert.equal(count(s, "SELECT COUNT(*) n FROM two_step"), 0);
  assert.equal(count(s, "SELECT COUNT(*) n FROM two_step_reauth"), 0);
  // The owner confirming on their own session doesn't unlock the thief's.
  const ok = await confirm(a).expect(200);
  assert.equal(ok.body.reauthUntil, Date.now() + 10 * 60000);
  assert.equal(
    (await a.get("/api/account/two-step")).body.reauthUntil,
    ok.body.reauthUntil,
  );
  assert.equal(
    (await thief.post("/api/account/two-step/setup").send({})).status,
    403,
  );
  assert.equal(
    (await thief.get("/api/account/two-step")).body.reauthUntil,
    null,
  );
  // Only a hash of the session is kept.
  const row = s.db
    .prepare("SELECT * FROM two_step_reauth WHERE user_id=?")
    .get(id);
  assert.equal(row.method, "password");
  assert.match(row.session_hash, /^[0-9a-f]{64}$/);
});

test("the confirmation lasts 10 minutes and never uses up a code", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  await confirm(a).expect(200);
  const setup = await a
    .post("/api/account/two-step/setup")
    .send({})
    .expect(200);
  // Ten minutes on, confirming the setup needs a new confirmation.
  advance(t, 10 * 60000 + 1000);
  assert.equal((await a.get("/api/account/two-step")).body.reauthUntil, null);
  const late = await a
    .post("/api/account/two-step/enable")
    .send({ code: codeFor(setup.body.secret) });
  assert.equal(late.status, 403);
  assert.equal(late.body.error.code, "two_step_reauth_required");
  await confirm(a).expect(200);
  const on = await a
    .post("/api/account/two-step/enable")
    .send({ code: codeFor(setup.body.secret) })
    .expect(200);
  // New recovery codes need a fresh confirmation too, checked before the
  // code, so the code refused here still works afterwards.
  advance(t, 10 * 60000 + 1000);
  const code = codeFor(setup.body.secret);
  const stale = await a
    .post("/api/account/two-step/recovery-codes")
    .send({ code });
  assert.equal(stale.status, 403);
  assert.equal(stale.body.error.code, "two_step_reauth_required");
  await confirm(a).expect(200);
  const fresh = await a
    .post("/api/account/two-step/recovery-codes")
    .send({ code })
    .expect(200);
  assert.equal(fresh.body.recoveryCodes.length, RECOVERY_COUNT);
  // Turning it off needs only a code (or a recovery code), not a confirmation.
  advance(t, 10 * 60000 + 1000);
  await a
    .post("/api/account/two-step/disable")
    .send({ code: fresh.body.recoveryCodes[0] })
    .expect(200);
  // The worker drops confirmations past their 10 minutes.
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM two_step_reauth WHERE user_id=?", id),
    1,
  );
  await s.tick();
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM two_step_reauth WHERE user_id=?", id),
    0,
  );
  void on;
});

test("an account without a password confirms with a fresh email code", async (t) => {
  const s = fixture(t);
  const emailSignIn = async () => {
    const agent = request.agent(s.app);
    const sent = await agent
      .post("/api/auth/email/send")
      .send({ email: "eve@example.com" })
      .expect(200);
    const r = await agent
      .post("/api/auth/email/verify")
      .send({ id: sent.body.id, code: sent.body.testCode })
      .expect(200);
    return { agent, id: r.body.user.id };
  };
  const { agent, id } = await emailSignIn();
  const other = (await emailSignIn()).agent;
  assert.deepEqual(
    (await agent.get("/api/account/two-step")).body.reauthMethods,
    ["email"],
  );
  assert.equal(
    (await agent.post("/api/account/two-step/setup").send({})).status,
    403,
  );
  const pw = await agent
    .post("/api/account/two-step/reauth")
    .send({ method: "password", password: PASSWORD });
  assert.equal(pw.body.error.code, "two_step_reauth_method");
  assert.match(
    pw.body.error.message,
    /email or a signature from your linked wallet/,
  );
  const start = await agent
    .post("/api/account/two-step/reauth/start")
    .send({ method: "email" })
    .expect(200);
  assert.match(start.body.testCode, /^\d{6}$/);
  const ch = s.db
    .prepare("SELECT * FROM challenges WHERE id=?")
    .get(start.body.id);
  assert.equal(ch.target, "eve@example.com");
  assert.equal(ch.purpose, "two_step_reauth");
  // The code can't sign anyone in, and another session can't use it.
  const signIn = await request(s.app)
    .post("/api/auth/email/verify")
    .send({ id: start.body.id, code: start.body.testCode });
  assert.equal(signIn.status, 400);
  const elsewhere = await other
    .post("/api/account/two-step/reauth")
    .send({ method: "email", id: start.body.id, code: start.body.testCode });
  assert.equal(elsewhere.body.error.code, "two_step_reauth_expired");
  const wrong = await agent.post("/api/account/two-step/reauth").send({
    method: "email",
    id: start.body.id,
    code: start.body.testCode === "000000" ? "111111" : "000000",
  });
  assert.equal(wrong.body.error.message, "Incorrect verification code.");
  await agent
    .post("/api/account/two-step/reauth")
    .send({ method: "email", id: start.body.id, code: start.body.testCode })
    .expect(200);
  const again = await agent
    .post("/api/account/two-step/reauth")
    .send({ method: "email", id: start.body.id, code: start.body.testCode });
  assert.equal(
    again.body.error.code,
    "two_step_reauth_expired",
    "a code works once",
  );
  assert.equal(
    s.db.prepare("SELECT method FROM two_step_reauth WHERE user_id=?").get(id)
      .method,
    "email",
  );
  assert.equal(
    (await other.post("/api/account/two-step/setup").send({})).status,
    403,
  );
  await agent.post("/api/account/two-step/setup").send({}).expect(200);
});

test("a wallet-only account confirms with a signature from its wallet", async (t) => {
  const s = fixture(t);
  const wallet = Wallet.createRandom();
  const agent = request.agent(s.app);
  const ch = await agent
    .post("/api/auth/wallet/challenge")
    .send({ address: wallet.address })
    .expect(200);
  const signedIn = await agent
    .post("/api/auth/wallet/verify")
    .send({
      id: ch.body.id,
      signature: await wallet.signMessage(ch.body.message),
    })
    .expect(200);
  assert.deepEqual(
    (await agent.get("/api/account/two-step")).body.reauthMethods,
    ["wallet"],
  );
  assert.equal(
    (await agent.post("/api/account/two-step/setup").send({})).status,
    403,
  );
  const email = await agent
    .post("/api/account/two-step/reauth/start")
    .send({ method: "email" });
  assert.equal(email.body.error.code, "two_step_reauth_method");
  const start = await agent
    .post("/api/account/two-step/reauth/start")
    .send({ method: "wallet" })
    .expect(200);
  assert.match(
    start.body.message,
    /Confirm a two-step sign-in change on Anonyma\. This does not authorize a blockchain transaction\./,
  );
  assert.ok(start.body.message.includes(wallet.address));
  // The message can't be used to sign in.
  const asSignIn = await request(s.app)
    .post("/api/auth/wallet/verify")
    .send({
      id: start.body.id,
      signature: await wallet.signMessage(start.body.message),
    });
  assert.equal(asSignIn.status, 400);
  const bad = await agent
    .post("/api/account/two-step/reauth")
    .send({ method: "wallet", id: start.body.id, signature: "0x1234" });
  assert.equal(bad.body.error.message, "Invalid signature.");
  const other = await agent.post("/api/account/two-step/reauth").send({
    method: "wallet",
    id: start.body.id,
    signature: await Wallet.createRandom().signMessage(start.body.message),
  });
  assert.equal(
    other.body.error.message,
    "Signature does not match the wallet.",
  );
  await agent
    .post("/api/account/two-step/reauth")
    .send({
      method: "wallet",
      id: start.body.id,
      signature: await wallet.signMessage(start.body.message),
    })
    .expect(200);
  assert.equal(
    s.db
      .prepare("SELECT method FROM two_step_reauth WHERE user_id=?")
      .get(signedIn.body.user.id).method,
    "wallet",
  );
  await agent.post("/api/account/two-step/setup").send({}).expect(200);
});

test("an account with an email and a wallet but no password may use either", async (t) => {
  const s = fixture(t);
  const agent = request.agent(s.app);
  const sent = await agent
    .post("/api/auth/email/send")
    .send({ email: "zoe@example.com" })
    .expect(200);
  await agent
    .post("/api/auth/email/verify")
    .send({ id: sent.body.id, code: sent.body.testCode })
    .expect(200);
  const wallet = Wallet.createRandom();
  const ch = await agent
    .post("/api/auth/wallet/challenge")
    .send({ address: wallet.address, link: true })
    .expect(200);
  await agent
    .post("/api/auth/wallet/verify")
    .send({
      id: ch.body.id,
      signature: await wallet.signMessage(ch.body.message),
    })
    .expect(200);
  assert.deepEqual(
    (await agent.get("/api/account/two-step")).body.reauthMethods,
    ["email", "wallet"],
  );
  const start = await agent
    .post("/api/account/two-step/reauth/start")
    .send({ method: "wallet" })
    .expect(200);
  await agent
    .post("/api/account/two-step/reauth")
    .send({
      method: "wallet",
      id: start.body.id,
      signature: await wallet.signMessage(start.body.message),
    })
    .expect(200);
  await agent.post("/api/account/two-step/setup").send({}).expect(200);
});

// ---- Sign-in ----

test("password sign-in needs the code before any session exists", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const { secret } = await enable(a);
  // Accounts without two-step sign in as before.
  await account(s, "bob");
  const plain = await login(s, "bob").expect(200);
  assert.ok(plain.body.user && !plain.body.twoStep);
  // A wrong password says nothing about two-step.
  const wrongPassword = await login(s, "alice", "not-the-password");
  assert.equal(wrongPassword.status, 401);
  assert.equal(wrongPassword.body.twoStep, undefined);
  const agent = request.agent(s.app);
  const first = await agent
    .post("/api/auth/password")
    .send({ username: "alice", password: PASSWORD })
    .expect(200);
  assert.equal(first.body.user, undefined);
  assert.equal(first.body.twoStep.method, "password");
  assert.match(first.body.twoStep.token, /^twostep_[0-9a-f]{32}$/);
  assert.ok(first.body.twoStep.expires > Date.now());
  assert.equal(cookieOf(first), "", "no session cookie yet");
  assert.equal((await agent.get("/api/me")).body.user, null);
  // The pending sign-in is stored as a hash.
  assert.equal(
    count(
      s,
      "SELECT COUNT(*) n FROM two_step_pending WHERE hash=?",
      first.body.twoStep.token,
    ),
    0,
  );
  const wrong = await agent
    .post("/api/auth/two-step")
    .send({ token: first.body.twoStep.token, code: codeFor(secret, 5) });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, "two_step_invalid");
  assert.equal(cookieOf(wrong), "");
  const done = await agent
    .post("/api/auth/two-step")
    .send({ token: first.body.twoStep.token, code: codeFor(secret, 1) })
    .expect(200);
  assert.equal(done.body.user.id, id);
  assert.deepEqual(done.body.twoStep, {
    method: "totp",
    recoveryCodesLeft: RECOVERY_COUNT,
  });
  assert.match(cookieOf(done), /anonyma_session=/);
  assert.equal((await agent.get("/api/me")).body.user.id, id);
  // The token is single use.
  const reuse = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: first.body.twoStep.token, code: codeFor(secret, 1) });
  assert.equal(reuse.body.error.code, "two_step_expired");
  // API keys are separate credentials and never ask for a code.
  const key = await a.post("/api/keys").send({ name: "cli" }).expect(201);
  const v1 = await request(s.app)
    .get("/v1")
    .set("Authorization", "Bearer " + key.body.key)
    .set("Accept", "application/json");
  assert.equal(v1.body.authenticated, true);
});

test("email code sign-in and password reset both need the code", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  // Link an email inside the signed-in session: no second step.
  const link = await a
    .post("/api/auth/email/send")
    .send({ email: "alice@example.com", purpose: "link" })
    .expect(200);
  const linked = await a
    .post("/api/auth/email/verify")
    .send({ id: link.body.id, code: link.body.testCode })
    .expect(200);
  assert.equal(linked.body.user.email, "alice@example.com");
  const { secret } = await enable(a);
  // Linking an email while two-step is on still needs no second step.
  const relink = await a
    .post("/api/auth/email/send")
    .send({ email: "alice@example.com", purpose: "link" })
    .expect(200);
  const relinked = await a
    .post("/api/auth/email/verify")
    .send({ id: relink.body.id, code: relink.body.testCode })
    .expect(200);
  assert.ok(relinked.body.user && !relinked.body.twoStep);

  // Email sign-in.
  const agent = request.agent(s.app);
  const sent = await agent
    .post("/api/auth/email/send")
    .send({ email: "alice@example.com" })
    .expect(200);
  const first = await agent
    .post("/api/auth/email/verify")
    .send({ id: sent.body.id, code: sent.body.testCode })
    .expect(200);
  assert.equal(first.body.twoStep.method, "email");
  assert.equal(cookieOf(first), "");
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM challenges WHERE id=?", sent.body.id),
    0,
    "email code spent",
  );
  const done = await agent
    .post("/api/auth/two-step")
    .send({ token: first.body.twoStep.token, code: codeFor(secret, 1) })
    .expect(200);
  assert.equal(done.body.user.id, id);
  advance(t, STEP_MS);

  // Password reset: nothing changes until the code.
  const before = s.db
    .prepare("SELECT password FROM users WHERE id=?")
    .get(id).password;
  const reset = await request(s.app)
    .post("/api/auth/email/send")
    .send({ email: "alice@example.com", purpose: "recover" })
    .expect(200);
  const resetFirst = await request(s.app)
    .post("/api/auth/email/verify")
    .send({
      id: reset.body.id,
      code: reset.body.testCode,
      password: "a-brand-new-password",
    })
    .expect(200);
  assert.equal(resetFirst.body.twoStep.method, "recover");
  assert.equal(cookieOf(resetFirst), "");
  assert.equal(
    s.db.prepare("SELECT password FROM users WHERE id=?").get(id).password,
    before,
  );
  assert.ok(
    (await agent.get("/api/me")).body.user,
    "sessions untouched so far",
  );
  const pendingRow = s.db
    .prepare("SELECT payload FROM two_step_pending WHERE user_id=?")
    .get(id);
  assert.ok(
    !pendingRow.payload.includes("a-brand-new-password"),
    "only the new password's hash waits",
  );
  await login(s).expect(200); // the old password still works
  const resetAgent = request.agent(s.app);
  const finished = await resetAgent
    .post("/api/auth/two-step")
    .send({ token: resetFirst.body.twoStep.token, code: codeFor(secret, 1) })
    .expect(200);
  assert.equal(finished.body.user.id, id);
  assert.equal(
    (await agent.get("/api/me")).body.user,
    null,
    "a reset signs out every other session",
  );
  assert.equal((await resetAgent.get("/api/me")).body.user.id, id);
  const old = await login(s);
  assert.equal(old.status, 401, "old password gone");
  const fresh = await login(s, "alice", "a-brand-new-password").expect(200);
  assert.equal(fresh.body.twoStep.method, "password");
});

test("wallet sign-in takes the same second step; linking a wallet doesn't", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const { secret } = await enable(a);
  const wallet = Wallet.createRandom();
  const sign = async (agent, link) => {
    const ch = await agent
      .post("/api/auth/wallet/challenge")
      .send({ address: wallet.address, link })
      .expect(200);
    return agent
      .post("/api/auth/wallet/verify")
      .send({
        id: ch.body.id,
        signature: await wallet.signMessage(ch.body.message),
      })
      .expect(200);
  };
  const linked = await sign(a, true);
  assert.equal(linked.body.user.wallet, wallet.address.toLowerCase());
  assert.equal(linked.body.twoStep, undefined);
  const agent = request.agent(s.app);
  const first = await sign(agent, false);
  assert.equal(first.body.twoStep.method, "wallet");
  assert.equal(cookieOf(first), "");
  const done = await agent
    .post("/api/auth/two-step")
    .send({ token: first.body.twoStep.token, code: codeFor(secret, 1) })
    .expect(200);
  assert.equal(done.body.user.id, id);
  // A new wallet account has no two-step and signs straight in.
  const fresh = Wallet.createRandom();
  const agent2 = request.agent(s.app);
  const ch = await agent2
    .post("/api/auth/wallet/challenge")
    .send({ address: fresh.address })
    .expect(200);
  const r = await agent2
    .post("/api/auth/wallet/verify")
    .send({
      id: ch.body.id,
      signature: await fresh.signMessage(ch.body.message),
    })
    .expect(200);
  assert.ok(r.body.user.id && !r.body.twoStep);
});

// ---- Codes ----

test("each code works once, and the step either side is accepted", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const { secret } = await enable(a);
  const failures = () =>
    s.db.prepare("SELECT failures FROM two_step WHERE user_id=?").get(id)
      .failures;
  // enable() used the current step's code: it can't sign in.
  const first = await login(s).expect(200);
  const token = first.body.twoStep.token;
  const replay = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token, code: codeFor(secret) });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, "two_step_code_used");
  assert.match(replay.body.error.message, /already used/);
  // The previous step is older than the one used: refused too.
  const older = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token, code: codeFor(secret, -1) });
  assert.equal(older.body.error.code, "two_step_code_used");
  assert.equal(failures(), 0, "replays don't count towards the lock");
  // Two steps ahead is outside the window, and counts.
  const far = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token, code: codeFor(secret, 2) });
  assert.equal(far.body.error.code, "two_step_invalid");
  assert.equal(failures(), 1);
  // The next step is inside it, and a success clears the count.
  const { agent } = await signInWithCode(s, "alice", codeFor(secret, 1));
  assert.equal(failures(), 0);
  // That code can't turn two-step off either, nor sign in again.
  const again = await agent
    .post("/api/account/two-step/disable")
    .send({ code: codeFor(secret, 1) });
  assert.equal(again.body.error.code, "two_step_code_used");
  const second = await login(s).expect(200);
  const twice = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: second.body.twoStep.token, code: codeFor(secret, 1) });
  assert.equal(twice.body.error.code, "two_step_code_used");
  // Thirty seconds on, the step after it works.
  advance(t, STEP_MS);
  await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: second.body.twoStep.token, code: codeFor(secret, 1) })
    .expect(200);
  assert.equal(failures(), 0);
});

test("the step before the server's is accepted while nothing newer was used", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const { secret } = await enable(a);
  // As if enable() had happened long ago.
  s.db
    .prepare("UPDATE two_step SET last_step=? WHERE user_id=?")
    .run(stepAt(Date.now()) - 20, id);
  await signInWithCode(s, "alice", codeFor(secret, -1));
});

test("wrong codes lock code entry for the account; the IP is limited too", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const { secret, codes } = await enable(a);
  const tokens = [];
  const first = await login(s).expect(200);
  const wrong = codeFor(secret, 7);
  for (let i = 0; i < MAX_FAILURES - 1; i++) {
    const r = await request(s.app)
      .post("/api/auth/two-step")
      .send({ token: first.body.twoStep.token, code: wrong });
    assert.equal(r.body.error.code, "two_step_invalid", `try ${i + 1}`);
  }
  // Failures count per account, across pending sign-ins.
  const second = await login(s).expect(200);
  tokens.push(second.body.twoStep.token);
  const fifth = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: second.body.twoStep.token, code: wrong });
  assert.equal(fifth.body.error.code, "two_step_invalid");
  const row = s.db.prepare("SELECT * FROM two_step WHERE user_id=?").get(id);
  assert.ok(row.locked_until > Date.now() + 14 * 60000);
  // Locked: even the right code and a recovery code are refused.
  for (const code of [codeFor(secret, 1), codes[0]]) {
    const r = await request(s.app)
      .post("/api/auth/two-step")
      .send({ token: second.body.twoStep.token, code });
    assert.equal(r.status, 429);
    assert.equal(r.body.error.code, "two_step_locked");
    assert.match(r.body.error.message, /Try again in 15 minutes/);
    assert.ok(Number(r.headers["retry-after"]) > 800);
  }
  // The recovery code wasn't spent while locked; settings changes are locked too.
  assert.equal(
    count(
      s,
      "SELECT COUNT(*) n FROM two_step_recovery WHERE user_id=? AND used IS NULL",
      id,
    ),
    RECOVERY_COUNT,
  );
  const off = await a
    .post("/api/account/two-step/disable")
    .send({ code: codeFor(secret, 1) });
  assert.equal(off.body.error.code, "two_step_locked");
  // Once the lock passes, the right code works and the count starts over.
  s.db
    .prepare("UPDATE two_step SET locked_until=? WHERE user_id=?")
    .run(Date.now() - 1, id);
  const done = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: second.body.twoStep.token, code: codeFor(secret, 1) })
    .expect(200);
  assert.ok(done.body.user);
  assert.equal(
    s.db.prepare("SELECT failures FROM two_step WHERE user_id=?").get(id)
      .failures,
    0,
  );
  // A pending sign-in allows five wrong codes, then starts over.
  const third = await login(s).expect(200);
  for (let i = 0; i < PENDING_ATTEMPTS; i++) {
    s.db
      .prepare(
        "UPDATE two_step SET failures=0,failed_since=NULL,locked_until=NULL WHERE user_id=?",
      )
      .run(id);
    await request(s.app)
      .post("/api/auth/two-step")
      .send({ token: third.body.twoStep.token, code: wrong })
      .expect(401);
  }
  const spent = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: third.body.twoStep.token, code: codeFor(secret, 1) });
  assert.equal(spent.body.error.code, "two_step_expired");
  // Malformed input counts for nothing.
  const failuresBefore = s.db
    .prepare("SELECT failures FROM two_step WHERE user_id=?")
    .get(id).failures;
  const fourth = await login(s).expect(200);
  const junk = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: fourth.body.twoStep.token, code: "12345" });
  assert.equal(junk.body.error.code, "two_step_code_format");
  assert.equal(
    s.db
      .prepare("SELECT attempts FROM two_step_pending WHERE hash=?")
      .get(hash(fourth.body.twoStep.token)).attempts,
    0,
  );
  assert.equal(
    s.db.prepare("SELECT failures FROM two_step WHERE user_id=?").get(id)
      .failures,
    failuresBefore,
  );
});

test("the second step is rate limited per IP", async (t) => {
  const s = fixture(t);
  let limited;
  for (let i = 0; i < 21; i++) {
    const r = await request(s.app)
      .post("/api/auth/two-step")
      .send({ token: "twostep_nope", code: "123456" });
    if (r.status === 429) limited = r;
  }
  assert.ok(limited, "the 21st request in 15 minutes is refused");
  assert.equal(limited.body.error.code, "rate_limit");
});

test("recovery codes work once each and can be replaced with a fresh code", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const { secret, codes } = await enable(a);
  // Any case, spaces for dashes.
  const typed = codes[0].toUpperCase().replaceAll("-", " ");
  const { done } = await signInWithCode(s, "alice", typed);
  assert.deepEqual(done.body.twoStep, {
    method: "recovery",
    recoveryCodesLeft: RECOVERY_COUNT - 1,
  });
  const first = await login(s).expect(200);
  const reuse = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: first.body.twoStep.token, code: codes[0] });
  assert.equal(reuse.status, 401);
  assert.equal(reuse.body.error.code, "two_step_invalid");
  assert.equal(
    (await a.get("/api/account/two-step")).body.recoveryCodesLeft,
    RECOVERY_COUNT - 1,
  );
  // Replacing needs an authenticator code, not a recovery code.
  const withRecovery = await a
    .post("/api/account/two-step/recovery-codes")
    .send({ code: codes[1] });
  assert.equal(withRecovery.status, 400);
  assert.equal(withRecovery.body.error.code, "two_step_code_format");
  const noCode = await a.post("/api/account/two-step/recovery-codes").send({});
  assert.equal(noCode.body.error.code, "two_step_code_format");
  const fresh = await a
    .post("/api/account/two-step/recovery-codes")
    .send({ code: codeFor(secret, 1) })
    .expect(200);
  assert.equal(fresh.body.recoveryCodes.length, RECOVERY_COUNT);
  assert.equal(fresh.body.recoveryCodesLeft, RECOVERY_COUNT);
  assert.ok(!fresh.body.recoveryCodes.some((c) => codes.includes(c)));
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM two_step_recovery WHERE user_id=?", id),
    RECOVERY_COUNT,
  );
  // The old ones stopped working; a new one works.
  const second = await login(s).expect(200);
  const old = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: second.body.twoStep.token, code: codes[2] });
  assert.equal(old.body.error.code, "two_step_invalid");
  await request(s.app)
    .post("/api/auth/two-step")
    .send({
      token: second.body.twoStep.token,
      code: fresh.body.recoveryCodes[0],
    })
    .expect(200);
});

test("turning it off needs a code and signs out other sessions", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const { secret, codes } = await enable(a);
  const { agent: other } = await signInWithCode(s, "alice", codeFor(secret, 1));
  for (const body of [{}, { code: "" }, { code: "nope" }]) {
    const r = await a.post("/api/account/two-step/disable").send(body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  const wrong = await a
    .post("/api/account/two-step/disable")
    .send({ code: codes[0].replace(/^./, (c) => (c === "a" ? "b" : "a")) });
  assert.equal(wrong.status, 401);
  assert.equal((await a.get("/api/account/two-step")).body.enabled, true);
  // A pending sign-in dies with the setting.
  const pending = await login(s).expect(200);
  const off = await a
    .post("/api/account/two-step/disable")
    .send({ code: codes[3] })
    .expect(200);
  assert.deepEqual(off.body, {
    enabled: false,
    enabledAt: null,
    recoveryCodesLeft: 0,
    reauthMethods: ["password"],
    reauthUntil: off.body.reauthUntil,
    signedOutSessions: 1,
  });
  assert.equal((await other.get("/api/me")).body.user, null);
  assert.equal((await a.get("/api/me")).body.user.id, id);
  for (const table of ["two_step", "two_step_recovery", "two_step_pending"])
    assert.equal(
      count(s, `SELECT COUNT(*) n FROM ${table} WHERE user_id=?`, id),
      0,
      table,
    );
  const late = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: pending.body.twoStep.token, code: codes[4] });
  assert.equal(late.body.error.code, "two_step_expired");
  // Back to a plain sign-in.
  const plain = await login(s).expect(200);
  assert.ok(plain.body.user && !plain.body.twoStep);
  const again = await a
    .post("/api/account/two-step/disable")
    .send({ code: codes[5] });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, "two_step_off");
});

test("a pending sign-in expires, and dies with the account", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const { secret } = await enable(a);
  const first = await login(s).expect(200);
  s.db
    .prepare("UPDATE two_step_pending SET expires=? WHERE user_id=?")
    .run(Date.now() - 1, id);
  const r = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: first.body.twoStep.token, code: codeFor(secret, 1) });
  assert.equal(r.body.error.code, "two_step_expired");
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM two_step_pending WHERE user_id=?", id),
    0,
  );
  // The worker removes expired ones it never saw used.
  await login(s).expect(200);
  s.db
    .prepare("UPDATE two_step_pending SET expires=? WHERE user_id=?")
    .run(Date.now() - 1, id);
  await s.tick();
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM two_step_pending WHERE user_id=?", id),
    0,
  );
  // Closing the account deletes everything two-step kept.
  const waiting = await login(s).expect(200);
  await a.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  for (const table of [
    "two_step",
    "two_step_recovery",
    "two_step_pending",
    "two_step_reauth",
  ])
    assert.equal(
      count(s, `SELECT COUNT(*) n FROM ${table} WHERE user_id=?`, id),
      0,
      table,
    );
  const gone = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: waiting.body.twoStep.token, code: codeFor(secret, 1) });
  assert.equal(gone.body.error.code, "two_step_expired");
});

test("the export says only whether it's on; Panic Wipe keeps it", async (t) => {
  const s = fixture(t);
  const { a, id } = await account(s);
  const off = await a.get("/api/account/export").expect(200);
  assert.deepEqual(off.body.twoStep, { enabled: false });
  const { secret, codes } = await enable(a);
  const on = await a.get("/api/account/export").expect(200);
  assert.deepEqual(on.body.twoStep, { enabled: true });
  const text = JSON.stringify(on.body);
  assert.ok(!text.includes(secret));
  assert.ok(!codes.some((c) => text.includes(c)));
  assert.ok(
    !text.includes(s.db.prepare("SELECT secret FROM two_step").get().secret),
  );
  // Panic Wipe: the setting stays (it protects the credits that stay); a
  // sign-in waiting for its code is gone with the sessions.
  const waiting = await login(s).expect(200);
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM two_step_reauth WHERE user_id=?", id),
    1,
  );
  await a.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  // The session's confirmation goes with the sessions.
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM two_step_reauth WHERE user_id=?", id),
    0,
  );
  assert.equal(
    count(
      s,
      "SELECT COUNT(*) n FROM two_step WHERE user_id=? AND enabled=1",
      id,
    ),
    1,
  );
  assert.equal(
    count(s, "SELECT COUNT(*) n FROM two_step_recovery WHERE user_id=?", id),
    RECOVERY_COUNT,
  );
  const r = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: waiting.body.twoStep.token, code: codeFor(secret, 1) });
  assert.equal(r.body.error.code, "two_step_expired");
  const next = await login(s).expect(200);
  assert.ok(next.body.twoStep);
});

test("switching the update off again keeps asking enrolled accounts for their code", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-twostep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const live = fixture(t, { dir });
  const { a } = await account(live);
  const { secret, codes } = await enable(a);
  live.close();
  const off = fixture(t, { released: "mvp", dir });
  const first = await login(off).expect(200);
  assert.equal(first.body.twoStep.method, "password");
  assert.equal(cookieOf(first), "");
  const agent = request.agent(off.app);
  await agent
    .post("/api/auth/two-step")
    .send({ token: first.body.twoStep.token, code: codeFor(secret, 1) })
    .expect(200);
  // Recovery codes still work too.
  const next = await login(off).expect(200);
  await request(off.app)
    .post("/api/auth/two-step")
    .send({ token: next.body.twoStep.token, code: codes[0] })
    .expect(200);
  // Its settings stay hidden while it's off; the export still says it's on.
  const hidden = await agent.get("/api/account/two-step");
  assert.equal(hidden.status, 403);
  assert.deepEqual(
    (await agent.get("/api/account/export").expect(200)).body.twoStep,
    { enabled: true },
  );
  // The contract doesn't list the sign-in step while it's off.
  assert.ok(
    !Object.keys(openapiForConfig(off.cfg).paths).includes(
      "/api/auth/two-step",
    ),
  );
});

test("a changed app secret stops authenticator codes but not recovery codes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-twostep-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const first = fixture(t, { dir });
  const { a } = await account(first);
  const { secret, codes } = await enable(a);
  first.close();
  const s = fixture(t, { dir, secret: "a-different-app-secret-entirely" });
  const pending = await login(s).expect(200);
  const r = await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: pending.body.twoStep.token, code: codeFor(secret, 1) });
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, "two_step_unavailable");
  await request(s.app)
    .post("/api/auth/two-step")
    .send({ token: pending.body.twoStep.token, code: codes[0] })
    .expect(200);
});

// ---- The app ----

test("the settings page and sign-in step use the helpers and Chinese for every string", () => {
  const dict = JSON.parse(
    readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"),
  );
  const han = /\p{Script=Han}/u;
  const source = readFileSync(
    new URL("../src/TwoStep.jsx", import.meta.url),
    "utf8",
  );
  const flat = source.replace(/\s+/g, " ");
  const entry = UPDATES.find((u) => u.id === "twostep");
  // Rendered by TwoStep.jsx, as written there.
  const rendered = [
    "Two-step sign-in.",
    "After your password, email code or wallet signature, ANONYMA asks for a 6-digit code from an authenticator app. A stolen password alone can’t reach your balance.",
    "Turn on two-step sign-in",
    "Scan this QR code with your authenticator app.",
    "Or enter this key by hand",
    "Copy key",
    "Enter the 6-digit code your app shows.",
    "6-digit code",
    "Turn on",
    "Checking…",
    "Cancel",
    "Save your recovery codes.",
    "Each code signs you in once if you lose your authenticator app. They’re shown only now; ANONYMA keeps only a scrambled copy.",
    "Copy codes",
    "Download as text",
    "I’ve saved these codes",
    "Done",
    "Two-step sign-in is on.",
    "Recovery codes left",
    "On since",
    "New recovery codes",
    "Turn off",
    "Enter a current 6-digit code from your authenticator app. Your old recovery codes stop working.",
    "Make new codes",
    "Enter a current code from your authenticator app, or a recovery code.",
    "Code or recovery code",
    "Turn off two-step sign-in",
    "Turning it on or off signs out your other sessions. Turning it on asks you to confirm it’s you first.",
    "Confirm it’s you.",
    "Turning on two-step sign-in and making new recovery codes need a fresh confirmation from this session.",
    "Your password",
    "Confirm",
    "Email me a code",
    "Sign with your wallet",
    "Waiting for your wallet…",
    "Enter the code from your email. It expires after 10 minutes.",
    "Email code",
    TWO_STEP_API_NOTE,
    "Two-step sign-in is off.",
    "1 other session was signed out.",
    "New recovery codes are ready. The old ones no longer work.",
    "Sign in to a real account to turn on two-step sign-in.",
    "QR code for your authenticator app",
    "Status",
    "Loading…",
    "TWO-STEP SIGN-IN",
    "Enter the 6-digit code from your authenticator app.",
    "Enter one of your recovery codes.",
    "Recovery code",
    "Use a recovery code instead",
    "Use your authenticator app instead",
    "Verify",
    "Back to sign in",
    "Your new password applies once the code is right.",
    "Only you should see this. Anyone with this key can make your codes.",
    "Continue",
  ];
  const patterns = [
    "Local test mode: no email was sent; your code is {0}.",
    "{0} other sessions were signed out.",
    "You used a recovery code. {0} left. Make new ones in Account → Security.",
  ];
  // Server messages the page and the sign-in step show.
  const server = [
    "That code didn’t work. Enter the current 6-digit code, or an unused recovery code.",
    "That code didn’t work. Enter the current 6-digit code from your authenticator app.",
    "That code didn’t match. Check the key in your app and that your phone’s clock is set automatically.",
    "That code was already used. Wait for the next one.",
    "This sign-in expired. Sign in again.",
    "This setup expired. Start again to get a new key.",
    "Enter the 6-digit code from your authenticator app, or a recovery code.",
    "Too many incorrect codes. Try again in 1 minute.",
    "Two-step sign-in is already on.",
    "Two-step sign-in is off.",
    "Authenticator codes can't be checked on this server right now. Use a recovery code, or contact support.",
    "This setup changed. Start again.",
    "Confirm it’s you first. Turning on two-step sign-in and making new recovery codes need your password (or a fresh email code or wallet signature) from the last 10 minutes.",
    "Confirm with your password.",
    "Confirm with a code sent to your email or a signature from your linked wallet.",
    "Incorrect password.",
    "Incorrect verification code.",
    "Code expired or too many attempts.",
    "Invalid signature.",
    "Signature does not match the wallet.",
    "Wallet challenge expired.",
  ];
  // The sign-in page's heading, the Security tab and the data controls.
  const elsewhere = {
    "../src/Pages.jsx": ["One more step."],
    "../src/Account.jsx": ["Security"],
    "../src/lib.js": [
      "Sign with the wallet linked to this account.",
      "No wallet account was selected.",
    ],
    "../src/DataControls.jsx": [
      "Two-step sign-in: while it’s on, your authenticator key, sealed with the server’s app secret, and your ten recovery codes, kept only as one-way hashes. A sign-in waiting for its code lasts 5 minutes, and a session’s “confirm it’s you” 10 minutes. Your export says only whether it’s on. Turning it off or closing your account deletes the key and codes; Panic Wipe leaves it on.",
    ],
  };
  for (const [file, list] of Object.entries(elsewhere)) {
    const text = readFileSync(new URL(file, import.meta.url), "utf8").replace(
      /\s+/g,
      " ",
    );
    for (const en of list) assert.ok(text.includes(en), `${file}: ${en}`);
  }
  for (const en of [
    entry.title,
    entry.tagline,
    ...entry.points,
    ...rendered,
    ...server,
    ...Object.values(elsewhere).flat(),
  ])
    assert.match(dict.strings[en] || "", han, en);
  // The unreleased refusal comes from the shared "{0} is coming soon." pattern.
  assert.ok(dict.patterns.some((p) => p.en === "{0} is coming soon."));
  for (const en of [
    ...patterns,
    "Too many incorrect codes. Try again in {0} minutes.",
  ])
    assert.ok(
      dict.patterns.some((p) => p.en === en && han.test(p.zh)),
      en,
    );
  for (const en of rendered.filter(
    (x) => x !== TWO_STEP_API_NOTE && x !== "Security",
  ))
    assert.ok(flat.includes(en), `rendered: ${en}`);
  // The page never sends the secret anywhere but its own QR drawing.
  assert.doesNotMatch(source, /https?:\/\/(?!askanonyma)/);
  assert.match(source, /encodeQR/);
});

test("browser helpers: gate, code input, key grouping and the codes file", () => {
  assert.equal(
    twoStepReleased({ releases: { features: { twostep: true } } }),
    true,
  );
  assert.equal(twoStepReleased({ releases: { features: {} } }), false);
  assert.equal(twoStepReleased(null), false);
  assert.equal(
    formatSecret("JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"),
    "JBSW Y3DP EHPK 3PXP JBSW Y3DP EHPK 3PXP",
  );
  assert.equal(codeInput("12 34-56x7"), "123456");
  assert.equal(codeInput("abcd-EFGH", true), "abcd-EFGH");
  const text = recoveryText(
    ["aaaa-bbbb-cccc-dddd", "eeee-ffff-gggg-hhhh"],
    "alice",
  );
  assert.match(text, /ANONYMA recovery codes for alice/);
  assert.match(text, /aaaa-bbbb-cccc-dddd\neeee-ffff-gggg-hhhh/);
  assert.match(text, /once/);
});
