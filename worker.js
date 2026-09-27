// Cloudflare Worker entry: serves the app from /public and the listing reader at /api/extract.
import { extract } from './lib/extract-core.js';

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/extract') {
      if (request.method !== 'POST') return json({ error: 'Use POST.' }, 405);
      let body = null; try { body = await request.json(); } catch {}
      const out = await extract({ body, headers: request.headers, env });
      return json(out.body, out.status);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found.' }, 404);
    return env.ASSETS.fetch(request);
  },
};
