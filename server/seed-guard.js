import { fail } from "./core.js";
import { isReleased } from "./releases.js";
import { findSeedPhrase, SEED_MESSAGE } from "../src/seed-guard.js";
import { stripLinkBlocks } from "../src/link-reader.js";

// Seed Guard's server check, behind the browser's own (src/SeedGuard.jsx):
// once the update is released, a chat or /v1 request whose text holds a
// valid BIP39 seed phrase is refused with 400 seed_phrase_blocked before
// anything is reserved, stored or sent upstream. It catches an old cached
// app, a flow the browser check missed, or a script. Nothing about a match
// is logged or kept: the refusal is an ordinary 4xx, which the error handler
// never logs, and it names no words.
//
// Overrides: the workspace's "Send anyway" (after a second confirm) sends
// allow_seed_phrase: true on /api/chat; API and MCP clients send the header
// X-Anonyma-Seed-Guard: off.
export const SEED_GUARD_HEADER = "x-anonyma-seed-guard";
export const API_SEED_MESSAGE =
  "This looks like a wallet seed phrase, so ANONYMA didn't send it. Remove it, or send the header X-Anonyma-Seed-Guard: off to allow it.";

const textOf = (content) =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : ""))
          .join("\n")
      : "";

// The text a request is sending now: its newest user message and any system
// or developer instructions, or a media request's prompt or input. Earlier
// turns already left with their own request, and assistant turns are model
// output, so neither is read again.
export function guardedTexts(body) {
  if (!body || typeof body !== "object") return [];
  const texts = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages)
      if (m?.role === "system" || m?.role === "developer") texts.push(textOf(m.content));
    const last = body.messages.findLast((m) => m?.role === "user");
    if (last) texts.push(textOf(last.content));
  }
  for (const key of ["prompt", "input"])
    if (typeof body[key] === "string") texts.push(body[key]);
  return texts;
}

export const apiOptOut = (req) =>
  String(req.headers?.[SEED_GUARD_HEADER] ?? "").trim().toLowerCase() === "off";

// A page read by Link Reader (a source="link" document block in a workspace
// message) is public text the server fetched, not something the user typed
// or attached from their device, so it isn't scanned.
export function refuseSeedPhrase(cfg, req, api) {
  if (!isReleased(cfg, "seedguard")) return;
  if (api ? apiOptOut(req) : req.body?.allow_seed_phrase === true) return;
  const skipLinks = !api && isReleased(cfg, "linkreader");
  if (guardedTexts(req.body).some((t) => findSeedPhrase(skipLinks ? stripLinkBlocks(t) : t)))
    fail(400, api ? API_SEED_MESSAGE : SEED_MESSAGE, "seed_phrase_blocked");
}

// For routes that only take a prompt or input (the /v1 media endpoints).
export const seedGuardMiddleware = (cfg) => (req, res, next) => {
  if (req.method === "POST") refuseSeedPhrase(cfg, req, true);
  next();
};
