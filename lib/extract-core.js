// Underwriting Desk — listing reader core (host-neutral).
// extract({ body, headers, env }) -> { status, body }
// AI (first one configured wins): ANTHROPIC_API_KEY | GEMINI_API_KEY | Cloudflare Workers AI (env.AI binding,
//   or CF_ACCOUNT_ID + CF_API_TOKEN).  Headless browser: CF_ACCOUNT_ID + CF_API_TOKEN (Cloudflare Browser Run).
// Other: APP_PASSCODE, SCRAPER_URL, USE_WEB_TOOLS, USE_BROWSER, ANTHROPIC_MODEL, GEMINI_MODEL, CF_AI_MODEL
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const PTYPES = ['Multifamily', 'Single family', 'Retail', 'Office', 'Industrial', 'Mixed-use', 'Other'];
const MAX_IMAGES = 5, MAX_IMAGE_B64 = 2_800_000, MAX_TEXT = 60_000;
const BOT_WALL = /captcha|access denied|are you a robot|press & hold|verify you are human|unusual traffic|request unsuccessful|pardon our interruption/i;
const looksOk = pg => !!(pg && pg.ok && pg.text.length > 400 && !BOT_WALL.test(pg.text.slice(0, 3000)));

export async function extract({ body, headers = {}, env = {} }) {
  const h = k => headers[k] ?? headers[k.toLowerCase()] ?? (typeof headers.get === 'function' ? headers.get(k) : undefined);
  if (env.APP_PASSCODE && h('x-app-key') !== env.APP_PASSCODE) return { status: 401, body: { error: 'Passcode required.' } };
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body || typeof body !== 'object') return { status: 400, body: { error: 'Send JSON: { url, text, images }.' } };
  let { url = '', text = '', images = [] } = body;
  url = String(url || '').trim(); text = String(text || '').slice(0, MAX_TEXT);
  images = (Array.isArray(images) ? images : []).filter(i => i && typeof i.data === 'string' && i.data.length < MAX_IMAGE_B64 && /^image\/(jpeg|png|webp|gif)$/.test(i.type || 'image/jpeg')).slice(0, MAX_IMAGES);
  if (!url && !text && !images.length) return { status: 400, body: { error: 'Add a link, a screenshot or some listing text.' } };
  if (url && !safeUrl(url)) return { status: 400, body: { error: 'That link is not a public web address.' } };

  // 1) plain fetch  2) real headless browser (Cloudflare Browser Run) if the plain fetch was blocked or empty
  let page = null, fetchNote = '', how = '';
  if (url && text.length < 1500) { // page text already supplied (pasted or sent from the browser): don't re-fetch
    try { page = await fetchPage(url, env); how = 'direct fetch'; if (!page.ok) fetchNote = `The site returned HTTP ${page.status} to a direct request.`; }
    catch (e) { fetchNote = 'Direct request failed (' + (e.name === 'AbortError' ? 'timed out' : e.message) + ').'; }
    if (page && page.ok && !looksOk(page) && !fetchNote) fetchNote = 'A direct request got a bot check or an empty page.';
    if (!looksOk(page) && env.CF_ACCOUNT_ID && env.CF_API_TOKEN && env.USE_BROWSER !== '0') {
      try {
        const rendered = await renderPage(url, env);
        if (looksOk(rendered)) { page = rendered; how = 'Cloudflare headless browser'; fetchNote = ''; }
        else fetchNote += ' The headless browser was blocked too.';
      } catch (e) { fetchNote += ' Headless browser failed (' + e.message + ').'; }
    }
  }
  const pageOk = looksOk(page);
  const material = [
    text && 'Pasted by user:\n' + text,
    pageOk && page.jsonld && 'Structured data on the page (JSON-LD):\n' + page.jsonld,
    pageOk && page.meta && 'Page meta tags:\n' + page.meta,
    pageOk && 'Page text (' + how + '):\n' + page.text,
  ].filter(Boolean).join('\n\n');

  const fallback = why => { const d = heuristic(pageOk ? page : null, text, url); d.sourceSummary = (why + ' ' + fetchNote).trim(); return { status: 200, body: d }; };
  const provider = env.ANTHROPIC_API_KEY ? 'claude' : env.GEMINI_API_KEY ? 'gemini' : (env.AI || (env.CF_ACCOUNT_ID && env.CF_API_TOKEN)) ? 'workers' : '';
  const useTools = !!(url && !pageOk && env.USE_WEB_TOOLS !== '0' && (provider === 'claude' || provider === 'gemini'));
  const cap = provider === 'workers' ? 40000 : 90000;
  const p = prompt(url, material.slice(0, cap), images.length, useTools, fetchNote);
  try {
    let out;
    if (provider === 'claude') out = await viaClaude(env, p, images, useTools, fetchNote);
    else if (provider === 'gemini') out = await viaGemini(env, p, images, fetchNote, useTools);
    else if (provider === 'workers') out = await viaWorkersAI(env, p, images, fetchNote);
    if (out) {
      if (out.body && typeof out.body === 'object') {
        // Backstop: anything the AI left empty but the pattern reader found on the page is filled in.
        const hz = heuristic(pageOk ? page : null, text, url); const filled = [];
        for (const k of ['address','city','state','zip','propertyType','price','units','sqft','yearBuilt','grossRentMonthly','occupancyPct','noi','capRate','taxesAnnual','insuranceAnnual','expensesAnnual','hoaMonthly','beds','baths']) {
          const v = out.body[k]; if ((v == null || v === '') && hz[k] != null && hz[k] !== '') { out.body[k] = hz[k]; filled.push(k); }
        }
        if (how && pageOk) out.body.sourceSummary = ((out.body.sourceSummary || '') + ' (page read by ' + how + ')').trim();
      }
      return out;
    }
  } catch (e) { return fallback('Pattern matching only (AI call failed: ' + e.message + ').'); }
  return fallback(pageOk ? 'Page text via ' + how + ', read by pattern matching (no AI configured).' : text ? 'Pasted text, read by pattern matching (no AI configured).' : 'URL only (no AI configured).');
}

