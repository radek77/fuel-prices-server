// Reads GOV.UK Fuel Finder into D1, one batch per cron run (every minute):
// the free Workers plan gives about 10 ms of CPU a run, too little for every
// batch at once. Where it is (job, batch) lives in the `meta` table.
// Stations once a day, prices otherwise, one cycle straight after another.
// Upserts change a row only when its values differ, to keep D1's free
// row-write allowance.

const BASE = "https://www.fuel-finder.service.gov.uk";
const ALIAS = { B7S: "B7_STANDARD", B7P: "B7_PREMIUM" };
const PATHS = { stations: "/api/v1/pfs", prices: "/api/v1/pfs/fuel-prices" };
const DAY = 24 * 3600 * 1000;
const MAX_BATCHES = 80;
const CHUNK = 500;

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

// One statement per line, for D1's exec.
export function upserts(stations, prices) {
  const sql = [];
  for (let i = 0; i < stations.length; i += CHUNK) {
    sql.push(`INSERT INTO stations (id,name,lat,lon,closed) VALUES ${stations.slice(i, i + CHUNK).join(",")} `
      + "ON CONFLICT(id) DO UPDATE SET name=excluded.name, lat=excluded.lat, lon=excluded.lon, closed=excluded.closed "
      + "WHERE stations.name IS NOT excluded.name OR stations.lat IS NOT excluded.lat OR stations.lon IS NOT excluded.lon OR stations.closed IS NOT excluded.closed;");
  }
  for (let i = 0; i < prices.length; i += CHUNK) {
    sql.push(`INSERT INTO prices (id,fuel,pence,updated) VALUES ${prices.slice(i, i + CHUNK).join(",")} `
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
    meta.job = "";
    return save(env, meta);
  }
  const sql = meta.job === "stations" ? upserts(stationRows(page), []) : upserts([], priceRows(page));
  if (sql) await env.DB.exec(sql);
  meta.batch = String(batch + 1);
  meta.lastFirst = first;
  return save(env, meta);
}
