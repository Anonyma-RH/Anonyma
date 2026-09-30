import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomBytes, createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { MIGRATIONS, uid, now, balance, addCredit } from "../server/core.js";
import { UPDATES, featuresFor, UNCENSORED_MODELS } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import { knownPage } from "../src/site-routes.js";
import { MODE_FEATURES, modeReleased, messageFromServer, safeNext } from "../src/lib.js";
import { buildChatRequest } from "../src/estimate.js";
import { createVeilState } from "../src/veil.js";
import { vaultChat } from "../src/device-vault.js";
import { withProjectInstructions } from "../src/projects.js";
import { rankTools } from "../src/tool-search.js";
import { paletteActions } from "../src/command-palette.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import {
  MAX_CHARACTERS,
  MAX_CHARACTER_INSTRUCTIONS,
  MAX_CHARACTER_OPENING,
  MAX_AVATAR_BYTES,
  MONOGRAMS,
  SHARE_TOKEN,
  characterBlock,
  characterChatPath,
  characterMode,
  characterModelNote,
  characterPagePath,
  characterProblems,
  characterRequestFields,
  hasOpening,
  initialOf,
  openingMessage,
  parseAvatar,
  parseShareDays,
  shareUrl,
  tokenFromLink,
  withCharacterInstructions,
} from "../src/characters.js";
import { cleanAvatar } from "../server/character-avatar.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const MODEL = "google/gemini-2.5-flash";
// The reference snapshot has no zero-data-retention labels, so one model is
// counted as private through the operator override. It is also one of the
// curated Uncensored models.
const UNCENSORED = "venice/venice-uncensored-1-2";
const SEED =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-characters-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: released ?? "all",
    mvpModels: [MODEL, UNCENSORED],
    privateModels: [UNCENSORED],
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(app, username = "u" + randomBytes(4).toString("hex")) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor % 250}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const make = async (p, body = {}) =>
  (
    await p.agent
      .post("/api/characters")
      .send({
        name: "Ada",
        description: "A stern librarian",
        instructions: "You are Ada, a stern but kind librarian. Keep answers short.",
        opening: "Shh. What are you looking for?",
        ...body,
      })
      .expect(201)
  ).body;
const chat = (extra = {}) => ({
  model: MODEL,
  messages: [{ role: "user", content: "Where are the atlases?" }],
  max_tokens: 50,
  requestId: uid(),
  ...extra,
});
// The conversation a streamed chat saved into, from its final event.
const conversationOf = (text) => {
  let id = null;
  for (const line of text.split("\n"))
    if (line.startsWith("data: {")) {
      const e = JSON.parse(line.slice(6));
      if (e.conversationId) id = e.conversationId;
    }
  return id;
};
const send = async (p, extra, status = 200) => {
  const r = await p.agent.post("/api/chat").send(chat(extra)).expect(status);
  return status === 200 ? conversationOf(r.text) : r.body;
};
const count = (s, table, where = "1", ...args) =>
  s.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...args).n;
const rows = (s, id) =>
  s.db.prepare("SELECT role,content,model,cost FROM messages WHERE conversation_id=? ORDER BY created,rowid").all(id);

// ---- Pictures ----

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, "latin1"), data])), 0);
  return Buffer.concat([head, data, tail]);
};
// A real PNG of `size` x `size` grey pixels, with optional hidden details.
function png(size = 32, { text = null, exif = false } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  const raw = Buffer.alloc((size + 1) * size, 0x80);
  for (let y = 0; y < size; y++) raw[y * (size + 1)] = 0;
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    chunk("IHDR", ihdr),
    ...(text ? [chunk("tEXt", Buffer.from("Author\0" + text, "latin1"))] : []),
    ...(exif ? [chunk("eXIf", Buffer.from("MM\0*\0\0\0\b\0\0", "latin1"))] : []),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
// A JPEG with the parts the stripper reads: an EXIF segment with GPS, a
// comment, a frame header, one scan and the end marker.
function jpeg(width, height, { hidden = true } = {}) {
  const seg = (marker, body) => {
    const b = Buffer.alloc(4 + body.length);
    b[0] = 0xff;
    b[1] = marker;
    b.writeUInt16BE(body.length + 2, 2);
    body.copy(b, 4);
    return b;
  };
  const frame = Buffer.from([8, height >> 8, height & 255, width >> 8, width & 255, 1, 1, 0x11, 0]);
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    ...(hidden ? [seg(0xe1, Buffer.from("Exif\0\0MM\0*\0\0\0\b\0\0", "latin1")), seg(0xfe, Buffer.from("taken at home"))] : []),
    seg(0xc0, frame),
    seg(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([0x12, 0x34, 0x56]),
    Buffer.from([0xff, 0xd9]),
  ]);
}
// A WebP that is a lossless header and a comment-like EXIF chunk.
function webp(width, height, { hidden = true } = {}) {
  const le32 = (n) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const piece = (type, body) => {
    const pad = body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
    return Buffer.concat([Buffer.from(type, "latin1"), le32(body.length), body, pad]);
  };
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0;
  const vp8l = Buffer.concat([Buffer.from([0x2f]), le32(bits), Buffer.alloc(8, 7)]);
  const body = Buffer.concat([
    Buffer.from("WEBP", "latin1"),
    piece("VP8L", vp8l),
    ...(hidden ? [piece("EXIF", Buffer.from("Exif\0\0MM\0*\0\0\0\b\0\0", "latin1"))] : []),
  ]);
  return Buffer.concat([Buffer.from("RIFF", "latin1"), le32(body.length), body]);
}
const dataUrl = (bytes, type = "image/png") => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const decode = (url) => Buffer.from(url.split(",")[1], "base64");
const has = (buf, needle) => buf.includes(Buffer.from(needle, "latin1"));

// ---- The release gate ----

test("Characters is registered, unreleased and gated like any update", async (t) => {
  const entry = UPDATES.find((u) => u.id === "characters");
  assert.ok(entry, "characters is registered");
  assert.equal(entry.title, "Characters");
  assert.equal(entry.tagline, "Make your own AI characters, with a name, a face and a personality.");
  assert.equal(entry.points.length, 3);
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  const gate = (path, method = "GET", body = {}, query) => featuresFor({ path, method, body, query });
  for (const path of [
    "/api/characters",
    "/API/Characters/chr_1",
    "/api/characters/chr_1/shares",
    "/api/characters/chr_1/duplicate",
    "/api/character-shares/chr_1",
    "/api/character-shares/abc/import",
  ])
    assert.deepEqual(gate(path, "POST"), ["characters"], path);
  // A chat filed with a character needs the update; nothing else does.
  assert.deepEqual(gate("/api/chat", "POST", { character: "chr_1" }), ["characters"]);
  assert.deepEqual(gate("/api/chat", "POST", { character: "chr_1", mode: "uncensored" }), ["characters", "uncensored"]);
  assert.deepEqual(gate("/api/chat", "POST", {}), []);
  for (const path of ["/api/conversations", "/api/projects", "/api/account/export"])
    assert.ok(!gate(path).includes("characters"), path);
  // A default model in the Uncensored section also needs that update.
  assert.deepEqual(gate("/api/characters", "POST", { model: MODEL }), ["characters"]);
  assert.deepEqual(gate("/api/characters", "POST", { model: UNCENSORED }), ["characters", "uncensored"]);
  assert.deepEqual(gate("/api/characters/chr_1", "PATCH", { model: UNCENSORED }), ["characters", "uncensored"]);
  assert.ok(UNCENSORED_MODELS.includes(UNCENSORED));

  // Unreleased: every route is refused before authentication, the page is
  // unknown, nothing is exported and the API contract leaves it out.
  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app, "ana");
  for (const send of [
    () => a.agent.get("/api/characters"),
    () => a.agent.post("/api/characters").send({ name: "Ada" }),
    () => a.agent.get("/api/characters/chr_x"),
    () => a.agent.patch("/api/characters/chr_x").send({ name: "Ada" }),
    () => a.agent.delete("/api/characters/chr_x"),
    () => a.agent.post("/api/characters/chr_x/duplicate").send({}),
    () => a.agent.post("/api/characters/chr_x/shares").send({}),
    () => a.agent.get("/api/characters/chr_x/shares"),
    () => a.agent.delete("/api/character-shares/chs_x"),
    () => a.agent.get("/api/character-shares/" + "a".repeat(43)),
    () => a.agent.post("/api/character-shares/" + "a".repeat(43) + "/import").send({}),
    () => a.agent.post("/api/chat").send(chat({ character: "chr_x" })),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Characters is coming soon.");
  }
  await request(mvp.app).get("/api/characters").expect(403);
  assert.equal(count(mvp, "characters"), 0);
  assert.equal(count(mvp, "holds"), 0, "a refused chat reserves nothing");
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.characters, false);
  assert.equal(config.releases.updates.find((u) => u.id === "characters").released, false);
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(closed.paths).some((p) => p.includes("character")));
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.ok(!("characters" in exported), "no characters key while unreleased and empty");
  const listed = (await a.agent.get("/api/conversations").expect(200)).body.data;
  assert.ok(listed.every((c) => !("character_id" in c)));
  // The page and its mode: a 404 before release, served after it.
  assert.equal(knownPage("/workspace/characters", {}), false);
  assert.equal(knownPage("/workspace/characters", { characters: true }), true);
  assert.equal(modeReleased({ releases: { features: {} } }, "characters"), false);
  assert.equal(modeReleased({ releases: { features: { characters: true } } }, "characters"), true);
  assert.equal(MODE_FEATURES.characters, "characters");
  await request(mvp.app).get("/workspace/characters").expect(404);

  // Released on its own, it needs nothing else.
  const own = fixture(t, "mvp,characters");
  const b = await person(own.app, "ben");
  await make(b);
  await request(own.app).get("/api/characters").expect(401);
  await request(own.app).get("/workspace/characters").expect(200);
  const open = (await request(own.app).get("/api/openapi.json").expect(200)).body;
  for (const [path, methods] of [
    ["/api/characters", ["get", "post"]],
    ["/api/characters/{id}", ["get", "patch", "delete"]],
    ["/api/characters/{id}/duplicate", ["post"]],
    ["/api/characters/{id}/shares", ["get", "post"]],
    ["/api/character-shares/{id}", ["delete"]],
    ["/api/character-shares/{token}", ["get"]],
    ["/api/character-shares/{token}/import", ["post"]],
  ])
    for (const m of methods) assert.ok(open.paths[path]?.[m], `${m} ${path}`);
  assert.match(open.components.schemas.ChatRequest.properties.character.description, /opening message/);
  // An Uncensored default needs that update too.
  await b.agent.post("/api/characters").send({ name: "Wild", model: UNCENSORED }).expect(403);
  const both = fixture(t, "mvp,characters,uncensored");
  const c = await person(both.app);
  const wild = await make(c, { name: "Wild", model: UNCENSORED });
  assert.equal(wild.model, UNCENSORED);
  // The migration is appended, found by what it creates: it comes after the
  // one before it in the list, and nothing is assumed about what follows.
  const db = new DatabaseSync(":memory:");
  const made = [];
  for (let v = 0; v < MIGRATIONS.length; v++) {
    MIGRATIONS[v](db);
    db.exec(`PRAGMA user_version=${v + 1}`);
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='character_shares'").get()) made.push(v);
    if (made.length === 1 && made[0] === v) break;
  }
  db.close();
  assert.equal(made.length, 1, "one migration creates the tables");
  assert.ok(made[0] >= 1, "it is not the first");
  assert.equal(
    count(own, "sqlite_master", "name IN ('characters','character_chats','character_shares')"),
    3,
  );
});

