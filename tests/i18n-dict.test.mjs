import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The English → Simplified Chinese dictionary behind the language switch,
// built by scripts/i18n-extract.mjs.
const dict = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
const han = /\p{Script=Han}/u;
const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort();

// Identifiers, paths, URLs, CSS and code, as opposed to words on a page.
function looksLikeCode(key) {
  const words = (key.replace(/\{\d+\}/g, "").match(/[A-Za-z]{2,}/g) || []).length;
  return (
    /^(https?:|mailto:|www\.)|:\/\//.test(key) ||
    /^[/.#?][\w./#?=&%-]*$/.test(key) ||
    /^[a-z0-9]+([_\-./:@][a-z0-9]+)+$/.test(key) ||
    /^[a-z]+[A-Z]\w*$/.test(key) ||
    /^[A-Z0-9]+(_[A-Z0-9]+)+$/.test(key) ||
    /^[a-z-]+:\s*[^;]+;$/.test(key) ||
    (words < 8 && /=>|[{}]|<\/?[a-z][^>]*>|\bfunction\s*\(|\d+px\b/.test(key.replace(/\{\d+\}/g, "")))
  );
}

test("the dictionary is valid JSON with strings and patterns", () => {
  assert.equal(typeof dict.strings, "object");
  assert.ok(!Array.isArray(dict.strings));
  assert.ok(Array.isArray(dict.patterns));
  assert.ok(Object.keys(dict.strings).length > 1000, "the extraction should not come back nearly empty");
  assert.ok(dict.patterns.length > 50);
  for (const p of dict.patterns) {
    assert.deepEqual(Object.keys(p).sort(), ["en", "zh"]);
    assert.equal(typeof p.en, "string");
    assert.equal(typeof p.zh, "string");
  }
});

test("every value contains Chinese characters", () => {
  for (const [en, zh] of Object.entries(dict.strings)) {
    assert.equal(typeof zh, "string", en);
    assert.match(zh, han, `strings[${JSON.stringify(en)}]`);
  }
  for (const p of dict.patterns) assert.match(p.zh, han, `pattern ${JSON.stringify(p.en)}`);
});

test("keys are visible English text, whitespace-normalised, never code or URLs", () => {
  const keys = [...Object.keys(dict.strings), ...dict.patterns.map((p) => p.en)];
  for (const key of keys) {
    assert.ok(key.trim(), "empty key");
    assert.equal(key, key.replace(/\s+/g, " ").trim(), `unnormalised key ${JSON.stringify(key)}`);
    assert.match(key.replace(/\{\d+\}/g, ""), /[A-Za-z]{2}/, `no words in ${JSON.stringify(key)}`);
    assert.doesNotMatch(key, han, `Chinese in key ${JSON.stringify(key)}`);
    assert.ok(!looksLikeCode(key), `code-like key ${JSON.stringify(key)}`);
  }
  assert.equal(new Set(dict.patterns.map((p) => p.en)).size, dict.patterns.length, "duplicate pattern");
});

test("every pattern has placeholders, and the same ones in English and Chinese", () => {
  for (const { en, zh } of dict.patterns) {
    const e = placeholders(en);
    assert.ok(e.length > 0, `pattern without a placeholder: ${JSON.stringify(en)}`);
    assert.deepEqual(e, [...new Set(e)], `repeated placeholder in ${JSON.stringify(en)}`);
    assert.deepEqual(e, e.map((_, i) => `{${i}}`).sort(), `placeholders not numbered from {0} in ${JSON.stringify(en)}`);
    assert.deepEqual(placeholders(zh), e, `placeholders differ: ${JSON.stringify(en)} → ${JSON.stringify(zh)}`);
    assert.ok(!(en in dict.strings), `pattern also listed as a string: ${JSON.stringify(en)}`);
  }
});

test("the dictionary covers the page title, the release list and server messages the UI shows", () => {
  assert.match(dict.strings["ANONYMA — One account. Many AI models."], han);
  assert.equal(dict.strings["Coming soon"], "即将推出");
  assert.match(dict.strings["Private Mode"], han);
  assert.match(dict.strings["Reference catalog snapshot · 19 Sep 2026"], han);
  const soon = dict.patterns.find((p) => p.en === "{0} is coming soon.");
  assert.ok(soon && soon.zh.includes("{0}"), "the feature_unreleased message");
  for (const en of ["{0} day", "{0} days", "{0} member", "{0} members", "{0} hours ago"])
    assert.ok(dict.patterns.some((p) => p.en === en), `plural pattern ${en}`);
});
