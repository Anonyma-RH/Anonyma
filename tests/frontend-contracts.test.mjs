import test from "node:test";
import assert from "node:assert/strict";
// Frontend contract helpers; the chat stream reader itself is covered by stream.test.mjs.
import { estimateCredits, savings, ApiError } from "../src/lib.js";
test("Credit conversion preserves display units", () => {
  assert.equal(estimateCredits(1), 1000);
  assert.equal(estimateCredits(5.25), 5250);
});
test("Calculator keeps negative differences honest", () => {
  assert.equal(savings(60, 15).annual, 540);
  assert.equal(savings(10, 30).monthly, -20);
  assert.equal(savings(0, 10).percent, 0);
});
test("API errors retain status and code for recovery UI", () => {
  const e = new ApiError("Insufficient balance", 402, "insufficient_credits");
  assert.equal(e.status, 402);
  assert.equal(e.code, "insufficient_credits");
});
import {
  normalizeModel,
  sortModels,
  messageFromServer,
  toRequestMessage,
  videoPresets,
} from "../src/lib.js";
// Shapes below are copied from the backend's local test mode responses.
test("Catalog models gain provider and description from owned_by/architecture", () => {
  const m = normalizeModel({
    id: "gpt-6-astra-pro",
    name: "GPT-6 Astra Pro",
    type: "chat",
    owned_by: "OpenAI",
    architecture: { modality: "text+image+file->text" },
  });
  assert.equal(m.provider, "OpenAI");
  assert.equal(m.description, "text+image+file → text");
  assert.equal(normalizeModel({ id: "google/x", type: "image" }).provider, "google");
});
test("Callable and popular models sort first", () => {
  const order = sortModels([
    { name: "B", callable: false },
    { name: "C", callable: true },
    { name: "A", callable: true, popular: true },
  ]).map((m) => m.name);
  assert.deepEqual(order, ["A", "C", "B"]);
});
test("Saved assistant objects and image parts become displayable messages", () => {
  const a = messageFromServer({
    role: "assistant",
    content: { text: "Hi", reasoning: "r", images: [{ type: "image_url", image_url: { url: "/api/media/x" } }] },
  });
  assert.equal(a.content, "Hi");
  assert.equal(a.reasoning, "r");
  assert.deepEqual(a.images, ["/api/media/x"]);
  const u = messageFromServer({
    role: "user",
    content: [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
  });
  assert.equal(u.content, "Look");
  assert.deepEqual(u.images, ["data:image/png;base64,AA=="]);
});
test("Reference images are sent as image_url parts; plain text stays a string", () => {
  assert.deepEqual(toRequestMessage({ role: "user", content: "Hi" }), { role: "user", content: "Hi" });
  assert.deepEqual(
    toRequestMessage({ role: "user", content: "Look", images: ["data:image/png;base64,AA=="] }).content,
    [{ type: "text", text: "Look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
  );
  assert.equal(toRequestMessage({ role: "assistant", content: "x", images: ["u"] }).content, "x");
});
test("Video presets follow published prices only", () => {
  const presets = videoPresets({
    pricing: {
      variants: [
        {
          quality: "standard",
          options: [
            { size: "16:9_5", price: 2.3 },
            { size: "16:9_5_no_audio", price: 1.15 },
            { size: "default", price: 3.68 },
            { size: "9:16_8", price: 0 },
          ],
        },
      ],
    },
  });
  assert.deepEqual(presets, [
    { quality: "standard", ratio: "16:9", duration: "5", price: 2.3 },
    { quality: "standard", ratio: "", duration: "", price: 3.68 },
  ]);
  assert.deepEqual(videoPresets({ pricing: { base_price: 1 } }), [
    { quality: "", ratio: "", duration: "", price: 1 },
  ]);
});
