import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { Wallet } from "ethers";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import {
  UNLOCK_MAX_FAILURES,
  UNLOCK_LOCK_MS,
} from "../server/routes/unlock.js";
import { paletteActions } from "../src/command-palette.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  ESC_PAIR_MS,
  IDLE_CHOICES,
  coverDocument,
  createEscPair,
  idleDue,
  lockApplies,
  normalizeSettings,
  parseLock,
  privacyScreenReleased,
  revealsOnKey,
  uncoverDocument,
} from "../src/privacy-screen.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const PASSWORD = "correct-horse-battery";
function fixture(t, released = "all", extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-privacy-screen-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(app, username = "maya_lee") {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: PASSWORD })
    .expect(201);
  return { agent, user: r.body.user };
}
async function walletPerson(app) {
  const wallet = Wallet.createRandom();
  const agent = request.agent(app);
  const ch = await agent
    .post("/api/auth/wallet/challenge")
    .send({ address: wallet.address })
    .expect(200);
  const r = await agent
    .post("/api/auth/wallet/verify")
    .send({ id: ch.body.id, signature: await wallet.signMessage(ch.body.message) })
    .expect(200);
  return { agent, wallet, user: r.body.user };
}
async function emailPerson(app, email = "maya@example.com") {
  const agent = request.agent(app);
  const sent = await agent.post("/api/auth/email/send").send({ email }).expect(200);
  const r = await agent
    .post("/api/auth/email/verify")
    .send({ id: sent.body.id, code: sent.body.testCode })
    .expect(200);
  return { agent, user: r.body.user };
}
const unlock = (agent, body) => agent.post("/api/auth/unlock").send(body);
const sessions = (s, user) =>
  s.db.prepare("SELECT hash FROM sessions WHERE user_id=? ORDER BY hash").all(user).map((r) => r.hash);

// ---- The release gate ----

