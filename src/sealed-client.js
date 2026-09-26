// Sealed Mode in the browser: verify the enclave, encrypt the request, decrypt
// the reply. Loaded only when Sealed Mode is switched on (it brings the
// official Tinfoil verifier and EHBP client, about 85 KB gzipped).
//
// It fails closed. Nothing is sent unless, moments before, this browser has
// itself verified the enclave's attestation: the AMD SEV-SNP report against
// AMD's roots, the Sigstore-signed release of the enclave's code, and the
// certificate binding the HPKE key to both. The server only relays the
// bundle, so it can't vouch for anything; a bundle that fails, is too old or
// comes from another repository stops the send.
import { Verifier } from "tinfoil";
import { Identity, Transport, KeyConfigMismatchError } from "ehbp";
import {
  SEALED_CONFIG_REPO,
  MAX_BUNDLE_AGE_MS,
  bundleAgeProblem,
  certificateValidity,
  sigstoreSource,
  hardwareName,
  sealedBody,
} from "./sealed.js";
import { readChatEvents } from "./stream.js";

export class SealedError extends Error {
  constructor(message, code, extra = {}) {
    super(message);
    this.name = "SealedError";
    this.code = code;
    Object.assign(this, extra);
  }
}
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const newId = () => hex(crypto.getRandomValues(new Uint8Array(16)));
// One prompt-cache secret per page (see sealedBody in src/sealed.js).
let cacheSecret = null;
const secret = () => (cacheSecret ||= hex(crypto.getRandomValues(new Uint8Array(32))));
const NOTHING_SENT = "Nothing was sent.";

// The official verifier: SEV-SNP report, Sigstore release, key binding.
export async function verifyBundle(bundle) {
  const verifier = new Verifier({ configRepo: SEALED_CONFIG_REPO });
  const result = await verifier.verifyBundle(bundle);
  return { hpkePublicKey: result.hpkePublicKey, document: verifier.getVerificationDocument() };
}

// Fetches the bundle through ANONYMA's relay and verifies it here. Returns
// what the verification panel shows and the key to encrypt to, or throws a
// SealedError (code "attestation_failed" or "attestation_unavailable").
export async function attest({
  origin = globalThis.location?.origin,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  verify = verifyBundle,
  headers = {},
  fresh = false,
} = {}) {
  let bundle;
  try {
    const r = await fetchImpl(`${origin}/api/sealed/attestation${fresh ? "?fresh=1" : ""}`, {
      credentials: "same-origin",
      headers,
    });
    if (!r.ok) throw Error(String(r.status));
    bundle = await r.json();
  } catch {
    throw new SealedError(
      `The enclave's attestation couldn't be fetched. ${NOTHING_SENT}`,
      "attestation_unavailable",
    );
  }
  const at = now();
  const failed = (why) =>
    new SealedError(`${why} ${NOTHING_SENT}`, "attestation_failed");
  const stale = bundleAgeProblem(bundle, at);
  if (stale) throw failed(stale);
  let result;
  try {
    result = await verify(bundle);
  } catch {
    throw failed("The enclave failed verification.");
  }
  const doc = result?.document;
  if (
    !doc?.securityVerified ||
    typeof result.hpkePublicKey !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.hpkePublicKey) ||
    doc.hpkePublicKey !== result.hpkePublicKey ||
    doc.configRepo !== SEALED_CONFIG_REPO
  )
    throw failed("The enclave failed verification.");
  let source = null;
  try {
    source = sigstoreSource(bundle.sigstoreBundle);
  } catch {}
  if (!source || source.repository !== `https://github.com/${SEALED_CONFIG_REPO}`)
    throw failed("The enclave's code doesn't come from the expected repository.");
  const measurement = doc.enclaveMeasurement?.measurement || {};
  return {
    hpkePublicKey: result.hpkePublicKey,
    measurement: (measurement.registers || []).join(""),
    measurementType: measurement.type || "",
    hardware: hardwareName(measurement.type),
    codeFingerprint: doc.codeFingerprint,
    repository: SEALED_CONFIG_REPO,
    commit: source.commit,
    ref: source.ref,
    releaseTag: doc.releaseTag || null,
    releaseDigest: doc.releaseDigest,
    enclaveHost: doc.enclaveHost,
    verifier: doc.verifier ? `${doc.verifier.name} ${doc.verifier.version}` : null,
    certificate: certificateValidity(bundle.enclaveCert),
    verifiedAt: at,
  };
}

// A verification is used only while it's younger than the maximum age.
export const isFresh = (attestation, at = Date.now(), maxAge = MAX_BUNDLE_AGE_MS) =>
  !!attestation?.hpkePublicKey &&
  at >= attestation.verifiedAt &&
  at - attestation.verifiedAt < maxAge;

// Encrypts one chat request to the verified enclave, sends it through the
// relay and hands each decrypted stream event to onEvent. If the enclave has
// rotated its key (EHBP's key-config refusal; the relay released that hold),
// it verifies again and resends once under a new request id.
export async function sealedChat({
  attestation,
  reattest,
  origin = globalThis.location?.origin,
  model,
  messages,
  maxTokens,
  requestId = newId(),
  signal,
  onEvent,
  headers = {},
  now = Date.now,
}) {
  if (!isFresh(attestation, now()))
    throw new SealedError(
      `The enclave hasn't been verified recently. ${NOTHING_SENT}`,
      "attestation_failed",
    );
  const body = JSON.stringify(
    sealedBody({ model, messages, maxTokens, cacheSecret: secret() }),
  );
  const send = async (att, id) => {
    const transport = new Transport(
      await Identity.fromPublicKeyHex(att.hpkePublicKey),
      new URL(origin).host,
    );
    return transport.request(`${origin}/api/sealed/chat`, {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json",
        "X-Private-Model": model,
        "Idempotency-Key": id,
        ...headers,
      },
      body,
      signal,
    });
  };
  let id = requestId,
    response;
  try {
    response = await send(attestation, id);
  } catch (e) {
    if (!(e instanceof KeyConfigMismatchError) || !reattest) throw e;
    const next = await reattest();
    if (!isFresh(next, now()))
      throw new SealedError(`The enclave couldn't be verified again. ${NOTHING_SENT}`, "attestation_failed");
    id = newId();
    response = await send(next, id);
  }
  if (!response.ok) {
    let data = null;
    try {
      data = await response.json();
    } catch {}
    throw new SealedError(
      data?.error?.message || "Sealed Mode is unavailable right now.",
      data?.error?.code || "sealed_error",
      { status: response.status, data, requestId: id },
    );
  }
  try {
    for await (const event of readChatEvents(response)) onEvent(event);
  } catch (e) {
    e.requestId = id;
    throw e;
  }
  return { requestId: id };
}

// The request's charge once the relay has settled or held it.
export async function sealedBilling(
  requestId,
  { origin = globalThis.location?.origin, fetchImpl = globalThis.fetch, headers = {}, tries = 6, wait = 250 } = {},
) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchImpl(
        `${origin}/api/sealed/requests/${encodeURIComponent(requestId)}`,
        { credentials: "same-origin", headers },
      );
      if (r.ok) {
        const view = await r.json();
        if (view.status !== "relaying") return view;
      } else if (r.status === 404) return null;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  return null;
}
