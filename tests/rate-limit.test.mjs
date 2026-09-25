import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { createServer } from "node:http";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { database, config } from "../server/core.js";
import { createLimiter, errorHandler } from "../server/middleware.js";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function fixture(t, dir, extra = {}) {
  const db = database(join(dir, "db.sqlite"));
  const cfg = config({
    production: false,
    rateLimitUrl: "",
    rateLimitToken: "",
    rateLimitNamespace: "test",
    serverInstances: 1,
    ...extra,
  });
  const app = express();
  app.set("trust proxy", false);
  app.get("/", createLimiter(db, cfg)("login", 3, 30000), (req, res) =>
    res.send("ok"),
  );
  app.use(errorHandler(cfg));
  let closed = false;
  const close = () => {
    if (!closed) db.close();
    closed = true;
  };
  t.after(close);
  return { db, app, close };
}
function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-limit-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
test("SQLite limits survive restart and serialize concurrent app instances", async (t) => {
  const dir = directory(t),
    a = fixture(t, dir),
    b = fixture(t, dir);
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      request(i % 2 ? a.app : b.app).get("/"),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 3);
  assert.equal(responses.filter((r) => r.status === 429).length, 9);
  assert.ok(
    Number(responses.find((r) => r.status === 429).headers["retry-after"]) > 0,
  );
  a.close();
  b.close();
  const restarted = fixture(t, dir);
  await request(restarted.app).get("/").expect(429);
  restarted.db.prepare("UPDATE rate_limits SET expires=0").run();
  await request(restarted.app).get("/").expect(200);
});
test("shared-store failures refuse requests without revealing credentials or resetting local quotas", async (t) => {
  const server = createServer((req, res) => {
    res.writeHead(503);
    res.end("unavailable");
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const svc = fixture(t, directory(t), {
    rateLimitUrl: `http://127.0.0.1:${server.address().port}`,
    rateLimitToken: "test-only",
  });
  const response = await request(svc.app).get("/").expect(503);
  assert.equal(response.body.error.code, "rate_limit_unavailable");
  assert.equal(svc.db.prepare("SELECT count(*) n FROM rate_limits").get().n, 0);
  assert.doesNotMatch(response.text, /test-only|127\.0\.0\.1/);
});
test("multi-server config requires a shared store and rejects partial or insecure production settings", () => {
  assert.throws(
    () => config({ serverInstances: 2, rateLimitUrl: "", rateLimitToken: "" }),
    /shared rate/,
  );
  assert.throws(
    () => config({ rateLimitUrl: "https://example.test", rateLimitToken: "" }),
    /Both/,
  );
  assert.throws(
    () =>
      config({ rateLimitUrl: "http://example.test", rateLimitToken: "test" }),
    /HTTPS/,
  );
});

test("real Redis shares atomic quotas across separate databases and app restarts", async (t) => {
  const binary = process.env.REDIS_SERVER || "redis-server";
  const cli = process.env.REDIS_CLI || "redis-cli";
  try {
    execFileSync(binary, ["--version"], { stdio: "ignore" });
    execFileSync(cli, ["--version"], { stdio: "ignore" });
  } catch {
    if (process.env.REQUIRE_REDIS_TEST === "1")
      throw Error("Redis binaries required by release checks.");
    return t.skip(
      "Redis integration runs mandatorily in release CI; install Redis to run locally.",
    );
  }
  const dir = directory(t),
    socket = join(dir, "redis.sock");
  const redis = spawn(
    binary,
    [
      "--port",
      "0",
      "--unixsocket",
      socket,
      "--unixsocketperm",
      "700",
      "--save",
      "",
      "--appendonly",
      "no",
      "--dir",
      dir,
    ],
    { stdio: "ignore" },
  );
  t.after(() => {
    redis.kill("SIGTERM");
  });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      ready =
        execFileSync(cli, ["-s", socket, "PING"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim() === "PONG";
    } catch {}
    if (ready) break;
    await wait(25);
  }
  assert.ok(ready, "isolated Redis started");
  // Small test-only REST adapter sends the exact production EVAL command to
  // a real Redis engine; Lua is not mocked or reimplemented in this test.
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== "Bearer test-only") {
      res.writeHead(401);
      return res.end();
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    try {
      const command = JSON.parse(body);
      assert.equal(command[0], "EVAL");
      const result = JSON.parse(
        execFileSync(cli, ["-s", socket, "--json", ...command], {
          encoding: "utf8",
        }),
      );
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ result }));
    } catch {
      res.writeHead(500);
      res.end("{}");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => server.close(r)));
  const settings = {
    serverInstances: 2,
    rateLimitUrl: `http://127.0.0.1:${server.address().port}`,
    rateLimitToken: "test-only",
  };
  const a = fixture(t, directory(t), settings),
    b = fixture(t, directory(t), settings);
  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) =>
      request(i % 2 ? a.app : b.app).get("/"),
    ),
  );
  assert.equal(responses.filter((r) => r.status === 200).length, 3);
  assert.equal(responses.filter((r) => r.status === 429).length, 17);
  a.close();
  b.close();
  const restarted = fixture(t, directory(t), settings);
  await request(restarted.app).get("/").expect(429);
  const keys = JSON.parse(
    execFileSync(cli, ["-s", socket, "--json", "KEYS", "test:*"], {
      encoding: "utf8",
    }),
  );
  assert.equal(keys.length, 1);
  assert.doesNotMatch(keys[0], /127\.0\.0\.1/);
  execFileSync(cli, ["-s", socket, "PEXPIRE", keys[0], "1"]);
  await wait(10);
  await request(restarted.app).get("/").expect(200);
});
