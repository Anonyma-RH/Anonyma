// Sealed Mode: the rules the browser and the server share. Pure and free of
// any crypto library, so the server can import it and node can test it; the
// encryption itself lives in src/sealed-client.js, which the workspace loads
// only when Sealed Mode is switched on.
//
// A sealed request is encrypted in the browser with EHBP (HPKE: X25519,
// HKDF-SHA256, AES-256-GCM) to a key that a hardware-attested enclave holds.
// ANONYMA's server relays the ciphertext to PPQ's private endpoint and the
// enclave's encrypted reply back, unread. Only PPQ's `private/*` models,
// labelled privacyLevel "e2e", run inside that enclave: for any other model
// the enclave would forward the prompt to the model's provider, so Sealed
// Mode never offers one.

export const SEALED_PREFIX = "private/";
// The enclave's published build: attestation is checked against this repo's
// Sigstore-signed release (the router that PPQ's /private endpoint fronts).
export const SEALED_CONFIG_REPO = "tinfoilsh/confidential-model-router";
// Tokens can't outnumber bytes (every token covers at least one byte), so the
// ciphertext length bounds the input. This covers the chat template's own
// tokens on top.
export const INPUT_OVERHEAD_TOKENS = 1024;
// The largest sealed request body the relay accepts: the service's 240,000
// character limit as 3-byte UTF-8, plus JSON and EHBP framing.
export const SEALED_MAX_BODY_BYTES = 1572864;
// EHBP frames a request body as a 4-byte length and one AES-GCM ciphertext
// (16-byte tag).
export const EHBP_REQUEST_OVERHEAD = 20;
// The server can't read max_tokens (it's encrypted), so it cuts a reply off
// once its ciphertext passes what the output cap could produce. A streamed
// token is about 250 bytes of JSON and framing; this allows twice that.
export const RESPONSE_BYTES_PER_TOKEN = 512;
export const RESPONSE_BYTES_OVERHEAD = 262144;
// The browser re-verifies the enclave once its last check is this old, and
// never sends on an older one. SNP reports carry no client nonce, so age is
// the only freshness bound there is.
export const MAX_BUNDLE_AGE_MS = 10 * 60 * 1000;
// A bundle whose enclave certificate was issued longer ago than this, or
// that has expired, is refused as stale.
export const MAX_CERT_AGE_DAYS = 90;

const finite = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;

// Only open-weight private models, which run inside the enclave.
export function isSealedModel(m) {
  return (
    m?.type === "chat" &&
    typeof m.id === "string" &&
    m.id.startsWith(SEALED_PREFIX) &&
    m.id.length > SEALED_PREFIX.length &&
    m.privacyLevel === "e2e" &&
    finite(m.pricing?.input_per_1M_tokens) &&
    finite(m.pricing?.output_per_1M_tokens)
  );
}
// The id the enclave knows the model by: "private/kimi-k3" -> "kimi-k3".
export const enclaveModelId = (id) => String(id).slice(SEALED_PREFIX.length);

// The EHBP ciphertext length for a plaintext body of `bytes` bytes.
export const ciphertextLength = (bytes) => bytes + EHBP_REQUEST_OVERHEAD;

// The most a sealed request can cost at the model's catalog price, in USD:
// every ciphertext byte as an input token, plus the full output cap.
export function sealedHoldUsd(m, ciphertextBytes, outputCap) {
  const input = ciphertextBytes + INPUT_OVERHEAD_TOKENS;
  return (
    (m.pricing.input_per_1M_tokens * input +
      m.pricing.output_per_1M_tokens * outputCap) /
    1e6
  );
}
// The ciphertext the relay lets through for a reply capped at `outputCap`.
export const responseByteCap = (outputCap) =>
  outputCap * RESPONSE_BYTES_PER_TOKEN + RESPONSE_BYTES_OVERHEAD;

// The plaintext request the browser seals: the enclave's model id, the
// messages, the capped reply budget and a per-tab prompt-cache secret. Every
// account shares ANONYMA's gateway key, so without that secret one person
// could time another's cached prompts; it travels inside the ciphertext.
export function sealedBody({ model, messages, maxTokens, cacheSecret }) {
  return {
    model: enclaveModelId(model),
    messages,
    max_tokens: maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    ...(cacheSecret ? { user_cache_secret: cacheSecret } : {}),
  };
}
// Bytes of a string as UTF-8.
export const utf8Length = (text) => new TextEncoder().encode(text).length;

// Tinfoil's usage record, sent as the X-Tinfoil-Usage-Metrics trailer on a
// streamed reply: "prompt=67,completion=42,total=109,model=gpt-oss-120b,
// cost_usd=0.000042". Read as a map (fields may be added anywhere); null
// unless prompt, completion and total are all whole numbers.
export function parseUsageMetrics(value) {
  if (typeof value !== "string" || !value || value.length > 2000) return null;
  const map = {};
  for (const part of value.split(",")) {
    const i = part.indexOf("=");
    if (i < 1) return null;
    const key = part.slice(0, i).trim();
    if (!/^[a-z_]{1,40}$/.test(key) || key in map) return null;
    map[key] = part.slice(i + 1).trim();
  }
  const whole = (s) => (/^\d{1,10}$/.test(s ?? "") ? Number(s) : null);
  const prompt = whole(map.prompt),
    completion = whole(map.completion),
    total = whole(map.total);
  if (prompt == null || completion == null || total == null) return null;
  const cost = /^\d{1,6}(\.\d{1,12})?$/.test(map.cost_usd ?? "")
    ? Number(map.cost_usd)
    : null;
  return {
    prompt,
    completion,
    total,
    model: /^[\w./:-]{1,120}$/.test(map.model ?? "") ? map.model : null,
    cost_usd: cost,
  };
}

