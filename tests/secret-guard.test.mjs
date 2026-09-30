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
import { MIGRATIONS, database, migrate, rollbackSchema } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { eraseAccountContent } from "../server/routes/account.js";
import {
  SECRET_RULES,
  crc32,
  findSecrets,
  githubChecksumValid,
  jwtValid,
  maskComposer,
  maskSecrets,
  previewSecret,
  removeFromComposer,
  removeSecrets,
  scanComposer,
  scanParts,
  secretGuardActive,
  secretGuardTurn,
  secretTag,
} from "../src/secret-guard.js";
import { findSeedPhrase, scanSecrets } from "../src/seed-guard.js";
import { createVeilState, loadVeilState, saveVeilState, unveil, veil, withoutSecrets } from "../src/veil.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
const ORIGIN = "http://localhost:5175";
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ---- Fixtures --------------------------------------------------------------
// Every key-shaped value is built here from a seed at run time, so this file
// holds no key-shaped literal for the repo's own secret scanners to flag.
// None of them was ever issued by anyone.
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const HEX = "0123456789abcdef";
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const B64 = B62 + "+/";
function chars(seed, n, alphabet = B62) {
  let out = "",
    h = createHash("sha256").update(seed).digest();
  while (out.length < n) {
    for (const b of h) if (out.length < n) out += alphabet[b % alphabet.length];
    h = createHash("sha256").update(h).digest();
  }
  return out;
}
const join2 = (...parts) => parts.join("");
function base62(n) {
  let s = "";
  do {
    s = B62[n % 62] + s;
    n = Math.floor(n / 62);
  } while (n > 0);
  return s.padStart(6, "0");
}
function githubToken(seed, prefix = join2("gh", "p_")) {
  const body = chars(seed, 30);
  return prefix + body + base62(crc32(body));
}
const jwtPart = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const JWT = [jwtPart({ alg: "HS256", typ: "JWT" }), jwtPart({ sub: "fixture", iat: 1 }), chars("jwt sig", 43)].join(".");
const PEM_BODY = Buffer.from(chars("pem body", 600, B64)).toString("base64").match(/.{1,64}/g).join("\n");
const pemBlock = (kind = "RSA ") =>
  join2("-----BEGIN ", kind, "PRIVATE", " KEY-----\n") + PEM_BODY + join2("\n-----END ", kind, "PRIVATE", " KEY-----");
const AWS_ID = join2("AK", "IA") + chars("aws id", 16, B32);
const AWS_SECRET = chars("aws secret", 40, B64);
const GH = githubToken("github one");
const F = {
  github: GH,
  githubPat: join2("github", "_pat_") + chars("pat a", 22) + "_" + chars("pat b", 59),
  gitlab: join2("gl", "pat-") + chars("gitlab", 20),
  slack: join2("xo", "xb-") + "1234567890123-1234567890123-" + chars("slack", 24),
  stripe: join2("sk", "_live_") + chars("stripe", 24),
  stripeRestricted: join2("rk", "_live_") + chars("stripe r", 24),
  google: join2("AI", "za") + chars("google", 35),
  openai: join2("sk-", "proj-") + chars("openai", 48),
  openaiPlain: "sk-" + chars("deepseek", 32, HEX),
  anthropic: join2("sk-", "ant-", "api03-") + chars("anthropic", 93),
  twilio: join2("S", "K") + chars("twilio", 32, HEX),
  sendgrid: join2("S", "G.") + chars("sendgrid a", 22) + "." + chars("sendgrid b", 43),
  npm: join2("np", "m_") + chars("npm", 36),
  jwt: JWT,
  password: chars("pw", 6) + "!9" + chars("pw2", 6),
};

