// Service worker: app works offline at the market; uploads resume when back online.
const VERSION = 'shark-id-v12';
const SHELL = [
  './', 'index.html', 'records.html', 'review.html', 'about.html', 'individuals.html', 'scale-card.html', 'manifest.webmanifest', 'css/app.css?v=6', 'icons/sharkive-wordmark.png?v=2', 'icons/icon-192.png', 'icons/favicon-a-64.png?v=1', 'icons/favicon-a-dark-64.png?v=1',
  'js/app.js?v=12', 'js/camera.js?v=12', 'js/capture.js?v=12', 'js/captcha.js?v=12', 'js/image.js?v=12', 'js/screen.js?v=12', 'js/classifier.js?v=12', 'js/config.js?v=12', 'js/idb.js?v=12', 'js/metadata.js?v=12',
  'js/queue.js?v=12', 'js/records.js?v=12', 'js/review.js?v=12', 'js/species-data.js?v=12', 'js/store.js?v=12', 'js/util.js?v=12',
  'js/visits.js?v=12', 'js/measure.js?v=12', 'js/dwc.js?v=12', 'js/individuals.js?v=12', 'js/photoid.js?v=12', 'js/photoid-core.js?v=12',
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
