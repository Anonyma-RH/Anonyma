import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildChatRequest } from "../src/estimate.js";
import { createApp } from "../server/app.js";
import { UPDATES, parseReleased, releaseInfo } from "../server/releases.js";
import {
  DEFAULT_CHOICE,
  PRESETS,
  STORAGE_KEY,
  TYPICAL,
  creditPrice,
  loadChoices,
  moveActive,
  pickPreset,
  presetPool,
  resolveChoice,
  requestNeedsVision,
  QUALITY_GUIDANCE,
  pickQuality,
  searchModels,
  toCredits,
  usdPrice,
  whyUnavailable,
  withChoice,
} from "../src/model-finder.js";

// Model Finder & Presets: prices come from the catalog's published rates,
// presets follow price tiers (quality is never invented), and choices respect
// task capability, Private mode and what's released.
const rate = (input, output) => ({ input_per_1M_tokens: input, output_per_1M_tokens: output });
const chat = (id, input, output, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  type: "chat",
  provider: extra.provider || "Lab",
  callable: true,
  popular: true,
  pricing: rate(input, output),
  ...extra,
});
const MODELS = [
  chat("tiny", 0.1, 0.4),
  chat("mid", 1, 4, { vision: true }),
  chat("upper", 3, 15, { private: true }),
  chat("top", 15, 75, { vision: true, private: true }),
  chat("obscure-cheap", 0.01, 0.02, { popular: false }),
  chat("unpriced", undefined, undefined),
  chat("offline", 0.05, 0.1, { callable: false }),
];

test("prices come only from published rates, per typical request, at the standard rate", () => {
  assert.equal(usdPrice(MODELS[1], "chat"), (1 * TYPICAL.input + 4 * TYPICAL.output) / 1e6);
  assert.equal(usdPrice(MODELS[5], "chat"), null);
  assert.equal(usdPrice({ imagePrice: 0.04 }, "image"), 0.04);
  assert.equal(usdPrice({ imagePrice: undefined }, "image"), null);
  const video = { pricing: { variants: [{ quality: "hd", options: [{ size: "5", price: 0.5 }, { size: "10", price: 0.9 }] }] } };
  assert.equal(usdPrice(video, "video"), 0.5);
  assert.ok(Math.abs(toCredits(0.006, 5) - 6.3) < 1e-9);
  assert.equal(toCredits(null, 5), null);
  assert.ok(Math.abs(creditPrice(MODELS[0], "code", 0) - 0.6) < 1e-9);
});

test("Cheap considers every eligible price; Balanced prefers popular models; quality needs evidence", () => {
  const opts = { mode: "chat" };
  assert.deepEqual(presetPool(MODELS, opts).map((m) => m.id), ["obscure-cheap", "tiny", "mid", "upper", "top"]);
  assert.equal(pickPreset(MODELS, "cheap", opts).id, "obscure-cheap");
  assert.equal(pickPreset(MODELS, "balanced", opts).id, "mid");
  assert.equal(pickPreset(MODELS, "best", opts), null);
  // Fewer than three popular models: every priced, callable model counts.
  const few = MODELS.map((m) => (["tiny", "mid"].includes(m.id) ? m : { ...m, popular: false }));
  assert.equal(pickPreset(few, "cheap", opts).id, "obscure-cheap");
  assert.ok(!presetPool(few, opts).some((m) => ["unpriced", "offline"].includes(m.id)));
  // The demo's sample catalog isn't callable but still shows presets, from
  // every priced sample model.
  assert.equal(pickPreset(MODELS.map((m) => ({ ...m, callable: false })), "cheap", { ...opts, demo: true }).id, "obscure-cheap");
  // Nothing to choose from.
  assert.equal(pickPreset([], "best", opts), null);
  // Highest price is not evidence of capability. The preset stays unavailable.
  assert.match(PRESETS.find((p) => p.id === "best").note, /task recommendation/);
});

