// Offline shell: once you've opened the desk signed in, the calculators work without a connection.
// Pages are network-first (so sign-in checks always run when online); static files are cache-first.
const CACHE = 'uwdesk-v3';
const STATIC = ['/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/site.css', '/site.js'];
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
  const cacheable = u.origin === location.origin || u.hostname.endsWith('gstatic.com') || u.hostname.endsWith('googleapis.com');
  if (!cacheable) return;
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(r => {
    if (r.ok) { const c = r.clone(); caches.open(CACHE).then(x => x.put(req, c)); }
    return r;
  })));
});
