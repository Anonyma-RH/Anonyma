import zlib from "node:zlib";
import { fail, uid, wantsWebSearch } from "./core.js";
import { chatLimits, contextEstimate } from "../data/chat-limits.js";
import { fetchLink, LinkError } from "./link-reader.js";
import { cleanText, findPhrases, projectVisible, scanInvisible } from "../src/shield.js";
import { parseDocumentBlocks } from "../src/documents.js";
import {
  QUERY_STOP,
  REPO_READER,
  REPO_SYSTEM,
  checkRepoPayload,
  repoKey,
  repoMessages,
  repoUserMessage,
  termsOf,
  validPath,
} from "../src/repo-reader.js";

// Repo Reader (update "reporeader"), the server half.
//
// Fetching: one public repo's tarball from codeload.github.com, through Link
// Reader's SSRF-safe fetcher in its host allowlist mode (every hop, redirects
// included, must be https on codeload.github.com), with no GitHub token, no
// cookies and a generic User-Agent: GitHub sees this server, never the
// person. 50 MB at most, 30 seconds.
//
// Unpacking, in memory only (nothing is written to disk), streamed: the
// gzip is inflated a chunk at a time and the tar read as it arrives, so
// only the kept text is ever held. Refused whole: more than 300 MB
// unpacked (a decompression bomb), more than 60,000 entries, a bad header
// checksum or a cut-off archive. Skipped entry by entry: symbolic and hard
// links (never followed), devices and FIFOs, any path that is absolute,
// has "." or ".." segments, a backslash, a NUL or control character, or
// sits outside the archive's one top folder; vendored and build folders
// (node_modules, vendor, dist, build, ...); lock files, minified files and
// source maps; binaries (by extension, a NUL byte or invalid UTF-8); files
// over 256 KB; and anything past 5,000 files or 8 MB of text. Injection
// Shield's invisible characters (zero-width, bidi overrides, tag
// characters) are taken out of the kept text, as they are from documents.
//
// The index: each kept file in 40-line chunks, with an inverted index for
// BM25, plus the terms of each path. Retrieval scores the question's terms
// against both and returns the best few excerpts.
//
// The cache: per account, in this process's memory only, for 30 minutes
// from the read, 3 repos an account and a server-wide memory budget of
// 128 MB shared by every account (the least recently used repo is forgotten
// first; a read that can't fit even then is refused as busy). Never logged
// and never written anywhere;
// erased with the account's content (forgetRepos) and listed, names and
// times only, in its export (exportRepos).

export const CODELOAD = "codeload.github.com";
const ARCHIVE_TYPES = ["application/x-gzip", "application/gzip", "application/octet-stream"];

export class RepoError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const MESSAGES = {
  repo_not_found: [404, "Couldn't find that repo, branch or tag on GitHub. Private repos can't be read."],
  repo_unavailable: [502, "GitHub didn't send the repo. Try again in a moment."],
  repo_unreachable: [502, "Couldn't reach GitHub. Try again in a moment."],
  repo_timeout: [504, "GitHub took too long to send the repo. Try again, or try a smaller repo."],
  repo_redirect: [502, "GitHub sent the download somewhere unexpected, so it wasn't read."],
  repo_not_archive: [502, "GitHub didn't send the repo's files."],
  repo_too_large: [413, "That repo's download is larger than 50 MB, so it wasn't read."],
  repo_unpacked_too_large: [413, "That repo unpacks to more than 300 MB, so it wasn't read."],
  repo_too_many_entries: [413, "That repo has more than 60,000 files and folders, so it wasn't read."],
  repo_corrupt: [422, "That download wasn't a readable archive, so it wasn't read."],
  repo_no_text: [422, "No readable text files were found in that repo."],
  repo_unpack_timeout: [504, "That repo took too long to unpack, so it wasn't read."],
  repo_cache_full: [503, "Busy, try again in a moment."],
};
export const repoError = (code) => new RepoError(MESSAGES[code][0], code, MESSAGES[code][1]);

// ---- Fetching ----

