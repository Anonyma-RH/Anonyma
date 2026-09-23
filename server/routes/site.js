import express from "express";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fail } from "../core.js";
import { configurationStatus } from "../readiness.js";
import { publicDocumentation } from "../public-documentation.js";
import {
  cliDownload,
  shellInstaller,
  powershellInstaller,
} from "../installers.js";

// Health, machine-readable docs, installers and the built web client.
export function siteRoutes({ app, db, cfg }) {
  app.get("/health", (req, res) =>
    res.json({
      ok: true,
      mode: cfg.testMode ? "local-test" : "live",
      database: !!db.prepare("SELECT 1").get(),
      integrations: configurationStatus(cfg).configured,
      ready: configurationStatus(cfg).requiredConfigured,
    }),
  );
  app.get("/llms.txt", (req, res) =>
    res
      .type("text")
      .send(
        "# Anonyma\nPrepaid model gateway.\n- Documentation: /docs\n- API: /v1\n- Full documentation: /llms-full.txt\n",
      ),
  );
  app.get("/llms-full.txt", (req, res) =>
    res.type("text").send(publicDocumentation()),
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
    app.use(express.static("dist/client"));
    app.get("/*path", (req, res) =>
      res.sendFile(resolve("dist/client/index.html")),
    );
  }
}
