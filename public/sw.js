// Service worker for the installable ANONYMA app. It is registered only once
// the "app" update is released (useInstallAppGate in src/InstallApp.jsx), and
// its scope is "/" because the file is served from the origin root.
//
// It deliberately does very little:
// - Page navigations always go to the network, so a new deploy's HTML (and
//   the hashed asset URLs it names) is what people see whenever they are
//   online. Pages are never cached; the offline page is shown only when the
//   network request itself fails.
// - Hashed build files under /assets/ never change under a given name, so
//   they are served cache-first and the cache is kept to a bounded size.
// - Every other request (the API, /v1, /mcp, /health, /version.json, media,
//   audio/video, byte ranges, downloads, other origins, anything that isn't
//   a GET) is left alone: the worker doesn't call respondWith for it.
//
// Bump CACHE_VERSION whenever this file's caching strategy changes; activate
// deletes every cache from an older version.
const CACHE_VERSION = "v2";
const SHELL_CACHE = "anonyma-shell-" + CACHE_VERSION;
const ASSET_CACHE = "anonyma-assets-" + CACHE_VERSION;
const OFFLINE_URL = "/offline.html";
// The offline page and the script that picks its language. Nothing else is
// precached: the app itself needs the network to reach models and accounts.
const SHELL_URLS = [OFFLINE_URL, "/offline.js"];
// Roughly one and a half builds' worth of hashed files; the oldest go first.
const MAX_ASSETS = 120;

// Requests the worker must never answer or cache, even as navigations.
function isNeverHandled(url, request) {
  const p = url.pathname;
  return (
    p === "/api" ||
    p.startsWith("/api/") ||
    p === "/v1" ||
    p.startsWith("/v1/") ||
    p === "/mcp" ||
    p.startsWith("/mcp/") ||
    p === "/health" ||
    p === "/version.json" ||
    p.startsWith("/media/") ||
    request.headers.has("range") ||
    request.destination === "video" ||
    request.destination === "audio" ||
    /\.(mp4|webm|mov|m4v|mp3|wav|m4a|aac|ogg|oga|flac)$/i.test(p)
  );
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL_CACHE);
      // All or nothing: if the offline page can't be stored the install
      // fails and the browser tries again on a later visit.
      await cache.addAll(
        SHELL_URLS.map((url) => new Request(url, { cache: "reload" })),
      );
      // Safe to take over at once: pages are never served from cache while
      // online, so a new worker can't pair stale HTML with new assets.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const current = [SHELL_CACHE, ASSET_CACHE];
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("anonyma-") && !current.includes(name))
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return; // never intercept writes
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // same-origin only
  if (isNeverHandled(url, request)) return;

  if (request.mode === "navigate") {
    // Only app pages (no file extension): downloads such as /install.sh,
    // /cli.mjs or /llms.txt and opened files stay plain browser navigations.
    if (/\.[a-z0-9]+$/i.test(url.pathname) && url.pathname !== OFFLINE_URL)
      return;
    event.respondWith(networkFirstPage(request));
    return;
  }
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(cacheFirstAsset(event));
    return;
  }
  if (SHELL_URLS.includes(url.pathname)) {
    event.respondWith(networkFirstShell(request));
  }
  // Anything else goes to the network exactly as if there were no worker.
});

// The live page whenever the network answers at all (including 404s and
// server errors, which are real answers); the offline page only when the
// request itself fails.
async function networkFirstPage(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(OFFLINE_URL, { cacheName: SHELL_CACHE });
    return cached || Response.error();
  }
}

async function networkFirstShell(request) {
  try {
    return await fetch(request);
  } catch {
    const cached = await caches.match(new URL(request.url).pathname, {
      cacheName: SHELL_CACHE,
    });
    return cached || Response.error();
  }
}

async function cacheFirstAsset(event) {
  const { request } = event;
  const cache = await caches.open(ASSET_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only complete, successful answers: a missing old chunk falls through to
  // the server's HTML 404 page, which must never be stored as a script.
  if (response.status === 200) {
    const copy = response.clone();
    event.waitUntil(cache.put(request, copy).then(() => trim(cache)));
  }
  return response;
}

// Cache keys come back in insertion order, so the oldest entries go first.
async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS)))
    await cache.delete(key);
}

// ---- Push Alerts ----
// A notification from ANONYMA's server (server/push-alerts.js), which only
// arrives once this browser was subscribed in Account settings. Each message
// is one fixed sentence and a page of this site to open, never anything from
// the account. The pages a notification may open (PUSH_KINDS' urls in
// src/push-alerts.js; tests keep the two lists equal):
const PUSH_PATHS = [
  "/workspace/routines",
  "/account/credits",
  "/account/credits#gift-links",
  "/account/settings#inactivity-wipe",
  "/account/settings#push-alerts",
];
const pushPath = (url) => (PUSH_PATHS.includes(url) ? url : "/workspace");

self.addEventListener("push", (event) => {
  let data = null;
  try {
    data = event.data ? event.data.json() : null;
  } catch {
    data = null;
  }
  const ok = data && data.v === 1 && typeof data.body === "string";
  // A push must always show a notification; one that can't be read shows
  // the plain name.
  event.waitUntil(
    self.registration.showNotification(ok ? String(data.title || "ANONYMA").slice(0, 80) : "ANONYMA", {
      body: ok ? data.body.slice(0, 200) : "",
      tag: ok && typeof data.tag === "string" ? data.tag.slice(0, 64) : "anonyma",
      icon: "/icons/icon-192.png",
      data: { url: pushPath(ok ? data.url : null) },
    }),
  );
});

// Opens the page in a new window (or focuses a window already on it), so a
// tab with unsent work is never navigated away.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(pushPath(event.notification.data && event.notification.data.url), self.location.origin);
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((c) => {
        const u = new URL(c.url);
        return u.origin === target.origin && u.pathname === target.pathname && u.hash === target.hash;
      });
      if (open) return open.focus();
      return self.clients.openWindow(target.href);
    })(),
  );
});
