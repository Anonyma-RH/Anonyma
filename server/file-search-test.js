import { SYSTEM_PREFIX, parseSent } from "../src/file-search.js";

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for a
// model answering a File Search question, so the page can be driven end to
// end without a provider. Never used live.
//
// It answers from the passages it is given: the opening of the first two,
// each cited by its number, so the page has real citations to show. Markers
// in a passage drive the failure paths the tests and the demo rig need:
// FILE-SEARCH-TEST-FAIL (a provider error), FILE-SEARCH-TEST-LENGTH (cut
// off with nothing), FILE-SEARCH-TEST-EMPTY (nothing), FILE-SEARCH-TEST-INVENT
// (cites a passage that wasn't sent), FILE-SEARCH-TEST-NONE (says the
// passages don't answer it), FILE-SEARCH-TEST-CUT (cut off, with a partial
// answer) and FILE-SEARCH-TEST-FENCE (wrapped in a code fence).
const opening = (text) => {
  // A passage opens with its heading line, if it has one (a Markdown heading,
  // or a short line with no end punctuation): skip those.
  const line = text
    .split("\n")
    .filter((l) => !/^\s*#{1,6}\s/.test(l) && !(l.trim().length <= 60 && !/[.!?。！？]$/.test(l.trim())))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = /^(.{40,220}?[.!?。！？])(?:\s|$)/.exec(line)?.[1];
  return sentence || (line.length > 200 ? line.slice(0, 200).replace(/\s\S*$/, "") + "…" : line);
};
export function fileSearchTestReply(messages) {
  const system = messages?.[0];
  if (system?.role !== "system" || typeof system.content !== "string" || !system.content.startsWith(SYSTEM_PREFIX)) return null;
  const user = messages.find((m) => m.role === "user")?.content;
  if (typeof user !== "string") return null;
  const { passages } = parseSent(user);
  const all = passages.map((p) => p.text).join("\n");
  if (all.includes("FILE-SEARCH-TEST-FAIL")) return { error: "Local test provider: this answer failed on purpose." };
  if (all.includes("FILE-SEARCH-TEST-LENGTH")) return { text: "", finish: "length" };
  if (all.includes("FILE-SEARCH-TEST-EMPTY")) return { text: "" };
  if (all.includes("FILE-SEARCH-TEST-NONE")) return { text: "The passages don't say." };
  const body = passages
    .slice(0, 2)
    .map((p) => `${opening(p.text)} [${p.n}]`)
    .join(" ");
  if (all.includes("FILE-SEARCH-TEST-INVENT")) return { text: body + " Also see [9]." };
  if (all.includes("FILE-SEARCH-TEST-CUT")) return { text: body.slice(0, 60), finish: "length" };
  const text = body || "The passages don't say.";
  return { text: all.includes("FILE-SEARCH-TEST-FENCE") ? "```markdown\n" + text + "\n```" : text };
}
