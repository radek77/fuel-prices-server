// Reads GOV.UK Fuel Finder into D1, one batch per cron run (every minute):
// the free Workers plan gives about 10 ms of CPU a run, too little for every
// batch at once. Where it is (job, batch) lives in the `meta` table.
// Stations once a day, prices otherwise, one cycle straight after another.
// Upserts change a row only when its values differ, to keep D1's free
// row-write allowance.

const BASE = "https://www.fuel-finder.service.gov.uk";
const ALIAS = { B7S: "B7_STANDARD", B7P: "B7_PREMIUM" };
const STATION_COLUMNS = ["id", "name", "brand", "address", "postcode", "lat", "lon", "closed", "temporary",
  "phone", "amenities", "opening_times", "fuel_types", "motorway", "supermarket"];
const PATHS = { stations: "/api/v1/pfs", prices: "/api/v1/pfs/fuel-prices" };
const DAY = 24 * 3600 * 1000;
const MAX_BATCHES = 80;
const CHUNK = 500;
// D1 takes a statement of at most 100 KB; a station row with its opening
// times is about 1.3 KB, so a chunk of rows ends well before.
const MAX_VALUES = 80_000;

// The rows in runs of at most CHUNK and MAX_VALUES characters.
export function chunks(rows) {
  const out = [];
  let run = [], size = 0;
  for (const row of rows) {
    if (run.length && (run.length >= CHUNK || size + row.length > MAX_VALUES)) {
      out.push(run);
      run = [];
      size = 0;
    }
    run.push(row);
    size += row.length + 1;
  }
  if (run.length) out.push(run);
  return out;
}
// Fewer prices than this for a fuel give no average: B10 and HVO are rare.
const MIN_FOR_AVERAGE = 50;

// D1's exec takes one statement per line, so text has no line breaks.
export const sqlText = (value) => `'${String(value).replace(/[\r\n]+/g, " ").replaceAll("'", "''")}'`;
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
    const text = (value) => (typeof value === "string" ? value.trim() : "");
    const name = text(row.trading_name) || text(row.brand_name) || "Station";
    const address = [location.address_line_1, location.address_line_2, location.city].map(text).filter(Boolean).join(", ");
    const flag = (value) => (value === true ? 1 : 0);
    // Kept as Fuel Finder sends them, JSON text, for the app's station sheet.
    const json = (value) => (value && typeof value === "object" ? sqlText(JSON.stringify(value)) : "NULL");
    const amenities = Array.isArray(row.amenities) ? row.amenities.filter((a) => typeof a === "string") : null;
    out.push(`(${sqlText(row.node_id)},${sqlText(name)},${sqlText(text(row.brand_name))},${sqlText(address)},`
      + `${sqlText(text(location.postcode))},${lat},${lon},${flag(row.permanent_closure)},${flag(row.temporary_closure)},`
      + `${sqlText(text(row.public_phone_number))},${json(amenities)},${json(row.opening_times)},${json(fuelTypes(row.fuel_types))},`
      + `${flag(row.is_motorway_service_station)},${flag(row.is_supermarket_service_station)})`);
  }
  return out;
}

// The fuels a station sells, by the prices' names, from a list or an
// object of flags (the guide shows the latter, other clients the former).
export function fuelTypes(value) {
  const names = Array.isArray(value) ? value
    : value && typeof value === "object" ? Object.keys(value).filter((key) => value[key] === true) : null;
  if (!names) return null;
  return [...new Set(names.filter((n) => typeof n === "string" && n).map((n) => ALIAS[n.toUpperCase()] ?? n.toUpperCase()))];
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
      // When the price took effect at the pump; when it was reported, failing that.
      const when = entry.price_change_effective_timestamp || entry.price_last_updated;
      const updated = when ? sqlText(when) : "NULL";
      out.push(`(${sqlText(row.node_id)},${sqlText(ALIAS[type] ?? type)},${pence},${updated})`);
    }
  }
  return out;
}

