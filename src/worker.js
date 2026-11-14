// GET /nearby?lat=51.57&lon=-0.77&radius=100 with the X-App-Key header:
// open stations within `radius` metres (at most 2000), nearest first,
// each with its prices by Fuel Finder fuel type, in pence per litre, and
// `averages`: the UK average per fuel type, for flagging a price far off it.
// The cron reads Fuel Finder into D1 (src/fuelfinder.js).
import { step } from "./fuelfinder.js";

const METRES_PER_DEGREE = 111320;

export function distance(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export default {
  async scheduled(event, env) {
    await step(env);
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/nearby") return new Response("Not found", { status: 404 });
    if (!env.APP_KEY || request.headers.get("X-App-Key") !== env.APP_KEY) {
      return new Response("Unauthorized", { status: 401 });
    }
    const lat = Number(url.searchParams.get("lat"));
    const lon = Number(url.searchParams.get("lon"));
    const radius = Math.min(Number(url.searchParams.get("radius")) || 100, 2000);
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180 && radius > 0)) {
      return new Response("Bad request", { status: 400 });
    }

    const dLat = radius / METRES_PER_DEGREE;
    const dLon = radius / (METRES_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));
    const { results } = await env.DB.prepare(
      `SELECT s.id, s.name, s.lat, s.lon, p.fuel, p.pence, p.updated
       FROM stations s LEFT JOIN prices p ON p.id = s.id
       WHERE s.closed = 0 AND s.lat BETWEEN ?1 AND ?2 AND s.lon BETWEEN ?3 AND ?4`,
    ).bind(lat - dLat, lat + dLat, lon - dLon, lon + dLon).all();

    const byID = new Map();
    for (const row of results) {
      let station = byID.get(row.id);
      if (!station) {
        station = { name: row.name, latitude: row.lat, longitude: row.lon,
                    distance: Math.round(distance(lat, lon, row.lat, row.lon)), prices: {} };
        byID.set(row.id, station);
      }
      if (row.fuel) station.prices[row.fuel] = { pence: row.pence, updated: row.updated };
    }
    const stations = [...byID.values()].filter((s) => s.distance <= radius).sort((a, b) => a.distance - b.distance);
    const averages = await env.DB.prepare("SELECT value FROM meta WHERE key = 'averages'").first("value");
    return Response.json({ stations, averages: averages ? JSON.parse(averages) : {} }, { headers: { "Cache-Control": "max-age=300" } });
  },
};