export function archiveUrl({ owner, repo, ref }) {
  const at = ref ? ref.split("/").map(encodeURIComponent).join("/") : "HEAD";
  return `https://${CODELOAD}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/tar.gz/${at}`;
}
// The tarball's bytes, or a RepoError with a fixed message (never the URL).
// `lookup`, `route` and `timeoutMs` are local test mode's.
export async function fetchArchive(parsed, { lookup, route, timeoutMs, maxBytes } = {}) {
  try {
    const page = await fetchLink(archiveUrl(parsed), {
      hosts: [CODELOAD],
      maxBytes: maxBytes ?? REPO_READER.maxArchiveBytes,
      timeoutMs: timeoutMs ?? REPO_READER.fetchSeconds * 1000,
      types: ARCHIVE_TYPES,
      accept: "application/x-gzip, application/gzip;q=0.9, application/octet-stream;q=0.5",
      ...(lookup ? { lookup } : {}),
      ...(route ? { route } : {}),
    });
    return page.body;
  } catch (e) {
    if (!(e instanceof LinkError)) throw repoError("repo_unreachable");
    if (e.code === "link_status") throw repoError([404, 410, 451].includes(e.upstream) ? "repo_not_found" : "repo_unavailable");
    if (e.code === "link_too_large") throw repoError("repo_too_large");
    if (e.code === "link_timeout") throw repoError("repo_timeout");
    if (e.code === "link_host" || e.code === "link_redirects") throw repoError("repo_redirect");
    if (e.code === "link_type") throw repoError("repo_not_archive");
    throw repoError("repo_unreachable");
  }
}

// ---- Unpacking ----

// Vendored, generated and tool folders, skipped wherever they appear.
export const SKIP_DIRS = new Set(
  [
    "node_modules", "bower_components", "jspm_packages", "vendor", "vendors", "third_party", "third-party",
    "dist", "build", "out", "target", "coverage", ".nyc_output", ".git", ".hg", ".svn", "__pycache__",
    ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".venv", "venv", ".tox",
    ".mypy_cache", ".pytest_cache", ".ruff_cache", ".gradle", ".idea", "pods", "carthage", "deriveddata",
    ".yarn", ".pnpm-store", "site-packages", ".terraform", ".angular", ".docusaurus", ".expo",
  ].map((s) => s.toLowerCase()),
);
const GENERATED = new Set(
  [
    "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lockb", "bun.lock",
    "cargo.lock", "poetry.lock", "pipfile.lock", "uv.lock", "gemfile.lock", "composer.lock", "go.sum",
    "mix.lock", "pubspec.lock", "podfile.lock", "packages.lock.json", "flake.lock", "deno.lock",
  ],
);
const GENERATED_SUFFIX = [".min.js", ".min.mjs", ".min.css", ".js.map", ".css.map", ".map", ".bundle.js", ".chunk.js"];
export const BINARY_EXT = new Set(
  (
    "png jpg jpeg gif webp avif bmp ico icns tif tiff psd ai eps heic raw svgz " +
    "pdf doc docx xls xlsx ppt pptx odt ods odp key numbers pages epub " +
    "zip gz tgz bz2 xz zst 7z rar tar jar war ear aar apk ipa dmg iso img deb rpm msi cab " +
    "exe dll so dylib a o obj lib bin elf class pyc pyo pyd wasm node " +
    "woff woff2 ttf otf eot " +
    "mp3 mp4 m4a m4v wav ogg oga opus flac aac webm mov avi mkv wmv flv mid midi " +
    "sqlite sqlite3 db mdb parquet feather arrow npy npz pkl pickle h5 hdf5 onnx pt pth ckpt safetensors tflite pb gguf " +
    "ds_store lockb blend fbx glb gltf stl 3ds dae unitypackage swf"
  ).split(" "),
);
const extOf = (name) => {
  const base = name.slice(name.lastIndexOf("/") + 1).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1) : base.startsWith(".") ? base.slice(1) : "";
};

const BLOCK = 512;
const EMPTY = Buffer.alloc(0);
function field(h, start, len) {
  const end = h.indexOf(0, start);
  return h.toString("utf8", start, end >= 0 && end < start + len ? end : start + len);
}
// An octal number field; -1 for GNU's base-256 form (only huge sizes use it).
function octal(h, start, len) {
  if (h[start] & 0x80) return -1;
  const s = h.toString("latin1", start, start + len).replace(/\0[\s\S]*$/, "").trim();
  if (!s) return 0;
  return /^[0-7]+$/.test(s) ? parseInt(s, 8) : NaN;
}
function checksumOk(h) {
  const stored = octal(h, 148, 8);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
  return stored === sum;
}
// PAX records: "<length> <key>=<value>\n", lengths in bytes.
function paxRecords(buf) {
  const out = new Map();
  let at = 0;
  while (at < buf.length) {
    const space = buf.indexOf(0x20, at);
    if (space < 0) break;
    const len = Number(buf.toString("latin1", at, space));
    if (!Number.isSafeInteger(len) || len <= space - at || at + len > buf.length) throw repoError("repo_corrupt");
    const record = buf.toString("utf8", space + 1, at + len - 1);
    const eq = record.indexOf("=");
    if (eq > 0) out.set(record.slice(0, eq), record.slice(eq + 1));
    at += len;
  }
  return out;
}
const CONTROL = /[\u0000-\u001f\u007f]/;

