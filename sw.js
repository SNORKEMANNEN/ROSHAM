/* ROSHCAM service worker — instant repeat loads, offline-tolerant assets.
   Strategy:
   - the app shell (index.html / navigations): network-first, so a deploy is
     picked up immediately; cache is only the offline fallback
   - static assets (images / audio): stale-while-revalidate — served from
     cache instantly, refreshed in the background */
const VERSION = 'rosham-v1.3.0';
const ASSET_CACHE = VERSION + '-assets';
const PAGE_CACHE = VERSION + '-pages';

const PRECACHE = [
  'logo.png', 'unranked.png',
  'rock.png', 'paper.png', 'scissors.png',
  'bronze.png', 'silver.png', 'gold.png', 'platinum.png', 'diamond.png',
  'master.png', 'grandmaster.png', 'champion.png', 'legend.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(ASSET_CACHE)
      .then((c) => c.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  if(url.origin !== location.origin) return; // never touch Firebase/CDN traffic

  // App shell: network-first with cached fallback
  if(req.mode === 'navigate'){
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(PAGE_CACHE).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('index.html')))
    );
    return;
  }

  // Static assets: stale-while-revalidate
  if(/\.(png|jpg|jpeg|webp|gif|svg|mp3|woff2?)$/.test(url.pathname)){
    e.respondWith(
      caches.match(req).then((hit) => {
        const refresh = fetch(req)
          .then((res) => {
            if(res && res.ok){
              const copy = res.clone();
              caches.open(ASSET_CACHE).then((c) => c.put(req, copy)).catch(() => {});
            }
            return res;
          })
          .catch(() => hit);
        return hit || refresh;
      })
    );
  }
});
