import assert from "node:assert/strict";
import test from "node:test";
import { chunks, fuelTypes, priceRows, records, stationRows, upserts } from "../src/fuelfinder.js";
import worker, { distance, openNow } from "../src/worker.js";

test("records are found inside a wrapper", () => {
  assert.deepEqual(records({ data: [{ node_id: "a" }] }), [{ node_id: "a" }]);
  assert.deepEqual(records([{ node_id: "a" }]), [{ node_id: "a" }]);
});

test("stations: quotes escaped, closures kept, rows without a place dropped", () => {
  const rows = stationRows([
    { node_id: "1", trading_name: "Bob's Garage", brand_name: "ESSO",
      location: { latitude: "51.5", longitude: -0.7, address_line_1: "1 High St", city: "Marlow", postcode: "SL7 1AA" } },
    { node_id: 2, brand_name: "Shell", location: { latitude: 51.6, longitude: -0.8 }, permanent_closure: true,
      temporary_closure: true, public_phone_number: "01628 123456", amenities: ["car_wash", 3],
      opening_times: { usual_days: { monday: { open: "06:00", close: "22:00", is_24_hours: false } } },
      fuel_types: { E10: true, B7_Standard: true, HVO: false }, is_motorway_service_station: true },
    { node_id: "3", trading_name: "No place", location: {} },
  ]);
  assert.deepEqual(rows, [
    "('1','Bob''s Garage','ESSO','1 High St, Marlow','SL7 1AA',51.5,-0.7,0,0,'',NULL,NULL,NULL,0,0)",
    "('2','Shell','Shell','','',51.6,-0.8,1,1,'01628 123456','[\"car_wash\"]',"
      + "'{\"usual_days\":{\"monday\":{\"open\":\"06:00\",\"close\":\"22:00\",\"is_24_hours\":false}}}',"
      + "'[\"E10\",\"B7_STANDARD\"]',1,0)"]);
  assert.deepEqual(fuelTypes(["E5", "B7S", "e10"]), ["E5", "B7_STANDARD", "E10"]);
  assert.equal(fuelTypes(undefined), null);
});

