// The server and static preview use the same finite route list. Keep future
// features addressable for their Coming soon pages without inventing routes.
export const DOC_TOPICS = [
  "billing",
  "getting-started",
  "models",
  "credits",
  "images",
  "api",
  "privacy",
];
export const GUIDE_SLUGS = [
  "choose-a-model",
  "understanding-credits",
  "one-api",
];
export const PUBLIC_PAGES = [
  "/",
  "/models",
  "/pricing",
  "/docs",
  "/whitepaper",
  "/developers",
  "/roadmap",
  "/support",
  "/privacy",
  "/terms",
  ...DOC_TOPICS.map((x) => "/docs/" + x),
  ...GUIDE_SLUGS.map((x) => "/guides/" + x),
];
const ACCOUNT = ["overview", "credits", "keys", "settings"];
const MODES = [
  "home",
  "chat",
  "code",
  "image",
  "video",
  "audio",
  "collab",
  "library",
  "veil",
];
export function knownPage(path) {
  if (path.length > 1) path = path.replace(/\/$/, "");
  return (
    PUBLIC_PAGES.includes(path) ||
    ["/login", "/register", "/workspace", "/account"].includes(path) ||
    ACCOUNT.some((x) => path === "/account/" + x) ||
    MODES.some((x) => path === "/workspace/" + x)
  );
}
export function sitemap(origin) {
  const escape = (s) =>
    s
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&apos;");
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    PUBLIC_PAGES.map(
      (path) => `  <url><loc>${escape(origin + path)}</loc></url>`,
    ).join("\n") +
    "\n</urlset>\n"
  );
}
export function robots(origin) {
  return `User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /v1/\nDisallow: /account\nDisallow: /workspace\nDisallow: /login\nDisallow: /register\nSitemap: ${origin}/sitemap.xml\n`;
}
