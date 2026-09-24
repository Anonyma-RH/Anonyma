// An optional second OpenAI-compatible gateway that serves chat when the
// primary one is unavailable. Only refusals that prove the primary never
// accepted the request trigger it, so a request is never paid for twice.
const REFRESH_MS = 10 * 60 * 1000;
export const FAILOVER_CODES = new Set([
  "provider_unavailable", // the primary account is unfunded or refused
  "provider_busy", // the primary is throttling
  "provider_down", // the primary couldn't be reached or answered 5xx
]);

export function createFallback(cfg) {
  const enabled = !cfg.testMode && !!cfg.gateway2 && !!cfg.gateway2Key;
  let ids = null,
    fetchedAt = 0,
    pending = null;
  async function catalog() {
    if (ids && Date.now() - fetchedAt < REFRESH_MS) return ids;
    pending ||= fetch(cfg.gateway2.replace(/\/$/, "") + "/models", {
      headers: { authorization: `Bearer ${cfg.gateway2Key}` },
      signal: AbortSignal.timeout(15000),
    })
      .then(async (r) => {
        if (!r.ok) throw Error(`Backup catalog unavailable (${r.status}).`);
        const j = await r.json();
        ids = (j.data || [])
          .map((m) => m?.id)
          .filter((id) => typeof id === "string");
        fetchedAt = Date.now();
        return ids;
      })
      .finally(() => (pending = null));
    try {
      return await pending;
    } catch {
      return ids || [];
    }
  }
  // The same model under the backup's naming: identical, or with a vendor
  // prefix such as "anthropic/claude-sonnet-5" for "claude-sonnet-5".
  async function modelFor(id) {
    if (!enabled) return null;
    const list = await catalog();
    const bare = id.includes("/") ? id.split("/").pop() : id;
    return (
      list.find((x) => x === id) ||
      list.find((x) => x.split("/").pop() === bare) ||
      null
    );
  }
  return {
    enabled,
    modelFor,
    // Settings for chatStream against the backup gateway.
    cfg: {
      ...cfg,
      gateway: cfg.gateway2,
      gatewayKey: cfg.gateway2Key,
      testMode: false,
    },
  };
}