// Cloudflare Browser Run (formerly Browser Rendering): renders the page in a real Chrome and returns the HTML.
async function renderPage(url, env) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}`;
  const body = JSON.stringify({ url, gotoOptions: { waitUntil: 'networkidle2', timeout: 30000 }, rejectRequestPattern: ['/^.*\\.(png|jpe?g|gif|webp|svg|woff2?|ttf|mp4)(\\?.*)?$/'] });
  const opts = { method: 'POST', headers: { authorization: 'Bearer ' + env.CF_API_TOKEN, 'content-type': 'application/json' }, body };
  let r = await fetchT(base + '/browser-run/content', opts, 45000);
  if (r.status === 404) r = await fetchT(base + '/browser-rendering/content', opts, 45000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.success) throw new Error(((j.errors || [])[0] || {}).message || 'HTTP ' + r.status);
  return { ok: true, status: 200, ...parseHtml(String(j.result || '')) };
}

// Cloudflare Workers AI — free daily allowance on Workers Free. Uses the AI binding on Pages, else the REST API.
async function viaWorkersAI(env, p, images, fetchNote) {
  const model = env.CF_AI_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct';
  const content = images.length
    ? [{ type: 'text', text: p }, ...images.slice(0, 3).map(i => ({ type: 'image_url', image_url: { url: `data:${i.type || 'image/jpeg'};base64,${i.data}` } }))]
    : p;
  const messages = [{ role: 'system', content: 'You extract real estate listing data and reply with one JSON object only.' }, { role: 'user', content }];
  let out;
  if (env.AI && typeof env.AI.run === 'function') {
    const r = await env.AI.run(model, { messages, max_tokens: 2000, temperature: 0.1 });
    out = typeof r?.response === 'string' ? r.response : JSON.stringify(r?.response ?? r?.choices?.[0]?.message?.content ?? '');
  } else {
    const r = await fetchT(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer ' + env.CF_API_TOKEN, 'content-type': 'application/json' }, body: JSON.stringify({ model, messages, max_tokens: 2000, temperature: 0.1 }) }, 55000);
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(((j.errors || [])[0] || {}).message || (j.error && j.error.message) || 'HTTP ' + r.status);
    out = j.choices?.[0]?.message?.content || '';
  }
  const data = parseJson(out);
  if (!data) throw new Error('reply was not valid JSON');
  if (fetchNote) data.sourceSummary = ((data.sourceSummary || '') + ' ' + fetchNote).trim();
  return { status: 200, body: data };
}

async function viaClaude(env, p, images, useTools, fetchNote) {
  const content = [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.type || 'image/jpeg', data: i.data } })), { type: 'text', text: p }];
  const payload = { model: env.ANTHROPIC_MODEL || 'claude-sonnet-5', max_tokens: 3000, messages: [{ role: 'user', content }] };
  if (useTools) payload.tools = [{ type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 2 }, { type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
  const r = await fetchT('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(useTools ? { 'anthropic-beta': 'web-fetch-2025-09-10' } : {}) }, body: JSON.stringify(payload) }, 55000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  const out = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
  const data = parseJson(out);
  if (!data) throw new Error('reply was not valid JSON');
  if (fetchNote && !useTools) data.sourceSummary = ((data.sourceSummary || '') + ' ' + fetchNote).trim();
  return { status: 200, body: data };
}

async function viaGemini(env, p, images, fetchNote, useTools) {
  const model = env.GEMINI_MODEL || 'gemini-2.5-flash';
  const parts = [...images.map(i => ({ inline_data: { mime_type: i.type || 'image/jpeg', data: i.data } })), { text: p }];
  const payload = { contents: [{ role: 'user', parts }], generationConfig: { temperature: 0.1 } };
  if (useTools) payload.tools = [{ google_search: {} }]; else payload.generationConfig.responseMimeType = 'application/json';
  const r = await fetchT(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': env.GEMINI_API_KEY }, body: JSON.stringify(payload) }, 55000);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'HTTP ' + r.status);
  const out = ((j.candidates || [])[0]?.content?.parts || []).map(x => x.text || '').join('\n');
  const data = parseJson(out);
  if (!data) throw new Error('reply was not valid JSON');
  if (fetchNote && !useTools) data.sourceSummary = ((data.sourceSummary || '') + ' ' + fetchNote).trim();
  return { status: 200, body: data };
}

async function fetchT(url, opts, ms) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}

export function safeUrl(u) {
  try {
    const x = new URL(u);
    if (!/^https?:$/.test(x.protocol)) return false;
    const h = x.hostname.toLowerCase();
    if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || !h.includes('.')) return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h.includes(':')) return false;
    return true;
  } catch { return false; }
}

async function fetchPage(url, env) {
  const target = env.SCRAPER_URL ? env.SCRAPER_URL.replace('{url}', encodeURIComponent(url)) : url;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetch(target, { redirect: 'follow', signal: ctl.signal, headers: {
      'user-agent': UA, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'accept-language': 'en-US,en;q=0.9' } });
    const html = (await r.text()).slice(0, 3_000_000);
    return { ok: r.ok, status: r.status, ...parseHtml(html) };
  } finally { clearTimeout(t); }
}

export function parseHtml(html) {
  const jsonld = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)]
    .map(m => m[1].trim()).join('\n').slice(0, 20000);
  const meta = [...html.matchAll(/<meta[^>]+(?:property|name)=["']((?:og|twitter|description)[^"']*)["'][^>]*content=["']([^"']*)["'][^>]*>/gi)]
    .map(m => m[1] + ': ' + m[2]).join('\n').slice(0, 4000);
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ').replace(/<(br|p|div|li|tr|h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#36;/g, '$').replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return { title: decode(title.trim()), jsonld, meta, text: (title + '\n' + body).slice(0, 70000) };
}
function decode(s) { return s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"'); }

function prompt(url, material, nImg, useTools, fetchNote) {
  return `You are a commercial real estate analyst. Extract the facts from a property listing so they can prefill underwriting calculators.

