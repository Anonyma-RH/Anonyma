import http from "node:http";
import https from "node:https";
import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
} from "node:crypto";
import { checkUrl, vetHost, systemLookup, requestOptions, LinkError } from "./link-reader.js";
import { pushService } from "../src/push-alerts.js";

// Web Push, the protocol half of Push Alerts (server/push-alerts.js), with
// node:crypto only:
// - RFC 8292 (VAPID): each request carries a JWT signed with ES256 by the
//   installation's key (VAPID_PRIVATE_KEY), for the push service's origin,
//   valid for 12 hours, naming VAPID_SUBJECT (a mailto: or https: contact),
//   and the matching public key (VAPID_PUBLIC_KEY).
// - RFC 8291 + RFC 8188 (aes128gcm): the message is encrypted for the one
//   browser that subscribed (its P-256 key and 16-byte auth secret) with a
//   fresh key pair and salt per message, in one record, padded to a fixed
//   size so every notification has the same length.
// - The request goes only to a known push service (Google, Mozilla, Apple or
//   Microsoft: pushService in src/push-alerts.js), over HTTPS, to an address
//   Link Reader's checks allow (checkUrl, then vetHost: public addresses
//   only, the connection pinned to the vetted address with the name as SNI).
//   No Topic header and one TTL and Urgency for every message, so the push
//   service can't tell one kind of notification from another.
// Nothing here logs an endpoint, a key or a payload.

const P256 = "prime256v1";
// The fixed size every payload is padded to (plaintext + delimiter).
export const PAD_TO = 512;
// Record size in the header: one record holds a padded payload and its tag.
export const RECORD_SIZE = 4096;
// Every message lives for 4 days at the push service, at normal urgency.
export const PUSH_TTL_SECONDS = 4 * 24 * 3600;
export const JWT_SECONDS = 12 * 3600;
const TIMEOUT_MS = 10_000;

// ---- base64url ----

// Strict: the URL-safe alphabet only, optional trailing "=" padding.
export function fromB64u(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*={0,2}$/.test(value)) return null;
  return Buffer.from(value.replace(/=+$/, ""), "base64url");
}
export const toB64u = (bytes) => Buffer.from(bytes).toString("base64url");

// ---- Keys ----

// A P-256 public key as the 65-byte uncompressed point (0x04 || x || y), or
// null when it isn't one on the curve.
export function validPoint(bytes) {
  if (!bytes || bytes.length !== 65 || bytes[0] !== 4) return false;
  try {
    createPublicKey({
      key: { kty: "EC", crv: "P-256", x: toB64u(bytes.subarray(1, 33)), y: toB64u(bytes.subarray(33)) },
      format: "jwk",
    });
    return true;
  } catch {
    return false;
  }
}
export const publicKeyObject = (raw) =>
  createPublicKey({
    key: { kty: "EC", crv: "P-256", x: toB64u(raw.subarray(1, 33)), y: toB64u(raw.subarray(33)) },
    format: "jwk",
  });

// The installation's VAPID keys from the configuration, or null (the reason
// in `problem`) when they're missing or don't form a key pair. The public
// key is the uncompressed point and the private key the 32-byte scalar,
// both base64url, as `node scripts/vapid-keys.mjs` prints them.
export function vapidKeys(cfg) {
  const pub = String(cfg.vapidPublicKey || "").trim();
  const priv = String(cfg.vapidPrivateKey || "").trim();
  const subject = String(cfg.vapidSubject || "").trim();
  if (!pub && !priv && !subject) return { keys: null, problem: "missing" };
  const publicRaw = fromB64u(pub);
  const privateRaw = fromB64u(priv);
  if (!publicRaw || !validPoint(publicRaw) || !privateRaw || privateRaw.length !== 32)
    return { keys: null, problem: "invalid_keys" };
  // The subject is how a push service reaches the operator: a mailto: or
  // https: URL (RFC 8292 section 2.1).
  if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/[^\s]+)$/i.test(subject))
    return { keys: null, problem: "invalid_subject" };
  let privateKey;
  try {
    const ecdh = createECDH(P256);
    ecdh.setPrivateKey(privateRaw);
    if (!ecdh.getPublicKey().equals(publicRaw)) return { keys: null, problem: "mismatch" };
    privateKey = createPrivateKey({
      key: {
        kty: "EC",
        crv: "P-256",
        d: toB64u(privateRaw),
        x: toB64u(publicRaw.subarray(1, 33)),
        y: toB64u(publicRaw.subarray(33)),
      },
      format: "jwk",
    });
  } catch {
    return { keys: null, problem: "invalid_keys" };
  }
  return { keys: { publicKey: toB64u(publicRaw), publicRaw, privateKey, subject }, problem: null };
}

