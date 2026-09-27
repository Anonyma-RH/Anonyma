import { fail, wantsWebSearch } from "./core.js";
import {
  COMPARE_MAX_TOKENS,
  COMPARE_SYSTEM,
  checkComparePayload,
  compareMessages,
} from "../src/compare-spec.js";
import { unescapeDocumentText } from "../src/documents.js";

// Document Compare ("doccompare"): "Summarize changes" is an ordinary
// /api/chat request whose messages the server builds itself from the
// `compare` payload (src/compare-spec.js), so it runs through chat's own
// reserve → settle billing, Spending Limits, Allowances, Seed Guard, Private
// Mode and Privacy Trail. It's always off the record: nothing about it is
// saved, so there's nothing to erase or export. The documents themselves
// never reach the server; the payload carries only the changed passages the
// browser chose, each with a little context.
//
// Runs first in runChat (before Local Sheets' and Seed Guard's checks, which
// then read the built messages), and returns true for a compare request, or
// undefined for any other, which is left untouched.
const REFUSED = [
  "conversationId",
  "project",
  "taskTool",
  "double_check",
  "treasury",
  "messages",
  // Local Sheets, Blind Compare and Deep research: each a mode of its own.
  "sheets",
  "models",
  "depth",
  "question",
];
export function prepareCompareRequest(body) {
  if (!body || body.compare === undefined) return;
  const refuse = (message) => fail(400, message, "invalid_compare");
  if (body.ephemeral !== true)
    refuse("Summaries of changes are never saved: send them off the record.");
  for (const key of REFUSED)
    if (body[key] !== undefined && body[key] !== null)
      refuse("A summary of changes can't be combined with other chat options.");
  if (body.memory != null || wantsWebSearch(body))
    refuse("A summary of changes can't be combined with other chat options.");
  if (body.mode !== undefined && body.mode !== "chat")
    refuse("A summary of changes can't be combined with other chat options.");
  let payload;
  try {
    payload = checkComparePayload(body.compare);
  } catch (e) {
    refuse(e.message);
  }
  body.messages = compareMessages(payload);
  body.max_tokens = COMPARE_MAX_TOKENS;
  body.mode = "chat";
  return true;
}

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for a
// model, so the whole flow can be driven without a provider. It reads the
// passages back out of the prompt and describes each one. Never used live.
export function compareTestReply(messages) {
  if (messages?.[0]?.content !== COMPARE_SYSTEM) return null;
  const user = messages.find((m) => m.role === "user")?.content;
  if (typeof user !== "string") return null;
  const block = /<document [^>]*>([\s\S]*)<\/document>/.exec(user);
  const passages = unescapeDocumentText(block?.[1] || "").split(/\n\n(?=Change \d+ of )/);
  const quote = (s, n = 12) => {
    const words = String(s).replace(/\[-|-\]|\{\+|\+\}/g, "").trim().split(/\s+/);
    return "“" + words.slice(0, n).join(" ") + (words.length > n ? "…" : "") + "”";
  };
  const lines = [];
  const where = [];
  for (const p of passages) {
    const head = /^Change (\d+) of \d+ · (\w+) · (.*)$/m.exec(p);
    if (!head) continue;
    // Where it is now: the revised ¶, or the original's for a removal.
    const at = head[3].includes("→") ? head[3].replace(/original |revised /g, "") : head[3].split(", ").at(-1).replace(/original |revised /g, "");
    where.push(at.split(/, | → /).at(-1));
    const edit = /^Text: (.*)$/m.exec(p)?.[1];
    if (edit) {
      const pairs = [...edit.matchAll(/(?:\[-(.*?)-\])?(?:\{\+(.*?)\+\})?/g)].filter((m) => m[1] || m[2]);
      const said = pairs
        .slice(0, 3)
        .map((m) => (m[1] && m[2] ? `${quote(m[1], 6)} became ${quote(m[2], 6)}` : m[1] ? `${quote(m[1], 6)} was taken out` : `${quote(m[2], 6)} was added`));
      lines.push(`- **${at}:** ${said.join("; ")}.`);
    }
    for (const [, tag, text] of p.matchAll(/^(Added|Removed|Moved from original ¶ \d+): (.*)$/gm))
      lines.push(
        tag === "Added"
          ? `- **${at}:** a new passage was added, starting ${quote(text)}.`
          : tag === "Removed"
            ? `- **${at}:** a passage was removed, starting ${quote(text)}.`
            : `- **${at}:** a passage moved, starting ${quote(text)}.`,
      );
  }
  return [
    "Local test provider (a fixture, not a model): this reply lists the passages it was sent.",
    "",
    "## What changed",
    ...(lines.length ? lines : ["- Nothing the fixture could read."]),
    "",
    "## What might matter",
    `- ${lines.length === 1 ? "This change touches" : `These ${lines.length} changes touch`} wording that can move obligations, dates or money. Read each one in the redline.`,
    "",
    "## What to check with a professional",
    `- Whether the changes at ${where.slice(0, 4).join(", ")} are acceptable for you before you sign.`,
  ].join("\n");
}