MATERIAL
${url ? 'Listing URL: ' + url + '\n(URL paths often contain the street address, city, state, ZIP and sometimes beds, baths or a listing ID.)' : 'No URL given.'}
${material ? material : 'No page text available.'}
${nImg ? nImg + ' screenshot(s) of the listing or offering memorandum are attached. Read every number in them.' : ''}
${useTools ? `\nThe server could not read the page directly (${fetchNote}). Use your web tools to open the listing URL. If that is blocked too, search the web for the address or listing title to find the same listing on other sites (LoopNet, Crexi, Zillow, Redfin, Realtor.com, broker sites, county records) and use only details that clearly match this property. Name your sources in sourceSummary.` : ''}

RULES
- Use only facts in the material or sources you read. Never invent or estimate a number. Use null when unknown.
- You may compute a value from stated values (avgRentPerUnit = grossRentMonthly / units; occupancyPct = 100 - vacancy; grossRentMonthly = annual gross / 12; noi = price x cap rate). List every computed field in "derived".
- Money as plain numbers. Percentages as numbers (6.5 means 6.5%). Keep monthly vs annual exactly as the field names say.
- propertyType must be one of: ${PTYPES.join(', ')}. state is the 2-letter code.
- unitMix: one entry per stated unit type, e.g. {"label":"2BR/1BA","count":8,"rent":1150}; [] if none.

