// Service worker: app works offline at the market; uploads resume when back online.
const VERSION = 'shark-id-v10';
const SHELL = [
  './', 'index.html', 'records.html', 'review.html', 'about.html', 'manifest.webmanifest', 'css/app.css?v=5', 'icons/sharkive-wordmark.png?v=2', 'icons/icon-192.png', 'icons/favicon-a-64.png?v=1', 'icons/favicon-a-dark-64.png?v=1',
  'js/app.js', 'js/camera.js', 'js/capture.js', 'js/captcha.js', 'js/image.js', 'js/screen.js', 'js/classifier.js', 'js/config.js', 'js/idb.js', 'js/metadata.js',
  'js/queue.js', 'js/records.js', 'js/review.js', 'js/species-data.js', 'js/store.js', 'js/util.js',
];
// Libraries and model weights: cache on first use, then serve from cache.
const CACHE_FIRST_HOSTS = ['cdn.jsdelivr.net', 'tfhub.dev', 'www.kaggle.com', 'storage.googleapis.com', 'kaggle.com'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (CACHE_FIRST_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') c.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (url.origin === self.location.origin) {
    // network first so updates arrive; cache fallback offline
    e.respondWith(fetch(req, { cache: 'no-cache' }).then(res => {
      if (res.ok) caches.open(VERSION).then(c => c.put(req, res.clone()));
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
  }
  // everything else (Supabase API, map tiles) goes straight to the network
});
