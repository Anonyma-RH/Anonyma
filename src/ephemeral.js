// Pure helpers for off-the-record chats and auto-delete retention, kept
// free of JSX so tests can import them directly.

// The only choices the server accepts; null clears (never deletes).
export const RETENTION_CHOICES = [
  { value: null, label: "Never" },
  { value: 1, label: "1 day" },
  { value: 7, label: "7 days" },
  { value: 30, label: "30 days" },
];
export const retentionOptionLabel = (days) =>
  RETENTION_CHOICES.find((c) => c.value === days)?.label ?? "Never";

// A short "Deletes in N days" indicator from a stored expiry (epoch ms), or
// "" when there is nothing to show. `nowMs` is injectable for tests.
export function retentionLabel(expires, nowMs = Date.now()) {
  if (!Number.isFinite(expires)) return "";
  const remaining = expires - nowMs;
  if (remaining <= 0) return "Deletes soon";
  const days = Math.ceil(remaining / 86400000);
  return days === 1 ? "Deletes in 1 day" : `Deletes in ${days} days`;
}

// The choice to show for a conversation that already has an expiry: the
// shortest option that still covers the time left (only the expiry is
// stored, not the original choice). null when it never deletes.
export function retentionChoiceFor(expires, nowMs = Date.now()) {
  if (!Number.isFinite(expires)) return null;
  const days = Math.max(1, Math.ceil((expires - nowMs) / 86400000));
  return days <= 1 ? 1 : days <= 7 ? 7 : 30;
}
