import { fail } from "../core.js";
import { createOnchain } from "../onchain.js";
import { CHAIN_IDS, kindOf } from "../../src/onchain.js";

// Onchain Explainer (update "onchain"): POST /api/onchain/lookup reads one
// transaction or address from a fixed list of public chain sources
// (server/onchain.js) and returns structured facts. The lookup is free,
// signed in and rate-limited per account; nothing is stored, and it never
// signs, sends or connects a wallet. The hash or address travels in the
// body, never in the URL, so no access log can record it. The explanation
// that follows is an ordinary chat message on the usual hold/settle path.
export function onchainRoutes(ctx) {
  const { app, cfg, limit, requireUser } = ctx;
  const onchain = createOnchain({ fetch: cfg.onchainFetch || globalThis.fetch, cfg });
  app.post(
    "/api/onchain/lookup",
    requireUser,
    limit("onchain", 20, 60000),
    limit("onchain_hour", 200, 3600000),
    async (req, res) => {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const value = typeof body.value === "string" ? body.value.trim() : "";
      const kind = kindOf(value);
      if (!kind)
        fail(400, "Paste a transaction hash (0x and 64 hex characters) or an address (0x and 40).", "invalid_request");
      if (body.kind !== undefined && body.kind !== kind)
        fail(400, "That value doesn't match the kind asked for.", "invalid_request");
      const chain = body.chain === undefined || body.chain === "auto" ? "auto" : Number(body.chain);
      if (chain !== "auto" && !CHAIN_IDS.includes(chain))
        fail(400, "Choose one of the listed chains.", "onchain_chain_unsupported");
      let facts;
      try {
        facts = await onchain.lookup({ kind, value: value.toLowerCase(), chain });
      } catch (e) {
        if (e.status) throw e;
        // Anything unexpected is reported by name only: a message could
        // quote chain data, and the value itself must never reach a log.
        console.error("Onchain lookup failed:", e?.name || "Error");
        fail(502, "The chain's data couldn't be read right now. Nothing was charged; try again in a minute.", "onchain_unavailable");
      }
      res.json({ facts });
    },
  );
  return { onchain };
}
