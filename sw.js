/* ROSHCAM service worker — instant repeat loads, offline-tolerant assets.
   Strategy:
   - the app shell (index.html / navigations): network-first, so a deploy is
     picked up immediately; cache is only the offline fallback
   - images (webp/png/svg): stale-while-revalidate — served from cache
     instantly, refreshed in the background so art changes still roll out
   - audio (mp3) + fonts: cache-first — these are big, immutable per release,
     and re-downloading them every visit wastes data on slow devices. Ship a
     changed sound by bumping VERSION (the old cache is purged on activate). */
const VERSION = 'rosham-v2.0.0';
const ASSET_CACHE = VERSION + '-assets';
const PAGE_CACHE = VERSION + '-pages';

const PRECACHE = [
  'logo.webp', 'logo.png', 'unranked.webp',
  'rock.webp', 'paper.webp', 'scissors.webp', 'xptoken.webp',
  'bronze.webp', 'silver.webp', 'gold.webp', 'platinum.webp', 'diamond.webp',
  'master.webp', 'grandmaster.webp', 'champion.webp', 'legend.webp',
  // installable-app icons (home screen / task switcher / splash)
  'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png',
  'apple-touch-icon-180.png',
];

// Warmed after activation WITHOUT blocking install/claim — a slow connection
// should never delay the SW taking control just because match SFX are still
// downloading.
const WARM = [
  'sfxmatchfound.mp3', 'sfxcountdown.mp3', 'sfxrankup.mp3',
  'menumusic.mp3', 'prestige.mp3', 'sfxlegend.mp3',
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
      .then(() => caches.open(ASSET_CACHE).then(async (c) => {
        // Best-effort audio warm-up — one at a time, never fatal.
        for(const url of WARM){
          try { if(!(await c.match(url))) await c.add(url); } catch(err){}
        }
      }))
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

  // Audio + fonts: cache-first (immutable per VERSION)
  if(/\.(mp3|woff2?)$/.test(url.pathname)){
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if(res && res.ok){
          const copy = res.clone();
          caches.open(ASSET_CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }))
    );
    return;
  }

  // Images: stale-while-revalidate
  if(/\.(png|jpg|jpeg|webp|gif|svg)$/.test(url.pathname)){
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

/* ===== Web Push =====
   Standards-compliant push display + click routing. The client subscribes via
   pushManager (see subscribeWebPush() in the app) and stores the subscription;
   a backend with the matching VAPID private key sends the actual pushes. */
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(_){ try { data = { body: e.data.text() }; } catch(__){} }
  const title = data.title || 'ROSHCAM';
  const opts = {
    body: data.body || '',
    icon: data.icon || 'icon-192.png',
    badge: 'icon-192.png',
    tag: data.tag || 'roshcam-push',
    renotify: !!data.renotify,
    data: { url: data.url || '/', ...(data.data || {}) },
    vibrate: data.vibrate || [40, 30, 60],
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for(const c of list){
        if('focus' in c){ c.postMessage({ type: 'notification-click', data: e.notification.data || {} }); return c.focus(); }
      }
      if(self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});