// Reads a tar stream chunk by chunk (see the header comment for the rules).
class TarReader {
  constructor(limits) {
    this.limits = limits;
    this.left = EMPTY;
    this.state = "header";
    this.remaining = 0;
    this.padding = 0;
    this.entry = null;
    this.top = null;
    this.pax = null;
    this.longName = null;
    this.commit = null;
    this.entries = 0;
    this.files = [];
    this.keptBytes = 0;
    this.hidden = 0;
    this.truncated = false;
    this.skipped = { vendored: 0, generated: 0, binary: 0, large: 0, links: 0, unsafe: 0, other: 0, limit: 0 };
    this.skippedDirs = new Set();
  }
  push(chunk) {
    let data = this.left.length ? Buffer.concat([this.left, chunk]) : chunk;
    let at = 0;
    while (at < data.length && this.state !== "done") {
      if (this.state === "header") {
        if (data.length - at < BLOCK) break;
        this.header(data.subarray(at, at + BLOCK));
        at += BLOCK;
      } else if (this.state === "body") {
        const take = Math.min(this.remaining, data.length - at);
        if (this.entry.keep) this.entry.chunks.push(Buffer.from(data.subarray(at, at + take)));
        this.remaining -= take;
        at += take;
        if (!this.remaining) this.finish();
      } else {
        const take = Math.min(this.padding, data.length - at);
        this.padding -= take;
        at += take;
        if (!this.padding) this.state = "header";
      }
    }
    this.left = at < data.length && this.state !== "done" ? Buffer.from(data.subarray(at)) : EMPTY;
  }
  end() {
    if (this.state === "body" || this.state === "pad" || this.left.length) throw repoError("repo_corrupt");
  }
  // The entry's path inside the repo ("" for the top folder), or null when
  // it's unsafe or outside the top folder.
  relative(name, folder = false) {
    if (!name || CONTROL.test(name) || name.includes("\\") || name.startsWith("/")) return null;
    const segs = name.replace(/\/+$/, "").split("/");
    if (segs.some((s) => s === "" || s === "." || s === "..")) return null;
    // The top folder is the first folder seen (codeload's "<repo>-<ref>/").
    if (this.top === null && segs.length < 2 && !folder) return null;
    this.top ??= segs[0];
    if (segs[0] !== this.top) return null;
    const rel = segs.slice(1).join("/");
    if (!rel) return "";
    if (segs.length - 1 > this.limits.maxDepth || !validPath(rel)) return null;
    return rel;
  }
  header(h) {
    if (h.every((b) => b === 0)) {
      this.state = "done";
      return;
    }
    if (!checksumOk(h)) throw repoError("repo_corrupt");
    if (++this.entries > this.limits.maxEntries) throw repoError("repo_too_many_entries");
    const type = String.fromCharCode(h[156] || 0x30);
    const size = octal(h, 124, 12);
    if (!Number.isSafeInteger(size) || size < 0) throw size === -1 ? repoError("repo_unpacked_too_large") : repoError("repo_corrupt");
    if (size > this.limits.maxUnpackedBytes) throw repoError("repo_unpacked_too_large");
    const ustar = h.toString("latin1", 257, 262) === "ustar";
    const prefix = ustar ? field(h, 345, 155) : "";
    const name = this.pax?.get("path") ?? this.longName ?? (prefix ? prefix + "/" : "") + field(h, 0, 100);
    const meta = type === "x" || type === "g" || type === "L" || type === "K";
    // A PAX size overrides the header's only for files too big for it,
    // which are over every limit here anyway: any disagreement is refused.
    if (!meta && this.pax?.has("size") && Number(this.pax.get("size")) !== size) throw repoError("repo_corrupt");
    if (!meta) {
      this.pax = null;
      this.longName = null;
    }
    const entry = { type, name, size, keep: false, chunks: [], path: null };
    if (meta) {
      if (size > 1024 * 1024) throw repoError("repo_corrupt");
      entry.keep = type !== "K";
    } else if (type === "0" || type === "7" || type === "\0") {
      const rel = this.relative(name);
      if (rel === null || rel === "") this.skipped.unsafe++;
      else this.consider(entry, rel, size);
    } else if (type === "5") {
      if (this.relative(name, true) === null) this.skipped.unsafe++;
    } else if (type === "1" || type === "2") this.skipped.links++;
    else this.skipped.other++;
    this.entry = entry;
    this.remaining = size;
    this.padding = (BLOCK - (size % BLOCK)) % BLOCK;
    this.state = "body";
    if (!size) this.finish();
  }
  consider(entry, rel, size) {
    const segs = rel.split("/");
    const base = segs.at(-1).toLowerCase();
    const vendored = segs.slice(0, -1).findIndex((s) => SKIP_DIRS.has(s.toLowerCase()));
    if (vendored >= 0) {
      this.skipped.vendored++;
      if (this.skippedDirs.size < 12) this.skippedDirs.add(segs.slice(0, vendored + 1).join("/"));
      return;
    }
    if (GENERATED.has(base) || GENERATED_SUFFIX.some((x) => base.endsWith(x))) return void this.skipped.generated++;
    if (BINARY_EXT.has(extOf(base))) return void this.skipped.binary++;
    if (size > this.limits.maxFileBytes) return void this.skipped.large++;
    if (this.files.length >= this.limits.maxFiles || this.keptBytes + size > this.limits.maxTextBytes) {
      this.truncated = true;
      return void this.skipped.limit++;
    }
    entry.keep = true;
    entry.path = rel;
  }
  finish() {
    const e = this.entry;
    this.state = this.padding ? "pad" : "header";
    if (!e?.keep) return;
    const buf = e.chunks.length === 1 ? e.chunks[0] : Buffer.concat(e.chunks);
    e.chunks = [];
    if (e.type === "x") return void (this.pax = paxRecords(buf));
    if (e.type === "g") {
      const comment = paxRecords(buf).get("comment");
      if (comment && /^[0-9a-f]{40}$/.test(comment.trim())) this.commit = comment.trim();
      return;
    }
    if (e.type === "L") return void (this.longName = buf.toString("utf8").replace(/\0[\s\S]*$/, ""));
    if (buf.includes(0)) return void this.skipped.binary++;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buf);
    } catch {
      return void this.skipped.binary++;
    }
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    text = text.replace(/\r\n/g, "\n");
    const invisible = scanInvisible(text);
    if (invisible.total) {
      this.hidden += invisible.total;
      text = cleanText(text, { text, invisible });
    }
    this.keptBytes += buf.length;
    this.files.push({ path: e.path, text, bytes: buf.length });
  }
}

