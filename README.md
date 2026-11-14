# fuel-prices-server

UK forecourt prices from GOV.UK Fuel Finder, for the OBD2Scanner app's
fill-up form. Prices from GOV.UK Fuel Finder, under the Open Government
Licence.

- **GitHub Actions** (`.github/workflows/update.yml`) holds the Fuel Finder
  credentials. Every 15 minutes it reads all prices (and once a day all
  stations) and upserts them into Cloudflare D1. A row is written only when
  it changed, to stay within D1's free allowance.
- **Cloudflare Worker** (`src/worker.js`) answers
  `GET /nearby?lat=…&lon=…&radius=100` with the `X-App-Key` header: open
  stations within the radius (at most 2000 m), nearest first, each with
  `prices[fuelType] = { pence, updated }`.

Nothing secret is in this repo. The credentials live in GitHub Secrets and
the app key in a Worker secret.

## Test

```sh
npm ci && npm test
```

## Limits to watch

- GitHub turns off scheduled workflows in a public repo after 60 days with
  no commits, and emails before it does. Re-enable it on the Actions tab.
- D1 free plan: 5 million rows read and 100,000 rows written a day. Each
  run reads one row per price to compare it.
- Endpoints and response shapes follow the open-source Home Assistant
  client beecho01/Fuel-Prices-UK. The Fuel Finder portal gives no base URL.
