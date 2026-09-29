// Offline shell: once you've opened Napkin Math signed in, the calculators work without a connection.
// Pages are network-first (so sign-in checks always run when online); static files are cache-first.
const CACHE = 'napkinmath-v5';
const STATIC = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/site.css', '/site.js', '/i18n.js?v=1'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(STATIC)).catch(() => {}).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const req = e.request, u = new URL(req.url);
  if (req.method !== 'GET' || u.pathname.startsWith('/api/')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then(r => {
      // Cache only real pages served at the address asked for (not a redirect to sign-in)
      if (r.ok && !r.redirected && u.origin === location.origin) { const c = r.clone(); caches.open(CACHE).then(x => x.put(u.pathname, c)); }
      return r;
    }).catch(() => caches.match(u.pathname).then(hit => hit || caches.match('/app/'))));
    return;
  }
  if (u.origin === location.origin) {        // our own files: always try the network first so updates arrive right away
    e.respondWith(fetch(req).then(r => { if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); } return r; })
      .catch(() => caches.match(req)));
    return;
  }
  if (!(u.hostname.endsWith('gstatic.com') || u.hostname.endsWith('googleapis.com'))) return;
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {   // fonts rarely change: cache first
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
    return r;
  })));
});
