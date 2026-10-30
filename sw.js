// Offline support: network-first so updates show up immediately, with the
// cache as a fallback when there's no connection (e.g. at 3am in a dark room).
const CACHE = 'napberry-v5';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'src/styles.css',
  'src/app.js',
  'src/analysis.js',
  'src/csv.js',
  'src/huckleberry.js',
  'src/learn.js',
  'src/norms.js',
  'src/planner.js',
  'src/predict.js',
  'src/recovery.js',
  'src/settings.js',
  'src/shift.js',
  'src/store.js',
  'src/sync.js',
  'src/time.js',
  'supabase/setup.sql',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html'))),
  );
});
