import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { balance, config, database, now, reserve, settle, uid } from "../server/core.js";
import {
  WELCOME_LAUNCH,
  backfillWelcome,
  grantWelcome,
  welcomeLeft,
} from "../server/welcome-credits.js";
import { categoryOf } from "../server/usage-insights.js";
import { compileDictionary, translateText } from "../src/i18n.js";

const UNIT = 10000; // subcredits per credit
const START = 100_000; // local test accounts start with 100,000 credits
function fixture(t, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-welcome-"));
  const s = createApp({
    testMode: true,
    released: "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
    welcomeCredits: 500,
    ...extra,
  });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
let visitor = 0;
const address = () => `198.51.100.${(++visitor % 250) + 1}`;
async function person(app, ip = address()) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", ip)
    .send({ username: "welcomer" + ++visitor, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user, ip };
}
const welcomeRows = (db, user) =>
  db
    .prepare("SELECT amount,ref,description FROM ledger WHERE user_id=? AND kind='welcome'")
    .all(user)
    .map((r) => ({ ...r }));

test("welcome credits default to 500 only in production, and must be whole numbers", () => {
  assert.equal(config({ testMode: false }).welcomeCredits, 0);
  assert.equal(config({ testMode: true }).welcomeCredits, 0);
  assert.equal(config({ welcomeCredits: 250 }).welcomeCredits, 250);
  assert.equal(config().welcomePerAddress, 2);
  assert.equal(config().welcomeDailyMax, 200);
  for (const bad of [-1, 1.5, NaN, 2_000_000])
    assert.throws(() => config({ welcomeCredits: bad }), /welcomeCredits/);
  assert.throws(() => config({ welcomeDailyMax: -5 }), /welcomeDailyMax/);
});

test("a new account starts with 500 welcome credits, and the config says so", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  assert.equal(a.user.balance, START + 500);
  assert.deepEqual(welcomeRows(s.db, a.user.id), [
    { amount: 500 * UNIT, ref: "welcome:" + a.user.id, description: "Free credits to try Anonyma" },
  ]);
  assert.equal((await request(s.app).get("/api/config").expect(200)).body.welcomeCredits, 500);
  // A second grant for the same account never lands.
  assert.equal(grantWelcome(s.db, s.cfg, a.user.id, a.ip), false);
  assert.equal(welcomeRows(s.db, a.user.id).length, 1);
  // Reward column in Usage Insights.
  assert.equal(categoryOf("welcome", null, 500 * UNIT), "reward");
});

test("welcome credits are off at 0", async (t) => {
  const s = fixture(t, { welcomeCredits: 0 });
  const a = await person(s.app);
  assert.equal(a.user.balance, START);
  assert.equal((await request(s.app).get("/api/config").expect(200)).body.welcomeCredits, 0);
});

test("new grants stop at 2 a day per address and at the site-wide daily limit", async (t) => {
  const s = fixture(t, { welcomeDailyMax: 3 });
  const ip = address();
  const [a, b, c] = [await person(s.app, ip), await person(s.app, ip), await person(s.app, ip)];
  assert.deepEqual([a, b, c].map((p) => p.user.balance), [START + 500, START + 500, START]);
  // The account is still created, just without the credits.
  assert.equal(welcomeRows(s.db, c.user.id).length, 0);
  const d = await person(s.app);
  const e = await person(s.app);
  assert.deepEqual([d, e].map((p) => p.user.balance), [START + 500, START]);
  // Addresses are only kept as hashes, and only for a day.
  const targets = s.db.prepare("SELECT target FROM rate_events WHERE kind='welcome'").all();
  assert.ok(targets.every((r) => /^[0-9a-f]{64}$/.test(r.target)));
  s.db.prepare("UPDATE rate_events SET created=? WHERE kind='welcome'").run(now() - 86400001);
  assert.equal((await person(s.app, ip)).user.balance, START + 500);
});

