import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vm from "node:vm";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { transformWithEsbuild } from "vite";
import { parseHTML } from "linkedom";
import { parse } from "@babel/parser";
import { createApp } from "../server/app.js";
import { UPDATES } from "../server/releases.js";
import { isReleased } from "../src/lib.js";
import {
  compileDictionary,
  createSession,
  getLanguage,
  hasLetters,
  normalize,
  setLanguage,
  startTranslator,
  stopTranslator,
  translateDate,
  translateText,
  HTML_LANG,
  LANGUAGES,
} from "../src/i18n.js";
import { paletteActions } from "../src/command-palette.js";
import { countLabel } from "../src/find-in-chat.js";
import { chainFactsText } from "../src/onchain.js";
import { releaseCopy } from "../src/release-copy.js";

// Español: the whole site in Spanish (src/i18n.js, src/i18n/es.json, the
// EN / ES / 中文 switch). Release commits flip `released` on UPDATES entries;
// these tests cover the gate itself, so they pin every update to unreleased
// for this file and keep passing after the release commit.
const committed = UPDATES.map((u) => u.released);
before(() => UPDATES.forEach((u) => (u.released = false)));
after(() => UPDATES.forEach((u, i) => (u.released = committed[i])));

const read = (p) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const zhRaw = JSON.parse(read("src/i18n/zh.json"));
const esRaw = JSON.parse(read("src/i18n/es.json"));
const es = compileDictionary(esRaw, "es");
const zh = compileDictionary(zhRaw, "zh");
const han = /\p{Script=Han}/u;
const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort();
// Spanish-only entries: labels the code writes in Spanish itself, and
// sentences the source ships that zh.json has no entry for.
const ES_ONLY = new Set([
  "Cambiar a español",
  "Prices from the live catalog on every model",
  "A gift is waiting.",
  "to claim it; you'll go straight back to it.",
]);
// And the patterns it adds: the receipt lines built in one template and the
// relative times that follow a label.
const ES_ONLY_PATTERNS = [
  "{0} · settled receipt.",
  "{0} · settled receipt. {1} unused reserved credits released.",
  // "Chat, 1 minute ago": a label and a relative time in one string.
  ...["minute", "hour", "day", "week", "month", "year"].flatMap((u) => [`{0}, {1} ${u} ago`, `{0}, {1} ${u}s ago`]),
];
// Brand, product-tier and technical words that read the same in Spanish.
const SAME = new Set([
  // Batch 8: browser names Push Alerts lists.
  "Safari", "Firefox", "Edge",
  "api", "api — ANONYMA", "Audio", "audio", "audio — ANONYMA", "Auto", "Auto →", "App", "Canvas", "Chat", "chat",
  "chat — ANONYMA", "Chats", "Color", "demo", "Error", "Filipino", "Formal", "formal", "Hardware", "Hindi", "Info",
  "Lite", "Markdown", "Normal", "Original", "Popular", "Prime", "Pro", "Prompt", "Prompts",
  "Robinhood Chain, chain ID 4663", "software", "token", "Token", "tokens ·", "Tokens", "Turbo", "Urdu", "video",
  "Video", "video — ANONYMA", "vs", "Web", "whitepaper", "Whitepaper", "WHITEPAPER", "whitepaper — ANONYMA",
  "Word (DOCX)", "Español", "Debate",
]);

// ---------------------------------------------------------------- the update

test("the update is registered as off by default", () => {
  const entry = UPDATES.find((u) => u.id === "es");
  assert.ok(entry, "es is registered in UPDATES");
  // Committed as false until its "Release …" commit flips it to true.
  assert.equal(typeof committed[UPDATES.indexOf(entry)], "boolean");
  assert.equal(entry.title, "Español");
  assert.equal(entry.tagline, "The whole site in Spanish.");
  assert.deepEqual(entry.points, [
    "One switch between English, Spanish and Chinese",
    "Every page, the workspace and your account",
    "Your chats stay exactly as written",
  ]);
  // Its title, tagline and points read in both dictionaries.
  for (const text of [entry.title, entry.tagline, ...entry.points]) {
    assert.ok(translateText(text, es), `es: ${text}`);
    assert.ok(translateText(text, zh), `zh: ${text}`);
  }
  assert.equal(translateText("Español", zh), "西班牙语");
});

// ------------------------------------------------------------ the dictionary

test("es.json has the shape the runtime reads", () => {
  assert.equal(typeof esRaw.strings, "object");
  assert.ok(!Array.isArray(esRaw.strings));
  assert.ok(Array.isArray(esRaw.patterns));
  assert.ok(Object.keys(esRaw.strings).length > 5000);
  assert.ok(esRaw.patterns.length > 800);
  for (const p of esRaw.patterns) {
    assert.deepEqual(Object.keys(p).sort(), ["en", "es"]);
    assert.equal(typeof p.en, "string");
    assert.equal(typeof p.es, "string");
  }
  assert.equal(es.lang, "es");
  assert.ok(es.strings.size > 5000);
  assert.equal(es.patterns.length, esRaw.patterns.length);
});