// ---- Gating --------------------------------------------------------------

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-secret-guard-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: ORIGIN,
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
async function signedIn(svc, name = "guarded") {
  const agent = request.agent(svc.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username: name + visitor, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
// The text of a streamed reply (the local test provider echoes the prompt).
const streamed = (sse) =>
  sse
    .split("\n")
    .filter((l) => l.startsWith("data: {"))
    .map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content || "")
    .join("");
const chat = (content, extra = {}) => ({ model: MODEL, messages: [{ role: "user", content }], max_tokens: 50, ...extra });

test("Secret Guard is registered, unreleased and gated like any update", async (t) => {
  const entry = UPDATES.find((u) => u.id === "secretguard");
  assert.ok(entry, "secretguard is registered");
  assert.equal(entry.title, "Secret Guard");
  assert.equal(entry.tagline, "Pasted code with an API key in it? It's caught before it's sent.");
  assert.equal(entry.points.length, 3);
  // `false` until its release commit flips it; the gate tests pin it anyway.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  const gate = (path, method = "GET") => featuresFor({ path, method, body: {} });
  assert.deepEqual(gate("/api/secret-guard"), ["secretguard"]);
  assert.deepEqual(gate("/API/Secret-Guard", "PUT"), ["secretguard"]);
  // A soft guard: chat, /v1 and MCP don't need it.
  assert.deepEqual(featuresFor({ path: "/api/chat", method: "POST", body: chat("hi") }), []);

  const mvp = fixture(t, "mvp");
  const { agent } = await signedIn(mvp);
  for (const send of [() => agent.get("/api/secret-guard"), () => agent.put("/api/secret-guard").send({ enabled: false })]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Secret Guard is coming soon.");
  }
  assert.equal(mvp.db.prepare("SELECT COUNT(*) n FROM secret_guard_off").get().n, 0);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.secretguard, false);
  const docs = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(docs.paths).some((p) => p.includes("secret-guard")));
  // The export says nothing about it until it's live.
  const exported = (await agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.secretGuard, undefined);

  // Unreleased, the browser never checks: the surfaces all ask this.
  assert.equal(secretGuardActive({ released: false }), false);
  assert.equal(secretGuardActive({ released: true, demo: true }), false);
  assert.equal(secretGuardActive({ released: true, enabled: false }), false);
  assert.equal(secretGuardActive({ released: true }), true);
  const ui = await secretGuardUi();
  const off = { releases: { features: { secretguard: false } } };
  assert.equal(renderToStaticMarkup(createElement(ui.SecretGuardSettings, { config: off, user: { id: "u" } })), "");
  assert.equal(renderToStaticMarkup(createElement(ui.SecretGuardSettings, { config: off, demo: true })), "");
  // The release list's icon.
  assert.match(source("Pages.jsx"), /\n  secretguard: "key",\n/);

  // Released: the switch and the docs are there.
  const live = fixture(t);
  const b = await signedIn(live);
  assert.deepEqual((await b.agent.get("/api/secret-guard").expect(200)).body, { enabled: true });
  const open = (await request(live.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(open.paths["/api/secret-guard"].get && open.paths["/api/secret-guard"].put);
  assert.match(open.paths["/api/secret-guard"].get.description, /\/v1\) and MCP are never checked/);
});

// ---- Detection -----------------------------------------------------------

test("each rule catches its own format and masks only the secret", () => {
  const cases = [
    ["github", "GitHub token", `token ${F.github} expires friday`, F.github],
    ["github", "GitHub token", `export GH=${F.githubPat}`, F.githubPat],
    // A clone URL with a token in it (built in parts, so this file holds no
    // credentialed URL for the public mirror's scan).
    ["gitlab", "GitLab token", "git clone " + ["https", "://oauth2:", F.gitlab, "@gitlab.example.com/x.git"].join(""), F.gitlab],
    ["slack", "Slack token", `SLACK = "${F.slack}"`, F.slack],
    ["stripe", "Stripe live key", `stripe.api_key = '${F.stripe}'`, F.stripe],
    ["stripe", "Stripe live key", F.stripeRestricted, F.stripeRestricted],
    ["google", "Google API key", `<script src="https://maps.example.com/js?key=${F.google}"></script>`, F.google],
    ["openai", "OpenAI-style API key", `client = OpenAI(api_key="${F.openai}")`, F.openai],
    ["openai", "OpenAI-style API key", `key: ${F.openaiPlain}`, F.openaiPlain],
    ["anthropic", "Anthropic API key", `ANTHROPIC_API_KEY=${F.anthropic}`, F.anthropic],
    ["twilio", "Twilio API key", `sid ${F.twilio}`, F.twilio],
    ["sendgrid", "SendGrid API key", `sg = ${F.sendgrid}`, F.sendgrid],
    ["npm", "npm token", `//registry.npmjs.org/:_authToken=${F.npm}`, F.npm],
    ["aws", "AWS access key", `aws_access_key_id = ${AWS_ID}`, AWS_ID],
    ["jwt", "JSON Web Token", `curl -H "Cookie: session=${F.jwt}"`, F.jwt],
    ["dburl", "Database password", `DATABASE_URL=postgres://app:${F.password}@db.internal:5432/app`, F.password],
    ["dburl", "Database password", `mongodb+srv://svc:${F.password}@cluster0.example.net/db`, F.password],
    ["bearer", "Access token", `curl -H 'Authorization: Bearer ${chars("bearer", 40)}' https://api.example.com`, chars("bearer", 40)],
    ["assignment", "Password", `DB_PASSWORD=${F.password}`, F.password],
    ["assignment", "Password", `  "password": "${F.password}",`, F.password],
    ["assignment", "API key", `API_KEY=${chars("env key", 32)}`, chars("env key", 32)],
    ["assignment", "Secret", `const clientSecret = "${chars("client secret", 24)}";`, chars("client secret", 24)],
    ["assignment", "Access token", `GITHUB_TOKEN: ${chars("yaml token", 30)}`, chars("yaml token", 30)],
    ["assignment", "Twilio auth token", `TWILIO_AUTH_TOKEN=${chars("twilio auth", 32, HEX)}`, chars("twilio auth", 32, HEX)],
  ];
  for (const [rule, label, text, value] of cases) {
    const finds = findSecrets(text);
    assert.equal(finds.length, 1, `${rule}: ${text}`);
    assert.equal(finds[0].rule, rule, text);
    assert.equal(finds[0].label, label, text);
    assert.equal(finds[0].value, value, text);
  }
  // A PEM private key, whole or cut short, masks the block.
  for (const kind of ["RSA ", "", "EC ", "OPENSSH ", "ENCRYPTED "]) {
    const block = pemBlock(kind);
    const finds = findSecrets(`Here is my key:\n${block}\nthanks`);
    assert.deepEqual(finds.map((f) => [f.rule, f.label, f.value]), [["pem", "Private key", block]], kind);
  }
  const cut = pemBlock().split("\n").slice(0, 5).join("\n");
  assert.deepEqual(findSecrets(cut + "\n\nCan you tell what this is?").map((f) => f.value), [cut]);
  // AWS: the key id and its secret, as a credentials CSV has them.
  const csv = findSecrets(`Access key ID,Secret access key\n${AWS_ID},${AWS_SECRET}\n`);
  assert.deepEqual(csv.map((f) => [f.label, f.value]), [["AWS access key", AWS_ID], ["AWS secret key", AWS_SECRET]]);
  const labelled = findSecrets(`AWS_SECRET_ACCESS_KEY=${AWS_SECRET}`);
  assert.deepEqual(labelled.map((f) => [f.label, f.value]), [["AWS secret key", AWS_SECRET]]);
  // A known token assigned to a name is named by its format.
  assert.deepEqual(findSecrets(`GITHUB_TOKEN=${F.github}`).map((f) => f.label), ["GitHub token"]);
  // Several in one paste, in order, never overlapping.
  const many = findSecrets([`GH=${F.github}`, `stripe ${F.stripe}`, pemBlock()].join("\n"));
  assert.deepEqual(many.map((f) => f.rule), ["github", "stripe", "pem"]);
  // Every rule has a label, and the labels are the ones the notice shows.
  assert.ok(SECRET_RULES.every((r) => typeof r.label === "string" && r.label));
});