test("unreleased: the unlock routes are refused and no UI, link or palette entry exists", async (t) => {
  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app);
  for (const send of [
    () => a.agent.get("/api/auth/unlock"),
    () => a.agent.post("/api/auth/unlock").send({ method: "password", password: PASSWORD }),
    () => a.agent.post("/api/auth/unlock/start").send({ method: "wallet" }),
    () => a.agent.post("/API/Auth/Unlock/").send({ method: "password", password: PASSWORD }),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Privacy Screen is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(mvp.app).post("/api/auth/unlock").send({}).expect(403);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.privacyscreen, false);
  assert.equal(privacyScreenReleased(config), false);
  const entry = config.releases.updates.find((u) => u.id === "privacyscreen");
  assert.equal(entry.title, "Privacy Screen");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(closed.paths).some((p) => p.includes("/unlock")));
  // Nothing else is gated by it, and it needs nothing else.
  for (const path of ["/api/auth/password", "/api/auth/logout", "/api/me", "/api/account/two-step"])
    assert.ok(!featuresFor({ path, method: "POST", body: {} }).includes("privacyscreen"), path);
  assert.deepEqual(featuresFor({ path: "/api/auth/unlock", method: "POST", body: {} }), ["privacyscreen"]);
  assert.deepEqual(featuresFor({ path: "/api/auth/unlock/start", method: "POST", body: {} }), ["privacyscreen"]);

  const own = fixture(t, "mvp,privacyscreen");
  const b = await person(own.app);
  await unlock(b.agent, { method: "password", password: PASSWORD }).expect(200);
  const open = (await request(own.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(open.paths["/api/auth/unlock"]?.get && open.paths["/api/auth/unlock"]?.post);
  assert.ok(open.paths["/api/auth/unlock/start"]?.post);

  // The Command Palette offers it only once released, to a signed-in live
  // account (not the demo), with its shortcut.
  const cfg = (...ids) => ({ releases: { features: Object.fromEntries(ids.map((id) => [id, true])) } });
  const find = (config, extra = {}) =>
    paletteActions({ config, mode: "chat", signedIn: true, ...extra }).find((a) => a.id === "privacy-screen");
  assert.equal(find(cfg()), undefined);
  assert.equal(find(cfg("privacyscreen"), { signedIn: false }), undefined);
  assert.equal(find(cfg("privacyscreen"), { demo: true }), undefined);
  const action = find(cfg("privacyscreen"));
  assert.equal(action.label, "Hide the screen");
  assert.match(action.detail, /Esc twice/);
  assert.ok(find(cfg("privacyscreen"), { page: "account", section: "settings" }));
  // The roadmap card has its icon.
  assert.match(readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8"), /\bprivacyscreen: "eyeoff"/);
});

// PrivacyScreen.jsx compiled for Node with the same esbuild Vite uses; shared
// UI is swapped for plain stand-ins so only its own markup renders.
async function uiModule() {
  const src = new URL("../src/PrivacyScreen.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-privacy-screen-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Notice = ({ children }) => React.createElement("div", null, children);
     export const Icon = () => React.createElement("svg");
     export const Mark = () => React.createElement("span", { className: "mark" });
     export const Button = ({ children, ...p }) => React.createElement("button", p, children);`,
  );
  const out = code
    .replace(/^import "\.\/privacy-screen\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/(lib|privacy-screen)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react-dom"/g, `from "${import.meta.resolve("react-dom")}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "PrivacyScreen.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("UI gate: no Hide button, setting or cover until released; then the honest copy", async () => {
  const { HideScreenButton, PrivacyScreenSettings, PrivacyScreen } = await uiModule();
  const user = { id: "u_1", username: "maya_lee" };
  const off = { releases: { features: { vault: true } } };
  const on = { releases: { features: { vault: true, privacyscreen: true } } };
  const render = (C, props) => renderToStaticMarkup(createElement(C, props));
  for (const C of [HideScreenButton, PrivacyScreenSettings, PrivacyScreen])
    assert.equal(render(C, { config: off, user }), "", C.name);
  // Signed out: nothing either.
  assert.equal(render(HideScreenButton, { config: on, user: null }), "");
  assert.equal(render(PrivacyScreenSettings, { config: on, user: null }), "");
  const button = render(HideScreenButton, { config: on, user });
  assert.match(button, /aria-label="Hide the screen"/);
  assert.match(button, /aria-keyshortcuts="Escape Escape"/);
  assert.match(button, />Hide</);
  const settings = render(PrivacyScreenSettings, { config: on, user })
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"');
  assert.match(settings, /id="privacy-screen"/);
  assert.match(settings, /Hide when I switch away/);
  assert.match(settings, /Lock after idle/);
  for (const minutes of IDLE_CHOICES) assert.match(settings, new RegExp(`value="${minutes}"`));
  assert.match(settings, /this browser only/);
  assert.match(settings, /It isn't encryption; for chats that never leave this device, use Device Vault\./);
  assert.match(settings, /doesn’t sign you out/);
  // Without Device Vault released, the line doesn't point to it.
  const noVault = render(PrivacyScreenSettings, { config: { releases: { features: { privacyscreen: true } } }, user });
  assert.doesNotMatch(noVault, /Device Vault/);
  // Server-side there's no document: the cover renders nothing.
  assert.equal(render(PrivacyScreen, { config: on, user }), "");
});

test("every visible string has Chinese, following the glossary", async () => {
  const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const han = /\p{Script=Han}/u;
  const entry = UPDATES.find((u) => u.id === "privacyscreen");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Privacy Screen is coming soon.",
    "Hidden — press any key or tap to return",
    "PRIVACY SCREEN",
    "Locked.",
    "Locked while you were away. Your chats are still here; unlock to see them.",
    "Your password",
    "Unlock",
    "Checking…",
    "Checking how to unlock…",
    "Sign out instead",
    "Signing out…",
    "You’re signed out. Sign in again to continue.",
    "Sign in",
    "Try again",
    "Email me a code",
    "Sign with your wallet",
    "Email code",
    "The wallet signs a one-time message. It authorizes no transaction and can’t be used to sign in.",
    "Incorrect password.",
    "Incorrect verification code.",
    "Signature does not match the wallet.",
    "Too many incorrect attempts. Try again in 1 minute, or sign out instead.",
    "Too many incorrect attempts. Try again in 15 minutes, or sign out instead.",
    "This code expired. Send a new one.",
    "This wallet request expired. Try again.",
    "Unlock with your password.",
    "Unlock with a code sent to your email or a signature from your linked wallet.",
    "Hide",
    "Hide the screen",
    "Hide the screen (Esc twice)",
    "Shortcut: press Esc twice",
    "Privacy Screen.",
    "Hide when I switch away",
    "Lock after idle",
    "Off",
    "After 5 minutes",
    "After 15 minutes",
    "After 1 hour",
    "Privacy Screen hides your screen from people nearby. It isn't encryption; for chats that never leave this device, use Device Vault.",
    "Privacy Screen hides your screen from people nearby. It isn't encryption.",
    "Privacy Screen: its choices and whether the screen is locked are kept only in this browser. Unlocking checks your password (or an email code or wallet signature) on the server, which keeps nothing but a count of wrong attempts, under a one-way key, for up to 15 minutes. Hiding takes your chats off the screen, not out of this browser’s memory.",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
  assert.equal(translateText("Device Vault", zh), "本机保险库");
  assert.match(translateText("Too many incorrect attempts. Try again in 15 minutes, or sign out instead.", zh), /15 分钟/);
  // The lock screen and cover mark no user content: the username only fills
  // a hidden field for password managers.
  const src = readFileSync(new URL("../src/PrivacyScreen.jsx", import.meta.url), "utf8");
  assert.match(src, /autoComplete="username"[\s\S]{0,160}readOnly\s+hidden/);
});

// ---- The unlock check ----

test("unlock: the right password unlocks without touching the session; a wrong one is refused", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const other = await person(s.app, "ben_other");
  const before = sessions(s, a.user.id);
  assert.deepEqual((await a.agent.get("/api/auth/unlock").expect(200)).body, { methods: ["password"], retryAfter: null });
  const ok = await unlock(a.agent, { method: "password", password: PASSWORD }).expect(200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.headers["set-cookie"], undefined, "no new cookie");
  assert.deepEqual(sessions(s, a.user.id), before, "no session created, rotated or ended");
  const wrong = await unlock(a.agent, { method: "password", password: "not-the-password" }).expect(401);
  assert.equal(wrong.body.error.code, "unlock_failed");
  assert.equal(wrong.body.error.message, "Incorrect password.");
  // A wrong password never signs anyone out.
  assert.equal((await a.agent.get("/api/me").expect(200)).body.user.id, a.user.id);
  assert.deepEqual(sessions(s, a.user.id), before);
  // Malformed and signed-out requests.
  assert.equal((await unlock(a.agent, { method: "password" }).expect(400)).body.error.code, "unlock_password_required");
  assert.equal((await unlock(a.agent, { method: "password", password: "x".repeat(257) }).expect(400)).body.error.code, "unlock_password_required");
  assert.equal((await unlock(a.agent, { method: "magic" }).expect(400)).body.error.code, "unlock_method");
  assert.equal((await unlock(request(s.app), { method: "password", password: PASSWORD }).expect(401)).body.error.code, "authentication_required");
  // A password account unlocks with its password only.
  for (const method of ["email", "wallet"]) {
    assert.equal((await a.agent.post("/api/auth/unlock/start").send({ method }).expect(400)).body.error.code, "unlock_method");
    assert.equal((await unlock(a.agent, { method, id: "x", code: "123456" }).expect(400)).body.error.code, "unlock_method");
  }
  // Another account's password is just wrong.
  await unlock(other.agent, { method: "password", password: "nope-nope-nope" }).expect(401);
});

test("unlock: five wrong attempts pause unlocking for 15 minutes; signing out still works", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const b = await person(s.app, "ben_other");
  for (let i = 1; i < UNLOCK_MAX_FAILURES; i++)
    assert.equal((await unlock(a.agent, { method: "password", password: "wrong-" + i }).expect(401)).body.error.code, "unlock_failed");
  // The fifth starts the lock at once.
  const fifth = await unlock(a.agent, { method: "password", password: "wrong-5" }).expect(429);
  assert.equal(fifth.body.error.code, "unlock_locked");
  assert.equal(fifth.body.error.message, "Too many incorrect attempts. Try again in 15 minutes, or sign out instead.");
  assert.ok(Number(fifth.headers["retry-after"]) > 14 * 60);
  // Even the right password waits, and the status says for how long.
  const right = await unlock(a.agent, { method: "password", password: PASSWORD }).expect(429);
  assert.equal(right.body.error.code, "unlock_locked");
  const status = (await a.agent.get("/api/auth/unlock").expect(200)).body;
  assert.ok(status.retryAfter > 14 * 60 && status.retryAfter <= UNLOCK_LOCK_MS / 1000);
  // Per account: another account isn't affected. The session still works.
  await unlock(b.agent, { method: "password", password: PASSWORD }).expect(200);
  assert.equal((await a.agent.get("/api/me").expect(200)).body.user.id, a.user.id);
  // The count is kept like a rate limit: a hashed key, never the account id.
  const rows = s.db.prepare("SELECT key,count,expires FROM rate_limits WHERE key LIKE '%:unlock_fail:%'").all();
  assert.equal(rows.length, 1);
  assert.ok(!rows[0].key.includes(a.user.id));
  assert.ok(rows[0].key.endsWith(createHash("sha256").update(a.user.id).digest("hex")));
  // Once the lock has run out, the right password works and clears the count.
  s.db.prepare("UPDATE rate_limits SET expires=? WHERE key=?").run(Date.now() - 1, rows[0].key);
  await unlock(a.agent, { method: "password", password: PASSWORD }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM rate_limits WHERE key=?").get(rows[0].key).n, 0);
  // Signing out is never blocked by the lock.
  for (let i = 0; i < UNLOCK_MAX_FAILURES; i++) await unlock(a.agent, { method: "password", password: "wrong" });
  await a.agent.post("/api/auth/logout").send({}).expect(200);
  assert.equal((await a.agent.get("/api/me").expect(200)).body.user, null);
});

test("unlock: a wallet-only account signs a one-time message bound to this session", async (t) => {
  const s = fixture(t);
  const w = await walletPerson(s.app);
  assert.deepEqual((await w.agent.get("/api/auth/unlock").expect(200)).body.methods, ["wallet"]);
  assert.equal((await unlock(w.agent, { method: "password", password: PASSWORD }).expect(400)).body.error.code, "unlock_method");
  const start = await w.agent.post("/api/auth/unlock/start").send({ method: "wallet" }).expect(200);
  assert.ok(start.body.message.includes(w.wallet.address));
  assert.match(start.body.message, /This does not authorize a blockchain transaction and can't be used to sign in\./);
  const signature = await w.wallet.signMessage(start.body.message);
  // It can't sign in anywhere.
  assert.equal((await request(s.app).post("/api/auth/wallet/verify").send({ id: start.body.id, signature })).status, 400);
  // Another session of the same account can't use it.
  const second = request.agent(s.app);
  const ch = await second.post("/api/auth/wallet/challenge").send({ address: w.wallet.address }).expect(200);
  await second.post("/api/auth/wallet/verify").send({ id: ch.body.id, signature: await w.wallet.signMessage(ch.body.message) }).expect(200);
  assert.equal((await unlock(second, { method: "wallet", id: start.body.id, signature }).expect(400)).body.error.code, "unlock_expired");
  // Another wallet's signature is wrong and counts.
  const stranger = Wallet.createRandom();
  const bad = await unlock(w.agent, { method: "wallet", id: start.body.id, signature: await stranger.signMessage(start.body.message) }).expect(401);
  assert.equal(bad.body.error.code, "unlock_failed");
  assert.equal(bad.body.error.message, "Signature does not match the wallet.");
  assert.equal((await unlock(w.agent, { method: "wallet", id: start.body.id, signature: "0x1234" }).expect(401)).body.error.code, "unlock_failed");
  const before = sessions(s, w.user.id);
  await unlock(w.agent, { method: "wallet", id: start.body.id, signature }).expect(200);
  assert.deepEqual(sessions(s, w.user.id), before);
  // Single use.
  assert.equal((await unlock(w.agent, { method: "wallet", id: start.body.id, signature }).expect(400)).body.error.code, "unlock_expired");
  // Expired messages are refused.
  const late = await w.agent.post("/api/auth/unlock/start").send({ method: "wallet" }).expect(200);
  s.db.prepare("UPDATE challenges SET expires=? WHERE id=?").run(Date.now() - 1, late.body.id);
  assert.equal((await unlock(w.agent, { method: "wallet", id: late.body.id, signature: await w.wallet.signMessage(late.body.message) }).expect(400)).body.error.code, "unlock_expired");
});

test("unlock: an email-only account gets a code; wipe and closure leave nothing behind", async (t) => {
  const s = fixture(t);
  const e = await emailPerson(s.app);
  assert.deepEqual((await e.agent.get("/api/auth/unlock").expect(200)).body.methods, ["email"]);
  assert.equal((await e.agent.post("/api/auth/unlock/start").send({ method: "wallet" }).expect(400)).body.error.code, "unlock_method");
  const sent = await e.agent.post("/api/auth/unlock/start").send({ method: "email" }).expect(200);
  assert.match(sent.body.testCode, /^\d{6}$/);
  const wrongCode = sent.body.testCode === "000000" ? "111111" : "000000";
  assert.equal((await unlock(e.agent, { method: "email", id: sent.body.id, code: wrongCode }).expect(401)).body.error.code, "unlock_failed");
  await unlock(e.agent, { method: "email", id: sent.body.id, code: sent.body.testCode }).expect(200);
  assert.equal((await unlock(e.agent, { method: "email", id: sent.body.id, code: sent.body.testCode }).expect(400)).body.error.code, "unlock_expired");

  // Nothing about the Privacy Screen is part of the account: not in the
  // export, and a pending code or message goes with Panic Wipe or closure.
  const exported = (await e.agent.get("/api/account/export").expect(200)).body;
  assert.doesNotMatch(JSON.stringify(exported), /unlock|privacy.?screen/i);
  await e.agent.post("/api/auth/unlock/start").send({ method: "email" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM challenges WHERE purpose='unlock'").get().n, 1);
  await e.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM challenges WHERE purpose='unlock'").get().n, 0);
  const w = await walletPerson(s.app);
  await w.agent.post("/api/auth/unlock/start").send({ method: "wallet" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM challenges WHERE purpose='unlock_wallet'").get().n, 1);
  await w.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM challenges WHERE purpose='unlock_wallet'").get().n, 0);
});

test("unlock: the server never logs a password, code or signature", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const lines = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...args) => lines.push(args.join(" "));
  try {
    await unlock(a.agent, { method: "password", password: "secret-attempt-9431" });
    await unlock(a.agent, { method: "password", password: PASSWORD });
  } finally {
    Object.assign(console, orig);
  }
  assert.ok(!lines.some((l) => l.includes("secret-attempt-9431") || l.includes(PASSWORD)));
  const code = readFileSync(new URL("../server/routes/unlock.js", import.meta.url), "utf8");
  assert.doesNotMatch(code, /console\./);
});

// ---- The browser logic ----

test("Esc twice within 400 ms, and nothing else, hides", () => {
  const esc = (extra = {}) => ({ key: "Escape", ...extra });
  let pair = createEscPair();
  assert.equal(pair(esc(), 1000), false);
  assert.equal(pair(esc(), 1000 + ESC_PAIR_MS), true, "the second within the window");
  assert.equal(pair(esc(), 1000 + ESC_PAIR_MS + 50), false, "a third starts over");
  pair = createEscPair();
  pair(esc(), 0);
  assert.equal(pair(esc(), ESC_PAIR_MS + 1), false, "too slow");
  assert.equal(pair(esc(), ESC_PAIR_MS + 200), true, "…but it counts as a new first press");
  pair = createEscPair();
  pair(esc(), 0);
  assert.equal(pair({ key: "a" }, 50), false);
  assert.equal(pair(esc(), 100), false, "another key in between breaks the pair");
  pair = createEscPair();
  pair(esc(), 0);
  pair({ key: "Shift" }, 50);
  assert.equal(pair(esc(), 100), true, "a lone modifier doesn't");
  for (const extra of [{ repeat: true }, { isComposing: true }, { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }]) {
    pair = createEscPair();
    pair(esc(), 0);
    assert.equal(pair(esc(extra), 100), false, JSON.stringify(extra));
  }
  // Holding Esc down never hides.
  pair = createEscPair();
  assert.equal([0, 30, 60, 90].map((at, i) => pair(esc({ repeat: i > 0 }), at)).some(Boolean), false);
});

test("any key returns, except lone modifiers and switching shortcuts", () => {
  for (const key of ["a", "Enter", " ", "Escape", "Tab", "ArrowDown", "F5"])
    assert.equal(revealsOnKey({ key }), true, key);
  assert.equal(revealsOnKey({ key: "A", shiftKey: true }), true);
  for (const key of ["Shift", "Control", "Alt", "Meta", "CapsLock", "Fn", "Process"])
    assert.equal(revealsOnKey({ key }), false, key);
  for (const extra of [{ metaKey: true }, { ctrlKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }])
    assert.equal(revealsOnKey({ key: "Tab", ...extra }), false, JSON.stringify(extra));
});

test("idle timer, settings and the kept lock", () => {
  const min = 60000;
  assert.equal(idleDue(0, 0, 999 * min), false, "off never locks");
  assert.equal(idleDue(0, 5, 5 * min - 1), false);
  assert.equal(idleDue(0, 5, 5 * min), true);
  assert.equal(idleDue(10 * min, 15, 24 * min), false);
  assert.equal(idleDue(10 * min, 15, 25 * min), true);
  assert.equal(idleDue(NaN, 5, 99 * min), false);
  assert.deepEqual(IDLE_CHOICES, [0, 5, 15, 60]);
  assert.deepEqual(normalizeSettings(null), { blur: false, idle: 0 });
  assert.deepEqual(normalizeSettings({ blur: true, idle: "15" }), { blur: true, idle: 15 });
  assert.deepEqual(normalizeSettings({ blur: "yes", idle: 7 }), { blur: false, idle: 0 });
  assert.deepEqual(parseLock('{"user":"u_1","at":5}'), { user: "u_1", at: 5 });
  assert.deepEqual(parseLock('{"signedOut":true,"user":"u_1"}'), { signedOut: true });
  for (const raw of [null, "", "nope", "[]", '{"user":""}', '{"at":1}']) assert.equal(parseLock(raw), null, String(raw));
  assert.equal(lockApplies({ user: "u_1" }, "u_1"), true);
  assert.equal(lockApplies({ user: "u_1" }, "u_2"), false, "another account's lock");
  assert.equal(lockApplies({ user: "u_1" }, null), false);
  assert.equal(lockApplies({ signedOut: true }, "u_1"), false);
  assert.equal(lockApplies(null, "u_1"), false);
});

// A tiny DOM, enough for the cover's detach and restore.
function fakeDocument() {
  class Node {
    constructor(tagName, props = {}) {
      Object.assign(this, { tagName, children: [], parentNode: null, scrollTop: 0, scrollLeft: 0, scrollHeight: 0, clientHeight: 0, attrs: new Set(), ...props });
    }
    get isConnected() {
      let n = this;
      while (n.parentNode) n = n.parentNode;
      return n === doc.documentElement;
    }
    appendChild(c) {
      c.parentNode?.removeChild(c);
      this.children.push(c);
      c.parentNode = this;
      return c;
    }
    removeChild(c) {
      this.children.splice(this.children.indexOf(c), 1);
      c.parentNode = null;
      return c;
    }
    replaceChild(n, o) {
      const i = this.children.indexOf(o);
      n.parentNode?.removeChild(n);
      this.children[i] = n;
      n.parentNode = this;
      o.parentNode = null;
      return o;
    }
    querySelectorAll() {
      const out = [];
      const walk = (n) => n.children.forEach((c) => (out.push(c), walk(c)));
      walk(this);
      return out;
    }
    get text() {
      return (this.textContent || "") + this.children.map((c) => c.text).join("");
    }
    hasAttribute(a) {
      return this.attrs.has(a);
    }
    removeAttribute(a) {
      this.attrs.delete(a);
    }
    setAttribute(a) {
      this.attrs.add(a);
    }
  }
  const doc = { documentElement: new Node("HTML") };
  doc.body = doc.documentElement.appendChild(new Node("BODY"));
  doc.createComment = () => new Node("#comment");
  doc.defaultView = { scrollX: 0, scrollY: 640, scrollTo(x, y) { this.to = [x, y]; } };
  return { doc, Node };
}

test("the cover takes the app out of the document and puts it back exactly", () => {
  const { doc, Node } = fakeDocument();
  const root = doc.body.appendChild(new Node("DIV", { id: "root" }));
  const script = doc.body.appendChild(new Node("SCRIPT"));
  const print = doc.body.appendChild(new Node("DIV", { className: "chat-print-root", textContent: "Printed chat: Northwind" }));
  const pane = root.appendChild(new Node("DIV", { scrollTop: 300, clientHeight: 500, scrollHeight: 2000 }));
  const followed = root.appendChild(new Node("DIV", { scrollTop: 1500, clientHeight: 500, scrollHeight: 2000 }));
  pane.appendChild(new Node("P", { textContent: "Resignation letter to Dana, Northwind offer" }));
  const composer = root.appendChild(new Node("TEXTAREA", { focus() { this.focused = true; } }));
  const dialog = root.appendChild(new Node("DIALOG", { open: true, matches: (q) => q === ":modal", showModal() { this.modal = true; this.attrs.add("open"); } }));
  dialog.attrs.add("open");
  doc.activeElement = composer;
  const layer = new Node("DIV", { className: "privacy-layer", textContent: "Hidden — press any key or tap to return" });

  const saved = coverDocument(doc, layer);
  assert.deepEqual(doc.body.children.map((c) => c.tagName), ["#comment", "SCRIPT", "#comment", "DIV"]);
  assert.equal(doc.body.children[3], layer);
  assert.ok(!doc.body.text.includes("Northwind"), "no chat text left in the document");
  assert.equal(root.isConnected, false);
  assert.equal(print.isConnected, false, "the print view goes too");
  assert.equal(script.parentNode, doc.body, "scripts stay");
  // Meanwhile the app keeps working on its detached tree.
  followed.scrollHeight = 2600;
  pane.appendChild(new Node("P", { textContent: "More reply text" }));

  uncoverDocument(doc, layer, saved);
  assert.deepEqual(doc.body.children, [root, script, print]);
  assert.equal(layer.parentNode, null);
  assert.equal(pane.scrollTop, 300, "a pane keeps its place");
  assert.equal(followed.scrollTop, 2600, "a pane at its end follows what arrived");
  assert.deepEqual(doc.defaultView.to, [0, 640]);
  assert.equal(composer.focused, true, "focus goes back");
  assert.equal(dialog.modal, true, "a modal dialog is modal again");
  assert.ok(doc.body.text.includes("More reply text"));
});

// ---- Headless Chrome: the real page ----

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
  const profile = mkdtempSync(join(tmpdir(), "anonyma-privacy-screen-chrome-"));
  const proc = spawn(CHROME, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
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
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((x) => x.type === "page");
    } catch {}
    if (!target) await sleep(100);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  t.after(() => ws.close());
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const run = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const until = async (expression, timeout = 20000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      try {
        if (await run(expression)) return;
      } catch {}
      await sleep(100);
    }
    throw new Error("timed out: " + expression);
  };
  const key = async (k, code, vk, text) => {
    await send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, ...(text ? { text } : {}) });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk });
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return { send, run, until, key };
}

test(
  "headless: hidden and locked screens hold no chat text in the DOM; a reply keeps streaming",
  { skip: !CHROME ? "Chrome isn't installed" : !BUILT ? "run npm run build first" : false, timeout: 120000 },
  async (t) => {
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const s = fixture(t, "all", { origin });
    const server = s.app.listen(port, "127.0.0.1");
    t.after(() => server.close());
    const reg = await request(s.app).post("/api/auth/register").send({ username: "maya_lee", password: PASSWORD }).expect(201);
    const cookie = reg.headers["set-cookie"][0].split(";")[0].split("=")[1];
    const user = reg.body.user.id;
    const conversation = "c_" + randomUUID().replaceAll("-", "");
    const secret = "Northwind offer, last day October 17";
    s.db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)").run(conversation, user, "Resignation letter to Dana", "chat", Date.now(), Date.now());
    s.db.prepare("INSERT INTO messages(id,conversation_id,role,content,model,cost,created) VALUES(?,?,?,?,?,?,?)").run("m_" + randomUUID().replaceAll("-", ""), conversation, "user", JSON.stringify("Draft my resignation: " + secret), null, 0, Date.now());

    const b = await chrome(t);
    await b.send("Network.enable");
    await b.send("Network.setCookie", { name: "anonyma_session", value: cookie, domain: "127.0.0.1", path: "/", httpOnly: true });
    await b.send("Page.navigate", { url: origin + "/workspace/chat" });
    const openChat = async () => {
      await b.until(`[...document.querySelectorAll(".conversation-list button")].some((x) => x.textContent.includes("Resignation letter"))`);
      await b.run(`[...document.querySelectorAll(".conversation-list button")].find((x) => x.textContent.includes("Resignation letter")).click()`);
      await b.until(`document.body.innerText.includes(${JSON.stringify(secret)})`);
    };
    await openChat();
    await b.until(`!!document.querySelector(".privacy-hide-button")`);
    const inDom = (text) => b.run(`document.documentElement.outerHTML.includes(${JSON.stringify(text)})`);

    // Esc twice: the app leaves the document; the cover is all there is.
    await b.key("Escape", "Escape", 27);
    await sleep(100);
    await b.key("Escape", "Escape", 27);
    await b.until(`!!document.querySelector("body > .privacy-layer .privacy-cover")`, 5000);
    assert.equal(await b.run(`!!document.getElementById("root")`), false);
    assert.equal(await inDom(secret), false, "no chat text in the DOM while hidden");
    assert.equal(await inDom("Resignation letter"), false, "not even the title");
    await sleep(700);
    await b.key("a", "KeyA", 65, "a");
    await b.until(`!!document.getElementById("root")`, 5000);
    assert.equal(await inDom(secret), true, "back on any key");
    assert.equal(await b.run(`!!document.querySelector(".privacy-layer")?.isConnected`), false);

    // A reply streaming while hidden keeps arriving and is there on return.
    await b.run(`document.querySelector(".new-conversation").click()`);
    await b.until(`!!document.querySelector("form.composer textarea")`);
    await b.run(`document.querySelector("form.composer textarea").focus()`);
    await b.send("Input.insertText", { text: "Plan the handover. " + "List each open item with its owner. ".repeat(50) });
    await b.key("Enter", "Enter", 13, "\r");
    await b.until(`document.body.innerText.includes("Local test provider")`);
    await b.run(`(window.__root = document.getElementById("root"), true)`);
    await b.key("Escape", "Escape", 27);
    await sleep(100);
    await b.key("Escape", "Escape", 27);
    await b.until(`!document.getElementById("root")`, 5000);
    const before = await b.run(`window.__root.textContent.length`);
    assert.equal(await inDom("Local test provider"), false);
    await b.until(`window.__root.textContent.includes("Configure your gateway key")`, 20000);
    assert.ok((await b.run(`window.__root.textContent.length`)) > before, "the reply kept streaming");
    await sleep(700);
    await b.key("x", "KeyX", 88, "x");
    await b.until(`document.body.innerText.includes("Configure your gateway key")`, 5000);

    // Lock after idle (5 minutes, with the page's clock moved on): the lock
    // screen holds no chat text, survives a reload, and the password opens it
    // without a new session.
    await b.run(`(localStorage.setItem("anonyma:privacy-screen", JSON.stringify({ idle: 5 })), true)`);
    await b.send("Page.navigate", { url: origin + "/workspace/chat" });
    await openChat();
    await b.run(`(() => { const real = Date.now; Date.now = () => real() + 6 * 60000; return true; })()`);
    await b.until(`!!document.querySelector(".privacy-lock input[type=password]")`, 15000);
    assert.equal(await inDom(secret), false, "no chat text in the DOM while locked");
    await b.send("Page.navigate", { url: origin + "/workspace/chat" });
    await b.until(`!!document.querySelector(".privacy-lock input[type=password]")`, 15000);
    await sleep(500);
    assert.equal(await inDom(secret), false, "still locked after a reload");
    const sessionsBefore = sessions(s, user);
    await b.run(`document.querySelector(".privacy-lock input[type=password]").focus()`);
    await b.send("Input.insertText", { text: PASSWORD });
    await b.key("Enter", "Enter", 13, "\r");
    await b.until(`!!document.getElementById("root") && !document.querySelector(".privacy-layer")?.isConnected`, 10000);
    assert.equal(await b.run(`localStorage.getItem("anonyma:privacy-screen-lock")`), null);
    assert.deepEqual(sessions(s, user), sessionsBefore, "same session");
  },
);
