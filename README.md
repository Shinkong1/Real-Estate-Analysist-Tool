# Underwriting Desk — installable app

Paste (or share) a listing link from your phone, the app reads the listing, and all 16
underwriting tools fill in. Works on iPhone, Android and desktop. The calculators also
work offline; importing a listing needs a connection.

## What's in this folder
| File | What it does |
|---|---|
| `public/` | The app itself: `index.html` (all 16 tools + Import), manifest, service worker, icons |
| `api/extract.js` | Vercel adapter for the link reader |
| `lib/extract-core.js` | The link reader (shared by every host) |
| `functions/api/extract.js` | Cloudflare Pages adapter |
| `server.js` | Optional: run it on your own computer or any Node host |
| `wrangler.toml` | Cloudflare Pages settings (output folder, free AI binding) |
| `vercel.json`, `public/_headers` | Security and caching headers |

## Put it online for free (GitHub → Cloudflare Pages)

Everything below runs on Cloudflare's free plan: hosting, a real headless browser for pages
that block simple readers, and a free AI model that reads the listing. No card needed.

1. **Put this folder in a GitHub repo** (e.g. `underwriting-desk`, private is fine).
2. **Create the Pages project:** Cloudflare dashboard → Workers & Pages → Create → Pages →
   Connect to Git → pick the repo. Framework preset: **None**. Build command: *(leave empty)*.
   Build output directory: **public**. Deploy. `wrangler.toml` already switches on the free
   Workers AI model (`AI` binding).
3. **Create an API token** (My Profile → API Tokens → Create Token → Custom) with:
   - Account → **Browser Rendering → Edit**  (headless browser, a.k.a. Browser Run)
   - Account → **Workers AI → Read**
4. **Add variables:** Pages project → Settings → Variables and Secrets (Production), as *Secret*:
   | Name | Value |
   |---|---|
   | `APP_PASSCODE` | any passphrase (keeps strangers from using your quota) |
   | `CF_ACCOUNT_ID` | your account ID (right sidebar of the dashboard home) |
   | `CF_API_TOKEN` | the token from step 3 |
   Then Deployments → Retry deployment so they take effect.
5. Open `https://<project>.pages.dev`. Every `git push` redeploys automatically.

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
  UW Desk, paste it on the Import screen.
- **Android (Chrome):** open the address → menu → **Install app**. You can then use
  **Share → UW Desk** straight from a listing and it starts reading automatically.
- The first time, open **App settings** on the Import screen and enter your passcode.

## Settings (environment variables)
| Name | Required | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | One AI key recommended | Lets Claude read pages and screenshots |
| `GEMINI_API_KEY` | Alternative | Free-tier AI option; used only if no Anthropic key |
| `GEMINI_MODEL` | No | Defaults to `gemini-2.5-flash` |
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | For Cloudflare features | Headless browser, and Workers AI outside Pages |
| `CF_AI_MODEL` | No | Defaults to `@cf/meta/llama-4-scout-17b-16e-instruct` |
| `USE_BROWSER` | No | Set to `0` to skip the headless browser |
| `APP_PASSCODE` | Recommended | Requires the passcode for every import |
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
