// Cloudflare Worker entry.
//   /            public landing page        /login  sign in + sign up        /account  plan, billing, owner tools
//   /app/        Napkin Math (signed-in users with an active plan, the owner, or a live test login)
//   /api/*       accounts + billing (lib/auth.js) and the listing reader /api/extract (lib/extract-core.js)
import { extract } from './lib/extract-core.js';
import { handleAuthApi, currentUser, access, json, redirect, limited } from './lib/auth.js';
import { handleDataApi, sharePage } from './lib/data.js';

const PRIVATE = { 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const VIEWER_BOOT = `<script nonce="__NONCE__">window.UW_VIEWER=1;(function(){try{var S=Storage.prototype,g=S.getItem,s=S.setItem,r=S.removeItem,m={},L=window.localStorage;
function own(t,k){return t===L&&typeof k==='string'&&k.indexOf('uwdesk.')===0&&k!=='uwdesk.theme';}
S.getItem=function(k){return own(this,k)?(Object.prototype.hasOwnProperty.call(m,k)?m[k]:null):g.call(this,k);};
S.setItem=function(k,v){if(own(this,k)){m[k]=String(v);return;}return s.call(this,k,v);};
S.removeItem=function(k){if(own(this,k)){delete m[k];return;}return r.call(this,k);};}catch(e){}})();</script>`;
const NOSTORE = { ...PRIVATE, 'cache-control': 'no-store' };
const withHeaders = (res, h) => { const r = new Response(res.body, res); for (const [k, v] of Object.entries(h)) r.headers.set(k, v); return r; };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    // Block cross-site state changes (defence in depth on top of SameSite cookies and JSON-only APIs)
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && url.pathname !== '/api/stripe-webhook') {
      const origin = request.headers.get('origin'), site = request.headers.get('sec-fetch-site');
      if ((origin && origin !== url.origin) || site === 'cross-site') return harden(json({ error: 'Cross-site request blocked.' }, 403), url);
    }
    let res;
    try { res = await route(request, env, url); }
    catch (e) { res = json({ error: 'Server error.' }, 500); }
    return harden(res, url);
  },
};

async function route(request, env, url) {
    const path = url.pathname;

    if (path === '/api/extract') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      const me = await currentUser(request, env);
      if (!access(me).ok) return json({ error: me ? 'Your plan isn’t active. Open Account to renew.' : 'Your session ended. Sign in again.' }, 401);
      if (me.role === 'test') return json({ error: 'Test logins are view-only, so listing import is turned off.' }, 403);
      if (me.role !== 'owner' && await limited(env, 'extract:' + me.email, 150, 86400)) return json({ error: 'Daily import limit reached (150). It resets within 24 hours.' }, 429);
      let body = null; try { body = await request.json(); } catch {}
      const out = await extract({ body, headers: request.headers, env: { ...env, APP_PASSCODE: '' } }); // session replaces the passcode
      return json(out.body, out.status);
    }
    // Voiceover for the home-page ad: a neural voice (Workers AI, Deepgram Aura 2), generated once and kept in KV.
    const av = path.match(/^\/api\/ad-voice\/([0-4])$/);
    if (av && request.method === 'GET') return adVoice(env, +av[1]);
    const shareM = path.match(/^\/s\/([a-z2-9]{9})$/);
    if (shareM && request.method === 'GET') return sharePage(env, shareM[1], url.origin);
    const data = await handleDataApi(request, env, url);
    if (data) return data;
    if (path.startsWith('/api/')) {
      try {
        const res = await handleAuthApi(request, env, url);
        return res || json({ error: 'Not found.' }, 404);
      } catch (e) { return json({ error: 'Server error.' }, 500); }
    }

    // Old installs and share links pointed at "/#…" — send them into the app
    if (path === '/' && (url.searchParams.has('url') || url.searchParams.has('text'))) {
      const me = await currentUser(request, env);
      if (me) return redirect('/app/' + url.search);
    }

    if (path === '/app' || path === '/app/index.html') return redirect('/app/' + url.search);
    if (path.startsWith('/app/')) {
      const me = await currentUser(request, env);
      if (!me) return redirect('/login?next=' + encodeURIComponent(path + url.search));
      if (!access(me).ok) return redirect('/account');
      // Fetch without the browser's cache validators so every account always gets its own copy of the page
      const h = new Headers(request.headers); h.delete('if-none-match'); h.delete('if-modified-since');
      const res = await env.ASSETS.fetch(new Request(request.url, { method: request.method, headers: h }));
      // Testers get a fresh desk on every visit: saved deals and inputs in this browser are hidden from them
      // (kept in memory only), so they always start from the example numbers and never see or change anyone's data.
      if (me.role === 'test' && (res.headers.get('content-type') || '').includes('text/html'))
        return withHeaders(res, { ...NOSTORE, 'x-viewer-boot': '1' }); // harden() injects the viewer script with its nonce
      return withHeaders(res, NOSTORE);
    }
    if (path === '/account' || path === '/account.html') {
      const me = await currentUser(request, env);
      if (!me) return redirect('/login?next=/account');
      if (path === '/account.html') return redirect('/account');
      return withHeaders(await env.ASSETS.fetch(request), PRIVATE);
    }
    if (path === '/login' || path === '/signup') {
      const me = await currentUser(request, env);
      if (me && access(me).ok && !url.searchParams.has('switch')) return redirect('/app/');
      if (path === '/signup') return redirect('/login?mode=signup' + (url.searchParams.get('plan') ? '&plan=' + url.searchParams.get('plan') : ''));
    }
    return env.ASSETS.fetch(request);
}

