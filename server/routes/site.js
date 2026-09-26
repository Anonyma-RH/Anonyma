import express from "express";
import { knownPage, sitemap, robots } from "../../src/site-routes.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "../core.js";
import { connectLive, isReleased } from "../releases.js";
import { configurationStatus } from "../readiness.js";
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
  // the public NYMA page (/token), Panic Wipe's "Wiped" page and the
  // workspace's Sheets page exist only once their update is live.
  const served = () => ({
    connect: connectLive(cfg),
    token: isReleased(cfg, "holders"),
    wipe: isReleased(cfg, "wipe"),
    sheets: isReleased(cfg, "sheets"),
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
        // always gets a new URL and browsers can keep the old one. Every other
        // static file keeps express.static's defaults.
        setHeaders(res, path) {
          if (path.endsWith("/sw.js")) res.set("Cache-Control", "no-cache");
          else if (path.includes("/dist/client/assets/"))
            res.set("Cache-Control", "public, max-age=31536000, immutable");
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
