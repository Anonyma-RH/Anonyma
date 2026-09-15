import test from "node:test";
import assert from "node:assert/strict";
import { config } from "../server/core.js";
test("configuration rejects invalid financial settings and ambiguous public origins", () => {
  for (const markup of [-1, NaN, Infinity])
    assert.throws(() => config({ markup }), /Markup/);
  for (const origin of [
    "javascript:alert(1)",
    Object.assign(new URL("https://example.com"), { username: "user", password: "password" }).href,
    "https://example.com/path",
  ])
    assert.throws(() => config({ origin }), /origin/);
  assert.equal(
    config({ origin: "https://example.com/" }).origin,
    "https://example.com",
  );
  assert.throws(() => config({ chain: NaN }), /chain/);
});
