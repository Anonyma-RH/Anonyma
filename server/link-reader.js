import http from "node:http";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { lookup as dnsLookup } from "node:dns/promises";
import { stripTracking } from "../src/link-reader.js";

// Link Reader, the network half: fetches one public web page for the
// workspace (routes/link-reader.js) without letting a link reach anything
// that isn't the public internet (SSRF).
//
// - The URL: http or https only, on its scheme's standard port (80 or 443),
//   with no username or password, a real multi-label host name (or a public
//   IP literal), and at most 2,048 characters. Known tracking parameters
//   (utm_*, fbclid, gclid, ...) are removed before it's fetched.
// - DNS is resolved here, once per hop. Every address a name resolves to must
//   be public (blockedAddress below: loopback, private, link-local, CGNAT,
//   multicast, broadcast, reserved, documentation, ULA, IPv4-mapped and NAT64
//   forms of those, and the cloud metadata addresses are refused), and the
//   connection goes to that vetted address, with the name only as SNI and the
//   Host header. A DNS answer that changes between the check and the
//   connection (rebinding) is never asked for.
// - Redirects are followed by hand, at most 3, and every hop is checked again
//   from the start.
// - The request carries no cookies, no Referer and a generic User-Agent; the
//   response's cookies are ignored. 10 seconds for the whole fetch, 5 MB for
//   the body (after decompression too), and only text/html, text/plain and
//   application/pdf are accepted.
// - Errors are LinkError(status, code, message) with fixed messages that
//   never contain the URL, a host or an address; nothing here logs.

export const LINK_LIMITS = Object.freeze({
  maxUrl: 2048,
  maxRedirects: 3,
  timeoutMs: 10000,
  maxBytes: 5 * 1024 * 1024,
});
export const USER_AGENT =
  "Mozilla/5.0 (compatible; ANONYMA-LinkReader/1.0; +https://askanonyma.com)";
export const ACCEPTED_TYPES = ["text/html", "text/plain", "application/pdf"];
const PORTS = { "http:": "80", "https:": "443" };

export class LinkError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const MESSAGES = {
  link_invalid: [400, "Paste a full link that starts with http or https."],
  link_userinfo: [400, "Links with a username or password in them can't be read."],
  link_port: [400, "Only links on the standard web ports (80 and 443) can be read."],
  link_blocked: [400, "That link points to a private or local address, so ANONYMA won't read it."],
  link_unreachable: [502, "Couldn't reach that page. Check the link and try again."],
  link_timeout: [504, "That page took longer than 10 seconds to load."],
  link_too_large: [413, "That page is larger than 5 MB."],
  link_type: [415, "Only web pages, plain text and PDFs can be read."],
  link_redirects: [502, "That link redirected more than 3 times."],
  link_status: [502, "The site didn't return the page."],
};
export function linkError(code) {
  const [status, message] = MESSAGES[code];
  return new LinkError(status, code, message);
}

// ---- Addresses ----

