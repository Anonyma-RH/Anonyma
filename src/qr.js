// A small, self-contained QR Code encoder (ISO/IEC 18004, model 2): byte
// mode only, any version from 1 to 40, all four error correction levels and
// the standard mask choice. Two-step sign-in draws its otpauth:// setup link
// with it in the browser, so the secret is never sent to a QR service and no
// package is needed. The structure follows the public-domain reference
// design by Project Nayuki; tests/two-step.test.mjs checks it module by
// module against an independent encoder.

// Error correction level: its two format bits and its row in the tables.
export const ECL = {
  L: { index: 0, bits: 1 },
  M: { index: 1, bits: 0 },
  Q: { index: 2, bits: 3 },
  H: { index: 3, bits: 2 },
};
// Per level (L, M, Q, H), per version (index 0 unused): error correction
// codewords in each block, and the number of blocks.
// prettier-ignore
const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];
// prettier-ignore
const BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const bit = (x, i) => ((x >>> i) & 1) !== 0;

// Modules left for data and error correction once the function patterns
// are drawn.
function rawDataModules(ver) {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (ver, ecl) =>
  Math.floor(rawDataModules(ver) / 8) -
  ECC_PER_BLOCK[ecl.index][ver] * BLOCKS[ecl.index][ver];

// GF(2^8) with the QR polynomial x^8 + x^4 + x^3 + x^2 + 1.
function gfMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data, divisor) {
  const result = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= gfMultiply(coef, factor)));
  }
  return result;
}

// The data codewords split into blocks, each with its error correction,
// then interleaved.
function addEcc(data, ver, ecl) {
  const blocks = BLOCKS[ecl.index][ver];
  const eccLen = ECC_PER_BLOCK[ecl.index][ver];
  const raw = Math.floor(rawDataModules(ver) / 8);
  const shortBlocks = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const divisor = rsDivisor(eccLen);
  const all = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(
      k,
      k + shortLen - eccLen + (i < shortBlocks ? 0 : 1),
    );
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    if (i < shortBlocks) dat.push(0);
    all.push(dat.concat(ecc));
  }
  const out = [];
  for (let i = 0; i < all[0].length; i++)
    for (let j = 0; j < all.length; j++)
      if (i !== shortLen - eccLen || j >= shortBlocks) out.push(all[j][i]);
  return out;
}

function alignmentPositions(ver, size) {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < count; pos -= step)
    result.splice(1, 0, pos);
  return result;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