// ----- ad voiceover -----
export const AD_LINES = [
  'Found a deal you like? Skip the late night in spreadsheets.',
  'Just paste the listing link into Napkin Math, and tap Analyze.',
  'In a couple of minutes, you’ve got the numbers that matter: cap rate, cash flow, cash-on-cash, and debt coverage.',
  'Sixteen underwriting tools fill in at once, from five-year returns all the way to due diligence.',
  'Try it free, or get started today for thirty dollars a week.',
];
const AD_VER = 'v2';
async function adVoice(env, n) {
  const speaker = (env.AD_VOICE || 'thalia').toLowerCase().replace(/[^a-z]/g, '');
  const key = `adv:${AD_VER}:${speaker}:${n}`;
  const headers = { 'content-type': 'audio/mpeg', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' };
  try {
    if (env.USERS) { const hit = await env.USERS.get(key, 'arrayBuffer'); if (hit && hit.byteLength > 1000) return new Response(hit, { headers }); }
    if (!env.AI) return json({ error: 'No AI binding.' }, 503);
    if (await limited(env, 'adgen', 40, 86400)) return json({ error: 'Voice busy.' }, 503);
    const out = await env.AI.run('@cf/deepgram/aura-2-en', { text: AD_LINES[n], speaker, encoding: 'mp3' });
    let buf;
    if (out instanceof ReadableStream || out instanceof Response) buf = await new Response(out.body || out).arrayBuffer();
    else if (out instanceof ArrayBuffer) buf = out;
    else if (out && out.audio) buf = Uint8Array.from(atob(out.audio), c => c.charCodeAt(0)).buffer;
    if (!buf || buf.byteLength < 1000) return json({ error: 'No audio returned.' }, 502);
    if (env.USERS) await env.USERS.put(key, buf);
    return new Response(buf, { headers });
  } catch (e) { return json({ error: 'Voice unavailable.' }, 502); }
}

// ----- security headers on every response -----
const BASE_HEADERS = {
  'strict-transport-security': 'max-age=31536000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'x-frame-options': 'DENY',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
};
function csp(nonce) {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "object-src 'none'",
    "form-action 'self'",
    'upgrade-insecure-requests',
  ].join('; ');
}
function harden(res, url) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(BASE_HEADERS)) if (k !== 'referrer-policy' || !h.has(k)) h.set(k, v);
  if (url.pathname.startsWith('/api/')) h.set('cache-control', h.get('cache-control') || 'no-store');
  const isHtml = (h.get('content-type') || '').includes('text/html');
  if (!isHtml || res.status === 101) return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  // Every inline <script> on our pages gets a one-time nonce; anything injected without it will not run.
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  h.set('content-security-policy', csp(nonce));
  h.delete('content-length'); h.delete('etag');
  const viewer = h.get('x-viewer-boot'); h.delete('x-viewer-boot');
  const out = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  let rw = new HTMLRewriter().on('script', { element(el) { el.setAttribute('nonce', nonce); } });
  if (viewer) rw = rw.on('head', { element(el) { el.prepend(VIEWER_BOOT.replace('__NONCE__', nonce), { html: true }); } });
  return rw.transform(out);
}