// A fresh VAPID key pair, as the environment takes it.
export function generateVapidKeys() {
  const ecdh = createECDH(P256);
  ecdh.generateKeys();
  return { publicKey: toB64u(ecdh.getPublicKey()), privateKey: toB64u(ecdh.getPrivateKey()) };
}

// ---- VAPID (RFC 8292) ----

// The JWS signing input for these claims. The member order is fixed so the
// same claims always give the same token text.
export function vapidSigningInput({ aud, exp, sub }) {
  const header = toB64u(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = toB64u(Buffer.from(JSON.stringify({ aud, exp, sub })));
  return `${header}.${body}`;
}
// The JWT for one push service origin: ES256, the signature as r || s.
export function vapidToken(keys, audience, nowMs) {
  const input = vapidSigningInput({
    aud: audience,
    exp: Math.floor(nowMs / 1000) + JWT_SECONDS,
    sub: keys.subject,
  });
  const signature = sign("sha256", Buffer.from(input), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `${input}.${toB64u(signature)}`;
}
export const vapidAuthorization = (keys, audience, nowMs) =>
  `vapid t=${vapidToken(keys, audience, nowMs)}, k=${keys.publicKey}`;

// ---- Encryption (RFC 8188, RFC 8291) ----

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
// HKDF-Expand for one block (up to 32 bytes), as both RFCs use it.
const expand = (prk, info, length) => hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
const CEK_INFO = Buffer.from("Content-Encoding: aes128gcm\0");
const NONCE_INFO = Buffer.from("Content-Encoding: nonce\0");

// RFC 8188 with a single record: the header (salt, record size, key id)
// followed by the record, which is the plaintext, the 0x02 delimiter and
// `pad` zero octets, sealed with AES-128-GCM.
export function encryptRecord({ ikm, salt, keyid = Buffer.alloc(0), rs = RECORD_SIZE, plaintext, pad = 0 }) {
  if (salt.length !== 16) throw Error("The salt must be 16 bytes.");
  if (plaintext.length + 1 + pad + 16 > rs) throw Error("The payload doesn't fit in one record.");
  const prk = hmac(salt, ikm);
  const cek = expand(prk, CEK_INFO, 16);
  const nonce = expand(prk, NONCE_INFO, 12);
  const header = Buffer.alloc(21 + keyid.length);
  salt.copy(header, 0);
  header.writeUInt32BE(rs, 16);
  header[20] = keyid.length;
  keyid.copy(header, 21);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2]), Buffer.alloc(pad)])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return Buffer.concat([header, sealed]);
}

// RFC 8291: the message for one subscription. `uaPublic` is the browser's
// p256dh (65 bytes) and `authSecret` its auth (16 bytes). `asPrivate` and
// `salt` are for test vectors only; each message otherwise gets a new
// key pair and salt.
export function encryptPush({ uaPublic, authSecret, plaintext, padTo = 0, asPrivate, salt }) {
  const ecdh = createECDH(P256);
  if (asPrivate) ecdh.setPrivateKey(asPrivate);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, secret);
  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]);
  const ikm = expand(prkKey, keyInfo, 32);
  const body = Buffer.from(plaintext);
  const pad = padTo ? Math.max(0, padTo - body.length - 1) : 0;
  return encryptRecord({ ikm, salt: salt || randomBytes(16), keyid: asPublic, plaintext: body, pad });
}

