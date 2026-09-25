import test from "node:test";
import assert from "node:assert/strict";
import { UPDATES, isReleased, parseReleased, releaseInfo } from "../server/releases.js";

// A committed `released: true` turns an update on even when the hosting
// setting leaves it off; RELEASED_FEATURES keeps working as before.
test("an update marked released in code is live under RELEASED_FEATURES=mvp", (t) => {
  const entry = { id: "committed-switch-test", title: "Test", tagline: "", points: [], released: true };
  UPDATES.push(entry);
  t.after(() => UPDATES.splice(UPDATES.indexOf(entry), 1));
  const cfg = { released: parseReleased("mvp") };
  assert.equal(isReleased(cfg, "committed-switch-test"), true);
  assert.equal(isReleased(cfg, "code"), false);
  const info = releaseInfo(cfg);
  assert.equal(info.updates.find((u) => u.id === "committed-switch-test").released, true);
  entry.released = false;
  assert.equal(isReleased(cfg, "committed-switch-test"), false);
});

test("RELEASED_FEATURES still releases updates without a commit", () => {
  assert.equal(isReleased({ released: parseReleased("mvp,code") }, "code"), true);
  assert.equal(isReleased({ released: parseReleased("all") }, "code"), true);
  assert.equal(isReleased({ released: parseReleased("mvp") }, "search"), false);
});