test("presets skip models whose provider trains on prompts when there's another choice", () => {
  const trains = MODELS.map((m) => (m.id === "top" ? { ...m, trainsOnPrompts: true } : m));
  assert.ok(!presetPool(trains, { mode: "chat", avoidTraining: true }).some(m => m.id === "top"));
  assert.ok(presetPool(trains, { mode: "chat" }).some(m => m.id === "top"));
  const all = MODELS.map((m) => ({ ...m, trainsOnPrompts: true }));
  assert.equal(pickPreset(all, "cheap", { mode: "chat", avoidTraining: true }).id, "obscure-cheap");
});

test("a saved choice resolves within what's allowed, with a clear fallback", () => {
  const privateOnly = MODELS.filter((m) => m.private);
  // Private mode: a remembered non-private model never slips through.
  const r = resolveChoice({ model: "mid" }, privateOnly, MODELS, { mode: "chat", privateMode: true });
  assert.ok(r.model.private);
  assert.equal(r.fallback.wanted, "MID");
  assert.match(r.fallback.reason, /zero-data-retention/);
  // Presets are picked inside the private list too.
  assert.equal(resolveChoice({ preset: "cheap" }, privateOnly, MODELS, { mode: "chat" }).model.id, "upper");
  // Images attached: only models that read images.
  const vision = MODELS.filter((m) => m.vision);
  const v = resolveChoice({ model: "tiny" }, vision, MODELS, { mode: "chat", needsVision: true });
  assert.equal(v.model.vision, true);
  assert.equal(v.fallback.reason, "can't read the images you attached");
  // Not released here, gone from the catalog, or offline.
  assert.equal(resolveChoice({ model: "tiny" }, MODELS.slice(1), MODELS, { mode: "chat" }).fallback.reason, "isn't available here");
  assert.equal(resolveChoice({ model: "gone" }, MODELS, MODELS, { mode: "chat" }).fallback.reason, "isn't in the catalog any more");
  assert.equal(whyUnavailable(MODELS[6]), "isn't available right now");
  // An available model is used as chosen; no choice means Balanced.
  assert.deepEqual(resolveChoice({ model: "upper" }, MODELS, MODELS, { mode: "chat" }), { model: MODELS[2], via: "model" });
  const d = resolveChoice(undefined, MODELS, MODELS, { mode: "chat" });
  assert.deepEqual([d.model.id, d.preset, d.fallback], ["mid", DEFAULT_CHOICE.preset, undefined]);
  // Nothing usable at all.
  assert.equal(resolveChoice({ preset: "best" }, [], MODELS, { mode: "chat" }).model, null);
});

test("search matches every word across name, id, provider and features", () => {
  const list = [
    chat("claude-sonnet-5", 2, 10, { name: "Claude Sonnet 5", provider: "Anthropic", vision: true }),
    chat("glm-5.3", 0.5, 2, { name: "GLM 5.3", provider: "Zhipu", private: true }),
    chat("cafe-model", 0, 0, { name: "Café Model", provider: "Crème Labs" }),
  ];
  const ids = (q) => searchModels(list, q, { mode: "chat" }).map((m) => m.id);
  assert.deepEqual(ids(""), ["claude-sonnet-5", "glm-5.3", "cafe-model"]);
  assert.deepEqual(ids("ANTHROPIC sonnet"), ["claude-sonnet-5"]);
  assert.deepEqual(ids("private"), ["glm-5.3"]);
  assert.deepEqual(ids("zdr"), ["glm-5.3"]);
  assert.deepEqual(ids("images"), ["claude-sonnet-5"]);
  assert.deepEqual(ids("cafe creme"), ["cafe-model"]);
  assert.deepEqual(ids("free"), ["cafe-model"]);
  assert.deepEqual(ids("glm-5"), ["glm-5.3"]);
  assert.deepEqual(ids("nothing like this"), []);
});

