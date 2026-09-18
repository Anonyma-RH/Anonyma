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
  const model = { id: "private/example", status: "live", type: "chat" };
  assert.equal(callable(model, cfg), false);
  assert.equal(callable({ ...model, id: "openai/example" }, cfg), true);
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
  assert.equal(result.verified, false);
  assert.ok(!JSON.stringify(result).includes("private-fixture"));
});
