#!/usr/bin/env node
// Lists what src/i18n/zh.json has and src/i18n/es.json lacks, so the Spanish
// dictionary can follow the Chinese one when a feature adds strings. The
// English source is the key for both; tests/i18n-es.test.mjs fails until
// every key is in es.json (strings and patterns, the same {0} placeholders).
//
//   node scripts/i18n-es-missing.mjs           print the missing entries
//   node scripts/i18n-es-missing.mjs --json    the same as JSON, to translate
//
// Translate with runtime/es-glossary.md (neutral Latin American Spanish, tú),
// then add each entry to es.json: strings as "English": "Español", patterns
// as { "en": "…{0}…", "es": "…{0}…" }.
import { readFileSync } from "node:fs";

const read = (name) => JSON.parse(readFileSync(new URL("../src/i18n/" + name, import.meta.url), "utf8"));
const zh = read("zh.json");
const es = read("es.json");
const strings = Object.keys(zh.strings).filter((en) => !(en in es.strings));
const known = new Set(es.patterns.map((p) => p.en));
const patterns = zh.patterns.map((p) => p.en).filter((en) => !known.has(en));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ strings: Object.fromEntries(strings.map((en) => [en, ""])), patterns: patterns.map((en) => ({ en, es: "" })) }, null, 2));
} else {
  console.log(`${strings.length} strings and ${patterns.length} patterns are in zh.json but not es.json.`);
  for (const en of strings) console.log("  string  " + JSON.stringify(en));
  for (const en of patterns) console.log("  pattern " + JSON.stringify(en));
}
process.exitCode = strings.length || patterns.length ? 1 : 0;
