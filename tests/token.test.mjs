import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { database, now } from "../server/core.js";
import { refreshTokenHoldings } from "../server/auth.js";

async function fixture(t, changeWallet = false) {
  const db = database(":memory:");
  const wallet = "0x0000000000000000000000000000000000000001";
  db.prepare("INSERT INTO users(id,wallet,created) VALUES(?,?,?)").run(
    "u",
    wallet,
    now(),
  );
  const user = db.prepare("SELECT * FROM users").get();
  const server = createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const respond = (call) => {
      if (call.method === "eth_chainId")
        return { jsonrpc: "2.0", id: call.id, result: "0x1" };
      if (changeWallet)
        db.prepare(
          "UPDATE users SET wallet=?,token_checked=NULL WHERE id='u'",
        ).run("0x0000000000000000000000000000000000000002");
      const value = call.params[0].data.startsWith("0x70a08231")
        ? 6000000n * 10n ** 18n
        : 18n;
      return {
        jsonrpc: "2.0",
        id: call.id,
        result: "0x" + value.toString(16).padStart(64, "0"),
      };
    };
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify(Array.isArray(body) ? body.map(respond) : respond(body)),
    );
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    db.close();
  });
  return {
    db,
    user,
    cfg: {
      rpc: `http://127.0.0.1:${server.address().port}`,
      token: "0x0000000000000000000000000000000000000003",
      chain: 1,
    },
  };
}
test("token RPC refresh records holdings and preserves established holding period", async (t) => {
  const { db, user, cfg } = await fixture(t);
  await refreshTokenHoldings(db, cfg, user);
  const first = db.prepare("SELECT * FROM users").get();
  assert.equal(first.token_balance, "6000000");
  assert.ok(first.token_since > 0);
  await refreshTokenHoldings(db, cfg, first);
  assert.equal(
    db.prepare("SELECT * FROM users").get().token_since,
    first.token_since,
  );
});
test("an in-flight token lookup cannot credit a newly linked wallet", async (t) => {
  const { db, user, cfg } = await fixture(t, true);
  await refreshTokenHoldings(db, cfg, user);
  const current = db.prepare("SELECT * FROM users").get();
  assert.equal(current.token_balance, "0");
  assert.equal(current.token_since, null);
  assert.equal(current.token_checked, null);
});
