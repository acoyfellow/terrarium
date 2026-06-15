// Offline-capable, update-safe service worker.
// HTML is network-first so a new deploy is picked up immediately (no stale shell
// pointing at a deleted bundle). Hashed assets and imagery are cache-first.
// The /api ledger is always-fresh with an offline fallback.
const CACHE = "terrarium-shell-v2";
const SHELL_ASSETS = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

function isHtml(request) {
  return request.mode === "navigate" || (request.headers.get("accept") || "").includes("text/html");
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Always-fresh JSON ledger; fall back to cache only when offline.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request).then((r) => { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put(request, c)); return r; }).catch(() => caches.match(request)));
    return;
  }

  // HTML shell: network-first so deploys are picked up; cached copy is the fallback.
  if (isHtml(request)) {
    event.respondWith(fetch(request).then((r) => { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put("/", c)); return r; }).catch(() => caches.match("/")));
    return;
  }

  // Hashed assets and imagery: cache-first.
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((r) => {
    if (r.ok && r.type === "basic") { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put(request, c)); }
    return r;
  })));
});
