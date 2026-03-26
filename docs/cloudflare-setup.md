# Cloudflare Setup Checklist

## Pages

- Create a Pages project from GitHub
- Production branch: `master` or your chosen release branch
- Output directory: `.`

## Access

Create one Access application covering the Pages hostname.

Recommended policy split:

- Browser policy:
  - Action: `Allow`
  - Include: your email / identity provider group
- n8n policy:
  - Action: `Service Auth`
  - Include: the service token created for n8n
  - Path: `/api/*`

## WAF / Rate Limiting

Recommended first-pass thresholds:

- `/api/funds/day-growth*`
  - 60 requests / minute / IP
- `/api/funds/batch-snapshot*`
  - 30 requests / minute / IP
- `/api/funds/holdings*`
  - 20 requests / minute / IP
- `/api/market/indices*`
  - 60 requests / minute / IP

If you keep the whole site behind Access, you can be more permissive for authenticated traffic and much stricter for anonymous traffic.

## n8n Example

Use an HTTP Request node with:

- Method: `GET`
- URL: `https://<your-project>.pages.dev/api/funds/day-growth?code=001632`
- Headers:
  - `CF-Access-Client-Id`
  - `CF-Access-Client-Secret`

Expected response:

```json
{
  "code": "001632",
  "date": "2026-03-26",
  "dayGrowthPct": -0.95,
  "source": "fundgz_json",
  "nav": 1.951,
  "cachedAt": "2026-03-26T08:00:00.000Z"
}
```
