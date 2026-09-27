// Document Compare ("doccompare"): the diff engine, the passages a summary
// may send, and the exports. Pure and DOM-free, so the same code runs in the
// page's Web Worker (src/compare.worker.js), on the page and in node tests.
// Nothing here sends, stores or logs anything: both documents stay in this
// browser's memory, and only buildHunks' output can ever reach a model.
//
// How two versions are compared:
// 1. Each is split into units: paragraphs (one per line; blank lines only
//    separate them), or sentences when either side is a PDF, whose page
//    breaks and line wraps say nothing about its structure.
// 2. The units are diffed with Myers' algorithm (linear-space bisection).
// 3. Inside each run of removed and added units, the most alike pairs
//    (by word overlap, in order) become "changed" units with a word-level
//    diff; the rest are added or removed.
// 4. A removed unit whose text turns up among the added ones elsewhere is a
//    move (best effort: long enough to be distinctive, the same or nearly).
// 5. Each changed unit, each run of added or of removed units, and each
//    move is one change: the unit of the change list, navigation and the
//    summary's passages.

export const MAX_FILE_BYTES = 25 * 1024 * 1024;
// "2 × 5 MB of text": the most text Compare reads from each version.
export const MAX_TEXT_CHARS = 5 * 1024 * 1024;
// The whole comparison gets this long before the rest is done coarsely
// (marked `approximate`), so a pathological pair can't hang the worker.
export const TIME_BUDGET_MS = 20000;

const PAIR_MIN = 0.45; // word overlap for two units to be one changed unit
const MOVE_MIN = 30; // characters: shorter units repeat too often to be moves
const MOVE_SIMILAR = 0.85; // word overlap for an edited move
const DP_CELLS = 2500; // pairing is exact up to this many candidate pairs
const MOVE_CANDIDATES = 40000; // near-exact move search up to this many pairs

// ---- Text and units ---------------------------------------------------------

// Line breaks become \n, tabs and odd spaces become spaces, control
// characters go, and runs of spaces collapse: spacing differences are never
// reported as changes.
export function normalizeText(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\u00a0\u2007\u202f\u3000]/g, " ")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .split("\n")
    .map((line) => line.replace(/ {2,}/g, " ").trim())
    .join("\n");
}

