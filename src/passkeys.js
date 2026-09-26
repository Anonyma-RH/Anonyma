// Passkeys in the browser (the sign-in page and Account → Security, in
// src/Passkeys.jsx): the release check, small pure helpers and the WebAuthn
// ceremonies. @simplewebauthn/browser is loaded only when a ceremony starts,
// so pages that never use a passkey don't download it.
import { api, isReleased } from "./lib.js";

export const PASSKEY_NAME_MAX = 40;
export const PASSKEY_LIMIT = 10;

// Released, and the service's origin can be a WebAuthn relying party.
export const passkeysReleased = (config) =>
  isReleased(config, "passkeys") && config?.services?.passkeys === true;

// Whether this browser can make and use passkeys at all.
export const browserSupportsPasskeys = (w = globalThis.window) =>
  !!w?.PublicKeyCredential &&
  typeof w.navigator?.credentials?.create === "function";

// A starting name for a new passkey, from the device type only; the person
// can change it before saving. Never sent anywhere until they add it.
export function defaultPasskeyName(nav = globalThis.navigator) {
  const ua = String(nav?.userAgent || "");
  const platform = String(nav?.userAgentData?.platform || nav?.platform || "");
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/CrOS/.test(ua)) return "Chromebook";
  if (/Mac/.test(platform) || /Macintosh/.test(ua)) return "Mac";
  if (/Win/.test(platform) || /Windows/.test(ua)) return "Windows PC";
  if (/Linux/.test(platform)) return "Linux";
  return "Passkey";
}

// What a name field keeps as someone types.
export const nameInput = (value) =>
  [...String(value).replace(/[\u0000-\u001f\u007f]/g, "")]
    .slice(0, PASSKEY_NAME_MAX)
    .join("");

// Removing this passkey would leave no way to sign in: no password, email
// or wallet, and no other passkey.
export const onlyWayIn = (methods) =>
  !!methods &&
  !methods.password &&
  !methods.email &&
  !methods.wallet &&
  methods.passkeys <= 1;

// The browser's own errors, said plainly. Server errors keep their message.
export function passkeyError(e) {
  const name = e?.name || "";
  const code = e?.code || "";
  if (code === "ERROR_CEREMONY_ABORTED" || name === "NotAllowedError" || name === "AbortError")
    return "The passkey prompt was closed or timed out. Nothing changed.";
  if (code === "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" || name === "InvalidStateError")
    return "This device already has a passkey for this account.";
  if (
    code === "ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT" ||
    code === "ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT"
  )
    return "This authenticator can’t check it’s you or store a passkey. Try your phone or computer’s built-in passkeys.";
  if (code === "ERROR_INVALID_DOMAIN" || code === "ERROR_INVALID_RP_ID" || name === "SecurityError")
    return "Passkeys need this site on a domain name over HTTPS.";
  if (e?.status || e?.message?.startsWith?.("The service"))
    return e.message;
  return "Your browser couldn’t use a passkey here. Try again, or sign in another way.";
}

const webauthn = () => import("@simplewebauthn/browser");
const post = (path, body = {}) => api(path, { method: "POST", body });

// Sign in with any passkey for this site (no username). Returns the
// session answer. A passkey this service no longer knows is reported to the
// browser, so its passkey manager can stop offering it.
export async function passkeySignIn() {
  const { startAuthentication, sendSignal } = await webauthn();
  const { options } = await post("/api/auth/passkey/options");
  const response = await startAuthentication({ optionsJSON: options });
  try {
    return await post("/api/auth/passkey/verify", { response });
  } catch (e) {
    if (e?.code === "passkey_unknown")
      sendSignal({
        signalName: "unknownCredential",
        rpID: options.rpId,
        credentialID: response.id,
      }).catch(() => {});
    throw e;
  }
}
// A new account: a username and a passkey, no password or email.
export async function passkeySignUp(username, name) {
  const { startRegistration } = await webauthn();
  const { options } = await post("/api/auth/passkey/signup/options", { username });
  const response = await startRegistration({ optionsJSON: options });
  return post("/api/auth/passkey/signup/verify", { response, name });
}
// Account → Security: add a passkey to the signed-in account.
export async function addPasskey(name) {
  const { startRegistration } = await webauthn();
  const { options } = await post("/api/account/passkeys/options");
  const response = await startRegistration({ optionsJSON: options });
  return post("/api/account/passkeys", { response, name });
}
// "Confirm it's you" with one of the account's passkeys, for this session.
export async function confirmWithPasskey() {
  const { startAuthentication } = await webauthn();
  const { options } = await post("/api/account/passkeys/reauth/options");
  const response = await startAuthentication({ optionsJSON: options });
  return post("/api/account/passkeys/reauth", { response });
}
