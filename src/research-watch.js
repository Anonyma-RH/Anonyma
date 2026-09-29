// Research Watch (update "researchwatch"): the pure parts shared by the
// server (server/research-watch.js, server/routes/research-watch.js) and the
// Routines page (src/ResearchWatch.jsx). No DOM, no network, no storage.
//
// A research watch is a routine (src/routines.js) whose run is a Deep
// Research run (src/deep-research.js): a plan, one web search per
// sub-question and a sourced report. Its topic is kept in the routine's
// `prompt`; the newest finished report in the Routines inbox is what "only
// new since last time" compares with, so deleting a report makes the watch
// forget it.

import { stripUrls } from "./deep-research.js";

// Watches an account can keep, apart from its ten prompt routines.
export const MAX_WATCHES = 5;
export const TOPIC_LIMIT = 500;
// A watch runs daily or weekly (a briefing, not a monitor: Page Watch and
// Routines cover finer schedules).
export const WATCH_REPEATS = ["daily", "weekly"];
// How much of the last report goes into the next run's prompt, in characters.
export const MAX_PREVIOUS = 3000;

// The part of a report worth comparing with next time: its "Key findings",
// shortened. Citation numbers and addresses go, since they mean nothing to
// the next run's own source list. A report without that section (a model
// that ignored the format) falls back to its opening text.
const KEY_LINE = /^\s{0,3}(?:#{1,6}\s*)?(?:\*\*|__)?\s*key findings\s*:?\s*(?:\*\*|__)?\s*:?\s*$/i;
const HEADING = /^\s{0,3}(?:#{1,6}\s|(?:\*\*|__)[^*_\n]{1,80}(?:\*\*|__)\s*:?\s*$|-{3,}\s*$)/;
export function keyFindings(report, limit = MAX_PREVIOUS) {
  const text = String(report || "").replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const at = lines.findIndex((l) => KEY_LINE.test(l));
  let section;
  if (at >= 0) {
    const out = [];
    for (let i = at + 1; i < lines.length; i++) {
      if (out.some((l) => l.trim()) && HEADING.test(lines[i])) break;
      out.push(lines[i]);
    }
    section = out.join("\n");
  }
  if (!section || !section.trim())
    section = lines.filter((l, i) => !(i === 0 && /^\s{0,3}#\s/.test(l))).join("\n");
  const clean = stripUrls(section)
    .replace(/(?:\[\d{1,3}\])+/g, "")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const end = Math.max(cut.lastIndexOf("\n"), cut.lastIndexOf(". "));
  return (end > limit * 0.6 ? cut.slice(0, end + 1) : cut).trim();
}

// A watch's name when the person leaves it empty: the topic, shortened.
export function defaultName(topic, limit = 60) {
  const t = String(topic || "").replace(/\s+/g, " ").trim();
  return t.length <= limit ? t : t.slice(0, limit - 1).trimEnd() + "…";
}
