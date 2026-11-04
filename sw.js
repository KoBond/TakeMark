// Service Worker: офлайн-работа TakeMark.
// При изменении файлов приложения увеличьте VERSION.
const VERSION = 'takemark-v2';
const RUNTIME = 'takemark-runtime';

const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/gs1.js',
  './js/storage.js',
  './js/scanner.js',
  './js/export.js',
  './js/dmtx.js',
  './js/imgproc.js',
  './js/photo.js',
  './wasm/dmtx.wasm',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

const CDN_HOSTS = ['cdn.jsdelivr.net', 'fastly.jsdelivr.net', 'unpkg.com'];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    // локальная копия декодера (если сборка её положила)
    try {
      const r = await fetch('./vendor/files.json', { cache: 'no-cache' });
      if (r.ok) {
        const files = await r.json();
        await cache.put('./vendor/files.json', new Response(JSON.stringify(files), { headers: { 'Content-Type': 'application/json' } }));
        await Promise.all(files.map(f => cache.add('./vendor/' + f).catch(() => {})));
      }
    } catch { /* нет vendor — декодер возьмётся с CDN */ }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== VERSION && k !== RUNTIME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Страница: сначала сеть, без сети — из кеша
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(VERSION);
        cache.put('./index.html', res.clone());
        return res;
      } catch {
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  // Декодер с CDN: кеш, затем сеть (версии неизменяемые)
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      if (res.ok) (await caches.open(RUNTIME)).put(req, res.clone());
      return res;
    })());
    return;
  }

  // Файлы приложения: отдаём из кеша и обновляем в фоне
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req, { ignoreSearch: true });
      const network = fetch(req).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      }).catch(() => null);
      return cached || (await network) || new Response('', { status: 504 });
    })());
  }
});
