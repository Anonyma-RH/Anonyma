import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { refuseSeedPhrase } from "../server/seed-guard.js";
import {
  blockedAddress,
  checkUrl,
  vetHost,
  requestOptions,
  bodyText,
  USER_AGENT,
  LINK_LIMITS,
} from "../server/link-reader.js";
import { extractHtml, extractPlain, domText, tidy } from "../server/link-extract.js";
import { parseHTML } from "linkedom";
import {
  LINK_READER,
  findLinks,
  stripTracking,
  countWords,
  capWords,
  maskOutsideLinks,
  stripLinkBlocks,
  formatWords,
} from "../src/link-reader.js";
import {
  buildDocumentBlock,
  composeMessageWithDocuments,
  parseDocumentBlocks,
} from "../src/documents.js";
import { buildChatRequest } from "../src/estimate.js";
import { createVeilState } from "../src/veil.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. These tests cover the
// gate itself, so they pin every update to unreleased for this file and keep
// passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const zh = compileDictionary(JSON.parse(readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8")));
const han = /[一-鿿]/;
const SEED = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

// ---- A local "internet": a test server and a resolver ----

const ARTICLE = `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><title>Why onions have layers | The Garden Post</title>
<meta property="og:site_name" content="The Garden Post">
<meta name="author" content="Rosa Field">
<style>.hidden{display:none} body{color:red}</style>
<script>window.secret = "SCRIPT-TEXT-SHOULD-NOT-APPEAR"; fetch("https://tracker.example/x")</script>
</head><body>
<nav><a href="/">Home</a> <a href="/about">About</a></nav>
<form action="/subscribe"><input name="email" value="FORM-VALUE-SHOULD-NOT-APPEAR"><button>Subscribe now</button></form>
<article>
<h1>Why onions have layers</h1>
<p class="byline">By Rosa Field</p>
<p>Onions grow in layers because each leaf base swells to store food for the plant through winter. The outermost layers dry into a papery skin that protects the bulb from moisture and pests.</p>
<p>Gardeners harvest onions when the tops fall over. <a href="https://example.org/guide?utm_source=news&fbclid=abc123&id=7">Read the curing guide</a> before you store them for the season.</p>
<h2>Storing the harvest</h2>
<ul><li>Cure them in a dry, airy place for two weeks.</li><li>Keep them cool and dark afterwards.</li></ul>
<div style="display:none">HIDDEN-TEXT-SHOULD-NOT-APPEAR</div>
<p hidden>ALSO-HIDDEN</p>
<table><tr><th>Variety</th><th>Days</th></tr><tr><td>Red Baron</td><td>110</td></tr></table>
<p>Layered bulbs also explain why onion routing is named the way it is: each relay peels one layer of encryption, and only the last one sees the message itself. Nobody in the middle learns both ends.</p>
</article>
<footer>Copyright The Garden Post</footer>
</body></html>`;

