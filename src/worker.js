// With the X-App-Key header:
// GET /nearby?lat=51.57&lon=-0.77&radius=100 — open stations within
//   `radius` metres (at most MAX_RADIUS), nearest first.
// GET /search?q=marlow&lat=51.57&lon=-0.77 — open stations whose name,
//   brand, address or postcode hold `q` (at most SEARCH_LIMIT); nearest
//   first when a point is given, else by name, `distance` then null.
// Each station comes with its brand, address, postcode and prices by Fuel
// Finder fuel type, in pence per litre, and the answer with `averages`: the
// UK average per fuel type, for flagging a price far off it.
// The cron reads Fuel Finder into D1 (src/fuelfinder.js).
import { step } from "./fuelfinder.js";

const METRES_PER_DEGREE = 111320;
// 50 miles: the app's widest distance filter.
export const MAX_RADIUS = 80500;
export const SEARCH_LIMIT = 50;

const COLUMNS = "s.id, s.name, s.brand, s.address, s.postcode, s.lat, s.lon, p.fuel, p.pence, p.updated";

export function distance(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

// One station per id, its price rows folded into `prices`.
function stations(rows, lat, lon) {
  const byID = new Map();
  for (const row of rows) {
    let station = byID.get(row.id);
    if (!station) {
      station = { id: row.id, name: row.name, brand: row.brand || null, address: row.address || null,
                  postcode: row.postcode || null, latitude: row.lat, longitude: row.lon,
                  distance: lat == null ? null : Math.round(distance(lat, lon, row.lat, row.lon)), prices: {} };
      byID.set(row.id, station);
    }
    if (row.fuel) station.prices[row.fuel] = { pence: row.pence, updated: row.updated };
  }
  return [...byID.values()];
}

async function answer(env, list) {
  const averages = await env.DB.prepare("SELECT value FROM meta WHERE key = 'averages'").first("value");
  return Response.json({ stations: list, averages: averages ? JSON.parse(averages) : {} },
                       { headers: { "Cache-Control": "max-age=300" } });
}

const bad = () => new Response("Bad request", { status: 400 });
const isPoint = (lat, lon) => Math.abs(lat) <= 90 && Math.abs(lon) <= 180;

export default {
  async scheduled(event, env) {
    await step(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/nearby" && url.pathname !== "/search") return new Response("Not found", { status: 404 });
    if (!env.APP_KEY || request.headers.get("X-App-Key") !== env.APP_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    const params = url.searchParams;
    const lat = params.has("lat") ? Number(params.get("lat")) : null;
    const lon = params.has("lon") ? Number(params.get("lon")) : null;

    if (url.pathname === "/search") {
      const q = (params.get("q") ?? "").trim();
      if (q.length < 2 || q.length > 60) return bad();
      const point = lat != null && lon != null && isPoint(lat, lon);
      // A postcode matches with or without its space: "SL7 1" or "SL71".
      const { results } = await env.DB.prepare(
        `WITH hits AS (SELECT id FROM stations WHERE closed = 0 AND (name LIKE ?1 OR brand LIKE ?1 OR address LIKE ?1
           OR REPLACE(postcode, ' ', '') LIKE ?2) LIMIT ${SEARCH_LIMIT})
         SELECT ${COLUMNS} FROM hits JOIN stations s ON s.id = hits.id LEFT JOIN prices p ON p.id = s.id`,
      ).bind(`%${q}%`, `${q.replaceAll(" ", "")}%`).all();
      const list = stations(results, point ? lat : null, lon);
      list.sort(point ? (a, b) => a.distance - b.distance : (a, b) => a.name.localeCompare(b.name));
      return answer(env, list);
    }

    const radius = Math.min(Number(params.get("radius")) || 100, MAX_RADIUS);
    if (!(lat != null && lon != null && isPoint(lat, lon) && radius > 0)) return bad();
    const dLat = radius / METRES_PER_DEGREE;
    const dLon = radius / (METRES_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    const { results } = await env.DB.prepare(
      `SELECT ${COLUMNS}
       FROM stations s LEFT JOIN prices p ON p.id = s.id
       WHERE s.closed = 0 AND s.lat BETWEEN ?1 AND ?2 AND s.lon BETWEEN ?3 AND ?4`,
    ).bind(lat - dLat, lat + dLat, lon - dLon, lon + dLon).all();
    const list = stations(results, lat, lon).filter((s) => s.distance <= radius).sort((a, b) => a.distance - b.distance);
    return answer(env, list);
  },
};
