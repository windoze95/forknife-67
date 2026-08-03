/**
 * Offline shell.
 *
 * Sprite data lives in localStorage, so the app is genuinely usable with no
 * signal at all — which matters, because the moment you want to check a sprite
 * is the moment you are mid game on mobile data.
 *
 * Bump CACHE whenever a shell asset changes; the old cache is deleted on
 * activate so a deploy cannot leave a device on stale JS.
 */

const CACHE = 'forknife67-v2.0.0';

const SHELL = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/lib/vault.js',
  '/lib/catalog.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // Individually, so one missing optional asset cannot fail the install.
      .then((cache) => Promise.allSettled(SHELL.map((url) => cache.add(url))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Sync must never be served from cache — a stale vault would look like data
  // loss. Let it fail naturally when offline; the client handles that.
  if (url.pathname.startsWith('/api/')) return;

  // Network first, cache as fallback: the player always gets the newest shell
  // when online, and a working app when not.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // Deep links still need to boot the shell when offline.
        if (request.mode === 'navigate') {
          const shell = await caches.match('/index.html');
          if (shell) return shell;
        }
        return new Response('Offline', { status: 503, statusText: 'Offline' });
      }),
  );
});