// ---- Sending ----

export class PushError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The endpoint a subscription may use: https, a known push service, and
// unchanged by Link Reader's URL checks (which also refuse private hosts,
// odd ports and credentials). Returns { url, service } or throws PushError.
export function checkEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2048)
    throw new PushError("push_endpoint", "That isn't a push subscription this browser can use.");
  let url, plain;
  try {
    url = checkUrl(endpoint);
    plain = new URL(endpoint);
  } catch {
    throw new PushError("push_endpoint", "That isn't a push subscription this browser can use.");
  }
  plain.hash = "";
  if (url.protocol !== "https:" || url.href !== plain.href)
    throw new PushError("push_endpoint", "That isn't a push subscription this browser can use.");
  const service = pushService(url.hostname);
  if (!service)
    throw new PushError(
      "push_service",
      "This browser uses a push service ANONYMA doesn't send to. Chrome, Edge, Firefox and Safari work.",
    );
  return { url, service };
}

// One POST to a push service. Resolves { status, retryAfter } (seconds or
// null) whatever the status; rejects only when no answer came (a refused
// address, DNS, the connection, 10 seconds). The response body is ignored.
// `hooks` (local test mode only): lookup replaces DNS, and route sends the
// vetted connection to a local test server ({ host, port, plain: true } for
// plain HTTP), after every check has run.
export async function postPush(endpoint, { headers, body }, hooks = {}) {
  const { url } = checkEndpoint(endpoint);
  const targets = await vetHost(url.hostname, hooks.lookup || systemLookup);
  let failure;
  for (const target of targets.slice(0, 3)) {
    try {
      return await once(url, target, { headers, body }, hooks.route || null);
    } catch (e) {
      failure = e;
    }
  }
  throw failure instanceof PushError ? failure : new PushError("push_unreachable", "The push service didn't answer.");
}

function once(url, target, { headers, body }, route) {
  return new Promise((resolve, reject) => {
    const dest = route ? route(target.address, 443) : null;
    const base = requestOptions(url, target, dest ? () => dest : null);
    const options = {
      ...base,
      method: "POST",
      headers: {
        Host: url.host,
        "User-Agent": "ANONYMA-Push/1.0",
        "Content-Length": body.length,
        Connection: "close",
        ...headers,
      },
    };
    const req = (dest?.plain ? http : https).request(options, (res) => {
      const retry = Number(res.headers["retry-after"]);
      res.resume();
      res.on("error", () => {});
      resolve({ status: res.statusCode, retryAfter: Number.isFinite(retry) && retry > 0 ? retry : null });
    });
    const timer = setTimeout(() => req.destroy(new PushError("push_timeout", "The push service took too long.")), TIMEOUT_MS);
    timer.unref?.();
    req.on("close", () => clearTimeout(timer));
    req.on("error", (e) => reject(e instanceof LinkError ? new PushError("push_unreachable", e.message) : e));
    req.end(body);
  });
}

// Everything for one message to one subscription: the encrypted body and
// the headers RFC 8030, 8291 and 8292 ask for.
export function pushRequest(keys, sub, payload, nowMs, test = {}) {
  const { url } = checkEndpoint(sub.endpoint);
  const body = encryptPush({
    uaPublic: fromB64u(sub.p256dh),
    authSecret: fromB64u(sub.auth),
    plaintext: Buffer.from(JSON.stringify(payload)),
    padTo: PAD_TO,
    ...test,
  });
  return {
    headers: {
      TTL: String(PUSH_TTL_SECONDS),
      Urgency: "normal",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: vapidAuthorization(keys, url.origin, nowMs),
    },
    body,
  };
}
