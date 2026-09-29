// Run anywhere Node 18+ runs:  ANTHROPIC_API_KEY=... APP_PASSCODE=... node server.js
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extract } from './lib/extract-core.js';
const root = fileURLToPath(new URL('./public/', import.meta.url));
const PUBLIC = new Set(['/index.html', '/manifest.webmanifest', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png']);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
const SEC = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
http.createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SEC)) res.setHeader(k, v);
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/extract') {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    if (req.method !== 'POST') { res.statusCode = 405; return res.end('{"error":"Use POST."}'); }
    let raw = '', size = 0;
    for await (const c of req) { size += c.length; if (size > 15e6) { res.statusCode = 413; return res.end('{"error":"Request too large."}'); } raw += c; }
    const out = await extract({ body: raw, headers: req.headers, env: process.env });
    res.statusCode = out.status; return res.end(JSON.stringify(out.body));
  }
  let p = normalize(decodeURIComponent(url.pathname)); if (p === '/' || p === '\\') p = '/index.html';
  if (!PUBLIC.has(p)) p = '/index.html';
  try { const b = await readFile(join(root, p)); res.setHeader('content-type', TYPES[extname(p)] || 'application/octet-stream'); if (p === '/sw.js' || p === '/index.html') res.setHeader('cache-control', 'no-cache'); res.end(b); }
  catch { res.statusCode = 404; res.end('Not found'); }
}).listen(process.env.PORT || 3000, () => console.log('Napkin Math on http://localhost:' + (process.env.PORT || 3000)));
