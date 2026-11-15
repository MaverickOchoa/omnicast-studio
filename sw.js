const CACHE_NAME = 'omnicast-pwa-v1';
const PRECACHE_ASSETS = [
  '/',
  '/index.html',
  '/projector.html',
  '/stage.html',
  '/tv.html',
  '/remote.html',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg'
];

// Install: Pre-cache core shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_ASSETS).catch((err) => {
        console.warn('[Service Worker] Non-fatal precache issue:', err);
      });
    }).then(() => self.skipWaiting())
  );
});

// Activate: Clean up old caches and take control
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key.startsWith('omnicast-') && key !== CACHE_NAME)
            .map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Smart network-first for production assets, strict bypass for real-time APIs
self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // 1. Strict bypass for Realtime, APIs, WebSockets, Video Streaming and Uploads
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/uploads/') ||
    url.pathname.startsWith('/tv-hls/') ||
    req.headers.has('range') ||
    req.method !== 'GET'
  ) {
    return; // Let browser handle network directly
  }

  // 2. Network-first strategy with cache fallback for pages and UI assets
  event.respondWith(
    fetch(req).then((networkRes) => {
      // If valid response, clone into cache
      if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
        const resClone = networkRes.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(req, resClone).catch(() => {});
        });
      }
      return networkRes;
    }).catch(() => {
      // Offline fallback: serve from cache if available
      return caches.match(req).then((cached) => {
        if (cached) return cached;
        // Fallback to root if navigating
        if (req.mode === 'navigate') {
          return caches.match('/');
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      });
    })
  );
});
