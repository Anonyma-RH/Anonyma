// Meeting Notes: reading a recording in this browser. The file never leaves
// it. Its sound is decoded here a few minutes at a time, and each piece is
// re-encoded as plain 16 kHz mono PCM (src/meeting-notes.js plans where the
// pieces are cut), so tags, cover art, recording dates, the file name and
// any video stay on this device.
//
// MP3, WAV and M4A / MP4 / MOV with AAC sound are read piece by piece from
// the file (a video's picture is never read), so a three-hour recording
// never has to fit in memory. Anything else the browser can decode (OGG,
// WebM, FLAC...) is decoded whole, up to an hour.
//
// The parsers work on bytes and run in Node too (tests); decoding needs the
// browser's Web Audio (decodeAudioData on a 16 kHz OfflineAudioContext,
// which also resamples).
import { CHUNK_RATE, MAX_FILE_BYTES, MAX_SECONDS, MAX_VIDEO_BYTES, MIN_SECONDS } from "./meeting-notes.js";

// Formats decoded whole: at most an hour, and when the browser can't say
// how long the file is, at most 60 MB.
export const WHOLE_MAX_SECONDS = 3600;
export const WHOLE_MAX_BYTES = 60 * 1024 * 1024;
export const RECORDING_ACCEPT =
  "audio/*,video/mp4,video/quicktime,video/webm,.mp3,.m4a,.wav,.webm,.ogg,.oga,.opus,.flac,.aac,.mp4,.mov,.m4v";

export class RecordingError extends Error {}
const bad = (message) => {
  throw new RecordingError(message);
};
export const MESSAGES = {
  unknown: "This file isn't a recording this page can read. Use MP3, M4A, WAV, WebM or OGG, or an MP4 or MOV video.",
  damaged: "This recording looks damaged, so it can't be read.",
  big: "This file is larger than 200 MB. Export the sound at a lower bitrate, or split it.",
  bigVideo: "This video is larger than 2 GB. Export its sound as M4A or MP3 first.",
  long: "This recording is longer than 3 hours. Split it, then make notes from each part.",
  short: "This recording is too short to transcribe.",
  silent: "This video has no sound track.",
  decode: "This browser couldn't decode the recording. Try MP3, M4A or WAV.",
  wholeLong: "OGG, WebM, FLAC and similar recordings up to an hour can be read here. Convert a longer one to M4A, MP3 or WAV.",
  noAudio: "This browser can't decode audio.",
};

// ---- Bytes ----

const u8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));
const ascii = (b, p, n) => {
  let s = "";
  for (let i = p; i < p + n && i < b.length; i++) s += String.fromCharCode(b[i]);
  return s;
};
const le16 = (b, p) => b[p] | (b[p + 1] << 8);
const le32 = (b, p) => (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
const be16 = (b, p) => (b[p] << 8) | b[p + 1];
const be32 = (b, p) => ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
const be64 = (b, p) => be32(b, p) * 2 ** 32 + be32(b, p + 4);

// What a file is, from its first bytes.
export function sniff(head) {
  const b = u8(head);
  if (b.length < 12) return null;
  if (ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 4) === "WAVE") return "wav";
  if (["ftyp", "moov", "mdat", "free", "wide", "skip"].includes(ascii(b, 4, 4))) return "mp4";
  if (ascii(b, 0, 3) === "ID3") return "mp3";
  if (ascii(b, 0, 4) === "OggS") return "ogg";
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (ascii(b, 0, 4) === "fLaC") return "flac";
  if (b[0] === 0xff && (b[1] & 0xf6) === 0xf0) return "aac";
  if (b[0] === 0xff && (b[1] & 0xe0) === 0xe0) return "mp3";
  return null;
}

// ---- WAV ----