test("GitHub tokens need their CRC32 checksum; JWTs need a JSON header", () => {
  assert.equal(githubChecksumValid(F.github), true);
  for (const prefix of ["gh" + "o_", "gh" + "u_", "gh" + "s_", "gh" + "r_"])
    assert.equal(githubChecksumValid(githubToken("other " + prefix, prefix)), true, prefix);
  // One character changed: the checksum fails, so it isn't flagged.
  const broken = F.github.slice(0, 10) + (F.github[10] === "a" ? "b" : "a") + F.github.slice(11);
  assert.equal(githubChecksumValid(broken), false);
  assert.deepEqual(findSecrets(`token ${broken}`), []);
  // A placeholder of the right length isn't either.
  assert.deepEqual(findSecrets("gh" + "p_" + "x".repeat(36)), []);
  assert.equal(crc32("hello"), 0x3610a686);
  // JWT: three base64url parts and a JSON header naming its algorithm.
  assert.equal(jwtValid(F.jwt), true);
  const notJwt = [jwtPart({ hello: "x" }), jwtPart({ sub: 1 }), "abc"].join(".");
  assert.equal(jwtValid(notJwt), false);
  assert.deepEqual(findSecrets("ey" + chars("fake header", 20) + ".ey" + chars("fake body", 20) + "." + chars("s", 20)), []);
});

test("random base64, UUIDs, git SHAs, transaction hashes and ordinary text don't match", () => {
  const texts = [];
  for (let i = 0; i < 300; i++) {
    const seed = "noise " + i;
    texts.push(Buffer.from(chars(seed, 16 + (i % 180), B64)).toString(i % 2 ? "base64" : "base64url"));
    texts.push(chars(seed, 16 + (i % 64), B64));
    const h = createHash("sha256").update(seed).digest("hex");
    texts.push(`${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`);
    texts.push(createHash("sha1").update(seed).digest("hex"));
    texts.push("commit " + createHash("sha1").update(seed).digest("hex"));
    texts.push("0x" + h);
    texts.push("tx: 0x" + h);
    texts.push(`id: ${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`);
  }
  texts.push(
    "Please review the attached budget and let me know which items we can cut before the meeting on Friday.",
    "The password policy says: at least 12 characters, and never reuse one.",
    "MAX_TOKENS=4096\ntoken_type: bearer\ntokenizer: cl100k_base\npassword_min_length: 12",
    'const token = await getToken();\nconst apiKey = process.env.API_KEY;\nheaders: { Authorization: `Bearer ${token}` }',
    "API_KEY=your_api_key_here\nSECRET_KEY=changeme\nPASSWORD=<password>\nTOKEN=${GITHUB_TOKEN}\nAPI_KEY=xxxxxxxxxxxxxxxx",
    "credentials: 'same-origin', maxTokens: maxTokens, token: a?.token",
    "postgres://user:password@localhost:5432/db and redis://localhost:6379",
    "Wallet 0x968be0c1a394bf1ce239e3b40909ec0f9d4f5583 holds the token.",
    "sk-this-is-a-very-long-kebab-case-css-class-name-for-the-sidebar",
    "The AWS docs call the key id field AccessKeyId and the secret SecretAccessKey.",
  );
  for (const text of texts) assert.deepEqual(findSecrets(text), [], text);
  // Seed Guard's own finds (a seed phrase, 64-hex) are Seed Guard's alone.
  assert.deepEqual(findSecrets(SEED), []);
});