// Encodes text (as UTF-8 bytes) in the smallest version that fits at the
// given level. Returns { version, size, mask, modules }, where modules[y][x]
// is true for a dark module. Throws when the text is too long for version 40.
export function encodeQR(
  text,
  { ecl = "M", mask: forcedMask, minVersion = 1 } = {},
) {
  const level = ECL[ecl];
  if (!level) throw Error("Unknown error correction level.");
  const bytes = [...new TextEncoder().encode(String(text))];
  let ver = Math.max(1, Math.min(40, minVersion)),
    capacity;
  for (; ; ver++) {
    if (ver > 40) throw Error("Text is too long for a QR code.");
    capacity = dataCodewords(ver, level) * 8;
    const countBits = ver <= 9 ? 8 : 16;
    if (
      bytes.length < 2 ** countBits &&
      4 + countBits + bytes.length * 8 <= capacity
    )
      break;
  }
  // Byte mode (0100), the character count, then the bytes.
  const bits = [];
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0x4, 4);
  push(bytes.length, ver <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacity - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data = [];
  for (let i = 0; i < bits.length; i += 8)
    data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

  const size = ver * 4 + 17;
  const modules = Array.from({ length: size }, () =>
    new Array(size).fill(false),
  );
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };
  // Timing patterns, finders (with their separators), alignment patterns.
  for (let i = 0; i < size; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  for (const [cx, cy] of [
    [3, 3],
    [size - 4, 3],
    [3, size - 4],
  ])
    for (let dy = -4; dy <= 4; dy++)
      for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy)),
          x = cx + dx,
          y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size)
          set(x, y, d !== 2 && d !== 4);
      }
  const align = alignmentPositions(ver, size);
  for (let i = 0; i < align.length; i++)
    for (let j = 0; j < align.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0);
      if (corner) continue;
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++)
          set(
            align[i] + dx,
            align[j] + dy,
            Math.max(Math.abs(dx), Math.abs(dy)) !== 1,
          );
    }
  const drawFormat = (m) => {
    const value = (level.bits << 3) | m;
    let rem = value;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const f = ((value << 10) | rem) ^ 0x5412;
    for (let i = 0; i <= 5; i++) set(8, i, bit(f, i));
    set(8, 7, bit(f, 6));
    set(8, 8, bit(f, 7));
    set(7, 8, bit(f, 8));
    for (let i = 9; i < 15; i++) set(14 - i, 8, bit(f, i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(f, i));
    for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(f, i));
    set(8, size - 8, true);
  };
  drawFormat(0);
  if (ver >= 7) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const v = (ver << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const a = size - 11 + (i % 3),
        b = Math.floor(i / 3);
      set(a, b, bit(v, i));
      set(b, a, bit(v, i));
    }
  }
  // Codewords in the zigzag order, skipping the function patterns.
  const codewords = addEcc(data, ver, level);
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++)
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!fixed[y][x] && i < codewords.length * 8) {
          modules[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
          i++;
        }
      }
  }
  const applyMask = (m) => {
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++)
        if (!fixed[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x];
  };
  let mask = forcedMask;
  if (mask === undefined) {
    let best = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m);
      drawFormat(m);
      const score = penalty(modules, size);
      if (score < best) {
        best = score;
        mask = m;
      }
      applyMask(m);
    }
  }
  if (!Number.isInteger(mask) || mask < 0 || mask > 7)
    throw Error("Mask must be 0 to 7.");
  applyMask(mask);
  drawFormat(mask);
  return { version: ver, size, mask, modules };
}

// The standard penalty score: runs, 2×2 blocks, finder-like patterns and
// the dark/light balance. Lower is better.
function penalty(modules, size) {
  let result = 0;
  const addHistory = (run, history) => {
    if (history[0] === 0) run += size;
    history.pop();
    history.unshift(run);
  };
  const countPatterns = (h) => {
    const n = h[1];
    const core =
      n > 0 && h[2] === n && h[3] === n * 3 && h[4] === n && h[5] === n;
    return (
      (core && h[0] >= n * 4 && h[6] >= n ? 1 : 0) +
      (core && h[6] >= n * 4 && h[0] >= n ? 1 : 0)
    );
  };
  const terminate = (color, run, history) => {
    if (color) {
      addHistory(run, history);
      run = 0;
    }
    addHistory(run + size, history);
    return countPatterns(history);
  };
  for (let pass = 0; pass < 2; pass++)
    for (let a = 0; a < size; a++) {
      let color = false,
        run = 0;
      const history = [0, 0, 0, 0, 0, 0, 0];
      for (let b = 0; b < size; b++) {
        const m = pass === 0 ? modules[a][b] : modules[b][a];
        if (m === color) {
          run++;
          if (run === 5) result += 3;
          else if (run > 5) result++;
        } else {
          addHistory(run, history);
          if (!color) result += countPatterns(history) * 40;
          color = m;
          run = 1;
        }
      }
      result += terminate(color, run, history) * 40;
    }
  for (let y = 0; y < size - 1; y++)
    for (let x = 0; x < size - 1; x++) {
      const c = modules[y][x];
      if (
        c === modules[y][x + 1] &&
        c === modules[y + 1][x] &&
        c === modules[y + 1][x + 1]
      )
        result += 3;
    }
  let dark = 0;
  for (const row of modules) for (const m of row) if (m) dark++;
  const total = size * size;
  result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
  return result;
}

// One SVG path for the dark modules, offset by a quiet zone (4 modules, as
// the standard asks). Draw it dark on a light background.
export function qrPath({ size, modules }, border = 4) {
  let d = "";
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (modules[y][x]) d += `M${x + border} ${y + border}h1v1h-1z`;
  return { d, viewBox: `0 0 ${size + border * 2} ${size + border * 2}` };
}
