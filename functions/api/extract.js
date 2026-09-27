// Cloudflare Pages Function → /api/extract  (set variables in Pages → Settings → Variables and Secrets)
import { extract } from '../../lib/extract-core.js';
export async function onRequestPost({ request, env }) {
  let body = null; try { body = await request.json(); } catch {}
  const out = await extract({ body, headers: request.headers, env });
  return new Response(JSON.stringify(out.body), { status: out.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}
export async function onRequest() { return new Response(JSON.stringify({ error: 'Use POST.' }), { status: 405, headers: { 'content-type': 'application/json' } }); }
