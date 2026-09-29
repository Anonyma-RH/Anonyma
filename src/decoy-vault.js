// Decoy Vault: a second passphrase that opens a separate, harmless vault
// instead of the real one, for when someone makes you unlock Device Vault.
//
// The decoy is an independent Device Vault in its own IndexedDB database
// (altStore in src/device-vault-store.js): its own salt, verifier, key and
// sealed chats, started with a few ordinary sample chats the person can
// continue or delete. Nothing links the two vaults: neither one's key opens
// the other's verifier or records, and neither is ever written with the
// other's key.
//
// Unlocking looks and costs the same whichever passphrase is typed. Once
// released, every unlock derives two keys in parallel with the same KDF
// parameters (the decoy's slot, or a stand-in with a random salt and a
// verifier nothing opens when no decoy is set), then checks both verifiers.
// So the real passphrase, the decoy's, a wrong one, and a vault with or
// without a decoy all do the same work, and nothing shown while a vault is
// unlocked says which one it is.
//
// Pure WebCrypto and data: no React, no storage, no network, so tests run it
// on Node's WebCrypto.
import { isReleased } from "./lib.js";
import {
  vaultReleased,
  createVault,
  deriveVaultKey,
  keyOpensVerifier,
  sealChat,
  passphraseProblem,
  fromBase64,
  toBase64,
  randomBytes,
  VaultError,
  VAULT_ERRORS,
  VAULT_FORMAT,
  VAULT_VERSION,
  VERIFIER_TEXT,
  SALT_BYTES,
  IV_BYTES,
  MIN_ITERATIONS,
  MAX_ITERATIONS,
  IDLE_CHOICES,
  DEFAULT_IDLE_MINUTES,
} from "./device-vault.js";

// Browser only, layered on Device Vault: nothing on the server to gate.
export const decoyReleased = (config) => vaultReleased(config) && isReleased(config, "decoy");

// The honest limits, shown wherever a decoy passphrase is set or changed.
export const DECOY_LIMITS = [
  "Someone who examines this browser's storage closely could tell that two vaults exist.",
  "Vault Sync syncs only your real vault. The decoy stays on this device, and while it's open, sync is paused and shows as off.",
  "Your ledger still lists every message's charge, from either vault.",
  "It deters casual pressure. It isn't proof against an expert: for example, inside the decoy a decoy passphrase can't be set.",
];
export const DECOY_ERRORS = {
  same: "Use a decoy passphrase that's different from your vault passphrase.",
  // Inside the decoy: it can't hold a decoy of its own. Only a wrong vault
  // passphrase is told apart first, exactly as in the real vault.
  here: "A decoy passphrase can't be set from here. Nothing was changed.",
};

// What a sealed verifier's ciphertext holds: the JSON text and GCM's tag.
const VERIFIER_CT_BYTES = new TextEncoder().encode(JSON.stringify(VERIFIER_TEXT)).length + 16;

// A slot's settings as stored, checked so a damaged decoy can never stop the
// real vault from opening (it's then treated as absent).
export function validSlot(meta) {
  try {
    return (
      meta?.format === VAULT_FORMAT &&
      meta.version === VAULT_VERSION &&
      meta.kdf?.name === "PBKDF2" &&
      meta.kdf.hash === "SHA-256" &&
      Number.isSafeInteger(meta.kdf.iterations) &&
      meta.kdf.iterations >= MIN_ITERATIONS &&
      meta.kdf.iterations <= MAX_ITERATIONS &&
      fromBase64(meta.kdf.salt).length >= SALT_BYTES &&
      fromBase64(meta.verifier?.iv).length === IV_BYTES &&
      fromBase64(meta.verifier?.ct).length >= 16
    );
  } catch {
    return false;
  }
}

// A stand-in for an empty slot: the same KDF parameters as `like`, a random
// salt, and a random verifier of a real one's size that no key opens.
export function standInSlot(like) {
  return {
    format: VAULT_FORMAT,
    version: VAULT_VERSION,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: like.kdf.iterations, salt: toBase64(randomBytes(SALT_BYTES)) },
    cipher: "AES-GCM-256",
    verifier: { iv: toBase64(randomBytes(IV_BYTES)), ct: toBase64(randomBytes(VERIFIER_CT_BYTES)) },
    idleMinutes: like.idleMinutes,
  };
}

// Which vault a passphrase opens: { slot: "main" | "alt", key, meta }, or
// VaultError "wrong_passphrase". Both keys are always derived, in parallel,
// and both verifiers always checked, whatever the answer.
export async function openEither({ main, alt = null }, passphrase) {
  const other = alt && validSlot(alt) ? alt : standInSlot(main);
  const derive = (m) => deriveVaultKey(passphrase, fromBase64(m.kdf.salt), m.kdf.iterations);
  const [mainKey, otherKey] = await Promise.all([derive(main), derive(other)]);
  const [isMain, isOther] = await Promise.all([
    keyOpensVerifier(mainKey, main.verifier),
    keyOpensVerifier(otherKey, other.verifier),
  ]);
  if (isMain) return { slot: "main", key: mainKey, meta: main };
  if (isOther && other === alt) return { slot: "alt", key: otherKey, meta: alt };
  throw new VaultError("wrong_passphrase", VAULT_ERRORS.wrong_passphrase);
}

const same = (a, b) => String(a).normalize("NFC") === String(b).normalize("NFC");
// What's wrong with a new decoy passphrase, before anything is derived.
export function decoyProblem(decoy, vaultPassphrase) {
  return passphraseProblem(decoy) || (same(decoy, vaultPassphrase) ? DECOY_ERRORS.same : null);
}

// A new decoy for the real vault `main`: the same KDF parameters and idle
// lock, a fresh salt and key, and the sample chats sealed with that key.
export async function createDecoy(main, passphrase, { lang = "en", model = null, now = Date.now(), newId } = {}) {
  const { meta, key } = await createVault(passphrase, {
    idleMinutes: IDLE_CHOICES.includes(main.idleMinutes) ? main.idleMinutes : DEFAULT_IDLE_MINUTES,
    iterations: main.kdf.iterations,
  });
  // The sample chats' text loads only when a decoy is made.
  const { sampleChats } = await import("./decoy-samples.js");
  const chats = sampleChats({ lang, model, now, newId });
  const records = [];
  for (const c of chats) records.push(await sealChat(key, c));
  return { meta, key, chats, records };
}
