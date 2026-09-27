import { useEffect, useState } from "react";
import { api, isReleased } from "./lib.js";

// Model Status (update "status"): the public, aggregated status of each model
// family from GET /api/status (server/model-status.js). Nothing here is about
// the person looking: the same numbers for everyone, from ANONYMA's own
// traffic, kept in memory on the server for an hour.

export const statusReleased = (config) => isReleased(config, "status");

export const STATUS_LABEL = {
  up: "Up",
  degraded: "Degraded",
  down: "Down",
  unknown: "Not enough data",
};

// The picker dot's tooltip: what the colour means, and the typical wait for
// the first token when there's enough data for one.
const HINT = {
  up: "Up: requests went through in the last 15 minutes.",
  degraded: "Degraded: some requests failed or timed out in the last 15 minutes.",
  down: "Down: most requests failed or timed out in the last 15 minutes.",
};
export function statusHint(entry) {
  const hint = HINT[entry?.status];
  if (!hint) return "";
  return entry.ttft ? `${hint} Typical first token: ${seconds(entry.ttft.median, "")} s.` : hint;
}

// 1234 → "1.2 s", to a tenth of a second.
export function seconds(ms, unit = " s") {
  if (!Number.isFinite(ms)) return "—";
  return (ms / 1000).toFixed(1) + unit;
}

// Model id → its entry ({ status, ttft, total, family }) for the models the
// report has numbers for. Anything missing has too little data to show.
export function statusByModel(report) {
  const out = {};
  for (const family of report?.families || [])
    for (const m of family.models || []) out[m.id] = { ...m, family: family.name };
  return out;
}

// Counts of families by status, for the page's summary line.
export function familyCounts(report) {
  const counts = { up: 0, degraded: 0, down: 0, unknown: 0 };
  for (const f of report?.families || []) counts[f.status] = (counts[f.status] || 0) + 1;
  return counts;
}

// GET /api/status while `live`, again every `every` ms while the page is
// visible. Failures keep the last answer: status is a hint, never a gate.
export function useModelStatus(live, { every = 60000 } = {}) {
  const [report, setReport] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!live) {
      setReport(null);
      return;
    }
    let controller = null;
    const load = () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      controller?.abort();
      controller = new AbortController();
      api("/api/status", { signal: controller.signal })
        .then((r) => {
          setReport(r);
          setFailed(false);
        })
        .catch((e) => {
          if (e?.name !== "AbortError") setFailed(true);
        });
    };
    load();
    const timer = setInterval(load, every);
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      controller?.abort();
    };
  }, [live, every]);
  return { report, failed };
}