let server, port;
const seen = [];
const routes = {
  "/article": (req, res) => res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Set-Cookie": "id=tracking-cookie" }).end(ARTICLE),
  "/plain": (req, res) => res.writeHead(200, { "Content-Type": "text/plain" }).end("Line one of the notes.\n\n\n\nLine two, with more words."),
  "/doc.pdf": (req, res) => res.writeHead(200, { "Content-Type": "application/pdf" }).end("%PDF-1.4\n% a tiny test document\n%%EOF\n"),
  "/fake.pdf": (req, res) => res.writeHead(200, { "Content-Type": "application/pdf" }).end("<html>not a pdf</html>"),
  "/image": (req, res) => res.writeHead(200, { "Content-Type": "image/png" }).end(Buffer.from([137, 80, 78, 71])),
  "/json": (req, res) => res.writeHead(200, { "Content-Type": "application/json" }).end("{}"),
  "/untyped": (req, res) => {
    res.removeHeader("Content-Type");
    res.writeHead(200).end("<p>no type</p>");
  },
  "/big": (req, res) => res.writeHead(200, { "Content-Type": "text/html", "Content-Length": LINK_LIMITS.maxBytes + 10 }).end(Buffer.alloc(LINK_LIMITS.maxBytes + 10, 97)),
  "/big-chunked": (req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    const chunk = Buffer.alloc(1024 * 1024, 98);
    for (let i = 0; i < 6; i++) res.write(chunk);
    res.end();
  },
  "/bomb": (req, res) =>
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" }).end(zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024, 32))),
  "/gzip": (req, res) =>
    res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "gzip" }).end(zlib.gzipSync(ARTICLE)),
  "/brotli": (req, res) =>
    res.writeHead(200, { "Content-Type": "text/html", "Content-Encoding": "br" }).end(zlib.brotliCompressSync(ARTICLE)),
  "/latin1": (req, res) =>
    res.writeHead(200, { "Content-Type": "text/plain; charset=windows-1252" }).end(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x6e, 0x6f, 0x74, 0x65, 0x73])),
  "/missing": (req, res) => res.writeHead(404, { "Content-Type": "text/html" }).end("<p>Not here</p>"),
  "/slow": () => {},
  "/empty": (req, res) => res.writeHead(200, { "Content-Type": "text/html" }).end("<html><body><script>app()</script></body></html>"),
  "/to-private": (req, res) => res.writeHead(302, { Location: "http://10.0.0.5/admin" }).end(),
  "/to-metadata-name": (req, res) => res.writeHead(301, { Location: "http://metadata.example.com/latest/meta-data/" }).end(),
  "/to-metadata-ip": (req, res) => res.writeHead(307, { Location: "http://169.254.169.254/latest/meta-data/" }).end(),
  "/to-mapped": (req, res) => res.writeHead(302, { Location: "http://[::ffff:127.0.0.1]/" }).end(),
  "/to-port": (req, res) => res.writeHead(302, { Location: "http://news.example.com:8080/article" }).end(),
  "/to-file": (req, res) => res.writeHead(302, { Location: "file:///etc/passwd" }).end(),
  "/to-userinfo": (req, res) => res.writeHead(302, { Location: "http://admin:pw@news.example.com/article" }).end(),
  "/to-rebind": (req, res) => res.writeHead(302, { Location: "http://rebind.example.com/article" }).end(),
  "/r1": (req, res) => res.writeHead(302, { Location: "/article?utm_campaign=x" }).end(),
  "/r2": (req, res) => res.writeHead(302, { Location: "/r1" }).end(),
  "/r3": (req, res) => res.writeHead(303, { Location: "http://news.example.com/r2" }).end(),
  "/r4": (req, res) => res.writeHead(302, { Location: "/r3" }).end(),
  "/loop": (req, res) => res.writeHead(302, { Location: "/loop" }).end(),
  "/no-location": (req, res) => res.writeHead(302).end(),
};
before(async () => {
  server = http.createServer((req, res) => {
    seen.push({ path: req.url, headers: req.headers });
    const handler = routes[new URL(req.url, "http://x").pathname];
    if (handler) handler(req, res);
    else res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
});
after(() => {
  server.closeAllConnections();
  server.close();
});

// Public addresses (documentation-free, real-looking) for the test names;
// every connection is routed to the local server after the checks ran.
const PUBLIC = "93.184.216.34";
let rebindCalls = 0;
const lookups = [];
const DNS = {
  "news.example.com": () => [{ address: PUBLIC, family: 4 }],
  "v6first.example.com": () => [
    { address: "2606:4700:4700::1111", family: 6 },
    { address: "93.184.216.35", family: 4 },
  ],
  "metadata.example.com": () => [{ address: "169.254.169.254", family: 4 }],
  "mixed.example.com": () => [
    { address: PUBLIC, family: 4 },
    { address: "10.1.2.3", family: 4 },
  ],
  "ula.example.com": () => [{ address: "fd00:ec2::254", family: 6 }],
  "mapped.example.com": () => [{ address: "::ffff:192.168.1.10", family: 6 }],
  // DNS rebinding: public the first time, loopback after that.
  "rebind.example.com": () => (rebindCalls++ === 0 ? [{ address: PUBLIC, family: 4 }] : [{ address: "127.0.0.1", family: 4 }]),
  "empty.example.com": () => [],
};
const routed = [];
function fixture(t, released = "all", extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-linkreader-"));
  const svc = createApp({
    testMode: true,
    released,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    linkReader: {
      lookup: async (host) => {
        lookups.push(host);
        const answer = DNS[host];
        if (!answer) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: "ENOTFOUND" });
        return answer();
      },
      route: (ip, p) => {
        routed.push({ ip, port: p });
        return { host: "127.0.0.1", port };
      },
      timeoutMs: 1500,
      ...extra,
    },
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
    .set("X-Forwarded-For", `198.51.100.${(++visitor % 250) + 1}`)
    .send({ username, password: "test-password-long" })
    .expect(201);
  return { agent, user: r.body.user };
}
const read = (p, url) => p.agent.post("/api/read").send({ url });

// ---- The release gate ----

test("unreleased: /api/read is refused, the config says so and the API docs leave it out", async (t) => {
  const mvp = fixture(t, "mvp");
  const a = await person(mvp.app, "ana");
  for (const send of [
    () => read(a, "http://news.example.com/article"),
    () => a.agent.post("/API/Read/").send({ url: "http://news.example.com/article" }),
  ]) {
    const res = await send().expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Link Reader is coming soon.");
  }
  // Refused before authentication, like every gated route, and nothing fetched.
  await request(mvp.app).post("/api/read").send({ url: "http://news.example.com/article" }).expect(403);
  assert.ok(!seen.length, "nothing was fetched");
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.linkreader, false);
  const entry = config.releases.updates.find((u) => u.id === "linkreader");
  assert.equal(entry.title, "Link Reader");
  assert.equal(entry.released, false);
  assert.equal(entry.points.length, 3);
  const closed = (await request(mvp.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(!closed.paths["/api/read"]);
  assert.deepEqual(featuresFor({ path: "/api/read", method: "POST", body: {} }), ["linkreader", "documents"]);
  for (const path of ["/api/chat", "/api/conversations", "/api/account/export"])
    assert.ok(!featuresFor({ path, method: "POST", body: {} }).includes("linkreader"), path);

  // It needs Documents too (the page rides as a document block).
  const alone = fixture(t, "mvp,linkreader");
  const b = await person(alone.app, "ben");
  assert.equal((await read(b, "http://news.example.com/article").expect(403)).body.error.message, "Documents is coming soon.");
  const both = fixture(t, "mvp,linkreader,documents");
  const c = await person(both.app, "cai");
  assert.equal((await read(c, "http://news.example.com/article").expect(200)).body.kind, "html");
  const open = (await request(both.app).get("/api/openapi.json").expect(200)).body;
  assert.ok(open.paths["/api/read"].post);
});

test("signed-in accounts only, and a url is required", async (t) => {
  const s = fixture(t);
  await request(s.app).post("/api/read").send({ url: "http://news.example.com/article" }).expect(401);
  const a = await person(s.app, "ana");
  for (const body of [{}, { url: 42 }, { url: "" }, { url: "x".repeat(2049) }])
    assert.equal((await a.agent.post("/api/read").send(body).expect(400)).body.error.code, "link_invalid");
});

test("the UI shows only once Link Reader and Documents are released", () => {
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(ws, /const linkCardsLive = isReleased\(config, "linkreader"\) && isReleased\(config, "documents"\);/);
  assert.match(ws, /const linkLive = !demo && !!user && textMode && linkCardsLive;/);
  assert.match(ws, /\{linkLive && \(\s*<LinkReaderChips/);
  assert.match(ws, /linkCards=\{linkCardsLive\}/);
  const pages = readFileSync(new URL("../src/Pages.jsx", import.meta.url), "utf8");
  assert.match(pages, /linkreader: "link",/);
  // What is retained: described only once it's live.
  const data = readFileSync(new URL("../src/DataControls.jsx", import.meta.url), "utf8");
  assert.match(data, /const linkReader =\s+!!config && isReleased\(config, "linkreader"\) && isReleased\(config, "documents"\);/);
  assert.match(data, /\{linkReader && \(\s*<li>\s*Link Reader:/);
});

// ---- Addresses (SSRF) ----

test("every refused IPv4 range, and public addresses allowed", () => {
  for (const ip of [
    "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "100.64.0.1", "100.100.100.200", "100.127.255.255",
    "127.0.0.1", "127.8.9.10", "169.254.0.1", "169.254.169.254", "169.254.170.2", "172.16.0.1", "172.31.255.255",
    "192.0.0.1", "192.0.0.192", "192.0.2.1", "192.88.99.1", "192.168.0.1", "192.168.255.255", "198.18.0.1",
    "198.19.255.255", "198.51.100.7", "203.0.113.9", "224.0.0.1", "239.255.255.250", "240.0.0.1",
    "255.255.255.255", "168.63.129.16",
  ])
    assert.ok(blockedAddress(ip), ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", "169.253.255.255", "198.20.0.1", "223.255.255.255"])
    assert.equal(blockedAddress(ip), null, ip);
});

test("every refused IPv6 range, IPv4-mapped and NAT64 forms, and public IPv6 allowed", () => {
  for (const ip of [
    "::", "::1", "[::1]", "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe", "::ffff:192.168.1.1", "::127.0.0.1", "::a00:1", "64:ff9b::10.0.0.1",
    "64:ff9b::a9fe:a9fe", "64:ff9b:1::1", "fc00::1", "fd00::1", "fd00:ec2::254", "fe80::1", "febf::1",
    "fec0::1", "ff02::1", "ff05::1:3", "100::1", "2001::1", "2001:0:4136:e378::1", "2001:db8::1",
    "2002:7f00:1::1", "3fff::1", "5f00::1", "fe80::1%eth0", "not-an-ip", "",
  ])
    assert.ok(blockedAddress(ip), ip);
  for (const ip of ["2606:4700:4700::1111", "2001:4860:4860::8888", "[2a00:1450:4001:82a::200e]", "::ffff:8.8.8.8", "64:ff9b::8.8.8.8", "2400:cb00::1"])
    assert.equal(blockedAddress(ip), null, ip);
});

test("URLs: http(s) only, standard ports, no userinfo, no local names, IP literals checked", () => {
  const code = (u) => {
    try {
      checkUrl(u);
      return "ok";
    } catch (e) {
      return e.code;
    }
  };
  for (const u of ["ftp://news.example.com/", "file:///etc/passwd", "javascript:alert(1)", "data:text/html,hi", "gopher://news.example.com/", "ws://news.example.com/", "news.example.com/page", "http://", "http://intranet/", "http:// news.example.com", "http://news.example.com/\nx", "http://x.example.com/" + "a".repeat(2048)])
    assert.equal(code(u), "link_invalid", u);
  for (const u of ["http://user@news.example.com/", "http://user:pass@news.example.com/", "http://@news.example.com/", "https://:pw@news.example.com/", "http:@news.example.com/", "http:\\\\@news.example.com/"])
    assert.equal(code(u), "link_userinfo", u);
  for (const u of ["http://news.example.com:8080/", "https://news.example.com:80/", "http://news.example.com:443/", "https://news.example.com:8443/", "http://news.example.com:22/", "http://news.example.com:0/"])
    assert.equal(code(u), "link_port", u);
  for (const u of [
    "http://localhost/", "http://LOCALHOST./", "http://app.localhost/", "http://printer.local/", "http://db.railway.internal/",
    "http://router.home.arpa/", "http://127.0.0.1/", "http://127.1/", "http://2130706433/", "http://0x7f000001/",
    "http://0177.0.0.1/", "http://0x7f.1/", "http://[::1]/", "http://[::ffff:127.0.0.1]/", "http://[fd00:ec2::254]/",
    "http://169.254.169.254/latest/meta-data/", "http://[::ffff:a9fe:a9fe]/", "http://10.0.0.1/", "http://100.64.0.1/",
    "http://0.0.0.0/", "http://[::]/", "http://[fe80::1]/", "http://224.0.0.1/", "http://255.255.255.255/",
  ])
    assert.equal(code(u), "link_blocked", u);
  // Allowed, with the default port spelled out, a public IP literal and IDN.
  for (const u of ["http://news.example.com:80/a", "https://news.example.com:443/a", "https://8.8.8.8/", "https://[2606:4700:4700::1111]/", "https://bücher.example/", "https://news.example.com./x"])
    assert.equal(code(u), "ok", u);
  // Tracking parameters and the fragment go; everything else stays in order.
  assert.equal(
    checkUrl("https://news.example.com/a?id=7&utm_source=x&UTM_Medium=y&fbclid=abc&gclid=1&q=onion&mc_eid=2#top").href,
    "https://news.example.com/a?id=7&q=onion",
  );
  assert.equal(checkUrl("https://news.example.com/a?q=1").href, "https://news.example.com/a?q=1");
});

test("DNS: every answer must be public, IPv4 is dialled first, mapped addresses dial as IPv4", async () => {
  const lookup = async (h) => DNS[h]();
  assert.deepEqual(await vetHost("news.example.com", lookup), [{ address: PUBLIC, family: 4 }]);
  assert.deepEqual((await vetHost("v6first.example.com", lookup)).map((d) => d.family), [4, 6]);
  for (const host of ["metadata.example.com", "mixed.example.com", "ula.example.com", "mapped.example.com"])
    await assert.rejects(vetHost(host, lookup), { code: "link_blocked" }, host);
  await assert.rejects(vetHost("empty.example.com", lookup), { code: "link_unreachable" });
  await assert.rejects(vetHost("nowhere.example.com", async () => { throw new Error("ENOTFOUND nowhere.example.com"); }), { code: "link_unreachable" });
  assert.deepEqual(await vetHost("[::ffff:8.8.8.8]", lookup), [{ address: "8.8.8.8", family: 4 }]);
});

test("the request goes to the vetted address with the name only as Host and SNI, and carries nothing of the user", () => {
  const url = checkUrl("https://news.example.com/a?b=1");
  const o = requestOptions(url, { address: PUBLIC, family: 4 });
  assert.equal(o.host, PUBLIC);
  assert.equal(o.family, 4);
  assert.equal(o.port, 443);
  assert.equal(o.servername, "news.example.com");
  assert.equal(o.path, "/a?b=1");
  assert.equal(o.agent, false);
  assert.equal(o.headers.Host, "news.example.com");
  assert.equal(o.headers["User-Agent"], USER_AGENT);
  const names = Object.keys(o.headers).map((h) => h.toLowerCase());
  for (const h of ["cookie", "referer", "authorization", "origin", "x-forwarded-for"]) assert.ok(!names.includes(h), h);
  // An IP-literal https link sends no SNI (it can't be an address).
  assert.ok(!("servername" in requestOptions(checkUrl("https://8.8.8.8/"), { address: "8.8.8.8", family: 4 })));
  assert.equal(requestOptions(checkUrl("http://news.example.com/"), { address: PUBLIC, family: 4 }).port, 80);
});

// ---- Fetching through the route ----

test("reads a page: clean text, title, site, words; no cookies, no Referer, a generic User-Agent", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  seen.length = 0;
  routed.length = 0;
  const r = (await read(a, "http://news.example.com/article?utm_source=x&fbclid=abc#section").expect(200)).body;
  assert.equal(r.kind, "html");
  assert.equal(r.url, "http://news.example.com/article");
  assert.equal(r.host, "news.example.com");
  assert.equal(r.redirected, false);
  assert.equal(r.title, "Why onions have layers");
  assert.equal(r.site_name, "The Garden Post");
  assert.match(r.text, /Onions grow in layers because each leaf base swells/);
  assert.match(r.text, /## Storing the harvest/);
  assert.match(r.text, /- Cure them in a dry, airy place for two weeks\./);
  assert.match(r.text, /Variety \| Days/);
  assert.match(r.text, /Read the curing guide/);
  for (const bad of ["SCRIPT-TEXT", "FORM-VALUE", "HIDDEN-TEXT", "ALSO-HIDDEN", "Subscribe now", "tracker.example", "example.org/guide", "fbclid", "color:red"])
    assert.ok(!r.text.includes(bad), bad);
  assert.equal(r.words, countWords(r.text));
  assert.equal(r.truncated, false);
  // What the site saw: our server, asked for the tracker-free path.
  assert.equal(seen.length, 1);
  const h = seen[0].headers;
  assert.equal(seen[0].path, "/article");
  assert.equal(h.host, "news.example.com");
  assert.equal(h["user-agent"], USER_AGENT);
  for (const name of ["cookie", "referer", "origin", "authorization", "x-forwarded-for"]) assert.ok(!(name in h), name);
  assert.deepEqual(routed, [{ ip: PUBLIC, port: 80 }]);
  // The site's cookie is ignored: a second read sends none.
  await read(a, "http://news.example.com/article").expect(200);
  assert.ok(!("cookie" in seen[1].headers));
});

test("plain text, PDFs (bytes for the browser), compressed pages and charsets", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const plain = (await read(a, "http://news.example.com/plain").expect(200)).body;
  assert.equal(plain.kind, "text");
  assert.equal(plain.text, "Line one of the notes.\n\nLine two, with more words.");
  assert.equal(plain.title, "plain");
  const pdf = (await read(a, "http://news.example.com/doc.pdf").expect(200)).body;
  assert.equal(pdf.kind, "pdf");
  assert.equal(pdf.title, "doc.pdf");
  assert.equal(Buffer.from(pdf.pdf, "base64").toString(), "%PDF-1.4\n% a tiny test document\n%%EOF\n");
  assert.equal(pdf.bytes, Buffer.byteLength("%PDF-1.4\n% a tiny test document\n%%EOF\n"));
  assert.equal((await read(a, "http://news.example.com/fake.pdf").expect(415)).body.error.code, "link_type");
  for (const path of ["/gzip", "/brotli"]) {
    const r = (await read(a, "http://news.example.com" + path).expect(200)).body;
    assert.equal(r.title, "Why onions have layers", path);
  }
  assert.equal((await read(a, "http://news.example.com/latin1").expect(200)).body.text, "Café notes");
});

test("wrong content types, oversized bodies and decompression bombs are refused", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  for (const path of ["/image", "/json", "/untyped"])
    assert.equal((await read(a, "http://news.example.com" + path).expect(415)).body.error.code, "link_type", path);
  for (const path of ["/big", "/big-chunked", "/bomb"]) {
    const r = await read(a, "http://news.example.com" + path).expect(413);
    assert.equal(r.body.error.code, "link_too_large", path);
    assert.equal(r.body.error.message, "That page is larger than 5 MB.");
  }
  const missing = (await read(a, "http://news.example.com/missing").expect(502)).body.error;
  assert.equal(missing.code, "link_status");
  assert.equal(missing.message, "The site answered 404 instead of the page.");
  assert.equal((await read(a, "http://news.example.com/empty").expect(422)).body.error.code, "link_unreadable");
  assert.equal((await read(a, "http://nowhere.example.com/").expect(502)).body.error.code, "link_unreachable");
});

test("redirects: at most 3, each checked again; private targets, ports, schemes and userinfo refused", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  seen.length = 0;
  const ok = (await read(a, "http://news.example.com/r3").expect(200)).body;
  assert.equal(ok.redirected, true);
  assert.equal(ok.url, "http://news.example.com/article", "the tracking parameter on the way was dropped");
  assert.deepEqual(seen.map((x) => x.path), ["/r3", "/r2", "/r1", "/article"]);
  assert.equal((await read(a, "http://news.example.com/r4").expect(502)).body.error.code, "link_redirects");
  assert.equal((await read(a, "http://news.example.com/loop").expect(502)).body.error.code, "link_redirects");
  assert.equal((await read(a, "http://news.example.com/no-location").expect(502)).body.error.code, "link_status");
  seen.length = 0;
  for (const [path, code] of [
    ["/to-private", "link_blocked"],
    ["/to-metadata-name", "link_blocked"],
    ["/to-metadata-ip", "link_blocked"],
    ["/to-mapped", "link_blocked"],
    ["/to-port", "link_port"],
    ["/to-file", "link_invalid"],
    ["/to-userinfo", "link_userinfo"],
  ]) {
    const r = await read(a, "http://news.example.com" + path).expect(400);
    assert.equal(r.body.error.code, code, path);
    assert.ok(!/10\.0\.0\.5|169\.254|metadata\.example|passwd/.test(r.body.error.message), "the message names no target");
  }
  // Only the first hop of each ever reached a server.
  assert.equal(seen.length, 7);
});

test("DNS rebinding: the address that was checked is the one connected to; a later answer is checked again", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  rebindCalls = 0;
  lookups.length = 0;
  routed.length = 0;
  // First answer public: fetched from that address, and never resolved twice.
  assert.equal((await read(a, "http://rebind.example.com/article").expect(200)).body.title, "Why onions have layers");
  assert.deepEqual(lookups, ["rebind.example.com"]);
  assert.deepEqual(routed, [{ ip: PUBLIC, port: 80 }]);
  // The same name answering loopback on the next hop is refused before any
  // connection.
  routed.length = 0;
  assert.equal((await read(a, "http://news.example.com/to-rebind").expect(400)).body.error.code, "link_blocked");
  assert.deepEqual(routed, [{ ip: PUBLIC, port: 80 }], "only news.example.com was connected to");
  // A name with both a public and a private answer is refused as a whole.
  routed.length = 0;
  for (const host of ["mixed.example.com", "metadata.example.com", "ula.example.com", "mapped.example.com"])
    assert.equal((await read(a, `http://${host}/article`).expect(400)).body.error.code, "link_blocked", host);
  assert.equal(routed.length, 0);
  // IPv4 first when a name has both.
  routed.length = 0;
  await read(a, "http://v6first.example.com/article").expect(200);
  assert.equal(routed[0].ip, "93.184.216.35");
});

test("a slow page times out, and at most 2 reads run at once per account", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const b = await person(s.app, "ben");
  const started = Date.now();
  // .then() starts a supertest request; until then it's only built.
  const slow = [read(a, "http://news.example.com/slow").then((r) => r), read(a, "http://news.example.com/slow").then((r) => r)];
  await new Promise((r) => setTimeout(r, 200));
  const busy = await read(a, "http://news.example.com/article").expect(429);
  assert.equal(busy.body.error.code, "link_busy");
  // Another account isn't held up.
  await read(b, "http://news.example.com/article").expect(200);
  for (const res of await Promise.all(slow)) {
    assert.equal(res.status, 504);
    assert.equal(res.body.error.code, "link_timeout");
  }
  assert.ok(Date.now() - started < 5000);
  await read(a, "http://news.example.com/article").expect(200);
});

test("60 reads an hour per account, then 429; other accounts are unaffected", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const b = await person(s.app, "ben");
  for (let i = 0; i < LINK_READER.perHour; i++) await read(a, "not a link").expect(400);
  const limited = await read(a, "http://news.example.com/article").expect(429);
  assert.equal(limited.body.error.code, "rate_limit");
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  await read(b, "http://news.example.com/article").expect(200);
});

test("nothing is logged and nothing is stored: not the link, its host or the page", async (t) => {
  const s = fixture(t);
  const a = await person(s.app, "ana");
  const logged = [];
  const saved = {};
  for (const k of ["log", "info", "warn", "error", "debug"]) {
    saved[k] = console[k];
    console[k] = (...args) => logged.push(args.map(String).join(" "));
  }
  try {
    for (const path of ["/article", "/missing", "/to-private", "/big", "/image", "/empty", "/slow"])
      await read(a, "http://news.example.com" + path + "?secret-token=abc");
    await read(a, "http://nowhere.example.com/secret-path");
  } finally {
    Object.assign(console, saved);
  }
  const all = logged.join("\n");
  for (const bad of ["example.com", "secret", "10.0.0.5", PUBLIC, "onion"]) assert.ok(!all.includes(bad), `logged ${bad}`);
  // No table holds the link, its host or the page.
  const dump = s.db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map(({ name }) => JSON.stringify(s.db.prepare(`SELECT * FROM "${name}"`).all()))
    .join("\n");
  for (const bad of ["example.com", "secret-token", "Onions grow"]) assert.ok(!dump.includes(bad), `stored ${bad}`);
  const exported = JSON.stringify((await a.agent.get("/api/account/export").expect(200)).body);
  assert.ok(!exported.includes("example.com"));
});

test("test hooks work only in local test mode", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-linkreader-live-"));
  const svc = createApp({
    testMode: false,
    released: "all",
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    // Were these honoured, hooks.invalid would reach the local server.
    linkReader: { lookup: async () => [{ address: PUBLIC, family: 4 }], route: () => ({ host: "127.0.0.1", port }) },
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const a = await person(svc.app, "ana");
  seen.length = 0;
  // .invalid never resolves (RFC 2606), so the real resolver refuses it.
  const r = await read(a, "http://hooks.invalid/article").expect(502);
  assert.equal(r.body.error.code, "link_unreachable");
  assert.equal(seen.length, 0);
});

// ---- Extraction ----

test("extraction: article text, headings, lists, tables; scripts, styles, forms and hidden text out", () => {
  const r = extractHtml(ARTICLE, { host: "news.example.com" });
  assert.equal(r.title, "Why onions have layers");
  assert.equal(r.siteName, "The Garden Post");
  assert.match(r.byline, /Rosa Field/);
  assert.doesNotMatch(r.text, /SCRIPT-TEXT|FORM-VALUE|HIDDEN|Subscribe|Copyright|Home About/);
  assert.match(r.text, /^# Why onions have layers|Onions grow in layers/m);
  // A page with no article falls back to the body without its navigation.
  const short = extractHtml(`<html><head><title>Status</title></head><body><nav>Menu Links</nav><main><p>All systems normal.</p></main><footer>Foot</footer></body></html>`, { host: "status.example.com" });
  assert.equal(short.title, "Status");
  assert.equal(short.text, "All systems normal.");
  assert.equal(short.words, 3);
  // The title falls back to the host.
  assert.equal(extractHtml("<p>Only words here.</p>", { host: "bare.example.com" }).title, "bare.example.com");
  // An ASP.NET-style page wrapped in one <form> keeps its content.
  const wrapped = extractHtml(`<html><body><form><div><p>${"Wrapped page content that matters. ".repeat(12)}</p><input value="x"></div></form></body></html>`);
  assert.match(wrapped.text, /Wrapped page content that matters\./);
});

test("extraction: word cap with a note, zero-width characters, <pre> kept", () => {
  const long = extractPlain(Array.from({ length: 50 }, (_, i) => "word" + i).join(" "), { maxWords: 10 });
  assert.equal(long.words, 10);
  assert.equal(long.truncated, true);
  assert.equal(long.text, "word0 word1 word2 word3 word4 word5 word6 word7 word8 word9");
  assert.equal(capWords("a b c", 30000).truncated, false);
  assert.equal(countWords("Onion routing 洋葱路由 works"), 7);
  assert.equal(tidy("a\u200bb\ufeff\u0007c\n\n\n\nd"), "abc\n\nd");
  const pre = extractHtml(`<article><h2>Code</h2><pre>line 1\n  indented 2</pre><p>${"Explained in words. ".repeat(20)}</p></article>`);
  assert.match(pre.text, /line 1\n {2}indented 2/);
  const { document } = parseHTML("<html><body><div><h3>Title</h3><ol><li>One</li><li>Two</li></ol><p>A<br>B</p></div></body></html>");
  assert.equal(domText(document.querySelector("div")), "### Title\n\n- One\n- Two\n\nA\nB");
});

test("charsets: header, meta tag and BOM", () => {
  assert.equal(bodyText(Buffer.from([0x63, 0x61, 0x66, 0xe9]), { type: "text/plain", charset: "iso-8859-1" }), "café");
  assert.equal(bodyText(Buffer.from('<meta charset="windows-1252"><p>caf\xe9</p>', "latin1"), { type: "text/html", charset: null }), '<meta charset="windows-1252"><p>café</p>');
  assert.equal(bodyText(Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]), { type: "text/plain", charset: "iso-8859-1" }), "hi");
  assert.equal(bodyText(Buffer.from("héllo"), { type: "text/plain", charset: "no-such-charset" }), "héllo");
});

// ---- The composer's links and the attached page ----

test("links in the composer: trailing punctuation, brackets, duplicates, at most 3", () => {
  assert.deepEqual(findLinks("Summarise https://en.wikipedia.org/wiki/Onion_(disambiguation). Thanks!"), [
    "https://en.wikipedia.org/wiki/Onion_(disambiguation)",
  ]);
  assert.deepEqual(findLinks("(see https://news.example.com/a), and https://news.example.com/a again"), ["https://news.example.com/a"]);
  assert.deepEqual(findLinks("“https://news.example.com/b”"), ["https://news.example.com/b"]);
  assert.deepEqual(findLinks("ftp://x.example.com and mailto:a@b.co and www.example.com"), []);
  assert.equal(findLinks("http://a.example.com http://b.example.com http://c.example.com http://d.example.com").length, 3);
  assert.equal(stripTracking("https://x.example.com/?utm_source=a&keep=1&fbclid=z").href, "https://x.example.com/?keep=1");
  assert.equal(formatWords(1), "1 word");
  assert.equal(formatWords(1896), "1,896 words");
});

const page = {
  source: "link",
  name: 'The "Garden" <Post>',
  url: "https://news.example.com/article?id=7&x=<y>",
  site: "news.example.com",
  words: 5,
  text: "Contact press@garden.example or call +1 415 555 0100 <b>now</b>. " + SEED,
};

test("the page rides as a Documents block marked source=link, and parses back", () => {
  const block = buildDocumentBlock(page);
  assert.match(block, /^<document name="The &quot;Garden&quot; &lt;Post&gt;" source="link" url="https:\/\/news\.example\.com\/article\?id=7&amp;x=&lt;y&gt;" site="news\.example\.com" words="5">/);
  const parsed = parseDocumentBlocks(composeMessageWithDocuments("What does it say?", [page]));
  assert.equal(parsed.text, "What does it say?");
  assert.deepEqual(
    { ...parsed.documents[0], chars: undefined },
    { name: page.name, pages: null, truncated: false, chars: undefined, text: page.text, source: "link", url: page.url, site: page.site, words: 5 },
  );
  // A document from the user's own device has none of this.
  const file = parseDocumentBlocks(composeMessageWithDocuments("q", [{ name: "notes.txt", text: "hi" }])).documents[0];
  assert.ok(!("source" in file));
  assert.ok(!buildDocumentBlock({ name: "notes.txt", text: "hi", url: "https://x.example.com" }).includes("url="));
});

test("Veil masks the question, never the page's text", () => {
  const state = createVeilState();
  const { request, masked } = buildChatRequest({
    text: "Is my address rosa@private.example on https://news.example.com/article ?",
    documents: [page],
    veilWith: { state, words: [] },
  });
  const sent = request.at(-1).content;
  assert.ok(!sent.includes("rosa@private.example"), "the question's email is masked");
  assert.ok(sent.includes("press@garden.example"), "the page's email is left as it is");
  assert.ok(sent.includes("+1 415 555 0100"));
  assert.equal(masked, 1);
  // Without a link block, masking is exactly as before.
  assert.equal(maskOutsideLinks("a b", (s) => s.toUpperCase()), "A B");
  const mixed = maskOutsideLinks("q1 " + buildDocumentBlock(page) + " q2", (s) => s.toUpperCase());
  assert.ok(mixed.startsWith("Q1 <document") && mixed.endsWith(" Q2"));
  assert.ok(mixed.includes("press@garden.example"));
  // A file's document block is masked as always.
  const own = buildDocumentBlock({ name: "mine.txt", text: "me@private.example" });
  assert.ok(!maskOutsideLinks(own, (s) => s.replace("me@private.example", "[EMAIL_1]")).includes("me@private.example"));
});

test("Seed Guard skips a read page's text, but still checks what the user typed", () => {
  const withPage = { body: { messages: [{ role: "user", content: composeMessageWithDocuments("Explain this page", [page]) }] } };
  const typed = { body: { messages: [{ role: "user", content: composeMessageWithDocuments(SEED, [page]) }] } };
  const file = { body: { messages: [{ role: "user", content: composeMessageWithDocuments("q", [{ name: "wallet.txt", text: SEED }]) }] } };
  const cfg = (released) => ({ released });
  // Released: the page is skipped.
  assert.doesNotThrow(() => refuseSeedPhrase(cfg("all"), withPage, false));
  assert.throws(() => refuseSeedPhrase(cfg("all"), typed, false), { code: "seed_phrase_blocked" });
  assert.throws(() => refuseSeedPhrase(cfg("all"), file, false), { code: "seed_phrase_blocked" });
  // The /v1 API never skips anything, and before release nothing is skipped.
  assert.throws(() => refuseSeedPhrase(cfg("all"), withPage, true), { code: "seed_phrase_blocked" });
  assert.throws(() => refuseSeedPhrase(cfg(new Set(["seedguard", "documents"])), withPage, false), { code: "seed_phrase_blocked" });
  assert.equal(stripLinkBlocks("before " + buildDocumentBlock(page) + " after"), "before  after");
  // The browser skips it too.
  const ws = readFileSync(new URL("../src/Workspace.jsx", import.meta.url), "utf8");
  assert.match(ws, /documents\.filter\(\(d\) => d\.source !== "link"\)\.map\(\(d\) => d\.text \|\| ""\)/);
});

// ---- The chips and the card ----

async function uiModule() {
  const src = new URL("../src/LinkReader.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const dir = mkdtempSync(join(tmpdir(), "anonyma-linkreader-ui-"));
  const react = import.meta.resolve("react");
  const stub = (name, body) => {
    writeFileSync(join(dir, name), `import React from "${react}";\n` + body);
    return pathToFileURL(join(dir, name)).href;
  };
  const ui = stub("ui.mjs", `export const Icon = () => React.createElement("svg");`);
  const lib = stub("lib.mjs", `export const api = async () => ({}); export const uid = () => "id";`);
  const pdf = stub("pdf.mjs", `export const pdfText = async () => ({ text: "", pages: 0 });`);
  const out = code
    .replace(/^import "\.\/link-reader\.css";$/m, "")
    .replace(/from "\.\/ui\.jsx"/g, `from "${ui}"`)
    .replace(/from "\.\/lib\.js"/g, `from "${lib}"`)
    .replace(/from "\.\/pdf-text\.js"/g, `from "${pdf}"`)
    .replace(/from "\.\/(documents|link-reader)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${react}"`);
  const file = join(dir, "LinkReader.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s.replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function textsOf(html) {
  const stack = [],
    ui = [],
    kept = [];
  for (const [, tag, text] of html.matchAll(/(<[^>]+>)|([^<]+)/g)) {
    if (tag) {
      const m = /^<(\/?)([a-z0-9]+)/i.exec(tag);
      if (!m) continue;
      const off = /data-i18n="off"/.test(tag);
      for (const [, attr] of tag.matchAll(/(?:aria-label|title)="([^"]*)"/g))
        (off || stack.some((x) => x.off) ? kept : ui).push(entities(attr));
      if (m[1]) stack.pop();
      else if (!tag.endsWith("/>")) stack.push({ off });
    } else {
      const t = entities(text).trim();
      if (t) (stack.some((x) => x.off) ? kept : ui).push(t);
    }
  }
  const words = (list) => list.filter((x) => /[A-Za-z]{2}/.test(x));
  return { ui: words(ui), kept: words(kept) };
}

test("the chip and the card: the site's words stay as they are, ANONYMA's are translated", async () => {
  const { LinkReaderChips, LinkCard } = await uiModule();
  const html = [
    renderToStaticMarkup(createElement(LinkReaderChips, { prompt: "What is https://news.example.com/article about?", documents: [], setDocuments() {} })),
    renderToStaticMarkup(createElement(LinkReaderChips, { prompt: "https://news.example.com/article", documents: [], setDocuments() {}, sealed: true })),
    renderToStaticMarkup(createElement(LinkReaderChips, { prompt: "https://news.example.com/article", documents: Array(5).fill({ name: "f" }), setDocuments() {} })),
    renderToStaticMarkup(createElement(LinkCard, { doc: { ...page, name: "Why onions have layers", words: 30000, truncated: true, text: capWords(Array(40000).fill("layer").join(" ")).text }, onRemove() {} })),
    // A saved message's page, trimmed to fit: the words that were sent.
    renderToStaticMarkup(createElement(LinkCard, { doc: { ...page, name: "Trimmed page", words: 9000, truncated: true, text: Array(7210).fill("word").join(" ") } })),
    renderToStaticMarkup(createElement(LinkCard, { doc: { ...page, name: "Tiny page", words: 12, pages: 3 } })),
  ].join("");
  assert.match(html, /Read this page/);
  assert.match(html, /Fetched by ANONYMA, not your browser/);
  assert.match(html, /A long page: only the first 30,000 words are attached\./);
  assert.match(html, /9,000 words/);
  assert.match(html, /A long page: only the first 7,210 words are attached\./);
  assert.match(html, /Link Reader is off in Sealed Mode/);
  assert.match(html, /Attach up to 5 documents per message\./);
  const { ui, kept } = textsOf(html);
  for (const text of ["Why onions have layers", "Trimmed page", "Tiny page", "news.example.com"]) assert.ok(kept.includes(text), text);
  assert.ok(!ui.some((x) => x.includes("onions") || x.includes("news.example.com")));
  for (const text of ui) assert.match(translateText(text, zh) ?? "", han, text);
  // A page already read offers no chip for its link.
  assert.equal(
    renderToStaticMarkup(createElement(LinkReaderChips, { prompt: "https://news.example.com/article", documents: [{ ...page, url: "https://news.example.com/article" }], setDocuments() {} })),
    "",
  );
});

test("Chinese: the update, the chip, the card and the errors the UI shows", () => {
  const entry = UPDATES.find((u) => u.id === "linkreader");
  for (const text of [
    entry.title,
    entry.tagline,
    ...entry.points,
    "Link Reader is coming soon.",
    "Reading…",
    "View text",
    "Hide text",
    "1 word",
    "1,896 words",
    "3 pages",
    "No readable text was found in that PDF. It may be a scanned image.",
    "Paste a full link that starts with http or https.",
    "Links with a username or password in them can't be read.",
    "Only links on the standard web ports (80 and 443) can be read.",
    "That link points to a private or local address, so ANONYMA won't read it.",
    "Couldn't reach that page. Check the link and try again.",
    "That page took longer than 10 seconds to load.",
    "That page took too long to read.",
    "That page is larger than 5 MB.",
    "Only web pages, plain text and PDFs can be read.",
    "That link redirected more than 3 times.",
    "The site didn't return the page.",
    "The site answered 404 instead of the page.",
    "Couldn't find readable text on that page.",
    "Another page is still being read. Try again in a moment.",
    "Couldn't read that page.",
    "Too many requests. Try again shortly.",
    "Link Reader: a page you ask it to read is fetched by ANONYMA’s server with no cookies and no referrer, so the site sees our server, not you. The link and the page are never logged or stored on their own; the page’s text is kept only inside your message, like an attached document, when the chat is saved.",
  ])
    assert.match(translateText(text, zh) ?? "", han, text);
});
