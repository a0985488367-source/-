const V='smc-dojo-v19';
const CORE=['./','index.html','manifest.webmanifest','icon-192.png','icon-512.png','icon-180.png'];
const DATA=["BNB_15m.json", "BNB_1h.json", "BNB_4h.json", "BTC_15m.json", "BTC_1h.json", "BTC_4h.json", "DOGE_15m.json", "DOGE_1h.json", "DOGE_4h.json", "ETH_15m.json", "ETH_1h.json", "ETH_4h.json", "SOL_15m.json", "SOL_1h.json", "SOL_4h.json", "XRP_15m.json", "XRP_1h.json", "XRP_4h.json"].map(f=>'mdata/'+f);
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(CORE).then(()=>c.addAll(DATA).catch(()=>{}))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);if(e.request.method!=='GET')return;
  if(u.origin!==location.origin){if(/fonts\.(googleapis|gstatic)\.com/.test(u.host))e.respondWith(caches.open(V).then(c=>c.match(e.request).then(r=>r||fetch(e.request).then(n=>{c.put(e.request,n.clone());return n}))));return}
  if(u.pathname.endsWith('/')||u.pathname.endsWith('index.html')){e.respondWith(fetch(e.request).then(n=>{const cl=n.clone();caches.open(V).then(c=>c.put(e.request,cl));return n}).catch(()=>caches.match(e.request).then(r=>r||caches.match('index.html'))));return}
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(n=>{const cl=n.clone();caches.open(V).then(c=>c.put(e.request,cl));return n})))});
