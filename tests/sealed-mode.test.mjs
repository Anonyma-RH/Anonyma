import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import {
  Identity,
  hexToBytes,
  bytesToHex,
  deriveResponseKeys,
  encryptChunk,
  HPKE_REQUEST_INFO,
  EXPORT_LABEL,
} from "ehbp";
import { createApp } from "../server/app.js";
import { config, usdUnits, tokenCost } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import {
  isSealedModel,
  enclaveModelId,
  parseUsageMetrics,
  certificateValidity,
  sigstoreSource,
  bundleAgeProblem,
  sealedHoldUsd,
  sealedBody,
  SEALED_CONFIG_REPO,
  SEALED_OFF,
  MAX_BUNDLE_AGE_MS,
} from "../src/sealed.js";
import { attest, sealedChat, sealedBilling, isFresh } from "../src/sealed-client.js";
import { buildChatRequest } from "../src/estimate.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

// A real attestation bundle from PPQ's /private/attestation (Tinfoil's router
// enclave), captured 25 Sep 2026. Public data: it verifies offline.
const BUNDLE = JSON.parse(
  readFileSync(new URL("./fixtures/sealed-attestation.json", import.meta.url), "utf8"),
);
const CAPTURED = Date.UTC(2026, 8, 25, 22, 45, 51);
const COMMIT = "4b4957b77ed0517d872202d2c1b9bee9e072b341";
const MEASUREMENT =
  "b3be62c7199d8e4d24f130e5651bdc8a62a2532f72c7e87c986bec54bf5f90bab703ad4dbfc5e45bfd385f8972dfc66c";
const GATEWAY_KEY = "test-sealed-gateway-key";
// What the user types. It must never appear on the server side.
const SECRET = "violet-heron-7f3a meet at the old pier";
const REPLY = ["Hello", " from", " the sealed", " enclave."];