Your final message must be only this JSON object:
{"address":null,"city":null,"state":null,"zip":null,"propertyType":null,"price":null,"units":null,"sqft":null,"yearBuilt":null,"grossRentMonthly":null,"avgRentPerUnit":null,"occupancyPct":null,"noi":null,"capRate":null,"taxesAnnual":null,"insuranceAnnual":null,"expensesAnnual":null,"otherIncomeMonthly":null,"hoaMonthly":null,"beds":null,"baths":null,"unitMix":[],"derived":[],"notes":"1-2 sentences: notable facts and anything inconsistent","sourceSummary":"what you read"}`;
}

export function parseJson(s) {
  const tries = [s, (s.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], s.slice(s.indexOf('{'), s.lastIndexOf('}') + 1)];
  for (const t of tries) { if (!t) continue; try { const v = JSON.parse(t); if (v && typeof v === 'object') return v; } catch {} }
  return null;
}

// No-AI fallback: JSON-LD + URL + regex over page text
export function heuristic(page, pasted, url) {
  const d = { address: null, city: null, state: null, zip: null, propertyType: null, price: null, units: null, sqft: null, yearBuilt: null,
    grossRentMonthly: null, avgRentPerUnit: null, occupancyPct: null, noi: null, capRate: null, taxesAnnual: null, insuranceAnnual: null,
    expensesAnnual: null, otherIncomeMonthly: null, hoaMonthly: null, beds: null, baths: null, unitMix: [], derived: [], notes: '' };
  const txt = [(page && page.ok) ? page.text : '', pasted || ''].join('\n');
  const num = s => s == null ? null : parseFloat(String(s).replace(/[$,\s]/g, '')) || null;
  const walk = (o, f) => { if (o && typeof o === 'object') { f(o); Object.values(o).forEach(v => walk(v, f)); } };
  if (page && page.jsonld) {
    for (const block of page.jsonld.split(/\n(?=[\[{])/)) {
      try {
        walk(JSON.parse(block), o => {
          if (o.streetAddress && !d.address) d.address = o.streetAddress;
          if (o.addressLocality && !d.city) d.city = o.addressLocality;
          if (o.addressRegion && !d.state) d.state = o.addressRegion;
          if (o.postalCode && !d.zip) d.zip = String(o.postalCode);
          if (o.price && !d.price) d.price = num(o.price);
          if (o.yearBuilt && !d.yearBuilt) d.yearBuilt = num(o.yearBuilt);
          if (o.numberOfBedrooms && !d.beds) d.beds = num(o.numberOfBedrooms);
          if (o.numberOfBathroomsTotal && !d.baths) d.baths = num(o.numberOfBathroomsTotal);
          if (o.floorSize && o.floorSize.value && !d.sqft) d.sqft = num(o.floorSize.value);
        });
      } catch {}
    }
  }
  const m = (re, i = 1) => { const x = txt.match(re); return x ? x[i] : null; };
  const setIf = (k, v) => { if (d[k] == null && v != null && v !== '' && !(typeof v === 'number' && !isFinite(v))) d[k] = v; };
  // 1) "Label" on one line, value on the next (LoopNet, Crexi, most broker sites) or "Label: value" on one line
  const lines = txt.split(/\n+/).map(l => l.trim()).filter(Boolean);
  const LABELS = [
    [/^(?:asking |list |sale |offering )?price$/i, 'price', 'money'], [/^(?:no\.?|number) of units$|^units$|^total units$|^unit count$/i, 'units', 'int'],
    [/^(?:building size|rentable building area|rba|gross building area|total building size|building sf|square feet|sq\.? ?ft\.?)$/i, 'sqft', 'int'],
    [/^year built(?:\/renovated)?$|^built$/i, 'yearBuilt', 'year'], [/^cap(?:italization)? rate$/i, 'capRate', 'pct'],
    [/^(?:noi|net operating income|pro forma noi)$/i, 'noi', 'money'], [/^(?:percent leased|occupancy|occupancy rate|% leased|leased)$/i, 'occupancyPct', 'pct'],
    [/^(?:annual )?(?:real estate |property )?taxes(?: \(annual\))?$|^tax amount$/i, 'taxesAnnual', 'money'], [/^insurance$/i, 'insuranceAnnual', 'money'],
    [/^(?:total )?(?:operating )?expenses$/i, 'expensesAnnual', 'money'], [/^(?:gross (?:scheduled |potential )?(?:rent|income)|total income|gross income|gpi|gsi)$/i, 'grossAnnual', 'money'],
    [/^(?:monthly rent|monthly income|total monthly rent)$/i, 'grossRentMonthly', 'money'], [/^(?:hoa(?: dues| fee)?s?)$/i, 'hoaMonthly', 'money'],
    [/^(?:beds|bedrooms)$/i, 'beds', 'num'], [/^(?:baths|bathrooms)$/i, 'baths', 'num'], [/^property (?:type|subtype)$|^asset type$/i, 'ptypeRaw', 'text'],
  ];
  const conv = (v, kind) => { if (v == null) return null; const s = String(v);
    if (kind === 'text') return s.trim();
    if (kind === 'year') { const y = s.match(/(1[89]\d\d|20\d\d)/); return y ? +y[1] : null; }
    if (kind === 'pct') { const p = s.match(/([\d.]+)\s*%/) || s.match(/^([\d.]+)$/); return p ? +p[1] : null; }
    if (kind === 'money' && !/\$/.test(s) && !/^\s*[\d,]+(?:\.\d+)?\s*$/.test(s)) return null;
    const x = (kind === 'money' && /\$/.test(s) ? s.match(/\$\s*([\d,]+(?:\.\d+)?)\s*(k|m|mm|million)?\b/i) : s.match(/([\d,]+(?:\.\d+)?)\s*(k|m|mm|million)?\b/i)); if (!x) return null;
    if (kind === 'money' && /\$/.test(s) && parseFloat(x[1].replace(/,/g, '')) === 0) return null;
    let n = parseFloat(x[1].replace(/,/g, '')); const suf = (x[2] || '').toLowerCase(); if (suf === 'k') n *= 1e3; if (suf === 'm' || suf === 'mm' || suf === 'million') n *= 1e6;
    return kind === 'int' ? Math.round(n) : n; };
  const extra = {};
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i]; const kv = L.match(/^([A-Za-z%./ ()]{2,40}?)\s*[:\t]\s*(.+)$/);
    for (const [re, key, kind] of LABELS) {
      let val = null;
      if (re.test(L) && i + 1 < lines.length) val = conv(lines[i + 1], kind);
      else if (kv && re.test(kv[1].trim())) val = conv(kv[2], kind);
      if (val != null) { if (key in d) setIf(key, val); else if (extra[key] == null) extra[key] = val; }
    }
  }
  const addr = m(/Address:\s*([^\n]+)/i) || (page && page.title) || '';
  const am = addr.match(/^\s*(\d+[^,\n]*?),\s*([A-Za-z .'-]+?),\s*([A-Z]{2})\s*(\d{5})?/);
  if (am) { setIf('address', am[1].trim()); setIf('city', am[2].trim()); setIf('state', am[3]); setIf('zip', am[4] || null); }
  const zipAny = txt.match(/,\s*([A-Z]{2})\s+(\d{5})\b/); if (zipAny) { setIf('state', zipAny[1]); setIf('zip', zipAny[2]); }
  // 2) inline patterns as a backstop
  setIf('price', num(m(/(?:price|asking|list(?:ed)? price)[^$]{0,25}\$\s?([\d,]{5,})/i)) || num(m(/\$\s?([\d,]{6,})/)));
  setIf('units', num(m(/(?:units|no\.? of units|number of units)[:\s]+(\d{1,4})\b/i)) || num(m(/\b(\d{1,4})[\s-](?:unit|units)\b/i)));
  setIf('capRate', num(m(/cap(?:italization)? rate[:\s]*([\d.]{1,5})\s*%/i)));
  setIf('noi', num(m(/\bNOI\b[^$]{0,15}\$\s?([\d,]{4,})/i)) || num(m(/net operating income[^$]{0,15}\$\s?([\d,]{4,})/i)));
  setIf('yearBuilt', num(m(/year built[^\d]{0,20}(1[89]\d\d|20\d\d)/i)) || num(m(/built in (1[89]\d\d|20\d\d)/i)));
  setIf('sqft', num(m(/(?:building size|rentable building area|RBA)[:\s]*([\d,]{3,})/i)) || num(m(/([\d,]{3,})\s*(?:SF|sq\.? ?ft|square feet)\b/i)));
  setIf('occupancyPct', num(m(/(?:occupancy|occupied|leased)[:\s]*([\d.]{2,5})\s*%/i)) || num(m(/([\d.]{2,5})\s*%\s*(?:leased|occupied)/i)));
  if (d.grossRentMonthly == null && extra.grossAnnual) { d.grossRentMonthly = Math.round(extra.grossAnnual / 12); d.derived.push('grossRentMonthly'); }
  const gpi = num(m(/(?:gross (?:scheduled |potential )?(?:rent|income)|GPI|GSI)[^$]{0,15}\$\s?([\d,]{5,})/i));
  if (d.grossRentMonthly == null && gpi) { d.grossRentMonthly = Math.round(gpi / 12); d.derived.push('grossRentMonthly'); }
  if (d.noi == null && d.capRate && d.price) { d.noi = Math.round(d.price * d.capRate / 100); d.derived.push('noi'); }
  const pt = (extra.ptypeRaw || '').toLowerCase(), lower = txt.toLowerCase();
  const typeOf = s => /apartment|multifamily|multi-family|residential income/.test(s) ? 'Multifamily' : /\bretail\b|shopping|restaurant/.test(s) ? 'Retail' : /\boffice\b|medical/.test(s) ? 'Office' : /industrial|warehouse|flex|manufactur/.test(s) ? 'Industrial' : /mixed[- ]use/.test(s) ? 'Mixed-use' : /single[- ]family|townhouse|condo/.test(s) ? 'Single family' : null;
  setIf('propertyType', typeOf(pt) || typeOf(lower.slice(0, 1500)) || typeOf(lower));
  if (url && !d.zip) { const z = url.match(/[-_/](\d{5})(?:[-_/]|$)/); if (z) d.zip = z[1]; }
  if (url && !d.state) { const s2 = url.match(/[-_/]([A-Z]{2})[-_/](?:\d{5}|\d{6,}\/)/i); if (s2) d.state = s2[1].toUpperCase(); }
  d.notes = 'Read by pattern matching without AI. Check every value, and add screenshots or an ANTHROPIC_API_KEY for a better read.';
  return d;
}
