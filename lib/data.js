// Napkin Math — data services for the deal-flow tools.
//   GET/PUT /api/state        a member's saved deals, pipeline, leads and settings (follows them across devices)
//   POST    /api/share        create a read-only link to one deal  →  GET /s/<id> (public page)
//   GET     /api/market?zips= Census ACS figures by ZIP (rents, values, vacancy, income, growth), cached 30 days
//   GET     /api/rentcast?... live rent estimate when RENTCAST_API_KEY is set
import { currentUser, access, json } from './auth.js';

const STATE_MAX = 2_000_000;       // bytes of saved data per member
const SHARE_DAYS = 180;
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;

export async function handleDataApi(req, env, url) {
  const p = url.pathname, m = req.method;
  if (!['/api/state', '/api/share', '/api/market', '/api/rentcast'].includes(p)) return null;
  if (!env.USERS) return json({ error: 'Storage is not set up.' }, 503);
  const me = await currentUser(req, env);
  if (!me || !access(me).ok) return json({ error: 'Sign in first.' }, 401);
  const isJson = (req.headers.get('content-type') || '').includes('application/json');

  if (p === '/api/state') {
    if (me.role === 'test') return json({ error: 'Test logins are view-only.' }, 403);
    const key = 'state:' + me.email.toLowerCase();
    if (m === 'GET') {
      const raw = await env.USERS.get(key);
      return json(raw ? JSON.parse(raw) : { state: null, updatedAt: 0 });
    }
    if (m === 'PUT') {
      if (!isJson) return json({ error: 'Send JSON.' }, 415);
      const text = await req.text();
      if (text.length > STATE_MAX) return json({ error: 'Too much saved data. Remove some leads or deals.' }, 413);
      let body; try { body = JSON.parse(text); } catch { return json({ error: 'Bad JSON.' }, 400); }
      if (!body || typeof body.state !== 'object') return json({ error: 'Missing state.' }, 400);
      const updatedAt = Number(body.updatedAt) || Date.now();
      await env.USERS.put(key, JSON.stringify({ state: body.state, updatedAt }));
      return json({ ok: true, updatedAt });
    }
    return json({ error: 'Use GET or PUT.' }, 405);
  }

  if (p === '/api/share' && m === 'POST') {
    if (me.role === 'test') return json({ error: 'Test logins are view-only.' }, 403);
    if (!isJson) return json({ error: 'Send JSON.' }, 415);
    const text = await req.text();
    if (text.length > 30_000) return json({ error: 'Deal is too large to share.' }, 413);
    let b; try { b = JSON.parse(text); } catch { return json({ error: 'Bad JSON.' }, 400); }
    const d = b && b.deal || {}, q = b && b.metrics || {};
    const clean = {
      name: String(b.name || 'Shared deal').slice(0, 120),
      note: String(b.note || '').slice(0, 600),
      deal: {
        address: String(d.address || '').slice(0, 120), city: String(d.city || '').slice(0, 60), state: String(d.state || '').slice(0, 2),
        zip: String(d.zip || '').slice(0, 10), propertyType: String(d.propertyType || '').slice(0, 30),
        price: num(d.price), units: num(d.units), sqft: num(d.sqft), yearBuilt: num(d.yearBuilt),
        grossRentMonthly: num(d.grossRentMonthly), occupancyPct: num(d.occupancyPct), noi: num(d.noi), capRate: num(d.capRate),
        url: /^https?:\/\//.test(String(d.url || '')) ? String(d.url).slice(0, 400) : '',
      },
      metrics: Object.fromEntries(['noi', 'cap', 'cf', 'coc', 'dscr', 'grm', 'ppu', 'ltv', 'rate', 'est'].map(k => [k, k === 'est' ? !!q[k] : num(q[k])])),
      cur: /^[A-Z]{3}$/.test(String(b.cur || '')) ? String(b.cur) : 'USD',
      by: me.role === 'owner' ? 'Napkin Math' : '', at: Date.now(),
    };
    const id = [...crypto.getRandomValues(new Uint8Array(9))].map(x => 'abcdefghijkmnpqrstuvwxyz23456789'[x % 32]).join('');
    await env.USERS.put('share:' + id, JSON.stringify(clean), { expirationTtl: SHARE_DAYS * 86400 });
    return json({ ok: true, url: url.origin + '/s/' + id, days: SHARE_DAYS });
  }

  if (p === '/api/market' && m === 'GET') {
    const zips = [...new Set((url.searchParams.get('zips') || '').split(/[^0-9]+/).filter(z => /^\d{5}$/.test(z)))].slice(0, 8);
    if (!zips.length) return json({ error: 'Enter 5-digit ZIP codes.' }, 400);
    const out = {};
    for (const z of zips) out[z] = await zipData(env, z);
    return json({ zips: out, source: 'U.S. Census Bureau, American Community Survey 5-year estimates' });
  }

  if (p === '/api/rentcast' && m === 'GET') {
    if (!env.RENTCAST_API_KEY) return json({ available: false });
    const address = (url.searchParams.get('address') || '').slice(0, 200);
    if (!address) return json({ available: true, error: 'Add a full street address.' }, 400);
    const qs = new URLSearchParams({ address, compCount: '8' });
    for (const k of ['bedrooms', 'bathrooms', 'squareFootage', 'propertyType']) { const v = url.searchParams.get(k); if (v) qs.set(k, v.slice(0, 40)); }
    const ck = 'rc:' + qs.toString();
    const hit = await env.USERS.get(ck, 'json');
    if (hit) return json({ available: true, ...hit });
    const r = await fetch('https://api.rentcast.io/v1/avm/rent/long-term?' + qs, { headers: { 'X-Api-Key': env.RENTCAST_API_KEY, accept: 'application/json' } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return json({ available: true, error: j.message || ('RentCast error ' + r.status) }, 502);
    const res = { rent: num(j.rent), low: num(j.rentRangeLow), high: num(j.rentRangeHigh),
      comps: (j.comparables || []).slice(0, 8).map(c => ({ address: String(c.formattedAddress || ''), rent: num(c.price), beds: num(c.bedrooms), baths: num(c.bathrooms), sqft: num(c.squareFootage), distance: num(c.distance), days: num(c.daysOld) })) };
    await env.USERS.put(ck, JSON.stringify(res), { expirationTtl: 7 * 86400 });
    return json({ available: true, ...res });
  }
  return json({ error: 'Not found.' }, 404);
}

// ---------- Census ACS by ZIP ----------
const VARS = {
  rent: 'B25064_001E', r0: 'B25031_002E', r1: 'B25031_003E', r2: 'B25031_004E', r3: 'B25031_005E', r4: 'B25031_006E',
  value: 'B25077_001E', units: 'B25002_001E', vacant: 'B25002_003E', occupied: 'B25003_001E', renters: 'B25003_003E',
  income: 'B19013_001E', pop: 'B01003_001E',
};
const OLD = ['rent', 'value', 'income', 'pop'];
export function parseCensus(rows, keys) {
  if (!Array.isArray(rows) || rows.length < 2) return null;
  const head = rows[0], row = rows[1], o = {};
  keys.forEach(k => { const i = head.indexOf(VARS[k]); const v = i >= 0 ? Number(row[i]) : NaN; o[k] = isFinite(v) && v >= 0 ? v : null; });
  return o;
}
async function acs(env, year, keys, zip) {
  const qs = `get=${keys.map(k => VARS[k]).join(',')}&for=zip%20code%20tabulation%20area:${zip}` + (env.CENSUS_API_KEY ? `&key=${env.CENSUS_API_KEY}` : '');
  const r = await fetch(`https://api.census.gov/data/${year}/acs/acs5?${qs}`, { headers: { accept: 'application/json' } });
  if (!r.ok) return null;
  return parseCensus(await r.json().catch(() => null), keys);
}
export function deriveMarket(now, old, year) {
  const g = (a, b) => (a != null && b ? a / b - 1 : null);
  const vacancy = now.units ? now.vacant / now.units : null;
  return {
    year, rent: now.rent, rentByBeds: [now.r0, now.r1, now.r2, now.r3, now.r4], value: now.value, income: now.income, pop: now.pop,
    vacancy, renterShare: now.occupied ? now.renters / now.occupied : null,
    rentToIncome: now.rent && now.income ? now.rent * 12 / now.income : null,
    priceToRent: now.value && now.rent ? now.value / (now.rent * 12) : null,
    rentGrowth5: old ? g(now.rent, old.rent) : null, valueGrowth5: old ? g(now.value, old.value) : null,
    popGrowth5: old ? g(now.pop, old.pop) : null, incomeGrowth5: old ? g(now.income, old.income) : null,
  };
}
async function zipData(env, zip) {
  const ck = 'mkt:v1:' + zip;
  const hit = await env.USERS.get(ck, 'json');
  if (hit) return hit;
  try {
    let now = null, year = 0;
    for (const y of [2024, 2023]) { now = await acs(env, y, Object.keys(VARS), zip); if (now && now.pop != null) { year = y; break; } }
    if (!now) return { error: 'No Census data for this ZIP.' };
    const old = await acs(env, year - 5, OLD, zip);
    const res = deriveMarket(now, old, year);
    await env.USERS.put(ck, JSON.stringify(res), { expirationTtl: 30 * 86400 });
    return res;
  } catch (e) { return { error: 'Census service unavailable. Try again later.' }; }
}

// ---------- public share page ----------
export async function sharePage(env, id, origin) {
  const d = /^[a-z2-9]{9}$/.test(id) && env.USERS ? await env.USERS.get('share:' + id, 'json') : null;
  const fm = x => { if (x == null) return '—'; try { return (x < 0 ? '−' : '') + new Intl.NumberFormat('en-US', { style: 'currency', currency: (d && d.cur) || 'USD', maximumFractionDigits: 0 }).format(Math.abs(x)); } catch (e) { return (x < 0 ? '−$' : '$') + Math.abs(Math.round(x)).toLocaleString('en-US'); } };
  const pc = x => x == null ? '—' : (x * 100).toFixed(1) + '%';
  const body = !d ? `<div class="card"><h1>This link has expired</h1><p class="muted">Shared deals stay available for ${SHARE_DAYS} days.</p><a class="btn primary" href="/">Go to Napkin Math</a></div>` : (() => {
    const x = d.deal, q = d.metrics, loc = [x.city, x.state, x.zip].filter(Boolean).join(', ');
    const kpi = (l, v, c = '') => `<div class="kpi"><span>${l}</span><b class="${c}">${v}</b></div>`;
    return `<p class="eyebrow">Shared deal${d.by ? ' · ' + esc(d.by) : ''}</p><h1>${esc(d.name)}</h1>
      <p class="muted">${esc([x.propertyType, x.units ? x.units + ' units' : '', loc].filter(Boolean).join(' · '))}</p>
      <div class="kpis">${kpi('Asking price', fm(x.price))}${kpi('NOI / year', fm(q.noi))}${kpi('Cap rate', pc(q.cap))}${kpi('Cash flow / month', fm(q.cf != null ? q.cf / 12 : null), q.cf >= 0 ? 'g' : 'b')}${kpi('Cash-on-cash', pc(q.coc))}${kpi('DSCR', q.dscr == null ? '—' : q.dscr.toFixed(2) + 'x')}${kpi('Price / unit', fm(q.ppu))}${kpi('Gross rent multiplier', q.grm == null ? '—' : q.grm.toFixed(1))}</div>
      <p class="small">Financing assumed: ${q.ltv != null ? Math.round(q.ltv * 100) + '% loan-to-value' : '—'} at ${q.rate != null ? (q.rate * 100).toFixed(2) + '%' : '—'}.${q.est ? ' NOI is estimated from rents and a standard expense ratio because expenses were not disclosed.' : ''}</p>
      ${d.note ? `<div class="note-box">${esc(d.note)}</div>` : ''}
      ${x.url ? `<p><a href="${esc(x.url)}" rel="nofollow noopener" target="_blank">View the original listing</a></p>` : ''}
      <p class="small">Shared ${new Date(d.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}. Screening estimates only; verify with your lender, CPA and attorney.</p>
      <div class="cta"><b>Run the numbers on your own deals</b><span>Paste any listing link into Napkin Math and get cash flow, cap rate and DSCR in minutes.</span><a class="btn primary" href="/">Try Napkin Math</a></div>`;
  })();
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${d ? esc(d.name) + ' — ' : ''}Napkin Math</title><meta name="robots" content="noindex"><meta name="theme-color" content="#1C2230">
<link rel="icon" href="/icons/icon-192.png"><script>try{var t=localStorage.getItem("uwdesk.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}</script>
<link rel="stylesheet" href="/site.css"><script src="/i18n.js?v=1"></script><style>
main{max-width:760px;margin:0 auto;padding:clamp(24px,5vw,48px) 16px 64px}h1{font-size:clamp(26px,4vw,36px);margin:4px 0 6px}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin:22px 0 14px}.kpi{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
.kpi span{display:block;font-size:13px;color:var(--ink-3)}.kpi b{font:800 24px "Archivo",sans-serif}.kpi b.g{color:var(--good)}.kpi b.b{color:var(--bad)}
.note-box{background:var(--surface);border-left:3px solid var(--accent);padding:12px 14px;border-radius:0 8px 8px 0;margin:14px 0}
.cta{margin-top:26px;background:var(--nav);color:var(--nav-ink);border-radius:12px;padding:18px;display:flex;flex-direction:column;gap:8px;align-items:flex-start}.cta b{color:#fff;font-size:17px}</style></head>
<body><header class="top"><div class="wrap"><a class="mk" href="/">NAPKIN <span>MATH</span></a><nav><a class="l" href="/login">Sign in</a><button class="tbtn" type="button" data-theme-btn></button></nav></div></header>
<main>${body}</main><script src="/site.js"></script></body></html>`;
  return new Response(html, { status: d ? 200 : 404, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-robots-tag': 'noindex' } });
}

// ---------- interface translation (public: the home page uses it too) ----------
export const LANG_NAMES = { es: 'Spanish', fr: 'French', pt: 'Portuguese (Brazil)', de: 'German', it: 'Italian', zh: 'Simplified Chinese', ja: 'Japanese', ko: 'Korean', ar: 'Arabic', hi: 'Hindi', vi: 'Vietnamese', tl: 'Filipino (Tagalog)', ru: 'Russian', pl: 'Polish', nl: 'Dutch', tr: 'Turkish' };
const M2M = { es: 'spanish', fr: 'french', pt: 'portuguese', de: 'german', it: 'italian', zh: 'chinese', ja: 'japanese', ko: 'korean', ar: 'arabic', hi: 'hindi', vi: 'vietnamese', ru: 'russian', pl: 'polish', nl: 'dutch', tr: 'turkish', tl: 'tagalog' };
async function hashKey(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].slice(0, 12).map(x => x.toString(16).padStart(2, '0')).join(''); }
export function parseArray(out, n) {
  if (Array.isArray(out)) return out.length === n ? out.map(String) : null;
  const s = String(out || ''), i = s.indexOf('['), j = s.lastIndexOf(']');
  if (i < 0 || j <= i) return null;
  try { const a = JSON.parse(s.slice(i, j + 1)); return Array.isArray(a) && a.length === n ? a.map(x => String(x)) : null; } catch { return null; }
}
export async function handleTranslate(req, env, url, limited) {
  if (url.pathname !== '/api/translate') return null;
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (!(req.headers.get('content-type') || '').includes('application/json')) return json({ error: 'Send JSON.' }, 415);
  const text = await req.text(); if (text.length > 40_000) return json({ error: 'Too much text.' }, 413);
  let b; try { b = JSON.parse(text); } catch { return json({ error: 'Bad JSON.' }, 400); }
  const lang = String(b.lang || ''), texts = Array.isArray(b.texts) ? b.texts.slice(0, 40).map(t => String(t).slice(0, 600)) : [];
  if (!LANG_NAMES[lang] || !texts.length) return json({ error: 'Unknown language.' }, 400);
  if (!env.USERS) return json({ translations: texts });
  if (await limited(env, 'tr:' + (req.headers.get('cf-connecting-ip') || 'x'), 600, 3600)) return json({ translations: texts, limited: true });
  const keys = await Promise.all(texts.map(t => hashKey(lang + '|' + t)));
  const got = await Promise.all(keys.map(k => env.USERS.get('tr:' + k)));
  const miss = texts.map((t, i) => got[i] == null ? i : -1).filter(i => i >= 0);
  if (miss.length && env.AI && !(await limited(env, 'trai', 4000, 86400))) {
    const src = miss.map(i => texts[i]);
    let outArr = null;
    try {
      const r = await env.AI.run(env.CF_AI_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct', { temperature: 0.1, max_tokens: 4000, messages: [
        { role: 'system', content: `You translate user-interface text for "Napkin Math", a U.S. real estate investing web app, into ${LANG_NAMES[lang]}. Input is a JSON array of strings. Reply with ONLY a JSON array of the translated strings, same length and order. Keep unchanged: the brand "Napkin Math", numbers, money amounts, percentages, dates, units like "/mo", acronyms (NOI, DSCR, IRR, LTV, GRM, EGI, T-12, LOI, HOA, NNN, ZIP, CSV, PDF, AI), website names, and any leading or trailing punctuation. Use short, natural wording suitable for buttons and labels. Never add explanations.` },
        { role: 'user', content: JSON.stringify(src) }] });
      outArr = parseArray(typeof r?.response === 'string' || Array.isArray(r?.response) ? r.response : r?.choices?.[0]?.message?.content, src.length);
    } catch (e) { outArr = null; }
    if (!outArr && M2M[lang]) {       // fallback: dedicated translation model, one string at a time
      outArr = [];
      for (const t of src.slice(0, 15)) { try { const r = await env.AI.run('@cf/meta/m2m100-1.2b', { text: t, source_lang: 'english', target_lang: M2M[lang] }); outArr.push(r && r.translated_text ? String(r.translated_text) : null); } catch { outArr.push(null); } }
    }
    if (outArr) await Promise.all(miss.map((idx, j) => { const v = outArr[j]; if (v == null || !v.trim()) return null; got[idx] = v; return env.USERS.put('tr:' + keys[idx], v, { expirationTtl: 90 * 86400 }); }));
  }
  return json({ translations: texts.map((t, i) => got[i] == null ? null : got[i]) });
}
