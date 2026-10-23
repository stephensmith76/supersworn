// Offline cache. Bump VERSION when app files change so old caches are cleared.
const PREFIX = 'ss-';
const VERSION = PREFIX + 'v8';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/store.js', 'js/rules.js', 'js/sync.js', 'js/ai.js', 'js/effects.js',
  'data/starforged.json', 'data/supersworn.json', 'data/villains.json', 'data/rules-notes.md', 'data/guides.json', 'data/app-guide.md',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  // Only touch our own caches: other apps on the same github.io origin share Cache Storage.
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

const timeout = (ms) => new Promise(resolve => setTimeout(() => resolve(null), ms));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const isFont = /^fonts\.(googleapis|gstatic)\.com$/.test(url.hostname);
  if (url.origin !== location.origin && !isFont) return; // leave Firebase and AI traffic alone

  // Fonts never change: cache first.
  if (isFont) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); e.waitUntil(caches.open(VERSION).then(c => c.put(req, copy))); }
      return res;
    }).catch(() => new Response('', { status: 504 }))));
    return;
  }

  // App files: try the network (bypassing the browser's HTTP cache) so updates
  // land right away, but fall back to the cached copy after 3.5 seconds on a weak signal.
  const network = fetch(req, { cache: 'no-cache' }).then(res => {
    if (res.ok) { const copy = res.clone(); e.waitUntil(caches.open(VERSION).then(c => c.put(req, copy))); }
    return res;
  });
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    try {
      if (!cached) return await network;
      const res = await Promise.race([network, timeout(3500)]);
      return res && res.ok ? res : cached;
    } catch {
      return cached || (await caches.match('index.html')) || new Response('Offline', { status: 503 });
    }
  })());
});
