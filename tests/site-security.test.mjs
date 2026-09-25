import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../server/app.js";
import { PUBLIC_PAGES, DOC_TOPICS, GUIDE_SLUGS } from "../src/site-routes.js";
import { articles } from "../src/data.js";
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-site-"));
  const svc = createApp({
    testMode: true,
    production: true,
    origin: "https://example.test",
    publicUrl: "https://example.test",
    trustProxy: "loopback",
    dbPath: join(dir, "db.sqlite"),
    mediaPath: join(dir, "media"),
    released: "mvp",
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return (path) => request(svc.app).get(path).set("X-Forwarded-Proto", "https");
}
test("known website routes work; unknown pages, docs, guides and assets return HTTP 404", async (t) => {
  const get = fixture(t);
  for (const path of PUBLIC_PAGES) await get(path).expect(200);
  for (const path of [
    "/missing",
    "/docs/missing",
    "/docs/api/missing",
    "/guides/missing",
    "/workspace/nope",
    "/account/nope",
    "/assets/missing.js",
  ]) {
    const res = await get(path).expect(404);
    assert.match(res.text, /id="root"/);
  }
  await get("/docs/privacy/").expect(200);
  assert.deepEqual([...GUIDE_SLUGS].sort(), articles.map((a) => a.slug).sort());
  const docs = readFileSync("src/Pages.jsx", "utf8");
  for (const topic of DOC_TOPICS) assert.ok(docs.includes('"' + topic + '"'));
});
test("security headers protect pages, errors, assets and API responses", async (t) => {
  const get = fixture(t);
  for (const path of [
    "/",
    "/missing",
    "/docs/missing",
    "/api/config",
    "/api/missing",
    "/favicon.svg",
  ]) {
    const res = await get(path);
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.equal(res.headers["x-frame-options"], "DENY");
    assert.equal(res.headers["strict-transport-security"], "max-age=31536000");
    assert.match(res.headers["permissions-policy"], /microphone=\(self\)/);
    assert.match(
      res.headers["content-security-policy"],
      /script-src 'self' 'wasm-unsafe-eval'/,
    );
    assert.match(
      res.headers["content-security-policy"],
      /frame-ancestors 'none'/,
    );
    assert.doesNotMatch(
      res.headers["content-security-policy"],
      /'unsafe-eval'/,
    );
    if (path.startsWith("/api"))
      assert.equal(res.headers["cache-control"], "no-store");
  }
});
test("sitemap and robots publish canonical public routes without private account routes", async (t) => {
  const get = fixture(t);
  const map = await get("/sitemap.xml")
    .expect(200)
    .expect("Content-Type", /application\/xml/);
  assert.ok(map.text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.match(
    map.text,
    /xmlns="http:\/\/www.sitemaps.org\/schemas\/sitemap\/0.9"/,
  );
  const urls = [...map.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(urls.length, new Set(urls).size);
  assert.deepEqual(
    urls,
    PUBLIC_PAGES.map((path) => "https://example.test" + path),
  );
  assert.doesNotMatch(map.text, /\/account|\/workspace|\/login|\/register/);
  const robots = await get("/robots.txt").expect(200);
  assert.match(robots.text, /Sitemap: https:\/\/example.test\/sitemap.xml/);
  assert.match(robots.text, /Disallow: \/login/);
});
test("health identifies the actual build artifact and never fabricates a revision", async (t) => {
  const get = fixture(t);
  const version = JSON.parse(readFileSync("dist/client/version.json", "utf8"));
  const health = (await get("/health").expect(200)).body;
  assert.deepEqual(health.build, version);
  assert.ok(version.commit === null || /^[a-f0-9]{40}$/.test(version.commit));
});