// ---- Making, editing, duplicating and deleting ----

test("make, list, edit, duplicate and delete a character; only its owner can", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  const ada = await make(a, { model: MODEL, avatar: "mono:navy" });
  assert.match(ada.id, /^chr_/);
  assert.deepEqual(
    { name: ada.name, model: ada.model, avatar: ada.avatar, chat_count: ada.chat_count, chats: ada.chats },
    { name: "Ada", model: MODEL, avatar: "mono:navy", chat_count: 0, chats: [] },
  );
  const listed = (await a.agent.get("/api/characters").expect(200)).body;
  assert.deepEqual(listed.characters.map((c) => c.id), [ada.id]);
  assert.equal(listed.max_characters, MAX_CHARACTERS);
  assert.equal(listed.limits.instructions, MAX_CHARACTER_INSTRUCTIONS);
  // Defaults: no model, no picture, empty text.
  const bare = (await a.agent.post("/api/characters").send({ name: "  Bo  " }).expect(201)).body;
  assert.deepEqual(
    { name: bare.name, description: bare.description, instructions: bare.instructions, opening: bare.opening, model: bare.model, avatar: bare.avatar },
    { name: "Bo", description: "", instructions: "", opening: "", model: null, avatar: null },
  );
  // Editing changes only what is sent.
  const edited = (
    await a.agent.patch("/api/characters/" + ada.id).send({ name: "Ada L.", instructions: "New.", model: null }).expect(200)
  ).body;
  assert.equal(edited.name, "Ada L.");
  assert.equal(edited.instructions, "New.");
  assert.equal(edited.opening, ada.opening, "left as it was");
  assert.equal(edited.model, null);
  assert.equal(edited.avatar, "mono:navy");
  assert.ok(edited.updated >= ada.updated);
  // Duplicate: the same fields, a marked name, no chats, no links.
  await a.agent.post(`/api/characters/${ada.id}/shares`).send({}).expect(201);
  const copy = (await a.agent.post(`/api/characters/${ada.id}/duplicate`).send({}).expect(201)).body;
  assert.notEqual(copy.id, ada.id);
  assert.equal(copy.name, "Ada L. (copy)");
  assert.equal(copy.instructions, "New.");
  assert.equal(copy.opening, ada.opening);
  assert.equal(copy.avatar, "mono:navy");
  assert.equal(count(s, "character_shares", "character_id=?", copy.id), 0);
  const longName = await make(a, { name: "x".repeat(60) });
  const longCopy = (await a.agent.post(`/api/characters/${longName.id}/duplicate`).send({}).expect(201)).body;
  assert.ok(longCopy.name.length <= 60 && longCopy.name.endsWith(" (copy)"));
  // Invalid fields are refused with a plain code.
  for (const body of [
    { name: "" },
    { name: "x".repeat(61) },
    { name: 5 },
    { name: "Ok", instructions: "y".repeat(MAX_CHARACTER_INSTRUCTIONS + 1) },
    { name: "Ok", opening: "y".repeat(MAX_CHARACTER_OPENING + 1) },
    { name: "Ok", description: "y".repeat(201) },
    { name: "Ok", instructions: ["not text"] },
  ]) {
    const r = await a.agent.post("/api/characters").send(body).expect(400);
    assert.equal(r.body.error.code, "invalid_character", JSON.stringify(body).slice(0, 40));
  }
  // The default model must be a released chat model.
  for (const model of ["no/such-model", 7, "x".repeat(300)]) {
    const r = await a.agent.post("/api/characters").send({ name: "Ok", model }).expect(400);
    assert.equal(r.body.error.code, "invalid_model");
  }
  // It is private to the account: another account sees a missing one.
  for (const send of [
    () => b.agent.get("/api/characters/" + ada.id),
    () => b.agent.patch("/api/characters/" + ada.id).send({ name: "Mine" }),
    () => b.agent.delete("/api/characters/" + ada.id),
    () => b.agent.post(`/api/characters/${ada.id}/duplicate`).send({}),
    () => b.agent.post(`/api/characters/${ada.id}/shares`).send({}),
    () => b.agent.get(`/api/characters/${ada.id}/shares`),
  ])
    assert.equal((await send().expect(404)).body.error.code, "character_not_found");
  assert.deepEqual((await b.agent.get("/api/characters").expect(200)).body.characters, []);
  await a.agent.delete("/api/characters/" + copy.id).expect(200);
  await a.agent.get("/api/characters/" + copy.id).expect(404);
  await a.agent.delete("/api/characters/" + copy.id).expect(404);
});

test("50 characters per account, also enforced by the database", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const insert = s.db.prepare(
    "INSERT INTO characters(id,user_id,name,created,updated) VALUES(?,?,?,?,?)",
  );
  for (let i = 0; i < MAX_CHARACTERS; i++) insert.run("chr_" + i, a.user.id, "C" + i, i, i);
  const r = await a.agent.post("/api/characters").send({ name: "One more" }).expect(409);
  assert.equal(r.body.error.code, "character_limit");
  assert.throws(() => insert.run("chr_x", a.user.id, "X", 1, 1), /character_limit/);
  await a.agent.post("/api/characters/chr_0/duplicate").send({}).expect(409);
  const b = await person(s.app);
  await make(b);
  await a.agent.delete("/api/characters/chr_0").expect(200);
  await make(a);
});

// ---- Pictures ----

