import { fail } from "../core.js";
import { REPO_READER, parseRepoUrl, repoKey, validPath } from "../../src/repo-reader.js";
import {
  RepoError,
  buildIndex,
  fetchArchive,
  findForQuestion,
  linesOf,
  repoCacheFor,
  unpackTarball,
} from "../repo-reader.js";

// Repo Reader (update "reporeader"): read one public GitHub repo and ask
// about it. The rules for fetching, unpacking and the cache are in
// server/repo-reader.js.
//
// - POST /api/repos { url }: fetches and unpacks the repo into this
//   account's short-lived cache (memory only, 30 minutes). Free: 20 reads an
//   hour per account (a mistyped link or a repo already open doesn't count),
//   one at a time per account and two across the server.
// - GET /api/repos, /api/repos/{id}, /api/repos/{id}/file?path=: what's
//   open, its file tree, one file's text.
// - POST /api/repos/{id}/excerpts { question }: the excerpts a question would
//   send ("What the AI sees"), free. Asking is then an off-the-record
//   /api/chat request carrying those excerpts as `repo` (server/repo-
//   reader.js builds the messages), billed like a message and held at
//   exactly the price /api/quote shows.
// - DELETE /api/repos/{id}: forget it now.
// Nothing is logged: not the link, the repo, a path or a question. Every
// failure is an ordinary 4xx/5xx with a fixed message, which the error
// handler never logs. The release gate (featuresFor) refuses these routes
// until the update is released.

const PER_ACCOUNT = 1,
  PER_SERVER = 2;

export function repoReaderRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  // Tests inject the resolver, route the connection to a local server, use
  // a clock and lower limits; only in local test mode.
  const hooks = cfg.testMode ? cfg.repoReader || {} : {};
  const limits = hooks.limits ? { ...REPO_READER, ...hooks.limits } : REPO_READER;
  const cache = repoCacheFor(db, {
    ...(hooks.now ? { now: hooks.now } : {}),
    ...(hooks.cacheBytes ? { maxBytes: hooks.cacheBytes } : {}),
  });
  const clock = hooks.now || Date.now;
  const hourly = limit("reporeader", REPO_READER.perHour, 3600000);
  const use = limit("reporeader-use", 240, 60000);
  const active = new Map();
  let total = 0;

  const view = (e, full = true) => ({
    id: e.id,
    repo: e.repo,
    ref: e.ref,
    commit: e.commit,
    url: `https://github.com/${e.repo}${e.ref ? "/tree/" + e.ref : ""}`,
    file_count: e.index.files.length,
    text_bytes: e.textBytes,
    skipped: e.skipped,
    skipped_dirs: e.skippedDirs,
    truncated: e.truncated,
    hidden_removed: e.hidden,
    read_at: e.created,
    forgotten_at: e.expires,
    forgotten_in: Math.max(0, e.expires - clock()),
    ...(full ? { files: e.index.files.map((f) => ({ path: f.path, lines: f.lines, bytes: f.bytes })) } : {}),
  });
  const one = (req) => {
    const e = cache.get(req.user.id, req.params.id);
    if (!e)
      fail(
        404,
        "This repo was forgotten (30 minutes after it was read, or when you closed it). Paste the link to read it again.",
        "repo_gone",
      );
    return e;
  };

  // The link is checked before the hourly limit, so a mistyped one doesn't
  // use up a read, and a repo this account already has open comes back as
  // it is, without fetching it again.
  const checkLink = (req, res, next) => {
    try {
      req.repoLink = parseRepoUrl(req.body?.url);
    } catch (e) {
      fail(400, e.message || "Paste a public GitHub repo link.", "repo_url");
    }
    const open = cache.byKey(req.user.id, repoKey(req.repoLink));
    if (open) return res.json({ ...view(open), cached: true });
    next();
  };

  app.post("/api/repos", requireUser, checkLink, hourly, async (req, res) => {
    const user = req.user.id;
    if ((active.get(user) || 0) >= PER_ACCOUNT || total >= PER_SERVER)
      fail(429, "Another repo is still being read. Try again in a moment.", "repo_busy");
    active.set(user, (active.get(user) || 0) + 1);
    total++;
    try {
      const link = req.repoLink;
      const gz = await fetchArchive(link, {
        lookup: hooks.lookup,
        route: hooks.route,
        timeoutMs: hooks.timeoutMs,
        maxBytes: limits.maxArchiveBytes,
      });
      const unpacked = await unpackTarball(gz, limits);
      const index = await buildIndex(unpacked.files);
      const entry = cache.put(user, {
        key: repoKey(link),
        repo: `${link.owner}/${link.repo}`,
        ref: link.ref,
        commit: unpacked.commit,
        index,
        bytes: index.bytes,
        textBytes: unpacked.files.reduce((n, f) => n + f.bytes, 0),
        skipped: unpacked.skipped,
        skippedDirs: unpacked.skippedDirs,
        truncated: unpacked.truncated,
        hidden: unpacked.hidden,
      });
      res.status(201).json(view(entry));
    } catch (e) {
      if (e instanceof RepoError || e?.status) throw e;
      // Never the error's own message: it could name the repo.
      fail(502, "Couldn't read that repo.", "repo_failed");
    } finally {
      const left = (active.get(user) || 1) - 1;
      if (left > 0) active.set(user, left);
      else active.delete(user);
      total--;
    }
  });

  app.get("/api/repos", requireUser, use, (req, res) =>
    res.json({ data: cache.list(req.user.id).map((e) => view(e, false)), limit: REPO_READER.perAccount }),
  );

  app.get("/api/repos/:id", requireUser, use, (req, res) => res.json(view(one(req))));

  app.get("/api/repos/:id/file", requireUser, use, (req, res) => {
    const e = one(req);
    const path = req.query?.path;
    const at = typeof path === "string" && validPath(path) ? e.index.byPath.get(path) : undefined;
    if (at === undefined) fail(404, "That file isn't in the files that were read.", "repo_file_not_found");
    const f = e.index.files[at];
    res.json({ path: f.path, lines: f.lines, bytes: f.bytes, text: f.lines ? linesOf(f, 1, f.lines) : "" });
  });

  app.post("/api/repos/:id/excerpts", requireUser, use, (req, res) => {
    const e = one(req);
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (!question) fail(400, "Type a question about the repo.", "invalid_repo");
    if (question.length > REPO_READER.maxQuestion)
      fail(400, `Keep the question under ${REPO_READER.maxQuestion.toLocaleString("en-US")} characters.`, "invalid_repo");
    const { payload, flagged, whole, fallback } = findForQuestion(e, question);
    res.json({ repo: payload, flagged, whole, fallback });
  });

  app.delete("/api/repos/:id", requireUser, use, (req, res) => {
    if (!cache.forget(req.user.id, String(req.params.id))) fail(404, "That repo isn't open.", "repo_gone");
    res.json({ ok: true });
  });

  return { cache };
}
