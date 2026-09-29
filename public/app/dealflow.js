/* Napkin Math — deal-flow tools: find, judge, manage and act on deals.
   Loads after the main app script and before it boots, so these tools join the same registry.
   Everything a member types is escaped with esc() before it reaches the page. */
(function () {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const VIEWER = () => !!window.UW_VIEWER;
S.deals = S.deals || []; S.leads = S.leads || []; S.mk = S.mk || {}; S.inbox = S.inbox || []; S.cmp = S.cmp || []; S.rc = S.rc || {};
const STAGES = ['Found', 'Analyzing', 'Offer sent', 'Under contract', 'Closed', 'Passed'];
const TYPES = [['t_mf', 'Multifamily'], ['t_sf', 'Single family'], ['t_rt', 'Retail'], ['t_of', 'Office'], ['t_in', 'Industrial'], ['t_mx', 'Mixed-use'], ['t_ot', 'Other']];
const n = (x, d) => { const v = toN(x); return fin(v) ? v : d; };

/* ---------- buy box + quick model ---------- */
function BOX() {
  const v = S.v.box || {}, g = (k, d) => n(v[k], d), p = (k, d) => g(k, d * 100) / 100;
  const types = TYPES.filter(([k]) => v[k] === undefined ? true : !!v[k] && v[k] !== 'false').map(t => t[1]);
  return { mkts: String(v.mkts || '').split(/[,;\n]+/).map(s => s.trim().toLowerCase()).filter(Boolean), types,
    pmin: g('pmin', NaN), pmax: g('pmax', NaN), umin: g('umin', NaN), umax: g('umax', NaN), ymin: g('ymin', NaN),
    cap: p('cap', .07), coc: p('coc', .08), dscr: g('dscr', 1.25), cfu: g('cfu', 100), ppu: g('ppu', NaN),
    ltv: clamp(p('ltv', .75), 0, .95), rate: p('rate', .07), amort: g('amort', 30), close: p('close', .03), expR: p('expR', .45), vac: p('vac', .05) };
}
function qm(d, b = BOX(), price) {
  price = fin(price) ? price : d.price;
  const units = d.units > 0 ? d.units : 1;
  const gross = fin(d.grossRentMonthly) ? d.grossRentMonthly : fin(d.avgRentPerUnit) ? d.avgRentPerUnit * units : NaN;
  const occ = fin(d.occupancyPct) ? d.occupancyPct / 100 : 1 - b.vac, other = fin(d.otherIncomeMonthly) ? d.otherIncomeMonthly : 0;
  const egi = fin(gross) ? gross * 12 * occ + other * 12 : NaN;
  let noi, est = false;
  if (fin(d.noi)) noi = d.noi;
  else if (fin(egi) && fin(d.expensesAnnual)) noi = egi - d.expensesAnnual;
  else if (fin(egi)) { noi = egi * (1 - b.expR); est = true; }
  else noi = NaN;
  const loan = price * b.ltv, ds = pmtM(b.rate, b.amort, loan) * 12, equity = price - loan + price * b.close;
  const cf = noi - ds;
  return { price, units, gross, egi, noi, est, loan, ds, equity, cf, coc: cf / equity, dscr: ds ? noi / ds : NaN, cap: noi / price,
    grm: fin(gross) && gross ? price / (gross * 12) : NaN, ppu: price / units, cfu: cf / 12 / units, ltv: b.ltv, rate: b.rate };
}
function screen(d, b = BOX()) {
  const q = qm(d, b), rows = [];
  const add = (label, ok, val, need) => rows.push({ label, ok, val, need });
  if (b.mkts.length) { const hay = [d.address, d.city, d.state, d.zip].join(' ').toLowerCase(); add('Market', b.mkts.some(m => hay.includes(m)), [d.city, d.state, d.zip].filter(Boolean).join(', ') || '—', b.mkts.join(', ')); }
  if (d.propertyType) add('Property type', b.types.includes(d.propertyType), d.propertyType, b.types.join(', '));
  if (fin(b.pmin) || fin(b.pmax)) add('Price', fin(d.price) && (!fin(b.pmin) || d.price >= b.pmin) && (!fin(b.pmax) || d.price <= b.pmax), fk(d.price), `${fin(b.pmin) ? fk(b.pmin) : 'any'} – ${fin(b.pmax) ? fk(b.pmax) : 'any'}`);
  if (fin(b.umin) || fin(b.umax)) add('Units', fin(d.units) && (!fin(b.umin) || d.units >= b.umin) && (!fin(b.umax) || d.units <= b.umax), nm(d.units), `${fin(b.umin) ? b.umin : 'any'} – ${fin(b.umax) ? b.umax : 'any'}`);
  if (fin(b.ymin)) add('Year built', fin(d.yearBuilt) && d.yearBuilt >= b.ymin, fin(d.yearBuilt) ? d.yearBuilt : '—', b.ymin + '+');
  if (fin(b.ppu)) add('Price / unit', fin(q.ppu) && q.ppu <= b.ppu, fm(q.ppu), '≤ ' + fm(b.ppu));
  add('Cap rate', fin(q.cap) && q.cap >= b.cap, pc(q.cap, 1), '≥ ' + pc(b.cap, 1));
  add('Cash-on-cash', fin(q.coc) && q.coc >= b.coc, pc(q.coc, 1), '≥ ' + pc(b.coc, 1));
  add('DSCR', fin(q.dscr) && q.dscr >= b.dscr, nx(q.dscr), '≥ ' + nx(b.dscr));
  add('Cash flow / unit / mo', fin(q.cfu) && q.cfu >= b.cfu, fm(q.cfu), '≥ ' + fm(b.cfu));
  const fails = rows.filter(r => !r.ok), known = fin(q.noi) && fin(d.price);
  return { q, rows, fails, pass: known && !fails.length, known };
}
const badge = r => !r.known ? tag('mut', 'Needs data') : r.pass ? tag('good', 'Fits buy box') : tag(r.fails.length <= 1 ? 'warn' : 'bad', r.fails.length + ' miss' + (r.fails.length > 1 ? 'es' : ''));

/* ---------- saved deals ---------- */
const dealById = id => S.deals.find(x => x.id === id);
const dealOpts = () => S.deals.length ? S.deals.map(x => [x.id, x.name]) : [['', 'No saved deals yet']];
function pickDeal(V) { const id = V.s('deal'); return dealById(id) || (S.active && S.deals.find(x => x.name === S.active.name)) || S.deals[0] || null; }
const dealSel = () => Sel('deal', 'Deal', dealOpts(), (S.active && (S.deals.find(x => x.name === S.active.name) || {}).id) || (S.deals[0] || {}).id || '', { w: true });
const needDeal = () => empty('Save a deal first: import a listing (or use the Deal Inbox), then come back here.');
const DEAL_TOOLS = ['maxoffer', 'flags', 'rentcheck', 'loi', 'lender'];
function dealsChanged() { save(); DEAL_TOOLS.concat(['box', 'compare', 'pipeline', 'inbox']).forEach(id => { if (document.getElementById('t-' + id)) build(id); }); if (typeof renderDeals === 'function') renderDeals(); }
const _saveDeal = saveDeal;
saveDeal = function (d) { _saveDeal(d); S.deals = S.deals.slice(0, 300); const rec = S.deals.find(x => x.data === d || x.name === dealName(d)); if (rec && !rec.stage) rec.stage = 'Found'; setTimeout(dealsChanged, 0); };
renderDeals = function () {
  const el = document.getElementById('dealList'); if (!el) return; const b = BOX();
  el.innerHTML = S.deals.length ? S.deals.slice(0, 60).map(x => `<div class="kv" style="align-items:center;gap:8px"><span style="min-width:0"><b style="color:var(--ink)">${esc(x.name)}</b> ${badge(screen(x.data, b))}<br><span class="mut" style="font-size:12px">${fin(x.data.price) ? fk(x.data.price) + ' · ' : ''}${fin(x.data.units) ? x.data.units + ' units · ' : ''}${esc(x.stage || 'Found')} · ${new Date(x.at).toLocaleDateString()}</span></span><span style="display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end"><button type="button" class="btn sm" style="margin:0" data-load="${esc(x.id)}">Load</button><button type="button" class="btn sm" style="margin:0" data-df-share="${esc(x.id)}">Share</button><button type="button" class="btn sm" style="margin:0" data-del="${esc(x.id)}">Delete</button></span></div>`).join('')
    : '<p class="note" style="margin:0">Deals you apply are saved here and in your account, so they follow you to every device.</p>';
};

/* ---------- small UI helpers ---------- */
function toast(html, ms = 6000) {
  let t = document.getElementById('dfToast');
  if (!t) { t = document.createElement('div'); t.id = 'dfToast'; t.setAttribute('role', 'status'); document.body.appendChild(t); }
  t.innerHTML = html; t.hidden = false; clearTimeout(t._h); t._h = setTimeout(() => { t.hidden = true; }, ms);
}
const btn = (label, attrs, cls = 'btn sm') => `<button type="button" class="${cls}" ${attrs}>${label}</button>`;
const go = id => document.dispatchEvent(new CustomEvent('uw:go', { detail: id }));
async function api(path, body, method) {
  const r = await fetch(path, body === undefined ? { method: method || 'GET' } : { method: method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let j = {}; try { j = await r.json(); } catch (e) {}
  if (!r.ok) throw new Error(j.error || ('Error ' + r.status));
  return j;
}
function heatBg(rank, total, good = true) { if (total < 2 || rank < 0) return ''; const t = rank / (total - 1), s = good ? t : 1 - t; return s > .66 ? 'background:var(--good-bg)' : s < .34 ? 'background:var(--bad-bg)' : ''; }
function printDoc(title, html) {
  const w = window.open('', '_blank'); if (!w) { toast('Allow pop-ups to print.'); return; }
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:14px/1.55 Georgia,serif;color:#111;max-width:720px;margin:40px auto;padding:0 24px}h1{font:700 22px Arial,sans-serif;margin:0 0 4px}h2{font:700 14px Arial,sans-serif;text-transform:uppercase;letter-spacing:.06em;margin:22px 0 6px;color:#333}table{border-collapse:collapse;width:100%;font:13px Arial,sans-serif}td,th{border-bottom:1px solid #ddd;padding:6px 4px;text-align:left}td:last-child,th:last-child{text-align:right}.muted{color:#666;font-size:12px}.letter p{margin:0 0 12px}@media print{body{margin:0}}</style></head><body>${html}</body></html>`);
  w.document.close(); setTimeout(() => { try { w.focus(); w.print(); } catch (e) {} }, 300);
}

/* =================== FIND DEALS =================== */
tool({ id: 'box', group: 'Find deals', name: 'Buy Box', blurb: 'Set the deals you want once. Every saved listing is checked against it, and the Deal Inbox, Compare, Pipeline and Max Offer tools all use these targets and financing assumptions.', wide: false,
  inputs: () => G('Where and what', T('mkts', 'Target markets', '', { ph: 'MD, PA, Cumberland, 21532', hint: 'States, cities or ZIPs separated by commas. Leave blank for anywhere.' }), ...TYPES.map(([k, l]) => C(k, l, true)),
      N('pmin', 'Min price', '', { pre: '$' }), N('pmax', 'Max price', 1500000, { pre: '$' }), N('umin', 'Min units', ''), N('umax', 'Max units', ''), N('ymin', 'Built after', '', { ph: 'any' }))
    + G('Returns you need', N('cap', 'Min cap rate', 7, { suf: '%' }), N('coc', 'Min cash-on-cash', 8, { suf: '%' }), N('dscr', 'Min DSCR', 1.25, { suf: 'x' }), N('cfu', 'Min cash flow', 100, { pre: '$', suf: '/unit/mo' }), N('ppu', 'Max price per unit', '', { pre: '$', w: true }))
    + ADV('Financing and estimate assumptions', false, N('ltv', 'Loan-to-value', 75, { suf: '%' }), N('rate', 'Interest rate', 7, { suf: '%' }), N('amort', 'Amortization', 30, { suf: 'yrs' }), N('close', 'Closing costs', 3, { suf: '%' }), N('expR', 'Expense ratio if not disclosed', 45, { suf: '% EGI', w: true }), N('vac', 'Vacancy if not disclosed', 5, { suf: '%' })),
  calc() {
    const b = BOX(), L = S.deals.map(x => ({ x, r: screen(x.data, b) }));
    const fit = L.filter(o => o.r.pass).length;
    const crit = `${b.mkts.length ? esc(b.mkts.join(', ')) : 'Any market'} · ${esc(b.types.length === TYPES.length ? 'all property types' : b.types.join(', ') || 'no types selected')} · cap ≥ ${pc(b.cap, 1)} · cash-on-cash ≥ ${pc(b.coc, 1)} · DSCR ≥ ${nx(b.dscr)} · ${fm(b.cfu)}/unit/mo`;
    return verdict(L.length ? (fit ? 'good' : 'warn') : 'mut', L.length ? `${fit} of ${L.length} saved deals fit your buy box` : 'Your buy box is saved', crit, L.length ? (fit ? 'MATCHES' : 'NO FITS') : 'READY')
      + (L.length ? card('Saved deals against your box', tbl(['Deal', 'Price', 'Cap', 'CoC', 'DSCR', 'Result'], L.map(({ x, r }) => [esc(x.name), fk(x.data.price), pc(r.q.cap, 1), pc(r.q.coc, 1), nx(r.q.dscr), badge(r) + (r.fails.length && r.known ? `<br><span class="mut" style="font-size:12px">${r.fails.map(f => esc(f.label)).join(', ')}</span>` : '')])))
        : card('Next', `<p class="note" style="margin:0">Paste listing links into the ${btn('Deal Inbox', 'data-df-go="inbox"', 'btn sm')} to screen many at once against these targets.</p>`))
      + card('How estimates work', `<p class="note" style="margin:0">When a listing doesn't state NOI or expenses, NOI is estimated as rent × occupancy × (1 − ${pc(b.expR, 0)}). Financing: ${pc(b.ltv, 0)} loan-to-value, ${pc(b.rate, 2)}, ${b.amort}-year amortization, ${pc(b.close, 1)} closing costs.</p>`);
  } });

const LISTING_HOSTS = /(loopnet|crexi|zillow|redfin|realtor|trulia|homes\.com|apartments\.com|showcase|commercialcafe|cityfeet|biproxi|ten-x|landwatch|auction\.com|hubzu|xome|movoto|compass\.com|century21|coldwellbanker|kw\.com|remax|mls)/i;
function findLinks(text) {
  const raw = [...String(text || '').matchAll(/https?:\/\/[^\s<>"'()]+/gi)].map(m => m[0].replace(/[.,;:!?)\]]+$/, ''));
  const bad = /unsubscribe|privacy|preferences|facebook|twitter|instagram|linkedin|youtube|mailto|\/terms|\/help|\.(png|jpe?g|gif|svg|css|js)(\?|$)/i;
  let L = [...new Set(raw)].filter(u => !bad.test(u));
  const listing = L.filter(u => LISTING_HOSTS.test(u) || /listing|property|homedetails|\/for-sale|\/home\//i.test(u));
  return (listing.length ? listing : L).slice(0, 50);
}
const INBOX = { running: false, ctl: null };
tool({ id: 'inbox', group: 'Find deals', name: 'Deal Inbox', blurb: 'Paste a batch of listing links, or a whole alert email from LoopNet, Crexi, Zillow or Redfin. Each listing is read, saved to your pipeline and checked against your buy box.', wide: false,
  inputs: () => G('Paste links or an alert email', A('paste', 'Links or email text', '', { rows: 9, ph: 'Paste listing links (one per line) or copy the whole body of a saved-search alert email here' }), C('skip', 'Skip links already in my saved deals', true))
    + `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${btn('Screen listings', 'data-df="inbox-run"', 'btn primary')}${btn('Stop', 'data-df="inbox-stop"', 'btn')}</div><p class="note" id="inboxStatus" aria-live="polite" style="margin:8px 0 0"></p>`,
  calc(V) {
    const links = findLinks(V.s('paste')), known = new Set(S.deals.map(x => x.data.url).filter(Boolean));
    const todo = V.b('skip') ? links.filter(u => !known.has(u)) : links;
    const b = BOX();
    const res = S.inbox.slice(0, 50).map(r => { const rec = dealById(r.id); const s = rec ? screen(rec.data, b) : null;
      return [rec ? esc(rec.name) : `<span class="mut">${esc(r.url.replace(/^https?:\/\/(www\.)?/, '').slice(0, 60))}</span>`, r.err ? tag('bad', 'Could not read') : s ? badge(s) : tag('mut', 'Queued'), rec ? fk(rec.data.price) : '—', s ? pc(s.q.cap, 1) : '—', s ? fm(s.q.cf / 12) : '—', rec ? btn('Open', `data-load-deal="${esc(rec.id)}"`) : (r.err ? `<span class="mut" style="font-size:12px">${esc(r.err).slice(0, 80)}</span>` : '')]; });
    return verdict(todo.length ? 'good' : 'mut', todo.length ? `${todo.length} listing link${todo.length > 1 ? 's' : ''} ready to screen` : 'Paste listing links or an alert email', todo.length ? `Up to 10 are read per run (about 20–60 seconds each). ${links.length - todo.length ? (links.length - todo.length) + ' already saved and skipped.' : ''}` : 'Tip: set up saved-search email alerts on LoopNet, Crexi or Zillow, then paste each alert here. That turns their alerts into screened deals in your pipeline.', todo.length ? 'READY' : 'EMPTY')
      + (todo.length ? card('Links found', ul(todo.slice(0, 10).map(u => `<span style="word-break:break-all">${esc(u)}</span>`)) + (todo.length > 10 ? `<p class="note">+ ${todo.length - 10} more (run again after this batch)</p>` : '')) : '')
      + (res.length ? card('Latest results', tbl(['Listing', 'Buy box', 'Price', 'Cap', 'Cash flow / mo', ''], res)) : '');
  } });
async function runInbox() {
  if (INBOX.running || VIEWER()) return;
  const v = S.v.inbox || {}, links = findLinks(v.paste), known = new Set(S.deals.map(x => x.data.url).filter(Boolean));
  const todo = (v.skip === false ? links : links.filter(u => !known.has(u))).slice(0, 10);
  const st = $('#inboxStatus'); if (!todo.length) { if (st) st.textContent = 'No new listing links found.'; return; }
  INBOX.running = true; INBOX.ctl = new AbortController();
  for (let i = 0; i < todo.length; i++) {
    if (INBOX.ctl.signal.aborted) break;
    if (st) st.textContent = `Reading ${i + 1} of ${todo.length}…`;
    const url = todo[i], row = { url, at: Date.now() };
    try { const d = normDeal(await runExtract(url, '', [], INBOX.ctl.signal), url); _saveDeal(d); const rec = S.deals.find(x => x.data.url === url) || S.deals[0]; rec.stage = rec.stage || 'Found'; rec.source = 'Inbox'; row.id = rec.id; }
    catch (e) { if (e && e.name === 'AbortError') break; row.err = (e && (e.message || e.code)) || 'Could not read'; }
    S.inbox = [row, ...S.inbox.filter(r => r.url !== url)].slice(0, 100); save(); run('inbox');
  }
  INBOX.running = false; if (st) st.textContent = INBOX.ctl.signal.aborted ? 'Stopped.' : 'Done. Deals are saved to your pipeline.'; dealsChanged();
}

/* ---------- off-market leads ---------- */
const TRUE = /^(y|yes|true|1|x|✓)$/i;
function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) { const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true; else if (c === ',' || c === '\t') { row.push(f); f = ''; } else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; } else f += c; }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows.filter(r => r.some(x => x.trim()));
}
function mapLeads(rows) {
  if (rows.length < 2) return [];
  const H = rows[0].map(h => h.trim().toLowerCase()), find = (re, not) => H.findIndex(h => re.test(h) && !(not && not.test(h)));
  const ix = { owner: find(/owner|name/, /mail|company type/), addr: find(/(property|site|situs)?\s*(street|address)/, /mail|owner/), city: find(/city/, /mail/), state: find(/^state|property state|site state/, /mail/), zip: find(/zip|postal/, /mail/),
    maddr: find(/mail.*(address|street)/), mcity: find(/mail.*city/), mstate: find(/mail.*state/), years: find(/years?\s*owned|length of ownership|ownership (years|length)/), sale: find(/(last )?sale date|purchase date|recording date/),
    equity: find(/equity\s*(%|percent|pct)?/), value: find(/value|avm|market price/), units: find(/units/), type: find(/property type|land use|use code/), phone: find(/phone/), email: find(/e-?mail/, /mail(ing)? address/), tags: find(/tags|list|lists|notes|motivation/) };
  const FLAG = { vacant: /vacant/, taxdel: /tax.*(delinq|default|lien)/, pre: /pre-?foreclos|nod|lis pendens|default notice|auction/, probate: /probate|estate|deceased|inherit/, code: /code viol|violation/, evict: /evict/, absentee: /absentee|non.?owner/, free: /free and clear|free & clear|no mortgage/ };
  const flagCols = Object.fromEntries(Object.entries(FLAG).map(([k, re]) => [k, H.findIndex(h => re.test(h))]));
  return rows.slice(1).map((r, i) => {
    const g = k => ix[k] >= 0 ? String(r[ix[k]] || '').trim() : '';
    const tags = (g('tags') + ' ' + g('type')).toLowerCase();
    const f = {}; Object.entries(FLAG).forEach(([k, re]) => { const c = flagCols[k]; f[k] = (c >= 0 && TRUE.test(String(r[c] || '').trim())) || re.test(tags); });
    const addr = g('addr'), maddr = g('maddr');
    if (!f.absentee && maddr && addr) f.absentee = maddr.replace(/\W/g, '').toLowerCase().slice(0, 10) !== addr.replace(/\W/g, '').toLowerCase().slice(0, 10);
    const outState = g('mstate') && g('state') && g('mstate').toUpperCase() !== g('state').toUpperCase();
    let years = n(g('years'), NaN); if (!fin(years) && g('sale')) { const d = new Date(g('sale')); if (!isNaN(d)) years = (Date.now() - d) / 3.156e10; }
    let eq = n(g('equity'), NaN); if (fin(eq) && eq <= 1) eq *= 100;
    return { id: 'l' + Date.now().toString(36) + i, owner: g('owner'), address: addr, city: g('city'), state: g('state'), zip: g('zip'), mail: [maddr, g('mcity'), g('mstate')].filter(Boolean).join(', '),
      years: fin(years) ? Math.round(years) : null, equity: fin(eq) ? Math.round(eq) : null, value: n(g('value'), null), units: n(g('units'), null), phone: g('phone'), email: g('email'), f, outState, status: 'New', note: '' };
  }).filter(l => l.address || l.owner);
}
function leadScore(l) {
  const f = l.f || {}; let s = 0; const why = [];
  const add = (c, pts, w) => { if (c) { s += pts; why.push(w); } };
  add(f.pre, 25, 'Pre-foreclosure'); add(f.taxdel, 20, 'Tax delinquent'); add(f.probate, 20, 'Probate / estate'); add(f.absentee, 15, 'Absentee owner');
  add(f.vacant, 15, 'Vacant'); add(f.code, 10, 'Code violations'); add(f.evict, 10, 'Evictions'); add(l.outState, 5, 'Out-of-state owner');
  add(l.years >= 15, 15, l.years + ' yrs owned'); add(l.years >= 10 && l.years < 15, 8, l.years + ' yrs owned');
  add(f.free || l.equity >= 80, 12, 'Free & clear / high equity'); add(!f.free && l.equity >= 50 && l.equity < 80, 8, l.equity + '% equity');
  add(l.units > 1 && l.years >= 10, 5, 'Long-time landlord');
  return { s: Math.min(100, s), why };
}
const LEAD_STATUS = ['New', 'Mailed', 'Called', 'Talking', 'Appointment', 'Offer made', 'Not interested', 'Dead'];
tool({ id: 'leads', group: 'Find deals', name: 'Off-Market Leads', blurb: 'Import an owner list from county records, PropStream, DealMachine or any CSV. Each owner is scored on how likely they are to sell, and you track outreach here.', wide: true,
  inputs: () => G('Import a lead list', `<label class="f w"><span class="l">CSV file</span><span class="in" style="padding:6px 9px"><input type="file" accept=".csv,text/csv,.txt" data-df-file="leads" style="font-size:13px"></span><small>Columns are matched by name: owner, property address, city, state, ZIP, mailing address, years owned or last sale date, equity, value, and yes/no flags like vacant, tax delinquent, pre-foreclosure, probate.</small></label>`,
      A('csv', 'Or paste CSV text', '', { rows: 3, ph: 'Owner,Property Address,City,State,Zip,Mailing Address,Years Owned,Vacant,Tax Delinquent' }))
    + `<div style="display:flex;gap:8px;flex-wrap:wrap;margin:6px 0 10px">${btn('Import pasted CSV', 'data-df="leads-import"', 'btn')}${btn('Export CSV', 'data-df="leads-export"', 'btn')}${btn('Clear all leads', 'data-df="leads-clear"', 'btn')}</div>`
    + G('Show', T('q', 'Search', '', { ph: 'Name, street, city or ZIP', w: false }), Sel('st', 'Status', ['All', ...LEAD_STATUS], 'All'), N('min', 'Min score', 0)),
  calc(V) {
    const all = S.leads.map((l, i) => ({ l, i, sc: leadScore(l) }));
    if (!all.length) return empty('No leads yet. Import a CSV export from your county, PropStream, DealMachine, BatchLeads or a list broker.');
    const q = V.s('q').toLowerCase(), st = V.s('st') || 'All', min = V.n('min', 0);
    const L = all.filter(o => (!q || [o.l.owner, o.l.address, o.l.city, o.l.zip].join(' ').toLowerCase().includes(q)) && (st === 'All' || o.l.status === st) && o.sc.s >= min).sort((a, b) => b.sc.s - a.sc.s);
    const hot = all.filter(o => o.sc.s >= 40).length, talking = all.filter(o => ['Talking', 'Appointment', 'Offer made'].includes(o.l.status)).length;
    return `<div class="cards" style="margin-bottom:14px">${card('', stat('Leads', nm(all.length)))}${card('', stat('Hot (score 40+)', nm(hot), hot ? 'good' : ''))}${card('', stat('In conversation', nm(talking)))}</div>`
      + card(`Showing ${Math.min(L.length, 150)} of ${L.length}`, tbl(['Score', 'Owner', 'Property', 'Why', 'Status', 'Note', ''], L.slice(0, 150).map(({ l, i, sc }) => [
        `<b class="${sc.s >= 40 ? 'good' : sc.s >= 20 ? 'warn' : 'mut'}">${sc.s}</b>`, esc(l.owner || '—') + (l.phone ? `<br><span class="mut" style="font-size:12px">${esc(l.phone)}</span>` : ''),
        esc([l.address, l.city, l.state, l.zip].filter(Boolean).join(', ')) + (l.mail ? `<br><span class="mut" style="font-size:12px">Mail: ${esc(l.mail)}</span>` : ''),
        `<span style="font-size:12px">${esc(sc.why.join(' · ') || '—')}</span>`,
        `<select data-df-lead="${i}" data-f="status" aria-label="Status">${LEAD_STATUS.map(s => `<option${s === l.status ? ' selected' : ''}>${s}</option>`).join('')}</select>`,
        `<input data-df-lead="${i}" data-f="note" value="${esc(l.note)}" aria-label="Note" class="wtxt" style="min-width:120px">`,
        btn('Analyze', `data-df-lead-deal="${i}"`)])));
  } });
function importLeads(text) {
  const L = mapLeads(parseCSV(text));
  if (!L.length) { toast('No rows found. The first row should be column names.'); return; }
  const seen = new Set(S.leads.map(l => (l.address + l.zip).toLowerCase()));
  const fresh = L.filter(l => !seen.has((l.address + l.zip).toLowerCase()));
  S.leads = S.leads.concat(fresh).slice(0, 5000); save(); run('leads');
  toast(`Imported ${fresh.length} lead${fresh.length === 1 ? '' : 's'}${L.length - fresh.length ? ` (${L.length - fresh.length} duplicates skipped)` : ''}.`);
}
function exportLeads() {
  const cols = ['score', 'owner', 'address', 'city', 'state', 'zip', 'mail', 'phone', 'email', 'years', 'equity', 'status', 'note', 'why'];
  const q = v => { const s = String(v == null ? '' : v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = S.leads.map(l => { const sc = leadScore(l); return cols.map(c => q(c === 'score' ? sc.s : c === 'why' ? sc.why.join('; ') : l[c])).join(','); });
  const blob = new Blob([cols.join(',') + '\n' + rows.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'napkin-math-leads.csv'; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ---------- market heat map ---------- */
const MKT_COLS = [
  ['rent', 'Median rent', v => fm(v), true], ['value', 'Median home value', v => fk(v), null], ['priceToRent', 'Price-to-rent', v => fin(v) ? v.toFixed(1) : '—', false],
  ['vacancy', 'Vacancy', v => pc(v, 1), false], ['renterShare', 'Renters', v => pc(v, 0), true], ['income', 'Median income', v => fk(v), true],
  ['rentGrowth5', 'Rent growth (5 yr)', v => pc(v, 1), true], ['valueGrowth5', 'Value growth (5 yr)', v => pc(v, 1), true], ['popGrowth5', 'Population growth (5 yr)', v => pc(v, 1), true], ['pop', 'Population', v => nm(v), null]];
const STRAT = { 'Cash flow': { priceToRent: -3, vacancy: -2, rentGrowth5: 2, renterShare: 1, popGrowth5: 1 }, 'Appreciation': { valueGrowth5: 3, popGrowth5: 2, income: 1, rentGrowth5: 1, vacancy: -1 }, 'Balanced': { priceToRent: -2, rentGrowth5: 2, valueGrowth5: 2, popGrowth5: 2, vacancy: -2, income: 1 } };
tool({ id: 'heat', group: 'Find deals', name: 'Market Heat Map', blurb: 'Compare up to 8 ZIP codes on rents, prices, vacancy, income and five-year growth from U.S. Census data, and rank them for your strategy.', wide: false,
  inputs: () => G('Markets', A('zips', 'ZIP codes', [...new Set(S.deals.map(x => x.data.zip).filter(Boolean))].slice(0, 4).join(', ') || '21532, 21502, 15301, 26505', { rows: 2 }), Sel('strat', 'Strategy', Object.keys(STRAT), 'Cash flow', { w: true }))
    + `<div style="margin-top:6px">${btn('Load market data', 'data-df="heat-load"', 'btn primary')}</div><p class="note" id="heatStatus" aria-live="polite" style="margin:8px 0 0"></p>`,
  calc(V) {
    const zips = [...new Set(V.s('zips').split(/[^0-9]+/).filter(z => /^\d{5}$/.test(z)))].slice(0, 8);
    const have = zips.filter(z => S.mk[z] && !S.mk[z].error);
    if (!have.length) return empty('Enter ZIP codes and tap Load market data. Data comes from the U.S. Census American Community Survey (5-year estimates), so it covers every U.S. ZIP code.');
    const w = STRAT[V.s('strat')] || STRAT['Cash flow'];
    const rankOf = (k, z) => { const vals = have.map(x => S.mk[x][k]).filter(fin).sort((a, b) => a - b); return vals.indexOf(S.mk[z][k]); };
    const score = z => { let s = 0, tw = 0; Object.entries(w).forEach(([k, wt]) => { const vals = have.map(x => S.mk[x][k]).filter(fin); const v = S.mk[z][k]; if (!fin(v) || vals.length < 2) return; const mn = Math.min(...vals), mx = Math.max(...vals); const t = mx === mn ? .5 : (v - mn) / (mx - mn); s += (wt > 0 ? t : 1 - t) * Math.abs(wt); tw += Math.abs(wt); }); return tw ? Math.round(s / tw * 100) : 50; };
    const order = have.slice().sort((a, b) => score(b) - score(a));
    const miss = zips.filter(z => !have.includes(z));
    return verdict('good', `Best for ${esc(V.s('strat') || 'cash flow')}: ${order[0]}`, `Score ${score(order[0])}/100 across ${have.length} ZIP${have.length > 1 ? 's' : ''}. Green is better for this strategy, red is weaker, relative to the ZIPs you entered.`, 'RANKED')
      + card('Heat map', `<div class="tw" tabindex="0"><table class="t"><thead><tr><th>Measure</th>${order.map(z => `<th>${z}</th>`).join('')}</tr></thead><tbody>`
        + `<tr><td><b>Score</b></td>${order.map(z => `<td><b>${score(z)}</b><div style="height:5px;border-radius:3px;background:var(--line);margin-top:4px"><div style="height:5px;border-radius:3px;width:${score(z)}%;background:var(--accent)"></div></div></td>`).join('')}</tr>`
        + MKT_COLS.map(([k, l, f, up]) => `<tr><td>${l}</td>${order.map(z => `<td style="${up === null ? '' : heatBg(rankOf(k, z), have.length, up)}">${f(S.mk[z][k])}</td>`).join('')}</tr>`).join('')
        + `<tr><td>Rent by bedrooms</td>${order.map(z => `<td style="font-size:12px">${(S.mk[z].rentByBeds || []).map((r, i) => fin(r) ? `${i}BR ${fm(r)}` : '').filter(Boolean).join('<br>') || '—'}</td>`).join('')}</tr></tbody></table></div>`)
      + (miss.length ? `<p class="note">Not loaded yet or no data: ${miss.map(z => esc(z) + (S.mk[z] && S.mk[z].error ? ' (' + esc(S.mk[z].error) + ')' : '')).join(', ')}</p>` : '')
      + `<p class="note">Source: U.S. Census Bureau, American Community Survey 5-year estimates${S.mk[order[0]].year ? ' (' + S.mk[order[0]].year + ', growth vs ' + (S.mk[order[0]].year - 5) + ')' : ''}. Survey figures lag the market by 1–2 years; use them to compare areas, then check current listings and rents.</p>`;
  } });
async function loadMarkets(zips, statusSel) {
  const st = statusSel && $(statusSel); if (st) st.textContent = 'Loading Census data…';
  try { const j = await api('/api/market?zips=' + encodeURIComponent(zips.join(','))); Object.assign(S.mk, j.zips); save(); if (st) st.textContent = ''; return j; }
  catch (e) { if (st) st.textContent = 'Could not load market data: ' + e.message; return null; }
}

/* =================== JUDGE DEALS =================== */
tool({ id: 'maxoffer', group: 'Deal analysis', name: 'Max Offer', blurb: 'Work backwards from your targets to the highest price that still hits every one of them, and see which target sets the ceiling.',
  inputs: () => G('Deal', dealSel()) + G('Targets (from your buy box)', N('cap', 'Min cap rate', +(BOX().cap * 100).toFixed(2), { suf: '%' }), N('coc', 'Min cash-on-cash', +(BOX().coc * 100).toFixed(2), { suf: '%' }), N('dscr', 'Min DSCR', BOX().dscr, { suf: 'x' }), N('cfu', 'Min cash flow', BOX().cfu, { pre: '$', suf: '/unit/mo' })),
  calc(V) {
    const rec = pickDeal(V); if (!rec) return needDeal();
    const d = rec.data, b = BOX(), ask = d.price, t = { cap: V.p('cap', b.cap), coc: V.p('coc', b.coc), dscr: V.n('dscr', b.dscr), cfu: V.n('cfu', b.cfu) };
    const q0 = qm(d, b); if (!fin(q0.noi)) return empty('This deal needs rent or NOI before a max offer can be worked out. Open it in Import and fill the rent.');
    const base = fin(ask) && ask > 0 ? ask : q0.noi / .07;
    const lim = [['Cap rate', p => qm(d, b, p).cap >= t.cap, pc(t.cap, 1)], ['Cash-on-cash', p => qm(d, b, p).coc >= t.coc, pc(t.coc, 1)], ['DSCR', p => qm(d, b, p).dscr >= t.dscr, nx(t.dscr)], ['Cash flow / unit', p => qm(d, b, p).cfu >= t.cfu, fm(t.cfu) + '/mo']]
      .map(([l, f, need]) => ({ l, need, max: Math.floor(maxFor(f, base) / 1000) * 1000 }));
    const top = Math.min(...lim.map(x => x.max)), bind = lim.find(x => x.max === top), qt = qm(d, b, top);
    const vs = fin(ask) && ask > 0 ? top / ask - 1 : NaN;
    S.maxOffer = S.maxOffer || {}; S.maxOffer[rec.id] = top;
    return verdict(top <= 0 ? 'bad' : vs >= 0 ? 'good' : vs > -.1 ? 'warn' : 'bad', top > 0 ? `Max offer: ${fm(top)}` : 'No price hits all your targets', top > 0 ? `${fin(vs) ? (vs >= 0 ? pc(vs, 1) + ' above' : pc(-vs, 1) + ' below') + ' asking (' + fm(ask) + '). ' : ''}The ceiling is set by your ${esc(bind.l.toLowerCase())} target (${bind.need}).${q0.est ? ' NOI is estimated because expenses weren’t disclosed.' : ''}` : 'Rents are too low for your targets at any price with this financing. Check the rent, or relax a target.', top > 0 ? (vs >= 0 ? 'AT ASK' : 'NEGOTIATE') : 'PASS')
      + card('Highest price for each target', tbl(['Target', 'Needs', 'Max price', ''], lim.map(x => [esc(x.l), x.need, fm(x.max), x === bind ? tag('warn', 'Sets ceiling') : ''])))
      + (top > 0 ? card('At your max offer', `<div class="cards">${stat('Cap rate', pc(qt.cap, 2))}${stat('Cash-on-cash', pc(qt.coc, 1))}${stat('DSCR', nx(qt.dscr))}${stat('Cash flow / mo', fm(qt.cf / 12))}</div><div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap">${btn('Write an offer letter at ' + fk(top), `data-df-loi="${esc(rec.id)}" data-price="${top}"`, 'btn primary sm')}</div>`) : '');
  } });

function redFlags(d) {
  const F = [], b = BOX(), q = qm(d, b), notes = String(d.notes || '').toLowerCase(), yr = d.yearBuilt;
  const add = (lvl, t) => F.push([lvl, t]);
  if (!fin(d.price)) add('bad', 'No asking price. Ask the broker for pricing guidance before spending time.');
  if (!fin(d.grossRentMonthly) && !fin(d.avgRentPerUnit) && !fin(d.noi)) add('bad', 'No rents or NOI disclosed. Request the rent roll and trailing-12-month (T-12) statement.');
  if (!fin(d.noi) && !fin(d.expensesAnnual)) add('warn', 'Expenses aren’t disclosed, so NOI here is an estimate. Get the T-12 and last two years of tax returns or P&Ls.');
  if (fin(d.expensesAnnual) && fin(q.egi) && q.egi > 0) { const r = d.expensesAnnual / q.egi, com = ['Retail', 'Office', 'Industrial'].includes(d.propertyType);
    if (!com && r < .3) add('bad', `Expenses are only ${pc(r, 0)} of income. Residential usually runs 35–50%, so NOI is probably overstated (missing management, repairs, reserves or payroll).`);
    else if (!com && r < .38) add('warn', `Expense ratio of ${pc(r, 0)} is on the light side. Check that management, repairs and reserves are included.`); }
  if (fin(d.capRate) && fin(d.noi) && fin(d.price) && Math.abs(d.noi / d.price * 100 - d.capRate) > .75) add('warn', `Stated cap rate (${d.capRate}%) doesn’t match NOI ÷ price (${pc(d.noi / d.price, 2)}). Ask how the broker calculated it.`);
  if (/pro ?forma|projected|potential|could (be|achieve)|upside|below market/.test(notes)) add('warn', 'The listing leans on pro forma or projected income. Underwrite on actual in-place rents and treat upside as a bonus.');
  if (fin(d.occupancyPct) && d.occupancyPct < 85) add('bad', `Occupancy is ${d.occupancyPct}%. Find out why units are empty (condition, market, management) and budget for lease-up.`);
  else if (fin(d.occupancyPct) && d.occupancyPct < 92) add('warn', `Occupancy of ${d.occupancyPct}% is below a stabilized 93–95%.`);
  if (fin(yr) && yr < 1978) add('warn', `Built in ${yr}: lead-paint disclosure applies. Budget for lead-safe work on turnovers.`);
  if (fin(yr) && yr < 1960) add('warn', 'Pre-1960 building: have an inspector check wiring (knob and tube), plumbing (galvanized or cast iron), sewer lateral and asbestos.');
  if (!fin(d.taxesAnnual)) add('warn', 'Property taxes not shown. Look up the tax bill and check whether a sale triggers reassessment in this county.');
  else if (fin(d.price) && d.taxesAnnual / d.price < .006) add('warn', `Taxes are ${pc(d.taxesAnnual / d.price, 2)} of price, which is low. Many counties reassess at the sale price, so model a higher tax bill.`);
  if (!fin(d.insuranceAnnual)) add('mut', 'Insurance not shown. Get a quote early; premiums have risen sharply in many states.');
  if (fin(q.grm) && q.grm > 14) add('warn', `Gross rent multiplier is ${q.grm.toFixed(1)}. The price is high relative to rents for a cash-flow deal.`);
  if (fin(q.dscr) && q.dscr < b.dscr) add('bad', `At asking price, DSCR is ${nx(q.dscr)}, below your ${nx(b.dscr)} minimum. Most lenders won’t lend the full amount.`);
  if (d.unitMix && d.unitMix.length && fin(d.units) && sum(d.unitMix.map(u => u.count)) !== d.units) add('warn', 'The unit mix doesn’t add up to the unit count. Ask for the rent roll to confirm.');
  [[/as.?is|cash only|fixer|tlc|handyman|needs work/, 'bad', 'Listed as-is or needs work: expect significant repairs and a harder time financing. Get contractor bids before offering.'],
   [/deferred maintenance|roof|foundation|structural|sewer|septic|mold|water damage|fire/, 'bad', 'Condition issues are mentioned (roof, foundation, water, mold or fire). Get a full inspection and repair bids.'],
   [/rent control|rent stabiliz/, 'warn', 'Rent control or stabilization is mentioned. Rent increases may be capped by law.'],
   [/section 8|hcv|voucher/, 'mut', 'Section 8 tenants mentioned. Rents are reliable, but check inspection requirements and payment standards.'],
   [/do not disturb|tenant.?occupied|drive.?by only/, 'mut', 'Tenant-occupied, drive-by only: you may not see interiors before an offer. Make the offer subject to inspection.'],
   [/nnn|triple net/, 'mut', 'NNN lease: check the lease terms, tenant credit and remaining term. The deal is only as good as the lease.'],
   [/lease (expir|ending)|month.?to.?month/, 'warn', 'Leases are expiring or month-to-month: income may not hold. Review the lease expiration schedule.'],
   [/flood/, 'warn', 'Flood zone mentioned. Price flood insurance before offering.'],
   [/auction|reo|bank.?owned|short sale/, 'warn', 'Auction, bank-owned or short sale: timelines and terms are rigid. Read the purchase terms carefully.'],
   [/seller financ|owner financ|assumable/, 'good', 'Seller financing or an assumable loan is mentioned. That can improve returns; see the Creative Financing tool.']].forEach(([re, lvl, t]) => { if (re.test(notes)) add(lvl, t); });
  if (!F.length) add('good', 'No obvious red flags in the listing data. Still verify rents, expenses and condition during due diligence.');
  const order = { bad: 0, warn: 1, mut: 2, good: 3 }; return F.sort((a, b) => order[a[0]] - order[b[0]]);
}
tool({ id: 'flags', group: 'Deal analysis', name: 'Red-Flag Scanner', blurb: 'Scans a saved deal for the problems that sink investors: overstated income, missing expenses, tax reassessment, old systems, condition and lease risks.',
  inputs: () => G('Deal', dealSel()),
  calc(V) {
    const rec = pickDeal(V); if (!rec) return needDeal();
    const F = redFlags(rec.data), bad = F.filter(f => f[0] === 'bad').length, warn = F.filter(f => f[0] === 'warn').length;
    return verdict(bad ? 'bad' : warn ? 'warn' : 'good', bad ? `${bad} serious issue${bad > 1 ? 's' : ''} to resolve` : warn ? `${warn} thing${warn > 1 ? 's' : ''} to check` : 'Nothing alarming found', esc(rec.name), bad ? 'RED FLAGS' : warn ? 'CHECK' : 'CLEAN')
      + card('What we found', flags(F))
      + card('Ask the broker for', ul(['Rent roll with lease start and end dates', 'Trailing 12-month (T-12) operating statement and last 2 years of P&Ls', 'Current tax bill and insurance declarations page', 'Utility bills and who pays each utility', 'List of capital improvements with dates (roof, HVAC, water heaters)', 'Any service contracts, laundry or parking agreements']));
  } });

tool({ id: 'rentcheck', group: 'Market research', name: 'Rent Check', blurb: 'Is the listing’s rent realistic? Compare it with Census median rents for the ZIP by bedroom count, and pull a live rent estimate with nearby rentals when RentCast is connected.',
  inputs: () => G('Deal', dealSel(), N('beds', 'Typical bedrooms per unit', 2), T('zip', 'ZIP override', '', { ph: 'Uses the deal’s ZIP', w: false }))
    + `<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">${btn('Get ZIP benchmarks', 'data-df="rent-mkt"', 'btn primary')}${btn('Live rent estimate', 'data-df="rent-live"', 'btn')}</div><p class="note" id="rentStatus" aria-live="polite" style="margin:8px 0 0"></p>`,
  calc(V) {
    const rec = pickDeal(V); if (!rec) return needDeal();
    const d = rec.data, zip = (V.s('zip') || d.zip || '').trim(), beds = clamp(Math.round(V.n('beds', 2)), 0, 4), m = S.mk[zip];
    const units = d.units > 0 ? d.units : 1, avg = fin(d.avgRentPerUnit) ? d.avgRentPerUnit : fin(d.grossRentMonthly) ? d.grossRentMonthly / units : NaN;
    let out = '';
    if (m && !m.error) {
      const bench = fin(m.rentByBeds && m.rentByBeds[beds]) ? m.rentByBeds[beds] : m.rent, gap = fin(avg) && bench ? avg / bench - 1 : NaN;
      out += verdict(!fin(gap) ? 'mut' : gap > .15 ? 'bad' : gap > .05 ? 'warn' : 'good', !fin(gap) ? 'Add the deal’s rent to compare' : gap > 0 ? `Listing rent is ${pc(gap, 0)} above the ZIP median` : `Listing rent is ${pc(-gap, 0)} below the ZIP median`,
        fin(gap) ? (gap > .15 ? 'Rents this far above the area median need proof: renovated units, amenities, or signed leases. Underwrite closer to the median unless the rent roll backs it up.' : gap < -.1 ? 'Rents are below the area median, which may mean upside after renovations or better management. Confirm with current listings nearby.' : 'Rents are in line with the area.') : '', !fin(gap) ? 'NO RENT' : gap > .15 ? 'HIGH' : gap > .05 ? 'CHECK' : 'IN LINE')
        + card(`ZIP ${esc(zip)} benchmarks`, kv('Listing avg rent / unit', fm(avg)) + kv(`Median rent, ${beds} bedroom${beds === 1 ? '' : 's'}`, fm(bench)) + kv('Median rent, all units', fm(m.rent)) + kv('Vacancy', pc(m.vacancy, 1)) + kv('Rent growth, 5 years', pc(m.rentGrowth5, 1)) + `<p class="note" style="margin:8px 0 0">Census medians include older and smaller units and lag current asking rents by 1–2 years, so newer or renovated units often rent 10–20% higher.</p>`);
    } else out += empty(zip ? `Tap Get ZIP benchmarks to load Census rents for ${esc(zip)}.` : 'This deal has no ZIP. Enter one to compare rents.');
    const key = [d.address, d.city, d.state, d.zip].filter(Boolean).join(', '), rc = S.rc[key];
    if (rc && rc.available === false) out += card('Live rent estimate', `<p class="note" style="margin:0">Live estimates with nearby rental comps need a RentCast API key (rentcast.io). Add <b>RENTCAST_API_KEY</b> in Cloudflare → Settings → Variables and Secrets.</p>`);
    else if (rc && rc.error) out += card('Live rent estimate', `<p class="note" style="margin:0">${esc(rc.error)}</p>`);
    else if (rc) out += card('Live rent estimate (RentCast)', kv('Estimated rent', fm(rc.rent)) + kv('Range', fm(rc.low) + ' – ' + fm(rc.high)) + (rc.comps && rc.comps.length ? tbl(['Nearby rental', 'Rent', 'Beds', 'Baths', 'SF', 'Miles'], rc.comps.map(c => [esc(c.address), fm(c.rent), nm(c.beds), nm(c.baths, 1), nm(c.sqft), fin(c.distance) ? c.distance.toFixed(1) : '—'])) : ''));
    return out;
  } });

/* =================== MANAGE DEALS =================== */
tool({ id: 'compare', group: 'Manage deals', name: 'Compare Deals', blurb: 'Line up to six saved deals side by side on the numbers that matter, with the best in each row highlighted and an overall ranking.', wide: true,
  inputs: () => G('Deals to compare', S.deals.length ? `<div class="f w" style="display:flex;flex-direction:column;gap:6px">${S.deals.slice(0, 60).map(x => `<label class="chk"><input type="checkbox" data-df-cmp="${esc(x.id)}"${S.cmp.includes(x.id) ? ' checked' : ''}><span>${esc(x.name)}${fin(x.data.price) ? ' · ' + fk(x.data.price) : ''}</span></label>`).join('')}</div>` : '<p class="note">No saved deals yet.</p>', Sel('rank', 'Rank by', ['Cash-on-cash', 'Cap rate', 'Cash flow', 'DSCR', 'Price per unit'], 'Cash-on-cash', { w: true })),
  calc(V) {
    const L = S.cmp.map(dealById).filter(Boolean).slice(0, 6); if (L.length < 2) return empty(S.deals.length < 2 ? 'Save at least two deals to compare them.' : 'Tick two or more deals on the left.');
    const b = BOX(), R = L.map(x => ({ x, r: screen(x.data, b) }));
    const rk = { 'Cash-on-cash': o => o.r.q.coc, 'Cap rate': o => o.r.q.cap, 'Cash flow': o => o.r.q.cf, 'DSCR': o => o.r.q.dscr, 'Price per unit': o => -o.r.q.ppu }[V.s('rank')] || (o => o.r.q.coc);
    R.sort((a, c) => (fin(rk(c)) ? rk(c) : -1e12) - (fin(rk(a)) ? rk(a) : -1e12));
    const rows = [['Asking price', o => o.x.data.price, fm, 0], ['Units', o => o.x.data.units, v => nm(v), 0], ['Price / unit', o => o.r.q.ppu, fm, -1], ['NOI / year', o => o.r.q.noi, fm, 1], ['Cap rate', o => o.r.q.cap, v => pc(v, 2), 1], ['Cash flow / month', o => o.r.q.cf / 12, fm, 1], ['Cash-on-cash', o => o.r.q.coc, v => pc(v, 1), 1], ['DSCR', o => o.r.q.dscr, nx, 1], ['Gross rent multiplier', o => o.r.q.grm, v => fin(v) ? v.toFixed(1) : '—', -1], ['Cash needed', o => o.r.q.equity, fm, -1], ['Year built', o => o.x.data.yearBuilt, v => fin(v) ? v : '—', 0]];
    const best = (f, dir) => { if (!dir) return null; const v = R.map(f).filter(fin); return v.length ? (dir > 0 ? Math.max(...v) : Math.min(...v)) : null; };
    return verdict('good', `#1 by ${esc(V.s('rank') || 'cash-on-cash').toLowerCase()}: ${esc(R[0].x.name)}`, R.some(o => o.r.q.est) ? 'Some NOI figures are estimated because expenses weren’t disclosed.' : '', 'RANKED')
      + card('Side by side', `<div class="tw" tabindex="0"><table class="t"><thead><tr><th></th>${R.map((o, i) => `<th>#${i + 1} ${esc(o.x.name)}</th>`).join('')}</tr></thead><tbody>`
        + rows.map(([l, f, fmt, dir]) => { const bv = best(f, dir); return `<tr><td>${l}</td>${R.map(o => { const v = f(o); return `<td${bv != null && v === bv ? ' style="background:var(--good-bg);font-weight:700"' : ''}>${fmt(v)}</td>`; }).join('')}</tr>`; }).join('')
        + `<tr><td>Buy box</td>${R.map(o => `<td>${badge(o.r)}</td>`).join('')}</tr><tr><td>Stage</td>${R.map(o => `<td>${esc(o.x.stage || 'Found')}</td>`).join('')}</tr><tr><td></td>${R.map(o => `<td>${btn('Open', `data-load-deal="${esc(o.x.id)}"`)} ${btn('Share', `data-df-share="${esc(o.x.id)}"`)}</td>`).join('')}</tr></tbody></table></div>`);
  } });

tool({ id: 'pipeline', group: 'Manage deals', name: 'Deal Pipeline', blurb: 'Track every deal from first look to closing. Move deals between stages, keep notes and next steps, and see what needs attention this week.', wide: true,
  inputs: () => G('Pipeline', T('q', 'Search', '', { ph: 'Name, city or note', w: false }), Sel('hide', 'Show', ['Active deals', 'Everything'], 'Active deals'), T('add', 'Add a deal by name or address', '', { ph: '123 Main St, Cumberland MD' }))
    + `<div style="margin-top:6px">${btn('Add to pipeline', 'data-df="pipe-add"', 'btn')}</div>`,
  calc(V) {
    if (!S.deals.length) return empty('Your pipeline is empty. Import a listing, use the Deal Inbox, or add a deal by name on the left.');
    const q = V.s('q').toLowerCase(), all = V.s('hide') === 'Everything', b = BOX(), today = new Date().toISOString().slice(0, 10);
    const L = S.deals.filter(x => !q || [x.name, x.data.city, x.notes].join(' ').toLowerCase().includes(q));
    const cols = all ? STAGES : STAGES.filter(s => !['Closed', 'Passed'].includes(s));
    const due = L.filter(x => x.next && x.next <= today && !['Closed', 'Passed'].includes(x.stage || 'Found'));
    const cardH = x => { const r = screen(x.data, b), i = STAGES.indexOf(x.stage || 'Found');
      return `<div class="pcard"><div style="display:flex;justify-content:space-between;gap:6px;align-items:flex-start"><b>${esc(x.name)}</b>${badge(r)}</div>
        <div class="mut" style="font-size:12px;margin:3px 0 6px">${fin(x.data.price) ? fk(x.data.price) : 'No price'}${fin(r.q.cap) ? ' · cap ' + pc(r.q.cap, 1) : ''}${fin(r.q.cf) ? ' · ' + fm(r.q.cf / 12) + '/mo' : ''}${x.source ? ' · ' + esc(x.source) : ''}</div>
        <label class="pl">Next step <input type="date" data-df-deal="${esc(x.id)}" data-f="next" value="${esc(x.next || '')}"${x.next && x.next <= today ? ' style="border-color:var(--bad)"' : ''}></label>
        <textarea data-df-deal="${esc(x.id)}" data-f="notes" rows="2" placeholder="Notes" aria-label="Notes for ${esc(x.name)}">${esc(x.notes || '')}</textarea>
        <div class="pbtns">${i > 0 ? btn('◀', `data-df-move="${esc(x.id)}" data-d="-1" aria-label="Move back"`) : ''}<select data-df-deal="${esc(x.id)}" data-f="stage" aria-label="Stage">${STAGES.map(s => `<option${s === (x.stage || 'Found') ? ' selected' : ''}>${s}</option>`).join('')}</select>${i < STAGES.length - 1 ? btn('▶', `data-df-move="${esc(x.id)}" data-d="1" aria-label="Move forward"`) : ''}${btn('Open', `data-load-deal="${esc(x.id)}"`)}${btn('Share', `data-df-share="${esc(x.id)}"`)}</div></div>`; };
    return (due.length ? verdict('warn', `${due.length} deal${due.length > 1 ? 's' : ''} need${due.length > 1 ? '' : 's'} a next step today`, due.map(x => esc(x.name)).join(', '), 'DUE') : '')
      + `<div class="pboard">${cols.map(s => { const C = L.filter(x => (x.stage || 'Found') === s); return `<div class="pcol"><h3 class="eyebrow">${s} <span class="mut">${C.length}</span></h3>${C.map(cardH).join('') || '<p class="note">—</p>'}</div>`; }).join('')}</div>`;
  } });

/* =================== ACT ON DEALS =================== */
tool({ id: 'loi', group: 'Execution', name: 'Letter of Intent', blurb: 'Turn your numbers into a non-binding offer letter for the broker: price, earnest money, due diligence, financing and closing terms.',
  inputs: () => G('Deal', dealSel(), N('price', 'Offer price', '', { pre: '$', ph: 'Your max offer', w: true })) + G('You', T('buyer', 'Buyer name', '', { ph: 'Your full name' }), T('entity', 'Buying entity', '', { ph: 'e.g. Maple Holdings LLC, and/or assigns' }), T('to', 'Addressed to', '', { ph: 'Broker or seller name' }))
    + G('Terms', N('em', 'Earnest money', '', { pre: '$', ph: '1% of price' }), N('dd', 'Due diligence period', 30, { suf: 'days' }), N('closeD', 'Close within', 45, { suf: 'days' }), C('fin', 'Subject to financing', true), N('finD', 'Financing contingency', 30, { suf: 'days' }), N('exp', 'Offer expires in', 5, { suf: 'days' }), A('extra', 'Other terms', 'Seller to provide rent roll, trailing 12-month operating statement, leases, service contracts and utility bills within 5 days of acceptance.', { rows: 3 })),
  calc(V) {
    const rec = pickDeal(V); if (!rec) return needDeal();
    const d = rec.data, mo = (S.maxOffer || {})[rec.id], price = V.n('price', fin(mo) && mo > 0 ? mo : fin(d.price) ? Math.round(d.price * .92 / 1000) * 1000 : NaN);
    const em = V.n('em', fin(price) ? Math.round(price * .01 / 500) * 500 : NaN), buyer = V.s('buyer') || '[Your name]', ent = V.s('entity') || buyer, to = V.s('to') || 'Listing Broker';
    const addr = [d.address, d.city, d.state, d.zip].filter(Boolean).join(', ') || rec.name, date = new Date(), exp = addDays(date, V.n('exp', 5));
    const P = [
      `${date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`, `Dear ${esc(to)},`,
      `This letter sets out the principal terms on which ${esc(ent)} (“Buyer”) proposes to purchase the property at <b>${esc(addr)}</b> (the “Property”)${fin(d.units) ? `, consisting of ${d.units} units` : ''}.`,
      `<b>1. Purchase price.</b> ${fm(price)}, payable in cash at closing${V.b('fin') ? ', with the balance funded by a new first mortgage loan' : ''}.`,
      `<b>2. Earnest money.</b> ${fm(em)}, deposited with a mutually agreed title company within 3 business days of a signed purchase agreement, refundable during the due diligence period.`,
      `<b>3. Due diligence.</b> ${V.n('dd', 30)} days from receipt of all seller documents to inspect the Property and review its financial records, leases and title. Buyer may terminate for any reason during this period with a full refund of earnest money.`,
      V.b('fin') ? `<b>4. Financing.</b> Subject to Buyer obtaining a loan on acceptable terms within ${V.n('finD', 30)} days of the purchase agreement.` : `<b>4. Financing.</b> This offer is not subject to financing.`,
      `<b>5. Closing.</b> On or before ${V.n('closeD', 45)} days after the purchase agreement is signed. Customary closing costs to be split per local custom.`,
      V.s('extra') ? `<b>6. Other terms.</b> ${esc(V.s('extra'))}` : '',
      `<b>Non-binding.</b> This letter is an expression of interest only and is not a binding contract. Neither party is bound until a definitive purchase agreement is signed by both. This offer expires at 5:00 pm on ${exp.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.`,
      `Sincerely,<br><br>${esc(buyer)}${ent !== buyer ? '<br>' + esc(ent) : ''}`].filter(Boolean);
    S.loiHtml = `<div class="letter"><h1>Letter of Intent</h1><p class="muted">Re: ${esc(addr)}</p>${P.map(p => `<p>${p}</p>`).join('')}</div>`;
    return card('Preview', `<div class="paper">${S.loiHtml}</div><div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">${btn('Print or save as PDF', 'data-df="loi-print"', 'btn primary sm')}${btn('Copy text', 'data-df="loi-copy"')}</div><p class="note">A starting point, not legal advice. Have your attorney or agent review before sending.</p>`);
  } });

tool({ id: 'lender', group: 'Execution', name: 'Lender Summary', blurb: 'A clean one-page deal summary to send lenders or partners: property, income, the loan you’re asking for, debt coverage, and sources and uses of funds.',
  inputs: () => G('Deal', dealSel()) + G('Loan request (defaults from your buy box)', N('ltv', 'Loan-to-value', +(BOX().ltv * 100).toFixed(1), { suf: '%' }), N('rate', 'Rate', +(BOX().rate * 100).toFixed(2), { suf: '%' }), N('amort', 'Amortization', BOX().amort, { suf: 'yrs' }), N('reno', 'Renovation budget', 0, { pre: '$' }))
    + G('Sponsor', T('sponsor', 'Your name / company', ''), T('contact', 'Phone or email', ''), A('exp', 'Experience', 'Owner-operator of residential rental property.', { rows: 3 })),
  calc(V) {
    const rec = pickDeal(V); if (!rec) return needDeal();
    const d = rec.data, b = { ...BOX(), ltv: V.p('ltv', BOX().ltv), rate: V.p('rate', BOX().rate), amort: V.n('amort', BOX().amort) }, q = qm(d, b), reno = V.n('reno', 0);
    const closing = d.price * b.close, uses = d.price + closing + reno, loan = q.loan, equity = uses - loan;
    const addr = [d.address, d.city, d.state, d.zip].filter(Boolean).join(', ') || rec.name;
    const row = (l, v) => `<tr><td>${l}</td><td>${v}</td></tr>`;
    S.lenderHtml = `<h1>${esc(addr)}</h1><p class="muted">${esc([d.propertyType, fin(d.units) ? d.units + ' units' : '', fin(d.yearBuilt) ? 'built ' + d.yearBuilt : '', fin(d.sqft) ? nm(d.sqft) + ' SF' : ''].filter(Boolean).join(' · '))}</p>
      <h2>Loan request</h2><table>${row('Loan amount', fm(loan))}${row('Loan-to-value', pc(b.ltv, 0))}${row('Rate / amortization', pc(b.rate, 2) + ' / ' + b.amort + ' years')}${row('Annual debt service', fm(q.ds))}${row('DSCR', nx(q.dscr))}${row('Debt yield', pc(q.noi / loan, 1))}</table>
      <h2>Income</h2><table>${row('Gross scheduled rent / year', fm(q.gross * 12))}${row('Occupancy', fin(d.occupancyPct) ? d.occupancyPct + '%' : 'Not stated')}${row('Effective gross income', fm(q.egi))}${row('Operating expenses', fm(q.egi - q.noi))}${row('Net operating income', fm(q.noi) + (q.est ? ' (estimated)' : ''))}${row('Cap rate at purchase price', pc(q.cap, 2))}</table>
      <h2>Sources and uses</h2><table>${row('Purchase price', fm(d.price))}${row('Closing costs', fm(closing))}${reno ? row('Renovation', fm(reno)) : ''}${row('<b>Total uses</b>', '<b>' + fm(uses) + '</b>')}${row('Senior loan', fm(loan))}${row('Sponsor equity', fm(equity))}</table>
      <h2>Sponsor</h2><p>${esc(V.s('sponsor') || '[Your name]')}${V.s('contact') ? ' · ' + esc(V.s('contact')) : ''}</p><p>${esc(V.s('exp'))}</p>
      <p class="muted">Prepared with Napkin Math on ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}. Figures are based on listing information and assumptions; subject to verification.</p>`;
    return verdict(q.dscr >= 1.25 ? 'good' : q.dscr >= 1.15 ? 'warn' : 'bad', `DSCR ${nx(q.dscr)} on a ${fk(loan)} loan`, q.dscr >= 1.25 ? 'Meets the 1.20–1.25x most lenders require.' : 'Below the 1.20–1.25x most lenders require. Lower the loan amount or negotiate the price.', q.dscr >= 1.25 ? 'BANKABLE' : 'TIGHT')
      + card('Preview', `<div class="paper">${S.lenderHtml}</div><div style="margin-top:12px">${btn('Print or save as PDF', 'data-df="lender-print"', 'btn primary sm')}</div>`);
  } });

function V5() { const vals = S.v.five || {}; return { n(k, d = NaN) { const x = toN(vals[k]); return fin(x) ? x : d; }, p(k, d = NaN) { const x = toN(vals[k]); return fin(x) ? x / 100 : d; }, s(k) { return vals[k] == null ? '' : String(vals[k]); }, b(k) { return !!vals[k]; } }; }
tool({ id: 'split', group: 'Execution', name: 'Partner Split', blurb: 'Raising money from partners? Model a preferred return and profit split, and see what investors and you each earn year by year and at sale.', wide: false,
  inputs: () => G('Cash flows', Sel('src', 'Use cash flows from', ['5-Minute Analysis', 'Enter below'], '5-Minute Analysis', { w: true }), N('eq', 'Total equity raised', 400000, { pre: '$' }), N('yrs', 'Hold period', 5, { suf: 'yrs' }), N('cf', 'Year 1 cash flow', 32000, { pre: '$' }), N('g', 'Cash flow growth', 3, { suf: '%/yr' }), N('sale', 'Net sale proceeds', 620000, { pre: '$', hint: 'After loan payoff and selling costs', w: true }))
    + G('Deal terms', N('lp', 'Investors put in', 90, { suf: '% of equity' }), N('pref', 'Preferred return', 8, { suf: '%' }), N('split', 'Investor share above pref', 70, { suf: '%' }), N('fee', 'Acquisition fee to you', 1.5, { suf: '% of price', hint: 'Paid at closing, on top of the split' }), N('px', 'Purchase price', 1000000, { pre: '$' })),
  calc(V) {
    let eq = V.n('eq', 0), yrs = clamp(Math.round(V.n('yrs', 5)), 1, 15), cfs = [], sale = V.n('sale', 0), src = V.s('src'), price = V.n('px', 0);
    if (src !== 'Enter below' && S.v.five) { try { const p = fiveParams(V5()), ask = V5().n('price', 0), offer = Math.round(ask * V5().n('offerPct', 100) / 100 / 1000) * 1000, m = fiveModel(p, offer); eq = m.equity; yrs = p.hold; cfs = m.rows.slice(1, p.hold + 1).map(r => r.cf); sale = m.netSale; price = offer; } catch (e) { cfs = []; } }
    if (!cfs.length) { const g = V.p('g', .03); cfs = Array.from({ length: yrs }, (_, i) => V.n('cf', 0) * Math.pow(1 + g, i)); }
    if (!(eq > 0)) return empty('Enter the equity raised.');
    const lpE = eq * V.p('lp', .9), gpE = eq - lpE, pref = V.p('pref', .08), sp = V.p('split', .7), fee = price * V.p('fee', 0);
    let owed = { lp: 0, gp: 0 }; const rows = [], lpF = [-lpE], gpF = [-gpE + fee];
    cfs.forEach((cf, i) => { owed.lp += lpE * pref; owed.gp += gpE * pref; let c = Math.max(0, cf), lp = 0, gp = 0;
      const pp = Math.min(c, owed.lp + owed.gp), sh = (owed.lp + owed.gp) ? owed.lp / (owed.lp + owed.gp) : 0; lp += pp * sh; gp += pp * (1 - sh); owed.lp -= pp * sh; owed.gp -= pp * (1 - sh); c -= pp;
      lp += c * sp; gp += c * (1 - sp);
      let sLP = 0, sGP = 0;
      if (i === cfs.length - 1) { let s = Math.max(0, sale); const cap = Math.min(s, eq); sLP += cap * lpE / eq; sGP += cap * gpE / eq; s -= cap; const up = Math.min(s, owed.lp + owed.gp), sh2 = (owed.lp + owed.gp) ? owed.lp / (owed.lp + owed.gp) : 0; sLP += up * sh2; sGP += up * (1 - sh2); s -= up; sLP += s * sp; sGP += s * (1 - sp); }
      rows.push([i + 1, fm(cf), fm(lp), fm(gp), i === cfs.length - 1 ? fm(sLP) + ' / ' + fm(sGP) : '']); lpF.push(lp + sLP); gpF.push(gp + sGP); });
    const lpIrr = irr(lpF), gpIrr = gpE > 0 ? irr(gpF) : NaN, lpM = sum(lpF.slice(1)) / lpE, gpTot = sum(gpF.slice(1)) + fee;
    return verdict(lpIrr >= .12 ? 'good' : lpIrr >= .08 ? 'warn' : 'bad', `Investors: ${pc(lpIrr, 1)} IRR, ${nx(lpM)} their money`, `You put in ${fm(gpE)} and receive ${fm(gpTot)} in total${fee ? ` including a ${fm(fee)} acquisition fee` : ''}${fin(gpIrr) ? ` (${pc(gpIrr, 1)} IRR)` : ''}. Most investors look for 12–18% IRR on value-add deals.`, lpIrr >= .12 ? 'ATTRACTIVE' : lpIrr >= .08 ? 'MODEST' : 'WEAK')
      + card('Year by year', tbl(['Year', 'Cash flow', 'To investors', 'To you', 'Sale: investors / you'], rows))
      + card('How the split works', `<p class="note" style="margin:0">Each year's cash flow first pays the ${pc(pref, 0)} preferred return on everyone's capital (unpaid pref carries forward). What's left is split ${pc(sp, 0)} to investors and ${pc(1 - sp, 0)} to you. At sale, capital is returned first, then any unpaid pref, then the same split.${src !== 'Enter below' && S.v.five ? ' Cash flows come from your 5-Minute Analysis.' : ''} Have a securities attorney review any raise from outside investors.</p>`);
  } });

/* ---------- events ---------- */
document.addEventListener('click', async e => {
  const b = e.target.closest('button'); if (!b || VIEWER()) return;
  if (b.dataset.dfGo) { go(b.dataset.dfGo); return; }
  if (b.dataset.loadDeal) { const x = dealById(b.dataset.loadDeal); if (x) { applyDeal(x.data); go('five'); } return; }
  if (b.dataset.dfShare) { const x = dealById(b.dataset.dfShare); if (!x) return; b.disabled = true;
    try { const q = qm(x.data); const j = await api('/api/share', { name: x.name, deal: x.data, note: x.notes || '', metrics: { noi: q.noi, cap: q.cap, cf: q.cf, coc: q.coc, dscr: q.dscr, grm: q.grm, ppu: q.ppu, ltv: q.ltv, rate: q.rate, est: q.est } });
      try { await navigator.clipboard.writeText(j.url); } catch (er) {}
      toast(`Share link copied. Anyone with it can view this deal for ${j.days} days:<br><a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.url)}</a>`, 12000); }
    catch (er) { toast('Could not create a link: ' + esc(er.message)); } finally { b.disabled = false; } return; }
  if (b.dataset.dfMove) { const x = dealById(b.dataset.dfMove); if (x) { const i = clamp(STAGES.indexOf(x.stage || 'Found') + (+b.dataset.d), 0, STAGES.length - 1); x.stage = STAGES[i]; save(); run('pipeline'); } return; }
  if (b.dataset.dfLoi) { (S.v.loi = S.v.loi || {}).deal = b.dataset.dfLoi; S.v.loi.price = b.dataset.price; save(); if (document.getElementById('t-loi')) build('loi'); go('loi'); return; }
  if (b.dataset.dfLeadDeal) { const l = S.leads[+b.dataset.dfLeadDeal]; if (!l) return; const d = normDeal({ address: l.address, city: l.city, state: l.state, zip: l.zip, units: l.units, notes: 'Off-market lead: ' + leadScore(l).why.join(', ') }, ''); _saveDeal(d); const rec = S.deals[0]; rec.stage = 'Analyzing'; rec.source = 'Lead'; dealsChanged(); toast('Added to your pipeline. Fill in rents and price in Import to analyze it.'); go('pipeline'); return; }
  const a = b.dataset.df; if (!a) return;
  if (a === 'inbox-run') runInbox();
  else if (a === 'inbox-stop') { if (INBOX.ctl) INBOX.ctl.abort(); }
  else if (a === 'leads-import') { importLeads((S.v.leads || {}).csv || ''); if (S.v.leads) { S.v.leads.csv = ''; save(); build('leads'); } }
  else if (a === 'leads-export') exportLeads();
  else if (a === 'leads-clear') { if (b.dataset.armed) { S.leads = []; save(); run('leads'); } else { b.dataset.armed = '1'; b.textContent = 'Tap again to delete all leads'; setTimeout(() => { if (b.isConnected) { delete b.dataset.armed; b.textContent = 'Clear all leads'; } }, 4000); } }
  else if (a === 'heat-load') { const zips = [...new Set(String((S.v.heat || {}).zips || $('#heat-zips')?.value || '').split(/[^0-9]+/).filter(z => /^\d{5}$/.test(z)))].slice(0, 8); if (!zips.length) { $('#heatStatus').textContent = 'Enter 5-digit ZIP codes.'; return; } b.disabled = true; await loadMarkets(zips, '#heatStatus'); b.disabled = false; run('heat'); }
  else if (a === 'rent-mkt' || a === 'rent-live') {
    const v = S.v.rentcheck || {}, rec = dealById(v.deal) || S.deals[0]; if (!rec) return; const st = $('#rentStatus');
    if (a === 'rent-mkt') { const zip = (v.zip || rec.data.zip || '').trim(); if (!/^\d{5}$/.test(zip)) { st.textContent = 'This deal needs a 5-digit ZIP.'; return; } b.disabled = true; await loadMarkets([zip], '#rentStatus'); b.disabled = false; }
    else { const d = rec.data, key = [d.address, d.city, d.state, d.zip].filter(Boolean).join(', '); if (!d.address) { st.textContent = 'A live estimate needs the street address.'; return; }
      b.disabled = true; st.textContent = 'Getting a live estimate…';
      try { const qs = new URLSearchParams({ address: key, bedrooms: String(v.beds || 2) }); if (d.units === 1 && d.sqft) qs.set('squareFootage', d.sqft); S.rc[key] = await api('/api/rentcast?' + qs); st.textContent = ''; }
      catch (er) { S.rc[key] = { error: er.message }; st.textContent = ''; } b.disabled = false; save(); }
    run('rentcheck'); }
  else if (a === 'pipe-add') { const name = String((S.v.pipeline || {}).add || '').trim(); if (!name) { toast('Type a name or address first.'); return; } const d = normDeal({ address: name }, ''); _saveDeal(d); S.deals[0].stage = 'Found'; S.deals[0].source = 'Manual'; S.v.pipeline.add = ''; save(); build('pipeline'); dealsChanged(); }
  else if (a === 'loi-print') printDoc('Letter of Intent', S.loiHtml || '');
  else if (a === 'loi-copy') { const t = document.createElement('div'); t.innerHTML = (S.loiHtml || '').replace(/<\/p>/g, '\n\n').replace(/<br>/g, '\n'); try { await navigator.clipboard.writeText(t.textContent.trim()); b.textContent = 'Copied'; } catch (er) { toast('Copy failed; use Print instead.'); } }
  else if (a === 'lender-print') printDoc('Lender summary', S.lenderHtml || '');
});
document.addEventListener('change', e => {
  const el = e.target; if (VIEWER()) return;
  if (el.dataset.dfCmp) { S.cmp = S.cmp.filter(id => id !== el.dataset.dfCmp); if (el.checked) S.cmp.push(el.dataset.dfCmp); save(); run('compare'); }
  else if (el.dataset.dfDeal) { const x = dealById(el.dataset.dfDeal); if (!x) return; x[el.dataset.f] = el.value; save(); if (el.dataset.f === 'stage') { run('pipeline'); if (typeof renderDeals === 'function') renderDeals(); } }
  else if (el.dataset.dfLead) { const l = S.leads[+el.dataset.dfLead]; if (l) { l[el.dataset.f] = el.value; save(); } }
  else if (el.dataset.dfFile === 'leads' && el.files && el.files[0]) { const f = el.files[0]; if (f.size > 8e6) { toast('That file is over 8 MB. Split it into smaller files.'); return; } f.text().then(importLeads); el.value = ''; }
});
document.addEventListener('input', e => { const el = e.target; if (VIEWER()) return; if (el.dataset.dfDeal && el.dataset.f === 'notes') { const x = dealById(el.dataset.dfDeal); if (x) { x.notes = el.value.slice(0, 2000); save(); } } });

/* ---------- styles ---------- */
const css = document.createElement('style');
css.textContent = `#dfToast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);z-index:50;max-width:min(560px,92vw);background:var(--nav);color:var(--nav-ink);border:1px solid var(--nav-2);border-radius:10px;padding:12px 16px;font-size:14px;box-shadow:0 8px 30px rgba(0,0,0,.3);word-break:break-word}#dfToast a{color:#fff}
.pboard{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px;align-items:start}.pcol{background:var(--surface-2);border:1px solid var(--line);border-radius:10px;padding:10px;min-width:0}.pcol h3{margin:2px 2px 8px}
.pcard{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px;font-size:13.5px}.pcard textarea{width:100%;margin:6px 0;font:13px "Public Sans",sans-serif;border:1px solid var(--line);border-radius:6px;padding:6px;background:var(--surface-2);color:var(--ink);resize:vertical}
.pcard .pl{display:flex;gap:6px;align-items:center;font-size:12px;color:var(--ink-3)}.pcard input[type=date]{font:13px "Public Sans",sans-serif;border:1px solid var(--line);border-radius:6px;padding:3px 6px;background:var(--surface-2);color:var(--ink)}
.pbtns{display:flex;gap:4px;flex-wrap:wrap;align-items:center}.pbtns .btn{margin:0;padding:4px 8px}.pbtns select{font:13px "Public Sans",sans-serif;border:1px solid var(--line);border-radius:6px;padding:4px;background:var(--surface-2);color:var(--ink);max-width:130px}
.paper{background:#fff;color:#111;border:1px solid var(--line);border-radius:6px;padding:22px 26px;font:14px/1.6 Georgia,serif;max-height:640px;overflow:auto}.paper h1{font:700 20px Arial,sans-serif;margin:0 0 4px;color:#111}.paper h2{font:700 12px Arial,sans-serif;text-transform:uppercase;letter-spacing:.06em;margin:18px 0 6px;color:#333}.paper table{border-collapse:collapse;width:100%;font:13px Arial,sans-serif}.paper td{border-bottom:1px solid #e5e5e5;padding:5px 3px}.paper td:last-child{text-align:right}.paper .muted{color:#666;font-size:12px}.paper p{margin:0 0 10px}
#t-leads select,#t-leads .wtxt{font:13px "Public Sans",sans-serif;border:1px solid var(--line);border-radius:6px;padding:4px;background:var(--surface-2);color:var(--ink)}`;
document.head.appendChild(css);

/* ---------- navigation order ---------- */
ORDER.splice(0, ORDER.length, 'box', 'inbox', 'leads', 'heat', 'five', 'screen', 'cashflow', 'caprate', 'fiveyr', 'reno', 'seller', 'maxoffer', 'flags', 'hood', 'markets', 'rent', 'rentcheck', 'pipeline', 'compare', 'dd', 'creative', 'x1031', 'loi', 'lender', 'split', 'portfolio', 'taxded', 'costseg');

/* ---------- cloud sync: saved deals, pipeline, leads and settings follow the member ---------- */
const SYNC = { on: false, t: 0, busy: false };
function syncStatus(txt) { document.querySelectorAll('[data-sync]').forEach(el => { el.textContent = txt; }); }
async function push() {
  if (!SYNC.on || SYNC.busy) return; SYNC.busy = true; syncStatus('Saving…');
  try { await api('/api/state', { state: S, updatedAt: S.updatedAt || Date.now() }, 'PUT'); syncStatus('Saved to your account'); }
  catch (e) { syncStatus('Not synced: ' + e.message); } finally { SYNC.busy = false; }
}
const _save = save;
save = function () { S.updatedAt = Date.now(); _save(); if (SYNC.on) { clearTimeout(SYNC.t); SYNC.t = setTimeout(push, 2500); } };
window.NM_SYNC_START = async function () {
  if (VIEWER()) return;
  document.querySelectorAll('.acct').forEach(a => { if (!a.querySelector('[data-sync]')) { const s = document.createElement('span'); s.dataset.sync = ''; s.style.cssText = 'font-size:11px;color:var(--nav-ink-2);flex-basis:100%'; a.style.flexWrap = 'wrap'; a.appendChild(s); } });
  try {
    const j = await api('/api/state');
    const local = S.updatedAt || 0, hasLocal = (S.deals && S.deals.length) || Object.keys(S.v || {}).length;
    if (j.state && j.updatedAt > local) {
      if (sessionStorage.getItem('nm.synced') === String(j.updatedAt)) { SYNC.on = true; syncStatus('Saved to your account'); return; }
      Object.keys(S).forEach(k => delete S[k]); Object.assign(S, j.state); try { localStorage.setItem('uwdesk.v1', JSON.stringify(S)); } catch (er) {} sessionStorage.setItem('nm.synced', String(j.updatedAt)); location.reload(); return;
    }
    SYNC.on = true;
    if (hasLocal && local >= (j.updatedAt || 0)) { if (!S.updatedAt) S.updatedAt = Date.now(); push(); } else syncStatus('Saved to your account');
  } catch (e) { syncStatus(''); }
};
})();
