/* Napkin Math free calculators: each page lists its inputs and a compute() function. */
(function () {
  'use strict';
  var C = window.UWC || { code: 'USD', sym: '$', locale: 'en-US' };
  function money(x, d) { if (!isFinite(x)) return '—'; try { return new Intl.NumberFormat(C.locale, { style: 'currency', currency: C.code, maximumFractionDigits: d || 0 }).format(x); } catch (e) { return C.sym + Math.round(x).toLocaleString(); } }
  function pct(x, d) { return isFinite(x) ? (x * 100).toFixed(d == null ? 2 : d) + '%' : '—'; }
  function num(v) { var x = parseFloat(String(v).replace(/[^0-9.\-]/g, '')); return isFinite(x) ? x : NaN; }
  function pmt(rate, years, pv) { var r = rate / 12, n = years * 12; return !pv || !years ? 0 : r === 0 ? pv / n : pv * r / (1 - Math.pow(1 + r, -n)); }
  var form = document.getElementById('calc'), out = document.getElementById('out');
  if (!form || !window.CALC) return;
  form.querySelectorAll('[data-money]').forEach(function (el) { el.textContent = C.sym.trim(); });
  function val(id) { var el = document.getElementById(id); return el ? num(el.value) : NaN; }
  function go() { try { out.innerHTML = window.CALC({ v: val, money: money, pct: pct, pmt: pmt }); } catch (e) { out.innerHTML = '<p>Check the inputs.</p>'; } }
  form.addEventListener('input', go); form.addEventListener('submit', function (e) { e.preventDefault(); go(); }); go();
})();
