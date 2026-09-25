import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  createHash,
  sign as edSign,
  verify as edVerify,
} from "node:crypto";
import { now, hash } from "./core.js";
import { canonical } from "./auth.js";
import { isReleased } from "./releases.js";

// Bytes actually signed/verified: sorted-key JSON, so field order never
// changes the signature. Reuses the IPN payload's canonicalization helper.
export function canonicalBytes(payload) {
  return Buffer.from(JSON.stringify(canonical(payload)));
}
// The raw 32-byte Ed25519 public key, read via its JWK "x" coordinate
// (base64url) rather than parsing the SPKI DER wrapper by hand.
function rawPublicKey(publicKey) {
  return Buffer.from(publicKey.export({ format: "jwk" }).x, "base64url");
}
// Short, stable fingerprint clients can use to pick the right public key.
function keyIdFor(publicKey) {
  return createHash("sha256").update(rawPublicKey(publicKey)).digest("hex").slice(0, 16);
}
function derivedMaterial(privateKey) {
  const publicKey = createPublicKey(privateKey);
  const keyId = keyIdFor(publicKey);
  return {
    keyId,
    privateKey,
    publicKey,
    publicKeyPem: publicKey.export({ format: "pem", type: "spki" }),
    jwk: {
      ...publicKey.export({ format: "jwk" }),
      kid: keyId,
      use: "sig",
      alg: "EdDSA",
    },
  };
}
function finalize({ keyId, privateKey, publicKey, publicKeyPem, jwk }) {
  return {
    keyId,
    algorithm: "Ed25519",
    publicKey,
    publicKeyPem,
    jwk,
    sign: (payload) => edSign(null, canonicalBytes(payload), privateKey).toString("base64"),
  };
}
function privateKeyFromDer(base64Der) {
  return createPrivateKey({
    key: Buffer.from(base64Der, "base64"),
    format: "der",
    type: "pkcs8",
  });
}
// The signing key for receipts: RECEIPT_SIGNING_KEY (base64 PKCS8 DER) when
// set, else the first key ever generated for this database. A missing key
// is created on first use and persisted so later restarts, and every other
// receipt already issued, keep verifying against the same key. Running
// without RECEIPT_SIGNING_KEY on a database that gets replaced (a restore,
// a fresh volume) silently starts a new key lineage — set the env var in
// production so the key survives independently of the database.
export function createReceiptSigner(db, cfg) {
  if (cfg.receiptSigningKey) {
    let privateKey;
    try {
      privateKey = privateKeyFromDer(cfg.receiptSigningKey);
    } catch {
      throw Error(
        "RECEIPT_SIGNING_KEY must be a base64 PKCS8 DER Ed25519 private key.",
      );
    }
    if (privateKey.asymmetricKeyType !== "ed25519")
      throw Error("RECEIPT_SIGNING_KEY must be an Ed25519 private key.");
    return finalize(derivedMaterial(privateKey));
  }
  const existing = db
    .prepare("SELECT * FROM receipt_keys ORDER BY created ASC, id ASC LIMIT 1")
    .get();
  if (!existing) {
    const generated = generateKeyPairSync("ed25519");
    const material = derivedMaterial(generated.privateKey);
    db.prepare(
      "INSERT OR IGNORE INTO receipt_keys(id,public_key,private_key,created) VALUES(?,?,?,?)",
    ).run(
      material.keyId,
      material.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
      generated.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
      now(),
    );
  }
  // Re-read rather than trust the just-generated key: another process may
  // have inserted first, and every caller must end up signing with whatever
  // row actually won so receipts stay verifiable against each other.
  const row = db
    .prepare("SELECT * FROM receipt_keys ORDER BY created ASC, id ASC LIMIT 1")
    .get();
  return finalize(derivedMaterial(privateKeyFromDer(row.private_key)));
}
// The public key for a receipt's key_id: the active signer, or a
// previously-generated database key (lets old receipts keep verifying after
// RECEIPT_SIGNING_KEY is introduced or rotated).
export function resolvePublicKey(db, signer, keyId) {
  if (typeof keyId !== "string" || !keyId) return null;
  if (keyId === signer.keyId) return signer.publicKey;
  const row = db.prepare("SELECT public_key FROM receipt_keys WHERE id=?").get(keyId);
  if (!row) return null;
  try {
    return createPublicKey({
      key: Buffer.from(row.public_key, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    return null;
  }
}
export function verifyPayloadSignature(payload, signatureBase64, publicKey) {
  try {
    const signature = Buffer.from(String(signatureBase64), "base64");
    if (!signature.length) return false;
    return edVerify(null, canonicalBytes(payload), publicKey, signature);
  } catch {
    return false;
  }
}
// The canonical receipt payload for a settled chat request. Never include
// identifying fields (username, email, wallet, user id) here — the id is
// the per-request reference already used by /api/requests/:id, not the
// user-prefixed hold id.
export function buildReceiptPayload({
  id,
  service,
  model,
  inputTokens,
  outputTokens,
  creditsCharged,
  creditsReleased,
  keyId,
  requestMessages,
  answerText,
}) {
  return {
    v: 1,
    id,
    issued: new Date().toISOString(),
    service,
    model,
    usage: {
      input_tokens: Number(inputTokens) || 0,
      output_tokens: Number(outputTokens) || 0,
    },
    credits_charged: creditsCharged,
    credits_released: creditsReleased,
    request_sha256: hash(JSON.stringify(canonical(requestMessages))),
    response_sha256: hash(answerText || ""),
    key_id: keyId,
  };
}
// The canonical receipt payload for a settled /v1 media request. Same v1
// envelope and signer as a chat receipt, so /api/receipts/verify checks it
// unchanged. Media isn't billed by tokens, so it carries kind (image,
// speech, transcription or video) instead of usage. request_sha256 covers
// the billed request (model, prompt or input, options; an uploaded file by
// its sha256) and response_sha256 the delivered output: a transcript's text,
// or the bytes of the delivered file(s) in order.
export function buildMediaReceiptPayload({
  id,
  service,
  model,
  kind,
  request,
  output,
  creditsCharged,
  creditsReleased,
  keyId,
}) {
  const response = createHash("sha256");
  for (const part of [].concat(output ?? "")) response.update(part);
  return {
    v: 1,
    id,
    issued: new Date().toISOString(),
    service,
    model,
    kind,
    credits_charged: creditsCharged,
    credits_released: creditsReleased,
    request_sha256: hash(JSON.stringify(canonical(request))),
    response_sha256: response.digest("hex"),
    key_id: keyId,
  };
}
// Sign a settled /v1 media request's receipt and keep a copy under its hold
// (so GET /api/receipts/:id finds it), as the chat path does. Only once the
// receipts update is released. Best effort: the request is already settled,
// so a signing failure never costs the caller what they paid for.
// `output` may be a function, so reading a saved file happens inside that
// best-effort guard too.
export function issueMediaReceipt(
  { db, cfg, receipts },
  { hold, user, requestId, receipt, output, ...fields },
) {
  if (!isReleased(cfg, "receipts")) return null;
  try {
    const payload = buildMediaReceiptPayload({
      id: requestId,
      service: cfg.publicUrl || cfg.origin,
      creditsCharged: receipt.credits_charged,
      creditsReleased: receipt.released,
      keyId: receipts.keyId,
      output: typeof output === "function" ? output() : output,
      ...fields,
    });
    const signature = receipts.sign(payload);
    db.prepare(
      "INSERT OR IGNORE INTO receipt_signatures(receipt_id,user_id,key_id,payload,signature,created) VALUES(?,?,?,?,?,?)",
    ).run(hold, user, receipts.keyId, JSON.stringify(payload), signature, now());
    return { receipt: payload, signature, key_id: receipts.keyId };
  } catch (e) {
    console.error("Receipt signing failed:", e.message);
    return null;
  }
}
