import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { addCredit, balance, hash, now, reserve, settle } from "../server/core.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { authenticateAccessToken, ACCESS_PREFIX } from "../server/oauth.js";
import { knownPage } from "../src/site-routes.js";
import { openapiForConfig } from "../server/openapi.js";
import {
  WIPE_GOES,
  WIPE_STAYS,
  WIPE_WORD,
  WIPED_PATH,
  clearBrowserData,
  walletPaymentPending,
} from "../src/panic-wipe.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing whichever updates have shipped.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ORIGIN = "http://localhost:5175";
const PASSWORD = "long-fixture-password";
function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-wipe-"));
  const s = createApp({
    testMode: true,
    released: released ?? "all",
    origin: ORIGIN,
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
  });
  t.after(() => {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return s;
}
async function account(s, username) {
  const a = request.agent(s.app);
  const r = await a
    .post("/api/auth/register")
    .send({ username, password: PASSWORD })
    .expect(201);
  return { a, id: r.body.user.id, username };
}
// A second session for the same account, as on another device.
async function signIn(s, username) {
  const a = request.agent(s.app);
  await a.post("/api/auth/password").send({ username, password: PASSWORD }).expect(200);
  return a;
}
const wipe = (a, confirm = WIPE_WORD) =>
  a.post("/api/account/wipe").send({ confirm });
const count = (s, sql, ...args) => s.db.prepare(sql).get(...args).n;

// Everything the wipe removes, per table, for one account.
const GONE = {
  conversations: "SELECT COUNT(*) n FROM conversations WHERE user_id=? AND collab_id IS NULL",
  messages: "SELECT COUNT(*) n FROM messages WHERE conversation_id IN ('chat','sym','branch','check')",
  share_links: "SELECT COUNT(*) n FROM share_links WHERE user_id=?",
  // Sealed Share: a sealed copy of a saved chat, and of a Device-only chat.
  sealed_shares: "SELECT COUNT(*) n FROM sealed_shares WHERE user_id=?",
  device_sealed_shares: "SELECT COUNT(*) n FROM sealed_shares WHERE user_id=? AND conversation_id IS NULL",
  media: "SELECT COUNT(*) n FROM media WHERE user_id=?",
  library_items: "SELECT COUNT(*) n FROM library_items WHERE media_id IN ('asset_a','asset_b')",
  uploads: "SELECT COUNT(*) n FROM uploads WHERE user_id=?",
  videos: "SELECT COUNT(*) n FROM videos WHERE user_id=?",
  memory_facts: "SELECT COUNT(*) n FROM memory_facts WHERE user_id=?",
  scrolls: "SELECT COUNT(*) n FROM scrolls WHERE user_id=?",
  user_instructions: "SELECT COUNT(*) n FROM user_instructions WHERE user_id=?",
  tickets: "SELECT COUNT(*) n FROM tickets WHERE user_id=?",
  sessions: "SELECT COUNT(*) n FROM sessions WHERE user_id=?",
  challenges: "SELECT COUNT(*) n FROM challenges WHERE payload=?",
  owned_collabs: "SELECT COUNT(*) n FROM collabs WHERE owner_id=?",
  memberships: "SELECT COUNT(*) n FROM collab_members WHERE user_id=?",
  oauth_tokens: "SELECT COUNT(*) n FROM oauth_tokens WHERE connection_id IN (SELECT id FROM oauth_connections WHERE user_id=?)",
  oauth_codes: "SELECT COUNT(*) n FROM oauth_codes WHERE connection_id IN (SELECT id FROM oauth_connections WHERE user_id=?)",
  live_keys: "SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND revoked IS NULL",
  live_apps: "SELECT COUNT(*) n FROM oauth_connections WHERE user_id=? AND revoked IS NULL",
  routines: "SELECT COUNT(*) n FROM routines WHERE user_id=?",
  routine_runs: "SELECT COUNT(*) n FROM routine_runs WHERE user_id=?",
};
const tally = (s, id) =>
  Object.fromEntries(
    Object.entries(GONE).map(([k, sql]) => [
      k,
      count(s, sql, ...(sql.includes("?") ? [id] : [])),
    ]),
  );
// What must survive the wipe exactly as it was.
function kept(s, id) {
  const all = (sql) => s.db.prepare(sql).all(id);
  return {
    user: s.db
      .prepare("SELECT id,username,email,wallet,created,deleted,referral_code FROM users WHERE id=?")
      .get(id),
    balance: balance(s.db, id),
    ledger: all("SELECT * FROM ledger WHERE user_id=? ORDER BY rowid"),
    deposits: all("SELECT * FROM deposits WHERE user_id=? ORDER BY rowid"),
    holds: all("SELECT * FROM holds WHERE user_id=? ORDER BY rowid"),
    receipts: all("SELECT * FROM receipt_signatures WHERE user_id=? ORDER BY rowid"),
    limits: all("SELECT * FROM spending_limits WHERE user_id=?"),
    retention: all("SELECT * FROM retention_defaults WHERE user_id=?"),
    memorySwitch: all("SELECT * FROM memory_settings WHERE user_id=?"),
  };
}

// One account with something of every kind, plus a second account whose
// collab it belongs to.
async function seed(s) {
  const alice = await account(s, "alice"),
    bob = await account(s, "bob");
  const db = s.db,
    t = now(),
    run = (sql, ...args) => db.prepare(sql).run(...args);
  // A routine with one delivered run in its inbox.
  run(
    "INSERT INTO routines(id,user_id,name,prompt,model,repeat,minute,timezone,run_cap,monthly_budget,next_run,created,updated) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
    "rt_1", alice.id, "Morning news", "Five bullets on AI news", "test-model", "daily", 480, "UTC", 10000, 100000, t + 86400000, t, t,
  );
  run(
    "INSERT INTO routine_runs(id,routine_id,user_id,slot,started,finished,status,answer) VALUES(?,?,?,?,?,?,?,?)",
    "rr_1", "rt_1", alice.id, t, t, t, "done", "A routine answer",
  );
  // Conversations: a chat, a Symposium run, a branch and a Double-check,
  // each with a message; a share link on the chat.
  for (const [id, mode, extra] of [
    ["chat", "chat", {}],
    ["sym", "symposium", {}],
    ["branch", "chat", { parent_id: "chat" }],
    ["check", "symposium", { source_id: "chat" }],
  ]) {
    run(
      "INSERT INTO conversations(id,user_id,title,mode,created,updated,parent_id,source_id) VALUES(?,?,?,?,?,?,?,?)",
      id, alice.id, "Secret " + id, mode, t, t, extra.parent_id ?? null, extra.source_id ?? null,
    );
    run(
      "INSERT INTO messages(id,conversation_id,role,content,created) VALUES(?,?,'user',?,?)",
      "m_" + id, id, JSON.stringify({ text: "private " + id }), t,
    );
  }
  run(
    "INSERT INTO share_links(id,user_id,conversation_id,token,title,snapshot,message_count,created) VALUES('share_1',?,'chat','tok_share_1','Secret chat','[]',1,?)",
    alice.id, t,
  );
  run(
    "INSERT INTO sealed_shares(id,user_id,conversation_id,token,ciphertext,created) VALUES('share_2',?,'chat','tok_share_2',randomblob(64),?),('share_3',?,NULL,'tok_share_3',randomblob(64),?)",
    alice.id, t, alice.id, t,
  );
  // Saved media with its files on disk, one in the library with a recipe.
  const files = [];
  for (const [id, kind] of [["asset_a", "image"], ["asset_b", "audio"]]) {
    const filename = id + (kind === "image" ? ".png" : ".mp3");
    writeFileSync(join(s.cfg.mediaPath, filename), "bytes of " + id);
    files.push(join(s.cfg.mediaPath, filename));
    run(
      "INSERT INTO media(id,user_id,kind,mime,filename,prompt,model,cost,created) VALUES(?,?,?,?,?,?,?,0,?)",
      id, alice.id, kind, kind === "image" ? "image/png" : "audio/mpeg", filename, "a private prompt", "m", t,
    );
  }
  run("INSERT INTO library_items(media_id,had_source,recipe) VALUES('asset_a',0,'{\"prompt\":\"x\"}')");
  run(
    "INSERT INTO uploads(id,user_id,name,bytes,kind,mime,text,created,expires,content) VALUES('upload_1',?,'notes.txt',5,'text','text/plain','hello',?,?,?)",
    alice.id, t, t + 86400000, Buffer.from("hello"),
  );
  run(
    "INSERT INTO videos(id,user_id,hold_id,status,request,created,updated) VALUES('video_1',?,NULL,'done','{\"prompt\":\"secret\"}',?,?)",
    alice.id, t, t,
  );
  run(
    "INSERT INTO memory_facts(id,user_id,text,created,updated,source_conversation_id) VALUES('fact_1',?,'I live somewhere',?,?,'chat')",
    alice.id, t, t,
  );
  run("INSERT INTO memory_settings(user_id,enabled,updated) VALUES(?,1,?)", alice.id, t);
  run("INSERT INTO scrolls(id,user_id,title,body,created,updated) VALUES('scroll_1',?,'Mine','Body',?,?)", alice.id, t, t);
  run("INSERT INTO user_instructions(user_id,body,enabled,updated) VALUES(?,'Always',1,?)", alice.id, t);
  await alice.a
    .post("/api/support")
    .send({ subject: "Help", body: "private ticket", email: "alice@example.invalid" })
    .expect(201);
  run(
    "INSERT INTO challenges(id,target,purpose,hash,expires,payload) VALUES('ch_1','alice@example.invalid','link','h',?,?)",
    t + 600000, alice.id,
  );
  // Settings that stay.
  run("INSERT INTO spending_limits(user_id,daily_limit,updated) VALUES(?,50000,?)", alice.id, t);
  run("INSERT INTO retention_defaults(user_id,days) VALUES(?,7)", alice.id);
  // Money that stays: a deposit, a settled request with a signed receipt.
  run(
    "INSERT INTO deposits(id,user_id,amount,currency,status,payload,credited,created,updated) VALUES('dep_1',?,10000000,'usdg','finished','{}',1,?,?)",
    alice.id, t, t,
  );
  addCredit(db, alice.id, 10000000, "dep_1", "deposit", "Deposit");
  reserve(db, { id: "hold_1", user: alice.id, amount: 5000 });
  settle(db, "hold_1", 3000, "Model usage");
  run(
    "INSERT INTO receipt_signatures(receipt_id,user_id,key_id,payload,signature,created) VALUES('hold_1',?,'k','{}','sig',?)",
    alice.id, t,
  );
  // An API key and a connected app with live tokens.
  const key = (await alice.a.post("/api/keys").send({ name: "agent" }).expect(201)).body.key;
  run("INSERT INTO oauth_clients(id,name,redirect_uris,created) VALUES('client_1','App','[]',?)", t);
  run(
    "INSERT INTO api_keys(id,user_id,hash,name,created,allowance_total,connection_id) VALUES('key_app',?,NULL,'App',?,100000,'conn_1')",
    alice.id, t,
  );
  run(
    "INSERT INTO oauth_connections(id,user_id,client_id,key_id,name,client_name,redirect_uri,created,activated,expires) VALUES('conn_1',?,'client_1','key_app','App','App','http://127.0.0.1/cb',?,?,?)",
    alice.id, t, t, t + 86400000,
  );
  const access = ACCESS_PREFIX + "x".repeat(43);
  run("INSERT INTO oauth_tokens(hash,connection_id,kind,created,expires) VALUES(?,'conn_1','access',?,?)", hash(access), t, t + 3600000);
  run(
    "INSERT INTO oauth_codes(hash,connection_id,client_id,redirect_uri,code_challenge,expires) VALUES('code_1','conn_1','client_1','http://127.0.0.1/cb','c',?)",
    t + 60000,
  );
  // A collab Alice owns (Bob wrote in it), and Bob's collab where Alice wrote.
  run("INSERT INTO collabs(id,owner_id,name,created,updated) VALUES('mine',?,'Mine',?,?)", alice.id, t, t);
  run("INSERT INTO collabs(id,owner_id,name,created,updated) VALUES('theirs',?,'Theirs',?,?)", bob.id, t, t);
  for (const [c, u, role] of [
    ["mine", alice.id, "owner"],
    ["mine", bob.id, "member"],
    ["theirs", bob.id, "owner"],
    ["theirs", alice.id, "member"],
  ])
    run("INSERT INTO collab_members(collab_id,user_id,role,joined) VALUES(?,?,?,?)", c, u, role, t);
  for (const [id, c, u] of [["in_mine", "mine", bob.id], ["in_theirs", "theirs", alice.id]]) {
    run(
      "INSERT INTO conversations(id,user_id,title,mode,created,updated,collab_id) VALUES(?,?,'Shared','chat',?,?,?)",
      id, u, t, t, c,
    );
    run(
      "INSERT INTO messages(id,conversation_id,role,content,created,author_id) VALUES(?,?,'user','\"shared\"',?,?)",
      "m_" + id, id, t, u,
    );
  }
  return { alice, bob, key, access, files };
}

test("the update is registered and gates the route, the page and nothing else", async (t) => {
  const entry = UPDATES.find((u) => u.id === "wipe");
  assert.ok(entry, "wipe is registered in UPDATES");
  // Its release commit flips this; the gates below hold either way.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "Panic Wipe");
  assert.equal(entry.tagline, "Everything gone in one tap. Your credits stay.");
  assert.equal(entry.points.length, 3);
  for (const path of ["/api/account/wipe", "/API/Account/Wipe", "/api/account/wipe/"])
    assert.deepEqual(featuresFor({ path, method: "POST", body: {} }), ["wipe"], path);
  for (const path of ["/api/account", "/api/account/export", "/api/account/wiped"])
    assert.ok(!featuresFor({ path, method: "POST", body: {} }).includes("wipe"), path);
  assert.equal(knownPage(WIPED_PATH), false);
  assert.equal(knownPage(WIPED_PATH, { wipe: true }), true);
  // Listed in the API document only once it's live.
  assert.equal(openapiForConfig({ released: new Set() }).paths["/api/account/wipe"], undefined);
  assert.ok(openapiForConfig({ released: "all" }).paths["/api/account/wipe"].post);

  const s = fixture(t, "mvp");
  const alice = await account(s, "alice");
  const r = await wipe(alice.a).expect(403);
  assert.equal(r.body.error.code, "feature_unreleased");
  assert.equal(r.body.error.message, "Panic Wipe is coming soon.");
  assert.equal(count(s, GONE.sessions, alice.id), 1);
  const cfg = (await request(s.app).get("/api/config").expect(200)).body;
  assert.equal(cfg.releases.features.wipe, false);
  if (existsSync("dist/client/index.html")) {
    await request(s.app).get(WIPED_PATH).expect(404);
    await request(fixture(t).app).get(WIPED_PATH).expect(200);
  }
});

test("a wipe erases everything listed, files included, and keeps the money", async (t) => {
  const s = fixture(t);
  const { alice, bob, key, access, files } = await seed(s);
  const otherDevice = await signIn(s, "alice");
  const before = kept(s, alice.id);
  const bobBefore = kept(s, bob.id);
  // Everything is there to begin with.
  const seeded = tally(s, alice.id);
  for (const [k, n] of Object.entries(seeded)) assert.ok(n > 0, `seeded ${k}`);
  assert.ok(files.every((f) => existsSync(f)));
  await request(s.app).get("/v1/models").set("Authorization", "Bearer " + key).expect(200);
  assert.ok(authenticateAccessToken(s.db, access));

  // One clear confirmation is required.
  await alice.a.post("/api/account/wipe").send({}).expect(400);
  for (const confirm of [null, "", "wipe", " WIPE", "DELETE"]) {
    const r = await wipe(alice.a, confirm).expect(400);
    assert.equal(r.body.error.code, "confirmation_required");
  }
  assert.deepEqual(tally(s, alice.id), seeded);

  const r = await wipe(alice.a).expect(200);
  assert.deepEqual(r.body, { ok: true });
  assert.match(String(r.headers["set-cookie"]), /anonyma_session=;/);

  // Everything listed is gone, files included.
  for (const [k, n] of Object.entries(tally(s, alice.id))) assert.equal(n, 0, k);
  // Deleted text is overwritten in the database file, not left in free pages.
  assert.equal(s.db.prepare("PRAGMA secure_delete").get().secure_delete, 0, "restored");
  s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  const file = readFileSync(s.cfg.dbPath);
  for (const secret of ["private chat", "private sym", "I live somewhere", "private ticket"])
    assert.equal(file.indexOf(secret), -1, secret);
  assert.ok(files.every((f) => !existsSync(f)), "media files removed from disk");
  // Every session is dead: this one and the other device.
  for (const a of [alice.a, otherDevice]) {
    await a.get("/api/account/ledger").expect(401);
    assert.equal((await a.get("/api/me").expect(200)).body.user ?? null, null);
  }
  // Keys and connected apps are revoked, not deleted: the ledger still names them.
  await request(s.app).get("/v1/models").set("Authorization", "Bearer " + key).expect(401);
  assert.equal(authenticateAccessToken(s.db, access), null);
  assert.equal(count(s, "SELECT COUNT(*) n FROM api_keys WHERE user_id=? AND revoked IS NOT NULL", alice.id), 2);
  assert.equal(count(s, "SELECT COUNT(*) n FROM oauth_connections WHERE user_id=? AND revoked IS NOT NULL", alice.id), 1);
  // The account, balance, ledger, deposits, request records, receipts and
  // settings are exactly as they were.
  assert.deepEqual(kept(s, alice.id), before);
  assert.equal(before.ledger.length, 3);
  // Bob keeps his account and his collab, with what Alice wrote in it; the
  // collab Alice owned went, with Bob's message in it, as closure does.
  assert.deepEqual(kept(s, bob.id), bobBefore);
  assert.equal(count(s, "SELECT COUNT(*) n FROM messages WHERE id='m_in_theirs' AND author_id=?", alice.id), 1);
  assert.equal(count(s, "SELECT COUNT(*) n FROM collabs WHERE id='theirs'"), 1);
  assert.equal(count(s, "SELECT COUNT(*) n FROM messages WHERE id='m_in_mine'"), 0);
  // Bob's own session is untouched.
  await bob.a.get("/api/account/ledger").expect(200);

  // Alice can sign in again to an empty account with her credits.
  const again = await signIn(s, "alice");
  const me = (await again.get("/api/me").expect(200)).body.user;
  assert.equal(me.id, alice.id);
  assert.equal((await again.get("/api/conversations").expect(200)).body.data.length, 0);
  assert.equal((await again.get("/api/media").expect(200)).body.data.length, 0);
});

test("requests in flight refuse the wipe, and nothing changes", async (t) => {
  const s = fixture(t);
  const { alice } = await seed(s);
  const seeded = tally(s, alice.id);
  const before = kept(s, alice.id);
  // A request reserved on her own balance.
  reserve(s.db, { id: "hold_busy", user: alice.id, amount: 1000 });
  let r = await wipe(alice.a).expect(409);
  assert.equal(r.body.error.code, "requests_in_flight");
  assert.deepEqual(tally(s, alice.id), seeded);
  s.db.prepare("UPDATE holds SET status='released' WHERE id='hold_busy'").run();
  // A team-paid request she started on someone else's treasury.
  const t0 = now();
  s.db.prepare("INSERT INTO users(id,created,deleted) VALUES('treasury_x',?,?)").run(t0, t0);
  s.db.prepare("INSERT INTO treasury_accounts(collab_id,account_user_id,created) VALUES('theirs','treasury_x',?)").run(t0);
  addCredit(s.db, "treasury_x", 100000, "fund_x", "treasury_deposit", "Fund");
  reserve(s.db, { id: "hold_team", user: "treasury_x", amount: 1000 });
  s.db.prepare("INSERT INTO treasury_spends(hold_id,collab_id,user_id,created) VALUES('hold_team','theirs',?,?)").run(alice.id, t0);
  r = await wipe(alice.a).expect(409);
  assert.equal(r.body.error.code, "requests_in_flight");
  assert.deepEqual(tally(s, alice.id), seeded);
  s.db.prepare("UPDATE holds SET status='released' WHERE id='hold_team'").run();
  // A collab she owns still has credits in its treasury: the closure rule.
  s.db.prepare("INSERT INTO users(id,created,deleted) VALUES('treasury_m',?,?)").run(t0, t0);
  s.db.prepare("INSERT INTO treasury_accounts(collab_id,account_user_id,created) VALUES('mine','treasury_m',?)").run(t0);
  addCredit(s.db, "treasury_m", 20000, "fund_m", "treasury_deposit", "Fund");
  r = await wipe(alice.a).expect(409);
  assert.equal(r.body.error.code, "treasury_not_empty");
  assert.equal(
    r.body.error.message,
    "A collab you own still has 2 credits in its team treasury. Withdraw or spend them before wiping your account.",
  );
  assert.deepEqual(tally(s, alice.id), seeded);
  assert.deepEqual(kept(s, alice.id), {
    ...before,
    holds: kept(s, alice.id).holds,
  });
  // Emptied, the wipe goes ahead.
  s.db
    .prepare("INSERT INTO ledger(id,user_id,amount,kind,ref,created) VALUES('l_out','treasury_m',-20000,'treasury_withdrawal','out_m',?)")
    .run(t0);
  await wipe(alice.a).expect(200);
  for (const [k, n] of Object.entries(tally(s, alice.id))) assert.equal(n, 0, k);
});

test("running it twice is safe, and a failed file removal can be retried", async (t) => {
  const s = fixture(t);
  const { alice, files } = await seed(s);
  const before = kept(s, alice.id);
  // A file that can't be removed stops the wipe before anything changes.
  const stuck = join(s.cfg.mediaPath, "asset_stuck.png");
  mkdirSync(stuck);
  writeFileSync(join(stuck, "inside"), "x");
  s.db
    .prepare("INSERT INTO media(id,user_id,kind,mime,filename,prompt,model,cost,created) VALUES('asset_stuck',?,'image','image/png','asset_stuck.png','','m',0,?)")
    .run(alice.id, now());
  const seeded = tally(s, alice.id);
  const r = await wipe(alice.a).expect(503);
  assert.equal(r.body.error.code, "media_delete_failed");
  const after = tally(s, alice.id);
  assert.deepEqual(after, seeded, "no rows changed");
  await alice.a.get("/api/account/ledger").expect(200);
  // Retried once the file can go: files already removed are skipped.
  rmSync(stuck, { recursive: true });
  await wipe(alice.a).expect(200);
  for (const [k, n] of Object.entries(tally(s, alice.id))) assert.equal(n, 0, k);
  assert.ok(files.every((f) => !existsSync(f)));
  const revoked = s.db
    .prepare("SELECT id,revoked FROM api_keys WHERE user_id=? ORDER BY id")
    .all(alice.id);
  // The same browser retrying after success is simply signed out.
  await wipe(alice.a).expect(401);
  // Signed in again, a second wipe succeeds and changes nothing that stays.
  const again = await signIn(s, "alice");
  await wipe(again).expect(200);
  for (const [k, n] of Object.entries(tally(s, alice.id))) assert.equal(n, 0, k);
  assert.deepEqual(kept(s, alice.id), before);
  assert.deepEqual(
    s.db.prepare("SELECT id,revoked FROM api_keys WHERE user_id=? ORDER BY id").all(alice.id),
    revoked,
    "revocation times are kept, not rewritten",
  );
  // Account closure, which shares the erasure, still works afterwards.
  const last = await signIn(s, "alice");
  await last.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.ok(s.db.prepare("SELECT deleted FROM users WHERE id=?").get(alice.id).deleted);
});

test("the browser side clears every store but the language, and waits for wallet payments", async () => {
  const store = (entries) => {
    const m = new Map(Object.entries(entries));
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      clear: () => m.clear(),
      keys: () => [...m.keys()],
    };
  };
  const local = store({
    "anonyma.lang": "zh",
    "anonyma:veil:words": "[\"secret\"]",
    "anonyma:walletPending:u_1": "[\"0xabc\"]",
    "anonyma-motion": "reduce",
  });
  const session = store({ "anonyma.receipt.prefill": "{}" });
  assert.equal(walletPaymentPending(local, "u_1"), true);
  assert.equal(walletPaymentPending(local, "u_2"), false);
  assert.equal(walletPaymentPending(store({ "anonyma:walletPending:u_1": "[]" }), "u_1"), false);
  assert.equal(walletPaymentPending(store({ "anonyma:walletPending:u_1": "{" }), "u_1"), false);
  const deleted = [],
    cachesLeft = new Set(["anonyma-shell-v3", "anonyma-assets-v3"]),
    unregistered = [];
  const idb = {
    databases: async () => [{ name: "one" }, { name: "two" }, {}],
    deleteDatabase(name) {
      deleted.push(name);
      const r = {};
      setTimeout(() => r.onsuccess?.());
      return r;
    },
  };
  const cacheStorage = {
    keys: async () => [...cachesLeft],
    delete: async (n) => cachesLeft.delete(n),
  };
  const serviceWorker = {
    getRegistrations: async () => [{ unregister: async () => unregistered.push(1) }],
  };
  await clearBrowserData({ local, session, idb, cacheStorage, serviceWorker });
  assert.deepEqual(local.keys(), ["anonyma.lang"]);
  assert.equal(local.getItem("anonyma.lang"), "zh");
  assert.deepEqual(session.keys(), []);
  assert.deepEqual(deleted, ["one", "two"]);
  assert.equal(cachesLeft.size, 0);
  assert.equal(unregistered.length, 1);
  // A browser without IndexedDB listing, caches or service workers, or
  // with storage that throws, still gets whatever it can cleared.
  const throwing = {
    getItem() {
      throw Error("blocked");
    },
    setItem() {
      throw Error("blocked");
    },
    clear() {
      throw Error("blocked");
    },
  };
  await clearBrowserData({ local: throwing, session: throwing, idb: {}, cacheStorage: undefined, serviceWorker: undefined });
});

