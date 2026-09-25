import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapi } from "../server/openapi.js";
import { guardedTexts } from "../server/seed-guard.js";
import { BIP39_ENGLISH } from "../src/bip39-english.js";
import {
  findSeedPhrase,
  findPrivateKey,
  findHexKey,
  scanSecrets,
  sha256,
  isSoft,
  SEED_MESSAGE,
  KEY_MESSAGE,
  HEX_MESSAGE,
} from "../src/seed-guard.js";
import { buildChatRequest } from "../src/estimate.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";

// Published BIP39 test vectors (valid checksums).
const ABANDON_12 =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const LEGAL_12 =
  "legal winner thank year wave sausage worth useful legal winner thank yellow";
const ABANDON_24 = Array(23).fill("abandon").join(" ") + " art";
const LETTER_24 =
  "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless";
const ZOO_18 = Array(17).fill("zoo").join(" ") + " when";

// Keys are derived here rather than written out, so the file holds no
// key-shaped literal. None of them has ever held funds.
const HEX_KEY = createHash("sha256").update("seed guard fixture").digest("hex");
const sha = (b) => createHash("sha256").update(b).digest();
function base58check(payload) {
  const bytes = Buffer.concat([payload, sha(sha(payload)).subarray(0, 4)]);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = BigInt("0x" + bytes.toString("hex")),
    out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = "1" + out;
  }
  return out;
}
const keyBytes = Buffer.from(HEX_KEY, "hex");
const WIF_COMPRESSED = base58check(Buffer.concat([Buffer.from([0x80]), keyBytes, Buffer.from([1])]));
const WIF_UNCOMPRESSED = base58check(Buffer.concat([Buffer.from([0x80]), keyBytes]));
const XPRV = base58check(
  Buffer.concat([
    Buffer.from("0488ade4", "hex"),
    Buffer.alloc(9),
    sha(Buffer.from("chain code")),
    Buffer.from([0]),
    keyBytes,
  ]),
);

test("the wordlist is the official BIP39 English list, and SHA-256 matches node:crypto", () => {
  assert.equal(BIP39_ENGLISH.length, 2048);
  assert.equal(new Set(BIP39_ENGLISH).size, 2048);
  assert.equal(
    createHash("sha256").update(BIP39_ENGLISH.join("\n") + "\n").digest("hex"),
    "2f5eed53a4727b4bf8880d8f3f199efc90e58503646d9ff8eff3a2ed3b24dbda",
  );
  for (const n of [0, 1, 55, 56, 63, 64, 65, 200]) {
    const input = Buffer.alloc(n, n % 251);
    assert.equal(Buffer.from(sha256(new Uint8Array(input))).toString("hex"), sha(input).toString("hex"));
  }
});

test("valid 12- and 24-word seed phrases are caught, plain, numbered or comma-separated", () => {
  for (const m of [ABANDON_12, LEGAL_12])
    assert.deepEqual(findSeedPhrase(m), { kind: "seed", words: 12 });
  for (const m of [ABANDON_24, LETTER_24])
    assert.deepEqual(findSeedPhrase(m), { kind: "seed", words: 24 });
  assert.deepEqual(findSeedPhrase(ZOO_18), { kind: "seed", words: 18 });
  const words = LEGAL_12.split(" ");
  const forms = [
    words.map((w, i) => `${i + 1}. ${w}`).join("\n"),
    words.map((w, i) => `${i + 1}) ${w}`).join(" "),
    words.join(", "),
    words.join(",\n"),
    JSON.stringify(words),
    words.map((w) => w.toUpperCase()).join(" "),
    `Here is my wallet backup, please keep it safe:\n\n${LETTER_24.split(" ").map((w, i) => `${i + 1}. ${w}`).join("\n")}\n\nThanks!`,
  ];
  for (const form of forms) assert.ok(findSeedPhrase(form), form);
  // In any of the places text is scanned: the finding names only the kind.
  assert.deepEqual(scanSecrets("hello", ["", ABANDON_12]), { kind: "seed", words: 12 });
  assert.doesNotMatch(JSON.stringify(scanSecrets(LEGAL_12)), /legal|winner/);
});

