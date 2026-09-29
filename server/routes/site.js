import express from "express";
import { knownPage, sitemap, robots } from "../../src/site-routes.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "../core.js";
import { connectLive, isReleased } from "../releases.js";
import { configurationStatus } from "../readiness.js";
import { PYTHON_WORKER_FILE, pythonWorkerCsp } from "../../src/python-assets.js";
import {
  publicDocumentation,
  publicDiscovery,
} from "../public-documentation.js";
import {
  cliDownload,
  shellInstaller,
  powershellInstaller,
} from "../installers.js";

// Health, machine-readable docs, installers and the built web client.
export function siteRoutes({ app, db, cfg }) {
  // Gated pages this installation serves: the Connect an App consent page,
  // the public NYMA page (/token), Panic Wipe's "Wiped" page, the
  // workspace's Sheets, On-device, Study and Compare pages, Model Status'
  // page, Gift Links claim page and Blind Arena exist only once released.
  // workspace's Sheets, On-device, Study, Compare and Canvas pages and Model
  // workspace's Sheets, On-device, Study, Compare and Slides pages and Model
  // Status' page exist only once their update is live.
  const served = () => ({
    connect: connectLive(cfg),
    token: isReleased(cfg, "holders"),
    wipe: isReleased(cfg, "wipe"),
    sheets: isReleased(cfg, "sheets"),
    // Model Status' public page (/status).
    status: isReleased(cfg, "status"),
    // Blind Arena's public leaderboard (/arena), built on Blind Compare.
    arena: isReleased(cfg, "arena") && isReleased(cfg, "blind"),
    ondevice: isReleased(cfg, "ondevice"),
    study: isReleased(cfg, "study"),
    compare: isReleased(cfg, "doccompare"),
    // Gift Links' claim page (/gift), never in the sitemap.
    gift: isReleased(cfg, "giftlinks"),
    canvas: isReleased(cfg, "canvas"),
    slides: isReleased(cfg, "slides"),
    translate: isReleased(cfg, "doctranslate"),
    // Meeting Notes' page, which transcribes with Voice & Audio's models.
    notes: isReleased(cfg, "meetingnotes") && isReleased(cfg, "audio"),
    // Chat Import's page (/workspace/import).
    chatimport: isReleased(cfg, "chatimport"),
    // Photo Tools' page, which runs on the image models.
    photos: isReleased(cfg, "phototools") && isReleased(cfg, "images"),
    // File Search's page, which searches saved files' text.
    filesearch: isReleased(cfg, "filesearch") && isReleased(cfg, "files") && isReleased(cfg, "documents"),
  });
  const build = existsSync("dist/client/version.json")
    ? JSON.parse(readFileSync("dist/client/version.json", "utf8"))
    : { commit: null, dirty: null, builtAt: null };
  app.get("/health", (req, res) =>
    res.json({
      ok: true,
      build,
      mode: cfg.testMode ? "local-test" : "live",
      database: !!db.prepare("SELECT 1").get(),
      integrations: configurationStatus(cfg).configured,
      ready: configurationStatus(cfg).requiredConfigured,
    }),
  );
  app.get("/sitemap.xml", (req, res) =>
    res.type("application/xml").send(sitemap(cfg.origin, served())),
  );
  app.get("/robots.txt", (req, res) =>
    res.type("text/plain").send(robots(cfg.origin)),
  );
  app.get("/llms.txt", (req, res) =>
    res.type("text").send(publicDiscovery(cfg)),
  );
  app.get("/llms-full.txt", (req, res) =>
    res.type("text").send(publicDocumentation(cfg)),
  );
  app.get("/install.sh", (req, res) =>
    res.type("text").send(shellInstaller(cfg)),
  );
  app.get("/install.ps1", (req, res) =>
    res.type("text").send(powershellInstaller(cfg)),
  );
  app.get("/cli.mjs", (req, res) => res.type("text").send(cliDownload(cfg)));
  app.use("/api", (req, res) => fail(404, "API route not found."));
  if (existsSync("dist/client")) {
    app.use(
      express.static("dist/client", {
        index: false,
        redirect: false,
        // The service worker file itself should always be revalidated, so a
        // new deploy's worker is never served stale from an intermediate
        // cache. Vite fingerprints every /assets file name, so a changed file
        // always gets a new URL and browsers can keep the old one. Local
        // OCR's files under /ocr/ and Python Runner's under /pyodide/ sit
        // in versioned directories that are never reused for other contents
        // (src/ocr-assets.js, src/python-assets.js), so they're cached the
        // same way. Every other static file keeps express.static's
        // defaults.
        setHeaders(res, path) {
          if (path.endsWith("/sw.js")) res.set("Cache-Control", "no-cache");
          else if (
            path.includes("/dist/client/assets/") ||
            path.includes("/dist/client/ocr/") ||
            path.includes("/dist/client/pyodide/")
          )
            res.set("Cache-Control", "public, max-age=31536000, immutable");
          // Python's files are for this site's own Python worker only.
          if (path.includes("/dist/client/pyodide/")) {
            res.set("Cross-Origin-Resource-Policy", "same-origin");
            if (path.endsWith(".whl")) res.set("Content-Type", "application/octet-stream");
          }
          // Python Runner's worker gets its own, stricter policy: it may
          // load and fetch Pyodide's files and nothing else.
          if (PYTHON_WORKER_FILE.test(path))
            res.set("Content-Security-Policy", pythonWorkerCsp(cfg.origin));
        },
      }),
    );
    app.get("/{*path}", (req, res) =>
      res
        .status(knownPage(req.path, served()) ? 200 : 404)
        .sendFile("index.html", { root: resolve("dist/client") }),
    );
  }
}
