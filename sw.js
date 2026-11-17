/* Offline support: network-first for app files, falling back to cache. */
const CACHE = 'aitrack-v2';
const ASSETS = ['./', 'index.html', 'css/style.css', 'js/config.js', 'js/utils.js', 'js/store.js', 'js/cloud.js', 'js/charts.js', 'js/app.js', 'icon.svg', 'manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

const LIB = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@';

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // The pinned Supabase library never changes: serve it cache-first so the app starts offline.
  if (e.request.url.startsWith(LIB)) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
      return res;
    })));
    return;
  }
  // Never cache API / auth calls or other origins.
  if (new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
      .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html')))
  );
});