// Unpacks a .tar.gz held in memory: { files: [{ path, text, bytes }],
// skipped, skippedDirs, truncated, hidden, commit, entries }, or a
// RepoError. `limits` defaults to REPO_READER's.
export function unpackTarball(gz, limits = REPO_READER) {
  return new Promise((resolve, reject) => {
    const reader = new TarReader(limits);
    const gunzip = zlib.createGunzip({ chunkSize: 64 * 1024 });
    let total = 0,
      settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      gunzip.removeAllListeners("data");
      gunzip.destroy();
      if (err) return reject(err instanceof RepoError ? err : repoError("repo_corrupt"));
      if (!reader.files.length) return reject(repoError("repo_no_text"));
      reader.files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      resolve({
        files: reader.files,
        skipped: reader.skipped,
        skippedDirs: [...reader.skippedDirs],
        truncated: reader.truncated,
        hidden: reader.hidden,
        commit: reader.commit,
        entries: reader.entries,
      });
    };
    const timer = setTimeout(() => done(repoError("repo_unpack_timeout")), limits.unpackSeconds * 1000);
    timer.unref?.();
    gunzip.on("data", (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > limits.maxUnpackedBytes) return done(repoError("repo_unpacked_too_large"));
      try {
        reader.push(chunk);
      } catch (e) {
        return done(e);
      }
      if (reader.state === "done") done();
    });
    gunzip.on("error", () => done(repoError("repo_corrupt")));
    gunzip.on("end", () => {
      try {
        reader.end();
        done();
      } catch (e) {
        done(e);
      }
    });
    if (!Buffer.isBuffer(gz) || gz.length < 18 || gz[0] !== 0x1f || gz[1] !== 0x8b) return done(repoError("repo_corrupt"));
    gunzip.end(gz);
  });
}

// ---- The index ----

const K1 = 1.2,
  B = 0.75;