test("prices: short names aliased, out-of-range prices dropped", () => {
  const rows = priceRows([{ node_id: "1", fuel_prices: [
    { fuel_type: "B7S", price: "149.9", price_last_updated: "2026-11-14T08:00:00Z" },
    { fuel_type: "E5", price: 159.9, price_last_updated: "2026-11-14T08:00:00Z",
      price_change_effective_timestamp: "2026-11-13T07:00:00Z" },
    { fuel_type: "E10", price: 1.399 },
  ] }]);
  // When it took effect at the pump, else when it was reported.
  assert.deepEqual(rows, ["('1','B7_STANDARD',149.9,'2026-11-14T08:00:00Z')", "('1','E5',159.9,'2026-11-13T07:00:00Z')"]);
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

test("search: name, brand, address or postcode; nearest first; key checked", async () => {
  const DB = fakeD1();
  DB.sqlite.exec(`INSERT INTO stations (id,name,brand,address,postcode,lat,lon,closed,temporary,phone,amenities,opening_times,fuel_types,motorway) VALUES
    ('a','Marlow Service Station','ESSO','1 High St, Marlow','SL7 1AA',51.57,-0.77,0,0,'01628 1','["car_wash"]','{"usual_days":{}}','["E10"]',0),
    ('b','Bourne End','SHELL','Station Rd, Bourne End','SL8 5QE',51.58,-0.71,0,1,NULL,NULL,NULL,NULL,1),
    ('c','Shut','SHELL','Marlow Rd','SL7 9ZZ',51.57,-0.77,1,0,NULL,NULL,NULL,NULL,0);
    INSERT INTO prices VALUES ('a','E10',139.9,NULL),('a','E5',152.9,NULL)`);
  const env = { APP_KEY: "k", DB };
  const get = async (query) => {
    const response = await worker.fetch(new Request(`https://w/search?${query}`, { headers: { "X-App-Key": "k" } }), env);
    return response.status === 200 ? (await response.json()).stations : response.status;
  };
  assert.equal((await worker.fetch(new Request("https://w/search?q=marlow"), env)).status, 401);
  assert.equal(await get("q=m"), 400);
  // Closed stations are left out; the address matches too.
  assert.deepEqual((await get("q=marlow")).map((s) => s.id), ["a"]);
  assert.deepEqual((await get("q=shell")).map((s) => s.id), ["b"]);
  assert.deepEqual((await get("q=sl71")).map((s) => s.id), ["a"]);
  assert.deepEqual((await get("q=SL8 5")).map((s) => s.id), ["b"]);
  const both = await get("q=SL&lat=51.58&lon=-0.71");
  assert.deepEqual(both.map((s) => s.id), ["b", "a"]);
  assert.equal(both[0].distance, 0);
  assert.deepEqual(both[1].prices.E10, { pence: 139.9, updated: null });
  assert.equal(both[1].brand, "ESSO");
  assert.equal(both[1].postcode, "SL7 1AA");
  assert.equal((await get("q=marlow"))[0].distance, null);
  // The list carries the flags and amenities, not the details.
  assert.equal(both[0].temporarilyClosed, true);
  assert.equal(both[0].motorway, true);
  assert.deepEqual(both[0].amenities, []);
  assert.deepEqual(both[1].amenities, ["car_wash"]);
  assert.equal("phone" in both[1], false);
});

test("station: details for one, not a permanently closed one", async () => {
  const DB = fakeD1();
  DB.sqlite.exec(`INSERT INTO stations (id,name,lat,lon,closed,phone,opening_times,fuel_types) VALUES
    ('a','A',51.57,-0.77,0,'01628 1','{"usual_days":{"monday":{"open":"06:00"}}}','["E10","HVO"]'),
    ('c','C',51.57,-0.77,1,NULL,NULL,NULL);
    INSERT INTO prices VALUES ('a','E10',139.9,'2026-11-13T07:00:00Z')`);
  const env = { APP_KEY: "k", DB };
  const get = (query) => worker.fetch(new Request(`https://w/station?${query}`, { headers: { "X-App-Key": "k" } }), env);
  const [station] = (await (await get("id=a&lat=51.57&lon=-0.77")).json()).stations;
  assert.equal(station.phone, "01628 1");
  assert.deepEqual(station.openingTimes, { usual_days: { monday: { open: "06:00" } } });
  assert.deepEqual(station.fuelTypes, ["E10", "HVO"]);
  assert.equal(station.distance, 0);
  assert.equal(station.prices.E10.updated, "2026-11-13T07:00:00Z");
  assert.equal((await get("id=c")).status, 404);
  assert.equal((await get("id=")).status, 400);
});

test("upserts: every statement under D1's 100 KB", () => {
  const big = "x".repeat(1300);
  const rows = Array.from({ length: 300 }, (_, i) => `('${i}','${big}')`);
  assert.ok(chunks(rows).length > 1);
  assert.equal(chunks(rows).flat().length, 300);
  for (const line of upserts(rows, []).split("\n")) assert.ok(line.length < 100_000, `${line.length}`);
  assert.deepEqual(chunks(["a", "b"]), [["a", "b"]]);
});

test("open now, in UK time", () => {
  const week = { usual_days: {
    monday: { open: "06:00:00", close: "22:00:00", is_24_hours: false },
    sunday: { open: "20:00:00", close: "02:00:00", is_24_hours: false },
    tuesday: { open: "00:00:00", close: "23:59:00", is_24_hours: true },
    wednesday: { open: "00:00:00", close: "00:00:00", is_24_hours: false } } };
  // 16 Nov 2026 is a Monday; UK time is UTC in November.
  assert.equal(openNow(week, new Date("2026-11-16T10:00:00Z")), true);
  assert.equal(openNow(week, new Date("2026-11-16T05:00:00Z")), false);
  assert.equal(openNow(week, new Date("2026-11-16T23:00:00Z")), false);
  assert.equal(openNow(week, new Date("2026-11-16T01:30:00Z")), true);   // Sunday's late hours
  assert.equal(openNow(week, new Date("2026-11-17T12:00:00Z")), true);
  assert.equal(openNow(week, new Date("2026-11-18T12:00:00Z")), false);  // closed all day
  assert.equal(openNow(week, new Date("2026-11-19T12:00:00Z")), null);   // no hours given
  assert.equal(openNow(null), null);
  // British Summer Time: 05:30 UTC is 06:30 in London.
  assert.equal(openNow({ usual_days: { monday: { open: "06:00", close: "22:00" } } }, new Date("2026-06-15T05:30:00Z")), true);
});
