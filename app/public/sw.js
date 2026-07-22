// Offline-capable, self-updating service worker.
//
// Freshness model (why this can't go stale after a deploy):
//   - Hashed build assets (/assets/*) are immutable: their filename changes on
//     every build, so cache-first is always correct and never stale.
//   - Everything else on this origin — the HTML shell, CHANGELOG.md, manifest,
//     icons, /api ledgers, /campaign imagery — is CONTENT that changes in place
//     across deploys, so it is network-first with an offline cache fallback.
//   - CACHE is stamped with a build ID at build time (vite.config.js replaces
//     __SW_BUILD_ID__), so every deploy gets a fresh cache and activate() purges
//     the previous one. No human ever hand-bumps a version.
const CACHE = "terrarium-shell-__SW_BUILD_ID__";
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

// Network-first with cache fallback: fetch fresh, update the cache, fall back to
// the cached copy only when offline.
function networkFirst(event, cacheKey) {
  event.respondWith(
    fetch(event.request)
      .then((r) => { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put(cacheKey || event.request, c)); return r; })
      .catch(() => caches.match(cacheKey || event.request)),
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Immutable hashed build assets: cache-first is safe forever (the filename
  // changes when the content changes).
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((r) => {
      if (r.ok && r.type === "basic") { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put(request, c)); }
      return r;
    })));
    return;
  }

  // The HTML shell: network-first, cache the resolved "/" so offline still boots.
  if (isHtml(request)) { networkFirst(event, "/"); return; }

  // Everything else on this origin is mutable content (CHANGELOG.md, manifest,
  // icons, /api, /campaign, docs): network-first so a deploy is always picked up.
  networkFirst(event);
});
