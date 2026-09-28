// Two-Step Sign-in in the browser (the settings page and the sign-in step
// in src/TwoStep.jsx): the release check and small pure helpers.

export const twoStepReleased = (config) =>
  config?.releases?.features?.twostep === true;

// Said on the settings page: keys never ask for a code.
export const TWO_STEP_API_NOTE =
  "API keys and connected apps (MCP) keep working without a code: they’re separate credentials. Revoke one from Account if it leaks.";

// "JBSWY3DP…" as groups of four, easier to type into an app.
export const formatSecret = (secret) =>
  String(secret || "")
    .replace(/(.{4})/g, "$1 ")
    .trim();

// What a code field keeps as someone types: six digits, or (for a recovery
// code) the text as typed, up to a sensible length.
export const codeInput = (value, recovery = false) =>
  recovery
    ? String(value).slice(0, 24)
    : String(value).replace(/\D/g, "").slice(0, 6);

// The recovery codes as a text file to keep.
export function recoveryText(codes, label) {
  return [
    `ANONYMA recovery codes for ${label || "your account"}`,
    "Each code signs you in once, instead of a code from your authenticator app.",
    "Keep them somewhere safe and private.",
    "",
    ...codes,
    "",
  ].join("\n");
}
