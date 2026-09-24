// Scrolls: saved, reusable prompts with {{name}} placeholders. Pure helpers
// so both the UI and tests can share them without pulling in JSX.
export const MAX_TITLE = 80;
export const MAX_BODY = 8000;
export const MAX_INSTRUCTIONS = 4000;
const VARIABLE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

// Ordered, de-duplicated {{name}} placeholders found in a scroll body.
export function extractVariables(body) {
  const seen = new Set();
  const names = [];
  for (const m of String(body || "").matchAll(VARIABLE))
    if (!seen.has(m[1])) {
      seen.add(m[1]);
      names.push(m[1]);
    }
  return names;
}

// Replace every {{name}} with its filled value; a missing value becomes "".
export function fillTemplate(body, values = {}) {
  return String(body || "").replace(VARIABLE, (_, name) =>
    values[name] != null ? String(values[name]) : "",
  );
}

export function validateTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) return "Give the scroll a title.";
  if (t.length > MAX_TITLE) return `Title cannot exceed ${MAX_TITLE} characters.`;
  return null;
}
export function validateBody(body) {
  const b = String(body ?? "");
  if (!b.trim()) return "The scroll needs a prompt.";
  if (b.length > MAX_BODY) return `Body cannot exceed ${MAX_BODY} characters.`;
  return null;
}
// {} means valid; otherwise a field -> message map for form errors.
export function validateScroll({ title, body } = {}) {
  const errors = {};
  const t = validateTitle(title);
  const b = validateBody(body);
  if (t) errors.title = t;
  if (b) errors.body = b;
  return errors;
}
export function validateInstructions(body) {
  const b = String(body ?? "");
  if (b.length > MAX_INSTRUCTIONS)
    return `Instructions cannot exceed ${MAX_INSTRUCTIONS} characters.`;
  return null;
}
