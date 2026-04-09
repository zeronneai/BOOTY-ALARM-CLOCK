// Booty Alarm Clock — Service Worker
// Cache-first for app shell; Cloudinary proxy for icons (iOS same-origin requirement)

const CACHE_NAME = 'booty-alarm-v2';

// Icon source on Cloudinary — service worker fetches this and serves it
// under the local /icons/ path so iOS treats it as same-origin
const ICON_BASE = 'https://res.cloudinary.com/dsprn0ew4/image/upload';
const ICON_PUB  = 'v1775682139/Gemini_Generated_Image_7xbbjc7xbbjc7xbb_tpdbob.png';

// App shell files to pre-cache (icons are fetched lazily via Cloudinary proxy)
const CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
];

// ── Install: pre-cache app shell ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CACHE_URLS))
  );
  self.skipWaiting();
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
  self.clients.claim();
});

// ── Fetch ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  if (event.request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;

  // ── ICON PROXY ──
  // Intercept icon requests and serve them from Cloudinary.
  // Handles /icons/icon-NNN.png and /apple-touch-icon*.png (iOS root fallback).
  const iconMatch = url.pathname.match(/^\/icons\/icon-(\d+)\.png$/) ||
                    url.pathname.match(/^\/apple-touch-icon(-precomposed)?\.png$/);
  if (iconMatch) {
    const size = (url.pathname.match(/icon-(\d+)/) || [])[1] || '180';
    const cloudUrl = `${ICON_BASE}/w_${size},h_${size},c_fill,f_png/${ICON_PUB}`;
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(cloudUrl).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        }).catch(() => caches.match(event.request));
      })
    );
    return;
  }

  // ── CDN resources (MediaPipe, Fonts, Cloudinary audio) ──
  // Network-first so fresh versions are fetched when online
  const isCDN = url.hostname !== self.location.hostname;
  if (isCDN) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // ── Local assets: cache-first ──
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
