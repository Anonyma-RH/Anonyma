import { Worker } from "node:worker_threads";
import { fail } from "../core.js";
import { fetchLink, bodyText, LinkError, LINK_LIMITS } from "../link-reader.js";
import { extractPlain, fileName } from "../link-extract.js";
import { LINK_READER } from "../../src/link-reader.js";

// Link Reader: POST /api/read { url } fetches one public page on the
// account's behalf, so the site sees this server (no cookies, no Referer, a
// generic User-Agent) and never the person's browser or IP. The SSRF rules
// are in server/link-reader.js; extraction runs in a worker thread
// (link-extract-worker.js) with a time and memory limit.
//
// Free, and limited to 60 reads an hour per account, with at most 2 at once
// per account and 8 across the server. Nothing is stored and nothing is
// logged: not the link, its host, the page or the error (every failure is an
// ordinary 4xx/5xx with a fixed message, which the error handler never
// logs). The page's text goes back to the browser, which attaches it to the
// message like a document; only that message is ever saved, as any chat's
// is. PDFs are returned as bytes for the browser's own PDF text extraction
// (the one Documents uses). The release gate (featuresFor) refuses the
// route until Link Reader and Documents are both released.

const PER_ACCOUNT = 2,
  PER_SERVER = 8,
  EXTRACT_MS = 8000;
const WORKER = new URL("../link-extract-worker.js", import.meta.url);

function runExtraction(html, host) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER, {
      workerData: { html, host },
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 48 },
    });
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.terminate().catch(() => {});
      fn(value);
    };
    const timer = setTimeout(
      () => done(reject, new LinkError(504, "link_timeout", "That page took too long to read.")),
      EXTRACT_MS,
    );
    worker.once("message", (m) =>
      m && !m.error ? done(resolve, m) : done(reject, new LinkError(422, "link_unreadable", "Couldn't find readable text on that page.")),
    );
    worker.once("error", () => done(reject, new LinkError(422, "link_unreadable", "Couldn't find readable text on that page.")));
    worker.once("exit", () => done(reject, new LinkError(422, "link_unreadable", "Couldn't find readable text on that page.")));
  });
}

export function linkReaderRoutes(ctx) {
  const { app, cfg, limit, requireUser } = ctx;
  const hourly = limit("linkreader", LINK_READER.perHour, 3600000);
  const active = new Map();
  let total = 0;
  // Tests inject the resolver and point the connection at a local server;
  // both only in local test mode (see fetchLink).
  const hooks = cfg.testMode ? cfg.linkReader || {} : {};

  app.post("/api/read", requireUser, hourly, async (req, res) => {
    const input = req.body?.url;
    if (typeof input !== "string" || !input.trim() || input.length > LINK_LIMITS.maxUrl)
      fail(400, "Paste a full link that starts with http or https.", "link_invalid");
    const user = req.user.id;
    if ((active.get(user) || 0) >= PER_ACCOUNT || total >= PER_SERVER)
      fail(429, "Another page is still being read. Try again in a moment.", "link_busy");
    active.set(user, (active.get(user) || 0) + 1);
    total++;
    try {
      const page = await fetchLink(input, {
        ...(hooks.lookup ? { lookup: hooks.lookup } : {}),
        ...(hooks.route ? { route: hooks.route } : {}),
        ...(hooks.timeoutMs ? { timeoutMs: hooks.timeoutMs } : {}),
      });
      const host = page.url.hostname;
      const base = {
        url: page.url.href,
        host,
        redirected: page.redirects > 0,
      };
      if (page.type === "application/pdf") {
        if (!page.body.subarray(0, 1024).includes("%PDF-"))
          fail(415, "Only web pages, plain text and PDFs can be read.", "link_type");
        return res.json({
          ...base,
          kind: "pdf",
          title: fileName(page.url.pathname) || host,
          site_name: "",
          byline: "",
          bytes: page.body.length,
          pdf: page.body.toString("base64"),
        });
      }
      const text = bodyText(page.body, page);
      const read =
        page.type === "text/plain"
          ? extractPlain(text, { host, path: page.url.pathname })
          : await runExtraction(text, host);
      if (!read.words)
        fail(422, "Couldn't find readable text on that page.", "link_unreadable");
      res.json({
        ...base,
        kind: page.type === "text/plain" ? "text" : "html",
        title: read.title || host,
        site_name: read.siteName,
        byline: read.byline,
        words: read.words,
        truncated: read.truncated,
        text: read.text,
      });
    } catch (e) {
      if (e instanceof LinkError || e?.status) throw e;
      // Never the error's own message: it could name the host.
      fail(502, "Couldn't read that page.", "link_failed");
    } finally {
      const left = (active.get(user) || 1) - 1;
      if (left > 0) active.set(user, left);
      else active.delete(user);
      total--;
    }
  });
}