test("a wrong checksum, a word off the list or a short run is not caught", () => {
  // The last word changed: every word is on the list, the checksum fails.
  assert.equal(findSeedPhrase(LEGAL_12.replace(/yellow$/, "year")), null);
  assert.equal(findSeedPhrase(Array(12).fill("abandon").join(" ")), null);
  // One word that isn't on the list breaks the run.
  assert.equal(findSeedPhrase(ABANDON_12.replace("about", "aboot")), null);
  assert.equal(findSeedPhrase(LEGAL_12.replace("sausage", "sausages")), null);
  // Eleven words, or sentences that end between the words.
  assert.equal(findSeedPhrase(LEGAL_12.split(" ").slice(0, 11).join(" ")), null);
  assert.equal(
    findSeedPhrase("legal winner thank year. wave sausage worth useful. legal winner thank yellow"),
    null,
  );
});

test("ordinary English prose with a few BIP39 words is not caught", () => {
  const prose = [
    "I want to buy a house near the ocean. The market is really good this year, and my family agrees it is a good time to move.",
    "Please review the attached budget and let me know which items we can cut before the meeting on Friday.",
    "Every morning the old fisherman walked down to the harbor, checked the weather, and decided whether the boat would leave.",
    "The garden needs water, the fence needs paint, and the kitchen still smells of the soup we made last night.",
  ];
  for (const p of prose) assert.equal(scanSecrets(p), null, p);
  // A long document of such prose, as an attachment would be.
  assert.equal(scanSecrets(prose.join("\n\n").repeat(200)), null);
});

test("WIF and xprv keys are hard blocks with Veil off; seed phrases outrank them", () => {
  // What Send posts with Veil off still carries the raw key: Seed Guard reads it.
  const { request: sent } = buildChatRequest({ text: "Import " + WIF_COMPRESSED, veilWith: null });
  assert.ok(sent.at(-1).content.includes(WIF_COMPRESSED));
  assert.deepEqual(scanSecrets(sent.map((m) => m.content)), { kind: "key" });
  for (const text of [WIF_COMPRESSED, WIF_UNCOMPRESSED, "import this: " + XPRV])
    assert.deepEqual(findPrivateKey(text), { kind: "key" }, text);
  assert.equal(isSoft({ kind: "key" }), false);
  assert.equal(isSoft(findSeedPhrase(ABANDON_12)), false);
  // The most serious find is named: seed phrase, then WIF/xprv, then 64-hex.
  assert.deepEqual(scanSecrets("0x" + HEX_KEY, WIF_COMPRESSED, ABANDON_12), { kind: "seed", words: 12 });
  assert.deepEqual(scanSecrets("0x" + HEX_KEY, XPRV), { kind: "key" });
  // A broken checksum is not a key.
  assert.equal(
    findPrivateKey(WIF_COMPRESSED.slice(0, -1) + (WIF_COMPRESSED.endsWith("2") ? "3" : "2")),
    null,
  );
  assert.equal(findPrivateKey("0x" + HEX_KEY), null, "64-hex is never a hard block");
  assert.equal(SEED_MESSAGE, "This looks like a wallet seed phrase. ANONYMA won't send it. Remove it to continue.");
  assert.equal(KEY_MESSAGE, "This looks like a wallet private key. ANONYMA won't send it. Remove it to continue.");
});

test("bare 64-hex, with or without 0x, is a soft notice: a key or a transaction hash", () => {
  const { request: sent } = buildChatRequest({ text: "Can you look up 0x" + HEX_KEY + "?", veilWith: null });
  assert.deepEqual(scanSecrets(sent.map((m) => m.content)), { kind: "hex" });
  for (const text of [
    HEX_KEY,
    "0x" + HEX_KEY,
    "My private key is 0x" + HEX_KEY + ", keep it.",
    `accounts: ["0x${HEX_KEY}"]`,
    "Why did 0x" + HEX_KEY + " revert?",
  ])
    assert.deepEqual(findHexKey(text), { kind: "hex" }, text);
  assert.equal(isSoft({ kind: "hex" }), true);
  assert.equal(HEX_MESSAGE, "This looks like a private key or a transaction hash. If it's a private key, remove it.");
  // Labelled hashes, links and impossible keys aren't flagged at all.
  for (const text of [
    "https://etherscan.io/tx/0x" + HEX_KEY,
    "txHash: 0x" + HEX_KEY,
    "What happened in tx 0x" + HEX_KEY + "?",
    "sha256:" + HEX_KEY,
    "0x" + "0".repeat(63) + "1",
    "f".repeat(64),
    HEX_KEY + "ab",
  ])
    assert.equal(scanSecrets(text), null, text);
});

