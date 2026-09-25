import { api } from "./lib.js";

// A signed receipt is passed to /verify through sessionStorage (not the URL,
// which would put usage details in browser history) rather than app state,
// so the prefill survives the navigation and works from a fresh tab too.
const PREFILL_KEY = "anonyma:verify-prefill";

export function copyableReceipt(signedReceipt) {
  return JSON.stringify(
    { receipt: signedReceipt.receipt, signature: signedReceipt.signature },
    null,
    2,
  );
}
export function stashForVerify(signedReceipt) {
  try {
    sessionStorage.setItem(PREFILL_KEY, copyableReceipt(signedReceipt));
    return true;
  } catch {
    return false;
  }
}
// One-time read: a later visit to /verify starts blank again.
export function takeVerifyPrefill() {
  try {
    const value = sessionStorage.getItem(PREFILL_KEY);
    if (value) sessionStorage.removeItem(PREFILL_KEY);
    return value || "";
  } catch {
    return "";
  }
}
export async function verifyReceipt(receiptText, answer) {
  let parsed;
  try {
    parsed = JSON.parse(receiptText);
  } catch {
    throw new Error("That isn't valid JSON. Paste the signed receipt as copied.");
  }
  const { receipt, signature } = parsed;
  if (!receipt || typeof receipt !== "object" || typeof signature !== "string")
    throw new Error('Expected an object with "receipt" and "signature".');
  return api("/api/receipts/verify", {
    method: "POST",
    body: { receipt, signature, ...(answer ? { answer } : {}) },
  });
}
