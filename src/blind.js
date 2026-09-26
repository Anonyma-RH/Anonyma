// Blind Compare: two models answer the same message side by side, labelled
// A and B in a random order, with names and per-reply costs hidden until the
// person votes. Pure and DOM-free: the workspace (src/Blind.jsx), the server
// (server/routes/blind.js) and the tests all import it.

export const SIDES = ["a", "b"];
// A is better, B is better, a tie, or both bad.
export const OUTCOMES = ["a", "b", "tie", "bad"];
// Votes kept per account (the newest); older ones drop off the rankings.
export const MAX_VOTES = 5000;

// A model's USD price for a typical exchange (2,000 tokens in, 1,000 out),
// the same yardstick Model Finder uses; null when the catalog has no rates.
export function typicalPrice(m) {
  const i = m?.pricing?.input_per_1M_tokens,
    o = m?.pricing?.output_per_1M_tokens;
  const ok = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return ok(i) && ok(o) ? (i * 2000 + o * 1000) / 1e6 : null;
}

// Who makes a model, for choosing two different voices when possible.
const maker = (m) =>
  String(m?.owned_by || m?.provider || String(m?.id || "").split("/")[0] || "")
    .trim()
    .toLowerCase();

// The models a blind round can use here: live chat models the service can
// run, in this section (Uncensored keeps its own), private ones only in
// Private Mode, and ones that can read images when the chat has some.
// Sealed (enclave) models never take part.
export function blindPool(
  models,
  { mode = "chat", privateMode = false, needsVision = false, uncensored = [] } = {},
) {
  return (models || []).filter(
    (m) =>
      m.type === "chat" &&
      m.callable &&
      !m.sealed &&
      (mode === "uncensored") === uncensored.includes(m.id) &&
      (!privateMode || m.private) &&
      (!needsVision || m.vision),
  );
}

// "Surprise me": two different models picked at random from the pool, in the
// same price band as `current` (within 3x either way, widened to 10x and
// then the whole pool while fewer than two fit), from two different makers
// when the band allows. Returns [id, id] or null when the pool is too small.
export function surprisePair(pool, current, random = Math.random) {
  const priced = (pool || []).filter((m) => typicalPrice(m) != null);
  if (priced.length < 2) return null;
  const sorted = priced.map(typicalPrice).sort((x, y) => x - y);
  const base = typicalPrice(current) ?? sorted[Math.floor((sorted.length - 1) / 2)];
  let band = priced;
  for (const f of [3, 10]) {
    const fit = priced.filter((m) => {
      const p = typicalPrice(m);
      return p <= base * f && p >= base / f;
    });
    if (fit.length >= 2) {
      band = fit;
      break;
    }
  }
  const pick = (list) => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  const first = pick(band);
  const others = band.filter((m) => m.id !== first.id);
  const apart = others.filter((m) => maker(m) !== maker(first));
  return [first.id, pick(apart.length ? apart : others).id];
}

// The pair to start from: the chosen model and the first other model by a
// different maker (else any other), or the pool's first two.
export function defaultPair(pool, current) {
  const list = pool || [];
  const first = list.find((m) => m.id === current?.id) || list[0];
  if (!first) return [];
  const second =
    list.find((m) => m.id !== first.id && maker(m) !== maker(first)) ||
    list.find((m) => m.id !== first.id);
  return second ? [first.id, second.id] : [first.id];
}

// Two different models, both still in the pool.
export const validPair = (pair, pool) =>
  Array.isArray(pair) &&
  pair.length === 2 &&
  pair[0] !== pair[1] &&
  pair.every((id) => (pool || []).some((m) => m.id === id));

// Which reply the conversation carries on from: the pick when there is one;
// for a tie, both bad, an unrevealed round or a failed side, reply A (or
// whichever side answered).
export function chosenSide(blind) {
  const o = blind?.reveal?.outcome;
  if (o === "a" || o === "b") return o;
  return blind?.a?.text?.trim() || !blind?.b?.text?.trim() ? "a" : "b";
}
export const historyText = (blind) => blind?.[chosenSide(blind)]?.text || "";

// The saved turn as one readable text (Export, Share, Bookmarks and search
// read it): A and B labelled, and once revealed, each model's name and the
// vote. Never a name before the vote.
export function blindText(blind) {
  const r = blind?.reveal;
  const head = (side) => {
    const label = `Reply ${side.toUpperCase()}`;
    const who = r?.[side]?.name || r?.[side]?.model;
    if (!who) return `**Blind compare · ${label}**`;
    const vote =
      r.outcome === side
        ? " · your pick"
        : r.outcome === "tie"
          ? " · tie"
          : r.outcome === "bad"
            ? " · both bad"
            : "";
    return `**${label} · ${who}${vote}**`;
  };
  return SIDES.map((side) => {
    const x = blind?.[side] || {};
    const body = x.text?.trim()
      ? x.text.trim()
      : x.error
        ? `_${String(x.error).replace(/[_*]/g, "")}_`
        : "_No reply._";
    return `${head(side)}\n\n${body}`;
  }).join("\n\n---\n\n");
}