// One statement per line, for D1's exec.
export function upserts(stations, prices) {
  const sql = [];
  for (const run of chunks(stations)) {
    const set = STATION_COLUMNS.slice(1).map((c) => `${c}=excluded.${c}`).join(", ");
    const changed = STATION_COLUMNS.slice(1).map((c) => `stations.${c} IS NOT excluded.${c}`).join(" OR ");
    sql.push(`INSERT INTO stations (${STATION_COLUMNS.join(",")}) VALUES ${run.join(",")} `
      + `ON CONFLICT(id) DO UPDATE SET ${set} WHERE ${changed};`);
  }
  for (const run of chunks(prices)) {
    sql.push(`INSERT INTO prices (id,fuel,pence,updated) VALUES ${run.join(",")} `
      + "ON CONFLICT(id,fuel) DO UPDATE SET pence=excluded.pence, updated=excluded.updated "
      + "WHERE prices.pence IS NOT excluded.pence OR prices.updated IS NOT excluded.updated;");
  }
  return sql.join("\n");
}

// Fuel Finder keeps one live token per client, so it is kept in `meta`
// and reused until a minute before it runs out.
async function token(env, meta, now, fetchFn) {
  if (meta.token && Number(meta.tokenExpires) > now + 60_000) return meta.token;
  const response = await fetchFn(`${BASE}/api/v1/oauth/generate_access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: env.FF_CLIENT_ID, client_secret: env.FF_CLIENT_SECRET }),
  });
  if (!response.ok) throw new Error(`token refused (${response.status})`);
  const body = await response.json();
  const value = (body.data ?? body).access_token;
  if (!value) throw new Error("token unreadable");
  meta.token = value;
  meta.tokenExpires = String(now + (Number((body.data ?? body).expires_in) || 3600) * 1000);
  return value;
}

async function save(env, meta) {
  const put = env.DB.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?1, ?2)");
  await env.DB.batch(Object.entries(meta).map(([key, value]) => put.bind(key, String(value))));
}

// One batch: a 404, an empty batch, a repeat of the last one or the cap
// ends the job. A 429, a refused token or a failure leaves the batch to
// the next run.
export async function step(env, now = Date.now(), fetchFn = fetch) {
  const { results } = await env.DB.prepare("SELECT key, value FROM meta").all();
  const meta = Object.fromEntries(results.map((row) => [row.key, row.value]));
  if (!meta.job) {
    meta.job = !meta.stationsDone || now - Number(meta.stationsDone) > DAY ? "stations" : "prices";
    meta.batch = "1";
    meta.lastFirst = "";
  }
  const batch = Number(meta.batch);
  const bearer = await token(env, meta, now, fetchFn);
  const response = await fetchFn(`${BASE}${PATHS[meta.job]}?batch-number=${batch}`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" },
  });
  if (response.status === 401) meta.token = "";
  if (response.status === 429 || response.status === 401) return save(env, meta);
  if (response.status !== 404 && !response.ok) {
    await save(env, meta);
    throw new Error(`${meta.job} batch ${batch} refused (${response.status})`);
  }

  const page = response.status === 404 ? [] : records(await response.json());
  const first = page[0]?.node_id == null ? "" : String(page[0].node_id);
  if (!first || first === meta.lastFirst || batch > MAX_BATCHES) {
    if (meta.job === "stations") meta.stationsDone = String(now);
    // The UK average per fuel, for the app to flag a price far off it:
    // once a day, at the end of a price cycle, worked out by D1.
    if (meta.job === "prices" && !(now - Number(meta.averagesDone) < DAY)) {
      const { results: rows } = await env.DB.prepare(
        `SELECT fuel, ROUND(AVG(pence), 1) AS pence FROM prices GROUP BY fuel HAVING COUNT(*) >= ${MIN_FOR_AVERAGE}`,
      ).all();
      meta.averages = JSON.stringify(Object.fromEntries(rows.map((row) => [row.fuel, row.pence])));
      meta.averagesDone = String(now);
    }
    meta.job = "";
    return save(env, meta);
  }
  const sql = meta.job === "stations" ? upserts(stationRows(page), []) : upserts([], priceRows(page));
  if (sql) await env.DB.exec(sql);
  meta.batch = String(batch + 1);
  meta.lastFirst = first;
  return save(env, meta);
}
