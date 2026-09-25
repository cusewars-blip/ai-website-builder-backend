# AI Website Builder — Generation Backend

The real backend for your AI website builder. A user types a prompt, this server
calls the AI provider, and streams back a complete, working website.

The default provider is **Google Gemini's free tier** (via AI Studio) — no
billing, no credit card. Set `AI_PROVIDER=anthropic` in `.env` to use Claude
instead (requires a paid Anthropic key).

**Your API key lives only on this server** — the browser never sees it. That's the
whole reason a static page alone can't do true generation.

## How it works

```
Browser --POST /api/generate { prompt, userId }--> Node server
   -- checks + deducts credits --> Gemini / Anthropic API --streams HTML--> Browser
```

- `POST /api/generate` — spends credits, streams the build via server-sent events
  (`start` → `delta` chunks → `done` with the full HTML, or `error`).
- `GET /api/credits?userId=...` — returns a user's credit balance.
- `GET /api/health` — sanity check + current pricing config.

## Accounts

Email + password accounts with cookie sessions (HttpOnly, Secure,
SameSite=None so the static builder page on another origin stays logged in).
New accounts start with **25 free credits**. Credits live on the account —
logging in on any device shows the same balance, and nobody can farm free
credits by reloading the page.

- `POST /api/auth/signup { email, password }` — create account (password ≥ 8
  chars), sets the session cookie. `409` if the email is taken.
- `POST /api/auth/login { email, password }` — `401` on bad credentials.
- `POST /api/auth/logout` — clears the session.
- `GET /api/me` — `{ loggedIn, email, credits }` for the current session.

Frontend calls must use `credentials: "include"` so the browser sends the
session cookie cross-origin. When a session cookie is present, `/api/generate`,
`/api/publish`, `/api/credits` and `/api/purchase` bill the logged-in account;
without one they fall back to the legacy `userId` parameter. Auth endpoints are
rate-limited (60 attempts / 15 min / IP). Storage is JSON files (`users.json`,
`sessions.json`) — ephemeral on Render's free tier, so switch to a real
database before launch.

## Credits model (matches your site)

- New users start with **25 free credits** (`FREE_CREDITS`).
- Each generation costs **10 credits** (`CREDITS_PER_BUILD`).
- **100 credits per one-time purchase** (no subscription) ≈ 10 builds at 10 credits each.
- Not enough credits → `402` "Top up to keep building."
- If the AI provider fails mid-build, credits are refunded automatically.
- **Promo:** every 3rd 100-credit purchase earns a **150-credit bonus**. Call
  `POST /api/purchase { userId }` from your payment webhook after each
  successful purchase — the backend grants the 100 credits and the bonus
  automatically.

Tune the math with the env vars — e.g. `CREDITS_PER_BUILD=5` doubles builds per
subscription.

## Quick start

1. Install Node.js 18+ and run:
   ```
   npm install
   cp .env.example .env
   ```
2. Get a **free** API key at https://aistudio.google.com/apikey (just needs a
   Google account — no billing) and put it in `.env` as `GEMINI_API_KEY`.
   (Prefer Claude? Set `AI_PROVIDER=anthropic` and use an Anthropic key instead —
   that one requires billing at https://console.anthropic.com.)
3. `npm start` and open http://localhost:3000 — the demo client lets you type a
   prompt, watch the build stream, and preview the result with your credit
   balance up top.

## Publishing

`POST /api/publish { userId, html, title }` saves a generated site and returns a
public URL like `/s/a1b2c3d4e5f6/`. Published sites are plain static files in
`sites/`, served by this same server — so once the backend is deployed, every
published site is instantly live on your domain (your lovable.app-style URL).
Publishing is free: the AI cost was already covered by the generation credits.

### Free domains for customers

Set `SITES_DOMAIN=yourdomain.com` in `.env` and add a wildcard DNS record
(`*.yourdomain.com` → your server). Every published site then automatically gets
a free address like `https://coffee-brand-a1b2.yourdomain.com`, alongside its
`/s/{id}/` URL — the API returns it as `domain`. For local testing,
`http://{name}.localhost:3000` works with no DNS setup.

## Connecting your marketing site

Point your site's builder UI at the deployed backend instead of `localhost`:

```js
const res = await fetch("https://your-backend.example.com/api/generate", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ prompt, userId }),
});
// read the SSE stream: events "start" | "delta" | "done" | "error"
```

Give each visitor a stable `userId` (the demo uses a random ID in localStorage;
production should use real accounts).

## Deploying (pick one)

**Render** (recommended): this repo ships a `render.yaml` Blueprint.
Push to GitHub → Render Dashboard → New → **Blueprint** → select the repo.
Then set these env vars in the Render dashboard (never commit secrets):
`GEMINI_API_KEY`, `CORS_ORIGIN` (your frontend origin, e.g. `https://muse.ai`),
and later `SITES_DOMAIN` when you own a domain. Your public URL will look like
`https://ai-website-builder-backend.onrender.com`.

**Railway**: push this folder to GitHub → Railway "New Project" →
"Deploy from repo" → add your env vars → done. You get a public URL.

**Vercel**: works, but streaming + the JSON ledger file need care — prefer
Railway/Render for this server.

> ⚠️ Render's free tier has an **ephemeral filesystem**: `credits.json` and
> published sites reset when the service restarts or redeploys. Fine for
> testing; before taking real payments, switch the ledger to Postgres
> (Render offers a free Postgres) — that's the next infrastructure step.

## Going live checklist

- [ ] Set `CORS_ORIGIN` to your site's domain (no longer open to all origins).
- [ ] Replace `credits.json` with a real database (Render Postgres, Supabase…).
- [ ] Add real user accounts instead of anonymous IDs.
- [ ] Sell credit packs with Stripe/PayPal: their webhooks grant credits
      (e.g. 100 credits on each $12.99 one-time purchase).
- [ ] Set spending alerts on your Anthropic account — each build costs you
      real API money, so the credit math is your margin.

## Costs to know about

Every build burns input + output tokens. A typical page costs a few cents in API
fees. That's why the credit system exists: it caps what each subscriber can cost
you. Watch your Anthropic usage dashboard for the first few weeks and adjust
`CREDITS_PER_BUILD` so each $12.99 credit pack stays profitable.