function lineStarts(text) {
  const starts = [0];
  for (let i = text.indexOf("\n"); i >= 0 && i < text.length - 1; i = text.indexOf("\n", i + 1)) starts.push(i + 1);
  return Int32Array.from(starts);
}
// Lines [start, end] (1-based) of a file, as one string.
export function linesOf(file, start, end) {
  const s = file.starts;
  const text = file.text;
  const from = s[start - 1] ?? text.length;
  const to = end < s.length ? s[end] - 1 : text.endsWith("\n") ? text.length - 1 : text.length;
  return text.slice(from, Math.max(from, to));
}
const pathTerms = (path) => new Set(termsOf(path.replace(/[/.\-]/g, " ")));

// Builds the search index for unpacked files, yielding to the event loop
// now and then. Returns { files, chunks..., postings, avg, bytes }.
export async function buildIndex(files, { chunkLines = REPO_READER.snippetLines } = {}) {
  const rows = [],
    chunkFile = [],
    chunkStart = [],
    chunkEnd = [],
    chunkLen = [];
  const postings = new Map();
  let bytes = 0,
    totalLen = 0;
  for (let fi = 0; fi < files.length; fi++) {
    if (fi && fi % 150 === 0) await new Promise((r) => setImmediate(r));
    const f = files[fi];
    const starts = lineStarts(f.text);
    const lines = f.text ? starts.length : 0;
    const base = f.path.slice(f.path.lastIndexOf("/") + 1);
    rows.push({ path: f.path, text: f.text, bytes: f.bytes, starts, lines, terms: pathTerms(f.path), baseTerms: pathTerms(base) });
    bytes += f.text.length * 2 + starts.length * 4 + f.path.length * 4 + 200;
    for (let s = 0; s < Math.max(lines, 1); s += chunkLines) {
      const e = Math.min(lines, s + chunkLines);
      const ci = chunkFile.length;
      const words = termsOf(e > s ? linesOf(rows[fi], s + 1, e) : "");
      const counts = new Map();
      for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
      for (const [w, c] of counts) {
        let list = postings.get(w);
        if (!list) postings.set(w, (list = []));
        list.push(ci, c);
      }
      chunkFile.push(fi);
      chunkStart.push(s + 1);
      chunkEnd.push(Math.max(e, s + 1));
      chunkLen.push(words.length);
      totalLen += words.length;
    }
  }
  const packed = new Map();
  for (const [w, list] of postings) {
    packed.set(w, Int32Array.from(list));
    bytes += list.length * 4 + w.length * 2 + 64;
  }
  const n = chunkFile.length;
  return {
    files: rows,
    byPath: new Map(rows.map((r, i) => [r.path, i])),
    chunkFile: Int32Array.from(chunkFile),
    chunkStart: Int32Array.from(chunkStart),
    chunkEnd: Int32Array.from(chunkEnd),
    chunkLen: Int32Array.from(chunkLen),
    postings: packed,
    avg: n ? totalLen / n || 1 : 1,
    bytes: bytes + n * 16,
  };
}

const TEST_PATH = /(^|\/)(tests?|__tests__|specs?|e2e|fixtures?)\/|\.(test|spec)\.[a-z0-9]+$|(^|\/)test_[^/]+\.py$|_test\.(go|py|rb)$/i;
const CHANGELOG = /(^|\/)(changelog|changes|history|news|releases?)(\.[a-z0-9]+)?$/i;
const MANIFESTS = ["package.json", "pyproject.toml", "setup.py", "cargo.toml", "go.mod", "pom.xml", "build.gradle", "gemfile", "composer.json", "mix.exs", "deno.json"];
const isReadme = (p) => /^readme(\.[a-z0-9]+)?$/i.test(p);