function v4Bytes(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const b = m.slice(1).map(Number);
  return b.every((x) => x <= 255) ? b : null;
}
// 16 bytes for a textual IPv6 address (with "::" and a dotted IPv4 tail), or
// null. Zone ids ("%eth0") are refused by the caller.
function v6Bytes(s) {
  if (!net.isIPv6(s) || s.includes("%")) return null;
  let head = s,
    tail4 = null;
  const dotted = /:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (dotted) {
    tail4 = v4Bytes(dotted[1]);
    if (!tail4) return null;
    head = s.slice(0, dotted.index + 1) + "0:0";
  }
  const [left, right] = head.includes("::") ? head.split("::") : [head, null];
  const part = (x) => (x ? x.split(":").filter((p) => p !== "") : []);
  const l = part(left),
    r = part(right);
  const fill = right === null ? 0 : 8 - l.length - r.length;
  const groups = [...l, ...Array(fill).fill("0"), ...r];
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((g) => {
    const v = parseInt(g, 16);
    return [v >> 8, v & 255];
  });
  if (tail4) bytes.splice(12, 4, ...tail4);
  return bytes;
}
const v4Int = (b) => ((b[0] << 24) | (b[1] << 16) | (b[2] << 8) | b[3]) >>> 0;
const V4_BLOCKS = [
  ["0.0.0.0", 8, "this network"],
  ["10.0.0.0", 8, "private"],
  ["100.64.0.0", 10, "shared (CGNAT)"],
  ["127.0.0.0", 8, "loopback"],
  ["169.254.0.0", 16, "link-local"], // includes 169.254.169.254 (metadata)
  ["172.16.0.0", 12, "private"],
  ["192.0.0.0", 24, "protocol assignments"], // includes 192.0.0.192 (metadata)
  ["192.0.2.0", 24, "documentation"],
  ["192.88.99.0", 24, "6to4 relay"],
  ["192.168.0.0", 16, "private"],
  ["198.18.0.0", 15, "benchmarking"],
  ["198.51.100.0", 24, "documentation"],
  ["203.0.113.0", 24, "documentation"],
  ["224.0.0.0", 4, "multicast"],
  ["240.0.0.0", 4, "reserved"], // includes 255.255.255.255 (broadcast)
  ["168.63.129.16", 32, "cloud metadata"], // Azure's host endpoint
].map(([base, bits, why]) => {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (v4Int(v4Bytes(base)) & mask) >>> 0, mask, why };
});
function blockedV4(b) {
  const n = v4Int(b);
  return V4_BLOCKS.find((r) => ((n & r.mask) >>> 0) === r.net)?.why || null;
}
const prefix = (bytes, pattern, bits) => {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3,
      bit = 7 - (i & 7);
    if (((bytes[byte] >> bit) & 1) !== ((pattern[byte] >> bit) & 1)) return false;
  }
  return true;
};
const V6 = (s) => v6Bytes(s);
const V6_BLOCKS = [
  [V6("64:ff9b:1::"), 48, "local NAT64"],
  [V6("2001::"), 23, "protocol assignments"], // includes Teredo 2001::/32
  [V6("2001:db8::"), 32, "documentation"],
  [V6("2002::"), 16, "6to4"],
  [V6("3fff::"), 20, "documentation"],
];
// Why an address may not be fetched ("loopback", "private", ...), or null
// when it's a public unicast address.
export function blockedAddress(address) {
  const s = String(address ?? "").trim();
  const four = v4Bytes(s);
  if (four) return blockedV4(four);
  const six = v6Bytes(s.replace(/^\[|\]$/g, ""));
  if (!six) return "not an address";
  const zero = (from, to) => six.slice(from, to).every((x) => x === 0);
  if (zero(0, 16)) return "unspecified";
  if (zero(0, 15) && six[15] === 1) return "loopback";
  // IPv4-mapped (::ffff:a.b.c.d) and NAT64 (64:ff9b::a.b.c.d): the IPv4
  // address inside decides. IPv4-compatible (::a.b.c.d) is deprecated.
  if (zero(0, 10) && six[10] === 0xff && six[11] === 0xff)
    return blockedV4(six.slice(12)) ? "mapped " + blockedV4(six.slice(12)) : null;
  if (zero(0, 12)) return "IPv4-compatible";
  if (prefix(six, V6("64:ff9b::"), 96))
    return blockedV4(six.slice(12)) ? "NAT64 " + blockedV4(six.slice(12)) : null;
  // Global unicast is 2000::/3; everything else (ULA fc00::/7 with the
  // fd00:ec2::254 metadata address, link-local fe80::/10, site-local,
  // multicast ff00::/8, discard 100::/64, ...) is refused.
  if ((six[0] & 0xe0) !== 0x20) {
    if ((six[0] & 0xfe) === 0xfc) return "unique local";
    if (six[0] === 0xfe && (six[1] & 0xc0) === 0x80) return "link-local";
    if (six[0] === 0xff) return "multicast";
    return "reserved";
  }
  return V6_BLOCKS.find(([p, bits]) => prefix(six, p, bits))?.[2] || null;
}
// The address to connect to: IPv4-mapped IPv6 is dialled as plain IPv4.
function dialable(address) {
  const six = v6Bytes(address);
  if (six && six.slice(0, 10).every((x) => x === 0) && six[10] === 0xff && six[11] === 0xff)
    return { address: six.slice(12).join("."), family: 4 };
  return { address, family: net.isIPv4(address) ? 4 : 6 };
}

// ---- URLs ----