test("es.json has every key zh.json has, strings and patterns", () => {
  const missing = Object.keys(zhRaw.strings).filter((k) => !(k in esRaw.strings));
  const missingPatterns = zhRaw.patterns.map((p) => p.en).filter((en) => !esRaw.patterns.some((p) => p.en === en));
  // When zh.json gains entries (a new feature), es.json needs them too:
  // translate them into runtime/es-glossary.md's Spanish and add them.
  assert.deepEqual(missing.slice(0, 20), [], `${missing.length} strings in zh.json but not es.json`);
  assert.deepEqual(missingPatterns.slice(0, 20), [], `${missingPatterns.length} patterns in zh.json but not es.json`);
  // Nothing invented: what es.json adds is a known, deliberate few.
  for (const k of Object.keys(esRaw.strings)) if (!(k in zhRaw.strings)) assert.ok(ES_ONLY.has(k), `unexpected es-only key ${JSON.stringify(k)}`);
  assert.deepEqual(esRaw.patterns.map((p) => p.en), [...zhRaw.patterns.map((p) => p.en), ...ES_ONLY_PATTERNS], "zh.json's patterns in the same order, then Spanish's own");
  assert.equal(new Set(esRaw.patterns.map((p) => p.en)).size, esRaw.patterns.length, "duplicate pattern");
});

test("every placeholder in English is in Spanish, exactly once each", () => {
  for (const { en, es: text } of esRaw.patterns)
    assert.deepEqual(placeholders(text), placeholders(en), `${JSON.stringify(en)} → ${JSON.stringify(text)}`);
  for (const [en, text] of Object.entries(esRaw.strings))
    assert.deepEqual(placeholders(text), placeholders(en), `${JSON.stringify(en)} → ${JSON.stringify(text)}`);
  for (const { en, es: text } of esRaw.patterns) {
    const found = placeholders(en);
    assert.ok(found.length > 0, `pattern without a placeholder: ${JSON.stringify(en)}`);
    assert.deepEqual(found, [...new Set(found)]);
    assert.ok(!(en in esRaw.strings), `pattern also listed as a string: ${JSON.stringify(en)}`);
    assert.equal(text, text.trim(), `untrimmed pattern ${JSON.stringify(en)}`);
  }
});

test("values are Spanish text: never empty, never Chinese, never padded", () => {
  const all = [...Object.entries(esRaw.strings), ...esRaw.patterns.map((p) => [p.en, p.es])];
  for (const [en, text] of all) {
    assert.equal(typeof text, "string", en);
    assert.ok(text.trim(), `empty value for ${JSON.stringify(en)}`);
    assert.doesNotMatch(text, han, `Chinese in ${JSON.stringify(en)}`);
    assert.equal(text, text.trim(), `padded value for ${JSON.stringify(en)}`);
    assert.doesNotMatch(text, /\s{2,}/, `double space in ${JSON.stringify(en)}`);
    // Inverted question and exclamation marks come in pairs (a heading split
    // over two lines carries one half in each fragment).
    const open = (text.match(/¿/g) || []).length;
    if (en.includes("?")) assert.ok(open <= (text.match(/\?/g) || []).length, `unclosed ¿ in ${JSON.stringify(text)}`);
    if (en.includes("!")) assert.ok((text.match(/¡/g) || []).length <= (text.match(/!/g) || []).length, `unclosed ¡ in ${JSON.stringify(text)}`);
  }
  // A question ends as a question.
  for (const [en, text] of Object.entries(esRaw.strings))
    if (en.endsWith("?") && en.length > 12) assert.match(text, /\?$/, en);
});

test("neutral Latin American Spanish: tú, not vos, vosotros or Spain-only words", () => {
  const spain = /\b(ordenador(?:es)?|vídeos?|costes?|vosotros|vuestr[oa]s?|coger|pinchar|pincha|tenéis|podéis|habéis|vos|tenés|querés|podés|sos)\b/iu;
  const usted = /\b(usted(?:es)?|su cuenta de usted)\b/iu;
  const all = [...Object.entries(esRaw.strings), ...esRaw.patterns.map((p) => [p.en, p.es])];
  for (const [en, text] of all) {
    assert.doesNotMatch(text, spain, `${JSON.stringify(en)} → ${JSON.stringify(text)}`);
    assert.doesNotMatch(text, usted, `${JSON.stringify(en)} → ${JSON.stringify(text)}`);
  }
});