test("a picture is a built-in monogram or a small image, and hidden details are removed on the server too", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  // Built-in monograms come from the house palette.
  for (const m of MONOGRAMS) assert.equal((await make(a, { avatar: "mono:" + m.id })).avatar, "mono:" + m.id);
  for (const avatar of ["mono:pink", "mono:", "mono:Cobalt", "cobalt", 5, {}, "https://example.com/a.png", "data:text/html;base64,PGI+"])
    assert.equal((await a.agent.post("/api/characters").send({ name: "Ok", avatar }).expect(400)).body.error.code, "invalid_avatar", String(avatar));
  // null clears the picture.
  const c = await make(a, { avatar: "mono:amber" });
  assert.equal((await a.agent.patch("/api/characters/" + c.id).send({ avatar: null }).expect(200)).body.avatar, null);

  // A PNG: its text and EXIF chunks are gone, the picture is the same size.
  const dirty = png(32, { text: "Jane Doe at 51.5N", exif: true });
  assert.ok(has(dirty, "Jane Doe") && has(dirty, "eXIf"));
  const made = await make(a, { avatar: dataUrl(dirty) });
  const stored = decode(made.avatar);
  assert.ok(made.avatar.startsWith("data:image/png;base64,"));
  assert.ok(!has(stored, "Jane Doe") && !has(stored, "tEXt") && !has(stored, "eXIf"));
  assert.ok(has(stored, "IHDR") && has(stored, "IDAT") && has(stored, "IEND"));
  assert.equal(stored.readUInt32BE(16), 32);
  // A JPEG: the EXIF and comment segments are gone.
  const jpg = jpeg(64, 48);
  assert.ok(has(jpg, "Exif") && has(jpg, "taken at home"));
  const j = decode((await make(a, { avatar: dataUrl(jpg, "image/jpeg") })).avatar);
  assert.ok(!has(j, "Exif") && !has(j, "taken at home"));
  assert.equal(j[0], 0xff);
  assert.equal(j[1], 0xd8);
  // A WebP: the EXIF chunk is gone.
  const wp = webp(200, 100);
  assert.ok(has(wp, "EXIF"));
  const w = decode((await make(a, { avatar: dataUrl(wp, "image/webp") })).avatar);
  assert.ok(!has(w, "EXIF") && has(w, "VP8L"));
  // Size cap: the pixels (256 at most each way) and the bytes.
  for (const [bytes, type] of [
    [png(257), "image/png"],
    [jpeg(300, 100), "image/jpeg"],
    [webp(100, 400), "image/webp"],
  ]) {
    const r = await a.agent.post("/api/characters").send({ name: "Big", avatar: dataUrl(bytes, type) }).expect(400);
    assert.equal(r.body.error.code, "invalid_avatar");
    assert.match(r.body.error.message, /256/);
  }
  assert.ok(png(256).length < MAX_AVATAR_BYTES);
  await make(a, { avatar: dataUrl(png(256)) });
  const heavy = png(200, { text: "x".repeat(MAX_AVATAR_BYTES) });
  assert.equal((await a.agent.post("/api/characters").send({ name: "Heavy", avatar: dataUrl(heavy) }).expect(400)).body.error.code, "invalid_avatar");
  // The claimed type must be what the bytes are, and anything else is refused.
  for (const avatar of [
    dataUrl(png(16), "image/jpeg"),
    dataUrl(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), "image/png"),
    dataUrl(Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00", "latin1"), "image/png"),
    dataUrl(Buffer.from("not an image"), "image/png"),
    "data:image/svg+xml;base64," + Buffer.from("<svg/>").toString("base64"),
    "data:image/png;base64,",
  ])
    assert.equal((await a.agent.post("/api/characters").send({ name: "Bad", avatar }).expect(400)).body.error.code, "invalid_avatar");
  // The pure checker agrees.
  assert.equal(cleanAvatar(null), null);
  assert.equal(cleanAvatar("mono:ink"), "mono:ink");
  assert.deepEqual(parseAvatar("mono:mist"), { kind: "mono", color: "mist" });
  assert.equal(parseAvatar("mono:pink"), null);
  assert.deepEqual(parseAvatar(null), { kind: "none" });
});

test("Seed Guard refuses a seed phrase in a character's text, without repeating it", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  for (const field of ["instructions", "opening", "description"]) {
    const r = await a.agent.post("/api/characters").send({ name: "Wallet", [field]: "My words: " + SEED }).expect(400);
    assert.equal(r.body.error.code, "seed_phrase_blocked");
    assert.doesNotMatch(r.body.error.message, /abandon/);
  }
  const c = await make(a);
  await a.agent.patch("/api/characters/" + c.id).send({ instructions: SEED }).expect(400);
  assert.equal(count(s, "characters", "instructions LIKE ? OR opening LIKE ? OR description LIKE ?", "%abandon%", "%abandon%", "%abandon%"), 0);
  // Before Seed Guard is released it isn't applied.
  const open = fixture(t, "mvp,characters");
  const b = await person(open.app);
  await make(b, { instructions: SEED });
});

// ---- Chatting with a character ----

test("a new saved chat is filed with its character; the opening message is its first turn, free and not a reply", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const ada = await make(a);
  const charges = () => count(s, "ledger", "user_id=? AND amount<0", a.user.id);
  // Making a character reserves and charges nothing.
  assert.equal(count(s, "holds"), 0);
  assert.equal(charges(), 0);
  const id = await send(a, { character: ada.id });
  assert.ok(id);
  const thread = rows(s, id);
  assert.equal(thread.length, 3, "opening, question, reply");
  // The opening: the character's greeting, no model, no cost, marked.
  assert.equal(thread[0].role, "assistant");
  assert.deepEqual(JSON.parse(thread[0].content), { text: "Shh. What are you looking for?", opening: true });
  assert.equal(thread[0].model, null);
  assert.equal(thread[0].cost, 0);
  assert.equal(thread[1].role, "user");
  assert.equal(thread[2].role, "assistant");
  assert.ok(thread[2].model);
  // One request held and settled; the greeting added nothing to it.
  assert.equal(count(s, "holds"), 1);
  assert.equal(count(s, "holds", "status='held'"), 0, "settled, nothing left held");
  assert.equal(charges(), 1, "one charge, for the model's own reply");
  const charged = s.db.prepare("SELECT SUM(cost) n FROM messages WHERE conversation_id=?").get(id).n;
  assert.equal(charged, thread[2].cost + thread[1].cost, "only the model's own reply has a cost");
  // Filed, and listed with the character.
  const detail = (await a.agent.get("/api/characters/" + ada.id).expect(200)).body;
  assert.deepEqual(detail.chats.map((c) => c.id), [id]);
  assert.equal(detail.chat_count, 1);
  assert.equal(
    (await a.agent.get("/api/conversations").expect(200)).body.data.find((c) => c.id === id).character_id,
    ada.id,
  );
  const opened = (await a.agent.get("/api/conversations/" + id).expect(200)).body;
  assert.equal(opened.character_id, ada.id);
  // The saved opening reads back as a marked assistant turn.
  const shown = opened.messages.map(messageFromServer);
  assert.equal(shown[0].opening, true);
  assert.equal(shown[0].content, "Shh. What are you looking for?");
  assert.ok(!shown[0].model);
  assert.ok(!shown[1].opening && !shown[2].opening);
  // A plain chat has no character; one with no opening writes no first turn.
  const plain = await send(a, {});
  assert.equal((await a.agent.get("/api/conversations/" + plain).expect(200)).body.character_id, null);
  const quiet = await make(a, { name: "Quiet", opening: "" });
  const q = await send(a, { character: quiet.id });
  assert.equal(rows(s, q).length, 2);
  // A message added to a saved chat keeps its character; naming one is refused.
  await send(a, { conversationId: id });
  assert.equal(rows(s, id).length, 5);
  const refused = await send(a, { conversationId: id, character: ada.id }, 400);
  assert.equal(refused.error.code, "invalid_request");
  // Editing the character applies to what is next, not to what was written.
  await a.agent.patch("/api/characters/" + ada.id).send({ opening: "Hello again." }).expect(200);
  assert.equal(JSON.parse(rows(s, id)[0].content).text, "Shh. What are you looking for?");
  const second = await send(a, { character: ada.id });
  assert.equal(JSON.parse(rows(s, second)[0].content).text, "Hello again.");
});

test("off the record, Private and other modes never file a chat; someone else's character is missing", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  const ada = await make(a);
  const other = await make(b, { name: "Theirs" });
  const before = { conversations: count(s, "conversations"), messages: count(s, "messages"), filed: count(s, "character_chats") };
  // The browser never names the character with an unsaved chat.
  const fields = characterRequestFields(ada, { ephemeral: true });
  assert.deepEqual(fields, {});
  const r = await a.agent.post("/api/chat").send(chat({ ephemeral: true, ...fields })).expect(200);
  assert.equal(conversationOf(r.text), null, "no conversation id is streamed");
  // And if a client did send it, it is refused before anything is reserved.
  const held = count(s, "holds");
  for (const extra of [
    { ephemeral: true, character: ada.id },
    { private: true, model: UNCENSORED, character: ada.id },
    { mode: "symposium", character: ada.id },
  ]) {
    const refused = await send(a, extra, 400);
    assert.equal(refused.error.code, "invalid_request");
  }
  assert.equal(count(s, "holds"), held);
  // Someone else's, or one that isn't there, is a plain not found.
  for (const character of [other.id, "chr_nope"]) {
    const missing = await send(a, { character }, 404);
    assert.equal(missing.error.code, "character_not_found");
  }
  assert.equal(count(s, "holds"), held);
  assert.equal(count(s, "conversations"), before.conversations);
  assert.equal(count(s, "messages"), before.messages);
  assert.equal(count(s, "character_chats"), before.filed);
  // Code and Uncensored conversations can have characters.
  const code = await send(a, { character: ada.id, mode: "code" });
  assert.equal(s.db.prepare("SELECT mode FROM conversations WHERE id=?").get(code).mode, "code");
  const wild = await make(a, { name: "Wild", model: UNCENSORED });
  const u = await send(a, { character: wild.id, mode: "uncensored", model: UNCENSORED });
  assert.equal(s.db.prepare("SELECT mode FROM conversations WHERE id=?").get(u).mode, "uncensored");
});