test("every visible string has Chinese, and the dialog says what goes and what stays", () => {
  const dict = JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"));
  const han = /\p{Script=Han}/u;
  const entry = UPDATES.find((u) => u.id === "wipe");
  const source = ["../src/PanicWipe.jsx", "../src/Wiped.jsx"]
    .map((p) => readFileSync(new URL(p, import.meta.url), "utf8"))
    .join("\n");
  // Rendered by the dialog and the Wiped page, as written in their source.
  const rendered = [
    "Wipe everything now.",
    "Erase your chats, files, memory and keys in one step, and sign out everywhere. Your credits stay.",
    "Wipe everything now",
    "Wipe everything now?",
    "This can’t be undone. If you want a copy, export your data first.",
    "What goes",
    "What stays",
    "Read the data-controls guide.",
    "A wallet payment from this browser is still being confirmed. Wait until it’s credited, then wipe.",
    "Type WIPE to confirm",
    "Wiping…",
    "Cancel",
    "PANIC WIPE",
    "Wiped.",
    "Everything your account stored is gone, and every device is signed out. This browser is cleared too.",
    "Still here",
    "A wipe can’t reach copies outside your account: exports you downloaded, data already sent to AI providers, and server backups.",
    "Sign in again",
    "Back to ANONYMA",
    "Loading…",
  ];
  // The server's refusals the dialog shows, and the page's tab title.
  const other = [
    "Type WIPE to confirm the wipe.",
    "Wait for your requests in progress to finish, then wipe again.",
    "wiped — ANONYMA",
  ];
  const visible = [
    entry.title,
    entry.tagline,
    ...entry.points,
    ...WIPE_GOES,
    ...WIPE_STAYS,
    ...rendered,
    ...other,
  ];
  for (const en of visible) assert.match(dict.strings[en] || "", han, en);
  for (const n of ["credit", "credits"])
    assert.ok(
      dict.patterns.some(
        (p) => p.en === `A collab you own still has {0} ${n} in its team treasury. Withdraw or spend them before wiping your account.`,
      ),
      n,
    );
  // JSX wraps long lines; the translator normalises whitespace, so compare
  // normalised text.
  const flat = source.replace(/\s+/g, " ");
  for (const en of rendered) assert.ok(flat.includes(en), `rendered: ${en}`);
  // Plain words for what the server does.
  const goes = WIPE_GOES.join(" ");
  for (const word of ["chats", "Symposium", "branches", "share links", "files", "uploads", "Memory", "Scrolls", "standing instructions", "API keys", "connected apps", "revoked", "Every sign-in", "this browser", "Collabs you own", "drafts"])
    assert.ok(goes.includes(word), word);
  const stays = WIPE_STAYS.join(" ");
  for (const word of ["every credit", "ledger", "deposits", "receipts", "other people’s collabs", "data-controls guide"])
    assert.ok(stays.includes(word), word);
});
