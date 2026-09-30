import { cleanTokens, tokensFromLines, SYSTEM_PREFIX, firstJson } from "../src/subtitles.js";
import { TEST_MEETING, TEST_LINE_SECONDS, isCoarse } from "./meeting-notes.js";

// Subtitles (update "subtitles"): what the routes need beyond what the
// browser shares (src/subtitles.js): the timed words a piece of a
// transcription reply gives, and the local test stand-ins for the
// transcription and translation models. The routes are
// server/routes/subtitles.js.

const round2 = (n) => Math.round(n * 100) / 100;

// The words of one piece as tokens { text, start, end } in the piece's own
// time, or [] when the reply can't be timed into cues. The reply's own word
// timings (as written, punctuation kept) are used; failing those, its lines,
// when none of them is coarse (a line over 30 seconds, or a piece with no
// timings at all, says little about where in it a word was said): their
// words spread by length over each line. Nothing is invented: a piece whose
// timing is unusable is refused, not guessed.
export function pieceTokens(reply, seconds) {
  const inside = (list) => list.filter((t) => t.start <= seconds + 1 && t.end >= 0);
  let tokens = cleanTokens(Array.isArray(reply?.tokens) ? reply.tokens : []);
  if (tokens.length) return inside(tokens);
  const lines = Array.isArray(reply?.segments) ? reply.segments : [];
  if (!lines.length || lines.some((s) => s.untimed || isCoarse(s))) return [];
  tokens = cleanTokens(tokensFromLines(lines));
  return inside(tokens);
}
// A piece's tokens placed in the whole video, never outside the piece.
export function placeTokens(tokens, start, seconds) {
  return tokens.map((t) => ({
    text: t.text,
    start: round2(start + Math.min(seconds, t.start)),
    end: round2(start + Math.min(seconds, Math.max(t.start, t.end))),
  }));
}

// ---- Local test mode ----

// LOCAL_TEST_MODE only: the scripted meeting of Meeting Notes' test mode
// (server/meeting-notes.js), spoken word by word at a steady pace with a
// pause between lines, so the whole flow runs with no provider. Never used
// live.
export const TEST_WORD_SECONDS = 0.36;
export function subtitleTestTranscript({ start, seconds }) {
  const words = [];
  let at = 0;
  let k = 0;
  const sentences = TEST_MEETING;
  // The script is laid out from the start of the video so a piece finds
  // the same words wherever it begins.
  while (at < start + seconds && k < 10000) {
    const text = sentences[k % sentences.length];
    const parts = text.split(" ");
    parts.forEach((w, i) => {
      const s = at + i * TEST_WORD_SECONDS;
      words.push({ text: w, start: s, end: s + TEST_WORD_SECONDS * 0.9 });
    });
    at += parts.length * TEST_WORD_SECONDS + 0.9 + (k % 3 === 0 ? 0.6 : 0);
    k++;
  }
  const tokens = words
    .filter((w) => w.start >= start - 1e-9 && w.start < start + seconds)
    .map((w) => ({ text: w.text, start: round2(w.start - start), end: round2(Math.min(seconds, w.end - start)) }));
  return { text: tokens.map((t) => t.text).join(" "), duration: seconds, tokens, segments: [] };
}

// Spanish for the scripted meeting's sentences, so the test stand-in for the
// translation model can show a real-looking track. A sentence not listed, or
// any other language, is echoed with a marker: it's a stand-in, never a
// translation.
const TEST_ES = new Map(
  [
    ["Okay, let's get started.", "Bien, empecemos."],
    ["This is the weekly launch sync for Atlas 2.0.", "Esta es la reunión semanal de lanzamiento de Atlas 2.0."],
    ["Quick agenda: the pricing page, the beta feedback, and the Android build.", "Agenda rápida: precios, comentarios de la beta y versión de Android."],
    ["First, pricing.", "Primero, precios."],
    ["Last week we had two options for the free tier.", "La semana pasada teníamos dos opciones para el plan gratuito."],
    ["I looked at the numbers again.", "Revisé de nuevo los números."],
    ["Most beta users stay under 1,000 credits a month.", "La mayoría de los usuarios de la beta usa menos de 1000 créditos al mes."],
    ["So we decided to keep the free tier at 1,000 credits, and drop the idea of a trial.", "Decidimos dejar el plan gratuito en 1000 créditos y olvidar la prueba."],
    ["Good.", "Bien."],
    ["Maya will update the pricing page copy before Thursday.", "Maya actualizará el texto de la página de precios antes del jueves."],
    ["I can do that.", "Yo lo hago."],
    ["I'll send the draft to maya.chen@example.com for review first, then post it.", "Enviaré el borrador a maya.chen@example.com para revisión y luego lo publico."],
    ["Next, the beta feedback.", "Ahora, los comentarios de la beta."],
    ["We had 140 responses this week.", "Esta semana tuvimos 140 respuestas."],
    ["The top complaint is still the export.", "La queja principal sigue siendo la exportación."],
    ["People want Markdown, not just PDF.", "La gente quiere Markdown, no solo PDF."],
    ["Agreed: Markdown export ships in 2.0, and PDF can wait for 2.1.", "De acuerdo: Markdown sale en la 2.0 y el PDF puede esperar a la 2.1."],
    ["Dev, can you size the Markdown export work by Monday?", "Dev, ¿puedes estimar la exportación a Markdown para el lunes?"],
    ["Sure, I'll have an estimate by Monday.", "Claro, tendré una estimación para el lunes."],
    ["Second complaint was the onboarding.", "La segunda queja fue la bienvenida."],
    ["Three people got stuck on the workspace invite.", "Tres personas se atascaron con la invitación al espacio."],
  ].map(([en, es]) => [en, es]),
);
const sentencesOf = (text) => text.split(/(?<=[.!?])\s+/).filter(Boolean);
// The workspace's local test stand-in for the translation model: it reads
// the cues out of the prompt and answers with strict JSON, one object per
// cue, in the shape the prompt asks for.
export function subtitleTranslateTestReply(messages) {
  const system = messages?.[0]?.content;
  if (typeof system !== "string" || !system.startsWith(SYSTEM_PREFIX)) return null;
  const target = /Target language: .*? \(([^)]+)\)/.exec(system)?.[1] || "";
  const user = String(messages.find((m) => m.role === "user")?.content || "");
  const doc = /<document name="[^"]*"[^>]*>([\s\S]*?)<\/document>/.exec(user)?.[1] || "";
  const items = firstJson(doc.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")) || [];
  const flatCue = (t) => String(t).replace(/\s+/g, " ").trim();
  const said = (text) => {
    const parts = sentencesOf(flatCue(text)).map((x) => (target === "es" ? TEST_ES.get(x) : null));
    return parts.length && parts.every(Boolean) ? parts.join(" ") : `[test ${target}] ${flatCue(text)}`;
  };
  return JSON.stringify((Array.isArray(items) ? items : []).map((i) => ({ n: i.n, text: said(i.text) })));
}
export { TEST_LINE_SECONDS };
