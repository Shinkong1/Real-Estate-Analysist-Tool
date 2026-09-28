// Shared by the landing, sign-in and account pages: theme button + small API helper.
(function () {
  var K = 'uwdesk.theme', root = document.documentElement, mq = matchMedia('(prefers-color-scheme: dark)');
  var ICON = {
    auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>',
    light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>'
  };
  var NEXT = { auto: 'light', light: 'dark', dark: 'auto' }, NAME = { auto: 'Auto', light: 'Light', dark: 'Dark' };
  function get() { try { var v = localStorage.getItem(K); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; } }
  function apply(m) {
    if (m === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', m);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', (m === 'dark' || (m === 'auto' && mq.matches)) ? '#0B0E14' : '#1C2230');
    document.querySelectorAll('[data-theme-btn]').forEach(function (b) {
      b.innerHTML = ICON[m]; b.setAttribute('aria-label', 'Theme: ' + NAME[m] + '. Switch to ' + NAME[NEXT[m]]); b.title = 'Theme: ' + NAME[m];
    });
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-theme-btn]'); if (!b) return;
    var m = NEXT[get()]; try { if (m === 'auto') localStorage.removeItem(K); else localStorage.setItem(K, m); } catch (x) {} apply(m);
  });
  if (mq.addEventListener) mq.addEventListener('change', function () { apply(get()); });
  document.addEventListener('DOMContentLoaded', function () { apply(get()); });
  apply(get());

  window.UW = {
    api: function (path, body) {
      return fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j._status = r.status; return j; }); })
        .catch(function () { return { error: 'Couldn’t reach the server. Check your connection.', _status: 0 }; });
    },
    logout: function () { return UW.api('/api/logout', {}).then(function () { location.href = '/'; }); },
    esc: function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); },
    date: function (ms) { return ms ? new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'; }
  };
})();
