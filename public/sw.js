// Service worker for the installable ANONYMA app shell. Scope is "/" (the
// file is served from the origin root), so no Service-Worker-Allowed header
// is needed. Only GET, same-origin requests are ever intercepted.
//
// Bump CACHE_VERSION when this file's caching *strategy* changes. Content
// changes to hashed build assets do not need a bump: a new deploy produces
// new hashed filenames, which simply miss the existing cache and get fetched
// fresh — the old, now-unreferenced entries are cleared on the next activate.
const CACHE_VERSION = "v1";
const CACHE_NAME = "anonyma-shell-" + CACHE_VERSION;
const OFFLINE_URL = "/offline.html";

// A minimal, always-available shell. Everything else (hashed JS/CSS, icons,
// fonts) is cached opportunistically the first time it is requested, via the
// runtime strategy below.
const SHELL_URLS = ["/", "/workspace", "/manifest.webmanifest", OFFLINE_URL];

// Requests that must always reach the network untouched: the API, the
// OpenAI-compatible /v1 surface, health checks and any private media (media
// is itself served under /api/media/*, so the /api/ rule already covers it).
function isNeverCached(url) {
  return (
    url.pathname.startsWith("/api/") ||
    url.pathname === "/api" ||
    url.pathname.startsWith("/v1") ||
    url.pathname === "/health"
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      // Tolerate any single missing shell URL (e.g. offline.html not yet
      // built in a dev checkout) instead of failing the whole install.
      await Promise.allSettled(
        SHELL_URLS.map((url) =>
          cache.add(new Request(url, { cache: "reload" })),
        ),
      );
      // Take over from any previous worker as soon as this one finishes
      // installing. Safe here because navigations are network-first (below),
      // so an immediately-activated worker never serves stale HTML paired
      // with mismatched hashed assets — see clients.claim() note below.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("anonyma-shell-") && name !== CACHE_NAME)
          .map((name) => caches.delete(name)),
      );
      // Control already-open tabs immediately. Paired with skipWaiting and
      // network-first navigations, this is how a new deploy is picked up
      // without an interstitial "reload to update" prompt: the very next
      // navigation or fetch already goes through the new worker, and it
      // still prefers the network over anything cached.
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept writes
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // same-origin only
  if (isNeverCached(url)) return; // let the API/health/v1 hit the network directly
  // Films and audio stream with byte-range requests (206 responses can't be
  // cached) and are tens of megabytes; leave them to the browser's own cache.
  if (
    request.headers.has("range") ||
    request.destination === "video" ||
    request.destination === "audio" ||
    /\.(mp4|webm|mov|mp3|wav|m4a|ogg)$/i.test(url.pathname)
  )
    return;

  const isNavigation =
    request.mode === "navigate" ||
    (request.headers.get("accept") || "").includes("text/html");

  if (isNavigation) {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  event.respondWith(staleWhileRevalidate(request));
});

// Always prefer a live page so a fresh deploy's HTML (and the new hashed
// asset URLs it references) is what people see whenever they are online.
// Cache is only a fallback for genuinely offline starts.
async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cache = await caches.open(CACHE_NAME);
    return (
      (await cache.match(request)) ||
      (await cache.match(OFFLINE_URL)) ||
      Response.error()
    );
  }
}

// Serve instantly from cache when available, refreshing it in the
// background. Hashed build assets never change under a given filename, so
// this is effectively cache-first for them; unhashed static files (fonts,
// icons, the hero clip) still get refreshed on every successful fetch
// instead of staying stale forever.
async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (response && response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  return cached || (await network) || Response.error();
}