const price = (input, output) => ({
  type: "per_token",
  currency: "USD",
  input_per_1M_tokens: input,
  output_per_1M_tokens: output,
});
const KIMI = {
  id: "private/kimi-k3",
  name: "Kimi K3 (Private via TEE)",
  type: "chat",
  owned_by: "Tinfoil",
  context_length: 256000,
  privacyLevel: "e2e",
  status: "live",
  pricing: price(4.22, 21.1),
};
const CATALOG = [
  KIMI,
  { ...KIMI, id: "private/gpt-oss-120b", name: "GPT-OSS 120B (Private via TEE)", context_length: 131072, pricing: price(0.15825, 0.633) },
  // Named private/ but not end-to-end: never sealed.
  { ...KIMI, id: "private/zdr-lookalike", name: "Look-alike", privacyLevel: "zdr" },
  // Proprietary models, even zero-data-retention or "e2ee"-named ones.
  { id: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5", type: "chat", privacyLevel: "zdr", status: "live", context_length: 200000, pricing: price(3, 15) },
  { id: "venice/e2ee-gemma-4-26b-a4b-uncensored-p", name: "Venice E2EE Gemma", type: "chat", privacyLevel: "zdr", status: "live", context_length: 32000, pricing: price(0.2, 0.8) },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", type: "chat", privacyLevel: "anon", status: "live", context_length: 1048576, pricing: price(0.3, 2.5) },
];

// --- A stand-in for PPQ ------------------------------------------------------
// Serves the attestation bundle and the query history, and plays the enclave:
// it holds an HPKE key the relay never has, opens each sealed request with it
// and streams an EHBP-encrypted reply, with Tinfoil's usage trailer.
async function mockPPQ() {
  const enclave = await Identity.generate();
  const hpke = await enclave.getPublicKeyHex();
  const state = {
    mode: "ok",
    trailer: "auto",
    usage: { prompt: 321, completion: 45 },
    history: [],
    seen: [],
    plaintexts: [],
    historyAuth: null,
  };
  const encode = (t) => new TextEncoder().encode(t);
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://ppq.invalid");
    if (req.method === "GET" && url.pathname === "/private/attestation") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(BUNDLE));
    }
    if (req.method === "GET" && url.pathname === "/queries/history") {
      state.historyAuth = req.headers.authorization;
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({
        status: "success",
        data: state.history,
        pagination: { page: 1, page_count: 100, total: state.history.length, total_pages: 1 },
      }));
    }
    if (req.method !== "POST" || url.pathname !== "/private/v1/chat/completions") {
      res.writeHead(404);
      return res.end();
    }
    const parts = [];
    for await (const c of req) parts.push(c);
    const body = Buffer.concat(parts);
    state.seen.push({ headers: req.headers, body });
    if (state.mode === "keyconfig" || state.mode === "keyconfig-once") {
      if (state.mode === "keyconfig-once") state.mode = "ok";
      res.writeHead(422, { "content-type": "application/problem+json" });
      return res.end(JSON.stringify({ type: "urn:ietf:params:ehbp:error:key-config", title: "key configuration mismatch" }));
    }
    if (state.mode === "notfound") {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end('{"error":{"code":"model_not_found","message":"The model does not exist or you do not have access to it."}}');
    }
    if (state.mode === "refuse") {
      res.writeHead(500, { "content-type": "application/json" });
      return res.end('{"error":"upstream trouble"}');
    }
    if (state.mode === "unsealed") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      return res.end(`data: {"plaintext":"${REPLY.join("")}"}\n\n`);
    }
    // Open it as the enclave does (EHBP: HPKE base mode, "ehbp request").
    const enc = hexToBytes(req.headers["ehbp-encapsulated-key"]);
    const recipient = await enclave.suite.SetupRecipient(
      { privateKey: enclave.getPrivateKey(), publicKey: enclave.getPublicKey() },
      enc,
      { info: encode(HPKE_REQUEST_INFO) },
    );
    const plain = JSON.parse(
      new TextDecoder().decode(await recipient.Open(body.subarray(4, 4 + body.readUInt32BE(0)))),
    );
    state.plaintexts.push(plain);
    const secret = new Uint8Array(await recipient.Export(encode(EXPORT_LABEL), 32));
    const nonce = crypto.getRandomValues(new Uint8Array(32));
    const keys = await deriveResponseKeys(secret, enc, nonce);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "ehbp-response-nonce": bytesToHex(nonce),
      ...(state.trailer === "none" ? {} : { trailer: "X-Tinfoil-Usage-Metrics" }),
    });
    let seq = 0;
    const send = async (text) => {
      const ct = await encryptChunk(keys, seq++, encode(text));
      const frame = Buffer.alloc(4 + ct.length);
      frame.writeUInt32BE(ct.length, 0);
      Buffer.from(ct).copy(frame, 4);
      res.write(frame);
    };
    const event = (v) => send(`data: ${JSON.stringify(v)}\n\n`);
    for (const piece of REPLY) {
      await event({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      if (state.mode === "stall") return new Promise((r) => res.on("close", r));
    }
    await event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    await event({ choices: [], usage: { prompt_tokens: state.usage.prompt, completion_tokens: state.usage.completion } });
    await send("data: [DONE]\n\n");
    const { prompt, completion } = state.usage;
    const metrics =
      state.trailer === "auto"
        ? `prompt=${prompt},completion=${completion},total=${prompt + completion},model=${plain.model},cost_usd=0.000042`
        : state.trailer;
    if (state.trailer !== "none") res.addTrailers({ "X-Tinfoil-Usage-Metrics": metrics });
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return {
    state,
    hpke,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((r) => server.close(r)),
  };
}

// --- The ANONYMA server, listening, with Sealed Mode configured ----------
async function fixture(t, overrides = {}) {
  const ppq = await mockPPQ();
  const dir = mkdtempSync(join(tmpdir(), "anonyma-sealed-"));
  const catalogPath = join(dir, "models.json");
  writeFileSync(catalogPath, JSON.stringify({ data: CATALOG, updatedAt: "2026-09-25T00:00:00.000Z" }));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath,
    origin: "http://localhost:5175",
    released: "all",
    sealedBilling: "trailer",
    sealedReconcile: true,
    sealedGateway: ppq.url,
    sealedGatewayKey: GATEWAY_KEY,
    ...overrides,
  });
  const server = http.createServer(svc.app);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
    await ppq.close();
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { svc, ppq, origin };
}
let visitor = 0;
async function signUp(svc, name = "sealer") {
  const r = await request(svc.app)
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor}`)
    .send({ username: name + visitor, password: "test-password-long" })
    .expect(201);
  const cookie = r.headers["set-cookie"].map((c) => c.split(";")[0]).join("; ");
  const user = svc.db.prepare("SELECT id FROM users ORDER BY created DESC LIMIT 1").get();
  return { cookie, id: user.id };
}
// The enclave's verification as the browser would hold it, with the stand-in
// enclave's key: the official verifier is exercised on the real bundle below.
async function verified(origin, ppq, cookie, at = Date.now()) {
  return attest({
    origin,
    headers: { Cookie: cookie },
    now: () => at,
    verify: async () => ({
      hpkePublicKey: ppq.hpke,
      document: {
        securityVerified: true,
        hpkePublicKey: ppq.hpke,
        configRepo: SEALED_CONFIG_REPO,
        enclaveMeasurement: { measurement: { type: "https://tinfoil.sh/predicate/sev-snp-guest/v2", registers: [MEASUREMENT] } },
        releaseTag: "v0.0.155",
        releaseDigest: BUNDLE.digest,
        enclaveHost: "inference.tinfoil.sh",
      },
    }),
  });
}
const withinCertificate = CAPTURED + 3600000;
// Records every console line, to prove nothing about a sealed chat is logged.
function recordConsole() {
  const lines = [];
  const saved = ["log", "info", "warn", "error"].map((k) => [k, console[k]]);
  for (const [k] of saved) console[k] = (...a) => lines.push(a.map(String).join(" "));
  return { lines, restore: () => saved.forEach(([k, f]) => (console[k] = f)) };
}
// Every row of every table, as text.
const everything = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all()))
    .join("\n");
const chatBody = (model = KIMI.id, text = SECRET) => ({
  model,
  messages: [{ role: "user", content: text }],
  maxTokens: 8192,
});
async function runSealed({ origin, ppq, cookie, at = withinCertificate, attestation, ...extra }) {
  const events = [];
  const att = attestation || (await verified(origin, ppq, cookie, at));
  const result = await sealedChat({
    ...chatBody(),
    ...extra,
    attestation: att,
    origin,
    headers: { Cookie: cookie },
    now: () => at,
    onEvent: (e) => {
      events.push(e);
      extra.onEvent?.(e);
    },
  });
  const text = events.map((e) => e.choices?.[0]?.delta?.content || "").join("");
  return { ...result, events, text };
}
const row = (svc, requestId, user) =>
  svc.db.prepare("SELECT * FROM sealed_requests WHERE hold_id=?").get(user + ":" + requestId);
const hold = (svc, requestId, user) =>
  svc.db.prepare("SELECT * FROM holds WHERE id=?").get(user + ":" + requestId);
const sealedDebits = (svc, user) =>
  svc.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE user_id=? AND kind='sealed'").get(user).n;
async function until(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = check();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

// --- Registration and gating -----------------------------------------------
test("Sealed Mode is registered, unreleased and gated like any update", async (t) => {
  const entry = UPDATES.find((u) => u.id === "sealed");
  assert.ok(entry, "sealed is registered");
  assert.equal(entry.title, "Sealed Mode");
  assert.equal(entry.tagline, "Encrypted in your browser. Readable only in the enclave.");
  assert.equal(entry.points.length, 3);
  assert.match(entry.points.join(" "), /Open-weight private models only/);
  assert.match(entry.points.join(" "), /metadata: model, time, size and tokens/);
  assert.match(entry.points.join(" "), /open-source page code we serve/);
  assert.ok(UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "routines"), "added after earlier updates");
  // `false` until its release commit flips it; the gate tests pin it anyway.
  assert.equal(committed[UPDATES.indexOf(entry)], false);
  assert.equal(entry.early, undefined);
  const gate = (path, method = "GET") => featuresFor({ path, method, body: {} });
  assert.deepEqual(gate("/api/sealed/attestation"), ["sealed"]);
  assert.deepEqual(gate("/api/sealed/chat", "POST"), ["sealed"]);
  assert.deepEqual(gate("/API/Sealed/Requests/abc"), ["sealed"]);
  // A raw ciphertext body is never read by the gate.
  assert.deepEqual(featuresFor({ path: "/api/sealed/chat", method: "POST", body: Buffer.from("x") }), ["sealed"]);

  // Unreleased: refused before anything else, and nothing is offered.
  const { svc } = await fixture(t, { released: "mvp" });
  const { cookie } = await signUp(svc);
  const agent = request(svc.app);
  const r = await agent.get("/api/sealed/attestation").set("Cookie", cookie).expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(r.body.error.message, "Sealed Mode is coming soon.");
  await agent.post("/api/sealed/chat").set("Cookie", cookie).set("Content-Type", "application/json").send("{}").expect(403);
  const cfg = (await agent.get("/api/config").expect(200)).body;
  assert.equal(cfg.releases.features.sealed, false);
  assert.equal(cfg.services.sealed, false);
  assert.equal(openapiForConfig(svc.cfg).paths["/api/sealed/chat"], undefined);
});

test("released without a billing mode, Sealed Mode stays off: it never runs with unknown billing", async (t) => {
  assert.throws(() => config({ sealedBilling: "maybe" }), /SEALED_BILLING must be trailer or reconcile/);
  assert.throws(() => config({ sealedBilling: "reconcile", sealedReconcile: false }), /needs SEALED_RECONCILE=true/);
  assert.throws(() => config({ sealedMaxHoldUsd: 0 }), /SEALED_MAX_HOLD_USD/);
  assert.equal(config({}).sealedBilling, "");

  const { svc, ppq } = await fixture(t, { sealedBilling: "" });
  const { cookie } = await signUp(svc);
  const agent = request(svc.app);
  const cfg = (await agent.get("/api/config").expect(200)).body;
  assert.equal(cfg.releases.features.sealed, true);
  assert.equal(cfg.services.sealed, false);
  const models = (await agent.get("/api/models").expect(200)).body.data;
  assert.ok(models.every((m) => !m.sealed), "no model is offered sealed");
  const r = await agent.get("/api/sealed/attestation").set("Cookie", cookie).expect(503);
  assert.equal(r.body.error.code, "sealed_unavailable");
  assert.equal(ppq.state.seen.length, 0);
  assert.equal((await sealedUiModule()).sealedLiveFor(cfg), false);
});

// --- The shared rules ------------------------------------------------------
test("only open-weight private models labelled e2e are sealed; usage trailers and certificates parse", () => {
  assert.equal(isSealedModel(KIMI), true);
  for (const m of CATALOG.slice(2)) assert.equal(isSealedModel(m), false, m.id);
  assert.equal(isSealedModel({ ...KIMI, pricing: {} }), false);
  assert.equal(isSealedModel({ ...KIMI, type: "image" }), false);
  assert.equal(enclaveModelId("private/kimi-k3"), "kimi-k3");

  assert.deepEqual(parseUsageMetrics("prompt=67,completion=42,total=109,model=gpt-oss-120b,cost_usd=0.000042"), {
    prompt: 67, completion: 42, total: 109, model: "gpt-oss-120b", cost_usd: 0.000042,
  });
  // A map, not positions: order and added fields don't matter.
  assert.deepEqual(parseUsageMetrics("cached_prompt_tokens=3,total=5,completion=2,prompt=3"), {
    prompt: 3, completion: 2, total: 5, model: null, cost_usd: null,
  });
  for (const bad of ["", "prompt=1,completion=2", "prompt=-1,completion=2,total=1", "prompt=1.5,completion=2,total=3", "prompt=1,prompt=2,completion=1,total=3", "garbage", null])
    assert.equal(parseUsageMetrics(bad), null, String(bad));

  assert.deepEqual(certificateValidity(BUNDLE.enclaveCert), {
    notBefore: Date.UTC(2026, 8, 24, 23, 50, 51),
    notAfter: Date.UTC(2026, 11, 23, 23, 50, 50),
  });
  assert.deepEqual(sigstoreSource(BUNDLE.sigstoreBundle), {
    repository: `https://github.com/${SEALED_CONFIG_REPO}`,
    commit: COMMIT,
    ref: "refs/tags/v0.0.155",
  });
  assert.equal(bundleAgeProblem(BUNDLE, CAPTURED), null);
  assert.match(bundleAgeProblem(BUNDLE, Date.UTC(2026, 11, 24)), /expired/);
  assert.match(bundleAgeProblem(BUNDLE, Date.UTC(2026, 8, 20)), /isn't valid yet/);
  assert.match(bundleAgeProblem(BUNDLE, CAPTURED + 86400000, 0.5), /older than the maximum age/);
  assert.match(bundleAgeProblem({ enclaveCert: "junk" }, CAPTURED), /couldn't be read/);
});