test("the glossary holds: the same English term is the same Spanish term", () => {
  const s = esRaw.strings;
  for (const [en, text] of [
    ["Private Mode", "Modo privado"],
    ["Symposium", "Simposio"],
    ["Coming soon", "Próximamente"],
    ["Off the record", "Sin registro"],
    ["Credits", "Créditos"],
    ["credits", "créditos"],
    ["Balance", "Saldo"],
    ["Veil", undefined],
    ["Sign in", "Iniciar sesión"],
    ["Sign out", "Cerrar sesión"],
    ["Create account", "Crear cuenta"],
    ["Password", "Contraseña"],
    ["Wallet", "Billetera"],
    ["Passkeys", "Llaves de acceso"],
    ["Panic Wipe", "Borrado de pánico"],
    ["Device Vault", "Bóveda del dispositivo"],
    ["Sealed Mode", "Modo sellado"],
    ["Scrolls", "Pergaminos"],
  ]) {
    if (text === undefined) assert.ok(!(en in s) || s[en] === en, "Veil stays Veil");
    else assert.equal(s[en], text, en);
  }
  // Veil is a brand: it is in every Spanish sentence about it.
  for (const [en, text] of Object.entries(s))
    if (/\bVeil\b/.test(en) && !/^Veil'?s? ?/i.test(en) === false && text.length > 12)
      assert.match(text, /Veil/, `Veil lost in ${JSON.stringify(en)}`);
  // Zero data retention, ledger and hold keep one translation each.
  const joined = Object.values(s).join("\n");
  assert.doesNotMatch(joined, /cero retención|retención de datos cero|registro de movimientos de créditos/i);
  assert.match(joined, /retención cero de datos/);
});

test("nothing is left in English: every string is translated, apart from names", () => {
  const same = Object.entries(esRaw.strings).filter(([en, text]) => en === text).map(([en]) => en);
  for (const en of same) assert.ok(SAME.has(en) || ES_ONLY.has(en), `untranslated: ${JSON.stringify(en)}`);
  for (const { en, es: text } of esRaw.patterns)
    if (en === text) assert.match(en.replace(/\{\d+\}/g, ""), /^[\s·/—%≈#×:.,()\-a-zA-Z]{0,14}$/, `untranslated pattern ${JSON.stringify(en)}`);
  // No stretch of English inside a Spanish value: a few English function
  // words together mean a sentence was left half-done. Code words, API field
  // names and Spanish words next to accents are not counted.
  const ENGLISH = new Set("the and with your you for this that are not can will has have was were been into when then than also each any but its their they them what which who how here there our".split(" "));
  const all = [...Object.entries(esRaw.strings), ...esRaw.patterns.map((p) => [p.en, p.es])];
  for (const [en, text] of all) {
    const words = text.toLowerCase().match(/(?<![\p{L}\p{N}_.\/-])[a-z']+(?![\p{L}\p{N}_.\/(-])/gu) || [];
    const hits = words.filter((w) => ENGLISH.has(w));
    assert.ok(hits.length < 2, `English left in ${JSON.stringify(text)} (${hits})`);
  }
});

// ------------------------------------------------------ translating a string

test("exact strings and patterns translate, and whitespace survives", () => {
  assert.equal(translateText("Log in", es), "Iniciar sesión");
  assert.equal(translateText("  Get started ", es), "  Comenzar ");
  assert.equal(translateText("\n   Get\n     started\n", es), "\n   Comenzar\n");
  assert.equal(translateText("3 days ago", es), "hace 3 días");
  assert.equal(translateText("1 hour ago", es), "hace 1 hora");
  assert.equal(translateText("1,234.5 credits available", es), "1,234.5 créditos disponibles");
  assert.equal(translateText("Something entirely different happened here today", es), undefined);
});

test("pattern captures translate too, names and handles stay as written", () => {
  assert.equal(translateText("Image Studio is coming soon.", es), "Próximamente: Estudio de imágenes.");
  assert.equal(translateText("Page 2 of 7", es), "Página 2 de 7");
  assert.equal(translateText("Sent to @demo", es), "Enviado a @demo");
  assert.equal(translateText("Sent 250 credits to @ada_9.", es), "Se enviaron 250 créditos a @ada_9.");
  assert.equal(translateText("Good evening", es), "Buenas noches");
  assert.equal(translateText("Opens in Venice", es) ?? "Opens in Venice", "Opens in Venice");
  // A whole sentence the dictionary lacks is not read as a name inside a
  // pattern: it stays English rather than turning into half-Spanish.
  assert.equal(translateText("Prices from the live catalog on every model", compileDictionary({ strings: {}, patterns: [{ en: "{0} model", es: "modelo de {0}" }] }, "es")), undefined);
  // A list inside a pattern joins with commas, not the Chinese 、.
  const list = compileDictionary({ strings: { Chat: "Chat", Account: "Cuenta" }, patterns: [{ en: "Enabled: {0}.", es: "Activado: {0}." }] }, "es");
  assert.equal(translateText("Enabled: Chat, Veil, Account.", list), "Activado: Chat, Veil, Cuenta.");
  assert.equal(translateText("Chat, Account", list), undefined);
});

test("en-US dates and times take the es-419 form, inside patterns and lines too", () => {
  assert.equal(translateDate("9/25/2026, 1:22:31 AM", "es"), "25/9/2026, 1:22:31 a. m.");
  assert.equal(translateDate("9/25/2026", "es"), "25/9/2026");
  assert.equal(translateDate("10:02:45 PM", "es"), "10:02:45 p. m.");
  assert.equal(translateDate("12:05 AM", "es"), "12:05 a. m.");
  assert.equal(translateDate("Credits", "es"), undefined);
  // A date the browser already wrote day first (25 can't be a month) stays.
  assert.equal(translateDate("25/9/2026", "es"), undefined);
  // A browser that writes the day first (Spanish, French, British English)
  // has already written "5/9/2026" as 5 September: only en-US dates with
  // AM/PM, and times, are converted there.
  assert.equal(translateDate("5/9/2026", "es", true), undefined);
  assert.equal(translateDate("5/9/2026", "es", false), "9/5/2026");
  assert.equal(translateDate("5/9/2026, 1:22 PM", "es", true), "9/5/2026, 1:22 p.\u00a0m.");
  assert.equal(translateDate("1:22 PM", "es", true), "1:22 p.\u00a0m.");
  // The Chinese form is untouched.
  assert.equal(translateDate("9/25/2026, 1:22:31 AM"), "2026/9/25 01:22:31");
  assert.equal(translateText("Last used 9/24/2026, 10:02:45 PM", es), "Último uso 24/9/2026, 10:02:45 p. m.");
  assert.equal(translateText(" 9/24/2026 ", es), " 24/9/2026 ");
  assert.equal(translateText("Personal chat · 9/25/2026", es), "Chat personal · 25/9/2026");
  // Numbers keep their shape: es-419 uses the same separators as en-US.
  assert.equal((1234567.891).toLocaleString("es-419"), (1234567.891).toLocaleString("en-US"));
});

test("a label and a relative time in one string keep their order", () => {
  assert.equal(translateText("Chat, 1 minute ago", es), "Chat, hace 1 minuto");
  assert.equal(translateText("Code, 3 days ago", es), "Código, hace 3 días");
  assert.equal(translateText("Symposium, 2 weeks ago", es), "Simposio, hace 2 semanas");
  assert.equal(translateText("Your balance · settled receipt.", es), "Tu saldo · recibo liquidado.");
  assert.equal(
    translateText("Your balance · settled receipt. 228.0764 unused reserved credits released.", es),
    "Tu saldo · recibo liquidado. Se liberaron 228.0764 créditos reservados sin usar.",
  );
  assert.equal(translateText("At this week's pace that lasts about several months.", es), "Al ritmo de esta semana, eso dura aproximadamente varios meses.");
});

test("relative times read in Spanish", () => {
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  assert.equal(translateText(rtf.format(-1, "day"), es), "ayer");
  assert.equal(translateText(rtf.format(-1, "week"), es), "la semana pasada");
  assert.equal(translateText(rtf.format(-3, "hour"), es), "hace 3 horas");
  assert.equal(translateText(rtf.format(-5, "minute"), es), "hace 5 minutos");
  assert.equal(translateText("just now", es), "justo ahora");
});

// ----------------------------------------------- the session (nodes, restore)

const text = (nodeValue) => ({ nodeValue, isConnected: true });
const values = (nodes) => nodes.map((n) => n.nodeValue);

test("switching back restores every original exactly, as often as needed", () => {
  const originals = ["Log in", " ", "Get started ", "\n  Image Studio is coming soon.\n", "42"];
  const nodes = originals.map(text);
  for (let i = 0; i < 3; i++) {
    const s = createSession(es);
    for (const n of [nodes[0], nodes[2], nodes[3], nodes[4]]) s.translateRun([n]);
    assert.deepEqual(values(nodes), ["Iniciar sesión", " ", "Comenzar ", "\n  Próximamente: Estudio de imágenes.\n", "42"]);
    s.translateRun([nodes[0]]);
    assert.equal(nodes[0].nodeValue, "Iniciar sesión");
    s.restoreAll();
    assert.deepEqual(values(nodes), originals);
  }
});

test("a sentence split over text nodes translates by its pieces when the whole isn't known", () => {
  const run = [
    text("Connected catalog · Reference catalog snapshot · 19 Sep 2026. Availability refers to this web workspace; developer API access has a separate release gate."),
    text(" Updated 9/19/2026, 6:17:17 PM"),
  ];
  const s = createSession(es);
  s.translateRun(run);
  assert.match(run[0].nodeValue, /^Catálogo conectado · /);
  assert.doesNotMatch(run[0].nodeValue, /Availability|Connected/);
  assert.equal(run[1].nodeValue, " Actualizado 19/9/2026, 6:17:17 p. m.");
  s.restoreAll();
  assert.match(run[0].nodeValue, /^Connected catalog/);
  assert.equal(run[1].nodeValue, " Updated 9/19/2026, 6:17:17 PM");
  // Nodes that only translate as a whole still do.
  const parts = [text("3"), text(" member"), text("s")];
  s.translateRun(parts);
  assert.deepEqual(values(parts), ["3 miembros", "", ""]);
  s.restoreAll();
  assert.deepEqual(values(parts), ["3", " member", "s"]);
});

test("attributes translate, stay English when kept, and restore", () => {
  const map = new Map(Object.entries({ "aria-label": "Get started", title: "Log in", alt: "A photo" }));
  const el = { isConnected: true, getAttribute: (k) => (map.has(k) ? map.get(k) : null), setAttribute: (k, v) => map.set(k, String(v)) };
  const s = createSession(es);
  for (const name of ["aria-label", "title", "alt"]) s.translateAttr(el, name, name === "title");
  assert.equal(el.getAttribute("aria-label"), "Comenzar");
  assert.equal(el.getAttribute("title"), "Log in");
  assert.equal(el.getAttribute("alt"), "A photo");
  s.restoreAll();
  assert.equal(el.getAttribute("aria-label"), "Get started");
});

test("Spanish text is not read back as English, and a split heading comes back English", () => {
  const s = createSession(es);
  const source = text("Image Studio is coming soon.");
  s.translateRun([source]);
  // anime's splitText copies the Spanish into new word nodes.
  const words = ["Próximamente:", " ", "Estudio", " ", "de", " ", "imágenes."].map(text);
  s.translateRun(words, { adoptable: true, whole: true });
  assert.equal(words.map((n) => n.nodeValue).join(""), "Próximamente: Estudio de imágenes.");
  s.restoreAll();
  assert.equal(words.map((n) => n.nodeValue).join(""), "Image Studio is coming soon.");
});

// -------------------------------------------- the live page (a real DOM tree)

function withPage(html, run) {
  const { window, document } = parseHTML(html);
  const saved = { document: globalThis.document, MutationObserver: globalThis.MutationObserver };
  globalThis.document = document;
  globalThis.MutationObserver = window.MutationObserver;
  if (!document.styleSheets) Object.defineProperty(document, "styleSheets", { value: [] });
  try {
    return run(document);
  } finally {
    stopTranslator();
    globalThis.document = saved.document;
    globalThis.MutationObserver = saved.MutationObserver;
  }
}

test("a live page: the site swaps to Spanish, the html lang follows, and chats stay as written", () => {
  const page = `<!doctype html><html lang="en"><head><title>ANONYMA — One account. Many AI models.</title></head><body>
    <main>
      <h1>Log in</h1>
      <p>3 days ago</p>
      <button aria-label="Copy" title="Copy" placeholder="Search">Copy</button>
      <article data-i18n="off"><p>Log in</p><p>3 days ago</p></article>
      <p contenteditable="true">Get started</p>
      <pre>Get started</pre><code>Get started</code>
      <p>Last used 9/24/2026, 10:02:45 PM</p>
    </main></body></html>`;
  withPage(page, (document) => {
    startTranslator(es);
    assert.equal(document.documentElement.getAttribute("lang"), "es-419");
    assert.equal(document.querySelector("title").textContent, "ANONYMA — Una cuenta. Muchos modelos de IA.");
    assert.equal(document.querySelector("h1").textContent, "Iniciar sesión");
    const button = document.querySelector("button");
    assert.equal(button.textContent, "Copiar");
    assert.equal(button.getAttribute("aria-label"), "Copiar");
    assert.equal(button.getAttribute("title"), "Copiar");
    // What people wrote is theirs: chat text, editable fields and code.
    assert.deepEqual([...document.querySelectorAll("article p")].map((p) => p.textContent), ["Log in", "3 days ago"]);
    assert.equal(document.querySelector("[contenteditable]").textContent, "Get started");
    assert.equal(document.querySelector("pre").textContent, "Get started");
    assert.equal(document.querySelector("code").textContent, "Get started");
    assert.equal(document.querySelector("main > p:nth-of-type(1)").textContent, "hace 3 días");
    assert.match(document.body.textContent, /Último uso 24\/9\/2026, 10:02:45 p\. m\./);
    // Back to English: every original comes back and the lang attribute too.
    stopTranslator();
    assert.equal(document.documentElement.getAttribute("lang"), "en");
    assert.equal(document.querySelector("h1").textContent, "Log in");
    assert.equal(button.getAttribute("aria-label"), "Copy");
    assert.match(document.body.textContent, /Last used 9\/24\/2026, 10:02:45 PM/);
  });
});

test("switching between Español and 中文 keeps every original", () => {
  withPage(`<!doctype html><html lang="en"><head><title>x</title></head><body><h1>Get started</h1><p>Sign out</p></body></html>`, (document) => {
    startTranslator(es);
    assert.equal(document.querySelector("h1").textContent, "Comenzar");
    startTranslator(zh);
    assert.equal(document.documentElement.getAttribute("lang"), "zh-CN");
    assert.equal(document.querySelector("h1").textContent, "开始使用");
    startTranslator(es);
    assert.equal(document.querySelector("p").textContent, "Cerrar sesión");
    stopTranslator();
    assert.equal(document.querySelector("h1").textContent, "Get started");
    assert.equal(document.documentElement.getAttribute("lang"), "en");
  });
});

test("the scoped words: How it works reads Cómo funciona, and The ANONYMA Platform reads La plataforma ANONYMA", () => {
  const flow = `<!doctype html><html lang="en"><head><title>x</title></head><body>
    <h2 class="intro-text"><span class="flow-word">How<i></i></span> <span class="flow-word">it<i></i></span> <span class="flow-word">works<i></i></span> </h2>
    <div class="outro-text"><h2>The ANONYMA<br>Platform</h2></div>
    <div class="n-flow-outro"><h2>The ANONYMA<br>Platform</h2></div>
    <button class="training-switch">Use <span data-i18n="off">GPT</span> instead</button>
  </body></html>`;
  withPage(flow, (document) => {
    startTranslator(es);
    const words = [...document.querySelectorAll(".flow-word")].map((e) => e.textContent);
    assert.deepEqual(words, ["Cómo", "funciona", ""]);
    for (const h of document.querySelectorAll(".outro-text h2, .n-flow-outro h2"))
      assert.equal([...h.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(" "), "La plataforma ANONYMA");
    assert.equal(document.querySelector(".training-switch").textContent.replace(/\s+/g, " ").trim(), "Usar GPT en su lugar");
    stopTranslator();
    assert.deepEqual([...document.querySelectorAll(".flow-word")].map((e) => e.textContent), ["How", "it", "works"]);
  });
});

// ----------------------------------------------------- the pages' own strings

// Every piece of English text in the main pages' source (JSX text, and the
// placeholder, title, aria-label and alt attributes), read from the code.
function pageStrings(file) {
  const ast = parse(read("src/" + file), { sourceType: "module", plugins: ["jsx"] });
  const out = new Set();
  const attrs = new Set(["placeholder", "title", "aria-label", "alt"]);
  (function walk(n) {
    if (!n || typeof n.type !== "string") return;
    if (n.type === "JSXText") out.add(normalize(n.value));
    if (n.type === "JSXAttribute" && attrs.has(n.name?.name) && n.value?.type === "StringLiteral") out.add(normalize(n.value.value));
    if (n.type === "JSXExpressionContainer") {
      const e = n.expression;
      if (e?.type === "StringLiteral") out.add(normalize(e.value));
      if (e?.type === "TemplateLiteral" && e.expressions.length === 0) out.add(normalize(e.quasis[0].value.cooked));
    }
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v.type === "string") walk(v);
    }
  })(ast.program);
  return [...out].filter((s) => /[A-Za-z]{2}/.test(s) && hasLetters(s));
}

test("no English is left on the main pages: what Chinese covers, Spanish covers", () => {
  const pages = ["Home.jsx", "ReferenceFlow.jsx", "Pages.jsx", "Account.jsx", "AccountFlows.jsx", "App.jsx", "WorkspaceHome.jsx", "Workspace.jsx"];
  // Names, handles, code and the like: never words on a page.
  const notWords = /^(@?username|you@example\.com|NYMA|ANONYMA|tokens|ZIP|USD|https?:\/\/.*|OpenAI Google|Anthropic DeepSeek)$/;
  let checked = 0;
  for (const file of pages)
    for (const s of pageStrings(file)) {
      if (notWords.test(s)) continue;
      checked++;
      assert.ok(translateText(s, es) !== undefined || translateText(s, zh) === undefined, `${file}: ${JSON.stringify(s)} has Chinese but no Spanish`);
      // Anything Spanish has is Spanish: no Chinese leaks in.
      const out = translateText(s, es);
      if (out !== undefined) assert.doesNotMatch(out, han);
    }
  assert.ok(checked > 400, `only ${checked} strings found on the main pages`);
  // And the few Chinese lacks: the two-line heading and the gift banner.
  for (const s of ["A gift is waiting.", "to claim it; you'll go straight back to it.", "The ANONYMA", "Platform"])
    assert.ok(translateText(s, es), s);
});

test("the strings the update itself adds have Spanish", () => {
  for (const s of [
    "Show the site in English, Spanish or Simplified Chinese. Your chats stay exactly as written.",
    "Show the site in English or Simplified Chinese. Your chats stay exactly as written.",
    "Language.",
    "Switch to English",
    "Cambiar a español",
  ])
    assert.ok(translateText(s, es), s);
  assert.equal(translateText("Cambiar a español", es), "Cambiar a español");
});

// -------------------------------------------------------------- language state

test("the language state knows English, Spanish and Chinese and nothing else", () => {
  assert.deepEqual(LANGUAGES, ["en", "es", "zh"]);
  assert.equal(HTML_LANG.es, "es-419");
  assert.equal(HTML_LANG.zh, "zh-CN");
  setLanguage("es");
  assert.equal(getLanguage(), "es");
  setLanguage("fr");
  assert.equal(getLanguage(), "en");
  setLanguage("zh");
  assert.equal(getLanguage(), "zh");
  setLanguage("es");
  setLanguage("en");
  assert.equal(getLanguage(), "en");
});

// ----------------------------------------------------- the switch and the gate

function fixture(t, released) {
  const dir = mkdtempSync(join(tmpdir(), "anonyma-i18n-es-"));
  const svc = createApp({
    testMode: true,
    dbPath: join(dir, "test.sqlite"),
    mediaPath: join(dir, "media"),
    origin: "http://localhost:5175",
    released,
  });
  t.after(() => {
    svc.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return svc;
}
// LanguageSwitch.jsx compiled for Node with the same esbuild Vite uses; its
// imports point at the modules this test already loaded.
async function switchModule() {
  const src = new URL("../src/LanguageSwitch.jsx", import.meta.url);
  const { code } = await transformWithEsbuild(readFileSync(src, "utf8"), src.pathname, { jsx: "transform", format: "esm" });
  const out = code
    .replace(/^import "\.\/i18n\.css";$/m, "")
    .replace(/from "\.\/(lib|i18n)\.js"/g, (_, f) => `from "${new URL(`../src/${f}.js`, import.meta.url)}"`)
    .replace(/from "react"/g, `from "${import.meta.resolve("react")}"`);
  const dir = mkdtempSync(join(tmpdir(), "anonyma-i18n-es-ui-"));
  const file = join(dir, "LanguageSwitch.mjs");
  writeFileSync(file, out);
  try {
    return await import(pathToFileURL(file).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const config = async (t, released) => (await request(fixture(t, released).app).get("/api/config").expect(200)).body;

test("before release the ES option is hidden, and a stored choice changes nothing", async (t) => {
  const { LanguageSwitch, LanguageSettings, languageReleased } = await switchModule();
  const render = (C, cfg) => renderToStaticMarkup(createElement(C, { config: cfg }));
  const mvp = await config(t, "mvp");
  assert.equal(mvp.releases.features.es, false);
  assert.equal(isReleased(mvp, "es"), false);
  assert.equal(render(LanguageSwitch, mvp), "");
  assert.equal(render(LanguageSettings, mvp), "");
  assert.equal(languageReleased(mvp, "es"), false);
  assert.equal(languageReleased(mvp, "en"), true);
  // Chinese is live and Spanish isn't: EN and 中文, no ES, even if es was stored.
  const zhOnly = await config(t, "mvp,zh");
  setLanguage("es");
  let html = render(LanguageSwitch, zhOnly);
  assert.doesNotMatch(html, />ES</);
  assert.match(html, /aria-pressed="true"[^>]*>EN</);
  assert.match(html, /aria-pressed="false"[^>]*>中文</);
  assert.doesNotMatch(html, /three/);
  assert.match(html, /aria-label="Language \/ 语言"/);
  assert.match(render(LanguageSettings, zhOnly), /Show the site in English or Simplified Chinese\./);
  assert.doesNotMatch(render(LanguageSettings, zhOnly), /Spanish/);
  assert.equal(languageReleased(zhOnly, "es"), false);
  setLanguage("en");
});

test("once released: EN / ES / 中文, the stored choice is the pressed one", async (t) => {
  const { LanguageSwitch, LanguageSettings, languageReleased } = await switchModule();
  const render = (C, cfg, props = {}) => renderToStaticMarkup(createElement(C, { config: cfg, ...props }));
  const live = await config(t, "mvp,zh,es");
  assert.equal(isReleased(live, "es"), true);
  assert.equal(languageReleased(live, "es"), true);
  let html = render(LanguageSwitch, live);
  assert.match(html, /data-i18n="off"/);
  assert.match(html, /aria-label="Language \/ Idioma \/ 语言"/);
  assert.match(html, /language-switch  ?three|language-switch three/);
  assert.match(html, /aria-pressed="true"[^>]*>EN</);
  assert.match(html, /lang="es"[^>]*>ES</);
  assert.match(html, /title="Español"/);
  assert.match(html, /aria-pressed="false"[^>]*>中文</);
  // (Server rendering always starts in English; the pressed button follows
  // the stored choice in the browser, through useShownLanguage.)
  assert.match(render(LanguageSettings, live), /Show the site in English, Spanish or Simplified Chinese\./);
  assert.match(render(LanguageSettings, live), /Language\./);
  setLanguage("en");
  // Spanish alone: EN and ES.
  const esOnly = await config(t, "mvp,es");
  html = render(LanguageSwitch, esOnly);
  assert.match(html, />EN</);
  assert.match(html, />ES</);
  assert.doesNotMatch(html, /中文/);
});

// ------------------------------------------------------------- the palette

test("the command palette offers one switch action per other language, once released", () => {
  const cfg = (...ids) => ({ releases: { features: Object.fromEntries(ids.map((id) => [id, true])) } });
  const langs = (config, language) =>
    paletteActions({ config, mode: "chat", signedIn: true, language }).filter((a) => a.id.startsWith("language"));
  // Chinese only: the one toggle, as before.
  const oldWay = langs(cfg("zh"), "en");
  assert.deepEqual(oldWay.map((a) => a.id), ["language"]);
  assert.equal(oldWay[0].label, "Switch to 中文");
  // Spanish released too: the other two languages, never the current one.
  const three = langs(cfg("zh", "es"), "en");
  assert.deepEqual(three.map((a) => a.id), ["language-es", "language-zh"]);
  assert.deepEqual(three.map((a) => a.label), ["Cambiar a español", "Switch to 中文"]);
  assert.deepEqual(langs(cfg("zh", "es"), "es").map((a) => a.id), ["language-en", "language-zh"]);
  assert.deepEqual(langs(cfg("zh", "es"), "zh").map((a) => a.id), ["language-en", "language-es"]);
  assert.deepEqual(langs(cfg("es"), "en").map((a) => a.id), ["language-es"]);
  assert.ok(three[0].keywords.includes("español") && three[0].keywords.includes("idioma"));
  // Unreleased: no language action at all.
  assert.deepEqual(langs(cfg(), "en"), []);
});

test("the small language-aware helpers know Spanish", () => {
  assert.equal(countLabel({ index: 0, total: 5, query: "a" }, "es"), "1 de 5");
  assert.equal(countLabel({ index: 0, total: 0, query: "a" }, "es"), "Sin coincidencias");
  assert.equal(countLabel({ index: 0, total: 5, query: "a" }, "zh"), "第 1 个，共 5 个");
  assert.equal(countLabel({ index: 0, total: 5, query: "a" }, true), "第 1 个，共 5 个");
  assert.equal(countLabel({ index: 0, total: 5, query: "a" }), "1 of 5");
  const facts = { kind: "transaction", chain: { id: 4663 } };
  assert.match(chainFactsText(facts, { lang: "es" }), /Write the explanation in Spanish/);
  assert.match(chainFactsText(facts, { lang: "zh" }), /Simplified Chinese/);
  assert.doesNotMatch(chainFactsText(facts, { lang: "en" }), /Write the explanation in/);
});

// --------------------------------------------------------------- the offline page

test("the offline page follows the Spanish choice", () => {
  const script = read("public/offline.js");
  const run = (stored) => {
    const classes = new Set();
    const document = { documentElement: { classList: { add: (c) => classes.add(c) }, lang: "en" }, title: "You're offline — ANONYMA" };
    vm.runInNewContext(script, { document, localStorage: { getItem: () => stored } });
    return { classes, lang: document.documentElement.lang, title: document.title };
  };
  const spanish = run("es");
  assert.deepEqual([...spanish.classes], ["es"]);
  assert.equal(spanish.lang, "es-419");
  assert.equal(spanish.title, "Sin conexión — ANONYMA");
  assert.equal(run("zh").lang, "zh-CN");
  assert.equal(run(null).lang, "en");
  assert.equal(run("fr").lang, "en");
  const html = read("public/offline.html");
  assert.match(html, /class="es-copy" lang="es-419"/);
  assert.match(html, /html\.es \.es-copy \{ display: block; \}/);
  assert.match(html, /Sin conexión/);
});

test("Spanish is client-only: nothing is stored on the server or sent anywhere", () => {
  const source = read("src/i18n.js");
  // The choice lives in this browser's localStorage and nowhere else.
  assert.doesNotMatch(source, /fetch\(|XMLHttpRequest|sendBeacon|navigator\.language/);
  assert.match(source, /localStorage|storage\(\)/);
  // The dictionary is loaded on demand, like the Chinese one.
  assert.match(source, /import\("\.\/i18n\/es\.json"\)/);
  assert.match(source, /import\("\.\/i18n\/zh\.json"\)/);
  assert.ok(!/from "\.\/i18n\/(es|zh)\.json"/.test(source), "the dictionaries must stay lazy");
});

// ------------------------------------------------- fixes after the release

test("the release list reads every update by name, including names with a comma or an ampersand", () => {
  // "Research, Writing & Calculators" and "Edit, Regenerate & Branch Chats"
  // have a comma in them: the list is read name by name, a name at a time.
  const config = {
    services: { generation: true },
    releases: { features: {}, updates: UPDATES.map((u) => ({ id: u.id, title: u.title, released: true })) },
  };
  const summary = releaseCopy(config).summary;
  const spanish = translateText(summary, es);
  const chinese = translateText(summary, zh);
  assert.ok(spanish && chinese);
  for (const { title } of UPDATES) {
    const inEs = translateText(title, es);
    const inZh = translateText(title, zh);
    if (inEs && inEs !== title) assert.ok(spanish.includes(inEs), `Spanish list lost ${JSON.stringify(title)}`);
    if (inZh && inZh !== title) assert.ok(chinese.includes(inZh), `Chinese list lost ${JSON.stringify(title)}`);
  }
  // No half-English name is left over: none of the fragments a comma splits.
  for (const left of ["Writing & Calculators", "Regenerate & Branch Chats", "More Reliable Answers", "Longer,"]) {
    assert.doesNotMatch(spanish, new RegExp(left.replace(/[&,]/g, "\\$&")), left);
    assert.doesNotMatch(chinese, new RegExp(left.replace(/[&,]/g, "\\$&")), left);
  }
  assert.match(spanish, /Investigación, redacción y calculadoras/);
  assert.match(spanish, /Respuestas más largas y confiables/);
  assert.match(spanish, /Editar, regenerar y ramificar chats/);
  // The tail of the list is a name too: "Prepaid credits" is not "{0} credits".
  assert.match(spanish, /Panel, Cuenta, Créditos prepago\./);
  assert.match(chinese, /控制台、账户、预付积分/);
  // Names the dictionary lacks pass through; a sentence is not a list.
  const small = compileDictionary({ strings: { Chat: "Chat", Account: "Cuenta" }, patterns: [{ en: "Enabled: {0}.", es: "Activado: {0}." }] }, "es");
  assert.equal(translateText("Enabled: Chat, Veil, Account.", small), "Activado: Chat, Veil, Cuenta.");
  assert.equal(translateText("Enabled: Hello there, this is not a list of names at all.", small), undefined);
});

test("text with its ampersands escaped (once or twice) is read as what it was", () => {
  assert.equal(translateText("Research, Writing &amp;amp; Calculators", es), "Investigación, redacción y calculadoras");
  assert.equal(translateText("Research, Writing &amp;amp; Calculators", zh), "研究、写作与计算器");
  assert.equal(translateText("Code &amp; Build", es), "Código y desarrollo");
  assert.equal(translateText("Voice &#38; Audio", es), "Voz y audio");
  assert.equal(translateText("Edit, Regenerate &amp;amp; Branch Chats", es), "Editar, regenerar y ramificar chats");
  // What isn't a known string stays as it is, entities and all.
  assert.equal(translateText("Something &amp; nothing at all", es), undefined);
});

test("the NYMA tier names read the same way in Spanish as in Chinese: translated", () => {
  const tiers = { Holder: ["持有者", "Titular"], Insider: ["资深持有者", "Avanzado"], "Inner Circle": ["核心圈", "Círculo íntimo"] };
  for (const [name, [inZh, inEs]] of Object.entries(tiers)) {
    assert.equal(translateText(name, zh), inZh, name);
    assert.equal(translateText(name, es), inEs, name);
    assert.equal(translateText(name + ".", es), inEs + ".", name);
  }
  // Nothing Spanish calls an "Insider" any more, sentences included.
  for (const [en, text] of [...Object.entries(esRaw.strings), ...esRaw.patterns.map((p) => [p.en, p.es])])
    assert.doesNotMatch(text, /Insider/, `${JSON.stringify(en)} → ${JSON.stringify(text)}`);
  assert.equal(translateText("Insider and up", es), "Avanzado y superiores");
  assert.equal(translateText("Your API rate limit: 360 requests/min (Insider boost)", es), "Tu límite de frecuencia de API: 360 solicitudes/min (impulso Avanzado)");
});

test("the header keeps short labels in Spanish: Flujos, Recursos and Entrar, only up there", () => {
  const page = `<!doctype html><html lang="en"><head><title>x</title></head><body>
    <header class="header"><nav class="nav" aria-label="Main navigation">
      <a>Platform</a>
      <div class="nav-drop"><button>Workflows <svg></svg></button></div>
      <div class="nav-drop"><button>Knowledge Base <svg></svg></button></div>
    </nav><div class="header-actions"><a>Log in</a><a class="header-cta">Get started</a></div></header>
    <main><h2>Workflows</h2><h2>Knowledge Base</h2><a>Log in</a></main></body></html>`;
  withPage(page, (document) => {
    startTranslator(es);
    const buttons = [...document.querySelectorAll(".nav-drop > button")].map((b) => b.textContent.trim());
    assert.deepEqual(buttons, ["Flujos", "Recursos"]);
    assert.equal(document.querySelector(".header-actions > a").textContent, "Entrar");
    assert.equal(document.querySelector(".header-cta").textContent, "Comenzar");
    assert.equal(document.querySelector(".nav > a").textContent, "Plataforma");
    // Everywhere else the full names stay.
    assert.deepEqual([...document.querySelectorAll("main h2")].map((h) => h.textContent), ["Flujos de trabajo", "Base de conocimiento"]);
    assert.equal(document.querySelector("main a").textContent, "Iniciar sesión");
    stopTranslator();
    assert.deepEqual([...document.querySelectorAll(".nav-drop > button")].map((b) => b.textContent.trim()), ["Workflows", "Knowledge Base"]);
    assert.equal(document.querySelector(".header-actions > a").textContent, "Log in");
  });
});

test("the header's labels stay on one line and the breadcrumb is cut with an ellipsis", () => {
  const css = read("src/i18n.css");
  assert.match(css, /@media \(min-width: 1100px\) \{\s+\.header \.nav > a,\s+\.header \.nav > \.nav-drop > button,\s+\.header-actions > a \{\s+white-space: nowrap;/);
  assert.match(css, /@media \(min-width: 940px\) and \(max-width: 1439px\)/);
  assert.match(css, /\.app-shell \.workspace-header > span \{\s+min-width: 0;\s+overflow: hidden;\s+text-overflow: ellipsis;\s+white-space: nowrap;/);
});