// A WAV's format and where its samples are, from its first bytes (`size` is
// the whole file's). PCM (8, 16, 24 or 32-bit) or float (32 or 64-bit),
// plain or WAVE_FORMAT_EXTENSIBLE.
export function wavLayout(head, size) {
  const b = u8(head);
  if (ascii(b, 0, 4) !== "RIFF" || ascii(b, 8, 4) !== "WAVE") bad(MESSAGES.damaged);
  let p = 12,
    fmt = null;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4),
      len = le32(b, p + 4),
      body = p + 8;
    if (id === "fmt ") {
      if (len < 16 || body + 16 > b.length) bad(MESSAGES.damaged);
      fmt = {
        tag: le16(b, body),
        channels: le16(b, body + 2),
        rate: le32(b, body + 4),
        blockAlign: le16(b, body + 12),
        bits: le16(b, body + 14),
      };
      if (fmt.tag === 0xfffe && len >= 40 && body + 26 <= b.length) fmt.tag = le16(b, body + 24);
    } else if (id === "data") {
      if (!fmt) bad(MESSAGES.damaged);
      const pcm = fmt.tag === 1 && [8, 16, 24, 32].includes(fmt.bits);
      const float = fmt.tag === 3 && [32, 64].includes(fmt.bits);
      if (
        (!pcm && !float) ||
        fmt.channels < 1 ||
        fmt.channels > 8 ||
        fmt.rate < 1000 ||
        fmt.rate > 384000 ||
        fmt.blockAlign !== (fmt.channels * fmt.bits) / 8
      )
        bad(MESSAGES.decode);
      let bytes = len;
      if (!bytes || bytes === 0xffffffff || body + bytes > size) bytes = size - body;
      bytes -= bytes % fmt.blockAlign;
      return { ...fmt, float, dataOffset: body, dataBytes: bytes, duration: bytes / fmt.blockAlign / fmt.rate };
    }
    p = body + len + (len & 1);
  }
  bad(MESSAGES.damaged);
}
// A WAV holding `data` (whole sample frames in `layout`'s format).
export function wavWith(layout, data) {
  const b = new Uint8Array(44 + data.length);
  const v = new DataView(b.buffer);
  b.set([82, 73, 70, 70], 0);
  v.setUint32(4, 36 + data.length, true);
  b.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, layout.float ? 3 : 1, true);
  v.setUint16(22, layout.channels, true);
  v.setUint32(24, layout.rate, true);
  v.setUint32(28, layout.rate * layout.blockAlign, true);
  v.setUint16(32, layout.blockAlign, true);
  v.setUint16(34, layout.bits, true);
  b.set([100, 97, 116, 97], 36);
  v.setUint32(40, data.length, true);
  b.set(data, 44);
  return b;
}
// Mono 16-bit PCM at `rate`: what every piece is sent as.
export function encodeWav16(samples, rate = CHUNK_RATE) {
  const b = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(b.buffer);
  b.set([82, 73, 70, 70], 0);
  v.setUint32(4, 36 + samples.length * 2, true);
  b.set([87, 65, 86, 69, 102, 109, 116, 32], 8);
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  b.set([100, 97, 116, 97], 36);
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] || 0));
    v.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return b;
}

// ---- MP3 ----

