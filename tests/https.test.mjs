import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "../server/core.js";
import { createApp } from "../server/app.js";

const origin = "https://service.example.invalid";
function fixture(t, overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-https-"));
  const service = createApp({
    testMode: true,
    production: true,
    origin,
    publicUrl: origin,
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "catalog.json"),
    trustProxy: "loopback",
    ...overrides,
  });
  t.after(() => {
    service.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return service;
}
test("production requires HTTPS for every configured URL, even in test mode", () => {
  for (const field of [
    "origin",
    "publicUrl",
    "gateway",
    "gateway2",
    "paymentBase",
    "rpc",
    "walletPaymentRpc",
  ])
    for (const value of ["http://example.invalid", "http://127.0.0.1:3001"])
      assert.throws(
        () =>
          config({
            production: true,
            testMode: true,
            origin,
            publicUrl: origin,
            [field]: value,
          }),
        /HTTPS/,
        `${field}: ${value}`,
      );
  for (const value of [
    "http://example.invalid",
    "http://localhost.example.invalid",
    "http://127.0.0.1.example.invalid",
  ])
    assert.throws(() => config({ production: false, origin: value }), /HTTPS/);
  for (const value of [
    "http://localhost:5175",
    "http://127.0.0.1:5175",
    "http://[::1]:5175",
  ])
    assert.equal(config({ production: false, origin: value }).origin, value);
  assert.equal(
    config({ production: true, origin, publicUrl: origin }).origin,
    origin,
  );
});
test("production blocks insecure writes and redirects reads without trusting the Host header", async (t) => {
  const s = fixture(t);
  const redirect = await request(s.app)
    .get("/account?tab=data")
    .set("Host", "attacker.example.invalid")
    .expect(308);
  assert.equal(redirect.headers.location, origin + "/account?tab=data");
  const denied = await request(s.app)
    .post("/api/auth/register")
    .send({ username: "blocked", password: "long-fixture-password" })
    .expect(426);
  assert.equal(denied.body.error.code, "https_required");
  assert.equal(denied.headers["set-cookie"], undefined);
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM users").get().n, 0);
  await request(s.app).get("/health").expect(200);
  const untrusted = fixture(t, { trustProxy: false });
  await request(untrusted.app)
    .post("/api/auth/register")
    .set("X-Forwarded-Proto", "https")
    .send({ username: "blocked", password: "long-fixture-password" })
    .expect(426);
});
test("trusted HTTPS proxy requests set and clear secure cookies on every session lifecycle path", async (t) => {
  const s = fixture(t);
  const secure = (req) => req.set("X-Forwarded-Proto", "https");
  const registered = await secure(request(s.app).post("/api/auth/register"))
    .send({ username: "secure-user", password: "long-fixture-password" })
    .expect(201);
  const check = (r) => {
    const c = r.headers["set-cookie"].find((c) =>
      c.startsWith("anonyma_session="),
    );
    for (const flag of [
      /; Secure/,
      /; HttpOnly/,
      /; SameSite=Lax/,
      /; Path=\//,
    ])
      assert.match(c, flag);
    assert.equal(r.headers["strict-transport-security"], "max-age=31536000");
    return c.split(";")[0];
  };
  let cookie = check(registered);
  await secure(request(s.app).get("/api/me")).set("Cookie", cookie).expect(200);
  check(
    await secure(request(s.app).post("/api/auth/logout"))
      .set("Cookie", cookie)
      .send({})
      .expect(200),
  );
  for (const path of ["/api/auth/logout-all", "/api/account"]) {
    const login = await secure(request(s.app).post("/api/auth/password"))
      .send({ username: "secure-user", password: "long-fixture-password" })
      .expect(200);
    cookie = check(login);
    const req =
      path === "/api/account"
        ? request(s.app).delete(path)
        : request(s.app).post(path);
    check(
      await secure(req)
        .set("Cookie", cookie)
        .send(path === "/api/account" ? { confirm: "DELETE" } : {})
        .expect(200),
    );
  }
});
test("HTTP loopback development keeps working without Secure cookies", async (t) => {
  const s = fixture(t, {
    production: false,
    origin: "http://localhost:5175",
    publicUrl: "",
  });
  const r = await request(s.app)
    .post("/api/auth/register")
    .send({ username: "local-user", password: "long-fixture-password" })
    .expect(201);
  assert.doesNotMatch(r.headers["set-cookie"][0], /; Secure/);
});