// ---- What the verification panel shows ----

// The enclave's hardware, from its measurement type.
export function hardwareName(type) {
  const t = String(type || "");
  if (/sev-snp/i.test(t)) return "AMD SEV-SNP";
  if (/tdx/i.test(t)) return "Intel TDX";
  return "Unknown hardware";
}

// Minimal DER reading, enough for two certificate fields the verifier
// doesn't hand back: the enclave certificate's validity and the source
// commit in the Sigstore signing certificate. Both certificates are the ones
// the verifier has just checked.
function tlv(bytes, pos) {
  if (pos + 2 > bytes.length) throw Error("Truncated certificate.");
  const tag = bytes[pos];
  let len = bytes[pos + 1],
    start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n < 1 || n > 4) throw Error("Unsupported certificate length.");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + bytes[start + i];
    start += n;
  }
  const end = start + len;
  if (end > bytes.length) throw Error("Truncated certificate.");
  return { tag, start, end };
}
function children(bytes, node) {
  const out = [];
  for (let p = node.start; p < node.end; ) {
    const c = tlv(bytes, p);
    out.push(c);
    p = c.end;
  }
  return out;
}
function oidOf(bytes, node) {
  const v = bytes.subarray(node.start, node.end);
  const parts = [Math.floor(v[0] / 40), v[0] % 40];
  let n = 0;
  for (let i = 1; i < v.length; i++) {
    n = n * 128 + (v[i] & 0x7f);
    if (!(v[i] & 0x80)) {
      parts.push(n);
      n = 0;
    }
  }
  return parts.join(".");
}
const text = (bytes, node) => new TextDecoder().decode(bytes.subarray(node.start, node.end));
function derTime(bytes, node) {
  const s = text(bytes, node);
  const m =
    node.tag === 0x17
      ? /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s)
      : /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  if (!m) throw Error("Unsupported certificate time.");
  let year = Number(m[1]);
  if (node.tag === 0x17) year += year < 50 ? 2000 : 1900;
  return Date.UTC(year, m[2] - 1, m[3], m[4], m[5], m[6]);
}
const fromBase64 = (b64) =>
  Uint8Array.from(atob(String(b64).replace(/\s+/g, "")), (c) => c.charCodeAt(0));
const tbsFields = (der) => children(der, children(der, tlv(der, 0))[0]);

// { notBefore, notAfter } in epoch ms, from a PEM certificate.
export function certificateValidity(pem) {
  const der = fromBase64(String(pem).replace(/-----[^-]+-----/g, ""));
  const fields = tbsFields(der);
  // Skip the optional [0] version; then serial, signature, issuer, validity.
  const validity = fields[fields[0].tag === 0xa0 ? 4 : 3];
  const [notBefore, notAfter] = children(der, validity);
  return { notBefore: derTime(der, notBefore), notAfter: derTime(der, notAfter) };
}

// Fulcio's source-repository extensions (OID 1.3.6.1.4.1.57264.1.x) in the
// Sigstore certificate that signed the enclave's release.
const FULCIO = "1.3.6.1.4.1.57264.1.";
export function sigstoreSource(sigstoreBundle) {
  const raw = sigstoreBundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof raw !== "string") return null;
  const der = fromBase64(raw);
  const wrap = tbsFields(der).find((f) => f.tag === 0xa3);
  if (!wrap) return null;
  const values = {};
  for (const ext of children(der, children(der, wrap)[0])) {
    const parts = children(der, ext);
    const id = oidOf(der, parts[0]);
    if (!id.startsWith(FULCIO)) continue;
    const inner = der.subarray(parts.at(-1).start, parts.at(-1).end);
    // Newer extensions wrap a UTF8String; the legacy ones hold raw text.
    values[id.slice(FULCIO.length)] =
      inner[0] === 0x0c ? text(inner, tlv(inner, 0)) : new TextDecoder().decode(inner);
  }
  const repository = values["12"] || (values["5"] ? "https://github.com/" + values["5"] : null);
  const commit = values["13"] || values["3"] || null;
  const ref = values["14"] || values["6"] || null;
  return repository && commit ? { repository, commit, ref } : null;
}

// Why a bundle is too old (or not yet valid) to use, or null when it's fine.
export function bundleAgeProblem(bundle, at, maxCertAgeDays = MAX_CERT_AGE_DAYS) {
  let v;
  try {
    v = certificateValidity(bundle?.enclaveCert);
  } catch {
    return "The enclave's certificate couldn't be read.";
  }
  if (at < v.notBefore - 300000) return "The enclave's certificate isn't valid yet.";
  if (at > v.notAfter) return "The enclave's certificate has expired.";
  if (at - v.notBefore > maxCertAgeDays * 86400000)
    return "The enclave's attestation is older than the maximum age.";
  return null;
}

// ---- Features Sealed Mode turns off, and why (one line each) ----
export const SEALED_OFF = [
  { id: "memory", text: "Memory is off: saved facts are added on our server, which only sees ciphertext." },
  { id: "search", text: "Web search is off: the search would run outside the enclave." },
  { id: "files", text: "Saved files are off: they're read on our server. Documents you attach are read in your browser and stay sealed." },
  { id: "scrolls", text: "Saving scrolls is off: it stores text on our server. Inserting your scrolls still works." },
  { id: "doublecheck", text: "Double-check and Symposium are off: they send the chat to models outside the enclave." },
  { id: "voice", text: "Voice and read aloud are off: audio is processed outside the enclave." },
  { id: "estimate", text: "The live estimate is off: it would send your prompt unsealed. The most it can cost is shown instead." },
];
