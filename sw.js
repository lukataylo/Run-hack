// sw.js — service worker: makes the installed web app work with no signal,
// which is the same reason the native shell bundles the files. Network-first
// for the page (so a redeploy is picked up), cache-first for static assets.
const CACHE = 'formcoach-v1';

// The app shell. Audio and vendor blobs are cached lazily on first use so the
// install is fast; a missing clip degrades to the device voice by design.
const SHELL = [
  '/', '/index.html', '/coach.js', '/session.js', '/voice.js', '/persona.js',
  '/head.js', '/bot.js', '/bot-data.js', '/body.js', '/music.js',
  '/manifest.webmanifest', '/assets/icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  // addAll fails the whole install if any single file 404s — add individually
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(
    SHELL.map((u) => c.add(u).catch(() => {}))
  )).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return; // never cache telemetry/sync/tts POSTs
  const url = new URL(request.url);
  if (url.origin !== location.origin) return;
  // live endpoints must never be served stale
  if (/^\/(telemetry|sync|hello|devices|tts|bodyimage)/.test(url.pathname)) return;

  const isDoc = request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  if (isDoc) {
    // network-first: a redeploy must reach the runner on the next launch
    e.respondWith(
      fetch(request).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(request).then((r) => r || caches.match('/index.html')))
    );
    return;
  }
  // cache-first for everything else, filling the cache as files are used
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      return r;
    }).catch(() => hit))
  );
});
