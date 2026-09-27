import { useEffect, useState } from "react";
import { api, isReleased } from "./lib.js";

// Blind Arena (update "arena", built on Blind Compare): the public
// leaderboard from GET /api/arena and the account's opt-in. Nothing here is
// about the person looking: the same board for everyone, from votes that
// accounts chose to add, counted without who added them (server/arena.js).

export const arenaReleased = (config) => isReleased(config, "arena") && isReleased(config, "blind");

// Model id → its rank on the board, for the picker's "Arena #3" badge. Only
// listed models (enough votes) have one.
export function arenaRanks(board) {
  const out = {};
  for (const m of board?.models || []) if (Number.isInteger(m.rank)) out[m.id] = m.rank;
  return out;
}

// 0.625 → "63%".
export const winPercent = (rate) => `${Math.round((Number(rate) || 0) * 100)}%`;

// Where a score sits on the board's interval bars, 0 to 100: the widest
// interval on the board sets the ends, with a little room either side.
export function barScale(models) {
  const list = models || [];
  if (!list.length) return () => 50;
  let lo = Math.min(...list.map((m) => m.ci?.[0] ?? m.score));
  let hi = Math.max(...list.map((m) => m.ci?.[1] ?? m.score));
  const pad = Math.max(10, (hi - lo) * 0.06);
  lo -= pad;
  hi += pad;
  return (v) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
}

// GET /api/arena while `live`. The server recomputes at most hourly, so
// once per page is enough; failures leave the board empty (the picker just
// shows no badge).
export function useArena(live) {
  const [board, setBoard] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!live) {
      setBoard(null);
      return;
    }
    const controller = new AbortController();
    api("/api/arena", { signal: controller.signal })
      .then((r) => {
        setBoard(r);
        setFailed(false);
      })
      .catch((e) => {
        if (e?.name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, [live]);
  return { board, failed };
}

// The account's choice. `round` goes only with the yes asked after a vote,
// so that vote is added too.
export const loadArenaChoice = () => api("/api/arena/consent");
export const saveArenaChoice = (contribute, round) =>
  api("/api/arena/consent", {
    method: "PUT",
    body: { contribute, ...(contribute && round ? { round } : {}) },
  });
