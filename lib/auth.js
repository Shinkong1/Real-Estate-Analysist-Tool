// Underwriting Desk — accounts, sessions and Stripe billing (Cloudflare Worker + KV).
//
// Roles:  owner  — signs in with OWNER_EMAIL (or the word "owner") + OWNER_PASSWORD (falls back to APP_PASSCODE)
//         test   — temporary logins the owner creates from the Account page; expire after TEST_LOGIN_HOURS (72)
//         member — paying subscribers ($25/week or $100/month through Stripe Checkout)
//
// KV (binding USERS):  user:<email>  sess:<token>  cust:<stripe customer id>  rl:<ip>
// Secrets: OWNER_PASSWORD (or APP_PASSCODE), OWNER_EMAIL (optional), STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET
// Optional: STRIPE_PRICE_WEEKLY / STRIPE_PRICE_MONTHLY (use existing Stripe prices instead of inline ones)

const SESSION_DAYS = 30;
const COOKIE = 'uwd_s';
const enc = new TextEncoder();
export const PLANS = {
  week:  { label: 'Weekly',  amount: 2500,  interval: 'week',  price: '$25 / week' },
  month: { label: 'Monthly', amount: 10000, interval: 'month', price: '$100 / month' },
};

// ---------- small helpers ----------
const SEC_HEADERS = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY' };
export const json = (obj, status = 200, extra = {}) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...SEC_HEADERS, ...extra },
});
export const redirect = (to, extra = {}) => new Response(null, { status: 302, headers: { location: to, 'cache-control': 'no-store', ...extra } });
const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randToken = (n = 32) => b64u(crypto.getRandomValues(new Uint8Array(n)));
const normEmail = e => String(e || '').trim().toLowerCase();
const isEmail = e => /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(e);
const now = () => Date.now();

