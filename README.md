# FundFlow

FundFlow is now structured for `Cloudflare Pages + Pages Functions`.

## What Changed

- Split the old single-file page into:
  - `index.html`
  - `assets/styles.css`
  - `assets/app.js`
- Added same-origin API endpoints under `functions/api/*`
- Moved browser-side third-party market/fund requests behind Cloudflare Functions
- Added `_headers` for baseline hardening
- Added `wrangler.toml` and `package.json` for local preview and Pages deployment

## Public Endpoints

- `GET /api/funds/day-growth?code=001632`
- `GET /api/funds/suggest?keyword=食品`
- `GET /api/funds/history?code=001632`
- `GET /api/funds/holdings?code=001632`
- `GET /api/funds/batch-snapshot?codes=001632,003095`
- `GET /api/market/indices`

## Local Development

```bash
npm install
npm test
npx wrangler pages dev .
```

Then open the local Pages URL printed by Wrangler.

## Cloudflare Pages Deployment

1. Push this branch to GitHub.
2. In Cloudflare Pages, create a new project from the GitHub repository.
3. Use these settings:
   - Framework preset: `None`
   - Build command: leave empty
   - Build output directory: `.`
4. After the first deployment, Cloudflare will generate a `*.pages.dev` domain.

## Required Cloudflare Security Setup

These settings are account-specific and must be configured in the Cloudflare dashboard.

### 1. Protect the site with Cloudflare Access

- Create a self-hosted Access application for the `*.pages.dev` hostname.
- Require login for browser users.
- Keep `/api/*` behind Access as well.

### 2. Create an n8n service token

- Create a Cloudflare Access service token.
- Add a policy that allows this service token to access `/api/*`.
- In n8n HTTP Request nodes, send:

```http
CF-Access-Client-Id: <your-client-id>
CF-Access-Client-Secret: <your-client-secret>
```

### 3. Add WAF rate limiting

Recommended initial targets:

- `/api/funds/day-growth*`
- `/api/funds/batch-snapshot*`
- `/api/funds/holdings*`
- `/api/market/indices*`

Recommended rule shape:

- Count by client IP
- Low burst threshold for anonymous traffic
- Much higher threshold for Access-authenticated traffic

### 4. Keep Bot Fight as secondary, not primary

Use `Access + cache + rate limiting` first. If you later upgrade plans, evaluate `Super Bot Fight Mode` carefully against n8n traffic.

## Notes

- The frontend keeps the existing `localStorage` holdings model.
- The `day-growth` endpoint is the recommended machine interface for n8n.
- Some Cloudflare security controls such as Access policy details and WAF expressions cannot be fully committed from this repo alone; they must be applied in your Cloudflare account.
