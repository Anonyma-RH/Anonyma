import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { catalog } from "./core.js";
export function loadCatalog(path) {
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(j.data) && j.data.length && j.updatedAt) return j;
  } catch {}
  return catalog();
}
export async function syncCatalog(
  cfg,
  previous = loadCatalog(cfg.catalogPath),
) {
  // PPQ's default feed omits dedicated media models. Refresh both feeds as
  // one snapshot; a failed feed must never retire previously available models.
  const feeds = await Promise.allSettled(
    ["/v1/models", "/v1/models?type=image,video"].map(async (path) => {
      const response = await fetch(cfg.gateway.replace(/\/$/, "") + path, {
        headers: cfg.gatewayKey
          ? { authorization: "Bearer " + cfg.gatewayKey }
          : {},
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw Error("Catalog refresh failed: " + response.status);
      const result = await response.json();
      if (!Array.isArray(result.data) || !result.data.length)
        throw Error(
          "Gateway returned an empty model catalog. Existing snapshot retained.",
        );
      return result.data;
    }),
  );
  const failed = feeds.find((feed) => feed.status === "rejected");
  if (failed) throw failed.reason;
  const combined = new Map();
  for (const feed of feeds)
    for (const model of feed.value) combined.set(model.id, model);
  const valid = [...combined.values()].filter(
    (m) =>
      typeof m.id === "string" &&
      m.id.length < 250 &&
      m.pricing &&
      typeof m.pricing === "object",
  );
  if (!valid.length)
    throw Error(
      "No priced models in gateway response. Existing snapshot retained.",
    );
  const live = valid.map((m) => ({
    ...m,
    name: m.name || m.id,
    status: "live",
  }));
  const ids = new Set(live.map((m) => m.id));
  const data = [
    ...live,
    ...previous.data
      .filter((m) => !ids.has(m.id))
      .map((m) => ({
        ...m,
        status: m.status === "planned" ? "planned" : "unavailable",
      })),
  ];
  const next = {
    data,
    updatedAt: new Date().toISOString(),
    source: "Configured gateway catalog",
    live: true,
  };
  mkdirSync(dirname(cfg.catalogPath), { recursive: true });
  const temp = cfg.catalogPath + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(temp, JSON.stringify(next), { mode: 0o600, flag: "wx" });
    renameSync(temp, cfg.catalogPath);
  } finally {
    try {
      unlinkSync(temp);
    } catch {}
  }
  return next;
}
