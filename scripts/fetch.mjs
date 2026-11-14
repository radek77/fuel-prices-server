// Reads GOV.UK Fuel Finder and writes updates.sql for D1.
// Stations only when STATIONS=true (once a day); prices every run.
// Upserts change a row only when its values differ, to keep D1's
// free row-write allowance.
import { writeFileSync } from "node:fs";

const BASE = "https://www.fuel-finder.service.gov.uk";
const ALIAS = { B7S: "B7_STANDARD", B7P: "B7_PREMIUM" };
const CHUNK = 500;

export const sqlText = (value) => `'${String(value).replaceAll("'", "''")}'`;
const num = (value) => (value === null || value === undefined || value === "" ? NaN : Number(value));

// The record list, at the top or inside a wrapper such as `data`.
export function records(json, depth = 0) {
  if (Array.isArray(json)) return json.filter((row) => row && typeof row === "object");
  if (depth >= 3 || !json || typeof json !== "object") return [];
  for (const value of Object.values(json)) {
    const found = records(value, depth + 1);
    if (found.length) return found;
  }
  return [];
}

export function stationRows(rows) {
  const out = [];
  for (const row of rows) {
    const location = row.location ?? row;
    const lat = num(location.latitude), lon = num(location.longitude);
    if (row.node_id == null || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const name = [row.trading_name, row.brand_name].find((n) => typeof n === "string" && n) ?? "Station";
    const closed = row.temporary_closure === true || row.permanent_closure === true ? 1 : 0;
    out.push(`(${sqlText(row.node_id)},${sqlText(name)},${lat},${lon},${closed})`);
  }
  return out;
}

export function priceRows(rows) {
  const out = [];
  for (const row of rows) {
    if (row.node_id == null || !Array.isArray(row.fuel_prices)) continue;
    for (const entry of row.fuel_prices) {
      const type = String(entry.fuel_type ?? "").toUpperCase();
      const pence = num(entry.price);
      // Pence per litre; anything else is a typo at the forecourt.
      if (!type || !(pence >= 50 && pence <= 500)) continue;
      const updated = entry.price_last_updated ? sqlText(entry.price_last_updated) : "NULL";
      out.push(`(${sqlText(row.node_id)},${sqlText(ALIAS[type] ?? type)},${pence},${updated})`);
    }
  }
  return out;
}

export function upserts(stations, prices) {
  const sql = [];
  for (let i = 0; i < stations.length; i += CHUNK) {
    sql.push(`INSERT INTO stations (id,name,lat,lon,closed) VALUES ${stations.slice(i, i + CHUNK).join(",")}
ON CONFLICT(id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lon=excluded.lon, closed=excluded.closed
WHERE stations.name IS NOT excluded.name OR stations.lat IS NOT excluded.lat OR stations.lon IS NOT excluded.lon OR stations.closed IS NOT excluded.closed;`);
  }
  for (let i = 0; i < prices.length; i += CHUNK) {
    sql.push(`INSERT INTO prices (id,fuel,pence,updated) VALUES ${prices.slice(i, i + CHUNK).join(",")}
ON CONFLICT(id,fuel) DO UPDATE SET pence=excluded.pence, updated=excluded.updated
WHERE prices.pence IS NOT excluded.pence OR prices.updated IS NOT excluded.updated;`);
  }
  return sql.join("\n");
}

async function token() {
  const response = await fetch(`${BASE}/api/v1/oauth/generate_access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: process.env.FF_CLIENT_ID, client_secret: process.env.FF_CLIENT_SECRET }),
  });
  if (!response.ok) throw new Error(`token refused (${response.status})`);
  const body = await response.json();
  const value = (body.data ?? body).access_token;
  if (!value) throw new Error("token unreadable");
  return value;
}

// Every batch: batch-number from 1 until a 404, an empty batch or a repeat.
// One request at a time, as Fuel Finder asks; a 429 is waited out.
async function rows(path, bearer) {
  const all = [];
  let previousFirst;
  for (let batch = 1; batch <= 80; batch++) {
    let response;
    for (let attempt = 0; ; attempt++) {
      response = await fetch(`${BASE}${path}?batch-number=${batch}`, {
        headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
      });
      if (response.status !== 429 || attempt >= 3) break;
      const wait = Number(response.headers.get("retry-after")) || 5;
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 60) * 1000));
    }
    if (response.status === 404) break;
    if (!response.ok) throw new Error(`${path} batch ${batch} refused (${response.status})`);
    const page = records(await response.json());
    const first = page[0]?.node_id;
    if (first == null || first === previousFirst) break;
    previousFirst = first;
    all.push(...page);
  }
  return all;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const bearer = await token();
  const stations = process.env.STATIONS === "true" ? stationRows(await rows("/api/v1/pfs", bearer)) : [];
  const prices = priceRows(await rows("/api/v1/pfs/fuel-prices", bearer));
  if (!prices.length) throw new Error("no prices read");
  writeFileSync("updates.sql", upserts(stations, prices));
  console.log(`${stations.length} stations, ${prices.length} prices`);
}