test("keyboard movement wraps and pages through the list", () => {
  assert.equal(moveActive(-1, "ArrowDown", 4), 0);
  assert.equal(moveActive(3, "ArrowDown", 4), 0);
  assert.equal(moveActive(0, "ArrowUp", 4), 3);
  assert.equal(moveActive(-1, "ArrowUp", 4), 3);
  assert.equal(moveActive(1, "End", 4), 3);
  assert.equal(moveActive(3, "Home", 4), 0);
  assert.equal(moveActive(1, "PageDown", 20), 6);
  assert.equal(moveActive(2, "PageUp", 20), 0);
  assert.equal(moveActive(9, "ArrowDown", 4), 0);
  assert.equal(moveActive(2, "Tab", 4), 2);
  assert.equal(moveActive(0, "ArrowDown", 0), -1);
});

test("choices are remembered per mode and junk in storage is ignored", () => {
  const store = {};
  const read = (k, fallback) => (k in store ? store[k] : fallback);
  assert.deepEqual(loadChoices(read), {});
  store[STORAGE_KEY] = {
    chat: { preset: "cheap" },
    code: { model: "glm-5.3" },
    image: { preset: "fastest" },
    video: { model: "x".repeat(201) },
    audio: { preset: "best" },
    uncensored: "best",
  };
  assert.deepEqual(loadChoices(read), { chat: { preset: "cheap" }, code: { model: "glm-5.3" } });
  store[STORAGE_KEY] = "garbage";
  assert.deepEqual(loadChoices(read), {});
  const next = withChoice({ chat: { preset: "cheap" } }, "code", { model: "mid", extra: 1 });
  assert.deepEqual(next, { chat: { preset: "cheap" }, code: { model: "mid" } });
  assert.equal(withChoice(next, "symposium", { preset: "best" }), next);
  assert.equal(withChoice(next, "chat", { preset: "nope" }), next);
});

test("presets on the bundled catalog are real price tiers of live models", () => {
  const snapshot = JSON.parse(readFileSync(new URL("../data/models.snapshot.json", import.meta.url), "utf8"));
  const live = snapshot.data
    .filter((m) => m.type === "chat" && m.status === "live")
    .map((m) => ({ ...m, callable: true }));
  const pick = (p) => pickPreset(live, p, { mode: "chat" });
  const [cheap, balanced] = ["cheap", "balanced"].map(pick);
  assert.ok(cheap && balanced);
  assert.ok(pick("best"));
  assert.ok(usdPrice(cheap, "chat") <= usdPrice(balanced, "chat"));
  for (const m of [cheap, balanced]) {
    const rates = snapshot.data.find((x) => x.id === m.id).pricing;
    assert.equal(usdPrice(m, "chat"), (rates.input_per_1M_tokens * 2000 + rates.output_per_1M_tokens * 1000) / 1e6);
  }
});

