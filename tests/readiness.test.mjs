import test from "node:test";
import assert from "node:assert/strict";
import {
  database,
  config,
  addCredit,
  uid,
  discount,
  callable,
} from "../server/core.js";
import {
  configurationStatus,
  assertNoTestCredits,
} from "../server/readiness.js";
test("encrypted private models are not routed through ordinary chat", () => {
  const cfg = { gatewayKey: "fixture" };
  const model = {
    id: "private/example",
    status: "live",
    type: "chat",
    pricing: { input_per_1M_tokens: 1, output_per_1M_tokens: 2 },
  };
  assert.equal(callable(model, cfg), false);
  assert.equal(callable({ ...model, id: "openai/example" }, cfg), true);
  assert.equal(
    callable({ ...model, id: "openai/example", pricing: {} }, cfg),
    false,
  );
});
test("token markup discount follows supply share immediately and stays bounded", () => {
  assert.equal(discount(1000000), 0.025);
  assert.equal(discount(5000000), 0.125);
  assert.equal(discount(15000000), 0.375);
  assert.equal(discount(40000000), 1);
  assert.equal(discount(50000000), 1);
  assert.equal(discount(-1), 0);
  assert.equal(discount("invalid"), 0);
});
test("live mode refuses to spend fixture credit balances and preserves the ledger", () => {
  const db = database(":memory:");
  try {
    const user = uid();
    db.prepare("INSERT INTO users(id,created) VALUES(?,?)").run(
      user,
      Date.now(),
    );
    addCredit(db, user, 100000, uid(), "test_credit", "Local fixture");
    assert.doesNotThrow(() => assertNoTestCredits(db, { testMode: true }));
    assert.throws(
      () => assertNoTestCredits(db, { testMode: false }),
      /test credits/,
    );
    assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger").get().n, 1);
  } finally {
    db.close();
  }
});
test("readiness reports missing configuration without exposing secrets or claiming verified services", () => {
  const c = config({
    testMode: false,
    gatewayKey: "private-fixture",
    paymentKey: "secret",
    paymentSecret: "ipn",
    publicUrl: "http://localhost",
    smtp: "",
    smtpFrom: "",
    walletProject: "",
    rpc: "",
    token: "",
  });
  const result = configurationStatus(c);
  assert.equal(result.configured.generation, true);
  assert.equal(result.configured.payments, false);
  assert.deepEqual(result.missing.payments, ["PUBLIC_BASE_URL"]);
  assert.equal(result.requiredConfigured, false);
  assert.equal(result.verified, false);
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
});
test("optional wallet and token settings do not block required configuration readiness", () => {
  const result = configurationStatus(
    config({
      testMode: false,
      gatewayKey: "fixture",
      paymentKey: "fixture",
      paymentSecret: "fixture",
      publicUrl: "https://anonyma.example.invalid",
      smtp: "smtp://localhost",
      smtpFrom: "noreply@example.invalid",
      walletProject: "",
      rpc: "",
      token: "",
    }),
  );
  assert.equal(result.requiredConfigured, true);
  assert.equal(result.configured.walletConnect, false);
  assert.equal(result.configured.token, false);
  assert.equal(result.verified, false);
});
test("production refuses a payment callback origin that differs from the browser origin", () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try {
    assert.throws(
      () =>
        config({
          origin: "http://127.0.0.1:3001",
          publicUrl: "https://anonyma.example.com",
          testMode: false,
        }),
      /APP_ORIGIN and PUBLIC_BASE_URL must match/,
    );
    assert.equal(
      config({
        origin: "https://anonyma.example.com",
        publicUrl: "https://anonyma.example.com",
        testMode: false,
      }).origin,
      "https://anonyma.example.com",
    );
  } finally {
    if (previous == null) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});
