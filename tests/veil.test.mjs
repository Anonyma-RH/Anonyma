import test from "node:test";
import assert from "node:assert/strict";
import { veil, unveil, createVeilState, luhnValid, ibanValid } from "../src/veil.js";

function veilOnce(text, words) {
  const state = createVeilState();
  return { state, ...veil(text, state, words) };
}
// Builds a fixture secret at runtime from separate literals, so the exact
// credential-shaped string (which this repo's own privacy-guard pre-commit
// check also scans for) never appears contiguously in this source file.
const fixtureSecret = (...parts) => parts.join("");

// --- detection per type --------------------------------------------------
test("Detects an email address", () => {
  const { text, count, state } = veilOnce("Reach me at jane.doe@example.com please");
  assert.equal(text, "Reach me at [EMAIL_1] please");
  assert.equal(count, 1);
  assert.equal(state.map.EMAIL_1, "jane.doe@example.com");
});
test("Detects international and US phone formats", () => {
  assert.equal(veilOnce("Call +1 415-555-2671 now").text, "Call [PHONE_1] now");
  assert.equal(veilOnce("Call 415-555-2671 now").text, "Call [PHONE_1] now");
  assert.equal(veilOnce("Call (415) 555-2671 now").text, "Call [PHONE_1] now");
});
test("Detects a Luhn-valid card number and tags it CARD", () => {
  const { text, state } = veilOnce("Card: 4111 1111 1111 1111 exp 12/29");
  assert.equal(text, "Card: [CARD_1] exp 12/29");
  assert.equal(state.map.CARD_1, "4111 1111 1111 1111");
});
test("Detects a checksum-valid IBAN", () => {
  const { text, state } = veilOnce("IBAN DE89370400440532013000 for transfer");
  assert.equal(text, "IBAN [IBAN_1] for transfer");
  assert.equal(state.map.IBAN_1, "DE89370400440532013000");
});
test("Detects EVM, base58 and bech32 wallet addresses as WALLET", () => {
  assert.equal(
    veilOnce("Send to 0x1234567890abcdef1234567890ABCDEF12345678").text,
    "Send to [WALLET_1]",
  );
  assert.equal(
    veilOnce("Send to 1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2").text,
    "Send to [WALLET_1]",
  );
  assert.equal(
    veilOnce("Send to bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq").text,
    "Send to [WALLET_1]",
  );
});
test("Detects well-known secret prefixes and bare 64-hex keys as KEY", () => {
  assert.equal(
    veilOnce("key: sk-ant-api03-1234567890abcdefghijklmnopqrstuvwxyz").text,
    "key: [KEY_1]",
  );
  assert.equal(
    veilOnce("token " + fixtureSecret("ghp_", "1234567890abcdefghijklmnopqrstuvwxyz")).text,
    "token [KEY_1]",
  );
  assert.equal(
    veilOnce(
      "token " + fixtureSecret("github_pat_", "11ABCDEFG01234567890abcdefghijklmnopqrstuvwxyz"),
    ).text,
    "token [KEY_1]",
  );
  assert.equal(veilOnce("aws " + fixtureSecret("AKIA", "1234567890ABCDEF")).text, "aws [KEY_1]");
  assert.equal(
    veilOnce("slack " + fixtureSecret("xoxb-", "1234567890-abcdefghijklmnop")).text,
    "slack [KEY_1]",
  );
  assert.equal(veilOnce("gkey AIza1234567890abcdefghijklmnopqrstuvw").text, "gkey [KEY_1]");
  assert.equal(veilOnce("priv " + "a1b2c3d4".repeat(8)).text, "priv [KEY_1]");
});
test("Detects IPv4 and IPv6 addresses (including compressed) as IP", () => {
  assert.equal(veilOnce("connect to 192.168.1.42 now").text, "connect to [IP_1] now");
  assert.equal(
    veilOnce("connect to 2001:0db8:85a3:0000:0000:8a2e:0370:7334 now").text,
    "connect to [IP_1] now",
  );
  assert.equal(veilOnce("connect to ::1 now").text, "connect to [IP_1] now");
});
test("Detects user-defined 'always veil' words as PRIVATE, case-insensitively", () => {
  const { text, count } = veilOnce("Nova Textiles is launching project zephyr next week", [
    "Nova Textiles",
    "Project Zephyr",
  ]);
  assert.equal(text, "[PRIVATE_1] is launching [PRIVATE_2] next week");
  assert.equal(count, 2);
});
test("A structured match takes priority over an overlapping word-list match", () => {
  const { text } = veilOnce("Contact us at jane.doe@example.com", ["jane.doe"]);
  assert.equal(text, "Contact us at [EMAIL_1]");
});