const ABBREVIATIONS = new Set([
  "e.g", "i.e", "etc", "mr", "mrs", "ms", "dr", "prof", "no", "nos", "sec",
  "secs", "art", "arts", "inc", "ltd", "co", "corp", "llc", "plc", "vs", "v",
  "st", "cf", "al", "fig", "p", "pp", "para", "paras", "cl", "sch", "u.s",
  "u.k", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct",
  "nov", "dec", "approx", "est", "dept", "govt",
]);
const ROMAN = /^(i{1,3}|iv|vi{0,3}|ix|x{1,3})$/;
const ENDS = /[.!?]+["'”’)\]]*\s+|[。！？]+["'”’」』）)]*\s*/gu;
// One line split into sentences at . ! ? (and 。！？) followed by a capital
// letter or a digit, except after a number, a single letter, a short roman
// numeral or a common abbreviation ("1. Definitions", "e.g. Acme", "U.S.
// law" stay whole).
export function splitSentences(line) {
  const out = [];
  let start = 0,
    m;
  ENDS.lastIndex = 0;
  while ((m = ENDS.exec(line))) {
    const end = m.index + m[0].length;
    if (end >= line.length) break;
    const mark = m[0][0];
    if (mark === "." || mark === "!" || mark === "?") {
      if (!/^["'“‘(\[]?[\p{Lu}\p{N}\p{Script=Han}]/u.test(line.slice(end, end + 2))) continue;
      if (mark === ".") {
        const word = (/(\S+)$/.exec(line.slice(start, m.index))?.[1] || "")
          .replace(/^["'“‘(\[]+/, "")
          .toLowerCase();
        if (
          !word ||
          /^\p{N}+([.,]\p{N}+)*$/u.test(word) ||
          /^\p{L}$/u.test(word) ||
          ROMAN.test(word) ||
          ABBREVIATIONS.has(word)
        )
          continue;
      }
    }
    const piece = line.slice(start, end).trim();
    if (piece) out.push(piece);
    start = end;
  }
  const rest = line.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

// "sentences" when either side is a PDF, else "paragraphs".
export const unitModeFor = (kindA, kindB) =>
  kindA === "pdf" || kindB === "pdf" ? "sentences" : "paragraphs";

// A document's units. A PDF's text flows across its pages first, so a page
// break that moves between versions isn't reported as a change.
export function unitsOf(text, kind, mode) {
  let t = normalizeText(text);
  if (mode === "sentences" && kind === "pdf")
    t = t.replace(/\n+/g, " ").replace(/ {2,}/g, " ").trim();
  const lines = t.split("\n").filter(Boolean);
  return mode === "sentences" ? lines.flatMap(splitSentences) : lines;
}

// ---- Words and tokens -------------------------------------------------------

// A word (numbers keep their separators: 1,000.50, 30-day, O'Brien), one
// CJK character, a run of spaces, or one other character.
const TOKEN =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}_]+(?:['’.,\-/][\p{L}\p{N}\p{M}_]+)*|\s+|[^\s]/gu;
export const tokenize = (text) => String(text || "").match(TOKEN) || [];
const WORDISH = /[\p{L}\p{N}]/u;
export const countWords = (text) =>
  tokenize(text).filter((t) => WORDISH.test(t)).length;
function wordBag(text) {
  const bag = new Map();
  let size = 0;
  for (const t of tokenize(text))
    if (WORDISH.test(t)) {
      const w = t.toLowerCase();
      bag.set(w, (bag.get(w) || 0) + 1);
      size++;
    }
  return { bag, size };
}
// Dice's coefficient over word counts: 1 is the same words, 0 none shared.
function overlap(x, y) {
  if (!x.size || !y.size) return 0;
  const [small, large] = x.bag.size <= y.bag.size ? [x, y] : [y, x];
  let shared = 0;
  for (const [w, n] of small.bag) shared += Math.min(n, large.bag.get(w) || 0);
  return (2 * shared) / (x.size + y.size);
}

// ---- Myers' diff over two arrays --------------------------------------------

// Runs [op, n]: 0 keeps n items, -1 removes n from `a`, 1 adds n from `b`.
// Minimal unless `clock.deadline` passes, after which what's left of a range
// is reported as removed then added, and `clock.timedOut` is set.
export function diffSequences(a, b, clock = { deadline: Infinity }) {
  const out = [];
  diffRange(a, 0, a.length, b, 0, b.length, out, clock);
  const merged = [];
  for (const [op, n] of out) {
    const last = merged.at(-1);
    if (last && last[0] === op) last[1] += n;
    else merged.push([op, n]);
  }
  return merged;
}
function diffRange(a, aLo, aHi, b, bLo, bHi, out, clock) {
  let pre = 0;
  while (aLo + pre < aHi && bLo + pre < bHi && a[aLo + pre] === b[bLo + pre]) pre++;
  let suf = 0;
  while (
    aHi - suf > aLo + pre &&
    bHi - suf > bLo + pre &&
    a[aHi - 1 - suf] === b[bHi - 1 - suf]
  )
    suf++;
  if (pre) out.push([0, pre]);
  const aS = aLo + pre,
    aE = aHi - suf,
    bS = bLo + pre,
    bE = bHi - suf;
  if (aS === aE) {
    if (bE > bS) out.push([1, bE - bS]);
  } else if (bS === bE) out.push([-1, aE - aS]);
  else {
    const split = bisect(a, aS, aE, b, bS, bE, clock);
    const n = aE - aS,
      m = bE - bS;
    if (!split || (split[0] === 0 && split[1] === 0) || (split[0] === n && split[1] === m)) {
      out.push([-1, n], [1, m]);
    } else {
      diffRange(a, aS, aS + split[0], b, bS, bS + split[1], out, clock);
      diffRange(a, aS + split[0], aE, b, bS + split[1], bE, out, clock);
    }
  }
  if (suf) out.push([0, suf]);
}
// The middle snake of an optimal path (Myers 1986, as in diff-match-patch),
// in linear space. Returns the split point [x, y], or null.
function bisect(a, aS, aE, b, bS, bE, clock) {
  const n = aE - aS,
    m = bE - bS;
  const maxD = Math.ceil((n + m) / 2);
  const off = maxD,
    len = 2 * maxD + 2;
  const v1 = new Int32Array(len).fill(-1),
    v2 = new Int32Array(len).fill(-1);
  v1[off + 1] = 0;
  v2[off + 1] = 0;
  const delta = n - m,
    front = delta % 2 !== 0;
  let k1start = 0,
    k1end = 0,
    k2start = 0,
    k2end = 0;
  for (let d = 0; d < maxD; d++) {
    if ((d & 31) === 0 && Date.now() > clock.deadline) {
      clock.timedOut = true;
      return null;
    }
    for (let k1 = -d + k1start; k1 <= d - k1end; k1 += 2) {
      const k1o = off + k1;
      let x1 =
        k1 === -d || (k1 !== d && v1[k1o - 1] < v1[k1o + 1])
          ? v1[k1o + 1]
          : v1[k1o - 1] + 1;
      let y1 = x1 - k1;
      while (x1 < n && y1 < m && a[aS + x1] === b[bS + y1]) {
        x1++;
        y1++;
      }
      v1[k1o] = x1;
      if (x1 > n) k1end += 2;
      else if (y1 > m) k1start += 2;
      else if (front) {
        const k2o = off + delta - k1;
        if (k2o >= 0 && k2o < len && v2[k2o] !== -1 && x1 >= n - v2[k2o])
          return [x1, y1];
      }
    }
    for (let k2 = -d + k2start; k2 <= d - k2end; k2 += 2) {
      const k2o = off + k2;
      let x2 =
        k2 === -d || (k2 !== d && v2[k2o - 1] < v2[k2o + 1])
          ? v2[k2o + 1]
          : v2[k2o - 1] + 1;
      let y2 = x2 - k2;
      while (x2 < n && y2 < m && a[aS + n - x2 - 1] === b[bS + m - y2 - 1]) {
        x2++;
        y2++;
      }
      v2[k2o] = x2;
      if (x2 > n) k2end += 2;
      else if (y2 > m) k2start += 2;
      else if (!front) {
        const k1o = off + delta - k2;
        if (k1o >= 0 && k1o < len && v1[k1o] !== -1) {
          const x1 = v1[k1o];
          if (x1 >= n - x2) return [x1, off + x1 - k1o];
        }
      }
    }
  }
  return null;
}

// ---- Word-level diff ---------------------------------------------------------

// Parts [op, text] (0 kept, -1 removed, 1 added) turning `before` into
// `after`, word by word. Within each change the removal comes first, and a
// short kept stretch between two changes joins them ("[-a b-]{+c d+}"
// rather than "[-a-]{+c+} [-b-]{+d+}").
export function wordDiff(before, after, clock = { deadline: Infinity }) {
  const ta = tokenize(before),
    tb = tokenize(after);
  const ids = new Map();
  const id = (t) => {
    let v = ids.get(t);
    if (v === undefined) ids.set(t, (v = ids.size));
    return v;
  };
  const runs = diffSequences(ta.map(id), tb.map(id), clock);
  const segments = [];
  let i = 0,
    j = 0;
  for (const [op, n] of runs) {
    if (op === 0) {
      segments.push({ eq: ta.slice(i, i + n).join("") });
      i += n;
      j += n;
      continue;
    }
    let last = segments.at(-1);
    if (!last || last.eq !== undefined) segments.push((last = { del: "", ins: "" }));
    if (op === -1) {
      last.del += ta.slice(i, i + n).join("");
      i += n;
    } else {
      last.ins += tb.slice(j, j + n).join("");
      j += n;
    }
  }
  // Readability (after diff-match-patch's semantic cleanup): a kept stretch
  // shorter than the changes on both sides of it (or only spaces between two
  // replacements) joins them, so "or" and lone spaces don't chop one rewrite
  // into pieces. Repeated until stable.
  let joined = segments;
  for (let changed = true; changed; ) {
    changed = false;
    const next = [];
    for (let k = 0; k < joined.length; k++) {
      const s = joined[k],
        prev = next.at(-1),
        after = joined[k + 1];
      const size = (c) => Math.max(c.del.length, c.ins.length);
      if (
        s.eq !== undefined &&
        prev &&
        prev.eq === undefined &&
        after &&
        after.eq === undefined &&
        (s.eq.length < Math.min(size(prev), size(after)) ||
          (/^\s+$/.test(s.eq) && prev.del && prev.ins && after.del && after.ins))
      ) {
        next[next.length - 1] = {
          del: prev.del + s.eq + after.del,
          ins: prev.ins + s.eq + after.ins,
        };
        k++;
        changed = true;
        continue;
      }
      next.push(s);
    }
    joined = next;
  }
  const parts = [];
  for (const s of joined) {
    if (s.eq !== undefined) {
      if (s.eq) parts.push([0, s.eq]);
    } else {
      if (s.del) parts.push([-1, s.del]);
      if (s.ins) parts.push([1, s.ins]);
    }
  }
  return parts;
}
// What the parts make on each side: 0 for the original, 1 for the revised.
export const partsText = (parts, side) =>
  parts
    .filter(([op]) => op === 0 || op === (side ? 1 : -1))
    .map(([, t]) => t)
    .join("");

// ---- Comparing two documents ---------------------------------------------

// Pairs of positions [i in removed, j in added], in order, that are alike
// enough to be one changed unit, the most alike overall.
function pairUnits(removed, added, similarity) {
  const R = removed.length,
    A = added.length;
  if (!R || !A) return [];
  if (R * A <= DP_CELLS) {
    const score = Array.from({ length: R + 1 }, () => new Float64Array(A + 1));
    const sims = Array.from({ length: R }, (_, i) =>
      Array.from({ length: A }, (_, j) => similarity(removed[i], added[j])),
    );
    for (let i = 1; i <= R; i++)
      for (let j = 1; j <= A; j++) {
        const s = sims[i - 1][j - 1];
        score[i][j] = Math.max(
          score[i - 1][j],
          score[i][j - 1],
          s >= PAIR_MIN ? score[i - 1][j - 1] + s : -1,
        );
      }
    const pairs = [];
    for (let i = R, j = A; i > 0 && j > 0; ) {
      const s = sims[i - 1][j - 1];
      if (s >= PAIR_MIN && score[i][j] === score[i - 1][j - 1] + s) {
        pairs.push([i - 1, j - 1]);
        i--;
        j--;
      } else if (score[i][j] === score[i - 1][j]) i--;
      else j--;
    }
    return pairs.reverse();
  }
  // Too many to weigh every pair: walk both in order, looking a little ahead.
  const pairs = [];
  let j = 0;
  for (let i = 0; i < R && j < A; i++) {
    let best = -1,
      bestSim = PAIR_MIN;
    for (let k = j; k < Math.min(A, j + 12); k++) {
      const s = similarity(removed[i], added[k]);
      if (s >= bestSim) {
        best = k;
        bestSim = s;
        if (s === 1) break;
      }
    }
    if (best >= 0) {
      pairs.push([i, best]);
      j = best + 1;
    }
  }
  return pairs;
}

// The comparison of two texts. `kinds` are the documents' kinds ("pdf",
// "office", "text"), which choose paragraph or sentence units.
//   a, b      the units of the original and the revised version
//   rows      the redline, in reading order:
//             { t: "same", a, b } | { t: "changed", a, b, parts }
//             | { t: "added", b } | { t: "removed", a }
//             | { t: "moved-out", a, to } (to: the row it moved to)
//             | { t: "moved-in", a, b, from, parts? } (parts if also edited)
//   changes   { id, kind: changed | added | removed | moved, start, end
//             (rows), a, b ([first, last] unit numbers from 1, or null),
//             added, removed (words) }
//   counts    changes by kind and in total, and words added and removed
export function compareTexts(original, revised, { kinds = {}, deadline } = {}) {
  const clock = { deadline: deadline ?? Date.now() + TIME_BUDGET_MS, timedOut: false };
  const mode = unitModeFor(kinds.a, kinds.b);
  const a = unitsOf(original, kinds.a, mode),
    b = unitsOf(revised, kinds.b, mode);
  const keys = new Map();
  const key = (s) => {
    let v = keys.get(s);
    if (v === undefined) keys.set(s, (v = keys.size));
    return v;
  };
  const runs = diffSequences(a.map(key), b.map(key), clock);
  const bagsA = new Map(),
    bagsB = new Map();
  const bagA = (i) => bagsA.get(i) || (bagsA.set(i, wordBag(a[i])), bagsA.get(i));
  const bagB = (j) => bagsB.get(j) || (bagsB.set(j, wordBag(b[j])), bagsB.get(j));
  const rows = [];
  let removed = [],
    added = [];
  const flush = () => {
    const pairs = pairUnits(removed, added, (i, j) => overlap(bagA(i), bagB(j)));
    let r = 0,
      s = 0;
    for (const [pi, pj] of [...pairs, [removed.length, added.length]]) {
      for (; r < pi; r++) rows.push({ t: "removed", a: removed[r] });
      for (; s < pj; s++) rows.push({ t: "added", b: added[s] });
      if (pi < removed.length) {
        const ai = removed[r++],
          bj = added[s++];
        rows.push({ t: "changed", a: ai, b: bj, parts: wordDiff(a[ai], b[bj], clock) });
      }
    }
    removed = [];
    added = [];
  };
  let i = 0,
    j = 0;
  for (const [op, n] of runs) {
    if (op === 0) {
      flush();
      for (let k = 0; k < n; k++) rows.push({ t: "same", a: i + k, b: j + k });
      i += n;
      j += n;
    } else if (op === -1) {
      for (let k = 0; k < n; k++) removed.push(i + k);
      i += n;
    } else {
      for (let k = 0; k < n; k++) added.push(j + k);
      j += n;
    }
  }
  flush();
  findMoves(rows, a, b, bagA, bagB, clock);
  const changes = groupChanges(rows, a, b);
  const counts = { changed: 0, added: 0, removed: 0, moved: 0, total: changes.length, wordsAdded: 0, wordsRemoved: 0 };
  for (const c of changes) {
    counts[c.kind]++;
    counts.wordsAdded += c.added;
    counts.wordsRemoved += c.removed;
  }
  return {
    mode,
    a,
    b,
    rows,
    changes,
    counts,
    chars: { a: a.reduce((n, u) => n + u.length, 0), b: b.reduce((n, u) => n + u.length, 0) },
    approximate: clock.timedOut,
  };
}

// Best effort: a removed unit whose text (or nearly) was added elsewhere
// moved there. Rewrites both rows in place.
function findMoves(rows, a, b, bagA, bagB, clock) {
  const gone = [],
    arrived = [];
  rows.forEach((r, k) => {
    if (r.t === "removed" && a[r.a].length >= MOVE_MIN) gone.push(k);
    if (r.t === "added" && b[r.b].length >= MOVE_MIN) arrived.push(k);
  });
  if (!gone.length || !arrived.length) return;
  const byText = new Map();
  for (const k of arrived) {
    const text = b[rows[k].b];
    if (!byText.has(text)) byText.set(text, []);
    byText.get(text).push(k);
  }
  const taken = new Set(),
    left = [];
  const move = (from, to, parts) => {
    const out = rows[from],
      into = rows[to];
    rows[from] = { t: "moved-out", a: out.a, to };
    rows[to] = { t: "moved-in", a: out.a, b: into.b, from, ...(parts ? { parts } : {}) };
    taken.add(to);
  };
  for (const k of gone) {
    const to = byText.get(a[rows[k].a])?.find((x) => !taken.has(x));
    if (to !== undefined) move(k, to, null);
    else left.push(k);
  }
  const open = arrived.filter((k) => !taken.has(k));
  if (!left.length || !open.length || left.length * open.length > MOVE_CANDIDATES) return;
  for (const k of left) {
    let best = -1,
      bestSim = MOVE_SIMILAR;
    for (const to of open) {
      if (taken.has(to)) continue;
      const s = overlap(bagA(rows[k].a), bagB(rows[to].b));
      if (s >= bestSim) {
        best = to;
        bestSim = s;
      }
    }
    if (best >= 0) move(k, best, wordDiff(a[rows[k].a], b[rows[best].b], clock));
  }
}

const wordsIn = (parts, op) =>
  parts.reduce((n, [o, t]) => n + (o === op ? countWords(t) : 0), 0);
function groupChanges(rows, a, b) {
  const changes = [];
  let open = null;
  const range = (lo, hi) => (lo == null ? null : [lo + 1, hi + 1]);
  const close = () => {
    if (!open) return;
    const kinds = new Set(open.kinds);
    changes.push({
      id: changes.length + 1,
      kind: kinds.size === 1 && !kinds.has("changed") ? [...kinds][0] : "changed",
      start: open.start,
      end: open.end,
      a: range(open.aLo, open.aHi),
      b: range(open.bLo, open.bHi),
      added: open.added,
      removed: open.removed,
    });
    open = null;
  };
  rows.forEach((r, k) => {
    if (r.t === "same" || r.t === "moved-out") return close();
    // Each changed paragraph is a change of its own; a run of added (or
    // removed) paragraphs is one change, like a new section.
    if (open && (r.t === "changed" || open.kinds.at(-1) !== r.t)) close();
    if (r.t === "moved-in") {
      close();
      changes.push({
        id: changes.length + 1,
        kind: "moved",
        start: k,
        end: k,
        a: [r.a + 1, r.a + 1],
        b: [r.b + 1, r.b + 1],
        added: r.parts ? wordsIn(r.parts, 1) : 0,
        removed: r.parts ? wordsIn(r.parts, -1) : 0,
      });
      return;
    }
    open ||= { start: k, kinds: [], added: 0, removed: 0, aLo: null, aHi: null, bLo: null, bHi: null };
    open.end = k;
    open.kinds.push(r.t);
    if (r.a !== undefined) {
      open.aLo ??= r.a;
      open.aHi = r.a;
    }
    if (r.b !== undefined) {
      open.bLo ??= r.b;
      open.bHi = r.b;
    }
    if (r.t === "added") open.added += countWords(b[r.b]);
    if (r.t === "removed") open.removed += countWords(a[r.a]);
    if (r.t === "changed") {
      open.added += wordsIn(r.parts, 1);
      open.removed += wordsIn(r.parts, -1);
    }
  });
  close();
  return changes;
}

// ---- A short label for the change list -------------------------------------

// { del, ins } for a change: the first words it removed and added.
export function changeLabel(result, change, max = 60) {
  const { rows, a, b } = result;
  const cut = (s) => {
    const t = String(s || "").replace(/\s+/g, " ").trim();
    return t.length > max ? t.slice(0, max).replace(/\s+\S*$/, "") + "…" : t;
  };
  for (let k = change.start; k <= change.end; k++) {
    const r = rows[k];
    if (r.t === "moved-in") return { text: cut(b[r.b]) };
    if (r.t === "added") return { ins: cut(b[r.b]) };
    if (r.t === "removed") return { del: cut(a[r.a]) };
    if (r.t === "changed")
      return {
        del: cut(r.parts.find(([op]) => op === -1)?.[1]),
        ins: cut(r.parts.find(([op]) => op === 1)?.[1]),
      };
  }
  return { text: "" };
}

// ---- What a summary may send ---------------------------------------------

// Every change as a passage: its changed units (edits marked [-removed-] and
// {+added+}) with at most `context` unchanged units on each side, cut to
// `contextChars`. Inside an edited unit only `window` words either side of an
// edit are kept, and its first `lead` words (a clause's heading); the rest is
// "…". Nothing else of either document is ever in a passage: no unchanged
// unit beyond the context, no unchanged words beyond the window.
export const HUNK_DEFAULTS = {
  context: 2,
  contextChars: 160,
  window: 8,
  lead: 3,
  lineChars: 2400,
  lines: 40,
  movedWords: 20,
};
export function buildHunks(result, options = {}) {
  const o = { ...HUNK_DEFAULTS, ...options };
  const { rows, changes, a, b } = result;
  let used = -1;
  return changes.map((c) => {
    const before = [];
    for (let k = c.start - 1; k > used && before.length < o.context; k--) {
      if (rows[k].t !== "same") break;
      before.unshift(b[rows[k].b]);
    }
    const after = [];
    let k = c.end + 1;
    for (; k < rows.length && after.length < o.context; k++) {
      if (rows[k].t !== "same") break;
      after.push(b[rows[k].b]);
    }
    used = c.end + after.length;
    const lines = [];
    for (let r = c.start; r <= c.end; r++) {
      const row = rows[r];
      if (row.t === "changed")
        lines.push({ tag: "edit", text: clip(windowed(row.parts, o.window, o.lead), o.lineChars) });
      else if (row.t === "added") lines.push({ tag: "added", text: clip(b[row.b], o.lineChars) });
      else if (row.t === "removed") lines.push({ tag: "removed", text: clip(a[row.a], o.lineChars) });
      else if (row.t === "moved-in")
        lines.push({
          tag: "moved",
          from: row.a + 1,
          text: clip(row.parts ? windowed(row.parts, o.window, o.lead) : headWords(b[row.b], o.movedWords), o.lineChars),
        });
    }
    return {
      kind: c.kind,
      a: c.kind === "added" ? null : c.a,
      b: c.kind === "removed" ? null : c.b,
      before: tailChars(before.join(" "), o.contextChars),
      lines: lines.slice(0, o.lines),
      ...(lines.length > o.lines ? { more: lines.length - o.lines } : {}),
      after: headChars(after.join(" "), o.contextChars),
    };
  });
}
const ELLIPSIS = "…";
function clip(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + " " + ELLIPSIS + "[trimmed]";
}
function tailChars(text, max) {
  if (text.length <= max) return text;
  const t = text.slice(-max);
  return ELLIPSIS + t.replace(/^\S*\s+/, "");
}
function headChars(text, max) {
  if (text.length <= max) return text;
  return text.slice(0, max).replace(/\s+\S*$/, "") + ELLIPSIS;
}
function headWords(text, n) {
  const toks = tokenize(text);
  let words = 0,
    k = 0;
  for (; k < toks.length; k++) if (WORDISH.test(toks[k]) && ++words > n) break;
  return k < toks.length ? toks.slice(0, k).join("").trimEnd() + ELLIPSIS : text;
}
// Keeps `head` words at the start and `tail` at the end of an unchanged
// stretch, with "…" between; the spaces next to an edit stay.
function keepEdges(text, head, tail) {
  const toks = tokenize(text);
  const wordAt = [];
  toks.forEach((t, k) => WORDISH.test(t) && wordAt.push(k));
  if (wordAt.length <= head + tail) return text;
  const lead = head ? toks.slice(0, wordAt[head - 1] + 1).join("") : "";
  const end = tail ? toks.slice(wordAt[wordAt.length - tail]).join("") : "";
  const leadSpace = head ? "" : /^\s/.test(text) ? " " : "";
  const endSpace = tail ? "" : /\s$/.test(text) ? " " : "";
  return (
    leadSpace +
    (head ? lead + " " : "") +
    ELLIPSIS +
    (tail ? " " + end.replace(/^\s+/, "") : "") +
    endSpace
  );
}
// A changed unit's parts as one line, edits marked, unchanged stretches cut
// to `w` words beside each edit (and the unit's first `lead` words).
export function windowed(parts, w, lead = 0) {
  return parts
    .map(([op, text], k) => {
      if (op === -1) return `[-${text}-]`;
      if (op === 1) return `{+${text}+}`;
      const first = k === 0,
        last = k === parts.length - 1;
      return keepEdges(text, first ? lead : w, last ? 0 : w);
    })
    .join("");
}

// ---- Exports --------------------------------------------------------------

const escapeHTML = (s) =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
const KIND_LABELS = { changed: "Changed", added: "Added", removed: "Removed", moved: "Moved" };
// Counts as one line: "12 changes · 6 changed · 3 added · 2 removed · 1 moved".
// `label` translates each word on its own.
export function countsLine(counts, label = (s) => s) {
  const count = (n, word) => `${n.toLocaleString("en-US")} ${label(word)}`;
  const parts = [count(counts.total, counts.total === 1 ? "change" : "changes")];
  for (const kind of ["changed", "added", "removed", "moved"])
    if (counts[kind]) parts.push(count(counts[kind], kind));
  return parts.join(" · ");
}
const unitLabel = (range) =>
  !range ? "" : range[0] === range[1] ? `¶ ${range[0]}` : `¶ ${range[0]}–${range[1]}`;
export const whereLabel = (change) =>
  change.kind === "moved"
    ? `${unitLabel(change.a)} → ${unitLabel(change.b)}`
    : unitLabel(change.kind === "removed" ? change.a : change.b || change.a);

// The whole redline as a standalone HTML page (no scripts, nothing
// external), to keep or print to PDF. Every piece of document text is
// escaped. `label` translates the page's own words.
export function redlineHTML({ result, original, revised, date = new Date(), label = (s) => s }) {
  const { rows, a, b, changes, counts } = result;
  const starts = new Map(changes.map((c) => [c.start, c]));
  const parts = (ps) =>
    ps
      .map(([op, t]) =>
        op === -1 ? `<del>${escapeHTML(t)}</del>` : op === 1 ? `<ins>${escapeHTML(t)}</ins>` : escapeHTML(t),
      )
      .join("");
  const body = rows
    .map((r, k) => {
      const c = starts.get(k);
      const tag = c ? `<span class="n">${escapeHTML(`${c.id}`)}</span>` : "";
      if (r.t === "same") return `<p>${escapeHTML(b[r.b])}</p>`;
      if (r.t === "changed") return `<p class="chg">${tag}${parts(r.parts)}</p>`;
      if (r.t === "added") return `<p class="chg">${tag}<ins>${escapeHTML(b[r.b])}</ins></p>`;
      if (r.t === "removed") return `<p class="chg">${tag}<del>${escapeHTML(a[r.a])}</del></p>`;
      if (r.t === "moved-out")
        return `<p class="mv"><span class="m">${escapeHTML(label(`Moved to ¶ ${rows[r.to].b + 1}`))}</span><s>${escapeHTML(a[r.a])}</s></p>`;
      return `<p class="mv">${tag}<span class="m">${escapeHTML(label(`Moved from ¶ ${r.a + 1}`))}</span>${r.parts ? parts(r.parts) : escapeHTML(b[r.b])}</p>`;
    })
    .join("\n");
  const when = date.toISOString().slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHTML(label("Redline"))}: ${escapeHTML(original)} → ${escapeHTML(revised)}</title>
<style>
body{font:15px/1.65 Georgia,"Times New Roman",serif;color:#142343;max-width:780px;margin:40px auto;padding:0 24px}
header{border-top:4px solid #0135df;padding-top:14px;margin-bottom:26px;font-family:system-ui,sans-serif}
h1{font-size:22px;margin:0 0 6px}
header p{margin:2px 0;font-size:13px;color:#68748a}
p{margin:0 0 12px}
ins{color:#0135df;background:#edf2ff;text-decoration:underline}
del{color:#9c5543;background:#fff3ee;text-decoration:line-through}
.chg{border-left:3px solid #0135df;padding-left:10px}
.mv{border-left:3px solid #ffb21c;padding-left:10px}
.mv s{color:#8a5a00}
.n,.m{font:600 11px system-ui,sans-serif;margin-right:8px;padding:1px 6px;border:1px solid #c8d5fb;background:#edf2ff;color:#0135df}
.m{border-color:#ffd98a;background:#fff7e6;color:#8a5a00}
footer{margin-top:30px;font:12px system-ui,sans-serif;color:#68748a}
@media print{body{margin:0;max-width:none}header{break-after:avoid}}
</style>
</head>
<body>
<header>
<h1>${escapeHTML(label("Redline"))}</h1>
<p>${escapeHTML(label("Original"))}: ${escapeHTML(original)}</p>
<p>${escapeHTML(label("Revised"))}: ${escapeHTML(revised)}</p>
<p>${escapeHTML(countsLine(counts, label))} · ${escapeHTML(when)}</p>
</header>
<main>
${body}
</main>
<footer>${escapeHTML(label("Compared in the browser with ANONYMA. To make a PDF, print this page and choose Save as PDF."))}</footer>
</body>
</html>
`;
}

// Markdown text with its own markup characters escaped.
const escapeMD = (s) => String(s ?? "").replace(/([\\`*_~[\]<>#|])/g, "\\$1");
const mdParts = (ps) =>
  ps
    .map(([op, t]) => {
      const text = escapeMD(t);
      if (op === 0) return text;
      const inner = text.trim();
      if (!inner) return text;
      const lead = text.match(/^\s*/)[0],
        trail = text.match(/\s*$/)[0];
      return lead + (op === -1 ? `~~${inner}~~` : `**${inner}**`) + trail;
    })
    .join("");
// The change list as Markdown: each change with where it is and its text,
// removed text struck through and added text in bold. `summary`, when
// given, is the AI summary to include: { text, model }.
export function changesMarkdown({ result, original, revised, date = new Date(), summary = null, label = (s) => s }) {
  const { rows, a, b, changes, counts } = result;
  const out = [
    `# ${label("Changes")}: ${escapeMD(original)} → ${escapeMD(revised)}`,
    "",
    `${countsLine(counts, label)} · ${label(`${counts.wordsAdded.toLocaleString("en-US")} words added`)} · ${label(`${counts.wordsRemoved.toLocaleString("en-US")} words removed`)} · ${date.toISOString().slice(0, 10)}`,
    "",
    `_${label("~~Struck through~~ was removed and **bold** was added. ¶ numbers count paragraphs in each version.")}_`,
    "",
  ];
  for (const c of changes) {
    out.push(`## ${c.id}. ${label(KIND_LABELS[c.kind])} · ${whereLabel(c)}`, "");
    for (let k = c.start; k <= c.end; k++) {
      const r = rows[k];
      if (r.t === "changed") out.push(mdParts(r.parts), "");
      else if (r.t === "added") out.push(`**${escapeMD(b[r.b])}**`, "");
      else if (r.t === "removed") out.push(`~~${escapeMD(a[r.a])}~~`, "");
      else if (r.t === "moved-in")
        out.push(`${label(`Moved from ¶ ${r.a + 1}`)}: ${r.parts ? mdParts(r.parts) : escapeMD(b[r.b])}`, "");
    }
  }
  if (!changes.length) out.push(label("No differences found."), "");
  if (summary?.text) {
    out.push(
      `## ${label("AI summary")}`,
      "",
      `_${label(`Written by ${summary.model} from the changed passages only. Not legal advice.`)}_`,
      "",
      summary.text.trim(),
      "",
    );
  }
  return out.join("\n");
}

// A file-name-safe stem from a document's name.
export function fileStem(name) {
  return (
    String(name || "document")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "document"
  );
}
