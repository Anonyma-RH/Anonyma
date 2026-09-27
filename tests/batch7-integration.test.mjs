import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";
import { DAY_MS, ACTIVITY_STEP_MS } from "../src/inactivity-wipe.js";

// Exercise the same new stores through each account lifecycle, with a second
// account to catch accidental broad deletion. These are isolated fixture funds.
test("batch 7 stores export and erase together, returning gifts exactly once", async (t) => {
  for (const method of ["panic", "closure", "inactivity"]) await t.test(method, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "anonyma-batch7-"));
    const svc = createApp({ testMode: true, released: "all", origin: "http://localhost:5175",
      dbPath: join(dir, "test.sqlite"), mediaPath: join(dir, "media"), catalogPath: join(dir, "models.json") });
    t.after(() => { svc.close(); rmSync(dir, { recursive: true, force: true }); });
    await svc.stopWork();
    const db = svc.db, at = Date.now();
    const users = [];
    for (const username of ["alice", "brenda"]) {
      const agent = request.agent(svc.app);
      const r = await agent.post("/api/auth/register").send({ username, password: "fixture-password-long" }).expect(201);
      const id = r.body.user.id;
      const funds = balance(db, id);
      await agent.post("/api/gifts").send({ amount: 100, note: "Fixture gift", requestId: `gift-${username}` }).expect(201);
      db.prepare("INSERT INTO canvas_documents(id,user_id,title,content,created,updated) VALUES(?,?,?,?,?,?)")
        .run(`canvas-${username}`, id, "Fixture canvas", "Private fixture prose", at, at);
      db.prepare("INSERT INTO slide_decks(id,user_id,title,theme,slides,created,updated) VALUES(?,?,?,?,?,?,?)")
        .run(`deck-${username}`, id, "Fixture deck", "cobalt", '[]', at, at);
      db.prepare("INSERT INTO vault_sync(user_id,id,salt,iterations,verifier_iv,verifier_ct,seq,created,updated) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, `vault-${username}`, Buffer.alloc(16).toString("base64"), 600000, Buffer.alloc(12).toString("base64"), Buffer.alloc(32).toString("base64"), 1, at, at);
      db.prepare("INSERT INTO vault_sync_records(user_id,id,version,seq,iv,ct,size,deleted,updated) VALUES(?,?,?,?,?,?,?,?,?)")
        .run(id, `record-${username}`, 1, 1, Buffer.alloc(12), Buffer.alloc(32), 32, 0, at);
      db.prepare("INSERT INTO arena_consent(user_id,choice) VALUES(?,?)").run(id, "yes");
      db.prepare("INSERT INTO conversations(id,user_id,title,mode,created,updated) VALUES(?,?,?,?,?,?)")
        .run(`notes-${username}`, id, "Fixture meeting notes", "chat", at, at);
      db.prepare("INSERT INTO messages(id,conversation_id,role,content,created) VALUES(?,?,?,?,?)")
        .run(`message-${username}`, `notes-${username}`, "assistant", JSON.stringify("Fixture transcript and notes"), at);
      users.push({ id, agent, funds });
    }
    db.prepare("INSERT INTO arena_tally(day,model_lo,model_hi,lo_wins) VALUES(?,?,?,?)")
      .run("2026-09-27", "fixture-a", "fixture-b", 1);
    const [a, b] = users;
    const exported = (await a.agent.get("/api/account/export").expect(200)).body;
    assert.equal(exported.gifts.length, 1);
    assert.equal(exported.canvases.length, 1);
    assert.equal(exported.slideDecks.length, 1);
    assert.equal(exported.vaultSync.records.length, 1);
    assert.ok(JSON.stringify(exported).includes("Fixture meeting notes"));
    const stores = ["gifts", "canvas_documents", "slide_decks", "vault_sync", "vault_sync_records", "arena_consent", "conversations"];
    const counts = (id) => stores.map((name) => db.prepare(`SELECT COUNT(*) n FROM ${name} WHERE user_id=?`).get(id).n);
    const otherBefore = counts(b.id);
    if (method === "panic") await a.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
    if (method === "closure") await a.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
    if (method === "inactivity") {
      await a.agent.put("/api/inactivity-wipe").send({ days: 30, confirm: true }).expect(200);
      db.prepare("UPDATE inactivity_wipe SET last_active=?,paused=0 WHERE user_id=?")
        .run(at - 30 * DAY_MS - ACTIVITY_STEP_MS - 1, a.id);
      db.prepare("INSERT INTO inactivity_clock(id,last_sweep) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_sweep=excluded.last_sweep").run(at - 60000);
      assert.equal((await svc.inactivity.sweep(at)).erased, 1);
      assert.equal((await svc.inactivity.sweep(at + 1000)).erased, 0);
    }
    assert.deepEqual(counts(a.id), stores.map(() => 0));
    assert.deepEqual(counts(b.id), otherBefore);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM arena_tally").get().n, 1, "anonymous aggregate remains");
    assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND kind='gift_return'").get(a.id).n, 1);
    if (method !== "closure") assert.deepEqual(balance(db, a.id), a.funds);
    else assert.equal(db.prepare("SELECT deleted FROM users WHERE id=?").get(a.id).deleted != null, true);
  });
});