// The best excerpts for a question: { snippets: [{ path, start, end, text,
// flagged }], fallback }, at most maxSnippets, perFile from one file and
// snippetChars of text. With no term matching anything, the README and the
// top-level manifest go instead (fallback: true).
export function retrieve(index, question, opts = {}) {
  const max = opts.maxSnippets ?? REPO_READER.maxSnippets,
    perFile = opts.perFile ?? REPO_READER.perFile,
    budget = opts.snippetChars ?? REPO_READER.snippetChars;
  const n = index.chunkFile.length;
  const terms = [...new Set(termsOf(question, QUERY_STOP))].slice(0, 24);
  const scores = new Float64Array(n);
  for (const t of terms) {
    const list = index.postings.get(t);
    if (!list) continue;
    const df = list.length / 2;
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
    for (let i = 0; i < list.length; i += 2) {
      const c = list[i],
        tf = list[i + 1];
      scores[c] += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * index.chunkLen[c]) / index.avg));
    }
  }
  // Paths: a question's term in a file's path lifts that file, more so in
  // its name, and a file the question names outright most of all.
  const q = String(question).toLowerCase();
  const fileBonus = new Float64Array(index.files.length);
  index.files.forEach((f, fi) => {
    let bonus = 0;
    for (const t of terms) if (f.terms.has(t)) bonus += f.baseTerms.has(t) ? 2 : 1.2;
    const base = f.path.slice(f.path.lastIndexOf("/") + 1).toLowerCase();
    if (q.includes(f.path.toLowerCase()) || (base.length >= 5 && q.includes(base))) bonus += 8;
    fileBonus[fi] = bonus;
  });
  // Tests and changelogs mention everything; the code itself should win
  // unless the question is about them.
  const aboutTests = /\b(test|tests|testing|spec|specs)\b|测试/i.test(q),
    aboutChanges = /\b(change|changes|changelog|history|version|versions|release|releases)\b|版本|更新/i.test(q);
  const prior = index.files.map((f) =>
    !aboutTests && TEST_PATH.test(f.path) ? 0.6 : !aboutChanges && CHANGELOG.test(f.path) ? 0.5 : 1,
  );
  for (let c = 0; c < n; c++) scores[c] *= prior[index.chunkFile[c]];
  const firstOf = new Int32Array(index.files.length).fill(-1);
  for (let c = 0; c < n; c++) if (firstOf[index.chunkFile[c]] < 0) firstOf[index.chunkFile[c]] = c;
  for (let c = 0; c < n; c++) {
    const b = fileBonus[index.chunkFile[c]];
    if (b) scores[c] += firstOf[index.chunkFile[c]] === c ? b : scores[c] > 0 ? b / 2 : 0;
  }
  let order = [];
  for (let c = 0; c < n; c++) if (scores[c] > 0) order.push(c);
  order.sort((a, b) => scores[b] - scores[a] || a - b);
  let fallback = false;
  if (!order.length) {
    fallback = true;
    const picks = index.files
      .map((f, fi) => ({ fi, rank: isReadme(f.path) ? 0 : MANIFESTS.includes(f.path.toLowerCase()) ? 1 : -1 }))
      .filter((x) => x.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 2);
    order = picks.map((p) => firstOf[p.fi]).filter((c) => c >= 0);
    if (!order.length && n) order = [0];
  }
  const chosen = [],
    fromFile = new Map();
  let used = 0;
  for (const c of order) {
    if (chosen.length >= max) break;
    const fi = index.chunkFile[c];
    if ((fromFile.get(fi) || 0) >= perFile) continue;
    const file = index.files[fi];
    let start = index.chunkStart[c],
      end = index.chunkEnd[c];
    let text = linesOf(file, start, end);
    if (text.length > REPO_READER.maxSnippetChars || used + text.length > budget) {
      // Shorten a long excerpt from its end to what's left of the budget.
      const room = Math.min(REPO_READER.maxSnippetChars, budget - used);
      if (room < 400) continue;
      while (end > start && text.length > room) text = linesOf(file, start, --end);
      if (text.length > room) continue;
    }
    chosen.push({ fi, start, end, text, score: scores[c] });
    fromFile.set(fi, (fromFile.get(fi) || 0) + 1);
    used += text.length;
  }
  // Neighbouring excerpts of one file join up; files keep their best rank.
  const rank = new Map();
  chosen.forEach((s, i) => rank.has(s.fi) || rank.set(s.fi, i));
  chosen.sort((a, b) => rank.get(a.fi) - rank.get(b.fi) || a.start - b.start);
  const snippets = [];
  for (const s of chosen) {
    const prev = snippets.at(-1);
    if (prev && prev.fi === s.fi && s.start <= prev.end + 1 && s.end - prev.start < REPO_READER.maxSnippetLines) {
      prev.end = Math.max(prev.end, s.end);
      prev.text = linesOf(index.files[s.fi], prev.start, prev.end);
    } else snippets.push({ ...s });
  }
  return {
    fallback,
    terms,
    snippets: snippets.map(({ fi, start, end, text }) => ({
      path: index.files[fi].path,
      start,
      end,
      text,
      // Injection Shield: text that reads like instructions to an AI. It's
      // sent as data either way; the page says so.
      flagged: findPhrases(projectVisible(text).visible).length > 0,
    })),
  };
}

// The file list sent with a question: shallow paths first, always
// including the excerpts' files, within listPaths and listChars.
export function fileList(index, must = []) {
  const depth = (p) => p.split("/").length;
  const all = index.files.map((f) => f.path).sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : 1));
  const out = [...new Set(must)];
  let chars = out.join("\n").length;
  for (const p of all) {
    if (out.length >= REPO_READER.listPaths) break;
    if (out.includes(p)) continue;
    if (chars + p.length + 1 > REPO_READER.listChars) break;
    out.push(p);
    chars += p.length + 1;
  }
  return out.sort();
}