const V1L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const V1L2 = [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384];
const V2L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
// An MPEG audio Layer II or III frame header at `i`, or null.
export function mp3Frame(b, i) {
  if (i + 4 > b.length || b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) return null;
  const version = (b[i + 1] >> 3) & 3; // 0: MPEG 2.5, 2: MPEG 2, 3: MPEG 1
  const layer = (b[i + 1] >> 1) & 3; // 1: III, 2: II
  if (version === 1 || (layer !== 1 && layer !== 2)) return null;
  const bi = b[i + 2] >> 4,
    ri = (b[i + 2] >> 2) & 3,
    pad = (b[i + 2] >> 1) & 1;
  if (bi === 0 || bi === 15 || ri === 3) return null;
  const v1 = version === 3;
  const rate = [44100, 48000, 32000][ri] / (v1 ? 1 : version === 2 ? 2 : 4);
  const kbps = (layer === 1 ? (v1 ? V1L3 : V2L3) : v1 ? V1L2 : V2L3)[bi];
  const samples = layer === 1 && !v1 ? 576 : 1152;
  const mono = b[i + 3] >> 6 === 3;
  return {
    length: Math.floor(((samples / 8) * kbps * 1000) / rate) + pad,
    samples,
    rate,
    mono,
    side: layer === 1 ? (v1 ? (mono ? 17 : 32) : mono ? 9 : 17) : 0,
    layer,
  };
}
// Every frame's offset in an MP3 (read through `read(start, end)`), found
// frame by frame from the first one that's followed by another. The Xing,
// Info or VBRI frame some encoders put first is left out: it holds no sound.
export async function mp3Index(read, size) {
  const BLOCK = 4 << 20,
    MARGIN = 8192;
  let base = 0,
    block = u8(await read(0, Math.min(size, BLOCK)));
  const load = async (p) => {
    base = p;
    block = u8(await read(p, Math.min(size, p + BLOCK)));
  };
  let pos = 0;
  if (ascii(block, 0, 3) === "ID3" && block.length >= 10) {
    const tag = ((block[6] & 0x7f) << 21) | ((block[7] & 0x7f) << 14) | ((block[8] & 0x7f) << 7) | (block[9] & 0x7f);
    pos = 10 + tag + (block[5] & 0x10 ? 10 : 0);
  }
  const offsets = [];
  let first = null,
    lost = 0;
  while (pos + 4 <= size) {
    // Keep a frame's worth ahead of `pos` in the block (the last block runs
    // to the end of the file).
    if (pos < base || (pos + MARGIN > base + block.length && base + block.length < size)) await load(pos);
    if (pos + 4 > base + block.length) break;
    const i = pos - base;
    const h = mp3Frame(block, i);
    const fits =
      h &&
      (first
        ? h.rate === first.rate && h.layer === first.layer
        : i + h.length + 4 > block.length || !!mp3Frame(block, i + h.length));
    if (!fits) {
      // Not a frame: look for the next one (sync is lost at most 64 KB).
      if (first && ++lost > 65536) break;
      if (!first && pos > 1 << 20) break;
      pos++;
      continue;
    }
    lost = 0;
    const info =
      !first &&
      h.layer === 1 &&
      (["Xing", "Info"].includes(ascii(block, i + 4 + h.side, 4)) || ascii(block, i + 36, 4) === "VBRI");
    if (!first) first = h;
    if (!info) offsets.push(pos);
    pos += h.length;
  }
  if (!first || !offsets.length) bad(MESSAGES.decode);
  return {
    offsets,
    end: Math.min(size, pos),
    samples: first.samples,
    rate: first.rate,
    channels: first.mono ? 1 : 2,
    duration: (offsets.length * first.samples) / first.rate,
  };
}

// ---- MP4 / M4A / MOV ----