async function sha256(s) { return hex(await crypto.subtle.digest('SHA-256', enc.encode(s))); }
async function safeEqual(a, b) { // compare via hashes so timing doesn't leak length or prefix
  const [x, y] = await Promise.all([sha256(String(a)), sha256(String(b))]);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i); return d === 0;
}
async function hashPassword(pw, saltB64) {
  const salt = saltB64 ? Uint8Array.from(atob(saltB64), c => c.charCodeAt(0)) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100000 }, key, 256);
  return { salt: btoa(String.fromCharCode(...salt)), hash: hex(bits) };
}
function readCookie(req, name) {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? m[1] : '';
}
const sessionCookie = (token, maxAge) =>
  `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

// ---------- users ----------
const getUser = (env, email) => env.USERS.get('user:' + email, 'json');
async function putUser(env, u) {
  const meta = { role: u.role, status: u.status, plan: u.plan || '', expiresAt: u.expiresAt || 0, periodEnd: u.periodEnd || 0, created: u.created };
  const opts = { metadata: meta };
  if (u.role === 'test' && u.expiresAt) opts.expiration = Math.floor(u.expiresAt / 1000) + 86400; // KV drops it a day after expiry
  await env.USERS.put('user:' + u.email, JSON.stringify(u), opts);
}
const ownerId = env => normEmail(env.OWNER_EMAIL) || 'owner';
const ownerPassword = env => env.OWNER_PASSWORD || env.APP_PASSCODE || '';

export function access(user) {
  if (!user) return { ok: false, why: 'signed_out' };
  if (user.role === 'owner') return { ok: true };
  if (user.role === 'test') return user.expiresAt > now() ? { ok: true } : { ok: false, why: 'test_expired' };
  if (['active', 'trialing', 'past_due'].includes(user.status)) return { ok: true };
  return { ok: false, why: user.status === 'pending' ? 'unpaid' : 'inactive' };
}

async function newSession(env, email, role) {
  const token = randToken();
  await env.USERS.put('sess:' + token, JSON.stringify({ email, role, created: now() }), { expirationTtl: SESSION_DAYS * 86400 });
  return sessionCookie(token, SESSION_DAYS * 86400);
}

// Returns the signed-in user record (owner gets a synthetic one) or null.
export async function currentUser(req, env) {
  if (!env.USERS) return null;
  const token = readCookie(req, COOKIE);
  if (!token || token.length > 80) return null;
  const s = await env.USERS.get('sess:' + token, 'json');
  if (!s) return null;
  if (s.role === 'owner') return s.email === ownerId(env) && ownerPassword(env) ? { email: s.email, role: 'owner', status: 'active' } : null;
  return getUser(env, s.email);
}

// Simple brute-force brake: 10 failed sign-ins per IP per 15 minutes.
async function rateLimited(env, req) {
  const ip = req.headers.get('cf-connecting-ip') || 'x';
  const n = parseInt(await env.USERS.get('rl:' + ip) || '0', 10);
  return { blocked: n >= 10, bump: () => env.USERS.put('rl:' + ip, String(n + 1), { expirationTtl: 900 }) };
}

// ---------- Stripe ----------
const stripeReady = env => !!(env.STRIPE_SECRET_KEY);
function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === 'object') form(v, key, out); else out.append(key, String(v));
  }
  return out;
}
async function stripe(env, method, path, params) {
  const r = await fetch('https://api.stripe.com/v1/' + path + (method === 'GET' && params ? '?' + form(params) : ''), {
    method,
    headers: { authorization: 'Bearer ' + env.STRIPE_SECRET_KEY, 'content-type': 'application/x-www-form-urlencoded' },
    body: method === 'GET' ? undefined : form(params || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'Stripe error ' + r.status);
  return j;
}
async function checkoutUrl(env, origin, user, plan) {
  const p = PLANS[plan];
  const priceId = plan === 'week' ? env.STRIPE_PRICE_WEEKLY : env.STRIPE_PRICE_MONTHLY;
  const item = priceId ? { price: priceId, quantity: 1 } : {
    quantity: 1,
    price_data: { currency: 'usd', unit_amount: p.amount, recurring: { interval: p.interval },
      product_data: { name: `Underwriting Desk — ${p.label}` } },
  };
  const params = {
    mode: 'subscription',
    line_items: { 0: item },
    client_reference_id: user.email,
    metadata: { email: user.email, plan },
    subscription_data: { metadata: { email: user.email, plan } },
    allow_promotion_codes: 'true',
    success_url: `${origin}/api/checkout/return?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/login?mode=signup&canceled=1&plan=${plan}`,
  };
  if (user.stripeCustomer) params.customer = user.stripeCustomer; else params.customer_email = user.email;
  const s = await stripe(env, 'POST', 'checkout/sessions', params);
  return s.url;
}
async function applySubscription(env, email, sub, plan) {
  const user = await getUser(env, email);
  if (!user || user.role !== 'member') return null;
  user.status = sub.status;
  user.stripeSub = sub.id;
  user.stripeCustomer = typeof sub.customer === 'string' ? sub.customer : (sub.customer && sub.customer.id) || user.stripeCustomer;
  const end = sub.current_period_end || (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  if (end) user.periodEnd = end * 1000;
  const interval = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].price && sub.items.data[0].price.recurring && sub.items.data[0].price.recurring.interval;
  user.plan = plan || (interval === 'week' ? 'week' : interval === 'month' ? 'month' : user.plan);
  user.cancelAtPeriodEnd = !!sub.cancel_at_period_end;
  await putUser(env, user);
  if (user.stripeCustomer) await env.USERS.put('cust:' + user.stripeCustomer, email);
  return user;
}
async function verifyStripeSignature(env, raw, header) {
  const parts = Object.fromEntries((header || '').split(',').map(kv => kv.split('=')).filter(p => p.length === 2).map(([k, v]) => [k.trim(), v]));
  const sigs = (header || '').split(',').filter(x => x.trim().startsWith('v1=')).map(x => x.trim().slice(3));
  const t = parts.t;
  if (!t || !sigs.length || Math.abs(now() / 1000 - Number(t)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(env.STRIPE_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = hex(await crypto.subtle.sign('HMAC', key, enc.encode(`${t}.${raw}`)));
  for (const s of sigs) if (await safeEqual(s, expected)) return true;
  return false;
}

// ---------- request handler for /api/* auth routes ----------
// Returns a Response, or null if the path isn't an auth/billing route.
export async function handleAuthApi(req, env, url) {
  const p = url.pathname, m = req.method, origin = url.origin;
  if (!p.startsWith('/api/')) return null;
  if (!env.USERS) return json({ error: 'Accounts are not set up yet (missing USERS storage).' }, 503);

  // Stripe webhook: raw body + signature, no cookie
  if (p === '/api/stripe-webhook' && m === 'POST') {
    if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: 'Webhook secret not set.' }, 503);
    const raw = await req.text();
    if (!(await verifyStripeSignature(env, raw, req.headers.get('stripe-signature')))) return json({ error: 'Bad signature.' }, 400);
    const evt = JSON.parse(raw), o = evt.data && evt.data.object || {};
    try {
      if (evt.type === 'checkout.session.completed' && o.mode === 'subscription') {
        const email = normEmail(o.client_reference_id || (o.metadata && o.metadata.email));
        const sub = await stripe(env, 'GET', 'subscriptions/' + o.subscription);
        await applySubscription(env, email, sub, o.metadata && o.metadata.plan);
      } else if (evt.type.startsWith('customer.subscription.')) {
        const email = normEmail((o.metadata && o.metadata.email) || await env.USERS.get('cust:' + o.customer));
        if (email) await applySubscription(env, email, o);
      }
    } catch (e) { return json({ error: e.message }, 500); } // Stripe retries on non-2xx
    return json({ received: true });
  }

  // Stripe sends the buyer back here after paying
  if (p === '/api/checkout/return' && m === 'GET') {
    const id = url.searchParams.get('session_id') || '';
    if (!stripeReady(env) || !/^cs_[A-Za-z0-9_]+$/.test(id)) return redirect('/login');
    try {
      const s = await stripe(env, 'GET', 'checkout/sessions/' + id, { expand: { 0: 'subscription' } });
      const email = normEmail(s.client_reference_id);
      if (s.status === 'complete' && s.subscription && email) {
        const user = await applySubscription(env, email, s.subscription, s.metadata && s.metadata.plan);
        if (user && access(user).ok) return redirect('/app/#import', { 'set-cookie': await newSession(env, email, 'member') });
      }
    } catch (e) { /* fall through */ }
    return redirect('/account?pending=1');
  }

  // Everything below takes JSON (also blocks cross-site form posts)
  const isJson = (req.headers.get('content-type') || '').includes('application/json');
  const body = m === 'POST' ? (isJson ? await req.json().catch(() => ({})) : null) : {};
  if (m === 'POST' && !body) return json({ error: 'Send JSON.' }, 415);

  if (p === '/api/login' && m === 'POST') {
    const rl = await rateLimited(env, req);
    if (rl.blocked) return json({ error: 'Too many attempts. Wait 15 minutes and try again.' }, 429);
    const id = normEmail(body.email), pw = String(body.password || '');
    if (!id || !pw) return json({ error: 'Enter your email and password.' }, 400);
    if (id === ownerId(env) && ownerPassword(env)) {
      if (await safeEqual(pw, ownerPassword(env))) return json({ ok: true, to: '/app/' }, 200, { 'set-cookie': await newSession(env, id, 'owner') });
      await rl.bump(); return json({ error: 'That email and password don’t match.' }, 401);
    }
    const user = await getUser(env, id);
    const ok = user && (await hashPassword(pw, user.salt)).hash === user.hash;
    if (!ok) { await rl.bump(); return json({ error: 'That email and password don’t match.' }, 401); }
    const a = access(user);
    if (user.role === 'test' && !a.ok) return json({ error: 'This test login has expired.' }, 403);
    return json({ ok: true, to: a.ok ? '/app/' : '/account' }, 200, { 'set-cookie': await newSession(env, id, user.role) });
  }

  if (p === '/api/logout' && m === 'POST') {
    const token = readCookie(req, COOKIE);
    if (token) await env.USERS.delete('sess:' + token);
    return json({ ok: true }, 200, { 'set-cookie': sessionCookie('', 0) });
  }

  if (p === '/api/signup' && m === 'POST') {
    const email = normEmail(body.email), pw = String(body.password || ''), plan = body.plan === 'week' ? 'week' : body.plan === 'month' ? 'month' : '';
    if (!isEmail(email)) return json({ error: 'Enter a valid email address.' }, 400);
    if (pw.length < 8) return json({ error: 'Use a password of at least 8 characters.' }, 400);
    if (!plan) return json({ error: 'Choose weekly or monthly.' }, 400);
    if (email === ownerId(env)) return json({ error: 'That email is already registered. Sign in instead.' }, 409);
    if (!stripeReady(env)) return json({ error: 'Sign-ups open soon — payments aren’t switched on yet.' }, 503);
    let user = await getUser(env, email);
    if (user && (user.role !== 'member' || user.status !== 'pending' || (await hashPassword(pw, user.salt)).hash !== user.hash))
      return json({ error: 'That email is already registered. Sign in instead.' }, 409);
    if (!user) {
      const h = await hashPassword(pw);
      user = { email, role: 'member', status: 'pending', plan, salt: h.salt, hash: h.hash, created: now() };
      await putUser(env, user);
    }
    try {
      const to = await checkoutUrl(env, origin, user, plan);
      return json({ ok: true, to }, 200, { 'set-cookie': await newSession(env, email, 'member') });
    } catch (e) { return json({ error: 'Couldn’t start checkout: ' + e.message }, 502); }
  }

  // ----- signed-in routes -----
  const me = await currentUser(req, env);

  if (p === '/api/me' && m === 'GET') {
    if (!me) return json({ signedIn: false, stripeReady: stripeReady(env), plans: PLANS });
    const a = access(me);
    return json({ signedIn: true, email: me.email, role: me.role, status: me.status, plan: me.plan || '',
      expiresAt: me.expiresAt || 0, periodEnd: me.periodEnd || 0, cancelAtPeriodEnd: !!me.cancelAtPeriodEnd,
      access: a.ok, why: a.why || '', stripeReady: stripeReady(env), hasBilling: !!me.stripeCustomer, plans: PLANS });
  }
  if (!me) return json({ error: 'Sign in first.' }, 401);

  if (p === '/api/checkout' && m === 'POST') {
    if (me.role !== 'member') return json({ error: 'This login doesn’t need a plan.' }, 400);
    if (!stripeReady(env)) return json({ error: 'Payments aren’t switched on yet.' }, 503);
    const plan = body.plan === 'week' ? 'week' : 'month';
    try { return json({ ok: true, to: await checkoutUrl(env, origin, me, plan) }); }
    catch (e) { return json({ error: 'Couldn’t start checkout: ' + e.message }, 502); }
  }

  if (p === '/api/portal' && m === 'POST') {
    if (!me.stripeCustomer || !stripeReady(env)) return json({ error: 'No billing account yet.' }, 400);
    try {
      const s = await stripe(env, 'POST', 'billing_portal/sessions', { customer: me.stripeCustomer, return_url: origin + '/account' });
      return json({ ok: true, to: s.url });
    } catch (e) { return json({ error: 'Couldn’t open billing: ' + e.message }, 502); }
  }

  // ----- owner only -----
  if (p.startsWith('/api/admin/')) {
    if (me.role !== 'owner') return json({ error: 'Owner only.' }, 403);
    if (p === '/api/admin/users' && m === 'GET') {
      const out = []; let cursor;
      do {
        const page = await env.USERS.list({ prefix: 'user:', cursor });
        for (const k of page.keys) out.push({ email: k.name.slice(5), ...(k.metadata || {}) });
        cursor = page.list_complete ? null : page.cursor;
      } while (cursor && out.length < 2000);
      out.sort((a, b) => (b.created || 0) - (a.created || 0));
      return json({ users: out });
    }
    if (p === '/api/admin/test-login' && m === 'POST') {
      const hours = Math.min(Math.max(parseInt(env.TEST_LOGIN_HOURS || '72', 10) || 72, 1), 24 * 30);
      const email = 'test-' + randToken(4).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) + '@uwdesk.test';
      const password = randToken(9).replace(/[-_]/g, 'x');
      const h = await hashPassword(password);
      const u = { email, role: 'test', status: 'active', plan: 'test', salt: h.salt, hash: h.hash, created: now(),
        expiresAt: now() + hours * 3600 * 1000, note: String(body.note || '').slice(0, 80) };
      await putUser(env, u);
      return json({ ok: true, email, password, expiresAt: u.expiresAt });
    }
    if (p === '/api/admin/revoke' && m === 'POST') {
      const email = normEmail(body.email);
      const u = await getUser(env, email);
      if (!u || u.role !== 'test') return json({ error: 'Only test logins can be removed here.' }, 400);
      await env.USERS.delete('user:' + email);
      return json({ ok: true });
    }
  }
  return null;
}
