import { useEffect } from "react";

// Query params the OS share sheet sends to our share_target action
// (public/manifest.webmanifest → share_target.params).
const SHARE_KEYS = ["title", "text", "url"];

// True when a search string carries any share-target field.
export function hasShareTarget(search) {
  const params = new URLSearchParams(search);
  return SHARE_KEYS.some((k) => params.get(k));
}

// Reads the share-target fields out of a search string. Returns null when
// none are present, so callers can treat "no share" and "empty share" alike.
export function readShareTarget(search) {
  const params = new URLSearchParams(search);
  const fields = Object.fromEntries(
    SHARE_KEYS.map((k) => [k, (params.get(k) || "").trim()]),
  );
  if (!fields.title && !fields.text && !fields.url) return null;
  return fields;
}

// Combines the shared title/text/url into one composer-ready string. A
// shared link's text and the link itself are kept on their own lines so
// the URL stays easy to see and edit.
export function combineShareFields({ title = "", text = "", url = "" } = {}) {
  return [title, text, url]
    .map((v) => (v || "").trim())
    .filter(Boolean)
    .join("\n\n");
}

// Returns `search` with the share-target keys removed, leaving every other
// param (e.g. ?demo=1, ?model=...) untouched.
export function stripShareParams(search) {
  const params = new URLSearchParams(search);
  for (const k of SHARE_KEYS) params.delete(k);
  const s = params.toString();
  return s ? "?" + s : "";
}

// Prefills the composer from a share_target request the first time the chat
// route loads with share params, then removes them from the URL so a
// refresh or re-send doesn't repeat the same share. Never auto-sends.
export function useShareTargetPrefill({ mode, search, setPrompt, onConsumed }) {
  useEffect(() => {
    if (mode !== "chat") return;
    const shared = readShareTarget(search);
    if (!shared) return;
    setPrompt(combineShareFields(shared));
    onConsumed?.(stripShareParams(search));
  }, [mode, search]);
}