test("the server reads the newest user message and the instructions, not earlier turns", () => {
  const body = {
    messages: [
      { role: "system", content: "Be brief." },
      { role: "user", content: ABANDON_12 },
      { role: "assistant", content: LEGAL_12 },
      { role: "user", content: [{ type: "text", text: "and now?" }] },
    ],
  };
  assert.deepEqual(guardedTexts(body), ["Be brief.", "and now?"]);
  assert.deepEqual(guardedTexts({ prompt: "a", input: "b" }), ["a", "b"]);
  assert.deepEqual(guardedTexts(null), []);
});

// --- Server ----------------------------------------------------------------
function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-seed-guard-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: released ?? "all",
    mvpModels: [MODEL],
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function signedIn(svc, name = "seeder") {
  const agent = request.agent(svc.app);
  await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor}`)
    .send({ username: name, password: "test-password-long" })
    .expect(201);
  return agent;
}
const chat = (content, extra = {}) => ({
  model: MODEL,
  messages: [{ role: "user", content }],
  max_tokens: 50,
  ...extra,
});
// Nothing about a refusal may be written to the console.
function quietly(fn) {
  const lines = [];
  const saved = ["log", "info", "warn", "error"].map((k) => [k, console[k]]);
  for (const [k] of saved) console[k] = (...a) => lines.push(a.join(" "));
  return fn().finally(() => {
    for (const [k, f] of saved) console[k] = f;
    assert.deepEqual(lines, [], "nothing logged");
  });
}

test("the server refuses a seed phrase with seed_phrase_blocked and accepts the override", async (t) => {
  const svc = fixture(t);
  const agent = await signedIn(svc);
  const conversations = () => svc.db.prepare("SELECT COUNT(*) n FROM conversations").get().n;
  const holds = () => svc.db.prepare("SELECT COUNT(*) n FROM holds").get().n;
  const before = [conversations(), holds()];
  await quietly(async () => {
    for (const content of [ABANDON_12, `1. ${LEGAL_12.split(" ").join("\n2. ")}`, LETTER_24]) {
      const r = await agent.post("/api/chat").send(chat(content)).expect(400);
      assert.equal(r.body.error.code, "seed_phrase_blocked");
      assert.equal(r.body.error.message, SEED_MESSAGE);
      assert.doesNotMatch(JSON.stringify(r.body), /abandon|legal|letter/);
    }
    // In standing instructions too; and never masked or saved on the way.
    const r = await agent
      .post("/api/chat")
      .send({ ...chat("Hi"), messages: [{ role: "system", content: LEGAL_12 }, { role: "user", content: "Hi" }] })
      .expect(400);
    assert.equal(r.body.error.code, "seed_phrase_blocked");
  });
  assert.deepEqual([conversations(), holds()], before, "nothing stored or held");
  // Earlier turns and model output aren't read again.
  await agent
    .post("/api/chat")
    .send({
      ...chat("Thanks"),
      messages: [
        { role: "user", content: ABANDON_12 },
        { role: "assistant", content: LEGAL_12 },
        { role: "user", content: "Thanks" },
      ],
    })
    .expect(200);
  // The server refuses seed phrases only: a transaction hash (64-hex) and
  // keys go through without any flag (the browser asks first).
  await agent.post("/api/chat").send(chat("What happened in tx 0x" + HEX_KEY + "?")).expect(200);
  await agent.post("/api/chat").send(chat(WIF_COMPRESSED)).expect(200);
  // "Send anyway", confirmed in the workspace.
  const ok = await agent
    .post("/api/chat")
    .send(chat(ABANDON_12, { allow_seed_phrase: true }))
    .expect(200);
  assert.match(ok.text, /"credits_charged"/);
  // Memory never stores one, override or not.
  const m = await agent.post("/api/memory/facts").send({ text: LEGAL_12 }).expect(400);
  assert.equal(m.body.error.code, "seed_phrase_blocked");
});

test("/v1 and MCP refuse a seed phrase unless the header opts out", async (t) => {
  const svc = fixture(t);
  const agent = await signedIn(svc, "api-seeder");
  const key = (await agent.post("/api/keys").send({ name: "seed", cap: null }).expect(201)).body;
  const v1 = () =>
    request(svc.app).post("/v1/chat/completions").set("Authorization", "Bearer " + key.key);
  const refused = await v1().send(chat(ABANDON_24)).expect(400);
  assert.equal(refused.body.error.code, "seed_phrase_blocked");
  assert.match(refused.body.error.message, /X-Anonyma-Seed-Guard: off/);
  // The workspace's body flag is not the API's switch.
  await v1().send(chat(ABANDON_24, { allow_seed_phrase: true })).expect(400);
  await v1().set("X-Anonyma-Seed-Guard", "off").send(chat(ABANDON_24)).expect(200);
  await v1().send(chat("What is a seed phrase?")).expect(200);
  await v1().send(chat("Explain tx 0x" + HEX_KEY)).expect(200);
  // Media endpoints read their prompt.
  const image = await request(svc.app)
    .post("/v1/images/generations")
    .set("Authorization", "Bearer " + key.key)
    .send({ model: "openai/gpt-image-1", prompt: LEGAL_12 })
    .expect(400);
  assert.equal(image.body.error.code, "seed_phrase_blocked");
  // MCP's ask tool runs the same check, and honours the same header.
  const ask = (headers = {}) =>
    request(svc.app)
      .post("/mcp")
      .set({ Authorization: "Bearer " + key.key, ...headers })
      .send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "ask", arguments: { model: MODEL, prompt: LEGAL_12 } },
      })
      .expect(200);
  const blocked = (await ask()).body.result;
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /seed phrase/);
  const allowed = (await ask({ "X-Anonyma-Seed-Guard": "off" })).body.result;
  assert.equal(allowed.isError, undefined);
});

test("the API contract documents the header and the override", () => {
  const params = (path) => openapi.paths[path].post.parameters.map((p) => p.name);
  for (const path of ["/v1/chat/completions", "/mcp", "/v1/images/generations", "/v1/audio/speech", "/v1/videos"])
    assert.ok(params(path).includes("X-Anonyma-Seed-Guard"), path);
  const header = openapi.paths["/v1/chat/completions"].post.parameters.find(
    (p) => p.name === "X-Anonyma-Seed-Guard",
  );
  assert.deepEqual(header.schema.enum, ["off"]);
  assert.match(header.description, /seed_phrase_blocked/);
  assert.match(
    openapi.components.schemas.ChatRequest.properties.allow_seed_phrase.description,
    /seed_phrase_blocked/,
  );
});

// --- Gating ---------------------------------------------------------------
// SeedGuard.jsx compiled for Node with the same esbuild Vite uses; its
// imports point at the modules this test already loaded.
async function seedGuardModule() {
  const src = new URL("../src/SeedGuard.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const out = code
    .replace(/^import "\.\/seed-guard\.css";$/m, "")
    .replace(/^import \{ Icon \} from "\.\/ui\.jsx";$/m, "const Icon = () => null;")
    .replace(/from "\.\/(lib|seed-guard)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${import.meta.resolve("react")}"`);
  const dir = mkdtempSync(join(tmpdir(), "anonyma-seed-guard-ui-"));
  const file = join(dir, "SeedGuard.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("while unreleased Seed Guard stays out of the way, and its override is refused", async (t) => {
  const entry = UPDATES.find((u) => u.id === "seedguard");
  assert.equal(committed[UPDATES.indexOf(entry)], false, "committed as unreleased");
  assert.equal(entry.title, "Seed Guard");
  assert.equal(entry.tagline, "Your seed phrase never leaves your browser.");
  assert.equal(entry.points.length, 3);
  assert.deepEqual(
    featuresFor({ path: "/api/chat", method: "POST", body: { allow_seed_phrase: true } }),
    ["seedguard"],
  );

  const svc = fixture(t, "mvp");
  const agent = await signedIn(svc, "early-seeder");
  const config = (await agent.get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.seedguard, false);
  // No server check yet: the request goes through as before.
  await agent.post("/api/chat").send(chat(ABANDON_12)).expect(200);
  const r = await agent
    .post("/api/chat")
    .send(chat(ABANDON_12, { allow_seed_phrase: true }))
    .expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(r.body.error.message, "Seed Guard is coming soon.");

  // Nor in the browser: nothing is scanned and no notice shows.
  const { seedGuardLive, useSeedScan, SeedGuardNotice, SeedGuardSoftNotice } = await seedGuardModule();
  assert.equal(seedGuardLive(config), false);
  const Probe = ({ config: c }) => {
    const hit = useSeedScan(seedGuardLive(c), ABANDON_12);
    return hit ? `${hit.kind} ${hit.words}` : "none";
  };
  assert.equal(renderToStaticMarkup(createElement(Probe, { config })), "none");
  const live = (await request(fixture(t, "all").app).get("/api/config").expect(200)).body;
  assert.equal(seedGuardLive(live), true);
  assert.equal(renderToStaticMarkup(createElement(Probe, { config: live })), "seed 12");
  // The notice: the message, and "Send anyway" only where there's an override.
  const hit = { kind: "seed", words: 12 };
  assert.equal(renderToStaticMarkup(createElement(SeedGuardNotice, { hit: null })), "");
  const withOverride = renderToStaticMarkup(
    createElement(SeedGuardNotice, { hit, onProceed: () => {} }),
  );
  assert.ok(withOverride.includes("ANONYMA won&#x27;t send it. Remove it to continue."));
  assert.match(withOverride, />Send anyway</);
  assert.doesNotMatch(withOverride, /abandon/);
  const memory = renderToStaticMarkup(createElement(SeedGuardNotice, { hit: { kind: "key" } }));
  assert.match(memory, /wallet private key/);
  assert.doesNotMatch(memory, /anyway/);
  // Support: no override for a hard find, even with onProceed.
  const support = renderToStaticMarkup(
    createElement(SeedGuardNotice, { hit, onProceed: () => {}, hardOverride: false }),
  );
  assert.doesNotMatch(support, /<button/);

  // The soft notice for 64-hex: its own message and one button that goes
  // straight on, with no second confirm.
  const hex = { kind: "hex" };
  const soft = renderToStaticMarkup(createElement(SeedGuardNotice, { hit: hex, onProceed: () => {} }));
  assert.ok(soft.includes("This looks like a private key or a transaction hash. If it&#x27;s a private key, remove it."));
  assert.equal(soft.match(/<button/g).length, 1);
  assert.ok(soft.includes(">It&#x27;s not a key, send</button>"));
  assert.doesNotMatch(soft, /anyway|Yes, send it|role="alert"/);
  assert.ok(
    renderToStaticMarkup(createElement(SeedGuardNotice, { hit: hex, onProceed: () => {}, verb: "save" }))
      .includes(">It&#x27;s not a key, save</button>"),
  );
  // Clicking it runs the send once, immediately.
  let sent = 0;
  const tree = SeedGuardSoftNotice({ hit: hex, onProceed: () => sent++ });
  const buttons = [];
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    if (node.type === "button") buttons.push(node);
    walk(node.props?.children);
  };
  walk(tree);
  assert.equal(buttons.length, 1);
  buttons[0].props.onClick();
  assert.equal(sent, 1);
  // Memory has no override: the soft notice shows without a button.
  assert.doesNotMatch(renderToStaticMarkup(createElement(SeedGuardNotice, { hit: hex })), /<button/);
});