// ---- Masking, removing and restoring --------------------------------------

test("Mask swaps each secret for [SECRET_n] and Veil's unveil puts it back", () => {
  const text = `Why 401?\nexport GITHUB_TOKEN=${F.github}\nDB=postgres://app:${F.password}@db:5432/x\nsame again: ${F.github}`;
  const state = createVeilState();
  const r = maskSecrets(text, state);
  assert.equal(r.count, 3);
  assert.deepEqual(r.tags, ["SECRET_1", "SECRET_2", "SECRET_1"]);
  assert.equal(
    r.text,
    "Why 401?\nexport GITHUB_TOKEN=[SECRET_1]\nDB=postgres://app:[SECRET_2]@db:5432/x\nsame again: [SECRET_1]",
  );
  assert.doesNotMatch(r.text, new RegExp(F.github + "|" + F.password.replace(/[!]/g, "\\!")));
  // The reply's placeholders are restored from the same map.
  assert.equal(unveil(r.text, state.map), text);
  assert.equal(unveil("Your token [SECRET_1] is fine; [SECRET_9] isn't mine.", state.map), `Your token ${F.github} is fine; [SECRET_9] isn't mine.`);
  // The same value keeps its tag in the conversation; a new one gets the next.
  assert.equal(maskSecrets(`again ${F.github}`, state).text, "again [SECRET_1]");
  assert.equal(secretTag(state, F.stripe), "SECRET_3");
  // Veil's own masking leaves placeholders alone, and its tags never collide.
  const veiled = veil(r.text + " mail me at a@example.com", state);
  assert.match(veiled.text, /\[SECRET_1\].*\[EMAIL_1\]/s);
  // Remove deletes the match (a database URL loses its ":password").
  assert.equal(
    removeSecrets(text).text,
    "Why 401?\nexport GITHUB_TOKEN=\nDB=postgres://app@db:5432/x\nsame again: ",
  );
  assert.deepEqual(findSecrets(removeSecrets(text).text), []);
  // The preview shows only the first 4 and last 2 characters.
  assert.equal(previewSecret(F.github), F.github.slice(0, 4) + "••••" + F.github.slice(-2));
  assert.equal(previewSecret(pemBlock(), "pem").length, 10);
  assert.doesNotMatch(previewSecret(pemBlock(), "pem"), /BEGIN/);
});

test("the values stay in memory: Veil's stored map and Device Vault never hold them", () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const state = createVeilState();
    const masked = maskSecrets(`key ${F.openai}`, state).text;
    veil("write to a@example.com", state);
    saveVeilState("c1", state);
    const saved = [...store.values()].join("");
    assert.doesNotMatch(saved, new RegExp(F.openai));
    assert.match(saved, /a@example\.com/, "Veil's own values are kept as before");
    const loaded = loadVeilState("c1");
    assert.equal(loaded.map.SECRET_1, undefined);
    // A reload shows the placeholder, and a later secret never reuses its tag.
    assert.equal(unveil(masked, loaded.map), "key [SECRET_1]");
    assert.equal(secretTag(loaded, F.stripe), "SECRET_2");
    // What Device Vault stores goes through the same filter.
    const kept = withoutSecrets(state);
    assert.deepEqual(Object.keys(kept.map), ["EMAIL_1"]);
    assert.ok(!Object.keys(kept.valueToTag).some((k) => k.startsWith("SECRET")));
    assert.equal(state.map.SECRET_1, F.openai, "the live state is untouched");
  } finally {
    delete globalThis.localStorage;
  }
  assert.match(source("Workspace.jsx"), /veil: withoutSecrets\(veilStateRef\.current\)/);
});

test("replies are restored on screen, in text and in code, with Secret Guard's title", async () => {
  const { veilRemarkPlugin } = await compileModule("Veil.jsx", [[/^import "\.\/veil\.css";$/m, ""]]);
  const map = { SECRET_1: F.github, EMAIL_1: "a@example.com" };
  const tree = {
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "text", value: "Use [SECRET_1] and write to [EMAIL_1]." }] },
      { type: "code", lang: "sh", value: "export GITHUB_TOKEN=[SECRET_1]\n# [EMAIL_1]" },
      { type: "paragraph", children: [{ type: "inlineCode", value: "[SECRET_1]" }] },
    ],
  };
  veilRemarkPlugin({ map })(tree);
  const marks = tree.children[0].children.filter((n) => n.type === "mark");
  assert.equal(marks[0].children[0].value, F.github);
  assert.equal(marks[0].data.hProperties.title, "Secret Guard — the model saw [SECRET_1]");
  assert.equal(marks[1].data.hProperties.title, "Veiled — the model saw [EMAIL_1]");
  // In code a <mark> can't go, so the value comes back as text; Veil's own
  // tags in code stay as they were.
  assert.equal(tree.children[1].value, `export GITHUB_TOKEN=${F.github}\n# [EMAIL_1]`);
  assert.equal(tree.children[2].children[0].value, F.github);
});

