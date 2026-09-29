import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.js";
import { now, uid } from "../server/core.js";
import { UPDATES } from "../server/releases.js";
import { openapi, openapiForConfig } from "../server/openapi.js";
import { rankTools } from "../src/tool-search.js";
import { clearBrowserData } from "../src/panic-wipe.js";
import { vaultDbNames } from "../src/device-vault-store.js";
import { PUSH_EVENTS, EVENT_UPDATES, PUSH_KINDS, PUSH_LANGS, pushPayload } from "../src/push-alerts.js";

// Batch 8 integration: the ten updates and the Meeting Notes fix together.
// One erase for everything (Panic Wipe, Inactivity Wipe and account
// closure), and the cross-feature rules: Auto Model, Model Status, the tool
// directory, Push Alerts for Research Watch and the API contract.

const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ORIGIN = "http://localhost:5175";
const PASSWORD = "test-password-long";
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 8, 29, 9, 0, 0);
const BATCH8 = ["phototools", "pushalerts", "recovery", "filesearch", "reporeader", "quotecards", "es", "decoy", "researchwatch", "chatimport"];
const source = (path) => readFileSync(new URL("../" + path, import.meta.url), "utf8");

function fixture(t, released, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-batch8-"));
  const svc = createApp({
    testMode: true,
    released: released ?? "all",
    origin: ORIGIN,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    ...extra,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
let visitor = 0;
async function person(svc, username) {
  const agent = request.agent(svc.app);
  const r = await agent
    .post("/api/auth/register")
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: PASSWORD })
    .expect(201);
  return { agent, id: r.body.user.id, username };
}
const count = (svc, sql, ...args) => svc.db.prepare(sql).get(...args).n;

// One of every server-side thing batch 8 keeps for an account.
async function seed(svc, p) {
  const db = svc.db,
    t = now(),
    run = (sql, ...args) => db.prepare(sql).run(...args);
  // Push Alerts: a browser, its switches and a notification waiting.
  const sub = uid("ps_");
  run(
    "INSERT INTO push_subscriptions(id,user_id,endpoint,p256dh,auth,service,lang,key_id,created) VALUES(?,?,?,?,?,?,?,?,?)",
    sub, p.id, "https://fcm.googleapis.com/fcm/send/" + p.id, "B" + "A".repeat(86), "A".repeat(22), "google", "en", "0123456789abcdef", t,
  );
  run("INSERT INTO push_settings(user_id,updated) VALUES(?,?)", p.id, t);
  run(
    "INSERT INTO push_queue(id,subscription_id,user_id,kind,created,attempts,next_try) VALUES(?,?,?,?,?,0,?)",
    uid("pq_"), sub, p.id, "routine", t, t + DAY,
  );
  // Recovery Kit: a kit of ten (digests only) and the dismissed nudge.
  run("INSERT INTO recovery_kits(user_id,salt,created) VALUES(?,?,?)", p.id, "s".repeat(32), t);
  for (let slot = 1; slot <= 10; slot++)
    run("INSERT INTO recovery_kit_codes(user_id,slot,digest) VALUES(?,?,?)", p.id, slot, "d".repeat(128));
  run("INSERT INTO recovery_nudges(user_id,dismissed) VALUES(?,?)", p.id, t);
  // File Search: a saved file, indexed.
  await p.agent
    .post("/api/files")
    .send({ filename: "Lease.md", data: Buffer.from("# Lease\n\nThe tenant gives 60 days written notice.\n").toString("base64"), consent: true })
    .expect(201);
  await p.agent.get("/api/file-search/files").expect(200);
  // Research Watch: a watch and one delivered briefing.
  const watch = uid("routine_");
  run(
    `INSERT INTO routines(id,user_id,name,prompt,model,web_search,repeat,minute,timezone,run_cap,monthly_budget,enabled,next_run,created,updated,kind,depth,new_only,next_due)
     VALUES(?,?,?,?,?,1,'daily',480,'UTC',?,?,0,NULL,?,?,'research','quick',0,NULL)`,
    watch, p.id, "Watch", "EU AI Act enforcement", "google/gemini-2.5-flash", 1_000_000, 50_000_000, t, t,
  );
  run(
    "INSERT INTO routine_runs(id,routine_id,user_id,slot,started,finished,status,kind,answer,research) VALUES(?,?,?,?,?,?,?,?,?,?)",
    uid("run_"), watch, p.id, t, t, t, "done", "research", "# Briefing", JSON.stringify({ depth: "quick", steps: [] }),
  );
  // Chat Import: one ChatGPT chat saved to the account.
  await p.agent
    .post("/api/import/chats")
    .send({
      source: "chatgpt",
      chats: [
        {
          source_id: "src-1",
          title: "Imported chat",
          created: Date.UTC(2024, 0, 1),
          updated: Date.UTC(2024, 0, 2),
          messages: [
            { role: "user", text: "question", created: Date.UTC(2024, 0, 1, 9) },
            { role: "assistant", text: "answer", created: Date.UTC(2024, 0, 1, 9, 1) },
          ],
        },
      ],
    })
    .expect(200);
  // Repo Reader: a repo open in the in-memory cache.
  svc.repoReader.cache.put(p.id, {
    key: "octo/demo@main",
    repo: "octo/demo",
    ref: "main",
    commit: "0".repeat(40),
    index: { files: [{ path: "index.js" }] },
    bytes: 1000,
  });
}
// What of it is still there, by feature.
function left(svc, id) {
  return {
    push:
      count(svc, "SELECT COUNT(*) n FROM push_subscriptions WHERE user_id=?", id) +
      count(svc, "SELECT COUNT(*) n FROM push_settings WHERE user_id=?", id) +
      count(svc, "SELECT COUNT(*) n FROM push_queue WHERE user_id=?", id),
    recoveryCodes: count(svc, "SELECT COUNT(*) n FROM recovery_kit_codes WHERE user_id=?", id),
    recoveryKit: count(svc, "SELECT COUNT(*) n FROM recovery_kits WHERE user_id=?", id),
    fileIndex:
      count(svc, "SELECT COUNT(*) n FROM file_chunks WHERE user_id=?", id) +
      count(svc, "SELECT COUNT(*) n FROM file_index WHERE user_id=?", id),
    watches:
      count(svc, "SELECT COUNT(*) n FROM routines WHERE user_id=? AND kind='research'", id) +
      count(svc, "SELECT COUNT(*) n FROM routine_runs WHERE user_id=? AND kind='research'", id),
    imported:
      count(svc, "SELECT COUNT(*) n FROM chat_imports WHERE user_id=?", id) +
      count(svc, "SELECT COUNT(*) n FROM conversations WHERE user_id=?", id),
    repos: svc.repoReader.cache.list(id).length,
  };
}
const SEEDED = { push: 3, recoveryCodes: 10, recoveryKit: 1, fileIndex: 2, watches: 2, imported: 2, repos: 1 };
const erased = (kit) => ({ push: 0, recoveryCodes: kit ? 10 : 0, recoveryKit: kit ? 1 : 0, fileIndex: 0, watches: 0, imported: 0, repos: 0 });

test("one erase for everything: Panic Wipe, Inactivity Wipe and closure remove batch 8's data; only the kit outlives a wipe", async (t) => {
  const svc = fixture(t);
  await svc.stopWork();
  let at = T0;
  t.mock.method(Date, "now", () => at);
  const panic = await person(svc, "petra");
  const idle = await person(svc, "ivan");
  const closing = await person(svc, "cleo");
  for (const p of [panic, idle, closing]) await seed(svc, p);
  for (const p of [panic, idle, closing]) {
    const l = left(svc, p.id);
    assert.ok(l.fileIndex >= 2, "the file is indexed");
    assert.deepEqual({ ...l, fileIndex: 2 }, SEEDED);
  }

  // The account export has each server-side item.
  const exported = (await panic.agent.get("/api/account/export").expect(200)).body;
  assert.equal(exported.pushAlerts.devices.length, 1);
  assert.equal(exported.pushAlerts.devices[0].pushService, "fcm.googleapis.com");
  assert.ok(!JSON.stringify(exported.pushAlerts).includes(panic.id), "the endpoint is cut to its host");
  assert.equal(exported.pushAlerts.events.research, true);
  assert.deepEqual([exported.recoveryKit.total, exported.recoveryKit.unused], [10, 10]);
  assert.ok(!JSON.stringify(exported).includes("d".repeat(128)), "never a code's digest");
  assert.equal(exported.fileSearch.indexedFiles.length, 1);
  assert.match(JSON.stringify(exported.fileSearch.indexedFiles[0].passages), /60 days written notice/);
  assert.ok(exported.routines.routines.some((r) => r.kind === "research"));
  assert.ok(exported.routines.runs.some((r) => r.kind === "research"));
  assert.ok(exported.conversations.some((c) => c.imported_from?.source === "chatgpt"));
  assert.deepEqual(exported.repoReader.map((r) => r.repo), ["octo/demo"]);

  // Panic Wipe: everything but the kit, a way back in like the password.
  await panic.agent.post("/api/account/wipe").send({ confirm: "WIPE" }).expect(200);
  assert.deepEqual(left(svc, panic.id), erased(true));
  // Closure: the kit too.
  await closing.agent.delete("/api/account").send({ confirm: "DELETE" }).expect(200);
  assert.deepEqual(left(svc, closing.id), erased(false));
  // The others' data is untouched so far.
  assert.deepEqual({ ...left(svc, idle.id), fileIndex: 2 }, SEEDED);

  // Inactivity Wipe: the worker's erase, past the deadline, as Panic Wipe.
  await idle.agent.put("/api/inactivity-wipe").send({ days: 30, confirm: true }).expect(200);
  const row = svc.db.prepare("SELECT * FROM inactivity_wipe WHERE user_id=?").get(idle.id);
  at = row.last_active + 32 * DAY;
  svc.db
    .prepare("INSERT INTO inactivity_clock(id,last_sweep) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET last_sweep=excluded.last_sweep")
    .run(at - 60_000);
  assert.equal((await svc.inactivity.sweep(at)).erased, 1);
  assert.deepEqual(left(svc, idle.id), erased(true));

  // Decoy and vault data are client-side: Panic Wipe's browser step deletes
  // the real vault, its sync copy and the decoy even where the browser can't
  // list its databases.
  const names = vaultDbNames(panic.id);
  assert.equal(names.length, 3);
  const gone = [];
  const idb = {
    deleteDatabase(name) {
      gone.push(name);
      const r = {};
      queueMicrotask(() => r.onsuccess?.());
      return r;
    },
  };
  await clearBrowserData({ local: null, session: null, idb, cacheStorage: null, serviceWorker: null, names });
  assert.deepEqual(gone.sort(), [...names].sort());
  assert.match(source("src/PanicWipe.jsx"), /clearBrowserData\(\{ names: user\?\.id \? vaultDbNames\(user\.id\) : \[\] \}\)/);
});

test("Push Alerts knows Research Watch: a content-free research_report, its own switch, in English, Chinese and Spanish", async (t) => {
  assert.ok(PUSH_EVENTS.includes("research"));
  assert.deepEqual(EVENT_UPDATES.research, ["researchwatch", "routines", "deepresearch", "search"]);
  assert.equal(PUSH_KINDS.research_report.event, "research");
  assert.deepEqual(PUSH_LANGS, ["en", "zh", "es"]);
  const zh = JSON.parse(source("src/i18n/zh.json")).strings;
  const es = JSON.parse(source("src/i18n/es.json")).strings;
  const en = PUSH_KINDS.research_report.body;
  assert.equal(pushPayload("research_report", "en").body, en);
  assert.equal(pushPayload("research_report", "zh").body, zh[en]);
  assert.equal(pushPayload("research_report", "es").body, es[en]);
  for (const lang of PUSH_LANGS) assert.equal(pushPayload("research_report", lang).url, "/workspace/routines");
  // The server's adapter queues it for the account's browsers; the routine
  // runner sends a watch's briefing as research_report, never as a routine.
  assert.match(source("server/app.js"), /ctx\.pushAlerts = \{ notify: \(\{ user, kind \}\) => ctx\.push\.notify\(user, kind\) \};/);
  assert.match(source("server/routines.js"), /if \(status === "done" && claimed\.routine\.kind !== "research"\)\s+ctx\.push\?\.notify\(claimed\.routine\.user_id, "routine"\);/);
  // Page Watch, Routines, low balance, gifts and the Inactivity reminder stay wired.
  assert.match(source("server/page-watch.js"), /ctx\.push\?\.notify\(row\.user_id, "pagewatch"\)/);
  assert.match(source("server/routes/gifts.js"), /ctx\.push\?\.notify\(outcome\.user_id, "gift_claimed"\)/);
  assert.match(source("server/routes/gifts.js"), /"gift_returned"/);
  assert.match(source("server/push-alerts.js"), /notify\(r\.user_id, "lowbalance"\)/);
  assert.match(source("server/push-alerts.js"), /notify\(r\.user_id, "inactivity", \{ at \}\)/);
  assert.match(source("server/worker.js"), /ctx\.push\?\.tick\(\);/);
  // A browser subscribed in Spanish is accepted.
  const svc = fixture(t);
  assert.equal(svc.db.prepare("SELECT sql FROM sqlite_master WHERE name='push_subscriptions'").get().sql.includes("'es'"), true);
});

test("saved File Search answers offer neither Regenerate nor Double-check this", () => {
  const ws = source("src/Workspace.jsx");
  const check = ws.slice(ws.indexOf("{doubleCheckLive &&"), ws.indexOf("Double-check this\n"));
  assert.match(check, /!m\.factcheck &&[\s\S]*!m\.filesearch &&/);
  assert.match(ws, /branchesLive && m\.content && !m\.research && !m\.blind && !m\.filesearch/);
});

test("Auto Model: the new feature pages offer no Auto, and their servers refuse an auto field", async (t) => {
  for (const page of ["PhotoTools", "FileSearch", "RepoReader", "ResearchWatch", "ChatImport"]) {
    const code = source(`src/${page}.jsx`);
    assert.doesNotMatch(code, /auto-model/, page);
  }
  const svc = fixture(t);
  const p = await person(svc, "auto");
  for (const path of ["/api/photo-tools/quote", "/api/photo-tools/run"]) {
    const res = await p.agent.post(path).send({ tool: "background", model: "any", auto: {} }).expect(400);
    assert.equal(res.body.error.code, "auto_not_offered", path);
  }
  const fs = await p.agent.post("/api/file-search/quote").send({ model: "any", question: "q", passages: [], auto: {} }).expect(400);
  assert.equal(fs.body.error.code, "invalid_request");
  // Repo Reader asks through /api/chat, which refuses auto beside a repo.
  assert.match(source("server/repo-reader.js"), /const REFUSED = \[\n  "auto",/);
});

test("Model Status: every new model-calling route is instrumented", () => {
  assert.match(source("server/routes/photo-tools.js"), /ctx\.modelStatus\.timed\(/);
  assert.match(source("server/routes/file-search.js"), /ctx\.modelStatus\.start\(m\.id\)/);
  // Research Watch's steps and Deep Research share researchCaller.
  assert.match(source("server/research-watch.js"), /researchCaller\(ctx, \{ m, isPrivate, controller \}\)/);
  assert.match(source("server/research.js"), /const probe = ctx\.modelStatus\.start\(m\.id\);/);
  // Repo Reader's questions run in runChat, which is instrumented.
  assert.match(source("server/routes/chat.js"), /prepareRepoRequest/);
  assert.match(source("server/routes/chat.js"), /const probe = ctx\.modelStatus\.start\(m\.id\);/);
});

test("the tool directory finds the new tools by intent, in English and Chinese", () => {
  const ws = source("src/Workspace.jsx");
  const entries = [...ws.matchAll(/^\s+\["(\w+)", "([^"]+)", "([^"]+)"\],$/gm)].map((m) => [m[1], m[2], m[3]]);
  const nav = entries.slice(entries.findIndex((e) => e[0] === "home"), entries.findIndex((e) => e[0] === "library") + 1);
  const first = (q) => rankTools(nav, q)[0]?.[0];
  for (const [q, id] of [
    ["remove background", "photos"],
    ["upscale my photo", "photos"],
    ["抠图", "photos"],
    ["search my files", "filesearch"],
    ["搜索文件", "filesearch"],
    ["explain this github repo", "repos"],
    ["仓库", "repos"],
    ["import my chatgpt history", "import"],
    ["导入聊天记录", "import"],
    ["research watch", "routines"],
    ["weekly briefing", "routines"],
    ["研究简报", "routines"],
  ])
    assert.equal(first(q), id, q);
  const tags = source("src/tool-search.js");
  for (const id of ["photos", "filesearch", "repos", "import"]) assert.match(tags, new RegExp(`^  ${id}: '[^']*\\p{Script=Han}`, "mu"), id);
});

test("the API contract documents every new route, lists them only once released, and has no garbled text", () => {
  const files = ["photo-tools", "push-alerts", "recovery-kit", "file-search", "repo-reader", "research-watch", "chat-import"];
  let seen = 0;
  for (const file of files.map((f) => `server/routes/${f}.js`))
    for (const [, method, path] of source(file).matchAll(/app\.(get|post|patch|delete|put)\(\s*"([^"*]+)"/g)) {
      seen++;
      const spec = openapi.paths[path.replace(/:(\w+)/g, "{$1}")]?.[method];
      assert.ok(spec, `${method} ${path}`);
      assert.ok(spec.summary && spec.summary.length > 5, `${method} ${path} has a summary`);
    }
  assert.ok(seen >= 25, `${seen} new routes`);
  const text = JSON.stringify(openapi);
  assert.doesNotMatch(text, /�|Ã.|â€|<<<<<<<|>>>>>>>|=======/);
  const all = JSON.stringify(openapiForConfig({ released: "all" }).paths);
  const mvp = JSON.stringify(openapiForConfig({ released: "mvp" }).paths);
  for (const p of ["/api/photo-tools", "/api/push", "/api/file-search", "/api/research-watches", "/api/import/chats"]) {
    assert.ok(all.includes(`"${p}`), p);
    assert.ok(!mvp.includes(`"${p}`), p);
  }
});

test("the ten updates are registered unreleased with an icon each", () => {
  for (const id of BATCH8) {
    const u = UPDATES.find((x) => x.id === id);
    assert.ok(u, id);
    assert.equal(typeof committed[UPDATES.indexOf(u)], "boolean");
    assert.equal(u.points.length, 3, id);
  }
  const pages = source("src/Pages.jsx");
  const icons = pages.slice(pages.indexOf("const featureIcons = {"), pages.indexOf("};", pages.indexOf("const featureIcons = {")));
  for (const id of BATCH8) assert.match(icons, new RegExp(`\\n  ${id}: "`), id);
});