test("deleting a character or a chat, branching and the conversation cap keep everything consistent", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const ada = await make(a);
  const id = await send(a, { character: ada.id });
  // A branch of a filed chat is filed with the same character, opening included.
  const opened = (await a.agent.get("/api/conversations/" + id).expect(200)).body;
  const last = opened.messages.at(-1);
  const branch = (
    await a.agent.post(`/api/conversations/${id}/branch`).send({ through: last.id, requestId: uid() }).expect(201)
  ).body;
  assert.equal(rows(s, branch.id).length, 3);
  assert.equal(JSON.parse(rows(s, branch.id)[0].content).opening, true);
  assert.equal((await a.agent.get("/api/conversations/" + branch.id).expect(200)).body.character_id, ada.id);
  assert.equal(count(s, "character_chats", "character_id=?", ada.id), 2);
  // Deleting a chat takes its filing with it.
  await a.agent.delete("/api/conversations/" + branch.id).expect(200);
  assert.equal(count(s, "character_chats", "conversation_id=?", branch.id), 0);
  // Deleting the character keeps the chat, as a plain chat, and drops its links.
  await a.agent.post(`/api/characters/${ada.id}/shares`).send({}).expect(201);
  await a.agent.delete("/api/characters/" + ada.id).expect(200);
  assert.equal(count(s, "character_chats", "character_id=?", ada.id), 0);
  assert.equal(count(s, "character_shares", "character_id=?", ada.id), 0);
  const kept = (await a.agent.get("/api/conversations/" + id).expect(200)).body;
  assert.equal(kept.character_id, null);
  assert.equal(kept.messages.length, 3, "the chat, greeting and all, stays");
  // The conversation cap prunes a filed chat like any other.
  const c = await make(a);
  const old = await send(a, { character: c.id });
  s.db.prepare("UPDATE conversations SET updated=1 WHERE id=?").run(old);
  const insert = s.db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)");
  for (let i = 0; i < 299; i++) insert.run("c_fill" + i, a.user.id, "Filler", "chat", now(), now() + i);
  await a.agent.post("/api/conversations").send({ title: "Newest" }).expect(201);
  assert.equal(count(s, "conversations", "id=?", old), 0, "pruned");
  assert.equal(count(s, "character_chats", "conversation_id=?", old), 0);
  assert.deepEqual((await a.agent.get("/api/characters/" + c.id).expect(200)).body.chats, []);
  // The database keeps a character's chats inside one account.
  const b = await person(s.app);
  const theirs = await make(b, { name: "Theirs" });
  const mine = await send(a, {});
  assert.throws(
    () => s.db.prepare("INSERT INTO character_chats(conversation_id,character_id,user_id,added) VALUES(?,?,?,?)").run(mine, theirs.id, a.user.id, 1),
    /character_owner_only/,
  );
});

// ---- Share a copy ----

const linkOf = (l) => l.url.split("#copy=")[1];
const WIF = (() => {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const payload = Buffer.concat([Buffer.from([0x80]), createHash("sha256").update("characters fixture").digest(), Buffer.from([1])]);
  const sum = createHash("sha256").update(createHash("sha256").update(payload).digest()).digest().subarray(0, 4);
  let n = BigInt("0x" + Buffer.concat([payload, sum]).toString("hex")),
    out = "";
  while (n > 0n) {
    out = alphabet[Number(n % 58n)] + out;
    n /= 58n;
  }
  return out;
})();

test("Share a copy: another signed-in account reads it in full and adds its own; the link carries no chats", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  const ada = await make(a, { model: MODEL, avatar: dataUrl(png(32)) });
  const chatId = await send(a, { character: ada.id });
  assert.ok(chatId);
  const link = (await a.agent.post(`/api/characters/${ada.id}/shares`).send({}).expect(201)).body;
  assert.match(link.url, /^http:\/\/localhost:5175\/workspace\/characters#copy=[A-Za-z0-9_-]{43}$/);
  assert.equal(link.url, shareUrl("http://localhost:5175/", linkOf(link)));
  const token = linkOf(link);
  assert.ok(SHARE_TOKEN.test(token));
  assert.equal(link.character_id, ada.id);
  // 30 days by default.
  assert.ok(Math.abs(link.expires - link.created - 30 * 86400000) < 1000);
  // What the link holds: the six fields of the character and nothing else.
  const row = s.db.prepare("SELECT snapshot FROM character_shares WHERE id=?").get(link.id);
  assert.deepEqual(Object.keys(JSON.parse(row.snapshot)).sort(), ["avatar", "description", "instructions", "model", "name", "opening"]);
  assert.ok(!row.snapshot.includes(chatId) && !row.snapshot.includes("Where are the atlases"), "no chats");
  assert.ok(!row.snapshot.includes(a.user.id) && !row.snapshot.includes(a.user.username), "nothing about its maker");
  // Reading needs an account, and is never cached or indexed.
  await request(s.app).get("/api/character-shares/" + token).expect(401);
  const seen = await b.agent.get("/api/character-shares/" + token).expect(200);
  assert.equal(seen.headers["cache-control"], "no-store");
  assert.equal(seen.headers["referrer-policy"], "no-referrer");
  assert.match(seen.headers["x-robots-tag"], /noindex/);
  assert.deepEqual(
    { name: seen.body.name, description: seen.body.description, instructions: seen.body.instructions, opening: seen.body.opening, model: seen.body.model, avatar: seen.body.avatar },
    { name: ada.name, description: ada.description, instructions: ada.instructions, opening: ada.opening, model: MODEL, avatar: ada.avatar },
  );
  assert.equal(seen.body.model_available, true);
  assert.ok(!JSON.stringify(seen.body).includes(a.user.id) && !("user_id" in seen.body) && !("owner" in seen.body));
  // The copy is the reader's own: a new character, no chats, no links.
  const before = count(s, "characters", "user_id=?", b.user.id);
  const made = (await b.agent.post(`/api/character-shares/${token}/import`).send({}).expect(201)).body;
  assert.equal(count(s, "characters", "user_id=?", b.user.id), before + 1);
  assert.notEqual(made.id, ada.id);
  assert.deepEqual(
    { name: made.name, instructions: made.instructions, opening: made.opening, model: made.model, avatar: made.avatar, chats: made.chats, model_kept: made.model_kept },
    { name: ada.name, instructions: ada.instructions, opening: ada.opening, model: MODEL, avatar: ada.avatar, chats: [], model_kept: true },
  );
  assert.equal(count(s, "character_shares", "character_id=?", made.id), 0);
  await b.agent.get("/api/characters/" + made.id).expect(200);
  await a.agent.get("/api/characters/" + made.id).expect(404);
  // Later edits reach neither the copy nor the link: it is the character as it was.
  await a.agent.patch("/api/characters/" + ada.id).send({ instructions: "Changed." }).expect(200);
  assert.equal((await b.agent.get("/api/character-shares/" + token).expect(200)).body.instructions, ada.instructions);
  assert.equal((await b.agent.get("/api/characters/" + made.id).expect(200)).body.instructions, ada.instructions);
  // The list and export show the link to its owner only.
  const mine = (await a.agent.get(`/api/characters/${ada.id}/shares`).expect(200)).body.data;
  assert.deepEqual(mine.map((l) => l.id), [link.id]);
  assert.deepEqual((await b.agent.get(`/api/characters/${made.id}/shares`).expect(200)).body.data, []);
  await b.agent.delete("/api/character-shares/" + link.id).expect(404);
  // A default model this account can't run isn't carried over, and it says so.
  s.db
    .prepare("UPDATE character_shares SET snapshot=? WHERE id=?")
    .run(JSON.stringify({ ...JSON.parse(row.snapshot), model: "no/such-model" }), link.id);
  const odd = (await b.agent.get("/api/character-shares/" + token).expect(200)).body;
  assert.equal(odd.model_available, false);
  const copy = (await b.agent.post(`/api/character-shares/${token}/import`).send({}).expect(201)).body;
  assert.equal(copy.model, null);
  assert.equal(copy.model_kept, false);
});

test("revoked, expired, unknown and malformed links all look the same, and only the owner can revoke", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  const ada = await make(a);
  const revoked = (await a.agent.post(`/api/characters/${ada.id}/shares`).send({}).expect(201)).body;
  const expired = (await a.agent.post(`/api/characters/${ada.id}/shares`).send({ expires_in_days: 1 }).expect(201)).body;
  const live = (await a.agent.post(`/api/characters/${ada.id}/shares`).send({ expires_in_days: 7 }).expect(201)).body;
  assert.ok(Math.abs(expired.expires - expired.created - 86400000) < 1000);
  assert.ok(Math.abs(live.expires - live.created - 7 * 86400000) < 1000);
  await a.agent.delete("/api/character-shares/" + revoked.id).expect(200);
  await a.agent.delete("/api/character-shares/" + revoked.id).expect(404);
  s.db.prepare("UPDATE character_shares SET expires=? WHERE id=?").run(now() - 1, expired.id);
  const tokens = [linkOf(revoked), linkOf(expired), randomBytes(32).toString("base64url"), "short", "a".repeat(44), "../etc/passwd", "%20"];
  const bodies = [];
  for (const token of tokens) {
    const r = await b.agent.get("/api/character-shares/" + encodeURIComponent(token)).expect(404);
    bodies.push(JSON.stringify(r.body));
    const i = await b.agent.post(`/api/character-shares/${encodeURIComponent(token)}/import`).send({}).expect(404);
    assert.equal(JSON.stringify(i.body), bodies.at(-1));
  }
  assert.equal(new Set(bodies).size, 1, "a guesser learns nothing");
  assert.equal(JSON.parse(bodies[0]).error.code, "share_not_found");
  assert.equal(count(s, "characters", "user_id=?", b.user.id), 0);
  // The live one still works, and the listing has only live links.
  await b.agent.get("/api/character-shares/" + linkOf(live)).expect(200);
  assert.deepEqual((await a.agent.get(`/api/characters/${ada.id}/shares`).expect(200)).body.data.map((l) => l.id), [live.id]);
  // The worker removes an expired link's snapshot.
  assert.equal(count(s, "character_shares"), 2, "the expired one is still stored until the worker runs");
  await s.tick();
  assert.equal(count(s, "character_shares", "id=?", expired.id), 0);
  assert.equal(count(s, "character_shares", "id=?", live.id), 1);
  // Only the owner revokes; deleting the character takes its links.
  await b.agent.delete("/api/character-shares/" + live.id).expect(404);
  await a.agent.delete("/api/characters/" + ada.id).expect(200);
  await b.agent.get("/api/character-shares/" + linkOf(live)).expect(404);
  assert.equal(count(s, "character_shares"), 0);
  // An account that is closed takes its links with it.
  const c = await person(s.app);
  const cc = await make(c);
  const cl = (await c.agent.post(`/api/characters/${cc.id}/shares`).send({}).expect(201)).body;
  await c.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  await b.agent.get("/api/character-shares/" + linkOf(cl)).expect(404);
});

