import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { addCredit, balance, now, uid } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { settledSince, TRANSFER_KINDS } from "../server/spending-limits.js";
import { categoryOf } from "../server/usage-insights.js";
import {
  ACCOUNT_FAILURES,
  ADDRESS_FAILURES,
  GIFT_TTL,
  codeHash,
  expireGifts,
} from "../server/routes/gifts.js";
import {
  GIFT_ALPHABET,
  GIFT_MAX,
  GIFT_MIN,
  GIFT_OPEN_MAX,
  GIFT_STORE_KEY,
  captureGiftCode,
  checkSymbol,
  codeFromBytes,
  forgetGiftCode,
  giftLink,
  keptGiftCode,
  normalizeGiftNote,
  parseGiftAmount,
  readCode,
} from "../src/gift-links.js";
import { knownPage, sitemap, robots } from "../src/site-routes.js";
import { safeNext, isReleased as clientReleased } from "../src/lib.js";
import { compileDictionary, translateText } from "../src/i18n.js";
import { WIPE_GIFTS } from "../src/panic-wipe.js";
import { paletteActions } from "../src/command-palette.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const UNIT = 10000; // subcredits per credit
const START = 100_000 * UNIT; // local test accounts start with 100,000 credits
function fixture(t, released, extra = {}) {
  const dir = extra.dir || mkdtempSync(join(tmpdir(), "anonyma-gifts-"));
  const s = createApp({
    testMode: true,
    released: released ?? "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: "http://localhost:5175",
  });
  s.dir = dir;
  t.after(() => {
    s.close();
    if (!extra.dir) rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
let visitor = 0;
const address = () => `198.51.100.${(++visitor % 250) + 1}`;
async function person(app, username, ip = address()) {
  const agent = request.agent(app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", ip)
    .send({ username, password: "test-password-long" })
    .expect(201);
  const token = /anonyma_session=([^;]+)/.exec(r.headers["set-cookie"].join(";"))[1];
  return { agent, user: r.body.user, ip, token };
}
const give = (p, body) => p.agent.post("/api/gifts").set("X-Forwarded-For", p.ip).send(body);
const claim = (p, code) => p.agent.post("/api/gifts/claim").set("X-Forwarded-For", p.ip).send({ code });
const peek = (app, code, ip = address()) =>
  request(app).post("/api/gifts/peek").set("X-Forwarded-For", ip).send({ code });
const units = (s, user) => balance(s.db, user).total;
const ledgerOf = (s, user) =>
  s.db
    .prepare("SELECT amount,kind,ref,description FROM ledger WHERE user_id=? ORDER BY created,rowid")
    .all(user)
    .map((r) => ({ ...r }));
// Every credit in the system: every balance plus what open gifts hold. A
// gift moves credits; it never makes or loses any.
const allLedger = (s) =>
  s.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM ledger").get().n +
  s.db.prepare("SELECT COALESCE(SUM(amount),0) n FROM gifts WHERE status='open'").get().n;
const newCode = () => codeFromBytes(randomBytes(27));
const cfg = (features) => ({ releases: { features } });

// ---- The release gate ----

test("unreleased: every route is refused, the page is a 404, and nothing is listed, exported or linked", async (t) => {
  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app, "ana");
  for (const send of [
    () => a.agent.get("/api/gifts"),
    () => a.agent.post("/api/gifts").send({ amount: 1000 }),
    () => a.agent.post("/api/gifts/gift_x/revoke").send({}),
    () => a.agent.post("/api/gifts/claim").send({ code: newCode() }),
    () => a.agent.post("/api/gifts/peek").send({ code: newCode() }),
    () => request(mvp.app).post("/api/gifts/peek").send({ code: newCode() }),
    () => a.agent.get("/API/Gifts/"),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Gift Links is coming soon.");
  }
  assert.equal(mvp.db.prepare("SELECT COUNT(*) n FROM gifts").get().n, 0);
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.giftlinks, false);
  const entry = config.releases.updates.find((u) => u.id === "giftlinks");
  assert.equal(entry.title, "Gift Links");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  assert.equal(UPDATES.filter((u) => u.id === "giftlinks").length, 1);
  assert.equal(typeof committed[UPDATES.findIndex((u) => u.id === "giftlinks")], "boolean", "registered release flag");
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!Object.keys(closed.paths).some((p) => p.includes("gift")));
  const exported = (await a.agent.get("/api/account/export").expect(200)).body;
  assert.ok(!("gifts" in exported), "no gifts key while unreleased and empty");
  // The claim page: a 404 until release, with no special headers; never in
  // the sitemap or robots.txt.
  assert.equal(knownPage("/gift"), false);
  assert.equal(knownPage("/gift", { gift: true }), true);
  assert.equal(knownPage("/gift/", { gift: true }), true);
  assert.ok(!sitemap("https://askanonyma.com", { gift: true }).includes("gift"));
  assert.ok(!robots("https://askanonyma.com").includes("gift"));
  const own = fixture(t, "mvp,giftlinks");
  if (existsSync("dist/client/index.html")) {
    const hidden = await request(mvp.app).get("/gift").expect(404);
    assert.equal(hidden.headers["x-robots-tag"], undefined);
    const page = await request(own.app).get("/gift").expect(200);
    assert.equal(page.headers["referrer-policy"], "no-referrer");
    assert.equal(page.headers["x-robots-tag"], "noindex, nofollow");
  }
  // Only its own routes are gated by it.
  assert.deepEqual(featuresFor({ path: "/api/gifts/claim", method: "POST", body: {} }), ["giftlinks"]);
  assert.deepEqual(featuresFor({ path: "/api/gifts", method: "GET", body: {} }), ["giftlinks"]);
  for (const path of ["/api/credits/send", "/api/account/export", "/api/me", "/gift"])
    assert.ok(!featuresFor({ path, method: "GET", body: {} }).includes("giftlinks"), path);
  // The client shows nothing until release.
  assert.equal(clientReleased(cfg({}), "giftlinks"), false);
  assert.equal(clientReleased(cfg({ giftlinks: true }), "giftlinks"), true);
  const src = (f) => readFileSync(new URL("../src/" + f, import.meta.url), "utf8");
  assert.match(src("Account.jsx"), /section === "credits" && giftsOn && \(demo \|\| user\) && \(/);
  assert.match(src("App.jsx"), /=== "\/gift" && isReleased\(config, "giftlinks"\)/);
  assert.match(src("GiftClaim.jsx"), /if \(!live\) return <NotFound \/>;/);
  assert.match(src("PanicWipe.jsx"), /\{giftsLive && <li>\{WIPE_GIFTS\}<\/li>\}/);
  const palette = (c, extra = {}) =>
    paletteActions({ config: c, mode: "chat", signedIn: true, ...extra }).map((x) => x.id);
  assert.ok(!palette(cfg({})).includes("gift-links"));
  assert.ok(palette(cfg({ giftlinks: true })).includes("gift-links"));
  assert.ok(!palette(cfg({ giftlinks: true }), { demo: true }).includes("gift-links"));
  assert.ok(!palette(cfg({ giftlinks: true }), { signedIn: false }).includes("gift-links"));
  // Released on its own, it needs nothing else.
  const b = await person(own.app, "ben");
  await give(b, { amount: 1000 }).expect(201);
  const open = (await request(own.app).get("/api/openapi.json").expect(200)).body;
  for (const [path, method] of [
    ["/api/gifts", "get"],
    ["/api/gifts", "post"],
    ["/api/gifts/{id}/revoke", "post"],
    ["/api/gifts/peek", "post"],
    ["/api/gifts/claim", "post"],
  ])
    assert.ok(open.paths[path]?.[method], `${method} ${path}`);
  // Sign-in sends you back to the claim page, and nowhere else new.
  assert.equal(safeNext("/gift"), "/gift");
  assert.equal(safeNext("/gift#ABCD"), null);
  assert.equal(safeNext("/gift?x=1"), null);
  assert.equal(safeNext("//evil.example/gift"), null);
});

// ---- Codes ----

test("a code is 135 random bits plus a check symbol, read however it's pasted", () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const code = newCode();
    assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
    const read = readCode(code);
    assert.equal(read.typo, false);
    assert.equal(read.code, code);
    seen.add(read.symbols);
  }
  assert.equal(seen.size, 2000);
  assert.equal(GIFT_ALPHABET.length, 32);
  assert.ok(27 * Math.log2(GIFT_ALPHABET.length) >= 128, "at least 128 random bits");
  // Every random symbol is a byte's low five bits: no bias.
  const bytes = Buffer.alloc(27, 0xff);
  assert.equal(codeFromBytes(bytes).replace(/-/g, "").slice(0, 27), "Z".repeat(27));
  assert.throws(() => codeFromBytes(Buffer.alloc(26)));
  // However it's pasted: lowercase, spaces, no dashes, lookalikes, a link.
  const code = newCode();
  const plain = code.replace(/-/g, "");
  for (const input of [
    code.toLowerCase(),
    plain,
    ` ${code.replace(/-/g, " ")} `,
    giftLink("https://askanonyma.com", code),
    code.replace(/0/g, "O").replace(/1/g, "I"),
    code.replace(/1/g, "l"),
  ])
    assert.equal(readCode(input)?.code, code, input);
  for (const bad of ["", "ABCD", plain + "0", plain.slice(1), plain.slice(0, 27) + "U", null, "x".repeat(500)])
    assert.equal(readCode(bad), null, String(bad));
  // A wrong symbol is caught by the check symbol, and so is a swap of two
  // neighbours (only 0 and Z, 31 apart, can hide from it).
  const symbols = readCode(code).symbols;
  let caught = 0,
    tried = 0;
  for (let i = 0; i < 28; i++)
    for (const c of GIFT_ALPHABET) {
      if (c === symbols[i]) continue;
      const diff = Math.abs(GIFT_ALPHABET.indexOf(c) - GIFT_ALPHABET.indexOf(symbols[i]));
      const typo = readCode(symbols.slice(0, i) + c + symbols.slice(i + 1));
      tried++;
      if (typo.typo) caught++;
      else assert.equal(diff, 31, `missed ${symbols[i]}→${c} at ${i}`);
    }
  assert.ok(caught >= tried - 28, `${caught}/${tried}`);
  for (let i = 0; i < 26; i++) {
    if (symbols[i] === symbols[i + 1]) continue;
    const swapped = symbols.slice(0, i) + symbols[i + 1] + symbols[i] + symbols.slice(i + 2);
    const diff = Math.abs(GIFT_ALPHABET.indexOf(symbols[i]) - GIFT_ALPHABET.indexOf(symbols[i + 1]));
    if (diff !== 31) assert.equal(readCode(swapped).typo, true, `swap at ${i}`);
  }
  assert.equal(checkSymbol(symbols), symbols[27]);
  // Amounts and notes, as the form reads them.
  assert.equal(parseGiftAmount("5,000"), 5000);
  assert.equal(parseGiftAmount(String(GIFT_MIN)), GIFT_MIN);
  assert.equal(parseGiftAmount(String(GIFT_MAX)), GIFT_MAX);
  for (const bad of ["99", "250001", "100.5", "-100", "", "1e3"]) assert.equal(parseGiftAmount(bad), null, bad);
  assert.equal(normalizeGiftNote("  Happy \n\t birthday  "), "Happy birthday");
});

test("the link's #code leaves the address bar before the app starts and waits in this tab only", () => {
  const store = new Map();
  const session = {
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  const replaced = [];
  const history = { state: { usr: null, key: "x" }, replaceState: (state, _, url) => replaced.push({ state, url }) };
  const code = newCode();
  assert.equal(captureGiftCode({ pathname: "/gift", search: "", hash: "#" + code }, history, session), code);
  assert.deepEqual(replaced, [{ state: history.state, url: "/gift" }], "the fragment is gone from the address");
  assert.equal(store.get(GIFT_STORE_KEY), code);
  assert.equal(keptGiftCode(session), code);
  forgetGiftCode(session);
  assert.equal(keptGiftCode(session), null);
  // A fragment that isn't a code is still taken out, and nothing is kept.
  assert.equal(captureGiftCode({ pathname: "/gift/", search: "", hash: "#nonsense" }, history, session), null);
  assert.equal(replaced.length, 2);
  assert.equal(store.size, 0);
  // Other pages are never touched.
  assert.equal(captureGiftCode({ pathname: "/s/abc", search: "", hash: "#" + code }, history, session), null);
  assert.equal(captureGiftCode({ pathname: "/gift", search: "", hash: "" }, history, session), null);
  assert.equal(replaced.length, 2);
  // It runs first: main.jsx imports it right after Sealed Share's boot.
  const main = readFileSync(new URL("../src/main.jsx", import.meta.url), "utf8");
  assert.ok(main.indexOf('import "./gift-boot.js";') < main.indexOf("import React"));
  assert.match(readFileSync(new URL("../Dockerfile", import.meta.url), "utf8"), /src\/gift-links\.js/);
});

// ---- Money ----

test("the money flow is exact in the ledger: made, claimed, and nobody learns who", async (t) => {
  const s = fixture(t);
  const giver = await person(s.app, "giver");
  const taker = await person(s.app, "taker");
  const before = allLedger(s);
  const made = await give(giver, { amount: 5000, note: "  Happy  birthday! " }).expect(201);
  assert.equal(made.body.amount, 5000);
  assert.equal(made.body.note, "Happy birthday!");
  assert.equal(made.body.status, "open");
  assert.equal(made.body.available, 95_000);
  assert.equal(made.body.expires - made.body.created, GIFT_TTL);
  assert.equal(made.body.link, "http://localhost:5175/gift#" + made.body.code);
  assert.equal(units(s, giver.user.id), START - 5000 * UNIT);
  const out = ledgerOf(s, giver.user.id).at(-1);
  assert.deepEqual(out, { amount: -5000 * UNIT, kind: "gift_out", ref: made.body.id + ":out", description: "Gift created" });
  // Anyone with the link can look first, signed in or not.
  const look = await peek(s.app, made.body.link).expect(200);
  assert.deepEqual(look.body, { status: "open", amount: 5000, note: "Happy birthday!", expires: made.body.expires, own: false });
  const mine = await giver.agent.post("/api/gifts/peek").send({ code: made.body.code }).expect(200);
  assert.equal(mine.body.own, true);
  // The claim.
  const got = await claim(taker, made.body.code.toLowerCase()).expect(200);
  assert.deepEqual(got.body, { status: "claimed", amount: 5000, note: "Happy birthday!", available: 105_000 });
  assert.equal(units(s, taker.user.id), START + 5000 * UNIT);
  assert.deepEqual(ledgerOf(s, taker.user.id).at(-1), {
    amount: 5000 * UNIT,
    kind: "gift_in",
    ref: made.body.id + ":settle",
    description: "Gift claimed",
  });
  // Conservation: a gift moves credits, it never makes or loses any.
  assert.equal(allLedger(s), before);
  // The giver sees only that it was claimed, and when.
  const list = (await giver.agent.get("/api/gifts").expect(200)).body;
  assert.equal(list.data[0].status, "claimed");
  assert.ok(list.data[0].claimed >= made.body.created);
  assert.equal(list.open, 0);
  const exported = (await giver.agent.get("/api/account/export").expect(200)).body;
  for (const text of [JSON.stringify(list), JSON.stringify(exported.gifts), JSON.stringify(ledgerOf(s, giver.user.id))]) {
    assert.ok(!text.includes(taker.user.id), "never the claimer's id");
    assert.ok(!text.includes("taker"), "never the claimer's name");
  }
  // The claimer never learns who sent it.
  assert.ok(!JSON.stringify(got.body).includes("giver") && !JSON.stringify(ledgerOf(s, taker.user.id)).includes("giver"));
  // The gift row doesn't keep who claimed it.
  const row = s.db.prepare("SELECT * FROM gifts WHERE id=?").get(made.body.id);
  assert.ok(!Object.values(row).includes(taker.user.id));
  // Once claimed, the link says so and shows nothing else.
  assert.deepEqual((await peek(s.app, made.body.code).expect(200)).body, { status: "claimed" });
  assert.equal((await claim(taker, made.body.code).expect(410)).body.error.code, "gift_claimed");
  // The ledger enforces one payout whatever code runs.
  assert.throws(
    () =>
      s.db
        .prepare("INSERT INTO ledger(id,user_id,amount,kind,ref,created) VALUES(?,?,?,?,?,?)")
        .run(uid("l_"), giver.user.id, 5000 * UNIT, "gift_return", made.body.id + ":settle", now()),
    /UNIQUE/,
  );
  // And a gift, once ended, can't change again.
  assert.throws(() => s.db.prepare("UPDATE gifts SET status='revoked' WHERE id=?").run(made.body.id), /gift_ended/);
  assert.throws(() => s.db.prepare("UPDATE gifts SET amount=1 WHERE id=?").run(made.body.id), /gift_ended/);
  // Usage Insights files it as sent and received; Spending Limits counts it.
  assert.equal(categoryOf("gift_out", null, -1), "sent");
  assert.equal(categoryOf("gift_return", null, 1), "sent");
  assert.equal(categoryOf("gift_in", null, 1), "received");
  assert.ok(TRANSFER_KINDS.includes("gift_out"));
  assert.equal(settledSince(s.db, giver.user.id, 0), 5000 * UNIT);
  assert.equal(settledSince(s.db, taker.user.id, 0), 0);
});

test("the balance, amounts, notes, spending limits and the dispute pause all apply when making a gift", async (t) => {
  const s = fixture(t);
  // Every request counts toward the ten an hour, so checks are spread over
  // accounts.
  const v = await person(s.app, "vale");
  const a = await person(s.app, "alma");
  const b = await person(s.app, "bea");
  for (const amount of [GIFT_MIN - 1, GIFT_MAX + 1, 100.5, "5000", null, -100])
    assert.equal((await give(v, { amount }).expect(400)).body.error.code, "invalid_amount", String(amount));
  assert.equal((await give(v, { amount: 1000, note: "x".repeat(141) }).expect(400)).body.error.code, "note_too_long");
  assert.equal((await give(v, { amount: 1000, note: 5 }).expect(400)).body.error.code, "invalid_note");
  // Seed Guard: a note is read by whoever has the link.
  const seed = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
  assert.equal((await give(v, { amount: 1000, note: seed }).expect(400)).body.error.code, "seed_phrase_blocked");
  // More than the available balance.
  assert.equal((await give(a, { amount: GIFT_MAX }).expect(402)).body.error.code, "insufficient_credits");
  addCredit(s.db, a.user.id, 200_000 * UNIT, "extra_" + a.user.id, "test_credit", "test");
  const big = await give(a, { amount: GIFT_MAX }).expect(201);
  assert.equal(big.body.amount, GIFT_MAX);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM gifts").get().n, 1, "refusals wrote nothing");
  addCredit(s.db, a.user.id, 600_000 * UNIT, "more_" + a.user.id, "test_credit", "test");
  // The same request id twice makes one gift, and the code isn't shown again.
  const again = await give(a, { amount: GIFT_MAX, requestId: "same" }).expect(201);
  const repeat = await give(a, { amount: GIFT_MAX, requestId: "same" }).expect(200);
  assert.equal(repeat.body.repeated, true);
  assert.equal(repeat.body.id, again.body.id);
  assert.equal(repeat.body.code, undefined);
  assert.equal(repeat.body.link, undefined);
  assert.equal((await give(a, { amount: 1000, requestId: "same" }).expect(409)).body.error.code, "duplicate_request");
  assert.equal(ledgerOf(s, a.user.id).filter((l) => l.kind === "gift_out").length, 2);
  // Spending Limits: a gift counts against the giver's limit.
  s.db
    .prepare("INSERT INTO spending_limits(user_id,daily_limit,monthly_limit,updated) VALUES(?,?,?,?)")
    .run(b.user.id, 3000 * UNIT, null, now());
  const limited = await give(b, { amount: 5000 }).expect(402);
  assert.equal(limited.body.error.code, "spending_limit");
  assert.equal(limited.body.spending_limit.limit, "daily");
  await give(b, { amount: 2000 }).expect(201);
  assert.equal((await give(b, { amount: 1500 }).expect(402)).body.error.code, "spending_limit");
  await give(b, { amount: 1000 }).expect(201);
  // A payment under reconciliation pauses making gifts, and claiming the
  // gifts already made (with a message that says nothing about why).
  const code = (await give(a, { amount: 1000 }).expect(201)).body.code;
  const t0 = now();
  s.db
    .prepare("INSERT INTO deposits(id,user_id,provider_id,amount,currency,status,payload,credited,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(uid("dep_"), a.user.id, "p_" + uid(), 10_000_000, "usdg", "reconciliation", "{}", 1, t0, t0);
  assert.equal((await give(a, { amount: 1000 }).expect(409)).body.error.code, "payment_reconciliation_pending");
  const paused = await claim(b, code).expect(409);
  assert.equal(paused.body.error.code, "gift_paused");
  assert.equal(paused.body.error.message, "This gift can't be claimed right now. Try again later.");
  // At most 25 open gifts per account, in the route and in the database.
  const c = await person(s.app, "cato");
  const insert = s.db.prepare(
    "INSERT INTO gifts(id,user_id,code_hash,amount,note,status,request_id,created,expires) VALUES(?,?,?,?,?,'open',?,?,?)",
  );
  for (let i = 0; i < GIFT_OPEN_MAX; i++)
    insert.run(uid("gift_"), c.user.id, codeHash(readCode(newCode()).symbols), 100 * UNIT, "", "r" + i, now(), now() + GIFT_TTL);
  assert.equal((await give(c, { amount: 100 }).expect(409)).body.error.code, "gift_limit");
  assert.throws(
    () => insert.run(uid("gift_"), c.user.id, codeHash(readCode(newCode()).symbols), 100 * UNIT, "", "r-x", now(), now() + GIFT_TTL),
    /gift_limit/,
  );
});

// ---- Races ----

test("parallel claims from many accounts: exactly one wins, and the ledger pays once", async (t) => {
  const s = fixture(t);
  const giver = await person(s.app, "gina");
  const takers = [];
  for (let i = 0; i < 8; i++) takers.push(await person(s.app, "rush" + i));
  const before = allLedger(s);
  const { code, id } = (await give(giver, { amount: 2500 }).expect(201)).body;
  const results = await Promise.all(takers.map((p) => claim(p, code)));
  const won = results.filter((r) => r.status === 200);
  assert.equal(won.length, 1);
  for (const r of results.filter((r) => r.status !== 200)) assert.equal(r.body.error.code, "gift_claimed");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE ref=?").get(id + ":settle").n, 1);
  assert.equal(allLedger(s), before);
  const paid = takers.filter((p) => units(s, p.user.id) === START + 2500 * UNIT);
  assert.equal(paid.length, 1);

  // A claim racing the giver's Cancel: one or the other, never both.
  const second = (await give(giver, { amount: 1000 }).expect(201)).body;
  const [claimed, revoked] = await Promise.all([
    claim(takers[0], second.code),
    giver.agent.post(`/api/gifts/${second.id}/revoke`).send({}),
  ]);
  assert.equal([claimed.status, revoked.status].filter((x) => x === 200).length, 1);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE ref=?").get(second.id + ":settle").n, 1);
  assert.equal(allLedger(s), before);
});

test("claims racing from separate database connections still pay exactly once", async (t) => {
  const s = fixture(t);
  const giver = await person(s.app, "gus");
  const takers = [];
  for (let i = 0; i < 6; i++) takers.push(await person(s.app, "thread" + i));
  const gifts = [];
  for (let i = 0; i < 5; i++) gifts.push((await give(giver, { amount: 1000 + i }).expect(201)).body);
  const before = allLedger(s);
  const gate = new Int32Array(new SharedArrayBuffer(4));
  const code = `
    const { workerData, parentPort } = require("node:worker_threads");
    (async () => {
      const core = await import(workerData.core);
      const gifts = await import(workerData.gifts);
      const db = core.database(workerData.db);
      Atomics.wait(workerData.gate, 0, 0);
      const won = [], lost = [];
      for (const symbols of workerData.codes) {
        try {
          const g = gifts.claimGift(db, workerData.user, symbols);
          if (g) won.push(g.id);
        } catch (e) {
          if (e.code !== "gift_claimed") throw e;
          lost.push(symbols);
        }
      }
      db.close();
      parentPort.postMessage({ won, lost: lost.length });
    })().catch((e) => parentPort.postMessage({ error: e.message }));
  `;
  const codes = gifts.map((g) => readCode(g.code).symbols);
  const runs = takers.map((p) => {
    const w = new Worker(code, {
      eval: true,
      workerData: {
        core: new URL("../server/core.js", import.meta.url).href,
        gifts: new URL("../server/routes/gifts.js", import.meta.url).href,
        db: join(s.dir, "test.sqlite"),
        user: p.user.id,
        codes,
        gate,
      },
    });
    return new Promise((resolve, reject) => {
      w.once("message", resolve);
      w.once("error", reject);
    });
  });
  await new Promise((r) => setTimeout(r, 300));
  Atomics.store(gate, 0, 1);
  Atomics.notify(gate, 0);
  const results = await Promise.all(runs);
  for (const r of results) assert.equal(r.error, undefined, r.error);
  const won = results.flatMap((r) => r.won);
  assert.equal(won.length, gifts.length, "each gift claimed once");
  assert.equal(new Set(won).size, gifts.length);
  assert.equal(results.reduce((n, r) => n + r.lost, 0), gifts.length * (takers.length - 1));
  for (const g of gifts)
    assert.equal(s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE ref=?").get(g.id + ":settle").n, 1);
  assert.equal(allLedger(s), before);
});

// ---- Cancel and expiry ----

test("cancelling and expiry give the credits back, once, whether or not the update is live", async (t) => {
  const s = fixture(t);
  const giver = await person(s.app, "gale");
  const other = await person(s.app, "otto");
  const before = allLedger(s);
  const gift = (await give(giver, { amount: 3000 }).expect(201)).body;
  const cancelled = await giver.agent.post(`/api/gifts/${gift.id}/revoke`).send({}).expect(200);
  assert.equal(cancelled.body.status, "revoked");
  assert.equal(cancelled.body.available, 100_000);
  assert.ok(cancelled.body.returned >= gift.created);
  assert.deepEqual(ledgerOf(s, giver.user.id).at(-1), {
    amount: 3000 * UNIT,
    kind: "gift_return",
    ref: gift.id + ":settle",
    description: "Gift cancelled",
  });
  assert.equal((await giver.agent.post(`/api/gifts/${gift.id}/revoke`).send({}).expect(409)).body.error.code, "gift_not_open");
  assert.equal((await other.agent.post(`/api/gifts/${gift.id}/revoke`).send({}).expect(404)).body.error.code, "gift_not_found");
  assert.equal((await claim(other, gift.code).expect(410)).body.error.code, "gift_returned");
  assert.deepEqual((await peek(s.app, gift.code).expect(200)).body, { status: "cancelled" });
  // A claimed gift can't be cancelled.
  const claimedGift = (await give(giver, { amount: 1000 }).expect(201)).body;
  await claim(other, claimedGift.code).expect(200);
  const late = await giver.agent.post(`/api/gifts/${claimedGift.id}/revoke`).send({}).expect(409);
  assert.equal(late.body.error.message, "This gift was already claimed, so it can't be cancelled.");
  // Expiry: unclaimed after 30 days, it comes back by itself, once.
  const waiting = (await give(giver, { amount: 2000 }).expect(201)).body;
  assert.equal(expireGifts(s.db, waiting.expires - 1), 0, "not before its time");
  assert.equal(s.gifts.expire(waiting.expires), 1);
  assert.equal(s.gifts.expire(waiting.expires + 1000), 0, "idempotent");
  assert.equal(ledgerOf(s, giver.user.id).at(-1).description, "Gift returned: unclaimed after 30 days");
  assert.equal(s.db.prepare("SELECT status FROM gifts WHERE id=?").get(waiting.id).status, "expired");
  assert.deepEqual((await peek(s.app, waiting.code).expect(200)).body, { status: "expired" });
  assert.equal((await claim(other, waiting.code).expect(410)).body.error.code, "gift_returned");
  // At its deadline a gift can't be claimed even before the worker runs.
  const t0 = now();
  const dueCode = newCode();
  s.db
    .prepare("INSERT INTO gifts(id,user_id,code_hash,amount,note,status,request_id,created,expires) VALUES(?,?,?,?,?,'open',?,?,?)")
    .run("gift_due", giver.user.id, codeHash(readCode(dueCode).symbols), 500 * UNIT, "", "due", t0 - GIFT_TTL, t0 - 1);
  s.db
    .prepare("INSERT INTO ledger(id,user_id,amount,kind,ref,description,created) VALUES(?,?,?,?,?,?,?)")
    .run(uid("l_"), giver.user.id, -500 * UNIT, "gift_out", "gift_due:out", "Gift created", t0 - GIFT_TTL);
  assert.equal((await peek(s.app, dueCode).expect(200)).body.status, "expired");
  assert.equal((await claim(other, dueCode).expect(410)).body.error.code, "gift_returned");
  // The worker returns it on its next round.
  await s.tick();
  assert.equal(s.db.prepare("SELECT status FROM gifts WHERE id='gift_due'").get().status, "expired");
  assert.equal(allLedger(s), before, "every credit is accounted for");
  assert.equal(units(s, giver.user.id), START - 1000 * UNIT, "only the claimed gift left");
  // Switched off again, the worker still returns what's open.
  const left = (await give(giver, { amount: 700 }).expect(201)).body;
  const off = fixture(t, "mvp", { dir: s.dir });
  assert.equal(off.gifts.expire(left.expires), 1);
  assert.equal(units(s, giver.user.id), START - 1000 * UNIT);
});

// ---- Privacy: hash-only storage, nothing logged ----

test("only a hash of the code is stored, and no code, link or hash reaches the logs", async (t) => {
  const s = fixture(t);
  const giver = await person(s.app, "hana");
  const taker = await person(s.app, "hugo");
  const lines = [];
  const streams = ["log", "info", "warn", "error", "debug"].map((k) => [k, console[k]]);
  for (const [k] of streams) console[k] = (...args) => lines.push(args.map(String).join(" "));
  const writes = [process.stdout.write, process.stderr.write];
  process.stdout.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return writes[0].call(this, chunk, ...rest);
  };
  process.stderr.write = function (chunk, ...rest) {
    lines.push(String(chunk));
    return writes[1].call(this, chunk, ...rest);
  };
  let made;
  try {
    made = (await give(giver, { amount: 1200, note: "logged? never" }).expect(201)).body;
    await peek(s.app, made.link).expect(200);
    await claim(giver, made.code).expect(400);
    const typo = made.code.slice(0, -1) + (made.code.endsWith("0") ? "1" : "0");
    await claim(taker, typo).expect(400);
    await claim(taker, newCode()).expect(404);
    await claim(taker, made.code).expect(200);
    await claim(taker, made.code).expect(410);
    // The code is read from the body only, never from the address.
    const q = await taker.agent.post("/api/gifts/claim?code=" + made.code).send({}).expect(400);
    assert.equal(q.body.error.code, "gift_code_invalid");
  } finally {
    for (const [k, fn] of streams) console[k] = fn;
    [process.stdout.write, process.stderr.write] = writes;
  }
  const symbols = readCode(made.code).symbols;
  for (const secret of [made.code, symbols, codeHash(symbols), made.link])
    assert.ok(!lines.some((l) => l.includes(secret)), "never logged");
  // Stored: the hash, never the code.
  const row = s.db.prepare("SELECT * FROM gifts WHERE id=?").get(made.id);
  assert.equal(row.code_hash, codeHash(symbols));
  assert.match(row.code_hash, /^[0-9a-f]{64}$/);
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const file = readFileSync(join(s.dir, "test.sqlite"));
  for (const secret of [made.code, symbols]) assert.equal(file.indexOf(secret), -1, "not in the database file");
  // The list and the export never carry a code or its hash.
  const list = JSON.stringify((await giver.agent.get("/api/gifts").expect(200)).body);
  const exported = JSON.stringify((await giver.agent.get("/api/account/export").expect(200)).body);
  for (const text of [list, exported]) {
    assert.ok(!text.includes(symbols) && !text.includes(made.code) && !text.includes(row.code_hash));
    assert.ok(!text.includes("code_hash"));
  }
});

// ---- Self-claim, rate limits and lockouts ----

test("the giver can't claim their own gift, and it costs them nothing to try", async (t) => {
  const s = fixture(t);
  const giver = await person(s.app, "ida");
  const gift = (await give(giver, { amount: 1000 }).expect(201)).body;
  const own = await claim(giver, gift.code).expect(400);
  assert.equal(own.body.error.code, "gift_own");
  assert.equal(units(s, giver.user.id), START - 1000 * UNIT);
  assert.equal(s.db.prepare("SELECT status FROM gifts WHERE id=?").get(gift.id).status, "open");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM gift_lockouts").get().n, 0, "not a wrong guess");
  // Signed out, claiming needs an account first.
  await request(s.app).post("/api/gifts/claim").send({ code: gift.code }).expect(401);
});

test("wrong codes lock out an account and an address; typos don't count; making gifts is rate limited", async (t) => {
  const s = fixture(t);
  const giver = await person(s.app, "jon");
  const guesser = await person(s.app, "jax");
  const friend = await person(s.app, "joy");
  const gift = (await give(giver, { amount: 1000 }).expect(201)).body;
  // Typos and malformed codes can't match anything, so they never count.
  const typo = gift.code.slice(0, -1) + (gift.code.endsWith("0") ? "1" : "0");
  for (let i = 0; i < 6; i++)
    assert.equal((await claim(guesser, i % 2 ? typo : "not-a-code").expect(400)).body.error.code, i % 2 ? "gift_code_typo" : "gift_code_invalid");
  // Wrong but well-formed codes do: past the limit, even the right code waits.
  for (let i = 0; i < ACCOUNT_FAILURES; i++) await claim(guesser, newCode()).expect(404);
  const locked = await claim(guesser, gift.code).expect(429);
  assert.equal(locked.body.error.code, "gift_locked");
  assert.ok(Number(locked.headers["retry-after"]) > 3000);
  assert.match(locked.body.error.message, /^Too many wrong gift codes\. Try again in \d+ min\.$/);
  // From another address the same account is still locked; another account
  // elsewhere is not.
  guesser.ip = address();
  assert.equal((await claim(guesser, gift.code).expect(429)).body.error.code, "gift_locked");
  await claim(friend, gift.code).expect(200);
  // Per address: wrong peeks from one address lock that address for peeks
  // and claims alike.
  const noisy = address();
  const second = (await give(giver, { amount: 1000 }).expect(201)).body;
  for (let i = 0; i < ADDRESS_FAILURES; i++) await peek(s.app, newCode(), noisy).expect(404);
  assert.equal((await peek(s.app, second.code, noisy).expect(429)).body.error.code, "gift_locked");
  const visitor = await person(s.app, "jin");
  visitor.ip = noisy;
  assert.equal((await claim(visitor, second.code).expect(429)).body.error.code, "gift_locked");
  await peek(s.app, second.code).expect(200);
  // The lockout table keeps no account id or address, and clears itself.
  const keys = s.db.prepare("SELECT key FROM gift_lockouts").all().map((r) => r.key);
  assert.ok(keys.length >= 2);
  for (const key of keys) {
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.ok(!key.includes(guesser.user.id) && !key.includes(noisy));
  }
  expireGifts(s.db, now() + 2 * 3600000);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM gift_lockouts").get().n, 0);
  // Making gifts: ten an hour per account.
  const maker = await person(s.app, "jude");
  for (let i = 0; i < 10; i++) await give(maker, { amount: 100 }).expect(201);
  assert.equal((await give(maker, { amount: 100 }).expect(429)).body.error.code, "rate_limit");
});

// ---- Referrals: gifts are not top-ups ----

test("gifts are not top-ups: no referral reward, no deposit", async (t) => {
  const s = fixture(t);
  const referrer = await person(s.app, "kira");
  const ref = (await referrer.agent.get("/api/referrals").expect(200)).body.code;
  const agent = request.agent(s.app);
  const referred = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", address())
    .send({ username: "kurt", password: "test-password-long", ref })
    .expect(201);
  assert.equal(s.db.prepare("SELECT referred_by FROM users WHERE id=?").get(referred.body.user.id).referred_by, referrer.user.id);
  const giver = await person(s.app, "kai");
  const gift = (await give(giver, { amount: 25_000 }).expect(201)).body;
  await agent.post("/api/gifts/claim").set("X-Forwarded-For", address()).send({ code: gift.code }).expect(200);
  await s.tick();
  assert.equal(
    s.db.prepare("SELECT COUNT(*) n FROM ledger WHERE user_id=? AND kind LIKE 'referral%'").get(referrer.user.id).n,
    0,
  );
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM deposits").get().n, 0);
});

// ---- Erase and export ----

test("the export lists your gifts; Panic Wipe and closure return unclaimed ones first, then erase the list", async (t) => {
  const s = fixture(t);
  const giver = await person(s.app, "lena");
  const taker = await person(s.app, "leo");
  const claimed = (await give(giver, { amount: 1000, note: "for Leo" }).expect(201)).body;
  await claim(taker, claimed.code).expect(200);
  const open = (await give(giver, { amount: 4000, note: "still waiting" }).expect(201)).body;
  const exported = (await giver.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.units.giftAmount, "credits");
  assert.deepEqual(
    exported.gifts.map(({ amount, note, status }) => ({ amount, note, status })),
    [
      { amount: 1000, note: "for Leo", status: "claimed" },
      { amount: 4000, note: "still waiting", status: "open" },
    ],
  );
  for (const g of exported.gifts) assert.deepEqual(Object.keys(g).sort(), ["amount", "claimed", "created", "expires", "id", "note", "returned", "status"]);
  // Panic Wipe: the open gift comes back to the balance, then the list goes.
  const before = allLedger(s);
  await giver.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.equal(units(s, giver.user.id), START - 1000 * UNIT, "only the claimed gift is gone");
  assert.equal(ledgerOf(s, giver.user.id).at(-1).description, "Gift cancelled: account content erased");
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM gifts WHERE user_id=?").get(giver.user.id).n, 0);
  assert.equal(allLedger(s), before);
  // Its link is dead, and the claimer's credits stay.
  assert.equal((await claim(taker, open.code).expect(404)).body.error.code, "gift_not_found");
  assert.equal(units(s, taker.user.id), START + 1000 * UNIT);
  // Closure: the same, then the balance is forfeited with the account.
  const closer = await person(s.app, "lou");
  const pending = (await give(closer, { amount: 2000 }).expect(201)).body;
  await closer.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM gifts WHERE user_id=?").get(closer.user.id).n, 0);
  assert.equal(units(s, closer.user.id), START, "returned before forfeiture");
  assert.equal(ledgerOf(s, closer.user.id).at(-1).kind, "gift_return");
  assert.equal((await claim(taker, pending.code).expect(404)).body.error.code, "gift_not_found");
  // Unreleased, an export still lists gifts that exist.
  const other = await person(s.app, "lyra");
  await give(other, { amount: 100 }).expect(201);
  const off = fixture(t, "mvp", { dir: s.dir });
  const agent = request.agent(off.app);
  await agent.post("/api/auth/password").send({ username: "lyra", password: "test-password-long" }).expect(200);
  assert.equal((await agent.get("/api/account/export").expect(200)).body.gifts.length, 1);
});

// ---- The screens ----

const uiDirs = [];
after(() => uiDirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));
async function pageModule(file) {
  const src = new URL("../src/" + file, import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-gifts-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub(
    "ui.mjs",
    `const el = (tag) => ({ children, className, to, onClick, disabled, secondary, ...rest }) => React.createElement(tag, { className, href: to }, children);
     export const Notice = el("div");
     export const Button = el("button");
     export const Icon = () => React.createElement("svg");
     export const Mark = () => React.createElement("span");
     export const Logo = () => React.createElement("a");
     export const CopyButton = ({ label }) => React.createElement("button", null, label || "Copy");`,
  );
  const router = stub("router.mjs", `export const Link = ({ children, to, className }) => React.createElement("a", { href: to, className }, children);`);
  const dom = stub("dom.mjs", `export const createPortal = (x) => x;`);
  const lang = stub("lang.mjs", `export const LanguageSwitch = () => null;`);
  const pages = stub("pages.mjs", `export const NotFound = () => React.createElement("p", null, "404");`);
  const context = stub("context.mjs", `export const useApp = () => ({ config: { releases: { features: { giftlinks: true } } }, user: null, loading: false, refresh() {} });`);
  const giftLinks = file === "GiftClaim.jsx" ? (await pageModule("GiftLinks.jsx")).url : null;
  const out = code
    .replace(/^import "\.\/gift-links\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "react-router-dom"/g, `from "${router}"`)
    .replace(/from "react-dom"/g, `from "${dom}"`)
    .replace(/from "\.\/LanguageSwitch\.jsx"/g, `from "${lang}"`)
    .replace(/from "\.\/Pages\.jsx"/g, `from "${pages}"`)
    .replace(/from "\.\/context\.jsx"/g, `from "${context}"`)
    .replace(/from "\.\/GiftLinks\.jsx"/g, `from "${giftLinks}"`)
    .replace(/from "\.\/(lib|qr|gift-links)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const target = join(dir, file.replace(".jsx", ".mjs"));
  writeFileSync(target, out);
  uiDirs.push(dir);
  const mod = await import(pathToFileURL(target).href);
  return { ...mod, url: pathToFileURL(target).href };
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
// Page text split by whether it sits inside data-i18n="off" (the giver's
// and the claimer's own words) or not (the page's, to be translated).
// Adjacent text nodes join, as the translator reads them.
function textsOf(html) {
  const VOID = new Set(["input", "br", "img", "hr", "path", "rect"]);
  const stack = [],
    page = [],
    kept = [];
  let run = "";
  const flush = () => {
    const t = entities(run).replace(/\s+/g, " ").trim();
    if (t) (stack.some((x) => x.off) ? kept : page).push(t);
    run = "";
  };
  for (const [, tag, text] of html.replace(/<!-- -->/g, "").matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      flush();
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(/(?:placeholder|aria-label|title)="([^"]*)"/g))
        (off || stack.some((x) => x.off) ? kept : page).push(entities(attr));
      if (m[1]) stack.pop();
      else if (!VOID.has(m[2].toLowerCase()) && !tag.endsWith("/>")) stack.push({ off });
    } else run += text;
  }
  flush();
  const words = (list) => list.filter((x) => /[A-Za-z]{2}/.test(x));
  return { page: words(page), kept: words(kept) };
}

test("both screens keep the giver's and claimer's words as written and translate the rest", async () => {
  const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
  const han = /\p{Script=Han}/u;
  const { GiftCard, GiftMade, GiftList, GiftLinks } = await pageModule("GiftLinks.jsx");
  const { ClaimView } = await pageModule("GiftClaim.jsx");
  const code = newCode();
  const link = giftLink("https://askanonyma.com", code);
  const day = Date.UTC(2026, 9, 27, 12);
  const gift = (status, extra = {}) => ({
    id: "gift_" + status,
    amount: 5000,
    note: "Happy birthday, Sam",
    status,
    created: day - GIFT_TTL,
    expires: day,
    claimed: status === "claimed" ? day - 5 : null,
    returned: ["revoked", "expired"].includes(status) ? day - 5 : null,
    ...extra,
  });
  const config = cfg({ giftlinks: true });
  const html = [
    renderToStaticMarkup(createElement(GiftLinks, { user: { id: "u1" }, demo: false, config })),
    renderToStaticMarkup(createElement(GiftLinks, { user: null, demo: true, config })),
    renderToStaticMarkup(createElement(GiftMade, { made: { ...gift("open"), code, link }, host: "askanonyma.com" })),
    renderToStaticMarkup(createElement(GiftCard, { amount: 25000, note: "", expires: day })),
    renderToStaticMarkup(createElement(GiftCard, { amount: 25000, note: "Welcome", claimed: true })),
    ...[null, []].map((gifts) => renderToStaticMarkup(createElement(GiftList, { gifts, busy: false, cancelling: null }))),
    renderToStaticMarkup(
      createElement(GiftList, {
        gifts: [gift("open"), gift("claimed", { id: "g2", note: "" }), gift("revoked"), gift("expired", { note: "Old note" })],
        busy: false,
        cancelling: "gift_open",
      }),
    ),
    ...[
      [{ status: "enter" }, null],
      [{ status: "loading" }, null],
      [{ status: "open", gift: { status: "open", amount: 5000, note: "Happy birthday, Sam", expires: day, own: false } }, null],
      [{ status: "open", gift: { status: "open", amount: 5000, note: "", expires: day, own: false } }, { id: "u2", username: "sam_42" }],
      [{ status: "open", claimError: "This gift has already been claimed.", gift: { status: "open", amount: 5000, note: "", expires: day, own: true } }, { id: "u1", username: "maya" }],
      [{ status: "done", gift: { status: "claimed", amount: 5000, note: "Happy birthday, Sam", available: 105000 } }, { id: "u2", username: "sam_42" }],
      ...["claimed", "cancelled", "expired", "returned", "missing"].map((status) => [{ status }, null]),
      [{ status: "error", message: "Too many wrong gift codes. Try again in 42 min." }, null],
    ].map(([state, user]) => renderToStaticMarkup(createElement(ClaimView, { config, user, state, busy: false }))),
  ].join("");
  const { page, kept } = textsOf(html);
  for (const text of ["Happy birthday, Sam", "Welcome", "Old note", code, link, "@sam_42"])
    assert.ok(kept.some((k) => k.includes(text)), "kept as written: " + text);
  // The brand name stays as written, as everywhere.
  for (const text of page.filter((x) => x !== "ANONYMA"))
    assert.match(translateText(text, zh) ?? "", han, "translated: " + text);
  for (const expected of ["Make gift link", "Your gifts", "Print card", "Claim 5,000 credits", "Create an account to claim", "5,000 credits are yours."])
    assert.ok(page.some((p) => p.includes(expected)), expected);
  // No names: the claim page shows neither side's account, apart from the
  // claimer's own "Signed in as".
  assert.ok(!html.includes("maya"));
  // Server messages the screens show, the release copy and Panic Wipe's line.
  const entry = UPDATES.find((u) => u.id === "giftlinks");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Gift Links is coming soon.",
    WIPE_GIFTS,
    "Gift from 100 to 250,000 whole credits.",
    "Not enough available credits for this gift.",
    "You already have 25 gifts waiting to be claimed. Cancel one, or wait for one to be claimed.",
    "Keep the note to 140 characters.",
    "That isn't a gift code. A code has 28 letters and numbers.",
    "That code has a typo. Check it and try again.",
    "No gift matches this code. Check it and try again.",
    "This is your own gift. Send the link to someone else, or cancel the gift to get the credits back.",
    "This gift is no longer available. Its credits went back to the person who sent it.",
    "This gift can't be claimed right now. Try again later.",
    "A credited payment is under reconciliation. Gifts are paused until it is confirmed.",
    "This gift was already made, and its link was shown only once. If you didn't keep it, cancel the gift to get the credits back.",
    "This gift was already claimed, so it can't be cancelled.",
    "Gift cancelled. 5,000 credits are back in your balance.",
    "Gift made",
    "Gift claimed",
    "Gift returned",
    "Gift returned: unclaimed after 30 days",
    "Gift cancelled: account content erased",
    "A gift is waiting. Sign in to claim it; you'll go straight back to it.",
    "A gift is waiting. Create an account to claim it; you'll go straight back to it.",
    "Gifts nobody has claimed yet are cancelled first: their links stop working and their credits are forfeited with the rest.",
    "Gift credits with a link",
    "Gift Links: each gift you make (its amount, note, dates and whether it was claimed or returned) and a fingerprint of its code, never the code itself. Who claimed a gift isn't kept with it and is never shown to you. Panic Wipe and closing your account cancel your unclaimed gifts, return their credits to your balance, then delete the list; the ledger keeps its entries.",
    "The export also lists the gifts you made: amount, note, dates and state. Codes aren't kept, so they can't be exported.",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
  // The glossary: credits are 积分, the ledger 账本.
  assert.match(translateText("Gift credits have no cash value and can't be refunded to cash.", zh), /积分/);
});
