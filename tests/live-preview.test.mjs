import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { createApp } from "../server/app.js";
import { UPDATES, featuresFor } from "../server/releases.js";
import { PREVIEW_FRAME_HTML } from "../server/routes/preview.js";
import {
  securityHeaders,
  previewFrameHeaders,
  PREVIEW_CSP,
  PREVIEW_FRAME_PATH,
} from "../src/security-headers.js";
import {
  PREVIEW_SANDBOX,
  PREVIEW_MESSAGE,
  PREVIEW_SHIM,
  PREVIEW_DEMO_REPLY,
  CONSOLE_KEEP,
  CONSOLE_TEXT,
  VIEWPORTS,
  assemblePreview,
  assembleSnippet,
  appendConsole,
  codeBlocks,
  dataUrl,
  latestFiles,
  normalizePath,
  noteText,
  previewPages,
  projectFiles,
  readConsoleMessage,
  readOpenMessage,
  isShimNotice,
  resolveRef,
  safeJson,
  scriptText,
  styleText,
} from "../src/live-preview.js";
import { compileDictionary, translateText } from "../src/i18n.js";

// Release commits flip `released` on UPDATES entries. The gate tests below
// pin every update to unreleased for this file, so they keep passing after
// the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const ORIGIN = "http://127.0.0.1:5175";
async function fixture(t, released = "all") {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-preview-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    catalogPath: join(dir, "models.json"),
    origin: ORIGIN,
    released,
  });
  await svc.stopWork();
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
const directives = (csp) =>
  Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [name, ...values] = d.split(/\s+/);
        return [name, values];
      }),
  );
const assistant = (content) => ({ role: "assistant", content });
const PREAMBLE = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;
// The document with the policy, the DNS switch and the shim taken off.
function body(html) {
  const i = html.indexOf("</script>");
  return html.slice(i + "</script>".length);
}

// ---------------------------------------------------------------------------
// Release gate and the frame document
// ---------------------------------------------------------------------------

test("Live Preview is registered last, off by default, and its frame is gated", async (t) => {
  const entry = UPDATES.find((u) => u.id === "preview");
  assert.ok(entry, "preview is registered");
  assert.equal(entry.title, "Live Preview");
  assert.equal(typeof entry.tagline, "string");
  assert.equal(entry.points.length, 3);
  assert.ok(
    UPDATES.indexOf(entry) > UPDATES.findIndex((u) => u.id === "limits"),
    "added after the updates before it",
  );
  assert.equal(
    committed[UPDATES.indexOf(entry)],
    true,
    "released by its release commit",
  );
  for (const path of [
    "/preview-frame.html",
    "/PREVIEW-FRAME.HTML",
    "/Preview-Frame.html",
  ])
    assert.deepEqual(
      featuresFor({ path, method: "GET", body: {} }),
      ["preview"],
      path,
    );
  // Nothing else is gated on it: there is no preview API.
  assert.deepEqual(
    featuresFor({ path: "/api/preview", method: "GET", body: {} }),
    [],
  );

  const mvp = await fixture(t, "mvp");
  for (const path of ["/preview-frame.html", "/PREVIEW-FRAME.HTML"]) {
    const res = await request(mvp.app)
      .get(path)
      .set("Sec-Fetch-Dest", "iframe")
      .expect(403);
    assert.equal(res.body.error.code, "feature_unreleased");
    assert.equal(res.body.error.message, "Live Preview is coming soon.");
    assert.equal(res.headers["x-frame-options"], "DENY");
  }
  const config = (await request(mvp.app).get("/api/config").expect(200)).body;
  assert.equal(config.releases.features.preview, false);
  // Unreleased, the app's own policy is exactly what it was.
  const page = await request(mvp.app).get("/api/config");
  assert.equal(
    page.headers["content-security-policy"],
    securityHeaders()["Content-Security-Policy"],
  );
  assert.match(
    page.headers["content-security-policy"],
    /frame-src https:\/\/verify\.walletconnect\.com https:\/\/verify\.walletconnect\.org(;|$)/,
  );
  // No API route was added.
  const openapi = (await request(mvp.app).get("/api/openapi.json").expect(200))
    .body;
  assert.ok(!Object.keys(openapi.paths).some((p) => /preview/i.test(p)));

  // Released on its own: the frame needs nothing else.
  const own = await fixture(t, "mvp,preview");
  await request(own.app)
    .get(PREVIEW_FRAME_PATH)
    .set("Sec-Fetch-Dest", "iframe")
    .expect(200);
  assert.equal(
    (await request(own.app).get("/api/config")).body.releases.features.preview,
    true,
  );
});

test("released, the app may frame exactly one extra URL: the preview frame", async (t) => {
  const s = await fixture(t, "mvp,preview");
  const before = directives(securityHeaders()["Content-Security-Policy"]);
  for (const path of ["/api/config", "/api/missing", "/"]) {
    const res = await request(s.app).get(path);
    const now = directives(res.headers["content-security-policy"]);
    assert.deepEqual(now["frame-src"], [
      ORIGIN + PREVIEW_FRAME_PATH,
      ...before["frame-src"],
    ]);
    // Everything else is untouched: scripts stay same-origin, no eval.
    for (const [name, values] of Object.entries(before))
      if (name !== "frame-src") assert.deepEqual(now[name], values, name);
    assert.deepEqual(now["script-src"], ["'self'", "'wasm-unsafe-eval'"]);
    assert.deepEqual(now["frame-ancestors"], ["'none'"]);
    assert.equal(res.headers["x-frame-options"], "DENY");
  }
});

