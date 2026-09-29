// Cloudflare Worker entry.
//   /            public landing page        /login  sign in + sign up        /account  plan, billing, owner tools
//   /app/        the Underwriting Desk (signed-in users with an active plan, the owner, or a live test login)
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