test("the workspace model list carries finder metadata and explicit release gates apply", async (t) => {
  const entry = UPDATES.find((u) => u.id === "finder");
  assert.equal(typeof entry.released, "boolean");
  assert.equal(entry.points.length, 3);
  const committedRelease = entry.released;
  try {
    entry.released = false;
    assert.equal(releaseInfo({ released: parseReleased("mvp") }).features.finder, false);
    assert.equal(releaseInfo({ released: parseReleased("mvp,finder") }).features.finder, true);
  } finally { entry.released = committedRelease; }

  const dir = mkdtempSync(join(tmpdir(), "anonyma-finder-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released: "all",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const models = (await request(svc.app).get("/api/models").expect(200)).body.data;
  const chats = models.filter((m) => m.type === "chat" && m.callable);
  assert.ok(chats.length > 3);
  assert.ok(chats.every((m) => "pricing" in m && "vision" in m));
  const opts = { mode: "chat" };
  const [cheap, balanced] = [pickPreset(chats, "cheap", opts), pickPreset(chats, "balanced", opts)];
  assert.ok(usdPrice(cheap, "chat") <= usdPrice(balanced, "chat"));
  assert.ok(pickPreset(chats, "best", opts));
  // Private mode's list is only zero-data-retention models, and so are its presets.
  const privateOnly = chats.filter((m) => m.private);
  if (privateOnly.length)
    for (const p of ["cheap", "balanced"]) assert.ok(pickPreset(privateOnly, p, opts).private);
});

test("the workspace shows the finder only when it's released and keeps the select otherwise", () => {
  const src = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(src, /const finderLive = isReleased\(config, "finder"\);/);
  assert.match(src, /\{finderLive \? \(\s*<ModelFinder/);
  assert.match(src, /<select\s+aria-label="Select model"/);
  // Only an explicit choice is saved, never a fallback.
  assert.match(src, /saveStore\(MODEL_CHOICES, withChoice\(loadChoices\(readStore\), mode, choice\)\)/);
});


test("image follow-ups retain vision until the image leaves the exact sent context", () => {
  const saved = { model: "tiny" };
  const first = buildChatRequest({ text: "Describe", attachments: [{ url: "data:image/png;base64,AA==" }] });
  assert.equal(requestNeedsVision(first.request), true);
  // Composer attachments have been cleared, but the next send retains images.
  const followup = buildChatRequest({ messages: first.next, text: "Explain more" });
  assert.equal(requestNeedsVision(followup.request), true);
  const allowed = MODELS.filter(m => m.callable && (!requestNeedsVision(followup.request) || m.vision));
  assert.equal(resolveChoice(saved, allowed, MODELS, { mode: "chat" }).model.vision, true);
  // Edit/regenerate uses its cut context, not whatever remains in the composer.
  const cut = buildChatRequest({ messages: [], text: "New branch" });
  assert.equal(requestNeedsVision(cut.request), false);
  const later = [...first.next, ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "Later" }))];
  assert.equal(requestNeedsVision(buildChatRequest({ messages: later, text: "Now" }).request), false);
});

test("no eligible model resolves to no send target; unavailable quality choices disclose fallback", () => {
  const empty = resolveChoice({ model: "tiny" }, [], MODELS, { mode: "chat", needsVision: true });
  assert.equal(empty.model, null);
  const quality = resolveChoice({ preset: "best" }, MODELS.filter(m => m.callable), MODELS, { mode: "chat" });
  assert.equal(quality.preset, "balanced");
  assert.match(quality.fallback.reason, /no reviewed recommendation/);
  assert.equal(quality.model.id, "mid");
  assert.equal(pickPreset([{ ...MODELS[3], pricing: rate(1000, 1000) }], "best", { mode: "chat" }), null);
});


test("Best quality uses reviewed task capabilities, independent of price and input order", () => {
  const opus = chat("anthropic/claude-opus-5", 1, 1, { vision: true });
  const codex = chat("gpt-5.3-codex", 0.1, 0.1, { vision: true });
  const qwen = chat("qwen/qwen3.5-397b-a17b", 100, 100, { vision: true, private: true });
  const unknown = chat("unreviewed-expensive-model", 1000, 1000);
  const models = [unknown, qwen, codex, opus];
  assert.equal(pickQuality(models, { mode: "chat" }).id, opus.id);
  assert.equal(pickQuality(models.toReversed(), { mode: "code" }).id, codex.id);
  assert.equal(pickQuality(models, { mode: "chat", privateMode: true, needsVision: true }).id, qwen.id);
  assert.equal(pickQuality([{ ...opus, callable: false }, unknown], { mode: "chat" }), null);
  assert.equal(pickQuality([{ ...opus, vision: false }], { mode: "chat", needsVision: true }), null);
  assert.equal(pickQuality([unknown], { mode: "chat" }), null);
  assert.equal(pickQuality([opus], { mode: "uncensored" }), null);
  assert.equal(pickPreset(models, "best", { mode: "code" }).id, codex.id);
  assert.equal(resolveChoice({ preset: "best" }, models, models, { mode: "chat" }).model.id, opus.id);
  const images = [{ id: "gpt-image-2.5-sunburst", callable: true, imagePrice: .02 }, { id: "gpt-image-2", callable: true, imagePrice: 1 }];
  assert.equal(pickQuality(images, { mode: "image" }).id, "gpt-image-2.5-sunburst");
  const video = { id: "veo3", callable: true, pricing: { variants: [{ options: [{ size: "8", price: 1 }] }] } };
  assert.equal(pickQuality([video], { mode: "video" }).id, "veo3");
  assert.ok(QUALITY_GUIDANCE.every(g => g.reason && g.source.startsWith("https://")));
});
