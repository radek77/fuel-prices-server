import assert from "node:assert/strict";
import test from "node:test";
import { priceRows, records, stationRows, upserts } from "../src/fuelfinder.js";
import worker, { distance } from "../src/worker.js";

test("records are found inside a wrapper", () => {
  assert.deepEqual(records({ data: [{ node_id: "a" }] }), [{ node_id: "a" }]);
  assert.deepEqual(records([{ node_id: "a" }]), [{ node_id: "a" }]);
});

test("stations: quotes escaped, closures kept, rows without a place dropped", () => {
  const rows = stationRows([
    { node_id: "1", trading_name: "Bob's Garage", location: { latitude: "51.5", longitude: -0.7 } },
    { node_id: 2, brand_name: "Shell", location: { latitude: 51.6, longitude: -0.8 }, permanent_closure: true },
    { node_id: "3", trading_name: "No place", location: {} },
  ]);
  assert.deepEqual(rows, ["('1','Bob''s Garage',51.5,-0.7,0)", "('2','Shell',51.6,-0.8,1)"]);
});

test("prices: short names aliased, out-of-range prices dropped", () => {
  const rows = priceRows([{ node_id: "1", fuel_prices: [
    { fuel_type: "B7S", price: "149.9", price_last_updated: "2026-11-14T08:00:00Z" },
    { fuel_type: "E10", price: 1.399 },
  ] }]);
  assert.deepEqual(rows, ["('1','B7_STANDARD',149.9,'2026-11-14T08:00:00Z')"]);
  assert.match(upserts([], rows), /ON CONFLICT\(id,fuel\) DO UPDATE/);
});

test("nearby: key checked, nearest first, prices grouped", async () => {
  const db = { prepare: () => ({ first: async () => '{"E10":150}', bind: () => ({ all: async () => ({ results: [
    { id: "far", name: "Far", lat: 51.5005, lon: -0.7, fuel: "E10", pence: 140.9, updated: null },
    { id: "near", name: "Near", lat: 51.5001, lon: -0.7, fuel: "E10", pence: 139.9, updated: "x" },
    { id: "near", name: "Near", lat: 51.5001, lon: -0.7, fuel: "E5", pence: 155.9, updated: "x" },
  ] }) }) }) };
  const env = { APP_KEY: "k", DB: db };
  const url = "https://w/nearby?lat=51.5&lon=-0.7&radius=100";
  assert.equal((await worker.fetch(new Request(url), env)).status, 401);
  const body = await (await worker.fetch(new Request(url, { headers: { "X-App-Key": "k" } }), env)).json();
  assert.deepEqual(body.stations.map((s) => s.name), ["Near", "Far"]);
  assert.deepEqual(Object.keys(body.stations[0].prices), ["E10", "E5"]);
  assert.deepEqual(body.averages, { E10: 150 });
  assert.ok(Math.abs(distance(51.5, -0.7, 51.5009, -0.7) - 100) < 1);
});

// D1 stand-in on Node's own SQLite, so the real SQL runs.
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { step } from "../src/fuelfinder.js";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../schema.sql", import.meta.url), "utf8"));
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    first: async (column) => db.prepare(sql).get(...args)?.[column] ?? null,
    run: () => db.prepare(sql).run(...args),
  });
  return {
    sqlite: db,
    prepare: (sql) => statement(sql),
    batch: async (statements) => statements.map((s) => s.run()),
    // D1's exec: one statement per line.
    exec: async (sql) => sql.split("\n").forEach((line) => db.exec(line)),
  };
}

test("cron: stations then prices, one batch a run, token reused", async () => {
  const DB = fakeD1();
  const env = { DB, FF_CLIENT_ID: "id", FF_CLIENT_SECRET: "secret" };
  const pages = {
    "/api/v1/pfs?batch-number=1": [{ node_id: "1", trading_name: "Shell Marlow", location: { latitude: 51.57, longitude: -0.77 } }],
    "/api/v1/pfs/fuel-prices?batch-number=1": { data: [{ node_id: "1", fuel_prices: [{ fuel_type: "E10", price: 139.9 }] }] },
  };
  let tokens = 0;
  const fetchFn = async (url) => {
    const path = url.replace("https://www.fuel-finder.service.gov.uk", "");
    if (path.endsWith("generate_access_token")) {
      tokens++;
      return Response.json({ data: { access_token: "t", expires_in: 3600 } });
    }
    return pages[path] ? Response.json(pages[path]) : new Response("", { status: 404 });
  };
  for (let run = 0; run < 4; run++) await step(env, 1_000_000 + run, fetchFn);
  assert.deepEqual(DB.sqlite.prepare("SELECT name, closed FROM stations").all().map((r) => ({ ...r })),
                   [{ name: "Shell Marlow", closed: 0 }]);
  assert.deepEqual(DB.sqlite.prepare("SELECT fuel, pence FROM prices").all().map((r) => ({ ...r })),
                   [{ fuel: "E10", pence: 139.9 }]);
  assert.equal(tokens, 1);
  // Stations done, prices cycle over: the next run starts prices again.
  const meta = Object.fromEntries(DB.sqlite.prepare("SELECT key, value FROM meta").all().map((r) => [r.key, r.value]));
  assert.equal(meta.job, "");
  assert.ok(meta.stationsDone);
  // One E10 price is too few for an average.
  assert.equal(meta.averages, "{}");
});

test("cron: averages per fuel once enough prices", async () => {
  const DB = fakeD1();
  const values = Array.from({ length: 60 }, (_, i) => `('${i}','E10',${i % 2 ? 150 : 160},NULL)`).join(",");
  DB.sqlite.exec(`INSERT INTO prices VALUES ${values}; INSERT INTO meta VALUES ('job','prices'),('batch','2'),('stationsDone','${Date.now()}'),('token','t'),('tokenExpires','${Date.now() + 3_600_000}')`);
  await step({ DB }, Date.now(), async () => new Response("", { status: 404 }));
  const averages = DB.sqlite.prepare("SELECT value FROM meta WHERE key='averages'").get().value;
  assert.deepEqual(JSON.parse(averages), { E10: 155 });
});
