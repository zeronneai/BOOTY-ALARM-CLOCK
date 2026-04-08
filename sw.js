// Booty Alarm Clock — Service Worker
// Cache-first strategy for app shell; network-first for audio/media

const CACHE_NAME = 'booty-alarm-v1';
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-180.png',
];

// ── Install: pre-cache app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting(); // activate immediately
});

// ── Activate: delete old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim(); // take control of all open pages immediately
});

// ── Fetch: cache-first for local assets, network-first for CDN ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Skip non-GET requests and browser extensions
  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // For CDN resources (MediaPipe, Google Fonts, Cloudinary audio)
  // use network-first so fresh versions are always fetched when online
  const isCDN = url.hostname !== self.location.hostname;
  if (isCDN) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache a copy if successful
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request)) // fallback to cache if offline
    );
    return;
  }

  // Local assets: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