test("copy links: 1, 7 or 30 days, five per character and twenty per account", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const ada = await make(a);
  assert.deepEqual(parseShareDays(undefined), { ok: true, days: 30 });
  for (const days of [0, 2, 365, "30", null, 30.5, -1, [7]])
    assert.equal((await a.agent.post(`/api/characters/${ada.id}/shares`).send({ expires_in_days: days }).expect(400)).body.error.code, "invalid_request", String(days));
  assert.equal(parseShareDays(null).ok, false);
  for (let i = 0; i < 5; i++) await a.agent.post(`/api/characters/${ada.id}/shares`).send({}).expect(201);
  const over = await a.agent.post(`/api/characters/${ada.id}/shares`).send({}).expect(400);
  assert.equal(over.body.error.code, "share_limit");
  // Twenty across characters (the rest written straight to the database, so
  // the hourly rate limit on making links isn't what is being tested).
  const insertLink = s.db.prepare(
    "INSERT INTO character_shares(id,user_id,character_id,token,snapshot,created,expires) VALUES(?,?,?,?,?,?,?)",
  );
  for (let n = 0; n < 3; n++) {
    const c = await make(a, { name: "C" + n });
    for (let i = 0; i < 5 && count(s, "character_shares") < 20; i++)
      insertLink.run(uid("chs_"), a.user.id, c.id, randomBytes(32).toString("base64url"), "{}", now(), now() + 86400000);
  }
  assert.equal(count(s, "character_shares"), 20);
  const d = await make(a, { name: "D" });
  assert.equal((await a.agent.post(`/api/characters/${d.id}/shares`).send({}).expect(400)).body.error.code, "share_limit");
  // Revoking one makes room.
  const one = s.db.prepare("SELECT id FROM character_shares LIMIT 1").get().id;
  await a.agent.delete("/api/character-shares/" + one).expect(200);
  await a.agent.post(`/api/characters/${d.id}/shares`).send({}).expect(201);
});

test("Seed Guard refuses a link whose character holds a seed phrase or private key, and an import of one", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  const ada = await make(a);
  // A character saved before Seed Guard was released may still hold one.
  for (const bad of [SEED, "My key: " + WIF]) {
    s.db.prepare("UPDATE characters SET instructions=? WHERE id=?").run(bad, ada.id);
    const r = await a.agent.post(`/api/characters/${ada.id}/shares`).send({}).expect(400);
    assert.equal(r.body.error.code, "seed_phrase_blocked");
    assert.doesNotMatch(r.body.error.message, /abandon|5[HJK]/);
    assert.equal(count(s, "character_shares"), 0);
  }
  // A hex hash is only a soft find for a person, so it doesn't stop a link.
  s.db.prepare("UPDATE characters SET instructions=? WHERE id=?").run("The commit is " + "ab12".repeat(16), ada.id);
  const ok = (await a.agent.post(`/api/characters/${ada.id}/shares`).send({}).expect(201)).body;
  // An import is checked again: a snapshot made before the guard existed.
  const stored = JSON.parse(s.db.prepare("SELECT snapshot FROM character_shares WHERE id=?").get(ok.id).snapshot);
  s.db.prepare("UPDATE character_shares SET snapshot=? WHERE id=?").run(JSON.stringify({ ...stored, opening: SEED }), ok.id);
  const r = await b.agent.post(`/api/character-shares/${linkOf(ok)}/import`).send({}).expect(400);
  assert.equal(r.body.error.code, "seed_phrase_blocked");
  assert.equal(count(s, "characters", "user_id=?", b.user.id), 0);
  // The import respects the 50-character cap too.
  s.db.prepare("UPDATE character_shares SET snapshot=? WHERE id=?").run(JSON.stringify(stored), ok.id);
  const insert = s.db.prepare("INSERT INTO characters(id,user_id,name,created,updated) VALUES(?,?,?,?,?)");
  for (let i = 0; i < MAX_CHARACTERS; i++) insert.run("chr_b" + i, b.user.id, "B" + i, i, i);
  assert.equal((await b.agent.post(`/api/character-shares/${linkOf(ok)}/import`).send({}).expect(409)).body.error.code, "character_limit");
});

// ---- Erase and export ----

test("the account export, Panic Wipe, closure and Inactivity Wipe cover characters, their pictures, chats and links", async (t) => {
  const s = fixture(t);
  await s.stopWork();
  const a = await person(s.app);
  const ada = await make(a, { model: MODEL, avatar: dataUrl(png(24)) });
  const plain = await make(a, { name: "Plain", avatar: "mono:mist", opening: "" });
  const id = await send(a, { character: ada.id });
  const link = (await a.agent.post(`/api/characters/${ada.id}/shares`).send({ expires_in_days: 7 }).expect(201)).body;
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.deepEqual(exported.characters.map((c) => c.name), ["Ada", "Plain"]);
  const out = exported.characters[0];
  assert.equal(out.avatar, ada.avatar, "the picture, as the data URL it is kept as");
  assert.match(out.avatar, /^data:image\/png;base64,/);
  assert.equal(exported.characters[1].avatar, "mono:mist");
  assert.deepEqual(
    { instructions: out.instructions, opening: out.opening, model: out.model, description: out.description },
    { instructions: ada.instructions, opening: ada.opening, model: MODEL, description: ada.description },
  );
  assert.deepEqual(out.conversations, [id]);
  assert.deepEqual(out.share_links.map((l) => [l.id, l.url]), [[link.id, link.url]]);
  assert.ok(exported.conversations.some((c) => c.id === id), "the chat itself is exported too");
  assert.ok(exported.conversations.find((c) => c.id === id).messages.some((m) => m.content?.opening === true), "with its greeting");
  const mine = (uid_) => ({
    characters: count(s, "characters", "user_id=?", uid_),
    filed: count(s, "character_chats", "user_id=?", uid_),
    links: count(s, "character_shares", "user_id=?", uid_),
  });
  assert.deepEqual(mine(a.user.id), { characters: 2, filed: 1, links: 1 });
  // Someone else's data stays.
  const other = await person(s.app);
  const theirs = await make(other, { name: "Theirs" });
  await other.agent.post(`/api/characters/${theirs.id}/shares`).send({}).expect(201);
  // Panic Wipe erases them with everything else.
  await a.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.deepEqual(mine(a.user.id), { characters: 0, filed: 0, links: 0 });
  assert.deepEqual(mine(other.user.id), { characters: 1, filed: 0, links: 1 });
  assert.equal(count(s, "conversations", "user_id=?", a.user.id), 0);
  // Closing an account does too.
  const c = await person(s.app);
  const cc = await make(c);
  await send(c, { character: cc.id });
  await c.agent.post(`/api/characters/${cc.id}/shares`).send({}).expect(201);
  assert.deepEqual(mine(c.user.id), { characters: 1, filed: 1, links: 1 });
  await c.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.deepEqual(mine(c.user.id), { characters: 0, filed: 0, links: 0 });
  // And so does Inactivity Wipe, whose erase is Panic Wipe's.
  const idle = await person(s.app);
  const ic = await make(idle);
  await send(idle, { character: ic.id });
  await idle.agent.post(`/api/characters/${ic.id}/shares`).send({}).expect(201);
  await idle.agent.put("/api/inactivity-wipe").send({ days: 30, confirm: true }).expect(200);
  const row = s.db.prepare("SELECT * FROM inactivity_wipe WHERE user_id=?").get(idle.user.id);
  const at = row.last_active + 32 * 86400000;
  s.db
    .prepare("INSERT INTO inactivity_clock(id,last_sweep) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_sweep=excluded.last_sweep")
    .run(at - 60_000);
  assert.equal((await s.inactivity.sweep(at)).erased, 1);
  assert.deepEqual(mine(idle.user.id), { characters: 0, filed: 0, links: 0 });
  assert.deepEqual(mine(other.user.id), { characters: 1, filed: 0, links: 1 });
  // An account with none exports an empty list once the update is live, and
  // nothing while it isn't.
  const fresh = await person(s.app);
  assert.deepEqual((await fresh.agent.get("/api/account/export").expect(200)).body.characters, []);
});

// ---- What the browser sends ----

