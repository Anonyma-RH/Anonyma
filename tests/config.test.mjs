import test from "node:test";
import assert from "node:assert/strict";
import { config, parseTrustProxy } from "../server/core.js";
test("configuration rejects invalid financial settings and ambiguous public origins", () => {
  for (const markup of [-1, NaN, Infinity])
    assert.throws(() => config({ markup }), /Markup/);
  for (const origin of [
    "javascript:alert(1)",
    Object.assign(new URL("https://example.com"), {
      username: "user",
      password: "password",
    }).href,
    "https://example.com/path",
  ])
    assert.throws(() => config({ origin }), /origin/);
  assert.equal(
    config({ origin: "https://example.com/" }).origin,
    "https://example.com",
  );
  assert.throws(() => config({ chain: NaN }), /chain/);
});
test("proxy trust defaults to loopback and refuses broad client trust", () => {
  assert.equal(config().trustProxy, "loopback");
  assert.equal(parseTrustProxy("false"), false);
  assert.equal(parseTrustProxy(""), false);
  assert.equal(parseTrustProxy("10.0.0.0/8"), "10.0.0.0/8");
  assert.throws(() => parseTrustProxy("2"), /not hops/);
  assert.throws(() => parseTrustProxy("true"), /forge/);
});