test("the frame document: a fixed page with its own sandbox and no network", async (t) => {
  const s = await fixture(t, "mvp,preview");
  for (const dest of ["iframe", undefined]) {
    const req = request(s.app).get(PREVIEW_FRAME_PATH);
    const res = await (dest ? req.set("Sec-Fetch-Dest", dest) : req).expect(
      200,
    );
    assert.equal(res.text, PREVIEW_FRAME_HTML);
    assert.match(res.headers["content-type"], /^text\/html/);
    const csp = res.headers["content-security-policy"];
    assert.equal(csp, previewFrameHeaders()["Content-Security-Policy"]);
    assert.ok(
      csp.startsWith("sandbox allow-scripts; "),
      "sandboxed even when opened on its own",
    );
    const d = directives(csp);
    assert.deepEqual(d.sandbox, ["allow-scripts"]);
    assert.deepEqual(d["default-src"], ["'none'"]);
    assert.deepEqual(d["connect-src"], ["'none'"]);
    assert.deepEqual(d["frame-src"], ["'none'"]);
    assert.deepEqual(d["form-action"], ["'none'"]);
    assert.deepEqual(d["frame-ancestors"], ["'self'"]);
    assert.equal(res.headers["x-frame-options"], "SAMEORIGIN");
    assert.equal(res.headers["referrer-policy"], "no-referrer");
    assert.equal(res.headers["x-dns-prefetch-control"], "off");
    assert.equal(res.headers["x-content-type-options"], "nosniff");
    assert.match(res.headers["permissions-policy"], /microphone=\(\)/);
    assert.equal(res.headers["set-cookie"], undefined);
  }
  await request(s.app).head(PREVIEW_FRAME_PATH).expect(200);
  // Never a tab, a script or an image: only ever a frame.
  for (const dest of ["document", "script", "image", "empty"])
    await request(s.app)
      .get(PREVIEW_FRAME_PATH)
      .set("Sec-Fetch-Dest", dest)
      .expect(404);
  // It asks only its parent for a document, accepts it only from its parent
  // on the app's own origin, once, and has no network code of its own.
  assert.match(
    PREVIEW_FRAME_HTML,
    /event\.source !== parent \|\| event\.origin !== origin/,
  );
  assert.match(PREVIEW_FRAME_HTML, /removeEventListener\("message", receive\)/);
  assert.match(
    PREVIEW_FRAME_HTML,
    /parent\.postMessage\(\{ type: "anonyma-preview:ready" \}, origin\)/,
  );
  assert.doesNotMatch(
    PREVIEW_FRAME_HTML,
    /fetch|XMLHttpRequest|WebSocket|eval|innerHTML|srcdoc/,
  );
  assert.ok(PREVIEW_FRAME_HTML.includes(`"${PREVIEW_MESSAGE.render}"`));
});

// ---------------------------------------------------------------------------
// The sandbox attribute and the preview policy
// ---------------------------------------------------------------------------

test('a preview frame only ever gets sandbox="allow-scripts"', async () => {
  assert.equal(PREVIEW_SANDBOX, "allow-scripts");
  // Every sandbox attribute in the client is the constant, and nothing sets
  // one at runtime.
  const dir = new URL("../src/", import.meta.url);
  for (const name of readdirSync(dir)) {
    if (!/\.(jsx?|mjs)$/.test(name)) continue;
    const src = readFileSync(new URL(name, dir), "utf8");
    for (const m of src.matchAll(
      /\bsandbox\s*=\s*(\{[^}]*\}|"[^"]*"|'[^']*')/g,
    ))
      assert.equal(m[1], "{PREVIEW_SANDBOX}", `${name}: ${m[0]}`);
    assert.doesNotMatch(src, /setAttribute\(\s*["']sandbox/i, name);
    assert.doesNotMatch(src, /\.sandbox\s*(=|\.add)/, name);
  }
  // The rendered panel: one frame, that one token, the frame URL, no srcdoc.
  const { LivePreview } = await panelModule();
  const html = renderToStaticMarkup(
    createElement(LivePreview, {
      files: [{ path: "index.html", content: "<h1>Hi</h1>" }],
    }),
  );
  const frames = html.match(/<iframe\b[^>]*>/g) || [];
  assert.equal(frames.length, 1);
  assert.match(frames[0], / sandbox="allow-scripts"/);
  assert.match(frames[0], / src="\/preview-frame\.html"/);
  assert.doesNotMatch(
    frames[0],
    /srcdoc|allow=|allowfullscreen|allow-same-origin|allow-top|allow-popups|allow-forms|allow-modals/i,
  );
});

test("the preview policy refuses the network and everything outside the page", () => {
  const d = directives(PREVIEW_CSP);
  assert.deepEqual(d, {
    "default-src": ["'none'"],
    "script-src": ["'unsafe-inline'", "blob:"],
    "style-src": ["'unsafe-inline'", "blob:"],
    "img-src": ["data:", "blob:"],
    "font-src": ["data:", "blob:"],
    "media-src": ["data:", "blob:"],
    "connect-src": ["'none'"],
    "frame-src": ["'none'"],
    "worker-src": ["'none'"],
    "form-action": ["'none'"],
    "base-uri": ["'none'"],
  });
  assert.doesNotMatch(PREVIEW_CSP, /'unsafe-eval'|'self'|https?:|\*|"|&|</);
  assert.ok(
    previewFrameHeaders()["Content-Security-Policy"].includes(PREVIEW_CSP),
  );
});

test("the policy <meta> is always the first element of a preview", () => {
  const hostile = [
    "",
    "<p>fragment</p>",
    "<!DOCTYPE html><html><head><title>t</title></head><body>x</body></html>",
    "\uFEFF<!doctype html>\n<html lang=en><body>bom</body></html>",
    "<!-- lead --><!DOCTYPE html><html><body>c</body></html>",
    "<html><head></head><body>no doctype</body></html>",
    '<meta http-equiv="Content-Security-Policy" content="script-src * \'unsafe-eval\'">',
    "</head></html><meta http-equiv=refresh content=0;url=https://evil.test>",
    "<!--",
    "<plaintext>",
    "<script>",
    "<style>",
    "<xmp><title><textarea>",
    "<noscript><template><iframe>",
    "<svg><script>alert(1)</script></svg>",
    '<base href="https://evil.test/"><script src="app.js"></script>',
    "\u0000<\u0000script>",
    "<![CDATA[ x",
    '"><script>alert(1)</script>',
    '<html><head><meta charset="x"><meta http-equiv="Content-Security-Policy" content="default-src *"></head></html>',
  ];
  for (const source of hostile) {
    const { html } = assemblePreview({
      files: [{ path: "index.html", content: source }],
      origin: ORIGIN,
    });
    const rest = html.startsWith("<!DOCTYPE html>") ? html.slice(15) : html;
    assert.ok(rest.startsWith(PREAMBLE), JSON.stringify(source));
    // The shim follows, whole, before anything from the page.
    assert.ok(
      rest.startsWith(
        PREAMBLE +
          '<meta http-equiv="x-dns-prefetch-control" content="off"><script>(function (c) {',
      ),
      JSON.stringify(source),
    );
    // Standards mode unless the page is a whole document without a doctype.
    const expectDoctype =
      /<!doctype/i.test(source) || !/<html[\s>]/i.test(source);
    assert.equal(
      html.startsWith("<!DOCTYPE html>"),
      expectDoctype,
      JSON.stringify(source),
    );
  }
});

test("the shim runs on one line and its settings can't break out of it", () => {
  assert.doesNotMatch(PREVIEW_SHIM, /\n/);
  assert.doesNotThrow(() => new Function(`return (${PREVIEW_SHIM})`));
  const evil = "</script><script>alert(1)</script><!--";
  const { html } = assemblePreview({
    files: [{ path: `a${evil}.html`, content: "<p>x</p>" }],
    origin: evil,
  });
  const shim = html.slice(0, html.indexOf("</script>"));
  assert.doesNotMatch(shim, /<\/script|<!--|<script>alert/i);
  assert.equal(
    safeJson("</script>\u2028&"),
    '"\\u003c/script\\u003e\\u2028\\u0026"',
  );
  // It never hands the page anything of the app's: only the frame path, the
  // app's origin (to post to) and the project's page names.
  const settings = JSON.parse(
    html
      .match(/\}\)\((\{.*?\})\);<\/script>/)[1]
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">")
      .replace(/\\u0026/g, "&"),
  );
  assert.deepEqual(Object.keys(settings).sort(), [
    "dir",
    "entry",
    "frame",
    "limit",
    "max",
    "open",
    "origin",
    "pages",
    "type",
  ]);
});

