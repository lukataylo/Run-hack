// sw.js — service worker: makes the installed web app work with no signal,
// which is the same reason the native shell bundles the files. Network-first
// for the page (so a redeploy is picked up), cache-first for static assets.
// Bumping this purges every old cache on activate. It must change whenever the
// caching STRATEGY changes; app code no longer depends on it (see below).
const CACHE = 'formcoach-v2';

// The app shell. Audio and vendor blobs are cached lazily on first use so the
// install is fast; a missing clip degrades to the device voice by design.
const SHELL = [
  '/', '/index.html', '/coach.js', '/session.js', '/voice.js', '/persona.js',
  '/head.js', '/phone.js', '/bot.js', '/bot-data.js', '/body.js', '/music.js',
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
  // Live endpoints must never be served stale. Belt AND braces: name them, and
  // then refuse to cache anything without a file extension — every dynamic
  // route here is extensionless, so a new endpoint can't silently get cached
  // the way /live/ did.
  if (/^\/(telemetry|sync|live|hello|devices|tts|bodyimage)/.test(url.pathname)) return;
  const looksStatic = /\.[a-z0-9]{2,5}$/i.test(url.pathname) || url.pathname === '/';
  if (!looksStatic) return;

  // Network-first for the page AND all app code. Cache-first would pin a stale
  // module forever: a redeploy would hand the phone a NEW index.html running
  // against OLD js, which breaks the moment the two disagree about a function.
  // Only big immutable blobs (vendor libs, audio clips, models, icons) are
  // cache-first — they are content-stable and expensive to refetch.
  const immutable = /^\/(vendor|audio|assets)\//.test(url.pathname);
  const isDoc = request.mode === 'navigate' || url.pathname === '/' || url.pathname.endsWith('.html');
  const isCode = url.pathname.endsWith('.js') || url.pathname.endsWith('.webmanifest');

  if (isDoc || (isCode && !immutable)) {
    e.respondWith(
      fetch(request).then((r) => {
        const copy = r.clone();
        caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
        return r;
      }).catch(() => caches.match(request).then((r) => r || (isDoc ? caches.match('/index.html') : undefined)))
    );
    return;
  }
  // cache-first for the immutable blobs, filling the cache as files are used
  e.respondWith(
    caches.match(request).then((hit) => hit || fetch(request).then((r) => {
      const copy = r.clone();
      caches.open(CACHE).then((c) => c.put(request, copy)).catch(() => {});
      return r;
    }).catch(() => hit))
  );
});
