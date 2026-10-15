// SMC 教練 App 的離線快取：一律先拿網路上最新的（規則改了馬上生效），連不到才用快取
const V = 'smc-coach-v5';
const CORE = ['./', 'index.html', 'app.js', 'extras.js', 'manifest.webmanifest', 'icon-180.png', 'icon-192.png', 'icon-512.png', '../src/smc/coach.js', '../src/smc/sessions.js'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('smc-coach-') && k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) {
    if (/fonts\.(googleapis|gstatic)\.com/.test(u.host)) e.respondWith(caches.open(V).then((c) => c.match(e.request).then((r) => r || fetch(e.request).then((n) => { c.put(e.request, n.clone()); return n; }))));
    return; // 交易所行情不快取
  }
  e.respondWith(fetch(e.request).then((n) => { if (n.ok) { const cl = n.clone(); caches.open(V).then((c) => c.put(e.request, cl)); } return n; }).catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});