test("a character's instructions go after standing and project instructions, in the one system message, and Veil masks them", () => {
  const project = { id: "prj_1", instructions: "Reply in British English." };
  const ada = { id: "chr_1", instructions: "You are Ada. Write to jane@example.com only if asked.", opening: "Shh. What are you looking for?" };
  const before = withProjectInstructions("Be brief.", project);
  const both = withCharacterInstructions(before, ada);
  // Order: standing, then the project's, then the character's.
  assert.equal(both, "Be brief.\n\nReply in British English.\n\n" + characterBlock(ada));
  assert.ok(both.indexOf("Be brief.") < both.indexOf("British English") && both.indexOf("British English") < both.indexOf("You are Ada."));
  // The opening is told to the model inside the instructions, not sent as a turn.
  assert.match(both, /Your opening message, already shown to the person before they wrote anything:\nShh\. What are you looking for\?$/);
  assert.equal(withCharacterInstructions("", ada), characterBlock(ada));
  assert.equal(withCharacterInstructions("Be brief.", { instructions: "  ", opening: "" }), "Be brief.");
  assert.equal(withCharacterInstructions("", null), "");
  assert.equal(characterBlock({ instructions: "Only this." }), "Only this.");
  assert.equal(characterBlock({ opening: "Hi." }), "Your opening message, already shown to the person before they wrote anything:\nHi.");
  // Sent as the leading system message of every request, the same path as a project's.
  const history = [
    { role: "assistant", content: ada.opening, opening: true },
    { role: "user", content: "First" },
    { role: "assistant", content: "Reply" },
  ];
  const plain = buildChatRequest({ messages: history, text: "Next", instructions: both });
  assert.deepEqual(plain.request[0], { role: "system", content: both });
  assert.deepEqual(plain.request.slice(1).map((m) => [m.role, m.content]), [["user", "First"], ["assistant", "Reply"], ["user", "Next"]]);
  assert.ok(!plain.request.some((m) => m.content === ada.opening), "the opening is never sent as a reply");
  // It is still shown, and never saved with the instructions.
  assert.equal(plain.next.length, 4);
  assert.equal(plain.next[0].opening, true);
  assert.ok(!plain.next.some((m) => m.role === "system"));
  // The same request is built with or without the greeting in the thread, so
  // an estimate beside Send prices exactly what Send posts.
  const without = buildChatRequest({ messages: history.slice(1), text: "Next", instructions: both });
  assert.deepEqual(plain.request, without.request);
  // Veil masks the instructions and the opening, with the conversation's own map.
  const state = createVeilState();
  const veiled = buildChatRequest({
    messages: history,
    text: "Write to jane@example.com",
    instructions: withCharacterInstructions("", { ...ada, opening: "Mail me at jane@example.com." }),
    veilWith: { state, words: [] },
  });
  assert.equal(veiled.request[0].role, "system");
  assert.ok(!veiled.request[0].content.includes("jane@example.com"), "masked");
  assert.match(veiled.request[0].content, /\[EMAIL_1\]/);
  assert.match(veiled.request.at(-1).content, /\[EMAIL_1\]/, "the same tag in the message");
  assert.equal(state.map.EMAIL_1, "jane@example.com");
  assert.ok(veiled.masked >= 3);
  // A fresh chat: the greeting is a turn of its own with no model.
  assert.deepEqual(openingMessage(ada), { role: "assistant", content: ada.opening, opening: true });
  assert.equal(hasOpening(ada), true);
  assert.equal(hasOpening({ opening: "   " }), false);
  const first = buildChatRequest({ messages: [openingMessage(ada)], text: "Hello", instructions: characterBlock(ada) });
  assert.deepEqual(first.request.map((m) => m.role), ["system", "user"]);
  assert.deepEqual(first.next.map((m) => [m.role, !!m.opening]), [["assistant", true], ["user", false]]);
});