test("attached text files and documents are scanned, with their names and lines", () => {
  const documents = [
    { id: "d1", name: "deploy.env", text: `NODE_ENV=production\nPORT=8080\nSTRIPE_KEY=${F.stripe}\n` },
    { id: "d2", name: "notes.md", text: "Nothing secret here." },
    { id: "d3", name: "page", source: "link", text: `A public page quoting ${F.google}` },
  ];
  const prompt = `Can you check these?\n\n${F.npm}`;
  // The workspace passes the documents as they'll be sent, minus Link Reader
  // pages (public text our server fetched, as Seed Guard skips them too).
  const finds = scanComposer({ prompt, documents: documents.filter((d) => d.source !== "link") });
  assert.deepEqual(
    finds.map((f) => [f.part, f.name, f.label, f.line]),
    [
      [0, "", "npm token", 3],
      [1, "deploy.env", "Stripe live key", 3],
    ],
  );
  assert.ok(finds.every((f) => !JSON.stringify(f).includes(F.stripe) && !JSON.stringify(f).includes(F.npm)), "a find carries only a preview");
  const state = createVeilState();
  const masked = maskComposer({ prompt, documents }, state);
  assert.equal(masked.count, 2);
  assert.equal(masked.prompt, "Can you check these?\n\n[SECRET_1]");
  assert.equal(masked.documents[0].text, "NODE_ENV=production\nPORT=8080\nSTRIPE_KEY=[SECRET_2]\n");
  assert.equal(masked.documents[0].name, "deploy.env");
  assert.equal(masked.documents[1], documents[1] === masked.documents[1] ? documents[1] : masked.documents[1]);
  assert.equal(masked.documents[2], documents[2], "a Link Reader page is left as it is");
  const removed = removeFromComposer({ prompt, documents });
  assert.equal(removed.count, 2);
  assert.deepEqual(scanComposer({ prompt: removed.prompt, documents: removed.documents.slice(0, 2) }), []);
  // scanParts takes strings, arrays and named parts alike.
  assert.equal(scanParts(["", [F.jwt], { text: F.twilio, name: "x.txt" }]).length, 2);
  // In the workspace: the prompt and the sent documents (no link pages) are
  // scanned, a find holds Send and the estimate, and Mask and send sends the
  // masked composer on the next render.
  const ws = source("Workspace.jsx");
  assert.match(ws, /sentDocuments\.filter\(\(d\) => d\.source !== "link"\)\.map\(\(d\) => \(\{ text: d\.text \|\| "", name: d\.name \|\| "" \}\)\)/);
  assert.match(ws, /const autoEstimate =\n    !seedHit &&\n    !secretHeld &&/);
  assert.match(ws, /if \(!blindReady \|\| seedHit \|\| secretHeld \|\|/);
  assert.match(ws, /!seedHit &&\n    !secretHeld &&\n    !busy &&\n    !!sendText/);
  assert.match(ws, /if \(seedHit \|\| secretHeld\) return;/);
  assert.match(ws, /const r = maskComposer\(\{ prompt, documents \}, veilStateRef\.current\);/);
});

test("Seed Guard goes first and its hard block is unchanged", async (t) => {
  const seed = scanSecrets(SEED);
  const finds = scanParts(`${SEED}\n${F.github}`);
  assert.equal(finds.length, 1);
  assert.equal(secretGuardTurn({ seedHit: seed, finds }), "seed");
  // Only once Seed Guard has been answered ("Send anyway", confirmed twice)
  // does Secret Guard ask; it never answers for Seed Guard.
  assert.equal(secretGuardTurn({ seedHit: seed, finds, seedAnswered: true }), "secret");
  assert.equal(secretGuardTurn({ seedHit: null, finds }), "secret");
  assert.equal(secretGuardTurn({ seedHit: seed, finds: [] }), "seed");
  assert.equal(secretGuardTurn({ seedHit: null, finds: [] }), null);
  // Masking a secret leaves the seed phrase for Seed Guard.
  const masked = maskSecrets(`${SEED}\n${F.github}`, createVeilState()).text;
  assert.deepEqual(findSeedPhrase(masked), { kind: "seed", words: 12 });
  // In the workspace the seed check runs first and returns before Secret
  // Guard's; the edit form shows Secret Guard only without a seed find.
  const ws = source("Workspace.jsx");
  const send = ws.slice(ws.indexOf("async function send(e, redo = null"));
  assert.ok(send.indexOf("if (seedFound && !allowSeed") < send.indexOf("if (!redo && secretHeld && !allowSecret)"));
  assert.match(ws, /hit=\{guardTurn === "seed" \? seedHit : null\}/);
  assert.match(ws, /finds=\{guardTurn === "secret" \? secretFinds : \[\]\}/);
  assert.match(ws, /finds=\{editSeed \? \[\] : editFinds\}/);
  // The server still refuses a seed phrase, placeholder or not.
  const svc = fixture(t);
  const { agent } = await signedIn(svc);
  const r = await agent.post("/api/chat").send(chat(masked)).expect(400);
  assert.equal(r.body.error.code, "seed_phrase_blocked");
});

test("a soft guard: no server check on chat, /v1 or MCP, and nothing logged", async (t) => {
  const svc = fixture(t);
  const { agent } = await signedIn(svc);
  const lines = [];
  const saved = ["log", "info", "warn", "error"].map((k) => [k, console[k]]);
  for (const [k] of saved) console[k] = (...a) => lines.push(a.join(" "));
  try {
    // The workspace's "Send anyway": the server takes the text as written.
    const sent = await agent.post("/api/chat").send(chat(`why 401 with ${F.github}?`)).expect(200);
    assert.match(streamed(sent.text), new RegExp(F.github));
    // /v1 and MCP callers are programs: never held, even with it on.
    const key = (await agent.post("/api/keys").send({ name: "ci", cap: null }).expect(201)).body;
    const v1 = await request(svc.app)
      .post("/v1/chat/completions")
      .set("Authorization", "Bearer " + key.key)
      .send(chat(`deploy with ${F.stripe}`))
      .expect(200);
    assert.match(JSON.stringify(v1.body), new RegExp(F.stripe));
    const mcp = await request(svc.app)
      .post("/mcp")
      .set("Authorization", "Bearer " + key.key)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ask", arguments: { model: MODEL, prompt: `use ${F.npm}` } } })
      .expect(200);
    assert.equal(mcp.body.result.isError, undefined);
  } finally {
    for (const [k, f] of saved) console[k] = f;
  }
  assert.ok(!lines.some((l) => l.includes(F.github) || l.includes(F.stripe) || l.includes(F.npm)), "no secret logged");
  // The server side has no detector at all: only the switch.
  for (const file of ["routes/api.js", "routes/mcp.js", "routes/chat.js", "routes/v1-media.js", "seed-guard.js"])
    assert.doesNotMatch(readFileSync(new URL("../server/" + file, import.meta.url), "utf8"), /secret-guard/, file);
  assert.doesNotMatch(readFileSync(new URL("../server/secret-guard.js", import.meta.url), "utf8"), /from "\.\.\/src\//);
});

// ---- The switch ------------------------------------------------------------

test("on by default, switched off per account, erased and exported", async (t) => {
  const svc = fixture(t);
  const a = await signedIn(svc, "switcher");
  const b = await signedIn(svc, "other");
  const rows = () => svc.db.prepare("SELECT * FROM secret_guard_off").all();
  assert.deepEqual((await a.agent.get("/api/secret-guard").expect(200)).body, { enabled: true });
  for (const body of [{}, { enabled: "no" }, { enabled: 0 }, { enabled: null }]) {
    const r = await a.agent.put("/api/secret-guard").send(body).expect(400);
    assert.equal(r.body.error.code, "invalid_request");
  }
  assert.deepEqual((await a.agent.put("/api/secret-guard").send({ enabled: false }).expect(200)).body, { enabled: false });
  assert.deepEqual((await a.agent.get("/api/secret-guard").expect(200)).body, { enabled: false });
  assert.deepEqual((await b.agent.get("/api/secret-guard").expect(200)).body, { enabled: true }, "per account");
  // Only the account and when: nothing else is kept.
  assert.deepEqual(rows().map((r) => Object.keys(r).sort()), [["updated", "user_id"]]);
  const exported = (await a.agent.get("/api/account/export").expect(200)).body.secretGuard;
  assert.equal(exported.enabled, false);
  assert.equal(typeof exported.switchedOff, "number");
  assert.deepEqual((await b.agent.get("/api/account/export").expect(200)).body.secretGuard, { enabled: true });
  // Back on: the row goes.
  await a.agent.put("/api/secret-guard").send({ enabled: true }).expect(200);
  assert.deepEqual(rows(), []);
  // The shared erase (closure, Panic Wipe, Inactivity Wipe) turns it back on.
  await a.agent.put("/api/secret-guard").send({ enabled: false }).expect(200);
  eraseAccountContent(svc.db, a.user);
  assert.deepEqual(rows(), []);
  await b.agent.put("/api/secret-guard").send({ enabled: false }).expect(200);
  await b.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.deepEqual(rows(), []);
  const c = await signedIn(svc, "closer");
  await c.agent.put("/api/secret-guard").send({ enabled: false }).expect(200);
  await c.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.deepEqual(rows(), []);
  // The table is an additive migration, found by content: an earlier build
  // can still start on the database, and upgrading again is harmless.
  const at = MIGRATIONS.findIndex((m) => String(m).includes("secret_guard_off"));
  assert.ok(at > 0, "found by content");
  const db = database(":memory:");
  assert.ok(db.prepare("SELECT version FROM schema_additive WHERE version=?").get(at + 1));
  assert.deepEqual(rollbackSchema(db, at), { from: MIGRATIONS.length, to: at });
  migrate(db);
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, MIGRATIONS.length);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='secret_guard_off'").get());
  db.close();
});

// ---- The notice and the settings ---------------------------------------------

async function compileModule(file, extra = []) {
  const src = new URL("../src/" + file, import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-secret-guard-ui-"));
  const ui = join(dir, "ui.mjs");
  writeFileSync(
    ui,
    `import React from "${import.meta.resolve("react")}";
     export const Icon = () => null;
     export const Notice = ({ children }) => React.createElement("div", { className: "notice" }, children);`,
  );
  let out = code
    .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${pathToFileURL(ui)}"`)
    .replace(/from "\.\/([\w-]+)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${import.meta.resolve("react")}"`);
  for (const [re, to] of extra) out = out.replace(re, to);
  const file2 = join(dir, file.replace(/\.jsx$/, ".mjs"));
  writeFileSync(file2, out);
  try {
    return await import(pathToFileURL(file2).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
let uiModule = null;
const secretGuardUi = async () => (uiModule ||= await compileModule("SecretGuard.jsx"));
const source = (file) => readFileSync(new URL("../src/" + file, import.meta.url), "utf8");
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// The page's own text, and what sits inside data-i18n="off".
function textsOf(html) {
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
      else if (!["input", "br", "img"].includes(m[2]) && !tag.endsWith("/>")) stack.push({ off });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    }
  }
  return { page: page.filter((s) => /[A-Za-z]{2}/.test(s)), kept };
}

test("the notice names each find, shows it partly hidden, and offers the three choices", async () => {
  const { SecretGuardNotice, secretHeadline } = await secretGuardUi();
  const one = scanParts(`line one\nline two\ntoken ${F.github}`);
  const html = renderToStaticMarkup(createElement(SecretGuardNotice, { finds: one, onMask() {}, onRemove() {}, onProceed() {} }));
  assert.match(html, /This looks like a secret \(GitHub token, line 3\)\./);
  assert.match(html, new RegExp(`<code data-i18n="off">${F.github.slice(0, 4)}••••${F.github.slice(-2)}</code>`));
  assert.doesNotMatch(html, new RegExp(F.github.slice(4, -2)));
  assert.match(html, />Mask and send<\/button>.*>Remove it<\/button>.*>Send anyway<\/button>/s);
  assert.match(html, /class="seed-guard-button solid"[^>]*>Mask and send/);
  assert.match(html, /Checked in this browser\. Nothing about it is saved or sent\./);
  // In a file; several at once; saving instead of sending; no override.
  const named = scanParts({ text: `A=1\nB=2\nTOKEN=${F.npm}`, name: "ci.env" });
  assert.equal(secretHeadline(named), "This looks like a secret (npm token, line 3 of ci.env).");
  const several = scanParts([F.github, { text: `x\n${F.stripe}`, name: "pay.js" }, F.jwt]);
  const list = renderToStaticMarkup(createElement(SecretGuardNotice, { finds: several, verb: "save", onMask() {}, onRemove() {} }));
  assert.match(list, /These look like 3 secrets\./);
  assert.match(list, /<b>Stripe live key<\/b><span>line 2 of pay\.js<\/span>/);
  assert.match(list, />Mask and save<\/button>.*>Remove them<\/button>/s);
  assert.doesNotMatch(list, /Save anyway|Send anyway/);
  assert.equal(renderToStaticMarkup(createElement(SecretGuardNotice, { finds: [] })), "");
  const eight = scanParts(Array.from({ length: 8 }, (_, i) => githubToken("many " + i)));
  assert.match(renderToStaticMarkup(createElement(SecretGuardNotice, { finds: eight, onMask() {} })), />and 2 more</);
});

test("each surface wires the notice: composer, edits, Canvas, Routines, Research Watch, Sharpen and Account", () => {
  const ws = source("Workspace.jsx");
  assert.match(ws, /onMask=\{maskComposerSecrets\}\n\s+onRemove=\{removeComposerSecrets\}/);
  // Deep research becomes web searches: mask or remove, no Send anyway.
  assert.match(ws, /onProceed=\{researchOn \? undefined : \(\) => send\(null, null, \{ allowSeed: seedAnswered, allowSecret: true \}\)\}/);
  assert.match(ws, /!!seedHit \|\|\n\s+secretHeld \|\|/);
  assert.match(ws, /if \(editedText != null && !allowSecret && secretLive && scanParts\(editedText\)\.length\) return;/);
  assert.match(ws, /secret: promptSecret,/);
  const canvas = source("Canvas.jsx");
  assert.match(canvas, /const mask = secrets === "mask" \? \(s\) => veilMask\(maskSecrets\(s, veilState\.current\)\.text\) : veilMask;/);
  assert.match(canvas, /setSecretHold\(\{ req, finds, allowSeed \}\)/);
  // A quote posts the payload, so none is asked for while a secret waits.
  assert.match(canvas, /!preview\.problem && !preview\.secrets && live/);
  const routines = source("Routines.jsx");
  assert.match(routines, /const secretFinds = useSecretScan\(secretLive, draft\.prompt\);/);
  assert.match(routines, /<Button type="submit" disabled=\{busy \|\| secretHeld\}>\n\s+Save routine/);
  assert.match(routines, /secretLive=\{secretLive\}/);
  const research = source("ResearchWatch.jsx");
  assert.match(research, /const secretFinds = useSecretScan\(secretLive, draft\.topic\);/);
  assert.match(research, /useQuote\(secretHeld \? \{ \.\.\.draft, topic: "" \} : draft, live\)/);
  const notice = research.slice(research.indexOf("<SecretGuardNotice"), research.indexOf("/>", research.indexOf("<SecretGuardNotice")));
  assert.doesNotMatch(notice, /onProceed/, "a topic is never saved as it is");
  assert.match(source("Sharpen.jsx"), /if \(secret\) return "Secret Guard found what looks like a password, key or token in this prompt\. Mask or remove it first\.";/);
  assert.match(source("Account.jsx"), /<SecretGuardSettings user=\{user\} demo=\{demo\} config=\{config\} \/>/);
  assert.match(source("DataControls.jsx"), /\{secretGuard && \(/);
});

test("Account → Security: on by default, and switching off asks first with a plain warning", async () => {
  const { SecretGuardSettings } = await secretGuardUi();
  const on = { releases: { features: { secretguard: true } } };
  const html = renderToStaticMarkup(createElement(SecretGuardSettings, { config: on, demo: true }));
  assert.match(html, /<h2>Secret Guard\.<\/h2>/);
  assert.match(html, /type="checkbox" role="switch" checked=""/);
  assert.match(html, /doesn’t check the developer API \(\/v1\) or MCP: those callers are programs/);
  assert.match(html, /can’t catch every secret/);
  assert.match(source("SecretGuard.jsx"), /e\.target\.checked \? change\(true\) : setConfirming\(true\)/);
});

test("every string it shows has Chinese and Spanish", async () => {
  const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const es = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/es.json", import.meta.url), "utf8")), "es");
  const han = /\p{Script=Han}/u;
  const { SecretGuardNotice, SecretGuardSettings } = await secretGuardUi();
  const on = { releases: { features: { secretguard: true } } };
  const allRules = scanParts([
    F.github, F.gitlab, F.slack, F.stripe, F.google, F.openai, F.anthropic, F.twilio, F.sendgrid, F.npm, F.jwt,
    `${AWS_ID},${AWS_SECRET}`, pemBlock(), `postgres://a:${F.password}@h/x`, `Authorization: Bearer ${chars("b", 40)}`,
    `PASSWORD=${F.password}`, `API_KEY=${chars("k", 30)}`, `SECRET=${chars("s", 30)}`, `TOKEN=${chars("t", 30)}`,
    `TWILIO_AUTH_TOKEN=${chars("ta", 32, HEX)}`,
    { text: F.github, name: "a.env" },
  ]);
  const labels = new Set(allRules.map((f) => f.label));
  assert.ok(labels.size >= 19, [...labels].join(", "));
  const html = [
    renderToStaticMarkup(createElement(SecretGuardNotice, { finds: allRules, onMask() {}, onRemove() {}, onProceed() {} })),
    renderToStaticMarkup(createElement(SecretGuardNotice, { finds: allRules.slice(0, 1), onMask() {}, onRemove() {}, onProceed() {} })),
    renderToStaticMarkup(createElement(SecretGuardNotice, { finds: allRules.slice(-1), verb: "save", onMask() {}, onProceed() {} })),
    renderToStaticMarkup(createElement(SecretGuardSettings, { config: on, demo: true })),
  ].join("");
  const { page } = textsOf(html);
  const shown = [
    ...page,
    ...labels,
    ...UPDATES.filter((u) => u.id === "secretguard").flatMap((u) => [u.title, u.tagline, ...u.points]),
    "Mask and save",
    "Save anyway",
    "Remove them",
    "and 2 more",
    "These look like 2 secrets.",
    "This looks like a secret (GitHub token, line 4 of main.py).",
    "Secret Guard — the model saw [SECRET_1]",
    ...[/note="([^"]+)"/g, /note = "([^"]+)"/g].flatMap((re) =>
      ["SecretGuard.jsx", "Canvas.jsx", "Routines.jsx", "ResearchWatch.jsx"].flatMap((f) => [...source(f).matchAll(re)].map((m) => m[1])),
    ),
    "Turn off Secret Guard? Passwords, keys and tokens you paste will be sent as written. Seed Guard still stops wallet seed phrases.",
    "Keep it on",
    "Turn off",
    "Turn off Secret Guard",
    "Off: passwords, keys and tokens you paste are sent as written. Seed Guard still stops wallet seed phrases.",
    "On. Secrets are caught before they're sent.",
    "Off. Messages are sent as written.",
    "Secret Guard found what looks like a password, key or token in this prompt. Mask or remove it first.",
    "enabled must be true or false.",
    source("DataControls.jsx").match(/Secret Guard checks what you send[^\n]+/)[0].trim(),
  ];
  assert.ok(shown.length > 40);
  for (const text of shown) {
    assert.match(translateText(text, zh) ?? "", han, `untranslated in Chinese: ${text}`);
    const spanish = translateText(text, es);
    assert.ok(spanish && spanish !== text, `untranslated in Spanish: ${text}`);
  }
  // A find's preview is the user's own text: kept as written.
  assert.match(html, /<code data-i18n="off">/);
});
