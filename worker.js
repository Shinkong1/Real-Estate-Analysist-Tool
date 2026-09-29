// Cloudflare Worker entry.
//   /            public landing page        /login  sign in + sign up        /account  plan, billing, owner tools
//   /app/        Napkin Math (signed-in users with an active plan, the owner, or a live test login)
//   /api/*       accounts + billing (lib/auth.js) and the listing reader /api/extract (lib/extract-core.js)
import { extract } from './lib/extract-core.js';
import { handleAuthApi, currentUser, access, json, redirect } from './lib/auth.js';

const PRIVATE = { 'cache-control': 'private, no-cache', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
const VIEWER_BOOT = `<script>window.UW_VIEWER=1;(function(){try{var S=Storage.prototype,g=S.getItem,s=S.setItem,r=S.removeItem,m={},L=window.localStorage;
function own(t,k){return t===L&&typeof k==='string'&&k.indexOf('uwdesk.')===0&&k!=='uwdesk.theme';}
S.getItem=function(k){return own(this,k)?(Object.prototype.hasOwnProperty.call(m,k)?m[k]:null):g.call(this,k);};
S.setItem=function(k,v){if(own(this,k)){m[k]=String(v);return;}return s.call(this,k,v);};
S.removeItem=function(k){if(own(this,k)){delete m[k];return;}return r.call(this,k);};}catch(e){}})();</script>`;
const NOSTORE = { ...PRIVATE, 'cache-control': 'no-store' };
const withHeaders = (res, h) => { const r = new Response(res.body, res); for (const [k, v] of Object.entries(h)) r.headers.set(k, v); return r; };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/api/extract') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      const me = await currentUser(request, env);
      if (!access(me).ok) return json({ error: me ? 'Your plan isn’t active. Open Account to renew.' : 'Your session ended. Sign in again.' }, 401);
      if (me.role === 'test') return json({ error: 'Test logins are view-only, so listing import is turned off.' }, 403);
      let body = null; try { body = await request.json(); } catch {}
      const out = await extract({ body, headers: request.headers, env: { ...env, APP_PASSCODE: '' } }); // session replaces the passcode
      return json(out.body, out.status);
    }
    // Voiceover for the home-page ad: a neural voice (Workers AI, Deepgram Aura 2), generated once and kept in KV.
    const av = path.match(/^\/api\/ad-voice\/([0-4])$/);
    if (av && request.method === 'GET') return adVoice(env, +av[1]);
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
        return withHeaders(new HTMLRewriter().on('head', { element(e) { e.prepend(VIEWER_BOOT, { html: true }); } }).transform(res), NOSTORE);
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
  },
};

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
