// SMC 道場 2.0：頁面和程式先走網路（拿最新版），行情資料和字型先用快取
const V = 'smc-dojo-v20';
const CORE = ['./', 'index.html', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'icon-180.png',
  'js/app.js', 'js/core.js', 'js/chart.js', 'js/concepts.js', 'js/gen.js', 'js/srs.js', 'js/ui.js', 'js/rogue.js', 'js/ranked.js', 'js/story.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(CORE).catch(() => {})).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
const put = (req, res) => { const cl = res.clone(); caches.open(V).then((c) => c.put(req, cl)); return res; };
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const cacheFirst = /\/mdata\//.test(u.pathname) || /fonts\.(googleapis|gstatic)\.com/.test(u.host);
  if (cacheFirst) { e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request).then((n) => put(e.request, n)))); return; }
  if (u.origin !== location.origin) return;
  e.respondWith(fetch(e.request).then((n) => put(e.request, n)).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
