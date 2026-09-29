import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { addCredit, balance, credits } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { openapiForConfig } from "../server/openapi.js";
import {
  EXTEND_UNAVAILABLE,
  hasAlpha,
  holdUnits,
  imageSize,
  photoIssue,
  photoModels,
  sniff,
  testCutout,
  testOutput,
  toolOf,
  upscaleMaxSide,
} from "../server/photo-tools.js";
import { PHOTO_CHANGED } from "../server/routes/photo-tools.js";
import { knownPage } from "../src/site-routes.js";
import { modeReleased } from "../src/lib.js";
import { rankTools } from "../src/tool-search.js";
import { TOOLS, TOOL_INFO, dataUrlBlob, fitPlan, price, resultName, shrinkScales, sizeNote, toolFrom } from "../src/photo-tools.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const dict = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));

// ---- Pictures ----

const RED = readFileSync(new URL("../data/test-image.png", import.meta.url));
const CUTOUT = testCutout(64);
const dataUrl = (bytes, type = "image/png") => `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
const PHOTO = dataUrl(RED);
// The test PNG with another size in its header: the server reads sizes from
// headers and never decodes a photo, so this is enough to be "that big".
function sized(width, height, bytes = RED) {
  const b = Buffer.from(bytes);
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}
// A JPEG that is only a start-of-frame header, GIF and WebP headers likewise.
const jpeg = (width, height) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xc0, 0x00, 0x0b, 0x08]), Buffer.from([height >> 8, height & 255, width >> 8, width & 255]), Buffer.from([0x01, 0x01, 0x11, 0x00, 0xff, 0xd9])]);
const gif = (width, height) => Buffer.concat([Buffer.from("GIF89a"), Buffer.from([width & 255, width >> 8, height & 255, height >> 8, 0, 0, 0])]);
function webp(kind, width, height) {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0);
  b.write("WEBP", 8);
  b.write(kind, 12, "latin1");
  if (kind === "VP8X") {
    b.writeUIntLE(width - 1, 24, 3);
    b.writeUIntLE(height - 1, 27, 3);
  } else if (kind === "VP8L") {
    b[20] = 0x2f;
    b.writeUInt32LE(((width - 1) | ((height - 1) << 14)) >>> 0, 21);
  } else {
    b.set([0x9d, 0x01, 0x2a], 23);
    b.writeUInt16LE(width, 26);
    b.writeUInt16LE(height, 28);
  }
  return b;
}
// A recovery phrase with a valid checksum, which Seed Guard must stop.
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ---- A catalog the way the live gateway describes it ----

const caps = (extra = {}) => ({
  accepts_prompt: false,
  requires_prompt: false,
  accepts_image_url: true,
  requires_image_url: true,
  ...extra,
});
const withPrompt = { accepts_prompt: true, requires_prompt: true };
const image = (id, capabilities, base = 0.0021, extra = {}) => ({
  id,
  name: id,
  type: "image",
  status: "live",
  category: "image-to-image",
  capabilities,
  pricing: { type: "per_generation", currency: "USD", base_price: base },
  ...extra,
});
const CATALOG = [
  image("birefnet-v2", caps(), 0.0021),
  image("aura-sr", caps(), 0.0021),
  image("crystal-upscaler", caps(), 0.0264),
  image("topaz-upscale", caps(), 0.0413),
  image("seedream-v5-lite-edit", caps(withPrompt), 0.0403),
  image("qwen-image-2-edit", caps(withPrompt), 0.0403),
  image("grok-imagine-edit", caps(withPrompt), 0.033),
  // A base price above its default option: the hold uses the higher one.
  image("flux-2-pro-i2i", caps(withPrompt), 0.0633, {
    pricing: { type: "per_generation", base_price: 0.0633, variants: [{ quality: "1k", options: [{ size: "default", price: 0.0287 }] }, { quality: "2k", options: [{ size: "default", price: 0.0403 }] }] },
  }),
  // A zero-data-retention edit model, for Private mode.
  image("zdr-edit", caps(withPrompt), 0.05, { privacyLevel: "zdr" }),
  // Not offered: the catalog declares no photo input for these.
  image("flux-kontext-pro", { accepts_prompt: true, requires_prompt: true, accepts_image_url: false, requires_image_url: false }, 0.0287, { category: "text-to-image" }),
  image("flux-kontext-max", { accepts_prompt: true, requires_prompt: true, accepts_image_url: false, requires_image_url: false }, 0.0575, { category: "text-to-image" }),
  image("flux-2-pro-outpaint", { accepts_prompt: true, requires_prompt: true, accepts_image_url: false, requires_image_url: false }, 0.0495),
  image("plain-edit", { accepts_prompt: true, requires_prompt: true, accepts_image_url: false, requires_image_url: false }, 0.02),
  // Not photo tools at all: a video row and a text-to-image model.
  image("kling-v3-standard-i2v", caps(withPrompt), 0.9, { category: "image-to-video" }),
  image("gpt-image-2", { accepts_prompt: true, requires_prompt: true, accepts_image_url: true, requires_image_url: false }, 0.05, { category: "text-to-image" }),
];
function catalogFile(t, data = CATALOG) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-photo-catalog-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, "models.json");
  writeFileSync(path, JSON.stringify({ updatedAt: new Date().toISOString(), data }));
  return path;
}

// ---- A stand-in for the gateway's image endpoint ----

// plan: { output(body, i) -> Buffer, cost, status, empty, delay, hang }.
async function gateway(t, plan = {}) {
  const calls = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    const i = calls.length;
    let held = null;
    try {
      // What was held at the moment the provider was asked.
      held = gateway.svc?.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM holds WHERE status='held'").get().n ?? null;
    } catch {}
    calls.push({ url: req.url, body, held });
    if (plan.hang) return;
    if (plan.delay) await new Promise((r) => setTimeout(r, plan.delay));
    if (plan.status) {
      res.writeHead(plan.status, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: { message: "stand-in provider failure" } }));
    }
    const out = plan.output ? plan.output(body, i) : body.model === "birefnet-v2" ? CUTOUT : RED;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        created: 1,
        model: body.model,
        cost: plan.cost ?? 0.002,
        data: plan.empty ? [] : [{ b64_json: Buffer.from(out).toString("base64"), content_type: "image/png" }],
      }),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }));
  return { url: "http://127.0.0.1:" + server.address().port, calls };
}

function fixture(t, { released, gatewayUrl = "http://127.0.0.1:9", catalog, ...extra } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-photo-"));
  const svc = createApp({
    testMode: false,
    gateway: gatewayUrl,
    gatewayKey: "fixture",
    released: released ?? "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: catalog ?? catalogFile(t),
    syncModels: false,
    origin: "http://localhost:5175",
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  svc.dir = dir;
  gateway.svc = svc;
  return svc;
}
let visitor = 0;
async function person(s, username, fund = 50_000_000) {
  const agent = request.agent(s.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  if (fund) addCredit(s.db, r.body.user.id, fund, "fund-" + username, "test_credit");
  return { agent, user: r.body.user };
}
const spends = (s, user) =>
  s.db.prepare("SELECT amount,description FROM ledger WHERE user_id=? AND amount<0 ORDER BY created,rowid").all(user).map((r) => ({ ...r }));
const heldOf = (s, user) => s.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM holds WHERE user_id=? AND status='held'").get(user).n;
const mediaOf = (s, user) => s.db.prepare("SELECT * FROM media WHERE user_id=?").all(user);
const count = (s, table) => s.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n;
const quote = (p, body) => p.agent.post("/api/photo-tools/quote").send(body);
// A run, asking for exactly the price the quote shows.
async function run(p, body = {}, status) {
  const tool = body.tool ?? "background";
  const model = body.model ?? { edit: "seedream-v5-lite-edit", background: "birefnet-v2", upscale: "aura-sr" }[tool];
  const q = (await quote(p, { tool, model, ...(body.private ? { private: true } : {}), ...(body.ephemeral ? { ephemeral: true } : {}) })).body;
  const res = await p.agent.post("/api/photo-tools/run").send({
    tool,
    model,
    image: PHOTO,
    max_units: q.units,
    requestId: "pt-" + Math.random(),
    ...(tool === "edit" ? { prompt: "Make the sky a warm sunset" } : {}),
    ...body,
  });
  if (status !== undefined) assert.equal(res.status, status, JSON.stringify(res.body));
  return res;
}

// ---- The release gate ----

test("unreleased: every route is refused before anything runs, the page is unknown and the docs leave it out", async (t) => {
  const s = fixture(t, { released: "mvp" });
  const a = await person(s, "ana");
  for (const [method, path] of [
    ["get", "/api/photo-tools"],
    ["post", "/api/photo-tools/quote"],
    ["post", "/api/photo-tools/run"],
    ["post", "/API/Photo-Tools/Run"],
  ]) {
    const res = await a.agent[method](path).send({ tool: "background" }).expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Photo Tools is coming soon.");
  }
  // Refused before authentication, like every gated route.
  await request(s.app).post("/api/photo-tools/run").send({}).expect(403);
  const config = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.phototools, false);
  const entry = config.releases.updates.find((u) => u.id === "phototools");
  assert.equal(entry.title, "Photo Tools");
  assert.equal(entry.points.length, 3);
  const docs = (await request(s.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(docs.paths).some((p) => p.startsWith("/api/photo-tools")));
  // The page is a 404 until release.
  await request(s.app).get("/workspace/photos").expect(404);
  assert.equal(knownPage("/workspace/photos", {}), false);
  assert.equal(knownPage("/workspace/photos", { photos: true }), true);
  // Released on its own, it still needs Image Studio's models.
  const partly = fixture(t, { released: "mvp,phototools" });
  const b = await person(partly, "ben");
  const res = await b.agent.post("/api/photo-tools/quote").send({ tool: "background", model: "birefnet-v2" }).expect(403);
  assert.equal(res.body.error.code, "feature_unreleased");
  assert.match(res.body.error.message, /coming soon/);
  await request(partly.app).get("/workspace/photos").expect(404);
  const gates = (body, method = "POST", path = "/api/photo-tools/run") => featuresFor({ path, method, body });
  assert.deepEqual(gates({}), ["phototools", "images"]);
  assert.deepEqual(gates({}, "GET", "/api/photo-tools"), ["phototools", "images"]);
  assert.deepEqual(gates({}, "POST", "/api/photo-tools/quote"), ["phototools", "images"]);
  // What a run turns on needs its own update, as the same chat would.
  assert.deepEqual(gates({ ephemeral: true }), ["phototools", "images", "ephemeral"]);
  assert.deepEqual(gates({ private: true }), ["phototools", "images", "private", "ephemeral"]);
  assert.deepEqual(gates({ veil_masked: 0, allow_seed_phrase: true }), ["phototools", "images", "trail", "seedguard"]);
  // Released with the studio, nothing is asked twice.
  const own = fixture(t, { released: "mvp,phototools,images" });
  const c = await person(own, "cyd");
  await c.agent.get("/api/photo-tools").expect(200);
  // Off the record isn't available until its own update is.
  const res2 = await c.agent.post("/api/photo-tools/run").send({ tool: "background", model: "birefnet-v2", ephemeral: true }).expect(403);
  assert.equal(res2.body.error.code, "feature_unreleased");
});

test("released: the page is served, the docs list the routes and the update flag will flip at release", async (t) => {
  const s = fixture(t);
  await request(s.app).get("/workspace/photos").expect((r) => assert.notEqual(r.status, 404));
  const docs = (await request(s.app).get("/api/openapi.json").expect(200)).body;
  for (const path of ["/api/photo-tools", "/api/photo-tools/quote", "/api/photo-tools/run"]) assert.ok(docs.paths[path], path);
  assert.ok(openapiForConfig({ released: "all" }).paths["/api/photo-tools/run"].post);
  const i = UPDATES.findIndex((u) => u.id === "phototools");
  assert.ok(i >= 0);
  assert.equal(typeof committed[i], "boolean");
  assert.equal(UPDATES[i].points.length, 3);
});

test("the app's entry points are gated: the sidebar, the page, the palette and the lazy chunk", () => {
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(ws, /\.filter\(\(\[id\]\) => id !== "photos" \|\| modeReleased\(config, "photos"\)\)/);
  assert.match(ws, /\(mode === "photos" && \(!config \|\| modeReleased\(config, "photos"\)\)\)/);
  assert.match(ws, /\) : mode === "photos" \? \(\s*modeReleased\(config, "photos"\) && \(/);
  assert.match(ws, /const PhotoTools = lazy\(\(\) => import\("\.\/PhotoTools\.jsx"\)\);/);
  assert.doesNotMatch(ws, /from "\.\/photo-tools\.js"/);
  const lib = readFileSync(new URL("../src/lib.js", import.meta.url), "utf8");
  assert.match(lib, /if \(mode === "photos"\) return isReleased\(config, "phototools"\) && isReleased\(config, "images"\);/);
  const site = readFileSync(new URL("../server/routes/site.js", import.meta.url), "utf8");
  assert.match(site, /photos: isReleased\(cfg, "phototools"\) && isReleased\(cfg, "images"\)/);
  // The sidebar and the palette agree with the config.
  const none = { releases: { features: {} } },
    onlyPhotos = { releases: { features: { phototools: true } } },
    both = { releases: { features: { phototools: true, images: true } } };
  assert.equal(modeReleased(none, "photos"), false);
  assert.equal(modeReleased(onlyPhotos, "photos"), false);
  assert.equal(modeReleased(both, "photos"), true);
});

// ---- Which models offer which tool ----

test("models are offered only when the catalog says they take a photo, and Extend is not offered", async (t) => {
  const s = fixture(t);
  const p = await person(s, "ana");
  const d = (await p.agent.get("/api/photo-tools").expect(200)).body;
  const ids = (tool) => d.tools.find((x) => x.id === tool).models.map((m) => m.id);
  assert.deepEqual(d.tools.map((x) => x.id), ["edit", "background", "upscale"]);
  // The preferred edit model first, then by price.
  assert.deepEqual(ids("edit"), ["seedream-v5-lite-edit", "qwen-image-2-edit", "flux-2-pro-i2i", "grok-imagine-edit", "zdr-edit"]);
  assert.deepEqual(ids("background"), ["birefnet-v2"]);
  assert.deepEqual(ids("upscale"), ["aura-sr", "crystal-upscaler", "topaz-upscale"]);
  assert.equal(d.tools.find((x) => x.id === "edit").default, "seedream-v5-lite-edit");
  assert.equal(d.tools.find((x) => x.id === "upscale").default, "aura-sr");
  // Not offered: no photo input in the catalog, a video row, a text-to-image model.
  for (const gone of ["flux-kontext-pro", "flux-kontext-max", "flux-2-pro-outpaint", "plain-edit", "kling-v3-standard-i2v", "gpt-image-2"])
    assert.ok(![...ids("edit"), ...ids("background"), ...ids("upscale")].includes(gone), gone);
  // Extend is listed as unavailable, with why.
  assert.deepEqual(d.unavailable, [{ tool: "extend", reason: "The gateway's outpainting model doesn't accept a photo yet." }]);
  const ext = await p.agent.post("/api/photo-tools/quote").send({ tool: "extend", model: "flux-2-pro-outpaint" }).expect(400);
  assert.equal(ext.body.error.code, "tool_unavailable");
  assert.equal(ext.body.error.message, EXTEND_UNAVAILABLE);
  // The highest published price is the hold; the display and hold agree.
  const flux = d.tools[0].models.find((m) => m.id === "flux-2-pro-i2i");
  assert.equal(flux.credits, 63.3);
  assert.equal(flux.units, holdUnits(CATALOG.find((m) => m.id === "flux-2-pro-i2i"), 1));
  assert.equal(d.private_available, true);
  assert.deepEqual(d.limits, { image_bytes: 1.5 * 1024 * 1024, prompt_characters: 2000 });
  // A model the tool doesn't offer can't be asked for it.
  for (const [tool, model] of [["edit", "aura-sr"], ["background", "seedream-v5-lite-edit"], ["upscale", "birefnet-v2"], ["edit", "flux-kontext-pro"], ["edit", "plain-edit"]]) {
    const res = await quote(p, { tool, model }).expect(400);
    assert.equal(res.body.error.code, "unsupported_model", model);
  }
  await quote(p, { tool: "edit", model: "no-such-model" }).expect(404);
  await quote(p, { tool: "sharpen", model: "aura-sr" }).expect(400);
});

test("a catalog without capability fields (the bundled snapshot) offers nothing, and a live one can add outpainting later", () => {
  const cfg = { released: "all", gatewayKey: "x", testMode: false };
  const bare = { data: [{ id: "birefnet-v2", type: "image", status: "live", pricing: { base_price: 0.0021 } }] };
  const none = photoModels(bare, cfg);
  assert.deepEqual([none.edit, none.background, none.upscale], [[], [], []]);
  assert.equal(photoIssue(bare.data[0], "background", cfg), "no_image_input");
  // A utility model that also demands a prompt can't be run with no words.
  const odd = image("aura-sr", caps({ requires_prompt: true, accepts_prompt: true }));
  assert.equal(photoIssue(odd, "upscale", cfg), "needs_prompt");
  // The outpaint model missing from the catalog says so.
  const gone = photoModels({ data: [] }, cfg);
  assert.equal(gone.unavailable[0].reason, "The gateway doesn't list an outpainting model right now.");
  assert.equal(toolOf({ id: "flux-kontext-pro" }), "edit");
  assert.equal(toolOf({ id: "gpt-image-2" }), null);
  // No gateway, no tools.
  assert.equal(photoIssue(CATALOG[0], "background", { released: "all", testMode: false }), "no_gateway");
  assert.equal(photoIssue({ ...CATALOG[0], status: "unavailable" }, "background", cfg), "not_live");
});

// ---- Request shapes ----

test("each tool sends the shape its model documents: a photo, and words only where a prompt is taken", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  await run(p, { tool: "background" }, 200);
  await run(p, { tool: "upscale", model: "crystal-upscaler" }, 200);
  await run(p, { tool: "edit", model: "qwen-image-2-edit", prompt: "  Turn the coat red  " }, 200);
  await run(p, { tool: "edit", model: "flux-2-pro-i2i", prompt: "Add snow" }, 200);
  assert.deepEqual(g.calls.map((c) => c.url), Array(4).fill("/v1/images/generations"));
  // Background removal and upscaling take no prompt at all: the field isn't sent.
  assert.deepEqual(Object.keys(g.calls[0].body).sort(), ["image_url", "model"]);
  assert.deepEqual(g.calls[0].body, { model: "birefnet-v2", image_url: PHOTO });
  assert.deepEqual(g.calls[1].body, { model: "crystal-upscaler", image_url: PHOTO });
  // An edit sends its words, trimmed, and the photo.
  assert.deepEqual(g.calls[2].body, { model: "qwen-image-2-edit", prompt: "Turn the coat red", image_url: PHOTO });
  // A model with priced qualities gets the first, as Image Studio does.
  assert.deepEqual(g.calls[3].body, { model: "flux-2-pro-i2i", prompt: "Add snow", quality: "1k", image_url: PHOTO });
  // Words sent with a tool that takes none never reach the provider.
  const q = (await quote(p, { tool: "upscale", model: "aura-sr" })).body;
  await p.agent.post("/api/photo-tools/run").send({ tool: "upscale", model: "aura-sr", image: PHOTO, prompt: "secret words", max_units: q.units }).expect(200);
  assert.ok(!JSON.stringify(g.calls[4].body).includes("secret words"));
});

test("a run is refused before anything is held when the photo or the words are unusable", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  const q = (await quote(p, { tool: "edit", model: "seedream-v5-lite-edit" })).body;
  const base = { tool: "edit", model: "seedream-v5-lite-edit", image: PHOTO, prompt: "Warmer light", max_units: q.units };
  let who = p,
    asked = 0;
  const refused = async (change, code, status = 400) => {
    // The run route allows ten a minute an account: keep clear of it.
    if (asked++ % 8 === 7) who = await person(s, "spare" + asked);
    const res = await who.agent.post("/api/photo-tools/run").send({ ...base, requestId: "x" + Math.random(), ...change }).expect(status);
    assert.equal(res.body.error.code, code, JSON.stringify(Object.keys(change)));
    assert.equal(count(s, "holds"), 0);
    assert.equal(g.calls.length, 0);
  };
  await refused({ image: undefined }, "invalid_image");
  await refused({ image: "https://example.com/photo.png" }, "invalid_image");
  await refused({ image: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=" }, "invalid_image");
  await refused({ image: "data:image/png;base64,@@@" }, "invalid_image");
  // A JPEG label on PNG bytes: the file's own bytes decide.
  await refused({ image: dataUrl(RED, "image/jpeg") }, "invalid_image");
  await refused({ image: dataUrl(Buffer.from("not a picture at all")) }, "invalid_image");
  await refused({ image: dataUrl(Buffer.concat([RED, Buffer.alloc(1.6 * 1024 * 1024)])) }, "image_too_large");
  await refused({ prompt: "   " }, "invalid_prompt");
  await refused({ prompt: undefined }, "invalid_prompt");
  await refused({ prompt: "x".repeat(2001) }, "invalid_prompt");
  await refused({ max_units: undefined }, "estimate_changed", 409);
  await refused({ max_units: q.units - 1 }, "estimate_changed", 409);
  await refused({ max_units: String(q.units) }, "estimate_changed", 409);
  await refused({ ephemeral: "yes" }, "invalid_request");
  await refused({ model: "aura-sr" }, "unsupported_model");
  await refused({ tool: "extend" }, "tool_unavailable");
  await refused({ source: "asset_nobody" }, "invalid_request", 404);
  const res = await who.agent.post("/api/photo-tools/run").send({ ...base, max_units: q.units - 5 }).expect(409);
  assert.equal(res.body.error.message, PHOTO_CHANGED);
  assert.equal(spends(s, p.user.id).length, 0);
});

// ---- Money ----

test("the quote is exactly what a run holds, and what's charged is the provider's cost, never above it", async (t) => {
  const g = await gateway(t, { cost: 0.03 });
  const s = fixture(t, { gatewayUrl: g.url, markup: 20 });
  const p = await person(s, "ana");
  const q = (await quote(p, { tool: "edit", model: "seedream-v5-lite-edit" })).body;
  // 0.0403 USD at a 20% rate, in ledger units and credits.
  assert.equal(q.units, Math.ceil(403000 * 1.2));
  assert.equal(q.credits, credits(q.units));
  assert.equal(q.estimate, true);
  assert.equal(heldOf(s, p.user.id), 0, "a quote holds nothing");
  assert.equal(count(s, "holds"), 0);
  const before = balance(s.db, p.user.id).total;
  const res = await run(p, { tool: "edit", model: "seedream-v5-lite-edit" }, 200);
  // At the moment the provider was asked, exactly the quote was held.
  assert.equal(g.calls[0].held, q.units);
  // The provider reported 0.03 USD: charged with the rate, under the hold.
  const charged = Math.ceil(300000 * 1.2);
  assert.equal(res.body.receipt.charged, charged);
  assert.ok(charged < q.units);
  assert.equal(res.body.receipt.credits_charged, credits(charged));
  assert.equal(res.body.receipt.released, credits(q.units - charged));
  assert.equal(balance(s.db, p.user.id).total, before - charged);
  assert.equal(heldOf(s, p.user.id), 0);
  assert.deepEqual(spends(s, p.user.id), [{ amount: -charged, description: "seedream-v5-lite-edit" }]);
  // A provider that reports more than the hold is never charged past it.
  const dear = await gateway(t, { cost: 5 });
  const s2 = fixture(t, { gatewayUrl: dear.url });
  const b = await person(s2, "ben");
  const q2 = (await quote(b, { tool: "background", model: "birefnet-v2" })).body;
  const over = await run(b, { tool: "background" }, 200);
  assert.equal(over.body.receipt.charged, q2.units);
  // The account's balance and Spending Limits are checked on the hold, before the provider.
  const poor = await person(s2, "cyd", 1000);
  const nope = await run(poor, { tool: "background" }, 402);
  assert.equal(nope.body.error.code, "insufficient_credits");
  assert.equal(dear.calls.length, 1);
  const limited = await person(s2, "dia");
  await limited.agent.patch("/api/spending-limits").send({ daily_limit: 1 }).expect(200);
  const stopped = await run(limited, { tool: "background" }, 402);
  assert.equal(stopped.body.error.code, "spending_limit");
  assert.equal(dear.calls.length, 1, "the limit stops it before the provider is asked");
  assert.equal(spends(s2, limited.user.id).length, 0);
});

test("you pay only for results you get: every failure is released and charges nothing", async (t) => {
  const cases = [
    ["a provider error", { status: 500 }, /Nothing was charged/],
    ["a provider that turns the request down", { status: 400 }, /Nothing was charged/],
    ["the gateway's account refused", { status: 402 }, /Nothing was charged/],
    ["a reply with no picture", { empty: true }, /Nothing was charged|nothing was charged/],
    ["a reply that isn't a picture", { output: () => Buffer.from("<html>sorry</html>") }, /nothing was saved or charged/],
  ];
  for (const [label, plan, message] of cases) {
    const g = await gateway(t, plan);
    const s = fixture(t, { gatewayUrl: g.url });
    const p = await person(s, "ana");
    const before = balance(s.db, p.user.id).total;
    const res = await run(p, { tool: "upscale" });
    assert.ok(res.status >= 400, label);
    assert.match(res.body.error.message, message, label);
    assert.equal(g.calls.length, 1, label);
    assert.equal(balance(s.db, p.user.id).total, before, label);
    assert.equal(heldOf(s, p.user.id), 0, label);
    assert.equal(spends(s, p.user.id).length, 0, label);
    assert.equal(mediaOf(s, p.user.id).length, 0, label);
    assert.equal(count(s, "library_items"), 0, label);
    // The hold was released, so the same account can go straight on.
    assert.equal(s.db.prepare("SELECT status FROM holds WHERE user_id=?").get(p.user.id).status, "released", label);
  }
  // A cut-out that can't be transparent isn't a cut-out: nothing saved, nothing charged.
  const opaque = await gateway(t, { output: () => RED });
  const s = fixture(t, { gatewayUrl: opaque.url });
  const p = await person(s, "bob");
  const res = await run(p, { tool: "background" }, 502);
  assert.equal(res.body.error.code, "photo_not_transparent");
  assert.equal(spends(s, p.user.id).length, 0);
  assert.equal(mediaOf(s, p.user.id).length, 0);
  // The same picture is fine for an edit or an upscale, which need no transparency.
  await run(p, { tool: "upscale" }, 200);
  // A timeout charges nothing either, and says so.
  const slow = await gateway(t, { hang: true });
  const s3 = fixture(t, { gatewayUrl: slow.url, requestTimeoutMs: 150 });
  const q = await person(s3, "cyd");
  const late = await run(q, { tool: "background" }, 504);
  assert.equal(late.body.error.code, "provider_timeout");
  assert.match(late.body.error.message, /nothing was charged/);
  assert.equal(spends(s3, q.user.id).length, 0);
  assert.equal(heldOf(s3, q.user.id), 0);
});

test("a photo already being processed holds the account: a second run waits and holds nothing", async (t) => {
  const g = await gateway(t, { delay: 300 });
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  const first = run(p, { tool: "background" }, 200);
  await new Promise((r) => setTimeout(r, 100));
  const second = await run(p, { tool: "upscale" }, 409);
  assert.equal(second.body.error.code, "photo_running");
  await first;
  assert.equal(g.calls.length, 1);
  assert.equal(spends(s, p.user.id).length, 1);
  // A repeated request id is refused too, never charged twice.
  const dup = { tool: "background", model: "birefnet-v2", image: PHOTO, requestId: "same-id" };
  const q = (await quote(p, dup)).body;
  await p.agent.post("/api/photo-tools/run").send({ ...dup, max_units: q.units }).expect(200);
  const again = await p.agent.post("/api/photo-tools/run").send({ ...dup, max_units: q.units }).expect(409);
  assert.equal(again.body.error.code, "duplicate_request");
  assert.equal(spends(s, p.user.id).length, 2);
});

// ---- The library, and off the record ----

test("a result is saved to the library like an Image Studio one, with no request settings kept", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  // Give it a library picture to come from.
  const first = await run(p, { tool: "upscale" }, 200);
  const src = first.body.media.id;
  const res = await run(p, { tool: "background", source: src }, 200);
  assert.equal(res.body.saved, true);
  assert.equal(res.body.image, null);
  assert.equal(res.body.mime, "image/png");
  const media = res.body.media;
  assert.equal(media.kind, "image");
  assert.equal(media.model, "birefnet-v2");
  assert.equal(media.prompt, "Background removed");
  assert.equal(media.cost, res.body.receipt.credits_charged);
  assert.equal(media.expires, null);
  // It's listed in the library and served to its owner as the transparent PNG.
  const list = (await p.agent.get("/api/media").expect(200)).body.data;
  assert.deepEqual(list.map((m) => m.id).sort(), [media.id, src].sort());
  const file = await p.agent.get(media.url).buffer(true).parse((r, cb) => { const c = []; r.on("data", (d) => c.push(d)); r.on("end", () => cb(null, Buffer.concat(c))); }).expect(200);
  assert.equal(sniff(file.body), "image/png");
  assert.ok(hasAlpha(file.body));
  // No recipe: nothing to rerun, and no photo kept as request settings.
  assert.equal(count(s, "library_items"), 0);
  // An edit is filed under what was asked for, an upscale under what was done.
  const edit = await run(p, { tool: "edit", prompt: "Make the coat red" }, 200);
  assert.equal(edit.body.media.prompt, "Make the coat red");
  const up = await run(p, { tool: "upscale" }, 200);
  assert.equal(up.body.media.prompt, "Upscaled photo");
  // Usage Insights sees an ordinary image spend.
  assert.equal(s.db.prepare("SELECT kind FROM holds WHERE user_id=? LIMIT 1").get(p.user.id).kind, "image");
  // Somebody else's library picture can't be named as a source.
  const other = await person(s, "ben");
  await run(other, { tool: "background", source: src }, 404);
  // Nothing of the photo or the words is logged.
  const lines = [];
  const spy = (...a) => lines.push(a.map(String).join(" "));
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  Object.assign(console, { log: spy, warn: spy, error: spy, info: spy });
  try {
    await run(p, { tool: "edit", prompt: "confidential wording xyzzy" }, 200);
    await run(p, { tool: "background", model: "no-such" }, 404);
  } finally {
    Object.assign(console, saved);
  }
  assert.ok(!lines.some((l) => l.includes("xyzzy") || l.includes(PHOTO.slice(30, 90))), "no content in the logs");
});

test("off the record: the result comes back in the reply, nothing is saved and it is filed by model only", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  const q = (await quote(p, { tool: "background", model: "birefnet-v2", ephemeral: true })).body;
  assert.equal(q.units, holdUnits(CATALOG[0], 1));
  const res = await run(p, { tool: "background", ephemeral: true }, 200);
  assert.equal(res.body.saved, false);
  assert.equal(res.body.media, null);
  assert.match(res.body.image, /^data:image\/png;base64,/);
  assert.ok(hasAlpha(Buffer.from(res.body.image.split(",")[1], "base64")));
  assert.equal(mediaOf(s, p.user.id).length, 0);
  assert.equal(count(s, "library_items"), 0);
  assert.deepEqual(readdirSync(join(s.dir, "media")).filter((f) => !f.startsWith(".")), []);
  assert.equal((await p.agent.get("/api/media").expect(200)).body.data.length, 0);
  // Charged as any run is.
  assert.equal(spends(s, p.user.id).length, 1);
  // Filed like an off-the-record chat, so the spend doesn't say what it was for.
  const hold = s.db.prepare("SELECT kind FROM holds WHERE user_id=?").get(p.user.id);
  assert.equal(hold.kind, "chat");
});

// ---- Private Mode ----

test("Private mode needs a zero-data-retention model: it keeps nothing, and is declined when no model qualifies", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  const d = (await p.agent.get("/api/photo-tools").expect(200)).body;
  assert.equal(d.private_available, true);
  assert.deepEqual(d.tools[0].models.filter((m) => m.private).map((m) => m.id), ["zdr-edit"]);
  // A model that isn't private is refused, with nothing held.
  const no = await quote(p, { tool: "edit", model: "seedream-v5-lite-edit", private: true }).expect(400);
  assert.equal(no.body.error.code, "private_model_required");
  assert.match(no.body.error.message, /No photo model offers it right now|zero data retention/);
  // A private model runs with zero-data-retention routing, and nothing is saved.
  const res = await run(p, { tool: "edit", model: "zdr-edit", private: true }, 200);
  assert.equal(res.body.saved, false);
  assert.match(res.body.image, /^data:image\/png/);
  assert.deepEqual(g.calls[0].body.provider, { zdr: true, data_collection: "deny" });
  assert.equal(mediaOf(s, p.user.id).length, 0);
  assert.equal(res.body.privacy.retention, "zero_data_retention");
  assert.equal(res.body.privacy.storage, "private");
  // Without Private mode, nothing asks for that routing.
  await run(p, { tool: "edit", model: "zdr-edit" }, 200);
  assert.equal(g.calls[1].body.provider, undefined);
  // The stock catalog has no zero-data-retention photo model: it says so.
  const bare = fixture(t, { gatewayUrl: g.url, catalog: catalogFile(t, CATALOG.filter((m) => m.id !== "zdr-edit")) });
  const b = await person(bare, "ben");
  assert.equal((await b.agent.get("/api/photo-tools").expect(200)).body.private_available, false);
  const refused = await run(b, { tool: "background", private: true }, 400);
  assert.equal(refused.body.error.code, "private_model_required");
  assert.equal(heldOf(bare, b.user.id), 0);
});

// ---- Seed Guard, Privacy Trail, Model Status ----

test("Seed Guard refuses a recovery phrase in the words before anything is held, unless confirmed", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  const res = await run(p, { tool: "edit", prompt: `Write this on the wall: ${SEED}` }, 400);
  assert.equal(res.body.error.code, "seed_phrase_blocked");
  assert.equal(g.calls.length, 0);
  assert.equal(count(s, "holds"), 0);
  // The chat's own "Send anyway" goes through.
  await run(p, { tool: "edit", prompt: `Write this on the wall: ${SEED}`, allow_seed_phrase: true }, 200);
  // Seed Guard off, nothing to check.
  const off = fixture(t, { gatewayUrl: g.url, released: "mvp,phototools,images" });
  const q = await person(off, "bob");
  await run(q, { tool: "edit", prompt: SEED }, 200);
});

test("Privacy Trail reports where it went, and Model Status counts the call", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  const res = await run(p, { tool: "background", veil_masked: null }, 200);
  assert.equal(res.body.privacy.model, "birefnet-v2");
  assert.equal(res.body.privacy.storage, "saved");
  assert.equal(res.body.privacy.retention, "provider_may_retain");
  assert.equal(res.body.privacy.veil_masked, null);
  assert.equal(res.body.privacy.receipt_id, null);
  const off = await run(p, { tool: "background", ephemeral: true, veil_masked: 0 }, 200);
  assert.equal(off.body.privacy.storage, "off_the_record");
  assert.equal(off.body.privacy.veil_masked, 0);
  // Model Status: one ok event per finished call, with nothing about the person.
  assert.deepEqual(s.modelStatus.events().map((e) => e.outcome), ["ok", "ok"]);
  // A provider that fails counts against its model.
  const bad = await gateway(t, { status: 500 });
  const s2 = fixture(t, { gatewayUrl: bad.url });
  const b = await person(s2, "ben");
  await run(b, { tool: "upscale" });
  assert.deepEqual(s2.modelStatus.events().map((e) => e.outcome), ["error"]);
});

// ---- Erase and export ----

test("results are ordinary library images: exported with the account and erased with it, files included", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  const res = await run(p, { tool: "background" }, 200);
  const id = res.body.media.id;
  const exported = (await p.agent.get("/api/account/export").expect(200)).body;
  assert.ok(exported.media.some((m) => m.id === id && m.model === "birefnet-v2"));
  assert.equal(readdirSync(join(s.dir, "media")).filter((f) => !f.startsWith(".")).length, 1);
  // Panic Wipe, closure and Inactivity Wipe share this erase.
  await p.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(mediaOf(s, p.user.id).length, 0);
  assert.deepEqual(readdirSync(join(s.dir, "media")).filter((f) => !f.startsWith(".")), []);
  // Deleting the result from the library removes it too.
  const q = await person(s, "bob");
  const r2 = await run(q, { tool: "background" }, 200);
  await q.agent.delete("/api/media/" + r2.body.media.id).expect(200);
  assert.equal(mediaOf(s, q.user.id).length, 0);
});

// ---- The pieces the page uses ----

test("stand-in output: a transparent cut-out for background removal, an opaque picture otherwise", () => {
  const cut = testOutput("background");
  assert.equal(sniff(cut), "image/png");
  assert.ok(hasAlpha(cut));
  assert.ok(!hasAlpha(testOutput("edit")));
  assert.ok(!hasAlpha(testOutput("upscale")));
  // Alpha is read from headers: RGBA, or a transparency chunk; WebP's flags; nothing else.
  assert.ok(hasAlpha(testCutout(8)));
  assert.equal(hasAlpha(Buffer.from("not a picture")), false);
  const riff = (chunk, flags) => {
    const b = Buffer.alloc(30);
    b.write("RIFF", 0);
    b.write("WEBP", 8);
    b.write(chunk, 12);
    b[20] = flags;
    return b;
  };
  assert.equal(hasAlpha(riff("VP8X", 0x10)), true);
  assert.equal(hasAlpha(riff("VP8X", 0)), false);
  assert.equal(hasAlpha(riff("VP8 ", 0x10)), false);
  const lossless = riff("VP8L", 0x2f);
  lossless[24] = 0x10;
  assert.equal(hasAlpha(lossless), true);
  assert.equal(sniff(Buffer.from("GIF89a")), "image/gif");
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "image/jpeg");
  assert.equal(sniff(Buffer.from("plain")), null);
});

// ---- Upscale: the input is capped so its result can be returned ----

test("photo sizes are read from headers: PNG, JPEG, GIF and the three WebP kinds", () => {
  assert.deepEqual(imageSize(RED), { width: 600, height: 600 });
  assert.deepEqual(imageSize(sized(1234, 56)), { width: 1234, height: 56 });
  assert.deepEqual(imageSize(jpeg(1025, 700)), { width: 1025, height: 700 });
  assert.deepEqual(imageSize(gif(320, 200)), { width: 320, height: 200 });
  assert.deepEqual(imageSize(webp("VP8X", 3000, 2000)), { width: 3000, height: 2000 });
  assert.deepEqual(imageSize(webp("VP8L", 1024, 512)), { width: 1024, height: 512 });
  assert.deepEqual(imageSize(webp("VP8 ", 800, 600)), { width: 800, height: 600 });
  // Truncated or unknown files have no size.
  assert.equal(imageSize(RED.subarray(0, 12)), null);
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46])), null);
  assert.equal(imageSize(Buffer.from("plain text")), null);
});

test("each upscaler's input cap follows its scale: aura-sr is 4x, so 1024 px in for at most 4096 out", () => {
  assert.equal(upscaleMaxSide("aura-sr"), 1024);
  // Scales that aren't published are treated as the worst case.
  assert.equal(upscaleMaxSide("crystal-upscaler"), 1024);
  assert.equal(upscaleMaxSide("topaz-upscale"), 1024);
  assert.equal(upscaleMaxSide("anything-else"), 1024);
  // A model known to scale less takes a bigger input, one that scales more a smaller one.
  assert.equal(upscaleMaxSide("gentle", { gentle: 2 }), 2048);
  assert.equal(upscaleMaxSide("huge", { huge: 8 }), 512);
});

test("an upscale takes a photo up to its model's long side, and is refused before anything is held above it", async (t) => {
  const g = await gateway(t);
  const s = fixture(t, { gatewayUrl: g.url });
  const p = await person(s, "ana");
  // The page learns the cap from the model list: upscalers only.
  const d = (await p.agent.get("/api/photo-tools").expect(200)).body;
  for (const m of d.tools.find((x) => x.id === "upscale").models) assert.equal(m.max_side, 1024, m.id);
  for (const tool of ["edit", "background"]) for (const m of d.tools.find((x) => x.id === tool).models) assert.equal(m.max_side, undefined, m.id);
  const q = (await quote(p, { tool: "upscale", model: "aura-sr" })).body;
  const attempt = (image, model = "aura-sr") =>
    p.agent.post("/api/photo-tools/run").send({ tool: "upscale", model, image, max_units: q.units, requestId: "up-" + Math.random() });
  const refused = async (image, model) => {
    const res = await attempt(image, model);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(count(s, "holds"), 0, "nothing was held");
    assert.equal(g.calls.length, 0, "the provider was never asked");
    return res;
  };
  // 1025 px on either side is one too many, whatever the file type.
  const wide = await refused(dataUrl(sized(1025, 100)));
  assert.equal(wide.body.error.code, "image_too_large_for_upscale");
  assert.match(wide.body.error.message, /up to 1024 px on its long side/);
  await refused(dataUrl(sized(100, 1025)));
  await refused(dataUrl(sized(4000, 3000)));
  await refused(dataUrl(jpeg(2000, 100), "image/jpeg"));
  await refused(dataUrl(gif(1100, 10), "image/gif"));
  await refused(dataUrl(webp("VP8X", 1025, 10), "image/webp"));
  // A photo whose size can't be read isn't sent to a model that will grow it.
  const blind = await refused(dataUrl(RED.subarray(0, 12)));
  assert.equal(blind.body.error.code, "invalid_image");
  // The run route allows ten a minute an account: carry on with another.
  const q2 = await person(s, "bea");
  const again = (who, tool, model, image, extra = {}) =>
    quote(who, { tool, model }).then((r) => who.agent.post("/api/photo-tools/run").send({ tool, model, image, max_units: r.body.units, ...extra }));
  // Exactly the cap goes through, and so does anything smaller.
  assert.equal((await again(q2, "upscale", "aura-sr", dataUrl(sized(1024, 1024)))).status, 200);
  assert.equal((await again(q2, "upscale", "aura-sr", dataUrl(jpeg(1024, 300), "image/jpeg"))).status, 200);
  assert.equal((await again(q2, "upscale", "aura-sr", PHOTO)).status, 200);
  assert.equal(g.calls.length, 3);
  // Every upscaler, not only aura-sr.
  for (const model of ["crystal-upscaler", "topaz-upscale"]) {
    const res = await again(q2, "upscale", model, dataUrl(sized(2048, 64)));
    assert.equal(res.status, 400, model);
    assert.equal(res.body.error.code, "image_too_large_for_upscale", model);
  }
  assert.equal(g.calls.length, 3);
  // The other tools take a bigger photo: their result isn't 4x bigger.
  const big = dataUrl(sized(3000, 2000));
  assert.equal((await again(q2, "edit", "seedream-v5-lite-edit", big, { prompt: "Warmer" })).status, 200);
  assert.equal((await again(q2, "background", "birefnet-v2", big)).status, 200);
  // Only the runs that were let through were charged.
  assert.equal(spends(s, q2.user.id).length, 5);
  assert.equal(spends(s, p.user.id).length, 0);
});

test("the page shrinks an upscale's photo to a copy that fits, and says so in the result", () => {
  // The same rule the server holds it to, read from the model list.
  assert.deepEqual(fitPlan(4000, 3000, 1024), { width: 1024, height: 768, scaled: true });
  assert.deepEqual(fitPlan(3000, 4000, 1024), { width: 768, height: 1024, scaled: true });
  assert.deepEqual(fitPlan(1024, 1024, 1024), { width: 1024, height: 1024, scaled: false });
  assert.deepEqual(fitPlan(600, 400, 1024), { width: 600, height: 400, scaled: false });
  assert.deepEqual(fitPlan(10000, 3, 1024), { width: 1024, height: 1, scaled: true });
  const page = readFileSync(new URL("../src/PhotoTools.jsx", import.meta.url), "utf8");
  // The copy is made before a run is allowed, sent instead of the photo, and compared with the result.
  for (const piece of [
    "  fitLongSide,\n",
    "list.find((m) => m.id === model)?.max_side || 1024",
    "fitLongSide(photoUrl, maxSide)",
    "    copyReady &&\n",
    "const before = maxSide ? copy.url : photo.url,",
    "image: before,",
    "`Upscaled from a ${result.copy} px copy`",
  ])
    assert.ok(page.includes(piece), piece);
  // Chinese for the new lines.
  const translate = compileDictionary(dict);
  const han = /\p{Script=Han}/u;
  for (const en of [
    "Upscaled from a 1024 px copy",
    "A photo bigger than 1024 px on its long side is shrunk to a copy that size here first, so the result stays a manageable size.",
    "Upscaling takes a photo up to 1024 px on its long side. Shrink it and try again.",
    "Making a smaller copy to upscale…",
    "A smaller copy of this photo is still too large to send. Use a smaller photo.",
    "The photo's size couldn't be read.",
  ])
    assert.match(translateText(en, translate) || "", han, en);
});

test("the page's helpers: names, prices, shrink steps, sizes and tools", () => {
  assert.deepEqual(TOOLS, ["edit", "background", "upscale"]);
  for (const id of TOOLS) assert.ok(TOOL_INFO[id].label && TOOL_INFO[id].blurb && TOOL_INFO[id].action);
  assert.equal(toolFrom("upscale"), "upscale");
  assert.equal(toolFrom("extend"), "edit");
  assert.equal(toolFrom(null), "edit");
  // Never rounded below what is held.
  assert.equal(price(155.2), "155.2");
  assert.equal(price(2.1), "2.1");
  assert.equal(price(1234.5678), "1,234.5678");
  assert.equal(price("x"), "");
  assert.equal(resultName("holiday photo.JPG", "background", "image/png"), "holiday photo-cutout.png");
  assert.equal(resultName("a/b<c>.png", "edit", "image/webp"), "abc-edited.webp");
  assert.equal(resultName("", "upscale", "image/jpeg"), "photo-upscaled.jpg");
  assert.equal(resultName("x.png", "unknown", "image/gif"), "x-result.gif");
  // A photo under the limit isn't touched; a bigger one steps down until it fits.
  assert.deepEqual(shrinkScales(1000), [1]);
  const steps = shrinkScales(6 * 1024 * 1024);
  assert.equal(steps.length, 8);
  assert.ok(steps[0] < 1 && steps.every((v, i) => i === 0 || v < steps[i - 1]));
  assert.ok(steps[0] ** 2 * 6 * 1024 * 1024 < 1.5 * 1024 * 1024, "the first try should land under the limit");
  assert.equal(sizeNote({ width: 900, height: 600 }, { width: 3600, height: 2400 }), "900 × 600 → 3,600 × 2,400");
  assert.equal(sizeNote({ width: 900, height: 600 }, { width: 900, height: 600 }), "900 × 600");
  assert.equal(sizeNote(null, { width: 1, height: 1 }), "");
  // An off-the-record result becomes the next photo without a network request.
  const blob = dataUrlBlob(PHOTO);
  assert.equal(blob.type, "image/png");
  assert.equal(blob.size, RED.length);
  assert.throws(() => dataUrlBlob("https://example.com/a.png"), /couldn't be read/);
  assert.throws(() => dataUrlBlob("data:image/png;base64,@@"), /couldn't be read/);
});

test("the tool directory finds Photo tools by intent, in English and Chinese, without disturbing the others", () => {
  const entries = [
    ["home", "Home"], ["tools", "Task tools"], ["canvas", "Canvas"], ["audio", "Voice & audio"], ["library", "Your library"],
    ["notes", "Meeting notes"], ["photos", "Photo tools", "Edit a photo with words, remove its background or upscale it. See the price first."],
  ];
  const first = (q) => rankTools(entries, q)[0]?.[0];
  for (const q of ["edit a photo", "remove background", "remove the background from a picture", "upscale", "enlarge a picture", "retouch", "cut out", "Photo tools", "抠图", "修图", "去背景"])
    assert.equal(first(q), "photos", q);
  // Saved pictures are still the library's, and writing is still Canvas's.
  assert.equal(first("find saved pictures"), "library");
  assert.equal(first("write a first draft"), "canvas");
  assert.equal(first("meeting action items"), "notes");
  assert.deepEqual(rankTools(entries.filter(([id]) => id !== "photos"), "remove background").map(([id]) => id).includes("photos"), false);
});

test("Chinese: the update's copy, the page's strings and the messages it shows are in the dictionary", () => {
  const update = UPDATES.find((u) => u.id === "phototools");
  const han = /\p{Script=Han}/u;
  for (const en of [update.title, update.tagline, ...update.points]) assert.match(dict.strings[en] || "", han, en);
  const translate = compileDictionary(dict);
  for (const en of [
    "Edit with words", "Remove background", "Upscale", "Drop a photo here", "Choose a photo", "What should change?", "Keep the result",
    "Nowhere: off the record, download only", "Use as the photo", "Open in your library", "New photo",
    "Private mode isn't available for photos: no photo model offers zero data retention.",
    "The photo is larger than 1.5 MiB. Shrink it and try again.",
    "The provider returned a picture without a transparent background, so nothing was saved or charged.",
    PHOTO_CHANGED, EXTEND_UNAVAILABLE,
  ])
    assert.match(translateText(en, translate) || "", han, en);
  assert.match(translateText("Seedream V5 Lite (Edit) · up to 40.3 credits", translate), /40\.3/);
  assert.match(translateText("Seedream V5 Lite (Edit) · up to 40.3 credits", translate), han);
  assert.match(translateText("From 2.1 credits", translate), han);
  assert.match(translateText("Up to 2.1 credits", translate), han);
  assert.match(translateText("Test receipt · 2.1 credits charged", translate), han);
  assert.match(translateText("Shrunk in this browser from 4.2 MB to 1.4 MB to fit the 1.5 MB limit.", translate), han);
  assert.match(translateText("Veil would mask 2 details in these words, and a photo edit needs them as written. Remove them, or turn Veil off.", translate), han);
  assert.match(translateText('"IMG_0001.HEIC" is too large to open. Use a photo under 40 MiB.', translate), han);
});

test("nothing new is stored per account: no table, and every result already belongs to the library", () => {
  const server = readFileSync(new URL("../server/routes/photo-tools.js", import.meta.url), "utf8");
  assert.doesNotMatch(server, /CREATE TABLE|INSERT INTO|db\.exec/);
  // The one place it writes is the library's own saveMedia.
  assert.match(server, /saveMedia\(user, "image"/);
  // The results are saved with no recipe, so the library can't replay a photo.
  assert.doesNotMatch(server, /recipe:|mediaRecipe/);
  const core = readFileSync(new URL("../server/core.js", import.meta.url), "utf8");
  assert.doesNotMatch(core, /photo_tools|photo-tools/);
});
