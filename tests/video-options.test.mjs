import test from "node:test";
import assert from "node:assert/strict";
import { videoOptions } from "../server/video-options.js";
import { videoPresets } from "../data/video-presets.js";
const model = {
  pricing: {
    variants: [
      { quality: "standard", options: [{ size: "16:9_5", price: 0.4 }] },
    ],
  },
};
test("video quotes and submissions require exact priced variants", () => {
  assert.equal(videoOptions(model, {}).price, 0.4);
  for (const body of [
    { quality: "not-real" },
    { ratio: "1:1" },
    { duration: "20" },
    { duration: "5_no_audio" },
  ])
    assert.throws(() => videoOptions(model, body));
  assert.throws(
    () =>
      videoOptions(
        {
          pricing: {
            variants: [
              { quality: "standard", options: [{ size: "16:9_5", price: -1 }] },
            ],
          },
        },
        {},
      ),
    /published price/,
  );
});
test("image-to-video requirements are checked before paid submission", () => {
  assert.throws(
    () => videoOptions({ ...model, category: "image-to-video" }, {}),
    /requires/,
  );
  assert.throws(
    () =>
      videoOptions(
        { ...model, capabilities: { accepts_image_url: false } },
        { image_url: "https://example.com/a.png" },
      ),
    /does not accept/,
  );
  assert.throws(
    () =>
      videoOptions(model, { image_url: Object.assign(new URL("https://example.com/a.png"), { username: "user", password: "pass" }).href }),
    /without credentials/,
  );
  assert.equal(
    videoOptions(
      { ...model, category: "image-to-video" },
      { image_url: "https://example.com/a.png" },
    ).price,
    0.4,
  );
});
test("duration-only and default-price videos omit unsupported provider fields", () => {
  const durationOnly = {
    pricing: {
      variants: [
        {
          quality: "standard",
          options: [
            { size: "5", price: 0.43 },
            { size: "10", price: 0.86 },
          ],
        },
      ],
    },
  };
  assert.deepEqual(videoOptions(durationOnly, { duration: "10" }), {
    ratio: undefined,
    duration: "10",
    quality: "standard",
    price: 0.86,
  });
  assert.throws(() => videoOptions(durationOnly, { ratio: "16:9" }));
  const flat = { pricing: { base_price: 0.53 } };
  assert.deepEqual(videoOptions(flat, {}), {
    ratio: undefined,
    duration: undefined,
    quality: undefined,
    price: 0.53,
  });
  assert.throws(() => videoOptions(flat, { duration: 10 }));
  assert.deepEqual(videoPresets({ pricing: { base_price: -2 } }), []);
  assert.deepEqual(
    videoPresets({
      pricing: {
        variants: [
          {
            quality: "standard",
            options: [{ size: "16:9_5_no_audio", price: 0.2 }],
          },
        ],
      },
    }),
    [],
  );
});