// The boxes directly inside b[start, end): [{ type, start (its body), end }].
function boxes(b, start, end) {
  const out = [];
  let p = start;
  while (p + 8 <= end) {
    let len = be32(b, p),
      hdr = 8;
    const type = ascii(b, p + 4, 4);
    if (len === 1) {
      if (p + 16 > end) break;
      len = be64(b, p + 8);
      hdr = 16;
    } else if (len === 0) len = end - p;
    if (len < hdr || p + len > end) break;
    out.push({ type, start: p + hdr, end: p + len });
    p += len;
  }
  return out;
}
const child = (b, box, type) => box && boxes(b, box.start, box.end).find((x) => x.type === type);
const path = (b, box, ...types) => types.reduce((x, t) => child(b, x, t), box);
// The first box of `type` anywhere inside b[start, end) (for esds, which
// QuickTime nests in a 'wave' box).
function findBox(b, start, end, type, depth = 0) {
  for (const x of boxes(b, start, end)) {
    if (x.type === type) return x;
    if (depth < 4 && x.end - x.start >= 8) {
      const inner = findBox(b, x.start, x.end, type, depth + 1);
      if (inner) return inner;
    }
  }
  return null;
}
const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
// An AudioSpecificConfig: the object type, rate index and channels ADTS
// needs (for HE-AAC, its AAC core's, which decoders extend implicitly).
export function parseAsc(bytes) {
  const b = u8(bytes);
  let bit = 0;
  const take = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v = (v << 1) | ((b[bit >> 3] >> (7 - (bit & 7))) & 1);
    return v;
  };
  if (b.length < 2) return null;
  let aot = take(5);
  if (aot === 31) aot = 32 + take(6);
  const sfi = take(4);
  const rate = sfi === 15 ? take(24) : RATES[sfi];
  const channels = take(4);
  let sbr = false;
  if (aot === 5 || aot === 29) {
    sbr = true;
    const esfi = take(4);
    if (esfi === 15) take(24);
    aot = take(5);
    if (aot === 31) aot = 32 + take(6);
  }
  return { aot, sfi, rate, channels, sbr };
}
// Reads an esds box's DecoderConfigDescriptor: the object type and the
// AudioSpecificConfig.
function esdsConfig(b, box) {
  let p = box.start + 4;
  const end = box.end;
  const desc = () => {
    const tag = b[p++];
    let len = 0;
    for (let i = 0; i < 4; i++) {
      const c = b[p++];
      len = (len << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { tag, len, body: p };
  };
  let d = desc();
  if (d.tag === 3) {
    p += 2;
    const flags = b[p++];
    if (flags & 0x80) p += 2;
    if (flags & 0x40) p += 1 + b[p];
    if (flags & 0x20) p += 2;
    d = desc();
  }
  if (d.tag !== 4 || p + 13 > end) return null;
  const objectType = b[p];
  p += 13;
  const s = desc();
  if (s.tag !== 5 || s.body + s.len > end) return { objectType, asc: null };
  return { objectType, asc: b.slice(s.body, s.body + s.len) };
}
// The first sound track of an MP4, M4A or MOV: where each AAC frame is and
// when it plays. { unsupported } for a sound track that isn't plain AAC, or
// a fragmented file (they're decoded whole instead).
export async function mp4Audio(read, size) {
  let p = 0,
    moov = null;
  while (p + 8 <= size) {
    const h = u8(await read(p, Math.min(size, p + 16)));
    let len = be32(h, 0),
      hdr = 8;
    const type = ascii(h, 4, 4);
    if (len === 1) {
      len = be64(h, 8);
      hdr = 16;
    } else if (len === 0) len = size - p;
    if (len < hdr || !/^[\x20-\x7e]{4}$/.test(type)) bad(MESSAGES.damaged);
    if (type === "moov") {
      if (len > 128 << 20) bad(MESSAGES.damaged);
      moov = u8(await read(p + hdr, p + len));
    } else if (type === "moof") return { unsupported: "fragmented" };
    p += len;
  }
  if (!moov) bad(MESSAGES.damaged);
  if (child(moov, { start: 0, end: moov.length }, "mvex")) return { unsupported: "fragmented" };
  const tracks = boxes(moov, 0, moov.length).filter((x) => x.type === "trak");
  let hadVideo = false;
  for (const trak of tracks) {
    const mdia = child(moov, trak, "mdia");
    const hdlr = child(moov, mdia, "hdlr");
    const handler = hdlr ? ascii(moov, hdlr.start + 8, 4) : "";
    if (handler === "vide") hadVideo = true;
    if (handler !== "soun") continue;
    const mdhd = child(moov, mdia, "mdhd");
    const stbl = path(moov, mdia, "minf", "stbl");
    if (!mdhd || !stbl) bad(MESSAGES.damaged);
    const timescale = moov[mdhd.start] === 1 ? be32(moov, mdhd.start + 20) : be32(moov, mdhd.start + 12);
    const stsd = child(moov, stbl, "stsd");
    if (!stsd || !timescale) bad(MESSAGES.damaged);
    const entry = boxes(moov, stsd.start + 8, stsd.end)[0];
    if (!entry) bad(MESSAGES.damaged);
    if (entry.type !== "mp4a") return { unsupported: entry.type, video: hadVideo };
    const version = be16(moov, entry.start + 8);
    const inner = entry.start + 28 + (version === 1 ? 16 : version === 2 ? 36 : 0);
    const esds = findBox(moov, inner, entry.end, "esds");
    const config = esds && esdsConfig(moov, esds);
    if (!config?.asc || ![0x40, 0x66, 0x67, 0x68].includes(config.objectType)) return { unsupported: "codec", video: hadVideo };
    const asc = parseAsc(config.asc);
    if (!asc || asc.aot < 1 || asc.aot > 4 || asc.sfi > 12 || asc.channels < 1 || asc.channels > 7)
      return { unsupported: "codec", video: hadVideo };
    // Sample sizes, chunk offsets, samples per chunk and durations.
    const stsz = child(moov, stbl, "stsz"),
      stco = child(moov, stbl, "stco") || child(moov, stbl, "co64"),
      stsc = child(moov, stbl, "stsc"),
      stts = child(moov, stbl, "stts");
    if (!stsz || !stco || !stsc || !stts) bad(MESSAGES.damaged);
    const fixed = be32(moov, stsz.start + 4),
      count = be32(moov, stsz.start + 8);
    if (!count || (!fixed && stsz.start + 12 + count * 4 > stsz.end)) bad(MESSAGES.damaged);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || be32(moov, stsz.start + 12 + i * 4);
    const wide = stco.type === "co64";
    const chunks = be32(moov, stco.start + 4);
    const chunkOffset = (c) => (wide ? be64(moov, stco.start + 8 + c * 8) : be32(moov, stco.start + 8 + c * 4));
    const runs = be32(moov, stsc.start + 4);
    const offsets = new Float64Array(count);
    let s = 0;
    for (let r = 0; r < runs && s < count; r++) {
      const at = stsc.start + 8 + r * 12;
      const firstChunk = be32(moov, at) - 1,
        perChunk = be32(moov, at + 4);
      const lastChunk = r + 1 < runs ? be32(moov, at + 12) - 1 : chunks;
      for (let c = firstChunk; c < lastChunk && s < count; c++) {
        let off = chunkOffset(c);
        for (let k = 0; k < perChunk && s < count; k++) {
          offsets[s] = off;
          off += sizes[s++];
        }
      }
    }
    if (s < count) bad(MESSAGES.damaged);
    const times = new Float64Array(count + 1);
    let t = 0,
      n = 0;
    const entries = be32(moov, stts.start + 4);
    for (let e = 0; e < entries && n < count; e++) {
      const k = be32(moov, stts.start + 8 + e * 8),
        delta = be32(moov, stts.start + 12 + e * 8);
      for (let j = 0; j < k && n < count; j++) {
        times[n++] = t / timescale;
        t += delta;
      }
    }
    while (n < count) times[n++] = t / timescale;
    times[count] = t / timescale;
    for (let i = 0; i < count; i++) if (offsets[i] + sizes[i] > size) bad(MESSAGES.damaged);
    return { asc, count, sizes, offsets, times, duration: times[count], channels: asc.channels, rate: asc.rate, video: hadVideo };
  }
  if (hadVideo) bad(MESSAGES.silent);
  bad(MESSAGES.damaged);
}
// AAC frames with ADTS headers: a stream any browser's decoder reads.
export function adtsStream(asc, frames) {
  let total = 0;
  for (const f of frames) total += f.length + 7;
  const out = new Uint8Array(total);
  let o = 0;
  for (const f of frames) {
    const len = f.length + 7;
    out[o] = 0xff;
    out[o + 1] = 0xf1;
    out[o + 2] = ((asc.aot - 1) << 6) | (asc.sfi << 2) | (asc.channels >> 2);
    out[o + 3] = ((asc.channels & 3) << 6) | (len >> 11);
    out[o + 4] = (len >> 3) & 0xff;
    out[o + 5] = ((len & 7) << 5) | 0x1f;
    out[o + 6] = 0xfc;
    out.set(f, o + 7);
    o += len;
  }
  return out;
}
// The bytes of samples k0..k1-1, read in runs (a video's picture between
// them is skipped).
export async function sampleFrames(read, track, k0, k1) {
  const frames = [];
  let i = k0;
  while (i < k1) {
    let j = i + 1,
      end = track.offsets[i] + track.sizes[i];
    while (j < k1 && track.offsets[j] >= end && track.offsets[j] - end < 65536) {
      end = track.offsets[j] + track.sizes[j];
      j++;
    }
    const buf = u8(await read(track.offsets[i], end));
    for (let k = i; k < j; k++) {
      const s = track.offsets[k] - track.offsets[i];
      frames.push(buf.subarray(s, s + track.sizes[k]));
    }
    i = j;
  }
  return frames;
}
// The first sample playing at or after `t` (binary search).
export function sampleAt(times, count, t) {
  let lo = 0,
    hi = count;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid + 1] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

// ---- Decoding (browser) ----

function offlineContext() {
  const C = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!C) bad(MESSAGES.noAudio);
  return new C(1, 1, CHUNK_RATE);
}
// Encoded audio → mono Float32 samples at 16 kHz.
async function decodeMono(buffer) {
  const ctx = offlineContext();
  let audio;
  try {
    audio = await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(buffer, resolve, reject);
      if (p && typeof p.then === "function") p.then(resolve, reject);
    });
  } catch {
    bad(MESSAGES.decode);
  }
  const n = audio.length,
    ch = audio.numberOfChannels;
  if (ch === 1) return audio.getChannelData(0);
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const data = audio.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += data[i] / ch;
  }
  return out;
}
// Exactly `n` samples from `samples`, starting at `lead` (silence past the end).
function exact(samples, lead, n) {
  const out = new Float32Array(n);
  const from = Math.max(0, Math.round(lead));
  out.set(samples.subarray(from, Math.min(samples.length, from + n)));
  return out;
}
const count16k = (start, end) => Math.round(end * CHUNK_RATE) - Math.round(start * CHUNK_RATE);
async function probeDuration(file) {
  if (typeof document === "undefined") return null;
  const url = URL.createObjectURL(file);
  try {
    const el = document.createElement(/^video\//.test(file.type) ? "video" : "audio");
    el.preload = "metadata";
    el.muted = true;
    const d = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(NaN), 8000);
      el.onloadedmetadata = () => (clearTimeout(timer), resolve(el.duration));
      el.onerror = () => (clearTimeout(timer), resolve(NaN));
      el.src = url;
    });
    return Number.isFinite(d) && d > 0 ? d : null;
  } finally {
    URL.revokeObjectURL(url);
  }
}
const FORMAT_NAMES = { wav: "WAV", mp3: "MP3", ogg: "OGG", webm: "WebM", flac: "FLAC", aac: "AAC" };
const isVideoFile = (file) => /^video\//.test(file.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(file.name || "");

