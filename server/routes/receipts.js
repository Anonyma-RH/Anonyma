import { fail, hash } from "../core.js";
import { resolvePublicKey, verifyPayloadSignature } from "../receipts.js";

// Ed25519-signed chat receipts: the public key, an owner-scoped copy of a
// past receipt, and free-standing signature verification.
export function receiptRoutes(ctx) {
  const { app, db, cfg, limit, requireUser, receipts } = ctx;
  const keyInfo = () => ({
    key_id: receipts.keyId,
    algorithm: receipts.algorithm,
    public_key_pem: receipts.publicKeyPem,
    jwk: receipts.jwk,
  });
  app.get("/api/receipts/key", (req, res) => res.json(keyInfo()));
  app.get("/.well-known/anonyma-receipts.json", (req, res) =>
    res.json(keyInfo()),
  );
  // Mirrors GET /api/requests/:id: the path segment is the requestId alone
  // (never a user id), scoped to its owner by prefixing the signed-in user.
  app.get("/api/receipts/:id", requireUser, (req, res) => {
    const row = db
      .prepare("SELECT * FROM receipt_signatures WHERE receipt_id=? AND user_id=?")
      .get(req.user.id + ":" + req.params.id, req.user.id);
    if (!row) fail(404, "Receipt not found.");
    res.json({
      receipt: JSON.parse(row.payload),
      signature: row.signature,
      key_id: row.key_id,
    });
  });
  app.post(
    "/api/receipts/verify",
    limit("receipts_verify", 60, 60000),
    (req, res) => {
      const { receipt, signature, answer } = req.body;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt))
        fail(400, "Provide the signed receipt object.");
      if (typeof signature !== "string" || !signature)
        fail(400, "Provide the receipt's signature.");
      const keyId = receipt.key_id;
      const publicKey = resolvePublicKey(db, receipts, keyId);
      if (!publicKey) {
        res.json({ valid: false, key_id: keyId ?? null, reason: "unknown_key" });
        return;
      }
      const valid = verifyPayloadSignature(receipt, signature, publicKey);
      const result = {
        valid,
        key_id: keyId,
        ...(valid ? {} : { reason: "invalid_signature" }),
      };
      if (typeof answer === "string" && answer.length)
        result.answer_matches = hash(answer) === receipt.response_sha256;
      res.json(result);
    },
  );
}