// A question's payload as the page sends it back on /api/chat, fitted to
// the message cap by dropping the weakest excerpts. The browser shows this
// ("What the AI sees") before anything is sent.
export function findForQuestion(entry, question) {
  const found = retrieve(entry.index, question);
  const payload = {
    repo: entry.repo,
    ref: entry.ref,
    commit: entry.commit,
    question: String(question).trim(),
    list: [],
    total_files: entry.index.files.length,
    snippets: found.snippets.map(({ path, start, end, text }) => ({ path, start, end, text })),
  };
  const flagged = found.snippets.map((s) => s.flagged);
  payload.list = fileList(entry.index, payload.snippets.map((s) => s.path));
  while (payload.snippets.length > 1 && repoUserMessage(payload).length > REPO_READER.messageChars) {
    payload.snippets.pop();
    flagged.pop();
  }
  while (payload.list.length > 20 && repoUserMessage(payload).length > REPO_READER.messageChars)
    payload.list = payload.list.slice(0, Math.floor(payload.list.length * 0.8));
  return { payload, flagged, fallback: found.fallback };
}

// ---- The cache ----

// The cache's server-wide memory budget: the container's memory is shared
// with everything else the server does.
export const REPO_CACHE_BYTES = 128 * 1024 * 1024;
export function createRepoCache({
  now = Date.now,
  ttlMs = REPO_READER.ttlMinutes * 60000,
  perAccount = REPO_READER.perAccount,
  maxBytes = REPO_CACHE_BYTES,
} = {}) {
  const entries = new Map();
  const drop = (id) => {
    const e = entries.get(id);
    if (!e) return;
    clearTimeout(e.timer);
    entries.delete(id);
  };
  const sweep = () => {
    const t = now();
    for (const [id, e] of entries) if (e.expires <= t) drop(id);
  };
  const bytes = () => [...entries.values()].reduce((n, e) => n + e.bytes, 0);
  // The least recently used entry (of one account, or of all).
  const idlest = (user) => {
    let pick = null;
    for (const e of entries.values()) if ((user == null || e.user === user) && (!pick || e.used < pick.used)) pick = e;
    return pick;
  };
  const touch = (e) => {
    if (e) e.used = now();
    return e;
  };
  return {
    // Keeps a read repo for this account and returns the entry. The
    // account's least recently used repo goes when it has 3, then anyone's
    // least recently used until it fits the budget; one that can't fit
    // even in an empty cache is refused as busy, and nothing is dropped.
    put(user, data) {
      sweep();
      if (!(data.bytes <= maxBytes)) throw repoError("repo_cache_full");
      for (const e of [...entries.values()]) if (e.user === user && e.key === data.key) drop(e.id);
      while ([...entries.values()].filter((e) => e.user === user).length >= perAccount) drop(idlest(user).id);
      while (entries.size && bytes() + data.bytes > maxBytes) drop(idlest().id);
      if (bytes() + data.bytes > maxBytes) throw repoError("repo_cache_full");
      const created = now();
      const entry = { ...data, id: uid("repo_"), user, created, used: created, expires: created + ttlMs };
      entry.timer = setTimeout(() => drop(entry.id), ttlMs);
      entry.timer.unref?.();
      entries.set(entry.id, entry);
      return entry;
    },
    get(user, id) {
      sweep();
      const e = typeof id === "string" ? entries.get(id) : null;
      return e && e.user === user ? touch(e) : null;
    },
    byKey(user, key) {
      sweep();
      for (const e of entries.values()) if (e.user === user && e.key === key) return touch(e);
      return null;
    },
    list(user) {
      sweep();
      return [...entries.values()].filter((e) => e.user === user).sort((a, b) => b.created - a.created);
    },
    forget(user, id) {
      const e = entries.get(id);
      if (!e || e.user !== user) return false;
      drop(id);
      return true;
    },
    forgetAll(user) {
      for (const e of [...entries.values()]) if (e.user === user) drop(e.id);
    },
    clear() {
      for (const id of [...entries.keys()]) drop(id);
    },
    get size() {
      sweep();
      return entries.size;
    },
    get bytes() {
      sweep();
      return bytes();
    },
    maxBytes,
  };
}
// One cache per app (per database), so account erasure can reach it.
const caches = new WeakMap();
export function repoCacheFor(db, options) {
  if (!caches.has(db)) caches.set(db, createRepoCache(options));
  return caches.get(db);
}
// Account closure and Panic Wipe (eraseAccountContent in routes/account.js).
export const forgetRepos = (db, user) => caches.get(db)?.forgetAll(user);
// Account export: which repos are being read right now (names and times
// only; the files are a public repo's, and go in 30 minutes anyway).
export const exportRepos = (db, user) =>
  (caches.get(db)?.list(user) || []).map((e) => ({
    repo: e.repo,
    ref: e.ref,
    commit: e.commit,
    files: e.index.files.length,
    read: e.created,
    forgotten_at: e.expires,
  }));