// ---------------------------------------------------------------------------
// Assembling a project
// ---------------------------------------------------------------------------

test("a page's own CSS, JS, SVG and images are inlined from the project", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>';
  const files = [
    {
      path: "index.html",
      content: `<!DOCTYPE html>
<html><head>
<link rel="stylesheet" href="css/site.css" media="screen">
<link rel="preconnect" href="https://fonts.example.test">
<link rel="dns-prefetch" href="//cdn.example.test">
<script src="./js/app.js?v=2" async integrity="sha384-x" crossorigin="anonymous"></script>
<script type="module" src="/js/mod.js"></script>
<script defer src="js/late.js"></script>
</head><body style="background: url('img/bg.svg')">
<img src="img/logo.svg" srcset="img/logo.svg 1x, img/logo.svg 2x" alt="logo">
<picture><source srcset="img/logo.svg"></picture>
<video poster="img/logo.svg"></video>
<svg><image href="img/logo.svg"/></svg>
<input type="image" src="img/logo.svg"> <input type="text" src="img/logo.svg">
<a href="about.html">About</a>
<script>var tag = "<img src='img/missing.png'>";</script>
<!-- <img src="img/commented.png"> -->
</body></html>`,
    },
    {
      path: "css/site.css",
      content:
        '@import url("parts/type.css") print;\nbody { color: red; }\n.x { background: url(../img/bg.svg) }\n/* url(img/in-comment.png) */\n.y::after { content: "</style><script>alert(1)</script>"; }',
    },
    {
      path: "css/parts/type.css",
      content:
        "h1 { font-family: serif; }\nh2 { background: url(../../img/logo.svg); }",
    },
    { path: "js/app.js", content: 'console.log("</script><!--");' },
    { path: "js/mod.js", content: "export const a = 1;" },
    { path: "js/late.js", content: "window.late = true;" },
    { path: "img/logo.svg", content: svg },
    { path: "img/bg.svg", content: svg },
    { path: "about.html", content: "<p>About</p>" },
  ];
  const r = assemblePreview({ files, origin: ORIGIN });
  assert.equal(r.entry, "index.html");
  assert.deepEqual(r.pages, ["index.html", "about.html"]);
  const b = body(r.html);
  const uri = dataUrl("img/logo.svg", svg);
  assert.ok(uri.startsWith("data:image/svg+xml;base64,"));
  // Stylesheet: inlined, @import folded in (inside @media print), url()s
  // resolved against each stylesheet's own folder, comments left alone, and
  // nothing inside can close the element.
  assert.match(
    b,
    /<style data-preview-href="css\/site\.css" media="screen">@media print \{ h1 \{ font-family: serif; \}/,
  );
  assert.ok(b.includes(`h2 { background: url(${uri}); }`));
  assert.ok(
    b.includes(`.x { background: url(${dataUrl("img/bg.svg", svg)}) }`),
  );
  assert.ok(b.includes("/* url(img/in-comment.png) */"));
  assert.ok(b.includes('content: "<\\/style><script>alert(1)</script>"'));
  assert.equal((b.match(/<\/style>/g) || []).length, 1);
  // Hints to other hosts are dropped entirely.
  assert.doesNotMatch(b, /preconnect|dns-prefetch|example\.test/);
  // Scripts: inlined in place, attributes that no longer apply removed, the
  // text escaped, and named for error line numbers.
  assert.ok(
    b.includes(
      '<script>console.log("<\\/script><\\!--");\n//# sourceURL=js/app.js</script>',
    ),
  );
  assert.ok(
    b.includes(
      '<script type="module">export const a = 1;\n//# sourceURL=js/mod.js</script>',
    ),
  );
  assert.doesNotMatch(b, /integrity|crossorigin|async|\bsrc="\.?\/?js\//);
  // A deferred script runs after the page: moved to the end of <body>.
  assert.ok(
    b.includes(
      "<script>window.late = true;\n//# sourceURL=js/late.js</script></body></html>",
    ),
  );
  // Images, sources, posters, SVG images and image inputs.
  assert.ok(
    b.includes(`<img src="${uri}" srcset="${uri} 1x, ${uri} 2x" alt="logo">`),
  );
  assert.ok(b.includes(`<source srcset="${uri}">`));
  assert.ok(b.includes(`<video poster="${uri}">`));
  assert.ok(b.includes(`<image href="${uri}" />`));
  assert.ok(b.includes(`<input type="image" src="${uri}">`));
  assert.ok(
    b.includes('<input type="text" src="img/logo.svg">'),
    "only image inputs load a src",
  );
  assert.ok(
    b.includes(`<body style="background: url(${dataUrl("img/bg.svg", svg)})">`),
  );
  // Links stay (the shim handles clicks); script text and comments aren't touched.
  assert.ok(b.includes('<a href="about.html">About</a>'));
  assert.ok(
    b.includes(
      `var tag = "<img src='img/missing.png'>";\n//# sourceURL=index.html#script-1</script>`,
    ),
  );
  assert.ok(b.includes('<!-- <img src="img/commented.png"> -->'));
  assert.deepEqual(r.notes, []);
});

test("pages in folders resolve relative, root-relative and parent paths", () => {
  const files = [
    {
      path: "pages/about.html",
      content:
        '<link rel="stylesheet" href="../css/a.css"><script src="/js/b.js"></script><img src="../../../img/c.svg"><a href="../index.html">home</a>',
    },
    { path: "css/a.css", content: "p{color:blue}" },
    { path: "js/b.js", content: "1" },
    { path: "img/c.svg", content: "<svg/>" },
  ];
  const r = assemblePreview({
    files,
    entry: "pages/about.html",
    origin: ORIGIN,
  });
  assert.equal(r.entry, "pages/about.html");
  const b = body(r.html);
  assert.ok(
    b.includes('<style data-preview-href="css/a.css">p{color:blue}</style>'),
  );
  assert.ok(b.includes("<script>1\n//# sourceURL=js/b.js</script>"));
  assert.ok(
    b.includes(`<img src="${dataUrl("img/c.svg", "<svg/>")}">`),
    "../ past the root stays at the root, as in a URL",
  );
  assert.deepEqual(r.notes, []);
  // The shim knows the page's folder, to resolve links the same way.
  assert.match(r.html, /"dir":"pages\/"/);
});

test("missing and outside references are listed, never fetched or silent", () => {
  const files = [
    {
      path: "index.html",
      content: `<link rel="stylesheet" href="missing.css">
<link rel="stylesheet" href="https://fonts.example.test/css2?family=Inter">
<script src="gone.js"></script>
<script src="https://cdn.example.test/lib.js"></script>
<img src="nope.png" srcset="nope.png 2x">
<img src="HTTPS://images.example.test/a.jpg">
<div style="background:url(missing-bg.png)"></div>
<iframe src="about.html"></iframe><object data="x.pdf"></object><embed src="y.swf">
<svg><use href="sprite.svg#icon"/><use href="#local"/></svg>
<style>@import "gone.css"; .z { background: url(//cdn.example.test/z.png) }</style>`,
    },
    { path: "about.html", content: "<p>about</p>" },
  ];
  const r = assemblePreview({ files, origin: ORIGIN });
  const b = body(r.html);
  // Missing project files: nothing is requested at all.
  assert.ok(b.includes("<!-- missing: missing.css -->"));
  assert.ok(b.includes("<!-- missing: gone.js -->"));
  assert.doesNotMatch(b, /gone\.js"|missing\.css"/);
  assert.ok(b.includes('<img src="data:," srcset="data:, 2x">'));
  assert.ok(b.includes('style="background:url(&quot;data:,&quot;)"'));
  // Outside URLs stay as written: the sandbox refuses them.
  assert.ok(
    b.includes('<script src="https://cdn.example.test/lib.js"></script>'),
  );
  assert.ok(b.includes('href="https://fonts.example.test/css2?family=Inter"'));
  const text = r.notes.map(noteText);
  assert.deepEqual(text, [
    "Missing file: missing.css (referenced in index.html)",
    "Not loaded, the preview blocks network requests: https://fonts.example.test/css2?family=Inter",
    "Missing file: gone.js (referenced in index.html)",
    "Not loaded, the preview blocks network requests: https://cdn.example.test/lib.js",
    "Missing file: nope.png (referenced in index.html)",
    "Not loaded, the preview blocks network requests: HTTPS://images.example.test/a.jpg",
    "Missing file: missing-bg.png (referenced in index.html)",
    "Not shown in the preview: about.html",
    "Not shown in the preview: x.pdf",
    "Not shown in the preview: y.swf",
    "Not shown in the preview: sprite.svg#icon",
    "Missing file: gone.css (referenced in index.html)",
    "Not loaded, the preview blocks network requests: //cdn.example.test/z.png",
  ]);
});

test("names are matched ignoring case, then by a unique file name", () => {
  const files = [
    {
      path: "index.html",
      content:
        '<link rel="stylesheet" href="Style.CSS"><script src="js/app.js"></script><img src="logo.svg">',
    },
    { path: "style.css", content: "a{}" },
    { path: "src/app.js", content: "2" },
    { path: "a/logo.svg", content: "<svg/>" },
    { path: "b/logo.svg", content: "<svg/>" },
  ];
  const r = assemblePreview({ files });
  assert.ok(
    body(r.html).includes('<style data-preview-href="style.css">a{}</style>'),
  );
  assert.ok(
    body(r.html).includes("<script>2\n//# sourceURL=src/app.js</script>"),
  );
  assert.deepEqual(r.notes.map(noteText), [
    "Style.CSS matched to style.css by file name",
    "js/app.js matched to src/app.js by file name",
    "Missing file: logo.svg (referenced in index.html)",
  ]);
});

test("nested frames never load: removed from the page and guarded at run time", () => {
  const r = assemblePreview({
    files: [
      {
        path: "index.html",
        content:
          '<iframe srcdoc="<script>1</script>">x</iframe><div><template shadowrootmode="closed"><p>in</p><iframe src="a.html"></iframe></template></div>' +
          '<object data="x.pdf"><p>fallback</p></object><embed src="y.swf"><frame src="f.html"><FencedFrame></FencedFrame>',
      },
    ],
  });
  const b = body(r.html);
  assert.doesNotMatch(
    b,
    /<iframe|<frame\b|<object|<embed|<fencedframe|\sshadowrootmode=/i,
  );
  assert.ok(
    b.includes('<template data-preview-shadowrootmode="closed"><p>in</p>'),
  );
  assert.ok(
    b.includes("<p>fallback</p>"),
    "an object's fallback content stays",
  );
  assert.deepEqual(r.notes.map(noteText), [
    "Not shown in the preview: srcdoc",
    "Not shown in the preview: <template shadowrootmode>",
    "Not shown in the preview: a.html",
    "Not shown in the preview: x.pdf",
    "Not shown in the preview: y.swf",
    "Not shown in the preview: f.html",
    "Not shown in the preview: <fencedframe>",
  ]);
  // At run time the shim removes frames as they're added (shadow roots
  // included), keeps declarative shadow roots off, and removes WebRTC, which
  // no Content-Security-Policy covers. Checked in headless Chrome in
  // verify/attacks.mjs; here, that the pieces are there.
  for (const piece of [
    "new MutationObserver",
    '"iframe, frame, object, embed, portal, fencedframe"',
    "/shadowrootmode/gi",
    '"setHTMLUnsafe"',
    '"parseHTMLUnsafe"',
    '["write", "writeln"]',
    '"attachShadow"',
    "clonable: false",
    '"RTCPeerConnection", "webkitRTCPeerConnection"',
  ])
    assert.ok(PREVIEW_SHIM.includes(piece), piece);
});

test("module imports between files are flagged, not silently broken", () => {
  const r = assemblePreview({
    files: [
      {
        path: "index.html",
        content:
          '<script type="module" src="main.js"></script><script type="module">import "./x.js";</script>',
      },
      {
        path: "main.js",
        content: 'import { a } from "./util.js";\nconsole.log(a);',
      },
      { path: "util.js", content: "export const a = 1;" },
    ],
  });
  assert.deepEqual(r.notes.map(noteText), [
    "Module imports between files aren't resolved in the preview: main.js",
    "Module imports between files aren't resolved in the preview: index.html",
  ]);
  // Classic scripts and imports of full URLs aren't flagged.
  const ok = assemblePreview({
    files: [
      {
        path: "index.html",
        content:
          '<script type="module">import x from "https://cdn.test/x.js";</script><script>const importantThing = "./a.js";</script>',
      },
    ],
  });
  assert.deepEqual(
    ok.notes.filter((n) => n.kind === "module"),
    [],
  );
});

test("choosing the page: asked for, else index.html, else the first page", () => {
  const files = [
    { path: "b.html", content: "b" },
    { path: "docs/index.html", content: "d" },
    { path: "a.htm", content: "a" },
    { path: "style.css", content: "" },
  ];
  assert.deepEqual(previewPages(files), ["docs/index.html", "a.htm", "b.html"]);
  assert.equal(assemblePreview({ files }).entry, "docs/index.html");
  assert.equal(assemblePreview({ files, entry: "b.html" }).entry, "b.html");
  assert.equal(assemblePreview({ files, entry: "./b.html" }).entry, "b.html");
  assert.equal(
    assemblePreview({ files, entry: "style.css" }).entry,
    "docs/index.html",
  );
  assert.equal(
    assemblePreview({ files, entry: "nope.html" }).entry,
    "docs/index.html",
  );
  assert.equal(
    assemblePreview({ files: [...files, { path: "index.html", content: "i" }] })
      .entry,
    "index.html",
  );
  const none = assemblePreview({ files: [{ path: "app.js", content: "1" }] });
  assert.equal(none.html, null);
  assert.deepEqual(none.notes.map(noteText), ["No HTML page to preview yet."]);
  const big = assemblePreview({
    files: [{ path: "index.html", content: "x".repeat(2000) }],
    limit: 1000,
  });
  assert.equal(big.html, null);
  assert.deepEqual(big.notes.map(noteText), [
    "This page is too large to preview.",
  ]);
});

test("a single HTML block from a reply previews on its own", () => {
  const r = assembleSnippet(
    '<button onclick="count++">+1</button><link rel="stylesheet" href="style.css">',
    ORIGIN,
  );
  assert.equal(r.entry, "index.html");
  assert.ok(r.html.startsWith("<!DOCTYPE html>" + PREAMBLE));
  assert.deepEqual(r.notes.map(noteText), [
    "Missing file: style.css (referenced in index.html)",
  ]);
});

test("references resolve like URLs, and escaping keeps inlined text inert", () => {
  assert.deepEqual(resolveRef("#top"), { kind: "fragment" });
  assert.deepEqual(resolveRef("  "), { kind: "empty" });
  assert.deepEqual(resolveRef("data:image/png;base64,AA"), { kind: "inline" });
  assert.deepEqual(resolveRef("blob:null/1"), { kind: "inline" });
  assert.deepEqual(resolveRef("mailto:a@example.test"), { kind: "other" });
  assert.deepEqual(resolveRef("javascript:void 0"), { kind: "other" });
  assert.deepEqual(resolveRef("//cdn.test/x.js"), {
    kind: "external",
    url: "//cdn.test/x.js",
  });
  assert.deepEqual(resolveRef("wss://x.test"), {
    kind: "external",
    url: "wss://x.test",
  });
  assert.deepEqual(resolveRef("img/a%20b.png?v=1#x", "pages/"), {
    kind: "local",
    path: "pages/img/a b.png",
  });
  assert.deepEqual(resolveRef("/a.css", "pages/"), {
    kind: "local",
    path: "a.css",
  });
  assert.deepEqual(resolveRef("../../a.css", "pages/"), {
    kind: "local",
    path: "a.css",
  });
  assert.equal(normalizePath("./a//b/../c\\d.js"), "a/c/d.js");
  assert.equal(scriptText("a</SCRIPT>b<!--c"), "a<\\/SCRIPT>b<\\!--c");
  assert.equal(styleText("a</Style>b"), "a<\\/Style>b");
});

// ---------------------------------------------------------------------------
// Code & Build files
// ---------------------------------------------------------------------------

test("files take the names replies give them", () => {
  const reply = [
    "```html index.html\n<h1>1</h1>\n```",
    '```css title="css/site.css"\na{}\n```',
    "```javascript filename=hello.js\nexport const a = 1;\n```",
    "```js:src/app.js\n1\n```",
    "```about.html\n<p>about</p>\n```",
    "### `data.json`\n\n```json\n{}\n```",
    "**styles/extra.css**\n```css\nb{}\n```",
    "Save this as `tool.py`:\n```python\nprint(1)\n```",
    "worker.js:\n```js\n2\n```",
    "```html\n<!-- contact.html -->\n<p>c</p>\n```",
    "```css\n/* print.css */\nc{}\n```",
    "```jsx\n// IdeaCard.jsx — prepared demo example\nexport default 1;\n```",
    "Here's a **Node.js** server:\n```js\n3\n```",
    "Update `index.html` too:\n```css\nd{}\n```",
  ].join("\n\n");
  const files = projectFiles([
    { role: "user", content: "```html secret.html\nno\n```" },
    assistant(reply),
  ]);
  assert.deepEqual(
    files.map((f) => f.path),
    [
      "index.html",
      "css/site.css",
      "hello.js",
      "src/app.js",
      "about.html",
      "data.json",
      "styles/extra.css",
      "tool.py",
      "worker.js",
      "contact.html",
      "print.css",
      "IdeaCard.jsx",
      "script.js",
      "style.css",
    ],
  );
  assert.ok(files.every((f) => f.version === 1 && f.name === f.path));
  assert.equal(files[0].content, "<h1>1</h1>\n");
});

test("unnamed blocks take the names the page asks for, and revise them", () => {
  const first = assistant(
    'A page:\n\n```html\n<link rel="stylesheet" href="styles.css"><script src="app.js"></script>\n```\n\n```css\nbody{}\n```\n\n```js\nconsole.log(1)\n```',
  );
  const second = assistant("Bluer:\n\n```css\nbody{color:blue}\n```");
  const third = assistant(
    "```html\n<link rel=stylesheet href=styles.css><p>v2</p>\n```\n\n```html\n<p>second page</p>\n```",
  );
  const files = projectFiles([
    first,
    { role: "user", content: "bluer" },
    second,
    third,
  ]);
  assert.deepEqual(
    files.map((f) => [f.path, f.version]),
    [
      ["index.html", 1],
      ["styles.css", 1],
      ["app.js", 1],
      ["styles.css", 2],
      ["index.html", 2],
      ["page-2.html", 1],
    ],
  );
  const latest = latestFiles(files);
  assert.equal(
    latest.find((f) => f.path === "styles.css").content,
    "body{color:blue}\n",
  );
  const r = assemblePreview({ files });
  assert.ok(
    body(r.html).includes(
      '<style data-preview-href="styles.css">body{color:blue} </style>',
    ),
  );
  assert.ok(body(r.html).includes("<p>v2</p>"), "the newest page");
  assert.deepEqual(r.notes, []);
  // With nothing to go by: style.css, script.js, file-N.
  const plain = projectFiles([
    assistant(
      "```css\na{}\n```\n```css\nb{}\n```\n```js\n1\n```\n```\ntext\n```\n```rust\nfn main(){}\n```",
    ),
  ]);
  assert.deepEqual(
    plain.map((f) => f.path),
    ["style.css", "style-2.css", "script.js", "file-4.txt", "file-5.rs"],
  );
});

test("code blocks: fences, tildes, indentation, CRLF, and replies still streaming", () => {
  assert.deepEqual(
    codeBlocks("````md\n```js\nx\n```\n````").map((b) => b.content),
    ["```js\nx\n```\n"],
  );
  assert.deepEqual(
    codeBlocks("~~~css\na{}\n~~~").map((b) => b.info),
    ["css"],
  );
  assert.deepEqual(
    codeBlocks("1. Page:\n   ```html\n   <p>x</p>\n   ```").map(
      (b) => b.content,
    ),
    ["<p>x</p>\n"],
  );
  assert.deepEqual(
    codeBlocks("```html\r\n<p>x</p>\r\n```\r\n").map((b) => b.content),
    ["<p>x</p>\n"],
  );
  assert.deepEqual(codeBlocks("```html\n<p>still typing"), []);
  assert.deepEqual(codeBlocks("``` not`a fence\n```"), []);
  // The local test provider's code reply.
  const fixture =
    "**Local test provider** — this is a deterministic integration fixture, not a live model.\n\n```javascript filename=hello.js\nexport function greet(name) {\n  return `Hello, ${name}!`;\n}\n```\n\nThe file is available in the code panel.";
  assert.deepEqual(
    projectFiles([assistant(fixture)]).map((f) => f.path),
    ["hello.js"],
  );
});

test("the demo project runs whole in the preview", () => {
  const files = projectFiles([assistant(PREVIEW_DEMO_REPLY)]);
  assert.deepEqual(
    files.map((f) => f.path),
    ["index.html", "style.css", "script.js"],
  );
  const r = assemblePreview({ files, origin: ORIGIN });
  assert.equal(r.entry, "index.html");
  assert.deepEqual(r.notes, []);
  assert.match(r.html, /<style data-preview-href="style\.css">/);
  assert.match(r.html, /\/\/# sourceURL=script\.js<\/script>/);
});

// ---------------------------------------------------------------------------
// Messages from the frame
// ---------------------------------------------------------------------------

test("console lines from the frame are plain, capped text", () => {
  const type = PREVIEW_MESSAGE.console;
  assert.equal(readConsoleMessage(null), null);
  assert.equal(readConsoleMessage("x"), null);
  assert.equal(readConsoleMessage({ type: "other", text: "x" }), null);
  assert.deepEqual(readConsoleMessage({ type, level: "error", text: "boom" }), {
    level: "error",
    text: "boom",
  });
  assert.deepEqual(readConsoleMessage({ type, level: "<b>", text: "x" }), {
    level: "log",
    text: "x",
  });
  assert.deepEqual(
    readConsoleMessage({ type, level: "log", text: { toString: "x" } }),
    { level: "log", text: "" },
  );
  assert.deepEqual(readConsoleMessage({ type, level: "log", text: 42 }), {
    level: "log",
    text: "",
  });
  const markup = '<img src=x onerror="alert(1)">';
  assert.equal(
    readConsoleMessage({ type, text: markup }).text,
    markup,
    "kept as text, rendered as text",
  );
  assert.equal(
    readConsoleMessage({ type, text: "y".repeat(CONSOLE_TEXT + 50) }).text
      .length,
    CONSOLE_TEXT + 1,
  );
  let state = { lines: [], dropped: 0 };
  for (let i = 0; i < 3; i++)
    state = appendConsole(
      state,
      Array.from({ length: 100 }, (_, j) => ({
        level: "log",
        text: `${i}.${j}`,
      })),
    );
  assert.equal(state.lines.length, CONSOLE_KEEP);
  assert.equal(state.dropped, 300 - CONSOLE_KEEP);
  assert.equal(state.lines.at(-1).text, "2.99");
});

test("only the shim's own notices are shown translated; page output never is", () => {
  for (const text of [
    "Nested frames aren't shown in the preview.",
    "Storage here is temporary and separate from ANONYMA.",
    "Console output stopped after 500 messages.",
    "Links don't leave the preview: about:blank",
    "Blocked by the preview sandbox: inline (script-src-attr)",
  ])
    assert.equal(isShimNotice(text), true, text);
  for (const text of [
    "Error",
    "Links don't leave the preview: a b",
    "alert: hi",
    "Uncaught Error: x (index.html)",
    "Nested frames aren't shown in the preview. Really",
  ])
    assert.equal(isShimNotice(text), false, text);
  // Every notice the shim can send is one of them.
  for (const m of PREVIEW_SHIM.matchAll(
    /send\("(?:blocked|info|warn)", "([^"]+)"\)/g,
  ))
    assert.ok(isShimNotice(m[1]), m[1]);
});

test("a preview link can only ask for one of the project's own pages", () => {
  const pages = ["index.html", "pages/about.html"];
  assert.equal(
    readOpenMessage(
      { type: PREVIEW_MESSAGE.open, path: "pages/about.html" },
      pages,
    ),
    "pages/about.html",
  );
  for (const path of [
    "../secret.html",
    "https://evil.test/",
    "about.html",
    1,
    null,
  ])
    assert.equal(
      readOpenMessage({ type: PREVIEW_MESSAGE.open, path }, pages),
      null,
    );
  assert.equal(
    readOpenMessage(
      { type: PREVIEW_MESSAGE.console, path: "index.html" },
      pages,
    ),
    null,
  );
});

test("viewports: the pane's own width, then desktop, tablet and phone widths", () => {
  assert.deepEqual(
    VIEWPORTS.map((v) => [v.id, v.width]),
    [
      ["fit", null],
      ["desktop", 1280],
      ["tablet", 768],
      ["phone", 375],
    ],
  );
});

// ---------------------------------------------------------------------------
// The panel, in Chinese too
// ---------------------------------------------------------------------------

// The panel compiled for Node with the esbuild Vite uses; ui.jsx and the
// icons are swapped for plain stand-ins so only its own text is rendered.
async function panelModule() {
  const src = new URL("../src/LivePreview.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(
    readFileSync(src, "utf8"),
    src.pathname,
    {
      jsx: "transform",
      format: "esm",
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "anonyma-preview-ui-"));
  writeFileSync(
    join(dir, "ui.mjs"),
    `import React from "${import.meta.resolve("react")}";
     export const Icon = () => null;
     export const Modal = ({ title, children }) => React.createElement("dialog", { "aria-label": title }, children);`,
  );
  writeFileSync(
    join(dir, "icons.mjs"),
    "export const Maximize2 = () => null, Monitor = () => null, Tablet = () => null, Smartphone = () => null;",
  );
  const out = code
    .replace(/^import "\.\/live-preview\.css";$/m, "")
    .replace(
      /from "\.\/ui\.jsx"/g,
      `from "${pathToFileURL(join(dir, "ui.mjs")).href}"`,
    )
    .replace(
      /from "lucide-react"/g,
      `from "${pathToFileURL(join(dir, "icons.mjs")).href}"`,
    )
    .replace(
      /from "\.\/i18n\.js"/g,
      `from "${new URL("../src/i18n.js", import.meta.url)}"`,
    )
    .replace(
      /from "\.\/live-preview\.js"/g,
      `from "${new URL("../src/live-preview.js", import.meta.url)}"`,
    )
    .replace(/from "react"/g, `from "${import.meta.resolve("react")}"`);
  const file = join(dir, "LivePreview.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const entities = (s) =>
  s
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

test("every word Live Preview shows has a Chinese translation", async () => {
  const dict = compileDictionary(
    JSON.parse(
      readFileSync(new URL("../src/i18n/zh.json", import.meta.url), "utf8"),
    ),
  );
  const { LivePreview, CodePanelTabs } = await panelModule();
  const html =
    renderToStaticMarkup(
      createElement(LivePreview, {
        files: [
          {
            path: "index.html",
            content:
              '<link rel="stylesheet" href="x.css"><script src="https://cdn.test/a.js"></script>',
          },
          { path: "about.html", content: "<p>a</p>" },
        ],
      }),
    ) +
    renderToStaticMarkup(
      createElement(LivePreview, { files: [{ path: "a.js", content: "1" }] }),
    ) +
    renderToStaticMarkup(
      createElement(CodePanelTabs, { tab: "preview", onTab() {} }),
    );
  // Text the translator skips: data-i18n="off" (page names, sizes, output).
  const visible = html.replace(
    /<(\w+)[^>]*data-i18n="off"[^>]*>[\s\S]*?<\/\1>/g,
    "",
  );
  const texts = [
    ...visible.split(/<[^>]+>/),
    ...[
      ...visible.matchAll(/(?:title|aria-label|placeholder|alt)="([^"]*)"/g),
    ].map((m) => m[1]),
  ]
    .map((s) => entities(s).trim())
    .filter((s) => /[A-Za-z]{2}/.test(s));
  for (const must of [
    "Files",
    "Preview",
    "Fit",
    "Desktop",
    "Tablet",
    "Phone",
    "Reload",
    "Console",
    "2 notes",
    "No HTML page to preview yet.",
  ])
    assert.ok(texts.includes(must), must);
  for (const text of texts)
    assert.match(
      translateText(text, dict) ?? "",
      /\p{Script=Han}/u,
      `untranslated: ${text}`,
    );
  // Everything else it can say: every note, the rest of the console, the
  // tab-strip label, the release copy and the code panel's line.
  const entry = UPDATES.find((u) => u.id === "preview");
  for (const text of [
    ...[
      "missing",
      "external",
      "matched",
      "module",
      "unsupported",
      "no-html",
      "too-large",
    ].map((kind) =>
      noteText({
        kind,
        ref: "css/site.css",
        from: "index.html",
        path: "site.css",
      }),
    ),
    "1 note",
    "12 notes",
    "35 earlier lines not shown",
    "Nothing logged yet.",
    "Clear",
    "Log",
    "Info",
    "Debug",
    "Warning",
    "Error",
    "Blocked",
    "Live preview",
    entry.title,
    entry.tagline,
    ...entry.points,
    "Prepared code · HTML runs only in the sandboxed Preview",
    // The shim's notices in the console (the page's own output isn't translated).
    "Nested frames aren't shown in the preview.",
    "This page hid a nested frame, so the preview stopped it.",
    "Storage here is temporary and separate from ANONYMA.",
    "Forms don't send anywhere in the preview.",
    "Console output stopped after 500 messages.",
    "Links don't leave the preview: https://example.test/",
    "Blocked by the preview sandbox: http://127.0.0.1:3479/fetch (connect-src)",
  ])
    assert.match(
      translateText(text, dict) ?? "",
      /\p{Script=Han}/u,
      `untranslated: ${text}`,
    );
});

test("the workspace shows none of it until the update is released", () => {
  const src = readFileSync(
    new URL("../src/Workspace.jsx", import.meta.url),
    "utf8",
  );
  assert.match(src, /const previewLive = isReleased\(config, "preview"\);/);
  assert.match(src, /useHtmlPreview\(previewLive && textMode\)/);
  assert.match(
    src,
    /const files = previewLive\s*\?\s*projectFiles\(messages\)/,
  );
  assert.match(src, /\{previewLive && <CodePanelTabs /);
  assert.match(src, /previewLive \? PREVIEW_DEMO_REPLY : sampleCode/);
  assert.match(
    src,
    /const previewing = previewLive && codePanelTab === "preview";/,
  );
  // The unreleased panel line is unchanged.
  assert.match(src, /: "Prepared code · no execution sandbox"/);
});