// Win rates from the account's own votes. A win counts 1, a tie half for
// each, and "both bad" is a loss for both. Sorted by win rate, then by how
// often the model was compared.
export function rankings(votes) {
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id))
      rows.set(id, { model: id, rounds: 0, wins: 0, ties: 0, losses: 0, both_bad: 0 });
    return rows.get(id);
  };
  for (const v of votes || []) {
    if (!OUTCOMES.includes(v?.outcome)) continue;
    if (!v.model_a || !v.model_b || v.model_a === v.model_b) continue;
    const a = row(v.model_a),
      b = row(v.model_b);
    a.rounds++;
    b.rounds++;
    if (v.outcome === "a") {
      a.wins++;
      b.losses++;
    } else if (v.outcome === "b") {
      b.wins++;
      a.losses++;
    } else if (v.outcome === "tie") {
      a.ties++;
      b.ties++;
    } else {
      a.losses++;
      b.losses++;
      a.both_bad++;
      b.both_bad++;
    }
  }
  return [...rows.values()]
    .map((r) => ({ ...r, win_rate: Math.round(((r.wins + r.ties / 2) / r.rounds) * 1000) / 1000 }))
    .sort(
      (x, y) =>
        y.win_rate - x.win_rate || y.rounds - x.rounds || x.model.localeCompare(y.model),
    );
}

export const percent = (rate) => `${Math.round((Number(rate) || 0) * 100)}%`;
// "4.2 s", "850 ms".
export function formatSpeed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return "";
  return n < 1000 ? `${Math.round(n)} ms` : `${(n / 1000).toFixed(1)} s`;
}

// A fresh round on screen before its first event.
export const pendingBlind = () => ({
  a: { text: "", reasoning: "", status: "streaming" },
  b: { text: "", reasoning: "", status: "streaming" },
  pending: true,
});

// Applies one /api/blind event to the round on screen. Events never carry a
// model's name or a reply's own cost; the final one carries the round token
// to vote with (or, when a side failed, the reveal straight away).
export function applyBlindEvent(blind, event) {
  if (!event || typeof event !== "object") return blind;
  const side = SIDES.includes(event.side) ? event.side : null;
  if (side && event.delta) {
    const cur = blind[side] || { text: "", reasoning: "" };
    return {
      ...blind,
      [side]: {
        ...cur,
        text: cur.text + (typeof event.delta.content === "string" ? event.delta.content : ""),
        reasoning:
          (cur.reasoning || "") +
          (typeof event.delta.reasoning === "string" ? event.delta.reasoning : ""),
      },
    };
  }
  if (side && event.status)
    return {
      ...blind,
      [side]: {
        ...blind[side],
        status: event.status,
        ...(event.error?.message ? { error: String(event.error.message) } : {}),
      },
    };
  const done = event.blind;
  if (done?.done) {
    const next = { ...blind, pending: false, credits: done.credits_charged ?? null };
    for (const s of SIDES)
      if (done.sides?.[s]?.status)
        next[s] = {
          ...next[s],
          status: done.sides[s].status,
          ...(done.sides[s].error ? { error: String(done.sides[s].error) } : {}),
        };
    if (done.round) next.token = done.round;
    if (done.reveal) next.reveal = done.reveal;
    return next;
  }
  return blind;
}

// Whether the round can still be voted on here.
export const canVote = (blind) =>
  !!blind?.token && !blind.reveal && !blind.pending;

// The turn on screen once revealed: the token goes (it's been used) and the
// readable text names both models.
export function revealTurn(message, reveal) {
  const { token, ...rest } = message.blind || {};
  const blind = { ...rest, reveal };
  return { ...message, blind, content: blindText(blind) };
}
// A round that can't be voted on any more (its token expired or is unknown).
export function closeTurn(message) {
  const { token, ...rest } = message.blind || {};
  return { ...message, blind: { ...rest, closed: true } };
}

// Both models still offered here (the same one twice is caught separately).
export const pairInPool = (pair, pool) =>
  Array.isArray(pair) &&
  pair.length === 2 &&
  pair.every((id) => (pool || []).some((m) => m.id === id));

// Randomness for "Surprise me" from the browser's CSPRNG.
export const secureRandom = () =>
  globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
