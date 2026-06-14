// Minimal offline-capable service worker. App shell is cached; the live campaign
// API is always fetched fresh and only falls back to cache when offline.
const SHELL = "terrarium-shell-v1";
const SHELL_ASSETS = ["/", "/index.html", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Always-fresh for the live ledger; fall back to cache offline.
  if (url.pathname.startsWith("/api/")) {
    event.respondWith(fetch(request).then((r) => { const c = r.clone(); caches.open(SHELL).then((cache) => cache.put(request, c)); return r; }).catch(() => caches.match(request)));
    return;
  }
  // Cache-first for static shell and generated imagery.
  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((r) => {
    if (r.ok && (r.type === "basic")) { const c = r.clone(); caches.open(SHELL).then((cache) => cache.put(request, c)); }
    return r;
  }).catch(() => cached)));
});