test("only a new saved chat names its character; a chat reopens with the one it began with", () => {
  const ada = { id: "chr_1" };
  assert.deepEqual(characterRequestFields(ada, {}), { character: "chr_1" });
  assert.deepEqual(characterRequestFields(ada, { ephemeral: true }), {}, "off the record, Private and Device only store nothing");
  assert.deepEqual(characterRequestFields(ada, { conversationId: "c_1" }), {}, "a saved chat keeps its own");
  assert.deepEqual(characterRequestFields(null, {}), {});
  // A saved chat's greeting reads back as a marked assistant turn.
  const shown = messageFromServer({ role: "assistant", model: null, content: { text: "Hello there.", opening: true } });
  assert.deepEqual([shown.content, shown.opening, shown.model], ["Hello there.", true, null]);
  assert.equal(messageFromServer({ role: "assistant", content: { text: "A reply." } }).opening, undefined);
  assert.equal(messageFromServer({ role: "user", content: "Hi" }).opening, undefined);
  // A vault chat keeps its character inside the sealed chat only.
  const sealed = vaultChat({ id: "v1", mode: "chat", messages: [{ role: "user", content: "Hi" }], character: "chr_1" });
  assert.equal(sealed.character, "chr_1");
  assert.ok(!("character" in vaultChat({ id: "v2", mode: "chat", messages: [] })));
  assert.ok(!("character" in vaultChat({ id: "v3", mode: "chat", messages: [], character: 7 })));
  // Where "Chat" opens: an Uncensored model only exists in its own section.
  assert.equal(characterMode({ model: UNCENSORED }, [UNCENSORED]), "uncensored");
  assert.equal(characterMode({ model: MODEL }, [UNCENSORED]), "chat");
  assert.equal(characterMode({ model: null }, [UNCENSORED]), "chat");
  assert.equal(characterChatPath({ id: "chr_1", model: UNCENSORED }, [UNCENSORED]), "/workspace/uncensored?character=chr_1");
  assert.equal(characterChatPath({ id: "chr_1" }), "/workspace/chat?character=chr_1");
  assert.equal(characterPagePath({ id: "chr_1" }), "/workspace/characters?id=chr_1");
  assert.equal(characterPagePath(null), "/workspace/characters");
  // What the composer says about a default model that isn't offered.
  const models = [{ id: "a", private: true }, { id: "b" }];
  assert.equal(characterModelNote({ model: "a" }, { models, visible: models, privateMode: true }), "");
  assert.match(characterModelNote({ model: "b" }, { models, visible: models, privateMode: true }), /Private Mode offers only private models/);
  assert.match(characterModelNote({ model: "b" }, { models, visible: [models[0]] }), /isn't offered in this section/);
  assert.match(characterModelNote({ model: "gone" }, { models, visible: models }), /isn't available/);
  assert.equal(characterModelNote({ model: null }, { models, visible: models, privateMode: true }), "");
});

test("the editor's checks match the server's, monograms come from the house palette and links read back", () => {
  assert.deepEqual(characterProblems({ name: "Ada" }), {});
  assert.ok(characterProblems({ name: " " }).name);
  assert.ok(characterProblems({ name: "x".repeat(61) }).name);
  assert.ok(characterProblems({ name: "x", description: "y".repeat(201) }).description);
  assert.ok(characterProblems({ name: "x", instructions: "y".repeat(4001) }).instructions);
  assert.ok(characterProblems({ name: "x", opening: "y".repeat(1001) }).opening);
  const brand = readFileSync(new URL("../src/brand.css", import.meta.url), "utf8").toLowerCase();
  for (const m of MONOGRAMS) assert.ok(brand.includes(m.hex), m.id);
  assert.equal(initialOf("ada"), "A");
  assert.equal(initialOf("  ¡émile"), "É");
  assert.equal(initialOf("零号"), "零");
  assert.equal(initialOf("!!!"), "?");
  assert.equal(initialOf(null), "?");
  const token = randomBytes(32).toString("base64url");
  const url = shareUrl("https://askanonyma.com/", token);
  assert.equal(url, `https://askanonyma.com/workspace/characters#copy=${token}`);
  assert.equal(tokenFromLink(url), token);
  assert.equal(tokenFromLink("  " + url + "\n"), token);
  assert.equal(tokenFromLink("#copy=" + token), token);
  assert.equal(tokenFromLink(token), token);
  for (const bad of ["", null, "hello", "https://example.com/?copy=" + token, "#copy=" + token.slice(1), "#copy=" + token + "abc", "copy=" + token])
    assert.equal(tokenFromLink(bad), null, String(bad));
  // Signing in on the way returns to the Characters page, and nowhere else.
  assert.equal(safeNext("/workspace/characters"), "/workspace/characters");
  assert.equal(safeNext("/workspace/characters#copy=" + token), null);
  assert.equal(safeNext("https://evil.example/workspace/characters"), null);
});

test("the tool directory and the Command Palette find Characters by intent, once released", () => {
  const entries = [
    ["chat", "Chat & reason"],
    ["projects", "Projects", "Group related chats, files and instructions in folders. Set defaults for each project."],
    ["characters", "Characters", "Make AI characters with a name, a picture and a personality, and chat with them on the model you choose."],
    ["photos", "Photo tools", "Edit a photo with words, remove its background or upscale it. See the price first."],
  ];
  for (const q of ["make a character", "roleplay", "persona", "I want to talk to an NPC", "companion", "角色扮演", "人设", "characters", "personality"]) {
    const found = rankTools(entries, q);
    assert.equal(found[0]?.[0], "characters", q);
  }
  assert.ok(!rankTools(entries, "roleplay").some((e) => e[0] === "photos"));
  // Never adds a tool the caller left out.
  assert.deepEqual(rankTools(entries.filter((e) => e[0] !== "characters"), "roleplay").map((e) => e[0]).includes("characters"), false);
  const place = (config) =>
    paletteActions({ config, signedIn: true, mode: "chat" }).find((a) => a.to?.startsWith?.("/workspace/characters") || a.id === "go-characters" || a.label === "Characters");
  assert.equal(place({ releases: { features: {} } }), undefined);
  assert.ok(place({ releases: { features: { characters: true } } }), "offered once released");
});

// ---- The page ----

// Characters.jsx and CharacterChat.jsx compiled for Node with the same esbuild
// Vite uses. Shared UI, routing and Seed Guard are swapped for plain stand-ins
// so only these files' own text is rendered.
async function pageModule() {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-characters-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `export const Icon = () => null;
     export const Button = ({ children, secondary, to, ...p }) => React.createElement(to ? "a" : "button", to ? { href: to, ...p } : p, children);
     export const Notice = ({ children }) => React.createElement("div", { className: "notice" }, children);
     export const Modal = ({ title, children }) => React.createElement("dialog", { "aria-label": title }, React.createElement("h2", null, title), children);
     export const Empty = ({ title, children, action }) => React.createElement("div", null, React.createElement("h3", null, title), React.createElement("p", null, children), action);`,
  );
  const seed = stub(
    "seed.mjs",
    `export const SeedGuardNotice = () => null;
     export const seedGuardLive = () => false;
     export const useSeedScan = () => null;`,
  );
  const secret = stub(
    "secret.mjs",
    `export const SecretGuardNotice = () => null;
     export const useSecretGuard = () => false;
     export const useSecretScan = () => [];`,
  );
  const router = stub(
    "router.mjs",
    `export const Link = ({ children, to, ...p }) => React.createElement("a", { href: to, ...p }, children);
     export const useNavigate = () => () => {};
     export const useSearchParams = () => [new URLSearchParams(globalThis.__characterParams || ""), () => {}];`,
  );
  const compile = async (name, chat) => {
    const src = new URL("../src/" + name, import.meta.url);
    const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
    const out = code
      .replace(/^import "\.\/[\w-]+\.css";$/gm, "")
      .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
      .replace(/from "\.\/SeedGuard\.jsx"/g, `from "${seed}"`)
      .replace(/from "\.\/SecretGuard\.jsx"/g, `from "${secret}"`)
      .replace(/from "\.\/secret-guard\.js"/g, `from "${new URL("../src/secret-guard.js", import.meta.url)}"`)
      .replace(/from "react-router-dom"/g, `from "${router}"`)
      .replace(/from "\.\/CharacterChat\.jsx"/g, `from "${chat}"`)
      .replace(/from "\.\/(lib|characters|character-avatar)\.js"/g, (m, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
      .replace(/from "react"/g, `from "${react}"`);
    const file = join(dir, name.replace(/\.jsx$/, ".mjs"));
    writeFileSync(file, out);
    return pathToFileURL(file).href;
  };
  try {
    const chat = await compile("CharacterChat.jsx", "");
    const page = await compile("Characters.jsx", chat);
    return { ...(await import(page)), ...(await import(chat)) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
// The page's text, split by whether it sits inside data-i18n="off" (the
// account's own words) or not (the page's own, to be translated).
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr", "meta", "link", "source", "wbr"]);
  const stack = [];
  const page = [],
    kept = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title|label)="([^"]*)"/g))
        (off || stack.some((x) => x.off) ? kept : page).push(entities(attr));
      const noText = /^(script|style|code|pre|textarea|noscript|kbd|samp)$/i.test(m[2]);
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>")) stack.push({ off: off || noText });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    }
  }
  const words = (list) => list.filter((s) => /[A-Za-z]{2}/.test(s));
  return { page: words(page), kept: words(kept) };
}

test("the Characters page marks the account's words off and translates the rest, in Chinese and Spanish", async () => {
  const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const es = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/es.json", import.meta.url), "utf8")), "es");
  const han = /\p{Script=Han}/u;
  const mod = await pageModule();
  const { default: Characters, PASTE_ERROR, GONE, CharacterDetail, CharacterEditor, ShareView, ImportView, PasteDialog, CharacterBar, CharacterChip, CharacterAvatar } = mod;
  const models = [
    { id: "m-1", name: "Gemini 2.5 Flash", type: "chat", callable: true },
    { id: "m-2", name: "Venice Wild", type: "chat", callable: true, private: false },
  ];
  const config = { releases: { uncensoredModels: ["m-2"], features: { characters: true, uncensored: true, private: true, seedguard: true } } };
  const ada = {
    id: "chr_1",
    name: "Ada Lovelace",
    description: "A stern librarian",
    instructions: "You are Ada. Speak like a pirate.",
    opening: "Shh. What are you looking for?",
    model: "m-1",
    avatar: "mono:navy",
    chat_count: 2,
    created: 1,
    updated: 1,
    chats: [{ id: "c1", title: "Atlas hunt", mode: "chat", updated: Date.parse("2026-09-20") }],
  };
  const quiet = { ...ada, id: "chr_2", name: "Quiet Bo", description: "", instructions: "", opening: "", model: null, avatar: null, chat_count: 0, chats: [] };
  const wild = { ...ada, id: "chr_3", name: "Wild Vex", model: "m-2", chat_count: 1, avatar: "data:image/png;base64,iVBORw0KGgo=" };
  const list = (items) => ({ list: items, loaded: true, max: 50, byId: (id) => items.find((c) => c.id === id) || null, reload: async () => {} });
  const noop = () => {};
  const render = (el) => renderToStaticMarkup(el);
  const share = { id: "chs_1", url: "http://localhost/workspace/characters#copy=" + "a".repeat(43), expires: Date.parse("2026-10-20") };
  const view = { name: "Captain Vex", description: "A gruff pirate", instructions: "You are Vex.", opening: "State yer business.", avatar: null, model: "m-2", model_name: "Venice Wild", model_available: true };
  const html = [];
  for (const params of ["", "id=chr_1", "id=chr_2", "id=chr_3"]) {
    globalThis.__characterParams = params;
    for (const [demo, user, items] of [[true, null, []], [false, null, []], [false, { id: "u" }, []], [false, { id: "u" }, [ada, quiet, wild]], [false, { id: "u" }, Array.from({ length: 50 }, (_, i) => ({ ...ada, id: "c" + i }))]])
      html.push(render(createElement(Characters, { demo, user, config, models, characters: list(items) })));
  }
  globalThis.__characterParams = "";
  for (const draft of [
    { name: "", description: "", instructions: "", opening: "", model: null, avatar: null },
    { id: "chr_1", name: "Ada Lovelace", description: "A stern librarian", instructions: "You are Ada.", opening: "Shh.", model: "m-1", avatar: "mono:amber" },
    { id: "chr_3", name: "Wild Vex", description: "", instructions: "", opening: "", model: "m-2", avatar: "data:image/png;base64,iVBORw0KGgo=" },
  ])
    html.push(render(createElement(CharacterEditor, { draft, setDraft: noop, config, models, busy: false, error: "You can have up to 50 characters. Delete one to add another.", onSave: noop, onCancel: noop, onDelete: noop })));
  for (const c of [ada, quiet, wild])
    html.push(
      render(createElement(CharacterDetail, { c, models, busy: false, atLimit: false, editor: null, onChat: noop, onEdit: noop, onDuplicate: noop, onShare: noop, onOpenChat: noop })),
    );
  html.push(
    render(createElement(ShareView, { character: ada, links: null, days: 30, setDays: noop, busy: false, error: "", copied: "", onCreate: noop, onRevoke: noop, onCopy: noop })),
    render(createElement(ShareView, { character: ada, links: [], days: 7, setDays: noop, busy: false, error: "", copied: "", onCreate: noop, onRevoke: noop, onCopy: noop })),
    render(createElement(ShareView, { character: ada, links: [share], days: 1, setDays: noop, busy: true, error: "", copied: "chs_1", onCreate: noop, onRevoke: noop, onCopy: noop })),
    render(createElement(ShareView, { character: ada, links: [share], days: 30, setDays: noop, busy: false, error: "You can have up to 20 active copy links. Revoke one first.", copied: "", onCreate: noop, onRevoke: noop, onCopy: noop })),
    render(createElement(ImportView, { view: null, gone: false, error: "", busy: false, atLimit: false, onAdd: noop, onClose: noop })),
    render(createElement(ImportView, { view: null, gone: true, error: "", busy: false, atLimit: false, onAdd: noop, onClose: noop })),
    render(createElement(ImportView, { view, gone: false, error: "", busy: false, atLimit: false, onAdd: noop, onClose: noop })),
    render(createElement(ImportView, { view: { ...view, model: null, opening: "", instructions: "  " }, gone: false, error: "", busy: false, atLimit: false, onAdd: noop, onClose: noop })),
    render(createElement(ImportView, { view: { ...view, model_available: false }, gone: false, error: "This character link isn't available.", busy: true, atLimit: true, onAdd: noop, onClose: noop })),
    render(createElement(PasteDialog, { onToken: noop, onClose: noop })),
    render(createElement(CharacterBar, { character: ada, saved: false, fresh: true, note: "This character's default model isn't offered in this section. Choose another model.", picker: null, onLeave: noop })),
    render(createElement(CharacterBar, { character: quiet, saved: true, fresh: false, onLeave: noop })),
    render(createElement(CharacterChip, { character: ada })),
    render(createElement(CharacterAvatar, { name: "Ada", avatar: null })),
    render(createElement(CharacterAvatar, { name: "Ada", avatar: "mono:navy", size: 30 })),
  );
  const { page, kept } = textsOf(html.join(""));
  // The account's words stay as written.
  for (const text of ["Ada Lovelace", "A stern librarian", "You are Ada. Speak like a pirate.", "Shh. What are you looking for?", "Atlas hunt", "Gemini 2.5 Flash", "Venice Wild", "Captain Vex", "You are Vex.", "State yer business."])
    assert.ok(kept.includes(text), `kept as written: ${text}`);
  for (const text of ["Ada Lovelace", "You are Ada. Speak like a pirate.", "Atlas hunt", "Captain Vex", "Quiet Bo", "Wild Vex"])
    assert.ok(!page.includes(text), `never translated: ${text}`);
  // A picture is a plain image with no alt text to leak, and a monogram is decoration.
  assert.match(html.join(""), /<img class="character-avatar image[^"]*"[^>]*src="data:image\/png;base64,iVBORw0KGgo="[^>]*alt=""/);
  assert.match(html.join(""), /<span class="character-avatar mono[^"]*"[^>]*aria-hidden="true"/);
  // Everything else has Chinese and Spanish.
  const date = /^\d{1,2}\/\d{1,2}\/\d{4}$/;
  const missing = { zh: [], es: [] };
  for (const text of page) {
    if (date.test(text)) continue; // a bare date takes the zh-CN / es-419 form (i18n.js)
    if (!han.test(translateText(text, zh) ?? "")) missing.zh.push(text);
    if (translateText(text, es) == null) missing.es.push(text);
  }
  // And what the rest of the workspace shows for Characters.
  const entry = UPDATES.find((u) => u.id === "characters");
  const rest = [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Characters is coming soon.",
    "Characters",
    "Character not found.",
    "Give the character a name of 1–60 characters.",
    "The description cannot exceed 200 characters.",
    "Instructions cannot exceed 4000 characters.",
    "The opening message cannot exceed 1000 characters.",
    "Choose a chat model, or no default.",
    "You can have up to 50 characters. Delete one to add another.",
    "This looks like a wallet seed phrase. A character's text is saved and sent with its chats, so ANONYMA won't save one. Remove it to continue.",
    "This character holds what looks like a wallet seed phrase or private key, so ANONYMA won't share it. Remove it and try again.",
    "You can have up to 20 active copy links. Revoke one first.",
    "A character can have up to 5 active copy links. Revoke one first.",
    "This character link isn't available.",
    "Copy link not found.",
    "Use a PNG, JPEG or WebP picture of up to 256 by 256 pixels.",
    "That picture couldn't be read. Try another image.",
    "That picture is too large. Keep it under 48 KB.",
    "That picture is too big. Use at most 256 by 256 pixels.",
    "Off-the-record and Private chats are never saved, so they aren't filed with a character.",
    "A saved chat keeps the character it began with; a new message can't change it.",
    "Characters are for chat, code and Uncensored conversations.",
    "That character wasn't found.",
    "Choose a picture.",
    "That picture is too large. Choose one under 12 MB.",
    "Use a PNG, JPEG, WebP, GIF or HEIC picture.",
    "That picture is too detailed to keep small. Try a simpler one.",
    "Characters, their pictures and copy links",
    "Chat with",
    "New chat with",
    "Leave character",
    "Instructions on",
    "Opening message",
    "Sent with every message after your standing instructions and the project's, in that order. Veil masks them like anything you type.",
    "File in project",
    "Added. This is your own copy: edit it as you like.",
    "Added. Its default model isn't available to you, so it has none: choose one with Edit.",
    "Make AI characters with a name, a picture and a personality, and chat with them on the model you choose.",
    "Opening Characters…",
    ...[/\{characters && \(\s*<li>(.*?)<\/li>/s, /\{characters && \(\s*<p>(.*?)<\/p>/s].map((re) =>
      readFileSync(new URL("../src/DataControls.jsx", import.meta.url), "utf8").match(re)[1].replace(/\s+/g, " ").trim(),
    ),
    "Add a character",
    "Add from a link",
    "Delete this character? Its chats stay saved, as plain chats, and its copy links stop working.",
    "That picture couldn't be redrawn.",
    "You opened a character link. Sign in, or create an account, to read it and add a copy.",
    PASTE_ERROR,
    GONE,
    ...Object.values(characterProblems({ name: "" })),
    ...Object.values(characterProblems({ name: "x".repeat(61), description: "y".repeat(201), instructions: "y".repeat(4001), opening: "z".repeat(1001) })),
    ...MONOGRAMS.map((m) => m.label),
    characterModelNote({ model: "b" }, { models: [{ id: "b" }], visible: [], privateMode: true }),
    characterModelNote({ model: "b" }, { models: [{ id: "b" }], visible: [] }),
    characterModelNote({ model: "gone" }, { models: [], visible: [] }),
  ];
  const lacking = { zh: [], es: [] };
  for (const text of rest) {
    if (!han.test(translateText(text, zh) ?? "")) lacking.zh.push(text);
    if (translateText(text, es) == null) lacking.es.push(text);
  }
  assert.deepEqual({ page: missing, rest: lacking }, { page: { zh: [], es: [] }, rest: { zh: [], es: [] } });
});

// ---- Where the workspace wires it in ----

test("the workspace gates every surface, keeps Auto off in a character chat and never files unsaved chats", () => {
  const src = (f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  const ws = src("Workspace.jsx");
  // Signed in, released, never the demo; nothing is loaded before that.
  assert.match(ws, /const charactersLive = !demo && !!user && charactersReleased\(config\);/);
  assert.match(ws, /const characters = useCharacters\(charactersLive, user\?\.id\);/);
  assert.match(ws, /const character = charactersLive && textMode \? characters\.byId\(characterId\) : null;/);
  assert.match(src("CharacterChat.jsx"), /if \(!enabled\) \{\s*setState\(\{ list: \[\], loaded: false/);
  // A ?character= link does nothing until the update is live and the list loaded.
  assert.match(ws, /if \(!characterParam \|\| !textMode \|\| !charactersLive \|\| !characters\.loaded\) return;/);
  // The page and its sidebar entry are unknown until released.
  assert.match(ws, /\(mode === "characters" && \(!config \|\| modeReleased\(config, "characters"\)\)\)/);
  assert.match(ws, /\.filter\(\(\[id\]\) => id !== "characters" \|\| modeReleased\(config, "characters"\)\)/);
  assert.match(ws, /mode === "characters" \? \(\s*modeReleased\(config, "characters"\) && \(/);
  // Its instructions come after standing and project instructions, in the one system message.
  assert.match(ws, /withCharacterInstructions\(\s*withProjectInstructions\(instructionsActive \? instructions\.body\.trim\(\) : "", project\),\s*character,\s*\)/);
  // Only a saved chat names its character; a vault chat keeps it inside the vault.
  assert.match(ws, /characterRequestFields\(character, \{ ephemeral, conversationId \}\)/);
  assert.match(ws, /character: character\?\.id \|\| null,/);
  assert.match(ws, /setCharacterId\(chat\.character \|\| null\);/);
  // Auto is off in a character chat until it is chosen again inside it, and the guarded lines are untouched.
  assert.match(ws, /const autoLive = !demo && !!user && textMode && autoModelReleased\(config\);/);
  assert.match(ws, /autoLive && !modelLinked && \(!character \|\| characterAuto\) && autoChoices\.modes\[mode\] === true/);
  // The opening is a turn of its own: never sent, no actions on it, and a fresh chat adds it on send.
  assert.match(ws, /const openingShown = !!character && hasOpening\(character\) && !messages\.length && !current && !carried;/);
  assert.match(ws, /messages: redo \? redo\.base : withOpening\(messages\),/);
  assert.match(ws, /\{!m\.opening && !\(branchesLive/);
  assert.match(ws, /!m\.sample && !m\.opening && \(/);
  // The page itself is never offered in the demo, and never loads its editor before it is opened.
  assert.match(ws, /const Characters = lazy\(\(\) => import\("\.\/Characters\.jsx"\)\);/);
  const page = src("Characters.jsx");
  assert.match(page, /if \(demo \|\| !user\)/);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML|eval\(|localStorage/);
  assert.match(page, /sessionStorage/, "a copy link's token waits in this tab only");
  // Nothing about a character is kept in browser storage, and there are no new dependencies.
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(!Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).some((n) => /character|avatar/i.test(n)));
  // The server copies what it imports from src/ into its image.
  const serverCopy = readFileSync(new URL("../Dockerfile", import.meta.url), "utf8")
    .split("\n")
    .find((line) => line.startsWith("COPY ") && line.endsWith(" ./src/"));
  for (const file of ["src/characters.js", "src/clean-uploads.js", "src/clean-notes.js"])
    assert.ok(serverCopy?.split(/\s+/).includes(file), `${file} is copied into the server image`);
  // A copy link's address never leaves the page: it is in the #fragment.
  assert.match(page, /window\.history\.replaceState\(window\.history\.state, "", window\.location\.pathname \+ window\.location\.search\)/);
});

test("the record: Panic Wipe, Inactivity Wipe and the data guide name characters once released", () => {
  const src = (f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  assert.match(src("panic-wipe.js"), /export const WIPE_CHARACTERS = "Characters, their pictures and copy links";/);
  assert.match(src("PanicWipe.jsx"), /\{charactersLive && <li>\{WIPE_CHARACTERS\}<\/li>\}/);
  assert.match(src("InactivityWipe.jsx"), /\{on\("characters"\) && <li>\{WIPE_CHARACTERS\}<\/li>\}/);
  assert.match(src("DataControls.jsx"), /\{characters && \(\s*<li>\s*Characters:/);
  const zh = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")).strings;
  const es = JSON.parse(readFileSync(new URL("../src/i18n/es.json", import.meta.url), "utf8")).strings;
  for (const text of ["Characters, their pictures and copy links"]) {
    assert.match(zh[text], /角色/);
    assert.match(es[text], /Personajes/);
  }
});
