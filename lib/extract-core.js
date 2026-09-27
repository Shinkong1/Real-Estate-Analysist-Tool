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
  if (url) {
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
    if (out) { if (how && pageOk && out.body && typeof out.body === 'object') out.body.sourceSummary = ((out.body.sourceSummary || '') + ' (page read by ' + how + ')').trim(); return out; }
  } catch (e) { return fallback('Pattern matching only (AI call failed: ' + e.message + ').'); }
  return fallback(pageOk ? 'Page text via ' + how + ', read by pattern matching (no AI configured).' : 'URL only (no AI configured).');
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
  d.price = d.price || num(m(/(?:price|asking|list(?:ed)? price)[^$\n]{0,20}\$\s?([\d,]{5,})/i)) || num(m(/\$\s?([\d,]{6,})/));
  d.units = num(m(/(?:units|no\.? of units|number of units)[:\s]+(\d{1,4})\b/i)) || num(m(/\b(\d{1,4})[\s-](?:unit|units)\b/i));
  d.capRate = num(m(/cap(?:italization)? rate[:\s]*([\d.]{1,5})\s*%/i));
  d.noi = num(m(/\bNOI\b[^$\n]{0,15}\$\s?([\d,]{4,})/i)) || num(m(/net operating income[^$\n]{0,15}\$\s?([\d,]{4,})/i));
  d.yearBuilt = d.yearBuilt || num(m(/year built[:\s]*(1[89]\d\d|20\d\d)/i)) || num(m(/built in (1[89]\d\d|20\d\d)/i));
  d.sqft = d.sqft || num(m(/(?:building size|rentable building area|RBA|square feet|sq\.? ?ft)[:\s]*([\d,]{3,})/i)) || num(m(/([\d,]{3,})\s*(?:SF|sq\.? ?ft|square feet)\b/i));
  d.occupancyPct = num(m(/(?:occupancy|occupied|leased)[:\s]*([\d.]{2,5})\s*%/i));
  d.taxesAnnual = num(m(/(?:annual )?(?:property )?tax(?:es)?[^$\n]{0,20}\$\s?([\d,]{3,})/i));
  d.grossRentMonthly = num(m(/(?:monthly (?:gross )?(?:rent|income))[^$\n]{0,15}\$\s?([\d,]{3,})/i));
  const gpi = num(m(/(?:gross (?:scheduled |potential )?(?:rent|income)|GPI|GSI)[^$\n]{0,15}\$\s?([\d,]{5,})/i));
  if (!d.grossRentMonthly && gpi) { d.grossRentMonthly = Math.round(gpi / 12); d.derived.push('grossRentMonthly'); }
  const lower = txt.toLowerCase();
  d.propertyType = /apartment|multifamily|multi-family|\bunits\b/.test(lower) ? 'Multifamily' : /\bretail\b|shopping/.test(lower) ? 'Retail' : /\boffice\b/.test(lower) ? 'Office' : /industrial|warehouse|flex/.test(lower) ? 'Industrial' : /mixed[- ]use/.test(lower) ? 'Mixed-use' : /single[- ]family|bed(room)?s?\b/.test(lower) ? 'Single family' : null;
  if (url && !d.zip) { const z = url.match(/[-_/](\d{5})(?:[-_/]|$)/); if (z) d.zip = z[1]; }
  if (url && !d.state) { const s = url.match(/[-_/]([A-Z]{2})[-_/]\d{5}/i); if (s) d.state = s[1].toUpperCase(); }
  d.notes = 'Read by pattern matching without AI. Check every value, and add screenshots or an ANTHROPIC_API_KEY for a better read.';
  return d;
}