export const repoKeyOf = repoKey;

// ---- The question, on /api/chat ----

// Refused alongside a question: every other built-message mode, options
// that store or add context, and Seed Guard's override (the question is
// checked on its own, below, with no override).
const REFUSED = [
  "auto",
  "conversationId",
  "project",
  "taskTool",
  "double_check",
  "treasury",
  "messages",
  "sheets",
  "study",
  "compare",
  "catchup",
  "canvas",
  "slides",
  "models",
  "depth",
  "question",
  "allow_seed_phrase",
];
// Runs in runChat (and /api/quote) after the other built-message modes;
// returns the checked payload, or undefined without `repo`.
export function prepareRepoRequest(body, { quote = false } = {}) {
  if (!body || body.repo === undefined) return;
  const refuse = (message) => fail(400, message, "invalid_repo");
  if (!quote && body.ephemeral !== true)
    refuse("Questions about a repo are asked off the record: send the request off the record.");
  for (const key of REFUSED)
    if (body[key] !== undefined && body[key] !== null) refuse("A repo question can't be combined with other chat options.");
  if (body.memory != null || wantsWebSearch(body)) refuse("A repo question can't be combined with other chat options.");
  if (body.mode !== undefined && body.mode !== "chat") refuse("A repo question can't be combined with other chat options.");
  let payload;
  try {
    payload = checkRepoPayload(body.repo);
  } catch (e) {
    refuse(e.message);
  }
  body.messages = repoMessages(payload);
  body.max_tokens = REPO_READER.replyTokens;
  body.mode = "chat";
  return payload;
}
// The answer's budget for the chosen model: replyTokens, lowered to the
// model's output cap and to what its context leaves after the excerpts.
// Refused before anything is held when that's under 2,000 tokens.
export function repoBudget(model, messages) {
  const limits = chatLimits(model);
  const room = (limits.contextTokens || 32768) - contextEstimate(messages);
  if (room < Math.min(2000, limits.maxOutputTokens))
    fail(
      400,
      "These excerpts are too long for this model. Choose a model with a larger context, or ask a narrower question. Nothing was sent or charged.",
      "repo_too_long",
    );
  return Math.max(1, Math.min(REPO_READER.replyTokens, limits.maxOutputTokens, room));
}

// ---- LOCAL_TEST_MODE only (server/provider.js) ----
// A stand-in for a model: it lists the excerpts it was sent, citing each as
// path:start-end, and never invents anything. [[repo:empty]] in the
// question returns nothing (released, not charged); [[repo:length]] a
// reply cut short. Never used live.
export function repoTestReply(messages) {
  if (messages?.[0]?.content !== REPO_SYSTEM) return null;
  const user = String(messages.find((m) => m.role === "user")?.content || "");
  const { text, documents } = parseDocumentBlocks(user);
  const question = /^Question: (.*)$/m.exec(text)?.[1] || "";
  const repo = /^Repository: (\S+)/m.exec(text)?.[1] || "the repo";
  if (question.includes("[[repo:empty]]")) return { text: "", finish: "stop" };
  const excerpts = documents.filter((d) => /:\d+-\d+$/.test(d.name));
  const lines = excerpts.slice(0, 6).map((d) => {
    const first = d.text
      .split("\n")
      .map((l) => l.replace(/^\d+\| ?/, "").trim())
      .find((l) => l.length > 2) || "";
    return `- \`${d.name}\` — ${first.replace(/`/g, "'").slice(0, 90)}`;
  });
  const answer = [
    "**Local test provider** — a fixture, not a model. It lists the excerpts it was sent instead of reading them.",
    "",
    `The closest matches in ${repo}:`,
    "",
    ...lines,
    "",
    `The most relevant file looks like \`${excerpts[0]?.name.replace(/-\d+$/, "") || "README.md:1"}\`. Configure a gateway key for real answers.`,
  ].join("\n");
  if (question.includes("[[repo:length]]")) return { text: answer.slice(0, 120), finish: "length" };
  return { text: answer, finish: "stop" };
}
