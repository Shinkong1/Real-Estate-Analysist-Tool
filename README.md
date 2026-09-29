# Napkin Math — installable app

Paste (or share) a listing link from your phone, the app reads the listing, and all 16
underwriting tools fill in. Works on iPhone, Android and desktop. The calculators also
work offline; importing a listing needs a connection.

## What's in this folder
| File | What it does |
|---|---|
| `public/` | Home page (`index.html`), `login.html`, `account.html`, the app in `app/index.html`, manifest, service worker, icons |
| `worker.js`, `lib/auth.js` | Cloudflare Worker: routing, accounts, sessions, Stripe billing |
| `api/extract.js` | Vercel adapter for the link reader |
| `lib/extract-core.js` | The link reader (shared by every host) |
| `functions/api/extract.js` | Cloudflare Pages adapter |
| `server.js` | Optional: run it on your own computer or any Node host |
| `wrangler.toml` | Cloudflare Worker settings (assets, `USERS` KV, free AI binding) |
| `vercel.json`, `public/_headers` | Security and caching headers |

## Site layout
| Address | What it is |
|---|---|
| `/` | Public home page with features and pricing |
| `/login` | Sign in and create an account (`/login?mode=signup&plan=week` or `plan=month`) |
| `/app/` | The Napkin Math app — only for the owner, a live test login, or a paying member |
| `/account` | Plan, billing and sign-out; the owner also gets test-login controls and the account list |

## Accounts and payments (Cloudflare Worker)
The site runs as the Cloudflare Worker `reat`; every `git push` to `main` redeploys it.
Accounts live in a Workers KV namespace bound as `USERS`, which Wrangler creates on the first deploy.

**Who can sign in**
- **Owner** — username `OwnerNamastay` (not case-sensitive; or the email in `OWNER_EMAIL` if set) with the password in `OWNER_PASSWORD`.
  If `OWNER_PASSWORD` isn't set, the existing `APP_PASSCODE` is the owner password.
- **Test logins** — the owner creates these from **Account → Create a 3-day test login**. Each one
  gets a random username and password (shown once) and stops working after 72 hours
  (`TEST_LOGIN_HOURS` changes that). Test logins are view-only: every tool and the example figures are visible,
  but inputs, saving deals and listing import are turned off. The owner can remove one early.
- **Public demo** — username `AssignedTester5`, password `subscribeforaccess5`, shown on the home page.
  View-only like test logins; each sign-in lasts 3 days. Every tester visit starts fresh from the
  example numbers — deals saved in that browser by other accounts are hidden from testers and left untouched. Set `DEMO_LOGIN=off` in Cloudflare to switch it off.
- **Members** — sign up at `/login`, pay $30/week or $100/month through Stripe Checkout, and can
  manage or cancel from **Account → Manage billing**. Access continues while Stripe reports the
  subscription as active, trialing or past due.

**Turn on payments (Stripe)**
1. In Stripe → Developers → API keys, copy the **Secret key**.
2. Stripe → Developers → Webhooks → **Add endpoint**: `https://<your worker address>/api/stripe-webhook`,
   events `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`. Copy the **Signing secret**.
3. Cloudflare → Workers & Pages → `reat` → Settings → Variables and Secrets → add as *Secret*:
   `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`.
4. Stripe → Settings → Billing → **Customer portal**: turn it on so members can cancel or change cards.

Prices are created inline at checkout. To use prices you've made in Stripe instead, add
`STRIPE_PRICE_WEEKLY` and `STRIPE_PRICE_MONTHLY` (price IDs). Use test-mode keys first to try it
with Stripe's test card `4242 4242 4242 4242`.

**Listing reader secrets** (unchanged): `CF_ACCOUNT_ID` and `CF_API_TOKEN` (Browser Rendering → Edit,
Workers AI → Read) turn on the headless browser. Imports now require a signed-in account with
access instead of the passcode.

**Free-plan limits:** headless browser 10 minutes/day (a listing takes ~5–15 s, so roughly
40–100 rendered pages a day) and one browser request every 10 seconds; Workers AI 10,000
neurons/day (a listing uses roughly 300–1,000, so about 10–30 AI reads a day). When a limit is hit
the app falls back to pattern matching and tells you.

### Better accuracy (optional, paid per use)
Add `ANTHROPIC_API_KEY` (console.anthropic.com). Claude then does the reading instead of the free
model, can read screenshots more reliably, and can search the web for the listing when a site
blocks both readers. A few cents per listing.

### Other hosts
- **Vercel** (free Hobby plan is non-commercial): `npm i -g vercel && vercel`, add the same
  variables, `vercel --prod`. Output directory `public` is picked up automatically.
- **Any Node server / your computer:** `node server.js` (see below).

### How reading a link works
1. The server requests the page directly.
2. If that is blocked or the page needs JavaScript, it opens it in Cloudflare's headless Chrome.
   (Cloudflare identifies this browser as automated, so heavily protected sites such as Zillow or
   LoopNet may still refuse it.)
3. The page text, plus any screenshots you attached, goes to the AI, which returns the numbers.
4. You review everything before it fills the tools. A screenshot always works as a last resort.

## Install on your phone
- **iPhone (Safari):** open your app address → Share → **Add to Home Screen**.
  To import: copy the listing link in the Zillow/LoopNet/Crexi app or browser, open
  Napkin Math, paste it on the Import screen.
- **Android (Chrome):** open the address → menu → **Install app**. You can then use
  **Share → Napkin Math** straight from a listing and it starts reading automatically.
- Sign in once on each device; sessions last 30 days.

## Settings (environment variables)
| Name | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | One AI key recommended | Lets Claude read pages and screenshots |
| `GEMINI_API_KEY` | Alternative | Free-tier AI option; used only if no Anthropic key |
| `GEMINI_MODEL` | No | Defaults to `gemini-2.5-flash` |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | For Cloudflare features | Headless browser, and Workers AI outside Pages |
| `CF_AI_MODEL` | No | Defaults to `@cf/meta/llama-4-scout-17b-16e-instruct` |
| `USE_BROWSER` | No | Set to `0` to skip the headless browser |
| `OWNER_PASSWORD` / `APP_PASSCODE` | Yes | Owner password (the passcode is used if no owner password is set) |
| `OWNER_EMAIL` | No | Lets the owner sign in with an email instead of `OwnerNamastay` |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | For sign-ups | Stripe Checkout and subscription updates |
| `TEST_LOGIN_HOURS` | No | Test login lifetime, default 72 |
| `ANTHROPIC_MODEL` | No | Defaults to `claude-sonnet-5` |
| `SCRAPER_URL` | No | A scraping service for sites that block bots, e.g. `https://api.example.com/?key=KEY&url={url}` |
| `USE_WEB_TOOLS` | No | Set to `0` to stop Claude from using web fetch/search |

**Cost:** each import is one Claude API call, typically a few cents; more with screenshots or
when web search is needed.

## Run it on your own computer instead
```
ANTHROPIC_API_KEY=sk-ant-... APP_PASSCODE=yourpass node server.js
```
Open http://localhost:3000. To use it from your phone on the same Wi-Fi, open
`http://<your computer's IP>:3000` (installing to the home screen needs HTTPS, so use Cloudflare or Vercel for that).

## Notes
- Deals, inputs and checklists are saved on each device (browser storage), not on the server.
- Listing sites' terms of use vary; this reads one page when you ask it to, for your own analysis.
- Screening estimates only; verify tax, legal and lending items with your CPA, attorney and lender.
