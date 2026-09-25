import { openapiForConfig } from "./openapi.js";
import { isReleased } from "./releases.js";

// Deliberately derived only from public source: never read local project notes.
export function publicDocumentation(cfg = {}) {
  const openapi = openapiForConfig(cfg);
  const operations = Object.entries(openapi.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(([method]) =>
        ["get", "post", "put", "patch", "delete", "head", "options"].includes(
          method,
        ),
      )
      .map(
        ([method, operation]) =>
          `- ${method.toUpperCase()} ${path}: ${operation.summary || operation.operationId || ""}`,
      ),
  );
  return [
    "# Anonyma",
    "",
    "Prepaid AI workspace. Check /api/config and /roadmap for current feature availability.",
    isReleased(cfg, "api")
      ? "Developer API & CLI: enabled. Use /docs/api for the supported interface."
      : "Developer API & CLI: Coming soon. /v1, API-key creation and CLI installers return 403 feature_unreleased.",
    "Operations below follow the installation release gates. Model and request-specific restrictions still apply.",
    "Machine-readable API contract: /api/openapi.json",
    "Interactive product documentation: /docs",
    isReleased(cfg, "api")
      ? "Developer requests use a Bearer API key; browser routes use a protected cookie and are not a substitute developer API."
      : "Browser routes use a protected cookie. They do not provide an available developer API.",
    "Live generation, payment and email require operator-configured services.",
    "Billing rules: /docs/billing. Interrupted requests may incur charges.",
    "Local test mode uses isolated fixtures and must not be used for live funds.",
    "",
    "## API operations",
    ...operations,
    "",
  ].join("\n");
}

export function publicDiscovery(cfg) {
  return `# Anonyma\nPrepaid AI workspace.\n- Documentation: /docs\n- Developer API & CLI: ${isReleased(cfg, "api") ? "enabled; documentation: /docs/api" : "Coming soon; not available"}\n- Availability: /api/config\n- Full documentation: /llms-full.txt\n`;
}
