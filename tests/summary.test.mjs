import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance } from "../server/core.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-summary-"));
  const svc = createApp({
    testMode: true, released: "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(app, username) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${++visitor}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}

test("the spending summary counts settled usage only, by day and kind", async (t) => {
  const s = fixture(t);
  const ana = await person(s.app, "ana");
  await person(s.app, "ben");
  const empty = (await ana.agent.get("/api/account/summary").expect(200)).body;
  assert.equal(empty.days.length, 14);
  assert.ok(empty.days.every((d) => d.spent === 0));
  assert.deepEqual(empty.byKind, []);

  const before = balance(s.db, ana.user.id).total;
  for (const text of ["one", "two"])
    await ana.agent
      .post("/api/chat")
      .send({
        model: "google/gemini-2.5-flash",
        messages: [{ role: "user", content: text }],
        max_tokens: 50,
      })
      .expect(200);
  const used = before - balance(s.db, ana.user.id).total;
  assert.ok(used > 0);
  // Sending credits moves money but isn't spending.
  await ana.agent
    .post("/api/credits/send")
    .send({ to: "ben", amount: 5 })
    .expect(201);

  const tz = new Date().getTimezoneOffset();
  const r = (await ana.agent.get("/api/account/summary?tz=" + tz).expect(200))
    .body;
  const today = r.days.at(-1);
  const local = new Date(Date.now() - tz * 60000).toISOString().slice(0, 10);
  assert.equal(today.date, local);
  assert.equal(today.spent, used / 10000);
  assert.deepEqual(
    r.byKind.map((k) => [k.kind, k.requests]),
    [["chat", 2]],
  );
  assert.equal(r.week.spent, used / 10000);
  assert.equal(r.week.previous, 0);
  assert.equal(r.week.requests, 2);
  assert.deepEqual(r.week.byKind, { chat: 2 });
  await request(s.app).get("/api/account/summary").expect(401);
});