const NAME_LABEL = /^(?!-)[a-z0-9_-]{1,63}(?<!-)$/;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan", ".intranet", ".corp"];
// A link that may be fetched, as a URL object with tracking parameters
// removed, or a LinkError. `base` resolves a redirect's Location.
export function checkUrl(input, base) {
  if (typeof input !== "string") throw linkError("link_invalid");
  const raw = input.trim();
  if (!raw || raw.length > LINK_LIMITS.maxUrl || /[\u0000-\u001f\u007f\s]/.test(raw))
    throw linkError("link_invalid");
  let url;
  try {
    url = base ? new URL(raw, base) : new URL(raw);
  } catch {
    throw linkError("link_invalid");
  }
  if (!PORTS[url.protocol]) throw linkError("link_invalid");
  // "user@host" and "user:pass@host", including an empty user ("@host"),
  // which the parser drops without a trace.
  if (
    url.username ||
    url.password ||
    /^(?:[a-z][a-z0-9+.-]*:[\/\\]*|[\/\\]{2})[^\/\\?#]*@/i.test(raw)
  )
    throw linkError("link_userinfo");
  // The parser drops a scheme's own default port, so anything left is
  // non-standard (including http on 443 and https on 80).
  if (url.port !== "" && url.port !== PORTS[url.protocol]) throw linkError("link_port");
  const host = url.hostname.toLowerCase();
  if (host.startsWith("[")) {
    if (blockedAddress(host)) throw linkError("link_blocked");
  } else if (net.isIPv4(host)) {
    if (blockedAddress(host)) throw linkError("link_blocked");
  } else {
    const name = host.endsWith(".") ? host.slice(0, -1) : host;
    const labels = name.split(".");
    if (
      labels.length < 2 ||
      !labels.every((l) => NAME_LABEL.test(l)) ||
      /^\d+$/.test(labels.at(-1)) ||
      name === "localhost" ||
      LOCAL_SUFFIXES.some((s) => name.endsWith(s))
    )
      throw linkError(name === "localhost" || LOCAL_SUFFIXES.some((s) => name.endsWith(s)) ? "link_blocked" : "link_invalid");
  }
  url.hash = "";
  return stripTracking(url);
}

// Every address a host resolves to, all public, with IPv4 first. A name
// that resolves to any refused address is refused as a whole.
export async function vetHost(host, lookup) {
  const bare = host.replace(/^\[|\]$/g, "");
  if (net.isIP(bare)) {
    if (blockedAddress(bare)) throw linkError("link_blocked");
    return [dialable(bare)];
  }
  let answers;
  try {
    answers = await lookup(host.endsWith(".") ? host.slice(0, -1) : host);
  } catch (e) {
    if (e instanceof LinkError) throw e;
    throw linkError("link_unreachable");
  }
  if (!Array.isArray(answers) || !answers.length) throw linkError("link_unreachable");
  const addresses = answers.map((a) => String(a?.address ?? a ?? ""));
  if (addresses.some((a) => !net.isIP(a) || blockedAddress(a))) throw linkError("link_blocked");
  const dial = addresses.map(dialable);
  return [...dial.filter((d) => d.family === 4), ...dial.filter((d) => d.family === 6)];
}
export const systemLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

// ---- Fetching ----

function mediaType(header) {
  const value = String(header || "");
  const type = value.split(";")[0].trim().toLowerCase();
  const charset = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(value)?.[1]?.toLowerCase() || null;
  return { type, charset };
}
function decode(buffer, encoding) {
  const e = String(encoding || "identity").trim().toLowerCase();
  const opts = { maxOutputLength: LINK_LIMITS.maxBytes };
  try {
    if (e === "identity" || e === "") return buffer;
    if (e === "gzip" || e === "x-gzip") return zlib.gunzipSync(buffer, opts);
    if (e === "br") return zlib.brotliDecompressSync(buffer, opts);
    if (e === "deflate") {
      try {
        return zlib.inflateSync(buffer, opts);
      } catch (err) {
        if (err instanceof RangeError || err?.code === "ERR_BUFFER_TOO_LARGE") throw err;
        return zlib.inflateRawSync(buffer, opts);
      }
    }
  } catch (err) {
    if (err instanceof RangeError || err?.code === "ERR_BUFFER_TOO_LARGE") throw linkError("link_too_large");
    throw linkError("link_unreachable");
  }
  throw linkError("link_unreachable");
}

// The request for one GET to a vetted address: the connection goes to
// `target.address`, and the name is only the Host header and TLS SNI (the
// certificate is still checked against the name). `route` (local test mode
// only) sends the connection to a local test server instead, after every
// check has run.
export function requestOptions(url, target, route = null) {
  const secure = url.protocol === "https:";
  const name = url.hostname.replace(/^\[|\]$/g, "");
  const plainName = name.endsWith(".") ? name.slice(0, -1) : name;
  const dest = route ? route(target.address, Number(PORTS[url.protocol])) : null;
  return {
    method: "GET",
    host: dest?.host ?? target.address,
    ...(dest ? {} : { family: target.family }),
    port: dest?.port ?? Number(PORTS[url.protocol]),
    path: (url.pathname || "/") + url.search,
    agent: false,
    headers: {
      Host: url.host,
      "User-Agent": USER_AGENT,
      Accept: "text/html,text/plain;q=0.9,application/pdf;q=0.8",
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Connection: "close",
    },
    ...(secure && !net.isIP(plainName) ? { servername: plainName } : {}),
  };
}
function requestOnce(url, target, { signal, route }) {
  return new Promise((resolve, reject) => {
    const options = { ...requestOptions(url, target, route), signal };
    const req = (url.protocol === "https:" ? https : http).request(options, resolve);
    req.on("error", reject);
    req.end();
  });
}
function readBody(res, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    res.on("data", (chunk) => {
      size += chunk.length;
      if (size > LINK_LIMITS.maxBytes) {
        res.destroy();
        reject(linkError("link_too_large"));
        return;
      }
      chunks.push(chunk);
    });
    let ended = false;
    res.on("end", () => {
      ended = true;
      resolve(Buffer.concat(chunks));
    });
    res.on("error", reject);
    res.on("close", () => {
      if (!ended) reject(signal?.aborted ? linkError("link_timeout") : linkError("link_unreachable"));
    });
  });
}
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

