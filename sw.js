// Service Worker: офлайн-работа TakeMark.
// Должна совпадать с версией в index.html (#app-version и var V) — это проверяет тест.
// Смена версии заставляет телефоны скачать обновлённые файлы.
const VERSION = 'takemark-1.4.1';
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
  './js/dmtx-worker.js',
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
    // cache: 'reload' — мимо HTTP-кеша браузера (GitHub Pages кеширует файлы на 10 минут)
    await cache.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })));
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

  // Файлы приложения: сначала сеть (новая версия видна сразу), без сети или при медленной сети — кеш
  if (url.origin === self.location.origin) {
    event.respondWith((async () => {
      const cache = await caches.open(VERSION);
      const network = fetch(req, { cache: 'no-cache' }).then(res => {
        if (res.ok) cache.put(req, res.clone());
        return res;
      });
      const cached = await cache.match(req, { ignoreSearch: true });
      if (!cached) return network.catch(() => new Response('', { status: 504 }));
      // ждём сеть не дольше 2,5 с, иначе отдаём кеш (сеть всё равно обновит его в фоне)
      const timeout = new Promise(resolve => setTimeout(() => resolve(cached), 2500));
      return Promise.race([network.catch(() => cached), timeout]);
    })());
  }
});
