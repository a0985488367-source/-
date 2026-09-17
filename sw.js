/**
 * Service Worker — 讓 App 可離線啟動（加到 iPhone 主畫面後也能在無網路時打開）
 *
 * 策略：
 *  - 同源的程式檔案：stale-while-revalidate（先給快取、背景更新）
 *  - 導覽請求（開啟 App）：network-first，失敗時回退快取的 index.html
 *  - 跨來源請求（交易所 API / WebSocket）：完全不攔截，直接走網路
 */

const VERSION = 'smc-terminal-v3';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'assets/styles/main.css',
  'assets/icons/icon-192.png',
  'assets/icons/icon-512.png',
  'assets/icons/apple-touch-icon.png',
  'src/app.js',
  'src/core/utils.js',
  'src/core/indicators.js',
  'src/core/store.js',
  'src/core/bus.js',
  'src/data/providers.js',
  'src/data/feed.js',
  'src/smc/swings.js',
  'src/smc/structure.js',
  'src/smc/orderblocks.js',
  'src/smc/fvg.js',
  'src/smc/liquidity.js',
  'src/smc/zones.js',
  'src/smc/sessions.js',
  'src/smc/engine.js',
  'src/smc/setups.js',
  'src/smc/mtf.js',
  'src/smc/backtest.js',
  'src/chart/chart.js',
  'src/chart/layers.js',
  'src/chart/scales.js',
  'src/chart/theme.js',
  'src/ui/dom.js',
  'src/ui/panels.js',
  'src/ui/scanner.js',
  'src/ui/alerts.js',
  'src/ui/glossary.js',
  'src/i18n/index.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // 個別加入，單一檔案失敗不會讓整個安裝失敗
      await Promise.all(
        SHELL.map((path) =>
          cache.add(new Request(new URL(path, self.registration.scope), { cache: 'reload' })).catch(() => {}),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // 交易所 API 等跨來源請求一律不快取、不攔截
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(req);
          const cache = await caches.open(VERSION);
          cache.put(new URL('index.html', self.registration.scope), fresh.clone());
          return fresh;
        } catch {
          const cache = await caches.open(VERSION);
          return (
            (await cache.match(new URL('index.html', self.registration.scope))) ||
            (await cache.match(new URL('./', self.registration.scope))) ||
            Response.error()
          );
        }
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const cached = await cache.match(req);
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        })
        .catch(() => null);
      return cached || (await network) || Response.error();
    })(),
  );
});
