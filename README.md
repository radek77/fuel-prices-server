# fuel-prices-server

UK forecourt prices from GOV.UK Fuel Finder, for the OBD2Scanner app's
fill-up form. Prices from GOV.UK Fuel Finder, under the Open Government
Licence.

- **Cron** (`src/fuelfinder.js`, every minute) holds the Fuel Finder
  credentials as Worker secrets and reads one batch a run into Cloudflare
  D1: all stations once a day, all prices otherwise, one cycle after
  another (about 16 minutes a cycle). One batch a run keeps within the free
  plan's 10 ms of CPU. Where it is lives in the `meta` table. A row is
  written only when it changed, to stay within D1's free allowance.
  (GitHub Actions did this until 2026-11-14; Fuel Finder's firewall
  refuses GitHub's runners.)
- **Cloudflare Worker** (`src/worker.js`) answers
  `GET /nearby?lat=…&lon=…&radius=100` with the `X-App-Key` header: open
  stations within the radius (at most 2000 m), nearest first, each with
  `prices[fuelType] = { pence, updated }`.

Nothing secret is in this repo. The credentials and the app key are
Worker secrets (`FF_CLIENT_ID`, `FF_CLIENT_SECRET`, `APP_KEY`).

## Test

```sh
npm ci && npm test
```

## Limits to watch

- D1 free plan: 5 million rows read and 100,000 rows written a day. Each
  price cycle reads one row per price to compare it.
- Endpoints and response shapes follow the open-source Home Assistant
  client beecho01/Fuel-Prices-UK. The Fuel Finder portal gives no base URL.