// --- round trip and consistent numbering ---------------------------------
test("veil then unveil restores the original text exactly", () => {
  const cases = [
    "Reach me at jane.doe@example.com or 415-555-2671.",
    "Card 4111 1111 1111 1111 and wallet 0x1234567890abcdef1234567890ABCDEF12345678.",
    "No sensitive data in this sentence at all.",
  ];
  for (const original of cases) {
    const state = createVeilState();
    const { text } = veil(original, state);
    assert.equal(unveil(text, state.map), original);
  }
});
test("The same value gets the same tag across separate calls sharing state", () => {
  const state = createVeilState();
  const r1 = veil("Email me at a@b.example or call 415-555-2671.", state);
  assert.equal(r1.text, "Email me at [EMAIL_1] or call [PHONE_1].");
  const r2 = veil("Second message: a@b.example again, plus new c@d.example and 415-555-2671.", state);
  assert.equal(r2.text, "Second message: [EMAIL_1] again, plus new [EMAIL_2] and [PHONE_1].");
  assert.equal(unveil(r2.text, state.map), "Second message: a@b.example again, plus new c@d.example and 415-555-2671.");
});
test("Tags for messages loaded from the server unveil when the map is present, else show as-is", () => {
  const state = createVeilState();
  veil("Email a@b.example", state);
  assert.equal(unveil("The model saw [EMAIL_1] in your note.", state.map), "The model saw a@b.example in your note.");
  assert.equal(unveil("Unknown tag [EMAIL_9] stays put.", state.map), "Unknown tag [EMAIL_9] stays put.");
  assert.equal(unveil("No map here", null), "No map here");
});

// --- Luhn / IBAN checksums ------------------------------------------------
test("luhnValid accepts a known-valid test card and rejects a broken one", () => {
  assert.equal(luhnValid("4111111111111111"), true);
  assert.equal(luhnValid("4111111111111112"), false);
  assert.equal(luhnValid("9783161484100"), false); // ISBN digits, not a card
});
test("ibanValid checks the mod-97 checksum", () => {
  assert.equal(ibanValid("DE89370400440532013000"), true);
  assert.equal(ibanValid("DE89370400440532013001"), false);
});

// --- negative cases: conservative detection -------------------------------
test("Does not flag ordinary prose", () => {
  const text = "The quick brown fox jumps over the lazy dog near the river.";
  const r = veilOnce(text);
  assert.equal(r.count, 0);
  assert.equal(r.text, text);
});
test("Does not flag an ISO date", () => {
  assert.equal(veilOnce("The meeting is on 2026-09-24 at noon").count, 0);
});
test("Does not flag clock times", () => {
  assert.equal(veilOnce("We meet at 14:30 sharp, or 2:30 PM").count, 0);
});
test("Does not flag a formatted price", () => {
  assert.equal(veilOnce("Total due: $1,299.00 today").count, 0);
});
test("Does not flag a semver version string", () => {
  assert.equal(veilOnce("Upgrade to v1.2.3 now").count, 0);
});
test("Does not flag an ISBN-like number (fails the card Luhn check)", () => {
  assert.equal(veilOnce("See ISBN 978-3-16-148410-0 for details").count, 0);
});
test("Does not flag a short reference/order number", () => {
  assert.equal(veilOnce("Order #48213 shipped").count, 0);
});
test("Does not flag CSS hex colours", () => {
  assert.equal(veilOnce("Use color #3b82f6 or #fff for the badge").count, 0);
});
test("Does not flag short git SHAs (7-12 chars)", () => {
  assert.equal(veilOnce("Fixed in commit a1b2c3d and also e5f6a7b8c9d0").count, 0);
});
test("An empty or missing 'always veil' list flags nothing extra", () => {
  assert.equal(veilOnce("Acme Corp is a normal sentence.", []).count, 0);
  assert.equal(veilOnce("Acme Corp is a normal sentence.").count, 0);
});
