// Public copy uses the same release flags as the server. Missing configuration
// is unknown, never evidence that every feature is live.
export const featureEnabled = (config, id) =>
  config?.releases?.features?.[id] === true;

export function guideReleaseLabel(config, features = []) {
  if (!features.length) return "";
  if (!config?.releases) return "Availability unavailable";
  const pending = features.filter((id) => !featureEnabled(config, id));
  if (!pending.length) return "";
  return pending.length === features.length
    ? "Coming soon"
    : "Some features coming soon";
}

export function featureLabel(config, id, label) {
  if (!config?.releases) return `${label} — availability unavailable`;
  if (!featureEnabled(config, id)) return `${label} — coming soon`;
  return config.testMode ? `${label} — local test` : label;
}

export function releaseCopy(config) {
  if (!config?.releases)
    return {
      label: "AVAILABILITY UNAVAILABLE",
      summary:
        "Current service availability could not be loaded. Check again before signing up or funding an account.",
      payment:
        "Funding availability could not be loaded. Do not send a payment based on this page.",
    };
  if (config.testMode)
    return {
      label: "LOCAL TEST SERVICE",
      summary:
        "This installation uses test responses and test credits. It is not a live AI or payment service.",
      payment: "Local test mode does not accept real payments.",
    };
  const enabled = (config.releases.updates || [])
    .filter((u) => u.released)
    .map((u) => u.title);
  const pending = (config.releases.updates || []).some((u) => !u.released);
  return {
    label: "CURRENT RELEASE",
    summary: `Enabled: ${[...(config.services?.generation ? ["Chat"] : []), ...enabled, "Dashboard", "Account", "Prepaid credits"].join(", ")}. ${config.services?.generation ? "Model availability and rates are shown in the catalog." : "AI generation is currently unavailable."} ${pending ? "Other features remain coming soon on the roadmap." : "See the roadmap for the full release list."}`,
    payment:
      config.services?.walletPayments && config.walletPayments
        ? `Funding: ${config.walletPayments.symbol} on ${config.walletPayments.chainName}. Credits are added after the transfer is verified; confirmation times can vary.`
        : config.services?.payments
          ? "Funding is available through the payment methods shown in your account. Credits are added after verified confirmation."
          : "Funding is currently unavailable. Do not send a payment until a supported method appears in your account.",
  };
}
