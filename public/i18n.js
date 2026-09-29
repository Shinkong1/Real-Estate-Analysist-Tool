/* Napkin Math — language and currency.
   Currency: sets window.UWC before the app renders, so every money figure uses the chosen currency.
   Language: interface text is translated on the page (cached in the browser and on the server).
   Anything marked data-noi18n, and everything people type, is never sent or changed. */
(function () {
  'use strict';
  var LANGS = [['en', 'English'], ['es', 'Español'], ['fr', 'Français'], ['pt', 'Português'], ['de', 'Deutsch'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['ru', 'Русский'], ['ar', 'العربية'], ['hi', 'हिन्दी'], ['zh', '中文'], ['ja', '日本語'], ['ko', '한국어'], ['vi', 'Tiếng Việt'], ['tl', 'Filipino']];
  var CURS = [['USD', '$', 'en-US'], ['CAD', 'CA$', 'en-CA'], ['MXN', 'MX$', 'es-MX'], ['GBP', '£', 'en-GB'], ['EUR', '€', 'de-DE'], ['AUD', 'A$', 'en-AU'], ['NZD', 'NZ$', 'en-NZ'], ['JPY', '¥', 'ja-JP'], ['CNY', 'CN¥', 'zh-CN'], ['INR', '₹', 'en-IN'], ['PHP', '₱', 'en-PH'], ['NGN', '₦', 'en-NG'], ['ZAR', 'R', 'en-ZA'], ['BRL', 'R$', 'pt-BR'], ['AED', 'AED ', 'en-AE'], ['KRW', '₩', 'ko-KR'], ['CHF', 'CHF ', 'de-CH'], ['SGD', 'S$', 'en-SG']];
  function get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  var nav = (navigator.language || 'en-US');
  var guessLang = (LANGS.find(function (l) { return nav.toLowerCase().indexOf(l[0]) === 0; }) || ['en'])[0];
  var region = (nav.split('-')[1] || '').toUpperCase();
  var guessCur = { CA: 'CAD', MX: 'MXN', GB: 'GBP', AU: 'AUD', NZ: 'NZD', JP: 'JPY', CN: 'CNY', IN: 'INR', PH: 'PHP', NG: 'NGN', ZA: 'ZAR', BR: 'BRL', AE: 'AED', KR: 'KRW', CH: 'CHF', SG: 'SGD', DE: 'EUR', FR: 'EUR', ES: 'EUR', IT: 'EUR', NL: 'EUR', IE: 'EUR', PT: 'EUR', AT: 'EUR', BE: 'EUR', FI: 'EUR' }[region] || 'USD';
  var lang = get('uwdesk.lang', 'en');           // English stays the default unless someone picks another language
  var cur = get('uwdesk.cur', guessCur);
  var C = CURS.find(function (c) { return c[0] === cur; }) || CURS[0];
  window.UWC = { code: C[0], sym: C[1], locale: C[2] };
  window.UWL = lang;
  var root = document.documentElement;
  if (lang !== 'en') { root.setAttribute('lang', lang); if (lang === 'ar') root.setAttribute('dir', 'rtl'); }

  /* ---------- picker ---------- */
  var GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true" style="width:17px;height:17px"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
  function picker() {
    var w = document.createElement('div'); w.className = 'i18n'; w.setAttribute('data-noi18n', '');
    w.innerHTML = '<button type="button" class="i18n-btn" aria-expanded="false" aria-haspopup="true" aria-label="Language and currency">' + GLOBE + '<span>' + lang.toUpperCase() + ' · ' + C[0] + '</span></button>'
      + '<div class="i18n-pop" hidden><label>Language<select data-i18n-lang>' + LANGS.map(function (l) { return '<option value="' + l[0] + '"' + (l[0] === lang ? ' selected' : '') + '>' + l[1] + '</option>'; }).join('') + '</select></label>'
      + '<label>Currency<select data-i18n-cur>' + CURS.map(function (c) { return '<option value="' + c[0] + '"' + (c[0] === C[0] ? ' selected' : '') + '>' + c[0] + ' (' + c[1].trim() + ')</option>'; }).join('') + '</select></label>'
      + '<p>Enter prices and rents in your currency. Plans are billed in U.S. dollars. Tax tools (depreciation, 1031, cost segregation) follow U.S. rules. Translations are automatic.</p></div>';
    var b = w.querySelector('.i18n-btn'), pop = w.querySelector('.i18n-pop');
    b.addEventListener('click', function (e) { e.stopPropagation(); pop.hidden = !pop.hidden; b.setAttribute('aria-expanded', String(!pop.hidden)); });
    document.addEventListener('click', function (e) { if (!w.contains(e.target)) { pop.hidden = true; b.setAttribute('aria-expanded', 'false'); } });
    w.querySelector('[data-i18n-lang]').addEventListener('change', function (e) { set('uwdesk.lang', e.target.value); location.reload(); });
    w.querySelector('[data-i18n-cur]').addEventListener('change', function (e) { set('uwdesk.cur', e.target.value); location.reload(); });
    return w;
  }
  function mount() {
    var spots = document.querySelectorAll('[data-theme-btn], .acct, .macct');
    spots.forEach(function (s) {
      var host = s.classList && (s.classList.contains('acct') || s.classList.contains('macct')) ? s : s.parentNode;
      if (host.querySelector(':scope > .i18n')) return;
      var p = picker();
      if (s.hasAttribute && s.hasAttribute('data-theme-btn')) host.insertBefore(p, s); else host.appendChild(p);
    });
    var st = document.createElement('style');
    st.textContent = '.i18n{position:relative;display:inline-flex}.i18n-btn{display:inline-flex;align-items:center;gap:5px;background:none;border:0;color:inherit;opacity:.85;cursor:pointer;font:600 12.5px "Public Sans",sans-serif;padding:6px;border-radius:6px}.i18n-btn:hover{opacity:1}'
      + '.i18n-pop{position:absolute;right:0;top:calc(100% + 6px);z-index:60;width:250px;background:var(--surface);color:var(--ink);border:1px solid var(--line);border-radius:10px;padding:12px;box-shadow:0 10px 30px rgba(0,0,0,.25);display:flex;flex-direction:column;gap:10px;text-align:left}'
      + '[dir=rtl] .i18n-pop{right:auto;left:0}.i18n-pop label{display:flex;flex-direction:column;gap:4px;font:600 12.5px "Public Sans",sans-serif}.i18n-pop select{font:14px "Public Sans",sans-serif;padding:7px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);color:var(--ink)}.i18n-pop p{margin:0;font-size:11.5px;line-height:1.45;color:var(--ink-3);font-weight:400}'
      + '.acct .i18n-pop{left:0;right:auto}';
    document.head.appendChild(st);
  }

  /* ---------- translation ---------- */
  if (lang === 'en') { document.addEventListener('DOMContentLoaded', mount); return; }
  var KEY = 'uwdesk.tr.' + lang, cache = {};
  try { cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { cache = {}; }
  var SKIP = /^(SCRIPT|STYLE|NOSCRIPT|CODE|PRE|TEXTAREA|INPUT|SVG)$/;
  var LETTERS = /[A-Za-z]{2,}/, NOT_UI = /https?:\/\/|www\.|@[a-z]|\.(com|net|org|io)\b|^\s*[\d$€£¥₹%.,:\/\-–—+()x ]+\s*$/i;
  var ADDRESS = /\b\d{1,6}\s+[A-Za-z0-9.' -]{2,40}\b(st|street|ave|avenue|rd|road|dr|drive|ln|lane|blvd|ct|court|way|pl|place|pkwy|hwy|cir|ter)\b\.?/i;
  var state = new WeakMap(), queue = new Map(), timer = 0, saving = 0;
  function skipEl(el) { for (var e = el; e && e !== document.body; e = e.parentElement) { if (SKIP.test(e.tagName) || (e.tagName === 'OPTION' && !e.hasAttribute('value')) || (e.hasAttribute && (e.hasAttribute('data-noi18n') || e.classList.contains('mk') || e.classList.contains('ad-mk')))) return true; if (e.tagName === 'SELECT' && /deal/.test(e.getAttribute('data-k') || '')) return true; } return false; }
  function wanted(s) { var t = s.trim(); return t.length > 1 && t.length < 600 && LETTERS.test(t) && !NOT_UI.test(t) && !ADDRESS.test(t); }
  function need(t) { if (!(t in cache) && !queue.has(t)) { queue.set(t, 1); clearTimeout(timer); timer = setTimeout(flush, 120); } }
  function applyText(node) {
    var cur = node.nodeValue, st = state.get(node);
    if (st && cur === st.tr) return;                      // already translated by us
    var src = cur, t = src.trim(); if (!wanted(t)) return;
    var tr = cache[t];
    if (tr) { var lead = src.match(/^\s*/)[0], tail = src.match(/\s*$/)[0]; var out = lead + tr + tail; state.set(node, { src: src, tr: out }); if (node.nodeValue !== out) node.nodeValue = out; }
    else if (tr === undefined) need(t);
  }
  var ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
  function applyAttrs(el) {
    ATTRS.forEach(function (a) {
      var v = el.getAttribute(a); if (!v) return; var mark = 'data-i18n-' + a;
      if (el.getAttribute(mark) === v) return;
      var t = v.trim(); if (!wanted(t)) return;
      var tr = cache[t]; if (tr) { el.setAttribute(a, tr); el.setAttribute(mark, tr); } else if (tr === undefined) need(t);
    });
  }
  function walk(rootEl) {
    if (!rootEl) return;
    if (rootEl.nodeType === 3) { if (!skipEl(rootEl.parentElement)) applyText(rootEl); return; }
    if (rootEl.nodeType !== 1 || skipEl(rootEl)) { if (rootEl.nodeType === 1 && (rootEl.tagName === 'INPUT' || rootEl.tagName === 'TEXTAREA') && !rootEl.closest('[data-noi18n]')) applyAttrs(rootEl); return; }
    applyAttrs(rootEl);
    var it = document.createTreeWalker(rootEl, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, null), n;
    while ((n = it.nextNode())) {
      if (n.nodeType === 3) { if (!skipEl(n.parentElement)) applyText(n); }
      else if (!skipEl(n) || n.tagName === 'INPUT' || n.tagName === 'TEXTAREA') { if (!n.closest('[data-noi18n]')) applyAttrs(n); }
    }
  }
  function persist() { clearTimeout(saving); saving = setTimeout(function () { try { var keys = Object.keys(cache); if (keys.length > 4000) keys.slice(0, keys.length - 4000).forEach(function (k) { delete cache[k]; }); localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) {} }, 800); }
  var inflight = 0;
  function flush() {
    if (!queue.size || inflight > 2) { if (queue.size) timer = setTimeout(flush, 300); return; }
    var batch = Array.from(queue.keys()).slice(0, 40); batch.forEach(function (t) { queue.delete(t); });
    inflight++;
    fetch('/api/translate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lang: lang, texts: batch }) })
      .then(function (r) { return r.json(); })
      .then(function (j) { (j.translations || []).forEach(function (tr, i) { cache[batch[i]] = (typeof tr === 'string' && tr.trim()) ? tr : null; }); persist(); walk(document.body); })
      .catch(function () { batch.forEach(function (t) { cache[t] = null; }); })
      .then(function () { inflight--; if (queue.size) flush(); });
    if (queue.size) setTimeout(flush, 50);
  }
  function start() {
    mount(); walk(document.body); if (document.title && wanted(document.title)) { var t0 = document.title.trim(); if (cache[t0]) document.title = cache[t0]; else need(t0); }
    new MutationObserver(function (muts) { muts.forEach(function (m) { if (m.type === 'characterData') { if (!skipEl(m.target.parentElement)) applyText(m.target); } else m.addedNodes.forEach(walk); }); })
      .observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(function () { var t0 = document.title.trim(); if (cache[t0]) document.title = cache[t0]; }, 2500);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
