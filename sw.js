// Offline support: network-first so updates show up immediately, with the
// cache as a fallback when there's no connection (e.g. at 3am in a dark room).
const CACHE = 'napberry-v6';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'icons/icon.svg',
  'src/styles.css',
  'src/app.js',
  'src/alerts.js',
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
  'supabase/push.sql',
  'supabase/functions/napberry-push/index.ts',
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

// Nap alerts (see src/alerts.js and supabase/push.sql): the push message is JSON { title, body, tag }.
// A browser may only receive pushes that show something, so there is always a notification, even
// if the message couldn't be read.
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    /* show the fallback below */
  }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Napberry', {
      body: data.body || 'Open Napberry to see what is next.',
      tag: data.tag || 'napberry-nap', // a newer alert replaces an older one instead of stacking up
      icon: 'icons/icon-192.png',
      data: { url: './' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => 'focus' in w);
      return open ? open.focus() : self.clients.openWindow(event.notification.data?.url || './');
    }),
  );
});