// Opens a recording: { format, video, channels, duration, read(start, end) },
// where read resolves to exactly the 16 kHz mono samples from `start` to
// `end` seconds. Throws a RecordingError with a message to show.
export async function openRecording(file) {
  const read = async (start, end) => new Uint8Array(await file.slice(start, end).arrayBuffer());
  const size = file.size;
  const head = await read(0, Math.min(size, 1 << 20));
  const kind = sniff(head);
  const video = kind === "mp4" ? isVideoFile(file) : kind === "webm" && isVideoFile(file);
  if (size > (kind === "mp4" && video ? MAX_VIDEO_BYTES : MAX_FILE_BYTES)) bad(kind === "mp4" && video ? MESSAGES.bigVideo : MESSAGES.big);
  let rec = null;
  if (kind === "wav") {
    const layout = wavLayout(head, size);
    rec = {
      format: "WAV",
      channels: layout.channels,
      duration: layout.duration,
      async read(start, end) {
        const f0 = Math.max(0, Math.floor(start * layout.rate)),
          f1 = Math.min(layout.dataBytes / layout.blockAlign, Math.ceil(end * layout.rate) + 1);
        const data = await read(layout.dataOffset + f0 * layout.blockAlign, layout.dataOffset + f1 * layout.blockAlign);
        const samples = await decodeMono(wavWith(layout, data).buffer);
        return exact(samples, (start - f0 / layout.rate) * CHUNK_RATE, count16k(start, end));
      },
    };
  } else if (kind === "mp3") {
    const index = await mp3Index(read, size);
    const frame = index.samples / index.rate;
    rec = {
      format: "MP3",
      channels: index.channels,
      duration: index.duration,
      async read(start, end) {
        // Three frames early, for the bit reservoir; the decoded lead is cut.
        const k0 = Math.max(0, Math.floor(start / frame) - 3),
          k1 = Math.min(index.offsets.length, Math.ceil(end / frame) + 1);
        const stop = k1 < index.offsets.length ? index.offsets[k1] : index.end;
        const bytes = await read(index.offsets[k0], stop);
        const samples = await decodeMono(bytes.buffer);
        return exact(samples, (start - k0 * frame) * CHUNK_RATE, count16k(start, end));
      },
    };
  } else if (kind === "mp4") {
    const track = await mp4Audio(read, size);
    if (!track.unsupported) {
      rec = {
        format: video ? "MP4" : "M4A",
        channels: track.channels,
        duration: track.duration,
        async read(start, end) {
          const k0 = Math.max(0, sampleAt(track.times, track.count, start) - 2),
            k1 = Math.min(track.count, sampleAt(track.times, track.count, end) + 2);
          const frames = await sampleFrames(read, track, k0, k1);
          const samples = await decodeMono(adtsStream(track.asc, frames).buffer);
          return exact(samples, (start - track.times[k0]) * CHUNK_RATE, count16k(start, end));
        },
      };
    } else if (size > MAX_FILE_BYTES) bad(MESSAGES.bigVideo);
  }
  if (!rec) {
    // Anything else the browser can decode, decoded whole.
    const known = kind ? (FORMAT_NAMES[kind] || (video ? "MP4" : "M4A")) : null;
    if (!kind && !/^(audio|video)\//.test(file.type)) bad(MESSAGES.unknown);
    const d = await probeDuration(file);
    if (d != null && d > WHOLE_MAX_SECONDS) bad(d > MAX_SECONDS ? MESSAGES.long : MESSAGES.wholeLong);
    if (d == null && size > WHOLE_MAX_BYTES) bad(MESSAGES.wholeLong);
    const all = await decodeMono(await file.arrayBuffer());
    const duration = all.length / CHUNK_RATE;
    if (duration > WHOLE_MAX_SECONDS) bad(MESSAGES.wholeLong);
    rec = {
      format: known || (file.name.split(".").pop() || "").toUpperCase().slice(0, 5) || "Audio",
      channels: null,
      duration,
      async read(start, end) {
        return exact(all, start * CHUNK_RATE, count16k(start, end));
      },
    };
  }
  if (!(rec.duration >= MIN_SECONDS)) bad(MESSAGES.short);
  if (rec.duration > MAX_SECONDS + 0.5) bad(MESSAGES.long);
  return { ...rec, video, size };
}

// A piece's WAV as a data URL, for the request body.
export function dataUrl(bytes, type = "audio/wav") {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(new Blob([bytes], { type }));
  });
}
