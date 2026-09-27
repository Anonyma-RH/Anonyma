import { WATCH_SYSTEM } from "../src/page-watch.js";
import { parseDocumentBlocks } from "../src/documents.js";

// LOCAL_TEST_MODE only (server/provider.js): a deterministic stand-in for
// the model behind a Page Watch summary, so the whole flow can be driven
// without a provider. It reads the changed lines back out of the diff and
// says what was removed and added. With a hint it answers the JSON verdict:
// "matters" when a changed line shares a word (4+ letters, first 4 letters
// compared, a few filler words like "change" left out) with the hint. A
// change containing PAGEWATCH-TEST-LENGTH comes back cut off with
// finish_reason "length". Never used live.
const clip = (s, max = 160) => (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s);
// "Pro plan price: **$39** (was $49)": the words that differ between an old
// and a new line, with a few words before them; the whole new line when
// most of it changed.
function changedWords(before, after) {
  const a = before.split(" "),
    b = after.split(" ");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const was = a.slice(start, a.length - end).join(" "),
    now = b.slice(start, b.length - end).join(" ");
  if (!start && !end) return `**Now:** ${clip(after)}`;
  const lead = b.slice(Math.max(0, start - 5), start).join(" ");
  return `${start > 5 ? "…" : ""}${lead ? lead + " " : ""}**${clip(now, 120) || "(removed)"}** (was ${clip(was, 120) || "nothing"})`;
}
export function pageWatchTestReply(messages) {
  if (messages?.[0]?.role !== "system" || messages[0].content !== WATCH_SYSTEM) return null;
  const user = messages.find((m) => m.role === "user")?.content;
  if (typeof user !== "string") return null;
  const { text: ask, documents } = parseDocumentBlocks(user);
  const diff = documents[0]?.text || "";
  const lines = diff.split("\n");
  const removed = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const added = lines.filter((l) => l.startsWith("+ ")).map((l) => l.slice(2));
  const bullets = [];
  for (let i = 0; i < Math.max(removed.length, added.length) && bullets.length < 5; i++) {
    if (removed[i] && added[i]) bullets.push("- " + changedWords(removed[i], added[i]));
    else if (added[i]) bullets.push(`- **Added:** ${clip(added[i])}`);
    else bullets.push(`- **Removed:** ${clip(removed[i])}`);
  }
  const summary = "_Local test provider (a fixture, not a model)._\n\n" + bullets.join("\n");
  const hint = /told only about this: "([^"]*)"/.exec(ask)?.[1];
  if (diff.includes("PAGEWATCH-TEST-LENGTH"))
    return { text: hint != null ? '{"matters": true, "summary": "- The pri' : summary.slice(0, 40), finish: "length" };
  if (hint == null) return { text: summary };
  const skip = new Set(["change", "changes", "changed", "when", "that", "this", "what", "with", "about", "there", "their", "tell"]);
  const words = (hint.toLowerCase().match(/[a-z]{4,}/g) || []).filter((w) => !skip.has(w));
  const changed = [...removed, ...added].join("\n").toLowerCase();
  const matters = words.some((w) => changed.includes(w.slice(0, 4)));
  return { text: JSON.stringify({ matters, summary: matters ? summary : "" }) };
}
