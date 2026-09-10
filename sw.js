/* sw.js — the Service Worker.
 *
 * This is what makes the app work with no internet connection. The browser
 * runs it in the background, separately from the page.
 *
 * CACHING STRATEGY: network-first, falling back to cache.
 *
 * On every request it tries the network first and quietly refreshes its stored
 * copy with whatever comes back. If the network fails — aeroplane, tunnel, no
 * signal — it serves the last good copy instead.
 *
 * The reason for network-first rather than the more common cache-first: with
 * cache-first, an edit to any file keeps showing the OLD version until the
 * cache is manually cleared, which means hard-refreshing after every change.
 * Network-first means changes simply appear, while offline still works.
 * The cost is a slightly slower load when online, which is imperceptible for
 * files this small.
 *
 * Bumping CACHE_VERSION is still good practice on a release, but it is no
 * longer required to see your changes.
 */

const CACHE_VERSION = 'scheduler-v6';

// Relative paths on purpose, so the app works both at a domain root and in a
// subfolder (e.g. username.github.io/Scheduler/).
const FILES_TO_CACHE = [
  '.',
  'index.html',
  'css/styles.css',
  'css/figures.css',
  'js/app.js',
  'js/store.js',
  'js/priority.js',
  'js/timeline.js',
  'js/tasks.js',
  'js/campus.js',
  'js/figures.js',
  'js/map.js',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'vendor/qrcode.js',
  'data/dining.json',
  'data/starter-schedule.json',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

// --- Install: pre-download the whole app so the first offline load works ---
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      // Individually, so one missing file cannot fail the entire install.
      .then((cache) => Promise.allSettled(
        FILES_TO_CACHE.map((file) => cache.add(file))
      ))
      // Take over immediately rather than waiting for every tab to close.
      .then(() => self.skipWaiting())
  );
});

// --- Activate: bin caches left behind by earlier versions ---
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((n) => n !== CACHE_VERSION).map((n) => caches.delete(n))
      ))
      .then(() => self.clients.claim())
  );
});

// --- Fetch: network first, cache as the safety net ---
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle our own GETs. Anything else goes straight to the network.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Stash a fresh copy for the next time we are offline. The clone is
        // required because a response body can only be read once.
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        // Offline. Serve the stored copy.
        const cached = await caches.match(request);
        if (cached) return cached;

        // A page request with nothing cached: hand back the app shell so the
        // user sees the app rather than the browser's error page.
        if (request.mode === 'navigate') {
          return caches.match('index.html');
        }

        return new Response('', { status: 504, statusText: 'Offline' });
      })
  );
});

// --- Notification clicks: focus the existing window, don't open a new tab ---
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clients) => {
        for (const client of clients) {
          if ('focus' in client) return client.focus();
        }
        if (self.clients.openWindow) return self.clients.openWindow('.');
      })
  );
});