test("accounts from before the launch get welcome credits once; deleted accounts and treasuries don't", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-welcome-"));
  const db = database(join(dir, "test.sqlite"));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const cfg = config({ welcomeCredits: 500 });
  const add = (id, created, deleted = null) =>
    db.prepare("INSERT INTO users(id,username,created,deleted) VALUES(?,?,?,?)").run(id, id, created, deleted);
  add("u_old", WELCOME_LAUNCH - 86400000);
  add("u_gone", WELCOME_LAUNCH - 86400000, WELCOME_LAUNCH - 1000);
  add("treasury_x", WELCOME_LAUNCH - 5000, WELCOME_LAUNCH - 5000);
  add("u_new", WELCOME_LAUNCH + 1000);
  add("u_had", WELCOME_LAUNCH - 3000);
  grantWelcome(db, cfg, "u_had", "203.0.113.9");
  assert.equal(backfillWelcome(db, cfg), 1);
  assert.equal(backfillWelcome(db, cfg), 0);
  const granted = db
    .prepare("SELECT user_id, amount FROM ledger WHERE kind='welcome' ORDER BY user_id")
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(granted, [
    { user_id: "u_had", amount: 500 * UNIT },
    { user_id: "u_old", amount: 500 * UNIT },
  ]);
  assert.equal(backfillWelcome(db, config({ welcomeCredits: 0 })), 0);
});

test("welcome credits are spent first and can't be sent, gifted or put in a treasury", async (t) => {
  const s = fixture(t);
  const a = await person(s.app);
  const b = await person(s.app);
  const send = (credits, requestId) =>
    a.agent.post("/api/credits/send").send({ to: b.user.username, amount: credits, requestId });
  // Paid credit moves; welcome credits don't.
  const locked = await send(START + 1, "w-1").expect(402);
  assert.equal(locked.body.error.code, "welcome_credits_locked");
  await send(START - 100, "w-2").expect(201);
  assert.equal(balance(s.db, a.user.id).available, 600 * UNIT);
  // A request spends welcome credits before paid credit: while it's held
  // and once it's settled.
  const hold = uid("h_");
  reserve(s.db, { id: hold, user: a.user.id, amount: 300 * UNIT });
  assert.equal(welcomeLeft(s.db, a.user.id), 200 * UNIT);
  settle(s.db, hold, 250 * UNIT);
  assert.equal(welcomeLeft(s.db, a.user.id), 250 * UNIT);
  // 350 left: 250 welcome, 100 paid.
  await send(101, "w-3").expect(402);
  await send(100, "w-4").expect(201);
  assert.equal(balance(s.db, a.user.id).available, 250 * UNIT);
  const gift = await a.agent.post("/api/gifts").set("X-Forwarded-For", a.ip).send({ amount: 100 }).expect(402);
  assert.equal(gift.body.error.code, "welcome_credits_locked");
  const collab = (await a.agent.post("/api/collabs").send({ name: "Crew" }).expect(201)).body;
  const contribution = await a.agent
    .post(`/api/collabs/${collab.id || collab.collab?.id}/treasury/contribute`)
    .send({ credits: 5, idempotency_key: "c-1" })
    .expect(402);
  assert.equal(contribution.body.error.code, "welcome_credits_locked");
  // Once requests have used them up, everything received moves freely.
  settle(s.db, (reserve(s.db, { id: "h_all", user: a.user.id, amount: 250 * UNIT }), "h_all"), 250 * UNIT);
  assert.equal(welcomeLeft(s.db, a.user.id), 0);
  await b.agent.post("/api/credits/send").send({ to: a.user.username, amount: 20, requestId: "back" }).expect(201);
  await send(20, "w-5").expect(201);
});

test("welcome credit copy is translated", () => {
  for (const lang of ["zh", "es"]) {
    const raw = JSON.parse(readFileSync(new URL(`../src/i18n/${lang}.json`, import.meta.url), "utf8"));
    const compiled = compileDictionary(raw, lang);
    for (const text of [
      "Welcome credits",
      "Free credits to try Anonyma",
      "New accounts start with 500 free credits.",
      "Free welcome credits can only be spent on requests. They can't be sent, gifted or added to a treasury.",
    ])
      assert.notEqual(translateText(text, compiled), text, `${lang}: ${text}`);
  }
});
