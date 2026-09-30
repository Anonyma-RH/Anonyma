import { fail } from "../core.js";
import { CONTRACT_READER, ContractInputError, parseContractInput, validSourcePath } from "../../src/contract-reader.js";
import { ContractError, contractCacheFor, createContractReader, sentFiles } from "../contract-reader.js";

// Contract Reader (update "contractreader", which builds on Onchain
// Explainer's sources, so it needs "onchain" too; see featuresFor). The
// rules for reading are in server/contract-reader.js.
//
// - POST /api/contracts { value, chain }: reads one contract (facts, and
//   its verified source or its bytecode's functions) into this account's
//   short-lived cache (memory only, 30 minutes, three at a time). Free: 40
//   reads an hour and 8 a minute per account (a mistyped address or a
//   contract already open doesn't count), one at a time per account.
// - GET /api/contracts, /api/contracts/{id}, /api/contracts/{id}/file?path=:
//   what's open, one read's facts and file list, one file's text.
// - DELETE /api/contracts/{id}: forget it now.
// The explanation is then an /api/chat request carrying `contract`: { id,
// lang } (server/contract-reader.js builds the messages), billed like a
// message and held at exactly the price /api/quote shows. Saved as an
// ordinary conversation unless it's off the record or in Private Mode.
// Nothing is logged: not the address, a path or a name. Every failure is an
// ordinary 4xx/5xx with a fixed message, which the error handler never
// logs. The addresses travel in the body, never in a URL.
export function contractReaderRoutes(ctx) {
  const { app, db, cfg, limit, requireUser } = ctx;
  // Tests inject the fetch (recorded responses) and a clock; only in local
  // test mode, like Onchain Explainer's.
  const hooks = cfg.testMode ? cfg.contractReader || {} : {};
  const reader = createContractReader({
    fetch: hooks.fetch || cfg.onchainFetch || globalThis.fetch,
    ...(hooks.now ? { now: hooks.now } : {}),
  });
  const cache = contractCacheFor(db, hooks.now ? { now: hooks.now } : undefined);
  const clock = hooks.now || Date.now;
  const minute = limit("contracts", 8, 60000);
  const hourly = limit("contracts_hour", CONTRACT_READER.perHour, 3600000);
  const use = limit("contracts-use", 240, 60000);
  const active = new Set();

  const view = (e, full = true) => ({
    id: e.id,
    chain: e.facts.chain,
    address: e.facts.address,
    name: e.facts.name || null,
    read_at: e.created,
    forgotten_at: e.expires,
    forgotten_in: Math.max(0, e.expires - clock()),
    ...(full
      ? {
          facts: e.facts,
          files: e.files.map((f) => ({
            path: f.path,
            lines: f.lines,
            bytes: f.bytes,
            ...(f.main ? { main: true } : {}),
            ...(f.flagged ? { flagged: true } : {}),
            ...(e.sent.index[f.path] ? { sent: true, functions: e.sent.index[f.path] } : {}),
          })),
          sent: {
            files: e.sent.sent.length,
            chars: e.sent.chars,
            truncated: e.sent.sent.some((f) => f.truncated) || undefined,
          },
          hidden_removed: e.hidden || 0,
        }
      : {}),
  });
  const one = (req) => {
    const e = cache.get(req.user.id, req.params.id);
    if (!e)
      fail(
        404,
        "This contract was forgotten (30 minutes after it was read, or when you closed it). Paste the address to read it again.",
        "contract_gone",
      );
    return e;
  };

  // The address is checked before the limits, so a mistyped one doesn't use
  // up a read, and a contract this account already has open comes back as
  // it is, without reading it again.
  const checkInput = (req, res, next) => {
    try {
      req.contractTarget = parseContractInput(req.body?.value, req.body?.chain);
    } catch (e) {
      if (e instanceof ContractInputError) fail(400, e.message, e.code);
      throw e;
    }
    const open = cache.byKey(req.user.id, `${req.contractTarget.chain}:${req.contractTarget.address}`);
    if (open) return res.json({ ...view(open), cached: true });
    next();
  };

  app.post("/api/contracts", requireUser, checkInput, minute, hourly, async (req, res) => {
    const user = req.user.id;
    if (active.has(user)) fail(429, "Another contract is still being read. Try again in a moment.", "contract_busy");
    active.add(user);
    try {
      const { chain, address } = req.contractTarget;
      let read;
      try {
        read = await reader.read({ chain, address });
      } catch (e) {
        if (e instanceof ContractError) fail(e.status, e.message, e.code);
        if (e?.status) throw e;
        // Never the error's own message: it could quote chain data.
        console.error("Contract read failed:", e?.name || "Error");
        fail(502, "The contract couldn't be read right now. Nothing was charged; try again in a minute.", "contract_unavailable");
      }
      const data = {
        key: `${chain}:${address}`,
        facts: read.facts,
        files: read.files,
        hidden: read.hidden,
        bytes: read.files.reduce((n, f) => n + f.bytes, 0) + JSON.stringify(read.facts).length,
      };
      data.sent = sentFiles(data);
      let entry;
      try {
        entry = cache.put(user, data);
      } catch (e) {
        if (e instanceof ContractError) fail(e.status, e.message, e.code);
        throw e;
      }
      res.status(201).json(view(entry));
    } finally {
      active.delete(user);
    }
  });

  app.get("/api/contracts", requireUser, use, (req, res) =>
    res.json({ data: cache.list(req.user.id).map((e) => view(e, false)), limit: CONTRACT_READER.perAccount }),
  );

  app.get("/api/contracts/:id", requireUser, use, (req, res) => res.json(view(one(req))));

  app.get("/api/contracts/:id/file", requireUser, use, (req, res) => {
    const e = one(req);
    const path = req.query?.path;
    const f = typeof path === "string" && validSourcePath(path) ? e.files.find((x) => x.path === path) : null;
    if (!f) fail(404, "That file isn't in the files that were read.", "contract_file_not_found");
    res.json({ path: f.path, lines: f.lines, bytes: f.bytes, text: f.text, sent: !!e.sent.index[f.path] });
  });

  app.delete("/api/contracts/:id", requireUser, use, (req, res) => {
    if (!cache.forget(req.user.id, String(req.params.id))) fail(404, "That contract isn't open.", "contract_gone");
    res.json({ ok: true });
  });

  return { cache, reader };
}