test("Veil masks and Seed Guard checks before anything is sealed", () => {
  const state = { map: {}, counters: {}, valueToTag: {} };
  const built = buildChatRequest({
    text: "Mail me at jane.doe@example.com",
    veilWith: { state, words: [] },
  });
  const body = JSON.stringify(sealedBody({ model: KIMI.id, messages: built.request, maxTokens: 8192, cacheSecret: "a".repeat(64) }));
  assert.equal(built.masked, 1);
  assert.doesNotMatch(body, /jane\.doe@example\.com/);
  assert.match(body, /"model":"kimi-k3"/);
  assert.match(body, /"user_cache_secret":"a{64}"/);
  // The workspace's send checks Seed Guard first, and only then hands off to
  // the sealed send, which builds its request with Veil like any chat.
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  const seedCheck = ws.indexOf("if (seedFound && !allowSeed && (!redo || redo.edited != null)) return;");
  const handOff = ws.indexOf("if (sealedOn && textMode) return sendSealed(redo);");
  assert.ok(seedCheck > 0 && handOff > seedCheck, "Seed Guard runs before the sealed send");
  assert.match(ws, /async function sendSealed\(redo\) \{[\s\S]*?veilWith: veiling \? \{ state: veilStateRef\.current, words: veilWords \} : null,/);
});

// --- Attestation in the browser -------------------------------------------
test("the official Tinfoil verifier accepts the captured enclave bundle offline, and the panel shows what it proved", async () => {
  const saved = globalThis.fetch;
  const fetched = [];
  globalThis.fetch = (u) => {
    fetched.push(String(u));
    throw Error("no network in this test");
  };
  let a;
  try {
    a = await attest({
      origin: "https://askanonyma.test",
      fetchImpl: async (url) => ({ ok: true, json: async () => structuredClone(BUNDLE), url }),
      now: () => CAPTURED,
    });
  } finally {
    globalThis.fetch = saved;
  }
  assert.deepEqual(fetched, [], "verification needs nothing from the network");
  assert.equal(a.hpkePublicKey, "63dd29eb27e7a4af209633ebf722c4140e7e0e4ac94f6efd25d00197e1091433");
  assert.equal(a.measurement, MEASUREMENT);
  assert.equal(a.hardware, "AMD SEV-SNP");
  assert.equal(a.repository, SEALED_CONFIG_REPO);
  assert.equal(a.commit, COMMIT);
  assert.equal(a.releaseTag, "v0.0.155");
  assert.equal(a.verifiedAt, CAPTURED);
  assert.equal(isFresh(a, CAPTURED + MAX_BUNDLE_AGE_MS - 1), true);
  assert.equal(isFresh(a, CAPTURED + MAX_BUNDLE_AGE_MS), false);

  const { SealedPanel, SealedReplyNote } = await sealedUiModule();
  const html = renderToStaticMarkup(createElement(SealedPanel, { state: { status: "verified", attestation: a }, onRetry() {}, holdCredits: 174.1 }));
  assert.match(html, /Enclave verified/);
  assert.match(html, /<code data-i18n="off" title="b3be62c7[0-9a-f]+">b3be62c7199d…dfc66c<\/code>/);
  assert.match(html, /href="https:\/\/github.com\/tinfoilsh\/confidential-model-router\/commit\/4b4957b77ed0517d872202d2c1b9bee9e072b341"/);
  assert.match(html, />tinfoilsh\/confidential-model-router @ 4b4957b</);
  assert.match(html, /AMD SEV-SNP/);
  assert.match(html, /This message holds up to 174\.10 credits/);
  for (const line of SEALED_OFF) assert.ok(html.includes(line.text.replace(/'/g, "&#x27;")), line.id);
  const failed = renderToStaticMarkup(createElement(SealedPanel, { state: { status: "failed", error: "The enclave failed verification. Nothing was sent." }, onRetry() {} }));
  assert.match(failed, /Verification failed/);
  assert.match(failed, /Verify again/);
  assert.doesNotMatch(failed, /Enclave measurement/);
  assert.match(
    renderToStaticMarkup(createElement(SealedReplyNote, { info: { billing: { status: "settled", charged: 1.2345 } } })),
    /Sealed · decrypted only in the enclave · not saved on our servers · 1\.2345 credits charged/,
  );
  assert.match(
    renderToStaticMarkup(createElement(SealedReplyNote, { info: { billing: { status: "reconcile_pending", held: 174.1 } } })),
    /174\.1 credits held until the charge is confirmed/,
  );
});

test("a bundle that fails verification, is stale or names another repository stops the send: no hold, no charge", async (t) => {
  const tampered = structuredClone(BUNDLE);
  tampered.digest = "0" + tampered.digest.slice(1);
  const serve = (b) => async () => ({ ok: true, json: async () => structuredClone(b) });
  await assert.rejects(
    attest({ origin: "https://x.test", fetchImpl: serve(tampered), now: () => CAPTURED }),
    (e) => e.code === "attestation_failed" && /failed verification\. Nothing was sent\./.test(e.message),
  );
  await assert.rejects(
    attest({ origin: "https://x.test", fetchImpl: serve(BUNDLE), now: () => Date.UTC(2027, 0, 1) }),
    (e) => e.code === "attestation_failed" && /expired/.test(e.message),
  );
  // A verifier result for another repository's build is not accepted either.
  await assert.rejects(
    attest({
      origin: "https://x.test",
      fetchImpl: serve(BUNDLE),
      now: () => CAPTURED,
      verify: async () => ({ hpkePublicKey: "ab".repeat(32), document: { securityVerified: true, hpkePublicKey: "ab".repeat(32), configRepo: "someone/else" } }),
    }),
    (e) => e.code === "attestation_failed",
  );
  await assert.rejects(
    attest({ origin: "https://x.test", fetchImpl: async () => ({ ok: false, status: 503 }) }),
    (e) => e.code === "attestation_unavailable",
  );

  // Through the whole stack: a stale verification sends nothing at all.
  const { svc, ppq, origin } = await fixture(t);
  const { cookie, id } = await signUp(svc);
  const att = await verified(origin, ppq, cookie, withinCertificate);
  const before = everything(svc.db);
  await assert.rejects(
    runSealed({ origin, ppq, cookie, attestation: att, at: withinCertificate + MAX_BUNDLE_AGE_MS }),
    (e) => e.code === "attestation_failed",
  );
  assert.equal(ppq.state.seen.length, 0, "nothing reached PPQ");
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM sealed_requests").get().n, 0);
  assert.equal(sealedDebits(svc, id), 0);
  assert.equal(everything(svc.db).replace(/"rate_limits"|\[\{"key[^\]]*\]/g, ""), before.replace(/"rate_limits"|\[\{"key[^\]]*\]/g, ""));
});

// --- Relay and billing -----------------------------------------------------
test("a sealed chat is encrypted in the client, relayed as ciphertext, readable only by the enclave, and settled from the trailer", async (t) => {
  const { svc, ppq, origin } = await fixture(t);
  const { cookie, id } = await signUp(svc);
  // What the client actually puts on the wire.
  const saved = globalThis.fetch;
  const sent = [];
  globalThis.fetch = async (input, init) => {
    if (input instanceof Request && input.url.endsWith("/api/sealed/chat"))
      sent.push({ headers: Object.fromEntries(input.headers), body: Buffer.from(await input.clone().arrayBuffer()) });
    return saved(input, init);
  };
  const log = recordConsole();
  let result;
  try {
    result = await runSealed({ origin, ppq, cookie });
  } finally {
    globalThis.fetch = saved;
    log.restore();
  }
  assert.equal(result.text, REPLY.join(""), "the reply is decrypted in the client");

  // The relay forwarded exactly the client's ciphertext, with our gateway key.
  assert.equal(ppq.state.seen.length, 1);
  const [upstream] = ppq.state.seen;
  assert.equal(sent.length, 1);
  assert.ok(upstream.body.equals(sent[0].body), "forwarded byte for byte");
  assert.equal(upstream.headers["ehbp-encapsulated-key"], sent[0].headers["ehbp-encapsulated-key"]);
  assert.equal(upstream.headers["x-private-model"], "private/kimi-k3");
  assert.equal(upstream.headers.authorization, `Bearer ${GATEWAY_KEY}`);
  assert.equal(upstream.headers["x-tinfoil-request-usage-metrics"], "true");
  assert.equal(sent[0].headers.authorization, undefined, "the browser never holds the gateway key");
  for (const encoding of ["utf8", "latin1", "base64", "hex"])
    assert.ok(!upstream.body.toString(encoding).includes("violet-heron"), `no plaintext (${encoding})`);
  // Only the enclave could open it.
  const [opened] = ppq.state.plaintexts;
  assert.equal(opened.model, "kimi-k3");
  assert.equal(opened.max_tokens, 8192);
  assert.equal(opened.stream, true);
  assert.match(opened.user_cache_secret, /^[0-9a-f]{64}$/);
  assert.equal(opened.messages[0].content, SECRET);

  // Held at the worst case, settled from the trailer at the catalog price.
  const r = row(svc, result.requestId, id);
  assert.equal(r.ciphertext_bytes, sent[0].body.length);
  assert.equal(r.held, Math.ceil(usdUnits(sealedHoldUsd(KIMI, r.ciphertext_bytes, 8192))));
  assert.equal(r.status, "settled");
  assert.equal(r.reason, "trailer");
  const charge = usdUnits(tokenCost(KIMI, 321, 45));
  assert.equal(r.charged, charge);
  assert.ok(r.charged < r.held);
  assert.equal(hold(svc, result.requestId, id).status, "settled");
  assert.equal(hold(svc, result.requestId, id).kind, "sealed");
  assert.equal(sealedDebits(svc, id), -charge);
  const view = await sealedBilling(result.requestId, { origin, headers: { Cookie: cookie } });
  assert.equal(view.status, "settled");
  assert.equal(view.charged, charge / 10000);
  assert.deepEqual(view.usage, { prompt_tokens: 321, completion_tokens: 45 });
  // Another account can't read it.
  const other = await signUp(svc, "other");
  await request(svc.app).get(`/api/sealed/requests/${result.requestId}`).set("Cookie", other.cookie).expect(404);

  // Nothing readable is kept or logged: not the prompt, not the reply.
  const stored = everything(svc.db);
  for (const text of ["violet-heron", "old pier", "sealed enclave", "the sealed"])
    assert.ok(!stored.includes(text), `not stored: ${text}`);
  assert.ok(!log.lines.join("\n").includes("violet-heron"));
  assert.ok(!log.lines.join("\n").includes("enclave."));
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM conversations").get().n, 0);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM messages").get().n, 0);
});

test("with no trailer the hold is kept as reconcile_pending, never expired, and settled from PPQ's query history", async (t) => {
  const { svc, ppq, origin } = await fixture(t);
  const { cookie, id } = await signUp(svc);
  ppq.state.trailer = "none";
  const log = recordConsole();
  let result;
  try {
    result = await runSealed({ origin, ppq, cookie });
  } finally {
    log.restore();
  }
  assert.equal(result.text, REPLY.join(""));
  const r = row(svc, result.requestId, id);
  assert.equal(r.status, "reconcile_pending");
  assert.equal(r.reason, "no_trailer");
  assert.equal(r.charged, null);
  // Not released and not charged in full: held.
  assert.equal(hold(svc, result.requestId, id).status, "held");
  assert.equal(sealedDebits(svc, id), 0);
  // Expiry never releases it.
  svc.db.prepare("UPDATE holds SET expires=0 WHERE id=?").run(id + ":" + result.requestId);
  await svc.tick();
  assert.equal(hold(svc, result.requestId, id).status, "held");
  const view = await sealedBilling(result.requestId, { origin, headers: { Cookie: cookie } });
  assert.equal(view.status, "reconcile_pending");
  assert.equal(view.held, r.held / 10000);

  // PPQ's history: the request's own row, plus rows it must not take.
  const at = new Date().toISOString();
  ppq.state.history = [
    { timestamp: at, model: "private/gpt-oss-120b", input_count: 300, output_count: 40, price_in_usd: 0.5, query_source: "api", api_key_id: "k" },
    { timestamp: new Date(Date.now() - 3600000).toISOString(), model: "private/kimi-k3", input_count: 300, output_count: 40, price_in_usd: 0.9, query_source: "api", api_key_id: "k" },
    { timestamp: at, model: "private/kimi-k3", input_count: 300, output_count: 40, price_in_usd: 0.00213, query_source: "api", api_key_id: "k" },
  ];
  // Not before the settling delay.
  assert.deepEqual(await svc.sealed.tick(Date.now()), { settled: 0, pending: 0 });
  const done = await svc.sealed.tick(Date.now() + 120000);
  assert.deepEqual(done, { settled: 1, pending: 0 });
  assert.equal(ppq.state.historyAuth, `Bearer ${GATEWAY_KEY}`);
  const settled = row(svc, result.requestId, id);
  assert.equal(settled.status, "settled");
  assert.equal(settled.reason, "reconciled");
  assert.equal(settled.charged, usdUnits(0.00213));
  assert.ok(settled.reconcile_ref);
  assert.equal(hold(svc, result.requestId, id).status, "settled");
  assert.equal(sealedDebits(svc, id), -usdUnits(0.00213));
  assert.match(
    svc.db.prepare("SELECT description FROM ledger WHERE ref=?").get(id + ":" + result.requestId).description,
    /^Reconciled: Kimi K3/,
  );
  // The same history row can't settle anything else.
  assert.deepEqual(await svc.sealed.tick(Date.now() + 240000), { settled: 0, pending: 0 });
  assert.ok(!log.lines.join("\n").includes("violet-heron"));
});

test("ambiguous history settles nothing, a mismatched model is held, and reconcile mode never settles from the trailer", async (t) => {
  const { svc, ppq, origin } = await fixture(t);
  const { cookie, id } = await signUp(svc);
  ppq.state.trailer = "none";
  const a = await runSealed({ origin, ppq, cookie });
  const b = await runSealed({ origin, ppq, cookie });
  const at = new Date().toISOString();
  const history = (price) => ({ timestamp: at, model: "private/kimi-k3", input_count: 200, output_count: 40, price_in_usd: price, query_source: "api", api_key_id: "k" });
  ppq.state.history = [history(0.001), history(0.002)];
  assert.deepEqual(await svc.sealed.tick(Date.now() + 120000), { settled: 0, pending: 2 });
  assert.equal(row(svc, a.requestId, id).status, "reconcile_pending");
  assert.equal(row(svc, b.requestId, id).status, "reconcile_pending");

  // The trailer names another model than the one billed: held, not trusted.
  ppq.state.trailer = "prompt=10,completion=5,total=15,model=some-other-model";
  const c = await runSealed({ origin, ppq, cookie });
  assert.equal(row(svc, c.requestId, id).status, "reconcile_pending");
  assert.equal(row(svc, c.requestId, id).reason, "model_mismatch");

  // SEALED_BILLING=reconcile: even a present trailer leaves it to the history.
  const other = await fixture(t, { sealedBilling: "reconcile" });
  const who = await signUp(other.svc);
  const d = await runSealed({ origin: other.origin, ppq: other.ppq, cookie: who.cookie });
  const dr = row(other.svc, d.requestId, who.id);
  assert.equal(dr.status, "reconcile_pending");
  assert.equal(dr.reason, "reconcile_mode");
  assert.equal(JSON.parse(dr.usage).prompt_tokens, 321, "the trailer is kept for the operator's comparison");
  assert.equal(hold(other.svc, d.requestId, who.id).status, "held");
});

test("a key rotation or refusal releases the hold with nothing charged; an unsealed reply is never passed on", async (t) => {
  const { svc, ppq, origin } = await fixture(t);
  const { cookie, id } = await signUp(svc);
  // The enclave rotated its key: the client verifies again and resends once.
  ppq.state.mode = "keyconfig-once";
  let reattested = 0;
  const att = await verified(origin, ppq, cookie, withinCertificate);
  const result = await runSealed({
    origin, ppq, cookie, attestation: att,
    reattest: async () => {
      reattested++;
      return verified(origin, ppq, cookie, withinCertificate);
    },
  });
  assert.equal(reattested, 1);
  assert.equal(result.text, REPLY.join(""));
  const rows = svc.db.prepare("SELECT * FROM sealed_requests WHERE user_id=? ORDER BY created,rowid").all(id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].status, "released");
  assert.equal(rows[0].reason, "key_config");
  assert.equal(svc.db.prepare("SELECT status FROM holds WHERE id=?").get(rows[0].hold_id).status, "released");
  assert.equal(rows[1].status, "settled");
  assert.equal(sealedDebits(svc, id), -rows[1].charged, "only the delivered request is charged");

  // Still rotating after the retry: released again, and the client says so.
  ppq.state.mode = "keyconfig";
  await assert.rejects(runSealed({ origin, ppq, cookie, reattest: () => verified(origin, ppq, cookie, withinCertificate) }));
  // A provider error: released, nothing charged.
  ppq.state.mode = "refuse";
  await assert.rejects(runSealed({ origin, ppq, cookie }), (e) => e.status === 502 && e.code === "provider_down" && /Nothing was charged/.test(e.message));
  const released = svc.db.prepare("SELECT COUNT(*) n FROM sealed_requests WHERE user_id=? AND status='released'").get(id).n;
  assert.equal(released, 4);
  assert.equal(sealedDebits(svc, id), -rows[1].charged);

  // A 200 without EHBP: its plaintext never reaches the browser; the hold
  // waits for reconciliation, since the enclave may have answered.
  ppq.state.mode = "unsealed";
  const log = recordConsole();
  try {
    await assert.rejects(runSealed({ origin, ppq, cookie }), (e) => e.status === 502 && e.code === "sealed_protocol" && !JSON.stringify(e.data).includes("enclave."));
  } finally {
    log.restore();
  }
  const protocol = svc.db.prepare("SELECT * FROM sealed_requests WHERE user_id=? AND reason='protocol'").get(id);
  assert.equal(protocol.status, "reconcile_pending");
  assert.equal(svc.db.prepare("SELECT status FROM holds WHERE id=?").get(protocol.hold_id).status, "held");
  assert.ok(!log.lines.join("\n").includes("enclave."));

  // A model the enclave doesn't serve (404): nothing sent or charged, and
  // Sealed Mode stops offering it for a while.
  ppq.state.mode = "notfound";
  await assert.rejects(runSealed({ origin, ppq, cookie }), (e) => e.status === 400 && e.code === "sealed_model_unavailable");
  const offered = (await (await fetch(origin + "/api/models")).json()).data;
  assert.ok(!offered.some((m) => m.id === "private/kimi-k3" && m.sealed), "hidden after a 404");
});

test("a Stop after the provider accepted is held for its charge, then charged from the history", async (t) => {
  const { svc, ppq, origin } = await fixture(t);
  const { cookie, id } = await signUp(svc);
  ppq.state.mode = "stall";
  const controller = new AbortController();
  let requestId;
  await assert.rejects(
    runSealed({
      origin, ppq, cookie,
      signal: controller.signal,
      onEvent: () => controller.abort(),
    }),
    (e) => {
      requestId = e.requestId;
      return e.name === "AbortError";
    },
  );
  assert.ok(requestId);
  const r = await until(() => {
    const v = row(svc, requestId, id);
    return v?.status !== "relaying" && v;
  });
  assert.equal(r.status, "reconcile_pending");
  assert.equal(r.reason, "stopped");
  assert.ok(r.accepted);
  assert.equal(hold(svc, requestId, id).status, "held");
  ppq.state.history = [{ timestamp: new Date().toISOString(), model: "private/kimi-k3", input_count: 120, output_count: 3, price_in_usd: 0.0006, query_source: "api", api_key_id: "k" }];
  assert.deepEqual(await svc.sealed.tick(Date.now() + 120000), { settled: 1, pending: 0 });
  assert.equal(sealedDebits(svc, id), -usdUnits(0.0006));
});

test("proprietary and look-alike models are refused before anything is held or sent, and never offered", async (t) => {
  const { svc, ppq, origin } = await fixture(t);
  const { cookie, id } = await signUp(svc);
  for (const model of ["anthropic/claude-sonnet-5", "venice/e2ee-gemma-4-26b-a4b-uncensored-p", "private/zdr-lookalike", "google/gemini-2.5-flash", "private/unknown"])
    await assert.rejects(
      runSealed({ origin, ppq, cookie, model }),
      (e) => e.status === 400 && e.code === "sealed_model_required",
      model,
    );
  assert.equal(ppq.state.seen.length, 0);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  const models = (await request(svc.app).get("/api/models").expect(200)).body.data;
  const sealed = models.filter((m) => m.sealed).map((m) => [m.id, m.sealedOutputCap]);
  assert.deepEqual(sealed, [["private/kimi-k3", 8192], ["private/gpt-oss-120b", 8192]]);
  // Relayed private/* models are never callable through the ordinary chat.
  assert.ok(models.filter((m) => m.id.startsWith("private/")).every((m) => m.callable === false));
  await request(svc.app).post("/api/chat").set("Cookie", cookie).send({ model: "private/kimi-k3", messages: [{ role: "user", content: "hi" }] }).expect(503);
  // Not a sealed body at all.
  const raw = (headers, body) => {
    let r = request(svc.app).post("/api/sealed/chat").set("Cookie", cookie).set("Content-Type", "application/json");
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(body);
  };
  const framed = Buffer.alloc(40);
  framed.writeUInt32BE(36, 0);
  assert.equal((await raw({ "X-Private-Model": KIMI.id }, framed).expect(400)).body.error.code, "sealed_protocol");
  assert.equal((await raw({ "X-Private-Model": KIMI.id, "Ehbp-Encapsulated-Key": "ab".repeat(32) }, Buffer.from('{"model":"kimi-k3"}')).expect(400)).body.error.code, "sealed_protocol");
  assert.equal(sealedDebits(svc, id), 0);
});

test("the hold is the worst case at the catalog price, and a request above the cap is refused unsent", async (t) => {
  // 1,000 ciphertext bytes on Kimi K3: (1000 + 1024) input + 8192 output.
  assert.equal(sealedHoldUsd(KIMI, 1000, 8192), (4.22 * 2024 + 21.1 * 8192) / 1e6);
  const { svc, ppq, origin } = await fixture(t, { sealedMaxHoldUsd: 0.1 });
  const { cookie, id } = await signUp(svc);
  await assert.rejects(
    runSealed({ origin, ppq, cookie }),
    (e) => e.status === 413 && e.code === "sealed_hold_cap" && /Nothing was sent or charged/.test(e.message),
  );
  assert.equal(ppq.state.seen.length, 0);
  assert.equal(svc.db.prepare("SELECT COUNT(*) n FROM holds").get().n, 0);
  // The cheaper model fits under the same cap.
  const ok = await runSealed({ origin, ppq, cookie, model: "private/gpt-oss-120b" });
  assert.equal(row(svc, ok.requestId, id).status, "settled");
  assert.equal(row(svc, ok.requestId, id).output_cap, 8192);
  // Credits run out: refused by the balance, nothing sent.
  const total = svc.db.prepare("SELECT SUM(amount) n FROM ledger WHERE user_id=?").get(id).n;
  svc.db
    .prepare("INSERT INTO holds(id,user_id,amount,kind,status,created,expires) VALUES('blocker',?,?,'chat','held',?,?)")
    .run(id, total, Date.now(), Date.now() + 86400000);
  await assert.rejects(runSealed({ origin, ppq, cookie, model: "private/gpt-oss-120b" }), (e) => e.status === 402);
  assert.equal(ppq.state.seen.length, 1);
});

test("Panic Wipe isn't blocked by a held sealed charge; the export has metadata only; closure waits for it", async (t) => {
  const { svc, ppq, origin } = await fixture(t);
  const { cookie, id } = await signUp(svc);
  const settled = await runSealed({ origin, ppq, cookie });
  ppq.state.trailer = "none";
  const pending = await runSealed({ origin, ppq, cookie });
  const agent = request(svc.app);
  const exported = (await agent.get("/api/account/export").set("Cookie", cookie).expect(200)).body;
  assert.deepEqual(exported.sealedRequests.map((r) => r.status), ["settled", "reconcile_pending"]);
  assert.ok(!JSON.stringify(exported).includes("violet-heron"));
  assert.ok(!JSON.stringify(exported).includes("enclave."));
  // Closing the account waits for billing; a wipe does not.
  await agent.delete("/api/account").set("Cookie", cookie).send({ confirm: "DELETE" }).expect(409);
  await agent.post("/api/account/wipe").set("Cookie", cookie).send({ confirm: "WIPE" }).expect(200);
  assert.equal(row(svc, settled.requestId, id), undefined, "a finished record goes with the wipe");
  assert.equal(row(svc, pending.requestId, id).status, "reconcile_pending", "one still owed stays until settled");
  assert.equal(hold(svc, pending.requestId, id).status, "held");
});

// --- The workspace ----------------------------------------------------------
// SealedMode.jsx compiled for Node with the same esbuild Vite uses.
async function sealedUiModule() {
  const src = new URL("../src/SealedMode.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, {
    jsx: "transform",
    format: "esm",
  });
  const out = code
    .replace(/^import "\.\/sealed-mode\.css";$/m, "")
    .replace(/^import \{ Icon \} from "\.\/ui\.jsx";$/m, "const Icon = () => null;")
    .replace(/from "\.\/(lib|sealed)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${import.meta.resolve("react")}"`);
  const dir = mkdtempSync(join(tmpdir(), "anonyma-sealed-ui-"));
  const file = join(dir, "SealedMode.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the workspace offers Sealed only when it's live, loads the crypto lazily and turns off what would leak", async () => {
  const { sealedLiveFor } = await sealedUiModule();
  assert.equal(sealedLiveFor({ releases: { features: {} }, services: { sealed: true } }), false);
  assert.equal(sealedLiveFor({ releases: { features: { sealed: true } }, services: { sealed: false } }), false);
  assert.equal(sealedLiveFor({ releases: { features: { sealed: true } }, services: { sealed: true } }), true);
  const read = (f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  const ws = read("Workspace.jsx");
  // The Tinfoil verifier and EHBP load only when the switch goes on.
  for (const f of ["Workspace.jsx", "SealedMode.jsx", "App.jsx", "main.jsx", "lib.js"])
    assert.doesNotMatch(read(f), /from "\.\/sealed-client\.js"|from "tinfoil"|from "ehbp"/, f);
  assert.match(read("SealedMode.jsx"), /const loadClient = \(\) => import\("\.\/sealed-client\.js"\);/);
  assert.match(ws, /const sealedAvailable =\s*!demo && !!user && sealedLiveFor\(config\) && \["chat", "code"\]\.includes\(mode\);/);
  assert.match(ws, /\{sealedAvailable && \(\s*<SealedToggle/);
  // Off while sealed: the estimate (it posts the prompt), web search, saved
  // files, memory, voice, scrolls editing, double-check and team billing.
  assert.match(ws, /\/\/ Sealed Mode never posts a prompt for an estimate \(it would go unsealed\)\.\s*!sealedOn;/);
  assert.match(ws, /\["chat", "code"\]\.includes\(mode\) &&\s*!sealedOn &&\s*isReleased\(config, "search"\)/);
  assert.match(ws, /filesEnabled=\{isReleased\(config, "files"\) && !sealedOn\}/);
  assert.match(ws, /sealedOn \|\| sealedThread\s*\? "Sealed Mode: memory isn't used or saved in this chat\."/);
  assert.match(ws, /\{textMode && scrollsLive && !sealedOn && \(/);
  assert.match(ws, /isReleased\(config, "doublecheck"\) && isReleased\(config, "symposium"\) &&\s*!sealedOn && !sealedThread;/);
  assert.match(ws, /\{\["chat", "code"\]\.includes\(mode\) && !sealedOn && teamPays\.toggle\}/);
  assert.match(ws, /\{voiceOpen && !privateMode && !sealedOn && textMode/);
  // Kept only in Device Vault while it's unlocked; never on the server.
  assert.match(ws, /setDeviceOnly\(vaultLive && vault\.unlocked\);\s*setEphemeral\(true\);/);
  assert.match(ws, /sealed: sealedOn \|\| sealedThread,/);
  assert.doesNotMatch(ws.slice(ws.indexOf("async function sendSealed"), ws.indexOf("// Edit a user turn")), /streamChat|\/api\/chat|conversationId/);
  // A sealed thread never goes on unsealed; Send waits for verification.
  assert.match(ws, /if \(sealedThread && !demo\) \{\s*setError\("This chat was sealed\./);
  assert.match(ws, /\(sealedOn && \(!sealedTarget \|\| enclave\.state\.status !== "verified"\)\)/);
  assert.match(read("device-vault.js"), /\.\.\.\(sealed \? \{ sealed: true \} : \{\}\),/);
});

test("中文: every Sealed Mode string the app shows has a translation", () => {
  const dict = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
  const patterns = new Set(dict.patterns.map((p) => p.en));
  const entry = UPDATES.find((u) => u.id === "sealed");
  const strings = [
    entry.title,
    entry.tagline,
    ...entry.points,
    ...SEALED_OFF.map((f) => f.text),
    "Sealed Mode encrypts your message in your browser to a hardware-verified enclave. ANONYMA only relays ciphertext.",
    "Sealed", "Sealed model", "Enclave verified", "Verification failed", "Verifying the enclave…", "Verify again",
    "Enclave measurement", "Source", "Hardware", "Verified", "What Sealed Mode turns off", "Nothing charged",
    "The enclave failed verification. Nothing was sent.",
    "The enclave's attestation couldn't be fetched. Nothing was sent.",
    "The enclave's certificate has expired. Nothing was sent.",
    "Sealed Mode works only with open-weight private models, which run inside the enclave.",
    "This chat was sealed. Turn on Sealed Mode to continue it, or start a new chat.",
  ];
  for (const s of strings) assert.match(dict.strings[s] || "", /\p{Script=Han}/u, s);
  for (const p of [
    "{0} credits charged",
    "{0} credits held until the charge is confirmed",
    "Sealed · decrypted only in the enclave · not saved on our servers · {0}",
    "This message holds up to {0} credits; you're charged for what it uses.",
    "This sealed request could cost up to {0} credits, more than the {1} a sealed request may hold. Start a new conversation or send less. Nothing was sent or charged.",
  ])
    assert.ok(patterns.has(p), p);
  assert.equal(dict.strings["Sealed Mode"], "密封模式");
});