// Fetches `input`, following up to 3 redirects, and returns
// { url (the final URL, tracking parameters removed), type, charset, body,
//   redirects }. `lookup`, `route` and a shorter `timeoutMs` are for tests.
export async function fetchLink(
  input,
  { lookup = systemLookup, route = null, timeoutMs = LINK_LIMITS.timeoutMs } = {},
) {
  const controller = new AbortController();
  const deadline = new Promise((_, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(linkError("link_timeout"));
    }, Math.min(timeoutMs, LINK_LIMITS.timeoutMs));
    timer.unref?.();
    controller.signal.addEventListener("abort", () => clearTimeout(timer));
  });
  deadline.catch(() => {});
  const run = async () => {
    let url = checkUrl(input);
    for (let hop = 0; ; hop++) {
      const targets = await Promise.race([vetHost(url.hostname, lookup), deadline]);
      let res,
        failure;
      // Each vetted address in turn (IPv4 first), only on connection errors.
      for (const target of targets.slice(0, 3)) {
        try {
          res = await Promise.race([requestOnce(url, target, { signal: controller.signal, route }), deadline]);
          break;
        } catch (e) {
          if (e instanceof LinkError) throw e;
          failure = e;
          if (controller.signal.aborted) throw linkError("link_timeout");
        }
      }
      if (!res) throw failure instanceof LinkError ? failure : linkError("link_unreachable");
      if (REDIRECTS.has(res.statusCode)) {
        const location = res.headers.location;
        // A redirect's own body is never read.
        res.destroy();
        if (!location) throw linkError("link_status");
        if (hop >= LINK_LIMITS.maxRedirects) throw linkError("link_redirects");
        url = checkUrl(String(location), url);
        continue;
      }
      if (res.statusCode < 200 || res.statusCode > 299) {
        res.destroy();
        throw Object.assign(linkError("link_status"), {
          message: `The site answered ${res.statusCode} instead of the page.`,
        });
      }
      const { type, charset } = mediaType(res.headers["content-type"]);
      if (!ACCEPTED_TYPES.includes(type)) {
        res.destroy();
        throw linkError("link_type");
      }
      const declared = Number(res.headers["content-length"]);
      if (Number.isFinite(declared) && declared > LINK_LIMITS.maxBytes) {
        res.destroy();
        throw linkError("link_too_large");
      }
      const raw = await Promise.race([readBody(res, controller.signal), deadline]);
      const body = decode(raw, res.headers["content-encoding"]);
      if (body.length > LINK_LIMITS.maxBytes) throw linkError("link_too_large");
      return { url, type, charset, body, redirects: hop };
    }
  };
  try {
    return await run();
  } catch (e) {
    if (e instanceof LinkError) throw e;
    if (controller.signal.aborted) throw linkError("link_timeout");
    throw linkError("link_unreachable");
  } finally {
    controller.abort();
  }
}

// The body as text: the header's charset, else a BOM or an HTML <meta>
// charset in the first 4 KB, else UTF-8. Unknown labels fall back to UTF-8.
export function bodyText(body, { type, charset }) {
  let label = charset;
  if (body[0] === 0xef && body[1] === 0xbb && body[2] === 0xbf) label = "utf-8";
  else if (body[0] === 0xff && body[1] === 0xfe) label = "utf-16le";
  else if (body[0] === 0xfe && body[1] === 0xff) label = "utf-16be";
  else if (!label && type === "text/html") {
    const head = body.subarray(0, 4096).toString("latin1");
    label =
      /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1]?.toLowerCase() || null;
  }
  let decoder;
  try {
    decoder = new TextDecoder(label || "utf-8");
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(body);
}
