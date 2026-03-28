// Service Worker — Hive Command PWA
// Auto-update: activates immediately via skipWaiting; uses network-first for navigations for freshness.

const CACHE_VERSION = 'hive-v6';

// Core app shell assets (must succeed for install)
const CORE_ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './manifest.json'
];

// Optional third-party assets (failures won't block install)
const OPTIONAL_ASSETS = [
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/marked/9.1.6/marked.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.0.6/purify.min.js',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Orbitron:wght@500;700;900&display=swap'
];

// Offline fallback HTML
const OFFLINE_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hive Command — Offline</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#07050e;color:#e8d5ff;font-family:monospace;
display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center}
.wrap{padding:2rem}.icon{font-size:3rem;margin-bottom:1rem}h1{font-size:1.2rem;color:#b041ff;margin-bottom:.5rem}
p{color:#b090d8;font-size:.85rem;line-height:1.5}
button{margin-top:1.5rem;background:#b041ff;color:#fff;border:none;border-radius:4px;padding:10px 24px;
font-family:inherit;cursor:pointer;text-transform:uppercase;letter-spacing:1px}
button:hover{filter:brightness(1.2)}</style></head>
<body><div class="wrap"><div class="icon">◈</div><h1>HIVE OFFLINE</h1>
<p>Network connection unavailable.<br>Cached data may be stale.</p>
<button onclick="location.reload()">Retry Connection</button></div></body></html>`;

// Install: cache core assets, then optionally cache CDN assets
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(cache =>
      cache.addAll(CORE_ASSETS).then(() =>
        Promise.allSettled(
          OPTIONAL_ASSETS.map(url =>
            fetch(url).then(res => {
              if (res.ok) return cache.put(url, res);
            }).catch(() => {})
          )
        )
      ).then(() =>
        cache.put('offline', new Response(OFFLINE_HTML, {
          headers: { 'Content-Type': 'text/html' }
        }))
      )
    ).then(() => self.skipWaiting())
  );
});

// Activate: purge old caches, claim clients immediately
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// Fetch: network-first for navigation (HTML), cache-first for assets
self.addEventListener('fetch', e => {
  const req = e.request;

  // Navigation requests (HTML pages) — always try network first for freshness
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, clone));
          return res;
        })
        .catch(() =>
          caches.match(req)
            .then(resp => resp || caches.match('./'))
            .then(resp => resp || caches.match('./index.html'))
            .then(resp => resp || caches.match('offline'))
            .then(resp => resp || new Response('Offline', {
              status: 503,
              headers: { 'Content-Type': 'text/plain' }
            }))
        )
    );
    return;
  }

  // API calls (supabase.co) — NEVER cache, always network
  if (req.url.includes('supabase.co')) {
    e.respondWith(fetch(req));
    return;
  }

  // Other assets (JS, CSS, fonts, icons) — cache first, fallback to network
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE_VERSION).then(c => c.put(req, clone));
        }
        return res;
      });
    })
  );
});
